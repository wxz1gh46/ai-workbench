import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { plugins, workspaces } from './index.ts';

/* ------------------------------------------------------------------ */
/* 通用列                                                              */
/* ------------------------------------------------------------------ */
const id = () => text('id').primaryKey();
const createdAt = () => text('created_at').notNull();
const updatedAt = () => text('updated_at').notNull();
const json = (name: string) => text(name, { mode: 'json' });

/* ================================================================== */
/* Step 1：插件系统与 MCP                                              */
/* ================================================================== */

/** 插件市场条目（当前仓库以「精选目录 + 本地 manifest」为准，此表存安装态） */
export const pluginInstallations = sqliteTable(
  'plugin_installations',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    pluginId: text('plugin_id')
      .notNull()
      .references(() => plugins.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    status: text('status', { enum: ['installed', 'enabled', 'disabled', 'error'] })
      .notNull()
      .default('installed'),
    /** 安装时的 manifest 快照与哈希，用于「更新」时比对是否被篡改 */
    manifest: json('manifest').$type<Record<string, unknown>>().notNull().default({}),
    manifestHash: text('manifest_hash').notNull().default(''),
    installedAt: text('installed_at').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    wsIdx: uniqueIndex('plugin_installations_ws_plugin_idx').on(t.workspaceId, t.pluginId),
  }),
);

