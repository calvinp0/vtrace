/**
 * M173-D — what the agent did with the orientation, and whether a wrong pivot
 * cost anything.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m173_orientation_use.ts
 *
 * §68's separation is enforced by construction: the COMPACT transcript is the
 * only source for what the agent saw and did, and gold — never the model's own
 * context — is the only source for whether the focus was right. Nothing read
 * here was ever exposed to a model.
 *
 * The classifiers live in `m173Consumption.ts` and were written before any live
 * run existed. This file only feeds them.
 *
 * Offline. Reads captured artifacts only.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ActionKind, INVESTIGATION_KINDS, classifyAction, parseRun } from "./m169Economics";
import {
  OrientationUse,
  PivotConsequence,
  classifyOrientationUse,
  classifyPivotConsequence,
  classifyRediscovery,
  samePath,
} from "./m173Consumption";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const RUNS = path.join(RESULTS, "runs");

const ledger = JSON.parse(
  readFileSync(path.join(RESULTS, "stage5_m173_paired_ledger.json"), "utf-8"),
) as { perRun: Record<string, any>[]; pairs: Record<string, any>[] };

const byKey = new Map<string, Record<string, any>>();
for (const run of ledger.perRun) byKey.set(`${run.instanceId}|${run.arm}`, run);

/** Ordered actions with their file targets, recomputed from the stream. */
function actionsOf(label: string): { requestIndex: number; kind: string; target: string | null }[] {
  const parent = path.join(RUNS, label, "raw");
  if (!existsSync(parent)) return [];
  for (const child of readdirSync(parent)) {
    const stream = path.join(parent, child, "_agent_stream.first_pass.jsonl");
    if (!existsSync(stream)) continue;
    const parsed = parseRun(readFileSync(stream, "utf-8").split("\n"));
    const actions: { requestIndex: number; kind: string; target: string | null }[] = [];
    for (const request of parsed.requests) {
      for (const use of request.toolUses) {
        actions.push({
          requestIndex: request.index,
          kind: classifyAction(use.name, use.command),
          target: use.filePath,
        });
      }
    }
    return actions;
  }
  return [];
}

/** Files the run's final patch actually changed — the authoritative edit set. */
function patchedFiles(label: string): readonly string[] {
  const parent = path.join(RUNS, label, "raw");
  if (!existsSync(parent)) return [];
  for (const child of readdirSync(parent)) {
    const dir = path.join(parent, child);
    const rowFile = readdirSync(dir).find((f) => f.startsWith("swebench-") && f.endsWith(".jsonl"));
    if (rowFile === undefined) continue;
    const line = readFileSync(path.join(dir, rowFile), "utf-8").split("\n").find((l) => l.trim());
    if (line === undefined) return [];
    const row = JSON.parse(line) as { modelPatch?: unknown };
    const patch = String(row.modelPatch ?? "");
    return Object.freeze([...new Set(
      [...patch.matchAll(/^diff --git a\/(\S+) b\/\S+/gm)].map((m) => m[1]!),
    )]);
  }
  return [];
}

