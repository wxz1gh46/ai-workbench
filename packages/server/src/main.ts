import { serve } from '@hono/node-server';
import { createServer } from 'node:http';
import { createApp } from './router/app.ts';
import { getDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { attachWebSocket } from './events/ws.ts';
import { registerBuiltinTools } from './tools/index.ts';
import { config } from './config.ts';
import { logger } from './utils/logger.ts';
import { startScheduler } from './services/scheduler.ts';

async function main() {
  runMigrations();
  registerBuiltinTools();

  const db = getDb();
  const app = createApp({ db });
  const server = createServer(async (req, res) => {
    const url = `http://${req.headers.host ?? `${config.host}:${config.port}`}${req.url}`;
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : (req as unknown as ReadableStream);
    const request = new Request(url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      ...(body ? { body, duplex: 'half' } : {}),
    } as RequestInit);
    const response = await app.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  });

  attachWebSocket(server);
  const stopScheduler = startScheduler(db);

  server.listen(config.port, config.host, () => {
    logger.info('AI Workbench server started', {
      url: `http://${config.host}:${config.port}`,
      ws: `ws://${config.host}:${config.port}/events`,
      degraded: !config.ai.apiKey,
    });
    if (!config.ai.apiKey) {
      logger.warn('未配置 AI_API_KEY，模型调用将走离线兜底；配置后自动启用真实模型');
    }
  });

  const shutdown = () => {
    logger.info('shutting down');
    stopScheduler();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
