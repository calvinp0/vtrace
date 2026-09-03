/**
 * M208 — budget-growth monotonicity: the adjacent-budget transition ledger, the
 * stage-by-stage fate of every lower-budget delivered item, and the first
 * causal divergence for every transition that is not order-preserving.
 *
 * PURE. Everything here is a function of snapshots the driver captured from the
 * REAL default `get_code_context` path (the packet and its M203 ledger) and from
 * ONE direct read-only capsule build with the same inputs (the ranked pool, the
 * roles, the pivot order, the packed support order and every discard with its
 * verbatim reason). Nothing is simulated, scored or ranked here.
 *
 * THE FROZEN A13 RULE, verbatim from run_stage5_m197a_engine.ts: per task, over
 * the five frozen budgets in ascending order, a SIZE VIOLATION is a step where
 * `ceil(chars/4)` of `focus.code` decreases and a FOCUS SWAP is a step where
 * `focus.at` changes; the claim counts tasks with any violation of either kind
 * and MATCHES at 0. The related-list order relations and the representation
 * regressions M207 reported beside it are OBSERVATIONS (m204Utilization's
 * `orderRelation` and the M207 sweep's `relationship_only` rule), reproduced
 * here under the same definitions; they are not part of the frozen verdict.
 *
 * STAGES, in the product's own order (recovered from src/, not invented):
 *   S1  ranked pool          hybridRetrieve + merges       diagnostics.candidate_scores
 *   S2  role assignment      assignCandidateRoles(maxPivots) / refineDebugRoles
 *   S4a pivot order          pivotCandidates.sort (anchor tiers; pivot-ranking v2)
 *   S4b support order        baseSupportOrder + co-edit / file-evidence /
 *                            path-completion / mechanism lanes (supportWindow)
 *   S5  packing              renderPivot / renderSupport against maxTokens
 *   S6  assembly             assembleProductContext: P#, S#, then D/I/M/G items
 *   S7  evidence budget      applyProgressiveContextBudget (the ladder)
 *   S9  projector            projectRunPipelineOrientation: admission prefix
 *                            under the caller's ceiling, then M205 routing
 *   S10 packet               focus + related, the frozen scorer's input
 */

import { orderRelation } from "./m204Utilization";

export const FROZEN_A13_BUDGETS: readonly number[] = [1000, 2000, 4000, 8000, 16000];

/** Frozen scorer's tokenizer: ceil(chars / 4). */
export const frozenTokens = (text: string): number => Math.ceil(text.length / 4);

// ------------------------------------------------------------------ snapshots

export interface PoolEntry {
  readonly rank: number;
  readonly symbolId: string;
  readonly fqName: string;
  readonly path: string;
  readonly finalScore: number;
  readonly sources: readonly string[];
}

export interface CapsuleEntry {
  readonly fqName: string;
  readonly path: string;
  readonly symbol: string;
  readonly kind: string;
  readonly contentMode: string;
  readonly estimatedTokens: number;
  readonly roleReason: string;
  /** `mechanism_support` / `orchestration_support` when a lane role placed it. */
  readonly selectionRole: string | null;
  /** supportTier replica: 0 implementation helper, 1 ordinary, 2 generic infrastructure. */
  readonly supportTier: number;
  readonly finalScore: number | null;
  readonly pivotRankScore: number | null;
  readonly pivotRankReason: string | null;
}

export interface DiscardEntry {
  readonly fqName: string;
  readonly reason: string;
}

export interface DeliveredItem {
  /** The assembly id (`P1`, `S7`, …) the ledger carries as `sourceId`. */
  readonly sourceId: string;
  readonly fqName: string;
  readonly ordinal: number;
  readonly slot: "focus" | "related";
  readonly representation: string;
  readonly representationReason: string;
  readonly availableRepresentation: string | null;
  readonly availableCodeCharacters: number | null;
  readonly characters: number;
  readonly actualTokens: number;
  readonly admissionPacketTokens: number;
  readonly compactAdmissionPacketTokens: number;
  readonly origin: string;
}

export interface StageSnapshot {
  readonly task: string;
  readonly budget: number;
  readonly tier: string;
  readonly maxPivots: number;
  readonly supportWindow: number;
  /** The allocator's allowance for this budget. */
  readonly candidatePool: number;
  /** The width the capsule actually ran with (an instrument may pin it). */
  readonly poolWidthUsed: number | null;
  readonly pool: readonly PoolEntry[];
  readonly pivots: readonly CapsuleEntry[];
  readonly support: readonly CapsuleEntry[];
  readonly discarded: readonly DiscardEntry[];
  /** The co-edit lane (M97/M98): whether it fired and which entries it placed (`path::symbol` -> action/confidence). */
  readonly coeditFired: boolean;
  readonly coeditCandidates: ReadonlyMap<string, { action: string; confidence: string }>;
  /** Every ledger `S#` id names the capsule support entry at that ordinal. */
  readonly assemblyAligned: boolean;
  readonly delivery: {
    readonly status: string;
    readonly selectedItemsBeforeBudget: number | null;
    readonly deliveredItems: number | null;
    readonly droppedForBudget: number | null;
    readonly compactionStages: readonly string[];
  };
  readonly focusAt: string | null;
  readonly focusForm: string | null;
  readonly focusCodeTokens: number;
  readonly items: readonly DeliveredItem[];
  readonly relatedIds: readonly string[];
  readonly relatedRepresentations: readonly string[];
  readonly wholeTokensFrozen: number;
  /** The packet with and without the per-item `tokens` fields (M203 accounting overhead), in characters. */
  readonly packetCharacters: number | null;
  readonly evidenceCharacters: number | null;
  readonly ceilingTokens: number | null;
  readonly evidenceTokens: number | null;
  readonly rejectedForCeiling: number;
  readonly notReached: number;
  readonly packetSha: string;
  /** The capsule's own lead agrees with the packet's focus. */
  readonly directBuildConsistent: boolean;
}

/** supportTier, replicated from buildCapsuleV2.ts so a snapshot can name the tier an entry sat in. */
export function supportTierOf(entry: { is_implementation_helper?: unknown; is_generic_infrastructure?: unknown }): number {
  if (entry.is_implementation_helper === true) return 0;
  if (entry.is_generic_infrastructure === true) return 2;
  return 1;
}

