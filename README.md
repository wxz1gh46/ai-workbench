# AI 工作台（AI Workbench）

> 你定义方向，它完成全过程。你验收结果，它持续进化。

桌面 AI 工作台：给定目标，系统自主规划、多 Agent 并行执行、调用工具、处理文件、部署网站、定时推送，最终交付完整成果。

---

## 目录结构

```
ai/
├── packages/
│   ├── shared/                        # 前后端共享：数据模型 / 事件协议 / API 契约 / 常量
│   │   └── src/
│   │       ├── types/
│   │       │   ├── ids.ts             # Id / 统一错误码 / ApiResponse 包装
│   │       │   ├── domain.ts          # 18 张表对应的领域模型
│   │       │   ├── events.ts          # WS 事件协议 + LogLine
│   │       │   └── api.ts             # 请求/响应 DTO
│   │       └── constants/index.ts     # Token 预算 / 内置 Agent / 危险动作清单
│   │
│   ├── server/                        # Node + TypeScript 后端（Agent Runtime）
│   │   ├── drizzle.config.ts
│   │   ├── test/e2e.test.ts           # 端到端冒烟测试（18 用例）
│   │   └── src/
│   │       ├── main.ts                # HTTP + WS 启动入口
│   │       ├── cli.ts                 # 无桌面端也能验证全链路
│   │       ├── config.ts              # 环境变量读取，无硬编码密钥
│   │       ├── db/
│   │       │   ├── client.ts          # SQLite + Drizzle
│   │       │   ├── migrate.ts         # 自研迁移执行器（幂等 + 可回滚）
│   │       │   ├── schema/index.ts     # Drizzle schema
│   │       │   └── migrations/         # 0001_init.sql + .down.sql
│   │       ├── agent/
│   │       │   ├── goal-service.ts    # 目标模式编排（Coordinator）
│   │       │   ├── planner.ts         # 目标解析 → 任务 DAG
│   │       │   ├── executor.ts        # 任务执行 + 工具调用 + 追踪
│   │       │   ├── critic.ts          # 完成审计（目标即验收标准）
│   │       │   ├── task-graph.ts      # DAG 纯函数（ready/blocked/环检测/进度）
│   │       │   ├── memory.ts          # 分层上下文（摘要/事实/原文/召回）
│   │       │   ├── model-router.ts    # 多模型路由 + 长上下文自动切换
│   │       │   └── tokens.ts          # Token 估算
│   │       ├── tools/                 # 工具层（注册表 + 权限门 + 审计）
│   │       │   ├── registry.ts
│   │       │   ├── fs-tools.ts        # 受限文件读写（防路径穿越）
│   │       │   └── office-tools.ts    # docx/xlsx/pptx/pdf/markdown
│   │       ├── services/              # 领域服务
│   │       │   ├── workspace.ts       # 引导 + 内置 Agent
│   │       │   ├── file-service.ts    # 文件 + 版本历史
│   │       │   ├── schedule-service.ts + scheduler.ts
│   │       │   ├── widget-service.ts  # 自然语言 → 小组件
│   │       │   ├── plugin-service.ts  # 插件市场 + 合规红线
│   │       │   ├── prompt-service.ts  # 提示词九要素生成
│   │       │   └── audit.ts
│   │       ├── events/bus.ts          # 事件总线（环形缓冲回放）
│   │       ├── events/ws.ts           # WS /events
│   │       └── router/app.ts + schemas.ts
│   │
│   └── desktop/                       # Tauri 2 + React + Vite 桌面端
│       ├── src/
│       │   ├── App.tsx                # 左侧导航 + 九大页面
│       │   ├── stores/app-store.ts    # Zustand 单一状态 + 事件归约
│       │   ├── lib/api.ts             # 类型安全 API 客户端
│       │   ├── lib/events.ts          # WS 指数退避重连
│       │   ├── components/ui.tsx
│       │   └── pages/                 # 目标/对话/看板/文件/定时/插件/提示词/集群/设置
│       └── src-tauri/                 # Rust 壳（目录校验 + 通知）
│
├── DECISIONS.md                       # 架构决策记录 + 已知缺陷复盘
├── docs/architecture.md               # 架构图 + 数据流
├── docker-compose.yml                 # Phase 3 本地 Postgres
└── .env.example                       # 全部配置项（含密钥占位）
```

---

## 核心架构

