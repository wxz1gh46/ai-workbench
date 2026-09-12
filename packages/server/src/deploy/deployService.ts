import { desc, eq } from 'drizzle-orm';
import { EventType, type WebsiteDeployment, type WebsitePlan, type WebsiteProject } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { websiteBuilds, websiteDeployments, websiteProjects } from '../db/schema/index.ts';
import { EventType as ET } from '@ai/shared';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';
import { safeJoin } from '../tools/fs-tools.ts';
import { eventBus } from '../events/bus.ts';
import { workspaceRoot } from '../services/workspace.ts';
import { DeployLogChannel } from './deployLog.ts';
import { getAdapter, listCapabilities, testAll } from './providerRegistry.ts';
import { EnvManager } from './envManager.ts';
import { AccessControlService } from './accessControl.ts';
import { DomainManager, validateDomain, summarizeBinding, type DomainBinding } from './domainManager.ts';
import { generateFiles, resolveEntry, writeProject } from './websiteGenerator.ts';
import { parseRequirement } from './requirements.ts';
import { DeployAuditor } from '../audit/index.ts';
import { NotifyService } from '../notify/notifyService.ts';

/**
 * 部署服务（Step 1 + Step 3 编排）。
 *
 * 一次完整链路：
 *   建项目 → /generate（需求解析 + 落盘 + Build 记录）
 *          → /deploy（选平台 → 适配器部署 → 记录 Deployment + 审计 + 通知）
 *          → /rollback / /domain / /access / DELETE
 *
 * 所有外部调用都写审计；危险动作先过 dangerGate。
 */
export class DeployService {
  private readonly env: EnvManager;
  private readonly acl: AccessControlService;
  /** 部署中的日志通道：deploymentId → 通道（供流式查询与 finalize） */
  private readonly channels = new Map<string, DeployLogChannel>();

  constructor(private readonly db: Db) {
    this.env = new EnvManager(db);
    this.acl = new AccessControlService(db);
  }

  private auditor() {
    return new DeployAuditor(this.db);
  }

  /* ----------------------------- 项目 ----------------------------- */

