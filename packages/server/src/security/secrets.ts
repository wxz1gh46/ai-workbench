import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { logger } from '../utils/logger.ts';

/**
 * 本地加密存储（Phase 3）。
 *
 * 密钥来源优先级：
 *   1. WORKBENCH_SECRET_KEY（用户显式配置，推荐；生产/多机场景必须用）
 *   2. 派生自本机 data/secrets/local.key（0o600，明文不落库、不落代码）
 *
 * 硬约束：
 *   - 任何密钥都不写入代码、日志、DB 明文字段、审计 detail
 *   - 未配置 WORKBENCH_SECRET_KEY 时明确告警，不静默降级为明文
 *   - 算法 AES-256-GCM（带认证标签，防篡改）
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

let cachedKey: Buffer | null = null;

function localKeyFile(): string {
  const dir = path.join(config.dataDir, 'secrets');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, 'local.key');
}

function derive(raw: string): Buffer {
  return createHmac('sha256', 'workbench-kdf-v1').update(raw).digest();
}

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.WORKBENCH_SECRET_KEY;
  if (fromEnv && fromEnv.length >= 32) {
    cachedKey = derive(fromEnv);
    return cachedKey;
  }
  if (fromEnv) {
    logger.warn('WORKBENCH_SECRET_KEY 长度不足 32，已按 KDF 拉伸；建议改用 32+ 位随机串');
    cachedKey = derive(fromEnv);
    return cachedKey;
  }

  const file = localKeyFile();
  if (existsSync(file)) {
    cachedKey = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
    return cachedKey;
  }
  const generated = randomBytes(32);
  writeFileSync(file, generated.toString('hex'), { mode: 0o600 });
  logger.warn('未配置 WORKBENCH_SECRET_KEY，已生成本机密钥文件；跨机迁移前请改用环境变量', { file });
  cachedKey = generated;
  return cachedKey;
}

/** 测试用：注入固定密钥（不影响生产路径） */
export function setSecretKeyForTest(key: string): void {
  cachedKey = derive(key);
}

/** 加密任意 JSON 可序列化配置；返回单串，可直接入库 encrypted_config */
export function seal(value: unknown): string {
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value ?? null), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join(':');
}

/** 解密；密文被篡改 / 密钥变更时抛可读错误，绝不返回半截数据 */
export function unseal<T = Record<string, unknown>>(sealed: string | null | undefined): T | null {
  if (!sealed) return null;
  const parts = sealed.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('密文格式不合法（期望 v1:iv:tag:data）');
  }
  const ivB64 = parts[1] as string;
  const tagB64 = parts[2] as string;
  const dataB64 = parts[3] as string;
  const key = loadKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const out = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]);
  return JSON.parse(out.toString('utf8')) as T;
}

/** 敏感值掩码，用于日志/审计/接口返回 */
export function maskSecret(value: string | null | undefined, keep = 4): string {
  if (!value) return '';
  if (value.length <= keep) return '****';
  return '****' + value.slice(-keep);
}

/** 对连接串做「只保留形状」的脱敏：postgres://us****:****@host/db */
export function redactConnectionString(input: string): string {
  try {
    const u = new URL(input);
    if (u.password) u.password = '****';
    if (u.username) u.username = u.username.length > 2 ? u.username.slice(0, 2) + '****' : '****';
    for (const k of [...u.searchParams.keys()]) {
      if (/key|token|secret|password|pwd/i.test(k)) u.searchParams.set(k, '****');
    }
    return u.toString();
  } catch {
    return maskSecret(input);
  }
}

/** 访问控制密码：只存 scrypt hash，从不存明文 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const saltB64 = parts[1] as string;
  const hashB64 = parts[2] as string;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64url'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** 读取运行期凭据：环境变量优先；不存在则返回 null（由调用方给出可读错误） */
export function resolveProviderToken(provider: string): string | null {
  const map: Record<string, string> = {
    vercel: 'VERCEL_TOKEN',
    'cloudflare-pages': 'CLOUDFLARE_API_TOKEN',
    netlify: 'NETLIFY_AUTH_TOKEN',
    neon: 'NEON_API_KEY',
    supabase: 'SUPABASE_ACCESS_TOKEN',
  };
  const envKey = map[provider];
  if (!envKey) return null;
  const v = process.env[envKey];
  return v && v.trim() ? v.trim() : null;
}
