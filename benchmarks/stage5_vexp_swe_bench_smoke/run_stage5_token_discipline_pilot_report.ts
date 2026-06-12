// Stage 5 token-discipline PILOT comparison report (read-only).
//
// Phase 3 of the token-discipline pilot. It compares the KNOWN worst historical
// overhead case — matplotlib-22719 (+1.55M tokens, +132.7%, 30 tool calls, a
// 16-deep Bash loop, repeated Read/Grep, and VTRACE lost a baseline-resolved
// task) — against a fresh paired rerun produced under the new STAGE5_TOKEN_DISCIPLINE
// policy. The question it answers: did strong-context patch-first discipline
// reduce the turn-count / cache-read blowup, and did it cost any resolution quality?
//
// It is PURE/READ-ONLY: it reads telemetry only (no agents, no Docker, no model
// calls). Historical numbers come from the token-path audit + turn-count reduction
// report already on disk; the new rerun's numbers come from the new run label's
// on-disk artifacts (outcome ledger tokens + `_tool_calls.json` tool stats +
// `_eval.meta.json` resolution) or from an explicit summary file. When no new run
// is present, the report says so and leaves the new-side fields null.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { computeToolCallStats, type RawToolCall } from "./run_stage5_token_path_audit";
import { TURN_COUNT_LONG_BASH_LOOP_THRESHOLD } from "../../src/capsule/turnCountWaste";

export const RESULTS_REL = "benchmarks/stage5_vexp_swe_bench_smoke/results";
export const DEFAULT_OUT_NAME = "stage5_token_discipline_pilot_matplotlib_22719";
export const PILOT_INSTANCE_ID = "matplotlib__matplotlib-22719";
export const TOKEN_PATH_AUDIT_FILE = "stage5_token_path_audit.json";
export const TURN_COUNT_REDUCTION_FILE = "stage5_turn_count_reduction.json";
export const DEFAULT_NEW_RUN_LABEL = "eval-token-discipline-pilot-matplotlib-22719";

// A token reduction below this relative fraction is noise, not a material win.
export const MATERIAL_TOKEN_REDUCTION_FRACTION = 0.1;

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

// One arm's turn-count/token telemetry for the pilot instance. Every field may be
// genuinely absent (null) — nothing is invented.
export interface ArmTelemetry {
  readonly runLabel: string | null;
  readonly totalTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly toolCallCount: number | null;
  readonly bashCount: number | null;
  readonly repeatedReadOrSearch: number | null;
  readonly resolved: boolean | null;
}

// The historical VTRACE side, plus its paired baseline resolution and the audited
// risk tier. tokenDeltaPct is the historical VTRACE-vs-baseline overhead.
export interface HistoricalOverhead {
  readonly vtraceRunLabel: string | null;
  readonly baselineRunLabel: string | null;
  readonly vtraceTotalTokens: number | null;
  readonly baselineTotalTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly tokenDeltaPct: number | null;
  readonly vtraceToolCallCount: number | null;
  readonly vtraceBashCount: number | null;
  readonly vtraceRepeatedReadOrSearch: number | null;
  readonly vtraceResolved: boolean | null;
  readonly baselineResolved: boolean | null;
  readonly tokenReductionRisk: string | null;
}

// The new paired rerun under the token-discipline policy. null when not yet run.
export interface NewRerun {
  readonly newRunLabel: string;
  readonly vtrace: ArmTelemetry;
  readonly baseline: ArmTelemetry;
  readonly tokenReductionRisk: string | null;
  // Whether the new run actually carried the policy (from preflight / run meta).
  readonly tokenDisciplineInjected: boolean;
  readonly tokenDisciplineMode: string;
}

// ---------------------------------------------------------------------------
// Verdict logic — the meaningful business decision of the pilot
// ---------------------------------------------------------------------------

export interface PilotVerdict {
  // Material drop in VTRACE total tokens OR cache-read tokens vs the historical run.
  readonly tokenOverheadImproved: boolean | null;
  readonly totalTokenReductionFraction: number | null;
  readonly cacheReadReductionFraction: number | null;
  // Fewer tool calls / fewer Bash calls / Bash loop dropped below the high-risk
  // threshold / fewer repeated reads / lower audited risk tier.
  readonly turnCountImproved: boolean | null;
  readonly bashDroppedBelowHighRisk: boolean | null;
  readonly riskTierImproved: boolean | null;
  // Token reduction is NOT a win if the new VTRACE patch loses resolution. This is
  // the spec's regression gate: new VTRACE unresolved while a baseline resolved.
  readonly qualityRegressed: boolean | null;
  // Stricter sub-signal: the new run is worse than the historical VTRACE run
  // (historical resolved, new did not). Drives readiness, since the pilot's goal is
  // overhead reduction on a task VTRACE was ALREADY losing — we only need to avoid
  // making it worse, while reporting the baseline gap honestly.
  readonly qualityWorseThanHistorical: boolean | null;
  readonly reasons: readonly string[];
}

