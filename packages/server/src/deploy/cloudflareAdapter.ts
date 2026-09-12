import { createHash } from 'node:crypto';
import { AppError } from '../utils/errors.ts';
import { resolveProviderToken } from '../security/secrets.ts';
import type { DeployContext, DeployProviderAdapter, DeployResult, ProviderCapability } from './provider.ts';
import type { DeployLogChannel } from './deployLog.ts';
import { dnsHint } from './vercelAdapter.ts';
import { packFilesForUpload } from './uploadUtil.ts';

const API = 'https://api.cloudflare.com/client/v4';

/**
 * Cloudflare Pages 适配器。
 *
 * 参考文档：https://developers.cloudflare.com/api/resources/pages/
 * 直接调用 Direct Upload API：
 *   POST /accounts/{account_id}/pages/projects/{project}/deployments
 *   需要 multipart/form-data，manifest 描述每个文件。
 *
 * 需要两个凭据：CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID（都从环境变量读）。
 * 未配置时返回结构化 degraded，不抛网络错误。
 */
export class CloudflareAdapter implements DeployProviderAdapter {
  readonly capability: ProviderCapability = {
    provider: 'cloudflare-pages',
    label: 'Cloudflare Pages',
    supportsEnvVars: true,
    supportsCustomDomain: true,
    supportsRollback: true,
    supportsPasswordProtection: false,
    tokenEnvKeys: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    docsUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    requiresToken: true,
  };

  token(): string | null {
    return resolveProviderToken('cloudflare-pages');
  }

  accountId(): string | null {
    const v = process.env.CLOUDFLARE_ACCOUNT_ID;
    return v && v.trim() ? v.trim() : null;
  }

