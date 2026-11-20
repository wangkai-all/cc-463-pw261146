import { audit, nowIso, tx } from './db.js';

/**
 * Reconciliation engine.
 *
 * Contract
 * --------
 * 1. Only effective batches count. A superseded export is never read as fact,
 *    but it is kept and cited as evidence when a value changed between revisions.
 * 2. Repeated rows are collapsed, never deleted. They keep their original
 *    source_row_id and are reported as explainable findings.
 * 3. Each source is read independently. An approved key correction writes an
 *    override keyed by (source, source_row_id, field). It never mutates the raw
 *    payload and never touches another source's rows.
 * 4. Per order the fact table carries three independent measures:
 *       order_amount   gross - discount, from the order source
 *       paid_amount    captured payments, from the payment source
 *       refunded_amount settled refunds, from the refund source
 *    The collection variance is  delta = paid - order_amount.
 *    Refund correctness is checked separately (refunded vs paid), so a fully
 *    refunded order is not misreported as an unpaid one.
 * 5. Every finding belongs to exactly one category:
 *       explainable  - the numbers reconcile once a known mechanism is applied
 *       pending_data - a feed, capture or settlement is still outstanding
 *       conflict     - evidence disagrees in a way no mechanism explains
 */

export const FINDING_CATEGORIES = ['explainable', 'pending_data', 'conflict'];
export const ENGINE_VERSION = 'recon-engine/1.1.0';

export const ACTION_RULES = {
  explainable: ['accept_diff', 'remap_key'],
  pending_data: ['defer_cutoff'],
  conflict: ['write_off', 'manual_entry', 'accept_diff'],
};

const CLOSING_ACTIONS = new Set(['accept_diff', 'write_off', 'manual_entry']);

/* ------------------------------------------------------------------ context */

function loadOverrides(db) {
  const map = new Map();
  for (const row of db.prepare('SELECT * FROM override_register').all()) {
    map.set(`${row.source}|${row.source_row_id}|${row.field}`, JSON.parse(row.value_json));
  }
  return map;
}

function overridden(overrides, source, row, field) {
  const key = `${source}|${row.source_row_id}|${field}`;
  return overrides.has(key) ? overrides.get(key) : row[field];
}

function effectiveFacts(db, source, overrides) {
  const table = source === 'orders' ? 'order_fact' : source === 'payments' ? 'payment_fact' : 'refund_fact';
  const rows = db.prepare(
    `SELECT f.*, b.source_ref, b.revision AS batch_revision, b.status AS batch_status
       FROM ${table} f JOIN source_batch b ON b.id = f.batch_id
      WHERE b.status <> 'superseded'
      ORDER BY f.id`
  ).all();
  return rows.map((row) => {
    if (source === 'orders') {
      const gross = overridden(overrides, 'orders', row, 'gross_cents');
      const discount = overridden(overrides, 'orders', row, 'discount_cents');
      return { ...row, gross_cents: gross, discount_cents: discount, net_cents: gross - discount };
    }
    if (source === 'payments') {
      return {
        ...row,
        order_no: overridden(overrides, 'payments', row, 'order_no'),
        amount_cents: overridden(overrides, 'payments', row, 'amount_cents'),
      };
    }
    return {
      ...row,
      order_no: overridden(overrides, 'refunds', row, 'order_no'),
      payment_no: overridden(overrides, 'refunds', row, 'payment_no'),
      amount_cents: overridden(overrides, 'refunds', row, 'amount_cents'),
    };
  });
}

export function evidence(row, fields = {}) {
  const base = {
    source: row.source,
    batch_id: row.batch_id,
    source_ref: row.source_ref,
    row_id: row.source_row_id,
    business_date: row.business_date,
  };
  if (row.source === 'orders') base.amount_cents = row.net_cents ?? row.gross_cents - row.discount_cents;
  else base.amount_cents = row.amount_cents;
  return { ...base, ...fields };
}

function emptyGroup(orderNo) {
  return {
    orderNo, orders: [], payments: [], refunds: [],
    duplicateOrders: [], duplicatePayments: [], duplicateRefunds: [],
  };
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** Deterministic key similarity: digit-only edit distance <= 2, or a permutation. */
export function similarKey(key, candidates) {
  const digits = (s) => String(s).replace(/\D/g, '');
  const target = digits(key);
  if (target.length < 6) return null;
  const scored = [...candidates]
    .filter((c) => c !== key)
    .map((c) => {
      const other = digits(c);
      const dist = editDistance(target, other);
      const permuted = target.length === other.length &&
        target.split('').sort().join('') === other.split('').sort().join('');
      return { key: c, dist, permuted };
    })
    .filter((c) => c.dist <= 2 || c.permuted)
    .sort((a, b) => a.dist - b.dist || a.key.localeCompare(b.key));
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].dist === scored[1].dist) return null; // ambiguous
  return scored[0].key;
}

