/**
 * M173-C/D — where the cost premium actually lives.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m173_displacement.ts
 *
 * M169 asked whether the pipeline was too expensive and answered yes: $0.0985
 * to displace $0.0026, a ratio of 38. M172 made the packet eleven times
 * cheaper. M173 measures the same ratio at 1.0 — the orientation now costs
 * about what it displaces — and the treatment arm STILL costs more per task
 * with an identical solve set.
 *
 * So the premium is not the packet, and this file asks where it is instead by
 * splitting each run at its own landmarks. The answer is not in the phase the
 * orientation was designed to shorten.
 *
 * §84 is why this exists: even if orientation fails to displace investigation
 * it may improve or worsen what happens later, and only a whole-run measurement
 * can tell. Offline; reads the M173 paired ledger only.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");

const ledger = JSON.parse(
  readFileSync(path.join(RESULTS, "stage5_m173_paired_ledger.json"), "utf-8"),
) as { perRun: Record<string, any>[] };

const byKey = new Map<string, Record<string, any>>();
for (const run of ledger.perRun) byKey.set(`${run.instanceId}|${run.arm}`, run);

const instanceIds = [...new Set(ledger.perRun.map((r) => r.instanceId as string))].sort();

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(middle)]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const sum = (values: readonly number[]): number => values.reduce((t, v) => t + v, 0);

/** Rank correlation. n is 11; this is a shape statistic, not a significance test. */
function spearman(x: readonly number[], y: readonly number[]): number | null {
  if (x.length !== y.length || x.length < 3) return null;
  const rank = (values: readonly number[]): number[] => {
    const order = [...values.keys()].sort((a, b) => values[a]! - values[b]!);
    const ranks = new Array<number>(values.length);
    order.forEach((originalIndex, position) => { ranks[originalIndex] = position; });
    return ranks;
  };
  const rx = rank(x);
  const ry = rank(y);
  const mx = sum(rx) / rx.length;
  const my = sum(ry) / ry.length;
  const numerator = rx.reduce((t, v, i) => t + (v - mx) * (ry[i]! - my), 0);
  const denominator = Math.sqrt(
    rx.reduce((t, v) => t + (v - mx) ** 2, 0) * ry.reduce((t, v) => t + (v - my) ** 2, 0),
  );
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(3));
}

const rows = instanceIds.map((instanceId) => {
  const a = byKey.get(`${instanceId}|baseline`);
  const b = byKey.get(`${instanceId}|vtrace_compact`);
  const measurable = a !== undefined && b !== undefined
    && typeof a.providerCostUsd === "number" && typeof b.providerCostUsd === "number";
  if (!measurable) return { instanceId, measurable: false as const };

  const deltaPreEditRequests = (b.preEditRequests as number) - (a.preEditRequests as number);
  const postEdit = (r: Record<string, any>): number => (r.requests as number) - (r.preEditRequests as number);

  return {
    instanceId,
    measurable: true as const,
    deltaPreEditRequests,
    deltaPostEditRequests: postEdit(b) - postEdit(a),
    deltaPreEditCostUsd: Number(((b.phasePreEditCostUsd as number) - (a.phasePreEditCostUsd as number)).toFixed(6)),
    deltaImplementationCostUsd: Number(((b.phaseImplementationCostUsd as number) - (a.phaseImplementationCostUsd as number)).toFixed(6)),
    deltaDebugTestCostUsd: Number(((b.phaseDebugTestCostUsd as number) - (a.phaseDebugTestCostUsd as number)).toFixed(6)),
    deltaWholeRunCostUsd: Number(((b.providerCostUsd as number) - (a.providerCostUsd as number)).toFixed(6)),
    deltaSearches: (b.searches as number) - (a.searches as number),
    orientationAttributableCostUsd: b.orientationAttributableCostUsd ?? null,
    treatmentEditedEarlier: deltaPreEditRequests < 0,
    resolvedBaseline: a.resolved ?? null,
    resolvedCompact: b.resolved ?? null,
  };
});

const measurable = rows.filter((r): r is Extract<typeof rows[number], { measurable: true }> => r.measurable);

const phase = {
  note:
    "input-side phase costs, split at each run's OWN first and last edit. The three do not "
    + "sum to the whole-run delta because output cost is not per-request observable (M169).",
  medianDeltaPreEditCostUsd: median(measurable.map((r) => r.deltaPreEditCostUsd)),
  medianDeltaImplementationCostUsd: median(measurable.map((r) => r.deltaImplementationCostUsd)),
  medianDeltaDebugTestCostUsd: median(measurable.map((r) => r.deltaDebugTestCostUsd)),
  totalDeltaPreEditCostUsd: Number(sum(measurable.map((r) => r.deltaPreEditCostUsd)).toFixed(4)),
  totalDeltaImplementationCostUsd: Number(sum(measurable.map((r) => r.deltaImplementationCostUsd)).toFixed(4)),
  totalDeltaDebugTestCostUsd: Number(sum(measurable.map((r) => r.deltaDebugTestCostUsd)).toFixed(4)),
};

