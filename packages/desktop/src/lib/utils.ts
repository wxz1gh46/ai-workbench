import type { Task } from '@ai/shared';

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const TASK_LABELS: Record<Task['status'], string> = {
  pending: '待排期',
  ready: '就绪',
  running: '执行中',
  blocked: '阻塞',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export function taskStatusLabel(status: Task['status']): string {
  return TASK_LABELS[status] ?? status;
}

export function taskStatusColor(status: Task['status']): string {
  switch (status) {
    case 'succeeded':
      return 'text-emerald-400';
    case 'running':
      return 'text-brand';
    case 'failed':
      return 'text-rose-400';
    case 'blocked':
      return 'text-amber-400';
    default:
      return 'text-muted';
  }
}

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

/** 危险操作二次确认文案，统一提示风格 */
export function confirmDanger(action: string, detail: string): boolean {
  return window.confirm(`⚠️ 危险操作：${action}\n\n${detail}\n\n确认执行？`);
}
