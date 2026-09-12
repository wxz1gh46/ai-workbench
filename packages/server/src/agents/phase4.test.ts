import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentPoolInfo } from '@ai/shared';
import { closeDb, createDb } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { setSecretKeyForTest } from '../security/secrets.ts';
import { AgentPoolService } from './agentPool.ts';
import { resolveBlockedTasks, resolveReadyTasks, topologicalLayers, validateDag, type DagNode } from './taskDag.ts';
import { decideParallelism, estimateSpeedup } from './parallelismPolicy.ts';
import { RouteRecorder, routeAgent, routeModel, routeTools } from './agentRouter.ts';
import { AggregationStore, aggregate, detectConflicts, normalizeValue, type AgentOutput } from './resultAggregator.ts';
import { resolveAll, resolveConflict } from './conflictResolver.ts';
import { CostController, budgetStateOf, estimateCost, MODEL_PRICES } from './costController.ts';
import { ParallelOrchestrator } from './parallelOrchestrator.ts';

function setup(name: string) {
  closeDb();
  const dir = mkdtempSync(path.join(tmpdir(), `p4ag-${name}-`));
  setSecretKeyForTest('phase4-agents-test-key-0123456789');
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

/* ------------------------------ DAG ------------------------------ */

const node = (id: string, dependsOn: string[] = [], status: DagNode['status'] = 'pending', priority = 0): DagNode => ({ id, dependsOn, status, priority, title: id });

test('DAG 校验：检测环并给出版路径', () => {
  const res = validateDag([node('a', ['b']), node('b', ['a'])]);
  assert.equal(res.ok, false);
  assert.ok(res.cycle && res.cycle.length >= 3, `应给出环路径，实际 ${JSON.stringify(res.cycle)}`);
});

test('DAG 校验：检测缺失依赖与自依赖', () => {
  const missing = validateDag([node('a', ['ghost'])]);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, [{ id: 'a', dependsOn: 'ghost' }]);
  const self = validateDag([node('a', ['a'])]);
  assert.equal(self.ok, false);
  assert.deepEqual(self.selfLoops, ['a']);
});

test('拓扑分层：同层任务可并行', () => {
  const nodes = [node('a'), node('b'), node('c', ['a']), node('d', ['a', 'b']), node('e', ['c', 'd'])];
  const { layers, validation } = topologicalLayers(nodes);
  assert.equal(validation.ok, true);
  assert.deepEqual(layers[0]!.sort(), ['a', 'b']);
  assert.deepEqual(layers[1], ['c', 'd'], 'c 与 d 仅依赖第一层，应同层并行');
  assert.deepEqual(layers[2], ['e']);
});

test('有环时拓扑分层返回空并带出校验结果', () => {
  const { layers, validation } = topologicalLayers([node('a', ['b']), node('b', ['a'])]);
  assert.equal(layers.length, 0);
  assert.equal(validation.ok, false);
});

test('就绪任务：依赖全部成功才就绪', () => {
  const nodes = [node('a', [], 'succeeded'), node('b', ['a']), node('c', ['a', 'd']), node('d', [], 'running')];
  assert.deepEqual(resolveReadyTasks(nodes), ['b']);
});

test('阻塞任务：依赖失败时明确报出原因', () => {
  const nodes = [node('a', [], 'failed'), node('b', ['a'])];
  const blocked = resolveBlockedTasks(nodes);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.id, 'b');
  assert.match(blocked[0]!.reason, /依赖任务未成功/);
});

test('拓扑分层顺序确定（同优先级按 id）', () => {
  const layers1 = topologicalLayers([node('b'), node('a'), node('c')]).layers;
  const layers2 = topologicalLayers([node('c'), node('a'), node('b')]).layers;
  assert.deepEqual(layers1, layers2);
});

/* ------------------------------ 并行度 ------------------------------ */

test('并行度取各约束最小值并可解释', () => {
  const d = decideParallelism({ configuredMax: 8, clusterMax: 6, poolHeadroom: { a: 2, b: 2 }, readyTasks: 10, cpuCores: 32 });
  assert.equal(d.limit, 4);
  assert.match(d.reason, /Agent 池容量/);
  assert.ok(d.factors.length >= 4);
});

