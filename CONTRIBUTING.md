# 贡献指南

感谢你愿意参与 AI 工作台。本项目遵循「先计划、再编码、再测试」的节奏，请先读完本指南再动手。

## 开发环境

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 22.6 | CI 使用 Node 22（`--experimental-transform-types` 所需） |
| pnpm | ≥ 9 | 仓库指定 `pnpm@9.12.0` |
| Rust | 1.77+ | 仅构建 Tauri 桌面壳时需要 |
| build-essential + python3 | — | `better-sqlite3` 原生编译所需 |
| LibreOffice | 可选 | 跨格式文档转换所需 |

```bash
git clone https://github.com/wxz1gh46/ai-workbench.git
cd ai-workbench
pnpm install
cp .env.example .env
```

> 若 `better-sqlite3` 预编译包不可用，需要本机编译：
> `apt-get install -y build-essential python3-dev && npm i -g node-gyp`

## 本地校验（提交前必须全绿）

```bash
pnpm typecheck     # 三个包的 tsc --noEmit
pnpm test          # 全部单元 + 端到端测试
pnpm lint          # 当前等同 typecheck
```

单项测试：

```bash
pnpm test:context                       # 分层上下文
pnpm test:security                      # 安全与权限
pnpm --filter @ai/server test:phase3    # Phase 3 全量
pnpm --filter @ai/server test:office    # Office 处理
```

## 提交规范

采用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat(scope):     新功能
fix(scope):      缺陷修复
docs(scope):     文档
test(scope):     测试
refactor(scope): 重构（不改变行为）
chore(scope):    构建/工具链
```

- `scope` 用模块名，如 `cluster`、`plugins`、`paid-data`、`prompt`、`enterprise`、`ci`。
- 一个 PR 尽量只做一件事；小步提交，便于回滚。

## 硬性约束（违反会被拒绝）

这些约束有单测覆盖，请勿绕过：

1. **不硬编码任何密钥**：Token / API Key / 数据库凭据只从环境变量或 OS Keychain 读取。
2. **不破坏既有阶段**：Phase 1/2/3 的测试必须保持通过。
3. **危险操作必须二次确认**：服务端强制校验 `confirm === true`，未确认返回 `428`。
4. **所有外部调用写审计日志**：付费数据源、插件、集群、SSO 均需分域审计。
5. **合规红线**：不得实现绕过反爬 / 验证码 / 共享账号 / 破解授权的能力。
6. **每个阶段可回滚**：新增能力必须提供功能开关或回滚脚本。

## 提交 PR

1. Fork 或从主分支切出特性分支。
2. 保证 `pnpm typecheck && pnpm test` 全绿。
3. 填写 PR 模板中的检查清单。
4. 若改动涉及数据库，附上 `.sql` 与 `.down.sql`。
5. 若改动涉及新依赖，在 PR 描述中说明理由与替代方案。

## 架构约定

- 领域逻辑（DAG、Token 估算、审计判定等）写成**纯函数/纯类**，与 Hono、DB 解耦，便于 `node:test` 直接覆盖。
- 类型定义放 `packages/shared`，前后端共享，避免双份漂移。
- 新增表结构必须同时提供正向与反向迁移脚本。
- 详细决策见 [DECISIONS.md](DECISIONS.md)。

## 文档

- 架构说明放 `docs/`，按 Phase 分文件。
- 用户可见的行为变化要同步更新 `CHANGELOG.md`。
