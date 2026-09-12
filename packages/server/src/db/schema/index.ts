import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/* ------------------------------------------------------------------ */
/* 通用列                                                              */
/* ------------------------------------------------------------------ */
const id = () => text('id').primaryKey();
const createdAt = () => text('created_at').notNull();
const updatedAt = () => text('updated_at').notNull();
const json = (name: string) => text(name, { mode: 'json' });

/* ------------------------------------------------------------------ */
/* 用户 / 工作区                                                       */
/* ------------------------------------------------------------------ */
export const users = sqliteTable('users', {
  id: id(),
  name: text('name').notNull(),
  role: text('role', { enum: ['owner', 'admin', 'member', 'viewer'] })
    .notNull()
    .default('owner'),
  createdAt: createdAt(),
});

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    rootPath: text('root_path'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ userIdx: index('workspaces_user_idx').on(t.userId) }),
);

/* ------------------------------------------------------------------ */
/* 会话 / 消息 / 记忆                                                  */
/* ------------------------------------------------------------------ */
export const conversations = sqliteTable(
  'conversations',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    goalId: text('goal_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ wsIdx: index('conversations_ws_idx').on(t.workspaceId) }),
);

export const messages = sqliteTable(
  'messages',
  {
    id: id(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['system', 'user', 'assistant', 'tool'] }).notNull(),
    content: text('content').notNull(),
    citations: json('citations').$type<string[]>().notNull().default([]),
    tokenCount: integer('token_count').notNull().default(0),
    summarized: integer('summarized', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({ convIdx: index('messages_conv_idx').on(t.conversationId, t.createdAt) }),
);

export const conversationSummaries = sqliteTable(
  'conversation_summaries',
  {
    id: id(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    fromMessageId: text('from_message_id').notNull(),
    toMessageId: text('to_message_id').notNull(),
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => ({ convIdx: index('summaries_conv_idx').on(t.conversationId) }),
);

export const memoryFacts = sqliteTable(
  'memory_facts',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    sourceMessageId: text('source_message_id'),
    importance: real('importance').notNull().default(0.5),
    createdAt: createdAt(),
  },
  (t) => ({ convKeyIdx: index('facts_conv_key_idx').on(t.conversationId, t.key) }),
);

/* ------------------------------------------------------------------ */
/* 目标 / 任务 / Agent                                                 */
/* ------------------------------------------------------------------ */
export const goals = sqliteTable(
  'goals',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id'),
    objective: text('objective').notNull(),
    acceptanceCriteria: json('acceptance_criteria').$type<string[]>().notNull().default([]),
    status: text('status', {
      enum: ['draft', 'planning', 'running', 'auditing', 'completed', 'failed', 'cancelled'],
    })
      .notNull()
      .default('draft'),
    progress: integer('progress').notNull().default(0),
    iterations: integer('iterations').notNull().default(0),
    maxIterations: integer('max_iterations').notNull().default(12),
    blockers: json('blockers').$type<string[]>().notNull().default([]),
    auditReport: text('audit_report'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ wsIdx: index('goals_ws_idx').on(t.workspaceId), statusIdx: index('goals_status_idx').on(t.status) }),
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: id(),
    goalId: text('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    parentTaskId: text('parent_task_id'),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status', {
      enum: ['pending', 'ready', 'running', 'blocked', 'succeeded', 'failed', 'cancelled'],
    })
      .notNull()
      .default('pending'),
    progress: integer('progress').notNull().default(0),
    agentRole: text('agent_role').notNull().default('coordinator'),
    tools: json('tools').$type<string[]>().notNull().default([]),
    dependsOn: json('depends_on').$type<string[]>().notNull().default([]),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    claimedBy: text('claimed_by'),
    input: json('input').$type<Record<string, unknown>>().notNull().default({}),
    output: json('output').$type<Record<string, unknown> | null>(),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (t) => ({
    goalIdx: index('tasks_goal_idx').on(t.goalId),
    statusIdx: index('tasks_status_idx').on(t.status),
    parentIdx: index('tasks_parent_idx').on(t.parentTaskId),
  }),
);

export const agents = sqliteTable(
  'agents',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    role: text('role').notNull(),
    status: text('status', { enum: ['idle', 'busy', 'offline', 'error'] })
      .notNull()
      .default('idle'),
    systemPrompt: text('system_prompt').notNull().default(''),
    model: text('model'),
    currentTaskId: text('current_task_id'),
    clusterNode: text('cluster_node'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    wsIdx: index('agents_ws_idx').on(t.workspaceId),
    roleIdx: uniqueIndex('agents_ws_role_idx').on(t.workspaceId, t.role),
  }),
);

export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: id(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    goalId: text('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['running', 'succeeded', 'failed', 'cancelled'] })
      .notNull()
      .default('running'),
    iteration: integer('iteration').notNull().default(0),
    reasoning: text('reasoning').notNull().default(''),
    promptDigest: text('prompt_digest').notNull().default(''),
    model: text('model').notNull().default(''),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    error: text('error'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => ({
    goalIdx: index('runs_goal_idx').on(t.goalId),
    taskIdx: index('runs_task_idx').on(t.taskId),
    agentIdx: index('runs_agent_idx').on(t.agentId),
  }),
);

export const toolCalls = sqliteTable(
  'tool_calls',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    toolName: text('tool_name').notNull(),
    args: json('args').$type<Record<string, unknown>>().notNull().default({}),
    result: json('result'),
    allowed: integer('allowed', { mode: 'boolean' }).notNull().default(true),
    durationMs: integer('duration_ms').notNull().default(0),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => ({ runIdx: index('tool_calls_run_idx').on(t.runId) }),
);

export const agentMessages = sqliteTable(
  'agent_messages',
  {
    id: id(),
    goalId: text('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    fromAgentId: text('from_agent_id').notNull(),
    toAgentId: text('to_agent_id'),
    topic: text('topic').notNull(),
    payload: json('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => ({ goalIdx: index('agent_messages_goal_idx').on(t.goalId) }),
);

/* ------------------------------------------------------------------ */
/* 文件 / 产物                                                         */
/* ------------------------------------------------------------------ */
export const files = sqliteTable(
  'files',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    name: text('name').notNull(),
    ext: text('ext').notNull().default(''),
    mime: text('mime').notNull().default('application/octet-stream'),
    size: integer('size').notNull().default(0),
    version: integer('version').notNull().default(1),
    sha256: text('sha256').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    wsIdx: index('files_ws_idx').on(t.workspaceId),
    pathIdx: uniqueIndex('files_ws_path_idx').on(t.workspaceId, t.path),
  }),
);

export const fileVersions = sqliteTable(
  'file_versions',
  {
    id: id(),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    storagePath: text('storage_path').notNull(),
    size: integer('size').notNull().default(0),
    sha256: text('sha256').notNull().default(''),
    note: text('note').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => ({ fileIdx: index('file_versions_file_idx').on(t.fileId, t.version) }),
);

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    goalId: text('goal_id'),
    taskId: text('task_id'),
    fileId: text('file_id'),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    url: text('url'),
    meta: json('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => ({ wsIdx: index('artifacts_ws_idx').on(t.workspaceId) }),
);

/* ------------------------------------------------------------------ */
/* 网站 / 数据库连接                                                   */
/* ------------------------------------------------------------------ */
export const websites = sqliteTable(
  'websites',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    goalId: text('goal_id'),
    name: text('name').notNull(),
    provider: text('provider', {
      enum: ['vercel', 'cloudflare-pages', 'netlify', 'local-preview'],
    })
      .notNull()
      .default('local-preview'),
    databaseConnectionId: text('database_connection_id'),
    status: text('status', {
      enum: ['creating', 'building', 'deployed', 'failed', 'deleted'],
    })
      .notNull()
      .default('creating'),
    url: text('url'),
    customDomain: text('custom_domain'),
    accessControl: text('access_control', { enum: ['public', 'password', 'private'] })
      .notNull()
      .default('private'),
    buildLog: text('build_log').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ wsIdx: index('websites_ws_idx').on(t.workspaceId) }),
);

export const databaseConnections = sqliteTable(
  'database_connections',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['neon', 'supabase', 'postgres', 'sqlite'] }).notNull(),
    name: text('name').notNull(),
    /** 只存引用名，真实连接串在 Keychain */
    secretRef: text('secret_ref').notNull(),
    host: text('host'),
    database: text('database'),
    ssl: integer('ssl', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({ wsIdx: index('db_conn_ws_idx').on(t.workspaceId) }),
);

/* ------------------------------------------------------------------ */
/* 定时任务                                                            */
/* ------------------------------------------------------------------ */
export const schedules = sqliteTable(
  'schedules',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    trigger: text('trigger', { enum: ['cron', 'interval', 'once'] }).notNull(),
    expression: text('expression').notNull(),
    action: json('action').$type<Record<string, unknown>>().notNull().default({}),
    channelIds: json('channel_ids').$type<string[]>().notNull().default([]),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastRunAt: text('last_run_at'),
    nextRunAt: text('next_run_at'),
    retry: integer('retry').notNull().default(2),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ wsIdx: index('schedules_ws_idx').on(t.workspaceId) }),
);

