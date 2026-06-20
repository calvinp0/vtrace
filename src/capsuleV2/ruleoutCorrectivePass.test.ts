import assert from "node:assert/strict";
import { test } from "bun:test";

import type { RuleOutSufficiencyCheck } from "./ruleoutSufficiency";
import {
  buildRuleOutCorrectiveResult,
  buildRuleOutCorrectiveSecondPassPrompt,
  decideRuleOutCorrectivePass,
  hasRuleOutCorrectiveForbiddenLeakage,
} from "./ruleoutCorrectivePass";

const PATCH = [
  "diff --git a/sphinx/domains/python.py b/sphinx/domains/python.py",
  "--- a/sphinx/domains/python.py",
  "+++ b/sphinx/domains/python.py",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

function checker(overrides: Partial<RuleOutSufficiencyCheck> = {}): RuleOutSufficiencyCheck {
  return {
    enabled: true,
    triggered: true,
    oracleFree: true,
    evidence: [],
    missingEvidence: ["output-preserving evidence"],
    correctivePromptWritten: true,
    canonicalReplaced: false,
    adoptionEligible: false,
    ruledOutImplementation: "sphinx/pycode/ast.py::unparse",
    ...overrides,
  };
}

test("corrective pass stays off unless its separate flag is enabled", () => {
  const decision = decideRuleOutCorrectivePass({
    enabled: false,
    checker: checker(),
    checkerArtifactText: "{}",
    correctivePrompt: "Revise the paired implementation.",
    firstPassPatch: PATCH,
  });
  assert.equal(decision.run, false);
  assert.match(decision.reason, /flag off/);
});

test("corrective pass schedules only for a triggered checker, safe prompt, and patch", () => {
  const decision = decideRuleOutCorrectivePass({
    enabled: true,
    checker: checker(),
    checkerArtifactText: JSON.stringify(checker()),
    correctivePrompt: "Revise the paired implementation using repository evidence.",
    firstPassPatch: PATCH,
  });
  assert.equal(decision.run, true);
  assert.equal(decision.correctivePromptSafe, true);
  assert.equal(decision.forbiddenLeakageDetected, false);
});

test("non-triggered, missing, and invalid checker inputs fail closed", () => {
  for (const input of [
    { checker: null, prompt: "safe", patch: PATCH },
    { checker: checker({ triggered: false }), prompt: "safe", patch: PATCH },
    { checker: checker({ correctivePromptWritten: false }), prompt: "", patch: PATCH },
    { checker: checker(), prompt: "safe", patch: "" },
  ]) {
    assert.equal(decideRuleOutCorrectivePass({
      enabled: true,
      checker: input.checker,
      checkerArtifactText: input.checker === null ? "" : JSON.stringify(input.checker),
      correctivePrompt: input.prompt,
      firstPassPatch: input.patch,
    }).run, false);
  }
});

test("forbidden leakage in checker or prompt prevents scheduling", () => {
  for (const text of [
    "FAIL_TO_PASS",
    "PASS_TO_PASS",
    "test_unparse[()-()]",
    "gold patch",
    "hidden test",
    "resolved=true",
    "benchmark expected output",
  ]) {
    assert.equal(hasRuleOutCorrectiveForbiddenLeakage(text), true);
    const decision = decideRuleOutCorrectivePass({
      enabled: true,
      checker: checker(),
      checkerArtifactText: "{}",
      correctivePrompt: text,
      firstPassPatch: PATCH,
    });
    assert.equal(decision.run, false);
    assert.equal(decision.forbiddenLeakageDetected, true);
  }
});

test("second-pass prompt contains the safe finding and complete first-pass patch", () => {
  const prompt = buildRuleOutCorrectiveSecondPassPrompt({
    correctivePrompt: "Inspect the paired implementation and revise if source evidence requires it.",
    firstPassPatch: PATCH,
  });
  assert.match(prompt, /revised patch candidate/);
  assert.match(prompt, /repository-visible source/);
  assert.match(prompt, /sphinx\/domains\/python\.py/);
  assert.equal(hasRuleOutCorrectiveForbiddenLeakage(prompt), false);
});

test("candidate result records changed files and never permits adoption", () => {
  const revised = `${PATCH}\n\ndiff --git a/sphinx/pycode/ast.py b/sphinx/pycode/ast.py\n--- a/sphinx/pycode/ast.py\n+++ b/sphinx/pycode/ast.py\n@@ -1 +1 @@\n-old\n+new\n`;
  const decision = decideRuleOutCorrectivePass({
    enabled: true,
    checker: checker(),
    checkerArtifactText: "{}",
    correctivePrompt: "safe corrective prompt",
    firstPassPatch: PATCH,
  });
  const result = buildRuleOutCorrectiveResult({
    enabled: true,
    checker: checker(),
    decision,
    modelCallExecuted: true,
    revisedPatch: revised,
    revisedPatchPath: "_ruleout_sufficiency_revised.patch",
    firstPassPatch: PATCH,
    canonicalResultsFileShaBefore: "same",
    canonicalResultsFileShaAfter: "same",
  });
  assert.equal(result.revisedPatchProduced, true);
  assert.deepEqual(result.revisedPatchChangedFiles, [
    "sphinx/domains/python.py",
    "sphinx/pycode/ast.py",
  ]);
  assert.equal(result.revisedPatchEditsRuledOutImplementation, true);
  assert.equal(result.canonicalReplaced, false);
  assert.equal(result.adoptionEligible, false);
  assert.equal(result.canonicalPatchUnchanged, true);
});

test("response leakage withholds the revised candidate", () => {
  const decision = decideRuleOutCorrectivePass({
    enabled: true,
    checker: checker(),
    checkerArtifactText: "{}",
    correctivePrompt: "safe corrective prompt",
    firstPassPatch: PATCH,
  });
  const result = buildRuleOutCorrectiveResult({
    enabled: true,
    checker: checker(),
    decision,
    modelCallExecuted: true,
    revisedPatch: PATCH,
    firstPassPatch: PATCH,
    responseLeakageDetected: true,
    canonicalResultsFileShaBefore: "same",
    canonicalResultsFileShaAfter: "same",
  });
  assert.equal(result.forbiddenLeakageDetected, true);
  assert.equal(result.revisedPatchProduced, false);
  assert.equal(result.revisedPatchPath, undefined);
});
