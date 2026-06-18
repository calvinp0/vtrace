import { describe, expect, test } from "bun:test";

import {
  applyRuleOutSufficiencyToCompliance,
  assertRuleOutCorrectivePromptSafe,
  buildRuleOutCorrectivePrompt,
  evaluateRuleOutSufficiency,
  hasOutputPreservingEvidence,
  type RuleOutSufficiencyInput,
} from "./ruleoutSufficiency";

const BASE: RuleOutSufficiencyInput = {
  enabled: true,
  semanticGroups: [{ name: "unparse", targets: ["a.py::unparse", "b.py::unparse"] }],
  patch: "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-old\n+new\n",
  surfacedTargets: ["a.py::unparse", "b.py::unparse"],
  inspectedPaths: ["b.py"],
  assistantText:
    "Ruled out b.py::unparse: join([]) is safe and returns empty string, so okay. No fix needed.",
};

describe("rule-out sufficiency checker", () => {
  test("flag disabled preserves no-trigger behavior", () => {
    expect(evaluateRuleOutSufficiency({ ...BASE, enabled: false })).toEqual({
      enabled: false,
      triggered: false,
      oracleFree: true,
      evidence: [],
      missingEvidence: [],
      canonicalReplaced: false,
      adoptionEligible: false,
    });
  });

  test("flag enabled fires on a sphinx-like paired rule-out", () => {
    const result = evaluateRuleOutSufficiency(BASE);
    expect(result.triggered).toBe(true);
    expect(result.triggerKind).toBe(
      "cross_implementation_output_ruleout_insufficient",
    );
  });

  test("does not fire when the paired implementation is edited", () => {
    const patch =
      `${BASE.patch}diff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-old\n+new\n`;
    expect(evaluateRuleOutSufficiency({ ...BASE, patch }).triggered).toBe(false);
  });

  test("does not fire without a same-operation semantic hypothesis", () => {
    expect(
      evaluateRuleOutSufficiency({ ...BASE, semanticGroups: [] }).triggered,
    ).toBe(false);
  });

  test("does not fire without rule-out text or a decision", () => {
    expect(
      evaluateRuleOutSufficiency({ ...BASE, assistantText: "", pivotDecisions: [] })
        .triggered,
    ).toBe(false);
  });

  test("does not fire when output-preserving evidence exists", () => {
    const assistantText =
      "Ruled out b.py::unparse: it is safe. The caller expects empty string and the repository docstring documents the desired output.";
    expect(
      evaluateRuleOutSufficiency({ ...BASE, assistantText }).triggered,
    ).toBe(false);
  });

  test("no-crash reasoning is not output-preserving evidence", () => {
    expect(
      hasOutputPreservingEvidence(
        "It does not crash; join returns empty string, so okay.",
      ),
    ).toBe(false);
  });

  test("corrective prompt contains no forbidden evaluator language", () => {
    const prompt = buildRuleOutCorrectivePrompt(
      "unparse",
      "a.py::unparse",
      "b.py::unparse",
    );
    expect(() => assertRuleOutCorrectivePromptSafe(prompt)).not.toThrow();
    expect(prompt).not.toMatch(
      /FAIL_TO_PASS|PASS_TO_PASS|gold patch|hidden test|expected benchmark output|resolved status|test_unparse/i,
    );
  });

  test("metadata preserves original and effective decisions", () => {
    const result = evaluateRuleOutSufficiency(BASE);
    expect(result.originalDecision).toBe("ruledOut");
    expect(result.effectiveDecision).toBe("unclear");
  });

  test("trigger reclassifies the original compliance decision as unclear", () => {
    const check = evaluateRuleOutSufficiency(BASE);
    const compliance = applyRuleOutSufficiencyToCompliance({
      enabled: true,
      required: [{ path: "b.py", symbol: "unparse", role: "non_lead_pivot" }],
      edited: ["a.py::unparse"],
      ruledOut: ["b.py::unparse"],
      missing: [],
      unclear: [],
      ruleOutConflicts: [],
      correctivePromptSent: false,
    }, check);
    expect(compliance.ruledOut).toEqual([]);
    expect(compliance.unclear).toEqual(["b.py::unparse"]);
    expect(compliance.correctivePromptSent).toBe(true);
  });

  test("canonical replacement is always false", () => {
    expect(evaluateRuleOutSufficiency(BASE).canonicalReplaced).toBe(false);
    expect(
      evaluateRuleOutSufficiency({ ...BASE, enabled: false }).canonicalReplaced,
    ).toBe(false);
  });

  test("adoption is ineligible by default", () => {
    expect(evaluateRuleOutSufficiency(BASE).adoptionEligible).toBe(false);
  });

  test("negative fixtures do not fire", () => {
    const fixtures: RuleOutSufficiencyInput[] = [
      {
        ...BASE,
        semanticGroups: [{ name: "helper", targets: ["a.py::helper", "b.py::helper"] }],
      },
      { ...BASE, surfacedTargets: [], inspectedPaths: [] },
      {
        ...BASE,
        assistantText:
          "Ruled out b.py::unparse because the caller expects empty string.",
      },
    ];
    expect(fixtures.map((fixture) => evaluateRuleOutSufficiency(fixture).triggered))
      .toEqual([false, false, false]);
  });

  test("missing artifacts are handled gracefully", () => {
    const result = evaluateRuleOutSufficiency({ ...BASE, patch: "" });
    expect(result.triggered).toBe(false);
    expect(result.missingEvidence).toContain("first-pass patch");
  });
});