export function capsuleEntryOf(item: Record<string, any>): CapsuleEntry {
  return {
    fqName: String(item.fq_name),
    path: String(item.path),
    symbol: String(item.symbol ?? ""),
    kind: String(item.kind ?? ""),
    contentMode: String(item.content_mode ?? ""),
    estimatedTokens: typeof item.estimated_tokens === "number" ? item.estimated_tokens : 0,
    roleReason: String(item.role_reason ?? ""),
    selectionRole: typeof item.selection_role === "string" ? item.selection_role : null,
    supportTier: supportTierOf(item),
    finalScore: typeof item.scorecard?.final === "number" ? item.scorecard.final : null,
    pivotRankScore: typeof item.pivot_rank_score === "number" ? item.pivot_rank_score : null,
    pivotRankReason: typeof item.pivot_rank_reason === "string" ? item.pivot_rank_reason : null,
  };
}

export function deliveredItemOf(item: Record<string, any>): DeliveredItem {
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    sourceId: String(item.sourceId ?? ""),
    fqName: String(item.at),
    ordinal: Number(item.ordinal),
    slot: item.slot === "focus" ? "focus" : "related",
    representation: String(item.representation),
    representationReason: String(item.representationReason ?? ""),
    availableRepresentation: typeof item.availableRepresentation === "string" ? item.availableRepresentation : null,
    availableCodeCharacters: num(item.availableCodeCharacters),
    characters: Number(item.characters ?? 0),
    actualTokens: Number(item.actualTokens ?? 0),
    admissionPacketTokens: Number(item.admissionPacketTokens ?? 0),
    compactAdmissionPacketTokens: Number(item.compactAdmissionPacketTokens ?? 0),
    origin: String(item.origin ?? ""),
  };
}

/**
 * Assemble a snapshot from what the driver observed: the default packet, its
 * ledger, the allocator's allocation and the direct capsule build.
 */
export function buildSnapshot(input: {
  readonly task: string;
  readonly budget: number;
  readonly allocation: { tier: string; maxPivots: number; supportWindow: number; candidatePool: number };
  readonly poolWidthUsed: number | null;
  readonly built: Record<string, any> | null;
  readonly packet: Record<string, any> | null;
  readonly ledger: Record<string, any> | undefined;
  readonly packetSha: string;
}): StageSnapshot {
  const built = input.built;
  const packet = input.packet;
  const ledger = input.ledger;
  const poolRows: any[] = Array.isArray(built?.diagnostics?.candidate_scores) ? built!.diagnostics.candidate_scores : [];
  const pool: PoolEntry[] = poolRows.map((c) => ({
    rank: Number(c.rank), symbolId: String(c.symbol_id), fqName: String(c.fq_name), path: String(c.path),
    finalScore: typeof c.scores?.final === "number" ? c.scores.final : 0,
    sources: Array.isArray(c.sources) ? c.sources.map(String) : [],
  }));
  const pivots = (Array.isArray(built?.pivots) ? built!.pivots : []).map(capsuleEntryOf);
  const support = (Array.isArray(built?.support) ? built!.support : []).map(capsuleEntryOf);
  const fqOf = (path: string, symbol: string): string => {
    const row = poolRows.find((c) => c.path === path && c.symbol === symbol);
    return row ? String(row.fq_name) : `${path}::${symbol}`;
  };
  const discarded: DiscardEntry[] = (Array.isArray(built?.discarded) ? built!.discarded : []).map((d: any) => ({
    fqName: typeof d.fq_name === "string" ? d.fq_name : fqOf(String(d.path), String(d.symbol)),
    reason: String(d.discard_reason ?? "unknown"),
  }));
  const coeditRows: any[] = Array.isArray(built?.diagnostics?.coedit_candidates) ? built!.diagnostics.coedit_candidates : [];
  const coeditCandidates = new Map<string, { action: string; confidence: string }>(
    coeditRows.map((c) => [`${c.path}::${c.symbol}`, { action: String(c.action), confidence: String(c.confidence) }] as const));
  const coeditFired = built?.diagnostics?.coedit_lane_fired === true;
  const items: DeliveredItem[] = (Array.isArray(ledger?.items) ? ledger!.items : []).map(deliveredItemOf);
  const isPacket = packet !== null && typeof packet === "object" && "focus" in packet;
  const focusCode = isPacket && typeof packet!.focus?.code === "string" ? packet!.focus.code : "";
  const related: any[] = isPacket && Array.isArray(packet!.related) ? packet!.related : [];
  const representationByAt = new Map(items.filter((i) => i.slot === "related").map((i) => [i.fqName, i.representation] as const));
  const relatedIds = related.map((r) => String(r.at));
  // Alignment: every `S<k>` the ledger delivered must name the capsule's k-th support entry.
  let assemblyAligned = true;
  for (const item of items) {
    const m = /^S(\d+)$/.exec(item.sourceId);
    if (m === null) continue;
    const entry = support[Number(m[1]) - 1];
    if (entry === undefined || entry.fqName !== item.fqName) { assemblyAligned = false; break; }
  }
  const eb = ledger?.evidenceBudget ?? {};
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const focusAt = isPacket ? String(packet!.focus.at) : null;
  return {
    task: input.task, budget: input.budget,
    tier: input.allocation.tier, maxPivots: input.allocation.maxPivots, supportWindow: input.allocation.supportWindow,
    candidatePool: input.allocation.candidatePool, poolWidthUsed: input.poolWidthUsed,
    pool, pivots, support, discarded, coeditFired, coeditCandidates, assemblyAligned,
    delivery: {
      status: typeof eb.deliveryStatus === "string" ? eb.deliveryStatus : "unavailable",
      selectedItemsBeforeBudget: num(eb.selectedItemsBeforeBudget), deliveredItems: num(eb.deliveredItems),
      droppedForBudget: num(eb.droppedForBudget),
      compactionStages: Array.isArray(eb.compactionStages) ? eb.compactionStages.map(String) : [],
    },
    focusAt,
    focusForm: isPacket ? (packet!.focus.form ?? null) : null,
    focusCodeTokens: frozenTokens(focusCode),
    items, relatedIds,
    relatedRepresentations: relatedIds.map((id) => representationByAt.get(id) ?? "unlabelled"),
    wholeTokensFrozen: frozenTokens(JSON.stringify(packet ?? {})),
    packetCharacters: num(ledger?.packet?.characters), evidenceCharacters: num(ledger?.evidence?.characters),
    ceilingTokens: num(ledger?.ceilingTokens), evidenceTokens: num(ledger?.evidence?.tokens),
    rejectedForCeiling: Number(ledger?.candidates?.rejectedForCeiling ?? 0),
    notReached: Number(ledger?.candidates?.notReached ?? 0),
    packetSha: input.packetSha,
    directBuildConsistent: focusAt === null || pivots.length === 0 ? false : pivots[0]!.fqName === focusAt,
  };
}

// ---------------------------------------------------------------- item fates

