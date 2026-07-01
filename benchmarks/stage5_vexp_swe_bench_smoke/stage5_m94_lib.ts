// Stage 5 M94 — deterministic VTRACE retrieval/capsule scoreboard: pure library.
//
// WHY THIS EXISTS
// ----------------
// M94 scores VTRACE's deterministic core (index -> retrieval -> capsule) BEFORE
// any coding agent acts: given only the issue text and the repo at the base
// commit, does VTRACE retrieve and pack the files/symbols the gold patch needs?
//
// This module holds the PURE, unit-tested pieces: gold extraction from the gold
// unified diff, recall@k / MRR, capsule-coverage, target-precision, budget/packing,
// and the conservative failure-mode classifier. The orchestration (open the index,
// build the capsule, read live artifacts, write reports) lives in the runner.
//
// Gold is SCORING-ONLY. Nothing here is ever fed into capsule generation — the
// runner builds the capsule from (task, intent, budget) alone and only then calls
// these functions with the gold labels. See `assertNoGoldLeakage` for the guard.
//
// NO Claude, NO Docker, NO agent run, NO API calls, NO live network.

import {
  extractChangedFromDiff,
  fileMatches,
  normalizeFilePath,
  rankedFiles,
  symbolMatches,
  type CapsuleSummary,
} from "./run_stage5_retrieval_eval";

// ---------------------------------------------------------------------------
// Gold extraction
// ---------------------------------------------------------------------------

// A file is "test" gold when it lives under a tests dir, is a `test_*.py` module,
// or ends `_test(s).py`. Same predicate the fixture builder uses, kept local so
// this module has no hidden coupling to the builder's private helper.
export function isTestFile(file: string): boolean {
  const f = normalizeFilePath(file);
  return /(^|\/)tests?\//.test(f) || /(^|\/)test_[^/]+$/.test(f) || /_tests?\.py$/.test(f);
}

export interface GoldLabels {
  /** Every source+test file the gold patch touches (normalized, /dev/null excluded). */
  readonly allFiles: string[];
  /** Non-test (production) gold files. */
  readonly sourceFiles: string[];
  /** Test-only gold files. */
  readonly testFiles: string[];
  /**
   * The scored gold set: source files when the patch touches any production file,
   * else the test files (so a test-only patch is never label-less). This mirrors
   * the existing retrieval-eval `expected_files` philosophy.
   */
  readonly scoredFiles: string[];
  /** Best-effort gold symbols on the scored files (bare + Class.method forms). */
  readonly symbols: string[];
  readonly symbolStatus: "available" | "unavailable";
  /** True when the patch is source-only (no test files touched). */
  readonly sourceOnly: boolean;
  /** True when the gold patch touches more than one scored file (co-edit shape). */
  readonly multiFile: boolean;
}

// Derive gold labels from a gold unified diff. Deterministic; reuses the shared
// `extractChangedFromDiff` (which already skips `/dev/null` and captures renames'
// new path via the `+++ b/...` line).
export function extractGold(patch: string): GoldLabels {
  const changed = extractChangedFromDiff(patch);
  const allFiles: string[] = [];
  const testFiles: string[] = [];
  const sourceFiles: string[] = [];
  const symbolsByScored = new Set<string>();
  for (const { file } of changed) {
    const f = normalizeFilePath(file);
    if (!allFiles.includes(f)) allFiles.push(f);
    if (isTestFile(f)) {
      if (!testFiles.includes(f)) testFiles.push(f);
    } else if (!sourceFiles.includes(f)) sourceFiles.push(f);
  }
  const scoredFiles = sourceFiles.length > 0 ? sourceFiles : testFiles;
  const scoredSet = new Set(scoredFiles);
  for (const { file, symbols } of changed) {
    if (!scoredSet.has(normalizeFilePath(file))) continue;
    for (const s of symbols) symbolsByScored.add(s);
  }
  const symbols = [...symbolsByScored].sort();
  return {
    allFiles,
    sourceFiles,
    testFiles,
    scoredFiles,
    symbols,
    symbolStatus: symbols.length > 0 ? "available" : "unavailable",
    sourceOnly: testFiles.length === 0,
    multiFile: scoredFiles.length > 1,
  };
}

