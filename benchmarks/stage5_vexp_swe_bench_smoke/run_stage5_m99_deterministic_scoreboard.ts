// Stage 5 M99 — deterministic VTRACE retrieval/capsule scoreboard: runner.
//
// Same generation/scoring path as M94–M98 (buildCapsuleV2 over the clean
// base-commit index; gold is scoring-only, never fed into generation), re-run so
// the M99 import-relation co-edit evidence can be measured against the frozen
// M98 baseline (M94–M97 kept as historical references). Adds: (a) the
// import-only-suspected and anchor-less cohorts derived from the M99 import-edge
// gap audit (id sets fixed from frozen M98 rows), and (b) per-case
// import-relation instrumentation (considered / kept / pruned / hub-rejected
// counts and per-candidate import evidence).
//
// NO Claude, NO Docker, NO agent run, NO API calls, NO live network.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent, CapsuleV2Mode, type CapsuleV2Result } from "../../src/capsuleV2/types";

import {
  deriveTaskFromProblemStatement,
  loadSweBench,
  type SweBenchInstance,
} from "./build_stage5_retrieval_fixture";
import {
  expectedFilesAreUnparsedLanguage,
  fileMatches,
  summarizeCapsule,
  type CapsuleSummary,
} from "./run_stage5_retrieval_eval";
import {
  assertNoGoldLeakage,
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

interface CoeditStats {
  readonly lane_fired: boolean;
  readonly anchor_files: string[];
  readonly candidate_count: number;
  readonly candidates_added: number;
  readonly candidates_rescued: number;
  readonly gold_hit: boolean;
  readonly gold_candidate_count: number;
  readonly non_gold_candidate_count: number;
  readonly evidence_types: string[];
  readonly candidates: Array<{
    path: string; symbol: string; action: string; evidence_type: string;
    anchor_path: string; edge_count: number; score: number; confidence: string;
    import_kinds?: string[];
    is_gold: boolean;
  }>;
  readonly pruned: Array<{
    path: string; symbol: string; action: string; evidence_type: string;
    confidence: string; prune_reason: string; is_gold: boolean;
  }>;
  readonly pruned_count: number;
  readonly confidence_tiers: Record<string, number>;
  readonly spare_slot_deferred_count: number;
  readonly displaced_count: number;
  readonly ambiguous_rejected_count: number;
  readonly high_degree_rejected_count: number;
  readonly budget_limited_count: number;
  // M99 import-relation instrumentation.
  readonly import_relation_considered: number;
  readonly import_relation_kept: number;
  readonly import_relation_pruned: number;
  readonly import_relation_hub_rejected: number;
  readonly import_relation_ambiguous_rejected: number;
  readonly import_relation_gold_hit: boolean;
  readonly import_relation_evidence_types: string[];
}

interface SupportPrecisionStats {
  readonly support_item_count: number;
  readonly support_file_count: number;
  readonly duplicate_file_support_count: number;
  readonly generic_infra_support_count: number;
  readonly docs_examples_support_count: number;
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
  readonly capsule: {
    readonly mode: string;
    readonly lead_pivot_file: string | null;
    readonly required_files: string[];
    readonly optional_files: string[];
    readonly capsule_files: string[];
    readonly ranked_top10: string[];
  } | null;
  readonly coedit: CoeditStats | null;
  readonly support_precision: SupportPrecisionStats | null;
  readonly file_metrics: FileMetrics | null;
  readonly target_metrics: TargetMetrics | null;
  readonly budget_metrics: BudgetMetrics | null;
  readonly symbol_metrics: SymbolMetrics | null;
  readonly outcome: Outcome | null;
  readonly failure_reasons: FailureReason[];
}

function coeditStats(result: CapsuleV2Result, goldFiles: readonly string[]): CoeditStats {
  const d = result.diagnostics;
  const candidates = (d.coedit_candidates ?? []).map((c) => ({
    path: c.path, symbol: c.symbol, action: c.action, evidence_type: c.evidence_type,
    anchor_path: c.anchor_path, edge_count: c.edge_count, score: c.score,
    confidence: c.confidence,
    ...(c.import_kinds === undefined ? {} : { import_kinds: [...c.import_kinds] }),
    is_gold: goldFiles.some((g) => fileMatches(g, c.path)),
  }));
  const pruned = (d.coedit_pruned ?? []).map((c) => ({
    path: c.path, symbol: c.symbol, action: c.action, evidence_type: c.evidence_type,
    confidence: c.confidence, prune_reason: c.prune_reason,
    is_gold: goldFiles.some((g) => fileMatches(g, c.path)),
  }));
  const importCandidates = candidates.filter((c) => c.evidence_type.startsWith("import_"));
  return {
    lane_fired: d.coedit_lane_fired ?? false,
    anchor_files: [...new Set((d.coedit_anchors ?? []).map((a) => a.path))],
    candidate_count: candidates.length,
    candidates_added: candidates.filter((c) => c.action === "injected").length,
    candidates_rescued: candidates.filter((c) => c.action === "rescued").length,
    gold_hit: candidates.some((c) => c.is_gold),
    gold_candidate_count: candidates.filter((c) => c.is_gold).length,
    non_gold_candidate_count: candidates.filter((c) => !c.is_gold).length,
    evidence_types: [...new Set(candidates.map((c) => c.evidence_type))].sort(),
    candidates,
    pruned,
    pruned_count: pruned.length,
    confidence_tiers: d.coedit_confidence_tiers ?? {},
    spare_slot_deferred_count: d.coedit_spare_slot_deferred_count ?? 0,
    displaced_count: (d.coedit_displaced ?? []).length,
    ambiguous_rejected_count: d.coedit_ambiguous_rejected_count ?? 0,
    high_degree_rejected_count: d.coedit_high_degree_rejected_count ?? 0,
    budget_limited_count: d.coedit_budget_limited_count ?? 0,
    import_relation_considered: d.coedit_import_considered_count ?? 0,
    import_relation_kept: importCandidates.length,
    import_relation_pruned: pruned.filter((c) => c.evidence_type.startsWith("import_")).length,
    import_relation_hub_rejected: d.coedit_import_hub_rejected_count ?? 0,
    import_relation_ambiguous_rejected: d.coedit_import_ambiguous_rejected_count ?? 0,
    import_relation_gold_hit: importCandidates.some((c) => c.is_gold),
    import_relation_evidence_types: [...new Set(importCandidates.map((c) => c.evidence_type))].sort(),
  };
}

function supportPrecisionStats(result: CapsuleV2Result): SupportPrecisionStats {
  const pivotFiles = new Set(result.pivots.map((p) => p.path));
  const seen = new Set(pivotFiles);
  let duplicates = 0;
  let generic = 0;
  let docs = 0;
  const supportFiles = new Set<string>();
  for (const item of result.support) {
    if (seen.has(item.path)) duplicates += 1;
    seen.add(item.path);
    supportFiles.add(item.path);
    if (item.is_generic_infrastructure) generic += 1;
    if (item.is_non_source_example === true) docs += 1;
  }
  return {
    support_item_count: result.support.length,
    support_file_count: supportFiles.size,
    duplicate_file_support_count: duplicates,
    generic_infra_support_count: generic,
    docs_examples_support_count: docs,
  };
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
    capsule: null,
    coedit: null,
    support_precision: null,
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
  const task = deriveTaskFromProblemStatement(instance.problem_statement);
  if (task.length === 0) {
    return { ...base, generation_status: "gold_unavailable", status_detail: "empty problem statement",
      failure_reasons: ["unknown"] };
  }
  const leak = assertNoGoldLeakage(task, gold);
  if (leak !== null) {
    return { ...base, generation_status: "leakage_blocked",
      status_detail: `gold path in task: ${leak}`, failure_reasons: ["unknown"] };
  }

  let result: CapsuleV2Result;
  const db = openIndexerDatabase(path.join(workspace, INDEX_RELPATH));
  try {
    result = buildCapsuleV2({ db, repoRoot: workspace, task, intent: CapsuleIntent.Debug, maxTokens: CAPSULE_BUDGET });
  } catch (error) {
    db.close();
    return { ...base, generation_status: "error",
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
    capsule: {
      mode: result.actual_mode,
      lead_pivot_file: cf.leadPivotFile,
      required_files: cf.requiredFiles,
      optional_files: cf.optionalFiles,
      capsule_files: cf.capsuleFiles,
      ranked_top10: [...cf.requiredFiles, ...cf.optionalFiles].slice(0, 10),
    },
    coedit: coeditStats(result, gold.scoredFiles),
    support_precision: supportPrecisionStats(result),
    file_metrics: fileMetrics,
    target_metrics: targetMetrics,
    budget_metrics: budgetMetrics,
    symbol_metrics: symbolMetrics,
    outcome: classification.outcome,
    failure_reasons: classification.reasons,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface MetricRow {
  readonly instance_id: string;
  readonly generation_status: string;
  readonly gold?: { multi_file: boolean; source_only: boolean };
  readonly repo?: string;
  readonly file_metrics: FileMetrics | null;
  readonly target_metrics: TargetMetrics | null;
  readonly budget_metrics: BudgetMetrics | null;
  readonly outcome: string | null;
}

function scoredRows<T extends MetricRow>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.generation_status === "scored" && r.file_metrics && r.target_metrics);
}

interface CohortAggregate {
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
  readonly lead_pivot_is_gold: number;
  readonly lead_pivot_is_source_gold: number;
  readonly hidden_coedit_recall: number | null;
  readonly median_capsule_est_tokens: number;
  readonly p90_capsule_est_tokens: number;
  readonly median_overpacking_ratio: number | null;
  readonly mean_capsule_file_count: number;
  readonly median_capsule_file_count: number;
  readonly mean_required_target_count: number;
  readonly mean_optional_target_count: number;
  readonly outcomes: Record<string, number>;
}

function aggregate(cohort: string, rows: readonly MetricRow[]): CohortAggregate {
  const fm = rows.map((r) => r.file_metrics!);
  const tm = rows.map((r) => r.target_metrics!);
  const bm = rows.map((r) => r.budget_metrics!);
  const hidden = fm.map((m) => m.hidden_coedit_recall).filter((v): v is number => v !== null);
  const overpack = tm.map((m) => m.overpacking_ratio).filter((v): v is number => v !== null);
  const outcomes: Record<string, number> = {};
  for (const r of rows) outcomes[r.outcome ?? "unknown"] = (outcomes[r.outcome ?? "unknown"] ?? 0) + 1;
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
    lead_pivot_is_gold: rate(fm.map((m) => m.lead_pivot_is_gold)),
    lead_pivot_is_source_gold: rate(fm.map((m) => m.lead_pivot_is_source_gold)),
    hidden_coedit_recall: hidden.length > 0 ? mean(hidden) : null,
    median_capsule_est_tokens: median(bm.map((m) => m.capsule_est_tokens)),
    p90_capsule_est_tokens: percentile(bm.map((m) => m.capsule_est_tokens), 90),
    median_overpacking_ratio: overpack.length > 0 ? median(overpack) : null,
    mean_capsule_file_count: mean(tm.map((m) => m.capsule_file_count)),
    median_capsule_file_count: median(tm.map((m) => m.capsule_file_count)),
    mean_required_target_count: mean(tm.map((m) => m.required_target_count)),
    mean_optional_target_count: mean(tm.map((m) => m.optional_target_count)),
    outcomes,
  };
}

function reasonDistribution(rows: readonly DetailRow[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const r of rows) for (const reason of r.failure_reasons) dist[reason] = (dist[reason] ?? 0) + 1;
  return dist;
}

interface CoeditAggregate {
  readonly n: number;
  readonly lane_fired: number;
  readonly lane_fire_rate: number;
  readonly cases_gold_hit: number;
  readonly gold_hit_rate_when_fired: number | null;
  readonly total_candidates: number;
  readonly total_injected: number;
  readonly total_rescued: number;
  readonly total_gold_candidates: number;
  readonly total_non_gold_candidates: number;
  readonly non_gold_candidate_rate: number | null;
  readonly total_pruned: number;
  readonly total_pruned_gold: number;
  readonly prune_reason_distribution: Record<string, number>;
  readonly confidence_tier_distribution: Record<string, number>;
  readonly total_spare_slot_deferred: number;
  readonly total_displaced: number;
  readonly total_ambiguous_rejected: number;
  readonly total_high_degree_rejected: number;
  readonly total_budget_limited: number;
  readonly evidence_type_distribution: Record<string, number>;
  // M99 import-relation lane.
  readonly import_considered: number;
  readonly import_kept: number;
  readonly import_kept_gold: number;
  readonly import_pruned: number;
  readonly import_hub_rejected: number;
  readonly import_ambiguous_rejected: number;
  readonly import_cases_gold_hit: number;
  readonly import_evidence_type_distribution: Record<string, number>;
}

function aggregateCoedit(rows: readonly DetailRow[]): CoeditAggregate {
  const stats = rows.map((r) => r.coedit).filter((c): c is CoeditStats => c !== null);
  const fired = stats.filter((c) => c.lane_fired);
  const types: Record<string, number> = {};
  for (const c of stats) for (const t of c.evidence_types) types[t] = (types[t] ?? 0) + 1;
  const importTypes: Record<string, number> = {};
  for (const c of stats) for (const t of c.import_relation_evidence_types) importTypes[t] = (importTypes[t] ?? 0) + 1;
  const pruneReasons: Record<string, number> = {};
  const tiers: Record<string, number> = {};
  for (const c of stats) {
    for (const p of c.pruned) pruneReasons[p.prune_reason] = (pruneReasons[p.prune_reason] ?? 0) + 1;
    for (const [tier, n] of Object.entries(c.confidence_tiers)) tiers[tier] = (tiers[tier] ?? 0) + n;
  }
  const totalCandidates = stats.reduce((acc, c) => acc + c.candidate_count, 0);
  const totalGold = stats.reduce((acc, c) => acc + c.gold_candidate_count, 0);
  const importCandidates = stats.flatMap((c) => c.candidates.filter((x) => x.evidence_type.startsWith("import_")));
  return {
    n: stats.length,
    lane_fired: fired.length,
    lane_fire_rate: stats.length > 0 ? fired.length / stats.length : 0,
    cases_gold_hit: fired.filter((c) => c.gold_hit).length,
    gold_hit_rate_when_fired: fired.length > 0 ? fired.filter((c) => c.gold_hit).length / fired.length : null,
    total_candidates: totalCandidates,
    total_injected: stats.reduce((acc, c) => acc + c.candidates_added, 0),
    total_rescued: stats.reduce((acc, c) => acc + c.candidates_rescued, 0),
    total_gold_candidates: totalGold,
    total_non_gold_candidates: totalCandidates - totalGold,
    non_gold_candidate_rate: totalCandidates > 0 ? (totalCandidates - totalGold) / totalCandidates : null,
    total_pruned: stats.reduce((acc, c) => acc + c.pruned_count, 0),
    total_pruned_gold: stats.reduce((acc, c) => acc + c.pruned.filter((p) => p.is_gold).length, 0),
    prune_reason_distribution: pruneReasons,
    confidence_tier_distribution: tiers,
    total_spare_slot_deferred: stats.reduce((acc, c) => acc + c.spare_slot_deferred_count, 0),
    total_displaced: stats.reduce((acc, c) => acc + c.displaced_count, 0),
    total_ambiguous_rejected: stats.reduce((acc, c) => acc + c.ambiguous_rejected_count, 0),
    total_high_degree_rejected: stats.reduce((acc, c) => acc + c.high_degree_rejected_count, 0),
    total_budget_limited: stats.reduce((acc, c) => acc + c.budget_limited_count, 0),
    evidence_type_distribution: types,
    import_considered: stats.reduce((acc, c) => acc + c.import_relation_considered, 0),
    import_kept: importCandidates.length,
    import_kept_gold: importCandidates.filter((c) => c.is_gold).length,
    import_pruned: stats.reduce((acc, c) => acc + c.import_relation_pruned, 0),
    import_hub_rejected: stats.reduce((acc, c) => acc + c.import_relation_hub_rejected, 0),
    import_ambiguous_rejected: stats.reduce((acc, c) => acc + c.import_relation_ambiguous_rejected, 0),
    import_cases_gold_hit: stats.filter((c) => c.import_relation_gold_hit).length,
    import_evidence_type_distribution: importTypes,
  };
}

interface SupportPrecisionAggregate {
  readonly n: number;
  readonly mean_support_items: number;
  readonly mean_support_files: number;
  readonly total_duplicate_file_support: number;
  readonly total_generic_infra_support: number;
  readonly total_docs_examples_support: number;
}

function aggregateSupportPrecision(rows: readonly DetailRow[]): SupportPrecisionAggregate {
  const stats = rows.map((r) => r.support_precision).filter((s): s is SupportPrecisionStats => s !== null);
  return {
    n: stats.length,
    mean_support_items: mean(stats.map((s) => s.support_item_count)),
    mean_support_files: mean(stats.map((s) => s.support_file_count)),
    total_duplicate_file_support: stats.reduce((acc, s) => acc + s.duplicate_file_support_count, 0),
    total_generic_infra_support: stats.reduce((acc, s) => acc + s.generic_infra_support_count, 0),
    total_docs_examples_support: stats.reduce((acc, s) => acc + s.docs_examples_support_count, 0),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function n3(x: number | null): string { return x === null ? "—" : x.toFixed(3); }
function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }
function csvEscape(v: string): string { return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }

interface SplitFile { readonly dev: string[]; readonly holdout: string[]; }

interface M98DetailRow extends MetricRow {
  readonly gold: { multi_file: boolean; source_only: boolean };
  readonly repo: string;
  readonly coedit: { lane_fired: boolean } | null;
  readonly file_metrics: FileMetrics | null;
}

interface AuditCase {
  readonly instance_id: string;
  readonly hidden_gold_count: number;
  readonly hidden: Array<{ reachability: string }>;
}

async function main(): Promise<void> {
  const dataPath = process.argv.includes("--swe-bench-data")
    ? process.argv[process.argv.indexOf("--swe-bench-data") + 1]!
    : DEFAULT_DATA;

  const swe = await loadSweBench(dataPath);
  const instances = [...swe.values()].sort((a, b) => a.instance_id.localeCompare(b.instance_id));

  const split = JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m95_dev_holdout_split.json"), "utf8")) as SplitFile;
  const devSet = new Set(split.dev);
  const holdSet = new Set(split.holdout);

  const rows: DetailRow[] = [];
  for (const inst of instances) {
    rows.push(scoreInstance(inst));
    const last = rows.at(-1)!;
    process.stdout.write(`${last.generation_status === "scored" ? "✓" : "·"} ${inst.instance_id}: ${last.outcome ?? last.generation_status}${last.coedit?.lane_fired ? " [coedit]" : ""}${(last.coedit?.import_relation_kept ?? 0) > 0 ? ` [import ${last.coedit!.import_relation_kept}]` : ""}\n`);
  }

  const scored = scoredRows(rows);
  const coverage = {
    attempted: rows.length,
    scored: scored.length,
    missingWorkspace: rows.filter((r) => r.generation_status === "missing_workspace").length,
    goldUnavailable: rows.filter((r) => r.generation_status === "gold_unavailable").length,
    other: rows.filter((r) => r.generation_status === "error" || r.generation_status === "leakage_blocked").length,
  };

  // ---- M98 baseline detail rows, re-aggregated on identical id subsets ----
  const m98Detail = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m98_deterministic_scoreboard.detail.json"), "utf8"),
  ) as { rows: M98DetailRow[] };
  const m98Scored = scoredRows(m98Detail.rows);
  const m98ById = new Map(m98Scored.map((r) => [r.instance_id, r] as const));

  // Comparison cohorts (id sets defined from the frozen M98 baseline / M99
  // pre-change audit, so both sides aggregate the SAME instances).
  const multiIds = new Set(m98Scored.filter((r) => r.gold.multi_file).map((r) => r.instance_id));
  const singleIds = new Set(m98Scored.filter((r) => !r.gold.multi_file).map((r) => r.instance_id));
  const hiddenIds = new Set(
    m98Scored.filter((r) => r.gold.multi_file && r.file_metrics!.hidden_coedit_recall !== null)
      .map((r) => r.instance_id),
  );
  const firedIds = new Set(
    m98Scored.filter((r) => r.coedit?.lane_fired === true).map((r) => r.instance_id),
  );
  const overpackedIds = new Set(
    m98Scored.filter((r) => r.outcome === "overpacked").map((r) => r.instance_id),
  );
  // Import-only-suspected / anchor-less cohorts from the frozen M99 audit: cases
  // whose M98 hidden gold has (resp. lacks) an exact import relation to a
  // capsule file at the base commit.
  const audit = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m99_import_edge_gap_audit.json"), "utf8"),
  ) as { cases: AuditCase[] };
  const importSuspectIds = new Set(
    audit.cases
      .filter((c) => c.hidden_gold_count > 0
        && c.hidden.some((h) => h.reachability !== "no_import_relation"))
      .map((c) => c.instance_id),
  );
  const anchorlessIds = new Set(
    audit.cases
      .filter((c) => c.hidden_gold_count > 0
        && c.hidden.every((h) => h.reachability === "no_import_relation"))
      .map((c) => c.instance_id),
  );

  const sub = (ids: ReadonlySet<string>, rowsIn: readonly MetricRow[]): MetricRow[] =>
    rowsIn.filter((r) => ids.has(r.instance_id));
  const cohortPair = (name: string, ids: ReadonlySet<string>): { m99: CohortAggregate; m98: CohortAggregate } => ({
    m99: aggregate(name, sub(ids, scored)),
    m98: aggregate(`m98_${name}`, sub(ids, m98Scored)),
  });

  const headline = aggregate("all", scored);
  const dev = aggregate("dev", scored.filter((r) => devSet.has(r.instance_id)));
  const holdout = aggregate("holdout", scored.filter((r) => holdSet.has(r.instance_id)));
  const m98Headline = aggregate("m98_all", m98Scored);
  const m98Dev = aggregate("m98_dev", m98Scored.filter((r) => devSet.has(r.instance_id)));
  const m98Holdout = aggregate("m98_holdout", m98Scored.filter((r) => holdSet.has(r.instance_id)));

  const multi = cohortPair("multi_file", multiIds);
  const single = cohortPair("single_file", singleIds);
  const hiddenSub = cohortPair("hidden_coedit_subset", hiddenIds);
  const firedSub = cohortPair("coedit_fired_m98", firedIds);
  const importSub = cohortPair("import_only_suspected", importSuspectIds);
  const anchorlessSub = cohortPair("anchorless", anchorlessIds);
  const overpackedSub = cohortPair("m98_overpacked", overpackedIds);
  const multiDev = cohortPair("multi_file_dev", new Set([...multiIds].filter((id) => devSet.has(id))));
  const multiHoldout = cohortPair("multi_file_holdout", new Set([...multiIds].filter((id) => holdSet.has(id))));

  const repos = [...new Set(scored.map((r) => r.repo))].sort();
  const byRepo = repos.map((repo) => aggregate(repo, scored.filter((r) => r.repo === repo)));
  const m98ByRepo = new Map(repos.map((repo) => [
    repo, aggregate(repo, m98Scored.filter((r) => r.repo === repo)),
  ] as const));
  const byShape = [
    aggregate("single_file", scored.filter((r) => !r.gold.multi_file)),
    aggregate("multi_file", scored.filter((r) => r.gold.multi_file)),
    aggregate("source_only", scored.filter((r) => r.gold.source_only)),
    aggregate("test_including", scored.filter((r) => !r.gold.source_only)),
  ].filter((c) => c.n > 0);

  const coeditAll = aggregateCoedit(scored);
  const coeditDev = aggregateCoedit(scored.filter((r) => devSet.has(r.instance_id)));
  const coeditHoldout = aggregateCoedit(scored.filter((r) => holdSet.has(r.instance_id)));
  const supportAll = aggregateSupportPrecision(scored);

  const outcomeDist = headline.outcomes;
  const reasonDist = reasonDistribution(rows);

  const m94 = JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m94_deterministic_scoreboard.json"), "utf8"));
  const m95 = JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m95_deterministic_scoreboard.json"), "utf8"));
  const m96 = JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m96_deterministic_scoreboard.json"), "utf8"));
  const m97 = JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m97_deterministic_scoreboard.json"), "utf8"));

  const flips = scored
    .map((r) => {
      const before = m98ById.get(r.instance_id);
      if (before === undefined || before.outcome === r.outcome) return null;
      return {
        instance_id: r.instance_id,
        from: before.outcome,
        to: r.outcome,
        cohort: devSet.has(r.instance_id) ? "dev" : "holdout",
      };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  // All-gold flips vs M98 (both directions) — the recall-side evidence.
  const allGoldFlips = scored
    .map((r) => {
      const before = m98ById.get(r.instance_id);
      if (before === undefined) return null;
      const beforeAll = before.file_metrics!.all_gold_in_capsule;
      const afterAll = r.file_metrics!.all_gold_in_capsule;
      if (beforeAll === afterAll) return null;
      return {
        instance_id: r.instance_id,
        direction: afterAll ? "gained" : "lost",
        cohort: devSet.has(r.instance_id) ? "dev" : "holdout",
      };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  await mkdir(RESULTS_ROOT, { recursive: true });
  const w = (name: string, data: unknown) =>
    writeFile(path.join(RESULTS_ROOT, name), JSON.stringify(data, null, 2) + "\n", "utf8");

  await w("stage5_m99_deterministic_scoreboard.json", {
    milestone: "M99",
    kind: "Deterministic pre-agent VTRACE retrieval/capsule scoreboard (post import-relation co-edit evidence)",
    live_agents: false, docker: false, api_spend: false,
    generation: { intent: "debug", budget: CAPSULE_BUDGET, builder: "buildCapsuleV2 (in-process)" },
    coverage, headline, dev, holdout,
    cohorts: {
      multi_file: multi, single_file: single,
      multi_file_dev: multiDev, multi_file_holdout: multiHoldout,
      hidden_coedit_subset: hiddenSub,
      coedit_fired_m98: firedSub,
      import_only_suspected: importSub,
      anchorless: anchorlessSub,
      m98_overpacked: overpackedSub,
    },
    by_repo: byRepo, by_patch_shape: byShape,
    coedit_lane: { all: coeditAll, dev: coeditDev, holdout: coeditHoldout },
    support_precision: { all: supportAll },
    outcome_distribution: outcomeDist, failure_reason_distribution: reasonDist,
    outcome_flips_vs_m98: flips,
    all_gold_flips_vs_m98: allGoldFlips,
    m98_headline: m98Headline, m98_dev: m98Dev, m98_holdout: m98Holdout,
    m97_headline: m97.headline, m96_headline: m96.headline, m95_headline: m95.headline, m94_headline: m94.headline,
  });
  await w("stage5_m99_deterministic_scoreboard.detail.json", { milestone: "M99", count: rows.length, rows });
  await w("stage5_m99_deterministic_failure_modes.json", {
    milestone: "M99",
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
    "repo,n,recall_at_1,recall_at_5,recall_at_10,mrr,any_gold_in_capsule,lead_pivot_is_source_gold,hidden_coedit_recall,median_est_tokens,mean_capsule_files,m98_recall_at_5,m98_any_gold,m98_mean_capsule_files",
    ...byRepo.sort((a, b) => b.n - a.n).map((c) => {
      const base = m98ByRepo.get(c.cohort)!;
      return [c.cohort, c.n, c.recall_at_1.toFixed(4), c.recall_at_5.toFixed(4), c.recall_at_10.toFixed(4), c.mrr.toFixed(4),
        c.any_gold_in_capsule.toFixed(4), c.lead_pivot_is_source_gold.toFixed(4),
        c.hidden_coedit_recall === null ? "" : c.hidden_coedit_recall.toFixed(4), c.median_capsule_est_tokens,
        c.mean_capsule_file_count.toFixed(3),
        base.recall_at_5.toFixed(4), base.any_gold_in_capsule.toFixed(4), base.mean_capsule_file_count.toFixed(3)]
        .map((x) => csvEscape(String(x))).join(",");
    }),
  ].join("\n");
  await writeFile(path.join(RESULTS_ROOT, "stage5_m99_deterministic_by_repo.csv"), repoCsv + "\n", "utf8");

  const missCsv = [
    "instance_id,repo,gold_files,top_candidates,capsule_files,failure_reason,cohort",
    ...scored.filter((r) => r.outcome === "miss" || r.outcome === "wrong_pivot").map((r) =>
      [r.instance_id, r.repo, r.gold.scored_files.join(" "), (r.capsule?.ranked_top10 ?? []).slice(0, 3).join(" "),
       (r.capsule?.capsule_files ?? []).slice(0, 3).join(" "), r.failure_reasons.join(" "),
       devSet.has(r.instance_id) ? "dev" : "holdout"].map((x) => csvEscape(String(x))).join(",")),
  ].join("\n");
  await writeFile(path.join(RESULTS_ROOT, "stage5_m99_deterministic_top_misses.csv"), missCsv + "\n", "utf8");

  const md = renderMd({
    headline, dev, holdout, m98Headline, m98Dev, m98Holdout,
    multi, single, multiDev, multiHoldout, hiddenSub, firedSub, importSub, anchorlessSub, overpackedSub,
    byRepo, byShape, outcomeDist, reasonDist, coverage,
    coeditAll, coeditDev, coeditHoldout, supportAll, flips, allGoldFlips, m94, m95, m96, m97,
  });
  await writeFile(path.join(RESULTS_ROOT, "stage5_m99_deterministic_scoreboard.md"), md, "utf8");

  process.stdout.write(
    `\nM99 scoreboard: ${coverage.scored}/${coverage.attempted} scored\n` +
      `ALL     r@1=${headline.recall_at_1.toFixed(3)} r@5=${headline.recall_at_5.toFixed(3)} any=${pct(headline.any_gold_in_capsule)} all=${pct(headline.all_gold_in_capsule)} hidden=${n3(headline.hidden_coedit_recall)} medTok=${headline.median_capsule_est_tokens} p90=${headline.p90_capsule_est_tokens} files=${headline.mean_capsule_file_count.toFixed(3)}\n` +
      `DEV     r@1=${dev.recall_at_1.toFixed(3)} r@5=${dev.recall_at_5.toFixed(3)} any=${pct(dev.any_gold_in_capsule)} all=${pct(dev.all_gold_in_capsule)} hidden=${n3(dev.hidden_coedit_recall)}\n` +
      `HOLDOUT r@1=${holdout.recall_at_1.toFixed(3)} r@5=${holdout.recall_at_5.toFixed(3)} any=${pct(holdout.any_gold_in_capsule)} all=${pct(holdout.all_gold_in_capsule)} hidden=${n3(holdout.hidden_coedit_recall)} medTok=${holdout.median_capsule_est_tokens} p90=${holdout.p90_capsule_est_tokens}\n` +
      `MULTI   all-gold ${pct(multi.m98.all_gold_in_capsule)} -> ${pct(multi.m99.all_gold_in_capsule)} | hidden ${n3(multi.m98.hidden_coedit_recall)} -> ${n3(multi.m99.hidden_coedit_recall)}\n` +
      `import lane: considered ${coeditAll.import_considered}, kept ${coeditAll.import_kept} (${coeditAll.import_kept_gold} gold), hub-rejected ${coeditAll.import_hub_rejected}, ambiguous ${coeditAll.import_ambiguous_rejected}\n` +
      `all-gold flips vs M98: ${allGoldFlips.length === 0 ? "none" : allGoldFlips.map((f) => `${f.instance_id} ${f.direction} [${f.cohort}]`).join(", ")}\n` +
      `outcomes: ${Object.entries(outcomeDist).map(([k, v]) => `${k}=${v}`).join(" ")}\n`,
  );
}

function cohortRow(c: CohortAggregate): string {
  return `| ${c.cohort} | ${c.n} | ${n3(c.recall_at_1)} | ${n3(c.recall_at_3)} | ${n3(c.recall_at_5)} | ${n3(c.recall_at_10)} | ${n3(c.mrr)} | ${pct(c.any_gold_in_capsule)} | ${pct(c.all_gold_in_capsule)} | ${pct(c.source_gold_in_capsule)} | ${pct(c.lead_pivot_is_source_gold)} | ${c.hidden_coedit_recall === null ? "—" : n3(c.hidden_coedit_recall)} | ${c.median_capsule_est_tokens} | ${c.p90_capsule_est_tokens} | ${n3(c.median_overpacking_ratio)} | ${c.mean_capsule_file_count.toFixed(2)} |`;
}

function deltaRow(metric: string, base: number, next: number, asPct: boolean): string {
  const f = (x: number): string => (asPct ? pct(x) : n3(x));
  const d = asPct ? `${((next - base) * 100).toFixed(1)}pts` : (next - base).toFixed(3);
  return `| ${metric} | ${f(base)} | ${f(next)} | ${d} |`;
}

function hiddenDeltaRow(base: number | null, next: number | null): string {
  const f = (x: number | null): string => (x === null ? "—" : n3(x));
  const d = base === null || next === null ? "—" : (next - base).toFixed(3);
  return `| hidden_coedit_recall | ${f(base)} | ${f(next)} | ${d} |`;
}

function cohortDelta(title: string, base: CohortAggregate, next: CohortAggregate): string {
  return `### ${title} (n=${next.n})

| metric | M98 | M99 | Δ |
| --- | --- | --- | --- |
${deltaRow("recall@1", base.recall_at_1, next.recall_at_1, false)}
${deltaRow("recall@3", base.recall_at_3, next.recall_at_3, false)}
${deltaRow("recall@5", base.recall_at_5, next.recall_at_5, false)}
${deltaRow("recall@10", base.recall_at_10, next.recall_at_10, false)}
${deltaRow("MRR", base.mrr, next.mrr, false)}
${deltaRow("any_gold_in_capsule", base.any_gold_in_capsule, next.any_gold_in_capsule, true)}
${deltaRow("all_gold_in_capsule", base.all_gold_in_capsule, next.all_gold_in_capsule, true)}
${deltaRow("lead_pivot_is_source_gold", base.lead_pivot_is_source_gold, next.lead_pivot_is_source_gold, true)}
${hiddenDeltaRow(base.hidden_coedit_recall, next.hidden_coedit_recall)}
| median tokens | ${base.median_capsule_est_tokens} | ${next.median_capsule_est_tokens} | ${next.median_capsule_est_tokens - base.median_capsule_est_tokens} |
| p90 tokens | ${base.p90_capsule_est_tokens} | ${next.p90_capsule_est_tokens} | ${next.p90_capsule_est_tokens - base.p90_capsule_est_tokens} |
| mean capsule files | ${n3(base.mean_capsule_file_count)} | ${n3(next.mean_capsule_file_count)} | ${(next.mean_capsule_file_count - base.mean_capsule_file_count).toFixed(3)} |
| median capsule files | ${n3(base.median_capsule_file_count)} | ${n3(next.median_capsule_file_count)} | ${(next.median_capsule_file_count - base.median_capsule_file_count).toFixed(3)} |
| mean required targets | ${n3(base.mean_required_target_count)} | ${n3(next.mean_required_target_count)} | ${(next.mean_required_target_count - base.mean_required_target_count).toFixed(3)} |
| mean optional targets | ${n3(base.mean_optional_target_count)} | ${n3(next.mean_optional_target_count)} | ${(next.mean_optional_target_count - base.mean_optional_target_count).toFixed(3)} |
| excellent | ${base.outcomes["excellent"] ?? 0} | ${next.outcomes["excellent"] ?? 0} | ${(next.outcomes["excellent"] ?? 0) - (base.outcomes["excellent"] ?? 0)} |
| overpacked | ${base.outcomes["overpacked"] ?? 0} | ${next.outcomes["overpacked"] ?? 0} | ${(next.outcomes["overpacked"] ?? 0) - (base.outcomes["overpacked"] ?? 0)} |
`;
}

function coeditBlock(label: string, c: CoeditAggregate): string {
  return `- **${label}**: fired on ${c.lane_fired}/${c.n} (${pct(c.lane_fire_rate)}); gold hit on ${c.cases_gold_hit}` +
    ` (${c.gold_hit_rate_when_fired === null ? "—" : pct(c.gold_hit_rate_when_fired)} of fired); ` +
    `kept ${c.total_candidates} (rescued ${c.total_rescued}, injected ${c.total_injected}; ` +
    `gold ${c.total_gold_candidates}, non-gold ${c.total_non_gold_candidates}); ` +
    `pruned ${c.total_pruned} (gold ${c.total_pruned_gold}); spare-deferred ${c.total_spare_slot_deferred}; displaced ${c.total_displaced}; ` +
    `tiers: ${Object.entries(c.confidence_tier_distribution).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}; ` +
    `import lane: considered ${c.import_considered}, kept ${c.import_kept} (gold ${c.import_kept_gold}), pruned ${c.import_pruned}, hub ${c.import_hub_rejected}, ambiguous ${c.import_ambiguous_rejected}; ` +
    `import types: ${Object.entries(c.import_evidence_type_distribution).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}`;
}

interface RenderInput {
  headline: CohortAggregate; dev: CohortAggregate; holdout: CohortAggregate;
  m98Headline: CohortAggregate; m98Dev: CohortAggregate; m98Holdout: CohortAggregate;
  multi: { m99: CohortAggregate; m98: CohortAggregate };
  single: { m99: CohortAggregate; m98: CohortAggregate };
  multiDev: { m99: CohortAggregate; m98: CohortAggregate };
  multiHoldout: { m99: CohortAggregate; m98: CohortAggregate };
  hiddenSub: { m99: CohortAggregate; m98: CohortAggregate };
  firedSub: { m99: CohortAggregate; m98: CohortAggregate };
  importSub: { m99: CohortAggregate; m98: CohortAggregate };
  anchorlessSub: { m99: CohortAggregate; m98: CohortAggregate };
  overpackedSub: { m99: CohortAggregate; m98: CohortAggregate };
  byRepo: CohortAggregate[]; byShape: CohortAggregate[];
  outcomeDist: Record<string, number>; reasonDist: Record<string, number>;
  coverage: { attempted: number; scored: number };
  coeditAll: CoeditAggregate; coeditDev: CoeditAggregate; coeditHoldout: CoeditAggregate;
  supportAll: SupportPrecisionAggregate;
  flips: Array<{ instance_id: string; from: string | null; to: string | null; cohort: string }>;
  allGoldFlips: Array<{ instance_id: string; direction: string; cohort: string }>;
  m94: any; m95: any; m96: any; m97: any;
}

function renderMd(input: RenderInput): string {
  const {
    headline, dev, holdout, m98Headline, m98Dev, m98Holdout,
    multi, single, multiDev, multiHoldout, hiddenSub, firedSub, importSub, anchorlessSub, overpackedSub,
    byRepo, byShape, outcomeDist, reasonDist, coverage,
    coeditAll, coeditDev, coeditHoldout, supportAll, flips, allGoldFlips, m94, m95, m96, m97,
  } = input;
  const HEAD = "| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack | mean files |";
  const SEP = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const outcomeLine = Object.entries(outcomeDist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
  const reasonLine = Object.entries(reasonDist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
  const flipLine = flips.length === 0
    ? "none"
    : flips.map((f) => `${f.instance_id} ${f.from}→${f.to} [${f.cohort}]`).join(", ");
  const allGoldLine = allGoldFlips.length === 0
    ? "none"
    : allGoldFlips.map((f) => `${f.instance_id} ${f.direction} [${f.cohort}]`).join(", ");
  return `# Stage 5 M99 Deterministic VTRACE Scoreboard (post import-relation co-edit evidence)

_Deterministic, offline: no live agents, no Docker, no API spend. Same generation
path as M94–M98; compared against the frozen M98 baseline (M94–M97 kept as
historical references)._

## Summary

- Scored: **${coverage.scored}/${coverage.attempted}**
- ALL: recall@5 **${n3(headline.recall_at_5)}** (M98 ${n3(m98Headline.recall_at_5)}, M97 ${n3(m97.headline.recall_at_5)}, M96 ${n3(m96.headline.recall_at_5)}, M95 ${n3(m95.headline.recall_at_5)}, M94 ${n3(m94.headline.mean_recall_at_5)}), any-gold **${pct(headline.any_gold_in_capsule)}** (M98 ${pct(m98Headline.any_gold_in_capsule)}), all-gold **${pct(headline.all_gold_in_capsule)}** (M98 ${pct(m98Headline.all_gold_in_capsule)}), hidden-coedit **${n3(headline.hidden_coedit_recall)}** (M98 ${n3(m98Headline.hidden_coedit_recall)}), mean files **${headline.mean_capsule_file_count.toFixed(3)}** (M98 ${m98Headline.mean_capsule_file_count.toFixed(3)})
- HOLDOUT: recall@1 **${n3(holdout.recall_at_1)}** (M98 ${n3(m98Holdout.recall_at_1)}), any-gold **${pct(holdout.any_gold_in_capsule)}** (M98 ${pct(m98Holdout.any_gold_in_capsule)}), hidden-coedit **${n3(holdout.hidden_coedit_recall)}** (M98 ${n3(m98Holdout.hidden_coedit_recall)}), med tok **${holdout.median_capsule_est_tokens}** (M98 ${m98Holdout.median_capsule_est_tokens}), p90 **${holdout.p90_capsule_est_tokens}** (M98 ${m98Holdout.p90_capsule_est_tokens})
- MULTI-FILE: all-gold **${pct(multi.m98.all_gold_in_capsule)} → ${pct(multi.m99.all_gold_in_capsule)}**, hidden-coedit **${n3(multi.m98.hidden_coedit_recall)} → ${n3(multi.m99.hidden_coedit_recall)}**
- All-gold flips vs M98: ${allGoldLine}
- Outcome flips vs M98: ${flipLine}
- Outcome distribution: ${outcomeLine}
- Failure-reason distribution: ${reasonLine}

## Cohort Metrics

${HEAD}
${SEP}
${cohortRow(headline)}
${cohortRow(dev)}
${cohortRow(holdout)}
${cohortRow(multi.m99)}
${cohortRow(single.m99)}
${cohortRow(hiddenSub.m99)}
${cohortRow(firedSub.m99)}
${cohortRow(importSub.m99)}
${cohortRow(anchorlessSub.m99)}
${cohortRow(overpackedSub.m99)}

## M98 → M99 Deltas

${cohortDelta("All scored", m98Headline, headline)}
${cohortDelta("Dev", m98Dev, dev)}
${cohortDelta("Holdout", m98Holdout, holdout)}
${cohortDelta("Multi-file only", multi.m98, multi.m99)}
${cohortDelta("Multi-file dev", multiDev.m98, multiDev.m99)}
${cohortDelta("Multi-file holdout", multiHoldout.m98, multiHoldout.m99)}
${cohortDelta("Single-file only", single.m98, single.m99)}
${cohortDelta("Hidden-coedit subset", hiddenSub.m98, hiddenSub.m99)}
${cohortDelta("Co-edit-fired cases (M98 definition)", firedSub.m98, firedSub.m99)}
${cohortDelta("Import-only suspected subset (M99 audit)", importSub.m98, importSub.m99)}
${cohortDelta("Anchor-less subset (M99 audit)", anchorlessSub.m98, anchorlessSub.m99)}
${cohortDelta("M98 overpacked cases", overpackedSub.m98, overpackedSub.m99)}

## Co-edit Lane (with import-relation evidence)

${coeditBlock("all", coeditAll)}
${coeditBlock("dev", coeditDev)}
${coeditBlock("holdout", coeditHoldout)}

## Support Composition (all scored)

- mean support items ${supportAll.mean_support_items.toFixed(3)}, mean support files ${supportAll.mean_support_files.toFixed(3)}
- duplicate-file support items ${supportAll.total_duplicate_file_support}, generic-infra ${supportAll.total_generic_infra_support}, docs/examples ${supportAll.total_docs_examples_support}

## By Repo

${HEAD}
${SEP}
${byRepo.sort((a, b) => b.n - a.n).map(cohortRow).join("\n")}

## By Patch Shape

${HEAD}
${SEP}
${byShape.map(cohortRow).join("\n")}
`;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
