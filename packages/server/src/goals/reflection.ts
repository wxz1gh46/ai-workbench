/**
 * 反思（Reflection）与修正策略。
 *
 * 目标循环里最容易失控的两点：
 * 1) 失败任务无限重试 → 必须有明确的重试/换角色/换工具/请求授权的升级路径；
 * 2) 无进展空转 → 必须能检测「本轮没有任何任务状态变化」并停下来交还控制权。
 *
 * 本模块把这些策略做成纯函数，便于单测（不需要模型与数据库）。
 */
import type { AgentRole, Task, TaskStatus } from '@ai/shared';

export type CorrectionKind =
  | 'retry'
  | 'reassign'
  | 'switch-tool'
  | 'request-authorization'
  | 'give-up';

export interface Correction {
  taskId: string;
  kind: CorrectionKind;
  reason: string;
  /** 换角色时建议的新角色 */
  nextRole?: AgentRole;
  /** 换工具时建议加上的工具 */
  addTools?: string[];
}

export interface ReflectionInput {
  tasks: Task[];
  /** 本轮开始时的任务状态快照，用于检测「无进展」 */
  previousStatuses?: Map<string, TaskStatus>;
  /** 用户已授权危险操作 */
  userConfirmed?: boolean;
}

export interface ReflectionResult {
  corrections: Correction[];
  /** 本轮是否有任何任务状态发生变化 */
  progressed: boolean;
  /** 是否已陷入停滞（无进展且仍有未终态任务） */
  stalled: boolean;
  summary: string;
}

/** 角色兜底链：某角色失败时依次尝试的替代角色 */
const ROLE_FALLBACK: Partial<Record<AgentRole, AgentRole[]>> = {
  researcher: ['analyst', 'coordinator'],
  analyst: ['researcher', 'coordinator'],
  coder: ['analyst', 'coordinator'],
  writer: ['analyst', 'coordinator'],
  'file-ops': ['writer', 'coordinator'],
  deployer: ['coordinator'],
  planner: ['coordinator'],
  critic: ['coordinator'],
  coordinator: [],
};

export function reflect(input: ReflectionInput): ReflectionResult {
  const { tasks, previousStatuses } = input;
  const corrections: Correction[] = [];

  for (const task of tasks) {
    if (task.status === 'succeeded' || task.status === 'cancelled') continue;

    if (task.status === 'failed' || task.status === 'blocked') {
      const attempts = task.attempts;
      const canRetry = attempts < task.maxAttempts;

      // 依赖失败导致的阻塞不能靠重试解决，需要先修上游
      const blockedByDependency = task.status === 'blocked' && (task.error ?? '').includes('依赖任务');

      if (blockedByDependency) {
        corrections.push({
          taskId: task.id,
          kind: 'retry',
          reason: `上游依赖未成功，待上游修复后重新调度：${task.error ?? ''}`,
        });
        continue;
      }

      if (canRetry) {
        corrections.push({
          taskId: task.id,
          kind: 'retry',
          reason: `第 ${attempts + 1}/${task.maxAttempts} 次尝试：${task.error ?? '未知错误'}`,
        });
        continue;
      }

      // 重试用尽 → 升级：换角色 / 换工具 / 请求授权 / 放弃
      const fallbacks = ROLE_FALLBACK[task.agentRole] ?? ['coordinator'];
      const nextRole = fallbacks[0];
      const errorText = task.error ?? '';

      if (/需要用户确认|权限|授权|危险操作/.test(errorText) && !input.userConfirmed) {
        corrections.push({
          taskId: task.id,
          kind: 'request-authorization',
          reason: `任务需要用户授权后才能继续：${errorText}`,
        });
      } else if (/工具|tool|不存在|未注册/.test(errorText)) {
        corrections.push({
          taskId: task.id,
          kind: 'switch-tool',
          reason: `工具不可用，改用基础文件工具重试：${errorText}`,
          ...(nextRole ? { nextRole } : {}),
          addTools: task.tools.filter((t) => t !== 'office.generate').length > 0 ? [] : ['fs.write', 'fs.read'],
        });
      } else if (nextRole && nextRole !== task.agentRole) {
        corrections.push({
          taskId: task.id,
          kind: 'reassign',
          reason: `重试 ${task.maxAttempts} 次仍失败，改由 ${nextRole} 接手：${errorText}`,
          nextRole,
        });
      } else {
        corrections.push({
          taskId: task.id,
          kind: 'give-up',
          reason: `无法自动恢复，需人工介入：${errorText}`,
        });
      }
    }
  }

  // 进展检测：比较状态快照
  let progressed = true;
  if (previousStatuses && previousStatuses.size > 0) {
    progressed = tasks.some((t) => previousStatuses.get(t.id) !== t.status);
  }

  const unsettled = tasks.filter((t) => !['succeeded', 'failed', 'cancelled'].includes(t.status));
  const stalled = !progressed && unsettled.length > 0;

  const summary = [
    `本轮修正 ${corrections.length} 项`,
    progressed ? '有状态推进' : '无状态推进',
    stalled ? '已停滞，需交还控制权或请求人工介入' : '',
  ]
    .filter(Boolean)
    .join('；');

  return { corrections, progressed, stalled, summary };
}

/** 把修正策略转成可执行的动作描述（供日志/审计与 UI 展示） */
export function describeCorrection(c: Correction): string {
  switch (c.kind) {
    case 'retry':
      return `重试任务 ${c.taskId}：${c.reason}`;
    case 'reassign':
      return `改派任务 ${c.taskId} 给 ${c.nextRole ?? 'coordinator'}：${c.reason}`;
    case 'switch-tool':
      return `任务 ${c.taskId} 换工具 ${(c.addTools ?? []).join('/') || '基础工具'}：${c.reason}`;
    case 'request-authorization':
      return `任务 ${c.taskId} 等待用户授权：${c.reason}`;
    case 'give-up':
      return `任务 ${c.taskId} 放弃自动恢复：${c.reason}`;
  }
}
