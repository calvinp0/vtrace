import { estimateTokens } from "../capsuleV2/tokens";
import type { ContextAccounting } from "../metrics/contextAccounting";
import type {
  ImpactEdge,
  ImpactGraphOutput,
  ImpactNode,
} from "./getImpactGraph";
import type { CallerCoverage } from "./callerCoverage";
import { finalizeImpactContinuation } from "./impactContinuation";
import type { StaticRelationEvidence } from "./staticEvidence";

export const IMPACT_RESPONSE_ENVELOPE_VERSION = "vtrace.impact_response_envelope/1" as const;
// Empirically, the stable root/provenance/accounting schema costs ~700 tokens.
// Six ARC caller sites still fit at or below 2,000 total tokens / 8,000 chars.
export const IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS = 800;
export const IMPACT_HARD_SERIALIZED_CHARACTER_CEILING = 80_000;

export interface ImpactResponseBudget {
  readonly envelopeVersion: typeof IMPACT_RESPONSE_ENVELOPE_VERSION;
  readonly requestedMaxTokens: number;
  readonly modelVisibleEstimatedTokens: number;
  readonly metadataEstimatedTokens: number;
  readonly estimatedTotalTokens: number;
  readonly totalCeiling: number;
  readonly serializedCharacters: number;
  readonly withinEnvelope: true;
  readonly compactionApplied: boolean;
  readonly compactedFields: readonly string[];
  readonly requestedMaxEdges: number;
  readonly retainedEdges: number;
  readonly omittedEdges: number;
  readonly resultState: "complete" | "bounded_truncated" | "response_compacted";
  readonly estimateMethod: "chars_div_4";
}

export type ImpactProductResponse = ImpactGraphOutput & {
  readonly accounting?: ContextAccounting | { readonly latencyMs: number; readonly ref: string };
  readonly responseBudget: ImpactResponseBudget;
};

type MutableImpactResponse = {
  -readonly [Key in keyof ImpactGraphOutput]: ImpactGraphOutput[Key];
} & { accounting?: ContextAccounting | { latencyMs: number; ref: string }; responseBudget?: ImpactResponseBudget };

/**
 * Restate caller coverage for what the response actually carries. The discovered
 * totals are preserved (an agent still learns how many sites exist); only the
 * delivered/omitted split moves. Status is clamped away from `complete` because
 * dropping evidence for budget can never increase certainty.
 */
function withDeliveredCallerCounts(
  coverage: CallerCoverage,
  deliveredPotentialCallers: number,
): CallerCoverage {
  const omitted = Math.max(0, coverage.potentialCallerCount - deliveredPotentialCallers);
  return {
    ...coverage,
    status: coverage.status === "complete" && omitted > 0 ? "incomplete" : coverage.status,
    deliveredPotentialCallerCount: deliveredPotentialCallers,
    potentialCallersOmitted: omitted,
    reasonCodes: omitted > coverage.potentialCallersOmitted
      ? [...new Set([...coverage.reasonCodes, "callsite_candidates_omitted" as const])].sort()
      : coverage.reasonCodes,
    notes: omitted > 0
      ? [
        "caller coverage incomplete; additional unresolved call sites omitted for response budget",
        ...coverage.notes,
      ]
      : coverage.notes,
  };
}

export function impactResponseTokenCeiling(requestedMaxTokens: number): number {
  const requested = Math.max(1, Math.floor(requestedMaxTokens));
  return requested + Math.max(
    IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS,
    Math.ceil(requested * 0.15),
  );
}

/**
 * THE HARD DELIVERY CONSTRAINT: may this response be returned at all?
 *
 * The complete serialized response against `max_tokens` plus the documented
 * metadata allowance — the bound `get_impact_graph`'s schema publishes as "the
 * complete response adds max(800, 15%) metadata tokens and is checked after all
 * fields are attached". Failing it is the ONLY reason a well-formed impact result
 * may be withheld, and the failure is a truthful bounded decline, never a throw.
 *
 * The character term is a backstop that cannot currently fire: `totalCeiling` is
 * clamped to `IMPACT_HARD_SERIALIZED_CHARACTER_CEILING / 4`, so satisfying the
 * token term already bounds the response at 80,000 characters. M178-A proved the
 * implication over every budget the tool accepts (1..20,000, zero
 * counterexamples). It is kept, and pinned by a test, because it is what makes
 * the clamp's job explicit rather than incidental.
 */
export function impactResponseFitsEnvelope(budget: ImpactResponseBudget): boolean {
  return budget.estimatedTotalTokens <= budget.totalCeiling
    && budget.serializedCharacters <= IMPACT_HARD_SERIALIZED_CHARACTER_CEILING;
}

