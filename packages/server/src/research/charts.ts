/**
 * 图表生成（纯函数）。
 *
 * 产出 Mermaid 源码（前端可直接渲染，也能被 Markdown/PDF 工具复用），
 * 不做位图渲染，避免引入 canvas/native 依赖。
 */
import type { ResearchClaim, ResearchSource } from '@ai/shared';

export interface ChartSpec {
  title: string;
  kind: 'bar' | 'line' | 'pie' | 'mermaid';
  /** Mermaid 源码（kind=mermaid）或序列化数据（其余类型） */
  data: unknown;
}

/**
 * 从论断中提取「可比数值」并生成柱状图。
 * 只在同一主题键下有多个数值（对比关系）时才生成，避免产出无意义图表。
 */
export function buildNumericChart(sources: ResearchSource[]): ChartSpec | null {
  const found: { label: string; value: number; unit: string }[] = [];
  for (const s of sources) {
    for (const c of s.content.matchAll(/([\u4e00-\u9fffA-Za-z]{2,12})\s*(?:预计|将|约|达到|为|是|超过|增至)?\s*(\d[\d,]*(?:\.\d+)?)\s*(GW|MW|%|亿|万|元|美元|吨|台)?/g)) {
      const value = Number((c[2] ?? '').replace(/,/g, ''));
      if (!Number.isFinite(value) || value === 0) continue;
      found.push({ label: `${c[1]}${c[3] ?? ''}`, value, unit: c[3] ?? '' });
    }
  }
  const unique = new Map<string, number>();
  for (const f of found) if (!unique.has(f.label) && unique.size < 12) unique.set(f.label, f.value);
  if (unique.size < 2) return null;

  const entries = [...unique.entries()];
  return {
    title: '关键数值对比',
    kind: 'bar',
    data: {
      mermaid: ['```mermaid', 'xychart-beta', '    title "关键数值对比"', '    x-axis [' + entries.map(([l]) => `"${l}"`).join(', ') + ']', '    bar [' + entries.map(([, v]) => v).join(', ') + ']', '```'].join('\n'),
      points: entries.map(([label, value]) => ({ label, value })),
    },
  };
}

/** 结论置信度分布（饼图） */
export function buildConfidenceChart(claims: ResearchClaim[]): ChartSpec | null {
  if (claims.length === 0) return null;
  const high = claims.filter((c) => c.confidence >= 0.7).length;
  const mid = claims.filter((c) => c.confidence >= 0.4 && c.confidence < 0.7).length;
  const low = claims.length - high - mid;
  const disputed = claims.filter((c) => c.disputed).length;
  return {
    title: '结论置信度分布',
    kind: 'pie',
    data: {
      mermaid: ['```mermaid', 'pie showData', '    title 结论置信度分布', `    "高置信（≥0.7）" : ${high}`, `    "中等置信" : ${mid}`, `    "低置信" : ${low}`, ...(disputed > 0 ? [`    "存在来源冲突" : ${disputed}`] : []), '```'].join('\n'),
      segments: { high, mid, low, disputed },
    },
  };
}

/** 来源类型分布（Mermaid 流程图，直观展示来源结构） */
export function buildSourceChart(sources: ResearchSource[]): ChartSpec | null {
  if (sources.length === 0) return null;
  const web = sources.filter((s) => /^https?:/.test(s.url)).length;
  const local = sources.filter((s) => s.url.startsWith('file://')).length;
  const knowledge = sources.filter((s) => s.url.startsWith('knowledge://')).length;
  return {
    title: '来源结构',
    kind: 'mermaid',
    data: {
      mermaid: ['```mermaid', 'graph LR', `    A[来源 ${sources.length}] --> B[外部 ${web}]`, `    A --> C[本地文件 ${local}]`, `    A --> D[待核查问题 ${knowledge}]`, '```'].join('\n'),
      counts: { web, local, knowledge },
    },
  };
}

export function buildCharts(sources: ResearchSource[], claims: ResearchClaim[]): ChartSpec[] {
  return [buildNumericChart(sources), buildConfidenceChart(claims), buildSourceChart(sources)].filter((c): c is ChartSpec => c !== null);
}
