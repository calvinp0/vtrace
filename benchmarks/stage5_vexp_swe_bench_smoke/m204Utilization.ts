/**
 * M204 — the budget-utilization analyzer, and the frozen A11 rule.
 *
 * PURE. Reads one delivered orientation packet, the ledger the projector
 * published for it (M203's accounting authority, consumed here and not
 * duplicated), and the upstream supply facts the driver observed, and states
 *
 *   what the caller authorised, what the projector was allowed, what the
 *   supply offered, what was consumed, what was left, and WHICH authority
 *   first prevented another eligible ranked item from being delivered.
 *
 * It changes nothing. Every number is a re-measurement of a serialization that
 * exists or a value copied from the ledger under its own label, and every
 * verdict is a comparison the reader can repeat.
 *
 * The frozen A11 rule is reproduced VERBATIM from `run_stage5_m197a_engine.ts`
 * and `run_stage5_m197a_report.ts`: the numerator is `ceil(characters / 4)` of
 * the whole model-facing output, the denominator is the caller's `max_tokens`,
 * the aggregate is the per-budget median over the 20 C-MED tasks, and the band
 * is MATCHES at >= 60% on every budget, EXCEEDS at >= 80%. Nothing in this file
 * is a second utilisation formula; the analyzer explains the frozen number, it
 * does not replace it.
 */

import { analyzeAccounting, frozenA14ItemsAccounted, frozenA14ItemsDelivered } from "./m203Accounting";

// ------------------------------------------------------------ the frozen rule

export const A11_BUDGETS = [1000, 2000, 4000, 8000, 16000] as const;
export const A11_MATCH_PERCENT = 60;
export const A11_EXCEED_PERCENT = 80;

/** The frozen scorer's numerator for one response: `tokens(JSON.stringify(out ?? {}))`, tokens = ceil(chars/4). */
export const frozenWholeResponseTokens = (out: unknown): number =>
  Math.ceil(JSON.stringify(out ?? {}).length / 4);

/** The frozen scorer's per-response figure: `+(100 * whole / budget).toFixed(2)`. */
export const frozenUtilisationPercent = (out: unknown, budget: number): number =>
  +(100 * frozenWholeResponseTokens(out) / budget).toFixed(2);

export type FrozenVerdict = "VTRACE_EXCEEDS_VEXP_CLAIM" | "VTRACE_MATCHES_VEXP_CLAIM" | "VTRACE_BELOW_VEXP_CLAIM";

