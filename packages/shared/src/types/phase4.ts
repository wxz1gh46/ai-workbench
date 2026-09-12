import type { Id, IsoDateTime } from './ids.ts';

/* ================================================================== */
/* Step 1：插件系统与 MCP                                              */
/* ================================================================== */

export type PluginKindV4 = 'mcp' | 'http' | 'websocket' | 'local';

export interface PluginPermissionDeclV4 {
  scope: string;
  description: string;
  sensitive: boolean;
  required?: boolean;
}

export interface PluginToolDeclV4 {
  name: string;
  description: string;
  dangerous?: boolean;
  requires?: string[];
  input?: Record<string, unknown>;
}

export interface PluginManifestV4 {
  name: string;
  version: string;
  author: string;
  description: string;
  kind: PluginKindV4;
  source: string;
  permissions: PluginPermissionDeclV4[];
  tools: PluginToolDeclV4[];
  resources?: { uri: string; description: string }[];
  prompts?: { name: string; description: string }[];
  requiresUserAuth: boolean;
  secretRefs: string[];
  sandbox: boolean;
  signature?: string;
  config?: Record<string, unknown>;
}

export interface PluginInstallationInfo {
  installationId: Id;
  pluginId: Id;
  name: string;
  version: string;
  status: 'installed' | 'enabled' | 'disabled' | 'error';
  manifestHash: string;
  installedAt: IsoDateTime;
  requiresUserAuth: boolean;
  secretRefs: string[];
  permissions: (PluginPermissionDeclV4 & { id: Id; granted: boolean })[];
  grantedScopes: string[];
  latestVersion: string;
  updateAvailable: boolean;
  source: string;
  kind: PluginKindV4;
  signed?: boolean;
}

export interface PluginInvokeResult {
  ok: boolean;
  tool: string;
  content: unknown;
  durationMs: number;
  degraded: boolean;
  denied?: { reason: string; missingScopes: string[] };
  error?: string;
}

