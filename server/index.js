import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { openDb, nowIso, audit } from './db.js';
import { loadBatch, setBatchStatus, IngestError, SOURCES } from './ingest.js';
import {
  runReconciliation, resultsFor, latestRun, recountSummary, buildContext,
  safeJson, evidence, ACTION_RULES,
} from './reconcile.js';
import {
  proposeAdjustment, approveAdjustment, rejectAdjustment, listAdjustments,
  getAdjustment, pendingScope, recomputeForScopes, AdjustError, ACTIONS, allowedActions,
} from './adjustments.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const publicDir = join(root, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const db = openDb();

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function actor(req) {
  const header = req.headers['x-actor'];
  if (!header) return null;
  let value = String(header);
  try { value = decodeURIComponent(value); } catch { /* keep raw */ }
  return value.trim().slice(0, 64) || null;
}

async function readJson(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

const SEVERITY_ORDER = { high: 3, medium: 2, low: 1 };

function runPayload(run, { includeResults = true } = {}) {
  const stored = safeJson(run.summary_json, {});
  const summary = recountSummary(db, run.id, stored);
  const out = {
    id: run.id,
    run_at: run.run_at,
    scope: safeJson(run.scope_json, { type: 'full' }),
    recomputed_from: run.recomputed_from,
    engine_version: run.engine_version,
    status: run.status,
    summary,
  };
  if (includeResults) out.results = decorateResults(run.id);
  return out;
}

function allowedFor(finding) {
  const payload = safeJson(finding.evidence_json, {});
  const remap = Array.isArray(payload.remap) ? payload.remap : [];
  return allowedActions(finding).filter((action) => action !== 'remap_key' || remap.length > 0);
}

function decorateResults(runId) {
  const results = resultsFor(db, runId);
  return results.map((r) => ({
    ...r,
    findings: r.findings
      .map((f) => ({
        ...f,
        evidence: f.evidence || [],
        allowed_actions: allowedFor(f),
      }))
      .sort((a, b) => (SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]) || a.id - b.id),
  }));
}

function batchesPayload() {
  const batches = db.prepare(
    `SELECT b.*, s.source_ref AS supersedes_ref,
            (SELECT COUNT(*) FROM recon_run r WHERE r.batch_id = b.id) AS run_count
       FROM source_batch b LEFT JOIN source_batch s ON s.id = b.supersedes_batch_id
      ORDER BY b.business_date DESC, b.source, b.revision DESC`
  ).all();
  const coverage = {};
  for (const source of SOURCES) {
    const rows = db.prepare(
      `SELECT business_date, status, COUNT(*) AS n FROM source_batch
        WHERE source = ? GROUP BY business_date, status ORDER BY business_date`
    ).all(source);
    const byDate = new Map();
    for (const row of rows) {
      if (!byDate.has(row.business_date)) byDate.set(row.business_date, { date: row.business_date, effective: 0, superseded: 0 });
      const entry = byDate.get(row.business_date);
      if (row.status === 'superseded') entry.superseded += row.n;
      else entry.effective += row.n;
    }
    coverage[source] = [...byDate.values()];
  }
  return { batches, coverage };
}

