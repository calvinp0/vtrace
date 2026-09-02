/**
 * Per-item accounting for the orientation packet: what each delivered item cost,
 * which route admitted it, and how the packet reconciles to its ceiling.
 *
 *     selection -> representation -> ceiling -> delivery
 *                                                 |
 *                                        accounting describing it   <- this module
 *
 * ACCOUNTING DESCRIBES; IT NEVER DECIDES. Nothing here is read by the projector
 * when it chooses an item, orders a list, or tests the ceiling. The ledger is
 * written AFTER admission, from the decisions the projector already made, and a
 * value in it feeding back into selection would make the accounting a second,
 * undeclared selector — the exact defect M181 removed from `compactReasons`.
 *
 * TWO SURFACES, ONE CONTRACT. Every delivered item carries a model-facing
 * `tokens` field: its own serialized cost in the packet, under the packet's own
 * token rule, including the field itself. That is the whole model-facing
 * disclosure — one integer per item — because the claim it satisfies is about
 * what the model is handed, and a verbose ledger in the packet would be paid for
 * on every call by an agent that never reads it. The rest of the record lives
 * out-of-band, keyed on the packet object (the M180 pattern), reachable by
 * `orientationAccountingOf` and costing zero serialized bytes. The `tokens`
 * field IS `actualTokens` in that record: one authority, projected twice.
 *
 * ESTIMATED IS NOT ACTUAL. An item is admitted against the packet as it stood at
 * admission time, before any item carried a `tokens` field. Its final cost
 * includes that field. Both are recorded, and the first is never overwritten by
 * the second: rewriting the admission-time figure would make the ledger a story
 * about a selection that did not happen.
 *
 * THE CEILING GOVERNS EVIDENCE. The projector's ceiling is tested on the packet
 * without accounting fields, exactly as before this module existed, so the set
 * and order of delivered items is a function of the evidence alone. The
 * accounting fields then ride above it by a bounded, reported amount
 * (`accountingOverhead`). Charging them inside the admission test would evict
 * evidence to make room for the description of the evidence — a selection
 * change, which belongs to a budget milestone and not to an accounting one.
 *
 * COST IS MEASURED, NOT ESTIMATED. Every character count here is the exact
 * length of the serialized item or packet, and every token figure is that count
 * under the one rule the ceiling uses. The ledger reconciles exactly in
 * characters: items plus wrapper equals the packet. Tokens are rounded per part,
 * so their sum is reconciled within a stated bound rather than pretended exact.
 *
 * ABSENT IS NOT ZERO. A fact the projector cannot see is `unavailable`; a fact
 * that does not apply to an item class is `not_applicable`. A zero is a
 * measurement.
 *
 * PURE. No I/O, no clock, no randomness. Identity is the item's canonical
 * `path::Symbol` plus its delivery ordinal, both deterministic.
 */

/**
 * M166's measured calibration for serialized tool-result JSON, 0.3174 tokens per
 * character over 363 provider-reported samples. The one rule for the packet:
 * the ceiling is applied through it and every figure below is stated in it.
 */
export const ORIENTATION_TOKENS_PER_CHARACTER = 0.3174032272551657;

/** Tokens for a serialized length under the packet's rule. Never negative. */
export const orientationTokensOfCharacters = (characters: number): number =>
  Math.max(0, Math.round(characters * ORIENTATION_TOKENS_PER_CHARACTER));

/** A fact the projector could not observe, or one that does not apply. Never 0. */
export type AccountingAbsence = "unavailable" | "not_applicable";

export type OrientationItemOrigin = "item_supply" | "pivot_neighborhood";

export interface OrientationItemAccounting {
  /** Canonical `path::Symbol`, exactly as the packet spells `at`. */
  readonly at: string;
  /** 0 is the focus; 1..n are `related` in delivered order. */
  readonly ordinal: number;
  readonly slot: "focus" | "related";
  /**
   * What was delivered: the focus carries its authoritative `contentMode`
   * (`focused_source`, `signature`, ...); a related entry carries a relationship
   * claim and no code, which is its own representation class.
   */
  readonly representation: string;
  /** The route that admitted the item. The first proposer wins; never re-ranked. */
  readonly origin: OrientationItemOrigin;
  /** Every route that proposed this identity, in proposal order. Length > 1 is a deduplication. */
  readonly origins: readonly OrientationItemOrigin[];
  /** The evidence budget's item id for a supply item; not applicable to a neighbour. */
  readonly sourceId: string | AccountingAbsence;
  /** The verbatim claim the packet makes about the item (`why` or `how`). */
  readonly reason: string;
  readonly reasonSource: "selection_reason" | "roles" | "neighbor_relation";
  /**
   * The chars/4 estimate the evidence budget published for the item's delivered
   * body — a DIFFERENT authority (it sized `modelVisibleContext`, not this
   * packet), carried verbatim and never converted.
   */
  readonly upstreamEstimatedTokens: number | AccountingAbsence;
  /** Characters of the rendered body the projector could see for this item. */
  readonly bodyCharacters: number | AccountingAbsence;
  /** Characters of code actually delivered in the packet. */
  readonly deliveredCodeCharacters: number;
  readonly codeDelivered: boolean;
  /** True when delivered code is a head-bounded prefix of the body. */
  readonly truncated: boolean;
  /** The item's serialized cost WITHOUT its `tokens` field: what admission saw. */
  readonly estimatedTokens: number;
  /** The whole evidence packet's tokens with this item as the last admitted: the value tested against the ceiling. */
  readonly admissionPacketTokens: number;
  /** Exact serialized characters of the delivered item, `tokens` field included. */
  readonly characters: number;
  /** The delivered item's cost under the packet rule. Equals the model-facing `tokens`. */
  readonly actualTokens: number;
  readonly cumulativeCharacters: number;
  readonly cumulativeTokens: number;
}

