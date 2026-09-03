import { describe, expect, test } from "bun:test";

import {
  adjacentPairs, classifyFocusSwap, firstDivergence, focusAdjustedRelation, frozenA13, longestCommonSubsequence,
  representationRegressionsOf, summarize, supportMoverMechanism, trackItem, transitionRow,
  type CapsuleEntry, type DeliveredItem, type StageSnapshot,
} from "./m208BudgetMonotonicity";

// ------------------------------------------------------------- fixtures

const entry = (fqName: string, over: Partial<CapsuleEntry> = {}): CapsuleEntry => ({
  fqName, path: `${fqName.split("::")[0]}`, symbol: fqName.split("::").pop() ?? fqName, kind: "function", contentMode: "signature", estimatedTokens: 30,
  roleReason: "lexical match; issue-domain relevance", selectionRole: null, supportTier: 1, finalScore: 1, pivotRankScore: null, pivotRankReason: null, ...over,
});

const delivered = (fqName: string, ordinal: number, sourceId: string, representation = "skeleton", over: Partial<DeliveredItem> = {}): DeliveredItem => ({
  sourceId, fqName, ordinal, slot: ordinal === 0 ? "focus" : "related", representation, representationReason: "upstream_form_delivered",
  availableRepresentation: representation, availableCodeCharacters: 80, characters: 120, actualTokens: 40,
  admissionPacketTokens: 100 + ordinal * 40, compactAdmissionPacketTokens: 90 + ordinal * 30, origin: "item_supply", ...over,
});

interface Spec {
  budget: number; tier?: string; maxPivots?: number; supportWindow?: number;
  pool: string[]; pivots: (string | CapsuleEntry)[]; support: (string | CapsuleEntry)[];
  discarded?: { fqName: string; reason: string }[];
  /** Delivered related ids, in packet order, with representation and assembly id. */
  related: [string, string, string][];
  focusCodeTokens?: number; coeditFired?: boolean; rejected?: number; dropped?: number;
}

function snapshot(spec: Spec): StageSnapshot {
  const pivots = spec.pivots.map((p) => (typeof p === "string" ? entry(p, { roleReason: "pivot: actionable function", contentMode: "full", pivotRankScore: 1 }) : p));
  const support = spec.support.map((s) => (typeof s === "string" ? entry(s) : s));
  const focus = pivots[0]!.fqName;
  const items: DeliveredItem[] = [delivered(focus, 0, "P1", "focused_source"), ...spec.related.map(([fq, rep, id], k) => delivered(fq, k + 1, id, rep))];
  return {
    task: "t", budget: spec.budget, tier: spec.tier ?? "standard", maxPivots: spec.maxPivots ?? 2, supportWindow: spec.supportWindow ?? 4,
    candidatePool: 25, poolWidthUsed: 25,
    pool: spec.pool.map((fq, k) => ({ rank: k + 1, symbolId: `id:${fq}`, fqName: fq, path: fq.split("::")[0]!, finalScore: 2 - k * 0.1, sources: ["lexical"] })),
    pivots, support, discarded: spec.discarded ?? [], coeditFired: spec.coeditFired ?? false, coeditCandidates: new Map(), assemblyAligned: true,
    delivery: { status: "compacted", selectedItemsBeforeBudget: 10, deliveredItems: items.length, droppedForBudget: spec.dropped ?? 0, compactionStages: [] },
    focusAt: focus, focusForm: "focused_source", focusCodeTokens: spec.focusCodeTokens ?? 100,
    items, relatedIds: spec.related.map(([fq]) => fq), relatedRepresentations: spec.related.map(([, rep]) => rep),
    wholeTokensFrozen: 800, ceilingTokens: 1000, evidenceTokens: 700, rejectedForCeiling: spec.rejected ?? 0, notReached: 0,
    packetSha: "x", directBuildConsistent: true,
  };
}

// ------------------------------------------------------------------ tests

