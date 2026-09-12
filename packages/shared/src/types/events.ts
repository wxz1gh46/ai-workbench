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
  /* Phase 2 新增事件 */
  CONTEXT_COMPACTED: 'context.compacted',
  TOKEN_BUDGET: 'context.token-budget',
  GOAL_RUN: 'goal.run',
  PROGRESS_UPDATED: 'goal.progress',
  CLUSTER_MODE: 'cluster.mode',
  TASK_BOARD: 'task.board',
  AGENT_MESSAGE_DIRECT: 'agent.message.direct',
  OFFICE_FILE_CHANGED: 'office.file-changed',
  FILE_VERSION: 'file.version',
  RESEARCH_PROGRESS: 'research.progress',
  RESEARCH_SOURCE: 'research.source',
  RESEARCH_REPORT: 'research.report',
  LOG: 'log',
  ERROR: 'error',
  /* Phase 3 新增事件 */
  WEBSITE_GENERATED: 'website.generated',
  WEBSITE_BUILD_LOG: 'website.build-log',
  DEPLOY_STATUS: 'deploy.status',
  DEPLOY_LOG: 'deploy.log',
  DB_STATUS: 'database.status',
  DB_MIGRATION: 'database.migration',
  DASHBOARD_UPDATED: 'dashboard.updated',
  WIDGET_UPDATED: 'widget.updated',
  WIDGET_REFRESHED: 'widget.refreshed',
  SCHEDULE_UPDATED: 'schedule.updated',
  SCHEDULE_LOG: 'schedule.log',
  NOTIFY_SENT: 'notify.sent',
  NOTIFY_FAILED: 'notify.failed',
  /* Phase 4 新增事件 */
  PLUGIN_INSTALLED: 'plugin.installed',
  PLUGIN_UNINSTALLED: 'plugin.uninstalled',
  PLUGIN_GRANTED: 'plugin.granted',
  PLUGIN_REVOKED: 'plugin.revoked',
  PLUGIN_CALLED: 'plugin.called',
  MCP_SERVER_UPDATED: 'mcp.server-updated',
  PAID_DATA_QUERY: 'paid-data.query',
  PAID_DATA_BLOCKED: 'paid-data.blocked',
  PROMPT_GENERATED: 'prompt.generated',
  PROMPT_OPTIMIZED: 'prompt.optimized',
  PROMPT_VERSION_SAVED: 'prompt.version-saved',
  PROMPT_ABTEST_UPDATED: 'prompt.abtest-updated',
  CLUSTER_NODE_REGISTERED: 'cluster.node-registered',
  CLUSTER_NODE_HEARTBEAT: 'cluster.node-heartbeat',
  CLUSTER_NODE_OFFLINE: 'cluster.node-offline',
  CLUSTER_LEADER: 'cluster.leader',
  CLUSTER_SHARD_UPDATED: 'cluster.shard-updated',
  CLUSTER_FALLBACK: 'cluster.fallback',
  AGENT_POOL_UPDATED: 'agent.pool-updated',
  AGENT_ROUTED: 'agent.routed',
  AGENT_RESULT_AGGREGATED: 'agent.result-aggregated',
  COST_RECORDED: 'cost.recorded',
  COST_BUDGET_WARNING: 'cost.budget-warning',
  RBAC_ROLE_UPDATED: 'rbac.role-updated',
  SSO_CONFIG_UPDATED: 'sso.config-updated',
  AUDIT_EXPORTED: 'audit.exported',
  RETENTION_APPLIED: 'compliance.retention-applied',
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
