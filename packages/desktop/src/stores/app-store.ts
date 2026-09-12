import { create } from 'zustand';
import type { Agent, AppEvent, Goal, LogLine, Task, Workspace } from '@ai/shared';
import { api, ApiError } from '@/lib/api';
import { EventStream } from '@/lib/events';

export interface Toast {
  id: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

interface AppState {
  ready: boolean;
  error: string | null;
  degraded: boolean;
  workspace: Workspace | null;
  agents: Agent[];
  goals: Goal[];
  activeGoal: Goal | null;
  tasks: Task[];
  logs: LogLine[];
  toasts: Toast[];
  /** 由 WS 推送的实时 Agent 状态，覆盖 DB 快照 */
  agentStatus: Record<string, { status: Agent['status']; currentTaskId: string | null }>;

  init(): Promise<void>;
  refreshWorkspace(): Promise<void>;
  setWorkspaceRoot(rootPath: string | null): Promise<void>;
  createGoal(objective: string, autoRun: boolean): Promise<void>;
  advanceGoal(): Promise<void>;
  runGoal(): Promise<void>;
  selectGoal(id: string): Promise<void>;
  cancelTask(id: string): Promise<void>;
  pushToast(t: Omit<Toast, 'id'>): void;
  dismissToast(id: string): void;
}

let stream: EventStream | null = null;

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  error: null,
  degraded: false,
  workspace: null,
  agents: [],
  goals: [],
  activeGoal: null,
  tasks: [],
  logs: [],
  toasts: [],
  agentStatus: {},

  async init() {
    try {
      const health = await api.health();
      const { workspace } = await api.bootstrap();
      const { agents } = await api.listAgents(workspace.id);
      set({ ready: true, workspace, agents, degraded: health.degraded, error: null });

      stream?.close();
      stream = new EventStream(workspace.id);
      stream.on((e) => applyEvent(e, set, get));
      stream.connect();

      await get().refreshWorkspace();
      if (health.degraded) {
        get().pushToast({ level: 'warn', message: '未配置 AI_API_KEY，当前为离线兜底模式（流程可跑通，内容为占位）' });
      }
    } catch (e) {
      set({ ready: true, error: describeError(e) });
    }
  },

  async refreshWorkspace() {
    const ws = get().workspace;
    if (!ws) return;
    const { goals } = await api.listGoals(ws.id);
    set({ goals });
    const active = get().activeGoal;
    if (active) {
      const detail = await api.getGoal(active.id);
      set({ activeGoal: detail.goal, tasks: detail.tasks });
    } else if (goals[0]) {
      await get().selectGoal(goals[0].id);
    }
  },

  async setWorkspaceRoot(rootPath) {
    const ws = get().workspace;
    if (!ws) return;
    const { workspace } = await api.setWorkspaceRoot(ws.id, rootPath);
    set({ workspace });
    get().pushToast({ level: 'success', message: `工作目录已更新：${rootPath ?? '（未设置）'}` });
  },

  async createGoal(objective, autoRun) {
    const ws = get().workspace;
    if (!ws) return;
    try {
      const res = await api.createGoal(ws.id, objective, autoRun);
      set({ activeGoal: res.goal, tasks: res.tasks, agents: res.agents });
      await get().refreshWorkspace();
      get().pushToast({ level: 'success', message: `目标已创建，拆解出 ${res.tasks.length} 个任务` });
    } catch (e) {
      get().pushToast({ level: 'error', message: describeError(e) });
    }
  },

  async advanceGoal() {
    const goal = get().activeGoal;
    if (!goal) return;
    try {
      const res = await api.advanceGoal(goal.id);
      set({ activeGoal: res.goal, tasks: res.tasks });
    } catch (e) {
      get().pushToast({ level: 'error', message: describeError(e) });
    }
  },

  async runGoal() {
    const goal = get().activeGoal;
    if (!goal) return;
    try {
      const res = await api.runGoal(goal.id);
      set({ activeGoal: res.goal, tasks: res.tasks });
      get().pushToast({
        level: res.finished ? 'success' : 'info',
        message: res.finished ? '目标已完成并通过审计' : `推进到第 ${res.goal.iterations} 轮，当前进度 ${res.goal.progress}%`,
      });
    } catch (e) {
      get().pushToast({ level: 'error', message: describeError(e) });
    }
  },

  async selectGoal(id) {
    const detail = await api.getGoal(id);
    set({ activeGoal: detail.goal, tasks: detail.tasks });
  },

  async cancelTask(id) {
    try {
      await api.cancelTask(id);
      const goal = get().activeGoal;
      if (goal) await get().selectGoal(goal.id);
      get().pushToast({ level: 'info', message: '任务已取消' });
    } catch (e) {
      get().pushToast({ level: 'error', message: describeError(e) });
    }
  },

  pushToast(t) {
    const id = Math.random().toString(36).slice(2);
    set({ toasts: [...get().toasts, { ...t, id }] });
    setTimeout(() => get().dismissToast(id), 6000);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((x) => x.id !== id) });
  },
}));

export function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.message}（${e.code}）`;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 事件 → 状态。集中处理，避免组件各自订阅造成状态不一致。 */
function applyEvent(
  e: AppEvent,
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): void {
  const payload = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'task.updated': {
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === payload.taskId ? { ...t, status: (payload.status as Task['status']) ?? t.status, progress: Number(payload.progress ?? t.progress) } : t,
        ),
      }));
      break;
    }
    case 'agent.status': {
      const agentId = String(payload.agentId ?? '');
      if (!agentId) break;
      set((s) => ({
        agentStatus: {
          ...s.agentStatus,
          [agentId]: {
            status: (payload.status as Agent['status']) ?? 'idle',
            currentTaskId: (payload.currentTaskId as string | null) ?? null,
          },
        },
      }));
      break;
    }
    case 'goal.updated': {
      const goalId = String(payload.goalId ?? '');
      set((s) => ({
        activeGoal:
          s.activeGoal && s.activeGoal.id === goalId
            ? {
                ...s.activeGoal,
                status: (payload.status as Goal['status']) ?? s.activeGoal.status,
                progress: Number(payload.progress ?? s.activeGoal.progress),
                iterations: Number(payload.iterations ?? s.activeGoal.iterations),
              }
            : s.activeGoal,
      }));
      break;
    }
    case 'log': {
      const line = payload as unknown as LogLine;
      set((s) => ({ logs: [...s.logs.slice(-299), line] }));
      break;
    }
    default: {
      // 其余事件仅进入日志流，供右侧面板展示
      set((s) => ({
        logs: [
          ...s.logs.slice(-299),
          { level: 'info', msg: `[${e.type}] ${JSON.stringify(payload).slice(0, 200)}`, at: e.at },
        ],
      }));
      void get;
    }
  }
}
