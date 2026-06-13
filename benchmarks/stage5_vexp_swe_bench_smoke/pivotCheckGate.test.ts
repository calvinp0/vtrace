import assert from "node:assert/strict";
import { test } from "bun:test";

import type {
  InspectionToolCall,
  PivotForInspection,
} from "../../src/capsule/finalEditDiagnostics";
import {
  buildApprovedChecklistSummary,
  buildPivotCheckPreflightPrompt,
  decidePhase2,
  evaluatePivotCheckGate,
  type PivotCheckGateInput,
} from "./pivotCheckGate";

const PIVOTS: PivotForInspection[] = [
  { path: "lib/a.py", symbol: "convert", role: "pivot", hidden: false },
  { path: "lib/b.py", symbol: "update", role: "pivot", hidden: true },
];

// A well-formed Phase-1 response: PIVOT_CHECK table accounting for both pivots,
// plus a neighborhood_use block.
function compliantText(): string {
  return [
    "I inspected the pivots.",
    "## PIVOT_CHECK",
    "| pivot | symbol | inspected | relevant | edit_needed | reason |",
    "|---|---|---:|---:|---:|---|",
    "| lib/a.py | convert | yes | yes | yes | root cause here |",
    "| lib/b.py | update | yes | no | no | inspected, not the cause |",
    "",
    "neighborhood_use:",
    "- used: lib/c.py::helper",
    "- ruled_out: lib/d.py::unrelated",
  ].join("\n");
}

function reads(paths: string[]): InspectionToolCall[] {
  return paths.map((p) => ({ tool: "read", target: p }));
}

function input(over: Partial<PivotCheckGateInput> = {}): PivotCheckGateInput {
  return {
    assistantText: compliantText(),
    toolCalls: reads(["lib/a.py", "lib/b.py"]),
    editedFiles: [],
    pivots: PIVOTS,
    neighborhoodExcerptCount: 3,
    neighborhoodIdentifiers: ["lib/c.py"],
    phase1Tokens: 1200,
    ...over,
  };
}

test("valid checklist with matching reads passes the gate", () => {
  const gate = evaluatePivotCheckGate(input());
  assert.equal(gate.pivotCheckGatePassed, true);
  assert.deepEqual(gate.failReasons, []);
  assert.equal(gate.checklistEmitted, true);
  assert.equal(gate.pivotCheckRowsParsed, 2);
  assert.equal(gate.pivotsInspected, 2);
  assert.equal(gate.pivotsRuledOut, 1); // b.py inspected + edit_needed=no
  assert.equal(gate.claimedInspectedWithoutRead, 0);
  assert.equal(gate.checklistToolAgreement, 1);
  assert.equal(gate.neighborhoodMentioned, true);
  assert.equal(gate.neighborhoodUseParsed, true);
  assert.equal(gate.phase1ToolCalls, 2);
  assert.equal(gate.phase1Tokens, 1200);
});

test("missing checklist fails the gate", () => {
  const gate = evaluatePivotCheckGate(
    input({ assistantText: "I will just patch lib/a.py directly." }),
  );
  assert.equal(gate.pivotCheckGatePassed, false);
  assert.ok(gate.failReasons.includes("checklist_not_emitted"));
  assert.ok(gate.failReasons.includes("no_checklist_rows"));
});

test("checklist that claims inspected but never Read fails the gate", () => {
  // Both rows claim inspected=yes, but only a.py was actually opened.
  const gate = evaluatePivotCheckGate(input({ toolCalls: reads(["lib/a.py"]) }));
  assert.equal(gate.pivotCheckGatePassed, false);
  assert.equal(gate.claimedInspectedWithoutRead, 1); // b.py false claim
  assert.ok(gate.failReasons.some((r) => r.startsWith("claimed_inspected_without_read")));
});

