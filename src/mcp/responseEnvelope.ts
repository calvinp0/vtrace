// Complete-response budgeting for the context-producing MCP tools.
//
// `max_tokens` bounds the MODEL-VISIBLE context. It never bounded the serialized
// MCP result, and before M130 nothing did: a 6,000-token request returned an
// 87,146-character payload because the same selected context was serialized four
// times over (rendered text, per-item bodies, capsule item bodies, neighborhood
// excerpts) and wrapped in unbounded retrieval telemetry.
//
// This module owns the boundary. Two distinct measurements:
//
//   model-visible context  — what the agent reads; bounded by `max_tokens`
//   complete response      — what crosses the wire; bounded by `max_tokens`
//                            plus a small documented metadata allowance
//
// The invariant it enforces:
//
//   one source-bearing model-visible representation
//   + compact structured metadata
//   + bounded optional diagnostics
//
// Everything else becomes a stable reference back into that one representation.

import { createHash } from "node:crypto";

import { estimateTokens } from "../capsuleV2/tokens";
import { applyProgressiveContextBudget } from "../productContext/budgetDelivery";

export const MCP_RESPONSE_ENVELOPE_VERSION = "vtrace.mcp_response_envelope/1" as const;

/**
 * How much explanatory detail a response may carry. The default is `standard`.
 * `debug` widens diagnostics but is still subject to the same hard total ceiling —
 * a debug response is more informative, never unbounded.
 */
export const McpResponseDetail = Object.freeze({
  Compact: "compact",
  Standard: "standard",
  Debug: "debug",
});

export type McpResponseDetail =
  (typeof McpResponseDetail)[keyof typeof McpResponseDetail];

export function isMcpResponseDetail(value: string): value is McpResponseDetail {
  return (Object.values(McpResponseDetail) as string[]).includes(value);
}

/**
 * Metadata allowance above the requested context budget. The complete serialized
 * response must fit `requested + max(FLOOR, requested * RATIO)` estimated tokens.
 * A flat floor keeps small requests workable; the ratio keeps large ones honest.
 *
 * THIS FILE OWNS ONE OF THE TWO RESPONSE CONTRACTS, AND NOT THE OTHER (M178).
 * `max_tokens` carries two distinct bounds, and on this path they are enforced in
 * two different components:
 *
 *   the EVIDENCE budget      model-visible context <= max_tokens
 *                            enforced by productContext/budgetDelivery.ts
 *
 *   the DELIVERY constraint  complete serialized response <= the ceiling below
 *                            enforced here, by `within_envelope`, and it is the
 *                            only one that can withhold a response
 *
 * Both the escalation ladder (`enforceTotalEnvelope`) and the terminal
 * (`within_envelope`) test the SAME condition, which is why this path has no
 * ladder/terminal mismatch. `get_impact_graph` reaches the same two contracts
 * through a single ladder and names them apart in `impactResponseEnvelope.ts`;
 * M178-A deliberately did not merge the two implementations, because their output
 * contracts differ (see stage5_m177_impact_envelope_architecture.md).
 *
 * A flat FLOOR necessarily over-grants whenever real metadata costs less than it,
 * and M178-B measured where that surplus goes: on the impact path it becomes
 * headroom the evidence may occupy. Same arithmetic applies here.
 */
export const RESPONSE_METADATA_ALLOWANCE_FLOOR_TOKENS = 1_000;
export const RESPONSE_METADATA_ALLOWANCE_RATIO = 0.15;

export function responseTokenCeiling(requestedContextTokens: number): number {
  const requested = Math.max(0, Math.floor(requestedContextTokens));
  return requested + Math.max(
    RESPONSE_METADATA_ALLOWANCE_FLOOR_TOKENS,
    Math.ceil(requested * RESPONSE_METADATA_ALLOWANCE_RATIO),
  );
}

export interface ResponseBudgetAccounting {
  readonly envelopeVersion: typeof MCP_RESPONSE_ENVELOPE_VERSION;
  readonly requested_context_tokens: number;
  readonly estimated_model_visible_tokens: number;
  readonly estimated_metadata_tokens: number;
  readonly estimated_total_response_tokens: number;
  readonly total_response_token_ceiling: number;
  readonly serialized_response_characters: number;
  readonly within_envelope: boolean;
  readonly compaction_applied: boolean;
  readonly compacted_fields: readonly string[];
  readonly omitted_detail_counts: Readonly<Record<string, number>>;
  readonly expansion_available: Readonly<Record<string, string>>;
  readonly diagnostics_detail: McpResponseDetail;
  readonly estimate_method: "chars_div_4";
  readonly notes: readonly string[];
}

export interface CompactProductResponseOptions {
  /** The caller's context budget. Also the base of the total-response ceiling. */
  readonly requestedContextTokens: number;
  readonly detail?: McpResponseDetail;
  /**
   * Opt-in restoration of per-item bodies in `productContext.items[].content`.
   * Off by default: those bodies are already rendered in `modelVisibleContext`.
   */
  readonly includeItemContent?: boolean;
  /**
   * INTERNAL. The budget the delivery packer may spend on evidence, when that has
   * had to be reduced below the caller's `requestedContextTokens` for the packet
   * to be deliverable at all. The CEILING is never reduced with it: the caller's
   * entitlement to a complete response is unchanged, and only the packer's target
   * moves. Set solely by `retryWithinCeiling` below; no tool passes it.
   */
  readonly evidenceBudgetTokens?: number;
  /** INTERNAL. Guards the retry above; see `MAX_EVIDENCE_BUDGET_RETRIES`. */
  readonly evidenceBudgetRetryDepth?: number;
}

type JsonRecord = Record<string, unknown>;

/** Per-item metadata kept by default: identity and decision, never evidence dumps. */
const ITEM_METADATA_KEEP = Object.freeze([
  "fqName",
  "kind",
  "returnType",
  "exported",
  "skeletonFallback",
  "applicability",
  "targetKind",
  "documentKind",
  "requiredTargetSources",
  "type",
  "source",
  "staleness",
  "contextId",
  "contextReference",
  "pivotContextId",
  "pivotContextReference",
  "pivotFqName",
  "relationKind",
  "direction",
  "evidenceStrength",
  "edgeType",
  "duplicateBodyOf",
]);

/** Freshness fields that must survive every compaction step. */
const INDEX_FRESHNESS_ESSENTIAL = Object.freeze([
  "status",
  "reason",
  "action",
  "fresh",
  "latestRunId",
  "indexRunId",
  "headCommit",
  "worktreeId",
  "repositoryId",
]);

/** Placeholder left where a repeated copy of the task text was removed. */
const QUERY_REFERENCE = "@request.task";

/**
 * What stands in place of the caller's own prose in the default projection.
 *
 * Frozen — never re-worded per call. It is a sentence rather than a deletion
 * because a silently absent field would make its ABSENCE informative, and this
 * response's whole design rests on omission carrying no claim. It states who
 * supplied the text and where the text still is.
 */
export const REQUEST_PROSE_OMITTED =
  "@omitted: supplied by the caller; returned verbatim at detail=debug";

/**
 * Project the request block for the model, keeping the whole of it for a
 * maintainer.
 *
 * WHAT WENT WRONG. Every large field in this response yields to the ceiling
 * except one. The tier immediately below already deduplicates repeated task text
 * — `taskSummary.query`, `taskSummary.normalizedQuery`, `capsuleResult.query` all
 * become `@request.task` — and deliberately exempts `request` itself, on the
 * grounds that it echoes the caller verbatim and is therefore a correctness
 * surface. That is a sound rule for a field somebody reads. M175-A went looking
 * for the readers: there are none in the product. The shipped block's only
 * consumers anywhere in the repository are two assertions in `mcp.test.ts`, both
 * issued at `detail=debug`, and a benchmark analyzer that counts it AS duplication.
 *
 * Meanwhile `request.task` is assigned `orchestration.request.query` at
 * formatRunPipelineOutput.ts:211 — the same string under a second key, identical
 * in 199 of 199 captured responses. So the one field the ladder could not touch
 * was the caller's own question, carried twice.
 *
 * WHAT IT COST. M174 measured a response in which retrieval had succeeded with ten
 * items and a correct lead pivot, and the agent received none of them: 6,435
 * tokens of metadata against 3,731 of evidence under a 9,200 ceiling, a deficit of
 * 966 tokens, with 5,087 tokens of that metadata being the question echoed back.
 * The ladder had nothing left to give up but the evidence, so it gave up the
 * evidence and advised the caller to raise `max_tokens`.
 *
 * THE PROPERTY THIS RESTORES. The request block's cost was unbounded in the
 * caller's own input — a median of 644 tokens on Broad100-A and 878 on
 * Broad100-B, reaching 12,923 on the longest question. It is now a constant 65,
 * whatever is asked. That is the point: no question can be long enough to
 * outbid the repository evidence, because the question is no longer what is
 * being weighed.
 *
 * NOT A DELETION, AND NOT A BUDGET MEASURE. The block keeps its shape, its
 * resolved parameters (`maxResults`, `maxBudgetCharacters`, `includeTests`, …)
 * and its place in the schema; two field VALUES change. It is applied
 * unconditionally rather than as another rung, because "reference the request,
 * do not restate it" is the default contract and not an emergency: a rung would
 * leave the echo present on every response that happens to fit, and make the
 * evidence's survival depend on the order of the ladder.
 *
 * `detail=debug` returns the request whole and is not routed through here.
 */
function projectRequestDisclosure(
  draft: JsonRecord,
  options: {
    readonly detail: McpResponseDetail;
    readonly compactedFields: string[];
    readonly omitted: Record<string, number>;
  },
): void {
  if (options.detail === McpResponseDetail.Debug) return;
  const request = asRecord(draft.request);
  if (request === undefined) return;

  let removedCharacters = 0;
  if (typeof request.task === "string" && request.task !== REQUEST_PROSE_OMITTED) {
    removedCharacters += request.task.length;
    request.task = REQUEST_PROSE_OMITTED;
  }
  if (typeof request.query === "string" && request.query !== QUERY_REFERENCE) {
    removedCharacters += request.query.length;
    request.query = QUERY_REFERENCE;
  }
  if (removedCharacters === 0) return;

  // Recorded as a compacted field and NOT as an omitted-detail count. Those counts
  // are ranked by magnitude to decide which six are worth reporting, so a
  // character-scale entry here would evict the item-scale kinds that tell a
  // maintainer what the response actually gave up. The projection is also not
  // "detail omitted" in the sense the other counts mean: nothing of the
  // repository was withheld, the caller's own input was simply not sent back.
  options.compactedFields.push("request.task/request.query");
}

/**
 * Left in place of static per-call honesty boilerplate under tight budgets. The
 * claims themselves are declared in the tool output schema, which the caller sees
 * once per session rather than once per response.
 */
const ACCOUNTING_CLAIM_REFERENCE = "see tool output schema: estimates are chars/4, not tokenizer counts";

/** `intent` alias fields that repeat a canonical sibling verbatim. */
const INTENT_LEGACY_ALIASES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["requested", "requestedPreset"],
  ["selected", "selectedPreset"],
  ["rationale", "reason"],
  ["mappedQueryIntent", "selectedIntent"],
]);

/** The accounting block must not itself become a large payload. */
const MAX_REPORTED_COMPACTED_FIELDS = 10;
const MAX_REPORTED_OMITTED_COUNTS = 6;
const MAX_REPORTED_EXPANSIONS = 1;

/**
 * `diagnostics.<section>` blocks restate decisions the sections themselves already
 * publish (`rules.activeCount`, `flow.skipReason`, `memory.*.included`, …). They
 * are kept in full only at `debug` detail.
 */
const DIAGNOSTICS_DUPLICATED_SECTIONS = Object.freeze([
  "rules",
  "memory",
  "flow",
  "intent",
  "impact",
  "budget",
]);

