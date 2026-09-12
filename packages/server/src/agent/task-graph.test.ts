import assert from 'node:assert/strict';
import test from 'node:test';
import { computeProgress, detectCycle, resolveBlocked, resolveReady, topoSort } from './task-graph.ts';
import type { DagNode } from './task-graph.ts';

const n = (
  id: string,
  dependsOn: string[] = [],
  status: DagNode['status'] = 'pending',
): DagNode => ({ id, dependsOn, status });

test('resolveReady 只放行依赖已成功的任务', () => {
  const nodes = [n('a', [], 'succeeded'), n('b', ['a']), n('c', ['b']), n('d', ['x'])];
  assert.deepEqual(resolveReady(nodes), ['b']);
});

test('resolveReady 包含 ready 状态且依赖已满足的任务', () => {
  const nodes = [n('a', [], 'ready'), n('b', ['a']), n('c', ['x'], 'succeeded')];
  assert.deepEqual(resolveReady(nodes), ['a']);
});

test('resolveReady 不重复放行 running/succeeded/failed', () => {
  const nodes = [n('a', [], 'running'), n('b', [], 'succeeded'), n('c', [], 'failed'), n('d', [], 'cancelled')];
  assert.deepEqual(resolveReady(nodes), []);
});

test('resolveBlocked 标记依赖失败的任务', () => {
  const nodes = [n('a', [], 'failed'), n('b', ['a']), n('c', ['b'])];
  const blocked = resolveBlocked(nodes);
  assert.equal(blocked.length, 1);
  assert.match(blocked[0]!.reason, /a/);
});

test('detectCycle 可发现环且无环时返回 null', () => {
  const cycle = detectCycle([n('a', ['b']), n('b', ['a'])]);
  assert.ok(Array.isArray(cycle) && cycle.length >= 2);
  assert.equal(detectCycle([n('a'), n('b', ['a']), n('c', ['b'])]), null);
});

test('topoSort 保证依赖在前', () => {
  const order = topoSort([n('c', ['b']), n('a'), n('b', ['a'])]);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('computeProgress 按任务状态加权', () => {
  assert.equal(computeProgress([]), 0);
  assert.equal(computeProgress([n('a', [], 'succeeded'), n('b')]), 50);
  assert.equal(computeProgress([n('a', [], 'succeeded'), n('b', [], 'running')]), 75);
});