/** `band(values, 60, 80, "atLeast")` from the frozen report, over the per-budget medians. */
export function frozenA11Verdict(mediansByBudget: readonly (number | null)[]): FrozenVerdict | null {
  if (mediansByBudget.length === 0 || mediansByBudget.some((v) => v === null || Number.isNaN(v))) return null;
  const nums = mediansByBudget as number[];
  if (nums.every((v) => v >= A11_EXCEED_PERCENT)) return "VTRACE_EXCEEDS_VEXP_CLAIM";
  if (nums.every((v) => v >= A11_MATCH_PERCENT)) return "VTRACE_MATCHES_VEXP_CLAIM";
  return "VTRACE_BELOW_VEXP_CLAIM";
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

// ----------------------------------------------------------- the vocabulary

export type BindingReason =
  | "NO_ELIGIBLE_EVIDENCE"
  | "UPSTREAM_BUDGET_EXHAUSTED"
  | "ORIENTATION_CEILING"
  | "ITEM_TOO_LARGE"
  | "REPRESENTATION_CAP"
  | "HEAD_BOUND"
  | "PROGRESSIVE_BUDGET_DROP"
  | "OTHER";

const TOKENS_PER_CHARACTER = 0.3174032272551657;
const packetTokensOf = (characters: number) => Math.max(0, Math.round(characters * TOKENS_PER_CHARACTER));

/**
 * What the driver could observe about the supply ABOVE the projector, from the
 * authoritative (detail=debug) response of the same request and from the
 * product's own allocator. Absent facts are null, never 0.
 */
export interface UpstreamSupply {
  /** Capsule v2 sizing tier the budget selected (`allocateBudget`). */
  readonly tier: string | null;
  readonly maxPivots: number | null;
  readonly maxSupport: number | null;
  readonly candidateCount: number | null;
  readonly pivotCount: number | null;
  readonly supportCount: number | null;
  /** Ranked candidates the capsule discarded, for any reason, and the reasons verbatim. */
  readonly discardedCount: number | null;
  readonly discardedByReason: Readonly<Record<string, number>> | null;
  /** Discards whose reason names the tier's item cap (`beyond <tier> support budget (max n)`). */
  readonly discardedForTierCap: number | null;
  /** Whether the paired authoritative response, where it carried the capsule, agreed with the direct build. */
  readonly directBuildConsistent: boolean | null;
  /** Neighbourhood excerpts that reached the projector, and the builder's cap. */
  readonly neighborhoodExcerpts: number | null;
  readonly neighborhoodPivots: number | null;
  readonly neighborhoodMaxPivots: number | null;
  readonly neighborhoodMaxExcerptsPerPivot: number | null;
}

export interface UtilizationGate { readonly id: string; readonly pass: boolean; readonly detail: string }

export interface ResponseUtilization {
  readonly budget: number;
  /** The ceiling the projector applied, in the packet's rule, and where it came from. */
  readonly effectiveCeilingTokens: number | null;
  readonly ceilingSource: string;
  /** The ceiling the product's rule says this budget entitles, in the packet's rule. */
  readonly expectedCeilingTokens: number;
  readonly supply: {
    readonly proposed: number | null;
    readonly deduplicated: number | null;
    readonly droppedNoClaim: number | null;
    /** Distinct, claim-bearing identities: admitted + rejected + not reached. */
    readonly eligible: number | null;
    readonly admitted: number | null;
    readonly rejectedForCeiling: number | null;
    readonly notReached: number | null;
    /** Packet-rule tokens of what was admitted (items only). */
    readonly admittedItemTokens: number | null;
    /** Packet-rule tokens of the candidate the ceiling rejected, if any. */
    readonly rejectedItemTokens: number | null;
    /** An ESTIMATE for the never-tested tail: not-reached count x the median admitted related cost. */
    readonly notReachedItemTokensEstimate: number | null;
    readonly remainingUsefulCandidateTokensEstimate: number | null;
  };
  readonly consumed: {
    readonly evidenceTokens: number | null;
    readonly evidenceCharacters: number | null;
    readonly packetTokens: number | null;
    readonly packetCharacters: number;
    readonly wrapperTokens: number | null;
    readonly accountingOverheadTokens: number | null;
    /** The frozen scorer's numerator. */
    readonly frozenWholeTokens: number;
    readonly items: number;
    readonly focusCodeCharacters: number;
    readonly relatedCount: number;
  };
  readonly unused: {
    /** Under the frozen rule: budget - ceil(chars/4). */
    readonly frozenBudgetTokens: number;
    /** Under the packet rule: ceiling - evidence packet. */
    readonly ceilingTokens: number | null;
  };
  readonly utilisationPercent: number;
  readonly upstream: {
    readonly requestedTokens: number | string;
    readonly modelVisibleTokens: number | string;
    readonly remainingTokens: number | string;
    readonly deliveryStatus: string;
    readonly selectedItemsBeforeBudget: number | string;
    readonly deliveredItems: number | string;
    readonly droppedForBudget: number | string;
    readonly compactionStages: readonly string[] | string;
    readonly supplyFacts: UpstreamSupply | null;
  };
  /** Characters of body the upstream rendered for related items that the packet's representation does not carry. */
  readonly representationWithheldCharacters: number | null;
  readonly headBoundWithheldCharacters: number;
  /** The first authority that stopped another eligible ranked ITEM being delivered. */
  readonly bindingReason: BindingReason;
  readonly bindingDetail: string;
  /** Secondary flags: what stopped more TOKENS, independent of item admission. */
  readonly tokenBinding: readonly BindingReason[];
  readonly supplyExhausted: boolean;
  readonly gates: readonly UtilizationGate[];
  readonly verdict: "UTILIZATION_INTEGRITY_PASS" | "UTILIZATION_INTEGRITY_FAIL";
}

export interface AnalyzeUtilizationInput {
  readonly budget: number;
  readonly packet: any;
  readonly ledger: any;
  /** The ceiling the product's rule entitles this budget to. */
  readonly expectedCeilingTokens: number;
  readonly headBoundCharacters: number;
  readonly frozenPhrases: readonly string[];
  readonly upstream?: UpstreamSupply | null;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const countOr = (v: unknown): number | null => (isCount(v) ? v : null);

/**
 * Hold one response to the utilisation questions. Every gate is a
 * re-measurement or a structural check; none reads a ledger value and trusts it.
 */
export function analyzeUtilization(input: AnalyzeUtilizationInput): ResponseUtilization {
  const packet = input.packet ?? {};
  const ledger = input.ledger;
  const related: any[] = Array.isArray(packet.related) ? packet.related : [];
  const delivered: any[] = [packet.focus, ...related];
  const packetCharacters = JSON.stringify(packet).length;
  const frozenWholeTokens = frozenWholeResponseTokens(packet);
  const utilisationPercent = frozenUtilisationPercent(packet, input.budget);
  const gates: UtilizationGate[] = [];
  const gate = (id: string, pass: boolean, detail: string) => { gates.push({ id, pass, detail }); };

  const items: any[] = Array.isArray(ledger?.items) ? ledger.items : [];
  const c = ledger?.candidates ?? {};
  const eb = ledger?.evidenceBudget ?? {};
  const effectiveCeilingTokens = isCount(ledger?.ceilingTokens) ? ledger.ceilingTokens : null;
  const ceilingSource: string = typeof ledger?.ceilingDerivation?.source === "string"
    ? ledger.ceilingDerivation.source : "fixed_policy";

  // Supply arithmetic, read from the ledger and re-derived where it can be.
  const admitted = countOr(c.admitted);
  const rejectedForCeiling = countOr(c.rejectedForCeiling);
  const notReached = countOr(c.notReached);
  const eligible = admitted === null || rejectedForCeiling === null || notReached === null
    ? null : admitted + rejectedForCeiling + notReached;
  const relatedRecords = items.filter((i) => i?.slot === "related");
  const admittedItemTokens = items.length === 0 ? null : items.reduce((n, i) => n + (isCount(i?.actualTokens) ? i.actualTokens : 0), 0);
  const rejectedRecord = Array.isArray(c.rejected) ? c.rejected[0] : undefined;
  const rejectedItemTokens = rejectedRecord && isCount(rejectedRecord.estimatedTokens) ? rejectedRecord.estimatedTokens : null;
  const medianRelatedTokens = relatedRecords.length === 0 ? null
    : median(relatedRecords.map((i) => (isCount(i?.actualTokens) ? i.actualTokens : 0)));
  const notReachedItemTokensEstimate = notReached === null ? null
    : notReached === 0 ? 0
      : medianRelatedTokens === null ? null : Math.round(notReached * medianRelatedTokens);
  const remainingUsefulCandidateTokensEstimate = rejectedItemTokens === null && notReachedItemTokensEstimate === null
    ? null : (rejectedItemTokens ?? 0) + (notReachedItemTokensEstimate ?? 0);

  // Consumption, re-measured.
  const evidenceCharacters = isCount(ledger?.evidence?.characters) ? ledger.evidence.characters : null;
  const evidenceTokens = isCount(ledger?.evidence?.tokens) ? ledger.evidence.tokens : null;
  const focusCode = typeof packet.focus?.code === "string" ? packet.focus.code : "";

  // The upstream facts, verbatim.
  const upstream = {
    requestedTokens: eb.requestedTokens ?? "unavailable",
    modelVisibleTokens: eb.modelVisibleTokens ?? "unavailable",
    remainingTokens: eb.remainingTokens ?? "unavailable",
    deliveryStatus: typeof eb.deliveryStatus === "string" ? eb.deliveryStatus : "unavailable",
    selectedItemsBeforeBudget: eb.selectedItemsBeforeBudget ?? "unavailable",
    deliveredItems: eb.deliveredItems ?? "unavailable",
    droppedForBudget: eb.droppedForBudget ?? "unavailable",
    compactionStages: Array.isArray(eb.compactionStages) ? eb.compactionStages : "unavailable",
    supplyFacts: input.upstream ?? null,
  };

  // Representation: what the upstream rendered for related items and the packet does not carry.
  const withheld = relatedRecords.map((i) => (isCount(i?.bodyCharacters) ? i.bodyCharacters : null));
  const representationWithheldCharacters = withheld.length === 0 ? 0
    : withheld.every((w) => w === null) ? null : withheld.reduce((n: number, w) => n + (w ?? 0), 0);
  const focusRecord = items[0];
  const headBoundWithheldCharacters = focusRecord?.truncated === true && isCount(focusRecord.bodyCharacters)
    ? Math.max(0, focusRecord.bodyCharacters - (focusRecord.deliveredCodeCharacters ?? 0)) : 0;

  // ---------------------------------------------------------- binding reason
  // Walk from the projector upward: the FIRST cap on the path that stopped an
  // eligible ranked item is the binding one. Nothing here is inferred from the
  // packet's size; every branch reads a recorded decision.
  let bindingReason: BindingReason;
  let bindingDetail: string;
  const supplyExhausted = rejectedForCeiling === 0 && notReached === 0;
  const stages: string[] = Array.isArray(eb.compactionStages) ? eb.compactionStages.map(String) : [];
  const facts = input.upstream ?? null;
  // The tier cap binds when the capsule discarded a ranked candidate BECAUSE of
  // the cap (its reason names the cap), or, where reasons are unavailable, when
  // a cap is full and candidates were discarded.
  const tierCapBinds = facts !== null && (
    (isCount(facts.discardedForTierCap) && facts.discardedForTierCap > 0)
    || (facts.discardedForTierCap === null
      && ((isCount(facts.pivotCount) && isCount(facts.maxPivots) && facts.pivotCount >= facts.maxPivots)
        || (isCount(facts.supportCount) && isCount(facts.maxSupport) && facts.supportCount >= facts.maxSupport))
      && isCount(facts.discardedCount) && facts.discardedCount > 0));
  if (rejectedForCeiling !== null && rejectedForCeiling > 0) {
    if (rejectedItemTokens !== null && effectiveCeilingTokens !== null && rejectedItemTokens > effectiveCeilingTokens) {
      bindingReason = "ITEM_TOO_LARGE";
      bindingDetail = `rejected candidate costs ${rejectedItemTokens} tokens against a ceiling of ${effectiveCeilingTokens}; it could never fit`;
    } else {
      bindingReason = "ORIENTATION_CEILING";
      bindingDetail = `ceiling ${effectiveCeilingTokens} rejected ${rejectedRecord?.at ?? "?"} at ${rejectedRecord?.admissionPacketTokens ?? "?"} packet tokens; ${notReached ?? "?"} never reached`;
    }
  } else if (isCount(eb.droppedForBudget) && eb.droppedForBudget > 0
    || stages.some((s) => /dropped/.test(s))) {
    bindingReason = "PROGRESSIVE_BUDGET_DROP";
    bindingDetail = `evidence budget dropped ${eb.droppedForBudget} items (${stages.join(", ")})`;
  } else if (upstream.deliveryStatus === "compacted" || upstream.deliveryStatus === "failed") {
    bindingReason = "UPSTREAM_BUDGET_EXHAUSTED";
    bindingDetail = `evidence budget ${eb.requestedTokens} bound the rendering (${stages.join(", ") || upstream.deliveryStatus}); nothing dropped`;
  } else if (tierCapBinds) {
    bindingReason = "OTHER";
    bindingDetail = `UPSTREAM_TIER_ITEM_CAP: tier ${facts!.tier} caps pivots at ${facts!.maxPivots} (delivered ${facts!.pivotCount}) and support at ${facts!.maxSupport} (delivered ${facts!.supportCount}); ${facts!.discardedForTierCap ?? "?"} of ${facts!.discardedCount} discards name the cap; ${eb.remainingTokens} evidence tokens unused`;
  } else if (supplyExhausted) {
    bindingReason = "NO_ELIGIBLE_EVIDENCE";
    bindingDetail = `every claim-bearing candidate was admitted (${admitted} of ${eligible}); upstream delivered ${eb.deliveredItems} of ${eb.selectedItemsBeforeBudget} selected`;
  } else {
    bindingReason = "OTHER";
    bindingDetail = "ledger absent or supply arithmetic unavailable";
  }
  const tokenBinding: BindingReason[] = [];
  if (representationWithheldCharacters !== null && representationWithheldCharacters > 0) tokenBinding.push("REPRESENTATION_CAP");
  if (headBoundWithheldCharacters > 0) tokenBinding.push("HEAD_BOUND");
  if (facts !== null && isCount(facts.neighborhoodExcerpts) && isCount(facts.neighborhoodPivots)
    && isCount(facts.neighborhoodMaxExcerptsPerPivot)
    && facts.neighborhoodPivots > 0
    && facts.neighborhoodExcerpts >= facts.neighborhoodPivots * facts.neighborhoodMaxExcerptsPerPivot) {
    tokenBinding.push("OTHER");
  }

  // ------------------------------------------------------------------ gates
  gate("ledger_present", ledger !== undefined && ledger !== null, ledger ? "ledger published" : "no ledger");
  const ids = delivered.map((d) => String(d?.at ?? ""));
  gate("no_duplicate_admission", new Set(ids).size === ids.length && ids.every((id) => id.length > 0),
    `${ids.length - new Set(ids).size} identities delivered twice`);
  // No filler: every related entry traces to a recorded route with a claim the
  // authoritative state made (a selection reason / role) or a frozen phrase.
  const frozen = new Set(input.frozenPhrases);
  const fillerViolations = related.filter((r, k) => {
    const record = items[k + 1];
    if (!record) return true;
    if (typeof r?.how !== "string" || r.how.trim().length === 0) return true;
    if (record.origin === "pivot_neighborhood") return !frozen.has(r.how) || record.reasonSource !== "neighbor_relation";
    if (record.origin === "item_supply") return typeof record.sourceId !== "string" || record.sourceId.length === 0
      || record.sourceId === "unavailable" || !(record.reasonSource === "selection_reason" || record.reasonSource === "roles");
    return true;
  }).length;
  gate("no_filler", fillerViolations === 0, `${fillerViolations} related entries without a traceable authoritative claim`);
  gate("no_synthetic_text", delivered.every((d) => typeof d?.at === "string" && !/^(?:synthetic|padding|filler)/i.test(d.at))
    && (packet.notes ?? []).every((n: unknown) => typeof n === "string" && (frozen.has(n)
      || /^Index freshness: /.test(n) || /^Workspace routing: /.test(n))),
    "notes are frozen phrases or verbatim authoritative status; no invented items");
  gate("ceiling_is_the_rule", effectiveCeilingTokens === input.expectedCeilingTokens,
    `ledger ceiling ${effectiveCeilingTokens} vs the rule's ${input.expectedCeilingTokens} for budget ${input.budget}`);
  gate("no_cap_violation", evidenceTokens !== null && effectiveCeilingTokens !== null
    && (evidenceTokens <= effectiveCeilingTokens || related.length === 0),
    `evidence ${evidenceTokens} vs ceiling ${effectiveCeilingTokens}${related.length === 0 ? " (focus only; never evicted)" : ""}`);
  gate("head_bound_respected", focusCode.length <= input.headBoundCharacters,
    `focus code ${focusCode.length} chars within ${input.headBoundCharacters}`);
  gate("candidate_arithmetic", [c.proposed, c.admitted, c.deduplicated, c.droppedNoClaim, c.rejectedForCeiling, c.notReached].every(isCount)
    && c.proposed === c.admitted + c.deduplicated + c.droppedNoClaim + c.rejectedForCeiling + c.notReached
    && c.admitted === delivered.length
    && (c.rejectedForCeiling === 0 ? c.notReached === 0 : c.rejectedForCeiling === 1),
    `proposed ${c.proposed} = admitted ${c.admitted} + deduplicated ${c.deduplicated} + no-claim ${c.droppedNoClaim} + rejected ${c.rejectedForCeiling} + not reached ${c.notReached}`);
  gate("accounting_coverage", frozenA14ItemsAccounted(packet) === frozenA14ItemsDelivered(packet),
    `${frozenA14ItemsAccounted(packet)} of ${frozenA14ItemsDelivered(packet)} delivered items accounted (frozen A14 predicate)`);
  const accounting = ledger ? analyzeAccounting({ packet, ledger, ceilingTokens: input.expectedCeilingTokens }) : null;
  gate("cost_reconciliation", accounting?.verdict === "ACCOUNTING_INTEGRITY_PASS",
    accounting === null ? "no ledger" : accounting.gates.filter((g) => !g.pass).map((g) => g.id).join(",") || "M203 analyzer passes");
  gate("frozen_numerator_is_the_packet", frozenWholeTokens === Math.ceil(packetCharacters / 4),
    `ceil(${packetCharacters}/4) = ${frozenWholeTokens}`);
  gate("packet_tokens_measured", ledger?.packet?.tokens === packetTokensOf(packetCharacters),
    `ledger packet ${ledger?.packet?.tokens} vs measured ${packetTokensOf(packetCharacters)}`);

  const pass = gates.every((g) => g.pass);
  return {
    budget: input.budget,
    effectiveCeilingTokens, ceilingSource, expectedCeilingTokens: input.expectedCeilingTokens,
    supply: {
      proposed: countOr(c.proposed), deduplicated: countOr(c.deduplicated), droppedNoClaim: countOr(c.droppedNoClaim),
      eligible, admitted, rejectedForCeiling, notReached,
      admittedItemTokens, rejectedItemTokens, notReachedItemTokensEstimate, remainingUsefulCandidateTokensEstimate,
    },
    consumed: {
      evidenceTokens, evidenceCharacters,
      packetTokens: isCount(ledger?.packet?.tokens) ? ledger.packet.tokens : null,
      packetCharacters,
      wrapperTokens: isCount(ledger?.wrapper?.tokens) ? ledger.wrapper.tokens : null,
      accountingOverheadTokens: isCount(ledger?.accountingOverhead?.tokens) ? ledger.accountingOverhead.tokens : null,
      frozenWholeTokens, items: delivered.length, focusCodeCharacters: focusCode.length, relatedCount: related.length,
    },
    unused: {
      frozenBudgetTokens: input.budget - frozenWholeTokens,
      ceilingTokens: evidenceTokens === null || effectiveCeilingTokens === null ? null : effectiveCeilingTokens - evidenceTokens,
    },
    utilisationPercent,
    upstream,
    representationWithheldCharacters,
    headBoundWithheldCharacters,
    bindingReason, bindingDetail, tokenBinding, supplyExhausted,
    gates,
    verdict: pass ? "UTILIZATION_INTEGRITY_PASS" : "UTILIZATION_INTEGRITY_FAIL",
  };
}

// ------------------------------------------------- cross-budget relations

/** `items(B1)` as a prefix, a subsequence, or neither, of `items(B2)`. */
export function orderRelation(smaller: readonly string[], larger: readonly string[]): "prefix" | "subsequence" | "neither" {
  if (smaller.every((id, k) => larger[k] === id)) return "prefix";
  let cursor = 0;
  for (const id of smaller) {
    const at = larger.indexOf(id, cursor);
    if (at < 0) return "neither";
    cursor = at + 1;
  }
  return "subsequence";
}

/** Effective budgets must not shrink as the caller's budget grows (§21). */
export function effectiveBudgetMonotonic(points: readonly { budget: number; effective: number | null }[]): {
  readonly monotonic: boolean; readonly violations: string[];
} {
  const sorted = [...points].sort((a, b) => a.budget - b.budget);
  const violations: string[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!; const next = sorted[i]!;
    if (prev.effective === null || next.effective === null) continue;
    if (next.effective < prev.effective) violations.push(`${prev.budget}->${next.budget}: ${prev.effective} -> ${next.effective}`);
  }
  return { monotonic: violations.length === 0, violations };
}