export type ItemFate =
  | "identical"
  | "moved_earlier"
  | "moved_later"
  | "became_focus"
  | "not_in_pool"
  | "role_discarded"
  | "packing_discarded"
  | "evidence_budget_dropped"
  | "projector_rejected"
  | "not_assembled"
  | "lane_not_reproduced"
  | "unaccounted";

export type RepresentationDirection = "same" | "richer" | "poorer" | "not_delivered";

/** M205's classes, richest first; `relationship_only` carries no code. */
export const REPRESENTATION_RANK: Readonly<Record<string, number>> = Object.freeze({
  focused_source: 5, excerpt: 4, mechanism_slice: 4, signature: 3, skeleton: 2, relationship_only: 1, unlabelled: 0,
});

export function representationDirection(before: string, after: string | null): RepresentationDirection {
  if (after === null) return "not_delivered";
  const b = REPRESENTATION_RANK[before] ?? 0; const a = REPRESENTATION_RANK[after] ?? 0;
  return a === b ? "same" : a > b ? "richer" : "poorer";
}

/** The product stages in order; a divergence is attributed to the EARLIEST one it appears at. */
export const STAGE_ORDER: readonly string[] = [
  "S1_ranked_pool", "S2_role_assignment", "S4a_pivot_order", "S4b_support_order", "S5_packing",
  "S6_assembly", "S7_evidence_budget", "S9_projector", "none", "unknown",
];
const stageIndex = (stage: string): number => { const i = STAGE_ORDER.indexOf(stage); return i < 0 ? STAGE_ORDER.length : i; };

/** Which assembly lane an item came from, from its `P#`/`S#`/`D#`/`I#`/`M#`/`G#` id or its projector origin. */
export function assemblyLaneOf(sourceId: string | null, origin: string | null): string {
  if (origin === "pivot_neighborhood") return "pivot_neighborhood";
  const prefix = sourceId?.[0] ?? "";
  switch (prefix) {
    case "P": return "capsule_pivot";
    case "S": return "capsule_support";
    case "R": return "required_target";
    case "D": return "actionability_target";
    case "I": return "impact_evidence";
    case "M": return "memory";
    case "G": return "rule";
    default: return "unknown";
  }
}

export interface StageFacts {
  readonly poolRank: number | null;
  /** Retrieval provenance of the pool entry (`lexical`, `graph`, `concept_owner`, …). */
  readonly poolSources: readonly string[];
  readonly finalScore: number | null;
  readonly role: "pivot" | "support" | "discard" | "absent";
  readonly roleReason: string | null;
  readonly lane: string;
  readonly pivotOrdinal: number | null;
  readonly supportOrdinal: number | null;
  readonly discardReason: string | null;
  readonly deliveredOrdinal: number | null;
  readonly representation: string | null;
  readonly representationReason: string | null;
  readonly tokens: number | null;
  readonly sourceId: string | null;
  readonly assemblyLane: string;
}

export function stageFactsOf(snapshot: StageSnapshot, fqName: string): StageFacts {
  const pool = snapshot.pool.find((p) => p.fqName === fqName);
  const pivotIndex = snapshot.pivots.findIndex((p) => p.fqName === fqName);
  const supportIndex = snapshot.support.findIndex((s) => s.fqName === fqName);
  const discard = snapshot.discarded.find((d) => d.fqName === fqName);
  const item = snapshot.items.find((i) => i.fqName === fqName);
  const role: StageFacts["role"] = pivotIndex >= 0 ? "pivot" : supportIndex >= 0 ? "support" : discard !== undefined ? "discard" : "absent";
  const entry = pivotIndex >= 0 ? snapshot.pivots[pivotIndex] : supportIndex >= 0 ? snapshot.support[supportIndex] : undefined;
  return {
    poolRank: pool?.rank ?? null, poolSources: pool?.sources ?? [], finalScore: pool?.finalScore ?? entry?.finalScore ?? null,
    role, roleReason: entry?.roleReason ?? null, lane: pivotIndex >= 0 ? "pivot" : laneOf(entry, snapshot),
    pivotOrdinal: pivotIndex >= 0 ? pivotIndex + 1 : null, supportOrdinal: supportIndex >= 0 ? supportIndex + 1 : null,
    discardReason: discard?.reason ?? null,
    deliveredOrdinal: item?.ordinal ?? null, representation: item?.representation ?? null,
    representationReason: item?.representationReason ?? null, tokens: item?.actualTokens ?? null,
    sourceId: item?.sourceId ?? null, assemblyLane: assemblyLaneOf(item?.sourceId ?? null, item?.origin ?? null),
  };
}

export interface TrackedItem {
  readonly task: string;
  readonly from: number;
  readonly to: number;
  readonly fqName: string;
  readonly lower: StageFacts;
  readonly higher: StageFacts;
  readonly fate: ItemFate;
  readonly representation: RepresentationDirection;
  /** The first product stage at which the higher budget parted from the lower budget's treatment. */
  readonly firstDivergenceStage: string;
  readonly mechanism: string;
  /** Position among the items both budgets delivered: lower ordinal -> higher ordinal (0-based). */
  readonly commonOrdinalLower: number | null;
  readonly commonOrdinalHigher: number | null;
  /** True when the item is outside the longest common subsequence of the two common-item orders. */
  readonly mover: boolean;
}

/**
 * Which support lane placed an entry (repository vocabulary: buildCapsuleV2,
 * coeditExpansion, graphNeighborAnchoring). A co-edit RESCUE keeps its organic
 * role reason, so the lane is read from the capsule's `coedit_candidates`
 * diagnostic when a snapshot is given.
 */
export function laneOf(entry: CapsuleEntry | undefined, snapshot?: Pick<StageSnapshot, "coeditCandidates">): string {
  if (entry === undefined) return "unknown";
  const coedit = snapshot?.coeditCandidates.get(`${entry.path}::${entry.symbol}`);
  if (coedit !== undefined) return `coedit_${coedit.action}_${coedit.confidence}`;
  if (entry.selectionRole === "mechanism_support") return "mechanism_support";
  if (entry.selectionRole === "orchestration_support") return "path_completion";
  const reason = entry.roleReason.toLowerCase();
  if (reason.startsWith("near high-confidence seed") || reason.startsWith("production neighbour of high-confidence seed")) return "graph_neighbour_anchoring";
  if (reason.includes("co-edit")) return "coedit";
  if (reason.includes("file-evidence") || reason.includes("file evidence") || reason.includes("deep-pool")) return "file_evidence_rescue";
  if (reason.includes("routed rescue")) return "routed_rescue";
  if (/^strong target (but )?beyond the pivot budget/.test(reason)) return "budget_demoted_pivot";
  if (entry.kind === "markdown_section" || reason.includes("documentation")) return "documentation";
  return `base_support_tier_${entry.supportTier}`;
}

