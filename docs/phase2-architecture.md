# Phase 2 架构说明（核心能力实现）

> 本文档描述 Phase 2 新增的分层架构、数据流与关键设计决策。
> Phase 1 基础架构见 [architecture.md](./architecture.md)。

---

## 1. 架构增量图

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 客户端层  Tauri 2 + React + Zustand + Tailwind                            │
│  Phase 2 页面：目标模式 │ Agent 集群 │ Office 工作区 │ 深度研究 │ 记忆面板   │
│  Phase 2 组件：ProgressTree │ TokenBudgetBar │ TaskBoard │ AgentNode       │
└────────────┬─────────────────────────────────────────┬───────────────────┘
             │ REST /api                               │ WS /events
┌────────────▼─────────────────────────────────────────▼───────────────────┐
│ Agent 运行时                                                              │
│                                                                          │
│  goals/GoalEngine ──▶ goals/reflection ──▶ goals/audit                   │
│      │  每轮落 GoalRun       修正策略          逐条对齐验收标准           │
│      │                       (重试/换角色/     并给出证据                 │
│      │                        换工具/授权/放弃)                           │
│      ▼                                                                   │
│  agent/Executor ──▶ tools/ToolRegistry（权限门 + 审计 + 追踪）            │
│      ▲                                                                   │
│      │  并行限流 + Agent 池                                               │
│  goals/goalEngine（并发上限 / 集群模式 / 消息总线 / 任务板）              │
└────────────┬─────────────────────────────────────────────────────────────┘
             │
┌────────────▼─────────────────────┐  ┌──────────────────────────────────┐
│ context/ContextManager           │  │ office/OfficeService             │
│  分层上下文（百万 token）         │  │  docx/xlsx/pptx/pdf 读写编辑      │
│  ├ summarizer  滚动摘要           │  │  parse → 原地改 OOXML / exceljs   │
│  ├ factExtractor 事实抽取         │  │  edit  → 保留未触及部分           │
│  ├ vectorRecall 向量+关键词召回    │  │  converter → LibreOffice（可选）  │
│  ├ tokenBudget 六分区预算         │  │  versioning → 版本历史与回滚      │
│  └ embedding   本地/远端向量       │  │  export → 带 TTL 的下载 URL       │
└────────────┬─────────────────────┘  └──────────────────────────────────┘
             │
┌────────────▼─────────────────────┐  ┌──────────────────────────────────┐
│ research/ResearchEngine          │  │ 数据层 SQLite + Drizzle          │
│  11 步：查询→检索→抓取→提取→验证   │  │  0002_phase2 迁移（可独立回滚）   │
│  →分析→提纲→报告→引用→图表→导出   │  └──────────────────────────────────┘
│  robots.txt 合规 │ 冲突标记 │ 发布 │  ┌──────────────────────────────────┐
└──────────────────────────────────┘  │ 安全层 路径边界/权限门/审计/TTL   │
                                      └──────────────────────────────────┘
```

---

## 2. 关键设计决策

### 2.1 向量召回为什么自研而不是直接上 LanceDB/Qdrant

- Phase 2 验收要求「有检索、有溯源」，SQLite + 内存向量在百万 token 量级仍可接受；
- 零外部依赖 → 离线可跑、可单测、CI 无需额外服务；
- 接口设计为 `RecallCandidate[] → RecallHit[]`，替换为 LanceDB/Qdrant 只需换实现，调用方不变；
- 配置 `AI_EMBEDDING_MODEL` 时优先走远端 embedding，失败自动回落本地（不阻塞主流程）。

> 代价：本地 embedding 是 hashing trick + n-gram 近似语义，不是深度语义。
> 因此召回额外并联一路**关键词召回**（对编号/专有名词敏感），两路融合后再按预算截断。

### 2.2 摘要与事实为什么「规则先行、模型补充」

模型不可用（未配置密钥）时产品必须仍可用，且**不能静默冒充真实输出**：

| 能力 | 无模型时 | 有模型时 |
| --- | --- | --- |
| 滚动摘要 | 确定性抽取式摘要（按句式特征分桶：决策/约束/未决/事实） | 模型摘要，强制固定小节结构 |
| 事实抽取 | 规则正则（偏好/约束/决策/指标） | 规则 + 模型 JSON，按类型+键+值去重 |
| 完成审计 | 确定性规则（任务状态 + 标准匹配） | 模型结论，但仍叠加确定性约束 |
| 报告撰写 | 确定性模板（结构完整、引用准确） | 模型润色，且必须通过安全校验 |

**审计的硬约束**：任务失败时，即使模型判定「通过」，审计结论仍为不通过。
理由：事实判定不能交给可能幻觉的模型，模型只做措辞。

### 2.3 报告润色的安全校验（防幻觉）

模型润色输出必须同时满足：

1. 引用编号集合与原稿**完全一致**（不丢不加）；
2. mermaid 代码块数量不减少；
3. 原稿含冲突标记时，润色稿必须仍含（⚠️/冲突）；
4. 长度不低于原稿 50%（防截断）、不低于 200 字符。

任一条不满足 → 丢弃润色结果，使用确定性稿。

### 2.4 Office 编辑为什么「原地改 OOXML」而不是重新生成

验收要求「编辑后格式不破坏」：

- `docx`：只改 `<w:t>` 文本节点、只在 `sectPr` 前插段落 → 样式/图片/页眉页脚/批注全保留；
- `pptx`：只新增页，并把新页合并进原包（同步 `Content_Types` / `presentation.xml` / `rels`）→ 母版与主题保留；
- `xlsx`：exceljs 定向改单元格 → **显式提示**「扩展特性可能丢失」，不隐瞒；
- `pdf`：明确拒绝原地编辑（会破坏交叉引用与数字签名），提示先转 docx。

### 2.5 合规红线（不可配置关闭）

| 约束 | 实现位置 | 验证方式 |
| --- | --- | --- |
| 抓取前必须检查 robots.txt | `research/robots.ts` + `fetch.ts` | 单测断言「未对禁止路径发出请求」 |
| noindex 页面不引用正文 | `research/fetch.ts` | 单测断言 `text === ''` |
| 付费来源不自动抓取、不作证据 | `research/search.ts` + 引擎过滤 | E2E 断言正文不含外部数据、不在 supporting |
| 插件不得绕过反爬/共享账号/破解 | `services/plugin-service.ts` | 单测断言安装被拒绝 |
| 密钥不硬编码 | 全源码扫描测试 | 正则扫描 `sk-*`/`AKIA*`/`ghp_*`/`Bearer` |
| 文件操作限定工作区内 | `tools/fs-tools.ts safeJoin` | 单测断言路径穿越 403 |
| 未配置 rootPath 默认拒绝写 | `officeService` | 单测断言 400 |

---

## 3. 数据流

### 3.1 目标模式一轮（GoalRun）

```
POST /goals/:id/run
  └─ GoalEngine.run → 循环 advance（最多 64 轮）
       ├─ 1. 解析阻塞：依赖失败的 pending → blocked（写原因）
       ├─ 2. 取就绪任务（resolveReady）→ 按 maxParallel 限流
       ├─ 3. 每个任务：claim Agent → Executor.runTask
       │      ├─ 落 agent_runs（prompt 摘要/模型/token）
       │      ├─ 工具调用逐个落 tool_calls（含被拒绝的）
       │      └─ 广播 task-result 到消息总线
       ├─ 4. reflect：重试 / 换角色 / 换工具 / 请求授权 / 放弃
       ├─ 5. 应用可自动恢复的修正（授权类留给用户）
       ├─ 6. 全部终态或停滞 → 审计
       │      ├─ 模型给结论 → buildAuditReport 逐条对齐验收标准
       │      └─ 落 goal_audits（结构化 + Markdown）
       └─ 7. 落 goal_runs（本轮 plan/reflection/taskIds/tokens）
