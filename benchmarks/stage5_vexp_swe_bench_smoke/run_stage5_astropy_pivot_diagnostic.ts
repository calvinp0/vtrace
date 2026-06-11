// Stage 5 Astropy pivot-ranking and Capsule-budget diagnostic.
//
// Read-only diagnostic that explains why the Astropy instance (astropy__astropy-14369)
// remained expensive and unresolved under strict VTRACE. It scans the COMMITTED /
// generated Stage 5 artifacts for every Astropy run, extracts the Capsule that was
// injected (pivots, snippet sizes, deferred refs) from each run's
// `_vtrace_instructions.snapshot.md`, the ordered tool log from `_tool_calls.json`,
// and the resolved/cost/token outcome from the strict-gated report + per-run eval
// meta, and assigns a conservative classification:
//
//   noisy_pivot_ranking | capsule_budget_too_large | deferred_refs_underused |
//   agent_looping | patch_mistake_despite_good_context | insufficient_evidence
//
// It does NOT re-run agents, Docker, retrieval, ranking, Capsule generation,
// PIVOT_CHECK, the critic, repair, the evaluator, or any prompt behavior. It reads
// existing artifacts only. Missing artifacts are reported as missing, never
// reconstructed, and token counts are never invented — the only authoritative token
// figure used is each Capsule's own `budget: N / M tokens used` line; per-snippet
// sizes are explicitly-labelled char-derived heuristics, not measured tokens.

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  summarizeOrderedToolCalls,
  type OrderedToolCall,
  type OrderedToolCallSummary,
} from "../../src/capsule/toolCallLog";

const DEFAULT_RESULTS_DIR = "benchmarks/stage5_vexp_swe_bench_smoke/results";
export const ASTROPY_DIAGNOSTIC_JSON_FILENAME = "stage5_astropy_pivot_diagnostic.json";
export const ASTROPY_DIAGNOSTIC_MD_FILENAME = "stage5_astropy_pivot_diagnostic.md";

// The instance under investigation, and the substrings that identify a matching run
// directory / run label (the runner names dirs e.g. `eval-strictgated-vtrace-astropy-14369`).
export const ASTROPY_INSTANCE_ID = "astropy__astropy-14369";
export const ASTROPY_MATCH_TOKENS: readonly string[] = ["astropy__astropy-14369", "astropy-14369"];

// Capsule token budget over which a run's injected Capsule is flagged "too large".
// Calibrated against the strict 10-task set (median ≈ 1.1k, max non-Astropy ≈ 1.6k);
// 2,000 sits above every non-Astropy strict Capsule and below Astropy's (2,772).
export const CAPSULE_TOKEN_BUDGET_THRESHOLD = 2000;

// Rough chars→tokens divisor, used ONLY for per-snippet size *heuristics* (which
// pivot snippet is largest). Never used to override the Capsule's own budget line.
export const CHARS_PER_TOKEN = 4;

export type PrimaryIssue =
  | "noisy_pivot_ranking"
  | "capsule_budget_too_large"
  | "deferred_refs_underused"
  | "agent_looping"
  | "patch_mistake_despite_good_context"
  | "insufficient_evidence";

export interface CapsulePivot {
  path: string;
  symbol: string | null;
  // Length of the captured `source:` snippet for this pivot, in characters, and the
  // char-derived token *heuristic* (not a measured token count).
  snippetChars: number;
  snippetTokenEstimateHeuristic: number;
}

export interface CapsuleDeferredRef {
  path: string;
  symbol: string | null;
}

// What we could recover from one run's `_vtrace_instructions.snapshot.md`. When the
// snapshot is absent every field is null/empty and `available` is false.
export interface ParsedCapsule {
  available: boolean;
  budgetTokensUsed: number | null;
  budgetTokensTotal: number | null;
  pivots: CapsulePivot[];
  deferredRefs: CapsuleDeferredRef[];
  capsuleItemCount: number;
  largestSnippetPath: string | null;
  largestSnippetChars: number | null;
  largestSnippetTokenEstimateHeuristic: number | null;
  searchLogicFlowPresent: boolean;
}

// Cost/token outcome for one run, and where it came from.
export type CostTokenSource = "strictgated_report" | "unavailable";

// All inputs needed to analyze one Astropy run, already loaded from disk (or supplied
// by a fixture in tests). Any field may be null when its artifact is missing.
export interface AstropyRunInputs {
  runLabel: string;
  condition: string;
  instanceId: string;
  snapshotMd: string | null;
  toolCalls: OrderedToolCall[] | null;
  evalMeta: Record<string, unknown> | null;
  runMeta: Record<string, unknown> | null;
  // Resolved cost/tokens/resolved from the strict-gated 10-task report, when this run
  // label corresponds to one of that report's tracked labels; else null.
  reportOutcome: { resolved: boolean | null; totalTokens: number | null; costUsd: number | null } | null;
}

