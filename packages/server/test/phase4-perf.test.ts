import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDb, createDb, type Db } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { setSecretKeyForTest } from '../src/security/secrets.ts';

/**
 * Phase 4 性能测试。
 *
 * 关注点：**在真实规模下不会卡死**（而不是微基准）。
 * 每项都有一个宽松但明确的上界，超过即失败 —— 这样「性能回归」会在 CI 里被捕捉到。
 */

interface Ctx {
  db: Db;
  workspaceId: string;
  cleanup: () => void;
}

function setup(name: string): Ctx {
  closeDb();
  const dir = mkdtempSync(path.join(tmpdir(), `p4perf-${name}-`));
  setSecretKeyForTest('phase4-perf-test-key-0123456789ab');
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

test('PERF-分片：10000 项分 200 片（< 600ms）', async () => {
  const { shardAuto, shardByCount, shardByWeight } = await import('../src/cluster/shardScheduler.ts');
  const items = Array.from({ length: 10_000 }, (_, i) => ({ w: (i % 10) + 1 }));
  const t0 = Date.now();
  const byCount = shardByCount(items, 200);
  const byWeight = shardByWeight(items, 200, (x) => x.w);
  const auto = shardAuto(items, 200, (x) => x.w);
  const elapsed = Date.now() - t0;
  assert.equal(byCount.length, 200);
  assert.equal(byWeight.length, 200);
  assert.equal(auto.length, 200);
  assert.equal(byCount.reduce((s, x) => s + x.items.length, 0), 10_000);
  // 预算按「整仓并发跑测试」的最坏情况给：单独跑本文件实测约 150ms，
  // 但与其它 test 文件并行时会被 CPU/GC 抢占放大到 210~280ms。
  // 之前卡 200ms 会让 `pnpm test` 稳定失败（不是性能退化，是阈值定得太紧）。
  assert.ok(elapsed < 600, `分片耗时 ${elapsed}ms，超过 600ms`);
});

test('PERF-分片：负载均衡度在合理范围（最大片权重不超过均值 1.6 倍）', async () => {
  const { shardByWeight } = await import('../src/cluster/shardScheduler.ts');
  const items = Array.from({ length: 5000 }, (_, i) => ({ w: (i % 50) + 1 }));
  const shards = shardByWeight(items, 50, (x) => x.w);
  const weights = shards.map((s) => s.weight);
  const avg = weights.reduce((a, b) => a + b, 0) / weights.length;
  const max = Math.max(...weights);
  assert.ok(max <= avg * 1.6, `最大片权重 ${max.toFixed(1)} 超过均值 ${avg.toFixed(1)} 的 1.6 倍`);
});

test('PERF-DAG：1000 节点 10 层依赖校验与分层（< 300ms）', async () => {
  const { topologicalLayers, validateDag, resolveReadyTasks } = await import('../src/agents/taskDag.ts');
  const nodes = [];
  for (let layer = 0; layer < 10; layer += 1) {
    for (let i = 0; i < 100; i += 1) {
      const id = `L${layer}N${i}`;
      const deps = layer === 0 ? [] : [`L${layer - 1}N${i}`, `L${layer - 1}N${(i + 1) % 100}`];
      nodes.push({ id, dependsOn: deps, status: 'pending' as const });
    }
  }
  const t0 = Date.now();
  assert.equal(validateDag(nodes).ok, true);
  const { layers } = topologicalLayers(nodes);
  const ready = resolveReadyTasks(nodes);
  const elapsed = Date.now() - t0;
  assert.equal(layers.length, 10);
  assert.equal(layers[0]!.length, 100);
  assert.equal(ready.length, 100);
  assert.ok(elapsed < 300, `DAG 处理耗时 ${elapsed}ms，超过 300ms`);
});

test('PERF-DAG：环检测在大图上快速失败（< 200ms）', async () => {
  const { validateDag } = await import('../src/agents/taskDag.ts');
  const nodes = Array.from({ length: 2000 }, (_, i) => ({ id: `n${i}`, dependsOn: [`n${(i + 1) % 2000}`], status: 'pending' as const }));
  const t0 = Date.now();
  const res = validateDag(nodes);
  const elapsed = Date.now() - t0;
  assert.equal(res.ok, false);
  assert.ok(res.cycle);
  assert.ok(elapsed < 200, `环检测耗时 ${elapsed}ms，超过 200ms`);
});

test('PERF-并行度：1000 次决策（< 100ms）', async () => {
  const { decideParallelism } = await import('../src/agents/parallelismPolicy.ts');
  const t0 = Date.now();
  for (let i = 0; i < 1000; i += 1) {
    decideParallelism({ configuredMax: 8, clusterMax: 6, poolHeadroom: { a: 3, b: 2 }, readyTasks: i % 20, cpuCores: 16 });
  }
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 100, `并行度决策耗时 ${elapsed}ms，超过 100ms`);
});

