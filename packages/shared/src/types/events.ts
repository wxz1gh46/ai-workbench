import type { Id, IsoDateTime } from './ids.ts';

/**
 * 事件总线（本地 EventEmitter / 远端 WS /events 共用一份协议）。
 * 前端按 type 分发到对应 store。
 */
export const EventType = {
  AGENT_STATUS: 'agent.status',
  AGENT_MESSAGE: 'agent.message',
  TASK_UPDATED: 'task.updated',
  GOAL_UPDATED: 'goal.updated',
  RUN_STARTED: 'run.started',
  RUN_FINISHED: 'run.finished',
  TOOL_CALLED: 'tool.called',
  MESSAGE_DELTA: 'message.delta',
  FILE_CREATED: 'file.created',
  ARTIFACT_CREATED: 'artifact.created',
  SCHEDULE_RUN: 'schedule.run',
  WEBSITE_UPDATED: 'website.updated',
  LOG: 'log',
  ERROR: 'error',
} as const;

export type EventTypeValue = (typeof EventType)[keyof typeof EventType];

/** 日志行（服务端 logger 与 WS 日志事件共用） */
export interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  at: string;
  [key: string]: unknown;
}

export interface AppEvent<T = unknown> {
  id: Id;
  type: EventTypeValue;
  workspaceId: Id;
  /** 用于前端按 goal/task 过滤 */
  goalId: Id | null;
  taskId: Id | null;
  payload: T;
  at: IsoDateTime;
}