```
┌─────────────────────────────────────────────────────────────┐
│ 客户端层  Tauri 2 + React + Zustand + Tailwind              │
│   目标模式 │ 对话 │ 看板 │ 文件 │ 定时 │ 插件 │ 提示词 │ 集群  │
└───────────────┬─────────────────────────┬───────────────────┘
                │ REST /api               │ WS /events
┌───────────────▼─────────────────────────▼───────────────────┐
│ Agent 运行时（packages/server/src/agent）                    │
│                                                             │
│  Coordinator ──▶ Planner ──▶ TaskQueue(DAG) ──▶ Executor    │
│       ▲              │              │               │       │
│       │              ▼              ▼               ▼       │
│    Critic ◀──── 验收标准        TaskGraph      ToolRegistry  │
│       │        （目标即审计）    纯函数        + 权限门      │
│       │                                          │          │
│       └────────── Memory（分层上下文）            │          │
│                 摘要/事实/原文/召回                │          │
└───────────────┬──────────────────────────────┬──────────────┘
                │                              │
┌───────────────▼────────────┐   ┌─────────────▼─────────────┐
│ 模型层  ModelRouter        │   │ 工具层                     │
│  普通模型 ◀──阈值──▶ 长上下文│   │  fs / office / 插件 / 部署 │
└────────────────────────────┘   └─────────────┬─────────────┘
                                               │
┌──────────────────────────────────────────────▼─────────────┐
│ 数据层  SQLite + Drizzle（本地） │ Postgres/Neon（Phase 3）  │
│         向量库（Phase 2）                                   │
└────────────────────────────────────────────────────────────┘
```

**目标循环**

```
解析目标 → 生成计划 → 任务 DAG → 并行执行 → 验证 → 反思 → 更新计划 → 完成审计
    │                                                        ▲
    └───────────── 目标文本同时作为起始指令与验收标准 ──────────┘
```

---

## 快速开始

### 环境要求

- Node.js ≥ 20（开发用 24）
- pnpm ≥ 9
- 可选：Rust 1.77+（构建桌面壳）、LibreOffice（Phase 2 文档转换）

### 1. 安装

```bash
pnpm install
cp .env.example .env
```

> `better-sqlite3` 需要编译。Debian/Ubuntu：
> `apt-get install -y build-essential python3-dev && npm i -g node-gyp`

### 2. 启动后端（终端 1）

```bash
pnpm dev:server
# http://127.0.0.1:8787/health
# ws://127.0.0.1:8787/events
```

### 3. 启动桌面端（终端 2）

```bash
pnpm dev:desktop
# http://localhost:5183
```

使用 Tauri 原生窗口：

```bash
pnpm --filter @ai/desktop tauri:dev
```

### 4. 配置模型（可选但推荐）

不配置也能跑：系统进入**离线兜底模式**，目标是「流程完整、结果占位」，UI 会明确提示。

配置真实模型：

```bash
# .env
AI_DEFAULT_PROVIDER=openai-compatible
AI_BASE_URL=https://api.openai.com/v1   # 或本地 http://127.0.0.1:11434/v1
AI_API_KEY=sk-***
AI_MODEL=gpt-4o-mini
AI_LONG_CONTEXT_MODEL=gpt-4.1
AI_LONG_CONTEXT_THRESHOLD=120000
```

### 5. 设置工作目录

桌面端「文件」页右上角填入目录，或在 CLI 中：

```bash
pnpm cli bootstrap   # 打印 workspace.id
```

未设置工作目录时，所有文件/Office 工具会被拒绝（安全默认）。

---

## 命令行验证（不依赖桌面端）

```bash
pnpm cli bootstrap
pnpm cli goal "调研 2025 年储能行业，输出带引用的报告"
pnpm cli run <goalId>            # 自动跑完并输出审计报告
pnpm cli advance <goalId>        # 只推进一轮
pnpm cli status <goalId>
pnpm cli office docx --title "周报" --content "# 本周\n- 完成 A"
```

---

## 测试

```bash
pnpm test                 # 全部（单元 + 端到端）
pnpm --filter @ai/server test
pnpm --filter @ai/desktop test
pnpm typecheck            # 三个包的类型检查
```

当前覆盖（49 个用例）：

- **server 单元**：DAG（ready/blocked/环/拓扑/进度）、Token 估算、计划解析、审计解析、工具调用提取、提示词渲染、插件合规、小组件推断
- **server 端到端**：引导 → 目标模式全流程（含 4 轮推进 + 审计通过）→ Office 四格式落盘 → 文件版本递增 → 插件合规 → 定时任务校验 → 看板 → 提示词 → 审计日志 → 统一错误格式
- **desktop 单元**：工具函数与状态标签

