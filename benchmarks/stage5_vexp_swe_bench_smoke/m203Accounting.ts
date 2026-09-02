/**
 * M203 — the accounting integrity analyzer, and the frozen A14 predicate.
 *
 * PURE. Reads a delivered orientation packet and the ledger the projector
 * published for it, and decides whether the ledger is a truthful description of
 * that packet. It changes nothing and computes nothing about a repository; it
 * re-measures serializations and compares them with what the ledger claims.
 *
 * The frozen A14 predicate is reproduced here VERBATIM from
 * `run_stage5_m197a_engine.ts` (the `itemsWithTokenAccounting` count) so the
 * pre/post reproduction counts with the committed rule and not a restatement of
 * it. It is not the analyzer's rule: A14 asks whether a field is present; the
 * analyzer asks whether the field is true.
 */

export interface AccountedItem {
  readonly at?: unknown;
  readonly tokens?: unknown;
  readonly tokenReductionPercent?: unknown;
  readonly rawTokens?: unknown;
  readonly savedTokens?: unknown;
  readonly code?: unknown;
  readonly form?: unknown;
}

/** The frozen scorer's per-item test, byte-for-byte the engine's predicate. */
export const frozenA14ItemHasAccounting = (it: any): boolean =>
  !!(it && (it.tokens !== undefined || it.tokenReductionPercent !== undefined
    || it.rawTokens !== undefined || it.savedTokens !== undefined));

/** The frozen scorer's denominator for one response: the focus slot plus every related entry. */
export const frozenA14ItemsDelivered = (out: any): number => 1 + (out?.related ?? []).length;

/** The frozen scorer's numerator for one response. */
export const frozenA14ItemsAccounted = (out: any): number =>
  [out?.focus, ...(out?.related ?? [])].filter(frozenA14ItemHasAccounting).length;

/**
 * The frozen A12 class label for an item, as the engine derives it. Used only to
 * enumerate the representation classes the corpus contains; the analyzer holds
 * every class to the same contract.
 */
export function frozenRepresentationClass(item: any, slot: "focus" | "related"): string {
  if (slot === "focus") return `FOCUS:${item?.form ?? "unknown"}`;
  return typeof item?.code === "string" ? "RELATED_WITH_CODE" : "RELATIONSHIP_ONLY";
}

const TOKENS_PER_CHARACTER = 0.3174032272551657;
const tokensOf = (characters: number) => Math.max(0, Math.round(characters * TOKENS_PER_CHARACTER));

export interface Gate { readonly id: string; readonly pass: boolean; readonly detail: string }

export interface AnalysisInput {
  /** The delivered packet, exactly as the tool returned it. */
  readonly packet: any;
  /** The ledger the projector published for it, or undefined when none was. */
  readonly ledger: any;
  /** The ceiling the projector declares. */
  readonly ceilingTokens: number;
}

export interface Analysis {
  readonly verdict: "ACCOUNTING_INTEGRITY_PASS" | "ACCOUNTING_INTEGRITY_FAIL";
  readonly gates: readonly Gate[];
  readonly eligible: number;
  readonly accounted: number;
}

const VALID_REPRESENTATIONS = new Set([
  "focused_source", "full_source", "excerpt", "skeleton", "signature", "summary",
  "document_excerpt", "unlabelled", "relationship_only",
]);
const VALID_ORIGINS = new Set(["item_supply", "pivot_neighborhood"]);
const VALID_REASON_SOURCES = new Set(["selection_reason", "roles", "neighbor_relation"]);
const isAbsence = (v: unknown) => v === "unavailable" || v === "not_applicable";
const isCount = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Hold a ledger to the packet it claims to describe. Every gate is a
 * re-measurement or a structural check; none reads a value from the ledger and
 * trusts it.
 */
