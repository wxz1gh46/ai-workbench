# 付费数据库接入合规文档

> 目标读者：需要接入自费数据源的业务方，以及需要评估合规风险的合规/法务同学。
> 结论先行：**本工作台只做「你已合法拥有的数据」的本地编排**。它不代注册账号、不申请密钥、不共享登录态、不绕过任何平台限制。

## 1. 已支持的 8 家数据源

| ID | 名称 | 类型 | 接入方式 | 凭据 | 本地限流 |
| --- | --- | --- | --- | --- | --- |
| `tonghuashun` | 同花顺 iFinD 开放平台 | 行情 | 同花顺官方开放平台 API（HTTP + sha256 签名） | `appKey` + `appSecret` | 60/min |
| `tianyancha` | 天眼查开放平台 | 工商司法 | 天眼查官方开放平台 API（`Authorization: Token`） | `token` | 30/min |
| `wind` | Wind 万得金融终端 | 金融 | **本机终端授权桥接**（需已购买并登录 Wind） | `windPath`（终端路径） | 20/min |
| `hs-juyuan` | 恒生聚源 | 金融 | 恒生聚源官方 API（`x-api-key`） | `apiKey` | 60/min |
| `sp-global` | S&P Global Market Intelligence | 全球市场 | S&P Global 官方 API（`x-api-key`） | `apiKey`（+ `accountId`） | 30/min |
| `imf` | IMF 国际货币基金组织 | 宏观 | IMF 官方开放数据接口（DataMapper） | **无需凭据** | 30/min |
| `hyyd-legal` | 华宇元典法律数据库 | 法律 | 华宇元典官方 API（`Bearer`） | `token` | 30/min |
| `academic` | 学术数据库（Crossref / OpenAlex） | 学术 | 官方开放 REST API | 可选 `mailto` | 60/min |

**没有的内容**：爬虫、逆向接口、非官方 SDK、共享账号池、验证码绕过、代理出口池。这些能力**从代码层面就不存在**。

## 2. 三道合规防线

### 防线 1：注册表声明即约束（`providerRegistry.ts`）

每个 Provider 必须声明：

```ts
accessMethods: string[];   // 官方接入方式（UI 上直接展示给用户）
requiresUserAuth: boolean; // 是否必须由用户自己提供凭据
credentialFields: { key, label, required, hint }[];  // 只索取必要字段
rateLimit: { perMinute, note };
docsUrl: string;           // 官方文档地址（用户可自行核对）
```

**注意**：`actions` 里声明的动作之外的操作会被拒绝（`UNKNOWN_ACTION`）——
不存在「传个野生 action 字符串就能查任意东西」的路径。

### 防线 2：合规守卫（`complianceGuard.ts`）

每次查询前判定，返回可读拒因：

| 检查 | 拒绝原因示例 |
| --- | --- |
| Provider / action 是否存在 | `未知的付费数据源：xxx` |
| 参数里是否出现滥用意图 | 见下表 |
| 需要凭据的 Provider 是否已配置 | `天眼查开放平台 需要你手动配置凭据后才能查询。接入方式：天眼查官方开放平台 API` |

滥用意图检测（正则，命中即拒）：

| 模式 | 拦截原因 |
| --- | --- |
| `bypass.*(rate.?limit\|限流\|限速\|配额)` | 请求绕过平台限流，不符合官方 API 使用条款 |
| `(crawl\|spider\|scrap\|爬虫\|爬取\|抓站)` | 请求使用爬虫方式抓取，不允许（必须走官方 API） |
| `(bulk\|dump\|全量\|批量导出\|镜像全库)` | 请求全量导出/镜像数据，超出授权范围 |
| `(shared\|共享).*(account\|账号\|token)` | 请求使用共享账号，违反平台条款 |
| `(crack\|破解\|盗版)` | 请求涉及破解授权 |
| `(captcha\|验证码).*(bypass\|绕过\|破解)` | 请求绕过验证码 |

**被拒绝的查询也会落库**（`paid_data_queries.status='blocked'` + `blocked_reason`），
这不是「惩罚」而是「留痕」：审计需要能回答「谁在什么时候试图绕过限制」。

`POST /paid-data/preflight` 让你在真正提交前就知道会不会被拒（UI 上会先跑一次）。

### 防线 3：本地限流与审计

