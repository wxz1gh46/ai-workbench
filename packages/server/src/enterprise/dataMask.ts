import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { dataMaskRules } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { createHash } from 'node:crypto';

/**
 * 数据脱敏（Phase 4 Step 6）。
 *
 * 策略：
 *   full     全部替换为 ****
 *   partial  保留首尾（邮箱保留 @ 前 1 位与域名；手机保留前 3 后 4）
 *   hash     哈希（可关联但不可逆）
 *   nullify  置为 null（合规上最彻底）
 *
 * 重要设计：脱敏是**输出侧**能力（导出 / API 返回 / 审计展示）。
 * 不做「入库即脱敏」—— 那会让业务无法使用数据；但也意味着：
 * 任何对外输出路径都必须显式调用 maskRecord，不能依赖调用方自觉。
 * 因此提供 maskMany / maskDeep 覆盖嵌套结构，降低漏用概率。
 */

export type MaskStrategy = 'full' | 'partial' | 'hash' | 'nullify';

export interface MaskRule {
  field: string;
  strategy: MaskStrategy;
  target: string;
  enabled: boolean;
}

/** 内置敏感字段的默认策略（用户未配置规则时的兜底，避免「忘了配 = 明文外泄」） */
export const DEFAULT_FIELD_STRATEGIES: Record<string, MaskStrategy> = {
  token: 'full',
  secret: 'full',
  password: 'full',
  pwd: 'full',
  apikey: 'full',
  api_key: 'full',
  authorization: 'full',
  cookie: 'full',
  session: 'full',
  clientsecret: 'full',
  client_secret: 'full',
  connectionstring: 'full',
  connection_string: 'full',
  email: 'partial',
  phone: 'partial',
  mobile: 'partial',
  idcard: 'partial',
  id_card: 'partial',
  bankcard: 'partial',
  bank_card: 'partial',
};

export function defaultStrategyFor(field: string): MaskStrategy | null {
  const key = field.replace(/[^a-z0-9]/gi, '').toLowerCase();
  for (const [pattern, strategy] of Object.entries(DEFAULT_FIELD_STRATEGIES)) {
    if (key.includes(pattern.replace(/[^a-z0-9]/gi, ''))) return strategy;
  }
  return null;
}

/** 单值脱敏 */
export function maskValue(value: unknown, strategy: MaskStrategy): unknown {
  if (value === null || value === undefined) return value;
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  switch (strategy) {
    case 'nullify':
      return null;
    case 'full':
      return '****';
    case 'hash':
      return `sha256:${createHash('sha256').update(str).digest('hex').slice(0, 16)}`;
    case 'partial':
      return partialMask(str);
    default:
      return '****';
  }
}

