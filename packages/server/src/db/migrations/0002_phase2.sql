-- =====================================================================
-- Phase 2 迁移：核心能力（百万 Token 上下文 / 目标模式 / 多 Agent / Office / 深度研究）
-- 原则：只新增列与表，不改动、不删除 Phase 1 结构 → 可与 0001 共存，
--       回滚脚本 0002_phase2.down.sql 只删除本文件新增内容。
-- =====================================================================

-- ------------------------- Step 1：分层上下文 -------------------------
ALTER TABLE memory_facts ADD COLUMN embedding TEXT;
ALTER TABLE memory_facts ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_facts ADD COLUMN fact_type TEXT NOT NULL DEFAULT 'fact';
ALTER TABLE memory_facts ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS facts_conv_type_idx ON memory_facts(conversation_id, fact_type);

ALTER TABLE conversation_summaries ADD COLUMN kind TEXT NOT NULL DEFAULT 'rolling';
ALTER TABLE conversation_summaries ADD COLUMN covered_count INTEGER NOT NULL DEFAULT 0;

-- ------------------------- Step 2：目标模式 --------------------------
CREATE TABLE IF NOT EXISTS goal_runs (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  iteration INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  plan TEXT,
  reflection TEXT NOT NULL DEFAULT '',
  audit_report TEXT,
  task_ids TEXT NOT NULL DEFAULT '[]',
  tokens_used INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS goal_runs_goal_idx ON goal_runs(goal_id, iteration);

CREATE TABLE IF NOT EXISTS goal_audits (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  passed INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  criteria TEXT NOT NULL DEFAULT '[]',
  issues TEXT NOT NULL DEFAULT '[]',
  next_actions TEXT NOT NULL DEFAULT '[]',
  markdown TEXT NOT NULL DEFAULT '',
  degraded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_audits_goal_idx ON goal_audits(goal_id, created_at);

-- 目标模式增强：任务级反思与产出摘要
ALTER TABLE tasks ADD COLUMN reflection TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN output_summary TEXT;
ALTER TABLE tasks ADD COLUMN last_agent_id TEXT;
ALTER TABLE tasks ADD COLUMN tokens_used INTEGER NOT NULL DEFAULT 0;

-- --------------------- Step 3/4：多 Agent 集群 -----------------------
CREATE TABLE IF NOT EXISTS cluster_configs (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'parallel',
  max_parallel INTEGER NOT NULL DEFAULT 4,
  node_id TEXT NOT NULL DEFAULT 'local',
  experimental INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

ALTER TABLE agent_messages ADD COLUMN thread_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'broadcast';
ALTER TABLE agent_messages ADD COLUMN content TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS agent_messages_thread_idx ON agent_messages(goal_id, thread_id);

-- --------------------- Step 5：Office 文件处理 ----------------------
CREATE TABLE IF NOT EXISTS office_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id TEXT,
  path TEXT NOT NULL,
  format TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '{}',
  meta TEXT NOT NULL DEFAULT '{}',
  warnings TEXT NOT NULL DEFAULT '[]',
  parsed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS office_docs_ws_path_idx ON office_documents(workspace_id, path);

CREATE TABLE IF NOT EXISTS office_previews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  format TEXT NOT NULL,
  markdown TEXT NOT NULL DEFAULT '',
  renderer TEXT NOT NULL DEFAULT 'markdown',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_exports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  storage_path TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  /** 可直接对外访问的 URL，null 表示仅本地 */
  url TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS file_exports_file_idx ON file_exports(file_id);

-- --------------------- Step 6：深度研究 -----------------------------
CREATE TABLE IF NOT EXISTS research_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  depth TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'pending',
  queries TEXT NOT NULL DEFAULT '[]',
  progress INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT '',
  output_formats TEXT NOT NULL DEFAULT '["markdown"]',
  allow_network INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS research_jobs_ws_idx ON research_jobs(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS research_sources (
  id TEXT PRIMARY KEY,
  research_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  accessed_at TEXT NOT NULL,
  reliability REAL NOT NULL DEFAULT 0.5,
  requires_auth INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS research_sources_job_idx ON research_sources(research_job_id);

CREATE TABLE IF NOT EXISTS research_claims (
  id TEXT PRIMARY KEY,
  research_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
  claim TEXT NOT NULL,
  supporting_sources TEXT NOT NULL DEFAULT '[]',
  conflicting_sources TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  disputed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS research_claims_job_idx ON research_claims(research_job_id);

CREATE TABLE IF NOT EXISTS research_reports (
  id TEXT PRIMARY KEY,
  research_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
  markdown TEXT NOT NULL DEFAULT '',
  charts TEXT NOT NULL DEFAULT '[]',
  references_json TEXT NOT NULL DEFAULT '[]',
  markdown_path TEXT,
  pdf_path TEXT,
  pptx_path TEXT,
  web_url TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS research_reports_job_idx ON research_reports(research_job_id);