const MAX_SELECTION_REASONS = 3;
const MAX_PIVOT_NEIGHBORHOOD_ENTRIES = 3;
const MAX_NEIGHBOR_RELATIONS_PER_PIVOT = 6;
const MAX_DEBUG_SAMPLE = 12;
// Field names a caller BRANCHES on, as opposed to reads for explanation. These
// survive at every detail level; the explanatory payload around them does not.
const DECISION_FIELD = /(?:reason|state|status|mode|decision|outcome|verdict|policy|tier|kind)$/i;
const MAX_INLINE_DIAGNOSTIC_ENTRIES = 12;
const MAX_INLINE_DIAGNOSTIC_CHARS = 400;
const MAX_DEFERRED_SUMMARY_CHARS = 96;

/**
 * Floor on per-item metadata rows kept when the selection itself is what pushes
 * a response over the ceiling. Below this the response stops being a usable map
 * of the context it ships, so the last-resort section drops take over instead.
 */
const MIN_RETAINED_PRODUCT_ITEMS = 3;

/** Flow hops that keep full relation evidence when a long path must be trimmed. */
const MAX_DETAILED_FLOW_STEPS = 3;

/**
 * Optional sections removed wholesale, in this order, only when every
 * duplication-removal step has run and the response is still over the ceiling.
 * Ordered least-to-most useful to a coding agent. The authoritative context,
 * freshness, provenance, warnings and accounting are deliberately absent.
 */
const LAST_RESORT_OPTIONAL_SECTIONS = Object.freeze([
  "pivotNeighborhood",
  "taskSummary",
  "context",
  "memory",
  "rules",
  "inspectFirst",
  "impact",
]);

/**
 * How many times the evidence budget may be lowered before the response is
 * declared undeliverable. Each attempt must reduce it strictly, so this bounds
 * work rather than deciding policy; measured convergence is one attempt.
 */
const MAX_EVIDENCE_BUDGET_RETRIES = 3;

/**
 * Re-pack the SAME authoritative result against a smaller evidence budget, under
 * the caller's unchanged ceiling.
 *
 * WHY THIS AND NOT A LARGER CEILING. Raising the metadata allowance would move
 * which budgets fail without making a bigger budget behave better than a smaller
 * one; the defect is that MORE budget could produce LESS, and only lowering the
 * packer's aim to what delivery can afford fixes that.
 *
 * WHY IT CANNOT INVENT ANYTHING. The packer's ladder is a fixed sequence of ever
 * weaker drafts, identical at every budget, in which the budget selects only where
 * to stop. Re-running it at a smaller budget therefore returns a rung the packer
 * would itself have published for a smaller request — an existing representation
 * of existing evidence, never a new claim, and never more evidence than the
 * caller's own budget already allowed.
 *
 * The retry starts from `output`, not from the half-compacted draft: the packer
 * renders from `productContext.items[].content`, which the compaction above has
 * by then removed as a duplicate, so descending in place would render bodiless
 * sections and call it compaction.
 */
function retryWithinCeiling<T>(
  output: T,
  options: CompactProductResponseOptions,
  accounting: ResponseBudgetAccounting,
  evidenceBudgetTokens: number,
): (T & { responseBudget: ResponseBudgetAccounting }) | undefined {
  const depth = options.evidenceBudgetRetryDepth ?? 0;
  if (depth >= MAX_EVIDENCE_BUDGET_RETRIES) return undefined;

  // What the envelope can still afford to spend on evidence, measured from the
  // metadata this attempt actually cost rather than from the flat allowance.
  const affordable = responseTokenCeiling(options.requestedContextTokens)
    - accounting.estimated_metadata_tokens;
  if (affordable < 1 || affordable >= evidenceBudgetTokens) return undefined;

  const candidate = compactProductResponse(output, {
    ...options,
    evidenceBudgetTokens: affordable,
    evidenceBudgetRetryDepth: depth + 1,
  });
  // Accept only a strict improvement. A retry that still cannot be delivered
  // leaves the original attempt to degrade truthfully, exactly as it does today.
  const productContext = asRecord((candidate as unknown as JsonRecord).productContext);
  const stillFailed = productContext?.deliveryFailed === true || productContext?.resolved !== true;
  return candidate.responseBudget.within_envelope && !stillFailed ? candidate : undefined;
}

/**
 * Rewrite a context-producing MCP tool result into the bounded response shape and
 * attach its budget accounting. Pure: the input value is never mutated.
 */
export function compactProductResponse<T>(
  output: T,
  options: CompactProductResponseOptions,
): T & { responseBudget: ResponseBudgetAccounting } {
  const detail = options.detail ?? McpResponseDetail.Standard;
  const draft = structuredClone(output) as unknown as JsonRecord;
  const compactedFields: string[] = [];
  const omitted: Record<string, number> = {};
  const expansion: Record<string, string> = {};

  // Captured before any rung runs: the ladder destroys the readiness record, and
  // the terminal decline below outranks every other state on it.
  const indexReady = readIndexReadiness(draft);

  // M178 named the two bounds this function enforces; M179 stopped them being the
  // same number. `max_tokens` is what the EVIDENCE may cost and is what the packer
  // targets; the ceiling is what the COMPLETE RESPONSE may cost and is what may
  // withhold it. The flat metadata allowance between them is not always enough for
  // real metadata, so the evidence a response can actually carry is `ceiling -
  // metadata`, which is routinely LESS than `max_tokens`. When it is, the packer is
  // aiming at a target nobody can honour, and `retryWithinCeiling` lowers the aim.
  const evidenceBudgetTokens = options.evidenceBudgetTokens ?? options.requestedContextTokens;
  const delivery = applyProgressiveContextBudget(draft, evidenceBudgetTokens);
  const deliveryCompacted = delivery?.accounting.status === "compacted"
    || delivery?.accounting.status === "failed";
  if (deliveryCompacted) {
    compactedFields.push("productContext.modelVisibleContext");
    omitted.productContextItemsDroppedForBudget = delivery?.accounting.droppedForBudget ?? 0;
  }
  const modelVisibleContext = readModelVisibleContext(draft);

  // 0. Project the caller's own question out of the model-facing response. This
  // runs before every measurement below, so the budget it frees is available to
  // the evidence rather than merely to the accounting. See M175.
  projectRequestDisclosure(draft, { detail, compactedFields, omitted });

  // 1. Remove duplicated source bodies from metadata items.
  compactProductContextItems(draft, {
    detail,
    includeItemContent: options.includeItemContent === true,
    compactedFields,
    omitted,
    expansion,
  });

  // 2. Replace compatibility representations with stable references.
  compactCapsuleResult(draft, { detail, compactedFields, omitted, expansion });
  compactLegacyContextSection(draft, { compactedFields, omitted, expansion });
  compactProductContextDiagnostics(draft, { detail, compactedFields, omitted, expansion });

  // 3. Reduce verbose diagnostics to summary counts and warning codes.
  compactDiagnostics(draft, { detail, compactedFields, omitted, expansion });

  // 3b. Hold the machine-facing diagnostics for `detail=debug`. The model is billed
  // for every character of this response (M166-A); the parts removed here are the
  // ones M166-B found no consumer for outside a maintainer's debugging session.
  reduceDiagnosticsToAgentFacing(draft, { detail, compactedFields, omitted, expansion });

  // 5. Bound pivot-neighborhood metadata.
  compactPivotNeighborhood(draft, { detail, compactedFields, omitted });

  // 6. Bound transitive impact/flow explanatory evidence.
  compactImpactSection(draft, { detail, compactedFields, omitted });

  // 7/8. Progressive product-context packing has already bounded
  // `modelVisibleContext`; freshness, provenance, warnings and accounting remain
  // protected while redundant envelope metadata is reduced around it.
  const escalation = enforceTotalEnvelope(draft, {
    detail,
    ceilingTokens: responseTokenCeiling(options.requestedContextTokens),
    accountingTokens: () => estimateTokens(serialize(buildAccounting({
      requestedContextTokens: options.requestedContextTokens,
      modelVisibleTokens: estimateTokens(modelVisibleContext),
      detail,
      compactionApplied: true,
      compactedFields,
      omitted,
      expansion,
      serializedCharacters: 0,
    }))),
    compactedFields,
    omitted,
  });

  let accounting = measureResponse(draft, {
    requestedContextTokens: options.requestedContextTokens,
    modelVisibleContext,
    detail,
    compactionApplied: deliveryCompacted || escalation.applied,
    compactedFields,
    omitted,
    expansion,
  });

  if (!accounting.within_envelope) {
    compactMandatoryProductMetadata(draft, compactedFields, omitted);
    accounting = measureResponse(draft, {
      requestedContextTokens: options.requestedContextTokens,
      modelVisibleContext: readModelVisibleContext(draft),
      detail,
      compactionApplied: true,
      compactedFields,
      omitted,
      expansion,
    });
  }

  if (!accounting.within_envelope) {
    compactNonessentialEnvelopeMetadata(draft, compactedFields, omitted);
    accounting = measureResponse(draft, {
      requestedContextTokens: options.requestedContextTokens,
      modelVisibleContext: readModelVisibleContext(draft),
      detail,
      compactionApplied: true,
      compactedFields,
      omitted,
      expansion,
    });
  }

  if (!accounting.within_envelope) {
    // Before discarding the evidence, spend less on it. See `retryWithinCeiling`.
    const retried = retryWithinCeiling(output, options, accounting, evidenceBudgetTokens);
    if (retried !== undefined) return retried;
  }

  if (!accounting.within_envelope) {
    degradeOversizedProductResponse(draft, compactedFields, omitted);
    accounting = measureResponse(draft, {
      requestedContextTokens: options.requestedContextTokens,
      modelVisibleContext: readModelVisibleContext(draft),
      detail,
      compactionApplied: true,
      compactedFields,
      omitted,
      expansion,
    });
  }

  if (!accounting.within_envelope) {
    // Every rung has run and the response still does not fit. This is a product
    // condition, not a transport fault, so it terminates in a bounded truthful
    // record rather than an exception. See buildBoundedEnvelopeDecline.
    const bounded = buildBoundedEnvelopeDecline(draft, compactedFields, omitted, indexReady);
    return {
      ...bounded,
      responseBudget: measureResponse(bounded, {
        requestedContextTokens: options.requestedContextTokens,
        modelVisibleContext: readModelVisibleContext(bounded),
        detail,
        compactionApplied: true,
        compactedFields,
        omitted,
        expansion,
      }),
    } as unknown as T & { responseBudget: ResponseBudgetAccounting };
  }

  draft.responseBudget = accounting;
  return draft as unknown as T & { responseBudget: ResponseBudgetAccounting };
}

/**
 * Re-enforce the envelope on an already-compacted response and refresh its
 * figures, carrying the inner pass's compaction record forward.
 *
 * `get_code_context` delegates to `run_pipeline` and then overwrites freshness
 * and timing on the returned value — which can push a response that fitted back
 * over the ceiling. Re-running compaction from scratch would under-report what
 * the inner pass removed (the duplication is already gone), so the record is
 * carried over and only the escalation ladder runs again.
 */
