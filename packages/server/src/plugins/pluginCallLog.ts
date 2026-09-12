import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { pluginCallLogs, pluginInstallations, plugins } from '../db/schema/index.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';

/**
 * 插件调用日志（Phase 4 Step 1）。
 *
 * 要求：所有工具调用（成功/失败/被拒）都要有日志 —— 被拒绝的调用同样要留痕，
 * 否则「谁在什么时候试图越权」无法追溯。
 *
 * 日志脱敏：入参里像 token/secret/password 的字段一律掩码后再入库，
 * 否则插件调用日志本身就成了凭据泄露源（真实风险）。
 */

const SENSITIVE_KEY = /token|secret|password|pwd|apikey|api_key|authorization|cookie|session/i;

export function maskArgs(args: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 4) return { _truncated: true };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined) {
      out[k] = v;
      continue;
    }
    if (SENSITIVE_KEY.test(k)) {
      out[k] = '<redacted>';
      continue;
    }
    if (typeof v === 'string') {
      // 长文本截断，避免日志表被大内容撑爆
      out[k] = v.length > 2000 ? `${v.slice(0, 2000)}…（截断）` : v;
      continue;
    }
    if (typeof v === 'object' && !Array.isArray(v)) {
      out[k] = maskArgs(v as Record<string, unknown>, depth + 1);
      continue;
    }
    if (Array.isArray(v)) {
      out[k] = v.slice(0, 50).map((x) => (typeof x === 'object' && x !== null ? maskArgs(x as Record<string, unknown>, depth + 1) : x));
      continue;
    }
    out[k] = v;
  }
  return out;
}

export class PluginCallLogger {
  constructor(private readonly db: Db) {}

  async log(input: {
    installationId: string;
    tool: string;
    args: Record<string, unknown>;
    ok: boolean;
    durationMs: number;
    error?: string | null;
    /** 是否因权限不足被拒绝：与「执行失败」区分开，便于排查授权问题 */
    denied?: boolean;
  }) {
    try {
      await this.db.insert(pluginCallLogs).values({
        id: newId('pcl'),
        pluginId: await this.resolvePluginId(input.installationId),
        tool: input.tool,
        args: maskArgs(input.args) as never,
        ok: input.ok,
        durationMs: Math.max(0, Math.round(input.durationMs)),
        error: input.error ?? null,
        createdAt: nowIso(),
      } as never);
    } catch (e) {
      // 调用日志失败不能影响插件主流程，但必须告警
      logger.error('plugin call log insert failed', {
        installationId: input.installationId,
        tool: input.tool,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** plugin_call_logs 既有表以 plugin_id 关联；由安装记录反查 */
  private async resolvePluginId(installationId: string): Promise<string> {
    const rows = (await this.db.select().from(pluginInstallations).where(eq(pluginInstallations.id, installationId)).limit(1)) as unknown as { pluginId: string }[];
    return rows[0]?.pluginId ?? installationId;
  }

  async list(workspaceId: string, installationId: string, limit = 100) {
    const insts = (await this.db.select().from(pluginInstallations).where(eq(pluginInstallations.workspaceId, workspaceId))) as unknown as { id: string; pluginId: string }[];
    const inst = insts.find((i) => i.id === installationId);
    if (!inst) return [];
    const pluginRows = (await this.db.select().from(plugins).where(and(eq(plugins.workspaceId, workspaceId), eq(plugins.id, inst.pluginId)))) as unknown as { id: string }[];
    if (pluginRows.length === 0) return [];
    return this.db
      .select()
      .from(pluginCallLogs)
      .where(eq(pluginCallLogs.pluginId, inst.pluginId))
      .orderBy(desc(pluginCallLogs.createdAt))
      .limit(limit);
  }
}
