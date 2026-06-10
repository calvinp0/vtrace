// Stage 5 risk-gated matplotlib old-vs-new comparison report.
//
// SCOPE: reporting / accounting ONLY. Both runs and their Docker evaluations already exist
// on disk; this script READS those raw artifacts and computes a single old-vs-new comparison
// for matplotlib__matplotlib-22719:
//   old = controlled VTRACE run    (eval-controlled-vtrace-matplotlib-22719)
//   new = risk-gated VTRACE rerun  (eval-riskgated-vtrace-matplotlib-22719)
//
// It runs NO agents, NO live critic, NO repair, NO Docker, and changes NO retrieval /
// Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair / evaluator
// / policy behavior. It never mutates a raw artifact; it only writes its own Markdown + JSON.
//
// Provenance is split deliberately:
//   * model usage / cost / resolution  → the SWE-bench JSONL row under raw/vtrace/*.jsonl
//   * VTRACE policy / context metadata  → _run.meta.json
// Token/cost numbers are NEVER read from _run.meta.json (that file only carries capsule
// estimates and policy flags, not real model spend). Resolution is read verbatim from the
// JSONL row; the Docker evaluation under _eval.meta.json is reported but never re-run.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { editedFilesFromPatch } from "../../src/capsule/finalEditDiagnostics";
import { delta, deltaPct } from "./run_stage5_pivot_check_report";
import { isRecord, uniq } from "./run_stage5_outcome_ledger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RESULTS_REL = "benchmarks/stage5_vexp_swe_bench_smoke/results";
export const INSTANCE_ID = "matplotlib__matplotlib-22719";
export const DEFAULT_OLD_LABEL = "eval-controlled-vtrace-matplotlib-22719";
export const DEFAULT_NEW_LABEL = "eval-riskgated-vtrace-matplotlib-22719";
export const DEFAULT_OUT_NAME = "stage5_riskgated_matplotlib_comparison";

// The three required interpretation statements, verbatim. They are emitted by the report and
// are also asserted by the tests so the causal framing cannot silently drift.
export const CAUSAL_NON_CLAIM =
  "This comparison does NOT prove that risk_gated reduced tokens by suppressing PIVOT_CHECK, " +
  "because the new risk_gated run still injected PIVOT_CHECK due to hidden_pivot.";

export const RESOLVED_AND_FEWER_CALLS_CLAIM =
  "The new run resolved the previous matplotlib loss and used far fewer ordered tool calls " +
  "than the old controlled VTRACE run.";

export const LIKELY_CAUSE_CLAIM =
  "The likely improvement is reduced agent/tool-loop behavior, not smaller initial context. " +
  "The exact cause is not proven from one rerun.";

export const RECOMMENDATION = {
  next:
    "Run a small 3-task risk_gated verification set, not the full 10-task set yet.",
  candidates: [
    {
      instanceId: "matplotlib__matplotlib-22719",
      reason: "confirmed improvement/resolution; rerun already available",
    },
    {
      instanceId: "astropy__astropy-14369",
      reason: "context_too_large + retrieval_noise case",
    },
    {
      instanceId: "psf__requests-5414",
      reason: "low-cost Requests case where repair later helped",
    },
  ],
  avoid: "Do not recommend more duplicate repair experiments.",
} as const;

export const NON_CLAIMS: readonly string[] = [
  CAUSAL_NON_CLAIM,
  "This is a single rerun (n=1), not a statistical benchmark; no significance is claimed.",
  "It does not isolate which factor (tool-loop behavior, stochasticity, sampling) drove the token drop.",
  "It does not change retrieval, Capsule v2, PIVOT_CHECK, EDIT_GUARD, PATCH_VERIFY, probes, critic, repair, the evaluator, or policy behavior.",
  "It does not rerun agents or Docker; usage/cost/resolution are read verbatim from the existing run + docker-eval artifacts.",
];

// ---------------------------------------------------------------------------
// Pure value coercion helpers
// ---------------------------------------------------------------------------

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.map(asString).filter((s): s is string => s !== null);
  return out;
}

