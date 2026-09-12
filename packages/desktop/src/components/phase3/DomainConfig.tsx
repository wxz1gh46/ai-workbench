import { useState } from 'react';
import type { ProviderCapability } from '@ai/shared';
import { Badge, Button, Empty } from '@/components/ui';

/**
 * 自定义域名配置。
 *
 * UI 职责（分工明确）：
 *   - 本组件只负责「发起绑定」与「把 DNS 指引讲清楚」；
 *   - 真正的 DNS 记录由用户去自己的 DNS 服务商添加（权限边界）；
 *   - HTTPS 证书由平台自动签发，这里明确标注状态而不是假装已就绪。
 */
export interface DomainBinding {
  domain: string;
  status: string;
  message: string;
  dns: { type: string; name: string; value: string }[];
  https: string;
}

export function DomainConfig({
  providers,
  binding,
  onBind,
  busy,
}: {
  providers: ProviderCapability[];
  binding: DomainBinding | null;
  onBind: (domain: string, provider: string) => void | Promise<void>;
  busy?: boolean;
}) {
  const [domain, setDomain] = useState('');
  const [provider, setProvider] = useState(providers.find((p) => p.requiresToken)?.provider ?? 'vercel');
  const [error, setError] = useState('');

  const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

  async function submit() {
    const d = domain.trim().toLowerCase();
    if (!DOMAIN_RE.test(d)) {
      setError('域名格式不合法（示例：www.example.com）。不支持通配符与平台保留域');
      return;
    }
    setError('');
    await onBind(d, provider);
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="www.example.com"
          className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-[11px] outline-none focus:border-brand"
        />
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as typeof provider)}
          className="rounded border border-border bg-bg px-2 py-1 text-[11px]"
        >
          {providers.map((p) => (
            <option key={p.provider} value={p.provider}>
              {p.label}
            </option>
          ))}
        </select>
        <Button variant="primary" onClick={() => void submit()} disabled={busy}>
          绑定
        </Button>
      </div>
      {error && <p className="text-[11px] text-rose-400">{error}</p>}

      {!binding ? (
        <Empty>尚未绑定自定义域名</Empty>
      ) : (
        <div className="space-y-2 rounded border border-border bg-bg p-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px]">{binding.domain}</span>
            <Badge tone={binding.status === 'failed' ? 'error' : binding.status === 'bound' ? 'ok' : 'warn'}>
              {binding.status === 'pending-dns' ? '等待 DNS' : binding.status === 'bound' ? '已生效' : '失败'}
            </Badge>
          </div>
          <p className="text-[11px] text-muted">{binding.message}</p>
          {binding.dns.length > 0 && (
            <div>
              <p className="mb-1 text-[10px] text-muted">请在你的 DNS 服务商处添加：</p>
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="text-muted">
                    <th className="text-left">类型</th>
                    <th className="text-left">主机记录</th>
                    <th className="text-left">记录值</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {binding.dns.map((r, i) => (
                    <tr key={i}>
                      <td>{r.type}</td>
                      <td>{r.name}</td>
                      <td className="break-all">{r.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[10px] text-muted">
            HTTPS：{binding.https === 'auto' ? '由平台自动签发（DNS 生效后数分钟内完成）' : binding.https}
          </p>
        </div>
      )}
    </div>
  );
}
