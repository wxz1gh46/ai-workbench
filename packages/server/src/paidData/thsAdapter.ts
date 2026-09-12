import type { PaidDataProviderSpec } from '@ai/shared';
import { AppError } from '../utils/errors.ts';
import { PaidDataAdapter, type AdapterContext, type AdapterResult } from './adapterBase.ts';

/**
 * 同花顺 iFinD 开放平台适配器。
 *
 * 仅使用官方开放平台 HTTP 接口（accessMethods 里声明的那一条）。
 * 鉴权方式：appKey + appSecret 计算 sha256 签名（与官方 v1 接口一致的做法），
 * 此处保持「参数结构与签名算法显式可见」，避免黑盒。
 */
export class ThsAdapter extends PaidDataAdapter {
  readonly providerId = 'tonghuashun';

  constructor(spec: PaidDataProviderSpec) {
    super(spec);
  }

  async query(action: string, params: Record<string, unknown>, ctx: AdapterContext): Promise<AdapterResult> {
    const missing = this.missingCredentials(ctx.credentials);
    if (missing.length > 0) {
      return this.degraded(`未配置同花顺凭据（缺少 ${missing.join(', ')}）。请在同花顺开放平台申请后，在「付费数据库」面板填写。`);
    }
    const base = ctx.credentials.baseUrl?.trim() || 'https://ft.10jqka.com.cn';
    const appKey = ctx.credentials.appKey!;
    const appSecret = ctx.credentials.appSecret!;

    const paths: Record<string, { path: string; params: Record<string, unknown> }> = {
      'market.quote': { path: '/api/v1/market/quote', params: { code: params.symbol } },
      'finance.report': { path: '/api/v1/finance/report', params: { code: params.symbol, period: params.period ?? 'latest' } },
      'company.announcement': { path: '/api/v1/company/announcement', params: { code: params.symbol } },
    };
    const target = paths[action];
    if (!target) throw AppError.badRequest(`同花顺适配器不支持动作：${action}`);
    if (!target.params.code) throw AppError.badRequest('缺少必填参数：symbol（证券代码）');

    const { createHash } = await import('node:crypto');
    const ts = Date.now().toString();
    const signature = createHash('sha256').update(`${appKey}${ts}${appSecret}`).digest('hex');

    const url = `${base.replace(/\/$/, '')}${target.path}`;
    const body = {
      app_key: appKey,
      timestamp: ts,
      signature,
      params: target.params,
    };
    let raw: unknown;
    try {
      raw = await this.http(ctx, url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // 未联调 / 网络不可达：显式降级而不是抛 500，让用户能继续用其他数据源
      const msg = e instanceof Error ? e.message : String(e);
      return this.degraded(`同花顺接口调用失败（${msg}）。请检查账号配额、IP 白名单与网络出口。`);
    }
    return {
      data: raw,
      citations: [this.citation(`同花顺 iFinD · ${action}`, this.spec.docsUrl)],
      degraded: false,
    };
  }
}
