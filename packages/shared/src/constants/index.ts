import type { AgentRole, PromptSections } from '../types/domain.ts';

/** 默认工作区名称 */
export const DEFAULT_WORKSPACE_NAME = '默认工作区';

/** 单个任务默认最大重试次数 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** 目标默认最大迭代轮次，防止无限循环 */
export const DEFAULT_MAX_ITERATIONS = 12;

/** 目标模式每个分支默认最大并行 Agent 数 */
export const DEFAULT_MAX_PARALLEL_AGENTS = 4;

/** Token 预算：分层上下文管理的默认比例 */
export const TOKEN_BUDGET = {
  /** 总预算 */
  total: 200_000,
  /** 近 N 轮原文保留 */
  recentRawRatio: 0.35,
  /** 滚动摘要 */
  summaryRatio: 0.2,
  /** 向量召回 */
  retrievalRatio: 0.25,
  /** 关键事实 */
  factsRatio: 0.1,
  /** 输出预留 */
  outputReserveRatio: 0.1,
} as const;

/** 内置 Agent 角色与默认 system prompt */
export const BUILTIN_AGENTS: { role: AgentRole; name: string; systemPrompt: string }[] = [
  {
    role: 'coordinator',
    name: '总控 Coordinator',
    systemPrompt:
      '你是总控 Agent。职责：理解目标、调度子 Agent、汇总结果、判断是否达成验收标准。' +
      '不直接做耗时工作，只做拆解、分配、检查与汇总。输出必须是结构化 JSON。',
  },
  {
    role: 'planner',
    name: '规划 Planner',
    systemPrompt:
      '你是规划 Agent。把目标拆解为带依赖关系的任务 DAG，标注每个任务所需角色与工具。' +
      '只输出 JSON：{"tasks":[{"key","title","description","agentRole","dependsOn":["key"],"tools":[]}]}。',
  },
  {
    role: 'researcher',
    name: '检索 Researcher',
    systemPrompt: '你是检索 Agent。负责信息检索与多源交叉验证，必须给出可溯源的引用，不得编造。',
  },
  {
    role: 'analyst',
    name: '分析 Analyst',
    systemPrompt: '你是分析 Agent。负责数据分析、对比与结论推导，给出计算过程与假设。',
  },
  {
    role: 'coder',
    name: '编码 Coder',
    systemPrompt: '你是编码 Agent。负责产出可运行代码与测试，遵循项目既有风格，禁止硬编码密钥。',
  },
  {
    role: 'writer',
    name: '写作 Writer',
    systemPrompt: '你是写作 Agent。负责把结构化结论写成人类可读的报告，保持事实准确。',
  },
  {
    role: 'file-ops',
    name: '文件 FileOps',
    systemPrompt: '你是文件处理 Agent。负责读写 docx/xlsx/pptx/pdf，保证不破坏原文件格式。',
  },
  {
    role: 'deployer',
    name: '部署 Deployer',
    systemPrompt:
      '你是部署 Agent。只在用户显式确认后执行部署。所有密钥来自用户配置，禁止硬编码。',
  },
  {
    role: 'critic',
    name: '评审 Critic',
    systemPrompt:
      '你是评审 Agent。对照目标与验收标准逐条审查产出，指出缺陷、风险与未完成项。' +
      '输出 JSON：{"passed":bool,"score":0-100,"issues":[{"severity","detail"}],"nextActions":[]}。',
  },
];

/** 提示词九要素的展示顺序与中文名 */
export const PROMPT_SECTION_LABELS: Record<keyof PromptSections, string> = {
  role: '角色',
  task: '任务',
  context: '上下文',
  steps: '步骤',
  tools: '工具',
  constraints: '约束',
  outputFormat: '输出格式',
  examples: '示例',
  acceptance: '验收标准',
};

export const EMPTY_PROMPT_SECTIONS: PromptSections = {
  role: '',
  task: '',
  context: '',
  steps: '',
  tools: '',
  constraints: '',
  outputFormat: '',
  examples: '',
  acceptance: '',
};

/** 需要用户二次确认的危险操作 */
export const DANGEROUS_ACTIONS = [
  'website.deploy',
  'website.delete',
  'file.delete',
  'schedule.delete',
  'plugin.install',
  'db.write',
  'paid_api.call',
] as const;

export type DangerousAction = (typeof DANGEROUS_ACTIONS)[number];

export function isDangerousAction(action: string): action is DangerousAction {
  return (DANGEROUS_ACTIONS as readonly string[]).includes(action);
}
