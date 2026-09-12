import path from 'node:path';

/**
 * 插件沙箱策略（Phase 4 Step 1）。
 *
 * 进程隔离由宿主（后续 MCP 子进程 / Worker）负责，这里提供**统一、可测试**的策略层：
 *   1) 文件系统：所有路径必须落在工作区根目录内（复用 safeJoin 思路，但不依赖工具层）
 *   2) 网络：白名单域名 + 是否允许联网；不允许 localhost/内网地址（防 SSRF）
 *   3) 资源：CPU 秒数、内存、单次调用超时、并发数上限
 *
 * 设计取舍：策略判定做成**纯函数**，因为真正隔离（容器/子进程）在测试环境不可用；
 * 纯函数可以 100% 被测试覆盖，且是隔离措施里最容易被绕过的一环（所以必须有测试）。
 */

export interface SandboxPolicy {
  /** 是否允许联网 */
  allowNetwork: boolean;
  /** 域名白名单；allowNetwork=true 且白名单为空时表示允许全部公网（内网仍然禁止） */
  allowedHosts: string[];
  /** 允许访问的路径前缀（工作区相对路径）；空数组表示禁止所有文件访问 */
  allowedPaths: string[];
  /** 单次调用超时（毫秒） */
  timeoutMs: number;
  /** 并发上限 */
  maxConcurrency: number;
  /** 内存上限（MB） */
  maxMemoryMb: number;
  /** CPU 时间上限（秒） */
  maxCpuSeconds: number;
}

export const DEFAULT_SANDBOX: SandboxPolicy = {
  allowNetwork: false,
  allowedHosts: [],
  allowedPaths: [],
  timeoutMs: 10_000,
  maxConcurrency: 2,
  maxMemoryMb: 256,
  maxCpuSeconds: 10,
};

export class SandboxViolation extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SandboxViolation';
    this.code = code;
  }
}

/** 内网 / 元数据地址：任何情况下都不允许插件访问（SSRF 防护） */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local，含云元数据 169.254.169.254
  /^\[?::1\]?$/,
  /\.local$/i,
  /^metadata\./i,
];

export function isPrivateHost(host: string): boolean {
  return PRIVATE_HOST_PATTERNS.some((re) => re.test(host));
}

/** 网络访问校验：协议 / 内网 / 白名单 */
export function assertNetworkAllowed(policy: SandboxPolicy, url: string): void {
  if (!policy.allowNetwork) {
    throw new SandboxViolation('NETWORK_DISABLED', '插件网络访问已被沙箱禁用（allowNetwork=false）');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SandboxViolation('BAD_URL', `非法 URL：${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SandboxViolation('BAD_PROTOCOL', `仅允许 http/https，收到 ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  if (isPrivateHost(host)) {
    throw new SandboxViolation('PRIVATE_HOST', `禁止访问内网/元数据地址：${host}`);
  }
  if (policy.allowedHosts.length > 0 && !policy.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new SandboxViolation('HOST_NOT_ALLOWED', `域名不在白名单内：${host}`);
  }
}

/**
 * 文件访问校验：路径必须在工作区根内，且命中 allowedPaths 前缀。
 * 注意：这里**不做「静默修正」**——路径穿越直接拒绝并报出，避免用户以为写成功了。
 */
export function assertPathAllowed(policy: SandboxPolicy, workspaceRoot: string | null, relPath: string): string {
  if (!workspaceRoot) {
    throw new SandboxViolation('NO_WORKSPACE', '工作区未设置根目录，插件不可访问文件系统');
  }
  if (policy.allowedPaths.length === 0) {
    throw new SandboxViolation('FS_DISABLED', '插件的文件系统访问未授权（allowedPaths 为空）');
  }
  const normalizedRel = path.normalize(relPath).replace(/^([/\\])+/, '');
  if (normalizedRel.startsWith('..')) {
    throw new SandboxViolation('PATH_TRAVERSAL', `检测到路径穿越：${relPath}`);
  }
  const abs = path.resolve(workspaceRoot, normalizedRel);
  const rootWithSep = path.resolve(workspaceRoot) + path.sep;
  if (abs !== path.resolve(workspaceRoot) && !abs.startsWith(rootWithSep)) {
    throw new SandboxViolation('OUT_OF_WORKSPACE', `路径越出工作区：${relPath}`);
  }
  const inAllowed = policy.allowedPaths.some((prefix) => {
    const p = path.normalize(prefix).replace(/^([/\\])+/, '');
    return p === '' || normalizedRel === p || normalizedRel.startsWith(p.endsWith('/') ? p : `${p}/`);
  });
  if (!inAllowed) {
    throw new SandboxViolation('PATH_NOT_ALLOWED', `路径不在授权前缀内：${relPath}`);
  }
  return abs;
}

/** 并发闸门：超过上限时排队等待（而非直接报错），避免高并发插件打满本机 */
export class ConcurrencyGate {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  get inFlight(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }
}

/** 超时包装：沙箱调用不允许无限等待 */
export async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, label = 'plugin call'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SandboxViolation('TIMEOUT', `${label} 超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 资源上限校验（声明值不得超出策略） */
export function assertResourceWithinPolicy(policy: SandboxPolicy, requested: Partial<SandboxPolicy>): void {
  if (requested.timeoutMs !== undefined && requested.timeoutMs > policy.timeoutMs) {
    throw new SandboxViolation('TIMEOUT_TOO_LARGE', `请求超时 ${requested.timeoutMs}ms 超出策略上限 ${policy.timeoutMs}ms`);
  }
  if (requested.maxMemoryMb !== undefined && requested.maxMemoryMb > policy.maxMemoryMb) {
    throw new SandboxViolation('MEMORY_TOO_LARGE', `请求内存 ${requested.maxMemoryMb}MB 超出策略上限 ${policy.maxMemoryMb}MB`);
  }
  if (requested.maxCpuSeconds !== undefined && requested.maxCpuSeconds > policy.maxCpuSeconds) {
    throw new SandboxViolation('CPU_TOO_LARGE', `请求 CPU ${requested.maxCpuSeconds}s 超出策略上限 ${policy.maxCpuSeconds}s`);
  }
}
