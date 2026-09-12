/**
 * Cron 解析器（Step 5）。
 *
 * 支持 5 段（分 时 日 月 周）与 6 段（秒 分 时 日 月 周，Quartz 风格）。
 * 自研而不是直接用 node-cron 的 validate：
 *   1. 需要给出「下次执行时间」给 UI 展示（node-cron 不提供 next 计算）；
 *   2. 需要解释表达式（自然语言描述）给用户确认，避免「0 0 * * * 到底几点跑」的误解；
 *   3. 时区需要显式处理（用户在中国，服务器可能在 UTC）。
 *
 * 支持语法：
 *   *            任意
 *   5            具体值
 *   1-5          范围
 *   star/15      步长（星号斜杠）
 *   1,3,5        列表
 *   0-30/5       范围 + 步长
 *   @daily / @hourly / @weekly / @monthly / @yearly / @minutely
 */

export interface ParsedCron {
  seconds: number[];
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** 是否 6 段（含秒） */
  hasSeconds: boolean;
  expression: string;
  description: string;
}

const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
  '@minutely': '* * * * *',
  '@secondly': '* * * * * *',
};

const FIELD_RANGE: Record<string, [number, number]> = {
  seconds: [0, 59],
  minutes: [0, 59],
  hours: [0, 23],
  daysOfMonth: [1, 31],
  months: [1, 12],
  daysOfWeek: [0, 7],
};

export class CronError extends Error {}

function parseField(field: string, range: [number, number], name: string): number[] {
  const [min, max] = range;
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const segment = part.trim();
    if (!segment) throw new CronError(`${name} 字段含空项`);

    // 步长：*/n 或 a-b/n 或 a/n（Quartz 允许 a/n 表示从 a 开始每 n）
    const stepMatch = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(segment);
    if (stepMatch) {
      const step = Number(stepMatch[2]);
      if (step < 1) throw new CronError(`${name} 步长必须 ≥1`);
      let from = min;
      let to = max;
      const base = stepMatch[1] as string;
      if (base !== '*') {
        const bounds = base.split('-').map(Number);
        from = bounds[0] as number;
        to = bounds.length > 1 ? (bounds[1] as number) : max;
      }
      for (let v = from; v <= to; v += step) out.add(normalizeDow(v, name, range));
      continue;
    }

    // 范围：a-b
    const rangeMatch = /^(\d+)-(\d+)$/.exec(segment);
    if (rangeMatch) {
      const from = Number(rangeMatch[1]);
      const to = Number(rangeMatch[2]);
      if (from > to) throw new CronError(`${name} 范围起点大于终点：${segment}`);
      for (let v = from; v <= to; v += 1) out.add(normalizeDow(v, name, range));
      continue;
    }

    // 单值
    if (/^\d+$/.test(segment)) {
      const v = Number(segment);
      out.add(normalizeDow(v, name, range));
      continue;
    }

    if (segment === '*') {
      for (let v = min; v <= max; v += 1) out.add(normalizeDow(v, name, range));
      continue;
    }

    throw new CronError(`${name} 字段无法解析：${segment}`);
  }

  const list = [...out].sort((a, b) => a - b);
  for (const v of list) {
    if (v < min || v > max) throw new CronError(`${name} 取值越界：${v}（允许 ${min}-${max}）`);
  }
  return list;
}

/**
 * 周日既允许 0 也允许 7 → 统一成 0。
 * 注意：这里必须按「值域」判断而不是字段名 —— 字段名是中文（用于报错信息），
 * 早期版本按 'daysOfWeek' 比较，导致 7 永远不会被归一化（真实缺陷）。
 */
function normalizeDow(v: number, name: string, range: [number, number]): number {
  const isDowField = range[0] === 0 && range[1] === 7;
  if (isDowField && v === 7) return 0;
  void name;
  return v;
}

export function parseCron(expression: string): ParsedCron {
  const raw = expression.trim().toLowerCase();
  if (!raw) throw new CronError('cron 表达式不能为空');
  const expanded = ALIASES[raw] ?? raw;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    throw new CronError(`cron 表达式需要 5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周），当前 ${fields.length} 段：${expression}`);
  }
  const hasSeconds = fields.length === 6;
  const [secField, minField, hourField, domField, monField, dowField] = hasSeconds
    ? (fields as [string, string, string, string, string, string])
    : (['0', ...fields] as [string, string, string, string, string, string]);

  const parsed: ParsedCron = {
    seconds: parseField(secField, FIELD_RANGE.seconds as [number, number], '秒'),
    minutes: parseField(minField, FIELD_RANGE.minutes as [number, number], '分'),
    hours: parseField(hourField, FIELD_RANGE.hours as [number, number], '时'),
    daysOfMonth: parseField(domField, FIELD_RANGE.daysOfMonth as [number, number], '日'),
    months: parseField(monField, FIELD_RANGE.months as [number, number], '月'),
    daysOfWeek: parseField(dowField, FIELD_RANGE.daysOfWeek as [number, number], '周'),
    hasSeconds,
    expression,
    description: '',
  };
  parsed.description = describe(parsed);
  return parsed;
}

