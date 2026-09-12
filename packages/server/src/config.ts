import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * 配置读取原则：
 * 1) 所有密钥只从环境变量 / OS Keychain 读，代码里不出现默认密钥
 * 2) 缺失密钥不报错，仅在真正调用对应能力时返回可读错误
 */
function env(key: string, fallback = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function num(key: string, fallback: number): number {
  const v = Number(env(key, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const root = process.cwd();

export const config = {
  env: env('NODE_ENV', 'development'),
  host: env('HOST', '127.0.0.1'),
  port: num('PORT', 8787),

  dataDir: ensureDir(path.resolve(root, env('DATA_DIR', './data'))),
  get storageDir() {
    return ensureDir(path.resolve(root, env('STORAGE_DIR', './data/storage')));
  },
  get dbFile() {
    return path.resolve(root, env('DB_FILE', path.join(env('DATA_DIR', './data'), 'ai-workbench.db')));
  },

  ai: {
    defaultProvider: env('AI_DEFAULT_PROVIDER', 'openai-compatible'),
    baseUrl: env('AI_BASE_URL', 'http://127.0.0.1:11434/v1'),
    apiKey: env('AI_API_KEY'),
    model: env('AI_MODEL', 'gpt-4o-mini'),
    longContextModel: env('AI_LONG_CONTEXT_MODEL', 'gpt-4.1'),
    longContextThreshold: num('AI_LONG_CONTEXT_THRESHOLD', 120_000),
  },

  /** 阶段开关：未实现的 Phase 默认关闭，UI 上显示为「未启用」 */
  features: {
    phase2GoalMode: true,
    phase2Office: true,
    phase2Research: false,
    phase3Deploy: false,
    phase3Schedule: true,
    phase4Cluster: false,
    phase4PaidPlugins: false,
  },

  logLevel: env('LOG_LEVEL', 'info'),
} as const;

export type AppConfig = typeof config;
