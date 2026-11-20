import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { seedPlan } from '../server/seed.js';
import { loadPlan, loadBatch, setBatchStatus, IngestError } from '../server/ingest.js';
import {
  runReconciliation, resultsFor, buildContext, recountSummary, similarKey,
} from '../server/reconcile.js';
import {
  proposeAdjustment, approveAdjustment, rejectAdjustment, AdjustError,
  getAdjustment, listAdjustments, pendingScope, recomputeForScopes,
} from '../server/adjustments.js';

function fresh() {
  const db = openDb(':memory:');
  loadPlan(db, seedPlan());
  return db;
}

function byOrder(db, runId, orderNo) {
  return resultsFor(db, runId).find((r) => r.order_no === orderNo);
}

function findingFor(result, subtype) {
  return result.findings.find((f) => f.subtype === subtype);
}

test('seed produces a full reconciliation snapshot', () => {
  const db = fresh();
  const { runId, summary } = runReconciliation(db, { actor: 'test' });
  assert.equal(summary.recomputed, 19);
  assert.equal(summary.carried, 0);
  assert.equal(summary.matched + summary.explained + summary.pending + summary.conflict, 19);
  assert.equal(summary.findings.conflict, 3);
});

test('duplicate rows are collapsed but preserved as evidence', () => {
  const db = fresh();
  const { runId } = runReconciliation(db, { actor: 'test' });
  const result = byOrder(db, runId, 'SO-20261103-0005');
  const finding = findingFor(result, 'orders_duplicate_rows');
  assert.ok(finding, 'duplicate finding exists');
  assert.equal(finding.category, 'explainable');
  assert.equal(finding.amount_cents, 0, 'duplicates do not change the reconciliation amount');
  const payload = JSON.parse(finding.evidence_json);
  assert.equal(payload.excluded_cents, 340000);
  assert.equal(payload.evidence.length, 2);
  const roles = payload.evidence.map((e) => e.role).sort();
  assert.deepEqual(roles, ['canonical', 'duplicate']);

  const rows = db.prepare(
    "SELECT source_row_id, is_duplicate, duplicate_of FROM order_fact WHERE order_no = 'SO-20261103-0005' ORDER BY id"
  ).all();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].is_duplicate, 1);
  assert.equal(rows[1].duplicate_of, rows[0].source_row_id);
  assert.equal(result.paid_cents, 340000, 'only one payment counted');
});

