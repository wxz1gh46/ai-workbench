# Phase 4 回滚方案

> 原则：**每个 Step 可独立回滚**，且回滚不误伤其它阶段。
> 回滚前请先跑 `pnpm --filter @ai/server verify:phase4` 确认当前状态。

## 1. 回滚级别总览

| 级别 | 范围 | 手段 | 数据影响 | 恢复方式 |
| --- | --- | --- | --- | --- |
| L1 | 单个功能 | 功能开关置 0 | **数据全保留** | 开关置 1 重启 |
| L2 | 单个 Step | 停用对应表/服务调用 | 数据保留 | 重新启用 |
| L3 | 整个 Phase 4 | `db:rollback` 回滚 0004 | **删除 29 张 Phase 4 表** | 重新迁移（数据不恢复） |
| L4 | 代码 | `git revert <commit>` | 无 | 重新 cherry-pick |
| L5 | 整库 | 恢复 `data/` 快照 | 回到快照点 | — |

**优先用 L1**。功能开关的存在就是为了让「回滚」不需要动数据库。

## 2. L1：功能开关（推荐）

```bash
# 关闭整个 Phase 4（全部接口返回「未启用」，数据全保留）
PHASE4_CLUSTER=0
PHASE4_PAID_PLUGINS=0
PHASE4_PROMPT=0
PHASE4_ENTERPRISE=0
```

关闭后的行为：

| 接口 | 关闭后的响应 |
| --- | --- |
| `POST /plugins/install` | 400 `插件系统 已被功能开关关闭（config.features.phase4PaidPlugins = false）；历史数据仍保留，重新打开即可恢复` |
| `POST /paid-data/query` | 400 同上（label 为「付费数据查询」） |
| `POST /prompts/generate` / `POST /prompts/v4` | 400（「提示词工程」） |
| `POST /cluster/nodes` | 400（「实验性集群」） |
| `POST /rbac/roles` | 400（「企业安全」） |
| **查询类接口** | **保持可用**（`GET /plugins/installed`、`GET /paid-data/queries`、`GET /cluster/status` 等） |

**为什么查询类不关**：用户需要能查看历史数据。关闭写入而不关闭读取，是「可回滚」与「可用性」的平衡点。

`GET /health` 的 `features` 字段会反映当前开关状态。

## 3. L2：按 Step 停用

### Step 1 插件系统

```bash
PHASE4_PAID_PLUGINS=0     # 关闭插件安装与调用（插件调用与付费数据共用此开关）
```
已安装插件的授权与调用日志保留在 `plugin_installations` / `plugin_grants` / `plugin_call_logs`。
重新打开后**授权状态原样恢复**（无需重新授权）。

### Step 2 付费数据

```bash
PHASE4_PAID_PLUGINS=0
```
凭据密文保留在 `paid_data_credentials`。注意：**凭据解密依赖 `WORKBENCH_SECRET_KEY`**，
如果这个 Key 变了，重新打开后需要重新填写凭据（这是特性，不是缺陷 —— 避免用错密钥解出错数据）。

### Step 3 提示词

```bash
PHASE4_PROMPT=0
```
模板、版本、A/B 测试数据全部保留。注意 `prompt_templates` 是 Phase 1/2/3/4 **共用**的表，
不要在生产环境手工删这张表的行。

### Step 4 集群

```bash
PHASE4_CLUSTER=0
```
或者更精细地：保持开关打开但设 `fallbackEnabled: false`（把「静默降级」变成「明确拒绝」）：

```bash
curl -X PATCH 'http://127.0.0.1:8787/cluster/policy?workspaceId=<ws>&confirm=true' \
  -d '{"workspaceId":"<ws>","fallbackEnabled":false}'
```

节点、分片、选举历史全部保留。

### Step 5 多 Agent 并行

Agent 池、路由记录、聚合结果、成本记录**没有独立开关**（它们是查询与记账，不产生外部副作用）。
要停用：把所有池 `activeAgents` 设为 0（此时编排的 `parallelism.limit` 会变成 0，任务不会被调度）：

```bash
curl -X POST 'http://127.0.0.1:8787/agents/pool/scale?role=coder&confirm=true' \
  -d '{"workspaceId":"<ws>","target":0}'
```
（若 `minAgents > 0`，先 `PATCH /agents/pool/:id` 把 `minAgents` 调成 0。）

### Step 6 企业安全

```bash
PHASE4_ENTERPRISE=0    # 关闭 RBAC 角色创建与 SSO 配置写入
```

**注意**：关闭前请确认没有把用户锁死的状态。若担心，先把 owner 角色恢复为全权限：

```sql
-- 备份后手工执行
UPDATE roles SET permissions = '<全部权限 JSON>' WHERE name = 'owner';
```

若要完全停用 RBAC 校验（回到「未分配角色即按 owner」），删掉全部分配即可：

```bash
curl -X POST http://127.0.0.1:8787/rbac/unassign -d '{"workspaceId":"<ws>","userId":"<u>","role":"viewer"}'
```

## 4. L3：数据库回滚

```bash
# 回滚最后一个迁移（0004_phase4.sql）
pnpm --filter @ai/server db:rollback

# 或显式指定
pnpm --filter @ai/server db:rollback -- 0004_phase4.sql
```

`0004_phase4.down.sql` 会 DROP 这 29 张表：