// Sum the four token components from the JSONL row. null only when every component is absent,
// so a run that genuinely logged 0 of a component still totals correctly.
export function tokenTotalOf(record: Record<string, unknown> | null): number | null {
  if (record === null) return null;
  const parts = [
    record.inputTokens,
    record.outputTokens,
    record.cacheReadTokens,
    record.cacheCreationTokens,
  ]
    .map(asNumber)
    .filter((n): n is number => n !== null);
  return parts.length === 0 ? null : parts.reduce((a, b) => a + b, 0);
}

// SHA-256 of the model patch — a stable fingerprint so two runs' patches can be compared for
// identity without inlining the whole diff. Empty patch hashes the empty string (recorded as
// null at the report level so "no patch" is not confused with a real hash).
export function patchHash(patch: string): string | null {
  if (patch.trim().length === 0) return null;
  return createHash("sha256").update(patch).digest("hex");
}

// Added (`+`) / removed (`-`) lines of a unified diff, excluding the file headers.
function addedLines(patch: string): string[] {
  return patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
}
function removedLines(patch: string): string[] {
  return patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
}

// A short mechanical patch summary: edited files + added/removed line counts. Purely derived
// from the diff — no interpretation, so it never overstates what the patch does.
export function patchSummary(patch: string, editedFiles: readonly string[]): string {
  if (patch.trim().length === 0) return "no patch produced";
  const adds = addedLines(patch).length;
  const dels = removedLines(patch).length;
  const files = editedFiles.length > 0 ? editedFiles.join(", ") : "unknown file";
  return `${files}: +${adds}/-${dels} lines`;
}

// Strip the `.bench-repos/<repo>/` prefix so tool-call paths read as repo-relative.
function relPath(p: string): string {
  const marker = ".bench-repos/";
  const idx = p.indexOf(marker);
  if (idx < 0) return p;
  const after = p.slice(idx + marker.length);
  const slash = after.indexOf("/");
  return slash >= 0 ? after.slice(slash + 1) : after;
}

// ---------------------------------------------------------------------------
// Raw run parts → RunUsage (pure)
// ---------------------------------------------------------------------------

export interface RawToolCall {
  readonly category: string | null;
  readonly path: string | null;
}

export interface RawRunParts {
  readonly runLabel: string;
  readonly meta: Record<string, unknown> | null; // _run.meta.json (policy/context only)
  readonly evalMeta: Record<string, unknown> | null; // _eval.meta.json (docker result)
  readonly record: Record<string, unknown> | null; // first swebench jsonl row (usage/cost)
  readonly toolCalls: readonly RawToolCall[] | null; // _tool_calls.json (ordered, null = absent)
}

// Every required comparison field for one run, each sourced from its authoritative file.
export interface RunUsage {
  readonly runLabel: string;
  readonly instanceId: string | null;
  // --- from the SWE-bench JSONL row ---
  readonly resolved: boolean | null;
  readonly costUsd: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly totalTokens: number | null;
  readonly numTurns: number | null;
  readonly toolCallsByType: Record<string, number> | null;
  readonly modelPatchHash: string | null;
  readonly modelPatchSummary: string;
  // --- ordered tool log (_tool_calls.json), falling back to meta count ---
  readonly orderedToolCallCount: number | null;
  readonly uniqueFilesRead: number | null;
  readonly uniqueFilesEdited: number | null;
  // --- from _run.meta.json (policy/context only) ---
  readonly vtraceCapsuleEstimatedTokens: number | null;
  readonly vtraceContextChars: number | null;
  readonly vtracePivotCheckPolicy: string | null;
  readonly vtracePivotCheckPolicyReason: string | null;
  readonly vtracePivotCheckRiskSignals: readonly string[] | null;
  readonly vtracePivotCheckWouldInjectUnderMultiPivot: boolean | null;
  readonly vtracePivotCheckInjected: boolean | null;
  readonly vtraceEditGuardInjected: boolean | null;
  readonly vtracePatchVerifyInjected: boolean | null;
}

// Docker evaluation facts, kept separate from RunUsage since they come from _eval.meta.json
// and only back the "Evaluation result" section (resolution itself is read from the JSONL row).
export interface RunEvaluation {
  readonly evaluationRan: boolean | null;
  readonly dockerUsed: boolean | null;
  readonly resolvedCount: number | null;
  readonly evaluationError: string | null;
}

