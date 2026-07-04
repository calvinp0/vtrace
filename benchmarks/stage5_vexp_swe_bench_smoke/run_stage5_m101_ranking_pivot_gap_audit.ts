// Stage 5 M101 — ranking / lead-pivot gap audit (pre-change, read-only).
//
// M100 left lead_pivot_is_source_gold at 51.5% while source_gold_in_capsule sits
// at 75.8%: in ~24 cases VTRACE already HOLDS the right source file but does not
// lead with it (11 of them "wrong_pivot": gold present only as support). This
// audit rebuilds every scored capsule on the SAME generation path as the M94–M100
// scoreboards (gold is scoring-only, never fed into generation) and dumps, per
// case, the full evidence picture of the lead pivot versus the best-placed gold
// file — role, scorecard, evidence lines, structural role signals, lane
// provenance — so the narrowest safe pivot/ranking rule can be designed from
// data instead of anecdotes.
//
// NO Claude, NO Docker, NO agent run, NO API calls, NO live network.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent, type CapsuleV2Item, type CapsuleV2Result } from "../../src/capsuleV2/types";

import {
  deriveTaskFromProblemStatement,
  loadSweBench,
  type SweBenchInstance,
} from "./build_stage5_retrieval_fixture";
import { fileMatches, normalizeFilePath } from "./run_stage5_retrieval_eval";
import { assertNoGoldLeakage, extractGold, isTestFile } from "./stage5_m94_lib";

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

// --- per-item projection -------------------------------------------------------

type LeadType =
  | "test"
  | "docs_example"
  | "facade_init"
  | "generic_infra"
  | "wrapper_dispatcher"
  | "wrong_source";

interface ItemView {
  readonly role: "pivot" | "support";
  /** 0-based index within its role list. */
  readonly index: number;
  readonly path: string;
  readonly symbol: string;
  readonly kind: string;
  readonly final: number;
  readonly scorecard: {
    lexical: number; symbol: number; path: number; test_to_impl: number;
    body_literal: number; graph_proximity: number;
  };
  /** Distinct direct-evidence scorecard components present (>0). */
  readonly direct_components: string[];
  readonly role_reason: string;
  readonly evidence: string[];
  readonly signals: {
    is_entry_point: boolean;
    is_implementation_helper: boolean;
    is_generic_infrastructure: boolean;
    is_query_builder_entrypoint: boolean;
  };
  readonly is_non_source_example: boolean;
  readonly pivot_rank_score: number | null;
  readonly pivot_rank_reason: string | null;
  /** Which injection/boost lanes touched this file (path-matched diagnostics). */
  readonly lanes: string[];
  readonly is_source_gold: boolean;
  readonly is_any_gold: boolean;
}

function directComponents(item: CapsuleV2Item): string[] {
  const out: string[] = [];
  const s = item.scorecard;
  if (s.symbol > 0) out.push("symbol");
  if (s.path > 0) out.push("path");
  if (s.test_to_impl > 0) out.push("test_to_impl");
  if (s.body_literal > 0) out.push("body_literal");
  return out;
}

function classifyLeadType(item: ItemView): LeadType {
  if (isTestFile(item.path)) return "test";
  if (item.is_non_source_example) return "docs_example";
  if (/(^|\/)__init__\.py$/.test(normalizeFilePath(item.path))) return "facade_init";
  if (item.signals.is_generic_infrastructure) return "generic_infra";
  if (item.signals.is_entry_point || item.signals.is_query_builder_entrypoint) return "wrapper_dispatcher";
  return "wrong_source";
}

function laneSets(result: CapsuleV2Result): Map<string, Set<string>> {
  const d = result.diagnostics;
  const lanes = new Map<string, Set<string>>();
  const add = (lane: string, paths: readonly string[]) => {
    if (paths.length === 0) return;
    lanes.set(lane, new Set(paths.map(normalizeFilePath)));
  };
  add("coedit", (d.coedit_candidates ?? []).map((c) => c.path));
  add("file_evidence", (d.file_evidence_candidates ?? []).map((c) => c.path));
  add("graph_neighbor", (d.graph_neighbor_matches ?? []).map((m) => m.neighbor_path));
  add("direct_evidence_strong", (d.direct_evidence_matches ?? []).filter((m) => m.tier === "strong").map((m) => m.path));
  add("direct_evidence_weak", (d.direct_evidence_matches ?? []).filter((m) => m.tier === "weak").map((m) => m.path));
  add("title_symbol", (d.title_symbol_matches ?? []).map((m) => m.path));
  add("literal_anchor", (d.literal_anchor_matches ?? []).map((m) => m.path));
  add("line_anchor", (d.line_anchor_candidates ?? []).map((m) => m.resolved_path));
  return lanes;
}

function lanesOf(lanes: ReadonlyMap<string, Set<string>>, filePath: string): string[] {
  const p = normalizeFilePath(filePath);
  const out: string[] = [];
  for (const [lane, paths] of lanes) {
    if (paths.has(p)) out.push(lane);
  }
  return out.sort();
}

// --- per-case row ----------------------------------------------------------------

