/**
 * M183-D — the primary paired resolution outcome.
 *
 *   bun run_stage5_m183_outcomes.ts
 *
 * Reads `stage5_m183_pair_records.jsonl` and nothing else. It does not open a
 * gold patch, a focus, an orientation packet or a transcript: §88 says the grade
 * is decided independently of treatment telemetry, and the way to make that true
 * is for this script to be unable to see it.
 *
 * The headline is RESOLVED. Gold-file localization is not reported here at all —
 * it lives in the diagnostics step, downstream, after grading, because §147's
 * failure mode is a localization rate quietly standing in for a solve rate.
 *
 * WHAT IS DELIBERATELY NOT CONCLUDED. An observed difference of one or two tasks
 * out of thirty is reported as a count with its exact uncertainty, and the
 * statistical verdict is computed separately from the observed one so the report
 * can say "improved, and not resolved statistically" — which at this sample size
 * is the likeliest true sentence (§41/§43/§91/§92).
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  exactMcNemar, resolutionCounts, resolutionDifferenceInterval, resolutionVerdict,
  statisticalVerdict,
} from "./m183Analysis";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const BOOTSTRAP_SEED = "M183-resolution/v1";

interface PairRecord {
  instanceId: string; repo: string; difficulty: string; stratum: string;
  m173Overlap: boolean; executionOrder: number; armOrder: string[] | null;
  pairValid: boolean; pairInvalidReason: string | null;
  baseline: { valid: boolean; resolved: boolean; graded: boolean; costUsd: number | null; numTurns: number | null; costLimitHit: boolean; turnLimitHit: boolean; reachedAnEdit: boolean };
  treatment: { valid: boolean; resolved: boolean; graded: boolean; costUsd: number | null; numTurns: number | null; costLimitHit: boolean; turnLimitHit: boolean; reachedAnEdit: boolean; triggerInjected: boolean };
  orientation: { deliveryState: string } | null;
}

function main(): void {
  const records = readFileSync(path.join(RESULTS, "stage5_m183_pair_records.jsonl"), "utf8")
    .split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as PairRecord);

  const valid = records.filter((r) => r.pairValid);
  const ungraded = valid.filter((r) => !r.baseline.graded || !r.treatment.graded);
  // §88: an ungraded arm has no resolution. It is excluded from the resolution
  // analysis and SAID, never defaulted to unresolved.
  const graded = valid.filter((r) => r.baseline.graded && r.treatment.graded);

  const pairs = graded.map((r) => ({
    instanceId: r.instanceId, repo: r.repo, stratum: r.stratum,
    baselineResolved: r.baseline.resolved, treatmentResolved: r.treatment.resolved,
  }));

  const counts = resolutionCounts(pairs);
  const test = exactMcNemar(counts.treatmentOnly, counts.baselineOnly);
  const interval = resolutionDifferenceInterval(pairs, BOOTSTRAP_SEED);
  const observed = resolutionVerdict(counts);
  const statistical = statisticalVerdict(counts, test);

  const byGroup = (key: (r: typeof pairs[number]) => string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const g of [...new Set(pairs.map(key))].sort()) {
      const subset = pairs.filter((p) => key(p) === g);
      const c = resolutionCounts(subset);
      out[g] = {
        pairs: c.validPairs, baselineResolved: c.baselineResolved, treatmentResolved: c.treatmentResolved,
        bothSolved: c.bothSolved, treatmentOnly: c.treatmentOnly, baselineOnly: c.baselineOnly, neither: c.neither,
      };
    }
    return out;
  };

  const resolutionPairs = {
    schemaVersion: "stage5.m183.resolution-pairs.v1",
    milestone: "M183", workstream: "M183-D",
    grader: "official Docker grading path (stage5_m183_grader_contract.md)",
    manifestInstances: records.length,
    validPairs: valid.length,
    gradedPairs: graded.length,
    ungradedValidPairs: ungraded.map((r) => r.instanceId),
    invalidPairs: records.filter((r) => !r.pairValid).map((r) => ({ instanceId: r.instanceId, reason: r.pairInvalidReason })),
    pairs: graded.map((r) => ({
      instanceId: r.instanceId, repo: r.repo, difficulty: r.difficulty, stratum: r.stratum,
      m173Overlap: r.m173Overlap, armOrder: r.armOrder,
      baselineResolved: r.baseline.resolved, treatmentResolved: r.treatment.resolved,
      outcome: r.baseline.resolved && r.treatment.resolved ? "BOTH"
        : r.treatment.resolved ? "TREATMENT_ONLY"
        : r.baseline.resolved ? "BASELINE_ONLY" : "NEITHER",
      orientationDelivered: r.treatment.triggerInjected === true,
      orientationState: r.orientation?.deliveryState ?? null,
      baselineCostLimitHit: r.baseline.costLimitHit, treatmentCostLimitHit: r.treatment.costLimitHit,
      baselineTurnLimitHit: r.baseline.turnLimitHit, treatmentTurnLimitHit: r.treatment.turnLimitHit,
    })),
  };

  const stats = {
    schemaVersion: "stage5.m183.resolution-stats.v1",
    milestone: "M183", workstream: "M183-D",
    counts: {
      validPairs: counts.validPairs,
      baselineResolved: counts.baselineResolved,
      treatmentResolved: counts.treatmentResolved,
      bothSolved: counts.bothSolved,
      treatmentOnly: counts.treatmentOnly,
      baselineOnly: counts.baselineOnly,
      neither: counts.neither,
    },
    absoluteDifference: counts.validPairs === 0 ? null
      : (counts.treatmentResolved - counts.baselineResolved) / counts.validPairs,
    rawDifferenceStatedAsCounts: counts.validPairs === 0 ? null
      : `${counts.treatmentResolved} vs ${counts.baselineResolved} of ${counts.validPairs}`,
    pairedTest: {
      method: "two-sided exact McNemar (binomial on the discordant pairs at p=0.5)",
      whyNotUnpaired: "§42 — the arms are paired by task, so all the information about a difference is in the discordant pairs; an unpaired proportions test discards the pairing and reports a smaller p-value than this design earns.",
      discordantPairs: test.discordant,
      treatmentOnly: counts.treatmentOnly, baselineOnly: counts.baselineOnly,
      pValue: test.pValue,
      interpretable: test.interpretable,
      zeroDiscordantMeaning: test.interpretable ? null
        : "No discordant pairs. This is NO INFORMATION about a difference, not evidence of equality.",
    },
    pairedInterval: {
      method: "percentile bootstrap over PAIRS (10,000 resamples), preserving the pairing",
      seed: BOOTSTRAP_SEED,
      ...interval,
    },
    verdicts: { resolution: observed, statistical },
    byRepository: byGroup((p) => p.repo),
    byStratum: byGroup((p) => p.stratum),
    interpretationGuard:
      "§41 — an observed difference of one or two tasks out of thirty is reported as a count with its uncertainty and is NOT described as an improvement in solve rate. The observed verdict and the statistical verdict are separate fields precisely so both can be said.",
  };

  writeFileSync(path.join(RESULTS, "stage5_m183_resolution_pairs.json"), `${JSON.stringify(resolutionPairs, null, 2)}\n`);
  writeFileSync(path.join(RESULTS, "stage5_m183_resolution_stats.json"), `${JSON.stringify(stats, null, 2)}\n`);

  console.log(`M183-D — valid pairs ${valid.length}, graded ${graded.length} of ${records.length} manifest instances`);
  console.log(`  baseline resolved  ${counts.baselineResolved} / ${counts.validPairs}`);
  console.log(`  VTRACE   resolved  ${counts.treatmentResolved} / ${counts.validPairs}`);
  console.log(`  both ${counts.bothSolved}  VTRACE-only ${counts.treatmentOnly}  baseline-only ${counts.baselineOnly}  neither ${counts.neither}`);
  console.log(`  exact McNemar p = ${test.pValue === null ? "n/a (no discordant pairs)" : test.pValue.toFixed(4)}`);
  console.log(`  verdicts: ${observed} / ${statistical}`);
}

main();
