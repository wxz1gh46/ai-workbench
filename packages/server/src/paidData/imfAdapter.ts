import type { PaidDataProviderSpec } from '@ai/shared';
import { AppError } from '../utils/errors.ts';
import { PaidDataAdapter, type AdapterContext, type AdapterResult } from './adapterBase.ts';

/**
 * IMF 开放数据适配器（无需凭据，官方开放接口）。
 *
 * 说明：使用 IMF 官方 DataMapper/SDMX 风格接口，形如
 *   https://www.imf.org/external/datamapper/api/v1/<INDICATOR>/<COUNTRY>
 * 未配置任何密钥也能用；仍然走本地限流，避免高频打扰对方。
 */
export class ImfAdapter extends PaidDataAdapter {
  readonly providerId = 'imf';

  constructor(spec: PaidDataProviderSpec) {
    super(spec);
  }

  async query(action: string, params: Record<string, unknown>, ctx: AdapterContext): Promise<AdapterResult> {
    const base = ctx.credentials.baseUrl?.trim() || 'https://www.imf.org/external/datamapper/api/v1';
    if (action === 'macro.dataset') {
      try {
        const raw = await this.http(ctx, `${base.replace(/\/$/, '')}/indicators`);
        return { data: raw, citations: [this.citation('IMF DataMapper · 指标列表', this.spec.docsUrl)], degraded: false };
      } catch (e) {
        return this.degraded(`IMF 接口调用失败（${e instanceof Error ? e.message : String(e)}）。`);
      }
    }
    if (action !== 'macro.series') throw AppError.badRequest(`IMF 适配器不支持动作：${action}`);
    const indicator = String(params.indicator ?? '').trim().toUpperCase();
    if (!indicator) throw AppError.badRequest('缺少必填参数：indicator（指标代码，如 NGDP_RPCH）');
    if (!/^[A-Z0-9_]+$/.test(indicator)) throw AppError.badRequest(`指标代码不合法：${indicator}`);
    const country = params.country ? String(params.country).toUpperCase() : '';
    if (country && !/^[A-Z,]+$/.test(country)) throw AppError.badRequest(`国家代码不合法：${country}`);

    const url = `${base.replace(/\/$/, '')}/${indicator}${country ? `/${country}` : ''}`;
    try {
      const raw = await this.http(ctx, url);
      return { data: raw, citations: [this.citation(`IMF DataMapper · ${indicator}`, this.spec.docsUrl)], degraded: false };
    } catch (e) {
      return this.degraded(`IMF 接口调用失败（${e instanceof Error ? e.message : String(e)}）。`);
    }
  }
}
