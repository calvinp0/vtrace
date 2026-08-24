/**
 * The authoritative semantic item supply, and who is allowed to change it.
 *
 * TWO LAYERS, ONE ARRAY. `productContext.items` serves two masters. It is the
 * model-facing per-item metadata that `responseEnvelope.ts` is entitled to
 * shrink so a response fits its ceiling, and it is the INDEX that
 * `projectRunPipelineOrientation` reads to decide what the agent is told. Those
 * have different owners and different lifetimes, and before M180 the second
 * silently inherited whatever the first left behind.
 *
 * WHAT THAT COST. `compactMandatoryProductMetadata` reduced the array to one row
 * as a metadata saving, and the envelope's escalation ladder halved it to a
 * floor of three. Neither touched `modelVisibleContext`, so the evidence stayed
 * in the response while the index over it was cut: on 167 of 169 frozen cases,
 * at some budget, the response paid to ship evidence the projector could no
 * longer reach. 72 of the 83 preservation violations M179 left came from here,
 * and a synthetic object containing nothing but sixteen items reproduces it —
 * three related entries at a budget of 1,600 and two at 3,200.
 *
 * THE SEPARATION. `applyProgressiveContextBudget` is the one component entitled
 * to decide what evidence exists: `max_tokens` bounds the model-visible context
 * and that is its contract. So it publishes what it delivered, here, keyed on
 * the productContext record it wrote into. Everything downstream may rewrite
 * `productContext.items` for serialization; the projector reads this instead.
 *
 *   authoritative supply   published once, by the evidence budget, immutable
 *   model-facing metadata  productContext.items, compacted freely afterwards
 *
 * NOT A RESPONSE FIELD. This is deliberately not part of the response. It costs
 * zero serialized bytes and changes no schema, so it cannot push a response
 * over the ceiling — which is what disqualified the alternative of keeping the
 * rows in the response itself (measured: 26 new budget pairs where a larger
 * budget declined, reopening the defect M179 closed). Internal authority may be
 * richer than default disclosure; M171 established that and it still holds.
 *
 * KEYED ON THE OBJECT, NOT ITS VALUE. Every rung in `responseEnvelope.ts`
 * mutates the productContext record IN PLACE, so its identity survives the whole
 * ladder. A copy does not carry the supply, and lookup then misses and the
 * projector falls back to `productContext.items` — exactly the pre-M180
 * behaviour, which is the safe direction to fail in.
 */

type JsonRecord = Record<string, unknown>;

/**
 * The projector's view of one delivered item. Field names match
 * `productContext.items` so the projector's own mapping reads either source
 * unchanged. Bodies are NOT carried: they are rendered once in
 * `modelVisibleContext`, which is where the projector already reads them, and
 * holding a second copy alive for the lifetime of a response would trade a
 * token defect for a memory one.
 */
export interface SemanticItem {
  readonly id: unknown;
  readonly fqName: unknown;
  readonly path: unknown;
  readonly lineSpan: unknown;
  readonly contentMode: unknown;
  readonly roles: unknown;
  readonly selectionReasons: unknown;
}

const SUPPLY = new WeakMap<object, readonly SemanticItem[]>();

const project = (item: JsonRecord): SemanticItem => Object.freeze({
  id: item.id,
  fqName: item.fqName,
  path: item.path,
  lineSpan: item.lineSpan,
  contentMode: item.contentMode,
  roles: Array.isArray(item.roles) ? Object.freeze([...item.roles]) : item.roles,
  selectionReasons: Array.isArray(item.selectionReasons)
    ? Object.freeze([...item.selectionReasons])
    : item.selectionReasons,
});

/**
 * Record what the evidence budget delivered. Called once per delivery, including
 * the delivery-failure path, where the supply is empty and the projector must
 * decline for that reason rather than for a bookkeeping one.
 */
export function publishSemanticItemSupply(product: object, delivered: readonly JsonRecord[]): void {
  SUPPLY.set(product, Object.freeze(delivered.map(project)));
}

/** The published supply, or undefined when this record never carried one. */
export function semanticItemSupplyOf(product: object): readonly SemanticItem[] | undefined {
  return SUPPLY.get(product);
}
