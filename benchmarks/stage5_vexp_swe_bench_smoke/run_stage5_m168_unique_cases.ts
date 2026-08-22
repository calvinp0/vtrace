/**
 * M168-E unique-win / unique-loss inspection.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m168_unique_cases.ts
 *
 * The grader says WHICH task an arm won. It never says why, and a pairwise
 * matrix invites the reader to supply a mechanism the data has not shown. This
 * emits, for every task where two arms disagree, the evidence needed to judge
 * whether the treatment plausibly caused the difference — and marks the
 * judgement UNASSESSED rather than guessing it.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");

interface PerRun {
  instanceId: string;
  arm: string;
  resolved: boolean | null;
  costUsd: number;
  numTurns: number;
  searchAttempts: number;
  reads: number;
  bashCalls: number;
  edits: number;
  totalToolCalls: number;
  callsBeforeFirstEdit: number;
  pipelineCalls: number;
  firstActionWasPipeline: boolean | null;
  guardStatus: string;
  guardDenials: number;
  patchEmpty: boolean;
}

const runs = JSON.parse(
  readFileSync(path.join(RESULTS, "stage5_m168_runs.json"), "utf-8"),
) as { perRun: PerRun[] };

const byTask = new Map<string, Map<string, PerRun>>();
for (const r of runs.perRun) {
  if (!byTask.has(r.instanceId)) byTask.set(r.instanceId, new Map());
  byTask.get(r.instanceId)!.set(r.arm, r);
}

/** The first pipeline result the arm actually received, if any. */
function firstPipelinePayload(instanceId: string, arm: string): {
  found: boolean;
  chars: number;
  leadPreview: string;
} {
  const label = `m168_${arm}_${instanceId.replace(/-/g, "_")}`;
  const rawParent = path.join(RESULTS, "runs", label, "raw");
  if (!existsSync(rawParent)) return { found: false, chars: 0, leadPreview: "" };
  const raw = readdirSync(rawParent).map((d) => path.join(rawParent, d))
    .find((d) => existsSync(d));
  if (raw === undefined) return { found: false, chars: 0, leadPreview: "" };

  const withOutputs = path.join(raw, "_tool_calls_with_outputs.json");
  if (!existsSync(withOutputs)) return { found: false, chars: 0, leadPreview: "" };

  const calls = JSON.parse(readFileSync(withOutputs, "utf-8")) as any[];
  const call = calls.find((c) => String(c.tool ?? "").endsWith("__run_pipeline"));
  if (call === undefined) return { found: false, chars: 0, leadPreview: "" };

  const output = typeof call.output === "string"
    ? call.output
    : JSON.stringify(call.output ?? call.output_summary ?? "");
  return { found: true, chars: output.length, leadPreview: output.slice(0, 400) };
}

const PAIRS: readonly (readonly [string, string])[] = [
  ["vtrace_strict", "vtrace_clean"],
  ["vtrace_clean", "baseline"],
  ["vtrace_strict", "baseline"],
];

const cases: unknown[] = [];

for (const [left, right] of PAIRS) {
  for (const [instanceId, arms] of byTask) {
    const l = arms.get(left);
    const r = arms.get(right);
    if (l === undefined || r === undefined) continue;
    if (l.resolved === null || r.resolved === null) continue;
    if (l.resolved === r.resolved) continue;

    const winner = l.resolved ? left : right;
    const loser = l.resolved ? right : left;
    const w = l.resolved ? l : r;
    const lo = l.resolved ? r : l;

    cases.push({
      comparison: `${left} vs ${right}`,
      instanceId,
      winner,
      loser,
      kind: `${winner}_unique_win`,
      winnerEvidence: {
        pipelineCalls: w.pipelineCalls,
        firstActionWasPipeline: w.firstActionWasPipeline,
        firstPipelinePayload: firstPipelinePayload(instanceId, winner),
        searchAttempts: w.searchAttempts,
        guardStatus: w.guardStatus,
        guardDenials: w.guardDenials,
        reads: w.reads,
        bashCalls: w.bashCalls,
        edits: w.edits,
        callsBeforeFirstEdit: w.callsBeforeFirstEdit,
        costUsd: w.costUsd,
        numTurns: w.numTurns,
      },
      loserEvidence: {
        pipelineCalls: lo.pipelineCalls,
        firstActionWasPipeline: lo.firstActionWasPipeline,
        firstPipelinePayload: firstPipelinePayload(instanceId, loser),
        searchAttempts: lo.searchAttempts,
        guardStatus: lo.guardStatus,
        guardDenials: lo.guardDenials,
        reads: lo.reads,
        bashCalls: lo.bashCalls,
        edits: lo.edits,
        callsBeforeFirstEdit: lo.callsBeforeFirstEdit,
        costUsd: lo.costUsd,
        numTurns: lo.numTurns,
        patchEmpty: lo.patchEmpty,
      },
      /**
       * Deliberately not inferred. A grader disagreement plus a treatment
       * difference is not causation, and M168's own rule is that attribution
       * needs the evidence to have been supplied, used, and plausibly decisive.
       */
      causalAssessment: "UNASSESSED — requires transcript inspection",
      blockedSearchImplicated: w.guardDenials > 0 || lo.guardDenials > 0,
    });
  }
}

const report = {
  milestone: "M168-E",
  purpose: "evidence for every grader disagreement, so attribution is inspected rather than inferred",
  gradedRuns: runs.perRun.filter((r) => r.resolved !== null).length,
  totalRuns: runs.perRun.length,
  disagreements: cases.length,
  note: cases.length === 0
    ? "no arm pair disagreed on any graded task"
    : "each case carries both arms' investigation evidence; causal assessment is not auto-filled",
  cases,
};

writeFileSync(
  path.join(RESULTS, "stage5_m168_unique_cases.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(`unique cases: ${cases.length} disagreement(s) over ${report.gradedRuns}/${report.totalRuns} graded runs`);
