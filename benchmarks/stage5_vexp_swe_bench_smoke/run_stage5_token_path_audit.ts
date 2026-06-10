// Stage 5 TOKEN-PATH AUDIT (why VTRACE first-pass runs spend more tokens than
// baseline, and where to reduce them). READ-ONLY.
//
// SCOPE: reporting/accounting only. This runner reads the already-generated
// controlled-task plan, the outcome ledger, the policy accounting, and per-run raw
// artifacts (_run.meta.json / _tool_calls.json) where they exist, and explains the
// per-task baseline-vs-VTRACE token/cost deltas with deterministic, evidence-based
// classifications.
//
// It RE-RUNS nothing: no agent, no live critic, no repair, no Docker. It mutates no
// raw artifact and changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD /
// PATCH_VERIFY / probe / critic / repair / evaluator / policy behavior.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { RESULTS_REL } from "./run_stage5_patch_probe_report";

export const DEFAULT_OUT_NAME = "stage5_token_path_audit";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly outName: string;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
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
  return { resultsDir, outName };
}

// ---------------------------------------------------------------------------
// Input model
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

export interface TokenBreakdown {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheCreation: number | null;
  readonly total: number | null;
}

const EMPTY_TOKENS: TokenBreakdown = { input: null, output: null, cacheRead: null, cacheCreation: null, total: null };

// One side (baseline or vtrace) of a controlled pair, as recorded in the outcome
// ledger. Every field may be genuinely absent (null) — nothing is invented.
export interface LedgerRun {
  readonly runLabel: string;
  readonly condition: string;
  readonly instanceId: string;
  readonly resolved: boolean | null;
  readonly costUsd: number | null;
  readonly tokens: TokenBreakdown;
  readonly toolLogOrdered: boolean;
  readonly toolCallCount: number | null;
  readonly editedFiles: readonly string[];
  readonly pivotCount: number | null;
  readonly hiddenPivotsInspected: number | null;
  readonly pivotCheckInjected: boolean | null;
  readonly editGuardInjected: boolean | null;
  readonly patchVerifyInjected: boolean | null;
}

export function parseLedgerRun(raw: Record<string, unknown>): LedgerRun {
  const tokens = (raw.tokens ?? {}) as Record<string, unknown>;
  return {
    runLabel: asStr(raw.runLabel) ?? "unknown",
    condition: asStr(raw.condition) ?? "unknown",
    instanceId: asStr(raw.instanceId) ?? "unknown",
    resolved: asBool(raw.resolved),
    costUsd: asNum(raw.cost),
    tokens: {
      input: asNum(tokens.input),
      output: asNum(tokens.output),
      cacheRead: asNum(tokens.cacheRead),
      cacheCreation: asNum(tokens.cacheCreation),
      total: asNum(tokens.total),
    },
    toolLogOrdered: asBool(raw.toolLogOrdered) === true,
    toolCallCount: asNum(raw.toolCallCount),
    editedFiles: Array.isArray(raw.editedFiles) ? raw.editedFiles.filter((f): f is string => typeof f === "string") : [],
    pivotCount: asNum(raw.pivotCount),
    hiddenPivotsInspected: asNum(raw.hiddenPivotsInspected),
    pivotCheckInjected: asBool(raw.pivotCheckInjected),
    editGuardInjected: asBool(raw.editGuardInjected),
    patchVerifyInjected: asBool(raw.patchVerifyInjected),
  };
}

// One entry of a per-run _tool_calls.json ordered tool log.
export interface RawToolCall {
  readonly tool?: string;
  readonly category?: string;
  readonly path?: string | null;
}

export interface ToolCallStats {
  readonly toolCallCount: number;
  readonly readCallCount: number;
  readonly grepCallCount: number;
  readonly searchCallCount: number;
  readonly editCallCount: number;
  readonly bashCallCount: number;
  readonly uniqueFilesRead: number;
  readonly uniqueFilesEdited: number;
  // Read/Grep calls beyond the first against the same path — the repeat-visit signal.
  readonly repeatedReadOrSearchCalls: number;
  readonly readOrSearchPaths: readonly string[];
}

export function computeToolCallStats(calls: readonly RawToolCall[]): ToolCallStats {
  const readOrSearchVisits = new Map<string, number>();
  const editedPaths = new Set<string>();
  let readCallCount = 0;
  let grepCallCount = 0;
  let searchCallCount = 0;
  let editCallCount = 0;
  let bashCallCount = 0;
  for (const c of calls) {
    const category = c.category ?? "other";
    if (category === "read") readCallCount += 1;
    if (category === "search") searchCallCount += 1;
    if (category === "edit") editCallCount += 1;
    if (c.tool === "Grep") grepCallCount += 1;
    if (c.tool === "Bash") bashCallCount += 1;
    if ((category === "read" || category === "search") && typeof c.path === "string" && c.path.length > 0) {
      readOrSearchVisits.set(c.path, (readOrSearchVisits.get(c.path) ?? 0) + 1);
    }
    if (category === "edit" && typeof c.path === "string" && c.path.length > 0) editedPaths.add(c.path);
  }
  let uniqueFilesRead = 0;
  let repeatedReadOrSearchCalls = 0;
  for (const n of readOrSearchVisits.values()) {
    uniqueFilesRead += 1;
    if (n > 1) repeatedReadOrSearchCalls += n - 1;
  }
  return {
    toolCallCount: calls.length,
    readCallCount,
    grepCallCount,
    searchCallCount,
    editCallCount,
    bashCallCount,
    uniqueFilesRead,
    uniqueFilesEdited: editedPaths.size,
    repeatedReadOrSearchCalls,
    readOrSearchPaths: [...readOrSearchVisits.keys()],
  };
}

// Capsule/context metadata from a per-run _run.meta.json (all optional).
export interface RunMetaInfo {
  readonly contextChars: number | null;
  readonly capsuleEstimatedTokens: number | null;
  readonly capsulePivotPaths: readonly string[];
  readonly pivotCheckInjected: boolean | null;
  // Deterministic PIVOT_CHECK policy state (tolerant; null on pre-policy runs). Lets
  // the audit tell "absent because disabled / risk_gated declined" apart from
  // "injected", and see whether the old >= 2-pivot behaviour would have injected.
  readonly pivotCheckPolicy: string | null;
  readonly pivotCheckWouldInjectUnderMultiPivot: boolean | null;
}

