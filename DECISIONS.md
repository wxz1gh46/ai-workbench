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
