// Stage 5R — deterministic retrieval-quality evaluation.
//
// WHY THIS EXISTS
// ----------------
// Stage 5's LIVE token/cost benchmark is noisy: Claude overloads produce
// zero-token rows, cache/session variance moves token counts, and small/local
// tasks are cheap enough that any context is net overhead. Tuning policy gates
// against that signal is benchmark whack-a-mole. Stage 5R measures the thing
// vtrace actually controls — RETRIEVAL QUALITY — with NO Claude, NO Docker, and
// NO vexp agent run. It is deterministic: given an indexed workspace and a fixed
// fixture of known-edited files (from real evaluated gold patches), it asks one
// question per instance — did vtrace surface the expected edit target, and as a
// pivot, a support item, or not at all?
//
// PRODUCT FRAMING
// ----------------
// vtrace is a local code-intelligence layer that gives agents evidence-ranked
// edit targets and dependency-aware context. Token reduction is an OUTCOME, not
// the design principle. So this stage scores: where should the agent look first
// (top-1 pivot), is the real target in the top-3, is it pivot vs support, how
// confident is the recommendation, and should context be injected at all (gate).
//
// KEY RULE: never use live token/cost results to tune this stage. Retrieval
// quality only. Expected files live ONLY in the fixture, never hardcoded in src.

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { CapsuleMode, type CapsuleMode as CapsuleModeT } from "../../src/capsule/capsuleModes";
import {
  buildInstanceQuery,
  capsuleModeForInstance,
  classifyCapsuleOutput,
  decideContextPolicy,
  deriveContextPolicySignals,
  findSweBenchRecord,
  loadSweBenchData,
  recommendedCapsuleModeFor,
  toSweBenchInstance,
  type CapsuleClassification,
  type ContextPolicyAction,
  type ContextPolicyDecision,
  type ProcessResult,
  type ProcessRunner,
  type SweBenchInstance,
} from "./run_stage5_vexp_swe_bench_smoke";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

// One evaluation target. The fixture carries ONLY the evaluation ground truth —
// the known-edited files/symbols taken from real gold patches. The problem
// statement, hints, and failing tests are loaded from the SWE-bench dataset by
// instance_id (so they are never duplicated/fabricated), unless overridden here.
export interface RetrievalEvalFixtureEntry {
  readonly instance_id: string;
  readonly repo: string;
  readonly expected_files: readonly string[];
  readonly expected_symbols?: readonly string[];
  /** Optional explicit workspace path (else resolved from results/workspaces). */
  readonly workspace?: string;
  /** Optional overrides so the fixture can run without the SWE-bench dataset. */
  readonly problem_statement?: string;
  readonly hints_text?: string | null;
  readonly fail_to_pass?: readonly string[];
  /** Human note explaining the gold patch; ignored by scoring. */
  readonly note?: string;
}

// Load a JSON-array or JSONL fixture of evaluation targets. Required fields are
// validated with a clear error — we never fabricate an expected file.
export async function loadRetrievalFixture(filePath: string): Promise<RetrievalEvalFixtureEntry[]> {
  const content = await readFile(filePath, "utf8").catch(() => null);
  if (content === null) throw new Error(`Retrieval fixture not found at ${filePath}.`);
  const trimmed = content.trim();
  const raw: unknown[] = trimmed.startsWith("[")
    ? (JSON.parse(trimmed) as unknown[])
    : trimmed
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as unknown);
  return raw.map((value, index) => validateFixtureEntry(value, index));
}

function validateFixtureEntry(value: unknown, index: number): RetrievalEvalFixtureEntry {
  if (!isRecord(value)) throw new Error(`Fixture entry ${index} is not an object.`);
  const instanceId = value.instance_id;
  const repo = value.repo;
  const expectedFiles = value.expected_files;
  if (!isString(instanceId)) throw new Error(`Fixture entry ${index} is missing instance_id.`);
  if (!isString(repo)) throw new Error(`Fixture entry ${instanceId} is missing repo.`);
  if (!Array.isArray(expectedFiles) || expectedFiles.filter(isString).length === 0) {
    throw new Error(`Fixture entry ${instanceId} must list at least one expected_files entry.`);
  }
  return {
    instance_id: instanceId,
    repo,
    expected_files: expectedFiles.filter(isString),
    ...(Array.isArray(value.expected_symbols)
      ? { expected_symbols: value.expected_symbols.filter(isString) }
      : {}),
    ...(isString(value.workspace) ? { workspace: value.workspace } : {}),
    ...(isString(value.problem_statement) ? { problem_statement: value.problem_statement } : {}),
    ...(typeof value.hints_text === "string" || value.hints_text === null
      ? { hints_text: value.hints_text as string | null }
      : {}),
    ...(Array.isArray(value.fail_to_pass) ? { fail_to_pass: value.fail_to_pass.filter(isString) } : {}),
    ...(isString(value.note) ? { note: value.note } : {}),
  };
}

