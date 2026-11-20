import { openDb, tx } from './db.js';
import { seedPlan } from './seed.js';
import { loadPlan } from './ingest.js';
import { runReconciliation } from './reconcile.js';

const reset = process.argv.includes('--reset');
const db = openDb();

if (reset) {
  tx(db, () => {
    for (const table of [
      'override_register', 'recompute_scope', 'adjustment', 'recon_finding', 'recon_result',
      'recon_run', 'audit_log', 'order_fact', 'payment_fact', 'refund_fact', 'source_batch',
    ]) db.prepare(`DELETE FROM ${table}`).run();
    db.prepare("DELETE FROM sqlite_sequence").run();
  });
  console.log('已清空演示数据');
}

const existing = db.prepare('SELECT COUNT(*) AS n FROM source_batch').get().n;
if (existing > 0 && !reset) {
  console.log(`数据库中已有 ${existing} 个来源批次，未重复导入。使用 --reset 重新生成。`);
  process.exit(0);
}

const plan = seedPlan();
const loaded = loadPlan(db, plan);
console.log(`导入 ${loaded.length} 个来源批次，共 ${loaded.reduce((s, b) => s + b.rowCount, 0)} 行`);
for (const batch of loaded) {
  console.log(`  批次 #${batch.batchId}  ${batch.source.padEnd(8)} ${batch.businessDate}  ${batch.sourceRef}  ${batch.rowCount} 行${batch.duplicates ? `，重复 ${batch.duplicates} 行` : ''}`);
}
const run = runReconciliation(db, { actor: 'seed', note: '演示数据初始对账' });
console.log(`对账批次 #${run.runId}：` + Object.entries(run.summary).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  '));
