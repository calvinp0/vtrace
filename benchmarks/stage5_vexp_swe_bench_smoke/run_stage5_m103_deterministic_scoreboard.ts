// Stage 5 M103 — deterministic VTRACE scoreboard: structured task derivation
// rebaseline.
//
// Same generation/scoring path as M94–M102 (buildCapsuleV2 over the clean
// base-commit index; gold is scoring-only), re-run with the NEW DEFAULT task
// derivation (`deriveStructuredTaskFromProblemStatement`: V0 base + extracted
// exceptions / failing tests / capped traceback frames — the M102-winning V5
// shape) and the NEW provenance-based leakage policy (issue-authored gold paths
// are evidence and stay scored; gold-patch-derived paths still block).
//
// Comparisons: frozen M101 detail rows (old derivation + old leakage policy)
// and frozen M102 V5 variant rows (the measurement M103 must reproduce), on the
// M101-scored 99-id comparable set; plus the 100-case new-policy set (adds
// psf__requests-5414, previously leakage_blocked).
//
// NO Claude, NO Docker, NO agent run, NO API calls, NO live network.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent, CapsuleV2Mode, type CapsuleV2Result } from "../../src/capsuleV2/types";

import { loadSweBench, type SweBenchInstance } from "./build_stage5_retrieval_fixture";
import { deriveStructuredTaskFromProblemStatement } from "./stage5_task_derivation";
import {
  expectedFilesAreUnparsedLanguage,
  summarizeCapsule,
  type CapsuleSummary,
} from "./run_stage5_retrieval_eval";
import {
  assessGoldLeakage,
  capsuleFilesOf,
  classify,
  computeBudgetMetrics,
  computeFileMetrics,
  computeSymbolMetrics,
  computeTargetMetrics,
  extractGold,
  mean,
  median,
  percentile,
  rate,
  type BudgetMetrics,
  type CapsuleFiles,
  type CapsuleItemDetail,
  type Classification,
  type FailureReason,
  type FileMetrics,
  type GoldLeakageAssessment,
  type Outcome,
  type SymbolMetrics,
  type TargetMetrics,
} from "./stage5_m94_lib";

const DEFAULT_DATA = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
const RESULTS_ROOT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");
const WS_ROOT = path.join(RESULTS_ROOT, "workspaces");
const INDEX_RELPATH = path.join(".vtrace", "index.sqlite");
const CAPSULE_BUDGET = 8000;
const CLEAN_WS_ROOTS = ["expanded", "cross_repo"] as const;

// The M102 V5 loss cases the milestone must explicitly re-analyze, plus the
// leakage-policy case.
const REGRESSION_GUARD_IDS = [
  "django__django-13513",
  "matplotlib__matplotlib-22719",
  "pydata__xarray-4695",
] as const;
const LEAKAGE_POLICY_ID = "psf__requests-5414";

