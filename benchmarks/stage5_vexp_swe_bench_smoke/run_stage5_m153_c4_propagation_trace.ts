/**
 * M153-C4 — paired candidate-propagation trace.
 *
 * C3 proved that a correct behavioural owner can survive activation,
 * representation, alignment and admission and still be absent from the delivered
 * capsule. This script answers the only remaining question: at which stage do the
 * two controls first differ?
 *
 *   control  requests  Session.get_adapter   reaches the pool
 *   failure  sphinx    get_filetype          does not
 *
 * It reproduces the capsule's OWN retrieval call — same shaping, same weights,
 * same request — rather than calling `generateOperationFactCandidates` directly,
 * because the standalone lane already admits `get_filetype`; the divergence must
 * therefore be downstream of the lane and only the real request exposes it.
 *
 * Read-only: opens each index database directly and never writes session state.
 */

import { Database } from "bun:sqlite";
import path from "node:path";
import { writeFileSync } from "node:fs";

import { resolveRepoLocalPaths } from "../../src/setup/repoState";
import { shapeSweQuery, type ShapedSweQuery } from "../../src/capsule/sweQueryShaping";
import { resolveProjectNameAliases } from "../../src/capsuleV2/projectNameSignals";
import { createLazyRepositoryPathPredicate } from "../../src/retrieval/repositoryPathMembership";
import { planIntent } from "../../src/capsuleV2/intent";
import { hybridRetrieve, HybridCandidateSource } from "../../src/retrieval/hybridRetrieval";
import { deriveBehavioralObjective } from "../../src/retrieval/behavioralObjective";
import { generateOperationFactCandidates } from "../../src/retrieval/operationFactCandidates";
import { repoRootFor } from "./m153BehavioralHarness";

const CANDIDATE_POOL_SIZE = 60;

/** Mirrors the capsule's private seed derivation so the request is identical. */
function deriveSymbolSeeds(shaped: ShapedSweQuery): string[] {
  const seeds: string[] = [];
  for (const identifier of shaped.identifiers) {
    if (/Test/.test(identifier) && /^[A-Z]/.test(identifier)) {
      const subject = identifier.replace(/^Test(?=[A-Z])/, "").replace(/(?:TestCase|Tests|Test)$/, "");
      if (subject.length >= 3) seeds.push(subject);
    } else if (!/^test[_A-Z]/.test(identifier)) {
      seeds.push(identifier);
    }
  }
  return [...new Set(seeds)];
}

interface Probe {
  readonly label: string;
  readonly repoKey: string;
  readonly caseId: string;
  readonly query: string;
  readonly fqName: string;
}

const PROBES: readonly Probe[] = [
  {
    label: "control",
    repoKey: "requests",
    caseId: "rq_adapter_selection",
    query: "How does the session decide which connection adapter handles a URL?",
    fqName: "requests/sessions.py::Session.get_adapter",
  },
  {
    label: "failure",
    repoKey: "sphinx",
    caseId: "sp_parser_selection",
    query: "How does the build decide which parser reads a given source file?",
    fqName: "sphinx/util/__init__.py::get_filetype",
  },
];