const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

function riskRank(risk: string | null): number | null {
  if (risk === null) return null;
  return RISK_RANK[risk] ?? null;
}

// Relative reduction (0..1) of `now` vs `before`; null when either is missing or
// `before` is non-positive. Positive = improvement (fewer tokens).
function reductionFraction(before: number | null, now: number | null): number | null {
  if (before === null || now === null || before <= 0) return null;
  return (before - now) / before;
}

export function computeVerdict(historical: HistoricalOverhead, newRerun: NewRerun | null): PilotVerdict {
  const reasons: string[] = [];
  if (newRerun === null) {
    reasons.push("no new paired rerun on disk yet — overhead effect not measured");
    return {
      tokenOverheadImproved: null,
      totalTokenReductionFraction: null,
      cacheReadReductionFraction: null,
      turnCountImproved: null,
      bashDroppedBelowHighRisk: null,
      riskTierImproved: null,
      qualityRegressed: null,
      qualityWorseThanHistorical: null,
      reasons,
    };
  }

  const totalFrac = reductionFraction(historical.vtraceTotalTokens, newRerun.vtrace.totalTokens);
  const cacheFrac = reductionFraction(historical.cacheReadTokens, newRerun.vtrace.cacheReadTokens);
  const tokenOverheadImproved =
    totalFrac === null && cacheFrac === null
      ? null
      : (totalFrac !== null && totalFrac >= MATERIAL_TOKEN_REDUCTION_FRACTION) ||
        (cacheFrac !== null && cacheFrac >= MATERIAL_TOKEN_REDUCTION_FRACTION);
  if (totalFrac !== null) reasons.push(`total tokens ${totalFrac >= 0 ? "down" : "up"} ${(totalFrac * 100).toFixed(1)}% vs historical`);
  if (cacheFrac !== null) reasons.push(`cacheRead tokens ${cacheFrac >= 0 ? "down" : "up"} ${(cacheFrac * 100).toFixed(1)}% vs historical`);

  // Turn-count: fewer tool calls, fewer Bash, Bash below the high-risk threshold,
  // fewer repeated reads, or a lower audited risk tier — any of these is progress.
  const fewerTools = nullableLess(newRerun.vtrace.toolCallCount, historical.vtraceToolCallCount);
  const fewerBash = nullableLess(newRerun.vtrace.bashCount, historical.vtraceBashCount);
  const fewerRepeats = nullableLess(newRerun.vtrace.repeatedReadOrSearch, historical.vtraceRepeatedReadOrSearch);
  const bashDroppedBelowHighRisk =
    newRerun.vtrace.bashCount === null
      ? null
      : (historical.vtraceBashCount === null || historical.vtraceBashCount >= TURN_COUNT_LONG_BASH_LOOP_THRESHOLD) &&
        newRerun.vtrace.bashCount < TURN_COUNT_LONG_BASH_LOOP_THRESHOLD;
  const newRank = riskRank(newRerun.tokenReductionRisk);
  const oldRank = riskRank(historical.tokenReductionRisk);
  const riskTierImproved = newRank === null || oldRank === null ? null : newRank < oldRank;

  const turnSignals = [fewerTools, fewerBash, fewerRepeats, bashDroppedBelowHighRisk, riskTierImproved];
  const turnCountImproved = turnSignals.every((s) => s === null)
    ? null
    : turnSignals.some((s) => s === true);
  if (fewerTools === true) reasons.push(`fewer tool calls: ${newRerun.vtrace.toolCallCount} < ${historical.vtraceToolCallCount}`);
  if (fewerBash === true) reasons.push(`fewer Bash calls: ${newRerun.vtrace.bashCount} < ${historical.vtraceBashCount}`);
  if (bashDroppedBelowHighRisk === true) reasons.push(`Bash loop dropped below the high-risk threshold (< ${TURN_COUNT_LONG_BASH_LOOP_THRESHOLD})`);
  if (fewerRepeats === true) reasons.push(`fewer repeated Read/Grep: ${newRerun.vtrace.repeatedReadOrSearch} < ${historical.vtraceRepeatedReadOrSearch}`);
  if (riskTierImproved === true) reasons.push(`risk tier improved: ${historical.tokenReductionRisk} → ${newRerun.tokenReductionRisk}`);

  // Quality gate. Prefer the NEW paired baseline; fall back to the historical
  // baseline when the new baseline did not produce a resolution signal.
  const baselineResolved = newRerun.baseline.resolved ?? historical.baselineResolved;
  const newVtraceResolved = newRerun.vtrace.resolved;
  const qualityRegressed =
    newVtraceResolved === null || baselineResolved === null
      ? null
      : newVtraceResolved === false && baselineResolved === true;
  const qualityWorseThanHistorical =
    newVtraceResolved === null || historical.vtraceResolved === null
      ? null
      : historical.vtraceResolved === true && newVtraceResolved === false;
  if (qualityRegressed === true) reasons.push("quality gap: new VTRACE unresolved while baseline resolved");
  if (qualityWorseThanHistorical === true) reasons.push("quality REGRESSION vs historical: new VTRACE lost a task historical VTRACE had resolved");
  if (qualityRegressed === false) reasons.push("no quality regression vs baseline");

  return {
    tokenOverheadImproved,
    totalTokenReductionFraction: totalFrac,
    cacheReadReductionFraction: cacheFrac,
    turnCountImproved,
    bashDroppedBelowHighRisk,
    riskTierImproved,
    qualityRegressed,
    qualityWorseThanHistorical,
    reasons,
  };
}

