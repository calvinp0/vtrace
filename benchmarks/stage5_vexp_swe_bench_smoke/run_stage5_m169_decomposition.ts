/**
 * M169-B — localize the CLEAN premium, temporally and by response category.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m169_decomposition.ts
 *
 * Two decompositions, kept apart because they answer different questions:
 *
 *   TEMPORAL   where in the run the extra dollars were spent, using only
 *              observable landmarks (§11) — first action, first edit, last edit.
 *   PAYLOAD    what the first `run_pipeline` response was actually made of,
 *              charged through M166's frozen rule table so that "evidence" and
 *              "bookkeeping" are not re-adjudicated here (§31).
 *
 * Reads artifacts only. No agents, no network, no product code paths mutated.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ResponseCategory, decompose, detectorControls } from "./m166Taxonomy";
import {
  ActionKind,
  Censoring,
  OPUS_4_5_PRICING,
  Phase,
  attributePayload,
  calibrateAcrossRuns,
  censoringOf,
  classifyAction,
  landmarksOf,
  parseRun,
  phaseCosts,
  priceUsage,
  type ParsedRun,
} from "./m169Economics";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const RUNS = path.join(RESULTS, "runs");

type Arm = "baseline" | "vtrace_clean" | "vtrace_strict";

interface Loaded {
  readonly label: string;
  readonly arm: Arm;
  readonly instanceId: string;
  readonly parsed: ParsedRun;
  /** The first `run_pipeline` tool_result, verbatim as the model received it. */
  readonly firstPipelineResultText: string | null;
}

function rawDir(label: string): string | null {
  const parent = path.join(RUNS, label, "raw");
  if (!existsSync(parent)) return null;
  for (const child of readdirSync(parent)) {
    const dir = path.join(parent, child);
    if (readdirSync(dir).some((f) => f.startsWith("swebench-") && f.endsWith(".jsonl"))) return dir;
  }
  return null;
}

/**
 * The model-visible text, taken from the stream rather than from the harness's
 * `_tool_calls_with_outputs.json` — that file truncates at 8k characters, which
 * is a third of the real response and would understate every payload figure.
 */
function firstPipelineResult(lines: readonly string[]): string | null {
  let pendingPipeline = false;
  for (const line of lines) {
    if (line.trim() === "") continue;
    let row: Record<string, any>;
    try { row = JSON.parse(line) as Record<string, any>; } catch { continue; }
    if (row.type === "assistant") {
      for (const block of (row.message?.content ?? []) as Record<string, any>[]) {
        if (block.type === "tool_use" && String(block.name ?? "").includes("run_pipeline")) pendingPipeline = true;
      }
      continue;
    }
    if (row.type === "user" && pendingPipeline) {
      for (const block of (row.message?.content ?? []) as Record<string, any>[]) {
        if (block.type !== "tool_result") continue;
        return typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      }
    }
  }
  return null;
}

function load(label: string): Loaded | null {
  const arm = (["baseline", "vtrace_clean", "vtrace_strict"] as const).find((a) => label.startsWith(`m168_${a}_`));
  if (arm === undefined) return null;
  const raw = rawDir(label);
  if (raw === null) return null;
  const rowFile = readdirSync(raw).find((f) => f.startsWith("swebench-") && f.endsWith(".jsonl"))!;
  const line = readFileSync(path.join(raw, rowFile), "utf-8").split("\n").find((l) => l.trim());
  if (line === undefined) return null;
  const streamFile = path.join(raw, "_agent_stream.first_pass.jsonl");
  if (!existsSync(streamFile)) return null;
  const lines = readFileSync(streamFile, "utf-8").split("\n");
  return {
    label,
    arm,
    instanceId: String((JSON.parse(line) as { instanceId: string }).instanceId),
    parsed: parseRun(lines),
    firstPipelineResultText: firstPipelineResult(lines),
  };
}

const loaded = (existsSync(RUNS) ? readdirSync(RUNS) : [])
  .filter((l) => l.startsWith("m168_")).sort()
  .map(load).filter((r): r is Loaded => r !== null);
const calibration = calibrateAcrossRuns(loaded.map((r) => r.parsed));

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(middle)]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

// ── temporal decomposition ──────────────────────────────────────────

interface PhaseRow {
  readonly label: string;
  readonly arm: Arm;
  readonly instanceId: string;
  readonly censoring: Censoring;
  readonly requests: number;
  readonly preEditRequests: number;
  readonly preEditInputSideUsd: number;
  readonly implementationInputSideUsd: number;
  readonly debugTestInputSideUsd: number;
  readonly preEditOutputUsd: number | null;
  readonly implementationOutputUsd: number | null;
  readonly debugTestOutputUsd: number | null;
  readonly preEditTotalUsd: number | null;
  readonly postEditTotalUsd: number | null;
}

