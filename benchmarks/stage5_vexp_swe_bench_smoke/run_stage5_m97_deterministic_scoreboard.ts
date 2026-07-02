// Stage 5 M97 — deterministic VTRACE retrieval/capsule scoreboard: runner.
//
// Same generation/scoring path as M94/M95/M96 (buildCapsuleV2 over the clean
// base-commit index; gold is scoring-only, never fed into generation), re-run so
// the M97 hidden co-edit support lane can be measured against the frozen M96
// baseline (M94/M95 kept as historical references). Adds: (a) multi-file /
// single-file / hidden-coedit / partial-gold cohorts compared like-for-like
// against the SAME instances re-aggregated from the M96 detail rows, and (b)
// per-case co-edit lane instrumentation read from the capsule diagnostics
// (anchors, rescued/injected candidates, gold hits, displaced items,
// hub/ambiguous/budget rejects).
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
    anchor_path: string; edge_count: number; score: number; is_gold: boolean;
  }>;
  readonly displaced_count: number;
  readonly ambiguous_rejected_count: number;
  readonly high_degree_rejected_count: number;
  readonly budget_limited_count: number;
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
    is_gold: goldFiles.some((g) => fileMatches(g, c.path)),
  }));
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
    displaced_count: (d.coedit_displaced ?? []).length,
    ambiguous_rejected_count: d.coedit_ambiguous_rejected_count ?? 0,
    high_degree_rejected_count: d.coedit_high_degree_rejected_count ?? 0,
    budget_limited_count: d.coedit_budget_limited_count ?? 0,
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
  readonly total_displaced: number;
  readonly total_ambiguous_rejected: number;
  readonly total_high_degree_rejected: number;
  readonly total_budget_limited: number;
  readonly evidence_type_distribution: Record<string, number>;
}

function aggregateCoedit(rows: readonly DetailRow[]): CoeditAggregate {
  const stats = rows.map((r) => r.coedit).filter((c): c is CoeditStats => c !== null);
  const fired = stats.filter((c) => c.lane_fired);
  const types: Record<string, number> = {};
  for (const c of stats) for (const t of c.evidence_types) types[t] = (types[t] ?? 0) + 1;
  const totalCandidates = stats.reduce((acc, c) => acc + c.candidate_count, 0);
  const totalGold = stats.reduce((acc, c) => acc + c.gold_candidate_count, 0);
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
    total_displaced: stats.reduce((acc, c) => acc + c.displaced_count, 0),
    total_ambiguous_rejected: stats.reduce((acc, c) => acc + c.ambiguous_rejected_count, 0),
    total_high_degree_rejected: stats.reduce((acc, c) => acc + c.high_degree_rejected_count, 0),
    total_budget_limited: stats.reduce((acc, c) => acc + c.budget_limited_count, 0),
    evidence_type_distribution: types,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function n3(x: number | null): string { return x === null ? "—" : x.toFixed(3); }
function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }
function csvEscape(v: string): string { return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }

interface SplitFile { readonly dev: string[]; readonly holdout: string[]; }

