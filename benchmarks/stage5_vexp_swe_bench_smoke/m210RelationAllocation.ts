/**
 * M210 — impact relation ALLOCATION: the pure rules that decide what a bounded
 * `get_impact_graph` response spends its envelope on, and how a frozen A15 miss
 * is attributed.
 *
 * PURE. Nothing here reads a database, a file or a clock. The audit driver and
 * the falsification suite both call these so that a control asserts the RULE
 * and not one run's output — the same discipline m209CallSiteTruth.ts follows
 * for call-site truth, which this module deliberately does not restate.
 *
 * THE VOCABULARY IS THE PRODUCT'S. A relation's lane is composed from fields
 * `StaticRelationEvidence` already carries — `direction` (which side of the
 * focal symbol), `kind` (what the relationship is) and `strength` (how certain
 * the resolver is). No second taxonomy is invented, and in particular nothing
 * here can make a relation more certain than the resolver made it: a lane is a
 * READING of the strength, never a source of one. That is what keeps §17's
 * `exact caller != potential caller` invariant true under any ordering this
 * module can express.
 *
 * WHAT THIS MODULE IS NOT. It is not a ranking improvement, and none of the
 * policies below is proposed as a product default by virtue of appearing here.
 * They exist so the milestone can ask a causal question — CAN the bound the
 * product already spends be spent better? — with orderings that are stated,
 * deterministic and total, rather than tuned against a result.
 */
import type { RelationLike } from "./m209CallSiteTruth";

// ------------------------------------------------------------------ lanes

/**
 * The evidence families an impact answer is made of, strongest first.
 *
 * The order is an argument about the TOOL, not about the benchmark: an impact
 * / blast-radius question is "what breaks if I change this", so a proven
 * consumer of the symbol outranks a proven mention of it, which outranks a
 * module-level import of its file, which outranks something the symbol itself
 * consumes. Within callers, the resolver's own strength ordering decides.
 */
export const IMPACT_LANES = [
  "exact_caller",
  "resolved_caller",
  "weak_caller",
  "referrer",
  "subtype",
  "importer",
  "structural",
  "other_incoming",
  "outgoing",
] as const;

export type ImpactLane = (typeof IMPACT_LANES)[number];

const CALL_KINDS = new Set(["calls"]);
const REFERENCE_KINDS = new Set(["references", "reads", "writes", "decorates", "registers", "routes_to", "tests", "documents"]);
const IMPORT_KINDS = new Set(["imports", "re_exports"]);
const SUBTYPE_KINDS = new Set(["inherits", "implements"]);
const STRUCTURAL_KINDS = new Set(["contains", "defines"]);

/** Strengths the resolver treats as PROOF that the call is this call. */
const EXACT_STRENGTHS = new Set(["exact"]);
/** Strengths the resolver treats as resolved but not exact. */
const RESOLVED_STRENGTHS = new Set(["resolved", "conservative"]);

/**
 * The lane one delivered relation belongs to. Total: every relation lands
 * somewhere, and an unknown kind lands in `other_incoming` / `outgoing` rather
 * than being promoted into a lane it did not earn.
 */
export function relationLane(relation: RelationLike): ImpactLane {
  if (relation.direction !== "incoming") return "outgoing";
  const kind = relation.kind ?? "unknown";
  const strength = relation.strength ?? "unresolved";
  if (CALL_KINDS.has(kind)) {
    if (EXACT_STRENGTHS.has(strength)) return "exact_caller";
    if (RESOLVED_STRENGTHS.has(strength)) return "resolved_caller";
    return "weak_caller";
  }
  if (REFERENCE_KINDS.has(kind)) return "referrer";
  if (SUBTYPE_KINDS.has(kind)) return "subtype";
  if (IMPORT_KINDS.has(kind)) return "importer";
  if (STRUCTURAL_KINDS.has(kind)) return "structural";
  return "other_incoming";
}

/** Position of a lane in the authority order; lower is stronger. */
export function laneAuthority(lane: ImpactLane): number {
  return IMPACT_LANES.indexOf(lane);
}

