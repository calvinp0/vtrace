/**
 * M179 — the monotone-delivery instrument.
 *
 * ONE AUTHORITATIVE OBJECT, MANY BUDGETS. M178 recorded the trap this module
 * exists to avoid: varying a request's `max_tokens` moves the ENGINE's spend as
 * well as the envelope's, so a ladder built by re-running the product at each
 * budget measures upstream state variation and calls it packing. Everything here
 * takes a FROZEN authoritative object and varies nothing but the delivery budget,
 * which is the only form in which the monotonicity question is well posed.
 *
 * PURE. `compactProductResponse` and `projectRunPipelineOrientation` are pure
 * functions of that object, so a ladder is a deterministic function of
 * (object, budget) alone — no transport, no index, no clock, no machine load.
 */

import { createHash } from "node:crypto";

import { compactProductResponse, McpResponseDetail } from "../../src/mcp/responseEnvelope";
import { projectRunPipelineOrientation } from "../../src/runPipeline/orientationProjection";

export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asArray = (value: unknown): readonly JsonRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

/**
 * The terminal states a budget can produce, ordered. A LOWER rank at a LARGER
 * budget is the violation the milestone is named for.
 */
export const TERMINAL_RANK = Object.freeze({ refused: 0, decline: 1, orientation: 2 });

export interface Delivered {
  /** `orientation` | `<resultState>` | `throw:<message>` */
  readonly state: string;
  readonly rank: number;
  /** Canonical semantic identity of the focus, or null when nothing was delivered. */
  readonly focus: string | null;
  /** Whether the focus carried a code body, and whether that body was cut. */
  readonly focusCode: boolean;
  readonly focusTruncated: boolean;
  readonly focusCodeCharacters: number;
  /** True when the focus body carried the renderer's closing sentence (see above). */
  readonly focusCodeContaminated: boolean;
  /** Canonical semantic identities of the related evidence, in delivered order. */
  readonly related: readonly string[];
  readonly notes: readonly string[];
  /** Envelope accounting, for economics and for the dominance arithmetic. */
  readonly modelVisibleTokens: number;
  readonly metadataTokens: number;
  readonly totalTokens: number;
  readonly ceilingTokens: number;
  readonly withinEnvelope: boolean;
  readonly envelopeDecline: boolean;
  /** True when the last-resort degradation fired — the state M179 must eliminate. */
  readonly boundedDegradation: boolean;
  readonly deliveredItems: number;
  readonly serializedCharacters: number;
}

/**
 * The delivery renderer's closing sentence.
 *
 * `parseRenderedBodies` takes everything after an item's metadata lines as that
 * item's body, and this line is appended once at the END of the whole rendering —
 * so it lands inside the LAST section's body and is served to the model as part
 * of that symbol's source. Whether it contaminates the focus therefore depends on
 * how many items were delivered, which depends on the budget: a pure measurement
 * artifact for monotonicity purposes, and a real truthfulness defect in its own
 * right. Normalized out here and counted separately.
 */
export const RENDER_TRAILING_NOTE =
  "Impact entries above are bounded static structural evidence; they are not dynamic execution flow.";

const stripTrailingNote = (code: string): { code: string; contaminated: boolean } => {
  const trimmed = code.trimEnd();
  if (!trimmed.endsWith(RENDER_TRAILING_NOTE)) return { code, contaminated: false };
  return { code: trimmed.slice(0, trimmed.length - RENDER_TRAILING_NOTE.length).trimEnd(), contaminated: true };
};

/**
 * Canonical evidence identity (§22). A related entry is identified by the symbol
 * it names AND the claim made about it: the same symbol delivered under a weaker
 * relationship phrase is not the same delivered fact.
 */
const relatedIdentity = (entry: JsonRecord): string =>
  `${String(entry.at)}|${String(entry.how)}`;

