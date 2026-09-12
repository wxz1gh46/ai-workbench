import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseRequirementByRules, deriveProjectName, inferSiteType } from './requirements.ts';
import { generateFiles, scanForSecrets, writeProject, resolveEntry } from './websiteGenerator.ts';
import { sanitizeName } from './deployService.ts';
import { packFilesForUpload, formatBytes } from './uploadUtil.ts';
import { validateDomain } from './domainManager.ts';
import { validateRule } from './accessControl.ts';
import { gate, isDangerous, dangerCatalog } from '../security/dangerGate.ts';

/* ================================================================== */
/* Step 1：需求解析（纯函数，无 IO）                                    */
/* ================================================================== */

test('需求解析：静态站（无实体无表单）', () => {
  const plan = parseRequirementByRules('做一个公司官网，包含关于我们和联系我们页面');
  assert.equal(plan.siteType, 'static');
  assert.equal(plan.needsDatabase, false);
  assert.ok(plan.pages.some((p) => p.path === '/'));
  assert.ok(plan.pages.some((p) => p.path === '/about'));
  assert.ok(plan.pages.some((p) => p.path === '/contact'));
  assert.equal(plan.entities.length, 0);
});

test('需求解析：全栈站（有表单但无实体）', () => {
  const plan = parseRequirementByRules('做一个联系我们页面，带表单提交到后端接口');
  assert.equal(plan.siteType, 'fullstack');
  assert.ok(plan.apis.some((a) => a.path.includes('contact')));
  assert.equal(plan.needsDatabase, false);
});

test('需求解析：留言板会识别出 messages 实体（提到“留言”即需要持久化）', () => {
  const plan = parseRequirementByRules('做一个留言板页面，保存用户留言');
  assert.equal(plan.siteType, 'fullstack-db');
  assert.ok(plan.entities.some((e) => e.name === 'messages'));
});

test('需求解析：带数据库站（识别出实体）', () => {
  const plan = parseRequirementByRules('做一个 SaaS 客户管理系统，需要客户、订单和登录后台');
  assert.equal(plan.siteType, 'fullstack-db');
  assert.equal(plan.needsDatabase, true);
  assert.ok(plan.entities.some((e) => e.name === 'customers'));
  assert.ok(plan.entities.some((e) => e.name === 'orders'));
  assert.ok(plan.apis.some((a) => a.path === '/customers' && a.requiresDb));
  // 每个实体都要有主键
  for (const e of plan.entities) {
    assert.ok(e.columns.some((c) => c.primary), `${e.name} 缺少主键`);
  }
});

test('需求解析：样式与访问控制被识别', () => {
  const plan = parseRequirementByRules('做一个暗色科技风后台，仅内部员工访问需要白名单');
  assert.equal(plan.styling.tone, 'tech');
  assert.equal(plan.styling.darkMode, true);
  assert.equal(plan.accessControl.type, 'email-allowlist');
});

test('需求解析：空需求必须报错而不是生成空站', () => {
  assert.throws(() => parseRequirementByRules('   '), /需求描述不能为空/);
});

test('需求解析：站点类型推断的边界情况', () => {
  assert.equal(inferSiteType('纯展示页面', []).siteType, 'static');
  assert.equal(inferSiteType('需要后端接口', []).siteType, 'fullstack');
  assert.equal(
    inferSiteType('随便', [{ name: 'x', columns: [{ name: 'id', type: 'uuid', nullable: false, primary: true }] }]).siteType,
    'fullstack-db',
  );
});

test('项目名与目录名净化：不允许路径穿越字符', () => {
  assert.equal(sanitizeName('../../etc/passwd'), 'etc-passwd');
  assert.equal(sanitizeName('Hello World!!!'), 'hello-world');
  assert.equal(sanitizeName("中文项目"), "site");
  assert.match(deriveProjectName("中文项目"), /^site-[0-9a-f]{8}$/);
  assert.equal(deriveProjectName('my cool shop'), 'cool-shop');
});

/* ================================================================== */
/* Step 1：文件生成（结构正确性）                                       */
/* ================================================================== */

test('生成静态站：文件结构完整且可直接运行', () => {
  const plan = parseRequirementByRules('做一个公司官网，关于我们、联系我们');
  const files = generateFiles(plan, 'demo', '做一个公司官网');
  const paths = files.map((f) => f.path);
  for (const required of ['index.html', 'assets/styles.css', 'assets/app.js', 'package.json', 'server.mjs', 'README.md', '.env.example']) {
    assert.ok(paths.includes(required), `缺少 ${required}`);
  }
  // 入口文件必须存在
  const entry = resolveEntry(plan);
  assert.equal(entry.entryFile, 'index.html');
  // 生成的内容不含密钥
  for (const f of files) {
    assert.deepEqual(scanForSecrets(f.content), [], `${f.path} 含疑似密钥`);
  }
});

