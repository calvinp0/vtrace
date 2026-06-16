// Tests for the M14 corrective pivot-revision pass (planning + prompt + record).
//
// Pure-function tests over `decideRevisionPass`, `buildRevisionPrompt`,
// `decideReplacement`, and the record helpers. They pin the activation gates (both
// flags + injected v2 + model patch + non-compliant verdict), the no-run cases
// (compliant / no model patch), the revision prompt shape (current patch, only
// missing/unclear candidates, anti-over-edit wording), the separate-artifact layout,
// and the conservative replacement rule. No fs, no spawn, no model.

import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  buildPivotInspectionContract,
  type ContractPivotView,
} from "./pivotInspectionContract";
import { computePivotInspectionCompliance } from "./pivotInspectionCompliance";
import {
  decideRevisionPass,
  buildRevisionPrompt,
  decideReplacement,
  outstandingCount,
  noRunRecord,
  REVISION_ARTIFACT_FILES,
} from "./pivotRevisionPass";

function pv(filePath: string, symbol: string): ContractPivotView {
  return { path: filePath, symbol };
}

// A 2-pivot contract: lead + one non-lead pivot (`a/other.py`).
function contract() {
  return buildPivotInspectionContract([pv("a/lead.py", "lead"), pv("a/other.py", "other")], []);
}

// Verdict where the non-lead pivot is outstanding (unclear: inspected, not edited).
function nonCompliant() {
  return computePivotInspectionCompliance({
    enabled: true,
    contract: contract(),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["a/other.py"],
  });
}

// Verdict where every required candidate is edited (compliant).
function compliant() {
  return computePivotInspectionCompliance({
    enabled: true,
    contract: contract(),
    editedFiles: ["a/lead.py", "a/other.py"],
    inspectedFiles: [],
  });
}

const PATCH = "diff --git a/a/lead.py b/a/lead.py\n@@ -1 +1 @@\n-old\n+new\n";

function baseDecisionInput() {
  return {
    revisionPassEnabled: true,
    enforcementEnabled: true,
    capsuleV2Injected: true,
    hasModelPatch: true,
    complianceBefore: nonCompliant(),
  };
}

// 1 — revision pass does not run unless BOTH flags are enabled.
test("revision pass requires both --pivot-revision-pass and --pivot-inspection-enforcement", () => {
  assert.equal(decideRevisionPass({ ...baseDecisionInput(), revisionPassEnabled: false }).run, false);
  assert.equal(decideRevisionPass({ ...baseDecisionInput(), enforcementEnabled: false }).run, false);
  assert.equal(decideRevisionPass(baseDecisionInput()).run, true);
});

// also: not for baseline / no_context skip / v1 (no Capsule v2 injected).
test("revision pass does not run without injected Capsule v2 context", () => {
  const d = decideRevisionPass({ ...baseDecisionInput(), capsuleV2Injected: false });
  assert.equal(d.run, false);
  assert.match(d.reason, /Capsule v2/);
});

// 2 — revision pass does not run for a compliant patch.
test("revision pass does not run for a compliant patch", () => {
  const d = decideRevisionPass({ ...baseDecisionInput(), complianceBefore: compliant() });
  assert.equal(d.run, false);
  assert.match(d.reason, /compliant/);
});

// single-pivot / no-coedit: no required candidates ⇒ no run.
test("revision pass does not run when there are no required candidates", () => {
  const single = computePivotInspectionCompliance({
    enabled: true,
    contract: buildPivotInspectionContract([pv("a/lead.py", "lead")], []),
    editedFiles: ["a/lead.py"],
    inspectedFiles: [],
  });
  const d = decideRevisionPass({ ...baseDecisionInput(), complianceBefore: single });
  assert.equal(d.run, false);
  assert.match(d.reason, /no required/);
});

// 3 — revision pass DOES run for a missing/unclear candidate.
test("revision pass runs for a missing/unclear candidate", () => {
  const d = decideRevisionPass(baseDecisionInput());
  assert.equal(d.run, true);
  assert.match(d.reason, /missing\/unclear/);
});

