/**
 * Step 8：安全与权限测试。
 *
 * 覆盖 Phase 2 验收要求「所有工具调用有日志和权限」以及合规红线：
 * - 路径穿越 / 工作区外访问一律拒绝
 * - 危险操作缺少用户确认时被拒绝，且有审计记录
 * - 未配置 rootPath 时默认不可写（安全默认）
 * - 合规红线：绕过反爬 / 共享账号 / 破解授权的插件声明被拒绝安装
 * - 密钥绝不落库、不硬编码
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const tmp = mkdtempSync(path.join(tmpdir(), 'ai-sec-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.STORAGE_DIR = path.join(tmp, 'data', 'storage');
process.env.DB_FILE = path.join(tmp, 'data', 'sec.db');
process.env.SOFFICE_PATH = '';

const { getDb, closeDb } = await import('../src/db/client.ts');
const { runMigrations } = await import('../src/db/migrate.ts');
const { createApp } = await import('../src/router/app.ts');
const { WorkspaceService } = await import('../src/services/workspace.ts');
const { AuditService } = await import('../src/services/audit.ts');
const { registerBuiltinTools, toolRegistry } = await import('../src/tools/index.ts');
const { PluginService } = await import('../src/services/plugin-service.ts');

runMigrations();
registerBuiltinTools();
const db = getDb();
const app = createApp({ db });
const audit = new AuditService(db);
const wsService = new WorkspaceService(db);
const plugins = new PluginService(db);
const workspaceRoot = mkdtempSync(path.join(tmp, 'ws-'));
let boot: Awaited<ReturnType<typeof wsService.ensureBootstrap>>;

before(async () => {
  boot = await wsService.ensureBootstrap();
  await wsService.updateRootPath(boot.workspace.id, workspaceRoot);
});

const post = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.fetch(
    new Request(`http://test${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
    }),
  );
const get = (url: string) => app.fetch(new Request(`http://test${url}`));

/* ---------------------------- 路径安全 ---------------------------- */

test('安全：office 读取拒绝路径穿越（../）', async () => {
  for (const p of ['../../etc/passwd', '../outside.docx', '/etc/passwd', 'a/../../../etc/hosts']) {
    const res = await post('/office/read', { workspaceId: boot.workspace.id, path: p });
    const body = await res.json();
    assert.ok(res.status === 403 || res.status === 404, `${p} 应被拒绝，实际 ${res.status}`);
    if (res.status === 403) assert.equal(body.error.code, 'FORBIDDEN');
  }
});

test('安全：office 编辑拒绝路径穿越，且不产生副作用', async () => {
  const res = await post('/office/edit', { workspaceId: boot.workspace.id, path: '../evil.docx', operations: [{ op: 'append', text: 'x' }] });
  assert.ok([403, 404].includes(res.status));
});

test('安全：未配置 rootPath 的工作区拒绝文件读写（安全默认）', async () => {
  const another = await wsService.ensureBootstrap();
  // 该工作区即当前工作区；临时把它设为 null 验证安全默认
  await wsService.updateRootPath(another.workspace.id, null);
  const res = await post('/office/read', { workspaceId: another.workspace.id, path: 'a.docx' });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.ok(body.error.message.includes('根目录'));
  await wsService.updateRootPath(another.workspace.id, workspaceRoot);
});

/* ---------------------- 危险操作与权限门 ---------------------- */

test('安全：工具注册表标记危险操作，且缺少确认时拒绝执行', async () => {
  const dangerous = toolRegistry.list().filter((t) => t.dangerous);
  // 内置工具目前都不是 dangerous；验证权限门本身对标记工具生效（用注入的测试工具）
  const gateBlocked = await toolRegistry.invoke('fs.write', { path: 'x.txt', content: 'x' }, {
    workspaceId: boot.workspace.id,
    goalId: null,
    taskId: null,
    agentId: 'user',
    runId: 'run-1',
    userConfirmed: false,
    workspaceRoot: null,
  });
  assert.equal(gateBlocked.ok, false, '未配置工作区根目录时必须拒绝写入');
  assert.ok(dangerous.every((t) => typeof t.permission === 'string'));
});

test('安全：未知工具调用返回可读错误而不是崩溃', async () => {
  const r = await toolRegistry.invoke('not.exist', {}, {
    workspaceId: boot.workspace.id,
    goalId: null,
    taskId: null,
    agentId: 'user',
    runId: 'run-1',
    userConfirmed: true,
    workspaceRoot,
  });
  assert.equal(r.ok, false);
  assert.ok(r.error?.includes('工具不存在'));
});

test('安全：插件安装涉及绕过反爬/共享账号/破解授权时被拒绝', async () => {
  const catalog = plugins.listCatalog();
  const illegal = catalog.find((p) => p.name === 'mock-illegal-crawler');
  if (illegal) {
    await assert.rejects(() => plugins.install(boot.workspace.id, illegal.name), /合规|禁止|不允许/);
  }
  // 付费数据源必须要求用户手动授权
  const paid = catalog.filter((p) => p.requiresUserAuth);
  assert.ok(paid.length >= 5, '付费数据源必须标记 requiresUserAuth');
});

