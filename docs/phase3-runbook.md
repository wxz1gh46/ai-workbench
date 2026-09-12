# Phase 3 运行手册：部署与数据库、定时任务与通知配置

## 0. 快速开始

```bash
pnpm install --ignore-scripts    # 若环境缺 node-gyp，先跳过脚本再单独 rebuild
pnpm rebuild better-sqlite3      # 原生模块需要编译产物
pnpm typecheck
pnpm test                        # 438 个服务端用例 + 4 个桌面用例
pnpm --filter @ai/desktop build

pnpm dev:server                  # http://127.0.0.1:8787
pnpm dev:desktop                 # http://127.0.0.1:5183
```

> `pnpm install` 在无可编译工具链的容器里会在 `better-sqlite3` 的 postinstall 失败。
> 这是环境问题不是代码问题：用 `--ignore-scripts` 安装后 `pnpm rebuild better-sqlite3`
> 即可（CNB 流水线里能正常编译）。

**不配置任何密钥也能跑通全链路**：模型走离线兜底、部署走 `local-preview`、
通知走桌面 outbox、数据库走「未配置」可读提示。所有降级都显式标注，不会静默冒充真实输出。

## 1. 环境变量

完整清单见 `.env.example`。Phase 3 相关：

```bash
# ---- 加密存储（强烈建议显式配置；未配则生成本机密钥文件）----
WORKBENCH_SECRET_KEY=            # 32+ 位随机串；跨机迁移/多实例必须配置

# ---- 部署平台（按需配置，用哪个配哪个）----
VERCEL_TOKEN=                     # https://vercel.com/account/tokens
CLOUDFLARE_API_TOKEN=             # https://dash.cloudflare.com/profile/api-tokens
CLOUDFLARE_ACCOUNT_ID=            # 控制台右侧 Account ID
CLOUDFLARE_PROJECT=               # 可选：指定 Pages 项目名（回滚/删除需要）
NETLIFY_AUTH_TOKEN=               # https://app.netlify.com/user/applications
NETLIFY_SITE_ID=                  # 可选：复用已有站点（回滚/域名需要）

# ---- 数据库（按需配置）----
NEON_API_KEY=                     # 可选：仅用于「列项目/分支」
SUPABASE_ACCESS_TOKEN=            # 可选：仅用于「列项目」
# 实际连接串不写在 .env 里！通过「数据库面板」输入，加密后入库

# ---- 通知渠道（按需配置；也可在 UI 里创建并加密存储）----
FEISHU_WEBHOOK_URL=
DINGTALK_WEBHOOK_URL=
WECOM_WEBHOOK_URL=
SMTP_URL=
```

### 关于加密密钥

| 情况 | 行为 |
| --- | --- |
| 配了 ≥32 位 `WORKBENCH_SECRET_KEY` | 用它派生密钥（推荐） |
| 配了但 <32 位 | **明确告警**并做 KDF 拉伸 |
| 完全没配 | 生成本机 `data/secrets/local.key`（0o600）并**明确告警** |

更换密钥后旧密文会解密失败（GCM 认证标签校验），表现为「渠道凭据解密失败」，
此时需要重新输入凭据 —— 这是刻意的设计，避免用错误密钥静默读出错数据。

## 2. 部署网站

### 2.1 前置：设置工作区目录

部署中心依赖工作区 `rootPath`（生成的文件写到 `<rootPath>/websites/<项目名>/`）。
到「设置 → 工作区」选择一个本地目录。

### 2.2 操作流程

1. **部署中心 → 新建项目**：填项目名 + 需求描述。
   - 需求描述越具体越好，例如：
     - `做一个公司官网，关于我们、联系我们，暗色科技风`
     - `做一个客户管理系统，有客户和订单，带后台管理界面和登录`
2. 点 **生成项目**：系统解析需求 → 落盘 8~17 个文件。
   左侧会显示解析结果（页面/接口/数据表/样式/访问控制），**先确认理解正确再往下走**。
   - 标了「规则解析（未接模型）」说明没配模型密钥，走的是确定性规则，结果依然可用。
3. 点 **构建检查**：验证入口文件存在、无密钥泄露、体积合理。
4. **环境变量**（可选）：如果需要连接数据库，把 `DATABASE_URL` 填进去（加密存储）。
5. 选择平台 → **一键部署**：
   - `本地预览`：免凭据，返回 `http://127.0.0.1:43xx`，**未发布公网**；
   - `Vercel` / `Cloudflare Pages` / `Netlify`：需要对应 Token，未配会给出明确提示。
