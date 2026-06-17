// Tests for the M13 pivot inspection COMPLIANCE checker.
//
// Pure-function tests over `computePivotInspectionCompliance` and its helpers. They
// pin the activation gate, the contract-derived required set, the edited / ruled-out /
// missing / unclear classification (including the conservative "inspected but no
// grounded rule-out ⇒ unclear" rule), the generated-artifact exclusion, the
// machine-readable PIVOT_DECISION parser, and the anti-over-edit corrective prompt.
//
// Nothing here pins instance ids, repo names, or gold-patch data: every contract is a
// synthetic selection shaped like a real capsule would carry it.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildPivotInspectionContract, type ContractPivotView } from "./pivotInspectionContract";
import type { ActionabilityHint } from "./actionabilityHints";
import {
  computePivotInspectionCompliance,
  requiredCandidatesFromContract,
  parsePivotDecisionMarkers,
  hasSourceGroundedRuleOut,
  buildCorrectivePrompt,
  wouldFireCorrectivePrompt,
  detectRuleOutConflict,
  type PivotDecisionMarker,
  type ComplianceTestExpectation,
} from "./pivotInspectionCompliance";

function pv(filePath: string, symbol: string, evidence?: string[]): ContractPivotView {
  return { path: filePath, symbol, evidence };
}

function coeditHint(source: string, related: string[]): ActionabilityHint {
  return {
    kind: "multi_file_coedit",
    sourceFile: source,
    relatedFile: related[0]!,
    relatedFiles: related,
    confidence: "medium",
    evidence: ["sibling pivots suggest a coordinated fix"],
    hint: "inspect each co-edit candidate and either edit it or rule it out",
  };
}

// A 2-pivot, no-coedit contract (sphinx/seaborn shape): one non-lead pivot.
function twoPivotContract() {
  return buildPivotInspectionContract(
    [pv("a/lead.py", "lead"), pv("a/other.py", "other")],
    [],
  );
}

// 1 — Checker only activates when --pivot-inspection-enforcement is enabled.
test("checker is inactive (empty verdict) when enforcement is disabled", () => {
  const out = computePivotInspectionCompliance({
    enabled: false,
    contract: twoPivotContract(),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["a/other.py"],
  });
  assert.equal(out.enabled, false);
  assert.deepEqual(out.required, []);
  assert.deepEqual(out.missing, []);
  assert.deepEqual(out.unclear, []);
  assert.equal(out.correctivePromptSent, false);
});

// 2 — Required candidates are derived from the M11/M12 contract.
test("required candidates are derived from the contract (non-lead pivots + co-edit)", () => {
  const contract = buildPivotInspectionContract(
    [pv("a/lead.py", "lead"), pv("a/other.py", "other")],
    [coeditHint("a/lead.py", ["b/coupled.py"])],
  );
  const required = requiredCandidatesFromContract(contract);
  assert.deepEqual(
    required,
    [
      { path: "a/other.py", symbol: "other", role: "non_lead_pivot" },
      { path: "b/coupled.py", symbol: undefined, role: "related_coedit" },
    ],
  );
});

// 3 — Candidate is compliant when its file is in the final patch.
test("candidate whose file is in the final patch is edited (compliant)", () => {
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: twoPivotContract(),
    editedFiles: ["a/lead.py", "a/other.py"],
    inspectedFiles: [],
  });
  assert.deepEqual(out.edited, ["a/other.py::other"]);
  assert.deepEqual(out.missing, []);
  assert.deepEqual(out.unclear, []);
  assert.equal(out.correctivePromptSent, false);
});

// file matching tolerates absolute tool-call paths vs repo-relative candidates.
test("edited/inspected matching tolerates absolute paths", () => {
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: twoPivotContract(),
    editedFiles: ["/abs/repo/a/other.py"],
    inspectedFiles: [],
  });
  assert.deepEqual(out.edited, ["a/other.py::other"]);
});

// 4 — Candidate is compliant when explicit RULED_OUT evidence is present.
test("candidate with a source-grounded RULED_OUT marker is ruledOut (compliant)", () => {
  const decisions: PivotDecisionMarker[] = [
    {
      path: "a/other.py",
      decision: "RULED_OUT",
      evidence: "this caller only forwards the value; the IndexError is raised in lead.py",
    },
  ];
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: twoPivotContract(),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["a/other.py"],
    decisions,
  });
  assert.deepEqual(out.ruledOut, ["a/other.py::other"]);
  assert.deepEqual(out.missing, []);
  assert.deepEqual(out.unclear, []);
  assert.equal(out.correctivePromptSent, false);
  assert.equal(hasSourceGroundedRuleOut("a/other.py", decisions), true);
});

