/**
 * What the agent is handed when the orientation projector declines.
 *
 *     FULL AUTHORITATIVE PIPELINE RESULT
 *              |
 *      ORIENTATION PROJECTOR  --- projects --->  compact orientation packet
 *              |
 *           declines
 *              |
 *      DECLINE PROJECTOR              <- this module
 *              |
 *      compact truthful non-answer    -> structuredContent AND content[0].text
 *
 * WHY THIS EXISTS. `projectRunPipelineOrientation` returns null on every state it
 * is not defined over, and `orientation ?? authoritativeResult` then handed the
 * model the whole authoritative result. That was defensible when the authoritative
 * result was the product. Under the compact default it is not: M174-A measured one
 * such response at 26,227 characters and 6,482 model-visible tokens to communicate
 * a single 186-character sentence, because the projector's decline is not a
 * failure envelope. It carries no `reason` and no `nextTool` — those belong to the
 * pre-assembly staleness envelopes, which never reach this path.
 *
 * WHAT THE 26,227 CHARACTERS WERE. 81.6% of that response was `request.query` and
 * `request.task`: the agent's own 10,611-character question, echoed back at it
 * twice. `productContext` was 6.1%, and `productContext.items` was empty. The
 * response contained no repository evidence at all.
 *
 * THE INVARIANT THIS MODULE ESTABLISHES, which is permanent:
 *
 *   A valid empty compact orientation must remain compact and truthful. It must
 *   never expose the full authoritative internal payload merely because no focus
 *   was selected.
 *
 * FAIL CLOSED, NOT FAIL SMALL. This module compacts ONLY states it can positively
 * identify from the authoritative record. An output whose shape it does not
 * recognise keeps its full authoritative envelope, because a terse answer about a
 * state we could not classify is exactly the dangerous answer the projector
 * declines to give. Compaction is earned by identification, never assumed.
 *
 * SOUND, NOT COMPLETE. Every string here is either verbatim authoritative or one
 * of the frozen phrases below. The module asserts nothing about the repository.
 *
 * PURE. No I/O, no clock, no randomness, no database.
 */

/**
 * The single decline boundary. It appears on EVERY declined result,
 * unconditionally, for the same reason `ORIENTATION_BOUNDARY` does: it is what
 * licenses reading the absence of a focus as something other than a claim about
 * the repository. A silent decline reads as "there is nothing there".
 */
export const DECLINE_BOUNDARY =
  "No focused orientation was selected from the current authoritative repository evidence. This is not an assertion that relevant code does not exist.";

export const DECLINE_SCHEMA_VERSION = "run_pipeline.orientation.none/1" as const;

/**
 * The states a decline can be in, as distinguished by §9: a valid empty
 * orientation must never be reported as a repository failure, and a repository
 * failure must never be softened into a valid empty orientation.
 */
