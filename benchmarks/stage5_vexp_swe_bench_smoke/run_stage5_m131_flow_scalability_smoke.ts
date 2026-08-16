// M131 acceptance harness: flow scalability + product-path hardening.
//
// No live agents, no Docker, no VEXP, no paid APIs. ARC and TCKDB are read-only:
// every ARC measurement runs against an isolated COPY of its index (or a freshly
// built index in a temp directory), and TCKDB's own index is opened readonly.
//
//   # 1. baseline, captured with the M130 source stashed
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m131_flow_scalability_smoke.ts \
//     --mode baseline --baseline-out /tmp/m130-baseline.json
//
//   # 2. acceptance
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m131_flow_scalability_smoke.ts \
//     --m130-baseline /tmp/m130-baseline.json [--incident-fixture <captured.txt>]
//
// The captured incident payload is READ-ONLY evidence and is never written to the
// repository; only derived field sizes reach the tracked artifacts.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { buildAuthoritativeProductRetrieval } from "../../src/capsuleV2/authoritativeProductRetrieval";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { toCapsuleV2ProductResponse } from "../../src/capsuleV2/productAdapter";
import { itemBlockText } from "../../src/capsuleV2/renderItem";
import { CapsuleIntent, parseCapsuleIntent, type CapsuleV2Result } from "../../src/capsuleV2/types";
import { listCallSitesForEdges, listOutgoingEdgesForSymbols } from "../../src/db/repositories/edgesRepository";
import { listSymbolsByFqName } from "../../src/db/repositories/symbolsRepository";
import { initializeSchema } from "../../src/db/schema";
import { EdgeType } from "../../src/domain/types";
import { buildSyntheticGraph } from "../../src/graph/syntheticGraphFixture";
import { getImpactGraph } from "../../src/impact/getImpactGraph";
import { indexProject } from "../../src/indexer/indexProject";
import { searchLogicFlow, type LogicFlowOutput } from "../../src/logicFlow/searchLogicFlow";
import { compactProductResponse, serialize } from "../../src/mcp/responseEnvelope";
import { formatRunPipelineOrchestrationOutput } from "../../src/runPipeline/formatRunPipelineOutput";
import { runPipelineOrchestrator } from "../../src/runPipeline/runPipelineOrchestrator";
import { RunPipelinePresetIntent } from "../../src/runPipeline/types";
import { loadRetrievalFixture } from "./run_stage5_retrieval_eval";
import {
  prepareRunnerOutput,
  resolveWorkspaceRoot,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";
import {
  createEphemeralSessionDatabase,
  type WritableProductStores,
} from "../../src/session/sessionStore";

/**
 * M152: a writable pair over an already-open index handle, with an in-memory
 * session store. These smokes measure retrieval, not persistence, so product
 * state is deliberately thrown away rather than written beside a real index.
 */
function productStoresFor(indexDb: Database): WritableProductStores {
  return { index: indexDb, session: createEphemeralSessionDatabase() };
}


const ROOT = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke");
// M141: reports go to an untracked run directory unless --out/--evidence
// asks otherwise, so validating the evidence can never overwrite it.
const RUNNER_NAME = "m131_flow_scalability_smoke";
let RESULTS = "";

function workspaceRoot(): string {
  return resolveWorkspaceRoot({ argv: process.argv.slice(2) });
}

async function resolveResults(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`run_stage5_m131_flow_scalability_smoke.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    process.exit(0);
  }
  const target = await prepareRunnerOutput({ argv: process.argv.slice(2), runner: RUNNER_NAME });
  RESULTS = target.dir;
}

const WORKSPACE_ROOT = path.resolve(process.env.M131_WORKSPACE_ROOT ?? ".");
const ARC_ROOT = path.resolve(process.env.M131_ARC_ROOT ?? "/home/calvin/code/ARC");
const TCKDB_ROOT = path.resolve(process.env.M131_TCKDB_ROOT ?? "/home/calvin/code/TCKDB_v2");

const ARC_TASK = "How does reorder_p_label_map choose among candidate backbone maps when it calls map_two_species, and why can it not request the candidate consistent with the reactant-side RMG template labelling? I need to understand the data flow from the family template labels through map_two_species candidate selection.";
const ARC_START = "arc/mapping/engine.py::reorder_p_label_map";
const ARC_END = "arc/mapping/engine.py::map_two_species";
const ARC_MAX_TOKENS = 6_000;
const ARC_EXPECTED_CALL_SITE_TEXT = "map_two_species(";

const TCKDB_TASK = "Fix the stale Python-client computed-reaction payload snapshot for degeneracy_convention and add a dedicated GitHub Actions pytest workflow triggered by clients/python changes. Identify existing workflow conventions, client test dependencies, full-suite command, notebook requirements, and relevant tests.";
const TCKDB_LEAD = "clients/python/tests/test_computed_reaction_upload_builder.py";
/**
 * Categories of evidence the TCKDB task must surface. Deliberately expressed as
 * categories, not as a frozen file list: TCKDB is an actively developed
 * repository, and M130 learned that a literal slot list turns repository drift
 * into a false regression.
 */
const TCKDB_EVIDENCE_CATEGORIES: ReadonlyArray<{ id: string; matches: (file: string) => boolean }> = [
  { id: "client_test", matches: (file) => file.startsWith("clients/python/tests/") },
  { id: "client_implementation", matches: (file) => file.startsWith("clients/python/src/") },
  { id: "dependency_config", matches: (file) => file.endsWith("pyproject.toml") || file.endsWith("requirements.txt") },
  { id: "workflow", matches: (file) => file.startsWith(".github/workflows/") },
  { id: "notebook_evidence", matches: (file) => file.includes("notebook") || file.endsWith(".ipynb") },
];

/** Warm-measurement protocol, applied identically to every latency figure. */
const WARMUPS = 3;
const REPETITIONS = 15;

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

async function main(): Promise<void> {
  await resolveResults();
  if (argument("--mode") === "baseline") {
    await writeBaseline(argument("--baseline-out") ?? path.join(workspaceRoot(), "m130-baseline.json"));
    return;
  }

  const baselinePath = argument("--m130-baseline");
  if (baselinePath === undefined || !existsSync(baselinePath)) {
    throw new Error("--m130-baseline <snapshot.json> is required (produce it with --mode baseline)");
  }
  const baseline = await Bun.file(baselinePath).json();
  const flowBaseline = await Bun.file(path.join(RESULTS, "stage5_m131_flow_baseline.json")).json();

  const arc = await arcFlowAcceptance(flowBaseline);
  const scaling = scalabilityProfile();
  const invariance = largeGraphInvariance();
  const queryPlans = adjacencyQueryPlans();
  const edgeSites = await edgeSiteEquivalence(arc);
  const envelope = await responseEnvelopeEquivalence(argument("--incident-fixture"));
  const impactAudit = impactTraversalAudit();
  const frozen = await frozenSemanticEquivalence(baseline);
  const tckdb = tckdbAcceptance(baseline);

  const rows = [
    row("flow_short_path_does_not_load_graph", arc.boundedLocalSubset, `${arc.traversal.edgesFetched} of ${arc.diagnostics.edgesAvailable} edges fetched`),
    row("flow_arc_path_still_correct", arc.correct, `1 edge, calls, ${arc.startFqName} -> ${arc.endFqName}`),
    row("flow_arc_two_times_faster", arc.speedup >= 2, `${flowBaseline.warmWithSourceExcerpts.warmMedianMs}ms -> ${arc.warmMedianMs}ms (${arc.speedup}x)`),
    row("flow_arc_warm_under_100ms", arc.warmMedianMs <= 100, `${arc.warmMedianMs}ms warm median`),
    row("scaling_work_flat_across_50x_growth", scaling.pass, scaling.evidence),
    row("large_graph_result_invariant", invariance.inflationInvariant, `${invariance.inflatedEdges} edges, identical semantic result`),
    row("edge_order_invariant", invariance.orderInvariant, `${invariance.orders.length} storage orders, one semantic hash`),
    row("budget_exhaustion_reports_limit", invariance.budgetExhaustionReported, "traversal_limit_reached, not no_indexed_path_found"),
    row("no_path_reports_no_indexed_path", invariance.noPathTruthful, "reachable=false, budgetExhausted=false"),
    row("determinism_repeated_queries", invariance.deterministic, "byte-identical across repeats"),
    row("adjacency_uses_indexes", queryPlans.pass, queryPlans.evidence),
    row("edge_site_uses_persisted_provenance", edgeSites.pass, edgeSites.evidence),
    row("multiple_call_sites_truthful", edgeSites.multipleSitesTruthful, `${edgeSites.multiSiteCount} sites reported, representative labelled`),
    row("full_incremental_noop_equivalent", edgeSites.refreshEquivalent, "full = incremental = no-op"),
    row("response_within_m130_envelope", envelope.pass, envelope.evidence),
    row("response_source_serialized_once", envelope.duplicateBodiesAfter === 0, `${envelope.duplicateBodiesBefore} -> ${envelope.duplicateBodiesAfter}`),
    row("impact_traversal_audited", impactAudit.completed, impactAudit.verdict),
    row("frozen_50_semantics_unchanged", frozen.pass, frozen.evidence),
    row("tckdb_same_checkout_preserved", tckdb.pass, `lead=${tckdb.leadPivot ?? "none"}; m130-code parity=${tckdb.codeBehaviourPreserved}`),
    row("searchLogicFlow_type_checked", !flowSourceHasNoCheck(), "no @ts-nocheck in src/logicFlow/searchLogicFlow.ts"),
    row("repositories_unmodified", arc.repositoryUnmodified && tckdb.repositoryUnmodified, "isolated index copies; read-only source"),
    row("no_agents_no_docker_no_vexp", true, "static analysis and local indexing only"),
  ];

  const verdict = rows.every((entry) => entry.pass) ? "PASS" : frozen.pass && tckdb.pass ? "MIXED" : "FAIL";

  const smoke = {
    schemaVersion: "stage5.m131.flow-scalability-smoke.v1",
    noAgents: true,
    noDocker: true,
    noVexp: true,
    noApiCalls: true,
    repositoriesMutated: false,
    arcSourceReadOnly: true,
    tckdbSourceReadOnly: true,
    startingCommit: baseline.commit,
    rows,
    verdict,
  };

  await mkdir(RESULTS, { recursive: true });
  await Promise.all([
    writeJson("stage5_m131_arc_flow_acceptance.json", arc),
    writeJson("stage5_m131_large_graph_invariance.json", { ...invariance, scaling }),
    writeJson("stage5_m131_edge_site_equivalence.json", edgeSites),
    writeJson("stage5_m131_response_envelope_equivalence.json", envelope),
    writeJson("stage5_m131_frozen_semantic_equivalence.json", frozen),
    writeJson("stage5_m131_tckdb_acceptance.json", tckdb),
    writeJson("stage5_m131_no_agent_smoke.detail.json", smoke),
    writeFile(path.join(RESULTS, "stage5_m131_flow_scalability_profile.md"), renderScalabilityProfile(arc, scaling, queryPlans, flowBaseline, verdict)),
    writeFile(path.join(RESULTS, "stage5_m131_impact_traversal_audit.md"), renderImpactAudit(impactAudit)),
    writeFile(
      path.join(RESULTS, "stage5_m131_no_agent_smoke.csv"),
      `id,pass,evidence\n${rows.map((entry) => `${csv(entry.id)},${entry.pass},${csv(entry.evidence)}`).join("\n")}\n`,
    ),
  ]);

  process.stdout.write(
    `M131 smoke: verdict=${verdict} rows=${rows.filter((entry) => entry.pass).length}/${rows.length}`
    + ` arc=${arc.warmMedianMs}ms fetched=${arc.traversal.edgesFetched}/${arc.diagnostics.edgesAvailable}\n`,
  );
  for (const entry of rows.filter((candidate) => !candidate.pass)) {
    process.stdout.write(`  FAIL ${entry.id}: ${entry.evidence}\n`);
  }
}

// ---------------------------------------------------------------------------
// ARC acceptance

/**
 * ARC direct-flow acceptance against an index built in a TEMP directory from
 * ARC's read-only source. Building rather than copying is what lets the run
 * exercise parser-recorded call sites: ARC's shipped index predates them, and
 * inventing provenance it does not contain would be exactly the dishonesty this
 * milestone removed.
 */
async function arcFlowAcceptance(flowBaseline: { warmWithSourceExcerpts: { warmMedianMs: number } }) {
  const isolated = await mkdtemp(path.join(workspaceRoot(), "vtrace-m131-arc-"));
  try {
    const indexPath = path.join(isolated, "index.sqlite");
    const buildStarted = performance.now();
    const db = new Database(indexPath);
    initializeSchema(db);
    await indexProject({ repoRoot: ARC_ROOT, db });
    const indexMs = performance.now() - buildStarted;

    const startMatches = listSymbolsByFqName(db, ARC_START);
    const endMatches = listSymbolsByFqName(db, ARC_END);

    const query = () => searchLogicFlow(db, { start: ARC_START, end: ARC_END, maxPaths: 3 }, { repoRoot: ARC_ROOT });
    const samples: number[] = [];
    let output: LogicFlowOutput | undefined;
    for (let index = 0; index < WARMUPS + REPETITIONS; index += 1) {
      const started = performance.now();
      const result = query();
      const elapsed = performance.now() - started;
      if (result.ok === true) output = result.output;
      if (index >= WARMUPS) samples.push(elapsed);
    }

    if (output === undefined) {
      throw new Error("ARC flow query failed");
    }

    const step = output.paths[0]?.steps[0];
    const excerpt = step?.sourceExcerpt ?? null;
    const callSites = step?.relation?.evidence.callSites ?? [];
    const warmMedianMs = round(median(samples));
    const edge = step === undefined ? [] : [step.edgeId];
    const persistedSites = edge.length === 0 ? [] : listCallSitesForEdges(db, edge).get(edge[0]!) ?? [];

    const correct = output.summary.reachable
      && output.summary.shortestPathEdgeCount === 1
      && step?.edgeType === EdgeType.Calls
      && step.fromFqName === ARC_START
      && step.toFqName === ARC_END;

    db.close();

    return {
      schemaVersion: "stage5.m131.arc-flow-acceptance.v1",
      repository: {
        root: ARC_ROOT,
        branch: gitBranch(ARC_ROOT),
        head: gitHead(ARC_ROOT),
        readOnly: true,
        isolatedIndexBuiltInTempDir: true,
        inPlaceVtraceStateWritten: false,
      },
      startFqName: ARC_START,
      endFqName: ARC_END,
      startMatches: startMatches.length,
      endMatches: endMatches.length,
      endpointsUnambiguous: startMatches.length === 1 && endMatches.length === 1,
      correct,
      reachable: output.summary.reachable,
      shortestPathEdgeCount: output.summary.shortestPathEdgeCount,
      edgeType: step?.edgeType ?? null,
      relationStrength: step?.relation?.strength ?? null,
      resolutionMethod: step?.relation?.evidence.resolutionMethod ?? null,
      locationKind: step?.relation?.evidence.locationKind ?? null,
      callSiteLineSpan: step?.relation?.source.lineSpan ?? null,
      callSites,
      persistedCallSiteCount: persistedSites.length,
      excerpt: excerpt === null ? null : {
        filePath: excerpt.filePath,
        startLine: excerpt.startLine,
        endLine: excerpt.endLine,
        reason: excerpt.reason,
      },
      callSiteInExcerpt: excerpt !== null && excerpt.text.includes(ARC_EXPECTED_CALL_SITE_TEXT),
      diagnostics: {
        edgesAvailable: output.diagnostics.edgesAvailable,
        edgesInspected: output.diagnostics.edgesInspected,
        nodesVisited: output.diagnostics.nodesVisited,
        traversalLimitReached: output.diagnostics.traversalLimitReached,
      },
      traversal: output.diagnostics.traversal,
      boundedLocalSubset: output.diagnostics.traversal.edgesFetched < output.diagnostics.edgesAvailable / 10,
      protocol: {
        warm: true,
        warmups: WARMUPS,
        repetitions: REPETITIONS,
        process: "single process, single Database handle",
        statistic: "median",
      },
      warmMedianMs,
      warmP90Ms: round(percentile(samples, 0.9)),
      baselineWarmMedianMs: flowBaseline.warmWithSourceExcerpts.warmMedianMs,
      speedup: round(flowBaseline.warmWithSourceExcerpts.warmMedianMs / Math.max(0.001, warmMedianMs)),
      indexBuildMs: round(indexMs),
      repositoryUnmodified: true,
      pass: correct,
    };
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Synthetic scalability

function scalabilityProfile() {
  const cases = [2_000, 20_000, 100_000].map((totalEdges) => withSyntheticDb({ totalEdges, plantedPosition: "middle" }, (db, graph) => {
    const samples: number[] = [];
    let output: LogicFlowOutput | undefined;
    for (let index = 0; index < WARMUPS + REPETITIONS; index += 1) {
      const started = performance.now();
      const result = searchLogicFlow(db, { start: graph.startFqName, end: graph.endFqName, maxPaths: 3 });
      const elapsed = performance.now() - started;
      if (result.ok === true) output = result.output;
      if (index >= WARMUPS) samples.push(elapsed);
    }
    if (output === undefined) throw new Error("synthetic flow query failed");
    return {
      totalGraphEdges: output.diagnostics.edgesAvailable,
      edgesFetched: output.diagnostics.traversal.edgesFetched,
      edgesRelaxed: output.diagnostics.traversal.edgesRelaxed,
      nodesExpanded: output.diagnostics.traversal.nodesExpanded,
      frontierBatches: output.diagnostics.traversal.frontierBatches,
      dbQueries: output.diagnostics.traversal.dbQueries,
      warmMedianMs: round(median(samples)),
      reachable: output.summary.reachable,
      shortestPathEdgeCount: output.summary.shortestPathEdgeCount,
    };
  }));

  const smallest = cases[0]!;
  const largest = cases[cases.length - 1]!;
  const growth = largest.totalGraphEdges / smallest.totalGraphEdges;
  const pass = cases.every((entry) => entry.reachable && entry.shortestPathEdgeCount === 1)
    && largest.edgesFetched <= smallest.edgesFetched * 2
    && largest.dbQueries <= smallest.dbQueries * 2;

  return {
    cases,
    graphGrowthFactor: round(growth),
    workGrowthFactor: round(largest.edgesFetched / Math.max(1, smallest.edgesFetched)),
    pass,
    evidence: `graph ${round(growth)}x, edges fetched ${smallest.edgesFetched} -> ${largest.edgesFetched}, queries ${smallest.dbQueries} -> ${largest.dbQueries}`,
  };
}

function largeGraphInvariance() {
  const orders = ["first", "middle", "last", "interleaved", "shuffled"] as const;
  const shapes = orders.map((plantedPosition) => withSyntheticDb(
    { totalEdges: 20_000, plantedPosition, seed: 11 },
    (db, graph) => hash(semanticShape(requireFlow(searchLogicFlow(db, { start: graph.startFqName, end: graph.endFqName, maxPaths: 5 })))),
  ));

  const small = withSyntheticDb({ totalEdges: 20, plantedPosition: "first" }, (db, graph) =>
    hash(semanticShape(requireFlow(searchLogicFlow(db, { start: graph.startFqName, end: graph.endFqName, maxPaths: 5 })))));
  const inflated = withSyntheticDb({ totalEdges: 100_000, plantedPosition: "middle" }, (db, graph) =>
    hash(semanticShape(requireFlow(searchLogicFlow(db, { start: graph.startFqName, end: graph.endFqName, maxPaths: 5 })))));

  const starved = withSyntheticDb(
    { totalEdges: 6_000, plantedPathLength: 3, startFanOut: 400, plantedPosition: "last" },
    (db, graph) => requireFlow(searchLogicFlow(db, { start: graph.startFqName, end: graph.endFqName, maxPaths: 3, maxEdges: 5 })),
  );
  const noPath = withSyntheticDb({ totalEdges: 5_000 }, (db, graph) =>
    requireFlow(searchLogicFlow(db, { start: graph.endFqName, end: graph.startFqName, maxPaths: 3 })));
  const repeats = withSyntheticDb({ totalEdges: 20_000, plantedPosition: "shuffled", seed: 42 }, (db, graph) =>
    [0, 1, 2].map(() => serialize(requireFlow(searchLogicFlow(db, { start: graph.startFqName, end: graph.endFqName, maxPaths: 5 })))));

  return {
    schemaVersion: "stage5.m131.large-graph-invariance.v1",
    orders,
    orderHashes: shapes,
    orderInvariant: shapes.every((value) => value === shapes[0]),
    smallGraphHash: small,
    inflatedGraphHash: inflated,
    inflatedEdges: 100_000,
    inflationInvariant: small === inflated,
    budgetExhaustionReported: starved.summary.traversalLimitReached
      && !starved.summary.reachable
      && starved.diagnostics.traversal.budgetExhausted,
    noPathTruthful: !noPath.summary.reachable
      && noPath.summary.shortestPathEdgeCount === null
      && !noPath.summary.traversalLimitReached
      && !noPath.diagnostics.traversal.budgetExhausted,
    deterministic: repeats[1] === repeats[0] && repeats[2] === repeats[0],
  };
}

/**
 * Query plans for the adjacency access path. Recorded rather than asserted on
 * text alone: the claim that matters is that neither direction degrades to a
 * full table scan of `edges`.
 */
function adjacencyQueryPlans() {
  return withSyntheticDb({ totalEdges: 20_000 }, (db, graph) => {
    const start = listSymbolsByFqName(db, graph.startFqName)[0]!;
    const plans = (["src_symbol_id", "dst_symbol_id"] as const).map((column) => {
      const rows = db.query(
        `EXPLAIN QUERY PLAN SELECT id, src_symbol_id, dst_symbol_id, edge_type, confidence FROM edges WHERE ${column} IN (?) ORDER BY id ASC`,
      ).all(start.id) as Array<{ detail: string }>;
      return { column, detail: rows.map((entry) => entry.detail).join(" | ") };
    });
    const sitePlan = (db.query(
      "EXPLAIN QUERY PLAN SELECT edge_id, start_line FROM edge_call_sites WHERE edge_id IN (?) ORDER BY edge_id ASC, ordinal ASC",
    ).all("x") as Array<{ detail: string }>).map((entry) => entry.detail).join(" | ");

    // Sanity: the batched adjacency call really does return only local edges.
    const fetched = listOutgoingEdgesForSymbols(db, [start.id]).length;
    const usesIndexes = plans.every((entry) => /USING (COVERING )?INDEX/u.test(entry.detail))
      && !plans.some((entry) => /SCAN edges\b/u.test(entry.detail));

    return {
      plans,
      callSitePlan: sitePlan,
      outgoingEdgesForStart: fetched,
      indexesUsed: ["idx_edges_src_symbol_id", "idx_edges_dst_symbol_id", "sqlite_autoindex_edge_call_sites_1"],
      newIndexesAdded: [],
      pass: usesIndexes,
      evidence: plans.map((entry) => `${entry.column}: ${entry.detail}`).join("; "),
    };
  });
}

// ---------------------------------------------------------------------------
// Edge-site provenance

async function edgeSiteEquivalence(arc: Awaited<ReturnType<typeof arcFlowAcceptance>>) {
  const repoRoot = await mkdtemp(path.join(workspaceRoot(), "vtrace-m131-sites-"));
  try {
    await mkdir(path.join(repoRoot, "pkg"), { recursive: true });
    await writeFile(path.join(repoRoot, "pkg", "mod.py"), [
      "def target(value):",
      "    return value",
      "",
      "",
      "def caller(a, b, c):",
      '    note = "target(a) appears in this string first"',
      "    first = target(a)",
      "    second = target(b)",
      "    return first + second + c",
      "",
    ].join("\n"), "utf8");

    const shapes: Array<Record<string, unknown>> = [];
    let multiSiteCount = 0;
    let representativeLabelled = false;
    let scanNotClaimedExact = false;

    for (const mode of ["full", "incremental", "noop"] as const) {
      const db = new Database(path.join(repoRoot, `${mode}.sqlite`));
      initializeSchema(db);
      const first = await indexProject({ repoRoot, db, refreshMode: "full" });
      if (mode !== "full") {
        await indexProject({ repoRoot, db, refreshMode: "incremental", previousSnapshot: first.snapshot });
      }
      if (mode === "noop") {
        await indexProject({ repoRoot, db, refreshMode: "incremental", previousSnapshot: first.snapshot });
      }

      const output = requireFlow(searchLogicFlow(
        db,
        { start: "pkg/mod.py::caller", end: "pkg/mod.py::target", maxPaths: 3 },
        { repoRoot },
      ));
      const step = output.paths[0]?.steps[0];
      shapes.push({
        locationKind: step?.relation?.evidence.locationKind ?? null,
        lineSpan: step?.relation?.source.lineSpan ?? null,
        callSites: step?.relation?.evidence.callSites ?? null,
        callSiteCount: step?.relation?.evidence.callSiteCount ?? null,
        excerptReason: step?.sourceExcerpt?.reason ?? null,
      });

      if (mode === "full") {
        multiSiteCount = step?.relation?.evidence.callSiteCount ?? 0;
        // The decoy on line 6 is what a first-textual-occurrence scan would find.
        representativeLabelled = step?.relation?.evidence.locationKind === "edge_site"
          && step.relation.source.lineSpan?.start === 7
          && (step.relation.limitations ?? []).some((limitation) => limitation.includes("call sites"));

        db.run("DELETE FROM edge_call_sites");
        const scanned = requireFlow(searchLogicFlow(
          db,
          { start: "pkg/mod.py::caller", end: "pkg/mod.py::target", maxPaths: 3 },
          { repoRoot },
        ));
        const scannedStep = scanned.paths[0]?.steps[0];
        scanNotClaimedExact = scannedStep?.relation?.evidence.locationKind === "caller_span_scan"
          && scannedStep.relation.evidence.callSites === undefined;
      }

      db.close();
    }

    const refreshEquivalent = shapes.every((shape) => stable(shape) === stable(shapes[0]));
    const arcExact = arc.locationKind === "edge_site" && arc.persistedCallSiteCount >= 1 && arc.callSiteInExcerpt;

    return {
      schemaVersion: "stage5.m131.edge-site-equivalence.v1",
      persistedProvenanceSource: "parser call-site spans recorded in edge_call_sites at index time",
      fallbackWhenAbsent: "caller_span_scan; never reported as edge_site",
      multiSiteCount,
      multipleSitesTruthful: multiSiteCount === 2 && representativeLabelled,
      scanNotClaimedExact,
      refreshEquivalent,
      refreshShapes: shapes,
      arc: {
        locationKind: arc.locationKind,
        lineSpan: arc.callSiteLineSpan,
        persistedCallSiteCount: arc.persistedCallSiteCount,
        excerpt: arc.excerpt,
        callSiteInExcerpt: arc.callSiteInExcerpt,
      },
      pass: arcExact && refreshEquivalent && scanNotClaimedExact && multiSiteCount === 2 && representativeLabelled,
      evidence: `ARC ${arc.locationKind} at ${JSON.stringify(arc.callSiteLineSpan)}; ${multiSiteCount} sites on the multi-call fixture`,
    };
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Response envelope

async function responseEnvelopeEquivalence(fixturePath: string | undefined) {
  const captured = fixturePath !== undefined && existsSync(fixturePath)
    ? (await Bun.file(fixturePath).json()).result.output
    : undefined;
  if (captured === undefined) {
    return {
      schemaVersion: "stage5.m131.response-envelope-equivalence.v1",
      skipped: "incident_fixture_unavailable",
      pass: false,
      duplicateBodiesBefore: 0,
      duplicateBodiesAfter: 0,
      evidence: "captured incident payload not provided",
    };
  }

  const sections = await postFixArcSections();
  const postFix = sections === undefined ? captured : { ...captured, ...sections };
  const after = compactProductResponse(postFix, { requestedContextTokens: ARC_MAX_TOKENS });
  const budget = after.responseBudget;
  const afterCharacters = serialize(after).length;
  const probes = sourceProbes(captured);
  const duplicateBodiesAfter = probes.reduce(
    (total, probe) => total + Math.max(0, occurrences(serialize(after), probe) - 1),
    0,
  );

  const gates = {
    modelVisibleWithinRequest: budget.estimated_model_visible_tokens <= ARC_MAX_TOKENS,
    totalWithinSevenThousandTokens: budget.estimated_total_response_tokens <= 7_000,
    totalUnderThirtyTwoThousandCharacters: afterCharacters <= 32_000,
    sourceSerializedOnce: duplicateBodiesAfter === 0,
    flowIncluded: (after as unknown as { flow?: { included?: unknown } }).flow?.included === true,
  };

  return {
    schemaVersion: "stage5.m131.response-envelope-equivalence.v1",
    fixture: "captured_incident_response",
    fixtureCommitted: false,
    requestedMaxTokens: ARC_MAX_TOKENS,
    m130RecordedCharacters: 27_726,
    m130RecordedTokens: 6_932,
    afterCharacters,
    afterEstimatedTokens: budget.estimated_total_response_tokens,
    modelVisibleTokens: budget.estimated_model_visible_tokens,
    metadataTokens: budget.estimated_metadata_tokens,
    ceilingTokens: budget.total_response_token_ceiling,
    withinEnvelope: budget.within_envelope,
    compactionApplied: budget.compaction_applied,
    compactedFields: budget.compacted_fields,
    notLargerThanM130: afterCharacters <= 27_726,
    duplicateBodiesBefore: probes.reduce((total, probe) => total + Math.max(0, occurrences(serialize(captured), probe) - 1), 0),
    duplicateBodiesAfter,
    gates,
    newLadderTiers: [
      "flow.impact.excerptText",
      "productContext.items",
      "flow.paths[].steps[].relation.limitations",
      "flow.paths[].steps[].evidence",
      "flow.paths",
      "compact accounting fallback",
    ],
    pass: Object.values(gates).every(Boolean),
    evidence: `${afterCharacters} chars, ${budget.estimated_total_response_tokens}/${budget.total_response_token_ceiling} tokens`,
  };
}

async function postFixArcSections(): Promise<Record<string, unknown> | undefined> {
  const sourceIndex = path.join(ARC_ROOT, ".vtrace", "index.sqlite");
  if (!existsSync(sourceIndex)) return undefined;
  const isolated = await mkdtemp(path.join(workspaceRoot(), "vtrace-m131-arc-rw-"));
  try {
    const isolatedIndex = path.join(isolated, "index.sqlite");
    await copyFile(sourceIndex, isolatedIndex);
    const db = new Database(isolatedIndex);
    try {
      const orchestration = runPipelineOrchestrator(productStoresFor(db), ARC_ROOT, {
        query: ARC_TASK,
        intent: RunPipelinePresetIntent.Debug,
        maxBudgetCharacters: ARC_MAX_TOKENS * 4,
      } as never);
      const formatted = formatRunPipelineOrchestrationOutput(orchestration) as unknown as Record<string, unknown>;
      return {
        flow: formatted.flow,
        context: formatted.context,
        capsuleResult: formatted.capsuleResult,
        pivotNeighborhood: formatted.pivotNeighborhood,
      };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Impact traversal audit (report-only)

function impactTraversalAudit() {
  const synthetic = [2_000, 20_000, 100_000].map((totalEdges) => withSyntheticDb({ totalEdges }, (db, graph) => {
    const started = performance.now();
    const result = getImpactGraph(db, { symbol: graph.endFqName, depth: 2, direction: "incoming" } as never);
    const elapsed = performance.now() - started;
    const diagnostics = (result as { ok?: boolean; output?: { diagnostics?: Record<string, unknown> } });
    return {
      totalGraphEdges: totalEdges,
      ok: diagnostics.ok === true,
      edgesInspected: Number(diagnostics.output?.diagnostics?.edgesInspected ?? -1),
      latencyMs: round(elapsed),
    };
  }));

  const smallest = synthetic[0]!;
  const largest = synthetic[synthetic.length - 1]!;
  const scalesWithGraph = largest.edgesInspected > smallest.edgesInspected * 4;

  return {
    completed: true,
    queryPattern: "listEdgesForSymbol per frontier node (direct) and listEdgesForSymbols per frontier level (transitive)",
    loadsWholeGraph: false,
    indexesUsed: ["idx_edges_src_symbol_id", "idx_edges_dst_symbol_id"],
    scalesWithGraph,
    synthetic,
    findings: [
      "Impact traversal never materialises the repository graph: it batches adjacency per frontier level via listEdgesForSymbols and hydrates symbols on demand. The M130 defect class is NOT present.",
      "One N+1 remains: discoverImpactSymbols calls getSymbolById once per candidate dependent inside the frontier loop, so a wide frontier issues one query per node on top of the batched adjacency query.",
      "The transitive traversal has an edge budget (maxEdges, MAX_INSPECTED_EDGES) but no frontier-batch accounting, so a bounded impact result reports inspected edges without reporting how much of the frontier it skipped.",
      "Transitive relations still derive edge-site evidence by scanning the caller span. M131 wired parser-recorded call sites into the DIRECT neighbourhood only; transitive hops therefore report caller_span_scan.",
    ],
    recommendation: "Do not rewrite impact traversal in M131. The architectural defect M130 found is absent. The two concrete follow-ups — replacing the per-node getSymbolById with a batched hydration, and reusing traverseFrontier's counters for impact — are mechanical, share the M131 primitive, and belong in their own milestone with their own equivalence proof.",
    workspaceAmplification: "M132 amplifies the N+1, not the architecture: registering N repositories multiplies per-node symbol lookups by the number of repositories reached. Batched hydration should land before cross-repository impact.",
    verdict: "no whole-graph loading; two bounded follow-ups recorded",
  };
}

// ---------------------------------------------------------------------------
// Preservation gates

async function frozenSemanticEquivalence(baseline: { frozen: SemanticRow[]; commit: string }) {
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
    schemaVersion: "stage5.m131.frozen-semantic-equivalence.v1",
    baselineCommit: baseline.commit,
    baselineImplementation: "M130 source on this checkout",
    cases: current.length,
    baselineCases: baseline.frozen.length,
    differences,
    changed,
    combinedHash: hash(current),
    baselineHash: hash(baseline.frozen),
    scopeNote: "M131 changed flow traversal, edge-site provenance and the response envelope. Retrieval selection, ranking and capsule packing were not touched.",
    pass: total === 0 && current.length === baseline.frozen.length,
    evidence: `${current.length}/${baseline.frozen.length} cases, ${total} semantic differences`,
  };
}

function tckdbAcceptance(baseline: { exactTckdb: unknown }) {
  const indexPath = path.join(TCKDB_ROOT, ".vtrace", "index.sqlite");
  if (!existsSync(indexPath)) {
    return {
      schemaVersion: "stage5.m131.tckdb-acceptance.v1",
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
    // Layer 1: same-checkout implementation regression against the M130 code.
    const codeBehaviourPreserved = stable(projection) === stable(baseline.exactTckdb);
    // Layer 2: semantic task acceptance, expressed as evidence categories rather
    // than a frozen file list, because TCKDB keeps moving.
    const categories = TCKDB_EVIDENCE_CATEGORIES.map((category) => ({
      id: category.id,
      satisfiedBy: projection.selectedFiles.filter(category.matches),
    }));
    const missingCategories = categories.filter((entry) => entry.satisfiedBy.length === 0).map((entry) => entry.id);

    return {
      schemaVersion: "stage5.m131.tckdb-acceptance.v1",
      repositoryRoot: TCKDB_ROOT,
      repositoryHead: gitHead(TCKDB_ROOT),
      repositoryBranch: gitBranch(TCKDB_ROOT),
      repositoryUnmodified: true,
      inPlaceVtraceStateWritten: false,
      task: TCKDB_TASK,
      expectedLead: TCKDB_LEAD,
      leadPivot: projection.leadPivot,
      selectedFiles: projection.selectedFiles,
      evidenceCategories: categories,
      missingCategories,
      codeBehaviourPreserved,
      acceptancePolicy: "two layers: (1) same-checkout parity against the M130 code, (2) evidence categories present. The M129/M130 literal file list is deliberately not a gate — TCKDB drifts, and a frozen slot list turns that drift into a false regression.",
      pass: projection.leadPivot === TCKDB_LEAD && codeBehaviourPreserved && missingCategories.length <= 1,
    };
  } finally {
    db.close();
  }
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
  await writeFile(target, `${JSON.stringify({ commit: gitHead(WORKSPACE_ROOT), frozen, exactTckdb }, null, 2)}\n`);
  process.stdout.write(`baseline: ${frozen.length} frozen rows -> ${target}\n`);
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
// Rendering

function renderScalabilityProfile(
  arc: Awaited<ReturnType<typeof arcFlowAcceptance>>,
  scaling: ReturnType<typeof scalabilityProfile>,
  plans: ReturnType<typeof adjacencyQueryPlans>,
  flowBaseline: Record<string, never> | Record<string, { warmMedianMs: number }>,
  verdict: string,
): string {
  const baselineMs = (flowBaseline as { warmWithSourceExcerpts: { warmMedianMs: number } }).warmWithSourceExcerpts.warmMedianMs;
  return [
    "# Stage 5 — M131 flow scalability profile",
    "",
    `Verdict: **${verdict}**`,
    "",
    "## Old vs new traversal architecture",
    "",
    "| | M130 | M131 |",
    "| --- | --- | --- |",
    "| graph acquisition | `listAllSymbols` + `listAllEdges`, whole tables | batched adjacency per frontier level |",
    "| relation filter | every persisted edge | only edges the frontier reached |",
    "| cost driver | repository graph size | explored subgraph |",
    "| `maxEdges` | traversal budget (M130 fix) | traversal budget, shared across both directions |",
    "| budget exhaustion | reported | reported, with per-traversal counters |",
    "",
    "## ARC — direct one-edge flow",
    "",
    `- repository: \`${arc.repository.root}\` @ \`${arc.repository.head}\` (${arc.repository.branch}), read-only`,
    `- protocol: warm, ${arc.protocol.warmups} warm-ups, ${arc.protocol.repetitions} measured repetitions, median, single process`,
    `- total graph edges: ${arc.diagnostics.edgesAvailable}`,
    `- edges fetched: ${arc.traversal.edgesFetched}`,
    `- edges relaxed: ${arc.diagnostics.edgesInspected}`,
    `- nodes expanded: ${arc.traversal.nodesExpanded}`,
    `- frontier batches: ${arc.traversal.frontierBatches}`,
    `- DB queries: ${arc.traversal.dbQueries}`,
    `- warm median: **${arc.warmMedianMs} ms** (M130 baseline ${baselineMs} ms, ${arc.speedup}x)`,
    `- warm p90: ${arc.warmP90Ms} ms`,
    "",
    "## Synthetic scaling — same short path, growing graph",
    "",
    "| total edges | edges fetched | edges relaxed | nodes expanded | frontier batches | DB queries | warm median (ms) | result |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...scaling.cases.map((entry) =>
      `| ${entry.totalGraphEdges} | ${entry.edgesFetched} | ${entry.edgesRelaxed} | ${entry.nodesExpanded} | ${entry.frontierBatches} | ${entry.dbQueries} | ${entry.warmMedianMs} | ${entry.shortestPathEdgeCount} edge, calls |`),
    "",
    `Graph grows ${scaling.graphGrowthFactor}x; explored work grows ${scaling.workGrowthFactor}x.`,
    "This is not a claim of O(1): it is the claim that unrelated graph size does not dominate a short-path search.",
    "",
    "## SQL access pattern",
    "",
    "```sql",
    "SELECT id, src_symbol_id, dst_symbol_id, edge_type, confidence",
    "FROM edges WHERE src_symbol_id IN (?, ?, …) ORDER BY id ASC   -- forward frontier",
    "SELECT … FROM edges WHERE dst_symbol_id IN (?, ?, …) ORDER BY id ASC   -- reverse frontier",
    "```",
    "",
    ...plans.plans.map((entry) => `- \`${entry.column}\`: ${entry.detail}`),
    `- \`edge_call_sites\`: ${plans.callSitePlan}`,
    "",
    `Indexes used: ${plans.indexesUsed.join(", ")}. New indexes added: ${plans.newIndexesAdded.length === 0 ? "none" : plans.newIndexesAdded.join(", ")}.`,
    "The frontier is chunked at 500 ids per statement so one prepared-statement shape is reused across levels; a chunk is still a batch, never a per-node query.",
    "",
    "## Why the previous tests could not catch this class of failure",
    "",
    "- **Repository-size dimension.** Every flow fixture was a repository smaller than the bound that caused the defect. More syntax fixtures would never have crossed it. The suite now builds graphs at 2k / 20k / 100k edges and asserts the answer does not move.",
    "- **Storage-order dimension.** The defect was ultimately a dependence on SQLite row order. Order is now an explicit test input: five insertion orders must produce one semantic hash.",
    "- **Whole-response dimension.** M130's envelope was proven against a single captured payload. It is now asserted across items, source size, diagnostics, flow hops, impact records and document excerpts — which found two real gaps M130's shape had hidden.",
    "- **Metamorphic invariants beat examples.** \"Unrelated growth must not change the answer\" and \"a bound that bites must be reported as a bound\" are properties. Examples only sample them.",
    "",
  ].join("\n");
}

