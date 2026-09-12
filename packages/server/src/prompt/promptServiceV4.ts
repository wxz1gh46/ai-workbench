import { eq } from 'drizzle-orm';
import { EMPTY_PROMPT_SECTIONS, type PromptSections } from '@ai/shared';
import type { PromptABTestReport, PromptVariableSpec } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { promptABTests, promptEvaluations, promptTemplates, promptVariables, promptVersions } from '../db/schema/index.ts';
import { modelRouter } from '../agent/model-router.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';
import { SECTION_KEYS, buildVariableSpecs, extractVariables, renderWithCheck, toCopyableMarkdown, emptySections } from './promptTemplate.ts';
import { generatePrompt, classifyIntent } from './promptGenerator.ts';
import { optimizeSections, scoreSections, type OptimizeIssue } from './promptOptimizer.ts';
import { PROMPT_LIBRARY, findTemplate } from './promptLibrary.ts';
import { aggregateVersion, decide, scoreLength, scoreStructure, scoreVariableCoverage } from './promptABTest.ts';

/**
 * 提示词工程服务（Phase 4 Step 3）。
 *
 * 与 Phase 1 的 PromptService（services/prompt-service.ts）的关系：
 *   - Phase 1 版本只做 optimize + save + list（简版）
 *   - 本服务是完整版：模板库 / 变量 / 生成 / 优化 / 版本 / A/B / 评估 / 一键复制
 *   - 两者共用 prompt_templates 表，version 语义一致（同一 name 递增版本），不会互相破坏
 */

const OPTIMIZER_SYSTEM = `你是提示词工程专家。把用户诉求转为结构化提示词，严格输出 JSON：
{"role":"","task":"","context":"","steps":"","tools":"","constraints":"","outputFormat":"","examples":"","acceptance":""}
要求：
- steps 用编号列表，每步可独立校验
- constraints 必须包含「不得编造事实」「不得硬编码密钥」
- acceptance 给出可量化、可核查的验收标准`;

export interface SaveTemplateInput {
  workspaceId: string;
  name: string;
  sections: PromptSections;
  variables?: Partial<PromptVariableSpec>[];
  tags?: string[];
  createdBy?: string;
}

export class PromptServiceV4 {
  constructor(private readonly db: Db) {}

  /* --------------------------- 模板库 --------------------------- */

