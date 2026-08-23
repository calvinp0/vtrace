/**
 * M175 — request-echo attribution and the disclosure policies under evaluation.
 *
 * THE DEFECT, IN ONE SENTENCE. `compactProductResponse` reduces or drops every
 * large field in a response except one, and that one is the caller's own question
 * carried twice; when the total ceiling binds, the only thing left to evict is
 * the repository evidence.
 *
 * THE LADDER, IN THE ORDER IT ACTUALLY RUNS (responseEnvelope.ts):
 *
 *   applyProgressiveContextBudget    bounds modelVisibleContext
 *   compactProductContextItems       drops duplicated source bodies
 *   compactCapsuleResult / …         reduces compatibility representations
 *   reduceDiagnosticsToAgentFacing   holds machine-facing diagnostics for debug
 *   enforceTotalEnvelope             tiered drops, incl. LAST_RESORT sections
 *   compactMandatoryProductMetadata  per-item metadata down to a floor
 *   compactNonessentialEnvelopeMetadata
 *   degradeOversizedProductResponse  ← items = [], deliveryFailed = true
 *
 * `request` appears at no rung. responseEnvelope.ts:1288 says why: "`request`
 * echoes the caller's own input verbatim and is a correctness surface, so it is
 * never rewritten." That exemption is the subject of this milestone. It is a
 * defensible rule for a field nobody pays for, and `request` is not that field.
 *
 * WHY REPLAY RATHER THAN RE-RUN. A policy is a transform of the authoritative
 * result, and compaction is a pure function of it, so both arms can be evaluated
 * from ONE captured snapshot. That is not a convenience: it is what makes §24's
 * critical isolation mechanical rather than argued. Retrieval, ranking, pivot
 * selection and the pre-envelope evidence selection are literally the same
 * objects on both sides, because they are the same bytes.
 *
 * ONE APPROXIMATION, DECLARED. The snapshot is captured at `detail=debug`, which
 * has already had the debug-permitted reductions applied to it. Absolute token
 * figures are therefore a lower bound on what a standard-detail response assembles
 * from. The DELTA between policies is exact, because the identical snapshot enters
 * both arms. `validateReplay` below checks the replay reproduces the independently
 * captured pathological outcome before any delta is believed.
 *
 * PURE apart from the explicit capture helper. No agent, no Docker, no paid API.
 */

import { compactProductResponse, McpResponseDetail } from "../../src/mcp/responseEnvelope";

export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The envelope's own estimator, reproduced. The envelope measures itself with
 * chars/4 (`estimate_method: "chars_div_4"`), so the ceiling arithmetic must use
 * chars/4 too — M166's 0.3174 tokens/char is the better estimate of what a
 * PROVIDER bills, and using it here would compare a policy against a bound the
 * product does not actually apply.
 */
export const envelopeTokens = (value: unknown): number =>
  Math.ceil(JSON.stringify(value ?? null).length / 4);

/** M166's measured provider rate, for reporting what the model is billed. */
const PROVIDER_TOKENS_PER_CHARACTER = 0.3174032272551657;
export const billedTokens = (value: unknown): number =>
  Math.max(0, Math.round(JSON.stringify(value ?? null).length * PROVIDER_TOKENS_PER_CHARACTER));

// ── the policies ──

/**
 * The candidate disclosure policies. Each is a pure transform of the
 * authoritative result, applied BEFORE compaction, so what it changes is what the
 * envelope has to fit — not merely what survives.
 *
 * Only policies the M175-A authority audit admits appear here (§26). The audit
 * found zero product consumers of the shipped `request` block and proved
 * `request.task` identical to `request.query` in 199 of 199 captures, so every
 * policy below preserves every consumer that exists.
 */
export enum DisclosurePolicy {
  /** Ship both verbatim copies. Today's behaviour. */
  Current = "CURRENT",
  /** Keep `task` verbatim; `query` becomes the reference the envelope already uses. */
  TaskOnly = "TASK_ONLY",
  /** Keep `query` verbatim; `task` becomes a reference. The mirror image. */
  QueryOnly = "QUERY_ONLY",
  /** No verbatim request prose. Compact identity only. */
  IdentityOnly = "IDENTITY_ONLY",
  /** No request block at all in the default projection. */
  NoDisclosure = "NO_REQUEST_DISCLOSURE",
}

/**
 * The reference the envelope ALREADY writes in place of a repeated task copy
 * (`responseEnvelope.ts:135`), reused verbatim. `productContext.task` has shipped
 * as this string since before M175; the milestone widens an existing idiom rather
 * than inventing a notation the caller has never seen.
 */
export const TASK_REFERENCE = "@request.task";
export const QUERY_REFERENCE = "@request.query";

