/**
 * The utilisation analyzer is only trustworthy if it reproduces the frozen A11
 * rule byte for byte and refuses the ways utilisation could be faked.
 */
import { describe, expect, test } from "bun:test";

import { orientationAccountingOf } from "../../src/runPipeline/orientationAccounting";
import {
  ORIENTATION_FROZEN_PHRASES, ORIENTATION_POLICY, orientationCeilingTokens, projectRunPipelineOrientation,
} from "../../src/runPipeline/orientationProjection";
import {
  analyzeUtilization, effectiveBudgetMonotonic, frozenA11Verdict, frozenUtilisationPercent,
  frozenWholeResponseTokens, orderRelation,
} from "./m204Utilization";

function authoritative(count: number, requested: number, bodyChars = 300): Record<string, unknown> {
  const items = Array.from({ length: count + 1 }, (_, index) => ({
    id: `i${index}`,
    fqName: index === 0 ? "pkg/focus.py::Focus.run" : `pkg/mod${index}.py::Sym${index}.method`,
    path: index === 0 ? "pkg/focus.py" : `pkg/mod${index}.py`,
    lineSpan: { start: index * 10 + 1, end: index * 10 + 9 },
    contentMode: "focused_source",
    roles: index === 0 ? ["pivot"] : ["support"],
    selectionReasons: [index === 0 ? "lead pivot for this task" : `direct caller ${index}`],
    estimatedTokens: 75 + index,
  }));
  return {
    diagnostics: { freshness: { readiness: { ready: true } } },
    pivotNeighborhood: [],
    responseBudget: { requested_context_tokens: requested },
    productContext: {
      resolved: true, retrievalFound: true, deliveryFailed: false,
      leadPivot: "pkg/focus.py::Focus.run", items,
      modelVisibleContext: items
        .map((item) => `\n## [${item.id}]\nroles: ${item.roles.join(",")}\n\n${"x".repeat(bodyChars)}`).join("\n"),
      freshness: { status: "fresh", reason: "" },
      delivery: { status: "complete", selectedItemsBeforeBudget: count + 1, deliveredItems: count + 1,
        droppedForBudget: 0, finalModelTokens: 900, compactionStages: [] },
      accounting: { budgetTokens: requested, usedTokensEstimate: 900, remainingTokensEstimate: requested - 900 },
    },
  };
}

const analyze = (count: number, requested: number, mutate?: (packet: any, ledger: any) => void) => {
  const packet: any = projectRunPipelineOrientation(authoritative(count, requested));
  const ledger: any = JSON.parse(JSON.stringify(orientationAccountingOf(packet)));
  const copy = JSON.parse(JSON.stringify(packet));
  mutate?.(copy, ledger);
  return analyzeUtilization({ budget: requested, packet: copy, ledger, expectedCeilingTokens: orientationCeilingTokens(requested),
    headBoundCharacters: ORIENTATION_POLICY.focusCodeCharacters, frozenPhrases: ORIENTATION_FROZEN_PHRASES });
};

describe("the frozen A11 rule, verbatim", () => {
  test("numerator is ceil(chars/4) of the whole output; the figure is toFixed(2)", () => {
    const out = { focus: { at: "a" }, related: [] };
    expect(frozenWholeResponseTokens(out)).toBe(Math.ceil(JSON.stringify(out).length / 4));
    expect(frozenUtilisationPercent(out, 1000)).toBe(+(100 * Math.ceil(JSON.stringify(out).length / 4) / 1000).toFixed(2));
    expect(frozenWholeResponseTokens(undefined)).toBe(1);
  });

  test("the band is MATCHES at >= 60 on EVERY budget, EXCEEDS at >= 80, else BELOW", () => {
    expect(frozenA11Verdict([60, 60, 60, 60, 60])).toBe("VTRACE_MATCHES_VEXP_CLAIM");
    expect(frozenA11Verdict([80, 90, 80, 80, 80])).toBe("VTRACE_EXCEEDS_VEXP_CLAIM");
    expect(frozenA11Verdict([100, 100, 100, 100, 59.99])).toBe("VTRACE_BELOW_VEXP_CLAIM");
    expect(frozenA11Verdict([40.55, 34.05, 17.02, 9.34, 7.54])).toBe("VTRACE_BELOW_VEXP_CLAIM");
    expect(frozenA11Verdict([60, null, 60, 60, 60])).toBeNull();
  });
});

describe("the analyzer classifies mechanically", () => {
  test("a supply-exhausted packet is NO_ELIGIBLE_EVIDENCE with unused budget, and passes", () => {
    const a = analyze(4, 16000);
    expect(a.verdict).toBe("UTILIZATION_INTEGRITY_PASS");
    expect(a.bindingReason).toBe("NO_ELIGIBLE_EVIDENCE");
    expect(a.supplyExhausted).toBe(true);
    expect(a.unused.frozenBudgetTokens).toBeGreaterThan(0);
    expect(a.supply.eligible).toBe(5);
    expect(a.supply.admitted).toBe(5);
  });

  test("a ceiling-bound packet is ORIENTATION_CEILING and states what was not reached", () => {
    const a = analyze(300, 1000);
    expect(a.verdict).toBe("UTILIZATION_INTEGRITY_PASS");
    expect(a.bindingReason).toBe("ORIENTATION_CEILING");
    expect(a.supply.rejectedForCeiling).toBe(1);
    expect(a.supply.notReached).toBeGreaterThan(0);
    expect(a.supply.remainingUsefulCandidateTokensEstimate).toBeGreaterThan(0);
    expect(a.effectiveCeilingTokens).toBe(orientationCeilingTokens(1000));
  });

  test("a duplicated item fails no_duplicate_admission", () => {
    const a = analyze(4, 16000, (packet) => { packet.related.push({ ...packet.related[0] }); });
    expect(a.verdict).toBe("UTILIZATION_INTEGRITY_FAIL");
    expect(a.gates.find((g) => g.id === "no_duplicate_admission")!.pass).toBe(false);
  });

  test("an item with no traceable authoritative claim fails no_filler", () => {
    const a = analyze(4, 16000, (packet, ledger) => {
      packet.related.push({ at: "pkg/x.py::filler", file: "pkg/x.py", lines: null, how: "probably relevant", tokens: 30 });
      ledger.items.push({ ...ledger.items[1], at: "pkg/x.py::filler", ordinal: 5, origin: "item_supply", sourceId: "unavailable", reason: "probably relevant" });
    });
    expect(a.verdict).toBe("UTILIZATION_INTEGRITY_FAIL");
    expect(a.gates.find((g) => g.id === "no_filler")!.pass).toBe(false);
  });

  test("a ceiling that is not the rule's fails ceiling_is_the_rule", () => {
    const a = analyze(4, 16000, (_packet, ledger) => { ledger.ceilingTokens = 99_999; });
    expect(a.gates.find((g) => g.id === "ceiling_is_the_rule")!.pass).toBe(false);
  });

  test("order relations and effective-budget monotonicity are decided, not inferred", () => {
    expect(orderRelation(["a", "b"], ["a", "b", "c"])).toBe("prefix");
    expect(orderRelation(["a", "c"], ["a", "b", "c"])).toBe("subsequence");
    expect(orderRelation(["c", "a"], ["a", "b", "c"])).toBe("neither");
    expect(effectiveBudgetMonotonic([{ budget: 1000, effective: 1270 }, { budget: 2000, effective: 2540 }]).monotonic).toBe(true);
    expect(effectiveBudgetMonotonic([{ budget: 1000, effective: 2000 }, { budget: 2000, effective: 1500 }]).violations).toHaveLength(1);
  });
});
