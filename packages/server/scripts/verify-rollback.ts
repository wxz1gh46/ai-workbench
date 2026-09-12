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
  (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").all(name) as unknown[]).length > 0;
const columnExists = (table: string, column: string): boolean =>
  (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);

const PHASE2_TABLES = ['goal_runs', 'goal_audits', 'cluster_configs', 'office_documents', 'file_exports', 'research_jobs', 'research_sources', 'research_claims', 'research_reports'];
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
