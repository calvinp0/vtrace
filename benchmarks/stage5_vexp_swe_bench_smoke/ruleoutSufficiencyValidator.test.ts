import { describe, expect, test } from "bun:test";

import {
  assertCorrectivePromptSafe,
  buildCorrectivePromptPreview,
  evaluateRuleOutSufficiency,
  hasConcreteOutputEvidence,
  type RuleOutSufficiencyInput,
} from "./ruleoutSufficiencyValidator";

const BASE: RuleOutSufficiencyInput = {
  label: "fixture",
  instance: "fixture",
  semanticGroups: [{ name: "unparse", targets: ["a.py::unparse", "b.py::unparse"] }],
  patch: "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-old\n+new\n",
  surfacedTargets: ["a.py::unparse", "b.py::unparse"],
  inspectedPaths: ["b.py"],
  assistantText: "Ruled out b.py::unparse: join([]) is safe and returns empty string, so okay. No fix needed.",
};

describe("rule-out sufficiency validator", () => {
  test("fires on synthetic same-operation crash-shaped rule-out", () => {
    expect(evaluateRuleOutSufficiency(BASE).fired).toBe(true);
  });

  test("does not fire when paired implementation is edited", () => {
    const patch = `${BASE.patch}diff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-old\n+new\n`;
    expect(evaluateRuleOutSufficiency({ ...BASE, patch }).fired).toBe(false);
  });

  test("does not fire without same-operation pair", () => {
    expect(evaluateRuleOutSufficiency({ ...BASE, semanticGroups: [] }).fired).toBe(false);
  });

  test("does not fire when rule-out provides output-preserving evidence", () => {
    const assistantText = "Ruled out b.py::unparse: it is safe. The caller expects empty string and the repository docstring documents it as desired.";
    expect(evaluateRuleOutSufficiency({ ...BASE, assistantText }).fired).toBe(false);
  });

  test("does not treat no-crash reasoning as output-preserving evidence", () => {
    expect(hasConcreteOutputEvidence("It does not crash; join returns empty string, so okay.")).toBe(false);
  });

  test("corrective prompt preview contains no hidden-test or gold labels", () => {
    const prompt = buildCorrectivePromptPreview("unparse", "a.py::unparse", "b.py::unparse");
    expect(() => assertCorrectivePromptSafe(prompt)).not.toThrow();
    expect(prompt).not.toMatch(/FAIL_TO_PASS|PASS_TO_PASS|gold patch|hidden test|test_unparse/i);
  });

  test("leakage check stays false when inputs are non-oracle", () => {
    expect(evaluateRuleOutSufficiency(BASE).leakageCheck).toEqual({
      usedGold: false,
      usedFailToPass: false,
      usedPassToPass: false,
      usedBenchmarkLabel: false,
    });
  });

  test("handles missing artifacts gracefully", () => {
    const result = evaluateRuleOutSufficiency({ ...BASE, patch: "" });
    expect(result.decision).toBe("insufficient_artifact");
    expect(result.missingEvidence).toContain("first-pass patch");
  });

  test("sphinx-like fixture fires", () => {
    const result = evaluateRuleOutSufficiency({
      ...BASE,
      semanticGroups: [{
        name: "unparse",
        targets: ["sphinx/domains/python.py::unparse", "sphinx/pycode/ast.py::unparse"],
      }],
      patch: "diff --git a/sphinx/domains/python.py b/sphinx/domains/python.py\n--- a/sphinx/domains/python.py\n+++ b/sphinx/domains/python.py\n",
      surfacedTargets: ["sphinx/pycode/ast.py::unparse"],
      inspectedPaths: ["sphinx/pycode/ast.py"],
      assistantText: 'Ruled out sphinx/pycode/ast.py::unparse because ", ".join() safely handles empty iterables. No fix needed.',
    });
    expect(result.fired).toBe(true);
  });

  test("negative fixtures do not fire", () => {
    const cases: RuleOutSufficiencyInput[] = [
      { ...BASE, semanticGroups: [{ name: "helper", targets: ["a.py::helper", "b.py::helper"] }] },
      { ...BASE, surfacedTargets: [], inspectedPaths: [], assistantText: "No rule-out." },
      { ...BASE, assistantText: "Ruled out b.py::unparse because the caller expects empty string." },
    ];
    expect(cases.map((input) => evaluateRuleOutSufficiency(input).fired)).toEqual([false, false, false]);
  });
});