interface CaseRow {
  readonly instance_id: string;
  readonly repo: string;
  readonly cohort: "dev" | "holdout";
  readonly m100_outcome: string | null;
  readonly gold_source_files: string[];
  readonly gold_multi_file: boolean;
  readonly lead_is_source_gold: boolean;
  readonly source_gold_in_capsule: boolean;
  readonly gold_in_required: boolean;
  /** Lead not gold but a source gold file is somewhere in the capsule. */
  readonly addressable: boolean;
  readonly lead: ItemView | null;
  readonly lead_type: LeadType | null;
  /** Best-placed source-gold item: first matching pivot, else first matching support. */
  readonly gold_best: ItemView | null;
  /** lead.final - gold_best.final (negative ⇒ gold actually scored higher). */
  readonly final_gap: number | null;
  readonly items: ItemView[];
  /** Discarded candidates on a gold file (role gate/budget dropped the right file). */
  readonly gold_discards: Array<{ path: string; symbol: string; reason: string }>;
}

function toItemView(
  item: CapsuleV2Item,
  index: number,
  lanes: ReadonlyMap<string, Set<string>>,
  sourceGold: readonly string[],
  anyGold: readonly string[],
): ItemView {
  return {
    role: item.role,
    index,
    path: normalizeFilePath(item.path),
    symbol: item.symbol,
    kind: item.kind,
    final: item.scorecard.final,
    scorecard: {
      lexical: item.scorecard.lexical,
      symbol: item.scorecard.symbol,
      path: item.scorecard.path,
      test_to_impl: item.scorecard.test_to_impl,
      body_literal: item.scorecard.body_literal,
      graph_proximity: item.scorecard.graph_proximity,
    },
    direct_components: directComponents(item),
    role_reason: item.role_reason,
    evidence: item.evidence,
    signals: {
      is_entry_point: item.is_entry_point,
      is_implementation_helper: item.is_implementation_helper,
      is_generic_infrastructure: item.is_generic_infrastructure,
      is_query_builder_entrypoint: item.is_query_builder_entrypoint,
    },
    is_non_source_example: item.is_non_source_example === true,
    pivot_rank_score: item.pivot_rank_score ?? null,
    pivot_rank_reason: item.pivot_rank_reason ?? null,
    lanes: lanesOf(lanes, item.path),
    is_source_gold: sourceGold.some((g) => fileMatches(g, item.path)),
    is_any_gold: anyGold.some((g) => fileMatches(g, item.path)),
  };
}

function auditInstance(
  instance: SweBenchInstance,
  cohort: "dev" | "holdout",
  m100Outcome: string | null,
): CaseRow | null {
  const gold = extractGold(instance.patch);
  if (gold.allFiles.length === 0) return null;
  const workspace = resolveCleanWorkspace(instance.instance_id);
  if (workspace === null) return null;
  const task = deriveTaskFromProblemStatement(instance.problem_statement);
  if (task.length === 0 || assertNoGoldLeakage(task, gold) !== null) return null;

  let result: CapsuleV2Result;
  const db = openIndexerDatabase(path.join(workspace, INDEX_RELPATH));
  try {
    result = buildCapsuleV2({ db, repoRoot: workspace, task, intent: CapsuleIntent.Debug, maxTokens: CAPSULE_BUDGET });
  } catch {
    db.close();
    return null;
  }
  db.close();

  const lanes = laneSets(result);
  const items: ItemView[] = [
    ...result.pivots.map((it, i) => toItemView(it, i, lanes, gold.sourceFiles, gold.scoredFiles)),
    ...result.support.map((it, i) => toItemView(it, i, lanes, gold.sourceFiles, gold.scoredFiles)),
  ];
  const lead = items.find((it) => it.role === "pivot" && it.index === 0) ?? null;
  const leadIsSourceGold = lead !== null && lead.is_source_gold;
  const sourceGoldInCapsule = items.some((it) => it.is_source_gold);
  const goldInRequired = items.some((it) => it.role === "pivot" && it.is_source_gold);
  const goldBest =
    items.find((it) => it.role === "pivot" && it.is_source_gold)
    ?? items.find((it) => it.role === "support" && it.is_source_gold)
    ?? null;
  const addressable = gold.sourceFiles.length > 0 && !leadIsSourceGold && sourceGoldInCapsule;

  const goldDiscards = result.discarded
    .filter((d) => gold.sourceFiles.some((g) => fileMatches(g, d.path)))
    .map((d) => ({ path: normalizeFilePath(d.path), symbol: d.symbol, reason: d.discard_reason }));

  return {
    instance_id: instance.instance_id,
    repo: instance.repo,
    cohort,
    m100_outcome: m100Outcome,
    gold_source_files: gold.sourceFiles,
    gold_multi_file: gold.multiFile,
    lead_is_source_gold: leadIsSourceGold,
    source_gold_in_capsule: sourceGoldInCapsule,
    gold_in_required: goldInRequired,
    addressable,
    lead,
    lead_type: lead !== null && !leadIsSourceGold ? classifyLeadType(lead) : null,
    gold_best: goldBest,
    final_gap: lead !== null && goldBest !== null ? lead.final - goldBest.final : null,
    items,
    gold_discards: goldDiscards,
  };
}