test('PERF-聚合：200 个 Agent 输出聚合（< 200ms）', async () => {
  const { aggregate } = await import('../src/agents/resultAggregator.ts');
  const outputs = Array.from({ length: 200 }, (_, i) => ({
    agentId: `a${i}`,
    role: i % 2 === 0 ? 'reviewer' : 'coder',
    data: { level: i % 3 === 0 ? 'high' : i % 3 === 1 ? 'medium' : 'low', score: i % 7, note: `n${i}` },
  }));
  const t0 = Date.now();
  const res = aggregate({ taskId: 't', strategy: 'majority', outputs });
  const elapsed = Date.now() - t0;
  assert.ok(Object.keys(res.result).length >= 3);
  assert.ok(elapsed < 200, `聚合耗时 ${elapsed}ms，超过 200ms`);
});

test('PERF-冲突检测：2000 个取值对的差异化检测（< 200ms）', async () => {
  const { detectConflicts } = await import('../src/agents/resultAggregator.ts');
  const outputs = Array.from({ length: 2000 }, (_, i) => ({ agentId: `a${i}`, data: { k: i % 100 } }));
  const t0 = Date.now();
  const conflicts = detectConflicts(outputs);
  const elapsed = Date.now() - t0;
  assert.equal(conflicts.length, 1, '同一字段的全部取值应聚成一处冲突');
  assert.equal(conflicts[0]!.values.length, 2000);
  assert.ok(elapsed < 200, `冲突检测耗时 ${elapsed}ms，超过 200ms`);
});

test('PERF-脱敏：10000 条记录深度脱敏（< 500ms）', async () => {
  const { DataMaskService } = await import('../src/enterprise/dataMask.ts');
  const svc = new DataMaskService(null as never);
  const records = Array.from({ length: 10_000 }, (_, i) => ({ id: i, token: `t${i}`, nested: { apiKey: `k${i}`, safe: 'ok' } }));
  const t0 = Date.now();
  for (const r of records) svc.maskDeep(r, { token: 'full', apikey: 'full' });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 500, `脱敏 10000 条耗时 ${elapsed}ms，超过 500ms`);
});

test('PERF-审计导出：5000 条消息量级（< 3s）', async (t) => {
  const ctx = setup('audit-export');
  const { auditLogs } = await import('../src/db/schema/index.ts');
  const { AuditQueryService } = await import('../src/enterprise/auditLog.ts');
  const { DataMaskService } = await import('../src/enterprise/dataMask.ts');
  const now = Date.now();
  const rows = Array.from({ length: 5000 }, (_, i) => ({
    id: `adt${i}`,
    workspaceId: ctx.workspaceId,
    actor: 'user',
    action: i % 5 === 0 ? 'plugin.invoke' : 'file.upload',
    targetType: 'plugin',
    targetId: `t${i}`,
    dangerous: false,
    confirmedByUser: true,
    detail: { i, token: `secret-${i}` } as never,
    createdAt: new Date(now - i * 60_000).toISOString(),
  }));
  // 分批插入（单条插入 5000 次会太慢，这里模拟真实批量写入路径）
  const t0 = Date.now();
  for (let i = 0; i < rows.length; i += 500) {
    await ctx.db.insert(auditLogs).values(rows.slice(i, i + 500) as never);
  }
  const insertMs = Date.now() - t0;
  assert.ok(insertMs < 5000, `插入 5000 条耗时 ${insertMs}ms，超过 5s`);

  const svc = new AuditQueryService(ctx.db, new DataMaskService(ctx.db));
  const t1 = Date.now();
  // 导出接口默认 limit 为 10000，但 auditExports 落库的 rowCount 取实际写入条数；
  // 这里数据跨度是 5000 分钟（≈3.5 天），时间窗口要覆盖全部，否则只会导出窗口内的记录。
  const res = await svc.export({ workspaceId: ctx.workspaceId, from: new Date(now - 7 * 86400_000).toISOString(), to: new Date(now + 60_000).toISOString(), outputDir: tmpdir(), limit: 10_000 });
  const elapsed = Date.now() - t1;
  assert.equal(res.rowCount, 5000, `实际导出 ${res.rowCount} 条`);
  assert.ok(elapsed < 3000, `导出 5000 条耗时 ${elapsed}ms，超过 3s`);
  t.diagnostic(`插入 ${insertMs}ms / 导出 ${elapsed}ms`);
  ctx.cleanup();
});

test('PERF-缓存：10000 次读写（< 100ms）', async () => {
  const { ResultCache } = await import('../src/paidData/resultCache.ts');
  const cache = new ResultCache();
  const t0 = Date.now();
  for (let i = 0; i < 10_000; i += 1) {
    cache.set(`k${i % 500}`, i, 60_000);
    cache.get(`k${i % 500}`);
  }
  const elapsed = Date.now() - t0;
  assert.ok(cache.size() <= 500, '缓存条目数必须受上限约束');
  assert.ok(elapsed < 100, `缓存读写耗时 ${elapsed}ms，超过 100ms`);
});