---

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康度 + 降级状态 + 阶段开关 |
| POST | `/workspaces/bootstrap` | 初始化 local 用户 + 默认工作区 + 9 个内置 Agent |
| PATCH | `/workspaces/:id` | 设置工作目录 |
| GET | `/workspaces/:id/agents` | Agent 列表 |
| POST | `/conversations/:id/messages` | 对话（分层上下文 + 召回溯源） |
| GET | `/conversations/:id/context-preview` | 查看上下文组装结果与 Token 占用 |
| GET | `/conversations/:id/memory` | 查看关键事实 |
| POST | `/agent/goal` | 创建目标（自动拆解 DAG） |
| POST | `/agent/goals/:id/advance` | 推进一轮 |
| POST | `/agent/goals/:id/run` | 自动跑完 |
| GET | `/agent/goals/:id` | 目标 + 任务详情 |
| GET | `/agent/goals/:id/messages` | Agent 间消息（任务板） |
| POST | `/agent/tasks/:id/cancel` | 取消任务 |
| GET | `/agent/runs` | 运行追踪（prompt / 模型 / token） |
| POST | `/files/upload` | 上传（同路径自动递增版本） |
| GET | `/files/:id/versions` | 版本历史 |
| POST | `/office/generate` | 生成 docx/xlsx/pptx/pdf/markdown |
| POST | `/research` | 深度研究（Phase 2） |
| POST | `/website/deploy` | 网站部署（Phase 3，需 confirm） |
| POST/GET/PATCH | `/schedule` | 定时任务 |
| GET/POST/DELETE | `/plugins` | 插件市场与安装 |
| POST | `/prompt/optimize` | 提示词九要素生成 |
| GET/POST/PATCH/DELETE | `/widgets` | 看板小组件 |
| GET | `/audit` | 审计日志 |
| GET | `/events/recent` | 事件回放 |
| WS | `/events` | 实时事件订阅 |

统一响应：成功 `{ ok: true, data, traceId }`；失败 `{ ok: false, error: { code, message, details?, traceId } }`。

---

## 数据模型

18 个实体，全部落地在 SQLite：

`User` `Workspace` `Conversation` `Message` `ConversationSummary` `MemoryFact`
`Goal` `Task` `Agent` `AgentRun` `ToolCall` `AgentMessage`
`File` `FileVersion` `Artifact`
`Website` `DatabaseConnection`
`Schedule` `ScheduleRun`
`Widget`
`Plugin` `PluginCallLog`
`PromptTemplate`
`AuditLog` `NotificationChannel`

关键设计：

- **多工作区**：所有业务表带 `workspace_id`，级联删除
- **任务依赖**：`tasks.depends_on` 存 JSON 数组，运行时校验无环
- **运行追踪**：`agent_runs` 记录 prompt 摘要、模型、输入/输出 token、成本
- **文件版本**：`files.version` + `file_versions` 保留每次内容快照
- **部署记录**：`websites.build_log` + 状态机，支持回滚入口
- **审计**：`audit_logs.dangerous` / `confirmed_by_user` 双列留痕

---

## 合规与安全约定

**写进代码的硬约束**（有单测覆盖）：

1. 密钥只从环境变量 / Keychain 读取，代码与数据库不存明文
2. 付费数据源插件（同花顺 / 天眼查 / Wind / 恒生聚源 / S&P Global / IMF / 华宇元典 / 学术库）必须 `requiresUserAuth = true`，凭据由用户手动配置
3. 插件 manifest 中出现「绕过反爬 / 绕过验证码 / 共享账号 / 破解授权」直接拒绝安装
4. 文件工具限定在 `workspace.rootPath` 内，拒绝路径穿越
5. 危险操作（部署 / 删除 / 安装 / 付费调用）在工具层与路由层双重拦截，且必须留审计

---

## 阶段进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **Phase 1 MVP** | 桌面壳 · 聊天 · 模型接入 · SQLite · 文件上传 · 基础 Agent · 基础设置 | ✅ 已交付 |
| **Phase 2 核心能力** | 目标模式 · 多 Agent 并行 · Office 处理 · 深度研究 · 百万 Token 上下文 | 🟡 目标模式/多 Agent/Office/分层上下文已完成；深度研究联网检索待做 |
| **Phase 3 交付与自动化** | 网站部署 · Neon/Supabase · 定制看板 · 定时任务 · 推送通知 | ✅ 已交付 |
| **Phase 4 生态与集群** | 实验性集群 · 精选插件 · 付费数据库 · 提示词工程 · 企业安全审计 | ✅ 已交付（MCP stdio 宿主进程、真实数据源联调待补） |

---

## 回滚方案

- **代码**：每一阶段独立 PR，`git revert <merge-commit>` 即可回滚
- **数据库**：每个迁移都有 `.down.sql`（`0001_init` / `0002_phase2` / `0003_phase3` / `0004_phase4`）
- **功能开关**：置 0 即可停用对应能力，**数据全保留**（见 `docs/phase4-rollback.md` 的 L1~L5 分级）
- **数据本身**：删除 `data/` 目录即可回到初始状态（本地单机，无外部依赖）
- **配置**：`.env` 不纳入版本控制，回滚代码不影响用户配置

