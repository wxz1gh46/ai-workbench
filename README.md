<div align="center">

# AI 工作台 · AI Workbench

**你定义方向，它完成全过程。你验收结果，它持续进化。**

桌面 AI 工作台：给定目标，系统自主规划、多 Agent 并行执行、调用工具、处理文件、部署网站、定时推送，最终交付完整成果。

[![CI](https://github.com/wxz1gh46/ai-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/wxz1gh46/ai-workbench/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen.svg)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-9.12.0-orange.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-732%20passing-success.svg)](#测试)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[快速开始](#快速开始) · [功能总览](#功能总览) · [架构](#核心架构) · [文档](#文档) · [贡献指南](CONTRIBUTING.md)

</div>

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

## 这是什么

一个**本地优先**的桌面 AI 工作台。不是聊天窗口套壳，而是一套完整的 Agent 运行时：

- **目标驱动**：你写一段目标，它拆成任务 DAG 并并行执行，最后用目标本身做验收审计。
- **本地优先**：数据存在你机器上的 SQLite，密钥只从环境变量 / OS Keychain 读，不经过任何中转服务器。
- **离线可跑**：不配置任何模型密钥也能跑通全链路——系统进入**离线兜底模式**，所有降级结果显式标注 `degraded`，不会静默冒充真实输出。
- **合规红线硬编码**：不实现绕过反爬、验证码、共享账号、破解授权的能力；付费数据源凭据一律由用户手动配置。

## 功能总览

| 能力 | 说明 |
| --- | --- |
| 🎯 **目标模式** | 目标即验收标准。`Planner → TaskQueue(DAG) → Executor → Critic` 闭环，支持反思、重试与停滞检测 |
| 🧠 **百万 Token 上下文** | 六分区 Token 预算、滚动摘要、事实抽取、向量 + 关键词混合召回、全程溯源 |
| 🤖 **多 Agent 并行** | 9 个内置角色 Agent、任务 DAG 并行调度、任务看板、运行追踪 |
| 📄 **Office 处理** | docx / xlsx / pptx / pdf / markdown 解析、OOXML 原地编辑、生成、可选 LibreOffice 转换 |
| 🔍 **深度研究** | robots.txt 合规抓取、多源交叉验证、引用一致性校验、Mermaid 图表、结构化报告 |
| 🚀 **网站部署** | 自然语言 → 页面 + 后端 API + 数据库 Schema；支持 Vercel / Cloudflare Pages / Netlify / 本地预览 |
| 🗄️ **数据库接入** | Neon / Supabase 连接测试、Schema 生成、版本化迁移（可回滚）、只读查询、备份 |
| 📊 **定制看板** | 自然语言建 7 类小组件、拖拽布局、布局回滚、固定到桌面、实时刷新 |
| ⏰ **定时任务** | Cron（含时区）/ 周期 / 一次性 + 6 类任务 + 模板 + 日志 + 指数退避重试 |
| 🔔 **推送通知** | 桌面 / 邮件 / Webhook / 飞书 / 钉钉 / 企业微信 + 发送日志 + 重试 |
| 🔌 **插件市场** | MCP 优先，安装 / 授权 / 沙箱 / 调用日志，manifest 合规校验 |
| ✍️ **提示词工程** | 九要素结构化生成、优化器、版本管理、A/B 测试、效果评估 |

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
## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Tauri 2（Rust） |
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS + React Grid Layout + Zustand |
| 后端 | Node.js + TypeScript + Hono |
| 数据 | SQLite + Drizzle ORM（本地）／Postgres + Neon / Supabase（云端） |
| 实时 | WebSocket `/events` + 本地事件总线（环形缓冲回放） |
| 文档 | docx / exceljs / pptxgenjs / pdf-lib / 自研零依赖 ZIP |
| 测试 | `node:test`（单元 + 集成 + 端到端） |

## 快速开始

### 环境要求

- Node.js ≥ 20（开发用 24）
- pnpm ≥ 9
- 可选：Rust 1.77+（构建桌面壳）、LibreOffice（Phase 2 文档转换）
- Node.js ≥ 22.6（测试用 `node:test` 的 `--experimental-transform-types` 需要；CI 使用 22）
- pnpm ≥ 9
- 可选：Rust 1.77+（构建原生桌面壳）、LibreOffice（跨格式转换）

### 1. 安装

```bash
git clone https://github.com/wxz1gh46/ai-workbench.git
cd ai-workbench
pnpm install
cp .env.example .env
```

> `better-sqlite3` 需要编译。Debian/Ubuntu：
> `better-sqlite3` 需要原生编译。Debian/Ubuntu：
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
### 4. 配置模型（可选）

不配置也能跑：系统进入**离线兜底模式**，目标是「流程完整、结果占位」，UI 会明确提示。

配置真实模型（兼容 OpenAI 协议，也可指向本地 Ollama）：

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
未设置工作目录时，所有文件 / Office 工具会被拒绝（安全默认）。

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
pnpm test                 # 全部（单元 + 集成 + 端到端）
pnpm typecheck            # 三个包的类型检查
pnpm lint                 # 当前等同 typecheck
```

分能力测试：

```bash
pnpm test:context                       # 分层上下文
pnpm test:security                      # 安全与权限
pnpm --filter @ai/server test:phase3    # Phase 3 全量
pnpm --filter @ai/server test:goals     # 目标模式
pnpm --filter @ai/server test:office    # Office 处理
pnpm --filter @ai/server test:research  # 深度研究
pnpm --filter @ai/server verify:phase4  # Phase 4 硬约束验收
pnpm perf:million                       # 百万 token 规模验证
```

**当前覆盖**：**732 个用例全部通过**（server 710 + desktop 22，覆盖 Phase 1~5 全量）。

不配置任何密钥即可跑通全链路：模型走离线兜底、部署走本地预览、通知写桌面 outbox、付费数据显式降级。

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
| POST | `/research` | 深度研究 |
| POST | `/website/deploy` | 网站部署（需 confirm） |
| POST/GET/PATCH | `/schedule` | 定时任务 |
| GET/POST/DELETE | `/plugins` | 插件市场与安装 |
| POST | `/prompt/optimize` | 提示词九要素生成 |
| GET/POST/PATCH/DELETE | `/widgets` | 看板小组件 |
| GET | `/audit` | 审计日志 |
| GET | `/events/recent` | 事件回放 |
| WS | `/events` | 实时事件订阅 |

统一响应格式：

```jsonc
// 成功
{ "ok": true, "data": { }, "traceId": "..." }
// 失败
{ "ok": false, "error": { "code": "...", "message": "...", "details": { }, "traceId": "..." } }
```

## 数据模型

核心实体（全部落地在 SQLite，随 Phase 增量扩展）：

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

## 阶段进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **Phase 1 MVP** | 桌面壳 · 聊天 · 模型接入 · SQLite · 文件上传 · 基础 Agent · 基础设置 | ✅ 已交付 |
| **Phase 2 核心能力** | 目标模式 · 多 Agent 并行 · Office 处理 · 深度研究 · 百万 Token 上下文 | ✅ 已交付（联网语义召回待补） |
| **Phase 3 交付与自动化** | 网站部署 · Neon/Supabase · 定制看板 · 定时任务 · 推送通知 | ✅ 已交付 |
| **Phase 4 生态与集群** | 实验性集群 · 精选插件 · 付费数据库 · 提示词工程 · 企业安全审计 | ✅ 已交付（MCP stdio 宿主进程、真实数据源联调待补） |
| **Phase 5 桌面壳层** | 侧边栏分组 · 多标签工作区 · 命令面板 · 状态栏 · 17 项功能统一入口 | ✅ 已交付 |

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 整体架构与数据流 |
| [docs/desktop-shell.md](docs/desktop-shell.md) | Phase 5 桌面壳层：分层结构、快捷键、测试说明 |
| [docs/phase2-3-overview.md](docs/phase2-3-overview.md) | Phase 2/3 目录增量与运行命令 |
| [docs/phase2-architecture.md](docs/phase2-architecture.md) · [data-model](docs/phase2-data-model.md) · [api](docs/phase2-api.md) · [runbook](docs/phase2-runbook.md) | Phase 2 架构 / 数据模型 / 接口 / 运行手册 |
| [docs/phase3-architecture.md](docs/phase3-architecture.md) · [data-model](docs/phase3-data-model.md) · [api](docs/phase3-api.md) · [runbook](docs/phase3-runbook.md) · [rollback](docs/phase3-rollback.md) | Phase 3 架构 / 数据模型 / 接口 / 运行手册 / 回滚 |
| [docs/phase4-architecture.md](docs/phase4-architecture.md) · [data-model](docs/phase4-data-model.md) · [api](docs/phase4-api.md) · [rollback](docs/phase4-rollback.md) | Phase 4 架构 / 数据模型 / 接口 / 回滚 |
| [docs/phase4-plugin-development.md](docs/phase4-plugin-development.md) · [paid-data-compliance](docs/phase4-paid-data-compliance.md) · [cluster-runbook](docs/phase4-cluster-runbook.md) · [prompt-engineering](docs/phase4-prompt-engineering.md) · [security-audit](docs/phase4-security-audit.md) | Phase 4 专项：插件开发 / 付费数据合规 / 集群运维 / 提示词工程 / 安全审计 |
| [DECISIONS.md](DECISIONS.md) | 架构决策记录（ADR），含全部已修复缺陷的过程记录 |

## 回滚方案

- **代码**：每一阶段独立提交，`git revert <commit>` 即可回滚。
- **数据库**：每个迁移都有配套 `.down.sql`（`0001_init` / `0002_phase2` / `0003_phase3` / `0004_phase4`）。
- **功能开关**：`packages/server/src/config.ts` 中的 `features.*` 可独立关闭各能力，**数据全保留**。
- **数据本身**：删除 `data/` 目录即可回到初始状态（本地单机，无外部依赖）。
- **配置**：`.env` 不纳入版本控制，回滚代码不影响用户配置。

```bash
pnpm --filter @ai/server db:rollback       # 回滚最后一个迁移
pnpm --filter @ai/server verify:rollback   # 验证 Phase 2/3 迁移回滚
pnpm --filter @ai/server verify:phase3
pnpm --filter @ai/server verify:phase4     # Phase 4 全部硬约束（含 0004 回滚）
```

详见 [docs/phase3-rollback.md](docs/phase3-rollback.md) 与 [docs/phase4-rollback.md](docs/phase4-rollback.md)。

## 贡献

欢迎贡献！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

提交前请确保：

```bash
pnpm typecheck && pnpm test
```

## 许可证

本项目基于 [MIT License](LICENSE) 开源。

<div align="center">

**[⬆ 回到顶部](#ai-工作台--ai-workbench)**

</div>
