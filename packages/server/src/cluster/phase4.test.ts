import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDb, createDb } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { setSecretKeyForTest } from '../security/secrets.ts';
import { NodeRegistry, DEFAULT_RESOURCES, isPrivateClusterHost } from './nodeRegistry.ts';
import { HeartbeatManager } from './heartbeat.ts';
import { ElectionService, rankCandidates } from './election.ts';
import { ClusterPolicyService, DEFAULT_POLICY, validatePolicy } from './clusterPolicy.ts';
import { shardAuto, shardByCount, shardByWeight, reshuffle, type ShardState } from './shardScheduler.ts';
import { TaskDistributor } from './taskDistributor.ts';
import { FaultTolerance } from './faultTolerance.ts';
import { decideFallback } from './clusterFallback.ts';
import { ClusterManager } from './clusterManager.ts';

function setup(name: string) {
  closeDb();
  const dir = mkdtempSync(path.join(tmpdir(), `p4cl-${name}-`));
  setSecretKeyForTest('phase4-cluster-test-key-0123456789');
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

/* ------------------------------ 分片 ------------------------------ */

test('按数量分片：均匀且不产生空片', () => {
  const shards = shardByCount([1, 2, 3, 4, 5, 6, 7], 3);
  assert.equal(shards.length, 3);
  assert.deepEqual(shards.map((s) => s.items.length), [3, 2, 2]);
  assert.equal(shards.reduce((s, x) => s + x.items.length, 0), 7);
});

test('分片数超过元素数时自动收敛', () => {
  const shards = shardByCount(['a', 'b'], 10);
  assert.equal(shards.length, 2);
  assert.ok(shards.every((s) => s.total === 2));
});

test('按权重分片：大项单独成片，避免长尾', () => {
  const items = [{ w: 10 }, { w: 1 }, { w: 1 }, { w: 1 }, { w: 1 }];
  const shards = shardByWeight(items, 2, (x) => x.w);
  const weights = shards.map((s) => s.weight).sort((a, b) => b - a);
  assert.equal(weights.length, 2);
  // LPT 贪心：最大的 10 独占一片，其余 4 个小的进另一片（差值 6 是此分布下的理论最优之一）
  assert.deepEqual(weights, [10, 4]);
  assert.equal(shards.reduce((s, x) => s + x.items.length, 0), 5);

  // 更接近均匀的分布下，两片权重应基本一致
  const evens = shardByWeight([{ w: 3 }, { w: 3 }, { w: 2 }, { w: 2 }], 2, (x) => x.w);
  const ew = evens.map((s) => s.weight).sort((a, b) => b - a);
  assert.equal(ew[0], 5);
  assert.equal(ew[1], 5);
});

test('auto 分片：权重分布不均时走权重策略', () => {
  const uniform = shardAuto(Array.from({ length: 10 }, (_, i) => i), 2, () => 1);
  assert.deepEqual(uniform.map((s) => s.items.length), [5, 5]);
  const skewed = shardAuto([{ w: 100 }, { w: 1 }, { w: 1 }], 2, (x) => x.w);
  assert.equal(skewed.length, 2);
});

test('重新分片不重复执行已完成分片', () => {
  const states: ShardState<number>[] = [
    { index: 0, items: [1], status: 'succeeded' },
    { index: 1, items: [2, 3], status: 'failed' },
    { index: 2, items: [4], status: 'running' },
  ];
  const reshuffled = reshuffle(states, [1]);
  assert.equal(reshuffled.length, 1);
  assert.deepEqual(reshuffled[0]!.items, [2, 3]);
  assert.equal(reshuffled[0]!.index, 1, 'index 应从已完成数量之后开始，避免与已完成分片冲突');
});

/* ------------------------------ 节点注册 ------------------------------ */

test('节点默认 offline，心跳后才上线', async () => {
  const ctx = setup('node-status');
  const registry = new NodeRegistry(ctx.db);
  const node = await registry.register({ name: 'w1' }, { maxNodes: 8 });
  assert.equal(node.status, 'offline');
  assert.deepEqual(node.resources, DEFAULT_RESOURCES);
  const beat = await registry.heartbeat(node.id, { cpu: 30, memory: 40 });
  assert.equal(beat.status, 'online');
  assert.equal(beat.heartbeatMiss, 0);
  const health = await registry.health(node.id);
  assert.equal(health[0]!.cpu, 30);
  ctx.cleanup();
});

test('节点数受策略 maxNodes 限制', async () => {
  const ctx = setup('node-limit');
  const registry = new NodeRegistry(ctx.db);
  await registry.register({ name: 'n1' }, { maxNodes: 2 });
  await registry.register({ name: 'n2' }, { maxNodes: 2 });
  await assert.rejects(() => registry.register({ name: 'n3' }, { maxNodes: 2 }), /已达上限/);
  ctx.cleanup();
});

test('同名节点为更新而非新建', async () => {
  const ctx = setup('node-update');
  const registry = new NodeRegistry(ctx.db);
  const a = await registry.register({ name: 'same', port: 1 }, { maxNodes: 4 });
  const b = await registry.register({ name: 'same', port: 2 }, { maxNodes: 4 });
  assert.equal(a.id, b.id);
  assert.equal(b.port, 2);
  ctx.cleanup();
});

test('端口越界被拒绝', async () => {
  const ctx = setup('node-port');
  const registry = new NodeRegistry(ctx.db);
  await assert.rejects(() => registry.register({ name: 'p', port: 99999 }, { maxNodes: 4 }), /端口非法/);
  ctx.cleanup();
});

test('不允许删除在线集群的 leader（避免静默失去主节点）', async () => {
  const ctx = setup('node-leader-del');
  const registry = new NodeRegistry(ctx.db);
  const a = await registry.register({ name: 'a' }, { maxNodes: 4 });
  await registry.register({ name: 'b' }, { maxNodes: 4 });
  await registry.heartbeat(a.id);
  const b = (await registry.list()).find((n) => n.name === 'b')!;
  await registry.heartbeat(b.id);
  await registry.setRole(a.id, 'leader');
  await assert.rejects(() => registry.remove(a.id), /不能直接删除在线集群的 leader/);
  ctx.cleanup();
});

test('内网地址判定与沙箱一致', () => {
  for (const h of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', 'localhost']) assert.equal(isPrivateClusterHost(h), true);
  assert.equal(isPrivateClusterHost('node.example.com'), false);
});

/* ------------------------------ 心跳与容错 ------------------------------ */

test('心跳超时把节点标记离线并触发回调', async () => {
  const ctx = setup('heartbeat');
  const registry = new NodeRegistry(ctx.db);
  const node = await registry.register({ name: 'w' }, { maxNodes: 4 });
  await registry.heartbeat(node.id);
  const offline: string[] = [];
  const hb = new HeartbeatManager(ctx.db, registry, {
    timeoutMs: 1000,
    now: () => new Date(Date.now() + 5000),
    onOffline: (nodes) => {
      offline.push(...nodes.map((n) => n.name));
    },
  });
  const res = await hb.tick();
  assert.equal(res.offline.length, 1);
  assert.deepEqual(offline, ['w']);
  assert.equal(hb.running, false, '未 start 时不应有定时器（避免测试进程不退出）');
  ctx.cleanup();
});

test('心跳未超时的节点保持在线', async () => {
  const ctx = setup('heartbeat-online');
  const registry = new NodeRegistry(ctx.db);
  const node = await registry.register({ name: 'w2' }, { maxNodes: 4 });
  await registry.heartbeat(node.id);
  const hb = new HeartbeatManager(ctx.db, registry, { timeoutMs: 60_000 });
  const res = await hb.tick();
  assert.equal(res.offline.length, 0);
  assert.ok(registry.onlineCache.length >= 0);
  ctx.cleanup();
});

test('节点失联后分片改派到健康节点', async () => {
  const ctx = setup('reassign');
  const registry = new NodeRegistry(ctx.db);
  const distributor = new TaskDistributor(ctx.db);
  const a = await registry.register({ name: 'a' }, { maxNodes: 4 });
  const b = await registry.register({ name: 'b' }, { maxNodes: 4 });
  await registry.heartbeat(a.id);
  await registry.heartbeat(b.id);
  const nodes = await registry.list();

  await distributor.distribute({ workspaceId: ctx.workspaceId, taskId: 't1', shards: [{ index: 0, total: 1, items: [1, 2], weight: 2 }], nodes, maxParallel: 4 });
  const shards = await distributor.listShards('t1');
  assert.equal(shards.length, 1);
  assert.equal(shards[0]!.status, 'assigned');

  const faults = new FaultTolerance(ctx.db, distributor, { maxAttempts: 3 });
  const dead = nodes.filter((n) => n.id === shards[0]!.assignedNodeId);
  const healthy = nodes.filter((n) => n.id !== shards[0]!.assignedNodeId);
  const result = await faults.handleNodeLoss(dead, healthy, 4);
  assert.equal(result.reassigned.length, 1);
  assert.notEqual(result.reassigned[0]!.to, shards[0]!.assignedNodeId);
  ctx.cleanup();
});

test('重试超过上限后分片标记 failed 而不是无限重试', async () => {
  const ctx = setup('retry-limit');
  const registry = new NodeRegistry(ctx.db);
  const distributor = new TaskDistributor(ctx.db);
  const a = await registry.register({ name: 'a' }, { maxNodes: 4 });
  await registry.heartbeat(a.id);
  const nodes = await registry.list();
  await distributor.distribute({ workspaceId: ctx.workspaceId, taskId: 't2', shards: [{ index: 0, total: 1, items: [1], weight: 1 }], nodes, maxParallel: 4 });
  const shard = (await distributor.listShards('t2'))[0]!;
  const { clusterShards } = await import('../db/schema/index.ts');
  const { eq } = await import('drizzle-orm');
  await ctx.db.update(clusterShards).set({ attempts: 3 } as never).where(eq(clusterShards.id, shard.id));
  const faults = new FaultTolerance(ctx.db, distributor, { maxAttempts: 3 });
  const res = await faults.retryShard(shard.id, nodes, 4);
  assert.equal(res.retried, false);
  assert.match(res.reason, /最大重试次数/);
  assert.equal((await distributor.listShards('t2')).find((s) => s.id === shard.id)!.status, 'failed');
  ctx.cleanup();
});

test('已完成分片不会被重试', async () => {
  const ctx = setup('retry-done');
  const registry = new NodeRegistry(ctx.db);
  const distributor = new TaskDistributor(ctx.db);
  const a = await registry.register({ name: 'a' }, { maxNodes: 4 });
  await registry.heartbeat(a.id);
  const nodes = await registry.list();
  await distributor.distribute({ workspaceId: ctx.workspaceId, taskId: 't3', shards: [{ index: 0, total: 1, items: [1], weight: 1 }], nodes, maxParallel: 4 });
  const shard = (await distributor.listShards('t3'))[0]!;
  await distributor.complete(shard.id, { ok: true, result: { v: 1 } });
  const faults = new FaultTolerance(ctx.db, distributor, {});
  const res = await faults.retryShard(shard.id, nodes, 4);
  assert.equal(res.retried, false);
  assert.match(res.reason, /已成功/);
  ctx.cleanup();
});

/* ------------------------------ 分发 ------------------------------ */

test('分发遵守并行上限，超出部分保持 pending 并说明原因', async () => {
  const ctx = setup('distribute-parallel');
  const registry = new NodeRegistry(ctx.db);
  const distributor = new TaskDistributor(ctx.db);
  const a = await registry.register({ name: 'a' }, { maxNodes: 4 });
  await registry.heartbeat(a.id);
  const nodes = await registry.list();
  const shards = shardByCount([1, 2, 3, 4, 5, 6], 6);
  const res = await distributor.distribute({ workspaceId: ctx.workspaceId, taskId: 't4', shards, nodes, maxParallel: 2 });
  assert.equal(res.assignments.length, 2);
  assert.equal(res.skipped.length, 4);
  assert.match(res.skipped[0]!.reason, /并行上限/);
  ctx.cleanup();
});

test('分发按标签与资源筛选节点', async () => {
  const ctx = setup('distribute-label');
  const registry = new NodeRegistry(ctx.db);
  const distributor = new TaskDistributor(ctx.db);
  const small = await registry.register({ name: 'small', resources: { cpu: 1, memoryMb: 1024 }, labels: { tier: 'basic' } }, { maxNodes: 4 });
  const big = await registry.register({ name: 'big', resources: { cpu: 16, memoryMb: 32768 }, labels: { tier: 'pro' } }, { maxNodes: 4 });
  await registry.heartbeat(small.id);
  await registry.heartbeat(big.id);
  const nodes = await registry.list();
  const res = await distributor.distribute({ workspaceId: ctx.workspaceId, taskId: 't5', shards: [{ index: 0, total: 1, items: [1], weight: 1 }], nodes, labels: { tier: 'pro' }, need: { cpu: 8 }, maxParallel: 4 });
  assert.equal(res.assignments.length, 1);
  assert.equal(res.assignments[0]!.nodeId, big.id);
  ctx.cleanup();
});

test('无可用节点时分发被跳过且原因可读', async () => {
  const ctx = setup('distribute-none');
  const distributor = new TaskDistributor(ctx.db);
  const res = await distributor.distribute({ workspaceId: ctx.workspaceId, taskId: 't6', shards: [{ index: 0, total: 1, items: [1], weight: 1 }], nodes: [], maxParallel: 4 });
  assert.equal(res.assignments.length, 0);
  assert.match(res.skipped[0]!.reason, /没有节点|降级单机/);
  ctx.cleanup();
});

test('同一分片重复分发不产生重复执行', async () => {
  const ctx = setup('distribute-idempotent');
  const registry = new NodeRegistry(ctx.db);
  const distributor = new TaskDistributor(ctx.db);
  const a = await registry.register({ name: 'a' }, { maxNodes: 4 });
  await registry.heartbeat(a.id);
  const nodes = await registry.list();
  const shards = shardByCount([1, 2], 2);
  await distributor.distribute({ workspaceId: ctx.workspaceId, taskId: 't7', shards, nodes, maxParallel: 4 });
  const again = await distributor.distribute({ workspaceId: ctx.workspaceId, taskId: 't7', shards, nodes, maxParallel: 4 });
  assert.equal(again.assignments.length, 0);
  assert.ok(again.skipped.every((s) => /跳过重复分发/.test(s.reason)));
  ctx.cleanup();
});

test('任务取消释放节点负载', async () => {
  const ctx = setup('cancel');
  const registry = new NodeRegistry(ctx.db);
  const distributor = new TaskDistributor(ctx.db);
  const a = await registry.register({ name: 'a' }, { maxNodes: 4 });
  await registry.heartbeat(a.id);
  const nodes = await registry.list();
  await distributor.distribute({ workspaceId: ctx.workspaceId, taskId: 't8', shards: [{ index: 0, total: 1, items: [1, 2, 3], weight: 3 }], nodes, maxParallel: 4 });
  assert.ok(distributor.load(a.id) > 0);
  const tasks = await distributor.listTasks(ctx.workspaceId);
  await distributor.cancelTask(ctx.workspaceId, tasks[0]!.id);
  assert.equal(distributor.load(a.id), 0);
  ctx.cleanup();
});

/* ------------------------------ 选举 ------------------------------ */

test('选举在无在线节点时不产生 leader', async () => {
  const ctx = setup('elect-none');
  const elections = new ElectionService(ctx.db);
  const res = await elections.elect({ reason: 'initial' });
  assert.equal(res.leaderNodeId, '');
  assert.equal(res.changed, false);
  ctx.cleanup();
});

test('选举按优先级确定性选出 leader，且全局只有一个 leader', async () => {
  const ctx = setup('elect');
  const registry = new NodeRegistry(ctx.db);
  const elections = new ElectionService(ctx.db);
  const a = await registry.register({ name: 'a' }, { maxNodes: 4 });
  const b = await registry.register({ name: 'b', labels: { leaderPriority: '10' } }, { maxNodes: 4 });
  await registry.heartbeat(a.id);
  await registry.heartbeat(b.id);
  const res = await elections.elect({ reason: 'initial' });
  assert.equal(res.leaderNodeId, b.id, '优先级高的节点应胜出');
  const leaders = (await registry.list()).filter((n) => n.role === 'leader');
  assert.equal(leaders.length, 1);
  ctx.cleanup();
});

test('leader 掉线触发重新选举（failover）', async () => {
  const ctx = setup('elect-failover');
  const registry = new NodeRegistry(ctx.db);
  const elections = new ElectionService(ctx.db);
  const a = await registry.register({ name: 'a', labels: { leaderPriority: '10' } }, { maxNodes: 4 });
  const b = await registry.register({ name: 'b' }, { maxNodes: 4 });
  await registry.heartbeat(a.id);
  await registry.heartbeat(b.id);
  const first = await elections.elect({ reason: 'initial' });
  assert.equal(first.leaderNodeId, a.id);

  await registry.setStatus(a.id, 'offline');
  const offlineNode = (await registry.get(a.id));
  const failover = await elections.handleFailover([offlineNode]);
  assert.ok(failover);
  assert.equal(failover!.leaderNodeId, b.id);
  assert.equal(failover!.reason, '按优先级选出：b（priority=0，role=worker）');
  const history = await elections.history();
  assert.ok(history.length >= 2, '两次选举都应有记录，term 递增');
  ctx.cleanup();
});

test('leader 未掉线时不触发 failover', async () => {
  const ctx = setup('elect-noop');
  const registry = new NodeRegistry(ctx.db);
  const elections = new ElectionService(ctx.db);
  const a = await registry.register({ name: 'a' }, { maxNodes: 4 });
  await registry.heartbeat(a.id);
  await elections.elect({ reason: 'initial' });
  const other = (await registry.list()).find((n) => n.id !== a.id);
  const res = await elections.handleFailover(other ? [other] : []);
  assert.equal(res, null);
  ctx.cleanup();
});

test('候选排序规则可独立验证', async () => {
  const nodes = [
    { id: '1', name: 'z', role: 'worker', labels: {} },
    { id: '2', name: 'a', role: 'worker', labels: {} },
    { id: '3', name: 'm', role: 'candidate', labels: {} },
  ] as never[];
  const ranked = rankCandidates(nodes);
  assert.equal(ranked[0]!.name, 'm', 'candidate 角色优先');
  assert.equal(ranked[2]!.name, 'z', '同权重时按名称确定性排序');
});

/* ------------------------------ 策略与降级 ------------------------------ */

test('策略校验：边界值拒绝', () => {
  assert.throws(() => validatePolicy({ maxNodes: 0, maxParallelTasks: 1, heartbeatTimeoutMs: 5000, resourceLimits: {} }), /maxNodes/);
  assert.throws(() => validatePolicy({ maxNodes: 1, maxParallelTasks: 999, heartbeatTimeoutMs: 5000, resourceLimits: {} }), /maxParallelTasks/);
  assert.throws(() => validatePolicy({ maxNodes: 1, maxParallelTasks: 1, heartbeatTimeoutMs: 10, resourceLimits: {} }), /heartbeatTimeoutMs/);
  assert.throws(() => validatePolicy({ maxNodes: 1, maxParallelTasks: 1, heartbeatTimeoutMs: 5000, resourceLimits: { cpu: -1 } }), /资源上限/);
});

test('策略默认值与资源治理校验', async () => {
  const ctx = setup('policy');
  const svc = new ClusterPolicyService(ctx.db);
  const policy = await svc.get(ctx.workspaceId);
  assert.equal(policy.maxNodes, DEFAULT_POLICY.maxNodes);
  assert.equal(policy.fallbackEnabled, true);
  const ok = svc.checkResource(policy.resourceLimits, { cpu: 1 });
  assert.equal(ok.ok, true);
  const bad = svc.checkResource(policy.resourceLimits, { cpu: 9999 });
  assert.equal(bad.ok, false);
  assert.match(bad.violations[0]!, /需要 9999/);
  ctx.cleanup();
});

test('策略更新被校验拦截', async () => {
  const ctx = setup('policy-update');
  const svc = new ClusterPolicyService(ctx.db);
  await svc.get(ctx.workspaceId);
  await assert.rejects(() => svc.update(ctx.workspaceId, { maxParallelTasks: 0 }), /maxParallelTasks/);
  const updated = await svc.update(ctx.workspaceId, { maxParallelTasks: 8, fallbackEnabled: false });
  assert.equal(updated.maxParallelTasks, 8);
  assert.equal(updated.fallbackEnabled, false);
  ctx.cleanup();
});

test('降级决策：无节点时回退单机并给出建议', () => {
  const d = decideFallback({ requested: 'cluster', fallbackEnabled: true, nodes: [], leaderExists: false });
  assert.equal(d.effective, 'degraded');
  assert.match(d.reason, /回退单机/);
  assert.ok(d.suggestion.length > 0);
});

test('降级决策：禁止回退时明确拒绝而不是偷偷降级', () => {
  const d = decideFallback({ requested: 'cluster', fallbackEnabled: false, nodes: [], leaderExists: false });
  assert.equal(d.effective, 'cluster');
  assert.match(d.reason, /不会被调度/);
});

test('降级决策：无 leader 时回退并提示触发选举', () => {
  const d = decideFallback({ requested: 'cluster', fallbackEnabled: true, nodes: [{ status: 'online' }], leaderExists: false });
  assert.equal(d.effective, 'degraded');
  assert.match(d.suggestion, /选举/);
});

test('降级决策：功能开关关闭时说明如何打开', () => {
  const d = decideFallback({ requested: 'cluster', fallbackEnabled: true, nodes: [{ status: 'online' }], leaderExists: true, clusterEnabled: false });
  assert.equal(d.effective, 'degraded');
  assert.match(d.reason, /phase4Cluster/);
});

test('单机模式不被降级逻辑改写', () => {
  const d = decideFallback({ requested: 'single', fallbackEnabled: true, nodes: [], leaderExists: false });
  assert.equal(d.effective, 'single');
});

/* ------------------------------ 管理器编排 ------------------------------ */

test('ClusterManager 引导：注册本机节点 → 心跳 → 选举 → 状态可用', async () => {
  const ctx = setup('manager');
  const manager = new ClusterManager(ctx.db, { clusterEnabled: true });
  const boot = await manager.ensureBootstrapped(ctx.workspaceId);
  assert.ok(boot.nodeId);
  assert.equal(boot.elected, true);

  const status = await manager.status(ctx.workspaceId, 'cluster');
  assert.equal(status.mode, 'cluster');
  assert.equal(status.degraded, false);
  assert.equal(status.online, 1);
  assert.ok(status.leader);
  assert.equal(status.term, 1);

  const mode = await manager.effectiveMode(ctx.workspaceId, 'cluster');
  assert.equal(mode.mode, 'cluster');
  manager.stop();
  ctx.cleanup();
});

test('ClusterManager：启动即可停止（不阻塞进程退出）', async () => {
  const ctx = setup('manager-stop');
  const manager = new ClusterManager(ctx.db, { heartbeatIntervalMs: 50, now: () => new Date() });
  manager.start();
  assert.equal(manager.heartbeat.running, true);
  manager.stop();
  assert.equal(manager.heartbeat.running, false);
  ctx.cleanup();
});

test('ClusterManager 状态在无节点时报告降级原因', async () => {
  const ctx = setup('manager-degraded');
  const manager = new ClusterManager(ctx.db, { clusterEnabled: true });
  const status = await manager.status(ctx.workspaceId, 'cluster');
  assert.equal(status.degraded, true);
  assert.ok((status.degradeReason ?? '').length > 0);
  ctx.cleanup();
});

test('FaultTolerance.isClusterUsable 综合判断可用性', () => {
  const online = [{ id: '1', name: 'a', status: 'online', role: 'leader' }] as never[];
  assert.equal(FaultTolerance.isClusterUsable(online, online[0]!).usable, true);
  assert.equal(FaultTolerance.isClusterUsable([], null).usable, false);
  assert.equal(FaultTolerance.isClusterUsable(online, null).usable, false);
  const offlineLeader = [{ id: '1', name: 'a', status: 'online', role: 'worker' }] as never[];
  const off = [{ id: '2', name: 'b', status: 'offline', role: 'leader' }] as never[];
  assert.equal(FaultTolerance.isClusterUsable([...offlineLeader, ...off], off[0]!).usable, false);
});

test('分片状态汇总能判断任务是否完成', () => {
  const s1 = FaultTolerance.summarize([
    { index: 0, items: [], status: 'succeeded' },
    { index: 1, items: [], status: 'failed' },
  ]);
  assert.equal(s1.done, true);
  assert.equal(s1.succeeded, 1);
  assert.equal(s1.failed, 1);
  const s2 = FaultTolerance.summarize([{ index: 0, items: [], status: 'running' }]);
  assert.equal(s2.done, false);
});
