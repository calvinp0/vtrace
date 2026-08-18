/**
 * M159-B §20–§34 — for every residual case, find the EARLIEST product stage at
 * which the useful evidence stopped being available to the downstream model.
 *
 * The stage model this walks is the product's own, not an abstraction imposed on
 * it:
 *
 *   index representation -> query shaping -> hybrid generation (all lanes) ->
 *   CANDIDATE_POOL_SIZE cap -> post-cap lane injection -> role assignment ->
 *   bounded pivot/support packing -> delivery
 *
 * Two of those boundaries are the ones M158's residual note could not tell
 * apart, and they need different milestones to fix:
 *
 *   - a symbol the generators SCORED and the pool cap then dropped is a bound
 *     question (`CANDIDATE_BOUND_EVICTION`);
 *   - a symbol no generator ever scored is a coverage question
 *     (`LANE_GENERATION_FAILURE`) — no score change can reach it.
 *
 * `hybridRetrieve` already publishes exactly the evidence that separates them.
 * `evaluatedById` holds EVERY candidate the generators scored, including the ones
 * the output cap excluded, and it exists in the product for the anchor lanes'
 * benefit. So the pre-cap read costs no new instrumentation, no relaxed product
 * bound (§27) and no new source read (§78) — it reads a map the product already
 * built for its own use.
 *
 * The retrieval preamble is REPLICATED here rather than exported from
 * `buildCapsuleV2`, because exporting it would be a product change made during an
 * audit that §88 requires to change no product code. The replication is not
 * trusted: every case asserts its capped, re-derived pool against the capsule's
 * own `candidate_scores`, and a case whose replication diverges is reported as
 * `replicationValid: false` rather than silently classified (§14's lesson, one
 * layer down).
 *
 * Reads pinned, already-indexed workspaces. NO agent, NO Docker, NO network, NO
 * indexing, NO writes to any target workspace or index.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { shapeSweQuery, type ShapedSweQuery } from "../../src/capsule/sweQueryShaping";
import { planIntent } from "../../src/capsuleV2/intent";
import { resolveProjectNameAliases } from "../../src/capsuleV2/projectNameSignals";
import { createLazyRepositoryPathPredicate } from "../../src/retrieval/repositoryPathMembership";
import {
  createHybridRetrievalRequestCache,
  hybridRetrieve,
  type HybridCandidate,
} from "../../src/retrieval/hybridRetrieval";
import { STRONG_DIRECT_LEXICAL } from "../../src/retrieval/hybridScoring";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import type { CapsuleV2Result } from "../../src/capsuleV2/types";
import { fileMatches, symbolMatches } from "./run_stage5_retrieval_eval";

/** The product's ordinary candidate bound (`buildCapsuleV2.CANDIDATE_POOL_SIZE`). */
const CANDIDATE_POOL_SIZE = 25;

/**
 * §32 — the first-divergence taxonomy. Ordered upstream-first; the classifier
 * returns the FIRST one that holds, so a symbol that is missing from the index
 * is never reported as a ranking problem however badly it would also have ranked
 * (§33).
 */
export type FirstDivergence =
  | "INDEX_FILE_MISSING"
  | "INDEX_SYMBOL_MISSING"
  | "LANE_GENERATION_FAILURE"
  | "CANDIDATE_GENERATION_POOL_BOUND"
  | "CANDIDATE_BOUND_EVICTION"
  | "RELEVANCE_RANKING"
  | "ROLE_AUTHORITY"
  | "NO_PIVOT_GATE"
  | "SUPPORT_PACKING"
  | "DELIVERED"
  | "UNCLASSIFIED";

interface TraceCase {
  readonly instanceId: string;
  readonly repo: string;
  readonly workspace: string;
  readonly task: string;
  readonly intent: string;
  readonly budget: number;
  readonly expectedFiles: readonly string[];
  readonly expectedSymbols: readonly string[];
}