test('预算超限时并行度为 0 并说明原因', () => {
  const d = decideParallelism({ configuredMax: 8, poolHeadroom: { a: 8 }, readyTasks: 10, budget: { ratio: 1.2, state: 'exceeded' } });
  assert.equal(d.limit, 0);
  assert.match(d.reason, /预算已超限/);
});

test('预算预警时并行度自动下调', () => {
  const d = decideParallelism({ configuredMax: 8, poolHeadroom: { a: 8 }, readyTasks: 10, budget: { ratio: 0.85, state: 'warn' } });
  assert.equal(d.limit, 4);
  assert.match(d.reason, /预算已用 85%/);
});

test('CPU 核数限制并行度（不打满开发机）', () => {
  const d = decideParallelism({ configuredMax: 16, poolHeadroom: { a: 16 }, readyTasks: 16, cpuCores: 4, coresPerAgent: 2 });
  assert.equal(d.limit, 2);
  assert.match(d.reason, /CPU 核数/);
});

test('就绪任务少于并行上限时按任务数执行', () => {
  const d = decideParallelism({ configuredMax: 8, poolHeadroom: { a: 8 }, readyTasks: 2 });
  assert.equal(d.limit, 2);
  assert.match(d.reason, /就绪任务数/);
});

test('加速比估计：任务数越多收益越大但有上界', () => {
  const s = estimateSpeedup({ taskCount: 12, limit: 4, avgTaskMs: 1000 });
  assert.equal(s.batches, 3);
  assert.ok(s.speedup > 1);
  const s1 = estimateSpeedup({ taskCount: 12, limit: 1, avgTaskMs: 1000 });
  assert.ok(s1.speedup <= 1.01);
});

/* ------------------------------ 路由 ------------------------------ */

test('模型路由：超上下文窗口的候选被排除并给出原因', () => {
  const res = routeModel({
    taskKind: 'code',
    estimatedInputTokens: 200_000,
    candidates: [
      { model: 'small', contextWindow: 1000, inputPricePerM: 0.1, outputPricePerM: 0.2, strengths: [] },
      { model: 'big', contextWindow: 1_000_000, inputPricePerM: 2, outputPricePerM: 8, strengths: ['code'], longContext: true },
    ],
  });
  assert.equal(res.model, 'big');
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0]!.reason, /上下文窗口/);
});

test('模型路由：成本超上限的候选被排除', () => {
  const res = routeModel({
    taskKind: 'general',
    estimatedInputTokens: 1_000_000,
    maxCostUsd: 0.001,
    candidates: [{ model: 'expensive', contextWindow: 2_000_000, inputPricePerM: 100, outputPricePerM: 100, strengths: [] }],
  });
  assert.equal(res.model, '');
  assert.match(res.reason, /没有满足/);
});

test('模型路由：同样满足要求时选更便宜的', () => {
  const res = routeModel({
    taskKind: 'general',
    estimatedInputTokens: 10_000,
    candidates: [
      { model: 'pricey', contextWindow: 128_000, inputPricePerM: 10, outputPricePerM: 30, strengths: [] },
      { model: 'cheap', contextWindow: 128_000, inputPricePerM: 0.1, outputPricePerM: 0.2, strengths: [] },
    ],
  });
  assert.equal(res.model, 'cheap');
});

test('工具路由：未允许联网时排除网络工具并说明', () => {
  const res = routeTools({
    taskText: '联网搜一下最新政策',
    candidates: [
      { name: 'web.fetch', keywords: ['联网', '搜'], network: true },
      { name: 'fs.read', keywords: ['文件'] },
    ],
    networkAllowed: false,
  });
  assert.deepEqual(res.tools, []);
  assert.equal(res.excluded[0]!.name, 'web.fetch');
  assert.match(res.excluded[0]!.reason, /未允许联网/);
});

test('工具路由：按关键词命中排序并限制数量', () => {
  const res = routeTools({
    taskText: '读取文件并查询数据库',
    candidates: [
      { name: 'fs.read', keywords: ['文件'] },
      { name: 'db.query', keywords: ['数据库'] },
      { name: 'unrelated', keywords: ['天气'] },
    ],
    networkAllowed: false,
    maxTools: 1,
  });
  assert.equal(res.tools.length, 1);
  assert.ok(res.scores.every((s) => s.score > 0));
});

