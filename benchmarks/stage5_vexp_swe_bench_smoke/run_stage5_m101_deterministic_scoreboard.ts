// Stage 5 M101 — deterministic VTRACE retrieval/capsule scoreboard: runner.
//
// Same generation/scoring path as M94–M100 (buildCapsuleV2 over the clean
// base-commit index; gold is scoring-only, never fed into generation), re-run so
// the M101 anchored-target pivot guard (dispatcher-demotion exemption + bounded
// pivot-cap exemption for title-symbol / literal-anchor / strong-direct-evidence
// targets) can be measured against the frozen M100 baseline. Adds: (a) the
// M100 wrong_pivot and source-gold-available comparison cohorts (id sets fixed
// from frozen M100 rows), and (b) per-case pivot-guard instrumentation (version,
// cap/dispatcher exemptions, lead flips vs M100).
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

interface PivotGuardStats {
  readonly version: string | null;
  readonly cap_exemptions: Array<{ path: string; symbol: string }>;
  readonly dispatcher_exemptions: Array<{ path: string; symbol: string }>;
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
  readonly pivot_guard: PivotGuardStats | null;
  readonly file_metrics: FileMetrics | null;
  readonly target_metrics: TargetMetrics | null;
  readonly budget_metrics: BudgetMetrics | null;
  readonly symbol_metrics: SymbolMetrics | null;
  readonly outcome: Outcome | null;
  readonly failure_reasons: FailureReason[];
}

