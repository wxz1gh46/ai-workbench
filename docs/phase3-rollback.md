# Phase 3 回滚方案

Phase 3 的每个能力都可以独立关闭，且**关闭不需要回滚数据库**（数据保留，功能停止）。
需要彻底回退时再按下面的分级方案操作。

## 分级回滚策略

| 级别 | 手段 | 影响范围 | 数据 |
| --- | --- | --- | --- |
| **L1 功能开关** | `config.features.phase3Deploy = false` 等 | 对应接口返回「未启用」 | 保留 |
| **L2 停用实例** | 停用定时任务 / 停用通知渠道 / 删除看板 | 单个对象停止工作 | 保留（可再启用） |
| **L3 删业务数据** | 删除部署记录 / 网站项目 / 数据库连接 | 单条业务数据 | 级联删除该对象的从属数据 |
| **L4 回滚迁移** | `pnpm db:rollback 0003_phase3.sql` | Phase 3 表结构 + 数据 | **丢失** Phase 3 全部数据 |
| **L5 回退代码** | `git revert` Phase 3 提交 | 代码层 | 由 L4 决定 |

**建议顺序**：L1（先停功能）→ L3（清理业务数据）→ L4（必要时回滚结构）→ L5。

## L1：功能开关

`packages/server/src/config.ts`：

```ts
features: {
  phase2GoalMode: true,
  phase2Office: true,
  phase2Research: true,
  phase3Deploy: false,     // ← 关闭网站部署（含生成/构建/部署/回滚/删除）
  phase3Schedule: true,    // ← 关闭定时任务
  phase4Cluster: false,
  phase4PaidPlugins: false,
},
```

也可通过环境变量控制（推荐用部署配置而不是改代码）：

```bash
# 在 config.ts 中已接入 env 读取；若需运行时切换，改成 env('FEATURE_PHASE3_DEPLOY', 'false') === 'true'
```

关闭后的行为：相关路由返回 `AppError.badRequest('…将在 Phase 3 交付（需用户配置…）')`，
UI 上显示为未启用。**已存在的部署记录/任务/渠道都还在**，重新打开开关即可恢复。

## L2：停用单个对象（零数据损失）

| 对象 | 操作 | 接口 |
| --- | --- | --- |
| 定时任务 | 停用（不清历史） | `PATCH /schedules/:id { enabled: false }` |
| 通知渠道 | 停用（不发但仍可测试） | `PATCH /notify/channels/:id { enabled: false }` |
| 小组件 | 禁用（保留配置） | `PATCH /widgets/:id { enabled: false }` |
| 网站项目 | 打 `deleted` 标记前可先只停用 | 目前为直接删除，建议先手动记录部署 URL |

## L3：删除业务数据

```bash
# 删除单个部署（先清理平台侧，再标 deleted）
curl -X DELETE "http://127.0.0.1:8787/api/websites/<id>/deployments/<depId>?confirm=true"

# 删除整个网站项目（尽力清理全部平台侧部署）
curl -X DELETE "http://127.0.0.1:8787/api/websites/<id>?confirm=true"

# 删除数据库连接（不影响云端数据库）
curl -X DELETE "http://127.0.0.1:8787/api/databases/<id>?workspaceId=<ws>&confirm=true"

# 删除定时任务（含执行历史，级联）
curl -X DELETE "http://127.0.0.1:8787/api/schedules/<id>?workspaceId=<ws>&confirm=true"

# 删除通知渠道（含发送日志，级联）
curl -X DELETE "http://127.0.0.1:8787/api/notify/channels/<id>?workspaceId=<ws>&confirm=true"

# 删除看板（含全部小组件）
curl -X DELETE "http://127.0.0.1:8787/api/dashboards/<id>?workspaceId=<ws>&confirm=true"
```

全部删除操作：需要 `confirm=true`（否则 428）+ 写分域审计。

## L4：回滚数据库迁移

```bash
# 回滚 Phase 3（只删 0003 新增的 13 张表与新列的数据）
pnpm db:rollback 0003_phase3.sql

# 验证：Phase 1/2 表完好，Phase 3 表已消失
pnpm verify:rollback
```

**回滚影响**：

| 消失 | 保留 |
| --- | --- |
| 13 张 Phase 3 表（网站项目/部署/数据库 schema/迁移/看板/数据源/通知渠道/日志/三个分域审计） | Phase 1/2 全部表与数据 |
| `database_connections` / `schedules` / `schedule_runs` / `widgets` 的 Phase 3 新增列**仍保留**（SQLite 老版本无 DROP COLUMN），但无代码依赖，不写入 | `schedules` / `schedule_runs` / `widgets` 的原有列与数据（Phase 1 简化版功能仍可用） |

> **为什么新增列不删**：SQLite 3.35 以下不支持 `DROP COLUMN`，
> 且删除列会重写表、有数据风险。保留空列对 Phase 1/2 无影响。
> `migrate.ts` 会在迁移时做「列存在性检查」，因此回滚后再迁移不会报 duplicate column。

**回滚前务必备份**：

```bash
cp data/ai-workbench.db "data/backup-$(date +%Y%m%d-%H%M%S).db"
```

## L5：回退代码

```bash
# 查看 Phase 3 的提交范围
git log --oneline <phase2-head>..HEAD

# 回退（保留历史，安全）
git revert --no-commit <phase3-commits...>
git commit -m "revert: 回退 Phase 3"

# 或直接切回 Phase 2 分支
git checkout <phase2-branch>
```

如果同时回滚了 L4，代码与数据库结构是一致的；
只回代码不回 L4 也不影响（新表闲置）。

## 各 Step 的独立回滚

| Step | 独立回滚方式 | 是否需回滚迁移 |
| --- | --- | --- |
| Step 1 网站生成器 | 删 `website_projects` 记录 + 删除工作区 `websites/<name>/` 目录 | 否 |
| Step 2 数据库接入 | 删 `database_connections`（云端库不受影响） | 否 |
| Step 3 网站部署 | 平台侧删除部署 → 删 `website_deployments` | 否 |
| Step 4 看板 | 删 `dashboards`（级联 `widgets`/`widget_data_sources`）；布局可单独回滚 | 否 |
| Step 5 定时任务 | 停用/删除 `schedules`（级联 `schedule_runs`） | 否 |
| Step 6 推送通知 | 停用/删除 `notify_channels`（级联 `notify_logs`） | 否 |
| 全部 Step | L1 功能开关 + L4 迁移回滚 | 是 |

## 验收自检

```bash
pnpm verify:rollback
# [P3-1] ✅ Phase 3 (13) 表齐全，新增列已生效
# [P3-2] ✅ Phase 3 回滚成功；Phase 1/2 表完好（未跨阶段误伤）
# [P3-3] ✅ Phase 3 迁移可幂等重新应用
# [P3-4] ✅ 功能开关存在（phase3Deploy / phase3Schedule），可独立关闭而去数据不丢
```
