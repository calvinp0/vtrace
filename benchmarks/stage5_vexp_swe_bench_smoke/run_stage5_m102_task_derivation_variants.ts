// Stage 5 M102 — task-derivation variant scoreboard: runner.
//
// Rebuilds every M101-scored capsule once per benchmark-only task-text variant
// (see `stage5_m102_task_variants.ts`) and scores each build with the same
// M94-lib metrics as the M94–M101 scoreboards. PRODUCT BEHAVIOUR IS UNCHANGED:
// the only lever is the caller-supplied `task` string that `buildCapsuleV2`
// has always accepted.
//
// Gold-leakage handling: the M94 guard blocks a case when a gold PATH appears
// in the task. For V0 that semantics is kept (parity with M101). For longer
// variants the task text is a verbatim slice/extraction of the PROBLEM
// STATEMENT — when the issue author wrote the gold path, that is legitimate
// evidence, not contamination (the gold patch is never read during
// generation). Those cases stay scored and are counted per-variant as
// `gold_path_in_task` so the effect is auditable.
//
// NO Claude, NO Docker, NO agent run, NO API calls, NO live network.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent, CapsuleV2Mode, type CapsuleV2Result } from "../../src/capsuleV2/types";

import { loadSweBench, type SweBenchInstance } from "./build_stage5_retrieval_fixture";
import {
  expectedFilesAreUnparsedLanguage,
  summarizeCapsule,
} from "./run_stage5_retrieval_eval";
import {
  assertNoGoldLeakage,
  capsuleFilesOf,
  classify,
  computeFileMetrics,
  computeTargetMetrics,
  extractGold,
  mean,
  median,
  percentile,
  rate,
  type FileMetrics,
  type Outcome,
  type TargetMetrics,
} from "./stage5_m94_lib";
import {
  buildTaskVariant,
  M102_VARIANT_NAMES,
  type M102VariantName,
} from "./stage5_m102_task_variants";

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

// --- per-(variant, case) row ---------------------------------------------------

interface VariantCaseRow {
  readonly variant: M102VariantName;
  readonly instance_id: string;
  readonly repo: string;
  readonly cohort: "dev" | "holdout";
  readonly status: "scored" | "blocked" | "error";
  readonly status_detail: string | null;
  readonly task_chars: number;
  readonly gold_path_in_task: boolean;
  readonly outcome: Outcome | null;
  readonly lead_pivot_file: string | null;
  readonly capsule_est_tokens: number | null;
  readonly fm: FileMetrics | null;
  readonly tm: TargetMetrics | null;
  readonly multi_file: boolean;
}

function scoreVariantCase(
  variant: M102VariantName,
  inst: SweBenchInstance,
  cohort: "dev" | "holdout",
): VariantCaseRow {
  const gold = extractGold(inst.patch);
  const v = buildTaskVariant(variant, inst.problem_statement);
  const base = {
    variant,
    instance_id: inst.instance_id,
    repo: inst.repo,
    cohort,
    task_chars: v.text.length,
    lead_pivot_file: null,
    capsule_est_tokens: null,
    fm: null,
    tm: null,
    multi_file: gold.multiFile,
  };
  const leak = assertNoGoldLeakage(v.text, gold);
  // V0 keeps M101 blocking semantics for exact parity; longer variants record
  // the (issue-authored) gold path as a diagnostic and stay scored.
  if (leak !== null && variant === "V0_current") {
    return { ...base, status: "blocked", status_detail: `gold path in task: ${leak}`, gold_path_in_task: true, outcome: null };
  }
  const workspace = resolveCleanWorkspace(inst.instance_id);
  if (workspace === null) {
    return { ...base, status: "error", status_detail: "missing workspace", gold_path_in_task: leak !== null, outcome: null };
  }
  let result: CapsuleV2Result;
  const db = openIndexerDatabase(path.join(workspace, INDEX_RELPATH));
  try {
    result = buildCapsuleV2({
      db, repoRoot: workspace, task: v.text, intent: CapsuleIntent.Debug, maxTokens: CAPSULE_BUDGET,
    });
  } catch (error) {
    db.close();
    return {
      ...base, status: "error",
      status_detail: error instanceof Error ? error.message : String(error),
      gold_path_in_task: leak !== null, outcome: null,
    };
  }
  db.close();
  const summary = summarizeCapsule(result);
  const cf = capsuleFilesOf(summary);
  const fm = computeFileMetrics(summary, gold, cf);
  const tm = computeTargetMetrics(gold, cf);
  const zeroRequired = summary.pivots.length === 0 || result.actual_mode === CapsuleV2Mode.NoContext;
  const unparsedLanguageGold = expectedFilesAreUnparsedLanguage(gold.scoredFiles);
  const cls = classify(gold, fm, tm, { unparsedLanguageGold, zeroRequired });
  return {
    ...base,
    status: "scored",
    status_detail: null,
    gold_path_in_task: leak !== null,
    outcome: cls.outcome,
    lead_pivot_file: cf.leadPivotFile,
    capsule_est_tokens: summary.estimatedTokens,
    fm,
    tm,
  };
}

