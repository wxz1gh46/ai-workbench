import type { PaidDataProviderSpec } from '@ai/shared';
import { AppError } from '../utils/errors.ts';
import { PaidDataAdapter, type AdapterContext, type AdapterResult } from './adapterBase.ts';

/** S&P Global Market Intelligence 适配器（官方 API，apiKey 鉴权） */
export class SpGlobalAdapter extends PaidDataAdapter {
  readonly providerId = 'sp-global';

  constructor(spec: PaidDataProviderSpec) {
    super(spec);
  }

  async query(action: string, params: Record<string, unknown>, ctx: AdapterContext): Promise<AdapterResult> {
    const missing = this.missingCredentials(ctx.credentials);
    if (missing.length > 0) return this.degraded(`未配置 S&P Global 凭据（缺少 ${missing.join(', ')}）。`);
    if (action !== 'market.intelligence') throw AppError.badRequest(`S&P Global 适配器不支持动作：${action}`);
    const query = String(params.query ?? '').trim();
    if (!query) throw AppError.badRequest('缺少必填参数：query（查询表达式）');
    const base = ctx.credentials.baseUrl?.trim() || 'https://api-ciq.marketintelligence.spglobal.com';
    const url = `${base.replace(/\/$/, '')}/gmds/v1/search?q=${encodeURIComponent(query)}${params.universe ? `&universe=${encodeURIComponent(String(params.universe))}` : ''}`;
    try {
      const raw = await this.http(ctx, url, { headers: { 'x-api-key': ctx.credentials.apiKey! } });
      return { data: raw, citations: [this.citation('S&P Global Market Intelligence', this.spec.docsUrl)], degraded: false };
    } catch (e) {
      return this.degraded(`S&P Global 接口调用失败（${e instanceof Error ? e.message : String(e)}）。`);
    }
  }
}