describe("longestCommonSubsequence", () => {
  test("names the minimal movers", () => {
    const keep = longestCommonSubsequence(["A", "B", "C", "D"], ["A", "C", "D", "B"]);
    expect([...keep]).toEqual(["A", "C", "D"]);
    // A swap between a light (role-changed) item and a bystander names the light one.
    const weighted = longestCommonSubsequence(["A", "X", "B"], ["A", "B", "X"], (id) => (id === "X" ? 1 : 2));
    expect([...weighted]).toEqual(["A", "B"]);
  });
});

describe("transitionRow", () => {
  test("a pure prefix is NONE at no stage", () => {
    const lo = snapshot({ budget: 1000, pool: ["a::P", "b::X", "c::Y"], pivots: ["a::P"], support: ["b::X", "c::Y"], related: [["b::X", "skeleton", "S1"]] });
    const hi = snapshot({ budget: 2000, pool: ["a::P", "b::X", "c::Y"], pivots: ["a::P"], support: ["b::X", "c::Y"], related: [["b::X", "skeleton", "S1"], ["c::Y", "skeleton", "S2"]] });
    const row = transitionRow(lo, hi);
    expect(row.relation).toBe("prefix");
    expect(row.firstDivergenceMechanism).toBe("NONE");
    expect(row.lostItems).toHaveLength(0);
  });

  test("new items interleaved by a wider pool is a subsequence, attributed to nothing", () => {
    const lo = snapshot({ budget: 2000, pool: ["a::P", "b::X", "c::Y"], pivots: ["a::P"], support: ["b::X", "c::Y"], related: [["b::X", "skeleton", "S1"], ["c::Y", "skeleton", "S2"]] });
    const hi = snapshot({ budget: 4000, pool: ["a::P", "b::X", "n::N", "c::Y"], pivots: ["a::P"], support: ["b::X", "n::N", "c::Y"], related: [["b::X", "skeleton", "S1"], ["n::N", "skeleton", "S2"], ["c::Y", "skeleton", "S3"]] });
    const row = transitionRow(lo, hi);
    expect(row.relation).toBe("subsequence");
    expect(row.stageRelations.pool).toBe("subsequence");
    expect(row.firstDivergenceMechanism).toBe("SUBSEQUENCE_NEW_ITEMS_INTERLEAVED");
    expect(row.addedItems).toBe(1);
  });

  test("a focus swap where the new lead was cap-demoted at the lower budget is the pivot cap plus v2", () => {
    const lo = snapshot({ budget: 1000, tier: "micro", maxPivots: 1, supportWindow: 1,
      pool: ["a::big", "a::Small", "b::X"], pivots: [entry("a::big", { pivotRankScore: 1.8, contentMode: "full" })],
      support: [entry("a::Small", { roleReason: "strong target but beyond the pivot budget — pivot: actionable interface" }), "b::X"],
      related: [["a::Small", "skeleton", "S1"], ["b::X", "skeleton", "S2"]], focusCodeTokens: 350 });
    const hi = snapshot({ budget: 2000, tier: "standard", maxPivots: 2, supportWindow: 4,
      pool: ["a::big", "a::Small", "b::X"], pivots: [entry("a::Small", { pivotRankScore: 1.87, contentMode: "full" }), entry("a::big", { pivotRankScore: 1.8, contentMode: "full" })],
      support: ["b::X"], related: [["a::big", "focused_source", "P2"], ["b::X", "skeleton", "S1"]], focusCodeTokens: 40 });
    const row = transitionRow(lo, hi);
    expect(row.focusSwap).toBe(true);
    expect(row.sizeViolation).toBe(true);
    expect(row.sizeViolationCause).toBe("focus_swap");
    expect(row.focusSwapRecord?.classification).toBe("tier_cap_widened_then_v2_reordered");
    expect(row.firstDivergenceStage).toBe("S4a_pivot_order");
    expect(row.firstDivergenceMechanism).toBe("PIVOT_CAP_LEAD_RESELECTION");
    // The frozen relation is `neither`; with both focus identities removed the rest is a prefix.
    expect(row.relation).toBe("neither");
    expect(focusAdjustedRelation(lo, hi)).toBe("prefix");
  });

  test("the anchor-tier variant is named when the new lead does not out-score the old one under v2", () => {
    const lo = snapshot({ budget: 1000, tier: "micro", maxPivots: 1,
      pool: ["a::fn", "b::Title"], pivots: [entry("a::fn", { pivotRankScore: 1.95 })],
      support: [entry("b::Title", { roleReason: "strong target but beyond the pivot budget — pivot: actionable interface" })],
      related: [["b::Title", "skeleton", "S1"]] });
    const hi = snapshot({ budget: 2000, maxPivots: 2, pool: ["a::fn", "b::Title"],
      pivots: [entry("b::Title", { pivotRankScore: 1.83 }), entry("a::fn", { pivotRankScore: 1.95 })], support: [], related: [["a::fn", "focused_source", "P2"]] });
    expect(classifyFocusSwap(lo, hi)?.classification).toBe("tier_cap_widened_then_anchor_tier_reordered");
  });

  test("a lead exposed only by the wider pool is pool growth", () => {
    const lo = snapshot({ budget: 8000, pool: ["a::P"], pivots: ["a::P"], support: [], related: [] });
    const hi = snapshot({ budget: 16000, tier: "full", maxPivots: 5, pool: ["z::New", "a::P"], pivots: ["z::New", "a::P"], support: [], related: [["a::P", "focused_source", "P2"]] });
    expect(classifyFocusSwap(lo, hi)?.classification).toBe("pool_growth_exposed_new_pivot");
  });

  test("a support entry promoted to pivot by the wider cap is a role promotion at S2", () => {
    const lo = snapshot({ budget: 1000, maxPivots: 1, pool: ["a::P", "b::Q", "c::R"], pivots: ["a::P"],
      support: [entry("c::R"), entry("b::Q", { roleReason: "strong target but beyond the pivot budget — pivot: actionable function" })],
      related: [["c::R", "skeleton", "S1"], ["b::Q", "skeleton", "S2"]] });
    const hi = snapshot({ budget: 2000, maxPivots: 2, pool: ["a::P", "b::Q", "c::R"], pivots: ["a::P", "b::Q"], support: ["c::R"],
      related: [["b::Q", "focused_source", "P2"], ["c::R", "skeleton", "S1"]] });
    const row = transitionRow(lo, hi);
    expect(row.relation).toBe("neither");
    expect(row.firstDivergenceMechanism).toBe("PIVOT_CAP_ROLE_PROMOTION");
    expect(row.movedItems.map((m) => [m.fqName, m.mechanism])).toEqual([["b::Q", "PIVOT_CAP_ROLE_PROMOTION"]]);
  });

  test("base support that trades places when the co-edit window changes is the window partition", () => {
    const lo = snapshot({ budget: 1000, supportWindow: 1, coeditFired: true, pool: ["a::P", "b::A", "c::B"], pivots: ["a::P"], support: ["b::A", "c::B"],
      related: [["b::A", "skeleton", "S1"], ["c::B", "skeleton", "S2"]] });
    const hi = snapshot({ budget: 2000, supportWindow: 4, coeditFired: true, pool: ["a::P", "b::A", "c::B"], pivots: ["a::P"], support: ["c::B", "b::A"],
      related: [["c::B", "skeleton", "S1"], ["b::A", "skeleton", "S2"]] });
    const row = transitionRow(lo, hi);
    expect(row.firstDivergenceStage).toBe("S4b_support_order");
    expect(row.firstDivergenceMechanism).toBe("SUPPORT_WINDOW_PARTITION:coedit_displacement:window_changed");
    expect(row.movedItems).toHaveLength(1);
    expect(supportMoverMechanism(lo, { ...hi, supportWindow: 1 }, "base_support_tier_1")).toBe("SUPPORT_WINDOW_PARTITION:coedit_displacement:window_content_changed");
  });

  test("a lower-budget item the higher budget packed but did not deliver is an evidence-budget drop", () => {
    const lo = snapshot({ budget: 1000, pool: ["a::P", "b::X", "c::Y"], pivots: ["a::P"], support: ["b::X", "c::Y"], related: [["b::X", "skeleton", "S1"], ["c::Y", "skeleton", "S2"]] });
    const hi = snapshot({ budget: 2000, pool: ["a::P", "b::X", "c::Y"], pivots: ["a::P"], support: ["b::X", "c::Y"], related: [["b::X", "skeleton", "S1"]], dropped: 1 });
    const row = transitionRow(lo, hi);
    expect(row.lostItems.map((i) => [i.fqName, i.fate, i.mechanism])).toEqual([["c::Y", "evidence_budget_dropped", "EVIDENCE_BUDGET_DROP:base_support_tier_1"]]);
    expect(row.firstDivergenceStage).toBe("S7_evidence_budget");
  });

  test("losses at the pool, the role gate, the packer and the projector are told apart", () => {
    const lo = snapshot({ budget: 1000, pool: ["a::P", "b::X", "c::Y", "d::Z", "e::W"], pivots: ["a::P"], support: ["b::X", "c::Y", "d::Z", "e::W"],
      related: [["b::X", "skeleton", "S1"], ["c::Y", "skeleton", "S2"], ["d::Z", "skeleton", "S3"], ["e::W", "skeleton", "S4"]] });
    const hi = snapshot({ budget: 2000, pool: ["a::P", "c::Y", "d::Z", "e::W"], pivots: ["a::P"], support: ["e::W"],
      discarded: [{ fqName: "c::Y", reason: "a test symbol, not an edit target" }, { fqName: "d::Z", reason: "over budget: no room for this support item" }],
      related: [], rejected: 1 });
    const row = transitionRow(lo, hi);
    const fates = Object.fromEntries(row.lostItems.map((i) => [i.fqName, i.fate]));
    expect(fates).toEqual({ "b::X": "not_in_pool", "c::Y": "role_discarded", "d::Z": "packing_discarded", "e::W": "projector_rejected" });
    expect(row.firstDivergenceStage).toBe("S1_ranked_pool");
    expect(row.firstDivergenceMechanism).toBe("RETRIEVAL_POOL_MEMBERSHIP:lexical");
  });

  test("an impact item the higher budget no longer delivers is an inferred evidence-budget drop when the pivots persist", () => {
    const lo = snapshot({ budget: 1000, pool: ["a::P"], pivots: ["a::P"], support: [], related: [["z::Impact", "relationship_only", "I1"]] });
    const hi = snapshot({ budget: 2000, pool: ["a::P"], pivots: ["a::P"], support: [], related: [], dropped: 1 });
    const [item] = transitionRow(lo, hi).lostItems;
    expect(item?.fate).toBe("evidence_budget_dropped");
    expect(item?.mechanism).toBe("EVIDENCE_BUDGET_DROP:impact_evidence(inferred)");
  });
});

