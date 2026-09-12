import type {
  AdvanceGoalRequest,
  AssignTaskRequest,
  CompactConversationRequest,
  CreateResearchRequest,
  OfficeConvertRequest,
  OfficeEditRequest,
  OfficeReadRequest,
  PublishResearchRequest,
  RunGoalRequest,
  SendAgentMessageRequest,
  UpdateClusterConfigRequest,
  CreateGoalRequest,
  CreateScheduleRequest,
  CreateWidgetRequest,
  DeployWebsiteRequest,
  GenerateOfficeRequest,
  OptimizePromptRequest,
  ResearchRequest,
  SendMessageRequest,
  UploadFileRequest,
} from '@ai/shared';

/** 轻量校验器：不引入额外依赖，报错信息带字段名，便于前端定位 */
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isStrOrEmpty = (v: unknown): v is string => typeof v === 'string';
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function isCreateGoalRequest(v: unknown): v is CreateGoalRequest {
  if (!isRecord(v)) return false;
  if (!isStr(v.workspaceId) || !isStr(v.objective)) return false;
  if (v.acceptanceCriteria !== undefined && !(Array.isArray(v.acceptanceCriteria) && v.acceptanceCriteria.every(isStrOrEmpty))) return false;
  if (v.maxIterations !== undefined && typeof v.maxIterations !== 'number') return false;
  if (v.autoRun !== undefined && typeof v.autoRun !== 'boolean') return false;
  return true;
}

export function isAdvanceRequest(v: unknown): v is AdvanceGoalRequest {
  if (v === undefined || v === null) return true;
  return isRecord(v) && (v.note === undefined || isStrOrEmpty(v.note));
}

export function isUploadFileRequest(v: unknown): v is UploadFileRequest {
  return (
    isRecord(v) &&
    isStr(v.workspaceId) &&
    isStr(v.name) &&
    isStrOrEmpty(v.contentBase64) &&
    (v.mime === undefined || isStrOrEmpty(v.mime))
  );
}

export function isGenerateOfficeRequest(v: unknown): v is GenerateOfficeRequest {
  if (!isRecord(v)) return false;
  const formats = ['docx', 'xlsx', 'pptx', 'pdf', 'markdown'];
  return (
    isStr(v.workspaceId) &&
    isStr(v.title) &&
    isStrOrEmpty(v.content) &&
    formats.includes(String(v.format))
  );
}

export function isResearchRequest(v: unknown): v is ResearchRequest {
  return isRecord(v) && isStr(v.workspaceId) && isStr(v.topic);
}

export function isDeployWebsiteRequest(v: unknown): v is DeployWebsiteRequest {
  return isRecord(v) && isStr(v.workspaceId) && isStr(v.description) && v.confirm === true;
}

export function isCreateScheduleRequest(v: unknown): v is CreateScheduleRequest {
  if (!isRecord(v)) return false;
  const triggers = ['cron', 'interval', 'once'];
  return (
    isStr(v.workspaceId) &&
    isStr(v.name) &&
    isStr(v.expression) &&
    triggers.includes(String(v.trigger)) &&
    isRecord(v.action)
  );
}

export function isOptimizePromptRequest(v: unknown): v is OptimizePromptRequest {
  return isRecord(v) && isStr(v.workspaceId) && isStr(v.intent);
}

export function isCreateWidgetRequest(v: unknown): v is CreateWidgetRequest {
  return isRecord(v) && isStr(v.workspaceId) && isStr(v.naturalLanguage);
}

export function isSendMessageRequest(v: unknown): v is SendMessageRequest {
  return isRecord(v) && isStr(v.conversationId) && isStr(v.content);
}

/* ================================================================== */
/* Phase 2 校验器                                                      */
/* ================================================================== */

