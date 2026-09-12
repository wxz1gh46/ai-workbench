import { isDangerousAction } from '@ai/shared';
import type { AgentRole } from '@ai/shared';
import { modelRouter } from './model-router.ts';
import { logger } from '../utils/logger.ts';

export interface PlannedTask {
  key: string;
  title: string;
  description: string;
  agentRole: AgentRole;
  dependsOn: string[];
  tools: string[];
  dangerous: boolean;
}

export interface Plan {
  acceptanceCriteria: string[];
  tasks: PlannedTask[];
  degraded: boolean;
}

const VALID_ROLES: AgentRole[] = [
  'coordinator',
  'planner',
  'researcher',
  'analyst',
  'coder',
  'writer',
  'file-ops',
  'deployer',
  'critic',
];

const PLANNER_SYSTEM = `你是规划 Agent。把用户目标拆解为带依赖关系的任务 DAG。
只输出 JSON，结构：
{"acceptanceCriteria":["..."],"tasks":[{"key":"t1","title":"...","description":"...","agentRole":"researcher|analyst|coder|writer|file-ops|deployer|critic","dependsOn":["t0"],"tools":["fs.read"]}]}
规则：
- 任务数 3~12 个，粒度可独立验收
- dependsOn 只能引用已出现的 key，禁止成环
- 涉及部署/删除/付费 API 的任务必须单独拆出，agentRole 用 deployer
- 不要输出 JSON 以外的任何内容`;

/** 解析模型返回的 JSON，容忍 markdown 代码块包裹 */
export function parsePlan(raw: string): { acceptanceCriteria: string[]; tasks: PlannedTask[] } {
  const cleaned = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('规划结果不是合法 JSON');
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
    __degraded?: unknown;
    acceptanceCriteria?: unknown;
    tasks?: unknown;
  };
  if (parsed.__degraded === true) throw new Error('模型处于离线兜底模式，无法生成计划');
  const criteria = Array.isArray(parsed.acceptanceCriteria)
    ? parsed.acceptanceCriteria.filter((x): x is string => typeof x === 'string')
    : [];
  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const tasks: PlannedTask[] = rawTasks
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .map((t, i) => {
      const role = String(t.agentRole ?? 'analyst') as AgentRole;
      const key = String(t.key ?? `t${i + 1}`);
      const deps = Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [];
      return {
        key,
        title: String(t.title ?? `任务 ${i + 1}`).slice(0, 200),
        description: String(t.description ?? '').slice(0, 2000),
        agentRole: VALID_ROLES.includes(role) ? role : 'analyst',
        dependsOn: deps.filter((d) => d !== key),
        tools: Array.isArray(t.tools) ? t.tools.map(String) : [],
        dangerous: deps.some((d) => isDangerousAction(d)),
      };
    });
  return { acceptanceCriteria: criteria, tasks };
}

/**
 * 目标解析 + 计划生成。
 * 无模型密钥时给出确定性的最小可用计划，保证流程完整体验。
 */
export async function createPlan(objective: string, explicitCriteria?: string[]): Promise<Plan> {
  const res = await modelRouter.chat({
    messages: [
      { role: 'system', content: PLANNER_SYSTEM },
      { role: 'user', content: objective },
    ],
    jsonMode: true,
    temperature: 0.2,
  });

  try {
    const { acceptanceCriteria, tasks } = parsePlan(res.content);
    if (tasks.length === 0) throw new Error('规划结果为空');
    return {
      acceptanceCriteria: explicitCriteria?.length ? explicitCriteria : acceptanceCriteria,
      tasks,
      degraded: res.degraded,
    };
  } catch (e) {
    logger.warn('plan parse failed, fallback to default skeleton', {
      error: e instanceof Error ? e.message : String(e),
    });
    return { ...defaultPlan(objective, explicitCriteria), degraded: true };
  }
}

/** 离线兜底计划：覆盖「调研 → 分析 → 产出 → 审计」最小闭环 */
export function defaultPlan(objective: string, explicitCriteria?: string[]): { acceptanceCriteria: string[]; tasks: PlannedTask[] } {
  return {
    acceptanceCriteria: explicitCriteria?.length
      ? explicitCriteria
      : [`围绕目标产出可交付成果：${objective.slice(0, 80)}`, '成果可追溯来源', '通过评审 Agent 的完成审计'],
    tasks: [
      {
        key: 't1',
        title: '信息收集与整理',
        description: '收集与目标相关的资料，列出关键事实与来源。',
        agentRole: 'researcher',
        dependsOn: [],
        tools: ['fs.read', 'fs.list'],
        dangerous: false,
      },
      {
        key: 't2',
        title: '分析与结论推导',
        description: '基于 t1 的素材做分析，给出结论与假设。',
        agentRole: 'analyst',
        dependsOn: ['t1'],
        tools: ['fs.read'],
        dangerous: false,
      },
      {
        key: 't3',
        title: '产出交付物',
        description: '把结论写成结构化报告并生成 docx。',
        agentRole: 'writer',
        dependsOn: ['t2'],
        tools: ['office.generate'],
        dangerous: false,
      },
      {
        key: 't4',
        title: '完成审计',
        description: '逐条对照验收标准审查 t3 产出，输出审计报告。',
        agentRole: 'critic',
        dependsOn: ['t3'],
        tools: ['fs.read'],
        dangerous: false,
      },
    ],
  };
}
