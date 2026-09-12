import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDb, createDb } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { setSecretKeyForTest, unseal } from '../security/secrets.ts';
import { PAID_PROVIDERS, findProvider, requiredCredentialKeys } from './providerRegistry.ts';
import { checkCompliance } from './complianceGuard.ts';
import { ResultCache, cacheKey, ttlFor } from './resultCache.ts';
import { PaidDataQueryRunner, countRows } from './queryRunner.ts';
import { CredentialManager } from './credentialManager.ts';
import { createAdapter, adapterIds } from './adapterFactory.ts';

function setup(name: string) {
  closeDb();
  const dir = mkdtempSync(path.join(tmpdir(), `p4pd-${name}-`));
  setSecretKeyForTest('phase4-paid-test-key-0123456789ab');
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
    cleanup: () => {
      closeDb();
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ------------------------------ 注册表 ------------------------------ */

test('注册表覆盖提示词列出的 8 个数据源', () => {
  const ids = PAID_PROVIDERS.map((p) => p.id);
  for (const id of ['tonghuashun', 'tianyancha', 'wind', 'hs-juyuan', 'sp-global', 'imf', 'hyyd-legal', 'academic']) {
    assert.ok(ids.includes(id), `缺少数据源：${id}`);
  }
  assert.equal(PAID_PROVIDERS.length, 8);
});

test('每个数据源都声明了官方接入方式与限流', () => {
  for (const p of PAID_PROVIDERS) {
    assert.ok(p.accessMethods.length > 0, `${p.id} 未声明接入方式`);
    assert.ok(p.accessMethods.some((m) => /API|接口|终端|桥接|IdP|官方/.test(m)), `${p.id} 的接入方式必须点名官方途径：${p.accessMethods.join(' / ')}`);
    assert.ok(p.rateLimit.perMinute > 0, `${p.id} 未声明限流`);
    assert.ok(p.docsUrl.startsWith('https://'), `${p.id} 缺少官方文档地址`);
  }
});

test('需要授权的数据源必须声明凭据字段', () => {
  for (const p of PAID_PROVIDERS) {
    if (p.requiresUserAuth) {
      assert.ok(p.credentialFields.length > 0, `${p.id} 声明需要授权却没有凭据字段`);
      assert.ok(p.credentialFields.some((f) => f.required), `${p.id} 至少有一个必填凭据字段`);
    }
  }
});

test('注册表不含任何硬编码凭据形态的默认值', () => {
  const dump = JSON.stringify(PAID_PROVIDERS);
  // 正则同样运行时拼接：否则本文件自身会被源码密钥扫描命中
  const shapes = [new RegExp(['sk', '[A-Za-z0-9]{16,}'].join('-')), new RegExp(['gh', 'p_[A-Za-z0-9]{20,}'].join('')), new RegExp(['AK', 'IA[0-9A-Z]{12,}'].join(''))];
  for (const re of shapes) {
    assert.equal(re.test(dump), false, '注册表不应包含任何凭据');
  }
});

test('requiredCredentialKeys 返回必填字段', () => {
  assert.deepEqual(requiredCredentialKeys('tianyancha'), ['token']);
  assert.deepEqual(requiredCredentialKeys('unknown-provider'), []);
});

/* ------------------------------ 合规守卫 ------------------------------ */

test('合规守卫拒绝未知数据源与未知动作', () => {
  const a = checkCompliance({ providerId: 'nope', action: 'x', params: {}, hasCredentials: true });
  assert.equal(a.allowed, false);
  assert.equal(a.code, 'UNKNOWN_PROVIDER');
  const b = checkCompliance({ providerId: 'tianyancha', action: 'company.nope', params: {}, hasCredentials: true });
  assert.equal(b.allowed, false);
  assert.equal(b.code, 'UNKNOWN_ACTION');
});

test('合规守卫拒绝绕过限流 / 爬虫 / 全量导出 / 共享账号 / 破解', () => {
  const cases = [
    { params: { keyword: '绕过限流批量拉取' }, code: 'ABUSE_INTENT' },
    { params: { keyword: 'crawl the site' }, code: 'ABUSE_INTENT' },
    { params: { keyword: '全量导出所有企业' }, code: 'ABUSE_INTENT' },
    { params: { keyword: 'shared account token' }, code: 'ABUSE_INTENT' },
    { params: { keyword: 'crack license' }, code: 'ABUSE_INTENT' },
  ];
  for (const c of cases) {
    const d = checkCompliance({ providerId: 'tianyancha', action: 'company.basic', params: c.params, hasCredentials: true });
    assert.equal(d.allowed, false, `${JSON.stringify(c.params)} 应被拒绝`);
    assert.equal(d.code, c.code);
  }
});

test('需要授权的数据源在无凭据时被拒绝，并给出接入方式', () => {
  const d = checkCompliance({ providerId: 'wind', action: 'wds.query', params: { dataset: 'x' }, hasCredentials: false });
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'NO_CREDENTIALS');
  assert.match(d.reason ?? '', /手动配置凭据/);
  assert.ok((d.accessMethods[0] ?? '').length > 0);
});

test('开放数据源无需凭据即可通过合规校验', () => {
  for (const id of ['imf', 'academic']) {
    const spec = findProvider(id)!;
    const d = checkCompliance({ providerId: id, action: spec.actions[0]!.name, params: { indicator: 'X', query: 'x' }, hasCredentials: false });
    assert.equal(d.allowed, true, `${id} 应允许无凭据查询`);
  }
});

/* ------------------------------ 缓存 ------------------------------ */

test('cacheKey 对参数顺序不敏感，并剔除元信息参数', () => {
  const a = cacheKey('imf', 'macro.series', { indicator: 'X', country: 'CN', purpose: 'a' });
  const b = cacheKey('imf', 'macro.series', { country: 'CN', indicator: 'X', purpose: 'b' });
  assert.equal(a, b);
  assert.notEqual(a, cacheKey('imf', 'macro.series', { indicator: 'Y', country: 'CN' }));
});

test('不同数据源缓存 TTL 不同（行情短、工商长、宏观最长）', () => {
  assert.ok(ttlFor('tonghuashun') < ttlFor('tianyancha'));
  assert.ok(ttlFor('tianyancha') < ttlFor('imf'));
});

test('ResultCache 过期后不再命中，且淘汰最旧项', () => {
  let now = 1000;
  const cache = new ResultCache(() => now);
  cache.set('k', { v: 1 }, 100);
  assert.deepEqual(cache.get('k'), { v: 1 });
  now = 1200;
  assert.equal(cache.get('k'), null);
  for (let i = 0; i < 600; i += 1) cache.set(`k${i}`, i, 10_000);
  assert.ok(cache.size() <= 500);
});

test('countRows 能识别常见包裹结构', () => {
  assert.equal(countRows([1, 2, 3]), 3);
  assert.equal(countRows({ items: [1, 2] }), 2);
  assert.equal(countRows({ data: { rows: [1] } }), 1);
  assert.equal(countRows(null), 0);
  assert.equal(countRows({ a: 1 }), 1);
});

/* ------------------------------ 查询运行器 ------------------------------ */

test('无凭据查询返回 blocked 记录（可追溯），不抛 500', async () => {
  const ctx = setup('blocked');
  const runner = new PaidDataQueryRunner(ctx.db);
  const res = await runner.run({ workspaceId: ctx.workspaceId, providerId: 'tianyancha', action: 'company.basic', params: { keyword: '示例公司' }, credentials: {} });
  assert.equal(res.status, 'blocked');
  assert.match(res.blockedReason ?? '', /手动配置凭据/);
  const history = await runner.listQueries(ctx.workspaceId, 10);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.status, 'blocked');
  ctx.cleanup();
});

