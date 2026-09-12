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
    /** 远端 embedding 模型；留空则使用本地确定性 embedding（离线可用） */
    embeddingModel: env('AI_EMBEDDING_MODEL'),
    /** 递归摘要用的「便宜」模型，留空则复用默认模型 */
    summaryModel: env('AI_SUMMARY_MODEL'),
    /** 单次请求的上下文总预算，可按模型能力调整 */
    contextBudget: num('AI_CONTEXT_BUDGET', 200_000),
    /** 滚动摘要触发阈值（token）；0 表示按上下文预算自动推算 */
    compactThreshold: num('AI_COMPACT_THRESHOLD', 0),
  },

  /** 联网检索：全部需要用户自行配置，不内置任何第三方密钥 */
  research: {
    /** 自建检索服务（SearXNG 等）的 base url，留空则禁用联网 */
    searchEndpoint: env('RESEARCH_SEARCH_ENDPOINT'),
    searchApiKey: env('RESEARCH_SEARCH_API_KEY'),
    /** 抓取并发与超时 */
    fetchConcurrency: num('RESEARCH_FETCH_CONCURRENCY', 4),
    fetchTimeoutMs: num('RESEARCH_FETCH_TIMEOUT_MS', 15_000),
    maxBytesPerPage: num('RESEARCH_MAX_BYTES_PER_PAGE', 400_000),
    userAgent: env('RESEARCH_USER_AGENT', 'AIWorkbenchBot/0.2 (+local research; contact: user-configured)'),
    /** 合规：是否遵守 robots.txt（默认遵守，不允许关闭绕过） */
    respectRobots: true,
  },

  /** Office 转换：LibreOffice headless 可执行文件路径，留空则显式降级 */
  office: {
    sofficePath: env('SOFFICE_PATH'),
    convertTimeoutMs: num('OFFICE_CONVERT_TIMEOUT_MS', 60_000),
  },

  /** 阶段开关：未实现的 Phase 默认关闭，UI 上显示为「未启用」 */
  features: {
    phase2GoalMode: true,
    phase2Office: true,
    phase2Research: true,
    phase3Deploy: true,
    phase3Schedule: true,
    phase3Database: true,
    phase3Dashboard: true,
    phase3Notify: true,
    /**
     * Phase 4 功能开关。
     *
     * 与 Phase 3 的策略一致：默认开启，但都可以单独关闭。
     * 关闭后接口返回「未启用」而**数据全保留** —— 这是「每个 Step 可独立回滚」的前提。
     */
    phase4Cluster: env('PHASE4_CLUSTER', '1') !== '0',
    phase4PaidPlugins: env('PHASE4_PAID_PLUGINS', '1') !== '0',
    phase4Prompt: env('PHASE4_PROMPT', '1') !== '0',
    phase4Enterprise: env('PHASE4_ENTERPRISE', '1') !== '0',
  },

  logLevel: env('LOG_LEVEL', 'info'),
} as const;

export type AppConfig = typeof config;