// --- aggregation -----------------------------------------------------------------

interface VariantAggregate {
  readonly variant: string;
  readonly subset: string;
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
  readonly gold_file_in_required: number;
  readonly wrong_pivot_count: number;
  readonly hidden_coedit_recall: number | null;
  readonly multi_file_all_gold_in_capsule: number | null;
  readonly outcomes: Record<string, number>;
  readonly overpacked_count: number;
  readonly median_capsule_est_tokens: number;
  readonly p90_capsule_est_tokens: number;
  readonly mean_capsule_file_count: number;
  readonly task_text_median_chars: number;
  readonly task_text_p90_chars: number;
  readonly gold_path_in_task_count: number;
}

function aggregate(variant: string, subset: string, rows: readonly VariantCaseRow[]): VariantAggregate {
  const scored = rows.filter((r) => r.status === "scored" && r.fm && r.tm);
  const fm = scored.map((r) => r.fm!);
  const tm = scored.map((r) => r.tm!);
  const hidden = fm.map((m) => m.hidden_coedit_recall).filter((v): v is number => v !== null);
  const multi = scored.filter((r) => r.multi_file);
  const outcomes: Record<string, number> = {};
  for (const r of scored) outcomes[r.outcome ?? "unknown"] = (outcomes[r.outcome ?? "unknown"] ?? 0) + 1;
  return {
    variant,
    subset,
    n: scored.length,
    recall_at_1: mean(fm.map((m) => m.gold_file_recall_at_1)),
    recall_at_3: mean(fm.map((m) => m.gold_file_recall_at_3)),
    recall_at_5: mean(fm.map((m) => m.gold_file_recall_at_5)),
    recall_at_10: mean(fm.map((m) => m.gold_file_recall_at_10)),
    mrr: mean(fm.map((m) => m.mrr_first_gold_file)),
    any_gold_in_capsule: rate(fm.map((m) => m.any_gold_in_capsule)),
    all_gold_in_capsule: rate(fm.map((m) => m.all_gold_in_capsule)),
    source_gold_in_capsule: rate(fm.map((m) => m.source_gold_in_capsule)),
    lead_pivot_is_source_gold: rate(fm.map((m) => m.lead_pivot_is_source_gold)),
    gold_file_in_required: rate(tm.map((m) => m.gold_file_in_required)),
    wrong_pivot_count: outcomes["wrong_pivot"] ?? 0,
    hidden_coedit_recall: hidden.length > 0 ? mean(hidden) : null,
    multi_file_all_gold_in_capsule:
      multi.length > 0 ? rate(multi.map((r) => r.fm!.all_gold_in_capsule)) : null,
    outcomes,
    overpacked_count: outcomes["overpacked"] ?? 0,
    median_capsule_est_tokens: median(scored.map((r) => r.capsule_est_tokens ?? 0)),
    p90_capsule_est_tokens: percentile(scored.map((r) => r.capsule_est_tokens ?? 0), 90),
    mean_capsule_file_count: mean(tm.map((m) => m.capsule_file_count)),
    task_text_median_chars: median(rows.map((r) => r.task_chars)),
    task_text_p90_chars: percentile(rows.map((r) => r.task_chars), 90),
    gold_path_in_task_count: rows.filter((r) => r.gold_path_in_task).length,
  };
}

// --- win/loss classification -------------------------------------------------------

const WIN_TYPES = [
  "gold_enters_top5", "gold_enters_capsule", "lead_becomes_source_gold",
  "required_becomes_gold", "wrong_pivot_fixed", "miss_improved",
] as const;
const LOSS_TYPES = [
  "gold_leaves_top5", "gold_leaves_capsule", "lead_source_gold_lost",
  "required_gold_lost", "all_gold_lost", "overpacked_introduced", "wrong_pivot_introduced",
] as const;