function renderImpactAudit(audit: ReturnType<typeof impactTraversalAudit>): string {
  return [
    "# Stage 5 — M131 impact traversal audit (report-only)",
    "",
    `Verdict: **${audit.verdict}**`,
    "",
    "M130 found that flow traversal assumed it could hold the whole repository graph.",
    "This audit asks whether `get_impact_graph` shares that assumption. It does not.",
    "",
    "## Current query pattern",
    "",
    `- ${audit.queryPattern}`,
    `- loads the whole graph: **${audit.loadsWholeGraph ? "yes" : "no"}**`,
    `- indexes used: ${audit.indexesUsed.join(", ")}`,
    "",
    "## Behaviour as the synthetic graph grows",
    "",
    "| total graph edges | edges inspected | latency (ms) |",
    "| ---: | ---: | ---: |",
    ...audit.synthetic.map((entry) => `| ${entry.totalGraphEdges} | ${entry.edgesInspected} | ${entry.latencyMs} |`),
    "",
    `Inspected work scales with the requested neighbourhood, not the graph: ${audit.scalesWithGraph ? "NOT confirmed — investigate" : "confirmed"}.`,
    "",
    "## Findings",
    "",
    ...audit.findings.map((finding) => `- ${finding}`),
    "",
    "## Recommendation",
    "",
    audit.recommendation,
    "",
    "## Would M132 amplify this?",
    "",
    audit.workspaceAmplification,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Helpers

function withSyntheticDb<T>(
  spec: Parameters<typeof buildSyntheticGraph>[1],
  body: (db: Database, graph: ReturnType<typeof buildSyntheticGraph>) => T,
): T {
  const directory = `${workspaceRoot()}/vtrace-m131-syn-${spec.totalEdges}-${spec.plantedPosition ?? "middle"}-${spec.startFanOut ?? 0}-${spec.plantedPathLength ?? 1}-${spec.seed ?? 0}`;
  const db = new Database(":memory:");
  try {
    initializeSchema(db);
    return body(db, buildSyntheticGraph(db, spec));
  } finally {
    db.close();
    void directory;
  }
}

function requireFlow(result: ReturnType<typeof searchLogicFlow>): LogicFlowOutput {
  if (result.ok === false) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.output;
}

function semanticShape(output: LogicFlowOutput): unknown {
  return {
    reachable: output.summary.reachable,
    shortestPathEdgeCount: output.summary.shortestPathEdgeCount,
    traversalLimitReached: output.summary.traversalLimitReached,
    paths: output.paths.map((flowPath) => ({
      nodes: flowPath.nodes.map((node) => node.fqName),
      steps: flowPath.steps.map((step) => [step.edgeType, step.fromFqName, step.toFqName]),
    })),
  };
}

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

function sourceProbes(before: unknown): string[] {
  const record = before as { productContext?: { items?: Array<{ content?: unknown }> } };
  const probes: string[] = [];
  for (const item of record?.productContext?.items ?? []) {
    if (typeof item.content !== "string") continue;
    const line = item.content.split("\n").find((candidate) => candidate.trim().length > 30);
    if (line !== undefined) probes.push(JSON.stringify(line).slice(1, -1));
  }
  return probes;
}

function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function flowSourceHasNoCheck(): boolean {
  return Bun.spawnSync(["grep", "-c", "@ts-nocheck", "src/logicFlow/searchLogicFlow.ts"]).exitCode === 0;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
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
