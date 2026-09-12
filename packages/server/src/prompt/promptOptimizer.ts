import { PROMPT_SECTION_LABELS, SECTION_KEYS, extractVariables, emptySections } from './promptTemplate.ts';
import type { PromptSections } from '@ai/shared';

/**
 * 提示词优化器（Phase 4 Step 3）。
 *
 * 设计原则：**确定性规则优先，LLM 只做锦上添花**。
 *   - 规则部分可离线运行、可单测、结果可复现（这是「优化器」能被信任的前提）
 *   - LLM 不可用时不会「什么都优化不出来」，而是给出规则化重写 + 明确说明
 *
 * 覆盖提示词要求的优化维度：
 *   消除歧义 · 补全约束 · 结构化 · 边界条件 · 失败处理 · 评估标准
 */

export interface OptimizeIssue {
  severity: 'low' | 'medium' | 'high';
  section: keyof PromptSections;
  detail: string;
  suggestion: string;
}

export interface OptimizeResult {
  sections: PromptSections;
  issues: OptimizeIssue[];
  notes: string[];
  score: number;
}

/* --------------------------- 歧义词表（可扩充） --------------------------- */
const AMBIGUOUS: { re: RegExp; section: keyof PromptSections; detail: string; suggestion: string }[] = [
  { re: /(尽量|可能|也许|大概|差不多)/, section: 'task', detail: '包含「尽量/可能」等模糊限定词，无法验收', suggestion: '改成可量化表述，例如「输出不少于 5 个要点，每个附来源」' },
  { re: /(等等|之类的|什么的|等)/, section: 'task', detail: '使用「等等」这类开放式结尾，模型无法判断范围', suggestion: '明确列举范围或给出判定规则' },
  { re: /(好一点|优化一下|改好|弄好)/, section: 'task', detail: '目标不可测量（「好一点」无法验收）', suggestion: '写出验收标准，例如「错误率低于 1%」「响应时间 < 200ms」' },
  { re: /(随便|你看着办|都行)/, section: 'task', detail: '把决策完全交给模型，结果不可控', suggestion: '给出至少一个示例输入/输出作为锚点' },
];

const MISSING_HARD_CONSTRAINTS = [
  { re: /不得编造|禁止编造|不要编造|不许编造/, text: '- 不得编造事实，不确定时明确说明「不确定」并给出获取方式' },
  { re: /不得硬编码|禁止硬编码|不要硬编码/, text: '- 不得硬编码密钥、Token、账号或环境相关配置' },
  { re: /来源|引用|出处/, text: '- 所有结论必须给出来源（URL / 文档名 / 数据表）与访问时间' },
];

const FAILURE_HANDLING = '失败处理：当输入缺失、工具不可用或结果冲突时，明确说明缺什么、尝试过什么，并给出下一步建议；不要返回空内容。';
const EDGE_CASES = '边界条件：空输入、超长输入、非法格式、超大数量、并发冲突时，给出可读错误而不是抛异常。';
const EVAL_CRITERIA = '评估标准：输出必须可被第三方复核 —— 结论、证据、计算过程三者齐全。';

/** 结构化：把「步骤」章节规范成编号列表（模型对编号列表的遵循度显著更高） */
export function normalizeSteps(steps: string): string {
  const lines = steps
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^(\d+[.)、]|[-*+])\s*/, '').trim())
    .filter(Boolean);
  if (lines.length === 0) return '';
  return lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
}

/** 补全约束：缺什么补什么，不重复添加 */
export function ensureConstraints(constraints: string): string {
  const text = constraints.trim();
  const missing = MISSING_HARD_CONSTRAINTS.filter((c) => !c.re.test(text)).map((c) => c.text);
  if (missing.length === 0) return text;
  return [text, ...missing].filter(Boolean).join('\n');
}