function orderTrace(orderNo) {
  const ctx = buildContext(db);
  const gather = (table, keyCol) => db.prepare(
    `SELECT f.*, b.source_ref, b.revision AS batch_revision, b.status AS batch_status, b.business_date AS batch_date
       FROM ${table} f JOIN source_batch b ON b.id = f.batch_id
      WHERE f.${keyCol} = ? ORDER BY b.business_date, b.revision, f.id`
  ).all(orderNo);
  const rawOrders = gather('order_fact', 'order_no');
  const rawPayments = gather('payment_fact', 'order_no');
  const rawRefunds = gather('refund_fact', 'order_no');
  const overrides = db.prepare('SELECT * FROM override_register WHERE order_no = ? ORDER BY id').all(orderNo);
  const adjustments = db.prepare(
    `SELECT a.*, f.title AS finding_title, f.category, f.subtype FROM adjustment a
       JOIN recon_finding f ON f.id = a.finding_id
      WHERE a.order_no = ? ORDER BY a.id`
  ).all(orderNo).map((a) => ({ ...a, ...safeJson(a.evidence_json, {}) }));
  const effective = {
    orders: ctx.facts.orders.filter((r) => r.order_no === orderNo),
    payments: ctx.facts.payments.filter((r) => r.order_no === orderNo),
    refunds: ctx.facts.refunds.filter((r) => r.order_no === orderNo),
  };
  const group = ctx.byOrder.get(orderNo);
  const duplicates = group ? {
    orders: group.duplicateOrders.map((r) => evidence(r, { role: 'duplicate' })),
    payments: group.duplicatePayments.map((r) => evidence(r, { role: 'duplicate' })),
    refunds: group.duplicateRefunds.map((r) => evidence(r, { role: 'duplicate' })),
  } : { orders: [], payments: [], refunds: [] };
  const run = latestRun(db);
  const result = run ? db.prepare('SELECT * FROM recon_result WHERE run_id = ? AND order_no = ?').get(run.id, orderNo) : null;
  const findings = result ? db.prepare('SELECT * FROM recon_finding WHERE result_id = ? ORDER BY id').all(result.id) : [];
  return {
    order_no: orderNo,
    raw: { orders: rawOrders, payments: rawPayments, refunds: rawRefunds },
    effective: {
      orders: effective.orders.map((r) => ({ ...r, raw: undefined })),
      payments: effective.payments.map((r) => ({ ...r, raw: undefined })),
      refunds: effective.refunds.map((r) => ({ ...r, raw: undefined })),
    },
    duplicates,
    overrides,
    adjustments,
    result: result ? {
      ...result,
      evidence: safeJson(result.evidence_json),
      findings: findings.map((f) => ({ ...f, ...safeJson(f.evidence_json) })),
    } : null,
    remap_targets: [...(ctx.remapTargets.get(orderNo) || [])].map((entry) => ({
      from: entry.from, payments: entry.group.payments.map((p) => evidence(p, { role: 'payment' })),
    })),
  };
}

function actionCatalogue() {
  return Object.entries(ACTIONS).map(([key, value]) => ({ action: key, ...value }));
}

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, regex, keys, handler });
}

/* ---------------------------------------------------------------- read api */

route('GET', '/api/overview', async (req, res) => {
  const run = latestRun(db);
  const pending = pendingScope(db);
  const batches = batchesPayload();
  const openAdjustments = db.prepare("SELECT COUNT(*) AS n FROM adjustment WHERE status = 'proposed'").get().n;
  const runCount = db.prepare('SELECT COUNT(*) AS n FROM recon_run').get().n;
  const daily = run ? db.prepare(
    `SELECT substr(COALESCE(b.business_date, '') ,1,10) AS date, r.status, COUNT(*) AS n
       FROM recon_result r
       LEFT JOIN source_batch b ON b.id = r.order_batch_id
      WHERE r.run_id = ? GROUP BY date, r.status ORDER BY date`
  ).all(run.id) : [];
  json(res, 200, {
    run: run ? runPayload(run, { includeResults: false }) : null,
    run_count: runCount,
    pending_scope: pending.length,
    pending_adjustments: openAdjustments,
    batches: batches.batches,
    coverage: batches.coverage,
    categories: Object.fromEntries(
      ['explainable', 'pending_data', 'conflict'].map((c) => [c, run ? db.prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS amount FROM recon_finding WHERE run_id = ? AND category = ? AND status = 'open'"
      ).get(run.id, c) : { n: 0, amount: 0 }])
    ),
    daily,
    actions: actionCatalogue(),
  });
});

route('GET', '/api/batches', async (req, res) => {
  json(res, 200, batchesPayload());
});

