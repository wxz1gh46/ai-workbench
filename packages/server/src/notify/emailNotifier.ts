import { createTransport, type Transporter } from 'nodemailer';
import type { NotifyChannelType, NotifyMessage } from '@ai/shared';
import { BaseNotifier, type NotifierContext, type SendResult } from './notifier.ts';

/**
 * 邮件通知（SMTP）。
 *
 * 配置：
 *   - 敏感：password（SMTP 口令/授权码）
 *   - 非敏感：host / port / secure / from / to
 *
 * 安全：
 *   - 口令只从加密存储读出，绝不写日志；
 *   - 未安装 nodemailer 或未配置时给出明确错误（不静默降级为「假发送成功」）。
 */
export class EmailNotifier extends BaseNotifier {
  readonly type: NotifyChannelType = 'email';
  readonly label = '邮件';
  readonly secretFields = [{ key: 'password', label: 'SMTP 口令/授权码', required: true }];
  readonly configFields = [
    { key: 'host', label: 'SMTP 主机', required: true, type: 'string' as const, hint: 'smtp.qq.com' },
    { key: 'port', label: '端口', required: true, type: 'number' as const, hint: '465（SSL）或 587（STARTTLS）' },
    { key: 'secure', label: '使用 SSL', required: false, type: 'string' as const, hint: 'true / false' },
    { key: 'user', label: '用户名', required: true, type: 'string' as const },
    { key: 'from', label: '发件人地址', required: false, type: 'string' as const },
    { key: 'to', label: '收件人（多个用逗号分隔）', required: true, type: 'string' as const },
  ];

  private transporter(ctx: NotifierContext): Transporter {
    const port = Number(ctx.config.port ?? 465);
    return createTransport({
      host: String(ctx.config.host),
      port,
      secure: ctx.config.secure === undefined ? port === 465 : String(ctx.config.secure) === 'true',
      auth: { user: String(ctx.config.user), pass: String(ctx.secret.password) },
      // 强制超时，避免 SMTP 挂死调度线程
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(message: NotifyMessage, ctx: NotifierContext): Promise<SendResult> {
    const to = String(ctx.config.to)
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (to.length === 0) throw new Error('缺少收件人：请在渠道配置中填写 to');
    const from = String(ctx.config.from || ctx.config.user);
    const transporter = this.transporter(ctx);
    try {
      const info = await this.withTimeout(
        transporter.sendMail({
          from,
          to,
          subject: `[AI 工作台] ${message.title}`,
          text: this.render(message),
          html: `<h3>${escapeHtml(message.title)}</h3><pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(message.content)}</pre>${message.url ? `<p><a href="${escapeHtml(message.url)}">${escapeHtml(message.url)}</a></p>` : ''}`,
        }),
        30_000,
        'SMTP',
      );
      return { ok: true, messageId: info.messageId, detail: { accepted: info.accepted } };
    } finally {
      transporter.close();
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
