# 架构决策记录（ADR）

> 规格要求：遇到不确定时先做合理假设并记录于此，不要停下来反复询问。
> 每条决策都标注「原因」与「后续替换路径」，避免把临时方案当永久架构。

---

## D-001 采用 pnpm workspace 单仓多包

**决策**：`packages/shared` / `packages/server` / `packages/desktop` 三包。

**原因**：
- 类型定义（数据模型、事件协议、API 契约）必须桌面端与服务端共享，避免双份漂移；
- 规格要求「类型安全」，共享包是唯一能保证端到端一致的方式；
- 相比 Nx/Turborepo，pnpm workspace 零额外配置，小步提交时心智负担最低。

**后续**：包数量增长后可加 Turborepo 做缓存，不改包结构。

---

## D-002 服务端用 Hono + node:http，而不是 Fastify/Express

**决策**：Hono 承载路由，`node:http` 承载 WebSocket。

**原因**：
- Hono 的 `app.fetch(Request)` 形态可在测试中直接构造 `Request` 调用，无需监听端口，e2e 测试快且稳定；
- 与 Web Fetch 标准一致，未来可整体搬到其他运行时（Bun/Workers）；
- 简单中间件模型足够，不需要 Fastify 的插件生态。

**后续**：性能瓶颈出现时可换接 `@hono/node-server` 的优化路径。

---

## D-003 领域逻辑与框架解耦，全部放 `packages/server/src/agent`

**决策**：DAG 调度（`task-graph.ts`）、Token 估算（`tokens.ts`）、计划解析（`planner.ts`）、审计判定（`critic.ts`）写成纯函数或纯类，不依赖 Hono、不依赖 DB 会话。

**原因**：
- 这些是最容易出错、最需要测试的部分，纯函数可以用 `node:test` 直接覆盖，无 mock；
- 符合规格「每个阶段必须有测试」；
- 未来换编排引擎（LangGraph/Temporal）时只替换 `goal-service.ts` 的驱动层。

**教训（已修复的真实缺陷）**：
`resolveReady` 最初只放行 `pending` / `blocked`，漏掉了 `ready` 状态 ——
导致创建目标后所有任务都是 `ready` 却一个都不派发，表现为「推进无任何效果」。
该缺陷由端到端测试捕获，现已补充 `ready` 与「不重复放行 running/succeeded」两个用例。

---

## D-004 自研极简迁移器，不用 drizzle-kit push

**决策**：`src/db/migrations/*.sql` + 自研执行器，记录到 `_migrations` 表。

**原因**：
- 规格要求「每个阶段必须可回滚」：`0001_init.down.sql` 显式提供回滚脚本，push 模式无法表达；
- 迁移过程要可审计、可重放（测试环境每次从零建库）；
- 避免 drizzle-kit 在 CI 中对交互式提示的依赖。

**权衡**：schema 与 migrations 存在双份维护成本。以 e2e 测试兜底：任何 schema 不一致都会在测试中直接报 `no such column`。

**真实案例**：`agent_runs.started_at` / `schedule_runs.started_at` 在 Drizzle schema 中被误写成 `created_at` 列，正是 e2e 测试以 `table agent_runs has no column named created_at` 暴露并修复的。

---

## D-005 分层上下文：Phase 1 用关键词召回，不引入向量库

**决策**：`MemoryService` 定义 `summary / fact / recent / retrieval` 四类上下文块与 Token 预算比例；召回先用 BM25 近似的关键词打分。

**原因**：
- 规格要求「百万 Token 对话不崩溃、有摘要和检索、可溯源」，这三点的核心是**预算分配与溯源**，不是向量算法；
- 引入 LanceDB/Qdrant 会显著拉长 Phase 1 交付时间，且离线环境难以安装；
- 接口 `buildContext(conversationId, query)` 已抽象，Phase 2 替换召回实现即可，调用方零改动。

**后续**：Phase 2 接入 LanceDB（本地零运维）或 pgvector（已有 Postgres 时）。

---

## D-006 Token 估算用启发式，不引入 tiktoken

**决策**：CJK 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token。

**原因**：
- 规格场景以中文为主，tiktoken 对中文有多字节分词差异，精度优势不明显；
- tiktoken 的 WASM 产物体积大、冷启动慢，对桌面端不友好；
- 预算分配只需要「数量级正确」。

**后续**：真实用量以模型返回的 `usage` 为准并回写 `agent_runs.input_tokens`，估算仅用于路由与预算。

---

## D-007 模型路由：兼容 OpenAI Chat Completions，超阈值自动切长上下文模型

**决策**：统一走 `/chat/completions`，通过 `AI_BASE_URL` 支持 OpenAI / Anthropic 网关 / 本地 Ollama / vLLM。

