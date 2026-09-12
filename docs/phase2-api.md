# Phase 2 接口文档

所有接口统一前缀 `/api`（开发态由 Vite 代理；Tauri 打包后指向本地 sidecar）。

## 统一约定

**成功响应**
```json
{ "ok": true, "data": { }, "traceId": "trace_xxx" }
```

**失败响应**
```json
{ "ok": false, "error": { "code": "BAD_REQUEST", "message": "可读说明", "details": {}, "traceId": "trace_xxx" } }
```

错误码：`BAD_REQUEST` `UNAUTHORIZED` `FORBIDDEN` `NOT_FOUND` `CONFLICT` `RATE_LIMITED` `PROVIDER_ERROR` `TOOL_ERROR` `TIMEOUT` `INTERNAL`

**WebSocket**：`ws://<host>/events?workspaceId=<id>`，连接后回放最近 100 条事件。

**危险操作**：需显式确认。部分接口通过 `x-user-confirmed: true` 头，部分通过 body 的 `confirm: true`。

---

## 1. 分层上下文（Step 1）

### GET /context/:conversationId/summary
记忆面板数据源。

```json
{
  "conversationId": "conv_x",
  "summaries": [{ "id": "sum_x", "content": "## 关键决策\n- ...", "tokenCount": 320, "coveredCount": 12, "kind": "rolling", "fromMessageId": "msg_a", "toMessageId": "msg_b", "createdAt": "..." }],
  "facts": [{ "id": "fact_x", "key": "约束", "value": "密钥不硬编码", "factType": "constraint", "importance": 0.75, "sourceMessageId": "msg_c", "embedding": [0.01], "recallCount": 2 }],
  "messages": 240,
  "rawTokens": 183420,
  "compactThreshold": 66500,
  "shouldCompact": true,
  "budget": { "total": 200000, "used": 183420, "byKind": {}, "limits": {}, "outputReserve": 10000, "overBudget": false }
}
```

### POST /context/:conversationId/compact
手动触发滚动摘要。可选头 `x-workspace-id`。

请求：
```json
{ "force": false, "keepRecent": 12 }
```
响应：
```json
{ "conversationId": "conv_x", "summarizedMessages": 48, "summaryId": "sum_y", "summary": "## 关键决策\n...", "tokensBefore": 24000, "tokensAfter": 4800, "factsExtracted": 12, "degraded": true }
```

### GET /conversations/:id/context-preview?q=<query>&files=a.md,b.md
返回组装后的分层上下文（含溯源与路由信息）。

```json
{
  "blocks": [{ "kind": "recent", "content": "[user] ...", "sourceIds": ["msg_a"], "tokens": 320 }],
  "totalTokens": 38000,
  "citations": ["msg_a", "msg_b"],
  "budget": { "total": 200000, "used": 48000, "byKind": { "recent": 18000 }, "limits": { "recent": 66500 }, "outputReserve": 10000, "overBudget": false },
  "model": "gpt-4o-mini",
  "routedByLength": false
}
```

`blocks[].kind` ∈ `recent | goal | summary | facts | retrieval | file`

---

## 2. 目标模式（Step 2）

### POST /goals
```json
{ "workspaceId": "ws_x", "objective": "为储能行业写调研报告", "autoRun": false, "maxIterations": 12, "acceptanceCriteria": ["可选，缺省由 Planner 解析"] }
```
响应 201：`{ "goal": {...}, "tasks": [...] }`

### POST /goals/:id/run
自主推进直到完成 / 达上限 / 停滞。可选头 `x-user-confirmed: true`。
```json
{ "maxIterations": 20, "mode": "parallel" }
```
响应：
```json
{
  "goal": { "status": "completed", "progress": 100, "iterations": 4 },
  "tasks": [],
  "run": { "iteration": 4, "reflection": "本轮修正 1 项；有状态推进", "tokensUsed": 3200 },
  "audit": { "passed": true, "score": 95, "criteria": [{ "criterion": "...", "met": true, "evidence": "..." }], "issues": [], "nextActions": [], "markdown": "# 完成审计报告..." },
  "finished": true,
  "corrections": ["重试任务 task_x：第 2/3 次尝试：..."],
  "stalled": false
}
```