const phaseRows: PhaseRow[] = loaded.map((run) => {
  const costs = phaseCosts(run.parsed);
  const by = Object.fromEntries(costs.map((c) => [c.phase, c]));
  const landmarks = landmarksOf(run.parsed);
  const pre = by[Phase.PreEdit]!;
  const impl = by[Phase.Implementation]!;
  const debug = by[Phase.DebugTest]!;
  const sum = (a: number, b: number | null): number | null => (b === null ? null : a + b);
  const post = sum(impl.inputSideCostUsd + debug.inputSideCostUsd,
    impl.estimatedOutputCostUsd === null || debug.estimatedOutputCostUsd === null
      ? null
      : impl.estimatedOutputCostUsd + debug.estimatedOutputCostUsd);
  return {
    label: run.label,
    arm: run.arm,
    instanceId: run.instanceId,
    censoring: censoringOf(run.parsed),
    requests: run.parsed.requests.length,
    preEditRequests: landmarks.firstEditRequest === null ? run.parsed.requests.length : landmarks.firstEditRequest,
    preEditInputSideUsd: Number(pre.inputSideCostUsd.toFixed(6)),
    implementationInputSideUsd: Number(impl.inputSideCostUsd.toFixed(6)),
    debugTestInputSideUsd: Number(debug.inputSideCostUsd.toFixed(6)),
    preEditOutputUsd: pre.estimatedOutputCostUsd === null ? null : Number(pre.estimatedOutputCostUsd.toFixed(6)),
    implementationOutputUsd: impl.estimatedOutputCostUsd === null ? null : Number(impl.estimatedOutputCostUsd.toFixed(6)),
    debugTestOutputUsd: debug.estimatedOutputCostUsd === null ? null : Number(debug.estimatedOutputCostUsd.toFixed(6)),
    preEditTotalUsd: sum(pre.inputSideCostUsd, pre.estimatedOutputCostUsd),
    postEditTotalUsd: post,
  };
});

const byInstanceArm = new Map<string, PhaseRow>();
for (const row of phaseRows) byInstanceArm.set(`${row.instanceId}|${row.arm}`, row);

const instances = [...new Set(phaseRows.map((r) => r.instanceId))].sort();
const phasePairs = instances.map((instanceId) => {
  const a = byInstanceArm.get(`${instanceId}|baseline`);
  const c = byInstanceArm.get(`${instanceId}|vtrace_clean`);
  const measurable = a !== undefined && c !== undefined
    && a.censoring === Censoring.Uncensored && c.censoring === Censoring.Uncensored;
  const delta = (pick: (row: PhaseRow) => number | null): number | null => {
    if (!measurable) return null;
    const left = pick(c!); const right = pick(a!);
    return left === null || right === null ? null : Number((left - right).toFixed(6));
  };
  return {
    instanceId,
    measurable,
    baselinePreEditUsd: a?.preEditTotalUsd ?? null,
    cleanPreEditUsd: c?.preEditTotalUsd ?? null,
    deltaPreEditUsd: delta((r) => r.preEditTotalUsd),
    baselinePostEditUsd: a?.postEditTotalUsd ?? null,
    cleanPostEditUsd: c?.postEditTotalUsd ?? null,
    deltaPostEditUsd: delta((r) => r.postEditTotalUsd),
    deltaRequests: delta((r) => r.requests),
    deltaPreEditRequests: delta((r) => r.preEditRequests),
  };
});

// ── payload decomposition ───────────────────────────────────────────

const CATEGORY_ORDER: readonly ResponseCategory[] = Object.freeze([
  ResponseCategory.RepositoryEvidence,
  ResponseCategory.AgentUsefulControl,
  ResponseCategory.Duplicate,
  ResponseCategory.MachineDiagnostic,
  ResponseCategory.Provenance,
  ResponseCategory.TransportStructure,
  ResponseCategory.Other,
]);

const payloadRows = loaded
  .filter((r) => r.arm !== "baseline" && r.firstPipelineResultText !== null)
  .map((run) => {
    const text = run.firstPipelineResultText!;
    let output: unknown = null;
    let parseStatus = "PARSED";
    try {
      const envelope = JSON.parse(text) as Record<string, any>;
      output = envelope?.result?.output ?? null;
      if (output === null) parseStatus = "NO_OUTPUT_FIELD";
    } catch {
      parseStatus = "PARSE_FAILURE";
    }
    // §72 — a parse failure is a parse failure. It is never rendered as absence.
    if (parseStatus !== "PARSED") {
      return {
        label: run.label, arm: run.arm, instanceId: run.instanceId,
        parseStatus, deliveredCharacters: text.length,
        byCategory: null, evidenceShare: null, envelopeShare: null,
      };
    }
    const decomposition = decompose(output);
    const byCategory = Object.fromEntries(
      CATEGORY_ORDER.map((category) => [category, decomposition.byCategory[category] ?? 0]),
    );
    const evidence = decomposition.byCategory[ResponseCategory.RepositoryEvidence] ?? 0;
    return {
      label: run.label,
      arm: run.arm,
      instanceId: run.instanceId,
      parseStatus,
      deliveredCharacters: text.length,
      decomposedCharacters: decomposition.totalCharacters,
      byCategory,
      evidenceShare: Number((evidence / decomposition.totalCharacters).toFixed(4)),
      envelopeShare: Number((1 - evidence / decomposition.totalCharacters).toFixed(4)),
      topGroups: decomposition.topGroups.slice(0, 8),
      decomposition,
    };
  });