export function remeasureResponseBudget<T extends { responseBudget: ResponseBudgetAccounting }>(
  output: T,
): T {
  const draft = { ...(output as unknown as JsonRecord) };
  const previous = output.responseBudget;
  delete draft.responseBudget;

  const indexReady = readIndexReadiness(draft);
  const compactedFields = [...previous.compacted_fields];
  const omitted = { ...previous.omitted_detail_counts };
  const expansion = { ...previous.expansion_available };
  const modelVisibleContext = readModelVisibleContext(draft);
  const detail = previous.diagnostics_detail;

  const escalation = enforceTotalEnvelope(draft, {
    detail,
    ceilingTokens: responseTokenCeiling(previous.requested_context_tokens),
    accountingTokens: () => estimateTokens(serialize(buildAccounting({
      requestedContextTokens: previous.requested_context_tokens,
      modelVisibleTokens: estimateTokens(modelVisibleContext),
      detail,
      compactionApplied: true,
      compactedFields,
      omitted,
      expansion,
      serializedCharacters: 0,
    }))),
    compactedFields,
    omitted,
  });

  let accounting = measureResponse(draft, {
    requestedContextTokens: previous.requested_context_tokens,
    modelVisibleContext,
    detail,
    compactionApplied: previous.compaction_applied || escalation.applied,
    compactedFields,
    omitted,
    expansion,
  });

  if (!accounting.within_envelope) {
    compactMandatoryProductMetadata(draft, compactedFields, omitted);
    accounting = measureResponse(draft, {
      requestedContextTokens: previous.requested_context_tokens,
      modelVisibleContext: readModelVisibleContext(draft),
      detail,
      compactionApplied: true,
      compactedFields,
      omitted,
      expansion,
    });
  }

  if (!accounting.within_envelope) {
    compactNonessentialEnvelopeMetadata(draft, compactedFields, omitted);
    accounting = measureResponse(draft, {
      requestedContextTokens: previous.requested_context_tokens,
      modelVisibleContext: readModelVisibleContext(draft),
      detail,
      compactionApplied: true,
      compactedFields,
      omitted,
      expansion,
    });
  }

  if (!accounting.within_envelope) {
    degradeOversizedProductResponse(draft, compactedFields, omitted);
    accounting = measureResponse(draft, {
      requestedContextTokens: previous.requested_context_tokens,
      modelVisibleContext: readModelVisibleContext(draft),
      detail,
      compactionApplied: true,
      compactedFields,
      omitted,
      expansion,
    });
  }

  if (!accounting.within_envelope) {
    // Same terminal condition on the re-measure path, reached when
    // `get_code_context` overwrites freshness and timing on a response the inner
    // pass had already brought inside the envelope.
    const bounded = buildBoundedEnvelopeDecline(draft, compactedFields, omitted, indexReady);
    return {
      ...bounded,
      responseBudget: measureResponse(bounded, {
        requestedContextTokens: previous.requested_context_tokens,
        modelVisibleContext: readModelVisibleContext(bounded),
        detail,
        compactionApplied: true,
        compactedFields,
        omitted,
        expansion,
      }),
    } as unknown as T;
  }

  return { ...draft, responseBudget: accounting } as unknown as T;
}

/**
 * The final metadata tier keeps the product contract and required orchestration
 * decisions, but removes optional compatibility manifests that merely repeat
 * identities already present in productContext/modelVisibleContext.
 */
function compactNonessentialEnvelopeMetadata(
  draft: JsonRecord,
  compactedFields: string[],
  omitted: Record<string, number>,
): void {
  const optional = [
    "capsule",
    "runtime",
    "inspectFirst",
    "accounting",
    "capsuleResult",
    "authoritativeCapsuleManifestId",
    "capsuleManifestId",
    "pivotNeighborhood",
    "workspace",
    "retrieval",
    "classification",
    "routingProfile",
    "capsuleProfile",
  ];
  let removed = 0;
  for (const field of optional) {
    if (draft[field] === undefined) continue;
    removed += serialize(draft[field]).length;
    delete draft[field];
  }
  if (removed > 0) {
    omitted.optionalEnvelopeMetadataCharacters = removed;
    compactedFields.push("optional_envelope_metadata");
  }

  const product = asRecord(draft.productContext);
  if (product !== undefined) {
    if (typeof product.task === "string" && product.task !== QUERY_REFERENCE) {
      product.task = QUERY_REFERENCE;
    }
    product.timing = {};
    product.roleCounts = {};
    const repository = asRecord(product.repository);
    if (repository !== undefined) {
      product.repository = pickFields(repository, INDEX_FRESHNESS_ESSENTIAL);
    }
    const freshness = asRecord(product.freshness);
    if (freshness !== undefined) {
      product.freshness = pickFields(freshness, INDEX_FRESHNESS_ESSENTIAL);
    }
    compactedFields.push("productContext.optional_metadata");
  }

  const diagnostics = asRecord(draft.diagnostics);
  if (diagnostics !== undefined) {
    const freshness = asRecord(diagnostics.indexFreshness);
    draft.diagnostics = {
      responseCompacted: true,
      ...(freshness === undefined ? {} : {
        indexFreshness: pickFields(freshness, INDEX_FRESHNESS_ESSENTIAL),
      }),
    };
    compactedFields.push("diagnostics.essential_only");
  }
}

function pickFields(record: JsonRecord, fields: readonly string[]): JsonRecord {
  const selected: JsonRecord = {};
  for (const field of fields) {
    if (record[field] !== undefined) selected[field] = record[field];
  }
  return selected;
}

function compactMandatoryProductMetadata(
  draft: JsonRecord,
  compactedFields: string[],
  omitted: Record<string, number>,
): void {
  const productContext = asRecord(draft.productContext);
  if (productContext === undefined) return;
  const items = asRecordArray(productContext.items) ?? [];
  if (items.length > 1) {
    const strongest = items[0]!;
    productContext.items = [{
      id: strongest.id ?? null,
      stableId: strongest.stableId ?? null,
      path: strongest.path ?? null,
      symbol: strongest.symbol ?? null,
      // Canonical indexed identity survives even the last-resort compaction: it
      // is the only field in this projection that is directly usable as a
      // follow-up tool argument, so dropping it would leave a compacted response
      // describing a symbol the agent can no longer ask about.
      fqName: strongest.fqName ?? null,
      roles: strongest.roles ?? [],
      contentMode: strongest.contentMode ?? null,
      estimatedTokens: strongest.estimatedTokens ?? 0,
      metadata: asRecord(strongest.metadata)?.fqName === undefined
        ? {}
        : { fqName: asRecord(strongest.metadata)?.fqName },
      contextReference: typeof strongest.id === "string" ? `[${strongest.id}]` : null,
    }];
    productContext.omittedItemCount = items.length - 1;
    omitted.productContextItems = (omitted.productContextItems ?? 0) + items.length - 1;
    compactedFields.push("productContext.items");
  }
  const diagnostics = asRecord(productContext.diagnostics);
  if (diagnostics !== undefined) {
    productContext.diagnostics = {
      responseCompacted: true,
      duplicateSourceBodies: diagnostics.duplicateSourceBodies ?? 0,
      omittedItemMetadata: Math.max(0, items.length - 1),
    };
    compactedFields.push("productContext.diagnostics");
  }
  const accounting = asRecord(productContext.accounting);
  if (accounting !== undefined) {
    productContext.accounting = {
      estimatedTokens: accounting.estimatedTokens ?? accounting.modelVisibleEstimatedTokens ?? 0,
      estimateMethod: accounting.estimateMethod ?? "chars_div_4",
    };
    compactedFields.push("productContext.accounting");
  }
}

/**
 * Last-resort structured degradation for a response whose mandatory context or
 * post-construction metadata still exceeds the complete envelope. A successful
 * bounded tool must never knowingly ship `within_envelope:false`.
 */
function degradeOversizedProductResponse(
  draft: JsonRecord,
  compactedFields: string[],
  omitted: Record<string, number>,
): void {
  const productContext = asRecord(draft.productContext);
  if (productContext === undefined) return;
  const items = asRecordArray(productContext.items) ?? [];
  const originalContext = typeof productContext.modelVisibleContext === "string"
    ? productContext.modelVisibleContext
    : "";
  const retrievalFound = productContext.retrievalFound === true
    || productContext.resolved === true
    || items.length > 0;
  productContext.resolved = false;
  productContext.retrievalFound = retrievalFound;
  productContext.deliveryFailed = retrievalFound;
  productContext.resultState = retrievalFound ? "delivery_failure" : "no_result";
  if (retrievalFound && productContext.topMatchReference === undefined && typeof productContext.leadPivot === "string") {
    productContext.topMatchReference = productContext.leadPivot;
  }
  productContext.items = [];
  const degradedContext = [
    retrievalFound ? "# VTRACE delivery failure" : "# VTRACE no result",
    retrievalFound
      ? "Relevant evidence was found, but the minimum deliverable representation could not fit the complete response envelope."
      : "Retrieval produced no sufficiently relevant evidence.",
    retrievalFound ? "Increase max_tokens or narrow the request." : "",
  ].join("\n");
  productContext.modelVisibleContext = degradedContext;
  productContext.accounting = {
    estimatedTokens: estimateTokens(degradedContext),
    degradedFromEstimatedTokens: estimateTokens(originalContext),
  };
  productContext.diagnostics = {
    resultState: retrievalFound ? "delivery_failure" : "no_result",
    retrievalFound,
    responseCompacted: true,
  };
  const delivery = asRecord(productContext.delivery);
  if (delivery !== undefined) {
    const selected = typeof delivery.selectedItemsBeforeBudget === "number"
      ? delivery.selectedItemsBeforeBudget
      : items.length;
    productContext.delivery = {
      ...delivery,
      status: retrievalFound ? "failed" : "no_result",
      deliveredItems: 0,
      droppedForBudget: selected,
      finalModelTokens: estimateTokens(degradedContext),
    };
  }
  omitted.productContextItems = (omitted.productContextItems ?? 0) + items.length;
  omitted.modelVisibleCharacters = (omitted.modelVisibleCharacters ?? 0) + originalContext.length;
  compactedFields.push("productContext.bounded_degradation");
}

/**
 * Explicit bounds on every string the terminal record may carry that the caller
 * or the repository, rather than this file, decides the length of. A fallback
 * that exists to bound the response must not contain a field that does not.
 */
const BOUNDED_DECLINE_TOP_MATCH_CHARACTERS = 256;
const BOUNDED_DECLINE_FRESHNESS_STATUS_CHARACTERS = 64;
const BOUNDED_DECLINE_FRESHNESS_REASON_CHARACTERS = 256;
const BOUNDED_DECLINE_CONTEXT_CHARACTERS = 512;

/**
 * Left in place of a value that exceeded its bound.
 *
 * OMISSION, NOT TRUNCATION. Every bounded field here is load-bearing for a claim:
 * `topMatchReference` is a follow-up tool argument, and the freshness pair is
 * quoted verbatim into the decline's own note. A truncated symbol name is an
 * identity that does not resolve, and a truncated freshness reason is a
 * re-worded claim. Both are worse than saying nothing, so over-long values are
 * dropped and marked rather than cut.
 */
const BOUNDED_DECLINE_OVER_BOUND = "@omitted: exceeded the bounded response limit";

const boundedString = (value: unknown, limit: number): string | undefined => {
  if (typeof value !== "string" || value === "") return undefined;
  return value.length <= limit ? value : BOUNDED_DECLINE_OVER_BOUND;
};

const boundedCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

/**
 * The terminal record for a response that cannot be represented inside its own
 * envelope. Fixed shape, bounded by construction: every field is a frozen
 * constant, a boolean, a non-negative integer, or a string with a declared limit.
 *
 * WHY THIS EXISTS. `degradeOversizedProductResponse` above is a real bounded
 * degradation, and for most responses it is enough. But it bounds `productContext`
 * and a response is more than its `productContext`: M176-A measured ten default
 * model-facing fields — `request.repoRoot`, `productContext.leadPivot`,
 * `productContext.freshness.reason`, `workspaceRouting.*`, `intent.reason`,
 * `savedObservation`, `warnings`, `flow.skipReason` among them — whose cost no
 * rung of the ladder reduces, each able on its own to carry an otherwise ordinary
 * response past even the DEFAULT ceiling. When that happened the ladder ran out
 * and the tool threw `product_response_envelope_unreachable`, which the server's
 * catch-all reported as `handler_failed`: a predictable product condition
 * arriving as an implementation fault, with no evidence, no orientation and no
 * decline. Reproduced on an ordinary corpus case (`pytest-dev__pytest-10081`,
 * `max_tokens` 150) through the real MCP transport.
 *
 * WHAT IT SAYS, AND WHAT IT REFUSES TO SAY. Nothing here is authored prose about
 * the repository. The record carries FACTS the ladder already established —
 * whether retrieval found anything, whether delivery failed, whether the index
 * vouched for itself, and the one top-match identity, if there is a real one
 * short enough to be usable — in the same field names the decline projector
 * already reads. So the model receives the decline it would have received had the
 * ladder been able to stop one rung earlier, in the SAME vocabulary: relevant
 * evidence was found and none of it survived the response budget. It is never
 * reported as "nothing was found" unless retrieval's own finding was that
 * nothing was found.
 *
 * NOT A NEW PUBLIC STATE. Ladder exhaustion changes nothing the model could infer
 * or act on differently — evidence existed, none could be delivered inside the
 * bound — so it reuses `evidence_found_but_undelivered` rather than minting
 * vocabulary for a distinction only a maintainer can use. The distinction a
 * maintainer DOES need is kept as one internal boolean,
 * `productContext.diagnostics.envelopeDecline`, so telemetry can separate a
 * response that degraded gracefully from one whose degraded form could not itself
 * be built.
 *
 * NOT A DUMP. The authoritative payload does not travel inside this record in any
 * form. Everything the ladder had left is dropped, and `omitted_detail_counts`
 * says how much.
 */
