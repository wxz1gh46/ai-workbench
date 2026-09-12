import type { AppEvent } from '@ai/shared';

type Handler = (e: AppEvent) => void;

export function wsBaseUrl(): string {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL as string;
  if (typeof location !== 'undefined' && location.origin.startsWith('http')) {
    return location.origin.replace(/^http/, 'ws');
  }
  return 'ws://127.0.0.1:8787';
}

/** WS /events 客户端：指数退避重连；断线重连后服务端会回放最近事件 */
export class EventStream {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private retry = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly workspaceId: string,
    private readonly baseUrl: string = wsBaseUrl(),
  ) {}

  connect(): void {
    if (this.closed) return;
    const url = `${this.baseUrl}/events?workspaceId=${encodeURIComponent(this.workspaceId)}`;
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.retry = 0;
    };
    this.ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as AppEvent;
        for (const h of this.handlers) h(data);
      } catch {
        /* 忽略无法解析的消息 */
      }
    };
    this.ws.onclose = () => this.scheduleReconnect();
    this.ws.onerror = () => this.ws?.close();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.retry = Math.min(this.retry + 1, 6);
    const delay = Math.min(1000 * 2 ** this.retry, 30_000);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }
}
