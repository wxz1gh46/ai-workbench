# Phase 4 接口文档

统一约定（与 Phase 1/2/3 一致）：

- 成功：`{ ok: true, data: T, traceId: string }`
- 失败：`{ ok: false, error: { code, message, details?, traceId } }`
- 危险操作需 `?confirm=true`（或 body 中 `confirm: true`）；缺失返回 **428** `CONFIRM_REQUIRED`
- 工作区参数：查询类接口用 `?workspaceId=...`，写类接口用 body
- 所有外部服务调用都写 `audit_logs`

## 错误码

| 码 | HTTP | 含义 |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | 参数缺失/非法（message 里带字段名） |
| `FORBIDDEN` | 403 | 权限不足 / 合规拒绝（如插件声明违规、endpoint 指向内网） |
| `NOT_FOUND` | 404 | 资源不存在 |
| `CONFLICT` | 409 | 状态冲突（如删除被引用的角色、缩容驱逐运行中 Agent） |
| `CONFIRM_REQUIRED` | 428 | 危险操作缺二次确认（details 里有 summary/level） |
| `RATE_LIMITED` | 429 | 本地限流（details 里有 `retryAfterMs`） |
| `PROVIDER_ERROR` | 502 | 外部平台返回错误 |
| `INTERNAL` | 500 | 服务端异常 |

---

## Step 1：插件系统与 MCP

### `GET /plugins/market`

查询参数：`q`（关键字，匹配名称/描述/工具）、`kind`（mcp/http/websocket/local）、`requiresAuth`（true/false）

```json
{ "catalog": [ { "name": "mcp-filesystem", "version": "1.0.0", "author": "ai-workbench",
  "description": "...", "kind": "mcp", "source": "market://mcp/filesystem",
  "permissions": [{ "scope": "fs:read", "description": "...", "sensitive": false, "required": true }],
  "tools": [{ "name": "read_file", "description": "...", "requires": ["fs:read"] }],
  "resources": [{ "uri": "workspace://", "description": "..." }],
  "prompts": [{ "name": "summarize-file", "description": "..." }],
  "requiresUserAuth": false, "secretRefs": [], "sandbox": true } ],
  "kinds": ["mcp", "http", "websocket", "local"] }
```

### `GET /plugins/market/:name`

返回 `{ manifest, signature: { signed, ok, hash }, marketSize }`。
`signature.signed=false` 表示市场清单未附签名（UI 上要标注）；`ok=false` 表示哈希不匹配（**不可安装**）。

### `POST /plugins/install?name=<name>&confirm=true`

Body：`{ workspaceId }`。**危险操作**。
返回安装结果（含 `installationId`、`permissions`、`grantedScopes`（新装为空）、`secretRefs`、`signed`、`manifestHash`）。

合规校验不通过在 **403 FORBIDDEN**，message 会说明原因（如「声明绕过反爬」）。

### `GET /plugins/installed?workspaceId=`

返回：`{ plugins: [{ installationId, pluginId, name, version, status, permissions[{...,granted}], grantedScopes, latestVersion, updateAvailable, requiresUserAuth, secretRefs, source, kind }] }`

### `POST /plugins/:id/uninstall?confirm=true`

Body：`{ workspaceId }`。**危险操作**。级联删除安装记录、授权、版本、权限。

### `POST /plugins/:id/update`

Body：`{ workspaceId }`。重新走安装流程；若 manifest 内容变更会**撤销全部旧授权**，返回里 `grantedScopes` 为空。

### `GET /plugins/:id/permissions?workspaceId=`

返回 `{ installationId, permissions, grantedScopes, requiresUserAuth, secretRefs }`。
`:id` 可传 `pluginId` 或 `installationId`。

### `POST /plugins/:id/grant`

Body：`{ workspaceId, scopes: string[], expiresAt?: string|null }`
返回 `{ granted, grantedScopes }`。授权未声明的 scope → **400**（防止「随便传个 scope 就拿到权限」）。

