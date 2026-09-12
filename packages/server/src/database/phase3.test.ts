import { createHash as createHashImpl } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresAdapter } from './postgresAdapter.ts';
import { generateSchema, mapType, migrationName } from './schemaGenerator.ts';
import { QueryRunner, withLimit } from './queryRunner.ts';
import { parseConnectionString } from './connectionManager.ts';
import { NeonAdapter } from './neonAdapter.ts';
import { SupabaseAdapter } from './supabaseAdapter.ts';
import { createAdapter, supportedProviders } from './adapterFactory.ts';
import { BackupService } from './backup.ts';
import { seal, unseal, maskSecret, redactConnectionString, hashPassword, verifyPassword } from '../security/secrets.ts';
import { parseRequirementByRules } from '../deploy/requirements.ts';

/* ================================================================== */
/* 加密存储（这是「凭据不落明文」的技术底座，必须先测）                  */
/* ================================================================== */

test('加密存储：seal → unseal 往返一致', () => {
  const value = { connectionString: 'postgres://u:p@h:5432/db', branch: 'main' };
  const sealed = seal(value);
  assert.ok(sealed.startsWith('v1:'));
  assert.equal(unseal<typeof value>(sealed)?.connectionString, value.connectionString);
});

test('加密存储：密文被篡改时解密失败（GCM 认证标签生效）', () => {
  const sealed = seal({ a: 1 });
  const parts = sealed.split(':');
  const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${Buffer.from('tampered').toString('base64url')}`;
  assert.throws(() => unseal(tampered));
});

test('加密存储：密文中不出现明文片段', () => {
  const secret = 'super-secret-token-value';
  const sealed = seal({ token: secret });
  assert.ok(!sealed.includes(secret));
});

test('脱敏：maskSecret 与连接串脱敏', () => {
  assert.equal(maskSecret('abcdefgh', 4), '****efgh');
  assert.equal(maskSecret(''), '');
  const redacted = redactConnectionString('postgres://admin:supersecret@db.example.com:5432/app?sslmode=require');
  assert.ok(!redacted.includes('supersecret'));
  assert.ok(redacted.includes('db.example.com'));
});

test('密码哈希：只存 hash，可校验，且相同密码产生不同 hash', () => {
  const h1 = hashPassword('my-password-123');
  const h2 = hashPassword('my-password-123');
  assert.notEqual(h1, h2, '不同 salt 应产生不同 hash');
  assert.ok(h1.startsWith('scrypt:'));
  assert.ok(!h1.includes('my-password-123'));
  assert.equal(verifyPassword('my-password-123', h1), true);
  assert.equal(verifyPassword('wrong', h1), false);
  assert.equal(verifyPassword('x', null), false);
});

/* ================================================================== */
/* 连接串解析                                                          */
/* ================================================================== */

test('连接串解析：提取 host/database/ssl，且不泄露密码', () => {
  const parsed = parseConnectionString('postgres://user:pass@ep-cool-123.us-east-1.aws.neon.tech/neondb?sslmode=require');
  assert.equal(parsed.host, 'ep-cool-123.us-east-1.aws.neon.tech');
  assert.equal(parsed.database, 'neondb');
  assert.equal(parsed.ssl, true);
  assert.equal(parseConnectionString('postgres://u:p@localhost:5432/db?sslmode=disable').ssl, false);
});

test('连接串解析：非法协议与格式给出可读错误', () => {
  assert.throws(() => parseConnectionString('mysql://u:p@h/db'), /协议不被支持/);
  assert.throws(() => parseConnectionString('not-a-url'), /格式不合法/);
});

/* ================================================================== */
/* SQL 安全（三层防护的第一层：静态拦截）                                */
/* ================================================================== */

test('SQL 静态校验：拦截 DROP DATABASE / TRUNCATE / 文件读取函数', () => {
  assert.match(PostgresAdapter.inspect('drop database prod').reason ?? '', /DROP DATABASE/);
  assert.match(PostgresAdapter.inspect('truncate table users').reason ?? '', /TRUNCATE/);
  assert.match(PostgresAdapter.inspect("select pg_read_file('/etc/passwd')").reason ?? '', /文件系统/);
  assert.match(PostgresAdapter.inspect("copy t from program 'rm -rf /'").reason ?? '', /文件系统/);
  assert.match(PostgresAdapter.inspect('create extension postgis').reason ?? '', /扩展安装/);
});

test('SQL 静态校验：识别写操作、拦截多语句写', () => {
  assert.equal(PostgresAdapter.inspect('select 1').isWrite, false);
  assert.equal(PostgresAdapter.inspect('insert into t values (1)').isWrite, true);
  assert.equal(PostgresAdapter.inspect('update t set a=1').isWrite, true);
  assert.equal(PostgresAdapter.inspect('delete from t').isWrite, true);
  assert.equal(PostgresAdapter.inspect('alter table t add column a int').isWrite, true);
  assert.equal(PostgresAdapter.inspect('select 1; drop table t').isWrite, true);
  assert.match(PostgresAdapter.inspect('insert into t values (1); delete from t').reason ?? '', /多语句/);
});

test('SQL 静态校验：空 SQL 被拒绝', () => {
  assert.equal(PostgresAdapter.inspect('   ').safe, false);
});

test('LIMIT 自动追加：SELECT 加 limit，已有 limit 不重复加', () => {
  assert.match(withLimit('select * from t', 50), /limit 50$/);
  assert.equal(withLimit('select * from t limit 10', 50), 'select * from t limit 10');
  assert.match(withLimit('with x as (select 1) select * from x', 20), /limit 20$/);
  assert.equal(withLimit('insert into t values (1)', 50), 'insert into t values (1)');
});

test('QueryRunner：只读模式下写操作被拒绝，写模式必须二次确认', async () => {
  const adapter = createAdapter({ provider: 'neon', connectionString: null });
  const runner = new QueryRunner(adapter);
  await assert.rejects(runner.run('insert into t values (1)', [], { readOnly: true }), /只读模式/);
  await assert.rejects(runner.run('insert into t values (1)', [], { readOnly: false, confirmed: false }), /二次确认/);
  await assert.rejects(runner.run('truncate t', [], { readOnly: false, confirmed: true }), /TRUNCATE/);
});

test('QueryRunner：未配置连接串时给出可读提示而不是底层错误', async () => {
  const adapter = createAdapter({ provider: 'neon', connectionString: null });
  const runner = new QueryRunner(adapter);
  await assert.rejects(runner.run('select 1', [], { readOnly: true }), /未配置数据库连接/);
});

test('QueryRunner.preflight 预检：写操作标记 needConfirm', () => {
  const adapter = createAdapter({ provider: 'neon', connectionString: null });
  const runner = new QueryRunner(adapter);
  const read = runner.preflight('select 1', { readOnly: true });
  assert.equal(read.isWrite, false);
  assert.equal(read.needConfirm, false);
  const write = runner.preflight('update t set a=1', { readOnly: false });
  assert.equal(write.isWrite, true);
  assert.equal(write.needConfirm, true);
  assert.equal(runner.preflight('drop database x', { readOnly: true }).safe, false);
});

/* ================================================================== */
/* Schema 生成                                                         */
/* ================================================================== */

test('Schema 生成：从需求产出表结构 + up/down 脚本', () => {
  const plan = parseRequirementByRules('做一个订单管理系统，有客户和订单');
  const { snapshot, up, down } = generateSchema(plan);
  assert.ok(snapshot.tables.length >= 2);
  assert.ok(snapshot.tables.some((t) => t.name === 'customers'));
  assert.ok(snapshot.tables.some((t) => t.name === 'orders'));
  assert.match(up, /create extension if not exists "pgcrypto"/);
  assert.match(up, /primary key default gen_random_uuid\(\)/);
  assert.match(down, /drop table if exists/i);
  // down 必须是 up 的逆序
  const upOrder = [...up.matchAll(/create table if not exists "(\w+)"/g)].map((m) => m[1]);
  const downOrder = [...down.matchAll(/drop table if exists "(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(downOrder, [...upOrder].reverse());
});

test('Schema 生成：Supabase 模式包含 RLS 策略', () => {
  const plan = parseRequirementByRules('做一个客户管理系统');
  const { up, snapshot } = generateSchema(plan, { withRls: true });
  assert.match(up, /enable row level security/);
  assert.match(up, /policy/);
  assert.ok(snapshot.tables.every((t) => t.rls === true));
});

test('Schema 生成：无实体时明确返回「无需数据库」', () => {
  const plan = parseRequirementByRules('做一个纯展示官网');
  const { snapshot, up } = generateSchema(plan);
  assert.equal(snapshot.tables.length, 0);
  assert.match(snapshot.note ?? '', /无需数据库/);
  assert.match(up, /无需数据库变更/);
});

test('Schema 生成：未知列类型被拒绝（不静默降级为 text）', () => {
  assert.throws(() => mapType('geo_point'), /不支持的列类型/);
  assert.equal(mapType('uuid'), 'uuid');
  assert.equal(mapType('TIMESTAMPTZ'), 'timestamptz');
  assert.equal(mapType('decimal'), 'numeric(14,2)');
  assert.equal(mapType('json'), 'jsonb');
});

test('Schema 生成：迁移名有序可读', () => {
  assert.equal(migrationName(1, 'Init Schema'), '0001_init_schema');
  assert.equal(migrationName(12, 'add orders table'), '0012_add_orders_table');
});

/* ================================================================== */
/* 适配器：未配置凭据时的降级行为（CI 里绝不能真实调用外部）             */
/* ================================================================== */

test('Neon 适配器：未配置连接串时 testConnection 返回 degraded 而不是抛错', async () => {
  const adapter = new NeonAdapter(null);
  const res = await adapter.testConnection();
  assert.equal(res.ok, false);
  assert.equal(res.degraded, true);
  assert.match(res.message, /未配置/);
  assert.match(res.message, /console\.neon\.tech/);
  assert.equal(adapter.configured(), false);
});

test('Supabase 适配器：未配置时降级，且列出需要用户提供的凭据', async () => {
  const adapter = new SupabaseAdapter(null);
  const res = await adapter.testConnection();
  assert.equal(res.degraded, true);
  const projects = await adapter.listProjects();
  assert.equal(projects.degraded, true);
  assert.match(projects.message, /SUPABASE_ACCESS_TOKEN/);
});

test('Neon 适配器：未配置 API Key 时列项目返回 degraded 而非抛错', async () => {
  const adapter = new NeonAdapter(null);
  const res = await adapter.listProjects();
  assert.equal(res.degraded, true);
  assert.match(res.message, /NEON_API_KEY/);
  assert.deepEqual(res.projects, []);
});

test('适配器工厂：四种 provider 都能创建，且默认只读', () => {
  for (const provider of ['neon', 'supabase', 'postgres'] as const) {
    const a = createAdapter({ provider, connectionString: null });
    assert.equal(a.configured(), false);
    assert.equal(a.provider, provider);
  }
  assert.throws(() => createAdapter({ provider: 'mysql' as never, connectionString: null }), /不支持的数据库类型/);
});

test('适配器工厂：provider 能力清单包含用户需自行准备的凭据', () => {
  const list = supportedProviders();
  assert.equal(list.length, 3);
  assert.ok(list.every((p) => p.needs.length > 0 && p.docs));
  assert.match(list.find((p) => p.provider === 'neon')?.needs.join(',') ?? '', /DATABASE_URL/);
});

/* ================================================================== */
/* Supabase RLS 策略生成                                               */
/* ================================================================== */

test('Supabase RLS：默认拒绝 + 显式放行，公开读单独成策略', () => {
  const sql = SupabaseAdapter.generateRlsPolicies([
    { name: 'posts', publicRead: true },
    { name: 'orders' },
  ]);
  assert.match(sql, /alter table if exists public\."posts" enable row level security/);
  assert.match(sql, /create policy "posts_public_read" on public\."posts" for select using \(true\)/);
  assert.match(sql, /create policy "orders_auth_write" on public\."orders" for all to authenticated/);
  // 没标记公开读的表不能有 public_read 策略
  assert.doesNotMatch(sql, /orders_public_read/);
});

/* ================================================================== */
/* 备份与恢复                                                          */
/* ================================================================== */

test('备份：sha256 校验能发现被篡改的备份', () => {
  const artifact = {
    id: 'b1',
    connectionId: 'db1',
    createdAt: new Date().toISOString(),
    format: 'sql' as const,
    bytes: 10,
    tables: 1,
    sha256: 'deadbeef',
    preview: 'select 1',
    content: 'select 1;',
  };
  const res = BackupService.verify(artifact);
  assert.equal(res.ok, false);
  assert.match(res.message, /sha256 不匹配/);
});

test('备份：校验通过时返回表数与体积', () => {
  const content = 'create table t (a int);';
  const artifact = {
    id: 'b1',
    connectionId: 'db1',
    createdAt: new Date().toISOString(),
    format: 'sql' as const,
    bytes: content.length,
    tables: 3,
    sha256: createHash(content),
    preview: content,
    content,
  };
  const res = BackupService.verify(artifact);
  assert.equal(res.ok, true);
  assert.match(res.message, /3 张表/);
});

test('恢复计划：必须二次确认，且给出分步指引', () => {
  const content = 'create table t (a int);';
  const artifact = {
    id: 'b1',
    connectionId: 'db1',
    createdAt: new Date().toISOString(),
    format: 'sql' as const,
    bytes: content.length,
    tables: 1,
    sha256: createHash(content),
    preview: content,
    content,
  };
  const plan = BackupService.planRestore(artifact);
  assert.equal(plan.requiresConfirm, true);
  assert.equal(plan.sql, content);
  assert.ok(plan.steps.length >= 3);
  assert.match(plan.steps.join(' '), /pg_restore/);
});

function createHash(s: string): string {
  return createHashImpl('sha256').update(s).digest('hex');
}
