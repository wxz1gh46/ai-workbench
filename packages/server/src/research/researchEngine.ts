/**
 * ResearchEngine：深度研究编排器。
 *
 * 流程（验收要求 11 步）：
 *   1 生成查询 → 2 搜索 → 3 抓取 → 4 提取 → 5 交叉验证 →
 *   6 分析 → 7 写提纲 → 8 写报告 → 9 加引用 → 10 生成图表 → 11 导出
 *
 * 每个阶段都：
 * - 更新 job 进度并广播事件（UI 可实时展示研究进度）
 * - 落原始来源（可溯源）
 * - 失败时给出可读错误，绝不静默产出空报告
 */
import { desc, eq } from 'drizzle-orm';
import {
  EventType,
  type OfficeFormat,
  type ResearchClaim,
  type ResearchJob,
  type ResearchReport,
  type ResearchSource,
} from '@ai/shared';
import type { Db } from '../db/client.ts';
import { researchClaims, researchJobs, researchReports, researchSources } from '../db/schema/index.ts';
import { config } from '../config.ts';
import { eventBus } from '../events/bus.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';
import { AuditService } from '../services/audit.ts';
import { WorkspaceService } from '../services/workspace.ts';
import { OfficeService } from '../office/officeService.ts';
import { buildQueries, isPaywalledDomain, search, searchEnabled } from './search.ts';
import { fetchAll } from './fetch.ts';
import { crossValidate, validationSummary } from './crossValidate.ts';
import { buildReport, buildResearchSlides, renderReportHtml } from './report.ts';

export interface CreateResearchInput {
  workspaceId: string;
  topic: string;
  depth?: 'quick' | 'standard' | 'deep';
  outputFormats?: OfficeFormat[];
  allowNetwork?: boolean;
  maxSources?: number;
  /** 本地检索用的候选文件（相对路径） */
  localFiles?: string[];
}

const RELIABILITY_BY_ORIGIN: Record<'web' | 'local' | 'knowledge', number> = {
  web: 0.7,
  local: 0.85,
  knowledge: 0.2,
};

/** 提升可信度：政府/官方/学术/主流媒体域 */
const HIGH_TRUST = [/\.gov(\.|$)/i, /\.edu(\.|$)/i, /\.org(\.|$)/i, /nature\.com/i, /science\.org/i, /ieee\.org/i, /who\.int/i];

export class ResearchEngine {
  private readonly audit: AuditService;
  private readonly workspaceService: WorkspaceService;
  private readonly office: OfficeService;

  constructor(private readonly db: Db) {
    this.audit = new AuditService(db);
    this.workspaceService = new WorkspaceService(db);
    this.office = new OfficeService(db);
  }

  /** 能力探测：告诉 UI 当前能用哪些研究能力，避免用户误以为联网可用 */
  capability(): { network: boolean; hint: string; maxSources: number } {
    const network = searchEnabled();
    return {
      network,
      hint: network
        ? '已配置检索端点，可在用户显式允许后联网检索（遵守 robots.txt）'
        : '未配置 RESEARCH_SEARCH_ENDPOINT：研究将在本地素材范围内进行，或产出「待核查问题」清单。配置自建检索服务（如 SearXNG）后启用联网。',
      maxSources: config.research.fetchConcurrency * 8,
    };
  }

  async create(input: CreateResearchInput, opts: { runInBackground?: boolean; localFiles?: string[] } = {}): Promise<ResearchJob> {
    const ws = await this.workspaceService.getById(input.workspaceId);
    const depth = input.depth ?? 'standard';
    const now = nowIso();
    const id = newId('rj');
    const queries = buildQueries(input.topic, depth);

    await this.db.insert(researchJobs).values({
      id,
      workspaceId: ws.id,
      topic: input.topic,
      depth,
      status: 'pending',
      queries,
      progress: 0,
      stage: '已创建，等待开始',
      outputFormats: input.outputFormats ?? ['markdown'],
      allowNetwork: input.allowNetwork === true,
      error: null,
      createdAt: now,
      finishedAt: null,
    });

    await this.audit.record({
      workspaceId: ws.id,
      actor: 'user',
      action: 'research.create',
      targetType: 'research_job',
      targetId: id,
      confirmedByUser: true,
      detail: { topic: input.topic, depth, allowNetwork: input.allowNetwork === true, queries: queries.length },
    });

    if (opts.runInBackground !== false) {
      void this.run(id, { allowNetwork: input.allowNetwork === true, maxSources: input.maxSources, localFiles: opts.localFiles ?? input.localFiles }).catch((e) => {
        logger.error('research run failed', { jobId: id, error: e instanceof Error ? e.message : String(e) });
      });
    }
    return this.get(id);
  }