test('Agent 路由：角色匹配优先，满负载的池被跳过', () => {
  const pools = [
    { id: 'p1', workspaceId: 'w', name: 'coder', role: 'coder', minAgents: 1, maxAgents: 4, activeAgents: 2, model: null, tools: [], status: 'active', createdAt: '', updatedAt: '' },
    { id: 'p2', workspaceId: 'w', name: 'writer', role: 'writer', minAgents: 1, maxAgents: 4, activeAgents: 4, model: null, tools: [], status: 'active', createdAt: '', updatedAt: '' },
  ] as AgentPoolInfo[];
  const res = routeAgent({ taskKind: 'code', pools, busyByRole: {} });
  assert.equal(res.role, 'coder');

  // coder 池忙满（activeAgents=2，在忙 2）→ 只剩 writer 可用
  const full = routeAgent({ taskKind: 'code', pools, busyByRole: { coder: 2 } });
  assert.equal(full.role, 'writer', 'coder 池无容量时应退到其他有容量的角色');
  const none = routeAgent({ taskKind: 'code', pools, busyByRole: { coder: 2, writer: 4 } });
  assert.equal(none.agentId, null);
  assert.match(none.reason, /没有可用容量/);
});

test('Agent 路由：显式指定角色优先', () => {
  const pools = [
    { id: 'p1', workspaceId: 'w', name: 'coder', role: 'coder', minAgents: 1, maxAgents: 4, activeAgents: 2, model: null, tools: [], status: 'active', createdAt: '', updatedAt: '' },
    { id: 'p2', workspaceId: 'w', name: 'reviewer', role: 'reviewer', minAgents: 1, maxAgents: 4, activeAgents: 2, model: null, tools: [], status: 'active', createdAt: '', updatedAt: '' },
  ] as AgentPoolInfo[];
  const res = routeAgent({ taskKind: 'code', requiredRole: 'reviewer', pools, busyByRole: {} });
  assert.equal(res.role, 'reviewer');
  assert.match(res.reason, /指定角色/);
});

test('路由记录落库并可按任务查询', async () => {
  const ctx = setup('routes');
  const recorder = new RouteRecorder(ctx.db);
  await recorder.record({ taskId: 't1', agentId: 'coder', reason: '角色匹配', score: 60, kind: 'agent' });
  await recorder.record({ taskId: 't1', agentId: 'coder', reason: '成本最低', score: 50, kind: 'model' });
  await recorder.record({ taskId: 't2', agentId: 'writer', reason: 'x', score: 1, kind: 'agent' });
  assert.equal((await recorder.list('t1')).length, 2);
  assert.equal((await recorder.listRecent(10)).length, 3);
  ctx.cleanup();
});

/* ------------------------------ 聚合与冲突 ------------------------------ */

test('多数一致时采纳多数值并记录分歧', () => {
  const outputs: AgentOutput[] = [
    { agentId: 'a1', role: 'reviewer', data: { level: 'high' } },
    { agentId: 'a2', role: 'reviewer', data: { level: 'high' } },
    { agentId: 'a3', role: 'reviewer', data: { level: 'low' } },
  ];
  const res = aggregate({ taskId: 't', strategy: 'majority', outputs });
  assert.equal(res.result.level, 'high');
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0]!.resolvedBy, 'majority');
  assert.equal(res.needsReview, false);
});

test('平票时不擅自裁决，标记待人工确认', () => {
  const outputs: AgentOutput[] = [
    { agentId: 'a1', data: { level: 'high' } },
    { agentId: 'a2', data: { level: 'low' } },
  ];
  const res = aggregate({ taskId: 't', strategy: 'majority', outputs });
  assert.equal(res.needsReview, true);
  assert.equal(res.conflicts[0]!.resolvedBy, 'unresolved');
  assert.ok(Array.isArray(res.result.level), '未决冲突应保留全部取值');
});