6. **部署日志**：实时流式输出（WS 推送 + 落库）。
7. **自定义域名**：输入域名 → 系统给出平台侧绑定结果 + 需要你在 DNS 服务商添加的记录表。
8. **访问控制**：口令 / 邮箱白名单 / IP 白名单。口令只存 scrypt hash。
9. **回滚**：在部署记录里点「回滚」，会把线上提升回该历史版本（新记录 `rollbackOf` 指向原记录）。
10. **删除**：删除单次部署（清理平台侧）或删除整个项目（尽力清理全部平台侧部署）。

### 2.3 平台凭据获取

| 平台 | 获取地址 | 需要的权限 |
| --- | --- | --- |
| Vercel | https://vercel.com/account/tokens | 默认 Full Access 即可 |
| Cloudflare | https://dash.cloudflare.com/profile/api-tokens | `Cloudflare Pages:Edit` + Account 读权限 |
| Netlify | https://app.netlify.com/user/applications#personal-access-tokens | 默认即可 |
| Neon | https://console.neon.tech → Connection Details | 连接串（无需 API Key） |
| Supabase | https://supabase.com/dashboard → Settings → Database | Postgres 连接串 |

> 工作台**不会**代你注册账号或申请 Key。任何「绕过平台限制」的请求都会被拒绝。

## 3. 数据库接入

### 3.1 创建连接

1. **数据库面板 → 选 provider → 填名称 + 连接串 → 新建连接**
   - 连接串形如 `postgres://user:pass@host:5432/db?sslmode=require`
   - 保存后立即 AES-256-GCM 加密，接口只返回 `host/db`
2. 点 **测试连接**：返回版本、延迟、能力探测（可否建表/是否支持 RLS）
3. **从网站需求生成 Schema**：选一个网站项目 → 生成 DDL（含 down 脚本）→ 写入迁移历史
4. **读取现有结构**：从远端内省真实表结构（用于接管已有库）
5. **查询控制台**：
   - 默认 **只读模式**（`BEGIN READ ONLY`），SELECT 会自动补 `LIMIT`
   - 点「预检」可以看到是否被判定为写操作、是否需要二次确认
   - 关闭只读后执行写操作会弹二次确认，并写 `db_audits`
6. **迁移**：在迁移历史里「应用」/「回滚」（都需二次确认）
7. **逻辑备份**：导出结构 + 每表前 100 行样本，带 sha256 校验

### 3.2 安全边界（务必了解）

**被拒绝的 SQL**：
- `DROP DATABASE` / `DROP SCHEMA public`
- `TRUNCATE`
- `GRANT` / `REVOKE` / 修改角色超级权限
- `pg_read_file` / `pg_ls_dir` / `COPY ... FROM PROGRAM`
- `CREATE EXTENSION`（请去控制台装）
- 多语句写（`select 1; drop table t` 这种伪装）

**备份能力边界**：这是**逻辑备份**（结构 + 样本），
完整数据备份请用 `pg_dump`。工作台不下载、不转存你的全量数据。

## 4. 定时任务

### 4.1 创建任务

1. **定时任务 → 选模板（或手动配置）**
   - 模板会自动填好 `taskConfig` 与建议 cron，你只需填空（如研究主题）
2. **Cron 编辑器**：
   - 有常用预设（每天 9 点 / 工作日 / 每周一 …）
   - 输入后立即显示「自然语言描述 + 后续 5 次执行时间」
   - 时区显式选择（默认 `Asia/Shanghai`）
3. **选择推送渠道**（留空 = 推送到全部启用渠道）
4. 创建后可在列表里「启用/停用/立即执行/删除」

### 4.2 任务类型

| 类型 | 需要填什么 | 说明 |
| --- | --- | --- |
| 目标模式 | objective / 验收标准 | 定时创建并自主推进目标 |
| 深度研究 | topic | 需配 `RESEARCH_SEARCH_ENDPOINT` 才能联网 |
| 生成文档 | format / title / content | 输出到工作区 |
| 部署网站 | websiteProjectId / provider | 危险动作，会写审计 |
| 数据查询 | connectionId / sql | **只读**，写 SQL 会被拒绝 |
| 自定义 | payload | 仅触发通知/Webhook |

### 4.3 失败重试

默认 `{ maxRetry: 2, baseDelayMs: 1000, factor: 2, maxDelayMs: 60000 }`，
带 ±20% 抖动避免重试风暴。

**只有可重试的错误才重试**：网络/超时/5xx 会重试；
参数错误（缺 objective）、权限错误、SQL 语法错误会**立即失败**，不浪费重试次数。

「执行历史」里可以看到每次尝试、重试次数、耗时、错误原文与结构化结果。

### 4.4 并发与重启

- 同一任务同时只跑一个实例（in-flight 保护），重复触发记为 `skipped`
- `nextRunAt` 持久化；进程重启后任务不丢
- 启动时**不补跑**错过的任务（只记 warning）—— 避免一次启动触发雪崩