export function buildContext(db) {
  const overrides = loadOverrides(db);
  const all = {
    orders: effectiveFacts(db, 'orders', overrides),
    payments: effectiveFacts(db, 'payments', overrides),
    refunds: effectiveFacts(db, 'refunds', overrides),
  };
  const facts = {
    orders: all.orders.filter((r) => r.is_duplicate === 0),
    payments: all.payments.filter((r) => r.is_duplicate === 0),
    refunds: all.refunds.filter((r) => r.is_duplicate === 0),
  };
  const duplicates = {
    orders: all.orders.filter((r) => r.is_duplicate === 1),
    payments: all.payments.filter((r) => r.is_duplicate === 1),
    refunds: all.refunds.filter((r) => r.is_duplicate === 1),
  };

  const byOrder = new Map();
  const get = (orderNo) => {
    if (!byOrder.has(orderNo)) byOrder.set(orderNo, emptyGroup(orderNo));
    return byOrder.get(orderNo);
  };
  for (const row of facts.orders) get(row.order_no).orders.push(row);
  for (const row of facts.payments) get(row.order_no).payments.push(row);
  for (const row of facts.refunds) get(row.order_no).refunds.push(row);
  for (const row of duplicates.orders) get(row.order_no).duplicateOrders.push(row);
  for (const row of duplicates.payments) get(row.order_no).duplicatePayments.push(row);
  for (const row of duplicates.refunds) get(row.order_no).duplicateRefunds.push(row);

  const orderNumbers = new Set(facts.orders.map((r) => r.order_no));

  // A payment whose order number matches nothing but closely matches exactly one
  // real order is a key typo. The payment stays in its own (typo) group as raw
  // evidence; the candidate order gets an explainable finding and a *virtual*
  // amount that never enters the payment source's totals.
  const remaps = new Map(); // typo order no -> { to, payments: [] }
  const remapTargets = new Map(); // real order no -> { from, payments }
  for (const [orderNo, group] of byOrder) {
    if (orderNumbers.has(orderNo) || group.orders.length) continue;
    if (!group.payments.length) continue;
    const candidate = similarKey(orderNo, orderNumbers);
    if (!candidate) continue;
    const entry = { to: candidate, from: orderNo, group };
    remaps.set(orderNo, entry);
    if (!remapTargets.has(candidate)) remapTargets.set(candidate, []);
    remapTargets.get(candidate).push(entry);
  }

  const feedDates = { orders: new Set(), payments: new Set(), refunds: new Set() };
  for (const source of ['orders', 'payments', 'refunds']) {
    for (const row of all[source]) feedDates[source].add(row.business_date);
    for (const batch of db.prepare(
      "SELECT business_date FROM source_batch WHERE source = ? AND status <> 'superseded'"
    ).all(source)) feedDates[source].add(batch.business_date);
  }

  const adjustmentsByOrder = new Map();
  for (const adj of db.prepare(
    `SELECT a.*, f.subtype, f.finding_key FROM adjustment a
       LEFT JOIN recon_finding f ON f.id = a.finding_id
      WHERE a.status = 'approved' AND a.order_no IS NOT NULL`
  ).all()) {
    if (!adjustmentsByOrder.has(adj.order_no)) adjustmentsByOrder.set(adj.order_no, []);
    adjustmentsByOrder.get(adj.order_no).push(adj);
  }

  return {
    db, overrides, facts, duplicates, byOrder, orderNumbers, remaps, remapTargets,
    feedDates, adjustmentsByOrder,
  };
}

/* ----------------------------------------------------------------- analysis */

function supersededOrderRows(db, orderNo) {
  return db.prepare(
    `SELECT f.*, b.source_ref, b.revision AS batch_revision
       FROM order_fact f JOIN source_batch b ON b.id = f.batch_id
      WHERE f.order_no = ? AND b.status = 'superseded' AND f.is_duplicate = 0
      ORDER BY b.revision`
  ).all(orderNo).map((row) => ({ ...row, net_cents: row.gross_cents - row.discount_cents }));
}

function sourceLabel(source) {
  return source === 'orders' ? '订单来源' : source === 'payments' ? '支付来源' : '退款来源';
}

function cents(n) {
  return (n / 100).toFixed(2);
}

function duplicateFinding(group, source, rows) {
  const canonical = source === 'orders' ? group.orders
    : source === 'payments' ? group.payments : group.refunds;
  const excluded = rows.reduce((s, r) => s + (r.source === 'orders' ? r.net_cents : r.amount_cents), 0);
  return {
    key: `${group.orderNo}:duplicate_rows:${source}`,
    subtype: `${source}_duplicate_rows`,
    category: 'explainable',
    severity: source === 'payments' ? 'high' : 'medium',
    title: `${sourceLabel(source)}存在重复行`,
    detail: `同一业务键在同一有效批次中出现了 ${rows.length + canonical.length} 次（重复 ${rows.length} 行，重复金额 ${cents(excluded)} 元）。对账只按一行计入，重复行保留原始 row_id 作为证据，对账金额影响为 0。`,
    amount_cents: 0,
    excluded_cents: excluded,
    auto_fixable: 1,
    suggested_action: 'accept_diff',
    evidence: [
      ...canonical.map((r) => evidence(r, { role: 'canonical' })),
      ...rows.map((r) => evidence(r, { role: 'duplicate', duplicate_of: r.duplicate_of })),
    ],
  };
}