/** True when `candidate` is strictly weaker evidence for an impact question than `reference`. */
export function isWeakerLane(candidate: ImpactLane, reference: ImpactLane): boolean {
  return laneAuthority(candidate) > laneAuthority(reference);
}

// -------------------------------------------------------- ordering policies

/**
 * An allocation policy is a PERMUTATION of the relations it is given. It may
 * not add, remove, alter or re-classify one. Every policy is deterministic and
 * total: it is applied as a stable sort over the product's own delivered order,
 * so two relations a policy cannot separate keep the order the product gave
 * them and no policy can introduce a tie-break of its own.
 */
export type AllocationPolicy = (relations: readonly RelationLike[]) => RelationLike[];

/** Stable sort by a key extracted from each relation; ties keep the input order. */
function stableBy(relations: readonly RelationLike[], key: (relation: RelationLike) => number): RelationLike[] {
  return relations
    .map((relation, index) => ({ relation, index, key: key(relation) }))
    .sort((left, right) => left.key - right.key || left.index - right.index)
    .map((entry) => entry.relation);
}

/** Does this relation carry a persisted call site AND the line that site names? */
export function carriesRenderedCallSite(relation: RelationLike): boolean {
  const evidence = relation.evidence ?? {};
  return (evidence.callSites?.length ?? 0) > 0
    && typeof evidence.sourceText === "string"
    && evidence.sourceText.trim().length > 0;
}

/**
 * Round-robin over lanes: take one relation from each non-empty lane in
 * authority order, then the next from each, and so on. Every lane present in
 * the input is represented before any lane takes a second slot, so no family
 * can starve another — which is the question counterfactual B asks.
 */
function roundRobinByLane(relations: readonly RelationLike[]): RelationLike[] {
  const byLane = new Map<ImpactLane, RelationLike[]>();
  for (const relation of relations) {
    const lane = relationLane(relation);
    const bucket = byLane.get(lane);
    if (bucket === undefined) byLane.set(lane, [relation]);
    else bucket.push(relation);
  }
  const lanes = [...byLane.keys()].sort((a, b) => laneAuthority(a) - laneAuthority(b));
  const out: RelationLike[] = [];
  for (let round = 0; out.length < relations.length; round += 1) {
    for (const lane of lanes) {
      const item = byLane.get(lane)![round];
      if (item !== undefined) out.push(item);
    }
  }
  return out;
}

export const ALLOCATION_POLICIES: Readonly<Record<string, AllocationPolicy>> = {
  /** The shipped order, untouched. The control every other policy is read against. */
  P0_PRODUCT: (relations) => [...relations],
  /** Lane authority alone: proven consumers before mentions before importers before outgoing. */
  P1_LANE_AUTHORITY: (relations) => stableBy(relations, (r) => laneAuthority(relationLane(r))),
  /**
   * Grounded evidence first: a relation whose call site the product can actually
   * SHOW outranks one it can only assert. Defensible for an evidence tool and
   * stated as such — but note it is a reading of what the response can prove,
   * not of what the repository contains, so it is reported, never assumed.
   */
  P2_GROUNDED_FIRST: (relations) => stableBy(relations, (r) => (carriesRenderedCallSite(r) ? 0 : 1)),
  /** Lane authority, then grounded evidence inside each lane. */
  P3_LANE_THEN_GROUNDED: (relations) => stableBy(
    stableBy(relations, (r) => (carriesRenderedCallSite(r) ? 0 : 1)),
    (r) => laneAuthority(relationLane(r)),
  ),
  /** Counterfactual B: no lane starves another. */
  P4_LANE_ROUND_ROBIN: (relations) => roundRobinByLane(relations),
};

// --------------------------------------------------------------- occupancy

export interface LaneOccupancy {
  readonly total: number;
  readonly byLane: Record<string, number>;
  readonly withCallSite: number;
  readonly withRenderedLine: number;
  readonly crossFile: number;
  readonly sameFile: number;
  readonly duplicateCallSiteIdentities: number;
}

/**
 * What a stretch of the relation stream is MADE of. Used both for the whole
 * truthful universe and for the slots ahead of a scored caller, which is the
 * question §6 asks: what occupied the capacity this caller did not get.
 */