function toolCallsByType(record: Record<string, unknown> | null): Record<string, number> | null {
  if (record === null || !isRecord(record.toolCalls)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(record.toolCalls)) {
    const n = asNumber(v);
    if (n !== null) out[k] = n;
  }
  return Object.keys(out).length === 0 ? null : out;
}

// Ordered tool-call count: prefer the actual ordered log length (_tool_calls.json), which is
// the ground truth the report is meant to count; fall back to the meta's cached count; null if
// neither is present. The two can differ slightly (the log is the authoritative ordered trace).
export function orderedToolCallCountOf(
  toolCalls: readonly RawToolCall[] | null,
  meta: Record<string, unknown> | null,
): number | null {
  if (toolCalls !== null) return toolCalls.length;
  return asNumber(meta?.vtraceToolCallCount);
}

function uniqueFilesByCategory(
  toolCalls: readonly RawToolCall[] | null,
  category: "read" | "edit",
): number | null {
  if (toolCalls === null) return null;
  const paths = toolCalls
    .filter((t) => t.category === category && t.path)
    .map((t) => relPath(t.path!));
  return uniq(paths).length;
}

export function buildRunUsage(parts: RawRunParts): RunUsage {
  const { meta, record, toolCalls } = parts;
  const modelPatch = asString(record?.modelPatch) ?? "";
  const editedFiles = uniq(editedFilesFromPatch(modelPatch));

  return {
    runLabel: parts.runLabel,
    instanceId: asString(record?.instanceId),
    // usage / cost / resolution — JSONL row ONLY
    resolved: asBool(record?.resolved),
    costUsd: asNumber(record?.costUsd),
    inputTokens: asNumber(record?.inputTokens),
    outputTokens: asNumber(record?.outputTokens),
    cacheReadTokens: asNumber(record?.cacheReadTokens),
    cacheCreationTokens: asNumber(record?.cacheCreationTokens),
    totalTokens: tokenTotalOf(record),
    numTurns: asNumber(record?.numTurns),
    toolCallsByType: toolCallsByType(record),
    modelPatchHash: patchHash(modelPatch),
    modelPatchSummary: patchSummary(modelPatch, editedFiles),
    // ordered tool log
    orderedToolCallCount: orderedToolCallCountOf(toolCalls, meta),
    uniqueFilesRead: uniqueFilesByCategory(toolCalls, "read"),
    uniqueFilesEdited: uniqueFilesByCategory(toolCalls, "edit"),
    // policy / context — _run.meta.json ONLY
    vtraceCapsuleEstimatedTokens: asNumber(meta?.vtraceCapsuleEstimatedTokens),
    vtraceContextChars: asNumber(meta?.vtraceContextChars),
    vtracePivotCheckPolicy: asString(meta?.vtracePivotCheckPolicy),
    vtracePivotCheckPolicyReason: asString(meta?.vtracePivotCheckPolicyReason),
    vtracePivotCheckRiskSignals: asStringArray(meta?.vtracePivotCheckRiskSignals),
    vtracePivotCheckWouldInjectUnderMultiPivot: asBool(meta?.vtracePivotCheckWouldInjectUnderMultiPivot),
    vtracePivotCheckInjected: asBool(meta?.vtracePivotCheckInjected),
    vtraceEditGuardInjected: asBool(meta?.vtraceEditGuardInjected),
    vtracePatchVerifyInjected: asBool(meta?.vtracePatchVerifyInjected),
  };
}

export function buildRunEvaluation(evalMeta: Record<string, unknown> | null): RunEvaluation {
  return {
    evaluationRan: asBool(evalMeta?.evaluationRan),
    dockerUsed: asBool(evalMeta?.dockerUsed),
    resolvedCount: asNumber(evalMeta?.resolvedCount),
    evaluationError: asString(evalMeta?.evaluationError),
  };
}

// ---------------------------------------------------------------------------
// Deltas (pure)
// ---------------------------------------------------------------------------

export interface ComparisonDeltas {
  readonly tokenDelta: number | null;
  readonly tokenDeltaPct: number | null;
  readonly costDelta: number | null;
  readonly costDeltaPct: number | null;
  readonly orderedToolCallDelta: number | null;
  readonly resolvedChanged: boolean | null;
}

