# Phase 4 架构说明：生态、集群与提示词工程

> 面向读者：想理解「为什么这样设计」的开发者，以及需要评估风险的运维/安全同学。
> Phase 1/2/3 的架构见 `architecture.md`、`phase2-architecture.md`、`phase3-architecture.md`。

## 1. 分层总览（Phase 4 增量）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 客户端  Tauri 2 + React + Zustand + Tailwind + React Grid Layout              │
│  Phase 4 页面  插件市场 │ 付费数据库 │ 提示词工作台 │ 集群视图 │ 安全中心       │
│  Phase 4 组件  PluginCard │ PluginPermissionDialog │ PluginCallLog             │
│               PaidDataQuery │ PaidDataResult │ PromptEditor │ PromptOptimizer │
│               PromptABTest │ ClusterNodeCard │ ClusterTaskBoard               │
│               ClusterHealthChart │ RbacRoleEditor │ AuditLogView              │
└──────────┬────────────────────────────────────────────────┬──────────────────┘
           │ REST /api                                       │ WS /events
┌──────────▼────────────────────────────────────────────────▼──────────────────┐
│ 能力层（Phase 4 新增）                                                        │
│  plugins/   pluginManifest(清单+合规+哈希) · pluginMarket(精选目录)            │
│             pluginInstaller(安装/授权/撤销/更新) · pluginSandbox(策略纯函数)    │
│             mcpClient(JSON-RPC) · mcpServerRegistry · pluginRuntime(调用链)    │
│             pluginCallLog(入参脱敏)                                            │
│  paidData/  providerRegistry(8 家) · adapterBase · 8 个适配器                 │
│             credentialManager(AES-256-GCM) · queryRunner(合规→限流→缓存→执行) │
│             complianceGuard · resultCache(分源 TTL)                            │
│  prompt/    promptTemplate(九要素+变量) · promptGenerator(意图→模板)          │
│             promptOptimizer(规则优先) · promptLibrary(9 个预置)               │
│             promptABTest(人工 0.75/自动 0.25) · promptServiceV4               │
│  cluster/   nodeRegistry · heartbeat · election(确定性优先级) · clusterPolicy │
│             shardScheduler(纯函数) · taskDistributor · faultTolerance         │
│             clusterMonitor · clusterFallback · clusterManager(门面)            │
│  agents/    agentPool · taskDag(纯函数) · parallelismPolicy(纯函数)            │
│             agentRouter(模型/工具/Agent) · resultAggregator(冲突显式)          │
│             conflictResolver · costController · parallelOrchestrator          │
│  enterprise/ rbac · sso(state/nonce) · auditLog(查询+导出) · dataMask          │
│             retentionPolicy(dryRun 优先) · complianceExport                    │
└──────────┬────────────────────────────────────────────────────────────────────┘
┌──────────▼──────────────────────────────┐  ┌────────────────────────────────┐
│ 安全层（贯穿）                            │  │ 数据层 SQLite + Drizzle          │
│  dangerGate(＋20 类动作) · secrets        │  │ migration 0004_phase4（含 .down）│
│  ToolRegistry · safeJoin · 沙箱策略       │  │ 29 张新表（不改 Phase 1/2/3）     │
└──────────────────────────────────────────┘  └────────────────────────────────┘
```

复用 Phase 1/2/3 已有能力：`EventBus`、`AuditService`、`ToolRegistry`（权限门）、`safeJoin`（路径边界）、`AppError`、`ApiResponse`、`modelRouter`（离线兜底）、`secrets`（AES-256-GCM）。

**硬约束：不修改 Phase 1/2/3 的任何表结构与既有接口行为**，只做新增表 + 新增路由 + 既有路由的「显式迁移提示」。

## 2. 七条关键设计决策

### ① 编排逻辑不直接调用 LLM，执行器由调用方注入

`ParallelOrchestrator` 的 `execute` 是可选入参。没有它时只做「规划」（返回会调度哪些任务、用什么模型），不假装执行成功。
好处：多 Agent 编排是**最容易出错**的部分（DAG、并行度、路由、聚合、成本），把它变成纯逻辑后可以完全离线单测；
真实执行由 Agent Runtime 注入，也让「一个测试跑 5 分钟」变成「跑 5 毫秒」。

### ② 分片 / DAG / 并行度 / 降级决策全部是纯函数

`shardScheduler`、`taskDag`、`parallelismPolicy`、`clusterFallback` 都是「输入确定 → 输出确定」。
原因：分布式调度最难排查的是「为什么这次分得不均 / 为什么只跑了 2 个」。
纯函数 + 可解释的 `factors` / `reason` 字段，让每个决策都能在 UI 上说清依据，也能被测试逐条断言。

### ③ 选举用确定性优先级排序，而不是随机超时

随机超时在单机/小集群场景几乎无法测试（结果不确定）。这里用「标签 `leaderPriority` → 角色权重 → 节点名」的确定性排序，
保证「同样的节点集合 + 同样的 term」在任意时刻算出同一个 leader。规则本身可单测，UI 上也能解释「为什么选了它」。

### ④ 冲突必须显式记录，不允许静默取第一个值

`resultAggregator` 的 `majority` 策略在平票时**不裁决**，而是把全部取值保留并标记 `needsReview=true`。
静默取第一个值的后果是：错误结论看起来像共识。`conflictResolver` 提供 `vote / priority / human` 三种手段，
其中 `human` 是兜底 —— 不可自动裁决时就必须落到人工确认。

### ⑤ 付费数据未配置凭据时显式降级，不返回假数据

所有适配器在缺凭据 / 接口不可达时返回 `degraded=true` + 可读说明（如「缺少 appKey」），而不是抛 500 或返回空数组。
降级结果**不写缓存** —— 否则用户配置完凭据还得等 TTL 过期才能拿到真数据（这是一个很容易忽略的坑）。

### ⑥ 提示词优化「规则优先，模型增强」

`promptOptimizer` 的规则部分（歧义检测、结构规范化、约束补全、评分）不依赖任何模型，可离线运行、结果可复现。
模型只在有密钥时做「润色」，且**空章节自动用规则结果补齐** —— 避免「优化完反而变差」。
这让提示词工作台在没有模型的环境下依然可用（而不是变成一个空壳页面）。

### ⑦ 保留策略默认预演（dryRun）

`retentionPolicy.apply` 的 `dryRun` 默认为 `true`：先算「会影响多少条」给用户看，确认后才真删。
并且核心表（`users` / `workspaces` / `goals` / `tasks` / `agents`）**禁止**配置保留策略 —— 删工作区等于删库。

## 3. 端到端数据流

### 3.1 插件调用

```
UI 点击调用
  → POST /plugins/:installationId/invoke
  → gate('paid_data.query'|'plugin.install', confirm)     ← 危险操作闸门（428）
  → PluginRuntime.invoke
      1) 已安装？           否 → 404
      2) 工具已声明？       否 → 403 + 调用日志（留痕越权尝试）
      3) 权限已授权？       否 → 返回 denied(missingScopes)（不抛错，便于 UI 引导授权）
      4) 危险工具已确认？   否 → 428 CONFIRM_REQUIRED
      5) 沙箱策略（网络/路径/超时/并发）
      6) 执行（注入的 executor 或 MCP JSON-RPC）
      7) 写 plugin_call_logs（入参脱敏，成功/失败/被拒都写）
  → 写全局 audit_logs + WS 事件 plugin.called