  async test(): Promise<{ ok: boolean; message: string; degraded: boolean; account?: string }> {
    const token = this.token();
    const account = this.accountId();
    if (!token || !account) {
      return {
        ok: false,
        degraded: true,
        message: `未配置 ${!token ? 'CLOUDFLARE_API_TOKEN' : 'CLOUDFLARE_ACCOUNT_ID'}：请在环境变量中设置`,
      };
    }
    try {
      const res = await fetch(`${API}/accounts/${account}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) return { ok: false, degraded: false, message: `凭据无效（HTTP ${res.status}）` };
      const json = (await res.json()) as { result?: { name?: string } };
      return { ok: true, degraded: false, message: 'Cloudflare 凭据可用', account: json.result?.name };
    } catch (e) {
      return { ok: false, degraded: false, message: `网络错误：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async deploy(ctx: DeployContext): Promise<DeployResult> {
    const token = this.token();
    const account = this.accountId();
    if (!token || !account) throw AppError.provider('未配置 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，无法部署');
    if (ctx.files.length === 0) throw AppError.badRequest('没有可部署的文件：请先执行「生成」');

    ctx.log.info(`准备部署到 Cloudflare Pages，项目 ${ctx.projectName}`);
    await this.ensureProject(ctx.projectName, token, account, ctx.log);
    const packed = packFilesForUpload(ctx.files);
    ctx.log.info(`已打包 ${packed.fileCount} 个文件`);

    const manifest: Record<string, { hash: string; size: number }> = {};
    for (const f of packed.files) manifest[`/${f.file}`] = { hash: sha1Hex(f.data), size: Buffer.byteLength(f.data) };

    const form = new FormData();
    form.set('manifest', JSON.stringify(manifest));
    for (const f of packed.files) {
      form.set(f.file, new Blob([f.data], { type: 'text/plain' }), f.file);
    }

    const res = await fetch(`${API}/accounts/${account}/pages/projects/${encodeURIComponent(ctx.projectName)}/deployments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      ctx.log.error(`Cloudflare Pages 部署失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
      throw AppError.provider(`Cloudflare Pages 部署失败（HTTP ${res.status}）`);
    }
    const json = (await res.json()) as {
      result?: { id?: string; url?: string; latest_stage?: { name?: string; status?: string } };
    };
    const id = json.result?.id;
    const url = json.result?.url ? normalizeUrl(json.result.url) : '';
    if (!id) throw AppError.provider('Cloudflare Pages 返回缺少部署 id');
    ctx.log.info(`部署已创建 id=${id}`);
    ctx.log.info(`线上地址：${url}`);
    if (Object.keys(ctx.envVars).length > 0) {
      ctx.log.warn('Cloudflare Pages 的生产环境变量需在项目设置或 API 中配置（本次已随部署提交的变量仅在构建期可用）');
    }
    return { deploymentId: id, url, rawSummary: { id, url, stage: json.result?.latest_stage }, degraded: false };
  }

  private async ensureProject(project: string, token: string, account: string, log: DeployLogChannel): Promise<void> {
    const res = await fetch(`${API}/accounts/${account}/pages/projects/${encodeURIComponent(project)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      log.info('项目已存在，直接复用');
      return;
    }
    log.info('项目不存在，创建新项目');
    const create = await fetch(`${API}/accounts/${account}/pages/projects`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: project, production_branch: 'main' }),
    });
    if (!create.ok) {
      const text = await create.text().catch(() => '');
      log.warn(`创建项目返回 HTTP ${create.status}（可能已存在）：${text.slice(0, 200)}`);
    }
  }

  async rollback(deploymentId: string, log: DeployLogChannel): Promise<DeployResult> {
    const token = this.token();
    const account = this.accountId();
    if (!token || !account) throw AppError.provider('未配置 Cloudflare 凭据，无法回滚');
    log.info('Cloudflare Pages 回滚需指定项目：通过 POST /deployments/{id}/rollback 提升历史部署');
    const project = process.env.CLOUDFLARE_PROJECT ?? '';
    if (!project) {
      log.warn('未设置 CLOUDFLARE_PROJECT，无法自动回滚；请在项目设置中手动选择历史部署');
      return { deploymentId, url: '', rawSummary: { rollbackOf: deploymentId, manual: true }, degraded: true };
    }
    const res = await fetch(
      `${API}/accounts/${account}/pages/projects/${encodeURIComponent(project)}/deployments/${deploymentId}/rollback`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      log.error(`回滚失败 HTTP ${res.status}`);
      throw AppError.provider(`Cloudflare Pages 回滚失败（HTTP ${res.status}）`);
    }
    const json = (await res.json()) as { result?: { url?: string; id?: string } };
    const url = json.result?.url ? normalizeUrl(json.result.url) : '';
    log.info(`回滚完成，当前地址：${url}`);
    return { deploymentId: json.result?.id ?? deploymentId, url, rawSummary: { rollbackOf: deploymentId }, degraded: false };
  }

  async remove(deploymentId: string, log: DeployLogChannel): Promise<{ ok: boolean; message: string; degraded: boolean }> {
    const token = this.token();
    const account = this.accountId();
    const project = process.env.CLOUDFLARE_PROJECT ?? '';
    if (!token || !account || !project) {
      return { ok: false, degraded: true, message: '未配置 Cloudflare 凭据或 CLOUDFLARE_PROJECT，无法删除' };
    }
    log.info(`删除部署 ${deploymentId}`);
    const res = await fetch(
      `${API}/accounts/${account}/pages/projects/${encodeURIComponent(project)}/deployments/${deploymentId}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      log.error(`删除失败 HTTP ${res.status}`);
      return { ok: false, degraded: false, message: `删除失败（HTTP ${res.status}）` };
    }
    log.info('删除成功');
    return { ok: true, degraded: false, message: '已删除' };
  }

  async bindDomain(domain: string, log: DeployLogChannel) {
    const token = this.token();
    const account = this.accountId();
    const project = process.env.CLOUDFLARE_PROJECT ?? '';
    if (!token || !account || !project) {
      return { ok: false, degraded: true, message: '未配置 Cloudflare 凭据或项目名，无法绑定域名', dns: dnsHint(domain) };
    }
    log.info(`绑定自定义域名 ${domain} 到 ${project}`);
    const res = await fetch(`${API}/accounts/${account}/pages/projects/${encodeURIComponent(project)}/domains`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: domain }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.error(`域名绑定失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, degraded: false, message: `绑定失败（HTTP ${res.status}）`, dns: dnsHint(domain) };
    }
    log.info('域名绑定已提交；HTTPS 由 Cloudflare 自动签发');
    return { ok: true, degraded: false, message: '已提交绑定，等待证书签发', dns: [{ type: 'CNAME', name: domain, value: `${project}.pages.dev` }] };
  }
}

function normalizeUrl(url: string): string {
  return url.startsWith('http') ? url : `https://${url}`;
}

/** manifest 用的稳定 hash：平台侧仅用于去重比对，任意稳定摘要即可 */
function sha1Hex(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}
