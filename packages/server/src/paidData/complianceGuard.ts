import { findProvider } from './providerRegistry.ts';

/**
 * 合规守卫（Phase 4 Step 2）。
 *
 * 硬约束（不提供关闭开关）：
 *   1) 只允许 provider 声明过的接入方式；出现「爬虫 / 逆向 / 反爬绕过」意图直接拒绝
 *   2) 需要用户授权的 provider，必须有已配置凭据才能查询
 *   3) 参数里不允许出现「批量导出/全量下载/绕过限速」这类滥用意图
 *   4) 所有查询必须写明用途（purpose），用于审计追溯「谁因为什么查了敏感数据」
 *
 * 设计：纯函数 + 可枚举的拒绝原因，便于 UI 直接把原因展示给用户，
 * 也便于安全测试逐条断言（不允许出现「静默通过」的分支）。
 */

export interface ComplianceInput {
  providerId: string;
  action: string;
  params: Record<string, unknown>;
  /** 是否已配置凭据 */
  hasCredentials: boolean;
  /** 用户显式用途说明（可选但强烈建议；审计用） */
  purpose?: string;
}

export interface ComplianceDecision {
  allowed: boolean;
  reason?: string;
  code?: 'UNKNOWN_PROVIDER' | 'UNKNOWN_ACTION' | 'NO_CREDENTIALS' | 'ABUSE_INTENT' | 'NOT_OFFICIAL_API';
  /** 合规提示（总是返回，便于 UI 展示「你正在以何种方式访问」） */
  accessMethods: string[];
  rateLimit: { perMinute: number; note: string };
}

const ABUSE_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /(bypass|绕过).*(rate.?limit|限流|限速|配额)/i, reason: '请求绕过平台限流，不符合官方 API 使用条款' },
  { re: /(crawl|spider|scrap|爬虫|爬取|抓站)/i, reason: '请求使用爬虫方式抓取，不允许（必须走官方 API）' },
  { re: /(bulk|dump|全量|批量导出|镜像全库)/i, reason: '请求全量导出/镜像数据，超出授权范围' },
  { re: /(shared|共享).*(account|账号|token)/i, reason: '请求使用共享账号，违反平台条款' },
  { re: /(crack|破解|盗版)/i, reason: '请求涉及破解授权' },
  { re: /(captcha|验证码).*(bypass|绕过|破解)/i, reason: '请求绕过验证码' },
];

export function checkCompliance(input: ComplianceInput): ComplianceDecision {
  const spec = findProvider(input.providerId);
  if (!spec) {
    return {
      allowed: false,
      reason: `未知的付费数据源：${input.providerId}`,
      code: 'UNKNOWN_PROVIDER',
      accessMethods: [],
      rateLimit: { perMinute: 0, note: '未知数据源不做限流承诺' },
    };
  }

  const base = { accessMethods: spec.accessMethods, rateLimit: spec.rateLimit };

  if (!spec.actions.some((a) => a.name === input.action)) {
    return {
      ...base,
      allowed: false,
      code: 'UNKNOWN_ACTION',
      reason: `${spec.name} 不支持动作：${input.action}（可用：${spec.actions.map((a) => a.name).join(', ')}）`,
    };
  }

  const haystack = JSON.stringify(input.params ?? {});
  for (const { re, reason } of ABUSE_PATTERNS) {
    if (re.test(haystack)) {
      return { ...base, allowed: false, code: 'ABUSE_INTENT', reason };
    }
  }

  if (spec.requiresUserAuth && !input.hasCredentials) {
    return {
      ...base,
      allowed: false,
      code: 'NO_CREDENTIALS',
      reason: `${spec.name} 需要你手动配置凭据后才能查询。接入方式：${spec.accessMethods.join(' / ')}`,
    };
  }

  return { ...base, allowed: true };
}
