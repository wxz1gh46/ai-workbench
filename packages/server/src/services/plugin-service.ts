import { eq } from 'drizzle-orm';
import type { Plugin, PluginPermission } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { pluginCallLogs, plugins } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';

export interface PluginManifest {
  name: string;
  version: string;
  kind: Plugin['kind'];
  source: string;
  permissions: PluginPermission[];
  requiresUserAuth: boolean;
  secretRefs: string[];
  sandbox: boolean;
  config?: Record<string, unknown>;
}

/**
 * 插件市场（精选插件）。
 *
 * 合规红线（写死在代码里，避免后续误改）：
 * - 付费数据库（同花顺 / 天眼查 / Wind / 恒生聚源 / 标普 / IMF / 华宇元典 / 学术库）
 *   一律 requiresUserAuth = true，凭据由用户在 Keychain 手动填写
 * - 不接受「绕过反爬」「共享账号」类插件：manifest 中出现相关声明直接拒绝安装
 * - 所有插件调用必须写 plugin_call_logs
 */
const FORBIDDEN_PATTERNS = [
  /bypass[-_ ]*(anti[-_ ]?)?(crawler|bot|scrap)/i,
  /绕过(反爬|风控|验证码)/,
  /shared[-_ ]?account/i,
  /共享账号/,
  /crack(ed)?[-_ ]?(api|license)/i,
];

export const CURATED_PLUGINS: PluginManifest[] = [
  {
    name: 'mcp-filesystem',
    version: '1.0.0',
    kind: 'mcp',
    source: 'market://mcp/filesystem',
    permissions: [
      { scope: 'fs:read', description: '读取工作区文件', sensitive: false },
      { scope: 'fs:write', description: '写入工作区文件', sensitive: true },
    ],
    requiresUserAuth: false,
    secretRefs: [],
    sandbox: true,
  },
  {
    name: 'mcp-web-fetch',
    version: '1.0.0',
    kind: 'mcp',
    source: 'market://mcp/web-fetch',
    permissions: [{ scope: 'net:http', description: '发起网络请求（遵守 robots.txt）', sensitive: true }],
    requiresUserAuth: true,
    secretRefs: [],
    sandbox: true,
    config: { respectRobots: true },
  },
  {
    name: 'db-tonghuashun',
    version: '0.9.0',
    kind: 'http',
    source: 'market://cn/tonghuashun',
    permissions: [
      { scope: 'paid:market-data', description: '读取同花顺行情数据（付费订阅）', sensitive: true },
    ],
    requiresUserAuth: true,
    secretRefs: ['TONGHUASHUN_APP_KEY', 'TONGHUASHUN_APP_SECRET'],
    sandbox: true,
    config: { note: '仅使用同花顺官方开放平台 API，需用户自行申请并配置密钥' },
  },
  {
    name: 'db-tianyancha',
    version: '0.9.0',
    kind: 'http',
    source: 'market://cn/tianyancha',
    permissions: [{ scope: 'paid:enterprise-data', description: '读取企业工商数据（付费订阅）', sensitive: true }],
    requiresUserAuth: true,
    secretRefs: ['TIANYANCHA_TOKEN'],
    sandbox: true,
    config: { note: '使用天眼查官方开放平台 API，密钥由用户手动配置' },
  },
  {
    name: 'db-wind',
    version: '0.8.0',
    kind: 'local',
    source: 'market://cn/wind',
    permissions: [{ scope: 'paid:financial-terminal', description: '读取 Wind 金融终端数据', sensitive: true }],
    requiresUserAuth: true,
    secretRefs: ['WIND_LICENSE'],
    sandbox: true,
    config: { note: '需本地安装 Wind 终端并授权，本插件仅做本地进程桥接' },
  },
  {
    name: 'db-hs-juyuan',
    version: '0.8.0',
    kind: 'http',
    source: 'market://cn/hs-juyuan',
    permissions: [{ scope: 'paid:financial-data', description: '读取恒生聚源金融数据', sensitive: true }],
    requiresUserAuth: true,
    secretRefs: ['JUYUAN_API_KEY'],
    sandbox: true,
  },
  {
    name: 'db-sp-global',
    version: '0.8.0',
    kind: 'http',
    source: 'market://global/sp-global',
    permissions: [{ scope: 'paid:market-intelligence', description: 'S&P Global Market Intelligence 数据', sensitive: true }],
    requiresUserAuth: true,
    secretRefs: ['SPGI_API_KEY'],
    sandbox: true,
  },
  {
    name: 'db-imf',
    version: '0.9.0',
    kind: 'http',
    source: 'market://global/imf',
    permissions: [{ scope: 'open:macro-data', description: 'IMF 公开宏观经济数据', sensitive: false }],
    requiresUserAuth: false,
    secretRefs: [],
    sandbox: true,
  },
  {
    name: 'db-hyyd-legal',
    version: '0.8.0',
    kind: 'http',
    source: 'market://cn/hyyd',
    permissions: [{ scope: 'paid:legal-case', description: '华宇元典法律案例数据', sensitive: true }],
    requiresUserAuth: true,
    secretRefs: ['HYYD_TOKEN'],
    sandbox: true,
  },
  {
    name: 'db-academic',
    version: '0.9.0',
    kind: 'http',
    source: 'market://global/academic',
    permissions: [{ scope: 'open:academic', description: '学术数据库检索（Crossref / OpenAlex 等开放接口）', sensitive: false }],
    requiresUserAuth: false,
    secretRefs: [],
    sandbox: true,
    config: { providers: ['crossref', 'openalex'] },
  },
];

