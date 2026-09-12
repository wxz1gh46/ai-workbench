# Phase 2 运行手册与回滚方案

---

## 1. 环境准备

### 1.1 系统依赖

```bash
# Node ≥ 20（本次验证于 Node 24）
node -v

# 构建 better-sqlite3（原生模块）需要编译工具链
# Debian/Ubuntu:
sudo apt-get update && sudo apt-get install -y build-essential python3
# macOS: xcode-select --install
# 注意：至少需要 make 与 gcc，否则 npm install 会在 better-sqlite3 处失败
```

### 1.2 可选外部依赖

| 能力 | 依赖 | 不配置时的行为 |
| --- | --- | --- |
| 跨格式转换 | LibreOffice headless（`SOFFICE_PATH`） | 同格式读写编辑仍可用；转换返回明确降级说明 |
| 联网检索 | 自建检索端点（`RESEARCH_SEARCH_ENDPOINT`） | 研究降级为本地素材 / 产生「待核查问题」清单 |
| 深度语义召回 | `AI_EMBEDDING_MODEL` | 使用本地确定性 embedding（近似语义 + 关键词混合） |
| 模型能力 | `AI_API_KEY` | 全流程离线兜底（确定性规则/模板），结果显式标注降级 |

### 1.3 配置

```bash
cp .env.example .env
# 按需填写；密钥一律只放环境变量，代码与数据库不存储明文
```

---

## 2. 安装与启动

```bash
pnpm install          # 安装依赖（含原生模块编译）

pnpm typecheck        # 类型检查（三个包）
pnpm test             # 全量单元 + 集成测试
pnpm lint             # 目前复用 tsc（无独立 lint 规则）

pnpm dev:server       # 后端 :8787
pnpm dev:desktop      # 前端 :5183（Vite）
pnpm tauri:dev        # 桌面壳（需 Rust 工具链）
```

### 无前端也能验证全链路

```bash
pnpm --filter @ai/server cli goal "调研 2025 储能行业并输出报告"
pnpm --filter @ai/server cli run <goalId>
pnpm --filter @ai/server cli office docx --title "周报" --content "# 本周"
```

---

## 3. 分步验证命令（对应 Phase 2 每个 Step）

| Step | 命令 | 期望 |
| --- | --- | --- |
| Step 1 分层上下文 | `pnpm --filter @ai/server test:context` | 31 个用例通过（预算/embedding/召回/摘要/事实） |
| Step 1 集成 | `pnpm --filter @ai/server test -- --test-name-pattern="百万"` | 百万 token 规模用例通过 |
| Step 2 目标模式 | `pnpm --filter @ai/server exec node --test --experimental-transform-types "src/goals/*.test.ts"` | 目标引擎 12 用例通过 |
| Step 5 Office | `pnpm --filter @ai/server exec node --test --experimental-transform-types "src/office/*.test.ts"` | 14 用例通过 |
| Step 6 深度研究 | `pnpm --filter @ai/server exec node --test --experimental-transform-types "src/research/*.test.ts"` | 21 用例通过 |
| Step 8 安全 | `pnpm --filter @ai/server exec node --test --experimental-transform-types "test/security.test.ts"` | 12 用例通过 |
| Step 8 性能 | `pnpm --filter @ai/server exec node --test --experimental-transform-types "src/context/performance.test.ts"` | 4 用例通过 |
| 规模验证 | `pnpm --filter @ai/server perf:million` | 打印 100 万 token 实测指标并 `exit 0` |

### 百万 Token 规模实测（本次结果）

```
[perf] 目标 1,000,000 token，开始写入…
[perf] 写入 666 条 / 1,008,890 token，用时 71ms
[perf] 组装用时 174ms，输入 token 54,524
[perf] 预算：used=64,524 total=200,000 over=false
[perf] 分区：recent=18180 retrieval=36344
[perf] 溯源引用 36 条，路由模型 gpt-4o-mini（长上下文切换=false）
[perf] 堆内存增量 32.6 MB
[perf] 压缩用时 74ms，摘要 654 条，事实 0 条，token 1008890 → 18180
[perf] 压缩后再组装用时 152ms，分区 recent,summary,retrieval
[perf] ✅ 通过：百万 token 不崩溃，预算不超限，有摘要/召回/溯源
```

> 可用 `PERF_TARGET_TOKENS=200000` 快速回归；用 `AI_SCALE_TOKENS=100000` 缩小测试规模。
> `PERF_*` / `AI_SCALE_TOKENS` 只影响压测脚本与规模测试，不影响生产行为。

---

## 4. 迁移与回滚

### 4.1 迁移执行

```bash
pnpm --filter @ai/server db:migrate
```

