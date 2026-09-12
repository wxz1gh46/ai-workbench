-- =====================================================================
-- Phase 3 迁移：交付与自动化
--   网站生成/部署 · Neon/Supabase 数据库 · 定制看板 · 定时任务 · 推送通知
-- 原则：只新增表与列，不改动、不删除 Phase 1/2 结构
--       → 可与 0001/0002 共存，回滚脚本 0003_phase3.down.sql 只删除本文件新增内容
--       → 新增列一律带 DEFAULT，保证老数据可读（向后兼容）
-- =====================================================================

-- ------------------------- Step 1：网站项目 --------------------------
CREATE TABLE IF NOT EXISTS website_projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  /** static | fullstack | fullstack-db */
  type TEXT NOT NULL DEFAULT 'static',
  /** vite-react | next | astro | vanilla-html | node-http */
  framework TEXT NOT NULL DEFAULT 'vanilla-html',
  /** draft | generated | built | deployed | failed | deleted */
  status TEXT NOT NULL DEFAULT 'draft',
  /** 自然语言需求原文 */
  requirement TEXT NOT NULL DEFAULT '',
  /** 需求解析结果（页面/实体/接口/访问控制） */
  plan JSON NOT NULL DEFAULT '{}',
  /** 生成的项目根目录（相对工作区根目录） */
  root_dir TEXT,
  entry_file TEXT,
  preview_url TEXT,
  database_connection_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS website_projects_ws_idx ON website_projects(workspace_id);