/**
 * THE COMPACTION TARGET: should the ladder keep shedding evidence?
 *
 * The five evidence keys against the caller's `max_tokens` — the bound the schema
 * publishes as "max_tokens bounds model-facing impact content". This is what the
 * degradation ladder is FOR, and it is deliberately NOT a delivery gate.
 *
 * WHY IT IS A TARGET AND NOT A GATE, since M177 recorded the difference as a
 * mismatch and a later reader will be tempted to "fix" it. The ladder has a floor
 * — one relation, one edge — below which the only remaining move is to deliver
 * nothing. Promoting this to a delivery gate would convert exactly those calls
 * into declines: M178-B measured 564 of them across the frozen corpus, costing 25
 * delivered edges, every one to reclaim at most 41 tokens. Worse, that excess is
 * not evidence overspending its budget at all — it is the SURPLUS METADATA
 * ALLOWANCE. The window in which a delivered response exceeds `max_tokens` has
 * width exactly `IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS - metadataTokens`: the
 * flat 800-token grant minus what this specimen's unshrinkable metadata actually
 * costs. When metadata comes in under its allowance, the slack is spent on
 * evidence rather than wasted — which is the allowance working, not leaking.
 *
 * ZERO of the 60 corpus symbols reach that window at the default budget, in
 * either the envelope-isolated or the engine-coupled view.
 */
export function impactResponseMeetsEvidenceBudget(budget: ImpactResponseBudget): boolean {
  return budget.modelVisibleEstimatedTokens <= budget.requestedMaxTokens;
}

/**
 * Final model-facing gate for get_impact_graph. The traversal may inspect more
 * evidence, but every compatibility projection is rebuilt from one retained set
 * of persisted edge ids before the complete serialized object is measured.
 */