**原因**：
- 一套协议覆盖绝大多数供应商，减少适配层；
- 规格要求「长上下文模型 + 普通模型自动切换」：在 `selectModel` 中按输入 token 估算与 `AI_LONG_CONTEXT_THRESHOLD` 比较实现。

---

## D-008 未配置密钥时启用「离线兜底」，且兜底结果显式可识别

**决策**：
- 无 `AI_API_KEY` 时，模型调用返回带 `__degraded: true` 的确定性占位内容，HTTP 层标记 `degraded`；
- Planner / Critic / PromptService 检测到 `__degraded` 后**主动判定为失败并走确定性兜底路径**。

**原因**：
- 若直接抛错，Phase 1 的目标模式、事件流、审计、UI 全都无法演示与测试；
- 但若把占位内容当真实结果解析，会出现「静默通过审计」这种最危险的行为；
- 曾经的缺陷：兜底 JSON 里没有标记位，被 Critic 解析成 `passed:false, score:0` 的空结论，目标永远无法完成。加 `__degraded` 后，Critic 改用确定性规则（全部任务成功即通过），语义正确且不谎报。

---

## D-009 危险操作在工具层与路由层双重拦截

**决策**：
- `ToolRegistry.invoke` 检查 `tool.dangerous && !ctx.userConfirmed` → 直接拒绝；
- 路由层（如 `/website/deploy`）要求请求体 `confirm === true`，否则 400；
- 所有危险动作写入 `audit_logs`，带 `dangerous` / `confirmedByUser` 两列。

**原因**：规格要求「危险操作必须用户确认」「所有工具调用写审计日志」。单层校验一旦被绕过就无补救，双层 + 审计留痕可事后追溯。

---

## D-010 文件工具强制限定在 workspace.rootPath 之内

**决策**：`safeJoin` 用 `path.resolve` 后比对前缀，拒绝 `../` 越界；`rootPath` 默认 `null`，未设置时文件功能直接不可用。

**原因**：桌面端直连本地文件系统是最大风险面。安全默认（默认不可写）+ 显式授权（用户设置目录）优于「默认开放再限制」。

---

## D-011 付费数据源插件的合规红线写进代码

**决策**：
- 插件清单（`CURATED_PLUGINS`）覆盖同花顺 / 天眼查 / Wind / 恒生聚源 / S&P Global / IMF / 华宇元典 / 学术库；
- `assertCompliant` 强制：`paid:*` 权限必须 `requiresUserAuth = true`；manifest 中出现「绕过反爬 / 绕过验证码 / 共享账号 / 破解授权」等声明直接拒绝安装；
- 凭据只存变量名（`secretRefs`），真实值由用户写入 Keychain / 环境变量。

**原因**：规格明确「不得绕过官方限制、不得硬编码账号、必须用户手动授权」。这类约束放在文档里会被遗忘，放在代码里 + 有单测覆盖才能长期守住。

---

## D-012 PDF 中文：优先嵌字体，缺失时显式降级而非崩溃

**决策**：`buildPdf` 依次探测 `PDF_CJK_FONT` → Noto CJK → PingFang → msyh；无可用字体时把非 ASCII 替换为 `?`，并在文档首行插入降级说明。

**原因**：
- 曾经的缺陷：直接对 CJK 文本调用 Helvetica 导致 `WinAnsi cannot encode "格"` 抛错，整个 `/office/generate` 返回 500；
- 静默输出乱码比崩溃更糟，因此选择「可用的产物 + 明确的降级提示」。

**后续**：Phase 2 接入 LibreOffice headless 转换，彻底解决 CJK 排版。

---

## D-013 Excel/Word/PPT 用各自官方库，不自己拼 XML

**决策**：docx / exceljs / pptxgenjs / pdf-lib。

**原因**：规格要求「不破坏原文件格式」。自己拼 OpenXML 无法保证兼容性，而这些库已被大量生产环境验证。

---

## D-014 WS 事件流带环形缓冲回放

**决策**：`EventBus` 保留最近 500 条事件，WS 连接建立后按 workspaceId 回放最近 100 条。

**原因**：桌面端可能因休眠/网络抖动断连，重连后若无回放，UI 上的任务与 Agent 状态会停留在旧快照，产生「界面与实际不一致」的错觉。

---

## D-015 定时任务 Phase 1 用 node-cron 进程内调度

**决策**：`startScheduler` 支持 cron / interval / once，失败按 `retry` 次数重试，每次执行写 `schedule_runs`；每分钟热加载一次配置。

**原因**：Phase 1 目标是「可跑通、可观测」。进程内调度足够，且无额外基础设施依赖。

**权衡**：进程重启会丢调度注册（配置在 DB 中，重启后热加载恢复）；不跨机。**后续**：Phase 3 换 BullMQ + Redis，接口不变。

---

## D-016 事件协议直接放 shared 包，而不是 OpenAPI 生成

**决策**：`EventType` 常量 + `AppEvent<T>` 泛型。

