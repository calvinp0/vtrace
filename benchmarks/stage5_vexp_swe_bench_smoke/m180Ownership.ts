/**
 * M180 — the item-ownership instrument.
 *
 * WHAT M179 LEFT. Its packer repair eliminated `orientation -> decline` outright,
 * and left 83 ordered budget pairs that still lose a related entry or move the
 * focus. Every one traces to `productContext.items`, which two different layers
 * believe they own.
 *
 * THE MEASUREMENT THAT MAKES IT VISIBLE. `applyProgressiveContextBudget` sets
 * `product.items` and RENDERS `product.modelVisibleContext` from the same
 * delivered list, so at the end of the evidence layer the two agree item for
 * item. Nothing between there and the wire rewrites the rendering except the
 * last-resort degradation, which replaces it wholesale and is separately
 * identifiable. So on any delivered response:
 *
 *     section ids of modelVisibleContext   = the EVIDENCE layer's supply
 *     ids of productContext.items          = what the PROJECTOR is handed
 *
 * and their difference is exactly the evidence whose text is still in the
 * payload while its index entry has been deleted for metadata bookkeeping. The
 * rendering is retry-proof: `retryWithinCeiling` re-enters the whole function at
 * a lower evidence budget, and the rendering it produces is that budget's.
 *
 * Do not use `responseBudget.compacted_fields` for this. It is
 * `[...new Set(fields)].sort().slice(0, reportedFields)` — alphabetically
 * truncated — so `productContext.items` drops off the report on exactly the
 * cases where it fired.
 *
 * PURE. Both functions under measurement are pure functions of the frozen
 * authoritative object, so a row is a deterministic function of (object, budget).
 */

import { createHash } from "node:crypto";

export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asArray = (value: unknown): readonly JsonRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

export const hashOf = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex").slice(0, 16);

/**
 * §16 — canonical semantic item identity.
 *
 * Everything the orientation projector can read out of an item and nothing else:
 * the symbol, where it is, how much of it is shown, what role it plays and the
 * claim made about it. `estimatedTokens`, `stableId` and every timing field are
 * excluded — they move for reasons that are not semantic.
 */
export const semanticItemIdentity = (item: JsonRecord): string => {
  const span = isRecord(item.lineSpan) ? item.lineSpan : null;
  const reasons = Array.isArray(item.selectionReasons) ? item.selectionReasons.map(text) : [];
  const roles = Array.isArray(item.roles) ? item.roles.map(text) : [];
  return [
    text(item.fqName),
    text(item.path),
    span === null ? "" : `${text(span.start)}-${text(span.end)}`,
    text(item.contentMode),
    roles.join(","),
    reasons[0] ?? "",
  ].join("|");
};

/** §17 — the ordered supply, hashed. */
export const semanticItemSupplyHash = (items: readonly JsonRecord[]): string =>
  hashOf(items.map(semanticItemIdentity));

/** Section ids of a rendered model-visible context, in rendered order. */
export function renderedSectionIds(rendered: unknown): readonly string[] {
  const ids: string[] = [];
  for (const section of text(rendered).split(/\n## /).slice(1)) {
    const match = /^\[([^\]]+)\]/.exec(section);
    if (match !== null) ids.push(match[1]!);
  }
  return ids;
}

/**
 * One (object, budget) observation of the ownership boundary.
 *
 * `evidenceSupply` is the evidence layer's own output, read off the rendering.
 * `projectorInput` is what survived the metadata layer. `withheld` is the gap:
 * evidence that is IN the response and unreachable by the projector.
 */
export interface OwnershipRow {
  readonly budget: number;
  /** Ids the evidence layer rendered — its delivered supply at the effective budget. */
  readonly evidenceSupply: readonly string[];
  /** Ids still carried by `productContext.items` when the projector runs. */
  readonly projectorInput: readonly string[];
  /** `evidenceSupply \ projectorInput`: rendered evidence with no index entry. */
  readonly withheld: readonly string[];
  /** Which layer removed them, inferred from the surviving shape. */
  readonly withheldBy: "none" | "mandatory_collapse" | "envelope_ladder_slice" | "degradation" | "unknown";
  readonly supplyHash: string;
  readonly projectorInputHash: string;
  /** True when the metadata layer changed the projector's semantic input at all. */
  readonly metadataMutatedSupply: boolean;
  readonly degraded: boolean;
}