function buildBoundedEnvelopeDecline(
  draft: JsonRecord,
  compactedFields: string[],
  omitted: Record<string, number>,
  /**
   * Whether the index vouched for itself, read BEFORE the ladder ran.
   *
   * It has to be, because by this point the fact is gone: the
   * `diagnostics.indexFreshness` rung deletes every object-valued key under
   * `diagnostics.freshness`, and `readiness` is one. That is sound for a response
   * that survives — the scalar status fields callers branch on are kept, and the
   * precise record is `diagnostics.indexFreshness`. It is not sound HERE, where
   * readiness outranks every other decline state and `readDeclineEvidence`
   * defaults a missing readiness record to ready. Restoring the one boolean the
   * decline needs is why it is captured at entry rather than looked up at exit.
   */
  indexReady: boolean | null,
): JsonRecord {
  const productContext = asRecord(draft.productContext);
  const droppedCharacters = serialize(draft).length;

  const bounded: JsonRecord = {};
  if (typeof draft.schemaVersion === "string") bounded.schemaVersion = draft.schemaVersion;

  // Carried in the exact shape the decline projector reads, so an unready index
  // is still reported as an unready index and never as a delivery loss.
  if (indexReady !== null) {
    bounded.diagnostics = { freshness: { readiness: { ready: indexReady } } };
  }

  if (productContext !== undefined) {
    // `retrievalFound` decides between "nothing was relevant" and "something was
    // and you are not getting it". It is read, never assumed: §21 requires an
    // empty retrieval to stay an empty retrieval.
    const retrievalFound = productContext.retrievalFound === true;
    const context = boundedString(productContext.modelVisibleContext, BOUNDED_DECLINE_CONTEXT_CHARACTERS);
    const topMatch = boundedString(
      typeof productContext.topMatchReference === "string" && productContext.topMatchReference !== ""
        ? productContext.topMatchReference
        : productContext.leadPivot,
      BOUNDED_DECLINE_TOP_MATCH_CHARACTERS,
    );
    const freshness = asRecord(productContext.freshness);
    const status = boundedString(freshness?.status, BOUNDED_DECLINE_FRESHNESS_STATUS_CHARACTERS);
    const reason = boundedString(freshness?.reason, BOUNDED_DECLINE_FRESHNESS_REASON_CHARACTERS);
    const delivery = asRecord(productContext.delivery);

    bounded.productContext = {
      responseVersion: typeof productContext.responseVersion === "string"
        ? productContext.responseVersion
        : null,
      resolved: false,
      retrievalFound,
      // The ladder having been exhausted IS a delivery failure, and the decline
      // projector reads this to reach the right state. It stays false when
      // retrieval found nothing, so an empty result is never dressed as a loss.
      deliveryFailed: retrievalFound,
      resultState: retrievalFound ? "delivery_failure" : "no_result",
      items: [],
      omittedItemCount: boundedCount(productContext.omittedItemCount),
      modelVisibleContext: context ?? "",
      // Disclosed only where the record genuinely holds a match, and only when it
      // is short enough to still be a usable follow-up argument (M174's rule).
      ...(retrievalFound && topMatch !== undefined && topMatch !== BOUNDED_DECLINE_OVER_BOUND
        ? { topMatchReference: topMatch }
        : {}),
      ...(status === undefined ? {} : { freshness: { status, ...(reason === undefined ? {} : { reason }) } }),
      delivery: {
        status: retrievalFound ? "failed" : "no_result",
        selectedItemsBeforeBudget: boundedCount(delivery?.selectedItemsBeforeBudget),
        deliveredItems: 0,
        droppedForBudget: boundedCount(delivery?.droppedForBudget),
      },
      diagnostics: {
        resultState: retrievalFound ? "delivery_failure" : "no_result",
        retrievalFound,
        responseCompacted: true,
        // The one thing this record says that the graceful degradation does not:
        // the bounded form could not itself be built from the response. Internal,
        // bounded, and the only way telemetry can attribute the two apart.
        envelopeDecline: true,
      },
    };
  }

  compactedFields.push("response.bounded_envelope_decline");
  omitted.boundedEnvelopeDeclineCharacters =
    (omitted.boundedEnvelopeDeclineCharacters ?? 0)
    + Math.max(0, droppedCharacters - serialize(bounded).length);
  return bounded;
}

/**
 * Whether the index vouched for itself, as recorded before any compaction ran.
 * `null` when the response carries no readiness record at all — which
 * `readDeclineEvidence` reads as ready, and which this must not silently assert.
 */
function readIndexReadiness(draft: JsonRecord): boolean | null {
  const readiness = asRecord(asRecord(asRecord(draft.diagnostics)?.freshness)?.readiness);
  return readiness === undefined ? null : readiness.ready === true;
}

function readModelVisibleContext(draft: JsonRecord): string {
  const productContext = asRecord(draft.productContext);
  const value = productContext?.modelVisibleContext;
  return typeof value === "string" ? value : "";
}

/**
 * `productContext.items` becomes metadata plus a reference into the rendered
 * context. Every body it carried is already present, verbatim, in
 * `modelVisibleContext` under the item's own `[id]` heading.
 */
function compactProductContextItems(
  draft: JsonRecord,
  options: {
    detail: McpResponseDetail;
    includeItemContent: boolean;
    compactedFields: string[];
    omitted: Record<string, number>;
    expansion: Record<string, string>;
  },
): void {
  const productContext = asRecord(draft.productContext);
  const items = productContext === undefined ? undefined : asRecordArray(productContext.items);
  if (productContext === undefined || items === undefined) {
    return;
  }

  let removedBodies = 0;
  let removedCharacters = 0;
  let trimmedReasons = 0;
  let trimmedMetadataKeys = 0;

  productContext.items = items.map((item) => {
    const next: JsonRecord = { ...item };
    const content = typeof item.content === "string" ? item.content : undefined;

    if (content !== undefined) {
      next.contentHash = sha256(content);
      next.contentCharacters = content.length;
      if (options.includeItemContent) {
        next.content = content;
      } else {
        delete next.content;
        removedBodies += 1;
        removedCharacters += content.length;
      }
    }

    const reasons = asStringArray(item.selectionReasons);
    if (reasons !== undefined && reasons.length > MAX_SELECTION_REASONS) {
      next.selectionReasons = reasons.slice(0, MAX_SELECTION_REASONS);
      next.selectionReasonsOmitted = reasons.length - MAX_SELECTION_REASONS;
      trimmedReasons += reasons.length - MAX_SELECTION_REASONS;
    }

    const metadata = asRecord(item.metadata);
    if (metadata !== undefined) {
      const kept: JsonRecord = {};
      let dropped = 0;
      for (const key of Object.keys(metadata)) {
        if (ITEM_METADATA_KEEP.includes(key)) {
          kept[key] = metadata[key];
        } else {
          dropped += 1;
        }
      }
      if (dropped > 0) {
        kept.boundedMetadataOmittedKeys = dropped;
        trimmedMetadataKeys += dropped;
      }
      next.metadata = kept;
    }

    return next;
  });

  if (removedBodies > 0) {
    options.compactedFields.push("productContext.items[].content");
    options.omitted.productContextItemBodies = removedBodies;
    options.omitted.productContextItemBodyCharacters = removedCharacters;
    options.expansion["productContext.items[].content"] =
      "Rendered once in productContext.modelVisibleContext under this item's `## [id]` heading; pass include_item_content=true for per-item bodies.";
  }
  if (trimmedReasons > 0) {
    options.compactedFields.push("productContext.items[].selectionReasons");
    options.omitted.productContextSelectionReasons = trimmedReasons;
  }
  if (trimmedMetadataKeys > 0) {
    options.compactedFields.push("productContext.items[].metadata");
    options.omitted.productContextItemMetadataKeys = trimmedMetadataKeys;
  }
}

/**
 * `capsuleResult` becomes the compact manifest it was always meant to be: role,
 * identity, sizing and the deterministic digest. Its item bodies were a third
 * serialization of the same selected source.
 */
function compactCapsuleResult(
  draft: JsonRecord,
  options: {
    detail: McpResponseDetail;
    compactedFields: string[];
    omitted: Record<string, number>;
    expansion: Record<string, string>;
  },
): void {
  const capsuleResult = asRecord(draft.capsuleResult);
  if (capsuleResult === undefined) {
    return;
  }

  const contextItemIdByIdentity = productContextItemIdIndex(draft);
  let removedBodies = 0;
  let removedCharacters = 0;
  let removedReasons = 0;

  for (const group of ["pivots", "support"] as const) {
    const items = asRecordArray(capsuleResult[group]);
    if (items === undefined) continue;
    capsuleResult[group] = items.map((item) => {
      const next: JsonRecord = { ...item };
      for (const field of ["source", "signature"] as const) {
        const value = item[field];
        if (typeof value === "string" && value.length > 0) {
          removedBodies += 1;
          removedCharacters += value.length;
        }
        next[field] = null;
      }
      const path = typeof item.path === "string" ? item.path : "";
      const fqName = typeof item.fqName === "string" ? item.fqName : "";
      next.contextItemId = contextItemIdByIdentity.get(`${path}::${fqName}`) ?? null;
      // `evidence` restates productContext.items[].selectionReasons verbatim and
      // is rendered again in `digest`; the manifest keeps only the decisive line.
      const evidence = asStringArray(item.evidence);
      if (evidence !== undefined && evidence.length > 0) {
        next.evidence = [];
        options.omitted.capsuleItemEvidenceLines =
          (options.omitted.capsuleItemEvidenceLines ?? 0) + evidence.length;
      }
      // `roleReason` is the decisive line, and it is character-identical to an
      // entry in productContext.items[].selectionReasons -- measured 6/6 on a
      // real request, where it was also the single largest field in the manifest.
      // A reader who wants the reasoning follows `contextItemId`; a reader who
      // wants the manifest wants identity and role. Debug keeps both in place.
      if (options.detail !== McpResponseDetail.Debug && typeof item.roleReason === "string" && item.roleReason.length > 0) {
        next.roleReason = "";
        removedReasons += 1;
      }
      return next;
    });
  }

  if ((options.omitted.capsuleItemEvidenceLines ?? 0) > 0) {
    options.compactedFields.push("capsuleResult.pivots[].evidence", "capsuleResult.support[].evidence");
    options.expansion["capsuleResult.pivots[].evidence"] =
      "Same lines as productContext.items[].selectionReasons and capsuleResult.digest.";
  }

  const discarded = asRecordArray(capsuleResult.discarded);
  if (discarded !== undefined && discarded.length > 0) {
    capsuleResult.discarded = [];
    options.compactedFields.push("capsuleResult.discarded");
    options.omitted.capsuleDiscardedCandidates = discarded.length;
  }

  if (removedReasons > 0) {
    options.compactedFields.push("capsuleResult.pivots[].roleReason", "capsuleResult.support[].roleReason");
    options.omitted.capsuleItemRoleReasons = removedReasons;
    options.expansion["capsuleResult.pivots[].roleReason"] =
      "Same line as productContext.items[].selectionReasons for the matching contextItemId; kept in full at detail=debug.";
  }

  if (removedBodies > 0) {
    options.compactedFields.push("capsuleResult.pivots[].source", "capsuleResult.support[].source");
    options.omitted.capsuleItemBodies = removedBodies;
    options.omitted.capsuleItemBodyCharacters = removedCharacters;
    options.expansion["capsuleResult.pivots[].source"] =
      "Rendered once in productContext.modelVisibleContext; capsuleResult items reference it via contextItemId.";
  }
}

