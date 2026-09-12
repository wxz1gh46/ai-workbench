import { createHash } from 'node:crypto';
import { AppError } from '../utils/errors.ts';
import { resolveProviderToken } from '../security/secrets.ts';
import type { DeployContext, DeployProviderAdapter, DeployResult, ProviderCapability } from './provider.ts';
import type { DeployLogChannel } from './deployLog.ts';
import { dnsHint } from './vercelAdapter.ts';
import { packFilesForUpload } from './uploadUtil.ts';

const API = 'https://api.netlify.com/api/v1';

/**
 * Netlify 适配器。
 *
 * 参考文档：https://docs.netlify.com/api/get-started/
 * 流程（官方推荐的 digest 部署）：
 *   1. POST /sites                      创建站点（已存在则复用）
 *   2. POST /deploys { files: {path: sha1} }   创建部署并拿到 required 列表
 *   3. PUT  /deploys/{id}/files/{path}          逐个上传 required 的文件
 *
 * 只上传平台要求上传的文件 → 天然增量、省流量。
 * 未配置 NETLIFY_AUTH_TOKEN 时返回结构化 degraded。
 */
export class NetlifyAdapter implements DeployProviderAdapter {
  readonly capability: ProviderCapability = {
    provider: 'netlify',
    label: 'Netlify',
    supportsEnvVars: true,
    supportsCustomDomain: true,
    supportsRollback: true,
    supportsPasswordProtection: true,
    tokenEnvKeys: ['NETLIFY_AUTH_TOKEN', 'NETLIFY_SITE_ID'],
    docsUrl: 'https://app.netlify.com/user/applications#personal-access-tokens',
    requiresToken: true,
  };

  token(): string | null {
    return resolveProviderToken('netlify');
  }

  siteId(): string | null {
    const v = process.env.NETLIFY_SITE_ID;
    return v && v.trim() ? v.trim() : null;
  }