### GET /goals/:id/progress
```json
{
  "goal": { "id": "goal_x", "objective": "...", "status": "running", "progress": 66, "iterations": 3, "maxIterations": 12, "acceptanceCriteria": ["..."] },
  "nodes": [{ "id": "task_a", "title": "...", "status": "succeeded", "progress": 100, "agentRole": "researcher", "assigneeAgentId": "agt_x", "dependsOn": [], "children": [], "blockedReason": null, "outputSummary": "..." }],
  "summary": { "total": 12, "succeeded": 8, "failed": 0, "blocked": 1, "running": 1, "pending": 2, "percent": 66 },
  "blockers": ["任务「x」：原因"]
}
```

### 其他
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/goals?workspaceId=` | 目标列表 |
| GET | `/goals/:id` | 目标 + 任务 |
| POST | `/goals/:id/cancel` | 取消目标 |
| GET | `/goals/:id/tasks` | 任务列表 |
| GET | `/goals/:id/audit` | 结构化审计 + Markdown |
| GET | `/goals/:id/runs` | 每轮 GoalRun（可回放） |
| GET | `/goals/:id/board` | 任务看板（按列） |
| GET | `/goals/:id/messages` | Agent 消息总线 |

---

## 3. 多 Agent 与集群（Step 3/4）

### GET /cluster?workspaceId=
```json
{ "config": { "workspaceId": "ws_x", "mode": "parallel", "maxParallel": 4, "nodeId": "local", "experimental": false } }
```

### PATCH /cluster
```json
{ "workspaceId": "ws_x", "mode": "single", "maxParallel": 1, "experimental": true }
```
`mode` ∈ `single`（降级串行）| `parallel`（默认并行）| `cluster`（实验性）

### POST /tasks/:id/assign
```json
{ "agentId": "agt_x", "preempt": false }
```
`preempt: true` 可抢占正在执行的任务（任务回到 ready）。

### POST /agents/:id/message
```json
{ "goalId": "goal_x", "content": "请复核数据来源", "kind": "request-help", "toAgentId": null }
```

### 其他
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/agents?workspaceId=` | Agent 列表 |
| GET | `/agents/:id/runs?limit=` | 该 Agent 的运行记录 |

---

## 4. Office 文件处理（Step 5）

### GET /office/status
```json
{ "available": false, "hint": "未配置 SOFFICE_PATH，跨格式转换不可用。..." }
```

### POST /office/read
```json
{ "workspaceId": "ws_x", "path": "out/report.docx" }
```
响应：`{ "format": "docx", "meta": { "paragraphs": 12 }, "content": { "text": "...", "outline": [] }, "warnings": [], "truncated": false, "fileId": "file_x" }`

### POST /office/preview
额外返回 `markdown`（xlsx 会转成 Markdown 表格）与 `renderer`（`docx-preview` | `pdf.js` | `sheetjs` | `pptx` | `markdown`）及 `downloadUrl`。

### POST /office/edit
```json
{
  "workspaceId": "ws_x",
  "path": "out/report.docx",
  "backup": true,
  "operations": [
    { "op": "replace", "find": "旧内容", "replace": "新内容" },
    { "op": "append", "text": "## 追加小节\n\n- 要点" },
    { "op": "setCell", "sheet": "数据", "cell": "B3", "value": 999 },
    { "op": "addSlide", "title": "第二页", "bullets": ["要点"] }
  ]
}
```
响应：`{ "applied": 2, "version": 3, "backupVersion": 2, "bytes": 8678, "warnings": [] }`

### POST /office/convert
```json
{ "workspaceId": "ws_x", "path": "out/report.docx", "target": "pdf", "outputPath": "out/report.pdf" }
```
未配置 LibreOffice 时 `degraded: true` 并给出配置指引（仍返回 200，便于 UI 展示原因）。

