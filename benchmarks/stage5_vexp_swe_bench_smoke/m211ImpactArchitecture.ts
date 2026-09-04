/**
 * M211 — impact CENSUS / PROJECTION / CONTINUATION architecture model.
 *
 * READ-ONLY with respect to the product. Nothing here is imported by `src/`.
 * This module carries three things and deliberately nothing else:
 *
 *   1. the frozen M211 product-quality metrics (§40), written down BEFORE any
 *      functional change so a post-change number cannot retro-fit its own bar;
 *   2. a truthful census computed from a relation universe the PRODUCT built,
 *      so the counterfactual never asserts a count the product cannot reach;
 *   3. a size model for the target architecture's response shape, used only by
 *      the §41 counterfactual.
 *
 * WHY A SIZE MODEL AND NOT THE REAL ENVELOPE. M210's arms were pre-transforms
 * handed to `compactImpactProductResponse`, which is the right instrument when
 * the question is "what would the shipped ladder do with different input". It
 * cannot answer M211's question: the envelope REBUILDS `nodes` and `view` from
 * whatever relations survive (`rebuildCanonicalNodeAndViewProjections`), so a
 * pre-transform that removes the graph restatement is undone downstream — M210
 * measured exactly that in arm E1. The counterfactual therefore constructs the
 * proposed response object from the product's OWN relation objects and measures
 * it. It is a size model, labelled as one, and it is never reported as a
 * product measurement.
 */

/** The frozen ordering authority: the product's own `compareStaticRelations`. */
export const M211_ORDERING_AUTHORITY = "compareStaticRelations/direction,strength,kind,sourcePath,sourceSymbol,id" as const;

export interface RelationLike {
  readonly id: string;
  readonly edgeId: string | null;
  readonly kind: string;
  readonly direction: "incoming" | "outgoing";
  readonly strength: string;
  readonly source: { readonly path?: string; readonly symbol?: string; readonly nodeId?: string };
  readonly target: { readonly path?: string; readonly symbol?: string; readonly nodeId?: string };
  readonly evidence?: { readonly sourceText?: string; readonly locationKind?: string; readonly callSites?: readonly unknown[] };
}

const CALL_KINDS = new Set(["calls"]);
const REFERENCE_KINDS = new Set(["references", "reads", "writes", "decorates", "registers", "routes_to", "tests", "documents"]);
const IMPORT_KINDS = new Set(["imports", "re_exports"]);
const SUBTYPE_KINDS = new Set(["inherits", "implements"]);
const STRUCTURAL_KINDS = new Set(["contains", "defines"]);
/** Proven. Never merged with the two below — §11. */
const EXACT_STRENGTHS = new Set(["exact"]);

/**
 * A truthful census over a COMPLETE relation universe.
 *
 * Every field names the population it was measured over, and no field is ever
 * derived from a rendered subset (§9). `exactCallers` and `resolvedCallers` are
 * separate on purpose: a caller proven inside one file and a caller resolved
 * across a module boundary are different epistemic claims and §11 forbids
 * summing them behind one label.
 */
export interface ImpactCensusModel {
  readonly directRelations: number;
  readonly directIncoming: number;
  readonly directOutgoing: number;
  readonly exactCallers: number;
  readonly resolvedCallers: number;
  readonly referrers: number;
  readonly importers: number;
  readonly subtypes: number;
  readonly structuralContainers: number;
  readonly outgoingDependencies: number;
  readonly crossFileRelations: number;
  readonly affectedFiles: number;
  readonly relationsWithCallSite: number;
}

export function censusFromUniverse(universe: readonly RelationLike[]): ImpactCensusModel {
  const incoming = universe.filter((relation) => relation.direction === "incoming");
  const callers = incoming.filter((relation) => CALL_KINDS.has(relation.kind));
  const files = new Set<string>();
  for (const relation of universe) {
    const path = relation.direction === "incoming" ? relation.source.path : relation.target.path;
    if (path !== undefined) files.add(path);
  }
  return {
    directRelations: universe.length,
    directIncoming: incoming.length,
    directOutgoing: universe.length - incoming.length,
    exactCallers: callers.filter((relation) => EXACT_STRENGTHS.has(relation.strength)).length,
    resolvedCallers: callers.filter((relation) => !EXACT_STRENGTHS.has(relation.strength)).length,
    referrers: incoming.filter((relation) => REFERENCE_KINDS.has(relation.kind)).length,
    importers: incoming.filter((relation) => IMPORT_KINDS.has(relation.kind)).length,
    subtypes: incoming.filter((relation) => SUBTYPE_KINDS.has(relation.kind)).length,
    structuralContainers: incoming.filter((relation) => STRUCTURAL_KINDS.has(relation.kind)).length,
    outgoingDependencies: universe.filter((relation) => relation.direction === "outgoing").length,
    crossFileRelations: universe.filter((relation) => relation.source.path !== relation.target.path).length,
    affectedFiles: files.size,
    relationsWithCallSite: universe.filter((relation) => (relation.evidence?.callSites?.length ?? 0) > 0).length,
  };
}

/**
 * The counterfactual's compact census block: what the model would actually read
 * in place of `nodes` + `edges` + `view`. Serialized exactly as it would be
 * delivered so its cost is measured rather than assumed.
 */
export function censusBlockCharacters(census: ImpactCensusModel, remaining: number, ref: string | null): number {
  return JSON.stringify({
    impactCensus: census,
    continuation: ref === null ? null : { remaining, ref, orderingAuthority: M211_ORDERING_AUTHORITY },
  }).length;
}

