import assert from 'node:assert/strict';
import test from 'node:test';
import { CRON_PRESETS, CronError, describe, nextRun, parseCron, validateCron, validateTimezone } from './cronParser.ts';
import { TASK_TEMPLATES, fillTemplate, getTemplate, validateTemplateValues } from './templates.ts';
import { JobRunner, isRetryable } from './jobRunner.ts';
import { computeDelay, normalizeRetry, shouldRetry, withRetry, DEFAULT_RETRY } from '../notify/retryPolicy.ts';
import { buildTimeline, computeStats, formatDuration, formatRunSummary } from './jobLog.ts';
import type { ScheduleTask } from '@ai/shared';

/* ================================================================== */
/* Cron 解析                                                           */
/* ================================================================== */

test('cron：5 段与 6 段都能解析', () => {
  const p5 = parseCron('*/5 * * * *');
  assert.equal(p5.hasSeconds, false);
  assert.deepEqual(p5.minutes, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  const p6 = parseCron('0 */5 * * * *');
  assert.equal(p6.hasSeconds, true);
  assert.deepEqual(p6.seconds, [0]);
});

test('cron：范围、列表、范围步长', () => {
  assert.deepEqual(parseCron('0 9 * * 1-5').daysOfWeek, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseCron('0 9 1,15 * *').daysOfMonth, [1, 15]);
  assert.deepEqual(parseCron('0-30/10 9 * * *').minutes, [0, 10, 20, 30]);
});

test('cron：别名 @daily 等', () => {
  assert.deepEqual(parseCron('@daily').hours, [0]);
  assert.deepEqual(parseCron('@hourly').minutes, [0]);
  assert.equal(parseCron('@weekly').daysOfWeek.length, 1);
});

test('cron：周日的 0 与 7 等价', () => {
  assert.deepEqual(parseCron('0 0 * * 7').daysOfWeek, [0]);
  assert.deepEqual(parseCron('0 0 * * 0').daysOfWeek, [0]);
});

test('cron：非法表达式全部被拒绝并给出可读原因', () => {
  const bad = [
    ['', /不能为空/],
    ['* * * *', /5 段/],
    ['* * * * * * *', /5 段/],
    ['60 * * * *', /越界/],
    ['0 25 * * *', /越界/],
    ['0 0 32 * *', /越界/],
    ['0 0 * 13 *', /越界/],
    ['0 5-1 * * *', /起点大于终点/],
    ['0 * * * abc', /无法解析/],
    ['0 */0 * * *', /步长/],
  ] as [string, RegExp][];
  for (const [expr, re] of bad) {
    try {
      parseCron(expr);
      assert.fail(`应拒绝: ${expr}`);
    } catch (e) {
      assert.ok(e instanceof CronError, `应为 CronError: ${expr}`);
      assert.match((e as Error).message, re, `错误信息不匹配: ${expr}`);
    }
  }
});

test('cron：validateCron 布尔语义', () => {
  assert.equal(validateCron('0 9 * * *'), true);
  assert.equal(validateCron('nope'), false);
});

test('cron：自然语言描述（避免用户误解"0 0 * * *"）', () => {
  assert.match(describe(parseCron('0 9 * * *')), /9 时/);
  assert.match(describe(parseCron('0 9 * * 1-5')), /周一/);
  assert.equal(describe(parseCron('* * * * *')), '每分钟执行一次');
  assert.ok(CRON_PRESETS.length >= 6);
  for (const p of CRON_PRESETS) assert.equal(validateCron(p.expression), true, `${p.label} 不合法`);
});

/* ================================================================== */
/* nextRun：时区与计算正确性                                            */
/* ================================================================== */

test('nextRun：每天 9 点（Asia/Shanghai）', () => {
  const from = new Date('2026-03-01T00:00:00+08:00');
  const next = nextRun('0 9 * * *', from, 'Asia/Shanghai');
  assert.equal(next.toISOString(), new Date('2026-03-01T09:00:00+08:00').toISOString());
});

test('nextRun：时区不同 → 同一表达式在不同时区触发时刻不同', () => {
  const from = new Date('2026-03-01T00:00:00Z');
  const sh = nextRun('0 9 * * *', from, 'Asia/Shanghai');
  const utc = nextRun('0 9 * * *', from, 'UTC');
  assert.notEqual(sh.toISOString(), utc.toISOString());
  assert.equal(utc.toISOString(), '2026-03-01T09:00:00.000Z');
});

test('nextRun：必须严格晚于 from（不能返回当前时刻）', () => {
  const exactly = new Date('2026-03-01T09:00:00+08:00');
  const next = nextRun('0 9 * * *', exactly, 'Asia/Shanghai');
  assert.ok(next.getTime() > exactly.getTime());
  assert.equal(next.toISOString(), new Date('2026-03-02T09:00:00+08:00').toISOString());
});

test('nextRun：工作日表达式跳过周末', () => {
  // 2026-03-06 是周五
  const friday = new Date('2026-03-06T10:00:00+08:00');
  const next = nextRun('0 9 * * 1-5', friday, 'Asia/Shanghai');
  // 下一个工作日是周一 3/9
  assert.equal(next.toISOString(), new Date('2026-03-09T09:00:00+08:00').toISOString());
});

test('nextRun：每 5 分钟', () => {
  const from = new Date('2026-03-01T00:02:00+08:00');
  const next = nextRun('*/5 * * * *', from, 'Asia/Shanghai');
  assert.equal(next.toISOString(), new Date('2026-03-01T00:05:00+08:00').toISOString());
});

test('nextRun：6 段带秒', () => {
  const from = new Date('2026-03-01T00:00:00+08:00');
  const next = nextRun('*/30 * * * * *', from, 'Asia/Shanghai');
  assert.equal(next.getTime() - from.getTime(), 30_000);
});

test('nextRun：非法时区被拒绝', () => {
  assert.equal(validateTimezone('Asia/Shanghai'), true);
  assert.equal(validateTimezone('UTC'), true);
  assert.equal(validateTimezone('Mars/Olympus'), false);
  assert.throws(() => nextRun('0 9 * * *', new Date(), 'Not/AZone'), /无效的时区/);
});

/* ================================================================== */
/* 任务模板                                                            */
/* ================================================================== */

test('任务模板：覆盖 6 种任务类型且 cron 合法', () => {
  const types = new Set(TASK_TEMPLATES.map((t) => t.taskType));
  for (const t of ['goal', 'research', 'office', 'deploy', 'db-query', 'custom']) {
    assert.ok(types.has(t as never), `缺少 ${t} 模板`);
  }
  for (const tpl of TASK_TEMPLATES) {
    assert.equal(validateCron(tpl.suggestedCron), true, `${tpl.name} 的 cron 不合法`);
    assert.ok(tpl.placeholders.every((p) => p.label && p.key));
  }
});

test('任务模板：填充占位符并保留未提供的字段', () => {
  const tpl = getTemplate('daily-research');
  assert.ok(tpl);
  const filled = fillTemplate(tpl, { topic: '储能行业' });
  assert.equal(filled.topic, '储能行业');
  assert.equal(filled.depth, 'standard');
  assert.deepEqual(filled.outputFormats, ['markdown', 'pdf', 'pptx']);
});

test('任务模板：必填占位符缺失时被拦住', () => {
  const tpl = getTemplate('daily-research');
  assert.ok(tpl);
  assert.deepEqual(validateTemplateValues(tpl, {}), ['研究主题(topic)']);
  assert.deepEqual(validateTemplateValues(tpl, { topic: 'x' }), []);
  assert.equal(getTemplate('nope'), null);
});

/* ================================================================== */
/* 执行器：未注入依赖 / 参数缺失 / SQL 安全                             */
/* ================================================================== */

function makeTask(overrides: Partial<ScheduleTask> = {}): ScheduleTask {
  return {
    id: 'sch1',
    workspaceId: 'ws1',
    name: 't',
    trigger: 'cron',
    expression: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    taskType: 'goal',
    taskConfig: {},
    template: null,
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    retryPolicy: { ...DEFAULT_RETRY },
    channelIds: [],
    concurrency: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('执行器：未注入依赖时显式降级（不假装成功）', async () => {
  const runner = new JobRunner(null as never, {});
  for (const type of ['goal', 'research', 'office', 'deploy', 'db-query'] as const) {
    const res = await runner.execute(makeTask({ taskType: type, taskConfig: { objective: 'x', topic: 'x', content: 'x', websiteProjectId: 'x', sql: 'select 1', connectionId: 'x' } }));
    assert.equal(res.ok, false, `${type} 应失败`);
    assert.equal(res.degraded, true, `${type} 应标记 degraded`);
  }
});

test('执行器：缺少必要参数时给出字段名（参数校验先于依赖检查）', async () => {
  const runner = new JobRunner(null as never, {});
  const res = await runner.execute(makeTask({ taskType: 'goal', taskConfig: {} }));
  assert.match(res.summary, /objective/);
  assert.equal(res.retryable, false);
});

test('执行器：缺少参数时不依赖 deps（尽早失败，避免无效重试）', async () => {
  let touched = false;
  const runner = new JobRunner(null as never, {
    runGoal: async () => {
      touched = true;
      return { goalId: 'g', status: 'completed', progress: 100 };
    },
  });
  const res = await runner.execute(makeTask({ taskType: 'goal', taskConfig: {} }));
  assert.equal(res.ok, false);
  assert.equal(touched, false, '参数缺失时不应触发真实执行');
});

test('执行器：定时任务里的写 SQL 被拒绝（双重保险）', async () => {
  let called = false;
  const runner = new JobRunner(null as never, {
    runQuery: async () => {
      called = true;
      return { columns: [], rows: [], rowCount: 0 };
    },
  });
  const res = await runner.execute(makeTask({ taskType: 'db-query', taskConfig: { connectionId: 'c1', sql: 'delete from users' } }));
  assert.equal(res.ok, false);
  assert.equal(called, false, '危险 SQL 不应触达执行器');
  assert.match(res.summary, /只读/);
});

test('执行器：goal 成功与失败判定', async () => {
  const ok = new JobRunner(null as never, {
    runGoal: async () => ({ goalId: 'g1', status: 'completed', progress: 100 }),
  });
  const r1 = await ok.execute(makeTask({ taskConfig: { objective: 'x' } }));
  assert.equal(r1.ok, true);
  assert.match(r1.summary, /100%/);

  const fail = new JobRunner(null as never, {
    runGoal: async () => ({ goalId: 'g2', status: 'failed', progress: 20 }),
  });
  const r2 = await fail.execute(makeTask({ taskConfig: { objective: 'x' } }));
  assert.equal(r2.ok, false);
  assert.equal(r2.retryable, true);
});

test('执行器：custom 任务成功且不产生副作用', async () => {
  const runner = new JobRunner(null as never, {});
  const res = await runner.execute(makeTask({ taskType: 'custom', taskConfig: { payload: { a: 1 } } }));
  assert.equal(res.ok, true);
  assert.deepEqual((res.data as { payload: unknown }).payload, { a: 1 });
});

test('执行器：可重试性判定（网络类重试，参数类不重试）', () => {
  assert.equal(isRetryable(new Error('fetch failed')), true);
  assert.equal(isRetryable(new Error('ETIMEDOUT')), true);
  assert.equal(isRetryable(new Error('429 Too Many Requests')), true);
  assert.equal(isRetryable(new Error('invalid api key')), false);
  assert.equal(isRetryable(new Error('缺少 topic 参数')), false);
  assert.equal(isRetryable(new Error('缺少 topic 参数')), false);
});

/* ================================================================== */
/* 重试策略（指数退避）                                                 */
/* ================================================================== */

test('重试策略：退避按指数增长且不超过上限', () => {
  const norm = normalizeRetry({ maxRetry: 4, baseDelayMs: 1000, factor: 2, maxDelayMs: 10_000 });
  const d1 = computeDelay(1, norm);
  const d2 = computeDelay(2, norm);
  const d3 = computeDelay(3, norm);
  assert.ok(d1 >= 800 && d1 <= 1200, `抖动范围异常: ${d1}`);
  assert.ok(d2 >= 1600 && d2 <= 2400);
  assert.ok(d3 >= 3200 && d3 <= 4800);
  // 超过上限时必须被截断
  const dBig = computeDelay(10, norm);
  assert.ok(dBig <= 12_000, `应被 maxDelayMs 截断: ${dBig}`);
});

test('重试策略：参数被规范化（防止负值/超大值）', () => {
  const norm = normalizeRetry({ maxRetry: -5, baseDelayMs: -1, factor: 999, maxDelayMs: 1e12 });
  assert.equal(norm.maxRetry, 0);
  assert.ok(norm.baseDelayMs >= 100);
  assert.ok(norm.factor <= 10);
  assert.ok(norm.maxDelayMs <= 3_600_000);
  // maxRetry=0 表示「不重试」：第一次尝试（attempt=1）就不应再重试
  assert.equal(shouldRetry(1, norm), false);
  assert.equal(shouldRetry(1, normalizeRetry({ maxRetry: 2 })), true);
});

test('重试策略：最终成功时重试次数正确', async () => {
  let n = 0;
  const { value, attempts } = await withRetry(
    async () => {
      n += 1;
      if (n < 3) throw new Error('fetch failed');
      return 'ok';
    },
    { maxRetry: 5, baseDelayMs: 1, factor: 1, maxDelayMs: 5 },
  );
  assert.equal(value, 'ok');
  assert.equal(attempts, 3);
});

test('重试策略：超过上限后抛出最后一个错误', async () => {
  let n = 0;
  await assert.rejects(
    withRetry(
      async () => {
        n += 1;
        throw new Error('always fails');
      },
      { maxRetry: 2, baseDelayMs: 1, factor: 1, maxDelayMs: 5 },
    ),
    /always fails/,
  );
  assert.equal(n, 3, '应尝试 maxRetry+1 次');
});

test('重试策略：onRetry 回调每次重试都被调用（用于写审计）', async () => {
  const events: number[] = [];
  await assert.rejects(
    withRetry(async () => { throw new Error('x'); }, { maxRetry: 2, baseDelayMs: 1, factor: 1, maxDelayMs: 5 }, (i) => events.push(i.attempt)),
  );
  assert.deepEqual(events, [1, 2]);
});

/* ================================================================== */
/* 任务日志                                                            */
/* ================================================================== */

test('任务日志：摘要包含状态/尝试/触发源/耗时', () => {
  const run = {
    id: 'r1',
    scheduleId: 's1',
    status: 'succeeded' as const,
    attempt: 2,
    retryCount: 1,
    log: '',
    result: {},
    error: null,
    trigger: 'manual' as const,
    startedAt: '2026-03-01T00:00:00.000Z',
    finishedAt: '2026-03-01T00:00:03.000Z',
  };
  const summary = formatRunSummary(run);
  assert.match(summary, /succeeded/);
  assert.match(summary, /2 次/);
  assert.match(summary, /手动/);
  assert.match(summary, /3\.0s/);
});

test('任务日志：耗时格式化', () => {
  assert.equal(formatDuration(500), '500ms');
  assert.equal(formatDuration(1500), '1.5s');
  assert.equal(formatDuration(65_000), '1m5s');
});

test('任务日志：统计成功率与平均耗时', () => {
  const runs = [
    { id: '1', scheduleId: 's', status: 'succeeded' as const, attempt: 1, retryCount: 0, log: '', result: null, error: null, trigger: 'auto' as const, startedAt: '2026-03-01T00:00:00.000Z', finishedAt: '2026-03-01T00:00:02.000Z' },
    { id: '2', scheduleId: 's', status: 'failed' as const, attempt: 1, retryCount: 0, log: '', result: null, error: 'x', trigger: 'auto' as const, startedAt: '2026-03-01T00:00:00.000Z', finishedAt: '2026-03-01T00:00:04.000Z' },
    { id: '3', scheduleId: 's', status: 'succeeded' as const, attempt: 1, retryCount: 0, log: '', result: null, error: null, trigger: 'auto' as const, startedAt: '2026-03-01T00:00:00.000Z', finishedAt: '2026-03-01T00:00:06.000Z' },
  ];
  const stats = computeStats(runs);
  assert.equal(stats.total, 3);
  assert.equal(stats.succeeded, 2);
  assert.equal(stats.failed, 1);
  assert.equal(stats.successRate, 67);
  assert.equal(stats.avgDurationMs, 4000);
});

test('任务日志：时间线按时间倒序', () => {
  const runs = [
    { id: '1', scheduleId: 's', status: 'succeeded' as const, attempt: 1, retryCount: 0, log: '', result: null, error: null, trigger: 'auto' as const, startedAt: '2026-03-01T00:00:00.000Z', finishedAt: '2026-03-01T00:00:01.000Z' },
    { id: '2', scheduleId: 's', status: 'failed' as const, attempt: 1, retryCount: 0, log: '', result: null, error: 'x', trigger: 'auto' as const, startedAt: '2026-03-02T00:00:00.000Z', finishedAt: '2026-03-02T00:00:01.000Z' },
  ];
  const tl = buildTimeline(runs);
  assert.equal(tl[0]?.status, 'failed');
  assert.equal(tl[1]?.ok, true);
});
