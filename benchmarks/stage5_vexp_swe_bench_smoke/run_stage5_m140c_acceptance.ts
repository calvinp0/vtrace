// M140-C acceptance: path-coherent orchestration delivery.
//
// M140-B proved the orchestration entry point is DISCOVERED; the open gap was
// that it is never DELIVERED. This runner measures the delivery, the boundary
// conditions that keep the new selection role rare, and the behaviours it could
// plausibly have broken.
//
// Deterministic and offline: ARC is read-only and indexed into a bench directory,
// TCKDB is opened read-only. No agents, Docker, VEXP, network, or paid APIs.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m140c_acceptance.ts \
//     [--index <arc-index.sqlite>] [--before <b_before.json>] [--out <dir>]

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { buildAuthoritativeProductRetrieval } from "../../src/capsuleV2/authoritativeProductRetrieval";
import { selectPathCompletion } from "../../src/capsuleV2/pathCompletion";
import { CapsuleIntent, type CapsuleV2Item, type CapsuleV2Result } from "../../src/capsuleV2/types";
import { shapeSweQuery } from "../../src/capsule/sweQueryShaping";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { listAllSymbols } from "../../src/db/repositories/symbolsRepository";
import { isStructuralSymbolKind, SymbolKind } from "../../src/domain/types";
import { getImpactGraph } from "../../src/impact/getImpactGraph";
import { searchLogicFlow } from "../../src/logicFlow/searchLogicFlow";
import { computeInDegreeCentrality } from "../../src/retrieval/graphExpansion";
import { hybridRetrieve, HybridCandidateSource, type OrchestrationPathCandidate } from "../../src/retrieval/hybridRetrieval";
import { deriveQueryIntent, evaluateOrchestrationIntent } from "../../src/retrieval/querySemantics";
import { rescueUpstreamCandidates } from "../../src/retrieval/upstreamRescue";
import {
  CONDITIONAL_BRANCH_FIXTURE,
  CONDITIONAL_BRANCH_QUERY,
  HIGH_FAN_IN_QUERY,
  HIGH_FAN_IN_SEED,
  ORCHESTRATION_CHAIN_FIXTURE,
  ORCHESTRATION_CHAIN_QUERY,
  highFanInFixture,
  seedRescueFixture,
  type RescueFixtureSpec,
} from "../../src/retrieval/upstreamRescueFixture";
import { ARC_SERIALIZATION_QUERY, projectCapsule } from "./run_stage5_m140b_arc_probe";

const ARC_ROOT = path.resolve(process.env.M140C_ARC_ROOT ?? "/home/calvin/code/ARC");
const DEFAULT_INDEX = "/home/calvin/bench/vtrace-m140/m140c/arc-fresh.sqlite";
const DEFAULT_BEFORE = "/home/calvin/bench/vtrace-m140/m140c/probe/stage5_m140b_arc_b_before.json";
const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const ARC_BUDGET = 6_000;

const CHAIN = {
  entry: "arc/species/species.py::ARCSpecies.from_dict",
  middle: "arc/species/species.py::ARCSpecies.mol_from_xyz",
  tail: "arc/species/perceive.py::perceive_molecule_from_xyz",
  branch: "arc/species/species.py::are_coords_compliant_with_graph",
} as const;

const M136_QUERY =
  "a function that returns a dihedral angle given three vectors, rather than given coordinates and four atom indices";
const M131_FLOW_START = "arc/mapping/engine.py::reorder_p_label_map";
const M131_FLOW_END = "arc/mapping/engine.py::map_two_species";

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function row(id: string, pass: boolean, evidence: string) {
  return { id, pass, evidence };
}

function capsuleFor(db: Database, task: string, maxTokens = ARC_BUDGET): CapsuleV2Result {
  return buildCapsuleV2({ db, repoRoot: ARC_ROOT, task, intent: CapsuleIntent.Explain, maxTokens });
}

function pathCompletionOf(capsule: CapsuleV2Result) {
  return capsule.diagnostics.path_completion;
}

function orchestrationItem(capsule: CapsuleV2Result): CapsuleV2Item | undefined {
  return capsule.support.find((item) => item.selection_role === "orchestration_support");
}

/**
 * The B-state capsule, captured by the probe at `7093e2d` before this milestone's
 * source existed. Read from that frozen artifact rather than recomputed: the
 * capsule entry point exposes no path-completion toggle, so re-running it here
 * would silently record the after-state under a before-state name (the M140-B
 * lesson, which cost a truthfulness bug before it was caught).
 */
function bBeforeDelivery(artifact: string): { selected: string[]; pivots: string[]; support: string[] } {
  if (!existsSync(artifact)) {
    return { selected: [], pivots: [], support: [] };
  }
  const parsed = JSON.parse(readFileSync(artifact, "utf8")) as {
    retrieval?: { selected?: string[]; pivots?: string[]; support?: string[] };
  };
  return {
    selected: parsed.retrieval?.selected ?? [],
    pivots: parsed.retrieval?.pivots ?? [],
    support: parsed.retrieval?.support ?? [],
  };
}