**原因**：事件是前后端紧耦合的实时协议，代码即契约最简单可靠；OpenAPI 更适合 REST。

---

## D-017 前端状态集中在单一 Zustand store

**决策**：`app-store.ts` 同时持有 workspace / agents / goals / tasks / logs，WS 事件统一在 `applyEvent` 中归约。

**原因**：Agent 运行态是高度联动的（任务变 → 进度变 → Agent 状态变 → 事件流变）。分散订阅会导致渲染顺序不一致与重复请求。集中归约让状态转换可预测。

**权衡**：store 会变大。当超过约 500 行时按领域拆分 slice，保持单一归约入口。

---

## D-018 Phase 未交付能力返回明确说明，而不是空实现

**决策**：`/research`、`/website/deploy` 在特性开关关闭时返回 400 + 说明「将在 Phase N 交付」，并说明前置条件。

**原因**：规格要求「实验性功能可降级」。静默成功会让用户以为功能已就绪，是更严重的体验问题。

---

## D-019 Tauri 壳不承载业务逻辑

**决策**：Rust 侧只提供 `validate_workspace_root` 与 `runtime_base_url` 两个命令。

**原因**：业务逻辑集中在 TypeScript 便于测试与复用；Rust 侧只做原生能力桥接（目录校验、通知）。避免同一逻辑两处实现。

---

## 待办与遗留风险

| 项 | 说明 | 计划 |
| --- | --- | --- |
| 大文件上传 | 当前 50MB 上限，走 base64 | Phase 2 改流式上传 |
| 向量检索 | 关键词近似，非语义 | Phase 2 接 LanceDB |
| 摘要触发 | 已实现存储结构，自动触发阈值待接入 LLM | Phase 2 |
| 集群模式 | UI 已有节点视图，无跨机调度 | Phase 4 |
| 推送渠道 | 表结构就绪，未接发送实现 | Phase 3 |
| PDF 中文 | 依赖系统字体 | Phase 2 接 LibreOffice |
| Electron/Tauri 签名 | 未配置签名与自动更新 | Phase 3 |

---

# Phase 2 决策与缺陷复盘

> Phase 2 交付：百万 Token 分层上下文、目标模式、多 Agent 并行与实验性集群、
> Office 文件处理、深度研究。所有能力默认离线可用，未配置密钥时显式降级而非静默失败。

## 一、架构决策

### D1. 自研 embedding 而非强制外部向量服务
**背景**：Phase 2 验收要求「有检索、有溯源」。
**决策**：默认使用本地确定性 embedding（hashing trick + 字符 n-gram + L2 归一），
配置 `AI_EMBEDDING_MODEL` 时优先远端，失败自动回落。
**理由**：CI/离线环境无法保证外部服务；本地实现的接口与远端一致，后续换 LanceDB/Qdrant 只换实现。
**代价与补偿**：本地是近似语义 → 额外并联关键词召回（对编号/专有名词敏感），两路融合。

### D2. 摘要/事实/审计「规则先行、模型补充」
**背景**：未配置密钥时产品仍必须可用，且不能静默冒充真实输出。
**决策**：
- 摘要：模型不可用 → 确定性抽取式摘要（按句特征分桶，保住关键决策）；
- 事实：规则正则永远先行，模型只做补充；
- 审计：模型结论必须叠加确定性约束——**任务失败时即使模型说「通过」也判不通过**。
**理由**：事实判定不能交给可能幻觉的模型；模型负责措辞，不负责事实。

### D3. 报告润色加安全校验（防幻觉）
**决策**：模型润色结果必须通过四项检查（引用编号集合一致、mermaid 块不减、冲突标记不丢、
长度不缩水），否则丢弃并回退确定性稿。
**理由**：让「有引用/冲突被标记」成为结构性保证，而不是靠模型自觉。

### D4. Office 编辑原地改 OOXML
**决策**：docx 只改 `<w:t>` 与追加段落；pptx 只新增页并合并进原包；xlsx 用 exceljs 定向改单元格；
pdf 明确拒绝原地编辑。
**理由**：「不破坏原格式」唯一可靠的做法是不重建文件结构。xlsx 受限于库能力，因此**显式提示**风险。

### D5. 合规做成硬约束而非配置项
**决策**：`config.research.respectRobots` 恒为 `true`；付费来源识别 → 不自动抓取、不作证据；
插件声明触碰「绕过反爬/共享账号/破解授权」直接拒绝安装。
**理由**：合规不应存在「压力下被关掉」的开关。测试断言「被禁止路径未发出任何请求」。

### D6. 批量写入必须复用 prepared statement
**决策**：`ContextManager.appendMessages` 用单个 prepared statement + 事务批量插入。
**理由**：见缺陷 #7，这是本阶段定位最深的性能/稳定性问题。

---

## 二、缺陷复盘（全部为实际复现并修复）

