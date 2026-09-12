import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task, TaskStatus } from '@ai/shared';
import { describeCorrection, reflect } from './reflection.ts';

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

test('reflect：未超重试上限 → 重试', () => {
  const r = reflect({ tasks: [task('a', { status: 'failed', attempts: 1, maxAttempts: 3, error: '超时' })] });
  assert.equal(r.corrections.length, 1);
  assert.equal(r.corrections[0]!.kind, 'retry');
});

test('reflect：重试用尽 + 普通错误 → 换角色', () => {
  const r = reflect({ tasks: [task('a', { status: 'failed', attempts: 3, maxAttempts: 3, agentRole: 'coder', error: '编译失败' })] });
  assert.equal(r.corrections[0]!.kind, 'reassign');
  assert.ok(r.corrections[0]!.nextRole);
});

test('reflect：权限类错误 → 请求用户授权（不自动重试）', () => {
  const r = reflect({ tasks: [task('a', { status: 'failed', attempts: 3, maxAttempts: 3, error: '危险操作需用户确认: website.deploy' })] });
  assert.equal(r.corrections[0]!.kind, 'request-authorization');
});

test('reflect：工具缺失 → 换工具', () => {
  const r = reflect({ tasks: [task('a', { status: 'failed', attempts: 3, maxAttempts: 3, error: '工具不存在: office.generate' })] });
  assert.equal(r.corrections[0]!.kind, 'switch-tool');
  assert.ok((r.corrections[0]!.addTools ?? []).length > 0);
});

test('reflect：依赖失败导致的阻塞不应被无脑重试', () => {
  const r = reflect({ tasks: [task('a', { status: 'blocked', attempts: 0, error: '依赖任务 t1 状态为 failed' })] });
  assert.equal(r.corrections.length, 1);
  assert.ok(r.corrections[0]!.reason.includes('上游依赖'));
});

test('reflect：已授权时权限错误不再请求授权', () => {
  const r = reflect({
    tasks: [task('a', { status: 'failed', attempts: 3, maxAttempts: 3, error: '需要用户确认' })],
    userConfirmed: true,
  });
  assert.notEqual(r.corrections[0]!.kind, 'request-authorization');
});

test('reflect：停滞检测 —— 状态无变化且仍有未终态任务', () => {
  const tasks = [task('a', { status: 'pending' }), task('b', { status: 'ready' })];
  const previous = new Map<string, TaskStatus>([['a', 'pending'], ['b', 'ready']]);
  const r = reflect({ tasks, previousStatuses: previous });
  assert.equal(r.progressed, false);
  assert.equal(r.stalled, true);
});

test('reflect：有状态变化时不算停滞', () => {
  const tasks = [task('a', { status: 'succeeded' })];
  const previous = new Map<string, TaskStatus>([['a', 'running']]);
  const r = reflect({ tasks, previousStatuses: previous });
  assert.equal(r.progressed, true);
  assert.equal(r.stalled, false);
});

test('reflect：全部终态时不判定停滞', () => {
  const tasks = [task('a', { status: 'succeeded' }), task('b', { status: 'failed' })];
  const previous = new Map<string, TaskStatus>([['a', 'succeeded'], ['b', 'failed']]);
  const r = reflect({ tasks, previousStatuses: previous });
  assert.equal(r.stalled, false, '已全部终态不该说“停滞”');
});

test('describeCorrection：每种修正都有可读描述', () => {
  for (const kind of ['retry', 'reassign', 'switch-tool', 'request-authorization', 'give-up'] as const) {
    const text = describeCorrection({ taskId: 't1', kind, reason: '原因' });
    assert.ok(text.length > 0);
    assert.ok(text.includes('t1'));
  }
});