describe("representation regressions", () => {
  test("a code-bearing entry that became relationship-only for the ceiling is classified by whether the richer form would have fit", () => {
    const lo = snapshot({ budget: 1000, pool: ["a::P", "b::X"], pivots: ["a::P"], support: ["b::X"], related: [["b::X", "skeleton", "S1"]] });
    const hiBase = snapshot({ budget: 2000, pool: ["a::P", "n::N", "b::X"], pivots: ["a::P"], support: ["n::N", "b::X"],
      related: [["n::N", "skeleton", "S1"], ["b::X", "relationship_only", "S2"]] });
    const hi: StageSnapshot = { ...hiBase, ceilingTokens: 10_000,
      items: hiBase.items.map((i) => (i.fqName === "b::X" ? { ...i, representationReason: "ceiling", availableRepresentation: "skeleton", availableCodeCharacters: 80 } : i)) };
    const { regressions } = representationRegressionsOf(lo, hi);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]!.newEarlierAdmissions).toBe(1);
    expect(regressions[0]!.classification).toBe("avoidable_admission_first_crowding");
    const tight: StageSnapshot = { ...hi, ceilingTokens: 50 };
    expect(representationRegressionsOf(lo, tight).regressions[0]!.classification).toBe("necessary_ceiling");
  });

  test("an upstream body that stopped rendering is not a projector regression", () => {
    const lo = snapshot({ budget: 1000, pool: ["a::P", "b::X"], pivots: ["a::P"], support: ["b::X"], related: [["b::X", "skeleton", "S1"]] });
    const hiBase = snapshot({ budget: 2000, pool: ["a::P", "b::X"], pivots: ["a::P"], support: ["b::X"], related: [["b::X", "relationship_only", "S1"]] });
    const hi: StageSnapshot = { ...hiBase, items: hiBase.items.map((i) => (i.fqName === "b::X" ? { ...i, representationReason: "no_rendered_body" } : i)) };
    expect(representationRegressionsOf(lo, hi).regressions[0]!.classification).toBe("upstream_form_changed");
  });
});