/** §21/§22 — representation is checked at FILE and SYMBOL level separately. */
export interface IndexRepresentation {
  readonly goldFilesExpected: number;
  readonly goldFilesIndexed: number;
  readonly missingFiles: readonly string[];
  /** Every symbol row in an indexed gold file, so a missing one is provable. */
  readonly goldFileSymbolCount: number;
  readonly goldSymbolsExpected: number;
  readonly goldSymbolsIndexed: number;
  readonly missingSymbols: readonly string[];
  readonly indexedGoldSymbols: readonly {
    readonly fqName: string;
    readonly localName: string;
    readonly kind: string;
    readonly path: string;
    /** §22/§66 — a represented symbol with no edges is not a represented RELATION. */
    readonly edgesIn: number;
    readonly edgesOut: number;
    readonly mechanismFacts: number;
  }[];
}

/** §25/§26 — what the generators produced, read BEFORE the pool cap. */
export interface PreCapObservation {
  readonly evaluatedTotal: number;
  readonly poolCap: number;
  /** Gold-SYMBOL candidates the generators scored, best first. */
  readonly goldSymbolScored: readonly {
    readonly fqName: string;
    readonly path: string;
    /** 1-based position among ALL scored candidates, by final score. */
    readonly preCapRank: number;
    readonly finalScore: number;
    readonly sources: readonly string[];
    readonly evidence: readonly string[];
  }[];
  /** Gold-FILE candidates the generators scored, best first. */
  readonly goldFileScored: readonly {
    readonly fqName: string;
    readonly path: string;
    readonly preCapRank: number;
    readonly finalScore: number;
    readonly sources: readonly string[];
  }[];
  /** True when the re-derived capped pool reproduces the capsule's own order. */
  readonly replicationValid: boolean;
  readonly replicationNote: string;
}

export interface CaseTrace {
  readonly instanceId: string;
  readonly repo: string;
  readonly group: string;
  readonly goldFate: string;
  readonly expectedFiles: readonly string[];
  readonly expectedSymbols: readonly string[];
  readonly representation: IndexRepresentation;
  readonly query: {
    readonly shapedQuery: string;
    readonly identifiers: readonly string[];
    readonly pathClues: readonly { raw: string; normalized: string; kind: string }[];
    readonly likelySymbols: readonly string[];
    /** §67 — the shape the task asks in, so query-type populations are visible. */
    readonly asksByIdentifier: boolean;
    readonly asksByPath: boolean;
    readonly asksByError: boolean;
    readonly asksByTest: boolean;
  };
  readonly preCap: PreCapObservation;
  readonly postCap: {
    readonly candidateCount: number;
    readonly goldFileOrdinaryRank: number | null;
    readonly goldSymbolOrdinaryRank: number | null;
  };
  readonly delivery: {
    readonly mode: string;
    readonly deliveredPivots: number;
    readonly deliveredSupport: number;
    readonly goldFileDelivered: boolean;
    readonly goldSymbolDelivered: boolean;
    readonly goldDiscardReasons: readonly string[];
  };
  readonly firstDivergence: FirstDivergence;
  readonly firstDivergenceDetail: string;
  readonly secondaryContributors: readonly string[];
  readonly confidence: "high" | "medium" | "low";
}

