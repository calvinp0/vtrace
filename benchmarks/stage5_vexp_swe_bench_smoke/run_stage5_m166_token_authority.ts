/**
 * M166-A — token authority over the real M164 runs.
 *
 * The question is not what VTRACE serializes; M165 already measured that. It is what
 * the model was handed and what the provider billed. Both are recoverable from the
 * M164 stream transcripts at zero cost, so no paid agent runs here (§13, §57).
 *
 * The attribution rests on an identity the streams either satisfy or do not:
 *
 *     cache_read[n+1] == cache_read[n] + cache_creation[n]
 *
 * Where it holds, a turn's cache-creation is exactly what that turn added to the
 * model's context, and every later request re-reads it. It is checked, not assumed.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  type Calibration,
  type CalibrationSample,
  type StreamTurn,
  attributeToolResult,
  calibrateResultTokens,
  checkCacheIdentity,
  parseAgentStream,
} from "./m166Boundary";

const RESULTS = path.join(path.resolve("."), "benchmarks/stage5_vexp_swe_bench_smoke/results");
const RUNS = path.join(RESULTS, "runs");
const OUT = path.join(RESULTS, "stage5_m166_token_authority.json");
const CONTROLS = path.join(RESULTS, "stage5_m166_attribution_controls.json");

const TRIGGER_PREFIX = "m164_tools_task_trigger_";
const NEUTRAL_PREFIX = "m164_tools_neutral_policy_";
const VTRACE_RESULT_MARKER = '"vtrace.mcp_server"';

function streamTurns(label: string): StreamTurn[] {
  const dir = path.join(RUNS, label, "raw/vtrace");
  for (const name of ["_agent_stream.first_pass.jsonl", "_agent_stream.jsonl"]) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    return parseAgentStream(readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0));
  }
  return [];
}

function runLabels(prefix: string): string[] {
  if (!existsSync(RUNS)) return [];
  return readdirSync(RUNS).filter((entry) => entry.startsWith(prefix)).sort();
}

/** Samples pairing what a turn handed the model against what the next request cached. */
function calibrationSamples(turns: readonly StreamTurn[]): CalibrationSample[] {
  const samples: CalibrationSample[] = [];
  for (const turn of turns) {
    if (turn.kind !== "toolResult") continue;
    const previous = [...turns].reverse().find((t): t is Extract<StreamTurn, { kind: "assistant" }> => t.kind === "assistant" && t.index < turn.index);
    const next = turns.find((t): t is Extract<StreamTurn, { kind: "assistant" }> => t.kind === "assistant" && t.index > turn.index);
    if (previous === undefined || next === undefined || next.cacheCreationTokens === null) continue;
    samples.push({ resultCharacters: turn.characters, authoredCharacters: previous.authoredCharacters, cacheCreationTokens: next.cacheCreationTokens });
  }
  return samples;
}