// 5 — Generic "not needed" without evidence is not compliant (unclear).
test("generic non-grounded RULED_OUT marker is unclear, not ruledOut", () => {
  const decisions: PivotDecisionMarker[] = [
    { path: "a/other.py", decision: "RULED_OUT", evidence: "not needed" },
  ];
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: twoPivotContract(),
    editedFiles: ["a/lead.py"],
    inspectedFiles: [],
    decisions,
  });
  assert.deepEqual(out.ruledOut, []);
  assert.deepEqual(out.unclear, ["a/other.py::other"]);
  assert.equal(out.correctivePromptSent, true);
  assert.equal(hasSourceGroundedRuleOut("a/other.py", decisions), false);
});

// conservative split: inspected but no marker ⇒ unclear; not inspected ⇒ missing.
test("inspected-but-not-edited is unclear; not-inspected-not-edited is missing", () => {
  const inspected = computePivotInspectionCompliance({
    enabled: true,
    contract: twoPivotContract(),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["a/other.py"],
  });
  assert.deepEqual(inspected.unclear, ["a/other.py::other"]);
  assert.deepEqual(inspected.missing, []);

  const skipped = computePivotInspectionCompliance({
    enabled: true,
    contract: twoPivotContract(),
    editedFiles: ["a/lead.py"],
    inspectedFiles: [],
  });
  assert.deepEqual(skipped.missing, ["a/other.py::other"]);
  assert.deepEqual(skipped.unclear, []);
});

// 6 — Generated-artifact table files are not treated as normal pivot requirements.
test("generated-artifact files are excluded from the required set", () => {
  const contract = buildPivotInspectionContract(
    [pv("a/lead.py", "lead")],
    [coeditHint("a/lead.py", ["a/grammar_parsetab.py"])],
  );
  const required = requiredCandidatesFromContract(contract, ["a/grammar_parsetab.py"]);
  assert.deepEqual(required, []);

  const out = computePivotInspectionCompliance({
    enabled: true,
    contract,
    editedFiles: ["a/lead.py"],
    inspectedFiles: [],
    generatedArtifactFiles: ["a/grammar_parsetab.py"],
  });
  assert.deepEqual(out.required, []);
  assert.equal(out.correctivePromptSent, false);
});

// 7 — Single-pivot / no-coedit cases produce no required candidates.
test("single-pivot no-coedit case yields a null contract and no required candidates", () => {
  const contract = buildPivotInspectionContract([pv("a/lead.py", "lead")], []);
  assert.equal(contract, null);
  assert.deepEqual(requiredCandidatesFromContract(contract), []);

  const out = computePivotInspectionCompliance({
    enabled: true,
    contract,
    editedFiles: ["a/lead.py"],
    inspectedFiles: [],
  });
  assert.deepEqual(out.required, []);
  assert.equal(out.correctivePromptSent, false);
});

// 8 — Anti-over-edit wording is preserved in any corrective prompt.
test("corrective prompt preserves the anti-over-edit guardrail wording", () => {
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: twoPivotContract(),
    editedFiles: ["a/lead.py"],
    inspectedFiles: [],
  });
  const prompt = buildCorrectivePrompt(out);
  assert.ok(prompt !== null);
  assert.match(prompt!, /Do not add files merely because they are listed/);
  assert.match(prompt!, /Prefer the minimal diff/);
  assert.match(prompt!, /cite concrete source evidence/);
  // It must NEVER instruct editing every pivot.
  assert.doesNotMatch(prompt!, /edit all pivots/i);
});

// 9 — Existing --disable-pivot-check legacy behavior is independent of this checker.
test("checker verdict depends only on its inputs, not on any legacy pivot-check flag", () => {
  // The compute input carries no legacy-flag coupling; the only gate is `enabled`.
  const input = {
    enabled: true,
    contract: twoPivotContract(),
    editedFiles: ["a/lead.py", "a/other.py"],
    inspectedFiles: [],
  } as const;
  const a = computePivotInspectionCompliance(input);
  const b = computePivotInspectionCompliance(input);
  assert.deepEqual(a, b);
});

