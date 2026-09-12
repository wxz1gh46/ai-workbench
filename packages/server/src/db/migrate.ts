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
      sqlite.exec(sql);
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
