import { describe, expect, test } from "bun:test";

import { A11_BUDGETS } from "./m204Utilization";
import { requiredMatchTokens } from "./m206Allocation";
import {
  UNCAPPED_WIDTH, candidateAllowance, candidateFate, narrowestSufficientWidth, parseWidths, provenanceOf, retrievalSupplyVerdict,
  roleIdentity, stopAtWidth, tailQuality, widthBudgetSupply, widthLabel, type ExposedCandidate, type ResponseFacts, type WidthBudgetSupply,
} from "./m207RetrievalPool";

const supplyRow = (width: number, budget: number, tokens: number): WidthBudgetSupply => widthBudgetSupply({
  width, budget, frozenTokens: [tokens, tokens, tokens], utilisation: [100 * tokens / budget], candidateCounts: [30], rankedStreams: [38], deliveredItems: [20],
});

describe("widths", () => {
  test("parses numeric widths and the uncapped sentinel, refusing nonsense", () => {
    expect(parseWidths("25,50,uncapped")).toEqual([25, 50, UNCAPPED_WIDTH]);
    expect(widthLabel(UNCAPPED_WIDTH)).toBe("uncapped");
    expect(widthLabel(200)).toBe("200");
    expect(() => parseWidths("25,zero")).toThrow(/M207_BAD_WIDTH/);
    expect(() => parseWidths("0")).toThrow(/M207_BAD_WIDTH/);
  });
});

describe("sufficiency on real packets", () => {
  test("a width is sufficient at a budget exactly when its median frozen tokens reach the frozen MATCH line", () => {
    const line = requiredMatchTokens(8000);
    expect(line).toBe(4800);
    expect(supplyRow(100, 8000, line).sufficiency).toBe("SUFFICIENT");
    expect(supplyRow(100, 8000, line - 1).sufficiency).toBe("INSUFFICIENT");
    expect(widthBudgetSupply({ width: 100, budget: 8000, frozenTokens: [], utilisation: [], candidateCounts: [], rankedStreams: [], deliveredItems: [] }).sufficiency).toBe("INDETERMINATE");
  });

  test("the verdict is taken on the uncapped width and needs every frozen budget", () => {
    const enough = A11_BUDGETS.map((b) => supplyRow(UNCAPPED_WIDTH, b, requiredMatchTokens(b)));
    expect(retrievalSupplyVerdict(enough)).toBe("A11_RETRIEVAL_SUPPLY_SUFFICIENT");
    const short = enough.map((r) => (r.budget === 16000 ? supplyRow(UNCAPPED_WIDTH, 16000, 4000) : r));
    expect(retrievalSupplyVerdict(short)).toBe("A11_RETRIEVAL_SUPPLY_INSUFFICIENT");
    expect(retrievalSupplyVerdict(enough.slice(0, 4))).toBe("A11_RETRIEVAL_SUPPLY_INDETERMINATE");
    // A narrower width being sufficient never decides the verdict; the uncapped width does.
    const narrowerOnly = [...A11_BUDGETS.map((b) => supplyRow(100, b, requiredMatchTokens(b))), ...short];
    expect(retrievalSupplyVerdict(narrowerOnly)).toBe("A11_RETRIEVAL_SUPPLY_INSUFFICIENT");
  });

  test("the narrowest sufficient width is the least swept width sufficient everywhere", () => {
    const rows = [
      ...A11_BUDGETS.map((b) => supplyRow(25, b, b === 1000 ? 900 : 100)),
      ...A11_BUDGETS.map((b) => supplyRow(100, b, requiredMatchTokens(b))),
      ...A11_BUDGETS.map((b) => supplyRow(UNCAPPED_WIDTH, b, requiredMatchTokens(b) + 10)),
    ];
    expect(narrowestSufficientWidth(rows)).toBe(100);
    expect(narrowestSufficientWidth(rows.filter((r) => r.width === 25))).toBeNull();
  });
});