export function compactImpactProductResponse(
  output: ImpactGraphOutput & { readonly accounting?: ContextAccounting },
): ImpactProductResponse {
  const draft = structuredClone(output) as MutableImpactResponse;
  // Responses assembled outside the engine (fixtures, older callers) may predate
  // the M139 caller-coverage fields. Treat them as absent rather than assuming
  // them; nothing below may invent a coverage claim that was never measured.
  if (draft.potentialCallers === undefined) draft.potentialCallers = [];
  const compacted = new Set<string>();
  const requestedMaxEdges = Math.max(1, draft.limits.maxEdges);
  const requestedMaxTokens = Math.max(1, draft.limits.maxTokens);
  const totalCeiling = Math.min(
    impactResponseTokenCeiling(requestedMaxTokens),
    Math.floor(IMPACT_HARD_SERIALIZED_CHARACTER_CEILING / 4),
  );
  const originalUniqueEdges = uniqueDeliveredEdgeCount(draft);

  // Canonical selection: direct evidence first (already evidence-ranked), then
  // legacy reverse edges as compatibility projections. No DB/iteration order is
  // consulted here.
  const selectedIds = new Set<string>();
  const selectedSyntheticIds = new Set<string>();
  const selectedRelations: StaticRelationEvidence[] = [];
  for (const relation of draft.directRelations) {
    if (selectedIds.size + selectedSyntheticIds.size >= requestedMaxEdges) break;
    const key = relation.edgeId ?? relation.id;
    const target = relation.edgeId === null ? selectedSyntheticIds : selectedIds;
    if (target.has(key)) continue;
    target.add(key);
    selectedRelations.push(compactRelation(relation));
  }
  const selectedEdges: ImpactEdge[] = [];
  for (const edge of draft.edges) {
    if (!selectedIds.has(edge.edgeId) && selectedIds.size + selectedSyntheticIds.size >= requestedMaxEdges) continue;
    selectedIds.add(edge.edgeId);
    selectedEdges.push(edge);
  }
  const projectedIds = new Set(selectedEdges.map((edge) => edge.edgeId));
  for (const relation of selectedRelations) {
    if (relation.edgeId === null
      || relation.persistedKind === null
      || projectedIds.has(relation.edgeId)
      || relation.source.nodeId === undefined
      || relation.target.nodeId === undefined
      || relation.source.symbol === undefined
      || relation.target.symbol === undefined) continue;
    selectedEdges.push({
      edgeId: relation.edgeId,
      edgeType: relation.persistedKind,
      fromSymbolId: relation.source.nodeId,
      fromFqName: relation.source.symbol,
      toSymbolId: relation.target.nodeId,
      toFqName: relation.target.symbol,
    });
    projectedIds.add(relation.edgeId);
  }
  draft.directRelations = selectedRelations;
  draft.edges = selectedEdges.filter((edge) => selectedIds.has(edge.edgeId));
  compacted.add("directRelations[].evidence");

  rebuildCanonicalNodeAndViewProjections(draft, compacted);

  // Paths repeat complete edge and node objects. Keep only paths wholly backed
  // by the retained graph, then remove them first if the response is tight.
  const boundedPaths = draft.paths
    .filter((path) => path.length <= draft.limits.maxDepth)
    .filter((path) => path.edges.every((edge) => {
      const key = edge.edgeId ?? edge.id;
      return edge.edgeId === null ? selectedSyntheticIds.has(key) : selectedIds.has(key);
    }))
    .slice(0, draft.limits.maxPaths);
  if (boundedPaths.length < draft.paths.length) compacted.add("paths");
  draft.paths = boundedPaths;

  // Static coverage prose is declared by the tool schema and need not consume
  // the small per-call envelope repeatedly.
  if (draft.coverage.notes.length > 2) {
    draft.coverage = { ...draft.coverage, notes: draft.coverage.notes.slice(0, 2) };
    compacted.add("coverage.notes");
  }
  // Coverage prose restates what `status` and `reasonCodes` already say
  // machine-readably. Keep the first line only; the machine-readable state is
  // never compacted away.
  if (draft.callerCoverage !== undefined && draft.callerCoverage.notes.length > 1) {
    draft.callerCoverage = {
      ...draft.callerCoverage,
      notes: draft.callerCoverage.notes.slice(0, 1),
    };
    compacted.add("callerCoverage.notes");
  }
  if (draft.accounting !== undefined
    && "estimatedOutputTokens" in draft.accounting
    && draft.accounting.skippedFiles !== undefined
    && draft.accounting.skippedFiles.length > 3) {
    draft.accounting = { ...draft.accounting, skippedFiles: draft.accounting.skippedFiles.slice(0, 3) };
    compacted.add("accounting.skippedFiles");
  }

  /**
   * The ladder's gate: keep compacting while EITHER contract is unsatisfied.
   *
   * Both predicates belong here and they answer different questions —
   * `impactResponseFitsEnvelope` decides whether the response may be returned,
   * `impactResponseMeetsEvidenceBudget` decides whether it is as small as the
   * caller asked for. Only the first governs the terminal below. Naming them
   * apart is M178's whole change: the single ambiguous `fits()` that used to sit
   * here read as though the terminal was failing to enforce one of its own
   * conditions, when in fact the two were never the same contract.
   */
  const ladderSatisfied = (): boolean => {
    const accounting = buildBudget(draft, {
      requestedMaxTokens,
      totalCeiling,
      requestedMaxEdges,
      originalUniqueEdges,
      compacted,
    });
    return impactResponseFitsEnvelope(accounting) && impactResponseMeetsEvidenceBudget(accounting);
  };

  if (!ladderSatisfied() && draft.paths.length > 0) {
    draft.paths = [];
    compacted.add("paths");
  }
  if (!ladderSatisfied() && (draft.affectedFiles.length + draft.entrypoints.length + draft.tests.length) > 0) {
    draft.affectedFiles = [];
    draft.entrypoints = [];
    draft.tests = [];
    compacted.add("affectedFiles/entrypoints/tests");
  }
  if (!ladderSatisfied() && draft.diagnostics.limitations.length > 1) {
    draft.diagnostics = { ...draft.diagnostics, limitations: draft.diagnostics.limitations.slice(0, 1) };
    compacted.add("diagnostics.limitations");
  }
  if (!ladderSatisfied() && draft.coverage.notes.length > 1) {
    draft.coverage = { ...draft.coverage, notes: draft.coverage.notes.slice(0, 1) };
    compacted.add("coverage.notes");
  }
  if (!ladderSatisfied() && draft.accounting !== undefined && "estimatedOutputTokens" in draft.accounting) {
    draft.accounting = {
      latencyMs: draft.accounting.latencyMs,
      ref: "responseBudget",
    };
    compacted.add("accounting");
  }

  // Prefer compact direct caller/reference evidence over lower-value transitive
  // compatibility edges. This is what keeps all known ARC call sites visible
  // under max_edges:10 without spending the envelope on unrelated depth-2 rows.
  if (!ladderSatisfied() && draft.directRelations.length > 0) {
    const directEdgeIds = new Set(
      draft.directRelations.flatMap((relation) => relation.edgeId === null ? [] : [relation.edgeId]),
    );
    const directEdges = draft.edges.filter((edge) => directEdgeIds.has(edge.edgeId));
    if (directEdges.length < draft.edges.length) {
      draft.edges = directEdges;
      rebuildCanonicalNodeAndViewProjections(draft, compacted);
      compacted.add("transitiveCompatibilityEdges");
    }
  }

  /**
   * THE GRAPH RESTATEMENT NOW HAS A RUNG (M211 §20), and it is above the
   * evidence rather than below them.
   *
   * M210 measured this as the ladder's remaining structural fault: `nodes`,
   * `edges` and `view` were only ever trimmed at the very END, after the
   * evidence had already been demoted and cut to one relation. The result on
   * the ARC corpus was a default response spending 3 167 characters restating a
   * 3-edge projection while its one delivered relation had lost its source line
   * — and, worse, the reduced evidence never bought anything, because the
   * restatement it was reduced to make room for was still there.
   *
   * The reason it may yield first is new. `edges` is a compatibility projection
   * of relations this response already carries in full, and until M211 it was
   * also the only place the response admitted the graph was larger than the
   * render. `impactCensus` now states that truthfully in ~600 characters, so
   * dropping edge rows costs the reader a duplicate rather than a fact. Each
   * dropped row stays counted in `responseBudget.omittedEdges`.
   *
   * Bounded below by one: an impact response that retains a relation but no edge
   * at all would contradict its own compatibility contract.
   */
  if (!ladderSatisfied() && draft.edges.length > 1) {
    const projected = draft.edges;
    const baseNodes = draft.nodes;
    const baseView = draft.view;
    const baseDependentFiles = draft.dependentFiles;
    let low = 1;
    let high = projected.length;
    let best = 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      draft.nodes = baseNodes;
      draft.view = baseView;
      draft.dependentFiles = baseDependentFiles;
      draft.edges = projected.slice(0, middle);
      rebuildCanonicalNodeAndViewProjections(draft, compacted);
      if (ladderSatisfied()) { best = middle; low = middle + 1; } else { high = middle - 1; }
    }
    draft.nodes = baseNodes;
    draft.view = baseView;
    draft.dependentFiles = baseDependentFiles;
    draft.edges = projected.slice(0, best);
    rebuildCanonicalNodeAndViewProjections(draft, compacted);
    if (best < projected.length) compacted.add("canonicalEdges");
  }
  // Potential callers are unproven evidence, so they yield before proven
  // relations — but only after the low-value transitive support above, and
  // strictly worst-confidence first. Whatever is dropped stays visible as a
  // count, and the coverage status can only get less complete, never more:
  // compaction must not be able to turn "we could not tell" into "there are
  // none".
  // Shed the explanation before the evidence: a bare `file:line receiver` still
  // tells an agent where to look, whereas dropping the site hides it entirely.
  if (!ladderSatisfied() && draft.potentialCallers.some((caller) => caller.sourceText !== undefined)) {
    draft.potentialCallers = draft.potentialCallers.map((caller) => ({
      filePath: caller.filePath,
      line: caller.line,
      column: caller.column,
      receiverExpression: caller.receiverExpression,
      enclosingSymbol: caller.enclosingSymbol,
      confidence: caller.confidence,
      evidenceKind: caller.evidenceKind,
    }));
    compacted.add("potentialCallers[].compactProjection");
  }

  /**
   * GRADUATED RELATION DEGRADATION (M211 §21), replacing a cliff.
   *
   * Until M211 this was two rungs: demote EVERY relation to `minimalRelation`,
   * then pop the tail one at a time. The first step is what M210 measured as the
   * cliff — one rung earlier the response carries a rendered source line on
   * every relation, and one rung later on none of them, because the demotion was
   * global. On the ARC corpus that left the default response delivering a single
   * relation with no source line while a truthful 869 callers existed.
   *
   * The replacement reaches a strictly better response for the same budget and
   * cannot reach a worse one. It solves for the shape
   *
   *     relations[0, a)  full compact form, source line intact
   *     relations[a, b)  minimal form, relationship + provenance only
   *     relations[b, n)  not rendered — counted by `impactCensus`
   *
   * maximising `b` FIRST and only then `a`. Maximising `b` first is what makes
   * this a Pareto improvement: `b` is exactly the count the old cliff-then-trim
   * pair converged to, so no relation that used to be delivered is lost, and the
   * head relations recover the source line they used to have taken from them.
   *
   * Both searches are binary rather than linear because `fits(k)` is monotone in
   * `k` — a longer prefix, or a richer prefix, only ever serializes larger. The
   * old tail loop paid one full re-serialization per dropped relation; at the
   * default `max_edges: 64` that is 63 of them against 6 here, which is why this
   * does not cost the latency the graduation would otherwise imply.
   */
  if (!ladderSatisfied() && draft.directRelations.length > 0) {
    const ranked = draft.directRelations;
    // The search probes prefix lengths out of order, and
    // `rebuildCanonicalNodeAndViewProjections` SYNTHESISES a node from a relation
    // endpoint when the node is no longer present — at `distance: 1` and with the
    // endpoint's own kind. Rebuilding from an already-shrunk projection would
    // therefore let a probe that shrinks and a later probe that grows disagree
    // about a node's distance. Every probe restarts from the same base instead,
    // so the shape that is finally applied is the one that was measured.
    const baseNodes = draft.nodes;
    const baseView = draft.view;
    const baseDependentFiles = draft.dependentFiles;
    const applyShape = (full: number, total: number): void => {
      draft.nodes = baseNodes;
      draft.view = baseView;
      draft.dependentFiles = baseDependentFiles;
      draft.directRelations = [
        ...ranked.slice(0, full),
        ...ranked.slice(full, total).map(minimalRelation),
      ];
      rebuildCanonicalNodeAndViewProjections(draft, compacted);
    };
    /** Largest `k` in [0, high] for which `admits(k)` holds, given monotonicity. */
    const largestAdmissible = (high: number, admits: (k: number) => boolean): number => {
      let low = 0;
      let best = 0;
      let ceiling = high;
      while (low <= ceiling) {
        const middle = Math.floor((low + ceiling) / 2);
        if (admits(middle)) { best = middle; low = middle + 1; } else { ceiling = middle - 1; }
      }
      return best;
    };

    // The ladder's floor is one relation, as it has always been: below that the
    // only remaining move is to deliver nothing, and `bounded_degradation` owns
    // that decision. The search may report 0, so the floor is applied here.
    const retained = Math.max(1, largestAdmissible(ranked.length, (count) => {
      applyShape(0, count);
      return ladderSatisfied();
    }));
    const detailed = largestAdmissible(retained, (count) => {
      applyShape(count, retained);
      return ladderSatisfied();
    });
    applyShape(detailed, retained);
    if (detailed < retained) compacted.add("directRelations[].compactProjection");
    if (retained < ranked.length) compacted.add("directRelations");
  }
  if (!ladderSatisfied() && draft.paths.length > 0) {
    draft.paths = [];
    compacted.add("paths");
  }

  // When the question is "who consumes this?" and nothing was proven, the
  // target's own downstream dependencies are the least relevant thing in the
  // response. Spending the last of the envelope on `copy -> as_dict` while
  // discarding candidate call sites inverts the priority the caller asked for.
  if (!ladderSatisfied()
    && draft.callerCoverage !== undefined
    && draft.callerCoverage.exactCallerCount === 0
    && draft.callerCoverage.status !== "complete"
    && draft.potentialCallers.length > 0
    && draft.directRelations.some((relation) => relation.direction === "outgoing")) {
    draft.directRelations = draft.directRelations.filter((relation) => relation.direction !== "outgoing");
    rebuildCanonicalNodeAndViewProjections(draft, compacted);
    compacted.add("outgoingRelationsYieldedToCallerEvidence");
  }

  // Only now, once the proven-relation projections have been reduced as far as
  // they go, do unproven call sites start to yield — worst confidence first.
  // Ordering matters: dropping every candidate to protect a verbose rendering of
  // "the class contains this method" would answer a consumer question with the
  // one relation that is not a consumer.
  for (const tier of ["unresolved", "medium", "high"] as const) {
    if (ladderSatisfied() || draft.potentialCallers.length === 0) break;
    const retained = draft.potentialCallers.filter((caller) => caller.confidence !== tier);
    if (retained.length === draft.potentialCallers.length) continue;
    draft.potentialCallers = retained;
    if (draft.callerCoverage !== undefined) {
      draft.callerCoverage = withDeliveredCallerCounts(draft.callerCoverage, retained.length);
    }
    compacted.add("potentialCallers");
  }

  // The mandatory root and one compact relation are designed to fit even the
  // 400-token supported minimum. This is a valid structured degradation, never
  // substring truncation or invalid JSON.
  if (!ladderSatisfied()) {
    draft.directRelations = draft.directRelations.slice(0, 1).map(minimalRelation);
    draft.paths = [];
    draft.affectedFiles = [];
    draft.entrypoints = [];
    draft.tests = [];
    draft.dependentFiles = [];
    draft.coverage = { ...draft.coverage, notes: [] };
    draft.diagnostics = { ...draft.diagnostics, limitations: [] };
    delete draft.accounting;
    rebuildCanonicalNodeAndViewProjections(draft, compacted);
    compacted.add("bounded_degradation");
  }

  while (!ladderSatisfied() && draft.edges.length > 1) {
    draft.edges = draft.edges.slice(0, -1);
    rebuildCanonicalNodeAndViewProjections(draft, compacted);
    compacted.add("canonicalEdges");
  }

  // THE LADDER IS DONE; the delivered set is final. Reconcile the continuation
  // against it (§22) before the response is measured, so `delivered + remaining
  // == total` describes what the caller receives rather than what the core
  // sliced. The census is deliberately NOT touched: it answers "how much impact
  // exists", which no amount of compaction changes.
  if (draft.continuation !== null && draft.continuation !== undefined) {
    const handle = draft.continuation;
    const finalized = finalizeImpactContinuation(
      handle.ref,
      handle.offset,
      handle.total,
      draft.directRelations.map((relation) => relation.id),
    );
    draft.continuation = finalized === null ? null : {
      ...handle,
      delivered: draft.directRelations.length,
      remaining: finalized.remaining,
      ref: finalized.ref,
    };
    if (finalized !== null && finalized.remaining > handle.remaining) compacted.add("continuation");
  }

  const responseBudget = buildBudget(draft, {
    requestedMaxTokens,
    totalCeiling,
    requestedMaxEdges,
    originalUniqueEdges,
    compacted,
  });
  // THE TERMINAL TESTS THE DELIVERY CONSTRAINT, AND ONLY IT. The evidence budget
  // is a compaction target that the ladder above has already pursued as far as its
  // floor allows; a response that is inside its envelope is deliverable even if
  // the ladder could not shrink the evidence the last few tokens. See
  // `impactResponseMeetsEvidenceBudget` for why promoting it here would trade
  // delivered evidence for surplus metadata allowance.
  if (!impactResponseFitsEnvelope(responseBudget)) {
    return buildBoundedImpactDecline(draft, {
      requestedMaxTokens,
      totalCeiling,
      requestedMaxEdges,
      originalUniqueEdges,
    });
  }
  draft.responseBudget = responseBudget;
  return draft as ImpactProductResponse;
}