/**
 * What stands in place of the caller's own prose in the default projection.
 * Frozen: never re-worded per call, and truthful about both what was removed and
 * how to retrieve it.
 */
export const REQUEST_PROSE_OMITTED =
  "@omitted: supplied by the caller; returned verbatim at detail=debug";

export function applyPolicy<T>(output: T, policy: DisclosurePolicy): T {
  const draft = structuredClone(output) as unknown as JsonRecord;
  const request = isRecord(draft.request) ? draft.request : undefined;
  if (request === undefined) return draft as unknown as T;

  switch (policy) {
    case DisclosurePolicy.Current:
      break;
    case DisclosurePolicy.TaskOnly:
      if (typeof request.query === "string") request.query = TASK_REFERENCE;
      break;
    case DisclosurePolicy.QueryOnly:
      if (typeof request.task === "string") request.task = QUERY_REFERENCE;
      break;
    case DisclosurePolicy.IdentityOnly:
      // No verbatim prose, and no hash either. §19: a digest the model cannot act
      // on is still model-visible overhead, and the MCP envelope already binds a
      // response to its request by `requestId`, so nothing here needs an identity
      // the protocol does not already carry.
      //
      // The marker is not decoration. Silently deleting the field would make its
      // absence informative in a response whose whole design rests on omission
      // carrying no claim — the same no-false-absence rule the orientation
      // boundary exists to satisfy. It says what was removed and where to get it.
      if (typeof request.task === "string") request.task = REQUEST_PROSE_OMITTED;
      if (typeof request.query === "string") request.query = TASK_REFERENCE;
      break;
    case DisclosurePolicy.NoDisclosure:
      delete draft.request;
      break;
  }
  return draft as unknown as T;
}

// ── attribution ──

export interface EchoAttribution {
  readonly requestBlockCharacters: number;
  readonly requestBlockTokens: number;
  readonly taskCharacters: number;
  readonly queryCharacters: number;
  readonly verbatimEchoCharacters: number;
  readonly verbatimEchoTokens: number;
  readonly duplicatedEchoCharacters: number;
  readonly identical: boolean;
  readonly totalCharacters: number;
  readonly totalTokens: number;
  readonly echoShareOfResponse: number;
  readonly evidenceCharacters: number;
  readonly evidenceTokens: number;
}

/** Measure the echo against the response that carries it. */
export function attributeEcho(output: unknown): EchoAttribution {
  const record = isRecord(output) ? output : {};
  const request = isRecord(record.request) ? record.request : {};
  const task = typeof request.task === "string" ? request.task : "";
  const query = typeof request.query === "string" ? request.query : "";
  const identical = task !== "" && task === query;
  const productContext = isRecord(record.productContext) ? record.productContext : {};
  const evidence = {
    items: productContext.items ?? [],
    modelVisibleContext: productContext.modelVisibleContext ?? "",
  };
  const verbatim = task.length + query.length;
  const total = JSON.stringify(record).length;
  return {
    requestBlockCharacters: JSON.stringify(request).length,
    requestBlockTokens: envelopeTokens(request),
    taskCharacters: task.length,
    queryCharacters: query.length,
    verbatimEchoCharacters: verbatim,
    verbatimEchoTokens: Math.ceil(verbatim / 4),
    // What a perfect deduplication would save: the redundant second copy only.
    duplicatedEchoCharacters: identical ? task.length : 0,
    identical,
    totalCharacters: total,
    totalTokens: envelopeTokens(record),
    echoShareOfResponse: total === 0 ? 0 : verbatim / total,
    evidenceCharacters: JSON.stringify(evidence).length,
    evidenceTokens: envelopeTokens(evidence),
  };
}

// ── delivery outcome ──

export interface DeliveryOutcome {
  readonly resolved: boolean;
  readonly retrievalFound: boolean;
  readonly deliveryFailed: boolean;
  readonly resultState: string;
  readonly selectedItemsBeforeBudget: number;
  readonly deliveredItems: number;
  readonly droppedForBudget: number;
  readonly leadPivot: string | null;
  readonly pivotDelivered: boolean;
  readonly withinEnvelope: boolean;
  readonly ceilingTokens: number;
  readonly totalResponseTokens: number;
  readonly metadataTokens: number;
  readonly modelVisibleTokens: number;
  readonly serializedCharacters: number;
}

