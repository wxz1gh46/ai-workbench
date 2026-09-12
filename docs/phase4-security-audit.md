# 安全与审计文档

> 目标读者：安全/合规同学，以及需要评估风险的技术负责人。
> 每一条约束都对应代码位置与测试用例，可逐条核验。

## 1. 安全模型与信任边界

```
┌──────────────────────────────────────────────────────────────┐
│ 信任边界 1：用户 ↔ 工作台服务                                  │
│   · 危险操作必须 confirm=true（服务端强制，无开关可关）         │
│   · RBAC 权限校验（分配角色后严格按角色执行）                   │
├──────────────────────────────────────────────────────────────┤
│ 信任边界 2：工作台 ↔ 插件                                      │
│   · 插件视为不可信：沙箱 + 逐项授权 + 调用日志 + 清单外工具拒绝  │
│   · manifest 哈希防篡改；内容变更强制重新授权                  │
├──────────────────────────────────────────────────────────────┤
│ 信任边界 3：工作台 ↔ 外部平台                                  │
│   · 只走官方 API；endpoint 拒绝内网/元数据地址（SSRF 防护）     │
│   · 凭据仅本地加密存储，不代持、不代理登录                      │
├──────────────────────────────────────────────────────────────┤
│ 信任边界 4：工作台 ↔ 本地文件系统                              │
│   · 路径必须落在工作区根目录内 + 命中授权前缀                   │
│   · 路径穿越直接拒绝（不静默修正）                              │
└──────────────────────────────────────────────────────────────┘
```

## 2. 危险操作二次确认

**服务端强制**：`gate(action, confirm)` 要求 `confirm === true`（严格等于，不接受 `'true'` / `1` / 非空对象）。

```ts
// packages/server/src/security/dangerGate.ts
export function gate(action: string, confirm: unknown, extras = {}): GateResult {
  if (!isDangerous(action)) return { confirmed: true, action, level: 'medium' };
  if (confirm !== true) {
    throw AppError.confirmRequired(`危险操作需二次确认：${summary}`, { action, summary, level });
  }
  ...
}
```

覆盖的 35 类动作：

| 阶段 | 动作 |
| --- | --- |
| Phase 3（15） | `website.delete` `website.deploy` `website.rollback` `deployment.delete` `domain.bind` `access.update` `db.create` `db.migrate` `db.rollback` `db.write` `db.delete` `dashboard.delete` `schedule.delete` `schedule.run` `notify.delete` |
| Phase 4（20） | `plugin.install` `plugin.uninstall` `plugin.revoke` `mcp.server.register` `mcp.server.remove` `paid_data.credential.save` `paid_data.credential.delete` `paid_data.query` `prompt.version.rollback` `cluster.node.remove` `cluster.policy.update` `cluster.election.force` `agent.pool.scale` `aggregated.resolve` `rbac.role.delete` `rbac.assign` `sso.enable` `sso.remove` `retention.apply` `audit.export` |

**测试**：`test/phase4-security.test.ts` 遍历全部 20 个 Phase 4 动作 × 9 种假值（`false/undefined/null/0/''/'true'/1/{}/[]`），断言全部被拒（180 次断言）。
`scripts/verify-phase4.ts` 再次核验 140 次。

**没有关闭开关**。这是刻意的：可关闭的安全措施等于没有。

## 3. 凭据保护

### 落库路径

```
用户输入 → 接口（不入日志）
  → seal(value)  →  AES-256-GCM，输出 `v1:iv:tag:data`（base64url）
  → 只写 paid_data_credentials.encrypted_config
```

### 密钥来源优先级

1. `WORKBENCH_SECRET_KEY`（≥32 位）
2. 本机 `data/secrets/local.key`（0o600），**并明确告警**（不静默降级为明文）
3. 生产/多机部署**必须**用环境变量 —— 否则换机器后旧密文无法解密

### 密钥变更后的行为

`unseal()` 在认证标签校验失败时抛错，而不是返回半截数据。`CredentialManager.resolve()` 把它转成可读错误：

> 「XX 凭据解密失败（通常是 WORKBENCH_SECRET_KEY 变更）。请重新填写凭据。」

### 出参永不返回明文

| 位置 | 处理 |
| --- | --- |
| `POST /paid-data/credentials` 响应 | 只返回 `fieldNames` + `masked`（`****1234`） |
| `GET /paid-data/credentials` | 只返回 `fieldNames` + `status` |
| `audit_logs.detail` | `sanitizeDetail()` 递归脱敏 |
| `plugin_call_logs.args` | `maskArgs()` 递归脱敏 |
| 日志（logger） | 调用方不传凭据；代码中无凭据输出 |

**测试**：`test/phase4-security.test.ts`
- 保存后断言 DB 中不含明文、响应中不含明文、`unseal` 能读回
- 换密钥后断言 `resolve()` 抛错
- 插件调用传 `apiKey` 后断言日志里是 `<redacted>`
- 审计 detail 嵌套 3 层的 `token`/`cookie` 断言被脱敏