### `POST /plugins/:id/revoke?confirm=true`

Body：`{ workspaceId, scopes?: string[] }`（不传则全撤）。**危险操作**。

### `POST /plugins/:id/invoke`

Body：`{ workspaceId, tool, args?, confirm? }`。**危险操作**（`gate('paid_data.query'|'plugin.invoke')` 语义）。

返回：

```json
{ "ok": false, "tool": "read_file", "content": null, "durationMs": 2, "degraded": false,
  "denied": { "reason": "权限未授权", "missingScopes": ["fs:read"] } }
```

- 权限不足 → `ok=false` + `denied`（**HTTP 200**，便于 UI 引导授权，而不是报错）
- 危险工具未确认 → **428**
- 工具未在清单中声明 → **403** + 写调用日志

### `GET /plugins/:id/calls?workspaceId=&limit=`

返回 `{ calls: [{ id, tool, args, ok, durationMs, error, createdAt }] }`。`args` 已在写入时脱敏。

### `GET /mcp/servers?workspaceId=`
### `POST /mcp/servers?confirm=true`

Body：`{ workspaceId, name, transport?, endpoint?, command?, args?, secretRefs? }`。
`endpoint` 指向内网/元数据地址 → **403**。

### `DELETE /mcp/servers/:id?workspaceId=&confirm=true`
### `POST /mcp/servers/:id/sync?workspaceId=`

探测并同步工具清单。stdio 未注入宿主时返回 `{ synced: 0, degraded: true, note: "..." }`（**不伪造工具列表**）。

### `GET /mcp/servers/:id/tools?workspaceId=`

---

## Step 2：付费数据库

### `GET /paid-data/providers?workspaceId=`

返回 8 家数据源声明：`{ providers: [{ id, name, type, region, status, docsUrl, requiresUserAuth, credentialFields, actions, accessMethods, rateLimit }], disclaimer }`。

### `POST /paid-data/credentials?providerId=&confirm=true`

Body：`{ workspaceId, credentials: {k: v}, replace? }`。**危险操作**。
返回 `{ providerId, status, fieldNames, requiredMissing, masked }` —— **`masked` 是掩码后的值，绝不返回明文**。
未知字段 → **400**（避免「写了不生效的字段」）。

### `GET /paid-data/credentials?workspaceId=`

返回 `{ credentials, requiredFields }`（`requiredFields` 是 `{providerId: [必填字段名]}`）。

### `DELETE /paid-data/credentials/:providerId?workspaceId=&confirm=true`

### `POST /paid-data/preflight`

Body：`{ workspaceId, providerId, action, params? }`
返回 `{ allowed, reason?, code?, accessMethods, rateLimit }` —— UI 在提交前就能告诉用户「会不会被拒」。

### `POST /paid-data/query?confirm=true`

Body：`{ workspaceId, providerId, action, params?, noCache?, purpose? }`。**危险操作**。

返回：

```json
{ "queryId": "pdq_...", "status": "succeeded", "data": {...},
  "citations": [{ "title": "...", "url": "...", "accessedAt": "...", "provider": "..." }],
  "cached": false, "degraded": false, "note": "缺少 appKey，已按未配置处理...",
  "rowCount": 1, "durationMs": 12 }
```

- 合规拒绝 → `status: "blocked"` + `blockedReason`（HTTP 200，并落库一条 blocked 记录）
- 限流 → **429** + `details.retryAfterMs`
- 未配置凭据 / 接口不可达 → `degraded: true` + 可读 `note`

### `GET /paid-data/queries?workspaceId=&limit=`
### `GET /paid-data/queries/:id?workspaceId=`

---

## Step 3：提示词工程

### `GET /prompts/library`

返回 9 个预置模板（含 `sections`、`variables`、`filledSections`）。

### `POST /prompts/library/:key`

Body：`{ workspaceId, name? }`。把预置模板创建到工作区（同名则新增版本）。

### `GET /prompts/catalog`

返回评估指标元数据 `{ metrics: { manual, auto } }`。

