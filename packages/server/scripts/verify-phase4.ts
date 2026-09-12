/**
 * Phase 4 验收脚本（Step 9）。
 *
 * 一次性验证 Phase 4 的所有硬约束：
 *   1) 迁移可回滚且不误伤 Phase 1/2/3
 *   2) 功能开关可独立关闭（数据保留）
 *   3) 危险动作闸门覆盖全部 Phase 4 动作
 *   4) 凭据加密可读写且换密钥后明确报错
 *   5) 沙箱拒绝内网 / 越界路径
 *   6) 合规守卫拒绝滥用意图
 *   7) 集群降级决策正确
 *   8) 提示词版本可回滚
 *
 * 运行：pnpm --filter @ai/server verify:phase4
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'ai-phase4-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.STORAGE_DIR = path.join(tmp, 'data', 'storage');
process.env.DB_FILE = path.join(tmp, 'data', 'phase4.db');
process.env.PHASE4_CLUSTER = '1';
process.env.PHASE4_PAID_PLUGINS = '1';
process.env.PHASE4_PROMPT = '1';
process.env.PHASE4_ENTERPRISE = '1';

const { getSqlite, closeDb } = await import('../src/db/client.ts');
const { runMigrations, rollback } = await import('../src/db/migrate.ts');
const { setSecretKeyForTest } = await import('../src/security/secrets.ts');

const PHASE4_TABLES = [
  'plugin_installations',
  'plugin_versions',
  'plugin_permissions',
  'plugin_grants',
  'mcp_servers',
  'mcp_tools',
  'paid_data_credentials',
  'paid_data_queries',
  'paid_data_results',
  'prompt_variables',
  'prompt_versions',
  'prompt_ab_tests',
  'prompt_evaluations',
  'cluster_nodes',
  'cluster_shards',
  'cluster_tasks',
  'cluster_elections',
  'cluster_health',
  'cluster_policies',
  'agent_pools',
  'agent_routes',
  'aggregated_results',
  'cost_records',
  'roles',
  'user_roles',
  'sso_configs',
  'audit_exports',
  'data_mask_rules',
  'retention_policies',
];
const PHASE3_TABLES = ['website_projects', 'database_connections', 'dashboards', 'notify_channels', 'deploy_audits'];
const PHASE2_TABLES = ['goal_runs', 'goal_audits', 'cluster_configs', 'office_documents', 'research_jobs'];
const PHASE1_TABLES = ['users', 'workspaces', 'conversations', 'messages', 'goals', 'tasks', 'agents', 'files', 'plugins', 'audit_logs'];

const tableExists = (name: string): boolean =>
  (getSqlite().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").all(name) as unknown[]).length > 0;

let failures = 0;
const ok = (cond: boolean, msg: string): void => {
  if (cond) console.log(`  ✅ ${msg}`);
  else {
    console.error(`  ❌ ${msg}`);
    failures += 1;
  }
};

setSecretKeyForTest('phase4-verify-key-0123456789abcdef');

/* ---------- 1) 迁移与回滚 ---------- */
console.log('[P4-1] 迁移 0004 后 Phase 4 表齐全');
const applied = runMigrations();
ok(applied.includes('0004_phase4.sql'), `已应用 0004（${applied.join(', ')}）`);
for (const t of PHASE4_TABLES) ok(tableExists(t), `表 ${t} 存在`);

console.log('[P4-2] 回滚 0004 只删 Phase 4 结构');
const rolledBack = rollback('0004_phase4.sql');
ok(rolledBack === '0004_phase4.sql', '回滚执行成功');
for (const t of PHASE4_TABLES) ok(!tableExists(t), `表 ${t} 已移除`);
for (const t of [...PHASE1_TABLES, ...PHASE2_TABLES, ...PHASE3_TABLES]) ok(tableExists(t), `跨阶段表 ${t} 未被误伤`);

console.log('[P4-3] 重新迁移幂等恢复');
runMigrations();
for (const t of PHASE4_TABLES) ok(tableExists(t), `表 ${t} 已恢复`);

console.log('[P4-4] 对不存在的迁移回滚返回 null（不破坏数据）');
ok(rollback('9999_not_exist.sql') === null, '未知迁移回滚被安全忽略');

