import type {
  AdvanceGoalResponse,
  Agent,
  Artifact,
  AuditLog,
  CreateGoalResponse,
  Goal,
  Message,
  PromptSections,
  Schedule,
  Task,
  Widget,
  Workspace,
  ApiResponse,
} from '@ai/shared';

/**
 * API 客户端。
 * 统一处理 ApiResponse 包装：失败抛 ApiError，调用方只关心业务数据。
 * 开发态走 vite proxy /api；Tauri 打包后指向本地 sidecar 同一地址。
 */
const BASE = import.meta.env.VITE_API_BASE ?? '/api';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly traceId: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  let body: ApiResponse<T>;
  try {
    body = (await res.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError('INTERNAL', `服务响应不是合法 JSON（HTTP ${res.status}）`, 'n/a');
  }
  if (!body.ok) throw new ApiError(body.error.code, body.error.message, body.error.traceId);
  return body.data;
}

export const api = {
  health: () => request<{ status: string; degraded: boolean; features: Record<string, boolean> }>('/health'),

  bootstrap: () => request<{ workspace: Workspace }>('/workspaces/bootstrap', { method: 'POST', body: '{}' }),
  setWorkspaceRoot: (id: string, rootPath: string | null) =>
    request<{ workspace: Workspace }>(`/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify({ rootPath }) }),
  listAgents: (workspaceId: string) => request<{ agents: Agent[] }>(`/workspaces/${workspaceId}/agents`),

  listMessages: (conversationId: string) => request<{ messages: Message[] }>(`/conversations/${conversationId}/messages`),
  sendMessage: (conversationId: string, content: string) =>
    request<{ userMessage: Message; assistantMessage: Message; citations: string[]; degraded: boolean }>(
      `/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify({ conversationId, content }) },
    ),

  createGoal: (workspaceId: string, objective: string, autoRun = false) =>
    request<CreateGoalResponse>('/agent/goal', { method: 'POST', body: JSON.stringify({ workspaceId, objective, autoRun }) }),
  listGoals: (workspaceId: string) => request<{ goals: Goal[] }>(`/agent/goals?workspaceId=${encodeURIComponent(workspaceId)}`),
  getGoal: (id: string) => request<{ goal: Goal; tasks: Task[] }>(`/agent/goals/${id}`),
  advanceGoal: (id: string) => request<AdvanceGoalResponse>(`/agent/goals/${id}/advance`, { method: 'POST', body: '{}' }),
  runGoal: (id: string) => request<AdvanceGoalResponse>(`/agent/goals/${id}/run`, { method: 'POST', body: '{}' }),
  cancelTask: (id: string) => request<{ task: Task }>(`/agent/tasks/${id}/cancel`, { method: 'POST', body: '{}' }),
  listRuns: (goalId: string) => request<{ runs: unknown[] }>(`/agent/runs?goalId=${encodeURIComponent(goalId)}`),

  generateOffice: (input: { workspaceId: string; format: string; title: string; content: string }) =>
    request<{ artifact: Artifact; path: string }>('/office/generate', { method: 'POST', body: JSON.stringify(input) }),

  listSchedules: (workspaceId: string) => request<{ schedules: Schedule[] }>(`/schedule?workspaceId=${encodeURIComponent(workspaceId)}`),
  createSchedule: (input: Record<string, unknown>) => request<{ schedule: Schedule }>('/schedule', { method: 'POST', body: JSON.stringify(input) }),

  listPlugins: (workspaceId: string) =>
    request<{ installed: unknown[]; catalog: { name: string; version: string; requiresUserAuth: boolean; permissions: { scope: string; description: string; sensitive: boolean }[]; secretRefs: string[] }[] }>(
      `/plugins?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  installPlugin: (name: string, workspaceId: string) =>
    request<{ plugin: { id: string; requiresUserAuth: boolean } }>(`/plugins/${name}/install`, { method: 'POST', body: JSON.stringify({ workspaceId }) }),

  optimizePrompt: (workspaceId: string, intent: string) =>
    request<{ sections: PromptSections; rendered: string; variables: string[]; notes: string[] }>('/prompt/optimize', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, intent }),
    }),

  listWidgets: (workspaceId: string) => request<{ widgets: Widget[] }>(`/widgets?workspaceId=${encodeURIComponent(workspaceId)}`),
  createWidget: (workspaceId: string, naturalLanguage: string) =>
    request<{ widget: Widget }>('/widgets', { method: 'POST', body: JSON.stringify({ workspaceId, naturalLanguage }) }),
  moveWidget: (id: string, layout: { x: number; y: number; w: number; h: number }) =>
    request<{ updated: boolean }>(`/widgets/${id}`, { method: 'PATCH', body: JSON.stringify({ layout }) }),
  removeWidget: (id: string) => request<{ removed: boolean }>(`/widgets/${id}`, { method: 'DELETE' }),

  listAudit: (workspaceId: string) => request<{ logs: AuditLog[] }>(`/audit?workspaceId=${encodeURIComponent(workspaceId)}`),
};