test('取值归一化避免误判冲突', () => {
  assert.equal(normalizeValue(1), normalizeValue(1.0));
  assert.equal(normalizeValue(' a  b '), 'a b');
  const inputs: AgentOutput[] = [
    { agentId: 'a1', data: { score: 1 } },
    { agentId: 'a2', data: { score: 1.0 } },
  ];
  assert.equal(detectConflicts(inputs).length, 0);
});

test('priority 策略按角色优先级裁决且不需要人工介入', () => {
  const outputs: AgentOutput[] = [
    { agentId: 'a1', role: 'writer', data: { level: 'low' } },
    { agentId: 'a2', role: 'coordinator', data: { level: 'high' } },
  ];
  const res = aggregate({ taskId: 't', strategy: 'priority', outputs, rolePriority: ['coordinator', 'writer'] });
  assert.equal(res.result.level, 'high');
  assert.equal(res.needsReview, false);
  assert.equal(res.conflicts[0]!.resolvedBy, 'priority');
});

test('concat 策略拼接各 Agent 输出', () => {
  const outputs: AgentOutput[] = [
    { agentId: 'a1', role: '前端', data: {}, summary: '完成了登录页' },
    { agentId: 'a2', role: '后端', data: {}, summary: '完成了鉴权接口' },
  ];
  const res = aggregate({ taskId: 't', strategy: 'concat', outputs });
  assert.match(String(res.result.merged), /登录页/);
  assert.match(String(res.result.merged), /鉴权接口/);
});

test('manual 策略只列差异不裁决', () => {
  const outputs: AgentOutput[] = [
    { agentId: 'a1', data: { x: 1 } },
    { agentId: 'a2', data: { x: 2 } },
  ];
  const res = aggregate({ taskId: 't', strategy: 'manual', outputs });
  assert.equal(res.needsReview, true);
  assert.equal(res.conflicts[0]!.resolution, '待人工确认');
});

test('空输出聚合不报错', () => {
  const res = aggregate({ taskId: 't', strategy: 'majority', outputs: [] });
  assert.deepEqual(res.result, {});
  assert.equal(res.needsReview, false);
});

test('聚合结果落库并支持人工裁决', async () => {
  const ctx = setup('aggregate');
  const store = new AggregationStore(ctx.db);
  const saved = await store.save({
    taskId: 't1',
    strategy: 'majority',
    outputs: [
      { agentId: 'a1', data: { level: 'high' } },
      { agentId: 'a2', data: { level: 'low' } },
    ],
  });
  assert.equal(saved.needsReview, true);

  const resolved = await store.resolve({ workspaceId: ctx.workspaceId, id: saved.id, decisions: [{ key: 'level', agentId: 'a2' }] });
  assert.equal(resolved.needsReview, false);
  const after = (await store.get('t1'))[0]!;
  assert.equal((after.result as Record<string, unknown>).level, 'low');
  ctx.cleanup();
});

test('人工裁决缺失决策时保持待确认', async () => {
  const ctx = setup('aggregate-pending');
  const store = new AggregationStore(ctx.db);
  const saved = await store.save({ taskId: 't2', strategy: 'majority', outputs: [{ agentId: 'a1', data: { x: 1 } }, { agentId: 'a2', data: { x: 2 } }] });
  const res = await store.resolve({ workspaceId: ctx.workspaceId, id: saved.id, decisions: [] });
  assert.equal(res.needsReview, true);
  ctx.cleanup();
});

test('冲突裁决：投票未达阈值时判为未解决', () => {
  const res = resolveConflict({
    conflict: { key: 'x', values: [{ agentId: 'a', value: 'v1' }, { agentId: 'b', value: 'v2' }], resolution: '', resolvedBy: 'unresolved' },
    method: 'vote',
  });
  assert.equal(res.resolved, false);
  assert.match(res.reason, /未达阈值/);
});

test('冲突裁决：唯一取值直接通过', () => {
  const res = resolveConflict({ conflict: { key: 'x', values: [{ agentId: 'a', value: 'v' }], resolution: '', resolvedBy: 'unresolved' }, method: 'human' });
  assert.equal(res.resolved, true);
  assert.equal(res.value, 'v');
});