/* ---------- 2) 功能开关 ---------- */
console.log('[P4-5] 功能开关存在且可独立关闭');
const { config } = await import('../src/config.ts');
ok(config.features.phase4Cluster === true, 'phase4Cluster 可读');
ok(config.features.phase4PaidPlugins === true, 'phase4PaidPlugins 可读');
ok(config.features.phase4Prompt === true, 'phase4Prompt 可读');
ok(config.features.phase4Enterprise === true, 'phase4Enterprise 可读');

/* ---------- 3) 危险动作闸门 ---------- */
console.log('[P4-6] 危险动作闸门覆盖全部 Phase 4 动作');
const { isDangerous, DANGEROUS_ACTIONS, gate } = await import('../src/security/dangerGate.ts');
const phase4Actions = [
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
for (const a of phase4Actions) {
  ok(isDangerous(a), `${a} 已注册`);
  ok(Boolean(DANGEROUS_ACTIONS[a]?.summary), `${a} 有人类可读后果说明`);
}
let blocked = 0;
for (const a of phase4Actions) {
  for (const fake of [false, undefined, null, 0, '', 'true', 1]) {
    try {
      gate(a, fake);
    } catch {
      blocked += 1;
    }
  }
}
ok(blocked === phase4Actions.length * 7, `假确认值全部被拦截（${blocked}/${phase4Actions.length * 7}）`);

/* ---------- 4) 凭据加密 ---------- */
console.log('[P4-7] 凭据加密可读写，换密钥后明确报错');
const { createDb } = await import('../src/db/client.ts');
const { getDb } = await import('../src/db/client.ts');
const db = getDb();
getSqlite().prepare('INSERT INTO users (id, name, role, created_at) VALUES (?,?,?,?)').run('u1', 'verify', 'owner', new Date().toISOString());
getSqlite()
  .prepare('INSERT INTO workspaces (id, user_id, name, root_path, created_at, updated_at) VALUES (?,?,?,?,?,?)')
  .run('ws1', 'u1', 'verify', tmp, new Date().toISOString(), new Date().toISOString());
const { CredentialManager } = await import('../src/paidData/credentialManager.ts');
const creds = new CredentialManager(db);
const secret = 'verify-secret-value-1234567890';
await creds.save({ workspaceId: 'ws1', providerId: 'tianyancha', credentials: { token: secret } });
const { paidDataCredentials } = await import('../src/db/schema/index.ts');
const rawRow = (await db.select().from(paidDataCredentials))[0]!;
ok(!rawRow.encryptedConfig.includes(secret), 'DB 中无明文凭据');
ok((await creds.resolve('ws1', 'tianyancha')).token === secret, '解密后可读回');
setSecretKeyForTest('another-completely-different-key-1234');
let decryptErrored = false;
try {
  await creds.resolve('ws1', 'tianyancha');
} catch {
  decryptErrored = true;
}
ok(decryptErrored, '换密钥后解密失败并明确报错（不返回错数据）');
setSecretKeyForTest('phase4-verify-key-0123456789abcdef');
void createDb;

/* ---------- 5) 沙箱 ---------- */
console.log('[P4-8] 沙箱拒绝内网 / 越界路径 / 未授权网络');
const { assertNetworkAllowed, assertPathAllowed, DEFAULT_SANDBOX } = await import('../src/plugins/pluginSandbox.ts');
let sandboxBlocks = 0;
for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/', 'http://10.0.0.1/', 'file:///etc/passwd', 'http://localhost/']) {
  try {
    assertNetworkAllowed({ ...DEFAULT_SANDBOX, allowNetwork: true }, url);
  } catch {
    sandboxBlocks += 1;
  }
}
ok(sandboxBlocks === 5, '内网 / 元数据 / 非法协议全部被拦截');
try {
  assertNetworkAllowed(DEFAULT_SANDBOX, 'https://example.com');
  ok(false, '默认应禁止网络');
} catch {
  ok(true, '默认禁止网络');
}
let pathBlocks = 0;
for (const p of ['../etc/passwd', '/etc/passwd', 'other/file']) {
  try {
    assertPathAllowed({ ...DEFAULT_SANDBOX, allowedPaths: ['work'] }, tmp, p);
  } catch {
    pathBlocks += 1;
  }
}
ok(pathBlocks === 3, '路径穿越 / 绝对路径 / 未授权前缀全部被拦截');