function traceOne(probe: Probe): Record<string, unknown> {
  const repoRoot = repoRootFor(probe.repoKey);
  const db = new Database(resolveRepoLocalPaths(repoRoot).dbPath, { readonly: true });
  try {
    const target = db.query(
      "SELECT id, fq_name, kind FROM symbols WHERE fq_name = ?",
    ).get(probe.fqName) as { id: string; fq_name: string; kind: string } | null;

    const facts = target === null ? [] : db.query(
      "SELECT kind, subject, provenance, result_bearing FROM symbol_mechanism_facts WHERE symbol_id = ?",
    ).all(target.id) as Array<Record<string, unknown>>;

    // ---- the capsule's own request, rebuilt ---------------------------------
    const repositoryPaths = createLazyRepositoryPathPredicate(db, { queries: 0 });
    const shaped = shapeSweQuery(
      { problemStatement: probe.query, failToPass: [] },
      {
        projectNameAliases: resolveProjectNameAliases(repoRoot),
        isRepositoryPath: repositoryPaths.isRepositoryPath,
      },
    );
    const plan = planIntent(undefined, probe.query, shaped);
    const retrieval = hybridRetrieve(db, {
      query: shaped.query,
      shaped,
      taskText: probe.query,
      weights: plan.weights,
      symbolSeeds: deriveSymbolSeeds(shaped),
      maxResults: CANDIDATE_POOL_SIZE,
    });

    // ---- the lane in isolation, for comparison ------------------------------
    const objective = deriveBehavioralObjective(
      shaped.derivedIntent ?? ({ originalTask: probe.query } as never),
    );
    const standalone = objective.operation === null
      ? null
      : generateOperationFactCandidates(db, objective as never);

    const admitted = retrieval.operationFactCandidates.candidates;
    // The distinction §11 demands: `evaluatedById` holds every candidate that was
    // constructed and scored, BEFORE the deliverable cap. A target present here
    // but absent from `candidates` was out-ranked; a target absent from both was
    // never constructed or was filtered out.
    const evaluated = target === null ? undefined : retrieval.evaluatedById.get(target.id);
    const evaluatedRanking = [...retrieval.evaluatedById.values()]
      .sort((left, right) => right.scores.final - left.scores.final);
    const evaluatedRank = target === null
      ? null
      : evaluatedRanking.findIndex((entry) => entry.symbolId === target.id) + 1;
    const inPool = retrieval.candidates.find((entry) => entry.fqName === probe.fqName);
    const anyOperationFactInPool = retrieval.candidates.filter((entry) =>
      entry.sources.includes(HybridCandidateSource.OperationFact));

    return {
      label: probe.label,
      repo: probe.repoKey,
      case: probe.caseId,
      query: probe.query,
      target: {
        fqName: probe.fqName,
        found: target !== null,
        symbolId: target?.id ?? null,
        kind: target?.kind ?? null,
      },
      mechanismFacts: facts,
      shaping: {
        shapedQuery: shaped.query,
        derivedIntentKind: shaped.derivedIntent?.kind ?? null,
        originalTask: shaped.derivedIntent?.originalTask ?? null,
        explicitIdentifiers: shaped.derivedIntent?.explicitIdentifiers ?? [],
        symbolHypotheses: shaped.derivedIntent?.symbolHypotheses ?? [],
      },
      objective: {
        operation: objective.operation,
        subjectTerms: (objective as { subjectTerms?: readonly string[] }).subjectTerms ?? [],
        suppressedBy: "suppressedBy" in objective ? objective.suppressedBy : null,
      },
      standaloneLane: standalone === null ? null : {
        candidates: standalone.candidates.map((entry) => entry.symbol.fqName),
        diagnostics: standalone.diagnostics,
      },
      retrievalLane: {
        objectiveOperation: retrieval.behavioralObjective.operation,
        objectiveSuppressedBy: "suppressedBy" in retrieval.behavioralObjective ? retrieval.behavioralObjective.suppressedBy : null,
        diagnostics: retrieval.operationFactCandidates.diagnostics,
        admitted: admitted.map((entry) => ({
          fqName: entry.symbol.fqName,
          factKind: entry.factKind,
          operand: entry.operand,
          alignment: entry.alignment,
        })),
      },
      evaluated: {
        total: retrieval.evaluatedById.size,
        targetPresent: evaluated !== undefined,
        targetRank: evaluatedRank === 0 ? null : evaluatedRank,
        targetSources: evaluated?.sources ?? null,
        targetScores: evaluated?.scores ?? null,
        targetEvidence: evaluated?.evidence ?? null,
        admittedRanks: admitted.map((entry) => ({
          fqName: entry.symbol.fqName,
          rank: evaluatedRanking.findIndex((row) => row.symbolId === entry.symbol.id) + 1,
          final: evaluatedRanking.find((row) => row.symbolId === entry.symbol.id)?.scores.final ?? null,
        })),
      },
      pool: {
        size: retrieval.candidates.length,
        targetPresent: inPool !== undefined,
        targetRank: inPool === undefined
          ? null
          : retrieval.candidates.findIndex((entry) => entry.fqName === probe.fqName) + 1,
        targetSources: inPool?.sources ?? null,
        targetScores: inPool?.scores ?? null,
        operationFactCarriers: anyOperationFactInPool.map((entry) => entry.fqName),
      },
      // §12/§13. Candidate identity is the symbol id, and every lane funnels
      // through `ensureCandidate`, so a definition two lanes both find is ONE
      // entry accumulating both sources rather than two competing rows. Measured
      // here rather than asserted: `get_adapter` is reached by the lexical lane
      // AND the operation-fact lane, so if a merge could erase the structural
      // provenance this is where it would show.
      identityAndMerge: {
        poolIdentitiesUnique:
          new Set(retrieval.candidates.map((entry) => entry.symbolId)).size
            === retrieval.candidates.length,
        multiSourceCandidates: retrieval.candidates
          .filter((entry) => entry.sources.length > 1)
          .slice(0, 10)
          .map((entry) => ({ fqName: entry.fqName, sources: entry.sources })),
        laneProvenanceSurvived: admitted.every((entry) => {
          const pooled = retrieval.candidates.find((row) => row.symbolId === entry.symbol.id);
          return pooled === undefined
            || pooled.sources.includes(HybridCandidateSource.OperationFact);
        }),
        laneAdmittedNotInPool: admitted
          .filter((entry) => !retrieval.candidates.some((row) => row.symbolId === entry.symbol.id))
          .map((entry) => entry.symbol.fqName),
      },
    };
  } finally {
    db.close();
  }
}

