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
  assertNoWithheldTestLabels,
  REVISION_ARTIFACT_FILES,
  MAX_EXCERPT_CANDIDATES,
  MAX_EXCERPT_LINES,
  MAX_EXCERPT_BULLETS,
  type RevisionTestExpectation,
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

// ===== M28.5 — hardened fair test-discovery requirements / checklist / telemetry marker =====

// M28.5-1. Default / no-policy revision prompt is byte-identical to the pre-M28.5 default and
// carries none of the M28.5 scaffold (requirements list, checklist, FAIR_TEST_DISCOVERY marker).
test("M28.5: default/no-policy revision prompt remains unchanged (no M28.5 scaffold)", () => {
  const expectation = buildTestExpectation(["tests/test_x.py::test_unparse"], "some problem");
  const base = buildRevisionPrompt({ complianceBefore: nonCompliant(), currentPatch: PATCH, testExpectation: expectation });
  const explicitNone = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    testExpectation: expectation,
    verificationPolicy: "none",
  });
  assert.equal(base, explicitNone);
  assert.doesNotMatch(base, /For a test command to count as fair verification/);
  assert.doesNotMatch(base, /Fair test discovery checklist/);
  assert.doesNotMatch(base, /FAIR_TEST_DISCOVERY:/);
});

// M28.5-2. The fair-policy prompt states the explicit numbered requirements: search/list, then
// read/open the relevant test file BEFORE running, then a canonical command.
test("M28.5: fair-policy prompt requires search/list + read/open before running the test", () => {
  const prompt = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    testExpectation: buildTestExpectation(["tests/test_x.py::test_unparse"], "some problem"),
    verificationPolicy: "agent_discovered",
  });
  assert.match(prompt, /For a test command to count as fair verification, you must:/);
  assert.match(prompt, /Search or list repository test files related to the touched module\/function\./);
  assert.match(prompt, /Read\/open the relevant test file before running the test\./);
  // Read requirement precedes the canonical-command requirement in the rendered prompt.
  assert.ok(
    prompt.indexOf("Read/open the relevant test file before running the test.")
      < prompt.indexOf("Run a canonical focused test command"),
    "read requirement must come before the run requirement",
  );
});

// M28.5-3. The fair-policy prompt explicitly says a grep/search result alone is not enough, and a
// guessed name is not enough.
test("M28.5: fair-policy prompt says grep/search alone (and a guessed name) is not enough", () => {
  const prompt = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    testExpectation: buildTestExpectation(["tests/test_x.py::test_unparse"], "some problem"),
    verificationPolicy: "agent_discovered",
  });
  assert.match(prompt, /A grep\/search result alone is not enough\./);
  assert.match(prompt, /A guessed test name from a function name is not enough\./);
});

// M28.5-4. The fair-policy prompt forbids pipes / redirection / head/tail truncation and shows the
// disqualified command shapes as concrete "not eligible" examples.
test("M28.5: fair-policy prompt forbids pipes/redirection/head/tail with concrete examples", () => {
  const prompt = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    testExpectation: buildTestExpectation(["tests/test_x.py::test_unparse"], "some problem"),
    verificationPolicy: "agent_discovered",
  });
  assert.match(prompt, /no pipes, no redirection, no head\/tail truncation/);
  assert.match(prompt, /A piped\/truncated command is not fair-verification eligible\./);
  assert.match(prompt, /Not fair-verification eligible:/);
  assert.match(prompt, /2>&1 \| head -60/);
  assert.match(prompt, /<discovered test node> 2>&1$/m);
});

// M28.5-5. The fair-policy prompt gives a canonical pytest example AND uses only neutral placeholder
// node names — never a real evaluator test node (no hidden-label leak via the static example).
test("M28.5: fair-policy prompt gives a canonical pytest example with neutral placeholders", () => {
  const ftp = ["tests/test_domain_py.py::test_parse_annotation"];
  const prompt = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    testExpectation: buildTestExpectation(ftp, "some problem"),
    verificationPolicy: "agent_discovered",
  });
  assert.match(prompt, /Good \(fair-verification eligible\):/);
  assert.match(prompt, /python -m pytest <discovered test node>/);
  assert.match(prompt, /pytest tests\/test_<module>\.py::test_<behavior>/);
  // The example must NOT be a real benchmark node (the withheld FAIL_TO_PASS leaf).
  assert.doesNotMatch(prompt, /test_parse_annotation/);
});