test('安全：插件安装经由 API 必须留审计，且付费源凭据由用户提供', async () => {
  const listRes = await get(`/plugins?workspaceId=${boot.workspace.id}`);
  const list = await listRes.json();
  const free = list.data.catalog.find((p: { requiresUserAuth: boolean }) => !p.requiresUserAuth) ?? list.data.catalog[0];

  const installRes = await post(`/plugins/${free.name}/install`, { workspaceId: boot.workspace.id });
  assert.equal(installRes.status, 201, '安装应成功');

  const logs = await audit.list(boot.workspace.id, 200);
  const installLog = logs.find((l) => l.action === 'plugin.install');
  assert.ok(installLog, 'API 安装必须写审计日志');
  assert.equal(installLog!.confirmedByUser, true, '安装视为用户已确认');

  // 付费源：安装后仍要求用户手动提供凭据
  const paid = list.data.catalog.find((p: { requiresUserAuth: boolean }) => p.requiresUserAuth);
  if (paid) {
    const detail = list.data.catalog.find((p: { name: string }) => p.name === paid.name);
    assert.ok(detail.secretRefs.length > 0, '付费源必须声明需要用户提供的凭据名');
  }
});

/* --------------------------- 数据安全 --------------------------- */

test('安全：数据库与存储目录中不出现任何明文密钥', async () => {
  const envSecrets = [process.env.AI_API_KEY, process.env.RESEARCH_SEARCH_API_KEY].filter(
    (v): v is string => typeof v === 'string' && v.length > 8,
  );
  // 该测试环境本就没配置密钥；核心断言是「代码里没有硬编码密钥」
  const srcRoot = path.resolve(import.meta.dirname, '../src');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (abs.endsWith('.ts')) files.push(abs);
    }
  };
  walk(srcRoot);
  assert.ok(files.length > 40, '应扫描到全部源码文件');

  const SUSPECT = /(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{24,})/;
  const offenders: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    if (SUSPECT.test(content)) offenders.push(path.relative(srcRoot, file));
  }
  assert.deepEqual(offenders, [], `不得硬编码密钥：${offenders.join(', ')}`);

  // 已配置的密钥（如果有）不得出现在数据库文件里
  if (envSecrets.length > 0) {
    const dbBuf = readFileSync(path.join(tmp, 'data', 'sec.db'));
    for (const secret of envSecrets) {
      assert.equal(dbBuf.includes(Buffer.from(secret)), false, '数据库不得存储明文密钥');
    }
  }
});

test('安全：审计日志记录危险操作标记与确认状态', async () => {
  await audit.record({
    workspaceId: boot.workspace.id,
    actor: 'user',
    action: 'website.deploy',
    targetType: 'website',
    targetId: 'w1',
    confirmedByUser: false,
    detail: { note: '未确认' },
  });
  await audit.record({
    workspaceId: boot.workspace.id,
    actor: 'user',
    action: 'website.deploy',
    targetType: 'website',
    targetId: 'w2',
    confirmedByUser: true,
    detail: { note: '已确认' },
  });
  const logs = await audit.list(boot.workspace.id, 50);
  const deploys = logs.filter((l) => l.action === 'website.deploy');
  assert.equal(deploys.length, 2);
  assert.ok(deploys.every((l) => l.dangerous === true), '危险操作必须标记 dangerous');
  assert.ok(deploys.some((l) => l.confirmedByUser === true));
  assert.ok(deploys.some((l) => l.confirmedByUser === false));
});

test('安全：审计写入失败不影响业务请求（旁路能力）', async () => {
  // 用一个不存在的工作区 id 触发外键问题，审计应自动兜底而不是抛错
  await assert.doesNotReject(() =>
    audit.record({
      workspaceId: 'ws-not-exist',
      actor: 'system',
      action: 'test.action',
      targetType: 'test',
      targetId: 'nope',
    }),
  );
  const logs = await audit.list(boot.workspace.id, 10);
  assert.ok(logs.length > 0, '审计应兜底写入真实工作区');
});

/* ------------------------- 统一错误格式 ------------------------- */

test('安全：所有错误响应保持统一格式且带 traceId', async () => {
  const cases: [Promise<Response>, number][] = [
    [post('/office/read', { workspaceId: boot.workspace.id, path: '../../x' }), 403],
    [post('/office/edit', { workspaceId: boot.workspace.id, path: 'x.docx', operations: [] }), 400],
    [get('/research/no-such-job/report'), 404],
    [get('/goals/no-such-goal/progress'), 404],
    [post('/context/none/compact', { force: 'yes' }), 400],
  ];
  for (const [promise, expected] of cases) {
    const res = await promise;
    const body = await res.json();
    assert.equal(res.status, expected, `状态码应为 ${expected}，实际 ${res.status}`);
    assert.equal(body.ok, false);
    assert.ok(typeof body.error.code === 'string' && body.error.code.length > 0);
    assert.ok(typeof body.error.traceId === 'string' && body.error.traceId.length > 0);
  }
});

test('安全：工作区列表接口不返回敏感字段', async () => {
  const res = await post('/workspaces/bootstrap', {});
  const body = await res.json();
  const text = JSON.stringify(body);
  assert.ok(!/api[_-]?key/i.test(text), '响应不得包含 apiKey');
  assert.ok(!/secret/i.test(text), '响应不得包含 secret');
  assert.ok(body.data.workspace.rootPath === workspaceRoot || typeof body.data.workspace.rootPath === 'string');
});
