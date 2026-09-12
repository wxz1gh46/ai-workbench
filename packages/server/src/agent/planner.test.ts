import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultPlan, parsePlan } from './planner.ts';

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