## 4. 沙箱与 SSRF 防护

### 网络

拒绝（`assertNetworkAllowed`）：

- 未开启 `allowNetwork` → 全部拒绝
- 协议非 `http/https`（`file:` / `ftp:` / `gopher:` 等）
- 内网/元数据：`127.*` `0.0.0.0` `10.*` `192.168.*` `172.16-31.*` `169.254.*`（含云元数据 `169.254.169.254`）`localhost` `[::1]` `*.local` `metadata.*`
- 非白名单域名（当 `allowedHosts` 非空）

同一套 `isPrivateHost` 判定也用于 **MCP 服务器注册**（注册期即拒，避免运行期 SSRF）和集群节点 host。

### 文件系统

`assertPathAllowed(policy, workspaceRoot, relPath)`：

1. 无工作区根目录 → 拒绝（`NO_WORKSPACE`）
2. `allowedPaths` 为空 → 全部拒绝（`FS_DISABLED`）
3. `path.normalize` 后以 `..` 开头 → 拒绝（`PATH_TRAVERSAL`）
4. 绝对路径解析后越出根目录 → 拒绝（`OUT_OF_WORKSPACE`）
5. 不在授权前缀内 → 拒绝（`PATH_NOT_ALLOWED`）

**关键设计**：**不做「静默修正」**。`../etc/passwd` 直接抛错，而不是被规整成 `etc/passwd` 后悄悄放行。
静默修正的后果是用户以为写成功了，实际写到了别处。

### 资源与并发

| 限制 | 默认 | 超限行为 |
| --- | --- | --- |
| 单次调用超时 | 10s | `TIMEOUT` |
| 并发 | 2 | **排队**（不丢任务） |
| 内存 | 256MB | 声明值超上限直接拒绝 |
| CPU | 10s | 同上 |

## 5. RBAC

### 权限点（20 个）

`workspace:read` `workspace:write` `goal:run` `agent:orchestrate` `cluster:manage`
`plugin:read` `plugin:install` `plugin:grant` `paid_data:read` `paid_data:configure` `paid_data:query`
`prompt:read` `prompt:write` `audit:read` `audit:export` `compliance:manage` `rbac:manage` `sso:manage`
`deploy:run` `database:write`

### 内置角色（6 个）

| 角色 | 权限 | 说明 |
| --- | --- | --- |
| `owner` | 全部 | **不可修改权限、不可删除**（防止把系统锁死） |
| `admin` | 除 `rbac:manage`/`sso:manage` 外全部 | 日常管理 |
| `operator` | 执行类（目标/集群/查询/部署） | |
| `member` | 基础（目标/提示词读写/只读） | |
| `viewer` | 只读 | |
| `auditor` | 审计只读 + 导出 + 合规管理 | 不参与业务 |

内置角色的权限**随版本自动同步**（否则新加的权限点永远拿不到）。

### 关键行为

- **多角色取并集**
- **未分配任何角色时按 `owner` 处理**（本地单机模式可用性优先）；**一旦分配角色就严格按角色执行**
- 校验失败 → **403** 并在 message 里**点名缺失的权限**（不是笼统的「无权限」）

**测试**：断言 viewer 无法通过 `rbac:manage`/`sso:manage`/`cluster:manage`/`plugin:install`/`paid_data:configure`/`retention.apply`；
断言 owner 权限不可被削弱。

## 6. 数据脱敏

### 策略

| 策略 | 行为 | 示例 |
| --- | --- | --- |
| `full` | 全部替换 | `secret` → `****` |
| `partial` | 按形态保留首尾 | `alice@example.com` → `a****@example.com`；`13812345678` → `138****5678`；`6222021234567890` → `6222********7890` |
| `hash` | 可关联不可逆 | `value` → `sha256:1a2b3c4d5e6f7a8b` |
| `nullify` | 置空 | `x` → `null` |

### 内置兜底策略

**用户没配规则时的兜底**（避免「忘了配 = 明文外泄」）：

- `full`：`token` `secret` `password` `pwd` `apikey` `api_key` `authorization` `cookie` `session` `clientsecret` `client_secret` `connectionstring`
- `partial`：`email` `phone` `mobile` `idcard` `id_card` `bankcard` `bank_card`

### 递归深度限制

`maskDeep` 深度上限 6，超出返回 `<max-depth>`。
原因：导出接口会被喂外部数据，恶意构造的超深结构会导致栈溢出。

### 生效范围

脱敏是**输出侧**能力（导出 / API 返回 / 审计展示），不做「入库即脱敏」（那会让业务无法使用数据）。
因此任何对外输出路径**必须显式调用**。为降低漏用概率：

- 审计查询 `AuditQueryService.list()` 内部强制走 `maskDeep`
- 审计导出复用同一路径（**导出内容 = 查询内容**，避免「预览脱敏了、导出没脱敏」）

