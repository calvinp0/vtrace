/**
 * M174-E — reconcile the whole-run premium against where the work actually went.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m174_economics.ts
 *
 * M173 reported a +$0.0563 paired median and an implementation premium of
 * +$1.4622 concentrated in two cases. It could not say whether that premium was
 * the pre-edit saving coming back in another phase (displacement), or work the
 * treatment simply did instead (divergence), or noise.
 *
 * M174-C answered the first: on eight of twelve pairs, ZERO strong information
 * units crossed the edit boundary. There is nothing to come back. So this
 * partitions the premium by PHASE and reports how much of it survives removing
 * the tail — which is the difference between a product defect and a long tail.
 *
 * ROBUST BY DEFAULT (§53). A mean over twelve pairs one of which moves $1.57 is
 * a statement about that pair. Median, trimmed mean and MAD are reported beside
 * it, and the tail's share is reported explicitly rather than being smoothed.
 *
 * Offline. No agent, no Docker, no paid API.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

interface PairRow {
  instanceId: string; censored: boolean;
  costA: number | null; costB: number | null; costDeltaUsd: number | null;
  costRatio: number | null; economicClass: string;
  resolvedA: boolean | null; resolvedB: boolean | null;
  phaseCostsA: Record<string, { requests: number; totalCostUsd: number }>;
  phaseCostsB: Record<string, { requests: number; totalCostUsd: number }>;
  information: Record<string, number | string[]>;
  firstEditDelta: number | null;
  revisionA: Record<string, number>; revisionB: Record<string, number>;
  testA: Record<string, number>; testB: Record<string, number>;
  orientation: Record<string, unknown>;
}

const pairwise = JSON.parse(
  readFileSync(path.join(RESULTS, "stage5_m174_pairwise_information.json"), "utf8"),
) as { pairs: PairRow[] };

const PHASES = ["PHASE_0_ORIENTATION", "PHASE_1_PRE_EDIT", "PHASE_2_IMPLEMENTATION", "PHASE_3_VERIFICATION"] as const;

// ── statistics ──────────────────────────────────────────────────────

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
/** Drop the extreme value at each end. With n=11 this removes both tails. */
const trimmedMean = (xs: readonly number[]): number | null => {
  if (xs.length < 3) return mean(xs);
  const s = [...xs].sort((a, b) => a - b).slice(1, -1);
  return mean(s);
};
const mad = (xs: readonly number[]): number | null => {
  const m = median(xs);
  return m === null ? null : median(xs.map((x) => Math.abs(x - m)));
};
const round = (x: number | null, digits = 4): number | null =>
  x === null ? null : Number(x.toFixed(digits));

// ── per-pair phase deltas ───────────────────────────────────────────

const rows = pairwise.pairs.map((pair) => {
  const delta = (phase: string): number =>
    (pair.phaseCostsB[phase]?.totalCostUsd ?? 0) - (pair.phaseCostsA[phase]?.totalCostUsd ?? 0);
  const sumPhases = (side: "phaseCostsA" | "phaseCostsB"): number =>
    PHASES.reduce((total, phase) => total + (pair[side][phase]?.totalCostUsd ?? 0), 0);

  const phaseDeltaTotal = PHASES.reduce((total, phase) => total + delta(phase), 0);
  // The phase model prices the input side exactly and apportions output by
  // authored characters; the harness row is the provider's own total. Reporting
  // the gap is §51's reconciliation error, not something to tune away.
  const reconciliationError = pair.costDeltaUsd === null ? null : phaseDeltaTotal - pair.costDeltaUsd;

  return {
    instanceId: pair.instanceId,
    censored: pair.censored,
    economicClass: pair.economicClass,
    resolvedA: pair.resolvedA, resolvedB: pair.resolvedB,
    sameOutcome: pair.resolvedA === pair.resolvedB,
    costA: pair.costA, costB: pair.costB,
    costDeltaUsd: pair.costDeltaUsd, costRatio: pair.costRatio,
    orientationCostUsd: round(pair.phaseCostsB.PHASE_0_ORIENTATION?.totalCostUsd ?? 0),
    deltaPreEdit: round(delta("PHASE_1_PRE_EDIT")),
    deltaImplementation: round(delta("PHASE_2_IMPLEMENTATION")),
    deltaVerification: round(delta("PHASE_3_VERIFICATION")),
    deltaPostEdit: round(delta("PHASE_2_IMPLEMENTATION") + delta("PHASE_3_VERIFICATION")),
    phaseSumA: round(sumPhases("phaseCostsA")), phaseSumB: round(sumPhases("phaseCostsB")),
    phaseDeltaTotal: round(phaseDeltaTotal),
    reconciliationError: round(reconciliationError),
    displacedStrong: pair.information.displacedStrong as number,
    eliminatedStrong: pair.information.eliminatedStrong as number,
    treatmentOnlyAgentAcquired: pair.information.treatmentOnlyAgentAcquired as number,
    firstEditDelta: pair.firstEditDelta,
    reworkA: pair.revisionA.reworkEdits, reworkB: pair.revisionB.reworkEdits,
    testsA: pair.testA.total, testsB: pair.testB.total,
  };
});

const uncensored = rows.filter((r) => !r.censored && r.costDeltaUsd !== null);
const deltas = uncensored.map((r) => r.costDeltaUsd!);

// ── tail concentration (§52) ────────────────────────────────────────

const positive = uncensored.filter((r) => r.costDeltaUsd! > 0).sort((a, b) => b.costDeltaUsd! - a.costDeltaUsd!);
const totalPositive = positive.reduce((sum, r) => sum + r.costDeltaUsd!, 0);
const share = (n: number): number | null =>
  totalPositive === 0 ? null : Number((positive.slice(0, n).reduce((s, r) => s + r.costDeltaUsd!, 0) / totalPositive).toFixed(4));

