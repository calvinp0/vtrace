// Capsule v2 orchestrator.
//
// The full product pipeline, in one deterministic, network-free pass:
//
//   task signals -> intent detection -> candidate generators -> evidence
//   scorecards -> pivot/support/discard roles -> budget allocator -> renderer
//
// Every stage is an existing, tested engine; this module is the orchestration
// that composes them into a bounded context capsule with explicit evidence,
// role assignment, and token-budget accounting. It hardcodes no benchmark
// instance ids and no file paths — the capsule is recovered from the index alone.

import type { Database } from "bun:sqlite";
import { getSymbolById } from "../db/repositories/symbolsRepository";

import {
  assignCandidateRoles,
  CandidateRole,
} from "../capsule/assignCandidateRoles";
import {
  extractFullSymbolSource,
  ExtractSymbolSourceStatus,
} from "../capsule/extractSymbolContent";
import { loadSymbolSource } from "../capsule/loadSymbolSource";
import { shapeSweQuery, type ShapedSweQuery } from "../capsule/sweQueryShaping";
import {
  createHybridRetrievalRequestCache,
  createHybridRetrievalProfile,
  hybridRetrieve,
  HybridCandidateSource,
  type BodyLiteralMatch,
  type HybridCandidate,
} from "../retrieval/hybridRetrieval";
import {
  classifyLexicalQueryTokens,
  recomputeWithWeakenedLexical,
  STRONG_DIRECT_LEXICAL,
} from "../retrieval/hybridScoring";
import { allocateBudget } from "./budgetAllocator";
import {
  buildNoContextExplanations,
  collectIssueTokens,
  passthroughRoles,
  refineDebugRoles,
  type ClassMethodExpansion,
  type RefinedRoledCandidate,
} from "./debugRoles";
import type { HybridScoreComponents } from "../retrieval/hybridScoring";
import { buildMechanismSlice } from "./mechanismSlice";
import {
  discoverMechanismSupport,
  inactiveMechanismSupport,
  MECHANISM_SUPPORT_LIMITS,
  type MechanismSupportResult,
} from "../retrieval/mechanismSupport";
import { hasBehavioralOperation } from "../retrieval/behavioralObjective";
import { selectPathCompletion, type PathCompletionResult } from "./pathCompletion";
import { detectActionabilityHints } from "./actionabilityHints";
import {
  detectMultiFileCoeditHints,
  type CoeditCandidateItem,
} from "./multiFileCoeditHints";
import { detectLocalizationSignals, type LocalizationSignals } from "./localizationSignals";
import { createLazyRepositoryPathPredicate } from "../retrieval/repositoryPathMembership";
import { retrieveDocSections, type DocSection } from "./docRetrieval";
import { detectEditRiskDirectives } from "./editRiskDirectives";
import {
  buildLineAnchorCandidate,
  parseLineAnchors,
  resolveLineAnchors,
  type LineAnchorResolution,
} from "./lineAnchorResolution";
import {
  backfillProductionCandidates,
  computeClassMethodExpansion,
  isTestDominatedPool,
} from "./productionBackfill";
import {
  backfillSqlRenderingCandidates,
  sqlRenderingRelevance,
  wantsSqlRenderingBackfill,
} from "./sqlRenderingBackfill";
import { planIntent, type IntentPlan } from "./intent";
import {
  nonSourcePivotDemotion,
  taskMentionsNonSource,
  type NonSourceDownrank,
} from "./nonSourceExample";
import { anchorTitleSymbols, type TitleSymbolResult } from "./titleSymbolAnchoring";
import { anchorLiterals, type LiteralAnchorResult } from "./literalAnchoring";
import { resolveProjectNameAliases } from "./projectNameSignals";
import {
  anchorDirectEvidence,
  boostScoresForDirectEvidence,
  type DirectEvidenceResult,
  type WeakDirectEvidenceOrdering,
} from "./directEvidenceAnchoring";
import { anchorGraphNeighbors, type GraphNeighborResult } from "./graphNeighborAnchoring";
import {
  COEDIT_BUDGET_FRACTION,
  expandCoeditSupport,
  orderSupportWithCoedit,
} from "./coeditExpansion";
import {
  FILE_EVIDENCE_BUDGET_FRACTION,
  rescueFileEvidenceSupport,
} from "./fileEvidenceRescue";
import {
  classifyGenericLexicalDecoy,
  collectQueryTokens,
  taskNamesCandidatePath,
  GENERIC_LEXICAL_DECOY_FACTOR,
  type GenericLexicalDecoy,
} from "./genericLexicalDecoy";
import { itemBlockText } from "./renderItem";
import {
  DEFAULT_PIVOT_RANKING_VERSION,
  scorePivot,
  type PivotRankingVersion,
  type PivotRankResult,
} from "./pivotRankingV2";
import { estimateTokens, roundPercent } from "./tokens";
import {
  createPathRelevanceContext,
  matchPathCluesWithContext,
  pathObjectiveAffinityWithContext,
} from "../retrieval/pathScopedRelevance";
import {
  deriveQueryIntent,
  evaluateCandidateContrast,
  evaluateDirectAnswer,
  exactSymbolEligibleTerms,
} from "../retrieval/querySemantics";
import {
  retrieveIndexedDocuments,
  type DocumentCandidate,
  type DocumentIntegrationProfile,
} from "../documents/documentRetrieval";
import {
  CapsuleIntent,
  CapsuleV2ContentMode,
  CapsuleV2Mode,
  NO_DEBUG_ROLE_SIGNALS,
  toScorecard,
  type CapsuleV2Discarded,
  type CapsuleV2Item,
  type CapsuleV2Result,
  type NoContextExplanation,
  type ResolvedCapsuleIntent,
} from "./types";

export interface BuildCapsuleV2Input {
  db: Database;
  repoRoot: string;
  /** The task / problem statement, as free prose. */
  task: string;
  /** Requested intent; `Auto` resolves from the task signals. */
  intent: CapsuleIntent;
  /** Token budget for the assembled capsule. */
  maxTokens: number;
  /** Offline profiler seam; omitted from deterministic product diagnostics by default. */
  includeTimingDiagnostics?: boolean;
  /**
   * Pivot ordering version (dev/benchmark lever, not user UX). `v2` (default)
   * applies the conservative multi-evidence / specificity / broad-snippet
   * re-ranking in ambiguous multi-pivot cases; `legacy` keeps the prior `final`
   * ordering. See `pivotRankingV2.ts`. Never uses outcome as an input.
   */
  pivotRankingVersion?: PivotRankingVersion;
}

// The candidate pool retrieval ranks before role assignment. Generous so the
// failing-test/graph routes can pull in a target lexical search alone missed;
// the budget allocator and role gate trim it back down.
const CANDIDATE_POOL_SIZE = 25;
// Cap on how many evidence lines a pivot carries — enough to justify the edit
// target without flooding the capsule.
const MAX_PIVOT_EVIDENCE = 6;
const roundScore = (value: number): number => Math.round(value * 1e4) / 1e4;