```bash
pnpm --filter @ai/server db:rollback       # 回滚最后一个迁移
pnpm --filter @ai/server verify:rollback   # 验证 Phase 2/3 回滚
pnpm --filter @ai/server verify:phase4     # 验证 Phase 4 全部硬约束（含 0004 回滚）
```

---

## 下一步建议

1. **Phase 2 收尾**：接入 LanceDB 做真语义召回；用 LLM 自动触发滚动摘要
2. **Phase 2 收尾**：LibreOffice headless 转换解决 CJK PDF 排版
3. **Phase 4 收尾**：MCP stdio 宿主进程（`PluginRuntime` 的 executor 已预留注入点）
4. **Phase 4 收尾**：付费数据源在你的账号下真实联调（适配器与合规守卫已就绪）
5. **多实例化**：把 `EventBus` / `ResultCache` / 限流窗口换成 Redis，即可横向扩展


---

## Phase 2 目录结构（增量）

```
packages/server/src/
├── context/                     # 百万 Token 分层上下文
│   ├── contextManager.ts        # 统一入口：存储/组装/压缩/事实/预算/路由/溯源
│   ├── tokenBudget.ts           # 六分区预算 + 输出预留 + 借用 + 截断（纯函数）
│   ├── summarizer.ts            # 滚动摘要（模型优先，离线抽取式兜底）
│   ├── factExtractor.ts         # 事实抽取（规则 + 模型，带分类与溯源）
│   ├── vectorRecall.ts          # 向量 + 关键词混合召回（时间衰减 + 预算截断）
│   └── embedding.ts             # 本地确定性 embedding / 远端可选
├── goals/                       # 目标模式
│   ├── goalEngine.ts            # 编队循环：GoalRun 持久化/并行限流/修正/审计
│   ├── progressTree.ts          # 目标 → 任务 → 子任务（纯函数）
│   ├── reflection.ts            # 重试/换角色/换工具/请求授权/放弃 + 停滞检测
│   └── audit.ts                 # 结构化审计：逐条对齐验收标准并给出证据
├── office/                      # Office 处理
│   ├── zip.ts                   # 零依赖 ZIP 读写（确定性输出）
│   ├── parse.ts                 # docx/xlsx/pptx/pdf 解析（含 PDF 对象流）
│   ├── edit.ts                  # 原地编辑 OOXML（不破坏格式）
│   ├── converter.ts             # LibreOffice headless（可选依赖）
│   └── officeService.ts         # 读取/预览/编辑/生成/转换/版本/导出 + 安全边界
├── research/                    # 深度研究
│   ├── robots.ts                # robots.txt 合规（最长匹配、缓存、保守拒绝）
│   ├── search.ts                # 检索（用户端点优先，否则本地素材）
│   ├── fetch.ts                 # 合规抓取（noindex 尊重、限流、超时、体积上限）
│   ├── crossValidate.ts         # 论断级多源交叉验证（数值冲突检测）
│   ├── citations.ts             # 引用编号 + 一致性校验
│   ├── charts.ts                # Mermaid 图表
│   ├── report.ts                # 结构化报告 + 润色安全校验
│   └── researchEngine.ts        # 11 步流程编排 + 导出 + 网页发布
└── db/migrations/
    ├── 0002_phase2.sql          # Phase 2 表与列
    └── 0002_phase2.down.sql     # 独立回滚脚本

packages/desktop/src/
├── pages/
│   ├── GoalPage.tsx             # 目标模式（进度树 + 阻塞项 + 结构化审计）
│   ├── AgentClusterPage.tsx     # Agent 集群（模式开关 + 节点图 + 消息流 + 看板）
│   ├── OfficeWorkspacePage.tsx  # Office 工作区（预览/编辑/转换/版本/导出）
│   ├── ResearchPage.tsx         # 深度研究（进度/来源/冲突/报告/发布）
│   └── MemoryPanelPage.tsx      # 记忆面板（摘要/事实/预算/召回溯源）
├── components/
│   ├── ProgressTree.tsx         # 进度树
│   ├── TokenBudgetBar.tsx       # Token 预算条
│   ├── TaskBoard.tsx            # 任务看板（取消/改派/抢占）
│   └── AgentNode.tsx            # Agent 节点（状态/任务/最近消息）
└── lib/confirm.ts               # 危险操作确认统一入口（可注入替身）
```

---

## Phase 2 运行命令