### `GET /prompts/v4?workspaceId=`

返回 `{ templates: [{ name, latestId, version, versions, sections, variables, tags, updatedAt, score }] }`（每个 name 只展示最新）。

### `GET /prompts/v4/:name?workspaceId=&version=`

返回 `{ name, version, templateId, sections, variables, history[{version, score}], score, renders }`。

### `POST /prompts/generate`

Body：`{ workspaceId, goal, context?, targetModel?, useModel? }`
返回 `{ sections, rendered, variables, intent, notes, degraded }`。
`degraded=true` 表示未用模型（规则生成），`notes` 里会说明。

### `POST /prompts/optimize-v4`

Body：`{ workspaceId, current, intent?, targetModel?, useModel? }`
返回 `{ sections, rendered, variables, notes, issues[{severity,section,detail,suggestion}], score, degraded }`。

### `POST /prompts/copy`

Body：`{ sections, variables?, name? }`
返回 `{ markdown, rendered, missingRequired, unknownVariables, ok }` —— 服务端渲染，前端直接写剪贴板。

### `POST /prompts/v4`

Body：`{ workspaceId, name, sections, tags?, variables? }` → 保存为**新版本**。

### `POST /prompts/v4/:name/rollback?confirm=true`

Body：`{ workspaceId, version }`。**危险操作**。生成新版本（不删历史）。

### A/B 测试

| 接口 | 说明 |
| --- | --- |
| `POST /prompts/v4/:name/abtest` | Body `{ workspaceId, templateName, versionA, versionB, name? }`；同版本 → 400 |
| `GET /prompts/abtests?workspaceId=` | 列表 |
| `POST /prompts/abtests/:id/evaluate` | Body `{ workspaceId, version: 'A'\|'B', metric, value, sampleSize, note? }`；人工 1~5、自动 0~5，越界 → 400 |
| `POST /prompts/abtests/:id/auto-evaluate?workspaceId=` | 跑结构/长度/变量覆盖三项自动指标 |
| `GET /prompts/abtests/:id?workspaceId=` | 报告：`{ test, evaluations, summary, winner, reason }` |
| `POST /prompts/abtests/:id/finish?workspaceId=` | 结束测试（结束后不能再评分 → 409） |

> `winner` 在「样本不足」或「差异不显著」时为 `null`，`reason` 会写明原因。

---

## Step 4：实验性集群

| 接口 | 说明 |
| --- | --- |
| `GET /cluster/status?workspaceId=&mode=` | 完整快照（`degraded`/`degradeReason`/`leader`/`term`/`nodes`/`taskStats`/`shardStats`） |
| `GET /cluster/nodes?workspaceId=` | 节点列表（含最新 metrics）+ policy |
| `POST /cluster/nodes` | Body `{ workspaceId, name, role?, host?, port?, resources?, labels? }`；超 maxNodes → 409 |
| `DELETE /cluster/nodes/:id?workspaceId=&confirm=true` | 删除在线 leader → 409 |
| `POST /cluster/nodes/:id/heartbeat` | Body `{ cpu?, memory?, gpu?, disk?, network? }` → 节点转 online |
| `POST /cluster/sweep?workspaceId=` | 手动触发心跳扫描（超时节点转 offline） |
| `GET /cluster/health` | 健康摘要（看板用） |
| `GET /cluster/elections?workspaceId=` | 选举历史 + 当前 term |
| `POST /cluster/elections?workspaceId=&confirm=true` | 强制重新选举 |
| `GET /cluster/tasks?workspaceId=&limit=` | 集群任务列表 |
| `POST /cluster/tasks/distribute` | Body `{ workspaceId, taskId, items, shardCount?, goalId?, labels?, need? }` |
| `POST /cluster/shards/:id/complete` | Body `{ ok, result?, error? }` |
| `POST /cluster/tasks/:id/cancel?workspaceId=` | 取消并释放节点负载 |
| `GET /cluster/policy?workspaceId=` | 集群策略 |
| `PATCH /cluster/policy?workspaceId=&confirm=true` | 更新策略（`maxNodes`/`maxParallelTasks`/`fallbackEnabled`/`heartbeatTimeoutMs`/`resourceLimits`） |
| `POST /cluster/bootstrap` | Body `{ workspaceId }`；注册本机节点 → 心跳 → 选举（幂等） |

