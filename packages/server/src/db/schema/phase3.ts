import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { databaseConnections, widgets, workspaces } from './index.ts';

/* ------------------------------------------------------------------ */
/* 通用列                                                              */
/* ------------------------------------------------------------------ */
const id = () => text('id').primaryKey();
const createdAt = () => text('created_at').notNull();
const updatedAt = () => text('updated_at').notNull();
const json = (name: string) => text(name, { mode: 'json' });

/* ================================================================== */
/* Step 1：网站项目 / 构建                                             */
/* ================================================================== */
export const websiteProjects = sqliteTable(
  'website_projects',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** static | fullstack | fullstack-db */
    type: text('type', { enum: ['static', 'fullstack', 'fullstack-db'] }).notNull().default('static'),
    /** vite-react | next | astro | vanilla-html | node-http */
    framework: text('framework').notNull().default('vanilla-html'),
    status: text('status', {
      enum: ['draft', 'generated', 'built', 'deployed', 'failed', 'deleted'],
    })
      .notNull()
      .default('draft'),
    requirement: text('requirement').notNull().default(''),
    plan: json('plan').$type<Record<string, unknown>>().notNull().default({}),
    rootDir: text('root_dir'),
    entryFile: text('entry_file'),
    previewUrl: text('preview_url'),
    databaseConnectionId: text('database_connection_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ wsIdx: index('website_projects_ws_idx').on(t.workspaceId) }),
);

export const websiteBuilds = sqliteTable(
  'website_builds',
  {
    id: id(),
    websiteProjectId: text('website_project_id')
      .notNull()
      .references(() => websiteProjects.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    files: json('files').$type<{ path: string; bytes: number }[]>().notNull().default([]),
    buildLog: text('build_log').notNull().default(''),
    status: text('status', { enum: ['pending', 'running', 'succeeded', 'failed'] })
      .notNull()
      .default('pending'),
    trigger: text('trigger').notNull().default('manual'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => ({ projectIdx: index('website_builds_project_idx').on(t.websiteProjectId, t.version) }),
);

/* ================================================================== */
/* Step 3：部署 / 访问控制                                             */
/* ================================================================== */
export const websiteDeployments = sqliteTable(
  'website_deployments',
  {
    id: id(),
    websiteProjectId: text('website_project_id')
      .notNull()
      .references(() => websiteProjects.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['vercel', 'cloudflare-pages', 'netlify', 'local-preview'] }).notNull(),
    deploymentId: text('deployment_id'),
    url: text('url'),
    customDomain: text('custom_domain'),
    /** 变量名 + 加密引用，绝不存明文 */
    envVars: json('env_vars').$type<{ key: string; secretRef: string }[]>().notNull().default([]),
    status: text('status', {
      enum: ['queued', 'building', 'uploaded', 'deployed', 'failed', 'rolled-back', 'deleted'],
    })
      .notNull()
      .default('queued'),
    log: text('log').notNull().default(''),
    buildId: text('build_id'),
    rollbackOf: text('rollback_of'),
    error: text('error'),
    deployedAt: text('deployed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ projectIdx: index('website_deployments_project_idx').on(t.websiteProjectId, t.createdAt) }),
);

export const websiteAccessRules = sqliteTable(
  'website_access_rules',
  {
    id: id(),
    websiteProjectId: text('website_project_id')
      .notNull()
      .references(() => websiteProjects.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ['password', 'email-allowlist', 'ip-allowlist'] }).notNull(),
    /** 非敏感值：邮箱 / IP；密码类此列为掩码 */
    value: text('value').notNull(),
    /** 密码类只存 hash（scrypt），从不存明文 */
    hash: text('hash'),
    createdAt: createdAt(),
  },
  (t) => ({ projectIdx: index('website_access_rules_project_idx').on(t.websiteProjectId) }),
);

/* ================================================================== */
/* Step 2：数据库 Schema / 迁移（连接表复用 0001 + 0003 新增列）        */
/* ================================================================== */
export const databaseSchemas = sqliteTable(
  'database_schemas',
  {
    id: id(),
    databaseConnectionId: text('database_connection_id')
      .notNull()
      .references(() => databaseConnections.id, { onDelete: 'cascade' }),
    schemaJson: json('schema_json').$type<Record<string, unknown>>().notNull().default({}),
    version: integer('version').notNull().default(1),
    note: text('note').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => ({ connIdx: index('database_schemas_conn_idx').on(t.databaseConnectionId, t.version) }),
);

export const databaseMigrations = sqliteTable(
  'database_migrations',
  {
    id: id(),
    databaseConnectionId: text('database_connection_id')
      .notNull()
      .references(() => databaseConnections.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sql: text('sql').notNull(),
    /** 回滚脚本 → 每条迁移可独立回滚 */
    downSql: text('down_sql').notNull().default(''),
    status: text('status', { enum: ['pending', 'applied', 'failed', 'rolled-back'] })
      .notNull()
      .default('pending'),
    appliedAt: text('applied_at'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => ({ connIdx: index('database_migrations_conn_idx').on(t.databaseConnectionId, t.createdAt) }),
);

/* ================================================================== */
/* Step 4：看板 / 小组件数据源                                          */
/* ================================================================== */
export const dashboards = sqliteTable(
  'dashboards',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    layoutJson: json('layout_json').$type<Record<string, unknown>>().notNull().default({}),
    /** 布局历史快照，用于布局回滚 */
    layoutHistory: json('layout_history').$type<{ at: string; layout: Record<string, unknown> }[]>().notNull().default([]),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ wsIdx: index('dashboards_ws_idx').on(t.workspaceId) }),
);

export const widgetDataSources = sqliteTable(
  'widget_data_sources',
  {
    id: id(),
    widgetId: text('widget_id')
      .notNull()
      .references(() => widgets.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: ['local-db', 'agent-runtime', 'deployment-status', 'schedule-status', 'custom-http'],
    }).notNull(),
    configJson: json('config_json').$type<Record<string, unknown>>().notNull().default({}),
    lastValue: json('last_value').$type<unknown>(),
    lastRefreshedAt: text('last_refreshed_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => ({ widgetIdx: index('widget_data_sources_widget_idx').on(t.widgetId) }),
);

/* ================================================================== */
/* Step 6：推送通知                                                     */
/* ================================================================== */
export const notifyChannels = sqliteTable(
  'notify_channels',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ['desktop', 'email', 'webhook', 'feishu', 'dingtalk', 'wecom'] }).notNull(),
    name: text('name').notNull(),
    /** 加密配置（webhook url / smtp 口令 / 机器人签名密钥） */
    encryptedConfig: text('encrypted_config'),
    /** 非敏感配置 */
    config: json('config').$type<Record<string, unknown>>().notNull().default({}),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastTestedAt: text('last_tested_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ wsIdx: index('notify_channels_ws_idx').on(t.workspaceId) }),
);

export const notifyLogs = sqliteTable(
  'notify_logs',
  {
    id: id(),
    channelId: text('channel_id')
      .notNull()
      .references(() => notifyChannels.id, { onDelete: 'cascade' }),
    scheduleRunId: text('schedule_run_id'),
    event: text('event').notNull().default('manual'),
    title: text('title').notNull(),
    content: text('content').notNull().default(''),
    status: text('status', { enum: ['pending', 'sent', 'failed'] }).notNull().default('pending'),
    attempt: integer('attempt').notNull().default(1),
    sentAt: text('sent_at'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => ({ channelIdx: index('notify_logs_channel_idx').on(t.channelId, t.createdAt) }),
);

/* ================================================================== */
/* 审计：部署 / 数据库 / 定时（独立于 audit_logs，便于按域查询）        */
/* ================================================================== */
export const deployAudits = sqliteTable(
  'deploy_audits',
  {
    id: id(),
    deploymentId: text('deployment_id'),
    websiteProjectId: text('website_project_id'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    actor: text('actor').notNull(),
    dangerous: integer('dangerous', { mode: 'boolean' }).notNull().default(false),
    confirmedByUser: integer('confirmed_by_user', { mode: 'boolean' }).notNull().default(false),
    detail: json('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => ({ wsIdx: index('deploy_audits_ws_idx').on(t.workspaceId, t.createdAt) }),
);

export const dbAudits = sqliteTable(
  'db_audits',
  {
    id: id(),
    databaseConnectionId: text('database_connection_id'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    actor: text('actor').notNull(),
    dangerous: integer('dangerous', { mode: 'boolean' }).notNull().default(false),
    confirmedByUser: integer('confirmed_by_user', { mode: 'boolean' }).notNull().default(false),
    detail: json('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => ({ wsIdx: index('db_audits_ws_idx').on(t.workspaceId, t.createdAt) }),
);

export const scheduleAudits = sqliteTable(
  'schedule_audits',
  {
    id: id(),
    scheduleId: text('schedule_id'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    actor: text('actor').notNull(),
    dangerous: integer('dangerous', { mode: 'boolean' }).notNull().default(false),
    confirmedByUser: integer('confirmed_by_user', { mode: 'boolean' }).notNull().default(false),
    detail: json('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => ({ wsIdx: index('schedule_audits_ws_idx').on(t.workspaceId, t.createdAt) }),
);
