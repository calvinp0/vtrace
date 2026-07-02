// Stage 5 M96 — deterministic VTRACE retrieval/capsule scoreboard: runner.
//
// Same generation/scoring path as M94/M95 (buildCapsuleV2 over the clean
// base-commit index; gold is scoring-only, never fed into generation), re-run so
// the M96 direct-evidence candidate lane can be measured against the frozen M94
// and M95 baselines. Adds: (a) an absent-gold subset cohort (the cases whose
// gold was absent from the M95 candidate pool, ids from the pre-change gap
// audit), and (b) per-case direct-evidence instrumentation read from the
// capsule diagnostics (mentions extracted, candidates added/boosted, gold hit,
// ambiguous/generic rejects).
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
import { loadBaseCommits } from "./prepare_stage5_workspaces";
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
const CAPSULE_INTENT = CapsuleIntent.Debug;
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

interface DirectEvidenceStats {
  readonly search_used: boolean;
  readonly mentions_extracted: number;
  readonly candidates_added: number;
  readonly candidates_boosted: number;
  readonly gold_hit: boolean;
  readonly non_gold_matches: number;
  readonly ambiguous_rejected: number;
  readonly generic_rejected: number;
  readonly types: string[];
  readonly matches: Array<{ term: string; type: string; tier: string; path: string; symbol: string }>;
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
  readonly direct_evidence: DirectEvidenceStats | null;
  readonly file_metrics: FileMetrics | null;
  readonly target_metrics: TargetMetrics | null;
  readonly budget_metrics: BudgetMetrics | null;
  readonly symbol_metrics: SymbolMetrics | null;
  readonly outcome: Outcome | null;
  readonly failure_reasons: FailureReason[];
}

function directEvidenceStats(result: CapsuleV2Result, goldFiles: readonly string[]): DirectEvidenceStats {
  const d = result.diagnostics;
  const matches = d.direct_evidence_matches ?? [];
  const boosted = d.direct_evidence_boosted ?? [];
  const boostedKeys = new Set(boosted.map((b) => `${b.path}|${b.symbol}`));
  const goldHit = matches.some((m) => goldFiles.some((g) => fileMatches(g, m.path)));
  return {
    search_used: d.direct_evidence_search_used ?? false,
    mentions_extracted: (d.direct_evidence_mentions ?? []).length,
    candidates_added: matches.filter((m) => !boostedKeys.has(`${m.path}|${m.symbol}`)).length,
    candidates_boosted: boosted.length,
    gold_hit: goldHit,
    non_gold_matches: matches.filter((m) => !goldFiles.some((g) => fileMatches(g, m.path))).length,
    ambiguous_rejected: d.direct_evidence_rejected_ambiguous_count ?? 0,
    generic_rejected: d.direct_evidence_rejected_generic_count ?? 0,
    types: [...new Set(matches.map((m) => m.type))].sort(),
    matches: matches.map((m) => ({ term: m.term, type: m.type, tier: m.tier, path: m.path, symbol: m.symbol })),
  };
}