test('合规拒绝同样落库（谁在什么时候试过什么可追溯）', async () => {
  const ctx = setup('blocked-audit');
  const runner = new PaidDataQueryRunner(ctx.db);
  const res = await runner.run({ workspaceId: ctx.workspaceId, providerId: 'tianyancha', action: 'company.basic', params: { keyword: '绕过限流' }, credentials: { token: 'x' } });
  assert.equal(res.status, 'blocked');
  assert.match(res.blockedReason ?? '', /限流/);
  ctx.cleanup();
});

test('预检接口给出与真实查询一致的判断', async () => {
  const ctx = setup('preflight');
  const runner = new PaidDataQueryRunner(ctx.db);
  const pre = runner.preflight({ providerId: 'wind', action: 'wds.query', params: { dataset: 'x' }, hasCredentials: false });
  assert.equal(pre.allowed, false);
  const pre2 = runner.preflight({ providerId: 'imf', action: 'macro.series', params: { indicator: 'X' }, hasCredentials: false });
  assert.equal(pre2.allowed, true);
  ctx.cleanup();
});

test('已配置凭据但接口不可达时显式降级（degraded=true）而不是抛错', async () => {
  const ctx = setup('degraded');
  const runner = new PaidDataQueryRunner(ctx.db);
  const fakeFetch = (async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  }) as unknown as typeof fetch;
  const res = await runner.run({
    workspaceId: ctx.workspaceId,
    providerId: 'tianyancha',
    action: 'company.basic',
    params: { keyword: '示例' },
    credentials: { token: 'tok_123' },
    fetchImpl: fakeFetch,
  });
  assert.equal(res.status, 'succeeded');
  assert.equal(res.degraded, true);
  assert.match(res.note ?? '', /调用失败/);
  ctx.cleanup();
});

