import { createHmac } from 'node:crypto';
import type { NotifyChannelType, NotifyMessage } from '@ai/shared';
import { BaseNotifier, type NotifierContext, type SendResult } from './notifier.ts';

/**
 * 飞书自定义机器人。
 * 文档：https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
 * 支持两种安全设置：签名校验（推荐）/ 自定义关键词。
 */
export class FeishuNotifier extends BaseNotifier {
  readonly type: NotifyChannelType = 'feishu';
  readonly label = '飞书';
  readonly secretFields = [
    { key: 'webhookUrl', label: '机器人 Webhook 地址', required: true, hint: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx' },
    { key: 'signSecret', label: '签名密钥', required: false, hint: '开启「签名校验」时必填' },
  ];
  readonly configFields = [
    { key: 'keyword', label: '自定义关键词', required: false, type: 'string' as const, hint: '开启关键词校验时用于拼接到标题' },
  ];

  async send(message: NotifyMessage, ctx: NotifierContext): Promise<SendResult> {
    const url = String(ctx.secret.webhookUrl ?? '');
    const keyword = ctx.config.keyword ? String(ctx.config.keyword) : '';
    const text = this.render(message);
    const body: Record<string, unknown> = {
      msg_type: 'text',
      content: { text: keyword && !text.includes(keyword) ? `[${keyword}] ${text}` : text },
    };
    const sign = ctx.secret.signSecret ? String(ctx.secret.signSecret) : '';
    if (sign) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      body.timestamp = timestamp;
      body.sign = createHmac('sha256', `${timestamp}\n${sign}`).update('').digest('base64');
    }

    const res = await this.withTimeout(
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    );
    const json = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; StatusCode?: number; data?: { message_id?: string } };
    const code = json.code ?? json.StatusCode ?? 0;
    if (!res.ok || code !== 0) {
      throw new Error(`飞书返回失败（HTTP ${res.status} code=${code}）：${json.msg ?? ''}`);
    }
    return { ok: true, messageId: json.data?.message_id, detail: { code } };
  }
}