// 10 — Deterministic / side-effect-free (supports the no-retrieval-change guarantee).
test("compliance computation is pure and deterministic", () => {
  const input = {
    enabled: true,
    contract: twoPivotContract(),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["a/other.py"],
  } as const;
  assert.deepEqual(
    computePivotInspectionCompliance(input),
    computePivotInspectionCompliance(input),
  );
});

// 11 — Missing candidate triggers the corrective prompt.
test("a missing candidate fires the corrective prompt", () => {
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: twoPivotContract(),
    editedFiles: ["a/lead.py"],
    inspectedFiles: [],
  });
  assert.equal(wouldFireCorrectivePrompt(out), true);
  assert.ok(buildCorrectivePrompt(out) !== null);
});

// 12 — Fully compliant patch does not trigger the corrective prompt.
test("a fully compliant run does not fire the corrective prompt", () => {
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: twoPivotContract(),
    editedFiles: ["a/lead.py", "a/other.py"],
    inspectedFiles: [],
  });
  assert.equal(wouldFireCorrectivePrompt(out), false);
  assert.equal(buildCorrectivePrompt(out), null);
});

// 13 — Corrective prompt lists only missing/unclear candidates.
test("corrective prompt lists only missing/unclear candidates, never edited/ruled-out", () => {
  const contract = buildPivotInspectionContract(
    [pv("a/lead.py", "lead"), pv("a/edited.py", "e"), pv("a/inspected.py", "i")],
    [coeditHint("a/lead.py", ["b/skipped.py"])],
  );
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract,
    editedFiles: ["a/lead.py", "a/edited.py"],
    inspectedFiles: ["a/inspected.py"],
  });
  assert.deepEqual(out.edited, ["a/edited.py::e"]);
  assert.deepEqual(out.unclear, ["a/inspected.py::i"]);
  assert.deepEqual(out.missing, ["b/skipped.py"]);

  const prompt = buildCorrectivePrompt(out)!;
  assert.match(prompt, /a\/inspected\.py::i/);
  assert.match(prompt, /b\/skipped\.py/);
  assert.doesNotMatch(prompt, /a\/edited\.py/);
});

// PIVOT_DECISION marker parser (Option C) — present so a future marker-emitting run can
// drive ruledOut; tolerant of indentation and key ordering.
test("parsePivotDecisionMarkers extracts well-formed markers and ignores noise", () => {
  const text = [
    "Here is my reasoning.",
    "PIVOT_DECISION:",
    "  path: a/other.py",
    "  decision: RULED_OUT",
    "  evidence: only forwards the value; no IndexError path here",
    "",
    "PIVOT_DECISION:",
    "  decision: EDITED",
    "  path: a/lead.py",
    "  evidence: guarded the empty-tuple branch",
  ].join("\n");
  const markers = parsePivotDecisionMarkers(text);
  assert.equal(markers.length, 2);
  assert.deepEqual(markers[0], {
    path: "a/other.py",
    decision: "RULED_OUT",
    evidence: "only forwards the value; no IndexError path here",
  });
  assert.equal(markers[1]!.decision, "EDITED");
  assert.equal(markers[1]!.path, "a/lead.py");
});

test("parsePivotDecisionMarkers returns [] for text without markers", () => {
  assert.deepEqual(parsePivotDecisionMarkers("no markers here\njust prose"), []);
  assert.deepEqual(parsePivotDecisionMarkers(""), []);
});

// --- (M15) edited file wins over a RULED_OUT marker -------------------------------

test("an edited candidate is `edited` even if a RULED_OUT marker is present", () => {
  const decisions: PivotDecisionMarker[] = [
    { path: "a/other.py", decision: "RULED_OUT", evidence: "the join handles empty input safely so no edit is required" },
  ];
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: buildPivotInspectionContract(
      [{ path: "a/lead.py", symbol: "lead" }, { path: "a/other.py", symbol: "other" }],
      [],
    ),
    editedFiles: ["a/lead.py", "a/other.py"],
    inspectedFiles: ["a/other.py"],
    decisions,
  });
  assert.deepEqual(out.edited, ["a/other.py::other"]);
  assert.deepEqual(out.ruledOut, []);
  assert.deepEqual(out.unclear, []);
});

// --- (M15) a grounded first-pass RULED_OUT marker suppresses the false trigger -----

