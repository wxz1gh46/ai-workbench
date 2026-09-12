import type { PaidDataProviderSpec } from '@ai/shared';
import { AppError } from '../utils/errors.ts';
import { PaidDataAdapter, type AdapterContext, type AdapterResult } from './adapterBase.ts';

/** 恒生聚源适配器（官方 API，apiKey 鉴权） */
export class HsjyAdapter extends PaidDataAdapter {
  readonly providerId = 'hs-juyuan';

  constructor(spec: PaidDataProviderSpec) {
    super(spec);
  }

  async query(action: string, params: Record<string, unknown>, ctx: AdapterContext): Promise<AdapterResult> {
    const missing = this.missingCredentials(ctx.credentials);
    if (missing.length > 0) return this.degraded(`未配置恒生聚源凭据（缺少 ${missing.join(', ')}）。`);
    if (action !== 'finance.query') throw AppError.badRequest(`恒生聚源适配器不支持动作：${action}`);
    const table = String(params.table ?? '').trim();
    if (!table) throw AppError.badRequest('缺少必填参数：table（数据表）');
    if (!/^[A-Za-z0-9_.]+$/.test(table)) {
      // 防注入：表名只允许字母数字下划线点，杜绝拼 SQL
      throw AppError.badRequest(`数据表名不合法：${table}`);
    }
    const base = ctx.credentials.baseUrl?.trim() || 'https://api.hscloud.cn';
    const url = `${base.replace(/\/$/, '')}/data/v1/query?table=${encodeURIComponent(table)}${params.filter ? `&filter=${encodeURIComponent(String(params.filter))}` : ''}`;
    try {
      const raw = await this.http(ctx, url, { headers: { 'x-api-key': ctx.credentials.apiKey! } });
      return { data: raw, citations: [this.citation(`恒生聚源 · ${table}`, this.spec.docsUrl)], degraded: false };
    } catch (e) {
      return this.degraded(`恒生聚源接口调用失败（${e instanceof Error ? e.message : String(e)}）。`);
    }
  }
}