```
plugin_installations  plugin_versions  plugin_permissions  plugin_grants
mcp_servers  mcp_tools
paid_data_credentials  paid_data_queries  paid_data_results
prompt_variables  prompt_versions  prompt_ab_tests  prompt_evaluations
cluster_nodes  cluster_shards  cluster_tasks  cluster_elections  cluster_health  cluster_policies
agent_pools  agent_routes  aggregated_results  cost_records
roles  user_roles  sso_configs  audit_exports  data_mask_rules  retention_policies
```

**不会动**：Phase 1/2/3 的全部表（`verify:phase4` 会逐张断言）。

⚠️ **执行前必做**：

```bash
# 1) 备份数据库与密文（凭据在 data/ 下的密钥文件里，丢了就无法解密）
cp -a data/ data.backup-$(date +%F)

# 2) 确认影响范围
pnpm --filter @ai/server verify:phase4    # 会列出全部 Phase 4 表
```

⚠️ **回滚后重新迁移**要注意：

- `0001/0002/0003` 的 `ALTER TABLE ADD COLUMN` 是幂等的（`makeIdempotent` 会先查 `PRAGMA table_info`）
- 但**数据不会回来**：回滚只删结构，重新迁移得到的是空表
- `_migrations` 表也记录了 0004；重新迁移会重新执行

## 5. L4：代码回滚

```bash
git revert <merge-commit-of-phase4>   # 生成一个反向提交（保留历史，推荐）
# 或
git reset --hard <phase3-commit>      # 丢弃历史（不推荐，除非分支未共享）
```

回滚代码后**必须**同时处理数据库：Phase 4 代码不会读旧结构，但旧代码也不认识新表。
两种选择：

1. 保留 0004 表（旧代码忽略它们，无害）
2. 执行 L3 回滚 0004

**推荐 1**（先回滚代码，观察一段时间再决定是否删表）——避免「回滚出错想再回去，数据已经没了」。

## 6. 各 Step 的独立回滚矩阵

| Step | 独立回滚手段 | 数据保留 | 备注 |
| --- | --- | --- | --- |
| 1 插件系统 | `PHASE4_PAID_PLUGINS=0` | ✅ | 授权与日志保留，重开即恢复 |
| 1 MCP | `DELETE /mcp/servers/:id` | ❌（该服务器） | 逐个删，不影响其它 |
| 2 付费数据 | `PHASE4_PAID_PLUGINS=0` | ✅ | 凭据密文保留 |
| 2 单个数据源 | `DELETE /paid-data/credentials/:providerId` | ❌（该源凭据） | 查询历史保留 |
| 3 提示词 | `PHASE4_PROMPT=0` | ✅ | 共用 `prompt_templates`，**不要手工删表** |
| 3 单条提示词 | `POST /prompts/v4/:name/rollback` | ✅ | 回滚内容而非删除 |
| 4 集群 | `PHASE4_CLUSTER=0` 或 `fallbackEnabled=false` | ✅ | 节点/分片历史保留 |
| 4 单节点 | `DELETE /cluster/nodes/:id` | ❌（该节点） | 在线 leader 需先换主 |
| 5 Agent 池 | `POST /agents/pool/scale` 到 0 | ✅ | 编排自动限流为 0 |
| 6 RBAC | 撤销全部分配（`/rbac/unassign`） | ✅ | 回到「未分配即 owner」 |
| 6 SSO | `DELETE /sso/config?confirm=true` | ❌（配置） | 用户数据不受影响 |
| 6 保留策略 | `DELETE /compliance/retention/:dataType` | ✅ | 删除策略本身 |
| 6 脱敏规则 | `DELETE /compliance/mask-rules/:id` | ✅ | 回落到内置兜底策略 |

## 7. 验证清单

回滚后逐项核验：

```bash
# 1) 类型与测试
pnpm typecheck && pnpm test

# 2) Phase 4 硬约束（含 0004 回滚 + 跨阶段误伤检查）
pnpm --filter @ai/server verify:phase4

# 3) Phase 2/3 回滚未受影响
pnpm --filter @ai/server verify:rollback

# 4) 服务能起来
pnpm dev:server
curl http://127.0.0.1:8787/health    # features 字段反映开关状态

# 5) 抽查关键接口
curl 'http://127.0.0.1:8787/plugins/installed?workspaceId=<ws>'
curl 'http://127.0.0.1:8787/cluster/status?workspaceId=<ws>'
```

## 8. 常见回滚问题

**Q：回滚代码后启动报 `no such table: plugin_installations`**
A：说明你回滚了代码但保留了对 Phase 4 表的调用。要么恢复代码，要么执行 `db:rollback` 后再启动旧代码。
（实际上 Phase 4 代码只在对应路由里查这些表，旧代码不会查。）

**Q：回滚后再迁移，Phase 4 表建好了但数据是空的**
A：符合预期。回滚只删结构不备份数据。若要保数据，回滚前先 `cp -a data/ data.backup-<date>`。

**Q：功能开关关掉了，为什么 `GET /cluster/status` 还能用？**
A：设计如此。查询类接口不关，是为了让用户能查看历史数据。只有产生外部影响/写入的入口才受开关控制。

**Q：`PHASE4_ENTERPRISE=0` 后 RBAC 校验还生效吗？**
A：开关只挡「创建角色 / 配置 SSO」这类写入。**已分配的权限校验仍然生效** ——
否则「关个开关就绕过权限」将是严重的权限提升漏洞。

**Q：能不能只回滚 0004 里的某几张表？**
A：不建议手工 DROP。用功能开关（L1）控制行为，比手工切表结构安全得多。
确实需要时，请在备份后直接执行 SQL，并注意外键依赖顺序（`plugin_grants` 依赖 `plugin_installations` 等）。