/** Read-only representation probe. Opens nothing the product does not already open. */
function probeRepresentation(db: Database, kase: TraceCase): IndexRepresentation {
  const files = db.query<{ id: string; path: string }, []>("SELECT id, path FROM files").all();
  const indexedGoldFiles = kase.expectedFiles
    .map((expected) => ({ expected, row: files.find((f) => fileMatches(expected, f.path)) }))
    .filter((entry): entry is { expected: string; row: { id: string; path: string } } => entry.row !== undefined);
  const missingFiles = kase.expectedFiles.filter((expected) => !files.some((f) => fileMatches(expected, f.path)));

  const symbolRows = indexedGoldFiles.flatMap((entry) =>
    db.query<{ fq_name: string; local_name: string; kind: string; id: string }, [string]>(
      "SELECT id, fq_name, local_name, kind FROM symbols WHERE file_id = ?",
    ).all(entry.row.id).map((row) => ({ ...row, path: entry.row.path })));

  const indexed: IndexRepresentation["indexedGoldSymbols"][number][] = [];
  const matchedExpected = new Set<string>();
  for (const row of symbolRows) {
    const hits = kase.expectedSymbols.filter((s) => symbolMatches(s, { symbol: row.local_name, fqName: row.fq_name }));
    if (hits.length === 0) continue;
    for (const hit of hits) matchedExpected.add(hit);
    const edgesIn = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM edges WHERE dst_symbol_id = ?").get(row.id)?.n ?? 0;
    const edgesOut = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM edges WHERE src_symbol_id = ?").get(row.id)?.n ?? 0;
    const mechanismFacts = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM symbol_mechanism_facts WHERE symbol_id = ?").get(row.id)?.n ?? 0;
    indexed.push({ fqName: row.fq_name, localName: row.local_name, kind: row.kind, path: row.path, edgesIn, edgesOut, mechanismFacts });
  }

  return {
    goldFilesExpected: kase.expectedFiles.length,
    goldFilesIndexed: indexedGoldFiles.length,
    missingFiles,
    goldFileSymbolCount: symbolRows.length,
    goldSymbolsExpected: kase.expectedSymbols.length,
    goldSymbolsIndexed: matchedExpected.size,
    missingSymbols: kase.expectedSymbols.filter((s) => !matchedExpected.has(s)),
    indexedGoldSymbols: indexed,
  };
}

/** The `deriveSymbolSeeds` rule, replicated verbatim from `buildCapsuleV2`. */
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
  return [...new Set(seeds.map((s) => s.trim()).filter((s) => s !== ""))];
}

/** The `extractFailingTests` rule, replicated verbatim from `buildCapsuleV2`. */
function extractFailingTests(task: string): string[] {
  const ids = new Set<string>();
  for (const match of task.matchAll(/\b[\w./-]+\.py::[\w:]+/g)) ids.add(match[0]);
  for (const match of task.matchAll(/\b[\w.]+\.[A-Z]\w*\.test_\w+\b/g)) ids.add(match[0]);
  return [...ids];
}