function resolveCleanWorkspace(instanceId: string): string | null {
  for (const root of CLEAN_WS_ROOTS) {
    const ws = path.join(WS_ROOT, root, instanceId);
    if (existsSync(path.join(ws, INDEX_RELPATH))) return ws;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-instance row
// ---------------------------------------------------------------------------

interface DerivationStats {
  readonly task_chars: number;
  readonly base_chars: number;
  readonly exception_count: number;
  readonly failing_test_count: number;
  readonly traceback_frame_count: number;
  readonly capped: boolean;
  readonly task_text: string;
}

interface LeakageStats {
  readonly verdict: GoldLeakageAssessment["verdict"];
  readonly issue_authored_paths: string[];
  readonly leaked_paths: string[];
}

interface DetailRow {
  readonly instance_id: string;
  readonly repo: string;
  readonly generation_status: "scored" | "missing_workspace" | "gold_unavailable" | "leakage_blocked" | "error";
  readonly status_detail: string | null;
  readonly gold: {
    readonly all_files: string[];
    readonly source_files: string[];
    readonly test_files: string[];
    readonly scored_files: string[];
    readonly source_only: boolean;
    readonly multi_file: boolean;
    readonly symbol_status: string;
  };
  readonly derivation: DerivationStats | null;
  readonly leakage: LeakageStats | null;
  readonly capsule: {
    readonly mode: string;
    readonly lead_pivot_file: string | null;
    readonly required_files: string[];
    readonly optional_files: string[];
    readonly capsule_files: string[];
    readonly ranked_top10: string[];
  } | null;
  readonly file_metrics: FileMetrics | null;
  readonly target_metrics: TargetMetrics | null;
  readonly budget_metrics: BudgetMetrics | null;
  readonly symbol_metrics: SymbolMetrics | null;
  readonly outcome: Outcome | null;
  readonly failure_reasons: FailureReason[];
}

function scoreInstance(instance: SweBenchInstance): DetailRow {
  const gold = extractGold(instance.patch);
  const goldBlock = {
    all_files: gold.allFiles,
    source_files: gold.sourceFiles,
    test_files: gold.testFiles,
    scored_files: gold.scoredFiles,
    source_only: gold.sourceOnly,
    multi_file: gold.multiFile,
    symbol_status: gold.symbolStatus,
  };
  const base = {
    instance_id: instance.instance_id,
    repo: instance.repo,
    gold: goldBlock,
    derivation: null,
    leakage: null,
    capsule: null,
    file_metrics: null,
    target_metrics: null,
    budget_metrics: null,
    symbol_metrics: null,
    outcome: null,
    failure_reasons: [] as FailureReason[],
  };

  if (gold.allFiles.length === 0) {
    return { ...base, generation_status: "gold_unavailable", status_detail: "no files in gold patch",
      failure_reasons: ["gold_patch_file_unavailable"] };
  }
  const workspace = resolveCleanWorkspace(instance.instance_id);
  if (workspace === null) {
    return { ...base, generation_status: "missing_workspace",
      status_detail: "no clean indexed workspace (expanded/cross_repo)",
      failure_reasons: ["repo_checkout_unavailable"] };
  }
  const derived = deriveStructuredTaskFromProblemStatement(instance.problem_statement);
  const derivation: DerivationStats = {
    task_chars: derived.diagnostics.taskChars,
    base_chars: derived.diagnostics.baseChars,
    exception_count: derived.diagnostics.exceptionCount,
    failing_test_count: derived.diagnostics.failingTestCount,
    traceback_frame_count: derived.diagnostics.tracebackFrameCount,
    capped: derived.diagnostics.capped,
    task_text: derived.taskText,
  };
  if (derived.taskText.length === 0) {
    return { ...base, derivation, generation_status: "gold_unavailable",
      status_detail: "empty problem statement", failure_reasons: ["unknown"] };
  }
  // Provenance-based leakage policy: issue-authored gold paths are evidence
  // (diagnostic only); a gold path the issue never contained is contamination
  // and still blocks scoring.
  const assessed = assessGoldLeakage(derived.taskText, instance.problem_statement, gold);
  const leakage: LeakageStats = {
    verdict: assessed.verdict,
    issue_authored_paths: assessed.issueAuthoredPaths,
    leaked_paths: assessed.leakedPaths,
  };
  if (assessed.verdict === "gold_patch_leak") {
    return { ...base, derivation, leakage, generation_status: "leakage_blocked",
      status_detail: `gold-patch-derived path in task: ${assessed.leakedPaths.join(", ")}`,
      failure_reasons: ["unknown"] };
  }

  let result: CapsuleV2Result;
  const db = openIndexerDatabase(path.join(workspace, INDEX_RELPATH));
  try {
    result = buildCapsuleV2({
      db, repoRoot: workspace, task: derived.taskText, intent: CapsuleIntent.Debug, maxTokens: CAPSULE_BUDGET,
    });
  } catch (error) {
    db.close();
    return { ...base, derivation, leakage, generation_status: "error",
      status_detail: error instanceof Error ? error.message : String(error), failure_reasons: ["unknown"] };
  }
  db.close();

  const summary: CapsuleSummary = summarizeCapsule(result);
  const cf: CapsuleFiles = capsuleFilesOf(summary);
  const items: CapsuleItemDetail[] = [...result.pivots, ...result.support].map((it) => ({
    path: it.path,
    role: it.role,
    contentMode: it.content_mode,
    chars: (it.source?.length ?? 0) + (it.signature?.length ?? 0),
    estTokens: it.estimated_tokens,
  }));
  const discardReasons = result.discarded.map((d) => d.discard_reason);

  const fileMetrics = computeFileMetrics(summary, gold, cf);
  const targetMetrics = computeTargetMetrics(gold, cf);
  const budgetMetrics = computeBudgetMetrics(summary, items, gold, cf, discardReasons);
  const symbolMetrics = computeSymbolMetrics(summary, gold);

  const zeroRequired = summary.pivots.length === 0 || result.actual_mode === CapsuleV2Mode.NoContext;
  const unparsedLanguageGold = expectedFilesAreUnparsedLanguage(gold.scoredFiles);
  const classification: Classification = classify(gold, fileMetrics, targetMetrics, { unparsedLanguageGold, zeroRequired });

  return {
    ...base,
    generation_status: "scored",
    status_detail: null,
    derivation,
    leakage,
    capsule: {
      mode: result.actual_mode,
      lead_pivot_file: cf.leadPivotFile,
      required_files: cf.requiredFiles,
      optional_files: cf.optionalFiles,
      capsule_files: cf.capsuleFiles,
      ranked_top10: [...cf.requiredFiles, ...cf.optionalFiles].slice(0, 10),
    },
    file_metrics: fileMetrics,
    target_metrics: targetMetrics,
    budget_metrics: budgetMetrics,
    symbol_metrics: symbolMetrics,
    outcome: classification.outcome,
    failure_reasons: classification.reasons,
  };
}

// ---------------------------------------------------------------------------
// Unified comparison row (M103 fresh / frozen M101 / frozen M102 V5)
// ---------------------------------------------------------------------------

interface CompareRow {
  readonly instance_id: string;
  readonly repo: string;
  readonly cohort: "dev" | "holdout";
  readonly multi_file: boolean;
  readonly fm: FileMetrics;
  readonly tm: TargetMetrics;
  readonly est_tokens: number;
  readonly task_chars: number | null;
  readonly exception_count: number | null;
  readonly failing_test_count: number | null;
  readonly traceback_frame_count: number | null;
  readonly outcome: string | null;
  readonly lead_pivot_file: string | null;
  readonly issue_authored_gold_path: boolean;
}

interface Aggregate {
  readonly cohort: string;
  readonly n: number;
  readonly recall_at_1: number;
  readonly recall_at_3: number;
  readonly recall_at_5: number;
  readonly recall_at_10: number;
  readonly mrr: number;
  readonly any_gold_in_capsule: number;
  readonly all_gold_in_capsule: number;
  readonly source_gold_in_capsule: number;
  readonly lead_pivot_is_source_gold: number;
  readonly lead_pivot_is_any_gold: number;
  readonly gold_file_in_required: number;
  readonly hidden_coedit_recall: number | null;
  readonly multi_file_all_gold_in_capsule: number | null;
  readonly wrong_pivot_count: number;
  readonly miss_count: number;
  readonly overpacked_count: number;
  readonly outcomes: Record<string, number>;
  readonly median_capsule_est_tokens: number;
  readonly p90_capsule_est_tokens: number;
  readonly mean_capsule_file_count: number;
  readonly median_capsule_file_count: number;
  readonly task_text_median_chars: number | null;
  readonly task_text_p90_chars: number | null;
  readonly mean_exceptions_count: number | null;
  readonly mean_failing_tests_count: number | null;
  readonly mean_traceback_frame_count: number | null;
  readonly issue_authored_gold_path_count: number;
}

function aggregate(cohort: string, rows: readonly CompareRow[]): Aggregate {
  const fm = rows.map((r) => r.fm);
  const tm = rows.map((r) => r.tm);
  const hidden = fm.map((m) => m.hidden_coedit_recall).filter((v): v is number => v !== null);
  const multi = rows.filter((r) => r.multi_file);
  const outcomes: Record<string, number> = {};
  for (const r of rows) outcomes[r.outcome ?? "unknown"] = (outcomes[r.outcome ?? "unknown"] ?? 0) + 1;
  const chars = rows.map((r) => r.task_chars).filter((v): v is number => v !== null);
  const meanOrNull = (xs: Array<number | null>): number | null => {
    const vals = xs.filter((v): v is number => v !== null);
    return vals.length > 0 ? mean(vals) : null;
  };
  return {
    cohort,
    n: rows.length,
    recall_at_1: mean(fm.map((m) => m.gold_file_recall_at_1)),
    recall_at_3: mean(fm.map((m) => m.gold_file_recall_at_3)),
    recall_at_5: mean(fm.map((m) => m.gold_file_recall_at_5)),
    recall_at_10: mean(fm.map((m) => m.gold_file_recall_at_10)),
    mrr: mean(fm.map((m) => m.mrr_first_gold_file)),
    any_gold_in_capsule: rate(fm.map((m) => m.any_gold_in_capsule)),
    all_gold_in_capsule: rate(fm.map((m) => m.all_gold_in_capsule)),
    source_gold_in_capsule: rate(fm.map((m) => m.source_gold_in_capsule)),
    lead_pivot_is_source_gold: rate(fm.map((m) => m.lead_pivot_is_source_gold)),
    lead_pivot_is_any_gold: rate(fm.map((m) => m.lead_pivot_is_gold)),
    gold_file_in_required: rate(tm.map((m) => m.gold_file_in_required)),
    hidden_coedit_recall: hidden.length > 0 ? mean(hidden) : null,
    multi_file_all_gold_in_capsule:
      multi.length > 0 ? rate(multi.map((r) => r.fm.all_gold_in_capsule)) : null,
    wrong_pivot_count: outcomes["wrong_pivot"] ?? 0,
    miss_count: outcomes["miss"] ?? 0,
    overpacked_count: outcomes["overpacked"] ?? 0,
    outcomes,
    median_capsule_est_tokens: median(rows.map((r) => r.est_tokens)),
    p90_capsule_est_tokens: percentile(rows.map((r) => r.est_tokens), 90),
    mean_capsule_file_count: mean(tm.map((m) => m.capsule_file_count)),
    median_capsule_file_count: median(tm.map((m) => m.capsule_file_count)),
    task_text_median_chars: chars.length > 0 ? median(chars) : null,
    task_text_p90_chars: chars.length > 0 ? percentile(chars, 90) : null,
    mean_exceptions_count: meanOrNull(rows.map((r) => r.exception_count)),
    mean_failing_tests_count: meanOrNull(rows.map((r) => r.failing_test_count)),
    mean_traceback_frame_count: meanOrNull(rows.map((r) => r.traceback_frame_count)),
    issue_authored_gold_path_count: rows.filter((r) => r.issue_authored_gold_path).length,
  };
}

// ---------------------------------------------------------------------------
// Frozen-row loaders
// ---------------------------------------------------------------------------

interface SplitFile { readonly dev: string[]; readonly holdout: string[]; }

interface M101DetailFile {
  rows: Array<{
    instance_id: string;
    repo: string;
    generation_status: string;
    gold: { multi_file: boolean };
    capsule: { lead_pivot_file: string | null } | null;
    file_metrics: FileMetrics | null;
    target_metrics: TargetMetrics | null;
    budget_metrics: { capsule_est_tokens: number } | null;
    outcome: string | null;
    failure_reasons: string[];
  }>;
}

interface M102DetailFile {
  rows: Array<{
    variant: string;
    instance_id: string;
    repo: string;
    cohort: "dev" | "holdout";
    status: string;
    task_chars: number;
    gold_path_in_task: boolean;
    outcome: string | null;
    lead_pivot_file: string | null;
    capsule_est_tokens: number | null;
    fm: FileMetrics | null;
    tm: TargetMetrics | null;
    multi_file: boolean;
  }>;
}

function m101ToCompare(row: M101DetailFile["rows"][number], devSet: ReadonlySet<string>): CompareRow {
  return {
    instance_id: row.instance_id,
    repo: row.repo,
    cohort: devSet.has(row.instance_id) ? "dev" : "holdout",
    multi_file: row.gold.multi_file,
    fm: row.file_metrics!,
    tm: row.target_metrics!,
    est_tokens: row.budget_metrics!.capsule_est_tokens,
    task_chars: null,
    exception_count: null,
    failing_test_count: null,
    traceback_frame_count: null,
    outcome: row.outcome,
    lead_pivot_file: row.capsule?.lead_pivot_file ?? null,
    issue_authored_gold_path: false,
  };
}

function v5ToCompare(row: M102DetailFile["rows"][number]): CompareRow {
  return {
    instance_id: row.instance_id,
    repo: row.repo,
    cohort: row.cohort,
    multi_file: row.multi_file,
    fm: row.fm!,
    tm: row.tm!,
    est_tokens: row.capsule_est_tokens ?? 0,
    task_chars: row.task_chars,
    exception_count: null,
    failing_test_count: null,
    traceback_frame_count: null,
    outcome: row.outcome,
    lead_pivot_file: row.lead_pivot_file,
    issue_authored_gold_path: row.gold_path_in_task,
  };
}

function m103ToCompare(row: DetailRow, devSet: ReadonlySet<string>): CompareRow {
  return {
    instance_id: row.instance_id,
    repo: row.repo,
    cohort: devSet.has(row.instance_id) ? "dev" : "holdout",
    multi_file: row.gold.multi_file,
    fm: row.file_metrics!,
    tm: row.target_metrics!,
    est_tokens: row.budget_metrics!.capsule_est_tokens,
    task_chars: row.derivation!.task_chars,
    exception_count: row.derivation!.exception_count,
    failing_test_count: row.derivation!.failing_test_count,
    traceback_frame_count: row.derivation!.traceback_frame_count,
    outcome: row.outcome,
    lead_pivot_file: row.capsule?.lead_pivot_file ?? null,
    issue_authored_gold_path: row.leakage?.verdict === "issue_authored_gold_path",
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function n3(x: number | null): string { return x === null ? "—" : x.toFixed(3); }
function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }
function csvEscape(v: string): string { return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }

async function main(): Promise<void> {
  const dataPath = process.argv.includes("--swe-bench-data")
    ? process.argv[process.argv.indexOf("--swe-bench-data") + 1]!
    : DEFAULT_DATA;

  const swe = await loadSweBench(dataPath);
  const instances = [...swe.values()].sort((a, b) => a.instance_id.localeCompare(b.instance_id));

  const split = JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m95_dev_holdout_split.json"), "utf8")) as SplitFile;
  const devSet = new Set(split.dev);

  const m101Detail = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m101_deterministic_scoreboard.detail.json"), "utf8"),
  ) as M101DetailFile;
  const m101Scored = m101Detail.rows.filter((r) => r.generation_status === "scored" && r.file_metrics && r.target_metrics);
  const m101Ids = new Set(m101Scored.map((r) => r.instance_id));
  const m101Compare = m101Scored.map((r) => m101ToCompare(r, devSet));
  const m101ById = new Map(m101Compare.map((r) => [r.instance_id, r] as const));

  const m102Detail = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m102_task_derivation_variants.detail.json"), "utf8"),
  ) as M102DetailFile;
  const v5Compare = m102Detail.rows
    .filter((r) => r.variant === "V5_title_plus_errors" && r.status === "scored" && r.fm && r.tm)
    .map(v5ToCompare);
  const v5ById = new Map(v5Compare.map((r) => [r.instance_id, r] as const));

  const gapAudit = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m102_task_derivation_gap_audit.json"), "utf8"),
  ) as { cases: Array<{ instance_id: string; has_evidence_beyond_v0: boolean }> };
  const beyondIds = new Set(gapAudit.cases.filter((c) => c.has_evidence_beyond_v0).map((c) => c.instance_id));

  // ---- fresh M103 scoring over ALL instances ----
  const rows: DetailRow[] = [];
  for (const inst of instances) {
    const row = scoreInstance(inst);
    rows.push(row);
    const leak = row.leakage && row.leakage.verdict !== "clean" ? ` [${row.leakage.verdict}]` : "";
    process.stdout.write(`${row.generation_status === "scored" ? "✓" : "·"} ${inst.instance_id}: ${row.outcome ?? row.generation_status}${leak}\n`);
  }
  const scored = rows.filter((r) => r.generation_status === "scored" && r.file_metrics && r.target_metrics);
  const m103All = scored.map((r) => m103ToCompare(r, devSet));
  const m103ById = new Map(m103All.map((r) => [r.instance_id, r] as const));
  const m103Comparable = m103All.filter((r) => m101Ids.has(r.instance_id));

  const coverage = {
    attempted: rows.length,
    scored: scored.length,
    missing_workspace: rows.filter((r) => r.generation_status === "missing_workspace").length,
    gold_unavailable: rows.filter((r) => r.generation_status === "gold_unavailable").length,
    leakage_blocked: rows.filter((r) => r.generation_status === "leakage_blocked").length,
    error: rows.filter((r) => r.generation_status === "error").length,
    issue_authored_gold_path: rows.filter((r) => r.leakage?.verdict === "issue_authored_gold_path").length,
    gold_patch_leak_block_count: rows.filter((r) => r.leakage?.verdict === "gold_patch_leak").length,
    newly_scored_vs_m101: scored.filter((r) => !m101Ids.has(r.instance_id)).map((r) => r.instance_id),
  };

  // ---- V5 reproduction parity (the core M103 proof) ----
  const v5ParityMismatches = m103Comparable
    .map((r) => {
      const v5 = v5ById.get(r.instance_id);
      if (v5 === undefined) return { instance_id: r.instance_id, field: "missing_v5_row", m103: r.outcome, v5: null };
      if (v5.outcome !== r.outcome) return { instance_id: r.instance_id, field: "outcome", m103: r.outcome, v5: v5.outcome };
      if (v5.lead_pivot_file !== r.lead_pivot_file) {
        return { instance_id: r.instance_id, field: "lead_pivot_file", m103: r.lead_pivot_file, v5: v5.lead_pivot_file };
      }
      if (v5.task_chars !== r.task_chars) {
        return { instance_id: r.instance_id, field: "task_chars", m103: String(r.task_chars), v5: String(v5.task_chars) };
      }
      return null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // ---- aggregates ----
  const sub = (rowsIn: readonly CompareRow[], pred: (r: CompareRow) => boolean): CompareRow[] => rowsIn.filter(pred);
  const tri = (name: string, pred: (r: CompareRow) => boolean) => ({
    m101: aggregate(`m101_${name}`, sub(m101Compare, pred)),
    v5: aggregate(`v5_${name}`, sub(v5Compare, pred)),
    m103: aggregate(name, sub(m103Comparable, pred)),
  });

  const all = tri("all_comparable", () => true);
  const dev = tri("dev", (r) => r.cohort === "dev");
  const holdout = tri("holdout", (r) => r.cohort === "holdout");
  const beyond = tri("evidence_beyond_v0", (r) => beyondIds.has(r.instance_id));
  const noBeyond = tri("no_evidence_beyond_v0", (r) => !beyondIds.has(r.instance_id));
  const newPolicy = aggregate("m103_new_policy_all_scored", m103All);
  const newPolicyDev = aggregate("m103_new_policy_dev", m103All.filter((r) => r.cohort === "dev"));
  const newPolicyHoldout = aggregate("m103_new_policy_holdout", m103All.filter((r) => r.cohort === "holdout"));

  const repos = [...new Set(m103Comparable.map((r) => r.repo))].sort();
  const byRepo = repos.map((repo) => ({
    repo,
    m101: aggregate(repo, m101Compare.filter((r) => r.repo === repo)),
    v5: aggregate(repo, v5Compare.filter((r) => r.repo === repo)),
    m103: aggregate(repo, m103Comparable.filter((r) => r.repo === repo)),
  }));

  // ---- flips vs M101 ----
  const outcomeFlips = m103Comparable
    .map((r) => {
      const before = m101ById.get(r.instance_id);
      if (before === undefined || before.outcome === r.outcome) return null;
      return { instance_id: r.instance_id, from: before.outcome, to: r.outcome, cohort: r.cohort };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);
  const leadFlips = m103Comparable
    .map((r) => {
      const before = m101ById.get(r.instance_id);
      if (before === undefined || before.lead_pivot_file === r.lead_pivot_file) return null;
      return {
        instance_id: r.instance_id,
        lead_pivot_old: before.lead_pivot_file,
        lead_pivot_new: r.lead_pivot_file,
        lead_was_source_gold: before.fm.lead_pivot_is_source_gold,
        lead_now_source_gold: r.fm.lead_pivot_is_source_gold,
        cohort: r.cohort,
      };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);
  const allGoldFlips = m103Comparable
    .map((r) => {
      const before = m101ById.get(r.instance_id);
      if (before === undefined || before.fm.all_gold_in_capsule === r.fm.all_gold_in_capsule) return null;
      return { instance_id: r.instance_id, direction: r.fm.all_gold_in_capsule ? "gained" : "lost", cohort: r.cohort };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  // ---- regression guard + leakage policy cases ----
  const guardCase = (id: string) => {
    const m101 = m101ById.get(id) ?? null;
    const v5 = v5ById.get(id) ?? null;
    const m103 = m103ById.get(id) ?? null;
    const detail = rows.find((r) => r.instance_id === id) ?? null;
    const pick = (r: CompareRow | null) => r === null ? null : {
      outcome: r.outcome,
      lead_pivot_file: r.lead_pivot_file,
      any_gold_in_capsule: r.fm.any_gold_in_capsule,
      all_gold_in_capsule: r.fm.all_gold_in_capsule,
      lead_pivot_is_source_gold: r.fm.lead_pivot_is_source_gold,
      gold_file_in_required: r.tm.gold_file_in_required,
      recall_at_5: r.fm.gold_file_recall_at_5,
      overpacking_ratio: r.tm.overpacking_ratio,
      capsule_file_count: r.tm.capsule_file_count,
    };
    return {
      instance_id: id,
      cohort: devSet.has(id) ? "dev" : "holdout",
      m101: pick(m101),
      m102_v5: pick(v5),
      m103: pick(m103),
      m103_generation_status: detail?.generation_status ?? "not_attempted",
      m103_status_detail: detail?.status_detail ?? null,
      m103_leakage: detail?.leakage ?? null,
    };
  };
  const regressionGuards = REGRESSION_GUARD_IDS.map(guardCase);
  const leakagePolicyCase = guardCase(LEAKAGE_POLICY_ID);

  // ---- outputs ----
  await mkdir(RESULTS_ROOT, { recursive: true });
  const w = (name: string, data: unknown) =>
    writeFile(path.join(RESULTS_ROOT, name), JSON.stringify(data, null, 2) + "\n", "utf8");

  const outcomeDist: Record<string, number> = {};
  for (const r of scored) outcomeDist[r.outcome ?? "unknown"] = (outcomeDist[r.outcome ?? "unknown"] ?? 0) + 1;
  const reasonDist: Record<string, number> = {};
  for (const r of rows) for (const reason of r.failure_reasons) reasonDist[reason] = (reasonDist[reason] ?? 0) + 1;

  await w("stage5_m103_deterministic_scoreboard.json", {
    milestone: "M103",
    kind: "Deterministic VTRACE scoreboard rebaseline (structured task derivation = product default; provenance-based leakage policy)",
    live_agents: false, docker: false, api_spend: false,
    generation: {
      intent: "debug", budget: CAPSULE_BUDGET, builder: "buildCapsuleV2 (in-process)",
      task_derivation: "deriveStructuredTaskFromProblemStatement (V0 base + exceptions<=6 + failing tests<=6 + traceback frames<=8, 1200-char total cap; byte-identical to M102 V5)",
      leakage_policy: "issue-authored gold paths scored with diagnostic; gold-patch-derived paths blocked",
    },
    coverage,
    v5_parity_mismatches: v5ParityMismatches,
    comparable_set: {
      note: "M101-scored 99-id set; m101/v5 columns re-aggregated from frozen detail rows on identical ids",
      all: all, dev, holdout,
      evidence_beyond_v0: beyond,
      no_evidence_beyond_v0: noBeyond,
    },
    new_policy_set: { all: newPolicy, dev: newPolicyDev, holdout: newPolicyHoldout },
    by_repo: byRepo,
    outcome_distribution: outcomeDist,
    failure_reason_distribution: reasonDist,
    outcome_flips_vs_m101: outcomeFlips,
    lead_pivot_flips_vs_m101: leadFlips,
    all_gold_flips_vs_m101: allGoldFlips,
    regression_guard_cases: regressionGuards,
    leakage_policy_case: leakagePolicyCase,
  });
  await w("stage5_m103_deterministic_scoreboard.detail.json", { milestone: "M103", count: rows.length, rows });
  await w("stage5_m103_deterministic_failure_modes.json", {
    milestone: "M103",
    outcome_distribution: outcomeDist,
    failure_reason_distribution: reasonDist,
    misses: scored.filter((r) => r.outcome === "miss" || r.outcome === "wrong_pivot").map((r) => ({
      instance_id: r.instance_id, repo: r.repo, gold_files: r.gold.scored_files,
      capsule_files: r.capsule?.capsule_files ?? [], outcome: r.outcome, failure_reasons: r.failure_reasons,
      in_dev: devSet.has(r.instance_id),
    })),
    overpacked: scored.filter((r) => r.outcome === "overpacked").map((r) => ({
      instance_id: r.instance_id, repo: r.repo, overpacking_ratio: r.target_metrics!.overpacking_ratio,
      capsule_file_count: r.target_metrics!.capsule_file_count, capsule_est_tokens: r.budget_metrics!.capsule_est_tokens,
    })),
  });

  const repoCsv = [
    "repo,n,recall_at_1,recall_at_5,recall_at_10,mrr,any_gold_in_capsule,all_gold_in_capsule,lead_pivot_is_source_gold,gold_file_in_required,hidden_coedit_recall,median_est_tokens,mean_capsule_files,task_p90_chars,m101_recall_at_5,m101_lead_src_gold,m101_mean_capsule_files,v5_recall_at_5,v5_lead_src_gold",
    ...byRepo.sort((a, b) => b.m103.n - a.m103.n).map(({ repo, m101, v5, m103 }) =>
      [repo, m103.n, m103.recall_at_1.toFixed(4), m103.recall_at_5.toFixed(4), m103.recall_at_10.toFixed(4), m103.mrr.toFixed(4),
        m103.any_gold_in_capsule.toFixed(4), m103.all_gold_in_capsule.toFixed(4), m103.lead_pivot_is_source_gold.toFixed(4),
        m103.gold_file_in_required.toFixed(4),
        m103.hidden_coedit_recall === null ? "" : m103.hidden_coedit_recall.toFixed(4),
        m103.median_capsule_est_tokens, m103.mean_capsule_file_count.toFixed(3),
        m103.task_text_p90_chars ?? "",
        m101.recall_at_5.toFixed(4), m101.lead_pivot_is_source_gold.toFixed(4), m101.mean_capsule_file_count.toFixed(3),
        v5.recall_at_5.toFixed(4), v5.lead_pivot_is_source_gold.toFixed(4)]
        .map((x) => csvEscape(String(x))).join(",")),
  ].join("\n");
  await writeFile(path.join(RESULTS_ROOT, "stage5_m103_deterministic_by_repo.csv"), repoCsv + "\n", "utf8");

  const missCsv = [
    "instance_id,repo,gold_files,top_candidates,capsule_files,failure_reason,cohort,task_chars",
    ...scored.filter((r) => r.outcome === "miss" || r.outcome === "wrong_pivot").map((r) =>
      [r.instance_id, r.repo, r.gold.scored_files.join(" "), (r.capsule?.ranked_top10 ?? []).slice(0, 3).join(" "),
        (r.capsule?.capsule_files ?? []).slice(0, 3).join(" "), r.failure_reasons.join(" "),
        devSet.has(r.instance_id) ? "dev" : "holdout", r.derivation?.task_chars ?? ""]
        .map((x) => csvEscape(String(x))).join(",")),
  ].join("\n");
  await writeFile(path.join(RESULTS_ROOT, "stage5_m103_deterministic_top_misses.csv"), missCsv + "\n", "utf8");

  const md = renderMd({
    coverage, all, dev, holdout, beyond, noBeyond,
    newPolicy, newPolicyDev, newPolicyHoldout,
    byRepo, outcomeDist, reasonDist,
    v5ParityMismatches, outcomeFlips, leadFlips, allGoldFlips,
    regressionGuards, leakagePolicyCase,
  });
  await writeFile(path.join(RESULTS_ROOT, "stage5_m103_deterministic_scoreboard.md"), md, "utf8");

  process.stdout.write(
    `\nM103 scoreboard: ${coverage.scored}/${coverage.attempted} scored (newly scored vs M101: ${coverage.newly_scored_vs_m101.join(", ") || "none"})\n` +
      `V5 parity mismatches: ${v5ParityMismatches.length === 0 ? "none" : JSON.stringify(v5ParityMismatches)}\n` +
      `ALL(99) r@1=${all.m103.recall_at_1.toFixed(3)} (M101 ${all.m101.recall_at_1.toFixed(3)}, V5 ${all.v5.recall_at_1.toFixed(3)}) r@5=${all.m103.recall_at_5.toFixed(3)} any=${pct(all.m103.any_gold_in_capsule)} all=${pct(all.m103.all_gold_in_capsule)} lead=${pct(all.m103.lead_pivot_is_source_gold)} wp=${all.m103.wrong_pivot_count} miss=${all.m103.miss_count} op=${all.m103.overpacked_count} files=${all.m103.mean_capsule_file_count.toFixed(3)}\n` +
      `HOLDOUT r@5=${holdout.m103.recall_at_5.toFixed(3)} (M101 ${holdout.m101.recall_at_5.toFixed(3)}) lead=${pct(holdout.m103.lead_pivot_is_source_gold)} (M101 ${pct(holdout.m101.lead_pivot_is_source_gold)}) any=${pct(holdout.m103.any_gold_in_capsule)} (M101 ${pct(holdout.m101.any_gold_in_capsule)}, V5 ${pct(holdout.v5.any_gold_in_capsule)})\n` +
      `NEW-POLICY(${newPolicy.n}) r@5=${newPolicy.recall_at_5.toFixed(3)} any=${pct(newPolicy.any_gold_in_capsule)} lead=${pct(newPolicy.lead_pivot_is_source_gold)}\n` +
      `psf__requests-5414: ${leakagePolicyCase.m103_generation_status} ${leakagePolicyCase.m103?.outcome ?? leakagePolicyCase.m103_status_detail ?? ""}\n` +
      `task chars med/p90: ${all.m103.task_text_median_chars}/${all.m103.task_text_p90_chars}\n`,
  );
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

interface Tri { m101: Aggregate; v5: Aggregate; m103: Aggregate; }

interface RenderInput {
  coverage: {
    attempted: number; scored: number;
    issue_authored_gold_path: number; gold_patch_leak_block_count: number;
    newly_scored_vs_m101: string[];
  };
  all: Tri; dev: Tri; holdout: Tri; beyond: Tri; noBeyond: Tri;
  newPolicy: Aggregate; newPolicyDev: Aggregate; newPolicyHoldout: Aggregate;
  byRepo: Array<{ repo: string; m101: Aggregate; v5: Aggregate; m103: Aggregate }>;
  outcomeDist: Record<string, number>; reasonDist: Record<string, number>;
  v5ParityMismatches: Array<{ instance_id: string; field: string }>;
  outcomeFlips: Array<{ instance_id: string; from: string | null; to: string | null; cohort: string }>;
  leadFlips: Array<{ instance_id: string; lead_pivot_old: string | null; lead_pivot_new: string | null; lead_was_source_gold: boolean; lead_now_source_gold: boolean; cohort: string }>;
  allGoldFlips: Array<{ instance_id: string; direction: string; cohort: string }>;
  regressionGuards: ReturnType<typeof Object>[] | unknown[];
  leakagePolicyCase: unknown;
}

function triTable(title: string, t: Tri): string {
  const row = (metric: string, f: (a: Aggregate) => string): string =>
    `| ${metric} | ${f(t.m101)} | ${f(t.v5)} | ${f(t.m103)} |`;
  const num = (g: (a: Aggregate) => number) => (a: Aggregate) => n3(g(a));
  const p = (g: (a: Aggregate) => number) => (a: Aggregate) => pct(g(a));
  const int = (g: (a: Aggregate) => number) => (a: Aggregate) => String(g(a));
  const opt = (g: (a: Aggregate) => number | null) => (a: Aggregate) => {
    const v = g(a);
    return v === null ? "—" : String(v);
  };
  return `### ${title} (n=${t.m103.n})

| metric | M101 | M102 V5 | M103 |
| --- | --- | --- | --- |
${row("recall@1", num((a) => a.recall_at_1))}
${row("recall@3", num((a) => a.recall_at_3))}
${row("recall@5", num((a) => a.recall_at_5))}
${row("recall@10", num((a) => a.recall_at_10))}
${row("MRR", num((a) => a.mrr))}
${row("any_gold_in_capsule", p((a) => a.any_gold_in_capsule))}
${row("all_gold_in_capsule", p((a) => a.all_gold_in_capsule))}
${row("source_gold_in_capsule", p((a) => a.source_gold_in_capsule))}
${row("lead_pivot_is_source_gold", p((a) => a.lead_pivot_is_source_gold))}
${row("lead_pivot_is_any_gold", p((a) => a.lead_pivot_is_any_gold))}
${row("gold_file_in_required", p((a) => a.gold_file_in_required))}
${row("hidden_coedit_recall", (a) => n3(a.hidden_coedit_recall))}
${row("multi_file_all_gold_in_capsule", (a) => a.multi_file_all_gold_in_capsule === null ? "—" : pct(a.multi_file_all_gold_in_capsule))}
${row("wrong_pivot", int((a) => a.wrong_pivot_count))}
${row("miss", int((a) => a.miss_count))}
${row("overpacked", int((a) => a.overpacked_count))}
${row("excellent", (a) => String(a.outcomes["excellent"] ?? 0))}
${row("median capsule tokens", int((a) => a.median_capsule_est_tokens))}
${row("p90 capsule tokens", int((a) => a.p90_capsule_est_tokens))}
${row("mean capsule files", (a) => a.mean_capsule_file_count.toFixed(3))}
${row("median capsule files", (a) => String(a.median_capsule_file_count))}
${row("task chars median", opt((a) => a.task_text_median_chars))}
${row("task chars p90", opt((a) => a.task_text_p90_chars))}
${row("issue_authored_gold_path", int((a) => a.issue_authored_gold_path_count))}
`;
}

function renderMd(input: RenderInput): string {
  const {
    coverage, all, dev, holdout, beyond, noBeyond,
    newPolicy, newPolicyDev, newPolicyHoldout, byRepo,
    outcomeDist, reasonDist, v5ParityMismatches, outcomeFlips, leadFlips, allGoldFlips,
    regressionGuards, leakagePolicyCase,
  } = input;
  const outcomeLine = Object.entries(outcomeDist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
  const reasonLine = Object.entries(reasonDist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
  const flipLine = outcomeFlips.length === 0 ? "none"
    : outcomeFlips.map((f) => `${f.instance_id} ${f.from}→${f.to} [${f.cohort}]`).join(", ");
  const leadLine = leadFlips.length === 0 ? "none"
    : leadFlips.map((f) => `${f.instance_id} ${f.lead_pivot_old ?? "—"}→${f.lead_pivot_new ?? "—"}${f.lead_now_source_gold ? " (now gold)" : f.lead_was_source_gold ? " (LOST gold)" : ""} [${f.cohort}]`).join(", ");
  const allGoldLine = allGoldFlips.length === 0 ? "none"
    : allGoldFlips.map((f) => `${f.instance_id} ${f.direction} [${f.cohort}]`).join(", ");
  const npLine = (a: Aggregate) =>
    `n=${a.n} r@1=${n3(a.recall_at_1)} r@5=${n3(a.recall_at_5)} any=${pct(a.any_gold_in_capsule)} all=${pct(a.all_gold_in_capsule)} lead=${pct(a.lead_pivot_is_source_gold)} wp=${a.wrong_pivot_count} miss=${a.miss_count} op=${a.overpacked_count} files=${a.mean_capsule_file_count.toFixed(3)} taskP90=${a.task_text_p90_chars}`;
  return `# Stage 5 M103 Deterministic Scoreboard (structured task derivation rebaseline)

_Deterministic, offline: no live agents, no Docker, no API spend. Same
generation path as M94–M102; task derivation is now the structured M103
default (V0 base + exceptions + failing tests + capped traceback frames), and
the leakage policy is provenance-based (issue-authored gold paths scored with
a diagnostic; gold-patch-derived paths still block)._

## Coverage

- Scored: **${coverage.scored}/${coverage.attempted}** (M101 scored 99/100)
- Newly scored vs M101: ${coverage.newly_scored_vs_m101.join(", ") || "none"}
- issue_authored_gold_path diagnostics: ${coverage.issue_authored_gold_path}
- gold_patch_leak blocks: ${coverage.gold_patch_leak_block_count}

## M102 V5 Reproduction

V5 parity mismatches (outcome / lead pivot / task chars, on the 99-id
comparable set): ${v5ParityMismatches.length === 0 ? "**none — exact reproduction**" : JSON.stringify(v5ParityMismatches)}

## Comparable-Set Metrics (M101-scored 99 ids)

${triTable("All scored", all)}
${triTable("Dev", dev)}
${triTable("Holdout", holdout)}
${triTable("Evidence-beyond-V0 cohort", beyond)}
${triTable("No-evidence-beyond-V0 cohort", noBeyond)}

## New-Policy Set (all M103-scored, includes psf__requests-5414)

- ALL: ${npLine(newPolicy)}
- DEV: ${npLine(newPolicyDev)}
- HOLDOUT: ${npLine(newPolicyHoldout)}

## Flips vs M101

- Outcome flips: ${flipLine}
- Lead-pivot flips: ${leadLine}
- All-gold flips: ${allGoldLine}

## Regression Guard Cases

\`\`\`json
${JSON.stringify(regressionGuards, null, 2)}
\`\`\`

## Leakage Policy Case (psf__requests-5414)

\`\`\`json
${JSON.stringify(leakagePolicyCase, null, 2)}
\`\`\`

## By Repo (M103, with M101/V5 baselines in the CSV)

| repo | n | r@1 | r@5 | MRR | any | all | lead=src | gold-in-req | files | medTok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${byRepo.sort((a, b) => b.m103.n - a.m103.n).map(({ repo, m103 }) =>
  `| ${repo} | ${m103.n} | ${n3(m103.recall_at_1)} | ${n3(m103.recall_at_5)} | ${n3(m103.mrr)} | ${pct(m103.any_gold_in_capsule)} | ${pct(m103.all_gold_in_capsule)} | ${pct(m103.lead_pivot_is_source_gold)} | ${pct(m103.gold_file_in_required)} | ${m103.mean_capsule_file_count.toFixed(2)} | ${m103.median_capsule_est_tokens} |`).join("\n")}

## Distributions

- Outcomes: ${outcomeLine}
- Failure reasons: ${reasonLine}
`;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