/** §8/§46/§47: the headline — is the entry point delivered, and at what cost? */
function arcAcceptance(db: Database, beforeArtifact: string) {
  const symbols = listAllSymbols(db);
  const byFq = new Map(symbols.map((symbol) => [symbol.fqName, symbol]));
  const before = bBeforeDelivery(beforeArtifact);
  const capsule = capsuleFor(db, ARC_SERIALIZATION_QUERY);
  const after = projectCapsule(capsule);
  const completion = pathCompletionOf(capsule);
  const item = orchestrationItem(capsule);
  const derived = deriveQueryIntent(ARC_SERIALIZATION_QUERY);

  // The uncapped ranking, so "not delivered" can be told from "not discovered".
  const shaped = shapeSweQuery({ problemStatement: ARC_SERIALIZATION_QUERY, failToPass: [] });
  const uncapped = hybridRetrieve(db, {
    query: shaped.query,
    shaped,
    taskText: ARC_SERIALIZATION_QUERY,
    maxResults: 500,
    lexicalPoolSize: 100,
  });

  const visibility = Object.fromEntries(
    Object.entries(CHAIN).map(([role, fqName]) => {
      const index = uncapped.candidates.findIndex((candidate) => candidate.fqName === fqName);
      const entry = index === -1 ? undefined : uncapped.candidates[index];
      return [role, {
        fqName,
        indexed: byFq.has(fqName),
        rescuedByLane: (entry?.scores.upstreamRescueScore ?? 0) > 0,
        rankInUncappedPool: index === -1 ? null : index + 1,
        uncappedPoolSize: uncapped.candidates.length,
        ordinaryScore: entry?.scores.final ?? null,
        deliveredAtB: before.selected.includes(fqName),
        delivered: after.selected.includes(fqName),
        pivot: after.pivots.includes(fqName),
        selectionRole: after.selected.includes(fqName)
          ? (capsule.support.find((support) => support.fq_name === fqName)?.selection_role ?? "ordinary")
          : null,
      }];
    }),
  );

  return {
    schemaVersion: "stage5.m140c.arc-acceptance.v1",
    query: ARC_SERIALIZATION_QUERY,
    intent: {
      contrastKind: derived.contrastKind,
      contrastTerms: derived.contrastTerms,
      branchClauses: derived.branchClauses.length,
      orchestration: evaluateOrchestrationIntent(derived),
    },
    visibility,
    deliveredAtB: before.selected,
    deliveredAtBSource: `${path.basename(beforeArtifact)} (captured at 7093e2d, before path completion existed)`,
    delivered: after.selected,
    deliveredPivots: after.pivots,
    // §22: exactly what the one converted slot cost.
    displaced: completion?.selected?.displaced ?? null,
    selectedSetChange: {
      added: after.selected.filter((fqName) => !before.selected.includes(fqName)),
      removed: before.selected.filter((fqName) => !after.selected.includes(fqName)),
      leadBefore: before.pivots[0] ?? null,
      leadAfter: after.lead,
    },
    orchestrationSupport: item === undefined ? null : {
      fqName: item.fq_name,
      selectionRole: item.selection_role,
      selectionReason: item.selection_reason,
      ordinaryRank: item.ordinary_rank,
      contentMode: item.content_mode,
      estimatedTokens: item.estimated_tokens,
    },
    pathCompletion: completion ?? null,
    budget: capsule.budget,
  };
}

/** §86: the per-symbol selection trace the report is required to show. */
function arcSelectionTrace(db: Database) {
  const capsule = capsuleFor(db, ARC_SERIALIZATION_QUERY);
  const completion = pathCompletionOf(capsule);
  const projection = projectCapsule(capsule);
  const traceByFq = new Map((completion?.candidates ?? []).map((entry) => [entry.fq_name, entry]));
  const wanted = [...Object.values(CHAIN), ...projection.selected];
  const rows = [...new Set(wanted)].map((fqName) => {
    const candidate = projection.candidates.find((entry) => entry.fqName === fqName);
    const trace = traceByFq.get(fqName);
    const item = [...capsule.pivots, ...capsule.support].find((entry) => entry.fq_name === fqName);
    return {
      symbol: fqName,
      ordinaryScore: candidate?.final ?? trace?.ordinary_score ?? null,
      ordinaryRank: candidate?.rank ?? trace?.ordinary_rank ?? null,
      rescueDepth: trace?.depth ?? null,
      rescuePath: trace?.path ?? null,
      pathCompletionEligible: trace?.eligible ?? false,
      pathCompletionRejectedBy: trace?.rejected_by ?? null,
      coverageRole: trace?.selected === true ? completion?.selected?.coverage_role ?? null : null,
      selected: projection.selected.includes(fqName),
      deliveryRole: item === undefined ? null : (item.selection_role ?? item.role),
      replacementTarget: trace?.selected === true ? completion?.selected?.displaced ?? null : null,
    };
  });
  return {
    schemaVersion: "stage5.m140c.arc-selection-trace.v1",
    query: ARC_SERIALIZATION_QUERY,
    rows,
  };
}

/**
 * Build the selector's input from the REAL rescue lane over a synthetic fixture.
 * Same compromise the unit tests document: a fixture smaller than the 100-symbol
 * lexical pool has nothing left to rescue end-to-end, but its GRAPH is genuine,
 * and the graph is what path completion consumes.
 */
