// Tests for the M14 corrective pivot-revision pass (planning + prompt + record),
// extended for M15 evidence enrichment (FAIL_TO_PASS / test expectation context,
// bounded source excerpts, graceful fallback).
//
// Pure-function tests over `decideRevisionPass`, `buildRevisionPrompt`,
// `buildTestExpectation`, `boundExcerpts`, `decideReplacement`, and the record
// helpers. They pin the activation gates, the no-run cases, the revision prompt shape
// (current patch, only missing/unclear candidates, test expectation, bounded excerpts,
// anti-over-edit wording), the separate-artifact layout, and the conservative
// replacement rule. No fs, no spawn, no model.

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
  buildTestExpectation,
  boundExcerpts,
  decideReplacement,
  outstandingCount,
  noRunRecord,
  REVISION_ARTIFACT_FILES,
  MAX_EXCERPT_CANDIDATES,
  MAX_EXCERPT_LINES,
  MAX_EXCERPT_BULLETS,
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
  assert.match(prompt, /You previously produced this patch\./);
  assert.match(prompt, /VTRACE could not verify the required pivot decision/);
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

// 12 — revision prompt carries anti-over-edit / minimal-diff wording (M15 wording).
test("revision prompt carries anti-over-edit and minimal-diff guardrails", () => {
  const prompt = buildRevisionPrompt({ complianceBefore: nonCompliant(), currentPatch: PATCH });
  assert.match(prompt, /Do not edit a file merely because it is listed/);
  assert.match(prompt, /Prefer the minimal final diff/);
  assert.match(prompt, /Preserve already-correct changes/);
  assert.match(prompt, /Only add a co-edit file when source\/test evidence requires it/);
  // The model is asked for a non-empty diff only when evidence requires it.
  assert.match(prompt, /Return a non-empty unified diff only if source\/test evidence requires a change/);
  assert.match(prompt, /Otherwise return no diff and include PIVOT_DECISION markers/);
  assert.doesNotMatch(prompt, /edit all pivots/i);
});

// bounded source excerpts are included when provided.
test("revision prompt includes provided source excerpts", () => {
  const prompt = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    sourceExcerpts: [
      { path: "a/other.py", symbol: "other", excerpt: "def other():\n    return forward(value)", evidence: ["why surfaced: caller of lead"] },
    ],
  });
  assert.match(prompt, /Source excerpts for the outstanding candidates/);
  assert.match(prompt, /a\/other\.py::other/);
  assert.match(prompt, /why surfaced: caller of lead/);
  assert.match(prompt, /def other\(\)/);
});

// 9 — FAIL_TO_PASS names are included in the revision prompt when available.
test("revision prompt includes FAIL_TO_PASS test names when available", () => {
  const expectation = buildTestExpectation(
    ["tests/test_x.py::test_empty_tuple", "tests/test_y.py::test_unparse"],
    "some problem",
  );
  assert.equal(expectation.source, "instance_metadata");
  const prompt = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    testExpectation: expectation,
  });
  assert.match(prompt, /## Test expectation/);
  assert.match(prompt, /FAIL_TO_PASS:/);
  assert.match(prompt, /tests\/test_x\.py::test_empty_tuple/);
  assert.match(prompt, /decide whether the missing\/unclear pivot affects the required behavior/);
});

// 10 — revision prompt falls back gracefully when FAIL_TO_PASS is unavailable.
test("revision prompt falls back to problem statement, then to nothing, when no FAIL_TO_PASS", () => {
  const fromProblem = buildTestExpectation([], "Empty tuple annotation crashes unparse with IndexError");
  assert.equal(fromProblem.source, "problem_statement");
  const p1 = buildRevisionPrompt({ complianceBefore: nonCompliant(), currentPatch: PATCH, testExpectation: fromProblem });
  assert.match(p1, /## Test expectation/);
  assert.match(p1, /No FAIL_TO_PASS test names were available/);
  assert.match(p1, /Empty tuple annotation crashes/);

  const none = buildTestExpectation([], "");
  assert.equal(none.source, "unavailable");
  // Prompt still builds and omits the section entirely (no crash, no empty header).
  const p2 = buildRevisionPrompt({ complianceBefore: nonCompliant(), currentPatch: PATCH, testExpectation: none });
  assert.doesNotMatch(p2, /## Test expectation/);
  // Without a testExpectation at all, the prompt also builds cleanly.
  const p3 = buildRevisionPrompt({ complianceBefore: nonCompliant(), currentPatch: PATCH });
  assert.match(p3, /You previously produced this patch\./);
});

// M23-1 — default mode (no policy / "none") leaves the revision prompt unchanged: FAIL_TO_PASS
// names still appear and the fair-verification block is absent.
test("M23: default mode leaves revision prompt behavior unchanged", () => {
  const expectation = buildTestExpectation(["tests/test_x.py::test_unparse"], "some problem");
  const base = buildRevisionPrompt({ complianceBefore: nonCompliant(), currentPatch: PATCH, testExpectation: expectation });
  const explicitNone = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    testExpectation: expectation,
    verificationPolicy: "none",
  });
  // Omitting the policy and passing "none" produce the identical prompt.
  assert.equal(base, explicitNone);
  // FAIL_TO_PASS names are still injected; the fair-verification block is absent.
  assert.match(base, /FAIL_TO_PASS:/);
  assert.match(base, /tests\/test_x\.py::test_unparse/);
  assert.doesNotMatch(base, /Fair verification/);
});