/**
 * Graduated representation forms (§21). These are M205's existing semantics
 * applied to impact relations, not a new representation class: `full` is the
 * relation the product already builds, `signature` drops the prose that the
 * schema already declares, `metadata` is the relationship without any source
 * evidence. A relation is never fabricated into a richer form than its own
 * truth supports.
 */
export type RepresentationForm = "full" | "signature" | "metadata";

export function representAtForm(relation: RelationLike, form: RepresentationForm): unknown {
  if (form === "full") return relation;
  const base = {
    id: relation.id,
    edgeId: relation.edgeId,
    kind: relation.kind,
    direction: relation.direction,
    strength: relation.strength,
    source: relation.source,
    target: relation.target,
  };
  if (form === "metadata") return base;
  return {
    ...base,
    evidence: {
      ...(relation.evidence?.sourceText === undefined ? {} : { sourceText: relation.evidence.sourceText }),
      locationKind: relation.evidence?.locationKind,
    },
  };
}

export interface ProjectionModel {
  readonly rendered: number;
  readonly renderedWithSourceText: number;
  readonly forms: Readonly<Record<RepresentationForm, number>>;
  readonly evidenceCharacters: number;
  readonly remaining: number;
}

/**
 * The bounded ranked projection: walk the canonical stream in order and admit
 * each relation at the richest form its remaining budget affords, degrading
 * form-by-form rather than dropping evidence from every relation at once (§21).
 * Stops when even `metadata` no longer fits. Never fills spare budget with
 * filler (§17): the loop simply ends when the stream does.
 */
export function projectEvidence(
  stream: readonly RelationLike[],
  evidenceBudgetCharacters: number,
  /**
   * Characters every admitted relation costs OUTSIDE its own record, because the
   * required `nodes`/`edges`/`view` projections grow with it. Charging it here is
   * what makes "restatement yields in lockstep with evidence" a budget the model
   * has to pay rather than an assertion — and it is why the counterfactual cannot
   * buy evidence simply by declaring the graph restatement free.
   */
  restatementOverheadPerRelation = 0,
): ProjectionModel {
  const forms: Record<RepresentationForm, number> = { full: 0, signature: 0, metadata: 0 };
  let spent = 0;
  let rendered = 0;
  let withText = 0;
  for (const relation of stream) {
    let admitted: RepresentationForm | null = null;
    for (const form of ["full", "signature", "metadata"] as const) {
      const cost = JSON.stringify(representAtForm(relation, form)).length + 1 + restatementOverheadPerRelation;
      if (spent + cost <= evidenceBudgetCharacters) { admitted = form; spent += cost; break; }
    }
    if (admitted === null) break;
    forms[admitted] += 1;
    rendered += 1;
    if (admitted !== "metadata" && (relation.evidence?.sourceText ?? "").trim().length > 0) withText += 1;
  }
  return {
    rendered,
    renderedWithSourceText: withText,
    forms,
    evidenceCharacters: spent,
    remaining: Math.max(0, stream.length - rendered),
  };
}

// ------------------------------------------------------- frozen M211 metrics

/**
 * §40. Defined and frozen BEFORE the functional change. Each entry states the
 * metric, how it is measured, and the bar it must clear. A metric whose bar is
 * "no regression" names the pre-change measurement it is compared against; the
 * pre-change values are recorded by the audit run, not by this file, so this
 * file cannot be edited into agreement with a result.
 */
export const M211_PRODUCT_METRICS = Object.freeze([
  { id: "P1", name: "CENSUS_TRUTH", bar: "For every probe target the delivered census equals the census computed over the complete relation universe the core returns at its hard bound. Zero disagreements." },
  { id: "P2", name: "CENSUS_INDEPENDENT_OF_EVIDENCE_BUDGET", bar: "Census counts are byte-identical across max_tokens in {400, 1200, 4000, 20000} and max_edges in {1, 8, 64, 2000}. Zero movements." },
  { id: "P3", name: "PROJECTION_IS_A_SUBSET", bar: "Every rendered relation id occurs in the census universe; no id occurs twice. Zero violations." },
  { id: "P4", name: "SOURCE_ANCHORED", bar: "Every rendered sourceText is the file's own line at the recorded span, under M209's truth guard. Zero fabrications." },
  { id: "P5", name: "CLASS_PRESERVED", bar: "Rendered exact/resolved and direct/transitive labels equal the universe's for the same relation id. Zero promotions." },
  { id: "P6", name: "EVIDENCE_YIELD", bar: "Source-backed rendered relations in the DEFAULT response: must not fall on any probe target, and must rise on the high-fanout targets (>=64 direct relations)." },
  { id: "P7", name: "RESTATEMENT_SHARE", bar: "graph-restatement chars / total chars in the default response: must fall on every probe target with >=8 direct relations." },
  { id: "P8", name: "BOUNDEDNESS", bar: "Default response stays inside the shipped envelope on every target and every fanout in {0,1,8,32,64,128,500,1000+}; no response exceeds the 80000-char hard ceiling; response size does not grow without bound in fanout." },
  { id: "P9", name: "RECONCILIATION", bar: "rendered + remaining == census total for the projected role, and remaining >= 0, on every target. Zero violations." },
  { id: "P10", name: "CONTINUATION_COVERAGE", bar: "Concatenated pages equal the prefix of the canonical ordered stream: no duplicate relation across pages, no relation skipped by cursor arithmetic, identical under a fresh process." },
  { id: "P11", name: "CENSUS_LATENCY_NO_REGRESSION", bar: "p90 default get_impact_graph latency on each corpus does not regress against the pre-change measurement taken in the same run conditions." },
  { id: "P12", name: "COUNTING_DOES_NOT_RENDER", bar: "Source excerpts built per default request is O(delivered evidence + classification-bound kinds), not O(universe). Measured by counting excerpt builds." },
] as const);
