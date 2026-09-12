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
  /* Phase 4 */
  PluginManifestV4,
  PluginInstallationInfo,
  PluginInvokeResult,
  McpServerRecord,
  McpToolRecord,
  PaidDataProviderSpec,
  PaidDataCredentialInfo,
  PaidDataQueryRecord,
  PaidDataQueryResult,
  PaidDataCitation,
  PromptVariableSpec,
  PromptABTestInfo,
  PromptABTestReport,
  PromptEvaluationInfo,
  PromptOptimizeReport,
  ClusterNodeInfo,
  ClusterStatus,
  ClusterPolicyInfo,
  ClusterTaskInfo,
  ClusterShardInfo,
  ElectionRecord,
  AgentPoolInfo,
  AgentRouteInfo,
  AggregatedResultInfo,
  CostRecordInfo,
  CostSummary,
  RoleInfo,
  UserRoleInfo,
  SsoConfigInfo,
  AuditExportInfo,
  DataMaskRuleInfo,
  RetentionPolicyInfo,
  RetentionRunResult,
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

  /* ================================================================== */
  /* Phase 4：插件系统与 MCP                                             */
  /* ================================================================== */

  pluginMarket: (params: { q?: string; kind?: string; requiresAuth?: boolean } = {}) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.kind) qs.set('kind', params.kind);
    if (params.requiresAuth !== undefined) qs.set('requiresAuth', String(params.requiresAuth));
    return request<{ catalog: PluginManifestV4[]; kinds: string[] }>(`/plugins/market?${qs.toString()}`);
  },
  pluginDetail: (name: string) =>
    request<{ manifest: PluginManifestV4; signature: { signed: boolean; ok: boolean; hash: string }; marketSize: number }>(
      `/plugins/market/${encodeURIComponent(name)}`,
    ),
  listInstalledPlugins: (workspaceId: string) =>
    request<{ plugins: PluginInstallationInfo[] }>(`/plugins/installed?workspaceId=${encodeURIComponent(workspaceId)}`),
  installPluginV4: (name: string, workspaceId: string) =>
    request<PluginInstallationInfo & { installationId: string; pluginId: string }>(
      `/plugins/install?name=${encodeURIComponent(name)}&confirm=true`,
      { method: 'POST', body: JSON.stringify({ workspaceId }) },
    ),
  uninstallPluginV4: (pluginId: string, workspaceId: string) =>
    request<{ removed: string; name: string }>(`/plugins/${encodeURIComponent(pluginId)}/uninstall?confirm=true`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId }),
    }),
  updatePluginV4: (pluginId: string, workspaceId: string) =>
    request<PluginInstallationInfo & { previousVersion: string; updated: boolean; latest: string }>(
      `/plugins/${encodeURIComponent(pluginId)}/update`,
      { method: 'POST', body: JSON.stringify({ workspaceId }) },
    ),
  pluginPermissions: (pluginId: string, workspaceId: string) =>
    request<{
      installationId: string;
      permissions: (PluginInstallationInfo['permissions'][number])[];
      grantedScopes: string[];
      requiresUserAuth: boolean;
      secretRefs: string[];
    }>(`/plugins/${encodeURIComponent(pluginId)}/permissions?workspaceId=${encodeURIComponent(workspaceId)}`),
  grantPlugin: (installationId: string, workspaceId: string, scopes: string[], expiresAt?: string | null) =>
    request<{ granted: string[]; grantedScopes: string[] }>(`/plugins/${encodeURIComponent(installationId)}/grant`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId, scopes, expiresAt: expiresAt ?? null }),
    }),
  revokePlugin: (installationId: string, workspaceId: string, scopes?: string[]) =>
    request<{ revoked: string[]; grantedScopes: string[] }>(
      `/plugins/${encodeURIComponent(installationId)}/revoke?confirm=true`,
      { method: 'POST', body: JSON.stringify({ workspaceId, ...(scopes ? { scopes } : {}) }) },
    ),
  invokePlugin: (installationId: string, workspaceId: string, tool: string, args: Record<string, unknown> = {}, confirm = false) =>
    request<PluginInvokeResult>(`/plugins/${encodeURIComponent(installationId)}/invoke`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId, tool, args, confirm }),
    }),
  pluginCalls: (installationId: string, workspaceId: string, limit = 100) =>
    request<{ calls: { id: string; tool: string; args: Record<string, unknown>; ok: boolean; durationMs: number; error: string | null; createdAt: string }[] }>(
      `/plugins/${encodeURIComponent(installationId)}/calls?workspaceId=${encodeURIComponent(workspaceId)}&limit=${limit}`,
    ),
  listMcpServers: (workspaceId: string) =>
    request<{ servers: McpServerRecord[]; transports: string[] }>(`/mcp/servers?workspaceId=${encodeURIComponent(workspaceId)}`),
  registerMcpServer: (input: {
    workspaceId: string;
    name: string;
    transport?: string;
    endpoint?: string;
    command?: string;
    args?: string[];
    secretRefs?: string[];
  }) => request<{ server: McpServerRecord }>('/mcp/servers?confirm=true', { method: 'POST', body: JSON.stringify(input) }),
  removeMcpServer: (id: string, workspaceId: string) =>
    request<{ removed: string }>(`/mcp/servers/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}&confirm=true`, {
      method: 'DELETE',
    }),
  syncMcpServer: (id: string, workspaceId: string) =>
    request<{ synced: number; degraded: boolean; note?: string; tools: McpToolRecord[] }>(
      `/mcp/servers/${encodeURIComponent(id)}/sync?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: '{}' },
    ),
  mcpTools: (id: string, workspaceId: string) =>
    request<{ tools: McpToolRecord[] }>(`/mcp/servers/${encodeURIComponent(id)}/tools?workspaceId=${encodeURIComponent(workspaceId)}`),

  /* ================================================================== */
  /* Phase 4：付费数据库                                                 */
  /* ================================================================== */

  paidProviders: (workspaceId?: string) =>
    request<{ providers: PaidDataProviderSpec[]; disclaimer?: string }>(
      `/paid-data/providers${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`,
    ),
  listPaidCredentials: (workspaceId: string) =>
    request<{ credentials: PaidDataCredentialInfo[]; requiredFields: Record<string, string[]> }>(
      `/paid-data/credentials?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  savePaidCredential: (providerId: string, workspaceId: string, credentials: Record<string, string>, replace = false) =>
    request<{ providerId: string; status: string; fieldNames: string[]; requiredMissing: string[]; masked: Record<string, string> }>(
      `/paid-data/credentials?providerId=${encodeURIComponent(providerId)}&confirm=true`,
      { method: 'POST', body: JSON.stringify({ workspaceId, credentials, replace }) },
    ),
  removePaidCredential: (providerId: string, workspaceId: string) =>
    request<{ removed: string }>(
      `/paid-data/credentials/${encodeURIComponent(providerId)}?workspaceId=${encodeURIComponent(workspaceId)}&confirm=true`,
      { method: 'DELETE' },
    ),
  paidPreflight: (input: { workspaceId: string; providerId: string; action: string; params?: Record<string, unknown> }) =>
    request<{ allowed: boolean; reason?: string; code?: string; accessMethods: string[]; rateLimit: { perMinute: number; note: string } }>(
      '/paid-data/preflight',
      { method: 'POST', body: JSON.stringify(input) },
    ),
  paidQuery: (input: { workspaceId: string; providerId: string; action: string; params?: Record<string, unknown>; noCache?: boolean; purpose?: string }) =>
    request<PaidDataQueryResult & { queryId: string; providerId: string; action: string; status: string; data: unknown; citations: PaidDataCitation[]; cached: boolean; degraded: boolean; note?: string; blockedReason?: string; rowCount: number; durationMs: number }>(
      '/paid-data/query?confirm=true',
      { method: 'POST', body: JSON.stringify(input) },
    ),
  listPaidQueries: (workspaceId: string, limit = 50) =>
    request<{ queries: PaidDataQueryRecord[] }>(`/paid-data/queries?workspaceId=${encodeURIComponent(workspaceId)}&limit=${limit}`),
  getPaidQuery: (id: string, workspaceId: string) =>
    request<{ query: PaidDataQueryRecord; result: { data: unknown; citations: PaidDataCitation[] } | null }>(
      `/paid-data/queries/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),

  /* ================================================================== */
  /* Phase 4：提示词工作台                                               */
  /* ================================================================== */

  promptLibrary: () =>
    request<{ templates: { key: string; name: string; description: string; tags: string[]; sections: PromptSections; variables: PromptVariableSpec[]; filledSections: number }[] }>(
      '/prompts/library',
    ),
  useLibraryTemplate: (key: string, workspaceId: string, name?: string) =>
    request<{ templateId: string; name: string; version: number; sections: PromptSections; variables: PromptVariableSpec[] }>(
      `/prompts/library/${encodeURIComponent(key)}`,
      { method: 'POST', body: JSON.stringify({ workspaceId, ...(name ? { name } : {}) }) },
    ),
  promptMetrics: () =>
    request<{ metrics: { manual: { metric: string; label: string; range: [number, number] }[]; auto: { metric: string; label: string; range: [number, number] }[] } }>('/prompts/catalog'),
  listPromptsV4: (workspaceId: string) =>
    request<{ templates: { name: string; latestId: string; version: number; versions: number[]; sections: PromptSections; variables: string[]; tags: string[]; updatedAt: string; score: number }[] }>(
      `/prompts/v4?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  getPromptV4: (name: string, workspaceId: string, version?: number) =>
    request<{
      name: string;
      version: number;
      templateId: string;
      sections: PromptSections;
      variables: PromptVariableSpec[];
      history: { id: string; version: number; updatedAt: string; score: number }[];
      score: number;
      renders: { markdown: string; ok: boolean; missingRequired: string[] };
    }>(`/prompts/v4/${encodeURIComponent(name)}?workspaceId=${encodeURIComponent(workspaceId)}${version ? `&version=${version}` : ''}`),
  generatePromptV4: (input: { workspaceId: string; goal: string; context?: string; targetModel?: string; useModel?: boolean }) =>
    request<{ sections: PromptSections; rendered: string; variables: PromptVariableSpec[]; intent: string; notes: string[]; degraded: boolean }>(
      '/prompts/generate',
      { method: 'POST', body: JSON.stringify(input) },
    ),
  optimizePromptV4: (input: { workspaceId: string; current: Partial<PromptSections>; intent?: string; targetModel?: string; useModel?: boolean }) =>
    request<PromptOptimizeReport & { rendered: string }>('/prompts/optimize-v4', { method: 'POST', body: JSON.stringify(input) }),
  copyPrompt: (sections: Partial<PromptSections>, variables: Record<string, string> = {}, name = '提示词') =>
    request<{ markdown: string; rendered: string; missingRequired: string[]; unknownVariables: string[]; ok: boolean }>('/prompts/copy', {
      method: 'POST',
      body: JSON.stringify({ sections, variables, name }),
    }),
  savePromptV4: (input: { workspaceId: string; name: string; sections: Partial<PromptSections>; tags?: string[] }) =>
    request<{ templateId: string; name: string; version: number }>('/prompts/v4', { method: 'POST', body: JSON.stringify(input) }),
  rollbackPromptV4: (name: string, workspaceId: string, version: number) =>
    request<{ templateId: string; name: string; version: number }>(
      `/prompts/v4/${encodeURIComponent(name)}/rollback?confirm=true`,
      { method: 'POST', body: JSON.stringify({ workspaceId, version }) },
    ),
  createAbTest: (input: { workspaceId: string; templateName: string; versionA: number; versionB: number; name?: string }) =>
    request<{ id: string; templateName: string; versionA: number; versionB: number; status: string }>('/prompts/v4/abtest', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listAbTests: (workspaceId: string) => request<{ tests: PromptABTestInfo[] }>(`/prompts/abtests?workspaceId=${encodeURIComponent(workspaceId)}`),
  recordAbEvaluation: (id: string, input: { workspaceId: string; version: 'A' | 'B'; metric: string; value: number; sampleSize: number; note?: string }) =>
    request<PromptEvaluationInfo>(`/prompts/abtests/${encodeURIComponent(id)}/evaluate`, { method: 'POST', body: JSON.stringify(input) }),
  autoEvaluateAb: (id: string, workspaceId: string) =>
    request<{ abTestId: string; results: { version: string; metrics: { metric: string; value: number }[] }[] }>(
      `/prompts/abtests/${encodeURIComponent(id)}/auto-evaluate?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: '{}' },
    ),
  getAbTest: (id: string, workspaceId: string) =>
    request<PromptABTestReport>(`/prompts/abtests/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`),
  finishAbTest: (id: string, workspaceId: string) =>
    request<PromptABTestReport>(`/prompts/abtests/${encodeURIComponent(id)}/finish?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST',
      body: '{}',
    }),

  /* ================================================================== */
  /* Phase 4：集群视图                                                   */
  /* ================================================================== */

  clusterNodes: (workspaceId: string) =>
    request<{ nodes: (ClusterNodeInfo & { metrics: { cpu: number; memory: number; gpu: number; disk: number; network: number } | null })[]; policy: ClusterPolicyInfo }>(
      `/cluster/nodes?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  registerClusterNode: (input: { workspaceId: string; name: string; role?: string; host?: string; port?: number; resources?: Record<string, number>; labels?: Record<string, string> }) =>
    request<{ node: ClusterNodeInfo }>('/cluster/nodes', { method: 'POST', body: JSON.stringify(input) }),
  removeClusterNode: (id: string, workspaceId: string) =>
    request<{ removed: string; name: string }>(`/cluster/nodes/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}&confirm=true`, {
      method: 'DELETE',
    }),
  clusterHeartbeat: (id: string, metrics: { cpu?: number; memory?: number } = {}) =>
    request<{ node: ClusterNodeInfo }>(`/cluster/nodes/${encodeURIComponent(id)}/heartbeat`, { method: 'POST', body: JSON.stringify(metrics) }),
  clusterSweep: (workspaceId: string) =>
    request<{ offline: { id: string; name: string }[]; online: { id: string; name: string }[] }>(
      `/cluster/sweep?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: '{}' },
    ),
  clusterStatus: (workspaceId: string, mode = 'cluster') =>
    request<ClusterStatus>(`/cluster/status?workspaceId=${encodeURIComponent(workspaceId)}&mode=${mode}`),
  clusterHealth: () =>
    request<{ nodes: { id: string; name: string; role: string; status: string; lastHeartbeat: string | null; heartbeatMiss: number; metrics: { cpu: number; memory: number; gpu: number; disk: number; network: number } | null }[]; online: number; total: number }>(
      '/cluster/health',
    ),
  clusterElections: (workspaceId: string) =>
    request<{ elections: ElectionRecord[]; term: number }>(`/cluster/elections?workspaceId=${encodeURIComponent(workspaceId)}`),
  forceElection: (workspaceId: string) =>
    request<{ term: number; leaderNodeId: string; reason: string; changed: boolean }>(
      `/cluster/elections?workspaceId=${encodeURIComponent(workspaceId)}&confirm=true`,
      { method: 'POST', body: '{}' },
    ),
  clusterTasks: (workspaceId: string, limit = 100) =>
    request<{ tasks: ClusterTaskInfo[] }>(`/cluster/tasks?workspaceId=${encodeURIComponent(workspaceId)}&limit=${limit}`),
  distributeClusterTask: (input: { workspaceId: string; taskId: string; items: unknown[]; shardCount?: number; goalId?: string; labels?: Record<string, string>; need?: Record<string, number> }) =>
    request<{ assignments: { shardIndex: number; nodeId: string; nodeName: string; reason: string }[]; skipped: { shardIndex: number; reason: string }[] }>(
      '/cluster/tasks/distribute',
      { method: 'POST', body: JSON.stringify(input) },
    ),
  cancelClusterTask: (id: string, workspaceId: string) =>
    request<{ task: ClusterTaskInfo }>(`/cluster/tasks/${encodeURIComponent(id)}/cancel?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST',
      body: '{}',
    }),
  clusterPolicy: (workspaceId: string) =>
    request<{ policy: ClusterPolicyInfo }>(`/cluster/policy?workspaceId=${encodeURIComponent(workspaceId)}`),
  updateClusterPolicy: (workspaceId: string, patch: Partial<{ maxNodes: number; maxParallelTasks: number; fallbackEnabled: boolean; heartbeatTimeoutMs: number; resourceLimits: Record<string, number> }>) =>
    request<{ policy: ClusterPolicyInfo }>(`/cluster/policy?workspaceId=${encodeURIComponent(workspaceId)}&confirm=true`, {
      method: 'PATCH',
      body: JSON.stringify({ workspaceId, ...patch }),
    }),
  clusterBootstrap: (workspaceId: string) =>
    request<{ nodeId: string; elected: boolean; term: number }>('/cluster/bootstrap', { method: 'POST', body: JSON.stringify({ workspaceId }) }),

  /* ================================================================== */
  /* Phase 4：Agent 池 / 路由 / 成本                                     */
  /* ================================================================== */

  agentPools: (workspaceId: string) =>
    request<{ pools: (AgentPoolInfo & { busy: number; headroom: number })[] }>(`/agents/pool?workspaceId=${encodeURIComponent(workspaceId)}`),
  createAgentPool: (input: { workspaceId: string; name: string; role: string; minAgents?: number; maxAgents?: number; tools?: string[] }) =>
    request<{ pool: AgentPoolInfo }>('/agents/pool', { method: 'POST', body: JSON.stringify(input) }),
  scaleAgentPool: (role: string, workspaceId: string, target: number) =>
    request<{ pool: AgentPoolInfo; changed: number; reason: string }>(`/agents/pool/scale?role=${encodeURIComponent(role)}&confirm=true`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId, target }),
    }),
  agentRoutes: (params: { taskId?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.taskId) qs.set('taskId', params.taskId);
    if (params.limit) qs.set('limit', String(params.limit));
    return request<{ routes: AgentRouteInfo[] }>(`/agents/routes?${qs.toString()}`);
  },
  agentModels: () =>
    request<{ models: { model: string; inputPricePerM: number; outputPricePerM: number }[] }>('/agents/models'),
  orchestrate: (input: {
    workspaceId: string;
    goalId?: string;
    nodes: { id: string; dependsOn: string[]; status: string; title?: string; priority?: number }[];
    taskTexts?: Record<string, string>;
    taskKinds?: Record<string, string>;
    networkAllowed?: boolean;
    maxParallel?: number;
    aggregationStrategy?: string;
    dryRun?: boolean;
  }) =>
    request<{
      parallelism: { limit: number; reason: string; factors: { name: string; value: number }[] };
      batches: string[][];
      dispatched: { taskId: string; role: string; model: string; tools: string[]; routeReason: string; agentReason: string }[];
      waiting: { taskId: string; reason: string }[];
      completed: string[];
      failed: { taskId: string; error: string }[];
      aggregated: AggregatedResultInfo[];
      cost: { total: number; state: string; ratio: number };
      speedup: { sequentialMs: number; parallelMs: number; speedup: number; batches: number };
      notes: string[];
    }>('/agents/orchestrate', { method: 'POST', body: JSON.stringify(input) }),
  aggregatedResults: (taskId: string) => request<{ results: AggregatedResultInfo[] }>(`/aggregated/results?taskId=${encodeURIComponent(taskId)}`),
  resolveAggregated: (id: string, workspaceId: string, decisions: { key: string; agentId?: string; value?: unknown }[]) =>
    request<{ id: string; remaining: number; needsReview: boolean; resolvedAt: string | null }>(
      `/aggregated/${encodeURIComponent(id)}/resolve?confirm=true`,
      { method: 'POST', body: JSON.stringify({ workspaceId, decisions }) },
    ),
  costs: (workspaceId: string, goalId?: string) =>
    request<CostSummary & { goalId?: string; cost?: number; records?: number }>(
      `/costs?workspaceId=${encodeURIComponent(workspaceId)}${goalId ? `&goalId=${encodeURIComponent(goalId)}` : ''}`,
    ),
  recordCost: (input: { workspaceId: string; model: string; tokensIn: number; tokensOut: number; goalId?: string; taskId?: string; agentId?: string; costUsd?: number }) =>
    request<{ id: string; cost: number; total: number; state: string; ratio: number }>('/costs', { method: 'POST', body: JSON.stringify(input) }),

  /* ================================================================== */
  /* Phase 4：安全中心                                                   */
  /* ================================================================== */

  rbacPermissions: () =>
    request<{ permissions: { key: string; label: string }[]; all: string[] }>('/rbac/permissions'),
  listRoles: (workspaceId: string) => request<{ roles: RoleInfo[] }>(`/rbac/roles?workspaceId=${encodeURIComponent(workspaceId)}`),
  createRole: (input: { workspaceId: string; name: string; permissions: string[] }) =>
    request<{ role: RoleInfo }>('/rbac/roles', { method: 'POST', body: JSON.stringify(input) }),
  updateRole: (name: string, workspaceId: string, permissions: string[]) =>
    request<{ role: RoleInfo }>(`/rbac/roles/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify({ workspaceId, permissions }) }),
  deleteRole: (name: string, workspaceId: string) =>
    request<{ removed: string; name: string }>(`/rbac/roles/${encodeURIComponent(name)}?workspaceId=${encodeURIComponent(workspaceId)}&confirm=true`, {
      method: 'DELETE',
    }),
  assignRole: (workspaceId: string, userId: string, role: string) =>
    request<{ assigned: boolean; role: string; userId: string; permissions: string[] }>('/rbac/assign?confirm=true', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, userId, role }),
    }),
  unassignRole: (workspaceId: string, userId: string, role: string) =>
    request<{ unassigned: boolean; role: string; userId: string }>('/rbac/unassign', { method: 'POST', body: JSON.stringify({ workspaceId, userId, role }) }),
  rbacUsers: (workspaceId: string) =>
    request<{ users: { userId: string; roles: string[]; permissions: string[] }[] }>(`/rbac/users?workspaceId=${encodeURIComponent(workspaceId)}`),
  checkPermission: (workspaceId: string, userId: string, permission: string) =>
    request<{ allowed: boolean; reason: string; granted: string[] }>(
      `/rbac/check?workspaceId=${encodeURIComponent(workspaceId)}&userId=${encodeURIComponent(userId)}&permission=${encodeURIComponent(permission)}`,
    ),
  ssoConfig: (workspaceId: string) => request<SsoConfigInfo & { configured: boolean; hasSecret: boolean }>(`/sso/config?workspaceId=${encodeURIComponent(workspaceId)}`),
  saveSsoConfig: (input: { workspaceId: string; protocol?: string; issuer: string; clientId: string; clientSecretRef: string; redirectUri: string; groupMapping?: Record<string, string>; enabled?: boolean }) =>
    request<SsoConfigInfo & { configured: boolean; hasSecret: boolean }>('/sso/config', { method: 'POST', body: JSON.stringify(input) }),
  enableSso: (workspaceId: string, enabled: boolean) =>
    request<SsoConfigInfo & { configured: boolean; hasSecret: boolean }>(`/sso/enable?confirm=true`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId, enabled }),
    }),
  removeSso: (workspaceId: string) =>
    request<{ removed: boolean }>(`/sso/config?workspaceId=${encodeURIComponent(workspaceId)}&confirm=true`, { method: 'DELETE' }),
  ssoAuthUrl: (workspaceId: string) =>
    request<{ url: string; state: string; nonce: string; expiresAt: string }>(`/sso/auth-url?workspaceId=${encodeURIComponent(workspaceId)}`),
  auditLogs: (params: { workspaceId: string; from?: string; to?: string; action?: string; actor?: string; dangerousOnly?: boolean; limit?: number }) => {
    const qs = new URLSearchParams({ workspaceId: params.workspaceId });
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    if (params.action) qs.set('action', params.action);
    if (params.actor) qs.set('actor', params.actor);
    if (params.dangerousOnly) qs.set('dangerousOnly', 'true');
    if (params.limit) qs.set('limit', String(params.limit));
    return request<{ logs: AuditLog[]; stats: { total: number; dangerous: number; unconfirmedDangerous: number; byAction: { action: string; count: number }[]; byActor: { actor: string; count: number }[] } }>(
      `/audit/logs?${qs.toString()}`,
    );
  },
  exportAudit: (input: { workspaceId: string; from: string; to: string; actor?: string }) =>
    request<{ exportId: string; filePath: string; rowCount: number; bytes: number }>('/audit/export?confirm=true', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  auditExports: (workspaceId: string) => request<{ exports: AuditExportInfo[] }>(`/audit/exports?workspaceId=${encodeURIComponent(workspaceId)}`),
  auditExportDownloadUrl: (id: string, workspaceId: string) =>
    `${BASE}/audit/exports/${encodeURIComponent(id)}/download?workspaceId=${encodeURIComponent(workspaceId)}`,
  maskRules: (workspaceId: string) =>
    request<{ rules: DataMaskRuleInfo[]; builtin: { field: string; strategy: string; source: string }[] }>(
      `/compliance/mask-rules?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  upsertMaskRule: (input: { workspaceId: string; field: string; strategy: string; target?: string; enabled?: boolean }) =>
    request<{ rule: DataMaskRuleInfo }>('/compliance/mask-rules', { method: 'POST', body: JSON.stringify(input) }),
  deleteMaskRule: (id: string, workspaceId: string) =>
    request<{ removed: string; field: string }>(`/compliance/mask-rules/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
    }),
  maskPreview: (workspaceId: string, limit = 10) =>
    request<{ samples: AuditLog[]; rules: { field: string; strategy: string; target: string }[] }>(
      `/compliance/mask-preview?workspaceId=${encodeURIComponent(workspaceId)}&limit=${limit}`,
    ),
  retentionPolicies: (workspaceId: string) =>
    request<{ policies: RetentionPolicyInfo[]; dataTypes: string[] }>(`/compliance/retention?workspaceId=${encodeURIComponent(workspaceId)}`),
  upsertRetention: (input: { workspaceId: string; dataType: string; retentionDays: number; action?: string; enabled?: boolean }) =>
    request<{ policy: RetentionPolicyInfo }>('/compliance/retention', { method: 'POST', body: JSON.stringify(input) }),
  deleteRetention: (dataType: string, workspaceId: string) =>
    request<{ removed: string }>(`/compliance/retention/${encodeURIComponent(dataType)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' }),
  applyRetention: (input: { workspaceId: string; dataType?: string; dryRun?: boolean }) =>
    request<{ dryRun: boolean; results: RetentionRunResult[] }>(
      `/compliance/retention/apply${input.dryRun === false ? '?confirm=true' : ''}`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  compliancePackage: (input: { workspaceId: string; from: string; to: string }) =>
    request<{
      workspaceId: string;
      generatedAt: string;
      audit: AuditLog[];
      maskRules: { field: string; strategy: string; target: string }[];
      retentionPolicies: { dataType: string; retentionDays: number; action: string; enabled: boolean }[];
      summary: { auditCount: number; dangerousCount: number; unconfirmedDangerous: number };
    }>('/compliance/package', { method: 'POST', body: JSON.stringify(input) }),
};

export type { TaskBoardCard };
