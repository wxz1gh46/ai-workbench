import { desc, eq } from 'drizzle-orm';
import { EMPTY_PROMPT_SECTIONS, PROMPT_SECTION_LABELS, type PromptSections, type PromptTemplate } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { promptTemplates } from '../db/schema/index.ts';
import { modelRouter } from '../agent/model-router.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';

const SECTION_KEYS = Object.keys(EMPTY_PROMPT_SECTIONS) as (keyof PromptSections)[];

/** 渲染模板：把 {{var}} 替换为给定值，缺失的保留占位以便用户补齐 */
export function renderPrompt(sections: PromptSections, vars: Record<string, string> = {}): string {
  return SECTION_KEYS.filter((k) => sections[k]?.trim())
    .map((k) => `## ${PROMPT_SECTION_LABELS[k]}\n${sections[k].trim()}`)
    .join('\n\n')
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => vars[name] ?? `{{${name}}}`);
}

export function extractVariables(sections: PromptSections): string[] {
  const set = new Set<string>();
  for (const k of SECTION_KEYS) {
    for (const m of (sections[k] ?? '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
      if (m[1]) set.add(m[1]);
    }
  }
  return [...set];
}

const OPTIMIZER_SYSTEM = `你是提示词工程专家。把用户诉求转成结构化提示词，严格输出 JSON：
{"role":"","task":"","context":"","steps":"","tools":"","constraints":"","outputFormat":"","examples":"","acceptance":""}
要求：
- role 写明身份与专业边界
- steps 用编号列表，可执行
- constraints 必须包含「不得编造事实」「不得硬编码密钥」
- acceptance 给出可验收的量化标准`;

export class PromptService {
  constructor(private readonly db: Db) {}

  async optimize(input: { workspaceId: string; intent: string; current?: Partial<PromptSections>; targetModel?: string }): Promise<{
    sections: PromptSections;
    rendered: string;
    variables: string[];
    notes: string[];
  }> {
    const base: PromptSections = { ...EMPTY_PROMPT_SECTIONS, ...(input.current ?? {}) };
    const res = await modelRouter.chat({
      messages: [
        { role: 'system', content: OPTIMIZER_SYSTEM },
        {
          role: 'user',
          content: [
            `# 诉求\n${input.intent}`,
            input.targetModel ? `# 目标模型\n${input.targetModel}` : '',
            Object.values(base).some(Boolean) ? `# 已有提示词\n${JSON.stringify(base, null, 2)}` : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
      jsonMode: true,
      temperature: 0.4,
    });

    let sections: PromptSections = base;
    const notes: string[] = [];
    try {
      const cleaned = res.content.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1)) as Record<string, unknown>;
      if (parsed.__degraded === true) throw new Error('模型处于离线兜底模式');
      sections = { ...EMPTY_PROMPT_SECTIONS };
      for (const k of SECTION_KEYS) sections[k] = typeof parsed[k] === 'string' ? (parsed[k] as string) : '';
      notes.push('已按九要素结构生成');
    } catch {
      // 兜底：确定性模板，保证功能可用
      sections = { ...EMPTY_PROMPT_SECTIONS, ...base };
      sections.role ||= '你是一名严谨的领域专家。';
      sections.task ||= input.intent;
      sections.steps ||= '1. 明确输入与约束\n2. 执行任务\n3. 自检后输出';
      sections.constraints ||= '- 不得编造事实\n- 不得硬编码密钥\n- 不确定时明确说明';
      sections.outputFormat ||= 'Markdown';
      sections.acceptance ||= '结论可验证，来源可追溯';
      notes.push('模型不可用，已使用内置模板，请人工补充上下文与示例');
    }

    const variables = extractVariables(sections);
    return { sections, rendered: renderPrompt(sections), variables, notes };
  }

  async save(input: { workspaceId: string; name: string; sections: PromptSections; tags?: string[] }): Promise<PromptTemplate> {
    if (!input.name.trim()) throw AppError.badRequest('模板名称不能为空');
    const existing = await this.db
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.workspaceId, input.workspaceId));
    const prev = existing.find((t) => t.name === input.name);
    const now = nowIso();
    if (prev) {
      const version = prev.version + 1;
      const id = newId('ptpl');
      await this.db.insert(promptTemplates).values({
        id,
        workspaceId: input.workspaceId,
        name: input.name,
        sections: input.sections as unknown as Record<string, string>,
        variables: extractVariables(input.sections),
        version,
        parentId: prev.id,
        tags: input.tags ?? [],
        createdAt: now,
        updatedAt: now,
      });
      return ((await this.db.select().from(promptTemplates).where(eq(promptTemplates.id, id)).limit(1)) as unknown as PromptTemplate[])[0]!;
    }
    const row = {
      id: newId('ptpl'),
      workspaceId: input.workspaceId,
      name: input.name,
      sections: input.sections as unknown as Record<string, string>,
      variables: extractVariables(input.sections),
      version: 1,
      parentId: null,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(promptTemplates).values(row);
    return row as unknown as PromptTemplate;
  }

  async list(workspaceId: string): Promise<PromptTemplate[]> {
    return (await this.db
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.workspaceId, workspaceId))
      .orderBy(desc(promptTemplates.updatedAt))) as unknown as PromptTemplate[];
  }
}
