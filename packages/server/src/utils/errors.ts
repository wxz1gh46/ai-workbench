import { ErrorCode, type ErrorCodeValue } from '@ai/shared';

/** 业务错误：带错误码，router 层统一序列化为 ApiErrorBody */
export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCodeValue, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(ErrorCode.BAD_REQUEST, message, 400, details);
  }
  static notFound(message: string) {
    return new AppError(ErrorCode.NOT_FOUND, message, 404);
  }
  static conflict(message: string) {
    return new AppError(ErrorCode.CONFLICT, message, 409);
  }
  static forbidden(message: string) {
    return new AppError(ErrorCode.FORBIDDEN, message, 403);
  }
  /** 危险操作缺少二次确认：428 让前端明确渲染确认弹窗 */
  static confirmRequired(message: string, details?: unknown) {
    return new AppError(ErrorCode.CONFIRM_REQUIRED, message, 428, details);
  }
  static internal(message: string, details?: unknown) {
    return new AppError(ErrorCode.INTERNAL, message, 500, details);
  }
  static provider(message: string, details?: unknown) {
    return new AppError(ErrorCode.PROVIDER_ERROR, message, 502, details);
  }
  static tool(message: string, details?: unknown) {
    return new AppError(ErrorCode.TOOL_ERROR, message, 500, details);
  }
}

export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof Error) return AppError.internal(e.message);
  return AppError.internal('未知错误', e);
}