describe("tail quality", () => {
  const exposed = (fqName: string, fate: ExposedCandidate["fate"], delivered: boolean, representation: string | null, score: number): ExposedCandidate => ({
    rank: 30, symbolId: fqName, path: "a.ts", fqName, symbol: fqName, finalScore: score, sources: ["lexical"], evidence: ["lexical match on name"],
    task: "t", budget: 16000, width: 100, fate, delivered, representation, provenance: "lexical",
  });

  test("fates: pivot, delivered support, packed-but-not-projected, discarded, role-discarded", () => {
    const ctx = { pivotFqNames: new Set(["p"]), supportFqNames: new Set(["s1", "s2"]), discardedRoleFqNames: new Set(["t"]), relatedIds: new Set(["s1"]), focusAt: "p" };
    expect(candidateFate({ fqName: "p", ...ctx })).toEqual({ fate: "pivot", delivered: true });
    expect(candidateFate({ fqName: "s1", ...ctx })).toEqual({ fate: "support_delivered", delivered: true });
    expect(candidateFate({ fqName: "s2", ...ctx })).toEqual({ fate: "support_packed_not_projected", delivered: false });
    expect(candidateFate({ fqName: "t", ...ctx })).toEqual({ fate: "role_discarded", delivered: false });
    expect(candidateFate({ fqName: "x", ...ctx })).toEqual({ fate: "support_discarded", delivered: false });
  });

  test("provenance follows the strongest generator present", () => {
    expect(provenanceOf(["lexical", "graph"], ["lexical match on name"])).toBe("lexical");
    expect(provenanceOf(["graph"], [])).toBe("graph_neighbour");
    expect(provenanceOf(["same_module"], [])).toBe("same_module");
    expect(provenanceOf(["test_to_impl", "lexical"], [])).toBe("test_routed");
    expect(provenanceOf([], [])).toBe("unsourced");
  });

  test("fractions separate truthful delivered supply from downstream rejection", () => {
    const q = tailQuality({ width: 100, budget: 16000, exposed: [
      exposed("a", "support_delivered", true, "skeleton", 0.5),
      exposed("b", "support_delivered", true, "relationship_only", 0.4),
      exposed("c", "support_discarded", false, null, 0.1),
      exposed("d", "role_discarded", false, null, 0.0),
    ], baselineScores: [1.0, 0.9], duplicates: 1 });
    expect(q.exposed).toBe(4);
    expect(q.deliveredFraction).toBe(0.5);
    expect(q.rejectedDownstreamFraction).toBe(0.5);
    expect(q.sourceBackedFraction).toBe(0.5);
    expect(q.relationshipOnlyFraction).toBe(0.5);
    expect(q.duplicateRate).toBe(0.2);
    expect(q.scoreDistribution?.max).toBe(0.5);
    expect(q.baselineScoreDistribution?.min).toBe(0.9);
    expect(q.fates).toEqual({ support_delivered: 2, support_discarded: 1, role_discarded: 1 });
  });
});

describe("role identity", () => {
  const facts = (pivots: string[], support: string[], focus: string): ResponseFacts => ({
    task: "t", budget: 8000, width: 25, candidateCount: 25, rankedStream: 30, roleDiscards: 2, pivotFqNames: pivots, supportFqNames: support,
    discardClasses: {}, focusAt: focus, relatedIds: [], frozenWholeTokens: 1, utilisationPercent: 1, deliveredItems: 1, stop: { reason: "NO_TRUTHFUL_SUPPLY", policy: null },
  });
  test("counts preserved pivot sets, leads and focus; a lost pivot is starvation", () => {
    const r = roleIdentity({ width: 100, budget: 8000, pairs: [
      { base: facts(["p1", "p2"], ["s"], "p1"), at: facts(["p1", "p2"], ["s", "s2", "s3"], "p1") },
      { base: facts(["p1"], ["s"], "p1"), at: facts(["p9"], ["s"], "p9") },
    ] });
    expect(r.samePivotSet).toBe(1);
    expect(r.sameLeadPivot).toBe(1);
    expect(r.sameFocus).toBe(1);
    expect(r.starvedPivots).toBe(1);
    expect(r.supportCountDelta).toEqual({ min: 0, max: 2, median: 1 });
  });
});

describe("stop reason at a width", () => {
  const base = { projectorRejectedForCeiling: 0, evidenceBudgetDropped: 0, evidenceBudgetCompacted: false, discardClasses: {} };
  test("a capped width whose pool is full stops on the pool; the uncapped width never does", () => {
    expect(stopAtWidth({ ...base, candidateCount: 25, width: 25 }).policy).toBe("CANDIDATE_POOL_CAP");
    expect(stopAtWidth({ ...base, candidateCount: 25, width: 50 }).reason).toBe("NO_TRUTHFUL_SUPPLY");
    expect(stopAtWidth({ ...base, candidateCount: 140, width: UNCAPPED_WIDTH }).reason).toBe("NO_TRUTHFUL_SUPPLY");
  });
  test("downstream bounds take precedence over the pool", () => {
    expect(stopAtWidth({ ...base, evidenceBudgetDropped: 3, candidateCount: 25, width: 25 }).policy).toBe("UPSTREAM_EVIDENCE_BUDGET");
    expect(stopAtWidth({ ...base, discardClasses: { TOKEN_BUDGET: 2 }, candidateCount: 25, width: 25 }).policy).toBe("CAPSULE_TOKEN_BUDGET");
    expect(stopAtWidth({ ...base, projectorRejectedForCeiling: 1, candidateCount: 25, width: 25 }).reason).toBe("NEXT_ITEM_TOO_LARGE");
  });
});

describe("candidate allowance", () => {
  test("grows with the budget at the measured per-candidate cost, floored and capped, never rung-specific", () => {
    const rule = (maxTokens: number) => candidateAllowance({ maxTokens, tokensPerDeliveredCandidate: 100, floor: 25, hardMaximum: 400 });
    expect(rule(1000)).toBe(25);
    expect(rule(2000)).toBe(25);
    expect(rule(2600)).toBe(26);
    expect(rule(8000)).toBe(80);
    expect(rule(16000)).toBe(160);
    expect(rule(100000)).toBe(400);
    expect(rule(0)).toBe(25);
    expect(rule(Number.NaN)).toBe(25);
    const budgets = [1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 16000, 20000];
    const values = budgets.map(rule);
    for (let i = 1; i < values.length; i += 1) expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
  });
});
