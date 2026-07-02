// Stage 5 M99 — import-edge gap audit (pre-change).
//
// Driven by the FROZEN M98 scoreboard detail. For every scored case with at
// least one HIDDEN gold file (gold not in the M98 capsule) it asks the M99
// question set: is there an exact file-level import / re-export relation
// between a capsule file and the hidden gold at the base commit; is that
// relation represented in the index's symbol-level edges; would a bounded
// import-relation co-edit mechanism (pool rescue via import evidence, or
// anchor-imports injection) have reached it; and how much NON-gold noise would
// each mechanism admit under candidate gates (task affinity, stem share,
// hub/fan thresholds, generic-infra/__init__ rejection).
//
// The import relations come from `createFileImportScanner` — an exact
// statement-level scan over the same base-commit tree the index was built from
// (top-level imports only, alias-aware, relative + package `__init__`
// re-export + root-package inference; wildcards resolve to the module file
// only, never expanded). Gold labels the OUTPUT only; capsule rebuilds see
// just the derived task.
//
// Split discipline: per-case file detail is emitted for DEV cases only;
// holdout cases contribute aggregate counters and nothing else.
//
// NO Claude, NO Docker, NO agent run, NO API calls, NO live network.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import {
  countCrossFileNeighborFiles,
  listEdgesTouchingFile,
} from "../../src/db/repositories/edgesRepository";
import { listSymbolsForFile } from "../../src/db/repositories/symbolsRepository";
import { isGenericInfraFile, isVendoredOrGenerated } from "../../src/capsuleV2/graphNeighborAnchoring";
import { meaningfulTokens } from "../../src/capsuleV2/coeditExpansion";
import {
  createFileImportScanner,
  type FileImportRelation,
  type FileImportScanner,
} from "../../src/parsers/pythonFileImports";
import { isLikelyTestCandidate } from "../../src/retrieval/searchSymbolsShared";

import {
  deriveTaskFromProblemStatement,
  loadSweBench,
} from "./build_stage5_retrieval_fixture";
import { fileMatches, normalizeFilePath } from "./run_stage5_retrieval_eval";

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

interface DetailRow {
  readonly instance_id: string;
  readonly repo: string;
  readonly generation_status: string;
  readonly outcome: string | null;
  readonly gold: { scored_files: string[]; multi_file: boolean };
  readonly capsule: { capsule_files: string[]; lead_pivot_file: string | null } | null;
  readonly file_metrics: { all_gold_in_capsule: boolean } | null;
}

// --- per-pair relation classification ----------------------------------------------

interface PairImportRelation {
  readonly capsule_file: string;
  /** hidden imports capsule file / capsule file imports hidden / both / none. */
  readonly direction: "hidden_imports_capsule" | "capsule_imports_hidden" | "both" | "none";
  readonly kinds: string[];
  readonly imported_names: string[];
  readonly relative: boolean;
  readonly via_root_inference: boolean;
  /** Symbol-level index edges between the pair, by type (Q3). */
  readonly index_edge_counts: Record<string, number>;
  readonly index_has_import_edge: boolean;
}

function indexEdgesBetween(
  db: ReturnType<typeof openIndexerDatabase>,
  a: string,
  b: string,
): Record<string, number> {
  const bIds = new Set(listSymbolsForFile(db, b).map((s) => s.id));
  const counts: Record<string, number> = {};
  for (const edge of listEdgesTouchingFile(db, a)) {
    if (!bIds.has(edge.srcSymbolId) && !bIds.has(edge.dstSymbolId)) continue;
    counts[edge.edgeType] = (counts[edge.edgeType] ?? 0) + 1;
  }
  return counts;
}

function pairRelation(
  db: ReturnType<typeof openIndexerDatabase>,
  scanner: FileImportScanner,
  capsuleFile: string,
  hiddenFile: string,
): PairImportRelation {
  const { aImportsB, bImportsA } = scanner.relationBetween(hiddenFile, capsuleFile);
  const direction = aImportsB !== null && bImportsA !== null
    ? "both"
    : aImportsB !== null
      ? "hidden_imports_capsule"
      : bImportsA !== null
        ? "capsule_imports_hidden"
        : "none";
  const relations = [aImportsB, bImportsA].filter((r): r is FileImportRelation => r !== null);
  const edgeCounts = indexEdgesBetween(db, capsuleFile, hiddenFile);
  return {
    capsule_file: capsuleFile,
    direction,
    kinds: [...new Set(relations.flatMap((r) => [...r.kinds]))].sort(),
    imported_names: [...new Set(relations.flatMap((r) => [...r.importedNames]))].sort(),
    relative: relations.some((r) => r.relative),
    via_root_inference: relations.some((r) => r.viaRootPackageInference),
    index_edge_counts: edgeCounts,
    index_has_import_edge: (edgeCounts["imports"] ?? 0) > 0,
  };
}

