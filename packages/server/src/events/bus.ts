import { EventEmitter } from 'node:events';
import type { AppEvent, EventTypeValue } from '@ai/shared';
import { newId, nowIso } from '../utils/ids.ts';

/**
 * 本地消息总线（Phase 1）。
 * Phase 2+ 可替换为 Redis Streams / NATS，保持 publish/subscribe 接口不变。
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish<T>(type: EventTypeValue, payload: T, ctx: { workspaceId: string; goalId?: string | null; taskId?: string | null }): AppEvent<T> {
    const event: AppEvent<T> = {
      id: newId('evt'),
      type,
      workspaceId: ctx.workspaceId,
      goalId: ctx.goalId ?? null,
      taskId: ctx.taskId ?? null,
      payload,
      at: nowIso(),
    };
    this.emitter.emit(type, event);
    this.emitter.emit('*', event);
    return event;
  }

  on(type: EventTypeValue | '*', handler: (e: AppEvent) => void): () => void {
    this.emitter.on(type, handler as (e: AppEvent) => void);
    return () => this.emitter.off(type, handler as (e: AppEvent) => void);
  }

  /** 环形缓冲：新连接 WS 客户端可回放最近事件 */
  private readonly ring: AppEvent[] = [];
  private static RING_SIZE = 500;

  publishBuffered<T>(type: EventTypeValue, payload: T, ctx: { workspaceId: string; goalId?: string | null; taskId?: string | null }): AppEvent<T> {
    const e = this.publish(type, payload, ctx);
    this.ring.push(e);
    if (this.ring.length > EventBus.RING_SIZE) this.ring.shift();
    return e;
  }

  recent(limit = 100, workspaceId?: string): AppEvent[] {
    const list = workspaceId ? this.ring.filter((e) => e.workspaceId === workspaceId) : this.ring;
    return list.slice(-limit);
  }
}

export const eventBus = new EventBus();
