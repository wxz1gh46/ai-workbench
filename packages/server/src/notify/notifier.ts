import type { NotifyChannelType, NotifyMessage } from '@ai/shared';
import { AppError } from '../utils/errors.ts';

/**
 * 通知渠道抽象（Step 6）。
 *
 * 所有渠道实现同一接口：
 *   - send() 只负责「发出」，失败必须抛出可读错误（由 NotifyService 统一重试与记录）；
 *   - validateConfig() 在保存渠道时校验必填字段（避免上线后才发现配错）；
 *   - describe() 给 UI 用，说明需要哪些凭据（凭据值永不返回）。
 */

export interface NotifierContext {
  /** 渠道非敏感配置 */
  config: Record<string, unknown>;
  /** 渠道敏感配置（已解密，仅在内存中存在） */
  secret: Record<string, unknown>;
  /** 通知渠道 id，用于桌面通知去重 */
  channelId: string;
}

export interface SendResult {
  ok: boolean;
  /** 平台返回的追踪 id（飞书/钉钉有 message_id） */
  messageId?: string;
  detail?: Record<string, unknown>;
  /** 是否为降级发送（例如桌面通知在无 Tauri 环境下只记录不弹出） */
  degraded?: boolean;
}

export interface Notifier {
  readonly type: NotifyChannelType;
  readonly label: string;
  /** 渠道需要用户手动配置的敏感字段（用于 UI 提示与校验） */
  readonly secretFields: { key: string; label: string; required: boolean; hint?: string }[];
  readonly configFields: { key: string; label: string; required: boolean; type: 'string' | 'number' | 'string[]'; hint?: string }[];
  validate(ctx: NotifierContext): void;
  send(message: NotifyMessage, ctx: NotifierContext): Promise<SendResult>;
}

export abstract class BaseNotifier implements Notifier {
  abstract readonly type: NotifyChannelType;
  abstract readonly label: string;
  abstract readonly secretFields: { key: string; label: string; required: boolean; hint?: string }[];
  abstract readonly configFields: { key: string; label: string; required: boolean; type: 'string' | 'number' | 'string[]'; hint?: string }[];

  validate(ctx: NotifierContext): void {
    const missing: string[] = [];
    for (const f of this.secretFields) {
      if (!f.required) continue;
      const v = ctx.secret[f.key];
      if (v === undefined || v === null || String(v).trim() === '') missing.push(`敏感配置 ${f.label}(${f.key})`);
    }
    for (const f of this.configFields) {
      if (!f.required) continue;
      const v = ctx.config[f.key];
      if (v === undefined || v === null || (Array.isArray(v) && v.length === 0) || String(v).trim() === '') {
        missing.push(`配置 ${f.label}(${f.key})`);
      }
    }
    if (missing.length > 0) {
      // 必须是 400 而不是 500：这是用户配置问题，不是服务端故障
      throw AppError.badRequest(`${this.label} 渠道配置不完整，缺少：${missing.join('、')}`, {
        channelType: this.type,
        missing,
      });
    }
  }

  abstract send(message: NotifyMessage, ctx: NotifierContext): Promise<SendResult>;

  /** 统一的文本渲染：把消息转成多渠道通用的纯文本 */
  protected render(message: NotifyMessage): string {
    const icon = message.level === 'error' ? '❌' : message.level === 'warning' ? '⚠️' : message.level === 'success' ? '✅' : 'ℹ️';
    const lines = [`${icon} ${message.title}`, '', message.content];
    if (message.url) lines.push('', `🔗 ${message.url}`);
    return lines.join('\n');
  }

  /** 超时包装：所有外部推送必须带超时，避免挂死调度线程 */
  protected async withTimeout<T>(p: Promise<T>, ms = 15_000, label = this.label): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 请求超时（${ms}ms）`)), ms)),
    ]);
  }
}