export function buildCapsuleV2(input: BuildCapsuleV2Input): CapsuleV2Result {
  const capsuleProfile = input.includeTimingDiagnostics === true
    ? { timingsMs: {} as Record<string, number>, counters: {} as Record<string, number> }
    : undefined;
  const documentProfile: DocumentIntegrationProfile | undefined =
    input.includeTimingDiagnostics === true
      ? { timingsMs: {}, counters: {} }
      : undefined;
  const taskDerivationStarted = performance.now();
  // M144: whether a path the task names belongs to THIS repository. Lazy, so a
  // task with no traceback path never pays for the lookup, and memoized, so a
  // deep traceback costs one table scan rather than one per frame.
  const failureEvidenceCounters = { queries: 0 };
  const repositoryPaths = createLazyRepositoryPathPredicate(input.db, failureEvidenceCounters);
  const shaped = shapeSweQuery({
    problemStatement: input.task,
    failToPass: extractFailingTests(input.task),
  }, {
    projectNameAliases: resolveProjectNameAliases(input.repoRoot),
    isRepositoryPath: repositoryPaths.isRepositoryPath,
    ...(documentProfile === undefined ? {} : { performanceProfile: documentProfile }),
  });
  // Intent planner: detect intent + select the strategy (generators, role policy,
  // budget). The strategy's `role_policy` is the real lever — `debug_refinement`
  // runs the caller/helper/infra refinement + production backfill; the others use
  // the base role gate. test-failure shares the debug strategy.
  // How strongly the issue text alone already localizes the edit site (resolved
  // against this repo's index). Independent of retrieval scoring; consumed by the
  // cost-aware context policy to skip injection for already-localized tasks. Always
  // computed so the diagnostic is present on both the inject and no_context paths.
  const localizationSignals = detectLocalizationSignals(input.db, input.task, {
    indexedPaths: repositoryPaths.indexedPaths(),
  });
  const plan = planIntent(input.intent, input.task, shaped);
  const objectiveDecompositionStarted = documentProfile === undefined ? 0 : performance.now();
  const pathContext = createPathRelevanceContext(
    shaped.derivedIntent?.positiveSearchText ?? input.task,
    shaped.pathClues ?? [],
    documentProfile,
  );
  recordDocumentTiming(documentProfile, "objective_decomposition", objectiveDecompositionStarted);
  const documentRetrieval = retrieveIndexedDocuments(
    input.db,
    input.task,
    shaped.pathClues ?? [],
    undefined,
    { pathContext, ...(documentProfile === undefined ? {} : { profile: documentProfile }) },
  );
  const intent = plan.intent;
  const weights = plan.weights;
  const debugRefinement = plan.strategy.role_policy === "debug_refinement";
  // A plain numeric record for the diagnostics surface (HybridScoreWeights has
  // fixed keys, so it is not directly a Record<string, number>).
  const weightsRecord: Record<string, number> = Object.fromEntries(Object.entries(weights));
  const allocation = allocateBudget(input.maxTokens);
  const taskDerivationMs = performance.now() - taskDerivationStarted;

  const symbolSeeds = deriveSymbolSeeds(shaped);
  const hybridRequestCache = createHybridRetrievalRequestCache();
  const hybridProfile = input.includeTimingDiagnostics === true
    ? createHybridRetrievalProfile()
    : undefined;
  const hybridRetrievalStarted = performance.now();
  let retrieval = hybridRetrieve(input.db, {
    query: shaped.query,
    shaped,
    // Raw task prose for body-literal extraction: the shaped query may drop a
    // diagnostic literal that the body-literal search needs.
    taskText: input.task,
    weights,
    symbolSeeds,
    maxResults: CANDIDATE_POOL_SIZE,
    ...(hybridProfile === undefined ? {} : { profile: hybridProfile }),
    requestCache: hybridRequestCache,
  });
  let compoundTaskRescueUsed = false;
  const normalPoolHasDirectEvidence = retrieval.candidates.some((candidate) =>
    candidate.scores.symbol > 0
    || candidate.scores.path > 0
    || candidate.scores.testToImpl > 0
    || candidate.scores.bodyLiteral > 0
    || candidate.scores.lexical >= STRONG_DIRECT_LEXICAL
  );
  if (retrieval.candidates.length === 0 || !normalPoolHasDirectEvidence) {
    const rescued = hybridRetrieve(input.db, {
      query: input.task,
      shaped,
      taskText: input.task,
      weights,
      symbolSeeds,
      maxResults: CANDIDATE_POOL_SIZE,
      enableCompoundTaskRescue: true,
      ...(hybridProfile === undefined ? {} : { profile: hybridProfile }),
      requestCache: hybridRequestCache,
    });
    if (rescued.candidates.length > 0) {
      retrieval = rescued;
      compoundTaskRescueUsed = true;
    }
  }
  const hybridRetrievalMs = performance.now() - hybridRetrievalStarted;
  let candidates = retrieval.candidates;
  if (shaped.pathClues !== undefined) {
    const pathScoringStarted = documentProfile === undefined ? 0 : performance.now();
    candidates = candidates.map((candidate) => {
      const matches = matchPathCluesWithContext(candidate.filePath, pathContext);
      if (matches.length === 0) return candidate;
      const pathScore = Math.max(candidate.scores.path, matches[0]!.score);
      const pathDelta = (pathScore - candidate.scores.path) * weights.path;
      const objectiveAffinity = pathObjectiveAffinityWithContext(candidate.filePath, pathContext);
      return {
        ...candidate,
        sources: [...new Set([...candidate.sources, HybridCandidateSource.Path])],
        evidence: [
          ...candidate.evidence,
          ...matches.slice(0, 2).map((match) =>
            `embedded path clue \`${match.normalizedClue}\` ${match.matchType} (+${match.score.toFixed(2)} path)`),
        ],
        scores: {
          ...candidate.scores,
          path: pathScore,
          localEvidence: candidate.scores.localEvidence + pathDelta + objectiveAffinity,
          final: candidate.scores.final + pathDelta + objectiveAffinity,
        },
      };
    }).sort((left, right) =>
      right.scores.final - left.scores.final
      || left.fqName.localeCompare(right.fqName)
      || left.symbolId.localeCompare(right.symbolId));
    recordDocumentTiming(documentProfile, "path_candidate_retrieval_scoring", pathScoringStarted);
    incrementDocumentCounter(documentProfile, "candidate_sorts", 1);
    incrementDocumentCounter(documentProfile, "candidate_array_copies", 1);
  }
  const bodyLiteralMatches = retrieval.bodyLiteralMatches;

  // File-line anchor resolution. When the task prose cites a source anchor
  // (`compiler.py#L428-L433`), resolve it against the index and map the line
  // range to the enclosing symbol — the issue named the edit site outright, a
  // signal lexical ranking cannot use. Resolved anchors are merged ahead of the
  // pool below and promoted to pivots in debug role refinement. Resolution is
  // intent-independent (the diagnostics surface it regardless); the forced-pivot
  // role only applies under debug refinement.
  const lineAnchorResolutions = resolveLineAnchors(
    input.db,
    parseLineAnchors(input.task),
    shaped,
  );
  const anchorSymbolIds = new Set(lineAnchorResolutions.map((resolution) => resolution.symbolId));

  // Production-candidate backfill (debug intent). A pool of only test symbols
  // means lexical search ranked the failing tests above the implementation they
  // exercise, so the real edit target never entered the pool. Recover it with
  // production-focused seeds (Class.method expansion + issue class/method names),
  // excluding tests, and merge those candidates ahead of the original pool.
  let productionBackfillUsed = false;
  let classMethodExpansionUsed = false;
  // Class.method expansion targets (containing class + recovered methods), used to
  // promote the actionable method edit-sites over the broad class in role refinement.
  let classMethodExpansion: ClassMethodExpansion | undefined;
  if (debugRefinement) {
    if (isTestDominatedPool(candidates)) {
      const backfill = backfillProductionCandidates({
        db: input.db,
        shaped,
        weights,
        task: input.task,
        issueTokens: collectIssueTokens(shaped),
        poolSize: CANDIDATE_POOL_SIZE,
      });
      classMethodExpansionUsed = backfill.classMethodExpansionUsed;
      classMethodExpansion = backfill.expansion;
      if (backfill.candidates.length > 0) {
        productionBackfillUsed = true;
        candidates = mergeCandidatesPreferring(backfill.candidates, candidates, CANDIDATE_POOL_SIZE);
      }
    } else {
      // No backfill needed, but the class + methods may already be in the pool;
      // compute the expansion so the method edit-sites still outrank the class.
      const cme = computeClassMethodExpansion(input.db, input.task, collectIssueTokens(shaped));
      classMethodExpansion = cme.expansion;
      classMethodExpansionUsed = cme.used;
    }
  }

  // SQL-rendering production backfill (debug intent). When the issue describes
  // query composition (combined/composed/union/...) together with SQL
  // rendering/output behaviour (sql/render/columns/...), the lexical pool is
  // dominated by the public query-builder API while the compiler method that
  // actually renders the combined SQL never entered it. Recover the rendering
  // implementation from general structural signals (a `*/compiler.py` path, a
  // `get_*_sql`/`as_sql` method) and merge it ahead of the pool. No hardcoded ids.
  let sqlRenderingBackfillUsed = false;
  const sqlRenderingTrigger = debugRefinement
    ? wantsSqlRenderingBackfill(input.task)
    : { active: false, compositionTerms: new Set<string>() };
  if (sqlRenderingTrigger.active) {
    const sqlCandidates = backfillSqlRenderingCandidates({
      db: input.db,
      shaped,
      weights,
      poolSize: CANDIDATE_POOL_SIZE,
    });
    if (sqlCandidates.length > 0) {
      sqlRenderingBackfillUsed = true;
      candidates = mergeCandidatesPreferring(sqlCandidates, candidates, CANDIDATE_POOL_SIZE);
    }
  }

  // Title-symbol candidate anchoring. The problem TITLE often names the important
  // class/type/symbol (e.g. `PythonCodePrinter`) while a body word or a generic
  // decoy dominates lexical ranking, so the real edit site never enters the pool.
  // Seed the indexed symbols bearing those title names into the pool with direct
  // "title mentions `X`" evidence. Merged ahead of the lexical pool (and the
  // test-to-impl backfill) but BEHIND the line-anchor merge below — a title name is
  // strong, but an explicit source anchor or a body-literal diagnostic keeps
  // priority. Non-source title matches are still demoted by the role pass later.
  const titleSymbols: TitleSymbolResult = anchorTitleSymbols({ db: input.db, task: input.task });
  // Inject ONLY the title symbols retrieval never reached — a synthesized
  // title-symbol candidate is thin (no test-to-impl/graph evidence), so it must
  // never replace a richer existing candidate for the same symbol. Symbols already
  // present keep their candidate and merely gain title precedence below.
  //
  if (titleSymbols.candidates.length > 0) {
    const poolIds = new Set(candidates.map((c) => c.symbolId));
    const fresh = titleSymbols.candidates.filter((c) => !poolIds.has(c.symbolId));
    if (fresh.length > 0) {
      candidates = mergeCandidatesPreferring(fresh, candidates, CANDIDATE_POOL_SIZE);
    }
  }
  const titleSymbolIds = new Set(titleSymbols.matches.map((m) => m.symbolId));
  const titleSymbolDiagnostics: Partial<CapsuleV2Result["diagnostics"]> = titleSymbols.used
    ? {
        title_symbol_search_used: true,
        title_symbol_terms: titleSymbols.terms,
        title_symbol_matches: titleSymbols.matches.map((m) => ({ term: m.term, path: m.path, symbol: m.symbol })),
      }
    : {};

  // High-signal literal / option / acronym anchoring. Complements title-symbol
  // anchoring for the misses whose strongest term is NOT a normal symbol shape — an
  // ALL-CAPS format/acronym (`FITS`, `CDS`), a dunder (`__array_function__`), a CLI/
  // config option (`--ignore-paths`), or a backticked config name. Resolves each to
  // indexed symbols by name / path segment / body literal / config constant, and
  // seeds them into the pool at the SAME strength tier as title-symbol matches. Like
  // title-symbol, only symbols not already present are injected (a synthesized anchor
  // candidate is thin and must not replace a richer existing one).
  const literalAnchors: LiteralAnchorResult = anchorLiterals({
    db: input.db,
    task: input.task,
    // The repository's own name is context, not a symbol pointer, unless the task
    // explicitly targets it. See projectNameSignals.
    projectNameAliases: resolveProjectNameAliases(input.repoRoot),
  });
  if (literalAnchors.candidates.length > 0) {
    const poolIds = new Set(candidates.map((c) => c.symbolId));
    const fresh = literalAnchors.candidates.filter((c) => !poolIds.has(c.symbolId));
    if (fresh.length > 0) {
      candidates = mergeCandidatesPreferring(fresh, candidates, CANDIDATE_POOL_SIZE);
    }
  }
  const literalAnchorIds = new Set(literalAnchors.matches.map((m) => m.symbolId));
  const literalAnchorDiagnostics: Partial<CapsuleV2Result["diagnostics"]> = literalAnchors.used
    ? {
        literal_anchor_search_used: true,
        literal_anchor_terms: literalAnchors.terms,
        literal_anchor_matches: literalAnchors.matches.map((m) => ({ term: m.term, path: m.path, symbol: m.symbol })),
      }
    : {};

  // Direct-evidence candidate anchoring (M96). The issue often names the edit
  // site in a shape none of the other lanes resolves — a dotted module path
  // (`utils.numberformat.format`), an explicit file token, a bare file stem
  // (`autoreload`), a mid-sentence class word (`Count`), or a mixed-case
  // identifier (`kernS`). Each mention is resolved against the INDEX with tight
  // ambiguity caps; a resolved symbol already in the pool receives a bounded
  // boost (evidence line + final floored at its tier), and a missing one is
  // injected. Strong (file-resolved) matches are anchor-grade like title
  // symbols; weak (stem/word) matches stay competitive-only and never join the
  // anchor precedence tiers.
  const directEvidence: DirectEvidenceResult = anchorDirectEvidence({
    db: input.db,
    task: input.task,
    // The same request grammar the lexical lane uses, so the two producers agree
    // on which task terms may claim to BE a symbol's name (M142 §16).
    exactNameEligibleTerms: exactSymbolEligibleTerms(
      shaped.derivedIntent ?? deriveQueryIntent(input.task),
    ),
  });
  const directEvidenceBoosted: Array<{ path: string; symbol: string; tier: string }> = [];
  // WEAK-tier ordering metadata: the boosted/injected final buys budget (a
  // support slot, a free pivot slot) but never the LEAD — pivot ordering ranks
  // weak-lane candidates behind every organically-evidenced pivot, tie-broken
  // among themselves by the ORGANIC final they had before the lane touched them
  // (0 for fresh injections). Weak evidence fills gaps and breaks ties; it
  // never reorders organic evidence.
  const weakDirectIds = new Set<string>();
  const weakOrganicFinalById = new Map<string, number>();
  if (directEvidence.used) {
    const poolById = new Map(candidates.map((c) => [c.symbolId, c] as const));
    const fresh: HybridCandidate[] = [];
    for (const match of directEvidence.matches) {
      const existing = poolById.get(match.symbolId);
      if (existing !== undefined) {
        if (match.tier === "weak" && !weakDirectIds.has(match.symbolId)) {
          weakDirectIds.add(match.symbolId);
          weakOrganicFinalById.set(match.symbolId, existing.scores.final);
        }
        existing.scores = boostScoresForDirectEvidence(existing.scores, match);
        const line = `task names ${match.reason} (direct evidence, ${match.tier})`;
        if (!existing.evidence.includes(line)) {
          existing.evidence = [...existing.evidence, line].sort();
        }
        directEvidenceBoosted.push({ path: match.path, symbol: match.symbol, tier: match.tier });
      }
    }
    const tierById = new Map(directEvidence.matches.map((m) => [m.symbolId, m.tier] as const));
    const freshIds = new Set<string>();
    for (const candidate of directEvidence.candidates) {
      if (poolById.has(candidate.symbolId) || freshIds.has(candidate.symbolId)) continue;
      freshIds.add(candidate.symbolId);
      if (tierById.get(candidate.symbolId) === "weak") {
        weakDirectIds.add(candidate.symbolId);
        weakOrganicFinalById.set(candidate.symbolId, 0);
      }
      fresh.push(candidate);
    }
    if (fresh.length > 0) {
      candidates = mergeCandidatesPreferring(fresh, candidates, CANDIDATE_POOL_SIZE);
    }
  }
  const weakDirectOrdering: WeakDirectEvidenceOrdering = {
    symbolIds: weakDirectIds,
    organicFinalById: weakOrganicFinalById,
  };
  const directEvidenceStrongIds = directEvidence.strongSymbolIds;
  const directEvidenceDiagnostics: Partial<CapsuleV2Result["diagnostics"]> =
    directEvidence.mentions.length > 0 || directEvidence.rejectedGenericCount > 0
      ? {
          direct_evidence_search_used: directEvidence.used,
          direct_evidence_mentions: directEvidence.mentions.map((m) => `${m.type}:${m.term}`),
          direct_evidence_matches: directEvidence.matches.map((m) => ({
            term: m.term,
            type: m.type,
            tier: m.tier,
            path: m.path,
            symbol: m.symbol,
          })),
          direct_evidence_rejected_ambiguous_count: directEvidence.rejectedAmbiguousCount,
          direct_evidence_rejected_generic_count: directEvidence.rejectedGenericCount,
          ...(directEvidenceBoosted.length > 0
            ? { direct_evidence_boosted: directEvidenceBoosted }
            : {}),
        }
      : {};

  // Merge the anchor-resolved targets AHEAD of everything else: an explicit source
  // anchor is the strongest edit-site signal, so it must never be crowded out of
  // the pool by the lexical ranking it was meant to correct.
  if (lineAnchorResolutions.length > 0) {
    candidates = mergeCandidatesPreferring(
      lineAnchorResolutions.map((resolution) => buildLineAnchorCandidate(resolution)),
      candidates,
      CANDIDATE_POOL_SIZE,
    );
  }

  // Synthetic anchor/backfill candidates bypass hybrid assembly. Apply the same
  // already-derived semantics to those candidates before role selection. Organic
  // candidates already carry these fields and are left untouched, preventing a
  // double penalty.
  candidates = candidates.map((candidate) => {
    if (candidate.scores.contrastPenalty !== undefined && candidate.scores.directAnswerScore !== undefined) return candidate;
    const symbol = getSymbolById(input.db, candidate.symbolId);
    if (symbol === undefined || shaped.derivedIntent === undefined) return candidate;
    const contrast = evaluateCandidateContrast(shaped.derivedIntent, symbol);
    const directAnswer = evaluateDirectAnswer(shaped.derivedIntent, symbol);
    const positiveObjectiveScore = roundScore(contrast.positiveObjectiveScore);
    const contrastPenalty = roundScore(contrast.contrastPenalty);
    const directAnswerScore = roundScore(directAnswer.score);
    if (positiveObjectiveScore === 0 && contrastPenalty === 0 && directAnswerScore === 0) {
      return { ...candidate, scores: { ...candidate.scores, positiveObjectiveScore: 0, contrastPenalty: 0, directAnswerScore: 0 } };
    }
    return {
      ...candidate,
      evidence: [...candidate.evidence,
        ...(positiveObjectiveScore > 0 ? [`preferred contrast side matched: ${contrast.matchedPositiveTerms.join(", ")} (+${positiveObjectiveScore.toFixed(2)})`] : []),
        ...(contrastPenalty > 0 ? [`downranked: ${contrast.reason} (-${contrastPenalty.toFixed(2)})`] : []),
        ...(directAnswerScore > 0 ? [`${directAnswer.reason} (+${directAnswerScore.toFixed(2)} direct answer)`] : []),
      ].sort(),
      scores: {
        ...candidate.scores,
        positiveObjectiveScore,
        contrastPenalty,
        directAnswerScore,
        final: roundScore(Math.max(0, candidate.scores.final + positiveObjectiveScore + directAnswerScore - contrastPenalty)),
      },
    };
  }).sort((left, right) =>
    right.scores.final - left.scores.final
    || left.fqName.localeCompare(right.fqName)
    || left.symbolId.localeCompare(right.symbolId));

  // Generic-infrastructure lexical-decoy suppression (general, repo-agnostic). A
  // generic bug-report word ("deprecation", "dict") over-anchors retrieval to an
  // infrastructure/helper module NAMED after that word (`deprecation.py`, a
  // `*Dict*` helper) even when the bug is elsewhere. When a candidate's whole
  // IDENTITY is a generic infra token, that token is in the query, and it carries
  // no stronger direct evidence (symbol/path/test/body-literal pointer, line
  // anchor, title-symbol match, strong graph reach) and the task does not name its
  // path, its blended lexical score is WEAKENED — so the generic word cannot carry
  // it to a pivot. Runs BEFORE role assignment, so the role gate re-decides on the
  // weakened score (a weakened decoy falls below the strong-direct-lexical bar and
  // demotes itself to support); the candidate is never removed. Title-symbol and
  // line-anchor candidates are doubly protected — they carry symbol/path evidence
  // AND are excluded by their id sets. Mirrors the exception-symptom de-anchoring.
  const decoyQueryTokens = collectQueryTokens(input.task);
  const genericLexicalDecoys: GenericLexicalDecoy[] = [];
  // A generic infra FILE (deprecation.py) holds many symbols, each a separate
  // suppressed candidate; the diagnostic surface reports one entry per (token, path)
  // so the miss-analysis line stays readable.
  const reportedDecoys = new Set<string>();
  // Symbol ids of every down-weighted decoy — graph-neighbour expansion must never
  // seed from a generic lexical decoy.
  const suppressedDecoyIds = new Set<string>();
  for (const candidate of candidates) {
    const decision = classifyGenericLexicalDecoy({
      filePath: candidate.filePath,
      localName: candidate.localName,
      queryTokens: decoyQueryTokens,
      scores: candidate.scores,
      hasLineAnchor: anchorSymbolIds.has(candidate.symbolId),
      hasTitleSymbol: titleSymbolIds.has(candidate.symbolId),
      taskNamesPath: taskNamesCandidatePath(input.task, candidate.filePath),
    });
    if (!decision.isDecoy) continue;
    suppressedDecoyIds.add(candidate.symbolId);
    candidate.scores = recomputeWithWeakenedLexical(
      candidate.scores,
      weights,
      candidate.scores.lexical * GENERIC_LEXICAL_DECOY_FACTOR,
    );
    candidate.evidence = [
      ...candidate.evidence,
      `lexical down-weighted: generic infrastructure decoy (token \`${decision.token}\`) with weak direct evidence`,
    ].sort();
    const key = `${decision.token ?? ""}|${candidate.filePath}`;
    if (!reportedDecoys.has(key)) {
      reportedDecoys.add(key);
      genericLexicalDecoys.push({
        token: decision.token ?? "",
        path: candidate.filePath,
        reason: decision.reason ?? "generic infrastructure lexical decoy",
      });
    }
  }
  const genericLexicalDecoyDiagnostics: Partial<CapsuleV2Result["diagnostics"]> =
    genericLexicalDecoys.length > 0
      ? { generic_lexical_decoys_suppressed: genericLexicalDecoys }
      : {};

  // Bounded test/import graph-neighbour expansion. The bug report may not name the
  // production edit target, but vtrace has already found something next to it (a
  // failing test, a config/warning helper, a parser adapter, a sibling module). This
  // walks ONE hop from the high-confidence seeds in the pool (line/title/literal
  // anchors, body-literal hits, test-routed, strong lexical — never decoys,
  // non-source, low-actionability, or undirect-evidence hubs) and seeds the
  // production neighbours that import/call/reference (or are referenced by) them.
  // Neighbours enter as SUPPORT-strength candidates (no direct evidence → the role
  // gate never makes them a pivot), so they can lift top-3 recall without displacing
  // a real edit target or out-ranking any explicit anchor. Runs AFTER decoy
  // suppression so it can exclude suppressed decoys as seeds.
  const graphNeighbors: GraphNeighborResult = anchorGraphNeighbors({
    db: input.db,
    task: input.task,
    candidates,
    anchorSymbolIds,
    titleSymbolIds,
    literalAnchorIds,
    suppressedDecoyIds,
  });
  // Recovered neighbours are kept OUT of the role pipeline entirely: adding them to
  // `candidates` would perturb debug role refinement (subsystem inference, the
  // helper/infra split) and could reorder REAL support. Instead they become support
  // entries rendered ONLY into leftover support budget, after every real support
  // item — purely additive recall that can never displace a file vtrace found.
  const graphNeighborPoolIds = new Set(candidates.map((c) => c.symbolId));
  const graphNeighborSupport: RefinedRoledCandidate[] = graphNeighbors.candidates
    .filter((c) => !graphNeighborPoolIds.has(c.symbolId))
    .map((candidate) => ({
      candidate,
      role: CandidateRole.Support,
      roleReason: candidate.evidence[0] ?? "production neighbour of high-confidence seed",
      signals: NO_DEBUG_ROLE_SIGNALS,
    }));
  const graphNeighborDiagnostics: Partial<CapsuleV2Result["diagnostics"]> = graphNeighbors.used
    ? {
        graph_neighbor_expansion_used: true,
        graph_neighbor_matches: graphNeighbors.matches.map((m) => ({
          seed_path: m.seedPath,
          seed_symbol: m.seedSymbol,
          edge: m.edge,
          neighbor_path: m.neighborPath,
          neighbor_symbol: m.neighborSymbol,
          reason: m.reason,
        })),
      }
    : {};

  // Role assignment. The base gate scores each candidate in isolation; for debug
  // intent we then refine roles with call-graph structure (caller vs helper,
  // local vs generic infrastructure) before capping pivots to the tier. Other
  // intents keep the base gate's own cap. Centrality never produces a pivot.
  // Tier-2 anchored targets (M101): the symbols the issue author NAMED outright
  // (title symbol / high-signal literal / STRONG direct evidence) — the same
  // precedence family the pivot ordering below already honours (evidenceTier 2).
  // Threading the ids into the role layer keeps the two stages coherent: a
  // target the orderer would rank first must not be cap-evicted or
  // dispatcher-demoted before ordering ever runs. Weak-direct and the
  // support-only lanes (co-edit / file-evidence / graph-neighbour) are
  // deliberately excluded, so a circumstantial mention can never ride this.
  const namedAnchorIds = new Set<string>([
    ...titleSymbolIds,
    ...literalAnchorIds,
    ...directEvidenceStrongIds,
  ]);
  let refined: RefinedRoledCandidate[];
  let subsystemRoot: string | undefined;
  let sourceBodyCallFallbackUsed = false;
  let anchoredDispatcherExemptions: Array<{ path: string; symbol: string }> = [];
  let anchoredCapExemption: { path: string; symbol: string; symbolId: string } | undefined;
  const roleAssignmentStarted = capsuleProfile === undefined ? 0 : performance.now();
  if (debugRefinement) {
    const result = refineDebugRoles(
      input.db,
      assignCandidateRoles(candidates),
      shaped,
      allocation.maxPivots,
      {
        sourceTextOf: (symbolId) => loadFocusedSourceById(input.db, input.repoRoot, symbolId),
        ...(classMethodExpansion === undefined ? {} : { expansion: classMethodExpansion }),
        ...(sqlRenderingTrigger.active
          ? { sqlRendering: { compositionTerms: sqlRenderingTrigger.compositionTerms } }
          : {}),
        ...(anchorSymbolIds.size > 0 ? { lineAnchor: { symbolIds: anchorSymbolIds } } : {}),
        ...(weakDirectIds.size > 0 ? { weakDirectEvidence: weakDirectOrdering } : {}),
        ...(namedAnchorIds.size > 0 ? { namedAnchors: { symbolIds: namedAnchorIds } } : {}),
      },
    );
    refined = result.refined;
    subsystemRoot = result.subsystemRoot;
    sourceBodyCallFallbackUsed = result.sourceBodyCallFallbackUsed;
    anchoredDispatcherExemptions = result.anchoredDispatcherExemptions;
    anchoredCapExemption = result.anchoredCapExemption;
  } else {
    refined = passthroughRoles(assignCandidateRoles(candidates, { maxPivots: allocation.maxPivots }));
  }
  recordCapsuleTiming(capsuleProfile, "capsule.role_assignment", roleAssignmentStarted);

  // A prose-embedded subtree is strong additive scope evidence, not a path-only
  // query. When at least two actionable candidates inside that subtree also
  // match distinctive objective words in their paths, preserve those exact
  // mixed objectives as the bounded pivots and demote outside-scope lexical
  // homonyms such as generic Workflow/Snapshot helpers.
  const coverageStarted = documentProfile === undefined ? 0 : performance.now();
  const scopedObjectives = shaped.pathClues === undefined
    ? []
    : refined
      .filter((entry) => {
        incrementDocumentCounter(documentProfile, "coverage_candidates_considered", 1);
        return entry.candidate.scores.actionability > 0
          && (entry.candidate.scores.path >= 0.75)
          && pathObjectiveAffinityWithContext(entry.candidate.filePath, pathContext) >= 0.3;
      })
      .sort((left, right) =>
        pathObjectiveAffinityWithContext(right.candidate.filePath, pathContext)
          - pathObjectiveAffinityWithContext(left.candidate.filePath, pathContext)
        || right.candidate.scores.final - left.candidate.scores.final
        || left.candidate.filePath.localeCompare(right.candidate.filePath)
        || left.candidate.fqName.localeCompare(right.candidate.fqName));
  if (scopedObjectives.length > 1) incrementDocumentCounter(documentProfile, "candidate_sorts", 1);
  const distinctScopedObjectives = scopedObjectives.filter((entry, index, all) =>
    all.findIndex((candidate) => candidate.candidate.filePath === entry.candidate.filePath) === index);
  if (distinctScopedObjectives.length >= 2 && shaped.pathClues !== undefined) {
    const selectedIds = new Set(distinctScopedObjectives.slice(0, allocation.maxPivots).map((entry) => entry.candidate.symbolId));
    for (const entry of refined) {
      if (selectedIds.has(entry.candidate.symbolId)) {
        entry.role = CandidateRole.Pivot;
        entry.roleReason = "direct subtree and task-objective evidence";
      } else if (entry.role === CandidateRole.Pivot) {
        entry.role = CandidateRole.Support;
        entry.roleReason = "generic lexical match outside the explicit task subtree";
      }
    }
  }
  recordDocumentTiming(documentProfile, "mixed_surface_coverage_selection", coverageStarted);

  // Non-source example / doc-data down-rank (general, repo-agnostic). A production
  // context provider prefers real source over docs/examples/sample/fixture files,
  // so a candidate under such a path is tagged and — unless the task explicitly
  // points at docs/examples, or an explicit line anchor named it — demoted out of
  // the pivot role into support. It is never silently dropped: the demotion is
  // recorded in `non_source_candidates_downranked`, and if the gold edit really
  // lives in docs/examples the task predicate keeps it eligible. This runs for
  // every intent (both the debug-refined and passthrough role paths).
  const taskAllowsNonSource = taskMentionsNonSource(input.task);
  const nonSourceDownranked: NonSourceDownrank[] = [];
  for (const entry of refined) {
    const { classification, demote } = nonSourcePivotDemotion(entry.candidate.filePath, {
      isPivot: entry.role === CandidateRole.Pivot,
      taskAllowsNonSource,
      isAnchored: anchorSymbolIds.has(entry.candidate.symbolId),
    });
    if (!classification.isNonSourceExample) continue;
    entry.nonSourceExample = classification;
    if (demote) {
      entry.role = CandidateRole.Support;
      entry.roleReason = `non-source example (${classification.reason}) — support, not an edit target`;
      nonSourceDownranked.push({ path: entry.candidate.filePath, reason: classification.reason ?? "non-source" });
    }
  }
  const nonSourceDiagnostics: Partial<CapsuleV2Result["diagnostics"]> =
    nonSourceDownranked.length > 0 ? { non_source_candidates_downranked: nonSourceDownranked } : {};

  // Debug-intent recovery diagnostics, surfaced on both the success and
  // no-context paths so the production-target recovery is always auditable.
  const debugDiagnostics: Partial<CapsuleV2Result["diagnostics"]> =
    debugRefinement
      ? {
          production_backfill_used: productionBackfillUsed,
          class_method_expansion_used: classMethodExpansionUsed,
          source_body_call_fallback_used: sourceBodyCallFallbackUsed,
          sql_rendering_backfill_used: sqlRenderingBackfillUsed,
          ...(subsystemRoot === undefined ? {} : { subsystem_root: subsystemRoot }),
        }
      : {};

  // M101 anchored-target pivot guard diagnostics: which exemptions fired.
  // Present only when the guard changed a role decision, so unaffected capsules
  // stay byte-identical.
  const pivotGuardDiagnostics: Partial<CapsuleV2Result["diagnostics"]> =
    anchoredDispatcherExemptions.length > 0 || anchoredCapExemption !== undefined
      ? {
          pivot_selection_version: "m101_anchored_target_guard",
          ...(anchoredDispatcherExemptions.length > 0
            ? { anchored_dispatcher_demotions_prevented: anchoredDispatcherExemptions }
            : {}),
          ...(anchoredCapExemption === undefined
            ? {}
            : {
                anchored_pivot_cap_exemptions: [
                  { path: anchoredCapExemption.path, symbol: anchoredCapExemption.symbol },
                ],
              }),
        }
      : {};

  // File-line anchor diagnostics, surfaced regardless of intent so the explicit
  // source-anchor route is always auditable: which anchor resolved to which
  // file/symbol, and how confident the mapping was.
  const lineAnchorDiagnostics: Partial<CapsuleV2Result["diagnostics"]> =
    lineAnchorResolutions.length > 0
      ? {
          line_anchor_resolution_used: true,
          line_anchor_candidates: lineAnchorResolutions.map((resolution) => ({
            anchor: resolution.anchor,
            resolved_path: resolution.resolvedPath,
            resolved_symbol: resolution.resolvedSymbol,
            confidence: resolution.confidence,
          })),
        }
      : {};

  const pivotCandidates = refined.filter((r) => r.role === CandidateRole.Pivot);
  const supportCandidates = refined.filter((r) => r.role === CandidateRole.Support);
  const roleDiscards = refined.filter((r) => r.role === CandidateRole.Discard);

  // Order the surviving pivots for rendering. A file-line anchor target leads of
  // all (the issue named it outright). Then, for a composed-query SQL-output bug,
  // the renderer most on-topic to the composition (`get_combinator_sql` for a
  // "combined" issue) ahead of a generic `as_sql`/`execute_sql`. Finally a
  // direct-evidence precedence tier: a body-literal diagnostic match (the bug
  // names the exact string this symbol emits) ranks ahead of a title-symbol match,
  // which in turn ranks ahead of ordinary lexical/graph candidates — exactly the
  // priority line-anchor/body-literal > title-symbol > normal.
  if (
    anchorSymbolIds.size > 0
    || sqlRenderingTrigger.active
    || titleSymbolIds.size > 0
    || literalAnchorIds.size > 0
    || directEvidenceStrongIds.size > 0
  ) {
    const anchorRank = (entry: RefinedRoledCandidate): number =>
      anchorSymbolIds.has(entry.candidate.symbolId) ? 1 : 0;
    const renderingRank = (entry: RefinedRoledCandidate): number =>
      sqlRenderingTrigger.active
        ? sqlRenderingRelevance(entry.candidate.localName, sqlRenderingTrigger.compositionTerms)
        : 0;
    // A weak direct-evidence candidate orders by its ORGANIC (pre-boost) final:
    // a boosted incumbent keeps the rank its own evidence earned; a fresh
    // injection (organic 0) sorts behind every organically-evidenced pivot.
    const orderingFinal = (entry: RefinedRoledCandidate): number =>
      weakDirectIds.has(entry.candidate.symbolId)
        ? weakOrganicFinalById.get(entry.candidate.symbolId) ?? 0
        : entry.candidate.scores.final;
    // Direct-evidence tier: body-literal (3) > title-symbol / high-signal literal
    // anchor / strong file-resolved direct evidence (2) > normal (1). The three
    // tier-2 lanes are comparable: each is an exact, author-written pointer at
    // the symbol/file. Weak direct-evidence (stem/class-word) matches stay in
    // tier 1 — a circumstantial mention must not out-rank multi-signal retrieval.
    const evidenceTier = (entry: RefinedRoledCandidate): number => {
      if (entry.candidate.scores.bodyLiteral > 0) return 3;
      if (
        titleSymbolIds.has(entry.candidate.symbolId)
        || literalAnchorIds.has(entry.candidate.symbolId)
        || directEvidenceStrongIds.has(entry.candidate.symbolId)
      ) return 2;
      return 1;
    };
    // A cap-exempted anchored pivot (M101) orders LAST regardless of its tier:
    // the exemption buys a required-target slot, never the lead.
    const capExemptRank = (entry: RefinedRoledCandidate): number =>
      anchoredCapExemption?.symbolId === entry.candidate.symbolId ? 1 : 0;
    pivotCandidates.sort(
      (left, right) =>
        capExemptRank(left) - capExemptRank(right)
        || anchorRank(right) - anchorRank(left)
        || renderingRank(right) - renderingRank(left)
        || evidenceTier(right) - evidenceTier(left)
        || orderingFinal(right) - orderingFinal(left)
        || left.candidate.fqName.localeCompare(right.candidate.fqName)
        || left.candidate.symbolId.localeCompare(right.candidate.symbolId),
    );
  }

  // Pivot-ranking v2 (conservative, additive, explainable). Score every surviving
  // pivot from PRE-OUTCOME signals only (scorecard, kind, path, snippet size); the
  // metadata is attached to the rendered pivots for the manifest/report. Re-order
  // ONLY in the ambiguous "multiple edit targets, no strong anchor" case — when a
  // line anchor / SQL-rendering / title-symbol / literal anchor fired, those strong
  // tiers already ordered the pivots above and v2 defers to them entirely. This is
  // exactly the noisy-retrieval scenario the Stage 5 Astropy diagnostic flagged.
  const pivotRankingVersion = input.pivotRankingVersion ?? DEFAULT_PIVOT_RANKING_VERSION;
  const pivotRankMeta = new Map<string, PivotRankResult>();
  const pivotRankingStarted = capsuleProfile === undefined ? 0 : performance.now();
  for (const entry of pivotCandidates) {
    const source = loadFocusedSource(input.db, input.repoRoot, entry.candidate);
    pivotRankMeta.set(
      entry.candidate.symbolId,
      scorePivot(
        {
          path: entry.candidate.filePath,
          kind: entry.candidate.kind,
          scorecard: toScorecard(entry.candidate.scores),
          evidenceSources: entry.candidate.sources,
          snippetTokens: source === undefined ? 0 : estimateTokens(source),
          ...(entry.nonSourceExample?.isNonSourceExample ? { isNonSourceExample: true } : {}),
        },
        pivotRankingVersion,
      ),
    );
  }
  recordCapsuleTiming(capsuleProfile, "capsule.pivot_source_loading_and_ranking", pivotRankingStarted);
  const noStrongAnchor =
    anchorSymbolIds.size === 0
    && !sqlRenderingTrigger.active
    && titleSymbolIds.size === 0
    && literalAnchorIds.size === 0
    && directEvidenceStrongIds.size === 0;
  if (pivotRankingVersion === "v2" && pivotCandidates.length >= 2 && noStrongAnchor) {
    // Weak direct-evidence pivots order by ORGANIC final here too — their
    // boosted scorecard would otherwise game the v2 rank (v2 scores are
    // final-scaled, so the organic final is directly comparable).
    const v2Score = (entry: RefinedRoledCandidate): number =>
      weakDirectIds.has(entry.candidate.symbolId)
        ? weakOrganicFinalById.get(entry.candidate.symbolId) ?? 0
        : pivotRankMeta.get(entry.candidate.symbolId)?.score ?? entry.candidate.scores.final;
    pivotCandidates.sort((left, right) => {
      return (
        v2Score(right) - v2Score(left)
        || left.candidate.fqName.localeCompare(right.candidate.fqName)
        || left.candidate.symbolId.localeCompare(right.candidate.symbolId)
      );
    });
  }

  // No high-confidence edit target: emit an intentionally empty capsule rather
  // than a vague support-only pile. The discards still report what was generated,
  // and the no-context explanations say precisely why nothing cleared the gate.
  if (pivotCandidates.length === 0) {
    return noContextResult({
      intent,
      plan,
      maxTokens: input.maxTokens,
      candidateCount: candidates.length,
      supportCount: supportCandidates.length,
      discarded: [
        ...supportCandidates.map((r) => toDiscarded(r, "support-only: no actionable edit target")),
        ...roleDiscards.map((r) => toDiscarded(r, r.roleReason)),
      ],
      weights: weightsRecord,
      shaped,
      localizationSignals,
      explanations: buildNoContextExplanations(refined, shaped),
      compoundTaskRescueUsed,
      ...(documentProfile === undefined
        ? {}
        : { documentIntegrationProfile: finalizeDocumentProfile(documentProfile) }),
      debugDiagnostics: {
        ...debugDiagnostics,
        ...lineAnchorDiagnostics,
        ...bodyLiteralDiagnostics(bodyLiteralMatches),
        ...nonSourceDiagnostics,
        ...titleSymbolDiagnostics,
        ...literalAnchorDiagnostics,
        ...directEvidenceDiagnostics,
        ...graphNeighborDiagnostics,
        ...genericLexicalDecoyDiagnostics,
      },
    });
  }

  // Greedy budget fill: pivots first (focused source, laddered down to fit),
  // then support (signatures), counting each item by the exact text it renders.
  const pivots: CapsuleV2Item[] = [];
  const support: CapsuleV2Item[] = [];
  const discarded: CapsuleV2Discarded[] = [];
  let usedTokens = 0;

  const pivotPackingStarted = capsuleProfile === undefined ? 0 : performance.now();
  pivotCandidates.forEach((entry, index) => {
    // The lead pivot is guaranteed (a capsule must name a target); later pivots
    // that cannot fit even a skeleton drop to the discard list.
    const forced = index === 0;
    const item = renderPivot(input.db, input.repoRoot, entry, input.maxTokens - usedTokens, forced);
    if (item === undefined) {
      discarded.push(toDiscarded(entry, "over budget: no room for this pivot"));
      return;
    }
    // Attach v2 ranking metadata (debug/report only — not rendered into the
    // prompt, so token accounting is unaffected).
    const rankMeta = pivotRankMeta.get(entry.candidate.symbolId);
    if (rankMeta !== undefined) {
      item.pivot_ranking_version = rankMeta.version;
      item.pivot_rank_score = rankMeta.score;
      item.pivot_rank_signals = rankMeta.signals;
      item.pivot_rank_penalties = rankMeta.penalties;
      item.pivot_rank_reason = rankMeta.reason;
    }
    // §48: the deciding statement must be delivered deliberately, never left to
    // whether the whole body happened to fit. Locate it always; when the body was
    // compressed away, deliver the slice INSTEAD of a bare signature, so a
    // budget-squeezed decider still shows the line that decides.
    const mechanismEvidence = retrieval.mechanismEvidenceById.get(entry.candidate.symbolId);
    if (mechanismEvidence !== undefined && mechanismEvidence.score > 0) {
      const anchor = mechanismEvidence.matched[0];
      const symbol = getSymbolById(input.db, entry.candidate.symbolId);
      if (anchor !== undefined && symbol !== undefined) {
        const slice = buildMechanismSlice(input.repoRoot, symbol, {
          kind: anchor.kind, subject: anchor.subject, lineOffset: anchor.lineOffset,
          evidence: anchor.evidence, provenance: anchor.provenance,
          resultBearing: anchor.resultBearing,
        });
        if (slice !== undefined) {
          item.mechanism_slice = {
            start_line: slice.startLine, end_line: slice.endLine,
            decision_line: slice.decisionLine, lines: slice.lines,
            bytes: slice.bytes, truncated: slice.truncated,
          };
          if (item.content_mode !== CapsuleV2ContentMode.Full) {
            item.content_mode = CapsuleV2ContentMode.MechanismSlice;
            item.source = slice.source;
          }
        }
      }
    }
    usedTokens += item.estimated_tokens;
    pivots.push(item);
  });
  recordCapsuleTiming(capsuleProfile, "capsule.pivot_packing", pivotPackingStarted);

  // Order support so the most edit-relevant context wins scarce support slots:
  // cap-demoted implementation helpers first, then ordinary local support, and
  // generic infrastructure last — a generic parser class must never outrank a
  // local helper (Problem B). Within a tier, higher final score wins. For
  // non-debug intents every signal is false, so this reduces to final order.
  // Recovered graph neighbours are appended AFTER every real support candidate, so
  // they only fill a leftover slot and never displace a file vtrace already found.
  const baseSupportOrder = [...supportCandidates].sort(
    (left, right) =>
      supportTier(left) - supportTier(right)
      || right.candidate.scores.final - left.candidate.scores.final,
  );

  // An anchored pivot-cap exemption (M101) CONVERTS one support slot into the
  // extra pivot slot rather than growing the capsule: the promoted target was
  // (or would have been) support anyway, so the total item budget — and with it
  // file count, overpacking, and token profile — stays at the tier's cap.
  const maxSupportSlots = Math.max(
    0,
    allocation.maxSupport - (anchoredCapExemption !== undefined ? 1 : 0),
  );

  // Hidden co-edit support expansion (M97). With a credible source lead pivot,
  // relation-backed sibling files (edge-connected package neighbours with
  // task-word affinity, generated-artifact pairs, or pooled siblings the support
  // budget squeezed out) enter as SUPPORT-only co-edit candidates. Placement is
  // displacement-safe: co-edit entries rank BEHIND every winner that introduces a
  // genuinely new, non-generic file, and only ahead of duplicate-file /
  // generic-infra winners — so a co-edit can reclaim a slot spent on a second
  // symbol of an already-present file but never evict a distinct support file
  // vtrace found on its own evidence.
  const coeditStarted = capsuleProfile === undefined ? 0 : performance.now();
  const coedit = expandCoeditSupport({
    db: input.db,
    task: input.task,
    pivotEntries: pivotCandidates,
    supportEntries: baseSupportOrder,
    winnerSymbolIds: new Set(
      baseSupportOrder.slice(0, maxSupportSlots).map((e) => e.candidate.symbolId),
    ),
    poolFilePaths: new Set(candidates.map((c) => c.filePath)),
    ids: { anchorSymbolIds, titleSymbolIds, literalAnchorIds, directEvidenceStrongIds, suppressedDecoyIds },
    repoRoot: input.repoRoot,
  });
  recordCapsuleTiming(capsuleProfile, "structural.coedit_expansion", coeditStarted);
  const coeditSymbolIds = new Set(coedit.entries.map((e) => e.candidate.symbolId));

  let orderedSupport: RefinedRoledCandidate[];
  let displaceableWinners: RefinedRoledCandidate[] = [];
  if (coedit.entries.length === 0) {
    orderedSupport = [...baseSupportOrder, ...graphNeighborSupport];
  } else {
    const order = orderSupportWithCoedit({
      baseOrder: baseSupportOrder,
      coeditEntries: coedit.entries,
      rescuedSymbolIds: coedit.rescuedSymbolIds,
      spareOnlySymbolIds: coedit.spareOnlySymbolIds,
      pivotFilePaths: new Set(pivotCandidates.map((e) => e.candidate.filePath)),
      maxSupport: maxSupportSlots,
      // Generic-infrastructure-tier support is junk a co-edit may replace.
      isProtectedTier: (entry) => supportTier(entry) !== 2,
    });
    displaceableWinners = order.displaceableWinners;
    orderedSupport = [
      ...order.ordered,
      ...graphNeighborSupport.filter((e) => !coeditSymbolIds.has(e.candidate.symbolId)),
    ];
  }

  // File-evidence deep-pool rescue (M100). The candidate pool cap counts
  // SYMBOLS (25 symbols ≈ 9 distinct files), so a real edit target the organic
  // generators DO reach can still miss the pool entirely. When such a deep-pool
  // source file also carries an exact, low-ambiguity derived-task evidence term
  // verbatim in its raw source text, rescue it as a SUPPORT-only entry. The
  // lane is doubly gated (organic reach AND exact file-level evidence — the
  // M100 audit measured each signal alone as noise), capped at 2 files, barred
  // from capsules already at 5 distinct files (an overpack flip needs ≥6), and
  // placed under the M98 displacement contract below, so it can reclaim a
  // duplicate-file/generic/docs slot but never evict a distinct new-file
  // winner, and never touches pivots.
  const baseWinnerFiles = new Set(pivotCandidates.map((e) => e.candidate.filePath));
  for (const entry of orderedSupport.slice(0, maxSupportSlots)) {
    baseWinnerFiles.add(entry.candidate.filePath);
  }
  const fileEvidenceStarted = capsuleProfile === undefined ? 0 : performance.now();
  const fileEvidence = rescueFileEvidenceSupport({
    db: input.db,
    repoRoot: input.repoRoot,
    task: input.task,
    shaped,
    weights,
    symbolSeeds,
    poolFilePaths: new Set([
      ...candidates.map((c) => c.filePath),
      ...coedit.entries.map((e) => e.candidate.filePath),
      ...graphNeighborSupport.map((e) => e.candidate.filePath),
    ]),
    baseDistinctFileCount: baseWinnerFiles.size,
    taskAllowsNonSource,
    requestCache: hybridRequestCache,
  });
  recordCapsuleTiming(capsuleProfile, "structural.file_evidence_deep_pass", fileEvidenceStarted);
  const fileEvidenceSymbolIds = new Set(fileEvidence.entries.map((e) => e.candidate.symbolId));
  if (fileEvidence.entries.length > 0) {
    const rescueOrder = orderSupportWithCoedit({
      baseOrder: orderedSupport,
      coeditEntries: fileEvidence.entries,
      rescuedSymbolIds: new Set(),
      spareOnlySymbolIds: new Set(),
      pivotFilePaths: new Set(pivotCandidates.map((e) => e.candidate.filePath)),
      maxSupport: maxSupportSlots,
      isProtectedTier: (entry) => supportTier(entry) !== 2,
    });
    orderedSupport = rescueOrder.ordered;
  }

  // Path-coherent orchestration delivery (M140-C). The M140-B rescue lane already
  // DISCOVERED the upstream entry point of the chain this request is about; what
  // it could not do is deliver it, because a rescued candidate is by construction
  // weakly lexical and lands far down the ordinary ranking. Rather than inflating
  // its score — which would put two-hop callers above exact direct answers — one
  // bounded support slot may go to the single candidate that completes an exact
  // short call path whose every other node is ALREADY selected below. Its ordinary
  // rank and score are reported unchanged; only the SELECTION changes.
  const pathCompletionStarted = capsuleProfile === undefined ? 0 : performance.now();
  const supportWinners = orderedSupport.slice(0, maxSupportSlots);
  const orchestrationIntentReason =
    retrieval.upstreamRescue.activationReason ?? retrieval.upstreamRescue.suppressedBy;
  const pathCompletion = selectPathCompletion({
    orchestrationPaths: retrieval.orchestrationPaths,
    // The lane's own gate, reused rather than recomputed: a request that is not
    // orchestration-shaped never produced a path to complete.
    orchestrationIntentActive: retrieval.upstreamRescue.activated,
    ...(orchestrationIntentReason === undefined ? {} : { orchestrationIntentReason }),
    selectedFqNames: new Set([
      ...pivots.map((item) => item.fq_name),
      ...supportWinners.map((entry) => entry.candidate.fqName),
    ]),
    supportSlots: maxSupportSlots,
    hasBranchClause: (shaped.derivedIntent?.branchClauses.length ?? 0) > 0,
  });
  let pathCompletionSymbolId: string | undefined;
  let pathCompletionDisplaced: string | undefined;
  if (pathCompletion.selection !== undefined) {
    const selection = pathCompletion.selection;
    pathCompletionSymbolId = selection.candidate.symbolId;
    const entry: RefinedRoledCandidate = {
      candidate: selection.candidate,
      role: CandidateRole.Support,
      roleReason: selection.selectionReason,
      signals: NO_DEBUG_ROLE_SIGNALS,
    };
    // Replacement policy (§21/§22): the role converts ONE existing support slot,
    // it never grows the capsule. It may only take the slot of the weakest winner
    // that is not itself load-bearing — an author-pointed anchor, a body-literal
    // diagnostic, or a node of the very path being completed (evicting the
    // intermediate would defeat the purpose). If nothing is displaceable the role
    // simply goes unused: a weak support item is worth less than a strong one, but
    // not less than nothing.
    // A rescued candidate that DID make the pool can also be sitting in the tail
    // of the support ordering, past the slot cut. Splicing without removing it
    // would leave a twin behind, reported as budget-dropped while the symbol it
    // names is delivered. Drop the twin; the entry below replaces it.
    orderedSupport = orderedSupport.filter((existing) =>
      existing.candidate.symbolId !== selection.candidate.symbolId);
    const pathNodes = new Set(selection.path);
    const isProtected = (winner: RefinedRoledCandidate): boolean =>
      pathNodes.has(winner.candidate.fqName)
      || winner.candidate.scores.bodyLiteral > 0
      || anchorSymbolIds.has(winner.candidate.symbolId)
      || titleSymbolIds.has(winner.candidate.symbolId)
      || literalAnchorIds.has(winner.candidate.symbolId)
      || directEvidenceStrongIds.has(winner.candidate.symbolId);
    if (supportWinners.length < maxSupportSlots) {
      orderedSupport = [...orderedSupport.slice(0, supportWinners.length), entry, ...orderedSupport.slice(supportWinners.length)];
    } else {
      let displaceIndex = -1;
      for (let index = supportWinners.length - 1; index >= 0; index -= 1) {
        if (!isProtected(supportWinners[index]!)) {
          displaceIndex = index;
          break;
        }
      }
      if (displaceIndex < 0) {
        pathCompletionSymbolId = undefined;
      } else {
        const displaced = orderedSupport[displaceIndex]!;
        pathCompletionDisplaced = displaced.candidate.fqName;
        // The displaced entry keeps its place in the ordering behind the winners,
        // so it is reported as budget-dropped rather than silently vanishing.
        orderedSupport = [
          ...orderedSupport.slice(0, displaceIndex),
          entry,
          ...orderedSupport.slice(displaceIndex + 1, maxSupportSlots),
          displaced,
          ...orderedSupport.slice(maxSupportSlots),
        ];
      }
    }
  }
  recordCapsuleTiming(capsuleProfile, "structural.path_completion", pathCompletionStarted);

  // --- M150 bounded mechanism support -----------------------------------------
  //
  // Ranking already found the decider and put it in `pivots`. What is still
  // missing is the evidence explaining WHY its choice has the semantics the
  // request asked about — for a first-item selection, the code that established
  // the order. Seeded ONLY from already-selected pivots that carry mechanism
  // evidence, so this can never become a general helper-expansion lane (§11).
  const mechanismSupportStarted = capsuleProfile === undefined ? 0 : performance.now();
  const objective = retrieval.behavioralObjective;
  const deliveredPivotFqNames = new Set(pivots.map((item) => item.fq_name));
  const mechanismSeeds = hasBehavioralOperation(objective)
    ? pivotCandidates
      .filter((entry) => deliveredPivotFqNames.has(entry.candidate.fqName))
      .flatMap((entry) => {
        const evidence = retrieval.mechanismEvidenceById.get(entry.candidate.symbolId);
        if (evidence === undefined || evidence.score <= 0) return [];
        const fact = evidence.matched.find((matched) => matched.provenance.length > 0);
        if (fact === undefined) return [];
        return [{
          symbolId: entry.candidate.symbolId,
          fqName: entry.candidate.fqName,
          provenance: fact.provenance,
        }];
      })
    : [];
  const mechanismSupport: MechanismSupportResult = hasBehavioralOperation(objective)
    ? discoverMechanismSupport({
      db: input.db,
      operation: objective.operation,
      seeds: mechanismSeeds,
      deliveredSymbolIds: new Set([
        ...pivotCandidates.map((entry) => entry.candidate.symbolId),
        ...orderedSupport.slice(0, maxSupportSlots).map((entry) => entry.candidate.symbolId),
      ]),
    })
    : inactiveMechanismSupport("request declares no behavioural operation");
  recordCapsuleTiming(capsuleProfile, "structural.mechanism_support", mechanismSupportStarted);

  // The helper enters through the ROLE, carrying the ordinary score and rank
  // retrieval computed for it. Nothing here adjusts either (§10).
  const mechanismSupportSymbolIds = new Map<string, { reason: string; ordinaryRank: number | null }>();
  for (const helper of mechanismSupport.candidates) {
    const evaluated = retrieval.evaluatedById.get(helper.symbol.id);
    const ordinaryRank = evaluated === undefined
      ? null
      : ([...retrieval.evaluatedById.values()].findIndex((c) => c.symbolId === helper.symbol.id) + 1) || null;
    const candidate: HybridCandidate = evaluated ?? {
      symbolId: helper.symbol.id,
      filePath: helper.symbol.filePath,
      fqName: helper.symbol.fqName,
      localName: helper.symbol.localName,
      kind: helper.symbol.kind,
      // A symbol ordinary retrieval never generated has no earned score, and
      // inventing one would be exactly the inflation §10 forbids. Zero is the
      // truthful value: it did not compete.
      scores: unscoredComponents(),
      sources: [],
      evidence: [],
      matches: [],
    };
    mechanismSupportSymbolIds.set(helper.symbol.id, { reason: helper.reason, ordinaryRank });
    const entry: RefinedRoledCandidate = {
      candidate,
      role: CandidateRole.Support,
      roleReason: helper.reason,
      signals: NO_DEBUG_ROLE_SIGNALS,
    };
    // Splicing past the slot cap would leave the helper permanently unpacked, so
    // when support is full the weakest winner is DISPLACED rather than the
    // explanation silently dropped. The displaced entry keeps its place behind
    // the cap and is reported as budget-dropped, exactly as M140-C does.
    if (orderedSupport.length < maxSupportSlots) {
      orderedSupport = [...orderedSupport, entry];
    } else {
      const displaced = orderedSupport[maxSupportSlots - 1]!;
      orderedSupport = [
        ...orderedSupport.slice(0, maxSupportSlots - 1),
        entry,
        displaced,
        ...orderedSupport.slice(maxSupportSlots),
      ];
    }
  }

  // Combined token ceiling for co-edit items, so the lane can never inflate the
  // capsule: whatever does not fit under the fraction is discarded (and counted).
  const coeditTokenCeiling = Math.floor(input.maxTokens * COEDIT_BUDGET_FRACTION);
  let coeditTokensUsed = 0;
  let coeditBudgetLimitedCount = 0;
  // Separate ceiling for file-evidence rescues, so that lane is bounded too.
  const fileEvidenceTokenCeiling = Math.floor(input.maxTokens * FILE_EVIDENCE_BUDGET_FRACTION);
  let fileEvidenceTokensUsed = 0;
  let fileEvidenceBudgetLimitedCount = 0;
  const renderedSupportIds = new Set<string>();

  const supportPackingStarted = capsuleProfile === undefined ? 0 : performance.now();
  for (const entry of orderedSupport) {
    if (support.length >= maxSupportSlots) {
      discarded.push(toDiscarded(entry, `beyond ${allocation.tier} support budget (max ${maxSupportSlots})`));
      continue;
    }
    const item = renderSupport(input.db, input.repoRoot, entry, input.maxTokens - usedTokens);
    if (item === undefined) {
      discarded.push(toDiscarded(entry, "over budget: no room for this support item"));
      continue;
    }
    if (coeditSymbolIds.has(entry.candidate.symbolId)) {
      if (coeditTokensUsed + item.estimated_tokens > coeditTokenCeiling) {
        coeditBudgetLimitedCount += 1;
        discarded.push(toDiscarded(entry, "co-edit token ceiling: over the co-edit budget fraction"));
        continue;
      }
      coeditTokensUsed += item.estimated_tokens;
    }
    if (fileEvidenceSymbolIds.has(entry.candidate.symbolId)) {
      if (fileEvidenceTokensUsed + item.estimated_tokens > fileEvidenceTokenCeiling) {
        fileEvidenceBudgetLimitedCount += 1;
        discarded.push(toDiscarded(entry, "file-evidence token ceiling: over the rescue budget fraction"));
        continue;
      }
      fileEvidenceTokensUsed += item.estimated_tokens;
    }
    const mechanismRole = mechanismSupportSymbolIds.get(entry.candidate.symbolId);
    if (mechanismRole !== undefined) {
      // §43: the role and the ordinary rank sit side by side. The item is here
      // because it explains the decision, and it is honest about not having
      // earned a place on its own evidence.
      item.selection_role = "mechanism_support";
      item.selection_reason = mechanismRole.reason;
      if (mechanismRole.ordinaryRank !== null) item.ordinary_rank = mechanismRole.ordinaryRank;
      const helper = mechanismSupport.candidates.find(
        (found) => found.symbol.id === entry.candidate.symbolId);
      if (helper !== undefined) {
        const slice = buildMechanismSlice(input.repoRoot, helper.symbol, helper.fact);
        if (slice !== undefined) {
          // The ordering line is the whole reason this helper is here; a bare
          // signature would name it without showing it (§22).
          item.content_mode = CapsuleV2ContentMode.MechanismSlice;
          item.source = slice.source;
          item.mechanism_slice = {
            start_line: slice.startLine, end_line: slice.endLine,
            decision_line: slice.decisionLine, lines: slice.lines,
            bytes: slice.bytes, truncated: slice.truncated,
          };
        }
      }
    }
    if (entry.candidate.symbolId === pathCompletionSymbolId && pathCompletion.selection !== undefined) {
      // §19/§41: the role and the rank are reported side by side. The item is
      // here because it completes the path, and it is honest about being a weak
      // direct match — folding one into the other would lose exactly the
      // distinction this milestone exists to establish.
      item.selection_role = "orchestration_support";
      item.selection_reason = pathCompletion.selection.selectionReason;
      item.ordinary_rank = pathCompletion.selection.ordinaryRank;
    }
    usedTokens += item.estimated_tokens;
    renderedSupportIds.add(entry.candidate.symbolId);
    support.push(item);
  }
  recordCapsuleTiming(capsuleProfile, "capsule.support_packing", supportPackingStarted);

  // Truthful file-document candidates share the authoritative selection. They
  // replace only the weakest packed support entries and can never become pivots
  // or graph evidence. This keeps the capsule/item cap fixed.
  const documentAccountingStarted = documentProfile === undefined ? 0 : performance.now();
  for (const document of documentRetrieval.candidates.slice(0, 2)) {
    if ([...pivots, ...support].some((item) => item.path === document.path)) continue;
    const documentRenderingStarted = documentProfile === undefined ? 0 : performance.now();
    const item = composeDocumentItem(document);
    recordDocumentTiming(documentProfile, "document_rendering", documentRenderingStarted);
    incrementDocumentCounter(documentProfile, "document_items_rendered", 1);
    while (
      support.length > 0
      && (support.length >= maxSupportSlots || usedTokens + item.estimated_tokens > input.maxTokens)
    ) {
      let removableIndex = -1;
      for (let index = support.length - 1; index >= 0; index -= 1) {
        const candidate = support[index]!;
        if (
          candidate.document_kind === undefined
          && matchPathCluesWithContext(candidate.path, pathContext).length === 0
        ) {
          removableIndex = index;
          break;
        }
      }
      if (removableIndex < 0) {
        for (let index = support.length - 1; index >= 0; index -= 1) {
          if (support[index]!.document_kind === undefined) {
            removableIndex = index;
            break;
          }
        }
      }
      if (removableIndex < 0) break;
      const [removed] = support.splice(removableIndex, 1);
      if (removed === undefined) break;
      usedTokens -= removed.estimated_tokens;
    }
    if (support.length >= maxSupportSlots || usedTokens + item.estimated_tokens > input.maxTokens) continue;
    support.push(item);
    usedTokens += item.estimated_tokens;
  }
  recordDocumentTiming(documentProfile, "document_accounting_deduplication", documentAccountingStarted);
  incrementDocumentCounter(
    documentProfile,
    "selected_document_count",
    support.filter((item) => item.document_kind !== undefined).length,
  );

  // Preserve one directly scoped notebook-verification surface when the task
  // explicitly asks for it. This is relevance-qualified (indexed Python symbol,
  // subtree evidence, notebook path term), and therefore cannot act as a weak
  // role filler.
  if (
    /\bnotebook\b/iu.test(input.task)
    && ![...pivots, ...support].some((item) => item.path.toLowerCase().includes("notebook"))
  ) {
    const notebookEntry = refined
      .filter((entry) =>
        entry.candidate.filePath.toLowerCase().includes("notebook")
        && entry.candidate.scores.path >= 0.75
        && entry.candidate.scores.actionability > 0)
      .sort((left, right) =>
        right.candidate.scores.final - left.candidate.scores.final
        || left.candidate.filePath.localeCompare(right.candidate.filePath))[0];
    if (notebookEntry !== undefined) {
      const item = renderSupport(input.db, input.repoRoot, notebookEntry, input.maxTokens - usedTokens);
      if (item !== undefined) {
        if (support.length >= maxSupportSlots) {
          const removableIndex = support.findIndex((candidate) =>
            candidate.document_kind === undefined
            && matchPathCluesWithContext(candidate.path, pathContext).length === 0);
          if (removableIndex >= 0) {
            const [removed] = support.splice(removableIndex, 1);
            if (removed !== undefined) usedTokens -= removed.estimated_tokens;
          }
        }
        if (support.length < maxSupportSlots && usedTokens + item.estimated_tokens <= input.maxTokens) {
          support.push(item);
          usedTokens += item.estimated_tokens;
        }
      }
    }
  }

  // Diagnostics: which displaceable winners actually lost their slot to a co-edit
  // candidate. Only a rendered HIGH-confidence (displacing) co-edit can be the
  // cause — spare-only (medium) entries rank behind every winner, so a winner
  // missing next to a rendered medium entry was cut by the ordinary budget.
  const coeditDisplacingRendered = coedit.entries.some(
    (e) => !coedit.spareOnlySymbolIds.has(e.candidate.symbolId)
      && renderedSupportIds.has(e.candidate.symbolId),
  );
  const coeditDisplaced = coeditDisplacingRendered
    ? displaceableWinners
        .filter((w) => !renderedSupportIds.has(w.candidate.symbolId))
        .map((w) => ({ path: w.candidate.filePath, symbol: w.candidate.localName }))
    : [];
  // Medium-confidence entries that found no spare slot — the displacements the
  // M98 spare-only placement refused (they would have rendered under M97).
  const coeditSpareSlotDeferredCount = coedit.entries.filter(
    (e) => coedit.spareOnlySymbolIds.has(e.candidate.symbolId)
      && !renderedSupportIds.has(e.candidate.symbolId),
  ).length;
  const coeditConfidenceTiers: Record<string, number> = {};
  for (const c of [...coedit.candidates, ...coedit.pruned]) {
    coeditConfidenceTiers[c.confidence] = (coeditConfidenceTiers[c.confidence] ?? 0) + 1;
  }
  const coeditDiagnostics: Partial<CapsuleV2Result["diagnostics"]> =
    coedit.fired
    || coedit.highDegreeRejectedCount > 0
    || coedit.ambiguousRejectedCount > 0
    || coedit.importConsideredCount > 0
      ? {
          coedit_lane_fired: coedit.fired,
          ...(coedit.anchors.length > 0 ? { coedit_anchors: coedit.anchors } : {}),
          ...(coedit.candidates.length > 0 ? { coedit_candidates: coedit.candidates } : {}),
          ...(coedit.pruned.length > 0
            ? {
                coedit_pruned: coedit.pruned,
                coedit_pruned_low_confidence_count: coedit.pruned.length,
              }
            : {}),
          ...(Object.keys(coeditConfidenceTiers).length > 0
            ? { coedit_confidence_tiers: coeditConfidenceTiers }
            : {}),
          ...(coeditSpareSlotDeferredCount > 0
            ? { coedit_spare_slot_deferred_count: coeditSpareSlotDeferredCount }
            : {}),
          ...(coedit.highDegreeRejectedCount > 0
            ? { coedit_high_degree_rejected_count: coedit.highDegreeRejectedCount }
            : {}),
          ...(coedit.ambiguousRejectedCount > 0
            ? { coedit_ambiguous_rejected_count: coedit.ambiguousRejectedCount }
            : {}),
          ...(coeditBudgetLimitedCount > 0
            ? { coedit_budget_limited_count: coeditBudgetLimitedCount }
            : {}),
          ...(coeditDisplaced.length > 0 ? { coedit_displaced: coeditDisplaced } : {}),
          ...(coedit.importConsideredCount > 0
            ? { coedit_import_considered_count: coedit.importConsideredCount }
            : {}),
          ...(coedit.importHubRejectedCount > 0
            ? { coedit_import_hub_rejected_count: coedit.importHubRejectedCount }
            : {}),
          ...(coedit.importAmbiguousRejectedCount > 0
            ? { coedit_import_ambiguous_rejected_count: coedit.importAmbiguousRejectedCount }
            : {}),
        }
      : {};

  // File-evidence rescue diagnostics: every extraction/gate decision the lane
  // made, surfaced only when the lane did anything observable.
  const fileEvidenceDiagnostics: Partial<CapsuleV2Result["diagnostics"]> =
    fileEvidence.fired
    || fileEvidence.fileCapSkipped
    || fileEvidence.consideredCount > 0
    || fileEvidence.ambiguousRejectedCount > 0
      ? {
          file_evidence_lane_fired: fileEvidence.fired,
          file_evidence_mentions: fileEvidence.mentions.map((m) => `${m.shape}:${m.term}`),
          file_evidence_considered_count: fileEvidence.consideredCount,
          ...(fileEvidence.matches.length > 0
            ? {
                file_evidence_candidates: fileEvidence.matches.map((m) => ({
                  path: m.path,
                  symbol: m.symbol,
                  term: m.term,
                  shape: m.shape,
                  ambiguity: m.ambiguity,
                  organic_rank: m.organicRank,
                })),
              }
            : {}),
          ...(fileEvidence.ambiguousRejectedCount > 0
            ? { file_evidence_ambiguous_rejected_count: fileEvidence.ambiguousRejectedCount }
            : {}),
          ...(fileEvidence.genericRejectedCount > 0
            ? { file_evidence_generic_rejected_count: fileEvidence.genericRejectedCount }
            : {}),
          ...(fileEvidence.sizeRejectedCount > 0
            ? { file_evidence_size_rejected_count: fileEvidence.sizeRejectedCount }
            : {}),
          ...(fileEvidence.prunedCount > 0
            ? { file_evidence_pruned_count: fileEvidence.prunedCount }
            : {}),
          ...(fileEvidence.fileCapSkipped ? { file_evidence_file_cap_skipped: true } : {}),
          ...(fileEvidenceBudgetLimitedCount > 0
            ? { file_evidence_budget_limited_count: fileEvidenceBudgetLimitedCount }
            : {}),
        }
      : {};

  // Documentation candidate source: query-relevant markdown sections fill any
  // remaining SUPPORT budget as summaries (never pivots — docs are not edit
  // targets). Code support takes priority, so docs are added last.
  if (support.length < maxSupportSlots) {
    const docs = retrieveDocSections(input.repoRoot, shaped.query, maxSupportSlots - support.length);
    for (const doc of docs) {
      const item = composeDocItem(doc);
      if (usedTokens + item.estimated_tokens > input.maxTokens) {
        continue;
      }
      usedTokens += item.estimated_tokens;
      support.push(item);
    }
  }

  for (const entry of roleDiscards) {
    discarded.push(toDiscarded(entry, entry.roleReason));
  }

  // Edit-risk directives: deterministic patch-planning hints derived from the
  // SHAPE of the selected pivots (shared-state mutation while a combined query is
  // rendered) and the task prose. Computed from the assembled pivots so the hint
  // reflects exactly the source the agent will read. Gated on the debug strategy.
  const editRiskDirectives = detectEditRiskDirectives({
    task: input.task,
    pivots,
    debugRefinement,
  });

  // Actionability hints: advisory reminders that a selected SOURCE file likely has
  // a paired generated/co-edit artifact (e.g. a PLY parser table) that must be
  // regenerated alongside it. Derived ONLY from the final selection's paths + the
  // workspace file map — never from retrieval scoring, ranking, or gold patches.
  const generatedArtifactHints = detectActionabilityHints({
    db: input.db,
    repoRoot: input.repoRoot,
    candidatePaths: [...pivots, ...support].map((item) => item.path),
  });

  // Multi-file co-edit hints: an explicit obligation when the SELECTION shape implies
  // a coordinated fix across several surfaced files (cross-module pivots, or sibling
  // pivots plus coupled caller/handler support). Derived ONLY from the final
  // selection's roles/paths/symbols + the task prose — never from retrieval scoring,
  // ranking, or gold patches. Files already covered by a more-specific
  // generated-artifact hint are excluded so the two never duplicate or override.
  const generatedArtifactFiles = generatedArtifactHints.flatMap((hint) => [
    hint.sourceFile,
    hint.relatedFile,
  ]);
  const coeditHints = detectMultiFileCoeditHints({
    task: input.task,
    pivots: pivots.map(toCoeditCandidate),
    support: support.map(toCoeditCandidate),
    generatedArtifactFiles,
  });
  // Generated-artifact hints first (more specific), then the multi-file co-edit hints.
  const actionabilityHints = [...generatedArtifactHints, ...coeditHints];

  return {
    intent,
    actual_mode: allocation.tier,
    budget: {
      max_tokens: input.maxTokens,
      estimated_tokens: usedTokens,
      used_percent: input.maxTokens > 0 ? roundPercent((usedTokens / input.maxTokens) * 100) : 0,
    },
    pivots,
    support,
    discarded,
    diagnostics: {
      intent_reason: plan.intent_reason,
      intent_confidence: plan.intent_confidence,
      strategy: plan.strategy,
      candidate_count: candidates.length,
      candidate_scores: candidateScoreDiagnostics(candidates),
      ...(compoundTaskRescueUsed ? { compound_task_rescue_used: true } : {}),
      ...pathCompletionDiagnostics(
        pathCompletion,
        pathCompletionSymbolId,
        pathCompletionDisplaced,
        support,
      ),
      ...(input.includeTimingDiagnostics === true ? {
        stage_timings_ms: {
          task_derivation: taskDerivationMs,
          hybrid_retrieval: hybridRetrievalMs,
        },
        ...(hybridProfile === undefined ? {} : { hybrid_profile: hybridProfile }),
        ...(capsuleProfile === undefined ? {} : { capsule_profile: capsuleProfile }),
        ...(documentProfile === undefined
          ? {}
          : {
              document_integration_profile: finalizeDocumentProfile(documentProfile),
            }),
      } : {}),
      pivot_count: pivots.length,
      support_count: support.length,
      discarded_count: discarded.length,
      tier: allocation.tier,
      weights: weightsRecord,
      likely_files: shaped.likelyFiles,
      likely_symbols: shaped.likelySymbols,
      failing_tests: shaped.failingTests,
      ...filteredSignalDiagnostics(shaped),
      ...querySemanticsDiagnostics(shaped),
      ...lexicalScoringDiagnostics(shaped.query),
      ...bodyLiteralDiagnostics(bodyLiteralMatches),
      ...debugDiagnostics,
      ...pivotGuardDiagnostics,
      ...lineAnchorDiagnostics,
      ...nonSourceDiagnostics,
      ...titleSymbolDiagnostics,
      ...literalAnchorDiagnostics,
      ...directEvidenceDiagnostics,
      ...graphNeighborDiagnostics,
      ...coeditDiagnostics,
      ...fileEvidenceDiagnostics,
      ...genericLexicalDecoyDiagnostics,
      ...(documentRetrieval.invoked
        ? {
            document_retrieval: {
              invoked: true,
              reason: documentRetrieval.reason,
              query_terms: documentRetrieval.queryTerms,
              candidate_count: documentRetrieval.candidates.length,
              selected_count: support.filter((item) => item.document_kind !== undefined).length,
              query_ms: input.includeTimingDiagnostics === true ? documentRetrieval.queryMs : 0,
              candidates: documentRetrieval.candidates.map((document, index) => {
                const selected = support.some((item) => item.path === document.path);
                return {
                  path: document.path,
                  kind: document.kind,
                  raw_rank: document.rawRank,
                  merged_rank: index + 1,
                  score: document.score,
                  matched_terms: document.matchedTerms,
                  objective_matches: document.objectiveMatches,
                  line_spans: document.excerpts.map((excerpt) => ({
                    start: excerpt.startLine,
                    end: excerpt.endLine,
                  })),
                  selected,
                  ...(selected ? {} : { exclusion_reason: "support_file_cap_or_budget" }),
                };
              }),
            },
          }
        : {}),
      ...(editRiskDirectives.length > 0 ? { edit_risk_directives: editRiskDirectives } : {}),
      localization_signals: localizationSignals,
    },
    ...(actionabilityHints.length > 0 ? { actionability_hints: actionabilityHints } : {}),
  };
}

