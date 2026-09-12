/**
 * 多源交叉验证（纯函数，离线可测）。
 *
 * 目标（验收要求）：「对比不同来源，标记冲突」。
 *
 * 方法：
 * 1) 从各来源正文里抽出**可比较的论断**：以句子为单位，筛出含量化指标或断言句式者；
 * 2) 对同一「主题键」（数字附近的实体词）聚合，形成 claim；
 * 3) 若同一键下出现**不同的数值**，标记 disputed 并把冲突来源都列出来；
 * 4) 置信度 = 来源数量 × 平均可信度 × 一致性因子。
 *
 * 这是个「确定性优先」的实现：数值冲突是客观可判定的，不依赖模型。
 * 模型只用于润色报告的措辞，不参与事实判定 —— 避免幻觉污染结论。
 */
import type { ResearchClaim, ResearchSource } from '@ai/shared';
import { newId } from '../utils/ids.ts';

export interface ClaimCandidate {
  claim: string;
  key: string;
  /** 论断中的数值（若有），用于冲突检测 */
  value: number | null;
  unit: string;
  sourceId: string;
}

/**
 * 从单条来源抽取可比较论断。
 *
 * 关键正确性要求（踩坑后修正）：
 * 1) 年份不是数据点（「2025 年」不是指标），必须排除 — 否则同一句话会被拆成
 *    年份与指标两个键，冲突检测彻底失效。
 * 2) 数字的正则不能吞掉后续数字：`30%` 在同一句里必须被单独抽出来。
 * 3) 主题键要去掉动词/程度词（预计/达到/将达/超过），只保留「指标名词 + 单位」，
 *    这样不同来源的不同表述才能落到同键。
 */
export function extractClaims(source: ResearchSource): ClaimCandidate[] {
  const sentences = source.content
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 6 && s.length <= 400);

  const out: ClaimCandidate[] = [];
  for (const s of sentences) {
    // 逐个数字匹配：先匹配「数字 + 单位」，避免数字之间互相吞并
    const matches = [...s.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(%|个百分点|万亿|亿|万|千|GW|MW|kW|kg|吨|元|美元|台|人)?/g)];
    const numeric: { value: number; unit: string; index: number }[] = [];
    for (const m of matches) {
      const value = Number((m[1] ?? '').replace(/,/g, ''));
      if (!Number.isFinite(value)) continue;
      const unit = m[2] ?? '';
      const index = m.index ?? 0;
      // 排除年份：1900-2100 的整数且无单位，且后面紧跟「年」
      const after = s.slice(index + (m[0]?.length ?? 0), index + (m[0]?.length ?? 0) + 2);
      const isYear = !unit && value >= 1900 && value <= 2100 && /^\s*年/.test(after);
      if (isYear) continue;
      numeric.push({ value, unit, index });
    }

    if (numeric.length === 0) {
      if (/(已发布|正式实施|必须|禁止|不得|生效|取消了?|新增了?)/.test(s)) {
        out.push({ claim: s, key: subjectKey(s, null), value: null, unit: '', sourceId: source.id });
      }
      continue;
    }

    for (const n of numeric) {
      out.push({
        claim: s,
        key: subjectKey(s.slice(0, n.index + 1), n.unit),
        value: n.value,
        unit: n.unit,
        sourceId: source.id,
      });
    }
  }
  return dedupeCandidates(out);
}

/** 同一来源同一键只保留一次（避免同句多数字重复计权） */
function dedupeCandidates(list: ClaimCandidate[]): ClaimCandidate[] {
  const map = new Map<string, ClaimCandidate>();
  for (const c of list) map.set(`${c.key}|${c.value}|${c.sourceId}`, c);
  return [...map.values()];
}

/**
 * 主题键：取数字前的「指标名词」，去掉动词与程度词。
 * 「2025 年储能装机量预计达到 120GW」与「储能装机量将达 300GW」都必须得到
 * 相近的键（都含「储能装机量」），否则冲突无法检出。
 */