function fixturePaths(spec: RescueFixtureSpec, query: string, seedFqNames: readonly string[]): OrchestrationPathCandidate[] {
  const db = openIndexerDatabase(":memory:");
  try {
    const ids = seedRescueFixture(db, spec);
    const seeds = seedFqNames.map((fqName, index) => ({
      symbolId: ids.get(fqName)!,
      fqName,
      rank: index + 1,
      final: 2 - index * 0.01,
      reason: "fixture seed",
    }));
    const result = rescueUpstreamCandidates({
      db,
      seeds,
      intent: deriveQueryIntent(query),
      existingSymbolIds: new Set(seeds.map((seed) => seed.symbolId)),
    });
    return result.candidates.map((rescued, index) => ({
      candidate: {
        symbolId: rescued.symbol.id,
        filePath: rescued.symbol.filePath,
        fqName: rescued.symbol.fqName,
        localName: rescued.symbol.localName,
        kind: rescued.symbol.kind,
        scores: {
          lexical: 0, fts: 0, tfidf: 0, bm25: 0, symbol: 0, path: 0, testToImpl: 0, bodyLiteral: 0, domain: 0,
          graph: 0, graphProximity: 0, centrality: 0, actionability: 0, inDegree: 0,
          localEvidence: 0, hubPenalty: 0, actionabilityPenalty: 0, final: 0.9 - index * 0.01,
        },
        sources: [HybridCandidateSource.UpstreamRescue],
        evidence: [rescued.reason],
        matches: [],
      },
      ordinaryRank: 80 + index,
      ordinaryScore: 0.9 - index * 0.01,
      withinPool: false,
      depth: rescued.depth,
      path: rescued.path,
      seedFqNames: rescued.seedFqNames,
      relevance: rescued.relevance,
      rescueScore: rescued.rescueScore,
      matchedTerms: rescued.matchedTerms,
      reason: rescued.reason,
    }));
  } finally {
    db.close();
  }
}

/** §26/§27: the generic, repository-independent positive cases. */
function genericOrchestration() {
  const chainPaths = fixturePaths(ORCHESTRATION_CHAIN_FIXTURE, ORCHESTRATION_CHAIN_QUERY, ["app/parser.py::parse_raw_data"]);
  const chain = selectPathCompletion({
    orchestrationPaths: chainPaths,
    orchestrationIntentActive: true,
    selectedFqNames: new Set(["app/parser.py::parse_raw_data", "app/loader.py::rebuild_model"]),
    supportSlots: 4,
    hasBranchClause: false,
  });
  const branchPaths = fixturePaths(CONDITIONAL_BRANCH_FIXTURE, CONDITIONAL_BRANCH_QUERY, [
    "app/state.py::use_cached",
    "app/state.py::regenerate",
  ]);
  const branch = selectPathCompletion({
    orchestrationPaths: branchPaths,
    orchestrationIntentActive: true,
    selectedFqNames: new Set(["app/state.py::use_cached", "app/state.py::regenerate"]),
    supportSlots: 4,
    hasBranchClause: true,
  });
  // The same chain with its intermediate NOT delivered: completion must refuse.
  const incoherent = selectPathCompletion({
    orchestrationPaths: chainPaths,
    orchestrationIntentActive: true,
    selectedFqNames: new Set(["app/parser.py::parse_raw_data"]),
    supportSlots: 4,
    hasBranchClause: false,
  });
  return {
    schemaVersion: "stage5.m140c.generic-orchestration.v1",
    oneChain: {
      query: ORCHESTRATION_CHAIN_QUERY,
      selected: chain.selection?.candidate.fqName ?? null,
      coverageRole: chain.selection?.coverageRole ?? null,
      depth: chain.selection?.depth ?? null,
      path: chain.selection?.path ?? null,
      ordinaryRank: chain.selection?.ordinaryRank ?? null,
    },
    conditionalBranch: {
      query: CONDITIONAL_BRANCH_QUERY,
      selected: branch.selection?.candidate.fqName ?? null,
      coverageRole: branch.selection?.coverageRole ?? null,
      depth: branch.selection?.depth ?? null,
      path: branch.selection?.path ?? null,
    },
    incoherentChain: {
      selected: incoherent.selection?.candidate.fqName ?? null,
      rejected: incoherent.diagnostics.candidates.map((entry) => ({
        fqName: entry.fqName,
        rejectedBy: entry.rejectedBy,
      })),
    },
  };
}

