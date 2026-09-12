/**
 * 回滚方案验证脚本（Step 9 验收：数据库迁移可回滚）。
 *
 * 流程：全新库 → migrate(0001+0002) → 校验 Phase 2 表存在 → rollback(0002) →
 *       校验 Phase 2 表消失、Phase 1 表完好 → 再次 migrate → 校验恢复。
 *
 * 运行：pnpm --filter @ai/server verify:rollback
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'ai-rollback-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.STORAGE_DIR = path.join(tmp, 'data', 'storage');
process.env.DB_FILE = path.join(tmp, 'data', 'rollback.db');

const { getSqlite, closeDb } = await import('../src/db/client.ts');
const { runMigrations, rollback } = await import('../src/db/migrate.ts');

const sqlite = getSqlite();
const tableExists = (name: string): boolean =>
  (getSqlite().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").all(name) as unknown[]).length > 0;
const columnExists = (table: string, column: string): boolean =>
  (getSqlite().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);

const PHASE2_TABLES = ['goal_runs', 'goal_audits', 'cluster_configs', 'office_documents', 'file_exports', 'research_jobs', 'research_sources', 'research_claims', 'research_reports'];
const PHASE3_TABLES = [
  'website_projects',
  'website_builds',
  'website_deployments',
  'website_access_rules',
  'database_schemas',
  'database_migrations',
  'dashboards',
  'widget_data_sources',
  'notify_channels',
  'notify_logs',
  'deploy_audits',
  'db_audits',
  'schedule_audits',
];
const PHASE1_TABLES = ['users', 'workspaces', 'conversations', 'messages', 'goals', 'tasks', 'agents', 'files', 'plugins', 'schedule_runs', 'audit_logs'];

const fail = (msg: string): never => {
  console.error(`❌ ${msg}`);
  closeDb();
  process.exit(1);
};

// 1) 向上迁移
const applied = runMigrations();
console.log(`[1] 应用迁移：${applied.join(', ') || '(已是最新)'}`);
for (const t of [...PHASE2_TABLES, ...PHASE1_TABLES]) {
  if (!tableExists(t)) fail(`迁移后缺少表 ${t}`);
}
if (!columnExists('memory_facts', 'fact_type')) fail('0002 的新列 fact_type 未生效');
console.log(`[1] ✅ Phase 1 (${PHASE1_TABLES.length}) + Phase 2 (${PHASE2_TABLES.length}) 表齐全，Phase 2 列已生效`);

// 2) 回滚 0002
const rolledBack = rollback('0002_phase2.sql');
if (rolledBack !== '0002_phase2.sql') fail(`回滚未执行：${String(rolledBack)}`);
for (const t of PHASE2_TABLES) {
  if (tableExists(t)) fail(`回滚后 Phase 2 表仍存在：${t}`);
}
for (const t of PHASE1_TABLES) {
  if (!tableExists(t)) fail(`回滚误删了 Phase 1 表：${t}`);
}
console.log('[2] ✅ 回滚后 Phase 2 表已移除，Phase 1 表完好');

// 3) 再次迁移（幂等恢复）
runMigrations();
for (const t of PHASE2_TABLES) {
  if (!tableExists(t)) fail(`重新迁移后缺少表 ${t}`);
}
console.log('[3] ✅ 重新迁移后 Phase 2 表恢复');

// 4) 回滚保护：对不存在的迁移回滚应返回 null 而不是破坏数据
const unknown = rollback('9999_not_exist.sql');
if (unknown !== null) fail('对不存在的迁移回滚应返回 null');
// 已回滚过的迁移再次回滚应返回 null（不会重复执行 DROP）
const secondTime = rollback('0002_phase2.sql');
if (secondTime !== '0002_phase2.sql') fail('第二次回滚 0002 应成功（表刚被恢复）');
const thirdTime = rollback('0002_phase2.sql');
if (thirdTime !== null) fail('已回滚的迁移再次回滚应返回 null');
if (tableExists('goal_runs')) fail('重复回滚不应影响结果（表应已删除）');
for (const t of PHASE1_TABLES) {
  if (!tableExists(t)) fail(`多次回滚后 Phase 1 表丢失：${t}`);
}
console.log('[4] ✅ 非法/重复回滚被安全处理，Phase 1 数据无损');

closeDb();
console.log('\n✅ 回滚方案验证通过：迁移可回滚、Phase 1 不受影响、可幂等恢复');

// 继续做 Phase 3 验证前必须重新拿到 sqlite 句柄（上面 closeDb 已关闭旧连接）


/* ================================================================== */
/* Phase 3 回滚验证（Step 9 验收：每个 Step 可独立回滚）                */
/* ================================================================== */

console.log('');
console.log('=== Phase 3 回滚验证 ===');

// 重新迁移到最新（含 0003）
const appliedAll = runMigrations();
console.log(`[P3-1] 应用迁移：${appliedAll.join(', ') || '(已是最新)'}`);
for (const t of PHASE3_TABLES) {
  if (!tableExists(t)) fail(`Phase 3 迁移后缺少表 ${t}`);
}
if (!columnExists('database_connections', 'encrypted_config')) fail('0003 的新列 encrypted_config 未生效');
if (!columnExists('schedules', 'timezone')) fail('0003 的新列 schedules.timezone 未生效');
if (!columnExists('schedule_runs', 'retry_count')) fail('0003 的新列 schedule_runs.retry_count 未生效');
if (!columnExists('widgets', 'pinned_to_desktop')) fail('widgets.pinned_to_desktop 未生效');
console.log(`[P3-1] ✅ Phase 3 (${PHASE3_TABLES.length}) 表齐全，新增列已生效`);

// 回滚 0003
const rolled3 = rollback('0003_phase3.sql');
if (rolled3 !== '0003_phase3.sql') fail(`Phase 3 回滚未执行：${String(rolled3)}`);
for (const t of PHASE3_TABLES) {
  if (tableExists(t)) fail(`Phase 3 回滚后表仍存在：${t}`);
}
for (const t of [...PHASE2_TABLES, ...PHASE1_TABLES]) {
  if (!tableExists(t)) fail(`Phase 3 回滚误伤 Phase 1/2 表：${t}`);
}
console.log('[P3-2] ✅ Phase 3 回滚成功；Phase 1/2 表完好（未跨阶段误伤）');

// 再次迁移：幂等恢复
const reapplied = runMigrations();
if (!reapplied.includes('0003_phase3.sql')) fail('Phase 3 迁移未能重新应用（幂等性失败）');
for (const t of PHASE3_TABLES) {
  if (!tableExists(t)) fail(`重新应用后缺失表 ${t}`);
}
console.log('[P3-3] ✅ Phase 3 迁移可幂等重新应用');

// 功能开关：Phase 3 能力可通过 features 关闭（不需要回滚数据库）
const { config } = await import('../src/config.ts');
if (typeof config.features.phase3Schedule !== 'boolean') fail('缺少 phase3Schedule 功能开关');
if (typeof config.features.phase3Deploy !== 'boolean') fail('缺少 phase3Deploy 功能开关');
console.log('[P3-4] ✅ 功能开关存在（phase3Deploy / phase3Schedule），可独立关闭而去数据不丢');

console.log('');
console.log('✅ Phase 1 + 2 + 3 迁移回滚与幂等恢复全部通过');
closeDb();