test('冲突裁决：人类方法永不自动解决', () => {
  const res = resolveAll({
    conflicts: [{ key: 'x', values: [{ agentId: 'a', value: 'v1' }, { agentId: 'b', value: 'v2' }], resolution: '', resolvedBy: 'unresolved' }],
    method: 'human',
  });
  assert.equal(res.resolved.length, 0);
  assert.equal(res.pending.length, 1);
});

/* ------------------------------ 成本 ------------------------------ */

test('成本计算使用价格表，未知模型成本为 0', () => {
  assert.ok(estimateCost('gpt-4o', 1_000_000, 0) > 0);
  assert.equal(estimateCost('unknown-model', 1_000_000, 1_000_000), 0);
  assert.equal(estimateCost('gpt-4o-mini', 0, 0), 0);
});

test('预算状态：容差避免边界误报', () => {
  assert.equal(budgetStateOf(0.5, { limitUsd: 1 }).state, 'none');
  assert.equal(budgetStateOf(0.85, { limitUsd: 1 }).state, 'warn');
  assert.equal(budgetStateOf(1.0, { limitUsd: 1 }).state, 'warn', '刚好等于上限不应判超限');
  assert.equal(budgetStateOf(1.0000001, { limitUsd: 1 }).state, 'exceeded');
  assert.equal(budgetStateOf(100, { limitUsd: 0 }).state, 'none', '未设预算时不限');
});

test('成本记录与汇总', async () => {
  const ctx = setup('cost');
  const costs = new CostController(ctx.db);
  await costs.record({ workspaceId: ctx.workspaceId, goalId: 'g1', agentId: 'a1', model: 'gpt-4o-mini', tokensIn: 100_000, tokensOut: 10_000 }, { limitUsd: 1 });
  await costs.record({ workspaceId: ctx.workspaceId, goalId: 'g1', agentId: 'a2', model: 'gpt-4o', tokensIn: 100_000, tokensOut: 10_000 }, { limitUsd: 1 });
  const summary = await costs.summary(ctx.workspaceId, { limitUsd: 10 });
  assert.equal(summary.byModel.length, 2);
  assert.equal(summary.byAgent.length, 2);
  assert.ok(summary.totalCost > 0);
  assert.equal(summary.budget.state, 'none');
  const goal = await costs.byGoal(ctx.workspaceId, 'g1');
  assert.equal(goal.records, 2);
  ctx.cleanup();
});

test('预算预警触发 warn 状态', async () => {
  const ctx = setup('cost-warn');
  const costs = new CostController(ctx.db);
  const res = await costs.record({ workspaceId: ctx.workspaceId, model: 'gpt-4o', tokensIn: 1_000_000, tokensOut: 0 }, { limitUsd: 3 });
  assert.equal(res.state, 'warn');
  ctx.cleanup();
});

test('价格表覆盖常用模型', () => {
  for (const m of ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'claude-3-5-sonnet', 'deepseek-chat']) {
    assert.ok(MODEL_PRICES[m], `缺少价格：${m}`);
  }
});

/* ------------------------------ Agent 池 ------------------------------ */

test('Agent 池创建校验 min/max 区间', async () => {
  const ctx = setup('pool');
  const pools = new AgentPoolService(ctx.db);
  await assert.rejects(() => pools.create({ workspaceId: ctx.workspaceId, name: 'x', role: 'coder', minAgents: 5, maxAgents: 2 }), /不能大于/);
  await assert.rejects(() => pools.create({ workspaceId: ctx.workspaceId, name: 'x', role: 'coder', minAgents: -1 }), /非负整数/);
  const created = await pools.create({ workspaceId: ctx.workspaceId, name: 'coder 池', role: 'coder', minAgents: 1, maxAgents: 4 });
  assert.equal(created.activeAgents, 1);
  await assert.rejects(() => pools.create({ workspaceId: ctx.workspaceId, name: 'again', role: 'coder' }), /已有 Agent 池/);
  ctx.cleanup();
});

