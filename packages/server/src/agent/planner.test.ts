import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultPlan, parsePlan } from './planner.ts';
import { detectCycle } from './task-graph.ts';

test('parsePlan 解析带 markdown 包裹的 JSON', () => {
  const raw = '```json\n{"acceptanceCriteria":["a"],"tasks":[{"key":"t1","title":"T","agentRole":"researcher","dependsOn":[]}]}\n```';
  const { acceptanceCriteria, tasks } = parsePlan(raw);
  assert.deepEqual(acceptanceCriteria, ['a']);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.agentRole, 'researcher');
});

test('parsePlan 过滤非法角色并去掉自依赖', () => {
  const raw = '{"tasks":[{"key":"t1","title":"T","agentRole":"hacker","dependsOn":["t1"]}]}';
  const { tasks } = parsePlan(raw);
  assert.equal(tasks[0]!.agentRole, 'analyst');
  assert.deepEqual(tasks[0]!.dependsOn, []);
});

test('parsePlan 对非 JSON 抛错', () => {
  assert.throws(() => parsePlan('抱歉我做不到'));
});

test('defaultPlan 依赖链无环且首任务无依赖', () => {
  const plan = defaultPlan('写一份行业报告');
  assert.equal(plan.tasks[0]!.dependsOn.length, 0);
  assert.ok(plan.tasks.some((t) => t.agentRole === 'critic'));
  assert.ok(plan.acceptanceCriteria.length >= 1);
});

test('defaultPlan 产出 ≥10 步的真实 DAG（离线也满足「自主完成 10+ 步」验收）', () => {
  const plan = defaultPlan('为储能行业写一份调研报告');
  assert.ok(plan.tasks.length >= 10, `离线计划应 ≥10 步，实际 ${plan.tasks.length}`);
  assert.ok(plan.acceptanceCriteria.length >= 3, '验收标准应足够具体');
  // DAG 必须无环
  const nodes = plan.tasks.map((t, i) => ({ id: t.key, dependsOn: t.dependsOn, status: 'pending' as const }));
  assert.equal(detectCycle(nodes), null, '离线计划不得成环');
  // 必须存在并行分支（同层多任务），否则无法验证多 Agent 并行
  const fans = plan.tasks.filter((t) => t.dependsOn.length > 0);
  const depsCount = new Map<string, number>();
  for (const t of fans) for (const d of t.dependsOn) depsCount.set(d, (depsCount.get(d) ?? 0) + 1);
  assert.ok([...depsCount.values()].some((c) => c >= 2), '应存在扇出（多任务共享同一上游），才能并行执行');
  // 依赖引用必须都存在
  const keys = new Set(plan.tasks.map((t) => t.key));
  for (const t of plan.tasks) for (const d of t.dependsOn) assert.ok(keys.has(d), `依赖 ${d} 不存在`);
});