// 9 — no model patch is handled gracefully (no run).
test("revision pass does not run when there is no model patch", () => {
  const d = decideRevisionPass({ ...baseDecisionInput(), hasModelPatch: false });
  assert.equal(d.run, false);
  assert.match(d.reason, /no model patch/);
});

// 4 — revision prompt includes the current patch.
test("revision prompt includes the current patch", () => {
  const prompt = buildRevisionPrompt({ complianceBefore: nonCompliant(), currentPatch: PATCH });
  assert.match(prompt, /You previously produced this patch:/);
  assert.match(prompt, /diff --git a\/a\/lead\.py/);
});

// 5 — revision prompt includes only missing/unclear candidates (never edited ones).
test("revision prompt lists only outstanding candidates, never edited ones", () => {
  const c = computePivotInspectionCompliance({
    enabled: true,
    contract: buildPivotInspectionContract(
      [pv("a/lead.py", "lead"), pv("a/edited.py", "e"), pv("a/out.py", "o")],
      [],
    ),
    editedFiles: ["a/lead.py", "a/edited.py"],
    inspectedFiles: ["a/out.py"],
  });
  const prompt = buildRevisionPrompt({ complianceBefore: c, currentPatch: PATCH });
  assert.match(prompt, /a\/out\.py::o/);
  assert.doesNotMatch(prompt, /a\/edited\.py/);
});

// 6 — revision prompt carries anti-over-edit / minimal-diff wording.
test("revision prompt carries anti-over-edit and minimal-diff guardrails", () => {
  const prompt = buildRevisionPrompt({ complianceBefore: nonCompliant(), currentPatch: PATCH });
  assert.match(prompt, /Do not edit a file merely because it is listed/);
  assert.match(prompt, /Prefer the minimal final diff/);
  assert.match(prompt, /Preserve already-correct changes/);
  assert.match(prompt, /Return a unified diff only/);
  assert.doesNotMatch(prompt, /edit all pivots/i);
});

// bounded source excerpts are included when provided.
test("revision prompt includes provided source excerpts", () => {
  const prompt = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    sourceExcerpts: [{ path: "a/other.py", excerpt: "def other():\n    return forward(value)" }],
  });
  assert.match(prompt, /Source excerpts for the outstanding candidates/);
  assert.match(prompt, /def other\(\)/);
});

// 7 — revised patch is persisted SEPARATELY (distinct artifact files + record fields).
test("artifact layout keeps original and revised patches in separate files", () => {
  assert.notEqual(REVISION_ARTIFACT_FILES.originalPatch, REVISION_ARTIFACT_FILES.revisedPatch);
  const files = new Set(Object.values(REVISION_ARTIFACT_FILES));
  assert.equal(files.size, Object.keys(REVISION_ARTIFACT_FILES).length); // all distinct
  // All artifact files are "_"-prefixed so they are never picked up as a canonical JSONL.
  for (const f of files) assert.ok(f.startsWith("_"), `${f} must be _-prefixed`);
});

// 8 — original patch is preserved (no-run record + replacement rule).
test("no-run record preserves the original patch and does not replace", () => {
  const rec = noRunRecord("patch already compliant", PATCH, compliant());
  assert.equal(rec.ran, false);
  assert.equal(rec.originalPatch, PATCH);
  assert.equal(rec.revisedPatch, null);
  assert.equal(rec.replacedFinalPatch, false);
});

// replacement is conservative: only when the revised patch strictly improves compliance.
test("decideReplacement replaces only on a strict compliance improvement with a real diff", () => {
  const before = nonCompliant();              // 1 outstanding
  const afterImproved = compliant();          // 0 outstanding
  const revised = "diff --git a/a/other.py b/a/other.py\n@@ -1 +1 @@\n-x\n+y\n";

  assert.equal(decideReplacement(before, afterImproved, revised), true);
  // no improvement ⇒ keep original
  assert.equal(decideReplacement(before, before, revised), false);
  // improvement but empty/no-diff ⇒ keep original
  assert.equal(decideReplacement(before, afterImproved, ""), false);
  assert.equal(decideReplacement(before, afterImproved, null), false);
  // no after verdict ⇒ keep original
  assert.equal(decideReplacement(before, null, revised), false);
  assert.equal(outstandingCount(before), 1);
  assert.equal(outstandingCount(afterImproved), 0);
});