export function assertCompliant(manifest: PluginManifest): void {
  const haystack = [manifest.name, manifest.source, JSON.stringify(manifest.config ?? {}), manifest.permissions.map((p) => p.scope + p.description).join(' ')].join(' ');
  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(haystack)) {
      throw AppError.forbidden(`插件声明违反合规要求，已拒绝安装: ${manifest.name}`);
    }
  }
  const paidScopes = manifest.permissions.filter((p) => p.scope.startsWith('paid:'));
  if (paidScopes.length > 0 && !manifest.requiresUserAuth) {
    throw AppError.forbidden(`付费数据插件必须要求用户手动授权: ${manifest.name}`);
  }
}

export class PluginService {
  constructor(private readonly db: Db) {}

  listCatalog(): PluginManifest[] {
    return CURATED_PLUGINS;
  }

  async list(workspaceId: string): Promise<Plugin[]> {
    return (await this.db.select().from(plugins).where(eq(plugins.workspaceId, workspaceId))) as Plugin[];
  }

  /** 安装：先合规校验，再落库为 installed（启用需用户再确认授权） */
  async install(workspaceId: string, name: string): Promise<Plugin> {
    const manifest = CURATED_PLUGINS.find((p) => p.name === name);
    if (!manifest) throw AppError.notFound(`插件市场中不存在: ${name}`);
    assertCompliant(manifest);
    const existing = (await this.list(workspaceId)).find((p) => p.name === name);
    const now = nowIso();
    if (existing) {
      await this.db.update(plugins).set({ version: manifest.version, updatedAt: now }).where(eq(plugins.id, existing.id));
      return (await this.db.select().from(plugins).where(eq(plugins.id, existing.id)).limit(1))[0] as Plugin;
    }
    const row = {
      id: newId('plg'),
      workspaceId,
      name: manifest.name,
      version: manifest.version,
      kind: manifest.kind,
      source: manifest.source,
      status: 'installed' as const,
      permissions: manifest.permissions,
      requiresUserAuth: manifest.requiresUserAuth,
      secretRefs: manifest.secretRefs,
      sandbox: manifest.sandbox,
      config: manifest.config ?? {},
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(plugins).values(row);
    return row as unknown as Plugin;
  }

  async setStatus(id: string, status: Plugin['status']): Promise<Plugin> {
    await this.db.update(plugins).set({ status, updatedAt: nowIso() }).where(eq(plugins.id, id));
    const rows = await this.db.select().from(plugins).where(eq(plugins.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw AppError.notFound(`插件未安装: ${id}`);
    return row as Plugin;
  }

  async uninstall(id: string): Promise<void> {
    await this.db.delete(plugins).where(eq(plugins.id, id));
  }

  /** 调用日志：Phase 1 仅记录，真实调用在插件运行时接入 */
  async logCall(input: { pluginId: string; tool: string; args: Record<string, unknown>; ok: boolean; durationMs: number; error?: string }): Promise<void> {
    await this.db.insert(pluginCallLogs).values({
      id: newId('pcl'),
      pluginId: input.pluginId,
      tool: input.tool,
      args: input.args,
      ok: input.ok,
      durationMs: input.durationMs,
      error: input.error ?? null,
      createdAt: nowIso(),
    });
  }
}
