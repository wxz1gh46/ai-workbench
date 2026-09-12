import { AppError } from '../utils/errors.ts';

/**
 * 自定义域名管理（Step 3）。
 *
 * 为什么不做 DNS 写入：
 *   托管平台的域名绑定 API 只能把域名挂到项目上，DNS 记录必须由用户在
 *   自己的 DNS 服务商处添加（这是权限边界，也是合规边界）。
 *   因此本模块负责：
 *     1. 域名语法与安全校验（拒绝通配、拒绝平台保留域）；
 *     2. 调用适配器完成平台侧绑定；
 *     3. 返回需要用户手工配置的 DNS 记录清单（明确、可复制）。
 */

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const RESERVED_SUFFIX = ['.vercel.app', '.netlify.app', '.pages.dev', '.local', '.internal', '.localdomain'];

export function validateDomain(domain: string): string {
  const d = domain.trim().toLowerCase();
  if (!d) throw AppError.badRequest('域名不能为空');
  if (d.length > 253) throw AppError.badRequest('域名过长');
  if (d.startsWith('*.')) throw AppError.badRequest('不支持通配符域名：请逐个绑定具体子域名');
  if (!DOMAIN_RE.test(d)) throw AppError.badRequest(`域名格式不合法: ${domain}`);
  if (RESERVED_SUFFIX.some((s) => d.endsWith(s))) {
    throw AppError.badRequest(`不能绑定平台保留域名（${RESERVED_SUFFIX.join(' / ')}），请使用你自己的域名`);
  }
  return d;
}

export interface DomainBinding {
  domain: string;
  status: 'pending-dns' | 'bound' | 'failed';
  message: string;
  dns: { type: string; name: string; value: string }[];
  https: 'auto' | 'manual' | 'unknown';
  verifiedAt: string | null;
}

/** 依据 DNS 记录是否可解析出结论（此处不做真实 DNS 查询：离线环境不可用，交由平台轮询） */
export function summarizeBinding(domain: string, adapterResult: { ok: boolean; message: string; degraded: boolean; dns?: { type: string; name: string; value: string }[] }): DomainBinding {
  return {
    domain,
    status: adapterResult.ok ? 'pending-dns' : adapterResult.degraded ? 'pending-dns' : 'failed',
    message: adapterResult.message,
    dns: adapterResult.dns ?? [],
    https: 'auto',
    verifiedAt: null,
  };
}

export class DomainManager {
  /** 生成绑定指引（无凭据时也能给用户可执行的下一步） */
  static guide(domain: string, provider: string): DomainBinding {
    const dns =
      provider === 'cloudflare-pages'
        ? [{ type: 'CNAME', name: domain, value: '<你的项目>.pages.dev' }]
        : provider === 'netlify'
          ? [{ type: 'CNAME', name: domain, value: 'apex-loadbalancer.netlify.com' }]
          : [
              { type: 'A', name: '@', value: '76.76.21.21' },
              { type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com' },
            ];
    return {
      domain,
      status: 'pending-dns',
      message: `请在 DNS 服务商处添加以下记录，HTTPS 证书将由 ${provider} 自动签发`,
      dns,
      https: 'auto',
      verifiedAt: null,
    };
  }
}
