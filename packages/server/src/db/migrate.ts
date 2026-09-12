import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { getSqlite } from './client.ts';
import { logger } from '../utils/logger.ts';

/**
 * 极简迁移执行器：
 * - 迁移文件按文件名排序执行（0001_xxx.sql, 0002_xxx.sql ...）
 * - 已执行的写入 _migrations 表，重复执行幂等
 * 选择自研而非 drizzle-kit push，是为了「每个阶段可回滚 + 可审计」。
 */
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, 'migrations');

/**
 * 迁移前处理：SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，而回滚脚本无法删除列
 * （老版本 SQLite 无 DROP COLUMN）。因此回滚后再迁移会出现 `duplicate column name`。
 *
 * 解决方式：为每条 `ALTER TABLE ... ADD COLUMN` 生成「先查 PRAGMA 再决定是否执行」的包装，
 * 保证迁移真正幂等 —— 这是「可回滚 + 可重复部署」的必要条件。
 */
export function makeIdempotent(sqlite: ReturnType<typeof getSqlite>, sql: string): void {
  // 先去掉行注释，否则注释会粘在语句开头导致 `^ALTER` 匹配失败
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  const statements = withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    const addColumn = /^ALTER\s+TABLE\s+(?:"?([\w]+)"?)\s+ADD\s+COLUMN\s+(?:"?([\w]+)"?)/i.exec(stmt);
    if (addColumn) {
      const [, table, column] = addColumn;
      if (!table || !column) continue;
      const exists = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
      if (exists) {
        logger.debug('migration step skipped (column exists)', { table, column });
        continue;
      }
    }
    sqlite.exec(stmt);
  }
}

export function runMigrations(): string[] {
  const sqlite = getSqlite();
  sqlite.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    (sqlite.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  );

  // 只加载「向上」迁移；*.down.sql 是回滚脚本，由 rollback() 显式使用，不能按顺序执行
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();

  const executed: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const tx = sqlite.transaction(() => {
      makeIdempotent(sqlite, sql);
      sqlite.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
    });
    tx();
    executed.push(file);
    logger.info('migration applied', { file });
  }
  if (executed.length === 0) logger.info('db up to date', { migrations: files.length });
  return executed;
}

/**
 * 回滚指定迁移（默认回滚最后一个已应用的）。
 * 用于「每个 Step 可独立回滚」的验收要求；只删除该迁移新增的结构。
 */
export function rollback(name?: string): string | null {
  const sqlite = getSqlite();
  const applied = (sqlite.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]).map((r) => r.name);
  const target = name ?? applied.at(-1);
  if (!target) {
    logger.warn('rollback skipped: no migration applied');
    return null;
  }
  if (!applied.includes(target)) {
    logger.warn('rollback skipped: migration not applied', { target });
    return null;
  }
  const upFile = path.join(MIGRATIONS_DIR, target);
  const downFile = upFile.replace(/\.sql$/, '.down.sql');
  if (!existsSync(downFile)) {
    logger.warn('rollback unavailable: missing down script', { target });
    return null;
  }
  const sql = readFileSync(downFile, 'utf8');
  const tx = sqlite.transaction(() => {
    sqlite.exec(sql);
    sqlite.prepare('DELETE FROM _migrations WHERE name = ?').run(target);
  });
  tx();
  logger.info('migration rolled back', { file: target });
  return target;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rollbackArg = process.argv.includes('--rollback');
  if (rollbackArg) {
    const idx = process.argv.indexOf('--rollback');
    const name = process.argv[idx + 1];
    rollback(name && name.endsWith('.sql') ? name : undefined);
  } else {
    runMigrations();
  }
}