function recordCapsuleTiming(
  profile: { timingsMs: Record<string, number> } | undefined,
  name: string,
  started: number,
): void {
  if (profile !== undefined) {
    profile.timingsMs[name] = (profile.timingsMs[name] ?? 0) + performance.now() - started;
  }
}

function recordDocumentTiming(
  profile: DocumentIntegrationProfile | undefined,
  name: string,
  started: number,
): void {
  if (profile !== undefined) {
    profile.timingsMs[name] = (profile.timingsMs[name] ?? 0) + performance.now() - started;
  }
}

function incrementDocumentCounter(
  profile: DocumentIntegrationProfile | undefined,
  name: string,
  delta: number,
): void {
  if (profile !== undefined) {
    profile.counters[name] = (profile.counters[name] ?? 0) + delta;
  }
}

function finalizeDocumentProfile(
  profile: DocumentIntegrationProfile,
): DocumentIntegrationProfile {
  const topLevelStages = [
    "path_clue_extraction",
    "objective_decomposition",
    "document_relevance_detection",
    "document_fts_query",
    "document_chunk_excerpt_loading",
    "document_candidate_materialization",
    "path_candidate_retrieval_scoring",
    "mixed_surface_coverage_selection",
    "document_accounting_deduplication",
  ];
  profile.timingsMs.m128_integration_total = topLevelStages.reduce(
    (total, stage) => total + (profile.timingsMs[stage] ?? 0),
    0,
  );
  return profile;
}