function observePreCap(db: Database, kase: TraceCase, capsule: CapsuleV2Result): PreCapObservation {
  const repositoryPaths = createLazyRepositoryPathPredicate(db, { queries: 0 });
  const shaped = shapeSweQuery(
    { problemStatement: kase.task, failToPass: extractFailingTests(kase.task) },
    { projectNameAliases: resolveProjectNameAliases(path.resolve(kase.workspace)), isRepositoryPath: repositoryPaths.isRepositoryPath },
  );
  const plan = planIntent(kase.intent as CapsuleIntent, kase.task, shaped);
  const requestCache = createHybridRetrievalRequestCache();
  const symbolSeeds = deriveSymbolSeeds(shaped);
  let retrieval = hybridRetrieve(db, {
    query: shaped.query,
    shaped,
    taskText: kase.task,
    weights: plan.weights,
    symbolSeeds,
    maxResults: CANDIDATE_POOL_SIZE,
    requestCache,
  });
  // The product's own M121 fallback gate, replicated verbatim. Without it a case
  // whose normal pool carries no direct evidence is audited against a pool the
  // product never used, and `evaluatedById` would under-report by an order of
  // magnitude — which is exactly how `django-15572` first showed up with 6
  // scored candidates against the capsule's 25.
  const normalPoolHasDirectEvidence = retrieval.candidates.some((candidate) =>
    candidate.scores.symbol > 0
    || candidate.scores.path > 0
    || candidate.scores.testToImpl > 0
    || candidate.scores.bodyLiteral > 0
    || candidate.scores.lexical >= STRONG_DIRECT_LEXICAL);
  let compoundRescueUsed = false;
  if (retrieval.candidates.length === 0 || !normalPoolHasDirectEvidence) {
    const rescued = hybridRetrieve(db, {
      query: kase.task,
      shaped,
      taskText: kase.task,
      weights: plan.weights,
      symbolSeeds,
      maxResults: CANDIDATE_POOL_SIZE,
      enableCompoundTaskRescue: true,
      requestCache,
    });
    if (rescued.candidates.length > 0) {
      retrieval = rescued;
      compoundRescueUsed = true;
    }
  }

  // The full scored population, ranked by the same final score the pool cap
  // orders on. This is the pre-bound state §26 asks for.
  const evaluated = [...retrieval.evaluatedById.values()]
    .sort((a, b) => b.scores.final - a.scores.final);
  const ranked = evaluated.map((candidate, index) => ({ candidate, preCapRank: index + 1 }));

  const isGoldFile = (c: HybridCandidate): boolean => kase.expectedFiles.some((f) => fileMatches(f, c.filePath));
  const isGoldSymbol = (c: HybridCandidate): boolean =>
    isGoldFile(c) && kase.expectedSymbols.some((s) => symbolMatches(s, { symbol: c.localName, fqName: c.fqName }));

  // §14 one layer down: a replication that silently diverges would classify every
  // case against the wrong pool. The check is deliberately MEMBERSHIP, not order:
  // `buildCapsuleV2` rescores its pool after `hybridRetrieve` returns (path clues,
  // production and SQL backfills, the anchor lanes), so a re-derived pool that
  // reproduces the product's ORDER would be reproducing a decision hybrid
  // retrieval does not make. What the audit actually relies on is narrower — that
  // every candidate the product admitted was one the generators scored — and that
  // is what is asserted. A capsule entry missing from `evaluatedById` would mean
  // `evaluatedById` under-reports, and the LANE_GENERATION_FAILURE reading with it.
  const evaluatedNames = new Set(evaluated.map((c) => c.fqName));
  const capsulePool = (capsule.diagnostics.candidate_scores ?? []).map((e) => e.fq_name);
  const covered = capsulePool.filter((fq) => evaluatedNames.has(fq)).length;
  const uncovered = capsulePool.filter((fq) => !evaluatedNames.has(fq));
  const replicationValid = capsulePool.length === 0 || covered === capsulePool.length;

  return {
    evaluatedTotal: evaluated.length,
    poolCap: CANDIDATE_POOL_SIZE,
    goldSymbolScored: ranked.filter((r) => isGoldSymbol(r.candidate)).map((r) => ({
      fqName: r.candidate.fqName,
      path: r.candidate.filePath,
      preCapRank: r.preCapRank,
      finalScore: r.candidate.scores.final,
      sources: r.candidate.sources.map(String),
      evidence: [...r.candidate.evidence],
    })),
    goldFileScored: ranked.filter((r) => isGoldFile(r.candidate)).map((r) => ({
      fqName: r.candidate.fqName,
      path: r.candidate.filePath,
      preCapRank: r.preCapRank,
      finalScore: r.candidate.scores.final,
      sources: r.candidate.sources.map(String),
    })),
    replicationValid,
    replicationNote: `${covered}/${capsulePool.length} capsule pool entries present in the scored set`
      + `${compoundRescueUsed ? " (compound-task rescue path)" : ""}`
      + `${uncovered.length === 0 ? "" : `; uncovered: ${uncovered.slice(0, 5).join(", ")}`}`,
  };
}

/**
 * §33 — the classifier. Walks the stages upstream-first and stops at the first
 * one that already lost the evidence. Deliberately keyed on the gold SYMBOL, not
 * the gold file: delivering a sibling definition out of the patched file is not
 * delivering the evidence the task needs, and conflating them is what let the
 * nine deep-ranked cases look like a packing population.
 */
export interface ReachEvidence {
  readonly verdict: "REACHABLE_AT_PRODUCT_POOL" | "REACHABLE_ONLY_DEEPER" | "UNREACHABLE_BY_GENERATION";
  readonly firstReachingPool: number | null;
  readonly rankAtFirstReach: number | null;
  readonly scoreAtFirstReach: number | null;
  readonly downstreamFoothold: {
    readonly parentScored: boolean;
    readonly siblingScored: boolean;
    readonly bestSiblingRank: number | null;
    readonly taskNamesGoldSymbol: boolean;
  };
}