export function validateCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/** 自然语言描述（UI 展示用，避免用户误解） */
export function describe(parsed: ParsedCron): string {
  const parts: string[] = [];
  const step = (arr: number[], total: number, unit: string): string | null => {
    if (arr.length === total) return null;
    if (arr.length === 1) return `第 ${arr[0]} ${unit}`;
    if (arr.length === 2) return `${arr[0]} 和 ${arr[1]} ${unit}`;
    return `${arr.slice(0, 5).join(', ')}${arr.length > 5 ? '…' : ''} ${unit}`;
  };

  if (parsed.hasSeconds) {
    const s = step(parsed.seconds, 60, '秒');
    if (s) parts.push(s);
  }
  const mi = step(parsed.minutes, 60, '分');
  if (mi) parts.push(mi);
  const h = step(parsed.hours, 24, '时');
  if (h) parts.push(h);
  const dom = step(parsed.daysOfMonth, 31, '日');
  if (dom) parts.push(dom);
  const mon = step(parsed.months, 12, '月');
  if (mon) parts.push(mon);
  const dowNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  if (parsed.daysOfWeek.length !== 7) {
    parts.push(parsed.daysOfWeek.map((d) => dowNames[d] ?? `周${d}`).join('、'));
  }

  if (parts.length === 0) return '每分钟执行一次';
  return `${parts.join('，')}执行`;
}

/**
 * 计算下一次执行时间。
 *
 * 算法：从 from 开始按秒（或分）向前推进，逐字段匹配。
 * 为避免极端表达式（如 2 月 30 日）导致死循环，最多扫描 4 年，超时抛错。
 * 时区：显式传入 IANA 时区名，内部按该时区的本地时间字段匹配（与 node-cron 行为一致）。
 */
export function nextRun(expression: string, from: Date = new Date(), timezone = 'Asia/Shanghai'): Date {
  const parsed = parseCron(expression);
  const tz = timezoneFormatter(timezone);
  const stepMs = parsed.hasSeconds ? 1000 : 60_000;

  // 从下一整分钟/整秒开始（保证 from 本身不会被返回）
  let cursor = new Date(Math.floor(from.getTime() / stepMs) * stepMs + stepMs);
  const deadline = cursor.getTime() + 4 * 366 * 24 * 60 * 60 * 1000;
  let guard = 0;

  while (cursor.getTime() < deadline) {
    guard += 1;
    if (guard > 2_000_000) throw new CronError(`无法计算下次执行时间（表达式过于严格）：${expression}`);
    const p = tz(cursor);

    if (parsed.months.includes(p.month) && parsed.daysOfMonth.includes(p.day) && parsed.daysOfWeek.includes(p.weekday)) {
      if (parsed.hours.includes(p.hour)) {
        if (parsed.minutes.includes(p.minute)) {
          if (parsed.seconds.includes(p.second)) return cursor;
          cursor = new Date(cursor.getTime() + 1000);
          continue;
        }
        // 秒/分不匹配 → 直接跳到下一整分钟（省 59 次循环）
        cursor = new Date(Math.floor(cursor.getTime() / 60_000) * 60_000 + 60_000);
        continue;
      }
      // 小时不匹配 → 跳到下一整点
      cursor = new Date(Math.floor(cursor.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
      continue;
    }

    // 日期不匹配 → 直接跳到次日 00:00（这是最主要的性能来源：
    // 「每月 1 日」这类表达式如果逐分钟扫描要遍历 4 万多分钟）
    const nextDay = new Date(cursor.getTime());
    nextDay.setUTCHours(0, 0, 0, 0);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    // 时区偏移可能导致跳过头，回退 1 天保证不漏
    cursor = nextDay.getTime() - 24 * 3_600_000 > cursor.getTime() ? new Date(nextDay.getTime() - 24 * 3_600_000) : nextDay;
    // 对齐到整分钟，避免越过之后错失目标
    cursor = new Date(Math.floor(cursor.getTime() / stepMs) * stepMs);
  }
  throw new CronError(`无法计算下次执行时间（表达式过于严格）：${expression}`);
}

interface TzParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

/** 用 Intl 做时区换算：不引入额外依赖，且能正确处理夏令时 */
function timezoneFormatter(timezone: string): (d: Date) => TzParts {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      weekday: 'short',
    });
  } catch {
    throw new CronError(`无效的时区：${timezone}（请使用 IANA 名称，如 Asia/Shanghai）`);
  }
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return (d: Date): TzParts => {
    const parts = formatter.formatToParts(d);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
    const weekdayKey = get('weekday');
    return {
      year: Number(get('year')),
      month: Number(get('month')),
      day: Number(get('day')),
      hour: Number(get('hour')) % 24,
      minute: Number(get('minute')),
      second: Number(get('second')),
      weekday: DOW[weekdayKey] ?? 0,
    };
  };
}

/** 校验时区名是否合法 */
export function validateTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** 常用表达式预设（UI 的快捷选择） */
export const CRON_PRESETS: { label: string; expression: string; note: string }[] = [
  { label: '每分钟', expression: '* * * * *', note: '调试用，注意频率' },
  { label: '每 5 分钟', expression: '*/5 * * * *', note: '' },
  { label: '每小时', expression: '0 * * * *', note: '整点触发' },
  { label: '每天 9:00', expression: '0 9 * * *', note: '常见日报时间' },
  { label: '工作日 9:00', expression: '0 9 * * 1-5', note: '周一到周五' },
  { label: '每周一 9:00', expression: '0 9 * * 1', note: '' },
  { label: '每月 1 日 9:00', expression: '0 9 1 * *', note: '' },
  { label: '每季度首日 9:00', expression: '0 9 1 1,4,7,10 *', note: '' },
];
