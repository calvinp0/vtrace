/**
 * M206 — candidate-allocation audit, the counterfactual uncapped-supply
 * evaluator, the supply-sufficiency rule and the stop-reason vocabulary.
 *
 * PURE over its inputs. Nothing here touches the product, a database, a clock
 * or the filesystem; the driver binds every fact (the capsule's ranked stream
 * and its discards, the delivered packet and its ledger, the bodies the index
 * holds for the candidates the caps discarded) and this module only arranges
 * and re-measures them.
 *
 * THE QUESTION. The frozen A11 scorer (m204Utilization.ts, verbatim) reads
 * ceil(chars/4) of the whole default packet against the caller's budget. M204
 * made the projector's ceiling the caller's; M205 let related entries carry
 * the body the rendering already paid for. What remained BELOW is the count
 * of candidates that reach the projector, and the suspect is the capsule's
 * per-tier item cap. Before that cap is touched, this module answers, for
 * every frozen response, what the SAME ranked stream would have delivered had
 * the count cap not stopped it: same scores, same order, same eligibility,
 * same deduplication, same representation router, same ceiling arithmetic —
 * only the count truncation removed, in simulation.
 *
 * TWO STOPS ARE PRESERVED. A candidate the count cap discarded still has to
 * (1) fit the projector's ceiling on the relationship-only packet, exactly as
 * the projector tests it (a prefix; the first miss ends admission), and
 * (2) fit the upstream evidence budget that bounds `modelVisibleContext`.
 * The second is reported as a separate bound: the real compaction ladder
 * shortens before it drops, so the truth lies between the ceiling-only figure
 * and the figure that also honours the upstream budget. Both are published;
 * the sufficiency rule is decided on the conservative one and refuses to call
 * a budget sufficient on the optimistic one alone.
 *
 * THE SUFFICIENCY RULE IS THE FROZEN RULE. required_match_tokens(B) is the
 * smallest whole-packet chars/4 count at which 100 x tokens / B >= 60, i.e.
 * ceil(0.6 x B). Nothing else is a second threshold.
 */

import {
  A11_BUDGETS, A11_EXCEED_PERCENT, A11_MATCH_PERCENT, frozenWholeResponseTokens, median,
} from "./m204Utilization";

// -------------------------------------------------------------- discards

/** Why the capsule discarded a ranked candidate, classified from its verbatim reason. */
export type DiscardClass =
  | "TIER_SUPPORT_CAP"
  | "TOKEN_BUDGET"
  | "REDUNDANT_DELIVERY"
  | "LANE_TOKEN_CEILING"
  | "ROLE_GATE"
  | "NO_PIVOT_SUPPORT_ONLY"
  | "OTHER";

export const TIER_SUPPORT_CAP_REASON = /^beyond (\w+) support budget \(max (\d+)\)$/;

export function classifyDiscardReason(reason: string, roleReason: string | undefined): DiscardClass {
  if (TIER_SUPPORT_CAP_REASON.test(reason)) return "TIER_SUPPORT_CAP";
  if (/^over budget: no room for this (support item|pivot)$/.test(reason)) return "TOKEN_BUDGET";
  if (/^redundant support: /.test(reason)) return "REDUNDANT_DELIVERY";
  if (/^(co-edit|file-evidence) token ceiling: /.test(reason)) return "LANE_TOKEN_CEILING";
  if (/^support-only: no actionable edit target$/.test(reason)) return "NO_PIVOT_SUPPORT_ONLY";
  // A role-layer discard carries its role reason AS the discard reason (the
  // capsule omits `role_reason` when the two are equal).
  if (roleReason === undefined) return "ROLE_GATE";
  return "OTHER";
}

/** A discard that lost ONLY to a count, and would otherwise have been packed in rank order. */
export const isCountCapDiscard = (cls: DiscardClass): boolean => cls === "TIER_SUPPORT_CAP";

/** The capsule marks a pivot demoted by the pivot cap in its role reason (two spellings, one meaning). */
export const PIVOT_CAP_DEMOTION = /beyond the pivot budget/;

// -------------------------------------------------------- stage audit

export interface StageRow {
  readonly stage: string;
  readonly authority: string;
  readonly input: number | null;
  readonly output: number | null;
  readonly lost: number;
  readonly lostByReason: Readonly<Record<string, number>>;
  /** Lost candidates that remained eligible on every other rule (count-bound only). */
  readonly otherwiseEligibleLost: number;
}

