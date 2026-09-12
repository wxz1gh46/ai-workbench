# 集群部署与运维手册

> 定位：**实验性**多节点集群。默认单机运行，集群是可选增强。
> 核心承诺：**集群不可用时任务仍会跑完**（降级单机），且用户能明确知道当前跑在哪种模式。

## 1. 快速开始（单机集群）

```bash
# 1) 注册本机节点 → 心跳 → 选举（幂等，可重复调用）
curl -X POST http://127.0.0.1:8787/cluster/bootstrap \
  -H 'content-type: application/json' -d '{"workspaceId":"<ws>"}'

# 2) 查看状态
curl 'http://127.0.0.1:8787/cluster/status?workspaceId=<ws>&mode=cluster'
```

返回中的关键字段：

| 字段 | 含义 |
| --- | --- |
| `mode` | `single` / `cluster` |
| `degraded` | 是否处于降级态（想用集群但不可用） |
| `degradeReason` | 降级原因（人类可读） |
| `leader` / `term` | 当前主节点与任期 |
| `online` / `nodes.length` | 在线节点数 / 总数 |
| `taskStats` / `shardStats` | 任务与分片状态分布 |

## 2. 加入更多节点

```bash
curl -X POST http://127.0.0.1:8787/cluster/nodes \
  -H 'content-type: application/json' \
  -d '{"workspaceId":"<ws>","name":"worker-2","host":"10.0.0.12","port":8787,
       "resources":{"cpu":8,"memoryMb":16384,"diskGb":100},
       "labels":{"tier":"pro","leaderPriority":"5"}}'
```

**注册后节点是 `offline`**，必须收到心跳才转 `online`：

```bash
curl -X POST http://127.0.0.1:8787/cluster/nodes/<nodeId>/heartbeat \
  -H 'content-type: application/json' -d '{"cpu":15,"memory":30,"disk":5}'
```

节点数受策略 `maxNodes` 限制（超出 → **409**，不会静默忽略）。

> `host` 允许回环地址（单机集群是合法起点）。若配置 `allowLoopback: false`，回环地址会被拒绝。

## 3. 心跳与失联判定

- 节点每 `heartbeatTimeoutMs / 3` 秒左右发一次心跳；也可由外部定时任务调 `POST /cluster/nodes/:id/heartbeat`
- 超时未收到心跳 → 扫描时标记 `offline`，`heartbeat_miss` 累加（**不删节点**，便于排障）
- 手动触发扫描：`POST /cluster/sweep?workspaceId=<ws>`

**手动扫描**适合调试；生产建议让 `ClusterManager.start()` 的后台定时器跑（`unref()`，不阻止进程退出）。

## 4. 选举机制

算法：**确定性优先级排序**（标签 `leaderPriority` → 角色权重 `candidate > worker` → 节点名 → id）。

- `leaderPriority` 是字符串标签，按数值比较；没配按 0
- **同输入必然得同 leader**：可复现、可测试、UI 上可解释「为什么选了它」
- 每次选举 term +1，并写 `cluster_elections`（`reason`: `initial`/`failover`/`manual`）
- 选举会先把所有节点降为 worker/candidate，再把胜出者设为 leader → **全局只有一个 leader**

```bash
# 查看历史
curl 'http://127.0.0.1:8787/cluster/elections?workspaceId=<ws>'
# 强制重新选举（leader 卡住时用）
curl -X POST 'http://127.0.0.1:8787/cluster/elections?workspaceId=<ws>&confirm=true'
```

**leader 掉线会自动触发 failover 选举**（由心跳扫描的 `onOffline` 回调串起：先选举 → 再改派分片；顺序不能反，否则改派时仍无 leader）。

## 5. 任务分片与分发

```bash
curl -X POST http://127.0.0.1:8787/cluster/tasks/distribute \
  -H 'content-type: application/json' \
  -d '{"workspaceId":"<ws>","taskId":"goal-task-1","items":[1,2,3,4,5,6],
       "shardCount":3,"labels":{"tier":"pro"},"need":{"cpu":2}}'
```

分片策略（`shardAuto`）：

- 权重差异小 → `by-count`（按数量平均切，分片数精确）
- 最大项 > 均值 × 3 → `by-weight`（LPT 贪心，大项优先，避免长尾）

分发策略（按优先级）：

1. **标签匹配**：任务声明的 labels 必须被节点满足
2. **资源满足**：任务 `need` 不超过节点资源声明
3. **负载最低**：`(在途权重 + 本分片权重) / 节点资源得分` 最小
4. **平局按节点名**：保证确定性

