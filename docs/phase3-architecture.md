# Phase 3 架构说明：交付与自动化

Phase 3 在 Phase 1（桌面壳/聊天/模型/SQLite/文件）与 Phase 2（百万 Token 上下文/目标模式/多 Agent/Office/深度研究）之上，
增加五块「把工作变成交付物」的能力：

1. 网站生成与部署（Vercel / Cloudflare Pages / Netlify）
2. 数据库接入（Neon / Supabase）
3. 定制化看板与小组件
4. 定时任务与自动执行
5. 推送通知（桌面 / 邮件 / Webhook / 飞书 / 钉钉 / 企业微信）

## 1. 分层视图

```
┌────────────────────────────────────────────────────────────────────────────┐
│ 客户端  Tauri 2 + React + Zustand + Tailwind                                 │
│  Phase 3 页面  部署中心 │ 数据库面板 │ 看板编辑器 │ 定时任务管理 │ 通知设置     │
│  Phase 3 组件  WebsitePreview │ DeployLogView │ DomainConfig │ EnvVarEditor  │
│                WidgetCard │ WidgetGallery │ CronEditor │ JobHistory          │
│                NotifyChannelForm                                             │
└──────────┬──────────────────────────────────────────────┬───────────────────┘
           │ REST /api                                     │ WS /events
┌──────────▼──────────────────────────────────────────────▼───────────────────┐
│ 能力层（Phase 3 新增）                                                        │
│  deploy/    requirements → websiteGenerator → staticSiteBuilder/fullstackBuilder
│             providerRegistry → vercel/cloudflare/netlify/localPreview Adapter │
│             envManager（加密注入） · domainManager · accessControl            │
│             deployLog（WS 流式） · rollback · delete                          │
│  database/  adapterFactory → neon/supabase/postgres Adapter                  │
│             schemaGenerator · migrationRunner（可回滚） · queryRunner（只读优先）│
│             connectionManager（加密存储） · backup                            │
│  dashboard/ widgetRegistry（7 类） · dataSource（7 个 provider）              │
│             layoutEngine（校验/紧凑/快照） · refreshScheduler（并发受限）      │
│  schedule/  cronParser（自研 + 时区 + nextRun） · scheduleEngine（tick 模型）  │
│             jobRunner（6 类任务） · templates · retryPolicy（指数退避）· jobLog│
│  notify/    notifier 抽象 → desktop/email/webhook/feishu/dingtalk/wecom      │
│             notifyService（重试 + 发送日志）                                   │
│  security/  secrets（AES-256-GCM + scrypt） · dangerGate（二次确认闸门）       │
│  audit/     DeployAuditor · DbAuditor · ScheduleAuditor（分域 + 脱敏）        │
└──────────┬──────────────────────────────────────────────────────────────────┘
┌──────────▼──────────────────────┐  ┌───────────────────────────────────────┐
│ 复用 Phase 1/2                   │  │ 数据层 SQLite + Drizzle                │
│  EventBus · AuditService         │  │  0001_init · 0002_phase2 · 0003_phase3 │
│  ToolRegistry（权限门）           │  │  每个迁移都有 .down.sql → 可独立回滚     │
│  safeJoin（路径边界）             │  └───────────────────────────────────────┘
│  AppError/ApiResponse 统一契约    │
│  GoalEngine/ResearchEngine/Office│
└──────────────────────────────────┘
```

## 2. 关键设计决策

### 2.1 「凭据由用户手动配置」是硬约束，不是可选项

所有外部服务的凭据都遵守同一条链路：

```
用户手动申请 → 环境变量 / 面板输入 → AES-256-GCM 加密 → DB 只存密文
                                              ↓
                                     部署时在内存解密注入
                                              ↓
                                  日志/审计/接口只出现变量名
```

实现位置：
- `security/secrets.ts`：`seal` / `unseal` / `maskSecret` / `redactConnectionString` / `resolveProviderToken`
- `deploy/envManager.ts`：环境变量加密存储，`resolveForDeploy` 只在部署瞬间解密
- `notify/notifyService.ts`：渠道凭据加密，`toPublic` 永不返回 `encryptedConfig`

**工作台不会代用户注册账号、申请 API Key、保存平台登录态。**

### 2.2 未配置凭据时必须「显式降级」，绝不假装成功

这是 Phase 2 建立、Phase 3 严格执行的规则。具体表现：