// Guard: none of the gold labels may appear inside the inputs that drive capsule
// generation (task text). A gold file path or symbol leaking into the task would
// invalidate the score. Returns the offending token, or null when clean.
export function assertNoGoldLeakage(task: string, gold: GoldLabels): string | null {
  const hay = task.toLowerCase();
  for (const f of gold.allFiles) {
    // A full repo-relative path in the task prose is a leak; a bare basename that
    // legitimately appears in an issue (e.g. "models.py") is not, so require the
    // path to carry a directory separator before flagging.
    if (f.includes("/") && hay.includes(f.toLowerCase())) return f;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ranking helpers
// ---------------------------------------------------------------------------

// The 1-indexed rank of the first ranked file that matches ANY gold file, or null.
export function firstGoldRank(ranked: readonly string[], gold: readonly string[]): number | null {
  for (let i = 0; i < ranked.length; i += 1) {
    if (gold.some((g) => fileMatches(g, ranked[i]!))) return i + 1;
  }
  return null;
}

// recall@k over a gold set: how many gold files appear in the top-k ranked files,
// divided by the gold-set size. Deterministic; boundary-aware file match.
export function recallAtK(ranked: readonly string[], gold: readonly string[], k: number): number {
  if (gold.length === 0) return 0;
  const top = ranked.slice(0, k);
  let hit = 0;
  for (const g of gold) {
    if (top.some((f) => fileMatches(g, f))) hit += 1;
  }
  return hit / gold.length;
}

export function mrr(rank: number | null): number {
  return rank === null ? 0 : 1 / rank;
}

// True when at least one gold file appears anywhere in the file set.
export function anyGoldIn(files: readonly string[], gold: readonly string[]): boolean {
  return gold.some((g) => files.some((f) => fileMatches(g, f)));
}

// True when every gold file appears in the file set.
export function allGoldIn(files: readonly string[], gold: readonly string[]): boolean {
  if (gold.length === 0) return false;
  return gold.every((g) => files.some((f) => fileMatches(g, f)));
}

// Count of gold files present in the file set.
export function goldCountIn(files: readonly string[], gold: readonly string[]): number {
  let n = 0;
  for (const g of gold) if (files.some((f) => fileMatches(g, f))) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// Capsule projection: distinct files by role
// ---------------------------------------------------------------------------

export interface CapsuleFiles {
  /** Distinct pivot files (deterministic equivalent of M92 "required targets"). */
  readonly requiredFiles: string[];
  /** Distinct support files (deterministic equivalent of M92 "optional targets"). */
  readonly optionalFiles: string[];
  /** Distinct files across pivots + support (the emitted capsule). */
  readonly capsuleFiles: string[];
  /** The lead pivot file (pivots[0]), or null when the capsule named no pivot. */
  readonly leadPivotFile: string | null;
}

function distinctPaths(items: readonly { path: string }[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    const p = normalizeFilePath(it.path);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export function capsuleFilesOf(summary: CapsuleSummary): CapsuleFiles {
  const requiredFiles = distinctPaths(summary.pivots);
  const optionalFiles = distinctPaths(summary.support).filter((p) => !requiredFiles.includes(p));
  const capsuleFiles = [...requiredFiles, ...optionalFiles];
  const leadPivotFile = summary.pivots[0] ? normalizeFilePath(summary.pivots[0].path) : null;
  return { requiredFiles, optionalFiles, capsuleFiles, leadPivotFile };
}

// ---------------------------------------------------------------------------
// File-level retrieval metrics
// ---------------------------------------------------------------------------

export interface FileMetrics {
  readonly gold_file_recall_at_1: number;
  readonly gold_file_recall_at_3: number;
  readonly gold_file_recall_at_5: number;
  readonly gold_file_recall_at_10: number;
  readonly first_gold_file_rank: number | null;
  readonly mrr_first_gold_file: number;
  readonly any_gold_in_top_5: boolean;
  readonly any_gold_in_top_10: boolean;
  readonly all_gold_in_top_10: boolean;
  readonly any_gold_in_capsule: boolean;
  readonly all_gold_in_capsule: boolean;
  readonly source_gold_in_capsule: boolean;
  readonly test_gold_in_capsule: boolean;
  readonly lead_pivot_is_gold: boolean;
  readonly lead_pivot_is_source_gold: boolean;
  /** Multi-file only: non-lead gold files recalled into the capsule / total non-lead gold. */
  readonly hidden_coedit_recall: number | null;
}

export function computeFileMetrics(
  summary: CapsuleSummary,
  gold: GoldLabels,
  cf: CapsuleFiles,
): FileMetrics {
  const ranked = rankedFiles(summary);
  const scored = gold.scoredFiles;
  const first = firstGoldRank(ranked, scored);
  const leadIsGold = cf.leadPivotFile !== null && scored.some((g) => fileMatches(g, cf.leadPivotFile!));
  const leadIsSourceGold =
    cf.leadPivotFile !== null && gold.sourceFiles.some((g) => fileMatches(g, cf.leadPivotFile!));

  // Hidden co-edit: for a multi-file gold patch, the non-lead gold files are the
  // ones the agent must also touch but that are not the headline edit site. Recall
  // them against the emitted capsule. The "lead" gold file is the one the capsule's
  // lead pivot matched (if any); otherwise treat the first scored gold as lead so a
  // capsule with a non-gold lead still measures every gold as a co-edit.
  let hiddenCoedit: number | null = null;
  if (gold.multiFile) {
    const leadGold = scored.find((g) => cf.leadPivotFile !== null && fileMatches(g, cf.leadPivotFile));
    const nonLead = scored.filter((g) => g !== (leadGold ?? scored[0]));
    if (nonLead.length > 0) {
      hiddenCoedit = goldCountIn(cf.capsuleFiles, nonLead) / nonLead.length;
    }
  }

  return {
    gold_file_recall_at_1: recallAtK(ranked, scored, 1),
    gold_file_recall_at_3: recallAtK(ranked, scored, 3),
    gold_file_recall_at_5: recallAtK(ranked, scored, 5),
    gold_file_recall_at_10: recallAtK(ranked, scored, 10),
    first_gold_file_rank: first,
    mrr_first_gold_file: mrr(first),
    any_gold_in_top_5: anyGoldIn(ranked.slice(0, 5), scored),
    any_gold_in_top_10: anyGoldIn(ranked.slice(0, 10), scored),
    all_gold_in_top_10: allGoldIn(ranked.slice(0, 10), scored),
    any_gold_in_capsule: anyGoldIn(cf.capsuleFiles, scored),
    all_gold_in_capsule: allGoldIn(cf.capsuleFiles, scored),
    source_gold_in_capsule: anyGoldIn(cf.capsuleFiles, gold.sourceFiles),
    test_gold_in_capsule: anyGoldIn(cf.capsuleFiles, gold.testFiles),
    lead_pivot_is_gold: leadIsGold,
    lead_pivot_is_source_gold: leadIsSourceGold,
    hidden_coedit_recall: hiddenCoedit,
  };
}

// ---------------------------------------------------------------------------
// Target / capsule precision metrics
// ---------------------------------------------------------------------------

export interface TargetMetrics {
  readonly required_target_count: number;
  readonly optional_target_count: number;
  readonly required_gold_file_count: number;
  readonly optional_gold_file_count: number;
  readonly gold_file_in_required: boolean;
  readonly gold_file_in_optional: boolean;
  readonly gold_file_only_optional: boolean;
  readonly required_non_gold_count: number;
  readonly optional_non_gold_count: number;
  readonly required_precision_file_level: number | null;
  readonly optional_precision_file_level: number | null;
  readonly overpacking_file_count: number;
  readonly overpacking_ratio: number | null;
  readonly capsule_file_count: number;
  readonly capsule_gold_file_count: number;
  readonly capsule_non_gold_file_count: number;
  readonly gold_file_density: number | null;
}

export function computeTargetMetrics(gold: GoldLabels, cf: CapsuleFiles): TargetMetrics {
  const scored = gold.scoredFiles;
  const reqGold = goldCountIn(cf.requiredFiles, scored);
  const optGold = goldCountIn(cf.optionalFiles, scored);
  const capGold = goldCountIn(cf.capsuleFiles, scored);
  const inRequired = reqGold > 0;
  const inOptional = optGold > 0;
  return {
    required_target_count: cf.requiredFiles.length,
    optional_target_count: cf.optionalFiles.length,
    required_gold_file_count: reqGold,
    optional_gold_file_count: optGold,
    gold_file_in_required: inRequired,
    gold_file_in_optional: inOptional,
    gold_file_only_optional: inOptional && !inRequired,
    required_non_gold_count: cf.requiredFiles.length - reqGold,
    optional_non_gold_count: cf.optionalFiles.length - optGold,
    required_precision_file_level: cf.requiredFiles.length > 0 ? reqGold / cf.requiredFiles.length : null,
    optional_precision_file_level: cf.optionalFiles.length > 0 ? optGold / cf.optionalFiles.length : null,
    overpacking_file_count: cf.capsuleFiles.length - capGold,
    // Emitted files per gold file recovered. High ⇒ the capsule spends its budget
    // on non-gold context. Null when no gold is in the capsule (undefined ratio).
    overpacking_ratio: capGold > 0 ? cf.capsuleFiles.length / capGold : null,
    capsule_file_count: cf.capsuleFiles.length,
    capsule_gold_file_count: capGold,
    capsule_non_gold_file_count: cf.capsuleFiles.length - capGold,
    gold_file_density: cf.capsuleFiles.length > 0 ? capGold / cf.capsuleFiles.length : null,
  };
}

// ---------------------------------------------------------------------------
// Budget / packing metrics
// ---------------------------------------------------------------------------

// A lightweight projection of a capsule item's rendered payload — enough to do
// gold-vs-non-gold char/token accounting without holding the whole builder result.
export interface CapsuleItemDetail {
  readonly path: string;
  readonly role: "pivot" | "support";
  readonly contentMode: string;
  readonly chars: number;
  readonly estTokens: number;
}

export interface BudgetMetrics {
  readonly capsule_char_count: number;
  readonly capsule_est_tokens: number;
  readonly digest_char_count: number | null;
  readonly digest_est_tokens: number | null;
  readonly total_context_char_count: number;
  readonly total_context_est_tokens: number;
  readonly budget_used_pct: number;
  readonly chars_per_gold_file_in_capsule: number | null;
  readonly non_gold_chars: number;
  readonly gold_chars: number;
  readonly gold_chars_estimable: boolean;
  readonly compression_reason_counts: Record<string, number>;
  readonly mode_counts: Record<string, number>;
}

export function computeBudgetMetrics(
  summary: CapsuleSummary,
  items: readonly CapsuleItemDetail[],
  gold: GoldLabels,
  cf: CapsuleFiles,
  discardReasons: readonly string[],
): BudgetMetrics {
  const scored = gold.scoredFiles;
  let charCount = 0;
  let goldChars = 0;
  let nonGoldChars = 0;
  const modeCounts: Record<string, number> = {};
  for (const it of items) {
    charCount += it.chars;
    modeCounts[it.contentMode] = (modeCounts[it.contentMode] ?? 0) + 1;
    if (scored.some((g) => fileMatches(g, it.path))) goldChars += it.chars;
    else nonGoldChars += it.chars;
  }
  const compressionReasonCounts: Record<string, number> = {};
  for (const r of discardReasons) {
    compressionReasonCounts[r] = (compressionReasonCounts[r] ?? 0) + 1;
  }
  const capGold = goldCountIn(cf.capsuleFiles, scored);
  return {
    capsule_char_count: charCount,
    capsule_est_tokens: summary.estimatedTokens,
    // The M92 live "digest / decision contract" is derived from the capsule at
    // injection time in the runner; there is no separate deterministic offline
    // digest artifact, so it is reported as unavailable (the capsule IS the
    // deterministic context artifact this scoreboard measures).
    digest_char_count: null,
    digest_est_tokens: null,
    total_context_char_count: charCount,
    total_context_est_tokens: summary.estimatedTokens,
    budget_used_pct: summary.usedPercent,
    chars_per_gold_file_in_capsule: capGold > 0 ? charCount / capGold : null,
    non_gold_chars: nonGoldChars,
    gold_chars: goldChars,
    gold_chars_estimable: true,
    compression_reason_counts: compressionReasonCounts,
    mode_counts: modeCounts,
  };
}

// ---------------------------------------------------------------------------
// Symbol metrics (optional, best-effort)
// ---------------------------------------------------------------------------

export interface SymbolMetrics {
  readonly gold_symbol_status: "available" | "unavailable";
  readonly gold_symbol_recall_at_5: number | null;
  readonly gold_symbol_recall_at_10: number | null;
  readonly gold_symbol_in_capsule: boolean | null;
  readonly gold_symbol_in_required: boolean | null;
  readonly gold_symbol_in_optional: boolean | null;
}

// Ranked capsule symbols in read order (pivots then support), each item carries a
// bare symbol + fq name for `symbolMatches`.
export function computeSymbolMetrics(summary: CapsuleSummary, gold: GoldLabels): SymbolMetrics {
  if (gold.symbolStatus === "unavailable") {
    return {
      gold_symbol_status: "unavailable",
      gold_symbol_recall_at_5: null,
      gold_symbol_recall_at_10: null,
      gold_symbol_in_capsule: null,
      gold_symbol_in_required: null,
      gold_symbol_in_optional: null,
    };
  }
  const ranked = [...summary.pivots, ...summary.support];
  const recall = (k: number): number => {
    const top = ranked.slice(0, k);
    let hit = 0;
    for (const g of gold.symbols) {
      if (top.some((it) => symbolMatches(g, it))) hit += 1;
    }
    return gold.symbols.length > 0 ? hit / gold.symbols.length : 0;
  };
  const inRole = (role: "pivot" | "support"): boolean =>
    gold.symbols.some((g) => ranked.filter((it) => it.role === role).some((it) => symbolMatches(g, it)));
  return {
    gold_symbol_status: "available",
    gold_symbol_recall_at_5: recall(5),
    gold_symbol_recall_at_10: recall(10),
    gold_symbol_in_capsule: gold.symbols.some((g) => ranked.some((it) => symbolMatches(g, it))),
    gold_symbol_in_required: inRole("pivot"),
    gold_symbol_in_optional: inRole("support"),
  };
}

// ---------------------------------------------------------------------------
// Failure-mode classification (conservative)
// ---------------------------------------------------------------------------

export type Outcome =
  | "excellent"
  | "good"
  | "partial"
  | "miss"
  | "overpacked"
  | "wrong_pivot"
  | "test_only"
  | "unknown";

export type FailureReason =
  | "hidden_coedit_missing"
  | "facade_file_overweighted"
  | "test_file_overweighted"
  | "traceback_file_overweighted"
  | "lexical_mismatch"
  | "symbol_alias_import_gap"
  | "package_reexport_gap"
  | "parser_coverage_gap"
  | "language_coverage_gap"
  | "ranking_gap"
  | "capsule_budget_excluded_gold"
  | "confidence_gate_demoted_gold"
  | "too_many_optional_targets"
  | "zero_required_but_gold_exists"
  | "gold_patch_file_unavailable"
  | "repo_checkout_unavailable"
  | "unknown";

// Overpacking cutoff: a capsule that carries >3 emitted files per recovered gold
// file (and >=6 total files) is spending most of its budget on non-gold context.
const OVERPACK_RATIO_CUTOFF = 3;
const OVERPACK_MIN_FILES = 6;

export interface Classification {
  readonly outcome: Outcome;
  readonly reasons: FailureReason[];
}

// Classify one instance from its computed metrics. Deterministic and conservative:
// prefers `unknown` when gold/artifact evidence is insufficient, and only asserts a
// failure reason the metrics actually support.
export function classify(
  gold: GoldLabels,
  file: FileMetrics,
  target: TargetMetrics,
  opts: {
    /** True when the gold source files are all in a language with no parser. */
    readonly unparsedLanguageGold: boolean;
    /** True when the capsule named zero pivots (no_context / empty). */
    readonly zeroRequired: boolean;
  } = { unparsedLanguageGold: false, zeroRequired: false },
): Classification {
  const reasons: FailureReason[] = [];
  const hasSourceGold = gold.sourceFiles.length > 0;
  const sourceInTop3 = file.gold_file_recall_at_3 > 0 && file.lead_pivot_is_source_gold
    ? true
    : gold.sourceFiles.length > 0 && file.first_gold_file_rank !== null && file.first_gold_file_rank <= 3
      && file.source_gold_in_capsule;

  // --- primary outcome ---
  let outcome: Outcome;
  if (target.capsule_file_count === 0 && !file.any_gold_in_capsule) {
    outcome = "miss";
  } else if (hasSourceGold && !file.source_gold_in_capsule && !file.any_gold_in_top_10) {
    outcome = "miss";
  } else if (!hasSourceGold && file.test_gold_in_capsule) {
    outcome = "test_only";
  } else if (hasSourceGold && file.test_gold_in_capsule && !file.source_gold_in_capsule) {
    outcome = "test_only";
  } else if (
    file.lead_pivot_is_source_gold &&
    file.source_gold_in_capsule &&
    (file.hidden_coedit_recall === null || file.hidden_coedit_recall === 1) &&
    (target.overpacking_ratio === null || target.overpacking_ratio <= OVERPACK_RATIO_CUTOFF)
  ) {
    outcome = "excellent";
  } else if (
    (target.overpacking_ratio ?? 0) > OVERPACK_RATIO_CUTOFF &&
    target.capsule_file_count >= OVERPACK_MIN_FILES &&
    file.any_gold_in_capsule
  ) {
    outcome = "overpacked";
  } else if (
    file.any_gold_in_capsule &&
    !file.lead_pivot_is_gold &&
    target.required_target_count > 0 &&
    target.required_gold_file_count === 0
  ) {
    outcome = "wrong_pivot";
  } else if (
    file.source_gold_in_capsule &&
    (file.gold_file_recall_at_5 > 0 || file.lead_pivot_is_source_gold) &&
    (file.hidden_coedit_recall === null || file.hidden_coedit_recall === 1)
  ) {
    outcome = "good";
  } else if (file.any_gold_in_capsule || file.any_gold_in_top_10) {
    outcome = "partial";
  } else {
    outcome = "unknown";
  }

  // --- failure reasons (only for non-excellent outcomes) ---
  if (outcome !== "excellent") {
    if (opts.unparsedLanguageGold) reasons.push("language_coverage_gap");
    if (gold.multiFile && file.hidden_coedit_recall !== null && file.hidden_coedit_recall < 1) {
      reasons.push("hidden_coedit_missing");
    }
    if (opts.zeroRequired && (hasSourceGold || gold.scoredFiles.length > 0)) {
      reasons.push("zero_required_but_gold_exists");
    }
    if (
      hasSourceGold &&
      !file.source_gold_in_capsule &&
      file.first_gold_file_rank !== null &&
      file.first_gold_file_rank > 10
    ) {
      // Retrieved but ranked far below the cutoff.
      reasons.push("ranking_gap");
    }
    if (
      hasSourceGold &&
      file.first_gold_file_rank === null &&
      !opts.unparsedLanguageGold
    ) {
      // Never retrieved at all — a lexical/retrieval gap rather than a ranking one.
      reasons.push("lexical_mismatch");
    }
    if (
      outcome === "overpacked" ||
      (target.optional_target_count >= 6 && target.optional_non_gold_count >= target.optional_target_count - 1)
    ) {
      reasons.push("too_many_optional_targets");
    }
    if (outcome === "test_only") reasons.push("test_file_overweighted");
    if (outcome === "wrong_pivot") reasons.push("ranking_gap");
    if (
      file.any_gold_in_top_10 &&
      !file.any_gold_in_capsule
    ) {
      reasons.push("capsule_budget_excluded_gold");
    }
  }

  if (reasons.length === 0 && outcome !== "excellent" && outcome !== "good") {
    reasons.push("unknown");
  }
  return { outcome, reasons: [...new Set(reasons)] };
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

export function rate(flags: readonly boolean[]): number {
  if (flags.length === 0) return 0;
  return flags.filter(Boolean).length / flags.length;
}
