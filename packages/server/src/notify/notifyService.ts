import { and, desc, eq } from 'drizzle-orm';
import { EventType, type NotifyChannel, type NotifyChannelType, type NotifyLogRecord, type NotifyMessage } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { notifyChannels, notifyLogs } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { maskSecret, seal, unseal } from '../security/secrets.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';
import { eventBus } from '../events/bus.ts';
import { getNotifier, listNotifierMeta, notifiers } from './registry.ts';
import { NOTIFY_RETRY, computeDelay, normalizeRetry, withRetry } from './retryPolicy.ts';

/**
 * 通知服务（Step 6）。
 *
 * 职责：
 *   1. 渠道 CRUD（敏感配置加密存储，接口永不返回明文）
 *   2. 测试发送
 *   3. dispatch：向一组渠道并发发送，逐条写 NotifyLog，失败按指数退避重试
 *   4. 发送日志查询
 *
 * 触发源（由其他模块调用）：
 *   - 定时任务执行完成（schedule）
 *   - 目标完成（goal）
 *   - 部署完成（deploy）
 *   - 异常事件（error）
 */
export class NotifyService {
  constructor(private readonly db: Db) {}

  /* ---------------------------- 渠道管理 ---------------------------- */

  async createChannel(input: {
    workspaceId: string;
    type: NotifyChannelType;
    name: string;
    config?: Record<string, unknown>;
    secret?: Record<string, unknown>;
    enabled?: boolean;
  }): Promise<NotifyChannel> {
    const notifier = getNotifier(input.type);
    if (!notifier) throw AppError.badRequest(`不支持的通知渠道类型: ${input.type}`);
    if (!input.name.trim()) throw AppError.badRequest('渠道名称不能为空');
    // 保存时先校验必填项：避免「保存成功但发送永远失败」
    notifier.validate({ config: input.config ?? {}, secret: input.secret ?? {}, channelId: 'validate' });

    const now = nowIso();
    const row = {
      id: newId('nch'),
      workspaceId: input.workspaceId,
      type: input.type,
      name: input.name.trim(),
      encryptedConfig: input.secret && Object.keys(input.secret).length > 0 ? seal(input.secret) : null,
      config: stripUndefined(input.config ?? {}),
      enabled: input.enabled ?? true,
      lastTestedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(notifyChannels).values(row);
    logger.info('notify channel created', { id: row.id, type: row.type });
    return this.toPublic(row as never);
  }

  async listChannels(workspaceId: string): Promise<NotifyChannel[]> {
    const rows = await this.db.select().from(notifyChannels).where(eq(notifyChannels.workspaceId, workspaceId));
    return rows.map((r) => this.toPublic(r as never));
  }

  /** 内部使用：拿原始行（含密文） */
  async rawChannel(workspaceId: string, channelId: string) {
    const rows = await this.db
      .select()
      .from(notifyChannels)
      .where(and(eq(notifyChannels.id, channelId), eq(notifyChannels.workspaceId, workspaceId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async updateChannel(input: {
    workspaceId: string;
    channelId: string;
    name?: string;
    config?: Record<string, unknown>;
    secret?: Record<string, unknown>;
    enabled?: boolean;
  }): Promise<NotifyChannel> {
    const existing = await this.rawChannel(input.workspaceId, input.channelId);
    if (!existing) throw AppError.notFound(`通知渠道不存在: ${input.channelId}`);

    const config = { ...(existing.config as Record<string, unknown>), ...(input.config ?? {}) };
    let secret: Record<string, unknown> = {};
    if (input.secret !== undefined) {
      secret = input.secret;
    } else if (existing.encryptedConfig) {
      try {
        secret = unseal<Record<string, unknown>>(existing.encryptedConfig) ?? {};
      } catch {
        secret = {};
      }
    }
    getNotifier(existing.type as NotifyChannelType).validate({ config, secret, channelId: input.channelId });

    const now = nowIso();
    await this.db
      .update(notifyChannels)
      .set({
        name: input.name?.trim() || existing.name,
        config: stripUndefined(config) as never,
        encryptedConfig: input.secret !== undefined ? seal(secret) : existing.encryptedConfig,
        enabled: input.enabled ?? existing.enabled,
        updatedAt: now,
      })
      .where(eq(notifyChannels.id, input.channelId));
    const fresh = await this.rawChannel(input.workspaceId, input.channelId);
    return this.toPublic(fresh as never);
  }

  async removeChannel(workspaceId: string, channelId: string): Promise<void> {
    const existing = await this.rawChannel(workspaceId, channelId);
    if (!existing) throw AppError.notFound(`通知渠道不存在: ${channelId}`);
    await this.db.delete(notifyChannels).where(eq(notifyChannels.id, channelId));
    logger.info('notify channel removed', { id: channelId });
  }

  async setEnabled(workspaceId: string, channelId: string, enabled: boolean): Promise<NotifyChannel> {
    return this.updateChannel({ workspaceId, channelId, enabled });
  }

  /* ---------------------------- 发送 ---------------------------- */

  /** 单渠道测试发送（UI 的「测试」按钮） */
  async testChannel(input: { workspaceId: string; channelId: string }): Promise<{ ok: boolean; message: string; degraded: boolean }> {
    const channel = await this.rawChannel(input.workspaceId, input.channelId);
    if (!channel) throw AppError.notFound(`通知渠道不存在: ${input.channelId}`);
    const result = await this.sendOne(channel as never, {
      event: 'test',
      title: '测试通知',
      content: '这是一条来自 AI 工作台的测试消息。收到即表示渠道配置正确。',
      level: 'info',
    });
    await this.db.update(notifyChannels).set({ lastTestedAt: nowIso(), updatedAt: nowIso() }).where(eq(notifyChannels.id, input.channelId));
    return result;
  }

  /** 单渠道发送（写日志 + 重试） */
  private async sendOne(
    channel: { id: string; type: string; config: unknown; encryptedConfig: string | null; enabled: boolean },
    message: NotifyMessage,
    scheduleRunId: string | null = null,
  ): Promise<{ ok: boolean; message: string; degraded: boolean }> {
    const notifier = notifiers[channel.type as NotifyChannelType];
    if (!notifier) {
      await this.writeLog({ channelId: channel.id, scheduleRunId, message, status: 'failed', attempt: 1, error: `不支持的渠道类型: ${channel.type}` });
      return { ok: false, message: `不支持的渠道类型: ${channel.type}`, degraded: false };
    }
    if (!channel.enabled) {
      await this.writeLog({ channelId: channel.id, scheduleRunId, message, status: 'failed', attempt: 0, error: '渠道已禁用' });
      return { ok: false, message: '渠道已禁用', degraded: false };
    }

    let secret: Record<string, unknown> = {};
    if (channel.encryptedConfig) {
      try {
        secret = unseal<Record<string, unknown>>(channel.encryptedConfig) ?? {};
      } catch (e) {
        const msg = `渠道凭据解密失败（密钥可能已变更）：${e instanceof Error ? e.message : String(e)}`;
        await this.writeLog({ channelId: channel.id, scheduleRunId, message, status: 'failed', attempt: 1, error: msg });
        return { ok: false, message: msg, degraded: false };
      }
    }
    const ctx = { config: (channel.config ?? {}) as Record<string, unknown>, secret, channelId: channel.id };

    const opts = normalizeRetry(NOTIFY_RETRY);
    try {
      const { value, attempts } = await withRetry(
        () => notifier.send(message, ctx),
        opts,
        ({ attempt, error, delayMs }) => {
          logger.warn('notify retry', { channelId: channel.id, attempt, error, delayMs });
          void this.writeLog({
            channelId: channel.id,
            scheduleRunId,
            message,
            status: 'failed',
            attempt,
            error: `${error}（${delayMs}ms 后重试）`,
          });
        },
      );
      await this.writeLog({
        channelId: channel.id,
        scheduleRunId,
        message,
        status: 'sent',
        attempt: attempts,
        messageId: value.messageId,
        detail: value.detail,
        degraded: value.degraded,
      });
      eventBus.publishBuffered(
        EventType.NOTIFY_SENT,
        { channelId: channel.id, channelType: channel.type, title: message.title, degraded: value.degraded ?? false, outbox: value.detail },
        { workspaceId: '', goalId: null, taskId: null },
      );
      return {
        ok: true,
        degraded: value.degraded ?? false,
        message: value.degraded ? '已记录（降级：未真正弹窗/发布）' : '发送成功',
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.writeLog({ channelId: channel.id, scheduleRunId, message, status: 'failed', attempt: opts.maxRetry + 1, error: msg });
      eventBus.publishBuffered(EventType.NOTIFY_FAILED, { channelId: channel.id, title: message.title, error: msg }, { workspaceId: '', goalId: null, taskId: null });
      return { ok: false, message: msg, degraded: false };
    }
  }

  /**
   * 分发到一组渠道。channelIds 为空时使用工作区所有启用渠道。
   * 并发发送但逐个隔离失败 → 单个渠道挂掉不影响其他渠道。
   */
  async dispatch(input: {
    workspaceId: string;
    message: NotifyMessage;
    channelIds?: string[];
    scheduleRunId?: string | null;
  }): Promise<{ sent: number; failed: number; results: { channelId: string; type: string; ok: boolean; message: string }[] }> {
    let targets: { id: string; type: string; config: unknown; encryptedConfig: string | null; enabled: boolean }[];
    if (input.channelIds && input.channelIds.length > 0) {
      const all = await this.db.select().from(notifyChannels).where(eq(notifyChannels.workspaceId, input.workspaceId));
      targets = all.filter((c) => input.channelIds?.includes(c.id)) as typeof targets;
    } else {
      const all = await this.db.select().from(notifyChannels).where(eq(notifyChannels.workspaceId, input.workspaceId));
      targets = all.filter((c) => c.enabled) as typeof targets;
    }
    if (targets.length === 0) {
      logger.info('notify dispatch skipped: no channel', { workspaceId: input.workspaceId, event: input.message.event });
      return { sent: 0, failed: 0, results: [] };
    }

    const settled = await Promise.all(
      targets.map(async (c) => {
        const res = await this.sendOne(c, input.message, input.scheduleRunId ?? null);
        return { channelId: c.id, type: c.type, ok: res.ok, message: res.message };
      }),
    );
    const sent = settled.filter((r) => r.ok).length;
    return { sent, failed: settled.length - sent, results: settled };
  }

  /* ---------------------------- 日志 ---------------------------- */

  private async writeLog(input: {
    channelId: string;
    scheduleRunId: string | null;
    message: NotifyMessage;
    status: 'pending' | 'sent' | 'failed';
    attempt: number;
    error?: string;
    messageId?: string;
    detail?: Record<string, unknown>;
    degraded?: boolean;
  }): Promise<void> {
    try {
      await this.db.insert(notifyLogs).values({
        id: newId('nlog'),
        channelId: input.channelId,
        scheduleRunId: input.scheduleRunId,
        event: input.message.event,
        title: input.message.title,
        // 落库前裁剪，并且绝不包含渠道凭据
        content: input.message.content.slice(0, 4000),
        status: input.status,
        attempt: input.attempt,
        sentAt: input.status === 'sent' ? nowIso() : null,
        error: input.error ? input.error.slice(0, 1000) : null,
        createdAt: nowIso(),
      });
    } catch (e) {
      logger.error('notify log insert failed', { error: e instanceof Error ? e.message : String(e) });
    }
    if (input.status === 'sent') {
      logger.info('notify sent', { channelId: input.channelId, event: input.message.event, attempt: input.attempt, degraded: input.degraded ?? false });
    } else if (input.error) {
      logger.warn('notify failed', { channelId: input.channelId, error: maskSecret(input.error, 0) });
    }
  }

  async listLogs(workspaceId: string, limit = 100, channelId?: string): Promise<NotifyLogRecord[]> {
    const channelIds = (await this.db.select().from(notifyChannels).where(eq(notifyChannels.workspaceId, workspaceId))).map((c) => c.id);
    if (channelIds.length === 0) return [];
    const rows = await this.db.select().from(notifyLogs).orderBy(desc(notifyLogs.createdAt)).limit(limit * 2);
    return rows
      .filter((r) => channelIds.includes(r.channelId) && (!channelId || r.channelId === channelId))
      .slice(0, limit) as unknown as NotifyLogRecord[];
  }

  /* ---------------------------- 元信息 ---------------------------- */

  catalog() {
    return listNotifierMeta();
  }

  /** 脱敏后的渠道视图：encryptedConfig 永不返回 */
  private toPublic(row: { id: string; workspaceId: string; type: string; name: string; config: unknown; encryptedConfig: string | null; enabled: boolean; lastTestedAt: string | null; createdAt: string; updatedAt: string }): NotifyChannel {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      type: row.type as NotifyChannelType,
      name: row.name,
      config: (row.config ?? {}) as Record<string, unknown>,
      enabled: row.enabled,
      configured: Boolean(row.encryptedConfig),
      lastTestedAt: row.lastTestedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

export { computeDelay };