**幂等性**：同一 `taskId` + `index` 重复分发不会产生两条执行记录。
已完成/执行中的分片会被跳过（`skipped` 里会说明原因）。超出 `maxParallelTasks` 的分片保持 `pending`，等下一轮。

## 6. 容错行为

| 故障 | 处置 |
| --- | --- |
| 节点失联 | 其 `assigned`/`running` 分片**重新入队**，改派到健康节点（旧分片标记 `reassigned`，新记录累加 `attempts`） |
| 分片执行失败 | 重试（受 `maxAttempts` 限制，默认 3）；超限标记 `failed` 并向上汇报，**不无限重试** |
| 已完成分片 | **永不重跑**（重跑 = 重复计费 + 结果冲突） |
| 集群整体不可用 | 按 `fallbackEnabled` 决定：回退单机（给出原因）或明确拒绝调度 |

## 7. 策略与资源治理

```bash
curl 'http://127.0.0.1:8787/cluster/policy?workspaceId=<ws>'
curl -X PATCH 'http://127.0.0.1:8787/cluster/policy?workspaceId=<ws>&confirm=true' \
  -H 'content-type: application/json' \
  -d '{"workspaceId":"<ws>","maxNodes":16,"maxParallelTasks":8,"fallbackEnabled":true,"heartbeatTimeoutMs":60000}'
```

| 字段 | 范围 | 说明 |
| --- | --- | --- |
| `maxNodes` | 1~256 | 节点数上限，超出注册直接 409 |
| `maxParallelTasks` | 1~64 | 并行分片上限 |
| `heartbeatTimeoutMs` | 1000~600000 | 心跳超时（决定多快判定离线） |
| `resourceLimits` | 非负数 | 单节点可用资源上限，分发时校验 |
| `fallbackEnabled` | bool | 是否允许回退单机 |

越界值 → **400** 并说明范围（不会「夹到边界」后静默生效）。

## 8. 监控与排障

```bash
curl http://127.0.0.1:8787/cluster/health          # 健康摘要（各节点最新指标）
curl 'http://127.0.0.1:8787/cluster/status?workspaceId=<ws>'
curl 'http://127.0.0.1:8787/cluster/tasks?workspaceId=<ws>'
```

### 常见问题

**Q：`degraded: true`，`degradeReason` 说「没有在线节点」**
A：节点注册后是 `offline`，需要心跳。检查：
1. 节点进程是否在跑
2. 心跳接口是否可达（`POST /cluster/nodes/:id/heartbeat`）
3. `heartbeatTimeoutMs` 是否设得太小（网络抖动会误判离线）

**Q：`degradeReason` 说「集群没有 leader」**
A：触发一次选举：`POST /cluster/elections?workspaceId=<ws>&confirm=true`。
或调 `/cluster/bootstrap`（会自动注册本机节点 + 心跳 + 选举）。

**Q：`degradeReason` 说「集群功能已被功能开关关闭」**
A：检查 `config.features.phase4Cluster`（环境变量 `PHASE4_CLUSTER=1`）。关闭态下接口返回「未启用」但**数据全保留**。

**Q：分片一直 `pending` 不动**
A：看 `/cluster/tasks/distribute` 返回的 `skipped[].reason`，常见原因：
- `已达并行上限 N` → 调大 `maxParallelTasks`
- `没有满足标签/资源要求的在线节点` → 检查 labels/need 与节点声明

**Q：节点被标记 offline 但进程还在**
A：检查是否有时差（`last_heartbeat` 是 ISO 8601，本地时区不影响比较，但系统时钟漂移会影响）。
`heartbeat_miss` 大于 1 说明反复丢失，优先排查网络。

**Q：想彻底停用集群**
A：把 `fallbackEnabled` 设为 `false` 会把「静默降级」变成「明确拒绝」；
或设 `PHASE4_CLUSTER=0` 关闭整个功能（数据保留）。

## 9. 回滚

```bash
# 单个节点
curl -X DELETE 'http://127.0.0.1:8787/cluster/nodes/<id>?workspaceId=<ws>&confirm=true'
#（在线 leader 会被拒绝删除 → 先触发选举换主）

# 集群级
PHASE4_CLUSTER=0   # 关闭功能开关，接口返回「未启用」，数据保留
pnpm --filter @ai/server db:rollback   # 回滚 0004（仅当确认不再需要 Phase 4 数据）
```

**注意**：回滚 0004 会删除全部 29 张 Phase 4 表（含插件授权、凭据密文、集群历史）。
执行前先 `pnpm verify:phase4` 确认影响范围，并备份 `data/` 目录。
