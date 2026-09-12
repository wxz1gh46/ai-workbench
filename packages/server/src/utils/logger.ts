import { EventEmitter } from 'node:events';
import { config } from '../config.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 日志总线：文件日志 + WS 推送共用 */
export const logBus = new EventEmitter();
logBus.setMaxListeners(0);

export function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[config.logLevel as LogLevel]) return;
  const line = {
    level,
    msg,
    at: new Date().toISOString(),
    ...meta,
  };
  const text = `[${line.at}] ${level.toUpperCase()} ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`;
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
  logBus.emit('log', line);
}

export const logger = {
  debug: (m: string, meta?: Record<string, unknown>) => log('debug', m, meta),
  info: (m: string, meta?: Record<string, unknown>) => log('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => log('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => log('error', m, meta),
};