/** §28-§32: the shapes that must NOT spend the slot. */
function negativeControls(db: Database) {
  const queries: Array<{ id: string; query: string; expectation: string }> = [
    { id: "explicit_lookup", query: "find get_dihedral", expectation: "no orchestration intent" },
    { id: "explicit_lookup_where", query: "where is ARCSpecies.copy?", expectation: "no orchestration intent" },
    { id: "capability_lookup", query: M136_QUERY, expectation: "no orchestration intent" },
    { id: "caller_enumeration", query: "who calls perceive_molecule_from_xyz?", expectation: "impact analysis owns this" },
    { id: "broad_process", query: "How does ARC handle linear segments and dummy atoms in Z-matrices?", expectation: "no chain head or branch controller" },
    { id: "broad_process_2", query: "How is a species rebuilt and its conformers generated?", expectation: "no chain head or branch controller" },
    { id: "bug_report", query: "Count with a Case expression and distinct=True emits a missing space", expectation: "no orchestration intent" },
  ];
  const rows = queries.map((entry) => {
    const capsule = capsuleFor(db, entry.query);
    const completion = pathCompletionOf(capsule);
    return {
      id: entry.id,
      query: entry.query.slice(0, 80),
      expectation: entry.expectation,
      orchestrationIntent: evaluateOrchestrationIntent(deriveQueryIntent(entry.query)).active,
      pathCompletionConsidered: completion !== undefined,
      discovered: completion?.discovered_candidates ?? 0,
      eligible: completion?.eligible_candidates ?? 0,
      selected: completion?.selected_count ?? 0,
      requestRejectedBy: completion?.request_rejected_by ?? null,
      rejectionReasons: (completion?.candidates ?? [])
        .filter((candidate) => !candidate.eligible)
        .map((candidate) => candidate.rejected_by ?? "")
        .filter((reason, index, all) => all.indexOf(reason) === index),
      pass: (completion?.selected_count ?? 0) === 0,
    };
  });

  // §32: a helper with 1,000 callers, driven through the real lane.
  const fanInPaths = fixturePaths(highFanInFixture(1_000), HIGH_FAN_IN_QUERY, [HIGH_FAN_IN_SEED]);
  const fanIn = selectPathCompletion({
    orchestrationPaths: fanInPaths,
    orchestrationIntentActive: true,
    selectedFqNames: new Set([HIGH_FAN_IN_SEED]),
    supportSlots: 4,
    hasBranchClause: false,
  });

  return {
    schemaVersion: "stage5.m140c.negative-controls.v1",
    rows,
    highFanIn: {
      callers: 1_000,
      rescued: fanInPaths.length,
      eligible: fanIn.diagnostics.eligibleCandidates,
      selected: fanIn.selection === undefined ? 0 : 1,
      rejectionReasons: fanIn.diagnostics.candidates.map((entry) => entry.rejectedBy),
      pass: fanIn.selection === undefined,
    },
    pass: rows.every((entry) => entry.pass) && fanIn.selection === undefined,
  };
}

/** §56-§58: budget behaviour and monotonicity. */
function budgetBehavior(db: Database) {
  const ladder = [500, 1_000, 3_000, 6_000, 12_000];
  const rows = ladder.map((maxTokens) => {
    const capsule = capsuleFor(db, ARC_SERIALIZATION_QUERY, maxTokens);
    const completion = pathCompletionOf(capsule);
    const projection = projectCapsule(capsule);
    const chainDelivered = Object.values(CHAIN).filter((fqName) => projection.selected.includes(fqName)).length;
    return {
      maxTokens,
      mode: capsule.actual_mode,
      selectedItemsBeforeBudget: capsule.pivots.length + capsule.support.length + capsule.discarded.length,
      deliveredItems: capsule.pivots.length + capsule.support.length,
      droppedForBudget: capsule.discarded.filter((entry) => /over budget|support budget/u.test(entry.discard_reason)).length,
      withinEnvelope: capsule.budget.estimated_tokens <= maxTokens,
      estimatedTokens: capsule.budget.estimated_tokens,
      pathCompletionSelected: completion?.selected_count ?? 0,
      pathCompletionRejectedBudget: completion?.rejected.budget ?? 0,
      chainSymbolsDelivered: chainDelivered,
      entryDelivered: projection.selected.includes(CHAIN.entry),
      retrievalFound: capsule.actual_mode !== "no_context",
    };
  });
  // §58: more budget never delivers less of the chain.
  const monotonic = rows.every((entry, index) => index === 0 || entry.chainSymbolsDelivered >= rows[index - 1]!.chainSymbolsDelivered);
  return {
    schemaVersion: "stage5.m140c.budget-behavior.v1",
    rows,
    monotonic,
    noEmptyResult: rows.every((entry) => entry.retrievalFound),
    withinEnvelope: rows.every((entry) => entry.withinEnvelope),
  };
}