/**
 * Bounds on the only strings in the terminal record whose length is decided by
 * the repository rather than by this file. Everything else the record carries is
 * a frozen constant, a boolean, or a non-negative integer, so these four bounds
 * are what make the terminal's size a constant instead of an input.
 */
const DECLINE_IDENTITY_CHARACTERS = 200;

/**
 * Left in place of an identity that exceeded its bound.
 *
 * OMISSION, NOT TRUNCATION, for M176's reason: `fqName` is the argument a caller
 * feeds back to this same tool, so half a symbol name is an identity that does
 * not resolve — strictly worse than an explicit refusal to quote it.
 */
const DECLINE_OVER_BOUND = "@omitted: exceeded the bounded impact response limit";

const boundedIdentity = (value: string): string =>
  value.length <= DECLINE_IDENTITY_CHARACTERS ? value : DECLINE_OVER_BOUND;

/**
 * The terminal record for an impact response that cannot be represented inside
 * its own envelope. Returned unconditionally: it is measured for reporting, never
 * re-gated, so there is no path from here back to an unreachable state.
 *
 * WHY THIS EXISTS. The ladder above is a real bounded degradation and for almost
 * every request it is enough. But it can only shrink the five model-visible keys,
 * and M177-A measured the floor to be 61% METADATA — 745 tokens of `richSummary`,
 * `diagnostics`, `callerCoverage`, `summary`, `resolvedSymbol`, `coverage` and
 * `timing` that no rung touches — against a ceiling of only
 * `max_tokens + max(800, 15%)`. So for any small budget the ladder runs out with
 * the response still too large, and before M177 it threw
 * `impact_response_envelope_unreachable`, which the MCP server's catch-all
 * reported as `handler_failed`. Reproduced through the real transport on
 * `pytest-dev__pytest-10081` at `max_tokens` 1/50/100/200/400 — and, more
 * tellingly, on a symbol with NO impact at all, where there was never any
 * evidence to shed.
 *
 * WHAT IT SAYS. Nothing authored. Every fact here was already established before
 * the ladder ran, carried in the field the caller already reads:
 * `summary.consumers` and `richSummary` keep the DISCOVERED population,
 * `callerCoverage` keeps the discovered/delivered split M139 built for exactly
 * this purpose, and `responseBudget.omittedEdges` says how much did not travel.
 * The reader can therefore tell "55 edges exist and you received none" from "this
 * symbol has no impact", which is the one distinction a decline must never blur.
 *
 * NOT A NEW PUBLIC STATE. `bounded_truncated` beside `retainedEdges: 0` already
 * means what this needs it to mean, and a genuinely empty impact still reports
 * `omittedEdges: 0`. Following M176, the distinction only a maintainer needs is
 * one internal boolean, `diagnostics.envelopeDecline`.
 *
 * NOT A DUMP. No evidence travels inside the record. The authoritative graph is
 * dropped whole and counted, never summarised in prose.
 */
