import type { NotifyChannelType, NotifyMessage } from '@ai/shared';
import { BaseNotifier, type NotifierContext, type SendResult } from './notifier.ts';

/** 通用 Webhook：POST JSON 到自定义 URL；可选自定义 header（用于鉴权） */
export class WebhookNotifier extends BaseNotifier {
  readonly type: NotifyChannelType = 'webhook';
  readonly label = 'Webhook';
  readonly secretFields = [
    { key: 'url', label: 'Webhook 地址', required: true, hint: 'https://your-endpoint/hook' },
    { key: 'authHeader', label: '鉴权 Header 值', required: false, hint: '例如 Bearer xxx，会以 Authorization 发送' },
  ];
  readonly configFields = [
    { key: 'method', label: 'HTTP 方法', required: false, type: 'string' as const, hint: '默认 POST' },
    { key: 'headers', label: '附加 Header（JSON）', required: false, type: 'string' as const },
  ];

  async send(message: NotifyMessage, ctx: NotifierContext): Promise<SendResult> {
    const url = String(ctx.secret.url ?? '');
    const method = String(ctx.config.method ?? 'POST').toUpperCase();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const extra = ctx.config.headers;
    if (extra && typeof extra === 'string' && extra.trim()) {
      try {
        Object.assign(headers, JSON.parse(extra) as Record<string, string>);
      } catch {
        throw new Error('附加 Header 不是合法 JSON');
      }
    }
    if (ctx.secret.authHeader) headers.authorization = String(ctx.secret.authHeader);

    const res = await this.withTimeout(
      fetch(url, {
        method,
        headers,
        body: JSON.stringify({
          event: message.event,
          title: message.title,
          content: message.content,
          url: message.url ?? null,
          level: message.level ?? 'info',
          at: new Date().toISOString(),
          text: this.render(message),
        }),
      }),
    );
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Webhook 返回 HTTP ${res.status}: ${text.slice(0, 200)}`);
    return { ok: true, detail: { status: res.status, body: text.slice(0, 200) } };
  }
}