export function parseRunMeta(raw: Record<string, unknown> | null): RunMetaInfo {
  if (raw === null) return { contextChars: null, capsuleEstimatedTokens: null, capsulePivotPaths: [], pivotCheckInjected: null, pivotCheckPolicy: null, pivotCheckWouldInjectUnderMultiPivot: null };
  const pivots = Array.isArray(raw.vtraceCapsulePivots) ? raw.vtraceCapsulePivots : [];
  const capsulePivotPaths = pivots
    .map((p) => (p && typeof p === "object" ? asStr((p as Record<string, unknown>).path) : null))
    .filter((p): p is string => p !== null);
  return {
    contextChars: asNum(raw.vtraceContextChars),
    capsuleEstimatedTokens: asNum(raw.vtraceCapsuleEstimatedTokens),
    capsulePivotPaths,
    pivotCheckInjected: asBool(raw.vtracePivotCheckInjected),
    pivotCheckPolicy: asStr(raw.vtracePivotCheckPolicy),
    pivotCheckWouldInjectUnderMultiPivot: asBool(raw.vtracePivotCheckWouldInjectUnderMultiPivot),
  };
}

// Surfaced capsule pivots the agent actually visited (read or searched). Tool-call
// paths are absolute workspace paths; pivot paths are repo-relative, so match by suffix.
export function countPivotsInspected(pivotPaths: readonly string[], readOrSearchPaths: readonly string[]): number {
  let inspected = 0;
  for (const pivot of pivotPaths) {
    if (readOrSearchPaths.some((p) => p === pivot || p.endsWith(`/${pivot}`))) inspected += 1;
  }
  return inspected;
}

// ---------------------------------------------------------------------------
// Per-task audit row
// ---------------------------------------------------------------------------

export type OverheadCategory =
  | "context_too_large"
  | "agent_oversearched"
  | "pivot_check_overhead"
  | "prompt_overhead"
  | "tool_loop_overhead"
  | "retrieval_noise"
  | "cache_accounting_artifact"
  | "necessary_complexity"
  | "unknown";

// All token/tool/pivot single-value fields describe the VTRACE run (the audit
// subject); baseline counterparts carry an explicit baseline* prefix.
export interface TaskAudit {
  readonly instanceId: string;
  readonly baselineRunLabel: string | null;
  readonly vtraceRunLabel: string | null;

  readonly baselineTotalTokens: number | null;
  readonly vtraceTotalTokens: number | null;
  readonly tokenDelta: number | null;
  readonly tokenDeltaPct: number | null;

  readonly baselineCostUsd: number | null;
  readonly vtraceCostUsd: number | null;
  readonly costDelta: number | null;
  readonly costDeltaPct: number | null;

  readonly baselineResolved: boolean | null;
  readonly vtraceResolved: boolean | null;

  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly baselineInputTokens: number | null;
  readonly baselineOutputTokens: number | null;
  readonly baselineCacheReadTokens: number | null;
  readonly baselineCacheCreationTokens: number | null;
  readonly cacheReadDelta: number | null;
  readonly cacheCreationDelta: number | null;

  readonly toolCallCount: number | null;
  readonly readCallCount: number | null;
  readonly grepCallCount: number | null;
  readonly searchCallCount: number | null;
  readonly editCallCount: number | null;
  readonly bashCallCount: number | null;
  readonly repeatedReadOrSearchCalls: number | null;

  readonly uniqueFilesRead: number | null;
  readonly uniqueFilesEdited: number | null;
  readonly pivotsSurfaced: number | null;
  readonly pivotsInspected: number | null;
  readonly hiddenPivotsInspected: number | null;

  readonly contextChars: number | null;
  readonly capsuleEstimatedTokens: number | null;

  readonly vtracePivotCheckInjected: boolean | null;
  // Deterministic PIVOT_CHECK policy state (tolerant; null on pre-policy runs).
  readonly vtracePivotCheckPolicy: string | null;
  readonly vtracePivotCheckWouldInjectUnderMultiPivot: boolean | null;
  readonly vtraceEditGuardInjected: boolean | null;
  readonly vtracePatchVerifyInjected: boolean | null;
  // Gated OFFLINE critic/repair artifacts exist for this instance (never part of
  // the first-pass run itself).
  readonly vtracePatchCriticRan: boolean | null;
  readonly vtracePatchRepairRan: boolean | null;

  readonly hasVtraceToolCallLog: boolean;
  readonly hasVtraceRunMeta: boolean;

  readonly categories: readonly OverheadCategory[];
  readonly classificationEvidence: readonly string[];
}

function delta(b: number | null, v: number | null): number | null {
  return b === null || v === null ? null : v - b;
}
function deltaPct(b: number | null, v: number | null): number | null {
  if (b === null || v === null || b === 0) return null;
  return ((v - b) / b) * 100;
}

export interface BuildTaskAuditArgs {
  readonly instanceId: string;
  readonly baselineRunLabel: string | null;
  readonly vtraceRunLabel: string | null;
  readonly baseline: LedgerRun | null;
  readonly vtrace: LedgerRun | null;
  readonly vtraceToolStats: ToolCallStats | null;
  readonly vtraceRunMeta: RunMetaInfo | null;
  // Instances with any gated critic/repair artifact (from policy accounting);
  // null when the accounting artifact itself is missing.
  readonly criticRepairInstances: ReadonlySet<string> | null;
}

