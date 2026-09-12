import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { websiteAccessRules } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { hashPassword, verifyPassword } from '../security/secrets.ts';
import { newId, nowIso } from '../utils/ids.ts';

/**
 * 网站访问控制（Step 3）。
 *
 * 三类规则：
 *   - password         口令保护：只存 scrypt hash，明文从不入库/入日志
 *   - email-allowlist  邮箱白名单
 *   - ip-allowlist     IP / CIDR 白名单
 *
 * 生成物层面：
 *   - 静态站：server.mjs 支持 SITE_PASSWORD（Basic Auth），口令从环境变量读；
 *   - 全栈站：同理；
 *   - 托管平台：Vercel/Netlify 支持平台侧口令保护，本工作台通过适配器下发。
 */

export type AccessRuleType = 'password' | 'email-allowlist' | 'ip-allowlist';

export interface AccessRuleInput {
  type: AccessRuleType;
  value: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** IPv4 / CIDR：逐段校验 0-255，前缀 0-32 */
export function isValidIpOrCidr(input: string): boolean {
  const [addr, prefix] = input.split('/');
  if (prefix !== undefined) {
    const p = Number(prefix);
    if (!Number.isInteger(p) || p < 0 || p > 32) return false;
  }
  const parts = (addr ?? '').split('.');
  if (parts.length !== 4) return false;
  return parts.every((seg) => /^\d{1,3}$/.test(seg) && Number(seg) >= 0 && Number(seg) <= 255);
}

export function validateRule(input: AccessRuleInput): void {
  if (input.type === 'email-allowlist') {
    const list = input.value.split(/[,;\s]+/).filter(Boolean);
    if (list.length === 0) throw AppError.badRequest('邮箱白名单不能为空');
    const bad = list.filter((e) => !EMAIL_RE.test(e));
    if (bad.length > 0) throw AppError.badRequest(`邮箱格式不合法: ${bad.join(', ')}`);
    return;
  }
  if (input.type === 'ip-allowlist') {
    const list = input.value.split(/[,;\s]+/).filter(Boolean);
    if (list.length === 0) throw AppError.badRequest('IP 白名单不能为空');
    const bad = list.filter((ip) => !isValidIpOrCidr(ip));
    if (bad.length > 0) throw AppError.badRequest(`IP/CIDR 格式不合法: ${bad.join(', ')}`);
    return;
  }
  if (input.type === 'password') {
    if (input.value.length < 8) throw AppError.badRequest('访问口令至少 8 位');
    if (input.value.length > 200) throw AppError.badRequest('访问口令过长');
    return;
  }
  throw AppError.badRequest(`不支持的访问控制类型: ${String(input.type)}`);
}

export class AccessControlService {
  constructor(private readonly db: Db) {}

  async list(websiteProjectId: string) {
    const rows = await this.db.select().from(websiteAccessRules).where(eq(websiteAccessRules.websiteProjectId, websiteProjectId));
    // 永远不返回 hash
    return rows.map((r) => ({ id: r.id, type: r.type, value: r.type === 'password' ? '****' : r.value, createdAt: r.createdAt }));
  }

  async set(websiteProjectId: string, rules: AccessRuleInput[]): Promise<{ count: number; types: AccessRuleType[] }> {
    if (rules.length === 0) {
      await this.clear(websiteProjectId);
      return { count: 0, types: [] };
    }
    for (const r of rules) validateRule(r);
    await this.clear(websiteProjectId);
    const now = nowIso();
    for (const r of rules) {
      await this.db.insert(websiteAccessRules).values({
        id: newId('acl'),
        websiteProjectId,
        type: r.type,
        // 口令只存 hash；value 存掩码，避免任何形式的明文留痕
        value: r.type === 'password' ? '****' : r.value,
        hash: r.type === 'password' ? hashPassword(r.value) : null,
        createdAt: now,
      });
    }
    return { count: rules.length, types: rules.map((r) => r.type) };
  }

  async clear(websiteProjectId: string): Promise<void> {
    await this.db.delete(websiteAccessRules).where(eq(websiteAccessRules.websiteProjectId, websiteProjectId));
  }

  /** 校验访问口令（用于本地预览与测试） */
  async checkPassword(websiteProjectId: string, password: string): Promise<boolean> {
    const rows = await this.db.select().from(websiteAccessRules).where(eq(websiteAccessRules.websiteProjectId, websiteProjectId));
    const rule = rows.find((r) => r.type === 'password');
    return verifyPassword(password, rule?.hash ?? null);
  }

  /** 生成给托管平台的访问控制配置（口令仍从环境变量注入，不在此处出现明文） */
  async toPlatformPolicy(websiteProjectId: string): Promise<{ mode: 'public' | 'password' | 'restricted'; envKeys: string[]; note: string }> {
    const rules = await this.db.select().from(websiteAccessRules).where(eq(websiteAccessRules.websiteProjectId, websiteProjectId));
    if (rules.length === 0) return { mode: 'public', envKeys: [], note: '公开访问' };
    if (rules.some((r) => r.type === 'password')) {
      return {
        mode: 'password',
        envKeys: ['SITE_PASSWORD'],
        note: '口令保护：部署时把 SITE_PASSWORD 注入平台环境变量；平台侧如需密码保护请在平台面板开启',
      };
    }
    return {
      mode: 'restricted',
      envKeys: [],
      note: `白名单访问（${rules.map((r) => r.type).join(', ')}）：需在平台侧 WAF / Access 中配置，本工作台已记录规则`,
    };
  }
}
