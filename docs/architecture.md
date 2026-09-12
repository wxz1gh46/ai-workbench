# 架构与数据流

## 1. 分层

| 层 | 组件 | 位置 |
| --- | --- | --- |
| 客户端层 | Tauri 2 + React + Zustand + Tailwind | `packages/desktop` |
| Agent 运行时 | Coordinator / Planner / Executor / Critic / Memory / TaskQueue / MessageBus / ToolRegistry / AuditLogger | `packages/server/src/agent` |
| 工具层 | 文件、Office、插件、部署 | `packages/server/src/tools` |
| 模型层 | ModelRouter（普通 ↔ 长上下文自动切换） | `agent/model-router.ts` |
| 数据层 | SQLite + Drizzle；Postgres/向量库在后续阶段 | `packages/server/src/db` |
| 插件层 | MCP 优先 + HTTP/WS 适配 | `services/plugin-service.ts` |
| 安全层 | 权限门、路径限制、复合规红线、审计 | `tools/registry.ts`、`services/audit.ts` |

## 2. 目标模式时序

```
用户输入目标
     │
     ▼
POST /agent/goal
     │
     ├─▶ Planner.createPlan()
     │       · 无密钥 → defaultPlan() 确定性兜底
     │       · 有密钥 → LLM 输出 JSON {acceptanceCriteria, tasks[]}
     │
     ├─▶ 入库前 DAG 校验（detectCycle）
     │       · 有环 → 回落 defaultPlan，避免脏图
     │
     ├─▶ 写 goals + tasks（status: ready/pending）
     │
     └─▶ audit_logs: goal.create
     
POST /agent/goals/:id/run  →  advanceUntilFinished()
                                 │
                     ┌───────────┴───────────┐
                     ▼                       │
           resolveBlocked（依赖失败标记）      │
           resolveReady（依赖已成功的任务）    │  每轮最多 32 次
                     │                       │
                     ▼                       │
           Promise.all(并行派发)              │
                     │                       │
                     ├─ claimAgent(role)     │
                     │    · 角色不匹配 → coordinator 兜底
                     ├─ collectUpstream()    │
                     ├─ Executor.runTask()   │
                     │    · 写 agent_runs（running）
                     │    · LLM + toolCalls JSON 解析
                     │    · 每次工具调用写 tool_calls + 事件
                     │    · 写 agent_runs（succeeded/failed）
                     ├─ 失败 → retryOrFail（attempts < maxAttempts → ready）
                     └─ broadcast() 写 agent_messages（共享任务板）
                     │                       │
                     ▼                       │
           全部终态或达 maxIterations？────────┘
                     │ 是
                     ▼
           Critic.auditGoal()
              · 逐条对照 acceptanceCriteria
              · 失败 → status=failed，blockers=nextActions
              · 无密钥 → 确定性规则（全成功即通过）
                     │
                     ▼
           goals.auditReport + audit_logs: goal.audit
```

## 3. 分层上下文（百万 Token）

```
Token 预算 200k
├─ 近期原文   35%  最近消息，倒序取到预算上限
├─ 向量召回   25%  按 query 关键词打分（Phase 2 → LanceDB）
├─ 滚动摘要   20%  最近 5 条摘要，倒序取到预算上限
├─ 关键事实   10%  按 importance 排序
└─ 输出预留   10%

buildContext() → { blocks[], totalTokens, citations[] }
                              │
                              └─▶ citations 回传前端，UI 展示「召回来源」
```

关键事实抽取（Phase 1 规则版）：正则匹配「我(更)喜欢/偏好/习惯」「必须/不能/禁止/务必」「决定/确定/就用」。

## 4. 事件流

```
服务端                                       客户端
eventBus.publishBuffered(type, payload, ctx)
   │
   ├─▶ EventEmitter（进程内订阅，scheduler / executor 用）
   ├─▶ 环形缓冲（最近 500 条，供回放）
   └─▶ WS /events
            │
            └─▶ EventStream（指数退避重连）
                     │
                     └─▶ app-store.applyEvent() 单一归约入口
                              ├─ task.updated      → tasks
                              ├─ agent.status      → agentStatus
                              ├─ goal.updated      → activeGoal
                              └─ 其他              → logs
```

## 5. 安全边界

```
用户确认 ──▶ 路由层校验（confirm: true）──▶ ToolRegistry 权限门 ──▶ 工具执行
                     │                              │
                     │ 拒绝                          │ 拒绝
                     ▼                              ▼
              audit_logs（dangerous=true,      返回 {ok:false} 并落 tool_calls
              confirmed_by_user=false）        （allowed=false）

文件访问：safeJoin(workspaceRoot, rel)
  · path.resolve 后必须仍以 workspaceRoot 为前缀
  · rootPath 为 null 时所有文件工具直接拒绝
```

## 6. 依赖方向

```
shared  ←──  server
   ↑            ↑
   └────  desktop

规则：shared 不依赖任何包；server 与 desktop 之间无直接依赖，只通过 HTTP/WS 协议通信。
```