function buildBoundedImpactDecline(
  draft: MutableImpactResponse,
  input: {
    requestedMaxTokens: number;
    totalCeiling: number;
    requestedMaxEdges: number;
    originalUniqueEdges: number;
  },
): ImpactProductResponse {
  // Every model-visible channel yields at once. There is no ordering question
  // left to get wrong: the ladder already tried every priority it knows.
  draft.nodes = [];
  draft.edges = [];
  draft.directRelations = [];
  draft.paths = [];
  draft.view = { format: draft.view.format, lines: [] };
  draft.dependentFiles = [];
  draft.affectedFiles = [];
  draft.entrypoints = [];
  draft.tests = [];
  // Unproven call sites are evidence too, and they leave as evidence: the count
  // they came from stays visible in `callerCoverage` below.
  const deliveredPotentialCallers = 0;
  draft.potentialCallers = [];
  delete draft.accounting;

  // The deprecated mixed-direction counts describe the DELIVERED set — that is
  // what `rebuildCanonicalNodeAndViewProjections` maintains them as everywhere
  // else — so they go to zero with the delivery. `summary.consumers` is M139's
  // truthful discovered accounting and is deliberately left alone: it is the
  // field that keeps this record from reading as "there are no consumers".
  draft.summary = {
    ...draft.summary,
    dependentSymbolCount: 0,
    dependentFileCount: 0,
    maxObservedDistance: 0,
  };

  // Coverage prose and edge-type inventories are schema-declared or restate
  // `observedEdgeTypes`; none of them is a claim that survives losing the graph.
  draft.coverage = {
    ...draft.coverage,
    supportedEdgeTypes: [],
    observedEdgeTypes: [],
    notes: [],
  };

  // Counts stay; the three open-ended maps go. `countsByRelation` and
  // `countsByStrength` are keyed by relation kinds the repository supplies and
  // `fieldDomains` labels fields this record no longer carries, so all three are
  // unbounded in principle and describe a delivered graph that is now empty.
  draft.richSummary = {
    ...draft.richSummary,
    countsByRelation: {},
    countsByStrength: {},
    fieldDomains: {},
    truncated: true,
  };

  // THE CENSUS SURVIVES THE DECLINE WHOLE, and is the reason the decline is
  // worth returning at all: a reader who receives no evidence still learns that
  // 869 callers exist rather than being unable to tell that from a symbol with
  // none.
  //
  // Not even its two maps are emptied, which is the one place this record
  // deliberately parts company with the `richSummary` treatment directly above.
  // `richSummary.countsByRelation` describes the DELIVERED graph, so it must go
  // to zero when nothing is delivered or it would be making a claim about a
  // response that no longer carries anything. The census describes the
  // UNIVERSE, and declining to deliver evidence does not change how much impact
  // exists — zeroing it here would be the census contradicting itself between
  // two budgets, which is precisely the coupling M211 removed. The record stays
  // a constant width regardless, because `countsByKind` and `countsByStrength`
  // are keyed by `StaticRelationKind` and `StaticEvidenceStrength`: closed
  // frozen vocabularies of fourteen and five members, not repository-supplied
  // values.

  // The discovered/delivered split, restated for a delivery of nothing. This is
  // the field that carries the truth: `exactCallerCount` keeps what was found and
  // `deliveredExactCallerCount` drops to zero beside it.
  if (draft.callerCoverage !== undefined) {
    const withCounts = withDeliveredCallerCounts(draft.callerCoverage, deliveredPotentialCallers);
    draft.callerCoverage = {
      ...withCounts,
      deliveredExactCallerCount: 0,
      status: withCounts.status === "complete" && withCounts.exactCallerCount > 0
        ? "incomplete"
        : withCounts.status,
      reasonCodes: withCounts.reasonCodes.slice(0, 4),
      notes: [],
    };
  }

  draft.diagnostics = {
    ...draft.diagnostics,
    canonicalEdgesRetained: 0,
    canonicalNodesRetained: 0,
    deliveryTruncated: true,
    limitations: [],
    // The one thing this record says that a graceful degradation does not: the
    // bounded form could not be built from the response, only in place of it.
    // Internal, bounded, and the only way telemetry can attribute the two apart.
    envelopeDecline: true,
  };

  // Identities are the last variable-length values left. Bounding them is what
  // turns the terminal's size from an input into a constant.
  draft.requested = { ...draft.requested, symbolFqn: boundedIdentity(draft.requested.symbolFqn) };
  draft.resolvedSymbol = {
    ...draft.resolvedSymbol,
    filePath: boundedIdentity(draft.resolvedSymbol.filePath),
    fqName: boundedIdentity(draft.resolvedSymbol.fqName),
    localName: boundedIdentity(draft.resolvedSymbol.localName),
  };

  // A single audit entry rather than the ladder's accumulated list: every rung
  // ran and none of it survived, so enumerating them would spend the envelope
  // restating one fact this field already carries.
  draft.responseBudget = buildBudget(draft, {
    requestedMaxTokens: input.requestedMaxTokens,
    totalCeiling: input.totalCeiling,
    requestedMaxEdges: input.requestedMaxEdges,
    originalUniqueEdges: input.originalUniqueEdges,
    compacted: new Set(["impact_envelope_decline"]),
  });
  return draft as ImpactProductResponse;
}