export enum OrientationDeclineState {
  /** The index is not ready or not fresh enough to answer. A repository state. */
  RepositoryNotReady = "repository_not_ready",
  /** Retrieval ran and surfaced nothing sufficiently relevant. A retrieval state. */
  NoRelevantEvidence = "no_relevant_evidence",
  /** Evidence WAS found and then did not survive the response envelope. */
  EvidenceFoundButUndelivered = "evidence_found_but_undelivered",
  /** Resolved and delivered, but nothing carried a projectable identity. */
  NoFocusSelected = "no_focus_selected",
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

export interface OrientationDecline {
  readonly schemaVersion: typeof DECLINE_SCHEMA_VERSION;
  readonly state: OrientationDeclineState;
  /** A frozen phrase naming what happened. Never re-worded per call. */
  readonly summary: string;
  readonly boundary: string;
  /** The authoritative remedy, verbatim. Absent when the record states none. */
  readonly nextStep?: string;
  /** The authoritative top match, verbatim. A usable follow-up tool argument. */
  readonly topMatch?: string;
  /** Interpretation-critical only. Absent when there is nothing to say. */
  readonly notes?: readonly string[];
}

/**
 * The authoritative facts a decision needs, read once from the record so the
 * policy below is a decision and not a parser.
 */
export interface DeclineEvidence {
  /** The index reported itself ready. */
  readonly ready: boolean;
  /** Retrieval surfaced something relevant. */
  readonly retrievalFound: boolean;
  /** Something was found and then lost to the response envelope. */
  readonly deliveryFailed: boolean;
  /** Count of items that survived to the response. */
  readonly deliveredItems: number;
  /** Count of items retrieval selected before the envelope was applied. */
  readonly selectedBeforeBudget: number;
  /** Verbatim `topMatchReference` or `leadPivot`; empty when the record has none. */
  readonly topMatch: string;
  /** Verbatim freshness status, e.g. "fresh", "stale". */
  readonly freshnessStatus: string;
  /** Verbatim freshness reason. */
  readonly freshnessReason: string;
}

/**
 * Read the authoritative record into the facts the policy decides over.
 * Returns null when the output is not a shape this module recognises — the
 * fail-closed case, where the caller must keep the full authoritative envelope.
 */
export function readDeclineEvidence(output: unknown): DeclineEvidence | null {
  if (!isRecord(output)) return null;
  const productContext = isRecord(output.productContext) ? output.productContext : null;
  if (productContext === null) return null;

  const readiness = (() => {
    const diagnostics = isRecord(output.diagnostics) ? output.diagnostics : {};
    const freshness = isRecord(diagnostics.freshness) ? diagnostics.freshness : {};
    return isRecord(freshness.readiness) ? freshness.readiness : null;
  })();
  const delivery = isRecord(productContext.delivery) ? productContext.delivery : {};
  const freshness = isRecord(productContext.freshness) ? productContext.freshness : {};
  const items = Array.isArray(productContext.items) ? productContext.items.filter(isRecord) : [];

  return Object.freeze({
    ready: readiness === null ? true : readiness.ready === true,
    retrievalFound: productContext.retrievalFound !== false,
    deliveryFailed: productContext.deliveryFailed === true,
    deliveredItems: items.filter((item) => text(item.fqName) !== "").length,
    selectedBeforeBudget: typeof delivery.selectedItemsBeforeBudget === "number"
      ? delivery.selectedItemsBeforeBudget
      : items.length,
    topMatch: text(productContext.topMatchReference) !== ""
      ? text(productContext.topMatchReference)
      : text(productContext.leadPivot),
    freshnessStatus: text(freshness.status),
    freshnessReason: text(freshness.reason),
  });
}

/**
 * The frozen summary phrase for each state. One phrase per state, authored once
 * here, so no call site can re-word a claim into a stronger one.
 */
export const DECLINE_SUMMARIES: Readonly<Record<OrientationDeclineState, string>> = Object.freeze({
  [OrientationDeclineState.RepositoryNotReady]:
    "The repository index is not ready to answer this request.",
  [OrientationDeclineState.NoRelevantEvidence]:
    "Retrieval ran and surfaced no sufficiently relevant evidence for this task.",
  [OrientationDeclineState.EvidenceFoundButUndelivered]:
    "Relevant evidence was found, but none of it survived the response budget.",
  [OrientationDeclineState.NoFocusSelected]:
    "Evidence was delivered, but none of it carried an identity a focus could be selected from.",
});

/** Every phrase this module may author. Nothing else is written into a decline. */
export const DECLINE_FROZEN_PHRASES: readonly string[] = Object.freeze([
  DECLINE_BOUNDARY,
  ...Object.values(DECLINE_SUMMARIES),
]);

/**
 * Which state this decline is in, and whether the agent is told the top match.
 *
 * THE ORDER IS THE POLICY. `deliveryFailed` and `retrievalFound` are both true in
 * the matplotlib case — retrieval selected ten items and the response envelope
 * evicted all ten — so a test order that asked "did retrieval find anything?"
 * first would report a delivery failure as a successful empty search. Readiness
 * is tested before either, because a claim derived from an index that has not
 * declared itself ready is a claim about a stale snapshot.
 *
 * DISCLOSING THE TOP MATCH is allowed exactly where the authoritative record
 * genuinely holds a match:
 *
 *   EvidenceFoundButUndelivered   YES. Retrieval succeeded and the envelope lost
 *                                 the result. `topMatchReference` is real, it is a
 *                                 usable follow-up argument, and it costs ~15
 *                                 tokens against the 6,482 this path used to
 *                                 spend. Withholding it would make a recoverable
 *                                 state look like a dead end.
 *   NoFocusSelected               YES, when present. Same reasoning: something was
 *                                 delivered, it simply carried no projectable
 *                                 identity.
 *   NoRelevantEvidence            NO. Retrieval's own finding is that nothing was
 *                                 relevant. Naming a "top" match of an empty
 *                                 result set would manufacture a lead out of a
 *                                 non-answer — the precise failure the projector's
 *                                 sound-not-complete rule exists to prevent.
 *   RepositoryNotReady            NO. The index has not vouched for itself; a
 *                                 symbol read out of it is not yet a fact about
 *                                 the working tree.
 */
export function decideDecline(
  evidence: DeclineEvidence,
): { readonly state: OrientationDeclineState; readonly discloseTopMatch: boolean } {
  if (!evidence.ready) {
    return { state: OrientationDeclineState.RepositoryNotReady, discloseTopMatch: false };
  }
  if (!evidence.retrievalFound) {
    return { state: OrientationDeclineState.NoRelevantEvidence, discloseTopMatch: false };
  }
  if (evidence.deliveryFailed) {
    return { state: OrientationDeclineState.EvidenceFoundButUndelivered, discloseTopMatch: true };
  }
  return { state: OrientationDeclineState.NoFocusSelected, discloseTopMatch: true };
}

/**
 * Project an authoritative result the orientation projector declined into a
 * compact, truthful non-answer — or return null when the shape is unrecognised
 * and the full authoritative envelope must be kept.
 */
export function projectOrientationDecline(output: unknown): OrientationDecline | null {
  const evidence = readDeclineEvidence(output);
  if (evidence === null) return null;

  const { state, discloseTopMatch } = decideDecline(evidence);

  const notes: string[] = [];
  if (evidence.freshnessStatus !== "" && evidence.freshnessStatus !== "fresh") {
    // Verbatim authoritative status, for the same reason the orientation packet
    // renders it verbatim: a re-worded freshness claim is a strengthened one.
    notes.push(`Index freshness: ${evidence.freshnessStatus} (${evidence.freshnessReason}).`);
  }

  // The remedy is quoted from the authoritative record's own degraded context,
  // never authored here, so the decline can never invent a fix the product does
  // not actually offer.
  const nextStep = readAuthoritativeRemedy(output);

  return Object.freeze({
    schemaVersion: DECLINE_SCHEMA_VERSION,
    state,
    summary: DECLINE_SUMMARIES[state],
    boundary: DECLINE_BOUNDARY,
    ...(nextStep === "" ? {} : { nextStep }),
    ...(discloseTopMatch && evidence.topMatch !== "" ? { topMatch: evidence.topMatch } : {}),
    ...(notes.length === 0 ? {} : { notes: Object.freeze([...notes]) }),
  });
}

/**
 * The authoritative record's own remedy line, verbatim.
 *
 * `degradeOversizedProductResponse` writes a short "# VTRACE ..." block into
 * `modelVisibleContext` whose last line is the actionable one. Quoting that line
 * keeps the decline's advice identical to the product's, which is the only way it
 * can be guaranteed correct.
 */
function readAuthoritativeRemedy(output: unknown): string {
  if (!isRecord(output)) return "";
  const productContext = isRecord(output.productContext) ? output.productContext : null;
  if (productContext === null) return "";
  const context = text(productContext.modelVisibleContext);
  if (!context.startsWith("# VTRACE ")) return "";
  const lines = context.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const last = lines[lines.length - 1] ?? "";
  return last.startsWith("#") ? "" : last;
}

/**
 * M166's measured calibration for serialized tool-result JSON, reused so a
 * decline is measured on the same scale as the packet it replaces.
 */
const TOKENS_PER_CHARACTER = 0.3174032272551657;

export const declineTokens = (decline: OrientationDecline): number =>
  Math.max(0, Math.round(JSON.stringify(decline).length * TOKENS_PER_CHARACTER));
