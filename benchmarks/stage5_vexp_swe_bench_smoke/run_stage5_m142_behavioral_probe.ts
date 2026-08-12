// M142 §7 behavioral-failure reproduction probe.
//
// Five failure modes were reported from real agent use. Before any of them can be
// FIXED they have to be MEASURED against the M141 predecessor, on a fresh index,
// with the producer that caused each one named rather than guessed (§92, §93).
//
// The probe answers three questions per behavioral query:
//
//   1. which candidates led / were delivered, and on what evidence
//   2. what ROLE each query token was given (prose vs identifier) — §18
//   3. whether the true concept owner was never generated, generated but low
//      ranked, ranked but not selected, or selected then dropped — §90
//
// ARC is read-only: the index lives under the bench root and ARC's own `.vtrace`
// is never touched. No agents, Docker, VEXP, network, or paid API.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m142_behavioral_probe.ts \
//     --index <path> [--reuse-index] [--label before|after] [--out <dir>]

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { listAllSymbols } from "../../src/db/repositories/symbolsRepository";
import { initializeSchema } from "../../src/db/schema";
import { isStructuralSymbolKind, type SymbolRecord } from "../../src/domain/types";
import { indexProject } from "../../src/indexer/indexProject";
import { shapeSweQuery } from "../../src/capsule/sweQueryShaping";
import { resolveProjectNameAliases } from "../../src/capsuleV2/projectNameSignals";
import { CapsuleIntent, type CapsuleV2Result } from "../../src/capsuleV2/types";
import { prepareRunnerOutput, SHARED_RUNNER_OPTIONS_HELP } from "./lib/runnerPaths";

const ARC_ROOT = path.resolve(process.env.M142_ARC_ROOT ?? "/home/calvin/code/ARC");
const DEFAULT_INDEX = "/home/calvin/bench/vtrace-m142/arc-m141.sqlite";
const RUNNER_NAME = "m142_behavioral_probe";
const BUDGET_TOKENS = 6_000;

/**
 * The four real behavioral failures (§83) plus the controls M142 must not break.
 *
 * `queryProvenance` is explicit: only the M140 serialization query survives
 * verbatim from a recorded artifact. The four M142 queries are RECONSTRUCTED from
 * the failure report's wording — §83 forbids claiming verbatim provenance we do
 * not have.
 */
export interface BehavioralCase {
  readonly id: string;
  readonly query: string;
  readonly queryProvenance: "verbatim_recorded" | "reconstructed_from_report";
  /** What the report says went wrong, in one line. */
  readonly reportedFailure: string;
  /** File that owns the concept, confirmed against current ARC (§45). */
  readonly expectedOwnerFile: string;
  /** Answer-bearing definitions inside the owner, by exact indexed FQN. */
  readonly expectedDefinitions: readonly string[];
  /** Candidates whose LEAD status would be a hygiene failure. */
  readonly falsePositiveLeads: readonly string[];
  readonly category: string;
}

export const ARC_BEHAVIORAL_CASES: readonly BehavioralCase[] = [
  {
    id: "arc_normal_mode_displacement",
    // Deliberately does NOT contain "normal mode displacement". A wording that
    // reuses the implementation's own words tests lexical search, not concept
    // ownership: the first reconstruction did, and nmd.py came back top-1 on the
    // predecessor, which would have recorded a passing "before".
    query:
      "How does ARC verify that a saddle point actually connects the intended "
      + "reactants and products by looking at how the atoms move in the imaginary "
      + "vibration?",
    queryProvenance: "reconstructed_from_report",
    reportedFailure:
      "the normal-mode displacement check module never surfaced; a differently-named "
      + "quantity (expected atom count with largest displacement) was returned instead",
    expectedOwnerFile: "arc/checks/nmd.py",
    expectedDefinitions: ["arc/checks/nmd.py::analyze_ts_normal_mode_displacement"],
    falsePositiveLeads: [],
    category: "concept concentrated in one module but weak symbol-name match",
  },
  {
    id: "arc_gaussian_route_keywords",
    // §19 gives this query verbatim; never paraphrase it.
    query: "How does ARC decide which Gaussian route keywords to emit?",
    queryProvenance: "reconstructed_from_report",
    reportedFailure:
      "arc/job/adapters/common.py::which became a lead pivot from the grammatical word "
      + "'which'; arc/main.py::ARC was reported to surface from the project name",
    expectedOwnerFile: "arc/job/adapters/gaussian.py",
    expectedDefinitions: [],
    falsePositiveLeads: ["arc/job/adapters/common.py::which", "arc/main.py::ARC"],
    category: "ordinary English word + project name collide with symbol names",
  },
  {
    id: "arc_reactant_atom_index_space",
    query:
      "When a reaction is mapped, how is the atom index space of the reactants "
      + "established and where does the bond list used for it come from?",
    queryProvenance: "reconstructed_from_report",
    reportedFailure: "get_reactants_and_products / get_bonds never surfaced",
    expectedOwnerFile: "arc/reaction/reaction.py",
    expectedDefinitions: [
      "arc/reaction/reaction.py::ARCReaction.get_reactants_and_products",
      "arc/reaction/reaction.py::ARCReaction.get_bonds",
    ],
    falsePositiveLeads: [],
    category: "concept distributed across two helpers",
  },
  {
    id: "arc_ts_guess_atom_order",
    query:
      "How is the atom order of a transition state guess brought into line with the "
      + "numbering used by the mapped product geometry?",
    queryProvenance: "reconstructed_from_report",
    reportedFailure: "get_single_mapped_product_xyz / order_xyz_by_atom_map never surfaced",
    expectedOwnerFile: "arc/reaction/reaction.py",
    expectedDefinitions: [
      "arc/reaction/reaction.py::ARCReaction.get_single_mapped_product_xyz",
      "arc/species/converter.py::order_xyz_by_atom_map",
    ],
    falsePositiveLeads: [],
    category: "behavior described without implementation name",
  },
];

