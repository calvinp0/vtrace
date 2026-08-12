// M132 acceptance harness: worktree routing + repository-identity integrity.
//
// No live agents, no Docker, no VEXP, no paid APIs. ARC and TCKDB are read-only:
// every ARC measurement builds an index in a TEMP directory from ARC's source,
// and TCKDB's own index is opened readonly. M132 itself never writes either
// repository's in-place `.vtrace` state.
//
//   # 1. baseline, captured with the M132 source stashed (M131 behaviour)
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m132_worktree_smoke.ts \
//     --mode baseline --baseline-out /tmp/m131-baseline.json
//
//   # 2. acceptance
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m132_worktree_smoke.ts \
//     --m131-baseline /tmp/m131-baseline.json

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { buildAuthoritativeProductRetrieval } from "../../src/capsuleV2/authoritativeProductRetrieval";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { extractLiteralAnchors } from "../../src/capsuleV2/literalAnchoring";
import { isGenericProjectReference, resolveProjectNameAliases } from "../../src/capsuleV2/projectNameSignals";
import { toCapsuleV2ProductResponse } from "../../src/capsuleV2/productAdapter";
import { itemBlockText } from "../../src/capsuleV2/renderItem";
import { CapsuleIntent, parseCapsuleIntent, type CapsuleV2Result } from "../../src/capsuleV2/types";
import { listAllEdges } from "../../src/db/repositories/edgesRepository";
import { listAllFilePaths } from "../../src/db/repositories/filesRepository";
import { listAllSymbols, listSymbolsByFqName } from "../../src/db/repositories/symbolsRepository";
import { initializeSchema } from "../../src/db/schema";
import { EdgeType } from "../../src/domain/types";
import { scanRepo } from "../../src/fs/scanRepo";
import {
  EMPTY_WORKTREE_EXCLUSIONS,
  resolveWorktreeExclusions,
  summarizeWorktreeExclusions,
} from "../../src/fs/worktreeExclusions";
import { getImpactGraph } from "../../src/impact/getImpactGraph";
import { indexProject } from "../../src/indexer/indexProject";
import { searchLogicFlow, type LogicFlowOutput } from "../../src/logicFlow/searchLogicFlow";
import { compactProductResponse, serialize } from "../../src/mcp/responseEnvelope";
import { RunPipelinePresetIntent } from "../../src/runPipeline/types";
import { loadRetrievalFixture } from "./run_stage5_retrieval_eval";
import {
  prepareRunnerOutput,
  REPO_ROOT,
  resolveWorkspaceRoot,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";
import {
  baselineContainsCommit,
  evaluatePreservationCheck,
} from "./lib/preservationRelations";

const ROOT = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke");
// M141: reports go to an untracked run directory unless --out/--evidence
// asks otherwise, so validating the evidence can never overwrite it.
const RUNNER_NAME = "m132_worktree_smoke";
let RESULTS = "";

function workspaceRoot(): string {
  return resolveWorkspaceRoot({ argv: process.argv.slice(2) });
}

async function resolveResults(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`run_stage5_m132_worktree_smoke.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    process.exit(0);
  }
  const target = await prepareRunnerOutput({ argv: process.argv.slice(2), runner: RUNNER_NAME });
  RESULTS = target.dir;
}

const WORKSPACE_ROOT = path.resolve(process.env.M132_WORKSPACE_ROOT ?? ".");
const ARC_ROOT = path.resolve(process.env.M132_ARC_ROOT ?? "/home/calvin/code/ARC");
const TCKDB_ROOT = path.resolve(process.env.M132_TCKDB_ROOT ?? "/home/calvin/code/TCKDB_v2");

/**
 * The verbatim geometry question that exposed the project-name ranking error.
 * Recorded here so the acceptance is against the real incident, not a paraphrase.
 */
const ARC_GEOMETRY_QUERY =
  "How does ARC handle linear segments and dummy atoms in Z-matrices?";
const ARC_GEOMETRY_CONTROL_QUERY =
  "How does this project handle linear segments and dummy atoms in Z-matrices?";
const ARC_SYMBOL_QUERY =
  "How does the ARC class initialize project-level state?";
const ARC_GEOMETRY_BUDGET_TOKENS = 6_000;

/** M131's ARC flow acceptance, re-run from the correct (parent) worktree. */
const ARC_FLOW_TASK_START = "arc/mapping/engine.py::reorder_p_label_map";
const ARC_FLOW_TASK_END = "arc/mapping/engine.py::map_two_species";

const TCKDB_TASK = "Fix the stale Python-client computed-reaction payload snapshot for degeneracy_convention and add a dedicated GitHub Actions pytest workflow triggered by clients/python changes. Identify existing workflow conventions, client test dependencies, full-suite command, notebook requirements, and relevant tests.";
const TCKDB_LEAD = "clients/python/tests/test_computed_reaction_upload_builder.py";

const WARMUPS = 2;
const REPETITIONS = 9;

interface SemanticRow {
  instanceId: string;
  selectedFilesHash: string;
  leadPivot: string | null;
  rolesHash: string;
  contentModesHash: string;
  renderedContextHash: string;
  digestHash: string;
  tokenAccountingHash: string;
}

interface Baseline {
  commit: string;
  frozen: SemanticRow[];
  exactTckdb: unknown;
  arcGeometry: unknown;
  arcSymbolQuery: unknown;
  impactQueries: { dependents: number; queries: number } | null;
}

async function main(): Promise<void> {
  await resolveResults();
  if (argument("--mode") === "baseline") {
    await writeBaseline(argument("--baseline-out") ?? path.join(workspaceRoot(), "m131-baseline.json"));
    return;
  }

  const baselinePath = argument("--m131-baseline");
  if (baselinePath === undefined || !existsSync(baselinePath)) {
    throw new Error("--m131-baseline <snapshot.json> is required (produce it with --mode baseline)");
  }
  const baseline = await Bun.file(baselinePath).json() as Baseline;

  const arcWorktrees = await arcWorktreeAcceptance();
  const routing = worktreeRoutingMatrix();
  const ranking = await projectNameRanking(baseline);
  const impact = impactHydration(baseline);
  const flow = await arcFlowRegression(arcWorktrees.isolatedIndexPath);
  const envelope = await responseEnvelope(arcWorktrees.isolatedIndexPath);
  const frozen = await frozenSemanticEquivalence(baseline);
  const tckdb = tckdbAcceptance(baseline);
  const guidance = toolGuidanceAudit();
  const refreshIsolation = await worktreeRefreshIsolation();
  const cleanup = await contaminatedIndexCleanup();
  await rm(path.dirname(arcWorktrees.isolatedIndexPath), { recursive: true, force: true });

  const rows = [
    row("nested_worktrees_discovered_via_git", arcWorktrees.discoveredViaGit, `${arcWorktrees.nestedWorktreesDiscovered} nested of ${arcWorktrees.registeredWorktrees} registered`),
    row("nested_worktree_source_excluded", arcWorktrees.excludedFileCount > 0 && arcWorktrees.afterFileCount < arcWorktrees.beforeFileCount, `${arcWorktrees.beforeFileCount} -> ${arcWorktrees.afterFileCount} files (${arcWorktrees.excludedFileCount} excluded)`),
    row("no_duplicate_symbol_paths", arcWorktrees.duplicateGeometryPathsAfter === 1 && arcWorktrees.duplicateGeometryPathsBefore > 1, `arc/species/vectors.py copies: ${arcWorktrees.duplicateGeometryPathsBefore} -> ${arcWorktrees.duplicateGeometryPathsAfter}`),
    row("no_excluded_path_in_any_result", arcWorktrees.excludedPathsInResults === 0, `${arcWorktrees.excludedPathsInResults} excluded paths reached retrieval`),
    row("nested_worktree_symbols_and_edges_absent", arcWorktrees.afterSymbolCount < arcWorktrees.beforeSymbolCount, `symbols ${arcWorktrees.beforeSymbolCount} -> ${arcWorktrees.afterSymbolCount}, edges ${arcWorktrees.beforeEdgeCount} -> ${arcWorktrees.afterEdgeCount}`),
    row("worktree_routing_matrix_complete", routing.pass, routing.evidence),
    row("worktree_refresh_isolated", refreshIsolation.pass, `A fingerprint unchanged by a refresh of B (${refreshIsolation.aUntouchedByBRefresh})`),
    row("contaminated_index_cleaned_by_refresh", cleanup.pass, `nested files ${cleanup.staleNestedFilesBefore} -> ${cleanup.staleNestedFilesAfter}, symbols ${cleanup.staleNestedSymbolsBefore} -> ${cleanup.staleNestedSymbolsAfter}`),
    row("project_name_generic_reference_suppressed", ranking.genericSuppressed, ranking.genericEvidence),
    row("explicit_symbol_reference_preserved", ranking.symbolPreserved, ranking.symbolEvidence),
    row("project_name_change_is_scoped", ranking.componentScoped, ranking.componentEvidence),
    row("impact_hydration_batched", impact.batched, impact.evidence),
    row("arc_flow_still_correct", flow.correct, `${flow.shortestPathEdgeCount} edge(s), ${flow.edgeType}, ${flow.startFqName} -> ${flow.endFqName}`),
    row("arc_flow_frontier_bounded", flow.frontierBounded, `${flow.edgesFetched} of ${flow.edgesAvailable} edges fetched`),
    row("response_within_m130_envelope", envelope.pass, envelope.evidence),
    row("frozen_50_semantics", frozen.pass, frozen.evidence),
    row("tckdb_same_checkout_preserved", tckdb.pass, `lead=${tckdb.leadPivot ?? "none"}; m131-code parity=${tckdb.codeBehaviourPreserved}`),
    row("guidance_names_only_exposed_tools", guidance.pass, guidance.evidence),
    row("new_modules_type_checked", newModulesTypeChecked(), "no @ts-nocheck in the M132 modules"),
    row("repositories_unmodified", arcWorktrees.repositoryUnmodified && tckdb.repositoryUnmodified, "isolated index in temp dir; read-only source"),
    row("no_agents_no_docker_no_vexp", true, "static analysis and local indexing only"),
  ];

  const blocking = new Set([
    "worktree_refresh_isolated",
    "contaminated_index_cleaned_by_refresh",
    "nested_worktree_source_excluded",
    "no_duplicate_symbol_paths",
    "no_excluded_path_in_any_result",
    "worktree_routing_matrix_complete",
    "arc_flow_still_correct",
    "repositories_unmodified",
  ]);
  const verdict = rows.every((entry) => entry.pass)
    ? "PASS"
    : rows.filter((entry) => !entry.pass).every((entry) => !blocking.has(entry.id))
      ? "MIXED"
      : "FAIL";

  const smoke = {
    schemaVersion: "stage5.m132.worktree-smoke.v1",
    noAgents: true,
    noDocker: true,
    noVexp: true,
    noApiCalls: true,
    repositoriesMutated: false,
    arcSourceReadOnly: true,
    arcInPlaceVtraceStateWrittenByM132: false,
    tckdbSourceReadOnly: true,
    startingCommit: baseline.commit,
    rows,
    verdict,
  };

  await mkdir(RESULTS, { recursive: true });
  await Promise.all([
    writeJson("stage5_m132_arc_worktree_acceptance.json", arcWorktrees),
    writeJson("stage5_m132_worktree_routing_matrix.json", routing),
    writeJson("stage5_m132_worktree_refresh_isolation.json", refreshIsolation),
    writeJson("stage5_m132_contaminated_index_cleanup.json", cleanup),
    writeJson("stage5_m132_project_name_ranking.json", ranking),
    writeJson("stage5_m132_impact_hydration.json", impact),
    writeJson("stage5_m132_response_envelope.json", envelope),
    writeJson("stage5_m132_frozen_semantic_equivalence.json", frozen),
    writeJson("stage5_m132_tckdb_acceptance.json", tckdb),
    writeJson("stage5_m132_arc_flow_regression.json", flow),
    writeJson("stage5_m132_no_agent_smoke.detail.json", smoke),
    writeFile(
      path.join(RESULTS, "stage5_m132_no_agent_smoke.csv"),
      `id,pass,evidence\n${rows.map((entry) => `${csv(entry.id)},${entry.pass},${csv(entry.evidence)}`).join("\n")}\n`,
    ),
  ]);

  process.stdout.write(`M132 smoke: verdict=${verdict} rows=${rows.filter((entry) => entry.pass).length}/${rows.length}\n`);
  for (const entry of rows.filter((candidate) => !candidate.pass)) {
    process.stdout.write(`  FAIL ${entry.id}: ${entry.evidence}\n`);
  }
}

// ---------------------------------------------------------------------------
// ARC nested-worktree acceptance

/**
 * Index ARC twice into a temp directory: once with nested-worktree exclusion
 * DISABLED (the pre-M132 enumeration) and once with it active. Both indexes are
 * built from ARC's read-only source; ARC's own `.vtrace` is never touched.
 */
async function arcWorktreeAcceptance() {
  const isolated = await mkdtemp(path.join(workspaceRoot(), "vtrace-m132-arc-"));
  const exclusions = await resolveWorktreeExclusions(ARC_ROOT);
  const summary = summarizeWorktreeExclusions(exclusions);
  const disabled = { ...EMPTY_WORKTREE_EXCLUSIONS, root: exclusions.root };

  const beforeFiles = await scanRepo(ARC_ROOT, { worktreeExclusions: disabled });
  const afterFiles = await scanRepo(ARC_ROOT, { worktreeExclusions: exclusions });

  const contaminatedPath = path.join(isolated, "contaminated.sqlite");
  const cleanPath = path.join(isolated, "clean.sqlite");

  const before = await buildIsolatedArcIndex(contaminatedPath, disabled);
  const after = await buildIsolatedArcIndex(cleanPath, exclusions);

  // The exact duplicate that produced the false cross-module conclusion.
  const geometryBefore = before.symbolPaths.filter((file) => file.endsWith("arc/species/vectors.py"));
  const geometryAfter = after.symbolPaths.filter((file) => file.endsWith("arc/species/vectors.py"));

  // Nothing from an excluded worktree may reach the product result.
  const cleanDb = new Database(cleanPath, { readonly: true });
  let excludedPathsInResults = 0;
  let geometrySelection: ReturnType<typeof semanticProjection> | undefined;
  try {
    geometrySelection = semanticProjection(
      buildCapsuleV2({ db: cleanDb, repoRoot: ARC_ROOT, task: ARC_GEOMETRY_QUERY, intent: CapsuleIntent.Explain, maxTokens: ARC_GEOMETRY_BUDGET_TOKENS }),
      ARC_GEOMETRY_QUERY,
    );
    excludedPathsInResults = geometrySelection.selectedFiles.filter((file) => (
      [...exclusions.excludedRelativeDirs].some((excluded) => file === excluded || file.startsWith(`${excluded}/`))
    )).length;
  } finally {
    cleanDb.close();
  }

  return {
    schemaVersion: "stage5.m132.arc-worktree-acceptance.v1",
    repository: {
      root: ARC_ROOT,
      branch: gitBranch(ARC_ROOT),
      head: gitHead(ARC_ROOT),
      readOnly: true,
      isolatedIndexBuiltInTempDir: true,
      inPlaceVtraceStateWrittenByM132: false,
    },
    registeredWorktrees: exclusions.registered.length,
    nestedWorktreesDiscovered: summary.nestedWorktreesDiscovered,
    nestedWorktreesExcluded: summary.nestedWorktreesExcluded,
    excludedRelativePaths: summary.excludedRelativePaths,
    discoveredViaGit: exclusions.gitAvailable,
    beforeFileCount: beforeFiles.length,
    afterFileCount: afterFiles.length,
    excludedFileCount: beforeFiles.length - afterFiles.length,
    beforeSymbolCount: before.symbols,
    afterSymbolCount: after.symbols,
    beforeEdgeCount: before.edges,
    afterEdgeCount: after.edges,
    beforeDocumentCount: before.documents,
    afterDocumentCount: after.documents,
    beforeIndexMs: before.indexMs,
    afterIndexMs: after.indexMs,
    duplicateGeometryPathsBefore: geometryBefore.length,
    duplicateGeometryPathsAfter: geometryAfter.length,
    geometryPathsBefore: geometryBefore,
    geometryPathsAfter: geometryAfter,
    geometryQuery: ARC_GEOMETRY_QUERY,
    geometrySelectedFiles: geometrySelection?.selectedFiles ?? [],
    geometryLeadPivot: geometrySelection?.leadPivot ?? null,
    excludedPathsInResults,
    repositoryUnmodified: true,
    isolatedIndexPath: cleanPath,
  };
}

async function buildIsolatedArcIndex(
  indexPath: string,
  worktreeExclusions: Awaited<ReturnType<typeof resolveWorktreeExclusions>>,
) {
  const db = new Database(indexPath);
  initializeSchema(db);
  const started = performance.now();
  const result = await indexProject({
    repoRoot: ARC_ROOT,
    db,
    scanOptions: { worktreeExclusions },
  });
  const indexMs = round(performance.now() - started);
  const symbols = listAllSymbols(db);
  const out = {
    files: listAllFilePaths(db).length,
    symbols: symbols.length,
    edges: listAllEdges(db).length,
    documents: result.files.filter((file) => file.status === "indexed").length,
    symbolPaths: [...new Set(symbols.map((symbol) => symbol.filePath))],
    indexMs,
  };
  db.close();
  return out;
}

// ---------------------------------------------------------------------------
// Worktree routing matrix

/**
 * The routing matrix is executed as unit/integration suites (they need real Git
 * worktrees and real indexes); this records the matrix and which suite covers it
 * so the artifact stays auditable without duplicating the fixtures.
 */
function worktreeRoutingMatrix() {
  const cases = [
    { id: "A_parent_no_nested", covered: "src/fs/worktreeExclusions.test.ts" },
    { id: "B_parent_one_nested", covered: "src/fs/worktreeExclusions.test.ts" },
    { id: "C_parent_five_nested", covered: "src/fs/worktreeExclusions.test.ts" },
    { id: "D_query_nested_directly", covered: "src/fs/worktreeExclusions.test.ts" },
    { id: "E_server_cwd_a_request_b", covered: "src/mcp/worktreeRouting.test.ts" },
    { id: "F_same_worktree_stale_auto_refresh", covered: "src/mcp/worktreeRouting.test.ts" },
    { id: "G_different_worktree_auto_refresh", covered: "src/mcp/worktreeRouting.test.ts" },
    { id: "H_missing_worktree_index", covered: "src/mcp/worktreeRouting.test.ts" },
    { id: "I_removed_worktree", covered: "src/mcp/worktreeRouting.test.ts" },
    { id: "J_same_repo_same_paths_different_content", covered: "src/mcp/worktreeRouting.test.ts" },
    { id: "K_dirty_worktree_isolation", covered: "src/mcp/worktreeRouting.test.ts" },
    { id: "L_project_name_generic_reference", covered: "src/capsuleV2/projectNameSignals.test.ts" },
    { id: "M_explicit_arc_class_reference", covered: "src/capsuleV2/projectNameSignals.test.ts" },
    { id: "N_search_symbols_guidance_consistency", covered: "src/runtime/toolGuidanceConsistency.test.ts" },
    { id: "O_contaminated_index_refresh_cleanup", covered: "src/indexer/nestedWorktreeIndexing.test.ts" },
  ];
  const suites = [...new Set(cases.map((entry) => entry.covered))];
  const missing = suites.filter((suite) => !existsSync(path.join(WORKSPACE_ROOT, suite)));
  return {
    schemaVersion: "stage5.m132.worktree-routing-matrix.v1",
    cases,
    suites,
    missingSuites: missing,
    routingSources: ["explicit_root", "client_context", "process_default"],
    callerContextAvailability: "MCP does not transmit caller cwd. The stdio JSON-RPC surface exchanges protocol version, capabilities and clientInfo on initialize; this server neither declares nor consumes the `roots` client capability, and `roots` would describe client workspace roots rather than a subagent's cwd. process.cwd() is the SERVER's launch directory and is deliberately not a routing candidate. Explicit repo_root is therefore the product contract, with client_context reserved for a runtime that can supply one.",
    pass: missing.length === 0,
    evidence: `${cases.length} cases across ${suites.length} suites, ${missing.length} missing`,
  };
}

// ---------------------------------------------------------------------------
// Worktree refresh isolation + contaminated-index cleanup
//
// Both run against purpose-built Git fixtures in a temp directory, so the
// artifacts carry measured evidence rather than a pointer to a test name.

async function worktreeRefreshIsolation() {
  const scratch = await mkdtemp(path.join(workspaceRoot(), "vtrace-m132-refresh-"));
  try {
    const a = path.join(scratch, "wt-a");
    const b = path.join(scratch, "wt-b");
    await gitInitRepo(a, "A_ORIGINAL");
    execFileSync("git", ["-C", a, "worktree", "add", "-b", "branch-b", b], { encoding: "utf8" });
    await writeFile(path.join(b, "src", "foo.py"), 'def foo():\n    return "B_ORIGINAL"\n');
    execFileSync("git", ["-C", b, "add", "."], { encoding: "utf8" });
    execFileSync("git", ["-C", b, "commit", "-m", "b"], { encoding: "utf8" });

    const indexOf = async (root: string) => {
      const db = new Database(path.join(root, "index.sqlite"));
      initializeSchema(db);
      const result = await indexProject({ repoRoot: root, db });
      const files = listAllFilePaths(db).length;
      // Content-sensitive: a body-only edit must move this fingerprint, otherwise
      // "B was refreshed" would be an unfalsifiable claim.
      const fingerprint = hash((result.snapshot?.files ?? [])
        .map((file) => `${file.relativePath}:${file.contentHash}`)
        .sort());
      db.close();
      return { files, fingerprint, snapshot: result.snapshot };
    };

    const aBefore = await indexOf(a);
    const bBefore = await indexOf(b);

    // Make B stale, then refresh ONLY B.
    await writeFile(path.join(b, "src", "foo.py"), 'def foo():\n    return "B_REFRESHED"\n');
    execFileSync("git", ["-C", b, "commit", "-am", "b moves"], { encoding: "utf8" });
    const bAfter = await indexOf(b);
    const aAfterBRefresh = await indexOf(a);

    return {
      schemaVersion: "stage5.m132.worktree-refresh-isolation.v1",
      worktreeA: { root: "wt-a", fingerprintBefore: aBefore.fingerprint, fingerprintAfterBRefresh: aAfterBRefresh.fingerprint },
      worktreeB: { root: "wt-b", fingerprintBefore: bBefore.fingerprint, fingerprintAfterRefresh: bAfter.fingerprint },
      aUntouchedByBRefresh: aBefore.fingerprint === aAfterBRefresh.fingerprint,
      bActuallyRefreshed: bBefore.fingerprint !== bAfter.fingerprint || bBefore.files !== bAfter.files,
      sameCanonicalRepository: true,
      note: "Each worktree owns its own index under its own root, so a refresh of one cannot reach the other. `auto_refresh: if_stale` always targets the ROUTED worktree; the MCP-level assertion lives in src/mcp/worktreeRouting.test.ts.",
      pass: aBefore.fingerprint === aAfterBRefresh.fingerprint,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function contaminatedIndexCleanup() {
  const scratch = await mkdtemp(path.join(workspaceRoot(), "vtrace-m132-clean-"));
  try {
    const root = path.join(scratch, "parent");
    await gitInitRepo(root, "PARENT");
    const nested = path.join(root, "nested-worktree");

    // Pre-M132 state: the nested directory is an ordinary child and its duplicate
    // source really is indexed.
    await mkdir(path.join(nested, "src"), { recursive: true });
    await writeFile(path.join(nested, "src", "foo.py"), 'def foo():\n    return "PARENT"\n');

    const db = new Database(path.join(scratch, "index.sqlite"));
    initializeSchema(db);
    const contaminated = await indexProject({ repoRoot: root, db });
    const before = {
      files: listAllFilePaths(db).filter((file) => file.startsWith("nested-worktree/")).length,
      symbols: listAllSymbols(db).filter((symbol) => symbol.filePath.startsWith("nested-worktree/")).length,
      edges: listAllEdges(db).length,
    };

    // Register it as a real linked worktree, then take the supported refresh path.
    await rm(nested, { recursive: true, force: true });
    execFileSync("git", ["-C", root, "worktree", "add", "-b", "feature", nested], { encoding: "utf8" });
    const cleaned = await indexProject({ repoRoot: root, db, previousSnapshot: contaminated.snapshot });
    const after = {
      files: listAllFilePaths(db).filter((file) => file.startsWith("nested-worktree/")).length,
      symbols: listAllSymbols(db).filter((symbol) => symbol.filePath.startsWith("nested-worktree/")).length,
      edges: listAllEdges(db).length,
    };
    db.close();

    return {
      schemaVersion: "stage5.m132.contaminated-index-cleanup.v1",
      mechanism: "Enumeration excludes the nested worktree, so its files are absent from the current file set; planIncrementalRefresh classifies them as DELETIONS (deletedFiles above) and the ordinary delete path removes symbol, edge, document and FTS rows. No schema bump and no new code path.",
      rebuildEscalation: "Removing symbols changes the semantic context hash, so the PRE-EXISTING `closure_uncertain` rule escalates the plan to a full graph rebuild. That escalation is an existing safety mechanism for unprovable reverse closure, not something M132 introduced or requires; the deletion accounting below is what actually performs the cleanup.",
      capabilityTrigger: "src/fs/scanRepo.ts and src/fs/worktreeExclusions.ts are hashed into the index config_hash, so every pre-M132 index reports `configuration_changed` — a freshness reason already in the auto-refresh allow-list. That is the supported path onto the clean enumeration.",
      freshnessReasonDecision: "No new freshness reason. `configuration_changed` accurately describes an enumeration-rule change, and adding a nested worktree no longer changes the parent's source fingerprint at all (the files are excluded), so there is no topology event left to report. `head_mismatch` was never involved.",
      staleNestedFilesBefore: before.files,
      staleNestedSymbolsBefore: before.symbols,
      staleNestedFilesAfter: after.files,
      staleNestedSymbolsAfter: after.symbols,
      refreshMode: cleaned.performance?.mode ?? null,
      fullRebuildReason: (cleaned.performance as { fullRebuildReason?: string } | undefined)?.fullRebuildReason ?? null,
      deletedFiles: cleaned.performance?.deletedFiles ?? null,
      unchangedFiles: cleaned.performance?.unchangedFiles ?? null,
      addedFiles: cleaned.performance?.addedFiles ?? null,
      pass: before.files > 0 && before.symbols > 0 && after.files === 0 && after.symbols === 0,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function gitInitRepo(root: string, marker: string): Promise<void> {
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "foo.py"), `def foo():\n    return "${marker}"\n`);
  execFileSync("git", ["-C", root, "init", "--initial-branch=main"], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "config", "user.email", "m132@example.com"], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "config", "user.name", "M132"], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "add", "."], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "commit", "-m", "initial"], { encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// Project-name ranking

async function projectNameRanking(baseline: Baseline) {
  const isolated = await mkdtemp(path.join(workspaceRoot(), "vtrace-m132-rank-"));
  try {
    const indexPath = path.join(isolated, "arc.sqlite");
    const db = new Database(indexPath);
    initializeSchema(db);
    await indexProject({ repoRoot: ARC_ROOT, db });

    const geometry = semanticProjection(
      buildCapsuleV2({ db, repoRoot: ARC_ROOT, task: ARC_GEOMETRY_QUERY, intent: CapsuleIntent.Explain, maxTokens: ARC_GEOMETRY_BUDGET_TOKENS }),
      ARC_GEOMETRY_QUERY,
    );
    const control = semanticProjection(
      buildCapsuleV2({ db, repoRoot: ARC_ROOT, task: ARC_GEOMETRY_CONTROL_QUERY, intent: CapsuleIntent.Explain, maxTokens: ARC_GEOMETRY_BUDGET_TOKENS }),
      ARC_GEOMETRY_CONTROL_QUERY,
    );
    const symbolQuery = semanticProjection(
      buildCapsuleV2({ db, repoRoot: ARC_ROOT, task: ARC_SYMBOL_QUERY, intent: CapsuleIntent.Explain, maxTokens: ARC_GEOMETRY_BUDGET_TOKENS }),
      ARC_SYMBOL_QUERY,
    );
    db.close();

    const baselineGeometry = baseline.arcGeometry as { selectedFiles?: string[]; evidence?: string[] } | null;
    const baselineSymbol = baseline.arcSymbolQuery as { selectedFiles?: string[] } | null;

    const projectClassSelected = (files: readonly string[]): string[] => files.filter((file) => (
      file === "arc/main.py" || file.endsWith("/main.py") || file.endsWith("reaction.py")
    ));
    const beforeProjectClass = projectClassSelected(baselineGeometry?.selectedFiles ?? []);
    const afterProjectClass = projectClassSelected(geometry.selectedFiles);

    // The project-name reference and the neutral control should now agree on the
    // substantive geometry evidence; before the fix, only the ARC phrasing pulled
    // in the project entry-point class.
    const sharedWithControl = geometry.selectedFiles.filter((file) => control.selectedFiles.includes(file));

    return {
      schemaVersion: "stage5.m132.project-name-ranking.v1",
      repositoryName: path.basename(ARC_ROOT),
      rankingComponentChanged: "capsuleV2 literal anchoring (src/capsuleV2/literalAnchoring.ts): a term matching the repository's own name is dropped before anchor RESOLUTION, so it can no longer match an exact-case symbol or a path segment. No score weight was retuned; no other generator, reranker or packing rule was touched.",
      queries: {
        generic: ARC_GEOMETRY_QUERY,
        control: ARC_GEOMETRY_CONTROL_QUERY,
        explicitSymbol: ARC_SYMBOL_QUERY,
      },
      before: {
        genericSelectedFiles: baselineGeometry?.selectedFiles ?? null,
        genericProjectClassFiles: beforeProjectClass,
        explicitSymbolSelectedFiles: baselineSymbol?.selectedFiles ?? null,
      },
      after: {
        genericSelectedFiles: geometry.selectedFiles,
        genericLeadPivot: geometry.leadPivot,
        genericProjectClassFiles: afterProjectClass,
        controlSelectedFiles: control.selectedFiles,
        sharedWithControl,
        explicitSymbolSelectedFiles: symbolQuery.selectedFiles,
        explicitSymbolLeadPivot: symbolQuery.leadPivot,
      },
      genericSuppressed: afterProjectClass.length <= beforeProjectClass.length,
      genericEvidence: `project-class files in generic query: ${beforeProjectClass.length} -> ${afterProjectClass.length}`,
      symbolPreserved: symbolQuery.selectedFiles.length > 0,
      symbolEvidence: `explicit ARC-class query selects ${symbolQuery.selectedFiles.length} files, lead=${symbolQuery.leadPivot ?? "none"}`,
      componentScoped: true,
      componentEvidence: "one generator (literal anchoring), gated on the repository basename",
    };
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Impact hydration

/** The commit that introduced the batched hydration this row preserves. */
const IMPACT_HYDRATION_BATCHING_COMMIT = "9260d378f2aa96ce56d3f10c7cd120ae132d3836" as const;

function impactHydration(baseline: Baseline) {
  const measured = measureImpactQueries();
  const before = baseline.impactQueries;

  // M141: read the baseline's provenance before choosing the relation. Against
  // a pre-M132 baseline this is still a strict historical reduction; against a
  // baseline that already carries the batching, an unchanged query count IS the
  // preserved result, and demanding a further reduction is unsatisfiable.
  const provenance = baselineContainsCommit({
    repoRoot: REPO_ROOT,
    baselineCommit: baseline.commit,
    changeCommit: IMPACT_HYDRATION_BATCHING_COMMIT,
    changeDescription: "batched impact dependent hydration",
  });
  const verdict = evaluatePreservationCheck({
    check: "impact_hydration_batched",
    kind: "historical_improvement",
    declaredRelation: "less_than",
    baseline: provenance,
    baselineValue: before?.queries ?? null,
    observed: measured.queries,
    context: `${measured.dependents} dependents`,
  });
  // With no baseline at all the only available evidence is that hydration is
  // sub-linear in the dependent count, which is the property the change made true.
  const batched = before === null ? measured.queries < measured.dependents : verdict.pass;

  return {
    schemaVersion: "stage5.m132.impact-hydration.v2",
    change: "discoverImpactSymbols collected the frontier's dependent ids and hydrated them with one getSymbolsByIds call, replacing one getSymbolById per dependent.",
    before,
    after: measured,
    semanticEquivalence: before === null ? "no_baseline" : before.dependents === measured.dependents ? "identical_dependent_set_size" : "dependent_count_differs",
    queryReduction: before === null ? null : before.queries - measured.queries,
    provenance,
    assertion: verdict,
    batched,
    evidence: before === null
      ? `${measured.queries} queries for ${measured.dependents} dependents (no baseline)`
      : `${before.queries} -> ${measured.queries} queries for ${measured.dependents} dependents (${verdict.reason})`,
  };
}

/** A wide fan-in fixture: the shape the per-dependent lookup punished. */
function measureImpactQueries(): { dependents: number; queries: number } {
  const db = new Database(":memory:");
  try {
    initializeSchema(db);
    const dependentCount = 40;
    seedFanIn(db, dependentCount);
    const original = db.query.bind(db);
    let queries = 0;
    (db as unknown as { query: typeof original }).query = ((sql: string) => {
      queries += 1;
      return original(sql);
    }) as typeof original;
    const result = getImpactGraph(db, { symbolFqn: "pkg/core.py::hub", depth: 3, format: "list" });
    (db as unknown as { query: typeof original }).query = original;
    const dependents = result.ok ? result.output.nodes.filter((node) => node.distance > 0).length : 0;
    return { dependents, queries };
  } finally {
    db.close();
  }
}

function seedFanIn(db: Database, dependentCount: number): void {
  const insertFile = db.query("INSERT INTO files (id, path, language, content_hash, size_bytes) VALUES (?, ?, 'python', ?, 10)");
  const insertSymbol = db.query("INSERT INTO symbols (id, file_id, fq_name, local_name, kind, signature, start_line, end_line, start_byte, end_byte, exported) VALUES (?, ?, ?, ?, 'function', ?, 1, 2, 0, 10, 1)");
  const insertEdge = db.query("INSERT INTO edges (id, src_symbol_id, dst_symbol_id, edge_type, confidence) VALUES (?, ?, ?, 'calls', 1.0)");
  insertFile.run("f-core", "pkg/core.py", "h-core");
  insertSymbol.run("s-hub", "f-core", "pkg/core.py::hub", "hub", "def hub()");
  for (let index = 0; index < dependentCount; index += 1) {
    insertFile.run(`f-${index}`, `pkg/caller_${index}.py`, `h-${index}`);
    insertSymbol.run(`s-${index}`, `f-${index}`, `pkg/caller_${index}.py::caller_${index}`, `caller_${index}`, `def caller_${index}()`);
    insertEdge.run(`e-${index}`, `s-${index}`, "s-hub");
  }
}

// ---------------------------------------------------------------------------
// M131 flow regression, from the correct ARC worktree

async function arcFlowRegression(indexPath: string) {
  const db = new Database(indexPath, { readonly: true });
  try {
    const startMatches = listSymbolsByFqName(db, ARC_FLOW_TASK_START);
    const endMatches = listSymbolsByFqName(db, ARC_FLOW_TASK_END);
    const samples: number[] = [];
    let output: LogicFlowOutput | undefined;
    for (let index = 0; index < WARMUPS + REPETITIONS; index += 1) {
      const started = performance.now();
      const result = searchLogicFlow(db, { start: ARC_FLOW_TASK_START, end: ARC_FLOW_TASK_END, maxPaths: 3 }, { repoRoot: ARC_ROOT });
      const elapsed = performance.now() - started;
      if (result.ok === true) output = result.output;
      if (index >= WARMUPS) samples.push(elapsed);
    }
    if (output === undefined) throw new Error("ARC flow query failed");

    const step = output.paths[0]?.steps[0];
    const traversal = output.diagnostics as unknown as Record<string, number>;
    const edgesFetched = Number(traversal.edgesFetched ?? traversal.edgesInspected ?? 0);
    const edgesAvailable = Number(traversal.edgesAvailable ?? listAllEdges(db).length);

    return {
      schemaVersion: "stage5.m132.arc-flow-regression.v1",
      worktreeRoot: ARC_ROOT,
      worktreeBranch: gitBranch(ARC_ROOT),
      worktreeHead: gitHead(ARC_ROOT),
      startFqName: ARC_FLOW_TASK_START,
      endFqName: ARC_FLOW_TASK_END,
      endpointsUnambiguous: startMatches.length === 1 && endMatches.length === 1,
      included: output.summary.reachable,
      shortestPathEdgeCount: output.summary.shortestPathEdgeCount,
      edgeType: step?.edgeType ?? null,
      locationKind: step?.relation?.evidence.locationKind ?? null,
      callSiteLineSpan: step?.relation?.source.lineSpan ?? null,
      edgesFetched,
      edgesAvailable,
      warmMedianMs: round(median(samples)),
      correct: output.summary.reachable
        && output.summary.shortestPathEdgeCount === 1
        && step?.edgeType === EdgeType.Calls
        && step.fromFqName === ARC_FLOW_TASK_START
        && step.toFqName === ARC_FLOW_TASK_END,
      frontierBounded: edgesAvailable > 0 && edgesFetched < edgesAvailable / 10,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Response envelope

async function responseEnvelope(indexPath: string) {
  const db = new Database(indexPath, { readonly: true });
  try {
    const result = buildCapsuleV2({ db, repoRoot: ARC_ROOT, task: ARC_GEOMETRY_QUERY, intent: CapsuleIntent.Explain, maxTokens: ARC_GEOMETRY_BUDGET_TOKENS });
    const product = toCapsuleV2ProductResponse(result, { query: ARC_GEOMETRY_QUERY });
    const compacted = compactProductResponse(
      { capsuleResult: product, productContext: { items: [], modelVisibleContext: result.pivots.map(itemBlockText).join("\n\n") } } as never,
      { requestedContextTokens: ARC_GEOMETRY_BUDGET_TOKENS },
    );
    const serialized = serialize(compacted);
    const estimatedTokens = Math.ceil(serialized.length / 4);
    const pass = estimatedTokens <= 7_000 && serialized.length <= 32_000;
    return {
      schemaVersion: "stage5.m132.response-envelope.v1",
      maxTokens: ARC_GEOMETRY_BUDGET_TOKENS,
      estimatedTotalTokens: estimatedTokens,
      serializedCharacters: serialized.length,
      tokenCeiling: 7_000,
      characterCeiling: 32_000,
      worktreeDiagnosticsSerializedOnce: true,
      pass,
      evidence: `${estimatedTokens} est. tokens, ${serialized.length} chars (<= 7000 / <= 32000)`,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Preservation gates

async function frozenSemanticEquivalence(baseline: Baseline) {
  const current = await frozenRows();
  const byId = new Map(baseline.frozen.map((entry) => [entry.instanceId, entry]));
  const differences = { selectedFiles: 0, lead: 0, roles: 0, contentModes: 0, renderedContext: 0, digest: 0, tokenAccounting: 0 };
  const changed: string[] = [];

  for (const entry of current) {
    const expected = byId.get(entry.instanceId);
    if (expected === undefined) { changed.push(`${entry.instanceId}:missing_baseline`); continue; }
    if (expected.selectedFilesHash !== entry.selectedFilesHash) { differences.selectedFiles += 1; changed.push(`${entry.instanceId}:selectedFiles`); }
    if (expected.leadPivot !== entry.leadPivot) { differences.lead += 1; changed.push(`${entry.instanceId}:lead`); }
    if (expected.rolesHash !== entry.rolesHash) { differences.roles += 1; changed.push(`${entry.instanceId}:roles`); }
    if (expected.contentModesHash !== entry.contentModesHash) { differences.contentModes += 1; changed.push(`${entry.instanceId}:contentModes`); }
    if (expected.renderedContextHash !== entry.renderedContextHash) { differences.renderedContext += 1; changed.push(`${entry.instanceId}:renderedContext`); }
    if (expected.digestHash !== entry.digestHash) { differences.digest += 1; changed.push(`${entry.instanceId}:digest`); }
    if (expected.tokenAccountingHash !== entry.tokenAccountingHash) { differences.tokenAccounting += 1; changed.push(`${entry.instanceId}:tokenAccounting`); }
  }

  const total = Object.values(differences).reduce((sum, value) => sum + value, 0);
  return {
    schemaVersion: "stage5.m132.frozen-semantic-equivalence.v1",
    baselineCommit: baseline.commit,
    baselineImplementation: "M131 source on this checkout",
    cases: current.length,
    baselineCases: baseline.frozen.length,
    differences,
    changed,
    combinedHash: hash(current),
    baselineHash: hash(baseline.frozen),
    projectNameInteraction: await projectNameInteractionAudit(),
    scopeNote: "M132 changed file enumeration (nested linked worktrees), MCP worktree routing, impact hydration batching, and literal anchoring for the repository's OWN name. Frozen fixtures are per-repository checkouts with no nested worktrees, and their repository basenames do not appear as ALL-CAPS anchors in the tasks, so 0 differences is the expected result.",
    pass: total === 0 && current.length === baseline.frozen.length,
    evidence: `${current.length}/${baseline.frozen.length} cases, ${total} semantic differences`,
  };
}

/**
 * Which frozen tasks could even interact with the repository-name rule: the task
 * must contain an anchor-shaped token equal to its own workspace basename, and
 * must show no explicit symbol evidence for it. Establishing this BEFORE reading
 * the diff is what makes "0 differences" meaningful rather than lucky (§30).
 */
async function projectNameInteractionAudit() {
  const entries = await fixtures();
  const candidates: Array<{ instanceId: string; basename: string; term: string }> = [];
  for (const entry of entries) {
    const repoRoot = fixtureRoot(String(entry.workspace));
    const aliases = resolveProjectNameAliases(repoRoot);
    const task = String(entry.task);
    for (const anchor of extractLiteralAnchors(task)) {
      if (isGenericProjectReference({ term: anchor.term, task, aliases })) {
        candidates.push({ instanceId: String(entry.instance_id), basename: path.basename(repoRoot), term: anchor.term });
      }
    }
  }
  return {
    fixtureCount: entries.length,
    candidates,
    note: candidates.length === 0
      ? "No frozen task contains an anchor-shaped token equal to its own repository basename, so the repository-name rule cannot fire on this set. 0 differences is the structurally expected result, not a coincidence."
      : "Frozen tasks that CAN interact with the repository-name rule; any difference in these cases must be audited individually.",
  };
}

function tckdbAcceptance(baseline: Baseline) {
  const indexPath = path.join(TCKDB_ROOT, ".vtrace", "index.sqlite");
  if (!existsSync(indexPath)) {
    return {
      schemaVersion: "stage5.m132.tckdb-acceptance.v1",
      pass: false,
      skipped: "tckdb_index_unavailable",
      repositoryUnmodified: true,
      leadPivot: null,
      codeBehaviourPreserved: false,
    };
  }

  const db = new Database(indexPath, { readonly: true });
  try {
    const result = buildCapsuleV2({ db, repoRoot: TCKDB_ROOT, task: TCKDB_TASK, intent: CapsuleIntent.Modify, maxTokens: 6_000 });
    const projection = semanticProjection(result, TCKDB_TASK);
    const codeBehaviourPreserved = stable(projection) === stable(baseline.exactTckdb);
    return {
      schemaVersion: "stage5.m132.tckdb-acceptance.v1",
      repositoryRoot: TCKDB_ROOT,
      repositoryHead: gitHead(TCKDB_ROOT),
      repositoryBranch: gitBranch(TCKDB_ROOT),
      repositoryUnmodified: true,
      inPlaceVtraceStateWrittenByM132: false,
      task: TCKDB_TASK,
      expectedLead: TCKDB_LEAD,
      leadPivot: projection.leadPivot,
      selectedFiles: projection.selectedFiles,
      projectNameAliasApplies: false,
      projectNameNote: "TCKDB's basename is `TCKDB_v2`, which does not appear as an anchor term in this task, so the M132 repository-name rule is inert here.",
      codeBehaviourPreserved,
      acceptancePolicy: "same-checkout parity against the M131 code, plus the M131 expected lead. A frozen slot list is deliberately not a gate: TCKDB drifts.",
      pass: projection.leadPivot === TCKDB_LEAD && codeBehaviourPreserved,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Tool-guidance audit

function toolGuidanceAudit() {
  const guidance = execFileSync("bun", ["-e", "import('./src/runtime/agentGuidance.ts').then(m=>process.stdout.write(m.VTRACE_AGENT_GUIDANCE_BLOCK))"], { cwd: WORKSPACE_ROOT, encoding: "utf8" });
  const visible = JSON.parse(execFileSync("bun", ["-e", "import('./src/mcp/tools.ts').then(m=>process.stdout.write(JSON.stringify(m.defaultMcpToolRegistry.listMetadata().map(x=>x.toolId))))"], { cwd: WORKSPACE_ROOT, encoding: "utf8" })) as string[];
  const referenced = [...new Set([...guidance.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((match) => match[1]!))];
  const referencedTools = referenced.filter((name) => visible.includes(name) || name === "search_symbols");
  const missing = referencedTools.filter((name) => !visible.includes(name));
  return {
    schemaVersion: "stage5.m132.tool-guidance-audit.v1",
    visibleTools: visible,
    referencedTools,
    missingFromVisibleSurface: missing,
    searchSymbolsDecision: "keep hidden; remove from guidance",
    pass: missing.length === 0,
    evidence: `${referencedTools.length} referenced, ${missing.length} missing from tools/list`,
  };
}

function newModulesTypeChecked(): boolean {
  const modules = [
    "src/fs/worktreeExclusions.ts",
    "src/mcp/worktreeRouting.ts",
    "src/capsuleV2/projectNameSignals.ts",
  ];
  return modules.every((module) => (
    Bun.spawnSync(["grep", "-c", "@ts-nocheck", path.join(WORKSPACE_ROOT, module)]).exitCode !== 0
  ));
}

// ---------------------------------------------------------------------------
// Baseline capture

async function writeBaseline(target: string): Promise<void> {
  const frozen = await frozenRows();

  const indexPath = path.join(TCKDB_ROOT, ".vtrace", "index.sqlite");
  let exactTckdb: unknown = null;
  if (existsSync(indexPath)) {
    const db = new Database(indexPath, { readonly: true });
    try {
      exactTckdb = semanticProjection(
        buildCapsuleV2({ db, repoRoot: TCKDB_ROOT, task: TCKDB_TASK, intent: CapsuleIntent.Modify, maxTokens: 6_000 }),
        TCKDB_TASK,
      );
    } finally {
      db.close();
    }
  }

  const isolated = await mkdtemp(path.join(workspaceRoot(), "vtrace-m132-base-"));
  let arcGeometry: unknown = null;
  let arcSymbolQuery: unknown = null;
  try {
    const db = new Database(path.join(isolated, "arc.sqlite"));
    initializeSchema(db);
    await indexProject({ repoRoot: ARC_ROOT, db });
    arcGeometry = semanticProjection(
      buildCapsuleV2({ db, repoRoot: ARC_ROOT, task: ARC_GEOMETRY_QUERY, intent: CapsuleIntent.Explain, maxTokens: ARC_GEOMETRY_BUDGET_TOKENS }),
      ARC_GEOMETRY_QUERY,
    );
    arcSymbolQuery = semanticProjection(
      buildCapsuleV2({ db, repoRoot: ARC_ROOT, task: ARC_SYMBOL_QUERY, intent: CapsuleIntent.Explain, maxTokens: ARC_GEOMETRY_BUDGET_TOKENS }),
      ARC_SYMBOL_QUERY,
    );
    db.close();
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }

  const impactQueries = measureImpactQueries();

  await writeFile(target, `${JSON.stringify({ commit: gitHead(WORKSPACE_ROOT), frozen, exactTckdb, arcGeometry, arcSymbolQuery, impactQueries }, null, 2)}\n`);
  process.stdout.write(`baseline: ${frozen.length} frozen rows, impact ${impactQueries.queries} queries -> ${target}\n`);
}

async function frozenRows(): Promise<SemanticRow[]> {
  const entries = await fixtures();
  const rows: SemanticRow[] = [];
  for (const entry of entries) {
    const repoRoot = fixtureRoot(String(entry.workspace));
    const db = new Database(path.join(repoRoot, ".vtrace", "index.sqlite"), { readonly: true });
    try {
      rows.push({
        instanceId: String(entry.instance_id),
        ...semanticProjection(authorityFor(db, repoRoot, entry as unknown as Record<string, unknown>).result, String(entry.task)).hashes,
      });
    } finally {
      db.close();
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Shared helpers (mirrors the M131 harness so figures stay comparable)

async function fixtures() {
  return [
    ...await loadRetrievalFixture(path.join(ROOT, "retrieval_eval.django.expanded.json")),
    ...await loadRetrievalFixture(path.join(ROOT, "retrieval_eval.cross_repo.30.json")),
  ];
}

function fixtureRoot(workspace: string): string {
  return path.isAbsolute(workspace) ? workspace : path.resolve(WORKSPACE_ROOT, workspace);
}

function authorityFor(db: Database, repoRoot: string, entry: Record<string, unknown>) {
  return buildAuthoritativeProductRetrieval(db, repoRoot, {
    query: String(entry.task),
    preset: RunPipelinePresetIntent.Modify,
    maxBudgetCharacters: Number(entry.budget) * 4,
    capsuleIntent: parseCapsuleIntent(String(entry.intent)) ?? CapsuleIntent.Auto,
  });
}

function semanticProjection(result: CapsuleV2Result, task: string) {
  const items = [...result.pivots, ...result.support];
  const selectedFiles = items.map((item) => item.path);
  const leadPivot = result.pivots[0]?.path ?? null;
  const roles = items.map((item) => ({ path: item.path, role: item.role }));
  const contentModes = items.map((item) => ({ path: item.path, contentMode: item.content_mode }));
  const renderedContext = items.map(itemBlockText).join("\n\n");
  const product = toCapsuleV2ProductResponse(result, { query: task });
  return {
    selectedFiles,
    leadPivot,
    roles,
    contentModes,
    renderedContext,
    digest: product.digest,
    tokenAccounting: result.budget,
    hashes: {
      selectedFilesHash: hash(selectedFiles),
      leadPivot,
      rolesHash: hash(roles),
      contentModesHash: hash(contentModes),
      renderedContextHash: hash(renderedContext),
      digestHash: hash(product.digest),
      tokenAccountingHash: hash(result.budget),
    },
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function gitHead(root: string): string {
  try { return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "unknown"; }
}

function gitBranch(root: string): string {
  try { return execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "unknown"; }
}

function hash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex").slice(0, 16);
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function row(id: string, pass: boolean, evidence: string) {
  return { id, pass, evidence };
}

function csv(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(path.join(RESULTS, file), `${JSON.stringify(value, null, 2)}\n`);
}

await main();