---

## Step 5：多 Agent 并行

| 接口 | 说明 |
| --- | --- |
| `GET /agents/pool?workspaceId=` | 池列表（含 `busy`/`headroom`） |
| `POST /agents/pool` | Body `{ workspaceId, name, role, minAgents?, maxAgents?, model?, tools? }`；同角色重复 → 409 |
| `POST /agents/pool/scale?role=&confirm=true` | Body `{ workspaceId, target }`；缩容会拒绝「驱逐运行中 Agent」 |
| `PATCH /agents/pool/:id` | 更新池配置 |
| `GET /agents/routes?taskId=` / `?limit=` | 路由记录（agent/model/tool，含 reason+score） |
| `GET /agents/models` | 模型价格表 |
| `POST /agents/orchestrate` | 编排：Body `{ workspaceId, nodes, taskTexts?, taskKinds?, networkAllowed?, maxParallel?, aggregationStrategy?, dryRun? }` |
| `GET /aggregated/results?taskId=` | 聚合结果 |
| `POST /aggregated/:id/resolve?confirm=true` | 人工裁决未决冲突：Body `{ workspaceId, decisions: [{key, agentId?, value?}] }` |
| `GET /costs?workspaceId=&goalId=` | 成本汇总（总/按模型/按 Agent/预算状态） |
| `POST /costs` | 记录一次调用成本 |

`orchestrate` 返回：

```json
{ "parallelism": { "limit": 2, "reason": "受 Agent 池容量限制（可通过扩容池提升）",
    "factors": [{ "name": "工作区配置上限", "value": 4 }, { "name": "Agent 池剩余容量", "value": 2 }] },
  "batches": [["t1","t2"],["t3"]],
  "dispatched": [{ "taskId": "t1", "role": "coder", "model": "gpt-4o-mini",
    "tools": ["fs.read"], "routeReason": "擅长 code；预估成本 $0.0001", "agentReason": "指定角色" }],
  "waiting": [{ "taskId": "t3", "reason": "受并行上限 2 限制，等待下一轮" }],
  "completed": ["t1","t2"], "failed": [], "aggregated": [...],
  "cost": { "total": 0.0002, "state": "none", "ratio": 0.0002 },
  "speedup": { "sequentialMs": 38400, "parallelMs": 19600, "speedup": 1.96, "batches": 2 },
  "notes": ["任务 t1 已完成规划（未注入执行器，不实际执行）"] }
```

---

## Step 6：企业安全与审计

### RBAC

| 接口 | 说明 |
| --- | --- |
| `GET /rbac/permissions` | 权限目录（`key` + 中文 `label`） |
| `GET /rbac/roles?workspaceId=` | 角色列表（首次调用自动初始化 6 个内置角色） |
| `POST /rbac/roles` | Body `{ workspaceId, name, permissions }`；未知权限点 → 400；与内置角色同名 → 409 |
| `PATCH /rbac/roles/:name` | Body `{ workspaceId, permissions }`；owner 不可改 → 403 |
| `DELETE /rbac/roles/:name?workspaceId=&confirm=true` | 内置角色 → 403；仍被使用 → 409 |
| `POST /rbac/assign?confirm=true` | Body `{ workspaceId, userId, role }`；**危险操作**（立即提权） |
| `POST /rbac/unassign` | Body `{ workspaceId, userId, role }` |
| `GET /rbac/users?workspaceId=` | 用户 → 角色/权限并集 |
| `GET /rbac/check?workspaceId=&userId=&permission=` | 单点权限校验 |

### SSO

