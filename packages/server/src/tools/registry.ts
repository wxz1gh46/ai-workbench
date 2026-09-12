import { AppError } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import type { ToolContext, ToolDefinition, ToolResult } from './types.ts';

/**
 * 工具注册表。
 * 所有工具调用（含被拒绝的）都必须写审计日志，由调用方（AgentRunner）负责落库，
 * 这里保证「权限校验 → 执行 → 计时 → 归一化错误」链路统一。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<A>(tool: ToolDefinition<A>): void {
    if (this.tools.has(tool.name)) {
      throw AppError.conflict(`工具已注册: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as unknown as ToolDefinition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition {
    const t = this.tools.get(name);
    if (!t) throw AppError.notFound(`工具不存在: ${name}`);
    return t;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** 生成给模型的工具说明（类 OpenAI function calling 格式） */
  describe(whitelist?: string[]): {
    name: string;
    description: string;
    dangerous: boolean;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
  }[] {
    return this.list()
      .filter((t) => !whitelist || whitelist.length === 0 || whitelist.includes(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        dangerous: t.dangerous,
        parameters: t.parameters,
      }));
  }

  async invoke(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    // 未知工具必须返回失败结果而不是抛出：模型可能编造工具名，
    // 抛出会让整个任务中断，返回结果则能让 Critic 触发「换工具」修正。
    const tool = this.tools.get(name);
    if (!tool) {
      logger.warn('tool not found', { tool: name, agentId: ctx.agentId });
      return { ok: false, error: `工具不存在: ${name}（可用工具：${[...this.tools.keys()].join(', ')}）` };
    }
    if (tool.dangerous && !ctx.userConfirmed) {
      logger.warn('tool blocked by permission gate', { tool: name, workspaceId: ctx.workspaceId });
      return {
        ok: false,
        error: `危险操作需用户确认: ${name}（权限: ${tool.permission}）`,
      };
    }
    const started = Date.now();
    try {
      const result = await tool.run(args as never, ctx);
      logger.debug('tool ok', { tool: name, ms: Date.now() - started });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error('tool failed', { tool: name, error: msg });
      return { ok: false, error: msg };
    }
  }
}

export const toolRegistry = new ToolRegistry();