describe("frozen A13 replica", () => {
  test("counts tasks with any size drop or focus swap, verbatim, and passes only at zero", () => {
    const mk = (budget: number, focus: string, tokens: number): StageSnapshot => ({ ...snapshot({ budget, pool: [focus], pivots: [focus], support: [], related: [] }), focusCodeTokens: tokens });
    const bad = [mk(1000, "a::F", 300), mk(2000, "a::G", 40), mk(4000, "a::G", 40), mk(8000, "a::G", 40), mk(16000, "a::G", 40)];
    const scored = frozenA13(bad);
    expect(scored.tasksWithSizeViolation).toBe(1);
    expect(scored.tasksWithFocusSwap).toBe(1);
    expect(scored.verdict).toBe("VTRACE_BELOW_VEXP_CLAIM");
    const good = [1000, 2000, 4000, 8000, 16000].map((b) => mk(b, "a::F", 100 + b / 1000));
    expect(frozenA13(good).verdict).toBe("VTRACE_EXCEEDS_VEXP_CLAIM");
  });
});

describe("attribution gate", () => {
  test("is complete only when every non-prefix transition names a stage and every lost item a fate", () => {
    const lo = snapshot({ budget: 1000, pool: ["a::P", "b::X"], pivots: ["a::P"], support: ["b::X"], related: [["b::X", "skeleton", "S1"]] });
    const hi = snapshot({ budget: 2000, pool: ["a::P", "b::X"], pivots: ["a::P"], support: ["b::X"], related: [["b::X", "skeleton", "S1"]] });
    expect(summarize([transitionRow(lo, hi)]).gate).toBe("A13_CAUSAL_ATTRIBUTION_COMPLETE");
    // An item in the higher pool, neither pivot, support nor discard: the capsule has no account of it.
    const odd: StageSnapshot = { ...hi, pivots: hi.pivots, support: [], related: [], relatedIds: [], relatedRepresentations: [], items: hi.items.slice(0, 1) } as StageSnapshot;
    const row = transitionRow(lo, odd);
    expect(row.lostItems[0]!.fate).toBe("unaccounted");
    expect(summarize([row]).gate).toBe("A13_CAUSAL_ATTRIBUTION_INCOMPLETE");
  });

  test("first divergence is the earliest stage any affected item names", () => {
    const div = firstDivergence({ focusSwap: false, relation: "neither",
      lostItems: [{ firstDivergenceStage: "S7_evidence_budget", mechanism: "EVIDENCE_BUDGET_DROP:x" } as any],
      movedItems: [{ firstDivergenceStage: "S4b_support_order", mechanism: "SUPPORT_WINDOW_PARTITION:coedit_displacement:window_changed" } as any] });
    expect(div.stage).toBe("S4b_support_order");
  });

  test("adjacent pairs are ascending and de-duplicated", () => {
    expect(adjacentPairs([2000, 1000, 1000, 4000])).toEqual([[1000, 2000], [2000, 4000]]);
  });
});

describe("trackItem", () => {
  test("a delivered item that kept its place with a richer form is identical, not a mover", () => {
    const lo = snapshot({ budget: 1000, pool: ["a::P", "b::X"], pivots: ["a::P"], support: ["b::X"], related: [["b::X", "relationship_only", "S1"]] });
    const hi = snapshot({ budget: 2000, pool: ["a::P", "b::X"], pivots: ["a::P"], support: ["b::X"], related: [["b::X", "skeleton", "S1"]] });
    const t = trackItem(lo, hi, "b::X", ["b::X"], ["b::X"], new Set());
    expect(t.fate).toBe("identical");
    expect(t.representation).toBe("richer");
    expect(t.firstDivergenceStage).toBe("none");
  });
});