const rows = ledger.pairs.map((pair) => {
  const instanceId = pair.instanceId as string;
  const a = byKey.get(`${instanceId}|baseline`);
  const b = byKey.get(`${instanceId}|vtrace_compact`);
  if (b === undefined) {
    return { instanceId, use: OrientationUse.Unobservable, reason: "no treatment run", pivot: PivotConsequence.Unobservable };
  }

  const packet = {
    focusFile: (b.orientationFocusFile ?? null) as string | null,
    focusAt: (b.orientationFocusAt ?? null) as string | null,
    relatedFiles: ((b.orientationRelatedFiles ?? []) as string[]),
  };

  const actions = actionsOf(b.label as string);
  const orientationRequestIndex = (b.pipelineCallDetail as { requestIndex: number }[] | undefined)?.[0]
    ?.requestIndex ?? -1;

  // The final patch is the authoritative edit set; the transcript's Edit calls
  // include edits that were later reverted or replaced.
  const editedFiles = patchedFiles(b.label as string);
  const baselineEditedFiles = a === undefined ? [] : patchedFiles(a.label as string);
  const inspectedFiles = actions
    .filter((x) => x.kind === ActionKind.Read && x.target !== null)
    .map((x) => x.target!);

  const goldFiles = ((b.goldFiles ?? []) as string[]);

  const use = classifyOrientationUse({
    packet,
    editedFiles,
    inspectedFiles,
    goldFiles,
    resolved: (b.resolved ?? null) as boolean | null,
  });

  const rediscovery = classifyRediscovery(
    packet, actions, orientationRequestIndex, INVESTIGATION_KINDS as readonly string[],
  );

  // §32 — did the treatment arm re-derive what it was handed? Counted against
  // the baseline so "the agent verified" can be told from "the agent had to".
  const preEditInvestigationDelta = a === undefined
    ? null
    : (b.investigationCallsPreEdit as number) - (a.investigationCallsPreEdit as number);

  const pivot = classifyPivotConsequence({
    focusIsGold: use.focusIsGold,
    use: use.use,
    resolved: (b.resolved ?? null) as boolean | null,
    preEditInvestigationDelta,
    editedFocus: use.editedFocus,
    editedAnyGold: editedFiles.some((f) => goldFiles.some((g) => samePath(g, f))),
  });

  return {
    instanceId,
    orientationDisclosure: b.orientationDisclosure ?? null,
    focusFile: packet.focusFile,
    focusAt: packet.focusAt,
    relatedFiles: packet.relatedFiles,
    goldFiles,
    focusIsGold: use.focusIsGold,

    use: use.use,
    useReason: use.reason,
    editedFocus: use.editedFocus,
    editedRelated: use.editedRelated,
    inspectedFocus: use.inspectedFocus,
    editedFiles,
    baselineEditedFiles,
    // §34 — an edit to a file the orientation named is not evidence of use if
    // the baseline edited it too. Recorded so the claim can be discounted.
    baselineEditedTheSameFocus: packet.focusFile !== null
      && baselineEditedFiles.some((f) => samePath(f, packet.focusFile)),

    rediscovery: {
      targetedConfirmation: rediscovery.targetedConfirmation,
      redundantRediscovery: rediscovery.redundantRediscovery,
      newInformationSearch: rediscovery.newInformationSearch,
      classified: rediscovery.classified,
    },
    preEditInvestigationCallsBaseline: a?.investigationCallsPreEdit ?? null,
    preEditInvestigationCallsCompact: b.investigationCallsPreEdit ?? null,
    preEditInvestigationDelta,

    pivotConsequence: pivot,
    resolved: b.resolved ?? null,
    baselineResolved: a?.resolved ?? null,
  };
});

const tally = <T extends string>(key: (r: any) => T): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = key(row);
    if (value === undefined) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
};

const causalPivotLosses = rows.filter(
  (r: any) => r.pivotConsequence === PivotConsequence.CausedWrongEdit
    || r.pivotConsequence === PivotConsequence.CausedExtraInvestigation,
);

const report = {
  schemaVersion: "stage5.m173.orientation-use.v1",
  milestone: "M173",
  workstream: "M173-D",
  sourceSeparation:
    "§68 — the compact transcript is the only source for what the agent saw and did; gold is "
    + "the only source for whether the focus was right. No analysis-only data was exposed to a model.",
  classifiersFrozenBefore: "any M173 live run existed (m173Consumption.ts)",
  useCounts: tally((r) => r.use),
  pivotCounts: tally((r) => r.pivotConsequence),
  rediscoveryTotals: {
    targetedConfirmation: rows.reduce((t: number, r: any) => t + (r.rediscovery?.targetedConfirmation ?? 0), 0),
    redundantRediscovery: rows.reduce((t: number, r: any) => t + (r.rediscovery?.redundantRediscovery ?? 0), 0),
    newInformationSearch: rows.reduce((t: number, r: any) => t + (r.rediscovery?.newInformationSearch ?? 0), 0),
  },
  focusIsGold: {
    correct: rows.filter((r: any) => r.focusIsGold === true).length,
    wrong: rows.filter((r: any) => r.focusIsGold === false).length,
    unobservable: rows.filter((r: any) => r.focusIsGold === null || r.focusIsGold === undefined).length,
  },
  pivotWorkVerdict: causalPivotLosses.length > 0
    ? "PIVOT_CORRECTNESS_WORK_LICENSED"
    : "PIVOT_CORRECTNESS_NOT_LICENSED",
  pivotWorkRule:
    "§36/§77 — licensed only where a wrong pivot has an OBSERVED downstream consequence. A "
    + "wrong pivot that was ignored, recovered from, or left no trace does not license "
    + "retrieval work, however many of them there are.",
  causalPivotLosses: causalPivotLosses.map((r: any) => ({
    instanceId: r.instanceId, focusFile: r.focusFile, goldFiles: r.goldFiles,
    consequence: r.pivotConsequence, resolved: r.resolved,
  })),
  rows,
};

writeFileSync(path.join(RESULTS, "stage5_m173_orientation_use.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(`M173 orientation use over ${rows.length} tasks`);
console.log(`  use          ${JSON.stringify(report.useCounts)}`);
console.log(`  pivot        ${JSON.stringify(report.pivotCounts)}`);
console.log(`  focus gold   ${report.focusIsGold.correct} correct / ${report.focusIsGold.wrong} wrong / ${report.focusIsGold.unobservable} unobservable`);
console.log(`  rediscovery  ${JSON.stringify(report.rediscoveryTotals)}`);
console.log(`  pivot work   ${report.pivotWorkVerdict}`);
