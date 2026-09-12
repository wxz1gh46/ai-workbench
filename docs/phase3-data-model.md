# Phase 3 数据模型

## 设计原则

1. **只新增、不改动** Phase 1/2 的表结构 → 三个迁移可共存、可独立回滚。
2. 新增列一律带 `DEFAULT` → 老数据可读，向后兼容。
3. 全部业务表 `REFERENCES workspaces(id) ON DELETE CASCADE` → 多工作区隔离与级联清理。
4. 凭据字段一律为 `*_enc` / `encrypted_config`，只存 AES-256-GCM 密文。
5. 每条迁移都有 `.down.sql` → 「每个 Step 可独立回滚」。
6. 三个分域审计表（部署/数据库/定时）独立于全局 `audit_logs`，
   便于按域直接查询而不需要二次过滤。

## 新增表（13 张）

### Step 1：网站项目

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `website_projects` | `type` `framework` `status` `requirement` `plan` `root_dir` `entry_file` `preview_url` `database_connection_id` | `plan` 存需求解析结果（页面/实体/API/样式/访问控制）；`root_dir` 指向工作区内生成目录 |
| `website_builds` | `version` `files` `build_log` `status` `trigger` `error` | 每次生成/构建一条；`version` 自增，用于「回滚到历史版本」 |

### Step 3：部署

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `website_deployments` | `provider` `deployment_id` `url` `custom_domain` `env_vars` `status` `log` `rollback_of` `deployed_at` | `env_vars` 只存 `{key, secretRef}`，**绝不存值**；`rollback_of` 指向被回滚的部署 → 回滚链可追溯 |
| `website_access_rules` | `type`(password/email-allowlist/ip-allowlist) `value` `hash` | 口令只存 `scrypt` hash；`value` 对口令类型存掩码 |

### Step 2：数据库

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `database_connections` | `provider` `status` `encrypted_config` `schema_json` `schema_version` `host` `database` `ssl` `last_tested_at` | 连接串加密存储；`host`/`database` 是**非敏感**信息，便于展示与审计 |
| `database_schemas` | `schema_json` `version` `note` | Schema 快照历史（每次生成/内省一条） |
| `database_migrations` | `name` `sql` `down_sql` `status` `applied_at` `error` | `down_sql` 必填（服务层强制）→ 每条迁移可独立回滚 |

### Step 4：看板

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `dashboards` | `layout_json` `layout_history` `is_default` | `layout_history` 保留最近 20 个快照 → **布局可回滚** |
| `widget_data_sources` | `type` `config_json` `last_value` `last_refreshed_at` `last_error` | 组件数据缓存；首屏读缓存，刷新走服务端调度 |
| `widgets`（复用 + 补列） | `+ position` `size` `data_source` `enabled` | `pinned_to_desktop` 由 0001 已有，Phase 3 直接复用 |

### Step 5：定时任务

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `schedules`（复用 + 补列） | `+ timezone` `task_type` `task_config` `template` `retry_policy` `concurrency` `interrupted_at` | `next_run_at` 持久化 → 进程重启不丢任务 |
| `schedule_runs`（复用 + 补列） | `+ retry_count` `result` `error` `trigger` | `result` 存结构化执行结果，`trigger` 区分自动/手动 |

### Step 6：通知

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `notify_channels` | `type` `encrypted_config` `config` `enabled` `last_tested_at` | 敏感配置加密；`config` 存非敏感项（host/port/to） |
| `notify_logs` | `channel_id` `schedule_run_id` `event` `title` `content` `status` `attempt` `sent_at` `error` | 每次尝试（含重试）都写一条 → 「重试了几次」可查 |

### 审计（3 张）

| 表 | 关键字段 |
| --- | --- |
| `deploy_audits` | `deployment_id` `website_project_id` `action` `actor` `dangerous` `confirmed_by_user` `detail` |
| `db_audits` | `database_connection_id` `action` `actor` `dangerous` `confirmed_by_user` `detail` |
| `schedule_audits` | `schedule_id` `action` `actor` `dangerous` `confirmed_by_user` `detail` |

`detail` 写入前经 `sanitizeDetail()` 脱敏：任何 key 命中 `token|secret|password|pwd|apikey|authorization|connectionstring|url` 都会被掩码。

## 与 Phase 1/2 的兼容处理

| 情况 | 处理 |
| --- | --- |
| 0001 的预留表 `websites` / `notification_channels` | 已被 `website_projects` / `notify_channels` 取代。表保留（不删，避免破坏老数据），代码中不再引用 |
| Phase 1 的 `/widgets` 简版路由 | 已删除全部同名重载，只保留兼容用的 `POST /widgets`（转发到 `DashboardService`）。**原因：HER 路由先声明会遮蔽后声明，导致 404 —— 真实踩坑** |
| Phase 1 的 `ScheduleService` | 保留（旧 UI 仍可用）；Phase 3 的 `ScheduleManager` 是完整实现，两者共用同一张表 |
| `schedules.action` 列 | 保留并继续写入（与 `task_config` 同步），保证老代码可读 |

## 迁移与回滚

```
0001_init.sql        Phase 1 基础（24+ 张表）
0002_phase2.sql      Phase 2（9 张表 + 若干列）
0003_phase3.sql      Phase 3（13 张表 + 若干列）
```

每个文件都有配套 `.down.sql`。执行器（`db/migrate.ts`）的特性：

- **幂等**：`ALTER TABLE ... ADD COLUMN` 会先查 `PRAGMA table_info` 再决定是否执行
  （SQLite 无 `ADD COLUMN IF NOT EXISTS`，且回滚脚本无法删列 → 必须靠存在性检查）；
- **可单条回滚**：`rollback('0003_phase3.sql')` 只删该迁移新增的结构；
- **不跨阶段误伤**：`verify:rollback` 脚本会断言「回滚 0003 后 Phase 1/2 表完好」。

验证命令：

```bash
pnpm --filter @ai/server verify:rollback
# [P3-1] ✅ Phase 3 (13) 表齐全，新增列已生效
# [P3-2] ✅ Phase 3 回滚成功；Phase 1/2 表完好（未跨阶段误伤）
# [P3-3] ✅ Phase 3 迁移可幂等重新应用
# [P3-4] ✅ 功能开关存在，可独立关闭而去数据不丢
```