// Project an assembled capsule item onto the minimal view the multi-file co-edit
// detector reads (role/path/symbol/kind + the non-source-example flag). Structurally
// identical to the persisted Stage-5 manifest item, so the detector behaves the same
// at build time and in the offline audit.
function toCoeditCandidate(item: CapsuleV2Item): CoeditCandidateItem {
  return {
    role: item.role,
    path: item.path,
    symbol: item.symbol,
    kind: item.kind,
    isNonSourceExample: item.is_non_source_example === true,
  };
}

function candidateScoreDiagnostics(candidates: readonly HybridCandidate[]) {
  return candidates.map((candidate, index) => ({
    rank: index + 1,
    symbol_id: candidate.symbolId,
    path: candidate.filePath,
    fq_name: candidate.fqName,
    symbol: candidate.localName,
    sources: [...candidate.sources],
    evidence: [...candidate.evidence],
    scores: { ...candidate.scores },
    ...(candidate.identifierConfidence === undefined
      ? {}
      : { identifier_confidence: candidate.identifierConfidence }),
  }));
}

// Support ordering tier: implementation helpers (edit sites that only missed the
// pivot budget) rank above ordinary support, which ranks above generic
// infrastructure. Lower number = higher priority.
/**
 * M140-C accounting. Emitted only when the rescue lane actually produced
 * something to consider, so an ordinary request's diagnostics are unchanged —
 * but a request where the role was considered and DECLINED is as auditable as one
 * where it fired, which is what makes "this should be rare" a checkable claim.
 */
