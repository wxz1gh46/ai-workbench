import type { PaidDataProviderSpec } from '@ai/shared';
import { AppError } from '../utils/errors.ts';
import { PaidDataAdapter, type AdapterContext, type AdapterResult } from './adapterBase.ts';

/** 华宇元典法律数据库适配器（官方 API，token 鉴权） */
export class HyydAdapter extends PaidDataAdapter {
  readonly providerId = 'hyyd-legal';

  constructor(spec: PaidDataProviderSpec) {
    super(spec);
  }

  async query(action: string, params: Record<string, unknown>, ctx: AdapterContext): Promise<AdapterResult> {
    const missing = this.missingCredentials(ctx.credentials);
    if (missing.length > 0) return this.degraded(`未配置华宇元典凭据（缺少 ${missing.join(', ')}）。`);
    const paths: Record<string, string> = { 'legal.search': '/open/api/v1/law/search', 'legal.case': '/open/api/v1/case/search' };
    const path = paths[action];
    if (!path) throw AppError.badRequest(`华宇元典适配器不支持动作：${action}`);
    const keyword = String(params.keyword ?? '').trim();
    if (!keyword) throw AppError.badRequest('缺少必填参数：keyword（关键词）');
    const base = ctx.credentials.baseUrl?.trim() || 'https://open.chineselaw.com';
    try {
      const raw = await this.http(ctx, `${base.replace(/\/$/, '')}${path}?keyword=${encodeURIComponent(keyword)}`, {
        headers: { authorization: `Bearer ${ctx.credentials.token}` },
      });
      return { data: raw, citations: [this.citation(`华宇元典 · ${action}`, this.spec.docsUrl)], degraded: false };
    } catch (e) {
      return this.degraded(`华宇元典接口调用失败（${e instanceof Error ? e.message : String(e)}）。`);
    }
  }
}
