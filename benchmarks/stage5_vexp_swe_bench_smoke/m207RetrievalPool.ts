/**
 * M207 — retrieval-pool authority: the pool-width sweep vocabulary, the
 * supply-sufficiency rule over REAL packets, the tail-quality classification of
 * newly exposed candidates, and the candidate-allowance policy derivation.
 *
 * PURE over its inputs. The driver (run_stage5_m207_pool_sweep.ts) runs the
 * product at each width and binds every fact; this module only arranges and
 * re-measures them.
 *
 * THE QUESTION. M206 removed the tier support count and found the frozen A11
 * sweep bound, at 8000 and 16000, by the retrieval pool: the ranked stream ends
 * at CANDIDATE_POOL_SIZE = 25 whatever the caller's budget. Before that pool is
 * touched, this module answers, for every frozen response, what the SAME
 * product path delivers when only the pool's width is varied — same lexical
 * universe, same scores, same eligibility, same role gate, same M206 allocator,
 * same M205 router, same M203 accounting, same projector ceiling. Unlike M206's
 * counterfactual this is not a replay: the driver runs the default
 * `get_code_context` handler with the width set through a construction-time
 * instrumentation field, so every downstream bound (evidence budget, envelope,
 * projector) is applied by the product itself and the frozen scorer reads the
 * packet the model would have been handed.
 *
 * THE SUFFICIENCY RULE IS THE FROZEN RULE. required_match_tokens(B) =
 * ceil(0.6 x B) whole-packet chars/4 tokens (m206Allocation.ts, verbatim). A
 * width is SUFFICIENT at a budget when the median frozen token count of its
 * real packets reaches that line. There is no optimistic/conservative pair
 * here, because nothing is simulated.
 */

import { A11_BUDGETS, median } from "./m204Utilization";
import { requiredExceedTokens, requiredMatchTokens, type DiscardClass, type StopReason } from "./m206Allocation";

// ------------------------------------------------------------------ widths

/** The counterfactual width meaning "every candidate the existing generators produced". */
export const UNCAPPED_WIDTH = Number.MAX_SAFE_INTEGER;
/** The width meaning "whatever the product derives for this budget on its own" (no instrument). */
export const PRODUCT_WIDTH = -1;

export const DEFAULT_SWEEP_WIDTHS: readonly number[] = [25, 50, 100, 200, UNCAPPED_WIDTH];

export const widthLabel = (width: number): string =>
  width === UNCAPPED_WIDTH ? "uncapped" : width === PRODUCT_WIDTH ? "product" : String(width);

export function parseWidths(text: string): number[] {
  return text.split(",").map((w) => w.trim()).filter(Boolean).map((w) => {
    if (w === "uncapped") return UNCAPPED_WIDTH;
    if (w === "product") return PRODUCT_WIDTH;
    const n = Number.parseInt(w, 10);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`M207_BAD_WIDTH: ${w}`);
    return n;
  });
}

// --------------------------------------------------------------- per response

/** One ranked candidate the capsule saw at some width, from its own diagnostics. */
export interface PoolCandidate {
  readonly rank: number;
  readonly symbolId: string;
  readonly path: string;
  readonly fqName: string;
  readonly symbol: string;
  readonly finalScore: number;
  readonly sources: readonly string[];
  readonly evidence: readonly string[];
}

export type CandidateFate = "pivot" | "support_delivered" | "support_packed_not_projected" | "support_discarded" | "role_discarded" | "unaccounted";

export interface ResponseFacts {
  readonly task: string;
  readonly budget: number;
  readonly width: number;
  /** Pool the capsule saw (after the anchor merges) and the stream it ordered. */
  readonly candidateCount: number | null;
  readonly rankedStream: number | null;
  readonly roleDiscards: number;
  readonly pivotFqNames: readonly string[];
  readonly supportFqNames: readonly string[];
  readonly discardClasses: Readonly<Record<string, number>>;
  readonly focusAt: string | null;
  readonly relatedIds: readonly string[];
  readonly frozenWholeTokens: number | null;
  readonly utilisationPercent: number | null;
  readonly deliveredItems: number | null;
  readonly stop: { readonly reason: StopReason; readonly policy: string | null };
}

// ---------------------------------------------------------------- sufficiency

export interface WidthBudgetSupply {
  readonly width: number;
  readonly budget: number;
  readonly frozen: boolean;
  readonly responses: number;
  readonly requiredMatchTokens: number;
  readonly requiredExceedTokens: number;
  readonly medianFrozenTokens: number | null;
  readonly medianUtilisation: number | null;
  readonly medianCandidateCount: number | null;
  readonly medianRankedStream: number | null;
  readonly medianDeliveredItems: number | null;
  readonly medianUnusedBudget: number | null;
  readonly sufficiency: "SUFFICIENT" | "INSUFFICIENT" | "INDETERMINATE";
}