```bash
# 全量校验
pnpm typecheck        # 三个包的类型检查
pnpm test             # 全量测试（server 238 + desktop 4）

# 分能力测试
pnpm test:context     # Step 1 分层上下文
pnpm test:security    # Step 8 安全与权限
pnpm --filter @ai/server test:goals      # 目标模式
pnpm --filter @ai/server test:office     # Office 处理
pnpm --filter @ai/server test:research   # 深度研究

# 规模验证（百万 token）
pnpm perf:million

# 迁移与回滚
pnpm db:migrate
pnpm db:rollback 0002_phase2.sql

# 启动
pnpm dev:server       # 后端 :8787
pnpm dev:desktop      # 前端 :5183
```

> **不配置任何密钥也能跑通全链路**：系统进入离线兜底模式，
> 摘要走抽取式、审计走确定性规则、报告走结构化模板，
> 所有降级结果都显式标注 `degraded`，不会静默冒充真实输出。

---

## Phase 3：交付与自动化

Phase 3 把「工作」变成「交付物」：一句话生成网站并部署上线、接入真实数据库、
定制看板、定时自动执行、多渠道推送。

### 能做什么

| 能力 | 说明 | 免凭据可用？ |
| --- | --- | --- |
| 网站生成 | 自然语言 → 页面 + 后端 API + 数据库 Schema（8~17 个文件） | ✅ |
| 一键部署 | Vercel / Cloudflare Pages / Netlify，返回线上 URL | 需平台 Token |
| 本地预览 | 无需任何凭据，本机可访问（仅 127.0.0.1） | ✅ |
| 自定义域名 | 绑定 + DNS 记录指引 + HTTPS 状态 | 需平台 Token |
| 访问控制 | 口令（scrypt）/ 邮箱白名单 / IP 白名单 | ✅ |
| 环境变量 | AES-256-GCM 加密存储，部署时注入，日志无明文 | ✅ |
| 部署日志 | 实时流式（WS）+ 落库回放 | ✅ |
| 回滚 / 删除 | 回滚到历史部署（可追溯 `rollbackOf`）/ 清理平台侧 | ✅ |
| Neon / Supabase | 连接测试 / Schema 生成 / 版本化迁移（可回滚）/ 只读查询 / 备份 | 需连接串 |
| 定制看板 | 自然语言建 7 类小组件 + 拖拽布局 + 布局回滚 + 固定到桌面 + 实时刷新 | ✅ |
| 定时任务 | Cron（含时区）/ 周期 / 一次性 + 6 类任务 + 模板 + 日志 + 指数退避重试 | ✅ |
| 推送通知 | 桌面 / 邮件 / Webhook / 飞书 / 钉钉 / 企业微信 + 发送日志 + 重试 | 桌面免凭据 |

### 安全底线（硬约束，无开关可关）

1. **凭据不落明文**：源码/日志/DB/审计/接口响应中都不出现凭据原文；
   加密算法 AES-256-GCM（带认证标签），口令用 scrypt。
2. **危险操作二次确认**：14 类危险动作在服务端强制校验 `confirm === true`，
   未确认返回 `428 CONFIRM_REQUIRED` + 人类可读后果说明。
3. **只读优先的数据库访问**：三层防护（静态 SQL 校验 + `BEGIN READ ONLY` + 强制 LIMIT）；
   按「整条语句」判定，`select 1; drop table t` 这种伪装写会被拦。
4. **凭据由用户手动配置**：工作台不代注册账号、不申请 Key、不保存登录态。
5. **所有外部调用写审计**：部署/数据库/定时三个分域审计表，`detail` 自动脱敏。
6. **生成产物密钥扫描**：命中常见凭据形态直接拒绝写入，并报出文件与模式。

### 快速体验（无需任何密钥）

```bash
pnpm install --ignore-scripts && pnpm rebuild better-sqlite3
pnpm typecheck && pnpm test          # 710 服务端 + 4 桌面用例
pnpm dev:server && pnpm dev:desktop
```

打开桌面端 → **部署中心**：

1. 在「设置 → 工作区」选一个本地目录
2. 新建项目，需求写：`做一个客户管理系统，有客户和订单，带后台管理`
3. 点「生成项目」→ 左侧会显示解析出的页面/接口/数据表（先确认理解正确）
4. 点「构建检查」→ 验证入口文件、无密钥泄露、体积合理
5. 平台选「本地预览」→ 一键部署 → 拿到 `http://127.0.0.1:43xx` 并能在浏览器打开

配好 `VERCEL_TOKEN` 之类凭据后，把平台换成 Vercel 就是真实上线。

### Phase 3 测试覆盖