export function optimizeSections(input: PromptSections): OptimizeResult {
  const sections = emptySections();
  for (const k of SECTION_KEYS) sections[k] = (input[k] ?? '').trim();

  const issues: OptimizeIssue[] = [];
  const notes: string[] = [];

  // 1) 歧义检测 + 不改内容，只提示（避免「优化器悄悄改写用户意图」）
  for (const rule of AMBIGUOUS) {
    for (const k of SECTION_KEYS) {
      if (sections[k] && rule.re.test(sections[k])) {
        issues.push({ severity: 'medium', section: k, detail: `${PROMPT_SECTION_LABELS[k]}：${rule.detail}`, suggestion: rule.suggestion });
        break;
      }
    }
  }

  // 2) 缺章节：按严重度提示
  if (!sections.role.trim()) {
    issues.push({ severity: 'high', section: 'role', detail: '缺少角色定义，模型无法确定专业边界', suggestion: '写出「你是一名 X 领域的 Y，只对 Z 负责」' });
    sections.role = '你是一名严谨的领域专家，只对你确认过的事实负责。';
    notes.push('已补全：角色');
  }
  if (!sections.task.trim()) {
    issues.push({ severity: 'high', section: 'task', detail: '缺少任务描述，无法执行', suggestion: '用一句话写清「输入是什么、要产出什么」' });
  }
  if (!sections.outputFormat.trim()) {
    issues.push({ severity: 'medium', section: 'outputFormat', detail: '缺少输出格式，跨模型表现不一致', suggestion: '指定 Markdown / JSON / 表格，并给出字段名' });
    sections.outputFormat = 'Markdown（含小标题、要点列表与结论段）';
    notes.push('已补全：输出格式');
  }
  if (!sections.acceptance.trim()) {
    issues.push({ severity: 'high', section: 'acceptance', detail: '缺少验收标准，无法判断完成度', suggestion: '写出可核查的标准，如「每条结论都有来源链接」' });
    sections.acceptance = EVAL_CRITERIA.replace('评估标准：', '');
    notes.push('已补全：验收标准');
  }

  // 3) 步骤结构化
  if (sections.steps.trim()) {
    const normalized = normalizeSteps(sections.steps);
    if (normalized !== sections.steps.trim()) {
      sections.steps = normalized;
      notes.push('已结构化：步骤（统一为编号列表）');
    }
  } else if (sections.task.trim()) {
    issues.push({ severity: 'low', section: 'steps', detail: '缺少执行步骤，复杂任务容易漏项', suggestion: '拆成 3~7 步，每步可独立校验' });
  }

  // 4) 硬约束补全
  const before = sections.constraints;
  sections.constraints = ensureConstraints(before);
  if (sections.constraints !== before) {
    notes.push('已补全：硬约束（不编造 / 不硬编码密钥 / 来源可追溯）');
  }

  // 5) 边界条件与失败处理
  if (!/边界|空输入|超长|非法格式/.test(sections.context)) {
    sections.context = [sections.context, EDGE_CASES].filter(Boolean).join('\n');
    notes.push('已补全：边界条件');
  }
  if (!/失败|异常|冲突|不可用/.test(sections.constraints)) {
    sections.constraints = [sections.constraints, FAILURE_HANDLING].filter(Boolean).join('\n');
    notes.push('已补全：失败处理');
  }

  const score = scoreSections(sections);
  return { sections, issues, notes, score };
}

/**
 * 提示词质量评分（0~100）。
 * 评分维度与九要素一一对应，权重体现「对最终效果的影响程度」：
 *   任务 25 / 角色 15 / 步骤 15 / 约束 15 / 输出格式 10 / 验收 10 / 上下文 5 / 示例 3 / 工具 2
 */
const WEIGHTS: Record<keyof PromptSections, number> = {
  task: 25,
  role: 15,
  steps: 15,
  constraints: 15,
  outputFormat: 10,
  acceptance: 10,
  context: 5,
  examples: 3,
  tools: 2,
};

export function scoreSections(sections: PromptSections): number {
  let score = 0;
  for (const k of SECTION_KEYS) {
    const text = (sections[k] ?? '').trim();
    if (!text) continue;
    const w = WEIGHTS[k];
    // 内容长度也参与：写 3 个字和写 3 句话的提示词效果差很多
    const lengthFactor = Math.min(1, text.length / (k === 'task' ? 60 : 40));
    score += w * (0.6 + 0.4 * lengthFactor);
  }
  const variables = extractVariables(sections);
  if (variables.length > 0) score += 2; // 可复用性加分
  return Math.max(0, Math.min(100, Math.round(score)));
}