/** Explicit-lookup positive controls: these must KEEP working (§137). */
export const ARC_EXPLICIT_CONTROLS: readonly BehavioralCase[] = [
  {
    id: "arc_explicit_which_lookup",
    query: "Where is which() implemented?",
    queryProvenance: "reconstructed_from_report",
    reportedFailure: "n/a — positive control",
    expectedOwnerFile: "arc/job/adapters/common.py",
    expectedDefinitions: ["arc/job/adapters/common.py::which"],
    falsePositiveLeads: [],
    category: "explicit identifier positive control",
  },
  {
    id: "arc_explicit_arc_class_lookup",
    query: "Where is the ARC class defined?",
    queryProvenance: "reconstructed_from_report",
    reportedFailure: "n/a — positive control",
    expectedOwnerFile: "arc/main.py",
    expectedDefinitions: ["arc/main.py::ARC"],
    falsePositiveLeads: [],
    category: "explicit project-named class positive control",
  },
  {
    id: "arc_broad_vague_control",
    query: "How does ARC work?",
    queryProvenance: "reconstructed_from_report",
    reportedFailure: "n/a — negative control: must not expand half the repository",
    expectedOwnerFile: "",
    expectedDefinitions: [],
    falsePositiveLeads: [],
    category: "broad vague query control",
  },
];

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

export async function buildArcIndex(indexPath: string): Promise<number> {
  await mkdir(path.dirname(indexPath), { recursive: true });
  const started = performance.now();
  const db = new Database(indexPath);
  try {
    initializeSchema(db);
    await indexProject({ repoRoot: ARC_ROOT, db });
  } finally {
    db.close();
  }
  return Math.round(performance.now() - started);
}

/**
 * §18: the role every task token was given, and whether it may seed an exact
 * symbol lookup. This is the observation that turns "which() showed up" into a
 * named producer rather than a symptom.
 */
export function identifierRoleMatrix(task: string, repoRoot: string) {
  const shaped = shapeSweQuery(
    { problemStatement: task },
    { projectNameAliases: resolveProjectNameAliases(repoRoot) },
  );
  const intent = shaped.derivedIntent;
  return {
    likelySymbols: shaped.likelySymbols,
    identifiers: shaped.identifiers,
    filteredGenericSymbols: shaped.filteredGenericSymbols,
    shapedQuery: shaped.query,
    explicitIdentifiers: intent?.explicitIdentifiers ?? [],
    projectReferences: intent?.projectReferences ?? [],
    symbolHypotheses: (intent?.symbolHypotheses ?? []).map((signal) => ({
      term: signal.term,
      role: signal.confidence,
      source: signal.source,
      exactSymbolEligible: signal.eligibleAsSymbol,
      reason: signal.reason,
    })),
    identifierSignals: (intent?.identifierSignals ?? []).map((signal) => ({
      term: signal.term,
      role: signal.confidence,
      source: signal.source,
      exactSymbolEligible: signal.eligibleAsSymbol,
    })),
  };
}