| 接口 | 说明 |
| --- | --- |
| `GET /sso/config?workspaceId=` | 返回配置（`clientSecretRef` 是变量名，`hasSecret` 表示环境变量是否已设置） |
| `POST /sso/config` | Body `{ workspaceId, protocol?, issuer, clientId, clientSecretRef, redirectUri, groupMapping? }` |
| `POST /sso/enable?confirm=true` | Body `{ workspaceId, enabled }`；密钥环境变量未设置时**拒绝启用** |
| `DELETE /sso/config?workspaceId=&confirm=true` | |
| `GET /sso/auth-url?workspaceId=` | 生成带 `state`+`nonce` 的授权链接（SAML 走 IdP 发起，此接口会拒绝） |

`clientSecretRef` 必须是全大写字母数字下划线（环境变量名）；传「像密钥的串」→ 400。

### 审计

| 接口 | 说明 |
| --- | --- |
| `GET /audit/logs?workspaceId=&from=&to=&action=&actor=&dangerousOnly=&limit=` | 查询（返回 `logs` + `stats`） |
| `POST /audit/export?confirm=true` | Body `{ workspaceId, from, to, actor? }`；生成脱敏 NDJSON |
| `GET /audit/exports?workspaceId=` | 导出记录列表 |
| `GET /audit/exports/:id/download?workspaceId=` | 下载（路径越界 → 403） |

### 脱敏与保留

| 接口 | 说明 |
| --- | --- |
| `GET /compliance/mask-rules?workspaceId=` | 自定义规则 + 内置兜底策略 |
| `POST /compliance/mask-rules` | Body `{ workspaceId, field, strategy, target?, enabled? }` |
| `DELETE /compliance/mask-rules/:id?workspaceId=` | |
| `GET /compliance/mask-preview?workspaceId=&limit=` | 预览脱敏效果（让用户先看到导出后的样子） |
| `GET /compliance/retention?workspaceId=` | 保留策略 + 允许的 dataTypes |
| `POST /compliance/retention` | Body `{ workspaceId, dataType, retentionDays, action?, enabled? }` |
| `DELETE /compliance/retention/:dataType?workspaceId=` | |
| `POST /compliance/retention/apply` | Body `{ workspaceId, dataType?, dryRun? }`；`dryRun` 默认 true，`dryRun:false` 需 `?confirm=true` |
| `POST /compliance/package` | Body `{ workspaceId, from, to }`；生成合规包（审计 + 规则 + 策略） |

---

## WebSocket 事件（Phase 4 增量）

在既有的 `WS /events` 上追加：

| 事件 | payload |
| --- | --- |
| `plugin.installed` | `{ name, version }` |
| `plugin.uninstalled` | `{ removed, name }` |
| `plugin.granted` / `plugin.revoked` | `{ granted / revoked, grantedScopes }` |
| `plugin.called` | `{ tool, ok }` |
| `mcp.server-updated` | `{ id, name }` |
| `paid-data.query` / `paid-data.blocked` | `{ providerId, action, status }` |
| `prompt.generated` | `{ intent, degraded }` |
| `prompt.optimized` | `{ score, degraded }` |
| `prompt.version-saved` | `{ name, version }` |
| `prompt.abtest-updated` | `{ id, versionA, versionB }` |
| `cluster.node-registered` | `{ nodeId, name }` |
| `cluster.node-heartbeat` | `{ nodeId, status, at }` |
| `cluster.node-offline` | `{ nodeId, name, missed }` |
| `cluster.leader` | `{ term, leaderNodeId, name, reason }` |
| `cluster.shard-updated` | `{ taskId, assignments }` |
| `agent.pool-updated` | `{ pool, changed, reason }` |
| `agent.routed` | 路由记录 |
| `agent.result-aggregated` | 聚合结果 |
| `cost.recorded` / `cost.budget-warning` | `{ id, cost, total, state, ratio }` |
| `rbac.role-updated` | `{ name }` |
| `sso.config-updated` | `{ protocol }` |
| `audit.exported` | `{ exportId, rowCount }` |
| `compliance.retention-applied` | `{ results }` |
