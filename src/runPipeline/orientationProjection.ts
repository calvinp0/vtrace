/**
 * The agent-facing orientation projection.
 *
 *     FULL AUTHORITATIVE PIPELINE RESULT
 *              |
 *      ORIENTATION PROJECTOR          <- this module
 *              |
 *      bounded orientation packet     -> structuredContent AND content[0].text
 *
 * `run_pipeline` computes everything it always computed. What changed is what
 * the model is handed by default: the authoritative result stays server-side and
 * the agent receives the smallest truthful projection of it that supports a first
 * repository decision.
 *
 * WHY. M169 priced the full-disclosure response at $0.0985 a task to displace
 * $0.0026 of investigation — thirty-eight times its worth. M170 showed the cost
 * could not be recovered by mediating the agent's own reads. M171 showed the
 * price was a property of the DISCLOSURE and not of the product category: the
 * response is 21,318 characters and carries 895 characters of code, asserting 89
 * distinct facts across 146 surfaces. Projecting instead of serialising costs a
 * median of 603-621 model-visible tokens against 6,766-6,884, an eleven-fold
 * reduction, with gold file and gold symbol delivery unchanged to the percentage
 * point on two independent hundred-task corpora.
 *
 * Four rules make the design what it is.
 *
 *   SOUND, NOT COMPLETE       the packet may omit a supported fact; it may never
 *                             assert one the authoritative state does not
 *                             support. Every string below is either verbatim
 *                             authoritative or one of the frozen phrases.
 *
 *   NO FALSE ABSENCE          omission is not a negative claim, which is only
 *                             true because one global boundary line says so on
 *                             every resolved packet, unconditionally. A boundary
 *                             that appeared only sometimes would make its absence
 *                             informative — and its absence would fall exactly
 *                             where the packet is most selective.
 *
 *   ENOUGH, THEN STOP         the projector has no notion of remaining space, so
 *                             there is nothing for freed space to attract. M166
 *                             watched the packer refill an emptied envelope; this
 *                             cannot, because what ends a packet is the
 *                             authoritative supply running out and not a budget
 *                             being reached. Holdout supply is a median of 5 and
 *                             a maximum of 9; the ceiling does not engage until
 *                             46. A larger budget therefore admits MORE of the
 *                             same ranked supply and never acquires anything.
 *
 *   VERBATIM OR FROZEN        a claim is never re-worded. Re-wording is how
 *                             "potential caller" becomes "caller" and how "not
 *                             observed" becomes "absent".
 *
 * ONE BOUND, AND IT IS REAL. M171's projector declared a token ceiling, set it on
 * every rung, and read it nowhere; the bound that actually acted was an
 * undeclared count cap of five. On the clean holdout that cap withheld 66
 * authoritative related entries and bought nothing — delivering all 66 leaves
 * gold file and gold symbol delivery identical and the median packet at 621
 * tokens. So the cap is gone and the ceiling is enforced, checked against the
 * assembled packet rather than an estimate of one.
 *
 * AND IT IS THE CALLER'S. M172 froze the ceiling at 2000, M171's R2000 rung: a
 * product default sized on agent economics, applied to every request whatever
 * `max_tokens` said. M204 traced what that made of a caller's budget: at 16000
 * the evidence budget upstream delivered its supply with four fifths of the
 * budget unused, and the fixed ceiling would have stopped admission at 2000
 * packet tokens — 1575 in the caller's own chars/4 unit — had the supply ever
 * reached it. A ceiling the caller cannot raise is not a budget. So the ceiling
 * is now the caller's evidence budget stated in the packet's unit
 * (`orientationCeilingTokens`), and 2000 remains what it always was, the
 * default — applied only when no budget reached the projector at all.
 *
 * WHAT THE CEILING MAY NOT EVICT: the focus and the interpretation-critical
 * notes. A claim that cannot be rendered truthfully is omitted rather than
 * weakened, and a packet whose qualifier was dropped for budget is precisely the
 * overstrong rendering that rule forbids. The ceiling governs the related list.
 *
 * NOT A SECOND PIPELINE. There is one authoritative `run_pipeline`. This module
 * selects from its result; it computes nothing about the repository, ranks
 * nothing, scores nothing, and can surface no source the authoritative response
 * did not already carry. `detail=debug` returns the authoritative result whole.
 *
 * PURE. No I/O, no clock, no randomness, no database. Its item supply is read
 * through the productContext record's OBJECT IDENTITY rather than its value
 * (M180), so it is a deterministic function of the object it is handed and not
 * of that object's JSON alone.
 */