### 1. 迁移执行器把 `*.down.sql` 当向上迁移执行
- **现象**：`runMigrations()` 按文件名排序执行全部 `.sql`，把 `0001_init.down.sql` 的
  `DROP TABLE` 也执行了，导致建表后立即被删。
- **定位**：测试启动时报「表不存在」；日志里 `migration applied {"file":"0001_init.down.sql"}` 是铁证。
- **修复**：过滤 `!f.endsWith('.down.sql')`；新增 `rollback()` 显式使用 down 脚本，并支持 CLI。

### 2. Token 预算比例之和为 1.1
- **现象**：六分区 + 输出预留按文档比例相加为 1.1，输入组装上限实际比模型上限高 10%。
- **修复**：调整比例为 1.0（检索 20%、输出预留 5%），新增 `validateRatios()` 启动即自检并抛错。

### 3. 事实溯源被兜底值覆盖
- **现象**：`mergeFacts` 对模型事实补 `sourceMessageId` 时，把规则命中的**精确来源**覆盖成了兜底值。
- **影响**：「点击跳回原消息」跳到错误消息，溯源失效。
- **修复**：去重时保留已有来源（`prev.sourceMessageId ?? f.sourceMessageId`）。

### 4. `pickSummarizeRange` 未保护最近原文
- **现象**：实现里只用「未摘要消息」切片，未排除最近 N 条，导致最近对话可能被摘要掉。
- **修复**：先按 `keepRecent` 算出最近消息 id 集合并从待摘要集合中剔除；并补测「最近消息绝不被摘要」。

### 5. `progressTree` 显示不出真正的执行者
- **现象**：`assigneeAgentId` 取 `task.claimedBy`（声明认领者），但引擎把实际执行者写在 `lastAgentId`。
- **修复**：`task.lastAgentId ?? task.claimedBy`。

### 6. `extractKeywords` 把整句吞成一个关键词
- **现象**：贪婪 CJK 正则匹配 `[\u4e00-\u9fff]{2,}`，`必须支持百万` 被当成一个词，
  导致验收标准匹配失效（任务永远无法对齐标准）。
- **修复**：先把虚词替换成空格做粗切分，再取有效片段。

### 7. better-sqlite3 在高频 GC 下进程退出时原生断言 abort（本阶段最深的问题）
- **现象**：规模测试与 perf 脚本在写入约 350+ 行后，进程退出阶段报
  `Assertion failed: (env) != nullptr`（`RemoveEnvironmentCleanupHook`）并 `SIGABRT`。
- **定位过程**：
  1. 先用最小复现脚本确认与业务代码无关：`new Database()` + 多次 `prepare()` + 大量分配即复现；
  2. 对比「每条新建 statement」与「复用单个 statement」：前者复现，后者通过 → 缩小到语句生命周期；
  3. 独立脚本跑 2500 行无问题，仅在 `node --test` 与 tsx loader 下复现 → 判定为
     **原生模块 finalizer 与 Node 24 的交互缺陷**；
  4. 换 `better-sqlite3@13.0.3` 复跑同一脚本 → 通过。
- **修复**：
  a. 依赖升级 `^11.5.0 → ^13.0.3`；
  b. 仍保留并推广批量写入路径（复用 prepared statement + 事务），因为它同时是
     「大文件/整仓库导入」的正确做法（语句创建次数 O(n) → O(1)）。
- **遗留约束**：记录在 `docs/phase2-architecture.md` §5 与 runbook 排查表，避免后人重新踩。

### 8. 未知工具名会抛错并中断任务
- **现象**：`ToolRegistry.invoke('not.exist')` 直接抛 `AppError.notFound`。
- **影响**：模型编造工具名 → 整个任务中断，且 Critic 无法走「换工具」修正路径。
- **修复**：未知工具返回 `{ ok: false, error: '工具不存在: xxx（可用工具：...）' }`，
  让反思环节能识别并切换工具。

### 9. 审计写入失败导致业务 500
- **现象**：把 `conversationId` 当 `workspaceId` 传入 → `audit_logs.workspace_id` 外键失败 → 500。
- **修复**：审计按优先级解析真实工作区（传入值 → 会话反查 → 任一工作区），
  全部失败只记 warn 不写库；插入异常被捕获记 error。对应测试：安全测试套件。

### 10. ZIP 读取器的压缩分支写法错误
- **现象**：写成 `deflateRawSync.length >= 0 ? inflate(raw) : Buffer.alloc(0)` —— 恒真但调用了错误的函数。
- **影响**：所有 OOXML 解压失败 → docx 解析返回空文本，pptx 无法解析。
- **修复**：按 `method` 显式分支（0=stored / 8=deflate），解压失败保留原始字节并让上层给出警告。