/**
 * `productContext.diagnostics` lists the selected, support and required files by
 * path -- a fourth restatement of a selection the response already carries in
 * `productContext.items`, which is right beside it and authoritative. The counts
 * are the part a caller acts on, so they stay; the paths become counts plus a
 * reference, and debug keeps the lists.
 *
 * `limitations` is NOT touched. It is the honest statement of what the evidence
 * cannot support, and a caller who drops it reads the rest more confidently than
 * they should.
 */
function compactProductContextDiagnostics(
  draft: JsonRecord,
  options: {
    detail: McpResponseDetail;
    compactedFields: string[];
    omitted: Record<string, number>;
    expansion: Record<string, string>;
  },
): void {
  if (options.detail === McpResponseDetail.Debug) return;
  const productContext = asRecord(draft.productContext);
  const diagnostics = productContext === undefined ? undefined : asRecord(productContext.diagnostics);
  if (diagnostics === undefined) return;

  let collapsed = 0;
  for (const key of ["selectedFiles", "supportFiles", "requiredFiles"] as const) {
    const value = asStringArray(diagnostics[key]);
    if (value === undefined || value.length === 0) continue;
    diagnostics[key] = [];
    diagnostics[`${key}Count`] = value.length;
    collapsed += value.length;
    options.compactedFields.push(`productContext.diagnostics.${key}`);
  }
  if (collapsed > 0) {
    options.omitted.productContextDiagnosticFilePaths = collapsed;
    options.expansion["productContext.diagnostics.selectedFiles"] =
      "Same paths as productContext.items[].path; kept in full at detail=debug.";
  }
}

/**
 * The legacy v1 `context` section predates `productContext` and re-describes the
 * same selection with per-candidate scoring. It stays as a compact alias so
 * existing readers keep their field, without a second selection representation.
 */
function compactLegacyContextSection(
  draft: JsonRecord,
  options: {
    compactedFields: string[];
    omitted: Record<string, number>;
    expansion: Record<string, string>;
  },
): void {
  const context = asRecord(draft.context);
  if (context === undefined) {
    return;
  }

  let omittedItems = 0;
  for (const group of ["pivots", "supports"] as const) {
    const items = asRecordArray(context[group]);
    if (items === undefined) continue;
    omittedItems += items.length;
    context[group] = items.map((item) => ({
      filePath: item.filePath ?? null,
      fqName: item.fqName ?? null,
      role: item.role ?? null,
      contentMode: item.contentMode ?? null,
    }));
  }

  if (omittedItems > 0) {
    context.supersededBy = "productContext";
    context.note =
      "Compatibility alias. Authoritative selection, roles, content modes and rendered context live in productContext.";
    options.compactedFields.push("context.pivots", "context.supports");
    options.omitted.legacyContextScoredItems = omittedItems;
    options.expansion["context"] = "Superseded by productContext; use productContext.items for full selection metadata.";
  }
}

/**
 * Retrieval telemetry (query variants, lane candidate matrices, term lists) is
 * benchmark-grade internal evidence. Normal context calls get counts; `debug`
 * gets bounded samples; nothing gets the raw matrix.
 */
function compactDiagnostics(
  draft: JsonRecord,
  options: {
    detail: McpResponseDetail;
    compactedFields: string[];
    omitted: Record<string, number>;
    expansion: Record<string, string>;
  },
): void {
  const diagnostics = asRecord(draft.diagnostics);
  if (diagnostics === undefined) {
    return;
  }

  if (options.detail === McpResponseDetail.Compact) {
    const retrieval = asRecord(diagnostics.retrieval);
    if (retrieval !== undefined) {
      diagnostics.retrieval = {
        initialReason: retrieval.initialReason ?? null,
        finalReason: retrieval.finalReason ?? null,
        fallbackApplied: retrieval.fallbackApplied ?? false,
        finalContextItemCount: retrieval.finalContextItemCount ?? 0,
        detail: "omitted_at_compact_detail",
      };
      options.compactedFields.push("diagnostics.retrieval");
    }
  } else {
    const retrieval = asRecord(diagnostics.retrieval);
    const search = retrieval === undefined ? undefined : asRecord(retrieval.search);
    if (retrieval !== undefined && search !== undefined) {
      let collapsed = 0;
      const bounded: JsonRecord = {};
      for (const key of Object.keys(search)) {
        const value = search[key];
        if (!Array.isArray(value)) {
          bounded[key] = value;
          continue;
        }
        // Only the large candidate/variant matrices are collapsed. Short term
        // lists are cheap and are the readable part of a retrieval decision.
        if (value.length <= MAX_INLINE_DIAGNOSTIC_ENTRIES && serialize(value).length <= MAX_INLINE_DIAGNOSTIC_CHARS) {
          bounded[key] = value;
          continue;
        }
        collapsed += value.length;
        bounded[`${key}Count`] = value.length;
        if (options.detail === McpResponseDetail.Debug && value.length > 0) {
          bounded[`${key}Sample`] = value.slice(0, MAX_DEBUG_SAMPLE);
        }
      }
      retrieval.search = bounded;
      if (collapsed > 0) {
        options.compactedFields.push("diagnostics.retrieval.search");
        options.omitted.retrievalSearchEntries = collapsed;
      }
    }

    for (const key of ["pathSignalsConsidered", "pathSignalsMatched"] as const) {
      const value = retrieval === undefined ? undefined : retrieval[key];
      if (Array.isArray(value) && value.length > MAX_DEBUG_SAMPLE) {
        (retrieval as JsonRecord)[key] = value.slice(0, MAX_DEBUG_SAMPLE);
        options.omitted[key] = value.length - MAX_DEBUG_SAMPLE;
      }
    }

  }

  // Index freshness is reported three times (productContext.freshness.refreshDiagnostics,
  // diagnostics.freshness, diagnostics.indexFreshness). `indexFreshness` is the
  // precise one; the others become references to it. Critical stale/missing status
  // is preserved in every location — only the repeated detail payload is dropped.
  const productContext = asRecord(draft.productContext);
  const productFreshness = productContext === undefined ? undefined : asRecord(productContext.freshness);
  if (
    productFreshness !== undefined
    && productFreshness.refreshDiagnostics !== undefined
    && productFreshness.refreshDiagnostics !== null
    && diagnostics.indexFreshness !== undefined
  ) {
    productFreshness.refreshDiagnostics = { ref: "diagnostics.indexFreshness" };
    options.compactedFields.push("productContext.freshness.refreshDiagnostics");
  }

}

/**
 * The readiness truth an agent needs, without the machine detail behind it.
 *
 * Status, reason, action and the readiness predicates are what distinguish ready
 * from degraded from stale from wrong-worktree, so they survive at every detail
 * level. Snapshot fingerprints, run ids, head comparisons, refresh bookkeeping and
 * performance timings answer "why did the indexer decide that", which is a question
 * for a maintainer at `detail=debug`, not for the model solving the task.
 */
export function agentFacingIndexFreshness(freshness: unknown): JsonRecord | null {
  const record = asRecord(freshness);
  if (record === undefined) {
    return freshness === null ? null : (freshness as JsonRecord | null) ?? null;
  }
  const core: JsonRecord = {};
  for (const key of AGENT_FACING_INDEX_FRESHNESS_KEYS) {
    if (record[key] !== undefined) core[key] = record[key];
  }
  return core;
}

/** Index-freshness fields that carry readiness truth rather than indexer bookkeeping. */
const AGENT_FACING_INDEX_FRESHNESS_KEYS = Object.freeze([
  "status",
  "reason",
  "action",
  "readiness",
]);

/** `diagnostics.freshness` fields that say what the state means and what to do. */
const AGENT_FACING_FRESHNESS_KEYS = Object.freeze([
  "state",
  "isStale",
  "summary",
  "whyItMatters",
  "recommendedAction",
  "reasons",
  "readiness",
]);

/**
 * Machine-facing `diagnostics` members. They answer how the answer was computed —
 * lane candidate matrices, scorer counts, budget arithmetic, per-stage timings —
 * and M166 measured them as model-visible and billed on every call while no
 * product code and no agent behaviour consumed them.
 */
const MACHINE_FACING_DIAGNOSTIC_MEMBERS = Object.freeze([
  "retrieval",
  "budget",
  "nudge",
  "intent",
  "memory",
  "rules",
  "impact",
  "flow",
  "deferredCount",
  "omittedSectionCount",
]);

/** Said where the removal happened, so a reduced block never reads as a complete one. */
const MACHINE_DIAGNOSTICS_AT_DEBUG_NOTE =
  "Machine-facing retrieval, budget, intent, memory, rules, impact, flow and index-internal diagnostics are returned in full at detail=debug.";

/**
 * Keep the diagnostics an agent can act on; hold the rest for `detail=debug`.
 *
 * M166-A measured what one call costs the model: the runtime hands it the entire
 * tool envelope, uncompacted, and the provider bills it once as cache-creation and
 * again on every later request in the run. M166-B found the diagnostics blocks
 * model-visible, billed, and — for the parts removed here — consumed by nothing.
 *
 * What survives is everything that stops a bounded answer reading as an
 * authoritative one: readiness status and its predicates, the component skip
 * reasons (which live in their own top-level sections, not here), and the omission
 * disclosures the envelope records. `detail=debug` is unchanged.
 */
function reduceDiagnosticsToAgentFacing(
  draft: JsonRecord,
  options: {
    detail: McpResponseDetail;
    compactedFields: string[];
    omitted: Record<string, number>;
    expansion: Record<string, string>;
  },
): void {
  if (options.detail === McpResponseDetail.Debug) {
    return;
  }
  const diagnostics = asRecord(draft.diagnostics);
  if (diagnostics === undefined) {
    return;
  }

  let removedCharacters = 0;
  for (const member of MACHINE_FACING_DIAGNOSTIC_MEMBERS) {
    if (diagnostics[member] === undefined) continue;
    removedCharacters += serialize(diagnostics[member]).length;
    delete diagnostics[member];
  }

  const freshness = asRecord(diagnostics.freshness);
  if (freshness !== undefined) {
    const before = serialize(freshness).length;
    const core: JsonRecord = {};
    for (const key of AGENT_FACING_FRESHNESS_KEYS) {
      if (freshness[key] !== undefined) core[key] = freshness[key];
    }
    diagnostics.freshness = core;
    removedCharacters += Math.max(0, before - serialize(core).length);
  }

  const indexFreshness = asRecord(diagnostics.indexFreshness);
  if (indexFreshness !== undefined) {
    const before = serialize(indexFreshness).length;
    const core = agentFacingIndexFreshness(indexFreshness) ?? {};
    diagnostics.indexFreshness = core;
    removedCharacters += Math.max(0, before - serialize(core).length);
  }

  if (removedCharacters > 0) {
    options.compactedFields.push("diagnostics");
    options.omitted.machineFacingDiagnosticCharacters = removedCharacters;
    // The envelope's `expansion_available` list is bounded and alphabetically
    // ordered, so a note placed only there can be truncated out of the response.
    // The disclosure belongs where the removal happened: a reader of `diagnostics`
    // must be able to tell "reduced" from "this is all there was" without
    // cross-referencing another block (§77).
    diagnostics.omittedForDetail = MACHINE_DIAGNOSTICS_AT_DEBUG_NOTE;
    options.expansion.diagnostics = MACHINE_DIAGNOSTICS_AT_DEBUG_NOTE;
  }
}

/**
 * Pivot neighborhood keeps identity and relation, not text. Its excerpts were a
 * fourth serialization of source already selected or reachable by path+lines.
 */