export interface CapsuleFacts {
  readonly candidateCount: number | null;
  readonly poolCap: number | null;
  readonly tier: string | null;
  readonly maxPivots: number | null;
  readonly maxSupport: number | null;
  readonly pivots: readonly { readonly roleReason: string }[];
  readonly support: readonly { readonly roleReason: string; readonly inPool: boolean }[];
  readonly discarded: readonly { readonly reason: string; readonly roleReason: string | undefined; readonly inPool: boolean }[];
}

export interface AssemblyFacts {
  readonly itemsByRole: Readonly<Record<string, number>>;
  readonly items: number;
  readonly duplicateItemsRemoved: number | null;
}

export interface DeliveryFacts {
  readonly selectedItemsBeforeBudget: number | null;
  readonly deliveredItems: number | null;
  readonly droppedForBudget: number | null;
  readonly compactionStages: readonly string[];
}

export interface ProjectorFacts {
  readonly neighbourhoodExcerpts: number | null;
  readonly proposed: number | null;
  readonly deduplicated: number | null;
  readonly droppedNoClaim: number | null;
  readonly admitted: number | null;
  readonly rejectedForCeiling: number | null;
  readonly notReached: number | null;
}

/**
 * Every truncation stage on the path, with what went in, what came out and
 * why the difference was lost. Counts only; no candidate is re-ranked.
 */