test('identical re-delivery of a source export is idempotent', () => {
  const db = fresh();
  const plan = seedPlan();
  const batch = plan.batches.find((b) => b.source_ref === 'psp-payments-20261102-v1');
  const again = loadBatch(db, {
    source: batch.source, source_ref: batch.source_ref, business_date: batch.business_date,
    revision: batch.revision, rows: batch.rows,
  }, 'test');
  assert.equal(again.idempotent, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_batch').get().n, plan.batches.length);
});

test('a different payload for an already-loaded revision is rejected', () => {
  const db = fresh();
  const batch = seedPlan().batches.find((b) => b.source_ref === 'psp-payments-20261102-v1');
  const changed = batch.rows.map((r, i) => (i === 0 ? { ...r, amount: '9999.00' } : r));
  assert.throws(() => loadBatch(db, {
    source: batch.source, source_ref: batch.source_ref, business_date: batch.business_date,
    revision: batch.revision, rows: changed,
  }, 'test'), (err) => err instanceof IngestError && err.status === 409);
});

test('a newer revision supersedes the old one but both remain queryable', () => {
  const db = fresh();
  const batches = db.prepare(
    "SELECT id, revision, status FROM source_batch WHERE source='orders' AND business_date='2026-11-04' ORDER BY revision"
  ).all();
  assert.equal(batches.length, 2);
  assert.equal(batches[0].status, 'superseded');
  assert.equal(batches[1].status, 'loaded');
  const facts = db.prepare('SELECT net FROM (SELECT gross_cents - discount_cents AS net FROM order_fact WHERE order_no = \'SO-20261104-0003\')').all();
  assert.deepEqual(facts.map((f) => f.net).sort((a, b) => a - b), [160000, 188000], 'raw rows from both revisions stay');
});

test('revision-driven variance is classified explainable, not conflict', () => {
  const db = fresh();
  const { runId } = runReconciliation(db, { actor: 'test' });
  const result = byOrder(db, runId, 'SO-20261104-0003');
  assert.equal(result.order_cents, 174000);
  assert.equal(result.paid_cents, 188000);
  assert.equal(result.delta_cents, 28000);
  assert.equal(result.status, 'explained');
  const finding = findingFor(result, 'source_revision');
  assert.ok(finding);
  assert.equal(finding.category, 'explainable');
  const payload = JSON.parse(finding.evidence_json);
  const roles = payload.evidence.map((e) => e.role);
  assert.ok(roles.includes('current_revision'));
  assert.ok(roles.includes('superseded_revision'));
  assert.ok(roles.includes('payment'));
});

test('partial payment with an in-flight row is pending data with an exact amount', () => {
  const db = fresh();
  const { runId } = runReconciliation(db, { actor: 'test' });
  const result = byOrder(db, runId, 'SO-20261103-0003');
  assert.equal(result.expected_cents, 94900);
  assert.equal(result.paid_cents, 40000);
  assert.equal(result.status, 'pending');
  const finding = findingFor(result, 'partial_payment');
  assert.equal(finding.amount_cents, 54900);
  assert.equal(finding.suggested_action ?? JSON.parse(finding.evidence_json).suggested_action, 'defer_cutoff');
  const payload = JSON.parse(finding.evidence_json);
  assert.ok(payload.evidence.some((e) => e.role === 'payment_in_flight'));
});

test('refund on a later business day explains the order without a conflict', () => {
  const db = fresh();
  const { runId } = runReconciliation(db, { actor: 'test' });
  const result = byOrder(db, runId, 'SO-20261102-0004');
  assert.equal(result.status, 'pending'); // also has an in-flight payment
  const cross = findingFor(result, 'cross_day_refund');
  assert.equal(cross.category, 'explainable');
  const payload = JSON.parse(cross.evidence_json);
  const dates = payload.evidence.filter((e) => e.role === 'refund' || e.role === 'payment')
    .map((e) => e.business_date);
  assert.deepEqual([...new Set(dates)].sort(), ['2026-11-02', '2026-11-03']);
});

test('a missing payment feed is pending data, not a conflict', () => {
  const db = fresh();
  const { runId } = runReconciliation(db, { actor: 'test' });
  const result = byOrder(db, runId, 'SO-20261105-0001');
  assert.equal(result.status, 'pending');
  assert.equal(findingFor(result, 'payment_feed_missing').category, 'pending_data');
});

test('an order with no payment on a delivered day is a conflict', () => {
  const db = fresh();
  const { runId } = runReconciliation(db, { actor: 'test' });
  const result = byOrder(db, runId, 'SO-20261102-0006');
  assert.equal(result.status, 'conflict');
  assert.equal(findingFor(result, 'order_without_payment').category, 'conflict');
});

test('refund larger than captured payment is a conflict of the exact excess', () => {
  const db = fresh();
  const { runId } = runReconciliation(db, { actor: 'test' });
  const result = byOrder(db, runId, 'SO-20261104-0002');
  const finding = findingFor(result, 'refund_exceeds_capture');
  assert.equal(finding.category, 'conflict');
  assert.equal(finding.amount_cents, 10000);
});

test('a key typo is explainable on the true order and reported once', () => {
  const db = fresh();
  const { runId } = runReconciliation(db, { actor: 'test' });
  const result = byOrder(db, runId, 'SO-20261103-0006');
  assert.equal(result.status, 'explained');
  assert.equal(result.paid_cents, 0, 'raw payment source still shows zero captured for this order');
  const typo = findingFor(result, 'payment_key_typo');
  assert.ok(typo);
  assert.equal(typo.amount_cents, 12900);
  const payload = JSON.parse(typo.evidence_json);
  assert.equal(payload.remap[0].source, 'payments');
  assert.equal(payload.remap[0].row_id, 'PAY-PAY-20261103-0007');
  assert.equal(payload.remap[0].to, 'SO-20261103-0006');
  const phantom = byOrder(db, runId, 'SO-20261103-0906');
  assert.equal(phantom, undefined, 'the typo order number is not reported as its own conflict');
});

test('approving a remap changes only the payment source', () => {
  const db = fresh();
  const { runId } = runReconciliation(db, { actor: 'test' });
  const result = byOrder(db, runId, 'SO-20261103-0006');
  const typo = findingFor(result, 'payment_key_typo');
  const payload = JSON.parse(typo.evidence_json);

  const adjustment = proposeAdjustment(db, {
    finding_id: typo.id,
    action: 'remap_key',
    reason: '支付流水订单号日期段录错，金额一致。',
    remap: payload.remap,
    evidence: payload.evidence,
  }, '张敏');
  assert.equal(adjustment.status, 'proposed');
  assert.equal(adjustment.source, 'payments');

  const { scope } = approveAdjustment(db, adjustment.id, { note: '同意' }, '李强');
  assert.equal(scope.type, 'order');
  assert.equal(scope.orderNo, 'SO-20261103-0006');

  // payment source now resolves to the real order
  const payments = db.prepare(
    "SELECT f.order_no, f.source_row_id, f.raw FROM payment_fact f WHERE f.payment_no = 'PAY-20261103-0007'"
  ).all();
  assert.equal(payments.length, 1);
  assert.equal(payments[0].order_no, 'SO-20261103-0906', 'raw row untouched');
  assert.match(payments[0].raw, /SO-20261103-0906/);

  const override = db.prepare('SELECT * FROM override_register').all();
  assert.equal(override.length, 1);
  assert.equal(override[0].source, 'payments');
  assert.equal(override[0].field, 'order_no');

  // orders and refunds untouched
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM override_register WHERE source <> \'payments\'').get().n, 0);
  const refundRows = db.prepare('SELECT COUNT(*) AS n FROM refund_fact').get().n;
  assert.equal(refundRows, 5);

  const recompute = recomputeForScopes(db, { actor: '李强' });
  assert.equal(recompute.summary.recomputed, 1);
  assert.equal(recompute.summary.carried, 18);
  const after = byOrder(db, recompute.runId, 'SO-20261103-0006');
  assert.equal(after.paid_cents, 12900);
  assert.equal(after.status, 'explained');
  assert.equal(findingFor(after, 'payment_key_typo'), undefined);

  // other orders carried forward keep the same conclusion
  const before = byOrder(db, runId, 'SO-20261102-0006');
  const carried = byOrder(db, recompute.runId, 'SO-20261102-0006');
  assert.equal(carried.status, before.status);
  assert.equal(carried.delta_cents, before.delta_cents);
});