  async test(): Promise<{ ok: boolean; message: string; degraded: boolean; account?: string }> {
    const token = this.token();
    if (!token) {
      return {
        ok: false,
        degraded: true,
        message: '未配置 NETLIFY_AUTH_TOKEN：请在环境变量中设置（Netlify → User settings → Applications）',
      };
    }
    try {
      const res = await fetch(`${API}/accounts`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) return { ok: false, degraded: false, message: `凭据无效（HTTP ${res.status}）` };
      const json = (await res.json()) as { name?: string; slug?: string }[];
      const first = Array.isArray(json) ? json[0] : undefined;
      return { ok: true, degraded: false, message: 'Netlify 凭据可用', account: first?.name ?? first?.slug };
    } catch (e) {
      return { ok: false, degraded: false, message: `网络错误：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async ensureSite(token: string, name: string, log: DeployLogChannel): Promise<string> {
    const preset = this.siteId();
    if (preset) {
      log.info(`复用 NETLIFY_SITE_ID=${preset}`);
      return preset;
    }
    log.info(`创建 Netlify 站点 ${name}`);
    const res = await fetch(`${API}/sites`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw AppError.provider(`创建 Netlify 站点失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { id?: string };
    if (!json.id) throw AppError.provider('Netlify 创建站点返回缺少 id');
    log.info(`站点已创建 id=${json.id}（建议记录到 NETLIFY_SITE_ID 以便后续复用）`);
    return json.id;
  }

  async deploy(ctx: DeployContext): Promise<DeployResult> {
    const token = this.token();
    if (!token) throw AppError.provider('未配置 NETLIFY_AUTH_TOKEN，无法部署到 Netlify');
    if (ctx.files.length === 0) throw AppError.badRequest('没有可部署的文件：请先执行「生成」');

    const siteId = await this.ensureSite(token, ctx.projectName, ctx.log);
    const packed = packFilesForUpload(ctx.files);
    const digest: Record<string, string> = {};
    for (const f of packed.files) digest[`/${f.file}`] = createHash('sha1').update(f.data).digest('hex');
    ctx.log.info(`提交 ${packed.fileCount} 个文件的摘要，等待平台返回待上传清单`);

    const createRes = await fetch(`${API}/sites/${siteId}/deploys`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ files: digest, ...(Object.keys(ctx.envVars).length ? { env: ctx.envVars } : {}) }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!createRes.ok) {
      const text = await createRes.text().catch(() => '');
      ctx.log.error(`创建部署失败 HTTP ${createRes.status}: ${text.slice(0, 300)}`);
      throw AppError.provider(`Netlify 创建部署失败（HTTP ${createRes.status}）`);
    }
    const deploy = (await createRes.json()) as { id?: string; required?: string[]; ssl_url?: string; deploy_ssl_url?: string };
    const deployId = deploy.id;
    if (!deployId) throw AppError.provider('Netlify 返回缺少部署 id');

    const required = new Set(deploy.required ?? Object.keys(digest));
    ctx.log.info(`平台要求上传 ${required.size} / ${packed.fileCount} 个文件`);
    let uploaded = 0;
    for (const f of packed.files) {
      const key = `/${f.file}`;
      if (!required.has(key)) continue;
      const put = await fetch(`${API}/deploys/${deployId}/files${key}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
        body: f.data,
      });
      if (!put.ok) {
        ctx.log.error(`上传失败 ${key} HTTP ${put.status}`);
        throw AppError.provider(`Netlify 上传文件失败：${key}`);
      }
      uploaded += 1;
    }
    ctx.log.info(`上传完成：${uploaded} 个文件`);

    const url = deploy.ssl_url ?? deploy.deploy_ssl_url ?? '';
    ctx.log.info(`线上地址：${url}`);
    return { deploymentId: deployId, url, rawSummary: { id: deployId, url, uploaded }, degraded: false };
  }

  async rollback(deploymentId: string, log: DeployLogChannel): Promise<DeployResult> {
    const token = this.token();
    if (!token) throw AppError.provider('未配置 NETLIFY_AUTH_TOKEN，无法回滚');
    const siteId = this.siteId();
    if (!siteId) {
      log.warn('未设置 NETLIFY_SITE_ID，无法自动回滚；请在 Netlify 控制台手动 Restore deploy');
      return { deploymentId, url: '', rawSummary: { rollbackOf: deploymentId, manual: true }, degraded: true };
    }
    log.info(`回滚到部署 ${deploymentId}`);
    const res = await fetch(`${API}/sites/${siteId}/deploys/${deploymentId}/restore`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      log.error(`回滚失败 HTTP ${res.status}`);
      throw AppError.provider(`Netlify 回滚失败（HTTP ${res.status}）`);
    }
    const json = (await res.json()) as { id?: string; ssl_url?: string; deploy_ssl_url?: string };
    const url = json.ssl_url ?? json.deploy_ssl_url ?? '';
    log.info(`回滚完成，当前地址：${url}`);
    return { deploymentId: json.id ?? deploymentId, url, rawSummary: { rollbackOf: deploymentId }, degraded: false };
  }

  async remove(deploymentId: string, log: DeployLogChannel): Promise<{ ok: boolean; message: string; degraded: boolean }> {
    const token = this.token();
    if (!token) return { ok: false, degraded: true, message: '未配置 NETLIFY_AUTH_TOKEN，无法删除' };
    log.info(`删除部署 ${deploymentId}`);
    const res = await fetch(`${API}/deploys/${deploymentId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      log.error(`删除失败 HTTP ${res.status}`);
      return { ok: false, degraded: false, message: `删除失败（HTTP ${res.status}）` };
    }
    log.info('删除成功');
    return { ok: true, degraded: false, message: '已删除' };
  }

  async bindDomain(domain: string, log: DeployLogChannel) {
    const token = this.token();
    const siteId = this.siteId();
    if (!token || !siteId) {
      return { ok: false, degraded: true, message: '未配置 NETLIFY_AUTH_TOKEN / NETLIFY_SITE_ID，无法绑定域名', dns: dnsHint(domain) };
    }
    log.info(`绑定自定义域名 ${domain}`);
    const res = await fetch(`${API}/sites/${siteId}/domain_aliases`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ domain }),
    });
    if (!res.ok) {
      log.error(`域名绑定失败 HTTP ${res.status}`);
      return { ok: false, degraded: false, message: `绑定失败（HTTP ${res.status}）`, dns: dnsHint(domain) };
    }
    log.info('域名绑定已提交；Netlify 会自动签发 Let\'s Encrypt 证书');
    return { ok: true, degraded: false, message: '已提交绑定，证书自动签发', dns: [{ type: 'CNAME', name: domain, value: 'apex-loadbalancer.netlify.com' }] };
  }
}