function pairDelta(before: number | null, after: number | null): number | null {
  return before !== null && after !== null ? delta(before, after) : null;
}
function pairDeltaPct(before: number | null, after: number | null): number | null {
  return before !== null && after !== null ? deltaPct(before, after) : null;
}

export function buildDeltas(oldRun: RunUsage, newRun: RunUsage): ComparisonDeltas {
  const resolvedChanged =
    oldRun.resolved !== null && newRun.resolved !== null ? oldRun.resolved !== newRun.resolved : null;
  return {
    tokenDelta: pairDelta(oldRun.totalTokens, newRun.totalTokens),
    tokenDeltaPct: pairDeltaPct(oldRun.totalTokens, newRun.totalTokens),
    costDelta: pairDelta(oldRun.costUsd, newRun.costUsd),
    costDeltaPct: pairDeltaPct(oldRun.costUsd, newRun.costUsd),
    orderedToolCallDelta: pairDelta(oldRun.orderedToolCallCount, newRun.orderedToolCallCount),
    resolvedChanged,
  };
}

// ---------------------------------------------------------------------------
// Pivot-check causal decision (pure)
// ---------------------------------------------------------------------------

export interface PivotCheckDecision {
  readonly policy: string | null;
  readonly policyReason: string | null;
  readonly riskSignals: readonly string[] | null;
  readonly wouldInjectUnderMultiPivot: boolean | null;
  readonly injected: boolean | null;
  // True ONLY if the new run actually suppressed PIVOT_CHECK (did not inject it). When false,
  // any "risk_gated saved tokens by suppressing PIVOT_CHECK" claim is unsupported.
  readonly suppressionClaimable: boolean;
  readonly causalNonClaim: string;
}

// The core causal-inference rule of this report. risk_gated CAN reduce tokens by suppressing
// PIVOT_CHECK in general — but only when it actually withholds the checklist. Here the new run
// still injected PIVOT_CHECK (risk signal hidden_pivot forced it on), so the suppression
// pathway never fired and cannot explain the token drop. Suppression is claimable only when
// injection is explicitly false.
export function buildPivotCheckDecision(newRun: RunUsage): PivotCheckDecision {
  const suppressionClaimable = newRun.vtracePivotCheckInjected === false;
  return {
    policy: newRun.vtracePivotCheckPolicy,
    policyReason: newRun.vtracePivotCheckPolicyReason,
    riskSignals: newRun.vtracePivotCheckRiskSignals,
    wouldInjectUnderMultiPivot: newRun.vtracePivotCheckWouldInjectUnderMultiPivot,
    injected: newRun.vtracePivotCheckInjected,
    suppressionClaimable,
    causalNonClaim: CAUSAL_NON_CLAIM,
  };
}

// ---------------------------------------------------------------------------
// Report assembly (pure)
// ---------------------------------------------------------------------------

export interface ComparisonReport {
  readonly generatedAt: string | null;
  readonly instanceId: string;
  readonly oldRun: RunUsage;
  readonly newRun: RunUsage;
  readonly oldEvaluation: RunEvaluation;
  readonly newEvaluation: RunEvaluation;
  readonly deltas: ComparisonDeltas;
  readonly pivotCheckDecision: PivotCheckDecision;
  readonly interpretation: readonly string[];
  readonly recommendation: typeof RECOMMENDATION;
  readonly nonClaims: readonly string[];
}