export function auditAllocationStages(input: {
  readonly capsule: CapsuleFacts;
  readonly assembly: AssemblyFacts | null;
  readonly delivery: DeliveryFacts | null;
  readonly projector: ProjectorFacts | null;
}): StageRow[] {
  const c = input.capsule;
  const rows: StageRow[] = [];
  const classes = c.discarded.map((d) => classifyDiscardReason(d.reason, d.roleReason));
  const count = (pred: (cls: DiscardClass, k: number) => boolean): Record<string, number> => {
    const out: Record<string, number> = {};
    classes.forEach((cls, k) => { if (pred(cls, k)) out[cls] = (out[cls] ?? 0) + 1; });
    return out;
  };
  const roleLost = count((cls) => cls === "ROLE_GATE" || cls === "NO_PIVOT_SUPPORT_ONLY");
  const roleLostTotal = Object.values(roleLost).reduce((n, v) => n + v, 0);
  const demotedInSupport = c.support.filter((s) => PIVOT_CAP_DEMOTION.test(s.roleReason)).length;
  const demotedInDiscards = c.discarded.filter((d) => d.roleReason !== undefined && PIVOT_CAP_DEMOTION.test(d.roleReason)).length;
  const pivotRoleCount = c.pivots.length + demotedInSupport + demotedInDiscards;
  const laneSupport = c.support.filter((s) => !s.inPool).length;
  const laneDiscards = c.discarded.filter((d) => !d.inPool).length;
  const supportOrdered = c.support.length + c.discarded.length - roleLostTotal;
  const supportLost = count((cls) => cls !== "ROLE_GATE" && cls !== "NO_PIVOT_SUPPORT_ONLY");

  rows.push({
    stage: "retrieval_pool", authority: "hybridRetrieve(maxResults = CANDIDATE_POOL_SIZE) in buildCapsuleV2.ts",
    input: null, output: c.candidateCount, lost: 0, lostByReason: {},
    otherwiseEligibleLost: 0,
  });
  rows.push({
    stage: "role_gate", authority: "assignCandidateRoles / refineDebugRoles (pivot, support, discard)",
    input: c.candidateCount, output: c.candidateCount === null ? null : c.candidateCount - roleLostTotal,
    lost: roleLostTotal, lostByReason: roleLost, otherwiseEligibleLost: 0,
  });
  rows.push({
    stage: "pivot_cap", authority: `allocateBudget(${c.tier ?? "?"}).maxPivots = ${c.maxPivots ?? "?"}; capPivots / assignCandidateRoles demote to support`,
    input: pivotRoleCount, output: c.pivots.length, lost: demotedInSupport + demotedInDiscards,
    lostByReason: demotedInSupport + demotedInDiscards === 0 ? {} : { PIVOT_CAP_DEMOTED_TO_SUPPORT: demotedInSupport + demotedInDiscards },
    otherwiseEligibleLost: 0,
  });
  rows.push({
    stage: "support_lanes", authority: "co-edit, file-evidence, graph-neighbour, path-completion, mechanism, document lanes (entries outside the pool)",
    input: supportOrdered - laneSupport - laneDiscards, output: supportOrdered, lost: 0, lostByReason: {},
    otherwiseEligibleLost: 0,
  });
  rows.push({
    stage: "support_packing", authority: `allocateBudget(${c.tier ?? "?"}).maxSupport = ${c.maxSupport ?? "?"} (count) + renderSupport(remaining tokens) + M158 dedupe + lane ceilings`,
    input: supportOrdered, output: c.support.length,
    lost: Object.values(supportLost).reduce((n, v) => n + v, 0), lostByReason: supportLost,
    otherwiseEligibleLost: supportLost.TIER_SUPPORT_CAP ?? 0,
  });
  if (input.assembly !== null) {
    rows.push({
      stage: "product_assembly", authority: "assembleProductContext: pivots + support + actionability + impact + memory/rules, deduplicateDrafts",
      input: c.pivots.length + c.support.length, output: input.assembly.items,
      lost: input.assembly.duplicateItemsRemoved ?? 0,
      lostByReason: input.assembly.duplicateItemsRemoved ? { DUPLICATE_DRAFT: input.assembly.duplicateItemsRemoved } : {},
      otherwiseEligibleLost: 0,
    });
  }
  if (input.delivery !== null) {
    rows.push({
      stage: "evidence_budget", authority: "applyProgressiveContextBudget (modelVisibleContext <= max_tokens chars/4)",
      input: input.delivery.selectedItemsBeforeBudget, output: input.delivery.deliveredItems,
      lost: input.delivery.droppedForBudget ?? 0,
      lostByReason: (input.delivery.droppedForBudget ?? 0) > 0 ? { DROPPED_FOR_EVIDENCE_BUDGET: input.delivery.droppedForBudget! } : {},
      otherwiseEligibleLost: 0,
    });
  }
  if (input.projector !== null) {
    const p = input.projector;
    rows.push({
      stage: "projector_admission", authority: "projectRunPipelineOrientation: dedupe by identity, claim required, prefix under orientationCeilingTokens(budget)",
      input: p.proposed, output: p.admitted,
      lost: (p.deduplicated ?? 0) + (p.droppedNoClaim ?? 0) + (p.rejectedForCeiling ?? 0) + (p.notReached ?? 0),
      lostByReason: {
        ...((p.deduplicated ?? 0) > 0 ? { DEDUPLICATED: p.deduplicated! } : {}),
        ...((p.droppedNoClaim ?? 0) > 0 ? { NO_CLAIM: p.droppedNoClaim! } : {}),
        ...((p.rejectedForCeiling ?? 0) > 0 ? { CEILING: p.rejectedForCeiling! } : {}),
        ...((p.notReached ?? 0) > 0 ? { NOT_REACHED: p.notReached! } : {}),
      },
      otherwiseEligibleLost: (p.rejectedForCeiling ?? 0) + (p.notReached ?? 0),
    });
  }
  return rows;
}

// --------------------------------------------------- counterfactual stream

/** One candidate the count cap discarded, with the body the index holds for it. */
export interface UncappedCandidate {
  readonly at: string;
  readonly file: string;
  readonly lines: string | null;
  /** The verbatim role reason: the claim the packet would make about it. */
  readonly how: string;
  /** Upstream content mode the product would render it in (sourceDraft rule), and that body. */
  readonly form: string;
  readonly body: string;
  /** chars/4 of the text the capsule would count for it (signature, or the symbol name). */
  readonly capsuleEstimatedTokens: number;
  /** Discard ordinal in the capsule's own order (rank among the count-cap discards). */
  readonly discardRank: number;
  /** The pool rank the candidate earned, when it came from the pool. */
  readonly poolRank: number | null;
  readonly finalScore: number | null;
  readonly role: "support" | "demoted_pivot";
  readonly identityResolved: boolean;
}

