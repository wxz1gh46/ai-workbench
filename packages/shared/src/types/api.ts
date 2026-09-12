import type { Id } from './ids.ts';
import type {
  Agent,
  AgentRun,
  Artifact,
  Goal,
  Message,
  Plugin,
  PromptSections,
  Schedule,
  Task,
  Website,
  Widget,
} from './domain.ts';

/* ------------------------------ Agent ------------------------------ */

export interface CreateGoalRequest {
  workspaceId: Id;
  objective: string;
  /** 显式给出验收标准；缺省由 Planner 解析生成 */
  acceptanceCriteria?: string[];
  /** 是否自动连续推进（false 时每轮需前端调用 /agent/goal/:id/advance） */
  autoRun?: boolean;
  maxIterations?: number;
}

export interface CreateGoalResponse {
  goal: Goal;
  tasks: Task[];
  agents: Agent[];
}

export interface AdvanceGoalRequest {
  /** 手动补充的观察/干预信息 */
  note?: string;
}

export interface AdvanceGoalResponse {
  goal: Goal;
  tasks: Task[];
  finished: boolean;
}

export interface CancelTaskResponse {
  task: Task;
}

export interface ListRunsQuery {
  goalId?: Id;
  taskId?: Id;
  agentId?: Id;
  limit?: number;
}

export interface ListRunsResponse {
  runs: AgentRun[];
}

/* ----------------------------- Files ------------------------------- */

export interface UploadFileRequest {
  workspaceId: Id;
  name: string;
  mime?: string;
  /** base64；大文件走流式上传（Phase 2） */
  contentBase64: string;
}

export interface UploadFileResponse {
  fileId: Id;
  path: string;
  version: number;
}

/* ----------------------------- Office ------------------------------ */

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'markdown';

export interface GenerateOfficeRequest {
  workspaceId: Id;
  format: OfficeFormat;
  title: string;
  /** markdown / 结构化数据 */
  content: string;
  /** xlsx 用：多 sheet 数据 */
  sheets?: { name: string; rows: unknown[][] }[];
  goalId?: Id;
}

export interface GenerateOfficeResponse {
  artifact: Artifact;
  fileId: Id;
}

/* ---------------------------- Research ----------------------------- */

export interface ResearchRequest {
  workspaceId: Id;
  topic: string;
  depth?: 'quick' | 'standard' | 'deep';
  outputFormats?: OfficeFormat[];
  /** 是否允许联网检索（默认 false，需要用户显式允许） */
  allowNetwork?: boolean;
}

/* ----------------------------- Website ----------------------------- */

export interface DeployWebsiteRequest {
  workspaceId: Id;
  description: string;
  provider?: Website['provider'];
  database?: 'neon' | 'supabase' | 'none';
  /** 危险操作：必须为 true 才会真正部署 */
  confirm: boolean;
}

export interface DeployWebsiteResponse {
  website: Website;
  log: string;
}

/* ---------------------------- Schedule ----------------------------- */

export interface CreateScheduleRequest {
  workspaceId: Id;
  name: string;
  trigger: Schedule['trigger'];
  expression: string;
  action: Record<string, unknown>;
  channelIds?: Id[];
  enabled?: boolean;
  retry?: number;
}

/* ----------------------------- Plugins ----------------------------- */

export interface ListPluginsResponse {
  plugins: Plugin[];
}

/* ----------------------------- Prompt ------------------------------ */

export interface OptimizePromptRequest {
  workspaceId: Id;
  /** 用户原始诉求 */
  intent: string;
  /** 已有提示词，给出则做优化，不给则从零生成 */
  current?: Partial<PromptSections>;
  /** 目标模型，影响输出风格 */
  targetModel?: string;
}

export interface OptimizePromptResponse {
  sections: PromptSections;
  rendered: string;
  variables: string[];
  notes: string[];
}

/* ----------------------------- Widgets ----------------------------- */

export interface CreateWidgetRequest {
  workspaceId: Id;
  /** 自然语言描述，如「显示所有 Agent 状态」 */
  naturalLanguage: string;
  dashboardId?: string;
}

export interface CreateWidgetResponse {
  widget: Widget;
}

/* ----------------------------- Messages ---------------------------- */

export interface SendMessageRequest {
  conversationId: Id;
  content: string;
}

export interface SendMessageResponse {
  userMessage: Message;
  assistantMessage: Message;
  /** 本次回答的召回来源 messageId */
  citations: Id[];
}

/* ================================================================== */
/* Phase 2 接口契约                                                     */
/* ================================================================== */

import type {
  AuditReport,
  ClusterConfig,
  CompactResult,
  ContextBundle,
  GoalRun,
  MemoryFactRecord,
  OfficeContent,
  OfficeDocumentInfo,
  OfficePreview,
  ProgressTree,
  ResearchClaim,
  ResearchJob,
  ResearchReport,
  ResearchSource,
  TaskBoard,
  TokenBudgetUsage,
} from './domain.ts';

/* --------------------- Step 1：分层上下文 -------------------------- */

