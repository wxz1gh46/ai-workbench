import { AppError } from '../utils/errors.ts';
import type { PaidDataCitation, PaidDataProviderSpec } from '@ai/shared';

/**
 * 付费数据适配器基类（Phase 4 Step 2）。
 *
 * 统一契约：
 *   - query(action, params, ctx) → { data, citations, degraded }
 *   - 只允许调用 provider.accessMethods 里声明的接入方式（合规守卫在 QueryRunner 层强制）
 *   - 未配置凭据时**显式降级**：返回 degraded=true + 空数据 + 可读说明，
 *     绝不返回「看起来像真数据」的占位内容（这是最危险的一类假成功）
 */

export interface AdapterContext {
  providerId: string;
  /** 解密后的用户凭据（仅在内存中短暂存在，不落日志） */
  credentials: Record<string, string>;
  /** 注入的 fetch，便于测试（默认全局 fetch） */
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}

export interface AdapterResult {
  data: unknown;
  citations: PaidDataCitation[];
  degraded: boolean;
  /** 降级/部分成功时的说明，必须能让用户看懂「为什么没有真数据」 */
  note?: string;
}

export abstract class PaidDataAdapter {
  abstract readonly providerId: string;

  constructor(protected readonly spec: PaidDataProviderSpec) {}

  /** 凭据是否齐备：缺失时返回缺失字段名，调用方给出可读错误 */
  missingCredentials(credentials: Record<string, string>): string[] {
    return this.spec.credentialFields.filter((f) => f.required && !credentials[f.key]?.trim()).map((f) => f.key);
  }

  /** 未配置凭据时的统一降级结果 */
  protected degraded(reason: string): AdapterResult {
    return { data: null, citations: [], degraded: true, note: reason };
  }

  protected citation(title: string, url: string, providerName = this.spec.name): PaidDataCitation {
    return { title, url, accessedAt: new Date().toISOString(), provider: providerName };
  }

  /** 统一 HTTP 调用（带超时、错误可读、不泄露凭据） */
  protected async http(
    ctx: AdapterContext,
    url: string,
    init: RequestInit & { headers?: Record<string, string> } = {},
  ): Promise<unknown> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(ctx.timeoutMs) });
    } catch (e) {
      // 网络错误：把原因说清楚（超时 / DNS / 连接拒绝），但不要带 URL 查询串（可能含凭据）
      const msg = e instanceof Error ? e.message : String(e);
      throw AppError.provider(`${this.spec.name} 请求失败：${msg}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw AppError.provider(`${this.spec.name} 返回 ${res.status}：${text.slice(0, 200)}`);
    }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }

  abstract query(action: string, params: Record<string, unknown>, ctx: AdapterContext): Promise<AdapterResult>;
}

/** 桩适配器：用于「已声明接入方式但未配置凭据/未联调」的 provider */
export class StubAdapter extends PaidDataAdapter {
  readonly providerId: string;

  constructor(spec: PaidDataProviderSpec) {
    super(spec);
    this.providerId = spec.id;
  }

  async query(action: string, _params: Record<string, unknown>, ctx: AdapterContext): Promise<AdapterResult> {
    const missing = this.missingCredentials(ctx.credentials);
    if (missing.length > 0) {
      return this.degraded(`未配置凭据（缺少 ${missing.join(', ')}），已按未配置处理。请在「付费数据库」面板填写后再查询。`);
    }
    if (!this.spec.actions.some((a) => a.name === action)) {
      throw AppError.badRequest(`${this.spec.name} 不支持动作：${action}（可用：${this.spec.actions.map((a) => a.name).join(', ')}）`);
    }
    return this.degraded(
      `凭据已配置，但 ${this.spec.name} 的真实接口需要在你的账号下联调（本工作台不代持账号、不在无凭据时伪造数据）。接入方式：${this.spec.accessMethods.join(' / ')}`,
    );
  }
}
