/**
 * The allocation audit is only trustworthy if its counterfactual replays the
 * projector's arithmetic exactly, admits nothing the product would refuse, and
 * refuses the ways a supply figure could be inflated.
 */
import { describe, expect, test } from "bun:test";

import { orientationTokensOfCharacters, withItemTokens } from "../../src/runPipeline/orientationAccounting";
import {
  ORIENTATION_BOUNDARY, ORIENTATION_POLICY, ORIENTATION_SCHEMA_VERSION, orientationCeilingTokens,
} from "../../src/runPipeline/orientationProjection";
import { availableRepresentation } from "../../src/runPipeline/orientationRepresentation";
import {
  actualStopReason, allocationGates, auditAllocationStages, classifyDiscardReason, requiredMatchTokens,
  simulateUncappedAdmission, sufficiencyRow, supplyVerdict, type Serializer, type UncappedCandidate,
} from "./m206Allocation";

const serializer: Serializer = {
  packetTokens: (p) => orientationTokensOfCharacters(JSON.stringify(p).length),
  assemble: (focus, related, notes) => ({ schemaVersion: ORIENTATION_SCHEMA_VERSION, focus, related: [...related], boundary: ORIENTATION_BOUNDARY, ...(notes.length === 0 ? {} : { notes: [...notes] }) }),
  withItemTokens,
  availableRepresentation: (i) => availableRepresentation(i) as any,
};

const focus = { at: "pkg/a.py::A.run", file: "pkg/a.py", lines: "1-9", form: "focused_source", why: "lead", code: "def run(self):\n    return 1", codeTruncated: false, tokens: 60 };
const delivered = (n: number) => Array.from({ length: n }, (_, k) => ({ at: `pkg/d${k}.py::D${k}`, file: `pkg/d${k}.py`, lines: "1-3", how: `direct caller ${k}`, tokens: 40 }));
const extra = (k: number, form = "skeleton", bodyLines = 2, role: UncappedCandidate["role"] = "support"): UncappedCandidate => ({
  at: `pkg/x${k}.py::X${k}.m`, file: `pkg/x${k}.py`, lines: `${k * 10 + 1}-${k * 10 + 5}`, how: `support candidate ${k}`,
  form, body: form === "summary" ? "CALLS y" : Array.from({ length: bodyLines }, (_, l) => `def m${k}_${l}(a):`).join("\n"),
  capsuleEstimatedTokens: 12, discardRank: k + 1, poolRank: 10 + k, finalScore: 1 - k / 100, role, identityResolved: true,
});

describe("discard classification", () => {
  test("names every capsule discard family and leaves nothing unexplained on the known reasons", () => {
    expect(classifyDiscardReason("beyond standard support budget (max 4)", "support: x")).toBe("TIER_SUPPORT_CAP");
    expect(classifyDiscardReason("beyond full support budget (max 10)", "support: x")).toBe("TIER_SUPPORT_CAP");
    expect(classifyDiscardReason("over budget: no room for this support item", "support: x")).toBe("TOKEN_BUDGET");
    expect(classifyDiscardReason("over budget: no room for this pivot", "pivot: x")).toBe("TOKEN_BUDGET");
    expect(classifyDiscardReason("redundant support: identical delivered evidence to a.py::b", "support: x")).toBe("REDUNDANT_DELIVERY");
    expect(classifyDiscardReason("co-edit token ceiling: over the co-edit budget fraction", "support: x")).toBe("LANE_TOKEN_CEILING");
    expect(classifyDiscardReason("support-only: no actionable edit target", "support: x")).toBe("NO_PIVOT_SUPPORT_ONLY");
    expect(classifyDiscardReason("discard: a test symbol, not an edit target", undefined)).toBe("ROLE_GATE");
    expect(classifyDiscardReason("something new", "support: x")).toBe("OTHER");
  });
});

