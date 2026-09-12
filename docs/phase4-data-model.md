# Phase 4 数据模型

> 迁移文件：`packages/server/src/db/migrations/0004_phase4.sql` / `0004_phase4.down.sql`
> 全部为**新增表**，不改动任何 Phase 1/2/3 的列。回滚脚本只 DROP 本文件新增内容。

## 通用约定

- `id`：`TEXT PRIMARY KEY`，服务端用 `newId(前缀)` 生成（nanoid 16 位），前缀便于日志辨认
- 时间：`TEXT` ISO 8601（`nowIso()`），便于跨 SQLite/Postgres 与直接字符串比较
- JSON：`TEXT` + `{ mode: 'json' }`（Drizzle 自动序列化）
- 工作区隔离：所有业务表都带 `workspace_id REFERENCES workspaces(id) ON DELETE CASCADE`
- **列名避开 SQL 保留字**：`cluster_shards` 的分片序号列用 `index_`（`index` 是保留字，直接用会让 SQLite 报 `no such column: "index"`）

---

## Step 1：插件系统与 MCP

### `plugin_installations` — 安装态（含 manifest 快照与哈希）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | |
| `workspace_id` | TEXT FK→workspaces | CASCADE |
| `plugin_id` | TEXT FK→plugins | CASCADE，指向 Phase 1 的 `plugins` 表 |
| `version` | TEXT | 安装时的版本 |
| `status` | TEXT | `installed` / `enabled` / `disabled` / `error` |
| `manifest` | JSON | **安装时的 manifest 快照**（市场后续变更不影响已装版本） |
| `manifest_hash` | TEXT | `normalizeManifest()` 的 sha256，字段顺序无关；用于「内容是否被篡改」比对 |
| `installed_at` / `updated_at` | TEXT | |

唯一索引：`(workspace_id, plugin_id)` —— 同一插件在一个工作区只有一条安装记录。

> **为什么快照要存**：manifest 哈希必须能重算。如果只存哈希不存内容，升级时无法判断「是版本变了还是内容被改了」。

### `plugin_versions` — 版本时间线

`(id, plugin_id, version, manifest, hash, released_at)`。安装/更新时追加一行，用于「这个插件历史上装过哪些版本、hash 是什么」。

### `plugin_permissions` — 权限声明

`(id, plugin_id, scope, description, required)`，唯一索引 `(plugin_id, scope)`。

### `plugin_grants` — 逐项授权

| 字段 | 说明 |
| --- | --- |
| `installation_id` | FK→plugin_installations CASCADE |
| `permission_id` | FK→plugin_permissions CASCADE |
| `granted_at` / `granted_by` | |
| `expires_at` | NULL 表示长期有效；查询时与当前时间比较 |
| `revoked_at` | 非 NULL 表示已撤销（保留行，便于审计「曾经授过什么」） |

唯一索引：`(installation_id, permission_id)`。

> **权限提升保护**：安装时若 `manifest_hash` 与库中不一致，会 `UPDATE plugin_grants SET revoked_at=now`（撤销全部授权），
> 强制用户重新逐项确认。否则「插件更新后新增一条敏感权限」会被静默继承。

### `mcp_servers` / `mcp_tools`

`mcp_servers`：`(id, workspace_id, name, transport, endpoint, command, args, status, capabilities, secret_refs, last_error, ...)`
唯一索引 `(workspace_id, name)`。

- `transport`：`stdio` / `http` / `sse` / `websocket`
- `endpoint`：**注册时即拒绝内网/元数据地址**（`isPrivateHost`），避免运行期 SSRF
- `secret_refs`：只存**变量名**，值由环境变量/Keychain 提供

`mcp_tools`：`(id, server_id, name, description, schema, enabled, dangerous)`，唯一索引 `(server_id, name)`。
重新同步工具时**保留用户已设置的 `enabled` 开关**（否则用户关掉的危险工具会被同步打开）。

---

## Step 2：付费数据库

### `paid_data_credentials` — 加密凭据