/** Run one budget against one frozen authoritative object. */
export function deliver(authoritative: unknown, budget: number): Delivered {
  const draft = structuredClone(authoritative) as JsonRecord;
  delete draft.responseBudget;
  let response: JsonRecord;
  try {
    response = compactProductResponse(draft, {
      requestedContextTokens: budget,
      detail: McpResponseDetail.Standard,
    }) as JsonRecord;
  } catch (cause) {
    return {
      state: `throw:${cause instanceof Error ? cause.message : String(cause)}`,
      rank: TERMINAL_RANK.refused,
      focus: null, focusCode: false, focusTruncated: false, focusCodeCharacters: 0, focusCodeContaminated: false,
      related: [], notes: [],
      modelVisibleTokens: 0, metadataTokens: 0, totalTokens: 0, ceilingTokens: 0,
      withinEnvelope: false, envelopeDecline: false, boundedDegradation: false,
      deliveredItems: 0, serializedCharacters: 0,
    };
  }

  const budgetAccounting = isRecord(response.responseBudget) ? response.responseBudget : {};
  const compactedFields = Array.isArray(budgetAccounting.compacted_fields)
    ? budgetAccounting.compacted_fields.map(String)
    : [];
  const productContext = isRecord(response.productContext) ? response.productContext : {};
  const diagnostics = isRecord(productContext.diagnostics) ? productContext.diagnostics : {};
  const number = (value: unknown): number => (typeof value === "number" ? value : 0);

  const shared = {
    modelVisibleTokens: number(budgetAccounting.estimated_model_visible_tokens),
    metadataTokens: number(budgetAccounting.estimated_metadata_tokens),
    totalTokens: number(budgetAccounting.estimated_total_response_tokens),
    ceilingTokens: number(budgetAccounting.total_response_token_ceiling),
    withinEnvelope: budgetAccounting.within_envelope === true,
    envelopeDecline: diagnostics.envelopeDecline === true,
    boundedDegradation: compactedFields.includes("productContext.bounded_degradation"),
    deliveredItems: asArray(productContext.items).length,
    serializedCharacters: number(budgetAccounting.serialized_response_characters),
  };

  const packet = projectRunPipelineOrientation(response);
  if (packet === null) {
    return {
      state: String(productContext.resultState ?? "unknown"),
      rank: TERMINAL_RANK.decline,
      focus: null, focusCode: false, focusTruncated: false, focusCodeCharacters: 0, focusCodeContaminated: false,
      related: [], notes: [],
      ...shared,
    };
  }
  const focus = packet.focus;
  const normalized = stripTrailingNote(focus.code ?? "");
  return {
    state: "orientation",
    rank: TERMINAL_RANK.orientation,
    focus: focus.at,
    focusCode: normalized.code !== "",
    focusTruncated: focus.codeTruncated,
    focusCodeCharacters: normalized.code.length,
    focusCodeContaminated: normalized.contaminated,
    related: packet.related.map((entry) => relatedIdentity(entry as unknown as JsonRecord)),
    notes: [...(packet.notes ?? [])],
    ...shared,
  };
}

/**
 * §26's violation taxonomy, evaluated over ONE ordered budget pair.
 *
 * `DECLINE_TO_ORIENTATION` is not a violation: the property is directional, and a
 * larger budget rescuing a smaller one's decline is the packer working.
 *
 * `ITEM_LOSS` is judged on semantic identities and not on counts, so an entry
 * that changed its relationship phrase registers as a loss rather than hiding
 * behind a stable cardinality.
 */
export interface PairViolation {
  readonly lower: number;
  readonly higher: number;
  readonly classes: readonly string[];
  readonly lostEvidence: readonly string[];
}

