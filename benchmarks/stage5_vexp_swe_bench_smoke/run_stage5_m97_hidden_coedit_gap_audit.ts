// Stage 5 M97 — hidden co-edit gap audit (pre-change).
//
// Driven by the FROZEN M96 scoreboard detail (`stage5_m96_deterministic_scoreboard
// .detail.json`). For every scored multi-file case it splits the gold files into
// FOUND (already in the M96 capsule) and HIDDEN (missing), then classifies the
// index-graph relation connecting each (found, hidden) pair: same directory,
// parent/child directory, sibling package, import/call/reference/contains edges,
// package `__init__` re-export, generated-artifact pair, test/source pair, or no
// obvious relation. It also probes the M96 pool fate of each hidden gold file by
// rebuilding the capsule (gold labels the OUTPUT only — generation sees just the
// derived task), and records hub-degree / generic-infra-name status so the M97
// acceptance rules can be justified from data.
//
// Split discipline: per-case file-level detail is emitted for DEV cases only;
// holdout cases contribute aggregate relation-class counters (the audit the
// milestone explicitly requires) and nothing else.
//
// NO Claude, NO Docker, NO agent run, NO API calls, NO live network.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { listEdgesTouchingFile } from "../../src/db/repositories/edgesRepository";
import { listSymbolsForFile } from "../../src/db/repositories/symbolsRepository";
import { computeInDegreeCentrality } from "../../src/retrieval/graphExpansion";
import { isGenericInfraFile } from "../../src/capsuleV2/graphNeighborAnchoring";

import {
  deriveTaskFromProblemStatement,
  loadSweBench,
} from "./build_stage5_retrieval_fixture";
import { fileMatches, normalizeFilePath } from "./run_stage5_retrieval_eval";
import { isTestFile } from "./stage5_m94_lib";

const DEFAULT_DATA = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
const RESULTS_ROOT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");
const WS_ROOT = path.join(RESULTS_ROOT, "workspaces");
const INDEX_RELPATH = path.join(".vtrace", "index.sqlite");
const CLEAN_WS_ROOTS = ["expanded", "cross_repo"] as const;
const CAPSULE_BUDGET = 8000;

function resolveCleanWorkspace(instanceId: string): string | null {
  for (const root of CLEAN_WS_ROOTS) {
    const ws = path.join(WS_ROOT, root, instanceId);
    if (existsSync(path.join(ws, INDEX_RELPATH))) return ws;
  }
  return null;
}

// --- relation classification ---------------------------------------------------

interface PairRelation {
  readonly relations: string[];
  /** Distinct symbol-level edges connecting the two files, by edge type. */
  readonly edge_counts: Record<string, number>;
}

function dirOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(0, idx) : "";
}