自研迁移执行器特性：
- 只加载 `*.sql` 且**排除** `*.down.sql`（回滚脚本不能被当作向上迁移执行）；
- 已执行记录写入 `_migrations`，重复执行幂等；
- 每个迁移在一个事务内执行。

### 4.2 回滚

```bash
# 回滚最后一个已应用的迁移
pnpm --filter @ai/server db:rollback

# 回滚指定迁移
pnpm --filter @ai/server db:rollback 0002_phase2.sql
```

`0002_phase2.down.sql` 删除本阶段新增的全部表与索引。
新增的**列**在 SQLite 上按版本尽力删除（3.35+ 支持 `DROP COLUMN`）；若数据库版本不支持，
列会保留但无数据依赖，**不影响 Phase 1 功能**。

### 4.3 每个 Step 的独立回滚

Phase 2 的每个能力都能通过「功能开关 + 代码路径」单独停用：

| 能力 | 停用方式 | 影响 |
| --- | --- | --- |
| 深度研究 | `PHASE2_RESEARCH=0` | `/research` 返回 400 并说明未启用；其他功能不受影响 |
| 集群模式 | `PATCH /cluster { mode: "single" }` | 目标模式串行执行（maxParallel 强制 1），仍可完成 |
| 实验性集群 | `PATCH /cluster { experimental: false }` | 关闭实验性入口 |
| 滚动摘要 | `AI_COMPACT_THRESHOLD` 调大（如 `999999999`） | 不自动压缩；仍可手动 `POST /context/:id/compact` |
| 向量召回 | 不配置 `AI_EMBEDDING_MODEL` | 回落本地关键词召回，功能不中断 |
| Office 转换 | 清空 `SOFFICE_PATH` | 转换显式降级，读写编辑不受影响 |
| 联网检索 | 清空 `RESEARCH_SEARCH_ENDPOINT` | 研究降级为本地素材/待核查清单 |
| 模型调用 | 清空 `AI_API_KEY` | 全流程离线兜底，结果标注 `degraded` |

> 数据库级回滚（4.2）与功能级回滚（4.3）可独立使用：
> 前者用于「结构不要了」，后者用于「功能先关掉观察」。

---

## 5. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `pnpm install` 在 better-sqlite3 处失败 | 缺少 make/gcc | 安装 build-essential / xcode-select |
| 进程退出时报 `RemoveEnvironmentCleanupHook` 断言 abort | better-sqlite3 旧版本（<13）在 Node 24 下高频 GC 的原生缺陷 | 已升级到 `^13.0.3`；如自行降级需谨慎 |
| 目标推进「无效果」 | 任务状态不是 `ready`（Phase 1 已修复的 `resolveReady` 缺陷） | 确认 `npm test` 中 task-graph 用例通过 |
| 目标一直不完成，审计不通过 | 任务失败且重试用尽（换角色/换工具也不可恢复） | 查看 `/goals/:id/audit` 的 `nextActions` 与 `/goals/:id/progress` 的 `blockers` |
| 研究报告无引用 / 全是「待核查问题」 | 未配置检索端点，或未勾选「允许联网」 | 配置 `RESEARCH_SEARCH_ENDPOINT`，请求中带 `allowNetwork: true` |
| 抓取全部被拒绝 | 目标站点 robots.txt 禁止 | 这是合规预期行为；换允许抓取的来源或提供本地素材 |
| Office 转换返回 degraded | 未配置 LibreOffice | 安装 LibreOffice 并设置 `SOFFICE_PATH=/usr/bin/soffice` |
| PDF 读不到文本 | 扫描件或 CMap/子集字体 | 配置 LibreOffice 转换后再读，或使用 OCR |
| 前端提示「无法连接本地服务」 | 后端未启动 | `pnpm dev:server` |

---

## 6. 日志与可观测性

- 结构化 JSON 日志（`utils/logger.ts`），字段含 `workspaceId` / `goalId` / `taskId`；
- 日志通过 `logBus` 广播到 WS `/events`，前端实时可见；
- 审计双层留痕：`audit_logs`（业务动作，含 `dangerous`、`confirmedByUser`）与
  `tool_calls`（每次工具调用，含被权限门拒绝的）；
- Agent 运行追踪：`agent_runs`（prompt 摘要 / 模型 / token / 成本）+ `goal_runs`（每轮）。

### 关键日志关键字

| 关键字 | 含义 |
| --- | --- |
| `dangerous action without user confirmation` | 危险操作缺少用户确认（已记录） |
| `audit skipped: workspace not resolvable` | 审计无法解析工作区，已跳过写库 |
| `fetch blocked by robots.txt` | 抓取被 robots 拒绝（合规行为） |
| `planner produced cyclic DAG` | Planner 产出成环，已重新生成 id（内部自愈） |
| `task execution failed` | 任务失败及重试信息 |
| `bulk messages appended` | 批量写入消息（大文件导入） |