**测试**：断言嵌套 3 层的 `token`/`apiKey`/`cookie` 被脱敏，非敏感字段不变；
断言导出文件内容不含明文。

## 7. 审计日志

### 记录范围

所有工具调用与用户操作：文件上传、Office 生成/编辑/转换、目标推进、插件安装/授权/调用、付费数据查询、
提示词保存/回滚、集群变更、RBAC 变更、SSO 变更、导出、保留策略执行……

### 字段

`(workspace_id, actor, action, target_type, target_id, dangerous, confirmed_by_user, detail, created_at)`

- `dangerous`：是否属危险动作（自动查表）
- `confirmed_by_user`：是否经过二次确认
- `detail`：**自动脱敏**（`sanitizeDetail` 递归处理）

### 「危险但未确认」是重点

`dangerous=true && confirmed_by_user=false` 的记录会被单独统计（`/audit/logs` 返回的 `stats.unconfirmedDangerous`），
安全中心顶部会红色提示。这类记录要么是历史遗留，要么说明了防护被绕过 —— **必须人工复核**。

### 导出

- **必须带时间范围**（无边界全量导出被拒绝）
- 格式 NDJSON（`detail` 是嵌套结构，CSV 会丢层级）
- 内容**已脱敏**
- 导出行为本身写一条 `audit.export` 审计
- 下载时双重校验：文件路径必须落在 `exports/` 内 **且** 工作区匹配

**已修复的真实缺陷**：`list()` 内部把 limit 夹到 1000，而 `export()` 请求 10000，
导致「导出成功」但只导出了 1/10 的数据。合规导出出现静默截断是不可接受的，已加 `allowLargeLimit` 打破上限。

## 8. 数据保留策略

### 允许的类型（8 个）

`audit_logs` `schedule_runs` `plugin_call_logs` `research_reports` `office_documents` `cost_records` `deployment_logs` `conversations`

### 禁止的类型（5 个）

`users` `workspaces` `goals` `tasks` `agents` —— 删这些等于删库，直接 **403**。

### 动作

`delete`（删除） / `anonymize`（匿名化） / `archive`（标记归档，不删）

### 默认预演

`apply({ dryRun })` 的 `dryRun` **默认为 true**：先算「会影响多少条」给用户看。
`dryRun: false` 需要 `?confirm=true`。

**测试**：断言预演不删除任何数据（对比删除前后行数）。

## 9. SSO 安全

### 只接受环境变量名

`clientSecretRef` 必须是全大写字母数字下划线（`SSO_CLIENT_SECRET`）。
传「像密钥的串」（`sk-*`、`ghp_*`、长度 ≥40 的随机串）或小写/混合大小写 → **400**，message 说明要求格式。

### state + nonce

- `buildAuthUrl()` 生成随机 `state`（防 CSRF）与 `nonce`（防重放），内存保存 10 分钟
- `consumeState()` **用后即焚**：无论校验成功与否都删除该 state
- `nonce` 不匹配 → 拒绝（可能的 id_token 重放）
- 过期（>10 分钟）→ 拒绝

**测试**：断言伪造 state 被拒、nonce 不匹配被拒、重复消费失败。

### 启用保护

密钥环境变量未设置时**不允许启用**（否则用户会在登录页反复失败却不知道为什么）。

## 10. 加密与完整性

| 用途 | 算法 |
| --- | --- |
| 凭据 / 敏感配置 | AES-256-GCM（带认证标签） |
| 口令（网站访问控制） | scrypt |
| manifest 完整性 | sha256（规范化序列化，字段顺序无关） |
| `state` / `nonce` | `randomBytes(16).toString('base64url')` |
| 本机密钥文件 | 0o600 |

## 11. 已知边界与不做的事

**明确不做**（不是「还没做」，是「不会做」）：

- 不绕过任何平台的反爬 / 风控 / 验证码
- 不使用共享账号、不代理登录
- 不代注册账号、不代申请密钥
- 不提供「关闭危险操作确认」的开关
- 不提供「关闭机器人协议遵守」的开关

**已知边界**：

- 单机 SQLite 场景，多实例部署需要把 `EventBus` / `ResultCache` / 限流窗口换成 Redis
- MCP stdio 传输需要宿主进程（未注入时不假装成功，明确返回 degraded）
- SAML 走 IdP 发起，本地不生成授权链接
- 到期保留策略需要外部定时触发（未内置调度器）
- 插件沙箱的「真隔离」依赖宿主（子进程/容器）；当前实现是策略层 + 可单测的纯函数判定

## 12. 核验方法

```bash
pnpm --filter @ai/server typecheck      # 类型安全
pnpm test                               # 710 个用例（含 phase4-security 25 个）
pnpm verify:phase4                      # Phase 4 硬约束逐条核验
pnpm verify:rollback                    # Phase 2/3 回滚验证
grep -rn "confirm" packages/server/src/security/dangerGate.ts   # 确认无关闭开关
```