function pathCompletionDiagnostics(
  result: PathCompletionResult,
  appliedSymbolId: string | undefined,
  displaced: string | undefined,
  support: readonly CapsuleV2Item[],
): Partial<CapsuleV2Result["diagnostics"]> {
  const diagnostics = result.diagnostics;
  if (diagnostics.discoveredCandidates === 0 && !diagnostics.eligibleRequest) {
    return {};
  }
  const selection = result.selection;
  // "Selected" and "delivered" are different outcomes: the slot can still be lost
  // to the token budget after the role is granted, exactly like any other item.
  const applied = selection !== undefined
    && appliedSymbolId !== undefined
    && support.some((item) => item.selection_role === "orchestration_support");
  return {
    path_completion: {
      eligible_request: diagnostics.eligibleRequest,
      ...(diagnostics.requestRejectedBy === undefined
        ? {}
        : { request_rejected_by: diagnostics.requestRejectedBy }),
      discovered_candidates: diagnostics.discoveredCandidates,
      eligible_candidates: diagnostics.eligibleCandidates,
      selected_count: applied ? 1 : 0,
      rejected: {
        no_intent: diagnostics.rejectedNoIntent,
        already_selected: diagnostics.rejectedAlreadySelected,
        no_coherent_path: diagnostics.rejectedNoCoherentPath,
        weak_relevance: diagnostics.rejectedWeakRelevance,
        structural: diagnostics.rejectedStructural,
        depth: diagnostics.rejectedDepth,
        budget: diagnostics.rejectedBudget,
        slot_taken: diagnostics.rejectedSlotTaken,
      },
      evaluation_ms: diagnostics.evaluationMs,
      ...(selection === undefined ? {} : {
        selected: {
          fq_name: selection.candidate.fqName,
          ordinary_rank: selection.ordinaryRank,
          ordinary_score: selection.ordinaryScore,
          depth: selection.depth,
          path: [...selection.path],
          coverage_role: selection.coverageRole,
          selection_reason: selection.selectionReason,
          ...(displaced === undefined ? {} : { displaced }),
          applied,
        },
      }),
      candidates: diagnostics.candidates.map((entry) => ({
        fq_name: entry.fqName,
        ordinary_rank: entry.ordinaryRank,
        ordinary_score: entry.ordinaryScore,
        depth: entry.depth,
        path: [...entry.path],
        downstream_selected: entry.downstreamSelected,
        matched_terms: [...entry.matchedTerms],
        eligible: entry.eligible,
        ...(entry.rejectedBy === undefined ? {} : { rejected_by: entry.rejectedBy }),
        selected: entry.selected,
      })),
    },
  };
}