/**
 * MIN_RETAINED_PRODUCT_ITEMS in `responseEnvelope.ts`. The ladder halves down to
 * this floor; the mandatory collapse goes to exactly one. That is what separates
 * the two rungs on a delivered response.
 */
const LADDER_FLOOR = 3;

export function observeOwnership(response: JsonRecord, budget: number): OwnershipRow {
  const productContext = isRecord(response.productContext) ? response.productContext : {};
  const items = asArray(productContext.items);
  const evidenceSupply = renderedSectionIds(productContext.modelVisibleContext);
  const projectorInput = items.map((item) => text(item.id));
  const present = new Set(projectorInput);
  const withheld = evidenceSupply.filter((id) => !present.has(id));
  const degraded = productContext.deliveryFailed === true || productContext.resolved !== true;

  const withheldBy = withheld.length === 0
    ? "none"
    : degraded
      ? "degradation"
      : projectorInput.length === 1 && evidenceSupply.length > 1
        ? "mandatory_collapse"
        : projectorInput.length >= LADDER_FLOOR
          ? "envelope_ladder_slice"
          : "unknown";

  return {
    budget,
    evidenceSupply,
    projectorInput,
    withheld,
    withheldBy,
    supplyHash: hashOf(evidenceSupply),
    projectorInputHash: hashOf(projectorInput),
    metadataMutatedSupply: withheld.length > 0 && !degraded,
    degraded,
  };
}

/**
 * §18's violation taxonomy, refined for M180. M179's `comparePair` names WHAT
 * changed between two budgets; this names WHY, by asking whether the lost
 * evidence was still in the larger budget's payload.
 */
export const M180_CLASS = Object.freeze({
  FocusChanged: "FOCUS_CHANGED",
  RelatedLost: "RELATED_ITEM_LOST",
  RelatedReplaced: "RELATED_ITEM_REPLACED",
  RoleChanged: "SEMANTIC_ROLE_CHANGED",
  RepresentationOnly: "REPRESENTATION_ONLY",
  NotReproduced: "NOT_REPRODUCED",
  Invalid: "INVALID_COMPARISON",
});

/**
 * §42 — the preservation semantics, fixed BEFORE anything is scored against it.
 *
 * M179's detector identified a related entry by `at|how`, which is right for the
 * question it asked and wrong for this one: it counts a claim getting STRONGER
 * as a loss. Two upgrades are real and measured on the current implementation:
 *
 *   CLAIM UPGRADE     the evidence layer empties `selectionReasons` when it
 *                     compacts, so the projector falls back to the roles string
 *                     ("pivot, required"). A larger budget restores the
 *                     authoritative reason ("actionable function — symbol-name
 *                     match; strong lexical match"). Same symbol, same fact,
 *                     more of it.
 *
 *   FOCUS RESOLUTION  a budget that can afford only one item may not be able to
 *                     afford `productContext.leadPivot`, so the projector falls
 *                     back. A larger budget delivering the declared lead is the
 *                     projector's own preference order being satisfied, not a
 *                     substitution.
 *
 * Both are DIRECTIONAL and the rule is symmetric: the reverse of either — the
 * authoritative reason decaying to the roles string, or the lead pivot being
 * abandoned for something else — is a violation. A rule that can only excuse is
 * not a rule.
 */
export interface PreservationVerdict {
  readonly violations: readonly string[];
  readonly benign: readonly string[];
  readonly lost: readonly string[];
}

export interface PreservationInput {
  readonly rank: number;
  readonly focus: string | null;
  readonly related: readonly string[];
  readonly notes: readonly string[];
  readonly focusCode: boolean;
  readonly focusCodeCharacters: number;
}

