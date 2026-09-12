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