/** 插件版本记录（每次安装/更新追加一行，可追溯） */
export const pluginVersions = sqliteTable(
  'plugin_versions',
  {
    id: id(),
    pluginId: text('plugin_id')
      .notNull()
      .references(() => plugins.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    manifest: json('manifest').$type<Record<string, unknown>>().notNull().default({}),
    hash: text('hash').notNull().default(''),
    releasedAt: text('released_at').notNull(),
  },
  (t) => ({ pluginIdx: index('plugin_versions_plugin_idx').on(t.pluginId, t.version) }),
);

/** 插件声明的权限项 */
export const pluginPermissions = sqliteTable(
  'plugin_permissions',
  {
    id: id(),
    pluginId: text('plugin_id')
      .notNull()
      .references(() => plugins.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    description: text('description').notNull().default(''),
    required: integer('required', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => ({ pluginIdx: uniqueIndex('plugin_permissions_plugin_scope_idx').on(t.pluginId, t.scope) }),
);

/** 用户逐项授权记录（可撤销、可设过期） */
export const pluginGrants = sqliteTable(
  'plugin_grants',
  {
    id: id(),
    installationId: text('installation_id')
      .notNull()
      .references(() => pluginInstallations.id, { onDelete: 'cascade' }),
    permissionId: text('permission_id')
      .notNull()
      .references(() => pluginPermissions.id, { onDelete: 'cascade' }),
    grantedAt: text('granted_at').notNull(),
    grantedBy: text('granted_by').notNull().default('user'),
    /** 过期时间；null 表示长期有效 */
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
  },
  (t) => ({
    instIdx: index('plugin_grants_inst_idx').on(t.installationId),
    permIdx: uniqueIndex('plugin_grants_perm_idx').on(t.installationId, t.permissionId),
  }),
);

/** MCP 服务器注册 */
export const mcpServers = sqliteTable(
  'mcp_servers',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** stdio | http | sse | websocket */
    transport: text('transport').notNull().default('stdio'),
    /** stdio 时为命令；http/sse 时为 URL。绝不存凭据明文 */
    endpoint: text('endpoint').notNull().default(''),
    command: text('command'),
    args: json('args').$type<string[]>().notNull().default([]),
    status: text('status', { enum: ['registered', 'connected', 'error', 'disabled'] })
      .notNull()
      .default('registered'),
    capabilities: json('capabilities').$type<Record<string, unknown>>().notNull().default({}),
    /** 需要用户提供凭据时的环境变量名列表 */
    secretRefs: json('secret_refs').$type<string[]>().notNull().default([]),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ wsIdx: uniqueIndex('mcp_servers_ws_name_idx').on(t.workspaceId, t.name) }),
);

/** MCP 工具（服务器能力缓存 + 启用开关） */
export const mcpTools = sqliteTable(
  'mcp_tools',
  {
    id: id(),
    serverId: text('server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    schema: json('schema').$type<Record<string, unknown>>().notNull().default({}),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    dangerous: integer('dangerous', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => ({ serverIdx: uniqueIndex('mcp_tools_server_name_idx').on(t.serverId, t.name) }),
);

/* ================================================================== */
/* Step 2：付费数据库                                                  */
/* ================================================================== */

/** 付费数据源凭据（密文存储；UI 只回显 configured 布尔） */
export const paidDataCredentials = sqliteTable(
  'paid_data_credentials',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    /** AES-256-GCM 密文（seal()） */
    encryptedConfig: text('encrypted_config').notNull(),
    /** 只列字段名，不含值 */
    fieldNames: json('field_names').$type<string[]>().notNull().default([]),
    status: text('status', { enum: ['unconfigured', 'configured', 'verified', 'error'] })
      .notNull()
      .default('configured'),
    lastVerifiedAt: text('last_verified_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ wsIdx: uniqueIndex('paid_credentials_ws_provider_idx').on(t.workspaceId, t.providerId) }),
);

/** 查询记录（每次调用一行，含合规判定） */
export const paidDataQueries = sqliteTable(
  'paid_data_queries',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    /** 适配器动作，如 company.basic / market.quote */
    action: text('action').notNull(),
    params: json('params').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status', { enum: ['pending', 'running', 'succeeded', 'failed', 'blocked'] })
      .notNull()
      .default('pending'),
    cached: integer('cached', { mode: 'boolean' }).notNull().default(false),
    degraded: integer('degraded', { mode: 'boolean' }).notNull().default(false),
    rowCount: integer('row_count').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    error: text('error'),
    /** 合规守卫拒因（如「未使用官方 API」） */
    blockedReason: text('blocked_reason'),
    createdAt: createdAt(),
    finishedAt: text('finished_at'),
  },
  (t) => ({ wsIdx: index('paid_queries_ws_idx').on(t.workspaceId, t.createdAt) }),
);

/** 查询结果（含引用来源与时间） */
export const paidDataResults = sqliteTable(
  'paid_data_results',
  {
    id: id(),
    queryId: text('query_id')
      .notNull()
      .references(() => paidDataQueries.id, { onDelete: 'cascade' }),
    data: json('data').$type<unknown>(),
    citations: json('citations')
      .$type<{ title: string; url: string; accessedAt: string; provider: string }[]>()
      .notNull()
      .default([]),
    /** 结果缓存键（provider+action+params 归一化后的 hash） */
    cacheKey: text('cache_key').notNull().default(''),
    expiresAt: text('expires_at'),
    createdAt: createdAt(),
  },
  (t) => ({
    queryIdx: index('paid_results_query_idx').on(t.queryId),
    cacheIdx: index('paid_results_cache_idx').on(t.cacheKey),
  }),
);

/* ================================================================== */
/* Step 3：提示词工程                                                  */
/* ================================================================== */

/** 提示词变量声明 */
export const promptVariables = sqliteTable(
  'prompt_variables',
  {
    id: id(),
    templateId: text('template_id').notNull(),
    name: text('name').notNull(),
    type: text('type', { enum: ['string', 'number', 'boolean', 'enum'] }).notNull().default('string'),
    required: integer('required', { mode: 'boolean' }).notNull().default(false),
    defaultValue: text('default_value'),
    description: text('description').notNull().default(''),
    options: json('options').$type<string[]>().notNull().default([]),
  },
  (t) => ({ tplIdx: uniqueIndex('prompt_variables_tpl_name_idx').on(t.templateId, t.name) }),
);

/** 版本历史（每次保存追加；含 parent 便于链式回滚） */
export const promptVersions = sqliteTable(
  'prompt_versions',
  {
    id: id(),
    templateId: text('template_id').notNull(),
    version: integer('version').notNull(),
    content: json('content').$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    createdBy: text('created_by').notNull().default('user'),
  },
  (t) => ({ tplIdx: index('prompt_versions_tpl_idx').on(t.templateId, t.version) }),
);

/** A/B 测试（两版本对比） */
export const promptABTests = sqliteTable(
  'prompt_ab_tests',
  {
    id: id(),
    templateId: text('template_id').notNull(),
    name: text('name').notNull().default(''),
    versionA: integer('version_a').notNull(),
    versionB: integer('version_b').notNull(),
    status: text('status', { enum: ['draft', 'running', 'finished'] }).notNull().default('draft'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    createdAt: createdAt(),
  },
  (t) => ({ tplIdx: index('prompt_ab_tpl_idx').on(t.templateId) }),
);

/** 评估指标（每个测试每个版本多行：人工评分 / 自动指标） */
export const promptEvaluations = sqliteTable(
  'prompt_evaluations',
  {
    id: id(),
    abTestId: text('ab_test_id').notNull(),
    version: text('version').notNull(),
    metric: text('metric').notNull(),
    value: real('value').notNull().default(0),
    sampleSize: integer('sample_size').notNull().default(0),
    note: text('note').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => ({ abIdx: index('prompt_eval_ab_idx').on(t.abTestId) }),
);

/* ================================================================== */
/* Step 4：实验性集群                                                  */
/* ================================================================== */

export const clusterNodes = sqliteTable(
  'cluster_nodes',
  {
    id: id(),
    clusterId: text('cluster_id').notNull().default('local'),
    name: text('name').notNull(),
    role: text('role', { enum: ['leader', 'worker', 'candidate'] }).notNull().default('worker'),
    host: text('host').notNull().default('127.0.0.1'),
    port: integer('port').notNull().default(0),
    status: text('status', { enum: ['online', 'offline', 'draining', 'error'] })
      .notNull()
      .default('offline'),
    /** 资源声明 {cpu, memoryMb, gpu, diskGb, networkMbps} */
    resources: json('resources').$type<Record<string, number>>().notNull().default({}),
    labels: json('labels').$type<Record<string, string>>().notNull().default({}),
    lastHeartbeat: text('last_heartbeat'),
    heartbeatMiss: integer('heartbeat_miss').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    clusterIdx: index('cluster_nodes_cluster_idx').on(t.clusterId),
    nameIdx: uniqueIndex('cluster_nodes_cluster_name_idx').on(t.clusterId, t.name),
  }),
);

export const clusterShards = sqliteTable(
  'cluster_shards',
  {
    id: id(),
    taskId: text('task_id').notNull(),
    goalId: text('goal_id'),
    /** 列名用 index_：index 是 SQL 保留字，直接用作列名会让 SQLite 报 no such column */
    index: integer('index_').notNull().default(0),
    total: integer('total').notNull().default(1),
    payload: json('payload').$type<Record<string, unknown>>().notNull().default({}),
    result: json('result').$type<Record<string, unknown> | null>(),
    status: text('status', { enum: ['pending', 'assigned', 'running', 'succeeded', 'failed', 'reassigned'] })
      .notNull()
      .default('pending'),
    assignedNodeId: text('assigned_node_id'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    createdAt: createdAt(),
    finishedAt: text('finished_at'),
  },
  (t) => ({
    taskIdx: index('cluster_shards_task_idx').on(t.taskId),
    statusIdx: index('cluster_shards_status_idx').on(t.status),
  }),
);

export const clusterTasks = sqliteTable(
  'cluster_tasks',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    goalId: text('goal_id'),
    taskId: text('task_id'),
    shardId: text('shard_id'),
    assignedNodeId: text('assigned_node_id'),
    status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] })
      .notNull()
      .default('queued'),
    error: text('error'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    createdAt: createdAt(),
  },
  (t) => ({
    wsIdx: index('cluster_tasks_ws_idx').on(t.workspaceId, t.status),
    shardIdx: index('cluster_tasks_shard_idx').on(t.shardId),
  }),
);

export const clusterElections = sqliteTable(
  'cluster_elections',
  {
    id: id(),
    clusterId: text('cluster_id').notNull().default('local'),
    term: integer('term').notNull().default(1),
    leaderNodeId: text('leader_node_id').notNull(),
    /** 上任原因：initial | failover | manual */
    reason: text('reason').notNull().default('initial'),
    electedAt: text('elected_at').notNull(),
  },
  (t) => ({ clusterIdx: index('cluster_elections_cluster_idx').on(t.clusterId, t.term) }),
);

export const clusterHealth = sqliteTable(
  'cluster_health',
  {
    id: id(),
    nodeId: text('node_id')
      .notNull()
      .references(() => clusterNodes.id, { onDelete: 'cascade' }),
    cpu: real('cpu').notNull().default(0),
    memory: real('memory').notNull().default(0),
    gpu: real('gpu').notNull().default(0),
    disk: real('disk').notNull().default(0),
    network: real('network').notNull().default(0),
    recordedAt: text('recorded_at').notNull(),
  },
  (t) => ({ nodeIdx: index('cluster_health_node_idx').on(t.nodeId, t.recordedAt) }),
);

export const clusterPolicies = sqliteTable('cluster_policies', {
  id: id(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull().default('default'),
  maxNodes: integer('max_nodes').notNull().default(8),
  maxParallelTasks: integer('max_parallel_tasks').notNull().default(4),
  /** {cpu, memoryMb, gpu, diskGb, networkMbps}：单节点可用上限 */
  resourceLimits: json('resource_limits').$type<Record<string, number>>().notNull().default({}),
  /** 集群异常时是否允许回退单机 */
  fallbackEnabled: integer('fallback_enabled', { mode: 'boolean' }).notNull().default(true),
  /** 心跳超时（毫秒）：超过即判定离线 */
  heartbeatTimeoutMs: integer('heartbeat_timeout_ms').notNull().default(30_000),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ================================================================== */
/* Step 5：多 Agent 并行                                               */
/* ================================================================== */

export const agentPools = sqliteTable(
  'agent_pools',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    role: text('role').notNull(),
    minAgents: integer('min_agents').notNull().default(1),
    maxAgents: integer('max_agents').notNull().default(4),
    /** 当前活跃实例数（逻辑计数量，非进程数） */
    activeAgents: integer('active_agents').notNull().default(0),
    model: text('model'),
    tools: json('tools').$type<string[]>().notNull().default([]),
    status: text('status', { enum: ['active', 'paused', 'error'] }).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ wsIdx: uniqueIndex('agent_pools_ws_role_idx').on(t.workspaceId, t.role) }),
);

export const agentRoutes = sqliteTable(
  'agent_routes',
  {
    id: id(),
    taskId: text('task_id').notNull(),
    agentId: text('agent_id').notNull(),
    poolId: text('pool_id'),
    /** 路由原因（可读） */
    reason: text('reason').notNull().default(''),
    score: real('score').notNull().default(0),
    /** agent | model | tool */
    kind: text('kind').notNull().default('agent'),
    detail: json('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => ({ taskIdx: index('agent_routes_task_idx').on(t.taskId) }),
);

export const aggregatedResults = sqliteTable(
  'aggregated_results',
  {
    id: id(),
    taskId: text('task_id').notNull(),
    goalId: text('goal_id'),
    /** majority | priority | concat | manual */
    strategy: text('strategy').notNull().default('concat'),
    result: json('result').$type<Record<string, unknown>>().notNull().default({}),
    conflicts: json('conflicts')
      .$type<{ key: string; values: { agentId: string; value: string }[]; resolution: string; resolvedBy: string }[]>()
      .notNull()
      .default([]),
    /** 是否仍有未决冲突需要人工确认 */
    needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
    resolvedAt: text('resolved_at'),
    createdAt: createdAt(),
  },
  (t) => ({ taskIdx: index('aggregated_results_task_idx').on(t.taskId) }),
);

export const costRecords = sqliteTable(
  'cost_records',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    goalId: text('goal_id'),
    taskId: text('task_id'),
    agentId: text('agent_id'),
    model: text('model').notNull().default(''),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    cost: real('cost').notNull().default(0),
    /** 预算告警级别：none | warn | exceeded */
    budgetState: text('budget_state').notNull().default('none'),
    createdAt: createdAt(),
  },
  (t) => ({
    wsIdx: index('cost_records_ws_idx').on(t.workspaceId, t.createdAt),
    goalIdx: index('cost_records_goal_idx').on(t.goalId),
  }),
);

/* ================================================================== */
/* Step 6：企业安全与审计                                              */
/* ================================================================== */

export const roles = sqliteTable(
  'roles',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 权限点数组，如 ['plugin:install','paid_data:query'] */
    permissions: json('permissions').$type<string[]>().notNull().default([]),
    /** 内置角色不可删除 */
    builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ wsIdx: uniqueIndex('roles_ws_name_idx').on(t.workspaceId, t.name) }),
);

export const userRoles = sqliteTable(
  'user_roles',
  {
    id: id(),
    userId: text('user_id').notNull(),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => ({ wsIdx: uniqueIndex('user_roles_user_role_idx').on(t.workspaceId, t.userId, t.roleId) }),
);

/** SSO 配置（OIDC / SAML）：密钥类字段只存变量名 */
export const ssoConfigs = sqliteTable('sso_configs', {
  id: id(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  protocol: text('protocol', { enum: ['oidc', 'saml'] }).notNull().default('oidc'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  issuer: text('issuer').notNull().default(''),
  clientId: text('client_id').notNull().default(''),
  /** 只存环境变量名，绝不存 client secret 本身 */
  clientSecretRef: text('client_secret_ref').notNull().default(''),
  redirectUri: text('redirect_uri').notNull().default(''),
  /** 域 → 角色映射 */
  groupMapping: json('group_mapping').$type<Record<string, string>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const auditExports = sqliteTable(
  'audit_exports',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('audit'),
    rangeStart: text('range_start').notNull(),
    rangeEnd: text('range_end').notNull(),
    filePath: text('file_path').notNull().default(''),
    rowCount: integer('row_count').notNull().default(0),
    status: text('status', { enum: ['pending', 'succeeded', 'failed'] }).notNull().default('pending'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => ({ wsIdx: index('audit_exports_ws_idx').on(t.workspaceId, t.createdAt) }),
);

export const dataMaskRules = sqliteTable(
  'data_mask_rules',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    field: text('field').notNull(),
    /** full | partial | hash | nullify */
    strategy: text('strategy').notNull().default('partial'),
    /** 规则适用对象（可选，如表名或 API 路径） */
    target: text('target').notNull().default('*'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ wsIdx: uniqueIndex('data_mask_ws_field_target_idx').on(t.workspaceId, t.field, t.target) }),
);

export const retentionPolicies = sqliteTable(
  'retention_policies',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    dataType: text('data_type').notNull(),
    retentionDays: integer('retention_days').notNull().default(90),
    /** delete | anonymize | archive */
    action: text('action').notNull().default('delete'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastRunAt: text('last_run_at'),
    lastAffected: integer('last_affected').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ wsIdx: uniqueIndex('retention_ws_type_idx').on(t.workspaceId, t.dataType) }),
);
