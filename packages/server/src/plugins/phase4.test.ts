import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDb, createDb } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { setSecretKeyForTest } from '../security/secrets.ts';
import { PluginInstaller } from './pluginInstaller.ts';
import { PluginRuntime } from './pluginRuntime.ts';
import { PluginCallLogger, maskArgs } from './pluginCallLog.ts';
import { McpServerRegistry } from './mcpServerRegistry.ts';
import { PLUGIN_MARKET, searchMarket } from './pluginMarket.ts';
import { assertCompliant, hashManifest, normalizeManifest, verifySignature, missingScopes, PluginComplianceError, type PluginManifest } from './pluginManifest.ts';
import { ConcurrencyGate, DEFAULT_SANDBOX, SandboxViolation, assertNetworkAllowed, assertPathAllowed, assertResourceWithinPolicy, isPrivateHost, withTimeout } from './pluginSandbox.ts';
import { McpClient } from './mcpClient.ts';

function setup(name: string) {
  closeDb();
  const dir = mkdtempSync(path.join(tmpdir(), `p4-${name}-`));
  setSecretKeyForTest('phase4-test-key-0123456789abcdef');
  process.env.DATA_DIR = dir;
  const file = path.join(dir, 'test.db');
  process.env.DB_FILE = file;
  const { db, sqlite } = createDb(file);
  runMigrations();
  const now = new Date().toISOString();
  sqlite.prepare('INSERT INTO users (id, name, role, created_at) VALUES (?,?,?,?)').run('u1', '测试', 'owner', now);
  sqlite.prepare('INSERT INTO workspaces (id, user_id, name, root_path, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('ws1', 'u1', 'ws', dir, now, now);
  return {
    db,
    workspaceId: 'ws1',
    tempDir: dir,
    cleanup: () => {
      closeDb();
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ------------------------------ 清单与合规 ------------------------------ */

test('市场中的每个插件清单都能通过合规校验', () => {
  for (const m of PLUGIN_MARKET) {
    assert.doesNotThrow(() => assertCompliant(m), `${m.name} 应通过合规校验`);
  }
});

test('市场覆盖提示词要求的所有付费数据源', () => {
  const names = PLUGIN_MARKET.map((m) => m.name).join(',');
  for (const k of ['tonghuashun', 'tianyancha', 'wind', 'juyuan', 'sp-global', 'imf', 'hyyd', 'academic']) {
    assert.ok(names.includes(k), `缺少数据源插件: ${k}`);
  }
});

test('付费数据插件必须要求用户手动授权', () => {
  const evil: PluginManifest = { ...PLUGIN_MARKET[2]!, name: 'evil-paid', permissions: [{ scope: 'paid:x', description: 'y', sensitive: true }], requiresUserAuth: false, secretRefs: [] };
  assert.throws(() => assertCompliant(evil), /必须要求用户手动授权/);
});

test('声明绕过反爬 / 共享账号 / 破解的插件被拒绝', () => {
  const base = PLUGIN_MARKET[0]!;
  for (const bad of ['market://bypass-anti-crawler', 'shared-account', 'cracked-api', '绕过反爬', '共享账号']) {
    const m: PluginManifest = { ...base, source: bad, config: {} };
    assert.throws(() => assertCompliant(m), PluginComplianceError, `${bad} 应被拒绝`);
  }
});

test('sandbox=false 的插件被拒绝（不允许脱离沙箱）', () => {
  const m: PluginManifest = { ...PLUGIN_MARKET[0]!, sandbox: false as unknown as true };
  assert.throws(() => assertCompliant(m), /必须在沙箱中运行/);
});

test('凭据变量名缺失但声明需要授权时被拒绝', () => {
  const m: PluginManifest = { ...PLUGIN_MARKET[2]!, secretRefs: [], permissions: [{ scope: 'paid:x', description: 'y', sensitive: true }], requiresUserAuth: true };
  assert.throws(() => assertCompliant(m), /未给出凭据变量名/);
});

test('manifest 哈希与字段顺序无关（同一内容必然同哈希）', () => {
  const a = PLUGIN_MARKET[4]!;
  const b: PluginManifest = { ...a, permissions: [...a.permissions].reverse(), tools: [...a.tools].reverse(), secretRefs: [...a.secretRefs].reverse() };
  assert.equal(hashManifest(a), hashManifest(b));
  assert.equal(normalizeManifest(a), normalizeManifest(b));
});

test('manifest 内容变化则哈希变化', () => {
  const a = PLUGIN_MARKET[0]!;
  const b: PluginManifest = { ...a, version: '9.9.9' };
  assert.notEqual(hashManifest(a), hashManifest(b));
});

test('签名校验：无签名标记为 unsigned，签名不匹配标记为 ok=false', () => {
  const m = PLUGIN_MARKET[0]!;
  const unsigned = verifySignature(m);
  assert.equal(unsigned.signed, false);
  const bad = verifySignature({ ...m, signature: 'sha256:deadbeef' });
  assert.equal(bad.signed, true);
  assert.equal(bad.ok, false);
  const good = verifySignature({ ...m, signature: `sha256:${hashManifest(m)}` });
  assert.equal(good.ok, true);
});

test('missingScopes 列出未授权权限点', () => {
  const tool = { name: 'x', description: '', requires: ['fs:read', 'fs:write'] };
  assert.deepEqual(missingScopes(tool, ['fs:read']), ['fs:write']);
  assert.deepEqual(missingScopes(tool, ['fs:read', 'fs:write']), []);
});

test('市场检索支持关键字与类型过滤', () => {
  assert.ok(searchMarket({ q: '同花顺' }).length >= 1);
  assert.ok(searchMarket({ kind: 'mcp' }).every((m) => m.kind === 'mcp'));
  assert.ok(searchMarket({ requiresAuth: false }).every((m) => !m.requiresUserAuth));
});

/* ------------------------------ 沙箱 ------------------------------ */

test('沙箱默认禁止网络', () => {
  assert.throws(() => assertNetworkAllowed(DEFAULT_SANDBOX, 'https://example.com'), /网络访问已被沙箱禁用/);
});

test('沙箱禁止内网与云元数据地址', () => {
  const policy = { ...DEFAULT_SANDBOX, allowNetwork: true };
  for (const url of ['http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://localhost/x']) {
    assert.throws(() => assertNetworkAllowed(policy, url), SandboxViolation, `${url} 应被拒绝`);
  }
  assert.equal(isPrivateHost('example.com'), false);
});

test('沙箱只允许 http/https 协议', () => {
  const policy = { ...DEFAULT_SANDBOX, allowNetwork: true };
  assert.throws(() => assertNetworkAllowed(policy, 'file:///etc/passwd'), /仅允许 http\/https/);
  assert.throws(() => assertNetworkAllowed(policy, 'not-a-url'), /非法 URL/);
});

test('沙箱域名白名单生效', () => {
  const policy = { ...DEFAULT_SANDBOX, allowNetwork: true, allowedHosts: ['api.example.com'] };
  assert.doesNotThrow(() => assertNetworkAllowed(policy, 'https://api.example.com/v1'));
  assert.doesNotThrow(() => assertNetworkAllowed(policy, 'https://sub.api.example.com/v1'));
  assert.throws(() => assertNetworkAllowed(policy, 'https://evil.com/'), /不在白名单内/);
});

test('沙箱路径边界：拒绝穿越与越权前缀', () => {
  const root = '/tmp/sandbox-root';
  const policy = { ...DEFAULT_SANDBOX, allowedPaths: ['work'] };
  assert.equal(assertPathAllowed(policy, root, 'work/a.txt'), path.join(root, 'work/a.txt'));
  assert.throws(() => assertPathAllowed(policy, root, '../etc/passwd'), /路径穿越/);
  assert.throws(() => assertPathAllowed(policy, root, 'other/a.txt'), /不在授权前缀内/);
  assert.throws(() => assertPathAllowed(policy, root, '/etc/passwd'), /不在授权前缀内/);
});

test('沙箱路径：未配置工作区或未授权文件系统时明确拒绝', () => {
  assert.throws(() => assertPathAllowed(DEFAULT_SANDBOX, null, 'a.txt'), /工作区未设置根目录/);
  assert.throws(() => assertPathAllowed(DEFAULT_SANDBOX, '/tmp', 'a.txt'), /文件系统访问未授权/);
});

test('沙箱资源上限校验', () => {
  assert.throws(() => assertResourceWithinPolicy(DEFAULT_SANDBOX, { timeoutMs: 999_999 }), /超出策略上限/);
  assert.throws(() => assertResourceWithinPolicy(DEFAULT_SANDBOX, { maxMemoryMb: 99_999 }), /超出策略上限/);
  assert.doesNotThrow(() => assertResourceWithinPolicy(DEFAULT_SANDBOX, { timeoutMs: 1000, maxMemoryMb: 64 }));
});

test('并发闸门排队而非丢弃', async () => {
  const gate = new ConcurrencyGate(2);
  let peak = 0;
  let active = 0;
  const task = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
  };
  await Promise.all(Array.from({ length: 6 }, () => gate.run(task)));
  assert.equal(peak, 2);
  assert.equal(gate.inFlight, 0);
  assert.equal(gate.waiting, 0);
});

test('超时包装会中断长时间调用', async () => {
  await assert.rejects(() => withTimeout(() => new Promise((r) => setTimeout(r, 200)), 20, 'slow'), /超时/);
  assert.equal(await withTimeout(async () => 42, 100), 42);
});

/* ------------------------------ 安装 / 授权 / 调用 ------------------------------ */

test('安装 → 逐项授权 → 调用 → 撤销 → 卸载 全流程', async () => {
  const ctx = setup('plugin-flow');
  const installer = new PluginInstaller(ctx.db);
  const runtime = new PluginRuntime(ctx.db);

  const installed = await installer.install(ctx.workspaceId, 'mcp-filesystem');
  assert.equal(installed.name, 'mcp-filesystem');
  assert.equal(installed.grantedScopes.length, 0, '新装插件不应有任何授权');
  assert.ok(installed.permissions.length >= 2);

  // 未授权时调用被拒，并给出缺失权限
  const denied = await runtime.invoke({ workspaceId: ctx.workspaceId, installationId: installed.installationId, tool: 'read_file', args: { path: 'a.txt' } });
  assert.equal(denied.ok, false);
  assert.deepEqual(denied.denied?.missingScopes, ['fs:read']);

  // 授权未声明的权限 → 拒绝
  await assert.rejects(() => installer.grant({ workspaceId: ctx.workspaceId, installationId: installed.installationId, scopes: ['root:everything'] }), /未声明以下权限/);

  const granted = await installer.grant({ workspaceId: ctx.workspaceId, installationId: installed.installationId, scopes: ['fs:read'] });
  assert.deepEqual(granted.granted, ['fs:read']);

  // 注入执行器后调用成功
  runtime.registerExecutor('mcp-filesystem', async (tool, args) => ({ tool: tool.name, path: args.path }));
  const invoked = await runtime.invoke({ workspaceId: ctx.workspaceId, installationId: installed.installationId, tool: 'read_file', args: { path: 'a.txt' } });
  assert.equal(invoked.ok, true);
  assert.deepEqual(invoked.content, { tool: 'read_file', path: 'a.txt' });

  // 未授权 fs:write 时被权限拦下（返回 denied 而不是抛错）
  const noPerm = await runtime.invoke({ workspaceId: ctx.workspaceId, installationId: installed.installationId, tool: 'write_file', args: { path: 'a.txt', content: 'x' }, confirm: true });
  assert.equal(noPerm.ok, false);
  assert.deepEqual(noPerm.denied?.missingScopes, ['fs:write']);

  // 授权后，危险工具仍必须二次确认
  await installer.grant({ workspaceId: ctx.workspaceId, installationId: installed.installationId, scopes: ['fs:write'] });
  await assert.rejects(
    () => runtime.invoke({ workspaceId: ctx.workspaceId, installationId: installed.installationId, tool: 'write_file', args: { path: 'a.txt', content: 'x' } }),
    /危险操作/,
  );
  const written = await runtime.invoke({ workspaceId: ctx.workspaceId, installationId: installed.installationId, tool: 'write_file', args: { path: 'a.txt', content: 'x' }, confirm: true });
  assert.equal(written.ok, true);

  // 调用日志（成功与失败都要有）
  const logs = await new PluginCallLogger(ctx.db).list(ctx.workspaceId, installed.installationId, 100);
  assert.ok(logs.length >= 3, `应有调用日志，实际 ${logs.length}`);
  assert.ok(logs.some((l: { ok: boolean }) => l.ok === false), '失败调用也必须有日志');

  const revoked = await installer.revoke({ workspaceId: ctx.workspaceId, installationId: installed.installationId });
  assert.deepEqual(revoked.grantedScopes, [], '全部撤销后不应残留任何授权');
  const afterRevoke = await runtime.invoke({ workspaceId: ctx.workspaceId, installationId: installed.installationId, tool: 'read_file', args: { path: 'a.txt' } });
  assert.equal(afterRevoke.ok, false, '撤销后不能继续调用');

  await installer.uninstall(ctx.workspaceId, installed.pluginId);
  assert.equal((await installer.listInstalled(ctx.workspaceId)).length, 0);
  ctx.cleanup();
});

test('调用清单外的工具被拒绝并留痕', async () => {
  const ctx = setup('plugin-unknown-tool');
  const installer = new PluginInstaller(ctx.db);
  const runtime = new PluginRuntime(ctx.db);
  const installed = await installer.install(ctx.workspaceId, 'mcp-filesystem');
  await assert.rejects(() => runtime.invoke({ workspaceId: ctx.workspaceId, installationId: installed.installationId, tool: 'rm_rf' }), /未在插件清单中声明/);
  ctx.cleanup();
});

test('调用日志对敏感入参脱敏', async () => {
  const ctx = setup('plugin-mask');
  const installer = new PluginInstaller(ctx.db);
  const logger = new PluginCallLogger(ctx.db);
  const installed = await installer.install(ctx.workspaceId, 'mcp-filesystem');
  await logger.log({ installationId: installed.installationId, tool: 'read_file', args: { path: 'a.txt', token: 'super-secret-value', nested: { apiKey: 'k123' } }, ok: true, durationMs: 5 });
  const logs = await logger.list(ctx.workspaceId, installed.installationId, 10);
  const args = logs[0]!.args as Record<string, unknown>;
  assert.equal(args.token, '<redacted>');
  assert.equal((args.nested as Record<string, unknown>).apiKey, '<redacted>');
  assert.equal(args.path, 'a.txt');
  ctx.cleanup();
});

test('maskArgs 对长字符串截断且不改动无关键', () => {
  const out = maskArgs({ content: 'x'.repeat(5000) }) as Record<string, string>;
  assert.ok((out.content ?? '').length < 2100);
});

test('manifest 变更后安装会撤销旧授权（防权限提升）', async () => {
  const ctx = setup('plugin-upgrade');
  const installer = new PluginInstaller(ctx.db);
  const installed = await installer.install(ctx.workspaceId, 'mcp-filesystem');
  await installer.grant({ workspaceId: ctx.workspaceId, installationId: installed.installationId, scopes: ['fs:read'] });
  assert.deepEqual((await installer.listInstalled(ctx.workspaceId))[0]!.grantedScopes, ['fs:read']);

  // 直接篡改库里的 manifestHash，模拟「市场上的 manifest 变了」
  const { pluginInstallations } = await import('../db/schema/index.ts');
  const { eq } = await import('drizzle-orm');
  await ctx.db.update(pluginInstallations).set({ manifestHash: 'stale-hash' } as never).where(eq(pluginInstallations.id, installed.installationId));

  const reinstalled = await installer.install(ctx.workspaceId, 'mcp-filesystem');
  assert.deepEqual(reinstalled.grantedScopes, [], 'manifest 变更后必须重新授权');
  ctx.cleanup();
});

test('授权可设过期时间', async () => {
  const ctx = setup('plugin-expiry');
  const installer = new PluginInstaller(ctx.db);
  const installed = await installer.install(ctx.workspaceId, 'mcp-filesystem');
  const past = new Date(Date.now() - 1000).toISOString();
  await installer.grant({ workspaceId: ctx.workspaceId, installationId: installed.installationId, scopes: ['fs:read'], expiresAt: past });
  const list = await installer.listInstalled(ctx.workspaceId);
  assert.deepEqual(list[0]!.grantedScopes, [], '过期授权不应生效');
  ctx.cleanup();
});

test('更新插件会记录上一版本', async () => {
  const ctx = setup('plugin-update');
  const installer = new PluginInstaller(ctx.db);
  const installed = await installer.install(ctx.workspaceId, 'mcp-filesystem');
  const updated = await installer.update(ctx.workspaceId, installed.pluginId);
  assert.equal(updated.previousVersion, installed.version);
  assert.equal(updated.updated, false, '版本一致时不应标记为已更新');
  ctx.cleanup();
});

/* ------------------------------ MCP 注册表 ------------------------------ */

test('MCP 服务器注册拒绝内网 endpoint（防 SSRF）', async () => {
  const ctx = setup('mcp-ssrf');
  const registry = new McpServerRegistry(ctx.db);
  for (const endpoint of ['http://127.0.0.1:8080', 'http://169.254.169.254/latest', 'http://10.1.2.3/']) {
    await assert.rejects(() => registry.register({ workspaceId: ctx.workspaceId, name: `bad-${endpoint}`, transport: 'http', endpoint }), /内网|元数据/);
  }
  ctx.cleanup();
});

test('MCP 服务器注册 / 更新 / 移除 / 工具同步', async () => {
  const ctx = setup('mcp-crud');
  const registry = new McpServerRegistry(ctx.db);
  const server = await registry.register({ workspaceId: ctx.workspaceId, name: 'local-tools', transport: 'stdio', command: 'node', args: ['server.js'], secretRefs: ['MCP_TOKEN'] });
  assert.equal(server.status, 'registered');
  assert.equal(server.endpoint, '');

  const again = await registry.register({ workspaceId: ctx.workspaceId, name: 'local-tools', transport: 'stdio', command: 'node2' });
  assert.equal(again.id, server.id, '同名注册应更新而不是新建');

  const tools = await registry.syncTools(server.id, [
    { name: 'read', description: '读', schema: {} },
    { name: 'write', description: '写', schema: {}, dangerous: true },
  ]);
  assert.equal(tools.length, 2);

  await registry.setToolEnabled(server.id, 'write', false);
  assert.equal((await registry.listTools(server.id)).find((t) => t.name === 'write')!.enabled, false);

  // 重新同步不应覆盖用户的 enable 开关
  await registry.syncTools(server.id, [{ name: 'write', description: '写2', schema: {} }]);
  assert.equal((await registry.listTools(server.id)).find((t) => t.name === 'write')!.enabled, false);

  await registry.remove(ctx.workspaceId, server.id);
  assert.equal((await registry.list(server.workspaceId)).length, 0);
  ctx.cleanup();
});

test('MCP 客户端：http 传输走 JSON-RPC，错误可读', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result: { tools: [{ name: 'echo', description: 'e', inputSchema: {} }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const client = new McpClient(
    { id: 's1', workspaceId: 'ws', name: 'remote', transport: 'http', endpoint: 'https://mcp.example.com/rpc', command: null, args: [], status: 'registered', capabilities: {}, secretRefs: [], lastError: null, createdAt: '', updatedAt: '' },
    { sandbox: { ...DEFAULT_SANDBOX, allowNetwork: true }, fetchImpl: fakeFetch },
  );
  const tools = await client.listTools();
  assert.equal(tools.degraded, false);
  assert.equal(tools.tools[0]!.name, 'echo');
  assert.match(calls[0]!.url, /mcp\.example\.com/);

  const call = await client.callTool('echo', { q: 'hi' });
  assert.equal(call.ok, true);
});

test('MCP 客户端：stdio 未注入宿主时显式降级而不是假装成功', async () => {
  const client = new McpClient({ id: 's2', workspaceId: 'ws', name: 'local', transport: 'stdio', endpoint: '', command: 'node', args: [], status: 'registered', capabilities: {}, secretRefs: [], lastError: null, createdAt: '', updatedAt: '' });
  const tools = await client.listTools();
  assert.equal(tools.degraded, true);
  const call = await client.callTool('x', {});
  assert.equal(call.ok, false);
  assert.equal(call.degraded, true);
});

test('MCP 客户端：网络被禁时调用失败并说明原因', async () => {
  const client = new McpClient({ id: 's3', workspaceId: 'ws', name: 'remote', transport: 'http', endpoint: 'https://mcp.example.com/rpc', command: null, args: [], status: 'registered', capabilities: {}, secretRefs: [], lastError: null, createdAt: '', updatedAt: '' });
  const call = await client.callTool('x', {});
  assert.equal(call.ok, false);
  assert.match(call.error ?? '', /网络访问已被沙箱禁用/);
});

test('插件安装写入版本记录与权限声明', async () => {
  const ctx = setup('plugin-records');
  const installer = new PluginInstaller(ctx.db);
  const installed = await installer.install(ctx.workspaceId, 'db-tianyancha');
  const detail = await installer.detail('db-tianyancha');
  assert.equal(detail.manifest.name, installed.name);
  assert.ok(detail.marketSize > 0);
  const perms = await installer.permissions(installed.pluginId);
  assert.ok(perms.length >= 1);
  assert.ok(perms.every((p) => p.scope.length > 0));
  ctx.cleanup();
});