test("a grounded first-pass RULED_OUT marker suppresses the corrective trigger", () => {
  const contract = buildPivotInspectionContract(
    [{ path: "a/lead.py", symbol: "lead" }, { path: "a/other.py", symbol: "other" }],
    [],
  );
  // Without a marker: inspected-but-not-edited ⇒ unclear ⇒ corrective fires.
  const before = computePivotInspectionCompliance({
    enabled: true,
    contract,
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["a/other.py"],
  });
  assert.deepEqual(before.unclear, ["a/other.py::other"]);
  assert.equal(before.correctivePromptSent, true);

  // With a grounded first-pass RULED_OUT marker: ruledOut ⇒ corrective suppressed.
  const after = computePivotInspectionCompliance({
    enabled: true,
    contract,
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["a/other.py"],
    decisions: [
      { path: "a/other.py", decision: "RULED_OUT", evidence: "scatterplot is not on the changed legend code path; the offset fix lives in scales.py" },
    ],
  });
  assert.deepEqual(after.ruledOut, ["a/other.py::other"]);
  assert.deepEqual(after.unclear, []);
  assert.equal(after.correctivePromptSent, false);
});


// ── M16: rule-out conflict guardrail ──────────────────────────────────────────────
// A grounded RULED_OUT must not be credited (suppress revision) when the candidate is
// strongly anchored by FAIL_TO_PASS / test-expectation evidence. Matching is against the
// test METHOD leaf only, so a test file named after a source module does NOT collide.

function te(
  failToPass: readonly string[],
  problemStatementExcerpt?: string,
): ComplianceTestExpectation {
  return { failToPass, problemStatementExcerpt };
}

const GROUNDED = "the join handles empty input safely so no edit is required";

function contractWith(path: string, symbol: string) {
  return buildPivotInspectionContract(
    [pv("a/lead.py", "lead"), pv(path, symbol)],
    [],
  );
}

test("M16: grounded rule-out with symbol-vs-test-method overlap is not ruledOut (conflict)", () => {
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: contractWith("sphinx/pycode/ast.py", "unparse"),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["sphinx/pycode/ast.py"],
    decisions: [{ path: "sphinx/pycode/ast.py", decision: "RULED_OUT", evidence: GROUNDED }],
    testExpectation: te(["tests/test_pycode_ast.py::test_unparse[()-()]"]),
  });
  assert.deepEqual(out.ruledOut, []);
  assert.deepEqual(out.unclear, ["sphinx/pycode/ast.py::unparse"]);
  assert.equal(out.ruleOutConflicts.length, 1);
  assert.equal(out.ruleOutConflicts[0]!.kind, "test_expectation_conflict");
  assert.match(out.ruleOutConflicts[0]!.evidence.join(" "), /symbol "unparse"/);
});

test("M16: grounded rule-out with file-stem-vs-test-method overlap is not ruledOut (conflict)", () => {
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: contractWith("pkg/widget.py", "render"),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["pkg/widget.py"],
    decisions: [{ path: "pkg/widget.py", decision: "RULED_OUT", evidence: GROUNDED }],
    testExpectation: te(["tests/test_ui.py::test_widget_visible"]),
  });
  assert.deepEqual(out.ruledOut, []);
  assert.deepEqual(out.unclear, ["pkg/widget.py::render"]);
  assert.match(out.ruleOutConflicts[0]!.evidence.join(" "), /file "widget"/);
});

test("M16: a conflicted rule-out remains revision-triggering", () => {
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: contractWith("sphinx/pycode/ast.py", "unparse"),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["sphinx/pycode/ast.py"],
    decisions: [{ path: "sphinx/pycode/ast.py", decision: "RULED_OUT", evidence: GROUNDED }],
    testExpectation: te(["tests/test_pycode_ast.py::test_unparse[()-()]"]),
  });
  assert.equal(out.correctivePromptSent, true);
  assert.equal(wouldFireCorrectivePrompt(out), true);
});

test("M16: corrective prompt carries the conflict evidence and keeps anti-over-edit wording", () => {
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: contractWith("sphinx/pycode/ast.py", "unparse"),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["sphinx/pycode/ast.py"],
    decisions: [{ path: "sphinx/pycode/ast.py", decision: "RULED_OUT", evidence: GROUNDED }],
    testExpectation: te(["tests/test_pycode_ast.py::test_unparse[()-()]"]),
  });
  const prompt = buildCorrectivePrompt(out)!;
  assert.match(prompt, /rule-out conflicts with the FAIL_TO_PASS\/test expectation/);
  assert.match(prompt, /Candidate: sphinx\/pycode\/ast\.py::unparse/);
  assert.match(prompt, /Conflict evidence:/);
  assert.match(prompt, /Do not add files merely because they are listed/);
  assert.match(prompt, /Prefer the minimal diff/);
});