export function widthBudgetSupply(input: {
  readonly width: number;
  readonly budget: number;
  readonly frozenTokens: readonly number[];
  readonly utilisation: readonly number[];
  readonly candidateCounts: readonly number[];
  readonly rankedStreams: readonly number[];
  readonly deliveredItems: readonly number[];
}): WidthBudgetSupply {
  const med = (v: readonly number[]) => (v.length === 0 ? null : +median(v).toFixed(2));
  const required = requiredMatchTokens(input.budget);
  const tokens = med(input.frozenTokens);
  return {
    width: input.width, budget: input.budget, frozen: (A11_BUDGETS as readonly number[]).includes(input.budget),
    responses: input.frozenTokens.length,
    requiredMatchTokens: required, requiredExceedTokens: requiredExceedTokens(input.budget),
    medianFrozenTokens: tokens, medianUtilisation: med(input.utilisation),
    medianCandidateCount: med(input.candidateCounts), medianRankedStream: med(input.rankedStreams),
    medianDeliveredItems: med(input.deliveredItems),
    medianUnusedBudget: tokens === null ? null : +(input.budget - tokens).toFixed(2),
    sufficiency: tokens === null ? "INDETERMINATE" : tokens >= required ? "SUFFICIENT" : "INSUFFICIENT",
  };
}

export type RetrievalSupplyVerdict =
  | "A11_RETRIEVAL_SUPPLY_SUFFICIENT"
  | "A11_RETRIEVAL_SUPPLY_INSUFFICIENT"
  | "A11_RETRIEVAL_SUPPLY_INDETERMINATE";

/**
 * The frozen rule needs MATCH at EVERY frozen budget, so the verdict is taken
 * on the effectively uncapped width alone: if the whole existing universe
 * cannot reach the line somewhere, no narrower width can.
 */
export function retrievalSupplyVerdict(rows: readonly WidthBudgetSupply[], uncappedWidth = UNCAPPED_WIDTH): RetrievalSupplyVerdict {
  const frozen = rows.filter((r) => r.frozen && r.width === uncappedWidth);
  if (frozen.length !== A11_BUDGETS.length) return "A11_RETRIEVAL_SUPPLY_INDETERMINATE";
  if (frozen.some((r) => r.sufficiency === "INSUFFICIENT")) return "A11_RETRIEVAL_SUPPLY_INSUFFICIENT";
  if (frozen.every((r) => r.sufficiency === "SUFFICIENT")) return "A11_RETRIEVAL_SUPPLY_SUFFICIENT";
  return "A11_RETRIEVAL_SUPPLY_INDETERMINATE";
}

/** The narrowest swept width whose real packets are SUFFICIENT at every frozen budget, or null. */
export function narrowestSufficientWidth(rows: readonly WidthBudgetSupply[]): number | null {
  const widths = [...new Set(rows.map((r) => r.width))].sort((a, b) => a - b);
  for (const width of widths) {
    const frozen = rows.filter((r) => r.frozen && r.width === width);
    if (frozen.length === A11_BUDGETS.length && frozen.every((r) => r.sufficiency === "SUFFICIENT")) return width;
  }
  return null;
}

// ------------------------------------------------------------- tail quality

export interface ExposedCandidate extends PoolCandidate {
  readonly task: string;
  readonly budget: number;
  readonly width: number;
  readonly fate: CandidateFate;
  readonly representation: string | null;
  readonly delivered: boolean;
  /** The strongest evidence family the candidate carries, from its scored sources. */
  readonly provenance: string;
}

/** Sources are the retrieval generators; the first present decides the family label. */
export function provenanceOf(sources: readonly string[], evidence: readonly string[]): string {
  const s = new Set(sources);
  if (s.has("test_to_impl") || s.has("failing_test")) return "test_routed";
  if (s.has("symbol")) return "symbol_name";
  if (s.has("path")) return "likely_file";
  if (s.has("body_literal")) return "body_literal";
  if (s.has("operation_fact")) return "operation_fact";
  if (s.has("lexical")) return evidence.some((e) => /^lexical match on/.test(e)) ? "lexical" : "lexical_scored";
  if (s.has("graph")) return "graph_neighbour";
  if (s.has("same_module")) return "same_module";
  if (s.has("upstream_rescue")) return "upstream_rescue";
  if (s.has("concept_owner")) return "concept_owner";
  return sources.length === 0 ? "unsourced" : sources.join("+");
}