/** Role/packing reason classes, from the verbatim discard reasons buildCapsuleV2 records. */
export function discardClassOf(reason: string): string {
  if (/over budget/.test(reason)) return "packing_over_budget";
  if (/redundant support/.test(reason)) return "packing_dedupe";
  if (/token ceiling/.test(reason)) return "packing_lane_ceiling";
  if (/support-only/.test(reason)) return "no_pivot_support_only";
  if (/test symbol/.test(reason)) return "role_gate_test_symbol";
  if (/no lexical\/symbol\/path\/test\/graph relevance/.test(reason)) return "role_gate_no_relevance";
  if (/hub/.test(reason)) return "role_gate_hub";
  return "role_gate_other";
}

/**
 * Longest common subsequence of two sequences of distinct ids, by weight;
 * returns the ids kept. With `weightOf` an item can be made cheaper to leave
 * out, so a swap between an item whose role changed and a bystander names the
 * role-changed item as the mover.
 */
export function longestCommonSubsequence(a: readonly string[], b: readonly string[], weightOf: (id: string) => number = () => 1): Set<string> {
  const n = a.length; const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + weightOf(a[i]!) : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const keep = new Set<string>();
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j] && dp[i]![j] === dp[i + 1]![j + 1]! + weightOf(a[i]!)) { keep.add(a[i]!); i += 1; j += 1; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return keep;
}

/**
 * Track one lower-budget delivered item into the higher-budget run, stage by
 * stage, and name the first stage where the two budgets treat it differently.
 * `common` is the lower budget's related order restricted to ids both budgets
 * delivered; `movers` the ids outside the longest common subsequence of the two
 * common orders (the minimal set whose movement explains the reorder).
 */
export function trackItem(lo: StageSnapshot, hi: StageSnapshot, fqName: string, common: readonly string[], hiCommon: readonly string[], movers: ReadonlySet<string>): TrackedItem {
  const lower = stageFactsOf(lo, fqName);
  const higher = stageFactsOf(hi, fqName);
  const rep = representationDirection(lower.representation ?? "unlabelled", higher.representation);
  const base = { task: lo.task, from: lo.budget, to: hi.budget, fqName, lower, higher, representation: rep,
    commonOrdinalLower: common.indexOf(fqName) >= 0 ? common.indexOf(fqName) : null,
    commonOrdinalHigher: hiCommon.indexOf(fqName) >= 0 ? hiCommon.indexOf(fqName) : null, mover: movers.has(fqName) };
  const nonCapsule = lower.assemblyLane !== "capsule_pivot" && lower.assemblyLane !== "capsule_support";
  if (hi.focusAt === fqName && lo.focusAt !== fqName) {
    return { ...base, fate: "became_focus", firstDivergenceStage: "S4a_pivot_order", mechanism: "PIVOT_CAP_LEAD_RESELECTION" };
  }
  if (higher.deliveredOrdinal !== null) {
    // Delivered at both budgets: did it move relative to the other common items, and what did it carry?
    const shift = (base.commonOrdinalHigher ?? 0) - (base.commonOrdinalLower ?? 0);
    const roleChanged = lower.role !== higher.role && lower.role !== "absent" && higher.role !== "absent";
    let stage = "none"; let mechanism = "NONE";
    if (base.mover) {
      if (roleChanged && higher.role === "pivot") { stage = "S2_role_assignment"; mechanism = "PIVOT_CAP_ROLE_PROMOTION"; }
      else if (roleChanged) { stage = "S2_role_assignment"; mechanism = `ROLE_RECLASSIFICATION:${lower.role}->${higher.role}`; }
      else if (higher.assemblyLane === "capsule_pivot") { stage = "S4a_pivot_order"; mechanism = "PIVOT_CAP_LEAD_RESELECTION"; }
      else if (higher.assemblyLane === "capsule_support") { stage = "S4b_support_order"; mechanism = supportMoverMechanism(lo, hi, higher.lane); }
      else if (higher.assemblyLane === "pivot_neighborhood") { stage = "S9_projector"; mechanism = "PIVOT_NEIGHBORHOOD_REORDER"; }
      else { stage = "S6_assembly"; mechanism = `ASSEMBLY_LANE_REORDER:${higher.assemblyLane}`; }
    } else if (rep === "poorer") {
      stage = "S9_projector"; mechanism = `REPRESENTATION_ROUTING:${higher.representationReason ?? "unknown"}`;
    }
    const fate: ItemFate = !base.mover ? "identical" : shift < 0 ? "moved_earlier" : "moved_later";
    return { ...base, fate, firstDivergenceStage: stage, mechanism: !base.mover && roleChanged ? `${mechanism}:role_changed_in_place:${lower.role}->${higher.role}` : mechanism };
  }
  // Not delivered at the higher budget. The higher budget's own capsule facts decide first.
  if (higher.role === "pivot" || higher.role === "support") {
    if (hi.rejectedForCeiling > 0 || hi.notReached > 0) {
      return { ...base, fate: "projector_rejected", firstDivergenceStage: "S9_projector", mechanism: "PROJECTOR_CEILING" };
    }
    return { ...base, fate: "evidence_budget_dropped", firstDivergenceStage: "S7_evidence_budget", mechanism: `EVIDENCE_BUDGET_DROP:${higher.lane}` };
  }
  if (higher.role === "discard") {
    const cls = discardClassOf(higher.discardReason ?? "");
    return cls.startsWith("packing")
      ? { ...base, fate: "packing_discarded", firstDivergenceStage: "S5_packing", mechanism: `CAPSULE_PACKING:${cls}` }
      : { ...base, fate: "role_discarded", firstDivergenceStage: "S2_role_assignment", mechanism: `ROLE_GATE:${cls}` };
  }
  if (nonCapsule) {
    // Impact / actionability / memory / rule items are derived from the pivots and the task by
    // assembleProductContext; with the pivot set preserved they were assembled again and the
    // evidence budget dropped them. Inferred, and labelled as such.
    const pivotsPreserved = lo.pivots.every((p) => hi.pivots.some((q) => q.fqName === p.fqName));
    return pivotsPreserved
      ? { ...base, fate: "evidence_budget_dropped", firstDivergenceStage: "S7_evidence_budget", mechanism: `EVIDENCE_BUDGET_DROP:${lower.assemblyLane}(inferred)` }
      : { ...base, fate: "not_assembled", firstDivergenceStage: "S6_assembly", mechanism: `ASSEMBLY_INPUT_CHANGED:${lower.assemblyLane}:pivot_set` };
  }
  if (higher.poolRank === null) {
    // A lane-injected entry (co-edit injection, graph-neighbour anchoring, file-evidence
    // rescue) was never a pool candidate; its absence is the lane's placement, not retrieval's.
    if (lower.poolRank === null) {
      return { ...base, fate: "lane_not_reproduced", firstDivergenceStage: "S4b_support_order", mechanism: `SUPPORT_LANE_NOT_REPRODUCED:${lower.lane}` };
    }
    // A pool candidate at the lower budget that the wider pool does not hold: named by its provenance.
    const provenance = [...lower.poolSources].sort().join("+") || "unknown";
    return { ...base, fate: "not_in_pool", firstDivergenceStage: "S1_ranked_pool", mechanism: `RETRIEVAL_POOL_MEMBERSHIP:${provenance}` };
  }
  return { ...base, fate: "unaccounted", firstDivergenceStage: "unknown", mechanism: "OTHER" };
}

