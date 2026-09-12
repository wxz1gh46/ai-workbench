import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AppEvent } from '@ai/shared';
import { eventBus } from './bus.ts';
import { logger } from '../utils/logger.ts';
import { logBus } from '../utils/logger.ts';

/**
 * WS /events：把事件总线推给前端。
 * 连接后先回放最近 100 条事件，避免 UI 断线重连后状态不一致。
 */
export function attachWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/events' });

  wss.on('connection', (socket: WebSocket, req) => {
    const url = new URL(req.url ?? '/events', 'http://localhost');
    const workspaceId = url.searchParams.get('workspaceId') ?? undefined;
    logger.info('ws connected', { clients: wss.clients.size });

    for (const e of eventBus.recent(100, workspaceId)) send(socket, e);

    const offEvent = eventBus.on('*', (e) => {
      if (workspaceId && e.workspaceId !== workspaceId) return;
      send(socket, e);
    });
    const onLog = (line: unknown) => {
      send(socket, {
        id: 'log',
        type: 'log',
        workspaceId: workspaceId ?? '',
        goalId: null,
        taskId: null,
        payload: line,
        at: new Date().toISOString(),
      } satisfies AppEvent);
    };
    logBus.on('log', onLog);

    socket.on('close', () => {
      offEvent();
      logBus.off('log', onLog);
    });
    socket.on('error', (e) => logger.warn('ws error', { error: e.message }));
  });

  return wss;
}

function send(socket: WebSocket, event: AppEvent): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(event));
}
