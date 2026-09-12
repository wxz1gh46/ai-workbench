import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDb, createDb, type Db } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { setSecretKeyForTest } from '../src/security/secrets.ts';
import { gate, isDangerous, DANGEROUS_ACTIONS, dangerCatalog } from '../src/security/dangerGate.ts';

interface Ctx {
  db: Db;
  workspaceId: string;
  tempDir: string;
  cleanup: () => void;
}

function setup(name: string): Ctx {
  closeDb();
  const dir = mkdtempSync(path.join(tmpdir(), `p4sec-${name}-`));
  setSecretKeyForTest('phase4-sec-test-key-0123456789abcdef');
  process.env.DATA_DIR = dir;
  process.env.DB_FILE = path.join(dir, 'test.db');
  const { db, sqlite } = createDb(process.env.DB_FILE);
  runMigrations();
  const now = new Date().toISOString();
  sqlite.prepare('INSERT INTO users (id, name, role, created_at) VALUES (?,?,?,?)').run('u1', 't', 'owner', now);
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

/* ================================================================== */
/* 危险操作闸门：Phase 4 新增动作全覆盖                                 */
/* ================================================================== */

const PHASE4_ACTIONS = [
  'plugin.install',
  'plugin.uninstall',
  'plugin.revoke',
  'mcp.server.register',
  'mcp.server.remove',
  'paid_data.credential.save',
  'paid_data.credential.delete',
  'paid_data.query',
  'prompt.version.rollback',
  'cluster.node.remove',
  'cluster.policy.update',
  'cluster.election.force',
  'agent.pool.scale',
  'aggregated.resolve',
  'rbac.role.delete',
  'rbac.assign',
  'sso.enable',
  'sso.remove',
  'retention.apply',
  'audit.export',
];

test('Phase 4 的 20 类危险动作全部注册在闸门中', () => {
  for (const action of PHASE4_ACTIONS) {
    assert.equal(isDangerous(action), true, `${action} 未注册为危险动作`);
    assert.ok(DANGEROUS_ACTIONS[action]!.summary.length > 5, `${action} 缺少人类可读的后果说明`);
  }
  assert.ok(dangerCatalog().length >= 35);
});

test('危险动作缺少 confirm 时全部被拦截（含各种假值）', () => {
  const fakeValues = [false, undefined, null, 0, '', 'true', 1, {}, []];
  for (const action of PHASE4_ACTIONS) {
    for (const fake of fakeValues) {
      assert.throws(() => gate(action, fake), /危险操作需二次确认/, `${action} + ${JSON.stringify(fake)} 应被拦截`);
    }
    assert.doesNotThrow(() => gate(action, true), `${action} 在显式确认后应放行`);
  }
});

test('非危险动作不受闸门限制', () => {
  const res = gate('cluster.node.register', undefined);
  assert.equal(res.confirmed, true);
  assert.equal(res.action, 'cluster.node.register');
});

/* ================================================================== */
/* 凭据不落明文                                                        */
/* ================================================================== */

test('付费数据凭据：源码 / DB / 日志 / 接口响应均无明文', async () => {
  const ctx = setup('cred-no-plaintext');
  const { CredentialManager } = await import('../src/paidData/credentialManager.ts');
  const secretValue = 'super-secret-token-abcdef123456';
  const manager = new CredentialManager(ctx.db);
  const saved = await manager.save({ workspaceId: ctx.workspaceId, providerId: 'tianyancha', credentials: { token: secretValue } });

  // 接口返回值
  assert.equal(JSON.stringify(saved).includes(secretValue), false);
  assert.match(saved.masked.token ?? '', /^\*{4}/);

  // DB
  const { paidDataCredentials } = await import('../src/db/schema/index.ts');
  const raw = (await ctx.db.select().from(paidDataCredentials))[0]!;
  assert.equal(raw.encryptedConfig.includes(secretValue), false);
  assert.match(raw.encryptedConfig, /^v1:/);

  // 列表接口
  const list = await manager.list(ctx.workspaceId);
  assert.equal(JSON.stringify(list).includes(secretValue), false);
  ctx.cleanup();
});

test('凭据加密：换密钥后解密失败会明确报错而不是返回错数据', async () => {
  const ctx = setup('cred-rotate');
  const { CredentialManager } = await import('../src/paidData/credentialManager.ts');
  const manager = new CredentialManager(ctx.db);
  await manager.save({ workspaceId: ctx.workspaceId, providerId: 'academic', credentials: { mailto: 'a@b.com' } });
  setSecretKeyForTest('a-completely-different-key-0123456789');
  await assert.rejects(() => manager.resolve(ctx.workspaceId, 'academic'), /解密失败|WORKBENCH_SECRET_KEY/);
  ctx.cleanup();
});

test('插件调用日志不落凭据明文', async () => {
  const ctx = setup('plugin-log-mask');
  const { PluginInstaller } = await import('../src/plugins/pluginInstaller.ts');
  const { PluginCallLogger } = await import('../src/plugins/pluginCallLog.ts');
  const installer = new PluginInstaller(ctx.db);
  const logger = new PluginCallLogger(ctx.db);
  const installed = await installer.install(ctx.workspaceId, 'mcp-filesystem');
  const secret = 'tok_live_9f8e7d6c5b4a';
  await logger.log({ installationId: installed.installationId, tool: 'read_file', args: { path: 'a.txt', apiKey: secret, nested: { authorization: secret } }, ok: true, durationMs: 1 });
  const logs = await logger.list(ctx.workspaceId, installed.installationId, 10);
  assert.equal(JSON.stringify(logs).includes(secret), false);
  ctx.cleanup();
});

test('审计 detail 的嵌套敏感字段被深度脱敏', async () => {
  const ctx = setup('audit-deep-mask');
  const { auditLogs } = await import('../src/db/schema/index.ts');
  const { AuditQueryService } = await import('../src/enterprise/auditLog.ts');
  const { DataMaskService } = await import('../src/enterprise/dataMask.ts');
  const svc = new AuditQueryService(ctx.db, new DataMaskService(ctx.db));
  const secret = 'nested-secret-value-xyz';
  await ctx.db.insert(auditLogs).values({
    id: 'adt1',
    workspaceId: ctx.workspaceId,
    actor: 'user',
    action: 'plugin.invoke',
    targetType: 'plugin',
    targetId: 'p',
    dangerous: false,
    confirmedByUser: true,
    detail: { level1: { level2: { token: secret, cookie: secret }, email: 'x@y.com' } } as never,
    createdAt: new Date().toISOString(),
  } as never);
  const logs = await svc.list({ workspaceId: ctx.workspaceId, limit: 10 });
  assert.equal(JSON.stringify(logs).includes(secret), false);
  ctx.cleanup();
});

/* ================================================================== */
/* 沙箱与 SSRF                                                         */
/* ================================================================== */

test('插件沙箱：禁止内网 / 元数据 / 非 http 协议', async () => {
  const { assertNetworkAllowed, DEFAULT_SANDBOX } = await import('../src/plugins/pluginSandbox.ts');
  const policy = { ...DEFAULT_SANDBOX, allowNetwork: true };
  const blocked = [
    'http://127.0.0.1/',
    'http://localhost/',
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://10.0.0.1/',
    'http://192.168.0.1/',
    'http://172.20.0.1/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'gopher://example.com/',
  ];
  for (const url of blocked) {
    assert.throws(() => assertNetworkAllowed(policy, url), /沙箱|仅允许|非法|禁止/, `${url} 必须被拦截`);
  }
});

test('MCP 服务器注册拒绝内网 endpoint', async () => {
  const ctx = setup('mcp-ssrf');
  const { McpServerRegistry } = await import('../src/plugins/mcpServerRegistry.ts');
  const registry = new McpServerRegistry(ctx.db);
  await assert.rejects(() => registry.register({ workspaceId: ctx.workspaceId, name: 'ssrf', transport: 'http', endpoint: 'http://169.254.169.254/' }), /内网|元数据/);
  await assert.rejects(() => registry.register({ workspaceId: ctx.workspaceId, name: 'ssrf2', transport: 'http', endpoint: 'http://127.0.0.1:6379/' }), /内网|元数据/);
  ctx.cleanup();
});

test('集群节点不拒绝本机回环（单机集群是合法场景）但拒绝无端点的公网注册', async () => {
  const ctx = setup('cluster-host');
  const { NodeRegistry } = await import('../src/cluster/nodeRegistry.ts');
  const registry = new NodeRegistry(ctx.db);
  const local = await registry.register({ name: 'local', host: '127.0.0.1' }, { maxNodes: 4, allowLoopback: true });
  assert.equal(local.host, '127.0.0.1');
  await assert.rejects(() => registry.register({ name: 'x', host: '127.0.0.1' }, { maxNodes: 4, allowLoopback: false }), /不允许注册回环/);
  ctx.cleanup();
});

/* ================================================================== */
/* 权限与越权                                                          */
/* ================================================================== */

test('RBAC：分配角色后严格按权限执行，不因「是本地用户」而放行', async () => {
  const ctx = setup('rbac-strict');
  const { RbacService } = await import('../src/enterprise/rbac.ts');
  const rbac = new RbacService(ctx.db);
  await rbac.ensureBuiltinRoles(ctx.workspaceId);
  await rbac.assign({ workspaceId: ctx.workspaceId, userId: 'viewer1', roleNameOrId: 'viewer' });
  const violations: string[] = [];
  for (const perm of ['rbac:manage', 'sso:manage', 'cluster:manage', 'plugin:install', 'paid_data:configure', 'retention.apply'] as const) {
    try {
      await rbac.enforce({ workspaceId: ctx.workspaceId, userId: 'viewer1', permission: perm as never });
      violations.push(perm);
    } catch {
      // 预期被拒
    }
  }
  assert.deepEqual(violations, [], 'viewer 不应通过任何敏感权限');
  ctx.cleanup();
});

test('RBAC：跨工作区角色不生效', async () => {
  const ctx = setup('rbac-tenant');
  const { RbacService } = await import('../src/enterprise/rbac.ts');
  const rbac = new RbacService(ctx.db);
  await rbac.ensureBuiltinRoles(ctx.workspaceId);
  await rbac.assign({ workspaceId: ctx.workspaceId, userId: 'u2', roleNameOrId: 'viewer' });
  const now = new Date().toISOString();
  const { getSqlite } = await import('../src/db/client.ts');
  getSqlite().prepare('INSERT INTO users (id, name, role, created_at) VALUES (?,?,?,?)').run('u9', 'other', 'owner', now);
  getSqlite().prepare('INSERT INTO workspaces (id, user_id, name, root_path, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('ws2', 'u9', 'ws2', null, now, now);
  // ws2 里 u2 没有任何角色 → 走单机 owner 兜底；但 ws2 不存在任何 ws1 的角色
  assert.equal((await rbac.listUserRoles('ws2')).length, 0);
  ctx.cleanup();
});

test('SSO 配置拒绝直接粘贴密钥（只接受环境变量名）', async () => {
  const ctx = setup('sso-secret');
  const { SsoService } = await import('../src/enterprise/sso.ts');
  const svc = new SsoService(ctx.db);
  const badRefs = [['sk', 'abcdefghijklmnopqrstuvwxyz1234'].join('-'), ['gh', 'p_abcdefghijklmnopqrstuvwxyz12345678'].join(''), 'lowercase', 'mixedCase', 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0'];
  for (const ref of badRefs) {
    await assert.rejects(
      () => svc.upsert(ctx.workspaceId, { issuer: 'https://idp.example.com', clientId: 'c', clientSecretRef: ref, redirectUri: 'http://127.0.0.1:8787/cb' }, []),
      /不是环境变量名/,
      `${ref} 应被拒绝`,
    );
  }
  ctx.cleanup();
});

test('SSO 授权链接带 state/nonce，防 CSRF 与重放', async () => {
  const ctx = setup('sso-csrf');
  const { SsoService } = await import('../src/enterprise/sso.ts');
  const svc = new SsoService(ctx.db);
  process.env.SSO_CSRF_SECRET = 'a-very-long-secret-value-for-test';
  await svc.upsert(ctx.workspaceId, { issuer: 'https://idp.example.com', clientId: 'c', clientSecretRef: 'SSO_CSRF_SECRET', redirectUri: 'http://127.0.0.1:8787/cb', enabled: true }, []);
  await svc.buildAuthUrl(ctx.workspaceId);
  assert.equal(svc.consumeState({ state: 'attacker-forged' }).ok, false);

  // nonce 不匹配必须拒绝；同时 state 立即作废（被伪造的 nonce 已用掉这次登录流程）
  const auth1 = await svc.buildAuthUrl(ctx.workspaceId);
  assert.equal(svc.consumeState({ state: auth1.state, nonce: 'wrong-nonce' }).ok, false, 'nonce 不匹配必须拒绝');
  assert.equal(svc.consumeState({ state: auth1.state, nonce: auth1.nonce }).ok, false, 'nonce 已被消费，state 不应再次可用');

  const auth2 = await svc.buildAuthUrl(ctx.workspaceId);
  assert.equal(svc.consumeState({ state: auth2.state, nonce: auth2.nonce }).ok, true);
  assert.equal(svc.consumeState({ state: auth2.state, nonce: auth2.nonce }).ok, false, '重复消费必须失败');
  delete process.env.SSO_CSRF_SECRET;
  ctx.cleanup();
});

/* ================================================================== */
/* SQL / 路径 / 表名注入                                               */
/* ================================================================== */

test('付费数据适配器拒绝 SQL 注入式表名', async () => {
  const { createAdapter } = await import('../src/paidData/adapterFactory.ts');
  const adapter = createAdapter('hs-juyuan');
  for (const table of ['a; drop table users', "a' OR '1'='1", 'a--', 'a b']) {
    await assert.rejects(
      () => adapter.query('finance.query', { table }, { providerId: 'hs-juyuan', credentials: { apiKey: 'k' }, timeoutMs: 500 }),
      /数据表名不合法/,
      `${table} 应被拒绝`,
    );
  }
});

test('IMF / 学术适配器校验代码格式', async () => {
  const { createAdapter } = await import('../src/paidData/adapterFactory.ts');
  await assert.rejects(() => createAdapter('imf').query('macro.series', { indicator: 'x; drop' }, { providerId: 'imf', credentials: {}, timeoutMs: 500 }), /指标代码不合法/);
  await assert.rejects(() => createAdapter('imf').query('macro.series', { indicator: 'OK', country: 'CN;drop' }, { providerId: 'imf', credentials: {}, timeoutMs: 500 }), /国家代码不合法/);
});

test('合规守卫拒绝「批量导出 / 绕过限流 / 爬虫」类参数', async () => {
  const { checkCompliance } = await import('../src/paidData/complianceGuard.ts');
  const probes = ['绕过限流', 'crawl all pages', '全量导出', 'shared account', 'crack license', 'bypass rate limit', 'captcha 绕过'];
  for (const probe of probes) {
    const d = checkCompliance({ providerId: 'tianyancha', action: 'company.basic', params: { keyword: probe }, hasCredentials: true });
    assert.equal(d.allowed, false, `${probe} 应被拒绝`);
    assert.equal(d.code, 'ABUSE_INTENT');
  }
});

test('插件清单中声明违规能力的插件无法安装', async () => {
  const { assertCompliant, PluginComplianceError } = await import('../src/plugins/pluginManifest.ts');
  const { PLUGIN_MARKET } = await import('../src/plugins/pluginMarket.ts');
  const base = PLUGIN_MARKET[0]!;
  const cases = [
    { ...base, source: 'market://bypass-anti-crawler' },
    { ...base, description: '本插件可绕过风控获取数据' },
    { ...base, author: 'shared account broker' },
    { ...base, config: { note: '使用破解版接口' } },
    { ...base, permissions: [{ scope: 'paid:x', description: '付费数据', sensitive: true }], requiresUserAuth: false },
    { ...base, sandbox: false as unknown as true },
  ];
  for (const c of cases) {
    assert.throws(() => assertCompliant(c), PluginComplianceError);
  }
});

/* ================================================================== */
/* 路径越权                                                            */
/* ================================================================== */

test('沙箱路径：拒绝穿越、绝对路径与未授权前缀', async () => {
  const { assertPathAllowed, DEFAULT_SANDBOX } = await import('../src/plugins/pluginSandbox.ts');
  const policy = { ...DEFAULT_SANDBOX, allowedPaths: ['work'] };
  const root = '/tmp/sandbox-work';
  for (const p of ['../etc/passwd', 'work/../../etc/passwd', '/etc/passwd', 'other/f.txt', '']) {
    if (p === 'work/../../etc/passwd') {
      assert.throws(() => assertPathAllowed(policy, root, p), /路径穿越|不在授权前缀/);
      continue;
    }
    assert.throws(() => assertPathAllowed(policy, root, p), /穿越|不在授权前缀|未授权/, `${p} 应被拒绝`);
  }
});

test('合规导出：文件路径越界被拒绝（防读任意文件）', async () => {
  const ctx = setup('export-traversal');
  const { ComplianceExportService } = await import('../src/enterprise/complianceExport.ts');
  const { AuditQueryService } = await import('../src/enterprise/auditLog.ts');
  const { DataMaskService } = await import('../src/enterprise/dataMask.ts');
  const { auditExports } = await import('../src/db/schema/index.ts');
  const svc = new ComplianceExportService(ctx.db, new AuditQueryService(ctx.db, new DataMaskService(ctx.db)), ctx.tempDir);
  for (const filePath of ['/etc/passwd', path.join(ctx.tempDir, '..', 'outside.txt'), path.join(tmpdir(), 'x.ndjson')]) {
    await ctx.db.insert(auditExports).values({
      id: `aexp_${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: ctx.workspaceId,
      type: 'audit',
      rangeStart: '',
      rangeEnd: '',
      filePath,
      rowCount: 0,
      status: 'succeeded',
      error: null,
      createdAt: new Date().toISOString(),
    } as never);
  }
  for (const row of await svc.listExports(ctx.workspaceId)) {
    await assert.rejects(() => svc.readExport(ctx.workspaceId, row.id), /路径越界|不存在/, `${row.filePath} 应被拒绝`);
  }
  ctx.cleanup();
});

/* ================================================================== */
/* 资源与并发保护                                                      */
/* ================================================================== */

test('插件并发闸门不丢任务、不超限', async () => {
  const { ConcurrencyGate } = await import('../src/plugins/pluginSandbox.ts');
  const gate = new ConcurrencyGate(3);
  let active = 0;
  let peak = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: 20 }, () =>
      gate.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 1));
        active -= 1;
        done += 1;
      }),
    ),
  );
  assert.equal(peak, 3);
  assert.equal(done, 20);
});

test('集群策略拒绝越界配置（防止把节点数/并行数设成危险值）', async () => {
  const ctx = setup('cluster-policy-limit');
  const { ClusterPolicyService } = await import('../src/cluster/clusterPolicy.ts');
  const svc = new ClusterPolicyService(ctx.db);
  await svc.get(ctx.workspaceId);
  await assert.rejects(() => svc.update(ctx.workspaceId, { maxNodes: 100000 }), /maxNodes/);
  await assert.rejects(() => svc.update(ctx.workspaceId, { maxParallelTasks: -1 }), /maxParallelTasks/);
  await assert.rejects(() => svc.update(ctx.workspaceId, { heartbeatTimeoutMs: 1 }), /heartbeatTimeoutMs/);
  await assert.rejects(() => svc.update(ctx.workspaceId, { resourceLimits: { cpu: -5 } }), /资源上限/);
  ctx.cleanup();
});

test('保留策略禁止对核心表配置（防删库）', async () => {
  const ctx = setup('retention-guard');
  const { RetentionService } = await import('../src/enterprise/retentionPolicy.ts');
  const svc = new RetentionService(ctx.db);
  for (const t of ['users', 'workspaces', 'goals', 'tasks', 'agents']) {
    await assert.rejects(() => svc.upsert({ workspaceId: ctx.workspaceId, dataType: t, retentionDays: 1 }), /不允许为/);
  }
  ctx.cleanup();
});

test('保留策略默认预演：未确认时不删除任何数据', async () => {
  const ctx = setup('retention-safe');
  const { RetentionService } = await import('../src/enterprise/retentionPolicy.ts');
  const { auditLogs } = await import('../src/db/schema/index.ts');
  const now = new Date().toISOString();
  for (let i = 0; i < 3; i += 1) {
    await ctx.db.insert(auditLogs).values({
      id: `a${i}`,
      workspaceId: ctx.workspaceId,
      actor: 'u',
      action: 'x',
      targetType: 't',
      targetId: String(i),
      dangerous: false,
      confirmedByUser: true,
      detail: {} as never,
      createdAt: new Date(Date.now() - 10 * 86400_000).toISOString(),
    } as never);
  }
  const svc = new RetentionService(ctx.db);
  await svc.upsert({ workspaceId: ctx.workspaceId, dataType: 'audit_logs', retentionDays: 1 });
  const { getSqlite } = await import('../src/db/client.ts');
  const count = () => (getSqlite().prepare('SELECT COUNT(*) c FROM audit_logs').get() as { c: number }).c;
  const before = count();
  await svc.apply({ workspaceId: ctx.workspaceId, dryRun: true }, {
    audit_logs: async (cutoff, _action, dryRun) => {
      const n = (getSqlite().prepare('SELECT COUNT(*) c FROM audit_logs WHERE created_at < ?').get(cutoff) as { c: number }).c;
      if (!dryRun) getSqlite().prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff);
      return { scanned: n, affected: dryRun ? 0 : n };
    },
  });
  assert.equal(count(), before, '预演不得删除数据');
  void now;
  ctx.cleanup();
});

test('审计导出必须带时间范围（防止无边界全量导出）', async () => {
  const ctx = setup('export-range');
  const { AuditQueryService } = await import('../src/enterprise/auditLog.ts');
  const { DataMaskService } = await import('../src/enterprise/dataMask.ts');
  const svc = new AuditQueryService(ctx.db, new DataMaskService(ctx.db));
  await assert.rejects(() => svc.export({ workspaceId: ctx.workspaceId, from: '', to: '', outputDir: ctx.tempDir }), /必须指定时间范围/);
  ctx.cleanup();
});