export function occupancy(
  relations: readonly RelationLike[],
  identityOf: (relation: RelationLike) => string,
): LaneOccupancy {
  const byLane: Record<string, number> = {};
  for (const lane of IMPACT_LANES) byLane[lane] = 0;
  let withCallSite = 0;
  let withRenderedLine = 0;
  let crossFileCount = 0;
  let sameFileCount = 0;
  const identities = new Map<string, number>();
  for (const relation of relations) {
    byLane[relationLane(relation)] += 1;
    if ((relation.evidence?.callSites?.length ?? 0) > 0) withCallSite += 1;
    if (carriesRenderedCallSite(relation)) withRenderedLine += 1;
    const from = relation.source?.path;
    const to = relation.target?.path;
    if (from !== undefined && to !== undefined) {
      if (from === to) sameFileCount += 1; else crossFileCount += 1;
    }
    const identity = identityOf(relation);
    identities.set(identity, (identities.get(identity) ?? 0) + 1);
  }
  return {
    total: relations.length,
    byLane,
    withCallSite,
    withRenderedLine,
    crossFile: crossFileCount,
    sameFile: sameFileCount,
    duplicateCallSiteIdentities: [...identities.values()].filter((n) => n > 1).length,
  };
}

// ---------------------------------------------------------- miss attribution

export const A15_MISS_CLASSES = [
  "SCORED",
  "CALLER_OUTSIDE_GLOBAL_SLICE",
  "CALLER_INSIDE_SLICE_BUT_EVIDENCE_NOT_AFFORDABLE",
  "CALLER_INSIDE_SLICE_RENDERING_FAILURE",
  "CALLER_DEDUPED_INCORRECTLY",
  "CALLER_ORDERED_BELOW_WEAKER_RELATIONS",
  "CALLER_TRUTH_UNAVAILABLE",
  "CALLER_STALE",
  "OTHER",
] as const;

export type A15MissClass = (typeof A15_MISS_CLASSES)[number];

export interface A15MissInput {
  /** Ordinal in the COMPLETE truthful direct-relation universe; -1 when absent. */
  readonly universeRank: number;
  /** Ordinal in the core's own default relation slice; -1 when the slice lost it. */
  readonly coreSliceRank: number;
  /** Ordinal in the DELIVERED default response; -1 when the envelope lost it. */
  readonly deliveredRank: number;
  /** m209's renderability verdict for the core relation. */
  readonly renderability: string;
  /** Did the DELIVERED relation carry a non-empty `sourceText`? */
  readonly deliveredHasSourceText: boolean;
  /** The frozen predicate's own answer. */
  readonly frozenRendered: boolean;
  /** Was the same call-site identity delivered under a different relation? */
  readonly duplicateIdentityDelivered: boolean;
  /** Delivered relations whose lane is strictly weaker than the target caller's. */
  readonly weakerRelationsDelivered: number;
}

/**
 * WHY a frozen A15 item did not score, decided in the order the causes
 * dominate one another: truth before delivery, delivery before rendering.
 *
 * The two classes that matter for the milestone's decision are the last two.
 * `CALLER_ORDERED_BELOW_WEAKER_RELATIONS` says the response HAD capacity for
 * this caller and spent it on weaker evidence — a reallocation could recover
 * it inside the existing bound. `CALLER_INSIDE_SLICE_BUT_EVIDENCE_NOT_AFFORDABLE`
 * says nothing weaker was delivered to displace, so the bound itself is what
 * bit. Reporting them apart is the whole point of the classification: one
 * licenses an allocation repair and the other does not.
 */
