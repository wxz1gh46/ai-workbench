import type {
  AdvanceGoalResponse,
  AuditReport,
  ClusterConfig,
  CompactResult,
  ContextBundle,
  ContextSummaryResponse,
  CreateResearchResponse,
  GoalRun,
  OfficeDocumentInfo,
  OfficeOperationResponse,
  OfficePreview,
  ProgressTree,
  ResearchJob,
  ResearchJobResponse,
  ResearchReport,
  RunGoalResponse,
  TaskBoard,
  TaskBoardCard,
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


  listFiles: (workspaceId: string) =>
    request<{ files: { id: string; path: string; name: string; ext: string; size: number; version: number; mime: string }[] }>(
      `/files?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),

  listAudit: (workspaceId: string) => request<{ logs: AuditLog[] }>(`/audit?workspaceId=${encodeURIComponent(workspaceId)}`),

  /* ---------------------- Phase 2：分层上下文 ---------------------- */

  contextSummary: (conversationId: string) => request<ContextSummaryResponse>(`/context/${encodeURIComponent(conversationId)}/summary`),
  compactContext: (conversationId: string, workspaceId: string, body: { force?: boolean; keepRecent?: number } = {}) =>
    request<CompactResult>(`/context/${encodeURIComponent(conversationId)}/compact`, {
      method: 'POST',
      headers: { 'x-workspace-id': workspaceId },
      body: JSON.stringify(body),
    }),
  contextPreview: (conversationId: string, q: string, files: string[] = []) =>
    request<ContextBundle>(
      `/conversations/${encodeURIComponent(conversationId)}/context-preview?q=${encodeURIComponent(q)}${files.length ? `&files=${encodeURIComponent(files.join(','))}` : ''}`,
    ),

  /* ------------------------ Phase 2：目标模式 ----------------------- */

  createGoalV2: (workspaceId: string, objective: string, autoRun = false, maxIterations?: number) =>
    request<{ goal: Goal; tasks: Task[] }>('/goals', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, objective, autoRun, ...(maxIterations === undefined ? {} : { maxIterations }) }),
    }),
  getGoalV2: (id: string) => request<{ goal: Goal; tasks: Task[] }>(`/goals/${id}`),
  runGoalV2: (id: string, mode?: ClusterConfig['mode']) =>
    request<RunGoalResponse>(`/goals/${id}/run`, { method: 'POST', body: JSON.stringify(mode ? { mode } : {}) }),
  cancelGoal: (id: string) => request<{ goal: Goal }>(`/goals/${id}/cancel`, { method: 'POST', body: '{}' }),
  goalProgress: (id: string) => request<ProgressTree>(`/goals/${id}/progress`),
  goalAudit: (id: string) => request<{ audit: AuditReport | null; markdown: string | null }>(`/goals/${id}/audit`),
  goalRuns: (id: string) => request<{ runs: GoalRun[] }>(`/goals/${id}/runs`),
  goalBoard: (id: string) => request<{ board: TaskBoard }>(`/goals/${id}/board`),
  goalMessages: (id: string) => request<{ messages: { id: string; kind: string; content: string; fromAgentId: string; createdAt: string }[] }>(`/goals/${id}/messages`),
  assignTask: (taskId: string, agentId: string, preempt = false) =>
    request<{ task: Task }>(`/tasks/${taskId}/assign`, { method: 'POST', body: JSON.stringify({ agentId, preempt }) }),
  sendAgentMessage: (agentId: string, goalId: string, content: string, kind = 'direct') =>
    request<{ message: { id: string } }>(`/agents/${agentId}/message`, { method: 'POST', body: JSON.stringify({ goalId, content, kind }) }),

  /* ------------------------ Phase 2：集群配置 ----------------------- */

  getCluster: (workspaceId: string) => request<{ config: ClusterConfig }>(`/cluster?workspaceId=${encodeURIComponent(workspaceId)}`),
  setCluster: (workspaceId: string, patch: { mode?: ClusterConfig['mode']; maxParallel?: number; experimental?: boolean }) =>
    request<{ config: ClusterConfig }>('/cluster', { method: 'PATCH', body: JSON.stringify({ workspaceId, ...patch }) }),
  listAgentsV2: (workspaceId: string) => request<{ agents: Agent[] }>(`/agents?workspaceId=${encodeURIComponent(workspaceId)}`),
  agentRuns: (agentId: string, limit = 50) => request<{ runs: unknown[] }>(`/agents/${agentId}/runs?limit=${limit}`),

  /* ------------------------- Phase 2：Office ------------------------ */

  officeStatus: () => request<{ available: boolean; hint: string }>('/office/status'),
  officeRead: (workspaceId: string, path: string) =>
    request<OfficeDocumentInfo & { warnings: string[]; truncated: boolean }>('/office/read', { method: 'POST', body: JSON.stringify({ workspaceId, path }) }),
  officePreview: (workspaceId: string, path: string) =>
    request<OfficePreview>('/office/preview', { method: 'POST', body: JSON.stringify({ workspaceId, path }) }),
  officeEdit: (workspaceId: string, path: string, operations: unknown[], backup = true) =>
    request<OfficeOperationResponse>('/office/edit', { method: 'POST', body: JSON.stringify({ workspaceId, path, operations, backup }) }),
  officeConvert: (workspaceId: string, path: string, target: string, outputPath?: string) =>
    request<{ path: string; degraded: boolean; warnings: string[]; version: number }>('/office/convert', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, path, target, ...(outputPath ? { outputPath } : {}) }),
    }),
  officeExport: (workspaceId: string, path: string, ttlHours = 168) =>
    request<{ id: string; url: string | null; size: number; expiresAt: string | null }>('/office/export', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, path, ttlHours }),
    }),
  fileVersions: (fileId: string) =>
    request<{ fileId: string; current: number; path: string; versions: { id: string; version: number; size: number; note: string; createdAt: string }[] }>(
      `/files/${encodeURIComponent(fileId)}/versions`,
    ),
  restoreFile: (fileId: string, version: number) =>
    request<{ fileId: string; version: number; restoredFrom: number; restoredToWorkspace: boolean }>(`/files/${encodeURIComponent(fileId)}/restore`, {
      method: 'POST',
      body: JSON.stringify({ version }),
    }),

  /* ------------------------ Phase 2：深度研究 ----------------------- */

  researchCapability: () => request<{ network: boolean; hint: string; maxSources: number }>('/research/capability'),
  listResearch: (workspaceId: string) => request<{ jobs: ResearchJob[] }>(`/research?workspaceId=${encodeURIComponent(workspaceId)}`),
  createResearch: (input: { workspaceId: string; topic: string; depth?: string; allowNetwork?: boolean; outputFormats?: string[]; maxSources?: number }) =>
    request<CreateResearchResponse>('/research', { method: 'POST', body: JSON.stringify(input) }),
  getResearch: (id: string) => request<ResearchJobResponse>(`/research/${id}`),
  getResearchReport: (id: string) => request<{ job: ResearchJob; report: ResearchReport }>(`/research/${id}/report`),
  publishResearch: (id: string, isPublic = false) =>
    request<{ webUrl: string; reportId: string }>(`/research/${id}/publish`, { method: 'POST', body: JSON.stringify({ public: isPublic }) }),
  cancelResearch: (id: string) => request<{ job: ResearchJob }>(`/research/${id}/cancel`, { method: 'POST', body: '{}' }),
  researchExportUrl: (id: string) => `${BASE}/research/${encodeURIComponent(id)}/export`,
};

export type { TaskBoardCard };
