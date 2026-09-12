import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { mcpServers, mcpTools } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { SandboxViolation, isPrivateHost } from './pluginSandbox.ts';

/**
 * MCP 服务器注册表（Phase 4 Step 1）。
 *
 * 安全约束：
 *   - endpoint 不允许指向内网 / 云元数据地址（注册期即拒绝，避免运行期 SSRF）
 *   - secretRefs 只记录「变量名」，凭据值由用户在 Keychain / 环境变量提供
 *   - 同一工作区内 name 唯一，避免出现两个同名服务器导致的混淆
 */

export interface RegisterServerInput {
  workspaceId: string;
  name: string;
  transport?: 'stdio' | 'http' | 'sse' | 'websocket';
  endpoint?: string;
  command?: string;
  args?: string[];
  secretRefs?: string[];
  capabilities?: Record<string, unknown>;
}

const TRANSPORTS = ['stdio', 'http', 'sse', 'websocket'] as const;

function validateEndpoint(transport: string, endpoint: string): void {
  if (transport === 'stdio') return;
  if (!endpoint) throw AppError.badRequest('http/sse/websocket 传输必须提供 endpoint');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw AppError.badRequest(`endpoint 不是合法 URL：${endpoint}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw AppError.badRequest(`endpoint 仅支持 http/https，收到 ${url.protocol}`);
  }
  if (isPrivateHost(url.hostname)) {
    // 明确拒绝并给出原因：避免用户以为只是「配置没生效」
    throw new AppError('FORBIDDEN', `endpoint 指向内网/元数据地址，已被拒绝：${url.hostname}`, 403);
  }
}

export class McpServerRegistry {
  constructor(private readonly db: Db) {}

  async list(workspaceId: string) {
    return (await this.db.select().from(mcpServers).where(eq(mcpServers.workspaceId, workspaceId))) as unknown as McpServerRow[];
  }

  async get(workspaceId: string, id: string) {
    const rows = await this.db.select().from(mcpServers).where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, id))).limit(1);
    const row = rows[0];
    if (!row) throw AppError.notFound(`MCP 服务器不存在: ${id}`);
    return row as unknown as McpServerRow;
  }

  async register(input: RegisterServerInput) {
    const name = input.name.trim();
    if (!name) throw AppError.badRequest('MCP 服务器名称不能为空');
    const transport = input.transport ?? 'stdio';
    if (!TRANSPORTS.includes(transport)) throw AppError.badRequest(`不支持的 MCP 传输：${transport}`);
    validateEndpoint(transport, input.endpoint ?? '');
    if (transport === 'stdio' && !input.command) throw AppError.badRequest('stdio 传输必须提供 command');

    const now = nowIso();
    const existing = (await this.list(input.workspaceId)).find((s) => s.name === name);
    if (existing) {
      await this.db
        .update(mcpServers)
        .set({
          transport,
          endpoint: input.endpoint ?? '',
          command: input.command ?? null,
          args: input.args ?? [],
          secretRefs: input.secretRefs ?? [],
          capabilities: input.capabilities ?? {},
          updatedAt: now,
        } as never)
        .where(eq(mcpServers.id, existing.id));
      return this.get(input.workspaceId, existing.id);
    }

    const row = {
      id: newId('mcp'),
      workspaceId: input.workspaceId,
      name,
      transport,
      endpoint: input.endpoint ?? '',
      command: input.command ?? null,
      args: input.args ?? [],
      status: 'registered' as const,
      capabilities: input.capabilities ?? {},
      secretRefs: input.secretRefs ?? [],
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(mcpServers).values(row as never);
    return this.get(input.workspaceId, row.id);
  }

  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    await this.db.delete(mcpServers).where(eq(mcpServers.id, id));
    return { removed: id };
  }

  async setStatus(id: string, status: 'registered' | 'connected' | 'error' | 'disabled', lastError?: string | null) {
    await this.db
      .update(mcpServers)
      .set({ status, lastError: lastError ?? null, updatedAt: nowIso() } as never)
      .where(eq(mcpServers.id, id));
  }

  /** 同步工具列表（能力缓存）：写 mcp_tools，保留用户已设置的 enabled 开关 */
  async syncTools(serverId: string, tools: { name: string; description: string; schema: Record<string, unknown>; dangerous?: boolean }[]) {
    const existing = (await this.db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId))) as unknown as McpToolRow[];
    const byName = new Map(existing.map((t) => [t.name, t]));
    for (const t of tools) {
      const prev = byName.get(t.name);
      if (prev) {
        await this.db
          .update(mcpTools)
          .set({ description: t.description, schema: t.schema, dangerous: t.dangerous ?? prev.dangerous } as never)
          .where(eq(mcpTools.id, prev.id));
      } else {
        await this.db.insert(mcpTools).values({
          id: newId('mcpt'),
          serverId,
          name: t.name,
          description: t.description,
          schema: t.schema,
          enabled: true,
          dangerous: t.dangerous ?? false,
        } as never);
      }
    }
    return this.listTools(serverId);
  }

  async listTools(serverId: string) {
    return (await this.db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId))) as unknown as McpToolRow[];
  }

  async setToolEnabled(serverId: string, name: string, enabled: boolean) {
    await this.db.update(mcpTools).set({ enabled } as never).where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, name)));
    return this.listTools(serverId);
  }
}

export type McpServerRow = typeof mcpServers.$inferSelect;
export type McpToolRow = typeof mcpTools.$inferSelect;
export { SandboxViolation };
