# Phase 2 & Phase 3 目录结构与运行命令

> 本文由原 README 拆分而来，保留完整的目录增量与运行命令细节。

## Phase 2 目录结构（增量）

```
packages/server/src/
├── context/                     # 百万 Token 分层上下文
│   ├── contextManager.ts        # 统一入口：存储/组装/压缩/事实/预算/路由/溯源
│   ├── tokenBudget.ts           # 六分区预算 + 输出预留 + 借用 + 截断（纯函数）
│   ├── summarizer.ts            # 滚动摘要（模型优先，离线抽取式兜底）
│   ├── factExtractor.ts         # 事实抽取（规则 + 模型，带分类与溯源）
│   ├── vectorRecall.ts          # 向量 + 关键词混合召回（时间衰减 + 预算截断）
│   └── embedding.ts             # 本地确定性 embedding / 远端可选
├── goals/                       # 目标模式
│   ├── goalEngine.ts            # 编队循环：GoalRun 持久化/并行限流/修正/审计
│   ├── progressTree.ts          # 目标 → 任务 → 子任务（纯函数）
│   ├── reflection.ts            # 重试/换角色/换工具/请求授权/放弃 + 停滞检测
│   └── audit.ts                 # 结构化审计：逐条对齐验收标准并给出证据
├── office/                      # Office 处理
│   ├── zip.ts                   # 零依赖 ZIP 读写（确定性输出）
│   ├── parse.ts                 # docx/xlsx/pptx/pdf 解析（含 PDF 对象流）
│   ├── edit.ts                  # 原地编辑 OOXML（不破坏格式）
│   ├── converter.ts             # LibreOffice headless（可选依赖）
│   └── officeService.ts         # 读取/预览/编辑/生成/转换/版本/导出 + 安全边界
├── research/                    # 深度研究
│   ├── robots.ts                # robots.txt 合规（最长匹配、缓存、保守拒绝）
│   ├── search.ts                # 检索（用户端点优先，否则本地素材）
│   ├── fetch.ts                 # 合规抓取（noindex 尊重、限流、超时、体积上限）
│   ├── crossValidate.ts         # 论断级多源交叉验证（数值冲突检测）
│   ├── citations.ts             # 引用编号 + 一致性校验
│   ├── charts.ts                # Mermaid 图表
│   ├── report.ts                # 结构化报告 + 润色安全校验
│   └── researchEngine.ts        # 11 步流程编排 + 导出 + 网页发布
└── db/migrations/
    ├── 0002_phase2.sql          # Phase 2 表与列
    └── 0002_phase2.down.sql     # 独立回滚脚本

packages/desktop/src/
├── pages/
│   ├── GoalPage.tsx             # 目标模式（进度树 + 阻塞项 + 结构化审计）
│   ├── AgentClusterPage.tsx     # Agent 集群（模式开关 + 节点图 + 消息流 + 看板）
│   ├── OfficeWorkspacePage.tsx  # Office 工作区（预览/编辑/转换/版本/导出）
│   ├── ResearchPage.tsx         # 深度研究（进度/来源/冲突/报告/发布）
│   └── MemoryPanelPage.tsx      # 记忆面板（摘要/事实/预算/召回溯源）
├── components/
│   ├── ProgressTree.tsx         # 进度树
│   ├── TokenBudgetBar.tsx       # Token 预算条
│   ├── TaskBoard.tsx            # 任务看板（取消/改派/抢占）
│   └── AgentNode.tsx            # Agent 节点（状态/任务/最近消息）
└── lib/confirm.ts               # 危险操作确认统一入口（可注入替身）
```

---

## Phase 2 运行命令

```bash
# 全量校验
pnpm typecheck        # 三个包的类型检查
pnpm test             # 全量测试（server 238 + desktop 4）

# 分能力测试
pnpm test:context     # Step 1 分层上下文
pnpm test:security    # Step 8 安全与权限
pnpm --filter @ai/server test:goals      # 目标模式
pnpm --filter @ai/server test:office     # Office 处理
pnpm --filter @ai/server test:research   # 深度研究

# 规模验证（百万 token）
pnpm perf:million

# 迁移与回滚
pnpm db:migrate
pnpm db:rollback 0002_phase2.sql

# 启动
pnpm dev:server       # 后端 :8787
pnpm dev:desktop      # 前端 :5183
```

> **不配置任何密钥也能跑通全链路**：系统进入离线兜底模式，
> 摘要走抽取式、审计走确定性规则、报告走结构化模板，
> 所有降级结果都显式标注 `degraded`，不会静默冒充真实输出。

---

## Phase 3：交付与自动化

Phase 3 把「工作」变成「交付物」：一句话生成网站并部署上线、接入真实数据库、
定制看板、定时自动执行、多渠道推送。

### 能做什么