export function buildTaskAudit(args: BuildTaskAuditArgs): TaskAudit {
  const { instanceId, baseline, vtrace, vtraceToolStats, vtraceRunMeta, criticRepairInstances } = args;
  const bTok = baseline?.tokens ?? EMPTY_TOKENS;
  const vTok = vtrace?.tokens ?? EMPTY_TOKENS;

  const pivotsSurfaced = vtrace?.pivotCount ?? null;
  const pivotsInspected =
    vtraceRunMeta !== null && vtraceToolStats !== null && vtraceRunMeta.capsulePivotPaths.length > 0
      ? countPivotsInspected(vtraceRunMeta.capsulePivotPaths, vtraceToolStats.readOrSearchPaths)
      : null;

  const criticRepairRan = criticRepairInstances === null ? null : criticRepairInstances.has(instanceId);

  const unclassified: TaskAudit = {
    instanceId,
    baselineRunLabel: args.baselineRunLabel,
    vtraceRunLabel: args.vtraceRunLabel,
    baselineTotalTokens: bTok.total,
    vtraceTotalTokens: vTok.total,
    tokenDelta: delta(bTok.total, vTok.total),
    tokenDeltaPct: deltaPct(bTok.total, vTok.total),
    baselineCostUsd: baseline?.costUsd ?? null,
    vtraceCostUsd: vtrace?.costUsd ?? null,
    costDelta: delta(baseline?.costUsd ?? null, vtrace?.costUsd ?? null),
    costDeltaPct: deltaPct(baseline?.costUsd ?? null, vtrace?.costUsd ?? null),
    baselineResolved: baseline?.resolved ?? null,
    vtraceResolved: vtrace?.resolved ?? null,
    inputTokens: vTok.input,
    outputTokens: vTok.output,
    cacheReadTokens: vTok.cacheRead,
    cacheCreationTokens: vTok.cacheCreation,
    baselineInputTokens: bTok.input,
    baselineOutputTokens: bTok.output,
    baselineCacheReadTokens: bTok.cacheRead,
    baselineCacheCreationTokens: bTok.cacheCreation,
    cacheReadDelta: delta(bTok.cacheRead, vTok.cacheRead),
    cacheCreationDelta: delta(bTok.cacheCreation, vTok.cacheCreation),
    toolCallCount: vtraceToolStats?.toolCallCount ?? vtrace?.toolCallCount ?? null,
    readCallCount: vtraceToolStats?.readCallCount ?? null,
    grepCallCount: vtraceToolStats?.grepCallCount ?? null,
    searchCallCount: vtraceToolStats?.searchCallCount ?? null,
    editCallCount: vtraceToolStats?.editCallCount ?? null,
    bashCallCount: vtraceToolStats?.bashCallCount ?? null,
    repeatedReadOrSearchCalls: vtraceToolStats?.repeatedReadOrSearchCalls ?? null,
    uniqueFilesRead: vtraceToolStats?.uniqueFilesRead ?? null,
    uniqueFilesEdited: vtraceToolStats?.uniqueFilesEdited ?? (vtrace !== null ? vtrace.editedFiles.length : null),
    pivotsSurfaced,
    pivotsInspected,
    hiddenPivotsInspected: vtrace?.hiddenPivotsInspected ?? null,
    contextChars: vtraceRunMeta?.contextChars ?? null,
    capsuleEstimatedTokens: vtraceRunMeta?.capsuleEstimatedTokens ?? null,
    vtracePivotCheckInjected: vtrace?.pivotCheckInjected ?? vtraceRunMeta?.pivotCheckInjected ?? null,
    vtracePivotCheckPolicy: vtraceRunMeta?.pivotCheckPolicy ?? null,
    vtracePivotCheckWouldInjectUnderMultiPivot: vtraceRunMeta?.pivotCheckWouldInjectUnderMultiPivot ?? null,
    vtraceEditGuardInjected: vtrace?.editGuardInjected ?? null,
    vtracePatchVerifyInjected: vtrace?.patchVerifyInjected ?? null,
    vtracePatchCriticRan: criticRepairRan,
    vtracePatchRepairRan: criticRepairRan,
    hasVtraceToolCallLog: vtraceToolStats !== null,
    hasVtraceRunMeta: vtraceRunMeta !== null,
    categories: [],
    classificationEvidence: [],
  };
  const { categories, evidence } = classifyTask(unclassified);
  return { ...unclassified, categories, classificationEvidence: evidence };
}

// ---------------------------------------------------------------------------
// Classification (deterministic, evidence-based)
// ---------------------------------------------------------------------------

// Thresholds are fixed so the classification is reproducible from artifacts alone.
export const OVERSEARCH_MIN_TOOL_CALLS = 20;
export const OVERSEARCH_MIN_REPEATED_READS = 3;
export const TOOL_LOOP_MIN_BASH_CALLS = 10;
export const RETRIEVAL_NOISE_MIN_UNIQUE_READS = 5;
export const RETRIEVAL_NOISE_MIN_PIVOTS = 2;
export const RETRIEVAL_NOISE_MAX_EDITED = 2;
export const CONTEXT_TOO_LARGE_MIN_CHARS = 20000;
export const CONTEXT_TOO_LARGE_MIN_CAPSULE_TOKENS = 4000;
export const CACHE_ARTIFACT_MIN_CREATION_SHARE = 0.6;

export function classifyTask(t: TaskAudit): { categories: OverheadCategory[]; evidence: string[] } {
  const categories: OverheadCategory[] = [];
  const evidence: string[] = [];

  // Only positive token deltas are overhead cases. Unknown deltas are unauditable.
  if (t.tokenDelta === null) {
    return { categories: ["unknown"], evidence: ["token delta unavailable (missing baseline or vtrace token totals)"] };
  }
  if (t.tokenDelta <= 0) {
    return { categories: [], evidence: [`vtrace used ${-t.tokenDelta} fewer tokens than baseline — not an overhead case`] };
  }

  const resolutionImproved = t.vtraceResolved === true && t.baselineResolved === false;

  if (resolutionImproved) {
    categories.push("necessary_complexity");
    evidence.push("vtrace resolved a task baseline did not — extra tokens bought a resolution");
  }

  if (
    t.toolCallCount !== null &&
    (t.toolCallCount >= OVERSEARCH_MIN_TOOL_CALLS ||
      (t.repeatedReadOrSearchCalls !== null && t.repeatedReadOrSearchCalls >= OVERSEARCH_MIN_REPEATED_READS))
  ) {
    categories.push("agent_oversearched");
    evidence.push(
      `high tool-call volume: ${t.toolCallCount} tool calls` +
        (t.repeatedReadOrSearchCalls !== null && t.repeatedReadOrSearchCalls > 0
          ? `, ${t.repeatedReadOrSearchCalls} repeated Read/Grep visits to already-seen paths`
          : ""),
    );
  }

  if (t.bashCallCount !== null && t.bashCallCount >= TOOL_LOOP_MIN_BASH_CALLS) {
    categories.push("tool_loop_overhead");
    evidence.push(`${t.bashCallCount} Bash calls — long run/inspect loop, each turn re-reads the growing context`);
  }

  if (t.vtracePivotCheckInjected === true && t.hiddenPivotsInspected !== null && t.hiddenPivotsInspected >= 1 && !resolutionImproved) {
    categories.push("pivot_check_overhead");
    evidence.push(`PIVOT_CHECK injected and ${t.hiddenPivotsInspected} hidden pivot(s) inspected without a resolution improvement`);
  }

  if ((t.vtraceEditGuardInjected === true || t.vtracePatchVerifyInjected === true) && !resolutionImproved) {
    categories.push("prompt_overhead");
    const guards = [t.vtraceEditGuardInjected === true ? "EDIT_GUARD" : null, t.vtracePatchVerifyInjected === true ? "PATCH_VERIFY" : null]
      .filter((g): g is string => g !== null)
      .join("+");
    evidence.push(`${guards} injected while tokens/cost increased without a resolution improvement`);
  }

  if (
    t.uniqueFilesRead !== null &&
    t.uniqueFilesRead >= RETRIEVAL_NOISE_MIN_UNIQUE_READS &&
    t.pivotsSurfaced !== null &&
    t.pivotsSurfaced >= RETRIEVAL_NOISE_MIN_PIVOTS &&
    t.uniqueFilesEdited !== null &&
    t.uniqueFilesEdited <= RETRIEVAL_NOISE_MAX_EDITED &&
    !resolutionImproved
  ) {
    categories.push("retrieval_noise");
    evidence.push(
      `${t.uniqueFilesRead} unique files read and ${t.pivotsSurfaced} pivots surfaced but only ${t.uniqueFilesEdited} file(s) edited, with no resolution gain`,
    );
  }

  if (
    (t.contextChars !== null && t.contextChars >= CONTEXT_TOO_LARGE_MIN_CHARS) ||
    (t.capsuleEstimatedTokens !== null && t.capsuleEstimatedTokens >= CONTEXT_TOO_LARGE_MIN_CAPSULE_TOKENS)
  ) {
    categories.push("context_too_large");
    evidence.push(
      `injected context is large (contextChars=${t.contextChars ?? "n/a"}, capsuleEstimatedTokens=${t.capsuleEstimatedTokens ?? "n/a"})`,
    );
  }

  if (t.cacheCreationDelta !== null && t.cacheCreationDelta >= CACHE_ARTIFACT_MIN_CREATION_SHARE * t.tokenDelta) {
    categories.push("cache_accounting_artifact");
    evidence.push(
      `cache-creation delta (${t.cacheCreationDelta}) accounts for >=${Math.round(CACHE_ARTIFACT_MIN_CREATION_SHARE * 100)}% of the token delta (${t.tokenDelta}) — prefix re-pricing, not extra reasoning`,
    );
  }

  if (categories.length === 0) {
    categories.push("unknown");
    evidence.push(
      t.hasVtraceToolCallLog
        ? "no deterministic rule matched despite ordered tool logs"
        : `insufficient artifacts: no ordered tool log for this pair${t.hasVtraceRunMeta ? "" : ", and no per-run capsule metadata"}`,
    );
  }
  return { categories, evidence };
}

