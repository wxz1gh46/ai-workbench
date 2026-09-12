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
  /* Phase 3 */
  WebsiteProject,
  WebsitePlan,
  WebsiteDeployment,
  ProviderCapability,
  DatabaseConnectionInfo,
  DatabaseSchemaSnapshot,
  DatabaseMigration,
  QueryResult,
  Dashboard,
  WidgetInstance,
  WidgetSpec,
  WidgetRenderData,
  ScheduleTask,
  ScheduleRunRecord,
  NotifyChannel,
  NotifyLogRecord,
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

  /* ================================================================== */
  /* Phase 3：部署中心                                                   */
  /* ================================================================== */

  deployCapabilities: () =>
    request<{ providers: ProviderCapability[]; danger: { action: string; summary: string; level: string }[] }>('/deploy/capabilities'),
  testDeployProviders: () =>
    request<{ results: { provider: string; configured: boolean; message: string }[] }>('/deploy/providers/test'),

  listWebsites: (workspaceId: string) =>
    request<{ projects: WebsiteProject[] }>(`/websites?workspaceId=${encodeURIComponent(workspaceId)}`),
  createWebsite: (input: { workspaceId: string; name: string; description?: string; requirement?: string; databaseConnectionId?: string | null }) =>
    request<{ project: WebsiteProject }>('/websites', { method: 'POST', body: JSON.stringify(input) }),
  getWebsite: (id: string) =>
    request<{
      project: WebsiteProject;
      deployments: WebsiteDeployment[];
      access: { id: string; type: string; value: string }[];
      envVars: { key: string; masked: string; updatedAt: string }[];
      files: { path: string; bytes: number }[];
      previewCommand: string;
    }>(`/websites/${encodeURIComponent(id)}`),
  updateWebsite: (id: string, patch: { name?: string; description?: string }) =>
    request<{ project: WebsiteProject }>(`/websites/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  generateWebsite: (id: string, requirement?: string) =>
    request<{ project: WebsiteProject; plan: WebsitePlan; files: { path: string; bytes: number }[]; previewCommand: string; rootDir: string }>(
      `/websites/${encodeURIComponent(id)}/generate`,
      { method: 'POST', body: JSON.stringify(requirement ? { requirement } : {}) },
    ),
  buildWebsite: (id: string) =>
    request<{ ok: boolean; version: number; checks: { name: string; ok: boolean; detail: string }[]; files: number; bytes: number }>(
      `/websites/${encodeURIComponent(id)}/build`,
      { method: 'POST', body: '{}' },
    ),
  deployWebsite: (id: string, provider: string) =>
    request<{ deployment: WebsiteDeployment; degraded: boolean; accessPolicy: { mode: string; note: string } }>(
      `/websites/${encodeURIComponent(id)}/deploy`,
      { method: 'POST', body: JSON.stringify({ provider, confirm: true }) },
    ),
  listDeployments: (id: string) =>
    request<{ deployments: WebsiteDeployment[] }>(`/websites/${encodeURIComponent(id)}/deployments`),
  deployLogs: (deploymentId: string) =>
    request<{ lines: { at: string; level: string; msg: string }[]; live: boolean }>(`/deployments/${encodeURIComponent(deploymentId)}/logs`),
  rollbackWebsite: (id: string, deploymentId: string) =>
    request<{ deployment: WebsiteDeployment }>(`/websites/${encodeURIComponent(id)}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ deploymentId, confirm: true }),
    }),
  deleteDeployment: (id: string, deploymentId: string) =>
    request<{ ok: boolean; message: string; degraded: boolean }>(
      `/websites/${encodeURIComponent(id)}/deployments/${encodeURIComponent(deploymentId)}?confirm=true`,
      { method: 'DELETE' },
    ),
  deleteWebsite: (id: string) =>
    request<{ ok: boolean; deployments: number }>(`/websites/${encodeURIComponent(id)}?confirm=true`, { method: 'DELETE' }),
  bindDomain: (id: string, domain: string, provider?: string) =>
    request<{ binding: { domain: string; status: string; message: string; dns: { type: string; name: string; value: string }[]; https: string } }>(
      `/websites/${encodeURIComponent(id)}/domain`,
      { method: 'POST', body: JSON.stringify({ domain, provider, confirm: true }) },
    ),
  setWebsiteAccess: (id: string, rules: { type: string; value: string }[]) =>
    request<{ count: number; types: string[] }>(`/websites/${encodeURIComponent(id)}/access`, {
      method: 'POST',
      body: JSON.stringify({ rules, confirm: true }),
    }),
  getWebsiteEnv: (id: string) =>
    request<{ vars: { key: string; masked: string; secretRef: string; updatedAt: string }[] }>(`/websites/${encodeURIComponent(id)}/env`),
  setWebsiteEnv: (id: string, vars: { key: string; value: string }[]) =>
    request<{ keys: string[]; replaced: string[] }>(`/websites/${encodeURIComponent(id)}/env`, {
      method: 'POST',
      body: JSON.stringify({ vars, confirm: true }),
    }),
  removeWebsiteEnv: (id: string, key: string) =>
    request<{ ok: boolean }>(`/websites/${encodeURIComponent(id)}/env/${encodeURIComponent(key)}?confirm=true`, { method: 'DELETE' }),

  /* ================================================================== */
  /* Phase 3：数据库面板                                                 */
  /* ================================================================== */

  dbProviders: () =>
    request<{ providers: { provider: string; label: string; needs: string[]; docs: string }[] }>('/databases/providers'),
  listDatabases: (workspaceId: string) =>
    request<{ connections: DatabaseConnectionInfo[] }>(`/databases?workspaceId=${encodeURIComponent(workspaceId)}`),
  createDatabase: (input: { workspaceId: string; provider: string; name: string; connectionString: string; branch?: string; note?: string }) =>
    request<{ connection: DatabaseConnectionInfo }>('/databases', { method: 'POST', body: JSON.stringify(input) }),
  getDatabase: (id: string, workspaceId: string) =>
    request<{ connection: DatabaseConnectionInfo; migrations: DatabaseMigration[]; backups: { id: string; createdAt: string; format: string; bytes: number; tables: number }[] }>(
      `/databases/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  testDatabase: (id: string, workspaceId: string) =>
    request<{ ok: boolean; degraded: boolean; message: string; serverVersion?: string; latencyMs?: number }>(
      `/databases/${encodeURIComponent(id)}/test?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: JSON.stringify({ workspaceId }) },
    ),
  deleteDatabase: (id: string, workspaceId: string) =>
    request<{ ok: boolean }>(`/databases/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}&confirm=true`, { method: 'DELETE' }),
  generateDbSchema: (id: string, workspaceId: string, websiteProjectId: string) =>
    request<{ snapshot: DatabaseSchemaSnapshot; up: string; down: string; version: number }>(
      `/databases/${encodeURIComponent(id)}/schema?workspaceId=${encodeURIComponent(workspaceId)}&websiteProjectId=${encodeURIComponent(websiteProjectId)}`,
      { method: 'POST', body: '{}' },
    ),
  introspectDb: (id: string, workspaceId: string) =>
    request<{ schema: DatabaseSchemaSnapshot }>(
      `/databases/${encodeURIComponent(id)}/schema?workspaceId=${encodeURIComponent(workspaceId)}&introspect=true`,
    ),
  applyMigration: (id: string, workspaceId: string, migrationId: string) =>
    request<{ ok: boolean; message: string }>(`/databases/${encodeURIComponent(id)}/migrate?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST',
      body: JSON.stringify({ migrationId, confirm: true }),
    }),
  rollbackMigration: (id: string, workspaceId: string, migrationId: string) =>
    request<{ ok: boolean; message: string }>(`/databases/${encodeURIComponent(id)}/migrate/rollback?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST',
      body: JSON.stringify({ migrationId, confirm: true }),
    }),
  runDbQuery: (id: string, workspaceId: string, sql: string, opts: { readOnly?: boolean; limit?: number; confirm?: boolean } = {}) =>
    request<QueryResult | { preflight: { safe: boolean; isWrite: boolean; needConfirm: boolean; reason?: string } }>(
      `/databases/${encodeURIComponent(id)}/query?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: JSON.stringify({ sql, readOnly: opts.readOnly ?? true, limit: opts.limit, confirm: opts.confirm }) },
    ),
  backupDatabase: (id: string, workspaceId: string) =>
    request<{ id: string; createdAt: string; format: string; bytes: number; tables: number; sha256: string; preview: string }>(
      `/databases/${encodeURIComponent(id)}/backup?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: JSON.stringify({ workspaceId, confirm: true }) },
    ),

  /* ================================================================== */
  /* Phase 3：看板编辑器                                                 */
  /* ================================================================== */

  widgetRegistry: () => request<{ widgets: WidgetSpec[] }>('/dashboard/registry'),
  listDashboards: (workspaceId: string) =>
    request<{ dashboards: Dashboard[] }>(`/dashboards?workspaceId=${encodeURIComponent(workspaceId)}`),
  createDashboard: (input: { workspaceId: string; name: string; description?: string }) =>
    request<{ dashboard: Dashboard }>('/dashboards', { method: 'POST', body: JSON.stringify(input) }),
  getDashboardV3: (id: string, workspaceId: string) =>
    request<{ dashboard: Dashboard; widgets: WidgetInstance[]; data: WidgetRenderData[] }>(
      `/dashboards/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  deleteDashboard: (id: string, workspaceId: string) =>
    request<{ ok: boolean; widgetsRemoved: number }>(`/dashboards/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}&confirm=true`, {
      method: 'DELETE',
    }),
  saveDashboardLayout: (id: string, workspaceId: string, items: { id: string; x: number; y: number; w: number; h: number }[]) =>
    request<{ dashboard: Dashboard; widgets: WidgetInstance[] }>(`/dashboards/${encodeURIComponent(id)}/layout?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),
  rollbackDashboardLayout: (id: string, workspaceId: string) =>
    request<{ dashboard: Dashboard; widgets: WidgetInstance[] }>(
      `/dashboards/${encodeURIComponent(id)}/layout/rollback?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: '{}' },
    ),
  refreshDashboard: (id: string, workspaceId: string) =>
    request<{ results: WidgetRenderData[]; degraded: number }>(`/dashboards/${encodeURIComponent(id)}/refresh?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST',
      body: '{}',
    }),
  createWidgetV3: (
    dashboardId: string,
    workspaceId: string,
    input: { naturalLanguage?: string; type?: string; title?: string; config?: Record<string, unknown>; layout?: { x: number; y: number; w: number; h: number } },
  ) =>
    request<{ widget: WidgetInstance; inference?: { type: string; confidence: number; degraded: boolean } }>(
      `/dashboards/${encodeURIComponent(dashboardId)}/widgets?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  updateWidgetV3: (id: string, workspaceId: string, patch: Record<string, unknown>) =>
    request<{ widget: WidgetInstance }>(`/widgets/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteWidgetV3: (id: string, workspaceId: string) =>
    request<{ removed: boolean }>(`/widgets/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' }),
  refreshWidgetV3: (id: string, workspaceId: string) =>
    request<WidgetRenderData>(`/widgets/${encodeURIComponent(id)}/refresh?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'POST', body: '{}' }),
  pinWidget: (id: string, workspaceId: string, pinned: boolean) =>
    request<{ widget: WidgetInstance }>(`/widgets/${encodeURIComponent(id)}/pin?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST',
      body: JSON.stringify({ pinned }),
    }),
  listPinnedWidgets: (workspaceId: string) =>
    request<{ widgets: WidgetInstance[] }>(`/widgets?workspaceId=${encodeURIComponent(workspaceId)}&pinned=true`),

  /* ================================================================== */
  /* Phase 3：定时任务管理                                               */
  /* ================================================================== */

  scheduleTemplates: () =>
    request<{
      templates: { name: string; label: string; description: string; taskType: string; suggestedCron: string; placeholders: { key: string; label: string; example: string; required: boolean }[]; dangerous: boolean }[];
      presets: { label: string; expression: string; note: string }[];
    }>('/schedule/templates'),
  previewCron: (expression: string, timezone: string) =>
    request<{ ok: boolean; error?: string; description?: string; next: string[] }>('/schedule/preview', {
      method: 'POST',
      body: JSON.stringify({ expression, timezone }),
    }),
  listSchedulesV3: (workspaceId: string) =>
    request<{ schedules: ScheduleTask[] }>(`/schedules?workspaceId=${encodeURIComponent(workspaceId)}`),
  createScheduleV3: (input: {
    workspaceId: string;
    name: string;
    trigger: string;
    expression: string;
    timezone?: string;
    taskType?: string;
    taskConfig?: Record<string, unknown>;
    template?: string;
    templateValues?: Record<string, string>;
    channelIds?: string[];
    enabled?: boolean;
  }) => request<{ schedule: ScheduleTask }>('/schedules', { method: 'POST', body: JSON.stringify(input) }),
  getScheduleV3: (id: string, workspaceId: string) =>
    request<{ schedule: ScheduleTask; runs: ScheduleRunRecord[]; stats: { total: number; succeeded: number; failed: number; successRate: number; avgDurationMs: number }; timeline: { at: string; status: string; label: string; ok: boolean }[] }>(
      `/schedules/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  updateScheduleV3: (id: string, workspaceId: string, patch: Record<string, unknown>) =>
    request<{ schedule: ScheduleTask }>(`/schedules/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteScheduleV3: (id: string, workspaceId: string) =>
    request<{ ok: boolean }>(`/schedules/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}&confirm=true`, { method: 'DELETE' }),
  runScheduleNow: (id: string, workspaceId: string) =>
    request<{ run: ScheduleRunRecord }>(`/schedules/${encodeURIComponent(id)}/run?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    }),
  listScheduleRunsV3: (id: string, workspaceId: string) =>
    request<{ runs: ScheduleRunRecord[]; stats: { total: number; succeeded: number; failed: number; successRate: number; avgDurationMs: number }; timeline: { at: string; status: string; label: string; ok: boolean }[] }>(
      `/schedules/${encodeURIComponent(id)}/runs?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),

  /* ================================================================== */
  /* Phase 3：通知设置                                                   */
  /* ================================================================== */

  notifyCatalog: () =>
    request<{ channels: { type: string; label: string; secretFields: { key: string; label: string; required: boolean; hint?: string }[]; configFields: { key: string; label: string; required: boolean; type: string; hint?: string }[] }[] }>(
      '/notify/catalog',
    ),
  listNotifyChannels: (workspaceId: string) =>
    request<{ channels: NotifyChannel[] }>(`/notify/channels?workspaceId=${encodeURIComponent(workspaceId)}`),
  createNotifyChannel: (input: { workspaceId: string; type: string; name: string; config?: Record<string, unknown>; secret?: Record<string, unknown>; enabled?: boolean }) =>
    request<{ channel: NotifyChannel }>('/notify/channels', { method: 'POST', body: JSON.stringify(input) }),
  updateNotifyChannel: (id: string, workspaceId: string, patch: Record<string, unknown>) =>
    request<{ channel: NotifyChannel }>(`/notify/channels/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteNotifyChannel: (id: string, workspaceId: string) =>
    request<{ removed: boolean }>(`/notify/channels/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}&confirm=true`, { method: 'DELETE' }),
  testNotifyChannel: (channelId: string, workspaceId: string) =>
    request<{ ok: boolean; message: string; degraded: boolean }>(`/notify/test?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST',
      body: JSON.stringify({ channelId }),
    }),
  listNotifyLogs: (workspaceId: string, limit = 100, channelId?: string) =>
    request<{ logs: NotifyLogRecord[] }>(
      `/notify/logs?workspaceId=${encodeURIComponent(workspaceId)}&limit=${limit}${channelId ? `&channelId=${encodeURIComponent(channelId)}` : ''}`,
    ),
};

export type { TaskBoardCard };