export function comparePair(lower: number, lowerDelivered: Delivered, higher: number, higherDelivered: Delivered): PairViolation | null {
  const classes: string[] = [];
  let lost: string[] = [];

  if (higherDelivered.rank < lowerDelivered.rank) {
    classes.push(lowerDelivered.rank === TERMINAL_RANK.orientation ? "ORIENTATION_TO_DECLINE" : "DECLINE_TO_REFUSED");
  }

  if (lowerDelivered.rank === TERMINAL_RANK.orientation && higherDelivered.rank === TERMINAL_RANK.orientation) {
    if (lowerDelivered.focus !== null && higherDelivered.focus !== lowerDelivered.focus) {
      classes.push("FOCUS_SUBSTITUTED");
      lost.push(`focus:${lowerDelivered.focus}`);
    }
    const higherRelated = new Set(higherDelivered.related);
    const missing = lowerDelivered.related.filter((id) => !higherRelated.has(id));
    if (missing.length > 0) {
      classes.push("ITEM_LOSS_WITH_NORMAL_RESPONSE");
      lost = [...lost, ...missing];
    }
    // §24: admission takes an authoritative-order prefix, so a lower budget's
    // entry that survives out of order at the higher budget is a priority
    // inversion — higher-priority evidence displaced by lower-priority evidence.
    const commonLower = lowerDelivered.related.filter((id) => higherRelated.has(id));
    const commonHigher = higherDelivered.related.filter((id) => lowerDelivered.related.includes(id));
    if (JSON.stringify(commonLower) !== JSON.stringify(commonHigher)) classes.push("PRIORITY_INVERSION");

    // §25 — a stronger representation preserves the same fact and ADDS detail.
    //
    // CALIBRATION. `codeTruncated` alone does not decide this. A skeletonized body
    // is not marked truncated and yet shows less of the symbol than a longer head
    // that is; treating the truncation flag as the downgrade signal reported 8x
    // more code arriving as a regression. What is measured is the code delivered:
    // losing the body outright, or being handed strictly less of it.
    if (lowerDelivered.focusCode && !higherDelivered.focusCode) classes.push("REPRESENTATION_DOWNGRADE");
    else if (higherDelivered.focusCodeCharacters < lowerDelivered.focusCodeCharacters) classes.push("REPRESENTATION_DOWNGRADE");

    // An interpretation-critical note may never be dropped for budget (§44).
    const higherNotes = new Set(higherDelivered.notes);
    if (lowerDelivered.notes.some((note) => !higherNotes.has(note))) classes.push("QUALIFIER_EVICTED");
  }

  return classes.length === 0 ? null : { lower, higher, classes, lostEvidence: lost };
}

/** Every ORDERED pair, which §60 calls the stronger metric. */
export function sweepLadder(authoritative: unknown, budgets: readonly number[]): {
  readonly ladder: readonly (Delivered & { budget: number })[];
  readonly violations: readonly PairViolation[];
} {
  const ladder = budgets.map((budget) => ({ budget, ...deliver(authoritative, budget) }));
  const violations: PairViolation[] = [];
  for (let i = 0; i < ladder.length; i += 1) {
    for (let j = i + 1; j < ladder.length; j += 1) {
      const violation = comparePair(ladder[i]!.budget, ladder[i]!, ladder[j]!.budget, ladder[j]!);
      if (violation !== null) violations.push(violation);
    }
  }
  return { ladder, violations };
}

export const hashOf = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex").slice(0, 16);

/**
 * §74's identity pins. Every field here is decided BEFORE the delivery budget is
 * considered, so two ladders that agree on them were packed from the same supply
 * in the same order — which is what makes a difference downstream attributable to
 * packing and to nothing else.
 */
export function authoritativeIdentity(authoritative: unknown): JsonRecord {
  const output = isRecord(authoritative) ? authoritative : {};
  const productContext = isRecord(output.productContext) ? output.productContext : {};
  const items = asArray(productContext.items);
  return {
    objectHash: hashOf(authoritative),
    leadPivot: String(productContext.leadPivot ?? ""),
    taskHash: String(productContext.taskHash ?? ""),
    selectedFileHash: String(productContext.selectedFileHash ?? ""),
    retrievalFound: productContext.retrievalFound === true,
    candidateSupplyHash: hashOf(items.map((item) => String(item.fqName ?? item.id ?? ""))),
    candidateOrderHash: hashOf(items.map((item, index) => `${index}:${String(item.fqName ?? item.id ?? "")}`)),
    neighborhoodHash: hashOf(asArray(output.pivotNeighborhood).map((n) => asArray(n.excerpts).map((e) => String(e.fqName ?? "")))),
    itemCount: items.length,
  };
}