export interface CandidateRow {
  readonly rank: number;
  readonly fqName: string;
  readonly path: string;
  readonly final: number;
  readonly lexical: number;
  readonly symbol: number;
  readonly domain: number;
  readonly centrality: number;
  readonly inDegree: number;
  readonly hubPenalty: number;
  readonly localEvidence: number;
  readonly identifierConfidence?: string;
  readonly sources: readonly string[];
}

export function projectCapsule(result: CapsuleV2Result) {
  const ref = (item: { fq_name: string }): string => item.fq_name;
  const items = [...result.pivots, ...result.support];
  const candidates: CandidateRow[] = (result.diagnostics.candidate_scores ?? []).map((entry) => ({
    rank: entry.rank,
    fqName: entry.fq_name,
    path: entry.path,
    final: entry.scores.final,
    lexical: entry.scores.lexical,
    symbol: entry.scores.symbol,
    domain: entry.scores.domain,
    centrality: entry.scores.centrality,
    inDegree: entry.scores.inDegree,
    hubPenalty: entry.scores.hubPenalty,
    localEvidence: entry.scores.localEvidence,
    ...(entry.identifier_confidence === undefined
      ? {}
      : { identifierConfidence: entry.identifier_confidence }),
    sources: entry.sources,
  }));
  return {
    mode: result.actual_mode,
    lead: result.pivots[0] === undefined ? null : ref(result.pivots[0]),
    pivots: result.pivots.map(ref),
    support: result.support.map(ref),
    selected: items.map(ref),
    selectedFiles: [...new Set(items.map((item) => item.path))],
    candidates,
  };
}

/**
 * §90: distinguish candidate ABSENCE from ranking failure. Resolution is by exact
 * indexed FQN — a local-name suffix match reports `TSGuess.from_dict` as
 * `ARCSpecies.from_dict` and turns an absent symbol into a false positive.
 */
export function classifyVisibility(
  symbols: readonly SymbolRecord[],
  projection: ReturnType<typeof projectCapsule>,
  fqName: string,
) {
  const symbol = symbols.find((candidate) => candidate.fqName === fqName);
  if (symbol === undefined) {
    return { fqName, indexed: false as const, state: "not_indexed" as const };
  }
  const candidate = projection.candidates.find((entry) => entry.fqName === fqName);
  const selected = projection.selected.includes(fqName);
  const pivot = projection.pivots.includes(fqName);
  const state = selected
    ? (pivot ? "pivot" : "selected_support")
    : candidate === undefined
      ? "not_generated"
      : "generated_not_selected";
  return {
    fqName,
    indexed: true as const,
    state,
    candidateRank: candidate?.rank ?? null,
    finalScore: candidate?.final ?? null,
    lead: projection.lead === fqName,
  };
}

/** Owner-file visibility: the metric §88 wants, computed from delivered items. */
export function ownerFileRank(
  projection: ReturnType<typeof projectCapsule>,
  ownerFile: string,
): { top1: boolean; top3: boolean; anywhere: boolean; bestCandidateRank: number | null } {
  if (ownerFile.length === 0) {
    return { top1: false, top3: false, anywhere: false, bestCandidateRank: null };
  }
  const orderedFiles: string[] = [];
  for (const fq of projection.selected) {
    const file = fq.split("::")[0] ?? fq;
    if (!orderedFiles.includes(file)) orderedFiles.push(file);
  }
  const index = orderedFiles.indexOf(ownerFile);
  const best = projection.candidates.find((entry) => entry.path === ownerFile);
  return {
    top1: index === 0,
    top3: index >= 0 && index < 3,
    anywhere: index >= 0,
    bestCandidateRank: best?.rank ?? null,
  };
}

/**
 * §94: for a highly-central class, what the query alone earned, what centrality
 * added, and what it ended up with. `centralityContribution` is the weighted
 * centrality term actually folded into `final`, so "would it still be here
 * without centrality?" is answerable from the row rather than estimated.
 */
const CENTRALITY_WATCHLIST = [
  "arc/species/species.py::ARCSpecies",
  "arc/reaction/reaction.py::ARCReaction",
  "arc/main.py::ARC",
  "arc/species/species.py::TSGuess",
] as const;

const CENTRALITY_WEIGHT = 0.5;

function centralityTrace(projection: ReturnType<typeof projectCapsule>) {
  return CENTRALITY_WATCHLIST.flatMap((fqName) => {
    const row = projection.candidates.find((entry) => entry.fqName === fqName);
    if (row === undefined) return [];
    const contribution = Math.round(CENTRALITY_WEIGHT * row.centrality * 1e4) / 1e4;
    return [{
      fqName,
      rank: row.rank,
      inDegree: row.inDegree,
      centrality: row.centrality,
      centralityContribution: contribution,
      finalScore: row.final,
      scoreWithoutCentrality: Math.round((row.final - contribution) * 1e4) / 1e4,
      localEvidence: row.localEvidence,
      hubPenalty: row.hubPenalty,
      selected: projection.selected.includes(fqName),
      pivot: projection.pivots.includes(fqName),
    }];
  });
}