### 11. 文件版本号复用导致出现两条 v2
- **现象**：编辑前 `snapshot()` 插入版本后未同步 `files.version`，
  随后 `bumpVersion()` 基于旧的 `files.version + 1` 再插入 → 两条相同版本号，且 `version` 不前进。
- **修复**：`snapshot()` 同步 `files.version`；`bumpVersion()` 改为按**已存在的最大版本**推导。

### 12. PDF 页数统计恒为 0
- **现象**：正则只认带空格的 `/Type /Page`，而 pdf-lib 产出 `/Type/Page`，且用对象流（ObjStm）压缩。
- **修复**：兼容两种写法，并解压对象流后再统计；文本抽取支持 `Tj`/`TJ`/`'`/`"` 与 hex 字符串。

### 13. 研究数值抽取把「年份」当数据点
- **现象**：`2025 年储能装机量预计达到 120GW` 抽出两个「数值」（2025 和 120），
  分别落入不同键，冲突检测彻底失效。
- **修复**：排除「1900–2100 整数且后接『年』」的年份；同时修正数字正则互相吞并的问题
  （`30%` 之前无法被抽出），并把主题键去动词（预计达到/将达）。

### 14. 离线兜底计划只有 4 步，无法满足「自主完成 ≥10 步」验收
- **现象**：`defaultPlan` 返回 4 个任务，即使完美执行也只有 4 步。
- **修复**：重写为 12 步真实 DAG（含扇出并行分支、量化分析、交叉验证、双交付物），
  并补测「必须存在扇出」「依赖引用必须存在」「无环」。

### 15. 测试环境缺少工具注册导致「工具不存在」
- **现象**：目标引擎测试未调用 `registerBuiltinTools()`，离线兜底触发的 `fs.write` 调用失败。
- **价值**：这次失败反而暴露了 #8（未知工具抛错）这一真实健壮性问题。

### 16. 插件目录自相矛盾（`requiresUserAuth: true` 但无凭据声明）
- **现象**：`mcp-web-fetch` 声明需要用户授权，却没有任何 `secretRefs`，用户不知道该配置什么。
- **修复**：该插件实际无需凭据 → 改为 `requiresUserAuth: false`；
  新增目录自洽测试：`requiresUserAuth` 为真时必须有凭据名；付费源必须有 sensitive 权限声明。

---

## 三、被放弃的方案

| 方案 | 放弃原因 |
| --- | --- |
| 直接引入 LanceDB/Qdrant | CI 需要额外服务；本地实现已满足「有检索可溯源」，且接口可平滑替换 |
| 引入 zip 库处理 OOXML | 只为「读一个 XML 改完写回」，自研 ~120 行即可，避免 native 编译与供应链面 |
| PDF 用 pdfium/LibreOffice 解析 | 重量级 native 依赖；改为「能解则解，不能解明确警告」 |
| xlsx 编辑保留全部扩展特性 | exceljs 能力边界；选择显式提示而不是假装无损 |
| 用模型做最终事实判定 | 幻觉风险；事实判定保持确定性，模型只润色 |

---

# Phase 3 复盘：交付与自动化

Phase 3（网站部署 / Neon·Supabase / 定制看板 / 定时任务 / 推送通知）实现过程中的真实缺陷与决策记录。
每条都写清了「现象 → 定位过程 → 根因 → 修法 → 如何防止复发」。

## 缺陷 1：路由遮蔽 —— 新接口永远 404，老接口静默返回假成功

**现象**：`GET /api/widgets?pinned=true` 返回 404「接口不存在」，而 `POST /api/widgets` 生效但行为不对。

**定位**：Phase 1 已经注册过 `/widgets` 系列路由，Phase 3 又在同一 app 实例上注册了一份。
Hono 的路由匹配是「先注册先匹配」，因此 Phase 1 的简版路由吞掉了 Phase 3 的请求。

**更严重的问题**：Phase 1 的 `/website/deploy` 占位接口返回 `202 { accepted: true, note: '部署任务已进入队列' }`，
但**什么都没做**。前端会显示「已进入队列」，用户以为部署成功了。
这不是 404 那么容易被发现，是最危险的一类 bug。

**修复**：
1. 删除 Phase 1 的 `/widgets` 重载，只保留一个兼容用的 `POST /widgets`（转发到 `DashboardService`）；
2. 把 `/website/deploy` 改成显式迁移提示（400 + `replacements` 列表），不再假装成功。

**防止复发**：`phase3-e2e.test.ts` 里有「部署记录可查询」「固定到桌面可切换」等用例，
直接从真实 HTTP 入口断言行为，任何遮蔽都会立刻失败。

## 缺陷 2：`nextRun` 逐分钟扫描 —— 性能差 19 倍

**现象**：`phase3-perf.test.ts` 报「500 次 nextRun 耗时 4630ms，超过 500ms 阈值」。

**定位**：初版实现是「从 now 开始每次 +1 分钟/秒，逐字段比对」。
对于「每月 1 日 9 点」这种稀疏表达式，要遍历数万分钟才能命中。