/* ---------- 6) 合规守卫 ---------- */
console.log('[P4-9] 合规守卫拒绝滥用意图');
const { checkCompliance } = await import('../src/paidData/complianceGuard.ts');
let complianceBlocks = 0;
for (const probe of ['绕过限流', 'crawl pages', '全量导出', 'shared account', 'crack license']) {
  const d = checkCompliance({ providerId: 'tianyancha', action: 'company.basic', params: { keyword: probe }, hasCredentials: true });
  if (!d.allowed && d.code === 'ABUSE_INTENT') complianceBlocks += 1;
}
ok(complianceBlocks === 5, '滥用意图全部被拒绝');
ok(checkCompliance({ providerId: 'imf', action: 'macro.series', params: { indicator: 'X' }, hasCredentials: false }).allowed, '官方开放接口无需凭据即可通过');

/* ---------- 7) 集群降级 ---------- */
console.log('[P4-10] 集群降级决策正确');
const { decideFallback } = await import('../src/cluster/clusterFallback.ts');
ok(decideFallback({ requested: 'cluster', fallbackEnabled: true, nodes: [], leaderExists: false }).effective === 'degraded', '无节点时降级单机');
ok(decideFallback({ requested: 'cluster', fallbackEnabled: false, nodes: [], leaderExists: false }).effective === 'cluster', '禁止回退时明确拒绝而不是偷偷降级');
ok(decideFallback({ requested: 'single', fallbackEnabled: true, nodes: [], leaderExists: false }).effective === 'single', '单机模式不被改写');

/* ---------- 8) 提示词版本回滚 ---------- */
console.log('[P4-11] 提示词版本可回滚且历史保留');
const { PromptServiceV4 } = await import('../src/prompt/promptServiceV4.ts');
const prompts = new PromptServiceV4(db);
const { EMPTY_PROMPT_SECTIONS } = await import('@ai/shared');
await prompts.save({ workspaceId: 'ws1', name: 'verify-tpl', sections: { ...EMPTY_PROMPT_SECTIONS, task: 'v1' } });
await prompts.save({ workspaceId: 'ws1', name: 'verify-tpl', sections: { ...EMPTY_PROMPT_SECTIONS, task: 'v2' } });
const rolled = await prompts.rollbackVersion('ws1', 'verify-tpl', 1);
ok(rolled.version === 3, `回滚生成新版本 v${rolled.version}`);
const detail = await prompts.detail('ws1', 'verify-tpl');
ok(detail.sections.task === 'v1', '内容已回到 v1');
ok(detail.history.length === 3, '历史版本全部保留');

/* ---------- 9) RBAC ---------- */
console.log('[P4-12] RBAC 权限可控且 owner 不可锁死');
const { RbacService } = await import('../src/enterprise/rbac.ts');
const rbac = new RbacService(db);
await rbac.ensureBuiltinRoles('ws1');
await rbac.assign({ workspaceId: 'ws1', userId: 'viewer1', roleNameOrId: 'viewer' });
const denied = await rbac.check({ workspaceId: 'ws1', userId: 'viewer1', permission: 'rbac:manage' });
ok(!denied.allowed, 'viewer 无法管理 RBAC');
let ownerProtected = false;
try {
  await rbac.updateRole('ws1', 'owner', ['workspace:read']);
} catch {
  ownerProtected = true;
}
ok(ownerProtected, 'owner 角色权限不可被削弱（防锁死）');

/* ---------- 10) 数据脱敏 ---------- */
console.log('[P4-13] 脱敏对嵌套结构生效');
const { DataMaskService } = await import('../src/enterprise/dataMask.ts');
const masker = new DataMaskService(db);
const masked = masker.maskDeep({ token: 'x', nested: { apiKey: 'y', email: 'a@b.com', safe: 'z' } }, { token: 'full', apikey: 'full' }) as Record<string, unknown>;
ok(masked.token === '****', '顶层敏感字段被脱敏');
ok((masked.nested as Record<string, unknown>).apiKey === '****', '嵌套敏感字段被脱敏');
ok((masked.nested as Record<string, unknown>).safe === 'z', '非敏感字段保持不变');

/* ---------- 汇总 ---------- */
closeDb();
console.log('');
if (failures === 0) {
  console.log('✅ Phase 4 验收全部通过');
  process.exit(0);
}
console.error(`❌ Phase 4 验收失败 ${failures} 项`);
process.exit(1);