// M28.5-6. The fair-policy prompt carries the visible checklist (all four items).
test("M28.5: fair-policy prompt includes the four-item discovery checklist", () => {
  const prompt = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    testExpectation: buildTestExpectation(["tests/test_x.py::test_unparse"], "some problem"),
    verificationPolicy: "agent_discovered",
  });
  assert.match(prompt, /Fair test discovery checklist:/);
  assert.match(prompt, /- \[ \] I searched\/listed repository test files\./);
  assert.match(prompt, /- \[ \] I read\/opened the relevant test file\./);
  assert.match(prompt, /- \[ \] I ran a canonical unpiped test command\./);
  assert.match(prompt, /- \[ \] I did not use benchmark\/evaluator labels\./);
});

// M28.5-7. The optional FAIR_TEST_DISCOVERY telemetry marker instruction renders ONLY under the
// fair policy (never in the default/none prompt).
test("M28.5: FAIR_TEST_DISCOVERY marker instruction renders only under the fair policy", () => {
  const expectation = buildTestExpectation(["tests/test_x.py::test_unparse"], "some problem");
  const fair = buildRevisionPrompt({
    complianceBefore: nonCompliant(),
    currentPatch: PATCH,
    testExpectation: expectation,
    verificationPolicy: "agent_discovered",
  });
  const none = buildRevisionPrompt({ complianceBefore: nonCompliant(), currentPatch: PATCH, testExpectation: expectation, verificationPolicy: "none" });
  assert.match(fair, /FAIR_TEST_DISCOVERY:/);
  assert.match(fair, /searched: <command or none>/);
  assert.match(fair, /result: <passed\/failed\/env-error\/not-run>/);
  assert.doesNotMatch(none, /FAIR_TEST_DISCOVERY:/);
});

