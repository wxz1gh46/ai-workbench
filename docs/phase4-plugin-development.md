# 插件开发文档（MCP 优先）

> 目标读者：想给这个工作台写插件的开发者。
> 先读 `phase4-architecture.md` 了解插件在系统中的位置。

## 1. 三种插件形态

| 形态 | `kind` | 通信方式 | 适用场景 |
| --- | --- | --- | --- |
| MCP 服务器 | `mcp` | stdio / http / sse / websocket + JSON-RPC 2.0 | **首选**。已有 MCP 生态的工具直接用 |
| HTTP 插件 | `http` | 官方 REST API | 付费数据源（同花顺/天眼查等） |
| 本地桥接 | `local` | 本机进程（如 Wind 终端） | 需要本机已授权软件的金融终端 |
| WebSocket 插件 | `websocket` | 长连接双向 | 需要服务端推送的场景 |

## 2. 清单（manifest）规范

```ts
interface PluginManifest {
  name: string;             // 唯一标识，如 mcp-filesystem
  version: string;          // 语义化版本
  author: string;
  description: string;      // 一句话说清「做什么」，不要写营销词
  kind: 'mcp' | 'http' | 'websocket' | 'local';
  source: string;           // market://... 或 https://...
  permissions: {            // 权限声明（用户逐项授权）
    scope: string;          // 命名：资源:动作，如 fs:read / net:http / paid:market-data
    description: string;    // 说清「授权后能做什么」，不要含糊
    sensitive: boolean;     // true 时 UI 会显著标注
    required?: boolean;     // 默认 true
  }[];
  tools: {                  // 工具列表（调用清单外工具会被拒绝）
    name: string;
    description: string;
    dangerous?: boolean;    // true 时每次调用都要二次确认
    requires?: string[];    // 依赖的权限点
    input?: Record<string, unknown>;
  }[];
  resources?: { uri: string; description: string }[];
  prompts?: { name: string; description: string }[];
  requiresUserAuth: boolean; // 付费/敏感数据源必须为 true
  secretRefs: string[];      // 需要用户提供的凭据「变量名」（只存名，不存值）
  sandbox: boolean;          // 必须为 true
  signature?: string;        // `sha256:<hash>`，由 hashManifest 计算
  config?: Record<string, unknown>;
}
```

### 最小可用示例

```ts
import type { PluginManifest } from '/src/plugins/pluginManifest.ts';

export const manifest: PluginManifest = {
  name: 'my-mcp-tools',
  version: '1.0.0',
  author: 'your-name',
  description: '把内部工单系统暴露为 MCP 工具（只读）',
  kind: 'mcp',
  source: 'market://internal/ticket',
  permissions: [
    { scope: 'net:http', description: '调用内部工单 API', sensitive: true, required: true },
  ],
  tools: [
    { name: 'ticket.search', description: '按关键字检索工单', requires: ['net:http'],
      input: { keyword: 'string', limit: 'number' } },
  ],
  requiresUserAuth: true,
  secretRefs: ['TICKET_API_TOKEN'],
  sandbox: true,
};
```

把它加入 `packages/server/src/plugins/pluginMarket.ts` 的 `PLUGIN_MARKET` 数组即可出现在市场里。

## 3. 合规红线（`assertCompliant` 会拒绝）

以下是**硬编码在代码里**的拒绝规则，不接受任何 override：

| 命中内容 | 拒绝原因 |
| --- | --- |
| `bypass-anti-crawler` / `绕过反爬` | 声明绕过反爬 |
| `绕过风控/验证码/限制` | 声明绕过平台风控 |
| `shared-account` / `共享账号` | 使用共享账号 |
| `cracked-api` / `破解` / `盗版` | 破解授权 |
| `steal-cookie` / `盗取登录态` | 盗用登录态 |
| `paid:*` 权限但 `requiresUserAuth: false` | 付费数据必须要求用户手动授权 |
| `sessionRefs` 为空但 `requiresUserAuth: true` | 用户无从配置凭据 |
| `sandbox: false` | 插件必须在沙箱中运行 |

**核对清单**（提交前逐条自查）：

- [ ] 只使用目标平台的**官方 API 或用户本机已授权的客户端**
- [ ] 不代理登录、不代持账号、不保存平台登录态
- [ ] 不包含任何硬编码密钥（用 `secretRefs` 声明变量名）
- [ ] 权限粒度足够细（不要一个 `root:everything` 打天下）
- [ ] 所有会产生副作用的操作标 `dangerous: true`
- [ ] 遵守目标平台的 robots.txt 与频率限制（在 `config` 里声明）

## 4. 签名与完整性