export interface McpServerRecord {
  id: Id;
  workspaceId: Id;
  name: string;
  transport: 'stdio' | 'http' | 'sse' | 'websocket';
  endpoint: string;
  command: string | null;
  args: string[];
  status: 'registered' | 'connected' | 'error' | 'disabled';
  capabilities: Record<string, unknown>;
  secretRefs: string[];
  lastError: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface McpToolRecord {
  id: Id;
  serverId: Id;
  name: string;
  description: string;
  schema: Record<string, unknown>;
  enabled: boolean;
  dangerous: boolean;
}

/* ================================================================== */
/* Step 2：付费数据库                                                  */
/* ================================================================== */

export interface PaidDataProviderSpec {
  id: string;
  name: string;
  type: 'market' | 'enterprise' | 'financial' | 'macro' | 'legal' | 'academic';
  region: string;
  status: 'available' | 'unconfigured' | 'configured';
  docsUrl: string;
  requiresUserAuth: boolean;
  /** 需要的配置字段名（只声明名字与说明，不索取默认值） */
  credentialFields: { key: string; label: string; required: boolean; hint?: string }[];
  /** 可用动作（用于 UI 生成查询表单） */
  actions: { name: string; label: string; description: string; params: { key: string; label: string; required: boolean }[] }[];
  /** 官方接入方式说明（合规要求写清楚） */
  accessMethods: string[];
  rateLimit: { perMinute: number; note: string };
}

export interface PaidDataCredentialInfo {
  providerId: string;
  status: 'unconfigured' | 'configured' | 'verified' | 'error';
  fieldNames: string[];
  lastVerifiedAt: IsoDateTime | null;
  lastError: string | null;
  updatedAt: IsoDateTime | null;
}

export interface PaidDataQueryRecord {
  id: Id;
  workspaceId: Id;
  providerId: string;
  action: string;
  params: Record<string, unknown>;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked';
  cached: boolean;
  degraded: boolean;
  rowCount: number;
  durationMs: number;
  error: string | null;
  blockedReason: string | null;
  createdAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
}

export interface PaidDataCitation {
  title: string;
  url: string;
  accessedAt: IsoDateTime;
  provider: string;
}

export interface PaidDataQueryResult {
  query: PaidDataQueryRecord;
  data: unknown;
  citations: PaidDataCitation[];
}

/* ================================================================== */
/* Step 3：提示词工程                                                  */
/* ================================================================== */

export interface PromptVariableSpec {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  required: boolean;
  defaultValue: string | null;
  description: string;
  options: string[];
}

export interface PromptVersionInfo {
  id: Id;
  templateId: Id;
  version: number;
  content: Record<string, string>;
  createdAt: IsoDateTime;
  createdBy: string;
}

export interface PromptABTestInfo {
  id: Id;
  templateId: Id;
  name: string;
  versionA: number;
  versionB: number;
  status: 'draft' | 'running' | 'finished';
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

export interface PromptEvaluationInfo {
  id: Id;
  abTestId: Id;
  version: string;
  metric: string;
  value: number;
  sampleSize: number;
  note: string;
  createdAt: IsoDateTime;
}

export interface PromptABTestReport {
  test: PromptABTestInfo;
  evaluations: PromptEvaluationInfo[];
  summary: {
    version: string;
    metrics: Record<string, number>;
    sampleSize: number;
    score: number;
  }[];
  winner: string | null;
  reason: string;
}

export interface PromptOptimizeReport {
  sections: Record<string, string>;
  rendered: string;
  variables: PromptVariableSpec[];
  notes: string[];
  issues: { severity: 'low' | 'medium' | 'high'; section: string; detail: string; suggestion: string }[];
  score: number;
  degraded: boolean;
}

/* ================================================================== */
/* Step 4：实验性集群                                                  */
/* ================================================================== */

export interface ClusterNodeInfo {
  id: Id;
  clusterId: string;
  name: string;
  role: 'leader' | 'worker' | 'candidate';
  host: string;
  port: number;
  status: 'online' | 'offline' | 'draining' | 'error';
  resources: Record<string, number>;
  labels: Record<string, string>;
  lastHeartbeat: IsoDateTime | null;
  heartbeatMiss: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ClusterShardInfo {
  id: Id;
  taskId: string;
  goalId: string | null;
  index: number;
  total: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  status: 'pending' | 'assigned' | 'running' | 'succeeded' | 'failed' | 'reassigned';
  assignedNodeId: Id | null;
  attempts: number;
  error: string | null;
  createdAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
}

export interface ClusterTaskInfo {
  id: Id;
  workspaceId: Id;
  goalId: string | null;
  taskId: string | null;
  shardId: Id | null;
  assignedNodeId: Id | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  error: string | null;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

export interface ClusterHealthSample {
  id: Id;
  nodeId: Id;
  cpu: number;
  memory: number;
  gpu: number;
  disk: number;
  network: number;
  recordedAt: IsoDateTime;
}

export interface ClusterPolicyInfo {
  id: Id;
  workspaceId: Id;
  name: string;
  maxNodes: number;
  maxParallelTasks: number;
  resourceLimits: Record<string, number>;
  fallbackEnabled: boolean;
  heartbeatTimeoutMs: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ClusterStatus {
  clusterId: string;
  mode: 'single' | 'cluster';
  degraded: boolean;
  degradeReason: string | null;
  leader: ClusterNodeInfo | null;
  term: number;
  nodes: ClusterNodeInfo[];
  online: number;
  policy: ClusterPolicyInfo;
  taskStats: { queued: number; running: number; succeeded: number; failed: number; cancelled: number };
  shardStats: { pending: number; assigned: number; running: number; succeeded: number; failed: number; reassigned: number };
}

export interface ElectionRecord {
  id: Id;
  clusterId: string;
  term: number;
  leaderNodeId: Id;
  reason: string;
  electedAt: IsoDateTime;
}

/* ================================================================== */
/* Step 5：多 Agent 并行                                               */
/* ================================================================== */

export interface AgentPoolInfo {
  id: Id;
  workspaceId: Id;
  name: string;
  role: string;
  minAgents: number;
  maxAgents: number;
  activeAgents: number;
  model: string | null;
  tools: string[];
  status: 'active' | 'paused' | 'error';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface AgentRouteInfo {
  id: Id;
  taskId: string;
  agentId: string;
  poolId: Id | null;
  reason: string;
  score: number;
  kind: 'agent' | 'model' | 'tool';
  detail: Record<string, unknown>;
  createdAt: IsoDateTime;
}

export interface AggregatedResultInfo {
  id: Id;
  taskId: string;
  goalId: string | null;
  strategy: 'majority' | 'priority' | 'concat' | 'manual';
  result: Record<string, unknown>;
  conflicts: { key: string; values: { agentId: string; value: string }[]; resolution: string; resolvedBy: string }[];
  needsReview: boolean;
  resolvedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

export interface CostRecordInfo {
  id: Id;
  workspaceId: Id;
  goalId: string | null;
  taskId: string | null;
  agentId: string | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  budgetState: 'none' | 'warn' | 'exceeded';
  createdAt: IsoDateTime;
}

export interface CostSummary {
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  budget: { limit: number; used: number; ratio: number; state: 'none' | 'warn' | 'exceeded' };
  byModel: { model: string; tokensIn: number; tokensOut: number; cost: number }[];
  byAgent: { agentId: string; cost: number; tokensIn: number; tokensOut: number }[];
}

/* ================================================================== */
/* Step 6：企业安全与审计                                              */
/* ================================================================== */

export interface RoleInfo {
  id: Id;
  workspaceId: Id;
  name: string;
  permissions: string[];
  builtin: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface UserRoleInfo {
  id: Id;
  userId: string;
  roleId: Id;
  workspaceId: Id;
  createdAt: IsoDateTime;
}

export interface SsoConfigInfo {
  id: Id;
  workspaceId: Id;
  protocol: 'oidc' | 'saml';
  enabled: boolean;
  issuer: string;
  clientId: string;
  /** 只暴露「凭据变量名」，绝不返回 secret 本身 */
  clientSecretRef: string;
  redirectUri: string;
  groupMapping: Record<string, string>;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface AuditExportInfo {
  id: Id;
  workspaceId: Id;
  type: string;
  rangeStart: IsoDateTime;
  rangeEnd: IsoDateTime;
  filePath: string;
  rowCount: number;
  status: 'pending' | 'succeeded' | 'failed';
  error: string | null;
  createdAt: IsoDateTime;
}

export interface DataMaskRuleInfo {
  id: Id;
  workspaceId: Id;
  field: string;
  strategy: 'full' | 'partial' | 'hash' | 'nullify';
  target: string;
  enabled: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface RetentionPolicyInfo {
  id: Id;
  workspaceId: Id;
  dataType: string;
  retentionDays: number;
  action: 'delete' | 'anonymize' | 'archive';
  enabled: boolean;
  lastRunAt: IsoDateTime | null;
  lastAffected: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface RetentionRunResult {
  dataType: string;
  action: string;
  scanned: number;
  affected: number;
  dryRun: boolean;
  detail: string;
}