function stemOf(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// Classify the structural relation between two INDEX paths (both resolved).
function classifyPair(
  db: ReturnType<typeof openIndexerDatabase>,
  foundPath: string,
  hiddenPath: string,
): PairRelation {
  const relations: string[] = [];
  const foundDir = dirOf(foundPath);
  const hiddenDir = dirOf(hiddenPath);

  if (foundDir === hiddenDir) relations.push("same_directory");
  else if (hiddenDir.startsWith(`${foundDir}/`) || foundDir.startsWith(`${hiddenDir}/`)) {
    relations.push("parent_child_directory");
  } else if (dirOf(foundDir) === dirOf(hiddenDir) && dirOf(foundDir) !== "") {
    relations.push("sibling_package");
  }

  // Symbol-level edges connecting the two files, either direction.
  const hiddenIds = new Set(listSymbolsForFile(db, hiddenPath).map((s) => s.id));
  const edgeCounts: Record<string, number> = {};
  for (const edge of listEdgesTouchingFile(db, foundPath)) {
    const other = hiddenIds.has(edge.srcSymbolId)
      ? edge.srcSymbolId
      : hiddenIds.has(edge.dstSymbolId)
        ? edge.dstSymbolId
        : null;
    if (other === null) continue;
    edgeCounts[edge.edgeType] = (edgeCounts[edge.edgeType] ?? 0) + 1;
  }
  for (const type of Object.keys(edgeCounts).sort()) relations.push(`edge_${type}`);

  // Package __init__ re-export shape: one side is a package __init__ whose
  // package contains (or is imported by) the other.
  const hiddenIsInit = hiddenPath.endsWith("/__init__.py");
  const foundIsInit = foundPath.endsWith("/__init__.py");
  if (
    (hiddenIsInit && foundPath.startsWith(`${dirOf(hiddenPath)}/`))
    || (foundIsInit && hiddenPath.startsWith(`${dirOf(foundPath)}/`))
  ) {
    relations.push("package_init_pair");
  }

  // Generated-artifact pair (PLY parser/lexer tables).
  const hiddenStem = stemOf(hiddenPath);
  const foundStem = stemOf(foundPath);
  if (
    hiddenStem === `${foundStem}_parsetab` || hiddenStem === `${foundStem}_lextab`
    || foundStem === `${hiddenStem}_parsetab` || foundStem === `${hiddenStem}_lextab`
  ) {
    relations.push("generated_artifact_pair");
  }

  if (isTestFile(hiddenPath) !== isTestFile(foundPath)) relations.push("test_source_pair");
  if (relations.length === 0) relations.push("no_obvious_relation");
  return { relations, edge_counts: edgeCounts };
}

// --- per-case audit --------------------------------------------------------------

interface HiddenFileAudit {
  readonly hidden_path: string;
  /** Pool fate on rebuild: in_capsule (shouldn't happen), discarded:<reason>, absent_from_pool. */
  readonly pool_fate: string;
  readonly graph_neighbor_saw_it: boolean;
  readonly max_symbol_in_degree: number;
  readonly generic_infra_named: boolean;
  readonly relations_to_found: Array<{ found_path: string } & PairRelation>;
}

interface CaseAudit {
  readonly instance_id: string;
  readonly cohort: "dev" | "holdout";
  readonly outcome: string;
  readonly gold_count: number;
  readonly found_gold: string[];
  readonly hidden_gold_count: number;
  readonly gold_support_budget_discards: string[];
  readonly hidden: HiddenFileAudit[];
}

interface DetailRow {
  readonly instance_id: string;
  readonly generation_status: string;
  readonly outcome: string | null;
  readonly gold: { scored_files: string[]; multi_file: boolean };
  readonly capsule: { capsule_files: string[] } | null;
}

async function main(): Promise<void> {
  const detail = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m96_deterministic_scoreboard.detail.json"), "utf8"),
  ) as { rows: DetailRow[] };
  const split = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m95_dev_holdout_split.json"), "utf8"),
  ) as { dev: string[]; holdout: string[] };
  const devSet = new Set(split.dev);
  const swe = await loadSweBench(DEFAULT_DATA);

  const multiFile = detail.rows.filter(
    (r) => r.generation_status === "scored" && r.gold.multi_file && r.capsule !== null,
  );

  const cases: CaseAudit[] = [];
  for (const row of multiFile) {
    const cohort: "dev" | "holdout" = devSet.has(row.instance_id) ? "dev" : "holdout";
    const capsuleFiles = row.capsule!.capsule_files;
    const found = row.gold.scored_files.filter((g) => capsuleFiles.some((c) => fileMatches(g, c)));
    const hiddenGold = row.gold.scored_files.filter((g) => !capsuleFiles.some((c) => fileMatches(g, c)));

    const workspace = resolveCleanWorkspace(row.instance_id);
    const instance = swe.get(row.instance_id);
    if (workspace === null || instance === undefined) continue;

    const db = openIndexerDatabase(path.join(workspace, INDEX_RELPATH));
    const allPaths = (db.query("SELECT path FROM files").all() as Array<{ path: string }>)
      .map((r) => normalizeFilePath(r.path));
    const resolveIndexPath = (gold: string): string | null =>
      allPaths.find((p) => fileMatches(gold, p)) ?? null;

    // Rebuild the capsule to probe pool fate (gold never fed into generation).
    const task = deriveTaskFromProblemStatement(instance.problem_statement);
    const result = buildCapsuleV2({
      db, repoRoot: workspace, task, intent: CapsuleIntent.Debug, maxTokens: CAPSULE_BUDGET,
    });
    const emittedPaths = [...result.pivots, ...result.support].map((it) => it.path);
    const goldSupportBudgetDiscards = result.discarded
      .filter((d) => /support budget/.test(d.discard_reason)
        && row.gold.scored_files.some((g) => fileMatches(g, d.path)))
      .map((d) => `${d.path} (${d.discard_reason})`);
    const graphNeighborPaths = (result.diagnostics.graph_neighbor_matches ?? [])
      .map((m) => m.neighbor_path);

    const hidden: HiddenFileAudit[] = [];
    for (const hiddenGoldFile of hiddenGold) {
      const hiddenPath = resolveIndexPath(hiddenGoldFile);
      if (hiddenPath === null) {
        hidden.push({
          hidden_path: hiddenGoldFile, pool_fate: "not_in_index", graph_neighbor_saw_it: false,
          max_symbol_in_degree: 0, generic_infra_named: false, relations_to_found: [],
        });
        continue;
      }
      const inEmitted = emittedPaths.some((p) => fileMatches(hiddenGoldFile, p));
      const discard = result.discarded.find((d) => fileMatches(hiddenGoldFile, d.path));
      const poolFate = inEmitted
        ? "in_capsule_on_rebuild"
        : discard !== undefined
          ? `discarded: ${discard.discard_reason}`
          : "absent_from_pool";
      const symbols = listSymbolsForFile(db, hiddenPath);
      const inDegrees = computeInDegreeCentrality(db, symbols.map((s) => s.id));
      const maxInDegree = Math.max(0, ...inDegrees.values());
      const relationsToFound = found
        .map((g) => resolveIndexPath(g))
        .filter((p): p is string => p !== null)
        .map((foundPath) => ({ found_path: foundPath, ...classifyPair(db, foundPath, hiddenPath) }));
      hidden.push({
        hidden_path: hiddenPath,
        pool_fate: poolFate,
        graph_neighbor_saw_it: graphNeighborPaths.some((p) => fileMatches(hiddenGoldFile, p)),
        max_symbol_in_degree: maxInDegree,
        generic_infra_named: isGenericInfraFile(hiddenPath),
        relations_to_found: relationsToFound,
      });
    }
    db.close();

    cases.push({
      instance_id: row.instance_id,
      cohort,
      outcome: row.outcome ?? "unknown",
      gold_count: row.gold.scored_files.length,
      // Split discipline: per-case FILE detail only for dev.
      found_gold: cohort === "dev" ? found : [],
      hidden_gold_count: hiddenGold.length,
      gold_support_budget_discards: cohort === "dev" ? goldSupportBudgetDiscards : [],
      hidden: cohort === "dev"
        ? hidden
        : hidden.map((h) => ({ ...h, hidden_path: "(holdout: redacted)", relations_to_found:
            h.relations_to_found.map((r) => ({ ...r, found_path: "(holdout: redacted)" })) })),
    });
    process.stdout.write(`✓ ${row.instance_id} (${cohort}): found=${found.length} hidden=${hiddenGold.length}\n`);
  }

  // Aggregate relation-class counters, per cohort (over hidden files with >=1 found anchor).
  const relationCounts: Record<string, Record<string, number>> = { dev: {}, holdout: {} };
  const fateCounts: Record<string, Record<string, number>> = { dev: {}, holdout: {} };
  const hubCounts: Record<string, { hub: number; non_hub: number; generic_named: number }> = {
    dev: { hub: 0, non_hub: 0, generic_named: 0 },
    holdout: { hub: 0, non_hub: 0, generic_named: 0 },
  };
  for (const c of cases) {
    for (const h of c.hidden) {
      const best = new Set(h.relations_to_found.flatMap((r) => r.relations));
      for (const rel of best) {
        relationCounts[c.cohort]![rel] = (relationCounts[c.cohort]![rel] ?? 0) + 1;
      }
      const fate = h.pool_fate.startsWith("discarded") ? "in_pool_not_capsule" : h.pool_fate;
      fateCounts[c.cohort]![fate] = (fateCounts[c.cohort]![fate] ?? 0) + 1;
      if (h.max_symbol_in_degree >= 5) hubCounts[c.cohort]!.hub += 1;
      else hubCounts[c.cohort]!.non_hub += 1;
      if (h.generic_infra_named) hubCounts[c.cohort]!.generic_named += 1;
    }
  }

  await mkdir(RESULTS_ROOT, { recursive: true });
  await writeFile(
    path.join(RESULTS_ROOT, "stage5_m97_hidden_coedit_gap_audit.json"),
    JSON.stringify({
      milestone: "M97",
      kind: "Hidden co-edit gap audit over frozen M96 multi-file cases",
      live_agents: false, docker: false, api_spend: false,
      multi_file_cases: { dev: cases.filter((c) => c.cohort === "dev").length,
        holdout: cases.filter((c) => c.cohort === "holdout").length },
      relation_class_counts: relationCounts,
      hidden_pool_fate_counts: fateCounts,
      hidden_hub_and_naming: hubCounts,
      cases,
    }, null, 2) + "\n",
    "utf8",
  );
  process.stdout.write(`\nwrote ${path.join(RESULTS_ROOT, "stage5_m97_hidden_coedit_gap_audit.json")}\n`);
  process.stdout.write(`relations dev: ${JSON.stringify(relationCounts["dev"])}\n`);
  process.stdout.write(`relations holdout: ${JSON.stringify(relationCounts["holdout"])}\n`);
  process.stdout.write(`fates dev: ${JSON.stringify(fateCounts["dev"])}\n`);
  process.stdout.write(`fates holdout: ${JSON.stringify(fateCounts["holdout"])}\n`);
  process.stdout.write(`hub/naming: ${JSON.stringify(hubCounts)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