// M28.2 — default (no fairPolicy) corrective prompt still leaks the literal test label
// (existing behavior preserved exactly); the detector still carries the literal evidence.
test("M28.2: default corrective prompt keeps the literal FAIL_TO_PASS conflict evidence", () => {
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: contractWith("sphinx/pycode/ast.py", "unparse"),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["sphinx/pycode/ast.py"],
    decisions: [{ path: "sphinx/pycode/ast.py", decision: "RULED_OUT", evidence: GROUNDED }],
    testExpectation: te(["tests/test_pycode_ast.py::test_unparse[()-()]"]),
  });
  const def = buildCorrectivePrompt(out)!;
  const explicitFalse = buildCorrectivePrompt(out, { fairPolicy: false })!;
  assert.equal(def, explicitFalse);
  assert.match(def, /Conflict evidence: symbol "unparse" matches FAIL_TO_PASS test test_unparse\[\(\)-\(\)\]/);
  // The internal detector keeps both the literal evidence and the structured overlaps.
  assert.match(out.ruleOutConflicts[0]!.evidence.join(" "), /test_unparse/);
  assert.deepEqual(out.ruleOutConflicts[0]!.overlaps, [
    { what: "symbol", token: "unparse", against: "test_expectation" },
  ]);
});

// M28.2 — fair-policy corrective prompt withholds the literal test node but keeps the
// candidate symbol overlap and the fact a conflict exists. The M16 detector is unchanged.
test("M28.2: fair-policy corrective prompt withholds the literal test label", () => {
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: contractWith("sphinx/pycode/ast.py", "unparse"),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["sphinx/pycode/ast.py"],
    decisions: [{ path: "sphinx/pycode/ast.py", decision: "RULED_OUT", evidence: GROUNDED }],
    testExpectation: te(["tests/test_pycode_ast.py::test_unparse[()-()]"]),
  });
  const fair = buildCorrectivePrompt(out, { fairPolicy: true })!;
  // Withheld: the literal evaluator test node never appears.
  assert.doesNotMatch(fair, /test_unparse/);
  assert.doesNotMatch(fair, /matches FAIL_TO_PASS test/);
  // Kept: candidate identity, the candidate-symbol overlap, the conflict, the withholding note.
  assert.match(fair, /Candidate: sphinx\/pycode\/ast\.py::unparse/);
  assert.match(fair, /candidate symbol "unparse" overlaps withheld benchmark test-expectation metadata/);
  assert.match(fair, /rule-out conflicts with the \(withheld\) benchmark test expectation/);
  assert.match(fair, /The exact evaluator test label is withheld under the fair verification policy/);
  // M16 guardrail unaffected: still a conflict, still revision-triggering.
  assert.equal(out.ruleOutConflicts.length, 1);
  assert.equal(out.correctivePromptSent, true);
});

// M28.2 — file-stem overlaps are also rendered label-free under the fair policy.
test("M28.2: fair-policy corrective prompt renders a file-stem overlap without the test label", () => {
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: contractWith("pkg/widget.py", "render"),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["pkg/widget.py"],
    decisions: [{ path: "pkg/widget.py", decision: "RULED_OUT", evidence: GROUNDED }],
    testExpectation: te(["tests/test_ui.py::test_widget_visible"]),
  });
  const fair = buildCorrectivePrompt(out, { fairPolicy: true })!;
  assert.doesNotMatch(fair, /test_widget_visible/);
  assert.match(fair, /candidate file "widget" overlaps withheld benchmark test-expectation metadata/);
  assert.deepEqual(out.ruleOutConflicts[0]!.overlaps, [
    { what: "file", token: "widget", against: "test_expectation" },
  ]);
});

