import type { NotifyChannelType, NotifyMessage } from '@ai/shared';
import { BaseNotifier, type NotifierContext, type SendResult } from './notifier.ts';

/**
 * 企业微信群机器人。
 * 文档：https://developer.work.weixin.qq.com/document/path/91770
 * 注意：markdown 类型不支持颜色；这里用 text 保证兼容性。
 */
export class WecomNotifier extends BaseNotifier {
  readonly type: NotifyChannelType = 'wecom';
  readonly label = '企业微信';
  readonly secretFields = [
    { key: 'webhookUrl', label: '机器人 Webhook 地址', required: true, hint: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx' },
  ];
  readonly configFields = [
    { key: 'mentionedList', label: '@ 成员 userid 列表', required: false, type: 'string[]' as const, hint: '如 zhangsan,lisi；填 @all 表示所有人' },
  ];

  async send(message: NotifyMessage, ctx: NotifierContext): Promise<SendResult> {
    const url = String(ctx.secret.webhookUrl ?? '');
    const mentioned = Array.isArray(ctx.config.mentionedList) ? (ctx.config.mentionedList as string[]) : [];
    const body = {
      msgtype: 'text',
      text: {
        content: this.render(message),
        ...(mentioned.length ? { mentioned_list: mentioned } : {}),
      },
    };
    const res = await this.withTimeout(
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    );
    const json = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
    if (!res.ok || (json.errcode ?? 0) !== 0) {
      throw new Error(`企业微信返回失败（HTTP ${res.status} errcode=${json.errcode}）：${json.errmsg ?? ''}`);
    }
    return { ok: true, detail: { errcode: 0 } };
  }
}