test('生成带数据库全栈站：包含 API / schema / 迁移 / down 脚本', () => {
  const plan = parseRequirementByRules('做一个订单管理系统，有客户和订单数据');
  const files = generateFiles(plan, 'demo', '订单管理系统');
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes('server.mjs'));
  assert.ok(paths.includes('api/_db.mjs'));
  assert.ok(paths.includes('api/customers.mjs'));
  assert.ok(paths.includes('api/orders.mjs'));
  assert.ok(paths.includes('db/schema.sql'));
  assert.ok(paths.includes('db/migrations/0001_init.sql'));
  // 回滚脚本必须存在（Phase 3 硬要求）
  assert.ok(paths.includes('db/migrations/0001_init.down.sql'), '缺少迁移回滚脚本');

  const up = files.find((f) => f.path === 'db/migrations/0001_init.sql')?.content ?? '';
  const down = files.find((f) => f.path === 'db/migrations/0001_init.down.sql')?.content ?? '';
  assert.match(up, /create table if not exists "customers"/i);
  assert.match(up, /gen_random_uuid\(\)/);
  assert.match(down, /drop table if exists/i);
});

test('生成的 API 使用参数化查询而不是字符串拼接', () => {
  const plan = parseRequirementByRules('做一个客户管理系统');
  const files = generateFiles(plan, 'demo', '客户管理');
  const api = files.find((f) => f.path === 'api/customers.mjs')?.content ?? '';
  assert.match(api, /\$\d/); // 占位符
  assert.match(api, /ORDER BY.*safeOrderBy|safeOrderBy\(/);
  // 不能出现把用户输入直接拼进 SQL 的写法
  assert.doesNotMatch(api, /'\s*\+\s*body\.\w+/);
});

test('生成的 server.mjs 使用动态加载 pg 并在缺失时降级', () => {
  const plan = parseRequirementByRules('做一个客户管理系统');
  const files = generateFiles(plan, 'demo', 'x');
  const db = files.find((f) => f.path === 'api/_db.mjs')?.content ?? '';
  assert.match(db, /await import\('pg'\)/);
  assert.match(db, /databaseStatus/);
  assert.match(db, /DATABASE_URL/);
  assert.match(db, /degraded|503/);
});

test('生成全栈站：server.mjs 为每个实体注册路由', () => {
  const plan = parseRequirementByRules('做一个客户和订单管理系统');
  const files = generateFiles(plan, 'demo', 'x');
  const server = files.find((f) => f.path === 'server.mjs')?.content ?? '';
  for (const e of plan.entities) {
    assert.match(server, new RegExp(`import \\{ routes as ${e.name}Routes \\}`), `缺少 ${e.name} 路由导入`);
    assert.match(server, new RegExp(`\\.\\.\\.${e.name}Routes`), `缺少 ${e.name} 路由挂载`);
  }
});

test('密钥扫描能识别常见凭据形态', () => {
  assert.deepEqual(scanForSecrets('const x = 1;'), []);
  // 假密钥运行时拼接：避免把「长得像真实密钥」的字符串写进源码（会被安全扫描命中）
  const fakeGhp = 'ghp_' + 'a'.repeat(36);
  const fakeSk = 'sk-' + 'b'.repeat(24);
  assert.ok(scanForSecrets(`token: ${fakeGhp}`).includes('github-pat'));
  assert.ok(scanForSecrets(`key=${fakeSk}`).includes('openai-key'));
  assert.ok(scanForSecrets('postgres://user:secret@host:5432/db').includes('postgres-uri-with-password'));
  assert.ok(scanForSecrets('-----BEGIN RSA PRIVATE KEY-----').includes('private-key'));
});

test('写入产物：拒绝含疑似密钥的生成内容', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-secret-'));
  try {
    await assert.rejects(
      writeProject(dir, 'x', [{ path: 'a.js', content: `const t = "${'ghp_' + 'c'.repeat(36)}";` }]),
      /检测到疑似密钥/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写入产物：未设置 workspaceRoot 时给出可读错误', async () => {
  await assert.rejects(writeProject(null, 'x', [{ path: 'a.txt', content: 'hi' }]), /工作区未设置根目录/);
});

test('写入产物：路径越界被拒绝（现在是显式的项目名校验）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-escape-'));
  try {
    // 净化前就拒绝，避免「静默修正成合法名」让用户误判写入位置
    await assert.rejects(writeProject(dir, '../../escape', [{ path: 'a.txt', content: 'x' }]), /路径分隔符|\.\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写入产物：重新生成会清空旧文件（避免残留导致接口 404）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-clean-'));
  try {
    await writeProject(dir, 'demo', [{ path: 'api/old.mjs', content: 'old' }]);
    assert.ok(existsSync(path.join(dir, 'websites/demo/api/old.mjs')));
    await writeProject(dir, 'demo', [{ path: 'api/new.mjs', content: 'new' }]);
    assert.ok(!existsSync(path.join(dir, 'websites/demo/api/old.mjs')), '旧文件应被清理');
    assert.ok(existsSync(path.join(dir, 'websites/demo/api/new.mjs')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('生成的 JS 语法可被解析（不会生成语法错误的站）', () => {
  const plan = parseRequirementByRules('做一个客户和订单管理系统，带后台管理');
  const files = generateFiles(plan, 'demo', 'x');
  const targets = files.filter((x) => x.path.endsWith('.mjs') || x.path.endsWith('.js'));
  assert.ok(targets.length > 0);
  for (const f of targets) {
    // ESM 语法（import/export）不能直接进 Function，改用 vm.SourceTextModule 之外的
    // 方式：node --check 等价物。这里用动态 import 的 data: URL 做「仅语法解析」不可行，
    // 因此改用 vm.compileFunction 处理，并对 import 语句做最小转换。
    // 生成的 .mjs 使用顶层 await（用于动态 import pg），因此包进 async 函数体校验语法
    const code = f.content.replace(/^import .*$/gm, '').replace(/^export /gm, '');
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (body: string) => unknown;
    assert.doesNotThrow(() => {
      new AsyncFunction(code);
    }, `${f.path} 语法错误`);
  }
});

/* ================================================================== */
/* Step 3：打包与部署辅助                                              */
/* ================================================================== */

test('打包上传：跳过二进制文件并显式报告', () => {
  const packed = packFilesForUpload([
    { path: 'index.html', content: '<html></html>' },
    { path: 'assets/logo.png', content: 'binary' },
    { path: '.env.example', content: 'X=' },
  ]);
  assert.equal(packed.fileCount, 2);
  assert.deepEqual(packed.skipped, ['assets/logo.png']);
  assert.ok(packed.totalBytes > 0);
});

test('formatBytes 输出可读单位', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.match(formatBytes(2048), /KB/);
  assert.match(formatBytes(3 * 1024 * 1024), /MB/);
});

test('域名校验：拒绝通配符、非法域名与平台保留域', () => {
  assert.equal(validateDomain('example.com'), 'example.com');
  assert.equal(validateDomain('WWW.Example.COM'), 'www.example.com');
  assert.throws(() => validateDomain('*.example.com'), /通配符/);
  assert.throws(() => validateDomain('not a domain'), /不合法/);
  assert.throws(() => validateDomain('foo.vercel.app'), /保留域名/);
  assert.throws(() => validateDomain(''), /不能为空/);
});

test('访问控制：密码强度与邮箱/IP 校验', () => {
  assert.throws(() => validateRule({ type: 'password', value: '123' }), /至少 8 位/);
  assert.doesNotThrow(() => validateRule({ type: 'password', value: 'a-strong-pass' }));
  assert.throws(() => validateRule({ type: 'email-allowlist', value: 'bad-email' }), /邮箱格式/);
  assert.doesNotThrow(() => validateRule({ type: 'email-allowlist', value: 'a@b.com, c@d.com' }));
  assert.throws(() => validateRule({ type: 'ip-allowlist', value: '999.1.1.1' }), /IP/);
  assert.doesNotThrow(() => validateRule({ type: 'ip-allowlist', value: '10.0.0.0/8' }));
});

/* ================================================================== */
/* 危险操作闸门                                                        */
/* ================================================================== */

test('危险操作：未确认一律拒绝，且错误信息可读', () => {
  assert.throws(() => gate('website.delete', false), /危险操作需二次确认/);
  assert.throws(() => gate('website.delete', undefined), /删除网站项目/);
  assert.doesNotThrow(() => gate('website.delete', true));
});

test('危险操作：非危险动作直接放行', () => {
  assert.equal(isDangerous('website.generate'), false);
  assert.doesNotThrow(() => gate('website.generate', false));
});

test('危险操作清单可枚举（供 UI 渲染确认弹窗）', () => {
  const catalog = dangerCatalog();
  assert.ok(catalog.length >= 10);
  for (const item of catalog) {
    assert.ok(item.action && item.summary && item.level);
  }
});