function compactPivotNeighborhood(
  draft: JsonRecord,
  options: {
    detail: McpResponseDetail;
    compactedFields: string[];
    omitted: Record<string, number>;
  },
): void {
  const neighborhoods = asRecordArray(draft.pivotNeighborhood);
  if (neighborhoods === undefined || neighborhoods.length === 0) {
    return;
  }

  if (options.detail === McpResponseDetail.Compact) {
    draft.pivotNeighborhood = [];
    options.compactedFields.push("pivotNeighborhood");
    options.omitted.pivotNeighborhoods = neighborhoods.length;
    return;
  }

  let removedExcerpts = 0;
  let removedCharacters = 0;
  const bounded = neighborhoods.slice(0, MAX_PIVOT_NEIGHBORHOOD_ENTRIES).map((entry) => {
    const excerpts = asRecordArray(entry.excerpts) ?? [];
    const kept = excerpts.slice(0, MAX_NEIGHBOR_RELATIONS_PER_PIVOT).map((excerpt) => {
      const text = typeof excerpt.text === "string" ? excerpt.text : "";
      if (text.length > 0) {
        removedExcerpts += 1;
        removedCharacters += text.length;
      }
      return {
        filePath: excerpt.filePath ?? null,
        symbol: excerpt.symbol ?? null,
        fqName: excerpt.fqName ?? null,
        startLine: excerpt.startLine ?? null,
        endLine: excerpt.endLine ?? null,
        reason: excerpt.reason ?? null,
        textCharacters: text.length,
      };
    });
    removedExcerpts += Math.max(0, excerpts.length - kept.length);
    return { ...entry, excerpts: kept };
  });

  draft.pivotNeighborhood = bounded;
  options.omitted.pivotNeighborhoodEntries = Math.max(0, neighborhoods.length - bounded.length);
  if (removedExcerpts > 0) {
    options.compactedFields.push("pivotNeighborhood[].excerpts[].text");
    options.omitted.pivotNeighborhoodExcerptCharacters = removedCharacters;
  }
}

function compactImpactSection(
  draft: JsonRecord,
  options: {
    detail: McpResponseDetail;
    compactedFields: string[];
    omitted: Record<string, number>;
  },
): void {
  const impact = asRecord(draft.impact);
  const dependents = impact === undefined ? undefined : asRecordArray(impact.topDependents);
  if (impact === undefined || dependents === undefined) {
    return;
  }
  const limit = options.detail === McpResponseDetail.Compact ? 3 : 6;
  if (dependents.length <= limit) {
    return;
  }
  impact.topDependents = dependents.slice(0, limit);
  options.compactedFields.push("impact.topDependents");
  options.omitted.impactDependents = dependents.length - limit;
}

/**
 * Deterministic escalation, applied only when the bounded default shape still
 * exceeds the ceiling. Ordered least-to-most informative loss; the authoritative
 * model-visible context and all freshness/provenance/warning state are never
 * touched, so an over-ceiling response degrades to metadata rather than to a
 * truncated or invalid payload.
 */