// M28.5-8. Even with the strengthened static scaffold, the fair policy still suppresses withheld
// evaluator labels and the assertion guard passes (the new examples use placeholders only).
test("M28.5: strengthened fair scaffold still suppresses withheld labels and passes the guard", () => {
  const ftp = [
    "tests/test_pycode_ast.py::test_unparse[()-()]",
    "tests/test_domain_py.py::test_parse_annotation",
  ];
  const prompt = buildRevisionPrompt({
    complianceBefore: conflictedCompliance(ftp),
    currentPatch: PATCH,
    testExpectation: expectationOf(ftp),
    verificationPolicy: "agent_discovered",
  });
  assert.doesNotMatch(prompt, /test_unparse/);
  assert.doesNotMatch(prompt, /test_parse_annotation/);
  assert.ok(!prompt.includes("FAIL_TO_PASS"));
  assert.doesNotThrow(() => assertNoWithheldTestLabels(prompt, ftp));
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

// ===== M28.2 — fair-policy revision prompt withholds literal evaluator test labels =====

// A conflicted verdict: the agent ruled out a STRONGLY test-anchored pivot, which the M16
// guardrail refuses to credit (so the conflict, with a literal test label internally, is
// carried into the corrective prompt). Mirrors the live sphinx-7462 leak.
function conflictedCompliance(failToPass: readonly string[]) {
  return computePivotInspectionCompliance({
    enabled: true,
    contract: buildPivotInspectionContract(
      [pv("a/lead.py", "lead"), pv("sphinx/pycode/ast.py", "unparse")],
      [],
    ),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["sphinx/pycode/ast.py"],
    decisions: [
      { path: "sphinx/pycode/ast.py", decision: "RULED_OUT", evidence: "the join is empty-safe so no edit is required" },
    ],
    testExpectation: { failToPass },
  });
}

function expectationOf(failToPass: readonly string[]): RevisionTestExpectation {
  return buildTestExpectation(failToPass, null);
}

// M28.2-1. Default / "none" policy still leaks the literal label (existing behavior unchanged).
test("M28.2: default revision prompt still contains the literal conflict test label", () => {
  const ftp = ["tests/test_pycode_ast.py::test_unparse[()-()]"];
  const prompt = buildRevisionPrompt({
    complianceBefore: conflictedCompliance(ftp),
    currentPatch: PATCH,
    testExpectation: expectationOf(ftp),
  });
  assert.match(prompt, /test_unparse\[\(\)-\(\)\]/);
  assert.match(prompt, /FAIL_TO_PASS:/);
});

// M28.2-2. Fair policy suppresses the FAIL_TO_PASS list AND the conflict-evidence test node.
test("M28.2: fair-policy revision prompt suppresses test_unparse[()-()] and the FAIL_TO_PASS list", () => {
  const ftp = ["tests/test_pycode_ast.py::test_unparse[()-()]"];
  const prompt = buildRevisionPrompt({
    complianceBefore: conflictedCompliance(ftp),
    currentPatch: PATCH,
    testExpectation: expectationOf(ftp),
    verificationPolicy: "agent_discovered",
  });
  assert.doesNotMatch(prompt, /test_unparse/);
  assert.doesNotMatch(prompt, /test_unparse\[\(\)-\(\)\]/);
  assert.doesNotMatch(prompt, /^FAIL_TO_PASS:/m);
  assert.doesNotMatch(prompt, /matches FAIL_TO_PASS test/);
});

// M28.2-3. Fair policy still includes the candidate symbol/path and the fact a conflict exists.
test("M28.2: fair-policy revision prompt keeps candidate symbol/path and conflict existence", () => {
  const ftp = ["tests/test_pycode_ast.py::test_unparse[()-()]"];
  const prompt = buildRevisionPrompt({
    complianceBefore: conflictedCompliance(ftp),
    currentPatch: PATCH,
    testExpectation: expectationOf(ftp),
    verificationPolicy: "agent_discovered",
  });
  assert.match(prompt, /Candidate: sphinx\/pycode\/ast\.py::unparse/);
  assert.match(prompt, /candidate symbol "unparse" overlaps withheld benchmark test-expectation metadata/);
  assert.match(prompt, /rule-out conflicts with the \(withheld\) benchmark test expectation/);
  assert.match(prompt, /labels are withheld under the fair verification policy/);
});

// M28.2-4. The other withheld node id family (test_parse_annotation) is also absent under fair policy.
test("M28.2: fair-policy revision prompt suppresses test_parse_annotation", () => {
  const ftp = [
    "tests/test_domain_py.py::test_parse_annotation",
    "tests/test_pycode_ast.py::test_unparse[()-()]",
  ];
  const prompt = buildRevisionPrompt({
    complianceBefore: conflictedCompliance(ftp),
    currentPatch: PATCH,
    testExpectation: expectationOf(ftp),
    verificationPolicy: "agent_discovered",
  });
  assert.doesNotMatch(prompt, /test_parse_annotation/);
  assert.doesNotMatch(prompt, /test_unparse/);
});

// M28.2-5. assertNoWithheldTestLabels passes for a sanitized prompt and throws for a leaky one.
test("M28.2: assertNoWithheldTestLabels guards full id and short ::leaf forms", () => {
  const ftp = ["tests/test_pycode_ast.py::test_unparse[()-()]"];
  const sanitized = buildRevisionPrompt({
    complianceBefore: conflictedCompliance(ftp),
    currentPatch: PATCH,
    testExpectation: expectationOf(ftp),
    verificationPolicy: "agent_discovered",
  });
  // The fair-policy build itself ran the assertion without throwing.
  assert.doesNotThrow(() => assertNoWithheldTestLabels(sanitized, ftp));
  // A prompt that leaks either the full id or the short leaf must throw.
  assert.throws(() => assertNoWithheldTestLabels("ran tests/test_pycode_ast.py::test_unparse[()-()]", ftp), /leaked a withheld test label/);
  assert.throws(() => assertNoWithheldTestLabels("ran test_unparse[()-()]", ftp), /leaked a withheld test label/);
  // No withheld labels ⇒ no-op.
  assert.doesNotThrow(() => assertNoWithheldTestLabels("anything", []));
});

// M28.2-6. Multiple withheld tests are all sanitized; unrelated repo paths/symbols are kept.
test("M28.2: fair policy handles multiple withheld tests and preserves unrelated paths/symbols", () => {
  const ftp = [
    "tests/test_pycode_ast.py::test_unparse[()-()]",
    "tests/test_domain_py.py::test_parse_annotation",
  ];
  const prompt = buildRevisionPrompt({
    complianceBefore: conflictedCompliance(ftp),
    currentPatch: PATCH,
    testExpectation: expectationOf(ftp),
    verificationPolicy: "agent_discovered",
    sourceExcerpts: [
      { path: "sphinx/pycode/ast.py", symbol: "unparse", excerpt: "def unparse(node):\n    return None", evidence: ["why surfaced: symbol match"] },
    ],
  });
  // Withheld evaluator labels gone.
  assert.doesNotMatch(prompt, /test_unparse/);
  assert.doesNotMatch(prompt, /test_parse_annotation/);
  // Unrelated repository path + candidate symbol still present (not over-sanitized).
  assert.match(prompt, /sphinx\/pycode\/ast\.py/);
  assert.match(prompt, /unparse/);
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