export interface AstropyRunDiagnostic {
  runLabel: string;
  condition: string;
  instanceId: string;
  resolved: boolean | null;
  totalCostUsd: number | null;
  totalTokens: number | null;
  costTokenSource: CostTokenSource;
  orderedTelemetryAvailable: boolean;
  missingTelemetryReason: string | null;
  toolCallSummary: OrderedToolCallSummary | null;
  capsuleAvailable: boolean;
  capsuleTokenEstimate: number | null;
  capsuleTokenBudget: number | null;
  capsuleSnippetTokenEstimateHeuristic: number | null;
  capsuleItemCount: number | null;
  pivotCount: number | null;
  pivotPaths: string[];
  topPivotPath: string | null;
  topPivotInEditedFiles: boolean | null;
  largestSnippetPath: string | null;
  largestSnippetTokenEstimateHeuristic: number | null;
  deferredRefCount: number | null;
  deferredRefPaths: string[];
  expandedDeferredRefCount: number | null;
  searchLogicFlowPresent: boolean;
  pivotCheckInjected: boolean | null;
  toolUseDisciplineInjected: boolean | null;
  editedFiles: string[];
  firstPatchPaths: string[];
}

export interface StrictSetTaskCapsule {
  instanceId: string;
  capsuleTokens: number | null;
  capsuleItems: number | null;
  deferredRefs: number | null;
}

export interface StrictSetMedians {
  taskCount: number;
  capsuleTokenMedian: number | null;
  capsuleItemMedian: number | null;
  deferredRefMedian: number | null;
  perTask: StrictSetTaskCapsule[];
}

export interface AstropyClassification {
  primaryIssue: PrimaryIssue;
  secondaryIssues: PrimaryIssue[];
  focusRunLabel: string | null;
  rationale: string[];
}

export interface AstropyRecommendation {
  id: 1 | 2 | 3 | 4;
  title: string;
  body: string;
}