/** 部分脱敏：按内容形态选择最合适的规则，而不是一律「保留首尾 2 位」 */
export function partialMask(str: string): string {
  const email = /^([^@]+)@(.+)$/.exec(str);
  if (email) {
    const local = email[1]!;
    return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(local.length - 1, 6)))}@${email[2]}`;
  }
  if (/^\d{11}$/.test(str)) return `${str.slice(0, 3)}****${str.slice(7)}`;
  if (/^\d{15,19}$/.test(str)) return `${str.slice(0, 4)}${'*'.repeat(8)}${str.slice(-4)}`;
  if (str.length <= 2) return '*'.repeat(str.length);
  if (str.length <= 6) return `${str.slice(0, 1)}${'*'.repeat(str.length - 2)}${str.slice(-1)}`;
  return `${str.slice(0, 2)}${'*'.repeat(Math.min(8, str.length - 4))}${str.slice(-2)}`;
}

export class DataMaskService {
  constructor(private readonly db: Db) {}

  async listRules(workspaceId: string) {
    return (await this.db.select().from(dataMaskRules).where(eq(dataMaskRules.workspaceId, workspaceId))) as unknown as RuleRow[];
  }

  async upsertRule(input: { workspaceId: string; field: string; strategy: MaskStrategy; target?: string; enabled?: boolean }) {
    if (!['full', 'partial', 'hash', 'nullify'].includes(input.strategy)) {
      throw AppError.badRequest(`未知脱敏策略：${input.strategy}（可用：full/partial/hash/nullify）`);
    }
    const field = input.field.trim();
    if (!field) throw AppError.badRequest('字段名不能为空');
    const target = (input.target ?? '*').trim() || '*';
    const existing = (await this.listRules(input.workspaceId)).find((r) => r.field === field && r.target === target);
    const now = nowIso();
    if (existing) {
      await this.db
        .update(dataMaskRules)
        .set({ strategy: input.strategy, enabled: input.enabled ?? existing.enabled, updatedAt: now } as never)
        .where(eq(dataMaskRules.id, existing.id));
      return { ...existing, strategy: input.strategy, enabled: input.enabled ?? existing.enabled, updatedAt: now };
    }
    const row = {
      id: newId('dmr'),
      workspaceId: input.workspaceId,
      field,
      strategy: input.strategy,
      target,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(dataMaskRules).values(row as never);
    return row as unknown as RuleRow;
  }

  async deleteRule(workspaceId: string, id: string) {
    const rows = (await this.listRules(workspaceId)) as unknown as RuleRow[];
    const row = rows.find((r) => r.id === id);
    if (!row) throw AppError.notFound(`脱敏规则不存在: ${id}`);
    await this.db.delete(dataMaskRules).where(and(eq(dataMaskRules.workspaceId, workspaceId), eq(dataMaskRules.id, id)));
    return { removed: id, field: row.field };
  }

  /** 构造「字段 → 策略」映射（显式规则优先于内置兜底） */
  buildStrategyMap(rules: MaskRule[], target = '*'): Record<string, MaskStrategy> {
    const map: Record<string, MaskStrategy> = {};
    for (const r of rules) {
      if (!r.enabled) continue;
      if (r.target !== '*' && r.target !== target) continue;
      map[r.field.toLowerCase()] = r.strategy;
    }
    return map;
  }

  /** 脱敏一条记录（浅层） */
  maskRecord(record: Record<string, unknown>, map: Record<string, MaskStrategy>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      const explicit = map[k.toLowerCase()];
      const strategy = explicit ?? defaultStrategyFor(k);
      if (strategy) {
        out[k] = maskValue(v, strategy);
        continue;
      }
      out[k] = v;
    }
    return out;
  }

  /**
   * 深度脱敏：递归处理嵌套对象/数组。
   * 递归深度上限 6：避免恶意构造的超深结构导致栈溢出（导出接口会被喂外部数据）。
   */
  maskDeep(value: unknown, map: Record<string, MaskStrategy>, depth = 0): unknown {
    if (depth > 6) return '<max-depth>';
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map((v) => this.maskDeep(v, map, depth + 1));
    if (typeof value === 'object') {
      const rec = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) {
        const explicit = map[k.toLowerCase()];
        const strategy = explicit ?? defaultStrategyFor(k);
        out[k] = strategy ? maskValue(v, strategy) : this.maskDeep(v, map, depth + 1);
      }
      return out;
    }
    return value;
  }

  async maskMany(workspaceId: string, records: Record<string, unknown>[], target = '*'): Promise<Record<string, unknown>[]> {
    const rules = (await this.listRules(workspaceId)) as unknown as MaskRule[];
    const map = this.buildStrategyMap(rules, target);
    return records.map((r) => this.maskRecord(r, map) as Record<string, unknown>);
  }

  /** 供测试/文档展示：内置兜底策略清单 */
  builtinCatalog() {
    return Object.entries(DEFAULT_FIELD_STRATEGIES).map(([field, strategy]) => ({ field, strategy, source: 'builtin' }));
  }
}

export type RuleRow = typeof dataMaskRules.$inferSelect;
