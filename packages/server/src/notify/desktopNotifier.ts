import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import type { NotifyChannelType, NotifyMessage } from '@ai/shared';
import { config } from '../config.ts';
import { BaseNotifier, type NotifierContext, type SendResult } from './notifier.ts';

/**
 * 桌面通知。
 *
 * 实现方式：
 *   - 有 Tauri 环境时，由前端监听 WS 的 notify.sent 事件调用 plugin-notification；
 *     服务端这里负责「把通知写进 outbox 并广播」，保证不依赖窗口是否打开。
 *   - 无 Tauri（纯 Node 运行 / 测试）时，写本地通知日志文件 → 返回 degraded，
 *     明确告知「已记录但未弹窗」，绝不假装已弹出。
 *
 * outbox 格式：JSONL，每行一条，便于前端增量拉取与查历史。
 */
export class DesktopNotifier extends BaseNotifier {
  readonly type: NotifyChannelType = 'desktop';
  readonly label = '桌面通知';
  readonly secretFields = [];
  readonly configFields = [
    { key: 'sound', label: '提示音', required: false, type: 'string' as const, hint: 'default / none' },
    { key: 'silentOnFocus', label: '窗口聚焦时静默', required: false, type: 'string' as const },
  ];

  private outboxPath(): string {
    const dir = path.join(config.dataDir, 'notify');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return path.join(dir, 'desktop-outbox.jsonl');
  }

  async send(message: NotifyMessage, ctx: NotifierContext): Promise<SendResult> {
    const record = {
      channelId: ctx.channelId,
      event: message.event,
      title: message.title,
      content: message.content,
      url: message.url ?? null,
      level: message.level ?? 'info',
      at: new Date().toISOString(),
      displayed: false,
    };
    appendFileSync(this.outboxPath(), JSON.stringify(record) + '\n', 'utf8');
    return {
      ok: true,
      degraded: true,
      detail: { outbox: this.outboxPath(), note: '已写入桌面通知 outbox，由 Tauri 前端消费并弹出系统通知' },
    };
  }
}