| 字段 | 说明 |
| --- | --- |
| `provider_id` | 如 `tianyancha` |
| `encrypted_config` | `seal()` 的产物，格式 `v1:iv:tag:data`（AES-256-GCM，base64url） |
| `field_names` | **只列字段名**（不含值），供 UI 展示「已配置哪些字段」 |
| `status` | `unconfigured` / `configured` / `verified` / `error` |
| `last_verified_at` / `last_error` | |

唯一索引：`(workspace_id, provider_id)`。

> **合并更新**：`save()` 默认把新值与已有值合并（`{...prev, ...new}`），只填一个字段时不会清空其它字段。
> 否则用户「只想换 Token」，结果 `appSecret` 被清空 → 表现为「突然查不了了」。

### `paid_data_queries` — 查询记录（含合规判定）

| 字段 | 说明 |
| --- | --- |
| `provider_id` / `action` / `params` | 调了什么 |
| `status` | `pending` / `running` / `succeeded` / `failed` / **`blocked`** |
| `cached` / `degraded` | 是否命中缓存 / 是否降级 |
| `row_count` / `duration_ms` | |
| `error` | 执行失败原因 |
| `blocked_reason` | **合规守卫拒因**（如「请求绕过平台限流」） |

索引：`(workspace_id, created_at)`。

> **blocked 也要落库**：否则「谁在什么时候试图绕过限流」无法追溯 —— 这恰恰是审计最关心的记录。

### `paid_data_results` — 结果与引用

`(id, query_id, data, citations, cache_key, expires_at, created_at)`

- `citations`：`[{title, url, accessedAt, provider}]`，合规要求「结果可溯源」
- `cache_key`：`provider::action::归一化参数`（key 排序、剔除 `purpose`/`confirm`）
- 索引：`query_id`、`cache_key`

---

## Step 3：提示词工程

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `prompt_variables` | `template_id, name, type, required, default_value, options` | 唯一 `(template_id, name)`；`type` 支持 string/number/boolean/enum |
| `prompt_versions` | `template_id, version, content, created_by` | 每次保存追加一行；`created_by` 可为 `library` / `rollback:v2` |
| `prompt_ab_tests` | `template_id, version_a, version_b, status, started_at, finished_at` | `status`: draft/running/finished |
| `prompt_evaluations` | `ab_test_id, version, metric, value, sample_size, note` | 每个测试每个版本多行；人工 1~5、自动 0~5（服务端强校验） |

> **版本回滚不删历史**：`rollbackVersion` 把指定历史版本的 content 复制成**新版本**（v3 = v1 的内容），
> `prompt_versions` 保留全部 3 行。这样「回滚」本身也是可追溯的。

---

## Step 4：实验性集群

### `cluster_nodes`

| 字段 | 说明 |
| --- | --- |
| `cluster_id` | 默认 `local`，为多集群预留 |
| `name` | 唯一 `(cluster_id, name)` |
| `role` | `leader` / `worker` / `candidate` |
| `host` / `port` | |
| `status` | `online` / `offline` / `draining` / `error`；**注册后默认 offline**，心跳后才 online |
| `resources` | `{cpu, memoryMb, gpu, diskGb, networkMbps}` |
| `labels` | `{leaderPriority: '10', tier: 'pro'}` —— 选举与分发的依据 |
| `last_heartbeat` / `heartbeat_miss` | |

### `cluster_shards`

| 字段 | 说明 |
| --- | --- |
| `task_id` / `goal_id` | 业务标识 |
| `index_` | 分片序号（**列名带下划线**，`index` 是 SQL 保留字） |
| `total` | 分片总数 |
| `payload` | `{items, weight}` |
| `result` | 执行结果 |
| `status` | `pending` / `assigned` / `running` / `succeeded` / `failed` / `reassigned` |
| `assigned_node_id` | |
| `attempts` | 已尝试次数（超过 maxAttempts 直接 failed，不无限重试） |

### `cluster_tasks` / `cluster_elections` / `cluster_health` / `cluster_policies`

