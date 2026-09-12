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

/**
 * 离线兜底计划。
 *
 * 设计目标：即使没有模型密钥，也要产出一个**真实的、≥10 步的 DAG**，
 * 而不是 4 步占位。理由：
 * 1) 目标模式的验收标准是「自主完成至少 10 步任务」，占位计划无法验证调度、
 *    并行、重试、反思、审计等真正重要的机制；
 * 2) 用户配置模型前，产品也应该是可用的（阶段性交付物可见）。
 *
 * 结构与真实调研闭环一致：范围界定 → 多维检索 → 多路分析 → 撰写 → 交付物 → 审计。
 */
export function defaultPlan(objective: string, explicitCriteria?: string[]): { acceptanceCriteria: string[]; tasks: PlannedTask[] } {
  const short = objective.slice(0, 60);
  return {
    acceptanceCriteria: explicitCriteria?.length
      ? explicitCriteria
      : [
          `围绕目标产出可交付成果：${short}`,
          '关键结论都有可追溯来源',
          '包含数据表格或量化指标',
          '通过评审 Agent 的完成审计',
        ],
    tasks: [
      {
        key: 't1',
        title: '界定目标范围与验收标准',
        description: `把目标拆成可验证的问题清单，明确边界与不做的部分。目标：${short}`,
        agentRole: 'planner',
        dependsOn: [],
        tools: [],
        dangerous: false,
      },
      {
        key: 't2',
        title: '设计检索维度与关键指标',
        description: '确定需要哪些维度的信息与量化指标（规模、增速、政策、竞争格局、风险）。',
        agentRole: 'planner',
        dependsOn: ['t1'],
        tools: [],
        dangerous: false,
      },
      {
        key: 't3',
        title: '收集行业规模与增长数据',
        description: '检索市场规模、增速、装机量等核心量化数据。',
        agentRole: 'researcher',
        dependsOn: ['t2'],
        tools: ['fs.read', 'fs.list'],
        dangerous: false,
      },
      {
        key: 't4',
        title: '收集政策与监管信息',
        description: '检索相关政策、补贴、准入与合规要求。',
        agentRole: 'researcher',
        dependsOn: ['t2'],
        tools: ['fs.read'],
        dangerous: false,
      },
      {
        key: 't5',
        title: '梳理竞争格局与主要参与者',
        description: '整理主要厂商、份额与产能分布。',
        agentRole: 'researcher',
        dependsOn: ['t2'],
        tools: ['fs.read'],
        dangerous: false,
      },
      {
        key: 't6',
        title: '识别风险与不确定性',
        description: '梳理技术、产能、价格与政策风险，标注不确定性。',
        agentRole: 'analyst',
        dependsOn: ['t3', 't4'],
        tools: ['fs.read'],
        dangerous: false,
      },
      {
        key: 't7',
        title: '量化分析：规模与增速测算',
        description: '基于 t3 数据做增速与规模测算，给出计算过程与假设。',
        agentRole: 'analyst',
        dependsOn: ['t3'],
        tools: ['fs.read'],
        dangerous: false,
      },
      {
        key: 't8',
        title: '横向对比与交叉验证',
        description: '对比不同来源的数据差异，标记冲突并给出取舍理由。',
        agentRole: 'analyst',
        dependsOn: ['t3', 't5'],
        tools: ['fs.read'],
        dangerous: false,
      },
      {
        key: 't9',
        title: '撰写结论与建议',
        description: '把分析结论写成可读的结论与行动建议。',
        agentRole: 'writer',
        dependsOn: ['t6', 't7', 't8'],
        tools: ['fs.write'],
        dangerous: false,
      },
      {
        key: 't10',
        title: '生成 docx 交付文档',
        description: '把结论整理为结构化 docx 文档并落盘。',
        agentRole: 'writer',
        dependsOn: ['t9'],
        tools: ['office.generate'],
        dangerous: false,
      },
      {
        key: 't11',
        title: '生成数据明细表',
        description: '把关键数据整理成 xlsx 表格，便于复核。',
        agentRole: 'file-ops',
        dependsOn: ['t7'],
        tools: ['office.generate'],
        dangerous: false,
      },
      {
        key: 't12',
        title: '完成审计与交付核对',
        description: '逐条对照验收标准审查全部产出，输出审计报告与遗留问题。',
        agentRole: 'critic',
        dependsOn: ['t10', 't11'],
        tools: ['fs.read'],
        dangerous: false,
      },
    ],
  };
}
