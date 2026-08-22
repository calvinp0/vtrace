/**
 * M170-A — what a normal agent actually does before it edits, and what it costs.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m170_investigation.ts
 *
 * Reads the M168 BASELINE arm only: twelve runs of an agent with no VTRACE at
 * all, which is the workflow M170 proposes to sit underneath. Cost attribution
 * is M169's — one cache write plus one re-read per subsequent request — so that
 * M170's dollars and M169's are the same dollars.
 *
 * No live agents. No paid APIs. Reads captured artifacts only.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  OperationIntent, Phase, parseOperations, isInvestigationIntent,
  FAMILY_VERDICTS, NATIVE_BOUND_DISCLOSURE, readSpanOf,
} from "./m170Investigation";
import {
  parseRun, calibrateAcrossRuns, attributePayload, censoringOf, checkCacheIdentity,
  OPUS_4_5_PRICING,
} from "./m169Economics";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const RUNS = path.join(RESULTS, "runs");

const labels = readdirSync(RUNS).filter((l) => l.startsWith("m168_baseline_")).sort();

interface Loaded {
  readonly label: string;
  readonly instanceId: string;
  readonly lines: readonly string[];
}

const loaded: Loaded[] = [];
for (const label of labels) {
  const stream = path.join(RUNS, label, "raw", "baseline", "_agent_stream.first_pass.jsonl");
  if (!existsSync(stream)) continue;
  loaded.push({
    label,
    instanceId: label.slice("m168_baseline_".length),
    lines: readFileSync(stream, "utf-8").split("\n"),
  });
}

const parsed = loaded.map((entry) => ({ ...entry, run: parseRun(entry.lines) }));
const calibration = calibrateAcrossRuns(parsed.map((p) => p.run));

const rows = parsed.map(({ label, instanceId, lines, run }) => {
  const operations = parseOperations(lines);
  const censoring = censoringOf(run);
  const cacheIdentity = checkCacheIdentity(run.requests);

  // M169 pairs results to uses by sibling order; M170 pairs by tool_use_id.
  // If the two ever disagree about how many results exist, every per-operation
  // cost below is attached to the wrong operation, so this is a gate, not a note.
  const pairingAgrees = operations.length === run.toolResults.length;

  const priced = operations.map((op) => {
    const attributed = attributePayload(run, op.orderIndex, calibration, OPUS_4_5_PRICING);
    return {
      orderIndex: op.orderIndex,
      tool: op.tool,
      intent: op.intent,
      phase: op.phase,
      isError: op.isError,
      resultCharacters: op.resultCharacters,
      bannerCharacters: op.bannerCharacters,
      nativePartialView: op.nativePartialView,
      filePath: typeof op.input.file_path === "string" ? op.input.file_path : null,
      pattern: typeof op.input.pattern === "string" ? op.input.pattern : null,
      globPattern: typeof op.input.glob === "string" ? op.input.glob : null,
      outputMode: typeof op.input.output_mode === "string" ? op.input.output_mode : null,
      headLimit: typeof op.input.head_limit === "number" ? op.input.head_limit : null,
      offset: typeof op.input.offset === "number" ? op.input.offset : null,
      limit: typeof op.input.limit === "number" ? op.input.limit : null,
      readSpan: op.tool === "Read" ? readSpanOf("") : null,
      resultPaths: op.resultPaths,
      payloadTokensEstimated: attributed?.payloadTokensEstimated ?? null,
      totalAttributableCostUsd: attributed?.totalAttributableCostUsd ?? null,
      amplificationRequests: attributed?.amplificationRequests ?? 0,
      authority: attributed?.authority ?? null,
    };
  });

  const investigation = priced.filter((p) => isInvestigationIntent(p.intent as OperationIntent));
  const preEdit = investigation.filter((p) => p.phase === Phase.PreFirstEdit);
  const sum = (values: readonly (number | null)[]): number =>
    values.reduce<number>((total, value) => total + (value ?? 0), 0);

  const byIntent: Record<string, { count: number; characters: number; tokens: number; costUsd: number }> = {};
  for (const op of priced) {
    const bucket = (byIntent[op.intent] ??= { count: 0, characters: 0, tokens: 0, costUsd: 0 });
    bucket.count += 1;
    bucket.characters += op.resultCharacters;
    bucket.tokens += op.payloadTokensEstimated ?? 0;
    bucket.costUsd += op.totalAttributableCostUsd ?? 0;
  }
  for (const bucket of Object.values(byIntent)) bucket.costUsd = Number(bucket.costUsd.toFixed(6));

  return {
    instanceId,
    label,
    censoring,
    cacheIdentityHolds: cacheIdentity.holdsEverywhere,
    pairingAgrees,
    requests: run.requests.length,
    operations: priced.length,
    unpairedToolUses: run.requests.reduce((n, r) => n + r.toolUses.length, 0) - priced.length,
    runCostUsd: run.result?.costUsd ?? null,
    investigationOperations: investigation.length,
    preEditInvestigationOperations: preEdit.length,
    investigationCharacters: sum(investigation.map((p) => p.resultCharacters)),
    preEditInvestigationCharacters: sum(preEdit.map((p) => p.resultCharacters)),
    investigationCostUsd: Number(sum(investigation.map((p) => p.totalAttributableCostUsd)).toFixed(6)),
    preEditInvestigationCostUsd: Number(sum(preEdit.map((p) => p.totalAttributableCostUsd)).toFixed(6)),
    wholeRunResultCharacters: sum(priced.map((p) => p.resultCharacters)),
    byIntent,
    operationsDetail: priced,
  };
});

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(middle)]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

// ── corpus-level concentration: where is the traffic actually? ───────

const allOperations = rows.flatMap((r) => r.operationsDetail);
const corpusByIntent: Record<string, { count: number; characters: number; costUsd: number; runsPresent: number }> = {};
for (const op of allOperations) {
  const bucket = (corpusByIntent[op.intent] ??= { count: 0, characters: 0, costUsd: 0, runsPresent: 0 });
  bucket.count += 1;
  bucket.characters += op.resultCharacters;
  bucket.costUsd += op.totalAttributableCostUsd ?? 0;
}
for (const [intent, bucket] of Object.entries(corpusByIntent)) {
  bucket.costUsd = Number(bucket.costUsd.toFixed(6));
  bucket.runsPresent = rows.filter((r) => r.operationsDetail.some((op) => op.intent === intent)).length;
}

const investigationOps = allOperations.filter((op) => isInvestigationIntent(op.intent as OperationIntent));
const investigationChars = investigationOps.reduce((n, op) => n + op.resultCharacters, 0);
const investigationCost = investigationOps.reduce((n, op) => n + (op.totalAttributableCostUsd ?? 0), 0);

const ranked = [...investigationOps].sort((a, b) => b.resultCharacters - a.resultCharacters);
const topShare = (n: number): number => {
  const top = ranked.slice(0, n).reduce((total, op) => total + op.resultCharacters, 0);
  return investigationChars === 0 ? 0 : Number((top / investigationChars).toFixed(4));
};

const wholeFileReads = allOperations.filter((op) => op.intent === OperationIntent.WholeFileRead && !op.isError);

const report = {
  schemaVersion: "stage5.m170.investigation-surface.v1",
  milestone: "M170",
  workstream: "A",
  title: "Normal-agent investigation surface, reconstructed from the M168 baseline arm",
  method: {
    corpus: "M168 baseline arm — twelve runs, no VTRACE tools, no VTRACE policy, no VTRACE context",
    source: "raw/baseline/_agent_stream.first_pass.jsonl (NOT _tool_calls_with_outputs.json, which truncates at 8192 chars)",
    pairing: "tool_use_id",
    costModel: "m169Economics.attributePayload — one cache write plus one re-read per subsequent request",
    pricing: OPUS_4_5_PRICING,
    calibrationAvailable: calibration !== null,
    liveSpendUsd: 0,
  },
  controls: {
    runsLoaded: rows.length,
    pairingAgreesEverywhere: rows.every((r) => r.pairingAgrees),
    pairingDisagreements: rows.filter((r) => !r.pairingAgrees).map((r) => r.instanceId),
    cacheIdentityHolds: rows.filter((r) => r.cacheIdentityHolds).length,
    censored: rows.filter((r) => r.censoring !== "UNCENSORED").map((r) => ({ instanceId: r.instanceId, censoring: r.censoring })),
  },
  corpus: {
    operations: allOperations.length,
    investigationOperations: investigationOps.length,
    investigationCharacters: investigationChars,
    investigationCostUsd: Number(investigationCost.toFixed(6)),
    investigationCostUsdPerTask: Number((investigationCost / Math.max(1, rows.length)).toFixed(6)),
    medianInvestigationCostUsd: Number(median(rows.map((r) => r.investigationCostUsd)).toFixed(6)),
    medianPreEditInvestigationCostUsd: Number(median(rows.map((r) => r.preEditInvestigationCostUsd)).toFixed(6)),
    byIntent: corpusByIntent,
    concentration: {
      note: "share of ALL investigation characters held by the N largest single operations",
      top1: topShare(1), top5: topShare(5), top10: topShare(10), top20: topShare(20),
    },
    wholeFileReads: {
      count: wholeFileReads.length,
      runsWithAtLeastOne: rows.filter((r) => r.operationsDetail.some((op) => op.intent === OperationIntent.WholeFileRead && !op.isError)).length,
      characters: wholeFileReads.reduce((n, op) => n + op.resultCharacters, 0),
      shareOfInvestigationCharacters: investigationChars === 0 ? 0
        : Number((wholeFileReads.reduce((n, op) => n + op.resultCharacters, 0) / investigationChars).toFixed(4)),
      costUsd: Number(wholeFileReads.reduce((n, op) => n + (op.totalAttributableCostUsd ?? 0), 0).toFixed(6)),
      nativePartialViewFired: wholeFileReads.filter((op) => op.nativePartialView).length,
      largestCharacters: Math.max(0, ...wholeFileReads.map((op) => op.resultCharacters)),
    },
  },
  operationSemantics: {
    nativeBoundDisclosure: NATIVE_BOUND_DISCLOSURE,
    familyVerdicts: FAMILY_VERDICTS,
  },
  perTask: rows,
};

const out = path.join(RESULTS, "stage5_m170_investigation_surface.json");
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(`runs ${rows.length}  pairing-agrees ${report.controls.pairingAgreesEverywhere}`);
console.log(`investigation ops ${investigationOps.length}  chars ${investigationChars}  $${report.corpus.investigationCostUsd}`);
console.log(`median investigation $${report.corpus.medianInvestigationCostUsd}  pre-edit $${report.corpus.medianPreEditInvestigationCostUsd}`);
console.log("by intent:");
for (const [intent, bucket] of Object.entries(corpusByIntent).sort((a, b) => b[1].characters - a[1].characters)) {
  console.log(`  ${intent.padEnd(20)} n=${String(bucket.count).padStart(3)}  chars=${String(bucket.characters).padStart(7)}  $${bucket.costUsd.toFixed(4)}  runs=${bucket.runsPresent}`);
}
console.log(`concentration top1=${report.corpus.concentration.top1} top5=${report.corpus.concentration.top5} top10=${report.corpus.concentration.top10}`);
console.log(`whole-file reads ${report.corpus.wholeFileReads.count} in ${report.corpus.wholeFileReads.runsWithAtLeastOne} runs, ${report.corpus.wholeFileReads.shareOfInvestigationCharacters} of investigation chars, native partial-view fired ${report.corpus.wholeFileReads.nativePartialViewFired}`);
console.log(`→ ${out}`);