```
438 个服务端用例（含 Phase 1/2 的 245 个全部保留通过）
├── deploy/phase3.test.ts       26  需求解析 / 文件生成 / 密钥扫描 / 打包 / 域名 / 闸门
├── database/phase3.test.ts     28  加密存储 / SQL 静态校验 / Schema / RLS / 适配器降级 / 备份
├── dashboard/phase3.test.ts    18  7 类组件注册 / 自然语言推断 / 布局引擎 / 快照回滚 / 数据源降级
├── schedule/phase3.test.ts     33  cron 解析与描述 / 时区 nextRun / 模板 / 执行器 / 指数退避
├── notify/phase3.test.ts       21  6 渠道校验 / 真实 HTTP 发送（本地假服务）/ 签名 / 超时
├── test/phase3-e2e.test.ts     36  生成→构建→部署→域名 / 看板→组件→刷新 / 任务→执行→推送
├── test/phase3-security.test.ts 20 凭据不落明文 / 危险动作全覆盖 / SQL 注入 / 路径穿越 / 监听地址
└── test/phase3-perf.test.ts     9  cron 计算 / 200 组件布局 / 并发上限 / 刷新扫描
```

运行：`pnpm test` / `pnpm --filter @ai/server test:phase3` / `pnpm verify:rollback`

### 文档

| 文档 | 内容 |
| --- | --- |
| [docs/phase3-architecture.md](docs/phase3-architecture.md) | 架构增量、7 个关键设计决策、目录结构、端到端数据流 |
| [docs/phase3-data-model.md](docs/phase3-data-model.md) | 13 张新表逐字段说明、与 Phase 1/2 的兼容处理、迁移与回滚 |
| [docs/phase3-api.md](docs/phase3-api.md) | 全部接口（含请求/响应示例、错误码、WS 事件表） |
| [docs/phase3-runbook.md](docs/phase3-runbook.md) | 部署/数据库/定时任务/通知的配置手册 + 常见问题 |
| [docs/phase3-rollback.md](docs/phase3-rollback.md) | L1~L5 分级回滚策略 + 各 Step 独立回滚 |

### 打包上传 GitHub

```bash
# 打包（自动扫描凭据，命中即中止）
./scripts/package-for-github.sh

# 创建私人仓库并推送（Token 只从环境变量读，不写入 git 配置、不回显）
GITHUB_TOKEN=ghp_xxx ./scripts/upload-github.sh --repo ai-workbench
```

---

## Phase 4：生态、集群与提示词工程

Phase 4 把工作台从「个人工具」推向「可协作的平台」：插件生态、付费数据、提示词工程、多节点集群、企业安全。

### 能做什么

**精选插件（MCP 优先）**
- 插件市场：10 个精选插件，含 4 个 MCP 服务器 + 6 个数据源接入
- 清单规范：`permissions` / `tools` / `resources` / `prompts` / `signature`
- **逐项授权**：默认不授予任何权限，可设过期时间，可随时撤销
- **沙箱**：网络/文件/资源受限；拒绝内网与云元数据地址（SSRF 防护）
- **防篡改**：manifest 存快照 + 哈希；内容变更强制重新授权（防权限静默提升）
- **调用日志**：成功/失败/被拒全部留痕，入参自动脱敏

**付费数据库（8 家，全部合规）**

| 同花顺 · 天眼查 · Wind 万得 · 恒生聚源 · 标普全球 · IMF · 华宇元典 · 学术数据库 |
| --- |

- 只走**官方 API 或你本机已授权的终端**；无爬虫、无共享账号、无登录态绕过
- 合规守卫拦截「绕过限流 / 爬虫 / 全量导出 / 共享账号 / 破解」类请求，**拒因可读且落库**
- 三道防线：注册表声明约束 → 合规守卫 → 本地限流 + 审计
- 未配置凭据时**显式降级**（`degraded: true` + 说明），不返回假数据、不抛 500

**提示词工程**
- 九要素结构 + 变量占位符（类型推断 / 必填 / 默认值）
- 9 个预置模板（代码评审 / 需求分析 / 深度调研 / 数据分析 / 任务规划 / 内容写作 / 部署方案 / 多 Agent 编排 / 提示词评审）
- 生成器 + 优化器：**规则优先，模型增强**（无密钥也能用，结果可复现）
- 优化覆盖：消除歧义 · 补全约束 · 结构化 · 边界条件 · 失败处理 · 评估标准
- 版本管理 + 回滚（回滚生成新版本，历史全保留）
- A/B 测试：人工指标（准确性/清晰度/可用性）+ 自动指标（结构/长度/变量覆盖）
- **样本不足时不给确定结论** —— 宁可不给，也不给错

**实验性集群**
- 节点注册 / 心跳 / **确定性选举**（可复现、可解释）/ 任务分片 / 负载感知分发
- 容错：节点失联改派、失败重试（限额）、已完成分片永不重跑
- 资源治理：`maxNodes` / `maxParallelTasks` / `resourceLimits` / `heartbeatTimeoutMs`
- **降级单机**：集群不可用时任务照样跑完，并明确告知原因与恢复方式
- 分片策略自动选择：分布均匀用 `by-count`，有超大项用 `by-weight`（LPT 贪心）

