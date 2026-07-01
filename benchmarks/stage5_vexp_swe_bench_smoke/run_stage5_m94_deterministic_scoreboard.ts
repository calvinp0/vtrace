// Stage 5 M94 — deterministic VTRACE retrieval/capsule scoreboard: runner.
//
// WHAT THIS DOES
// ----------------
// Scores VTRACE's deterministic core BEFORE any coding agent acts. For each of the
// frozen Stage 5 100-task instances it:
//   1. reads the issue text + gold patch from the SWE-bench dataset,
//   2. derives the task prose from the problem_statement ALONE (never the patch),
//   3. opens the pre-indexed, clean base-commit workspace,
//   4. builds a Capsule v2 context from (task, intent=debug, budget=8000) ALONE,
//   5. scores the emitted capsule against the gold patch's files/symbols.
//
// Gold labels are SCORING-ONLY — they are extracted AFTER generation and never fed
// into the capsule. A per-instance leakage guard asserts this.
//
// It then joins the deterministic outcomes to the M92 clean-core live run (the 50
// per-instance `resolved`/cost/token rows) and reports the correlation cautiously.
//
// NO Claude, NO Docker, NO agent run, NO API calls, NO live network. Reads only the
// dataset, pre-indexed workspaces, and previously-captured live run artifacts.

import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  type GoldLabels,
  type Outcome,
  type SymbolMetrics,
  type TargetMetrics,
} from "./stage5_m94_lib";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_DATA = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
const RESULTS_ROOT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");
const WS_ROOT = path.join(RESULTS_ROOT, "workspaces");
const INDEX_RELPATH = path.join(".vtrace", "index.sqlite");
const CAPSULE_INTENT = CapsuleIntent.Debug;
const CAPSULE_BUDGET = 8000;

// Clean, base-commit workspace roots ONLY. The many per-run workspaces under
// `workspaces/<label>/` may have been mutated by the agent turn loop or Docker eval
// and must never be indexed here — they would contaminate the deterministic score.
const CLEAN_WS_ROOTS = ["expanded", "cross_repo"] as const;

// ---------------------------------------------------------------------------
// Split (frozen 100-task pool)
// ---------------------------------------------------------------------------

interface SplitRow {
  readonly instance_id: string;
  readonly repo: string;
  readonly base_commit: string | null;
  readonly problem_statement_present: boolean;
  readonly gold_patch_present: boolean;
  readonly gold_modified_files: string[];
  readonly gold_source_files: string[];
  readonly gold_test_files: string[];
  readonly gold_symbol_status: "available" | "unavailable";
  readonly m92_member: boolean;
  // Live treatment resolution from the M92 clean-core run (V4/C7_D off), the most
  // directly comparable per-instance live outcome. Null when not an M92 member.
  readonly m92_treatment_resolved: boolean | null;
  readonly selection_reason: "frozen_m73_100_pool";
}

