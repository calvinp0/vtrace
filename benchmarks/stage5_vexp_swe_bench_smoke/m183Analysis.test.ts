import { describe, expect, test } from "bun:test";

import {
  bootstrapInterval, describe as describeDist, effectVerdict, exactMcNemar, mean, median,
  quantile, reductionView, resolutionCounts, resolutionDifferenceInterval, resolutionVerdict,
  seededRandom, statisticalVerdict, totalAgentTokens, trimmedMean,
} from "./m183Analysis";

const pair = (b: boolean, t: boolean) => ({ baselineResolved: b, treatmentResolved: t });

describe("token accounting", () => {
  test("TOTAL_AGENT_TOKENS includes cache traffic, which is nearly all of it", () => {
    // A real M173 baseline row. Input+output is 0.03% of the traffic.
    const row = { inputTokens: 83, outputTokens: 10, cacheReadTokens: 279_087, cacheCreationTokens: 31_273 };
    expect(totalAgentTokens(row)).toBe(310_453);
    expect(row.inputTokens + row.outputTokens).toBeLessThan(totalAgentTokens(row) * 0.001);
  });
});

describe("descriptive statistics", () => {
  test("median handles even and odd lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
  });
  test("quantile interpolates", () => {
    expect(quantile([0, 10], 0.5)).toBe(5);
    expect(quantile([0, 1, 2, 3, 4], 0.9)).toBeCloseTo(3.6, 10);
  });
  test("a trimmed mean moves off a tail and the untrimmed one does not", () => {
    const heavy = [1, 1, 1, 1, 1, 1, 1, 1, 1, 100];
    expect(mean(heavy)).toBeCloseTo(10.9, 10);
    expect(trimmedMean(heavy, 0.1)).toBeCloseTo(1, 10);
  });
  test("describe reports sign counts so a mixed distribution cannot hide in a mean", () => {
    const d = describeDist([-2, -1, 0, 1, 5]);
    expect([d.negative, d.zero, d.positive]).toEqual([2, 1, 2]);
    expect(d.sum).toBe(3);
  });
});

describe("resolution counts", () => {
  test("the four cells partition the pairs and the margins agree", () => {
    const pairs = [pair(true, true), pair(true, false), pair(false, true), pair(false, true), pair(false, false)];
    const c = resolutionCounts(pairs);
    expect([c.bothSolved, c.baselineOnly, c.treatmentOnly, c.neither]).toEqual([1, 1, 2, 1]);
    expect(c.bothSolved + c.baselineOnly + c.treatmentOnly + c.neither).toBe(c.validPairs);
    expect(c.baselineResolved).toBe(2);
    expect(c.treatmentResolved).toBe(3);
  });
});

describe("exact McNemar", () => {
  test("zero discordant pairs is NO INFORMATION, not p=1", () => {
    const t = exactMcNemar(0, 0);
    expect(t.pValue).toBeNull();
    expect(t.interpretable).toBe(false);
  });
  test("a symmetric split is maximally unsurprising", () => {
    expect(exactMcNemar(3, 3).pValue).toBeCloseTo(1, 10);
  });
  test("known values against the binomial", () => {
    // b=5, c=0 -> 2 * P(X<=0 | n=5, p=0.5) = 2 * 1/32 = 0.0625
    expect(exactMcNemar(5, 0).pValue).toBeCloseTo(0.0625, 10);
    // b=6, c=0 -> 2 * 1/64 = 0.03125
    expect(exactMcNemar(6, 0).pValue).toBeCloseTo(0.03125, 10);
    // b=1, c=0 -> 2 * 0.5 = 1
    expect(exactMcNemar(1, 0).pValue).toBeCloseTo(1, 10);
    // Symmetric in its arguments: the test does not know which arm is which.
    expect(exactMcNemar(2, 7).pValue).toBeCloseTo(exactMcNemar(7, 2).pValue!, 12);
  });
  test("a 30-pair sample cannot resolve a one-task difference", () => {
    // The realistic case the prompt warns about in §41.
    expect(exactMcNemar(4, 3).pValue!).toBeGreaterThan(0.5);
  });
});

