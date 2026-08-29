/**
 * M183 analysis core — paired outcomes, paired economics, paired uncertainty.
 *
 * PURE. No I/O, no clock, no randomness that is not seeded. §143 requires the
 * headline numbers to be reconstructible from the committed compact records, so
 * every statistic here is a deterministic function of the pair list.
 *
 * THREE THINGS THIS MODULE REFUSES TO DO.
 *
 *   It does not average percentages when the denominators vary (§45). A pooled
 *   ratio and a median of per-pair ratios answer different questions and are
 *   reported as two numbers, never blended into one.
 *
 *   It does not use an unpaired proportions test (§42). The arms are paired by
 *   task, so the information about a resolution difference lives entirely in the
 *   discordant pairs, and an unpaired test would throw that pairing away and
 *   report a smaller p-value than the design earns.
 *
 *   It does not decide anything from `inputTokens + outputTokens` (§37). A real
 *   M173 baseline row spent 83 input and 10 output tokens against 279,087 cache
 *   reads; a comparison built on the first two would compare rounding errors.
 */

import { createHash } from "node:crypto";

// ── token accounting, defined once (§37) ────────────────────────────

export interface ArmTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/** The whole-run total. The ONLY definition M183 uses. */
export const totalAgentTokens = (t: ArmTokens): number =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens;

// ── descriptive statistics ──────────────────────────────────────────

export const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;

export const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

export const quantile = (xs: readonly number[], q: number): number => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
};

/**
 * Symmetric trimmed mean, for §102's sensitivity view.
 *
 * Reported ALONGSIDE the untrimmed mean and the pooled total, never instead of
 * them: trimming a heavy-tailed cost distribution is exactly how a tail-driven
 * result gets presented as a central one.
 */
export function trimmedMean(xs: readonly number[], proportion: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.floor(s.length * proportion);
  const kept = k === 0 ? s : s.slice(k, s.length - k);
  return kept.length === 0 ? Number.NaN : mean(kept);
}

export interface Distribution {
  readonly n: number;
  readonly median: number;
  readonly mean: number;
  readonly trimmedMean10: number;
  readonly p10: number;
  readonly p90: number;
  readonly min: number;
  readonly max: number;
  readonly sum: number;
  readonly negative: number;
  readonly positive: number;
  readonly zero: number;
}

export function describe(xs: readonly number[]): Distribution {
  return Object.freeze({
    n: xs.length,
    median: median(xs), mean: mean(xs), trimmedMean10: trimmedMean(xs, 0.1),
    p10: quantile(xs, 0.1), p90: quantile(xs, 0.9),
    min: xs.length === 0 ? Number.NaN : Math.min(...xs),
    max: xs.length === 0 ? Number.NaN : Math.max(...xs),
    sum: sum(xs),
    negative: xs.filter((x) => x < 0).length,
    positive: xs.filter((x) => x > 0).length,
    zero: xs.filter((x) => x === 0).length,
  });
}

// ── paired binary outcome: exact McNemar (§42) ──────────────────────

export interface ResolutionCounts {
  readonly bothSolved: number;
  readonly treatmentOnly: number;
  readonly baselineOnly: number;
  readonly neither: number;
  readonly validPairs: number;
  readonly baselineResolved: number;
  readonly treatmentResolved: number;
}

export function resolutionCounts(
  pairs: readonly { readonly baselineResolved: boolean; readonly treatmentResolved: boolean }[],
): ResolutionCounts {
  const bothSolved = pairs.filter((p) => p.baselineResolved && p.treatmentResolved).length;
  const treatmentOnly = pairs.filter((p) => !p.baselineResolved && p.treatmentResolved).length;
  const baselineOnly = pairs.filter((p) => p.baselineResolved && !p.treatmentResolved).length;
  const neither = pairs.filter((p) => !p.baselineResolved && !p.treatmentResolved).length;
  return Object.freeze({
    bothSolved, treatmentOnly, baselineOnly, neither,
    validPairs: pairs.length,
    baselineResolved: bothSolved + baselineOnly,
    treatmentResolved: bothSolved + treatmentOnly,
  });
}