function pivotGuardStats(result: CapsuleV2Result): PivotGuardStats {
  const d = result.diagnostics;
  return {
    version: d.pivot_selection_version ?? null,
    cap_exemptions: d.anchored_pivot_cap_exemptions ?? [],
    dispatcher_exemptions: d.anchored_dispatcher_demotions_prevented ?? [],
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
    pivot_guard: null,
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
    pivot_guard: pivotGuardStats(result),
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
  readonly gold_file_in_required: number;
  readonly mean_required_gold_file_count: number;
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
    gold_file_in_required: rate(tm.map((m) => m.gold_file_in_required)),
    mean_required_gold_file_count: mean(tm.map((m) => m.required_gold_file_count)),
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

interface GuardAggregate {
  readonly n: number;
  readonly guard_fired: number;
  readonly cap_exemptions: number;
  readonly dispatcher_exemptions: number;
  readonly cases: Array<{ instance_id: string; cap: string[]; dispatcher: string[] }>;
}

function aggregateGuard(rows: readonly DetailRow[]): GuardAggregate {
  const fired = rows.filter((r) => r.pivot_guard?.version != null);
  return {
    n: rows.length,
    guard_fired: fired.length,
    cap_exemptions: rows.reduce((acc, r) => acc + (r.pivot_guard?.cap_exemptions.length ?? 0), 0),
    dispatcher_exemptions: rows.reduce((acc, r) => acc + (r.pivot_guard?.dispatcher_exemptions.length ?? 0), 0),
    cases: fired.map((r) => ({
      instance_id: r.instance_id,
      cap: r.pivot_guard!.cap_exemptions.map((e) => `${e.path}::${e.symbol}`),
      dispatcher: r.pivot_guard!.dispatcher_exemptions.map((e) => `${e.path}::${e.symbol}`),
    })),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function n3(x: number | null): string { return x === null ? "—" : x.toFixed(3); }
function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }
function csvEscape(v: string): string { return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }

interface SplitFile { readonly dev: string[]; readonly holdout: string[]; }

interface M100DetailRow extends MetricRow {
  readonly gold: { multi_file: boolean; source_only: boolean };
  readonly repo: string;
  readonly capsule: { lead_pivot_file: string | null } | null;
  readonly file_metrics: FileMetrics | null;
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
    const guard = last.pivot_guard?.version != null
      ? ` [guard cap=${last.pivot_guard.cap_exemptions.length} disp=${last.pivot_guard.dispatcher_exemptions.length}]`
      : "";
    process.stdout.write(`${last.generation_status === "scored" ? "✓" : "·"} ${inst.instance_id}: ${last.outcome ?? last.generation_status}${guard}\n`);
  }

  const scored = scoredRows(rows);
  const coverage = {
    attempted: rows.length,
    scored: scored.length,
    missingWorkspace: rows.filter((r) => r.generation_status === "missing_workspace").length,
    goldUnavailable: rows.filter((r) => r.generation_status === "gold_unavailable").length,
    other: rows.filter((r) => r.generation_status === "error" || r.generation_status === "leakage_blocked").length,
  };

  // ---- M100 baseline detail rows, re-aggregated on identical id subsets ----
  const m100Detail = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m100_deterministic_scoreboard.detail.json"), "utf8"),
  ) as { rows: M100DetailRow[] };
  const m100Scored = scoredRows(m100Detail.rows);
  const m100ById = new Map(m100Scored.map((r) => [r.instance_id, r] as const));

  // Comparison cohorts (id sets defined from the frozen M100 baseline, so both
  // sides aggregate the SAME instances).
  const multiIds = new Set(m100Scored.filter((r) => r.gold.multi_file).map((r) => r.instance_id));
  const singleIds = new Set(m100Scored.filter((r) => !r.gold.multi_file).map((r) => r.instance_id));
  const hiddenIds = new Set(
    m100Scored.filter((r) => r.gold.multi_file && r.file_metrics!.hidden_coedit_recall !== null)
      .map((r) => r.instance_id),
  );
  const overpackedIds = new Set(
    m100Scored.filter((r) => r.outcome === "overpacked").map((r) => r.instance_id),
  );
  const wrongPivotIds = new Set(
    m100Scored.filter((r) => r.outcome === "wrong_pivot").map((r) => r.instance_id),
  );
  // Source gold already in the M100 capsule but a non-gold lead — the exact
  // population the M101 guard is allowed to affect.
  const sourceGoldAvailableIds = new Set(
    m100Scored
      .filter((r) => r.file_metrics!.source_gold_in_capsule && !r.file_metrics!.lead_pivot_is_source_gold)
      .map((r) => r.instance_id),
  );

  const sub = (ids: ReadonlySet<string>, rowsIn: readonly MetricRow[]): MetricRow[] =>
    rowsIn.filter((r) => ids.has(r.instance_id));
  const cohortPair = (name: string, ids: ReadonlySet<string>): { next: CohortAggregate; base: CohortAggregate } => ({
    next: aggregate(name, sub(ids, scored)),
    base: aggregate(`m100_${name}`, sub(ids, m100Scored)),
  });

  const headline = aggregate("all", scored);
  const dev = aggregate("dev", scored.filter((r) => devSet.has(r.instance_id)));
  const holdout = aggregate("holdout", scored.filter((r) => holdSet.has(r.instance_id)));
  const m100Headline = aggregate("m100_all", m100Scored);
  const m100Dev = aggregate("m100_dev", m100Scored.filter((r) => devSet.has(r.instance_id)));
  const m100Holdout = aggregate("m100_holdout", m100Scored.filter((r) => holdSet.has(r.instance_id)));

  const multi = cohortPair("multi_file", multiIds);
  const single = cohortPair("single_file", singleIds);
  const hiddenSub = cohortPair("hidden_coedit_subset", hiddenIds);
  const wrongPivotSub = cohortPair("m100_wrong_pivot", wrongPivotIds);
  const sourceGoldAvailSub = cohortPair("m100_source_gold_available", sourceGoldAvailableIds);
  const overpackedSub = cohortPair("m100_overpacked", overpackedIds);
  const multiDev = cohortPair("multi_file_dev", new Set([...multiIds].filter((id) => devSet.has(id))));
  const multiHoldout = cohortPair("multi_file_holdout", new Set([...multiIds].filter((id) => holdSet.has(id))));

  const repos = [...new Set(scored.map((r) => r.repo))].sort();
  const byRepo = repos.map((repo) => aggregate(repo, scored.filter((r) => r.repo === repo)));
  const m100ByRepo = new Map(repos.map((repo) => [
    repo, aggregate(repo, m100Scored.filter((r) => r.repo === repo)),
  ] as const));
  const byShape = [
    aggregate("single_file", scored.filter((r) => !r.gold.multi_file)),
    aggregate("multi_file", scored.filter((r) => r.gold.multi_file)),
    aggregate("source_only", scored.filter((r) => r.gold.source_only)),
    aggregate("test_including", scored.filter((r) => !r.gold.source_only)),
  ].filter((c) => c.n > 0);

  const guardAll = aggregateGuard(scored);
  const guardDev = aggregateGuard(scored.filter((r) => devSet.has(r.instance_id)));
  const guardHoldout = aggregateGuard(scored.filter((r) => holdSet.has(r.instance_id)));

  const outcomeDist = headline.outcomes;
  const reasonDist = reasonDistribution(rows);

  const outcomeFlips = scored
    .map((r) => {
      const before = m100ById.get(r.instance_id);
      if (before === undefined || before.outcome === r.outcome) return null;
      return {
        instance_id: r.instance_id,
        from: before.outcome,
        to: r.outcome,
        cohort: devSet.has(r.instance_id) ? "dev" : "holdout",
      };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  const leadFlips = scored
    .map((r) => {
      const before = m100ById.get(r.instance_id);
      if (before === undefined) return null;
      const oldLead = before.capsule?.lead_pivot_file ?? null;
      const newLead = r.capsule?.lead_pivot_file ?? null;
      if (oldLead === newLead) return null;
      return {
        instance_id: r.instance_id,
        lead_pivot_old: oldLead,
        lead_pivot_new: newLead,
        lead_now_source_gold: r.file_metrics!.lead_pivot_is_source_gold,
        lead_was_source_gold: before.file_metrics!.lead_pivot_is_source_gold,
        cohort: devSet.has(r.instance_id) ? "dev" : "holdout",
      };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  const allGoldFlips = scored
    .map((r) => {
      const before = m100ById.get(r.instance_id);
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

  await w("stage5_m101_deterministic_scoreboard.json", {
    milestone: "M101",
    kind: "Deterministic pre-agent VTRACE retrieval/capsule scoreboard (post anchored-target pivot guard)",
    live_agents: false, docker: false, api_spend: false,
    generation: { intent: "debug", budget: CAPSULE_BUDGET, builder: "buildCapsuleV2 (in-process)" },
    coverage, headline, dev, holdout,
    cohorts: {
      multi_file: multi, single_file: single,
      multi_file_dev: multiDev, multi_file_holdout: multiHoldout,
      hidden_coedit_subset: hiddenSub,
      m100_wrong_pivot: wrongPivotSub,
      m100_source_gold_available: sourceGoldAvailSub,
      m100_overpacked: overpackedSub,
    },
    by_repo: byRepo, by_patch_shape: byShape,
    pivot_guard: { all: guardAll, dev: guardDev, holdout: guardHoldout },
    outcome_distribution: outcomeDist, failure_reason_distribution: reasonDist,
    outcome_flips_vs_m100: outcomeFlips,
    lead_pivot_flips_vs_m100: leadFlips,
    all_gold_flips_vs_m100: allGoldFlips,
    m100_headline: m100Headline, m100_dev: m100Dev, m100_holdout: m100Holdout,
  });
  await w("stage5_m101_deterministic_scoreboard.detail.json", { milestone: "M101", count: rows.length, rows });
  await w("stage5_m101_deterministic_failure_modes.json", {
    milestone: "M101",
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
    "repo,n,recall_at_1,recall_at_5,recall_at_10,mrr,any_gold_in_capsule,lead_pivot_is_source_gold,gold_file_in_required,hidden_coedit_recall,median_est_tokens,mean_capsule_files,m100_recall_at_5,m100_lead_src_gold,m100_mean_capsule_files",
    ...byRepo.sort((a, b) => b.n - a.n).map((c) => {
      const base = m100ByRepo.get(c.cohort)!;
      return [c.cohort, c.n, c.recall_at_1.toFixed(4), c.recall_at_5.toFixed(4), c.recall_at_10.toFixed(4), c.mrr.toFixed(4),
        c.any_gold_in_capsule.toFixed(4), c.lead_pivot_is_source_gold.toFixed(4), c.gold_file_in_required.toFixed(4),
        c.hidden_coedit_recall === null ? "" : c.hidden_coedit_recall.toFixed(4), c.median_capsule_est_tokens,
        c.mean_capsule_file_count.toFixed(3),
        base.recall_at_5.toFixed(4), base.lead_pivot_is_source_gold.toFixed(4), base.mean_capsule_file_count.toFixed(3)]
        .map((x) => csvEscape(String(x))).join(",");
    }),
  ].join("\n");
  await writeFile(path.join(RESULTS_ROOT, "stage5_m101_deterministic_by_repo.csv"), repoCsv + "\n", "utf8");

  const missCsv = [
    "instance_id,repo,gold_files,top_candidates,capsule_files,failure_reason,cohort",
    ...scored.filter((r) => r.outcome === "miss" || r.outcome === "wrong_pivot").map((r) =>
      [r.instance_id, r.repo, r.gold.scored_files.join(" "), (r.capsule?.ranked_top10 ?? []).slice(0, 3).join(" "),
       (r.capsule?.capsule_files ?? []).slice(0, 3).join(" "), r.failure_reasons.join(" "),
       devSet.has(r.instance_id) ? "dev" : "holdout"].map((x) => csvEscape(String(x))).join(",")),
  ].join("\n");
  await writeFile(path.join(RESULTS_ROOT, "stage5_m101_deterministic_top_misses.csv"), missCsv + "\n", "utf8");

  const md = renderMd({
    headline, dev, holdout, m100Headline, m100Dev, m100Holdout,
    multi, single, multiDev, multiHoldout, hiddenSub, wrongPivotSub, sourceGoldAvailSub, overpackedSub,
    byRepo, byShape, outcomeDist, reasonDist, coverage,
    guardAll, guardDev, guardHoldout, outcomeFlips, leadFlips, allGoldFlips,
  });
  await writeFile(path.join(RESULTS_ROOT, "stage5_m101_deterministic_scoreboard.md"), md, "utf8");

  process.stdout.write(
    `\nM101 scoreboard: ${coverage.scored}/${coverage.attempted} scored\n` +
      `ALL     r@1=${headline.recall_at_1.toFixed(3)} r@5=${headline.recall_at_5.toFixed(3)} any=${pct(headline.any_gold_in_capsule)} all=${pct(headline.all_gold_in_capsule)} lead=src ${pct(headline.lead_pivot_is_source_gold)} (M100 ${pct(m100Headline.lead_pivot_is_source_gold)}) hidden=${n3(headline.hidden_coedit_recall)} medTok=${headline.median_capsule_est_tokens} p90=${headline.p90_capsule_est_tokens} files=${headline.mean_capsule_file_count.toFixed(3)}\n` +
      `DEV     r@1=${dev.recall_at_1.toFixed(3)} r@5=${dev.recall_at_5.toFixed(3)} any=${pct(dev.any_gold_in_capsule)} all=${pct(dev.all_gold_in_capsule)} lead=src ${pct(dev.lead_pivot_is_source_gold)} (M100 ${pct(m100Dev.lead_pivot_is_source_gold)})\n` +
      `HOLDOUT r@1=${holdout.recall_at_1.toFixed(3)} r@5=${holdout.recall_at_5.toFixed(3)} any=${pct(holdout.any_gold_in_capsule)} all=${pct(holdout.all_gold_in_capsule)} lead=src ${pct(holdout.lead_pivot_is_source_gold)} (M100 ${pct(m100Holdout.lead_pivot_is_source_gold)})\n` +
      `WRONG_PIVOT (M100 subset): outcomes ${JSON.stringify(wrongPivotSub.next.outcomes)}\n` +
      `guard: fired ${guardAll.guard_fired}/${guardAll.n} (cap ${guardAll.cap_exemptions}, dispatcher ${guardAll.dispatcher_exemptions})\n` +
      `lead flips vs M100: ${leadFlips.length === 0 ? "none" : leadFlips.map((f) => `${f.instance_id} ${f.lead_was_source_gold ? "G" : "·"}→${f.lead_now_source_gold ? "G" : "·"} [${f.cohort}]`).join(", ")}\n` +
      `all-gold flips vs M100: ${allGoldFlips.length === 0 ? "none" : allGoldFlips.map((f) => `${f.instance_id} ${f.direction} [${f.cohort}]`).join(", ")}\n` +
      `outcome flips vs M100: ${outcomeFlips.length === 0 ? "none" : outcomeFlips.map((f) => `${f.instance_id} ${f.from}→${f.to} [${f.cohort}]`).join(", ")}\n` +
      `outcomes: ${Object.entries(outcomeDist).map(([k, v]) => `${k}=${v}`).join(" ")}\n`,
  );
}

function cohortRow(c: CohortAggregate): string {
  return `| ${c.cohort} | ${c.n} | ${n3(c.recall_at_1)} | ${n3(c.recall_at_3)} | ${n3(c.recall_at_5)} | ${n3(c.recall_at_10)} | ${n3(c.mrr)} | ${pct(c.any_gold_in_capsule)} | ${pct(c.all_gold_in_capsule)} | ${pct(c.source_gold_in_capsule)} | ${pct(c.lead_pivot_is_source_gold)} | ${pct(c.gold_file_in_required)} | ${c.hidden_coedit_recall === null ? "—" : n3(c.hidden_coedit_recall)} | ${c.median_capsule_est_tokens} | ${c.p90_capsule_est_tokens} | ${n3(c.median_overpacking_ratio)} | ${c.mean_capsule_file_count.toFixed(2)} |`;
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

| metric | M100 | M101 | Δ |
| --- | --- | --- | --- |
${deltaRow("recall@1", base.recall_at_1, next.recall_at_1, false)}
${deltaRow("recall@3", base.recall_at_3, next.recall_at_3, false)}
${deltaRow("recall@5", base.recall_at_5, next.recall_at_5, false)}
${deltaRow("recall@10", base.recall_at_10, next.recall_at_10, false)}
${deltaRow("MRR", base.mrr, next.mrr, false)}
${deltaRow("any_gold_in_capsule", base.any_gold_in_capsule, next.any_gold_in_capsule, true)}
${deltaRow("all_gold_in_capsule", base.all_gold_in_capsule, next.all_gold_in_capsule, true)}
${deltaRow("lead_pivot_is_source_gold", base.lead_pivot_is_source_gold, next.lead_pivot_is_source_gold, true)}
${deltaRow("gold_file_in_required", base.gold_file_in_required, next.gold_file_in_required, true)}
${hiddenDeltaRow(base.hidden_coedit_recall, next.hidden_coedit_recall)}
| median tokens | ${base.median_capsule_est_tokens} | ${next.median_capsule_est_tokens} | ${next.median_capsule_est_tokens - base.median_capsule_est_tokens} |
| p90 tokens | ${base.p90_capsule_est_tokens} | ${next.p90_capsule_est_tokens} | ${next.p90_capsule_est_tokens - base.p90_capsule_est_tokens} |
| mean capsule files | ${n3(base.mean_capsule_file_count)} | ${n3(next.mean_capsule_file_count)} | ${(next.mean_capsule_file_count - base.mean_capsule_file_count).toFixed(3)} |
| mean required targets | ${n3(base.mean_required_target_count)} | ${n3(next.mean_required_target_count)} | ${(next.mean_required_target_count - base.mean_required_target_count).toFixed(3)} |
| mean optional targets | ${n3(base.mean_optional_target_count)} | ${n3(next.mean_optional_target_count)} | ${(next.mean_optional_target_count - base.mean_optional_target_count).toFixed(3)} |
| excellent | ${base.outcomes["excellent"] ?? 0} | ${next.outcomes["excellent"] ?? 0} | ${(next.outcomes["excellent"] ?? 0) - (base.outcomes["excellent"] ?? 0)} |
| wrong_pivot | ${base.outcomes["wrong_pivot"] ?? 0} | ${next.outcomes["wrong_pivot"] ?? 0} | ${(next.outcomes["wrong_pivot"] ?? 0) - (base.outcomes["wrong_pivot"] ?? 0)} |
| overpacked | ${base.outcomes["overpacked"] ?? 0} | ${next.outcomes["overpacked"] ?? 0} | ${(next.outcomes["overpacked"] ?? 0) - (base.outcomes["overpacked"] ?? 0)} |
`;
}

function guardBlock(label: string, g: GuardAggregate): string {
  return `- **${label}**: fired on ${g.guard_fired}/${g.n}; cap exemptions ${g.cap_exemptions}; `
    + `dispatcher exemptions ${g.dispatcher_exemptions}`
    + (g.cases.length > 0
      ? `\n${g.cases.map((c) => `  - ${c.instance_id}: ${[...c.cap.map((x) => `cap ${x}`), ...c.dispatcher.map((x) => `disp ${x}`)].join("; ")}`).join("\n")}`
      : "");
}

interface RenderInput {
  headline: CohortAggregate; dev: CohortAggregate; holdout: CohortAggregate;
  m100Headline: CohortAggregate; m100Dev: CohortAggregate; m100Holdout: CohortAggregate;
  multi: { next: CohortAggregate; base: CohortAggregate };
  single: { next: CohortAggregate; base: CohortAggregate };
  multiDev: { next: CohortAggregate; base: CohortAggregate };
  multiHoldout: { next: CohortAggregate; base: CohortAggregate };
  hiddenSub: { next: CohortAggregate; base: CohortAggregate };
  wrongPivotSub: { next: CohortAggregate; base: CohortAggregate };
  sourceGoldAvailSub: { next: CohortAggregate; base: CohortAggregate };
  overpackedSub: { next: CohortAggregate; base: CohortAggregate };
  byRepo: CohortAggregate[]; byShape: CohortAggregate[];
  outcomeDist: Record<string, number>; reasonDist: Record<string, number>;
  coverage: { attempted: number; scored: number };
  guardAll: GuardAggregate; guardDev: GuardAggregate; guardHoldout: GuardAggregate;
  outcomeFlips: Array<{ instance_id: string; from: string | null; to: string | null; cohort: string }>;
  leadFlips: Array<{
    instance_id: string; lead_pivot_old: string | null; lead_pivot_new: string | null;
    lead_now_source_gold: boolean; lead_was_source_gold: boolean; cohort: string;
  }>;
  allGoldFlips: Array<{ instance_id: string; direction: string; cohort: string }>;
}

function renderMd(input: RenderInput): string {
  const {
    headline, dev, holdout, m100Headline, m100Dev, m100Holdout,
    multi, single, multiDev, multiHoldout, hiddenSub, wrongPivotSub, sourceGoldAvailSub, overpackedSub,
    byRepo, byShape, outcomeDist, reasonDist, coverage,
    guardAll, guardDev, guardHoldout, outcomeFlips, leadFlips, allGoldFlips,
  } = input;
  const HEAD = "| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | gold-in-req | hidden-coedit | med tok | p90 tok | med overpack | mean files |";
  const SEP = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const outcomeLine = Object.entries(outcomeDist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
  const reasonLine = Object.entries(reasonDist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
  const flipLine = outcomeFlips.length === 0
    ? "none"
    : outcomeFlips.map((f) => `${f.instance_id} ${f.from}→${f.to} [${f.cohort}]`).join(", ");
  const leadLine = leadFlips.length === 0
    ? "none"
    : leadFlips.map((f) => `${f.instance_id} ${f.lead_pivot_old ?? "—"}→${f.lead_pivot_new ?? "—"}${f.lead_now_source_gold ? " (now gold)" : f.lead_was_source_gold ? " (LOST gold)" : ""} [${f.cohort}]`).join(", ");
  const allGoldLine = allGoldFlips.length === 0
    ? "none"
    : allGoldFlips.map((f) => `${f.instance_id} ${f.direction} [${f.cohort}]`).join(", ");
  return `# Stage 5 M101 Deterministic VTRACE Scoreboard (post anchored-target pivot guard)

_Deterministic, offline: no live agents, no Docker, no API spend. Same generation
path as M94–M100; compared against the frozen M100 baseline._

## Summary

- Scored: **${coverage.scored}/${coverage.attempted}**
- ALL: lead=src-gold **${pct(headline.lead_pivot_is_source_gold)}** (M100 ${pct(m100Headline.lead_pivot_is_source_gold)}), gold-in-required **${pct(headline.gold_file_in_required)}** (M100 ${pct(m100Headline.gold_file_in_required)}), wrong_pivot **${headline.outcomes["wrong_pivot"] ?? 0}** (M100 ${m100Headline.outcomes["wrong_pivot"] ?? 0}), recall@5 **${n3(headline.recall_at_5)}** (M100 ${n3(m100Headline.recall_at_5)}), any-gold **${pct(headline.any_gold_in_capsule)}** (M100 ${pct(m100Headline.any_gold_in_capsule)}), all-gold **${pct(headline.all_gold_in_capsule)}** (M100 ${pct(m100Headline.all_gold_in_capsule)}), hidden-coedit **${n3(headline.hidden_coedit_recall)}** (M100 ${n3(m100Headline.hidden_coedit_recall)}), mean files **${headline.mean_capsule_file_count.toFixed(3)}** (M100 ${m100Headline.mean_capsule_file_count.toFixed(3)})
- HOLDOUT: lead=src-gold **${pct(holdout.lead_pivot_is_source_gold)}** (M100 ${pct(m100Holdout.lead_pivot_is_source_gold)}), recall@1 **${n3(holdout.recall_at_1)}** (M100 ${n3(m100Holdout.recall_at_1)}), recall@5 **${n3(holdout.recall_at_5)}** (M100 ${n3(m100Holdout.recall_at_5)}), any-gold **${pct(holdout.any_gold_in_capsule)}** (M100 ${pct(m100Holdout.any_gold_in_capsule)}), all-gold **${pct(holdout.all_gold_in_capsule)}** (M100 ${pct(m100Holdout.all_gold_in_capsule)})
- Lead-pivot flips vs M100: ${leadLine}
- All-gold flips vs M100: ${allGoldLine}
- Outcome flips vs M100: ${flipLine}
- Outcome distribution: ${outcomeLine}
- Failure-reason distribution: ${reasonLine}

## Cohort Metrics

${HEAD}
${SEP}
${cohortRow(headline)}
${cohortRow(dev)}
${cohortRow(holdout)}
${cohortRow(multi.next)}
${cohortRow(single.next)}
${cohortRow(hiddenSub.next)}
${cohortRow(wrongPivotSub.next)}
${cohortRow(sourceGoldAvailSub.next)}
${cohortRow(overpackedSub.next)}

## M100 → M101 Deltas

${cohortDelta("All scored", m100Headline, headline)}
${cohortDelta("Dev", m100Dev, dev)}
${cohortDelta("Holdout", m100Holdout, holdout)}
${cohortDelta("M100 wrong_pivot subset", wrongPivotSub.base, wrongPivotSub.next)}
${cohortDelta("M100 source-gold-available subset (gold in capsule, non-gold lead)", sourceGoldAvailSub.base, sourceGoldAvailSub.next)}
${cohortDelta("Multi-file only", multi.base, multi.next)}
${cohortDelta("Multi-file dev", multiDev.base, multiDev.next)}
${cohortDelta("Multi-file holdout", multiHoldout.base, multiHoldout.next)}
${cohortDelta("Single-file only", single.base, single.next)}
${cohortDelta("Hidden-coedit subset", hiddenSub.base, hiddenSub.next)}
${cohortDelta("M100 overpacked cases", overpackedSub.base, overpackedSub.next)}

## Anchored-Target Pivot Guard

${guardBlock("all", guardAll)}
${guardBlock("dev", guardDev)}
${guardBlock("holdout", guardHoldout)}

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