test('an adjustment cannot cite evidence the finding never recorded', () => {
  const db = fresh();
  const { runId } = runReconciliation(db, { actor: 'test' });
  const result = byOrder(db, runId, 'SO-20261104-0003');
  const finding = findingFor(result, 'source_revision');
  const payload = JSON.parse(finding.evidence_json);
  assert.throws(() => proposeAdjustment(db, {
    finding_id: finding.id,
    action: 'accept_diff',
    reason: '试图引用不存在的证据。',
    evidence: [{ source: 'refunds', row_id: 'RF-FAKE', batch_id: 99 }],
  }, '张敏'), (err) => err instanceof AdjustError && err.code === 'evidence_not_cited');
  // the real evidence is accepted
  const ok = proposeAdjustment(db, {
    finding_id: finding.id,
    action: 'accept_diff',
    reason: '订单金额修订已确认，差额由修订解释。',
    evidence: payload.evidence,
  }, '张敏');
  assert.equal(ok.status, 'proposed');
});

test('finding category restricts which actions are allowed', () => {
  const db = fresh();
  const { runId } = runReconciliation(db, { actor: 'test' });
  const conflict = findingFor(byOrder(db, runId, 'SO-20261102-0006'), 'order_without_payment');
  assert.throws(() => proposeAdjustment(db, {
    finding_id: conflict.id, action: 'defer_cutoff', reason: '不应挂起真实冲突。',
  }, '张敏'), (err) => err instanceof AdjustError && err.code === 'action_not_allowed');

  const pending = findingFor(byOrder(db, runId, 'SO-20261105-0001'), 'payment_feed_missing');
  assert.throws(() => proposeAdjustment(db, {
    finding_id: pending.id, action: 'write_off', reason: '不应核销待补数据。', amount_cents: 100,
  }, '张敏'), (err) => err instanceof AdjustError && err.code === 'action_not_allowed');
});