export interface AstropyDiagnostic {
  resultsDir: string;
  capsuleTokenBudgetThreshold: number;
  runsAnalyzed: AstropyRunDiagnostic[];
  focusRunLabel: string | null;
  strictSetMedians: StrictSetMedians;
  classification: AstropyClassification;
  recommendedNextChange: AstropyRecommendation;
  missingArtifacts: string[];
  nonClaims: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

// Does this run label / instance id belong to the Astropy instance under study?
export function matchesAstropy(label: string, instanceId: string | null): boolean {
  if (instanceId !== null && ASTROPY_MATCH_TOKENS.includes(instanceId)) return true;
  return ASTROPY_MATCH_TOKENS.some((token) => label.includes(token));
}

// Median of a numeric list (null when empty). Even-length → mean of the two middle.
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// Parse `1,234` / `1234` → 1234; null otherwise.
function parseGroupedInt(text: string): number | null {
  const digits = text.replace(/,/g, "").trim();
  if (!/^\d+$/.test(digits)) return null;
  return Number.parseInt(digits, 10);
}

// Parse a Capsule snapshot markdown into pivots, deferred refs, budget, snippet sizes.
//
// Snapshot grammar (as emitted by the runner):
//   `budget: 2,772 / 8,000 tokens used`
//   `● pivot <path>::<symbol>` … `source:` <snippet> … (`hidden candidate:` | next marker)
//   `○ support <path>::<symbol>`   (deferred reference: signature only, no full snippet)
// Tolerant: anything it cannot recognize is skipped rather than throwing.
export function parseCapsuleSnapshot(md: string | null): ParsedCapsule {
  if (md === null) {
    return {
      available: false,
      budgetTokensUsed: null,
      budgetTokensTotal: null,
      pivots: [],
      deferredRefs: [],
      capsuleItemCount: 0,
      largestSnippetPath: null,
      largestSnippetChars: null,
      largestSnippetTokenEstimateHeuristic: null,
      searchLogicFlowPresent: false,
    };
  }

  const lines = md.split(/\r?\n/);
  let budgetTokensUsed: number | null = null;
  let budgetTokensTotal: number | null = null;
  const budgetMatch = md.match(/budget:\s*([\d,]+)\s*\/\s*([\d,]+)\s*tokens used/);
  if (budgetMatch) {
    budgetTokensUsed = parseGroupedInt(budgetMatch[1]!);
    budgetTokensTotal = parseGroupedInt(budgetMatch[2]!);
  }
  const searchLogicFlowPresent = /searchLogicFlow|search logic flow/i.test(md);

  const pivotRe = /^●\s*pivot\s+(\S+?)(?:::(\S+))?\s*$/;
  const supportRe = /^○\s*support\s+(\S+?)(?:::(\S+))?\s*$/;
  // A line that ends the current pivot's snippet region.
  const isBoundary = (line: string): boolean =>
    line.startsWith("●") || line.startsWith("○") || line.startsWith("## ") || /^\s*hidden candidate:/.test(line);

  const pivots: CapsulePivot[] = [];
  const deferredRefs: CapsuleDeferredRef[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const pivot = line.match(pivotRe);
    if (pivot) {
      // Capture the snippet region: from the line after `source:` up to the next
      // boundary. We measure its character length (a size proxy); if there is no
      // `source:` block we still record the pivot with a zero-length snippet.
      let snippetChars = 0;
      let j = i + 1;
      let inSource = false;
      for (; j < lines.length; j += 1) {
        const inner = lines[j]!;
        if (isBoundary(inner)) break;
        if (/^\s*source:\s*$/.test(inner)) {
          inSource = true;
          continue;
        }
        if (inSource) snippetChars += inner.length + 1; // +1 for the newline
      }
      pivots.push({
        path: pivot[1]!,
        symbol: pivot[2] ?? null,
        snippetChars,
        snippetTokenEstimateHeuristic: Math.round(snippetChars / CHARS_PER_TOKEN),
      });
      continue;
    }
    const support = line.match(supportRe);
    if (support) {
      deferredRefs.push({ path: support[1]!, symbol: support[2] ?? null });
    }
  }

  let largestSnippetPath: string | null = null;
  let largestSnippetChars: number | null = null;
  for (const pivot of pivots) {
    if (largestSnippetChars === null || pivot.snippetChars > largestSnippetChars) {
      largestSnippetChars = pivot.snippetChars;
      largestSnippetPath = pivot.path;
    }
  }

  return {
    available: true,
    budgetTokensUsed,
    budgetTokensTotal,
    pivots,
    deferredRefs,
    capsuleItemCount: pivots.length + deferredRefs.length,
    largestSnippetPath,
    largestSnippetChars,
    largestSnippetTokenEstimateHeuristic:
      largestSnippetChars === null ? null : Math.round(largestSnippetChars / CHARS_PER_TOKEN),
    searchLogicFlowPresent,
  };
}

// Edited files from the ordered tool log: every edit-category call's path. Returned
// as-is (absolute bench paths); pivot paths are repo-relative, so overlap is tested
// by suffix.
function editedFilesFromToolCalls(calls: readonly OrderedToolCall[]): string[] {
  const files: string[] = [];
  for (const call of calls) {
    if (call.category === "edit" && typeof call.path === "string") {
      if (!files.includes(call.path)) files.push(call.path);
    }
  }
  return files;
}

// True when a repo-relative pivot path overlaps any edited file (suffix match).
function pivotOverlapsEdited(pivotPath: string, editedFiles: readonly string[]): boolean {
  return editedFiles.some((edited) => edited === pivotPath || edited.endsWith(`/${pivotPath}`) || edited.endsWith(pivotPath));
}

// Count deferred refs that the agent actually opened (a read-category tool call whose
// path matches the deferred ref AND that is not itself a selected pivot — opening a
// pivot file does not count as "expanding the deferred ref"). Null when there is no
// ordered telemetry to attribute against.
function countExpandedDeferredRefs(
  deferredRefs: readonly CapsuleDeferredRef[],
  pivots: readonly CapsulePivot[],
  calls: readonly OrderedToolCall[] | null,
): number | null {
  if (calls === null) return null;
  const readPaths = calls.filter((c) => c.category === "read" && typeof c.path === "string").map((c) => c.path as string);
  const pivotPaths = new Set(pivots.map((p) => p.path));
  let expanded = 0;
  for (const ref of deferredRefs) {
    if (pivotPaths.has(ref.path)) continue;
    if (readPaths.some((rp) => rp === ref.path || rp.endsWith(`/${ref.path}`) || rp.endsWith(ref.path))) {
      expanded += 1;
    }
  }
  return expanded;
}

// Analyze a single Astropy run from already-loaded inputs (pure — no disk).
export function analyzeAstropyRun(inputs: AstropyRunInputs): AstropyRunDiagnostic {
  const capsule = parseCapsuleSnapshot(inputs.snapshotMd);
  const orderedTelemetryAvailable = inputs.toolCalls !== null;
  const toolCallSummary = orderedTelemetryAvailable
    ? summarizeOrderedToolCalls(inputs.toolCalls as OrderedToolCall[], true)
    : null;
  const editedFiles = inputs.toolCalls !== null ? editedFilesFromToolCalls(inputs.toolCalls) : [];

  const pivotPaths = capsule.pivots.map((p) => p.path);
  const topPivotPath = pivotPaths.length > 0 ? pivotPaths[0]! : null;
  const topPivotInEditedFiles =
    topPivotPath === null || editedFiles.length === 0 ? null : pivotOverlapsEdited(topPivotPath, editedFiles);

  // Resolved is read from the per-run eval meta first (always written by the runner),
  // falling back to the strict-gated report block when the meta is missing.
  const resolvedFromMeta =
    inputs.evalMeta !== null && typeof inputs.evalMeta.resolvedCount === "number"
      ? inputs.evalMeta.resolvedCount > 0
      : null;
  const resolved = resolvedFromMeta ?? inputs.reportOutcome?.resolved ?? null;

  // Cost/tokens come only from the strict-gated report (the only artifact that joins
  // them per task/label); unavailable otherwise — never guessed.
  const totalCostUsd = inputs.reportOutcome?.costUsd ?? null;
  const totalTokens = inputs.reportOutcome?.totalTokens ?? null;
  const costTokenSource: CostTokenSource = totalCostUsd !== null || totalTokens !== null ? "strictgated_report" : "unavailable";

  const snippetTokenSum = capsule.pivots.reduce((acc, p) => acc + p.snippetTokenEstimateHeuristic, 0);

  return {
    runLabel: inputs.runLabel,
    condition: inputs.condition,
    instanceId: inputs.instanceId,
    resolved,
    totalCostUsd,
    totalTokens,
    costTokenSource,
    orderedTelemetryAvailable,
    missingTelemetryReason: orderedTelemetryAvailable ? null : "no_tool_calls_artifact",
    toolCallSummary,
    capsuleAvailable: capsule.available,
    capsuleTokenEstimate: capsule.budgetTokensUsed,
    capsuleTokenBudget: capsule.budgetTokensTotal,
    capsuleSnippetTokenEstimateHeuristic: capsule.available ? snippetTokenSum : null,
    capsuleItemCount: capsule.available ? capsule.capsuleItemCount : null,
    pivotCount: capsule.available ? capsule.pivots.length : null,
    pivotPaths,
    topPivotPath,
    topPivotInEditedFiles,
    largestSnippetPath: capsule.largestSnippetPath,
    largestSnippetTokenEstimateHeuristic: capsule.largestSnippetTokenEstimateHeuristic,
    deferredRefCount: capsule.available ? capsule.deferredRefs.length : null,
    deferredRefPaths: capsule.deferredRefs.map((r) => r.path),
    expandedDeferredRefCount: countExpandedDeferredRefs(capsule.deferredRefs, capsule.pivots, inputs.toolCalls),
    searchLogicFlowPresent: capsule.searchLogicFlowPresent,
    pivotCheckInjected:
      inputs.runMeta !== null ? boolOrNull(inputs.runMeta.vtracePivotChecklistEmitted) : null,
    toolUseDisciplineInjected:
      inputs.runMeta !== null ? boolOrNull(inputs.runMeta.stage5ToolUseDisciplineInjected) : null,
    editedFiles,
    firstPatchPaths: editedFiles,
  };
}

// Pick the run to classify on: prefer the strict-gated run, else the first run that
// has BOTH ordered telemetry and a Capsule, else the first run, else null.
export function pickFocusRun(runs: readonly AstropyRunDiagnostic[]): AstropyRunDiagnostic | null {
  if (runs.length === 0) return null;
  const strict = runs.find((r) => r.runLabel.includes("strictgated"));
  if (strict) return strict;
  const full = runs.find((r) => r.orderedTelemetryAvailable && r.capsuleAvailable);
  if (full) return full;
  return runs[0]!;
}

// Conservative, deterministic classification. Precedence is rooted in causality: a
// top pivot that misses the edited file is upstream of (and bloats) the Capsule, so
// noisy ranking outranks an over-large budget; both are reported, the rest follow.
export function classifyAstropy(
  focus: AstropyRunDiagnostic | null,
  medians: StrictSetMedians,
  threshold: number,
): AstropyClassification {
  if (focus === null) {
    return {
      primaryIssue: "insufficient_evidence",
      secondaryIssues: [],
      focusRunLabel: null,
      rationale: ["No Astropy run directories were found to analyze."],
    };
  }

  const hasTelemetry = focus.orderedTelemetryAvailable;
  const hasPivots = (focus.pivotCount ?? 0) > 0;
  const rationale: string[] = [];

  if (!hasTelemetry && !hasPivots) {
    rationale.push(
      `Focus run \`${focus.runLabel}\` has neither ordered telemetry nor a parseable Capsule; nothing can be attributed.`,
    );
    return { primaryIssue: "insufficient_evidence", secondaryIssues: [], focusRunLabel: focus.runLabel, rationale };
  }

  // Individual signals.
  const noisy = hasPivots && focus.editedFiles.length > 0 && focus.topPivotInEditedFiles === false;
  const capsuleBig = focus.capsuleTokenEstimate !== null && focus.capsuleTokenEstimate > threshold;
  const deferredUnder =
    focus.deferredRefCount !== null &&
    medians.deferredRefMedian !== null &&
    focus.deferredRefCount < medians.deferredRefMedian;
  const looping =
    focus.toolCallSummary !== null &&
    (focus.toolCallSummary.longBashLoopHeuristic || focus.toolCallSummary.repeatedSearchHeuristic);

  const secondary: PrimaryIssue[] = [];
  const pushSecondary = (issue: PrimaryIssue, why: string): void => {
    secondary.push(issue);
    rationale.push(why);
  };

  let primaryIssue: PrimaryIssue;
  if (noisy) {
    primaryIssue = "noisy_pivot_ranking";
    rationale.push(
      `Top pivot \`${focus.topPivotPath}\` is not in the eventually edited file(s) [${focus.editedFiles.join(", ") || "—"}].`,
    );
    if (capsuleBig)
      pushSecondary("capsule_budget_too_large", `Capsule budget ${focus.capsuleTokenEstimate} tokens exceeds ${threshold}.`);
    if (deferredUnder)
      pushSecondary(
        "deferred_refs_underused",
        `Deferred refs ${focus.deferredRefCount} below strict-set median ${medians.deferredRefMedian}.`,
      );
    if (looping) pushSecondary("agent_looping", "A loop heuristic tripped in ordered telemetry.");
  } else if (capsuleBig) {
    primaryIssue = "capsule_budget_too_large";
    rationale.push(`Capsule budget ${focus.capsuleTokenEstimate} tokens exceeds ${threshold}, with top pivot inside the edited file.`);
    if (deferredUnder)
      pushSecondary(
        "deferred_refs_underused",
        `Deferred refs ${focus.deferredRefCount} below strict-set median ${medians.deferredRefMedian}.`,
      );
    if (looping) pushSecondary("agent_looping", "A loop heuristic tripped in ordered telemetry.");
  } else if (looping) {
    primaryIssue = "agent_looping";
    rationale.push("A loop heuristic tripped in ordered telemetry while pivots/budget look reasonable.");
  } else if (deferredUnder) {
    primaryIssue = "deferred_refs_underused";
    rationale.push(`Deferred refs ${focus.deferredRefCount} below strict-set median ${medians.deferredRefMedian}.`);
  } else if (focus.resolved === false && hasTelemetry && hasPivots) {
    primaryIssue = "patch_mistake_despite_good_context";
    rationale.push("Run is unresolved but pivots overlap the edit, the Capsule is within budget, and no loop tripped.");
  } else {
    primaryIssue = "insufficient_evidence";
    rationale.push("No single signal dominates and the run resolved or evidence is inconclusive.");
  }

  return { primaryIssue, secondaryIssues: secondary, focusRunLabel: focus.runLabel, rationale };
}

// Recommend exactly one next change. If the relevant runs lack ordered telemetry we
// prefer recommendation 4 (gather a fresh run) over implementing a ranking change.
export function chooseRecommendation(
  classification: AstropyClassification,
  focus: AstropyRunDiagnostic | null,
): AstropyRecommendation {
  const telemetryMissing = focus === null || !focus.orderedTelemetryAvailable;
  if (classification.primaryIssue === "insufficient_evidence" || telemetryMissing) {
    return {
      id: 4,
      title: "No change yet — gather a fresh Astropy strict run",
      body: "Evidence is insufficient or ordered telemetry is missing for the relevant Astropy run(s). Run one fresh Astropy strict run now that universal telemetry is enabled before changing ranking.",
    };
  }
  if (classification.primaryIssue === "noisy_pivot_ranking") {
    return {
      id: 1,
      title: "Pivot ranking fix",
      body: "Prefer implementation pivots that are referenced by multiple evidence types and down-rank broad/noisy paths, so the eventually-edited file is not demoted below an unrelated, large-snippet candidate.",
    };
  }
  if (classification.primaryIssue === "capsule_budget_too_large") {
    return {
      id: 2,
      title: "Capsule budget fix",
      body: "Cap large snippets and push lower-ranked context into deferred refs, so a single large pivot snippet cannot dominate the Capsule budget.",
    };
  }
  if (classification.primaryIssue === "deferred_refs_underused") {
    return {
      id: 3,
      title: "Deferred-ref fix",
      body: "Make high-confidence deferred refs easier/cheaper to inspect without expanding broad context.",
    };
  }
  // agent_looping / patch_mistake_despite_good_context: no ranking/budget change is
  // warranted from this evidence; gather a fresh, fully-instrumented run first.
  return {
    id: 4,
    title: "No change yet — gather a fresh Astropy strict run",
    body: "The primary signal does not point at a ranking/budget change. Capture a fresh fully-instrumented Astropy strict run before acting.",
  };
}

export const ASTROPY_DIAGNOSTIC_NON_CLAIMS: readonly string[] = [
  "This report does not re-run agents or Docker.",
  "This report does not change retrieval, ranking, Capsule generation, or prompt behavior.",
  "This report does not prove Astropy is representative of all noisy retrieval failures.",
  "Missing telemetry is reported as missing, not reconstructed.",
  "Per-snippet token figures are char-derived heuristics; only each Capsule's own budget line is treated as an authoritative token count.",
];

// Assemble the full diagnostic from per-run diagnostics + the strict-set medians (pure).
export function buildAstropyDiagnostic(
  resultsDir: string,
  runs: AstropyRunDiagnostic[],
  medians: StrictSetMedians,
  missingArtifacts: string[],
): AstropyDiagnostic {
  const focus = pickFocusRun(runs);
  const classification = classifyAstropy(focus, medians, CAPSULE_TOKEN_BUDGET_THRESHOLD);
  const recommendedNextChange = chooseRecommendation(classification, focus);
  return {
    resultsDir,
    capsuleTokenBudgetThreshold: CAPSULE_TOKEN_BUDGET_THRESHOLD,
    runsAnalyzed: runs,
    focusRunLabel: focus?.runLabel ?? null,
    strictSetMedians: medians,
    classification,
    recommendedNextChange,
    missingArtifacts,
    nonClaims: [...ASTROPY_DIAGNOSTIC_NON_CLAIMS],
  };
}

// ---------------------------------------------------------------------------
// Disk layer
// ---------------------------------------------------------------------------

async function readText(file: string): Promise<string | null> {
  return readFile(file, "utf8").then(
    (text) => text,
    () => null,
  );
}

async function readJson(file: string): Promise<unknown> {
  const text = await readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function listSubdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

// Find the single condition sub-directory under <runDir>/raw (e.g. "vtrace").
async function findRawConditionDir(runDir: string): Promise<{ condition: string; dir: string } | null> {
  const raw = path.join(runDir, "raw");
  const conditions = await listSubdirs(raw);
  if (conditions.length === 0) return null;
  // Prefer "vtrace"; else take the first.
  const condition = conditions.includes("vtrace") ? "vtrace" : conditions[0]!;
  return { condition, dir: path.join(raw, condition) };
}

// Locate the per-run `_tool_calls.json` and coerce it to OrderedToolCall[]; null when absent.
function coerceToolCalls(value: unknown): OrderedToolCall[] | null {
  if (!Array.isArray(value)) return null;
  const calls: OrderedToolCall[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    calls.push({
      index: typeof entry.index === "number" ? entry.index : calls.length,
      tool: typeof entry.tool === "string" ? entry.tool : "unknown",
      category: (entry.category as OrderedToolCall["category"]) ?? "other",
      path: typeof entry.path === "string" ? entry.path : null,
      query: typeof entry.query === "string" ? entry.query : null,
      args: isRecord(entry.args) ? entry.args : {},
      output_summary: typeof entry.output_summary === "string" ? entry.output_summary : null,
    });
  }
  return calls;
}

// Build a label → {resolved, totalTokens, costUsd} index from the strict-gated
// 10-task report, covering each task's baseline / oldVtrace / risk / strict labels.
function reportOutcomeIndex(report: unknown): Map<string, { resolved: boolean | null; totalTokens: number | null; costUsd: number | null }> {
  const index = new Map<string, { resolved: boolean | null; totalTokens: number | null; costUsd: number | null }>();
  if (!isRecord(report) || !Array.isArray(report.tasks)) return index;
  for (const task of report.tasks) {
    if (!isRecord(task)) continue;
    const pairs: Array<[unknown, unknown]> = [
      [task.strictLabel, task.strict],
      [task.riskLabel, task.risk],
      [task.baselineLabel, task.baseline],
      [task.oldVtraceLabel, task.oldVtrace],
    ];
    for (const [label, block] of pairs) {
      if (typeof label !== "string" || !isRecord(block)) continue;
      // Don't overwrite a more-specific label (strict) with a duplicate baseline label.
      if (index.has(label)) continue;
      index.set(label, {
        resolved: boolOrNull(block.resolved),
        totalTokens: numberOrNull(block.totalTokens),
        costUsd: numberOrNull(block.costUsd),
      });
    }
  }
  return index;
}

// Compute the strict 10-task-set Capsule medians from the strict run snapshots.
async function loadStrictSetMedians(resultsDir: string): Promise<StrictSetMedians> {
  const runsRoot = path.join(resultsDir, "runs");
  const labels = (await listSubdirs(runsRoot)).filter((label) => label.startsWith("eval-strictgated-vtrace-"));
  const perTask: StrictSetTaskCapsule[] = [];
  for (const label of labels.sort()) {
    const snapshot = await readText(path.join(runsRoot, label, "_vtrace_instructions.snapshot.md"));
    const capsule = parseCapsuleSnapshot(snapshot);
    const instanceId = label.replace("eval-strictgated-vtrace-", "");
    perTask.push({
      instanceId,
      capsuleTokens: capsule.budgetTokensUsed,
      capsuleItems: capsule.available ? capsule.capsuleItemCount : null,
      deferredRefs: capsule.available ? capsule.deferredRefs.length : null,
    });
  }
  const tokenVals = perTask.map((t) => t.capsuleTokens).filter((v): v is number => v !== null);
  const itemVals = perTask.map((t) => t.capsuleItems).filter((v): v is number => v !== null);
  const deferredVals = perTask.map((t) => t.deferredRefs).filter((v): v is number => v !== null);
  return {
    taskCount: perTask.length,
    capsuleTokenMedian: median(tokenVals),
    capsuleItemMedian: median(itemVals),
    deferredRefMedian: median(deferredVals),
    perTask,
  };
}

// Discover and load every Astropy run, then build the diagnostic.
export async function loadAstropyDiagnostic(resultsDir: string): Promise<AstropyDiagnostic> {
  const missingArtifacts: string[] = [];
  const runsRoot = path.join(resultsDir, "runs");

  const report = await readJson(path.join(resultsDir, "stage5_strictgated_10task_report.json"));
  if (report === null) missingArtifacts.push("stage5_strictgated_10task_report.json");
  const outcomeIndex = reportOutcomeIndex(report);

  const allLabels = await listSubdirs(runsRoot);
  const astropyLabels = allLabels.filter((label) => matchesAstropy(label, null)).sort();
  if (astropyLabels.length === 0) missingArtifacts.push("runs/*astropy-14369* (no Astropy run directories found)");

  const runs: AstropyRunDiagnostic[] = [];
  for (const label of astropyLabels) {
    const runDir = path.join(runsRoot, label);
    const snapshotMd = await readText(path.join(runDir, "_vtrace_instructions.snapshot.md"));
    const raw = await findRawConditionDir(runDir);
    const condition = raw?.condition ?? "unknown";
    const toolCalls = raw === null ? null : coerceToolCalls(await readJson(path.join(raw.dir, "_tool_calls.json")));
    const evalMeta = raw === null ? null : ((await readJson(path.join(raw.dir, "_eval.meta.json"))) as Record<string, unknown> | null);
    const runMeta = raw === null ? null : ((await readJson(path.join(raw.dir, "_run.meta.json"))) as Record<string, unknown> | null);
    const instanceId =
      Array.isArray(runMeta?.instances) && typeof runMeta?.instances[0] === "string"
        ? (runMeta.instances[0] as string)
        : ASTROPY_INSTANCE_ID;
    runs.push(
      analyzeAstropyRun({
        runLabel: label,
        condition,
        instanceId,
        snapshotMd,
        toolCalls,
        evalMeta,
        runMeta,
        reportOutcome: outcomeIndex.get(label) ?? null,
      }),
    );
  }

  const medians = await loadStrictSetMedians(resultsDir);
  if (medians.taskCount === 0) missingArtifacts.push("runs/eval-strictgated-vtrace-* (no strict-set snapshots for medians)");

  return buildAstropyDiagnostic(resultsDir, runs, medians, missingArtifacts);
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function fmtCost(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

function fmtTokens(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

function fmtNum(value: number | null): string {
  return value === null ? "—" : String(value);
}

function yesNo(value: boolean | null): string {
  return value === null ? "—" : value ? "yes" : "no";
}

export function renderAstropyDiagnosticMarkdown(diag: AstropyDiagnostic): string {
  const lines: string[] = [];
  const focus = diag.runsAnalyzed.find((r) => r.runLabel === diag.focusRunLabel) ?? null;

  lines.push("# Stage 5 Astropy pivot diagnostic", "");

  lines.push("## Summary", "");
  lines.push(`- Results dir: \`${diag.resultsDir}\``);
  lines.push(`- Instance: \`${ASTROPY_INSTANCE_ID}\``);
  lines.push(`- Astropy runs analyzed: ${diag.runsAnalyzed.length}`);
  lines.push(`- Focus run: \`${diag.focusRunLabel ?? "—"}\``);
  lines.push(`- Primary classification: **${diag.classification.primaryIssue}**`);
  lines.push(
    `- Secondary: ${diag.classification.secondaryIssues.length > 0 ? diag.classification.secondaryIssues.join(", ") : "none"}`,
  );
  lines.push(`- Recommended next change: **#${diag.recommendedNextChange.id} — ${diag.recommendedNextChange.title}**`);
  if (diag.missingArtifacts.length > 0) lines.push(`- Missing artifacts: ${diag.missingArtifacts.join("; ")}`);
  lines.push("");

  lines.push("## Runs analyzed", "");
  if (diag.runsAnalyzed.length === 0) {
    lines.push("_No Astropy run directories found._", "");
  } else {
    lines.push("| run-label | condition | resolved | telemetry | capsule tok | items | pivots | top pivot | top∈edit |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const run of diag.runsAnalyzed) {
      lines.push(
        `| ${run.runLabel} | ${run.condition} | ${yesNo(run.resolved)} | ${run.orderedTelemetryAvailable ? "ordered" : "missing"} | ${fmtNum(run.capsuleTokenEstimate)} | ${fmtNum(run.capsuleItemCount)} | ${fmtNum(run.pivotCount)} | ${run.topPivotPath ?? "—"} | ${yesNo(run.topPivotInEditedFiles)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Outcome and cost", "");
  lines.push("| run-label | resolved | cost | tokens | source | turns/tools |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const run of diag.runsAnalyzed) {
    const tools = run.toolCallSummary
      ? `bash ${run.toolCallSummary.bashToolCalls} / grep ${run.toolCallSummary.grepLikeToolCalls} / read ${run.toolCallSummary.fileReadToolCalls}`
      : "—";
    lines.push(
      `| ${run.runLabel} | ${yesNo(run.resolved)} | ${fmtCost(run.totalCostUsd)} | ${fmtTokens(run.totalTokens)} | ${run.costTokenSource} | ${tools} |`,
    );
  }
  lines.push("");

  lines.push("## Pivot evidence", "");
  if (focus === null) {
    lines.push("_No focus run to report pivots for._", "");
  } else {
    lines.push(`Focus run: \`${focus.runLabel}\` (condition \`${focus.condition}\`).`, "");
    lines.push(`- Top pivot: \`${focus.topPivotPath ?? "—"}\``);
    lines.push(`- All pivots: ${focus.pivotPaths.length > 0 ? focus.pivotPaths.map((p) => `\`${p}\``).join(", ") : "—"}`);
    lines.push(`- Edited file(s): ${focus.editedFiles.length > 0 ? focus.editedFiles.map((p) => `\`${p}\``).join(", ") : "—"}`);
    lines.push(`- Top pivot concentrated in edited file: ${yesNo(focus.topPivotInEditedFiles)}`);
    const docsTestPivots = focus.pivotPaths.filter((p) => /(^|\/)(tests?|docs?|conf|setup)(\/|\.|$)/i.test(p));
    lines.push(
      `- Pivots pointing at tests/docs/config rather than implementation: ${docsTestPivots.length > 0 ? docsTestPivots.map((p) => `\`${p}\``).join(", ") : "none"}`,
    );
    lines.push("");
    // Cross-run pivot-ordering comparison (resolved vs unresolved) when available.
    lines.push("Cross-run top-pivot ordering (resolved vs unresolved):", "");
    lines.push("| run-label | resolved | top pivot | top∈edit |");
    lines.push("| --- | --- | --- | --- |");
    const capsuleRuns = diag.runsAnalyzed.filter((r) => r.capsuleAvailable);
    for (const run of capsuleRuns) {
      lines.push(`| ${run.runLabel} | ${yesNo(run.resolved)} | ${run.topPivotPath ?? "—"} | ${yesNo(run.topPivotInEditedFiles)} |`);
    }
    lines.push("");
    // Conservative caveat: the ordering↔outcome link is correlational. If any
    // capsule run shares the focus's top-pivot file yet differs in outcome, say so.
    const focusTop = focus.topPivotPath;
    if (focusTop !== null) {
      const resolvedWithFocusTop = capsuleRuns.some((r) => r.resolved === true && r.topPivotPath === focusTop);
      const otherTops = new Set(capsuleRuns.map((r) => r.topPivotPath).filter((p) => p !== focusTop && p !== null));
      const resolvedWithOtherTop = capsuleRuns.some((r) => r.resolved === true && r.topPivotPath !== focusTop);
      const unresolvedWithOtherTop = capsuleRuns.some((r) => r.resolved === false && otherTops.has(r.topPivotPath));
      if (resolvedWithOtherTop || unresolvedWithOtherTop || resolvedWithFocusTop) {
        lines.push(
          "Caveat: the ordering↔outcome relationship is correlational, not proven causal. " +
            "Among the Astropy runs, top-pivot ordering co-varies with outcome but at least one run with a different/better top pivot still failed (and/or one resolved), so good ordering appears necessary-but-not-sufficient.",
          "",
        );
      }
    }
  }

  lines.push("## Capsule budget evidence", "");
  lines.push("| run-label | capsule tok | budget | items | snippet tok* | largest snippet | largest tok* |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const run of diag.runsAnalyzed) {
    lines.push(
      `| ${run.runLabel} | ${fmtNum(run.capsuleTokenEstimate)} | ${fmtNum(run.capsuleTokenBudget)} | ${fmtNum(run.capsuleItemCount)} | ${fmtNum(run.capsuleSnippetTokenEstimateHeuristic)} | ${run.largestSnippetPath ?? "—"} | ${fmtNum(run.largestSnippetTokenEstimateHeuristic)} |`,
    );
  }
  lines.push("");
  lines.push(
    `Strict 10-task-set medians (n=${diag.strictSetMedians.taskCount}): capsule tokens ${fmtNum(diag.strictSetMedians.capsuleTokenMedian)}, items ${fmtNum(diag.strictSetMedians.capsuleItemMedian)}, deferred refs ${fmtNum(diag.strictSetMedians.deferredRefMedian)}. Threshold for "too large": ${diag.capsuleTokenBudgetThreshold} tokens.`,
  );
  if (focus !== null && focus.capsuleTokenEstimate !== null && diag.strictSetMedians.capsuleTokenMedian !== null) {
    const ratio = focus.capsuleTokenEstimate / diag.strictSetMedians.capsuleTokenMedian;
    lines.push(`Focus Capsule is ${ratio.toFixed(2)}× the strict-set median capsule-token count.`);
  }
  lines.push("");
  lines.push("\\* snippet token figures are char-derived heuristics, not measured tokens.", "");

  lines.push("## Deferred reference evidence", "");
  lines.push("| run-label | deferred refs | deferred paths | expanded |");
  lines.push("| --- | --- | --- | --- |");
  for (const run of diag.runsAnalyzed) {
    lines.push(
      `| ${run.runLabel} | ${fmtNum(run.deferredRefCount)} | ${run.deferredRefPaths.length > 0 ? run.deferredRefPaths.join(", ") : "—"} | ${fmtNum(run.expandedDeferredRefCount)} |`,
    );
  }
  lines.push("");
  if (focus !== null && focus.deferredRefCount !== null && diag.strictSetMedians.deferredRefMedian !== null) {
    lines.push(
      `Focus run has ${focus.deferredRefCount} deferred ref(s) vs strict-set median ${diag.strictSetMedians.deferredRefMedian}.`,
      "",
    );
  }

  lines.push("## Tool-loop evidence", "");
  if (focus === null || focus.toolCallSummary === null) {
    lines.push(
      focus === null
        ? "_No focus run._"
        : "Ordered telemetry is missing for the focus run; loop behavior is NOT inferred from raw logs.",
      "",
    );
  } else {
    const s = focus.toolCallSummary;
    lines.push(`Focus run \`${focus.runLabel}\` ordered telemetry:`, "");
    lines.push(`- bashToolCalls: ${s.bashToolCalls}`);
    lines.push(`- grepLikeToolCalls: ${s.grepLikeToolCalls}`);
    lines.push(`- fileReadToolCalls: ${s.fileReadToolCalls}`);
    lines.push(`- longBashLoopHeuristic: ${s.longBashLoopHeuristic ? "yes" : "no"}`);
    lines.push(`- repeatedSearchHeuristic: ${s.repeatedSearchHeuristic ? "yes" : "no"}`);
    lines.push("");
  }

  lines.push("## Classification", "");
  lines.push(`- Primary issue: **${diag.classification.primaryIssue}**`);
  lines.push(
    `- Secondary issues: ${diag.classification.secondaryIssues.length > 0 ? diag.classification.secondaryIssues.join(", ") : "none"}`,
  );
  for (const reason of diag.classification.rationale) lines.push(`- ${reason}`);
  lines.push("");

  lines.push("## Recommended next change", "");
  lines.push(`**#${diag.recommendedNextChange.id} — ${diag.recommendedNextChange.title}**`, "");
  lines.push(diag.recommendedNextChange.body, "");

  lines.push("## Non-claims", "");
  for (const claim of diag.nonClaims) lines.push(`- ${claim}`);
  lines.push("");

  return lines.join("\n");
}

export async function runAstropyPivotDiagnostic(resultsDir: string): Promise<AstropyDiagnostic> {
  const diag = await loadAstropyDiagnostic(resultsDir);
  await writeFile(path.join(resultsDir, ASTROPY_DIAGNOSTIC_JSON_FILENAME), `${JSON.stringify(diag, null, 2)}\n`);
  await writeFile(path.join(resultsDir, ASTROPY_DIAGNOSTIC_MD_FILENAME), renderAstropyDiagnosticMarkdown(diag));
  return diag;
}

export function parseResultsDir(argv: readonly string[]): string {
  for (const flag of ["--results", "--out"]) {
    const index = argv.indexOf(flag);
    if (index >= 0 && argv[index + 1] !== undefined) return path.resolve(argv[index + 1] as string);
  }
  return path.resolve(DEFAULT_RESULTS_DIR);
}

if (import.meta.main) {
  const resultsDir = parseResultsDir(process.argv.slice(2));
  runAstropyPivotDiagnostic(resultsDir)
    .then((diag) => {
      process.stdout.write(
        `Stage 5 Astropy pivot diagnostic: ${diag.runsAnalyzed.length} run(s); primary=${diag.classification.primaryIssue}; ` +
          `recommendation #${diag.recommendedNextChange.id} (${diag.recommendedNextChange.title}).\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    });
}
