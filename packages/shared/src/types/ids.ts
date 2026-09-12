/**
 * 全局 ID 与基础类型。
 * 统一使用 string ID（ULID/UUID 由服务端生成），避免跨端 bigint 序列化问题。
 */
export type Id = string;

export type IsoDateTime = string;

/** 统一错误码，前端可按码做差异化处理 */
export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  TOOL_ERROR: 'TOOL_ERROR',
  TIMEOUT: 'TIMEOUT',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 统一错误响应格式：所有 API 失败都返回该结构 */
export interface ApiErrorBody {
  ok: false;
  error: {
    code: ErrorCodeValue;
    message: string;
    /** 机器可读的补充信息，如缺失的字段名 */
    details?: unknown;
    traceId: string;
  };
}

/** 统一成功响应格式 */
export interface ApiOkBody<T> {
  ok: true;
  data: T;
  traceId: string;
}

export type ApiResponse<T> = ApiOkBody<T> | ApiErrorBody;