export function candidateFate(input: {
  readonly fqName: string;
  readonly pivotFqNames: ReadonlySet<string>;
  readonly supportFqNames: ReadonlySet<string>;
  readonly discardedRoleFqNames: ReadonlySet<string>;
  readonly relatedIds: ReadonlySet<string>;
  readonly focusAt: string | null;
}): { fate: CandidateFate; delivered: boolean } {
  const delivered = input.relatedIds.has(input.fqName) || input.focusAt === input.fqName;
  if (input.pivotFqNames.has(input.fqName)) return { fate: "pivot", delivered };
  if (input.supportFqNames.has(input.fqName)) return { fate: delivered ? "support_delivered" : "support_packed_not_projected", delivered };
  if (input.discardedRoleFqNames.has(input.fqName)) return { fate: "role_discarded", delivered };
  return { fate: delivered ? "unaccounted" : "support_discarded", delivered };
}

export interface TailQuality {
  readonly width: number;
  readonly budget: number;
  readonly exposed: number;
  readonly scoreDistribution: { min: number; p10: number; median: number; p90: number; max: number } | null;
  readonly baselineScoreDistribution: { min: number; p10: number; median: number; p90: number; max: number } | null;
  readonly fates: Readonly<Record<string, number>>;
  readonly provenance: Readonly<Record<string, number>>;
  readonly representations: Readonly<Record<string, number>>;
  readonly deliveredFraction: number | null;
  readonly rejectedDownstreamFraction: number | null;
  readonly sourceBackedFraction: number | null;
  readonly relationshipOnlyFraction: number | null;
  readonly duplicateRate: number | null;
}

const pct = (values: readonly number[], p: number): number => {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
};
export const scoreDistribution = (values: readonly number[]) => values.length === 0 ? null : {
  min: +pct(values, 0.0000001).toFixed(4), p10: +pct(values, 0.1).toFixed(4), median: +median(values).toFixed(4),
  p90: +pct(values, 0.9).toFixed(4), max: +pct(values, 1).toFixed(4),
};

export function tailQuality(input: {
  readonly width: number;
  readonly budget: number;
  readonly exposed: readonly ExposedCandidate[];
  readonly baselineScores: readonly number[];
  readonly duplicates: number;
}): TailQuality {
  const hist = (f: (c: ExposedCandidate) => string) => {
    const h: Record<string, number> = {};
    for (const c of input.exposed) h[f(c)] = (h[f(c)] ?? 0) + 1;
    return h;
  };
  const n = input.exposed.length;
  const frac = (k: number) => (n === 0 ? null : +(k / n).toFixed(4));
  const delivered = input.exposed.filter((c) => c.delivered).length;
  const rejected = input.exposed.filter((c) => c.fate === "role_discarded" || c.fate === "support_discarded" || c.fate === "support_packed_not_projected").length;
  const sourceBacked = input.exposed.filter((c) => c.delivered && c.representation !== null && c.representation !== "relationship_only").length;
  const relationshipOnly = input.exposed.filter((c) => c.delivered && c.representation === "relationship_only").length;
  return {
    width: input.width, budget: input.budget, exposed: n,
    scoreDistribution: scoreDistribution(input.exposed.map((c) => c.finalScore)),
    baselineScoreDistribution: scoreDistribution(input.baselineScores),
    fates: hist((c) => c.fate), provenance: hist((c) => c.provenance),
    representations: hist((c) => c.representation ?? (c.delivered ? "unlabelled" : "not_delivered")),
    deliveredFraction: frac(delivered), rejectedDownstreamFraction: frac(rejected),
    sourceBackedFraction: delivered === 0 ? null : +(sourceBacked / delivered).toFixed(4),
    relationshipOnlyFraction: delivered === 0 ? null : +(relationshipOnly / delivered).toFixed(4),
    duplicateRate: n + input.duplicates === 0 ? null : +(input.duplicates / (n + input.duplicates)).toFixed(4),
  };
}

// ------------------------------------------------------------ role identity

export interface RoleIdentity {
  readonly width: number;
  readonly budget: number;
  readonly responses: number;
  readonly samePivotSet: number;
  readonly sameLeadPivot: number;
  readonly sameFocus: number;
  readonly pivotCountDelta: { min: number; max: number; median: number } | null;
  readonly supportCountDelta: { min: number; max: number; median: number } | null;
  readonly starvedPivots: number;
}