```ts
import { hashManifest, verifySignature } from '/src/plugins/pluginManifest.ts';

const hash = hashManifest(manifest);          // 字段顺序无关的 sha256
const signed = { ...manifest, signature: `sha256:${hash}` };
console.log(verifySignature(signed));         // { signed: true, ok: true, hash }
```

**哈希是字段顺序无关的**：`normalizeManifest()` 会按固定顺序序列化（权限按 scope 排序、工具按 name 排序、数组排序）。
否则「同一份清单在不同机器上哈希不同」，重新安装就会误报「内容被篡改」。

安装时若发现库中 `manifest_hash` 与当前不一致，会**撤销该插件的全部授权**，强制用户重新确认：
这是防「插件更新悄悄新增一条敏感权限」的关键机制。

## 5. 沙箱约束

插件运行在策略沙箱中，宿主会强制以下限制：

| 维度 | 限制 | 违反时 |
| --- | --- | --- |
| 网络 | 默认禁用；允许后禁止内网/云元数据地址（`127.*`、`10.*`、`192.168.*`、`172.16-31.*`、`169.254.*`、`localhost`、`*.local`） | `SandboxViolation` |
| 协议 | 仅 `http` / `https` | `SandboxViolation` |
| 域名 | 可配白名单；非白名单域名拒绝 | `HOST_NOT_ALLOWED` |
| 文件系统 | 路径必须落在工作区内 + 命中授权前缀；**路径穿越直接拒绝（不静默修正）** | `PATH_TRAVERSAL` / `OUT_OF_WORKSPACE` |
| 超时 | 单次调用默认 10s | `TIMEOUT` |
| 并发 | 默认 2（超出排队而非丢弃） | — |
| 资源 | 内存 256MB / CPU 10s（声明值超出策略上限直接拒绝） | `MEMORY_TOO_LARGE` 等 |

**注意 `assertPathAllowed` 不做「静默修正」**：`../etc/passwd` 会抛错而不是被规整成 `etc/passwd`。
静默修正的后果是用户以为写成功了，实际写到了别处。

## 6. 调用日志与脱敏

所有调用（成功/失败/被拒）都会写 `plugin_call_logs`，入参在写入前经过 `maskArgs()`：

- key 命中 `token|secret|password|apikey|authorization|cookie|session` → `<redacted>`
- 字符串超过 2000 字符 → 截断
- 嵌套对象递归处理（深度上限 4），数组只保留前 50 项

**自测方法**：调用时故意传一个 `apiKey: 'xxx'`，然后在插件市场的「调用日志」里确认显示为 `<redacted>`。

## 7. 本地调试

```bash
# 1) 注册 MCP 服务器（http 传输，注意不能指向内网）
curl -X POST 'http://127.0.0.1:8787/mcp/servers?confirm=true' \
  -H 'content-type: application/json' \
  -d '{"workspaceId":"<ws>","name":"my-tools","transport":"http","endpoint":"https://mcp.example.com/rpc"}'

# 2) 探测并同步工具
curl -X POST 'http://127.0.0.1:8787/mcp/servers/<id>/sync?workspaceId=<ws>'

# 3) 安装插件 + 授权 + 调用
curl -X POST 'http://127.0.0.1:8787/plugins/install?name=my-mcp-tools&confirm=true' -d '{"workspaceId":"<ws>"}'
curl -X POST 'http://127.0.0.1:8787/plugins/<installationId>/grant' -d '{"workspaceId":"<ws>","scopes":["net:http"]}'
curl -X POST 'http://127.0.0.1:8787/plugins/<installationId>/invoke' \
  -d '{"workspaceId":"<ws>","tool":"ticket.search","args":{"keyword":"支付"}}'
```

stdio 传输需要一个宿主进程。当前实现**不会假装成功**：未注入宿主时
`listTools()` 返回 `{ tools: [], degraded: true }`，`callTool()` 返回 `ok: false` + 可读错误。
要在测试或宿主里注入执行器：

```ts
const runtime = new PluginRuntime(db);
runtime.registerExecutor('my-mcp-tools', async (tool, args) => {
  if (tool.name === 'ticket.search') return await fetchTickets(args.keyword);
  throw new Error(`未实现的工具：${tool.name}`);
});
```

## 8. 好插件的标准

1. **权限最小化**：只声明真的需要的能力。用户看到 5 个敏感权限会直接不装
2. **工具粒度合理**：一个工具做一件可命名的事，不要 `do_everything(what: string)`
3. **危险操作显式标注**：写文件、删除、发送消息都要 `dangerous: true`
4. **失败信息可读**：报「缺少参数 symbol」而不是 `TypeError: undefined`
5. **降级要诚实**：拿不到数据就说拿不到，不要返回 0 或空对象让调用方以为「查询成功但没有结果」
6. **幂等**：同一个调用重复执行不应产生两份副作用
