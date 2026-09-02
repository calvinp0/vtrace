/**
 * The representation authority for the orientation packet: what a delivered
 * item's `code` IS, which items may carry one, and why an item received the
 * representation it did.
 *
 *     authoritative supply item ──► availableRepresentation ──► routing ──► packet
 *        (form, rendered body)        (form, bounded code)      (fits?)     (form, code)
 *
 * ONE SYSTEM, TWO SLOTS. Before M205 the focus carried `form`/`code`/
 * `codeTruncated` and every related entry carried a relationship claim and
 * nothing else, so the packet had exactly two representation classes: the
 * focus's own form and `relationship_only`. The authoritative rendering the
 * projector already reads carries a body for most related items — a
 * co-pivot's focused source, an index-derived structural skeleton, a parser
 * signature, a document excerpt — and paid for it upstream. This module lets a
 * related entry carry that body under the SAME three fields the focus uses,
 * with the same head-bound rule, so there is one item representation and not a
 * focus one and a related one.
 *
 * A CLASS IS A CONSTRUCTION RULE, NOT A LABEL. The forms admitted here are the
 * upstream content modes whose bodies are built by distinct, deterministic
 * rules from distinct authorities (`assembleProductContext.sourceDraft`,
 * `budgetDelivery`):
 *
 *   focused_source    the capsule's focused source body for a pivot
 *   full_source       a whole-symbol source body (declared upstream; unused today)
 *   excerpt           a body head-bounded by the evidence budget: a 900-character
 *                     head ending in the compaction marker, or the defining lines
 *   skeleton          the structural skeleton derived from the index: signature,
 *                     member signatures, docstring
 *   signature         the parser signature stored in the index
 *   document_excerpt  a line-bounded document/configuration excerpt
 *
 * Every other form — `summary` most of all, which is what impact lines,
 * memory observations and rule text are rendered as — is NOT source and never
 * becomes `code`. The table is exhaustive and FAILS CLOSED: a form absent from
 * it carries no code, so a new upstream mode can never leak into `code` under a
 * label the model would read as source. The label itself is carried verbatim
 * from upstream, never re-derived: the projector has no index and cannot tell a
 * skeleton from a signature, so it must not claim to.
 *
 * NO PHANTOM CLASSES. A representation is counted only when it is delivered.
 * What an item COULD have carried is recorded in the ledger as its available
 * representation, for the supply measurement, and appears in no packet.
 *
 * THE LADDER IS EXPLICIT. Each related entry is offered at most two forms, in
 * this order, and the first that fits the caller's ceiling is delivered:
 *
 *   1. its upstream form, head-bounded to `RELATED_CODE_CHARACTERS`
 *   2. relationship only — the pre-M205 entry, byte for byte
 *
 * There is no third rung: a body that does not fit at the bound is not cut
 * further to make it fit, because a tighter cut is a different excerpt than the
 * one whose size was declared. Relationship-only is always available and is
 * what a tight budget delivers.
 *
 * PURE. No I/O, no clock, no database.
 */

/** The one non-code representation: a relationship claim and a location. */
export const RELATIONSHIP_ONLY = "relationship_only" as const;

/**
 * Upstream content modes whose rendered body is source-backed text and may be
 * delivered as `code`. The `authority` names what the body is a rendering OF,
 * which is what an integrity check holds it to.
 */
export const CODE_BEARING_FORMS: Readonly<Record<string, { readonly authority: string }>> = Object.freeze({
  focused_source: { authority: "capsule focused source body: a verbatim slice of the indexed file within the item's span" },
  full_source: { authority: "whole-symbol source body: a verbatim slice of the indexed file within the item's span" },
  excerpt: { authority: "evidence-budget head of a body: a verbatim slice of the indexed file (a 900-character head followed by the compaction marker line, or the defining lines, at most eight)" },
  skeleton: { authority: "index-derived structural skeleton: the parser signature, member signatures and docstring" },
  signature: { authority: "the parser signature stored in the index, verbatim" },
  document_excerpt: { authority: "line-bounded document or configuration excerpt: a verbatim slice of the file within the item's span" },
});

export const isCodeBearingForm = (form: string): boolean => Object.hasOwn(CODE_BEARING_FORMS, form);

