import { AppError } from '../utils/errors.ts';
import { resolveProviderToken } from '../security/secrets.ts';
import type { DeployContext, DeployProviderAdapter, DeployResult, ProviderCapability } from './provider.ts';
import type { DeployLogChannel } from './deployLog.ts';
import { packFilesForUpload, uploadTarball } from './uploadUtil.ts';

const API = 'https://api.vercel.com';

/**
 * Vercel 适配器。
 *
 * 参考文档：https://vercel.com/docs/rest-api
 * 流程：POST /v13/deployments （files 内联 或 压缩包上传）
 * 本实现用「内联 files」方式，避免依赖 tar 打包与对象存储。
 *
 * 未配置 VERCEL_TOKEN 时不报错，而是返回结构化 degraded 结果，
 * 并明确告知需要用户手动配置 —— 这是 Phase 3 的硬要求（凭据由用户授权）。
 */
export class VercelAdapter implements DeployProviderAdapter {
  readonly capability: ProviderCapability = {
    provider: 'vercel',
    label: 'Vercel',
    supportsEnvVars: true,
    supportsCustomDomain: true,
    supportsRollback: true,
    supportsPasswordProtection: false,
    tokenEnvKeys: ['VERCEL_TOKEN'],
    docsUrl: 'https://vercel.com/account/tokens',
    requiresToken: true,
  };

  token(): string | null {
    return resolveProviderToken('vercel');
  }