test('self-approval is blocked unless explicitly overridden', () => {
  const db = fresh();
  const { runId } = runReconciliation(db, { actor: 'test' });
  const finding = findingFor(byOrder(db, runId, 'SO-20261104-0003'), 'source_revision');
  const payload = JSON.parse(finding.evidence_json);
  const adjustment = proposeAdjustment(db, {
    finding_id: finding.id, action: 'accept_diff', reason: '修订差额已确认。', evidence: payload.evidence,
  }, '张敏');
  assert.throws(() => approveAdjustment(db, adjustment.id, {}, '张敏'),
    (err) => err instanceof AdjustError && err.code === 'self_approval');
  const approved = approveAdjustment(db, adjustment.id, { allow_self_approval: true }, '张敏');
  assert.equal(approved.adjustment.status, 'approved');
});

test('rejecting an adjustment reopens the finding', () => {
  const db = fresh();
  const { runId } = runReconciliation(db, { actor: 'test' });
  const finding = findingFor(byOrder(db, runId, 'SO-20261104-0003'), 'source_revision');
  const payload = JSON.parse(finding.evidence_json);
  const adjustment = proposeAdjustment(db, {
    finding_id: finding.id, action: 'accept_diff', reason: '修订差额已确认。', evidence: payload.evidence,
  }, '张敏');
  assert.equal(db.prepare('SELECT status FROM recon_finding WHERE id = ?').get(finding.id).status, 'adjusted');
  rejectAdjustment(db, adjustment.id, { note: '证据不足' }, '李强');
  assert.equal(db.prepare('SELECT status FROM recon_finding WHERE id = ?').get(finding.id).status, 'open');
  assert.equal(getAdjustment(db, adjustment.id).status, 'rejected');
});

test('write-off reduces the residual without touching evidence', () => {
  const db = fresh();
  const { runId } = runReconciliation(db, { actor: 'test' });
  const result = byOrder(db, runId, 'SO-20261102-0006');
  const finding = findingFor(result, 'order_without_payment');
  const payload = JSON.parse(finding.evidence_json);
  const adjustment = proposeAdjustment(db, {
    finding_id: finding.id, action: 'write_off',
    reason: '确认该订单为线下收款，支付流水未进系统，核销差额。',
    amount_cents: result.delta_cents === 0 ? finding.amount_cents : Math.abs(result.delta_cents),
    evidence: payload.evidence,
  }, '张敏');
  approveAdjustment(db, adjustment.id, {}, '李强');
  const recompute = recomputeForScopes(db, { actor: '李强' });
  const after = byOrder(db, recompute.runId, 'SO-20261102-0006');
  assert.equal(after.status, 'explained');
  assert.equal(after.adjustment_cents, finding.amount_cents, 'the write-off offsets the negative delta');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_fact WHERE order_no = ?').get('SO-20261102-0006').n, 1,
    'source rows untouched');
});

test('a scope recompute carries unrelated orders forward unchanged', () => {
  const db = fresh();
  const first = runReconciliation(db, { actor: 'test' });
  const second = runReconciliation(db, {
    actor: 'test', scope: { type: 'source_date', sourceDate: '2026-11-05' },
  });
  assert.equal(second.summary.recomputed, 2);
  assert.equal(second.summary.carried, 17);
  for (const orderNo of ['SO-20261102-0001', 'SO-20261104-0002']) {
    const before = byOrder(db, first.runId, orderNo);
    const after = byOrder(db, second.runId, orderNo);
    assert.equal(after.status, before.status);
    assert.equal(after.delta_cents, before.delta_cents);
    assert.equal(after.findings.length, before.findings.length);
  }
});

