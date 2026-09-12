import { EMPTY_PROMPT_SECTIONS, PROMPT_SECTION_LABELS, type PromptSections } from '@ai/shared';
import type { PromptVariableSpec } from '@ai/shared';

/**
 * 提示词模板与变量（Phase 4 Step 3）。
 *
 * 九要素结构（Phase 1 已定义）保持不变，本文件扩展：
 *   - 变量声明（类型 / 必填 / 默认值 / 说明），支持 {{var}} 语法
 *   - 渲染时做「必填缺失」检查：不静默留空占位，而是明确报出缺哪些变量
 *   - 一键复制用 Markdown 输出（渲染后的成品）
 */

export const SECTION_KEYS = Object.keys(EMPTY_PROMPT_SECTIONS) as (keyof PromptSections)[];

export const VARIABLE_RE = /\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g;

export { PROMPT_SECTION_LABELS };

/** 抽取变量名（去重、保持出现顺序） */
export function extractVariables(sections: PromptSections): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of SECTION_KEYS) {
    for (const m of (sections[k] ?? '').matchAll(VARIABLE_RE)) {
      const name = m[1];
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

/**
 * 推断变量类型与必填：
 *   - 变量名里含 count/limit/num/数量 的推断为 number
 *   - 含 enable/is/should 的推断为 boolean
 *   - 其余为 string；全部默认「非必填」，避免一上来就拦住用户
 */
export function inferVariableSpec(name: string): PromptVariableSpec {
  const lower = name.toLowerCase();
  let type: PromptVariableSpec['type'] = 'string';
  if (/(count|limit|num|size|数量|条数)/.test(lower)) type = 'number';
  else if (/^(is|has|enable|should)[A-Z_]/.test(name) || /(是否|开关)/.test(name)) type = 'boolean';
  return { name, type, required: false, defaultValue: null, description: '', options: [] };
}

export function buildVariableSpecs(sections: PromptSections, overrides: PromptVariableSpec[] = []): PromptVariableSpec[] {
  const map = new Map(overrides.map((o) => [o.name, o]));
  return extractVariables(sections).map((name) => map.get(name) ?? inferVariableSpec(name));
}

/** 渲染：缺失变量「保留占位」而不是变成空串（用户能一眼看出没填） */
export function renderPrompt(sections: PromptSections, vars: Record<string, string> = {}): string {
  return SECTION_KEYS.filter((k) => (sections[k] ?? '').trim())
    .map((k) => `## ${PROMPT_SECTION_LABELS[k]}\n${(sections[k] ?? '').trim()}`)
    .join('\n\n')
    .replace(VARIABLE_RE, (_m, name: string) => {
      const v = vars[name];
      return v !== undefined && v !== '' ? v : `{{${name}}}`;
    });
}

export interface RenderCheck {
  ok: boolean;
  missing: string[];
  unknown: string[];
  rendered: string;
}

/** 渲染前校验：必填缺失 / 传了模板里不存在的变量（后者通常是调用方拼错了） */
export function renderWithCheck(sections: PromptSections, vars: Record<string, string>, specs: PromptVariableSpec[]): RenderCheck {
  const declared = new Set(extractVariables(sections));
  const missing: string[] = [];
  const merged: Record<string, string> = { ...vars };
  for (const spec of specs) {
    const provided = vars[spec.name];
    if (provided === undefined || provided === '') {
      if (spec.defaultValue !== null && spec.defaultValue !== undefined) {
        merged[spec.name] = spec.defaultValue;
      } else if (spec.required) {
        missing.push(spec.name);
      }
    }
  }
  const unknown = Object.keys(vars).filter((k) => !declared.has(k));
  return { ok: missing.length === 0, missing, unknown, rendered: renderPrompt(sections, merged) };
}

/** 保真复制：输出可直接粘贴到任意模型 / 其他工具的 Markdown */
export function toCopyableMarkdown(input: { name: string; sections: PromptSections; variables: Record<string, string> }): string {
  const rendered = renderPrompt(input.sections, input.variables);
  return `# ${input.name}\n\n<!-- 由 AI 工作台·提示词工作台生成；未填写的变量保留为 {{var}} -->\n\n${rendered}\n`;
}

/** 空模板：保证所有章节都有 key，避免下游 undefined 判断散落各处 */
export function emptySections(): PromptSections {
  return { ...EMPTY_PROMPT_SECTIONS };
}

/** 合并：以 base 为底，用 partial 非空字段覆盖 */
export function mergeSections(base: PromptSections, partial: Partial<PromptSections>): PromptSections {
  const out = emptySections();
  for (const k of SECTION_KEYS) out[k] = partial[k]?.trim() ? (partial[k] as string) : (base[k] ?? '');
  return out;
}