  async test(): Promise<{ ok: boolean; message: string; degraded: boolean; account?: string }> {
    const token = this.token();
    if (!token) {
      return {
        ok: false,
        degraded: true,
        message: '未配置 VERCEL_TOKEN：请在环境变量中设置（https://vercel.com/account/tokens）',
      };
    }
    try {
      const res = await fetch(`${API}/v2/user`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) return { ok: false, degraded: false, message: `凭据无效或权限不足（HTTP ${res.status}）` };
      const json = (await res.json()) as { user?: { username?: string; email?: string } };
      return { ok: true, degraded: false, message: 'Vercel 凭据可用', account: json.user?.username ?? json.user?.email };
    } catch (e) {
      return { ok: false, degraded: false, message: `网络错误：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async deploy(ctx: DeployContext): Promise<DeployResult> {
    const token = this.token();
    if (!token) throw AppError.provider('未配置 VERCEL_TOKEN，无法部署到 Vercel');
    if (ctx.files.length === 0) throw AppError.badRequest('没有可部署的文件：请先执行「生成」');

    ctx.log.info(`准备部署到 Vercel，项目名 ${ctx.projectName}，文件 ${ctx.files.length} 个`);
    const packed = packFilesForUpload(ctx.files);
    ctx.log.info(`已打包 ${packed.fileCount} 个文件，${packed.totalBytes} 字节`);
    if (packed.skipped.length > 0) ctx.log.warn(`跳过 ${packed.skipped.length} 个不受支持的文件：${packed.skipped.join(', ')}`);

    const body = {
      name: ctx.projectName,
      target: 'production',
      files: packed.files,
      projectSettings: { framework: null, buildCommand: null, outputDirectory: null },
      ...(Object.keys(ctx.envVars).length
        ? { env: Object.entries(ctx.envVars).map(([key, value]) => ({ key, value, target: ['production', 'preview'], type: 'encrypted' })) }
        : {}),
    };

    const res = await fetch(`${API}/v13/deployments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      ctx.log.error(`Vercel 部署失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
      throw AppError.provider(`Vercel 部署失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { id?: string; url?: string; readyState?: string; alias?: string[] };
    if (!json.id || !json.url) throw AppError.provider('Vercel 返回缺少 id/url 字段');

    const url = `https://${json.url}`;
    ctx.log.info(`部署已创建：id=${json.id} state=${json.readyState ?? 'unknown'}`);
    ctx.log.info(`预览地址：${url}`);

    // Vercel 部署是异步的，轮询到 ready（最多 5 分钟），失败不抛错，交由状态字段体现
    const finalState = await this.waitReady(json.id, token, ctx.log);
    ctx.log.info(`部署最终状态：${finalState}`);
    if (finalState === 'ERROR') throw AppError.provider('Vercel 构建失败，请查看平台日志');

    return {
      deploymentId: json.id,
      url,
      rawSummary: { id: json.id, url: json.url, state: finalState, envKeys: Object.keys(ctx.envVars) },
      degraded: false,
    };
  }

  private async waitReady(id: string, token: string, log: DeployLogChannel, timeoutMs = 300_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = 'QUEUED';
    while (Date.now() < deadline) {
      await sleep(3000);
      const res = await fetch(`${API}/v13/deployments/${id}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) continue;
      const json = (await res.json()) as { readyState?: string };
      const state = json.readyState ?? 'UNKNOWN';
      if (state !== last) {
        log.info(`状态变化：${last} → ${state}`);
        last = state;
      }
      if (state === 'READY' || state === 'ERROR' || state === 'CANCELED') return state;
    }
    log.warn('等待部署就绪超时，返回当前状态');
    return last;
  }

  async rollback(deploymentId: string, log: DeployLogChannel): Promise<DeployResult> {
    const token = this.token();
    if (!token) throw AppError.provider('未配置 VERCEL_TOKEN，无法回滚');
    log.info(`回滚：把部署 ${deploymentId} 重新提升为生产`);
    const res = await fetch(`${API}/v9/projects/${encodeURIComponent(deploymentId)}/rollback`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.error(`回滚失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
      throw AppError.provider(`Vercel 回滚失败（HTTP ${res.status}）`);
    }
    const json = (await res.json()) as { url?: string; id?: string };
    const url = json.url ? `https://${json.url}` : '';
    log.info(`回滚完成，当前生产地址：${url || '（由平台返回为准）'}`);
    return { deploymentId: json.id ?? deploymentId, url, rawSummary: { rollbackOf: deploymentId }, degraded: false };
  }

  async remove(deploymentId: string, log: DeployLogChannel): Promise<{ ok: boolean; message: string; degraded: boolean }> {
    const token = this.token();
    if (!token) return { ok: false, degraded: true, message: '未配置 VERCEL_TOKEN，无法删除' };
    log.info(`删除部署 ${deploymentId}`);
    const res = await fetch(`${API}/v13/deployments/${deploymentId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.error(`删除失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, degraded: false, message: `删除失败（HTTP ${res.status}）` };
    }
    log.info('删除成功');
    return { ok: true, degraded: false, message: '已删除' };
  }

  async bindDomain(domain: string, log: DeployLogChannel) {
    const token = this.token();
    if (!token) {
      return {
        ok: false,
        degraded: true,
        message: '未配置 VERCEL_TOKEN，无法绑定域名',
        dns: dnsHint(domain),
      };
    }
    log.info(`绑定自定义域名 ${domain}`);
    const res = await fetch(`${API}/v10/projects/-/domains/${encodeURIComponent(domain)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.error(`域名绑定失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, degraded: false, message: `绑定失败（HTTP ${res.status}）：${text.slice(0, 200)}`, dns: dnsHint(domain) };
    }
    log.info('域名已提交绑定；请在 DNS 服务商处按提示配置记录，HTTPS 由平台自动签发');
    return { ok: true, degraded: false, message: '已提交绑定，等待 DNS 与证书生效', dns: dnsHint(domain) };
  }
}

export function dnsHint(domain: string): { type: string; name: string; value: string }[] {
  const root = domain.split('.').slice(-2).join('.');
  const sub = domain === root ? '@' : domain.slice(0, domain.length - root.length - 1);
  return [
    { type: 'A', name: sub || '@', value: '76.76.21.21' },
    { type: 'CNAME', name: sub ? sub : 'www', value: 'cname.vercel-dns.com' },
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { uploadTarball };