test('真实请求成功时返回数据与引用来源', async () => {
  const ctx = setup('success');
  const runner = new PaidDataQueryRunner(ctx.db);
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ result: { items: [{ name: 'IMF GDP' }] } }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const res = await runner.run({
    workspaceId: ctx.workspaceId,
    providerId: 'imf',
    action: 'macro.series',
    params: { indicator: 'NGDP_RPCH', country: 'CN' },
    fetchImpl: fakeFetch,
  });
  assert.equal(res.status, 'succeeded');
  assert.equal(res.degraded, false);
  assert.equal(res.rowCount, 1);
  assert.equal(res.citations.length, 1);
  assert.match(res.citations[0]!.accessedAt, /^\d{4}-/);

  // 第二次命中缓存
  const res2 = await runner.run({ workspaceId: ctx.workspaceId, providerId: 'imf', action: 'macro.series', params: { country: 'CN', indicator: 'NGDP_RPCH' }, fetchImpl: fakeFetch });
  assert.equal(res2.cached, true);
  ctx.cleanup();
});

test('本地限流生效（超出 perMinute 直接 429）', async () => {
  const ctx = setup('ratelimit');
  const runner = new PaidDataQueryRunner(ctx.db);
  const fakeFetch = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const spec = findProvider('imf')!;
  for (let i = 0; i < spec.rateLimit.perMinute; i += 1) {
    await runner.run({ workspaceId: ctx.workspaceId, providerId: 'imf', action: 'macro.series', params: { indicator: 'X', country: `C${i}` }, fetchImpl: fakeFetch });
  }
  await assert.rejects(() => runner.run({ workspaceId: ctx.workspaceId, providerId: 'imf', action: 'macro.dataset', params: {}, fetchImpl: fakeFetch }), /限流/);
  ctx.cleanup();
});

/* ------------------------------ 凭据管理 ------------------------------ */

test('凭据加密落库：库里无明文，接口不返回明文', async () => {
  const ctx = setup('cred-encrypt');
  const manager = new CredentialManager(ctx.db);
  const saved = await manager.save({ workspaceId: ctx.workspaceId, providerId: 'tianyancha', credentials: { token: 'tyc-super-secret-token' } });
  assert.deepEqual(saved.fieldNames, ['token']);
  assert.match(saved.masked.token ?? '', /^\*{4}/);
  assert.equal(JSON.stringify(saved).includes('tyc-super-secret-token'), false);

  const raw = await ctx.db.select().from((await import('../db/schema/index.ts')).paidDataCredentials);
  const encrypted = (raw[0] as { encryptedConfig: string }).encryptedConfig;
  assert.equal(encrypted.includes('tyc-super-secret-token'), false, 'DB 中不得有明文');
  assert.equal(unseal<{ token: string }>(encrypted)?.token, 'tyc-super-secret-token');

  const resolved = await manager.resolve(ctx.workspaceId, 'tianyancha');
  assert.equal(resolved.token, 'tyc-super-secret-token');
  ctx.cleanup();
});

test('凭据合并更新不会清空未提交的字段', async () => {
  const ctx = setup('cred-merge');
  const manager = new CredentialManager(ctx.db);
  await manager.save({ workspaceId: ctx.workspaceId, providerId: 'tonghuashun', credentials: { appKey: 'k1', appSecret: 's1' } });
  await manager.save({ workspaceId: ctx.workspaceId, providerId: 'tonghuashun', credentials: { appKey: 'k2' } });
  const resolved = await manager.resolve(ctx.workspaceId, 'tonghuashun');
  assert.equal(resolved.appKey, 'k2');
  assert.equal(resolved.appSecret, 's1', '未提交的字段不能被清空');
  ctx.cleanup();
});

test('replace=true 时整体覆盖', async () => {
  const ctx = setup('cred-replace');
  const manager = new CredentialManager(ctx.db);
  await manager.save({ workspaceId: ctx.workspaceId, providerId: 'tonghuashun', credentials: { appKey: 'k1', appSecret: 's1' } });
  await manager.save({ workspaceId: ctx.workspaceId, providerId: 'tonghuashun', credentials: { appKey: 'k2' }, replace: true });
  const resolved = await manager.resolve(ctx.workspaceId, 'tonghuashun');
  assert.equal(resolved.appSecret, undefined);
  ctx.cleanup();
});

test('未知凭据字段被拒绝（避免写了不生效）', async () => {
  const ctx = setup('cred-unknown');
  const manager = new CredentialManager(ctx.db);
  await assert.rejects(() => manager.save({ workspaceId: ctx.workspaceId, providerId: 'tianyancha', credentials: { token: 'x', notAField: 'y' } }), /不支持以下凭据字段/);
  ctx.cleanup();
});