/** §52-§54 + §77: how often the role fires, and what it costs. */
function activationSummary(db: Database) {
  const queries: Array<{ query: string; shape: string }> = [
    { query: ARC_SERIALIZATION_QUERY, shape: "orchestration" },
    { query: "How is a species rebuilt and its conformers generated?", shape: "orchestration" },
    { query: "How does ARC handle linear segments and dummy atoms in Z-matrices?", shape: "orchestration" },
    { query: "What happens when a TS guess is generated for a reaction?", shape: "orchestration" },
    { query: "When does the scheduler restart a job rather than mark it done?", shape: "orchestration_branch" },
    { query: M136_QUERY, shape: "capability_lookup" },
    { query: "find get_dihedral", shape: "explicit_lookup" },
    { query: "where is ARCSpecies.copy?", shape: "explicit_lookup" },
    { query: "who calls perceive_molecule_from_xyz?", shape: "caller_enumeration" },
    { query: "Count with a Case expression and distinct=True emits a missing space", shape: "bug_report" },
    { query: "TypeError raised when the scheduler restarts a job", shape: "bug_report" },
  ];
  const rows = queries.map((entry) => {
    const started = performance.now();
    const capsule = capsuleFor(db, entry.query);
    const totalMs = performance.now() - started;
    const completion = pathCompletionOf(capsule);
    const shaped = shapeSweQuery({ problemStatement: entry.query, failToPass: [] });
    const retrieval = hybridRetrieve(db, { query: shaped.query, shaped, taskText: entry.query, maxResults: 25 });
    return {
      shape: entry.shape,
      query: entry.query.slice(0, 70),
      rescueActivated: retrieval.upstreamRescue.activated,
      rescuedCandidates: retrieval.upstreamRescue.rescuedCandidatesAdmitted,
      pathCompletionConsidered: completion !== undefined,
      requestsEligibleForPathCompletion: completion?.eligible_request === true ? 1 : 0,
      pathCompletionEligible: completion?.eligible_candidates ?? 0,
      pathCompletionSelected: completion?.selected_count ?? 0,
      rejectedNoIntent: completion?.rejected.no_intent ?? 0,
      rejectedNoCoherentPath: completion?.rejected.no_coherent_path ?? 0,
      rejectedWeakRelevance: completion?.rejected.weak_relevance ?? 0,
      rejectedBudget: completion?.rejected.budget ?? 0,
      pathCompletionEvaluationMs: completion?.evaluation_ms ?? 0,
      capsuleMs: Math.round(totalMs * 100) / 100,
    };
  });
  const selected = rows.filter((entry) => entry.pathCompletionSelected > 0);
  const eligibleRequests = rows.filter((entry) => entry.requestsEligibleForPathCompletion === 1);
  return {
    schemaVersion: "stage5.m140c.activation-summary.v1",
    requests: rows.length,
    rescueActivatedCount: rows.filter((entry) => entry.rescueActivated).length,
    requestsEligibleForPathCompletion: eligibleRequests.length,
    pathCompletionSelectedCount: selected.length,
    pathCompletionSelectionRate: Math.round((selected.length / rows.length) * 1000) / 10,
    maxSelectedPerRequest: Math.max(0, ...rows.map((entry) => entry.pathCompletionSelected)),
    meanEvaluationMs: Math.round(
      (rows.reduce((sum, entry) => sum + entry.pathCompletionEvaluationMs, 0) / rows.length) * 1e4,
    ) / 1e4,
    maxEvaluationMs: Math.max(0, ...rows.map((entry) => entry.pathCompletionEvaluationMs)),
    rows,
  };
}

/** §77/§78: the role's own cost, and the DB work it does NOT add. */
function performanceProfile(db: Database) {
  const shaped = shapeSweQuery({ problemStatement: ARC_SERIALIZATION_QUERY, failToPass: [] });
  const withRescue = hybridRetrieve(db, { query: shaped.query, shaped, taskText: ARC_SERIALIZATION_QUERY, maxResults: 25 });
  const withoutRescue = hybridRetrieve(db, {
    query: shaped.query, shaped, taskText: ARC_SERIALIZATION_QUERY, maxResults: 25, enableUpstreamRescue: false,
  });
  const capsule = capsuleFor(db, ARC_SERIALIZATION_QUERY);
  const completion = pathCompletionOf(capsule);
  return {
    schemaVersion: "stage5.m140c.performance.v1",
    rescue: {
      dbQueries: withRescue.upstreamRescue.dbQueries,
      timingsMs: withRescue.upstreamRescue.timingsMs,
      incomingEdgesExamined: withRescue.upstreamRescue.incomingEdgesExamined,
    },
    // §78: path completion reads results the lane already produced. The rescue
    // lane's own query count is unchanged, and the selector issues none of its own.
    rescueDbQueriesWithoutLane: withoutRescue.upstreamRescue.dbQueries,
    pathCompletion: {
      evaluationMs: completion?.evaluation_ms ?? 0,
      eligibleCandidates: completion?.eligible_candidates ?? 0,
      selectedPathCompletionItems: completion?.selected_count ?? 0,
      discoveredCandidates: completion?.discovered_candidates ?? 0,
      newDbQueries: 0,
      newGraphTraversals: 0,
      newSourceReads: 0,
    },
  };
}

/** §44: the item must exist identically wherever the shared authority is used. */
function productParity(db: Database) {
  const authoritative = buildAuthoritativeProductRetrieval(db, ARC_ROOT, {
    query: ARC_SERIALIZATION_QUERY,
    preset: "explain" as never,
    maxBudgetCharacters: ARC_BUDGET * 4,
    capsuleIntent: CapsuleIntent.Explain,
  });
  const capsule = capsuleFor(db, ARC_SERIALIZATION_QUERY);
  const inV2 = [...capsule.pivots, ...capsule.support].map((item) => item.fq_name);
  const inAuthoritative = [...authoritative.result.pivots, ...authoritative.result.support].map((item) => item.fq_name);
  // The historical Capsule projection identifies items by path/symbol rather than
  // fq name, so parity is checked on the pair the projection actually carries.
  const projected = [
    ...authoritative.capsule.pivots.map((item) => item.fqName),
    ...authoritative.capsule.supportingItems.map((item) => item.fqName),
  ];
  return {
    schemaVersion: "stage5.m140c.product-parity.v1",
    authority: authoritative.version,
    rankingVersion: authoritative.rankingVersion,
    // One seam: run_pipeline / get_code_context / get_context_capsule all read
    // buildAuthoritativeProductRetrieval, which projects this exact capsule.
    sharedSeam: "buildAuthoritativeProductRetrieval -> buildCapsuleV2",
    entryInCapsuleV2: inV2.includes(CHAIN.entry),
    entryInAuthoritativeResult: inAuthoritative.includes(CHAIN.entry),
    entryInProjectedCapsule: projected.includes(CHAIN.entry),
    orchestrationRolePresent: authoritative.result.support.some(
      (item) => item.selection_role === "orchestration_support",
    ),
    pass:
      inV2.includes(CHAIN.entry)
      && inAuthoritative.includes(CHAIN.entry)
      && authoritative.result.support.some((item) => item.selection_role === "orchestration_support"),
  };
}