CREATE TABLE IF NOT EXISTS website_builds (
  id TEXT PRIMARY KEY,
  website_project_id TEXT NOT NULL REFERENCES website_projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  /** 生成/构建的文件清单 [{path, bytes}] */
  files JSON NOT NULL DEFAULT '[]',
  build_log TEXT NOT NULL DEFAULT '',
  /** pending | running | succeeded | failed */
  status TEXT NOT NULL DEFAULT 'pending',
  /** manual | rollback | schedule | agent */
  trigger TEXT NOT NULL DEFAULT 'manual',
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS website_builds_project_idx ON website_builds(website_project_id, version);

-- ------------------------- Step 3：部署记录 --------------------------
CREATE TABLE IF NOT EXISTS website_deployments (
  id TEXT PRIMARY KEY,
  website_project_id TEXT NOT NULL REFERENCES website_projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  /** 平台侧部署 id */
  deployment_id TEXT,
  url TEXT,
  custom_domain TEXT,
  /** 只存变量名与加密引用，不存明文值 */
  env_vars JSON NOT NULL DEFAULT '[]',
  /** queued | building | uploaded | deployed | failed | rolled-back | deleted */
  status TEXT NOT NULL DEFAULT 'queued',
  log TEXT NOT NULL DEFAULT '',
  build_id TEXT,
  /** 回滚来源部署 id，支持回滚链追溯 */
  rollback_of TEXT,
  error TEXT,
  deployed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS website_deployments_project_idx ON website_deployments(website_project_id, created_at);

CREATE TABLE IF NOT EXISTS website_access_rules (
  id TEXT PRIMARY KEY,
  website_project_id TEXT NOT NULL REFERENCES website_projects(id) ON DELETE CASCADE,
  /** password | email-allowlist | ip-allowlist */
  type TEXT NOT NULL,
  /** 非敏感值（邮箱/IP）；密码类只存 hash */
  value TEXT NOT NULL,
  hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS website_access_rules_project_idx ON website_access_rules(website_project_id);

-- ------------------------- Step 2：数据库接入 ------------------------
-- 复用 0001 的 database_connections，仅补齐 Phase 3 需要的列
ALTER TABLE database_connections ADD COLUMN provider TEXT NOT NULL DEFAULT 'neon';
ALTER TABLE database_connections ADD COLUMN status TEXT NOT NULL DEFAULT 'unconfigured';
ALTER TABLE database_connections ADD COLUMN encrypted_config TEXT;
ALTER TABLE database_connections ADD COLUMN schema_json JSON NOT NULL DEFAULT '{}';
ALTER TABLE database_connections ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE database_connections ADD COLUMN last_tested_at TEXT;
ALTER TABLE database_connections ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS database_schemas (
  id TEXT PRIMARY KEY,
  database_connection_id TEXT NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE,
  schema_json JSON NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS database_schemas_conn_idx ON database_schemas(database_connection_id, version);

CREATE TABLE IF NOT EXISTS database_migrations (
  id TEXT PRIMARY KEY,
  database_connection_id TEXT NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sql TEXT NOT NULL,
  /** 回滚脚本，保证每条迁移可独立回滚 */
  down_sql TEXT NOT NULL DEFAULT '',
  /** pending | applied | failed | rolled-back */
  status TEXT NOT NULL DEFAULT 'pending',
  applied_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS database_migrations_conn_idx ON database_migrations(database_connection_id, created_at);

-- ------------------------- Step 4：看板与小组件 ----------------------
CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  /** 布局快照，用于「看板布局可回滚」 */
  layout_json JSON NOT NULL DEFAULT '{}',
  /** 布局历史（最近 N 个快照） */
  layout_history JSON NOT NULL DEFAULT '[]',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dashboards_ws_idx ON dashboards(workspace_id);

-- widgets 已有表：补齐 Phase 3 需要的列（老 dashboard_id='default' 数据仍可用）
ALTER TABLE widgets ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE widgets ADD COLUMN size TEXT NOT NULL DEFAULT 'md';
ALTER TABLE widgets ADD COLUMN data_source TEXT NOT NULL DEFAULT 'local';
ALTER TABLE widgets ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS widget_data_sources (
  id TEXT PRIMARY KEY,
  widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  /** local-db | agent-runtime | deployment-status | schedule-status | custom-http */
  type TEXT NOT NULL,
  config_json JSON NOT NULL DEFAULT '{}',
  last_value JSON,
  last_refreshed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS widget_data_sources_widget_idx ON widget_data_sources(widget_id);

-- ------------------------- Step 5：定时任务 --------------------------
-- 复用 0001 的 schedules / schedule_runs，补齐 Phase 3 需要的列
ALTER TABLE schedules ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai';
ALTER TABLE schedules ADD COLUMN task_type TEXT NOT NULL DEFAULT 'goal';
ALTER TABLE schedules ADD COLUMN task_config JSON NOT NULL DEFAULT '{}';
ALTER TABLE schedules ADD COLUMN template TEXT;
ALTER TABLE schedules ADD COLUMN retry_policy JSON NOT NULL DEFAULT '{}';
ALTER TABLE schedules ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 1;
ALTER TABLE schedules ADD COLUMN interrupted_at TEXT;

ALTER TABLE schedule_runs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedule_runs ADD COLUMN result JSON;
ALTER TABLE schedule_runs ADD COLUMN error TEXT;
ALTER TABLE schedule_runs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'auto';

-- ------------------------- Step 6：推送通知 --------------------------
CREATE TABLE IF NOT EXISTS notify_channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  /** desktop | email | webhook | feishu | dingtalk | wecom */
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  /** 加密后的渠道配置（webhook url / smtp 密码 / 机器人密钥） */
  encrypted_config TEXT,
  /** 非敏感配置（host/port/from/收件人） */
  config JSON NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_tested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notify_channels_ws_idx ON notify_channels(workspace_id);

CREATE TABLE IF NOT EXISTS notify_logs (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES notify_channels(id) ON DELETE CASCADE,
  schedule_run_id TEXT,
  /** schedule | goal | deploy | error | test | manual */
  event TEXT NOT NULL DEFAULT 'manual',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  /** pending | sent | failed */
  status TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 1,
  sent_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notify_logs_channel_idx ON notify_logs(channel_id, created_at);

-- ------------------------- 审计（部署 / 数据库 / 定时）----------------
CREATE TABLE IF NOT EXISTS deploy_audits (
  id TEXT PRIMARY KEY,
  deployment_id TEXT,
  website_project_id TEXT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  dangerous INTEGER NOT NULL DEFAULT 0,
  confirmed_by_user INTEGER NOT NULL DEFAULT 0,
  detail JSON NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deploy_audits_ws_idx ON deploy_audits(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS db_audits (
  id TEXT PRIMARY KEY,
  database_connection_id TEXT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  dangerous INTEGER NOT NULL DEFAULT 0,
  confirmed_by_user INTEGER NOT NULL DEFAULT 0,
  detail JSON NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS db_audits_ws_idx ON db_audits(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS schedule_audits (
  id TEXT PRIMARY KEY,
  schedule_id TEXT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  dangerous INTEGER NOT NULL DEFAULT 0,
  confirmed_by_user INTEGER NOT NULL DEFAULT 0,
  detail JSON NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS schedule_audits_ws_idx ON schedule_audits(workspace_id, created_at);
