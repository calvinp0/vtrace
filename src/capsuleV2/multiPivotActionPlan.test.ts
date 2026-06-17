// Tests for the M35 Multi-Pivot Action Plan — the compact, first-pass "required
// inspection set" rendered at the top of the capsule. These exercise the pure
// builder/renderer over hand-built pivot + co-edit-hint inputs; they touch no
// retrieval, scoring, or role behaviour, and reference no gold/oracle data.
//
// The plan exists because M32/M34 found the genuine multi-pivot failure is
// context-to-action: the secondary co-edit pivot is already in the injected block
// but framed as supporting/optional and buried, so the agent edits the lead and
// stops. The plan raises that secondary pivot's salience without adding evidence,
// changing retrieval, or enabling enforcement.

import assert from "node:assert/strict";
import { test } from "bun:test";

import type { ActionabilityHint } from "./actionabilityHints";
import {
  MULTI_PIVOT_ACTION_PLAN_ENV,
  MULTI_PIVOT_ACTION_PLAN_HEADING,
  buildMultiPivotActionPlan,
  multiPivotActionPlanEnabled,
  renderMultiPivotActionPlanText,
} from "./multiPivotActionPlan";
import type { ContractPivotView } from "./pivotInspectionContract";

function pivot(path: string, symbol: string, reason: string): ContractPivotView {
  return { path, symbol, evidence: [reason] };
}

function coeditHint(sourceFile: string, relatedFiles: string[]): ActionabilityHint {
  return {
    kind: "multi_file_coedit",
    sourceFile,
    relatedFile: relatedFiles[0]!,
    relatedFiles,
    confidence: "high",
    evidence: ["pivots span separate modules — coordinated fix likely"],
    hint: "inspect each co-edit candidate and edit or rule it out",
    patchObligation: {
      kind: "consider_coedit_files_in_final_diff",
      text: "include all required co-edits in the final diff",
    },
  };
}

function render(
  pivots: ContractPivotView[],
  hints: ActionabilityHint[] = [],
): string {
  return renderMultiPivotActionPlanText(buildMultiPivotActionPlan(pivots, hints)).join("\n");
}

// 1. No plan for single localized / no-context tasks.
test("1. single-pivot, no co-edit hint → no action plan", () => {
  const plan = buildMultiPivotActionPlan(
    [pivot("a/lead.py", "fix", "the obvious edit site")],
    [],
  );
  assert.equal(plan, null);
  assert.equal(render([pivot("a/lead.py", "fix", "x")]), "");
});

// 2. The plan renders when a co-edit hint exists, even for a single pivot.
test("2. single pivot + multi_file_coedit hint → action plan renders", () => {
  const plan = buildMultiPivotActionPlan(
    [pivot("a/lead.py", "fix", "the lead site")],
    [coeditHint("a/lead.py", ["b/other.py"])],
  );
  assert.notEqual(plan, null);
  assert.equal(plan!.hasCoedit, true);
  const text = render([pivot("a/lead.py", "fix", "the lead site")], [coeditHint("a/lead.py", ["b/other.py"])]);
  assert.ok(text.includes(MULTI_PIVOT_ACTION_PLAN_HEADING));
  assert.ok(text.includes("b/other.py"));
});

// 3. The plan includes both the primary (lead) and a secondary pivot.
test("3. action plan includes primary and secondary pivots", () => {
  const plan = buildMultiPivotActionPlan(
    [pivot("a/lead.py", "lead", "lead reason"), pivot("b/second.py", "second", "second reason")],
    [],
  )!;
  assert.equal(plan.entries[0]!.role, "lead");
  assert.equal(plan.entries[0]!.file, "a/lead.py");
  assert.ok(plan.entries.some((e) => e.file === "b/second.py" && e.role === "pivot"));
});

// 4. The plan is bounded to at most 3 required pivots (lead included).
test("4. action plan is bounded to max 3 pivots", () => {
  const pivots = [
    pivot("a/lead.py", "lead", "r0"),
    pivot("b/p1.py", "p1", "r1"),
    pivot("c/p2.py", "p2", "r2"),
    pivot("d/p3.py", "p3", "r3"),
    pivot("e/p4.py", "p4", "r4"),
  ];
  const plan = buildMultiPivotActionPlan(pivots, [])!;
  assert.ok(plan.entries.length <= 3, `expected ≤3 entries, got ${plan.entries.length}`);
  assert.equal(plan.entries[0]!.role, "lead");
});

// 5. The plan does not duplicate source excerpts: it renders compact one-line
// entries, never a pivot's source body (no code fences; every line stays short).
test("5. action plan carries no source excerpts", () => {
  const text = render(
    [
      pivot("a/lead.py", "lead", "issue source anchor maps here"),
      pivot("b/second.py", "second", "symbol-name match; exercised by a failing test"),
    ],
    [],
  );
  // No markdown code fences (no source block).
  assert.ok(!text.includes("```"));
  // Every line is a compact single line — a source body would produce long/indented
  // code lines. The longest reason is clipped to 90 chars; entries add the file id.
  for (const line of text.split("\n")) {
    assert.ok(line.length <= 160, `unexpectedly long line (${line.length}): ${line}`);
  }
  // Whole section stays compact.
  assert.ok(text.length < 600, `expected compact section, got ${text.length} chars`);
});