export interface CandidateRow {
  readonly ordinal: number;
  readonly origin: "delivered" | "uncapped";
  readonly role: string;
  readonly at: string;
  readonly representation: string;
  readonly form: string | null;
  readonly codeCharacters: number;
  readonly estimatedTokens: number;
  readonly cumulativePacketTokens: number;
  readonly fitsCeiling: boolean;
  readonly capsuleBudgetFits: boolean | null;
  readonly upstreamFits: boolean | null;
  readonly reason: string;
  readonly poolRank: number | null;
  readonly finalScore: number | null;
  readonly discardRank: number | null;
}

export type StopReason =
  | "NO_TRUTHFUL_SUPPLY"
  | "NEXT_ITEM_TOO_LARGE"
  | "HARD_SAFETY_BOUND"
  | "OTHER_EXPLICIT_POLICY";

export interface SimulationResult {
  readonly rows: readonly CandidateRow[];
  /** The counterfactual packet, accounted, as the frozen scorer would read it. */
  readonly packet: unknown;
  readonly frozenTokens: number;
  readonly evidencePacketTokens: number;
  /** The frozen count when only candidates that also pass the upstream and capsule budgets are admitted. */
  readonly frozenTokensAllBounds: number;
  readonly admittedExtra: number;
  readonly admittedExtraAllBounds: number;
  readonly rejectedExtraForCeiling: number;
  readonly notReachedExtra: number;
  readonly unresolvedExtra: number;
  /** Count-cap discards whose identity the packet already delivered through another route. */
  readonly deduplicatedExtra: number;
  readonly stopReason: StopReason;
  readonly stopDetail: string;
}

export interface Serializer {
  /** Packet tokens of an assembled evidence packet: the projector's rule, verbatim. */
  readonly packetTokens: (packet: object) => number;
  readonly assemble: (focus: object, related: readonly object[], notes: readonly string[]) => object;
  readonly withItemTokens: <T extends object>(item: T) => T & { readonly tokens: number };
  readonly availableRepresentation: (input: { origin: "item_supply"; form: string; body: string; bound: number }) =>
    { readonly available: true; readonly candidate: { readonly form: string; readonly code: string; readonly truncated: boolean } }
    | { readonly available: false; readonly reason: string };
}

/**
 * Replay the projector's admission and routing over the delivered prefix plus
 * the count-cap discards, in the capsule's order. The delivered entries are
 * kept exactly as delivered (they were routed first in the real run, and the
 * projector's routing is a function of the packet as it stood at their turn);
 * each extra is admitted relationship-only under the ceiling, then offered its
 * upstream form under the same ceiling. Nothing is re-ranked.
 */