test('Agent 池扩缩容遵守 min/max 边界', async () => {
  const ctx = setup('pool-scale');
  const pools = new AgentPoolService(ctx.db);
  await pools.create({ workspaceId: ctx.workspaceId, name: 'c', role: 'coder', minAgents: 1, maxAgents: 4 });
  await assert.rejects(() => pools.scale({ workspaceId: ctx.workspaceId, idOrRole: 'coder', target: 0 }), /小于池的最小实例数/);
  await assert.rejects(() => pools.scale({ workspaceId: ctx.workspaceId, idOrRole: 'coder', target: 99 }), /必须是 0~64 的整数/);
  const up = await pools.scale({ workspaceId: ctx.workspaceId, idOrRole: 'coder', target: 3 });
  assert.equal(up.pool.activeAgents, 3);
  assert.equal(up.changed, 2);
  ctx.cleanup();
});

test('缩容时拒绝驱逐正在执行任务的 Agent', async () => {
  const ctx = setup('pool-busy');
  const pools = new AgentPoolService(ctx.db);
  await pools.create({ workspaceId: ctx.workspaceId, name: 'c', role: 'coder', minAgents: 1, maxAgents: 4 });
  await pools.scale({ workspaceId: ctx.workspaceId, idOrRole: 'coder', target: 3 });
  const { agents } = await import('../db/schema/index.ts');

  // agents 表对 (workspace_id, role) 有唯一约束：用「同角色多行」表达忙碌不可行，
  // 改为验证核心不变量 —— 缩容后的剩余实例数不得少于正在执行任务的 Agent 数。
  const svc = pools as unknown as { busyAgents: (w: string, r: string) => Promise<unknown[]> };
  const original = svc.busyAgents.bind(pools);
  svc.busyAgents = async () => [{ id: 'ag0' }, { id: 'ag1' }, { id: 'ag2' }];
  await assert.rejects(() => pools.scale({ workspaceId: ctx.workspaceId, idOrRole: 'coder', target: 1 }), /正在执行任务/);
  svc.busyAgents = original;
  void agents;
  ctx.cleanup();
});

test('ensurePool 对未知角色自动建池', async () => {
  const ctx = setup('pool-ensure');
  const pools = new AgentPoolService(ctx.db);
  const p = await pools.ensurePool(ctx.workspaceId, 'researcher', { max: 2 });
  assert.equal(p.role, 'researcher');
  const again = await pools.ensurePool(ctx.workspaceId, 'researcher');
  assert.equal(again.id, p.id, '重复调用应复用已有池');
  ctx.cleanup();
});

/* ------------------------------ 编排器 ------------------------------ */

const poolFixtures = (): AgentPoolInfo[] =>
  [
    { id: 'p1', workspaceId: 'ws1', name: 'coordinator', role: 'coordinator', minAgents: 1, maxAgents: 2, activeAgents: 2, model: null, tools: [], status: 'active', createdAt: '', updatedAt: '' },
    { id: 'p2', workspaceId: 'ws1', name: 'coder', role: 'coder', minAgents: 1, maxAgents: 4, activeAgents: 4, model: null, tools: [], status: 'active', createdAt: '', updatedAt: '' },
    { id: 'p3', workspaceId: 'ws1', name: 'writer', role: 'writer', minAgents: 1, maxAgents: 2, activeAgents: 2, model: null, tools: [], status: 'active', createdAt: '', updatedAt: '' },
  ] as AgentPoolInfo[];

test('编排规划不实际执行，且不假装完成', async () => {
  const ctx = setup('orchestrate-plan');
  const orch = new ParallelOrchestrator(ctx.db);
  const res = await orch.plan({
    workspaceId: ctx.workspaceId,
    nodes: [node('t1'), node('t2')],
    pools: poolFixtures(),
    modelCandidates: [{ model: 'gpt-4o-mini', contextWindow: 128_000, inputPricePerM: 0.15, outputPricePerM: 0.6, strengths: ['general'] }],
    toolCandidates: [],
    configuredMaxParallel: 4,
  });
  assert.equal(res.dispatched.length, 2);
  assert.equal(res.completed.length, 0);
  assert.ok(res.notes.some((n) => /未注入执行器/.test(n)));
  ctx.cleanup();
});