```

### 3.2 付费数据查询

```
UI 预检 → POST /paid-data/preflight → checkCompliance（UI 提前知道会不会被拒）
UI 查询 → POST /paid-data/query
  → gate('paid_data.query', confirm)                       ← 428
  → CredentialManager.resolve（解密；失败明确报错）
  → PaidDataQueryRunner.run
      1) 合规守卫（provider/action/滥用意图/凭据齐备）      → blocked 也落库
      2) 本地限流（按 provider 声明，60s 滑动窗口）          → 429 + retryAfterMs
      3) 缓存（provider+action+归一化参数，分源 TTL）        → cached=true
      4) 适配器执行（带超时；失败降级不抛 500）
      5) 落 paid_data_queries + paid_data_results（含 citations）
  → 写全局 audit_logs（含 purpose 用途说明）+ WS 事件
```

### 3.3 多 Agent 并行

```
POST /agents/orchestrate
  → 1) DAG 校验（有环/缺依赖/自依赖 → 400 + 环路径）
  → 2) 就绪任务（依赖全部 succeeded）
  → 3) 并行度 = min(工作区配置, 集群策略, 池容量, 预算, CPU 核数, 就绪数) → 带 factors 解释
  → 4) 预算预检（exceeded → limit=0，不产生任何调用）
  → 5) 逐任务路由（agent/model/tool）→ 全部写 agent_routes（含 reason + score）
  → 6) 执行（注入的 executor）
  → 7) 成本计量 → cost_records（含 budgetState）
  → 8) 结果聚合 → aggregated_results（冲突显式记录）
