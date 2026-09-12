import type { PaidDataProviderSpec } from '@ai/shared';
import { AppError } from '../utils/errors.ts';
import { PaidDataAdapter, type AdapterContext, type AdapterResult } from './adapterBase.ts';

/**
 * 天眼查开放平台适配器。
 * 鉴权：官方要求的 Authorization: Token <token>。只在服务端使用，不回显。
 */
export class TycAdapter extends PaidDataAdapter {
  readonly providerId = 'tianyancha';

  constructor(spec: PaidDataProviderSpec) {
    super(spec);
  }

  async query(action: string, params: Record<string, unknown>, ctx: AdapterContext): Promise<AdapterResult> {
    const missing = this.missingCredentials(ctx.credentials);
    if (missing.length > 0) {
      return this.degraded(`未配置天眼查 Token（缺少 ${missing.join(', ')}）。请在 open.tianyancha.com 申请后填写。`);
    }
    const base = ctx.credentials.baseUrl?.trim() || 'https://open.api.tianyancha.com';
    const paths: Record<string, string> = {
      'company.basic': '/services/open/ic/baseinfo/normal',
      'company.justice': '/services/open/jr/lawSuit',
      'company.equity': '/services/open/ic/equity',
    };
    const path = paths[action];
    if (!path) throw AppError.badRequest(`天眼查适配器不支持动作：${action}`);
    const query = String(params.keyword ?? '').trim();
    if (!query) throw AppError.badRequest('缺少必填参数：keyword（企业名/关键词）');

    const url = `${base.replace(/\/$/, '')}${path}?keyword=${encodeURIComponent(query)}`;
    let raw: unknown;
    try {
      raw = await this.http(ctx, url, { headers: { authorization: `Token ${ctx.credentials.token}` } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return this.degraded(`天眼查接口调用失败（${msg}）。请检查 Token 有效期、套餐余额与调用频次。`);
    }
    return {
      data: raw,
      citations: [this.citation(`天眼查 · ${action}`, this.spec.docsUrl)],
      degraded: false,
    };
  }
}