  library() {
    return PROMPT_LIBRARY.map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      tags: t.tags,
      sections: t.sections,
      variables: buildVariableSpecs(t.sections),
      filledSections: SECTION_KEYS.filter((k) => (t.sections[k] ?? '').trim()).length,
    }));
  }

  /**
   * 从预置模板创建到工作区（带变量声明落库）。
   * 若同名已存在：不覆盖，而是新增一个版本（避免「点错一下把用户改过的模板冲掉」）。
   */
  async createFromLibrary(workspaceId: string, key: string, nameOverride?: string) {
    const tpl = findTemplate(key);
    if (!tpl) throw AppError.notFound(`预置模板不存在: ${key}`);
    const name = (nameOverride ?? tpl.name).trim();
    return this.save({ workspaceId, name, sections: tpl.sections, tags: tpl.tags, createdBy: 'library' });
  }

  /* --------------------------- 生成 / 优化 --------------------------- */

  async generate(input: { workspaceId: string; goal: string; context?: string; targetModel?: string; useModel?: boolean }) {
    const base = generatePrompt({ goal: input.goal, ...(input.context ? { context: input.context } : {}), ...(input.targetModel ? { targetModel: input.targetModel } : {}) });
    const notes = [...base.notes];
    let sections = base.sections;
    let degraded = true;

    if (input.useModel !== false && modelRouter.hasCredentials) {
      try {
        const res = await modelRouter.chat({
          messages: [
            { role: 'system', content: OPTIMIZER_SYSTEM },
            { role: 'user', content: `# 目标\n${input.goal}\n\n# 已有骨架（请在此基础上补全，不要改变意图）\n${JSON.stringify(sections, null, 2)}` },
          ],
          jsonMode: true,
          temperature: 0.3,
        });
        const parsed = parseSections(res.content);
        if (parsed) {
          sections = parsed;
          notes.push('已用模型补全细节');
          degraded = false;
        } else {
          notes.push('模型返回无法解析为九要素结构，已保留规则生成的骨架');
        }
      } catch (e) {
        notes.push(`模型不可用（${e instanceof Error ? e.message : String(e)}），已使用内置规则模板`);
      }
    } else {
      notes.push('未配置模型密钥，使用内置规则模板（离线可用、结果可复现）');
    }

    return { sections, rendered: renderWithCheck(sections, {}, buildVariableSpecs(sections)).rendered, variables: buildVariableSpecs(sections), intent: classifyIntent(input.goal), notes, degraded };
  }

  async optimize(input: { workspaceId: string; intent?: string; current: Partial<PromptSections>; targetModel?: string; useModel?: boolean }) {
    const merged: PromptSections = { ...EMPTY_PROMPT_SECTIONS };
    for (const k of SECTION_KEYS) merged[k] = (input.current[k] ?? '').trim();
    if (!SECTION_KEYS.some((k) => merged[k].trim())) {
      throw AppError.badRequest('待优化的提示词不能为空（至少填写一个章节）');
    }

    const rule = optimizeSections(merged);
    let sections = rule.sections;
    const issues: OptimizeIssue[] = [...rule.issues];
    const notes = [...rule.notes];
    let degraded = true;

    if (input.useModel !== false && modelRouter.hasCredentials) {
      try {
        const res = await modelRouter.chat({
          messages: [
            { role: 'system', content: OPTIMIZER_SYSTEM },
            {
              role: 'user',
              content: [
                input.intent ? `# 诉求\n${input.intent}` : '',
                input.targetModel ? `# 目标模型\n${input.targetModel}` : '',
                `# 已有提示词（保留原意，只做补全与结构化）\n${JSON.stringify(merged, null, 2)}`,
              ]
                .filter(Boolean)
                .join('\n\n'),
            },
          ],
          jsonMode: true,
          temperature: 0.35,
        });
        const parsed = parseSections(res.content);
        if (parsed) {
          // 模型结果以规则结果为兜底：任何章节为空都用规则结果补齐，避免「优化完反而变差」
          for (const k of SECTION_KEYS) if (!(parsed[k] ?? '').trim()) parsed[k] = sections[k];
          sections = parsed;
          notes.push('已用模型增强表达（空章节自动用规则结果补齐）');
          degraded = false;
        }
      } catch (e) {
        notes.push(`模型不可用（${e instanceof Error ? e.message : String(e)}），仅使用规则化优化`);
      }
    } else {
      notes.push('未配置模型密钥，仅使用规则化优化（歧义检测 / 结构规范化 / 约束补全）');
    }

    const variableSpecs = buildVariableSpecs(sections);
    return {
      sections,
      rendered: renderWithCheck(sections, {}, variableSpecs).rendered,
      variables: variableSpecs,
      notes,
      issues,
      score: scoreSections(sections),
      degraded,
    };
  }

  /** 一键复制：渲染为可粘贴的 Markdown（不落库） */
  copyable(input: { sections: PromptSections; variables?: Record<string, string>; name?: string }) {
    const specs = buildVariableSpecs(input.sections);
    const check = renderWithCheck(input.sections, input.variables ?? {}, specs);
    return {
      markdown: toCopyableMarkdown({ name: input.name ?? '提示词', sections: input.sections, variables: input.variables ?? {} }),
      rendered: check.rendered,
      missingRequired: check.missing,
      unknownVariables: check.unknown,
      ok: check.ok,
    };
  }

  /* --------------------------- 持久化 --------------------------- */

  async save(input: SaveTemplateInput) {
    const name = input.name.trim();
    if (!name) throw AppError.badRequest('模板名称不能为空');
    const specs = input.variables?.length ? buildVariableSpecs(input.sections, input.variables as PromptVariableSpec[]) : buildVariableSpecs(input.sections);
    const now = nowIso();

    const existing = (await this.db.select().from(promptTemplates).where(eq(promptTemplates.workspaceId, input.workspaceId))) as unknown as TemplateRow[];
    const sameName = existing.filter((t) => t.name === name).sort((a, b) => b.version - a.version)[0];
    const id = newId('ptpl');
    const version = sameName ? sameName.version + 1 : 1;

    await this.db.insert(promptTemplates).values({
      id,
      workspaceId: input.workspaceId,
      name,
      sections: input.sections as unknown as Record<string, string>,
      variables: extractVariables(input.sections) as never,
      version,
      parentId: sameName?.id ?? null,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    } as never);

    // 版本历史（与 prompt_templates 双写：templates 表是「当前状态」，versions 是「时间线」）
    await this.db.insert(promptVersions).values({
      id: newId('ptpv'),
      templateId: id,
      version,
      content: input.sections as unknown as Record<string, string>,
      createdAt: now,
      createdBy: input.createdBy ?? 'user',
    } as never);

    await this.syncVariables(id, specs);

    return { templateId: id, name, version, sections: input.sections, variables: specs, parentId: sameName?.id ?? null };
  }

  private async syncVariables(templateId: string, specs: PromptVariableSpec[]) {
    const existing = (await this.db.select().from(promptVariables).where(eq(promptVariables.templateId, templateId))) as unknown as VariableRow[];
    const byName = new Map(existing.map((v) => [v.name, v]));
    for (const spec of specs) {
      const prev = byName.get(spec.name);
      if (prev) {
        await this.db
          .update(promptVariables)
          .set({ type: spec.type, required: spec.required, defaultValue: spec.defaultValue, description: spec.description, options: spec.options as never } as never)
          .where(eq(promptVariables.id, prev.id));
      } else {
        await this.db.insert(promptVariables).values({
          id: newId('ptvv'),
          templateId,
          name: spec.name,
          type: spec.type,
          required: spec.required,
          defaultValue: spec.defaultValue,
          description: spec.description,
          options: spec.options as never,
        } as never);
      }
    }
  }

  async list(workspaceId: string) {
    const rows = (await this.db.select().from(promptTemplates).where(eq(promptTemplates.workspaceId, workspaceId))) as unknown as TemplateRow[];
    // 只展示每个 name 的最新版本，并把历史版本号一并带上（UI 可直接展开）
    const byName = new Map<string, TemplateRow[]>();
    for (const r of rows) {
      const arr = byName.get(r.name) ?? [];
      arr.push(r);
      byName.set(r.name, arr);
    }
    return [...byName.entries()].map(([name, list]) => {
      const sorted = [...list].sort((a, b) => b.version - a.version);
      const latest = sorted[0]!;
      return {
        name,
        latestId: latest.id,
        version: latest.version,
        versions: sorted.map((s) => s.version),
        sections: latest.sections as unknown as PromptSections,
        variables: (latest.variables ?? []) as string[],
        tags: (latest.tags ?? []) as string[],
        updatedAt: latest.updatedAt,
        score: scoreSections(latest.sections as unknown as PromptSections),
      };
    });
  }

  async detail(workspaceId: string, name: string, version?: number) {
    const rows = (await this.db.select().from(promptTemplates).where(eq(promptTemplates.workspaceId, workspaceId))) as unknown as TemplateRow[];
    const list = rows.filter((r) => r.name === name);
    if (list.length === 0) throw AppError.notFound(`模板不存在: ${name}`);
    const sorted = list.sort((a, b) => b.version - a.version);
    const target = version ? sorted.find((s) => s.version === version) : sorted[0];
    if (!target) throw AppError.notFound(`模板「${name}」不存在版本 ${version}`);
    const vars = (await this.db.select().from(promptVariables).where(eq(promptVariables.templateId, target.id))) as unknown as VariableRow[];
    const versions = (await this.db.select().from(promptVersions).where(eq(promptVersions.templateId, target.id))) as unknown as VersionRow[];
    return {
      name,
      version: target.version,
      templateId: target.id,
      sections: target.sections as unknown as PromptSections,
      variables: vars.map((v) => ({ name: v.name, type: v.type, required: v.required, defaultValue: v.defaultValue, description: v.description, options: (v.options ?? []) as string[] })),
      history: sorted.map((s) => ({ id: s.id, version: s.version, updatedAt: s.updatedAt, score: scoreSections(s.sections as unknown as PromptSections) })),
      versionRows: versions,
      score: scoreSections(target.sections as unknown as PromptSections),
      renders: this.copyable({ sections: target.sections as unknown as PromptSections, name }),
    };
  }

  /** 版本回滚：把指定历史版本复制成一个新版本（不删历史，保证可追溯） */
  async rollbackVersion(workspaceId: string, name: string, version: number) {
    const detail = await this.detail(workspaceId, name, version);
    return this.save({ workspaceId, name, sections: detail.sections, tags: [], createdBy: `rollback:v${version}` });
  }

  /* --------------------------- A/B 测试 --------------------------- */

  async createABTest(input: { workspaceId: string; templateName: string; versionA: number; versionB: number; name?: string }) {
    const detailA = await this.detail(input.workspaceId, input.templateName, input.versionA);
    await this.detail(input.workspaceId, input.templateName, input.versionB);
    if (input.versionA === input.versionB) throw AppError.badRequest('A/B 测试需要两个不同版本');
    const id = newId('ptab');
    await this.db.insert(promptABTests).values({
      id,
      templateId: detailA.templateId,
      name: input.name ?? `${input.templateName} v${input.versionA} vs v${input.versionB}`,
      versionA: input.versionA,
      versionB: input.versionB,
      status: 'running',
      startedAt: nowIso(),
      finishedAt: null,
      createdAt: nowIso(),
    } as never);
    return { id, templateName: input.templateName, versionA: input.versionA, versionB: input.versionB, status: 'running' as const };
  }

  /**
   * 记录评估：值必须落在合法范围，否则报错（避免「评分 100 分」这种脏数据把结论带偏）
   *   - 人工指标：1~5
   *   - 自动指标：0~5
   */
  async recordEvaluation(input: { workspaceId: string; abTestId: string; version: 'A' | 'B'; metric: string; value: number; sampleSize: number; note?: string }) {
    const test = await this.getABTest(input.workspaceId, input.abTestId);
    if (test.status === 'finished') throw AppError.conflict(`测试已结束，不能再记录评分（${input.abTestId}）`);
    const manual = ['accuracy', 'clarity', 'usefulness'].includes(input.metric);
    const min = manual ? 1 : 0;
    const max = 5;
    if (!Number.isFinite(input.value) || input.value < min || input.value > max) {
      throw AppError.badRequest(`指标 ${input.metric} 的取值必须在 ${min}~${max} 之间（收到 ${input.value}）`);
    }
    if (!Number.isInteger(input.sampleSize) || input.sampleSize < 1) throw AppError.badRequest('sampleSize 必须是 ≥1 的整数');

    const id = newId('ptev');
    await this.db.insert(promptEvaluations).values({
      id,
      abTestId: input.abTestId,
      version: input.version,
      metric: input.metric,
      value: input.value,
      sampleSize: input.sampleSize,
      note: input.note ?? '',
      createdAt: nowIso(),
    } as never);
    return { id, abTestId: input.abTestId, version: input.version, metric: input.metric, value: input.value, sampleSize: input.sampleSize };
  }

  /** 自动指标：跑一遍结构/长度/变量覆盖，无需人工输入 */
  async autoEvaluate(input: { workspaceId: string; abTestId: string }) {
    const test = await this.getABTest(input.workspaceId, input.abTestId);
    const byName = await this.findTemplateNameByTemplateId(input.workspaceId, test.templateId);
    if (!byName) throw AppError.notFound(`模板不存在: ${test.templateId}`);
    const results = [];
    for (const [version, label] of [
      [test.versionA, 'A'],
      [test.versionB, 'B'],
    ] as const) {
      const detail = await this.detail(input.workspaceId, byName, version);
      const sections = detail.sections;
      const filled = SECTION_KEYS.filter((k) => (sections[k] ?? '').trim()).length;
      const chars = SECTION_KEYS.reduce((s, k) => s + (sections[k] ?? '').length, 0);
      const declared = detail.variables.length;
      const used = extractVariables(sections).length;
      const metrics = [
        { metric: 'structure', value: scoreStructure(filled, SECTION_KEYS.length) },
        { metric: 'length', value: scoreLength(chars) },
        { metric: 'variableCoverage', value: scoreVariableCoverage(declared, used) },
      ];
      for (const m of metrics) {
        await this.recordEvaluation({ workspaceId: input.workspaceId, abTestId: test.id, version: label, metric: m.metric, value: m.value, sampleSize: 1, note: '自动指标' });
      }
      results.push({ version: label, metrics });
    }
    return { abTestId: test.id, results, degraded: false };
  }

  async finishABTest(workspaceId: string, abTestId: string) {
    const test = await this.getABTest(workspaceId, abTestId);
    await this.db.update(promptABTests).set({ status: 'finished', finishedAt: nowIso() } as never).where(eq(promptABTests.id, abTestId));
    return this.report(workspaceId, abTestId, { ...test, status: 'finished' });
  }

  async report(workspaceId: string, abTestId: string, preset?: ABTestRow): Promise<PromptABTestReport> {
    const test = preset ?? (await this.getABTest(workspaceId, abTestId));
    const evals = (await this.db.select().from(promptEvaluations).where(eq(promptEvaluations.abTestId, abTestId))) as unknown as EvalRow[];
    const toInput = (label: 'A' | 'B', version: number) => ({
      version: label,
      metrics: evals
        .filter((e) => e.version === label)
        .map((e) => ({ metric: e.metric, value: e.value, sampleSize: e.sampleSize })),
    });
    const decided = decide({ versionA: toInput('A', test.versionA), versionB: toInput('B', test.versionB) });
    return {
      test: { ...test, status: test.status },
      evaluations: evals.map((e) => ({ id: e.id, abTestId: e.abTestId, version: e.version, metric: e.metric, value: e.value, sampleSize: e.sampleSize, note: e.note, createdAt: e.createdAt })),
      summary: decided.summary,
      winner: decided.winner,
      reason: decided.reason,
    };
  }

  async listABTests(workspaceId: string) {
    const rows = (await this.db.select().from(promptABTests)) as unknown as ABTestRow[];
    if (rows.length === 0) return [];
    // templateId 属于本工作区才返回
    const tpls = (await this.db.select().from(promptTemplates).where(eq(promptTemplates.workspaceId, workspaceId))) as unknown as TemplateRow[];
    const ids = new Set(tpls.map((t) => t.id));
    return rows.filter((r) => ids.has(r.templateId));
  }

  private async getABTest(workspaceId: string, abTestId: string): Promise<ABTestRow> {
    const rows = (await this.db.select().from(promptABTests).where(eq(promptABTests.id, abTestId)).limit(1)) as unknown as ABTestRow[];
    const row = rows[0];
    if (!row) throw AppError.notFound(`A/B 测试不存在: ${abTestId}`);
    const tpl = (await this.db.select().from(promptTemplates).where(eq(promptTemplates.id, row.templateId)).limit(1)) as unknown as TemplateRow[];
    if (tpl[0]?.workspaceId !== workspaceId) throw AppError.notFound(`A/B 测试不存在: ${abTestId}`);
    return row;
  }

  private async findTemplateNameByTemplateId(workspaceId: string, templateId: string): Promise<string | null> {
    const rows = (await this.db.select().from(promptTemplates).where(eq(promptTemplates.workspaceId, workspaceId))) as unknown as TemplateRow[];
    return rows.find((r) => r.id === templateId)?.name ?? null;
  }

  /** 供 UI 展示的指标元数据 */
  metricCatalog() {
    return {
      manual: ['accuracy', 'clarity', 'usefulness'].map((k) => ({ metric: k, label: METRIC_LABELS[k], range: [1, 5] as [number, number] })),
      auto: ['structure', 'length', 'variableCoverage'].map((k) => ({ metric: k, label: METRIC_LABELS[k], range: [0, 5] as [number, number] })),
    };
  }
}

function parseSections(raw: string): PromptSections | null {
  try {
    const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    if (parsed.__degraded === true) return null;
    const out = emptySections();
    let filled = 0;
    for (const k of SECTION_KEYS) {
      const v = parsed[k];
      out[k] = typeof v === 'string' ? v : '';
      if (out[k].trim()) filled += 1;
    }
    return filled > 0 ? out : null;
  } catch (e) {
    logger.debug('prompt json parse failed', { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

import { METRIC_LABELS } from './promptABTest.ts';

export type TemplateRow = typeof promptTemplates.$inferSelect;
export type VersionRow = typeof promptVersions.$inferSelect;
export type VariableRow = typeof promptVariables.$inferSelect;
export type ABTestRow = typeof promptABTests.$inferSelect;
export type EvalRow = typeof promptEvaluations.$inferSelect;