export function simulateUncappedAdmission(input: {
  readonly focus: Record<string, unknown>;
  readonly notes: readonly string[];
  readonly delivered: readonly Record<string, unknown>[];
  readonly extras: readonly UncappedCandidate[];
  readonly ceilingTokens: number;
  readonly relatedBound: number;
  readonly upstream: { readonly budgetTokens: number; readonly renderedCharacters: number } | null;
  readonly capsule: { readonly maxTokens: number; readonly usedTokens: number } | null;
  readonly serializer: Serializer;
  /** The count the capsule saw in the pool, and its cap, for the stop reason. */
  readonly pool: { readonly candidateCount: number | null; readonly cap: number | null };
}): SimulationResult {
  const s = input.serializer;
  const stripTokens = (entry: Record<string, unknown>): Record<string, unknown> => {
    const { tokens: _t, ...rest } = entry;
    return rest;
  };
  const focus = stripTokens(input.focus);
  const related: Record<string, unknown>[] = input.delivered.map(stripTokens);
  const rows: CandidateRow[] = [];
  let cumulative = s.packetTokens(s.assemble(focus, related, input.notes));
  for (const [k, entry] of related.entries()) {
    const code = typeof entry.code === "string" ? entry.code : "";
    rows.push({
      ordinal: k + 1, origin: "delivered", role: "related", at: String(entry.at),
      representation: typeof entry.code === "string" ? String(entry.form ?? "unlabelled") : "relationship_only",
      form: typeof entry.form === "string" ? entry.form : null, codeCharacters: code.length,
      estimatedTokens: s.packetTokens(entry), cumulativePacketTokens: cumulative, fitsCeiling: true,
      capsuleBudgetFits: null, upstreamFits: null, reason: String(entry.how ?? ""), poolRank: null, finalScore: null, discardRank: null,
    });
  }

  // Admission: relationship-only prefix, first miss ends it (the projector's loop).
  const admitted: { entry: Record<string, unknown>; candidate: UncappedCandidate; index: number }[] = [];
  let rejected = 0; let notReached = 0; let unresolved = 0; let deduplicated = 0;
  let stopDetail = "";
  let nextTooLarge: UncappedCandidate | null = null;
  const candidates = input.extras.filter((c) => c.identityResolved);
  unresolved = input.extras.length - candidates.length;
  // The projector's own deduplication: one identity is delivered once, the
  // first proposal wins. A count-cap discard whose identity the packet already
  // carries (through the impact or neighbourhood lanes) is recorded, not
  // admitted a second time.
  const seen = new Set<string>([String(focus.at ?? ""), ...related.map((e) => String(e.at ?? ""))]);
  for (const [k, candidate] of candidates.entries()) {
    if (seen.has(candidate.at)) { deduplicated += 1; continue; }
    seen.add(candidate.at);
    if (rejected > 0) { notReached += 1; continue; }
    const entry: Record<string, unknown> = { at: candidate.at, file: candidate.file, lines: candidate.lines, how: candidate.how };
    const trial = [...related, entry];
    const packetTokens = s.packetTokens(s.assemble(focus, trial, input.notes));
    if (packetTokens > input.ceilingTokens) {
      rejected += 1; nextTooLarge = candidate;
      rows.push({
        ordinal: related.length + 1, origin: "uncapped", role: candidate.role, at: candidate.at,
        representation: "REJECTED_FOR_CEILING", form: null, codeCharacters: 0,
        estimatedTokens: s.packetTokens(entry), cumulativePacketTokens: packetTokens, fitsCeiling: false,
        capsuleBudgetFits: null, upstreamFits: null, reason: candidate.how, poolRank: candidate.poolRank,
        finalScore: candidate.finalScore, discardRank: candidate.discardRank,
      });
      continue;
    }
    related.push(entry);
    admitted.push({ entry, candidate, index: related.length - 1 });
    void k;
  }

  // Routing: each admitted extra offered its upstream form, in order, within the ceiling.
  let capsuleUsed = input.capsule?.usedTokens ?? 0;
  let upstreamChars = input.upstream?.renderedCharacters ?? 0;
  let admittedAllBounds = 0;
  const allBoundsRelated: Record<string, unknown>[] = input.delivered.map(stripTokens);
  for (const a of admitted) {
    const availability = s.availableRepresentation({ origin: "item_supply", form: a.candidate.form, body: a.candidate.body, bound: input.relatedBound });
    let final = a.entry; let representation = "relationship_only"; let codeChars = 0; let reason = "form_not_code_bearing";
    if (availability.available) {
      const rich = { ...a.entry, form: availability.candidate.form, code: availability.candidate.code, codeTruncated: availability.candidate.truncated };
      const trial = related.map((e, i) => (i === a.index ? rich : e));
      const trialTokens = s.packetTokens(s.assemble(focus, trial, input.notes));
      if (trialTokens <= input.ceilingTokens) {
        related[a.index] = rich; final = rich; representation = availability.candidate.form; codeChars = availability.candidate.code.length;
        reason = "upstream_form_delivered";
      } else {
        reason = "ceiling";
      }
    } else {
      reason = "reason" in availability ? String(availability.reason) : "form_not_code_bearing";
    }
    // The upstream evidence budget and the capsule's own token budget, as the
    // product would apply them to this candidate had the count cap not
    // discarded it. Header + body is what the rendering costs; the capsule
    // counts the signature it renders. Neither re-ranks anything.
    const headerChars = 12 + a.candidate.at.length + 40 + a.candidate.form.length + (a.candidate.lines?.length ?? 0) + 8 + a.candidate.how.length + 2;
    const renderedChars = headerChars + a.candidate.body.length;
    const upstreamFits = input.upstream === null ? null
      : Math.ceil((upstreamChars + renderedChars) / 4) <= input.upstream.budgetTokens;
    const capsuleFits = input.capsule === null ? null
      : capsuleUsed + a.candidate.capsuleEstimatedTokens <= input.capsule.maxTokens;
    if (upstreamFits !== false && capsuleFits !== false) {
      upstreamChars += renderedChars; capsuleUsed += a.candidate.capsuleEstimatedTokens;
      admittedAllBounds += 1; allBoundsRelated.push(final);
    }
    cumulative = s.packetTokens(s.assemble(focus, related.slice(0, a.index + 1), input.notes));
    rows.push({
      ordinal: a.index + 1, origin: "uncapped", role: a.candidate.role, at: a.candidate.at,
      representation, form: representation === "relationship_only" ? null : representation, codeCharacters: codeChars,
      estimatedTokens: s.packetTokens(final), cumulativePacketTokens: cumulative, fitsCeiling: true,
      capsuleBudgetFits: capsuleFits, upstreamFits, reason,
      poolRank: a.candidate.poolRank, finalScore: a.candidate.finalScore, discardRank: a.candidate.discardRank,
    });
  }

  const evidencePacket = s.assemble(focus, related, input.notes);
  const packet = s.assemble(s.withItemTokens(focus), related.map((e) => s.withItemTokens(e)), input.notes);
  const packetAllBounds = s.assemble(s.withItemTokens(focus), allBoundsRelated.map((e) => s.withItemTokens(e)), input.notes);

  // Why admission stopped, walking from the packet outward.
  let stopReason: StopReason;
  if (rejected > 0) {
    stopReason = "NEXT_ITEM_TOO_LARGE";
    stopDetail = `the caller's ceiling ${input.ceilingTokens} refused ${nextTooLarge?.at ?? "?"}; ${notReached} ranked candidates behind it never reached`;
  } else if (admitted.length > 0 && admittedAllBounds < admitted.length) {
    stopReason = "OTHER_EXPLICIT_POLICY";
    stopDetail = `every count-cap discard fits the ceiling; ${admitted.length - admittedAllBounds} of ${admitted.length} would be bound upstream by the evidence budget or the capsule token budget`;
  } else if (input.pool.candidateCount !== null && input.pool.cap !== null && input.pool.candidateCount >= input.pool.cap) {
    stopReason = "OTHER_EXPLICIT_POLICY";
    stopDetail = `every count-cap discard admitted; the ranked stream ends at the retrieval pool cap (${input.pool.candidateCount} of ${input.pool.cap})`;
  } else {
    stopReason = "NO_TRUTHFUL_SUPPLY";
    stopDetail = `every count-cap discard admitted; the ranked stream ends below the pool cap (${input.pool.candidateCount ?? "?"} of ${input.pool.cap ?? "?"})`;
  }
  return {
    rows, packet,
    frozenTokens: frozenWholeResponseTokens(packet),
    evidencePacketTokens: s.packetTokens(evidencePacket),
    frozenTokensAllBounds: frozenWholeResponseTokens(packetAllBounds),
    admittedExtra: admitted.length, admittedExtraAllBounds: admittedAllBounds,
    rejectedExtraForCeiling: rejected, notReachedExtra: notReached, unresolvedExtra: unresolved, deduplicatedExtra: deduplicated,
    stopReason, stopDetail,
  };
}