export const TERMINAL_ORIENTATION = 2;

const atOf = (identity: string): string => identity.split("|")[0] ?? identity;
const howOf = (identity: string): string => identity.slice(atOf(identity).length + 1);

/**
 * `rolesFallback` maps an fqName to the exact string the projector produces when
 * an item has no selection reason — `roles.join(", ")`. Built from the frozen
 * authoritative object, so it is a property of the case and not of a budget.
 */
export function comparePreservation(
  lower: PreservationInput,
  higher: PreservationInput,
  leadPivot: string,
  rolesFallback: ReadonlyMap<string, string>,
): PreservationVerdict {
  const violations: string[] = [];
  const benign: string[] = [];
  const lost: string[] = [];

  if (higher.rank < lower.rank) {
    violations.push(lower.rank === TERMINAL_ORIENTATION ? "ORIENTATION_TO_DECLINE" : "DECLINE_TO_REFUSED");
  }
  if (lower.rank !== TERMINAL_ORIENTATION || higher.rank !== TERMINAL_ORIENTATION) {
    return { violations, benign, lost };
  }

  if (lower.focus !== null && higher.focus !== lower.focus) {
    if (higher.focus === leadPivot && lower.focus !== leadPivot) benign.push("FOCUS_RESOLVED_TO_LEAD");
    else {
      violations.push("FOCUS_CHANGED");
      lost.push(`focus:${lower.focus}`);
    }
  }

  const higherByAt = new Map(higher.related.map((identity) => [atOf(identity), howOf(identity)]));
  for (const identity of lower.related) {
    if (higher.related.includes(identity)) continue;
    const at = atOf(identity);
    const higherHow = higherByAt.get(at);
    if (higherHow === undefined) {
      violations.push("RELATED_ITEM_LOST");
      lost.push(identity);
      continue;
    }
    const fallback = rolesFallback.get(at);
    const lowerWasFallback = fallback !== undefined && howOf(identity) === fallback;
    const higherIsFallback = fallback !== undefined && higherHow === fallback;
    if (lowerWasFallback && !higherIsFallback) benign.push("CLAIM_UPGRADED");
    else {
      violations.push(higherIsFallback ? "CLAIM_DOWNGRADED" : "SEMANTIC_ROLE_CHANGED");
      lost.push(identity);
    }
  }

  // §24 — admission takes an authoritative-order prefix, so an entry surviving
  // out of order at the larger budget is higher-priority evidence displaced.
  const higherAts = new Set(higher.related.map(atOf));
  const commonLower = lower.related.map(atOf).filter((at) => higherAts.has(at));
  const lowerAts = new Set(lower.related.map(atOf));
  const commonHigher = higher.related.map(atOf).filter((at) => lowerAts.has(at));
  if (JSON.stringify(commonLower) !== JSON.stringify(commonHigher)) violations.push("PRIORITY_INVERSION");

  if (lower.focusCode && !higher.focusCode) violations.push("REPRESENTATION_DOWNGRADE");
  else if (higher.focusCodeCharacters < lower.focusCodeCharacters) violations.push("REPRESENTATION_DOWNGRADE");

  const higherNotes = new Set(higher.notes);
  if (lower.notes.some((note) => !higherNotes.has(note))) violations.push("QUALIFIER_EVICTED");

  return { violations: [...new Set(violations)], benign: [...new Set(benign)], lost };
}

/** `fqName -> roles.join(", ")`, from the frozen authoritative object. */
export function rolesFallbackMap(authoritative: unknown): ReadonlyMap<string, string> {
  const output = isRecord(authoritative) ? authoritative : {};
  const productContext = isRecord(output.productContext) ? output.productContext : {};
  const map = new Map<string, string>();
  for (const item of asArray(productContext.items)) {
    const fqName = item.fqName === undefined || item.fqName === null ? "" : String(item.fqName);
    const roles = Array.isArray(item.roles) ? item.roles.map((role) => String(role)) : [];
    if (fqName !== "") map.set(fqName, roles.join(", "));
  }
  return map;
}