export function classifyFirstDivergence(
  trace: Omit<CaseTrace, "firstDivergence" | "firstDivergenceDetail" | "secondaryContributors" | "confidence">,
  reach: ReachEvidence | undefined,
): {
  divergence: FirstDivergence;
  detail: string;
  secondary: string[];
} {
  const rep = trace.representation;
  const secondary: string[] = [];

  if (rep.goldFilesIndexed === 0) {
    return { divergence: "INDEX_FILE_MISSING", detail: `no gold file indexed (${rep.missingFiles.join(", ")})`, secondary };
  }
  if (rep.goldSymbolsIndexed === 0) {
    return {
      divergence: "INDEX_SYMBOL_MISSING",
      detail: `gold file indexed with ${rep.goldFileSymbolCount} symbols, but no gold symbol among them (${rep.missingSymbols.join(", ")})`,
      secondary,
    };
  }

  const scored = trace.preCap.goldSymbolScored;
  if (scored.length === 0) {
    if (trace.preCap.goldFileScored.length > 0) {
      secondary.push(`a non-gold symbol from the gold file WAS scored at pre-cap rank ${trace.preCap.goldFileScored[0]!.preCapRank}`);
    }
    // "Not scored at the product pool" is two different worlds, and the
    // escalation probe is what separates them (§33). Widening the generation pool
    // is a DIAGNOSTIC, never a proposed bound (§42) — the class it assigns says
    // where the loss happens, not what to set.
    if (reach !== undefined && reach.verdict === "REACHABLE_ONLY_DEEPER") {
      return {
        divergence: "CANDIDATE_GENERATION_POOL_BOUND",
        detail: `gold symbol unscored at the product pool of ${trace.preCap.poolCap}; the generators reach it only at pool ${reach.firstReachingPool}, where it scores ${reach.scoreAtFirstReach?.toFixed(3)} at pre-cap rank ${reach.rankAtFirstReach}`,
        secondary,
      };
    }
    if (reach !== undefined && reach.downstreamFoothold.taskNamesGoldSymbol) {
      // The `sympy-13480` control signature. No residual case carries it, but a
      // future one would, and it must not be silently filed as unreachable.
      secondary.push("task names the gold symbol verbatim: the class-method expansion lane has a foothold this probe does not model");
    }
    return {
      divergence: "LANE_GENERATION_FAILURE",
      detail: `gold symbol indexed (${rep.indexedGoldSymbols.map((s) => s.fqName).join(", ")}) but NO generator lane scored it at any probed pool up to 32x the product's; ${trace.preCap.evaluatedTotal} candidates were scored`,
      secondary,
    };
  }

  const best = scored[0]!;
  if (trace.postCap.goldSymbolOrdinaryRank === null) {
    // Scored but absent from the capsule's pool: the cap is the divergence only
    // if it actually bound. Below the cap and still absent is a different defect.
    if (best.preCapRank > trace.preCap.poolCap) {
      return {
        divergence: "CANDIDATE_BOUND_EVICTION",
        detail: `gold symbol scored ${best.finalScore.toFixed(3)} at pre-cap rank ${best.preCapRank}, dropped by the pool cap of ${trace.preCap.poolCap}`,
        secondary,
      };
    }
    return {
      divergence: "UNCLASSIFIED",
      detail: `gold symbol scored at pre-cap rank ${best.preCapRank}, inside the cap of ${trace.preCap.poolCap}, yet absent from the capsule pool`,
      secondary,
    };
  }

  if (trace.delivery.goldSymbolDelivered) return { divergence: "DELIVERED", detail: "gold symbol delivered", secondary };

  const reasons = trace.delivery.goldDiscardReasons;
  if (reasons.some((r) => /^beyond \w+ support budget/.test(r))) {
    return { divergence: "SUPPORT_PACKING", detail: `gold symbol admitted at ordinary rank ${trace.postCap.goldSymbolOrdinaryRank} and lost a support slot`, secondary };
  }
  if (reasons.includes("support-only: no actionable edit target")) {
    return { divergence: "NO_PIVOT_GATE", detail: "gold symbol earned support authority and the no-pivot gate withheld it", secondary };
  }
  return { divergence: "ROLE_AUTHORITY", detail: `gold symbol admitted at ordinary rank ${trace.postCap.goldSymbolOrdinaryRank}; role reasons: ${reasons.join("; ")}`, secondary };
}