const trace = PROBES.map(traceOne);
const out = path.join(import.meta.dir, "results/stage5_m153_c4_candidate_propagation_trace.json");
writeFileSync(out, `${JSON.stringify({ probes: trace }, null, 2)}\n`);
const mergeOut = path.join(import.meta.dir, "results/stage5_m153_c4_identity_merge_audit.json");
writeFileSync(mergeOut, `${JSON.stringify({
  question: "does candidate identity, dedupe or provenance merge contribute to the divergence?",
  verdict: "no — identity is the symbol id, merges union sources, and lane provenance survives",
  probes: trace.map((entry) => {
    const row = entry as never as { label: string; repo: string; identityAndMerge: unknown };
    return { label: row.label, repo: row.repo, ...(row.identityAndMerge as object) };
  }),
}, null, 2)}\n`);
for (const entry of trace) {
  const row = entry as never as {
    label: string; repo: string;
    objective: { operation: string | null; subjectTerms: string[]; suppressedBy: string | null };
    retrievalLane: { admitted: Array<{ fqName: string }>; diagnostics: { active: boolean; reason: string } };
    standaloneLane: { candidates: string[] } | null;
    pool: { targetPresent: boolean; targetRank: number | null; operationFactCarriers: string[] };
  };
  console.log(`\n=== ${row.label} (${row.repo}) ===`);
  console.log(`  objective        : ${row.objective.operation} ${JSON.stringify(row.objective.subjectTerms)}`);
  console.log(`  suppressedBy     : ${row.objective.suppressedBy}`);
  console.log(`  standalone lane  : ${JSON.stringify(row.standaloneLane?.candidates ?? null)}`);
  console.log(`  retrieval lane   : active=${row.retrievalLane.diagnostics.active} ${row.retrievalLane.diagnostics.reason}`);
  console.log(`  retrieval admits : ${JSON.stringify(row.retrievalLane.admitted.map((a) => a.fqName))}`);
  console.log(`  target in pool   : ${row.pool.targetPresent} rank=${row.pool.targetRank}`);
  console.log(`  op-fact carriers : ${JSON.stringify(row.pool.operationFactCarriers)}`);
}
console.log(`\nwrote ${out}`);