describe("stage audit", () => {
  test("counts what each stage lost and marks only the count cap as otherwise-eligible", () => {
    const rows = auditAllocationStages({
      capsule: {
        candidateCount: 25, poolCap: 25, tier: "standard", maxPivots: 2, maxSupport: 4,
        pivots: [{ roleReason: "lead" }, { roleReason: "second" }],
        support: [{ roleReason: "strong target beyond the pivot budget — x", inPool: true }, { roleReason: "s", inPool: true }, { roleReason: "s", inPool: true }, { roleReason: "co-edit", inPool: false }],
        discarded: [
          ...Array.from({ length: 12 }, () => ({ reason: "beyond standard support budget (max 4)", roleReason: "support: s", inPool: true })),
          { reason: "discard: a test symbol, not an edit target", roleReason: undefined, inPool: true },
          { reason: "redundant support: identical delivered evidence to a::b", roleReason: "support: s", inPool: true },
        ],
      },
      assembly: { itemsByRole: { pivot: 2, support: 4, impact: 3 }, items: 9, duplicateItemsRemoved: 0 },
      delivery: { selectedItemsBeforeBudget: 9, deliveredItems: 9, droppedForBudget: 0, compactionStages: [] },
      projector: { neighbourhoodExcerpts: 4, proposed: 12, deduplicated: 2, droppedNoClaim: 0, admitted: 9, rejectedForCeiling: 0, notReached: 0 },
    });
    const by = Object.fromEntries(rows.map((r) => [r.stage, r]));
    expect(by.role_gate!.lost).toBe(1);
    expect(by.pivot_cap!.input).toBe(3);
    expect(by.pivot_cap!.output).toBe(2);
    expect(by.support_packing!.input).toBe(4 + 12 + 1);
    expect(by.support_packing!.output).toBe(4);
    expect(by.support_packing!.lostByReason.TIER_SUPPORT_CAP).toBe(12);
    expect(by.support_packing!.otherwiseEligibleLost).toBe(12);
    expect(by.projector_admission!.lostByReason.DEDUPLICATED).toBe(2);
    expect(rows.every((r) => r.stage !== "support_packing" ? r.otherwiseEligibleLost === 0 : true)).toBe(true);
  });
});