function scoreInstance(instance: SweBenchInstance, baseCommit: string | null): DetailRow {
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
    direct_evidence: null,
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
    result = buildCapsuleV2({ db, repoRoot: workspace, task, intent: CAPSULE_INTENT, maxTokens: CAPSULE_BUDGET });
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
    status_detail: baseCommit ? null : "base_commit missing from dataset",
    capsule: {
      mode: result.actual_mode,
      lead_pivot_file: cf.leadPivotFile,
      required_files: cf.requiredFiles,
      optional_files: cf.optionalFiles,
      capsule_files: cf.capsuleFiles,
      ranked_top10: [...cf.requiredFiles, ...cf.optionalFiles].slice(0, 10),
    },
    direct_evidence: directEvidenceStats(result, gold.scoredFiles),
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

function scoredRows(rows: readonly DetailRow[]): DetailRow[] {
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

function aggregate(cohort: string, rows: readonly DetailRow[]): CohortAggregate {
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

interface DirectEvidenceAggregate {
  readonly cases_with_mentions: number;
  readonly cases_search_used: number;
  readonly cases_gold_hit: number;
  readonly total_candidates_added: number;
  readonly total_candidates_boosted: number;
  readonly total_gold_matches_cases: number;
  readonly total_non_gold_matches: number;
  readonly total_ambiguous_rejected: number;
  readonly total_generic_rejected: number;
  readonly gold_hit_rate_when_used: number | null;
  readonly type_distribution: Record<string, number>;
}

function aggregateDirectEvidence(rows: readonly DetailRow[]): DirectEvidenceAggregate {
  const de = rows.map((r) => r.direct_evidence).filter((d): d is DirectEvidenceStats => d !== null);
  const used = de.filter((d) => d.search_used);
  const types: Record<string, number> = {};
  for (const d of de) for (const t of d.types) types[t] = (types[t] ?? 0) + 1;
  return {
    cases_with_mentions: de.filter((d) => d.mentions_extracted > 0).length,
    cases_search_used: used.length,
    cases_gold_hit: used.filter((d) => d.gold_hit).length,
    total_candidates_added: de.reduce((acc, d) => acc + d.candidates_added, 0),
    total_candidates_boosted: de.reduce((acc, d) => acc + d.candidates_boosted, 0),
    total_gold_matches_cases: de.filter((d) => d.gold_hit).length,
    total_non_gold_matches: de.reduce((acc, d) => acc + d.non_gold_matches, 0),
    total_ambiguous_rejected: de.reduce((acc, d) => acc + d.ambiguous_rejected, 0),
    total_generic_rejected: de.reduce((acc, d) => acc + d.generic_rejected, 0),
    gold_hit_rate_when_used: used.length > 0 ? used.filter((d) => d.gold_hit).length / used.length : null,
    type_distribution: types,
  };
}

// ---------------------------------------------------------------------------
// Baseline comparison helpers
// ---------------------------------------------------------------------------

// M95 detail rows re-aggregated on an arbitrary id subset, so the absent-gold /
// by-shape cohorts compare like-for-like against the SAME instances.
interface BaselineDetailRow {
  readonly instance_id: string;
  readonly generation_status: string;
  readonly file_metrics: FileMetrics | null;
  readonly target_metrics: TargetMetrics | null;
  readonly budget_metrics: BudgetMetrics | null;
  readonly outcome: string | null;
}

function baselineAggregate(cohort: string, rows: readonly BaselineDetailRow[]): CohortAggregate {
  return aggregate(cohort, rows as unknown as DetailRow[]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function n3(x: number | null): string { return x === null ? "—" : x.toFixed(3); }
function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }
function csvEscape(v: string): string { return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }

interface SplitFile { readonly dev: string[]; readonly holdout: string[]; }
interface GapAuditFile { readonly absent_case_ids: { dev: string[]; holdout: string[] }; }

async function main(): Promise<void> {
  const dataPath = process.argv.includes("--swe-bench-data")
    ? process.argv[process.argv.indexOf("--swe-bench-data") + 1]!
    : DEFAULT_DATA;

  const swe = await loadSweBench(dataPath);
  const baseCommits = await loadBaseCommits(dataPath);
  const instances = [...swe.values()].sort((a, b) => a.instance_id.localeCompare(b.instance_id));

  const split = JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m95_dev_holdout_split.json"), "utf8")) as SplitFile;
  const devSet = new Set(split.dev);
  const holdSet = new Set(split.holdout);
  const gapAudit = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m96_candidate_pool_gap_audit.json"), "utf8"),
  ) as GapAuditFile;
  const absentSet = new Set([...gapAudit.absent_case_ids.dev, ...gapAudit.absent_case_ids.holdout]);

  const rows: DetailRow[] = [];
  for (const inst of instances) {
    rows.push(scoreInstance(inst, baseCommits.get(inst.instance_id)?.base_commit ?? null));
    const last = rows.at(-1)!;
    process.stdout.write(`${last.generation_status === "scored" ? "✓" : "·"} ${inst.instance_id}: ${last.outcome ?? last.generation_status}\n`);
  }

  const scored = scoredRows(rows);
  const coverage = {
    attempted: rows.length,
    scored: scored.length,
    missingWorkspace: rows.filter((r) => r.generation_status === "missing_workspace").length,
    goldUnavailable: rows.filter((r) => r.generation_status === "gold_unavailable").length,
    other: rows.filter((r) => r.generation_status === "error" || r.generation_status === "leakage_blocked").length,
  };

  const headline = aggregate("all", scored);
  const dev = aggregate("dev", scored.filter((r) => devSet.has(r.instance_id)));
  const holdout = aggregate("holdout", scored.filter((r) => holdSet.has(r.instance_id)));
  const absentGold = aggregate("absent_gold_m95", scored.filter((r) => absentSet.has(r.instance_id)));
  const absentGoldDev = aggregate("absent_gold_m95_dev",
    scored.filter((r) => absentSet.has(r.instance_id) && devSet.has(r.instance_id)));
  const absentGoldHoldout = aggregate("absent_gold_m95_holdout",
    scored.filter((r) => absentSet.has(r.instance_id) && holdSet.has(r.instance_id)));
  const repos = [...new Set(scored.map((r) => r.repo))].sort();
  const byRepo = repos.map((repo) => aggregate(repo, scored.filter((r) => r.repo === repo)));
  const byShape = [
    aggregate("single_file", scored.filter((r) => !r.gold.multi_file)),
    aggregate("multi_file", scored.filter((r) => r.gold.multi_file)),
    aggregate("source_only", scored.filter((r) => r.gold.source_only)),
    aggregate("test_including", scored.filter((r) => !r.gold.source_only)),
  ].filter((c) => c.n > 0);

  const deAll = aggregateDirectEvidence(scored);
  const deDev = aggregateDirectEvidence(scored.filter((r) => devSet.has(r.instance_id)));
  const deHoldout = aggregateDirectEvidence(scored.filter((r) => holdSet.has(r.instance_id)));

  const outcomeDist = headline.outcomes;
  const reasonDist = reasonDistribution(rows);

  // ---- load M94 + M95 baselines for comparison ----
  const m94 = JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m94_deterministic_scoreboard.json"), "utf8"));
  const m95 = JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m95_deterministic_scoreboard.json"), "utf8"));
  const m95Detail = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m95_deterministic_scoreboard.detail.json"), "utf8"),
  ) as { rows: BaselineDetailRow[] };
  const m95Scored = m95Detail.rows.filter(
    (r) => r.generation_status === "scored" && r.file_metrics && r.target_metrics,
  );
  const m95AbsentGold = baselineAggregate("m95_absent_gold", m95Scored.filter((r) => absentSet.has(r.instance_id)));
  const m95AbsentGoldDev = baselineAggregate("m95_absent_gold_dev",
    m95Scored.filter((r) => absentSet.has(r.instance_id) && devSet.has(r.instance_id)));
  const m95AbsentGoldHoldout = baselineAggregate("m95_absent_gold_holdout",
    m95Scored.filter((r) => absentSet.has(r.instance_id) && holdSet.has(r.instance_id)));

  await mkdir(RESULTS_ROOT, { recursive: true });
  const w = (name: string, data: unknown) =>
    writeFile(path.join(RESULTS_ROOT, name), JSON.stringify(data, null, 2) + "\n", "utf8");

  await w("stage5_m96_deterministic_scoreboard.json", {
    milestone: "M96",
    kind: "Deterministic pre-agent VTRACE retrieval/capsule scoreboard (post direct-evidence lane)",
    live_agents: false, docker: false, api_spend: false,
    generation: { intent: "debug", budget: CAPSULE_BUDGET, builder: "buildCapsuleV2 (in-process)" },
    coverage, headline, dev, holdout,
    absent_gold_subset: { all: absentGold, dev: absentGoldDev, holdout: absentGoldHoldout,
      m95_baseline: { all: m95AbsentGold, dev: m95AbsentGoldDev, holdout: m95AbsentGoldHoldout } },
    by_repo: byRepo, by_patch_shape: byShape,
    direct_evidence: { all: deAll, dev: deDev, holdout: deHoldout },
    outcome_distribution: outcomeDist, failure_reason_distribution: reasonDist,
    m94_headline: m94.headline, m95_headline: m95.headline, m95_dev: m95.dev, m95_holdout: m95.holdout,
  });
  await w("stage5_m96_deterministic_scoreboard.detail.json", { milestone: "M96", count: rows.length, rows });
  await w("stage5_m96_deterministic_failure_modes.json", {
    milestone: "M96",
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

  // by-repo CSV
  const repoCsv = [
    "repo,n,recall_at_1,recall_at_5,recall_at_10,mrr,any_gold_in_capsule,lead_pivot_is_source_gold,median_est_tokens",
    ...byRepo.sort((a, b) => b.n - a.n).map((c) =>
      [c.cohort, c.n, c.recall_at_1.toFixed(4), c.recall_at_5.toFixed(4), c.recall_at_10.toFixed(4), c.mrr.toFixed(4),
       c.any_gold_in_capsule.toFixed(4), c.lead_pivot_is_source_gold.toFixed(4), c.median_capsule_est_tokens]
        .map((x) => csvEscape(String(x))).join(",")),
  ].join("\n");
  await writeFile(path.join(RESULTS_ROOT, "stage5_m96_deterministic_by_repo.csv"), repoCsv + "\n", "utf8");

  const missCsv = [
    "instance_id,repo,gold_files,top_candidates,capsule_files,failure_reason,cohort",
    ...scored.filter((r) => r.outcome === "miss" || r.outcome === "wrong_pivot").map((r) =>
      [r.instance_id, r.repo, r.gold.scored_files.join(" "), (r.capsule?.ranked_top10 ?? []).slice(0, 3).join(" "),
       (r.capsule?.capsule_files ?? []).slice(0, 3).join(" "), r.failure_reasons.join(" "),
       devSet.has(r.instance_id) ? "dev" : "holdout"].map((x) => csvEscape(String(x))).join(",")),
  ].join("\n");
  await writeFile(path.join(RESULTS_ROOT, "stage5_m96_deterministic_top_misses.csv"), missCsv + "\n", "utf8");

  // Markdown
  const md = renderMd({
    headline, dev, holdout, absentGold, absentGoldDev, absentGoldHoldout,
    m95AbsentGold, m95AbsentGoldDev, m95AbsentGoldHoldout,
    byRepo, byShape, outcomeDist, reasonDist, coverage,
    deAll, deDev, deHoldout, m94, m95,
  });
  await writeFile(path.join(RESULTS_ROOT, "stage5_m96_deterministic_scoreboard.md"), md, "utf8");

  process.stdout.write(
    `\nM96 scoreboard: ${coverage.scored}/${coverage.attempted} scored\n` +
      `ALL     r@1=${headline.recall_at_1.toFixed(3)} r@5=${headline.recall_at_5.toFixed(3)} r@10=${headline.recall_at_10.toFixed(3)} any=${pct(headline.any_gold_in_capsule)} lead=${pct(headline.lead_pivot_is_source_gold)} medTok=${headline.median_capsule_est_tokens} p90=${headline.p90_capsule_est_tokens}\n` +
      `DEV     r@1=${dev.recall_at_1.toFixed(3)} r@5=${dev.recall_at_5.toFixed(3)} r@10=${dev.recall_at_10.toFixed(3)} any=${pct(dev.any_gold_in_capsule)} lead=${pct(dev.lead_pivot_is_source_gold)} medTok=${dev.median_capsule_est_tokens} p90=${dev.p90_capsule_est_tokens}\n` +
      `HOLDOUT r@1=${holdout.recall_at_1.toFixed(3)} r@5=${holdout.recall_at_5.toFixed(3)} r@10=${holdout.recall_at_10.toFixed(3)} any=${pct(holdout.any_gold_in_capsule)} lead=${pct(holdout.lead_pivot_is_source_gold)} medTok=${holdout.median_capsule_est_tokens} p90=${holdout.p90_capsule_est_tokens}\n` +
      `ABSENT  all any=${pct(absentGold.any_gold_in_capsule)} (M95 ${pct(m95AbsentGold.any_gold_in_capsule)}) | holdout any=${pct(absentGoldHoldout.any_gold_in_capsule)} (M95 ${pct(m95AbsentGoldHoldout.any_gold_in_capsule)})\n` +
      `outcomes: ${Object.entries(outcomeDist).map(([k, v]) => `${k}=${v}`).join(" ")}\n`,
  );
}

function cohortRow(c: CohortAggregate): string {
  return `| ${c.cohort} | ${c.n} | ${n3(c.recall_at_1)} | ${n3(c.recall_at_3)} | ${n3(c.recall_at_5)} | ${n3(c.recall_at_10)} | ${n3(c.mrr)} | ${pct(c.any_gold_in_capsule)} | ${pct(c.all_gold_in_capsule)} | ${pct(c.source_gold_in_capsule)} | ${pct(c.lead_pivot_is_source_gold)} | ${c.hidden_coedit_recall === null ? "—" : n3(c.hidden_coedit_recall)} | ${c.median_capsule_est_tokens} | ${c.p90_capsule_est_tokens} | ${n3(c.median_overpacking_ratio)} |`;
}

interface RenderInput {
  headline: CohortAggregate; dev: CohortAggregate; holdout: CohortAggregate;
  absentGold: CohortAggregate; absentGoldDev: CohortAggregate; absentGoldHoldout: CohortAggregate;
  m95AbsentGold: CohortAggregate; m95AbsentGoldDev: CohortAggregate; m95AbsentGoldHoldout: CohortAggregate;
  byRepo: CohortAggregate[]; byShape: CohortAggregate[];
  outcomeDist: Record<string, number>; reasonDist: Record<string, number>;
  coverage: { attempted: number; scored: number };
  deAll: DirectEvidenceAggregate; deDev: DirectEvidenceAggregate; deHoldout: DirectEvidenceAggregate;
  m94: any; m95: any;
}

function deltaRow(metric: string, base: number, next: number, asPct: boolean): string {
  const f = (x: number): string => (asPct ? pct(x) : n3(x));
  const d = asPct ? `${((next - base) * 100).toFixed(1)}pts` : (next - base).toFixed(3);
  return `| ${metric} | ${f(base)} | ${f(next)} | ${d} |`;
}

function cohortDelta(title: string, base: CohortAggregate, next: CohortAggregate): string {
  return `### ${title} (n=${next.n})

| metric | M95 | M96 | Δ |
| --- | --- | --- | --- |
${deltaRow("recall@1", base.recall_at_1, next.recall_at_1, false)}
${deltaRow("recall@3", base.recall_at_3, next.recall_at_3, false)}
${deltaRow("recall@5", base.recall_at_5, next.recall_at_5, false)}
${deltaRow("recall@10", base.recall_at_10, next.recall_at_10, false)}
${deltaRow("MRR", base.mrr, next.mrr, false)}
${deltaRow("any_gold_in_capsule", base.any_gold_in_capsule, next.any_gold_in_capsule, true)}
${deltaRow("all_gold_in_capsule", base.all_gold_in_capsule, next.all_gold_in_capsule, true)}
${deltaRow("lead_pivot_is_source_gold", base.lead_pivot_is_source_gold, next.lead_pivot_is_source_gold, true)}
| median tokens | ${base.median_capsule_est_tokens} | ${next.median_capsule_est_tokens} | ${next.median_capsule_est_tokens - base.median_capsule_est_tokens} |
| p90 tokens | ${base.p90_capsule_est_tokens} | ${next.p90_capsule_est_tokens} | ${next.p90_capsule_est_tokens - base.p90_capsule_est_tokens} |
| overpacked | ${base.outcomes["overpacked"] ?? 0} | ${next.outcomes["overpacked"] ?? 0} | ${(next.outcomes["overpacked"] ?? 0) - (base.outcomes["overpacked"] ?? 0)} |
`;
}

function deBlock(label: string, de: DirectEvidenceAggregate): string {
  return `- **${label}**: search used on ${de.cases_search_used} cases (${de.cases_with_mentions} had mentions); ` +
    `gold hit on ${de.cases_gold_hit} (${de.gold_hit_rate_when_used === null ? "—" : pct(de.gold_hit_rate_when_used)} of used); ` +
    `candidates added ${de.total_candidates_added}, boosted ${de.total_candidates_boosted}, non-gold matches ${de.total_non_gold_matches}; ` +
    `rejected ambiguous ${de.total_ambiguous_rejected}, generic ${de.total_generic_rejected}; ` +
    `types: ${Object.entries(de.type_distribution).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}`;
}

function renderMd(input: RenderInput): string {
  const {
    headline, dev, holdout, absentGold, absentGoldDev, absentGoldHoldout,
    m95AbsentGold, m95AbsentGoldDev, m95AbsentGoldHoldout,
    byRepo, byShape, outcomeDist, reasonDist, coverage, deAll, deDev, deHoldout, m94, m95,
  } = input;
  const HEAD = "| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack |";
  const SEP = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const m94h = m94.headline as Record<string, number>;
  const m95h = m95.headline as CohortAggregate;
  const m95dev = m95.dev as CohortAggregate;
  const m95hold = m95.holdout as CohortAggregate;
  const outcomeLine = Object.entries(outcomeDist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
  const reasonLine = Object.entries(reasonDist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
  return `# Stage 5 M96 Deterministic VTRACE Scoreboard (post direct-evidence lane)

_Deterministic, offline: no live agents, no Docker, no API spend. Same generation
path as M94/M95; compared against the frozen M94 and M95 baselines._

## Summary

- Scored: **${coverage.scored}/${coverage.attempted}**
- ALL: recall@5 **${n3(headline.recall_at_5)}** (M95 ${n3(m95h.recall_at_5)}, M94 ${n3(m94h.mean_recall_at_5)}), any-gold **${pct(headline.any_gold_in_capsule)}** (M95 ${pct(m95h.any_gold_in_capsule)}), recall@1 **${n3(headline.recall_at_1)}** (M95 ${n3(m95h.recall_at_1)}), lead=src-gold **${pct(headline.lead_pivot_is_source_gold)}** (M95 ${pct(m95h.lead_pivot_is_source_gold)})
- HOLDOUT: recall@10 **${n3(holdout.recall_at_10)}** (M95 ${n3(m95hold.recall_at_10)}), any-gold **${pct(holdout.any_gold_in_capsule)}** (M95 ${pct(m95hold.any_gold_in_capsule)}), recall@1 **${n3(holdout.recall_at_1)}** (M95 ${n3(m95hold.recall_at_1)}), med tok **${holdout.median_capsule_est_tokens}** (M95 ${m95hold.median_capsule_est_tokens}), p90 **${holdout.p90_capsule_est_tokens}** (M95 ${m95hold.p90_capsule_est_tokens})
- ABSENT-GOLD SUBSET (holdout): any-gold **${pct(absentGoldHoldout.any_gold_in_capsule)}** (M95 ${pct(m95AbsentGoldHoldout.any_gold_in_capsule)})
- Outcome distribution: ${outcomeLine}
- Failure-reason distribution: ${reasonLine}

## Cohort Metrics

${HEAD}
${SEP}
${cohortRow(headline)}
${cohortRow(dev)}
${cohortRow(holdout)}
${cohortRow(absentGold)}
${cohortRow(absentGoldDev)}
${cohortRow(absentGoldHoldout)}

## M95 → M96 Deltas

${cohortDelta("All scored", m95h, headline)}
${cohortDelta("Dev", m95dev, dev)}
${cohortDelta("Holdout", m95hold, holdout)}
${cohortDelta("Absent-gold subset (all)", m95AbsentGold, absentGold)}
${cohortDelta("Absent-gold subset (dev)", m95AbsentGoldDev, absentGoldDev)}
${cohortDelta("Absent-gold subset (holdout)", m95AbsentGoldHoldout, absentGoldHoldout)}

## Direct-Evidence Lane

${deBlock("all", deAll)}
${deBlock("dev", deDev)}
${deBlock("holdout", deHoldout)}

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