  async createProject(input: {
    workspaceId: string;
    name: string;
    description?: string;
    requirement?: string;
    databaseConnectionId?: string | null;
    actor?: string;
  }): Promise<WebsiteProject> {
    const name = input.name.trim();
    if (!name) throw AppError.badRequest('项目名称不能为空');
    if (name.length > 120) throw AppError.badRequest('项目名称过长（≤120）');
    const now = nowIso();
    const row = {
      id: newId('wsp'),
      workspaceId: input.workspaceId,
      name,
      description: input.description ?? '',
      type: 'static' as const,
      framework: 'vanilla-html',
      status: 'draft' as const,
      requirement: input.requirement ?? '',
      plan: {} as Record<string, unknown>,
      rootDir: null,
      entryFile: null,
      previewUrl: null,
      databaseConnectionId: input.databaseConnectionId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(websiteProjects).values(row);
    await this.auditor().record({
      workspaceId: input.workspaceId,
      action: 'website.create',
      actor: input.actor ?? 'user',
      websiteProjectId: row.id,
      confirmedByUser: true,
      detail: { name, databaseConnectionId: row.databaseConnectionId },
    });
    logger.info('website project created', { id: row.id, name });
    return row as unknown as WebsiteProject;
  }

  async listProjects(workspaceId: string): Promise<WebsiteProject[]> {
    const rows = await this.db.select().from(websiteProjects).where(eq(websiteProjects.workspaceId, workspaceId)).orderBy(desc(websiteProjects.createdAt));
    return rows.filter((r) => r.status !== 'deleted') as unknown as WebsiteProject[];
  }

  async getProject(id: string): Promise<WebsiteProject> {
    const rows = await this.db.select().from(websiteProjects).where(eq(websiteProjects.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.status === 'deleted') throw AppError.notFound(`网站项目不存在: ${id}`);
    return row as unknown as WebsiteProject;
  }

  /* --------------------------- Step 1 生成 -------------------------- */

  async generate(input: {
    websiteProjectId: string;
    requirement?: string;
    actor?: string;
  }): Promise<{ project: WebsiteProject; plan: WebsitePlan; files: { path: string; bytes: number }[]; previewCommand: string; rootDir: string }> {
    const project = await this.getProject(input.websiteProjectId);
    const requirement = (input.requirement ?? project.requirement ?? '').trim();
    if (!requirement) throw AppError.badRequest('缺少需求描述：请描述你想要的网站（页面、功能、数据）');

    const plan = await parseRequirement(requirement);
    const channel = new DeployLogChannel(`build-${project.id}`, project.workspaceId);
    channel.info(`需求解析完成：${plan.summary}`);
    channel.info(`页面 ${plan.pages.map((p) => p.path).join(', ')}`);
    if (plan.entities.length > 0) channel.info(`数据实体：${plan.entities.map((e) => e.name).join(', ')}`);
    if (plan.degraded) channel.warn('未配置模型密钥：当前使用规则解析（确定性、离线可用），结果已标注降级');
    channel.info('正在生成项目文件…');

    const files = generateFiles(plan, sanitizeName(project.name), requirement);
    const root = await workspaceRoot(this.db, project.workspaceId);
    const { rootDir, written } = await writeProject(root, sanitizeName(project.name), files);
    const entry = resolveEntry(plan);
    channel.info(`已写入 ${written.length} 个文件到 ${rootDir}`);
    channel.info(`入口文件：${entry.entryFile}；本地运行：${entry.previewCommand}`);

    const version = await this.nextBuildVersion(project.id);
    await this.db.insert(websiteBuilds).values({
      id: newId('wbld'),
      websiteProjectId: project.id,
      version,
      files: written,
      buildLog: channel.textForStorage(),
      status: 'succeeded',
      trigger: 'manual',
      error: null,
      createdAt: nowIso(),
    });

    const existingPlan = (project.plan ?? {}) as Record<string, unknown>;
    await this.db
      .update(websiteProjects)
      .set({
        requirement,
        plan: { ...plan, envVars: existingPlan.envVars ?? [] } as never,
        type: plan.siteType,
        framework: plan.framework,
        rootDir,
        entryFile: entry.entryFile,
        status: 'generated',
        updatedAt: nowIso(),
      })
      .where(eq(websiteProjects.id, project.id));

    await this.auditor().record({
      workspaceId: project.workspaceId,
      action: 'website.generate',
      actor: input.actor ?? 'user',
      websiteProjectId: project.id,
      confirmedByUser: true,
      detail: {
        siteType: plan.siteType,
        framework: plan.framework,
        pages: plan.pages.length,
        entities: plan.entities.length,
        files: written.length,
        degraded: plan.degraded ?? false,
      },
    });

    eventBus.publishBuffered(ET.WEBSITE_GENERATED, { projectId: project.id, plan, files: written }, { workspaceId: project.workspaceId });

    const fresh = await this.getProject(project.id);
    return { project: fresh, plan, files: written, previewCommand: entry.previewCommand, rootDir };
  }

  private async nextBuildVersion(projectId: string): Promise<number> {
    const rows = await this.db.select().from(websiteBuilds).where(eq(websiteBuilds.websiteProjectId, projectId));
    return rows.reduce((max, r) => Math.max(max, r.version), 0) + 1;
  }

  /* --------------------------- Step 3 部署 -------------------------- */

  async deploy(input: {
    websiteProjectId: string;
    provider: WebsiteDeployment['provider'];
    actor?: string;
    confirm: boolean;
  }): Promise<{ deployment: WebsiteDeployment; degraded: boolean; accessPolicy: { mode: string; envKeys: string[]; note: string } }> {
    const project = await this.getProject(input.websiteProjectId);
    const plan = project.plan as unknown as WebsitePlan;
    if (!plan?.pages?.length) throw AppError.badRequest('尚未生成项目：请先执行「生成」再部署');

    const adapter = getAdapter(input.provider);
    const capacity = adapter.capability;
    if (capacity.requiresToken && !adapter.token()) {
      // 不直接失败：返回可读的「未配置」错误，并附带所需环境变量名（用户手动授权）
      await this.auditor().record({
        workspaceId: project.workspaceId,
        action: 'website.deploy.blocked',
        actor: input.actor ?? 'user',
        websiteProjectId: project.id,
        confirmedByUser: input.confirm,
        detail: { provider: input.provider, reason: 'missing-token', tokenEnvKeys: capacity.tokenEnvKeys },
      });
      throw AppError.provider(
        `未配置 ${input.provider} 凭据：请设置环境变量 ${capacity.tokenEnvKeys.join(', ')}（获取地址：${capacity.docsUrl}）后重试。工作台不会替你申请或保存任何平台账号。`,
        { provider: input.provider, tokenEnvKeys: capacity.tokenEnvKeys, docsUrl: capacity.docsUrl },
      );
    }

    const root = await workspaceRoot(this.db, project.workspaceId);
    if (!project.rootDir || !root) throw AppError.badRequest('项目尚未生成到工作区，请先执行「生成」');
    const absRoot = safeJoin(root, project.rootDir);
    const files = await readGeneratedFiles(absRoot, plan);

    const deploymentId = newId('wdep');
    const log = new DeployLogChannel(deploymentId, project.workspaceId);
    this.channels.set(deploymentId, log);
    log.info(`开始部署：项目=${project.name} 平台=${input.provider}`);
    log.info(`产物：${files.length} 个文件`);

    const envVars = await this.env.resolveForDeploy(project.id);
    const envKeys = Object.keys(envVars);
    if (envKeys.length > 0) log.info(`将注入环境变量：${envKeys.join(', ')}（值已加密，日志中不出现明文）`);

    const accessPolicy = await this.acl.toPlatformPolicy(project.id);
    if (accessPolicy.mode !== 'public') log.info(`访问控制：${accessPolicy.note}`);

    const now = nowIso();
    await this.db.insert(websiteDeployments).values({
      id: deploymentId,
      websiteProjectId: project.id,
      provider: input.provider,
      deploymentId: null,
      url: null,
      customDomain: project.plan && (project.plan as { customDomain?: string }).customDomain ? null : null,
      envVars: envKeys.map((k) => ({ key: k, secretRef: `envvar:${k}` })),
      status: 'queued',
      log: '',
      buildId: null,
      rollbackOf: null,
      error: null,
      deployedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    // 日志批量落库：避免每行一次 DB 写
    let lastFlush = 0;
    log.onFlush(() => {
      if (Date.now() - lastFlush < 1000) return;
      lastFlush = Date.now();
      void this.db
        .update(websiteDeployments)
        .set({ log: log.textForStorage(), status: 'building', updatedAt: nowIso() })
        .where(eq(websiteDeployments.id, deploymentId))
        .catch(() => undefined);
    });

    // 本地预览需要知道产物目录
    if (input.provider === 'local-preview') process.env.LOCAL_PREVIEW_ROOT = absRoot;

    let result: { deploymentId: string; url: string; rawSummary: Record<string, unknown>; degraded: boolean };
    try {
      result = await adapter.deploy({ projectName: sanitizeName(project.name), files, envVars, log });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`部署失败：${msg}`);
      await this.db
        .update(websiteDeployments)
        .set({ status: 'failed', error: msg, log: log.textForStorage(), updatedAt: nowIso() })
        .where(eq(websiteDeployments.id, deploymentId));
      await this.db.update(websiteProjects).set({ status: 'failed', updatedAt: nowIso() }).where(eq(websiteProjects.id, project.id));
      await this.auditor().record({
        workspaceId: project.workspaceId,
        action: 'website.deploy.failed',
        actor: input.actor ?? 'user',
        websiteProjectId: project.id,
        deploymentId,
        confirmedByUser: input.confirm,
        detail: { provider: input.provider, error: msg.slice(0, 500) },
      });
      throw e;
    }

    await this.db
      .update(websiteDeployments)
      .set({
        deploymentId: result.deploymentId,
        url: result.url,
        status: 'deployed',
        log: log.textForStorage(),
        deployedAt: nowIso(),
        updatedAt: nowIso(),
      })
      .where(eq(websiteDeployments.id, deploymentId));
    await this.db.update(websiteProjects).set({ status: 'deployed', previewUrl: result.url, updatedAt: nowIso() }).where(eq(websiteProjects.id, project.id));

    await this.auditor().record({
      workspaceId: project.workspaceId,
      action: 'website.deploy',
      actor: input.actor ?? 'user',
      websiteProjectId: project.id,
      deploymentId,
      confirmedByUser: input.confirm,
      detail: {
        provider: input.provider,
        url: result.url,
        degraded: result.degraded,
        envKeys,
        accessMode: accessPolicy.mode,
        raw: result.rawSummary,
      },
    });

    eventBus.publishBuffered(
      EventType.DEPLOY_STATUS,
      { deploymentId, provider: input.provider, status: 'deployed', url: result.url },
      { workspaceId: project.workspaceId },
    );

    // 部署完成推送（Step 6 接线）
    void new NotifyService(this.db)
      .dispatch({
        workspaceId: project.workspaceId,
        message: {
          event: 'deploy',
          level: result.degraded ? 'warning' : 'success',
          title: `网站已部署：${project.name}`,
          content: `平台：${input.provider}\n地址：${result.url || '（本地预览）'}${result.degraded ? '\n注意：本次为本地降级预览，未真正发布到公网' : ''}`,
          url: result.url || undefined,
        },
      })
      .catch((e) => logger.warn('deploy notify failed', { error: e instanceof Error ? e.message : String(e) }));

    const rows = await this.db.select().from(websiteDeployments).where(eq(websiteDeployments.id, deploymentId)).limit(1);
    return { deployment: rows[0] as unknown as WebsiteDeployment, degraded: result.degraded, accessPolicy };
  }

  async listDeployments(websiteProjectId: string): Promise<WebsiteDeployment[]> {
    const rows = await this.db
      .select()
      .from(websiteDeployments)
      .where(eq(websiteDeployments.websiteProjectId, websiteProjectId))
      .orderBy(desc(websiteDeployments.createdAt));
    return rows as unknown as WebsiteDeployment[];
  }

  /** 流式日志：按 deploymentId 取实时日志行（WS 之外还可轮询） */
  logs(deploymentId: string): { lines: { at: string; level: string; msg: string }[]; live: boolean } {
    const channel = this.channels.get(deploymentId);
    if (!channel) return { lines: [], live: false };
    return { lines: channel.toArray(), live: true };
  }

  async rollback(input: { websiteProjectId: string; deploymentId: string; actor?: string; confirm: boolean }): Promise<WebsiteDeployment> {
    const project = await this.getProject(input.websiteProjectId);
    const rows = await this.db.select().from(websiteDeployments).where(eq(websiteDeployments.id, input.deploymentId)).limit(1);
    const target = rows[0];
    if (!target || target.websiteProjectId !== project.id) throw AppError.notFound(`部署记录不存在: ${input.deploymentId}`);
    if (!target.deploymentId) throw AppError.badRequest('该部署没有平台侧 id（本地预览不支持回滚）');

    const adapter = getAdapter(target.provider);
    const log = new DeployLogChannel(newId('wdep'), project.workspaceId);
    log.info(`回滚到 ${target.provider} 的部署 ${target.deploymentId}`);
    const result = await adapter.rollback(target.deploymentId, log);

    const now = nowIso();
    const id = newId('wdep');
    await this.db.insert(websiteDeployments).values({
      id,
      websiteProjectId: project.id,
      provider: target.provider,
      deploymentId: target.deploymentId,
      url: result.url || target.url,
      customDomain: target.customDomain,
      envVars: target.envVars,
      status: 'rolled-back',
      log: log.textForStorage(),
      buildId: target.buildId,
      rollbackOf: target.id,
      error: null,
      deployedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await this.db.update(websiteProjects).set({ previewUrl: result.url || target.url, status: 'deployed', updatedAt: now }).where(eq(websiteProjects.id, project.id));

    await this.auditor().record({
      workspaceId: project.workspaceId,
      action: 'website.rollback',
      actor: input.actor ?? 'user',
      websiteProjectId: project.id,
      deploymentId: id,
      confirmedByUser: input.confirm,
      detail: { rollbackOf: target.id, provider: target.provider, degraded: result.degraded },
    });

    eventBus.publishBuffered(
      EventType.DEPLOY_STATUS,
      { deploymentId: id, provider: target.provider, status: 'rolled-back', url: result.url },
      { workspaceId: project.workspaceId },
    );

    const fresh = await this.db.select().from(websiteDeployments).where(eq(websiteDeployments.id, id)).limit(1);
    return fresh[0] as unknown as WebsiteDeployment;
  }

  async deleteDeployment(input: { websiteProjectId: string; deploymentId: string; actor?: string; confirm: boolean }): Promise<{ ok: boolean; message: string; degraded: boolean }> {
    const project = await this.getProject(input.websiteProjectId);
    const rows = await this.db.select().from(websiteDeployments).where(eq(websiteDeployments.id, input.deploymentId)).limit(1);
    const target = rows[0];
    if (!target || target.websiteProjectId !== project.id) throw AppError.notFound(`部署记录不存在: ${input.deploymentId}`);

    const log = new DeployLogChannel(input.deploymentId, project.workspaceId);
    const adapter = getAdapter(target.provider);
    const res = target.deploymentId
      ? await adapter.remove(target.deploymentId, log)
      : { ok: true, message: '该部署没有平台侧记录，仅清理本地记录', degraded: false };

    await this.db
      .update(websiteDeployments)
      .set({ status: 'deleted', log: log.textForStorage(), error: res.ok ? null : res.message, updatedAt: nowIso() })
      .where(eq(websiteDeployments.id, input.deploymentId));

    await this.auditor().record({
      workspaceId: project.workspaceId,
      action: 'deployment.delete',
      actor: input.actor ?? 'user',
      websiteProjectId: project.id,
      deploymentId: input.deploymentId,
      confirmedByUser: input.confirm,
      detail: { provider: target.provider, ok: res.ok, degraded: res.degraded },
    });
    return res;
  }

  async deleteProject(input: { websiteProjectId: string; actor?: string; confirm: boolean }): Promise<{ ok: boolean; deployments: number }> {
    const project = await this.getProject(input.websiteProjectId);
    const dels = await this.listDeployments(project.id);
    let removed = 0;
    for (const d of dels) {
      if (d.status === 'deleted') continue;
      if (d.deploymentId) {
        const log = new DeployLogChannel(d.id, project.workspaceId);
        const adapter = getAdapter(d.provider);
        // 删除是尽力而为：平台侧失败不阻断本地清理，但会记录
        const res = await adapter.remove(d.deploymentId, log).catch((e) => ({ ok: false, degraded: false, message: e instanceof Error ? e.message : String(e) }));
        await this.db
          .update(websiteDeployments)
          .set({ status: res.ok ? 'deleted' : 'failed', error: res.ok ? null : res.message, log: log.textForStorage(), updatedAt: nowIso() })
          .where(eq(websiteDeployments.id, d.id));
        if (res.ok) removed += 1;
      }
    }
    await this.db.update(websiteProjects).set({ status: 'deleted', updatedAt: nowIso() }).where(eq(websiteProjects.id, project.id));
    await this.auditor().record({
      workspaceId: project.workspaceId,
      action: 'website.delete',
      actor: input.actor ?? 'user',
      websiteProjectId: project.id,
      confirmedByUser: input.confirm,
      detail: { deploymentsRemoved: removed, deploymentsTotal: dels.length },
    });
    return { ok: true, deployments: removed };
  }

  /* ------------------------ 域名 / 访问控制 ------------------------ */

  async bindDomain(input: { websiteProjectId: string; domain: string; provider?: WebsiteDeployment['provider']; actor?: string; confirm: boolean }): Promise<DomainBinding> {
    const project = await this.getProject(input.websiteProjectId);
    const domain = validateDomain(input.domain);
    const provider = input.provider ?? 'vercel';

    const adapter = getAdapter(provider);
    const log = new DeployLogChannel(`domain-${project.id}`, project.workspaceId);
    const res = await adapter.bindDomain(domain, log).catch((e) => ({
      ok: false,
      degraded: adapter.token() === null,
      message: e instanceof Error ? e.message : String(e),
      dns: undefined as undefined | { type: string; name: string; value: string }[],
    }));
    const binding = summarizeBinding(domain, { ...res, dns: res.dns ?? DomainManager.guide(domain, provider).dns });

    const plan = { ...(project.plan as Record<string, unknown>), customDomain: domain };
    await this.db.update(websiteProjects).set({ plan: plan as never, updatedAt: nowIso() }).where(eq(websiteProjects.id, project.id));

    await this.auditor().record({
      workspaceId: project.workspaceId,
      action: 'domain.bind',
      actor: input.actor ?? 'user',
      websiteProjectId: project.id,
      confirmedByUser: input.confirm,
      detail: { domain, provider, ok: res.ok, degraded: res.degraded, dns: binding.dns },
    });

    eventBus.publishBuffered(EventType.WEBSITE_UPDATED, { projectId: project.id, customDomain: domain, binding }, { workspaceId: project.workspaceId });
    return binding;
  }

  async setAccess(input: { websiteProjectId: string; rules: { type: 'password' | 'email-allowlist' | 'ip-allowlist'; value: string }[]; actor?: string; confirm: boolean }) {
    const project = await this.getProject(input.websiteProjectId);
    const result = await this.acl.set(project.id, input.rules);
    await this.auditor().record({
      workspaceId: project.workspaceId,
      action: 'access.update',
      actor: input.actor ?? 'user',
      websiteProjectId: project.id,
      confirmedByUser: input.confirm,
      // 只记录类型与数量，绝不记录口令/IP/邮箱明细以外的敏感信息
      detail: { types: result.types, count: result.count },
    });
    return result;
  }

  async getAccess(websiteProjectId: string) {
    return this.acl.list(websiteProjectId);
  }

  async envVars(websiteProjectId: string) {
    const { public: list } = await this.env.list(websiteProjectId);
    return list;
  }

  async setEnvVars(input: { websiteProjectId: string; vars: { key: string; value: string }[]; actor?: string; confirm: boolean }) {
    const project = await this.getProject(input.websiteProjectId);
    const res = await this.env.set(project.id, input.vars);
    await this.auditor().record({
      workspaceId: project.workspaceId,
      action: 'website.env.update',
      actor: input.actor ?? 'user',
      websiteProjectId: project.id,
      confirmedByUser: input.confirm,
      // 审计只留变量名，不留值
      detail: { keys: res.keys, replaced: res.replaced },
    });
    return res;
  }

  async removeEnvVar(input: { websiteProjectId: string; key: string; actor?: string; confirm: boolean }) {
    const project = await this.getProject(input.websiteProjectId);
    await this.env.remove(project.id, input.key);
    await this.auditor().record({
      workspaceId: project.workspaceId,
      action: 'website.env.remove',
      actor: input.actor ?? 'user',
      websiteProjectId: project.id,
      confirmedByUser: input.confirm,
      detail: { key: input.key },
    });
    return { ok: true };
  }

  /* ------------------------------ 能力 ------------------------------ */

  capabilities() {
    return listCapabilities();
  }

  async testProviders() {
    return testAll();
  }
}

/**
 * 项目名 → 安全的目录名。
 *
 * 注意：这是一个「净化」函数，会把 `../x` 变成 `x`（安全但会掩盖用户意图）。
 * 因此调用方在写盘前必须用 validateProjectName 显式拒绝可疑输入，
 * 而不是依赖净化后的结果（否则用户以为写到了别处、实际写到了本地目录）。
 */
export function sanitizeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'site'
  );
}

/** 显式拒绝路径穿越形态的项目名（净化前校验，避免「静默修正」） */
export function validateProjectName(name: string): { ok: boolean; reason?: string } {
  const raw = name.trim();
  if (!raw) return { ok: false, reason: '项目名不能为空' };
  if (raw.length > 120) return { ok: false, reason: '项目名过长（≤120 字符）' };
  if (raw.includes('..') || /[\\/]/.test(raw)) {
    return { ok: false, reason: `项目名不能包含路径分隔符或 ".."：${raw}` };
  }
  if (/^[.~]/.test(raw)) return { ok: false, reason: '项目名不能以 . 或 ~ 开头' };
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(raw)) return { ok: false, reason: `项目名 ${raw} 是系统保留名` };
  return { ok: true };
}

/** 从磁盘读回生成产物（部署前重新读取，保证部署内容与磁盘一致） */
async function readGeneratedFiles(absRoot: string, plan: WebsitePlan): Promise<{ path: string; content: string; key?: boolean }[]> {
  const { readdir, readFile, stat } = await import('node:fs/promises');
  const path = await import('node:path');
  const out: { path: string; content: string; key?: boolean }[] = [];
  const skip = new Set(['node_modules', '.git', 'dist']);
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await readdir(dir);
    for (const e of entries) {
      if (skip.has(e)) continue;
      const abs = path.join(dir, e);
      const relPath = rel ? `${rel}/${e}` : e;
      const info = await stat(abs);
      if (info.isDirectory()) {
        await walk(abs, relPath);
      } else {
        if (info.size > 2 * 1024 * 1024) continue; // 单文件 > 2MB 不上传（避免误打包大文件）
        const content = await readFile(abs, 'utf8').catch(() => '');
        out.push({ path: relPath, content, key: relPath === 'index.html' || relPath === 'server.mjs' });
      }
    }
  }
  await walk(absRoot, '');
  // 防止 plan 未使用告警
  void plan;
  return out;
}
