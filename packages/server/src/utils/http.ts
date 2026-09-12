import type { Context } from 'hono';
import { ErrorCode, type ApiErrorBody, type ApiOkBody } from '@ai/shared';
import { AppError, toAppError } from './errors.ts';
import { newId } from './ids.ts';

export function traceId(c: Context): string {
  return c.req.header('x-trace-id') ?? newId('trace');
}

export function ok<T>(c: Context, data: T, status = 200) {
  const body: ApiOkBody<T> = { ok: true, data, traceId: traceId(c) };
  return c.json(body, status as never);
}

export function fail(c: Context, e: unknown) {
  const err = toAppError(e);
  const body: ApiErrorBody = {
    ok: false,
    error: { code: err.code, message: err.message, details: err.details, traceId: traceId(c) },
  };
  return c.json(body, err.status as never);
}

/** 统一 JSON 请求体解析：schema 校验失败一律 400 + 字段路径 */
export async function parseJson<T>(c: Context, validate: (v: unknown) => v is T, label = 'body'): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw AppError.badRequest(`请求体不是合法 JSON（${label}）`);
  }
  if (!validate(raw)) throw AppError.badRequest(`请求体字段缺失或类型错误（${label}）`);
  return raw;
}

export { ErrorCode };