export function readDelivery(compacted: unknown): DeliveryOutcome {
  const record = isRecord(compacted) ? compacted : {};
  const productContext = isRecord(record.productContext) ? record.productContext : {};
  const delivery = isRecord(productContext.delivery) ? productContext.delivery : {};
  const budget = isRecord(record.responseBudget) ? record.responseBudget : {};
  const items = Array.isArray(productContext.items) ? productContext.items : [];
  const leadPivot = typeof productContext.leadPivot === "string" ? productContext.leadPivot : null;
  const num = (value: unknown): number => (typeof value === "number" ? value : 0);
  const deliveredItems = num(delivery.deliveredItems) || items.length;
  return {
    resolved: productContext.resolved === true,
    retrievalFound: productContext.retrievalFound === true,
    deliveryFailed: productContext.deliveryFailed === true,
    resultState: typeof productContext.resultState === "string" ? productContext.resultState : "",
    selectedItemsBeforeBudget: num(delivery.selectedItemsBeforeBudget),
    deliveredItems,
    droppedForBudget: num(delivery.droppedForBudget),
    leadPivot,
    pivotDelivered: leadPivot !== null && items.some(
      (item) => isRecord(item) && item.fqName === leadPivot,
    ),
    withinEnvelope: budget.within_envelope === true,
    ceilingTokens: num(budget.total_response_token_ceiling),
    totalResponseTokens: num(budget.estimated_total_response_tokens),
    metadataTokens: num(budget.estimated_metadata_tokens),
    modelVisibleTokens: num(budget.estimated_model_visible_tokens),
    serializedCharacters: num(budget.serialized_response_characters),
  };
}

/** The default context budget a Stage 5 / Claude Code call actually requests. */
export const DEFAULT_REQUESTED_CONTEXT_TOKENS = 8_000;

export function compactUnder(
  snapshot: unknown,
  policy: DisclosurePolicy,
  requestedContextTokens = DEFAULT_REQUESTED_CONTEXT_TOKENS,
): unknown {
  const withPolicy = applyPolicy(snapshot, policy);
  // `responseBudget` is compaction OUTPUT, not input; leaving a previous run's
  // accounting in the draft would let a replay measure its own prior answer.
  const draft = structuredClone(withPolicy) as JsonRecord;
  delete draft.responseBudget;
  return compactProductResponse(draft, {
    requestedContextTokens,
    detail: McpResponseDetail.Standard,
  });
}

/**
 * Compaction, with the one exception the product itself can raise.
 *
 * `compactProductResponse` throws `product_response_envelope_unreachable` when a
 * response will not fit even after the evidence has been deleted. That is a real
 * product state, so it is carried as an outcome rather than escaping as an error.
 */
export interface CompactionOutcome {
  readonly delivery: DeliveryOutcome;
  readonly unreachable: boolean;
}

export function compactOrUnreachable(
  snapshot: unknown,
  policy: DisclosurePolicy,
  requestedContextTokens = DEFAULT_REQUESTED_CONTEXT_TOKENS,
): CompactionOutcome {
  try {
    return { delivery: readDelivery(compactUnder(snapshot, policy, requestedContextTokens)), unreachable: false };
  } catch (cause) {
    if (cause instanceof Error && cause.message === "product_response_envelope_unreachable") {
      return { delivery: readDelivery(null), unreachable: true };
    }
    throw cause;
  }
}

// ── §15 pathology classification ──

export enum Pathology {
  RequestEchoEviction = "REQUEST_ECHO_EVICTION",
  OtherMetadataEviction = "OTHER_METADATA_EVICTION",
  EvidenceSupplyTooLarge = "EVIDENCE_SUPPLY_TOO_LARGE",
  TruthfulnessOverhead = "TRUTHFULNESS_OVERHEAD",
  NotAffected = "NOT_AFFECTED",
  Unknown = "UNKNOWN",
}

export interface Classification {
  readonly pathology: Pathology;
  readonly why: string;
  readonly currentDelivered: number;
  readonly repairedDelivered: number;
}

/**
 * Classify a case by REPLAY, not by threshold.
 *
 * A case is `REQUEST_ECHO_EVICTION` only if the identical authoritative snapshot
 * delivers nothing under the current policy and delivers something under the
 * repair. Nothing here reasons from the echo being large: §15 forbids attributing
 * every truncation to the echo, and a size test would do exactly that.
 */
