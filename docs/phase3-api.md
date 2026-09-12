# Phase 3 接口文档

所有接口统一前缀 `/api`，统一响应包裹：

```jsonc
// 成功
{ "ok": true, "data": { /* ... */ }, "traceId": "trace_xxx" }
// 失败
{ "ok": false, "error": { "code": "CONFIRM_REQUIRED", "message": "…", "details": {}, "traceId": "trace_xxx" } }
```

错误码新增：`CONFIRM_REQUIRED`（HTTP 428，危险操作缺二次确认）。

## 通用约定

| 约定 | 说明 |
| --- | --- |
| **危险操作** | 必须 `confirm: true`（body）或 `?confirm=true`（DELETE），否则 428 + `{action, summary, level}` |
| **工作区** | 列表/创建接口必须带 `workspaceId` |
| **凭据** | 请求可传明文（HTTPS/本机回环），响应**永不**返回明文 |
| **降级** | 未配置外部能力返回可读错误 + `degraded` 语义，不静默成功 |
| **审计** | 所有外部调用与非只读操作都落审计；`detail` 自动脱敏 |
| **事件** | 状态变化推 WS `/events`，见文末事件表 |

---

## 1. 部署中心

### 能力探测

```
GET /api/deploy/capabilities
→ { providers: ProviderCapability[], danger: [{action, summary, level}] }

ProviderCapability = {
  provider, label,
  supportsEnvVars, supportsCustomDomain, supportsRollback, supportsPasswordProtection,
  tokenEnvKeys: string[],   // 需要用户手动配置的环境变量
  docsUrl, requiresToken
}
```

```
GET /api/deploy/providers/test
→ { results: [{ provider, configured, message }] }
```

### 网站项目

```
POST   /api/websites                       { workspaceId, name, description?, requirement?, databaseConnectionId? }
GET    /api/websites?workspaceId=…
GET    /api/websites/:id                   → { project, deployments, access, envVars, files, previewCommand }
PATCH  /api/websites/:id                   { name?, description? }
```

### 生成与构建

```
POST /api/websites/:id/generate            { requirement? }
→ { project, plan, files: [{path,bytes}], previewCommand, rootDir }

plan = {
  summary, siteType: 'static'|'fullstack'|'fullstack-db', framework, needsDatabase, degraded,
  pages:     [{ path, title, sections[], requiresAuth }],
  entities:  [{ name, columns: [{name,type,nullable,primary}], relations? }],
  apis:      [{ method, path, description, entity?, requiresDb }],
  styling:   { tone, palette[], darkMode },
  accessControl: { type, note }
}

POST /api/websites/:id/build
→ { ok, version, checks: [{name, ok, detail}], files, bytes }
   checks = 入口文件 / 文件数量 / 产物体积 / 密钥扫描
```

### 部署 / 回滚 / 删除

```
POST   /api/websites/:id/deploy            { provider, confirm: true }   ← 危险操作
→ 202 { deployment, degraded, accessPolicy }
   未配凭据 → 502，message 含所需环境变量与获取地址

GET    /api/websites/:id/deployments
GET    /api/deployments/:id/logs           → { lines: [{at,level,msg}], live: boolean }
POST   /api/websites/:id/rollback          { deploymentId, confirm: true }
DELETE /api/websites/:id/deployments/:deploymentId?confirm=true
DELETE /api/websites/:id?confirm=true      → { ok, deployments }
```

### 域名 / 访问控制 / 环境变量

```
POST   /api/websites/:id/domain            { domain, provider?, confirm: true }
→ { binding: { domain, status, message, dns: [{type,name,value}], https } }

GET    /api/websites/:id/access
POST   /api/websites/:id/access            { rules: [{type,value}], confirm: true }
       type ∈ password | email-allowlist | ip-allowlist

GET    /api/websites/:id/env               → { vars: [{key, masked, secretRef, updatedAt}] }
POST   /api/websites/:id/env               { vars: [{key,value}], confirm: true }
DELETE /api/websites/:id/env/:key?confirm=true

GET    /api/websites/:id/deploy-audits?limit=100
```

---

## 2. 数据库面板

```
GET    /api/databases/providers            → [{ provider, label, needs[], docs }]
POST   /api/databases                      { workspaceId, provider, name, connectionString, branch?, note? }
GET    /api/databases?workspaceId=…
GET    /api/databases/:id?workspaceId=…    → { connection, migrations, backups }
DELETE /api/databases/:id?workspaceId=…&confirm=true
POST   /api/databases/:id/test             { workspaceId }
→ { ok, degraded, message, serverVersion?, latencyMs?, capabilities? }
```