/**
 * Name the rule that moved a support entry both budgets delivered. The support
 * order is `baseSupportOrder` (tier, then final score) re-partitioned by
 * `orderSupportWithCoedit` at the tier's support WINDOW (protected winners,
 * displacing co-edits, displaceable winners, spare co-edits, rest) and followed
 * by the graph-neighbour lane; so with the same pool a base entry moves only
 * because the window's partition changed, and a co-edit or neighbour entry
 * moves because its lane placed it relative to a different window.
 */
export function supportMoverMechanism(lo: StageSnapshot, hi: StageSnapshot, higherLane: string): string {
  if (higherLane.startsWith("coedit")) return `SUPPORT_LANE_PLACEMENT:${higherLane}`;
  if (higherLane === "graph_neighbour_anchoring") return "SUPPORT_LANE_PLACEMENT:graph_neighbour_append";
  if (higherLane === "file_evidence_rescue" || higherLane === "path_completion" || higherLane === "mechanism_support" || higherLane === "documentation" || higherLane === "routed_rescue") {
    return `SUPPORT_LANE_PLACEMENT:${higherLane}`;
  }
  if (lo.coeditFired || hi.coeditFired) {
    return lo.supportWindow !== hi.supportWindow
      ? "SUPPORT_WINDOW_PARTITION:coedit_displacement:window_changed"
      : "SUPPORT_WINDOW_PARTITION:coedit_displacement:window_content_changed";
  }
  return `SUPPORT_ORDER_OTHER:${higherLane}`;
}

// ------------------------------------------------------------- transitions

export type Relation = "prefix" | "subsequence" | "neither" | "unmeasured";

export interface RepresentationRegression {
  readonly fqName: string;
  readonly lowerRepresentation: string;
  readonly higherRepresentation: string;
  readonly higherReason: string;
  readonly higherOrdinal: number | null;
  readonly higherAvailableRepresentation: string | null;
  readonly higherAvailableCodeCharacters: number | null;
  /** The packet tokens the higher budget had committed before this entry was admitted. */
  readonly higherCompactAdmissionTokens: number | null;
  readonly higherCeilingTokens: number | null;
  /** Items admitted ahead of this one at the higher budget that the lower budget never delivered. */
  readonly newEarlierAdmissions: number;
  /** Would the lower budget's form have fit had only the items admitted before it been charged? (ceiling reason only.) */
  readonly richerFormWouldFitBeforeLaterAdmissions: boolean | null;
  readonly classification: "avoidable_admission_first_crowding" | "necessary_no_code_bearing_form" | "necessary_ceiling" | "upstream_form_changed";
}

export interface FocusSwapRecord {
  readonly task: string;
  readonly from: number;
  readonly to: number;
  readonly fromFocus: string;
  readonly toFocus: string;
  readonly fromTier: string;
  readonly toTier: string;
  readonly fromMaxPivots: number;
  readonly toMaxPivots: number;
  readonly fromPool: number;
  readonly toPool: number;
  readonly toFocusInLowerPool: boolean;
  readonly toFocusLowerRank: number | null;
  readonly fromFocusLowerRank: number | null;
  readonly toFocusHigherRank: number | null;
  readonly fromFocusHigherRank: number | null;
  readonly toFocusLowerRole: string;
  readonly toFocusLowerRoleReason: string | null;
  readonly fromFocusHigherRole: string;
  readonly fromFocusHigherPivotOrdinal: number | null;
  readonly toFocusV2: number | null;
  readonly fromFocusV2: number | null;
  readonly toFocusV2Reason: string | null;
  readonly fromFocusV2Reason: string | null;
  readonly scoreChanged: boolean;
  readonly classification:
    | "tier_cap_widened_then_v2_reordered"
    | "tier_cap_widened_then_anchor_tier_reordered"
    | "pool_growth_exposed_new_pivot"
    | "pool_reorder"
    | "lower_focus_lost"
    | "other";
}

export interface TransitionRow {
  readonly task: string;
  readonly from: number;
  readonly to: number;
  readonly fromTier: string;
  readonly toTier: string;
  readonly fromMaxPivots: number;
  readonly toMaxPivots: number;
  readonly fromSupportWindow: number;
  readonly toSupportWindow: number;
  readonly fromPool: number;
  readonly toPool: number;
  readonly fromPoolWidthUsed: number | null;
  readonly toPoolWidthUsed: number | null;
  readonly fromFocus: string | null;
  readonly toFocus: string | null;
  readonly focusSwap: boolean;
  readonly focusSwapRecord: FocusSwapRecord | null;
  readonly fromFocusCodeTokens: number;
  readonly toFocusCodeTokens: number;
  readonly sizeViolation: boolean;
  readonly sizeViolationCause: "focus_swap" | "same_focus_body_shrank" | null;
  readonly fromRelated: readonly string[];
  readonly toRelated: readonly string[];
  /** The frozen observation: m204Utilization.orderRelation on the related ids. */
  readonly relation: Relation;
  /** The same relation with both budgets' focus identities removed from both lists. */
  readonly focusAdjustedRelation: Relation;
  readonly stageRelations: {
    readonly pool: Relation;
    readonly pivots: Relation;
    readonly support: Relation;
    readonly assembly: Relation;
    readonly delivered: Relation;
    readonly packet: Relation;
  };
  readonly firstDivergenceStage: string;
  readonly firstDivergenceMechanism: string;
  readonly lostItems: readonly TrackedItem[];
  readonly movedItems: readonly TrackedItem[];
  readonly addedItems: number;
  readonly representationRegressions: readonly RepresentationRegression[];
  readonly representationUpgrades: number;
  readonly fromWholeTokens: number;
  readonly toWholeTokens: number;
  readonly fromDelivered: number;
  readonly toDelivered: number;
  readonly fromDroppedForBudget: number | null;
  readonly toDroppedForBudget: number | null;
  readonly toRejectedForCeiling: number;
  readonly assemblyAligned: boolean;
  readonly directBuildConsistent: boolean;
}