export function analyseOrder(ctx, orderNo) {
  const group = ctx.byOrder.get(orderNo) || emptyGroup(orderNo);
  const findings = [];
  const add = (f) => findings.push(f);

  const order = group.orders[0] || null;
  const captured = group.payments.filter((p) => p.status === 'captured');
  const pendingPays = group.payments.filter((p) => p.status === 'pending' || p.status === 'failed');
  const voidedPays = group.payments.filter((p) => p.status === 'void');
  const settledRefunds = group.refunds.filter((r) => r.status === 'settled');
  const pendingRefunds = group.refunds.filter((r) => r.status === 'pending' || r.status === 'failed');

  /* 1. duplicates ------------------------------------------------------- */
  if (group.duplicateOrders.length) add(duplicateFinding(group, 'orders', group.duplicateOrders));
  if (group.duplicatePayments.length) add(duplicateFinding(group, 'payments', group.duplicatePayments));
  if (group.duplicateRefunds.length) add(duplicateFinding(group, 'refunds', group.duplicateRefunds));

  /* 2. key typo in another source (reported on this order) --------------- */
  let remapPending = 0;
  for (const entry of ctx.remapTargets.get(orderNo) || []) {
    const pays = entry.group.payments.filter((p) => p.status === 'captured');
    remapPending += pays.reduce((s, p) => s + p.amount_cents, 0);
    add({
      key: `${orderNo}:payment_key_typo:${entry.from}`,
      subtype: 'payment_key_typo',
      category: 'explainable',
      severity: 'high',
      title: '支付流水的订单号疑似录入错误',
      detail: `支付流水记录的订单号 ${entry.from} 在订单来源中不存在，与订单 ${orderNo} 高度相似且金额可对上。只需修正支付来源的关联键，订单与退款来源不做改动。`,
      amount_cents: remapPending,
      auto_fixable: 1,
      suggested_action: 'remap_key',
      remap: entry.group.payments.map((p) => ({
        source: 'payments', row_id: p.source_row_id, field: 'order_no',
        from: entry.from, to: orderNo,
      })),
      evidence: [
        ...pays.map((p) => evidence(p, { role: 'payment', order_no: entry.from })),
        ...(order ? [evidence(order, { role: 'order' })] : []),
      ],
    });
  }

  /* 3. refunds without a payment reference ------------------------------ */
  for (const r of group.refunds) {
    if (r.payment_no) continue;
    const candidates = captured.filter((p) => {
      const otherRefund = group.refunds.some((x) => x !== r && x.payment_no === p.payment_no);
      return !otherRefund;
    });
    if (order && candidates.length === 1) {
      add({
        key: `${orderNo}:refund_key_gap:${r.refund_no}`,
        subtype: 'refund_key_gap',
        category: 'explainable',
        severity: 'medium',
        title: '退款缺少支付流水号',
        detail: `退款 ${r.refund_no} 未携带支付流水号；订单 ${orderNo} 唯一一笔已捕获支付为 ${candidates[0].payment_no}，可安全补键。`,
        amount_cents: r.amount_cents,
        auto_fixable: 1,
        suggested_action: 'remap_key',
        remap: [{ source: 'refunds', row_id: r.source_row_id, field: 'payment_no', from: null, to: candidates[0].payment_no }],
        evidence: [
          evidence(r, { role: 'refund', payment_no: null }),
          evidence(candidates[0], { role: 'payment' }),
        ],
      });
    } else {
      add({
        key: `${orderNo}:refund_missing_payment_ref:${r.refund_no}`,
        subtype: 'refund_missing_payment_ref',
        category: 'pending_data',
        severity: 'medium',
        title: '退款无法归属到支付流水',
        detail: `退款 ${r.refund_no} 未携带支付流水号，且订单 ${orderNo} 的候选支付不唯一，需要人工补充关联后再对账。`,
        amount_cents: r.amount_cents,
        auto_fixable: 0,
        suggested_action: 'manual_entry',
        evidence: [evidence(r, { role: 'refund', payment_no: null }),
        ...captured.map((p) => evidence(p, { role: 'payment_candidate' }))],
      });
    }
  }

  /* 4. cross-day refund -------------------------------------------------- */
  for (const r of group.refunds) {
    if (!r.payment_no) continue;
    const p = group.payments.find((x) => x.payment_no === r.payment_no);
    if (!p || p.business_date === r.business_date) continue;
    add({
      key: `${orderNo}:cross_day_refund:${r.refund_no}`,
      subtype: 'cross_day_refund',
      category: 'explainable',
      severity: 'low',
      title: '退款跨日入账',
      detail: `退款 ${r.refund_no} 记于 ${r.business_date}，对应支付 ${p.payment_no} 发生在 ${p.business_date}。本对账按订单口径归集，不做跨日拆分。`,
      amount_cents: r.amount_cents,
      auto_fixable: 1,
      suggested_action: 'accept_diff',
      evidence: [
        evidence(r, { role: 'refund' }),
        evidence(p, { role: 'payment' }),
      ],
    });
  }

  /* 5. in-flight records -------------------------------------------------- */
  // Pending payments are reported per row only when they are not already the
  // explanation for an order-level shortfall (section 8), so the same cents are
  // never counted twice in the finding list.
  const capturedSoFar = captured.reduce((sum, p) => sum + p.amount_cents, 0);
  const pendingExplainsShortfall = Boolean(order) && capturedSoFar < order.net_cents &&
    pendingPays.some((p) => p.amount_cents >= order.net_cents - capturedSoFar);
  if (!pendingExplainsShortfall) {
    for (const p of pendingPays) {
      add({
        key: `${orderNo}:payment_pending:${p.payment_no}`,
        subtype: 'payment_in_flight',
        category: 'pending_data',
        severity: 'medium',
        title: p.status === 'failed' ? '支付流水失败待重试' : '支付流水尚未完成',
        detail: `支付 ${p.payment_no} 状态为 ${p.status}，不计入已收款；等状态回写后按订单重算。`,
        amount_cents: p.amount_cents,
        auto_fixable: 0,
        suggested_action: 'defer_cutoff',
        evidence: [evidence(p, { role: 'payment_in_flight' })],
      });
    }
  }
  for (const r of pendingRefunds) {
    add({
      key: `${orderNo}:refund_pending:${r.refund_no}`,
      subtype: 'refund_in_flight',
      category: 'pending_data',
      severity: 'medium',
      title: r.status === 'failed' ? '退款失败待重试' : '退款尚未结算',
      detail: `退款 ${r.refund_no} 状态为 ${r.status}，不计入已退款；等结算回执后按订单重算。`,
      amount_cents: r.amount_cents,
      auto_fixable: 0,
      suggested_action: 'defer_cutoff',
      evidence: [evidence(r, { role: 'refund_in_flight' })],
    });
  }
  for (const p of voidedPays) {
    add({
      key: `${orderNo}:payment_void:${p.payment_no}`,
      subtype: 'payment_voided',
      category: 'explainable',
      severity: 'low',
      title: '支付流水已作废',
      detail: `支付 ${p.payment_no} 状态为 void，已从收款中排除。`,
      amount_cents: p.amount_cents,
      auto_fixable: 1,
      suggested_action: 'accept_diff',
      evidence: [evidence(p, { role: 'payment_voided' })],
    });
  }

  /* 6. measures ---------------------------------------------------------- */
  const paid = captured.reduce((s, p) => s + p.amount_cents, 0);
  const refunded = settledRefunds.reduce((s, r) => s + r.amount_cents, 0);
  const net = paid - refunded;
  let expected = order ? order.net_cents : 0;
  let delta = order ? paid - expected : 0;
  let deltaExplained = false;

  if (order && order.status === 'cancelled') {
    if (delta !== 0) {
      add({
        key: `${orderNo}:cancelled_order`,
        subtype: 'cancelled_order',
        category: 'explainable',
        severity: 'medium',
        title: '订单已取消但仍记录应收',
        detail: `订单 ${orderNo} 已取消，应收按 0 计；来源保留原金额 ${cents(expected)} 元与已收 ${cents(paid)} 元作为证据，差异 ${cents(delta)} 元可由取消状态解释。`,
        amount_cents: Math.abs(delta),
        auto_fixable: 1,
        suggested_action: 'accept_diff',
        evidence: [evidence(order, { role: 'order' }),
        ...captured.map((p) => evidence(p, { role: 'payment' }))],
      });
      expected = paid;
      delta = 0;
      deltaExplained = true;
    }
  }

  /* 7. source revision ---------------------------------------------------- */
  if (order && delta !== 0) {
    const revisions = supersededOrderRows(ctx.db, orderNo);
    const prior = revisions.find((r) => r.net_cents - order.net_cents === delta);
    if (prior) {
      add({
        key: `${orderNo}:source_revision:${prior.batch_revision}`,
        subtype: 'source_revision',
        category: 'explainable',
        severity: 'high',
        title: '订单来源被新修订覆盖',
        detail: `订单 ${orderNo} 的金额由修订 ${prior.batch_revision} 的 ${cents(prior.net_cents)} 元更正为 ${cents(order.net_cents)} 元（${order.source_ref}），支付仍按修订前金额结算。差额 ${cents(delta)} 元来自来源修订，不是资金差错；订单、支付两个来源均保留各自证据。`,
        amount_cents: Math.abs(delta),
        auto_fixable: 1,
        suggested_action: 'accept_diff',
        evidence: [
          evidence(order, { role: 'current_revision', revision: order.batch_revision }),
          evidence(prior, { role: 'superseded_revision', revision: prior.batch_revision }),
          ...captured.map((p) => evidence(p, { role: 'payment' })),
        ],
      });
      deltaExplained = true;
    }
  }

  /* 8. collection variance ------------------------------------------------ */
  const effectivePaid = paid + remapPending;
  const effectiveDelta = order ? effectivePaid - expected : remapPending;

  if (order && remapPending !== 0 && effectiveDelta === 0) {
    // the typo finding (2) already explains this; do not raise a conflict
  } else if (order && !group.payments.length) {
    const missingFeed = !ctx.feedDates.payments.has(order.business_date);
    add({
      key: `${orderNo}:no_payment_rows`,
      subtype: missingFeed ? 'payment_feed_missing' : 'order_without_payment',
      category: missingFeed ? 'pending_data' : 'conflict',
      severity: missingFeed ? 'medium' : 'high',
      title: missingFeed ? '当日支付流水尚未到齐' : '订单没有任何支付流水',
      detail: missingFeed
        ? `订单 ${orderNo} 所在业务日 ${order.business_date} 的支付批次尚未导入，无法判断是否收款，等待补数。`
        : `订单 ${orderNo} 已确认（${cents(expected)} 元），但 ${order.business_date} 的支付批次中没有对应流水。`,
      amount_cents: expected,
      auto_fixable: 0,
      suggested_action: missingFeed ? 'defer_cutoff' : 'manual_entry',
      evidence: [evidence(order, { role: 'order' })],
    });
  } else if (order && effectiveDelta !== 0 && !deltaExplained) {
    if (pendingPays.length && effectiveDelta < 0) {
      add({
        key: `${orderNo}:partial_payment`,
        subtype: 'partial_payment',
        category: 'pending_data',
        severity: 'medium',
        title: '部分支付尚未完成',
        detail: `订单 ${orderNo} 应收 ${cents(expected)} 元，已捕获 ${cents(paid)} 元，尚有 ${cents(-effectiveDelta)} 元处于在途（${pendingPays.map((p) => p.payment_no).join('、')}）。`,
        amount_cents: -effectiveDelta,
        auto_fixable: 0,
        suggested_action: 'defer_cutoff',
        evidence: [evidence(order, { role: 'order' }),
        ...captured.map((p) => evidence(p, { role: 'payment' })),
        ...pendingPays.map((p) => evidence(p, { role: 'payment_in_flight' }))],
      });
    } else {
      const over = effectiveDelta > 0;
      add({
        key: `${orderNo}:${over ? 'overpaid' : 'underpaid'}`,
        subtype: over ? 'overpaid' : 'underpaid',
        category: 'conflict',
        severity: 'high',
        title: over ? '收款超过订单金额' : '收款不足订单金额',
        detail: `订单 ${orderNo} 应收 ${cents(expected)} 元，已捕获 ${cents(paid)} 元${refunded ? `、已退 ${cents(refunded)} 元` : ''}，净收 ${cents(net)} 元，${over ? '多收' : '少收'} ${cents(Math.abs(effectiveDelta))} 元，且来源中没有可解释该差额的机制。`,
        amount_cents: Math.abs(effectiveDelta),
        auto_fixable: 0,
        suggested_action: 'manual_entry',
        evidence: [evidence(order, { role: 'order' }),
        ...captured.map((p) => evidence(p, { role: 'payment' })),
        ...settledRefunds.map((r) => evidence(r, { role: 'refund' })),
        ...pendingPays.map((p) => evidence(p, { role: 'payment_in_flight', excluded_from_paid: true }))],
      });
    }
  }

  /* 9. refunds against capture ------------------------------------------- */
  if (order && refunded > paid) {
    add({
      key: `${orderNo}:refund_exceeds_capture`,
      subtype: 'refund_exceeds_capture',
      category: 'conflict',
      severity: 'high',
      title: '退款金额超过已收款',
      detail: `订单 ${orderNo} 已捕获 ${cents(paid)} 元，已结算退款 ${cents(refunded)} 元，超出 ${cents(refunded - paid)} 元。`,
      amount_cents: refunded - paid,
      auto_fixable: 0,
      suggested_action: 'manual_entry',
      evidence: [...captured.map((p) => evidence(p, { role: 'payment' })),
      ...settledRefunds.map((r) => evidence(r, { role: 'refund' }))],
    });
  }

  /* 10. payment/refund with no order at all ------------------------------- */
  if (!order) {
    const typo = ctx.remaps.has(orderNo);
    if (!typo) {
      const dates = [...new Set([...group.payments, ...group.refunds].map((r) => r.business_date))];
      const feedMissing = dates.some((d) => !ctx.feedDates.orders.has(d));
      const amount = group.payments.length
        ? group.payments.reduce((s, p) => s + (p.status === 'captured' ? p.amount_cents : 0), 0)
        : group.refunds.reduce((s, r) => s + r.amount_cents, 0);
      add({
        key: `${orderNo}:order_missing`,
        subtype: feedMissing ? 'order_feed_missing' : 'payment_without_order',
        category: feedMissing ? 'pending_data' : 'conflict',
        severity: 'high',
        title: feedMissing ? '订单来源当日批次缺失' : '支付/退款找不到订单',
        detail: feedMissing
          ? `订单号 ${orderNo} 出现在支付或退款来源，但 ${dates.join('、')} 的订单批次尚未导入。`
          : `订单号 ${orderNo} 出现在支付或退款来源，订单来源中没有对应记录，也没有可自动关联的候选订单。`,
        amount_cents: Math.abs(amount),
        auto_fixable: 0,
        suggested_action: feedMissing ? 'defer_cutoff' : 'manual_entry',
        evidence: [...group.payments.map((p) => evidence(p, { role: 'payment' })),
        ...group.refunds.map((r) => evidence(r, { role: 'refund' }))],
      });
    }
  }

  return {
    orderNo,
    order,
    paid, refunded, net, expected, delta,
    remapPending,
    adjustmentCents: 0,
    findings,
    group,
    analysed: Boolean(order) || findings.length > 0,
  };
}

