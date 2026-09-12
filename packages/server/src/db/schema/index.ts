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
    /** Phase 2：rolling 滚动摘要 / manual 手动压缩 */
    kind: text('kind').notNull().default('rolling'),
    /** Phase 2：本次摘要覆盖的消息条数 */
    coveredCount: integer('covered_count').notNull().default(0),
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
    /** Phase 2：向量表示（JSON 数组，本地或远端 embedding） */
    embedding: json('embedding').$type<number[] | null>(),
    /** Phase 2：被召回次数 */
    recallCount: integer('recall_count').notNull().default(0),
    /** Phase 2：事实分类 fact/decision/constraint/preference */
    factType: text('fact_type').notNull().default('fact'),
    updatedAt: updatedAt(),
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
    /** Phase 2：Critic 对该任务的反思结论 */
    reflection: text('reflection').notNull().default(''),
    /** Phase 2：产出摘要（供进度树与看板展示） */
    outputSummary: text('output_summary'),
    /** Phase 2：最近一次执行该任务的 Agent */
    lastAgentId: text('last_agent_id'),
    /** Phase 2：该任务累计消耗 token */
    tokensUsed: integer('tokens_used').notNull().default(0),
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
    /** Phase 2：话题线程，便于 UI 聚合 */
    threadId: text('thread_id').notNull().default(''),
    /** Phase 2：消息种类 */
    kind: text('kind').notNull().default('broadcast'),
    /** Phase 2：可读消息正文 */
    content: text('content').notNull().default(''),
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
    /** Phase 3：供应商与状态 */
    provider: text('provider').notNull().default('neon'),
    status: text('status', { enum: ['unconfigured', 'ok', 'error', 'migrating'] }).notNull().default('unconfigured'),
    /** Phase 3：加密后的连接配置（AES-256-GCM） */
    encryptedConfig: text('encrypted_config'),
    schemaJson: json('schema_json').$type<Record<string, unknown>>().notNull().default({}),
    schemaVersion: integer('schema_version').notNull().default(0),
    lastTestedAt: text('last_tested_at'),
    updatedAt: updatedAt(),
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
    /** Phase 3：时区 / 任务类型 / 参数 / 模板 / 重试策略 */
    timezone: text('timezone').notNull().default('Asia/Shanghai'),
    taskType: text('task_type').notNull().default('goal'),
    taskConfig: json('task_config').$type<Record<string, unknown>>().notNull().default({}),
    template: text('template'),
    retryPolicy: json('retry_policy').$type<Record<string, unknown>>().notNull().default({}),
    concurrency: integer('concurrency').notNull().default(1),
    interruptedAt: text('interrupted_at'),
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
    /** Phase 3：重试与结构化结果 */
    retryCount: integer('retry_count').notNull().default(0),
    result: json('result').$type<Record<string, unknown> | null>(),
    error: text('error'),
    trigger: text('trigger').notNull().default('auto'),
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
    /** Phase 3：位置 / 尺寸 / 数据源 / 启用 */
    position: integer('position').notNull().default(0),
    size: text('size').notNull().default('md'),
    dataSource: text('data_source').notNull().default('local'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
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

/* ================================================================== */
/* Phase 2 增量表                                                      */
/* ================================================================== */

/** 目标推进轮次记录，支持回放、审计与回滚 */
export const goalRuns = sqliteTable(
  'goal_runs',
  {
    id: id(),
    goalId: text('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    iteration: integer('iteration').notNull().default(0),
    status: text('status', { enum: ['running', 'succeeded', 'failed', 'cancelled'] })
      .notNull()
      .default('running'),
    plan: json('plan').$type<Record<string, unknown> | null>(),
    reflection: text('reflection').notNull().default(''),
    auditReport: text('audit_report'),
    taskIds: json('task_ids').$type<string[]>().notNull().default([]),
    tokensUsed: integer('tokens_used').notNull().default(0),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => ({ goalIdx: index('goal_runs_goal_idx').on(t.goalId, t.iteration) }),
);

/** 结构化完成审计报告 */
export const goalAudits = sqliteTable(
  'goal_audits',
  {
    id: id(),
    goalId: text('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    passed: integer('passed', { mode: 'boolean' }).notNull().default(false),
    score: integer('score').notNull().default(0),
    criteria: json('criteria').$type<{ criterion: string; met: boolean; evidence: string }[]>().notNull().default([]),
    issues: json('issues').$type<{ severity: 'low' | 'medium' | 'high'; detail: string }[]>().notNull().default([]),
    nextActions: json('next_actions').$type<string[]>().notNull().default([]),
    markdown: text('markdown').notNull().default(''),
    degraded: integer('degraded', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({ goalIdx: index('goal_audits_goal_idx').on(t.goalId, t.createdAt) }),
);

/** Agent 集群配置（含降级开关） */
export const clusterConfigs = sqliteTable('cluster_configs', {
  workspaceId: text('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  mode: text('mode', { enum: ['single', 'parallel', 'cluster'] }).notNull().default('parallel'),
  maxParallel: integer('max_parallel').notNull().default(4),
  nodeId: text('node_id').notNull().default('local'),
  experimental: integer('experimental', { mode: 'boolean' }).notNull().default(false),
  updatedAt: updatedAt(),
});

/** Office 文档解析缓存 */
export const officeDocuments = sqliteTable(
  'office_documents',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fileId: text('file_id'),
    path: text('path').notNull(),
    format: text('format').notNull(),
    content: json('content').$type<Record<string, unknown>>().notNull().default({}),
    meta: json('meta').$type<Record<string, unknown>>().notNull().default({}),
    warnings: json('warnings').$type<string[]>().notNull().default([]),
    parsedAt: text('parsed_at').notNull(),
  },
  (t) => ({ wsPathIdx: uniqueIndex('office_docs_ws_path_idx').on(t.workspaceId, t.path) }),
);

/** Office 预览结果 */
export const officePreviews = sqliteTable(
  'office_previews',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    format: text('format').notNull(),
    markdown: text('markdown').notNull().default(''),
    renderer: text('renderer').notNull().default('markdown'),
    createdAt: createdAt(),
  },
  (t) => ({ wsPathIdx: index('office_previews_ws_path_idx').on(t.workspaceId, t.path) }),
);

/** 导出记录：文件 → 可下载 / 可发布 URL */
export const fileExports = sqliteTable(
  'file_exports',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fileId: text('file_id').notNull(),
    version: integer('version').notNull().default(1),
    storagePath: text('storage_path').notNull(),
    mime: text('mime').notNull().default('application/octet-stream'),
    size: integer('size').notNull().default(0),
    url: text('url'),
    expiresAt: text('expires_at'),
    createdAt: createdAt(),
  },
  (t) => ({ fileIdx: index('file_exports_file_idx').on(t.fileId) }),
);

/** 深度研究任务 */
export const researchJobs = sqliteTable(
  'research_jobs',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    topic: text('topic').notNull(),
    depth: text('depth', { enum: ['quick', 'standard', 'deep'] }).notNull().default('standard'),
    status: text('status', {
      enum: [
        'pending',
        'searching',
        'fetching',
        'extracting',
        'validating',
        'analyzing',
        'writing',
        'completed',
        'failed',
        'cancelled',
      ],
    })
      .notNull()
      .default('pending'),
    queries: json('queries').$type<string[]>().notNull().default([]),
    progress: integer('progress').notNull().default(0),
    stage: text('stage').notNull().default(''),
    outputFormats: json('output_formats').$type<string[]>().notNull().default(['markdown']),
    allowNetwork: integer('allow_network', { mode: 'boolean' }).notNull().default(false),
    sourceCount: integer('source_count').notNull().default(0),
    claimCount: integer('claim_count').notNull().default(0),
    disputedCount: integer('disputed_count').notNull().default(0),
    error: text('error'),
    createdAt: createdAt(),
    finishedAt: text('finished_at'),
  },
  (t) => ({ wsIdx: index('research_jobs_ws_idx').on(t.workspaceId, t.createdAt) }),
);

/** 研究来源（可溯源引用） */
export const researchSources = sqliteTable(
  'research_sources',
  {
    id: id(),
    researchJobId: text('research_job_id')
      .notNull()
      .references(() => researchJobs.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    title: text('title').notNull().default(''),
    snippet: text('snippet').notNull().default(''),
    content: text('content').notNull().default(''),
    accessedAt: text('accessed_at').notNull(),
    reliability: real('reliability').notNull().default(0.5),
    requiresAuth: integer('requires_auth', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => ({ jobIdx: index('research_sources_job_idx').on(t.researchJobId) }),
);

/** 交叉验证出的论断（含冲突标记） */
export const researchClaims = sqliteTable(
  'research_claims',
  {
    id: id(),
    researchJobId: text('research_job_id')
      .notNull()
      .references(() => researchJobs.id, { onDelete: 'cascade' }),
    claim: text('claim').notNull(),
    supportingSources: json('supporting_sources').$type<string[]>().notNull().default([]),
    conflictingSources: json('conflicting_sources').$type<string[]>().notNull().default([]),
    confidence: real('confidence').notNull().default(0.5),
    disputed: integer('disputed', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => ({ jobIdx: index('research_claims_job_idx').on(t.researchJobId) }),
);

/** 研究报告产物 */
export const researchReports = sqliteTable(
  'research_reports',
  {
    id: id(),
    researchJobId: text('research_job_id')
      .notNull()
      .references(() => researchJobs.id, { onDelete: 'cascade' }),
    markdown: text('markdown').notNull().default(''),
    charts: json('charts').$type<{ title: string; kind: string; data: unknown }[]>().notNull().default([]),
    referencesJson: json('references_json')
      .$type<{ index: number; sourceId: string; title: string; url: string; accessedAt: string; snippet: string }[]>()
      .notNull()
      .default([]),
    markdownPath: text('markdown_path'),
    pdfPath: text('pdf_path'),
    pptxPath: text('pptx_path'),
    webUrl: text('web_url'),
    createdAt: createdAt(),
  },
  (t) => ({ jobIdx: uniqueIndex('research_reports_job_idx').on(t.researchJobId) }),
);

/* ================================================================== */
/* Phase 3 增量表（交付与自动化）                                       */
/* ================================================================== */
export {
  websiteProjects,
  websiteBuilds,
  websiteDeployments,
  websiteAccessRules,
  databaseSchemas,
  databaseMigrations,
  dashboards,
  widgetDataSources,
  notifyChannels,
  notifyLogs,
  deployAudits,
  dbAudits,
  scheduleAudits,
} from './phase3.ts';

/* ================================================================== */
/* Phase 4 增量表（生态、集群与提示词工程）                             */
/* ================================================================== */
export * from './phase4.ts';

