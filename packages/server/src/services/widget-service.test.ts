import assert from 'node:assert/strict';
import test from 'node:test';
import { inferWidget } from './widget-service.ts';

test('任务相关描述映射到 task-progress', () => {
  assert.equal(inferWidget('显示所有任务进度').type, 'task-progress');
});

test('Agent 描述映射到 agent-status', () => {
  assert.equal(inferWidget('看下集群里每个 Agent 的状态').type, 'agent-status');
});

test('无匹配时回落 task-progress', () => {
  assert.equal(inferWidget('随便来点什么吧').type, 'task-progress');
  assert.deepEqual(inferWidget('网站是否在线').config, { websiteId: null });
});