export function runBehavioralCase(db: Database, symbols: readonly SymbolRecord[], testCase: BehavioralCase) {
  const started = performance.now();
  const capsule = buildCapsuleV2({
    db,
    repoRoot: ARC_ROOT,
    task: testCase.query,
    intent: CapsuleIntent.Explain,
    maxTokens: BUDGET_TOKENS,
  });
  const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  const projection = projectCapsule(capsule);
  const owner = ownerFileRank(projection, testCase.expectedOwnerFile);
  const serialized = JSON.stringify(capsule);

  // Owner-file definitions actually present in the index, so an acceptance can be
  // stated against real symbols rather than remembered names.
  const ownerDefinitions = symbols
    .filter((symbol) => symbol.filePath === testCase.expectedOwnerFile && !isStructuralSymbolKind(symbol.kind))
    .map((symbol) => symbol.fqName);

  return {
    id: testCase.id,
    category: testCase.category,
    query: testCase.query,
    queryProvenance: testCase.queryProvenance,
    reportedFailure: testCase.reportedFailure,
    elapsedMs,
    identifierRoles: identifierRoleMatrix(testCase.query, ARC_ROOT),
    retrieval: {
      mode: projection.mode,
      lead: projection.lead,
      pivots: projection.pivots,
      support: projection.support,
      selectedFiles: projection.selectedFiles,
      topCandidates: projection.candidates.slice(0, 15),
    },
    ownerFile: { path: testCase.expectedOwnerFile, ...owner, indexedDefinitions: ownerDefinitions.length },
    expectedDefinitions: testCase.expectedDefinitions.map((fqName) =>
      classifyVisibility(symbols, projection, fqName)),
    falsePositiveLeads: testCase.falsePositiveLeads.map((fqName) =>
      classifyVisibility(symbols, projection, fqName)),
    centralityTrace: centralityTrace(projection),
    response: {
      serializedBytes: serialized.length,
      pivotCount: capsule.pivots.length,
      supportCount: capsule.support.length,
    },
  };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`run_stage5_m142_behavioral_probe.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    return;
  }
  const target = await prepareRunnerOutput({ argv: process.argv.slice(2), runner: RUNNER_NAME });
  const indexPath = argument("--index") ?? DEFAULT_INDEX;
  const label = argument("--label") ?? "m141_before";
  const reuse = process.argv.includes("--reuse-index") && existsSync(indexPath);

  let indexMs: number | null = null;
  if (!reuse) {
    process.stdout.write(`indexing ARC -> ${indexPath}\n`);
    indexMs = await buildArcIndex(indexPath);
  }

  const db = new Database(indexPath, { readonly: true });
  try {
    const symbols = listAllSymbols(db);
    const cases = [...ARC_BEHAVIORAL_CASES, ...ARC_EXPLICIT_CONTROLS]
      .map((testCase) => runBehavioralCase(db, symbols, testCase));

    const artifact = {
      schemaVersion: "stage5.m142.behavioral-failures.v1",
      label,
      generatedFrom: {
        vtraceHead: git(process.cwd(), ["rev-parse", "HEAD"]),
        vtraceBranch: git(process.cwd(), ["rev-parse", "--abbrev-ref", "HEAD"]),
        arcRoot: ARC_ROOT,
        arcHead: git(ARC_ROOT, ["rev-parse", "HEAD"]),
        arcTrackedClean: git(ARC_ROOT, ["status", "--porcelain", "--untracked-files=no"]).length === 0,
        indexPath,
        indexBuildMs: indexMs,
        indexedSymbols: symbols.length,
      },
      cases,
    };
    const outPath = path.join(target.dir, `stage5_m142_behavioral_failures_${label}.json`);
    await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    process.stdout.write(`${outPath}\n`);
    for (const entry of cases) {
      process.stdout.write(
        `${entry.id}: lead=${entry.retrieval.lead ?? "-"} owner(${entry.ownerFile.path})`
        + ` top1=${entry.ownerFile.top1} top3=${entry.ownerFile.top3} anywhere=${entry.ownerFile.anywhere}`
        + ` bytes=${entry.response.serializedBytes}\n`,
      );
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  await main();
}