  async get(jobId: string): Promise<ResearchJob> {
    const row = (await this.db.select().from(researchJobs).where(eq(researchJobs.id, jobId)).limit(1))[0];
    if (!row) throw AppError.notFound(`研究任务不存在: ${jobId}`);
    return {
      ...row,
      depth: row.depth as ResearchJob['depth'],
      status: row.status as ResearchJob['status'],
      queries: row.queries,
      outputFormats: row.outputFormats as OfficeFormat[],
      allowNetwork: row.allowNetwork,
    };
  }

  async list(workspaceId: string, limit = 50): Promise<ResearchJob[]> {
    const rows = await this.db
      .select()
      .from(researchJobs)
      .where(eq(researchJobs.workspaceId, workspaceId))
      .orderBy(desc(researchJobs.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      ...row,
      depth: row.depth as ResearchJob['depth'],
      status: row.status as ResearchJob['status'],
      queries: row.queries,
      outputFormats: row.outputFormats as OfficeFormat[],
      allowNetwork: row.allowNetwork,
    }));
  }

  async listSources(jobId: string): Promise<ResearchSource[]> {
    return (await this.db.select().from(researchSources).where(eq(researchSources.researchJobId, jobId))) as ResearchSource[];
  }

  async listClaims(jobId: string): Promise<ResearchClaim[]> {
    return (await this.db.select().from(researchClaims).where(eq(researchClaims.researchJobId, jobId))) as ResearchClaim[];
  }

  async getReport(jobId: string): Promise<ResearchReport | null> {
    const row = (await this.db.select().from(researchReports).where(eq(researchReports.researchJobId, jobId)).limit(1))[0];
    if (!row) return null;
    return {
      id: row.id,
      researchJobId: row.researchJobId,
      markdown: row.markdown,
      charts: row.charts as ResearchReport['charts'],
      references: row.referencesJson,
      markdownPath: row.markdownPath,
      pdfPath: row.pdfPath,
      pptxPath: row.pptxPath,
      webUrl: row.webUrl,
      createdAt: row.createdAt,
    };
  }

  /** 执行完整研究流程 */
  async run(jobId: string, opts: { allowNetwork?: boolean; maxSources?: number; localFiles?: string[] } = {}): Promise<ResearchJob> {
    const job = await this.get(jobId);
    const ws = await this.workspaceService.getById(job.workspaceId);
    const maxSources = Math.min(opts.maxSources ?? 20, 60);
    const startedProgress: number[] = [];

    const setStage = async (status: ResearchJob['status'], progress: number, stage: string) => {
      startedProgress.push(progress);
      await this.db.update(researchJobs).set({ status, progress, stage }).where(eq(researchJobs.id, jobId));
      eventBus.publishBuffered(EventType.RESEARCH_PROGRESS, { jobId, status, progress, stage }, { workspaceId: ws.id, goalId: null, taskId: null });
    };

    try {
      if (job.status === 'completed') return job;

      /* 2) 搜索 */
      await setStage('searching', 10, `已生成 ${job.queries.length} 条检索式，开始检索`);
      const hits = await search(job.queries, {
        maxResults: maxSources,
        workspaceRoot: ws.rootPath,
        ...(opts.localFiles && opts.localFiles.length > 0 ? { localFiles: opts.localFiles } : {}),
        allowNetwork: opts.allowNetwork === true,
      });
      if (hits.length === 0) {
        await this.finish(jobId, 'failed', '检索未返回任何来源（可能是主题过窄或未配置检索服务）');
        return this.get(jobId);
      }

      /* 3) 抓取 */
      await setStage('fetching', 25, `共 ${hits.length} 个候选来源，开始合规抓取`);
      const webHits = hits.filter((h) => h.origin === 'web' && !h.requiresAuth);
      const blockedAuth = hits.filter((h) => h.requiresAuth);
      const fetched = await fetchAll(webHits.map((h) => h.url));
      const fetchMap = new Map(fetched.map((f) => [f.url, f]));

      /* 4) 提取：落来源（含被 robots 拒绝的原因，留痕可审计） */
      await setStage('extracting', 45, `抓取完成，提取正文（被拒绝 ${fetched.filter((f) => !f.ok).length} 个）`);
      const sourceRows: ResearchSource[] = [];
      const now = nowIso();

      for (const hit of hits) {
        const page = hit.origin === 'web' ? fetchMap.get(hit.url) : undefined;
        const isKnowledge = hit.origin === 'knowledge';
        const content = page ? (page.ok ? page.text : `[未抓取] ${page.blockedReason ?? ''}`) : hit.snippet;
        const reliability = computeReliability(hit.origin, hit.url, page?.ok === true, hit.requiresAuth);
        sourceRows.push({
          id: newId('rsrc'),
          researchJobId: jobId,
          url: hit.url,
          title: page?.title || hit.title,
          snippet: (page?.snippet || hit.snippet).slice(0, 1200),
          content: content.slice(0, 100_000),
          accessedAt: now,
          reliability,
          requiresAuth: hit.requiresAuth,
        });
      }
      if (sourceRows.length > 0) await this.db.insert(researchSources).values(sourceRows);
      for (const s of sourceRows) {
        eventBus.publishBuffered(EventType.RESEARCH_SOURCE, { jobId, url: s.url, title: s.title, reliability: s.reliability }, { workspaceId: ws.id, goalId: null, taskId: null });
      }

      /* 5) 交叉验证 */
      await setStage('validating', 60, '多源交叉验证，标记冲突');
      // 只有真正抓到内容的来源参与事实判定（未抓取的来源不能作为证据）
      const usable = sourceRows.filter((s) => !s.content.startsWith('[未抓取]') && !s.url.startsWith('knowledge://'));
      const claims = crossValidate(usable);
      if (claims.length > 0) await this.db.insert(researchClaims).values(claims);
      const summary = validationSummary(claims);
      const disputed = claims.filter((c) => c.disputed).length;

      await this.audit.record({
        workspaceId: ws.id,
        actor: 'researcher',
        action: 'research.validate',
        targetType: 'research_job',
        targetId: jobId,
        confirmedByUser: true,
        detail: { sources: sourceRows.length, usable: usable.length, claims: claims.length, disputed, blockedByAuth: blockedAuth.length, blockedByRobots: fetched.filter((f) => !f.ok).length },
      });

      /* 6~10) 分析 + 提纲 + 报告 + 引用 + 图表 */
      await setStage('analyzing', 75, `交叉验证完成：${claims.length} 条论断，${disputed} 条存在冲突`);
      const report = await buildReport({ topic: job.topic, sources: sourceRows, claims, depth: job.depth });

      await setStage('writing', 88, '撰写结构化报告并附引用与图表');
      const reportId = newId('rrep');
      await this.db.insert(researchReports).values({
        id: reportId,
        researchJobId: jobId,
        markdown: report.markdown,
        charts: report.charts,
        referencesJson: report.citations.map((c) => ({
          index: c.index,
          sourceId: c.sourceId,
          title: c.title,
          url: c.url,
          accessedAt: c.accessedAt,
          snippet: c.snippet,
        })),
        markdownPath: null,
        pdfPath: null,
        pptxPath: null,
        webUrl: null,
        createdAt: nowIso(),
      });

      /* 11) 导出：markdown / pdf / pptx（仅在指定格式时生成） */
      await setStage('writing', 94, '导出报告文件');
      const exportWarnings = await this.exportReport(job, reportId, report.markdown, report.charts);

      const final = await this.finish(jobId, 'completed', null);
      eventBus.publishBuffered(
        EventType.RESEARCH_REPORT,
        { jobId, reportId, charts: report.charts.length, citations: report.citations.length, disputed, degraded: report.degraded, exportWarnings },
        { workspaceId: ws.id, goalId: null, taskId: null },
      );
      logger.info('research completed', { jobId, sources: sourceRows.length, claims: claims.length, disputed, degraded: report.degraded });
      return final;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error('research failed', { jobId, error: msg });
      await this.finish(jobId, 'failed', msg);
      throw AppError.internal(`研究执行失败：${msg}`);
    }
  }

  /** 生成 md / pdf / pptx 产物，并把路径写回报告记录 */
  private async exportReport(job: ResearchJob, reportId: string, markdown: string, charts: { title: string; kind: string; data: unknown }[]): Promise<string[]> {
    const warnings: string[] = [];
    const ws = await this.workspaceService.getById(job.workspaceId);
    if (!ws.rootPath) {
      warnings.push('工作区未配置 rootPath，跳过文件导出（报告仍可在页面查看与复制）');
      return warnings;
    }
    const ctx = { workspaceId: ws.id, workspaceRoot: ws.rootPath };
    const formats = job.outputFormats.length > 0 ? job.outputFormats : (['markdown'] as OfficeFormat[]);
    const safeTopic = job.topic.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    const updates: Partial<{ markdownPath: string; pdfPath: string; pptxPath: string }> = {};

    try {
      const chunks = charts.map((c) => (c.data as { mermaid?: string }).mermaid ?? '').filter(Boolean).join('\n\n');
      const mdBody = chunks ? `${markdown}\n\n## 图表源码\n\n${chunks}\n` : markdown;
      const md = await this.office.generate(ctx, {
        format: 'markdown',
        title: `研究报告-${safeTopic}`,
        content: mdBody,
        outputPath: `research/${safeTopic}/report.md`,
      });
      updates.markdownPath = md.path;
    } catch (e) {
      warnings.push(`Markdown 导出失败：${e instanceof Error ? e.message : String(e)}`);
    }

    for (const format of formats) {
      if (format === 'markdown') continue;
      try {
        if (format === 'pptx') {
          const slides = buildResearchSlides(job.topic, markdown);
          const r = await this.office.generate(ctx, { format: 'pptx', title: `研究报告-${safeTopic}`, content: markdown, slides, outputPath: `research/${safeTopic}/report.pptx` });
          updates.pptxPath = r.path;
        } else if (format === 'pdf') {
          const r = await this.office.generate(ctx, { format: 'pdf', title: `研究报告-${safeTopic}`, content: markdown.slice(0, 20_000), outputPath: `research/${safeTopic}/report.pdf` });
          updates.pdfPath = r.path;
          if (r.warnings.length > 0) warnings.push(...r.warnings);
        } else if (format === 'docx' || format === 'xlsx') {
          const r = await this.office.generate(ctx, {
            format,
            title: `研究报告-${safeTopic}`,
            content: markdown,
            ...(format === 'xlsx' ? { sheets: [{ name: '结论', rows: [['论断', '置信度'], ...extractClaimRows(markdown)] }] } : {}),
            outputPath: `research/${safeTopic}/report.${format}`,
          });
          if (format === 'docx') updates.pdfPath = updates.pdfPath ?? null as unknown as string;
          void r;
        }
      } catch (e) {
        warnings.push(`${format} 导出失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const patch: Record<string, string> = {};
    if (updates.markdownPath) patch.markdownPath = updates.markdownPath;
    if (updates.pdfPath) patch.pdfPath = updates.pdfPath;
    if (updates.pptxPath) patch.pptxPath = updates.pptxPath;
    if (Object.keys(patch).length > 0) {
      await this.db.update(researchReports).set(patch).where(eq(researchReports.id, reportId));
    }
    return warnings;
  }

  /** 发布为网页（本地 preview 型 URL，可由 UI 直接打开） */
  async publish(jobId: string, opts: { public?: boolean } = {}): Promise<{ webUrl: string; reportId: string }> {
    const job = await this.get(jobId);
    const report = await this.getReport(jobId);
    if (!report) throw AppError.badRequest('报告尚未生成，无法发布');
    const ws = await this.workspaceService.getById(job.workspaceId);
    const ctx = { workspaceId: ws.id, workspaceRoot: ws.rootPath };
    const safeTopic = job.topic.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);

    // 发布产物是一份自包含 HTML：可离线打开，也可部署到任意静态托管
    const html = renderReportHtml(job, report);
    let webUrl: string;
    if (ws.rootPath) {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const pathMod = await import('node:path');
      const rel = `research/${safeTopic}/index.html`;
      const abs = pathMod.join(ws.rootPath, rel);
      await mkdir(pathMod.dirname(abs), { recursive: true });
      await writeFile(abs, html, 'utf8');
      webUrl = `file://${abs}`;
    } else {
      webUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
    }

    await this.db.update(researchReports).set({ webUrl }).where(eq(researchReports.id, report.id));
    await this.audit.record({
      workspaceId: ws.id,
      actor: 'user',
      action: 'research.publish',
      targetType: 'research_report',
      targetId: report.id,
      confirmedByUser: true,
      detail: { jobId, public: opts.public === true, webUrl: webUrl.startsWith('data:') ? '(inline html)' : webUrl },
    });
    eventBus.publishBuffered(EventType.RESEARCH_REPORT, { jobId, webUrl, published: true }, { workspaceId: ws.id, goalId: null, taskId: null });
    void ctx;
    return { webUrl, reportId: report.id };
  }

  async cancel(jobId: string): Promise<ResearchJob> {
    const job = await this.get(jobId);
    if (job.status === 'completed') throw AppError.conflict('研究已完成，无法取消');
    await this.db.update(researchJobs).set({ status: 'cancelled', finishedAt: nowIso(), stage: '被用户取消' }).where(eq(researchJobs.id, jobId));
    await this.audit.record({
      workspaceId: job.workspaceId,
      actor: 'user',
      action: 'research.cancel',
      targetType: 'research_job',
      targetId: jobId,
      confirmedByUser: true,
      detail: { topic: job.topic },
    });
    return this.get(jobId);
  }

  private async finish(jobId: string, status: ResearchJob['status'], error: string | null): Promise<ResearchJob> {
    const job = await this.get(jobId);
    const sources = await this.listSources(jobId);
    const claims = await this.listClaims(jobId);
    await this.db
      .update(researchJobs)
      .set({
        status,
        progress: status === 'completed' ? 100 : job.progress,
        stage: status === 'completed' ? '已完成' : `失败：${error ?? '未知错误'}`,
        sourceCount: sources.length,
        claimCount: claims.length,
        disputedCount: claims.filter((c) => c.disputed).length,
        error,
        finishedAt: nowIso(),
      })
      .where(eq(researchJobs.id, jobId));
    eventBus.publishBuffered(EventType.RESEARCH_PROGRESS, { jobId, status, progress: status === 'completed' ? 100 : job.progress, error }, { workspaceId: job.workspaceId, goalId: null, taskId: null });
    return this.get(jobId);
  }
}

/** 可信度推断：来源类型 + 域名权威性 + 是否成功抓取 */
export function computeReliability(origin: 'web' | 'local' | 'knowledge', url: string, fetchedOk: boolean, requiresAuth: boolean): number {
  let base = RELIABILITY_BY_ORIGIN[origin];
  if (origin === 'web') {
    if (HIGH_TRUST.some((re) => re.test(url))) base += 0.15;
    if (isPaywalledDomain(url)) base -= 0.1;
    if (!fetchedOk) base -= 0.25;
  }
  if (requiresAuth) base -= 0.1;
  return Number(Math.max(0.05, Math.min(0.98, base)).toFixed(2));
}

/**
 * 从报告 markdown 抽结论表格行（用于 xlsx 导出）。
 * 只取「关键结论速览」小节下的要点，避免把建议当成结论。
 */
export function extractClaimRows(markdown: string): (string | number)[][] {
  const rows: (string | number)[][] = [];
  const start = markdown.indexOf('## 关键结论速览');
  if (start === -1) return rows;
  const nextHeading = markdown.indexOf('\n## ', start + 5);
  const section = markdown.slice(start, nextHeading === -1 ? undefined : nextHeading);
  for (const line of section.split('\n')) {
    const m = line.match(/^- (.+?)(?: \[\d+\])?(?: ⚠️.+)?$/);
    if (m?.[1] && rows.length < 50) {
      rows.push([m[1].slice(0, 200), line.includes('⚠️') ? '存在冲突' : '—']);
    }
  }
  return rows;
}