| 场景 | 行为 |
| --- | --- |
| 未配 `VERCEL_TOKEN` 部署 | 抛可读错误，附所需环境变量名与获取地址，同时写 `website.deploy.blocked` 审计 |
| 未配数据库连接串执行查询 | 抛「未配置 X 连接串」，提示去哪拿 |
| 桌面通知（无 Tauri） | 写 outbox 文件 + 返回 `degraded: true`，明确说明「未真正弹窗」 |
| 未配模型密钥生成网站 | 走规则解析（确定性），结果标 `degraded: true` |
| 无任何部署凭据 | `local-preview` 适配器给出本机可访问 URL，并标注「未发布公网」 |

### 2.3 危险操作闸门（dangerGate）

`security/dangerGate.ts` 集中登记所有危险动作及其人类可读后果：

```ts
gate('website.delete', body.confirm, { websiteProjectId })
// confirm !== true → 428 CONFIRM_REQUIRED + { action, summary, level }
```

**为什么不用「前端弹窗 + 后端信任」**：后端必须独立可验证。
前端 `triggerConfirm` 只负责收集用户意图，真实拦截点永远在服务端。

验收点：`phase3-security.test.ts` 遍历全部危险动作，断言 `false/undefined/null/0/''/'true'/1` 全部被拒绝。

### 2.4 只读优先的数据库访问

三层防护（`database/queryRunner.ts` + `postgresAdapter.ts`）：

1. **静态层**：`PostgresAdapter.inspect()` 按「整条语句」判定（不是只看开头！），拦截
   `DROP DATABASE` / `TRUNCATE` / `GRANT` / `pg_read_file` / `COPY FROM PROGRAM` / `CREATE EXTENSION`，
   以及「多语句写」（`select 1; drop table t` 这种伪装）。
2. **会话层**：只读时 `BEGIN READ ONLY`，即使静态分析漏掉，数据库也会拒绝写。
3. **结果层**：强制 `LIMIT`（默认 200，上限 2000），避免把百万行拉进内存。

### 2.5 调度采用「tick + next_run_at」而不是「一个任务一个 cron 实例」

`schedule/scheduleEngine.ts` 每 30 秒扫一次到期任务：

- 任务在运行期增删改不需要重新注册定时器；
- `next_run_at` 持久化 → 进程重启不丢任务；
- 并发上限 + in-flight 集合 → 同一任务不会重入；
- 启动时不补跑错过的任务（只记 warning）→ 避免一次性触发雪崩。

`cronParser.ts` 是自研的，原因：
- 需要给 UI 提供「下次执行时间」（node-cron 不提供）；
- 需要自然语言描述（避免 `0 0 * * *` 到底几点的误解）；
- 需要显式时区（`Intl.DateTimeFormat` 换算，正确处理夏令时）。
- 性能：字段级跳过（日期不匹配直接跳次日）使 500 次计算从 4630ms 降到 247ms。

### 2.6 看板刷新：事件驱动 + 轮询兜底 + 并发受限

`dashboard/refreshScheduler.ts`：

- **事件驱动**：状态变化立即刷新相关类型组件（用户感知实时）；
- **轮询兜底**：按组件各自的 `refreshIntervalMs`，防止事件丢失；
- **并发上限**（默认 4）+ **防抖**（默认 1500ms）+ **首刷宽限期**（新建组件不立即刷新）；
- 单组件失败不影响整板（`Promise.all` 内逐个 try/catch）。

### 2.7 部署日志流式输出

`deploy/deployLog.ts`：日志同时写内存缓冲 + WS 推送（`deploy.log` 事件）。
批量 flush 到 DB（阈值 20 行或 1 秒防抖），超长日志保留头尾并标注省略量。

## 3. 目录结构