/* ------------------------------------------------------------ adjustments */

function applyAdjustments(base, adjustments) {
  let adjustmentCents = 0;
  const acceptedSubtypes = new Set();
  const deferredSubtypes = new Set();
  const used = [];
  for (const adj of adjustments) {
    used.push(adj);
    if (adj.action === 'defer_cutoff') {
      deferredSubtypes.add(adj.subtype);
      continue;
    }
    if (CLOSING_ACTIONS.has(adj.action)) {
      acceptedSubtypes.add(adj.subtype);
      if (adj.action === 'write_off' && base.delta !== 0) {
        const offset = Math.min(Math.abs(base.delta), Math.abs(adj.amount_cents));
        adjustmentCents += base.delta > 0 ? -offset : offset;
      }
    }
  }
  const findings = base.findings.map((f) => {
    if (acceptedSubtypes.has(f.subtype)) {
      return { ...f, inherited_accepted: true, adjustment_id: used.find((a) => a.subtype === f.subtype)?.id ?? null };
    }
    if (deferredSubtypes.has(f.subtype)) {
      return { ...f, inherited_deferred: true };
    }
    return f;
  });
  const open = findings.filter((f) => !f.inherited_accepted);
  const residual = base.delta + adjustmentCents;
  let status;
  if (open.some((f) => f.category === 'conflict')) status = 'conflict';
  else if (open.some((f) => f.category === 'pending_data')) status = 'pending';
  else if (open.length || used.length) status = 'explained';
  else status = residual === 0 && base.remapPending === 0 ? 'matched' : 'explained';
  return { ...base, findings, adjustmentCents, residual, status, adjustments: used };
}