test('a scoped run that follows a full run keeps the snapshot whole', () => {
  const db = fresh();
  const first = runReconciliation(db, { actor: 'test' });
  const scoped = runReconciliation(db, { actor: 'test', scope: { type: 'order', orderNo: 'SO-20261103-0006' } });
  const total = resultsFor(db, scoped.runId).length;
  assert.equal(total, resultsFor(db, first.runId).length);
  const summary = recountSummary(db, scoped.runId);
  assert.equal(summary.recomputed, 1);
  assert.equal(summary.carried, 18);
});

test('ingesting a batch for a missing day resolves the pending findings', () => {
  const db = fresh();
  const before = runReconciliation(db, { actor: 'test' });
  assert.equal(byOrder(db, before.runId, 'SO-20261105-0001').status, 'pending');

  loadBatch(db, {
    source: 'payments',
    source_ref: 'psp-payments-20261105-v1',
    business_date: '2026-11-05',
    revision: 1,
    rows: [
      { payment_no: 'PAY-20261105-0001', order_no: 'SO-20261105-0001', paid_at: '2026-11-05T09:30:00+08:00', business_date: '2026-11-05', amount: '1660.00', status: 'captured' },
      { payment_no: 'PAY-20261105-0002', order_no: 'SO-20261105-0002', paid_at: '2026-11-05T11:00:00+08:00', business_date: '2026-11-05', amount: '240.00', status: 'captured' },
    ],
  }, 'test');

  const after = runReconciliation(db, {
    actor: 'test', scope: { type: 'source_date', sourceDate: '2026-11-05' },
  });
  const result = byOrder(db, after.runId, 'SO-20261105-0001');
  assert.equal(result.status, 'matched');
  assert.equal(result.paid_cents, 166000);
});