/** The first VTRACE tool result in a run, identified by the envelope the server stamps. */
function firstVtraceResultIndex(turns: readonly StreamTurn[]): number | null {
  for (const turn of turns) {
    if (turn.kind === "toolResult" && turn.head.includes(VTRACE_RESULT_MARKER)) return turn.index;
  }
  return null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

function main(): void {
  const triggerLabels = runLabels(TRIGGER_PREFIX);
  const neutralLabels = runLabels(NEUTRAL_PREFIX);
  const allTurns = new Map<string, StreamTurn[]>();
  for (const label of [...triggerLabels, ...neutralLabels]) allTurns.set(label, streamTurns(label));

  // Calibrate across BOTH arms: the widest span of tool-result sizes available, and
  // the neutral arm supplies the small-result end that the trigger arm alone lacks.
  const samples = [...allTurns.values()].flatMap((turns) => calibrationSamples(turns));
  const calibration: Calibration | null = calibrateResultTokens(samples);

  const identity = { checked: 0, held: 0, runsWithViolations: [] as string[] };
  for (const [label, turns] of allTurns) {
    const report = checkCacheIdentity(turns);
    identity.checked += report.checked;
    identity.held += report.held;
    if (report.violations.length > 0) identity.runsWithViolations.push(label);
  }

  const cases: Record<string, unknown>[] = [];
  for (const label of triggerLabels) {
    const turns = allTurns.get(label) ?? [];
    const index = firstVtraceResultIndex(turns);
    const assistants = turns.filter((t): t is Extract<StreamTurn, { kind: "assistant" }> => t.kind === "assistant");
    const runTraffic = assistants.reduce((sum, t) => sum + (t.cacheCreationTokens ?? 0) + (t.cacheReadTokens ?? 0) + (t.inputTokens ?? 0), 0);
    if (index === null) {
      cases.push({ label, instanceId: label.slice(TRIGGER_PREFIX.length), vtraceCallObserved: false, note: "no VTRACE tool result in this stream" });
      continue;
    }
    const attribution = attributeToolResult(turns, index, calibration);
    const target = turns.find((t) => t.index === index)!;
    const vtraceCallCount = turns.filter((t) => t.kind === "toolResult" && t.head.includes(VTRACE_RESULT_MARKER)).length;
    const otherResults = turns.filter((t): t is Extract<StreamTurn, { kind: "toolResult" }> => t.kind === "toolResult" && !t.head.includes(VTRACE_RESULT_MARKER));
    cases.push({
      label,
      instanceId: label.slice(TRIGGER_PREFIX.length),
      vtraceCallObserved: true,
      vtraceResultCount: vtraceCallCount,
      requests: assistants.length,
      modelVisibleCharacters: target.kind === "toolResult" ? target.characters : null,
      attribution,
      /** Every request after the VTRACE result re-read it; this is the total re-read. */
      cacheReadAmplification: {
        subsequentRequests: attribution.subsequentRequests,
        tokens: attribution.cacheReadAmplificationTokens,
        authority: attribution.authority,
      },
      totalRunTrafficTokens: runTraffic,
      vtraceShareOfRunTrafficPercent: runTraffic === 0 || attribution.estimatedTokens === null
        ? null
        : Number((100 * (attribution.estimatedTokens * (1 + attribution.subsequentRequests)) / runTraffic).toFixed(1)),
      otherToolResults: {
        count: otherResults.length,
        medianCharacters: median(otherResults.map((t) => t.characters)),
        maxCharacters: otherResults.length === 0 ? null : Math.max(...otherResults.map((t) => t.characters)),
        vtraceIsLargest: otherResults.every((t) => t.characters <= (target.kind === "toolResult" ? target.characters : 0)),
      },
    });
  }

  const measured = cases.filter((c) => c.vtraceCallObserved === true);
  const chars = measured.map((c) => c.modelVisibleCharacters as number);
  const estimated = measured.map((c) => (c.attribution as { estimatedTokens: number | null }).estimatedTokens).filter((v): v is number => v !== null);
  const upper = measured.map((c) => (c.attribution as { upperBoundTokens: number | null }).upperBoundTokens).filter((v): v is number => v !== null);
  const lower = measured.map((c) => (c.attribution as { lowerBoundTokens: number | null }).lowerBoundTokens).filter((v): v is number => v !== null);
  const amplified = measured.map((c) => (c.cacheReadAmplification as { tokens: number | null }).tokens).filter((v): v is number => v !== null);
  const share = measured.map((c) => c.vtraceShareOfRunTrafficPercent).filter((v): v is number => typeof v === "number");

  const payload = {
    schemaVersion: 1,
    milestone: "M166",
    workstream: "A",
    title: "What the model was handed and what the provider billed, for one VTRACE call",
    sources: {
      arms: { trigger: triggerLabels.length, neutral: neutralLabels.length },
      transcripts: "M164 stream-json, first pass; no new agent spend (§13/§57)",
    },
    cacheIdentity: {
      statement: "cache_read[n+1] == cache_read[n] + cache_creation[n]",
      checked: identity.checked,
      held: identity.held,
      holdRate: identity.checked === 0 ? null : Number((identity.held / identity.checked).toFixed(4)),
      runsWithViolations: identity.runsWithViolations,
      reading: identity.held === identity.checked
        ? "identity held on every checked turn; a turn's cache-creation is what that turn added"
        : "identity held on all but the named runs; attribution there is bounded, not derived",
    },
    calibration: calibration === null ? null : {
      ...calibration,
      derivedFrom: "measured cache-creation regressed on tool-result characters and assistant-authored characters, across both arms",
      authority: "DERIVED_FROM_PROVIDER_REPORTED",
      comparisonToProductEstimate: {
        productAssumesCharactersPerToken: 4,
        measuredCharactersPerToken: Number(calibration.resultCharactersPerToken.toFixed(2)),
        productUnderstatesByFactor: Number((4 / calibration.resultCharactersPerToken).toFixed(3)),
        reading: "responseBudget's chars/4 estimate understates the billed cost of a dense JSON payload",
      },
    },
    aggregate: {
      cases: cases.length,
      measured: measured.length,
      modelVisibleCharacters: { median: median(chars), p90: percentile(chars, 0.9), min: Math.min(...chars), max: Math.max(...chars) },
      firstCallTokens: {
        lowerBound: { median: median(lower), min: lower.length === 0 ? null : Math.min(...lower), max: lower.length === 0 ? null : Math.max(...lower) },
        estimated: { median: median(estimated), p90: percentile(estimated, 0.9), min: Math.min(...estimated), max: Math.max(...estimated) },
        upperBound: { median: median(upper), min: upper.length === 0 ? null : Math.min(...upper), max: upper.length === 0 ? null : Math.max(...upper) },
        authority: "DERIVED_FROM_PROVIDER_REPORTED",
      },
      cacheReadAmplificationTokens: { median: median(amplified), p90: percentile(amplified, 0.9), min: Math.min(...amplified), max: Math.max(...amplified) },
      vtraceShareOfRunTrafficPercent: { median: median(share), min: share.length === 0 ? null : Math.min(...share), max: share.length === 0 ? null : Math.max(...share) },
    },
    cases,
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 1));

  // §15. The measurement path must be shown detecting a small result and a large one
  // before any figure it produces is treated as evidence. The control is built from
  // the same real streams: tool results spanning three orders of magnitude.
  const buckets = [
    { name: "tiny", min: 0, max: 200 },
    { name: "small", min: 200, max: 2000 },
    { name: "medium", min: 2000, max: 10000 },
    { name: "large", min: 10000, max: 100000 },
  ].map((bucket) => {
    const inBucket = samples.filter((s) => s.resultCharacters >= bucket.min && s.resultCharacters < bucket.max);
    return {
      ...bucket,
      samples: inBucket.length,
      medianResultCharacters: median(inBucket.map((s) => s.resultCharacters)),
      medianMeasuredCacheCreationTokens: median(inBucket.map((s) => s.cacheCreationTokens)),
    };
  });
  const monotonic = buckets.filter((b) => b.samples > 0);
  const controls = {
    schemaVersion: 1,
    milestone: "M166",
    workstream: "A",
    title: "Known-positive attribution controls",
    method: "real M164 tool results across both arms, bucketed by size; no synthetic fixture and no paid model call",
    buckets,
    monotoneInPayloadSize: monotonic.every((bucket, i) => i === 0 || (bucket.medianMeasuredCacheCreationTokens ?? 0) >= (monotonic[i - 1]!.medianMeasuredCacheCreationTokens ?? 0)),
    fitQuality: calibration === null ? null : { rSquared: Number(calibration.rSquared.toFixed(4)), samples: calibration.samples },
    negativeControl: {
      statement: "a stream carrying no usage figures must yield no derived attribution",
      covered: "m166Boundary.test.ts — checkCacheIdentity reports checked=0 and holdsEverywhere=false",
    },
    verdict: calibration !== null && calibration.rSquared > 0.5 && monotonic.every((bucket, i) => i === 0 || (bucket.medianMeasuredCacheCreationTokens ?? 0) >= (monotonic[i - 1]!.medianMeasuredCacheCreationTokens ?? 0))
      ? "PASS — billed traffic moves with model-visible payload size, and the fit is strong enough to attribute"
      : "FAIL — the measurement path cannot separate a small result from a large one",
  };
  writeFileSync(CONTROLS, JSON.stringify(controls, null, 1));

  console.error(`[m166-A] identity ${identity.held}/${identity.checked}; calibration ${calibration === null ? "none" : `${calibration.resultCharactersPerToken.toFixed(2)} chars/token R2=${calibration.rSquared.toFixed(3)}`}`);
  console.error(`[m166-A] first-call estimated median ${median(estimated)} tokens; amplification median ${median(amplified)}; share median ${median(share)}%`);
  console.error(`[m166-A] wrote ${OUT} and ${CONTROLS}`);
}

main();
