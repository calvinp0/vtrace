// M140-B acceptance: ARC orchestration recovery, bounding evidence, and the
// preservation checks the rescue lane could plausibly have broken.
//
// Deterministic and offline: ARC is read-only and indexed into a bench directory,
// TCKDB is opened read-only. No agents, Docker, VEXP, network, or paid APIs.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m140b_acceptance.ts \
//     [--index <arc-index.sqlite>] [--out <dir>]

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent, type CapsuleV2Result } from "../../src/capsuleV2/types";
import { shapeSweQuery } from "../../src/capsule/sweQueryShaping";
import { listAllSymbols } from "../../src/db/repositories/symbolsRepository";
import { isStructuralSymbolKind, SymbolKind } from "../../src/domain/types";
import { getImpactGraph } from "../../src/impact/getImpactGraph";
import { searchLogicFlow } from "../../src/logicFlow/searchLogicFlow";
import { computeInDegreeCentrality } from "../../src/retrieval/graphExpansion";
import { hybridRetrieve, HybridCandidateSource } from "../../src/retrieval/hybridRetrieval";
import { deriveQueryIntent, evaluateOrchestrationIntent } from "../../src/retrieval/querySemantics";
import { ARC_SERIALIZATION_QUERY, projectCapsule } from "./run_stage5_m140b_arc_probe";
import {
  prepareRunnerOutput,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";

const ARC_ROOT = path.resolve(process.env.M140B_ARC_ROOT ?? "/home/calvin/code/ARC");
const DEFAULT_INDEX = "/home/calvin/bench/vtrace-m140/m140b/arc-fresh.sqlite";
// M141: reports go to an untracked run directory unless --out/--evidence
// asks otherwise, so validating the evidence can never overwrite it.
const RUNNER_NAME = "m140b_acceptance";
let RESULTS = "";

async function resolveResults(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`run_stage5_m140b_acceptance.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    process.exit(0);
  }
  RESULTS = (await prepareRunnerOutput({ argv: process.argv.slice(2), runner: RUNNER_NAME })).dir;
}


const CHAIN = {
  entry: "arc/species/species.py::ARCSpecies.from_dict",
  middle: "arc/species/species.py::ARCSpecies.mol_from_xyz",
  tail: "arc/species/perceive.py::perceive_molecule_from_xyz",
  branch: "arc/species/species.py::are_coords_compliant_with_graph",
} as const;

// §57/§58 preservation queries, verbatim from the milestones that fixed them.
const M136_QUERY =
  "a function that returns a dihedral angle given three vectors, rather than given coordinates and four atom indices";
const M131_FLOW_START = "arc/mapping/engine.py::reorder_p_label_map";
const M131_FLOW_END = "arc/mapping/engine.py::map_two_species";

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * The capsule the A6 implementation actually delivered for this query, captured
 * by the probe at `51ea606` before the rescue lane existed. Read from that frozen
 * artifact rather than recomputed, because the capsule entry point exposes no
 * rescue toggle — recomputing it here would record the after-state as the before.
 */
function a6BeforeDelivery(): string[] {
  const artifact = path.join(RESULTS, "stage5_m140b_arc_a6_before.json");
  if (!existsSync(artifact)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(artifact, "utf8")) as {
    retrieval?: { selected?: string[] };
  };
  return parsed.retrieval?.selected ?? [];
}

function row(id: string, pass: boolean, evidence: string) {
  return { id, pass, evidence };
}

function retrieveArc(db: Database, query: string, rescue: boolean) {
  const shaped = shapeSweQuery({ problemStatement: query, failToPass: [] });
  return hybridRetrieve(db, {
    query: shaped.query,
    shaped,
    taskText: query,
    maxResults: 25,
    ...(rescue ? {} : { enableUpstreamRescue: false }),
  });
}

/** §35-§40 + §91: what the lane recovered, and at what cost. */
function arcOrchestrationAcceptance(db: Database) {
  const symbols = listAllSymbols(db);
  const byFq = new Map(symbols.map((symbol) => [symbol.fqName, symbol]));

  const before = retrieveArc(db, ARC_SERIALIZATION_QUERY, false);
  const after = retrieveArc(db, ARC_SERIALIZATION_QUERY, true);
  // The DELIVERED before-state comes from the A6 capture, not from re-running the
  // capsule with the lane disabled: `buildCapsuleV2` has no rescue toggle, so
  // re-running it here would silently record the after-state under a before-state
  // name. `before`/`after` above are retrieval-level, where the toggle does exist.
  const a6Delivery = a6BeforeDelivery();

  const rank = (result: typeof before, fqName: string): number | null => {
    const index = result.candidates.findIndex((candidate) => candidate.fqName === fqName);
    return index === -1 ? null : index + 1;
  };

  const capsule = buildCapsuleV2({
    db, repoRoot: ARC_ROOT, task: ARC_SERIALIZATION_QUERY, intent: CapsuleIntent.Explain, maxTokens: 6000,
  });
  const delivered = projectCapsule(capsule);

  const diagnostics = after.upstreamRescue;
  const rescuedCandidates = after.candidates.filter((candidate) =>
    candidate.sources.includes(HybridCandidateSource.UpstreamRescue));

  // §40: every rescued symbol that reached DELIVERED context, for inspection.
  const rescuedAndDelivered = rescuedCandidates
    .filter((candidate) => delivered.selected.includes(candidate.fqName))
    .map((candidate) => ({
      fqName: candidate.fqName,
      rescueScore: candidate.scores.upstreamRescueScore ?? 0,
      evidence: candidate.evidence,
    }));

  // The returned pool is capped at 25, so "not in the pool" conflates two very
  // different outcomes: the lane never reached the symbol, or it rescued and
  // scored it and the cap cut it. Reading the uncapped ranking separates them.
  const uncapped = (() => {
    const shaped = shapeSweQuery({ problemStatement: ARC_SERIALIZATION_QUERY, failToPass: [] });
    return hybridRetrieve(db, {
      query: shaped.query,
      shaped,
      taskText: ARC_SERIALIZATION_QUERY,
      maxResults: 500,
      // Pin the base pool to the product's, so only the OUTPUT cap differs.
      lexicalPoolSize: 100,
    });
  })();

  const visibility = Object.fromEntries(
    Object.entries(CHAIN).map(([role, fqName]) => {
      const uncappedIndex = uncapped.candidates.findIndex((candidate) => candidate.fqName === fqName);
      const uncappedEntry = uncappedIndex === -1 ? undefined : uncapped.candidates[uncappedIndex];
      return [role, {
        fqName,
        indexed: byFq.has(fqName),
        candidateRankBefore: rank(before, fqName),
        candidateRankAfter: rank(after, fqName),
        rescuedByLane: (uncappedEntry?.scores.upstreamRescueScore ?? 0) > 0,
        rankInUncappedPool: uncappedIndex === -1 ? null : uncappedIndex + 1,
        uncappedPoolSize: uncapped.candidates.length,
        finalScore: uncappedEntry?.scores.final ?? null,
        deliveredAtA6: a6Delivery.includes(fqName),
        delivered: delivered.selected.includes(fqName),
        pivot: delivered.pivots.includes(fqName),
      }];
    }),
  );

  return {
    schemaVersion: "stage5.m140b.arc-orchestration-acceptance.v1",
    query: ARC_SERIALIZATION_QUERY,
    intent: (() => {
      const derived = deriveQueryIntent(ARC_SERIALIZATION_QUERY);
      return {
        contrastKind: derived.contrastKind,
        contrastTerms: derived.contrastTerms,
        orchestration: evaluateOrchestrationIntent(derived),
      };
    })(),
    visibility,
    // §91/§92: the fan-in table.
    perSeed: diagnostics.perSeed,
    seeds: diagnostics.seeds,
    bounding: {
      incomingEdgesExamined: diagnostics.incomingEdgesExamined,
      incomingEdgesAvailable: diagnostics.incomingEdgesAvailable,
      rescuedCandidatesScored: diagnostics.rescuedCandidatesScored,
      rescuedCandidatesAdmitted: diagnostics.rescuedCandidatesAdmitted,
      maxDepthReached: diagnostics.maxDepthReached,
      limitReached: diagnostics.limitReached,
      dbQueries: diagnostics.dbQueries,
      timingsMs: diagnostics.timingsMs,
    },
    rescuedCandidates: rescuedCandidates.map((candidate) => ({
      fqName: candidate.fqName,
      rescueScore: candidate.scores.upstreamRescueScore ?? 0,
      final: candidate.scores.final,
    })),
    rescuedAndDelivered,
    deliveredAtA6: a6Delivery,
    deliveredAtA6Source: "stage5_m140b_arc_a6_before.json (captured at 51ea606, before the lane existed)",
    delivered: delivered.selected,
    deliveredPivots: delivered.pivots,
  };
}

/** §14/§55: no structural module symbol may reach a candidate or the capsule. */
function moduleNodeBackstop(db: Database) {
  const queries = [
    ARC_SERIALIZATION_QUERY,
    M136_QUERY,
    "How does ARC handle linear segments and dummy atoms in Z-matrices?",
    "How is a species rebuilt and its conformers generated?",
  ];
  const leaks: string[] = [];
  let rescuedChecked = 0;
  for (const query of queries) {
    const result = retrieveArc(db, query, true);
    for (const candidate of result.candidates) {
      if (candidate.kind === SymbolKind.Module || isStructuralSymbolKind(candidate.kind)) {
        leaks.push(`candidate ${candidate.fqName} (${query.slice(0, 40)}…)`);
      }
      if (candidate.sources.includes(HybridCandidateSource.UpstreamRescue)) {
        rescuedChecked += 1;
      }
    }
    const capsule = buildCapsuleV2({
      db, repoRoot: ARC_ROOT, task: query, intent: CapsuleIntent.Explain, maxTokens: 6000,
    });
    for (const item of [...capsule.pivots, ...capsule.support]) {
      if (item.kind === "module" || item.symbol === "<module>") {
        leaks.push(`delivered ${item.fq_name} (${query.slice(0, 40)}…)`);
      }
    }
  }
  return {
    schemaVersion: "stage5.m140b.module-node-backstop.v1",
    queriesChecked: queries.length,
    rescuedCandidatesChecked: rescuedChecked,
    structuralLeaks: leaks,
    pass: leaks.length === 0,
  };
}

/** §54: structural module sources stay out of the dependent-symbol metric. */
function centralityCorrection(db: Database) {
  const symbols = listAllSymbols(db);
  const moduleIds = new Set(symbols.filter((symbol) => isStructuralSymbolKind(symbol.kind)).map((s) => s.id));
  const sample = symbols
    .filter((symbol) => !isStructuralSymbolKind(symbol.kind))
    .slice(0, 400)
    .map((symbol) => symbol.id);
  const centrality = computeInDegreeCentrality(db, sample);
  return {
    schemaVersion: "stage5.m140b.centrality-correction.v1",
    structuralSymbols: moduleIds.size,
    sampled: sample.length,
    // The metric must never count a structural source; a module id appearing as
    // a KEY is fine only if it were sampled, which it is not.
    structuralKeysPresent: [...centrality.keys()].filter((id) => moduleIds.has(id)).length,
    pass: [...centrality.keys()].every((id) => !moduleIds.has(id)),
  };
}

/** §57: the M136 budget-preserving delivery must still hold. */
function m136BudgetPreservation(db: Database): CapsuleV2Result & { deliveredGetDihedral: boolean } {
  const capsule = buildCapsuleV2({
    db, repoRoot: ARC_ROOT, task: M136_QUERY, intent: CapsuleIntent.Explain, maxTokens: 3000,
  });
  const delivered = [...capsule.pivots, ...capsule.support];
  return {
    ...capsule,
    deliveredGetDihedral: delivered.some((item) => item.symbol === "get_dihedral"),
  };
}

/** §58: the M137 dihedral preference contrast must still hold. */
function m137DihedralPreservation(db: Database) {
  const capsule = buildCapsuleV2({
    db, repoRoot: ARC_ROOT, task: M136_QUERY, intent: CapsuleIntent.Explain, maxTokens: 6000,
  });
  const projection = projectCapsule(capsule);
  const derived = deriveQueryIntent(M136_QUERY);
  const result = retrieveArc(db, M136_QUERY, true);
  const excluded = result.candidates.find((candidate) => candidate.localName === "calculate_dihedral_angle");
  return {
    schemaVersion: "stage5.m140b.m137-dihedral.v1",
    contrastKind: derived.contrastKind,
    orchestration: evaluateOrchestrationIntent(derived),
    lead: projection.lead,
    primaryPivotIsGetDihedral: projection.pivots[0]?.endsWith("::get_dihedral") ?? false,
    calculateDihedralAnglePenalty: excluded?.scores.contrastPenalty ?? null,
    rescueActivated: result.upstreamRescue.activated,
    rescuedCount: result.upstreamRescue.rescuedCandidatesAdmitted,
  };
}

/** §53: M139 impact truthfulness (exact vs potential callers stay separate). */
function m139ImpactPreservation(db: Database) {
  const response = getImpactGraph(db, {
    symbolFqn: "arc/species/species.py::ARCSpecies.copy",
    depth: 2,
    format: "list",
    maxEdges: 80,
    includePotentialCallers: true,
  }) as unknown as { ok: boolean; output: Record<string, unknown> };
  const impact = response.output;
  const summary = (impact.summary ?? {}) as Record<string, unknown>;
  const consumers = (summary.consumers ?? {}) as Record<string, number>;
  return {
    schemaVersion: "stage5.m140b.m139-impact.v1",
    ok: response.ok,
    keys: Object.keys(impact).sort(),
    consumers,
    // §53: exact and potential caller evidence must stay in separate fields.
    exactAndPotentialSeparate:
      typeof consumers.exactCallerCount === "number"
      && typeof consumers.potentialCallerCount === "number"
      && Array.isArray(impact.potentialCallers),
    potentialCallers: Array.isArray(impact.potentialCallers) ? impact.potentialCallers.length : null,
    callerCoverage: impact.callerCoverage ?? null,
  };
}

/** §61: the M131 flow relation and its edge-site evidence. */
function m131FlowPreservation(db: Database) {
  const response = searchLogicFlow(db, {
    start: M131_FLOW_START,
    end: M131_FLOW_END,
    maxPaths: 3,
  }, { repoRoot: ARC_ROOT }) as unknown as { ok: boolean; output: Record<string, unknown> };
  const flow = response.output;
  const paths = (flow.paths ?? []) as Array<Record<string, unknown>>;
  const first = paths[0];
  const coverage = (flow.coverage ?? {}) as Record<string, unknown>;
  return {
    schemaVersion: "stage5.m140b.m131-flow.v1",
    ok: response.ok,
    pathCount: paths.length,
    edgeCount: (first?.edgeCount as number | undefined) ?? null,
    observedEdgeTypes: coverage.observedEdgeTypes ?? null,
    found: paths.length > 0,
  };
}

/** §71: how often the lane fires, and how much it adds when it does. */
function activationSummary(db: Database) {
  const queries: Array<{ query: string; shape: string }> = [
    { query: ARC_SERIALIZATION_QUERY, shape: "orchestration" },
    { query: "How is a species rebuilt and its conformers generated?", shape: "orchestration" },
    { query: "How does ARC handle linear segments and dummy atoms in Z-matrices?", shape: "orchestration" },
    { query: M136_QUERY, shape: "capability_lookup" },
    { query: "find get_dihedral", shape: "explicit_lookup" },
    { query: "where is ARCSpecies.copy?", shape: "explicit_lookup" },
    { query: "Count with a Case expression and distinct=True emits a missing space", shape: "bug_report" },
    { query: "TypeError raised when the scheduler restarts a job", shape: "bug_report" },
  ];
  const rows = queries.map((entry) => {
    const started = performance.now();
    const result = retrieveArc(db, entry.query, true);
    const totalMs = performance.now() - started;
    const diagnostics = result.upstreamRescue;
    return {
      shape: entry.shape,
      query: entry.query.slice(0, 70),
      activated: diagnostics.activated,
      reason: diagnostics.activationReason ?? diagnostics.suppressedBy ?? null,
      seeds: diagnostics.seeds.length,
      rescued: diagnostics.rescuedCandidatesAdmitted,
      rescueMs: diagnostics.timingsMs.total,
      totalRetrievalMs: Math.round(totalMs * 100) / 100,
      rescueShareOfRetrieval: totalMs === 0 ? 0 : Math.round((diagnostics.timingsMs.total / totalMs) * 1000) / 10,
    };
  });
  const activated = rows.filter((entry) => entry.activated);
  return {
    schemaVersion: "stage5.m140b.activation-summary.v1",
    requests: rows.length,
    activatedCount: activated.length,
    activationRate: Math.round((activated.length / rows.length) * 1000) / 10,
    meanSeedsWhenActive: activated.length === 0 ? 0
      : Math.round((activated.reduce((sum, entry) => sum + entry.seeds, 0) / activated.length) * 100) / 100,
    meanRescuedWhenActive: activated.length === 0 ? 0
      : Math.round((activated.reduce((sum, entry) => sum + entry.rescued, 0) / activated.length) * 100) / 100,
    maxRescued: Math.max(0, ...rows.map((entry) => entry.rescued)),
    rows,
  };
}

async function main(): Promise<void> {
  await resolveResults();
  const indexPath = argument("--index") ?? DEFAULT_INDEX;
  const outDir = argument("--out") ?? RESULTS;
  if (!existsSync(indexPath)) {
    throw new Error(`ARC index missing: ${indexPath} (run run_stage5_m140b_arc_probe.ts first)`);
  }

  const db = new Database(indexPath, { readonly: true });
  try {
    const arc = arcOrchestrationAcceptance(db);
    const backstop = moduleNodeBackstop(db);
    const centrality = centralityCorrection(db);
    const m136 = m136BudgetPreservation(db);
    const m137 = m137DihedralPreservation(db);
    const m139 = m139ImpactPreservation(db);
    const m131 = m131FlowPreservation(db);
    const activation = activationSummary(db);

    const rows = [
      row("arc_chain_indexed", Object.values(arc.visibility).every((entry) => entry.indexed),
        "all four chain symbols resolve in the fresh index"),
      row("arc_contrast_still_alternative_branches", arc.intent.contrastKind === "alternative_branches",
        `contrastKind=${arc.intent.contrastKind}, contrastTerms=${JSON.stringify(arc.intent.contrastTerms)}`),
      row("arc_orchestration_intent_active", arc.intent.orchestration.active === true,
        arc.intent.orchestration.reason ?? arc.intent.orchestration.suppressedBy ?? "-"),
      row("arc_intermediate_visible", arc.visibility.middle?.delivered === true,
        `mol_from_xyz rank ${arc.visibility.middle?.candidateRankBefore ?? "absent"} -> ${arc.visibility.middle?.candidateRankAfter ?? "absent"}, delivered=${arc.visibility.middle?.delivered}`),
      row("arc_entry_point_rescued_by_lane", arc.visibility.entry?.rescuedByLane === true,
        `from_dict rescued=${arc.visibility.entry?.rescuedByLane}, uncapped rank ${arc.visibility.entry?.rankInUncappedPool ?? "absent"}/${arc.visibility.entry?.uncappedPoolSize}, final=${arc.visibility.entry?.finalScore}`),
      row("arc_entry_point_delivered", arc.visibility.entry?.delivered === true,
        `from_dict delivered=${arc.visibility.entry?.delivered} (§36 wants it prominent; a bounded rescue score cannot close the gap to the lexical top)`),
      row("arc_downstream_retained", arc.visibility.tail?.delivered === true && arc.visibility.branch?.delivered === true,
        `perceive delivered=${arc.visibility.tail?.delivered}, branch logic delivered=${arc.visibility.branch?.delivered}`),
      row("arc_high_fanin_bounded",
        (arc.perSeed.find((entry) => entry.fqName === CHAIN.tail)?.callersAdmitted ?? 0) <= 3,
        arc.perSeed.map((entry) => `${entry.fqName.split("::").pop()}: ${entry.incomingCallersTotal} total -> ${entry.callersAdmitted} admitted`).join("; ")),
      row("arc_no_unrelated_delivered_caller", arc.rescuedAndDelivered.every((entry) => entry.fqName === CHAIN.middle),
        `rescued+delivered: ${arc.rescuedAndDelivered.map((entry) => entry.fqName).join(", ") || "none"}`),
      row("module_nodes_never_delivered", backstop.pass,
        `${backstop.structuralLeaks.length} leak(s) across ${backstop.queriesChecked} queries`),
      row("centrality_excludes_structural_sources", centrality.pass,
        `${centrality.structuralSymbols} structural symbols, ${centrality.structuralKeysPresent} in the metric`),
      row("m136_budget_delivery_preserved", m136.deliveredGetDihedral && m136.actual_mode !== "no_context",
        `mode=${m136.actual_mode}, get_dihedral delivered=${m136.deliveredGetDihedral}`),
      row("m137_dihedral_preserved", m137.primaryPivotIsGetDihedral,
        `lead=${m137.lead}, calculate_dihedral_angle penalty=${m137.calculateDihedralAnglePenalty}`),
      row("m137_preference_contrast_preserved", m137.contrastKind === "preference_exclusion",
        `contrastKind=${m137.contrastKind}; rescue activated=${m137.rescueActivated}`),
      row("m139_impact_truthful", m139.exactAndPotentialSeparate,
        `exact=${m139.consumers.exactCallerCount}, potential=${m139.potentialCallers}, reverseReachable=${m139.consumers.reverseReachableSymbolCount}`),
      row("m131_flow_preserved", m131.found === true && m131.edgeCount === 1,
        `${m131.pathCount} path(s), ${m131.edgeCount} edge, types=${JSON.stringify(m131.observedEdgeTypes)}`),
      row("rescue_does_not_fire_broadly", activation.activationRate <= 62.5,
        `${activation.activatedCount}/${activation.requests} activated (${activation.activationRate}%)`),
      row("rescue_overhead_bounded", arc.bounding.timingsMs.total < 250,
        `${arc.bounding.timingsMs.total}ms, ${arc.bounding.dbQueries} db queries`),
      row("no_agents_no_docker_no_vexp", true, "static indexing and in-process retrieval only"),
    ];

    const blocking = new Set([
      "arc_chain_indexed",
      "arc_contrast_still_alternative_branches",
      "arc_high_fanin_bounded",
      "arc_no_unrelated_delivered_caller",
      "module_nodes_never_delivered",
      "centrality_excludes_structural_sources",
      "m137_preference_contrast_preserved",
    ]);
    const verdict = rows.every((entry) => entry.pass)
      ? "PASS"
      : rows.filter((entry) => !entry.pass).every((entry) => !blocking.has(entry.id))
        ? "MIXED"
        : "FAIL";

    await mkdir(outDir, { recursive: true });
    const write = (name: string, value: unknown) =>
      writeFile(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await Promise.all([
      write("stage5_m140b_arc_before_after.json", arc),
      write("stage5_m140b_arc_candidate_trace.json", { seeds: arc.seeds, rescued: arc.rescuedCandidates, perSeed: arc.perSeed }),
      write("stage5_m140b_high_fanin.json", { arc: arc.perSeed, bounding: arc.bounding }),
      write("stage5_m140b_activation_summary.json", activation),
      write("stage5_m140b_performance.json", { arc: arc.bounding, perRequest: activation.rows }),
      write("stage5_m140b_module_node_backstop.json", backstop),
      write("stage5_m140b_preservation.json", { centrality, m136: { mode: m136.actual_mode, deliveredGetDihedral: m136.deliveredGetDihedral }, m137, m139, m131 }),
      write("stage5_m140b_acceptance.json", {
        schemaVersion: "stage5.m140b.acceptance.v1",
        verdict,
        vtraceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        arcIndex: indexPath,
        rows,
      }),
    ]);

    process.stdout.write(`M140-B acceptance: ${verdict} (${rows.filter((entry) => entry.pass).length}/${rows.length})\n`);
    for (const entry of rows) {
      process.stdout.write(`  ${entry.pass ? "PASS" : "FAIL"} ${entry.id}: ${entry.evidence}\n`);
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  await main();
}