```
packages/server/src/
  deploy/
    requirements.ts        需求解析（规则 + LLM 增强）
    templates.ts           生成产物公共模板（README/env.example/gitignore/styles）
    staticSiteBuilder.ts   静态站生成（零依赖 server.mjs）
    fullstackBuilder.ts    全栈站生成（server.mjs + api/*.mjs + db/schema.sql）
    websiteGenerator.ts    落盘 + 密钥扫描 + 路径边界
    projectService.ts      项目更新 / 产物读取 / 构建可部署性检查
    provider.ts            部署适配器接口 + 能力声明
    vercelAdapter.ts       Vercel（内联 files 部署 + 轮询状态）
    cloudflareAdapter.ts   Cloudflare Pages（Direct Upload + manifest）
    netlifyAdapter.ts      Netlify（digest 增量上传）
    localPreviewAdapter.ts 本地预览（免凭据，仅监听 127.0.0.1）
    providerRegistry.ts    注册表 + 全平台能力探测
    envManager.ts          环境变量加密管理
    domainManager.ts       域名校验 + DNS 指引 + 绑定
    accessControl.ts       口令/邮箱/IP 白名单（scrypt）
    deployLog.ts           流式日志通道
    deployService.ts       生成 → 部署 → 回滚 → 删除 编排
    uploadUtil.ts          打包与体积校验
  database/
    adapter.ts             适配器接口
    postgresAdapter.ts     Postgres 基类（连接/内省/迁移/备份 + SQL 静态校验）
    neonAdapter.ts         Neon（分支感知 + 项目列举）
    supabaseAdapter.ts     Supabase（RLS 策略生成 + 项目列举）
    adapterFactory.ts      provider → adapter
    schemaGenerator.ts     需求 → DDL + down DDL + 快照
    migrationRunner.ts     版本化迁移（强制 down 脚本）
    queryRunner.ts         只读优先查询 + 预检
    connectionManager.ts   连接串加密存储
    backup.ts              逻辑备份 + sha256 校验 + 恢复计划
    databaseService.ts     编排 + 审计
  dashboard/
    widgetRegistry.ts      7 类组件 + 自然语言推断
    dataSource.ts          7 个数据源 provider + 降级语义
    layoutEngine.ts        布局校验/紧凑/重叠检测/快照回滚
    refreshScheduler.ts    事件驱动 + 轮询 + 并发受限
    dashboardService.ts    编排（含布局历史）
  schedule/
    cronParser.ts          5/6 段 + 别名 + 时区 + nextRun + 描述
    templates.ts           6 类任务模板 + 占位符校验
    jobRunner.ts           6 类任务执行 + 可重试性判定
    scheduleService.ts     编排（审计 + 通知联动）
    scheduleEngine.ts      tick 调度 + 启动恢复
    jobLog.ts              摘要/时间线/统计
  notify/
    notifier.ts            渠道抽象 + 超时保护
    desktopNotifier.ts     outbox 模式
    emailNotifier.ts       SMTP
    webhookNotifier.ts     通用 Webhook
    feishuNotifier.ts      飞书（含签名）
    dingtalkNotifier.ts    钉钉（含加签）
    wecomNotifier.ts       企业微信（含 @成员）
    registry.ts            渠道注册表
    notifyService.ts       渠道 CRUD + 分发 + 日志 + 重试
    retryPolicy.ts         指数退避 + 抖动（调度与通知共用）
  security/
    secrets.ts             加密存储 + 脱敏 + 口令哈希 + 凭据解析
    dangerGate.ts          危险动作登记 + 二次确认闸门
  audit/
    index.ts               部署/数据库/定时三个分域审计 + detail 脱敏
  db/
    schema/index.ts        Phase 1/2 表 + 复用表（补 Phase 3 列）
    schema/phase3.ts       Phase 3 新增表定义
    migrations/0003_phase3.sql + .down.sql

packages/desktop/src/
  pages/        DeployCenterPage · DatabasePanelPage · DashboardEditorPage
                ScheduleManagerPage · NotificationSettingsPage
  components/phase3/
                WebsitePreview · DeployLogView · DomainConfig · EnvVarEditor
                WidgetCard · WidgetGallery · CronEditor · JobHistory · NotifyChannelForm
```

## 4. 数据流示例：从一句话到线上网站

```
用户：「做一个客户管理系统，有客户和订单，带后台管理」
  │
  ├─ POST /websites                → website_projects(status=draft)
  ├─ POST /websites/:id/generate
  │    ├─ requirements.parseRequirement      → WebsitePlan（页面/实体/API/样式/访问控制）
  │    ├─ fullstackBuilder.buildFullstackSite → 17 个文件（含 db/schema.sql + down 脚本）
  │    ├─ websiteGenerator.writeProject      → 落到工作区 websites/<name>/（清空后重建）
  │    ├─ 密钥扫描（拒绝写入含凭据的产物）
  │    └─ website_builds(version=1) + deploy_audits(website.generate)
  ├─ POST /websites/:id/build      → 入口存在 / 无密钥 / 体积合理 三项检查
  ├─ POST /websites/:id/env        → DATABASE_URL 加密入库（明文永不回显）
  ├─ POST /websites/:id/deploy { provider: vercel, confirm: true }
  │    ├─ dangerGate('website.deploy', true)
  │    ├─ providerRegistry.getAdapter('vercel') → 无 token → 可读错误 + 审计 blocked
  │    └─ 有 token → 内联 files 上送 → 轮询 ready → website_deployments(url=...)
  │                  → 审计 website.deploy → 通知 dispatch（deploy 事件）
  ├─ POST /websites/:id/domain     → 域名校验 → 平台绑定 → DNS 指引
  ├─ POST /websites/:id/rollback   → 提升历史部署 → 新记录 rollback_of=<原 id>
  └─ DELETE /websites/:id?confirm=true → 尽力清理平台侧 → 本地标 deleted
```
