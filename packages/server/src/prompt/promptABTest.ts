import type { PromptABTestInfo, PromptEvaluationInfo, PromptABTestReport } from '@ai/shared';

/**
 * A/B 测试与效果评估（Phase 4 Step 3）。
 *
 * 指标设计（两类，缺一不可）：
 *   人工指标：accuracy（准确性）、clarity（清晰度）、usefulness（可用性）—— 1~5 分
 *   自动指标：structure（九要素完整度）、length（长度合理性）、variableCoverage（变量覆盖率）
 *
 * 胜负判定：先比人工总分均值；人工样本不足（< 2）时退化为自动指标，
 * 并在 reason 里明确写出「样本不足，结论仅供参考」—— 不能给出没有依据的赢家。
 */

export const MANUAL_METRICS = ['accuracy', 'clarity', 'usefulness'] as const;
export const AUTO_METRICS = ['structure', 'length', 'variableCoverage'] as const;

export const METRIC_LABELS: Record<string, string> = {
  accuracy: '准确性',
  clarity: '清晰度',
  usefulness: '可用性',
  structure: '结构完整度',
  length: '长度合理性',
  variableCoverage: '变量覆盖率',
};

export interface ScoreInput {
  version: string;
  metrics: { metric: string; value: number; sampleSize?: number }[];
}

/** 单版本聚合：人工分与自动分分别求加权平均 */
export function aggregateVersion(input: ScoreInput): { version: string; metrics: Record<string, number>; sampleSize: number; score: number } {
  const metrics: Record<string, number> = {};
  let sampleSize = 0;
  for (const m of input.metrics) {
    metrics[m.metric] = m.value;
    sampleSize = Math.max(sampleSize, m.sampleSize ?? 0);
  }
  // 人工指标权重 0.75，自动指标 0.25：最终看得是「有没有用」，不是「工整不工整」
  const manual = MANUAL_METRICS.map((k) => metrics[k]).filter((v): v is number => typeof v === 'number');
  const auto = AUTO_METRICS.map((k) => metrics[k]).filter((v): v is number => typeof v === 'number');
  const manualAvg = manual.length ? manual.reduce((a, b) => a + b, 0) / manual.length : 0;
  const autoAvg = auto.length ? auto.reduce((a, b) => a + b, 0) / auto.length : 0;
  const score = manual.length && auto.length ? manualAvg * 0.75 + autoAvg * 0.25 : manualAvg || autoAvg;
  return { version: input.version, metrics, sampleSize, score: Math.round(score * 100) / 100 };
}

export interface DecideInput {
  versionA: ScoreInput;
  versionB: ScoreInput;
  /** 最少人工样本数，低于则结论降级 */
  minSample?: number;
}

export interface DecideOutput {
  summary: PromptABTestReport['summary'];
  winner: string | null;
  reason: string;
}

export function decide(input: DecideInput): DecideOutput {
  const a = aggregateVersion(input.versionA);
  const b = aggregateVersion(input.versionB);
  const minSample = input.minSample ?? 2;
  const summary = [a, b];

  const aManual = MANUAL_METRICS.some((m) => typeof a.metrics[m] === 'number');
  const bManual = MANUAL_METRICS.some((m) => typeof b.metrics[m] === 'number');
  const sampleEnough = Math.min(a.sampleSize, b.sampleSize) >= minSample;

  if (!aManual && !bManual) {
    if (a.score === b.score) {
      return { summary, winner: null, reason: '两版本自动指标相同，且均无人工评分，无法判定优劣。请补充人工评分。' };
    }
    const winner = a.score > b.score ? a.version : b.version;
    return { summary, winner, reason: `无人工评分，暂按自动指标（结构/长度/变量覆盖）判定 ${winner} 更优；建议补充人工评分后再定稿。` };
  }

  if (!sampleEnough) {
    const winner = a.score > b.score ? a.version : b.version;
    return {
      summary,
      winner,
      reason: `人工样本不足（要求各版本 ≥ ${minSample} 条，当前 A=${a.sampleSize}、B=${b.sampleSize}），结论仅供参考：${winner} 暂时领先。`,
    };
  }

  const diff = Math.abs(a.score - b.score);
  if (diff < 0.15) {
    return { summary, winner: null, reason: `两版本得分接近（差值 ${diff.toFixed(2)}），差异不显著，建议保持现状或继续采样。` };
  }
  const winner = a.score > b.score ? a.version : b.version;
  return { summary, winner, reason: `${winner} 综合得分更高（A=${a.score}，B=${b.score}，人工权重 0.75）。` };
}

/** 自动指标：结构完整度（九要素覆盖率 0~5 分） */
export function scoreStructure(filled: number, total = 9): number {
  if (total <= 0) return 0;
  return Math.round((Math.min(filled, total) / total) * 5 * 100) / 100;
}

/** 自动指标：长度合理性（越接近理想长度越高，超出或过短都扣分） */
export function scoreLength(chars: number, ideal = 800): number {
  if (chars <= 0) return 0;
  const ratio = chars / ideal;
  // 0.5x~2x 视为合理区间；偏离越大分越低
  const penalty = ratio < 0.5 ? (0.5 - ratio) * 4 : ratio > 2 ? Math.min(3, (ratio - 2) * 1.5) : 0;
  return Math.max(0, Math.round((5 - penalty) * 100) / 100);
}

/** 自动指标：变量覆盖率（已声明且有默认值/被使用） */
export function scoreVariableCoverage(declared: number, used: number): number {
  if (declared === 0 && used === 0) return 5;
  if (declared === 0) return 0;
  return Math.round(Math.min(1, used / declared) * 5 * 100) / 100;
}

export type { PromptABTestInfo, PromptEvaluationInfo, PromptABTestReport };