// 6. Inspect / edit-or-rule-out wording WITHOUT hard enforcement.
test("6. edit-or-rule-out wording without enforcement markers", () => {
  const text = render(
    [pivot("a/lead.py", "lead", "lead reason"), pivot("b/second.py", "second", "second reason")],
    [],
  );
  assert.ok(text.toLowerCase().includes("inspect each required pivot"));
  assert.ok(text.toLowerCase().includes("rule"));
  // Must NOT cross into the M12 enforcement contract.
  assert.ok(!text.includes("PIVOT_DECISION"));
  assert.ok(!text.includes("Required pivot check before final patch"));
  assert.ok(!text.toUpperCase().includes("REQUIRED DECISION"));
});

// 7. Sphinx-like fixture: secondary ast.py::unparse pivot appears when evidence exists.
test("7. sphinx-like: secondary ast.py::unparse co-edit appears in the plan", () => {
  const pivots = [
    pivot("sphinx/domains/python.py", "_parse_annotation", "issue source anchor maps here"),
    pivot("sphinx/pycode/ast.py", "unparse", "symbol-name match; exercised by a failing test"),
  ];
  const plan = buildMultiPivotActionPlan(pivots, [])!;
  const text = renderMultiPivotActionPlanText(plan).join("\n");
  assert.ok(text.includes("sphinx/pycode/ast.py::unparse"));
  assert.ok(text.includes("sphinx/domains/python.py::_parse_annotation"));
  // Lead is the issue-anchored site; ast.py is the secondary inspection target.
  assert.equal(plan.entries[0]!.file, "sphinx/domains/python.py");
  assert.ok(plan.entries.some((e) => e.file === "sphinx/pycode/ast.py" && e.role !== "lead"));
});

// 8. Seaborn-like fixture: secondary co-edit pivot appears when a co-edit hint exists.
test("8. seaborn-like: secondary co-edit candidate appears in the plan", () => {
  const pivots = [pivot("seaborn/_core/scales.py", "_setup", "issue source anchor maps here")];
  const hints = [coeditHint("seaborn/_core/scales.py", ["seaborn/utils.py"])];
  const plan = buildMultiPivotActionPlan(pivots, hints)!;
  const text = renderMultiPivotActionPlanText(plan).join("\n");
  assert.ok(text.includes("seaborn/_core/scales.py::_setup"));
  assert.ok(text.includes("seaborn/utils.py"));
  assert.ok(plan.entries.some((e) => e.file === "seaborn/utils.py" && e.role === "related_coedit"));
});

// 9. The numbered inspection set is rendered with role tags and reasons (structure).
test("9. inspection set renders numbered entries with role + reason", () => {
  const text = render(
    [pivot("a/lead.py", "lead", "lead reason here"), pivot("b/second.py", "second", "second reason here")],
    [],
  );
  assert.ok(text.includes("1. a/lead.py::lead (lead pivot) — lead reason here"));
  assert.ok(text.includes("2. b/second.py::second (pivot) — second reason here"));
});

// 10. Reasons are clipped (no unbounded blow-up from a long evidence string).
test("10. long reasons are clipped to keep the section compact", () => {
  const longReason = "x ".repeat(200).trim();
  const plan = buildMultiPivotActionPlan(
    [pivot("a/lead.py", "lead", "short"), pivot("b/second.py", "second", longReason)],
    [],
  )!;
  const secondary = plan.entries.find((e) => e.file === "b/second.py")!;
  assert.ok(secondary.reason.length <= 90, `reason too long: ${secondary.reason.length}`);
});

// 11. A co-edit candidate already present as a pivot is not double-listed.
test("11. co-edit file that is already a pivot is not duplicated", () => {
  const pivots = [pivot("a/lead.py", "lead", "r0"), pivot("b/second.py", "second", "r1")];
  // The hint's related file IS the existing second pivot — must appear once.
  const plan = buildMultiPivotActionPlan(pivots, [coeditHint("a/lead.py", ["b/second.py"])])!;
  const occurrences = plan.entries.filter((e) => e.file === "b/second.py").length;
  assert.equal(occurrences, 1);
});

// --- M36.1 env toggle (isolated via an injected env map; no process.env mutation) ---

const ON = MULTI_PIVOT_ACTION_PLAN_ENV;

// 12. Unset env → enabled (default ON, preserves M35 behavior).
test("12. toggle: unset env is enabled (default ON)", () => {
  assert.equal(multiPivotActionPlanEnabled({}), true);
});

// 13. Explicit falsy values suppress (0 / false / off, case- and space-insensitive).
test("13. toggle: 0 / false / off (any case, trimmed) suppress", () => {
  for (const v of ["0", "false", "off", "FALSE", "Off", "  0 ", "OFF"]) {
    assert.equal(multiPivotActionPlanEnabled({ [ON]: v }), false, `"${v}" should disable`);
  }
});

// 14. Truthy / unrecognized values preserve rendering.
test("14. toggle: truthy/unrecognized values stay enabled", () => {
  for (const v of ["1", "true", "on", "yes", "enabled", ""]) {
    assert.equal(multiPivotActionPlanEnabled({ [ON]: v }), true, `"${v}" should stay enabled`);
  }
});