- **限流**：按 `rateLimit.perMinute` 做 60s 滑动窗口，超出返回 **429** + `retryAfterMs`。
  这是**本地**强制，不依赖对方限流生效 —— 避免「因为对方没拦，我们就猛打」。
- **审计**：每次查询写一条 `audit_logs`（`action='paid_data.query'`），`detail` 含 action/status/cached/degraded/blockedReason，
  并可带 `purpose`（用途说明，强烈建议填写，用于回答「为什么查了这家企业」）。
- **引用**：结果必须带 `citations`（来源标题 + URL + 访问时间 + provider），否则结果无法溯源。

## 3. 凭据如何保管

```
用户输入（UI）→ POST /paid-data/credentials
  → CredentialManager.save()
      · 只接受 provider 声明过的字段（未知字段 → 400）
      · 默认与已有值合并（避免「只想换 Token，结果密钥被清空」）
      · seal()  → AES-256-GCM 加密（格式 v1:iv:tag:data）
  → 落库 paid_data_credentials.encrypted_config（密文）
```

加密密钥来源（`security/secrets.ts`）：

1. `WORKBENCH_SECRET_KEY`（环境变量，≥32 位，**生产/多机必须配**）
2. 未配置时派生自本机 `data/secrets/local.key`（0o600），并**明确告警**（不静默降级为明文）
3. 密钥变更后旧密文解密失败 → 抛「凭据解密失败（通常是 WORKBENCH_SECRET_KEY 变更），请重新填写凭据」
   —— **不会静默读出错数据**

凭据**永不出现**在：源码、日志、`audit_logs.detail`、`plugin_call_logs.args`、接口响应。
接口只返回 `fieldNames` + `masked`（如 `****1234`）。

## 4. 你需要自己做的事

工作台**不会**替你做以下任何一件：

| 事项 | 为什么 | 怎么做 |
| --- | --- | --- |
| 注册数据平台账号 | 涉及实名与企业资质 | 到各平台官网自行注册 |
| 申请 API Key / 订阅套餐 | 涉及付费合同 | 在平台控制台申请并购买 |
| 阅读并同意平台条款 | 法律主体是你，不是本工具 | 逐条阅读，特别关注「数据使用范围」 |
| 确认数据可用于你的场景 | 部分数据源禁止转售/对外分发 | 咨询你的法务 |
| 保管凭据 | 泄露责任在你 | 用环境变量或本工作台加密存储，不要贴到聊天/Issue 里 |
| 本机授权软件（Wind） | 许可与登录态属于你 | 自行安装 Wind 终端并登录 |

## 5. 使用前的自查清单

- [ ] 我**已经**在对应平台注册并购买了相应权限
- [ ] 我的凭据是**通过环境变量或本工作台凭据面板**配置的，没有写在代码/配置/Issue 里
- [ ] 我知道这个数据源的使用范围限制（能否对外展示、能否落库、能否二次分发）
- [ ] 我填了 `purpose`（用途说明），未来被问「为什么查这个」时能回答
- [ ] 我没有依赖本工具做「本工具做不到」的事（批量爬取、绕过限制、共享账号）

## 6. 常见问题

**Q：为什么我配置了凭据，查询还是返回 `degraded: true`？**
A：说明凭据已配置但接口调用失败（网络不通 / 配额用尽 / IP 未在白名单 / 账号无该接口权限）。
`note` 字段会说明具体原因。降级结果**不会写缓存**，所以修好后立刻能拿到真数据。

**Q：为什么返回 `status: "blocked"`？**
A：被合规守卫拦下了。`blockedReason` 会写明原因（最常见的是「未配置凭据」或「参数里含绕过限流的表述」）。

**Q：我看到 429 `RATE_LIMITED`，是我的配额用完了吗？**
A：不是。这是**本地**限流（按 provider 声明保守设置），`details.retryAfterMs` 告诉你还要等多久。
实际是否触发对方配额由你自己的账号决定。

**Q：能加一个「免费代理池」提高并发吗？**
A：不会加。使用代理池规避平台限流属于条款违反，与本项目的合规底线冲突。

**Q：我想接一个没在列表里的数据源。**
A：在 `providerRegistry.ts` 加声明 + 在 `adapterFactory.ts` 加实现（或先走 `StubAdapter` 显式降级）。
如果它需要凭据，**必须**把 `requiresUserAuth` 设为 `true` 并声明 `secretRefs`，否则 `assertCompliant` 会拒绝。
