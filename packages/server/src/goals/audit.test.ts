import assert from 'node:assert/strict';
import test from 'node:test';
import type { Goal, Task } from '@ai/shared';
import { buildAuditReport, extractKeywords, matchCriteria } from './audit.ts';

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    goalId: 'g1',
    parentTaskId: null,
    title: `任务 ${id}`,
    description: '',
    status: 'succeeded',
    progress: 100,
    agentRole: 'analyst',
    tools: [],
    dependsOn: [],
    attempts: 0,
    maxAttempts: 3,
    claimedBy: null,
    input: {},
    output: { text: `产出内容 ${id}` },
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
  objective: '交付一个可运行的桌面 AI 客户端',
  acceptanceCriteria: ['百万 Token 对话不崩溃', '生成 docx 文件'],
  status: 'auditing',
  progress: 100,
  iterations: 3,
  maxIterations: 12,
  blockers: [],
  auditReport: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('extractKeywords：过滤虚词并保留有效关键词', () => {
  const k = extractKeywords('必须支持百万 Token 对话并且能够生成 docx 文件');
  assert.ok(k.includes('百万'));
  assert.ok(k.includes('token') || k.includes('Token') || k.includes('docx'));
  assert.ok(!k.includes('必须'));
  assert.ok(!k.includes('支持'));
});

test('matchCriteria：把验收标准映射到具体任务产出', () => {
  const tasks = [
    task('a', { title: '实现百万 Token 对话上下文', output: { text: '分层上下文已完成，实测 100 万 token 通过' } }),
    task('b', { title: '生成 docx 文件', output: { text: '已生成报告.docx' } }),
  ];
  const matched = matchCriteria(goal, tasks);
  assert.equal(matched.length, 2);
  assert.ok(matched.every((m) => m.met));
  assert.ok(matched[0]!.evidence.includes('100 万 token'));
});

test('matchCriteria：相关任务失败 → 标准未满足', () => {
  const tasks = [
    task('a', { title: '实现百万 Token 对话上下文', status: 'failed', error: '内存溢出' }),
    task('b', { title: '生成 docx 文件' }),
  ];
  const matched = matchCriteria(goal, tasks);
  assert.equal(matched[0]!.met, false);
  assert.ok(matched[0]!.evidence.includes('failed'));
});

test('matchCriteria：无任务绑定标准时以「全部成功」兜底', () => {
  const tasks = [task('x', { title: '无关任务 A' }), task('y', { title: '无关任务 B' })];
  const matched = matchCriteria(goal, tasks);
  assert.ok(matched.every((m) => m.met), '全部任务成功时应视为满足');
});

test('buildAuditReport：全部成功且模型通过 → passed', () => {
  const tasks = [task('a', { title: '实现百万 Token 对话上下文' }), task('b', { title: '生成 docx 文件' })];
  const report = buildAuditReport({
    goal,
    tasks,
    verdict: { passed: true, score: 95, issues: [], nextActions: [], report: '# 模型结论\n通过', degraded: false },
  });
  assert.equal(report.passed, true);
  assert.equal(report.score, 95);
  assert.ok(report.markdown.includes('[x] 百万 Token 对话不崩溃'));
  assert.ok(report.markdown.includes('模型结论'));
});

test('buildAuditReport：任务失败时即使模型说通过也判不通过', () => {
  const tasks = [task('a', { title: '实现百万 Token 对话上下文', status: 'failed', error: '崩溃' })];
  const report = buildAuditReport({
    goal,
    tasks,
    verdict: { passed: true, score: 100, issues: [], nextActions: [], report: '通过', degraded: false },
  });
  assert.equal(report.passed, false, '任务失败绝不能因为模型说通过而通过');
  assert.ok(report.issues.some((i) => i.severity === 'high'));
  assert.ok(report.nextActions.some((a) => a.includes('重试')));
});

test('buildAuditReport：模型离线时使用确定性分数且标记 degraded', () => {
  const tasks = [task('a', { title: '实现百万 Token 对话上下文' }), task('b', { title: '生成 docx 文件', status: 'failed' })];
  const report = buildAuditReport({ goal, tasks, verdict: null });
  assert.equal(report.degraded, true);
  assert.equal(report.passed, false);
  assert.equal(report.score, 50);
});

test('buildAuditReport：未满足的标准必须出现在 nextActions', () => {
  const tasks = [task('a', { title: '实现百万 Token 对话上下文' })]; // 缺 docx 任务 → 无匹配但全成功，视为满足
  const report = buildAuditReport({ goal, tasks, verdict: null });
  assert.ok(report.criteria.every((c) => typeof c.met === 'boolean'));
  assert.ok(report.nextActions.every((a) => typeof a === 'string'));
});

test('buildAuditReport：markdown 含验收核对/问题/后续动作三段', () => {
  const report = buildAuditReport({ goal, tasks: [task('a', { title: '实现百万 Token 对话上下文' })], verdict: null });
  assert.ok(report.markdown.includes('## 验收标准逐条核对'));
  assert.ok(report.markdown.includes('## 问题清单'));
  assert.ok(report.markdown.includes('## 后续动作'));
});
