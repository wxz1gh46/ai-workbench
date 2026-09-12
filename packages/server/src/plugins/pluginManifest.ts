import { createHash } from 'node:crypto';

/**
 * 插件清单规范（Phase 4 Step 1）。
 *
 * 清单是「插件能力与权限的唯一事实来源」：
 *   - 安装前用 assertCompliant() 做合规校验（拒绝绕过反爬 / 共享账号 / 破解授权）
 *   - 安装时快照 + 哈希入库，更新时比对哈希 → 防篡改（signature verification）
 *   - 运行期用 requiresGrant() 判断某次工具调用是否已被用户逐项授权
 */

export type PluginKind = 'mcp' | 'http' | 'websocket' | 'local';

export interface PluginPermissionDecl {
  /** 权限点，如 fs:read / net:http / paid:market-data */
  scope: string;
  description: string;
  /** 敏感权限必须在 UI 上单独确认 */
  sensitive: boolean;
  /** 是否必授权才能使用插件（false 为可选权限） */
  required?: boolean;
}

export interface PluginToolDecl {
  name: string;
  description: string;
  /** 是否需要二次确认（危险操作） */
  dangerous?: boolean;
  /** 该工具依赖的权限点 */
  requires?: string[];
  /** 入参 JSON Schema 摘要（用于 UI 生成表单与调用前校验） */
  input?: Record<string, unknown>;
}

export interface PluginManifest {
  name: string;
  version: string;
  author: string;
  description: string;
  kind: PluginKind;
  source: string;
  permissions: PluginPermissionDecl[];
  tools: PluginToolDecl[];
  resources?: { uri: string; description: string }[];
  prompts?: { name: string; description: string }[];
  /** 付费/敏感数据源必须要求用户手动授权 */
  requiresUserAuth: boolean;
  /** 需要用户提供的凭据「变量名」（只存名，不存值） */
  secretRefs: string[];
  /** 是否在沙箱中运行 */
  sandbox: boolean;
  /** 签名：manifest 的 sha256（由 registry 计算或发行方提供），用于校验完整性 */
  signature?: string;
  config?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* 合规红线（写死在代码里，避免后续误改）                               */
/* ------------------------------------------------------------------ */

const FORBIDDEN_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /bypass[-_ ]*(anti[-_ ]?)?(crawler|bot|scrap)/i, reason: '声明绕过反爬' },
  { re: /绕过(反爬|风控|验证码|限制)/, reason: '声明绕过平台风控' },
  { re: /shared[-_ ]?account/i, reason: '使用共享账号' },
  { re: /共享账号|共用账号/, reason: '使用共享账号' },
  { re: /crack(ed)?[-_ ]?(api|license|plugin)/i, reason: '破解授权' },
  { re: /破解|盗版|激活码生成/, reason: '破解授权' },
  { re: /steal[-_ ]?cookie|盗取.*(cookies|登录态)/i, reason: '盗用登录态' },
];

export class PluginComplianceError extends Error {
  readonly reason: string;
  constructor(name: string, reason: string) {
    super(`插件声明违反合规要求，已拒绝安装: ${name}（${reason}）`);
    this.name = 'PluginComplianceError';
    this.reason = reason;
  }
}

/** 合规校验：不通过直接抛错，调用方无需二次判断 */
export function assertCompliant(manifest: PluginManifest): void {
  const haystack = [
    manifest.name,
    manifest.source,
    manifest.description,
    manifest.author,
    JSON.stringify(manifest.config ?? {}),
    manifest.tools.map((t) => `${t.name} ${t.description}`).join(' '),
    manifest.permissions.map((p) => `${p.scope} ${p.description}`).join(' '),
  ].join(' ');

  for (const { re, reason } of FORBIDDEN_PATTERNS) {
    if (re.test(haystack)) throw new PluginComplianceError(manifest.name, reason);
  }

  const paidScopes = manifest.permissions.filter((p) => p.scope.startsWith('paid:'));
  if (paidScopes.length > 0 && !manifest.requiresUserAuth) {
    throw new PluginComplianceError(manifest.name, '付费数据插件必须要求用户手动授权');
  }
  if (manifest.permissions.some((p) => p.sensitive) && manifest.secretRefs.length === 0 && manifest.requiresUserAuth) {
    throw new PluginComplianceError(manifest.name, '声明需要凭据但未给出凭据变量名，用户无法完成配置');
  }
  if (manifest.sandbox !== true) {
    throw new PluginComplianceError(manifest.name, '插件必须在沙箱中运行（sandbox 必须为 true）');
  }
}

/**
 * manifest 规范化 + 哈希。
 * 用固定字段顺序序列化，保证同一个 manifest 在任何机器上哈希一致
 * （否则「重新安装即报签名不匹配」—— 这是最容易踩的坑）。
 */
export function normalizeManifest(manifest: PluginManifest): string {
  const canonical = {
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    description: manifest.description,
    kind: manifest.kind,
    source: manifest.source,
    requiresUserAuth: manifest.requiresUserAuth,
    sandbox: manifest.sandbox,
    secretRefs: [...manifest.secretRefs].sort(),
    permissions: [...manifest.permissions]
      .map((p) => ({ scope: p.scope, description: p.description, sensitive: p.sensitive, required: p.required ?? true }))
      .sort((a, b) => a.scope.localeCompare(b.scope)),
    tools: [...manifest.tools]
      .map((t) => ({ name: t.name, description: t.description, dangerous: t.dangerous ?? false, requires: [...(t.requires ?? [])].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    resources: [...(manifest.resources ?? [])].map((r) => r.uri).sort(),
    prompts: [...(manifest.prompts ?? [])].map((p) => p.name).sort(),
    config: manifest.config ?? {},
  };
  return JSON.stringify(canonical);
}

export function hashManifest(manifest: PluginManifest): string {
  return createHash('sha256').update(normalizeManifest(manifest)).digest('hex');
}

/** 签名校验：发行方给出 signature 时必须匹配；未给出时按「未签名」标记 */
export function verifySignature(manifest: PluginManifest): { signed: boolean; ok: boolean; hash: string } {
  const hash = hashManifest(manifest);
  if (!manifest.signature) return { signed: false, ok: false, hash };
  const ok = manifest.signature.replace(/^sha256:/, '') === hash;
  return { signed: true, ok, hash };
}

/** 单次工具调用是否满足权限要求（未被授权的权限点会被列出） */
export function missingScopes(tool: PluginToolDecl, grantedScopes: string[]): string[] {
  const need = tool.requires ?? [];
  return need.filter((s) => !grantedScopes.includes(s));
}