test("neighborhood not mentioned fails when excerpts were provided", () => {
  // A checklist with no neighborhood_use block and no neighborhood reference.
  const text = [
    "## PIVOT_CHECK",
    "| pivot | symbol | inspected | relevant | edit_needed | reason |",
    "|---|---|---:|---:|---:|---|",
    "| lib/a.py | convert | yes | yes | yes | root cause |",
    "| lib/b.py | update | yes | no | no | not the cause |",
  ].join("\n");
  const gate = evaluatePivotCheckGate(
    input({ assistantText: text, neighborhoodIdentifiers: [] }),
  );
  assert.equal(gate.pivotCheckGatePassed, false);
  assert.ok(gate.failReasons.includes("neighborhood_not_mentioned"));
  assert.ok(gate.failReasons.includes("neighborhood_use_not_parsed"));

  // With no neighborhood excerpts provided, the neighborhood requirement is moot.
  const noNbhd = evaluatePivotCheckGate(
    input({ assistantText: text, neighborhoodExcerptCount: 0, neighborhoodIdentifiers: [] }),
  );
  assert.equal(noNbhd.pivotCheckGatePassed, true);
});

test("editing a file during the inspect-only phase is a gate violation", () => {
  const gate = evaluatePivotCheckGate(input({ editedFiles: ["lib/a.py"] }));
  assert.equal(gate.pivotCheckGatePassed, false);
  assert.ok(gate.failReasons.some((r) => r.startsWith("edit_before_gate")));
});

test("every pivot must be accounted for by a checklist row", () => {
  // Only a.py has a row; the hidden b.py is omitted.
  const text = [
    "## PIVOT_CHECK",
    "| pivot | symbol | inspected | relevant | edit_needed | reason |",
    "|---|---|---:|---:|---:|---|",
    "| lib/a.py | convert | yes | yes | yes | root cause |",
    "neighborhood_use:",
    "- used: lib/c.py",
    "- ruled_out: none",
  ].join("\n");
  const gate = evaluatePivotCheckGate(input({ assistantText: text }));
  assert.equal(gate.pivotCheckGatePassed, false);
  assert.ok(gate.failReasons.some((r) => r.startsWith("pivots_unaccounted")));
});

test("phase 2 is skipped on a failed gate and started on a passing gate", () => {
  const failed = evaluatePivotCheckGate(input({ assistantText: "no checklist" }));
  const skip = decidePhase2(failed);
  assert.equal(skip.phase2Started, false);
  assert.match(skip.phase2SkippedReason ?? "", /pivot_check_gate_failed/);

  const passed = evaluatePivotCheckGate(input());
  const go = decidePhase2(passed);
  assert.equal(go.phase2Started, true);
  assert.equal(go.phase2SkippedReason, null);
});

test("the approved checklist summary carries the Phase-1 analysis into Phase 2", () => {
  const gate = evaluatePivotCheckGate(input());
  const summary = buildApprovedChecklistSummary(gate);
  assert.match(summary, /APPROVED_PIVOT_CHECK/);
  assert.match(summary, /lib\/a\.py: inspected=yes, edit_needed=yes/);
  assert.match(summary, /lib\/b\.py: inspected=yes, edit_needed=no/);
  assert.match(summary, /neighborhood used: lib\/c\.py::helper/);
  assert.match(summary, /neighborhood ruled out: lib\/d\.py::unrelated/);
  assert.match(summary, /smallest correct patch/);
});

test("the preflight prompt is inspect-only and seeds a row per pivot", () => {
  const prompt = buildPivotCheckPreflightPrompt(PIVOTS, 3);
  assert.match(prompt, /INSPECTION-ONLY/);
  assert.match(prompt, /Do NOT edit, write, or patch/);
  assert.match(prompt, /\| lib\/a\.py \| convert \|/);
  assert.match(prompt, /\| lib\/b\.py \| update \|/);
  assert.match(prompt, /neighborhood_use:/);
  assert.match(prompt, /Do not produce a patch in this phase/);

  // No neighborhood → no neighborhood_use requirement line.
  const noNbhd = buildPivotCheckPreflightPrompt(PIVOTS, 0);
  assert.doesNotMatch(noNbhd, /neighborhood_use:/);
});