**修复**：改为**字段级跳过**：
- 日期不匹配 → 直接跳到次日（最主要的性能来源）
- 小时不匹配 → 跳到下一整点
- 分钟不匹配 → 跳到下一整分钟

结果：500 次计算 **4630ms → 247ms**。

**顺带的正确性修复**：明确「返回时间必须严格晚于 from」，
并新增「每 5 分钟」「6 段带秒」「工作日跳过周末」三个边界用例。
其中「工作日跳过周末」用例暴露了原本的日期跳过逻辑会漏目标，因此加了「回退一天保证不漏」的处理。

## 缺陷 3：`compact()` 抹掉用户向下拖动的意图

**现象**：`phase3-e2e.test.ts` 的「拖拽布局持久化」用例断言 `y === 4`，实际得到 `y === 0`。

**定位**：`compact()` 从 `y = 0` 开始找空位，导致用户把组件拖到 `y=4` 后保存，
服务端又把它压回 `y=0`。用户视角就是「拖了没反应」。

**根因**：把 compact 实现成了「全部归零」，而 React Grid Layout 的 `compact('vertical')`
语义是「消除空洞」，不是「全部贴顶」。

**修复**：只在「上方存在阻挡物」时才上移：

```ts
let y = item.y;
while (y > 0 && placed.some(p => overlaps({ ...item, y }, p))) y -= 1;
```

同时新增「单组件保持原位」「上方有阻挡才下移」两个用例锁住语义。

## 缺陷 4：`PostgresAdapter.inspect` 只看语句开头 —— SQL 注入绕过

**现象**：`phase3-security.test.ts` 断言 `select 1; drop table users` 应被拒绝，实际返回 `safe: true`。

**定位**：初版用 `/^\s*(insert|update|...)/i` 判定写操作。
`select 1; drop table users` 的开头是 `select`，被当成只读查询放行。

**修复**：先按 `;` 拆成语句，**逐条判定**，只要任一条是写操作就整体标为写；
并且「写 + 多语句」直接拒绝（防止绕过二次确认做批量变更）。

写入操作的正则也补全了 `merge` / `call` / `do` / `vacuum` / `reindex` / `refresh`
（初版只有 insert/update/delete/alter/create/drop/grant/revoke/comment）。

## 缺陷 5：`GRANT` 未被拦截 —— 提权语句漏网

**现象**：同一个安全测试断言 `grant all on users to public` 应被拒绝，实际 `safe: true`。

**修复**：把 `GRANT`/`REVOKE` 加入 `BLOCKED_PATTERNS` 并给出理由
（「会改变数据库权限模型，请用数据库控制台」）。
同时补了「修改角色超级权限」与 `pg_execute_server_program`。

## 缺陷 6：`IP_RE` 正则放过 `999.1.1.1`

**现象**：安全测试断言 `validateRule({ type: 'ip-allowlist', value: '999.1.1.1' })` 应抛错，实际通过。

**根因**：`/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/` 只校验「1-3 位数字」，
不校验数值范围，`999` 合法通过。

**修复**：新增 `isValidIpOrCidr()` 逐段校验 `0-255` 且前缀 `0-32`，
并加了 `192.168.1.1/33`、`192.168.1/-1`、`192.168.1` 边界用例。

## 缺陷 7：`sanitizeName` 静默修正路径穿越

**现象**：安全测试断言 `writeProject(dir, '../x', …)` 应拒绝，实际成功（写到了 `dir/x`）。

**分析**：`sanitizeName` 会把 `../x` 净化为 `x` —— **行为本身是安全的**（没写出去），
但用户以为写到了别处、实际写到了本地目录，这种「静默修正」是不应该的。

**修复**：新增 `validateProjectName()`，在净化**之前**显式拒绝
`..` / 路径分隔符 / 以 `.` 或 `~` 开头 / Windows 保留名（CON/PRN/AUX/NUL/COM1/LPT1）。
`writeProject` 现在先校验再净化。

## 缺陷 8：通知配置校验抛普通 Error → 500 而不是 400

**现象**：E2E 用例「配置不完整的渠道在创建时就被拒绝」期望 400，实际 500。

**根因**：`BaseNotifier.validate()` 用 `throw new Error(...)`，
被 Hono 的 `onError` 当成未捕获异常 → 500。

**为什么这是真问题**：用户填错表单却看到「服务器错误」，会以为系统故障而不是自己少填了字段。

**修复**：改为 `throw AppError.badRequest(...)`，并在 `details` 里带上 `missing` 字段列表。
`phase3-e2e.test.ts` 断言错误信息里包含具体缺失字段名（如「Webhook 地址」）。

## 缺陷 9：`RefreshScheduler.tick` 首轮刷新 200 个新建组件

