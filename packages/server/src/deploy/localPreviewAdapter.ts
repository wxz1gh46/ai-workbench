import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { DeployContext, DeployProviderAdapter, DeployResult, ProviderCapability } from './provider.ts';
import type { DeployLogChannel } from './deployLog.ts';

/**
 * 本地预览适配器（不需要任何凭据）。
 *
 * 用途：
 *   1. 用户没配任何部署平台 Token 时，依然能拿到一个可访问的线上（本机）地址；
 *   2. 部署前先本地验证产物完整性（缺 index.html 直接报错，而不是等平台构建失败）。
 *
 * 安全：只监听 127.0.0.1，绝不监听 0.0.0.0（避免把工作区产物暴露到局域网）。
 */
export class LocalPreviewAdapter implements DeployProviderAdapter {
  readonly capability: ProviderCapability = {
    provider: 'local-preview',
    label: '本地预览',
    supportsEnvVars: false,
    supportsCustomDomain: false,
    supportsRollback: false,
    supportsPasswordProtection: false,
    tokenEnvKeys: [],
    docsUrl: '',
    requiresToken: false,
  };

  private readonly servers = new Map<string, { server: Server; port: number; root: string }>();

  token(): string | null {
    return null;
  }

  async test(): Promise<{ ok: boolean; message: string; degraded: boolean }> {
    return { ok: true, degraded: false, message: '本地预览无需凭据' };
  }

  async deploy(ctx: DeployContext): Promise<DeployResult> {
    const root = process.env.LOCAL_PREVIEW_ROOT;
    if (!root) throw new Error('未设置 LOCAL_PREVIEW_ROOT');
    const abs = resolve(root);
    if (!existsSync(join(abs, 'index.html')) && !existsSync(join(abs, 'public', 'index.html'))) {
      ctx.log.error('产物缺少 index.html，本地预览无法启动');
      throw new Error('产物缺少 index.html：请先重新生成项目');
    }
    const serveRoot = existsSync(join(abs, 'index.html')) ? abs : join(abs, 'public');
    ctx.log.info(`本地预览根目录：${serveRoot}`);

    const existing = this.servers.get(ctx.projectName);
    if (existing) {
      ctx.log.info(`复用已有预览服务端口 ${existing.port}`);
      return { deploymentId: `local-${existing.port}`, url: `http://127.0.0.1:${existing.port}`, rawSummary: { port: existing.port }, degraded: true };
    }

    const port = await freePort(4300);
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let filePath = normalize(join(serveRoot, decodeURIComponent(url.pathname)));
      if (!filePath.startsWith(serveRoot)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) filePath = join(serveRoot, 'index.html');
      try {
        const body = readFileSync(filePath);
        res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end('404');
      }
    });
    await new Promise<void>((ok) => server.listen(port, '127.0.0.1', ok));
    this.servers.set(ctx.projectName, { server, port, root: serveRoot });
    ctx.log.info(`本地预览已启动： http://127.0.0.1:${port}`);
    ctx.log.warn('本地预览仅监听 127.0.0.1，未对外发布；要上线请配置 Vercel / Cloudflare / Netlify 凭据');
    return { deploymentId: `local-${port}`, url: `http://127.0.0.1:${port}`, rawSummary: { port }, degraded: true };
  }

  async rollback(deploymentId: string, log: DeployLogChannel): Promise<DeployResult> {
    log.warn('本地预览不支持回滚（重新生成即可）');
    return { deploymentId, url: '', rawSummary: { unsupported: true }, degraded: true };
  }

  async remove(deploymentId: string, log: DeployLogChannel): Promise<{ ok: boolean; message: string; degraded: boolean }> {
    for (const [name, entry] of this.servers) {
      if (deploymentId === `local-${entry.port}`) {
        await new Promise<void>((ok) => entry.server.close(() => ok()));
        this.servers.delete(name);
        log.info(`已停止本地预览服务 ${deploymentId}`);
        return { ok: true, degraded: false, message: '本地预览已停止' };
      }
    }
    return { ok: false, degraded: true, message: '未找到对应的本地预览服务' };
  }

  async bindDomain(domain: string): Promise<{ ok: boolean; message: string; degraded: boolean }> {
    return { ok: false, degraded: true, message: `本地预览不支持绑定域名（${domain} 需要真实托管平台）` };
  }

  /** 进程退出/测试清理用 */
  async stopAll(): Promise<void> {
    for (const [, entry] of this.servers) {
      await new Promise<void>((ok) => entry.server.close(() => ok()));
    }
    this.servers.clear();
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

async function freePort(start: number): Promise<number> {
  const net = await import('node:net');
  for (let p = start; p < start + 200; p += 1) {
    const ok = await new Promise<boolean>((resolveOk) => {
      const srv = net.createServer();
      srv.once('error', () => resolveOk(false));
      srv.once('listening', () => srv.close(() => resolveOk(true)));
      srv.listen(p, '127.0.0.1');
    });
    if (ok) return p;
  }
  throw new Error('找不到可用端口（4300-4500 全部被占用）');
}