### Schema 与迁移

```
GET  /api/databases/:id/schema?workspaceId=…                     → 当前快照 + 迁移历史
GET  /api/databases/:id/schema?workspaceId=…&introspect=true     → 从远端读取真实结构
POST /api/databases/:id/schema?workspaceId=…&websiteProjectId=…  → 从网站需求生成 DDL
→ { snapshot, up, down, version }

POST /api/databases/:id/migrate            { migrationId, confirm: true }   ← 危险操作
POST /api/databases/:id/migrate/rollback   { migrationId, confirm: true }   ← 危险操作
```

### 查询（只读优先）

```
POST /api/databases/:id/query?workspaceId=…   { sql, params?, readOnly?, limit?, confirm? }

// confirm 不为 true 时 → 预检（不执行）
→ { preflight: { safe, isWrite, needConfirm, reason? } }

// confirm === true → 执行
→ QueryResult = { columns, rows, rowCount, truncated, ms, readOnly }
```

被拒绝的 SQL（静态层）：`DROP DATABASE` / `TRUNCATE` / `GRANT|REVOKE` / `pg_read_file` /
`COPY FROM PROGRAM` / `CREATE EXTENSION` / 多语句写。

### 备份与恢复

```
POST /api/databases/:id/backup?workspaceId=…   { confirm: true }
→ { id, createdAt, format, bytes, tables, sha256, preview, downloadPath }

GET  /api/databases/:id/backups?workspaceId=…
POST /api/backups/:id/restore-plan?workspaceId=…&connectionId=…
→ { sql, steps[], requiresConfirm: true }    ← 只给方案，不自动执行

GET  /api/databases/:id/audits?workspaceId=…
```

---

## 3. 看板编辑器

```
GET    /api/dashboard/registry             → { widgets: WidgetSpec[] }（7 类）
WidgetSpec = { type, label, description, naturalLanguageExamples[], defaultSize{w,h}, dataSource, configSchema[] }

POST   /api/dashboards                     { workspaceId, name, description? }
GET    /api/dashboards?workspaceId=…
GET    /api/dashboards/:id?workspaceId=…    → { dashboard, widgets, data }
PATCH  /api/dashboards/:id?workspaceId=…    { name }
DELETE /api/dashboards/:id?workspaceId=…&confirm=true
```

### 小组件

```
POST /api/dashboards/:id/widgets?workspaceId=…
  方式 A（自然语言）：{ naturalLanguage: "显示网站部署状态" }
  方式 B（直接指定）：{ type: "file-list", title?, config?, layout?, pinnedToDesktop?, refreshIntervalMs? }
→ 201 { widget, inference? }     // 自然语言方式会返回识别类型与置信度

GET    /api/widgets?workspaceId=…&dashboardId=…    → { dashboard, widgets, data }
GET    /api/widgets?workspaceId=…&pinned=true       → 固定到桌面的组件
PATCH  /api/widgets/:id?workspaceId=…   { title?, config?, layout?, pinnedToDesktop?, refreshIntervalMs?, enabled? }
DELETE /api/widgets/:id?workspaceId=…
POST   /api/widgets/:id/refresh?workspaceId=…       → WidgetRenderData
POST   /api/widgets/:id/pin?workspaceId=…           { pinned }
```

7 类组件：`task-progress` `agent-status` `file-list` `website-status` `schedule-status` `data-query` `prompt-template`。

### 布局

```
POST /api/dashboards/:id/layout?workspaceId=…
  { items: [{id,x,y,w,h}], compact? }         // 校验：越界/重叠一律 400
→ { dashboard, widgets }

POST /api/dashboards/:id/layout/rollback?workspaceId=…   { index? }   // 布局回滚
POST /api/dashboards/:id/refresh?workspaceId=…                        // 整板刷新（单点失败隔离）
```

---

## 4. 定时任务

```
GET  /api/schedule/templates   → { templates[6], presets[] }
POST /api/schedule/preview     { expression, timezone }
→ { ok, description?, next: string[5], error? }
```

### 任务 CRUD

