import type { Id, IsoDateTime } from './ids.ts';

/* ------------------------------------------------------------------ */
/* 工作区 / 会话 / 消息                                                 */
/* ------------------------------------------------------------------ */

export interface User {
  id: Id;
  name: string;
  /** 本地单机模式默认 'local'，未来支持多用户 RBAC */
  role: 'owner' | 'admin' | 'member' | 'viewer';
  createdAt: IsoDateTime;
}

export interface Workspace {
  id: Id;
  userId: Id;
  name: string;
  /** 本地工作区根目录绝对路径，桌面端直连文件系统 */
  rootPath: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface Conversation {
  id: Id;
  workspaceId: Id;
  title: string;
  /** 归属目标（目标模式下会话挂在 Goal 上） */
  goalId: Id | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  id: Id;
  conversationId: Id;
  role: MessageRole;
  content: string;
  /** 引用溯源：本条消息在检索时召回的来源 messageId 列表 */
  citations: Id[];
  tokenCount: number;
  /** 是否已被滚动摘要覆盖（仍保留在原始消息表中） */
  summarized: boolean;
  createdAt: IsoDateTime;
}

export interface ConversationSummary {
  id: Id;
  conversationId: Id;
  /** 被该摘要覆盖的消息范围（含） */
  fromMessageId: Id;
  toMessageId: Id;
  content: string;
  tokenCount: number;
  createdAt: IsoDateTime;
}

/** 关键事实抽取结果，长期记忆的骨架 */
export interface MemoryFact {
  id: Id;
  conversationId: Id;
  workspaceId: Id;
  key: string;
  value: string;
  sourceMessageId: Id | null;
  importance: number;
  createdAt: IsoDateTime;
}

/* ------------------------------------------------------------------ */
/* 目标 / 任务 / Agent                                                 */
/* ------------------------------------------------------------------ */

export type GoalStatus =
  | 'draft'
  | 'planning'
  | 'running'
  | 'auditing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Goal {
  id: Id;
  workspaceId: Id;
  conversationId: Id | null;
  /** 目标文本：既是起始指令，也是完成审计标准 */
  objective: string;
  /** 目标解析出的结构化验收标准 */
  acceptanceCriteria: string[];
  status: GoalStatus;
  /** 0-100 完成度 */
  progress: number;
  /** 迭代轮次，用于限制无限循环 */
  iterations: number;
  /** 自动推进的最大轮次上限（也支持用户在 UI 里单步推进） */
  maxIterations: number;
  /** 阻断项说明 */
  blockers: string[];
  /** 完成审计报告（Markdown） */
  auditReport: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface Task {
  id: Id;
  goalId: Id;
  /** 父子关系构成进度树 */
  parentTaskId: Id | null;
  title: string;
  description: string;
  status: TaskStatus;
  /** 0-100 */
  progress: number;
  /** 需要的 Agent 角色，调度时用于匹配 */
  agentRole: AgentRole;
  /** 本任务可用的工具名（空表示继承全局） */
  tools: string[];
  /** DAG 依赖：这些任务成功后才可执行 */
  dependsOn: Id[];
  /** 失败重试 */
  attempts: number;
  maxAttempts: number;
  /** 抢占/取消标记 */
  claimedBy: Id | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
}

export type AgentRole =
  | 'coordinator'
  | 'planner'
  | 'researcher'
  | 'analyst'
  | 'coder'
  | 'writer'
  | 'file-ops'
  | 'deployer'
  | 'critic';

export type AgentStatus = 'idle' | 'busy' | 'offline' | 'error';

export interface Agent {
  id: Id;
  workspaceId: Id;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  /** 独立上下文的 system prompt */
  systemPrompt: string;
  /** 该 Agent 可使用的模型（null 表示跟随全局路由） */
  model: string | null;
  /** 当前执行中的任务 */
  currentTaskId: Id | null;
  /** 实验性集群模式下的节点标识 */
  clusterNode: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type AgentRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface AgentRun {
  id: Id;
  agentId: Id;
  taskId: Id;
  goalId: Id;
  status: AgentRunStatus;
  iteration: number;
  /** 本轮的思考/推理文本 */
  reasoning: string;
  /** 本轮构建的 prompt 摘要 */
  promptDigest: string;
  /** 路由到的模型 */
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error: string | null;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
}

export interface ToolCall {
  id: Id;
  runId: Id;
  agentId: Id;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  /** 权限是否通过；未通过则不会真正执行 */
  allowed: boolean;
  durationMs: number;
  error: string | null;
  createdAt: IsoDateTime;
}

/** Agent 间消息总线记录 */
export interface AgentMessage {
  id: Id;
  goalId: Id;
  fromAgentId: Id;
  /** null 表示广播给任务板 */
  toAgentId: Id | null;
  topic: string;
  payload: Record<string, unknown>;
  createdAt: IsoDateTime;
}

/* ------------------------------------------------------------------ */
/* 文件 / 产物                                                         */
/* ------------------------------------------------------------------ */

export interface FileRecord {
  id: Id;
  workspaceId: Id;
  /** 相对 workspace.rootPath 的路径 */
  path: string;
  name: string;
  ext: string;
  mime: string;
  size: number;
  /** 单调递增版本号，配合 FileVersion 实现版本历史 */
  version: number;
  sha256: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface FileVersion {
  id: Id;
  fileId: Id;
  version: number;
  storagePath: string;
  size: number;
  sha256: string;
  note: string;
  createdAt: IsoDateTime;
}

export type ArtifactKind = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'markdown' | 'html' | 'image' | 'json';

export interface Artifact {
  id: Id;
  workspaceId: Id;
  goalId: Id | null;
  taskId: Id | null;
  fileId: Id | null;
  kind: ArtifactKind;
  title: string;
  /** 可直接下载/发布的 URL（本地服务或远端） */
  url: string | null;
  meta: Record<string, unknown>;
  createdAt: IsoDateTime;
}

/* ------------------------------------------------------------------ */
/* 网站部署 / 数据库连接                                                */
/* ------------------------------------------------------------------ */

export type WebsiteStatus = 'creating' | 'building' | 'deployed' | 'failed' | 'deleted';

export interface Website {
  id: Id;
  workspaceId: Id;
  goalId: Id | null;
  name: string;
  provider: 'vercel' | 'cloudflare-pages' | 'netlify' | 'local-preview';
  /** 关联的云端数据库连接 */
  databaseConnectionId: Id | null;
  status: WebsiteStatus;
  url: string | null;
  /** 自定义域名 */
  customDomain: string | null;
  /** 访问控制：public | password | private */
  accessControl: 'public' | 'password' | 'private';
  /** 每次部署一条记录，支持回滚 */
  buildLog: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type DatabaseKind = 'neon' | 'supabase' | 'postgres' | 'sqlite';

export interface DatabaseConnection {
  id: Id;
  workspaceId: Id;
  kind: DatabaseKind;
  name: string;
  /** 密钥引用名，真实连接串存 OS Keychain / 本地加密存储，不入库 */
  secretRef: string;
  host: string | null;
  database: string | null;
  ssl: boolean;
  createdAt: IsoDateTime;
}

/* ------------------------------------------------------------------ */
/* 定时任务 / 看板 / 插件 / 提示词                                       */
/* ------------------------------------------------------------------ */

export type ScheduleTrigger = 'cron' | 'interval' | 'once';

export interface Schedule {
  id: Id;
  workspaceId: Id;
  name: string;
  trigger: ScheduleTrigger;
  /** cron 表达式 / interval 毫秒 / 一次性执行的 ISO 时间 */
  expression: string;
  /** 触发时执行的动作，如 { type: 'goal', objective: '每日行业简报' } */
  action: Record<string, unknown>;
  channelIds: Id[];
  enabled: boolean;
  lastRunAt: IsoDateTime | null;
  nextRunAt: IsoDateTime | null;
  retry: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ScheduleRun {
  id: Id;
  scheduleId: Id;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  attempt: number;
  log: string;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
}

export type WidgetType =
  | 'task-progress'
  | 'agent-status'
  | 'file-generator'
  | 'website-monitor'
  | 'schedule-calendar'
  | 'db-query'
  | 'prompt-shortcut';

export interface Widget {
  id: Id;
  workspaceId: Id;
  dashboardId: string;
  type: WidgetType;
  title: string;
  /** 自然语言创建时的原始描述 */
  naturalLanguage: string | null;
  /** React Grid Layout 布局 */
  layout: { x: number; y: number; w: number; h: number };
  config: Record<string, unknown>;
  pinnedToDesktop: boolean;
  refreshIntervalMs: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type PluginKind = 'mcp' | 'http' | 'websocket' | 'local';
export type PluginStatus = 'installed' | 'enabled' | 'disabled' | 'update-available' | 'error';

export interface Plugin {
  id: Id;
  workspaceId: Id;
  name: string;
  version: string;
  kind: PluginKind;
  /** 市场来源 */
  source: string;
  status: PluginStatus;
  /** 权限声明，安装时展示给用户确认 */
  permissions: PluginPermission[];
  /** 是否需要用户手动授权（付费数据库类一律 true） */
  requiresUserAuth: boolean;
  /** 密钥/Token 引用名，真实值存 Keychain */
  secretRefs: string[];
  sandbox: boolean;
  config: Record<string, unknown>;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface PluginPermission {
  scope: string;
  description: string;
  /** 敏感权限（如交易、企业数据）在 UI 上强提示 */
  sensitive: boolean;
}

export interface PluginCallLog {
  id: Id;
  pluginId: Id;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  error: string | null;
  createdAt: IsoDateTime;
}

export interface PromptTemplate {
  id: Id;
  workspaceId: Id;
  name: string;
  /** 结构化提示词九要素 */
  sections: PromptSections;
  /** {{variable}} 占位符 */
  variables: string[];
  version: number;
  parentId: Id | null;
  tags: string[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface PromptSections {
  role: string;
  task: string;
  context: string;
  steps: string;
  tools: string;
  constraints: string;
  outputFormat: string;
  examples: string;
  acceptance: string;
}

/* ------------------------------------------------------------------ */
/* 审计日志                                                            */
/* ------------------------------------------------------------------ */

export interface AuditLog {
  id: Id;
  workspaceId: Id;
  actor: string;
  action: string;
  targetType: string;
  targetId: string | null;
  /** 是否危险操作（删除/部署/付费调用），危险操作需用户确认 */
  dangerous: boolean;
  confirmedByUser: boolean;
  detail: Record<string, unknown>;
  createdAt: IsoDateTime;
}
