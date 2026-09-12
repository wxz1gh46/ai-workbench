-- =====================================================================
-- Phase 4 迁移：生态、集群与提示词工程
--   插件系统与 MCP · 付费数据库 · 提示词工程 · 实验性集群
--   多 Agent 并行 · 企业安全与审计
-- 原则：只新增表，不改动、不删除 Phase 1/2/3 结构
--       → 可与 0001/0002/0003 共存，回滚脚本 0004_phase4.down.sql 只删除本文件新增内容
-- =====================================================================

-- ------------------------- Step 1：插件系统与 MCP --------------------------
CREATE TABLE IF NOT EXISTS plugin_installations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  -- installed | enabled | disabled | error
  status TEXT NOT NULL DEFAULT 'installed',
  -- 安装时 manifest 快照与哈希：更新时比对，防篡改
  manifest TEXT NOT NULL DEFAULT '{}',
  manifest_hash TEXT NOT NULL DEFAULT '',
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_installations_ws_plugin_idx ON plugin_installations(workspace_id, plugin_id);

CREATE TABLE IF NOT EXISTS plugin_versions (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  manifest TEXT NOT NULL DEFAULT '{}',
  hash TEXT NOT NULL DEFAULT '',
  released_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plugin_versions_plugin_idx ON plugin_versions(plugin_id, version);

CREATE TABLE IF NOT EXISTS plugin_permissions (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_permissions_plugin_scope_idx ON plugin_permissions(plugin_id, scope);

CREATE TABLE IF NOT EXISTS plugin_grants (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES plugin_permissions(id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL,
  granted_by TEXT NOT NULL DEFAULT 'user',
  -- NULL 表示长期有效
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS plugin_grants_inst_idx ON plugin_grants(installation_id);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_grants_perm_idx ON plugin_grants(installation_id, permission_id);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- stdio | http | sse | websocket
  transport TEXT NOT NULL DEFAULT 'stdio',
  endpoint TEXT NOT NULL DEFAULT '',
  command TEXT,
  args TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'registered',
  capabilities TEXT NOT NULL DEFAULT '{}',
  -- 需要用户提供的凭据「变量名」，绝不存值
  secret_refs TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_servers_ws_name_idx ON mcp_servers(workspace_id, name);

CREATE TABLE IF NOT EXISTS mcp_tools (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  schema TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  dangerous INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_tools_server_name_idx ON mcp_tools(server_id, name);

-- ------------------------- Step 2：付费数据库 --------------------------
CREATE TABLE IF NOT EXISTS paid_data_credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  -- AES-256-GCM 密文，永不明文
  encrypted_config TEXT NOT NULL,
  -- 只列字段名，不含值
  field_names TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'configured',
  last_verified_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS paid_credentials_ws_provider_idx ON paid_data_credentials(workspace_id, provider_id);

CREATE TABLE IF NOT EXISTS paid_data_queries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  action TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  cached INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS paid_queries_ws_idx ON paid_data_queries(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS paid_data_results (
  id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL REFERENCES paid_data_queries(id) ON DELETE CASCADE,
  data TEXT,
  citations TEXT NOT NULL DEFAULT '[]',
  cache_key TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS paid_results_query_idx ON paid_data_results(query_id);
CREATE INDEX IF NOT EXISTS paid_results_cache_idx ON paid_data_results(cache_key);

-- ------------------------- Step 3：提示词工程 --------------------------
CREATE TABLE IF NOT EXISTS prompt_variables (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'string',
  required INTEGER NOT NULL DEFAULT 0,
  default_value TEXT,
  description TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS prompt_variables_tpl_name_idx ON prompt_variables(template_id, name);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user'
);
CREATE INDEX IF NOT EXISTS prompt_versions_tpl_idx ON prompt_versions(template_id, version);

CREATE TABLE IF NOT EXISTS prompt_ab_tests (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  version_a INTEGER NOT NULL,
  version_b INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prompt_ab_tpl_idx ON prompt_ab_tests(template_id);

CREATE TABLE IF NOT EXISTS prompt_evaluations (
  id TEXT PRIMARY KEY,
  ab_test_id TEXT NOT NULL,
  version TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  sample_size INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prompt_eval_ab_idx ON prompt_evaluations(ab_test_id);

-- ------------------------- Step 4：实验性集群 --------------------------
CREATE TABLE IF NOT EXISTS cluster_nodes (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL DEFAULT 'local',
  name TEXT NOT NULL,
  -- leader | worker | candidate
  role TEXT NOT NULL DEFAULT 'worker',
  host TEXT NOT NULL DEFAULT '127.0.0.1',
  port INTEGER NOT NULL DEFAULT 0,
  -- online | offline | draining | error
  status TEXT NOT NULL DEFAULT 'offline',
  resources TEXT NOT NULL DEFAULT '{}',
  labels TEXT NOT NULL DEFAULT '{}',
  last_heartbeat TEXT,
  heartbeat_miss INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cluster_nodes_cluster_idx ON cluster_nodes(cluster_id);
CREATE UNIQUE INDEX IF NOT EXISTS cluster_nodes_cluster_name_idx ON cluster_nodes(cluster_id, name);

CREATE TABLE IF NOT EXISTS cluster_shards (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  goal_id TEXT,
  index_ INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 1,
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  assigned_node_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS cluster_shards_task_idx ON cluster_shards(task_id);
CREATE INDEX IF NOT EXISTS cluster_shards_status_idx ON cluster_shards(status);

CREATE TABLE IF NOT EXISTS cluster_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  goal_id TEXT,
  task_id TEXT,
  shard_id TEXT,
  assigned_node_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cluster_tasks_ws_idx ON cluster_tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS cluster_tasks_shard_idx ON cluster_tasks(shard_id);

CREATE TABLE IF NOT EXISTS cluster_elections (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL DEFAULT 'local',
  term INTEGER NOT NULL DEFAULT 1,
  leader_node_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'initial',
  elected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cluster_elections_cluster_idx ON cluster_elections(cluster_id, term);

CREATE TABLE IF NOT EXISTS cluster_health (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES cluster_nodes(id) ON DELETE CASCADE,
  cpu REAL NOT NULL DEFAULT 0,
  memory REAL NOT NULL DEFAULT 0,
  gpu REAL NOT NULL DEFAULT 0,
  disk REAL NOT NULL DEFAULT 0,
  network REAL NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cluster_health_node_idx ON cluster_health(node_id, recorded_at);

CREATE TABLE IF NOT EXISTS cluster_policies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'default',
  max_nodes INTEGER NOT NULL DEFAULT 8,
  max_parallel_tasks INTEGER NOT NULL DEFAULT 4,
  resource_limits TEXT NOT NULL DEFAULT '{}',
  fallback_enabled INTEGER NOT NULL DEFAULT 1,
  heartbeat_timeout_ms INTEGER NOT NULL DEFAULT 30000,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ------------------------- Step 5：多 Agent 并行 --------------------------
CREATE TABLE IF NOT EXISTS agent_pools (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  min_agents INTEGER NOT NULL DEFAULT 1,
  max_agents INTEGER NOT NULL DEFAULT 4,
  active_agents INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  tools TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_pools_ws_role_idx ON agent_pools(workspace_id, role);

CREATE TABLE IF NOT EXISTS agent_routes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  pool_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  score REAL NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'agent',
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_routes_task_idx ON agent_routes(task_id);

CREATE TABLE IF NOT EXISTS aggregated_results (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  goal_id TEXT,
  strategy TEXT NOT NULL DEFAULT 'concat',
  result TEXT NOT NULL DEFAULT '{}',
  conflicts TEXT NOT NULL DEFAULT '[]',
  needs_review INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS aggregated_results_task_idx ON aggregated_results(task_id);

CREATE TABLE IF NOT EXISTS cost_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  goal_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  model TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  budget_state TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cost_records_ws_idx ON cost_records(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS cost_records_goal_idx ON cost_records(goal_id);

-- ------------------------- Step 6：企业安全与审计 --------------------------
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_ws_name_idx ON roles(workspace_id, name);

CREATE TABLE IF NOT EXISTS user_roles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_user_role_idx ON user_roles(workspace_id, user_id, role_id);

CREATE TABLE IF NOT EXISTS sso_configs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL DEFAULT 'oidc',
  enabled INTEGER NOT NULL DEFAULT 0,
  issuer TEXT NOT NULL DEFAULT '',
  client_id TEXT NOT NULL DEFAULT '',
  -- 只存环境变量名，绝不存 client secret
  client_secret_ref TEXT NOT NULL DEFAULT '',
  redirect_uri TEXT NOT NULL DEFAULT '',
  group_mapping TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_exports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'audit',
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  file_path TEXT NOT NULL DEFAULT '',
  row_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_exports_ws_idx ON audit_exports(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS data_mask_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  -- full | partial | hash | nullify
  strategy TEXT NOT NULL DEFAULT 'partial',
  target TEXT NOT NULL DEFAULT '*',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS data_mask_ws_field_target_idx ON data_mask_rules(workspace_id, field, target);

CREATE TABLE IF NOT EXISTS retention_policies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  data_type TEXT NOT NULL,
  retention_days INTEGER NOT NULL DEFAULT 90,
  -- delete | anonymize | archive
  action TEXT NOT NULL DEFAULT 'delete',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_affected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS retention_ws_type_idx ON retention_policies(workspace_id, data_type);
