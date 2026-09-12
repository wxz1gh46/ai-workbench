import type { OfficeFormat } from './api.ts';
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

/* ------------------------------------------------------------------ */
/* Phase 2：百万 Token 分层上下文                                       */
/* ------------------------------------------------------------------ */

/** 上下文片段种类：对应 Token 预算的五个分区 */
export type ContextBlockKind = 'summary' | 'facts' | 'recent' | 'retrieval' | 'file' | 'goal';

export interface ContextBlock {
  kind: ContextBlockKind;
  content: string;
  /** 溯源：该片段来自哪些 messageId / factId，前端可点击跳回原消息 */
  sourceIds: Id[];
  tokens: number;
  /** 片段级相关度（向量召回时给出），用于 UI 排序展示 */
  score?: number;
}

/** Token 预算分配结果，UI 用进度条展示 */
export interface TokenBudgetUsage {
  total: number;
  used: number;
  byKind: Record<ContextBlockKind, number>;
  /** 各分区上限 */
  limits: Record<ContextBlockKind, number>;
  outputReserve: number;
  overBudget: boolean;
}

/** 上下文组装结果（可溯源） */
export interface ContextBundle {
  blocks: ContextBlock[];
  totalTokens: number;
  /** 全部可溯源 messageId，前端高亮用 */
  citations: Id[];
  budget: TokenBudgetUsage;
  /** 当前路由到的模型 */
  model: string;
  /** 模型是否因长上下文自动切换 */
  routedByLength: boolean;
}

/** 长期记忆事实（Phase 2 增加 embedding、分类与召回计数） */
export interface MemoryFactRecord extends MemoryFact {
  /** 向量（本地确定性 embedding 或外部服务返回），null 表示尚未计算 */
  embedding: number[] | null;
  /** 被检索召回次数，用于重要度衰减/提升 */
  recallCount: number;
  /** 事实分类 */
  factType: 'preference' | 'constraint' | 'decision' | 'fact';
  updatedAt: IsoDateTime;
}

/** 会话压缩（滚动摘要）执行结果 */
export interface CompactResult {
  conversationId: Id;
  summarizedMessages: number;
  summaryId: Id | null;
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  factsExtracted: number;
  degraded: boolean;
}

/* ------------------------------------------------------------------ */
/* Phase 2：目标模式（GoalRun / 进度树）                                */
/* ------------------------------------------------------------------ */

export type GoalRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/** 一次目标推进的持久化记录，支持回放与审计 */
export interface GoalRun {
  id: Id;
  goalId: Id;
  iteration: number;
  status: GoalRunStatus;
  /** 本轮使用的计划（JSON） */
  plan: Record<string, unknown> | null;
  /** 本轮反思结论 */
  reflection: string;
  /** 本轮审计报告 */
  auditReport: string | null;
  taskIds: Id[];
  tokensUsed: number;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
}

/** 进度树节点：目标 → 任务 → 子任务 */
export interface ProgressNode {
  id: Id;
  parentId: Id | null;
  title: string;
  status: TaskStatus | GoalStatus;
  progress: number;
  agentRole: string;
  assigneeAgentId: Id | null;
  dependsOn: Id[];
  children: ProgressNode[];
  /** 阻塞原因（status=blocked 时） */
  blockedReason: string | null;
  outputSummary: string | null;
}

export interface ProgressTree {
  goal: {
    id: Id;
    objective: string;
    status: GoalStatus;
    progress: number;
    iterations: number;
    maxIterations: number;
    acceptanceCriteria: string[];
  };
  nodes: ProgressNode[];
  /** 完成度总览 */
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    blocked: number;
    running: number;
    pending: number;
    percent: number;
  };
  blockers: string[];
}

/** 完成审计报告（结构化，便于 UI 渲染） */
export interface AuditReport {
  goalId: Id;
  passed: boolean;
  score: number;
  criteria: { criterion: string; met: boolean; evidence: string }[];
  issues: { severity: 'low' | 'medium' | 'high'; detail: string }[];
  nextActions: string[];
  markdown: string;
  degraded: boolean;
  generatedAt: IsoDateTime;
}

/* ------------------------------------------------------------------ */
/* Phase 2：多 Agent 集群                                               */
/* ------------------------------------------------------------------ */

/** Agent 集群运行模式：实验性集群可降级为单 Agent */
export type ClusterMode = 'single' | 'parallel' | 'cluster';

export interface ClusterConfig {
  workspaceId: Id;
  mode: ClusterMode;
  /** 并发上限 */
  maxParallel: number;
  /** 集群节点标识（跨机部署时使用，本地为 'local'） */
  nodeId: string;
  /** 功能开关：出问题时一键关闭实验性能力 */
  experimental: boolean;
}