route('POST', '/api/batches', async (req, res) => {
  const body = await readJson(req);
  const who = actor(req) || body.actor || 'operator';
  const result = loadBatch(db, body, who);
  json(res, result.idempotent ? 200 : 201, result);
});

route('POST', '/api/batches/:id/status', async (req, res) => {
  const body = await readJson(req);
  const batch = setBatchStatus(db, Number(req.params.id), body.status, actor(req) || body.actor || 'operator');
  json(res, 200, batch);
});

route('GET', '/api/runs', async (req, res) => {
  const runs = db.prepare('SELECT * FROM recon_run ORDER BY id DESC LIMIT 50').all();
  json(res, 200, { runs: runs.map((r) => runPayload(r, { includeResults: false })) });
});

route('GET', '/api/runs/:id', async (req, res) => {
  const run = db.prepare('SELECT * FROM recon_run WHERE id = ?').get(Number(req.params.id));
  if (!run) return json(res, 404, { error: '对账批次不存在' });
  json(res, 200, runPayload(run));
});

route('POST', '/api/runs', async (req, res) => {
  const body = await readJson(req);
  const who = actor(req) || body.actor || 'operator';
  const result = runReconciliation(db, { scope: body.scope || null, actor: who, note: body.note || null });
  json(res, 201, { ...result, run: runPayload(db.prepare('SELECT * FROM recon_run WHERE id = ?').get(result.runId)) });
});

