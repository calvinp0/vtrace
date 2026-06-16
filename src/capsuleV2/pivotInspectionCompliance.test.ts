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
  type PivotDecisionMarker,
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
