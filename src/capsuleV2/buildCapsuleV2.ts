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
  hybridRetrieve,
  type BodyLiteralMatch,
  type HybridCandidate,
} from "../retrieval/hybridRetrieval";
import {
  classifyLexicalQueryTokens,
  recomputeWithWeakenedLexical,
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
import { detectActionabilityHints } from "./actionabilityHints";
import {
  detectMultiFileCoeditHints,
  type CoeditCandidateItem,
} from "./multiFileCoeditHints";
import { detectLocalizationSignals, type LocalizationSignals } from "./localizationSignals";
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

export function buildCapsuleV2(input: BuildCapsuleV2Input): CapsuleV2Result {
  const shaped = shapeSweQuery({
    problemStatement: input.task,
    failToPass: extractFailingTests(input.task),
  });
  // Intent planner: detect intent + select the strategy (generators, role policy,
  // budget). The strategy's `role_policy` is the real lever — `debug_refinement`
  // runs the caller/helper/infra refinement + production backfill; the others use
  // the base role gate. test-failure shares the debug strategy.
  // How strongly the issue text alone already localizes the edit site (resolved
  // against this repo's index). Independent of retrieval scoring; consumed by the
  // cost-aware context policy to skip injection for already-localized tasks. Always
  // computed so the diagnostic is present on both the inject and no_context paths.
  const localizationSignals = detectLocalizationSignals(input.db, input.task);
  const plan = planIntent(input.intent, input.task, shaped);
  const intent = plan.intent;
  const weights = plan.weights;
  const debugRefinement = plan.strategy.role_policy === "debug_refinement";
  // A plain numeric record for the diagnostics surface (HybridScoreWeights has
  // fixed keys, so it is not directly a Record<string, number>).
  const weightsRecord: Record<string, number> = Object.fromEntries(Object.entries(weights));
  const allocation = allocateBudget(input.maxTokens);

  const symbolSeeds = deriveSymbolSeeds(shaped);
  const retrieval = hybridRetrieve(input.db, {
    query: shaped.query,
    shaped,
    // Raw task prose for body-literal extraction: the shaped query may drop a
    // diagnostic literal that the body-literal search needs.
    taskText: input.task,
    weights,
    symbolSeeds,
    maxResults: CANDIDATE_POOL_SIZE,
  });
  let candidates = retrieval.candidates;
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
  // Inject ONLY the title symbols not already in the pool — a synthesized
  // title-symbol candidate is thin (no test-to-impl/graph evidence), so it must
  // never replace a richer existing candidate for the same symbol. Symbols already
  // present keep their candidate and merely gain title precedence below.
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
  const literalAnchors: LiteralAnchorResult = anchorLiterals({ db: input.db, task: input.task });
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
  const directEvidence: DirectEvidenceResult = anchorDirectEvidence({ db: input.db, task: input.task });
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
    usedTokens += item.estimated_tokens;
    pivots.push(item);
  });

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
  });
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
    usedTokens += item.estimated_tokens;
    renderedSupportIds.add(entry.candidate.symbolId);
    support.push(item);
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
      pivot_count: pivots.length,
      support_count: support.length,
      discarded_count: discarded.length,
      tier: allocation.tier,
      weights: weightsRecord,
      likely_files: shaped.likelyFiles,
      likely_symbols: shaped.likelySymbols,
      failing_tests: shaped.failingTests,
      ...filteredSignalDiagnostics(shaped),
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
      ...(editRiskDirectives.length > 0 ? { edit_risk_directives: editRiskDirectives } : {}),
      localization_signals: localizationSignals,
    },
    ...(actionabilityHints.length > 0 ? { actionability_hints: actionabilityHints } : {}),
  };
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

// Support ordering tier: implementation helpers (edit sites that only missed the
// pivot budget) rank above ordinary support, which ranks above generic
// infrastructure. Lower number = higher priority.
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
      final: doc.score,
    },
    estimated_tokens: 0,
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
      pivot_count: 0,
      support_count: 0,
      discarded_count: input.discarded.length,
      tier: CapsuleV2Mode.NoContext,
      weights: input.weights,
      likely_files: input.shaped.likelyFiles,
      likely_symbols: input.shaped.likelySymbols,
      failing_tests: input.shaped.failingTests,
      ...filteredSignalDiagnostics(input.shaped),
      ...lexicalScoringDiagnostics(input.shaped.query),
      ...input.debugDiagnostics,
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