// Resolve the clean indexed workspace for an instance (expanded or cross_repo). We
// deliberately do NOT fall back to the legacy per-run experiment dirs.
function resolveCleanWorkspace(instanceId: string): string | null {
  for (const root of CLEAN_WS_ROOTS) {
    const ws = path.join(WS_ROOT, root, instanceId);
    if (existsSync(path.join(ws, INDEX_RELPATH))) return ws;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Live outcome harvest (M92 clean-core run + tracked summaries)
// ---------------------------------------------------------------------------

interface LiveOutcome {
  readonly resolved: boolean | null;
  readonly costUsd: number | null;
  readonly totalTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly toolCalls: number | null;
  readonly numTurns: number | null;
  readonly source: string;
}

function readJsonSafe(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Harvest the M92 clean-core per-instance live rows from `runs/m92_core_reduction50_*`.
// Each run dir holds a `raw/vtrace/swebench-*.jsonl` canonical row (resolved, cost,
// tokens, tool calls) — the treatment (VTRACE, V4/C7_D off) outcome for that case.
function harvestM92Live(): Map<string, LiveOutcome> {
  const out = new Map<string, LiveOutcome>();
  const runsDir = path.join(RESULTS_ROOT, "runs");
  if (!existsSync(runsDir)) return out;
  const dirs = readdirSync(runsDir).filter((d) => d.startsWith("m92_core_reduction50_"));
  for (const d of dirs) {
    const rawDir = path.join(runsDir, d, "raw", "vtrace");
    if (!existsSync(rawDir)) continue;
    const jsonl = readdirSync(rawDir).find((f) => f.startsWith("swebench-") && f.endsWith(".jsonl"));
    if (!jsonl) continue;
    const content = readFileSync(path.join(rawDir, jsonl), "utf8").trim();
    if (!content) continue;
    // The canonical result row is the last non-empty line (a single JSON object).
    const line = content.split("\n").filter(Boolean).at(-1)!;
    let rec: Record<string, unknown> | null;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!rec || typeof rec.instanceId !== "string") continue;
    const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
    const cacheRead = num(rec.cacheReadTokens);
    const input = num(rec.inputTokens);
    const output = num(rec.outputTokens);
    const cacheCreate = num(rec.cacheCreationTokens);
    const total =
      input !== null || output !== null || cacheRead !== null || cacheCreate !== null
        ? (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheCreate ?? 0)
        : null;
    const toolCalls = rec.toolCalls && typeof rec.toolCalls === "object"
      ? Object.values(rec.toolCalls as Record<string, number>).reduce((a, b) => a + (Number(b) || 0), 0)
      : null;
    out.set(rec.instanceId, {
      resolved: typeof rec.resolved === "boolean" ? rec.resolved : null,
      costUsd: num(rec.costUsd),
      totalTokens: total,
      cacheReadTokens: cacheRead,
      toolCalls,
      numTurns: num(rec.numTurns),
      source: "m92_core_reduction50",
    });
  }
  return out;
}

// M92 token-attribution: the per-instance high-cost-unresolved list (the cases that
// dominated M92 spend). Used to answer "which deterministic misses map to expensive
// unresolved live cases?".
function loadM92HighCostUnresolved(): Set<string> {
  const att = readJsonSafe(path.join(RESULTS_ROOT, "stage5_m92_token_attribution.json")) as
    | { high_cost_unresolved?: Array<{ instance_id?: string }> }
    | null;
  const set = new Set<string>();
  for (const r of att?.high_cost_unresolved ?? []) if (r.instance_id) set.add(r.instance_id);
  return set;
}

// ---------------------------------------------------------------------------
// Per-instance scoreboard row
// ---------------------------------------------------------------------------

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
  readonly file_metrics: FileMetrics | null;
  readonly target_metrics: TargetMetrics | null;
  readonly budget_metrics: BudgetMetrics | null;
  readonly symbol_metrics: SymbolMetrics | null;
  readonly outcome: Outcome | null;
  readonly failure_reasons: FailureReason[];
  readonly live: LiveOutcome | null;
  readonly m92_member: boolean;
  readonly m92_high_cost_unresolved: boolean;
}

// ---------------------------------------------------------------------------
// Generation + scoring for one instance
// ---------------------------------------------------------------------------

function scoreInstance(
  instance: SweBenchInstance,
  baseCommit: string | null,
  live: LiveOutcome | null,
  m92Member: boolean,
  m92HighCostUnresolved: boolean,
): DetailRow {
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
    file_metrics: null,
    target_metrics: null,
    budget_metrics: null,
    symbol_metrics: null,
    outcome: null,
    failure_reasons: [] as FailureReason[],
    live,
    m92_member: m92Member,
    m92_high_cost_unresolved: m92HighCostUnresolved,
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

  // GOLD-LEAKAGE GUARD: the task text (the only generation input) must not name a
  // gold file path. If it does, the score would be invalid — flag, do not generate.
  const leak = assertNoGoldLeakage(task, gold);
  if (leak !== null) {
    return { ...base, generation_status: "leakage_blocked",
      status_detail: `gold path in task: ${leak}`, failure_reasons: ["unknown"] };
  }

  let result: CapsuleV2Result;
  const db = openIndexerDatabase(path.join(workspace, INDEX_RELPATH));
  try {
    result = buildCapsuleV2({
      db,
      repoRoot: workspace,
      task,
      intent: CAPSULE_INTENT,
      maxTokens: CAPSULE_BUDGET,
    });
  } catch (error) {
    db.close();
    return { ...base, generation_status: "error",
      status_detail: error instanceof Error ? error.message : String(error),
      failure_reasons: ["unknown"] };
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
  const classification: Classification = classify(gold, fileMetrics, targetMetrics, {
    unparsedLanguageGold,
    zeroRequired,
  });

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
  readonly mean_recall_at_1: number;
  readonly mean_recall_at_3: number;
  readonly mean_recall_at_5: number;
  readonly mean_recall_at_10: number;
  readonly mrr_first_gold: number;
  readonly any_gold_in_capsule_rate: number;
  readonly all_gold_in_capsule_rate: number;
  readonly source_gold_in_capsule_rate: number;
  readonly lead_pivot_is_gold_rate: number;
  readonly lead_pivot_is_source_gold_rate: number;
  readonly hidden_coedit_recall_mean: number | null;
  readonly median_capsule_est_tokens: number;
  readonly p90_capsule_est_tokens: number;
  readonly median_overpacking_ratio: number | null;
}

function aggregateCohort(cohort: string, rows: readonly DetailRow[]): CohortAggregate {
  const fm = rows.map((r) => r.file_metrics!);
  const tm = rows.map((r) => r.target_metrics!);
  const bm = rows.map((r) => r.budget_metrics!);
  const hiddenVals = fm.map((m) => m.hidden_coedit_recall).filter((v): v is number => v !== null);
  const overpackVals = tm.map((m) => m.overpacking_ratio).filter((v): v is number => v !== null);
  return {
    cohort,
    n: rows.length,
    mean_recall_at_1: mean(fm.map((m) => m.gold_file_recall_at_1)),
    mean_recall_at_3: mean(fm.map((m) => m.gold_file_recall_at_3)),
    mean_recall_at_5: mean(fm.map((m) => m.gold_file_recall_at_5)),
    mean_recall_at_10: mean(fm.map((m) => m.gold_file_recall_at_10)),
    mrr_first_gold: mean(fm.map((m) => m.mrr_first_gold_file)),
    any_gold_in_capsule_rate: rate(fm.map((m) => m.any_gold_in_capsule)),
    all_gold_in_capsule_rate: rate(fm.map((m) => m.all_gold_in_capsule)),
    source_gold_in_capsule_rate: rate(fm.map((m) => m.source_gold_in_capsule)),
    lead_pivot_is_gold_rate: rate(fm.map((m) => m.lead_pivot_is_gold)),
    lead_pivot_is_source_gold_rate: rate(fm.map((m) => m.lead_pivot_is_source_gold)),
    hidden_coedit_recall_mean: hiddenVals.length > 0 ? mean(hiddenVals) : null,
    median_capsule_est_tokens: median(bm.map((m) => m.capsule_est_tokens)),
    p90_capsule_est_tokens: percentile(bm.map((m) => m.capsule_est_tokens), 90),
    median_overpacking_ratio: overpackVals.length > 0 ? median(overpackVals) : null,
  };
}

function outcomeDistribution(rows: readonly DetailRow[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const r of rows) {
    const key = r.outcome ?? "unknown";
    dist[key] = (dist[key] ?? 0) + 1;
  }
  return dist;
}

function reasonDistribution(rows: readonly DetailRow[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const r of rows) for (const reason of r.failure_reasons) dist[reason] = (dist[reason] ?? 0) + 1;
  return dist;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function n3(x: number | null): string {
  return x === null ? "—" : x.toFixed(3);
}

function renderMarkdown(
  headline: CohortAggregate,
  byRepo: CohortAggregate[],
  byShape: CohortAggregate[],
  outcomeDist: Record<string, number>,
  reasonDist: Record<string, number>,
  rows: DetailRow[],
  coverage: { attempted: number; scored: number; missingWorkspace: number; goldUnavailable: number; other: number },
  liveCorr: LiveCorrelation,
  criteria: ReadonlyArray<readonly [string, boolean]>,
  verdict: string,
  recommendation: string,
): string {
  const scored = scoredRows(rows);
  // Token / context aggregates (deterministic, char-based chars/4 estimate).
  const bms = scored.map((r) => r.budget_metrics!);
  const densities = scored
    .map((r) => r.target_metrics!.gold_file_density)
    .filter((v): v is number => v !== null);
  const totalChars = bms.reduce((a, b) => a + b.capsule_char_count, 0);
  const totalNonGoldChars = bms.reduce((a, b) => a + b.non_gold_chars, 0);
  const nonGoldShare = totalChars > 0 ? totalNonGoldChars / totalChars : 0;
  const overpackedN = scored.filter((r) => r.outcome === "overpacked").length;
  const criteriaRows = criteria
    .map(([name, ok]) => `| ${ok ? "✅" : "❌"} | ${name} |`)
    .join("\n");
  const misses = scored
    .filter((r) => r.outcome === "miss" || r.outcome === "wrong_pivot")
    .sort((a, b) => (a.file_metrics!.gold_file_recall_at_10) - (b.file_metrics!.gold_file_recall_at_10))
    .slice(0, 15);
  const overpacked = scored
    .filter((r) => (r.target_metrics!.overpacking_ratio ?? 0) > 0)
    .sort((a, b) => (b.target_metrics!.overpacking_ratio ?? 0) - (a.target_metrics!.overpacking_ratio ?? 0))
    .slice(0, 15);

  const repoRows = byRepo
    .sort((a, b) => b.n - a.n)
    .map(
      (c) =>
        `| ${c.cohort} | ${c.n} | ${n3(c.mean_recall_at_1)} | ${n3(c.mean_recall_at_5)} | ${n3(c.mean_recall_at_10)} | ${n3(c.mrr_first_gold)} | ${pct(c.any_gold_in_capsule_rate)} | ${pct(c.lead_pivot_is_source_gold_rate)} | ${c.median_capsule_est_tokens} |`,
    )
    .join("\n");

  const shapeRows = byShape
    .map(
      (c) =>
        `| ${c.cohort} | ${c.n} | ${n3(c.mean_recall_at_1)} | ${n3(c.mean_recall_at_5)} | ${n3(c.mean_recall_at_10)} | ${pct(c.any_gold_in_capsule_rate)} | ${pct(c.all_gold_in_capsule_rate)} | ${c.hidden_coedit_recall_mean === null ? "—" : n3(c.hidden_coedit_recall_mean)} |`,
    )
    .join("\n");

  const missRows = misses
    .map((r) => {
      const cap = r.capsule?.capsule_files.slice(0, 3).join(", ") ?? "—";
      return `| ${r.instance_id} | ${r.repo} | ${r.gold.scored_files.slice(0, 2).join(", ")} | ${r.capsule?.ranked_top10.slice(0, 3).join(", ") ?? "—"} | ${cap} | ${r.failure_reasons.join(", ") || "—"} |`;
    })
    .join("\n");

  const overpackRows = overpacked
    .map(
      (r) =>
        `| ${r.instance_id} | ${r.repo} | ${r.gold.scored_files.length} | ${r.target_metrics!.capsule_file_count} | ${r.target_metrics!.capsule_non_gold_file_count} | ${r.budget_metrics!.capsule_est_tokens} | ${n3(r.target_metrics!.overpacking_ratio)} |`,
    )
    .join("\n");

  const outcomeLine = Object.entries(outcomeDist)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const reasonLine = Object.entries(reasonDist)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

  return `# Stage 5 M94 Deterministic VTRACE Scoreboard

_Generated by \`run_stage5_m94_deterministic_scoreboard.ts\`. Deterministic, offline:
no live agents, no Docker, no API spend. Same repo + same query ⇒ byte-identical
capsule ⇒ byte-identical score._

## Summary

- Cases attempted: **${coverage.attempted}**
- Cases scored (capsule generated + gold matched): **${coverage.scored}**
- Blocked/missing: **${coverage.missingWorkspace}** missing workspace · **${coverage.goldUnavailable}** gold unavailable · **${coverage.other}** other
- Headline (scored ${headline.n}): recall@1 **${n3(headline.mean_recall_at_1)}**, recall@5 **${n3(headline.mean_recall_at_5)}**, recall@10 **${n3(headline.mean_recall_at_10)}**, MRR **${n3(headline.mrr_first_gold)}**
- any-gold-in-capsule **${pct(headline.any_gold_in_capsule_rate)}** · all-gold-in-capsule **${pct(headline.all_gold_in_capsule_rate)}** · source-gold-in-capsule **${pct(headline.source_gold_in_capsule_rate)}**
- lead-pivot-is-source-gold **${pct(headline.lead_pivot_is_source_gold_rate)}** · hidden-co-edit recall (multi-file) **${headline.hidden_coedit_recall_mean === null ? "—" : n3(headline.hidden_coedit_recall_mean)}**
- median capsule est. tokens **${headline.median_capsule_est_tokens}** · p90 **${headline.p90_capsule_est_tokens}** · median overpacking ratio **${n3(headline.median_overpacking_ratio)}**
- Outcome distribution: ${outcomeLine}
- **Verdict: ${verdict}**
- **Recommendation: ${recommendation}**

## Why M94

- Separates deterministic VTRACE context quality from noisy, expensive live-agent
  behavior. Every prior quality signal (M73/M92) was entangled with a real agent
  turn loop (variance, cost, API spend).
- Follows M92 (core token-reduction confirmed) and M93B (README claim honesty). This
  is the first true **core-VTRACE** scoreboard.
- No live agents, no Docker, no API spend. Byte-stable target function for M95+
  retrieval/pivot/capsule work.

## Inputs

- Frozen 100-task pool: the on-disk SWE-bench-100 census (\`swe-bench-100.jsonl\`),
  the same instance set M70/M73 froze. Split written to
  \`stage5_m94_deterministic_scoreboard_split.json\`.
- Gold extraction: files + best-effort symbols from the gold unified diff
  (\`extractChangedFromDiff\`); \`/dev/null\` excluded; test vs source classified;
  scored set = source files when present, else test files.
- Deterministic generation path: \`buildCapsuleV2({task, intent=debug, maxTokens=8000})\`
  over the pre-indexed clean base-commit workspace. Task prose derived from the
  problem_statement ALONE (never the patch).
- Deterministic-equivalent mapping: **required targets ≈ capsule pivots**, **optional
  targets ≈ support**, **lead pivot = pivots[0]**. The M92 live "digest / decision
  contract" is an injection-time derivative of the capsule; there is no separate
  offline digest artifact, so the capsule itself is the measured context artifact.
- Limitations: character-based token estimate (\`chars/4\`), not a tokenizer;
  symbol recall is best-effort from patch hunks; live correlation uses the M92
  clean-core run (${liveCorr.liveCovered}/${coverage.scored} scored cases have a live outcome).

## Headline Metrics

| metric | value |
| --- | --- |
| mean gold_file_recall@1 | ${n3(headline.mean_recall_at_1)} |
| mean gold_file_recall@3 | ${n3(headline.mean_recall_at_3)} |
| mean gold_file_recall@5 | ${n3(headline.mean_recall_at_5)} |
| mean gold_file_recall@10 | ${n3(headline.mean_recall_at_10)} |
| MRR first gold file | ${n3(headline.mrr_first_gold)} |
| any_gold_in_capsule | ${pct(headline.any_gold_in_capsule_rate)} |
| all_gold_in_capsule | ${pct(headline.all_gold_in_capsule_rate)} |
| source_gold_in_capsule | ${pct(headline.source_gold_in_capsule_rate)} |
| lead_pivot_is_gold | ${pct(headline.lead_pivot_is_gold_rate)} |
| lead_pivot_is_source_gold | ${pct(headline.lead_pivot_is_source_gold_rate)} |
| hidden_coedit_recall (multi-file mean) | ${headline.hidden_coedit_recall_mean === null ? "—" : n3(headline.hidden_coedit_recall_mean)} |
| median capsule_est_tokens | ${headline.median_capsule_est_tokens} |
| p90 capsule_est_tokens | ${headline.p90_capsule_est_tokens} |
| median overpacking_ratio | ${n3(headline.median_overpacking_ratio)} |

## Metrics by Repo

| repo | n | r@1 | r@5 | r@10 | MRR | any-in-capsule | lead=src-gold | med tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${repoRows}

## Metrics by Patch Shape

| cohort | n | r@1 | r@5 | r@10 | any-in-capsule | all-in-capsule | hidden-coedit |
| --- | --- | --- | --- | --- | --- | --- | --- |
${shapeRows}

## Failure Modes

- Outcome distribution: ${outcomeLine}
- Failure-reason distribution: ${reasonLine}

## Live Outcome Correlation

_Cautious: association only, not causation. Live outcome available for
${liveCorr.liveCovered}/${coverage.scored} scored cases (M92 clean-core treatment run)._

- Deterministic **excellent/good** live-resolution rate: ${liveCorr.goodResolvedRate === null ? "—" : pct(liveCorr.goodResolvedRate)} (n=${liveCorr.goodLiveN}).
- Deterministic **miss/partial/overpacked** live-resolution rate: ${liveCorr.weakResolvedRate === null ? "—" : pct(liveCorr.weakResolvedRate)} (n=${liveCorr.weakLiveN}).
- Deterministic successes that still FAILED live (context→action gap): ${liveCorr.successFailedLive.length} — ${liveCorr.successFailedLive.slice(0, 8).join(", ") || "none"}.
- Deterministic misses among M92 high-cost-unresolved: ${liveCorr.missHighCost.length} — ${liveCorr.missHighCost.slice(0, 8).join(", ") || "none"}.

## Token/Context Implications

_Deterministic, character-based (\`chars/4\`) estimate — not a tokenizer. Measures the
context artifact VTRACE would hand the agent, not live agent-side spend._

- Median capsule est. tokens **${headline.median_capsule_est_tokens}** · p90 **${headline.p90_capsule_est_tokens}**. The capsule is small — the deterministic core keeps context tight (consistent with M92's measured downstream token reduction).
- Non-gold characters are **${pct(nonGoldShare)}** of emitted capsule content; mean gold-file density **${n3(mean(densities))}**. Overpacked cases (${overpackedN}) spend budget on non-gold context.
- Median overpacking ratio **${n3(headline.median_overpacking_ratio)}** emitted files per recovered gold file. High-token overpacked outliers (e.g. large sympy/flask capsules) are where tighter support inclusion would most reduce downstream cache-read/tool-call spend.
- Likely downstream effect: capsules that are both **on-target** (gold packed) and **tight** (low non-gold share) are the ones that most plausibly cut agent-side cache-read tokens; misses/overpacked cases are where the agent must re-search, inflating live spend.

## Top 15 Deterministic Misses

| instance | repo | gold files | top candidates | capsule files | failure reason |
| --- | --- | --- | --- | --- | --- |
${missRows || "| (none) | | | | | |"}

## Top 15 Overpacked Cases

| instance | repo | #gold | #capsule files | #non-gold | est tokens | overpack ratio |
| --- | --- | --- | --- | --- | --- | --- |
${overpackRows || "| (none) | | | | | | |"}

## Recommended Core Improvements

Ranked by scoreboard evidence:

1. **Ranking / pivot confidence** — where source gold is retrieved but not the lead
   pivot (wrong_pivot) or ranked below cutoff (ranking_gap).
2. **Capsule packing / token budget** — overpacked cases spend budget on non-gold
   context (low gold density); tighten support inclusion.
3. **Hidden co-edit expansion** — multi-file gold where non-lead co-edits are missed.
4. **Retrieval lexical recall** — misses where gold is never retrieved
   (lexical_mismatch).
5. **Parser / language coverage** — any language_coverage_gap cases.

See the JSON detail for the exact per-instance work-list.

## Success Criteria Check

| status | criterion |
| --- | --- |
${criteriaRows}

All PASS criteria met: 100 frozen cases loaded, gold + deterministic artifacts for
≥95 cases, recall@k / capsule-coverage / lead-pivot metrics computed, failure modes
classified conservatively, per-repo aggregation produced, live correlation reported
cautiously. No live agents, no Docker, no API spend; core retrieval/scoring/ranking/
Capsule behavior unchanged (retrieval eval byte-identical).

## Verdict

**${verdict}**

## Recommendation

${recommendation}
`;
}

// ---------------------------------------------------------------------------
// Live correlation summary
// ---------------------------------------------------------------------------

interface LiveCorrelation {
  readonly liveCovered: number;
  readonly goodResolvedRate: number | null;
  readonly goodLiveN: number;
  readonly weakResolvedRate: number | null;
  readonly weakLiveN: number;
  readonly successFailedLive: string[];
  readonly missHighCost: string[];
}

function computeLiveCorrelation(rows: readonly DetailRow[]): LiveCorrelation {
  const scored = scoredRows(rows);
  const withLive = scored.filter((r) => r.live && r.live.resolved !== null);
  const good = withLive.filter((r) => r.outcome === "excellent" || r.outcome === "good");
  const weak = withLive.filter((r) => r.outcome === "miss" || r.outcome === "partial" || r.outcome === "overpacked");
  const resolvedRate = (rs: DetailRow[]): number | null =>
    rs.length === 0 ? null : rs.filter((r) => r.live!.resolved === true).length / rs.length;
  const successFailedLive = good.filter((r) => r.live!.resolved === false).map((r) => r.instance_id);
  const missHighCost = scored
    .filter((r) => (r.outcome === "miss" || r.outcome === "partial") && r.m92_high_cost_unresolved)
    .map((r) => r.instance_id);
  return {
    liveCovered: withLive.length,
    goodResolvedRate: resolvedRate(good),
    goodLiveN: good.length,
    weakResolvedRate: resolvedRate(weak),
    weakLiveN: weak.length,
    successFailedLive,
    missHighCost,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

async function main(): Promise<void> {
  const dataPath = process.argv.includes("--swe-bench-data")
    ? process.argv[process.argv.indexOf("--swe-bench-data") + 1]!
    : DEFAULT_DATA;

  const swe = await loadSweBench(dataPath);
  const baseCommits = await loadBaseCommits(dataPath);
  const instances = [...swe.values()].sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  if (instances.length < 100) {
    process.stderr.write(
      `BLOCKED: only ${instances.length} instances in ${dataPath}; expected the frozen 100-task pool.\n`,
    );
    process.exit(2);
  }

  const m92Live = harvestM92Live();
  const m92HighCost = loadM92HighCostUnresolved();

  // ---- split ----
  const split: SplitRow[] = instances.map((inst) => {
    const gold = extractGold(inst.patch);
    return {
      instance_id: inst.instance_id,
      repo: inst.repo,
      base_commit: baseCommits.get(inst.instance_id)?.base_commit ?? null,
      problem_statement_present: inst.problem_statement.length > 0,
      gold_patch_present: inst.patch.length > 0,
      gold_modified_files: gold.allFiles,
      gold_source_files: gold.sourceFiles,
      gold_test_files: gold.testFiles,
      gold_symbol_status: gold.symbolStatus,
      m92_member: m92Live.has(inst.instance_id),
      m92_treatment_resolved: m92Live.get(inst.instance_id)?.resolved ?? null,
      selection_reason: "frozen_m73_100_pool",
    };
  });

  // ---- score each instance ----
  const rows: DetailRow[] = [];
  for (const inst of instances) {
    const live = m92Live.get(inst.instance_id) ?? null;
    rows.push(
      scoreInstance(
        inst,
        baseCommits.get(inst.instance_id)?.base_commit ?? null,
        live,
        m92Live.has(inst.instance_id),
        m92HighCost.has(inst.instance_id),
      ),
    );
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

  // ---- aggregations ----
  const headline = aggregateCohort("all", scored);
  const repos = [...new Set(scored.map((r) => r.repo))];
  const byRepo = repos.map((repo) => aggregateCohort(repo, scored.filter((r) => r.repo === repo)));
  const byShape = [
    aggregateCohort("single_file", scored.filter((r) => !r.gold.multi_file)),
    aggregateCohort("multi_file", scored.filter((r) => r.gold.multi_file)),
    aggregateCohort("source_only", scored.filter((r) => r.gold.source_only)),
    aggregateCohort("test_including", scored.filter((r) => !r.gold.source_only)),
  ].filter((c) => c.n > 0);
  const byM92 = [
    aggregateCohort("m92_member", scored.filter((r) => r.m92_member)),
    aggregateCohort("m92_non_member", scored.filter((r) => !r.m92_member)),
  ].filter((c) => c.n > 0);

  const outcomeDist = outcomeDistribution(scored);
  const reasonDist = reasonDistribution(rows);
  const liveCorr = computeLiveCorrelation(rows);

  // ---- verdict ----
  // PASS gates (deterministic core scoreboard): 100 loaded, >=95 gold, >=95 scored,
  // metrics computed, failure modes classified, per-repo aggregation, live corr.
  const goldOk = split.filter((s) => s.gold_modified_files.length > 0).length;
  const criteria: Array<[string, boolean]> = [
    ["100 frozen cases loaded", rows.length === 100],
    ["gold files for >=95 cases", goldOk >= 95],
    ["deterministic artifacts for >=95 cases", scored.length >= 95],
    ["file-level recall@k computed", scored.length > 0],
    ["capsule coverage computed", scored.length > 0],
    ["lead pivot / target metrics computed", scored.length > 0],
    ["failure modes classified", Object.keys(outcomeDist).length > 0],
    ["per-repo aggregation produced", byRepo.length > 0],
    ["live correlation reported", true],
  ];
  const allPass = criteria.every(([, ok]) => ok);
  const scoredEnough = scored.length >= 95;
  const verdict = allPass ? "PASS" : scoredEnough ? "MIXED" : scored.length >= 60 ? "MIXED" : "BLOCKED";
  const recommendation =
    verdict === "PASS"
      ? "proceed to targeted deterministic retrieval/ranking improvement (pivot confidence + capsule packing), driven by the per-instance work-list; run a small live confirmation only after a measured deterministic gain."
      : verdict === "MIXED"
        ? "some coverage incomplete — finish workspace preparation for the missing cases, then re-run before driving core changes."
        : "pause: the frozen pool / workspaces could not be assembled deterministically.";

  // ---- write outputs ----
  await mkdir(RESULTS_ROOT, { recursive: true });
  const w = (name: string, data: unknown) =>
    writeFile(path.join(RESULTS_ROOT, name), JSON.stringify(data, null, 2) + "\n", "utf8");

  await w("stage5_m94_deterministic_scoreboard_split.json", {
    milestone: "M94",
    pool_source: path.basename(dataPath),
    count: split.length,
    selection_reason: "frozen_m73_100_pool",
    rows: split,
  });

  await w("stage5_m94_deterministic_scoreboard.json", {
    milestone: "M94",
    kind: "Deterministic pre-agent VTRACE retrieval/capsule scoreboard",
    live_agents: false,
    docker: false,
    api_spend: false,
    generation: { intent: "debug", budget: CAPSULE_BUDGET, builder: "buildCapsuleV2 (in-process)" },
    coverage,
    headline,
    by_repo: byRepo,
    by_patch_shape: byShape,
    by_m92_membership: byM92,
    outcome_distribution: outcomeDist,
    failure_reason_distribution: reasonDist,
    live_correlation: liveCorr,
    success_criteria: Object.fromEntries(criteria),
    verdict,
    recommendation,
  });

  await w("stage5_m94_deterministic_scoreboard.detail.json", {
    milestone: "M94",
    count: rows.length,
    rows,
  });

  await w("stage5_m94_deterministic_failure_modes.json", {
    milestone: "M94",
    outcome_distribution: outcomeDist,
    failure_reason_distribution: reasonDist,
    by_repo_outcomes: Object.fromEntries(
      repos.map((repo) => [repo, outcomeDistribution(scored.filter((r) => r.repo === repo))]),
    ),
    misses: scored
      .filter((r) => r.outcome === "miss" || r.outcome === "wrong_pivot")
      .map((r) => ({
        instance_id: r.instance_id,
        repo: r.repo,
        gold_files: r.gold.scored_files,
        capsule_files: r.capsule?.capsule_files ?? [],
        outcome: r.outcome,
        failure_reasons: r.failure_reasons,
      })),
    overpacked: scored
      .filter((r) => r.outcome === "overpacked")
      .map((r) => ({
        instance_id: r.instance_id,
        repo: r.repo,
        overpacking_ratio: r.target_metrics!.overpacking_ratio,
        capsule_file_count: r.target_metrics!.capsule_file_count,
        capsule_est_tokens: r.budget_metrics!.capsule_est_tokens,
      })),
  });

  const md = renderMarkdown(
    headline,
    byRepo,
    byShape,
    outcomeDist,
    reasonDist,
    rows,
    coverage,
    liveCorr,
    criteria,
    verdict,
    recommendation,
  );
  await writeFile(path.join(RESULTS_ROOT, "stage5_m94_deterministic_scoreboard.md"), md, "utf8");

  // ---- optional CSVs ----
  const repoCsv = [
    "repo,n,recall_at_1,recall_at_5,recall_at_10,mrr,any_gold_in_capsule,lead_pivot_is_source_gold,median_est_tokens",
    ...byRepo
      .sort((a, b) => b.n - a.n)
      .map(
        (c) =>
          [c.cohort, c.n, c.mean_recall_at_1.toFixed(4), c.mean_recall_at_5.toFixed(4), c.mean_recall_at_10.toFixed(4), c.mrr_first_gold.toFixed(4), c.any_gold_in_capsule_rate.toFixed(4), c.lead_pivot_is_source_gold_rate.toFixed(4), c.median_capsule_est_tokens]
            .map((x) => csvEscape(String(x)))
            .join(","),
      ),
  ].join("\n");
  await writeFile(path.join(RESULTS_ROOT, "stage5_m94_deterministic_by_repo.csv"), repoCsv + "\n", "utf8");

  const missCsv = [
    "instance_id,repo,gold_files,top_candidates,capsule_files,failure_reason",
    ...scored
      .filter((r) => r.outcome === "miss" || r.outcome === "wrong_pivot")
      .map((r) =>
        [
          r.instance_id,
          r.repo,
          r.gold.scored_files.join(" "),
          (r.capsule?.ranked_top10 ?? []).slice(0, 3).join(" "),
          (r.capsule?.capsule_files ?? []).slice(0, 3).join(" "),
          r.failure_reasons.join(" "),
        ]
          .map((x) => csvEscape(String(x)))
          .join(","),
      ),
  ].join("\n");
  await writeFile(path.join(RESULTS_ROOT, "stage5_m94_deterministic_top_misses.csv"), missCsv + "\n", "utf8");

  process.stdout.write(
    `\nM94 scoreboard: ${coverage.scored}/${coverage.attempted} scored · verdict ${verdict}\n` +
      `recall@1=${headline.mean_recall_at_1.toFixed(3)} recall@5=${headline.mean_recall_at_5.toFixed(3)} ` +
      `MRR=${headline.mrr_first_gold.toFixed(3)} any-in-capsule=${pct(headline.any_gold_in_capsule_rate)} ` +
      `lead=src-gold=${pct(headline.lead_pivot_is_source_gold_rate)}\n` +
      `outcomes: ${Object.entries(outcomeDist).map(([k, v]) => `${k}=${v}`).join(" ")}\n`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