```

### 3.4 集群任务分发

```
POST /cluster/tasks/distribute
  → shardAuto（权重差异大 → by-weight LPT；否则 by-count）
  → TaskDistributor.distribute
      1) 已完成/执行中的分片不重复分发（幂等，可重入）
      2) 并行上限检查（超出保持 pending 并说明）
      3) 选节点：标签匹配 → 资源满足 → 负载最低 → 平局按名称
      4) 写 cluster_shards + cluster_tasks
  → 心跳超时 → sweep 标记 offline → 选举 → handleNodeLoss
      → 受影响分片改派（force=true 跳过重复分发保护）
      → 超重试上限的分片标记 failed（不无限重试）
```

## 4. 与 Phase 1/2/3 的兼容处理

| 位置 | 处理方式 |
| --- | --- |
| 数据库 | 只新增 `0004_phase4.sql` 的表，不改任何既有列；`.down.sql` 只 DROP 本文件新增表 |
| `plugins` 表 | Phase 1 的简版插件表保留并继续写入；Phase 4 的 `plugin_installations` 通过 `plugin_id` 外键关联 |
| `prompt_templates` 表 | Phase 1 的 `PromptService` 与 Phase 4 的 `PromptServiceV4` 共用，`version` 语义一致（同名递增） |
| `cluster_configs` 表 | Phase 2 的简版集群配置保留；Phase 4 的节点/分片/策略是独立表，互不覆盖 |
| 路由 | Phase 1 的 `/plugins/:name/install`、`/plugins`、`/prompt/optimize` 保持原行为；Phase 4 用不同的路径（`/plugins/installed`、`/prompts/v4`、`/prompts/optimize-v4`）避免遮蔽 |
| 危险动作 | `DANGEROUS_ACTIONS` 用 `Object.assign` 追加 Phase 4 的 20 条，原有 15 条不变 |
| 功能开关 | 新增 `phase4Cluster/phase4PaidPlugins/phase4Prompt/phase4Enterprise`，默认开启；关闭后接口返回「未启用」但数据全保留 |

## 5. 扩展点（下一轮可以怎么长）

1. **真实 MCP 宿主进程**：`PluginRuntime` 已把执行器抽成 `ToolExecutor`，注入 stdio 子进程即可（协议层 `McpClient` 已就绪）
2. **Redis 化**：`EventBus`、`ResultCache`、限流窗口的接口都是可替换的；换成 Redis 即可支持多实例
3. **真实集群**：`nodeRegistry` 的 host/port 已建模，`McpClient` 的 JSON-RPC 可直接复用于节点间通信
4. **向量召回**：Phase 2 的 `embedding` 接口已预留，Phase 4 的 `plugin`/`paidData` 结果可作为新的召回源