export function analyzeAccounting(input: AnalysisInput): Analysis {
  const gates: Gate[] = [];
  const gate = (id: string, pass: boolean, detail: string) => { gates.push({ id, pass, detail }); };
  const packet = input.packet ?? {};
  const delivered: any[] = [packet.focus, ...(packet.related ?? [])];
  const eligible = delivered.length;
  const ledger = input.ledger;
  const items: any[] = Array.isArray(ledger?.items) ? ledger.items : [];

  gate("ledger_present", ledger !== undefined && ledger !== null, ledger ? "ledger published" : "no ledger for this packet");
  if (!ledger) {
    return { verdict: "ACCOUNTING_INTEGRITY_FAIL", gates, eligible, accounted: 0 };
  }

  // Coverage: one record per delivered item, no more, no fewer, same identities, same order.
  gate("every_item_accounted", items.length === eligible,
    `${items.length} records for ${eligible} delivered items`);
  const deliveredIds = delivered.map((d) => String(d?.at ?? ""));
  const ledgerIds = items.map((i) => String(i?.at ?? ""));
  gate("identities_match_in_order", JSON.stringify(deliveredIds) === JSON.stringify(ledgerIds),
    ledgerIds.length === deliveredIds.length ? "record i describes delivered item i" : "length differs");
  gate("no_duplicate_records", new Set(ledgerIds).size === ledgerIds.length,
    `${ledgerIds.length - new Set(ledgerIds).size} duplicate identities`);
  gate("no_duplicate_delivery", new Set(deliveredIds).size === deliveredIds.length,
    `${deliveredIds.length - new Set(deliveredIds).size} identities delivered twice`);
  gate("ordinals_valid", items.every((i, k) => i?.ordinal === k)
    && (items.length === 0 || (items[0]?.slot === "focus" && items.slice(1).every((i) => i?.slot === "related"))),
    "ordinal k at position k; focus at 0, related after");
  gate("identity_is_semantic", items.every((i) => typeof i?.at === "string" && i.at.length > 0
    && !("uuid" in i) && !("timestamp" in i)),
    "identity is the canonical path::Symbol; no random or clock-derived key");

  // Every delivered item carries the model-facing field, and it is the ledger's actual cost.
  const accounted = delivered.filter((d) => isCount(d?.tokens)).length;
  gate("model_facing_field_per_item", accounted === eligible, `${accounted} of ${eligible} carry tokens`);
  gate("field_equals_actual", items.every((i, k) => delivered[k]?.tokens === i?.actualTokens),
    "packet.tokens == ledger.actualTokens on every item");
  // The model-facing field itself, against the serializer, independent of the ledger.
  const serializedOf = (k: number) => delivered[k] === undefined ? "" : JSON.stringify(delivered[k]);
  gate("field_is_measured", delivered.every((d, k) => d?.tokens === tokensOf(serializedOf(k).length)),
    "packet.tokens is the serialized item's cost under the packet rule");

  // Actual cost is a measurement of the delivered serialization under the packet rule.
  const costMismatches = items.filter((i, k) => {
    const serialized = serializedOf(k);
    return i?.characters !== serialized.length || i?.actualTokens !== tokensOf(serialized.length);
  });
  gate("actual_cost_is_measured", costMismatches.length === 0,
    `${costMismatches.length} records whose characters/tokens differ from the serialized item`);

  // Estimated is not actual: the admission figure is the item without its field.
  const estimateMismatches = items.filter((i, k) => {
    if (delivered[k] === undefined) return true;
    const { tokens: _t, ...evidence } = delivered[k];
    return i?.estimatedTokens !== tokensOf(JSON.stringify(evidence).length);
  });
  gate("estimate_is_admission_time_cost", estimateMismatches.length === 0,
    `${estimateMismatches.length} records whose estimatedTokens is not the item's cost without the field`);
  gate("estimate_not_overwritten", items.every((i) => isCount(i?.estimatedTokens) && isCount(i?.actualTokens)
    && i.estimatedTokens <= i.actualTokens), "estimated <= actual on every item; both present");

  // Representation truth.
  gate("representation_valid", items.every((i) => VALID_REPRESENTATIONS.has(String(i?.representation))),
    `classes: ${[...new Set(items.map((i) => String(i?.representation)))].join(", ") || "none"}`);
  gate("delivered_code_measured", items.every((i, k) => {
    const code = delivered[k]?.code;
    const chars = typeof code === "string" ? code.length : 0;
    return i?.deliveredCodeCharacters === chars && i?.codeDelivered === (typeof code === "string");
  }), "deliveredCodeCharacters equals the code actually in the packet");
  gate("truncation_truthful", items.every((i, k) => {
    const truncated = delivered[k]?.codeTruncated === true;
    if (i?.truncated !== truncated) return false;
    if (!truncated) return true;
    return typeof i?.bodyCharacters === "number" && i.bodyCharacters > i.deliveredCodeCharacters;
  }), "a truncated item reports a body larger than what it delivered; an untruncated one does not");
  gate("absence_is_explicit", items.every((i) =>
    (isCount(i?.upstreamEstimatedTokens) || isAbsence(i?.upstreamEstimatedTokens))
    && (isCount(i?.bodyCharacters) || isAbsence(i?.bodyCharacters))
    && (typeof i?.sourceId === "string")),
    "unavailable / not_applicable are stated, never encoded as 0");

  // Attribution.
  gate("origin_valid", items.every((i) => VALID_ORIGINS.has(String(i?.origin))
    && Array.isArray(i?.origins) && i.origins.length > 0 && i.origins[0] === i.origin
    && i.origins.every((o: unknown) => VALID_ORIGINS.has(String(o)))),
    "admitting origin is the first proposer; every origin is a known route");
  gate("reason_is_the_packet_claim", items.every((i, k) => {
    const claim = k === 0 ? (delivered[0]?.why ?? "") : delivered[k]?.how;
    return i?.reason === claim && VALID_REASON_SOURCES.has(String(i?.reasonSource));
  }), "ledger.reason is the verbatim why/how the packet carries");
  gate("neighbour_reason_is_frozen_phrase", items.every((i) =>
    i?.origin !== "pivot_neighborhood" || i?.reasonSource === "neighbor_relation"),
    "a neighbourhood item is attributed to the relation table, never to a selection reason");

  // Reconciliation.
  const packetCharacters = JSON.stringify(packet).length;
  const itemCharacters = delivered.reduce((n, d) => n + JSON.stringify(d).length, 0);
  const r = ledger.reconciliation ?? {};
  gate("characters_reconcile_exactly", r.itemCharacters === itemCharacters
    && r.packetCharacters === packetCharacters
    && r.itemCharacters + r.wrapperCharacters === packetCharacters && r.charactersExact === true,
    `${itemCharacters} item + ${r.wrapperCharacters} wrapper = ${packetCharacters} packet`);
  const itemTokens = items.reduce((n, i) => n + (i?.actualTokens ?? 0), 0);
  gate("tokens_reconcile_within_bound", r.itemTokens === itemTokens && r.packetTokens === tokensOf(packetCharacters)
    && Math.abs(r.packetTokens - (r.itemTokens + r.wrapperTokens)) === r.tokenDeviation
    && r.tokenDeviation <= r.tokenDeviationBound && r.tokenDeviationBound === Math.ceil((items.length + 2) / 2),
    `deviation ${r.tokenDeviation} within bound ${r.tokenDeviationBound}`);
  let cumulativeC = 0; let cumulativeT = 0;
  gate("cumulative_consistent", items.every((i) => {
    cumulativeC += i?.characters ?? 0; cumulativeT += i?.actualTokens ?? 0;
    return i?.cumulativeCharacters === cumulativeC && i?.cumulativeTokens === cumulativeT;
  }) && (items.length === 0 || items.at(-1)!.cumulativeCharacters === itemCharacters),
    "running totals match the per-item figures and end at the item total");

  // Budget: the ceiling was honoured on the evidence packet; the overhead is charged and stated.
  const { tokens: _ft, ...focusEvidence } = packet.focus ?? {};
  const evidencePacket = { ...packet, focus: focusEvidence,
    related: (packet.related ?? []).map(({ tokens: _t, ...rest }: any) => rest) };
  const evidenceCharacters = JSON.stringify(evidencePacket).length;
  gate("evidence_packet_measured", ledger.evidence?.characters === evidenceCharacters
    && ledger.evidence?.tokens === tokensOf(evidenceCharacters),
    `evidence ${evidenceCharacters} chars / ${tokensOf(evidenceCharacters)} tokens`);
  gate("ceiling_honoured_on_evidence", ledger.ceilingTokens === input.ceilingTokens
    && ledger.ceilingAppliesTo === "evidence_packet"
    && ledger.evidence?.withinCeiling === (ledger.evidence?.tokens <= input.ceilingTokens)
    && (items.length <= 1 || ledger.evidence?.tokens <= input.ceilingTokens),
    `evidence ${ledger.evidence?.tokens} vs ceiling ${input.ceilingTokens}`);
  gate("overhead_charged", ledger.packet?.characters === packetCharacters
    && ledger.packet?.tokens === tokensOf(packetCharacters)
    && ledger.accountingOverhead?.characters === packetCharacters - evidenceCharacters
    && ledger.accountingOverhead?.tokens === tokensOf(packetCharacters) - tokensOf(evidenceCharacters),
    `overhead ${ledger.accountingOverhead?.tokens} tokens over evidence`);
  gate("admission_figures_bounded", items.every((i) => isCount(i?.admissionPacketTokens)
    && i.admissionPacketTokens <= input.ceilingTokens)
    && (items.length === 0 || items.at(-1)!.admissionPacketTokens === ledger.evidence?.tokens),
    "every admitted item's admission packet within the ceiling; last equals the evidence packet");
  gate("rejections_are_over_ceiling", (ledger.candidates?.rejected ?? []).every((c: any) =>
    c?.reason === "ceiling" && c?.admissionPacketTokens > input.ceilingTokens),
    `${ledger.candidates?.rejectedForCeiling ?? 0} rejected for the ceiling`);
  const c = ledger.candidates ?? {};
  gate("candidate_arithmetic", [c.proposed, c.admitted, c.deduplicated, c.droppedNoClaim, c.rejectedForCeiling, c.notReached].every(isCount)
    && c.proposed === c.admitted + c.deduplicated + c.droppedNoClaim + c.rejectedForCeiling + c.notReached
    && c.admitted === items.length && (c.rejectedForCeiling === 0 ? c.notReached === 0 : c.rejectedForCeiling === 1),
    `proposed ${c.proposed} = admitted ${c.admitted} + deduplicated ${c.deduplicated} + no-claim ${c.droppedNoClaim} `
      + `+ rejected ${c.rejectedForCeiling} + not reached ${c.notReached}`);
  gate("evidence_budget_stated", ledger.evidenceBudget?.method === "characters_div_4"
    && (isCount(ledger.evidenceBudget?.requestedTokens) || isAbsence(ledger.evidenceBudget?.requestedTokens)),
    `requested ${ledger.evidenceBudget?.requestedTokens}, visible ${ledger.evidenceBudget?.modelVisibleTokens}, remaining ${ledger.evidenceBudget?.remainingTokens}`);

  const pass = gates.every((g) => g.pass);
  return { verdict: pass ? "ACCOUNTING_INTEGRITY_PASS" : "ACCOUNTING_INTEGRITY_FAIL", gates, eligible, accounted };
}

/** The packet with its one model-facing accounting field removed: the pre-M203 packet. */
export function stripAccounting(packet: any): any {
  if (!packet || typeof packet !== "object" || !("focus" in packet)) return packet;
  const strip = ({ tokens: _t, ...rest }: any) => rest;
  const out: any = {};
  for (const [k, v] of Object.entries(packet)) {
    out[k] = k === "focus" ? strip(v) : k === "related" ? (v as any[]).map(strip) : v;
  }
  return out;
}