/** Exact binomial coefficient in floating point; n stays small here. */
function binomialPmf(k: number, n: number, p: number): number {
  let logC = 0;
  for (let i = 1; i <= k; i += 1) logC += Math.log(n - k + i) - Math.log(i);
  return Math.exp(logC + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

/**
 * Two-sided exact McNemar over the discordant pairs.
 *
 * With b treatment-only and c baseline-only wins, the null is that a discordant
 * pair is a fair coin. The exact test is the two-sided binomial on b successes
 * out of b+c at p=0.5, which is the right test at these sample sizes — the
 * chi-square approximation is unreliable when b+c is small, and b+c is expected
 * to be small here. Zero discordant pairs is NOT p=1 evidence of equality; it is
 * no information, and is reported as such.
 */
export function exactMcNemar(treatmentOnly: number, baselineOnly: number): {
  readonly discordant: number;
  readonly pValue: number | null;
  readonly interpretable: boolean;
} {
  const n = treatmentOnly + baselineOnly;
  if (n === 0) {
    return Object.freeze({ discordant: 0, pValue: null, interpretable: false });
  }
  const k = Math.min(treatmentOnly, baselineOnly);
  let tail = 0;
  for (let i = 0; i <= k; i += 1) tail += binomialPmf(i, n, 0.5);
  return Object.freeze({ discordant: n, pValue: Math.min(1, 2 * tail), interpretable: true });
}

// ── deterministic paired bootstrap (§103) ───────────────────────────

/** xorshift128, seeded from a string. Reproducible across machines and runs. */
export function seededRandom(seed: string): () => number {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  let x = digest.readUInt32LE(0) || 1;
  let y = digest.readUInt32LE(4) || 2;
  let z = digest.readUInt32LE(8) || 3;
  let w = digest.readUInt32LE(12) || 4;
  return () => {
    const t = x ^ (x << 11);
    x = y; y = z; z = w;
    w = (w ^ (w >>> 19)) ^ (t ^ (t >>> 8));
    return (w >>> 0) / 0x1_0000_0000;
  };
}

export interface Interval { readonly point: number; readonly lower: number; readonly upper: number; readonly resamples: number }

/**
 * Percentile bootstrap over PAIRS, not over arms.
 *
 * Resampling pairs preserves the pairing; resampling the two arms independently
 * would destroy it and produce an interval for a comparison this design did not
 * make.
 */
export function bootstrapInterval(
  values: readonly number[],
  statistic: (xs: readonly number[]) => number,
  seed: string,
  resamples = 10_000,
): Interval {
  if (values.length === 0) {
    return Object.freeze({ point: Number.NaN, lower: Number.NaN, upper: Number.NaN, resamples: 0 });
  }
  const rng = seededRandom(seed);
  const draws: number[] = [];
  for (let r = 0; r < resamples; r += 1) {
    const sample: number[] = [];
    for (let i = 0; i < values.length; i += 1) {
      sample.push(values[Math.floor(rng() * values.length)]!);
    }
    draws.push(statistic(sample));
  }
  return Object.freeze({
    point: statistic(values),
    lower: quantile(draws, 0.025),
    upper: quantile(draws, 0.975),
    resamples,
  });
}

/**
 * Bootstrap the paired resolution difference (treatmentResolved - baselineResolved) / n.
 *
 * Encoded per pair as +1 (treatment-only), -1 (baseline-only), 0 (concordant),
 * so the resampled statistic is the mean of that encoding — which is exactly the
 * paired difference in proportions.
 */
export function resolutionDifferenceInterval(
  pairs: readonly { readonly baselineResolved: boolean; readonly treatmentResolved: boolean }[],
  seed: string,
  resamples = 10_000,
): Interval {
  const encoded = pairs.map((p) =>
    p.treatmentResolved === p.baselineResolved ? 0 : p.treatmentResolved ? 1 : -1);
  return bootstrapInterval(encoded, mean, seed, resamples);
}

// ── paired reduction (§45) ──────────────────────────────────────────

export interface ReductionView {
  /** Median of the per-pair (B - V) / B ratios. Undefined denominators dropped. */
  readonly medianPairedPercent: number;
  /** (sum B - sum V) / sum B. A different question, reported separately. */
  readonly pooledPercent: number;
  readonly medianAbsoluteDelta: number;
  readonly meanAbsoluteDelta: number;
  readonly pooledBaseline: number;
  readonly pooledTreatment: number;
  readonly pairsWithUsableRatio: number;
}

export function reductionView(
  pairs: readonly { readonly baseline: number; readonly treatment: number }[],
): ReductionView {
  const usable = pairs.filter((p) => p.baseline > 0);
  const ratios = usable.map((p) => ((p.baseline - p.treatment) / p.baseline) * 100);
  const deltas = pairs.map((p) => p.baseline - p.treatment);
  const pooledBaseline = sum(pairs.map((p) => p.baseline));
  const pooledTreatment = sum(pairs.map((p) => p.treatment));
  return Object.freeze({
    medianPairedPercent: median(ratios),
    pooledPercent: pooledBaseline === 0 ? Number.NaN : ((pooledBaseline - pooledTreatment) / pooledBaseline) * 100,
    medianAbsoluteDelta: median(deltas),
    meanAbsoluteDelta: mean(deltas),
    pooledBaseline, pooledTreatment,
    pairsWithUsableRatio: usable.length,
  });
}

// ── verdict vocabulary (§111-§118) ──────────────────────────────────

export type ResolutionVerdict =
  | "OBSERVED_RESOLUTION_IMPROVEMENT" | "OBSERVED_RESOLUTION_PARITY"
  | "OBSERVED_RESOLUTION_REGRESSION" | "RESOLUTION_NOT_MEASURABLE";

export type StatisticalVerdict =
  | "RESOLUTION_ADVANTAGE_STATISTICALLY_SUPPORTED"
  | "RESOLUTION_DIFFERENCE_NOT_STATISTICALLY_RESOLVED"
  | "RESOLUTION_REGRESSION_STATISTICALLY_SUPPORTED"
  | "INSUFFICIENT_VALID_PAIRS";

export type EffectVerdict = "REDUCTION_CONFIRMED" | "NEUTRAL" | "INCREASE_CONFIRMED" | "MIXED" | "NOT_MEASURABLE";

export function resolutionVerdict(counts: ResolutionCounts): ResolutionVerdict {
  if (counts.validPairs === 0) return "RESOLUTION_NOT_MEASURABLE";
  if (counts.treatmentResolved > counts.baselineResolved) return "OBSERVED_RESOLUTION_IMPROVEMENT";
  if (counts.treatmentResolved < counts.baselineResolved) return "OBSERVED_RESOLUTION_REGRESSION";
  return "OBSERVED_RESOLUTION_PARITY";
}

/**
 * The statistical verdict is DELIBERATELY conservative and separate from the
 * observed one (§91/§92). An observed improvement with p = 0.5 is an observed
 * improvement that is not statistically resolved, and both halves are said.
 */
export function statisticalVerdict(
  counts: ResolutionCounts,
  test: ReturnType<typeof exactMcNemar>,
  minimumValidPairs = 10,
): StatisticalVerdict {
  if (counts.validPairs < minimumValidPairs) return "INSUFFICIENT_VALID_PAIRS";
  if (!test.interpretable || test.pValue === null || test.pValue > 0.05) {
    return "RESOLUTION_DIFFERENCE_NOT_STATISTICALLY_RESOLVED";
  }
  return counts.treatmentOnly > counts.baselineOnly
    ? "RESOLUTION_ADVANTAGE_STATISTICALLY_SUPPORTED"
    : "RESOLUTION_REGRESSION_STATISTICALLY_SUPPORTED";
}

/**
 * An effect verdict from an interval, not from a point estimate.
 *
 * `MIXED` is reserved for a genuinely split picture — the interval straddles zero
 * AND the median and the pooled aggregate disagree in sign — rather than being
 * the place uncomfortable results go.
 */
export function effectVerdict(
  interval: Interval,
  medianDelta: number,
  pooledDelta: number,
): EffectVerdict {
  if (!Number.isFinite(interval.point)) return "NOT_MEASURABLE";
  const straddles = interval.lower <= 0 && interval.upper >= 0;
  if (!straddles) return interval.point > 0 ? "REDUCTION_CONFIRMED" : "INCREASE_CONFIRMED";
  const signsDisagree = Math.sign(medianDelta) !== 0 && Math.sign(pooledDelta) !== 0
    && Math.sign(medianDelta) !== Math.sign(pooledDelta);
  return signsDisagree ? "MIXED" : "NEUTRAL";
}