// ------------------------------------------------- the actual response's stop

/**
 * What stopped the NEXT eligible ranked item from reaching the delivered
 * packet, for the response as it stands. The first stage on the path from the
 * packet upward that removed an otherwise-eligible candidate is binding.
 */
export function actualStopReason(input: {
  readonly projectorRejectedForCeiling: number | null;
  readonly tierCapDiscards: number;
  readonly evidenceBudgetDropped: number | null;
  readonly evidenceBudgetCompacted: boolean;
  readonly tokenBudgetDiscards: number;
  readonly laneCeilingDiscards: number;
  readonly candidateCount: number | null;
  readonly poolCap: number | null;
}): { readonly reason: StopReason; readonly policy: string | null; readonly detail: string } {
  if ((input.projectorRejectedForCeiling ?? 0) > 0) {
    return { reason: "NEXT_ITEM_TOO_LARGE", policy: null, detail: "the projector's ceiling (the caller's budget) refused the next ranked item" };
  }
  if ((input.evidenceBudgetDropped ?? 0) > 0) {
    return { reason: "OTHER_EXPLICIT_POLICY", policy: "UPSTREAM_EVIDENCE_BUDGET", detail: `the evidence budget dropped ${input.evidenceBudgetDropped} selected items` };
  }
  if (input.tierCapDiscards > 0) {
    return { reason: "OTHER_EXPLICIT_POLICY", policy: "FIXED_TIER_SUPPORT_CAP", detail: `${input.tierCapDiscards} ranked support candidates discarded for the tier's item count` };
  }
  if (input.evidenceBudgetCompacted) {
    return { reason: "OTHER_EXPLICIT_POLICY", policy: "UPSTREAM_EVIDENCE_BUDGET", detail: "the evidence budget compacted the rendering; nothing dropped" };
  }
  if (input.tokenBudgetDiscards > 0) {
    return { reason: "NEXT_ITEM_TOO_LARGE", policy: "CAPSULE_TOKEN_BUDGET", detail: `${input.tokenBudgetDiscards} candidates did not fit the capsule's remaining token budget` };
  }
  if (input.laneCeilingDiscards > 0) {
    return { reason: "OTHER_EXPLICIT_POLICY", policy: "LANE_TOKEN_CEILING", detail: `${input.laneCeilingDiscards} lane candidates over their lane's token fraction` };
  }
  if (input.candidateCount !== null && input.poolCap !== null && input.candidateCount >= input.poolCap) {
    return { reason: "OTHER_EXPLICIT_POLICY", policy: "CANDIDATE_POOL_CAP", detail: `the ranked stream ends at the retrieval pool cap (${input.candidateCount} of ${input.poolCap})` };
  }
  return { reason: "NO_TRUTHFUL_SUPPLY", policy: null, detail: `every eligible ranked candidate delivered (pool ${input.candidateCount ?? "?"} of ${input.poolCap ?? "?"})` };
}

