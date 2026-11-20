import { createHash } from 'node:crypto';
import { parseCents } from './money.js';
import { audit, nowIso, tx } from './db.js';

export const SOURCES = ['orders', 'payments', 'refunds'];

const REQUIRED = {
  orders: ['order_no', 'ordered_at', 'business_date', 'gross'],
  payments: ['payment_no', 'order_no', 'paid_at', 'business_date', 'amount'],
  refunds: ['refund_no', 'order_no', 'refunded_at', 'business_date', 'amount'],
};

const PAYMENT_STATUS = new Set(['captured', 'pending', 'failed', 'void', 'refunded']);
const REFUND_STATUS = new Set(['settled', 'pending', 'failed']);
const ORDER_STATUS = new Set(['confirmed', 'cancelled', 'closed']);

export class IngestError extends Error {
  constructor(message, { status = 400, errors = [] } = {}) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

export function normalizeRow(source, raw, index) {
  const errors = [];
  const row = { ...raw };
  for (const field of REQUIRED[source]) {
    if (row[field] == null || row[field] === '') errors.push(`第 ${index + 1} 行缺少字段 ${field}`);
  }
  const out = { raw: JSON.stringify(raw) };
  const text = (field) => (row[field] == null ? null : String(row[field]).trim());
  const date = text('business_date');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push(`第 ${index + 1} 行 business_date 非法: ${date}`);

  if (source === 'orders') {
    out.order_no = text('order_no');
    out.customer_id = text('customer_id');
    out.ordered_at = text('ordered_at');
    out.business_date = date;
    out.currency = text('currency') || 'CNY';
    out.status = text('status') || 'confirmed';
    out.source_row_id = text('source_row_id') || `ROW-${index + 1}`;
    if (!ORDER_STATUS.has(out.status)) errors.push(`第 ${index + 1} 行订单状态未知: ${out.status}`);
    try {
      out.gross_cents = parseCents(row.gross);
      out.discount_cents = row.discount == null || row.discount === '' ? 0 : parseCents(row.discount);
      if (out.gross_cents < 0) errors.push(`第 ${index + 1} 行订单金额为负`);
      if (out.discount_cents < 0 || out.discount_cents > out.gross_cents) {
        errors.push(`第 ${index + 1} 行折扣不在合理范围`);
      }
    } catch (err) {
      errors.push(`第 ${index + 1} 行金额无法解析: ${row.gross ?? row.discount}`);
    }
  } else if (source === 'payments') {
    out.payment_no = text('payment_no');
    out.order_no = text('order_no');
    out.paid_at = text('paid_at');
    out.business_date = date;
    out.channel = text('channel');
    out.status = text('status') || 'captured';
    out.source_row_id = text('source_row_id') || `ROW-${index + 1}`;
    if (!PAYMENT_STATUS.has(out.status)) errors.push(`第 ${index + 1} 行支付状态未知: ${out.status}`);
    try {
      out.amount_cents = parseCents(row.amount);
      if (out.amount_cents < 0) errors.push(`第 ${index + 1} 行支付金额为负`);
    } catch {
      errors.push(`第 ${index + 1} 行金额无法解析: ${row.amount}`);
    }
  } else if (source === 'refunds') {
    out.refund_no = text('refund_no');
    out.payment_no = text('payment_no');
    out.order_no = text('order_no');
    out.refunded_at = text('refunded_at');
    out.business_date = date;
    out.reason = text('reason');
    out.status = text('status') || 'settled';
    out.source_row_id = text('source_row_id') || `ROW-${index + 1}`;
    if (!REFUND_STATUS.has(out.status)) errors.push(`第 ${index + 1} 行退款状态未知: ${out.status}`);
    try {
      out.amount_cents = parseCents(row.amount);
      if (out.amount_cents < 0) errors.push(`第 ${index + 1} 行退款金额为负`);
    } catch {
      errors.push(`第 ${index + 1} 行金额无法解析: ${row.amount}`);
    }
  } else {
    errors.push(`未知来源: ${source}`);
  }
  return { row: out, errors };
}

function checksum(source, rows) {
  return createHash('sha256')
    .update(source)
    .update('\n')
    .update(JSON.stringify(rows))
    .digest('hex')
    .slice(0, 16);
}

function factCols(source) {
  return source === 'orders'
    ? ['source_row_id', 'order_no', 'customer_id', 'ordered_at', 'business_date', 'currency',
      'gross_cents', 'discount_cents', 'status', 'raw']
    : source === 'payments'
      ? ['source_row_id', 'payment_no', 'order_no', 'paid_at', 'business_date', 'amount_cents',
        'channel', 'status', 'raw']
      : ['source_row_id', 'refund_no', 'payment_no', 'order_no', 'refunded_at', 'business_date',
        'amount_cents', 'reason', 'status', 'raw'];
}

function naturalKey(source, row) {
  return source === 'orders' ? row.order_no
    : source === 'payments' ? row.payment_no
      : row.refund_no;
}

function naturalKeyColumn(source) {
  return source === 'orders' ? 'order_no' : source === 'payments' ? 'payment_no' : 'refund_no';
}

function factTable(source) {
  return source === 'orders' ? 'order_fact' : source === 'payments' ? 'payment_fact' : 'refund_fact';
}

function amountOf(source, row) {
  return source === 'orders' ? row.gross_cents - row.discount_cents : row.amount_cents;
}

/**
 * Load one source export. The whole export is rejected when any row fails
 * validation, so a half-loaded feed can never masquerade as "missing data".
 */
export function loadBatch(db, payload, actor = 'system') {
  const source = String(payload.source || '');
  if (!SOURCES.includes(source)) throw new IngestError(`来源必须是 ${SOURCES.join(' / ')}`);
  const businessDate = String(payload.business_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new IngestError('business_date 必须是 YYYY-MM-DD');
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) throw new IngestError('批次必须包含至少一行数据');

  const normalized = payload.rows.map((row, i) => normalizeRow(source, row, i));
  const errors = normalized.flatMap((n) => n.errors);
  if (errors.length) {
    throw new IngestError('批次校验未通过，整批未导入', { status: 422, errors });
  }
  const rows = normalized.map((n) => n.row);
  const sourceRef = String(payload.source_ref || `${source}-${businessDate}`);
  const revision = Number.isInteger(payload.revision) && payload.revision > 0 ? payload.revision : 1;
  const sum = checksum(source, rows);

  const existing = db.prepare(
    'SELECT * FROM source_batch WHERE source = ? AND source_ref = ? AND business_date = ? AND revision = ?'
  ).get(source, sourceRef, businessDate, revision);
  if (existing) {
    if (existing.checksum === sum) {
      return { batchId: existing.id, idempotent: true, rowCount: existing.row_count };
    }
    throw new IngestError('同一 source_ref / 日期 / 修订号已有不同内容，拒绝覆盖', { status: 409 });
  }

  // A newer export for the same source+date supersedes the previous revision.
  const prior = db.prepare(
    `SELECT id, revision FROM source_batch
      WHERE source = ? AND business_date = ? AND status <> 'superseded'
      ORDER BY revision DESC LIMIT 1`
  ).get(source, businessDate);
  if (prior && revision <= prior.revision) {
    throw new IngestError(
      `已存在更新或同级的有效批次（修订 ${prior.revision}），请使用更高的 revision`,
      { status: 409 }
    );
  }

  return tx(db, () => {
    if (prior) {
      db.prepare("UPDATE source_batch SET status = 'superseded' WHERE id = ?").run(prior.id);
      audit(db, actor, 'batch.supersede', 'source_batch', prior.id, {
        replacedBy: sourceRef, revision,
      });
    }
    const info = db.prepare(
      `INSERT INTO source_batch
         (source, source_ref, business_date, revision, supersedes_batch_id, loaded_at,
          row_count, checksum, status, note)
       VALUES (?,?,?,?,?,?,?,?, 'loaded', ?)`
    ).run(source, sourceRef, businessDate, revision, prior ? prior.id : null, nowIso(),
      rows.length, sum, payload.note || null);
    const batchId = Number(info.lastInsertRowid);

    const table = factTable(source);
    const cols = factCols(source);
    const stmt = db.prepare(
      `INSERT INTO ${table} (batch_id, source, ${cols.join(',')}) VALUES (?, ?, ${cols.map(() => '?').join(',')})`
    );
    const ids = [];
    for (const row of rows) {
      const result = stmt.run(batchId, source, ...cols.map((c) => row[c] ?? null));
      ids.push(Number(result.lastInsertRowid));
    }
    markDuplicates(db, source, batchId);
    audit(db, actor, 'batch.load', 'source_batch', batchId, {
      source, source_ref: sourceRef, business_date: businessDate, revision, row_count: rows.length,
      superseded: prior ? prior.id : null,
    });
    const dupes = db.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE batch_id = ? AND is_duplicate = 1`
    ).get(batchId).n;
    return { batchId, idempotent: false, rowCount: rows.length, duplicates: dupes, supersededBatchId: prior?.id ?? null };
  });
}

/**
 * Mark repeated natural keys inside a batch, and re-deliveries of a key that an
 * effective batch already holds. The repeated row is never deleted: it keeps its
 * source_row_id so the evidence trail still shows the export contained it.
 */
export function markDuplicates(db, source, batchId) {
  const table = factTable(source);
  const keyCol = naturalKeyColumn(source);
  const rows = db.prepare(
    `SELECT id, source_row_id, ${keyCol} AS natural_key, business_date, status, raw
       FROM ${table}
      WHERE batch_id = ?
      ORDER BY id`
  ).all(batchId);
  const dbRows = rows.map((r) => {
    const raw = JSON.parse(r.raw);
    const amount = source === 'orders'
      ? parseCents(raw.gross) - (raw.discount == null || raw.discount === '' ? 0 : parseCents(raw.discount))
      : parseCents(raw.amount);
    return { ...r, amount };
  });

  const update = db.prepare(`UPDATE ${table} SET is_duplicate = 1, duplicate_of = ? WHERE id = ?`);
  const seen = new Map();
  for (const row of dbRows) {
    const key = `${row.natural_key}|${row.business_date}|${row.amount}|${row.status}`;
    if (seen.has(key)) {
      update.run(seen.get(key).source_row_id, row.id);
      continue;
    }
    const amountCols = source === 'orders' ? 'f.gross_cents, f.discount_cents' : 'f.amount_cents';
    const prior = db.prepare(
      `SELECT f.id, f.source_row_id, f.status, ${amountCols}
         FROM ${table} f
         JOIN source_batch b ON b.id = f.batch_id
        WHERE f.${keyCol} = ? AND f.business_date = ? AND f.batch_id <> ?
          AND f.is_duplicate = 0 AND b.status <> 'superseded'
        ORDER BY f.id LIMIT 1`
    ).get(row.natural_key, row.business_date, batchId);
    const priorAmount = prior && source === 'orders'
      ? prior.gross_cents - prior.discount_cents
      : prior?.amount_cents;
    if (prior && priorAmount === row.amount && prior.status === row.status) {
      update.run(prior.source_row_id, row.id);
      continue;
    }
    seen.set(key, row);
  }
}

export function loadPlan(db, plan, actor = 'seed') {
  const loaded = [];
  for (const batch of plan.batches) {
    const result = loadBatch(db, {
      source: batch.source,
      source_ref: batch.source_ref,
      business_date: batch.business_date,
      revision: batch.revision,
      rows: batch.rows,
      note: batch.note,
    }, actor);
    loaded.push({ ...result, source: batch.source, sourceRef: batch.source_ref, businessDate: batch.business_date });
  }
  return loaded;
}

export function setBatchStatus(db, batchId, status, actor = 'operator') {
  const allowed = new Set(['loaded', 'superseded', 'reconciled']);
  if (!allowed.has(status)) throw new IngestError(`批次状态非法: ${status}`);
  const batch = db.prepare('SELECT * FROM source_batch WHERE id = ?').get(batchId);
  if (!batch) throw new IngestError('批次不存在', { status: 404 });
  db.prepare('UPDATE source_batch SET status = ? WHERE id = ?').run(status, batchId);
  audit(db, actor, 'batch.status', 'source_batch', batchId, { from: batch.status, to: status });
  return db.prepare('SELECT * FROM source_batch WHERE id = ?').get(batchId);
}