describe("verdicts", () => {
  test("observed and statistical verdicts are independent", () => {
    const counts = resolutionCounts([pair(false, true), pair(true, false), pair(false, true), ...Array.from({ length: 27 }, () => pair(true, true))]);
    expect(resolutionVerdict(counts)).toBe("OBSERVED_RESOLUTION_IMPROVEMENT");
    // ...and yet 2 vs 1 discordant resolves nothing.
    expect(statisticalVerdict(counts, exactMcNemar(counts.treatmentOnly, counts.baselineOnly)))
      .toBe("RESOLUTION_DIFFERENCE_NOT_STATISTICALLY_RESOLVED");
  });
  test("too few valid pairs is said plainly rather than tested", () => {
    const counts = resolutionCounts([pair(false, true), pair(true, false)]);
    expect(statisticalVerdict(counts, exactMcNemar(1, 1))).toBe("INSUFFICIENT_VALID_PAIRS");
  });
  test("an empty sample is NOT_MEASURABLE, not parity", () => {
    expect(resolutionVerdict(resolutionCounts([]))).toBe("RESOLUTION_NOT_MEASURABLE");
  });
  test("effect verdict separates a real effect from a straddling one", () => {
    expect(effectVerdict({ point: 5, lower: 1, upper: 9, resamples: 10 }, 5, 5)).toBe("REDUCTION_CONFIRMED");
    expect(effectVerdict({ point: -5, lower: -9, upper: -1, resamples: 10 }, -5, -5)).toBe("INCREASE_CONFIRMED");
    expect(effectVerdict({ point: 1, lower: -3, upper: 5, resamples: 10 }, 1, 1)).toBe("NEUTRAL");
    // Median and pooled disagreeing in sign is what MIXED is for.
    expect(effectVerdict({ point: 1, lower: -3, upper: 5, resamples: 10 }, 2, -7)).toBe("MIXED");
  });
});

describe("bootstrap", () => {
  test("the seeded generator is deterministic and machine-independent", () => {
    const a = seededRandom("m183");
    const b = seededRandom("m183");
    const draws = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(draws);
    expect(draws.every((d) => d >= 0 && d < 1)).toBe(true);
    expect(new Set(draws).size).toBe(5);
    expect(Array.from({ length: 5 }, seededRandom("other"))).not.toEqual(draws);
  });
  test("the same input gives the same interval every time", () => {
    const xs = [1, 2, 3, 4, 5, 20];
    const one = bootstrapInterval(xs, mean, "seed", 500);
    const two = bootstrapInterval(xs, mean, "seed", 500);
    expect(one).toEqual(two);
    expect(one.point).toBeCloseTo(mean(xs), 10);
    expect(one.lower).toBeLessThanOrEqual(one.point);
    expect(one.upper).toBeGreaterThanOrEqual(one.point);
  });
  test("an all-concordant sample gives a zero-width interval at zero", () => {
    const i = resolutionDifferenceInterval(Array.from({ length: 20 }, () => pair(true, true)), "s", 200);
    expect(i.point).toBe(0);
    expect(i.lower).toBe(0);
    expect(i.upper).toBe(0);
  });
  test("the resolution interval is the paired difference in proportions", () => {
    const pairs = [pair(false, true), pair(false, true), pair(true, false), ...Array.from({ length: 7 }, () => pair(true, true))];
    const i = resolutionDifferenceInterval(pairs, "s", 200);
    expect(i.point).toBeCloseTo((2 - 1) / 10, 10);
  });
});

describe("reduction views", () => {
  test("median-of-ratios and pooled ratio are reported as different numbers", () => {
    // One huge pair dominates the pooled view; the per-pair median does not see it.
    const pairs = [
      { baseline: 100, treatment: 50 },   // 50% reduction
      { baseline: 100, treatment: 50 },   // 50%
      { baseline: 10_000, treatment: 20_000 }, // -100%
    ];
    const v = reductionView(pairs);
    expect(v.medianPairedPercent).toBeCloseTo(50, 10);
    expect(v.pooledPercent).toBeLessThan(0);
    expect(v.pooledBaseline).toBe(10_200);
    expect(v.pooledTreatment).toBe(20_100);
  });
  test("a zero baseline is dropped from the ratio rather than producing infinity", () => {
    const v = reductionView([{ baseline: 0, treatment: 5 }, { baseline: 10, treatment: 5 }]);
    expect(v.pairsWithUsableRatio).toBe(1);
    expect(v.medianPairedPercent).toBeCloseTo(50, 10);
    // ...but it still counts in the absolute delta and the pooled totals.
    expect(v.pooledBaseline).toBe(10);
    // deltas are [0-5, 10-5] = [-5, 5]; their median is 0.
    expect(v.medianAbsoluteDelta).toBeCloseTo(0, 10);
  });
});
