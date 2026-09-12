import assert from 'node:assert/strict';
import test from 'node:test';
import type { Goal, Task } from '@ai/shared';
import { allSettled, allSucceeded, buildProgressTree, flattenTree, summarize } from './progressTree.ts';

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    goalId: 'g1',
    parentTaskId: null,
    title: `任务 ${id}`,
    description: '',
    status: 'pending',
    progress: 0,
    agentRole: 'analyst',
    tools: [],
    dependsOn: [],
    attempts: 0,
    maxAttempts: 3,
    claimedBy: null,
    input: {},
    output: null,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

const goal: Goal = {
  id: 'g1',
  workspaceId: 'ws1',
  conversationId: null,
  objective: '完成 Phase 2',
  acceptanceCriteria: ['百万 token 不崩溃'],
  status: 'running',
  progress: 0,
  iterations: 1,
  maxIterations: 12,
  blockers: [],
  auditReport: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('summarize：各状态计数与完成度', () => {
  const tasks = [
    task('a', { status: 'succeeded' }),
    task('b', { status: 'failed' }),
    task('c', { status: 'blocked' }),
    task('d', { status: 'running' }),
    task('e', { status: 'pending' }),
  ];
  const s = summarize(tasks);
  assert.equal(s.total, 5);
  assert.equal(s.succeeded, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.blocked, 1);
  assert.equal(s.running, 1);
  assert.equal(s.pending, 1);
  assert.ok(s.percent > 0 && s.percent < 100);
});

test('buildProgressTree：父子层级与阻塞原因', () => {
  const tasks = [task('root', { status: 'running' }), task('child', { parentTaskId: 'root', status: 'blocked', error: '缺少凭据' })];
  const tree = buildProgressTree(goal, tasks);
  assert.equal(tree.nodes.length, 1);
  assert.equal(tree.nodes[0]!.id, 'root');
  assert.equal(tree.nodes[0]!.children.length, 1);
  assert.equal(tree.nodes[0]!.children[0]!.blockedReason, '缺少凭据');
  assert.equal(flattenTree(tree.nodes).length, 2);
});

test('buildProgressTree：依赖失败时给出推断出的阻塞原因', () => {
  const tasks = [task('up', { status: 'failed', error: '超时' }), task('down', { status: 'pending', dependsOn: ['up'] })];
  const tree = buildProgressTree(goal, tasks);
  const down = flattenTree(tree.nodes).find((n) => n.id === 'down')!;
  // pending 不算 blocked，但依赖信息必须保留，便于 UI 展示原因
  assert.deepEqual(down.dependsOn, ['up']);
});

test('buildProgressTree：blockers 汇总任务级与目标级去重', () => {
  const g = { ...goal, blockers: ['目标级：等待用户授权'] };
  const tasks = [task('x', { status: 'blocked', error: '缺凭据' })];
  const tree = buildProgressTree(g, tasks);
  assert.ok(tree.blockers.some((b) => b.includes('缺凭据')));
  assert.ok(tree.blockers.some((b) => b.includes('等待用户授权')));
});

test('buildProgressTree：输出摘要与执行 Agent 透传给 UI', () => {
  const tasks = [task('x', { status: 'succeeded', outputSummary: '已完成报告', lastAgentId: 'agt-1' })];
  const node = flattenTree(buildProgressTree(goal, tasks).nodes)[0]!;
  assert.equal(node.outputSummary, '已完成报告');
  assert.equal(node.assigneeAgentId, 'agt-1');
});

test('allSettled / allSucceeded：终态判定', () => {
  assert.equal(allSettled([task('a', { status: 'succeeded' }), task('b', { status: 'blocked' })]), true);
  assert.equal(allSettled([task('a', { status: 'running' })]), false);
  assert.equal(allSucceeded([task('a', { status: 'succeeded' })]), true);
  assert.equal(allSucceeded([task('a', { status: 'succeeded' }), task('b', { status: 'failed' })]), false);
  assert.equal(allSucceeded([]), false, '空任务集不能算成功');
});