import { semanticItemSupplyOf } from "../productContext/semanticItemSupply";
import { MODEL_VISIBLE_CONTEXT_FOOTER } from "../productContext/types";
import {
  ORIENTATION_TOKENS_PER_CHARACTER,
  orientationTokensOfCharacters,
  publishOrientationAccounting,
  tokenDeviationBound,
  withItemTokens,
  type AccountingAbsence,
  type OrientationAccounting,
  type OrientationItemAccounting,
  type OrientationItemOrigin,
  type OrientationRejectedCandidate,
} from "./orientationAccounting";
import {
  RELATED_CODE_CHARACTERS,
  RELATIONSHIP_ONLY,
  availableRepresentation,
  headBound,
  representationClassOf,
  type RepresentationReason,
} from "./orientationRepresentation";

/**
 * The single global claim boundary. It appears on EVERY resolved packet, never
 * conditionally, because it is what licenses every omission the projector makes.
 */
export const ORIENTATION_BOUNDARY =
  "Focused orientation: task-relevant evidence selected from the indexed worktree, not an exhaustive repository listing. Items not shown are not thereby absent.";

export const ORIENTATION_TRUNCATION_NOTE = "The excerpt above is the head of a longer span.";

/**
 * The pivot-neighborhood relationship enum, rendered.
 *
 * The raw values are internal tokens. `fallback_symbol_window` means "another
 * symbol in the same file, reached by no edge at all", and shipping that token to
 * a model is both unreadable and an invitation to infer a relationship that does
 * not exist. Each phrase states a fact about the INDEX, never about the world,
 * and preserves the exact strength of the underlying claim: an indexed call edge
 * stays an indexed call edge, and the no-relationship case says so in words.
 *
 * Exhaustive over the reason enum and FAILS CLOSED: a reason absent from this
 * table carries no claim, so the neighbour is dropped rather than shipped under
 * an opaque or over-strong label. A new internal token can never leak by default.
 */
export const NEIGHBOR_RELATION_PHRASES: Readonly<Record<string, string>> = Object.freeze({
  caller: "calls the focus symbol (indexed call edge)",
  callee: "called by the focus symbol (indexed call edge)",
  importer: "imports the focus symbol's module (indexed import edge)",
  imported: "imported by the focus symbol's module (indexed import edge)",
  reference: "references the focus symbol (indexed reference edge)",
  sibling: "declared in the same scope as the focus symbol",
  support: "selected as supporting evidence for this task",
  fallback_symbol_window: "in the same file as the focus symbol; no indexed relationship to it",
});

/** Every phrase the projector may author. Nothing else is written into a packet. */
export const ORIENTATION_FROZEN_PHRASES: readonly string[] = Object.freeze([
  ORIENTATION_BOUNDARY,
  ORIENTATION_TRUNCATION_NOTE,
  ...Object.values(NEIGHBOR_RELATION_PHRASES),
]);

export const ORIENTATION_SCHEMA_VERSION = "run_pipeline.orientation/1" as const;

/**
 * The frozen policy. Qualified offline on two disjoint hundred-task corpora
 * before it was wired here; `benchmarks/.../results/stage5_m172_frozen_policy.json`
 * records why each value is what it is.
 */
export const ORIENTATION_POLICY = Object.freeze({
  /**
   * The DEFAULT model-visible token bound on the EVIDENCE packet — the items,
   * in the packet's framing, before each item's own `tokens` field is attached.
   * Applied only when the response carries no evidence budget for the projector
   * to read (`orientationCeilingTokens`); every budgeted response is bounded by
   * its own budget instead. Governs `related`. The accounting fields then ride
   * above the ceiling by a bounded amount the ledger states
   * (`accountingOverhead`), because testing the ceiling on the accounted packet
   * would let the description of the evidence evict the evidence. See
   * orientationAccounting.ts.
   *
   * It is a default and not a safety maximum: M172 took it from M171's R2000
   * rung on agent economics, and no transport or product bound stands behind
   * the number itself. The bounds that do stand are the caller's budget, the
   * upstream tier caps on supply, and the focus head bound below.
   */
  ceilingTokens: 2000,
  /** Head bound on the focus excerpt, in characters, cut on a line boundary. */
  focusCodeCharacters: 1800,
  /**
   * Head bound on a related entry's code, in characters, cut on the same line
   * rule. Owned by orientationRepresentation.ts; stated here so the policy is
   * one object.
   */
  relatedCodeCharacters: RELATED_CODE_CHARACTERS,
});

/**
 * Characters per token of the caller's budget: `max_tokens` is a chars/4 budget
 * on the model-visible context (src/capsuleV2/tokens.ts, budgetDelivery.ts),
 * and the packet is the model-visible output of the default path.
 */
export const ORIENTATION_CHARACTERS_PER_REQUESTED_TOKEN = 4;

