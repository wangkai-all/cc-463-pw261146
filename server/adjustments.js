import { audit, nowIso, tx } from './db.js';
import {
  ACTION_RULES, safeJson, recomputeScopePreview, runReconciliation,
} from './reconcile.js';

/**
 * Adjustments are the only way a human can change how a finding is treated.
 * They are append-only records:
 *   proposed -> approved | rejected
 * Approving never edits a source row. It writes to override_register (for key
 * corrections) or to the adjustment itself (for accepted differences and
 * write-offs), and queues a recompute scope. The source payloads stay intact,
 * so the other two sources keep their own evidence.
 */

export class AdjustError extends Error {
  constructor(message, { status = 400, code = 'invalid' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const ACTIONS = {
  remap_key: {
    label: '修正来源关联键',
    category: 'explainable',
    needsRemap: true,
    description: '只在指定来源的指定行上写入 override，不修改原始报文，也不改动其他来源。',
  },
  accept_diff: {
    label: '接受差异（附解释）',
    category: 'explainable',
    needsAmount: false,
    description: '确认差异由已知机制导致，并把它记为已解释差异，保留全部证据。',
  },
  write_off: {
    label: '差异核销',
    category: 'conflict',
    needsAmount: true,
    description: '为真实冲突建立核销差额；原凭证保留，核销记录单独可追溯。',
  },
  defer_cutoff: {
    label: '挂起至下一批次',
    category: 'pending_data',
    needsAmount: false,
    description: '把待补数据的发现挂起到下一批次，重算时继续保持开放。',
  },
  manual_entry: {
    label: '人工登记',
    category: 'conflict',
    needsAmount: true,
    description: '由人工给出处理金额与说明，形成可审计的人工凭证。',
  },
};

export function allowedActions(finding) {
  return ACTION_RULES[finding.category] || [];
}

function findingRow(db, id) {
  const finding = db.prepare(
    `SELECT f.*, r.order_no AS result_order_no FROM recon_finding f
       LEFT JOIN recon_result r ON r.id = f.result_id WHERE f.id = ?`
  ).get(id);
  if (!finding) throw new AdjustError('发现项不存在', { status: 404, code: 'not_found' });
  return finding;
}

function findingPayload(finding) {
  const payload = safeJson(finding.evidence_json);
  return payload && !Array.isArray(payload) && typeof payload === 'object' ? payload : {};
}

/**
 * Evidence may only be quoted when it actually appears in the finding. This is
 * the guard against "fixing" a finding by inventing support for it.
 */
function validateEvidence(db, finding, evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new AdjustError('调整必须附带至少一条可追溯证据', { status: 422, code: 'evidence_required' });
  }
  const allowed = new Set(
    (findingPayload(finding).evidence || []).map((e) => `${e.source}|${e.row_id}|${e.batch_id}`)
  );
  for (const ref of evidence) {
    const key = `${ref.source}|${ref.row_id}|${ref.batch_id}`;
    if (!allowed.has(key)) {
      throw new AdjustError(`证据 ${key} 不在该发现项的原始证据中，不能引用`, {
        status: 422, code: 'evidence_not_cited',
      });
    }
  }
}

export function proposeAdjustment(db, payload, actor) {
  const findingId = Number(payload.finding_id);
  const finding = findingRow(db, findingId);
  if (!actor) throw new AdjustError('必须提供操作人', { status: 400, code: 'actor_required' });
  if (['accepted', 'resolved', 'superseded'].includes(finding.status)) {
    throw new AdjustError('该发现项已关闭，不能再提出调整', { status: 409, code: 'finding_closed' });
  }

  const action = String(payload.action || '');
  if (!ACTIONS[action]) throw new AdjustError(`未知调整动作: ${action}`, { status: 422, code: 'unknown_action' });
  const allowed = allowedActions(finding);
  if (!allowed.includes(action)) {
    throw new AdjustError(
      `「${ACTIONS[action].label}」不能用于${categoryLabel(finding.category)}，允许的动作：${allowed.map((a) => ACTIONS[a].label).join('、')}`,
      { status: 422, code: 'action_not_allowed' }
    );
  }
  if (!payload.reason || String(payload.reason).trim().length < 4) {
    throw new AdjustError('调整必须写明原因（至少 4 个字）', { status: 422, code: 'reason_required' });
  }

  const amount = payload.amount_cents == null ? 0 : Math.trunc(Number(payload.amount_cents));
  if (ACTIONS[action].needsAmount) {
    if (!amount) throw new AdjustError('该动作需要填写调整金额', { status: 422, code: 'amount_required' });
    if (Math.abs(amount) > Math.max(finding.amount_cents, 1)) {
      throw new AdjustError(
        `调整金额 ${Math.abs(amount)} 分超过发现项金额 ${finding.amount_cents} 分`,
        { status: 422, code: 'amount_exceeds_finding' }
      );
    }
  }

  let remap = null;
  if (ACTIONS[action].needsRemap) {
    remap = normalizeRemap(db, finding, payload.remap);
  }

  const evidence = payload.evidence ?? findingPayload(finding).evidence ?? [];
  validateEvidence(db, finding, evidence);

  return tx(db, () => {
    const source = remap ? remap[0].source : (payload.source || primarySource(finding));
    const info = db.prepare(
      `INSERT INTO adjustment
         (finding_id, run_id, action, source, order_no, target_source, target_row_id, amount_cents,
          reason, evidence_json, status, proposed_by, proposed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'proposed', ?, ?)`
    ).run(findingId, finding.run_id, action, String(source),
      finding.order_no ?? finding.result_order_no ?? null,
      remap ? remap[0].source : null, remap ? remap[0].row_id : null, Math.abs(amount),
      String(payload.reason).trim(), JSON.stringify({ evidence, remap }), actor, nowIso());
    const adjustmentId = Number(info.lastInsertRowid);
    db.prepare("UPDATE recon_finding SET status = 'adjusted' WHERE id = ? AND status = 'open'").run(findingId);
    audit(db, actor, 'adjustment.propose', 'adjustment', adjustmentId, {
      finding_id: findingId, action, amount_cents: Math.abs(amount), remap,
    });
    return getAdjustment(db, adjustmentId);
  });
}

function primarySource(finding) {
  const payload = findingPayload(finding);
  const first = (payload.evidence || [])[0];
  return first?.source || 'orders';
}

function categoryLabel(category) {
  return category === 'explainable' ? '可解释差异' : category === 'pending_data' ? '待补数据' : '真实冲突';
}

function normalizeRemap(db, finding, remap) {
  const declared = Array.isArray(remap) ? remap : findingPayload(finding).remap;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new AdjustError('该发现项没有可用的补键方案', { status: 422, code: 'remap_unavailable' });
  }
  if (!Array.isArray(remap) || remap.length === 0) {
    throw new AdjustError('补键动作需要明确要修正的行与字段', { status: 422, code: 'remap_required' });
  }
  const byKey = new Map(declared.map((r) => [`${r.source}|${r.row_id}|${r.field}`, r]));
  return remap.map((r) => {
    const key = `${r.source}|${r.row_id}|${r.field}`;
    const known = byKey.get(key);
    if (!known) {
      throw new AdjustError(`补键目标 ${key} 不是该发现项建议的来源行`, { status: 422, code: 'remap_not_suggested' });
    }
    if (known.to !== r.to) {
      throw new AdjustError(`补键目标值必须为建议值 ${known.to}`, { status: 422, code: 'remap_value_mismatch' });
    }
    const table = r.source === 'payments' ? 'payment_fact' : r.source === 'refunds' ? 'refund_fact' : 'order_fact';
    const row = db.prepare(`SELECT id, order_no FROM ${table} WHERE source_row_id = ?`).get(r.row_id);
    if (!row) throw new AdjustError(`来源行 ${r.row_id} 不存在`, { status: 422, code: 'remap_row_missing' });
    return { ...known, from: r.from ?? known.from, to: known.to };
  });
}

export function approveAdjustment(db, id, payload, actor) {
  const adjustment = getAdjustment(db, id);
  if (!actor) throw new AdjustError('必须提供审批人', { status: 400, code: 'actor_required' });
  if (adjustment.status !== 'proposed') {
    throw new AdjustError(`调整当前状态为 ${adjustment.status}，只有待审批的调整可以审批`, {
      status: 409, code: 'not_pending',
    });
  }
  if (adjustment.proposed_by === actor && payload.allow_self_approval !== true) {
    throw new AdjustError('提出人不能审批自己的调整（如确需，请显式使用 allow_self_approval）', {
      status: 409, code: 'self_approval',
    });
  }
  const finding = findingRow(db, adjustment.finding_id);
  if (finding.status === 'superseded') {
    throw new AdjustError('发现项已被新的对账批次取代', { status: 409, code: 'finding_superseded' });
  }
  const evidence = safeJson(adjustment.evidence_json, {}).evidence || [];
  validateEvidence(db, finding, evidence);

  return tx(db, () => {
    const remap = safeJson(adjustment.evidence_json, {}).remap || null;
    db.prepare(
      `UPDATE adjustment SET status = 'approved', approved_by = ?, approved_at = ?, approval_note = ?
        WHERE id = ?`
    ).run(actor, nowIso(), payload.note ? String(payload.note) : null, id);

    if (adjustment.action === 'remap_key' && Array.isArray(remap)) {
      for (const r of remap) {
        // Scoped by (source, source_row_id, field): other sources are untouched.
        db.prepare(
          `INSERT INTO override_register (source, source_row_id, order_no, field, value_json, adjustment_id, created_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(source, source_row_id, field)
           DO UPDATE SET value_json = excluded.value_json, adjustment_id = excluded.adjustment_id,
                         created_at = excluded.created_at`
        ).run(r.source, r.row_id, adjustment.order_no, r.field, JSON.stringify(r.to), id, nowIso());
      }
    }

    db.prepare("UPDATE recon_finding SET status = 'resolved' WHERE id = ?").run(adjustment.finding_id);

    const scope = scopeForAdjustment(adjustment);
    db.prepare(
      `INSERT INTO recompute_scope
         (run_id, finding_id, adjustment_id, scope_type, order_no, batch_id, source_date, reason, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(adjustment.run_id, adjustment.finding_id, id, scope.type, scope.orderNo ?? null,
      scope.batchId ?? null, scope.sourceDate ?? null, `调整 #${id} 审批通过：${adjustment.reason}`, nowIso());

    audit(db, actor, 'adjustment.approve', 'adjustment', id, {
      finding_id: adjustment.finding_id, action: adjustment.action, scope,
    });
    return { adjustment: getAdjustment(db, id), scope };
  });
}

function scopeForAdjustment(adjustment) {
  return { type: 'order', orderNo: adjustment.order_no };
}

export function rejectAdjustment(db, id, payload, actor) {
  const adjustment = getAdjustment(db, id);
  if (!actor) throw new AdjustError('必须提供操作人', { status: 400, code: 'actor_required' });
  if (adjustment.status !== 'proposed') {
    throw new AdjustError('只有待审批的调整可以驳回', { status: 409, code: 'not_pending' });
  }
  return tx(db, () => {
    db.prepare(
      `UPDATE adjustment SET status = 'rejected', approved_by = ?, approved_at = ?, approval_note = ?
        WHERE id = ?`
    ).run(actor, nowIso(), payload.note ? String(payload.note) : null, id);
    const open = db.prepare(
      "SELECT COUNT(*) AS n FROM adjustment WHERE finding_id = ? AND status = 'proposed'"
    ).get(adjustment.finding_id).n;
    if (open === 0) {
      db.prepare("UPDATE recon_finding SET status = 'open' WHERE id = ?").run(adjustment.finding_id);
    }
    audit(db, actor, 'adjustment.reject', 'adjustment', id, { note: payload.note ?? null });
    return getAdjustment(db, id);
  });
}

export function getAdjustment(db, id) {
  const adjustment = db.prepare(
    `SELECT a.*, f.finding_key, f.subtype, f.title AS finding_title, f.category AS finding_category,
            f.status AS finding_status, r.run_id AS result_run_id
       FROM adjustment a
       JOIN recon_finding f ON f.id = a.finding_id
       LEFT JOIN recon_result r ON r.id = f.result_id
      WHERE a.id = ?`
  ).get(id);
  if (!adjustment) throw new AdjustError('调整记录不存在', { status: 404, code: 'not_found' });
  const evidence = safeJson(adjustment.evidence_json, {});
  return { ...adjustment, evidence: evidence.evidence || [], remap: evidence.remap || null };
}

export function listAdjustments(db, { status = null, findingId = null, limit = 200 } = {}) {
  const clauses = [];
  const params = [];
  if (status) { clauses.push('a.status = ?'); params.push(status); }
  if (findingId) { clauses.push('a.finding_id = ?'); params.push(findingId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(
    `SELECT a.id, a.finding_id, a.run_id, a.action, a.source, a.order_no, a.amount_cents, a.reason,
            a.status, a.proposed_by, a.proposed_at, a.approved_by, a.approved_at, a.applied_run_id, a.applied_at,
            f.finding_key, f.subtype, f.category, f.title AS finding_title
       FROM adjustment a JOIN recon_finding f ON f.id = a.finding_id
       ${where}
      ORDER BY a.id DESC LIMIT ?`
  ).all(...params, limit);
}

export function pendingScope(db) {
  return db.prepare(
    `SELECT s.*, f.title AS finding_title, a.action, a.status AS adjustment_status
       FROM recompute_scope s
       LEFT JOIN recon_finding f ON f.id = s.finding_id
       LEFT JOIN adjustment a ON a.id = s.adjustment_id
      WHERE s.consumed_at IS NULL
      ORDER BY s.id`
  ).all();
}

/**
 * Close the loop: recompute exactly the orders queued by approved adjustments,
 * then report what was recomputed and what stayed carried forward.
 */
export function recomputeForScopes(db, { actor = 'system', note = null } = {}) {
  const preview = recomputeScopePreview(db);
  if (!preview.full && preview.orders.length === 0 && preview.scopes.length === 0) {
    throw new AdjustError('当前没有待重算范围', { status: 409, code: 'no_pending_scope' });
  }
  const result = runReconciliation(db, {
    actor,
    note: note || '调整审批后重算',
    scopeIds: preview.scopes.map((s) => s.id),
    scope: preview.full
      ? { type: 'full' }
      : { type: 'orders', orderNos: preview.orders },
  });
  return { ...result, preview };
}
