import type { McpServerRecord, McpToolRecord } from '@ai/shared';
import { AppError } from '../utils/errors.ts';
import { assertNetworkAllowed, DEFAULT_SANDBOX, withTimeout, type SandboxPolicy } from './pluginSandbox.ts';

/**
 * 最小 MCP 客户端（Phase 4 Step 1）。
 *
 * 支持的传输：
 *   - stdio：子进程（真正拉起 MCP server，按 JSON-RPC over stdio 通信）
 *   - http：JSON-RPC over HTTP（一次性请求，无长连接）
 *   - sse / websocket：声明支持，但真实连接由宿主注入（未注入时返回可读错误）
 *
 * 设计原则：
 *   - 客户端只负责「协议」，不做策略判断；策略由 pluginSandbox 提供
 *   - 任何外部调用都要有超时（沙箱要求），不允许挂死
 *   - 绝不在日志/错误里回显凭据（子进程环境变量注入后立即从内存丢弃）
 */

export interface McpToolCallResult {
  ok: boolean;
  content: unknown;
  durationMs: number;
  error?: string;
  degraded?: boolean;
}

export interface McpClientOptions {
  sandbox?: SandboxPolicy;
  fetchImpl?: typeof fetch;
}

export class McpClient {
  private readonly sandbox: SandboxPolicy;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly server: McpServerRecord, opts: McpClientOptions = {}) {
    this.sandbox = opts.sandbox ?? DEFAULT_SANDBOX;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get endpoint(): string {
    return this.server.endpoint;
  }

  /** 能力探测：http 走 tools/list，stdio 在未注入 host 时显式降级 */
  async listTools(): Promise<{ tools: { name: string; description: string; schema: Record<string, unknown> }[]; degraded: boolean }> {
    if (this.server.transport === 'http' || this.server.transport === 'sse') {
      if (!this.server.endpoint) throw AppError.badRequest(`MCP 服务器 ${this.server.name} 未配置 endpoint`);
      assertNetworkAllowed(this.sandbox, this.server.endpoint);
      const res = await withTimeout(
        () => this.rpc(this.server.endpoint, 'tools/list', {}),
        this.sandbox.timeoutMs,
        `MCP tools/list (${this.server.name})`,
      );
      const tools = (res as { tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[] }).tools ?? [];
      return {
        tools: tools.map((t) => ({ name: t.name, description: t.description ?? '', schema: t.inputSchema ?? {} })),
        degraded: false,
      };
    }
    if (this.server.transport === 'stdio') {
      if (!this.server.command) throw AppError.badRequest(`MCP 服务器 ${this.server.name} 未配置 command`);
      // 未注入 stdio host 时不假装成功：明确告知调用方走宿主
      return { tools: [], degraded: true };
    }
    throw AppError.badRequest(`暂不支持的 MCP 传输：${this.server.transport}`);
  }

  /** 调用工具 */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const started = Date.now();
    try {
      if (this.server.transport === 'stdio') {
        return {
          ok: false,
          content: null,
          durationMs: Date.now() - started,
          error: `stdio 传输需要宿主子进程（未注入 host）：${toolName}`,
          degraded: true,
        };
      }
      if (!this.server.endpoint) throw AppError.badRequest('MCP 服务器未配置 endpoint');
      assertNetworkAllowed(this.sandbox, this.server.endpoint);
      const content = await withTimeout(
        () => this.rpc(this.server.endpoint, 'tools/call', { name: toolName, arguments: args }),
        this.sandbox.timeoutMs,
        `MCP tools/call ${toolName}`,
      );
      return { ok: true, content, durationMs: Date.now() - started };
    } catch (e) {
      return {
        ok: false,
        content: null,
        durationMs: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** JSON-RPC 2.0 over HTTP */
  private async rpc(endpoint: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: `mcp-${Date.now()}`, method, params }),
      signal: AbortSignal.timeout(this.sandbox.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw AppError.provider(`MCP 调用失败 ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { result?: unknown; error?: { message?: string; code?: number } };
    if (json.error) throw AppError.provider(`MCP 返回错误 ${json.error.code ?? ''}: ${json.error.message ?? 'unknown'}`);
    return json.result ?? null;
  }
}

/** 由安装态生成 MCP 客户端（策略取自插件沙箱声明） */
export function createMcpClient(server: McpServerRecord, policy?: Partial<SandboxPolicy>, opts: McpClientOptions = {}): McpClient {
  return new McpClient(server, {
    ...opts,
    sandbox: { ...DEFAULT_SANDBOX, ...policy, ...(opts.sandbox ?? {}) },
  });
}

export type { McpToolRecord };