function supportTier(entry: RefinedRoledCandidate): number {
  if (entry.signals.is_implementation_helper) {
    return 0;
  }
  if (entry.signals.is_generic_infrastructure) {
    return 2;
  }
  return 1;
}

// --- pivot/support rendering --------------------------------------------------

// Render a pivot, laddering content full -> signature -> skeleton until it fits
// the remaining budget. A forced (lead) pivot always renders at least a skeleton
// so the capsule never goes empty when a target exists.
function renderPivot(
  db: Database,
  repoRoot: string,
  entry: RefinedRoledCandidate,
  remainingTokens: number,
  forced: boolean,
): CapsuleV2Item | undefined {
  const candidate = entry.candidate;
  const evidence = pivotEvidence(entry);
  const source = loadFocusedSource(db, repoRoot, candidate);
  const signature = loadSignature(db, repoRoot, candidate);

  const ladder: Array<{ mode: CapsuleV2ContentMode; source?: string; signature?: string }> = [];
  if (source !== undefined) {
    ladder.push({ mode: CapsuleV2ContentMode.Full, source, ...(signature ? { signature } : {}) });
  }
  if (signature !== undefined) {
    ladder.push({ mode: CapsuleV2ContentMode.Signature, signature });
  }
  ladder.push({ mode: CapsuleV2ContentMode.Skeleton });

  return firstFitting(entry, "pivot", evidence, ladder, remainingTokens, forced);
}

