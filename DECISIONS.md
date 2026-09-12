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