## 5. 通知渠道配置

### 5.1 桌面通知

不需要配置。通知写入 `data/notify/desktop-outbox.jsonl`，
由 Tauri 前端消费并弹系统通知。纯 Node 运行时返回 `degraded: true` 并说明「已记录未弹窗」。

### 5.2 邮件（SMTP）

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| host | `smtp.qq.com` | SMTP 服务器 |
| port | `465` | 465=SSL，587=STARTTLS |
| secure | `true` | 留空则按端口推断 |
| user | `you@qq.com` | 登录名 |
| password | 授权码 | **不是邮箱密码**，去邮箱设置里生成 |
| to | `a@b.com,c@d.com` | 逗号分隔 |

### 5.3 飞书 / 钉钉 / 企业微信

三者都需要先在对应群里创建「自定义机器人」拿 Webhook 地址：

| 平台 | 创建位置 | 安全设置 |
| --- | --- | --- |
| 飞书 | 群设置 → 群机器人 → 添加机器人 → 自定义机器人 | 推荐「签名校验」（填 signSecret）；也可用关键词 |
| 钉钉 | 群设置 → 智能群助手 → 添加机器人 → 自定义 | 推荐「加签」（填 signSecret）；也可用关键词 |
| 企业微信 | 群设置 → 群机器人 → 添加 | 仅 Webhook key |

> 如果选「关键词」校验，请在渠道配置里填 keyword，系统会自动把关键词拼进标题。
> 否则平台会返回 310000/keywords not in content 之类的错误。

### 5.4 通用 Webhook

```jsonc
// 系统会 POST 这样的 body
{
  "event": "schedule",           // schedule | goal | deploy | error | test | manual
  "title": "定时任务完成：每日简报",
  "content": "类型：research\n表达式：0 9 * * *（Asia/Shanghai）…",
  "url": "https://your-site.example.com",
  "level": "success",            // info | success | warning | error
  "at": "2026-03-01T01:00:00.000Z",
  "text": "✅ 定时任务完成：每日简报\n\n类型：research…"   // 纯文本版（飞书/钉钉同款）
}
```

可选填 `authHeader`（会以 `Authorization` 头发送，如 `Bearer xxx`）。

### 5.5 发送日志

「通知设置 → 发送日志」可看到每次尝试：

- `sent` / `failed` / `pending`
- `attempt`（重试次数）
- 关联的 `scheduleRunId`（能反查是哪次任务触发的）
- 错误原文

通知重试策略与任务重试独立（默认 3 次，基准 800ms）。

## 6. 常见问题

**Q：部署失败提示「未配置 vercel 凭据」**
A：这是**预期行为**。设置 `VERCEL_TOKEN` 环境变量后重启服务，或在 `.env` 里配置。
错误里会带上所需变量名与获取地址。

**Q：本地预览地址打不开**
A：本地预览只监听 `127.0.0.1`，且仅在服务进程存活期间有效。
它是「部署前验证」，不是公网托管。要上线请配置真实平台凭据。

**Q：数据库测试连接一直失败**
A：依次检查 ① 连接串里的 `sslmode`（云端必须 `require`）；
② 白名单（Neon/Supabase 默认允许任意 IP，自建库可能需要在防火墙放行）；
③ 本地调试可用 `PGSSLMODE=disable` 覆盖。

**Q：定时任务没执行**
A：① 检查是否 `enabled`；② 看 `nextRunAt` 是否是过去的（说明服务当时没运行，
启动时不补跑）；③ 执行历史里是否有 `skipped`（上一次还没跑完）。

**Q：小组件一直显示「降级」**
A：降级是显式语义，说明该组件的数据源有问题（例如 `data-query` 未配 connectionId）。
点组件刷新后看具体错误信息，不要期待它静默返回空数据。

**Q：怎么关掉 Phase 3 能力？**
A：`config.features.phase3Deploy` / `phase3Schedule` 是功能开关。
关掉后对应接口返回「未启用」，但**数据不丢**（不需要回滚数据库）。

## 7. 运维命令

```bash
pnpm test                       # 全量测试
pnpm --filter @ai/server test:phase3
pnpm --filter @ai/server test:deploy
pnpm --filter @ai/server test:database
pnpm --filter @ai/server test:dashboard
pnpm --filter @ai/server test:schedule
pnpm --filter @ai/server test:notify
pnpm test:e2e                   # 包含 Phase 3 端到端（36 个用例）
pnpm typecheck
pnpm lint

pnpm db:migrate                 # 应用迁移
pnpm db:rollback 0003_phase3.sql  # 单条回滚
pnpm verify:rollback            # 回滚方案端到端验证
```
