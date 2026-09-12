import type { PaidDataProviderSpec } from '@ai/shared';
import { AppError } from '../utils/errors.ts';
import { PaidDataAdapter, type AdapterContext, type AdapterResult } from './adapterBase.ts';

/**
 * 学术数据库适配器：Crossref / OpenAlex 官方开放接口（无需付费凭据）。
 * 支持可选的 mailto，进入 polite pool 以获得更稳定的配额。
 */
export class AcademicAdapter extends PaidDataAdapter {
  readonly providerId = 'academic';

  constructor(spec: PaidDataProviderSpec) {
    super(spec);
  }

  async query(action: string, params: Record<string, unknown>, ctx: AdapterContext): Promise<AdapterResult> {
    const mailto = (ctx.credentials.mailto ?? '').trim();
    const suffix = mailto ? `&mailto=${encodeURIComponent(mailto)}` : '';
    if (action === 'paper.search') {
      const query = String(params.query ?? '').trim();
      if (!query) throw AppError.badRequest('缺少必填参数：query（关键词）');
      const limit = Math.min(Math.max(Number(params.limit ?? 10), 1), 50);
      const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}${suffix}`;
      try {
        const raw = await this.http(ctx, url);
        return { data: raw, citations: [this.citation('Crossref 论文检索', 'https://api.crossref.org/')], degraded: false };
      } catch (e) {
        return this.degraded(`Crossref 调用失败（${e instanceof Error ? e.message : String(e)}）。`);
      }
    }
    if (action === 'paper.citations') {
      const doi = String(params.doi ?? '').trim();
      if (!doi) throw AppError.badRequest('缺少必填参数：doi');
      const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}${mailto ? `?mailto=${encodeURIComponent(mailto)}` : ''}`;
      try {
        const raw = await this.http(ctx, url);
        return { data: raw, citations: [this.citation(`OpenAlex · ${doi}`, 'https://api.openalex.org/')], degraded: false };
      } catch (e) {
        return this.degraded(`OpenAlex 调用失败（${e instanceof Error ? e.message : String(e)}）。`);
      }
    }
    throw AppError.badRequest(`学术适配器不支持动作：${action}`);
  }
}
