/**
 * M168-E collection + analysis — turn captured run artifacts into the outcome
 * table, the pairwise matrices and the paired deltas.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m168_collect.ts
 *
 * Reads only artifacts. Runs nothing, spends nothing. Safe to run mid-sweep —
 * every aggregate carries the number of pairs it was computed over, so a
 * partial sweep reports partial denominators rather than pretending.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  behaviour,
  coercionVerdict,
  outcomeMatrix,
  pairedDelta,
  totalTraffic,
  type RunRecord,
} from "./m168Analysis";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const RUNS = path.join(RESULTS, "runs");
const GUARD_EVENTS = path.join(RESULTS, "_m168_guard_events");

type Arm = RunRecord["arm"];
const ARMS: readonly Arm[] = ["baseline", "vtrace_strict", "vtrace_clean"];

function armOf(label: string): Arm | null {
  for (const arm of ARMS) if (label.startsWith(`m168_${arm}_`)) return arm;
  return null;
}

function loadRun(label: string): RunRecord | null {
  const arm = armOf(label);
  if (arm === null) return null;
  // raw/vtrace for the treatment arms, raw/baseline for --protocol baseline.
  const rawParent = path.join(RUNS, label, "raw");
  const raw = (existsSync(rawParent) ? readdirSync(rawParent) : [])
    .map((d) => path.join(rawParent, d))
    .find((d) => readdirSync(d).some((f) => f.startsWith("swebench-") && f.endsWith(".jsonl")));
  if (raw === undefined) return null;

  const rowFile = readdirSync(raw).find((f) => f.startsWith("swebench-") && f.endsWith(".jsonl"))!;

  const line = readFileSync(path.join(raw, rowFile), "utf-8").split("\n").find((l) => l.trim());
  if (line === undefined) return null;
  const row = JSON.parse(line) as Record<string, any>;

  const callsPath = path.join(raw, "_tool_calls.json");
  const toolCalls = existsSync(callsPath)
    ? (JSON.parse(readFileSync(callsPath, "utf-8")) as any[]).map((c) => ({
        tool: String(c.tool ?? "unknown"),
        category: String(c.category ?? "other"),
        path: c.path === null || c.path === undefined ? null : String(c.path),
      }))
    : [];

  const guardPath = path.join(GUARD_EVENTS, `${label}.jsonl`);
  const guardEvents = existsSync(guardPath)
    ? readFileSync(guardPath, "utf-8").split("\n").filter((l) => l.trim()).map((l) => {
        const e = JSON.parse(l) as { decision: string; indexPresent: boolean };
        return { decision: e.decision as "deny" | "allow", indexPresent: !!e.indexPresent };
      })
    : [];

  return {
    label,
    arm,
    instanceId: String(row.instanceId),
    costUsd: Number(row.costUsd ?? 0),
    inputTokens: Number(row.inputTokens ?? 0),
    outputTokens: Number(row.outputTokens ?? 0),
    cacheReadTokens: Number(row.cacheReadTokens ?? 0),
    cacheCreationTokens: Number(row.cacheCreationTokens ?? 0),
    numTurns: Number(row.numTurns ?? 0),
    resolved: row.resolved === null || row.resolved === undefined ? null : !!row.resolved,
    toolCalls,
    guardEvents,
    patchEmpty: String(row.modelPatch ?? "").trim() === "",
  };
}

const records: RunRecord[] = [];
for (const label of existsSync(RUNS) ? readdirSync(RUNS).sort() : []) {
  if (!label.startsWith("m168_")) continue;
  const rec = loadRun(label);
  if (rec !== null) records.push(rec);
}

const byArm = (arm: Arm) => records.filter((r) => r.arm === arm);
const mapOf = <T,>(arm: Arm, f: (r: RunRecord) => T): Map<string, T> =>
  new Map(byArm(arm).map((r) => [r.instanceId, f(r)] as const));

const metrics = {
  cost: (r: RunRecord) => r.costUsd,
  totalTraffic: (r: RunRecord) => totalTraffic(r),
  cacheCreation: (r: RunRecord) => r.cacheCreationTokens,
  cacheRead: (r: RunRecord) => r.cacheReadTokens,
  turns: (r: RunRecord) => r.numTurns,
  searchAttempts: (r: RunRecord) => behaviour(r).searchAttempts,
  reads: (r: RunRecord) => behaviour(r).reads,
  filesOpened: (r: RunRecord) => behaviour(r).filesOpened,
  pipelineCalls: (r: RunRecord) => behaviour(r).pipelineCalls,
  pipelineReuse: (r: RunRecord) => behaviour(r).pipelineReuse,
  bashCalls: (r: RunRecord) => behaviour(r).bashCalls,
  totalToolCalls: (r: RunRecord) => behaviour(r).totalToolCalls,
  callsBeforeFirstEdit: (r: RunRecord) => behaviour(r).callsBeforeFirstEdit,
} as const;

const PAIRS: readonly (readonly [Arm, Arm])[] = [
  ["vtrace_strict", "vtrace_clean"],
  ["vtrace_clean", "baseline"],
  ["vtrace_strict", "baseline"],
];

const pairwise = PAIRS.map(([left, right]) => ({
  comparison: `${left} vs ${right}`,
  outcomes: outcomeMatrix(left, right,
    mapOf(left, (r) => r.resolved), mapOf(right, (r) => r.resolved)),
  deltas: Object.entries(metrics).map(([name, f]) =>
    pairedDelta(name, mapOf(left, f), mapOf(right, f))),
}));

const strictBehaviours = byArm("vtrace_strict").map(behaviour);
const countStatus = (s: string) => strictBehaviours.filter((b) => b.guardStatus === s).length;
const guardedRuns = countStatus("GUARDED");
const guardUnexercisedRuns = countStatus("GUARD_UNEXERCISED");
const guardDegradedRuns = countStatus("GUARD_DEGRADED");
const guardFaultRuns = countStatus("GUARD_FAULT");

const primary = pairwise[0]!;
const verdict = coercionVerdict({
  searchDelta: primary.deltas.find((d) => d.metric === "searchAttempts")!,
  costDelta: primary.deltas.find((d) => d.metric === "cost")!,
  trafficDelta: primary.deltas.find((d) => d.metric === "totalTraffic")!,
  outcomes: primary.outcomes,
  guardedRuns,
  guardUnexercisedRuns,
  guardDegradedRuns,
  guardFaultRuns,
});

const report = {
  milestone: "M168-E",
  runsCollected: records.length,
  plannedRuns: 36,
  byArm: Object.fromEntries(ARMS.map((a) => [a, byArm(a).length])),
  completeTriples: [...new Set(records.map((r) => r.instanceId))]
    .filter((id) => ARMS.every((a) => records.some((r) => r.arm === a && r.instanceId === id)))
    .sort(),
  spendSoFarUsd: records.reduce((s, r) => s + r.costUsd, 0),
  gradedRuns: records.filter((r) => r.resolved !== null).length,
  guard: {
    strictRuns: strictBehaviours.length,
    guarded: guardedRuns,
    unexercised: guardUnexercisedRuns,
    degraded: guardDegradedRuns,
    fault: guardFaultRuns,
    totalDenials: strictBehaviours.reduce((s, b) => s + b.guardDenials, 0),
    note:
      "GUARD_UNEXERCISED = policy in force, agent never attempted a search (valid). "
      + "GUARD_DEGRADED = hook ran and allowed a search through (never pooled with guarded). "
      + "GUARD_FAULT = searches attempted but the hook never ran (apparatus failure).",
  },
  firstActionCompliance: Object.fromEntries(ARMS.map((a) => [a, {
    runs: byArm(a).length,
    pipelineFirst: byArm(a).filter((r) => behaviour(r).firstActionWasPipeline === true).length,
    noToolCalls: byArm(a).filter((r) => behaviour(r).firstActionWasPipeline === null).length,
  }])),
  perRun: records.map((r) => ({
    instanceId: r.instanceId, arm: r.arm, resolved: r.resolved, costUsd: r.costUsd,
    totalTraffic: totalTraffic(r), numTurns: r.numTurns, patchEmpty: r.patchEmpty,
    ...behaviour(r),
  })),
  pairwise,
  primaryVerdict: verdict,
};

writeFileSync(path.join(RESULTS, "stage5_m168_runs.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`collected ${records.length}/36 runs · complete triples ${report.completeTriples.length}/12 · spend $${report.spendSoFarUsd.toFixed(4)}`);
console.log(`guard: ${guardedRuns} guarded, ${guardUnexercisedRuns} unexercised, ${guardDegradedRuns} degraded, ${guardFaultRuns} fault (of ${strictBehaviours.length} strict runs)`);
console.log(`primary verdict: ${verdict.verdict}`);
