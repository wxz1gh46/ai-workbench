import { nanoid } from 'nanoid';

/** 短 ID，够用且对本地单机场景友好（避免 UUID 冗长） */
export function newId(prefix?: string): string {
  const id = nanoid(16);
  return prefix ? `${prefix}_${id}` : id;
}

export function nowIso(): string {
  return new Date().toISOString();
}