// --- candidate-gate simulation ------------------------------------------------------

// A capsule file is a plausible expansion ANCHOR for the simulation when it is
// a credible source file (mirrors the co-edit lane's anchor spirit; the exact
// role/evidence gates are noted as an approximation in the analysis).
function isPlausibleAnchor(p: string): boolean {
  if (isLikelyTestCandidate({ filePath: p, localName: "", fqName: "" })) return false;
  if (isVendoredOrGenerated(p)) return false;
  if (isGenericInfraFile(p)) return false;
  return p.endsWith(".py");
}

function isAdmissibleCandidate(p: string): boolean {
  if (p.endsWith("/__init__.py") || p === "__init__.py") return false;
  return isPlausibleAnchor(p);
}

interface SimulatedCandidate {
  readonly path: string;
  readonly anchor: string;
  readonly mechanism: "anchor_imports_candidate" | "candidate_imports_anchor_pool";
  readonly kinds: string[];
  readonly has_task_affinity: boolean;
  readonly has_stem_share: boolean;
  readonly candidate_import_fan_in: number;
  readonly candidate_edge_fan: number;
  /** Symbol-level index edges between candidate and anchor, by type. */
  readonly pair_edge_types: Record<string, number>;
  readonly has_init_reexport: boolean;
  readonly is_gold: boolean;
}

// --- per-case audit -----------------------------------------------------------------

interface HiddenFileAudit {
  readonly hidden_path: string;
  readonly pool_fate: string;
  readonly generic_infra_named: boolean;
  readonly is_init: boolean;
  readonly import_fan_in: number;
  readonly import_fan_out: number;
  readonly edge_fan: number;
  readonly relations: PairImportRelation[];
  /** Best available import-relation route to this hidden file (Q6/Q8). */
  readonly reachability:
    | "anchor_imports_hidden"
    | "hidden_imports_anchor_in_pool"
    | "hidden_imports_anchor_not_in_pool"
    | "no_import_relation";
}

interface CaseAudit {
  readonly instance_id: string;
  readonly cohort: "dev" | "holdout";
  readonly outcome: string;
  readonly multi_file: boolean;
  readonly hidden_gold_count: number;
  readonly hidden: HiddenFileAudit[];
  readonly simulated_candidates: SimulatedCandidate[];
}