export function roleIdentity(input: {
  readonly width: number;
  readonly budget: number;
  readonly pairs: readonly { readonly base: ResponseFacts; readonly at: ResponseFacts }[];
}): RoleIdentity {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const pivotDelta = input.pairs.map((p) => p.at.pivotFqNames.length - p.base.pivotFqNames.length);
  const supportDelta = input.pairs.map((p) => p.at.supportFqNames.length - p.base.supportFqNames.length);
  const dist = (v: readonly number[]) => v.length === 0 ? null : { min: Math.min(...v), max: Math.max(...v), median: median(v) };
  return {
    width: input.width, budget: input.budget, responses: input.pairs.length,
    samePivotSet: input.pairs.filter((p) => same(p.base.pivotFqNames, p.at.pivotFqNames)).length,
    sameLeadPivot: input.pairs.filter((p) => p.base.pivotFqNames[0] === p.at.pivotFqNames[0]).length,
    sameFocus: input.pairs.filter((p) => p.base.focusAt === p.at.focusAt).length,
    pivotCountDelta: dist(pivotDelta), supportCountDelta: dist(supportDelta),
    // A pivot the base width delivered that the wider width does not: the tail displaced a required target.
    starvedPivots: input.pairs.filter((p) => p.base.pivotFqNames.some((f) => !p.at.pivotFqNames.includes(f))).length,
  };
}

// ---------------------------------------------------- the stop, per response

/** The M206 stop vocabulary with the pool bound read from the width the response ran at. */
export function stopAtWidth(input: {
  readonly projectorRejectedForCeiling: number | null;
  readonly evidenceBudgetDropped: number | null;
  readonly evidenceBudgetCompacted: boolean;
  readonly discardClasses: Readonly<Record<string, number>>;
  readonly candidateCount: number | null;
  readonly width: number;
}): { readonly reason: StopReason; readonly policy: string | null; readonly detail: string } {
  const classes = input.discardClasses;
  if ((input.projectorRejectedForCeiling ?? 0) > 0) {
    return { reason: "NEXT_ITEM_TOO_LARGE", policy: null, detail: "the projector's ceiling (the caller's budget) refused the next ranked item" };
  }
  if ((input.evidenceBudgetDropped ?? 0) > 0) {
    return { reason: "OTHER_EXPLICIT_POLICY", policy: "UPSTREAM_EVIDENCE_BUDGET", detail: `the evidence budget dropped ${input.evidenceBudgetDropped} selected items` };
  }
  if ((classes.TIER_SUPPORT_CAP ?? 0) > 0) {
    return { reason: "OTHER_EXPLICIT_POLICY", policy: "FIXED_TIER_SUPPORT_CAP", detail: `${classes.TIER_SUPPORT_CAP} ranked support candidates discarded for a count` };
  }
  if (input.evidenceBudgetCompacted) {
    return { reason: "OTHER_EXPLICIT_POLICY", policy: "UPSTREAM_EVIDENCE_BUDGET", detail: "the evidence budget compacted the rendering; nothing dropped" };
  }
  if ((classes.TOKEN_BUDGET ?? 0) > 0) {
    return { reason: "NEXT_ITEM_TOO_LARGE", policy: "CAPSULE_TOKEN_BUDGET", detail: `${classes.TOKEN_BUDGET} candidates did not fit the capsule's remaining token budget` };
  }
  if ((classes.LANE_TOKEN_CEILING ?? 0) > 0) {
    return { reason: "OTHER_EXPLICIT_POLICY", policy: "LANE_TOKEN_CEILING", detail: `${classes.LANE_TOKEN_CEILING} lane candidates over their lane's token fraction` };
  }
  if (input.width !== UNCAPPED_WIDTH && input.candidateCount !== null && input.candidateCount >= input.width) {
    return { reason: "OTHER_EXPLICIT_POLICY", policy: "CANDIDATE_POOL_CAP", detail: `the ranked stream ends at the retrieval pool width (${input.candidateCount} of ${input.width})` };
  }
  return { reason: "NO_TRUTHFUL_SUPPLY", policy: null, detail: `every eligible ranked candidate delivered (pool ${input.candidateCount ?? "?"}${input.width === UNCAPPED_WIDTH ? ", uncapped" : ` of ${input.width}`})` };
}

// --------------------------------------------------------------- policy

/**
 * The candidate-allowance derivation the product would carry if the sweep
 * licenses a repair: the number of ranked candidates the caller's budget could
 * deliver at the product's own measured cost per delivered support entry,
 * never below the historical pool and never above an independent safety
 * maximum. Stated here so the report can show, for every budget the product
 * might be asked, what the rule yields; the product's own copy is the
 * authority and the report checks the two agree.
 */
export function candidateAllowance(input: {
  readonly maxTokens: number;
  readonly tokensPerDeliveredCandidate: number;
  readonly floor: number;
  readonly hardMaximum: number;
}): number {
  if (!Number.isFinite(input.maxTokens) || input.maxTokens <= 0) return input.floor;
  const wanted = Math.ceil(input.maxTokens / input.tokensPerDeliveredCandidate);
  return Math.max(input.floor, Math.min(input.hardMaximum, wanted));
}

export const discardClassHistogram = (classes: readonly DiscardClass[]): Record<string, number> => {
  const h: Record<string, number> = {};
  for (const c of classes) h[c] = (h[c] ?? 0) + 1;
  return h;
};
