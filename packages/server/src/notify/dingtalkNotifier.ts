import { createHmac } from 'node:crypto';
import type { NotifyChannelType, NotifyMessage } from '@ai/shared';
import { BaseNotifier, type NotifierContext, type SendResult } from './notifier.ts';

/**
 * 钉钉自定义机器人。
 * 文档：https://open.dingtalk.com/document/robots/custom-robot-access
 * 安全设置：加签（推荐）/ 关键词 / IP 白名单。
 */
export class DingtalkNotifier extends BaseNotifier {
  readonly type: NotifyChannelType = 'dingtalk';
  readonly label = '钉钉';
  readonly secretFields = [
    { key: 'webhookUrl', label: '机器人 Webhook 地址', required: true, hint: 'https://oapi.dingtalk.com/robot/send?access_token=xxx' },
    { key: 'signSecret', label: '加签密钥（SEC 开头）', required: false, hint: '开启「加签」时必填' },
  ];
  readonly configFields = [{ key: 'keyword', label: '自定义关键词', required: false, type: 'string' as const }];

  async send(message: NotifyMessage, ctx: NotifierContext): Promise<SendResult> {
    let url = String(ctx.secret.webhookUrl ?? '');
    const sign = ctx.secret.signSecret ? String(ctx.secret.signSecret) : '';
    if (sign) {
      const timestamp = Date.now();
      const stringToSign = `${timestamp}\n${sign}`;
      const signature = encodeURIComponent(createHmac('sha256', sign).update(stringToSign).digest('base64'));
      url += `&timestamp=${timestamp}&sign=${signature}`;
    }
    const keyword = ctx.config.keyword ? String(ctx.config.keyword) : '';
    const text = this.render(message);
    const body = {
      msgtype: 'text',
      text: { content: keyword && !text.includes(keyword) ? `[${keyword}] ${text}` : text },
    };

    const res = await this.withTimeout(
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    );
    const json = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
    if (!res.ok || (json.errcode ?? 0) !== 0) {
      throw new Error(`钉钉返回失败（HTTP ${res.status} errcode=${json.errcode}）：${json.errmsg ?? ''}`);
    }
    return { ok: true, detail: { errcode: 0 } };
  }
}