describe("counterfactual admission", () => {
  const base = (budget: number, extras: UncappedCandidate[], deliveredCount = 3, upstream: { budgetTokens: number; renderedCharacters: number } | null = null) =>
    simulateUncappedAdmission({
      focus, notes: [], delivered: delivered(deliveredCount), extras,
      ceilingTokens: orientationCeilingTokens(budget), relatedBound: ORIENTATION_POLICY.relatedCodeCharacters,
      upstream, capsule: null, serializer, pool: { candidateCount: 25, cap: 25 },
    });

  test("the delivered prefix is replayed at the projector's own numbers and the extras follow in discard order", () => {
    const sim = base(16000, [extra(0), extra(1), extra(2)]);
    expect(sim.rows.slice(0, 3).map((r) => r.origin)).toEqual(["delivered", "delivered", "delivered"]);
    expect(sim.rows.slice(3).map((r) => r.at)).toEqual(["pkg/x0.py::X0.m", "pkg/x1.py::X1.m", "pkg/x2.py::X2.m"]);
    expect(sim.admittedExtra).toBe(3);
    expect(sim.rows.slice(3).every((r) => r.representation === "skeleton" && r.reason === "upstream_form_delivered")).toBe(true);
    expect(sim.rows.slice(1).every((r, k) => r.cumulativePacketTokens >= sim.rows[k]!.cumulativePacketTokens)).toBe(true);
    expect(sim.stopReason).toBe("OTHER_EXPLICIT_POLICY");
    expect(sim.stopDetail).toContain("pool cap");
    expect(sim.frozenTokens).toBe(Math.ceil(JSON.stringify(sim.packet).length / 4));
  });

  test("a tight ceiling refuses the first extra that does not fit and never reaches the rest; nothing is skipped past", () => {
    const extras = Array.from({ length: 40 }, (_, k) => extra(k));
    const sim = base(1000, extras, 2);
    expect(sim.rejectedExtraForCeiling).toBe(1);
    expect(sim.admittedExtra + sim.rejectedExtraForCeiling + sim.notReachedExtra).toBe(40);
    expect(sim.stopReason).toBe("NEXT_ITEM_TOO_LARGE");
    const rejected = sim.rows.find((r) => !r.fitsCeiling)!;
    // The rejected one is the next in order after the last admitted one: no bin-packing.
    const lastAdmitted = sim.rows.filter((r) => r.origin === "uncapped" && r.fitsCeiling).at(-1)!;
    expect(rejected.discardRank).toBe(lastAdmitted.discardRank! + 1);
    expect(sim.evidencePacketTokens <= orientationCeilingTokens(1000)).toBe(true);
  });

  test("a non-code-bearing body stays relationship-only and an oversized body is head-bounded, never cut further", () => {
    const sim = base(16000, [extra(0, "summary"), extra(1, "focused_source", 200)]);
    const summary = sim.rows.find((r) => r.at === "pkg/x0.py::X0.m")!;
    const big = sim.rows.find((r) => r.at === "pkg/x1.py::X1.m")!;
    expect(summary.representation).toBe("relationship_only");
    expect(summary.reason).toBe("form_not_code_bearing");
    expect(big.representation).toBe("focused_source");
    expect(big.codeCharacters).toBeLessThanOrEqual(ORIENTATION_POLICY.relatedCodeCharacters);
  });

  test("the upstream evidence budget is a separate bound: the ceiling-only figure and the all-bounds figure diverge when it binds", () => {
    const extras = Array.from({ length: 10 }, (_, k) => extra(k, "skeleton", 30));
    const loose = base(16000, extras, 1, { budgetTokens: 16000, renderedCharacters: 3000 });
    const tight = base(16000, extras, 1, { budgetTokens: 760, renderedCharacters: 3000 });
    expect(loose.admittedExtraAllBounds).toBe(10);
    expect(loose.frozenTokensAllBounds).toBe(loose.frozenTokens);
    expect(tight.admittedExtra).toBe(10);
    expect(tight.admittedExtraAllBounds).toBe(0);
    expect(tight.frozenTokensAllBounds).toBeLessThan(tight.frozenTokens);
    expect(tight.stopReason).toBe("OTHER_EXPLICIT_POLICY");
    expect(tight.stopDetail).toContain("bound upstream");
  });

  test("an unresolved identity is counted and never admitted; a stream below the pool cap ends as no truthful supply", () => {
    const sim = simulateUncappedAdmission({
      focus, notes: [], delivered: delivered(1), extras: [{ ...extra(0), identityResolved: false }, extra(1)],
      ceilingTokens: orientationCeilingTokens(16000), relatedBound: 600, upstream: null, capsule: null, serializer,
      pool: { candidateCount: 9, cap: 25 },
    });
    expect(sim.unresolvedExtra).toBe(1);
    expect(sim.admittedExtra).toBe(1);
    expect(sim.stopReason).toBe("NO_TRUTHFUL_SUPPLY");
  });

  test("a count-cap discard whose identity the packet already carries is deduplicated, never delivered twice", () => {
    const dup: UncappedCandidate = { ...extra(5), at: "pkg/d1.py::D1" };
    const sim = base(16000, [extra(0), dup, extra(0)], 3);
    expect(sim.deduplicatedExtra).toBe(2);
    expect(sim.admittedExtra).toBe(1);
    const ids = sim.rows.filter((r) => r.fitsCeiling).map((r) => r.at);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the same inputs give the same rows and the same packet across repeats", () => {
    const extras = Array.from({ length: 12 }, (_, k) => extra(k, k % 2 ? "signature" : "skeleton"));
    const a = base(4000, extras); const b = base(4000, extras);
    expect(JSON.stringify(a.rows)).toBe(JSON.stringify(b.rows));
    expect(JSON.stringify(a.packet)).toBe(JSON.stringify(b.packet));
  });
});