```

停滞检测：比较本轮前后任务状态快照，无变化且仍有未终态任务 → `stalled = true`，交还控制权（不空转）。

### 3.2 分层上下文组装

```
buildContext(conversationId, query)
  ├─ recent   近期原文（最高优先级，绝不摘要最近 12 条）
  ├─ goal     目标 + 验收标准
  ├─ summary  滚动摘要（最新在前）
  ├─ facts    关键事实（按重要度 + 事实级召回提升）
  ├─ retrieval 向量 + 关键词混合召回（排除已作为近期原文的条目）
  └─ file     工作区文件上下文（按传入路径读取）
       ↓
  tokenBudget.assembleContext
    · 每分区不超自身上限
    · 高优先级先分配，剩余额度可被低优先级借用
    · 单条超预算 → 截断并标注来源（不丢弃）
       ↓
  返回 { blocks(含 sourceIds), budget, model, routedByLength }
```

### 3.3 深度研究 11 步

```
create → run
  1  buildQueries          按深度生成互补检索式
  2  search                用户端点（需 allowNetwork）或本地工作区
  3  fetchAll              并发抓取（robots 前置检查 + 限流 + 超时 + 体积上限）
  4  落 research_sources   被拒绝/需授权来源也留痕
  5  crossValidate         论断级数值冲突检测 → research_claims
  6  validationSummary     统计冲突与高置信数
  7  buildOutline          提纲
  8  buildReport           确定性报告 + 模型润色（安全校验）
  9  buildCitations        引用编号（正文编号与文献表强一致）
 10  buildCharts           Mermaid：数值对比 / 置信度分布 / 来源结构
 11  export + publish      md/pdf/pptx 落盘 + 自包含 HTML
```

---

## 4. 事件协议增量

| 事件 | 触发点 | 前端用途 |
| --- | --- | --- |
| `context.compacted` | 压缩完成 | 记忆面板刷新 |
| `context.token-budget` | 预算变化 | Token 条更新 |
| `goal.run` | 每轮结束 | 轮次列表、修正项计数 |
| `goal.progress` | 进度变化 | 进度树刷新 |
| `cluster.mode` | 集群配置变更 | 模式开关回显 |
| `task.board` | 任务板变化 | 看板刷新 |
| `agent.message.direct` | Agent 间消息 | 消息流时间线 |
| `research.progress` | 研究阶段推进 | 研究进度条 |
| `research.source` | 单个来源落地 | 来源列表实时追加 |
| `research.report` | 报告生成/发布 | 报告预览与导出入口 |
| `office.file-changed` | 文件编辑完成 | 预览与版本刷新 |
| `file.version` | 版本回滚 | 版本历史刷新 |

---

## 5. 已知限制

1. **本地 embedding 是近似语义**：精确语义召回建议配置 `AI_EMBEDDING_MODEL` 或后续接 LanceDB。
2. **PDF 文本抽取覆盖有限**：扫描件与 CMap/子集字体无法解析，会返回 warnings（建议配 LibreOffice 或 OCR）。
3. **xlsx 编辑经 exceljs 重写**：极少数扩展特性（部分图表/条件格式）可能丢失，已显式提示。
4. **集群模式仍是单机内多 Agent**：跨机调度需 Phase 4 的 BullMQ + Redis。
5. **`node --test` + better-sqlite3 的批量写入**：必须走 `ContextManager.appendMessages`（复用单个 prepared statement + 事务）；逐条 insert 在千级规模会触发原生断言 abort（已升级 better-sqlite3 13.x，但仍保留批量路径作为正确做法）。