function enforceTotalEnvelope(
  draft: JsonRecord,
  options: {
    detail: McpResponseDetail;
    ceilingTokens: number;
    /** Current measured cost of the accounting block this ladder will be followed by. */
    accountingTokens: () => number;
    compactedFields: string[];
    omitted: Record<string, number>;
  },
): { applied: boolean } {
  // The accounting block is appended after this ladder runs, so its cost has to
  // be accounted for here — measured, not guessed, because it grows with the
  // number of compaction steps applied. A fixed guess left the ladder stopping
  // just under the ceiling and the finished response landing just over it.
  const withinBudget = (): boolean =>
    estimateTokens(serialize(draft)) + options.accountingTokens() <= options.ceilingTokens;

  const steps: Array<{ field: string; apply: () => number }> = [
    {
      field: "pivotNeighborhood",
      apply: () => {
        const entries = asRecordArray(draft.pivotNeighborhood);
        if (entries === undefined || entries.length === 0) return 0;
        draft.pivotNeighborhood = [];
        return entries.length;
      },
    },
    {
      field: "context",
      apply: () => {
        const context = asRecord(draft.context);
        if (context === undefined) return 0;
        draft.context = {
          included: context.included ?? false,
          skipReason: context.skipReason ?? null,
          itemCount: context.itemCount ?? 0,
          capsuleRef: context.capsuleRef ?? null,
          capsuleManifestId: context.capsuleManifestId ?? null,
          supersededBy: "productContext",
          note: "Dropped by response compaction; productContext carries the authoritative selection.",
          pivots: [],
          supports: [],
        };
        return 1;
      },
    },
    {
      field: "diagnostics.retrieval",
      apply: () => {
        const diagnostics = asRecord(draft.diagnostics);
        const retrieval = diagnostics === undefined ? undefined : asRecord(diagnostics.retrieval);
        if (diagnostics === undefined || retrieval === undefined) return 0;
        diagnostics.retrieval = {
          initialReason: retrieval.initialReason ?? null,
          finalReason: retrieval.finalReason ?? null,
          fallbackApplied: retrieval.fallbackApplied ?? false,
          finalContextItemCount: retrieval.finalContextItemCount ?? 0,
          detail: "omitted_by_response_compaction",
        };
        return 1;
      },
    },
    {
      field: "productContext.items[].selectionReasons",
      apply: () => {
        const productContext = asRecord(draft.productContext);
        const items = productContext === undefined ? undefined : asRecordArray(productContext.items);
        if (productContext === undefined || items === undefined) return 0;
        let dropped = 0;
        productContext.items = items.map((item) => {
          const reasons = asStringArray(item.selectionReasons) ?? [];
          if (reasons.length <= 1) return item;
          dropped += reasons.length - 1;
          return { ...item, selectionReasons: reasons.slice(0, 1), selectionReasonsOmitted: reasons.length - 1 };
        });
        return dropped;
      },
    },
    {
      field: "memory",
      apply: () => {
        const memory = asRecord(draft.memory);
        if (memory === undefined) return 0;
        let dropped = 0;
        for (const [group, key] of [["session", "recentObservations"], ["durable", "topObservations"]] as const) {
          const section = asRecord(memory[group]);
          const entries = section === undefined ? undefined : asRecordArray(section[key]);
          if (section === undefined || entries === undefined) continue;
          dropped += entries.length;
          section[key] = [];
        }
        return dropped;
      },
    },
    {
      // Repeated query text: `request.query` duplicates `request.task`, and
      // `taskSummary.normalizedQuery` is derivable. The task itself is retained.
      field: "duplicated_query_text",
      apply: () => {
        // `request` echoes the caller's own input verbatim and is a correctness
        // surface, so it is never rewritten. Only derived restatements are.
        let dropped = 0;
        const taskSummary = asRecord(draft.taskSummary);
        if (taskSummary !== undefined && typeof taskSummary.normalizedQuery === "string") {
          taskSummary.normalizedQuery = QUERY_REFERENCE;
          dropped += 1;
        }
        if (taskSummary !== undefined && typeof taskSummary.query === "string") {
          taskSummary.query = QUERY_REFERENCE;
          dropped += 1;
        }
        const capsuleResult = asRecord(draft.capsuleResult);
        if (capsuleResult !== undefined && typeof capsuleResult.query === "string") {
          capsuleResult.query = QUERY_REFERENCE;
          dropped += 1;
        }
        return dropped;
      },
    },
    {
      // The selected/required/support path lists restate items[].path.
      field: "productContext.diagnostics.selectedFiles",
      apply: () => {
        const productContext = asRecord(draft.productContext);
        const diagnostics = productContext === undefined ? undefined : asRecord(productContext.diagnostics);
        if (diagnostics === undefined) return 0;
        let dropped = 0;
        for (const key of ["selectedFiles", "requiredFiles", "supportFiles"] as const) {
          const files = asStringArray(diagnostics[key]);
          if (files === undefined || files.length === 0) continue;
          dropped += files.length;
          diagnostics[key] = [];
          diagnostics[`${key}Count`] = files.length;
        }
        return dropped;
      },
    },
    {
      // Keep status/reason/action/run identity; drop the verbose manifest deltas.
      field: "diagnostics.indexFreshness",
      apply: () => {
        const diagnostics = asRecord(draft.diagnostics);
        const freshness = diagnostics === undefined ? undefined : asRecord(diagnostics.indexFreshness);
        if (diagnostics === undefined || freshness === undefined) return 0;
        const essential: JsonRecord = {};
        let dropped = 0;
        for (const key of Object.keys(freshness)) {
          if (INDEX_FRESHNESS_ESSENTIAL.includes(key)) {
            essential[key] = freshness[key];
          } else {
            dropped += 1;
          }
        }
        // The sibling `freshness` block repeats the same state; keep its scalar
        // status fields (callers branch on them) and drop only nested detail.
        const sibling = asRecord(diagnostics.freshness);
        if (sibling !== undefined) {
          for (const key of Object.keys(sibling)) {
            if (typeof sibling[key] === "object" && sibling[key] !== null) {
              delete sibling[key];
              dropped += 1;
            }
          }
        }
        if (dropped === 0) return 0;
        essential.boundedDetailOmittedKeys = dropped;
        diagnostics.indexFreshness = essential;
        return dropped;
      },
    },
    {
      // Per-section decision mirrors: `diagnostics.impact` restates `impact.skipReason`,
      // `diagnostics.memory` restates `memory.*.included`, and so on. Kept by default
      // because they are small and documented; dropped only under a tight budget.
      field: "diagnostics.<section>",
      apply: () => {
        const diagnostics = asRecord(draft.diagnostics);
        if (diagnostics === undefined) return 0;
        let dropped = 0;
        for (const section of DIAGNOSTICS_DUPLICATED_SECTIONS) {
          if (diagnostics[section] === undefined) continue;
          delete diagnostics[section];
          dropped += 1;
        }
        if (dropped > 0) {
          diagnostics.sectionDecisionsOmitted = dropped;
          diagnostics.sectionDecisionsNote =
            "Each section publishes its own decision; this mirror was dropped by response compaction.";
        }
        return dropped;
      },
    },
    {
      field: "deferred.notes",
      apply: () => {
        const deferred = asRecord(draft.deferred);
        const notes = deferred === undefined ? undefined : asStringArray(deferred.notes);
        if (deferred === undefined || notes === undefined || notes.length === 0) return 0;
        deferred.notes = notes.slice(0, 1);
        return notes.length - 1;
      },
    },
    {
      field: "capsuleResult.pivots[].roleReason",
      apply: () => {
        const capsuleResult = asRecord(draft.capsuleResult);
        if (capsuleResult === undefined) return 0;
        let dropped = 0;
        for (const group of ["pivots", "support"] as const) {
          const items = asRecordArray(capsuleResult[group]);
          if (items === undefined) continue;
          capsuleResult[group] = items.map((item) => {
            if (typeof item.roleReason !== "string" || item.roleReason.length === 0) return item;
            dropped += 1;
            return { ...item, roleReason: "" };
          });
        }
        return dropped;
      },
    },
    {
      field: "productContext.items[].metadata",
      apply: () => {
        const productContext = asRecord(draft.productContext);
        const items = productContext === undefined ? undefined : asRecordArray(productContext.items);
        if (productContext === undefined || items === undefined) return 0;
        let dropped = 0;
        productContext.items = items.map((item) => {
          const metadata = asRecord(item.metadata);
          if (metadata === undefined) return item;
          const identity: JsonRecord = {};
          for (const key of ["fqName", "kind", "applicability", "targetKind"]) {
            if (metadata[key] !== undefined) identity[key] = metadata[key];
          }
          const removed = Object.keys(metadata).length - Object.keys(identity).length;
          if (removed <= 0) return item;
          dropped += removed;
          identity.boundedMetadataOmittedKeys = removed;
          return { ...item, metadata: identity };
        });
        return dropped;
      },
    },
    {
      field: "flow.paths[].sourceExcerpts",
      apply: () => {
        const flow = asRecord(draft.flow);
        const paths = flow === undefined ? undefined : asRecordArray(flow.paths);
        if (flow === undefined || paths === undefined) return 0;
        let dropped = 0;
        flow.paths = paths.map((path) => {
          const excerpts = asRecordArray(path.sourceExcerpts) ?? [];
          if (excerpts.length <= 1) return path;
          dropped += excerpts.length - 1;
          return { ...path, sourceExcerpts: excerpts.slice(0, 1) };
        });
        return dropped;
      },
    },
    {
      // `suggestedInput` re-serializes the task for every deferred ref; the hash
      // is the only field `expand_vexp_ref` actually needs.
      field: "deferred.items[].suggestedInput",
      apply: () => {
        const deferred = asRecord(draft.deferred);
        const items = deferred === undefined ? undefined : asRecordArray(deferred.items);
        if (deferred === undefined || items === undefined) return 0;
        let dropped = 0;
        deferred.items = items.map((item) => {
          const suggested = asRecord(item.suggestedInput);
          if (suggested === undefined || Object.keys(suggested).length === 0) return item;
          dropped += 1;
          return { ...item, suggestedInput: { hash: item.hash ?? null } };
        });
        return dropped;
      },
    },
    {
      // `intent` carries each decision twice under legacy and current names.
      field: "intent",
      apply: () => {
        const intent = asRecord(draft.intent);
        if (intent === undefined) return 0;
        let dropped = 0;
        for (const [alias, canonical] of INTENT_LEGACY_ALIASES) {
          if (intent[alias] !== undefined && intent[alias] === intent[canonical]) {
            delete intent[alias];
            dropped += 1;
          }
        }
        return dropped;
      },
    },
    {
      // The digest is a second *rendering* of the selection that
      // productContext.items already carries as structured metadata and
      // modelVisibleContext already carries as text.
      field: "capsuleResult.digest",
      apply: () => {
        const capsuleResult = asRecord(draft.capsuleResult);
        if (capsuleResult === undefined || typeof capsuleResult.digest !== "string") return 0;
        if (capsuleResult.digest.length === 0) return 0;
        capsuleResult.digest = "";
        return 1;
      },
    },
    {
      field: "productContext.items[].selectionReasons(all)",
      apply: () => {
        const productContext = asRecord(draft.productContext);
        const items = productContext === undefined ? undefined : asRecordArray(productContext.items);
        if (productContext === undefined || items === undefined) return 0;
        let dropped = 0;
        productContext.items = items.map((item) => {
          const reasons = asStringArray(item.selectionReasons) ?? [];
          if (reasons.length === 0) return item;
          dropped += reasons.length;
          const previous = typeof item.selectionReasonsOmitted === "number" ? item.selectionReasonsOmitted : 0;
          const next: JsonRecord = { ...item, selectionReasonsOmitted: previous + reasons.length };
          delete next.selectionReasons;
          return next;
        });
        return dropped;
      },
    },
    {
      field: "prose_notes",
      apply: () => {
        let dropped = 0;
        for (const section of ["rules", "deferred"] as const) {
          const record = asRecord(draft[section]);
          const notes = record === undefined ? undefined : asStringArray(record.notes);
          if (record === undefined || notes === undefined || notes.length === 0) continue;
          dropped += notes.length;
          record.notes = [];
        }
        const capsuleResult = asRecord(draft.capsuleResult);
        const hints = capsuleResult === undefined ? undefined : asRecordArray(capsuleResult.actionabilityHints);
        if (capsuleResult !== undefined && hints !== undefined) {
          capsuleResult.actionabilityHints = hints.map((hint) => {
            if (hint.patchObligation === undefined) return hint;
            dropped += 1;
            const obligation = asRecord(hint.patchObligation);
            return { ...hint, patchObligation: { kind: obligation?.kind ?? null, text: "" } };
          });
        }
        return dropped;
      },
    },
    {
      field: "inspectFirst.related",
      apply: () => {
        const inspectFirst = asRecord(draft.inspectFirst);
        const related = inspectFirst === undefined ? undefined : asRecordArray(inspectFirst.related);
        if (inspectFirst === undefined || related === undefined || related.length <= 1) return 0;
        inspectFirst.related = related.slice(0, 1);
        return related.length - 1;
      },
    },
    {
      // Once the digest is gone, capsuleResult item rows restate
      // productContext.items row for row. The manifest keeps only what makes it a
      // manifest: role, identity, and the reference back into the items array.
      field: "capsuleResult.pivots",
      apply: () => {
        const capsuleResult = asRecord(draft.capsuleResult);
        if (capsuleResult === undefined) return 0;
        let reduced = 0;
        for (const group of ["pivots", "support"] as const) {
          const items = asRecordArray(capsuleResult[group]);
          if (items === undefined || items.length === 0) continue;
          reduced += items.length;
          capsuleResult[group] = items.map((item) => ({
            role: item.role ?? null,
            path: item.path ?? null,
            fqName: item.fqName ?? null,
            contentMode: item.contentMode ?? null,
            estimatedTokens: item.estimatedTokens ?? 0,
            contextItemId: item.contextItemId ?? null,
          }));
        }
        if (capsuleResult.diagnostics !== undefined) {
          capsuleResult.diagnostics = { ref: "diagnostics.retrieval" };
          reduced += 1;
        }
        return reduced;
      },
    },
    {
      field: "inspectFirst",
      apply: () => {
        const inspectFirst = asRecord(draft.inspectFirst);
        if (inspectFirst === undefined) return 0;
        const likelyFirst = asRecord(inspectFirst.likelyFirst);
        if (likelyFirst === undefined) return 0;
        let dropped = 0;
        if (typeof likelyFirst.why === "string" && likelyFirst.why.length > 0) {
          likelyFirst.why = "";
          dropped += 1;
        }
        if (typeof inspectFirst.avoidFirst === "string" && inspectFirst.avoidFirst.length > 0) {
          inspectFirst.avoidFirst = "";
          dropped += 1;
        }
        return dropped;
      },
    },
    {
      field: "capsuleResult.actionabilityHints[].evidence",
      apply: () => {
        const capsuleResult = asRecord(draft.capsuleResult);
        const hints = capsuleResult === undefined ? undefined : asRecordArray(capsuleResult.actionabilityHints);
        if (capsuleResult === undefined || hints === undefined) return 0;
        let dropped = 0;
        capsuleResult.actionabilityHints = hints.map((hint) => {
          const evidence = asStringArray(hint.evidence) ?? [];
          if (evidence.length === 0) return hint;
          dropped += evidence.length;
          return { ...hint, evidence: [] };
        });
        return dropped;
      },
    },
    {
      // Last metadata tier: items keep identity, role, span, hash and sizing —
      // the fields §10 requires of a reference row — and nothing else.
      field: "productContext.items[].metadata(identity)",
      apply: () => {
        const productContext = asRecord(draft.productContext);
        const items = productContext === undefined ? undefined : asRecordArray(productContext.items);
        if (productContext === undefined || items === undefined) return 0;
        let dropped = 0;
        productContext.items = items.map((item) => {
          const metadata = asRecord(item.metadata);
          const next = { ...item };
          if (metadata !== undefined && Object.keys(metadata).length > 1) {
            dropped += Object.keys(metadata).length - 1;
            next.metadata = metadata.fqName === undefined ? {} : { fqName: metadata.fqName };
          }
          if (next.contentCharacters !== undefined) {
            delete next.contentCharacters;
            dropped += 1;
          }
          return next;
        });
        return dropped;
      },
    },
    {
      field: "deferred.items[].summary",
      apply: () => {
        const deferred = asRecord(draft.deferred);
        const items = deferred === undefined ? undefined : asRecordArray(deferred.items);
        if (deferred === undefined || items === undefined) return 0;
        let dropped = 0;
        deferred.items = items.map((item) => {
          if (typeof item.summary !== "string" || item.summary.length <= MAX_DEFERRED_SUMMARY_CHARS) return item;
          dropped += 1;
          return { ...item, summary: `${item.summary.slice(0, MAX_DEFERRED_SUMMARY_CHARS)}…` };
        });
        return dropped;
      },
    },
    {
      // Three accounting blocks describe the same call. `productContext.accounting`
      // is the authoritative one; the outer block keeps its latency and points at it.
      field: "accounting",
      apply: () => {
        const accounting = asRecord(draft.accounting);
        if (accounting === undefined || accounting.ref !== undefined) return 0;
        const dropped = Object.keys(accounting).length - 1;
        if (dropped <= 0) return 0;
        draft.accounting = {
          latencyMs: accounting.latencyMs ?? 0,
          ref: "productContext.accounting",
        };
        return dropped;
      },
    },
    {
      // Identity duplication: metadata.fqName is exactly `path::symbol` for these
      // rows, and both are already present.
      field: "productContext.items[].metadata(derivable)",
      apply: () => {
        const productContext = asRecord(draft.productContext);
        const items = productContext === undefined ? undefined : asRecordArray(productContext.items);
        if (productContext === undefined || items === undefined) return 0;
        let dropped = 0;
        productContext.items = items.map((item) => {
          const metadata = asRecord(item.metadata);
          const fqName = metadata?.fqName;
          if (
            metadata === undefined
            || Object.keys(metadata).length !== 1
            || typeof fqName !== "string"
            || fqName !== `${item.path ?? ""}::${item.symbol ?? ""}`
          ) {
            return item;
          }
          dropped += 1;
          const next: JsonRecord = { ...item };
          delete next.metadata;
          return next;
        });
        return dropped;
      },
    },
    {
      // Static per-call honesty boilerplate becomes a reference. The claims still
      // bind — they are stated in the tool's declared output schema — but they stop
      // being re-serialized on every response once the budget is this tight.
      field: "static_honesty_boilerplate",
      apply: () => {
        const productContext = asRecord(draft.productContext);
        const accounting = productContext === undefined ? undefined : asRecord(productContext.accounting);
        let dropped = 0;
        if (accounting !== undefined) {
          for (const key of ["baseline", "claimBoundary"] as const) {
            if (typeof accounting[key] === "string" && accounting[key] !== ACCOUNTING_CLAIM_REFERENCE) {
              accounting[key] = ACCOUNTING_CLAIM_REFERENCE;
              dropped += 1;
            }
          }
        }
        const diagnostics = productContext === undefined ? undefined : asRecord(productContext.diagnostics);
        const limitations = diagnostics === undefined ? undefined : asStringArray(diagnostics.limitations);
        if (diagnostics !== undefined && limitations !== undefined && limitations.length > 0) {
          const previous = typeof diagnostics.limitationsOmitted === "number" ? diagnostics.limitationsOmitted : 0;
          diagnostics.limitations = [];
          diagnostics.limitationsOmitted = previous + limitations.length;
          diagnostics.limitationsRef = ACCOUNTING_CLAIM_REFERENCE;
          dropped += limitations.length;
        }
        return dropped;
      },
    },
    {
      // Expansion handles, not evidence. The refs stay discoverable through
      // `expandable`; only their per-item detail goes.
      field: "deferred.items",
      apply: () => {
        const deferred = asRecord(draft.deferred);
        const items = deferred === undefined ? undefined : asRecordArray(deferred.items);
        if (deferred === undefined || items === undefined || items.length === 0) return 0;
        deferred.items = [];
        deferred.expandable = false;
        deferred.omittedItemCount = items.length;
        return items.length;
      },
    },
    {
      // Last tier for the manifest: counts and budget only. productContext.items
      // remains the authoritative per-item record, so nothing unique is lost.
      field: "capsuleResult.manifest_only",
      apply: () => {
        const capsuleResult = asRecord(draft.capsuleResult);
        if (capsuleResult === undefined) return 0;
        let dropped = 0;
        for (const group of ["pivots", "support", "actionabilityHints"] as const) {
          const items = asRecordArray(capsuleResult[group]);
          if (items === undefined || items.length === 0) continue;
          dropped += items.length;
          capsuleResult[group] = [];
        }
        if (dropped === 0) return 0;
        capsuleResult.supersededBy = "productContext.items";
        return dropped;
      },
    },
    {
      // Inline hop/dependent excerpts are SOURCE serialized outside the one
      // authoritative representation, and they grow with path length. A
      // one-hop answer never reaches this tier; a ten-hop one would otherwise
      // reintroduce the M130 duplication by the back door. Identity and span
      // survive, so the source stays one Read away.
      field: "flow.impact.excerptText",
      apply: () => {
        let stripped = 0;

        const stripExcerpt = (holder: JsonRecord | undefined): void => {
          const excerpt = holder === undefined ? undefined : asRecord(holder.sourceExcerpt);
          if (excerpt === undefined || typeof excerpt.text !== "string") return;
          excerpt.textCharacters = excerpt.text.length;
          delete excerpt.text;
          stripped += 1;
        };

        for (const flowPath of asRecordArray(asRecord(draft.flow)?.paths) ?? []) {
          // The product renders paths as `sourceExcerpts`; the raw engine output
          // renders them as `steps[].sourceExcerpt`. Both carry source text.
          for (const step of asRecordArray(flowPath.steps) ?? []) {
            stripExcerpt(step);
          }
          for (const excerpt of asRecordArray(flowPath.sourceExcerpts) ?? []) {
            if (typeof excerpt.text !== "string") continue;
            excerpt.textCharacters = excerpt.text.length;
            delete excerpt.text;
            stripped += 1;
          }
        }

        for (const dependent of asRecordArray(asRecord(draft.impact)?.topDependents) ?? []) {
          stripExcerpt(dependent);
        }

        return stripped;
      },
    },
    {
      // Per-item metadata grows with the selection, and at a full context budget
      // even compact rows can outgrow the metadata allowance. M130 never saw this
      // because the incident carried four items. Items are ordered by selection
      // priority, so the retained prefix is the part that matters most, and the
      // rendered context itself is untouched.
      field: "productContext.items",
      apply: () => {
        const productContext = asRecord(draft.productContext);
        const items = productContext === undefined ? undefined : asRecordArray(productContext.items);
        if (productContext === undefined || items === undefined || items.length <= MIN_RETAINED_PRODUCT_ITEMS) {
          return 0;
        }

        const original = items.length;
        let kept = original;

        // Halve until it fits or the floor is reached: bounded iterations, and
        // every intermediate state is a valid response.
        while (kept > MIN_RETAINED_PRODUCT_ITEMS) {
          kept = Math.max(MIN_RETAINED_PRODUCT_ITEMS, Math.floor(kept / 2));
          productContext.items = items.slice(0, kept);
          productContext.omittedItemCount = original - kept;
          if (withinBudget()) break;
        }

        return original - kept;
      },
    },
    {
      // Per-step limitations are the same static honesty boilerplate repeated
      // once per hop. The path's own `limitations` still carries it once.
      field: "flow.paths[].steps[].relation.limitations",
      apply: () => {
        let dropped = 0;
        for (const flowPath of asRecordArray(asRecord(draft.flow)?.paths) ?? []) {
          for (const step of asRecordArray(flowPath.steps) ?? []) {
            const relation = asRecord(step.relation);
            const limitations = relation === undefined ? undefined : asStringArray(relation.limitations);
            if (relation === undefined || limitations === undefined || limitations.length === 0) continue;
            delete relation.limitations;
            dropped += limitations.length;
          }
        }
        return dropped;
      },
    },
    {
      // A long path costs per hop. The first hops are the ones a reader acts on,
      // so later hops keep identity (edge type and endpoints) and lose evidence.
      // The path shape — which is the answer — is unchanged.
      field: "flow.paths[].steps[].evidence",
      apply: () => {
        let dropped = 0;
        for (const flowPath of asRecordArray(asRecord(draft.flow)?.paths) ?? []) {
          const steps = asRecordArray(flowPath.steps);
          if (steps !== undefined && steps.length > MAX_DETAILED_FLOW_STEPS) {
            for (const step of steps.slice(MAX_DETAILED_FLOW_STEPS)) {
              if (step.relation === undefined && step.sourceExcerpt === undefined) continue;
              delete step.relation;
              delete step.sourceExcerpt;
              dropped += 1;
            }
            flowPath.stepEvidenceOmitted = steps.length - MAX_DETAILED_FLOW_STEPS;
          }

          const excerpts = asRecordArray(flowPath.sourceExcerpts);
          if (excerpts !== undefined && excerpts.length > MAX_DETAILED_FLOW_STEPS) {
            flowPath.sourceExcerpts = excerpts.slice(0, MAX_DETAILED_FLOW_STEPS);
            flowPath.sourceExcerptsOmitted = excerpts.length - MAX_DETAILED_FLOW_STEPS;
            dropped += excerpts.length - MAX_DETAILED_FLOW_STEPS;
          }
        }
        return dropped;
      },
    },
    {
      // Last tier for flow: the decision, the claim scope and the reason survive;
      // the enumerated paths do not. A negative or bounded result must never lose
      // the words that make it truthful, so only `paths` goes.
      field: "flow.paths",
      apply: () => {
        const flow = asRecord(draft.flow);
        const paths = flow === undefined ? undefined : asRecordArray(flow.paths);
        if (flow === undefined || paths === undefined || paths.length === 0) return 0;
        flow.paths = [];
        flow.pathsOmitted = paths.length;
        return paths.length;
      },
    },
    {
      // Static per-call honesty boilerplate; the two load-bearing lines stay.
      field: "productContext.diagnostics.limitations",
      apply: () => {
        const productContext = asRecord(draft.productContext);
        const diagnostics = productContext === undefined ? undefined : asRecord(productContext.diagnostics);
        const limitations = diagnostics === undefined ? undefined : asStringArray(diagnostics.limitations);
        if (diagnostics === undefined || limitations === undefined || limitations.length <= 2) return 0;
        diagnostics.limitations = limitations.slice(0, 2);
        diagnostics.limitationsOmitted = limitations.length - 2;
        return limitations.length - 2;
      },
    },
  ];

  let applied = false;
  for (const step of steps) {
    if (withinBudget()) {
      break;
    }
    const dropped = step.apply();
    if (dropped === 0) continue;
    applied = true;
    options.compactedFields.push(step.field);
    options.omitted[`compaction:${step.field}`] = dropped;
  }

  // Guaranteed backstop. The named steps above remove duplication; this removes
  // whole OPTIONAL sections, lowest value first, so the envelope holds for any
  // input rather than only for the shapes the named steps happened to anticipate.
  // The authoritative model-visible context, freshness, provenance, warnings and
  // accounting are not in this list and are never removed.
  for (const section of LAST_RESORT_OPTIONAL_SECTIONS) {
    if (withinBudget()) {
      break;
    }
    if (draft[section] === undefined || draft[section] === null) continue;
    const characters = serialize(draft[section]).length;
    if (characters <= 2) continue;
    // Arrays empty, objects null. Both are valid values of the declared optional
    // section; `compacted_fields` and `omitted_detail_counts` say what happened.
    draft[section] = Array.isArray(draft[section]) ? [] : null;
    applied = true;
    options.compactedFields.push(section);
    options.omitted[`compaction:${section}`] = characters;
  }

  return { applied };
}

