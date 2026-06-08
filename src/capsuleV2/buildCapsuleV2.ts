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
  classifyGenericLexicalDecoy,
  collectQueryTokens,
  taskNamesCandidatePath,
  GENERIC_LEXICAL_DECOY_FACTOR,
  type GenericLexicalDecoy,
} from "./genericLexicalDecoy";
import { itemBlockText } from "./renderItem";
import { estimateTokens, roundPercent } from "./tokens";
import {
  CapsuleIntent,
  CapsuleV2ContentMode,
  CapsuleV2Mode,
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
  const plan = planIntent(input.intent, input.task, shaped);
  const intent = plan.intent;
  const weights = plan.weights;
  const debugRefinement = plan.strategy.role_policy === "debug_refinement";
  // A plain numeric record for the diagnostics surface (HybridScoreWeights has
  // fixed keys, so it is not directly a Record<string, number>).
  const weightsRecord: Record<string, number> = Object.fromEntries(Object.entries(weights));
  const allocation = allocateBudget(input.maxTokens);

  const retrieval = hybridRetrieve(input.db, {
    query: shaped.query,
    shaped,
    // Raw task prose for body-literal extraction: the shaped query may drop a
    // diagnostic literal that the body-literal search needs.
    taskText: input.task,
    weights,
    symbolSeeds: deriveSymbolSeeds(shaped),
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

  // Role assignment. The base gate scores each candidate in isolation; for debug
  // intent we then refine roles with call-graph structure (caller vs helper,
  // local vs generic infrastructure) before capping pivots to the tier. Other
  // intents keep the base gate's own cap. Centrality never produces a pivot.
  let refined: RefinedRoledCandidate[];
  let subsystemRoot: string | undefined;
  let sourceBodyCallFallbackUsed = false;
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
      },
    );
    refined = result.refined;
    subsystemRoot = result.subsystemRoot;
    sourceBodyCallFallbackUsed = result.sourceBodyCallFallbackUsed;
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
  ) {
    const anchorRank = (entry: RefinedRoledCandidate): number =>
      anchorSymbolIds.has(entry.candidate.symbolId) ? 1 : 0;
    const renderingRank = (entry: RefinedRoledCandidate): number =>
      sqlRenderingTrigger.active
        ? sqlRenderingRelevance(entry.candidate.localName, sqlRenderingTrigger.compositionTerms)
        : 0;
    // Direct-evidence tier: body-literal (3) > title-symbol / high-signal literal
    // anchor (2) > normal (1). Title-symbol and literal anchors share tier 2 — an
    // exact title-name and an exact high-signal-literal hit are comparable evidence.
    const evidenceTier = (entry: RefinedRoledCandidate): number => {
      if (entry.candidate.scores.bodyLiteral > 0) return 3;
      if (titleSymbolIds.has(entry.candidate.symbolId) || literalAnchorIds.has(entry.candidate.symbolId)) return 2;
      return 1;
    };
    pivotCandidates.sort(
      (left, right) =>
        anchorRank(right) - anchorRank(left)
        || renderingRank(right) - renderingRank(left)
        || evidenceTier(right) - evidenceTier(left)
        || right.candidate.scores.final - left.candidate.scores.final
        || left.candidate.fqName.localeCompare(right.candidate.fqName)
        || left.candidate.symbolId.localeCompare(right.candidate.symbolId),
    );
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
      explanations: buildNoContextExplanations(refined, shaped),
      debugDiagnostics: {
        ...debugDiagnostics,
        ...lineAnchorDiagnostics,
        ...bodyLiteralDiagnostics(bodyLiteralMatches),
        ...nonSourceDiagnostics,
        ...titleSymbolDiagnostics,
        ...literalAnchorDiagnostics,
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
    usedTokens += item.estimated_tokens;
    pivots.push(item);
  });

  // Order support so the most edit-relevant context wins scarce support slots:
  // cap-demoted implementation helpers first, then ordinary local support, and
  // generic infrastructure last — a generic parser class must never outrank a
  // local helper (Problem B). Within a tier, higher final score wins. For
  // non-debug intents every signal is false, so this reduces to final order.
  const orderedSupport = [...supportCandidates].sort(
    (left, right) =>
      supportTier(left) - supportTier(right)
      || right.candidate.scores.final - left.candidate.scores.final,
  );

  for (const entry of orderedSupport) {
    if (support.length >= allocation.maxSupport) {
      discarded.push(toDiscarded(entry, `beyond ${allocation.tier} support budget (max ${allocation.maxSupport})`));
      continue;
    }
    const item = renderSupport(input.db, input.repoRoot, entry, input.maxTokens - usedTokens);
    if (item === undefined) {
      discarded.push(toDiscarded(entry, "over budget: no room for this support item"));
      continue;
    }
    usedTokens += item.estimated_tokens;
    support.push(item);
  }

  // Documentation candidate source: query-relevant markdown sections fill any
  // remaining SUPPORT budget as summaries (never pivots — docs are not edit
  // targets). Code support takes priority, so docs are added last.
  if (support.length < allocation.maxSupport) {
    const docs = retrieveDocSections(input.repoRoot, shaped.query, allocation.maxSupport - support.length);
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
      ...lineAnchorDiagnostics,
      ...nonSourceDiagnostics,
      ...titleSymbolDiagnostics,
      ...literalAnchorDiagnostics,
      ...genericLexicalDecoyDiagnostics,
      ...(editRiskDirectives.length > 0 ? { edit_risk_directives: editRiskDirectives } : {}),
    },
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
