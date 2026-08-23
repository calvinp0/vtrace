/**
 * M174-B — reconstruct the 12 M173 pairs as ordered, targeted action traces.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m174_traces.ts
 *
 * M173's ledger counts what each agent did. This reconstructs what each agent
 * TOUCHED, from the same authoritative transcripts, so a pair can be compared on
 * information acquired rather than tool calls issued.
 *
 * SOURCE. `raw/{vtrace,baseline}/_agent_stream.first_pass.jsonl` — the complete
 * stream. NOT `_tool_calls_with_outputs.json`, which truncates tool output at
 * 8,192 characters (M170 §69); this corpus has 19 results longer than that, the
 * largest 26,736 characters, and a displacement measure built on truncated
 * evidence would under-credit exactly the large reads that matter most.
 *
 * ACCOUNTING. `m169Economics`, imported unchanged, deduplicating on `message.id`
 * (§15). Request indices here are ITS indices, so every figure in M174 lines up
 * with M173's ledger row for the same run.
 *
 * PHASES. M174's own landmarks, not m169's: the boundary is the first MEANINGFUL
 * edit (§17), which excludes the five `/tmp` reproduction scripts this corpus
 * contains. m169's `landmarksOf` takes the first edit of any kind and would date
 * astropy's treatment implementation phase from request 39 instead of 12.
 *
 * Offline. No agent, no Docker, no paid API.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

import { EditClass, TracePhase, strengthOf, SEARCH_FILE_CREDIT_CAP } from "./m174Traces";
import {
  RESULTS, calibrateAcrossRuns, censoringOf, m173Labels, phaseCostsM174,
  priceUsage, reconstruct, reconstructInputSide, OPUS_4_5_PRICING,
  type Arm, type Calibration, type Reconstructed,
} from "./m174Reconstruct";

const ROOT = path.resolve(".");

// ── main ────────────────────────────────────────────────────────────

const labels = m173Labels();

const loaded: Reconstructed[] = [];
const problems: Record<string, unknown>[] = [];

for (const label of labels) {
  const entry = reconstruct(label);
  if (entry === null) { problems.push({ label, problem: "NOT_OBSERVABLE", detail: "no agent stream" }); continue; }
  loaded.push(entry);
}

const calibration: Calibration | null = calibrateAcrossRuns(loaded.map((r) => r.run));

// ── pair the arms ───────────────────────────────────────────────────

const byInstance = new Map<string, Partial<Record<Arm, Reconstructed>>>();
for (const entry of loaded) {
  const current = byInstance.get(entry.instanceId) ?? {};
  current[entry.arm] = entry;
  byInstance.set(entry.instanceId, current);
}

const perRun = loaded.map((entry) => {
  const usage = reconstructInputSide(entry.run.requests);
  const strong = entry.units.filter((u) => strengthOf(u.kind) === "STRONG");
  return {
    label: entry.label,
    arm: entry.arm,
    instanceId: entry.instanceId,
    censoring: censoringOf(entry.run),
    requests: entry.run.requests.length,
    toolCalls: entry.uses.length,
    landmarks: entry.landmarks,
    phaseCosts: phaseCostsM174(entry.run, entry.landmarks),
    totalCostUsd: entry.run.result?.costUsd ?? null,
    inputSideCostUsd: Number(priceUsage(usage, OPUS_4_5_PRICING).toFixed(6)),
    actionsByKind: entry.actions.reduce<Record<string, number>>((acc, a) => {
      acc[a.kind] = (acc[a.kind] ?? 0) + 1; return acc;
    }, {}),
    meaningfulEdits: entry.actions.filter((a) => a.editClass === EditClass.Meaningful).length,
    scratchEdits: entry.actions.filter((a) => a.editClass === EditClass.Scratch).length,
    searchesCapped: entry.actions.filter((a) => a.searchCapped).length,
    unitsTotal: entry.units.length,
    unitsStrong: strong.length,
    unitsDistinct: new Set(entry.units.map((u) => u.key)).size,
    unitsStrongDistinct: new Set(strong.map((u) => u.key)).size,
    orientationDelivered: entry.orientation.delivered,
    orientationFocusFile: entry.orientation.focusFile,
    orientationFocusAt: entry.orientation.focusAt,
    orientationRelatedFiles: entry.orientation.relatedFiles.length,
    orientationUnits: entry.orientation.units.length,
    orientationCharacters: entry.orientationCharacters,
  };
});

const pairs = [...byInstance.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([instanceId, arms]) => {
  const a = arms.baseline;
  const b = arms.vtrace_compact;
  return {
    instanceId,
    complete: a !== undefined && b !== undefined,
    baselineLabel: a?.label ?? null,
    treatmentLabel: b?.label ?? null,
    baselineFirstEdit: a?.landmarks.firstMeaningfulEditRequest ?? null,
    treatmentFirstEdit: b?.landmarks.firstMeaningfulEditRequest ?? null,
    firstEditDelta: a?.landmarks.firstMeaningfulEditRequest !== undefined
      && a.landmarks.firstMeaningfulEditRequest !== null
      && b?.landmarks.firstMeaningfulEditRequest !== undefined
      && b.landmarks.firstMeaningfulEditRequest !== null
      ? b.landmarks.firstMeaningfulEditRequest - a.landmarks.firstMeaningfulEditRequest
      : null,
    baselineRequests: a?.run.requests.length ?? null,
    treatmentRequests: b?.run.requests.length ?? null,
    baselineCostUsd: a?.run.result?.costUsd ?? null,
    treatmentCostUsd: b?.run.result?.costUsd ?? null,
    costDeltaUsd: a?.run.result?.costUsd !== undefined && b?.run.result?.costUsd !== undefined
      ? Number((b.run.result.costUsd - a.run.result.costUsd).toFixed(6)) : null,
  };
});

// ── artifacts ───────────────────────────────────────────────────────

const write = (name: string, value: unknown): void => {
  const target = path.join(RESULTS, name);
  writeFileSync(target, `${JSON.stringify(value, null, 1)}\n`);
  process.stdout.write(`wrote ${path.relative(ROOT, target)}\n`);
};

write("stage5_m174_pair_manifest.json", {
  schemaVersion: "stage5.m174.pair-manifest.v1",
  milestone: "M174", workstream: "M174-B",
  source: "raw/{vtrace,baseline}/_agent_stream.first_pass.jsonl — complete streams, NOT the 8192-truncated _tool_calls_with_outputs.json",
  accounting: { module: "m169Economics, imported unchanged", deduplicationKey: "message.id" },
  calibration,
  runsFound: loaded.length,
  pairsComplete: pairs.filter((p) => p.complete).length,
  problems,
  pairs,
});

write("stage5_m174_phase_boundaries.json", {
  schemaVersion: "stage5.m174.phase-boundaries.v1",
  milestone: "M174", workstream: "M174-B",
  rule: {
    firstMeaningfulEdit: "first Edit/Write/MultiEdit whose file_path resolves inside the repository under test; /tmp reproductions are SCRATCH",
    knownPositive: "astropy vtrace_compact r12 astropy/units/format/cds.py",
    knownNegative: "astropy vtrace_compact r39 /tmp/test_cds_grammar.py",
    phases: Object.values(TracePhase),
    frozenBefore: "any pairwise interpretation",
  },
  perRun,
});

write("stage5_m174_ordered_actions.json", {
  schemaVersion: "stage5.m174.ordered-actions.v1",
  milestone: "M174", workstream: "M174-B",
  searchFileCreditCap: SEARCH_FILE_CREDIT_CAP,
  runs: loaded.map((entry) => ({
    label: entry.label, arm: entry.arm, instanceId: entry.instanceId,
    landmarks: entry.landmarks,
    actions: entry.actions,
  })),
});

write("stage5_m174_orientation_information.json", {
  schemaVersion: "stage5.m174.orientation-information.v1",
  milestone: "M174", workstream: "M174-B",
  note: "the compact packet canonicalized as the treatment arm's INITIAL information state (§28)",
  runs: loaded.filter((e) => e.arm === "vtrace_compact").map((entry) => ({
    label: entry.label, instanceId: entry.instanceId,
    characters: entry.orientationCharacters,
    delivered: entry.orientation.delivered,
    focusFile: entry.orientation.focusFile,
    focusAt: entry.orientation.focusAt,
    relatedFiles: entry.orientation.relatedFiles,
    relatedAts: entry.orientation.relatedAts,
    units: entry.orientation.units.map((u) => ({ kind: u.kind, key: u.key })),
  })),
});

write("stage5_m174_information_units.json", {
  schemaVersion: "stage5.m174.information-units.v1",
  milestone: "M174", workstream: "M174-B",
  bucketLines: 50,
  runs: loaded.map((entry) => ({
    label: entry.label, arm: entry.arm, instanceId: entry.instanceId,
    units: entry.units.map((u) => ({
      kind: u.kind, key: u.key, requestIndex: u.requestIndex, phase: u.phase, via: u.via,
    })),
  })),
});

process.stdout.write(`\nruns ${loaded.length}  complete pairs ${pairs.filter((p) => p.complete).length}  problems ${problems.length}\n`);
for (const pair of pairs) {
  process.stdout.write(
    `${pair.instanceId.padEnd(30)} A_edit=${String(pair.baselineFirstEdit).padStart(4)} B_edit=${String(pair.treatmentFirstEdit).padStart(4)}`
    + ` Δ=${String(pair.firstEditDelta).padStart(4)}  A_req=${String(pair.baselineRequests).padStart(3)} B_req=${String(pair.treatmentRequests).padStart(3)}`
    + `  Δ$=${pair.costDeltaUsd === null ? "  n/a" : pair.costDeltaUsd.toFixed(4).padStart(8)}\n`,
  );
}