test('invalid source rows reject the whole batch', () => {
  const db = fresh();
  const countBefore = db.prepare('SELECT COUNT(*) AS n FROM payment_fact').get().n;
  assert.throws(() => loadBatch(db, {
    source: 'payments', source_ref: 'bad-batch', business_date: '2026-11-06',
    rows: [
      { payment_no: 'P1', order_no: 'SO-1', paid_at: '2026-11-06T10:00:00+08:00', business_date: '2026-11-06', amount: '10.00' },
      { payment_no: 'P2', order_no: 'SO-2', paid_at: '2026-11-06T10:00:00+08:00', business_date: '2026-11-06', amount: 'ten' },
    ],
  }, 'test'), (err) => err instanceof IngestError && err.status === 422 && err.errors.length === 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_fact').get().n, countBefore);
});

test('similarKey refuses to pick between equally close candidates', () => {
  assert.equal(similarKey('SO-20261103-0906', ['SO-20261103-0006']), 'SO-20261103-0006');
  assert.equal(similarKey('SO-20261103-0906', ['SO-20261103-0006', 'SO-20261103-0907']), null);
});

test('summary amounts equal the open finding amounts', () => {
  const db = fresh();
  const { runId } = runReconciliation(db, { actor: 'test' });
  const summary = recountSummary(db, runId);
  const rows = db.prepare(
    "SELECT category, SUM(amount_cents) AS amt FROM recon_finding WHERE run_id = ? AND status = 'open' GROUP BY category"
  ).all(runId);
  const map = Object.fromEntries(rows.map((r) => [r.category, r.amt]));
  assert.equal(summary.amounts.pending, map.pending_data);
  assert.equal(summary.amounts.conflict, map.conflict);
});

test('pending scopes merge and are consumed by recompute', () => {
  const db = fresh();
  const run = runReconciliation(db, { actor: 'test' });
  const a = findingFor(byOrder(db, run.runId, 'SO-20261104-0003'), 'source_revision');
  const b = findingFor(byOrder(db, run.runId, 'SO-20261103-0004'), 'refund_key_gap');
  const payloadA = JSON.parse(a.evidence_json);
  const payloadB = JSON.parse(b.evidence_json);
  const adjA = proposeAdjustment(db, {
    finding_id: a.id, action: 'accept_diff', reason: '修订差额确认。', evidence: payloadA.evidence,
  }, '张敏');
  approveAdjustment(db, adjA.id, {}, '李强');
  const adjB = proposeAdjustment(db, {
    finding_id: b.id, action: 'remap_key', reason: '退款补支付流水号。',
    remap: payloadB.remap, evidence: payloadB.evidence,
  }, '张敏');
  approveAdjustment(db, adjB.id, {}, '李强');

  const pending = pendingScope(db);
  assert.equal(pending.length, 2);
  const recompute = recomputeForScopes(db, { actor: '李强' });
  assert.deepEqual(recompute.preview.orders.sort(), ['SO-20261103-0004', 'SO-20261104-0003']);
  assert.equal(recompute.summary.recomputed, 2);
  assert.equal(pendingScope(db).length, 0, 'scopes are consumed');
});

test('listAdjustments filters by status', () => {
  const db = fresh();
  const run = runReconciliation(db, { actor: 'test' });
  const finding = findingFor(byOrder(db, run.runId, 'SO-20261104-0003'), 'source_revision');
  const payload = JSON.parse(finding.evidence_json);
  const adj = proposeAdjustment(db, {
    finding_id: finding.id, action: 'accept_diff', reason: '修订差额确认。', evidence: payload.evidence,
  }, '张敏');
  assert.equal(listAdjustments(db, { status: 'proposed' }).length, 1);
  approveAdjustment(db, adj.id, {}, '李强');
  assert.equal(listAdjustments(db, { status: 'proposed' }).length, 0);
  assert.equal(listAdjustments(db, { status: 'approved' }).length, 1);
});

test('rebuilding the context sees the override without mutating facts', () => {
  const db = fresh();
  const before = buildContext(db);
  const finding = findingFor(byOrder(db, runReconciliation(db, {}).runId, 'SO-20261103-0006'), 'payment_key_typo');
  const payload = JSON.parse(finding.evidence_json);
  const adj = proposeAdjustment(db, {
    finding_id: finding.id, action: 'remap_key', reason: '补录正确的订单号。', remap: payload.remap, evidence: payload.evidence,
  }, '张敏');
  approveAdjustment(db, adj.id, {}, '李强');
  const after = buildContext(db);
  assert.equal(after.facts.payments.find((p) => p.payment_no === 'PAY-20261103-0007').order_no, 'SO-20261103-0006');
  assert.equal(before.facts.payments.find((p) => p.payment_no === 'PAY-20261103-0007').order_no, 'SO-20261103-0906');
  assert.equal(db.prepare("SELECT order_no FROM payment_fact WHERE payment_no='PAY-20261103-0007'").get().order_no, 'SO-20261103-0906');
});

test('recompute with no pending scope is refused', () => {
  const db = fresh();
  runReconciliation(db, { actor: 'test' });
  assert.throws(() => recomputeForScopes(db, {}), (err) => err instanceof AdjustError && err.code === 'no_pending_scope');
});

test('superseded exports never count toward reconciliation', () => {
  const db = fresh();
  const active = db.prepare(
    "SELECT id FROM source_batch WHERE source_ref = 'erp-orders-20261104-v2'"
  ).get();
  setBatchStatus(db, active.id, 'superseded', 'test');

  const ctx = buildContext(db);
  assert.equal(
    ctx.facts.orders.filter((o) => o.order_no === 'SO-20261104-0003').length, 0,
    'neither revision is effective once both are superseded'
  );

  const { runId } = runReconciliation(db, { actor: 'test' });
  const result = byOrder(db, runId, 'SO-20261104-0003');
  assert.equal(result.expected_cents, 0, 'no order fact is counted');
  assert.equal(result.paid_cents, 188000, 'the payment is still counted');
  assert.equal(result.status, 'pending', 'a missing order feed is pending data, not a conflict');
  assert.equal(findingFor(result, 'source_revision'), undefined, 'the revision explanation is gone');
  assert.equal(findingFor(result, 'order_feed_missing').category, 'pending_data');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM order_fact WHERE order_no = ?').get('SO-20261104-0003').n, 2,
    'the raw rows of both revisions stay on disk'
  );
});