export interface ContextSummaryResponse {
  conversationId: Id;
  summaries: {
    id: Id;
    content: string;
    tokenCount: number;
    /** 本次摘要覆盖的消息条数 */
    coveredCount: number;
    /** rolling 滚动摘要 / manual 手动压缩 */
    kind: string;
    fromMessageId: Id;
    toMessageId: Id;
    createdAt: string;
  }[];
  facts: MemoryFactRecord[];
  messages: number;
  /** 未摘要消息的 token 总量 */
  rawTokens: number;
  /** 触发滚动摘要的阈值 */
  compactThreshold: number;
  /** 是否建议压缩 */
  shouldCompact: boolean;
  budget: TokenBudgetUsage;
}

export interface CompactConversationRequest {
  /** 强制压缩，即使未超阈值 */
  force?: boolean;
  /** 目标保留的最近消息条数 */
  keepRecent?: number;
}

export interface ContextPreviewQuery {
  q?: string;
  /** 附带的工作区文件上下文（相对路径） */
  files?: string[];
}

/* ----------------------- Step 2：目标模式 -------------------------- */

export interface RunGoalRequest {
  /** 最大轮次上限，覆盖默认 */
  maxIterations?: number;
  /** 运行模式：single 单 Agent 串行（降级） */
  mode?: 'single' | 'parallel' | 'cluster';
}

export interface RunGoalResponse {
  goal: Goal;
  runs: GoalRun[];
  audit: AuditReport | null;
  finished: boolean;
}

export interface GoalProgressResponse extends ProgressTree {}

export interface GoalAuditResponse {
  audit: AuditReport | null;
  markdown: string | null;
}

export interface ListGoalRunsResponse {
  runs: GoalRun[];
}

/* ---------------------- Step 3/4：多 Agent ------------------------- */

export interface UpdateClusterConfigRequest {
  mode?: ClusterConfig['mode'];
  maxParallel?: number;
  experimental?: boolean;
}

export interface ClusterConfigResponse {
  config: ClusterConfig;
}

export interface SendAgentMessageRequest {
  fromAgentId?: Id;
  toAgentId?: Id | null;
  kind?: 'broadcast' | 'direct' | 'request-help';
  content: string;
  threadId?: Id;
}

export interface TaskBoardResponse {
  board: TaskBoard;
}

export interface AssignTaskRequest {
  agentId: Id;
  /** 抢占：无论当前状态都改派 */
  preempt?: boolean;
}

/* ------------------------ Step 5：Office -------------------------- */

export interface OfficeReadRequest {
  workspaceId: Id;
  /** 工作区相对路径 */
  path: string;
}

export interface OfficeConvertRequest {
  workspaceId: Id;
  path: string;
  /** 目标格式；实际转换依赖 LibreOffice headless，缺失时显式降级 */
  target: OfficeFormat;
  outputPath?: string;
}

export interface OfficeEditRequest {
  workspaceId: Id;
  path: string;
  /** 编辑指令：append 追加段落 / replace 文本替换 / setCell 单元格 */
  operations: (
    | { op: 'append'; text: string }
    | { op: 'replace'; find: string; replace: string }
    | { op: 'setCell'; sheet: string; cell: string; value: string | number }
    | { op: 'addSlide'; title: string; bullets: string[] }
  )[];
  /** 是否先备份为 FileVersion */
  backup?: boolean;
}

export interface GenerateOfficeV2Request {
  workspaceId: Id;
  format: OfficeFormat;
  title: string;
  content: string;
  sheets?: { name: string; rows: (string | number | boolean | null)[][] }[];
  slides?: { title: string; bullets: string[] }[];
  outputPath?: string;
  goalId?: Id;
}

export interface OfficeOperationResponse {
  fileId: Id | null;
  path: string;
  version: number;
  bytes: number;
  /** 实际被应用的编辑操作数 */
  applied: number;
  /** 编辑前自动备份的版本号（null 表示未备份） */
  backupVersion: number | null;
  warnings: string[];
  degraded?: boolean;
}

export interface FileVersionsResponse {
  fileId: Id;
  versions: { id: Id; version: number; size: number; sha256: string; storagePath: string; note: string; createdAt: string }[];
  current: number;
}

export interface RestoreFileVersionResponse {
  fileId: Id;
  /** 恢复后新生成的版本号 */
  version: number;
  restoredFrom: number;
  note: string;
}

/* ---------------------- Step 6：深度研究 --------------------------- */

export interface CreateResearchRequest {
  workspaceId: Id;
  topic: string;
  depth?: 'quick' | 'standard' | 'deep';
  outputFormats?: OfficeFormat[];
  /** 必须显式允许联网；未配置检索渠道时自动降级为本地知识 */
  allowNetwork?: boolean;
  /** 最大来源数 */
  maxSources?: number;
}

export interface CreateResearchResponse {
  job: ResearchJob;
}

export interface ResearchJobResponse {
  job: ResearchJob;
  sources: ResearchSource[];
  claims: ResearchClaim[];
  report: ResearchReport | null;
}

export interface ResearchReportResponse {
  job: ResearchJob;
  report: ResearchReport;
}

export interface PublishResearchRequest {
  workspaceId: Id;
  /** 是否公开（false 为本地预览） */
  public?: boolean;
}

export interface PublishResearchResponse {
  jobId: Id;
  webUrl: string;
  artifactId: Id;
}
