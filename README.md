<div align="center">

# AI 工作台 · AI Workbench

**你定义方向，它完成全过程。你验收结果，它持续进化。**

桌面 AI 工作台：给定目标，系统自主规划、多 Agent 并行执行、调用工具、处理文件、部署网站、定时推送，最终交付完整成果。

[![CI](https://github.com/wxz1gh46/ai-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/wxz1gh46/ai-workbench/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen.svg)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-9.12.0-orange.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-438%20passing-success.svg)](#测试)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[快速开始](#快速开始) · [架构](#核心架构) · [文档](#文档) · [路线图](#路线图) · [贡献指南](CONTRIBUTING.md)

</div>

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

## 测试

```bash
pnpm test                 # 全部（单元 + 端到端）
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
pnpm perf:million                       # 百万 token 规模验证
```

**当前覆盖**：438 个服务端用例 + 4 个桌面端用例，全部通过。

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
`Website` `DatabaseConnection` `Schedule` `ScheduleRun` `Widget`
`Plugin` `PluginCallLog` `PromptTemplate` `AuditLog` `NotificationChannel`

关键设计：

- **多工作区**：所有业务表带 `workspace_id`，级联删除。
- **任务依赖**：`tasks.depends_on` 存 JSON 数组，运行时校验无环。
- **运行追踪**：`agent_runs` 记录 prompt 摘要、模型、输入/输出 token、成本。
- **文件版本**：`files.version` + `file_versions` 保留每次内容快照。
- **审计**：`audit_logs.dangerous` / `confirmed_by_user` 双列留痕。

## 合规与安全约定

以下约束**写进代码并有单测覆盖**，不是口头承诺：

1. 密钥只从环境变量 / Keychain 读取，代码与数据库不存明文。
2. 付费数据源插件（同花顺 / 天眼查 / Wind / 恒生聚源 / S&P Global / IMF / 华宇元典 / 学术库）必须 `requiresUserAuth = true`，凭据由用户手动配置。
3. 插件 manifest 中出现「绕过反爬 / 绕过验证码 / 共享账号 / 破解授权」直接拒绝安装。
4. 文件工具限定在 `workspace.rootPath` 内，拒绝路径穿越。
5. 危险操作在工具层与路由层双重拦截，且必须留审计。
6. 本地预览服务只监听 `127.0.0.1`，不暴露到局域网。

安全问题请勿公开提交 Issue，请走 [SECURITY.md](SECURITY.md) 中的私下渠道。

## 项目结构

```
ai-workbench/
├── packages/
│   ├── shared/        # 前后端共享：数据模型 / 事件协议 / API 契约 / 常量
│   ├── server/        # Node + TypeScript 后端（Agent Runtime）
│   │   └── src/
│   │       ├── agent/      # 目标编排、DAG、模型路由、记忆
│   │       ├── context/    # 百万 Token 分层上下文
│   │       ├── goals/      # 目标模式引擎
│   │       ├── office/     # Office 处理
│   │       ├── research/   # 深度研究
│   │       ├── deploy/     # 网站生成与部署
│   │       ├── database/   # Neon / Supabase / Postgres
│   │       ├── dashboard/  # 定制看板
│   │       ├── schedule/   # 定时任务
│   │       ├── notify/     # 推送通知
│   │       ├── tools/      # 工具注册表 + 权限门
│   │       ├── security/   # 密钥与危险操作闸门
│   │       └── db/         # Drizzle schema + 迁移（含 down 脚本）
│   └── desktop/       # Tauri 2 + React + Vite 桌面端
├── docs/              # 架构 / 接口 / 数据模型 / 运行手册 / 回滚方案
├── scripts/           # 打包与上传脚本
├── DECISIONS.md       # 架构决策记录（含真实缺陷复盘）
└── CHANGELOG.md
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 总体架构图与数据流 |
| [docs/phase2-architecture.md](docs/phase2-architecture.md) | Phase 2 架构增量与关键设计决策 |
| [docs/phase2-data-model.md](docs/phase2-data-model.md) | Phase 2 数据模型 |
| [docs/phase2-api.md](docs/phase2-api.md) | Phase 2 接口文档 |
| [docs/phase2-runbook.md](docs/phase2-runbook.md) | Phase 2 运行手册 |
| [docs/phase3-architecture.md](docs/phase3-architecture.md) | Phase 3 架构增量与端到端数据流 |
| [docs/phase3-data-model.md](docs/phase3-data-model.md) | Phase 3 的 13 张新表逐字段说明 |
| [docs/phase3-api.md](docs/phase3-api.md) | Phase 3 全部接口 + WS 事件表 |
| [docs/phase3-runbook.md](docs/phase3-runbook.md) | 部署 / 数据库 / 定时 / 通知配置手册 |
| [docs/phase3-rollback.md](docs/phase3-rollback.md) | L1~L5 分级回滚策略 |
| [docs/phase2-3-overview.md](docs/phase2-3-overview.md) | Phase 2/3 目录增量与运行命令 |
| [DECISIONS.md](DECISIONS.md) | 架构决策记录（ADR） |

## 回滚方案

- **代码**：每一阶段独立提交，`git revert <commit>` 即可回滚。
- **数据库**：每个迁移都有配套 `.down.sql`，`pnpm db:rollback 0003_phase3.sql`。
- **功能开关**：`packages/server/src/config.ts` 中的 `features.*` 可独立关闭各能力。
- **数据本身**：删除 `data/` 目录即可回到初始状态（本地单机，无外部依赖）。
- **配置**：`.env` 不纳入版本控制，回滚代码不影响用户配置。

详见 [docs/phase3-rollback.md](docs/phase3-rollback.md)。

## 路线图

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **Phase 1** MVP | 桌面壳 · 聊天 · 模型接入 · SQLite · 文件上传 · 基础 Agent · 基础设置 | ✅ 已交付 |
| **Phase 2** 核心能力 | 目标模式 · 多 Agent 并行 · Office 处理 · 深度研究 · 百万 Token 上下文 | ✅ 已交付 |
| **Phase 3** 交付与自动化 | 网站部署 · Neon/Supabase · 定制看板 · 定时任务 · 推送通知 | ✅ 已交付 |
| **Phase 4** 生态与集群 | 实验性集群 · 精选插件 · 付费数据库 · 提示词工程 · 企业安全审计 | 🚧 进行中 |

Phase 4 计划：

1. 插件系统与 MCP（市场 / 安装 / 授权 / 沙箱 / 签名 / 调用日志）
2. 付费数据库插件（同花顺 / 天眼查 / Wind / 恒生聚源 / S&P / IMF / 华宇元典 / 学术库）
3. AI 提示词生成与优化（模板 / 变量 / 生成器 / 优化器 / A-B / 版本 / 评估）
4. 实验性集群（节点注册 / 心跳 / 选举 / 分片 / 容错 / 降级单机）
5. 多 Agent 并行强化（Agent 池 / DAG / 模型路由 / 结果聚合 / 冲突解决 / 成本控制）
6. 企业安全与审计（RBAC / SSO / 审计 / 脱敏 / 合规导出 / 保留策略）

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