export function isCompactRequest(v: unknown): v is CompactConversationRequest {
  if (v === undefined || v === null) return true;
  if (!isRecord(v)) return false;
  if (v.force !== undefined && typeof v.force !== 'boolean') return false;
  if (v.keepRecent !== undefined && (typeof v.keepRecent !== 'number' || v.keepRecent < 1 || v.keepRecent > 500)) return false;
  return true;
}

export function isRunGoalRequest(v: unknown): v is RunGoalRequest {
  if (v === undefined || v === null) return true;
  if (!isRecord(v)) return false;
  if (v.maxIterations !== undefined && (typeof v.maxIterations !== 'number' || v.maxIterations < 1 || v.maxIterations > 200)) return false;
  if (v.mode !== undefined && !['single', 'parallel', 'cluster'].includes(String(v.mode))) return false;
  return true;
}

export function isClusterConfigRequest(v: unknown): v is UpdateClusterConfigRequest {
  if (!isRecord(v)) return false;
  if (v.mode !== undefined && !['single', 'parallel', 'cluster'].includes(String(v.mode))) return false;
  if (v.maxParallel !== undefined && (typeof v.maxParallel !== 'number' || v.maxParallel < 1 || v.maxParallel > 32)) return false;
  if (v.experimental !== undefined && typeof v.experimental !== 'boolean') return false;
  return Object.keys(v).length > 0;
}

export function isSendAgentMessageRequest(v: unknown): v is SendAgentMessageRequest {
  if (!isRecord(v)) return false;
  return isStr(v.content) && v.content.length <= 8000;
}

export function isAssignTaskRequest(v: unknown): v is AssignTaskRequest {
  if (!isRecord(v)) return false;
  if (!isStr(v.agentId)) return false;
  return v.preempt === undefined || typeof v.preempt === 'boolean';
}

export function isOfficeReadRequest(v: unknown): v is OfficeReadRequest {
  return isRecord(v) && isStr(v.workspaceId) && isStr(v.path);
}

export function isOfficeConvertRequest(v: unknown): v is OfficeConvertRequest {
  if (!isRecord(v)) return false;
  const formats = ['docx', 'xlsx', 'pptx', 'pdf', 'markdown'];
  return isStr(v.workspaceId) && isStr(v.path) && formats.includes(String(v.target));
}

export function isOfficeEditRequest(v: unknown): v is OfficeEditRequest {
  if (!isRecord(v)) return false;
  if (!isStr(v.workspaceId) || !isStr(v.path)) return false;
  if (!Array.isArray(v.operations) || v.operations.length === 0 || v.operations.length > 500) return false;
  return v.operations.every((op) => {
    if (!isRecord(op)) return false;
    switch (String(op.op)) {
      case 'append':
        return isStr(op.text);
      case 'replace':
        return typeof op.find === 'string' && typeof op.replace === 'string';
      case 'setCell':
        return isStr(op.sheet) && isStr(op.cell) && (typeof op.value === 'string' || typeof op.value === 'number');
      case 'addSlide':
        return isStr(op.title) && Array.isArray(op.bullets) && (op.bullets as unknown[]).every(isStrOrEmpty);
      default:
        return false;
    }
  });
}

export function isCreateResearchRequestV2(v: unknown): v is CreateResearchRequest {
  if (!isRecord(v)) return false;
  if (!isStr(v.workspaceId) || !isStr(v.topic) || v.topic.length > 2000) return false;
  if (v.depth !== undefined && !['quick', 'standard', 'deep'].includes(String(v.depth))) return false;
  if (v.allowNetwork !== undefined && typeof v.allowNetwork !== 'boolean') return false;
  if (v.maxSources !== undefined && (typeof v.maxSources !== 'number' || v.maxSources < 1 || v.maxSources > 100)) return false;
  if (v.outputFormats !== undefined) {
    const formats = ['docx', 'xlsx', 'pptx', 'pdf', 'markdown'];
    if (!Array.isArray(v.outputFormats) || !v.outputFormats.every((f) => formats.includes(String(f)))) return false;
  }
  return true;
}