const relationOf = (a: readonly string[], b: readonly string[]): Relation => orderRelation(a, b);

/** The frozen observation, less the two focus identities (a swap alone makes any two lists `neither`). */
export function focusAdjustedRelation(lo: StageSnapshot, hi: StageSnapshot): Relation {
  const drop = new Set([lo.focusAt, hi.focusAt].filter((x): x is string => typeof x === "string"));
  return relationOf(lo.relatedIds.filter((id) => !drop.has(id)), hi.relatedIds.filter((id) => !drop.has(id)));
}

/** Assembly order as the ledger saw it: P# then S# in id order (what assembleProductContext produced). */
function assemblyOrder(snapshot: StageSnapshot): string[] {
  return [...snapshot.pivots.map((p) => p.fqName), ...snapshot.support.map((s) => s.fqName)];
}

export function classifyFocusSwap(lo: StageSnapshot, hi: StageSnapshot): FocusSwapRecord | null {
  if (lo.focusAt === null || hi.focusAt === null || lo.focusAt === hi.focusAt) return null;
  const toLower = stageFactsOf(lo, hi.focusAt);
  const toHigher = stageFactsOf(hi, hi.focusAt);
  const fromLower = stageFactsOf(lo, lo.focusAt);
  const fromHigher = stageFactsOf(hi, lo.focusAt);
  const toPivot = hi.pivots.find((p) => p.fqName === hi.focusAt);
  const fromPivotHi = hi.pivots.find((p) => p.fqName === lo.focusAt);
  const toFocusInLowerPool = toLower.poolRank !== null;
  const scoreChanged = toLower.finalScore !== null && toHigher.finalScore !== null
    && Math.abs(toLower.finalScore - toHigher.finalScore) > 1e-9;
  let classification: FocusSwapRecord["classification"] = "other";
  const capDemotedAtLower = toLower.role === "support" && /beyond the pivot budget/.test(toLower.roleReason ?? "");
  if (fromHigher.role !== "pivot") classification = "lower_focus_lost";
  else if (toFocusInLowerPool && capDemotedAtLower && hi.maxPivots > lo.maxPivots) {
    // The cap admitted it by final-score rank; the pivot ORDER then put it first, by pivot-ranking v2 or by the anchor tiers.
    classification = (toPivot?.pivotRankScore ?? -Infinity) > (fromPivotHi?.pivotRankScore ?? -Infinity)
      ? "tier_cap_widened_then_v2_reordered" : "tier_cap_widened_then_anchor_tier_reordered";
  }
  else if (!toFocusInLowerPool) classification = "pool_growth_exposed_new_pivot";
  else if (toLower.poolRank !== null && fromLower.poolRank !== null && toHigher.poolRank !== null && fromHigher.poolRank !== null
    && (toLower.poolRank > fromLower.poolRank) !== (toHigher.poolRank > fromHigher.poolRank)) classification = "pool_reorder";
  return {
    task: lo.task, from: lo.budget, to: hi.budget, fromFocus: lo.focusAt, toFocus: hi.focusAt,
    fromTier: lo.tier, toTier: hi.tier, fromMaxPivots: lo.maxPivots, toMaxPivots: hi.maxPivots,
    fromPool: lo.pool.length, toPool: hi.pool.length,
    toFocusInLowerPool, toFocusLowerRank: toLower.poolRank, fromFocusLowerRank: fromLower.poolRank,
    toFocusHigherRank: toHigher.poolRank, fromFocusHigherRank: fromHigher.poolRank,
    toFocusLowerRole: toLower.role, toFocusLowerRoleReason: toLower.roleReason,
    fromFocusHigherRole: fromHigher.role, fromFocusHigherPivotOrdinal: fromHigher.pivotOrdinal,
    toFocusV2: toPivot?.pivotRankScore ?? null, fromFocusV2: fromPivotHi?.pivotRankScore ?? null,
    toFocusV2Reason: toPivot?.pivotRankReason ?? null, fromFocusV2Reason: fromPivotHi?.pivotRankReason ?? null,
    scoreChanged, classification,
  };
}

export function representationRegressionsOf(lo: StageSnapshot, hi: StageSnapshot): { regressions: RepresentationRegression[]; upgrades: number } {
  const loRep = new Map(lo.relatedIds.map((id, k) => [id, lo.relatedRepresentations[k]!] as const));
  const loSet = new Set(lo.relatedIds);
  const regressions: RepresentationRegression[] = [];
  let upgrades = 0;
  hi.relatedIds.forEach((id, k) => {
    const before = loRep.get(id);
    const after = hi.relatedRepresentations[k]!;
    if (before === undefined) return;
    const direction = representationDirection(before, after);
    if (direction === "richer") upgrades += 1;
    // The M207 observation rule, verbatim: a code-bearing entry that became relationship-only.
    if (before === "relationship_only" || after !== "relationship_only") return;
    const item = hi.items.find((i) => i.fqName === id && i.slot === "related");
    const newEarlier = hi.relatedIds.slice(0, k).filter((x) => !loSet.has(x)).length;
    const reason = item?.representationReason ?? "unknown";
    let wouldFit: boolean | null = null;
    let classification: RepresentationRegression["classification"] = "necessary_ceiling";
    if (reason === "ceiling" && item !== undefined && hi.ceilingTokens !== null) {
      // Charge only the items delivered ahead of it (their delivered cost) plus this entry in its richer form.
      const ahead = hi.items.filter((i) => i.ordinal < item.ordinal).reduce((n, i) => n + i.actualTokens, 0);
      const wrapper = Math.max(0, hi.items[0]!.compactAdmissionPacketTokens - hi.items[0]!.actualTokens);
      const richer = item.actualTokens + Math.round((item.availableCodeCharacters ?? 0) * 0.3174) + 12;
      wouldFit = ahead + wrapper + richer <= hi.ceilingTokens;
      classification = wouldFit ? "avoidable_admission_first_crowding" : "necessary_ceiling";
    } else if (reason === "form_not_code_bearing" || reason === "no_rendered_body") {
      classification = "necessary_no_code_bearing_form";
      const loItem = lo.items.find((i) => i.fqName === id);
      if (loItem !== undefined && loItem.representationReason === "upstream_form_delivered") classification = "upstream_form_changed";
    }
    regressions.push({
      fqName: id, lowerRepresentation: before, higherRepresentation: after, higherReason: reason,
      higherOrdinal: item?.ordinal ?? null, higherAvailableRepresentation: item?.availableRepresentation ?? null,
      higherAvailableCodeCharacters: item?.availableCodeCharacters ?? null,
      higherCompactAdmissionTokens: item?.compactAdmissionPacketTokens ?? null, higherCeilingTokens: hi.ceilingTokens,
      newEarlierAdmissions: newEarlier, richerFormWouldFitBeforeLaterAdmissions: wouldFit, classification,
    });
  });
  return { regressions, upgrades };
}

