import type { PluginManifest } from './pluginManifest.ts';

/**
 * 精选插件市场（Phase 4 Step 1）。
 *
 * 与 Phase 1 的 CURATED_PLUGINS（services/plugin-service.ts）的关系：
 *   - 本文件是 Phase 4 的「完整清单规范」版本，含 tools / resources / prompts / author / description
 *   - Phase 1 的简版目录保留给旧 UI；新 UI（PluginMarket 页面）走本目录
 *   - 两边的 name 保持一一对应，避免出现「同一插件两个 id」的混乱
 *
 * 合规红线：付费数据源一律 requiresUserAuth = true，凭据由用户手动配置。
 */

function m(partial: Omit<PluginManifest, 'sandbox'> & { sandbox?: boolean }): PluginManifest {
  return { sandbox: true, ...partial };
}

export const PLUGIN_MARKET: PluginManifest[] = [
  /* ------------------------------ MCP 优先 ------------------------------ */
  m({
    name: 'mcp-filesystem',
    version: '1.0.0',
    author: 'ai-workbench',
    description: '本地文件系统 MCP 服务器：在工作区目录内读写文件（路径边界由宿主强制）',
    kind: 'mcp',
    source: 'market://mcp/filesystem',
    permissions: [
      { scope: 'fs:read', description: '读取工作区文件', sensitive: false, required: true },
      { scope: 'fs:write', description: '写入/覆盖工作区文件', sensitive: true, required: false },
    ],
    tools: [
      { name: 'read_file', description: '读取文本文件内容', requires: ['fs:read'], input: { path: 'string' } },
      { name: 'list_dir', description: '列出目录条目', requires: ['fs:read'], input: { path: 'string' } },
      { name: 'write_file', description: '写入文件（会覆盖同名文件）', requires: ['fs:write'], dangerous: true, input: { path: 'string', content: 'string' } },
    ],
    resources: [{ uri: 'workspace://', description: '工作区目录树' }],
    prompts: [{ name: 'summarize-file', description: '对文件内容做摘要' }],
    requiresUserAuth: false,
    secretRefs: [],
  }),
  m({
    name: 'mcp-web-fetch',
    version: '1.1.0',
    author: 'ai-workbench',
    description: '联网抓取 MCP 服务器：遵守 robots.txt，支持并发与超时限制',
    kind: 'mcp',
    source: 'market://mcp/web-fetch',
    permissions: [{ scope: 'net:http', description: '发起 HTTP 请求（遵守 robots.txt）', sensitive: true, required: true }],
    tools: [
      { name: 'fetch_url', description: '抓取单个 URL 并返回文本', requires: ['net:http'], input: { url: 'string' } },
      { name: 'search', description: '调用用户自建检索端点', requires: ['net:http'], input: { query: 'string' } },
    ],
    requiresUserAuth: false,
    secretRefs: [],
    config: { respectRobots: true, maxBytes: 400_000 },
  }),
  m({
    name: 'mcp-git',
    version: '0.9.0',
    author: 'ai-workbench',
    description: 'Git MCP 服务器：在工作区内执行只读 git 查询（log/diff/status）',
    kind: 'mcp',
    source: 'market://mcp/git',
    permissions: [
      { scope: 'fs:read', description: '读取工作区文件', sensitive: false, required: true },
      { scope: 'exec:readonly', description: '执行只读命令', sensitive: true, required: true },
    ],
    tools: [
      { name: 'git_log', description: '查看提交历史', requires: ['exec:readonly'], input: { limit: 'number' } },
      { name: 'git_diff', description: '查看工作区 diff', requires: ['exec:readonly'] },
    ],
    requiresUserAuth: false,
    secretRefs: [],
  }),
  m({
    name: 'mcp-sqlite',
    version: '0.9.0',
    author: 'ai-workbench',
    description: 'SQLite MCP 服务器：只读查询本地 .db 文件（默认强制 LIMIT）',
    kind: 'mcp',
    source: 'market://mcp/sqlite',
    permissions: [{ scope: 'db:read', description: '只读查询本地数据库', sensitive: true, required: true }],
    tools: [{ name: 'query', description: '执行只读 SQL', requires: ['db:read'], input: { sql: 'string' } }],
    requiresUserAuth: false,
    secretRefs: [],
  }),

  /* ------------------------------ 付费数据源 ------------------------------ */
  m({
    name: 'db-tonghuashun',
    version: '1.0.0',
    author: 'ai-workbench',
    description: '同花顺开放平台：行情、财务、公告（需自行申请 API Key）',
    kind: 'http',
    source: 'market://cn/tonghuashun',
    permissions: [{ scope: 'paid:market-data', description: '读取同花顺行情数据（付费订阅）', sensitive: true, required: true }],
    tools: [
      { name: 'market.quote', description: '查询实时行情', requires: ['paid:market-data'], input: { symbol: 'string' } },
      { name: 'finance.report', description: '查询财务指标', requires: ['paid:market-data'], input: { symbol: 'string', period: 'string' } },
      { name: 'company.announcement', description: '查询公司公告', requires: ['paid:market-data'], input: { symbol: 'string' } },
    ],
    requiresUserAuth: true,
    secretRefs: ['TONGHUASHUN_APP_KEY', 'TONGHUASHUN_APP_SECRET'],
    config: { note: '仅使用同花顺官方开放平台 API，密钥由用户自行申请' },
  }),
  m({
    name: 'db-tianyancha',
    version: '1.0.0',
    author: 'ai-workbench',
    description: '天眼查开放平台：工商、司法、股权（需自行申请 Token）',
    kind: 'http',
    source: 'market://cn/tianyancha',
    permissions: [{ scope: 'paid:enterprise-data', description: '读取企业工商数据（付费订阅）', sensitive: true, required: true }],
    tools: [
      { name: 'company.basic', description: '查询企业基本信息', requires: ['paid:enterprise-data'], input: { keyword: 'string' } },
      { name: 'company.justice', description: '查询司法风险', requires: ['paid:enterprise-data'], input: { keyword: 'string' } },
      { name: 'company.equity', description: '查询股权结构', requires: ['paid:enterprise-data'], input: { keyword: 'string' } },
    ],
    requiresUserAuth: true,
    secretRefs: ['TIANYANCHA_TOKEN'],
    config: { note: '使用天眼查官方开放平台 API，密钥由用户手动配置' },
  }),
  m({
    name: 'db-wind',
    version: '0.9.0',
    author: 'ai-workbench',
    description: 'Wind 万得金融终端：本地终端桥接，需本机已安装并登录 Wind',
    kind: 'local',
    source: 'market://cn/wind',
    permissions: [{ scope: 'paid:financial-terminal', description: '读取 Wind 金融终端数据', sensitive: true, required: true }],
    tools: [
      { name: 'wds.query', description: '查询 Wind 数据集', requires: ['paid:financial-terminal'], input: { dataset: 'string' } },
      { name: 'wset.data', description: '查询行情序列', requires: ['paid:financial-terminal'], input: { codes: 'string' } },
    ],
    requiresUserAuth: true,
    secretRefs: ['WIND_LICENSE'],
    config: { note: '需本地安装 Wind 终端并授权，本插件仅做本地进程桥接，不代理登录' },
  }),
  m({
    name: 'db-hs-juyuan',
    version: '0.9.0',
    author: 'ai-workbench',
    description: '恒生聚源：金融数据（需自行申请 API Key）',
    kind: 'http',
    source: 'market://cn/hs-juyuan',
    permissions: [{ scope: 'paid:financial-data', description: '读取恒生聚源金融数据', sensitive: true, required: true }],
    tools: [{ name: 'finance.query', description: '查询金融数据', requires: ['paid:financial-data'], input: { table: 'string' } }],
    requiresUserAuth: true,
    secretRefs: ['JUYUAN_API_KEY'],
  }),
  m({
    name: 'db-sp-global',
    version: '0.9.0',
    author: 'ai-workbench',
    description: 'S&P Global Market Intelligence：全球市场数据',
    kind: 'http',
    source: 'market://global/sp-global',
    permissions: [{ scope: 'paid:market-intelligence', description: 'S&P Global Market Intelligence 数据', sensitive: true, required: true }],
    tools: [{ name: 'market.intelligence', description: '查询全球市场情报', requires: ['paid:market-intelligence'], input: { query: 'string' } }],
    requiresUserAuth: true,
    secretRefs: ['SPGI_API_KEY'],
  }),
  m({
    name: 'db-imf',
    version: '0.9.0',
    author: 'ai-workbench',
    description: 'IMF 公开数据：宏观经济指标（开放接口，无需凭据）',
    kind: 'http',
    source: 'market://global/imf',
    permissions: [{ scope: 'open:macro-data', description: 'IMF 公开宏观经济数据', sensitive: false, required: true }],
    tools: [{ name: 'macro.series', description: '查询宏观序列', requires: ['open:macro-data'], input: { indicator: 'string', country: 'string' } }],
    requiresUserAuth: false,
    secretRefs: [],
  }),
  m({
    name: 'db-hyyd-legal',
    version: '0.9.0',
    author: 'ai-workbench',
    description: '华宇元典法律数据库：法规与案例检索',
    kind: 'http',
    source: 'market://cn/hyyd',
    permissions: [{ scope: 'paid:legal-case', description: '华宇元典法律案例数据', sensitive: true, required: true }],
    tools: [{ name: 'legal.search', description: '检索法律案例', requires: ['paid:legal-case'], input: { keyword: 'string' } }],
    requiresUserAuth: true,
    secretRefs: ['HYYD_TOKEN'],
  }),
  m({
    name: 'db-academic',
    version: '1.0.0',
    author: 'ai-workbench',
    description: '学术数据库：Crossref / OpenAlex 开放接口，含引用关系',
    kind: 'http',
    source: 'market://global/academic',
    permissions: [{ scope: 'open:academic', description: '学术数据库检索（Crossref / OpenAlex 等开放接口）', sensitive: false, required: true }],
    tools: [
      { name: 'paper.search', description: '检索论文', requires: ['open:academic'], input: { query: 'string' } },
      { name: 'paper.citations', description: '查询引用关系', requires: ['open:academic'], input: { doi: 'string' } },
    ],
    requiresUserAuth: false,
    secretRefs: [],
    config: { providers: ['crossref', 'openalex'] },
  }),
];

export function findManifest(name: string): PluginManifest | undefined {
  return PLUGIN_MARKET.find((p) => p.name === name);
}

/** 市场分类检索：按关键字 / 类型过滤 */
export function searchMarket(input: { q?: string; kind?: string; requiresAuth?: boolean } = {}): PluginManifest[] {
  const q = (input.q ?? '').trim().toLowerCase();
  return PLUGIN_MARKET.filter((p) => {
    if (input.kind && p.kind !== input.kind) return false;
    if (input.requiresAuth !== undefined && p.requiresUserAuth !== input.requiresAuth) return false;
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.tools.some((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
    );
  });
}