export function classify(snapshot: unknown, repaired: DisclosurePolicy): Classification {
  const current = compactOrUnreachable(snapshot, DisclosurePolicy.Current);
  const fixed = compactOrUnreachable(snapshot, repaired);

  // Retrieval is read from the PRE-COMPACTION snapshot, before anything else is
  // decided. Reading it from the compacted response would be circular: compaction
  // rewrites `retrievalFound` as part of degrading, and on an unreachable envelope
  // there is no compacted response to read at all. If nothing was retrieved, no
  // evidence was displaced, and no echo however large makes this its pathology.
  const authoritative = isRecord(snapshot) ? snapshot : {};
  const productContext = isRecord(authoritative.productContext) ? authoritative.productContext : {};
  const retrievedCount = Array.isArray(productContext.items) ? productContext.items.length : 0;
  if (retrievedCount === 0 && productContext.resolved !== true) {
    return {
      pathology: Pathology.NotAffected,
      why: "Retrieval produced nothing. There was no evidence for the echo to displace.",
      currentDelivered: 0,
      repairedDelivered: fixed.unreachable ? 0 : fixed.delivery.deliveredItems,
    };
  }

  // A response the envelope cannot fit even after deleting the evidence is not an
  // echo pathology: the ladder ran out of things to give up. Reported as supply.
  if (current.unreachable) {
    if (!fixed.unreachable) {
      return {
        pathology: Pathology.RequestEchoEviction,
        why: "The envelope is unreachable today and reachable with the echo removed.",
        currentDelivered: 0,
        repairedDelivered: fixed.delivery.deliveredItems,
      };
    }
    // Unreachable either way. Which non-request field is responsible depends on
    // whether the evidence alone would have overrun the ceiling.
    const supply = attributeEcho(snapshot);
    const ceiling = 2 * DEFAULT_REQUESTED_CONTEXT_TOKENS;
    return {
      pathology: supply.evidenceTokens > ceiling
        ? Pathology.EvidenceSupplyTooLarge
        : Pathology.OtherMetadataEviction,
      why: "Envelope unreachable under both policies — nothing the request block could have paid for.",
      currentDelivered: 0,
      repairedDelivered: 0,
    };
  }

  if (!current.delivery.deliveryFailed && current.delivery.deliveredItems > 0) {
    return {
      pathology: Pathology.NotAffected,
      why: "Delivery succeeded under the current policy; the echo cost budget but evicted nothing.",
      currentDelivered: current.delivery.deliveredItems,
      repairedDelivered: fixed.delivery.deliveredItems,
    };
  }
  if (fixed.delivery.deliveredItems > current.delivery.deliveredItems) {
    return {
      pathology: Pathology.RequestEchoEviction,
      why: "Same authoritative snapshot; removing the verbatim request echo and changing nothing "
        + "else restores delivery. The echo outbid the evidence.",
      currentDelivered: current.delivery.deliveredItems,
      repairedDelivered: fixed.delivery.deliveredItems,
    };
  }
  const attribution = attributeEcho(snapshot);
  if (attribution.evidenceTokens > current.delivery.ceilingTokens) {
    return {
      pathology: Pathology.EvidenceSupplyTooLarge,
      why: "Evidence alone exceeds the ceiling. Removing the echo cannot and does not help.",
      currentDelivered: current.delivery.deliveredItems,
      repairedDelivered: fixed.delivery.deliveredItems,
    };
  }
  return {
    pathology: Pathology.OtherMetadataEviction,
    why: "Delivery fails with the echo removed, and the evidence fits the ceiling on its own. "
      + "Something other than the request block is consuming the envelope.",
    currentDelivered: current.delivery.deliveredItems,
    repairedDelivered: fixed.delivery.deliveredItems,
  };
}

/**
 * Confirm a replayed snapshot reproduces an independently captured outcome.
 *
 * The replay is the instrument for every number in M175-B through M175-E, so it
 * is calibrated against the one outcome that was recorded by the live product
 * before any of this existed. A replay that cannot reproduce the known case is
 * not evidence about the unknown ones.
 */
export interface ReplayValidation {
  readonly field: string;
  readonly captured: number | string | boolean;
  readonly replayed: number | string | boolean;
  readonly agrees: boolean;
}

export function validateReplay(
  capturedCompacted: unknown,
  snapshot: unknown,
): readonly ReplayValidation[] {
  const captured = readDelivery(capturedCompacted);
  const replayed = readDelivery(compactUnder(snapshot, DisclosurePolicy.Current));
  const rows: ReplayValidation[] = [];
  const check = (field: string, a: number | string | boolean, b: number | string | boolean): void => {
    rows.push({ field, captured: a, replayed: b, agrees: a === b });
  };
  check("resultState", captured.resultState, replayed.resultState);
  check("deliveryFailed", captured.deliveryFailed, replayed.deliveryFailed);
  check("retrievalFound", captured.retrievalFound, replayed.retrievalFound);
  check("selectedItemsBeforeBudget", captured.selectedItemsBeforeBudget, replayed.selectedItemsBeforeBudget);
  check("deliveredItems", captured.deliveredItems, replayed.deliveredItems);
  check("droppedForBudget", captured.droppedForBudget, replayed.droppedForBudget);
  check("leadPivot", captured.leadPivot ?? "", replayed.leadPivot ?? "");
  check("ceilingTokens", captured.ceilingTokens, replayed.ceilingTokens);
  return rows;
}