export interface OrientationRejectedCandidate {
  readonly at: string;
  readonly origin: OrientationItemOrigin;
  /** Position in the admissible list, after the focus and deduplication. */
  readonly proposedOrdinal: number;
  readonly estimatedTokens: number;
  readonly admissionPacketTokens: number;
  readonly reason: "ceiling";
}

export interface OrientationEvidenceBudget {
  readonly method: "characters_div_4";
  readonly requestedTokens: number | AccountingAbsence;
  readonly modelVisibleTokens: number | AccountingAbsence;
  readonly remainingTokens: number | AccountingAbsence;
  readonly deliveryStatus: string | AccountingAbsence;
  readonly selectedItemsBeforeBudget: number | AccountingAbsence;
  readonly deliveredItems: number | AccountingAbsence;
  readonly droppedForBudget: number | AccountingAbsence;
  readonly compactionStages: readonly string[] | AccountingAbsence;
}

export interface OrientationAccounting {
  readonly tokenRule: {
    readonly method: "characters_times_tokens_per_character";
    readonly tokensPerCharacter: number;
    readonly rounding: "nearest";
  };
  readonly ceilingTokens: number;
  readonly ceilingAppliesTo: "evidence_packet";
  /** The packet as tested against the ceiling: no item carries `tokens` yet. */
  readonly evidence: { readonly characters: number; readonly tokens: number; readonly withinCeiling: boolean };
  /** The packet as delivered. */
  readonly packet: { readonly characters: number; readonly tokens: number };
  /** packet minus evidence: the cost of the accounting fields themselves. */
  readonly accountingOverhead: { readonly characters: number; readonly tokens: number };
  /** packet minus every item: schema version, boundary, notes, keys and punctuation. */
  readonly wrapper: { readonly characters: number; readonly tokens: number };
  readonly reconciliation: {
    readonly itemCharacters: number;
    readonly wrapperCharacters: number;
    readonly packetCharacters: number;
    /** items + wrapper == packet, in characters. Always true by construction; published so it can be checked. */
    readonly charactersExact: boolean;
    readonly itemTokens: number;
    readonly wrapperTokens: number;
    readonly packetTokens: number;
    /** |packet - (items + wrapper)| in tokens: rounding only. */
    readonly tokenDeviation: number;
    /** Half a token per rounded part. Deviation above this is not rounding. */
    readonly tokenDeviationBound: number;
  };
  /**
   * Every proposal is in exactly one of these: admitted, deduplicated (a later
   * proposal of an identity already proposed), dropped because no claim could be
   * rendered for it (an unknown relation token; see NEIGHBOR_RELATION_PHRASES),
   * rejected by the ceiling, or never reached because the ceiling broke the
   * prefix before it. proposed = the sum of the other five.
   */
  readonly candidates: {
    readonly proposed: number;
    readonly deduplicated: number;
    readonly droppedNoClaim: number;
    readonly admitted: number;
    readonly rejectedForCeiling: number;
    readonly notReached: number;
    readonly rejected: readonly OrientationRejectedCandidate[];
  };
  /** The upstream evidence budget, verbatim, in its own units. */
  readonly evidenceBudget: OrientationEvidenceBudget;
  readonly items: readonly OrientationItemAccounting[];
}

const LEDGERS = new WeakMap<object, OrientationAccounting>();

/** Record the ledger for a packet. Called once, by the projector, after assembly. */
export function publishOrientationAccounting(packet: object, ledger: OrientationAccounting): void {
  LEDGERS.set(packet, ledger);
}

/** The ledger for a packet the projector produced, or undefined for any other object. */
export function orientationAccountingOf(packet: object): OrientationAccounting | undefined {
  return LEDGERS.get(packet);
}

/**
 * Attach the model-facing `tokens` field so that it states the item's cost WITH
 * itself included. The field's own digits are part of the serialization, so the
 * value is a fixed point: start from the cost without the field and re-measure
 * until the figure stops moving. Each step can only lengthen the serialization
 * (a larger count has at least as many digits), so the sequence is
 * non-decreasing and bounded, and converges within the digit-count steps.
 */
export function withItemTokens<T extends object>(item: T): T & { readonly tokens: number } {
  let tokens = orientationTokensOfCharacters(JSON.stringify(item).length);
  for (;;) {
    const candidate = { ...item, tokens };
    const measured = orientationTokensOfCharacters(JSON.stringify(candidate).length);
    if (measured === tokens) return Object.freeze(candidate);
    tokens = measured;
  }
}

/** The bound the token reconciliation is held to: half a token of rounding per part. */
export const tokenDeviationBound = (parts: number): number => Math.ceil(parts / 2);