// ------------------------------------------------------- sufficiency

/** The frozen MATCH line in whole-packet chars/4 tokens: the least count at which 100 x t / B >= 60. */
export const requiredMatchTokens = (budget: number): number => Math.ceil((A11_MATCH_PERCENT / 100) * budget);
export const requiredExceedTokens = (budget: number): number => Math.ceil((A11_EXCEED_PERCENT / 100) * budget);

export type BudgetSufficiency = "SUFFICIENT" | "INSUFFICIENT" | "INDETERMINATE";

export interface SufficiencyRow {
  readonly budget: number;
  readonly frozen: boolean;
  readonly responses: number;
  readonly requiredMatchTokens: number;
  readonly requiredExceedTokens: number;
  readonly medianRankedPreCap: number | null;
  readonly medianPostCap: number | null;
  readonly medianCurrentFrozenTokens: number | null;
  readonly medianUncappedFrozenTokens: number | null;
  readonly medianUncappedFrozenTokensAllBounds: number | null;
  readonly currentUtilisationMedian: number | null;
  readonly theoreticalUtilisationMedian: number | null;
  readonly theoreticalUtilisationAllBoundsMedian: number | null;
  readonly distribution: { readonly min: number; readonly p10: number; readonly median: number; readonly p90: number; readonly max: number } | null;
  readonly sufficiency: BudgetSufficiency;
}

const pct = (values: readonly number[], p: number): number => {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
};

export function distributionOf(values: readonly number[]) {
  if (values.length === 0) return null;
  return { min: pct(values, 0.0000001), p10: pct(values, 0.1), median: median(values), p90: pct(values, 0.9), max: pct(values, 1) };
}

export function sufficiencyRow(input: {
  readonly budget: number;
  readonly rankedPreCap: readonly number[];
  readonly postCap: readonly number[];
  readonly currentFrozenTokens: readonly number[];
  readonly uncappedFrozenTokens: readonly number[];
  readonly uncappedFrozenTokensAllBounds: readonly number[];
}): SufficiencyRow {
  const b = input.budget;
  const med = (v: readonly number[]) => (v.length === 0 ? null : +median(v).toFixed(2));
  const required = requiredMatchTokens(b);
  const optimistic = med(input.uncappedFrozenTokens);
  const conservative = med(input.uncappedFrozenTokensAllBounds);
  const sufficiency: BudgetSufficiency = conservative === null || optimistic === null ? "INDETERMINATE"
    : conservative >= required ? "SUFFICIENT"
      : optimistic < required ? "INSUFFICIENT" : "INDETERMINATE";
  const util = (v: number) => +(100 * v / b).toFixed(2);
  return {
    budget: b, frozen: (A11_BUDGETS as readonly number[]).includes(b), responses: input.currentFrozenTokens.length,
    requiredMatchTokens: required, requiredExceedTokens: requiredExceedTokens(b),
    medianRankedPreCap: med(input.rankedPreCap), medianPostCap: med(input.postCap),
    medianCurrentFrozenTokens: med(input.currentFrozenTokens),
    medianUncappedFrozenTokens: optimistic, medianUncappedFrozenTokensAllBounds: conservative,
    currentUtilisationMedian: input.currentFrozenTokens.length === 0 ? null : +median(input.currentFrozenTokens.map(util)).toFixed(2),
    theoreticalUtilisationMedian: input.uncappedFrozenTokens.length === 0 ? null : +median(input.uncappedFrozenTokens.map(util)).toFixed(2),
    theoreticalUtilisationAllBoundsMedian: input.uncappedFrozenTokensAllBounds.length === 0 ? null : +median(input.uncappedFrozenTokensAllBounds.map(util)).toFixed(2),
    distribution: distributionOf(input.uncappedFrozenTokensAllBounds.map(util)),
    sufficiency,
  };
}