### POST /office/export
```json
{ "workspaceId": "ws_x", "path": "out/report.docx", "ttlHours": 168 }
```
响应：`{ "id": "exp_x", "url": "/files/exports/exp_x", "size": 8678, "expiresAt": "..." }`

### GET /files/exports/:exportId
带过期检查的真实下载（`content-disposition: attachment`）。

### 其他
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/files/:id/content` | 按文件记录解析 |
| GET | `/files/:id/versions` | 版本历史 |
| POST | `/files/:id/restore` | 回滚到指定版本（产生新版本，可再回滚） |

```json
// POST /files/file_x/restore
{ "version": 1 }
// → { "fileId": "file_x", "version": 4, "restoredFrom": 1, "restoredToWorkspace": true, "bytes": 8579 }
```

---

## 5. 深度研究（Step 6）

### GET /research/capability
```json
{ "network": false, "hint": "未配置 RESEARCH_SEARCH_ENDPOINT：研究将在本地素材范围内进行...", "maxSources": 32 }
```

### POST /research
```json
{
  "workspaceId": "ws_x",
  "topic": "储能行业 2025 装机量与风险",
  "depth": "deep",
  "allowNetwork": true,
  "outputFormats": ["markdown", "pdf", "pptx"],
  "maxSources": 20
}
```
`allowNetwork` 默认为 `false`；**未显式允许时不会发起任何外部请求**。
响应 201：`{ "job": { "id": "rj_x", "status": "pending", "queries": ["..."], "progress": 0 } }`
执行在后台进行，通过 `GET /research/:id` 轮询或订阅 WS `research.progress`。

### GET /research/:id
```json
{
  "job": { "status": "completed", "progress": 100, "sourceCount": 6, "claimCount": 4, "disputedCount": 1, "stage": "已完成" },
  "sources": [{ "id": "rsrc_x", "url": "https://...", "title": "...", "snippet": "...", "content": "...", "accessedAt": "...", "reliability": 0.7, "requiresAuth": false }],
  "claims": [{ "id": "claim_x", "claim": "2025 年储能装机量预计达到 120GW", "supportingSources": ["rsrc_a"], "conflictingSources": ["rsrc_b"], "confidence": 0.62, "disputed": true }],
  "report": { "id": "rrep_x", "markdown": "# ...", "charts": [{ "title": "...", "kind": "bar", "data": { "mermaid": "```mermaid..." } }], "references": [{ "index": 1, "sourceId": "rsrc_a", "title": "...", "url": "...", "accessedAt": "...", "snippet": "..." }], "markdownPath": "research/xxx/report.md", "pdfPath": "research/xxx/report.pdf", "pptxPath": "research/xxx/report.pptx", "webUrl": null }
}
```

### GET /research/:id/report
仅返回报告（未生成时 404）。

### GET /research/:id/export
直接下载 Markdown（`text/markdown`）。

### POST /research/:id/publish
```json
{ "public": false }
```
响应：`{ "webUrl": "file:///.../index.html", "reportId": "rrep_x" }`
工作区未配置 `rootPath` 时返回内联 `data:text/html;base64,...`。

### 其他
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/research?workspaceId=` | 研究任务列表 |
| POST | `/research/:id/cancel` | 取消研究 |

---

## 6. 错误与限流语义

| 场景 | 状态码 | code |
| --- | --- | --- |
| 路径穿越 / 工作区外访问 | 403 | `FORBIDDEN` |
| 未配置 rootPath | 400 | `BAD_REQUEST` |
| 参数非法（深度、版本号、并发等） | 400 | `BAD_REQUEST` |
| 目标/任务/文件/报告不存在 | 404 | `NOT_FOUND` |
| 已完成目标再取消、执行中任务未抢占就改派 | 409 | `CONFLICT` |
| 外部检索/模型失败 | 502 | `PROVIDER_ERROR` |

> 审计写入失败**不会**影响业务请求（审计是旁路能力，仅记录警告日志）。
