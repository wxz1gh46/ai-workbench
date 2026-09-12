/**
 * Step 9：迁移与回滚方案测试。
 *
 * 验收要求「数据库迁移可回滚、每个 Step 可独立回滚」。这里把回滚方案验证脚本的
 * 关键断言固化进测试，避免回归时被无声破坏。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tmp = mkdtempSync(path.join(tmpdir(), 'ai-mig-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.STORAGE_DIR = path.join(tmp, 'data', 'storage');
process.env.DB_FILE = path.join(tmp, 'data', 'mig.db');

const { getSqlite, closeDb } = await import('./client.ts');
const { runMigrations, rollback, makeIdempotent } = await import('./migrate.ts');

after(() => closeDb());
const sqlite = getSqlite();
const tableExists = (name: string) =>
  (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").all(name) as unknown[]).length > 0;

test('迁移脚本配对：每个向上迁移都有 down 脚本', () => {
  const dir = path.resolve(import.meta.dirname, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const ups = files.filter((f) => !f.endsWith('.down.sql'));
  assert.ok(ups.length >= 2, `应有 ≥2 个向上迁移，实际 ${ups.length}`);
  for (const up of ups) {
    assert.ok(files.includes(up.replace(/\.sql$/, '.down.sql')), `${up} 缺少 down 脚本`);
  }
});

test('makeIdempotent：重复 ADD COLUMN 不会报 duplicate column', () => {
  sqlite.exec('CREATE TABLE IF NOT EXISTS t_idem (id TEXT PRIMARY KEY)');
  const sql = 'ALTER TABLE t_idem ADD COLUMN note TEXT; ALTER TABLE t_idem ADD COLUMN note TEXT;';
  assert.doesNotThrow(() => makeIdempotent(sqlite, sql));
  // 带注释的语句同样要被正确识别
  const commented = '-- 说明\nALTER TABLE t_idem ADD COLUMN note2 TEXT;\n-- 再说明\nALTER TABLE t_idem ADD COLUMN note2 TEXT;';
  assert.doesNotThrow(() => makeIdempotent(sqlite, commented));
  const cols = (sqlite.prepare('PRAGMA table_info(t_idem)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('note') && cols.includes('note2'));
});

test('迁移：Phase 1 + Phase 2 表与列齐全', () => {
  const applied = runMigrations();
  assert.ok(applied.includes('0001_init.sql') || applied.length === 0, `应包含 0001，实际 ${applied.join(',')}`);
  for (const t of ['users', 'workspaces', 'goals', 'tasks', 'agents', 'files', 'audit_logs']) {
    assert.ok(tableExists(t), `缺少 Phase 1 表 ${t}`);
  }
  for (const t of ['goal_runs', 'goal_audits', 'cluster_configs', 'office_documents', 'file_exports', 'research_jobs', 'research_reports']) {
    assert.ok(tableExists(t), `缺少 Phase 2 表 ${t}`);
  }
  const factCols = (sqlite.prepare('PRAGMA table_info(memory_facts)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(factCols.includes('fact_type'), '0002 新增列 fact_type 应存在');
  assert.ok(factCols.includes('embedding'), '0002 新增列 embedding 应存在');
});

test('回滚：0002 删除 Phase 2 表且不动 Phase 1', () => {
  const target = rollback('0002_phase2.sql');
  assert.equal(target, '0002_phase2.sql');
  for (const t of ['goal_runs', 'goal_audits', 'cluster_configs', 'research_jobs']) {
    assert.equal(tableExists(t), false, `回滚后 ${t} 应被删除`);
  }
  for (const t of ['users', 'workspaces', 'goals', 'tasks', 'agents']) {
    assert.ok(tableExists(t), `回滚不应删除 Phase 1 表 ${t}`);
  }
});

test('回滚后可幂等重新迁移（可回滚 + 可重复部署）', () => {
  assert.doesNotThrow(() => runMigrations());
  for (const t of ['goal_runs', 'research_reports', 'cluster_configs']) {
    assert.ok(tableExists(t), `重新迁移后应恢复 ${t}`);
  }
});

test('回滚保护：不存在的迁移返回 null，已回滚的再次回滚也返回 null', () => {
  assert.equal(rollback('9999_not_exist.sql'), null);
  assert.equal(rollback('0002_phase2.sql'), '0002_phase2.sql');
  assert.equal(rollback('0002_phase2.sql'), null, '已回滚的迁移再次回滚应为 null');
  for (const t of ['users', 'tasks']) assert.ok(tableExists(t), '多次回滚后 Phase 1 表必须完好');
});

test('回滚脚本内容不包含删除 Phase 1 表的语句', () => {
  const down = readFileSync(path.resolve(import.meta.dirname, 'migrations/0002_phase2.down.sql'), 'utf8');
  const phase1Tables = ['users', 'workspaces', 'conversations', 'messages', 'goals', 'tasks', 'agents', 'agent_runs', 'files', 'file_versions', 'widgets', 'plugins', 'audit_logs'];
  for (const t of phase1Tables) {
    assert.ok(!new RegExp(`DROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?${t}\\b`, 'i').test(down), `down 脚本不得删除 Phase 1 表 ${t}`);
  }
  assert.ok(/DROP\s+TABLE/i.test(down), 'down 脚本应包含删除动作');
});