export type SupplyVerdict = "A11_SUPPLY_SUFFICIENT" | "A11_SUPPLY_INSUFFICIENT" | "A11_SUPPLY_INDETERMINATE";

/** The frozen rule needs MATCH at EVERY frozen budget, so sufficiency does too. */
export function supplyVerdict(rows: readonly SufficiencyRow[]): SupplyVerdict {
  const frozen = rows.filter((r) => r.frozen);
  if (frozen.length !== A11_BUDGETS.length) return "A11_SUPPLY_INDETERMINATE";
  if (frozen.some((r) => r.sufficiency === "INSUFFICIENT")) return "A11_SUPPLY_INSUFFICIENT";
  if (frozen.every((r) => r.sufficiency === "SUFFICIENT")) return "A11_SUPPLY_SUFFICIENT";
  return "A11_SUPPLY_INDETERMINATE";
}

// --------------------------------------------------- response-level gates

export interface AllocationGate { readonly id: string; readonly pass: boolean; readonly detail: string }

/**
 * Hold one delivered response and its counterfactual to the allocation
 * questions the milestone asks: no duplicate identity, no filler (every
 * related entry traces to a supply record with a claim), accounting
 * reconciles (the M204 analyzer's verdict, consumed), every discard
 * classified (no unexplained truncation), and the stop reason explained.
 */
export function allocationGates(input: {
  readonly packet: any;
  readonly utilizationVerdict: string | null;
  readonly discardClasses: readonly DiscardClass[];
  readonly stop: { readonly reason: StopReason; readonly policy: string | null };
  readonly simulation: SimulationResult | null;
}): AllocationGate[] {
  const gates: AllocationGate[] = [];
  const related: any[] = Array.isArray(input.packet?.related) ? input.packet.related : [];
  const ids = [String(input.packet?.focus?.at ?? ""), ...related.map((r) => String(r.at))];
  gates.push({ id: "no_duplicate_identity", pass: new Set(ids).size === ids.length && ids.every((i) => i.length > 0), detail: `${ids.length - new Set(ids).size} repeated identities` });
  gates.push({ id: "utilization_integrity", pass: input.utilizationVerdict === "UTILIZATION_INTEGRITY_PASS", detail: String(input.utilizationVerdict) });
  const unexplained = input.discardClasses.filter((c) => c === "OTHER").length;
  gates.push({ id: "every_discard_classified", pass: unexplained === 0, detail: `${unexplained} discards with an unclassified reason` });
  gates.push({ id: "stop_reason_explained", pass: input.stop.reason !== "OTHER_EXPLICIT_POLICY" || input.stop.policy !== null, detail: `${input.stop.reason}${input.stop.policy ? `:${input.stop.policy}` : ""}` });
  if (input.simulation !== null) {
    const sim = input.simulation;
    const simIds = sim.rows.filter((r) => r.fitsCeiling).map((r) => r.at);
    gates.push({ id: "counterfactual_no_duplicate", pass: new Set(simIds).size === simIds.length, detail: `${simIds.length - new Set(simIds).size} duplicates in the counterfactual stream` });
    gates.push({ id: "counterfactual_prefix", pass: sim.rows.filter((r) => r.origin === "delivered").every((r, k) => String(related[k]?.at) === r.at), detail: "delivered entries lead the counterfactual in delivered order" });
  }
  return gates;
}