describe("sufficiency", () => {
  test("the required count is the frozen MATCH line in the frozen unit", () => {
    expect(requiredMatchTokens(1000)).toBe(600);
    expect(requiredMatchTokens(16000)).toBe(9600);
  });
  test("a budget is sufficient on the conservative figure, insufficient on the optimistic one, indeterminate between", () => {
    const row = (opt: number[], cons: number[]) => sufficiencyRow({ budget: 1000, rankedPreCap: [20], postCap: [5], currentFrozenTokens: [400], uncappedFrozenTokens: opt, uncappedFrozenTokensAllBounds: cons });
    expect(row([700, 700, 700], [650, 650, 650]).sufficiency).toBe("SUFFICIENT");
    expect(row([500, 500, 500], [400, 400, 400]).sufficiency).toBe("INSUFFICIENT");
    expect(row([700, 700, 700], [500, 500, 500]).sufficiency).toBe("INDETERMINATE");
  });
  test("the verdict needs every frozen budget, and one insufficient budget decides it", () => {
    const rows = [1000, 2000, 4000, 8000, 16000].map((b) => sufficiencyRow({ budget: b, rankedPreCap: [20], postCap: [5], currentFrozenTokens: [b * 0.3], uncappedFrozenTokens: [b * 0.7], uncappedFrozenTokensAllBounds: [b * 0.65] }));
    expect(supplyVerdict(rows)).toBe("A11_SUPPLY_SUFFICIENT");
    const mixed = rows.map((r) => (r.budget === 16000 ? { ...r, sufficiency: "INSUFFICIENT" as const } : r));
    expect(supplyVerdict(mixed)).toBe("A11_SUPPLY_INSUFFICIENT");
    expect(supplyVerdict(rows.slice(0, 4))).toBe("A11_SUPPLY_INDETERMINATE");
  });
});

describe("stop reasons and gates", () => {
  test("the first binding stage from the packet outward names the stop", () => {
    const base = { projectorRejectedForCeiling: 0, tierCapDiscards: 0, evidenceBudgetDropped: 0, evidenceBudgetCompacted: false, tokenBudgetDiscards: 0, laneCeilingDiscards: 0, candidateCount: 9, poolCap: 25 };
    expect(actualStopReason(base).reason).toBe("NO_TRUTHFUL_SUPPLY");
    expect(actualStopReason({ ...base, candidateCount: 25 }).policy).toBe("CANDIDATE_POOL_CAP");
    expect(actualStopReason({ ...base, tierCapDiscards: 3, candidateCount: 25 }).policy).toBe("FIXED_TIER_SUPPORT_CAP");
    expect(actualStopReason({ ...base, tierCapDiscards: 3, projectorRejectedForCeiling: 1 }).reason).toBe("NEXT_ITEM_TOO_LARGE");
    expect(actualStopReason({ ...base, tierCapDiscards: 3, evidenceBudgetDropped: 2 }).policy).toBe("UPSTREAM_EVIDENCE_BUDGET");
  });
  test("a duplicate identity, an unclassified discard or an unexplained stop fails the gates", () => {
    const packet = { focus: { at: "a::b" }, related: [{ at: "c::d" }, { at: "c::d" }] };
    const gates = allocationGates({ packet, utilizationVerdict: "UTILIZATION_INTEGRITY_PASS", discardClasses: ["OTHER"], stop: { reason: "OTHER_EXPLICIT_POLICY", policy: null }, simulation: null });
    expect(gates.find((g) => g.id === "no_duplicate_identity")!.pass).toBe(false);
    expect(gates.find((g) => g.id === "every_discard_classified")!.pass).toBe(false);
    expect(gates.find((g) => g.id === "stop_reason_explained")!.pass).toBe(false);
    const honest = allocationGates({ packet: { focus: { at: "a::b" }, related: [{ at: "c::d" }] }, utilizationVerdict: "UTILIZATION_INTEGRITY_PASS", discardClasses: ["TIER_SUPPORT_CAP"], stop: { reason: "OTHER_EXPLICIT_POLICY", policy: "FIXED_TIER_SUPPORT_CAP" }, simulation: null });
    expect(honest.every((g) => g.pass)).toBe(true);
  });
});