// ---------------------------------------------------------------------------
// Aggregate + offenders + recommendations (pure)
// ---------------------------------------------------------------------------

function sumNullable(values: ReadonlyArray<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

export interface AggregateMetrics {
  readonly taskCount: number;
  readonly pairedTaskCount: number;
  readonly overheadTaskCount: number;
  readonly baselineResolved: number;
  readonly vtraceResolved: number;
  readonly totalBaselineTokens: number | null;
  readonly totalVtraceTokens: number | null;
  readonly totalTokenDelta: number | null;
  readonly totalTokenDeltaPct: number | null;
  readonly totalBaselineCostUsd: number | null;
  readonly totalVtraceCostUsd: number | null;
  readonly totalCostDelta: number | null;
  readonly totalCostDeltaPct: number | null;
  readonly componentDeltas: {
    readonly input: number | null;
    readonly output: number | null;
    readonly cacheRead: number | null;
    readonly cacheCreation: number | null;
  };
  // Of the summed POSITIVE token deltas, the share carried by cache reads.
  readonly cacheReadShareOfPositiveDeltas: number | null;
  readonly tasksWithToolCallLog: number;
  readonly categoryCounts: Readonly<Partial<Record<OverheadCategory, number>>>;
  // Total positive token delta across the tasks where each category fired.
  readonly categoryTokenMass: Readonly<Partial<Record<OverheadCategory, number>>>;
}

export function computeAggregate(tasks: readonly TaskAudit[]): AggregateMetrics {
  const overhead = tasks.filter((t) => t.tokenDelta !== null && t.tokenDelta > 0);
  const totalBaselineTokens = sumNullable(tasks.map((t) => t.baselineTotalTokens));
  const totalVtraceTokens = sumNullable(tasks.map((t) => t.vtraceTotalTokens));
  const totalBaselineCostUsd = sumNullable(tasks.map((t) => t.baselineCostUsd));
  const totalVtraceCostUsd = sumNullable(tasks.map((t) => t.vtraceCostUsd));

  const categoryCounts: Partial<Record<OverheadCategory, number>> = {};
  const categoryTokenMass: Partial<Record<OverheadCategory, number>> = {};
  for (const t of tasks) {
    for (const c of t.categories) {
      categoryCounts[c] = (categoryCounts[c] ?? 0) + 1;
      if (t.tokenDelta !== null && t.tokenDelta > 0) categoryTokenMass[c] = (categoryTokenMass[c] ?? 0) + t.tokenDelta;
    }
  }

  const positiveDeltaSum = sumNullable(overhead.map((t) => t.tokenDelta));
  const positiveCacheReadSum = sumNullable(overhead.map((t) => t.cacheReadDelta));

  return {
    taskCount: tasks.length,
    pairedTaskCount: tasks.filter((t) => t.baselineTotalTokens !== null && t.vtraceTotalTokens !== null).length,
    overheadTaskCount: overhead.length,
    baselineResolved: tasks.filter((t) => t.baselineResolved === true).length,
    vtraceResolved: tasks.filter((t) => t.vtraceResolved === true).length,
    totalBaselineTokens,
    totalVtraceTokens,
    totalTokenDelta: delta(totalBaselineTokens, totalVtraceTokens),
    totalTokenDeltaPct: deltaPct(totalBaselineTokens, totalVtraceTokens),
    totalBaselineCostUsd,
    totalVtraceCostUsd,
    totalCostDelta: delta(totalBaselineCostUsd, totalVtraceCostUsd),
    totalCostDeltaPct: deltaPct(totalBaselineCostUsd, totalVtraceCostUsd),
    componentDeltas: {
      input: sumNullable(tasks.map((t) => delta(t.baselineInputTokens, t.inputTokens))),
      output: sumNullable(tasks.map((t) => delta(t.baselineOutputTokens, t.outputTokens))),
      cacheRead: sumNullable(tasks.map((t) => t.cacheReadDelta)),
      cacheCreation: sumNullable(tasks.map((t) => t.cacheCreationDelta)),
    },
    cacheReadShareOfPositiveDeltas:
      positiveDeltaSum !== null && positiveDeltaSum > 0 && positiveCacheReadSum !== null ? positiveCacheReadSum / positiveDeltaSum : null,
    tasksWithToolCallLog: tasks.filter((t) => t.hasVtraceToolCallLog).length,
    categoryCounts,
    categoryTokenMass,
  };
}

export interface Offender {
  readonly instanceId: string;
  readonly vtraceRunLabel: string | null;
  readonly tokenDelta: number;
  readonly tokenDeltaPct: number | null;
  readonly costDelta: number | null;
  readonly baselineResolved: boolean | null;
  readonly vtraceResolved: boolean | null;
  readonly categories: readonly OverheadCategory[];
  readonly evidence: readonly string[];
}

export function computeOffenders(tasks: readonly TaskAudit[]): Offender[] {
  return tasks
    .filter((t): t is TaskAudit & { tokenDelta: number } => t.tokenDelta !== null && t.tokenDelta > 0)
    .sort((a, b) => b.tokenDelta - a.tokenDelta)
    .map((t) => ({
      instanceId: t.instanceId,
      vtraceRunLabel: t.vtraceRunLabel,
      tokenDelta: t.tokenDelta,
      tokenDeltaPct: t.tokenDeltaPct,
      costDelta: t.costDelta,
      baselineResolved: t.baselineResolved,
      vtraceResolved: t.vtraceResolved,
      categories: t.categories,
      evidence: t.classificationEvidence,
    }));
}

export interface TokenRecommendation {
  readonly rank: number;
  readonly title: string;
  readonly evidence: string;
  readonly affectedTasks: readonly string[];
  // Total positive token delta across the tasks that triggered this recommendation.
  readonly tokenMass: number;
}

// Each candidate fires only when its driving categories actually fired; ranking is
// by the token mass of the affected overhead tasks (largest lever first).
export function computeRecommendations(tasks: readonly TaskAudit[], aggregate: AggregateMetrics): TokenRecommendation[] {
  const overheadWith = (cats: readonly OverheadCategory[]): TaskAudit[] =>
    tasks.filter((t) => t.tokenDelta !== null && t.tokenDelta > 0 && cats.some((c) => t.categories.includes(c)));
  const mass = (ts: readonly TaskAudit[]): number => ts.reduce((a, t) => a + (t.tokenDelta ?? 0), 0);
  const ids = (ts: readonly TaskAudit[]): string[] => ts.map((t) => t.instanceId);

  const candidates: Array<Omit<TokenRecommendation, "rank">> = [];

  const loops = overheadWith(["agent_oversearched", "tool_loop_overhead"]);
  if (loops.length >= 1) {
    candidates.push({
      title: "Add anti-loop guidance / make injected context more actionable so the agent stops over-searching and re-running long Bash loops.",
      evidence: `${loops.length} overhead task(s) show high tool-call volume, repeated Read/Grep visits, or >=${TOOL_LOOP_MIN_BASH_CALLS} Bash calls; every extra turn re-reads the whole growing context (cache reads carry ${aggregate.cacheReadShareOfPositiveDeltas !== null ? `${Math.round(aggregate.cacheReadShareOfPositiveDeltas * 100)}%` : "most"} of the positive token deltas).`,
      affectedTasks: ids(loops),
      tokenMass: mass(loops),
    });
  }

  const pivotCheck = overheadWith(["pivot_check_overhead"]);
  if (pivotCheck.length >= 2) {
    // PIVOT_CHECK is now risk_gated by default (--pivot-check-policy risk_gated):
    // it injects only on a deterministic high-risk signal, not merely for two pivots.
    // These overhead tasks predate or opted out of risk-gating; the recommendation is
    // to re-run them under the default and tighten the risk signals if any still inject.
    const stillMultiPivot = pivotCheck.filter((t) => t.vtracePivotCheckWouldInjectUnderMultiPivot === true).length;
    candidates.push({
      title: "Confirm PIVOT_CHECK risk-gating (now the default) suppresses these injections; tighten the risk signals if any still inject.",
      evidence:
        `PIVOT_CHECK was injected with hidden-pivot inspection on ${pivotCheck.length} overhead task(s) without any ` +
        `resolution improvement over baseline. risk_gated is now the default policy; ` +
        (stillMultiPivot > 0
          ? `${stillMultiPivot} of these still satisfy the old >= 2-pivot gate, so verify their risk signals justify the cost.`
          : `re-run under risk_gated to confirm the overhead injections no longer fire.`),
      affectedTasks: ids(pivotCheck),
      tokenMass: mass(pivotCheck),
    });
  }

  const prompt = overheadWith(["prompt_overhead"]);
  if (prompt.length >= 1) {
    candidates.push({
      title: "Disable EDIT_GUARD/PATCH_VERIFY in the default first-pass policy unless explicitly testing them.",
      evidence: `EDIT_GUARD/PATCH_VERIFY were injected on ${prompt.length} overhead task(s) while tokens/cost increased without a resolution improvement.`,
      affectedTasks: ids(prompt),
      tokenMass: mass(prompt),
    });
  }

  const context = overheadWith(["context_too_large"]);
  if (context.length >= 1) {
    candidates.push({
      title: "Reduce the Capsule snippet budget / pivot context lines, and prefer deferred refs over eager code excerpts.",
      evidence: `${context.length} overhead task(s) carried injected context above the size thresholds (>=${CONTEXT_TOO_LARGE_MIN_CHARS} chars or >=${CONTEXT_TOO_LARGE_MIN_CAPSULE_TOKENS} capsule tokens).`,
      affectedTasks: ids(context),
      tokenMass: mass(context),
    });
  }

  const noise = overheadWith(["retrieval_noise"]);
  if (noise.length >= 1) {
    candidates.push({
      title: "Improve pivot ranking for noisy retrieval cases (many files read, few edited, no resolution gain).",
      evidence: `${noise.length} overhead task(s) read >=${RETRIEVAL_NOISE_MIN_UNIQUE_READS} unique files against >=${RETRIEVAL_NOISE_MIN_PIVOTS} surfaced pivots while editing <=${RETRIEVAL_NOISE_MAX_EDITED}, with no resolution gain.`,
      affectedTasks: ids(noise),
      tokenMass: mass(noise),
    });
  }

  const cache = overheadWith(["cache_accounting_artifact"]);
  if (cache.length >= 1) {
    candidates.push({
      title: "Treat small cache-creation-dominated deltas as measurement noise; re-pair cross-label runs under one label before drawing token conclusions from them.",
      evidence: `${cache.length} overhead task(s) have token deltas dominated (>=${Math.round(CACHE_ARTIFACT_MIN_CREATION_SHARE * 100)}%) by cache-creation accounting rather than extra reasoning.`,
      affectedTasks: ids(cache),
      tokenMass: mass(cache),
    });
  }

  const unknown = overheadWith(["unknown"]);
  if (unknown.length >= 1) {
    candidates.push({
      title: "Capture ordered tool logs (_tool_calls.json) and capsule metadata for ALL runs — the largest unexplained deltas are on pairs without per-turn telemetry.",
      evidence: `${unknown.length} overhead task(s) could not be classified because the pair lacks ordered tool logs or per-run capsule metadata.`,
      affectedTasks: ids(unknown),
      tokenMass: mass(unknown),
    });
  }

  return candidates
    .sort((a, b) => b.tokenMass - a.tokenMass || a.title.localeCompare(b.title))
    .map((c, i) => ({ rank: i + 1, ...c }));
}

// ---------------------------------------------------------------------------
// Report (pure)
// ---------------------------------------------------------------------------

export interface TokenPathAuditReport {
  readonly generatedAt: string | null;
  readonly summary: {
    readonly taskCount: number;
    readonly overheadTaskCount: number;
    readonly totalTokenDelta: number | null;
    readonly totalTokenDeltaPct: number | null;
    readonly totalCostDelta: number | null;
    readonly totalCostDeltaPct: number | null;
    readonly baselineResolved: number;
    readonly vtraceResolved: number;
    readonly largestOffender: string | null;
    readonly dominantCategories: readonly OverheadCategory[];
    readonly headline: string;
  };
  readonly tasks: readonly TaskAudit[];
  readonly aggregate: AggregateMetrics;
  readonly offenders: readonly Offender[];
  readonly recommendations: readonly TokenRecommendation[];
  readonly nonClaims: readonly string[];
}

export const NON_CLAIMS: readonly string[] = [
  "This is not a VEXP comparison and not a statistically meaningful SWE-bench benchmark (n=10, 5 pairs cross-label).",
  "This re-runs nothing: no agent, no live critic, no repair, no Docker; raw artifacts are read-only inputs.",
  "This does not change retrieval, Capsule v2, PIVOT_CHECK, EDIT_GUARD, PATCH_VERIFY, probe, critic, repair, evaluator, or policy behavior.",
  "Tool-call and pivot-inspection analysis only covers VTRACE runs that emitted an ordered _tool_calls.json; baseline runs have no tool log, so per-pair tool-call deltas are NOT claimed.",
  "Cross-label pairs (astropy, matplotlib, requests, sphinx, sympy) compare runs from different protocols/dates; their cache-accounting components are not strictly controlled.",
  "vtracePatchCriticRan / vtracePatchRepairRan describe gated OFFLINE artifacts for the instance, never work inside the first-pass run.",
  "Token totals include cache reads/creation as reported by the runner; no metric was invented or imputed.",
  "Classifications are deterministic threshold rules over observed artifacts; they identify likely causes, not proven mechanisms.",
];

function fmtUsd(v: number | null): string {
  return v === null ? "n/a" : `$${v.toFixed(4)}`;
}
function fmtNum(v: number | null): string {
  return v === null ? "null" : String(Math.round(v));
}
function fmtPct(v: number | null): string {
  return v === null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}
function fmtSigned(v: number | null): string {
  return v === null ? "null" : `${v >= 0 ? "+" : ""}${Math.round(v)}`;
}
function tri(v: boolean | null): string {
  return v === null ? "unknown" : v ? "true" : "false";
}

export function buildReport(args: { readonly generatedAt: string | null; readonly tasks: readonly TaskAudit[] }): TokenPathAuditReport {
  const { generatedAt, tasks } = args;
  const aggregate = computeAggregate(tasks);
  const offenders = computeOffenders(tasks);
  const recommendations = computeRecommendations(tasks, aggregate);

  const dominantCategories = (Object.entries(aggregate.categoryTokenMass) as Array<[OverheadCategory, number]>)
    .filter(([c]) => c !== "necessary_complexity")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c]) => c);

  const top = offenders[0] ?? null;
  const headline =
    `VTRACE first-pass used ${fmtSigned(aggregate.totalTokenDelta)} tokens (${fmtPct(aggregate.totalTokenDeltaPct)}) and ` +
    `${fmtUsd(aggregate.totalCostDelta)} (${fmtPct(aggregate.totalCostDeltaPct)}) vs baseline across ${aggregate.pairedTaskCount} paired tasks, ` +
    `resolving ${aggregate.vtraceResolved}/${aggregate.taskCount} vs baseline ${aggregate.baselineResolved}/${aggregate.taskCount}. ` +
    `${aggregate.overheadTaskCount} task(s) are token-overhead cases` +
    (top !== null ? `; the largest is ${top.instanceId} (${fmtSigned(top.tokenDelta)} tokens, ${top.categories.join(", ")})` : "") +
    `. Dominant overhead categories by token mass: ${dominantCategories.length > 0 ? dominantCategories.join(", ") : "none"}.`;

  return {
    generatedAt,
    summary: {
      taskCount: aggregate.taskCount,
      overheadTaskCount: aggregate.overheadTaskCount,
      totalTokenDelta: aggregate.totalTokenDelta,
      totalTokenDeltaPct: aggregate.totalTokenDeltaPct,
      totalCostDelta: aggregate.totalCostDelta,
      totalCostDeltaPct: aggregate.totalCostDeltaPct,
      baselineResolved: aggregate.baselineResolved,
      vtraceResolved: aggregate.vtraceResolved,
      largestOffender: top?.instanceId ?? null,
      dominantCategories,
      headline,
    },
    tasks,
    aggregate,
    offenders,
    recommendations,
    nonClaims: NON_CLAIMS,
  };
}