function rebuildCanonicalNodeAndViewProjections(
  draft: MutableImpactResponse,
  compacted: Set<string>,
): void {
  const previousLinesByNodeId = new Map(
    draft.nodes.map((node, index) => [node.symbolId, draft.view.lines[index]]),
  );
  const nodeIds = new Set<string>([draft.resolvedSymbol.symbolId]);
  for (const edge of draft.edges) {
    nodeIds.add(edge.fromSymbolId);
    nodeIds.add(edge.toSymbolId);
  }
  for (const relation of draft.directRelations) {
    if (relation.source.nodeId !== undefined) nodeIds.add(relation.source.nodeId);
    if (relation.target.nodeId !== undefined) nodeIds.add(relation.target.nodeId);
  }
  const existingNodes = new Map(draft.nodes.map((node) => [node.symbolId, node]));
  for (const relation of draft.directRelations) {
    for (const endpoint of [relation.source, relation.target]) {
      if (endpoint.nodeId === undefined || existingNodes.has(endpoint.nodeId)) continue;
      const fqName = endpoint.symbol ?? endpoint.nodeId;
      existingNodes.set(endpoint.nodeId, {
        symbolId: endpoint.nodeId,
        filePath: endpoint.path ?? "",
        fqName,
        localName: fqName.split("::").at(-1)?.split(".").at(-1) ?? fqName,
        kind: endpoint.kind ?? draft.resolvedSymbol.kind,
        distance: 1,
      });
    }
  }
  draft.nodes = [...existingNodes.values()]
    .filter((node) => nodeIds.has(node.symbolId))
    .map(({ sourceExcerpt: _sourceExcerpt, ...node }) => node);
  const nodeById = new Map(draft.nodes.map((node) => [node.symbolId, node]));
  draft.dependentFiles = [...new Set(
    draft.nodes.filter((node) => node.distance > 0).map((node) => node.filePath),
  )].sort();
  draft.view = {
    format: draft.view.format,
    lines: draft.view.format === "mermaid"
      ? draft.nodes.map((node) => compactViewLine(node, draft.edges, nodeById))
      : draft.nodes.map((node) => previousLinesByNodeId.get(node.symbolId)
        ?? compactViewLine(node, draft.edges, nodeById)),
  };
  draft.summary = {
    ...draft.summary,
    dependentSymbolCount: Math.max(0, draft.nodes.length - 1),
    dependentFileCount: draft.dependentFiles.length,
    maxObservedDistance: Math.max(0, ...draft.nodes.map((node) => node.distance)),
  };
  draft.diagnostics = {
    ...draft.diagnostics,
    canonicalEdgesRetained: uniqueDeliveredEdgeCount(draft),
    canonicalNodesRetained: draft.nodes.length,
    deliveryTruncated: draft.diagnostics.deliveryTruncated
      || uniqueDeliveredEdgeCount(draft) < draft.limits.maxEdges,
  };
  compacted.add("nodes[].sourceExcerpt");
  compacted.add("view");
}