function measureResponse(
  draft: JsonRecord,
  input: {
    requestedContextTokens: number;
    modelVisibleContext: string;
    detail: McpResponseDetail;
    compactionApplied: boolean;
    compactedFields: string[];
    omitted: Record<string, number>;
    expansion: Record<string, string>;
  },
): ResponseBudgetAccounting {
  const modelVisibleTokens = estimateTokens(input.modelVisibleContext);
  const settle = (compactAccounting: boolean): ResponseBudgetAccounting => {
    const build = (serializedCharacters: number): ResponseBudgetAccounting => buildAccounting({
      ...input,
      modelVisibleTokens,
      serializedCharacters,
      compactAccounting,
    });

    // The accounting block is itself part of the payload, so measuring it is a
    // small fixpoint: only the digit width of the recorded figures can change.
    let accounting = build(0);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const measured = serialize({ ...draft, responseBudget: accounting }).length;
      if (measured === accounting.serialized_response_characters) {
        return accounting;
      }
      accounting = build(measured);
    }
    return accounting;
  };

  const full = settle(false);
  // Spending the last of the envelope on the accounting block's own prose would
  // be the one compaction that helps nobody.
  return full.within_envelope ? full : settle(true);
}

/** Pure accounting-block construction, shared by the ladder's reserve and the final measurement. */
function buildAccounting(input: {
  requestedContextTokens: number;
  modelVisibleTokens: number;
  detail: McpResponseDetail;
  compactionApplied: boolean;
  compactedFields: readonly string[];
  omitted: Record<string, number>;
  expansion: Record<string, string>;
  serializedCharacters: number;
  /**
   * Drop the per-response prose and trim the audit lists. The accounting block
   * is itself part of the payload — around 300 tokens of a 1000-token metadata
   * allowance — so under a tight budget its own explanatory text is the last
   * thing worth spending the envelope on. Every load-bearing figure survives.
   */
  compactAccounting?: boolean;
}): ResponseBudgetAccounting {
  const totalTokens = estimateTokens("x".repeat(input.serializedCharacters));
  const compact = input.compactAccounting === true;
  const reportedFields = compact ? 3 : MAX_REPORTED_COMPACTED_FIELDS;
  return {
    envelopeVersion: MCP_RESPONSE_ENVELOPE_VERSION,
    requested_context_tokens: input.requestedContextTokens,
    estimated_model_visible_tokens: input.modelVisibleTokens,
    estimated_metadata_tokens: Math.max(0, totalTokens - input.modelVisibleTokens),
    estimated_total_response_tokens: totalTokens,
    total_response_token_ceiling: responseTokenCeiling(input.requestedContextTokens),
    serialized_response_characters: input.serializedCharacters,
    within_envelope: totalTokens <= responseTokenCeiling(input.requestedContextTokens),
    compaction_applied: input.compactionApplied,
    compacted_fields: [...new Set(input.compactedFields)].sort().slice(0, reportedFields),
    omitted_detail_counts: compact ? {} : boundedCounts(input.omitted),
    expansion_available: compact ? {} : boundedExpansions(input.expansion),
    diagnostics_detail: input.detail,
    estimate_method: "chars_div_4",
    notes: compact
      ? ["Accounting detail was itself compacted to fit the response ceiling; see the tool output schema."]
      : [
        "Token figures are chars/4 estimates, not tokenizer counts.",
        "max_tokens bounds the model-visible context; the total ceiling adds a documented metadata allowance.",
      ],
  };
}

function productContextItemIdIndex(draft: JsonRecord): Map<string, string> {
  const index = new Map<string, string>();
  const productContext = asRecord(draft.productContext);
  const items = productContext === undefined ? undefined : asRecordArray(productContext.items);
  if (items === undefined) {
    return index;
  }
  for (const item of items) {
    const metadata = asRecord(item.metadata);
    const fqName = typeof metadata?.fqName === "string" ? metadata.fqName : "";
    const path = typeof item.path === "string" ? item.path : "";
    const id = typeof item.id === "string" ? item.id : undefined;
    if (id !== undefined) {
      index.set(`${path}::${fqName}`, id);
    }
  }
  return index;
}

/** Largest counts first, so the bound keeps the most consequential omissions. */
function boundedCounts(counts: Record<string, number>): Record<string, number> {
  const entries = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      rightValue - leftValue || leftKey.localeCompare(rightKey));
  const kept = entries.slice(0, MAX_REPORTED_OMITTED_COUNTS);
  const bounded = Object.fromEntries(kept);
  if (entries.length > kept.length) {
    bounded.additionalOmittedDetailKinds = entries.length - kept.length;
  }
  return bounded;
}

function boundedExpansions(expansion: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(expansion).sort(([left], [right]) => left.localeCompare(right)).slice(0, MAX_REPORTED_EXPANSIONS),
  );
}

export function serialize(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function asRecordArray(value: unknown): JsonRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => (asRecord(entry) ?? {} as JsonRecord));
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}