| 能力 | 说明 | 免凭据可用？ |
| --- | --- | --- |
| 网站生成 | 自然语言 → 页面 + 后端 API + 数据库 Schema（8~17 个文件） | ✅ |
| 一键部署 | Vercel / Cloudflare Pages / Netlify，返回线上 URL | 需平台 Token |
| 本地预览 | 无需任何凭据，本机可访问（仅 127.0.0.1） | ✅ |
| 自定义域名 | 绑定 + DNS 记录指引 + HTTPS 状态 | 需平台 Token |
| 访问控制 | 口令（scrypt）/ 邮箱白名单 / IP 白名单 | ✅ |
| 环境变量 | AES-256-GCM 加密存储，部署时注入，日志无明文 | ✅ |
| 部署日志 | 实时流式（WS）+ 落库回放 | ✅ |
| 回滚 / 删除 | 回滚到历史部署（可追溯 `rollbackOf`）/ 清理平台侧 | ✅ |
| Neon / Supabase | 连接测试 / Schema 生成 / 版本化迁移（可回滚）/ 只读查询 / 备份 | 需连接串 |
| 定制看板 | 自然语言建 7 类小组件 + 拖拽布局 + 布局回滚 + 固定到桌面 + 实时刷新 | ✅ |
| 定时任务 | Cron（含时区）/ 周期 / 一次性 + 6 类任务 + 模板 + 日志 + 指数退避重试 | ✅ |
| 推送通知 | 桌面 / 邮件 / Webhook / 飞书 / 钉钉 / 企业微信 + 发送日志 + 重试 | 桌面免凭据 |

### 安全底线（硬约束，无开关可关）

1. **凭据不落明文**：源码/日志/DB/审计/接口响应中都不出现凭据原文；
   加密算法 AES-256-GCM（带认证标签），口令用 scrypt。
2. **危险操作二次确认**：14 类危险动作在服务端强制校验 `confirm === true`，
   未确认返回 `428 CONFIRM_REQUIRED` + 人类可读后果说明。
3. **只读优先的数据库访问**：三层防护（静态 SQL 校验 + `BEGIN READ ONLY` + 强制 LIMIT）；
   按「整条语句」判定，`select 1; drop table t` 这种伪装写会被拦。
4. **凭据由用户手动配置**：工作台不代注册账号、不申请 Key、不保存登录态。
5. **所有外部调用写审计**：部署/数据库/定时三个分域审计表，`detail` 自动脱敏。
6. **生成产物密钥扫描**：命中常见凭据形态直接拒绝写入，并报出文件与模式。

### 快速体验（无需任何密钥）

```bash
pnpm install --ignore-scripts && pnpm rebuild better-sqlite3
pnpm typecheck && pnpm test          # 438 服务端 + 4 桌面用例
pnpm dev:server && pnpm dev:desktop
```

打开桌面端 → **部署中心**：

1. 在「设置 → 工作区」选一个本地目录
2. 新建项目，需求写：`做一个客户管理系统，有客户和订单，带后台管理`
3. 点「生成项目」→ 左侧会显示解析出的页面/接口/数据表（先确认理解正确）
4. 点「构建检查」→ 验证入口文件、无密钥泄露、体积合理
5. 平台选「本地预览」→ 一键部署 → 拿到 `http://127.0.0.1:43xx` 并能在浏览器打开

配好 `VERCEL_TOKEN` 之类凭据后，把平台换成 Vercel 就是真实上线。

### Phase 3 测试覆盖

```
438 个服务端用例（含 Phase 1/2 的 245 个全部保留通过）
├── deploy/phase3.test.ts       26  需求解析 / 文件生成 / 密钥扫描 / 打包 / 域名 / 闸门
├── database/phase3.test.ts     28  加密存储 / SQL 静态校验 / Schema / RLS / 适配器降级 / 备份
├── dashboard/phase3.test.ts    18  7 类组件注册 / 自然语言推断 / 布局引擎 / 快照回滚 / 数据源降级
├── schedule/phase3.test.ts     33  cron 解析与描述 / 时区 nextRun / 模板 / 执行器 / 指数退避
├── notify/phase3.test.ts       21  6 渠道校验 / 真实 HTTP 发送（本地假服务）/ 签名 / 超时
├── test/phase3-e2e.test.ts     36  生成→构建→部署→域名 / 看板→组件→刷新 / 任务→执行→推送
├── test/phase3-security.test.ts 20 凭据不落明文 / 危险动作全覆盖 / SQL 注入 / 路径穿越 / 监听地址
└── test/phase3-perf.test.ts     9  cron 计算 / 200 组件布局 / 并发上限 / 刷新扫描
```

运行：`pnpm test` / `pnpm --filter @ai/server test:phase3` / `pnpm verify:rollback`

### 文档

| 文档 | 内容 |
| --- | --- |
| [docs/phase3-architecture.md](docs/phase3-architecture.md) | 架构增量、7 个关键设计决策、目录结构、端到端数据流 |
| [docs/phase3-data-model.md](docs/phase3-data-model.md) | 13 张新表逐字段说明、与 Phase 1/2 的兼容处理、迁移与回滚 |
| [docs/phase3-api.md](docs/phase3-api.md) | 全部接口（含请求/响应示例、错误码、WS 事件表） |
| [docs/phase3-runbook.md](docs/phase3-runbook.md) | 部署/数据库/定时任务/通知的配置手册 + 常见问题 |
| [docs/phase3-rollback.md](docs/phase3-rollback.md) | L1~L5 分级回滚策略 + 各 Step 独立回滚 |

### 打包上传 GitHub

```bash
# 打包（自动扫描凭据，命中即中止）
./scripts/package-for-github.sh

# 创建私人仓库并推送（Token 只从环境变量读，不写入 git 配置、不回显）
GITHUB_TOKEN=ghp_xxx ./scripts/upload-github.sh --repo ai-workbench
```