**现象**：性能测试期望「刚创建的 200 个组件首轮全部跳过」，实际 `refreshed = 200`。

**根因**：`lastRefresh.get(w.id) ?? 0` —— 新建组件没有刷新记录，
`now - 0 >= interval` 恒成立，于是首轮全部到期，瞬间打满数据源。

**修复**：以「组件创建时间」作为首刷基准：

```ts
const createdAt = Date.parse(w.createdAt ?? '') || 0;
const last = this.lastRefresh.get(w.id) ?? createdAt;
```

**为什么重要**：用户一次粘贴 20 个组件是很常见的操作，
没有这个宽限期，就会出现「保存看板瞬间卡死几秒」的体验问题。

## 缺陷 10：测试脚手架共享 DB 单例导致「no such table」

**现象**：`phase3-perf.test.ts` 的第 2、3 个用例报 `SqliteError: no such table: users`。

**定位**：`setupTestContext().cleanup()` 会 `sqlite.close()`，
但 `createDb` 内部维护模块级单例 `singleton`，下一个用例调用 `createDb` 时
拿到的是**已关闭的句柄**。

**修复**：`setupTestContext` 开头调用 `closeDb()` 重置单例，`cleanup` 也先 `closeDb()` 再 close。

**教训**：测试辅助里任何「全局状态」都要显式重置，不能依赖调用顺序。

另外 `phase3-e2e.test.ts` 里我一开始在 seeded 之后 `sqlite.close()`，
导致后续所有请求报 `The database connection is not open` —— 同一个坑的另一面：
**传给 `createApp` 的 db 和 seed 用的是同一个连接，不能提前关**。

## 缺陷 11：本地预览服务器导致 `node --test` 无法退出

**现象**：E2E 全部 36 个用例通过（7.9s），但进程一直挂着，直到 300s 超时被杀。

**根因**：`LocalPreviewAdapter` 会常驻监听 `127.0.0.1`（这正是它的功能），
测试结束后没有关闭，Node 的 event loop 不空。

**修复**：`after()` 钩子里通过 `getAdapter('local-preview')` 拿到**与路由同一个实例**并 `stopAll()`。
一开始我 new 了一个新实例去 stopAll，发现没效果 —— 因为单例不一致。

**顺带的发现**：`node --test --test-force-exit` 能绕过，但那是掩盖问题，
正确的做法是找到并关闭句柄。

## 缺陷 12：源码密钥扫描测试命中测试夹具

**现象**：Phase 2 的「源码中不出现硬编码密钥」测试失败，报 `deploy/phase3.test.ts`。

**分析**：我在测试里写了 `'ghp_' + 'a'.repeat(36)` 之外的**字面量**假密钥
（`ghp_abcdefghijklmnopqrstuvwxyz0123456789`），被同一条规则命中。

**这其实说明扫描器工作正常**。修复方式是让测试夹具本身也遵守规则：
运行时拼接 `'ghp_' + 'a'.repeat(36)`，源码里不出现完整形态。

## 缺陷 13：`compact` 与 `MAX_ROWS` 的边界冲突

**现象**：性能测试构造 200 个 6×4 组件（y 到 400），报「组件超出最大行数（200）」。

**分析**：`MAX_ROWS = 200` 是我为「防爆护栏」设的，但 200 个组件确实需要 100 行，
而测试构造的 `y` 到了 400。说明护栏太紧。

**修复**：`MAX_ROWS` 提到 2000（仍是护栏，但不会误伤合理布局）。

## 缺陷 14：`normalizeDow` 按字段名判断，永不生效

**现象**：cron 测试断言 `parseCron('0 0 * * 7').daysOfWeek` 等于 `[0]`，实际 `[7]`。

**根因**：`normalizeDow(v, name, range)` 里按 `name === 'daysOfWeek'` 判断，
但调用处传的 name 是中文（「周」，用于报错信息），永远不等于 `'daysOfWeek'`。

**修复**：改为按**值域**判断（`range[0] === 0 && range[1] === 7`），
这才是正确的判据 —— 字段名只是展示用的。

**同时修复**：`describe()` 对「7 天全选」不再输出「周日、周一…周7」，直接判定为「不限」。

## 缺陷 15：观察到的性能问题 —— 整板刷新无并发上限

**现象**：`refreshDashboard` 用 `Promise.all` 并发刷新所有组件，
12 个 `data-query` 组件会同时发起 12 次查询。

**修复**：`RefreshScheduler` 引入 `maxConcurrent`（默认 4）+ 轮转批次 + 轮次超时（10s），
超时的组件在下一轮补上。测试断言并发峰值 `<= 4`。

## 缺陷 16：`JobRunner` 的参数校验晚于依赖检查

**现象**：测试里「缺少 objective 参数」期望错误信息含 `objective`，
实际得到「目标模式未启用（deps.runGoal 未注入）」。

