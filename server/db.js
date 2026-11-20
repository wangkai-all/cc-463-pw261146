import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.RECON_DATA_DIR || join(here, '..', 'data');

/**
 * One row per business day's ingest of one source. A batch is the unit a
 * reconciliation run operates on; every load, every finding and every journal
 * entry points back at the batch that produced it.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS source_batch (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  source              TEXT NOT NULL CHECK (source IN ('orders','payments','refunds')),
  source_ref          TEXT NOT NULL,
  business_date       TEXT NOT NULL,
  revision            INTEGER NOT NULL DEFAULT 1,
  supersedes_batch_id INTEGER REFERENCES source_batch(id),
  loaded_at           TEXT NOT NULL,
  row_count           INTEGER NOT NULL DEFAULT 0,
  checksum            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'loaded'
                      CHECK (status IN ('loaded','superseded','reconciled')),
  note                TEXT,
  UNIQUE (source, source_ref, business_date, revision)
);

CREATE TABLE IF NOT EXISTS order_fact (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id          INTEGER NOT NULL REFERENCES source_batch(id),
  source            TEXT NOT NULL DEFAULT 'orders',
  source_row_id     TEXT NOT NULL,
  order_no          TEXT NOT NULL,
  customer_id       TEXT,
  ordered_at        TEXT NOT NULL,
  business_date     TEXT NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'CNY',
  gross_cents       INTEGER NOT NULL,
  discount_cents    INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,
  is_duplicate      INTEGER NOT NULL DEFAULT 0,
  duplicate_of      TEXT,
  raw               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_fact_order ON order_fact(order_no, batch_id);
CREATE INDEX IF NOT EXISTS idx_order_fact_batch ON order_fact(batch_id);

CREATE TABLE IF NOT EXISTS payment_fact (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id          INTEGER NOT NULL REFERENCES source_batch(id),
  source            TEXT NOT NULL DEFAULT 'payments',
  source_row_id     TEXT NOT NULL,
  payment_no        TEXT NOT NULL,
  order_no          TEXT NOT NULL,
  paid_at           TEXT NOT NULL,
  business_date     TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL,
  channel           TEXT,
  status            TEXT NOT NULL,
  is_duplicate      INTEGER NOT NULL DEFAULT 0,
  duplicate_of      TEXT,
  raw               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_fact_order ON payment_fact(order_no, batch_id);
CREATE INDEX IF NOT EXISTS idx_payment_fact_batch ON payment_fact(batch_id);

CREATE TABLE IF NOT EXISTS refund_fact (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id          INTEGER NOT NULL REFERENCES source_batch(id),
  source            TEXT NOT NULL DEFAULT 'refunds',
  source_row_id     TEXT NOT NULL,
  refund_no         TEXT NOT NULL,
  payment_no        TEXT,
  order_no          TEXT NOT NULL,
  refunded_at       TEXT NOT NULL,
  business_date     TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL,
  reason            TEXT,
  status            TEXT NOT NULL,
  is_duplicate      INTEGER NOT NULL DEFAULT 0,
  duplicate_of      TEXT,
  raw               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refund_fact_order ON refund_fact(order_no, batch_id);
CREATE INDEX IF NOT EXISTS idx_refund_fact_payment ON refund_fact(payment_no, batch_id);
CREATE INDEX IF NOT EXISTS idx_refund_fact_batch ON refund_fact(batch_id);

CREATE TABLE IF NOT EXISTS recon_run (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id         INTEGER REFERENCES source_batch(id),
  run_at           TEXT NOT NULL,
  scope_json       TEXT NOT NULL,
  recomputed_from  INTEGER REFERENCES recon_run(id),
  engine_version   TEXT NOT NULL,
  summary_json     TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'completed'
);

CREATE TABLE IF NOT EXISTS recon_result (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          INTEGER NOT NULL REFERENCES recon_run(id),
  order_no        TEXT NOT NULL,
  order_batch_id  INTEGER REFERENCES source_batch(id),
  order_cents     INTEGER NOT NULL DEFAULT 0,
  paid_cents      INTEGER NOT NULL DEFAULT 0,
  refunded_cents  INTEGER NOT NULL DEFAULT 0,
  net_cents       INTEGER NOT NULL DEFAULT 0,
  expected_cents  INTEGER NOT NULL DEFAULT 0,
  delta_cents     INTEGER NOT NULL DEFAULT 0,
  adjustment_cents INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  evidence_json   TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_result_run ON recon_result(run_id, status);
CREATE INDEX IF NOT EXISTS idx_result_order ON recon_result(order_no);

CREATE TABLE IF NOT EXISTS recon_finding (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL REFERENCES recon_run(id),
  result_id     INTEGER REFERENCES recon_result(id),
  order_no      TEXT,
  finding_key   TEXT NOT NULL,
  category      TEXT NOT NULL
                CHECK (category IN ('explainable','pending_data','conflict')),
  subtype       TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'medium'
                CHECK (severity IN ('low','medium','high')),
  title         TEXT NOT NULL,
  detail        TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL DEFAULT 0,
  explainable   INTEGER NOT NULL DEFAULT 0,
  auto_fixable  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','adjusted','accepted','waived','resolved','superseded')),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (run_id, finding_key)
);
CREATE INDEX IF NOT EXISTS idx_finding_run ON recon_finding(run_id, category, status);

CREATE TABLE IF NOT EXISTS adjustment (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id          INTEGER NOT NULL REFERENCES recon_finding(id),
  run_id              INTEGER NOT NULL REFERENCES recon_run(id),
  action              TEXT NOT NULL
                      CHECK (action IN ('remap_key','write_off','defer_cutoff','accept_diff','manual_entry')),
  source              TEXT NOT NULL,
  order_no            TEXT,
  target_source       TEXT,
  target_row_id       TEXT,
  amount_cents        INTEGER NOT NULL DEFAULT 0,
  reason              TEXT NOT NULL,
  evidence_json       TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'proposed'
                      CHECK (status IN ('proposed','approved','rejected')),
  proposed_by         TEXT NOT NULL,
  proposed_at         TEXT NOT NULL,
  approved_by         TEXT,
  approved_at         TEXT,
  approval_note       TEXT,
  applied_run_id      INTEGER REFERENCES recon_run(id),
  applied_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_adjustment_finding ON adjustment(finding_id);
CREATE INDEX IF NOT EXISTS idx_adjustment_run ON adjustment(run_id, status);

CREATE TABLE IF NOT EXISTS recompute_scope (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              INTEGER NOT NULL REFERENCES recon_run(id),
  finding_id          INTEGER REFERENCES recon_finding(id),
  adjustment_id       INTEGER REFERENCES adjustment(id),
  scope_type          TEXT NOT NULL
                      CHECK (scope_type IN ('order','batch','source_date','full')),
  order_no            TEXT,
  batch_id            INTEGER,
  source_date         TEXT,
  reason              TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  consumed_at         TEXT,
  consumed_run_id     INTEGER REFERENCES recon_run(id)
);
CREATE INDEX IF NOT EXISTS idx_scope_run ON recompute_scope(run_id);
CREATE INDEX IF NOT EXISTS idx_scope_pending ON recompute_scope(consumed_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  entity       TEXT NOT NULL,
  entity_id    TEXT,
  detail_json  TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS override_register (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  order_no      TEXT,
  field         TEXT NOT NULL,
  value_json    TEXT NOT NULL,
  adjustment_id INTEGER REFERENCES adjustment(id),
  created_at    TEXT NOT NULL,
  UNIQUE (source, source_row_id, field)
);
`;

export function openDb(path = join(DATA_DIR, 'recon.db')) {
  if (path !== ':memory:') mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function audit(db, actor, action, entity, entityId, detail = {}) {
  db.prepare(
    'INSERT INTO audit_log (at, actor, action, entity, entity_id, detail_json) VALUES (?,?,?,?,?,?)'
  ).run(nowIso(), actor, action, entity, entityId == null ? null : String(entityId), JSON.stringify(detail));
}