function compactViewLine(
  node: ImpactNode,
  edges: readonly ImpactEdge[],
  nodeById: ReadonlyMap<string, ImpactNode>,
): string {
  const edge = edges.find((candidate) => candidate.fromSymbolId === node.symbolId);
  const target = edge === undefined ? undefined : nodeById.get(edge.toSymbolId);
  return edge === undefined
    ? `d${node.distance} ${node.fqName}`
    : `d${node.distance} ${node.fqName} ${edge.edgeType} ${target?.fqName ?? edge.toFqName}`;
}

/**
 * Canonical selection's per-relation projection: what every delivered relation
 * looks like BEFORE the ladder has shed anything.
 *
 * WHY THE GROUNDING KEYS ARE KEPT (M209). `sourceText` is the caller's own line
 * at the persisted call site, and `referenceName` is the callee name that line
 * has to contain for the line to be evidence at all. `buildStaticRelationEvidence`
 * derives both under the index's freshness check — the excerpt is refused unless
 * the file's size and sha256 still match what was indexed — so they are the proof
 * that the structural claim is true, not a restatement of it.
 *
 * This function runs on EVERY response, before any budget is measured. Dropping
 * the two keys here made a call site indistinguishable from a coordinate on the
 * one surface that enumerates callers, on every call, at every budget, while the
 * same builder's output reached `search_logic_flow` intact — the asymmetry M209
 * measured at 0 % against 100 %. Shedding them is a budget decision, and budget
 * decisions belong to the ladder: `minimalRelation` below is the rung that makes
 * it, and it records itself in `compactedFields` so a reader can tell an
 * unaffordable line from an absent one.
 *
 * `limitations` is still dropped here: it is per-relation prose restating what
 * the tool schema and `diagnostics.limitations` already declare once.
 */