/** 任务看板列 */
export type TaskBoardColumn = 'todo' | 'running' | 'blocked' | 'done';

export interface TaskBoardCard {
  taskId: Id;
  goalId: Id;
  title: string;
  column: TaskBoardColumn;
  status: TaskStatus;
  agentRole: string;
  assigneeAgentId: Id | null;
  assigneeName: string | null;
  attempts: number;
  maxAttempts: number;
  dependsOn: Id[];
  blockedReason: string | null;
  tokensUsed: number;
  updatedAt: IsoDateTime;
}

export interface TaskBoard {
  columns: Record<TaskBoardColumn, TaskBoardCard[]>;
  total: number;
}

/** Agent 间消息（Phase 2 扩展：可寻址、可回复） */
export interface AgentMessageRecord extends AgentMessage {
  /** 会话线程标识，便于 UI 按话题聚合 */
  threadId: Id;
  /** 消息种类 */
  kind: 'broadcast' | 'direct' | 'task-claim' | 'task-result' | 'request-help' | 'reply';
}

/* ------------------------------------------------------------------ */
/* Phase 2：Office 文件处理                                             */
/* ------------------------------------------------------------------ */

export interface OfficeDocumentInfo {
  fileId: Id | null;
  path: string;
  format: OfficeFormat;
  /** docx: 段落；xlsx: 工作表；pptx: 幻灯片；pdf: 页文本 */
  meta: {
    paragraphs?: number;
    sheets?: { name: string; rows: number; cols: number }[];
    slides?: number;
    pages?: number;
    words?: number;
  };
  /** 解析出的结构化内容（文本 + 表格 + 幻灯片） */
  content: OfficeContent;
  /** 解析过程中的降级说明（如 PDF 中文排版） */
  warnings: string[];
}

export interface OfficeContent {
  text: string;
  tables?: { sheet: string; rows: (string | number | boolean | null)[][] }[];
  slides?: { title: string; bullets: string[] }[];
  outline?: { level: number; text: string }[];
}

/** Office 预览（供 UI 渲染，不依赖原生 Office） */
export interface OfficePreview {
  format: OfficeFormat;
  /** markdown 形式的结构化预览 */
  markdown: string;
  tables: { sheet: string; rows: (string | number | boolean | null)[][] }[];
  slides: { title: string; bullets: string[] }[];
  /** 是否需要专用渲染器（docx 用 docx-preview、pdf 用 pdf.js） */
  renderer: 'markdown' | 'docx-preview' | 'pdf.js' | 'sheetjs' | 'pptx';
  /** 可下载 URL */
  downloadUrl: string;
}

/* ------------------------------------------------------------------ */
/* Phase 2：深度研究                                                    */
/* ------------------------------------------------------------------ */

export type ResearchJobStatus =
  | 'pending'
  | 'searching'
  | 'fetching'
  | 'extracting'
  | 'validating'
  | 'analyzing'
  | 'writing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ResearchSource {
  id: Id;
  researchJobId: Id;
  url: string;
  title: string;
  snippet: string;
  /** 抓取到的正文（截断存储） */
  content: string;
  accessedAt: IsoDateTime;
  /** 可信度 0-1，由来源域名与交叉验证结果推断 */
  reliability: number;
  /** 是否为付费/需登录来源，未授权时标记为未验证 */
  requiresAuth: boolean;
}

export interface ResearchClaim {
  id: Id;
  researchJobId: Id;
  claim: string;
  /** 支持该论断的来源 id */
  supportingSources: Id[];
  /** 冲突来源 id（多源交叉验证发现不一致） */
  conflictingSources: Id[];
  confidence: number;
  /** 是否被标记为冲突 */
  disputed: boolean;
}

export interface ResearchJob {
  id: Id;
  workspaceId: Id;
  topic: string;
  depth: 'quick' | 'standard' | 'deep';
  status: ResearchJobStatus;
  /** 生成的检索式 */
  queries: string[];
  progress: number;
  stage: string;
  sourceCount: number;
  claimCount: number;
  disputedCount: number;
  error: string | null;
  createdAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
}

export interface ResearchReport {
  id: Id;
  researchJobId: Id;
  markdown: string;
  /** 图表（Mermaid / SVG，前端可直接渲染） */
  charts: { title: string; kind: 'bar' | 'line' | 'pie' | 'mermaid'; data: unknown }[];
  references: {
    index: number;
    sourceId: Id;
    title: string;
    url: string;
    accessedAt: IsoDateTime;
    snippet: string;
  }[];
  markdownPath: string | null;
  pdfPath: string | null;
  pptxPath: string | null;
  webUrl: string | null;
  createdAt: IsoDateTime;
}
