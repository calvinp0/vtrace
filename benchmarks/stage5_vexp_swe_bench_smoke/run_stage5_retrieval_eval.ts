// Stage 5R — deterministic Capsule v2 retrieval-quality evaluation.
//
// WHY THIS EXISTS
// ----------------
// The LIVE Stage 5 token/cost benchmark is noisy and expensive: Claude
// overloads, cache variance, Docker, and agent-execution cost. Before paying for
// that, Stage 5R measures the thing vtrace actually controls — RETRIEVAL QUALITY —
// with NO Claude, NO Docker, NO vexp agent run, NO API calls. It is deterministic:
// given an indexed workspace and a fixed fixture of known-edited files/symbols
// (from real evaluated gold patches), it asks one question per instance:
//
//   Does Capsule v2 put the known edited file/symbol in the top-1 pivot, the
//   top-3 selected items, support, discarded, or nowhere (missing)?
//
// PRODUCT FRAMING
// ----------------
//   pivot    = likely edit site
//   support  = useful context, not the first edit target
//   discard  = test/generic/noisy/over-budget candidate
//   missing  = not surfaced at all
//
// CRITICAL RULE: the expected_files / expected_symbols are EVALUATION LABELS only.
// They are read from the fixture to SCORE the capsule; they are NEVER passed into
// Capsule v2 retrieval. Production retrieval sees only (task, intent, budget).

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import {
  CapsuleIntent,
  parseCapsuleIntent,
  type CapsuleV2Result,
} from "../../src/capsuleV2/types";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * Where the expected labels came from. GOLD labels (the SWE-bench reference
 * `patch`) are preferred. `passing_model_patch` labels are derived from an
 * evaluated `modelPatch` that PASSED — useful, but kept separate because a
 * passing patch may represent a valid ALTERNATIVE fix (a different edit site
 * than the gold one), so a Capsule "miss" against it is not necessarily a real
 * retrieval miss. `manual_verified` labels were curated and checked by hand.
 */
export type LabelSource = "gold_patch" | "passing_model_patch" | "manual_verified";

export const LABEL_SOURCES: readonly LabelSource[] = ["gold_patch", "passing_model_patch", "manual_verified"];

export function isLabelSource(value: unknown): value is LabelSource {
  return typeof value === "string" && (LABEL_SOURCES as readonly string[]).includes(value);
}

export interface RetrievalEvalFixtureEntry {
  readonly instance_id: string;
  readonly repo: string;
  /** Repo-relative or absolute path to the indexed workspace (contains .vtrace). */
  readonly workspace: string;
  /** The task/problem prose handed to Capsule v2 — never the expected labels. */
  readonly task: string;
  readonly intent: string;
  readonly budget: number;
  /** Provenance of the expected labels (gold preferred). Required. */
  readonly label_source: LabelSource;
  /** Evaluation labels (edited files). Scoring only — never fed into retrieval. */
  readonly expected_files: readonly string[];
  /** Evaluation labels (edited symbols, optionally `Class.method`). Scoring only. */
  readonly expected_symbols: readonly string[];
  /** Set true to permit a repeated instance_id (e.g. a gold + alternative label row). */
  readonly allow_duplicate?: boolean;
  readonly notes?: string;
}

// Load + validate a JSON-array fixture. A malformed row is a hard error: we never
// fabricate an expected label or silently drop a target. A repeated instance_id
// is rejected unless every copy past the first sets `allow_duplicate: true` (used
// when a single instance carries both a gold and an alternative-fix label row).
export async function loadRetrievalFixture(filePath: string): Promise<RetrievalEvalFixtureEntry[]> {
  const content = await readFile(filePath, "utf8").catch(() => null);
  if (content === null) {
    throw new Error(`Retrieval fixture not found at ${filePath}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Retrieval fixture ${filePath} is not valid JSON: ${String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Retrieval fixture ${filePath} must be a JSON array.`);
  }
  const entries = parsed.map((value, index) => validateFixtureEntry(value, index));
  assertNoUnexpectedDuplicates(entries);
  return entries;
}

// A repeated instance_id is only allowed when the repeat opts in via
// `allow_duplicate`. The FIRST occurrence need not set the flag; the repeats must.
export function assertNoUnexpectedDuplicates(entries: readonly RetrievalEvalFixtureEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.instance_id) && entry.allow_duplicate !== true) {
      throw new Error(
        `Duplicate instance_id ${entry.instance_id} in fixture; set "allow_duplicate": true on the repeat to allow it.`,
      );
    }
    seen.add(entry.instance_id);
  }
}