route('GET', '/api/findings', async (req, res) => {
  const run = latestRun(db);
  if (!run) return json(res, 200, { findings: [], run: null });
  const { category, status, q } = req.query;
  const clauses = ['run_id = ?'];
  const params = [run.id];
  if (category) { clauses.push('category = ?'); params.push(category); }
  if (status === 'active') clauses.push("status IN ('open','adjusted')");
  else if (status) { clauses.push('status = ?'); params.push(status); }
  if (q) { clauses.push('(order_no LIKE ? OR title LIKE ? OR finding_key LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const findings = db.prepare(
    `SELECT f.*, (SELECT COUNT(*) FROM adjustment a WHERE a.finding_id = f.id) AS adjustment_count
       FROM recon_finding f WHERE ${clauses.join(' AND ')} ORDER BY f.id`
  ).all(...params).map((f) => ({
    ...f,
    ...safeJson(f.evidence_json, {}),
    allowed_actions: allowedFor(f),
    adjustments: db.prepare(
      'SELECT id, action, status, proposed_by, approved_by, amount_cents, reason FROM adjustment WHERE finding_id = ? ORDER BY id'
    ).all(f.id),
  }));
  json(res, 200, {
    run: runPayload(run, { includeResults: false }),
    findings,
    counts: db.prepare(
      'SELECT category, status, COUNT(*) AS n FROM recon_finding WHERE run_id = ? GROUP BY category, status'
    ).all(run.id),
  });
});

route('GET', '/api/findings/:id', async (req, res) => {
  const finding = db.prepare(
    `SELECT f.*, r.order_no AS result_order_no, r.status AS order_status
       FROM recon_finding f LEFT JOIN recon_result r ON r.id = f.result_id WHERE f.id = ?`
  ).get(Number(req.params.id));
  if (!finding) return json(res, 404, { error: '发现项不存在' });
  const payload = safeJson(finding.evidence_json, {});
  json(res, 200, {
    ...finding,
    ...payload,
    allowed_actions: allowedFor(finding),
    adjustments: db.prepare('SELECT * FROM adjustment WHERE finding_id = ? ORDER BY id').all(finding.id),
  });
});

route('GET', '/api/orders/:orderNo', async (req, res) => {
  json(res, 200, orderTrace(req.params.orderNo));
});

route('GET', '/api/adjustments', async (req, res) => {
  json(res, 200, {
    adjustments: listAdjustments(db, {
      status: req.query.status || null,
      findingId: req.query.finding_id ? Number(req.query.finding_id) : null,
    }),
    actions: actionCatalogue(),
  });
});

route('POST', '/api/findings/:id/adjustments', async (req, res) => {
  const body = await readJson(req);
  const who = actor(req) || body.actor;
  const adjustment = proposeAdjustment(db, { ...body, finding_id: Number(req.params.id) }, who);
  json(res, 201, adjustment);
});

route('POST', '/api/adjustments/:id/approve', async (req, res) => {
  const body = await readJson(req);
  const who = actor(req) || body.actor;
  json(res, 200, approveAdjustment(db, Number(req.params.id), body, who));
});

route('POST', '/api/adjustments/:id/reject', async (req, res) => {
  const body = await readJson(req);
  const who = actor(req) || body.actor;
  json(res, 200, rejectAdjustment(db, Number(req.params.id), body, who));
});

route('GET', '/api/adjustments/:id', async (req, res) => {
  json(res, 200, getAdjustment(db, Number(req.params.id)));
});

route('GET', '/api/recompute', async (req, res) => {
  const pending = pendingScope(db);
  const { recomputeScopePreview } = await import('./reconcile.js');
  const preview = recomputeScopePreview(db);
  json(res, 200, { pending, preview });
});

route('POST', '/api/recompute', async (req, res) => {
  const body = await readJson(req);
  const who = actor(req) || body.actor || 'operator';
  const result = recomputeForScopes(db, { actor: who, note: body.note || null });
  json(res, 201, { ...result, run: runPayload(db.prepare('SELECT * FROM recon_run WHERE id = ?').get(result.runId)) });
});

route('GET', '/api/audit', async (req, res) => {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all();
  json(res, 200, { entries: rows.map((r) => ({ ...r, detail: safeJson(r.detail_json, {}) })) });
});

route('GET', '/api/meta', async (req, res) => {
  const ctx = buildContext(db);
  json(res, 200, {
    actions: actionCatalogue(),
    action_rules: ACTION_RULES,
    sources: SOURCES,
    order_count: ctx.byOrder.size,
    now: nowIso(),
  });
});

/* ----------------------------------------------------------------- server */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    const match = routes.find((r) => r.method === req.method && r.regex.test(pathname));
    if (!match) {
      const anyPath = routes.some((r) => r.regex.test(pathname));
      return json(res, anyPath ? 405 : 404, { error: anyPath ? '方法不允许' : '接口不存在' });
    }
    const values = match.regex.exec(pathname).slice(1);
    req.params = Object.fromEntries(match.keys.map((k, i) => [k, values[i]]));
    req.query = Object.fromEntries(url.searchParams);
    try {
      await match.handler(req, res);
    } catch (err) {
      if (err instanceof IngestError || err instanceof AdjustError) {
        return json(res, err.status || 400, {
          error: err.message, code: err.code || 'invalid', details: err.errors || undefined,
        });
      }
      const status = err.status && Number.isInteger(err.status) ? err.status : 500;
      if (status >= 500) console.error(err);
      return json(res, status, { error: status >= 500 ? '服务器内部错误' : err.message });
    }
    return;
  }

  // static
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = resolve(publicDir, `.${normalize(rel)}`);
  if (!filePath.startsWith(publicDir)) return json(res, 403, { error: 'forbidden' });
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    if (extname(pathname)) return json(res, 404, { error: 'not found' });
    const body = await readFile(join(publicDir, 'index.html'));
    res.writeHead(200, { 'content-type': MIME['.html'], 'content-length': body.length });
    res.end(body);
  }
});

const port = Number(process.env.PORT || 7788);
server.listen(port, () => {
  console.log(`销售对账工作台已启动: http://localhost:${port}`);
  const hasData = db.prepare('SELECT COUNT(*) AS n FROM source_batch').get().n;
  if (!hasData) console.log('数据库为空，可运行 `npm run seed` 载入演示数据。');
});