test("M16: grounded rule-out with no test conflict still suppresses (ruledOut)", () => {
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: contractWith("a/other.py", "other"),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["a/other.py"],
    decisions: [{ path: "a/other.py", decision: "RULED_OUT", evidence: GROUNDED }],
    testExpectation: te(["tests/test_unrelated.py::test_something_else"]),
  });
  assert.deepEqual(out.ruledOut, ["a/other.py::other"]);
  assert.deepEqual(out.unclear, []);
  assert.deepEqual(out.ruleOutConflicts, []);
  assert.equal(out.correctivePromptSent, false);
});

test("M16: seaborn-style non-gold rule-out stays suppressed despite a test_relational file", () => {
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: contractWith("seaborn/relational.py", "scatterplot"),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["seaborn/relational.py"],
    decisions: [{ path: "seaborn/relational.py", decision: "RULED_OUT", evidence: "fix lives in utils.py::locator_to_legend_entries which scatterplot delegates to" }],
    testExpectation: te([
      "tests/_core/test_plot.py::TestLegend::test_legend_has_no_offset",
      "tests/test_relational.py::TestRelationalPlotter::test_legend_has_no_offset",
    ]),
  });
  assert.deepEqual(out.ruledOut, ["seaborn/relational.py::scatterplot"]);
  assert.deepEqual(out.ruleOutConflicts, []);
  assert.equal(out.correctivePromptSent, false);
});

test("M16: generic token overlaps do not create a conflict", () => {
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: contractWith("pkg/core.py", "utils"),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["pkg/core.py"],
    decisions: [{ path: "pkg/core.py", decision: "RULED_OUT", evidence: GROUNDED }],
    testExpectation: te(["tests/test_core.py::test_utils_helper"]),
  });
  assert.deepEqual(out.ruledOut, ["pkg/core.py::utils"]);
  assert.deepEqual(out.ruleOutConflicts, []);
  assert.equal(detectRuleOutConflict({ path: "pkg/core.py", symbol: "utils", role: "non_lead_pivot" }, te(["tests/test_core.py::test_utils_helper"])), null);
});

test("M16: an edited candidate is edited, never a conflict, even with a test-anchored marker", () => {
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: contractWith("sphinx/pycode/ast.py", "unparse"),
    editedFiles: ["a/lead.py", "sphinx/pycode/ast.py"],
    inspectedFiles: ["sphinx/pycode/ast.py"],
    decisions: [{ path: "sphinx/pycode/ast.py", decision: "RULED_OUT", evidence: GROUNDED }],
    testExpectation: te(["tests/test_pycode_ast.py::test_unparse[()-()]"]),
  });
  assert.deepEqual(out.edited, ["sphinx/pycode/ast.py::unparse"]);
  assert.deepEqual(out.unclear, []);
  assert.deepEqual(out.ruleOutConflicts, []);
});

test("M16: no test expectation means existing grounded rule-out behavior preserved", () => {
  const out = computePivotInspectionCompliance({
    enabled: true,
    contract: contractWith("sphinx/pycode/ast.py", "unparse"),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["sphinx/pycode/ast.py"],
    decisions: [{ path: "sphinx/pycode/ast.py", decision: "RULED_OUT", evidence: GROUNDED }],
  });
  assert.deepEqual(out.ruledOut, ["sphinx/pycode/ast.py::unparse"]);
  assert.deepEqual(out.ruleOutConflicts, []);
  assert.equal(out.correctivePromptSent, false);
});

test("M16: problem-statement fallback flags a symbol conflict only when no FAIL_TO_PASS exists", () => {
  const cand = { path: "sphinx/pycode/ast.py", symbol: "unparse", role: "non_lead_pivot" } as const;
  assert.equal(
    detectRuleOutConflict(cand, te(["tests/test_x.py::test_y"], "the unparse helper drops the empty tuple")),
    null,
  );
  const c = detectRuleOutConflict(cand, te([], "the unparse helper drops the empty tuple"));
  assert.ok(c !== null);
  assert.match(c!.evidence.join(" "), /problem statement/);
});

test("M16: compliance with a test expectation is deterministic", () => {
  const input = {
    enabled: true,
    contract: contractWith("sphinx/pycode/ast.py", "unparse"),
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["sphinx/pycode/ast.py"],
    decisions: [{ path: "sphinx/pycode/ast.py", decision: "RULED_OUT", evidence: GROUNDED }],
    testExpectation: te(["tests/test_pycode_ast.py::test_unparse[()-()]"]),
  } as const;
  assert.deepEqual(
    computePivotInspectionCompliance(input),
    computePivotInspectionCompliance(input),
  );
});