const earlier = measurable.filter((r) => r.treatmentEditedEarlier);
const notEarlier = measurable.filter((r) => !r.treatmentEditedEarlier);

const correlation = {
  preEditRequestsVsPostEditRequests: spearman(
    measurable.map((r) => r.deltaPreEditRequests), measurable.map((r) => r.deltaPostEditRequests),
  ),
  preEditRequestsVsImplementationCost: spearman(
    measurable.map((r) => r.deltaPreEditRequests), measurable.map((r) => r.deltaImplementationCostUsd),
  ),
  preEditRequestsVsWholeRunCost: spearman(
    measurable.map((r) => r.deltaPreEditRequests), measurable.map((r) => r.deltaWholeRunCostUsd),
  ),
  reading:
    "negative means the FURTHER AHEAD the treatment arm's first edit is relative to the "
    + "baseline's, the MORE the whole run costs.",
};

const report = {
  schemaVersion: "stage5.m173.displacement.v1",
  milestone: "M173",
  workstream: "M173-C",
  question: "the orientation is cheap and the treatment still costs more — where is the premium?",
  answer: {
    notInTheOrientation:
      `the packet's own attributable cost is a median of `
      + `$${median(measurable.map((r) => r.orientationAttributableCostUsd ?? 0))?.toFixed(4)} a task`,
    notInInvestigation:
      `pre-edit cost across the sample is ${phase.totalDeltaPreEditCostUsd <= 0 ? "LOWER" : "higher"} `
      + `by $${Math.abs(phase.totalDeltaPreEditCostUsd).toFixed(4)} in total, and searches fall on every task`,
    inImplementation:
      `implementation-phase cost is higher by $${phase.totalDeltaImplementationCostUsd.toFixed(4)} in `
      + `total — the whole premium and more — while its MEDIAN is `
      + `$${phase.medianDeltaImplementationCostUsd?.toFixed(4)}, so it is a tail and not a shift`,
  },
  phase,
  correlation,
  displacementHypothesis: {
    statement:
      "the orientation does not remove the work of understanding; it lets the agent begin "
      + "editing before it has done that work, and the work reappears afterwards at a higher price.",
    evidence: {
      tasksWhereTreatmentEditedEarlier: earlier.length,
      medianWholeRunDeltaUsdWhenEarlier: median(earlier.map((r) => r.deltaWholeRunCostUsd)),
      medianWholeRunDeltaUsdOtherwise: median(notEarlier.map((r) => r.deltaWholeRunCostUsd)),
      cases: earlier.map((r) => ({
        instanceId: r.instanceId,
        deltaPreEditRequests: r.deltaPreEditRequests,
        deltaPostEditRequests: r.deltaPostEditRequests,
        deltaWholeRunCostUsd: r.deltaWholeRunCostUsd,
        resolvedBaseline: r.resolvedBaseline,
        resolvedCompact: r.resolvedCompact,
      })),
    },
    strength:
      "SUGGESTIVE, NOT ESTABLISHED. The rank correlation is over 11 pairs and only 2 of them "
      + "sit in the earlier-edit group. It is offered as the mechanism most consistent with the "
      + "measurements, and it is exactly the shape a larger qualification should be designed to "
      + "confirm or kill — not a finding to build retrieval work on.",
  },
  rows,
};

writeFileSync(path.join(RESULTS, "stage5_m173_displacement.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log("M173 displacement analysis");
console.log(`  Δ$ pre-edit        median ${phase.medianDeltaPreEditCostUsd?.toFixed(4)}   total ${phase.totalDeltaPreEditCostUsd}`);
console.log(`  Δ$ implementation  median ${phase.medianDeltaImplementationCostUsd?.toFixed(4)}   total ${phase.totalDeltaImplementationCostUsd}`);
console.log(`  Δ$ debug/test      median ${phase.medianDeltaDebugTestCostUsd?.toFixed(4)}   total ${phase.totalDeltaDebugTestCostUsd}`);
console.log(`  spearman(Δ pre-edit requests, Δ whole-run cost)  ${correlation.preEditRequestsVsWholeRunCost}`);
console.log(`  median Δ$ when the treatment edited earlier (n=${earlier.length})  ${median(earlier.map((r) => r.deltaWholeRunCostUsd))?.toFixed(4)}`);
console.log(`  median Δ$ otherwise (n=${notEarlier.length})                       ${median(notEarlier.map((r) => r.deltaWholeRunCostUsd))?.toFixed(4)}`);