/** The tail, defined mechanically before any narrative (§39). */
const TAIL_RULE = "the top 2 positive whole-run paired cost deltas among uncensored pairs";
const tail = positive.slice(0, 2).map((r) => r.instanceId);

// ── premium partition ───────────────────────────────────────────────

const sum = (pick: (r: typeof rows[number]) => number | null): number =>
  Number(uncensored.reduce((total, r) => total + (pick(r) ?? 0), 0).toFixed(4));

const withoutTail = uncensored.filter((r) => !tail.includes(r.instanceId));
const deltasWithoutTail = withoutTail.map((r) => r.costDeltaUsd!);

const report = {
  schemaVersion: "stage5.m174.economics.v1",
  milestone: "M174", workstream: "M174-E",
  population: {
    pairs: rows.length,
    uncensored: uncensored.length,
    censoredExcluded: rows.filter((r) => r.censored).map((r) => r.instanceId),
    note: "pylint-4551 is COST_CENSORED in M173's ledger (NO_RESULT_EVENT on the baseline arm) and is excluded from every economic figure, exactly as M173 excluded it",
  },
  robustPairedEconomics: {
    n: deltas.length,
    medianUsd: round(median(deltas)),
    meanUsd: round(mean(deltas)),
    trimmedMeanUsd: round(trimmedMean(deltas)),
    madUsd: round(mad(deltas)),
    wins: uncensored.filter((r) => r.economicClass === "ECONOMIC_WIN").length,
    neutral: uncensored.filter((r) => r.economicClass === "ROUGH_NEUTRAL").length,
    losses: uncensored.filter((r) => r.economicClass === "ECONOMIC_LOSS").length,
  },
  withoutTail: {
    rule: TAIL_RULE,
    excluded: tail,
    n: deltasWithoutTail.length,
    medianUsd: round(median(deltasWithoutTail)),
    meanUsd: round(mean(deltasWithoutTail)),
    totalUsd: round(deltasWithoutTail.reduce((a, b) => a + b, 0)),
  },
  tailConcentration: {
    rule: TAIL_RULE,
    tail,
    totalPositivePremiumUsd: round(totalPositive),
    shareTop1: share(1), shareTop2: share(2), shareTop3: share(3),
    ranked: positive.map((r) => ({ instanceId: r.instanceId, deltaUsd: r.costDeltaUsd })),
  },
  premiumPartition: {
    note: "aggregate over uncensored pairs; the orientation column is what the packet itself cost, the rest is where the run differed",
    orientationCostUsd: sum((r) => r.orientationCostUsd),
    deltaPreEditUsd: sum((r) => r.deltaPreEdit),
    deltaImplementationUsd: sum((r) => r.deltaImplementation),
    deltaVerificationUsd: sum((r) => r.deltaVerification),
    deltaPostEditUsd: sum((r) => r.deltaPostEdit),
    wholeRunDeltaUsd: sum((r) => r.costDeltaUsd),
    reconciliationErrorUsd: sum((r) => r.reconciliationError),
    reconciliationNote: "phase totals price the input side exactly and apportion whole-run output by authored characters; the residual against the provider row is reported, not absorbed",
  },
  displacementSummary: {
    pairsWithZeroDisplacement: rows.filter((r) => r.displacedStrong === 0).length,
    pairsWithZeroTreatmentOnlyWork: rows.filter((r) => r.treatmentOnlyAgentAcquired === 0).length,
    totalDisplacedStrongUnits: rows.reduce((s, r) => s + r.displacedStrong, 0),
    totalEliminatedStrongUnits: rows.reduce((s, r) => s + r.eliminatedStrong, 0),
    note: "displacement is measured across each arm's OWN first meaningful edit (§25)",
  },
  preEditSaving: {
    pairsWhereTreatmentPreEditCheaper: uncensored.filter((r) => (r.deltaPreEdit ?? 0) < 0).length,
    totalDeltaPreEditUsd: sum((r) => r.deltaPreEdit),
    note: "negative means the treatment's pre-edit phase cost LESS than the baseline's",
  },
  rows,
};

const target = path.join(RESULTS, "stage5_m174_economic_reconciliation.json");
writeFileSync(target, `${JSON.stringify(report, null, 1)}\n`);
process.stdout.write(`wrote ${path.relative(ROOT, target)}\n\n`);

process.stdout.write("instance                        Δtotal   Δpre-edit  Δimpl    Δverify   class\n");
for (const r of rows) {
  process.stdout.write(
    `${r.instanceId.padEnd(30)} ${String(r.costDeltaUsd?.toFixed(4) ?? "n/a").padStart(8)} `
    + `${String(r.deltaPreEdit?.toFixed(4) ?? "n/a").padStart(10)} ${String(r.deltaImplementation?.toFixed(4) ?? "n/a").padStart(8)} `
    + `${String(r.deltaVerification?.toFixed(4) ?? "n/a").padStart(9)}   ${r.economicClass}\n`,
  );
}
process.stdout.write(`\nrobust: ${JSON.stringify(report.robustPairedEconomics)}\n`);
process.stdout.write(`tail:   ${JSON.stringify(report.tailConcentration.tail)} share1=${report.tailConcentration.shareTop1} share2=${report.tailConcentration.shareTop2} share3=${report.tailConcentration.shareTop3}\n`);
process.stdout.write(`no tail:${JSON.stringify(report.withoutTail)}\n`);
process.stdout.write(`pre-edit saving: ${JSON.stringify(report.preEditSaving)}\n`);