/* ------------------------------------------------------------------ run */

function normalizeScope(scope) {
  if (!scope || scope.type === 'full' || scope.type === 'all') return { type: 'full' };
  if (scope.type === 'order') {
    if (!scope.orderNo) throw Object.assign(new Error('order 范围需要 orderNo'), { status: 400 });
    return { type: 'order', orderNo: String(scope.orderNo) };
  }
  if (scope.type === 'source_date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(scope.sourceDate || '')) {
      throw Object.assign(new Error('source_date 范围需要合法的 sourceDate'), { status: 400 });
    }
    return { type: 'source_date', sourceDate: scope.sourceDate };
  }
  if (scope.type === 'batch') {
    if (!Number.isInteger(scope.batchId)) throw Object.assign(new Error('batch 范围需要 batchId'), { status: 400 });
    return { type: 'batch', batchId: scope.batchId };
  }
  if (scope.type === 'orders') {
    if (!Array.isArray(scope.orderNos) || scope.orderNos.length === 0) {
      throw Object.assign(new Error('orders 范围需要 orderNos'), { status: 400 });
    }
    return { type: 'orders', orderNos: scope.orderNos.map(String) };
  }
  throw Object.assign(new Error(`未知重算范围: ${scope.type}`), { status: 400 });
}

export function affectedOrders(ctx, scope) {
  if (!scope || scope.type === 'full') return [...ctx.byOrder.keys()];
  if (scope.type === 'order') return ctx.byOrder.has(scope.orderNo) ? [scope.orderNo] : [];
  if (scope.type === 'orders') return [...new Set(scope.orderNos.map(String))].sort();
  if (scope.type === 'source_date') {
    const set = new Set();
    for (const [orderNo, group] of ctx.byOrder) {
      if ([...group.orders, ...group.payments, ...group.refunds,
        ...group.duplicateOrders, ...group.duplicatePayments, ...group.duplicateRefunds]
        .some((r) => r.business_date === scope.sourceDate)) set.add(orderNo);
    }
    return [...set].sort();
  }
  const batch = ctx.db.prepare('SELECT * FROM source_batch WHERE id = ?').get(scope.batchId);
  if (!batch) throw Object.assign(new Error('批次不存在'), { status: 404 });
  const table = batch.source === 'orders' ? 'order_fact' : batch.source === 'payments' ? 'payment_fact' : 'refund_fact';
  const rows = ctx.db.prepare(`SELECT order_no FROM ${table} WHERE batch_id = ?`).all(batch.id);
  return [...new Set(rows.map((r) => r.order_no))].sort();
}

