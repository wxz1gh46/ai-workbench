import type { DeployProvider } from '@ai/shared';
import type { DeployProviderAdapter, ProviderCapability } from './provider.ts';
import { VercelAdapter } from './vercelAdapter.ts';
import { CloudflareAdapter } from './cloudflareAdapter.ts';
import { NetlifyAdapter } from './netlifyAdapter.ts';
import { LocalPreviewAdapter } from './localPreviewAdapter.ts';

/**
 * 部署平台注册表。
 * 新增平台只需实现 DeployProviderAdapter 并在这里登记。
 */
const adapters: Record<DeployProvider, DeployProviderAdapter> = {
  vercel: new VercelAdapter(),
  'cloudflare-pages': new CloudflareAdapter(),
  netlify: new NetlifyAdapter(),
  'local-preview': new LocalPreviewAdapter(),
};

export function getAdapter(provider: DeployProvider): DeployProviderAdapter {
  return adapters[provider];
}

export function listCapabilities(): ProviderCapability[] {
  return Object.values(adapters).map((a) => a.capability);
}

export async function testAll(): Promise<{ provider: DeployProvider; capability: ProviderCapability; configured: boolean; message: string }[]> {
  const out: { provider: DeployProvider; capability: ProviderCapability; configured: boolean; message: string }[] = [];
  for (const [provider, adapter] of Object.entries(adapters) as [DeployProvider, DeployProviderAdapter][]) {
    const res = await adapter.test().catch((e) => ({ ok: false, degraded: false, message: e instanceof Error ? e.message : String(e) }));
    out.push({ provider, capability: adapter.capability, configured: res.ok, message: res.message });
  }
  return out;
}

export { adapters };
export type { DeployProviderAdapter, ProviderCapability };
