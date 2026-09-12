import { EMPTY_PROMPT_SECTIONS, type PromptSections } from '@ai/shared';
import { emptySections, mergeSections } from './promptTemplate.ts';

/**
 * 提示词生成器（Phase 4 Step 3）。
 *
 * 从「一句话目标」生成结构化九要素提示词。
 * 关键设计：**规则引擎负责骨架，LLM 负责润色**。
 *   - 规则引擎：按意图分类（写代码 / 写文档 / 数据分析 / 调研 / 部署 / 通用）套用模板
 *   - 无模型时也能生成可用提示词（离线可用，且结果可复现 → 可单测）
 */

export type IntentKind = 'code' | 'document' | 'data-analysis' | 'research' | 'deploy' | 'general';

const INTENT_RULES: { kind: IntentKind; re: RegExp }[] = [
  { kind: 'code', re: /(代码|编程|函数|实现|接口|重构|缓存|算法|bug|报错|测试|code|api|lru)/i },
  { kind: 'document', re: /(文档|报告|方案|总结|周报|ppt|汇报|写作)/i },
  { kind: 'data-analysis', re: /(数据|分析|指标|报表|统计|趋势|对比|sql|excel)/i },
  { kind: 'research', re: /(调研|研究|综述|文献|竞品|市场|政策|查证)/i },
  { kind: 'deploy', re: /(部署|上线|发布|运维|域名|服务器|docker|k8s)/i },
];

export function classifyIntent(goal: string): IntentKind {
  for (const r of INTENT_RULES) {
    if (r.re.test(goal)) return r.kind;
  }
  return 'general';
}

interface Profile {
  role: string;
  steps: string[];
  constraints: string[];
  acceptance: string;
  outputFormat: string;
}

const PROFILES: Record<IntentKind, Profile> = {
  code: {
    role: '你是一名有 10 年经验的资深软件工程师，擅长在保证正确性的前提下写出可维护、可测试的代码。',
    steps: ['明确输入、输出与调用方约定（接口签名 / 数据格式）', '给出最小可用实现，标注关键取舍', '补上边界与异常分支的处理', '写出可运行的验证方式（命令 / 单测用例）'],
    constraints: ['不得编造不存在的 API 或库', '不得硬编码密钥、Token 与账号', '不得删改无关代码，改动必须最小化', '所有路径访问必须限制在指定目录内'],
    acceptance: '代码可直接运行；给出验证命令与实际输出；边界情况有明确处理。',
    outputFormat: 'Markdown：实现思路 → 代码块（带文件路径）→ 验证命令 → 已知限制',
  },
  document: {
    role: '你是一名结构化写作专家，擅长把零散信息整理成逻辑清晰、可直接交付的文档。',
    steps: ['明确读者与用途', '列出大纲（3~6 个一级标题）', '逐节填充，每节先结论后论据', '通读一遍，删除重复与空话'],
    constraints: ['不得编造数据与来源', '不确定的信息必须标注「待核实」', '不得堆砌形容词，每段至多一个核心观点'],
    acceptance: '结论先行、章节自洽、每个关键论断有依据；读者不追问即可执行。',
    outputFormat: 'Markdown：标题 → 摘要（3 句内）→ 分节正文 → 结论与下一步',
  },
  'data-analysis': {
    role: '你是一名数据分析师，擅长用可复现的方法从数据中得出可验证的结论。',
    steps: ['确认数据字段含义与口径', '说明统计方法（口径 / 样本 / 时间范围）', '给出计算过程与中间结果', '给出结论并标注置信度与局限'],
    constraints: ['不得编造数据', '不得用不匹配的口径做对比', '结论必须可复算（给出公式与参数）'],
    acceptance: '每个结论都能由给出的数据与公式复算出来；口径与局限写清楚。',
    outputFormat: 'Markdown：口径说明 → 表格 → 计算过程 → 结论（含置信度）',
  },
  research: {
    role: '你是一名严谨的研究员，擅长多源交叉验证并明确区分「事实」与「推断」。',
    steps: ['拆解研究问题为可检索的子问题', '逐个子问题收集来源并记录访问时间', '对矛盾说法做交叉验证', '形成结论并列出反证与未决问题'],
    constraints: ['不得编造来源或链接', '事实与推断必须分开标注', '存在冲突时必须呈现双方观点', '不得使用未授权的抓取手段'],
    acceptance: '每个关键论断都附来源；冲突点有明确标注；未决问题单独列出。',
    outputFormat: 'Markdown：摘要 → 分问题论述（带引用编号）→ 冲突与反证 → 未决问题 → 来源列表',
  },
  deploy: {
    role: '你是一名运维工程师，擅长在保证可回滚的前提下规划部署与变更。',
    steps: ['列出变更项与影响面', '给出前置检查与备份方案', '给出执行步骤（可复制命令）', '给出验证方法与回滚步骤'],
    constraints: ['不得在命令中暴露凭据', '不得省略回滚方案', '危险操作必须要求二次确认', '不得直接在生产上试错'],
    acceptance: '每一步都能验证；回滚路径明确；无凭据出现在任何输出中。',
    outputFormat: 'Markdown：变更清单 → 前置检查 → 执行步骤 → 验证 → 回滚',
  },
  general: {
    role: '你是一名可靠的任务执行助手，先确认理解，再给出可验证的结果。',
    steps: ['复述你的理解（含假设）', '给出执行计划（编号）', '逐步执行并给出中间结果', '给出最终结果与自检结论'],
    constraints: ['不得编造事实', '不确定时明确说明并给出获取方式', '不得硬编码密钥与账号'],
    acceptance: '结果可被第三方复核；假设与不确定项均已显式说明。',
    outputFormat: 'Markdown：理解与假设 → 计划 → 执行结果 → 自检',
  },
};

export interface GenerateInput {
  goal: string;
  /** 用户补充的上下文（可选） */
  context?: string;
  /** 目标模型（影响输出风格描述） */
  targetModel?: string;
}

export interface GenerateResult {
  sections: PromptSections;
  intent: IntentKind;
  notes: string[];
}

export function generatePrompt(input: GenerateInput): GenerateResult {
  const goal = input.goal.trim();
  if (!goal) throw new Error('目标不能为空');
  const intent = classifyIntent(goal);
  const profile = PROFILES[intent];
  const notes: string[] = [`已按意图「${intent}」套用结构化模板`];

  const variables: string[] = [];
  if (!/\{\{/.test(goal)) variables.push('topic');

  const sections = mergeSections(emptySections(), {
    role: profile.role,
    task: `目标：${goal}\n\n要求：输出必须可直接使用，不需要我再补充信息。`,
    context: [input.context ?? '', `输入材料：{{input}}`, variables.length ? `主题：{{topic}}` : ''].filter(Boolean).join('\n'),
    steps: profile.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    tools: '可用工具：工作区文件读写、联网检索（需你显式允许）、数据查询。工具调用前先说明意图，调用后说明结果。',
    constraints: profile.constraints.map((c) => `- ${c}`).join('\n'),
    outputFormat: [profile.outputFormat, input.targetModel ? `目标模型：${input.targetModel}` : ''].filter(Boolean).join('\n'),
    examples: '示例（可选）：若我有历史产物，优先沿用其结构与命名风格。',
    acceptance: profile.acceptance,
  });

  if (!sections.constraints.includes('不得编造')) notes.push('警告：约束中缺少「不得编造事实」，请检查模板配置');

  return { sections, intent, notes };
}

export { EMPTY_PROMPT_SECTIONS };