/**
 * The first stage, in product order, at which the lower budget's delivered
 * sequence stops being preserved by the higher budget. Item-driven: the earliest
 * stage named by any lost or moved item (or the focus swap), so a reorder among
 * entries neither budget delivered never names the divergence of what was.
 */
export function firstDivergence(row: Pick<TransitionRow, "focusSwap" | "lostItems" | "movedItems" | "relation">): { stage: string; mechanism: string } {
  if (row.relation === "prefix") return { stage: "none", mechanism: "NONE" };
  const affected = [...row.lostItems, ...row.movedItems].filter((i) => i.firstDivergenceStage !== "none");
  const candidates: { stage: string; mechanism: string }[] = affected.map((i) => ({ stage: i.firstDivergenceStage, mechanism: i.mechanism }));
  if (row.focusSwap) candidates.push({ stage: "S4a_pivot_order", mechanism: "PIVOT_CAP_LEAD_RESELECTION" });
  if (candidates.length === 0) {
    return row.relation === "subsequence"
      ? { stage: "none", mechanism: "SUBSEQUENCE_NEW_ITEMS_INTERLEAVED" }
      : { stage: "unknown", mechanism: "OTHER" };
  }
  candidates.sort((a, b) => stageIndex(a.stage) - stageIndex(b.stage));
  const earliest = candidates[0]!.stage;
  const atStage = candidates.filter((c) => c.stage === earliest);
  const mechanism = Object.entries(histogram(atStage, (c) => c.mechanism))[0]![0];
  return { stage: earliest, mechanism };
}

export function transitionRow(lo: StageSnapshot, hi: StageSnapshot): TransitionRow {
  const hiRelated = new Set(hi.relatedIds);
  const hiDelivered = new Set(hi.items.map((i) => i.fqName));
  const common = lo.relatedIds.filter((id) => hiRelated.has(id));
  const hiCommon = hi.relatedIds.filter((id) => common.includes(id));
  // An item whose capsule role changed moved for a reason the stages record
  // (a cap promotion puts a support entry ahead of every support entry), so it
  // is a mover by construction; the longest common subsequence then names the
  // minimal movers among the rest, and cannot blame a bystander for a swap.
  const capsuleRole = (snapshot: StageSnapshot, id: string): string =>
    snapshot.pivots.some((p) => p.fqName === id) ? "pivot" : snapshot.support.some((s) => s.fqName === id) ? "support" : "other";
  const roleChanged = new Set(common.filter((id) => {
    const a = capsuleRole(lo, id); const b = capsuleRole(hi, id);
    return a !== "other" && b !== "other" && a !== b;
  }));
  // Role-changed items weigh less, so the longest common subsequence keeps
  // bystanders and names the promoted item as the mover when the two swapped;
  // a promoted item that kept its place (a cap-demoted pivot at the head of
  // support entering the pivot block, M208) is in the subsequence and moved
  // nothing.
  const stable = longestCommonSubsequence(common, hiCommon, (id) => (roleChanged.has(id) ? 1 : 2));
  const movers = new Set(common.filter((id) => !stable.has(id)));
  const tracked = lo.relatedIds.map((id) => trackItem(lo, hi, id, common, hiCommon, movers));
  const lostItems = tracked.filter((t) => !hiDelivered.has(t.fqName) || t.fate === "became_focus");
  const movedItems = tracked.filter((t) => hiRelated.has(t.fqName) && t.fate !== "became_focus" && (t.mover || t.firstDivergenceStage !== "none"));
  void roleChanged;
  const swap = classifyFocusSwap(lo, hi);
  const { regressions, upgrades } = representationRegressionsOf(lo, hi);
  const stageRelations = {
    pool: lo.pool.length === 0 || hi.pool.length === 0 ? "unmeasured" as Relation : relationOf(lo.pool.map((p) => p.fqName), hi.pool.map((p) => p.fqName)),
    pivots: relationOf(lo.pivots.map((p) => p.fqName), hi.pivots.map((p) => p.fqName)),
    support: relationOf(lo.support.map((s) => s.fqName), hi.support.map((s) => s.fqName)),
    assembly: relationOf(assemblyOrder(lo), assemblyOrder(hi)),
    delivered: relationOf(lo.items.map((i) => i.fqName), hi.items.map((i) => i.fqName)),
    packet: relationOf(lo.relatedIds, hi.relatedIds),
  };
  const sizeViolation = hi.focusCodeTokens < lo.focusCodeTokens;
  const partial = { focusSwap: swap !== null, lostItems, movedItems, relation: stageRelations.packet };
  const divergence = firstDivergence(partial);
  return {
    task: lo.task, from: lo.budget, to: hi.budget,
    fromTier: lo.tier, toTier: hi.tier, fromMaxPivots: lo.maxPivots, toMaxPivots: hi.maxPivots,
    fromSupportWindow: lo.supportWindow, toSupportWindow: hi.supportWindow,
    fromPool: lo.pool.length, toPool: hi.pool.length, fromPoolWidthUsed: lo.poolWidthUsed, toPoolWidthUsed: hi.poolWidthUsed,
    fromFocus: lo.focusAt, toFocus: hi.focusAt, focusSwap: swap !== null, focusSwapRecord: swap,
    fromFocusCodeTokens: lo.focusCodeTokens, toFocusCodeTokens: hi.focusCodeTokens,
    sizeViolation, sizeViolationCause: sizeViolation ? (swap !== null ? "focus_swap" : "same_focus_body_shrank") : null,
    fromRelated: lo.relatedIds, toRelated: hi.relatedIds,
    relation: stageRelations.packet, focusAdjustedRelation: focusAdjustedRelation(lo, hi),
    stageRelations, lostItems, movedItems,
    firstDivergenceStage: divergence.stage, firstDivergenceMechanism: divergence.mechanism,
    addedItems: hi.relatedIds.filter((id) => !lo.relatedIds.includes(id)).length,
    representationRegressions: regressions, representationUpgrades: upgrades,
    fromWholeTokens: lo.wholeTokensFrozen, toWholeTokens: hi.wholeTokensFrozen,
    fromDelivered: lo.items.length, toDelivered: hi.items.length,
    fromDroppedForBudget: lo.delivery.droppedForBudget, toDroppedForBudget: hi.delivery.droppedForBudget,
    toRejectedForCeiling: hi.rejectedForCeiling,
    assemblyAligned: lo.assemblyAligned && hi.assemblyAligned,
    directBuildConsistent: lo.directBuildConsistent && hi.directBuildConsistent,
  };
}