/**
 * The evidence ceiling for one response, in the packet's own token rule.
 *
 * ONE RULE. The caller's evidence budget is `requested_context_tokens` — the
 * caller's `max_tokens`, or the product default the response was packed
 * against when the caller gave none — in chars/4 units. The packet's ceiling is
 * that budget stated in the packet's unit: requested tokens × 4 characters ×
 * the packet's tokens-per-character. Under the caller's own rule the two are
 * the same number of characters, so an evidence packet within this ceiling is
 * within the budget the caller stated, measured the way the caller stated it.
 *
 * A budget the projector cannot see falls back to `ORIENTATION_POLICY.ceilingTokens`.
 * Nothing is reserved here twice: the wrapper is inside the packet the ceiling
 * tests, the focus and the notes are never evicted by it, and the accounting
 * fields ride above it by the amount the ledger reports (M203).
 *
 * No upper bound is imposed beyond the caller's number, because none exists on
 * this path that the number would have to respect: `get_code_context` accepts
 * any non-negative integer, and the packet is bounded in fact by its supply —
 * the upstream tier caps and the neighbourhood caps — and in code by the focus
 * head bound. Inventing a maximum would be a second undeclared cap of exactly
 * the kind this rule replaces.
 */
export function orientationCeilingTokens(requestedContextTokens: number | AccountingAbsence): number {
  if (typeof requestedContextTokens !== "number" || !Number.isFinite(requestedContextTokens) || requestedContextTokens < 0) {
    return ORIENTATION_POLICY.ceilingTokens;
  }
  return orientationTokensOfCharacters(requestedContextTokens * ORIENTATION_CHARACTERS_PER_REQUESTED_TOKEN);
}

/**
 * M166's measured calibration for serialized tool-result JSON, 0.3174 tokens per
 * character over 363 provider-reported samples. `characters / 4` understates this
 * payload materially, which is why the ceiling is applied through it. The rule
 * itself is owned by `orientationAccounting.ts`, so the ceiling and the per-item
 * accounting can never be stated in different units.
 */
const TOKENS_PER_CHARACTER = ORIENTATION_TOKENS_PER_CHARACTER;

export const orientationTokens = (packet: OrientationPacket): number =>
  orientationTokensOfCharacters(JSON.stringify(packet).length);

export interface OrientationFocus {
  /** `path::Symbol` exactly as the authoritative state spells it. */
  readonly at: string;
  readonly file: string;
  readonly lines: string | null;
  /**
   * What `code` IS — full body, signature-only skeleton, and so on.
   * Interpretation-critical: a skeleton shown without this label reads as the
   * implementation.
   */
  readonly form: string | null;
  /** The authoritative selection reason, verbatim and unabridged. */
  readonly why: string | null;
  readonly code: string | null;
  readonly codeTruncated: boolean;
  /**
   * This item's own serialized cost in the packet, under the packet's token
   * rule, including this field. Per-item accounting (see orientationAccounting.ts).
   */
  readonly tokens: number;
}

export interface OrientationRelated {
  readonly at: string;
  readonly file: string;
  readonly lines: string | null;
  /** The authoritative relationship or role string, verbatim. Never strengthened. */
  readonly how: string;
  /**
   * The same three fields the focus carries, present TOGETHER or not at all
   * (M205). Absent, the entry is relationship-only and serializes exactly as it
   * did before any related entry could carry code. Present, `form` is the
   * upstream content mode verbatim — interpretation-critical for the same
   * reason as the focus's — and `code` is that form's body, head-bounded to
   * `ORIENTATION_POLICY.relatedCodeCharacters` on a line boundary.
   */
  readonly form?: string;
  readonly code?: string;
  readonly codeTruncated?: boolean;
  /** This item's own serialized cost in the packet, including this field. */
  readonly tokens: number;
}