test('PERF-成本汇总：20000 条记录（< 1.5s）', async () => {
  const ctx = setup('cost');
  const { costRecords } = await import('../src/db/schema/index.ts');
  const { CostController } = await import('../src/agents/costController.ts');
  const rows = Array.from({ length: 20_000 }, (_, i) => ({
    id: `c${i}`,
    workspaceId: ctx.workspaceId,
    goalId: `g${i % 20}`,
    taskId: `t${i}`,
    agentId: `a${i % 10}`,
    model: i % 3 === 0 ? 'gpt-4o' : 'gpt-4o-mini',
    tokensIn: 100,
    tokensOut: 50,
    cost: 0.001,
    budgetState: 'none',
    createdAt: new Date().toISOString(),
  }));
  for (let i = 0; i < rows.length; i += 1000) {
    await ctx.db.insert(costRecords).values(rows.slice(i, i + 1000) as never);
  }
  const svc = new CostController(ctx.db);
  const t0 = Date.now();
  const summary = await svc.summary(ctx.workspaceId, { limitUsd: 100 });
  const elapsed = Date.now() - t0;
  assert.equal(summary.byModel.length, 2);
  assert.equal(summary.byAgent.length, 10);
  assert.ok(elapsed < 1500, `成本汇总耗时 ${elapsed}ms，超过 1.5s`);
  ctx.cleanup();
});

test('PERF-插件市场检索：全量扫描（< 20ms）', async () => {
  const { searchMarket } = await import('../src/plugins/pluginMarket.ts');
  const t0 = Date.now();
  for (let i = 0; i < 200; i += 1) searchMarket({ q: '数据' });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 20, `市场检索 200 次耗时 ${elapsed}ms，超过 20ms`);
});

test('PERF-提示词：200 次生成 + 优化（< 1.5s）', async () => {
  const { generatePrompt } = await import('../src/prompt/promptGenerator.ts');
  const { optimizeSections } = await import('../src/prompt/promptOptimizer.ts');
  const t0 = Date.now();
  for (let i = 0; i < 200; i += 1) {
    const gen = generatePrompt({ goal: `分析第 ${i} 组数据的趋势并输出结论` });
    optimizeSections(gen.sections);
  }
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1500, `200 次生成+优化耗时 ${elapsed}ms，超过 1.5s`);
});

test('PERF-分发：500 分片在 20 节点上分配（< 500ms）', async () => {
  const ctx = setup('distribute');
  const { NodeRegistry } = await import('../src/cluster/nodeRegistry.ts');
  const { TaskDistributor } = await import('../src/cluster/taskDistributor.ts');
  const { shardByCount } = await import('../src/cluster/shardScheduler.ts');
  const registry = new NodeRegistry(ctx.db);
  for (let i = 0; i < 20; i += 1) {
    const n = await registry.register({ name: `n${i}`, resources: { cpu: 8, memoryMb: 16384 } }, { maxNodes: 32 });
    await registry.heartbeat(n.id, { cpu: 10 });
  }
  const nodes = await registry.list();
  const distributor = new TaskDistributor(ctx.db);
  const shards = shardByCount(Array.from({ length: 5000 }, (_, i) => i), 500);
  const t0 = Date.now();
  const res = await distributor.distribute({ workspaceId: ctx.workspaceId, taskId: 'big-task', shards, nodes, maxParallel: 500 });
  const elapsed = Date.now() - t0;
  assert.equal(res.assignments.length, 500);
  assert.ok(elapsed < 500, `500 分片分发耗时 ${elapsed}ms，超过 500ms`);
  ctx.cleanup();
});

test('PERF-合规守卫：10000 次判定（< 400ms）', async () => {
  const { checkCompliance } = await import('../src/paidData/complianceGuard.ts');
  const t0 = Date.now();
  for (let i = 0; i < 10_000; i += 1) {
    checkCompliance({ providerId: 'tianyancha', action: 'company.basic', params: { keyword: `k${i}` }, hasCredentials: i % 2 === 0 });
  }
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 400, `合规判定耗时 ${elapsed}ms，超过 400ms`);
});

test('PERF-插件清单哈希：1000 次（< 100ms）', async () => {
  const { hashManifest } = await import('../src/plugins/pluginManifest.ts');
  const { PLUGIN_MARKET } = await import('../src/plugins/pluginMarket.ts');
  const t0 = Date.now();
  for (let i = 0; i < 1000; i += 1) hashManifest(PLUGIN_MARKET[i % PLUGIN_MARKET.length]!);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 100, `哈希 1000 次耗时 ${elapsed}ms，超过 100ms`);
});