export function isPublishResearchRequest(v: unknown): v is PublishResearchRequest {
  if (!isRecord(v)) return false;
  if (!isStr(v.workspaceId)) return false;
  return v.public === undefined || typeof v.public === 'boolean';
}

/* ================================================================== */
/* Phase 3 校验器                                                      */
/* ================================================================== */

const PROVIDERS = ['vercel', 'cloudflare-pages', 'netlify', 'local-preview'];
const DB_PROVIDERS = ['neon', 'supabase', 'postgres', 'sqlite'];
const WIDGET_TYPES = ['task-progress', 'agent-status', 'file-list', 'website-status', 'schedule-status', 'data-query', 'prompt-template'];
const NOTIFY_TYPES = ['desktop', 'email', 'webhook', 'feishu', 'dingtalk', 'wecom'];
const SCHEDULE_TASK_TYPES = ['goal', 'research', 'office', 'deploy', 'db-query', 'custom'];

export function isCreateWebsiteProjectRequest(v: unknown): v is { workspaceId: string; name: string; description?: string; requirement?: string; databaseConnectionId?: string | null } {
  if (!isRecord(v)) return false;
  if (!isStr(v.workspaceId) || !isStr(v.name)) return false;
  if (v.description !== undefined && !isStrOrEmpty(v.description)) return false;
  if (v.requirement !== undefined && !isStrOrEmpty(v.requirement)) return false;
  if (v.databaseConnectionId !== undefined && v.databaseConnectionId !== null && !isStr(v.databaseConnectionId)) return false;
  return true;
}

export function isGenerateWebsiteRequest(v: unknown): v is { requirement?: string } {
  if (v === undefined || v === null) return true;
  return isRecord(v) && (v.requirement === undefined || isStrOrEmpty(v.requirement));
}

export function isDeployRequest(v: unknown): v is { provider: string; confirm: boolean } {
  if (!isRecord(v)) return false;
  return PROVIDERS.includes(String(v.provider)) && v.confirm === true;
}

export function isConfirmRequest(v: unknown): v is { confirm: boolean } {
  return isRecord(v) && v.confirm === true;
}

export function isRollbackRequest(v: unknown): v is { deploymentId: string; confirm: boolean } {
  if (!isRecord(v)) return false;
  return isStr(v.deploymentId) && v.confirm === true;
}

export function isDeleteDeploymentRequest(v: unknown): v is { deploymentId: string; confirm: boolean } {
  if (!isRecord(v)) return false;
  return isStr(v.deploymentId) && v.confirm === true;
}

export function isDomainRequest(v: unknown): v is { domain: string; provider?: string; confirm: boolean } {
  if (!isRecord(v)) return false;
  if (!isStr(v.domain) || v.confirm !== true) return false;
  return v.provider === undefined || PROVIDERS.includes(String(v.provider));
}

export function isAccessRequest(v: unknown): v is { rules: { type: string; value: string }[]; confirm: boolean } {
  if (!isRecord(v)) return false;
  if (v.confirm !== true || !Array.isArray(v.rules)) return false;
  return v.rules.every((r) => isRecord(r) && ['password', 'email-allowlist', 'ip-allowlist'].includes(String(r.type)) && isStrOrEmpty(r.value));
}

export function isEnvVarRequest(v: unknown): v is { vars: { key: string; value: string }[]; confirm: boolean } {
  if (!isRecord(v)) return false;
  if (v.confirm !== true || !Array.isArray(v.vars) || v.vars.length === 0) return false;
  return v.vars.every((x) => isRecord(x) && isStr(x.key) && typeof x.value === 'string');
}