export interface OrientationPacket {
  readonly schemaVersion: typeof ORIENTATION_SCHEMA_VERSION;
  readonly focus: OrientationFocus;
  readonly related: readonly OrientationRelated[];
  readonly boundary: string;
  /** Interpretation-critical only. Absent when there is nothing to say. */
  readonly notes?: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asArray = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

/**
 * Split the authoritative rendering into per-item bodies.
 *
 * This is the ONLY place a serialized response carries source text — pivot
 * neighborhood excerpt bodies are stripped before the response leaves the server.
 * Sourcing the projection's code from here is what keeps this a projection: the
 * packet can never show source the authoritative response does not already show.
 */
function parseRenderedBodies(rendered: string): ReadonlyMap<string, string> {
  const bodies = new Map<string, string>();
  if (rendered === "") return bodies;
  // The rendering closes with one framing line after the last item. It is not
  // part of any body: left in place it became the tail of the last item's code
  // (M205 found it inside a delivered skeleton), a line no source contains.
  const footerAt = rendered.lastIndexOf(`\n${MODEL_VISIBLE_CONTEXT_FOOTER}`);
  const withoutFooter = footerAt >= 0 && rendered.slice(footerAt + 1 + MODEL_VISIBLE_CONTEXT_FOOTER.length).trim() === ""
    ? rendered.slice(0, footerAt) : rendered;
  for (const section of withoutFooter.split(/\n## /).slice(1)) {
    const idMatch = /^\[([^\]]+)\]/.exec(section);
    if (idMatch === null) continue;
    const lines = section.split("\n");
    let cursor = 1;
    while (cursor < lines.length && /^(roles|mode|lines|why|kind|relation):/.test(lines[cursor]!)) cursor += 1;
    while (cursor < lines.length && lines[cursor]!.trim() === "") cursor += 1;
    bodies.set(idMatch[1]!, lines.slice(cursor).join("\n").trim());
  }
  return bodies;
}

/** The focus and related shapes as they stand at admission: every field but `tokens`. */
type EvidenceFocus = Omit<OrientationFocus, "tokens">;
type EvidenceRelated = Omit<OrientationRelated, "tokens">;

/**
 * Assemble a packet from its parts. Called with the evidence-only shapes while
 * the ceiling is tested and with the accounted shapes for delivery; the framing
 * is identical either way, which is what makes the two measurements comparable.
 */
function assemble<F extends EvidenceFocus, R extends EvidenceRelated>(
  focus: F,
  related: readonly R[],
  notes: readonly string[],
): OrientationPacket & { readonly focus: F; readonly related: readonly R[] } {
  return Object.freeze({
    schemaVersion: ORIENTATION_SCHEMA_VERSION,
    focus,
    related: Object.freeze([...related]),
    boundary: ORIENTATION_BOUNDARY,
    ...(notes.length === 0 ? {} : { notes: Object.freeze([...notes]) }),
  }) as OrientationPacket & { readonly focus: F; readonly related: readonly R[] };
}

const absent = (value: unknown, fallback: AccountingAbsence): number | AccountingAbsence =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * The evidence budget this response was packed against, in its own chars/4
 * units: the envelope's `requested_context_tokens`, or, when the envelope did
 * not carry it, the product context's own `budgetTokens`. One reading, used by
 * the ceiling and reported by the ledger, so the two can never disagree.
 */
function requestedContextTokensOf(
  responseBudget: Record<string, unknown>,
  productContext: Record<string, unknown>,
): number | AccountingAbsence {
  const requested = absent(responseBudget.requested_context_tokens, "unavailable");
  if (requested !== "unavailable") return requested;
  const accounting = isRecord(productContext.accounting) ? productContext.accounting : {};
  return absent(accounting.budgetTokens, "unavailable");
}

/**
 * Project an authoritative `run_pipeline` result into an orientation packet, or
 * return null when the result is not one the projection is defined over.
 *
 * Returning null is deliberate and is how failure semantics are preserved: a
 * stale index, an unready repository, a delivery failure or an empty retrieval
 * keeps its full, unambiguous authoritative envelope — `reason`, `nextTool`,
 * readiness and all. A compact success output does not license a vague failure
 * output, so the projector declines rather than compressing.
 */
export function projectRunPipelineOrientation(output: unknown): OrientationPacket | null {
  if (!isRecord(output)) return null;

  const productContext = isRecord(output.productContext) ? output.productContext : null;
  if (productContext === null) return null;
  if (productContext.resolved !== true) return null;
  if (productContext.retrievalFound === false) return null;
  if (productContext.deliveryFailed === true) return null;

  const readiness = (() => {
    const diagnostics = isRecord(output.diagnostics) ? output.diagnostics : {};
    const freshness = isRecord(diagnostics.freshness) ? diagnostics.freshness : {};
    return isRecord(freshness.readiness) ? freshness.readiness : null;
  })();
  if (readiness !== null && readiness.ready !== true) return null;

  const bodies = parseRenderedBodies(text(productContext.modelVisibleContext));
  // THE SUPPLY, NOT THE SERIALIZATION (M180). `productContext.items` is the
  // response envelope's to compact, and it compacts it by DELETING rows — one
  // rung reduced the array to a single entry, another halved it to a floor of
  // three, neither touching `modelVisibleContext`. Reading it here made a
  // bookkeeping operation decide what the agent is told: 72 of the 83
  // preservation violations M179 left, and on 167 of 169 frozen cases, at some
  // budget, the response shipped rendered evidence this projector could no
  // longer see. `applyProgressiveContextBudget` owns the evidence budget and
  // publishes what it delivered; that is what is read. When no supply was
  // published — a value that was copied or deserialized on the way here — the
  // fallback is the pre-M180 source, which is the safe direction to fail in.
  const supply = semanticItemSupplyOf(productContext) ?? asArray(productContext.items);
  const items = asArray(supply)
    .filter((item) => text(item.fqName) !== "")
    .map((item) => {
      const span = isRecord(item.lineSpan) ? item.lineSpan : null;
      return {
        id: text(item.id),
        fqName: text(item.fqName),
        path: text(item.path),
        lines: span === null ? null : `${text(span.start)}-${text(span.end)}`,
        contentMode: text(item.contentMode),
        roles: Array.isArray(item.roles) ? item.roles.map(text) : [],
        reasons: Array.isArray(item.selectionReasons) ? item.selectionReasons.map(text) : [],
        body: bodies.get(text(item.id)) ?? "",
        // Carried for the ledger only: the evidence budget's own chars/4 figure
        // for this item, in its own units. Read nowhere in this function.
        upstreamEstimatedTokens: absent(item.estimatedTokens, "unavailable"),
      };
    });
  if (items.length === 0) return null;

  const leadPivot = text(productContext.leadPivot);
  const focusItem = items.find((item) => item.fqName === leadPivot)
    ?? items.find((item) => item.roles.includes("pivot"))
    ?? items[0]!;

  const bounded = headBound(focusItem.body, ORIENTATION_POLICY.focusCodeCharacters);
  const focus: EvidenceFocus = Object.freeze({
    at: focusItem.fqName,
    file: focusItem.path,
    lines: focusItem.lines,
    form: focusItem.contentMode === "" ? null : focusItem.contentMode,
    why: focusItem.reasons[0] ?? null,
    code: bounded.cut === "" ? null : bounded.cut,
    codeTruncated: bounded.truncated,
  });

  // Interpretation-critical notes only. Everything else stays in the
  // authoritative result and is reachable at detail=debug.
  const notes: string[] = [];
  const freshness = isRecord(productContext.freshness) ? productContext.freshness : {};
  const freshnessStatus = text(freshness.status);
  if (freshnessStatus !== "" && freshnessStatus !== "fresh") {
    // Verbatim authoritative status: a re-worded freshness claim is exactly the
    // kind of strengthening the verbatim rule exists to prevent.
    notes.push(`Index freshness: ${freshnessStatus} (${text(freshness.reason)}).`);
  }
  const routing = isRecord(output.workspaceRouting) ? output.workspaceRouting : {};
  if (routing.isWorkspace === true && text(routing.outcome) !== "single_repository") {
    notes.push(`Workspace routing: ${text(routing.outcome)}. ${text(routing.reason)}`);
  }
  if (focus.codeTruncated) notes.push(ORIENTATION_TRUNCATION_NOTE);

  // The admissible list, in AUTHORITATIVE order. Items first, then pivot
  // neighbours; admission takes a prefix, which is what keeps a tighter bound's
  // output a subset of a looser one's. No re-ranking, ever.
  const seen = new Set<string>([focusItem.fqName]);
  // Every route that proposed each identity, in proposal order. The FIRST
  // proposal is the one that is admitted; later ones are deduplicated and
  // recorded, never delivered twice. The focus's own proposals are recorded too.
  const proposals = new Map<string, OrientationItemOrigin[]>();
  const propose = (fqName: string, origin: OrientationItemOrigin): void => {
    proposals.set(fqName, [...(proposals.get(fqName) ?? []), origin]);
  };
  interface Candidate {
    readonly entry: EvidenceRelated;
    readonly origin: OrientationItemOrigin;
    readonly reasonSource: OrientationItemAccounting["reasonSource"];
    readonly sourceId: string | AccountingAbsence;
    readonly upstreamEstimatedTokens: number | AccountingAbsence;
    readonly bodyCharacters: number | AccountingAbsence;
    /** The upstream content mode and rendered body, read by representation routing only. */
    readonly form: string;
    readonly body: string;
  }
  const candidates: Candidate[] = [];
  let droppedNoClaim = 0;
  const consider = (
    fqName: string, path: string, lines: string | null, how: string,
    provenance: Omit<Candidate, "entry">,
  ): void => {
    if (fqName === "") return;
    propose(fqName, provenance.origin);
    if (seen.has(fqName)) return;
    if (how === "") { droppedNoClaim += 1; return; }
    seen.add(fqName);
    candidates.push({ entry: Object.freeze({ at: fqName, file: path, lines, how }), ...provenance });
  };
  for (const item of items) {
    // The item's own first selection reason IS the relationship claim the
    // authoritative state makes about it. Reused verbatim; never generalized.
    consider(item.fqName, item.path, item.lines, item.reasons[0] ?? item.roles.join(", "), {
      origin: "item_supply",
      reasonSource: item.reasons[0] === undefined ? "roles" : "selection_reason",
      sourceId: item.id === "" ? "unavailable" : item.id,
      upstreamEstimatedTokens: item.upstreamEstimatedTokens,
      bodyCharacters: item.body.length,
      form: item.contentMode,
      body: item.body,
    });
  }
  for (const neighborhood of asArray(output.pivotNeighborhood)) {
    for (const excerpt of asArray(neighborhood.excerpts)) {
      consider(
        text(excerpt.fqName),
        text(excerpt.filePath),
        `${text(excerpt.startLine)}-${text(excerpt.endLine)}`,
        NEIGHBOR_RELATION_PHRASES[text(excerpt.reason)] ?? "",
        {
          origin: "pivot_neighborhood",
          reasonSource: "neighbor_relation",
          sourceId: "not_applicable",
          upstreamEstimatedTokens: "not_applicable",
          // The excerpt body is stripped before the response leaves the server;
          // its size survives as `textCharacters` when the envelope recorded it.
          bodyCharacters: typeof excerpt.text === "string"
            ? excerpt.text.length : absent(excerpt.textCharacters, "unavailable"),
          form: "",
          body: "",
        },
      );
    }
  }

  // The ceiling for THIS response: the caller's evidence budget in the packet's
  // unit, read from the same place the ledger reports it, before any admission.
  const responseBudget = isRecord(output.responseBudget) ? output.responseBudget : {};
  const requestedContextTokens = requestedContextTokensOf(responseBudget, productContext);
  const ceilingTokens = orientationCeilingTokens(requestedContextTokens);

  // Admission, unchanged in form: a prefix of the admissible list, tested on the
  // evidence packet. What each test saw is recorded for the ledger and read by
  // nothing else — the loop below is exactly the loop that ran before any
  // accounting existed, against a ceiling that is now the caller's.
  const related: EvidenceRelated[] = [];
  const admitted: Candidate[] = [];
  const admissionPacketTokens: number[] = [orientationTokens(assemble(focus, [], notes))];
  const rejected: OrientationRejectedCandidate[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const next = [...related, candidate.entry];
    const packetTokens = orientationTokens(assemble(focus, next, notes));
    if (packetTokens > ceilingTokens) {
      rejected.push(Object.freeze({
        at: candidate.entry.at, origin: candidate.origin, proposedOrdinal: index + 1,
        estimatedTokens: orientationTokensOfCharacters(JSON.stringify(candidate.entry).length),
        admissionPacketTokens: packetTokens, reason: "ceiling",
      }));
      break;
    }
    related.push(candidate.entry);
    admitted.push(candidate);
    admissionPacketTokens.push(packetTokens);
  }

  // Representation (M205): WHAT each admitted entry carries, decided after and
  // never instead of WHICH entries are admitted. The set and order above are
  // exactly the pre-M205 set and order — admission tested relationship-only
  // entries, so a tighter budget still delivers a prefix of a looser one's
  // items — and this pass walks that set in the same authoritative order,
  // offering each entry its upstream form, head-bounded, and keeping it only
  // when the packet with it stays within the caller's ceiling. Later entries
  // are still relationship-only when an earlier one is tested, so the test is
  // conservative: an upgrade can never evict an item the ceiling admitted.
  // The first entry in rank order is offered richness first; nothing here
  // re-ranks, re-derives a body, or cuts one further than the declared bound.
  const compactAdmissionPacketTokens = [...admissionPacketTokens];
  const delivered: EvidenceRelated[] = [...related];
  const representationRouting: {
    readonly reason: RepresentationReason;
    readonly availableRepresentation: string | AccountingAbsence;
    readonly availableCodeCharacters: number | AccountingAbsence;
  }[] = [];
  for (const [index, candidate] of admitted.entries()) {
    const availability = availableRepresentation({
      origin: candidate.origin, form: candidate.form, body: candidate.body,
      bound: ORIENTATION_POLICY.relatedCodeCharacters,
    });
    if (availability.available === false) {
      representationRouting.push({ reason: availability.reason, availableRepresentation: "not_applicable", availableCodeCharacters: "not_applicable" });
      admissionPacketTokens[index + 1] = orientationTokens(assemble(focus, delivered, notes));
      continue;
    }
    const { form, code, truncated } = availability.candidate;
    const rich: EvidenceRelated = Object.freeze({ ...candidate.entry, form, code, codeTruncated: truncated });
    const trial = delivered.map((entry, k) => (k === index ? rich : entry));
    const trialTokens = orientationTokens(assemble(focus, trial, notes));
    if (trialTokens <= ceilingTokens) {
      delivered[index] = rich;
      representationRouting.push({ reason: "upstream_form_delivered", availableRepresentation: form, availableCodeCharacters: code.length });
      admissionPacketTokens[index + 1] = trialTokens;
    } else {
      representationRouting.push({ reason: "ceiling", availableRepresentation: form, availableCodeCharacters: code.length });
      admissionPacketTokens[index + 1] = orientationTokens(assemble(focus, delivered, notes));
    }
  }
  const evidencePacket = assemble(focus, delivered, notes);

  // Delivery: the same items, in the same order, each now stating its own cost.
  const accountedFocus = withItemTokens(focus);
  const accountedRelated = delivered.map((entry) => withItemTokens(entry));
  const packet = assemble(accountedFocus, accountedRelated, notes);

  publishOrientationAccounting(packet, ledgerFor({
    packet, evidencePacket, focus: accountedFocus, related: accountedRelated,
    focusProvenance: {
      origin: "item_supply",
      origins: proposals.get(focusItem.fqName) ?? ["item_supply"],
      sourceId: focusItem.id === "" ? "unavailable" : focusItem.id,
      reasonSource: focusItem.reasons[0] === undefined ? "roles" : "selection_reason",
      upstreamEstimatedTokens: focusItem.upstreamEstimatedTokens,
      bodyCharacters: focusItem.body.length,
    },
    admitted: admitted.map((c, k) => ({ ...c, origins: proposals.get(c.entry.at) ?? [c.origin], routing: representationRouting[k]! })),
    admissionPacketTokens, compactAdmissionPacketTokens, rejected,
    proposed: [...proposals.values()].reduce((n, list) => n + list.length, 0),
    deduplicated: [...proposals.values()].reduce((n, list) => n + list.length - 1, 0),
    droppedNoClaim,
    notReached: candidates.length - admitted.length - rejected.length,
    productContext, responseBudget, requestedContextTokens, ceilingTokens,
  }));

  return packet;
}

/**
 * Build the ledger from what the projector already decided. Pure bookkeeping:
 * every number is a measurement of a serialization that exists, or a value
 * copied from the authoritative result under its own label.
 */
function ledgerFor(input: {
  readonly packet: OrientationPacket;
  readonly evidencePacket: object;
  readonly focus: OrientationFocus;
  readonly related: readonly OrientationRelated[];
  readonly focusProvenance: {
    readonly origin: OrientationItemOrigin; readonly origins: readonly OrientationItemOrigin[];
    readonly sourceId: string | AccountingAbsence;
    readonly reasonSource: OrientationItemAccounting["reasonSource"];
    readonly upstreamEstimatedTokens: number | AccountingAbsence;
    readonly bodyCharacters: number | AccountingAbsence;
  };
  readonly admitted: readonly {
    readonly entry: object; readonly origin: OrientationItemOrigin;
    readonly origins: readonly OrientationItemOrigin[];
    readonly reasonSource: OrientationItemAccounting["reasonSource"];
    readonly sourceId: string | AccountingAbsence;
    readonly upstreamEstimatedTokens: number | AccountingAbsence;
    readonly bodyCharacters: number | AccountingAbsence;
    readonly routing: {
      readonly reason: RepresentationReason;
      readonly availableRepresentation: string | AccountingAbsence;
      readonly availableCodeCharacters: number | AccountingAbsence;
    };
  }[];
  readonly admissionPacketTokens: readonly number[];
  readonly compactAdmissionPacketTokens: readonly number[];
  readonly rejected: readonly OrientationRejectedCandidate[];
  readonly proposed: number;
  readonly deduplicated: number;
  readonly droppedNoClaim: number;
  readonly notReached: number;
  readonly productContext: Record<string, unknown>;
  readonly responseBudget: Record<string, unknown>;
  readonly requestedContextTokens: number | AccountingAbsence;
  readonly ceilingTokens: number;
}): OrientationAccounting {
  const { focus, related } = input;
  const items: OrientationItemAccounting[] = [];
  let cumulativeCharacters = 0;
  let cumulativeTokens = 0;
  const push = (record: Omit<OrientationItemAccounting, "cumulativeCharacters" | "cumulativeTokens">): void => {
    cumulativeCharacters += record.characters;
    cumulativeTokens += record.actualTokens;
    items.push(Object.freeze({ ...record, cumulativeCharacters, cumulativeTokens }));
  };

  const { tokens: focusTokens, ...focusEvidence } = focus;
  push({
    at: focus.at, ordinal: 0, slot: "focus",
    representation: representationClassOf(focus, "focus"),
    representationReason: "focus_slot",
    availableRepresentation: representationClassOf(focus, "focus"),
    availableCodeCharacters: focus.code?.length ?? 0,
    origin: input.focusProvenance.origin, origins: Object.freeze([...input.focusProvenance.origins]),
    sourceId: input.focusProvenance.sourceId,
    reason: focus.why ?? "", reasonSource: input.focusProvenance.reasonSource,
    upstreamEstimatedTokens: input.focusProvenance.upstreamEstimatedTokens,
    bodyCharacters: input.focusProvenance.bodyCharacters,
    deliveredCodeCharacters: focus.code?.length ?? 0,
    codeDelivered: focus.code !== null,
    truncated: focus.codeTruncated,
    estimatedTokens: orientationTokensOfCharacters(JSON.stringify(focusEvidence).length),
    compactAdmissionPacketTokens: input.compactAdmissionPacketTokens[0]!,
    admissionPacketTokens: input.admissionPacketTokens[0]!,
    characters: JSON.stringify(focus).length,
    actualTokens: focusTokens,
  });
  for (const [index, entry] of related.entries()) {
    const provenance = input.admitted[index]!;
    const { tokens, ...evidence } = entry;
    const representation = representationClassOf(entry, "related");
    push({
      at: entry.at, ordinal: index + 1, slot: "related",
      representation,
      representationReason: provenance.routing.reason,
      availableRepresentation: provenance.routing.availableRepresentation,
      availableCodeCharacters: provenance.routing.availableCodeCharacters,
      origin: provenance.origin, origins: Object.freeze([...provenance.origins]),
      sourceId: provenance.sourceId,
      reason: entry.how, reasonSource: provenance.reasonSource,
      upstreamEstimatedTokens: provenance.upstreamEstimatedTokens,
      bodyCharacters: provenance.bodyCharacters,
      deliveredCodeCharacters: representation === RELATIONSHIP_ONLY ? 0 : entry.code!.length,
      codeDelivered: representation !== RELATIONSHIP_ONLY,
      truncated: entry.codeTruncated === true,
      estimatedTokens: orientationTokensOfCharacters(JSON.stringify(evidence).length),
      compactAdmissionPacketTokens: input.compactAdmissionPacketTokens[index + 1]!,
      admissionPacketTokens: input.admissionPacketTokens[index + 1]!,
      characters: JSON.stringify(entry).length,
      actualTokens: tokens,
    });
  }

  const packetCharacters = JSON.stringify(input.packet).length;
  const packetTokens = orientationTokensOfCharacters(packetCharacters);
  const evidenceCharacters = JSON.stringify(input.evidencePacket).length;
  const evidenceTokens = orientationTokensOfCharacters(evidenceCharacters);
  const itemCharacters = cumulativeCharacters;
  const itemTokens = cumulativeTokens;
  const wrapperCharacters = packetCharacters - itemCharacters;
  const wrapperTokens = orientationTokensOfCharacters(wrapperCharacters);

  const delivery = isRecord(input.productContext.delivery) ? input.productContext.delivery : {};
  const accounting = isRecord(input.productContext.accounting) ? input.productContext.accounting : {};
  const requested = input.requestedContextTokens;

  const ledger: OrientationAccounting = {
    tokenRule: { method: "characters_times_tokens_per_character",
      tokensPerCharacter: TOKENS_PER_CHARACTER, rounding: "nearest" },
    ceilingTokens: input.ceilingTokens,
    ceilingAppliesTo: "evidence_packet",
    ceilingDerivation: {
      source: typeof requested === "number" ? "requested_context_tokens" : "policy_default",
      requestedContextTokens: requested,
      charactersPerRequestedToken: ORIENTATION_CHARACTERS_PER_REQUESTED_TOKEN,
      defaultCeilingTokens: ORIENTATION_POLICY.ceilingTokens,
    },
    evidence: { characters: evidenceCharacters, tokens: evidenceTokens,
      withinCeiling: evidenceTokens <= input.ceilingTokens },
    packet: { characters: packetCharacters, tokens: packetTokens },
    accountingOverhead: { characters: packetCharacters - evidenceCharacters,
      tokens: packetTokens - evidenceTokens },
    wrapper: { characters: wrapperCharacters, tokens: wrapperTokens },
    reconciliation: {
      itemCharacters, wrapperCharacters, packetCharacters,
      charactersExact: itemCharacters + wrapperCharacters === packetCharacters,
      itemTokens, wrapperTokens, packetTokens,
      tokenDeviation: Math.abs(packetTokens - (itemTokens + wrapperTokens)),
      tokenDeviationBound: tokenDeviationBound(items.length + 2),
    },
    candidates: {
      proposed: input.proposed,
      deduplicated: input.deduplicated,
      droppedNoClaim: input.droppedNoClaim,
      admitted: items.length,
      rejectedForCeiling: input.rejected.length,
      notReached: input.notReached,
      rejected: Object.freeze([...input.rejected]),
    },
    evidenceBudget: {
      method: "characters_div_4",
      requestedTokens: requested,
      modelVisibleTokens: absent(delivery.finalModelTokens, "unavailable") === "unavailable"
        ? absent(accounting.usedTokensEstimate, "unavailable") : absent(delivery.finalModelTokens, "unavailable"),
      remainingTokens: absent(accounting.remainingTokensEstimate, "unavailable"),
      deliveryStatus: typeof delivery.status === "string" ? delivery.status : "unavailable",
      selectedItemsBeforeBudget: absent(delivery.selectedItemsBeforeBudget, "unavailable"),
      deliveredItems: absent(delivery.deliveredItems, "unavailable"),
      droppedForBudget: absent(delivery.droppedForBudget, "unavailable"),
      compactionStages: Array.isArray(delivery.compactionStages)
        ? Object.freeze(delivery.compactionStages.map(text)) : "unavailable",
    },
    items: Object.freeze(items),
  };
  return Object.freeze(ledger);
}