export function buildReport(
  generatedAt: string | null,
  oldParts: RawRunParts,
  newParts: RawRunParts,
): ComparisonReport {
  const oldRun = buildRunUsage(oldParts);
  const newRun = buildRunUsage(newParts);
  return {
    generatedAt,
    instanceId: INSTANCE_ID,
    oldRun,
    newRun,
    oldEvaluation: buildRunEvaluation(oldParts.evalMeta),
    newEvaluation: buildRunEvaluation(newParts.evalMeta),
    deltas: buildDeltas(oldRun, newRun),
    pivotCheckDecision: buildPivotCheckDecision(newRun),
    interpretation: [CAUSAL_NON_CLAIM, RESOLVED_AND_FEWER_CALLS_CLAIM, LIKELY_CAUSE_CLAIM],
    recommendation: RECOMMENDATION,
    nonClaims: NON_CLAIMS,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderJson(report: ComparisonReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function fmtInt(n: number | null): string {
  return n === null ? "n/a" : Math.round(n).toLocaleString("en-US");
}
function fmtCost(n: number | null): string {
  return n === null ? "n/a" : `$${n.toFixed(4)}`;
}
function fmtPct(n: number | null): string {
  return n === null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}
function fmtSignedInt(n: number | null): string {
  return n === null ? "n/a" : `${n >= 0 ? "+" : ""}${Math.round(n).toLocaleString("en-US")}`;
}
function fmtBool(b: boolean | null): string {
  return b === null ? "unknown" : b ? "yes" : "no";
}
function fmtStr(s: string | null): string {
  return s === null ? "n/a" : s;
}
function fmtSignals(s: readonly string[] | null): string {
  return s === null ? "n/a" : s.length === 0 ? "[]" : `[${s.join(", ")}]`;
}
function fmtToolByType(t: Record<string, number> | null): string {
  if (t === null) return "n/a";
  const entries = Object.entries(t);
  return entries.length === 0 ? "{}" : entries.map(([k, v]) => `${k}:${v}`).join(", ");
}
function fmtHash(h: string | null): string {
  return h === null ? "n/a" : `\`${h.slice(0, 12)}…\``;
}

export function renderMarkdown(report: ComparisonReport): string {
  const { oldRun, newRun, deltas, pivotCheckDecision: pc } = report;
  const lines: string[] = [];

  lines.push("# Stage 5 risk-gated matplotlib comparison");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");
  lines.push(
    "_Reporting / accounting only. No agents, no live critic, no repair, no Docker. Usage / cost / " +
      "resolution are read from the SWE-bench JSONL row; VTRACE policy / context metadata is read from " +
      "`_run.meta.json`. Token and cost numbers are never sourced from `_run.meta.json`. No retrieval / " +
      "Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair / evaluator / policy " +
      "behavior is changed, and no raw artifact is mutated._",
  );
  lines.push("");

  // --- Summary -------------------------------------------------------------
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `Instance \`${report.instanceId}\` was rerun under the risk_gated pivot-check policy ` +
      `(\`${newRun.runLabel}\`) and compared to the prior controlled VTRACE run (\`${oldRun.runLabel}\`).`,
  );
  lines.push("");
  lines.push(
    `Tokens ${fmtInt(oldRun.totalTokens)} → ${fmtInt(newRun.totalTokens)} ` +
      `(${fmtSignedInt(deltas.tokenDelta)}, ${fmtPct(deltas.tokenDeltaPct)}). ` +
      `Cost ${fmtCost(oldRun.costUsd)} → ${fmtCost(newRun.costUsd)} ` +
      `(${fmtCost(deltas.costDelta)}, ${fmtPct(deltas.costDeltaPct)}). ` +
      `Ordered tool calls ${fmtInt(oldRun.orderedToolCallCount)} → ${fmtInt(newRun.orderedToolCallCount)} ` +
      `(${fmtSignedInt(deltas.orderedToolCallDelta)}).`,
  );
  lines.push("");
  lines.push(
    `Resolution ${fmtBool(oldRun.resolved)} → ${fmtBool(newRun.resolved)} ` +
      `(changed: ${deltas.resolvedChanged === null ? "unknown" : deltas.resolvedChanged ? "yes" : "no"}). ` +
      RESOLVED_AND_FEWER_CALLS_CLAIM,
  );
  lines.push("");

  // --- Old vs new usage ----------------------------------------------------
  lines.push("## Old vs new usage");
  lines.push("");
  lines.push("| field | old | new | Δ |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(`| runLabel | \`${oldRun.runLabel}\` | \`${newRun.runLabel}\` | — |`);
  lines.push(`| instanceId | ${fmtStr(oldRun.instanceId)} | ${fmtStr(newRun.instanceId)} | — |`);
  lines.push(`| resolved | ${fmtBool(oldRun.resolved)} | ${fmtBool(newRun.resolved)} | ${deltas.resolvedChanged === null ? "unknown" : deltas.resolvedChanged ? "changed" : "same"} |`);
  lines.push(`| costUsd | ${fmtCost(oldRun.costUsd)} | ${fmtCost(newRun.costUsd)} | ${fmtCost(deltas.costDelta)} (${fmtPct(deltas.costDeltaPct)}) |`);
  lines.push(`| inputTokens | ${fmtInt(oldRun.inputTokens)} | ${fmtInt(newRun.inputTokens)} | ${fmtSignedInt(pairDelta(oldRun.inputTokens, newRun.inputTokens))} |`);
  lines.push(`| outputTokens | ${fmtInt(oldRun.outputTokens)} | ${fmtInt(newRun.outputTokens)} | ${fmtSignedInt(pairDelta(oldRun.outputTokens, newRun.outputTokens))} |`);
  lines.push(`| cacheReadTokens | ${fmtInt(oldRun.cacheReadTokens)} | ${fmtInt(newRun.cacheReadTokens)} | ${fmtSignedInt(pairDelta(oldRun.cacheReadTokens, newRun.cacheReadTokens))} |`);
  lines.push(`| cacheCreationTokens | ${fmtInt(oldRun.cacheCreationTokens)} | ${fmtInt(newRun.cacheCreationTokens)} | ${fmtSignedInt(pairDelta(oldRun.cacheCreationTokens, newRun.cacheCreationTokens))} |`);
  lines.push(`| totalTokens | ${fmtInt(oldRun.totalTokens)} | ${fmtInt(newRun.totalTokens)} | ${fmtSignedInt(deltas.tokenDelta)} (${fmtPct(deltas.tokenDeltaPct)}) |`);
  lines.push(`| numTurns | ${fmtInt(oldRun.numTurns)} | ${fmtInt(newRun.numTurns)} | ${fmtSignedInt(pairDelta(oldRun.numTurns, newRun.numTurns))} |`);
  lines.push(`| vtraceCapsuleEstimatedTokens | ${fmtInt(oldRun.vtraceCapsuleEstimatedTokens)} | ${fmtInt(newRun.vtraceCapsuleEstimatedTokens)} | ${fmtSignedInt(pairDelta(oldRun.vtraceCapsuleEstimatedTokens, newRun.vtraceCapsuleEstimatedTokens))} |`);
  lines.push(`| vtraceContextChars | ${fmtInt(oldRun.vtraceContextChars)} | ${fmtInt(newRun.vtraceContextChars)} | ${fmtSignedInt(pairDelta(oldRun.vtraceContextChars, newRun.vtraceContextChars))} |`);
  lines.push("");
  lines.push(
    "Token and cost figures above come from the SWE-bench JSONL row (real model spend). " +
      "`vtraceCapsuleEstimatedTokens` and `vtraceContextChars` are the much smaller injected-context " +
      "figures from `_run.meta.json` and are NOT the model spend — they are shown only to confirm the " +
      "initial context size was essentially unchanged between runs.",
  );
  lines.push("");

  // --- Pivot-check policy decision -----------------------------------------
  lines.push("## Pivot-check policy decision");
  lines.push("");
  lines.push("| field | value |");
  lines.push("| --- | --- |");
  lines.push(`| vtracePivotCheckPolicy | ${fmtStr(pc.policy)} |`);
  lines.push(`| vtracePivotCheckPolicyReason | ${fmtStr(pc.policyReason)} |`);
  lines.push(`| vtracePivotCheckRiskSignals | ${fmtSignals(pc.riskSignals)} |`);
  lines.push(`| vtracePivotCheckWouldInjectUnderMultiPivot | ${fmtBool(pc.wouldInjectUnderMultiPivot)} |`);
  lines.push(`| vtracePivotCheckInjected | ${fmtBool(pc.injected)} |`);
  lines.push(`| vtraceEditGuardInjected | ${fmtBool(newRun.vtraceEditGuardInjected)} |`);
  lines.push(`| vtracePatchVerifyInjected | ${fmtBool(newRun.vtracePatchVerifyInjected)} |`);
  lines.push(`| suppressionClaimable | ${pc.suppressionClaimable ? "yes" : "no"} |`);
  lines.push("");
  lines.push(
    `Under \`risk_gated\`, the new run detected risk signals ${fmtSignals(pc.riskSignals)} and therefore ` +
      `STILL injected PIVOT_CHECK (\`vtracePivotCheckInjected = ${fmtBool(pc.injected)}\`). The suppression ` +
      "pathway never fired, so PIVOT_CHECK suppression cannot be the cause of the token reduction.",
  );
  lines.push("");
  lines.push(`> ${CAUSAL_NON_CLAIM}`);
  lines.push("");

  // --- Tool-call comparison ------------------------------------------------
  lines.push("## Tool-call comparison");
  lines.push("");
  lines.push("| field | old | new | Δ |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(`| orderedToolCallCount | ${fmtInt(oldRun.orderedToolCallCount)} | ${fmtInt(newRun.orderedToolCallCount)} | ${fmtSignedInt(deltas.orderedToolCallDelta)} |`);
  lines.push(`| toolCallsByType | ${fmtToolByType(oldRun.toolCallsByType)} | ${fmtToolByType(newRun.toolCallsByType)} | — |`);
  lines.push(`| uniqueFilesRead | ${fmtInt(oldRun.uniqueFilesRead)} | ${fmtInt(newRun.uniqueFilesRead)} | ${fmtSignedInt(pairDelta(oldRun.uniqueFilesRead, newRun.uniqueFilesRead))} |`);
  lines.push(`| uniqueFilesEdited | ${fmtInt(oldRun.uniqueFilesEdited)} | ${fmtInt(newRun.uniqueFilesEdited)} | ${fmtSignedInt(pairDelta(oldRun.uniqueFilesEdited, newRun.uniqueFilesEdited))} |`);
  lines.push("");
  lines.push(
    "`orderedToolCallCount` is taken from the ordered `_tool_calls.json` log when present (falling back to " +
      "`vtraceToolCallCount` in `_run.meta.json`). The drop in ordered tool calls is the clearest " +
      "behavioral difference between the two runs.",
  );
  lines.push("");

  // --- Patch comparison ----------------------------------------------------
  lines.push("## Patch comparison");
  lines.push("");
  lines.push("| field | old | new |");
  lines.push("| --- | --- | --- |");
  lines.push(`| modelPatchHash | ${fmtHash(oldRun.modelPatchHash)} | ${fmtHash(newRun.modelPatchHash)} |`);
  lines.push(`| modelPatchSummary | ${oldRun.modelPatchSummary} | ${newRun.modelPatchSummary} |`);
  lines.push("");
  lines.push(
    `The patches differ (${oldRun.modelPatchHash === newRun.modelPatchHash ? "identical hash" : "distinct hashes"}). ` +
      "The old run narrowed the deprecation-warning guard; the new run added an explicit empty-array early " +
      "return. The new patch is the one that passed Docker evaluation.",
  );
  lines.push("");

  // --- Evaluation result ---------------------------------------------------
  lines.push("## Evaluation result");
  lines.push("");
  lines.push("| field | old | new |");
  lines.push("| --- | --- | --- |");
  lines.push(`| resolved (JSONL row) | ${fmtBool(oldRun.resolved)} | ${fmtBool(newRun.resolved)} |`);
  lines.push(`| evaluationRan | ${fmtBool(report.oldEvaluation.evaluationRan)} | ${fmtBool(report.newEvaluation.evaluationRan)} |`);
  lines.push(`| dockerUsed | ${fmtBool(report.oldEvaluation.dockerUsed)} | ${fmtBool(report.newEvaluation.dockerUsed)} |`);
  lines.push(`| resolvedCount | ${fmtInt(report.oldEvaluation.resolvedCount)} | ${fmtInt(report.newEvaluation.resolvedCount)} |`);
  lines.push(`| evaluationError | ${fmtStr(report.oldEvaluation.evaluationError)} | ${fmtStr(report.newEvaluation.evaluationError)} |`);
  lines.push("");
  lines.push(
    "The new risk_gated rerun was Docker-evaluated and resolved the instance, recovering the previous " +
      "matplotlib loss. Resolution is read verbatim from the existing JSONL row and `_eval.meta.json`; " +
      "nothing was re-evaluated here.",
  );
  lines.push("");

  // --- Interpretation ------------------------------------------------------
  lines.push("## Interpretation");
  lines.push("");
  for (const claim of report.interpretation) lines.push(`- ${claim}`);
  lines.push("");

  // --- Recommended next step -----------------------------------------------
  lines.push("## Recommended next step");
  lines.push("");
  lines.push(`**${report.recommendation.next}**`);
  lines.push("");
  lines.push("Suggested candidates:");
  lines.push("");
  for (const c of report.recommendation.candidates) {
    lines.push(`- \`${c.instanceId}\` — ${c.reason}.`);
  }
  lines.push("");
  lines.push(report.recommendation.avoid);
  lines.push("");

  // --- Non-claims ----------------------------------------------------------
  lines.push("## Non-claims");
  lines.push("");
  for (const claim of report.nonClaims) lines.push(`- ${claim}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Loading (impure)
// ---------------------------------------------------------------------------

async function readJsonFile(p: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(p, "utf8");
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Read the first JSON record from a swebench-*.jsonl file in a run's vtrace dir.
async function readSwebenchRecord(vtraceDir: string): Promise<Record<string, unknown> | null> {
  let entries: string[];
  try {
    entries = await readdir(vtraceDir);
  } catch {
    return null;
  }
  const jsonl = entries.find((e) => e.startsWith("swebench-") && e.endsWith(".jsonl"));
  if (!jsonl) return null;
  try {
    const text = await readFile(path.join(vtraceDir, jsonl), "utf8");
    const firstLine = text.split("\n").find((l) => l.trim().length > 0);
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readToolCalls(vtraceDir: string): Promise<RawToolCall[] | null> {
  try {
    const text = await readFile(path.join(vtraceDir, "_tool_calls.json"), "utf8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(isRecord).map((t) => ({
      category: asString(t.category),
      path: asString(t.path),
    }));
  } catch {
    return null;
  }
}

export async function loadRun(resultsDir: string, runLabel: string): Promise<RawRunParts> {
  const vtraceDir = path.join(resultsDir, "runs", runLabel, "raw", "vtrace");
  const [meta, evalMeta, record, toolCalls] = await Promise.all([
    readJsonFile(path.join(vtraceDir, "_run.meta.json")),
    readJsonFile(path.join(vtraceDir, "_eval.meta.json")),
    readSwebenchRecord(vtraceDir),
    readToolCalls(vtraceDir),
  ]);
  return { runLabel, meta, evalMeta, record, toolCalls };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly oldLabel: string;
  readonly newLabel: string;
  readonly outName: string;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let oldLabel = DEFAULT_OLD_LABEL;
  let newLabel = DEFAULT_NEW_LABEL;
  let outName = DEFAULT_OUT_NAME;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`Missing value for ${arg}.`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "--results":
        resultsDir = next();
        break;
      case "--old-label":
        oldLabel = next();
        break;
      case "--new-label":
        newLabel = next();
        break;
      case "--out-name":
        outName = next();
        break;
      case "--help":
      case "-h":
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { resultsDir, oldLabel, newLabel, outName };
}

async function main(config: CliConfig): Promise<void> {
  const generatedAt = new Date().toISOString();

  const [oldParts, newParts] = await Promise.all([
    loadRun(config.resultsDir, config.oldLabel),
    loadRun(config.resultsDir, config.newLabel),
  ]);

  const report = buildReport(generatedAt, oldParts, newParts);

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  const { oldRun, newRun, deltas, pivotCheckDecision: pc } = report;
  process.stdout.write(
    [
      "Stage 5 risk-gated matplotlib comparison written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Tokens: ${fmtInt(oldRun.totalTokens)} → ${fmtInt(newRun.totalTokens)} (${fmtSignedInt(deltas.tokenDelta)}, ${fmtPct(deltas.tokenDeltaPct)})`,
      `Cost: ${fmtCost(oldRun.costUsd)} → ${fmtCost(newRun.costUsd)} (${fmtCost(deltas.costDelta)}, ${fmtPct(deltas.costDeltaPct)})`,
      `Ordered tool calls: ${fmtInt(oldRun.orderedToolCallCount)} → ${fmtInt(newRun.orderedToolCallCount)} (${fmtSignedInt(deltas.orderedToolCallDelta)})`,
      `Resolved: ${fmtBool(oldRun.resolved)} → ${fmtBool(newRun.resolved)}`,
      `PIVOT_CHECK injected (new): ${fmtBool(pc.injected)}   suppression claimable: ${pc.suppressionClaimable ? "yes" : "no"}`,
      "",
    ].join("\n"),
  );
}

if (import.meta.main) {
  try {
    await main(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