async function main(): Promise<void> {
  const detail = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m98_deterministic_scoreboard.detail.json"), "utf8"),
  ) as { rows: DetailRow[] };
  const split = JSON.parse(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m95_dev_holdout_split.json"), "utf8"),
  ) as { dev: string[]; holdout: string[] };
  const devSet = new Set(split.dev);
  const swe = await loadSweBench(DEFAULT_DATA);

  const scoredRows = detail.rows.filter(
    (r) => r.generation_status === "scored" && r.capsule !== null && r.file_metrics !== null,
  );

  const cases: CaseAudit[] = [];
  for (const row of scoredRows) {
    const cohort: "dev" | "holdout" = devSet.has(row.instance_id) ? "dev" : "holdout";
    const workspace = resolveCleanWorkspace(row.instance_id);
    const instance = swe.get(row.instance_id);
    if (workspace === null || instance === undefined) continue;

    const db = openIndexerDatabase(path.join(workspace, INDEX_RELPATH));
    const allPaths = (db.query("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>)
      .map((r) => normalizeFilePath(r.path));
    const resolveIndexPath = (gold: string): string | null =>
      allPaths.find((p) => fileMatches(gold, p)) ?? null;
    const scanner = createFileImportScanner(allPaths, (p) => {
      try {
        return readFileSync(path.join(workspace, p), "utf8");
      } catch {
        return null;
      }
    });

    // Whole-repo import fan-in map (audit-only; product would use bounded
    // sources — this measures what fan-in gating buys).
    const fanIn = new Map<string, number>();
    for (const p of allPaths) {
      for (const rel of scanner.relationsOf(p)) {
        fanIn.set(rel.importedPath, (fanIn.get(rel.importedPath) ?? 0) + 1);
      }
    }

    // Rebuild the capsule to probe pool membership (gold never fed in).
    const task = deriveTaskFromProblemStatement(instance.problem_statement);
    const result = buildCapsuleV2({
      db, repoRoot: workspace, task, intent: CapsuleIntent.Debug, maxTokens: CAPSULE_BUDGET,
    });
    const capsulePaths = [...new Set([...result.pivots, ...result.support].map((it) => it.path))];
    const poolPaths = new Set([
      ...capsulePaths,
      ...result.discarded.map((d) => d.path),
    ]);
    const taskTokens = meaningfulTokens(task);

    const capsuleGold = row.gold.scored_files.filter((g) => capsulePaths.some((c) => fileMatches(g, c)));
    const hiddenGold = row.gold.scored_files.filter((g) => !capsulePaths.some((c) => fileMatches(g, c)));
    void capsuleGold;

    const hidden: HiddenFileAudit[] = [];
    for (const hiddenGoldFile of hiddenGold) {
      const hiddenPath = resolveIndexPath(hiddenGoldFile);
      if (hiddenPath === null) {
        hidden.push({
          hidden_path: hiddenGoldFile, pool_fate: "not_in_index", generic_infra_named: false,
          is_init: false, import_fan_in: 0, import_fan_out: 0, edge_fan: 0, relations: [],
          reachability: "no_import_relation",
        });
        continue;
      }
      const discard = result.discarded.find((d) => fileMatches(hiddenGoldFile, d.path));
      const poolFate = capsulePaths.some((p) => fileMatches(hiddenGoldFile, p))
        ? "in_capsule_on_rebuild"
        : discard !== undefined
          ? `discarded: ${discard.discard_reason}`
          : "absent_from_pool";
      const relations = capsulePaths.map((c) => pairRelation(db, scanner, c, hiddenPath))
        .filter((r) => r.direction !== "none" || Object.keys(r.index_edge_counts).length > 0);
      const anchorImports = relations.some(
        (r) => (r.direction === "capsule_imports_hidden" || r.direction === "both")
          && isPlausibleAnchor(r.capsule_file),
      );
      const hiddenImportsAnchor = relations.some(
        (r) => (r.direction === "hidden_imports_capsule" || r.direction === "both")
          && isPlausibleAnchor(r.capsule_file),
      );
      const inPool = poolFate !== "absent_from_pool";
      const reachability = anchorImports
        ? "anchor_imports_hidden"
        : hiddenImportsAnchor
          ? (inPool ? "hidden_imports_anchor_in_pool" : "hidden_imports_anchor_not_in_pool")
          : "no_import_relation";
      hidden.push({
        hidden_path: hiddenPath,
        pool_fate: poolFate,
        generic_infra_named: isGenericInfraFile(hiddenPath),
        is_init: hiddenPath.endsWith("/__init__.py"),
        import_fan_in: fanIn.get(hiddenPath) ?? 0,
        import_fan_out: scanner.importFanOut(hiddenPath),
        edge_fan: countCrossFileNeighborFiles(db, hiddenPath),
        relations,
        reachability,
      });
    }

    // ---- noise simulation over EVERY scored case (not just misses) ----
    // Mechanism 1: anchor imports candidate (injection-shaped; fan-out bounded).
    // Mechanism 2: pooled candidate imports anchor (rescue-shaped).
    const anchors = capsulePaths.filter(isPlausibleAnchor).slice(0, 4);
    const simulated: SimulatedCandidate[] = [];
    const seen = new Set<string>(capsulePaths);
    const isGold = (p: string): boolean => row.gold.scored_files.some((g) => fileMatches(g, p));
    const stemTokens = (p: string): Set<string> =>
      meaningfulTokens(p.slice(p.lastIndexOf("/") + 1).replace(/\.py$/, ""));
    const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
      for (const t of a) if (b.has(t)) return true;
      return false;
    };
    // Rescue-shape FIRST (a pooled file is doubly evidenced — the product lane
    // would prefer it), then injection-shape over the remainder.
    for (const poolPath of [...poolPaths].sort()) {
      if (seen.has(poolPath) || !isAdmissibleCandidate(poolPath)) continue;
      for (const anchor of anchors) {
        const rel = scanner.relationBetween(poolPath, anchor);
        if (rel.aImportsB === null && rel.bImportsA === null) continue;
        seen.add(poolPath);
        const relations = [rel.aImportsB, rel.bImportsA]
          .filter((r): r is FileImportRelation => r !== null);
        const kinds = [...new Set(relations.flatMap((r) => [...r.kinds]))].sort();
        const nameTokens = meaningfulTokens(
          relations.flatMap((r) => [...r.importedNames]).join(" "),
        );
        simulated.push({
          path: poolPath, anchor, mechanism: "candidate_imports_anchor_pool",
          kinds,
          has_task_affinity: intersects(nameTokens, taskTokens)
            || intersects(stemTokens(poolPath), taskTokens),
          has_stem_share: intersects(stemTokens(poolPath), stemTokens(anchor)),
          candidate_import_fan_in: fanIn.get(poolPath) ?? 0,
          candidate_edge_fan: countCrossFileNeighborFiles(db, poolPath),
          pair_edge_types: indexEdgesBetween(db, poolPath, anchor),
          has_init_reexport: kinds.includes("init_reexport"),
          is_gold: isGold(poolPath),
        });
        break;
      }
    }
    for (const anchor of anchors) {
      const anchorStems = stemTokens(anchor);
      for (const rel of scanner.relationsOf(anchor)) {
        const c = rel.importedPath;
        if (seen.has(c) || !isAdmissibleCandidate(c)) continue;
        seen.add(c);
        const nameTokens = meaningfulTokens(rel.importedNames.join(" "));
        simulated.push({
          path: c, anchor, mechanism: "anchor_imports_candidate", kinds: [...rel.kinds],
          has_task_affinity: intersects(nameTokens, taskTokens) || intersects(stemTokens(c), taskTokens),
          has_stem_share: intersects(stemTokens(c), anchorStems),
          candidate_import_fan_in: fanIn.get(c) ?? 0,
          candidate_edge_fan: countCrossFileNeighborFiles(db, c),
          pair_edge_types: indexEdgesBetween(db, c, anchor),
          has_init_reexport: rel.kinds.includes("init_reexport"),
          is_gold: isGold(c),
        });
      }
    }
    db.close();

    cases.push({
      instance_id: row.instance_id,
      cohort,
      outcome: row.outcome ?? "unknown",
      multi_file: row.gold.multi_file,
      hidden_gold_count: hiddenGold.length,
      // Split discipline: file-level detail only for dev.
      hidden: cohort === "dev"
        ? hidden
        : hidden.map((h) => ({
            ...h,
            hidden_path: "(holdout: redacted)",
            relations: h.relations.map((r) => ({ ...r, capsule_file: "(holdout: redacted)" })),
          })),
      simulated_candidates: cohort === "dev"
        ? simulated
        : simulated.map((s) => ({ ...s, path: "(holdout: redacted)", anchor: "(holdout: redacted)" })),
    });
    process.stdout.write(
      `✓ ${row.instance_id} (${cohort}): hidden=${hiddenGold.length}`
      + ` reach=[${hidden.map((h) => h.reachability).join(",")}] sim=${simulated.length}`
      + ` (${simulated.filter((s) => s.is_gold).length} gold)\n`,
    );
  }

  // ---- aggregates ----
  const reachCounts: Record<string, Record<string, number>> = { dev: {}, holdout: {} };
  const fateCounts: Record<string, Record<string, number>> = { dev: {}, holdout: {} };
  const indexEdgePresence = { pairs_with_import_relation: 0, pairs_with_index_import_edge: 0, pairs_with_any_index_edge: 0 };
  for (const c of cases) {
    for (const h of c.hidden) {
      reachCounts[c.cohort]![h.reachability] = (reachCounts[c.cohort]![h.reachability] ?? 0) + 1;
      const fate = h.pool_fate.startsWith("discarded") ? "in_pool_not_capsule" : h.pool_fate;
      fateCounts[c.cohort]![fate] = (fateCounts[c.cohort]![fate] ?? 0) + 1;
      for (const r of h.relations) {
        if (r.direction !== "none") {
          indexEdgePresence.pairs_with_import_relation += 1;
          if (r.index_has_import_edge) indexEdgePresence.pairs_with_index_import_edge += 1;
          if (Object.keys(r.index_edge_counts).length > 0) indexEdgePresence.pairs_with_any_index_edge += 1;
        }
      }
    }
  }

  // Gate sweep: precision/recall of the simulated candidate mechanisms under
  // combinations of gates, split by cohort (Q9–Q12).
  interface GateResult {
    gate: string;
    dev: { candidates: number; gold: number; cases_with_any: number };
    holdout: { candidates: number; gold: number; cases_with_any: number };
  }
  const hasPairCallRef = (s: SimulatedCandidate): boolean =>
    (s.pair_edge_types["calls"] ?? 0) + (s.pair_edge_types["references"] ?? 0) > 0;
  const isRescue = (s: SimulatedCandidate): boolean => s.mechanism === "candidate_imports_anchor_pool";
  const gates: Array<{ name: string; test: (s: SimulatedCandidate) => boolean }> = [
    { name: "ungated", test: () => true },
    { name: "affinity", test: (s) => s.has_task_affinity },
    { name: "affinity_or_stem", test: (s) => s.has_task_affinity || s.has_stem_share },
    { name: "affinity+fanin<=25", test: (s) => s.has_task_affinity && s.candidate_import_fan_in <= 25 },
    { name: "affinity+fanin<=10", test: (s) => s.has_task_affinity && s.candidate_import_fan_in <= 10 },
    { name: "rescue_any", test: isRescue },
    { name: "rescue+pair_callref", test: (s) => isRescue(s) && hasPairCallRef(s) },
    {
      name: "rescue+pair_callref+fanin<=10",
      test: (s) => isRescue(s) && hasPairCallRef(s) && s.candidate_import_fan_in <= 10,
    },
    { name: "rescue+reexport", test: (s) => isRescue(s) && s.has_init_reexport },
    {
      name: "rescue+reexport+fanin<=10",
      test: (s) => isRescue(s) && s.has_init_reexport && s.candidate_import_fan_in <= 10,
    },
    {
      name: "rescue+reexport+aff+fanin<=10",
      test: (s) => isRescue(s) && s.has_init_reexport && s.has_task_affinity && s.candidate_import_fan_in <= 10,
    },
    {
      name: "rescue+(reexport|pair_callref)+fanin<=10",
      test: (s) => isRescue(s) && (s.has_init_reexport || hasPairCallRef(s)) && s.candidate_import_fan_in <= 10,
    },
    {
      name: "rescue+(reexport&aff|pair_callref)+fanin<=10",
      test: (s) => isRescue(s)
        && ((s.has_init_reexport && s.has_task_affinity) || hasPairCallRef(s))
        && s.candidate_import_fan_in <= 10,
    },
  ];
  const gateSweep: GateResult[] = gates.map((g) => {
    const result: GateResult = {
      gate: g.name,
      dev: { candidates: 0, gold: 0, cases_with_any: 0 },
      holdout: { candidates: 0, gold: 0, cases_with_any: 0 },
    };
    for (const c of cases) {
      const passing = c.simulated_candidates.filter(g.test);
      const bucket = result[c.cohort];
      bucket.candidates += passing.length;
      bucket.gold += passing.filter((s) => s.is_gold).length;
      if (passing.length > 0) bucket.cases_with_any += 1;
    }
    return result;
  });

  await mkdir(RESULTS_ROOT, { recursive: true });
  await writeFile(
    path.join(RESULTS_ROOT, "stage5_m99_import_edge_gap_audit.json"),
    JSON.stringify({
      milestone: "M99",
      kind: "Import-edge gap audit over frozen M98 cases (file-level import scan vs index edges)",
      live_agents: false, docker: false, api_spend: false,
      cases_total: cases.length,
      cases_with_hidden_gold: cases.filter((c) => c.hidden_gold_count > 0).length,
      hidden_reachability_counts: reachCounts,
      hidden_pool_fate_counts: fateCounts,
      index_edge_presence_for_import_pairs: indexEdgePresence,
      gate_sweep: gateSweep,
      cases: cases.filter((c) => c.hidden_gold_count > 0 || c.simulated_candidates.length > 0),
    }, null, 2) + "\n",
    "utf8",
  );
  process.stdout.write(`\nwrote ${path.join(RESULTS_ROOT, "stage5_m99_import_edge_gap_audit.json")}\n`);
  process.stdout.write(`reachability dev: ${JSON.stringify(reachCounts["dev"])}\n`);
  process.stdout.write(`reachability holdout: ${JSON.stringify(reachCounts["holdout"])}\n`);
  process.stdout.write(`index edge presence: ${JSON.stringify(indexEdgePresence)}\n`);
  for (const g of gateSweep) {
    process.stdout.write(
      `gate ${g.gate}: dev ${g.dev.gold}/${g.dev.candidates} gold (cases ${g.dev.cases_with_any});`
      + ` holdout ${g.holdout.gold}/${g.holdout.candidates} gold (cases ${g.holdout.cases_with_any})\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
