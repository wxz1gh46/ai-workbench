import { readFileSync, readdirSync } from 'node:fs';
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

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
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

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations();
}