export function recomputeScopePreview(db, scopes = null) {
  const ctx = buildContext(db);
  const pending = scopes ?? db.prepare(
    'SELECT * FROM recompute_scope WHERE consumed_at IS NULL ORDER BY id'
  ).all();
  const orderSet = new Set();
  let full = false;
  for (const s of pending) {
    const scope = s.scope_type === 'order' ? { type: 'order', orderNo: s.order_no }
      : s.scope_type === 'batch' ? { type: 'batch', batchId: s.batch_id }
        : s.scope_type === 'source_date' ? { type: 'source_date', sourceDate: s.source_date }
          : { type: 'full' };
    if (scope.type === 'full') { full = true; break; }
    for (const orderNo of affectedOrders(ctx, scope)) orderSet.add(orderNo);
  }
  return {
    full,
    orders: full ? [] : [...orderSet].sort(),
    scopes: pending.map((s) => ({
      id: s.id, type: s.scope_type, order_no: s.order_no, batch_id: s.batch_id,
      source_date: s.source_date, reason: s.reason, created_at: s.created_at,
    })),
    batches: [...new Set(pending.filter((s) => s.batch_id).map((s) => s.batch_id))],
  };
}

export function addScope(db, scope, { findingId = null, adjustmentId = null, reason }) {
  db.prepare(
    `INSERT INTO recompute_scope
       (run_id, finding_id, adjustment_id, scope_type, order_no, batch_id, source_date, reason, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(scope.runId ?? null, findingId, adjustmentId, scope.type, scope.orderNo ?? null,
    scope.batchId ?? null, scope.sourceDate ?? null, reason, nowIso());
}

export function runReconciliation(db, { scope = null, actor = 'system', note = null, scopeIds = [] } = {}) {
  const normalized = normalizeScope(scope);
  const ctx = buildContext(db);
  const previous = db.prepare('SELECT * FROM recon_run ORDER BY id DESC LIMIT 1').get();

  const computed = new Map();
  for (const [orderNo, group] of ctx.byOrder) {
    const result = analyseOrder(ctx, orderNo);
    if (!result.analysed) continue; // only a typo'd payment group; reported on its candidate
    computed.set(orderNo, result);
  }

  const inScope = new Set(affectedOrders(ctx, normalized));
  const carryResults = previous
    ? db.prepare('SELECT * FROM recon_result WHERE run_id = ?').all(previous.id)
    : [];
  const carryFindings = previous
    ? db.prepare('SELECT * FROM recon_finding WHERE run_id = ?').all(previous.id)
    : [];
  const carryByOrder = new Map(carryResults.map((r) => [r.order_no, r]));
  const carryFindingsByResult = new Map();
  for (const f of carryFindings) {
    if (!carryFindingsByResult.has(f.result_id)) carryFindingsByResult.set(f.result_id, []);
    carryFindingsByResult.get(f.result_id).push(f);
  }

  const batchId = normalized.type === 'batch' ? normalized.batchId
    : db.prepare("SELECT id FROM source_batch WHERE status <> 'superseded' ORDER BY id DESC LIMIT 1").get()?.id ?? null;

  return tx(db, () => {
    const runInfo = db.prepare(
      `INSERT INTO recon_run (batch_id, run_at, scope_json, recomputed_from, engine_version, summary_json, status)
       VALUES (?,?,?,?,?, '{}', 'completed')`
    ).run(batchId, nowIso(), JSON.stringify(normalized), previous?.id ?? null, ENGINE_VERSION);
    const runId = Number(runInfo.lastInsertRowid);

    const insertResult = db.prepare(
      `INSERT INTO recon_result
        (run_id, order_no, order_batch_id, order_cents, paid_cents, refunded_cents, net_cents,
         expected_cents, delta_cents, adjustment_cents, status, evidence_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const insertFinding = db.prepare(
      `INSERT INTO recon_finding
        (run_id, result_id, order_no, finding_key, category, subtype, severity, title, detail,
         amount_cents, explainable, auto_fixable, status, evidence_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );

    const summary = {
      matched: 0, explained: 0, pending: 0, conflict: 0,
      recomputed: 0, carried: 0,
      findings: { explainable: 0, pending_data: 0, conflict: 0 },
      amounts: { pending: 0, conflict: 0, explainable: 0, pending_data: 0 },
    };
    const orderCents = { order: 0, paid: 0, refunded: 0, delta: 0, unresolved: 0 };

    for (const [orderNo, base] of computed) {
      const scoped = inScope.has(orderNo);
      const carriedPrev = previous ? carryByOrder.get(orderNo) : null;
      if (!scoped && carriedPrev) {
        const resultInfo = insertResult.run(runId, carriedPrev.order_no, carriedPrev.order_batch_id,
          carriedPrev.order_cents, carriedPrev.paid_cents, carriedPrev.refunded_cents, carriedPrev.net_cents,
          carriedPrev.expected_cents, carriedPrev.delta_cents, carriedPrev.adjustment_cents,
          carriedPrev.status, carriedPrev.evidence_json);
        const resultId = Number(resultInfo.lastInsertRowid);
        for (const f of carryFindingsByResult.get(carriedPrev.id) || []) {
          insertFinding.run(runId, resultId, f.order_no, f.finding_key, f.category, f.subtype, f.severity,
            f.title, f.detail, f.amount_cents, f.explainable, f.auto_fixable, f.status, f.evidence_json);
          if (f.status === 'open') {
            summary.findings[f.category] += 1;
            summary.amounts[f.category] += Math.abs(f.amount_cents);
          }
        }
        summary[carriedPrev.status] = (summary[carriedPrev.status] || 0) + 1;
        summary.carried += 1;
        orderCents.order += carriedPrev.order_cents;
        orderCents.paid += carriedPrev.paid_cents;
        orderCents.refunded += carriedPrev.refunded_cents;
        orderCents.delta += carriedPrev.delta_cents;
        orderCents.unresolved += carriedPrev.delta_cents + carriedPrev.adjustment_cents;
        continue;
      }

      const merged = applyAdjustments(base, ctx.adjustmentsByOrder.get(orderNo) || []);
      summary.recomputed += 1;
      summary[merged.status] = (summary[merged.status] || 0) + 1;
      const allEvidence = merged.findings.flatMap((f) => f.evidence || []);
      const resultInfo = insertResult.run(runId, orderNo, merged.order?.batch_id ?? null,
        merged.order?.gross_cents ?? 0, merged.paid, merged.refunded, merged.net, merged.expected,
        merged.delta, merged.adjustmentCents, merged.status, JSON.stringify(allEvidence));
      const resultId = Number(resultInfo.lastInsertRowid);
      orderCents.order += merged.order?.gross_cents ?? 0;
      orderCents.paid += merged.paid;
      orderCents.refunded += merged.refunded;
      orderCents.delta += merged.delta;
      orderCents.unresolved += merged.residual;

      for (const f of merged.findings) {
        if (f.inherited_accepted) {
          // keep the trail: the finding is re-created as accepted, linked to its adjustment
          insertFinding.run(runId, resultId, orderNo, f.key, f.category, f.subtype, f.severity, f.title, f.detail,
            f.amount_cents, f.category === 'explainable' ? 1 : 0, f.auto_fixable ? 1 : 0, 'accepted',
            JSON.stringify({ ...f, evidence: f.evidence }));
          continue;
        }
        const status = f.inherited_deferred ? 'waived' : 'open';
        insertFinding.run(runId, resultId, orderNo, f.key, f.category, f.subtype, f.severity, f.title, f.detail,
          f.amount_cents, f.category === 'explainable' ? 1 : 0, f.auto_fixable ? 1 : 0, status,
          JSON.stringify({ ...f, evidence: f.evidence }));
        summary.findings[f.category] += 1;
        summary.amounts[f.category] += Math.abs(f.amount_cents);
      }
    }

    summary.amounts.pending = summary.amounts.pending_data;
    summary.totals = orderCents;
    db.prepare('UPDATE recon_run SET summary_json = ? WHERE id = ?').run(JSON.stringify(summary), runId);

    // mark the scopes this run consumed and the adjustments it applied
    const appliedAdjustmentIds = new Set();
    for (const list of ctx.adjustmentsByOrder.values()) {
      for (const adj of list) if (inScope.has(adj.order_no)) appliedAdjustmentIds.add(adj.id);
    }
    for (const id of appliedAdjustmentIds) {
      db.prepare('UPDATE adjustment SET applied_run_id = ?, applied_at = ? WHERE id = ? AND applied_run_id IS NULL')
        .run(runId, nowIso(), id);
    }
    if (scopeIds.length) {
      const stmt = db.prepare('UPDATE recompute_scope SET consumed_at = ?, consumed_run_id = ? WHERE id = ? AND consumed_at IS NULL');
      for (const id of scopeIds) stmt.run(nowIso(), runId, id);
    } else if (normalized.type === 'full') {
      db.prepare('UPDATE recompute_scope SET consumed_at = ?, consumed_run_id = ? WHERE consumed_at IS NULL')
        .run(nowIso(), runId);
    }

    audit(db, actor, 'recon.run', 'recon_run', runId, {
      scope: normalized, summary, note, adjustments_applied: [...appliedAdjustmentIds],
    });
    return { runId, summary, scope: normalized };
  });
}

/* --------------------------------------------------------------- queries */

export function latestRun(db) {
  return db.prepare('SELECT * FROM recon_run ORDER BY id DESC LIMIT 1').get();
}

export function resultsFor(db, runId) {
  const results = db.prepare('SELECT * FROM recon_result WHERE run_id = ? ORDER BY order_no').all(runId);
  const findings = db.prepare(
    `SELECT f.*, (SELECT COUNT(*) FROM adjustment a WHERE a.finding_id = f.id) AS adjustment_count
       FROM recon_finding f WHERE f.run_id = ? ORDER BY f.id`
  ).all(runId);
  const byResult = new Map();
  for (const f of findings) {
    if (!byResult.has(f.result_id)) byResult.set(f.result_id, []);
    byResult.get(f.result_id).push({ ...f, evidence: safeJson(f.evidence_json).evidence || safeJson(f.evidence_json) });
  }
  return results.map((r) => ({
    ...r,
    evidence: safeJson(r.evidence_json),
    findings: byResult.get(r.id) || [],
  }));
}

export function safeJson(text, fallback = []) {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return fallback;
  }
}

export function recountSummary(db, runId, stored) {
  if (!stored) {
    const run = db.prepare('SELECT summary_json FROM recon_run WHERE id = ?').get(runId);
    stored = safeJson(run?.summary_json, {});
  }
  const summary = {
    matched: 0, explained: 0, pending: 0, conflict: 0,
    recomputed: stored.recomputed ?? 0, carried: stored.carried ?? 0,
    findings: { explainable: 0, pending_data: 0, conflict: 0 },
    amounts: { pending: 0, conflict: 0 },
    totals: { order: 0, paid: 0, refunded: 0, delta: 0, unresolved: 0 },
  };
  for (const row of db.prepare(
    'SELECT status, COUNT(*) AS n, SUM(order_cents) o, SUM(paid_cents) p, SUM(refunded_cents) r, ' +
    'SUM(delta_cents) d, SUM(delta_cents + adjustment_cents) u ' +
    'FROM recon_result WHERE run_id = ? GROUP BY status'
  ).all(runId)) {
    summary[row.status] = (summary[row.status] || 0) + row.n;
    summary.totals.order += row.o || 0;
    summary.totals.paid += row.p || 0;
    summary.totals.refunded += row.r || 0;
    summary.totals.delta += row.d || 0;
    summary.totals.unresolved += row.u || 0;
  }
  for (const row of db.prepare(
    "SELECT category, COUNT(*) AS n FROM recon_finding WHERE run_id = ? AND status = 'open' GROUP BY category"
  ).all(runId)) {
    summary.findings[row.category] = row.n;
  }
  for (const row of db.prepare(
    "SELECT category, SUM(amount_cents) AS amt FROM recon_finding WHERE run_id = ? AND status = 'open' GROUP BY category"
  ).all(runId)) {
    if (row.category === 'pending_data') summary.amounts.pending = row.amt || 0;
    if (row.category === 'conflict') summary.amounts.conflict = row.amt || 0;
    summary.amounts[row.category] = row.amt || 0;
  }
  return summary;
}