const parsedPayloads = payloadRows.filter((r) => r.parseStatus === "PARSED");
const controls = detectorControls(parsedPayloads.map((r) => (r as any).decomposition));

// Price each category with the same arithmetic used for the whole payload.
const cleanPayloads = parsedPayloads.filter((r) => r.arm === "vtrace_clean");
const categoryCost = (): Record<string, { characters: number; tokens: number; costUsd: number }> => {
  const totals: Record<string, { characters: number; tokens: number; costUsd: number }> = {};
  for (const row of cleanPayloads) {
    const run = loaded.find((l) => l.label === row.label)!;
    const attributed = run.parsed.toolResults
      .map((tr) => attributePayload(run.parsed, tr.orderIndex, calibration))
      .find((a) => a !== null && a.kind === ActionKind.Pipeline);
    if (attributed === undefined || attributed === null || attributed.payloadTokensEstimated === null) continue;
    const totalChars = row.decomposedCharacters!;
    for (const [category, characters] of Object.entries(row.byCategory!)) {
      const share = totalChars === 0 ? 0 : (characters as number) / totalChars;
      const bucket = totals[category] ?? { characters: 0, tokens: 0, costUsd: 0 };
      totals[category] = {
        characters: bucket.characters + (characters as number),
        tokens: bucket.tokens + attributed.payloadTokensEstimated * share,
        costUsd: bucket.costUsd + (attributed.totalAttributableCostUsd ?? 0) * share,
      };
    }
  }
  return Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, {
    characters: v.characters,
    tokens: Math.round(v.tokens),
    costUsd: Number(v.costUsd.toFixed(6)),
  }]));
};

const write = (name: string, doc: unknown): void => {
  writeFileSync(path.join(RESULTS, name), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${name}`);
};

write("stage5_m169_phase_decomposition.json", {
  schemaVersion: "stage5.m169.phase-decomposition.v1",
  milestone: "M169",
  workstream: "M169-B",
  landmarkPolicy: "Observable landmarks only. The pre-edit window is called PRE_EDIT_INVESTIGATION, never 'localization' (§13).",
  outputPolicy: "Input-side phase costs are EXACT. The output term is whole-run output apportioned by authored characters and is ESTIMATED.",
  perRun: phaseRows,
  pairs: phasePairs,
  pairedMedians: {
    pairs: phasePairs.filter((p) => p.measurable).length,
    medianDeltaPreEditUsd: Number(median(phasePairs.filter((p) => p.deltaPreEditUsd !== null).map((p) => p.deltaPreEditUsd!)).toFixed(6)),
    medianDeltaPostEditUsd: Number(median(phasePairs.filter((p) => p.deltaPostEditUsd !== null).map((p) => p.deltaPostEditUsd!)).toFixed(6)),
    medianDeltaRequests: median(phasePairs.filter((p) => p.deltaRequests !== null).map((p) => p.deltaRequests!)),
  },
});

write("stage5_m169_payload_composition.json", {
  schemaVersion: "stage5.m169.payload-composition.v1",
  milestone: "M169",
  workstream: "M169-B",
  classifier: "M166-B frozen rule table, reused verbatim (§31). M169 re-adjudicates no category.",
  source: "the model-visible tool_result in the stream, NOT the harness's 8k-truncated tool-call log",
  detectorControls: controls,
  perRun: payloadRows.map(({ decomposition, ...rest }: any) => rest),
  cleanArmCategoryCost: categoryCost(),
  pricing: OPUS_4_5_PRICING,
});

// ── console ─────────────────────────────────────────────────────────

const measurable = phasePairs.filter((p) => p.measurable);
console.log(`\npaired phase medians over ${measurable.length} uncensored pairs`);
console.log(`  pre-edit  delta: $${median(measurable.map((p) => p.deltaPreEditUsd!)).toFixed(4)}`);
console.log(`  post-edit delta: $${median(measurable.map((p) => p.deltaPostEditUsd!)).toFixed(4)}`);
console.log(`  requests  delta: ${median(measurable.map((p) => p.deltaRequests!))}`);
console.log(`\nfirst run_pipeline payload composition (clean arm, ${cleanPayloads.length} runs):`);
for (const [category, value] of Object.entries(categoryCost()).sort((a, b) => b[1].characters - a[1].characters)) {
  const total = Object.values(categoryCost()).reduce((s, v) => s + v.characters, 0);
  console.log(`  ${category.padEnd(22)} ${String(value.characters).padStart(8)} chars ${((100 * value.characters) / total).toFixed(1).padStart(5)}%  $${value.costUsd.toFixed(4)}`);
}
console.log(`\ndetector controls: ${controls.length}`);
for (const control of controls) console.log(`  ${JSON.stringify(control)}`);