export function classifyA15Miss(input: A15MissInput): A15MissClass {
  if (input.frozenRendered) return "SCORED";
  if (input.renderability === "STALE_TRUTH") return "CALLER_STALE";
  if (input.universeRank < 0) return "CALLER_TRUTH_UNAVAILABLE";
  if (input.renderability === "GRAPH_ONLY_TRUTH") return "CALLER_TRUTH_UNAVAILABLE";
  // Delivered WITH a line that the frozen rule still rejects: a rendering fault,
  // which is the class M209 repaired and which should now be empty.
  if (input.deliveredRank >= 0 && input.deliveredHasSourceText) return "CALLER_INSIDE_SLICE_RENDERING_FAILURE";
  // Delivered WITHOUT its line: the ladder shed the evidence to make budget.
  if (input.deliveredRank >= 0) return "CALLER_INSIDE_SLICE_BUT_EVIDENCE_NOT_AFFORDABLE";
  if (input.coreSliceRank < 0) return "CALLER_OUTSIDE_GLOBAL_SLICE";
  if (input.duplicateIdentityDelivered) return "CALLER_DEDUPED_INCORRECTLY";
  if (input.weakerRelationsDelivered > 0) return "CALLER_ORDERED_BELOW_WEAKER_RELATIONS";
  if (input.renderability === "AMBIGUOUS_TRUTH") return "OTHER";
  return "CALLER_INSIDE_SLICE_BUT_EVIDENCE_NOT_AFFORDABLE";
}

/** The finer reading of the affordability class: was the relation trimmed, or only its line? */
export function affordabilityForm(input: A15MissInput): "relation_trimmed" | "evidence_shed" | "not_applicable" {
  if (classifyA15Miss(input) !== "CALLER_INSIDE_SLICE_BUT_EVIDENCE_NOT_AFFORDABLE") return "not_applicable";
  return input.deliveredRank >= 0 ? "evidence_shed" : "relation_trimmed";
}

// ------------------------------------------------------ response anatomy

/**
 * Where a bounded impact response's characters actually go, grouped by what the
 * tool's own schema says each field IS.
 *
 * `max_edges bounds the canonical delivered edge set; nodes, paths,
 * directRelations, and view are projections of that set` — the tool's published
 * contract. So the response has ONE authority and four projections of it, and
 * exactly one of those projections (`directRelations`) carries the evidence.
 * The split below is that sentence turned into a measurement: what the evidence
 * projection costs, what the other three cost restating the same set, and what
 * is left over as metadata no projection change can shed.
 */
export interface ResponseAnatomy {
  readonly totalCharacters: number;
  readonly directRelationsCharacters: number;
  readonly nodesCharacters: number;
  readonly edgesCharacters: number;
  readonly viewCharacters: number;
  readonly pathsCharacters: number;
  readonly potentialCallersCharacters: number;
  readonly restatementCharacters: number;
  readonly fixedCharacters: number;
  readonly deliveredRelations: number;
  readonly deliveredNodes: number;
  readonly deliveredEdges: number;
  readonly deliveredViewLines: number;
  readonly relationsWithSourceText: number;
}

const size = (value: unknown): number => JSON.stringify(value ?? null).length;

export function responseAnatomy(response: any): ResponseAnatomy {
  const directRelationsCharacters = size(response?.directRelations);
  const nodesCharacters = size(response?.nodes);
  const edgesCharacters = size(response?.edges);
  const viewCharacters = size(response?.view);
  const pathsCharacters = size(response?.paths);
  const potentialCallersCharacters = size(response?.potentialCallers);
  const totalCharacters = size(response);
  return {
    totalCharacters,
    directRelationsCharacters,
    nodesCharacters,
    edgesCharacters,
    viewCharacters,
    pathsCharacters,
    potentialCallersCharacters,
    restatementCharacters: nodesCharacters + edgesCharacters + viewCharacters + pathsCharacters,
    fixedCharacters: totalCharacters - directRelationsCharacters - nodesCharacters
      - edgesCharacters - viewCharacters - pathsCharacters - potentialCallersCharacters,
    deliveredRelations: response?.directRelations?.length ?? 0,
    deliveredNodes: response?.nodes?.length ?? 0,
    deliveredEdges: response?.edges?.length ?? 0,
    deliveredViewLines: response?.view?.lines?.length ?? 0,
    relationsWithSourceText: (response?.directRelations ?? [])
      .filter((relation: any) => typeof relation?.evidence?.sourceText === "string"
        && relation.evidence.sourceText.trim().length > 0).length,
  };
}
