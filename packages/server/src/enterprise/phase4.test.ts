import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDb, createDb } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { setSecretKeyForTest } from '../security/secrets.ts';
import { ALL_PERMISSIONS, BUILTIN_ROLES, PERMISSIONS, RbacService, isPermission } from './rbac.ts';
import { DataMaskService, defaultStrategyFor, maskValue, partialMask } from './dataMask.ts';
import { AuditQueryService } from './auditLog.ts';
import { RetentionService, RETENTION_DATA_TYPES } from './retentionPolicy.ts';
import { SsoService } from './sso.ts';
import { ComplianceExportService } from './complianceExport.ts';

function setup(name: string) {
  closeDb();
  const dir = mkdtempSync(path.join(tmpdir(), `p4en-${name}-`));
  setSecretKeyForTest('phase4-ent-test-key-0123456789abc');
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

/* ------------------------------ RBAC ------------------------------ */

test('内置角色幂等初始化，owner 拥有全部权限', async () => {
  const ctx = setup('rbac-init');
  const rbac = new RbacService(ctx.db);
  const first = await rbac.ensureBuiltinRoles(ctx.workspaceId);
  const second = await rbac.ensureBuiltinRoles(ctx.workspaceId);
  assert.equal(first.length, second.length, '重复初始化不应重复创建');
  assert.equal(first.length, BUILTIN_ROLES.length);
  const owner = first.find((r) => r.name === 'owner')!;
  assert.equal(owner.permissions.length, ALL_PERMISSIONS.length);
  ctx.cleanup();
});

test('内置角色权限随版本同步（新增权限点自动生效）', async () => {
  const ctx = setup('rbac-sync');
  const rbac = new RbacService(ctx.db);
  await rbac.ensureBuiltinRoles(ctx.workspaceId);
  const { roles } = await import('../db/schema/index.ts');
  const { eq } = await import('drizzle-orm');
  const admin = (await rbac.listRoles(ctx.workspaceId)).find((r) => r.name === 'admin')!;
  await ctx.db.update(roles).set({ permissions: [] as never }).where(eq(roles.id, admin.id));
  assert.equal((await rbac.getRole(ctx.workspaceId, 'admin')).permissions.length, 0);
  await rbac.ensureBuiltinRoles(ctx.workspaceId);
  assert.ok((await rbac.getRole(ctx.workspaceId, 'admin')).permissions.length > 0, '内置角色权限应被同步回来');
  ctx.cleanup();
});

test('创建角色校验权限点与重名', async () => {
  const ctx = setup('rbac-create');
  const rbac = new RbacService(ctx.db);
  await assert.rejects(() => rbac.createRole({ workspaceId: ctx.workspaceId, name: 'x', permissions: ['not:a:perm'] }), /未知权限点/);
  await assert.rejects(() => rbac.createRole({ workspaceId: ctx.workspaceId, name: 'owner', permissions: [] }), /内置角色同名/);
  const role = await rbac.createRole({ workspaceId: ctx.workspaceId, name: 'custom', permissions: ['workspace:read'] });
  assert.equal(role.builtin, false);
  await assert.rejects(() => rbac.createRole({ workspaceId: ctx.workspaceId, name: 'custom', permissions: [] }), /已存在/);
  ctx.cleanup();
});

test('owner 角色权限不可修改（防锁死系统）', async () => {
  const ctx = setup('rbac-owner');
  const rbac = new RbacService(ctx.db);
  await rbac.ensureBuiltinRoles(ctx.workspaceId);
  await assert.rejects(() => rbac.updateRole(ctx.workspaceId, 'owner', ['workspace:read']), /不可修改/);
  ctx.cleanup();
});

test('内置角色不可删除，被引用的角色不可删除', async () => {
  const ctx = setup('rbac-delete');
  const rbac = new RbacService(ctx.db);
  await rbac.ensureBuiltinRoles(ctx.workspaceId);
  await assert.rejects(() => rbac.deleteRole(ctx.workspaceId, 'viewer'), /内置角色不可删除/);
  await rbac.createRole({ workspaceId: ctx.workspaceId, name: 'temp', permissions: ['workspace:read'] });
  await rbac.assign({ workspaceId: ctx.workspaceId, userId: 'u2', roleNameOrId: 'temp' });
  await assert.rejects(() => rbac.deleteRole(ctx.workspaceId, 'temp'), /仍被 1 个用户使用/);
  await rbac.unassign({ workspaceId: ctx.workspaceId, userId: 'u2', roleNameOrId: 'temp' });
  assert.equal((await rbac.deleteRole(ctx.workspaceId, 'temp')).name, 'temp');
  ctx.cleanup();
});

test('权限取并集：多角色叠加', async () => {
  const ctx = setup('rbac-multi');
  const rbac = new RbacService(ctx.db);
  await rbac.ensureBuiltinRoles(ctx.workspaceId);
  await rbac.assign({ workspaceId: ctx.workspaceId, userId: 'u2', roleNameOrId: 'viewer' });
  await rbac.assign({ workspaceId: ctx.workspaceId, userId: 'u2', roleNameOrId: 'auditor' });
  const perms = await rbac.permissionsOf(ctx.workspaceId, 'u2');
  assert.ok(perms.includes('workspace:read'));
  assert.ok(perms.includes('audit:export'));
  assert.equal(perms.includes('rbac:manage'), false, 'viewer+auditor 不应拿到管理权限');
  ctx.cleanup();
});

test('权限校验：未分配角色视为 owner（单机模式可用性优先）', async () => {
  const ctx = setup('rbac-default');
  const rbac = new RbacService(ctx.db);
  await rbac.ensureBuiltinRoles(ctx.workspaceId);
  const res = await rbac.check({ workspaceId: ctx.workspaceId, userId: 'nobody', permission: 'cluster:manage' });
  assert.equal(res.allowed, true);
  assert.match(res.reason, /未分配角色的用户按 owner/);
  ctx.cleanup();
});

test('分配角色后严格按角色校验，403 里点名缺失权限', async () => {
  const ctx = setup('rbac-enforce');
  const rbac = new RbacService(ctx.db);
  await rbac.ensureBuiltinRoles(ctx.workspaceId);
  await rbac.assign({ workspaceId: ctx.workspaceId, userId: 'u2', roleNameOrId: 'viewer' });
  const ok = await rbac.check({ workspaceId: ctx.workspaceId, userId: 'u2', permission: 'workspace:read' });
  assert.equal(ok.allowed, true);
  const no = await rbac.check({ workspaceId: ctx.workspaceId, userId: 'u2', permission: 'rbac:manage' });
  assert.equal(no.allowed, false);
  assert.match(no.reason, /rbac:manage/);
  await assert.rejects(() => rbac.enforce({ workspaceId: ctx.workspaceId, userId: 'u2', permission: 'cluster:manage' }), /缺少权限 cluster:manage/);
  ctx.cleanup();
});

test('重复分配角色幂等', async () => {
  const ctx = setup('rbac-idempotent');
  const rbac = new RbacService(ctx.db);
  await rbac.ensureBuiltinRoles(ctx.workspaceId);
  const a = await rbac.assign({ workspaceId: ctx.workspaceId, userId: 'u3', roleNameOrId: 'viewer' });
  const b = await rbac.assign({ workspaceId: ctx.workspaceId, userId: 'u3', roleNameOrId: 'viewer' });
  assert.equal(a.assigned, true);
  assert.equal(b.assigned, false);
  assert.equal((await rbac.listUserRoles(ctx.workspaceId)).length, 1);
  ctx.cleanup();
});

test('权限目录与常量完整', () => {
  assert.ok(Object.keys(PERMISSIONS).length >= 15);
  assert.equal(isPermission('workspace:read'), true);
  assert.equal(isPermission('nope'), false);
  const catalog = new RbacService(null as never).permissionCatalog();
  assert.equal(catalog.length, Object.keys(PERMISSIONS).length);
});

/* ------------------------------ 脱敏 ------------------------------ */

test('默认敏感字段兜底策略（防漏配即明文外泄）', () => {
  assert.equal(defaultStrategyFor('apiToken'), 'full');
  assert.equal(defaultStrategyFor('client_secret'), 'full');
  assert.equal(defaultStrategyFor('userEmail'), 'partial');
  assert.equal(defaultStrategyFor('nickname'), null);
});

test('脱敏策略行为正确', () => {
  assert.equal(maskValue('secret', 'full'), '****');
  assert.equal(maskValue('x', 'nullify'), null);
  assert.match(String(maskValue('value', 'hash')), /^sha256:[0-9a-f]{16}$/);
  assert.equal(maskValue(null, 'full'), null);
});

test('部分脱敏按内容形态选择规则（邮箱 / 手机 / 银行卡）', () => {
  assert.equal(partialMask('alice@example.com'), 'a****@example.com');
  assert.equal(partialMask('13812345678'), '138****5678');
  assert.equal(partialMask('6222021234567890'), '6222********7890');
  assert.equal(partialMask('ab'), '**');
});

test('深度脱敏递归处理嵌套结构并截断超深结构', () => {
  const svc = new DataMaskService(null as never);
  const out = svc.maskDeep({ token: 'x', nested: { apiKey: 'y', safe: 'z' }, list: [{ email: 'a@b.com' }] }, { token: 'full', apikey: 'full' }) as Record<string, unknown>;
  assert.equal(out.token, '****');
  assert.equal((out.nested as Record<string, unknown>).apiKey, '****');
  assert.equal((out.nested as Record<string, unknown>).safe, 'z');
  assert.match(String(((out.list as unknown[])[0] as Record<string, unknown>).email), /\*/);

  let deep: Record<string, unknown> = { token: 'x' };
  for (let i = 0; i < 10; i += 1) deep = { inner: deep };
  const masked = JSON.stringify(svc.maskDeep(deep, { token: 'full' }));
  assert.match(masked, /max-depth/);
});

test('脱敏规则 CRUD 与目标维度', async () => {
  const ctx = setup('mask-rules');
  const svc = new DataMaskService(ctx.db);
  await assert.rejects(() => svc.upsertRule({ workspaceId: ctx.workspaceId, field: 'x', strategy: 'nope' as 'full' }), /未知脱敏策略/);
  const r1 = await svc.upsertRule({ workspaceId: ctx.workspaceId, field: 'customerName', strategy: 'partial' });
  const r2 = await svc.upsertRule({ workspaceId: ctx.workspaceId, field: 'customerName', strategy: 'full' });
  assert.equal(r1.id, r2.id, '同字段同目标应为更新');
  assert.equal(r2.strategy, 'full');
  const map = svc.buildStrategyMap([{ field: 'customerName', strategy: 'full', target: '*', enabled: true }]);
  assert.equal(map.customername, 'full');
  assert.equal(Object.keys(svc.buildStrategyMap([{ field: 'a', strategy: 'full', target: 'other', enabled: true }], '*')).length, 0);
  assert.equal((await svc.deleteRule(ctx.workspaceId, r1.id)).field, 'customerName');
  await assert.rejects(() => svc.deleteRule(ctx.workspaceId, 'nope'), /不存在/);
  ctx.cleanup();
});

test('maskMany 对整批记录应用规则', async () => {
  const ctx = setup('mask-many');
  const svc = new DataMaskService(ctx.db);
  await svc.upsertRule({ workspaceId: ctx.workspaceId, field: 'token', strategy: 'full' });
  const out = await svc.maskMany(ctx.workspaceId, [{ token: 'a' }, { token: 'b' }]);
  assert.deepEqual(out.map((o) => o.token), ['****', '****']);
  ctx.cleanup();
});

/* ------------------------------ 审计与导出 ------------------------------ */

async function seedAudit(ctx: ReturnType<typeof setup>, count: number) {
  const { auditLogs } = await import('../db/schema/index.ts');
  for (let i = 0; i < count; i += 1) {
    await ctx.db.insert(auditLogs).values({
      id: `adt${i}`,
      workspaceId: ctx.workspaceId,
      actor: i % 2 === 0 ? 'user' : 'agent',
      action: i % 3 === 0 ? 'plugin.install' : 'file.upload',
      targetType: 'plugin',
      targetId: `t${i}`,
      dangerous: i % 4 === 0,
      confirmedByUser: i % 8 !== 0,
      detail: { index: i, token: 'secret-value', email: 'a@b.com' } as never,
      createdAt: new Date(Date.now() - i * 60_000).toISOString(),
    } as never);
  }
}

test('审计查询支持时间 / 动作 / 执行者 / 危险动作过滤，且返回已脱敏', async () => {
  const ctx = setup('audit-list');
  await seedAudit(ctx, 12);
  const svc = new AuditQueryService(ctx.db, new DataMaskService(ctx.db));
  const all = await svc.list({ workspaceId: ctx.workspaceId, limit: 100 });
  assert.equal(all.length, 12);
  assert.equal(JSON.stringify(all).includes('secret-value'), false, 'detail 必须脱敏');
  const danger = await svc.list({ workspaceId: ctx.workspaceId, dangerousOnly: true, limit: 100 });
  assert.ok(danger.length > 0 && danger.every((r) => r.dangerous));
  const byAction = await svc.list({ workspaceId: ctx.workspaceId, action: 'plugin.install', limit: 100 });
  assert.ok(byAction.every((r) => r.action === 'plugin.install'));
  const byActor = await svc.list({ workspaceId: ctx.workspaceId, actor: 'agent', limit: 100 });
  assert.ok(byActor.every((r) => r.actor === 'agent'));
  const windowed = await svc.list({ workspaceId: ctx.workspaceId, from: new Date(Date.now() - 5 * 60_000).toISOString(), limit: 100 });
  assert.ok(windowed.length < 12);
  ctx.cleanup();
});

test('审计统计：识别未确认的危险操作', async () => {
  const ctx = setup('audit-stats');
  await seedAudit(ctx, 12);
  const svc = new AuditQueryService(ctx.db, new DataMaskService(ctx.db));
  const stats = await svc.stats(ctx.workspaceId);
  assert.equal(stats.total, 12);
  assert.ok(stats.dangerous > 0);
  assert.ok(stats.unconfirmedDangerous > 0, '存在「危险但未确认」的记录必须能被统计出来');
  assert.ok(stats.byAction.length > 0 && stats.byActor.length > 0);
  ctx.cleanup();
});

test('审计导出：生成 NDJSON、登记记录、并再写一条导出审计', async () => {
  const ctx = setup('audit-export');
  await seedAudit(ctx, 5);
  const svc = new AuditQueryService(ctx.db, new DataMaskService(ctx.db));
  const from = new Date(Date.now() - 3600_000).toISOString();
  const to = new Date().toISOString();
  const res = await svc.export({ workspaceId: ctx.workspaceId, from, to, outputDir: ctx.tempDir });
  assert.ok(existsSync(res.filePath));
  assert.equal(res.rowCount, 5);
  const body = readFileSync(res.filePath, 'utf8');
  assert.equal(body.includes('secret-value'), false, '导出内容必须脱敏');
  assert.equal(body.split('\n').filter(Boolean).length, 5);

  const exports = await svc.listExports(ctx.workspaceId);
  assert.equal(exports.length, 1);
  assert.equal(exports[0]!.status, 'succeeded');
  const logs = await svc.list({ workspaceId: ctx.workspaceId, action: 'audit.export', limit: 10 });
  assert.equal(logs.length, 1, '导出行为本身必须留痕');
  ctx.cleanup();
});

test('审计导出参数校验：时间范围必填且顺序正确', async () => {
  const ctx = setup('audit-export-validate');
  const svc = new AuditQueryService(ctx.db, new DataMaskService(ctx.db));
  const now = new Date().toISOString();
  await assert.rejects(() => svc.export({ workspaceId: ctx.workspaceId, from: '', to: now, outputDir: ctx.tempDir }), /必须指定时间范围/);
  await assert.rejects(() => svc.export({ workspaceId: ctx.workspaceId, from: now, to: new Date(Date.now() - 60000).toISOString(), outputDir: ctx.tempDir }), /不能晚于/);
  ctx.cleanup();
});

test('脱敏预览：让用户先看到导出后的样子', async () => {
  const ctx = setup('audit-preview');
  await seedAudit(ctx, 3);
  await new DataMaskService(ctx.db).upsertRule({ workspaceId: ctx.workspaceId, field: 'email', strategy: 'nullify' });
  const svc = new AuditQueryService(ctx.db, new DataMaskService(ctx.db));
  const preview = await svc.previewMask(ctx.workspaceId, 5);
  assert.equal(preview.samples.length, 3);
  assert.ok(preview.rules.some((r) => r.field === 'email'));
  ctx.cleanup();
});

/* ------------------------------ 保留策略 ------------------------------ */

test('保留策略类型白名单与禁止类型', async () => {
  const ctx = setup('retention-types');
  const svc = new RetentionService(ctx.db);
  await assert.rejects(() => svc.upsert({ workspaceId: ctx.workspaceId, dataType: 'users', retentionDays: 30 }), /不允许为 users 配置/);
  await assert.rejects(() => svc.upsert({ workspaceId: ctx.workspaceId, dataType: 'workspaces', retentionDays: 30 }), /不允许/);
  await assert.rejects(() => svc.upsert({ workspaceId: ctx.workspaceId, dataType: 'nope', retentionDays: 30 }), /未知数据类型/);
  await assert.rejects(() => svc.upsert({ workspaceId: ctx.workspaceId, dataType: 'audit_logs', retentionDays: 0 }), /保留天数/);
  await assert.rejects(() => svc.upsert({ workspaceId: ctx.workspaceId, dataType: 'audit_logs', retentionDays: 99999 }), /保留天数/);
  await assert.rejects(() => svc.upsert({ workspaceId: ctx.workspaceId, dataType: 'audit_logs', retentionDays: 30, action: 'nope' as 'delete' }), /未知动作/);
  const p = await svc.upsert({ workspaceId: ctx.workspaceId, dataType: 'audit_logs', retentionDays: 30 });
  assert.equal(p.action, 'delete');
  assert.equal((await svc.list(ctx.workspaceId)).length, 1);
  assert.equal(RETENTION_DATA_TYPES.length, 8);
  ctx.cleanup();
});

test('保留策略执行默认 dryRun（不删数据）', async () => {
  const ctx = setup('retention-dry');
  await seedAudit(ctx, 5);
  const svc = new RetentionService(ctx.db);
  await svc.upsert({ workspaceId: ctx.workspaceId, dataType: 'audit_logs', retentionDays: 1 });
  const results = await svc.apply({ workspaceId: ctx.workspaceId }, {
    audit_logs: async () => ({ scanned: 5, affected: 5 }),
  });
  assert.equal(results[0]!.dryRun, true);
  assert.equal(results[0]!.affected, 5);
  assert.match(results[0]!.detail, /预演/);
  ctx.cleanup();
});

test('保留策略确认执行后记录 lastRunAt 与影响条数', async () => {
  const ctx = setup('retention-apply');
  const svc = new RetentionService(ctx.db);
  await svc.upsert({ workspaceId: ctx.workspaceId, dataType: 'audit_logs', retentionDays: 1 });
  const results = await svc.apply({ workspaceId: ctx.workspaceId, dryRun: false }, {
    audit_logs: async () => ({ scanned: 3, affected: 3 }),
  });
  assert.equal(results[0]!.dryRun, false);
  const policy = (await svc.list(ctx.workspaceId))[0]!;
  assert.equal(policy.lastAffected, 3);
  assert.ok(policy.lastRunAt);
  ctx.cleanup();
});

test('未实现执行器的数据类型被跳过并说明（不误删）', async () => {
  const ctx = setup('retention-skip');
  const svc = new RetentionService(ctx.db);
  await svc.upsert({ workspaceId: ctx.workspaceId, dataType: 'conversations', retentionDays: 1 });
  const results = await svc.apply({ workspaceId: ctx.workspaceId, dryRun: false }, {});
  assert.equal(results[0]!.affected, 0);
  assert.match(results[0]!.detail, /未实现/);
  ctx.cleanup();
});

test('保留策略删除与空策略报错', async () => {
  const ctx = setup('retention-delete');
  const svc = new RetentionService(ctx.db);
  await assert.rejects(() => svc.apply({ workspaceId: ctx.workspaceId, dataType: 'audit_logs' }, {}), /没有启用的保留策略/);
  await svc.upsert({ workspaceId: ctx.workspaceId, dataType: 'cost_records', retentionDays: 90 });
  assert.equal((await svc.remove(ctx.workspaceId, 'cost_records')).removed, 'cost_records');
  await assert.rejects(() => svc.remove(ctx.workspaceId, 'cost_records'), /不存在/);
  ctx.cleanup();
});

test('停用的策略不参与执行', async () => {
  const ctx = setup('retention-disabled');
  const svc = new RetentionService(ctx.db);
  await svc.upsert({ workspaceId: ctx.workspaceId, dataType: 'audit_logs', retentionDays: 1, enabled: false });
  const results = await svc.apply({ workspaceId: ctx.workspaceId, dryRun: false }, { audit_logs: async () => ({ scanned: 9, affected: 9 }) });
  assert.equal(results.length, 0);
  ctx.cleanup();
});

/* ------------------------------ SSO ------------------------------ */

test('SSO 配置只接受「凭据变量名」，拒绝直接粘贴密钥', async () => {
  const ctx = setup('sso-ref');
  const svc = new SsoService(ctx.db);
  await assert.rejects(
    // 运行时拼接：避免源码里出现「像密钥的字面量」（源码密钥扫描器会误报）
    () => svc.upsert(ctx.workspaceId, { issuer: 'https://idp.example.com', clientId: 'c', clientSecretRef: ['sk', 'abcdefghijklmnopqrstuvwxyz'].join('-'), redirectUri: 'http://127.0.0.1:8787/cb' }, ['owner']),
    /看起来不是环境变量名/,
  );
  await assert.rejects(
    () => svc.upsert(ctx.workspaceId, { issuer: 'https://idp.example.com', clientId: 'c', clientSecretRef: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', redirectUri: 'http://127.0.0.1:8787/cb' }, ['owner']),
    /看起来不是环境变量名/,
  );
  ctx.cleanup();
});

test('SSO 配置校验 issuer 与角色映射', async () => {
  const ctx = setup('sso-validate');
  const svc = new SsoService(ctx.db);
  await assert.rejects(() => svc.upsert(ctx.workspaceId, { issuer: 'not-a-url', clientId: 'c', clientSecretRef: 'SSO_SECRET', redirectUri: 'x' }, ['owner']), /URL 不合法/);
  await assert.rejects(() => svc.upsert(ctx.workspaceId, { issuer: 'https://idp.example.com', clientId: 'c', clientSecretRef: 'SSO_SECRET', redirectUri: 'http://x/cb', groupMapping: { eng: 'ghost-role' } }, ['owner']), /不存在的角色/);
  await assert.rejects(() => svc.upsert(ctx.workspaceId, { issuer: 'https://idp.example.com', clientId: 'c', clientSecretRef: '', redirectUri: 'http://x/cb' }, ['owner']), /clientSecretRef/);
  await assert.rejects(() => svc.upsert(ctx.workspaceId, { issuer: 'https://idp.example.com', clientId: 'c', clientSecretRef: 'SSO_SECRET', redirectUri: 'x' }, ['owner']), /redirectUri/);
  ctx.cleanup();
});

test('SSO 描述不泄露 secret，只显示是否已配置', async () => {
  const ctx = setup('sso-describe');
  const svc = new SsoService(ctx.db);
  delete process.env.SSO_TEST_SECRET;
  const described = await svc.upsert(ctx.workspaceId, { issuer: 'https://idp.example.com', clientId: 'cid', clientSecretRef: 'SSO_TEST_SECRET', redirectUri: 'http://127.0.0.1:8787/cb', groupMapping: { eng: 'member' } }, ['member']);
  assert.equal(described.hasSecret, false);
  assert.equal(JSON.stringify(described).includes('SSO_TEST_SECRET='), false);
  assert.equal(described.clientSecretRef, 'SSO_TEST_SECRET');
  ctx.cleanup();
});

test('缺少密钥环境变量时不允许启用 SSO', async () => {
  const ctx = setup('sso-enable');
  const svc = new SsoService(ctx.db);
  delete process.env.SSO_ENABLE_SECRET;
  await svc.upsert(ctx.workspaceId, { issuer: 'https://idp.example.com', clientId: 'c', clientSecretRef: 'SSO_ENABLE_SECRET', redirectUri: 'http://x/cb' }, []);
  await assert.rejects(() => svc.setEnabled(ctx.workspaceId, true), /未设置，无法启用/);
  process.env.SSO_ENABLE_SECRET = 'a-very-long-secret-value';
  const enabled = await svc.setEnabled(ctx.workspaceId, true);
  assert.equal(enabled.enabled, true);
  delete process.env.SSO_ENABLE_SECRET;
  ctx.cleanup();
});

test('授权链接带 state 与 nonce，且 state 用后即失效', async () => {
  const ctx = setup('sso-state');
  const svc = new SsoService(ctx.db);
  process.env.SSO_STATE_SECRET = 'a-very-long-secret-value';
  await svc.upsert(ctx.workspaceId, { issuer: 'https://idp.example.com', clientId: 'cid', clientSecretRef: 'SSO_STATE_SECRET', redirectUri: 'http://127.0.0.1:8787/cb', enabled: true }, []);
  const auth = await svc.buildAuthUrl(ctx.workspaceId);
  assert.match(auth.url, /^https:\/\/idp\.example\.com\/authorize\?/);
  assert.match(auth.url, /state=/);
  assert.match(auth.url, /nonce=/);

  const bad = svc.consumeState({ state: 'forged' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /state 无效/);

  const ok = svc.consumeState({ state: auth.state, nonce: auth.nonce });
  assert.equal(ok.ok, true);
  const replay = svc.consumeState({ state: auth.state });
  assert.equal(replay.ok, false, 'state 必须用后即焚，防重放');
  delete process.env.SSO_STATE_SECRET;
  ctx.cleanup();
});

test('SAML 协议不生成授权链接（由 IdP 发起）', async () => {
  const ctx = setup('sso-saml');
  const svc = new SsoService(ctx.db);
  await svc.upsert(ctx.workspaceId, { protocol: 'saml', issuer: 'https://idp.example.com', clientId: 'c', clientSecretRef: 'X_SECRET', redirectUri: 'http://x/cb', enabled: true }, []);
  await assert.rejects(() => svc.buildAuthUrl(ctx.workspaceId), /SAML 登录由 IdP 发起/);
  ctx.cleanup();
});

test('SSO 角色映射与指纹', async () => {
  const ctx = setup('sso-map');
  const svc = new SsoService(ctx.db);
  await svc.upsert(ctx.workspaceId, { issuer: 'https://idp.example.com', clientId: 'c', clientSecretRef: 'X_SECRET', redirectUri: 'http://x/cb', groupMapping: { eng: 'member', sec: 'auditor' } }, ['member', 'auditor']);
  const roles = await svc.resolveRoles(ctx.workspaceId, ['eng', 'unknown']);
  assert.deepEqual(roles, ['member']);
  const fp = await svc.fingerprint(ctx.workspaceId);
  assert.match(fp ?? '', /^[0-9a-f]{16}$/);
  assert.equal((await svc.remove(ctx.workspaceId)).removed, true);
  await assert.rejects(() => svc.remove(ctx.workspaceId), /尚未配置 SSO/);
  ctx.cleanup();
});

/* ------------------------------ 合规导出 ------------------------------ */

test('合规包包含审计 / 脱敏规则 / 保留策略，且不含任何凭据', async () => {
  const ctx = setup('compliance-pkg');
  await seedAudit(ctx, 4);
  const svc = new ComplianceExportService(ctx.db, new AuditQueryService(ctx.db, new DataMaskService(ctx.db)), ctx.tempDir);
  const pkg = await svc.buildPackage({
    workspaceId: ctx.workspaceId,
    from: new Date(Date.now() - 3600_000).toISOString(),
    to: new Date().toISOString(),
    maskRules: [{ field: 'token', strategy: 'full', target: '*' }],
    retentionPolicies: [{ dataType: 'audit_logs', retentionDays: 90, action: 'delete', enabled: true }],
  });
  assert.equal(pkg.audit.length, 4);
  assert.equal(pkg.summary.auditCount, 4);
  assert.ok(pkg.summary.dangerousCount > 0);
  assert.equal(JSON.stringify(pkg).includes('secret-value'), false);
  assert.equal(pkg.maskRules.length, 1);
  assert.equal(pkg.retentionPolicies.length, 1);
  ctx.cleanup();
});

test('导出下载：越权与其他工作区访问被拒绝', async () => {
  const ctx = setup('compliance-download');
  await seedAudit(ctx, 2);
  const auditQuery = new AuditQueryService(ctx.db, new DataMaskService(ctx.db));
  const svc = new ComplianceExportService(ctx.db, auditQuery, ctx.tempDir);
  const res = await svc.exportAudit({ workspaceId: ctx.workspaceId, from: new Date(Date.now() - 3600_000).toISOString(), to: new Date().toISOString() });
  const file = await svc.readExport(ctx.workspaceId, res.exportId);
  assert.equal(file.rowCount, 2);
  assert.match(file.fileName, /^aexp_/);
  await assert.rejects(() => svc.readExport('ws2', res.exportId), /不存在/);
  await assert.rejects(() => svc.readExport(ctx.workspaceId, 'aexp_nope'), /不存在/);
  ctx.cleanup();
});

test('导出文件路径必须在 exports 目录内（防路径穿越）', async () => {
  const ctx = setup('compliance-traversal');
  const { auditExports } = await import('../db/schema/index.ts');
  const svc = new ComplianceExportService(ctx.db, new AuditQueryService(ctx.db, new DataMaskService(ctx.db)), ctx.tempDir);
  await ctx.db.insert(auditExports).values({
    id: 'aexp_evil',
    workspaceId: ctx.workspaceId,
    type: 'audit',
    rangeStart: '',
    rangeEnd: '',
    filePath: '/etc/passwd',
    rowCount: 1,
    status: 'succeeded',
    error: null,
    createdAt: new Date().toISOString(),
  } as never);
  await assert.rejects(() => svc.readExport(ctx.workspaceId, 'aexp_evil'), /路径越界/);
  ctx.cleanup();
});

test('导出文件缺失时给出可读错误', async () => {
  const ctx = setup('compliance-missing');
  const { auditExports } = await import('../db/schema/index.ts');
  const svc = new ComplianceExportService(ctx.db, new AuditQueryService(ctx.db, new DataMaskService(ctx.db)), ctx.tempDir);
  const fakePath = path.join(ctx.tempDir, 'exports', 'gone.ndjson');
  await ctx.db.insert(auditExports).values({
    id: 'aexp_gone',
    workspaceId: ctx.workspaceId,
    type: 'audit',
    rangeStart: '',
    rangeEnd: '',
    filePath: fakePath,
    rowCount: 0,
    status: 'succeeded',
    error: null,
    createdAt: new Date().toISOString(),
  } as never);
  await assert.rejects(() => svc.readExport(ctx.workspaceId, 'aexp_gone'), /已不存在/);
  ctx.cleanup();
});
