import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, closeDb, type Db } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { setSecretKeyForTest } from '../src/security/secrets.ts';

/**
 * Phase 3 测试脚手架。
 *
 * 关键点：
 *   1. 每个测试用独立临时目录 + :memory: 之外的 SQLite 文件（迁移需要文件）；
 *   2. 注入固定加密密钥（setSecretKeyForTest）→ 测试可复现，不依赖环境变量；
 *   3. 绝不读取真实环境变量里的平台凭据 → 保证「未配置」路径被测到，
 *      而不是在 CI 上意外调用真实 Vercel/Neon。
 */
export interface TestContext {
  db: Db;
  workspaceId: string;
  tempDir: string;
  cleanup: () => void;
}

const PROVIDER_ENV_KEYS = [
  'VERCEL_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_PROJECT',
  'NETLIFY_AUTH_TOKEN',
  'NETLIFY_SITE_ID',
  'NEON_API_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'DATABASE_URL',
];

export function setupTestContext(name: string): TestContext {
  // 每个测试上下文必须从干净的 DB 单例开始：上一个测试的 cleanup 会 close 掉
  // 共享句柄，如果不重置单例，下一个 setupTestContext 会拿到已关闭的连接
  // （表现为 "no such table: users" —— 真实踩坑）。
  closeDb();
  const tempDir = mkdtempSync(path.join(tmpdir(), `ai-wb-${name}-`));
  setSecretKeyForTest('phase3-test-key-0123456789abcdef');
  // 隔离真实凭据：任何测试都不应调用外部平台
  const saved: Record<string, string | undefined> = {};
  for (const k of PROVIDER_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.DATA_DIR = tempDir;

  const dbFile = path.join(tempDir, 'test.db');
  process.env.DB_FILE = dbFile;
  const { db, sqlite } = createDb(dbFile);
  runMigrations();

  const now = new Date().toISOString();
  const userId = 'usr_test';
  const workspaceId = 'ws_test';
  sqlite
    .prepare('INSERT INTO users (id, name, role, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, '测试用户', 'owner', now);
  sqlite
    .prepare('INSERT INTO workspaces (id, user_id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(workspaceId, userId, '测试工作区', tempDir, now, now);

  return {
    db,
    workspaceId,
    tempDir,
    cleanup: () => {
      closeDb();
      sqlite.close();
      for (const k of PROVIDER_ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/** 断言辅助：从执行结果中提取错误信息 */
export function errorOf(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => '',
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
}