function classifyChanges(v0: VariantCaseRow, v: VariantCaseRow): { wins: string[]; losses: string[] } {
  const wins: string[] = [];
  const losses: string[] = [];
  if (v0.status !== "scored" || v.status !== "scored" || !v0.fm || !v.fm || !v0.tm || !v.tm) {
    return { wins, losses };
  }
  const f0 = v0.fm; const f1 = v.fm; const t0 = v0.tm; const t1 = v.tm;
  if (!f0.any_gold_in_top_5 && f1.any_gold_in_top_5) wins.push("gold_enters_top5");
  if (f0.any_gold_in_top_5 && !f1.any_gold_in_top_5) losses.push("gold_leaves_top5");
  if (!f0.any_gold_in_capsule && f1.any_gold_in_capsule) wins.push("gold_enters_capsule");
  if (f0.any_gold_in_capsule && !f1.any_gold_in_capsule) losses.push("gold_leaves_capsule");
  if (!f0.lead_pivot_is_source_gold && f1.lead_pivot_is_source_gold) wins.push("lead_becomes_source_gold");
  if (f0.lead_pivot_is_source_gold && !f1.lead_pivot_is_source_gold) losses.push("lead_source_gold_lost");
  if (!t0.gold_file_in_required && t1.gold_file_in_required) wins.push("required_becomes_gold");
  if (t0.gold_file_in_required && !t1.gold_file_in_required) losses.push("required_gold_lost");
  if (f0.all_gold_in_capsule && !f1.all_gold_in_capsule) losses.push("all_gold_lost");
  if (v0.outcome === "wrong_pivot" && v.outcome !== "wrong_pivot" && f1.any_gold_in_capsule) {
    wins.push("wrong_pivot_fixed");
  }
  if (v0.outcome !== "wrong_pivot" && v.outcome === "wrong_pivot") losses.push("wrong_pivot_introduced");
  if (v0.outcome === "miss" && (v.outcome === "partial" || v.outcome === "good" || v.outcome === "excellent")) {
    wins.push("miss_improved");
  }
  if (v0.outcome !== "overpacked" && v.outcome === "overpacked") losses.push("overpacked_introduced");
  return { wins, losses };
}

// --- main ---------------------------------------------------------------------------

interface SplitFile { readonly dev: string[]; readonly holdout: string[]; }
function csvEscape(v: string): string { return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }

async function main(): Promise<void> {
  const dataPath = process.argv.includes("--swe-bench-data")
    ? process.argv[process.argv.indexOf("--swe-bench-data") + 1]!
    : DEFAULT_DATA;
  const variantArgIdx = process.argv.indexOf("--variants");
  const variantNames: M102VariantName[] = variantArgIdx !== -1
    ? process.argv[variantArgIdx + 1]!.split(",") as M102VariantName[]
    : [...M102_VARIANT_NAMES];

  const swe = await loadSweBench(dataPath);
  const split = JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m95_dev_holdout_split.json"), "utf8")) as SplitFile;
  const devSet = new Set(split.dev);

  const m101 = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m101_deterministic_scoreboard.detail.json"), "utf8"),
  ) as { rows: Array<{ instance_id: string; generation_status: string; outcome: string | null; failure_reasons: string[] }> };
  const scoredIds = m101.rows.filter((r) => r.generation_status === "scored").map((r) => r.instance_id).sort();
  const m101ById = new Map(m101.rows.map((r) => [r.instance_id, r] as const));

  const evidenceAudit = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m102_task_derivation_gap_audit.json"), "utf8"),
  ) as { cases: Array<{ instance_id: string; has_evidence_beyond_v0: boolean }> };
  const beyondIds = new Set(evidenceAudit.cases.filter((c) => c.has_evidence_beyond_v0).map((c) => c.instance_id));

  const rows: VariantCaseRow[] = [];
  for (const variant of variantNames) {
    for (const id of scoredIds) {
      const inst = swe.get(id);
      if (inst === undefined) continue;
      const row = scoreVariantCase(variant, inst, devSet.has(id) ? "dev" : "holdout");
      rows.push(row);
    }
    const done = rows.filter((r) => r.variant === variant);
    process.stdout.write(
      `${variant}: scored ${done.filter((r) => r.status === "scored").length}/${done.length}` +
      ` | wrong_pivot ${done.filter((r) => r.outcome === "wrong_pivot").length}` +
      ` | miss ${done.filter((r) => r.outcome === "miss").length}` +
      ` | goldPathInTask ${done.filter((r) => r.gold_path_in_task).length}\n`,
    );
  }

  // Parity check: this runner's V0 outcomes must match the frozen M101 rows.
  const v0Rows = rows.filter((r) => r.variant === "V0_current");
  const v0ById = new Map(v0Rows.map((r) => [r.instance_id, r] as const));
  const parityMismatches = v0Rows
    .filter((r) => (m101ById.get(r.instance_id)?.outcome ?? null) !== r.outcome)
    .map((r) => ({ instance_id: r.instance_id, m101: m101ById.get(r.instance_id)?.outcome ?? null, v0: r.outcome }));

  // Cohort id sets (from frozen M101 rows).
  const missIds = new Set(m101.rows.filter((r) => r.outcome === "miss").map((r) => r.instance_id));
  const wrongPivotIds = new Set(m101.rows.filter((r) => r.outcome === "wrong_pivot").map((r) => r.instance_id));
  const lexicalIds = new Set(
    m101.rows.filter((r) => r.failure_reasons.includes("lexical_mismatch")).map((r) => r.instance_id),
  );

  const subsets: Array<{ name: string; filter: (r: VariantCaseRow) => boolean }> = [
    { name: "all", filter: () => true },
    { name: "dev", filter: (r) => r.cohort === "dev" },
    { name: "holdout", filter: (r) => r.cohort === "holdout" },
    { name: "m101_misses", filter: (r) => missIds.has(r.instance_id) },
    { name: "m101_wrong_pivot", filter: (r) => wrongPivotIds.has(r.instance_id) },
    { name: "m101_lexical_mismatch", filter: (r) => lexicalIds.has(r.instance_id) },
    { name: "evidence_beyond_v0", filter: (r) => beyondIds.has(r.instance_id) },
    { name: "no_evidence_beyond_v0", filter: (r) => !beyondIds.has(r.instance_id) },
  ];

  const aggregates: VariantAggregate[] = [];
  for (const variant of variantNames) {
    const vr = rows.filter((r) => r.variant === variant);
    for (const s of subsets) aggregates.push(aggregate(variant, s.name, vr.filter(s.filter)));
  }

  // Win/loss vs V0.
  interface ChangeRow {
    variant: string; instance_id: string; cohort: string; repo: string;
    wins: string[]; losses: string[];
    v0_outcome: string | null; outcome: string | null;
    v0_lead: string | null; lead: string | null; task_chars: number;
  }
  const changes: ChangeRow[] = [];
  for (const r of rows) {
    if (r.variant === "V0_current") continue;
    const v0 = v0ById.get(r.instance_id);
    if (v0 === undefined) continue;
    const { wins, losses } = classifyChanges(v0, r);
    if (wins.length === 0 && losses.length === 0) continue;
    changes.push({
      variant: r.variant, instance_id: r.instance_id, cohort: r.cohort, repo: r.repo,
      wins, losses, v0_outcome: v0.outcome, outcome: r.outcome,
      v0_lead: v0.lead_pivot_file, lead: r.lead_pivot_file, task_chars: r.task_chars,
    });
  }

  const winLoss = variantNames.filter((v) => v !== "V0_current").map((variant) => {
    const vc = changes.filter((c) => c.variant === variant);
    const grossWins = vc.reduce((a, c) => a + c.wins.length, 0);
    const grossLosses = vc.reduce((a, c) => a + c.losses.length, 0);
    const winEvents: Record<string, number> = {};
    const lossEvents: Record<string, number> = {};
    for (const c of vc) {
      for (const w of c.wins) winEvents[w] = (winEvents[w] ?? 0) + 1;
      for (const l of c.losses) lossEvents[l] = (lossEvents[l] ?? 0) + 1;
    }
    const casesWithWins = vc.filter((c) => c.wins.length > 0).length;
    const casesWithLosses = vc.filter((c) => c.losses.length > 0).length;
    return {
      variant,
      gross_wins: grossWins,
      gross_losses: grossLosses,
      cases_with_wins: casesWithWins,
      cases_with_losses: casesWithLosses,
      net_cases: casesWithWins - casesWithLosses,
      win_loss_ratio: grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0),
      win_events: winEvents,
      loss_events: lossEvents,
      dev: {
        cases_with_wins: vc.filter((c) => c.cohort === "dev" && c.wins.length > 0).length,
        cases_with_losses: vc.filter((c) => c.cohort === "dev" && c.losses.length > 0).length,
      },
      holdout: {
        cases_with_wins: vc.filter((c) => c.cohort === "holdout" && c.wins.length > 0).length,
        cases_with_losses: vc.filter((c) => c.cohort === "holdout" && c.losses.length > 0).length,
      },
    };
  });

  await mkdir(RESULTS_ROOT, { recursive: true });
  const w = (name: string, data: unknown) =>
    writeFile(path.join(RESULTS_ROOT, name), JSON.stringify(data, null, 2) + "\n", "utf8");

  await w("stage5_m102_task_derivation_variants.json", {
    milestone: "M102",
    kind: "Task-derivation variant scoreboard (benchmark-only task text; product behaviour unchanged)",
    live_agents: false, docker: false, api_spend: false,
    generation: { intent: "debug", budget: CAPSULE_BUDGET, builder: "buildCapsuleV2 (in-process)" },
    variants: variantNames,
    scored_id_count: scoredIds.length,
    v0_parity_mismatches: parityMismatches,
    leakage_note:
      "V0 keeps M101 blocking semantics; longer variants record issue-authored gold paths as gold_path_in_task instead of blocking (task text derives from the problem statement only).",
    aggregates,
    win_loss: winLoss,
  });
  await w("stage5_m102_task_derivation_variants.detail.json", { milestone: "M102", count: rows.length, rows });

  const repoCsvRows: string[] = ["variant,repo,n,recall_at_1,recall_at_5,mrr,any_gold_in_capsule,all_gold_in_capsule,lead_pivot_is_source_gold,gold_file_in_required,mean_capsule_files,median_est_tokens,overpacked"];
  for (const variant of variantNames) {
    const vr = rows.filter((r) => r.variant === variant);
    for (const repo of [...new Set(vr.map((r) => r.repo))].sort()) {
      const a = aggregate(variant, repo, vr.filter((r) => r.repo === repo));
      repoCsvRows.push([
        variant, repo, a.n, a.recall_at_1.toFixed(4), a.recall_at_5.toFixed(4), a.mrr.toFixed(4),
        a.any_gold_in_capsule.toFixed(4), a.all_gold_in_capsule.toFixed(4),
        a.lead_pivot_is_source_gold.toFixed(4), a.gold_file_in_required.toFixed(4),
        a.mean_capsule_file_count.toFixed(3), a.median_capsule_est_tokens, a.overpacked_count,
      ].map((x) => csvEscape(String(x))).join(","));
    }
  }
  await writeFile(path.join(RESULTS_ROOT, "stage5_m102_task_derivation_variants_by_repo.csv"), repoCsvRows.join("\n") + "\n", "utf8");

  const changeCsvRows = [
    "variant,instance_id,cohort,repo,wins,losses,v0_outcome,outcome,v0_lead,lead,task_chars",
    ...changes
      .sort((a, b) => a.variant.localeCompare(b.variant) || a.instance_id.localeCompare(b.instance_id))
      .map((c) => [
        c.variant, c.instance_id, c.cohort, c.repo, c.wins.join(" "), c.losses.join(" "),
        c.v0_outcome ?? "", c.outcome ?? "", c.v0_lead ?? "", c.lead ?? "", c.task_chars,
      ].map((x) => csvEscape(String(x))).join(",")),
  ];
  await writeFile(path.join(RESULTS_ROOT, "stage5_m102_task_derivation_variants_top_changes.csv"), changeCsvRows.join("\n") + "\n", "utf8");

  const fmt = (a: VariantAggregate) =>
    `${a.variant.padEnd(24)} ${a.subset.padEnd(22)} n=${a.n} r@1=${a.recall_at_1.toFixed(3)} r@5=${a.recall_at_5.toFixed(3)} any=${(a.any_gold_in_capsule * 100).toFixed(1)}% all=${(a.all_gold_in_capsule * 100).toFixed(1)}% lead=${(a.lead_pivot_is_source_gold * 100).toFixed(1)}% wp=${a.wrong_pivot_count} miss=${a.outcomes["miss"] ?? 0} op=${a.overpacked_count} files=${a.mean_capsule_file_count.toFixed(2)} medTok=${a.median_capsule_est_tokens} taskP90=${a.task_text_p90_chars}`;
  process.stdout.write("\n" + aggregates.filter((a) => ["all", "dev", "holdout"].includes(a.subset)).map(fmt).join("\n") + "\n");
  process.stdout.write(`\nV0 parity mismatches: ${parityMismatches.length === 0 ? "none" : JSON.stringify(parityMismatches)}\n`);
  for (const wl of winLoss) {
    process.stdout.write(
      `${wl.variant}: wins ${wl.gross_wins} (cases ${wl.cases_with_wins}) losses ${wl.gross_losses} (cases ${wl.cases_with_losses}) net ${wl.net_cases} | dev +${wl.dev.cases_with_wins}/-${wl.dev.cases_with_losses} hold +${wl.holdout.cases_with_wins}/-${wl.holdout.cases_with_losses}\n`,
    );
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