// --------------------------------------------------------------- aggregates

export interface FrozenA13Curve {
  readonly task: string;
  readonly points: readonly { budget: number; focusAt: string | null; focusCodeTokens: number }[];
  readonly sizeViolations: number;
  readonly focusSwaps: number;
}

/** The frozen scorer, verbatim (run_stage5_m197a_engine.ts), over snapshots at the frozen budgets. */
export function frozenA13(snapshots: readonly StageSnapshot[], budgets: readonly number[] = FROZEN_A13_BUDGETS): {
  readonly curves: FrozenA13Curve[];
  readonly tasksWithSizeViolation: number;
  readonly tasksWithFocusSwap: number;
  readonly violations: number;
  readonly verdict: "VTRACE_EXCEEDS_VEXP_CLAIM" | "VTRACE_MATCHES_VEXP_CLAIM" | "VTRACE_BELOW_VEXP_CLAIM";
} {
  const tasks = [...new Set(snapshots.map((s) => s.task))];
  const curves: FrozenA13Curve[] = tasks.map((task) => {
    const points = budgets.map((b) => snapshots.find((s) => s.task === task && s.budget === b)).filter((s): s is StageSnapshot => s !== undefined)
      .map((s) => ({ budget: s.budget, focusAt: s.focusAt, focusCodeTokens: s.focusCodeTokens }));
    let sizeViolations = 0; let focusSwaps = 0;
    for (let i = 1; i < points.length; i += 1) {
      if (points[i]!.focusCodeTokens < points[i - 1]!.focusCodeTokens) sizeViolations += 1;
      if (points[i]!.focusAt !== points[i - 1]!.focusAt) focusSwaps += 1;
    }
    return { task, points, sizeViolations, focusSwaps };
  });
  const tasksWithSizeViolation = curves.filter((c) => c.sizeViolations > 0).length;
  const tasksWithFocusSwap = curves.filter((c) => c.focusSwaps > 0).length;
  const violations = tasksWithSizeViolation + tasksWithFocusSwap;
  // band([violations], 0, 0, "atMost"): exceed and match both at 0.
  return { curves, tasksWithSizeViolation, tasksWithFocusSwap, violations,
    verdict: violations <= 0 ? "VTRACE_EXCEEDS_VEXP_CLAIM" : "VTRACE_BELOW_VEXP_CLAIM" };
}

export function histogram<T>(rows: readonly T[], key: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) { const k = key(row); out[k] = (out[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

export interface AttributionSummary {
  readonly transitions: number;
  readonly relations: Record<string, number>;
  readonly focusAdjustedRelations: Record<string, number>;
  readonly firstDivergenceByMechanism: Record<string, number>;
  readonly firstDivergenceByStage: Record<string, number>;
  readonly lostItems: number;
  readonly lostItemsByMechanism: Record<string, number>;
  readonly movedItems: number;
  readonly movedItemsByMechanism: Record<string, number>;
  readonly focusSwaps: number;
  readonly focusSwapsByClass: Record<string, number>;
  readonly sizeViolations: number;
  readonly sizeViolationsByCause: Record<string, number>;
  readonly representationRegressions: number;
  readonly representationRegressionsByClass: Record<string, number>;
  readonly representationRegressionsByReason: Record<string, number>;
  readonly unattributedTransitions: string[];
  readonly unaccountedItems: string[];
  readonly alignmentFailures: string[];
  readonly gate: "A13_CAUSAL_ATTRIBUTION_COMPLETE" | "A13_CAUSAL_ATTRIBUTION_INCOMPLETE";
}

export function summarize(rows: readonly TransitionRow[]): AttributionSummary {
  const lost = rows.flatMap((r) => r.lostItems);
  const moved = rows.flatMap((r) => r.movedItems);
  const swaps = rows.map((r) => r.focusSwapRecord).filter((s): s is FocusSwapRecord => s !== null);
  const regressions = rows.flatMap((r) => r.representationRegressions);
  const unattributed = rows.filter((r) => r.relation !== "prefix" && (r.firstDivergenceMechanism === "OTHER" || r.firstDivergenceStage === "unknown"))
    .map((r) => `${r.task}@${r.from}->${r.to}`);
  const unaccounted = lost.filter((i) => i.fate === "unaccounted").map((i) => `${i.task}@${i.from}->${i.to}:${i.fqName}`);
  const alignment = rows.filter((r) => !r.assemblyAligned || !r.directBuildConsistent).map((r) => `${r.task}@${r.from}->${r.to}`);
  const swapsUnclassified = swaps.filter((s) => s.classification === "other").length;
  return {
    transitions: rows.length,
    relations: histogram(rows, (r) => r.relation),
    focusAdjustedRelations: histogram(rows, (r) => r.focusAdjustedRelation),
    firstDivergenceByMechanism: histogram(rows, (r) => r.firstDivergenceMechanism),
    firstDivergenceByStage: histogram(rows, (r) => r.firstDivergenceStage),
    lostItems: lost.length, lostItemsByMechanism: histogram(lost, (i) => i.mechanism),
    movedItems: moved.length, movedItemsByMechanism: histogram(moved, (i) => i.mechanism),
    focusSwaps: swaps.length, focusSwapsByClass: histogram(swaps, (s) => s.classification),
    sizeViolations: rows.filter((r) => r.sizeViolation).length,
    sizeViolationsByCause: histogram(rows.filter((r) => r.sizeViolation), (r) => r.sizeViolationCause ?? "none"),
    representationRegressions: regressions.length,
    representationRegressionsByClass: histogram(regressions, (g) => g.classification),
    representationRegressionsByReason: histogram(regressions, (g) => g.higherReason),
    unattributedTransitions: unattributed, unaccountedItems: unaccounted, alignmentFailures: alignment,
    gate: unattributed.length === 0 && unaccounted.length === 0 && alignment.length === 0 && swapsUnclassified === 0
      ? "A13_CAUSAL_ATTRIBUTION_COMPLETE" : "A13_CAUSAL_ATTRIBUTION_INCOMPLETE",
  };
}

/** Adjacent pairs of an ascending budget list. */
export function adjacentPairs(budgets: readonly number[]): [number, number][] {
  const sorted = [...new Set(budgets)].sort((a, b) => a - b);
  return sorted.slice(1).map((b, k) => [sorted[k]!, b] as [number, number]);
}