test('凭据删除与状态标记', async () => {
  const ctx = setup('cred-delete');
  const manager = new CredentialManager(ctx.db);
  await manager.save({ workspaceId: ctx.workspaceId, providerId: 'academic', credentials: { mailto: 'a@b.com' } });
  await manager.markVerified(ctx.workspaceId, 'academic', true);
  const list = await manager.list(ctx.workspaceId);
  assert.equal(list[0]!.status, 'verified');
  await manager.remove(ctx.workspaceId, 'academic');
  assert.equal((await manager.list(ctx.workspaceId)).length, 0);
  await assert.rejects(() => manager.remove(ctx.workspaceId, 'academic'), /未配置凭据/);
  ctx.cleanup();
});

/* ------------------------------ 适配器 ------------------------------ */

test('适配器工厂覆盖全部已声明的数据源', () => {
  for (const p of PAID_PROVIDERS) {
    const adapter = createAdapter(p.id);
    assert.equal(adapter.providerId, p.id);
    assert.doesNotThrow(() => adapter.missingCredentials({}));
  }
  assert.equal(adapterIds().length, 8);
  assert.throws(() => createAdapter('nope'), /未知的付费数据源/);
});

test('同花顺适配器缺少凭据时降级并点名缺失字段', async () => {
  const adapter = createAdapter('tonghuashun');
  const res = await adapter.query('market.quote', { symbol: '600000' }, { providerId: 'tonghuashun', credentials: {}, timeoutMs: 1000 });
  assert.equal(res.degraded, true);
  assert.match(res.note ?? '', /appKey/);
});

test('同花顺适配器签名调用成功并返回引用', async () => {
  const adapter = createAdapter('tonghuashun');
  const captured: { url: string; body: string }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    captured.push({ url: String(url), body: String(init.body) });
    return new Response(JSON.stringify({ data: [{ price: 1 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const res = await adapter.query('market.quote', { symbol: '600000' }, { providerId: 'tonghuashun', credentials: { appKey: 'k', appSecret: 's' }, timeoutMs: 1000, fetchImpl: fakeFetch });
  assert.equal(res.degraded, false);
  assert.equal(res.citations.length, 1);
  const body = JSON.parse(captured[0]!.body) as { signature: string; app_key: string };
  assert.equal(body.app_key, 'k');
  assert.equal(body.signature.length, 64, '应为 sha256 十六进制');
  assert.equal(captured[0]!.url.includes('/s'), false, 'URL 中不得出现 appSecret');
});

test('天眼查适配器缺少 keyword 时报可读错误', async () => {
  const adapter = createAdapter('tianyancha');
  await assert.rejects(() => adapter.query('company.basic', {}, { providerId: 'tianyancha', credentials: { token: 't' }, timeoutMs: 1000, fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch }), /keyword/);
});

test('Wind 适配器未安装终端时降级并说明原因', async () => {
  const adapter = createAdapter('wind');
  const res = await adapter.query('wds.query', { dataset: 'x' }, { providerId: 'wind', credentials: { windPath: '/definitely/not/exists' }, timeoutMs: 1000 });
  assert.equal(res.degraded, true);
  assert.match(res.note ?? '', /终端路径不存在/);
});

test('恒生聚源拒绝非法表名（防注入）', async () => {
  const adapter = createAdapter('hs-juyuan');
  await assert.rejects(
    () => adapter.query('finance.query', { table: 'users; drop table x' }, { providerId: 'hs-juyuan', credentials: { apiKey: 'k' }, timeoutMs: 1000 }),
    /数据表名不合法/,
  );
});

test('IMF 适配器拒绝非法指标代码', async () => {
  const adapter = createAdapter('imf');
  await assert.rejects(() => adapter.query('macro.series', { indicator: 'DROP TABLE' }, { providerId: 'imf', credentials: {}, timeoutMs: 1000 }), /指标代码不合法/);
});

test('学术适配器限制返回数量上限', async () => {
  const adapter = createAdapter('academic');
  let url = '';
  const fakeFetch = (async (u: string) => {
    url = String(u);
    return new Response(JSON.stringify({ message: { items: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  await adapter.query('paper.search', { query: 'llm', limit: 9999 }, { providerId: 'academic', credentials: {}, timeoutMs: 1000, fetchImpl: fakeFetch });
  assert.match(url, /rows=50/, 'limit 必须被夹到 50');
});

test('S&P 适配器缺少 query 时报可读错误', async () => {
  const adapter = createAdapter('sp-global');
  await assert.rejects(() => adapter.query('market.intelligence', {}, { providerId: 'sp-global', credentials: { apiKey: 'k' }, timeoutMs: 1000 }), /query/);
});