// Render a support item as a signature (or a skeleton when none is indexed).
// Support never carries a source body — that is what distinguishes it from a
// pivot. Dropped entirely when it does not fit the remaining budget.
/**
 * The scorecard of a symbol ordinary retrieval never generated.
 *
 * All zeros, deliberately. A mechanism-support helper is here because of a
 * causal relation, not because it competed and won, and inventing a score for it
 * would be exactly the rank/score inflation the role exists to avoid (§10).
 */
function unscoredComponents(): HybridScoreComponents {
  return {
    lexical: 0, fts: 0, tfidf: 0, bm25: 0, symbol: 0, path: 0, testToImpl: 0,
    bodyLiteral: 0, domain: 0, graph: 0, graphProximity: 0, centrality: 0,
    actionability: 1, inDegree: 0, localEvidence: 0, hubPenalty: 0,
    actionabilityPenalty: 0, final: 0,
  };
}

function renderSupport(
  db: Database,
  repoRoot: string,
  entry: RefinedRoledCandidate,
  remainingTokens: number,
): CapsuleV2Item | undefined {
  const candidate = entry.candidate;
  const evidence = supportEvidence(entry);
  const signature = loadSignature(db, repoRoot, candidate);

  const ladder: Array<{ mode: CapsuleV2ContentMode; signature?: string }> = [];
  if (signature !== undefined) {
    ladder.push({ mode: CapsuleV2ContentMode.Signature, signature });
  }
  ladder.push({ mode: CapsuleV2ContentMode.Skeleton });

  return firstFitting(entry, "support", evidence, ladder, remainingTokens, false);
}

// Pick the richest ladder rung whose rendered block fits the remaining budget.
// When `forced`, fall back to the cheapest rung even if it overflows, so a lead
// pivot is always emitted.
function firstFitting(
  entry: RefinedRoledCandidate,
  role: "pivot" | "support",
  evidence: string[],
  ladder: Array<{ mode: CapsuleV2ContentMode; source?: string; signature?: string }>,
  remainingTokens: number,
  forced: boolean,
): CapsuleV2Item | undefined {
  let cheapest: CapsuleV2Item | undefined;
  for (const rung of ladder) {
    const item = composeItem(entry, role, evidence, rung);
    if (item.estimated_tokens <= remainingTokens) {
      return item;
    }
    cheapest = item; // ladder is richest -> cheapest, so the last is the smallest.
  }
  return forced ? cheapest : undefined;
}

function composeItem(
  entry: RefinedRoledCandidate,
  role: "pivot" | "support",
  evidence: string[],
  rung: { mode: CapsuleV2ContentMode; source?: string; signature?: string },
): CapsuleV2Item {
  const candidate = entry.candidate;
  const item: CapsuleV2Item = {
    role,
    role_reason: entry.roleReason,
    is_entry_point: entry.signals.is_entry_point,
    is_implementation_helper: entry.signals.is_implementation_helper,
    is_generic_infrastructure: entry.signals.is_generic_infrastructure,
    is_class_method_expansion_target: entry.signals.is_class_method_expansion_target,
    is_containing_class_context: entry.signals.is_containing_class_context,
    is_query_builder_entrypoint: entry.signals.is_query_builder_entrypoint,
    is_sql_rendering_implementation: entry.signals.is_sql_rendering_implementation,
    path: candidate.filePath,
    fq_name: candidate.fqName,
    symbol: candidate.localName,
    kind: candidate.kind,
    content_mode: rung.mode,
    ...(rung.source === undefined ? {} : { source: rung.source }),
    ...(rung.signature === undefined ? {} : { signature: rung.signature }),
    evidence,
    scorecard: toScorecard(candidate.scores),
    estimated_tokens: 0,
    ...nonSourceFields(entry),
  };
  item.estimated_tokens = estimateTokens(itemBlockText(item));
  return item;
}

