# Phase 2 数据模型

迁移文件：`packages/server/src/db/migrations/0002_phase2.sql`
回滚脚本：`0002_phase2.down.sql`（`pnpm --filter @ai/server db:rollback 0002_phase2.sql`）

设计原则：
- 只**新增**表与列，不改动、不删除 Phase 1 结构 → 可共存、可独立回滚；
- 多工作区级联删除（`ON DELETE CASCADE`）；
- 所有可追溯的外键都指向真实实体，避免「审计写入因外键失败而 500」（见 §4）。

---

## 1. 新增表

### goal_runs —— 目标推进轮次（可回放）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | `grun_*` |
| goal_id | TEXT FK → goals | 级联删除 |
| iteration | INTEGER | 轮次序号（从 1 开始） |
| status | TEXT | `running` / `succeeded` / `failed` / `cancelled` |
| plan | JSON | 本轮使用的计划 |
| reflection | TEXT | 反思 + 本轮修正动作的文本 |
| audit_report | TEXT | 本轮审计报告（Markdown） |
| task_ids | JSON | 本轮实际派发的任务 id |
| tokens_used | INTEGER | 本轮 token 消耗 |
| started_at / finished_at | TEXT | 时间边界 |

索引：`(goal_id, iteration)`

### goal_audits —— 结构化完成审计

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | `audit-report_*` |
| goal_id | TEXT FK → goals | |
| passed | BOOLEAN | 是否通过 |
| score | INTEGER | 0-100 |
| criteria | JSON | `[{ criterion, met, evidence }]` 逐条验收核对 |
| issues | JSON | `[{ severity, detail }]` |
| next_actions | JSON | 后续动作 |
| markdown | TEXT | 渲染后的完整报告 |
| degraded | BOOLEAN | 是否离线降级审计 |
| created_at | TEXT | |

索引：`(goal_id, created_at)`

### cluster_configs —— Agent 集群配置（含降级开关）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| workspace_id | TEXT PK FK → workspaces | 一个工作区一份配置 |
| mode | TEXT | `single`（降级）/ `parallel` / `cluster`（实验性） |
| max_parallel | INTEGER | 并发上限（默认 4） |
| node_id | TEXT | 节点标识（本地为 `local`） |
| experimental | BOOLEAN | 实验性功能总开关 |
| updated_at | TEXT | |

### office_documents / office_previews —— 解析与预览缓存

`office_documents`：`(workspace_id, path)` 唯一索引，缓存 `content`（结构化内容）、`meta`、`warnings`、`parsed_at`。
`office_previews`：缓存 `markdown` 与 `renderer`，便于 UI 秒开。

### file_exports —— 导出记录（带 TTL）

| 列 | 说明 |
| --- | --- |
| id | `exp_*` |
| workspace_id / file_id / version | 来源文件与版本 |
| storage_path | 导出副本在 `STORAGE_DIR` 下的相对路径 |
| mime / size | 下载所需元信息 |
| url | `/files/exports/:id` |
| expires_at | 过期时间（默认 168 小时） |

### research_jobs / research_sources / research_claims / research_reports

`research_jobs`：`topic`、`depth`、`status`、`queries`、`progress`、`stage`、`output_formats`、`allow_network`、`source_count`、`claim_count`、`disputed_count`、`error`。

`research_sources`：`url`、`title`、`snippet`、`content`(截断)、`accessed_at`、`reliability`、`requires_auth`。
> 被 robots 拒绝或需授权的来源**也会落库**（`content` 以 `[未抓取]` 开头），保证抓取行为可审计。

`research_claims`：`claim`、`supporting_sources`、`conflicting_sources`、`confidence`、`disputed`。

`research_reports`：`markdown`、`charts`（Mermaid 源码）、`references_json`（编号引用）、`markdown_path`、`pdf_path`、`pptx_path`、`web_url`。

---

## 2. 扩展列（Phase 1 表）

### memory_facts
| 新列 | 说明 |
| --- | --- |
| embedding | JSON 数组（本地 hashing embedding 或远端返回），null 表示未计算 |
| recall_count | 被召回次数（重要度自增强） |
| fact_type | `preference` / `constraint` / `decision` / `fact` |
| updated_at | |

新增索引：`(conversation_id, fact_type)`

### conversation_summaries
| 新列 | 说明 |
| --- | --- |
| kind | `rolling`（自动）/ `manual`（手动压缩） |
| covered_count | 本次摘要覆盖的消息条数 |

### tasks
| 新列 | 说明 |
| --- | --- |
| reflection | Critic/Executor 对该任务的反思结论 |
| output_summary | 产出摘要（进度树与看板展示用） |
| last_agent_id | 最近真正执行该任务的 Agent |
| tokens_used | 累计 token |

### agent_messages
| 新列 | 说明 |
| --- | --- |
| thread_id | 话题线程（UI 按话题聚合） |
| kind | `broadcast` / `direct` / `task-claim` / `task-result` / `request-help` / `reply` |
| content | 可读消息正文 |

新增索引：`(goal_id, thread_id)`

---

## 3. 存储布局

```
DATA_DIR/
├── ai-workbench.db              # SQLite（WAL）
└── storage/                     # STORAGE_DIR
    ├── <workspaceId>/<fileId>/v<N>_<name>      # 文件版本
    ├── <workspaceId>/exports/<exportId>_<name> # 导出副本
    └── ...
```

工作区文件（用户目录）与存储目录严格分离：
- 版本快照放 `STORAGE_DIR`（系统管理，可清理）；
- 用户可见产物放 `workspace.rootPath`（用户管理，如 `out/*.docx`、`research/<topic>/*`）。

---

## 4. 缺陷复盘：审计为何必须能「兜底」

Phase 1 的 `AuditService` 直接把调用方传入的 `workspaceId` 写入 `audit_logs.workspace_id`（外键）。
调用方偶尔会把 `conversationId` / `goalId` 误当 `workspaceId`，于是：

```
SQLITE_CONSTRAINT_FOREIGNKEY → 未捕获 → 500
```

**审计是旁路能力，绝不能因为写日志失败而让业务请求失败。**

修复策略（`services/audit.ts`）：
1. 依次尝试：传入值 → 该值作为会话 id 反查 → 任意一个已存在的工作区；
2. 全部失败 → 跳过写库，记 `warn` 日志（仍可在日志系统追溯）；
3. 插入异常被捕获，记 `error` 日志后返回，不向上抛。

对应测试：`test/security.test.ts` →「审计写入失败不影响业务请求（旁路能力）」。