- `cluster_tasks`：分发后每个分片对应一行 `cluster_tasks` 记录（`queued/running/succeeded/failed/cancelled`）
- `cluster_elections`：`(cluster_id, term, leader_node_id, reason, elected_at)`，`reason` 为 `initial/failover/manual`
- `cluster_health`：`(node_id, cpu, memory, gpu, disk, network, recorded_at)`，心跳带指标时写入
- `cluster_policies`：`max_nodes` / `max_parallel_tasks` / `resource_limits` / `fallback_enabled` / `heartbeat_timeout_ms`

> **`fallback_enabled` 的语义**：为 `true` 时「集群不可用 → 自动回退单机并给出原因」；
> 为 `false` 时**明确拒绝调度**而不是偷偷降级 —— 用户需要知道任务没有按预期方式执行。

---

## Step 5：多 Agent 并行

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `agent_pools` | `role, min_agents, max_agents, active_agents, model, tools, status` | 唯一 `(workspace_id, role)`；一个角色只允许一个池，否则调度不确定 |
| `agent_routes` | `task_id, agent_id, pool_id, reason, score, kind, detail` | `kind` 为 agent/model/tool；`reason` 人类可读 |
| `aggregated_results` | `task_id, strategy, result, conflicts, needs_review, resolved_at` | 冲突数组显式存储，未决时 `needs_review=true` |
| `cost_records` | `workspace_id, goal_id, task_id, agent_id, model, tokens_in/out, cost, budget_state` | `budget_state`: none/warn/exceeded |

> **`agent_routes` 存在的意义**：多 Agent 系统最缺的是「为什么这个任务交给了那个 Agent」。
> 每次 Agent/模型/工具路由都写一行，UI 上可以直接展示决策链。

---

## Step 6：企业安全与审计

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `roles` | `name, permissions(JSON), builtin` | 唯一 `(workspace_id, name)`；`builtin` 角色不可删除 |
| `user_roles` | `user_id, role_id, workspace_id` | 唯一 `(workspace_id, user_id, role_id)`；多角色权限取并集 |
| `sso_configs` | `protocol, enabled, issuer, client_id, client_secret_ref, redirect_uri, group_mapping` | **只存密钥的变量名**，绝不存 secret |
| `audit_exports` | `type, range_start, range_end, file_path, row_count, status` | 导出行为本身也要留痕 |
| `data_mask_rules` | `field, strategy, target, enabled` | 唯一 `(workspace_id, field, target)`；`strategy`: full/partial/hash/nullify |
| `retention_policies` | `data_type, retention_days, action, enabled, last_run_at, last_affected` | 唯一 `(workspace_id, data_type)`；`action`: delete/anonymize/archive |

> **`retention_policies` 的类型白名单**：只允许 `audit_logs` / `schedule_runs` / `plugin_call_logs` /
> `research_reports` / `office_documents` / `cost_records` / `deployment_logs` / `conversations`。
> `users` / `workspaces` / `goals` / `tasks` / `agents` 被显式禁止（防删库）。

---

## 表清单（29 张）

```
Step 1  plugin_installations  plugin_versions  plugin_permissions  plugin_grants
        mcp_servers  mcp_tools
Step 2  paid_data_credentials  paid_data_queries  paid_data_results
Step 3  prompt_variables  prompt_versions  prompt_ab_tests  prompt_evaluations
Step 4  cluster_nodes  cluster_shards  cluster_tasks  cluster_elections
        cluster_health  cluster_policies
Step 5  agent_pools  agent_routes  aggregated_results  cost_records
Step 6  roles  user_roles  sso_configs  audit_exports  data_mask_rules  retention_policies
```

## 回滚

```bash
pnpm --filter @ai/server db:rollback              # 回滚最后一个迁移（默认 0004）
pnpm --filter @ai/server verify:rollback          # 验证 Phase 2/3 回滚
pnpm --filter @ai/server verify:phase4            # 验证 Phase 4 全部硬约束（含 0004 回滚）
```

回滚 0004 只删除上述 29 张表；Phase 1/2/3 的表由验证脚本逐张断言「未被误伤」。