// ---------------------------------------------------------------------------
// Capsule diagnostics parsing (the score-ordered, role-tagged selection)
// ---------------------------------------------------------------------------

export interface ParsedSelectionItem {
  readonly role: "pivot" | "support";
  readonly path: string;
  readonly symbol: string;
  readonly finalScore: number;
}

export interface ParsedDiscardedItem {
  readonly path: string;
  readonly symbol: string;
  readonly reason: string;
}

export interface ParsedCapsuleDiagnostics {
  readonly recommendedMode: string | null;
  readonly actualMode: string | null;
  readonly targetConfidence: string | null;
  readonly pivotCount: number | null;
  readonly supportCount: number | null;
  /**
   * Size of the candidate pool BEFORE role assignment. The decisive "why missing"
   * signal: 0 means retrieval surfaced nothing (a routing miss); > 0 with a
   * missing expected file means candidates were found but none matched / were
   * discarded (an over-strict gate). Distinguishing the two is the whole point.
   */
  readonly candidateCountBeforeRoles: number | null;
  readonly contextChars: number | null;
  readonly likelyFiles: readonly string[];
  readonly likelySymbols: readonly string[];
  /** Pivots first, then support; each in descending final score (Requirement). */
  readonly selection: readonly ParsedSelectionItem[];
  readonly discarded: readonly ParsedDiscardedItem[];
}

// Parse the capsule `--json` diagnostics block into the fields retrieval scoring
// needs. Returns null when the output is not the expected JSON envelope (a hard
// error or legacy raw text) — the caller records that honestly rather than
// guessing a ranking from prose.
export function parseCapsuleDiagnostics(stdout: string): ParsedCapsuleDiagnostics | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.diagnostics)) return null;
  const d = parsed.diagnostics;

  const selection: ParsedSelectionItem[] = Array.isArray(d.selection)
    ? d.selection.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const role = entry.role;
        if (role !== "pivot" && role !== "support") return [];
        if (!isString(entry.path)) return [];
        const scores = isRecord(entry.scores) ? entry.scores : {};
        return [
          {
            role,
            path: entry.path,
            symbol: isString(entry.symbol) ? entry.symbol : "",
            finalScore: isNumber(scores.final) ? scores.final : 0,
          },
        ];
      })
    : [];

  const discarded: ParsedDiscardedItem[] = Array.isArray(d.top_discarded_candidates)
    ? d.top_discarded_candidates.flatMap((entry) => {
        if (!isRecord(entry) || !isString(entry.path)) return [];
        return [
          {
            path: entry.path,
            symbol: isString(entry.symbol) ? entry.symbol : "",
            reason: isString(entry.discard_reason) ? entry.discard_reason : "",
          },
        ];
      })
    : [];

  return {
    recommendedMode: isString(d.recommended_mode) ? d.recommended_mode : null,
    actualMode: isString(d.actual_mode) ? d.actual_mode : null,
    targetConfidence: isString(d.target_confidence) ? d.target_confidence : null,
    pivotCount: isNumber(d.pivot_count) ? d.pivot_count : null,
    supportCount: isNumber(d.support_count) ? d.support_count : null,
    candidateCountBeforeRoles: isNumber(d.candidate_count_before_roles) ? d.candidate_count_before_roles : null,
    contextChars: isNumber(d.context_chars) ? d.context_chars : null,
    likelyFiles: Array.isArray(d.likely_files) ? d.likely_files.filter(isString) : [],
    likelySymbols: Array.isArray(d.likely_symbols) ? d.likely_symbols.filter(isString) : [],
    selection,
    discarded,
  };
}

// ---------------------------------------------------------------------------
// Retrieval-quality scoring (pure)
// ---------------------------------------------------------------------------

// Normalize a repo-relative path for comparison: forward slashes, no leading
// "./", trimmed. Capsule paths and gold-patch paths are both repo-relative, so
// after this they compare directly.
export function normalizeFilePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

