import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../config.ts';
import * as schema from './schema/index.ts';

export type Db = ReturnType<typeof createDb>['db'];

let singleton: ReturnType<typeof createDb> | null = null;

function createDb(file: string = config.dbFile) {
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

/** 获取单例 DB；测试时可传入 :memory: */
export function getDb(file?: string) {
  if (!singleton) singleton = createDb(file);
  return singleton.db;
}

export function getSqlite(file?: string) {
  if (!singleton) singleton = createDb(file);
  return singleton.sqlite;
}

export function closeDb(): void {
  if (singleton) {
    singleton.sqlite.close();
    singleton = null;
  }
}

export { createDb, schema };