export const scheduleRuns = sqliteTable(
  'schedule_runs',
  {
    id: id(),
    scheduleId: text('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['running', 'succeeded', 'failed', 'skipped'] })
      .notNull()
      .default('running'),
    attempt: integer('attempt').notNull().default(1),
    log: text('log').notNull().default(''),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => ({ schedIdx: index('schedule_runs_sched_idx').on(t.scheduleId) }),
);

/* ------------------------------------------------------------------ */
/* 看板小组件                                                          */
/* ------------------------------------------------------------------ */
export const widgets = sqliteTable(
  'widgets',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    dashboardId: text('dashboard_id').notNull().default('default'),
    type: text('type').notNull(),
    title: text('title').notNull(),
    naturalLanguage: text('natural_language'),
    layout: json('layout').$type<{ x: number; y: number; w: number; h: number }>().notNull(),
    config: json('config').$type<Record<string, unknown>>().notNull().default({}),
    pinnedToDesktop: integer('pinned_to_desktop', { mode: 'boolean' }).notNull().default(false),
    refreshIntervalMs: integer('refresh_interval_ms').notNull().default(5000),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ wsIdx: index('widgets_ws_idx').on(t.workspaceId) }),
);

/* ------------------------------------------------------------------ */
/* 插件                                                                */
/* ------------------------------------------------------------------ */
export const plugins = sqliteTable(
  'plugins',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    version: text('version').notNull(),
    kind: text('kind', { enum: ['mcp', 'http', 'websocket', 'local'] })
      .notNull()
      .default('mcp'),
    source: text('source').notNull().default(''),
    status: text('status', {
      enum: ['installed', 'enabled', 'disabled', 'update-available', 'error'],
    })
      .notNull()
      .default('installed'),
    permissions: json('permissions')
      .$type<{ scope: string; description: string; sensitive: boolean }[]>()
      .notNull()
      .default([]),
    requiresUserAuth: integer('requires_user_auth', { mode: 'boolean' }).notNull().default(true),
    secretRefs: json('secret_refs').$type<string[]>().notNull().default([]),
    sandbox: integer('sandbox', { mode: 'boolean' }).notNull().default(true),
    config: json('config').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ wsIdx: uniqueIndex('plugins_ws_name_idx').on(t.workspaceId, t.name) }),
);