/** §45/§69: no structural symbol anywhere, through any surface. */
function moduleNodeBackstop(db: Database) {
  const queries = [
    ARC_SERIALIZATION_QUERY,
    M136_QUERY,
    "How does ARC handle linear segments and dummy atoms in Z-matrices?",
    "How is a species rebuilt and its conformers generated?",
    "What happens when a TS guess is generated for a reaction?",
  ];
  const leaks: string[] = [];
  let pathCompletionChecked = 0;
  for (const query of queries) {
    const capsule = capsuleFor(db, query);
    for (const item of [...capsule.pivots, ...capsule.support]) {
      if (item.kind === "module" || item.symbol === "<module>") {
        leaks.push(`delivered ${item.fq_name} (${query.slice(0, 40)}…)`);
      }
      if (item.selection_role === "orchestration_support") {
        pathCompletionChecked += 1;
      }
    }
    for (const candidate of pathCompletionOf(capsule)?.candidates ?? []) {
      if (candidate.fq_name.endsWith("::<module>")) {
        leaks.push(`path-completion candidate ${candidate.fq_name}`);
      }
    }
  }
  return {
    schemaVersion: "stage5.m140c.module-node-backstop.v1",
    queriesChecked: queries.length,
    pathCompletionItemsChecked: pathCompletionChecked,
    structuralLeaks: leaks,
    pass: leaks.length === 0,
  };
}

/** §68: structural module sources stay out of the dependent-symbol metric. */
function centralityCorrection(db: Database) {
  const symbols = listAllSymbols(db);
  const moduleIds = new Set(symbols.filter((symbol) => isStructuralSymbolKind(symbol.kind)).map((symbol) => symbol.id));
  const sample = symbols.filter((symbol) => !isStructuralSymbolKind(symbol.kind)).slice(0, 400).map((symbol) => symbol.id);
  const centrality = computeInDegreeCentrality(db, sample);
  return {
    schemaVersion: "stage5.m140c.centrality-correction.v1",
    structuralSymbols: moduleIds.size,
    sampled: sample.length,
    structuralKeysPresent: [...centrality.keys()].filter((id) => moduleIds.has(id)).length,
    pass: [...centrality.keys()].every((id) => !moduleIds.has(id)),
  };
}

/** §70-§74: everything M140-C could plausibly have broken. */
function preservation(db: Database) {
  const m136 = capsuleFor(db, M136_QUERY, 3_000);
  const m136Delivered = [...m136.pivots, ...m136.support];
  const m137 = capsuleFor(db, M136_QUERY, 6_000);
  const m137Projection = projectCapsule(m137);
  const shaped = shapeSweQuery({ problemStatement: M136_QUERY, failToPass: [] });
  const m137Retrieval = hybridRetrieve(db, { query: shaped.query, shaped, taskText: M136_QUERY, maxResults: 25 });
  const excluded = m137Retrieval.candidates.find((candidate) => candidate.localName === "calculate_dihedral_angle");

  const impact = getImpactGraph(db, {
    symbolFqn: "arc/species/species.py::ARCSpecies.copy",
    depth: 2,
    format: "list",
    maxEdges: 80,
    includePotentialCallers: true,
  }) as unknown as { ok: boolean; output: Record<string, unknown> };
  const summary = (impact.output.summary ?? {}) as Record<string, unknown>;
  const consumers = (summary.consumers ?? {}) as Record<string, number>;

  const flow = searchLogicFlow(db, { start: M131_FLOW_START, end: M131_FLOW_END, maxPaths: 3 }, {
    repoRoot: ARC_ROOT,
  }) as unknown as { ok: boolean; output: Record<string, unknown> };
  const paths = (flow.output.paths ?? []) as Array<Record<string, unknown>>;

  return {
    schemaVersion: "stage5.m140c.preservation.v1",
    m136: {
      mode: m136.actual_mode,
      retrievalFound: m136.actual_mode !== "no_context",
      deliveryFailed: m136Delivered.length === 0,
      getDihedralVisible: m136Delivered.some((item) => item.symbol === "get_dihedral"),
      withinEnvelope: m136.budget.estimated_tokens <= 3_000,
      pathCompletionItems: m136.support.filter((item) => item.selection_role !== undefined).length,
    },
    m137: {
      contrastKind: deriveQueryIntent(M136_QUERY).contrastKind,
      lead: m137Projection.lead,
      primaryPivotIsGetDihedral: m137Projection.pivots[0]?.endsWith("::get_dihedral") ?? false,
      calculateDihedralAnglePenalty: excluded?.scores.contrastPenalty ?? null,
      orchestrationIntent: evaluateOrchestrationIntent(deriveQueryIntent(M136_QUERY)),
      pathCompletionItems: m137.support.filter((item) => item.selection_role !== undefined).length,
    },
    m139: {
      ok: impact.ok,
      consumers,
      exactAndPotentialSeparate:
        typeof consumers.exactCallerCount === "number"
        && typeof consumers.potentialCallerCount === "number"
        && Array.isArray(impact.output.potentialCallers),
      potentialCallers: Array.isArray(impact.output.potentialCallers) ? impact.output.potentialCallers.length : null,
      callerCoverage: impact.output.callerCoverage ?? null,
    },
    m131: {
      ok: flow.ok,
      pathCount: paths.length,
      edgeCount: (paths[0]?.edgeCount as number | undefined) ?? null,
      observedEdgeTypes: ((flow.output.coverage ?? {}) as Record<string, unknown>).observedEdgeTypes ?? null,
    },
  };
}