// Does a capsule candidate path satisfy an expected (gold-patch) file? Exact
// repo-relative equality after normalization, with a path-boundary suffix
// fallback so a workspace-prefixed candidate still matches the gold path. The
// fallback is boundary-aware ("/utils.py" must not match "admindocs_utils.py").
export function expectedFileMatches(expected: string, candidate: string): boolean {
  const exp = normalizeFilePath(expected);
  const cand = normalizeFilePath(candidate);
  if (exp.length === 0 || cand.length === 0) return false;
  if (exp === cand) return true;
  return cand.endsWith(`/${exp}`) || exp.endsWith(`/${cand}`);
}

// The score-ordered, de-duplicated file ranking the agent would read top-down:
// pivots first (already ordered by final score in `selection`), then support.
export function rankedFilesFromSelection(selection: readonly ParsedSelectionItem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of selection) {
    const file = normalizeFilePath(item.path);
    if (file.length === 0 || seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}

export type ExpectedFileRole = "pivot" | "support" | "missing";

export interface ExpectedFileEvaluation {
  /** 1-based rank of the best-matching expected file in the file ranking; null if absent. */
  readonly rank: number | null;
  readonly role: ExpectedFileRole;
  readonly containsTop1: boolean;
  readonly containsTop3: boolean;
  /** Which expected file matched (the best-ranked one); null when missing. */
  readonly matchedFile: string | null;
  /** True when the expected file was recovered but discarded (a too-strict gate). */
  readonly discarded: boolean;
}

// Evaluate where the expected edit target landed in the capsule. The role is the
// strongest occurrence: pivot beats support (pivots always sort ahead). "missing"
// means the file is in NEITHER role — though it may still have been recovered and
// discarded, which the `discarded` flag surfaces (an over-strict pivot gate, not
// an empty recovery).
export function evaluateExpectedFile(
  expectedFiles: readonly string[],
  selection: readonly ParsedSelectionItem[],
  discarded: readonly ParsedDiscardedItem[],
): ExpectedFileEvaluation {
  const ranked = rankedFilesFromSelection(selection);

  let bestRank: number | null = null;
  let matchedFile: string | null = null;
  for (const expected of expectedFiles) {
    const idx = ranked.findIndex((file) => expectedFileMatches(expected, file));
    if (idx >= 0 && (bestRank === null || idx + 1 < bestRank)) {
      bestRank = idx + 1;
      matchedFile = ranked[idx] ?? null;
    }
  }

  if (bestRank !== null && matchedFile !== null) {
    // Role = the strongest role among selection items at the matched file. Pivots
    // sort first, so the first matching selection item carries the strongest role.
    const role: ExpectedFileRole =
      selection.find((item) => expectedFileMatches(matchedFile as string, item.path))?.role ?? "support";
    return {
      rank: bestRank,
      role,
      containsTop1: bestRank === 1,
      containsTop3: bestRank <= 3,
      matchedFile,
      discarded: false,
    };
  }

  const wasDiscarded = expectedFiles.some((expected) =>
    discarded.some((item) => expectedFileMatches(expected, item.path)),
  );
  return { rank: null, role: "missing", containsTop1: false, containsTop3: false, matchedFile: null, discarded: wasDiscarded };
}

// Did the capsule surface any expected (gold-patch) symbol — as a selected item
// or in likely_symbols? Exact, case-sensitive name match (symbol names are
// case-significant in Python).
export function containsExpectedSymbol(
  expectedSymbols: readonly string[],
  selection: readonly ParsedSelectionItem[],
  likelySymbols: readonly string[],
): boolean {
  if (expectedSymbols.length === 0) return false;
  const found = new Set<string>([
    ...selection.map((item) => item.symbol),
    ...likelySymbols,
  ]);
  return expectedSymbols.some((symbol) => found.has(symbol));
}

// ---------------------------------------------------------------------------
// Per-instance row
// ---------------------------------------------------------------------------

export type InstanceStatus = "evaluated" | "no_workspace" | "error";

export interface RetrievalEvalRow {
  readonly instance_id: string;
  readonly repo: string;
  readonly status: InstanceStatus;
  readonly status_detail: string | null;
  readonly recommended_mode: string | null;
  readonly actual_mode: string | null;
  readonly context_policy_action: ContextPolicyAction | null;
  readonly pivot_count: number | null;
  readonly support_count: number | null;
  readonly candidate_count_before_roles: number | null;
  readonly top_1_pivot_file: string | null;
  readonly top_3_files: readonly string[];
  readonly expected_file_rank: number | null;
  readonly expected_file_role: ExpectedFileRole;
  readonly contains_expected_file_top1: boolean;
  readonly contains_expected_file_top3: boolean;
  readonly contains_expected_symbol: boolean;
  readonly confidence: string | null;
  readonly capsule_chars: number | null;
  readonly discard_reasons: readonly string[];
  readonly expected_files: readonly string[];
  readonly expected_symbols: readonly string[];
  readonly workspace: string | null;
}

export interface EvaluateInstanceInput {
  readonly entry: RetrievalEvalFixtureEntry;
  /** Mode recommended from the instance's own shaping (fallback for non-evaluated rows). */
  readonly recommendedMode: string | null;
  readonly classification: CapsuleClassification | null;
  readonly diagnostics: ParsedCapsuleDiagnostics | null;
  readonly policy: ContextPolicyDecision | null;
  readonly status: InstanceStatus;
  readonly statusDetail: string | null;
  readonly workspace: string | null;
}

// Build one evaluation row from the parsed capsule outputs. Pure: the same logic
// runs in the live report and in tests (with injected diagnostics).
export function evaluateInstance(input: EvaluateInstanceInput): RetrievalEvalRow {
  const { entry, diagnostics, classification, policy } = input;
  const selection = diagnostics?.selection ?? [];
  const discarded = diagnostics?.discarded ?? [];
  const expectedFiles = entry.expected_files;
  const expectedSymbols = entry.expected_symbols ?? [];

  const fileEval = evaluateExpectedFile(expectedFiles, selection, discarded);
  const top1Pivot = selection.find((item) => item.role === "pivot")?.path ?? null;
  const top3 = rankedFilesFromSelection(selection).slice(0, 3);

  // Surface WHY a recovered expected file was thrown away (honesty: an over-strict
  // pivot gate is a different failure from an empty recovery).
  const discardReasons: string[] = [...discarded.map((item) => `${item.path} :: ${item.symbol} — ${item.reason}`)];
  if (fileEval.discarded) {
    const hit = discarded.find((item) => expectedFiles.some((f) => expectedFileMatches(f, item.path)));
    if (hit) discardReasons.unshift(`EXPECTED FILE DISCARDED: ${hit.path} — ${hit.reason}`);
  }

  return {
    instance_id: entry.instance_id,
    repo: entry.repo,
    status: input.status,
    status_detail: input.statusDetail,
    recommended_mode: diagnostics?.recommendedMode ?? input.recommendedMode,
    actual_mode: diagnostics?.actualMode ?? classification?.actualCapsuleMode ?? null,
    context_policy_action: policy?.action ?? null,
    pivot_count: diagnostics?.pivotCount ?? classification?.pivotCount ?? null,
    support_count: diagnostics?.supportCount ?? classification?.supportCount ?? null,
    candidate_count_before_roles: diagnostics?.candidateCountBeforeRoles ?? null,
    top_1_pivot_file: top1Pivot === null ? null : normalizeFilePath(top1Pivot),
    top_3_files: top3,
    expected_file_rank: fileEval.rank,
    expected_file_role: fileEval.role,
    contains_expected_file_top1: fileEval.containsTop1,
    contains_expected_file_top3: fileEval.containsTop3,
    contains_expected_symbol: containsExpectedSymbol(expectedSymbols, selection, diagnostics?.likelySymbols ?? []),
    confidence: diagnostics?.targetConfidence ?? null,
    capsule_chars: diagnostics?.contextChars ?? null,
    discard_reasons: discardReasons,
    expected_files: expectedFiles,
    expected_symbols: expectedSymbols,
    workspace: input.workspace,
  };
}

// ---------------------------------------------------------------------------
// Aggregate metrics (pure)
// ---------------------------------------------------------------------------

export interface RetrievalEvalAggregate {
  readonly instances_total: number;
  /** Rows where retrieval actually ran — the denominator for every rate below. */
  readonly instances_evaluated: number;
  readonly instances_no_workspace: number;
  readonly instances_error: number;
  readonly top_1_file_accuracy: number;
  readonly top_3_file_recall: number;
  readonly expected_file_as_pivot_rate: number;
  readonly expected_file_as_support_rate: number;
  readonly expected_file_missing_rate: number;
  readonly contains_expected_symbol_rate: number;
  readonly mean_capsule_chars: number;
  readonly skip_count: number;
  readonly inject_count: number;
  readonly low_confidence_count: number;
}

export function aggregate(rows: readonly RetrievalEvalRow[]): RetrievalEvalAggregate {
  const evaluated = rows.filter((row) => row.status === "evaluated");
  const n = evaluated.length;
  const rate = (count: number): number => (n === 0 ? 0 : count / n);
  const charsValues = evaluated.map((row) => row.capsule_chars).filter((value): value is number => value !== null);

  return {
    instances_total: rows.length,
    instances_evaluated: n,
    instances_no_workspace: rows.filter((row) => row.status === "no_workspace").length,
    instances_error: rows.filter((row) => row.status === "error").length,
    top_1_file_accuracy: rate(evaluated.filter((row) => row.contains_expected_file_top1).length),
    top_3_file_recall: rate(evaluated.filter((row) => row.contains_expected_file_top3).length),
    expected_file_as_pivot_rate: rate(evaluated.filter((row) => row.expected_file_role === "pivot").length),
    expected_file_as_support_rate: rate(evaluated.filter((row) => row.expected_file_role === "support").length),
    expected_file_missing_rate: rate(evaluated.filter((row) => row.expected_file_role === "missing").length),
    contains_expected_symbol_rate: rate(evaluated.filter((row) => row.contains_expected_symbol).length),
    mean_capsule_chars: charsValues.length === 0 ? 0 : charsValues.reduce((a, b) => a + b, 0) / charsValues.length,
    skip_count: evaluated.filter((row) => row.context_policy_action === "no_context").length,
    inject_count: evaluated.filter((row) => row.context_policy_action === "inject").length,
    low_confidence_count: evaluated.filter((row) => row.confidence === "low").length,
  };
}

export interface RetrievalEvalArtifact {
  readonly generatedFrom: {
    readonly fixture: string;
    readonly sweBenchData: string | null;
    readonly resultsDir: string;
    readonly vtraceCommand: string;
  };
  readonly rows: readonly RetrievalEvalRow[];
  readonly aggregate: RetrievalEvalAggregate;
}

// ---------------------------------------------------------------------------
// Report rendering (pure)
// ---------------------------------------------------------------------------

const CSV_COLUMNS: readonly (keyof RetrievalEvalRow)[] = [
  "instance_id",
  "repo",
  "status",
  "recommended_mode",
  "actual_mode",
  "context_policy_action",
  "pivot_count",
  "support_count",
  "candidate_count_before_roles",
  "top_1_pivot_file",
  "top_3_files",
  "expected_file_rank",
  "expected_file_role",
  "contains_expected_file_top1",
  "contains_expected_file_top3",
  "contains_expected_symbol",
  "confidence",
  "capsule_chars",
  "expected_files",
  "expected_symbols",
  "discard_reasons",
  "status_detail",
  "workspace",
];

export function renderCsv(rows: readonly RetrievalEvalRow[]): string {
  const header = CSV_COLUMNS.join(",");
  const lines = rows.map((row) =>
    CSV_COLUMNS.map((column) => csvEscape(formatCsvCell(row[column]))).join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

function formatCsvCell(value: RetrievalEvalRow[keyof RetrievalEvalRow]): string {
  if (Array.isArray(value)) return value.join(" ; ");
  if (value === null || value === undefined) return "";
  return String(value);
}

export function renderMarkdown(artifact: RetrievalEvalArtifact): string {
  const { rows, aggregate: agg } = artifact;
  const lines: string[] = [];
  lines.push("# Stage 5R — deterministic retrieval-quality evaluation", "");
  lines.push(
    "Measures whether vtrace surfaces the real edit target for each instance — as a pivot, a support",
    "item, or not at all. No Claude, no Docker, no vexp agent run; no token/cost signal is used here.",
    "",
  );
  lines.push("## How this was generated", "");
  lines.push(`- fixture: \`${artifact.generatedFrom.fixture}\``);
  lines.push(`- swe-bench data: \`${artifact.generatedFrom.sweBenchData ?? "(fixture-inlined)"}\``);
  lines.push(`- workspaces: \`${artifact.generatedFrom.resultsDir}/workspaces\``);
  lines.push(`- vtrace command: \`${artifact.generatedFrom.vtraceCommand}\``);
  lines.push("");

  lines.push("## Aggregate", "");
  lines.push(
    `- instances: ${agg.instances_total} total — ${agg.instances_evaluated} evaluated, ` +
      `${agg.instances_no_workspace} no-workspace, ${agg.instances_error} error`,
  );
  lines.push(`- top-1 file accuracy: ${pct(agg.top_1_file_accuracy)} (expected file is the lead ranked file)`);
  lines.push(`- top-3 file recall: ${pct(agg.top_3_file_recall)}`);
  lines.push(
    `- expected-file role: pivot ${pct(agg.expected_file_as_pivot_rate)}, ` +
      `support ${pct(agg.expected_file_as_support_rate)}, missing ${pct(agg.expected_file_missing_rate)}`,
  );
  lines.push(`- contains expected symbol: ${pct(agg.contains_expected_symbol_rate)}`);
  lines.push(`- mean capsule chars: ${Math.round(agg.mean_capsule_chars)}`);
  lines.push(
    `- gate: inject ${agg.inject_count}, no_context ${agg.skip_count}; low-confidence ${agg.low_confidence_count}`,
  );
  lines.push("");

  lines.push("## Per-instance", "");
  lines.push(
    "| instance | status | rec→act mode | policy | conf | top-1 pivot | exp rank | role | top1 | top3 | sym |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const row of rows) {
    lines.push(
      `| ${row.instance_id} | ${row.status} | ${row.recommended_mode ?? "-"}→${row.actual_mode ?? "-"} ` +
        `| ${row.context_policy_action ?? "-"} | ${row.confidence ?? "-"} | ${row.top_1_pivot_file ?? "—"} ` +
        `| ${row.expected_file_rank ?? "—"} | ${row.expected_file_role} | ${mark(row.contains_expected_file_top1)} ` +
        `| ${mark(row.contains_expected_file_top3)} | ${mark(row.contains_expected_symbol)} |`,
    );
  }
  lines.push("");

  lines.push("## Why each instance succeeded or failed", "");
  for (const row of rows) {
    lines.push(`### ${row.instance_id}`, "");
    lines.push(`- expected file(s): ${row.expected_files.join(", ")}`);
    if (row.status !== "evaluated") {
      lines.push(`- NOT EVALUATED (${row.status}): ${row.status_detail ?? "no detail"}`, "");
      continue;
    }
    lines.push(`- top-1 pivot: ${row.top_1_pivot_file ?? "none recovered"}`);
    lines.push(`- top-3 files: ${row.top_3_files.length > 0 ? row.top_3_files.join(", ") : "none"}`);
    if (row.expected_file_role === "missing") {
      const why =
        row.candidate_count_before_roles === 0
          ? " — retrieval returned 0 candidates (a routing miss, NOT an over-strict gate)"
          : row.discard_reasons.some((reason) => reason.startsWith("EXPECTED FILE DISCARDED"))
            ? " — it was recovered then discarded (an over-strict gate)"
            : row.candidate_count_before_roles !== null
              ? ` — ${row.candidate_count_before_roles} candidates retrieved but none matched the expected file`
              : "";
      lines.push(`- VERDICT: expected file MISSING from the capsule${why}.`);
    } else {
      lines.push(
        `- VERDICT: expected file present as **${row.expected_file_role}** at rank ${row.expected_file_rank}.`,
      );
    }
    if (row.context_policy_action === "no_context") {
      lines.push("- gate: no_context — vtrace would inject nothing for this task.");
    }
    if (row.discard_reasons.length > 0) {
      lines.push("- discarded candidates:");
      for (const reason of row.discard_reasons.slice(0, 5)) lines.push(`  - ${reason}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function mark(value: boolean): string {
  return value ? "✅" : "❌";
}

// ---------------------------------------------------------------------------
// Workspace resolution + capsule invocation (impure)
// ---------------------------------------------------------------------------

const INDEX_RELPATH = path.join(".vtrace", "index.sqlite");

// Find an already-indexed checkout for an instance. The fixture may pin a
// workspace; otherwise we search results/workspaces for any directory named
// <instance_id> (directly or one run-label deep) that carries a vtrace index.
// Returns null when none is indexed — recorded honestly as no_workspace, never
// fabricated.
export async function resolveIndexedWorkspace(
  resultsDir: string,
  instanceId: string,
  override?: string,
): Promise<string | null> {
  if (override !== undefined) {
    return (await pathExists(path.join(override, INDEX_RELPATH))) ? override : null;
  }
  const workspacesDir = path.join(resultsDir, "workspaces");
  const candidates: string[] = [path.join(workspacesDir, instanceId)];
  for (const label of await listDirs(workspacesDir)) {
    candidates.push(path.join(workspacesDir, label, instanceId));
  }
  const indexed: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, INDEX_RELPATH))) indexed.push(candidate);
  }
  indexed.sort();
  return indexed[0] ?? null;
}

export function buildCapsuleQueryCommand(
  vtraceCommand: string,
  workspace: string,
  query: string,
  mode: CapsuleModeT,
): { command: string; args: string[] } {
  const [command, ...base] = vtraceCommand.split(/\s+/).filter((part) => part.length > 0);
  if (command === undefined) throw new Error("vtrace command is empty.");
  return { command, args: [...base, "capsule", workspace, query, "--mode", mode, "--json"] };
}

export interface RetrievalRunDeps {
  readonly runProcess?: ProcessRunner;
}

// Run vtrace's deterministic capsule pipeline against one indexed workspace and
// return the classification + parsed diagnostics. No Claude/Docker/agent run.
export async function runCapsuleForInstance(
  vtraceCommand: string,
  workspace: string,
  instance: SweBenchInstance,
  deps: RetrievalRunDeps = {},
): Promise<{ classification: CapsuleClassification; diagnostics: ParsedCapsuleDiagnostics | null; queryCommand: string }> {
  const runProc = deps.runProcess ?? defaultRunProcess;
  const query = buildInstanceQuery(instance);
  const mode = capsuleModeForInstance(instance);
  const { command, args } = buildCapsuleQueryCommand(vtraceCommand, workspace, query, mode);
  const result = await runProc(command, args);
  const stdout = result.stdout.trim().length > 0 ? result.stdout : result.stderr;
  return {
    classification: classifyCapsuleOutput(stdout),
    diagnostics: parseCapsuleDiagnostics(stdout),
    queryCommand: `${command} ${args.slice(0, -1).join(" ")} <query> --mode ${mode} --json`,
  };
}

// ---------------------------------------------------------------------------
// CLI config + orchestration
// ---------------------------------------------------------------------------

export interface RetrievalEvalConfig {
  readonly fixture: string;
  readonly out: string;
  readonly resultsDir: string;
  readonly sweBenchData: string | null;
  readonly vtraceCommand: string;
}

const DEFAULT_OUT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");
const DEFAULT_FIXTURE = path.join(
  "benchmarks",
  "stage5_vexp_swe_bench_smoke",
  "retrieval_eval.django.json",
);

export const DEFAULT_RETRIEVAL_EVAL_CONFIG: RetrievalEvalConfig = {
  fixture: DEFAULT_FIXTURE,
  out: DEFAULT_OUT,
  resultsDir: DEFAULT_OUT,
  sweBenchData: null,
  vtraceCommand: "bun src/cli/index.ts",
};

export function parseArgs(argv: readonly string[]): RetrievalEvalConfig {
  let config = { ...DEFAULT_RETRIEVAL_EVAL_CONFIG };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--fixture":
      case "--retrieval-fixture":
        config = { ...config, fixture: requireValue(argv, ++index, arg) };
        break;
      case "--out":
        config = { ...config, out: requireValue(argv, ++index, arg) };
        break;
      case "--results-dir":
        config = { ...config, resultsDir: requireValue(argv, ++index, arg) };
        break;
      case "--swe-bench-data":
        config = { ...config, sweBenchData: requireValue(argv, ++index, arg) };
        break;
      case "--vtrace-command":
        config = { ...config, vtraceCommand: requireValue(argv, ++index, arg) };
        break;
      case "--mode":
        // Accepted for parity with the live runner; this script is retrieval-eval only.
        requireValue(argv, ++index, arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg ?? "(empty)"}`);
    }
  }
  return config;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`Missing value for ${flag}.`);
  return value;
}

// Resolve a SweBenchInstance for the entry: prefer fixture-inlined fields (so the
// fixture can run standalone), else look it up in the SWE-bench dataset by id.
async function resolveInstance(
  entry: RetrievalEvalFixtureEntry,
  records: readonly Record<string, unknown>[] | null,
): Promise<SweBenchInstance> {
  if (entry.problem_statement !== undefined) {
    return toSweBenchInstance({
      repo: entry.repo,
      instance_id: entry.instance_id,
      base_commit: "fixture",
      problem_statement: entry.problem_statement,
      hints_text: entry.hints_text ?? null,
      fail_to_pass: entry.fail_to_pass ?? [],
    });
  }
  if (records === null) {
    throw new Error(
      `Instance ${entry.instance_id} has no inlined problem_statement; pass --swe-bench-data to load it.`,
    );
  }
  const record = findSweBenchRecord(records, entry.instance_id);
  if (record === null) throw new Error(`Instance ${entry.instance_id} not found in the SWE-bench dataset.`);
  return toSweBenchInstance(record);
}

export async function runRetrievalEval(
  config: RetrievalEvalConfig,
  deps: RetrievalRunDeps = {},
): Promise<RetrievalEvalArtifact> {
  const fixture = await loadRetrievalFixture(config.fixture);
  const records = config.sweBenchData === null ? null : await loadSweBenchData(config.sweBenchData);

  const rows: RetrievalEvalRow[] = [];
  for (const entry of fixture) {
    let instance: SweBenchInstance;
    try {
      instance = await resolveInstance(entry, records);
    } catch (error) {
      rows.push(
        evaluateInstance({
          entry,
          recommendedMode: null,
          classification: null,
          diagnostics: null,
          policy: null,
          status: "error",
          statusDetail: error instanceof Error ? error.message : String(error),
          workspace: null,
        }),
      );
      continue;
    }

    const recommendedMode = recommendedCapsuleModeFor(instance);
    const workspace = await resolveIndexedWorkspace(config.resultsDir, entry.instance_id, entry.workspace);
    if (workspace === null) {
      rows.push(
        evaluateInstance({
          entry,
          recommendedMode,
          classification: null,
          diagnostics: null,
          policy: null,
          status: "no_workspace",
          statusDetail: `No indexed workspace found under ${config.resultsDir}/workspaces.`,
          workspace: null,
        }),
      );
      continue;
    }

    try {
      const { classification, diagnostics } = await runCapsuleForInstance(
        config.vtraceCommand,
        workspace,
        instance,
        deps,
      );
      const policy = decideContextPolicy(deriveContextPolicySignals(instance), {
        capsuleAction: classification.policyAction,
        hasContext: classification.contextInjected,
        pivotCount: classification.pivotCount,
        supportCount: classification.supportCount,
        actualMode: classification.actualCapsuleMode,
      });
      const status: InstanceStatus = classification.policyAction === "error" ? "error" : "evaluated";
      rows.push(
        evaluateInstance({
          entry,
          recommendedMode,
          classification,
          diagnostics,
          policy,
          status,
          statusDetail: classification.error,
          workspace,
        }),
      );
    } catch (error) {
      rows.push(
        evaluateInstance({
          entry,
          recommendedMode,
          classification: null,
          diagnostics: null,
          policy: null,
          status: "error",
          statusDetail: error instanceof Error ? error.message : String(error),
          workspace,
        }),
      );
    }
  }

  return {
    generatedFrom: {
      fixture: config.fixture,
      sweBenchData: config.sweBenchData,
      resultsDir: config.resultsDir,
      vtraceCommand: config.vtraceCommand,
    },
    rows,
    aggregate: aggregate(rows),
  };
}

export async function writeReports(config: RetrievalEvalConfig, artifact: RetrievalEvalArtifact): Promise<void> {
  await mkdir(config.out, { recursive: true });
  await writeFile(path.join(config.out, "stage5_retrieval_eval.csv"), renderCsv(artifact.rows));
  await writeFile(
    path.join(config.out, "stage5_retrieval_eval.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  await writeFile(path.join(config.out, "stage5_retrieval_eval.md"), renderMarkdown(artifact));
}

async function main(config: RetrievalEvalConfig): Promise<void> {
  const artifact = await runRetrievalEval(config);
  await writeReports(config, artifact);
  const agg = artifact.aggregate;
  process.stdout.write(
    `Stage 5R: ${agg.instances_evaluated}/${agg.instances_total} evaluated — ` +
      `top-1 ${pct(agg.top_1_file_accuracy)}, top-3 ${pct(agg.top_3_file_recall)}, ` +
      `pivot ${pct(agg.expected_file_as_pivot_rate)} / support ${pct(agg.expected_file_as_support_rate)} / ` +
      `missing ${pct(agg.expected_file_missing_rate)}. Reports in ${config.out}\n`,
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function defaultRunProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on("error", (error) =>
      resolve({
        exitCode: 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: `${Buffer.concat(stderrChunks).toString("utf8")}${error.message}`,
      }),
    );
    proc.on("close", (code) =>
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      }),
    );
  });
}

async function pathExists(target: string): Promise<boolean> {
  return (await stat(target).then(() => true).catch(() => false));
}

async function listDirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

if (import.meta.main) {
  try {
    await main(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