test('编排拒绝有环 DAG', async () => {
  const ctx = setup('orchestrate-cycle');
  const orch = new ParallelOrchestrator(ctx.db);
  await assert.rejects(
    () => orch.run({ workspaceId: ctx.workspaceId, nodes: [node('a', ['b']), node('b', ['a'])], pools: [], modelCandidates: [], toolCandidates: [], configuredMaxParallel: 4 }),
    /DAG 校验失败/,
  );
  ctx.cleanup();
});

test('编排：预算超限时不调度任何任务', async () => {
  const ctx = setup('orchestrate-budget');
  const orch = new ParallelOrchestrator(ctx.db);
  await orch.recordCost({ workspaceId: ctx.workspaceId, model: 'gpt-4o', tokensIn: 5_000_000, tokensOut: 0, budget: { limitUsd: 1 } });
  const res = await orch.run({
    workspaceId: ctx.workspaceId,
    nodes: [node('t1'), node('t2')],
    pools: poolFixtures(),
    modelCandidates: [{ model: 'gpt-4o-mini', contextWindow: 128_000, inputPricePerM: 0.15, outputPricePerM: 0.6, strengths: [] }],
    toolCandidates: [],
    configuredMaxParallel: 4,
    budget: { limitUsd: 1 },
  });
  assert.equal(res.dispatched.length, 0);
  assert.equal(res.cost.state, 'exceeded');
  assert.ok(res.waiting.length >= 1);
  ctx.cleanup();
});

test('编排：执行失败的任务被单独记录，不影响其他任务', async () => {
  const ctx = setup('orchestrate-fail');
  const orch = new ParallelOrchestrator(ctx.db);
  const res = await orch.run({
    workspaceId: ctx.workspaceId,
    nodes: [node('t1'), node('t2')],
    pools: poolFixtures(),
    modelCandidates: [{ model: 'gpt-4o-mini', contextWindow: 128_000, inputPricePerM: 0.15, outputPricePerM: 0.6, strengths: [] }],
    toolCandidates: [],
    configuredMaxParallel: 4,
    execute: async (t) => {
      if (t.id === 't1') throw new Error('模拟执行失败');
      return { agentId: 'a', data: { ok: true } };
    },
  });
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0]!.taskId, 't1');
  assert.equal(res.completed.length, 1);
  ctx.cleanup();
});

test('编排：多 Agent 同任务输出被聚合', async () => {
  const ctx = setup('orchestrate-aggregate');
  const orch = new ParallelOrchestrator(ctx.db);
  let call = 0;
  const res = await orch.run({
    workspaceId: ctx.workspaceId,
    nodes: [node('t1')],
    pools: poolFixtures(),
    modelCandidates: [{ model: 'gpt-4o-mini', contextWindow: 128_000, inputPricePerM: 0.15, outputPricePerM: 0.6, strengths: [] }],
    toolCandidates: [],
    configuredMaxParallel: 4,
    aggregationStrategy: 'concat',
    execute: async () => {
      call += 1;
      return { agentId: `a${call}`, data: { idx: call }, summary: `输出 ${call}` };
    },
  });
  assert.equal(res.completed.length, 1);
  ctx.cleanup();
});

test('编排：并行上限受 Agent 池容量约束', async () => {
  const ctx = setup('orchestrate-limit');
  const orch = new ParallelOrchestrator(ctx.db);
  const res = await orch.plan({
    workspaceId: ctx.workspaceId,
    nodes: Array.from({ length: 4 }, (_, i) => node(`t${i}`)),
    pools: [{ id: 'p', workspaceId: 'ws1', name: 'o', role: 'operator', minAgents: 1, maxAgents: 2, activeAgents: 2, model: null, tools: [], status: 'active', createdAt: '', updatedAt: '' }] as AgentPoolInfo[],
    modelCandidates: [{ model: 'gpt-4o-mini', contextWindow: 128_000, inputPricePerM: 0.15, outputPricePerM: 0.6, strengths: [] }],
    toolCandidates: [],
    configuredMaxParallel: 8,
  });
  assert.equal(res.parallelism.limit, 2);
  assert.equal(res.dispatched.length, 2);
  assert.equal(res.waiting.length, 2);
  ctx.cleanup();
});
