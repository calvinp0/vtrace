/**
 * M173-B — the cap-pressure report.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m173_cap_pressure.ts
 *
 * Written by the driver when the task-entry spend guard stops the sweep, and
 * runnable at any time to see where the budget stands.
 *
 * The question it has to answer honestly is the one that decides whether a
 * partial sweep is usable: IS THE PRESSURE ARM-SKEWED? A cap that bites because
 * the treatment arm is expensive, in an experiment about whether the treatment
 * is expensive, would silently select the cheap half of the treatment
 * distribution and report it as the treatment. So the per-arm spend is
 * decomposed rather than totalled, and the runs that remain are listed by name.
 *
 * Offline. Reads captured artifacts and the authorisation only.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const RUNS = path.join(RESULTS, "runs");

type Arm = "baseline" | "vtrace_compact";
const ARMS: readonly Arm[] = ["baseline", "vtrace_compact"];

const labelFor = (arm: Arm, instanceId: string): string =>
  `m173_${arm}_${instanceId.replace(/-/g, "_")}`;

function resultRow(label: string): { costUsd: number | null } | null {
  const parent = path.join(RUNS, label, "raw");
  if (!existsSync(parent)) return null;
  for (const child of readdirSync(parent)) {
    const dir = path.join(parent, child);
    const file = readdirSync(dir).find((f) => f.startsWith("swebench-") && f.endsWith(".jsonl"));
    if (file === undefined) continue;
    const line = readFileSync(path.join(dir, file), "utf-8").split("\n").find((l) => l.trim());
    if (line === undefined) return { costUsd: null };
    const row = JSON.parse(line) as Record<string, unknown>;
    return { costUsd: typeof row.costUsd === "number" ? row.costUsd : null };
  }
  return null;
}

const schedule = JSON.parse(
  readFileSync(path.join(RESULTS, "stage5_m173_schedule.json"), "utf-8"),
) as { schedule: { order: number; instanceId: string; armOrder: Arm[] }[] };

const authorizationPath = path.join(RESULTS, "stage5_m173_cost_authorization.json");
const capUsd = existsSync(authorizationPath)
  ? (JSON.parse(readFileSync(authorizationPath, "utf-8")) as { hardCapUsd?: number }).hardCapUsd ?? null
  : null;

const tasks = schedule.schedule.sort((a, b) => a.order - b.order).map((row) => {
  const arms = Object.fromEntries(ARMS.map((arm) => [arm, resultRow(labelFor(arm, row.instanceId))])) as
    Record<Arm, { costUsd: number | null } | null>;
  const completedArms = ARMS.filter((arm) => arms[arm] !== null);
  return {
    order: row.order,
    instanceId: row.instanceId,
    completedArms,
    remainingArms: ARMS.filter((arm) => arms[arm] === null),
    pairComplete: completedArms.length === ARMS.length,
    pairHalfRun: completedArms.length === 1,
    costUsd: Object.fromEntries(ARMS.map((arm) => [arm, arms[arm]?.costUsd ?? null])),
  };
});

const spentByArm = Object.fromEntries(ARMS.map((arm) => [
  arm,
  tasks.reduce((total, t) => total + (t.costUsd[arm] ?? 0), 0),
])) as Record<Arm, number>;

const runsByArm = Object.fromEntries(ARMS.map((arm) => [
  arm,
  tasks.filter((t) => t.costUsd[arm] !== null).length,
])) as Record<Arm, number>;

const totalSpent = ARMS.reduce((total, arm) => total + spentByArm[arm], 0);
const totalRuns = ARMS.reduce((total, arm) => total + runsByArm[arm], 0);
const remainingRuns = tasks.reduce((total, t) => total + t.remainingArms.length, 0);
const runningAverage = totalRuns === 0 ? null : totalSpent / totalRuns;
const projectedToFinish = runningAverage === null ? null : remainingRuns * runningAverage;
const projectedTotal = projectedToFinish === null ? null : totalSpent + projectedToFinish;

/**
 * Arm skew, measured two ways because either alone can mislead: the per-arm
 * mean says which arm is expensive, the per-arm completion count says whether
 * the stop point has already selected one.
 */
const meanByArm = Object.fromEntries(ARMS.map((arm) => [
  arm,
  runsByArm[arm] === 0 ? null : spentByArm[arm] / runsByArm[arm],
])) as Record<Arm, number | null>;