export const pluginCallLogs = sqliteTable(
  'plugin_call_logs',
  {
    id: id(),
    pluginId: text('plugin_id')
      .notNull()
      .references(() => plugins.id, { onDelete: 'cascade' }),
    tool: text('tool').notNull(),
    args: json('args').$type<Record<string, unknown>>().notNull().default({}),
    ok: integer('ok', { mode: 'boolean' }).notNull().default(true),
    durationMs: integer('duration_ms').notNull().default(0),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => ({ pluginIdx: index('plugin_calls_plugin_idx').on(t.pluginId) }),
);

/* ------------------------------------------------------------------ */
/* 提示词模板                                                          */
/* ------------------------------------------------------------------ */
export const promptTemplates = sqliteTable(
  'prompt_templates',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sections: json('sections').$type<Record<string, string>>().notNull(),
    variables: json('variables').$type<string[]>().notNull().default([]),
    version: integer('version').notNull().default(1),
    parentId: text('parent_id'),
    tags: json('tags').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ wsIdx: index('prompts_ws_idx').on(t.workspaceId) }),
);

/* ------------------------------------------------------------------ */
/* 审计日志                                                            */
/* ------------------------------------------------------------------ */
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    dangerous: integer('dangerous', { mode: 'boolean' }).notNull().default(false),
    confirmedByUser: integer('confirmed_by_user', { mode: 'boolean' }).notNull().default(false),
    detail: json('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => ({
    wsIdx: index('audit_ws_idx').on(t.workspaceId),
    actionIdx: index('audit_action_idx').on(t.action),
  }),
);

/** 通知渠道配置（Phase 3 推送用） */
export const notificationChannels = sqliteTable(
  'notification_channels',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['desktop', 'email', 'webhook', 'feishu', 'dingtalk', 'wecom'] })
      .notNull(),
    name: text('name').notNull(),
    /** 密钥引用名，真实值在 Keychain */
    secretRef: text('secret_ref'),
    secretValueEnc: text('secret_value_enc'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({ wsIdx: index('channels_ws_idx').on(t.workspaceId) }),
);