// The non-source example signal fields, present only when the candidate was
// classified as a docs/examples/sample/fixture file. Shared by items + discards.
function nonSourceFields(
  entry: RefinedRoledCandidate,
): { is_non_source_example?: true; non_source_reason?: string } {
  if (!entry.nonSourceExample?.isNonSourceExample) return {};
  return {
    is_non_source_example: true,
    ...(entry.nonSourceExample.reason === undefined ? {} : { non_source_reason: entry.nonSourceExample.reason }),
  };
}

// Kind label for a retrieved documentation section (not a code symbol kind).
const MARKDOWN_SECTION_KIND = "markdown_section";

// Compose a support item from a documentation section: a summary under a
// signature-style block, with a synthesised scorecard (lexical overlap only —
// docs carry no symbol/graph signals). Always support, never a pivot.
function composeDocItem(doc: DocSection): CapsuleV2Item {
  const item: CapsuleV2Item = {
    role: "support",
    role_reason: "relevant documentation section",
    is_entry_point: false,
    is_implementation_helper: false,
    is_generic_infrastructure: false,
    is_class_method_expansion_target: false,
    is_containing_class_context: false,
    is_query_builder_entrypoint: false,
    is_sql_rendering_implementation: false,
    path: doc.filePath,
    fq_name: `${doc.filePath}#${doc.heading}`,
    symbol: doc.heading,
    kind: MARKDOWN_SECTION_KIND,
    content_mode: CapsuleV2ContentMode.Signature,
    signature: doc.summary,
    evidence: [`markdown section "${doc.heading}" matches: ${doc.matchedTerms.join(", ")}`],
    scorecard: {
      lexical: doc.score,
      symbol: 0,
      path: 0,
      test_to_impl: 0,
      body_literal: 0,
      graph_proximity: 0,
      centrality: 0,
      actionability: 0,
      hub_penalty: 0,
      direct_answer: 0,
      mechanism_evidence: 0,
      final: doc.score,
    },
    estimated_tokens: 0,
  };
  item.estimated_tokens = estimateTokens(itemBlockText(item));
  return item;
}

function composeDocumentItem(document: DocumentCandidate): CapsuleV2Item {
  const source = document.excerpts.map((excerpt) => (
    `Lines ${excerpt.startLine}-${excerpt.endLine}${excerpt.keyPath === undefined ? "" : ` [${excerpt.keyPath}]`}:\n${excerpt.text}`
  )).join("\n\n");
  const item: CapsuleV2Item = {
    role: "support",
    role_reason: `${document.kind.toUpperCase()} configuration matches task objectives`,
    ...NO_DEBUG_ROLE_SIGNALS,
    path: document.path,
    fq_name: `${document.path}#document`,
    symbol: document.path.split("/").at(-1) ?? document.path,
    kind: `${document.kind}_document`,
    content_mode: CapsuleV2ContentMode.DocumentExcerpt,
    source,
    evidence: [
      `document FTS matches: ${document.matchedTerms.join(", ")}`,
      ...document.objectiveMatches.map((objective) => `objective match: ${objective}`),
      ...document.pathMatches.map((match) =>
        `path clue \`${match.normalizedClue}\`: ${match.matchType} (+${match.score.toFixed(2)})`),
    ],
    scorecard: {
      lexical: Math.min(1, document.score),
      symbol: 0,
      path: document.pathMatches[0]?.score ?? 0,
      test_to_impl: 0,
      body_literal: 0,
      graph_proximity: 0,
      centrality: 0,
      actionability: 0,
      hub_penalty: 0,
      direct_answer: 0,
      mechanism_evidence: 0,
      final: document.score,
    },
    estimated_tokens: 0,
    document_kind: document.kind,
    line_spans: document.excerpts.map((excerpt) => ({ start: excerpt.startLine, end: excerpt.endLine })),
    path_clue_matches: document.pathMatches.map((match) => ({
      clue: match.clue,
      normalized_clue: match.normalizedClue,
      match_type: match.matchType,
      score: match.score,
      subtree_match: match.subtreeMatch,
      filename_match: match.filenameMatch,
    })),
  };
  item.estimated_tokens = estimateTokens(itemBlockText(item));
  return item;
}

// --- source/signature loading -------------------------------------------------

function loadFocusedSource(db: Database, repoRoot: string, candidate: HybridCandidate): string | undefined {
  return loadFocusedSourceById(db, repoRoot, candidate.symbolId);
}

function loadFocusedSourceById(db: Database, repoRoot: string, symbolId: string): string | undefined {
  const result = loadSymbolSource(db, repoRoot, symbolId);
  const extracted = extractFullSymbolSource(result);
  return extracted.status === ExtractSymbolSourceStatus.Extracted ? extracted.source : undefined;
}

// Merge backfilled production candidates AHEAD of the original pool, deduped by
// symbol id and capped — so the recovered edit targets are never crowded out
// again by the test symbols that dominated the first pass.
function mergeCandidatesPreferring(
  preferred: readonly HybridCandidate[],
  rest: readonly HybridCandidate[],
  limit: number,
): HybridCandidate[] {
  const out: HybridCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of [...preferred, ...rest]) {
    if (seen.has(candidate.symbolId)) {
      continue;
    }
    seen.add(candidate.symbolId);
    out.push(candidate);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

function loadSignature(db: Database, repoRoot: string, candidate: HybridCandidate): string | undefined {
  const result = loadSymbolSource(db, repoRoot, candidate.symbolId);
  return result.symbol?.signature;
}

// --- evidence shaping ---------------------------------------------------------

// A pivot leads with the role reason (the decisive reason it is an edit target —
// for debug intent this is the caller-vs-helper-vs-infra decision), then the
// candidate's own evidence lines, deduped and capped.
function pivotEvidence(entry: RefinedRoledCandidate): string[] {
  return dedupe([entry.roleReason, ...entry.candidate.evidence]).slice(0, MAX_PIVOT_EVIDENCE);
}

function supportEvidence(entry: RefinedRoledCandidate): string[] {
  return dedupe([entry.roleReason, ...entry.candidate.evidence]).slice(0, MAX_PIVOT_EVIDENCE);
}

// --- helpers ------------------------------------------------------------------

function toDiscarded(entry: RefinedRoledCandidate, reason: string): CapsuleV2Discarded {
  return {
    path: entry.candidate.filePath,
    symbol: entry.candidate.localName,
    kind: entry.candidate.kind,
    is_entry_point: entry.signals.is_entry_point,
    is_implementation_helper: entry.signals.is_implementation_helper,
    is_generic_infrastructure: entry.signals.is_generic_infrastructure,
    is_class_method_expansion_target: entry.signals.is_class_method_expansion_target,
    is_containing_class_context: entry.signals.is_containing_class_context,
    is_query_builder_entrypoint: entry.signals.is_query_builder_entrypoint,
    is_sql_rendering_implementation: entry.signals.is_sql_rendering_implementation,
    scorecard: toScorecard(entry.candidate.scores),
    evidence: [...entry.candidate.evidence],
    discard_reason: reason,
    ...nonSourceFields(entry),
  };
}

interface NoContextInput {
  intent: ResolvedCapsuleIntent;
  plan: IntentPlan;
  maxTokens: number;
  candidateCount: number;
  supportCount: number;
  discarded: CapsuleV2Discarded[];
  weights: Record<string, number>;
  shaped: ShapedSweQuery;
  localizationSignals: LocalizationSignals;
  explanations: NoContextExplanation[];
  debugDiagnostics: Partial<CapsuleV2Result["diagnostics"]>;
  compoundTaskRescueUsed: boolean;
  documentIntegrationProfile?: DocumentIntegrationProfile;
}

function noContextResult(input: NoContextInput): CapsuleV2Result {
  return {
    intent: input.intent,
    actual_mode: CapsuleV2Mode.NoContext,
    reason: "no high-confidence edit target recovered",
    budget: { max_tokens: input.maxTokens, estimated_tokens: 0, used_percent: 0 },
    pivots: [],
    support: [],
    discarded: input.discarded,
    diagnostics: {
      intent_reason: input.plan.intent_reason,
      intent_confidence: input.plan.intent_confidence,
      strategy: input.plan.strategy,
      candidate_count: input.candidateCount,
      ...(input.compoundTaskRescueUsed ? { compound_task_rescue_used: true } : {}),
      pivot_count: 0,
      support_count: 0,
      discarded_count: input.discarded.length,
      tier: CapsuleV2Mode.NoContext,
      weights: input.weights,
      likely_files: input.shaped.likelyFiles,
      likely_symbols: input.shaped.likelySymbols,
      failing_tests: input.shaped.failingTests,
      ...filteredSignalDiagnostics(input.shaped),
      ...querySemanticsDiagnostics(input.shaped),
      ...lexicalScoringDiagnostics(input.shaped.query),
      ...input.debugDiagnostics,
      ...(input.documentIntegrationProfile === undefined
        ? {}
        : { document_integration_profile: input.documentIntegrationProfile }),
      localization_signals: input.localizationSignals,
      ...(input.explanations.length > 0 ? { no_context_explanations: input.explanations } : {}),
    },
  };
}

// Noise the query shaper dropped from the high-confidence signals, surfaced as
// diagnostics so a filtered generic token / runner script is auditable. Present
// only when something was filtered (keeps the diagnostics surface quiet otherwise).
function filteredSignalDiagnostics(shaped: ShapedSweQuery): Partial<CapsuleV2Result["diagnostics"]> {
  return {
    ...(shaped.filteredGenericSymbols.length > 0
      ? { filtered_generic_symbols: shaped.filteredGenericSymbols }
      : {}),
    ...(shaped.filteredRunnerFiles.length > 0
      ? { filtered_runner_files: shaped.filteredRunnerFiles }
      : {}),
  };
}

function querySemanticsDiagnostics(shaped: ShapedSweQuery): Partial<CapsuleV2Result["diagnostics"]> {
  const intent = shaped.derivedIntent;
  if (intent === undefined || (intent.kind === "general"
    && intent.contrastClauses.length === 0
    && intent.weakLiteralTokens.length === 0
    && intent.projectReferences.length === 0)) {
    return {};
  }
  return {
    query_semantics: {
      intent: intent.kind,
      ...(intent.intentReason === undefined ? {} : { intent_reason: intent.intentReason }),
      positive_terms: intent.positiveTerms.slice(0, 16),
      contrast_terms: intent.contrastTerms.slice(0, 16),
      contrast_phrases: intent.contrastPhrases.slice(0, 6),
      explicit_identifiers: intent.explicitIdentifiers.slice(0, 12),
      comparison_identifiers: intent.comparisonIdentifiers.slice(0, 12),
      weak_literal_tokens: intent.weakLiteralTokens.slice(0, 12),
      symbol_hypotheses: intent.symbolHypotheses.slice(0, 12).map((signal) => ({
        text: signal.term,
        confidence: signal.confidence,
        source: signal.source,
      })),
      project_references: intent.projectReferences.slice(0, 6),
    },
  };
}

// Body-literal recovery diagnostics: which distinctive task literals (diagnostic
// codes / messages) were found in a symbol's source body and pulled it into the
// pool. Present only when at least one literal matched.
function bodyLiteralDiagnostics(
  matches: readonly BodyLiteralMatch[],
): Partial<CapsuleV2Result["diagnostics"]> {
  if (matches.length === 0) {
    return {};
  }
  return {
    body_literal_search_used: true,
    body_literal_matches: matches.map((match) => ({
      literal: match.literal,
      path: match.path,
      symbol: match.symbol,
    })),
  };
}

// Generic-token lexical-scoring decomposition of the retrieval query, surfaced so
// the down-weighting policy is auditable. Present only when the query carried a
// generic token (otherwise nothing was eligible for down-weighting).
function lexicalScoringDiagnostics(query: string): Partial<CapsuleV2Result["diagnostics"]> {
  const tokens = classifyLexicalQueryTokens(query);
  if (tokens.generic.size === 0) {
    return {};
  }
  return {
    downweighted_lexical_tokens: [...tokens.generic],
    lexical_meaningful_token_count: tokens.meaningful.size,
    lexical_generic_token_count: tokens.generic.size,
    // Exception-symptom nouns de-anchored from meaningful ranking (G1). Present
    // only when at least one exception name contributed a de-anchored noun.
    ...(tokens.deanchored.size > 0
      ? { deanchored_exception_tokens: [...tokens.deanchored] }
      : {}),
  };
}

// Symbol seeds beyond the shaped likely-symbols: the SUBJECT of each failing
// test class (AggregateTestCase -> Aggregate), which usually names the
// implementation directly, plus the issue identifiers that are not test names.
function deriveSymbolSeeds(shaped: ShapedSweQuery): string[] {
  const seeds: string[] = [];
  for (const identifier of shaped.identifiers) {
    if (/Test/.test(identifier) && /^[A-Z]/.test(identifier)) {
      const subject = identifier.replace(/^Test(?=[A-Z])/, "").replace(/(?:TestCase|Tests|Test)$/, "");
      if (subject.length >= 3) {
        seeds.push(subject);
      }
    } else if (!/^test[_A-Z]/.test(identifier)) {
      seeds.push(identifier);
    }
  }
  return dedupe(seeds);
}

// Extract failing-test node ids from free task prose so `shapeSweQuery` can route
// the failing test to its implementation. Recognises pytest ("a/b/test_x.py::
// TestY::test_z") and Django dotted ("a.b.TestY.test_z") shapes.
function extractFailingTests(task: string): string[] {
  const ids = new Set<string>();
  for (const match of task.matchAll(/\b[\w./-]+\.py::[\w:]+/g)) {
    ids.add(match[0]);
  }
  for (const match of task.matchAll(/\b[\w.]+\.[A-Z]\w*\.test_\w+\b/g)) {
    ids.add(match[0]);
  }
  return [...ids];
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