export function renderJson(report: TokenPathAuditReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export const REQUIRED_MARKDOWN_SECTIONS: readonly string[] = [
  "# Stage 5 token-path audit",
  "## Summary",
  "## Aggregate token/cost comparison",
  "## Per-task token deltas",
  "## Tool-call and file-read analysis",
  "## Prompt/context overhead",
  "## PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY overhead",
  "## Largest VTRACE token offenders",
  "## Likely causes",
  "## Token-reduction recommendations",
  "## Non-claims",
];

export function renderMarkdown(report: TokenPathAuditReport): string {
  const L: string[] = [];
  const { summary, aggregate, tasks } = report;

  L.push("# Stage 5 token-path audit");
  L.push("");
  if (report.generatedAt) L.push(`_Generated: ${report.generatedAt}_`, "");
  L.push(
    "_Reporting/accounting only. Re-runs nothing (no agent, no live critic, no repair, no Docker); reads the controlled-task plan, outcome ledger, policy accounting, and per-run raw artifacts where present._",
  );
  L.push("");

  L.push("## Summary");
  L.push("");
  L.push(summary.headline);
  L.push("");
  L.push(`- paired tasks: **${aggregate.pairedTaskCount}** of ${aggregate.taskCount}`);
  L.push(`- token-overhead cases (vtrace > baseline): **${aggregate.overheadTaskCount}**`);
  L.push(`- total token delta: **${fmtSigned(aggregate.totalTokenDelta)}** (${fmtPct(aggregate.totalTokenDeltaPct)})`);
  L.push(`- total cost delta: **${fmtUsd(aggregate.totalCostDelta)}** (${fmtPct(aggregate.totalCostDeltaPct)})`);
  L.push(`- resolved: baseline **${aggregate.baselineResolved}/${aggregate.taskCount}**, vtrace first-pass **${aggregate.vtraceResolved}/${aggregate.taskCount}**`);
  L.push(`- tasks with ordered tool logs: **${aggregate.tasksWithToolCallLog}** (all VTRACE-side; baseline runs have none)`);
  L.push("");

  L.push("## Aggregate token/cost comparison");
  L.push("");
  L.push("| metric | baseline | vtrace | delta | delta % |");
  L.push("| --- | --- | --- | --- | --- |");
  L.push(
    `| total tokens | ${fmtNum(aggregate.totalBaselineTokens)} | ${fmtNum(aggregate.totalVtraceTokens)} | ${fmtSigned(aggregate.totalTokenDelta)} | ${fmtPct(aggregate.totalTokenDeltaPct)} |`,
  );
  L.push(
    `| total cost | ${fmtUsd(aggregate.totalBaselineCostUsd)} | ${fmtUsd(aggregate.totalVtraceCostUsd)} | ${fmtUsd(aggregate.totalCostDelta)} | ${fmtPct(aggregate.totalCostDeltaPct)} |`,
  );
  L.push(`| resolved | ${aggregate.baselineResolved} | ${aggregate.vtraceResolved} | ${aggregate.vtraceResolved - aggregate.baselineResolved} | — |`);
  L.push("");
  L.push("Token-component deltas (vtrace − baseline, summed over paired tasks):");
  L.push("");
  L.push("| component | delta |");
  L.push("| --- | --- |");
  L.push(`| input | ${fmtSigned(aggregate.componentDeltas.input)} |`);
  L.push(`| output | ${fmtSigned(aggregate.componentDeltas.output)} |`);
  L.push(`| cacheRead | ${fmtSigned(aggregate.componentDeltas.cacheRead)} |`);
  L.push(`| cacheCreation | ${fmtSigned(aggregate.componentDeltas.cacheCreation)} |`);
  L.push("");
  if (aggregate.cacheReadShareOfPositiveDeltas !== null) {
    L.push(
      `Cache reads carry **${Math.round(aggregate.cacheReadShareOfPositiveDeltas * 100)}%** of the summed positive token deltas: the overhead is mostly the conversation prefix being re-read on every extra agent turn, i.e. token deltas track TURN COUNT more than prompt size.`,
    );
    L.push("");
  }

  L.push("## Per-task token deltas");
  L.push("");
  L.push("| instance | baseline run | vtrace run | baseline tok | vtrace tok | Δ tok | Δ % | baseline $ | vtrace $ | Δ $ | base res | vtrace res |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const t of tasks) {
    L.push(
      `| ${t.instanceId} | ${t.baselineRunLabel ?? "n/a"} | ${t.vtraceRunLabel ?? "n/a"} | ${fmtNum(t.baselineTotalTokens)} | ${fmtNum(t.vtraceTotalTokens)} | ${fmtSigned(t.tokenDelta)} | ${fmtPct(t.tokenDeltaPct)} | ${fmtUsd(t.baselineCostUsd)} | ${fmtUsd(t.vtraceCostUsd)} | ${fmtUsd(t.costDelta)} | ${tri(t.baselineResolved)} | ${tri(t.vtraceResolved)} |`,
    );
  }
  L.push("");

  L.push("## Tool-call and file-read analysis");
  L.push("");
  L.push("_VTRACE-side only: ordered `_tool_calls.json` logs exist for the cross-label controlled VTRACE runs; baseline runs and the older same-label django pairs have no tool log (null)._");
  L.push("");
  L.push("| instance | tool calls | read | grep | search | edit | bash | repeated read/grep | unique files read | unique files edited |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const t of tasks) {
    L.push(
      `| ${t.instanceId} | ${fmtNum(t.toolCallCount)} | ${fmtNum(t.readCallCount)} | ${fmtNum(t.grepCallCount)} | ${fmtNum(t.searchCallCount)} | ${fmtNum(t.editCallCount)} | ${fmtNum(t.bashCallCount)} | ${fmtNum(t.repeatedReadOrSearchCalls)} | ${fmtNum(t.uniqueFilesRead)} | ${fmtNum(t.uniqueFilesEdited)} |`,
    );
  }
  L.push("");

  L.push("## Prompt/context overhead");
  L.push("");
  L.push("| instance | context chars | capsule est. tokens | pivots surfaced | pivots inspected | hidden pivots inspected |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const t of tasks) {
    L.push(
      `| ${t.instanceId} | ${fmtNum(t.contextChars)} | ${fmtNum(t.capsuleEstimatedTokens)} | ${fmtNum(t.pivotsSurfaced)} | ${fmtNum(t.pivotsInspected)} | ${fmtNum(t.hiddenPivotsInspected)} |`,
    );
  }
  L.push("");
  const measured = tasks.filter((t) => t.contextChars !== null);
  if (measured.length > 0) {
    const maxChars = Math.max(...measured.map((t) => t.contextChars ?? 0));
    L.push(
      `Where measured, the injected VTRACE context is small (max ${maxChars} chars ≈ ${Math.round(maxChars / 4)} tokens): one-time prompt size is NOT the main token driver; the multiplier is how many turns re-read the conversation afterwards.`,
    );
    L.push("");
  }

  L.push("## PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY overhead");
  L.push("");
  L.push("| instance | PIVOT_CHECK injected | policy | would inj. (multi-pivot) | EDIT_GUARD injected | PATCH_VERIFY injected | critic ran (offline) | repair ran (offline) | Δ tok |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const t of tasks) {
    L.push(
      `| ${t.instanceId} | ${tri(t.vtracePivotCheckInjected)} | ${t.vtracePivotCheckPolicy ?? "—"} | ${tri(t.vtracePivotCheckWouldInjectUnderMultiPivot)} | ${tri(t.vtraceEditGuardInjected)} | ${tri(t.vtracePatchVerifyInjected)} | ${tri(t.vtracePatchCriticRan)} | ${tri(t.vtracePatchRepairRan)} | ${fmtSigned(t.tokenDelta)} |`,
    );
  }
  L.push("");
  L.push("_EDIT_GUARD / PATCH_VERIFY injection was not recorded (null) for these first-pass controlled runs — their guard experiments ran under separate labels outside this controlled set. Critic/repair columns refer to gated OFFLINE artifacts for the instance, never first-pass work._");
  L.push("");

  L.push("## Largest VTRACE token offenders");
  L.push("");
  if (report.offenders.length === 0) {
    L.push("_No task where VTRACE used more tokens than baseline._");
  } else {
    for (const [i, o] of report.offenders.entries()) {
      L.push(`${i + 1}. **${o.instanceId}** (${o.vtraceRunLabel ?? "n/a"}): ${fmtSigned(o.tokenDelta)} tokens (${fmtPct(o.tokenDeltaPct)}), ${fmtUsd(o.costDelta)} — ${o.categories.join(", ")}`);
      for (const e of o.evidence) L.push(`   - ${e}`);
    }
  }
  L.push("");

  L.push("## Likely causes");
  L.push("");
  const causeEntries = (Object.entries(aggregate.categoryCounts) as Array<[OverheadCategory, number]>).sort(
    (a, b) => (aggregate.categoryTokenMass[b[0]] ?? 0) - (aggregate.categoryTokenMass[a[0]] ?? 0),
  );
  if (causeEntries.length === 0) {
    L.push("_No overhead case to classify._");
  } else {
    L.push("| category | tasks | token mass (positive deltas) |");
    L.push("| --- | --- | --- |");
    for (const [c, n] of causeEntries) L.push(`| ${c} | ${n} | ${fmtNum(aggregate.categoryTokenMass[c] ?? null)} |`);
    L.push("");
    L.push("_Categories are deterministic threshold rules (multi-label); token mass attributes each overhead task's full positive delta to every category that fired on it, so masses overlap and do not sum to the total delta._");
  }
  L.push("");

  L.push("## Token-reduction recommendations");
  L.push("");
  if (report.recommendations.length === 0) {
    L.push("_No recommendation fired — no overhead evidence found._");
  } else {
    for (const r of report.recommendations) {
      L.push(`${r.rank}. **${r.title}**`);
      L.push(`   - evidence: ${r.evidence}`);
      L.push(`   - affected tasks (${r.affectedTasks.length}, ${fmtNum(r.tokenMass)} overhead tokens): ${r.affectedTasks.join(", ")}`);
    }
  }
  L.push("");

  L.push("## Non-claims");
  L.push("");
  for (const n of report.nonClaims) L.push(`- ${n}`);
  L.push("");

  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Read-only loading
// ---------------------------------------------------------------------------

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

interface PlanDoc {
  readonly selectedTasks?: ReadonlyArray<Record<string, unknown>>;
}
interface LedgerDoc {
  readonly runs?: ReadonlyArray<Record<string, unknown>>;
}
interface AccountingDoc {
  readonly conversions?: ReadonlyArray<Record<string, unknown>>;
}

export async function loadTaskAudits(resultsDir: string): Promise<TaskAudit[]> {
  const plan = await readJson<PlanDoc>(path.join(resultsDir, "stage5_controlled_10_task_plan.json"));
  if (plan === null || !Array.isArray(plan.selectedTasks) || plan.selectedTasks.length === 0) {
    throw new Error(
      `No controlled-task plan at ${path.join(resultsDir, "stage5_controlled_10_task_plan.json")} (or it has no selectedTasks); nothing to audit.`,
    );
  }

  const ledger = await readJson<LedgerDoc>(path.join(resultsDir, "stage5_outcome_ledger.json"));
  const ledgerRuns = (ledger?.runs ?? []).map(parseLedgerRun);
  const byLabelCondition = new Map<string, LedgerRun>(ledgerRuns.map((r) => [`${r.runLabel}::${r.condition}`, r]));

  const accounting = await readJson<AccountingDoc>(path.join(resultsDir, "stage5_policy_accounting.json"));
  const criticRepairInstances =
    accounting !== null && Array.isArray(accounting.conversions)
      ? new Set(accounting.conversions.map((c) => asStr(c.instanceId)).filter((s): s is string => s !== null))
      : null;

  const audits: TaskAudit[] = [];
  for (const raw of plan.selectedTasks) {
    const instanceId = asStr(raw.instanceId) ?? "unknown";
    const baselineRunLabel = asStr(raw.baselineRunLabel);
    const vtraceRunLabel = asStr(raw.vtraceRunLabel);
    const baseline = baselineRunLabel !== null ? (byLabelCondition.get(`${baselineRunLabel}::baseline`) ?? null) : null;
    const vtrace = vtraceRunLabel !== null ? (byLabelCondition.get(`${vtraceRunLabel}::vtrace`) ?? null) : null;

    let vtraceToolStats: ToolCallStats | null = null;
    let vtraceRunMeta: RunMetaInfo | null = null;
    if (vtraceRunLabel !== null) {
      const rawDir = path.join(resultsDir, "runs", vtraceRunLabel, "raw", "vtrace");
      const toolCalls = await readJson<RawToolCall[]>(path.join(rawDir, "_tool_calls.json"));
      if (Array.isArray(toolCalls)) vtraceToolStats = computeToolCallStats(toolCalls);
      const meta = await readJson<Record<string, unknown>>(path.join(rawDir, "_run.meta.json"));
      if (meta !== null) vtraceRunMeta = parseRunMeta(meta);
    }

    audits.push(
      buildTaskAudit({
        instanceId,
        baselineRunLabel,
        vtraceRunLabel,
        baseline,
        vtrace,
        vtraceToolStats,
        vtraceRunMeta,
        criticRepairInstances,
      }),
    );
  }
  return audits;
}

// ---------------------------------------------------------------------------
// Main (impure)
// ---------------------------------------------------------------------------

export async function run(config: CliConfig): Promise<TokenPathAuditReport> {
  const generatedAt = new Date().toISOString();
  const tasks = await loadTaskAudits(config.resultsDir);
  const report = buildReport({ generatedAt, tasks });

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  process.stdout.write(
    [
      "Stage 5 token-path audit written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Paired tasks: ${report.aggregate.pairedTaskCount}   Overhead cases: ${report.summary.overheadTaskCount}`,
      `Token delta: ${fmtSigned(report.summary.totalTokenDelta)} (${fmtPct(report.summary.totalTokenDeltaPct)})   Cost delta: ${fmtUsd(report.summary.totalCostDelta)} (${fmtPct(report.summary.totalCostDeltaPct)})`,
      `Largest offender: ${report.summary.largestOffender ?? "none"}   Dominant categories: ${report.summary.dominantCategories.join(", ") || "none"}`,
      `Recommendations: ${report.recommendations.length}`,
      "",
    ].join("\n"),
  );
  return report;
}

if (import.meta.main) {
  try {
    await run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
