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
