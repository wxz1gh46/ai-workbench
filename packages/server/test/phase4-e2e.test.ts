import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDb, createDb, type Db } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { setSecretKeyForTest } from '../src/security/secrets.ts';

/**
 * Phase 4 端到端集成测试。
 *
 * 覆盖三条真实链路（不依赖任何外部凭据 / 外部网络）：
 *   1) 插件：安装 → 逐项授权 → 调用 → 调用日志 → 撤销 → 卸载
 *   2) 付费数据：合规拒绝 → 配置凭据（加密）→ 预检 → 查询（降级）→ 审计
 *   3) 提示词：模板库 → 生成 → 优化 → 保存版本 → A/B 自动评估 → 报告
 *   4) 集群：引导 → 分片分发 → 节点失联 → 改派 → 状态降级
 *   5) 编排：DAG → 并行度 → 路由 → 聚合 → 成本
 *   6) 企业安全：RBAC → 审计 → 脱敏 → 保留策略 → 合规包
 */

interface Ctx {
  db: Db;
  workspaceId: string;
  tempDir: string;
  cleanup: () => void;
}

function setup(name: string): Ctx {
  closeDb();
  const dir = mkdtempSync(path.join(tmpdir(), `p4e2e-${name}-`));
  setSecretKeyForTest('phase4-e2e-test-key-0123456789abcd');
  process.env.DATA_DIR = dir;
  process.env.DB_FILE = path.join(dir, 'test.db');
  delete process.env.AI_API_KEY;
  for (const k of ['VERCEL_TOKEN', 'NEON_API_KEY', 'TIANYANCHA_TOKEN', 'WORKBENCH_TOKEN_BUDGET_USD']) delete process.env[k];
  const { db, sqlite } = createDb(process.env.DB_FILE);
  runMigrations();
  const now = new Date().toISOString();
  sqlite.prepare('INSERT INTO users (id, name, role, created_at) VALUES (?,?,?,?)').run('u1', '测试用户', 'owner', now);
  sqlite.prepare('INSERT INTO workspaces (id, user_id, name, root_path, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('ws1', 'u1', '测试工作区', dir, now, now);
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
/* 链路 1：插件全生命周期                                              */
/* ================================================================== */

test('E2E-插件：安装 → 授权 → 调用 → 日志 → 撤销 → 卸载', async () => {
  const ctx = setup('plugin');
  const { PluginInstaller } = await import('../src/plugins/pluginInstaller.ts');
  const { PluginRuntime } = await import('../src/plugins/pluginRuntime.ts');
  const { PluginCallLogger } = await import('../src/plugins/pluginCallLog.ts');

  const installer = new PluginInstaller(ctx.db);
  const runtime = new PluginRuntime(ctx.db);
  const calls = new PluginCallLogger(ctx.db);

  // 1) 市场浏览
  const market = installer.browse({ q: '文件' });
  assert.ok(market.length > 0);

  // 2) 安装
  const installed = await installer.install(ctx.workspaceId, 'mcp-filesystem');
  assert.equal(installed.grantedScopes.length, 0);

  // 3) 未授权调用被拒（返回 denied 而不是抛错，便于 UI 展示「去授权」）
  const denied = await runtime.invoke({ workspaceId: ctx.workspaceId, installationId: installed.installationId, tool: 'read_file', args: { path: 'a.txt' } });
  assert.equal(denied.ok, false);
  assert.deepEqual(denied.denied?.missingScopes, ['fs:read']);

  // 4) 授权 + 调用成功
  await installer.grant({ workspaceId: ctx.workspaceId, installationId: installed.installationId, scopes: ['fs:read'] });
  runtime.registerExecutor('mcp-filesystem', async () => ({ content: 'file body' }));
  const ok = await runtime.invoke({ workspaceId: ctx.workspaceId, installationId: installed.installationId, tool: 'read_file', args: { path: 'a.txt' } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.content, { content: 'file body' });

  // 5) 调用日志（成功与失败都在）
  const logs = await calls.list(ctx.workspaceId, installed.installationId, 50);
  assert.ok(logs.length >= 2);
  assert.ok(logs.some((l: { ok: boolean }) => !l.ok));

  // 6) 撤销后调用再次被拒
  await installer.revoke({ workspaceId: ctx.workspaceId, installationId: installed.installationId });
  const afterRevoke = await runtime.invoke({ workspaceId: ctx.workspaceId, installationId: installed.installationId, tool: 'read_file', args: { path: 'a.txt' } });
  assert.equal(afterRevoke.ok, false);

  // 7) 卸载后安装列表清空
  await installer.uninstall(ctx.workspaceId, installed.pluginId);
  assert.equal((await installer.listInstalled(ctx.workspaceId)).length, 0);
  ctx.cleanup();
});

/* ================================================================== */
/* 链路 2：付费数据                                                    */
/* ================================================================== */

test('E2E-付费数据：合规拒绝 → 加密配置 → 预检 → 查询 → 审计', async () => {
  const ctx = setup('paiddata');
  const { CredentialManager } = await import('../src/paidData/credentialManager.ts');
  const { PaidDataQueryRunner } = await import('../src/paidData/queryRunner.ts');
  const { AuditQueryService } = await import('../src/enterprise/auditLog.ts');
  const { DataMaskService } = await import('../src/enterprise/dataMask.ts');

  const creds = new CredentialManager(ctx.db);
  const runner = new PaidDataQueryRunner(ctx.db);

  // 1) 未配置凭据：查询被合规拒绝并落 blocked 记录
  const blocked = await runner.run({ workspaceId: ctx.workspaceId, providerId: 'tianyancha', action: 'company.basic', params: { keyword: '示例公司' }, credentials: {} });
  assert.equal(blocked.status, 'blocked');

  // 2) 写入凭据（加密）
  await creds.save({ workspaceId: ctx.workspaceId, providerId: 'tianyancha', credentials: { token: 'tyc-secret-token-value' } });
  const { paidDataCredentials } = await import('../src/db/schema/index.ts');
  const raw = (await ctx.db.select().from(paidDataCredentials))[0]!;
  assert.equal(raw.encryptedConfig.includes('tyc-secret-token-value'), false);

  // 3) 预检通过
  const pre = runner.preflight({ providerId: 'tianyancha', action: 'company.basic', params: { keyword: '示例' }, hasCredentials: true });
  assert.equal(pre.allowed, true);

  // 4) 查询：接口不可达时显式降级（不伪造数据）
  const resolved = await creds.resolve(ctx.workspaceId, 'tianyancha');
  const degraded = await runner.run({
    workspaceId: ctx.workspaceId,
    providerId: 'tianyancha',
    action: 'company.basic',
    params: { keyword: '示例' },
    credentials: resolved,
    fetchImpl: (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch,
  });
  assert.equal(degraded.degraded, true);

  // 5) 查询历史可查（含 blocked 与降级两次）
  const history = await runner.listQueries(ctx.workspaceId, 10);
  assert.equal(history.length, 2);

  // 6) 审计：记录查询动作（由路由层写，这里验证审计服务可用且脱敏）
  const audit = new AuditQueryService(ctx.db, new DataMaskService(ctx.db));
  const { auditLogs } = await import('../src/db/schema/index.ts');
  await ctx.db.insert(auditLogs).values({
    id: 'adt1',
    workspaceId: ctx.workspaceId,
    actor: 'user',
    action: 'paid_data.query',
    targetType: 'paid_data_provider',
    targetId: 'tianyancha',
    dangerous: true,
    confirmedByUser: true,
    detail: { token: 'tyc-secret-token-value', action: 'company.basic' } as never,
    createdAt: new Date().toISOString(),
  } as never);
  const logs = await audit.list({ workspaceId: ctx.workspaceId, action: 'paid_data.query', limit: 10 });
  assert.equal(logs.length, 1);
  assert.equal(JSON.stringify(logs).includes('tyc-secret-token-value'), false, '审计 detail 必须脱敏');
  ctx.cleanup();
});

/* ================================================================== */
/* 链路 3：提示词工程                                                  */
/* ================================================================== */

test('E2E-提示词：库 → 生成 → 优化 → 版本 → A/B → 报告', async () => {
  const ctx = setup('prompt');
  const { PromptServiceV4 } = await import('../src/prompt/promptServiceV4.ts');
  const svc = new PromptServiceV4(ctx.db);

  // 1) 库
  const lib = svc.library();
  assert.ok(lib.length >= 9);

  // 2) 生成（离线）
  const gen = await svc.generate({ workspaceId: ctx.workspaceId, goal: '调研 2026 年 AI 芯片市场格局' });
  assert.equal(gen.intent, 'research');
  assert.equal(gen.degraded, true);

  // 3) 优化（离线）
  const opt = await svc.optimize({ workspaceId: ctx.workspaceId, current: gen.sections as never });
  assert.ok(opt.score > 0);

  // 4) 保存两个版本
  const v1 = await svc.save({ workspaceId: ctx.workspaceId, name: '调研提示词', sections: gen.sections });
  const v2 = await svc.save({ workspaceId: ctx.workspaceId, name: '调研提示词', sections: opt.sections });
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);

  // 5) 一键复制：变量会被保留为 {{var}}，未填必填变量时 ok=false 并列出清单
  const copy = svc.copyable({ sections: opt.sections, variables: {}, name: '调研提示词' });
  assert.match(copy.markdown, /\{\{|##|#/);
  const withVars = svc.copyable({ sections: opt.sections, variables: Object.fromEntries(copy.missingRequired.map((m) => [m, 'x'])), name: '调研提示词' });
  assert.equal(withVars.ok, true, '补齐必填变量后应通过校验');
  assert.equal(withVars.missingRequired.length, 0);

  // 6) A/B 自动评估 + 报告
  const t = await svc.createABTest({ workspaceId: ctx.workspaceId, templateName: '调研提示词', versionA: 1, versionB: 2 });
  await svc.autoEvaluate({ workspaceId: ctx.workspaceId, abTestId: t.id });
  await svc.recordEvaluation({ workspaceId: ctx.workspaceId, abTestId: t.id, version: 'A', metric: 'accuracy', value: 3, sampleSize: 3 });
  await svc.recordEvaluation({ workspaceId: ctx.workspaceId, abTestId: t.id, version: 'B', metric: 'accuracy', value: 5, sampleSize: 3 });
  const report = await svc.finishABTest(ctx.workspaceId, t.id);
  assert.equal(report.winner, 'B');
  assert.equal(report.evaluations.length, 8, '3 自动指标 × 2 版本 + 2 个人工评分');

  // 7) 回滚到 v1 生成 v3
  const rolled = await svc.rollbackVersion(ctx.workspaceId, '调研提示词', 1);
  assert.equal(rolled.version, 3);
  ctx.cleanup();
});

/* ================================================================== */
/* 链路 4：集群                                                       */
/* ================================================================== */

test('E2E-集群：引导 → 分发 → 失联改派 → 降级状态', async () => {
  const ctx = setup('cluster');
  const { ClusterManager } = await import('../src/cluster/clusterManager.ts');
  const { shardByCount } = await import('../src/cluster/shardScheduler.ts');

  const manager = new ClusterManager(ctx.db, { clusterEnabled: true, maxAttempts: 3 });
  const boot = await manager.ensureBootstrapped(ctx.workspaceId);
  assert.ok(boot.elected);

  // 再加一个节点
  const policy = await manager.policies.get(ctx.workspaceId);
  const second = await manager.nodes.register({ name: 'worker-2', resources: { cpu: 8, memoryMb: 16384 } }, { maxNodes: policy.maxNodes, allowLoopback: true });
  await manager.heartbeat.beat(second.id, { cpu: 5, memory: 10 });

  const nodes = (await manager.nodes.list()).filter((n) => n.status === 'online');
  assert.equal(nodes.length, 2);

  // 分发 4 个分片
  const res = await manager.distributor.distribute({
    workspaceId: ctx.workspaceId,
    taskId: 'goal-task-1',
    shards: shardByCount([1, 2, 3, 4], 2),
    nodes,
    maxParallel: 4,
  });
  assert.equal(res.assignments.length, 2);
  const shards = await manager.distributor.listShards('goal-task-1');
  assert.equal(shards.length, 2);

  // 让被分配节点掉线 → 改派
  const lostNodeId = shards[0]!.assignedNodeId!;
  await manager.nodes.setStatus(lostNodeId, 'offline');
  const lost = await manager.nodes.get(lostNodeId);
  const healthy = (await manager.nodes.list()).filter((n) => n.status === 'online');
  const faults = await manager.faults.handleNodeLoss([lost], healthy, 4);
  assert.equal(faults.reassigned.length, 1);
  assert.notEqual(faults.reassigned[0]!.to, lostNodeId);

  // 状态快照
  const status = await manager.status(ctx.workspaceId, 'cluster');
  assert.ok(status.nodes.length >= 2);
  assert.ok(status.shardStats.pending + status.shardStats.assigned + status.shardStats.reassigned >= 2);
  manager.stop();
  ctx.cleanup();
});

test('E2E-集群：全部节点掉线时降级单机并给出原因', async () => {
  const ctx = setup('cluster-degraded');
  const { ClusterManager } = await import('../src/cluster/clusterManager.ts');
  const manager = new ClusterManager(ctx.db, { clusterEnabled: true });
  const boot = await manager.ensureBootstrapped(ctx.workspaceId);
  await manager.nodes.setStatus(boot.nodeId, 'offline');
  const status = await manager.status(ctx.workspaceId, 'cluster');
  assert.equal(status.degraded, true);
  assert.equal(status.mode, 'single');
  assert.ok((status.degradeReason ?? '').length > 0);
  const mode = await manager.effectiveMode(ctx.workspaceId, 'cluster');
  assert.equal(mode.mode, 'degraded');
  manager.stop();
  ctx.cleanup();
});

/* ================================================================== */
/* 链路 5：多 Agent 并行编排                                           */
/* ================================================================== */

test('E2E-编排：DAG → 并行度 → 路由 → 聚合 → 成本', async () => {
  const ctx = setup('orchestrate');
  const { ParallelOrchestrator } = await import('../src/agents/parallelOrchestrator.ts');
  const { AgentPoolService } = await import('../src/agents/agentPool.ts');
  const { MODEL_PRICES } = await import('../src/agents/costController.ts');

  const orchestrator = new ParallelOrchestrator(ctx.db);
  const pools = new AgentPoolService(ctx.db);
  await pools.create({ workspaceId: ctx.workspaceId, name: 'coder', role: 'coder', minAgents: 2, maxAgents: 4 });
  await pools.create({ workspaceId: ctx.workspaceId, name: 'writer', role: 'writer', minAgents: 1, maxAgents: 2 });
  const poolList = await pools.list(ctx.workspaceId);

  const nodes = [
    { id: 't1', dependsOn: [], status: 'pending' as const, title: '写接口', priority: 10 },
    { id: 't2', dependsOn: [], status: 'pending' as const, title: '写文档', priority: 5 },
    { id: 't3', dependsOn: ['t1', 't2'], status: 'pending' as const, title: '汇总' },
  ];

  const result = await orchestrator.run({
    workspaceId: ctx.workspaceId,
    nodes,
    taskTexts: { t1: '实现 HTTP 接口', t2: '写使用文档并读取文件' },
    taskKinds: { t1: 'code', t2: 'document' },
    pools: poolList as never,
    modelCandidates: Object.entries(MODEL_PRICES).map(([model, price]) => ({
      model,
      contextWindow: model.includes('4.1') ? 1_000_000 : 128_000,
      inputPricePerM: price.in,
      outputPricePerM: price.out,
      strengths: ['general'],
      longContext: model.includes('4.1'),
    })),
    toolCandidates: [
      { name: 'fs.read', keywords: ['文件', '读取'] },
      { name: 'web.fetch', keywords: ['联网'], network: true },
    ],
    networkAllowed: false,
    configuredMaxParallel: 4,
    aggregationStrategy: 'concat',
    execute: async (t) => ({ agentId: `${t.role}-1`, role: t.role, data: { task: t.id }, summary: `完成 ${t.id}` }),
  });

  // 只有 t1/t2 就绪（t3 依赖未完成）
  assert.equal(result.dispatched.length, 2);
  assert.equal(result.completed.length, 2);
  assert.ok(result.batches.length >= 2, '应识别出两批：可并行的一批 + 依赖批');
  assert.ok(result.parallelism.limit >= 2);
  assert.ok(result.speedup.speedup > 1);

  const { RouteRecorder } = await import('../src/agents/agentRouter.ts');
  const recorder = new RouteRecorder(ctx.db);
  assert.ok((await recorder.list('t1')).length >= 3, '每个任务应有 agent/model/tool 三条路由记录');

  assert.equal(result.aggregated.length, 2);
  ctx.cleanup();
});

test('E2E-编排：预算超限时拒绝调度', async () => {
  const ctx = setup('orchestrate-budget');
  const { ParallelOrchestrator } = await import('../src/agents/parallelOrchestrator.ts');
  const { AgentPoolService } = await import('../src/agents/agentPool.ts');
  const pools = new AgentPoolService(ctx.db);
  await pools.create({ workspaceId: ctx.workspaceId, name: 'c', role: 'coder', minAgents: 1, maxAgents: 4 });
  const orchestrator = new ParallelOrchestrator(ctx.db);
  await orchestrator.recordCost({ workspaceId: ctx.workspaceId, model: 'gpt-4o', tokensIn: 10_000_000, tokensOut: 1_000_000, budget: { limitUsd: 1 } });
  const res = await orchestrator.run({
    workspaceId: ctx.workspaceId,
    nodes: [{ id: 't1', dependsOn: [], status: 'pending' }],
    pools: (await pools.list(ctx.workspaceId)) as never,
    modelCandidates: [],
    toolCandidates: [],
    configuredMaxParallel: 4,
    budget: { limitUsd: 1 },
  });
  assert.equal(res.cost.state, 'exceeded');
  assert.equal(res.dispatched.length, 0);
  ctx.cleanup();
});

/* ================================================================== */
/* 链路 6：企业安全                                                    */
/* ================================================================== */

test('E2E-企业安全：RBAC → 审计 → 脱敏 → 保留 → 合规包', async () => {
  const ctx = setup('enterprise');
  const { RbacService } = await import('../src/enterprise/rbac.ts');
  const { DataMaskService } = await import('../src/enterprise/dataMask.ts');
  const { AuditQueryService } = await import('../src/enterprise/auditLog.ts');
  const { RetentionService } = await import('../src/enterprise/retentionPolicy.ts');
  const { ComplianceExportService } = await import('../src/enterprise/complianceExport.ts');
  const { auditLogs } = await import('../src/db/schema/index.ts');

  // 1) RBAC
  const rbac = new RbacService(ctx.db);
  await rbac.ensureBuiltinRoles(ctx.workspaceId);
  await rbac.assign({ workspaceId: ctx.workspaceId, userId: 'analyst', roleNameOrId: 'viewer' });
  await assert.rejects(() => rbac.enforce({ workspaceId: ctx.workspaceId, userId: 'analyst', permission: 'rbac:manage' }), /缺少权限/);

  // 2) 审计数据
  for (let i = 0; i < 6; i += 1) {
    await ctx.db.insert(auditLogs).values({
      id: `adt${i}`,
      workspaceId: ctx.workspaceId,
      actor: 'user',
      action: 'plugin.invoke',
      targetType: 'plugin',
      targetId: `p${i}`,
      dangerous: i === 0,
      confirmedByUser: true,
      detail: { token: `secret-${i}`, nested: { apiKey: `k-${i}` } } as never,
      createdAt: new Date(Date.now() - i * 3600_000).toISOString(),
    } as never);
  }

  const masker = new DataMaskService(ctx.db);
  const audit = new AuditQueryService(ctx.db, masker);
  const logs = await audit.list({ workspaceId: ctx.workspaceId, limit: 100 });
  assert.equal(JSON.stringify(logs).includes('secret-'), false, '嵌套字段也必须脱敏');

  // 3) 自定义脱敏规则
  await masker.upsertRule({ workspaceId: ctx.workspaceId, field: 'actor', strategy: 'full' });
  const afterRule = await audit.list({ workspaceId: ctx.workspaceId, limit: 5 });
  assert.ok(afterRule.every((r) => r.actor === '****'));

  // 4) 保留策略：先预演
  const retention = new RetentionService(ctx.db);
  await retention.upsert({ workspaceId: ctx.workspaceId, dataType: 'audit_logs', retentionDays: 2 });
  const dry = await retention.apply({ workspaceId: ctx.workspaceId }, { audit_logs: async () => ({ scanned: 3, affected: 3 }) });
  assert.equal(dry[0]!.dryRun, true);
  assert.equal((await audit.list({ workspaceId: ctx.workspaceId, limit: 100 })).length, 6, '预演不得删除数据');

  // 5) 合规包
  const svc = new ComplianceExportService(ctx.db, audit, ctx.tempDir);
  const pkg = await svc.buildPackage({
    workspaceId: ctx.workspaceId,
    from: new Date(Date.now() - 24 * 3600_000).toISOString(),
    to: new Date().toISOString(),
    maskRules: (await masker.listRules(ctx.workspaceId)).map((r) => ({ field: r.field, strategy: r.strategy, target: r.target })),
    retentionPolicies: (await retention.list(ctx.workspaceId)).map((p) => ({ dataType: p.dataType, retentionDays: p.retentionDays, action: p.action, enabled: p.enabled })),
  });
  assert.ok(pkg.audit.length >= 1);
  assert.equal(JSON.stringify(pkg).includes('secret-'), false);
  assert.equal(pkg.maskRules.length, 1);
  assert.equal(pkg.retentionPolicies.length, 1);

  // 6) 导出 + 下载
  const exported = await svc.exportAudit({ workspaceId: ctx.workspaceId, from: new Date(Date.now() - 24 * 3600_000).toISOString(), to: new Date().toISOString() });
  const file = await svc.readExport(ctx.workspaceId, exported.exportId);
  assert.equal(file.rowCount, pkg.audit.length);
  assert.equal(file.content.toString('utf8').includes('secret-'), false);
  ctx.cleanup();
});

test('E2E-全链路无外部凭据也能跑通（不静默伪造结果）', async () => {
  const ctx = setup('no-creds');
  const { PluginInstaller } = await import('../src/plugins/pluginInstaller.ts');
  const { PluginRuntime } = await import('../src/plugins/pluginRuntime.ts');
  const { CredentialManager } = await import('../src/paidData/credentialManager.ts');
  const { PaidDataQueryRunner } = await import('../src/paidData/queryRunner.ts');
  const { PromptServiceV4 } = await import('../src/prompt/promptServiceV4.ts');
  const { ClusterManager } = await import('../src/cluster/clusterManager.ts');

  // 插件：未接运行时宿主 → 显式 degraded
  const installer = new PluginInstaller(ctx.db);
  const runtime = new PluginRuntime(ctx.db);
  const installed = await installer.install(ctx.workspaceId, 'mcp-filesystem');
  await installer.grant({ workspaceId: ctx.workspaceId, installationId: installed.installationId, scopes: ['fs:read'] });
  const invoked = await runtime.invoke({ workspaceId: ctx.workspaceId, installationId: installed.installationId, tool: 'read_file', args: { path: 'a.txt' } });
  assert.equal(invoked.degraded, true, '未接宿主必须显式降级');

  // 付费数据：无凭据 → blocked
  const runner = new PaidDataQueryRunner(ctx.db);
  const blocked = await runner.run({ workspaceId: ctx.workspaceId, providerId: 'wind', action: 'wds.query', params: { dataset: 'x' }, credentials: {} });
  assert.equal(blocked.status, 'blocked');

  // 提示词：离线可用
  const prompts = new PromptServiceV4(ctx.db);
  const gen = await prompts.generate({ workspaceId: ctx.workspaceId, goal: '写一份部署方案' });
  assert.equal(gen.degraded, true);
  assert.ok(gen.rendered.length > 50);

  // 集群：可引导并报告单机
  const manager = new ClusterManager(ctx.db, { clusterEnabled: true });
  const boot = await manager.ensureBootstrapped(ctx.workspaceId);
  assert.ok(boot.nodeId);
  manager.stop();

  // 凭据管理器：无凭据时返回空对象而不是报错
  const creds = new CredentialManager(ctx.db);
  assert.deepEqual(await creds.resolve(ctx.workspaceId, 'imf'), {});
  ctx.cleanup();
});