/**
 * Head bound on a related entry's code, in characters, cut on a line boundary.
 *
 * One third of the focus bound (1800). On the C-MED supply it covers three
 * quarters of co-pivot focused-source bodies, nine tenths of skeletons and
 * every signature whole, and it keeps the focus the largest item in any
 * packet. It is a declared bound, not a tuned one: the frozen representation
 * claim counts classes, not characters, and no value of this constant changes
 * whether a class is delivered.
 */
export const RELATED_CODE_CHARACTERS = 600;

/** The order in which a related entry's forms are tried. Explicit; nothing iterates a table to find it. */
export const REPRESENTATION_LADDER: readonly ["upstream_form", typeof RELATIONSHIP_ONLY] =
  Object.freeze(["upstream_form", RELATIONSHIP_ONLY]) as ["upstream_form", typeof RELATIONSHIP_ONLY];

/**
 * Why an item received the representation it did. Every delivered item carries
 * exactly one; the ledger records it and the analyzer holds it to the packet.
 *
 *   focus_slot                    the focus: its form and head bound are the focus rule
 *   upstream_form_delivered       the related entry carries its upstream form's body
 *   ceiling                       the body was available but the packet with it exceeded the ceiling
 *   no_rendered_body              the authoritative rendering carried no body for the item
 *   form_not_code_bearing         a body exists but its form is not source (summary, unknown)
 *   neighbour_text_not_carried    a pivot-neighbourhood entry: its excerpt text is stripped
 *                                 before the response reaches the projector
 */
export type RepresentationReason =
  | "focus_slot"
  | "upstream_form_delivered"
  | "ceiling"
  | "no_rendered_body"
  | "form_not_code_bearing"
  | "neighbour_text_not_carried";

export const REPRESENTATION_REASONS: readonly RepresentationReason[] = Object.freeze([
  "focus_slot", "upstream_form_delivered", "ceiling", "no_rendered_body", "form_not_code_bearing",
  "neighbour_text_not_carried",
]);

/** A representation an item could carry: its upstream form and the bounded body. */
export interface RepresentationCandidate {
  readonly form: string;
  readonly code: string;
  readonly truncated: boolean;
}

export type RepresentationAvailability =
  | { readonly available: true; readonly candidate: RepresentationCandidate }
  | { readonly available: false; readonly reason: "no_rendered_body" | "form_not_code_bearing" | "neighbour_text_not_carried" };

/** Head-bound a body on a line boundary, so a truncated excerpt is never a half line. */
export function headBound(body: string, limit: number): { readonly cut: string; readonly truncated: boolean } {
  if (body.length <= limit) return { cut: body, truncated: false };
  const slice = body.slice(0, limit);
  const lastNewline = slice.lastIndexOf("\n");
  const chosen = lastNewline > limit * 0.4 ? slice.slice(0, lastNewline) : slice;
  return { cut: chosen.trimEnd(), truncated: true };
}

/**
 * The richest representation an item's evidence supports, or the reason none
 * does. Deterministic in its inputs; reads nothing else.
 */
export function availableRepresentation(input: {
  readonly origin: "item_supply" | "pivot_neighborhood";
  readonly form: string;
  readonly body: string;
  readonly bound: number;
}): RepresentationAvailability {
  if (input.origin === "pivot_neighborhood") return { available: false, reason: "neighbour_text_not_carried" };
  if (input.body === "") return { available: false, reason: "no_rendered_body" };
  if (!isCodeBearingForm(input.form)) return { available: false, reason: "form_not_code_bearing" };
  const bounded = headBound(input.body, input.bound);
  if (bounded.cut === "") return { available: false, reason: "no_rendered_body" };
  return { available: true, candidate: { form: input.form, code: bounded.cut, truncated: bounded.truncated } };
}

/**
 * The representation class of a delivered item, from the item alone. The focus
 * is classed by its form, as it always was; a related entry is classed by the
 * form of the code it carries, or as relationship-only when it carries none.
 */
export function representationClassOf(
  item: { readonly form?: unknown; readonly code?: unknown },
  slot: "focus" | "related",
): string {
  if (slot === "focus") {
    return typeof item.form === "string" && item.form !== "" ? item.form : "unlabelled";
  }
  if (typeof item.code !== "string") return RELATIONSHIP_ONLY;
  return typeof item.form === "string" && item.form !== "" ? item.form : "unlabelled";
}