```
POST   /api/schedules   { workspaceId, name, trigger, expression, timezone?, taskType?,
                          taskConfig?, template?, templateValues?, channelIds?, retryPolicy?, enabled? }
GET    /api/schedules?workspaceId=…
GET    /api/schedules/:id?workspaceId=…   → { schedule, runs, stats, timeline }
PATCH  /api/schedules/:id?workspaceId=…   { name?, expression?, timezone?, taskConfig?, channelIds?, retryPolicy?, enabled? }
DELETE /api/schedules/:id?workspaceId=…&confirm=true
POST   /api/schedules/:id/run?workspaceId=…   { confirm: true }   → 202 { run }
GET    /api/schedules/:id/runs?workspaceId=…&limit=50
GET    /api/schedule-audits?workspaceId=…
```

`trigger` 语义：

| trigger | expression 格式 | 说明 |
| --- | --- | --- |
| `cron` | `0 9 * * 1-5` 或 6 段带秒 | 支持 `@daily` 等别名；非法表达式返回可读原因 |
| `interval` | 毫秒数字符串，≥ 60000 | 周期任务 |
| `once` | ISO 时间，必须晚于当前 | 一次性任务 |

6 类任务（`taskType`）：

| 类型 | taskConfig | 行为 |
| --- | --- | --- |
| `goal` | `{ objective, acceptanceCriteria?, maxIterations? }` | 创建目标并自动推进 |
| `research` | `{ topic, depth?, allowNetwork? }` | 提交深度研究任务 |
| `office` | `{ format, title, content }` | 生成 Office 文档 |
| `deploy` | `{ websiteProjectId, provider }` | 触发网站部署（危险动作） |
| `db-query` | `{ connectionId, sql, limit? }` | **只读** SQL，写语句直接拒绝 |
| `custom` | `{ payload? }` | 仅触发通知/Webhook |

重试策略 `retryPolicy = { maxRetry, baseDelayMs, factor, maxDelayMs }`，
延迟公式 `min(maxDelayMs, baseDelayMs × factor^(n-1)) × (0.8~1.2 抖动)`。

---

## 5. 通知设置

```
GET /api/notify/catalog    → { channels: [{ type, label, secretFields[], configFields[] }] }
```

### 渠道

```
POST   /api/notify/channels   { workspaceId, type, name, config?, secret?, enabled? }
GET    /api/notify/channels?workspaceId=…
PATCH  /api/notify/channels/:id?workspaceId=…   { name?, config?, secret?, enabled? }
DELETE /api/notify/channels/:id?workspaceId=…&confirm=true
POST   /api/notify/test?workspaceId=…   { channelId }
→ { ok, message, degraded }
POST   /api/notify/send?  { workspaceId, message: {event,title,content,url?,level?}, channelIds? }
→ { sent, failed, results: [{channelId,type,ok,message}] }
GET    /api/notify/logs?workspaceId=…&limit=100&channelId=…
```

6 类渠道与所需凭据：

| type | 敏感字段（加密） | 普通字段 |
| --- | --- | --- |
| `desktop` | 无 | `sound`, `silentOnFocus` |
| `email` | `password` | `host`, `port`, `secure`, `user`, `from`, `to` |
| `webhook` | `url`, `authHeader` | `method`, `headers` |
| `feishu` | `webhookUrl`, `signSecret` | `keyword` |
| `dingtalk` | `webhookUrl`, `signSecret` | `keyword` |
| `wecom` | `webhookUrl` | `mentionedList` |

---

## 6. WS 事件（Phase 3 新增）

| 事件 | payload | 触发时机 |
| --- | --- | --- |
| `website.generated` | `{ projectId, plan, files }` | 生成完成 |
| `website.updated` | `{ projectId, customDomain?, binding? }` | 项目变更/域名绑定 |
| `website.build-log` | `{ projectId, level, msg }` | 构建检查 |
| `deploy.status` | `{ deploymentId, provider, status, url }` | 部署状态变化 |
| `deploy.log` | `{ deploymentId, at, level, msg, elapsedMs }` | 部署日志逐行（实时） |
| `database.status` | `{ connectionId, status }` | 连接状态 |
| `database.migration` | `{ connectionId, migrationId, status }` | 迁移应用/回滚 |
| `dashboard.updated` | `{ dashboardId, widgets }` | 布局保存 |
| `widget.updated` | `{ widgetId, action }` | 组件增删改 |
| `widget.refreshed` | `{ widgetId, type, degraded, error }` | 组件数据刷新 |
| `schedule.updated` | `{ scheduleId, action }` | 任务增删改启停 |
| `schedule.log` | `{ scheduleId, level, msg, runId?, status? }` | 执行过程日志 |
| `notify.sent` | `{ channelId, channelType, title, degraded }` | 发送成功 |
| `notify.failed` | `{ channelId, title, error }` | 发送失败 |