interface M96DetailRow extends MetricRow {
  readonly gold: { multi_file: boolean; source_only: boolean };
  readonly repo: string;
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
    process.stdout.write(`${last.generation_status === "scored" ? "✓" : "·"} ${inst.instance_id}: ${last.outcome ?? last.generation_status}${last.coedit?.lane_fired ? " [coedit]" : ""}\n`);
  }

  const scored = scoredRows(rows);
  const coverage = {
    attempted: rows.length,
    scored: scored.length,
    missingWorkspace: rows.filter((r) => r.generation_status === "missing_workspace").length,
    goldUnavailable: rows.filter((r) => r.generation_status === "gold_unavailable").length,
    other: rows.filter((r) => r.generation_status === "error" || r.generation_status === "leakage_blocked").length,
  };

  // ---- M96 baseline detail rows, re-aggregated on identical id subsets ----
  const m96Detail = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m96_deterministic_scoreboard.detail.json"), "utf8"),
  ) as { rows: M96DetailRow[] };
  const m96Scored = scoredRows(m96Detail.rows);
  const m96ById = new Map(m96Scored.map((r) => [r.instance_id, r] as const));

  // Comparison cohorts (id sets defined from the M96 baseline where they refer to
  // baseline conditions, so both sides aggregate the SAME instances).
  const multiIds = new Set(m96Scored.filter((r) => r.gold.multi_file).map((r) => r.instance_id));
  const singleIds = new Set(m96Scored.filter((r) => !r.gold.multi_file).map((r) => r.instance_id));
  // Hidden-coedit subset: multi-file cases with ≥1 non-lead gold to recover.
  const hiddenIds = new Set(
    m96Scored.filter((r) => r.gold.multi_file && r.file_metrics!.hidden_coedit_recall !== null)
      .map((r) => r.instance_id),
  );
  // Partial-gold subset: M96 found at least one gold but missed another.
  const partialGoldIds = new Set(
    m96Scored.filter((r) => r.file_metrics!.any_gold_in_capsule && !r.file_metrics!.all_gold_in_capsule)
      .map((r) => r.instance_id),
  );

  const sub = (ids: ReadonlySet<string>, rowsIn: readonly MetricRow[]): MetricRow[] =>
    rowsIn.filter((r) => ids.has(r.instance_id));
  const cohortPair = (name: string, ids: ReadonlySet<string>): { m97: CohortAggregate; m96: CohortAggregate } => ({
    m97: aggregate(name, sub(ids, scored)),
    m96: aggregate(`m96_${name}`, sub(ids, m96Scored)),
  });

  const headline = aggregate("all", scored);
  const dev = aggregate("dev", scored.filter((r) => devSet.has(r.instance_id)));
  const holdout = aggregate("holdout", scored.filter((r) => holdSet.has(r.instance_id)));
  const m96Headline = aggregate("m96_all", m96Scored);
  const m96Dev = aggregate("m96_dev", m96Scored.filter((r) => devSet.has(r.instance_id)));
  const m96Holdout = aggregate("m96_holdout", m96Scored.filter((r) => holdSet.has(r.instance_id)));

  const multi = cohortPair("multi_file", multiIds);
  const single = cohortPair("single_file", singleIds);
  const hiddenSub = cohortPair("hidden_coedit_subset", hiddenIds);
  const partialSub = cohortPair("partial_gold_subset", partialGoldIds);
  const multiDev = cohortPair("multi_file_dev", new Set([...multiIds].filter((id) => devSet.has(id))));
  const multiHoldout = cohortPair("multi_file_holdout", new Set([...multiIds].filter((id) => holdSet.has(id))));

  const repos = [...new Set(scored.map((r) => r.repo))].sort();
  const byRepo = repos.map((repo) => aggregate(repo, scored.filter((r) => r.repo === repo)));
  const m96ByRepo = new Map(repos.map((repo) => [
    repo, aggregate(repo, m96Scored.filter((r) => r.repo === repo)),
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

  const outcomeDist = headline.outcomes;
  const reasonDist = reasonDistribution(rows);

  const m94 = JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m94_deterministic_scoreboard.json"), "utf8"));
  const m95 = JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m95_deterministic_scoreboard.json"), "utf8"));

  // Per-case flips vs M96, for the report (dev detail only; holdout stays aggregate).
  const flips = scored
    .filter((r) => devSet.has(r.instance_id))
    .map((r) => {
      const before = m96ById.get(r.instance_id);
      if (before === undefined || before.outcome === r.outcome) return null;
      return { instance_id: r.instance_id, from: before.outcome, to: r.outcome };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  await mkdir(RESULTS_ROOT, { recursive: true });
  const w = (name: string, data: unknown) =>
    writeFile(path.join(RESULTS_ROOT, name), JSON.stringify(data, null, 2) + "\n", "utf8");

  await w("stage5_m97_deterministic_scoreboard.json", {
    milestone: "M97",
    kind: "Deterministic pre-agent VTRACE retrieval/capsule scoreboard (post hidden co-edit lane)",
    live_agents: false, docker: false, api_spend: false,
    generation: { intent: "debug", budget: CAPSULE_BUDGET, builder: "buildCapsuleV2 (in-process)" },
    coverage, headline, dev, holdout,
    cohorts: {
      multi_file: multi, single_file: single,
      multi_file_dev: multiDev, multi_file_holdout: multiHoldout,
      hidden_coedit_subset: hiddenSub, partial_gold_subset: partialSub,
    },
    by_repo: byRepo, by_patch_shape: byShape,
    coedit_lane: { all: coeditAll, dev: coeditDev, holdout: coeditHoldout },
    outcome_distribution: outcomeDist, failure_reason_distribution: reasonDist,
    dev_outcome_flips_vs_m96: flips,
    m96_headline: m96Headline, m96_dev: m96Dev, m96_holdout: m96Holdout,
    m95_headline: m95.headline, m94_headline: m94.headline,
  });
  await w("stage5_m97_deterministic_scoreboard.detail.json", { milestone: "M97", count: rows.length, rows });
  await w("stage5_m97_deterministic_failure_modes.json", {
    milestone: "M97",
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
    "repo,n,recall_at_1,recall_at_5,recall_at_10,mrr,any_gold_in_capsule,lead_pivot_is_source_gold,hidden_coedit_recall,median_est_tokens,m96_recall_at_5,m96_any_gold",
    ...byRepo.sort((a, b) => b.n - a.n).map((c) => {
      const base = m96ByRepo.get(c.cohort)!;
      return [c.cohort, c.n, c.recall_at_1.toFixed(4), c.recall_at_5.toFixed(4), c.recall_at_10.toFixed(4), c.mrr.toFixed(4),
        c.any_gold_in_capsule.toFixed(4), c.lead_pivot_is_source_gold.toFixed(4),
        c.hidden_coedit_recall === null ? "" : c.hidden_coedit_recall.toFixed(4), c.median_capsule_est_tokens,
        base.recall_at_5.toFixed(4), base.any_gold_in_capsule.toFixed(4)]
        .map((x) => csvEscape(String(x))).join(",");
    }),
  ].join("\n");
  await writeFile(path.join(RESULTS_ROOT, "stage5_m97_deterministic_by_repo.csv"), repoCsv + "\n", "utf8");

  const missCsv = [
    "instance_id,repo,gold_files,top_candidates,capsule_files,failure_reason,cohort",
    ...scored.filter((r) => r.outcome === "miss" || r.outcome === "wrong_pivot").map((r) =>
      [r.instance_id, r.repo, r.gold.scored_files.join(" "), (r.capsule?.ranked_top10 ?? []).slice(0, 3).join(" "),
       (r.capsule?.capsule_files ?? []).slice(0, 3).join(" "), r.failure_reasons.join(" "),
       devSet.has(r.instance_id) ? "dev" : "holdout"].map((x) => csvEscape(String(x))).join(",")),
  ].join("\n");
  await writeFile(path.join(RESULTS_ROOT, "stage5_m97_deterministic_top_misses.csv"), missCsv + "\n", "utf8");

  const md = renderMd({
    headline, dev, holdout, m96Headline, m96Dev, m96Holdout,
    multi, single, multiDev, multiHoldout, hiddenSub, partialSub,
    byRepo, byShape, outcomeDist, reasonDist, coverage,
    coeditAll, coeditDev, coeditHoldout, flips, m94, m95,
  });
  await writeFile(path.join(RESULTS_ROOT, "stage5_m97_deterministic_scoreboard.md"), md, "utf8");

  process.stdout.write(
    `\nM97 scoreboard: ${coverage.scored}/${coverage.attempted} scored\n` +
      `ALL     r@1=${headline.recall_at_1.toFixed(3)} r@5=${headline.recall_at_5.toFixed(3)} any=${pct(headline.any_gold_in_capsule)} all=${pct(headline.all_gold_in_capsule)} hidden=${n3(headline.hidden_coedit_recall)} medTok=${headline.median_capsule_est_tokens} p90=${headline.p90_capsule_est_tokens}\n` +
      `DEV     r@1=${dev.recall_at_1.toFixed(3)} r@5=${dev.recall_at_5.toFixed(3)} any=${pct(dev.any_gold_in_capsule)} all=${pct(dev.all_gold_in_capsule)} hidden=${n3(dev.hidden_coedit_recall)}\n` +
      `HOLDOUT r@1=${holdout.recall_at_1.toFixed(3)} r@5=${holdout.recall_at_5.toFixed(3)} any=${pct(holdout.any_gold_in_capsule)} all=${pct(holdout.all_gold_in_capsule)} hidden=${n3(holdout.hidden_coedit_recall)} medTok=${holdout.median_capsule_est_tokens} p90=${holdout.p90_capsule_est_tokens}\n` +
      `MULTI   all-gold ${pct(multi.m96.all_gold_in_capsule)} -> ${pct(multi.m97.all_gold_in_capsule)} | hidden ${n3(multi.m96.hidden_coedit_recall)} -> ${n3(multi.m97.hidden_coedit_recall)}\n` +
      `coedit: fired ${coeditAll.lane_fired}/${coeditAll.n}, gold-hit ${coeditAll.cases_gold_hit}, candidates ${coeditAll.total_candidates} (${coeditAll.total_gold_candidates} gold)\n` +
      `outcomes: ${Object.entries(outcomeDist).map(([k, v]) => `${k}=${v}`).join(" ")}\n`,
  );
}

function cohortRow(c: CohortAggregate): string {
  return `| ${c.cohort} | ${c.n} | ${n3(c.recall_at_1)} | ${n3(c.recall_at_3)} | ${n3(c.recall_at_5)} | ${n3(c.recall_at_10)} | ${n3(c.mrr)} | ${pct(c.any_gold_in_capsule)} | ${pct(c.all_gold_in_capsule)} | ${pct(c.source_gold_in_capsule)} | ${pct(c.lead_pivot_is_source_gold)} | ${c.hidden_coedit_recall === null ? "—" : n3(c.hidden_coedit_recall)} | ${c.median_capsule_est_tokens} | ${c.p90_capsule_est_tokens} | ${n3(c.median_overpacking_ratio)} |`;
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

| metric | M96 | M97 | Δ |
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
| overpacked | ${base.outcomes["overpacked"] ?? 0} | ${next.outcomes["overpacked"] ?? 0} | ${(next.outcomes["overpacked"] ?? 0) - (base.outcomes["overpacked"] ?? 0)} |
`;
}

function coeditBlock(label: string, c: CoeditAggregate): string {
  return `- **${label}**: fired on ${c.lane_fired}/${c.n} (${pct(c.lane_fire_rate)}); gold hit on ${c.cases_gold_hit}` +
    ` (${c.gold_hit_rate_when_fired === null ? "—" : pct(c.gold_hit_rate_when_fired)} of fired); ` +
    `candidates ${c.total_candidates} (rescued ${c.total_rescued}, injected ${c.total_injected}; ` +
    `gold ${c.total_gold_candidates}, non-gold ${c.total_non_gold_candidates}); displaced ${c.total_displaced}; ` +
    `rejected ambiguous ${c.total_ambiguous_rejected}, hub ${c.total_high_degree_rejected}, budget ${c.total_budget_limited}; ` +
    `types: ${Object.entries(c.evidence_type_distribution).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}`;
}

interface RenderInput {
  headline: CohortAggregate; dev: CohortAggregate; holdout: CohortAggregate;
  m96Headline: CohortAggregate; m96Dev: CohortAggregate; m96Holdout: CohortAggregate;
  multi: { m97: CohortAggregate; m96: CohortAggregate };
  single: { m97: CohortAggregate; m96: CohortAggregate };
  multiDev: { m97: CohortAggregate; m96: CohortAggregate };
  multiHoldout: { m97: CohortAggregate; m96: CohortAggregate };
  hiddenSub: { m97: CohortAggregate; m96: CohortAggregate };
  partialSub: { m97: CohortAggregate; m96: CohortAggregate };
  byRepo: CohortAggregate[]; byShape: CohortAggregate[];
  outcomeDist: Record<string, number>; reasonDist: Record<string, number>;
  coverage: { attempted: number; scored: number };
  coeditAll: CoeditAggregate; coeditDev: CoeditAggregate; coeditHoldout: CoeditAggregate;
  flips: Array<{ instance_id: string; from: string | null; to: string | null }>;
  m94: any; m95: any;
}

function renderMd(input: RenderInput): string {
  const {
    headline, dev, holdout, m96Headline, m96Dev, m96Holdout,
    multi, single, multiDev, multiHoldout, hiddenSub, partialSub,
    byRepo, byShape, outcomeDist, reasonDist, coverage,
    coeditAll, coeditDev, coeditHoldout, flips, m94, m95,
  } = input;
  const HEAD = "| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack |";
  const SEP = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const outcomeLine = Object.entries(outcomeDist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
  const reasonLine = Object.entries(reasonDist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
  const flipLine = flips.length === 0
    ? "none"
    : flips.map((f) => `${f.instance_id} ${f.from}→${f.to}`).join(", ");
  return `# Stage 5 M97 Deterministic VTRACE Scoreboard (post hidden co-edit lane)

_Deterministic, offline: no live agents, no Docker, no API spend. Same generation
path as M94/M95/M96; compared against the frozen M96 baseline (M94/M95 kept as
historical references)._

## Summary

- Scored: **${coverage.scored}/${coverage.attempted}**
- ALL: recall@5 **${n3(headline.recall_at_5)}** (M96 ${n3(m96Headline.recall_at_5)}, M95 ${n3(m95.headline.recall_at_5)}, M94 ${n3(m94.headline.mean_recall_at_5)}), any-gold **${pct(headline.any_gold_in_capsule)}** (M96 ${pct(m96Headline.any_gold_in_capsule)}), all-gold **${pct(headline.all_gold_in_capsule)}** (M96 ${pct(m96Headline.all_gold_in_capsule)}), hidden-coedit **${n3(headline.hidden_coedit_recall)}** (M96 ${n3(m96Headline.hidden_coedit_recall)})
- HOLDOUT: recall@1 **${n3(holdout.recall_at_1)}** (M96 ${n3(m96Holdout.recall_at_1)}), any-gold **${pct(holdout.any_gold_in_capsule)}** (M96 ${pct(m96Holdout.any_gold_in_capsule)}), hidden-coedit **${n3(holdout.hidden_coedit_recall)}** (M96 ${n3(m96Holdout.hidden_coedit_recall)}), med tok **${holdout.median_capsule_est_tokens}** (M96 ${m96Holdout.median_capsule_est_tokens}), p90 **${holdout.p90_capsule_est_tokens}** (M96 ${m96Holdout.p90_capsule_est_tokens})
- MULTI-FILE: all-gold **${pct(multi.m96.all_gold_in_capsule)} → ${pct(multi.m97.all_gold_in_capsule)}**, hidden-coedit **${n3(multi.m96.hidden_coedit_recall)} → ${n3(multi.m97.hidden_coedit_recall)}**
- Dev outcome flips vs M96: ${flipLine}
- Outcome distribution: ${outcomeLine}
- Failure-reason distribution: ${reasonLine}

## Cohort Metrics

${HEAD}
${SEP}
${cohortRow(headline)}
${cohortRow(dev)}
${cohortRow(holdout)}
${cohortRow(multi.m97)}
${cohortRow(single.m97)}
${cohortRow(hiddenSub.m97)}
${cohortRow(partialSub.m97)}

## M96 → M97 Deltas

${cohortDelta("All scored", m96Headline, headline)}
${cohortDelta("Dev", m96Dev, dev)}
${cohortDelta("Holdout", m96Holdout, holdout)}
${cohortDelta("Multi-file only", multi.m96, multi.m97)}
${cohortDelta("Multi-file dev", multiDev.m96, multiDev.m97)}
${cohortDelta("Multi-file holdout", multiHoldout.m96, multiHoldout.m97)}
${cohortDelta("Single-file only", single.m96, single.m97)}
${cohortDelta("Hidden-coedit subset", hiddenSub.m96, hiddenSub.m97)}
${cohortDelta("Partial-gold subset (any found, some missing)", partialSub.m96, partialSub.m97)}

## Co-edit Lane

${coeditBlock("all", coeditAll)}
${coeditBlock("dev", coeditDev)}
${coeditBlock("holdout", coeditHoldout)}

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
