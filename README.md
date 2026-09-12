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
| **Phase 3 交付与自动化** | 网站部署 · Neon/Supabase · 定制看板 · 定时任务 · 推送通知 | 🟡 看板/定时任务已完成；部署与推送待做 |
| **Phase 4 生态与集群** | 实验性集群 · 精选插件 · 付费数据库 · 提示词工程 · 企业安全审计 | 🟡 插件市场/提示词/审计已完成；跨机集群与真实数据源对接待做 |

---

## 回滚方案

- **代码**：每一阶段独立 PR，`git revert <merge-commit>` 即可回滚
- **数据库**：`packages/server/src/db/migrations/0001_init.down.sql` 提供完整反向脚本
- **数据本身**：删除 `data/` 目录即可回到初始状态（本地单机，无外部依赖）
- **配置**：`.env` 不纳入版本控制，回滚代码不影响用户配置

---

## 下一步建议

1. **Phase 2 收尾**：接入 LanceDB 做真语义召回；用 LLM 自动触发滚动摘要
2. **Phase 2 收尾**：LibreOffice headless 转换解决 CJK PDF 排版
3. **Phase 3**：实现 Vercel / Cloudflare Pages Provider 适配器与 Neon 编排
4. **Phase 3**：推送渠道（桌面通知 / 邮件 / Webhook / 飞书 / 钉钉 / 企业微信）
5. **Phase 4**：跨机集群调度（BullMQ + Redis）、MCP 插件宿主进程隔离


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
pnpm typecheck && pnpm test          # 438 服务端 + 4 桌面用例
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