// M23-2 — the opt-in policy renders the discovery-based instruction AND suppresses literal
// injected FAIL_TO_PASS test names (Option 1: do not put hidden evaluator labels in the prompt).
test("M23: opt-in fair test policy renders discovery instruction and hides FAIL_TO_PASS names", () => {
  const expectation = buildTestExpectation(["tests/test_x.py::test_unparse"], "some problem");
  const prompt = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    testExpectation: expectation,
    verificationPolicy: "agent_discovered",
  });
  // The fair-verification discovery instruction is present.
  assert.match(prompt, /## Fair verification \(agent-discovered focused test\)/);
  assert.match(prompt, /discover and run the smallest relevant repository test/);
  assert.match(prompt, /Do not run a test merely because a hidden benchmark\/evaluator label says so/);
  assert.match(prompt, /Do not claim the patch is verified unless the command output shows the test actually passed/);
  // Literal FAIL_TO_PASS names are NOT injected under the fair policy (Option 1).
  assert.doesNotMatch(prompt, /FAIL_TO_PASS:/);
  assert.doesNotMatch(prompt, /tests\/test_x\.py::test_unparse/);
  assert.match(prompt, /labels are withheld under the fair verification policy/);
  // Anti-over-edit guardrails (REVISION_RULES) are preserved.
  assert.match(prompt, /Prefer the minimal final diff\./);
});

// M23 — the public problem-statement excerpt is legitimate context and is NOT suppressed by the
// fair policy (only hidden FAIL_TO_PASS labels are).
test("M23: fair policy keeps the public problem-statement excerpt", () => {
  const fromProblem = buildTestExpectation([], "Empty tuple annotation crashes unparse with IndexError");
  const prompt = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    testExpectation: fromProblem,
    verificationPolicy: "agent_discovered",
  });
  assert.match(prompt, /Empty tuple annotation crashes/);
  assert.match(prompt, /## Fair verification/);
});

// ===== M28 — strengthened fair test-discovery scaffold in the revision prompt =====

// M28-1. Default / no-policy revision prompt is byte-identical to the pre-M28 default: omitting
// the policy and passing "none" produce the same prompt, the fair-verification/discovery block is
// absent, and literal FAIL_TO_PASS names still appear (default behavior unchanged).
test("M28: default/no-policy revision prompt remains unchanged", () => {
  const expectation = buildTestExpectation(["tests/test_x.py::test_unparse"], "some problem");
  const base = buildRevisionPrompt({ complianceBefore: nonCompliant(), currentPatch: PATCH, testExpectation: expectation });
  const explicitNone = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    testExpectation: expectation,
    verificationPolicy: "none",
  });
  assert.equal(base, explicitNone);
  assert.doesNotMatch(base, /## Fair verification/);
  assert.doesNotMatch(base, /Discovery protocol/);
  assert.match(base, /FAIL_TO_PASS:/);
  assert.match(base, /tests\/test_x\.py::test_unparse/);
});

// M28-2. The fair policy prompt carries an explicit search/list/read repository-test discovery
// instruction (the M28 protocol), not just the generic "discover a test" sentence.
test("M28: fair policy prompt includes explicit search/list/read repository-test discovery protocol", () => {
  const prompt = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    testExpectation: buildTestExpectation(["tests/test_x.py::test_unparse"], "some problem"),
    verificationPolicy: "agent_discovered",
  });
  assert.match(prompt, /Discovery protocol/);
  assert.match(prompt, /Search\/list\/read the repository test files related to the touched module\/function/);
  assert.match(prompt, /grep\/ripgrep\/find\/ls over the test directories, then read the candidate test file/);
  assert.match(prompt, /Choose the smallest focused test you actually discovered/);
});

// M28-3. The fair policy prompt tells the agent not to guess a test from the function name alone.
test("M28: fair policy prompt forbids guessing a test from the function name alone", () => {
  const prompt = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    testExpectation: buildTestExpectation(["tests/test_x.py::test_unparse"], "some problem"),
    verificationPolicy: "agent_discovered",
  });
  assert.match(prompt, /Do not guess a test name from the edited function name alone/);
});