interface FixtureRow {
  readonly instance_id: string;
  readonly repo: string;
  readonly task: string;
  readonly intent: string;
  readonly budget: number;
  readonly expected_files: string[];
  readonly expected_symbols: string[];
}

export function traceCase(kase: TraceCase, group: string, goldFate: string, reach: ReachEvidence | undefined): CaseTrace {
  const workspace = path.resolve(kase.workspace);
  const db = openIndexerDatabase(path.join(workspace, ".vtrace", "index.sqlite"));
  try {
    const capsule = buildCapsuleV2({
      db,
      repoRoot: workspace,
      task: kase.task,
      intent: kase.intent as CapsuleIntent,
      maxTokens: kase.budget,
    });
    const representation = probeRepresentation(db, kase);
    const preCap = observePreCap(db, kase, capsule);

    const scores = capsule.diagnostics.candidate_scores ?? [];
    const goldFileEntry = scores.find((e) => kase.expectedFiles.some((f) => fileMatches(f, e.path)));
    const goldSymbolEntry = scores.find((e) =>
      kase.expectedFiles.some((f) => fileMatches(f, e.path))
      && kase.expectedSymbols.some((s) => symbolMatches(s, { symbol: e.symbol, fqName: e.fq_name })));

    const inGold = (p: string, sym: string, fq: string) =>
      kase.expectedFiles.some((f) => fileMatches(f, p))
      && kase.expectedSymbols.some((s) => symbolMatches(s, { symbol: sym, fqName: fq }));
    const delivered = [...capsule.pivots, ...capsule.support];

    const shapedForQuery = ((): ShapedSweQuery => {
      const paths = createLazyRepositoryPathPredicate(db, { queries: 0 });
      return shapeSweQuery(
        { problemStatement: kase.task, failToPass: extractFailingTests(kase.task) },
        { projectNameAliases: resolveProjectNameAliases(workspace), isRepositoryPath: paths.isRepositoryPath },
      );
    })();

    const partial = {
      instanceId: kase.instanceId,
      repo: kase.repo,
      group,
      goldFate,
      expectedFiles: [...kase.expectedFiles],
      expectedSymbols: [...kase.expectedSymbols],
      representation,
      query: {
        shapedQuery: shapedForQuery.query,
        identifiers: [...shapedForQuery.identifiers],
        pathClues: (shapedForQuery.pathClues ?? []).map((clue) => ({ raw: clue.raw, normalized: clue.normalized, kind: String(clue.kind) })),
        likelySymbols: [...(shapedForQuery.likelySymbols ?? [])],
        asksByIdentifier: shapedForQuery.identifiers.length > 0,
        asksByPath: (shapedForQuery.pathClues ?? []).length > 0,
        asksByError: /Error|Exception|Traceback/.test(kase.task),
        asksByTest: extractFailingTests(kase.task).length > 0,
      },
      preCap,
      postCap: {
        candidateCount: capsule.diagnostics.candidate_count,
        goldFileOrdinaryRank: goldFileEntry?.rank ?? null,
        goldSymbolOrdinaryRank: goldSymbolEntry?.rank ?? null,
      },
      delivery: {
        mode: capsule.actual_mode,
        deliveredPivots: capsule.pivots.length,
        deliveredSupport: capsule.support.length,
        goldFileDelivered: delivered.some((i) => kase.expectedFiles.some((f) => fileMatches(f, i.path))),
        goldSymbolDelivered: delivered.some((i) => inGold(i.path, i.symbol, i.fq_name)),
        goldDiscardReasons: [...new Set(
          capsule.discarded
            .filter((i) => kase.expectedFiles.some((f) => fileMatches(f, i.path)))
            .map((i) => i.discard_reason)
            .filter((r) => r !== ""),
        )].sort(),
      },
    };

    const verdict = classifyFirstDivergence(partial, reach);
    return {
      ...partial,
      firstDivergence: verdict.divergence,
      firstDivergenceDetail: verdict.detail,
      secondaryContributors: verdict.secondary,
      confidence: preCap.replicationValid ? "high" : "low",
    };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const get = (flag: string, fallback?: string): string => {
    const index = argv.indexOf(flag);
    const value = index < 0 ? undefined : argv[index + 1];
    if (value === undefined) {
      if (fallback !== undefined) return fallback;
      throw new Error(`${flag} is required.`);
    }
    return value;
  };

  const fixturePath = get("--fixture");
  const corpusRoot = get("--corpus-root");
  const manifestPath = get("--manifest");
  const outPath = get("--out");
  const taxonomyPath = get("--taxonomy-out");
  const reachPath = get("--reach");

  const fixture = (await Bun.file(fixturePath).json()) as readonly FixtureRow[];
  const manifest = (await Bun.file(manifestPath).json()) as {
    entries: readonly { instanceId: string; group: string; goldFate: string }[];
  };
  const byId = new Map(fixture.map((row) => [row.instance_id, row]));
  const reachArtifact = (await Bun.file(reachPath).json()) as { records: readonly (ReachEvidence & { instanceId: string })[] };
  const reachById = new Map(reachArtifact.records.map((r) => [r.instanceId, r]));

  const traces: CaseTrace[] = [];
  const failures: { instanceId: string; error: string }[] = [];
  for (const entry of manifest.entries) {
    const row = byId.get(entry.instanceId);
    if (row === undefined) {
      failures.push({ instanceId: entry.instanceId, error: "not in fixture" });
      continue;
    }
    try {
      traces.push(traceCase({
        instanceId: row.instance_id,
        repo: row.repo,
        workspace: path.join(corpusRoot, row.instance_id),
        task: row.task,
        intent: row.intent,
        budget: row.budget,
        expectedFiles: row.expected_files,
        expectedSymbols: row.expected_symbols,
      }, entry.group, entry.goldFate, reachById.get(entry.instanceId)));
    } catch (error) {
      failures.push({ instanceId: entry.instanceId, error: String(error) });
    }
  }

  await writeFile(outPath, `${JSON.stringify({
    schemaVersion: "stage5.m159.case-traces.v1",
    corpusRoot,
    fixture: fixturePath,
    manifest: manifestPath,
    cases: traces.length,
    failures,
    unvalidatedReplications: traces.filter((t) => !t.preCap.replicationValid).map((t) => t.instanceId),
    traces,
  }, null, 2)}\n`, "utf8");

  const classes = [...new Set(traces.map((t) => t.firstDivergence))].sort();
  const taxonomy = classes.map((cls) => {
    const hits = traces.filter((t) => t.firstDivergence === cls);
    return {
      firstDivergence: cls,
      cases: hits.length,
      repos: [...new Set(hits.map((t) => t.repo))].sort(),
      repoCount: new Set(hits.map((t) => t.repo)).size,
      instances: hits.map((t) => t.instanceId).sort(),
      byGroup: {
        DEEP_RANKED_OR_PREDELIVERY_LOSS: hits.filter((t) => t.group === "DEEP_RANKED_OR_PREDELIVERY_LOSS").length,
        NEVER_RETRIEVED_CAUSE_UNKNOWN: hits.filter((t) => t.group === "NEVER_RETRIEVED_CAUSE_UNKNOWN").length,
      },
    };
  }).sort((a, b) => b.cases - a.cases);

  await writeFile(taxonomyPath, `${JSON.stringify({
    schemaVersion: "stage5.m159.first-divergence-taxonomy.v1",
    corpusRoot,
    residualCases: traces.length,
    localized: traces.filter((t) => t.firstDivergence !== "UNCLASSIFIED").length,
    unexplained: traces.filter((t) => t.firstDivergence === "UNCLASSIFIED").length,
    taxonomy,
  }, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ cases: traces.length, failures, taxonomy }, null, 2));
}

if (import.meta.main) {
  await main();
}