export function validateFixtureEntry(value: unknown, index: number): RetrievalEvalFixtureEntry {
  if (!isRecord(value)) {
    throw new Error(`Fixture entry ${index} is not an object.`);
  }
  const id = value.instance_id;
  if (!isString(id)) {
    throw new Error(`Fixture entry ${index} is missing instance_id.`);
  }
  if (!isString(value.repo)) {
    throw new Error(`Fixture entry ${id} is missing repo.`);
  }
  if (!isString(value.workspace)) {
    throw new Error(`Fixture entry ${id} is missing workspace.`);
  }
  if (!isString(value.task)) {
    throw new Error(`Fixture entry ${id} is missing task.`);
  }
  const expectedFiles = Array.isArray(value.expected_files) ? value.expected_files.filter(isString) : [];
  if (expectedFiles.length === 0) {
    throw new Error(`Fixture entry ${id} must list at least one expected_files entry.`);
  }
  if (value.label_source !== undefined && !isLabelSource(value.label_source)) {
    throw new Error(
      `Fixture entry ${id} has an invalid label_source "${String(value.label_source)}" `
      + `(expected one of ${LABEL_SOURCES.join(", ")}).`,
    );
  }
  return {
    instance_id: id,
    repo: value.repo,
    workspace: value.workspace,
    task: value.task,
    intent: isString(value.intent) ? value.intent : "auto",
    budget: isNumber(value.budget) ? value.budget : 8000,
    // GOLD is preferred; a row that omits the source is treated as hand-curated
    // (the original five were authored before the field existed). The on-disk
    // validator (validateFixtureOnDisk) flags an absent source explicitly.
    label_source: isLabelSource(value.label_source) ? value.label_source : "manual_verified",
    expected_files: expectedFiles,
    expected_symbols: Array.isArray(value.expected_symbols) ? value.expected_symbols.filter(isString) : [],
    ...(value.allow_duplicate === true ? { allow_duplicate: true as const } : {}),
    ...(isString(value.notes) ? { notes: value.notes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Fixture validation against disk (requirement: workspace + label sanity)
// ---------------------------------------------------------------------------

export interface FixtureValidationIssue {
  readonly instance_id: string;
  readonly severity: "error" | "warning";
  readonly check:
    | "workspace_missing"
    | "workspace_not_indexed"
    | "expected_file_absolute"
    | "expected_file_escapes_repo"
    | "expected_file_not_in_workspace"
    | "task_empty"
    | "label_source_missing"
    | "duplicate_instance";
  readonly detail: string;
}

// Validate a fixture against the filesystem. This is the requirement-4 gate:
//   - workspace path exists and is indexed
//   - expected files are repo-relative (not absolute, no `..` escape)
//   - expected files exist inside the workspace
//   - task is non-empty
//   - a label source is declared
//   - no duplicate instance IDs unless explicitly allowed
// Expected files are checked for EXISTENCE only — they are never read into or
// passed to retrieval. The `rawHadLabelSource` set carries which rows declared a
// label_source in the source JSON (parsing defaults a missing one, so existence
// must be judged on the raw object).
export async function validateFixtureOnDisk(
  entries: readonly RetrievalEvalFixtureEntry[],
  rawHadLabelSource: ReadonlySet<string>,
): Promise<FixtureValidationIssue[]> {
  const issues: FixtureValidationIssue[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const push = (severity: FixtureValidationIssue["severity"], check: FixtureValidationIssue["check"], detail: string) =>
      issues.push({ instance_id: entry.instance_id, severity, check, detail });

    if (seen.has(entry.instance_id) && entry.allow_duplicate !== true) {
      push("error", "duplicate_instance", `repeated instance_id without allow_duplicate`);
    }
    seen.add(entry.instance_id);

    if (entry.task.trim().length === 0) push("error", "task_empty", "task is empty");
    if (!rawHadLabelSource.has(entry.instance_id)) {
      push("warning", "label_source_missing", `no label_source declared (defaulted to manual_verified)`);
    }

    const workspace = path.resolve(entry.workspace);
    const workspaceExists = await pathExists(workspace);
    if (!workspaceExists) {
      push("error", "workspace_missing", `workspace not found: ${entry.workspace}`);
    } else if (!(await pathExists(path.join(workspace, INDEX_RELPATH)))) {
      push("error", "workspace_not_indexed", `workspace not indexed (no ${INDEX_RELPATH})`);
    }

    for (const file of entry.expected_files) {
      if (path.isAbsolute(file)) {
        push("error", "expected_file_absolute", `expected file is absolute: ${file}`);
        continue;
      }
      const normalized = normalizeFilePath(file);
      if (normalized.split("/").includes("..")) {
        push("error", "expected_file_escapes_repo", `expected file escapes repo: ${file}`);
        continue;
      }
      if (workspaceExists && !(await pathExists(path.join(workspace, normalized)))) {
        push("error", "expected_file_not_in_workspace", `expected file not found in workspace: ${file}`);
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Capsule summary (the role-ordered selection scoring works over)
// ---------------------------------------------------------------------------

export interface SelectedItem {
  readonly role: "pivot" | "support";
  readonly path: string;
  readonly symbol: string;
  readonly fqName: string;
  readonly final: number;
  /** The decisive justification for this role (caller vs helper vs infra). */
  readonly roleReason: string;
  /** Role signals used by the miss taxonomy (entry-point vs generic infra). */
  readonly isEntryPoint: boolean;
  readonly isGenericInfrastructure: boolean;
}

export interface DiscardedItem {
  readonly path: string;
  readonly symbol: string;
  readonly fqName: string;
  readonly reason: string;
}

export interface CapsuleSummary {
  readonly intent: string;
  readonly actualMode: string;
  readonly budgetTokens: number;
  readonly estimatedTokens: number;
  readonly usedPercent: number;
  /** Pivots first, then support — the order the agent would read top-down. */
  readonly pivots: readonly SelectedItem[];
  readonly support: readonly SelectedItem[];
  readonly discarded: readonly DiscardedItem[];
  readonly candidateCount: number | null;
  /** The subsystem root the debug refinement inferred (for wrong-subsystem misses). */
  readonly subsystemRoot: string | null;
  /** Whether a task file-line anchor resolved to a symbol (for anchor misses). */
  readonly lineAnchorResolutionUsed: boolean;
}

// Project a Capsule v2 result onto the summary the scorer needs. Works on the
// typed builder result (live path) — the same shape the `--json` surface emits.
export function summarizeCapsule(result: CapsuleV2Result): CapsuleSummary {
  const toSelected = (role: "pivot" | "support") =>
    (item: CapsuleV2Result["pivots"][number]): SelectedItem => ({
      role,
      path: item.path,
      symbol: item.symbol,
      fqName: item.fq_name,
      final: item.scorecard.final,
      roleReason: item.role_reason,
      isEntryPoint: item.is_entry_point,
      isGenericInfrastructure: item.is_generic_infrastructure,
    });
  return {
    intent: result.intent,
    actualMode: result.actual_mode,
    budgetTokens: result.budget.max_tokens,
    estimatedTokens: result.budget.estimated_tokens,
    usedPercent: result.budget.used_percent,
    pivots: result.pivots.map(toSelected("pivot")),
    support: result.support.map(toSelected("support")),
    discarded: result.discarded.map((item) => ({
      path: item.path,
      symbol: item.symbol,
      // CapsuleV2Discarded carries no fq_name; the bare symbol name is enough for
      // discarded-symbol matching.
      fqName: "",
      reason: item.discard_reason,
    })),
    candidateCount: result.diagnostics.candidate_count,
    subsystemRoot: result.diagnostics.subsystem_root ?? null,
    lineAnchorResolutionUsed: result.diagnostics.line_anchor_resolution_used ?? false,
  };
}

// ---------------------------------------------------------------------------
// Scoring (pure)
// ---------------------------------------------------------------------------

export function normalizeFilePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

// Boundary-aware repo-relative file match (so "/utils.py" does not match
// "admindocs_utils.py", but a workspace-prefixed candidate still matches the
// gold path).
export function fileMatches(expected: string, candidate: string): boolean {
  const exp = normalizeFilePath(expected);
  const cand = normalizeFilePath(candidate);
  if (exp.length === 0 || cand.length === 0) return false;
  if (exp === cand) return true;
  return cand.endsWith(`/${exp}`) || exp.endsWith(`/${cand}`);
}

// Match an expected (possibly `Class.method`) symbol to a capsule item. Accepts
// the bare method name (capsule items carry local names), the exact name, or an
// fq-name suffix — so "ModelAdmin.get_inline_instances" matches a
// "get_inline_instances" method item.
export function symbolMatches(expected: string, item: { symbol: string; fqName: string }): boolean {
  const exp = expected.trim();
  if (exp.length === 0) return false;
  const last = exp.split(".").pop() ?? exp;
  if (item.symbol === exp || item.symbol === last) return true;
  const fq = (item.fqName ?? "").replace(/::/g, ".");
  if (fq.length === 0) return false;
  return fq === exp || fq.endsWith(`.${exp}`) || fq.endsWith(`.${last}`);
}

// De-duplicated file ranking: pivots first (already final-score ordered), then
// support — exactly the order an agent reads the capsule top-down.
export function rankedFiles(summary: CapsuleSummary): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...summary.pivots, ...summary.support]) {
    const file = normalizeFilePath(item.path);
    if (file.length === 0 || seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}

export type ExpectedFileRole = "pivot" | "support" | "discarded" | "missing";

export interface ExpectedFileEvaluation {
  readonly rank: number | null;
  readonly role: ExpectedFileRole;
  readonly matchedFile: string | null;
}

export function evaluateExpectedFile(
  expectedFiles: readonly string[],
  summary: CapsuleSummary,
): ExpectedFileEvaluation {
  const ranked = rankedFiles(summary);
  let bestRank: number | null = null;
  let matchedFile: string | null = null;
  for (const expected of expectedFiles) {
    const idx = ranked.findIndex((file) => fileMatches(expected, file));
    if (idx >= 0 && (bestRank === null || idx + 1 < bestRank)) {
      bestRank = idx + 1;
      matchedFile = ranked[idx] ?? null;
    }
  }
  if (bestRank !== null && matchedFile !== null) {
    // Pivots sort first, so the first selected item at the matched file carries
    // the strongest role.
    const role: ExpectedFileRole =
      [...summary.pivots, ...summary.support].find((item) => fileMatches(matchedFile as string, item.path))?.role
      ?? "support";
    return { rank: bestRank, role, matchedFile };
  }
  const discardedHit = expectedFiles.some((expected) =>
    summary.discarded.some((item) => fileMatches(expected, item.path)),
  );
  return { rank: null, role: discardedHit ? "discarded" : "missing", matchedFile: null };
}

export interface ExpectedSymbolEvaluation {
  readonly rank: number | null;
  readonly role: ExpectedFileRole;
}

export function evaluateExpectedSymbol(
  expectedSymbols: readonly string[],
  summary: CapsuleSummary,
): ExpectedSymbolEvaluation {
  if (expectedSymbols.length === 0) {
    return { rank: null, role: "missing" };
  }
  const selected = [...summary.pivots, ...summary.support];
  for (let i = 0; i < selected.length; i += 1) {
    const item = selected[i]!;
    if (expectedSymbols.some((sym) => symbolMatches(sym, item))) {
      return { rank: i + 1, role: item.role };
    }
  }
  const discardedHit = summary.discarded.some((item) =>
    expectedSymbols.some((sym) => symbolMatches(sym, item)),
  );
  return { rank: null, role: discardedHit ? "discarded" : "missing" };
}

// ---------------------------------------------------------------------------
// Miss taxonomy + top-k diagnostics (make a miss diagnosable without rerunning)
// ---------------------------------------------------------------------------

// Why an instance failed to put its expected file in the top-3. A `hit` row (the
// expected file IS top-3) carries `none`. `unknown` is the explicit escape hatch
// when no signal explains the miss — never guessed.
export type MissCategory =
  | "none"
  | "missing_from_candidates"
  | "present_but_support"
  | "present_but_discarded"
  | "wrong_subsystem"
  | "wrong_entry_point"
  | "generic_infrastructure_ranked_above_target"
  | "line_anchor_not_resolved"
  | "test_symbol_pollution"
  | "workspace_error"
  | "fixture_label_error"
  | "unknown";

export interface TopItemDiag {
  readonly path: string;
  readonly symbol: string;
  readonly role_reason: string;
}

export interface DiscardedItemDiag {
  readonly path: string;
  readonly symbol: string;
  readonly discard_reason: string;
}

export interface TopKDiagnostics {
  readonly top_pivots: readonly TopItemDiag[];
  readonly top_support: readonly TopItemDiag[];
  readonly top_discarded: readonly DiscardedItemDiag[];
}

const TOP_K = 5;

export function topKDiagnostics(summary: CapsuleSummary): TopKDiagnostics {
  const sel = (item: SelectedItem): TopItemDiag => ({
    path: normalizeFilePath(item.path),
    symbol: item.symbol,
    role_reason: item.roleReason,
  });
  return {
    top_pivots: summary.pivots.slice(0, TOP_K).map(sel),
    top_support: summary.support.slice(0, TOP_K).map(sel),
    top_discarded: summary.discarded.slice(0, TOP_K).map((item) => ({
      path: normalizeFilePath(item.path),
      symbol: item.symbol,
      discard_reason: item.reason,
    })),
  };
}

// A task carries a file-line anchor when it cites `path#Lnn` / `path:nn-mm` style
// source coordinates — used to tell a line-anchor miss apart from a plain miss.
export function taskHasLineAnchor(task: string): boolean {
  return /#L\d+/.test(task) || /\.\w+:\d+/.test(task);
}

// Classify a miss from the row + capsule signals. Deterministic, best-effort, and
// CONSERVATIVE: it only names a specific cause when a signal supports it, falling
// back to `missing_from_candidates` (the expected file never surfaced) or
// `unknown`. The order encodes precedence — the most specific cause wins.
export function classifyMiss(
  row: Pick<
    RetrievalEvalRow,
    "result" | "expected_file_role" | "contains_expected_file_top3" | "expected_files"
  >,
  summary: CapsuleSummary | null,
  task: string,
): MissCategory {
  if (row.result === "workspace_error") return "workspace_error";
  if (row.result === "fixture_error") return "fixture_label_error";
  if (row.contains_expected_file_top3) return "none";
  if (summary === null) return "unknown";

  // Present but not top-3: discarded (with the discard cause refined) or support.
  if (row.expected_file_role === "discarded") {
    const hit = summary.discarded.find((d) => row.expected_files.some((f) => fileMatches(f, d.path)));
    const reason = (hit?.reason ?? "").toLowerCase();
    if (/test/.test(reason)) return "test_symbol_pollution";
    if (/hub|generic|infra/.test(reason)) return "generic_infrastructure_ranked_above_target";
    return "present_but_discarded";
  }
  if (row.expected_file_role === "support") return "present_but_support";

  // role === "missing": the expected file is nowhere in the selection. Use the
  // capsule's own debug signals to attribute the miss.
  const topPivot = summary.pivots[0] ?? null;
  if (taskHasLineAnchor(task) && !summary.lineAnchorResolutionUsed) {
    return "line_anchor_not_resolved";
  }
  if (topPivot?.isGenericInfrastructure) return "generic_infrastructure_ranked_above_target";
  if (
    summary.subsystemRoot &&
    topPivot &&
    !pathInSubsystem(topPivot.path, summary.subsystemRoot) &&
    !row.expected_files.some((f) => pathInSubsystem(f, summary.subsystemRoot!))
  ) {
    return "wrong_subsystem";
  }
  if (
    summary.subsystemRoot &&
    !pathInSubsystem(row.expected_files[0] ?? "", summary.subsystemRoot) &&
    topPivot &&
    pathInSubsystem(topPivot.path, summary.subsystemRoot)
  ) {
    return "wrong_subsystem";
  }
  if (topPivot?.isEntryPoint) return "wrong_entry_point";
  if (summary.candidateCount !== null && summary.candidateCount > 0) {
    // Candidates existed but the expected file was not among the surfaced ones.
    return "missing_from_candidates";
  }
  return "unknown";
}

// Is a file under the inferred subsystem root (e.g. `django/db`)? Boundary-aware.
function pathInSubsystem(file: string, subsystemRoot: string): boolean {
  const f = normalizeFilePath(file);
  const root = normalizeFilePath(subsystemRoot);
  if (root.length === 0 || f.length === 0) return false;
  return f === root || f.startsWith(`${root}/`) || f.includes(`/${root}/`);
}

// ---------------------------------------------------------------------------
// Per-instance row
// ---------------------------------------------------------------------------

export type RetrievalResult =
  | "hit_top1_pivot"
  | "hit_top3"
  | "hit_support"
  | "hit_discarded"
  | "missing"
  | "skipped_no_context"
  | "fixture_error"
  | "workspace_error";

export interface RetrievalEvalRow {
  readonly instance_id: string;
  readonly label_source: LabelSource;
  readonly intent: string;
  readonly actual_mode: string | null;
  readonly budget_tokens: number;
  readonly estimated_tokens: number | null;
  readonly used_percent: number | null;

  readonly expected_files: readonly string[];
  readonly expected_symbols: readonly string[];

  readonly top_1_pivot_file: string | null;
  readonly top_1_pivot_symbol: string | null;
  readonly top_3_files: readonly string[];

  readonly expected_file_best_rank: number | null;
  readonly expected_file_role: ExpectedFileRole;
  readonly expected_symbol_best_rank: number | null;
  readonly expected_symbol_role: ExpectedFileRole;

  readonly contains_expected_file_top1: boolean;
  readonly contains_expected_file_top3: boolean;
  readonly contains_expected_file_anywhere: boolean;
  readonly contains_expected_symbol_anywhere: boolean;

  readonly pivot_count: number;
  readonly support_count: number;
  readonly discarded_count: number;

  readonly result: RetrievalResult;
  readonly miss_category: MissCategory;
  readonly failure_reason: string | null;

  /** Top-k pivots / support / discarded — makes a miss diagnosable offline. */
  readonly diagnostics: TopKDiagnostics;
}

export type RowError =
  | { readonly kind: "workspace_error"; readonly detail: string }
  | { readonly kind: "fixture_error"; readonly detail: string };

// Build one evaluation row. Pure: the live path passes a real CapsuleSummary;
// tests inject one (or an error) directly — no DB required.
export function evaluateInstance(
  entry: RetrievalEvalFixtureEntry,
  summary: CapsuleSummary | null,
  error?: RowError,
): RetrievalEvalRow {
  if (error || summary === null) {
    const kind = error?.kind ?? "workspace_error";
    return {
      instance_id: entry.instance_id,
      label_source: entry.label_source,
      intent: entry.intent,
      actual_mode: null,
      budget_tokens: entry.budget,
      estimated_tokens: null,
      used_percent: null,
      expected_files: entry.expected_files,
      expected_symbols: entry.expected_symbols,
      top_1_pivot_file: null,
      top_1_pivot_symbol: null,
      top_3_files: [],
      expected_file_best_rank: null,
      expected_file_role: "missing",
      expected_symbol_best_rank: null,
      expected_symbol_role: "missing",
      contains_expected_file_top1: false,
      contains_expected_file_top3: false,
      contains_expected_file_anywhere: false,
      contains_expected_symbol_anywhere: false,
      pivot_count: 0,
      support_count: 0,
      discarded_count: 0,
      result: kind,
      miss_category: kind === "fixture_error" ? "fixture_label_error" : "workspace_error",
      failure_reason: error?.detail ?? "workspace not available",
      diagnostics: { top_pivots: [], top_support: [], top_discarded: [] },
    };
  }

  const fileEval = evaluateExpectedFile(entry.expected_files, summary);
  const symbolEval = evaluateExpectedSymbol(entry.expected_symbols, summary);
  const top1Pivot = summary.pivots[0] ?? null;
  const top3 = rankedFiles(summary).slice(0, 3);

  const containsTop1 = fileEval.rank === 1 && fileEval.role === "pivot";
  const containsTop3 = fileEval.rank !== null && fileEval.rank <= 3;
  const containsAnywhere = fileEval.role === "pivot" || fileEval.role === "support" || fileEval.role === "discarded";
  const symbolAnywhere = symbolEval.role !== "missing";

  const { result, failureReason } = classifyResult(summary, fileEval, entry);

  const partialRow = {
    result,
    expected_file_role: fileEval.role,
    contains_expected_file_top3: containsTop3,
    expected_files: entry.expected_files,
  };
  const missCategory = classifyMiss(partialRow, summary, entry.task);

  return {
    instance_id: entry.instance_id,
    label_source: entry.label_source,
    intent: summary.intent,
    actual_mode: summary.actualMode,
    budget_tokens: entry.budget,
    estimated_tokens: summary.estimatedTokens,
    used_percent: summary.usedPercent,
    expected_files: entry.expected_files,
    expected_symbols: entry.expected_symbols,
    top_1_pivot_file: top1Pivot ? normalizeFilePath(top1Pivot.path) : null,
    top_1_pivot_symbol: top1Pivot ? top1Pivot.symbol : null,
    top_3_files: top3,
    expected_file_best_rank: fileEval.rank,
    expected_file_role: fileEval.role,
    expected_symbol_best_rank: symbolEval.rank,
    expected_symbol_role: symbolEval.role,
    contains_expected_file_top1: containsTop1,
    contains_expected_file_top3: containsTop3,
    contains_expected_file_anywhere: containsAnywhere,
    contains_expected_symbol_anywhere: symbolAnywhere,
    pivot_count: summary.pivots.length,
    support_count: summary.support.length,
    discarded_count: summary.discarded.length,
    result,
    miss_category: missCategory,
    failure_reason: failureReason,
    diagnostics: topKDiagnostics(summary),
  };
}

function classifyResult(
  summary: CapsuleSummary,
  fileEval: ExpectedFileEvaluation,
  entry: RetrievalEvalFixtureEntry,
): { result: RetrievalResult; failureReason: string | null } {
  if (summary.actualMode === "no_context") {
    return {
      result: "skipped_no_context",
      failureReason: "capsule returned no_context (no high-confidence edit target)",
    };
  }
  if (fileEval.role === "pivot" && fileEval.rank === 1) {
    return { result: "hit_top1_pivot", failureReason: null };
  }
  if (fileEval.rank !== null && fileEval.rank <= 3) {
    return { result: "hit_top3", failureReason: null };
  }
  if (fileEval.rank !== null) {
    return { result: "hit_support", failureReason: null };
  }
  if (fileEval.role === "discarded") {
    const hit = summary.discarded.find((item) =>
      entry.expected_files.some((f) => fileMatches(f, item.path)),
    );
    return {
      result: "hit_discarded",
      failureReason: `expected file recovered but discarded: ${hit?.path ?? "?"} — ${hit?.reason ?? "?"}`,
    };
  }
  return {
    result: "missing",
    failureReason: `expected file not surfaced (candidate_count=${summary.candidateCount ?? "?"})`,
  };
}

// ---------------------------------------------------------------------------
// Aggregate metrics (pure)
// ---------------------------------------------------------------------------

export interface RetrievalEvalAggregate {
  readonly instances_total: number;
  readonly instances_evaluated: number;
  readonly workspace_error_count: number;
  readonly no_context_count: number;

  readonly top_1_file_accuracy: number;
  readonly top_3_file_recall: number;
  readonly expected_file_as_pivot_rate: number;
  readonly expected_file_as_support_rate: number;
  readonly expected_file_missing_rate: number;
  readonly expected_file_discarded_rate: number;

  readonly expected_symbol_hit_rate: number;
  readonly expected_symbol_as_pivot_rate: number;

  readonly mean_capsule_tokens: number;
  readonly mean_pivot_count: number;
  readonly mean_support_count: number;

  /** Count of each miss category across ALL rows (hits carry `none`). */
  readonly miss_taxonomy: Readonly<Record<MissCategory, number>>;
}

const MISS_CATEGORIES: readonly MissCategory[] = [
  "none",
  "missing_from_candidates",
  "present_but_support",
  "present_but_discarded",
  "wrong_subsystem",
  "wrong_entry_point",
  "generic_infrastructure_ranked_above_target",
  "line_anchor_not_resolved",
  "test_symbol_pollution",
  "workspace_error",
  "fixture_label_error",
  "unknown",
];

function tallyMissTaxonomy(rows: readonly RetrievalEvalRow[]): Record<MissCategory, number> {
  const out = Object.fromEntries(MISS_CATEGORIES.map((c) => [c, 0])) as Record<MissCategory, number>;
  for (const row of rows) out[row.miss_category] += 1;
  return out;
}

// Aggregate split by label source — `gold_patch` rates are the headline number;
// `passing_model_patch` is reported separately because a miss there may just mean
// the model fixed it at a different (valid) site than the gold patch.
export function aggregateByLabelSource(
  rows: readonly RetrievalEvalRow[],
): Partial<Record<LabelSource, RetrievalEvalAggregate>> {
  const out: Partial<Record<LabelSource, RetrievalEvalAggregate>> = {};
  for (const source of LABEL_SOURCES) {
    const subset = rows.filter((row) => row.label_source === source);
    if (subset.length > 0) out[source] = aggregate(subset);
  }
  return out;
}

export function aggregate(rows: readonly RetrievalEvalRow[]): RetrievalEvalAggregate {
  const evaluated = rows.filter((row) => row.result !== "workspace_error" && row.result !== "fixture_error");
  const n = evaluated.length;
  const rate = (count: number): number => (n === 0 ? 0 : round(count / n));
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : round(values.reduce((a, b) => a + b, 0) / values.length);

  return {
    instances_total: rows.length,
    instances_evaluated: n,
    workspace_error_count: rows.filter((row) => row.result === "workspace_error").length,
    no_context_count: rows.filter((row) => row.result === "skipped_no_context").length,

    top_1_file_accuracy: rate(evaluated.filter((row) => row.contains_expected_file_top1).length),
    top_3_file_recall: rate(evaluated.filter((row) => row.contains_expected_file_top3).length),
    expected_file_as_pivot_rate: rate(evaluated.filter((row) => row.expected_file_role === "pivot").length),
    expected_file_as_support_rate: rate(evaluated.filter((row) => row.expected_file_role === "support").length),
    expected_file_missing_rate: rate(evaluated.filter((row) => row.expected_file_role === "missing").length),
    expected_file_discarded_rate: rate(evaluated.filter((row) => row.expected_file_role === "discarded").length),

    expected_symbol_hit_rate: rate(evaluated.filter((row) => row.contains_expected_symbol_anywhere).length),
    expected_symbol_as_pivot_rate: rate(evaluated.filter((row) => row.expected_symbol_role === "pivot").length),

    mean_capsule_tokens: mean(evaluated.map((row) => row.estimated_tokens ?? 0)),
    mean_pivot_count: mean(evaluated.map((row) => row.pivot_count)),
    mean_support_count: mean(evaluated.map((row) => row.support_count)),

    miss_taxonomy: tallyMissTaxonomy(rows),
  };
}

export interface RetrievalEvalArtifact {
  readonly generatedFrom: {
    readonly fixture: string;
    readonly resultsDir: string;
    readonly builder: string;
  };
  readonly rows: readonly RetrievalEvalRow[];
  readonly aggregate: RetrievalEvalAggregate;
  /** Aggregate split by label source (gold_patch / passing_model_patch / manual_verified). */
  readonly byLabelSource: Partial<Record<LabelSource, RetrievalEvalAggregate>>;
}

// ---------------------------------------------------------------------------
// Report rendering (pure)
// ---------------------------------------------------------------------------

const CSV_COLUMNS: readonly (keyof RetrievalEvalRow)[] = [
  "instance_id",
  "label_source",
  "intent",
  "actual_mode",
  "budget_tokens",
  "estimated_tokens",
  "used_percent",
  "top_1_pivot_file",
  "top_1_pivot_symbol",
  "expected_file_best_rank",
  "expected_file_role",
  "expected_symbol_best_rank",
  "expected_symbol_role",
  "contains_expected_file_top1",
  "contains_expected_file_top3",
  "contains_expected_file_anywhere",
  "contains_expected_symbol_anywhere",
  "pivot_count",
  "support_count",
  "discarded_count",
  "result",
  "miss_category",
  "failure_reason",
];

export function renderCsv(rows: readonly RetrievalEvalRow[]): string {
  const header = CSV_COLUMNS.join(",");
  const lines = rows.map((row) => CSV_COLUMNS.map((col) => csvCell(row[col])).join(","));
  return [header, ...lines].join("\n") + "\n";
}

function csvCell(value: RetrievalEvalRow[keyof RetrievalEvalRow]): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return csvEscape(value.join(" | "));
  return csvEscape(String(value));
}

function metricsTable(a: RetrievalEvalAggregate): string[] {
  return [
    "| metric | value |",
    "| --- | --- |",
    `| instances_total | ${a.instances_total} |`,
    `| instances_evaluated | ${a.instances_evaluated} |`,
    `| workspace_error_count | ${a.workspace_error_count} |`,
    `| no_context_count | ${a.no_context_count} |`,
    `| top_1_file_accuracy | ${pct(a.top_1_file_accuracy)} |`,
    `| top_3_file_recall | ${pct(a.top_3_file_recall)} |`,
    `| expected_file_as_pivot_rate | ${pct(a.expected_file_as_pivot_rate)} |`,
    `| expected_file_as_support_rate | ${pct(a.expected_file_as_support_rate)} |`,
    `| expected_file_discarded_rate | ${pct(a.expected_file_discarded_rate)} |`,
    `| expected_file_missing_rate | ${pct(a.expected_file_missing_rate)} |`,
    `| expected_symbol_hit_rate | ${pct(a.expected_symbol_hit_rate)} |`,
    `| expected_symbol_as_pivot_rate | ${pct(a.expected_symbol_as_pivot_rate)} |`,
    `| mean_capsule_tokens | ${a.mean_capsule_tokens.toFixed(1)} |`,
    `| mean_pivot_count | ${a.mean_pivot_count.toFixed(2)} |`,
    `| mean_support_count | ${a.mean_support_count.toFixed(2)} |`,
  ];
}

const LABEL_SOURCE_TITLES: Record<LabelSource, string> = {
  gold_patch: "gold_patch (preferred — SWE-bench reference patch)",
  passing_model_patch: "passing_model_patch (alternative fix — a miss may be a valid different edit site)",
  manual_verified: "manual_verified (hand-curated and checked)",
};

export function renderMarkdown(artifact: RetrievalEvalArtifact): string {
  const a = artifact.aggregate;
  const lines: string[] = [];
  lines.push("# Stage 5R — Capsule v2 Retrieval-Quality Evaluation", "");

  lines.push("## Scope", "");
  lines.push(
    "**This is deterministic retrieval-quality evaluation only.**",
    "",
    "- It does **not** run Claude.",
    "- It does **not** run Docker.",
    "- It does **not** run any vexp agent execution and makes **no API calls**.",
    "- It does **not** measure token / cost / duration (those are the LIVE Stage 5",
    "  benchmark, reported separately).",
    "- Expected labels (`expected_files` / `expected_symbols`) are **evaluation-only**",
    "  and are **never** passed into Capsule v2 retrieval.",
    "",
    "It evaluates Capsule v2 retrieval quality on a fixed fixture of SWE-bench",
    "instances with known edit targets, asking one question per instance: does the",
    "capsule put the known edited file/symbol in the top-1 pivot, top-3, support,",
    "discarded, or nowhere?",
    "",
  );

  lines.push("## Methodology", "");
  lines.push(
    "For each instance the indexed workspace is opened and Capsule v2 is built from",
    "`(task, intent, budget)` ALONE via `buildCapsuleV2`. The resulting pivots /",
    "support / discarded are compared against the fixture's `expected_files` and",
    "`expected_symbols` (evaluation labels from known patches). File rank is the",
    "1-based position in the de-duplicated pivots-then-support file ranking.",
    "",
    "- **pivot** = likely edit site · **support** = useful context ·",
    "**discard** = test/generic/over-budget · **missing** = not surfaced.",
    "",
  );

  lines.push("## Aggregate metrics — all instances", "");
  lines.push(...metricsTable(a));
  lines.push("");

  // Per-label-source breakdown (only sources actually present are emitted).
  lines.push("## Aggregate metrics — by label source", "");
  const present = LABEL_SOURCES.filter((s) => artifact.byLabelSource[s] !== undefined);
  if (present.length <= 1) {
    lines.push(
      present.length === 1
        ? `All ${a.instances_total} instances share one label source (${present[0]}); see the table above.`
        : "No labelled instances.",
      "",
    );
  } else {
    for (const source of present) {
      lines.push(`### ${LABEL_SOURCE_TITLES[source]}`, "");
      lines.push(...metricsTable(artifact.byLabelSource[source]!));
      lines.push("");
    }
  }

  lines.push("## Miss taxonomy", "");
  lines.push("| category | count |", "| --- | --- |");
  for (const [category, count] of Object.entries(a.miss_taxonomy)) {
    if (count > 0) lines.push(`| ${category} | ${count} |`);
  }
  lines.push("");

  lines.push("## Per-instance results", "");
  lines.push(
    "| instance | label | expected file | top pivot | role | top-1? | top-3? | result | miss category |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of artifact.rows) {
    const topPivot =
      row.top_1_pivot_file === null
        ? "—"
        : `${row.top_1_pivot_file}::${row.top_1_pivot_symbol ?? "?"}`;
    lines.push(
      `| ${row.instance_id} | ${row.label_source} | ${row.expected_files[0] ?? "—"} | ${topPivot} | `
      + `${row.expected_file_role} | ${mark(row.contains_expected_file_top1)} | `
      + `${mark(row.contains_expected_file_top3)} | ${row.result} | ${row.miss_category} |`,
    );
  }
  lines.push("");

  const misses = artifact.rows.filter((row) => !row.contains_expected_file_top3);
  lines.push("## Misses / failures — top-k diagnostics", "");
  if (misses.length === 0) {
    lines.push("None — every evaluated instance surfaced its expected edit target in the top-3.", "");
  } else {
    for (const row of misses) {
      lines.push(
        `### ${row.instance_id} — ${row.result} / ${row.miss_category}`,
        "",
        `- expected: ${row.expected_files.join(", ") || "—"}`,
        `- reason: ${row.failure_reason ?? "—"}`,
      );
      lines.push(...renderTopK("top pivots", row.diagnostics.top_pivots.map((p) => `${p.path}::${p.symbol} — ${p.role_reason}`)));
      lines.push(...renderTopK("top support", row.diagnostics.top_support.map((p) => `${p.path}::${p.symbol} — ${p.role_reason}`)));
      lines.push(...renderTopK("top discarded", row.diagnostics.top_discarded.map((p) => `${p.path}::${p.symbol} — ${p.discard_reason}`)));
      lines.push("");
    }
  }

  lines.push("## Notes", "");
  lines.push(
    "- `expected_files` / `expected_symbols` are EVALUATION LABELS only. They are",
    "  read from the fixture to score the capsule and are NEVER passed into Capsule",
    "  v2 retrieval — production retrieval receives only `(task, intent, budget)`.",
    "- No instance IDs or expected paths are hardcoded in production Capsule v2 logic.",
    "- This stage measures retrieval quality only; it runs no Claude, Docker, or",
    "  vexp agent execution and makes no API calls.",
    "- `passing_model_patch` labels are reported separately: a miss against one may",
    "  reflect a valid ALTERNATIVE fix site rather than a retrieval failure.",
    "",
  );

  return lines.join("\n");
}

function renderTopK(label: string, items: readonly string[]): string[] {
  if (items.length === 0) return [`- ${label}: (none)`];
  return [`- ${label}:`, ...items.map((it) => `  - ${it}`)];
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function mark(value: boolean): string {
  return value ? "yes" : "no";
}

// ---------------------------------------------------------------------------
// Expected-label extraction helper (best-effort, for building fixtures)
// ---------------------------------------------------------------------------

export interface ExtractedLabels {
  readonly instance_id: string;
  readonly changed_files: string[];
  readonly changed_symbols_guess: string[];
}

// Extract changed files (and a best-effort symbol guess) from the `modelPatch`
// fields in evaluated swebench JSONL artifacts. For building/auditing fixtures
// only — never used by production retrieval.
export function extractExpectedLabelsFromJsonl(content: string): ExtractedLabels[] {
  const byInstance = new Map<string, { files: Set<string>; symbols: Set<string> }>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(record) || !isString(record.instanceId)) continue;
    const patch = isString(record.modelPatch) ? record.modelPatch : "";
    if (patch.length === 0) continue;
    const bucket = byInstance.get(record.instanceId) ?? { files: new Set<string>(), symbols: new Set<string>() };
    for (const { file, symbols } of extractChangedFromDiff(patch)) {
      bucket.files.add(file);
      for (const sym of symbols) bucket.symbols.add(sym);
    }
    byInstance.set(record.instanceId, bucket);
  }
  return [...byInstance.entries()].map(([instance_id, { files, symbols }]) => ({
    instance_id,
    changed_files: [...files].sort(),
    changed_symbols_guess: [...symbols].sort(),
  }));
}

// Parse a unified diff into changed files and a best-effort set of changed Python
// symbols. The hunk-header `@@ ... @@ <context>` names the enclosing def/class;
// added/removed `def`/`class` lines name edited symbols; an edited `def` whose
// hunk-header context is a `class` is also emitted as `Class.method`; and
// top-level `NAME = ...` lines name edited module-level assignments. Best-effort,
// for seeding/auditing fixtures only — never used by production retrieval.
export function extractChangedFromDiff(patch: string): Array<{ file: string; symbols: string[] }> {
  const out: Array<{ file: string; symbols: string[] }> = [];
  let current: { file: string; symbols: Set<string> } | null = null;
  // The class named by the most recent hunk header, for `Class.method` joins.
  let hunkClass: string | null = null;
  const pushCurrent = (): void => {
    if (current) out.push({ file: current.file, symbols: [...current.symbols].sort() });
  };
  for (const line of patch.split(/\r?\n/)) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileMatch) {
      pushCurrent();
      current = { file: normalizeFilePath(fileMatch[1]!), symbols: new Set<string>() };
      hunkClass = null;
      continue;
    }
    if (current === null) continue;

    // `@@ ... @@ <context>` hunk headers name the enclosing def or class.
    const hunkHeader = /^@@.*@@\s*(.*)$/.exec(line);
    if (hunkHeader) {
      const ctx = hunkHeader[1]!;
      const ctxClass = /(?:^|\b)class\s+([A-Za-z_]\w*)/.exec(ctx);
      const ctxDef = /(?:^|\b)(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(ctx);
      hunkClass = ctxClass ? ctxClass[1]! : null;
      if (ctxClass) current.symbols.add(ctxClass[1]!);
      if (ctxDef) current.symbols.add(ctxDef[1]!);
      continue;
    }

    // A def/class on a diff line — CONTEXT (` `), added (`+`), or removed (`-`).
    // Context lines matter: a hunk that edits the BODY of a method shows the
    // enclosing `def` as context, so the method (the real edit site) is recovered
    // even though no `def` line itself changed. A `def` under a known class also
    // yields the `Class.method` form.
    const defClass = /^[ +-]\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(line);
    if (defClass) {
      const [, keyword, name] = defClass as unknown as [string, string, string];
      current.symbols.add(name);
      if (keyword === "def" && hunkClass) current.symbols.add(`${hunkClass}.${name}`);
      if (keyword === "class") hunkClass = name;
      continue;
    }

    // Top-level `NAME = ...` (no indentation after the +/-) names a module-level
    // assignment that CHANGED — a common edit site for settings/registries/defaults.
    const moduleAssign = /^[+-]([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(line);
    if (moduleAssign) current.symbols.add(moduleAssign[1]!);
  }
  pushCurrent();
  return out;
}

// ---------------------------------------------------------------------------
// Live evaluation (opens the indexed workspace, builds the capsule)
// ---------------------------------------------------------------------------

const INDEX_RELPATH = path.join(".vtrace", "index.sqlite");

export interface RunRetrievalEvalDeps {
  /** Build a capsule summary for an entry, or throw a RowError-shaped error. */
  readonly evaluateEntry?: (entry: RetrievalEvalFixtureEntry) => Promise<CapsuleSummary>;
}

// Default live evaluator: resolve the workspace + index, open it, and run Capsule
// v2 from (task, intent, budget) alone — never the expected labels.
export async function evaluateEntryLive(entry: RetrievalEvalFixtureEntry): Promise<CapsuleSummary> {
  const workspace = path.resolve(entry.workspace);
  if (!(await pathExists(workspace))) {
    throw rowError("workspace_error", `workspace not found: ${entry.workspace}`);
  }
  const dbPath = path.join(workspace, INDEX_RELPATH);
  if (!(await pathExists(dbPath))) {
    throw rowError("workspace_error", `workspace not indexed (no ${INDEX_RELPATH}): ${entry.workspace}`);
  }
  const intent = parseCapsuleIntent(entry.intent) ?? CapsuleIntent.Auto;
  const db = openIndexerDatabase(dbPath);
  try {
    const result = buildCapsuleV2({
      db,
      repoRoot: workspace,
      task: entry.task,
      intent,
      maxTokens: entry.budget,
    });
    return summarizeCapsule(result);
  } finally {
    db.close();
  }
}

export async function runRetrievalEval(
  config: RetrievalEvalConfig,
  deps: RunRetrievalEvalDeps = {},
): Promise<RetrievalEvalArtifact> {
  const entries = await loadRetrievalFixture(config.fixture);
  const evaluate = deps.evaluateEntry ?? evaluateEntryLive;
  const rows: RetrievalEvalRow[] = [];
  for (const entry of entries) {
    try {
      const summary = await evaluate(entry);
      rows.push(evaluateInstance(entry, summary));
    } catch (error) {
      rows.push(evaluateInstance(entry, null, toRowError(error)));
    }
  }
  return {
    generatedFrom: {
      fixture: config.fixture,
      resultsDir: config.out,
      builder: "buildCapsuleV2 (in-process, --json equivalent)",
    },
    rows,
    aggregate: aggregate(rows),
    byLabelSource: aggregateByLabelSource(rows),
  };
}

// ---------------------------------------------------------------------------
// CLI config + orchestration
// ---------------------------------------------------------------------------

export interface RetrievalEvalConfig {
  readonly fixture: string;
  readonly out: string;
  /** Base name for the {json,csv,md} reports (no extension). */
  readonly reportName: string;
}

const DEFAULT_OUT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");
const DEFAULT_FIXTURE = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "retrieval_eval.django.json");
const DEFAULT_REPORT_NAME = "stage5_retrieval_eval";

export const DEFAULT_RETRIEVAL_EVAL_CONFIG: RetrievalEvalConfig = {
  fixture: DEFAULT_FIXTURE,
  out: DEFAULT_OUT,
  reportName: DEFAULT_REPORT_NAME,
};

// Guard against a report-name that would escape the out dir or collide with a path
// separator — the reports are written as `<out>/<reportName>.{json,csv,md}`.
function sanitizeReportName(value: string): string {
  if (value.length === 0 || /[\\/]/.test(value) || value.includes("..")) {
    throw new Error(`Invalid --report-name "${value}" (must be a bare file stem, no path separators).`);
  }
  return value.replace(/\.(json|csv|md)$/i, "");
}

export function parseArgs(argv: readonly string[]): RetrievalEvalConfig {
  let fixture = DEFAULT_FIXTURE;
  let out = DEFAULT_OUT;
  let reportName = DEFAULT_REPORT_NAME;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--retrieval-fixture" || arg === "--fixture") {
      fixture = requireValue(argv, (i += 1), arg);
    } else if (arg === "--out") {
      out = requireValue(argv, (i += 1), arg);
    } else if (arg === "--report-name") {
      reportName = sanitizeReportName(requireValue(argv, (i += 1), arg));
    } else if (arg === "--mode") {
      // Accept "--mode retrieval-eval" for parity with the live runner invocation.
      const value = requireValue(argv, (i += 1), arg);
      if (value !== "retrieval-eval") {
        throw new Error(`Unsupported --mode "${value}" for the retrieval eval (expected "retrieval-eval").`);
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { fixture, out, reportName };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`Flag ${flag} requires a value.`);
  return value;
}

export async function writeReports(config: RetrievalEvalConfig, artifact: RetrievalEvalArtifact): Promise<void> {
  await mkdir(config.out, { recursive: true });
  const base = path.join(config.out, config.reportName);
  await writeFile(`${base}.json`, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  await writeFile(`${base}.csv`, renderCsv(artifact.rows), "utf8");
  await writeFile(`${base}.md`, renderMarkdown(artifact), "utf8");
}

async function main(config: RetrievalEvalConfig): Promise<void> {
  const artifact = await runRetrievalEval(config);
  await writeReports(config, artifact);
  const a = artifact.aggregate;
  process.stdout.write(
    `Stage 5R retrieval eval: ${a.instances_evaluated}/${a.instances_total} evaluated · `
    + `top-1 ${pct(a.top_1_file_accuracy)} · top-3 ${pct(a.top_3_file_recall)} · `
    + `pivot ${pct(a.expected_file_as_pivot_rate)} · missing ${pct(a.expected_file_missing_rate)}\n`,
  );
  process.stdout.write(`Reports written to ${config.out}/${config.reportName}.{json,csv,md}\n`);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function rowError(kind: RowError["kind"], detail: string): Error & { rowError: RowError } {
  const error = new Error(detail) as Error & { rowError: RowError };
  error.rowError = { kind, detail };
  return error;
}

function toRowError(error: unknown): RowError {
  if (error instanceof Error && "rowError" in error) {
    return (error as Error & { rowError: RowError }).rowError;
  }
  return { kind: "workspace_error", detail: error instanceof Error ? error.message : String(error) };
}

async function pathExists(target: string): Promise<boolean> {
  return stat(target).then(() => true).catch(() => false);
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// `readdir` re-export kept for optional workspace discovery by callers.
export { readdir };

if (import.meta.main) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
