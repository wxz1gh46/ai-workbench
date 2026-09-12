import type {
  AdvanceGoalRequest,
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
