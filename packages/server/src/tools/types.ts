import type { Id } from '@ai/shared';

export interface ToolContext {
  workspaceId: Id;
  goalId: Id | null;
  taskId: Id | null;
  agentId: Id;
  runId: Id;
  /** 用户是否已对危险操作做出确认（由 UI 传入） */
  userConfirmed: boolean;
  /** 工作区根目录，文件类工具必须限制在此目录内 */
  workspaceRoot: string | null;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  /** 便于 UI 展示的简短说明 */
  summary?: string;
}

export interface ToolDefinition<A = Record<string, unknown>> {
  name: string;
  description: string;
  /** 危险操作需要用户显式确认 */
  dangerous: boolean;
  /** 权限范围声明，安装/调用时展示 */
  permission: string;
  /** 极简 JSON Schema（避免引入 zod-to-json-schema 依赖） */
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}