const armSkew = (() => {
  const a = meanByArm.baseline;
  const b = meanByArm.vtrace_compact;
  const countsBalanced = runsByArm.baseline === runsByArm.vtrace_compact;
  if (a === null || b === null) {
    return {
      verdict: "UNOBSERVABLE" as const,
      note: "one arm has no completed run yet",
      completionBalanced: countsBalanced,
    };
  }
  const ratio = a === 0 ? null : b / a;
  return {
    verdict: ratio === null
      ? ("UNOBSERVABLE" as const)
      : ratio >= 1.25
        ? ("TREATMENT_SKEWED" as const)
        : ratio <= 0.8
          ? ("BASELINE_SKEWED" as const)
          : ("NOT_SKEWED" as const),
    treatmentOverBaselineMeanRatio: ratio === null ? null : Number(ratio.toFixed(3)),
    completionBalanced: countsBalanced,
    note:
      "if the pressure is TREATMENT_SKEWED, a truncated sweep would report the cheap half of "
      + "the treatment distribution as the treatment. The remedy is a larger cap or a smaller "
      + "sample, never dropping the expensive treatment runs (§13).",
  };
})();

const halfRun = tasks.filter((t) => t.pairHalfRun);

const report = {
  schemaVersion: "stage5.m173.cap-pressure.v1",
  milestone: "M173",
  workstream: "M173-B",
  hardCapUsd: capUsd,
  completed: {
    tasksWithCompletePair: tasks.filter((t) => t.pairComplete).length,
    tasksTotal: tasks.length,
    armRunsCompleted: totalRuns,
    armRunsPlanned: tasks.length * ARMS.length,
  },
  spend: {
    totalRecordedUsd: Number(totalSpent.toFixed(4)),
    byArmUsd: Object.fromEntries(ARMS.map((a) => [a, Number(spentByArm[a].toFixed(4))])),
    runsByArm: runsByArm,
    runningAverageUsd: runningAverage === null ? null : Number(runningAverage.toFixed(4)),
    headroomUsd: capUsd === null ? null : Number((capUsd - totalSpent).toFixed(4)),
  },
  remaining: {
    armRuns: remainingRuns,
    projectedCostToFinishUsd: projectedToFinish === null ? null : Number(projectedToFinish.toFixed(4)),
    projectedTotalUsd: projectedTotal === null ? null : Number(projectedTotal.toFixed(4)),
    fitsWithinCap: capUsd === null || projectedTotal === null ? null : projectedTotal <= capUsd,
    runs: tasks.flatMap((t) => t.remainingArms.map((arm) => ({ instanceId: t.instanceId, arm, order: t.order }))),
  },
  armSkew,
  balance: {
    halfRunPairs: halfRun.map((t) => ({ instanceId: t.instanceId, completedArms: t.completedArms })),
    balanced: halfRun.length === 0,
    policy:
      "the spend guard gates at TASK entry, so a pair that has begun always finishes. A "
      + "half-run pair here means an infrastructure failure or an operator interrupt, not the "
      + "cap.",
  },
  perTask: tasks,
};

writeFileSync(path.join(RESULTS, "stage5_m173_cap_pressure.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log("\n── M173 cap pressure ──────────────────────────────────────");
console.log(`  cap                    $${capUsd ?? "NONE"}`);
console.log(`  complete pairs         ${report.completed.tasksWithCompletePair}/${report.completed.tasksTotal}`);
console.log(`  arm runs completed     ${totalRuns}/${report.completed.armRunsPlanned}`);
console.log(`  recorded spend         $${report.spend.totalRecordedUsd}  (A $${report.spend.byArmUsd.baseline} / B $${report.spend.byArmUsd.vtrace_compact})`);
console.log(`  headroom               $${report.spend.headroomUsd ?? "-"}`);
console.log(`  projected to finish    $${report.remaining.projectedCostToFinishUsd ?? "-"} over ${remainingRuns} runs`);
console.log(`  projected total        $${report.remaining.projectedTotalUsd ?? "-"}  fits: ${report.remaining.fitsWithinCap}`);
console.log(`  arm skew               ${armSkew.verdict}  (B/A mean ratio ${("treatmentOverBaselineMeanRatio" in armSkew ? armSkew.treatmentOverBaselineMeanRatio : null) ?? "-"})`);
console.log(`  balanced               ${report.balance.balanced}`);
if (report.remaining.runs.length > 0) {
  console.log("  remaining runs:");
  for (const r of report.remaining.runs) console.log(`    [${r.order}] ${r.instanceId} ${r.arm}`);
}
