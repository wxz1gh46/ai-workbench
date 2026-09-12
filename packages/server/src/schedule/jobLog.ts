import type { ScheduleRunRecord } from '@ai/shared';

/**
 * 任务日志工具（Step 5）。
 *
 * 目标：让「为什么这次没跑 / 为什么失败 / 重试了几次」一眼可查。
 * 日志包含：状态时间线、每次尝试的耗时、结构化结果摘要、错误原文。
 */

export interface JobLogLine {
  at: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

export function formatRunSummary(run: ScheduleRunRecord): string {
  const duration = run.finishedAt && run.startedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;
  const parts = [
    `状态：${run.status}`,
    `尝试：${run.attempt} 次（重试 ${run.retryCount}）`,
    `触发：${run.trigger === 'manual' ? '手动' : '定时'}`,
  ];
  if (duration !== null && Number.isFinite(duration)) parts.push(`耗时：${formatDuration(duration)}`);
  if (run.error) parts.push(`错误：${run.error}`);
  return parts.join(' · ');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** 生成执行时间线（UI 用） */
export function buildTimeline(runs: ScheduleRunRecord[], limit = 20): { at: string; status: ScheduleRunRecord['status']; label: string; ok: boolean }[] {
  return runs
    .slice(0, limit)
    .map((r) => ({
      at: r.finishedAt ?? r.startedAt,
      status: r.status,
      ok: r.status === 'succeeded',
      label: formatRunSummary(r),
    }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** 统计：成功率与平均耗时（用于任务卡片上的健康度） */
export function computeStats(runs: ScheduleRunRecord[]): { total: number; succeeded: number; failed: number; successRate: number; avgDurationMs: number } {
  const total = runs.length;
  const succeeded = runs.filter((r) => r.status === 'succeeded').length;
  const failed = runs.filter((r) => r.status === 'failed').length;
  const durations = runs
    .filter((r) => r.finishedAt)
    .map((r) => Date.parse(r.finishedAt as string) - Date.parse(r.startedAt))
    .filter((d) => Number.isFinite(d) && d >= 0);
  return {
    total,
    succeeded,
    failed,
    successRate: total === 0 ? 0 : Math.round((succeeded / total) * 100),
    avgDurationMs: durations.length === 0 ? 0 : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
  };
}