export function isCreateDatabaseRequest(v: unknown): v is { workspaceId: string; provider: string; name: string; connectionString: string; branch?: string; note?: string } {
  if (!isRecord(v)) return false;
  if (!isStr(v.workspaceId) || !isStr(v.name) || !isStr(v.connectionString)) return false;
  if (!DB_PROVIDERS.includes(String(v.provider))) return false;
  if (v.branch !== undefined && !isStrOrEmpty(v.branch)) return false;
  return true;
}

export function isQueryRequest(v: unknown): v is { sql: string; params?: unknown[]; readOnly?: boolean; limit?: number; confirm?: boolean } {
  if (!isRecord(v)) return false;
  if (!isStr(v.sql)) return false;
  if (v.params !== undefined && !Array.isArray(v.params)) return false;
  if (v.readOnly !== undefined && typeof v.readOnly !== 'boolean') return false;
  if (v.limit !== undefined && (typeof v.limit !== 'number' || v.limit < 1 || v.limit > 2000)) return false;
  if (v.confirm !== undefined && typeof v.confirm !== 'boolean') return false;
  return true;
}

export function isCreateSchemaRequest(v: unknown): v is { sql?: string; downSql?: string; name?: string; withRls?: boolean } {
  if (v === undefined || v === null) return true;
  if (!isRecord(v)) return false;
  if (v.sql !== undefined && !isStr(v.sql)) return false;
  if (v.downSql !== undefined && !isStr(v.downSql)) return false;
  if (v.withRls !== undefined && typeof v.withRls !== 'boolean') return false;
  return true;
}

export function isMigrationRequest(v: unknown): v is { migrationId: string; confirm: boolean } {
  if (!isRecord(v)) return false;
  return isStr(v.migrationId) && v.confirm === true;
}

export function isCreateDashboardRequest(v: unknown): v is { workspaceId: string; name: string; description?: string } {
  return isRecord(v) && isStr(v.workspaceId) && isStr(v.name);
}

export function isCreateWidgetRequestV3(v: unknown): v is {
  workspaceId: string;
  dashboardId?: string;
  naturalLanguage?: string;
  type?: string;
  title?: string;
  config?: Record<string, unknown>;
  layout?: { x: number; y: number; w: number; h: number };
  pinnedToDesktop?: boolean;
  refreshIntervalMs?: number;
} {
  if (!isRecord(v)) return false;
  if (!isStr(v.workspaceId)) return false;
  const hasNl = isStr(v.naturalLanguage);
  const hasType = isStr(v.type);
  if (!hasNl && !hasType) return false;
  if (hasType && !WIDGET_TYPES.includes(String(v.type))) return false;
  if (v.dashboardId !== undefined && !isStr(v.dashboardId)) return false;
  if (v.layout !== undefined) {
    if (!isRecord(v.layout)) return false;
    const l = v.layout;
    if (![l.x, l.y, l.w, l.h].every((n) => typeof n === 'number')) return false;
  }
  if (v.refreshIntervalMs !== undefined && (typeof v.refreshIntervalMs !== 'number' || v.refreshIntervalMs < 1000)) return false;
  return true;
}

export function isUpdateWidgetRequest(v: unknown): v is {
  title?: string;
  config?: Record<string, unknown>;
  layout?: { x: number; y: number; w: number; h: number };
  pinnedToDesktop?: boolean;
  refreshIntervalMs?: number;
  enabled?: boolean;
} {
  if (!isRecord(v)) return false;
  if (v.title !== undefined && !isStr(v.title)) return false;
  if (v.config !== undefined && !isRecord(v.config)) return false;
  if (v.layout !== undefined) {
    if (!isRecord(v.layout)) return false;
    const l = v.layout;
    if (![l.x, l.y, l.w, l.h].every((n) => typeof n === 'number')) return false;
  }
  if (v.refreshIntervalMs !== undefined && (typeof v.refreshIntervalMs !== 'number' || v.refreshIntervalMs < 1000)) return false;
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') return false;
  return true;
}