export function subjectKey(sentence: string, unit: string | null): string {
  const VERBS = ['预计', '将达', '达到', '将', '约', '为', '是', '超过', '增至', '增至约', '有', '达', '增长', '增速', '同比', '环比'];
  let head = sentence.replace(/\d[\d,]*(?:\.\d+)?/g, ' ');
  for (const v of VERBS) head = head.split(v).join(' ');
  head = head.replace(/[0-9年月日%（）()、,，．.]/g, ' ');

  // 取出现长度最大的中文/英文名词片段作为指标名
  const nouns = (head.match(/[\u4e00-\u9fff]{2,14}|[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? [])
    .map((n) => n.trim())
    .filter((n) => !/^(我们|他们|这个|那个|已经|可以|必须|仍然|目前|其中|以及|因此|同时|此外|报告|数据显示)$/.test(n));

  // 优先包含「量/额/率/数/规模/价格/占比」等指标词的片段
  const indicator = nouns.find((n) => /(量|额|率|数|规模|价格|占比|产能|装机|增速|成本|收入|利润)/.test(n));
  const key = (indicator ?? nouns[nouns.length - 1] ?? nouns[0] ?? '其他').slice(0, 12);
  return `${key}${unit ? `|${unit}` : ''}`;
}

/** 数值容差：相对差 <3% 视为一致（避免四舍五入被误判为冲突） */
const TOLERANCE = 0.03;

export function crossValidate(sources: ResearchSource[]): ResearchClaim[] {
  const byKey = new Map<string, ClaimCandidate[]>();
  for (const source of sources) {
    for (const c of extractClaims(source)) {
      const list = byKey.get(c.key) ?? [];
      list.push(c);
      byKey.set(c.key, list);
    }
  }

  const claims: ResearchClaim[] = [];
  for (const [key, candidates] of byKey) {
    const numeric = candidates.filter((c) => c.value !== null) as (ClaimCandidate & { value: number })[];
    const uniqueSources = new Set(candidates.map((c) => c.sourceId));
    let supporting: string[] = [...uniqueSources];
    let conflicting: string[] = [];
    let disputed = false;

    if (numeric.length >= 2) {
      // 以「出现次数最多的数值区间」为主流结论
      const groups: { value: number; sources: Set<string> }[] = [];
      for (const c of numeric) {
        const group = groups.find((g) => Math.abs(g.value - c.value) / Math.max(Math.abs(g.value), Math.abs(c.value), 1) <= TOLERANCE);
        if (group) group.sources.add(c.sourceId);
        else groups.push({ value: c.value, sources: new Set([c.sourceId]) });
      }
      groups.sort((a, b) => b.sources.size - a.sources.size);
      const main = groups[0]!;
      const others = groups.slice(1);
      supporting = [...main.sources];
      conflicting = [...new Set(others.flatMap((g) => [...g.sources]))].filter((s) => !main.sources.has(s));
      disputed = conflicting.length > 0;
    }

    // 以主流来源的句子作为 claim 文本（最能代表共识表述）
    const representative = candidates.find((c) => supporting.includes(c.sourceId)) ?? candidates[0]!;
    const reliabilityOf = (id: string) => sources.find((s) => s.id === id)?.reliability ?? 0.5;
    const avgReliability = supporting.reduce((s, id) => s + reliabilityOf(id), 0) / Math.max(1, supporting.length);
    const consistency = disputed ? Math.max(0.3, 1 - conflicting.length / (supporting.length + conflicting.length)) : 1;
    const confidence = Math.max(0.05, Math.min(1, (supporting.length >= 3 ? 1 : supporting.length / 3) * avgReliability * consistency));

    claims.push({
      id: newId('claim'),
      researchJobId: representative.sourceId ? (sources.find((s) => s.id === representative.sourceId)?.researchJobId ?? '') : '',
      claim: representative.claim,
      supportingSources: supporting,
      conflictingSources: conflicting,
      confidence: Number(confidence.toFixed(3)),
      disputed,
    });
    void key;
  }

  // 相关度排序：置信度高、被多源支持、冲突的优先展示
  return claims
    .sort((a, b) => Number(b.disputed) - Number(a.disputed) || b.confidence - a.confidence || b.supportingSources.length - a.supportingSources.length)
    .slice(0, 60);
}

/** 统计冲突情况，供报告与 UI 展示 */
export function validationSummary(claims: ResearchClaim[]): { total: number; disputed: number; highConfidence: number } {
  return {
    total: claims.length,
    disputed: claims.filter((c) => c.disputed).length,
    highConfidence: claims.filter((c) => c.confidence >= 0.7 && !c.disputed).length,
  };
}