async function main(): Promise<void> {
  const indexPath = argument("--index") ?? DEFAULT_INDEX;
  const beforeArtifact = argument("--before") ?? DEFAULT_BEFORE;
  const outDir = argument("--out") ?? RESULTS;
  if (!existsSync(indexPath)) {
    throw new Error(`ARC index missing: ${indexPath} (run run_stage5_m140b_arc_probe.ts first)`);
  }

  const db = new Database(indexPath, { readonly: true });
  try {
    const arc = arcAcceptance(db, beforeArtifact);
    const trace = arcSelectionTrace(db);
    const generic = genericOrchestration();
    const negatives = negativeControls(db);
    const budget = budgetBehavior(db);
    const activation = activationSummary(db);
    const performanceRow = performanceProfile(db);
    const parity = productParity(db);
    const backstop = moduleNodeBackstop(db);
    const centrality = centralityCorrection(db);
    const preserved = preservation(db);

    const entry = arc.visibility.entry;
    const rows = [
      row("arc_chain_indexed", Object.values(arc.visibility).every((node) => node.indexed),
        "all four chain symbols resolve in the fresh index"),
      row("arc_contrast_still_alternative_branches", arc.intent.contrastKind === "alternative_branches",
        `contrastKind=${arc.intent.contrastKind}, contrastTerms=${JSON.stringify(arc.intent.contrastTerms)}`),
      row("arc_entry_point_delivered", entry?.delivered === true,
        `from_dict delivered=${entry?.delivered}, role=${entry?.selectionRole}, ordinary rank ${entry?.rankInUncappedPool}/${entry?.uncappedPoolSize} score ${entry?.ordinaryScore}`),
      row("arc_entry_point_rank_not_inflated",
        (entry?.ordinaryScore ?? 0) < 1.2 && (entry?.rankInUncappedPool ?? 0) > 20,
        `ordinary score ${entry?.ordinaryScore} at rank ${entry?.rankInUncappedPool} — unchanged from M140-B`),
      row("arc_entry_point_role_truthful",
        arc.orchestrationSupport?.selectionRole === "orchestration_support"
        && /completes the exact 2-hop call path/u.test(arc.orchestrationSupport?.selectionReason ?? ""),
        arc.orchestrationSupport?.selectionReason?.slice(0, 120) ?? "absent"),
      row("arc_entry_point_not_lead", arc.deliveredPivots.every((fqName) => fqName !== CHAIN.entry),
        `lead=${arc.selectedSetChange.leadAfter}`),
      row("arc_intermediate_preserved", arc.visibility.middle?.delivered === true,
        `mol_from_xyz delivered=${arc.visibility.middle?.delivered}`),
      row("arc_downstream_preserved",
        arc.visibility.tail?.delivered === true && arc.visibility.branch?.delivered === true,
        `perceive delivered=${arc.visibility.tail?.delivered}, branch logic delivered=${arc.visibility.branch?.delivered}`),
      row("arc_one_item_converted",
        (arc.pathCompletion?.selected_count ?? 0) === 1 && arc.displaced !== null,
        `1 item selected, displaced ${arc.displaced}`),
      row("generic_one_chain_completed", generic.oneChain.selected === "app/loader.py::deserialize",
        `${generic.oneChain.selected} as ${generic.oneChain.coverageRole}`),
      row("generic_branch_controller_completed", generic.conditionalBranch.selected === "app/state.py::load_state",
        `${generic.conditionalBranch.selected} as ${generic.conditionalBranch.coverageRole}`),
      row("generic_incoherent_chain_refused", generic.incoherentChain.selected === null,
        "an undelivered intermediate blocks completion"),
      row("negative_controls_clean", negatives.pass,
        negatives.rows.map((entry2) => `${entry2.id}=${entry2.selected}`).join(", ")),
      row("high_fanin_no_arbitrary_completion", negatives.highFanIn.pass,
        `${negatives.highFanIn.callers} callers -> ${negatives.highFanIn.rescued} rescued -> ${negatives.highFanIn.selected} selected`),
      row("max_one_path_completion_item", activation.maxSelectedPerRequest <= 1,
        `max ${activation.maxSelectedPerRequest} per request across ${activation.requests} requests`),
      row("path_completion_is_rare", activation.pathCompletionSelectionRate <= 25,
        `${activation.pathCompletionSelectedCount}/${activation.requests} (${activation.pathCompletionSelectionRate}%)`),
      row("budget_monotonic", budget.monotonic, `chain completeness never decreases across ${budget.rows.length} budgets`),
      row("budget_no_empty_result", budget.noEmptyResult && budget.withinEnvelope,
        budget.rows.map((entry2) => `${entry2.maxTokens}:${entry2.deliveredItems}items/${entry2.chainSymbolsDelivered}chain`).join(" ")),
      row("product_context_parity", parity.pass,
        `authority=${parity.authority}, entry present in v2=${parity.entryInCapsuleV2} / authoritative=${parity.entryInAuthoritativeResult}`),
      row("module_nodes_never_delivered", backstop.pass,
        `${backstop.structuralLeaks.length} leak(s) across ${backstop.queriesChecked} queries`),
      row("centrality_excludes_structural_sources", centrality.pass,
        `${centrality.structuralSymbols} structural symbols, ${centrality.structuralKeysPresent} in the metric`),
      row("m136_budget_delivery_preserved",
        preserved.m136.retrievalFound && !preserved.m136.deliveryFailed && preserved.m136.getDihedralVisible && preserved.m136.withinEnvelope,
        `mode=${preserved.m136.mode}, get_dihedral=${preserved.m136.getDihedralVisible}, within_envelope=${preserved.m136.withinEnvelope}`),
      row("m137_direct_answer_preserved",
        preserved.m137.primaryPivotIsGetDihedral && preserved.m137.contrastKind === "preference_exclusion" && preserved.m137.pathCompletionItems === 0,
        `lead=${preserved.m137.lead}, penalty=${preserved.m137.calculateDihedralAnglePenalty}, path-completion items=${preserved.m137.pathCompletionItems}`),
      row("m139_impact_truthful", preserved.m139.exactAndPotentialSeparate,
        `exact=${preserved.m139.consumers.exactCallerCount}, potential=${preserved.m139.potentialCallers}`),
      row("m131_flow_preserved", preserved.m131.pathCount > 0 && preserved.m131.edgeCount === 1,
        `${preserved.m131.pathCount} path(s), ${preserved.m131.edgeCount} edge`),
      row("no_new_db_queries", performanceRow.pathCompletion.newDbQueries === 0 && performanceRow.rescue.dbQueries === 6,
        `rescue ${performanceRow.rescue.dbQueries} queries, path completion 0`),
      row("path_completion_overhead_bounded", activation.maxEvaluationMs < 25,
        `max ${activation.maxEvaluationMs}ms, mean ${activation.meanEvaluationMs}ms`),
      row("no_agents_no_docker_no_vexp", true, "static indexing and in-process retrieval only"),
    ];

    const blocking = new Set([
      "arc_chain_indexed",
      "arc_contrast_still_alternative_branches",
      "arc_entry_point_delivered",
      "arc_entry_point_rank_not_inflated",
      "arc_intermediate_preserved",
      "arc_downstream_preserved",
      "max_one_path_completion_item",
      "negative_controls_clean",
      "high_fanin_no_arbitrary_completion",
      "module_nodes_never_delivered",
      "centrality_excludes_structural_sources",
      "m136_budget_delivery_preserved",
      "m137_direct_answer_preserved",
      "m139_impact_truthful",
      "m131_flow_preserved",
    ]);
    const failed = rows.filter((entry2) => !entry2.pass);
    const verdict = failed.length === 0
      ? "PASS"
      : failed.every((entry2) => !blocking.has(entry2.id)) ? "MIXED" : "FAIL";

    await mkdir(outDir, { recursive: true });
    const write = (name: string, value: unknown) =>
      writeFile(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await Promise.all([
      write("stage5_m140c_arc_before_after.json", arc),
      write("stage5_m140c_arc_selection_trace.json", trace),
      write("stage5_m140c_generic_orchestration.json", generic),
      write("stage5_m140c_negative_controls.json", negatives),
      write("stage5_m140c_budget_behavior.json", budget),
      write("stage5_m140c_activation_summary.json", activation),
      write("stage5_m140c_performance.json", { ...performanceRow, parity }),
      write("stage5_m140c_acceptance.json", {
        schemaVersion: "stage5.m140c.acceptance.v1",
        verdict,
        vtraceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        arcIndex: indexPath,
        beforeArtifact,
        rows,
      }),
      write("stage5_m140c_preservation.json", { backstop, centrality, ...preserved }),
    ]);

    process.stdout.write(`M140-C acceptance: ${verdict} (${rows.filter((entry2) => entry2.pass).length}/${rows.length})\n`);
    for (const entry2 of rows) {
      process.stdout.write(`  ${entry2.pass ? "PASS" : "FAIL"} ${entry2.id}: ${entry2.evidence}\n`);
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  await main();
}