**分析**：这是**测试暴露的更好行为**：参数错误是用户配置问题，
应该**先于**依赖注入检查 —— 否则用户在没配好环境时看到的是「未启用」，
配好环境后才看到「缺参数」，多走一轮。

**修复**：把参数校验提到依赖检查之前，并加了一个用例断言
「参数缺失时不触发真实执行」（避免无效重试）。

## 关键决策记录

### 决策 1：自研 cron 解析器而不是用 node-cron

`node-cron` 只提供 `validate` 和执行，不提供：
1. **下次执行时间**（UI 必须展示，否则用户不知道 `0 0 * * *` 到底几点跑）；
2. **自然语言描述**（同上，降低误解）；
3. **显式时区换算**（`Intl.DateTimeFormat` 正确处理夏令时；node-cron 依赖服务器 TZ）。

自研的代价是要自己做性能优化（见缺陷 2），但换来的是完全可控的行为与可测的边界。

### 决策 2：`local-preview` 适配器是一等公民，不是 fallback

它解决两个真实问题：
1. 用户没配任何平台 Token 时，仍能拿到可访问地址（「生成完能自己看一眼」是最小可用体验）；
2. 部署前本地验证产物完整性（缺 `index.html` 立即报错，而不是等平台构建失败）。

它**只监听 127.0.0.1**（安全测试用正则断言这一点），且返回 `degraded: true` +
明确文案「本地预览仅监听 127.0.0.1，未对外发布」——不假装上线了。

### 决策 3：危险操作闸门写在服务端，前端弹窗只是收集意图

前端 `triggerConfirm` 可以被绕过（改 JS、直接调 API）。
所以真实拦截点必须在服务端 `gate()`，并覆盖 `false/undefined/null/0/''/'true'/1` 全部形态。
`phase3-security.test.ts` 遍历全部危险动作 × 7 种假值做断言。

### 决策 4：三个分域审计表 vs 复用全局 `audit_logs`

`audit_logs` 是「所有工具调用与用户操作」的全局总线，
但「部署历史 / 迁移历史 / 任务历史」页面需要按域查询且要带上域内上下文
（`deployment_id` / `database_connection_id` / `schedule_id`）。

如果复用一张表，每个查询都要 `WHERE target_type = 'deployment' AND target_id IN (...)`
再做二次过滤，既慢又容易漏。所以三个域各一张表，同时**都写**全局表（双写）。
双写是冗余的，但换来的是「任何操作都能在全局审计里按时间线看到」，
这对「到底发生了什么」这类排查很重要。

### 决策 5：备份只做逻辑备份，不代持全量数据

`backup.ts` 只导出「结构 + 每表前 100 行样本」，并在 UI 与文档里明确说明
「完整备份请用 pg_dump」。

原因：桌面工作台不应该成为用户生产数据的副本载体 ——
那既带来存储/合规风险，也容易让用户误以为「有备份了」而放弃真正的备份策略。
明确的边界比虚假的安心更有价值。

### 决策 6：`WORKBENCH_SECRET_KEY` 未配置时生成密钥文件 + 告警，而不是报错

报错会让首次体验直接失败（用户还没进入设置页就卡住了）；
静默使用固定密钥则是安全事故。

选择「生成 `data/secrets/local.key`（0o600）+ 明确 WARN」：
首次可用，且日志里说清了「跨机迁移前请改用环境变量」。
更换密钥后旧密文解密失败（GCM 认证标签），表现为可读错误而不是错数据。

### 决策 7：功能开关放在 `config.features`，不放在数据库

放数据库需要迁移与权限模型；放配置文件则「改一行重启」即可。
Phase 3 新增 5 个开关（`phase3Deploy` / `phase3Schedule` / `phase3Database` / `phase3Dashboard` / `phase3Notify`），
关闭后接口返回「未启用」但**数据全保留**（见缺陷 1 的修复与 `phase3-rollback.md` 的 L1）。

### 决策 8：`/website/deploy` 保留但返回 410 语义，而不是直接删除

直接删会让老调用方拿到 404「接口不存在」，排查成本高。
返回 400 + `{ deprecated, replacements: [...] }` 明确告知迁移路径，
既保证不静默假成功，又给出可执行的下一步。

## Phase 3 交付统计

| 项目 | 数值 |
| --- | --- |
| 新增服务端模块 | 7 个目录 / 42 个文件 |
| 新增数据表 | 13 张（+ 复用表补 15 列） |
| 新增接口 | 约 55 个 |
| 新增 UI 页面 | 5 个（+ 9 个 Phase 3 专用组件） |
| 新增测试用例 | 193 个（总计 442 个，全部通过） |
| 修复真实缺陷 | 16 个（本文档全部记录） |
| 性能优化 | nextRun 4630ms → 247ms（19 倍） |
| 文档 | 5 份（架构/数据模型/接口/运行手册/回滚方案） |