// --- main ------------------------------------------------------------------------

interface SplitFile { readonly dev: string[]; readonly holdout: string[]; }

async function main(): Promise<void> {
  const dataPath = process.argv.includes("--swe-bench-data")
    ? process.argv[process.argv.indexOf("--swe-bench-data") + 1]!
    : DEFAULT_DATA;
  const swe = await loadSweBench(dataPath);
  const instances = [...swe.values()].sort((a, b) => a.instance_id.localeCompare(b.instance_id));

  const split = JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m95_dev_holdout_split.json"), "utf8")) as SplitFile;
  const devSet = new Set(split.dev);

  const m100Detail = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m100_deterministic_scoreboard.detail.json"), "utf8"),
  ) as { rows: Array<{ instance_id: string; outcome: string | null }> };
  const m100OutcomeById = new Map(m100Detail.rows.map((r) => [r.instance_id, r.outcome] as const));

  const rows: CaseRow[] = [];
  for (const inst of instances) {
    const row = auditInstance(
      inst,
      devSet.has(inst.instance_id) ? "dev" : "holdout",
      m100OutcomeById.get(inst.instance_id) ?? null,
    );
    if (row !== null) {
      rows.push(row);
      process.stdout.write(
        `${row.addressable ? "▲" : "·"} ${row.instance_id}: lead=${row.lead?.path ?? "—"} `
        + `${row.lead_is_source_gold ? "GOLD" : row.lead_type ?? ""}`
        + `${row.addressable ? ` | gold_best=${row.gold_best?.role}#${row.gold_best?.index} ${row.gold_best?.path}` : ""}\n`,
      );
    }
  }

  const addressable = rows.filter((r) => r.addressable);
  const wrongPivot = rows.filter((r) => r.m100_outcome === "wrong_pivot");
  const leadTypeDist = (subset: readonly CaseRow[]): Record<string, number> => {
    const dist: Record<string, number> = {};
    for (const r of subset) if (r.lead_type !== null) dist[r.lead_type] = (dist[r.lead_type] ?? 0) + 1;
    return dist;
  };
  const goldPlacement = (subset: readonly CaseRow[]): Record<string, number> => {
    const dist: Record<string, number> = {};
    for (const r of subset) {
      const key = r.gold_best === null
        ? "absent"
        : `${r.gold_best.role}#${r.gold_best.index}`;
      dist[key] = (dist[key] ?? 0) + 1;
    }
    return dist;
  };

  const summary = {
    milestone: "M101",
    kind: "Pre-change ranking / lead-pivot gap audit (read-only rebuild of the M100 generation path)",
    live_agents: false,
    docker: false,
    api_spend: false,
    scored: rows.length,
    lead_is_source_gold_count: rows.filter((r) => r.lead_is_source_gold).length,
    source_gold_in_capsule_count: rows.filter((r) => r.source_gold_in_capsule).length,
    addressable_count: addressable.length,
    addressable_dev: addressable.filter((r) => r.cohort === "dev").length,
    addressable_holdout: addressable.filter((r) => r.cohort === "holdout").length,
    wrong_pivot_count: wrongPivot.length,
    lead_type_distribution_addressable: leadTypeDist(addressable),
    lead_type_distribution_wrong_pivot: leadTypeDist(wrongPivot),
    gold_best_placement_addressable: goldPlacement(addressable),
    gold_best_placement_wrong_pivot: goldPlacement(wrongPivot),
    // Q11 evidence: leads whose file was touched by a support-only lane.
    support_only_lane_leads: rows
      .filter((r) => r.lead !== null
        && r.lead.lanes.some((l) => l === "coedit" || l === "file_evidence" || l === "graph_neighbor"))
      .map((r) => ({ instance_id: r.instance_id, lead: r.lead!.path, lanes: r.lead!.lanes })),
    cases: rows.map((r) => ({
      ...r,
      // Keep the full item dump only where it informs rule design.
      items: r.addressable || r.m100_outcome === "wrong_pivot" ? r.items : [],
    })),
  };

  await mkdir(RESULTS_ROOT, { recursive: true });
  await writeFile(
    path.join(RESULTS_ROOT, "stage5_m101_ranking_pivot_gap_audit.json"),
    JSON.stringify(summary, null, 2) + "\n",
    "utf8",
  );
  process.stdout.write(
    `\nM101 gap audit: ${rows.length} scored; lead=src-gold ${summary.lead_is_source_gold_count}; `
    + `addressable ${summary.addressable_count} (dev ${summary.addressable_dev} / holdout ${summary.addressable_holdout}); `
    + `wrong_pivot ${summary.wrong_pivot_count}\n`
    + `lead types (addressable): ${JSON.stringify(summary.lead_type_distribution_addressable)}\n`
    + `gold placement (addressable): ${JSON.stringify(summary.gold_best_placement_addressable)}\n`
    + `support-only-lane leads: ${summary.support_only_lane_leads.length}\n`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