function compactRelation(relation: StaticRelationEvidence): StaticRelationEvidence {
  return {
    ...relation,
    evidence: {
      resolutionMethod: relation.evidence.resolutionMethod,
      locationKind: relation.evidence.locationKind,
      ...(relation.evidence.sourceText === undefined ? {} : { sourceText: relation.evidence.sourceText }),
      ...(relation.evidence.referenceName === undefined ? {} : { referenceName: relation.evidence.referenceName }),
      ...(relation.evidence.importAlias === undefined ? {} : { importAlias: relation.evidence.importAlias }),
      ...(relation.evidence.callSites === undefined ? {} : { callSites: relation.evidence.callSites }),
      ...(relation.evidence.callSiteCount === undefined ? {} : { callSiteCount: relation.evidence.callSiteCount }),
    },
    limitations: [],
  };
}

/**
 * The ladder's per-relation rung: the smallest truthful record of the relation.
 *
 * The rendered line goes here and only here, because it is the largest part of a
 * relation and the response is over its budget. `referenceName` stays: it is a
 * local name, it names what the resolver matched, and losing it would leave the
 * span with nothing to say what it is a span OF. The span itself, the endpoints
 * and the resolution method all survive, so what remains is a truthful pointer —
 * which is exactly what a caller who could not afford the expression should get.
 */
function minimalRelation(relation: StaticRelationEvidence): StaticRelationEvidence {
  return {
    ...relation,
    source: { nodeId: relation.source.nodeId, path: relation.source.path, symbol: relation.source.symbol, lineSpan: relation.source.lineSpan },
    target: { nodeId: relation.target.nodeId, path: relation.target.path, symbol: relation.target.symbol },
    evidence: {
      resolutionMethod: relation.evidence.resolutionMethod,
      locationKind: relation.evidence.locationKind,
      ...(relation.evidence.referenceName === undefined ? {} : { referenceName: relation.evidence.referenceName }),
      ...(relation.evidence.callSites === undefined ? {} : { callSites: relation.evidence.callSites }),
      ...(relation.evidence.callSiteCount === undefined ? {} : { callSiteCount: relation.evidence.callSiteCount }),
    },
    limitations: [],
  };
}

function uniqueDeliveredEdgeCount(output: Pick<ImpactGraphOutput, "edges" | "directRelations">): number {
  return new Set([
    ...output.edges.map((edge) => edge.edgeId),
    ...output.directRelations.map((relation) => relation.edgeId ?? relation.id),
  ]).size;
}

function modelVisibleValue(draft: MutableImpactResponse): unknown {
  return {
    edges: draft.edges,
    nodes: draft.nodes,
    view: draft.view,
    directRelations: draft.directRelations,
    paths: draft.paths,
  };
}

function buildBudget(
  draft: MutableImpactResponse,
  input: {
    requestedMaxTokens: number;
    totalCeiling: number;
    requestedMaxEdges: number;
    originalUniqueEdges: number;
    compacted: ReadonlySet<string>;
  },
): ImpactResponseBudget {
  const modelVisibleEstimatedTokens = estimateTokens(JSON.stringify(modelVisibleValue(draft)));
  const retainedEdges = uniqueDeliveredEdgeCount(draft);
  const omittedEdges = Math.max(
    draft.richSummary.omittedEdges,
    input.originalUniqueEdges - retainedEdges,
  );
  let serializedCharacters = 0;
  let accounting: ImpactResponseBudget;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const estimatedTotalTokens = estimateTokens("x".repeat(serializedCharacters));
    accounting = {
      envelopeVersion: IMPACT_RESPONSE_ENVELOPE_VERSION,
      requestedMaxTokens: input.requestedMaxTokens,
      modelVisibleEstimatedTokens,
      metadataEstimatedTokens: Math.max(0, estimatedTotalTokens - modelVisibleEstimatedTokens),
      estimatedTotalTokens,
      totalCeiling: input.totalCeiling,
      serializedCharacters,
      withinEnvelope: true,
      compactionApplied: input.compacted.size > 0,
      compactedFields: [...input.compacted].sort().slice(0, 8),
      requestedMaxEdges: input.requestedMaxEdges,
      retainedEdges,
      omittedEdges,
      resultState: omittedEdges > 0
        ? "bounded_truncated"
        : input.compacted.size > 0 ? "response_compacted" : "complete",
      estimateMethod: "chars_div_4",
    };
    const measured = JSON.stringify({ ...draft, responseBudget: accounting }).length;
    if (measured === serializedCharacters) return accounting;
    serializedCharacters = measured;
  }
  return accounting!;
}