// M28-4. The fair policy prompt tells the agent to avoid piped/truncated test commands and prefer
// a canonical `python -m pytest` / `pytest` invocation.
test("M28: fair policy prompt tells the agent to avoid piped/truncated commands", () => {
  const prompt = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    testExpectation: buildTestExpectation(["tests/test_x.py::test_unparse"], "some problem"),
    verificationPolicy: "agent_discovered",
  });
  assert.match(prompt, /Run it with a canonical command — never a piped or truncated one/);
  assert.match(prompt, /piping or truncating the test command/);
  assert.match(prompt, /python -m pytest <discovered test node>/);
});

// M28-5. The fair policy prompt suppresses literal FAIL_TO_PASS test names — including the static
// "FAIL_TO_PASS" task label that M23.1 left behind (the only "FAIL_TO_PASS" token allowed is none).
test("M28: fair policy prompt suppresses literal FAIL_TO_PASS test names and label", () => {
  const prompt = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    testExpectation: buildTestExpectation(["tests/test_x.py::test_unparse"], "some problem"),
    verificationPolicy: "agent_discovered",
  });
  assert.doesNotMatch(prompt, /FAIL_TO_PASS:/);
  assert.doesNotMatch(prompt, /tests\/test_x\.py::test_unparse/);
  // The cosmetic static "FAIL_TO_PASS" task label is gone under the fair policy (M28 cleanup).
  assert.ok(!prompt.includes("FAIL_TO_PASS"));
  assert.match(prompt, /labels are withheld under the fair verification policy/);
  // Minimal-diff guardrails are still preserved.
  assert.match(prompt, /Prefer the minimal final diff\./);
});

// 11 — candidate excerpts are strictly bounded (count / lines / bullets).
test("source excerpts are bounded to count, lines, and bullets", () => {
  const many = Array.from({ length: 6 }, (_, i) => ({
    path: `a/f${i}.py`,
    symbol: `s${i}`,
    excerpt: Array.from({ length: 30 }, (_, l) => `line${l}`).join("\n"),
    evidence: ["b1", "b2", "b3", "b4"],
  }));
  const bounded = boundExcerpts(many);
  assert.equal(bounded.length, MAX_EXCERPT_CANDIDATES);
  for (const ex of bounded) {
    assert.ok(ex.excerpt.split("\n").length <= MAX_EXCERPT_LINES, "excerpt line bound");
    assert.ok((ex.evidence ?? []).length <= MAX_EXCERPT_BULLETS, "evidence bullet bound");
  }
});

// 7 — revised patch is persisted SEPARATELY (distinct artifact files + record fields).
test("artifact layout keeps original and revised patches in separate files", () => {
  assert.notEqual(REVISION_ARTIFACT_FILES.originalPatch, REVISION_ARTIFACT_FILES.revisedPatch);
  assert.ok(REVISION_ARTIFACT_FILES.firstPassAssistant.startsWith("_pivot_first_pass"));
  const files = new Set(Object.values(REVISION_ARTIFACT_FILES));
  assert.equal(files.size, Object.keys(REVISION_ARTIFACT_FILES).length); // all distinct
  // All artifact files are "_"-prefixed so they are never picked up as a canonical JSONL.
  for (const f of files) assert.ok(f.startsWith("_"), `${f} must be _-prefixed`);
});

// 8 — original patch is preserved (no-run record + replacement rule), extras carried.
test("no-run record preserves the original patch and carries M15 extras", () => {
  const rec = noRunRecord("patch already compliant", PATCH, compliant(), {
    firstPassAssistantTextPath: "/x/_pivot_first_pass_assistant.txt",
    firstPassPivotDecisions: [{ path: "a/other.py", decision: "RULED_OUT", evidence: "join is empty-safe" }],
    testExpectation: { failToPass: ["t1"], source: "instance_metadata" },
  });
  assert.equal(rec.ran, false);
  assert.equal(rec.originalPatch, PATCH);
  assert.equal(rec.revisedPatch, null);
  assert.equal(rec.replacedFinalPatch, false);
  assert.equal(rec.firstPassAssistantTextPath, "/x/_pivot_first_pass_assistant.txt");
  assert.equal(rec.firstPassPivotDecisions?.[0]?.decision, "RULED_OUT");
  assert.equal(rec.testExpectation?.source, "instance_metadata");
});

// no-run record without extras still builds (graceful).
test("no-run record works without M15 extras", () => {
  const rec = noRunRecord("revision-pass flag off", PATCH, compliant());
  assert.equal(rec.ran, false);
  assert.equal(rec.originalPatch, PATCH);
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
