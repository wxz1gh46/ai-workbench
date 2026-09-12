import type { DeployProvider } from '@ai/shared';
import type { GeneratedFile } from './templates.ts';
import type { DeployLogChannel } from './deployLog.ts';

/**
 * 部署平台适配器接口。
 *
 * 三家平台（Vercel / Cloudflare Pages / Netlify）能力不同，但工作台只需要 6 个动作：
 *   test → createProject → upload → getUrl → rollback → delete
 * 统一抽象后，UI 与 Service 只面向接口编程。
 *
 * 硬约束：
 *   - 凭据一律运行时从环境变量读取（见 secrets.resolveProviderToken），不进代码/DB；
 *   - 任何一个适配器都必须支持 dryRun（无凭据时返回结构化的「未配置」结果，
 *     而不是抛网络错误），保证离线可测。
 */

export interface DeployContext {
  projectName: string;
  files: GeneratedFile[];
  /** 已解密的部署环境变量（仅在内存中短暂存在） */
  envVars: Record<string, string>;
  log: DeployLogChannel;
}

export interface DeployResult {
  deploymentId: string;
  url: string;
  /** 平台返回的原始响应（已裁剪敏感字段），便于排障与审计 */
  rawSummary: Record<string, unknown>;
  degraded: boolean;
}

export interface ProviderCapability {
  provider: DeployProvider;
  label: string;
  supportsEnvVars: boolean;
  supportsCustomDomain: boolean;
  supportsRollback: boolean;
  supportsPasswordProtection: boolean;
  /** 需要的环境变量名（UI 上提示用户配置） */
  tokenEnvKeys: string[];
  docsUrl: string;
  /** 无可执行凭据时，部署会走本地产物模式（不调用外部 API） */
  requiresToken: boolean;
}

export interface DeployProviderAdapter {
  capability: ProviderCapability;
  token(): string | null;
  test(): Promise<{ ok: boolean; message: string; degraded: boolean; account?: string }>;
  deploy(ctx: DeployContext): Promise<DeployResult>;
  rollback(deploymentId: string, log: DeployLogChannel): Promise<DeployResult>;
  remove(deploymentId: string, log: DeployLogChannel): Promise<{ ok: boolean; message: string; degraded: boolean }>;
  bindDomain(domain: string, log: DeployLogChannel): Promise<{ ok: boolean; message: string; degraded: boolean; dns?: { type: string; name: string; value: string }[] }>;
}