**多 Agent 并行**
- Agent 池（按角色，min/max 区间，缩容拒绝驱逐运行中实例）
- 任务 DAG（环检测给出版路径、拓扑分层、就绪/阻塞计算）
- 并行度决策：`min(工作区配置, 集群策略, 池容量, 预算, CPU 核数, 就绪数)` + **可解释的 factors**
- 路由：模型（成本/上下文/擅长领域）、工具（关键词）、Agent（角色匹配 + 容量）
- 结果聚合：majority / priority / concat / manual —— **冲突显式记录，平票不裁决**
- 成本控制：按模型价格表计量、预算预警、超限暂停并行

**企业安全与审计**
- RBAC：20 个权限点、6 个内置角色、多角色取并集、**owner 不可锁死**
- SSO（OIDC/SAML）：只接受环境变量名、state+nonce 防 CSRF/重放、密钥缺失拒绝启用
- 审计日志：全量操作留痕、**危险但未确认的记录单独告警**
- 合规导出：强制脱敏、必须带时间范围、**导出行为本身也留痕**；修复了「静默截断 90% 数据」的真实缺陷
- 数据脱敏：full/partial/hash/nullify + **递归处理嵌套结构** + 内置兜底策略
- 保留策略：**默认预演**、核心表禁止配置（防删库）

### 安全底线（硬约束，无开关可关）

1. **35 类危险操作服务端强制二次确认**，无 confirm 返回 `428 CONFIRM_REQUIRED` + 人类可读后果
2. **凭据不落明文**：源码 / 日志 / DB / 审计 / 接口响应全部无明文；AES-256-GCM 加密；换密钥后解密失败会明确报错
3. **SSRF 防护**：插件 endpoint、MCP 服务器、集群节点统一拒绝内网与云元数据地址
4. **路径边界**：文件访问必须落在工作区内 + 命中授权前缀；**路径穿越直接拒绝（不静默修正）**
5. **插件不可信**：清单外工具拒绝、未授权拒绝、危险工具需确认、所有调用留痕
6. **合规不妥协**：不绕过反爬/风控、不用共享账号、不代注册账号、不代理登录
7. **降级要诚实**：拿不到数据就说拿不到，不返回 0 或空对象让调用方误判

### 快速体验（无需任何密钥）

```bash
pnpm install --ignore-scripts && pnpm rebuild better-sqlite3
pnpm typecheck && pnpm test
pnpm dev:server && pnpm dev:desktop
```

打开桌面端 → **插件市场**：

1. 搜「文件」→ 安装 `mcp-filesystem` → 在弹出的权限对话框里勾选 `fs:read`
2. 切到 **付费数据库** → 选「IMF（无需凭据）」→ 直接查询全球宏观数据
3. 切到 **提示词工作台** → 从模板库选「深度调研」→ 生成 → 优化 → 保存两个版本 → 建 A/B 测试
4. 切到 **集群视图** → 点「注册本机节点」→ 看到节点上线、leader 选出、term=1
5. 切到 **安全中心** → 看审计日志里刚才的全部操作

### Phase 4 测试覆盖

```
src/plugins/phase4.test.ts      33  清单合规 / 哈希幂等 / 沙箱策略 / 安装授权撤销 / 调用日志脱敏 / MCP
src/paidData/phase4.test.ts     33  注册表自洽 / 合规守卫 / 缓存 TTL / 查询降级 / 凭据加密 / 8 个适配器
src/prompt/phase4.test.ts       31  变量渲染 / 意图分类 / 生成 / 优化 / 模板库 / 版本回滚 / A/B 判定
src/cluster/phase4.test.ts      39  分片均衡 / 节点注册 / 心跳超时 / 改派重试 / 选举 / 策略 / 降级 / 管理器
src/agents/phase4.test.ts       48  DAG 环检测 / 并行度 / 路由 / 聚合冲突 / 成本 / 池扩缩容 / 编排
src/enterprise/phase4.test.ts   38  RBAC / 脱敏 / 审计 / 保留策略 / SSO / 合规包 / 导出越权
test/phase4-e2e.test.ts          9  插件全链路 / 付费数据 / 提示词 / 集群 / 编排 / 企业安全 / 无凭据可跑通
test/phase4-security.test.ts    25  危险动作全覆盖 / 凭据不落明文 / SSRF / 越权 / 注入 / 并发
test/phase4-perf.test.ts        16  10000 项分片 / 1000 节点 DAG / 20000 条成本汇总 / 5000 条导出
```