// a < b with null tolerance: null when either side is missing.
function nullableLess(a: number | null, b: number | null): boolean | null {
  if (a === null || b === null) return null;
  return a < b;
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

export const INTERPRETATION =
  "This pilot tests whether the new strong-context patch-first token discipline reduces the known "
  + "turn-count/cache-read blowup on the worst historical overhead case. It is not a headline benchmark "
  + "and it is not a 100-task validation. It is a targeted engineering check before scaling to more instances.";

export const NON_CLAIMS: readonly string[] = [
  "This pilot does not establish the 100-task token-reduction number.",
  "This pilot does not prove the policy generalizes.",
  "This pilot does not change Stage 5 policy accounting.",
  "This pilot does not enable generated-parser repair broadly.",
];

export interface PilotReport {
  readonly generatedAt: string | null;
  readonly pilotInstanceId: string;
  readonly historicalRunLabel: string | null;
  readonly newRunLabel: string;
  readonly tokenDisciplineInjected: boolean;
  readonly tokenDisciplineMode: string;
  readonly historicalVtraceTotalTokens: number | null;
  readonly newVtraceTotalTokens: number | null;
  readonly historicalVtraceToolCalls: number | null;
  readonly newVtraceToolCalls: number | null;
  readonly historicalVtraceBashCount: number | null;
  readonly newVtraceBashCount: number | null;
  readonly historicalTokenReductionRisk: string | null;
  readonly newTokenReductionRisk: string | null;
  readonly historicalResolved: boolean | null;
  readonly newResolved: boolean | null;
  readonly tokenOverheadImproved: boolean | null;
  readonly turnCountImproved: boolean | null;
  readonly qualityRegressed: boolean | null;
  readonly readyForMoreOverheadCases: boolean;
  readonly readyFor100TaskBenchmark: false;
  // Richer detail beyond the required JSON contract.
  readonly historical: HistoricalOverhead;
  readonly newRerun: NewRerun | null;
  readonly verdict: PilotVerdict;
  readonly preflightPassed: boolean | null;
  // The mode the PREFLIGHT classified for this instance (e.g.
  // strong_context_patch_first) — distinct from tokenDisciplineMode, which reflects
  // what the NEW RUN carried (disabled until the live rerun happens).
  readonly preflightMode: string | null;
  readonly liveRerunPending: boolean;
  readonly recommendedNextStep: string;
  readonly nonClaims: readonly string[];
}

export function buildPilotReport(opts: {
  generatedAt: string | null;
  historical: HistoricalOverhead;
  newRerun: NewRerun | null;
  newRunLabel: string;
  preflightPassed: boolean | null;
  preflightMode?: string | null;
}): PilotReport {
  const { historical, newRerun } = opts;
  const verdict = computeVerdict(historical, newRerun);

  // Readiness for MORE overhead cases: we need real evidence of an overhead win
  // AND we must not have made resolution worse than the historical VTRACE run.
  // (matplotlib-22719 was already a VTRACE loss; the bar for a pilot whose goal is
  // overhead reduction is "cut the blowup without losing ground we held".) The
  // baseline gap is reported separately as qualityRegressed, never hidden.
  const overheadOrTurnImproved = verdict.tokenOverheadImproved === true || verdict.turnCountImproved === true;
  const readyForMoreOverheadCases =
    newRerun !== null && overheadOrTurnImproved && verdict.qualityWorseThanHistorical !== true;

  const recommendedNextStep = computeRecommendedNextStep(newRerun, verdict, readyForMoreOverheadCases);

  return {
    liveRerunPending: newRerun === null,
    preflightMode: opts.preflightMode ?? null,
    generatedAt: opts.generatedAt,
    pilotInstanceId: PILOT_INSTANCE_ID,
    historicalRunLabel: historical.vtraceRunLabel,
    newRunLabel: opts.newRunLabel,
    tokenDisciplineInjected: newRerun?.tokenDisciplineInjected ?? false,
    tokenDisciplineMode: newRerun?.tokenDisciplineMode ?? "disabled",
    historicalVtraceTotalTokens: historical.vtraceTotalTokens,
    newVtraceTotalTokens: newRerun?.vtrace.totalTokens ?? null,
    historicalVtraceToolCalls: historical.vtraceToolCallCount,
    newVtraceToolCalls: newRerun?.vtrace.toolCallCount ?? null,
    historicalVtraceBashCount: historical.vtraceBashCount,
    newVtraceBashCount: newRerun?.vtrace.bashCount ?? null,
    historicalTokenReductionRisk: historical.tokenReductionRisk,
    newTokenReductionRisk: newRerun?.tokenReductionRisk ?? null,
    historicalResolved: historical.vtraceResolved,
    newResolved: newRerun?.vtrace.resolved ?? null,
    tokenOverheadImproved: verdict.tokenOverheadImproved,
    turnCountImproved: verdict.turnCountImproved,
    qualityRegressed: verdict.qualityRegressed,
    readyForMoreOverheadCases,
    readyFor100TaskBenchmark: false,
    historical,
    newRerun,
    verdict,
    preflightPassed: opts.preflightPassed,
    recommendedNextStep,
    nonClaims: NON_CLAIMS,
  };
}

function computeRecommendedNextStep(
  newRerun: NewRerun | null,
  verdict: PilotVerdict,
  ready: boolean,
): string {
  if (newRerun === null) {
    return "Do a deliberate, SUPERVISED live paired rerun of matplotlib-22719 (label `" + DEFAULT_NEW_RUN_LABEL
      + "`) with token discipline enabled — baseline and VTRACE arms — then regenerate this report to measure the "
      + "overhead effect. This is a billable Docker solve and should be launched intentionally, not as part of CI.";
  }
  if (verdict.qualityWorseThanHistorical === true) {
    return "STOP scaling: the policy cut overhead but LOST resolution the historical VTRACE run held — investigate "
      + "whether patch-first fired too early before broadening the pilot.";
  }
  if (ready) {
    return "Proceed to a small batch of the next-worst overhead cases (e.g. astropy-14369) under the same paired "
      + "protocol before considering any larger run. Do NOT jump to the 100-task benchmark.";
  }
  return "Inconclusive: the rerun did not show a material overhead drop. Inspect the new ordered tool-call log and "
    + "re-run before scaling.";
}

// ---------------------------------------------------------------------------
// Markdown / JSON rendering
// ---------------------------------------------------------------------------

function fmtNum(v: number | null): string {
  return v === null ? "n/a" : v.toLocaleString("en-US");
}
function fmtBool(v: boolean | null): string {
  return v === null ? "n/a" : v ? "yes" : "no";
}
function fmtPct(frac: number | null): string {
  return frac === null ? "n/a" : `${(frac * 100).toFixed(1)}%`;
}

export function renderJson(report: PilotReport): string {
  return JSON.stringify(report, null, 2);
}

export function renderMarkdown(report: PilotReport): string {
  const h = report.historical;
  const n = report.newRerun;
  const v = report.verdict;
  const L: string[] = [];
  L.push("# Stage 5 token-discipline pilot: matplotlib-22719");
  L.push("");

  L.push("## Summary");
  L.push("");
  if (n === null) {
    L.push(
      "**Phase 1 preflight PASSED; Phase 2 live paired rerun is PENDING.** The new paired rerun has not been "
        + "produced, so the token-discipline EFFECT is not yet measured. All `newVtrace*` fields are null/unavailable. "
        + `The historical overhead is recorded below; once a paired run under label \`${report.newRunLabel}\` exists, `
        + "regenerate this report. `readyFor100TaskBenchmark` stays false.",
    );
  } else {
    const overhead = v.tokenOverheadImproved === true ? "reduced VTRACE token overhead" : "did NOT materially reduce token overhead";
    const turn = v.turnCountImproved === true ? "reduced turn-count" : "did not reduce turn-count";
    const quality = v.qualityRegressed === true ? "but quality regressed vs baseline" : "with no quality regression vs baseline";
    L.push(`The token-discipline rerun ${overhead} and ${turn}, ${quality}.`);
  }
  L.push("");
  L.push("| signal | value |");
  L.push("| --- | --- |");
  L.push(`| tokenOverheadImproved | ${fmtBool(report.tokenOverheadImproved)} |`);
  L.push(`| turnCountImproved | ${fmtBool(report.turnCountImproved)} |`);
  L.push(`| qualityRegressed | ${fmtBool(report.qualityRegressed)} |`);
  L.push(`| readyForMoreOverheadCases | ${fmtBool(report.readyForMoreOverheadCases)} |`);
  L.push(`| readyFor100TaskBenchmark | ${fmtBool(report.readyFor100TaskBenchmark)} |`);
  L.push("");

  L.push("## Why this case");
  L.push("");
  L.push(
    "matplotlib-22719 is the canonical worst-overhead case from the Stage 5 token-path audit: "
      + `+${fmtNum(h.vtraceTotalTokens !== null && h.baselineTotalTokens !== null ? h.vtraceTotalTokens - h.baselineTotalTokens : null)} tokens `
      + `(${h.tokenDeltaPct === null ? "n/a" : `+${h.tokenDeltaPct.toFixed(1)}%`}), `
      + `${fmtNum(h.vtraceToolCallCount)} tool calls, a ${fmtNum(h.vtraceBashCount)}-deep Bash loop, `
      + `${fmtNum(h.vtraceRepeatedReadOrSearch)} repeated Read/Grep visits, audited risk \`${h.tokenReductionRisk ?? "n/a"}\` — `
      + "and VTRACE LOST a task the baseline resolved. If patch-first discipline helps anywhere, it should help here.",
  );
  L.push("");

  L.push("## Preflight");
  L.push("");
  L.push(
    report.preflightPassed === null
      ? "Preflight result not supplied to this report."
      : report.preflightPassed
        ? `Phase 1 preflight PASSED: STAGE5_TOKEN_DISCIPLINE is injected for this instance in \`${report.preflightMode ?? "strong_context_patch_first"}\` mode, and the baseline arm does not receive it. See \`stage5_token_discipline_preflight.md\`. (The new-run injection state is separate — \`tokenDisciplineInjected=${fmtBool(report.tokenDisciplineInjected)}\` until the live rerun runs.)`
        : "Preflight FAILED — the live rerun should not have proceeded; treat new-side numbers with suspicion.",
  );
  L.push("");

  L.push("## Historical overhead");
  L.push("");
  L.push(`Historical VTRACE run: \`${h.vtraceRunLabel ?? "n/a"}\` (paired baseline \`${h.baselineRunLabel ?? "n/a"}\`).`);
  L.push("");
  L.push("| metric | baseline | VTRACE |");
  L.push("| --- | --- | --- |");
  L.push(`| total tokens | ${fmtNum(h.baselineTotalTokens)} | ${fmtNum(h.vtraceTotalTokens)} |`);
  L.push(`| cacheRead tokens | n/a | ${fmtNum(h.cacheReadTokens)} |`);
  L.push(`| tool calls | n/a | ${fmtNum(h.vtraceToolCallCount)} |`);
  L.push(`| Bash calls | n/a | ${fmtNum(h.vtraceBashCount)} |`);
  L.push(`| repeated Read/Grep | n/a | ${fmtNum(h.vtraceRepeatedReadOrSearch)} |`);
  L.push(`| resolved | ${fmtBool(h.baselineResolved)} | ${fmtBool(h.vtraceResolved)} |`);
  L.push(`| token-reduction risk | n/a | ${h.tokenReductionRisk ?? "n/a"} |`);
  L.push("");

  L.push("## New paired rerun");
  L.push("");
  if (n === null) {
    L.push(`No new rerun on disk under label \`${report.newRunLabel}\`. Run it, then regenerate.`);
  } else {
    L.push(`New run label: \`${n.newRunLabel}\` — token discipline injected: ${fmtBool(n.tokenDisciplineInjected)} (\`${n.tokenDisciplineMode}\`).`);
    L.push("");
    L.push("| metric | baseline | VTRACE |");
    L.push("| --- | --- | --- |");
    L.push(`| total tokens | ${fmtNum(n.baseline.totalTokens)} | ${fmtNum(n.vtrace.totalTokens)} |`);
    L.push(`| cacheRead tokens | ${fmtNum(n.baseline.cacheReadTokens)} | ${fmtNum(n.vtrace.cacheReadTokens)} |`);
    L.push(`| tool calls | ${fmtNum(n.baseline.toolCallCount)} | ${fmtNum(n.vtrace.toolCallCount)} |`);
    L.push(`| Bash calls | ${fmtNum(n.baseline.bashCount)} | ${fmtNum(n.vtrace.bashCount)} |`);
    L.push(`| repeated Read/Grep | ${fmtNum(n.baseline.repeatedReadOrSearch)} | ${fmtNum(n.vtrace.repeatedReadOrSearch)} |`);
    L.push(`| resolved | ${fmtBool(n.baseline.resolved)} | ${fmtBool(n.vtrace.resolved)} |`);
    L.push(`| token-reduction risk | n/a | ${n.tokenReductionRisk ?? "n/a"} |`);
  }
  L.push("");

  L.push("## Token-path comparison");
  L.push("");
  L.push("| metric | historical VTRACE | new VTRACE | reduction |");
  L.push("| --- | --- | --- | --- |");
  L.push(`| total tokens | ${fmtNum(h.vtraceTotalTokens)} | ${fmtNum(n?.vtrace.totalTokens ?? null)} | ${fmtPct(v.totalTokenReductionFraction)} |`);
  L.push(`| cacheRead tokens | ${fmtNum(h.cacheReadTokens)} | ${fmtNum(n?.vtrace.cacheReadTokens ?? null)} | ${fmtPct(v.cacheReadReductionFraction)} |`);
  L.push("");
  L.push(`tokenOverheadImproved: **${fmtBool(v.tokenOverheadImproved)}** (material threshold ${fmtPct(MATERIAL_TOKEN_REDUCTION_FRACTION)}).`);
  L.push("");

  L.push("## Turn-count comparison");
  L.push("");
  L.push("| metric | historical VTRACE | new VTRACE |");
  L.push("| --- | --- | --- |");
  L.push(`| tool calls | ${fmtNum(h.vtraceToolCallCount)} | ${fmtNum(n?.vtrace.toolCallCount ?? null)} |`);
  L.push(`| Bash calls | ${fmtNum(h.vtraceBashCount)} | ${fmtNum(n?.vtrace.bashCount ?? null)} |`);
  L.push(`| repeated Read/Grep | ${fmtNum(h.vtraceRepeatedReadOrSearch)} | ${fmtNum(n?.vtrace.repeatedReadOrSearch ?? null)} |`);
  L.push(`| risk tier | ${h.tokenReductionRisk ?? "n/a"} | ${n?.tokenReductionRisk ?? "n/a"} |`);
  L.push("");
  L.push(
    `turnCountImproved: **${fmtBool(v.turnCountImproved)}** — Bash below high-risk threshold (< ${TURN_COUNT_LONG_BASH_LOOP_THRESHOLD}): `
      + `${fmtBool(v.bashDroppedBelowHighRisk)}; risk tier improved: ${fmtBool(v.riskTierImproved)}.`,
  );
  L.push("");

  L.push("## Resolution/quality comparison");
  L.push("");
  L.push(`- Historical: baseline resolved=${fmtBool(h.baselineResolved)}, VTRACE resolved=${fmtBool(h.vtraceResolved)}.`);
  if (n !== null) {
    L.push(`- New: baseline resolved=${fmtBool(n.baseline.resolved)}, VTRACE resolved=${fmtBool(n.vtrace.resolved)}.`);
  }
  L.push(`- qualityRegressed (new VTRACE unresolved while a baseline resolved): **${fmtBool(v.qualityRegressed)}**.`);
  L.push(`- qualityWorseThanHistorical (lost a task historical VTRACE held): **${fmtBool(v.qualityWorseThanHistorical)}**.`);
  L.push("");
  L.push("> Token reduction is not a win if the new VTRACE patch is worse or loses resolution because it patched too early.");
  L.push("");

  L.push("## Interpretation");
  L.push("");
  L.push(INTERPRETATION);
  if (v.reasons.length > 0) {
    L.push("");
    for (const r of v.reasons) L.push(`- ${r}`);
  }
  L.push("");

  L.push("## Recommended next step");
  L.push("");
  L.push(report.recommendedNextStep);
  L.push("");

  L.push("## Non-claims");
  L.push("");
  for (const nc of report.nonClaims) L.push(`- ${nc}`);
  L.push("");

  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Loaders (impure — read telemetry on disk)
// ---------------------------------------------------------------------------

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

interface AuditTask {
  instanceId?: string;
  baselineRunLabel?: string;
  vtraceRunLabel?: string;
  baselineTotalTokens?: number;
  vtraceTotalTokens?: number;
  tokenDeltaPct?: number;
  cacheReadTokens?: number;
  baselineResolved?: boolean;
  vtraceResolved?: boolean;
  toolCallCount?: number;
  bashCallCount?: number;
  repeatedReadOrSearchCalls?: number;
}

// Load the historical overhead for the pilot instance from the token-path audit
// (token/tool numbers + resolution) and the turn-count reduction report (risk tier).
export async function loadHistoricalOverhead(
  resultsDir: string,
  instanceId: string,
): Promise<HistoricalOverhead | null> {
  const audit = (await readJson(path.join(resultsDir, TOKEN_PATH_AUDIT_FILE))) as { tasks?: AuditTask[] } | null;
  const task = audit?.tasks?.find((t) => t.instanceId === instanceId) ?? null;
  if (task === null) return null;

  const reduction = (await readJson(path.join(resultsDir, TURN_COUNT_REDUCTION_FILE))) as
    | { cases?: { instanceId?: string; risk?: string }[] }
    | null;
  const riskCase = reduction?.cases?.find((c) => c.instanceId === instanceId) ?? null;

  return {
    vtraceRunLabel: task.vtraceRunLabel ?? null,
    baselineRunLabel: task.baselineRunLabel ?? null,
    vtraceTotalTokens: asNum(task.vtraceTotalTokens),
    baselineTotalTokens: asNum(task.baselineTotalTokens),
    cacheReadTokens: asNum(task.cacheReadTokens),
    tokenDeltaPct: asNum(task.tokenDeltaPct),
    vtraceToolCallCount: asNum(task.toolCallCount),
    vtraceBashCount: asNum(task.bashCallCount),
    vtraceRepeatedReadOrSearch: asNum(task.repeatedReadOrSearchCalls),
    vtraceResolved: asBool(task.vtraceResolved),
    baselineResolved: asBool(task.baselineResolved),
    tokenReductionRisk: riskCase?.risk ?? null,
  };
}

// Read one arm's tool stats from a run label's `_tool_calls.json`, resolution from
// `_eval.meta.json`, and tokens from the outcome ledger (keyed runLabel::condition).
async function loadArm(
  resultsDir: string,
  runLabel: string,
  condition: "baseline" | "vtrace",
  ledgerByKey: Map<string, Record<string, unknown>>,
): Promise<ArmTelemetry> {
  const rawDir = path.join(resultsDir, "runs", runLabel, "raw", condition);
  const toolCalls = (await readJson(path.join(rawDir, "_tool_calls.json"))) as RawToolCall[] | null;
  const stats = Array.isArray(toolCalls) ? computeToolCallStats(toolCalls) : null;
  const evalMeta = (await readJson(path.join(rawDir, "_eval.meta.json"))) as Record<string, unknown> | null;
  const resolvedFromEval =
    evalMeta && typeof evalMeta.resolvedCount === "number" ? evalMeta.resolvedCount > 0 : null;

  const ledger = ledgerByKey.get(`${runLabel}::${condition}`) ?? null;
  const tokens = (ledger?.tokens ?? {}) as Record<string, unknown>;

  return {
    runLabel,
    totalTokens: asNum(tokens.total),
    cacheReadTokens: asNum(tokens.cacheRead),
    toolCallCount: stats ? stats.toolCallCount : asNum(ledger?.toolCallCount),
    bashCount: stats ? stats.bashCallCount : null,
    repeatedReadOrSearch: stats ? stats.repeatedReadOrSearchCalls : null,
    resolved: resolvedFromEval ?? asBool(ledger?.resolved),
  };
}

// Build the new-rerun telemetry from a run label's on-disk artifacts. Returns null
// when neither arm produced any readable telemetry (i.e. the run has not happened).
export async function loadNewRerun(
  resultsDir: string,
  newRunLabel: string,
  tokenDiscipline: { injected: boolean; mode: string; risk: string | null },
): Promise<NewRerun | null> {
  const ledgerRaw = (await readJson(path.join(resultsDir, "stage5_outcome_ledger.json"))) as
    | { runs?: Record<string, unknown>[] }
    | null;
  const ledgerByKey = new Map<string, Record<string, unknown>>();
  for (const r of ledgerRaw?.runs ?? []) {
    const label = asStr(r.runLabel);
    const cond = asStr(r.condition);
    if (label !== null && cond !== null) ledgerByKey.set(`${label}::${cond}`, r);
  }

  const vtrace = await loadArm(resultsDir, newRunLabel, "vtrace", ledgerByKey);
  const baseline = await loadArm(resultsDir, newRunLabel, "baseline", ledgerByKey);
  const anyData =
    vtrace.toolCallCount !== null ||
    vtrace.totalTokens !== null ||
    vtrace.resolved !== null ||
    baseline.toolCallCount !== null ||
    baseline.totalTokens !== null ||
    baseline.resolved !== null;
  if (!anyData) return null;

  return {
    newRunLabel,
    vtrace,
    baseline,
    tokenReductionRisk: tokenDiscipline.risk,
    tokenDisciplineInjected: tokenDiscipline.injected,
    tokenDisciplineMode: tokenDiscipline.mode,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly outName: string;
  readonly instanceId: string;
  readonly newRunLabel: string;
  readonly generatedAt: string | null;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let outName = DEFAULT_OUT_NAME;
  let instanceId = PILOT_INSTANCE_ID;
  let newRunLabel = DEFAULT_NEW_RUN_LABEL;
  let generatedAt: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--results-dir": resultsDir = argv[++i] ?? resultsDir; break;
      case "--out": outName = argv[++i] ?? outName; break;
      case "--instance": instanceId = argv[++i] ?? instanceId; break;
      case "--new-run-label": newRunLabel = argv[++i] ?? newRunLabel; break;
      case "--generated-at": generatedAt = argv[++i] ?? null; break;
      default: break;
    }
  }
  return { resultsDir, outName, instanceId, newRunLabel, generatedAt };
}

// Read the preflight's pass flag + mode, so the report can echo readiness state.
async function loadPreflight(resultsDir: string): Promise<{ passed: boolean | null; injected: boolean; mode: string }> {
  const pf = (await readJson(path.join(resultsDir, "stage5_token_discipline_preflight.json"))) as
    | { preflightPassed?: boolean; result?: { tokenDisciplineInjected?: boolean; tokenDisciplineMode?: string } }
    | null;
  if (pf === null) return { passed: null, injected: false, mode: "disabled" };
  return {
    passed: asBool(pf.preflightPassed),
    injected: pf.result?.tokenDisciplineInjected === true,
    mode: pf.result?.tokenDisciplineMode ?? "disabled",
  };
}

export async function main(config: CliConfig): Promise<PilotReport> {
  const historical = await loadHistoricalOverhead(config.resultsDir, config.instanceId);
  if (historical === null) {
    throw new Error(`No historical overhead for ${config.instanceId} in ${TOKEN_PATH_AUDIT_FILE}`);
  }
  const preflight = await loadPreflight(config.resultsDir);
  // The new run's risk tier is recomputed downstream by the turn-count scorer; here
  // we leave it null unless an ingest provided it, so the report never fabricates it.
  const newRerun = await loadNewRerun(config.resultsDir, config.newRunLabel, {
    injected: preflight.injected,
    mode: preflight.mode,
    risk: null,
  });

  const report = buildPilotReport({
    generatedAt: config.generatedAt,
    historical,
    newRerun,
    newRunLabel: config.newRunLabel,
    preflightPassed: preflight.passed,
    preflightMode: preflight.mode,
  });

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));
  process.stdout.write(
    [
      `Stage 5 token-discipline pilot report → ${mdPath}`,
      `  newRun=${config.newRunLabel} present=${newRerun !== null} `
        + `overheadImproved=${report.tokenOverheadImproved} turnImproved=${report.turnCountImproved} `
        + `qualityRegressed=${report.qualityRegressed} readyForMore=${report.readyForMoreOverheadCases} ready100=${report.readyFor100TaskBenchmark}`,
      "",
    ].join("\n"),
  );
  return report;
}

if (import.meta.main) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