export function isSaveLayoutRequest(v: unknown): v is { items: { id: string; x: number; y: number; w: number; h: number }[]; compact?: boolean } {
  if (!isRecord(v)) return false;
  if (!Array.isArray(v.items)) return false;
  return v.items.every((i) => isRecord(i) && isStr(i.id) && [i.x, i.y, i.w, i.h].every((n) => typeof n === 'number'));
}

export function isCreateScheduleRequestV3(v: unknown): v is {
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
  retryPolicy?: { maxRetry?: number; baseDelayMs?: number; factor?: number; maxDelayMs?: number };
  enabled?: boolean;
} {
  if (!isRecord(v)) return false;
  if (!isStr(v.workspaceId) || !isStr(v.name) || !isStr(v.expression)) return false;
  if (!['cron', 'interval', 'once'].includes(String(v.trigger))) return false;
  if (v.taskType !== undefined && !SCHEDULE_TASK_TYPES.includes(String(v.taskType))) return false;
  if (v.taskConfig !== undefined && !isRecord(v.taskConfig)) return false;
  if (v.channelIds !== undefined && !(Array.isArray(v.channelIds) && v.channelIds.every(isStr))) return false;
  return true;
}

export function isUpdateScheduleRequest(v: unknown): v is {
  name?: string;
  expression?: string;
  timezone?: string;
  taskConfig?: Record<string, unknown>;
  channelIds?: string[];
  retryPolicy?: { maxRetry?: number; baseDelayMs?: number; factor?: number; maxDelayMs?: number };
  enabled?: boolean;
} {
  if (!isRecord(v)) return false;
  if (v.name !== undefined && !isStr(v.name)) return false;
  if (v.expression !== undefined && !isStr(v.expression)) return false;
  if (v.taskConfig !== undefined && !isRecord(v.taskConfig)) return false;
  if (v.channelIds !== undefined && !(Array.isArray(v.channelIds) && v.channelIds.every(isStr))) return false;
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') return false;
  return true;
}

export function isCronPreviewRequest(v: unknown): v is { expression: string; timezone?: string } {
  return isRecord(v) && isStr(v.expression) && (v.timezone === undefined || isStr(v.timezone));
}

export function isCreateNotifyChannelRequest(v: unknown): v is {
  workspaceId: string;
  type: string;
  name: string;
  config?: Record<string, unknown>;
  secret?: Record<string, unknown>;
  enabled?: boolean;
} {
  if (!isRecord(v)) return false;
  if (!isStr(v.workspaceId) || !isStr(v.name)) return false;
  if (!NOTIFY_TYPES.includes(String(v.type))) return false;
  if (v.config !== undefined && !isRecord(v.config)) return false;
  if (v.secret !== undefined && !isRecord(v.secret)) return false;
  return true;
}

export function isUpdateNotifyChannelRequest(v: unknown): v is {
  name?: string;
  config?: Record<string, unknown>;
  secret?: Record<string, unknown>;
  enabled?: boolean;
} {
  if (!isRecord(v)) return false;
  if (v.name !== undefined && !isStr(v.name)) return false;
  if (v.config !== undefined && !isRecord(v.config)) return false;
  if (v.secret !== undefined && !isRecord(v.secret)) return false;
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') return false;
  return v.name !== undefined || v.config !== undefined || v.secret !== undefined || v.enabled !== undefined;
}

export function isTestNotifyRequest(v: unknown): v is { channelId: string } {
  return isRecord(v) && isStr(v.channelId);
}

export function isSendNotifyRequest(v: unknown): v is { workspaceId: string; message: { event: string; title: string; content: string; url?: string; level?: string }; channelIds?: string[] } {
  if (!isRecord(v)) return false;
  if (!isStr(v.workspaceId) || !isRecord(v.message)) return false;
  const m = v.message;
  if (!isStr(m.event) || !isStr(m.title) || isStrOrEmpty(m.content) === false) return false;
  if (m.content === undefined) return false;
  return true;
}