运行：`pnpm test` / `pnpm verify:phase4`

### Phase 4 文档

| 文档 | 内容 |
| --- | --- |
| `docs/phase4-architecture.md` | 架构增量、7 条关键设计决策、端到端数据流、兼容处理 |
| `docs/phase4-data-model.md` | 29 张新表逐字段说明、保留字陷阱、表清单 |
| `docs/phase4-api.md` | 约 90 个接口 + 错误码 + WS 事件表 |
| `docs/phase4-plugin-development.md` | 清单规范、合规红线自查、签名、沙箱约束、调试方法 |
| `docs/phase4-paid-data-compliance.md` | 8 家数据源接入方式、三道合规防线、凭据保管、自查清单 |
| `docs/phase4-cluster-runbook.md` | 集群部署、心跳、选举、分发、容错、监控、FAQ |
| `docs/phase4-prompt-engineering.md` | 九要素、变量、生成器、优化器、版本、A/B 判定规则 |
| `docs/phase4-security-audit.md` | 信任边界、35 类危险动作、凭据保护、SSRF、RBAC、脱敏、审计 |
| `docs/phase4-rollback.md` | L1~L5 分级回滚 + 各 Step 独立回滚矩阵 + 验证清单 |

---

## Phase 5：桌面版壳层（功能集合与桌面 UI）

> 把 Phase 1~4 的 17 个功能收进一个真正的桌面应用外壳：侧边栏 + 多标签工作区 + 命令面板 + 状态栏。

### 解决的问题

| 之前 | 现在 |
| --- | --- |
| 17 个入口平铺一长条，无分组无搜索 | 5 组可折叠侧边栏 + `Ctrl/Cmd+K` 中英关键词搜索 |
| 跨页对比要来回点，回不去 | 多标签工作区，`Ctrl/Cmd+W` 关闭、`Ctrl/Cmd+Tab` 轮换、`Ctrl/Cmd+1..9` 直选 |
| 手写 if/else 导航，加页面易漏改 | `nav-config` 唯一数据源 + `Record<TabKey, ComponentType>` 类型安全注册表 |
| 部分页面没有标题，不知道用途 | 统一页头：功能名 + 一句话用途 + 右侧动作 |
| 状态下沉在各页面，无处看全局 | 底部状态栏：连接 / 降级 / Agent 数 / 工作区目录 / 当前功能 |
| 每次打开都从默认页开始 | 标签、侧边栏形态、分组折叠、最近使用全部持久化 |

### 功能集合（17 项 / 5 组）

```
工作台        对话 · 目标模式 · 看板编辑器 · 文件工作区 · Office 工作区 · 深度研究
智能体        记忆面板 · Agent 集群 · 多节点集群 · 提示词工作台
交付与自动化  部署中心 · 数据库面板 · 付费数据库 · 定时任务 · 通知设置
生态与集群    插件市场 · 安全中心
系统          设置
```

### 目录

```
packages/desktop/src/
  nav/nav-config.ts              功能清单（唯一数据源）+ 命令面板搜索
  pages/registry/index.tsx       功能 → 页面组件（类型安全）
  components/shell/              Sidebar · TabBar · tab-state · CommandPalette
                                 StatusBar · PageHeader · use-shell
  App.tsx                        仅负责组装
```

### 快捷键

| 快捷键 | 动作 |
| --- | --- |
| `Ctrl/Cmd + K` | 打开命令面板 |
| `Ctrl/Cmd + W` | 关闭当前标签（自动激活邻居） |
| `Ctrl/Cmd + Tab` | 标签轮换（`Shift` 反向） |
| `Ctrl/Cmd + 1..9` | 直选第 N 个标签 |
| 鼠标中键 | 关闭标签 |

### 测试

`nav-config.test.ts` 是**功能集合的守门测试**：17 个能力逐个断言存在，key 唯一，每项必须有分组/图标/关键词/说明。
意义不是覆盖率，而是防止功能悄悄从导航消失 —— 用户看不到入口 = 功能不存在。

`tab-state.test.ts` 覆盖标签栏纯逻辑：重复打开不重复、关闭优先右邻居/末尾回退、关最后一个保留兜底页。

```
pnpm --filter @ai/desktop test      # 22 通过
pnpm --filter @ai/desktop build     # 447.53 kB / gzip 130.99 kB
```

### 文档

`docs/desktop-shell.md`：分层结构、桌面手感清单、视觉 token、测试说明、已下线简版页面清单。

### 已下线的 4 个简版页面

`DashboardPage` / `SchedulePage` / `PluginsPage` / `PromptPage` 从导航移除（文件保留、可回滚），
能力由 Phase 3/4 的正式页面完整承担，避免出现两套入口让用户不知道该点哪个。
