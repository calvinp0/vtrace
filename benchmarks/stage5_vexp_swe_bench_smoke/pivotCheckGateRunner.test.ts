import assert from "node:assert/strict";
import { test } from "bun:test";

import type { InspectionToolCall, PivotForInspection } from "../../src/capsule/finalEditDiagnostics";
import { parseArgs } from "./run_stage5_vexp_swe_bench_smoke";
import {
  describeHardGateOutcome,
  hardGateMetaFields,
  orchestrateHardGate,
  type HardGatePhase1Outcome,
  type HardGatePhase2Outcome,
} from "./pivotCheckGateRunner";

const PIVOTS: PivotForInspection[] = [
  { path: "lib/a.py", symbol: "convert", role: "pivot", hidden: false },
  { path: "lib/b.py", symbol: "update", role: "pivot", hidden: true },
];

// A compliant Phase-1 transcript: a PIVOT_CHECK table accounting for both pivots
// plus a neighborhood_use block.
function compliantText(): string {
  return [
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

function phase1(over: Partial<HardGatePhase1Outcome> = {}): HardGatePhase1Outcome {
  return {
    assistantText: compliantText(),
    toolCalls: reads(["lib/a.py", "lib/b.py"]),
    editedFiles: [],
    phase1Tokens: 1200,
    streamFile: "/out/_agent_phase1_pivot_check_stream.jsonl",
    promptFile: "/out/_vtrace_pivot_check_preflight.md",
    ...over,
  };
}

function phase2(over: Partial<HardGatePhase2Outcome> = {}): HardGatePhase2Outcome {
  return {
    streamFile: "/out/_agent_phase2_solve_stream.jsonl",
    promptFile: "/out/_vtrace_instructions.md",
    solveCompleted: true,
    dockerEvaluated: true,
    resolved: true,
    ...over,
  };
}

// A spy harness: records whether each phase ran and what Phase 2 received.
function spyDeps(p1: HardGatePhase1Outcome, p2: HardGatePhase2Outcome = phase2()) {
  const calls = { phase1Ran: false, phase2Ran: false, approvedSummary: null as string | null };
  return {
    calls,
    deps: {
      pivots: PIVOTS,
      neighborhoodExcerptCount: 3,
      neighborhoodIdentifiers: ["lib/c.py"],
      runPhase1: async () => {
        calls.phase1Ran = true;
        return p1;
      },
      runPhase2: async (summary: string) => {
        calls.phase2Ran = true;
        calls.approvedSummary = summary;
        return p2;
      },
    },
  };
}

test("a passing Phase 1 starts Phase 2", async () => {
  const { calls, deps } = spyDeps(phase1());
  const result = await orchestrateHardGate(deps);
  assert.equal(calls.phase1Ran, true);
  assert.equal(calls.phase2Ran, true);
  assert.equal(result.gate.pivotCheckGatePassed, true);
  assert.equal(result.phase2Started, true);
  assert.equal(result.phase2SkippedReason, null);
  assert.equal(result.status, "docker_evaluated");
  assert.notEqual(result.phase2, null);
});

test("a failing Phase 1 skips Phase 2 entirely (no solve, no Docker)", async () => {
  const { calls, deps } = spyDeps(phase1({ assistantText: "I'll just patch lib/a.py." }));
  const result = await orchestrateHardGate(deps);
  assert.equal(calls.phase1Ran, true);
  assert.equal(calls.phase2Ran, false); // Phase 2 must never run
  assert.equal(result.status, "gate_failed");
  assert.equal(result.phase2Started, false);
  assert.equal(result.phase2, null);
  assert.match(result.phase2SkippedReason ?? "", /pivot_check_gate_failed/);
});

test("a missing checklist produces a gate_failed result", async () => {
  const { deps } = spyDeps(phase1({ assistantText: "no checklist at all" }));
  const result = await orchestrateHardGate(deps);
  assert.equal(result.status, "gate_failed");
  assert.ok(result.gate.failReasons.includes("checklist_not_emitted"));
  const meta = hardGateMetaFields(result);
  assert.equal(meta.pivotCheckGatePassed, false);
  assert.equal(meta.phase2Started, false);
});

test("claimed-inspected-without-read produces a gate_failed result", async () => {
  // Both rows claim inspected=yes but only a.py was actually opened.
  const { calls, deps } = spyDeps(phase1({ toolCalls: reads(["lib/a.py"]) }));
  const result = await orchestrateHardGate(deps);
  assert.equal(result.status, "gate_failed");
  assert.equal(calls.phase2Ran, false);
  assert.equal(result.gate.claimedInspectedWithoutRead, 1);
  assert.ok(result.gate.failReasons.some((r) => r.startsWith("claimed_inspected_without_read")));
});

test("a Phase-1 edit/write violation produces a gate_failed result", async () => {
  const { calls, deps } = spyDeps(phase1({ editedFiles: ["lib/a.py"] }));
  const result = await orchestrateHardGate(deps);
  assert.equal(result.status, "gate_failed");
  assert.equal(calls.phase2Ran, false);
  assert.ok(result.gate.failReasons.some((r) => r.startsWith("edit_before_gate")));
});

test("Phase 2 receives the approved checklist summary built from Phase 1", async () => {
  const { calls, deps } = spyDeps(phase1());
  const result = await orchestrateHardGate(deps);
  assert.notEqual(calls.approvedSummary, null);
  // The summary handed to Phase 2 is exactly the orchestrator's approved summary.
  assert.equal(calls.approvedSummary, result.approvedChecklistSummary);
  assert.match(calls.approvedSummary ?? "", /APPROVED_PIVOT_CHECK/);
  assert.match(calls.approvedSummary ?? "", /lib\/a\.py: inspected=yes, edit_needed=yes/);
});

test("Phase 1 and Phase 2 streams/prompts are not mixed", async () => {
  const { deps } = spyDeps(phase1());
  const result = await orchestrateHardGate(deps);
  assert.notEqual(result.phase1.streamFile, result.phase2?.streamFile);
  assert.notEqual(result.phase1.promptFile, result.phase2?.promptFile);
  const meta = hardGateMetaFields(result);
  assert.match(meta.phase1StreamFile, /_agent_phase1_pivot_check_stream\.jsonl$/);
  assert.match(meta.phase2StreamFile ?? "", /_agent_phase2_solve_stream\.jsonl$/);
  assert.notEqual(meta.phase1StreamFile, meta.phase2StreamFile);
});

test("the default Stage 5 run path is unchanged (hard gate is opt-in)", () => {
  const base = ["--mode", "run-protocol", "--protocol", "vtrace-indexed"];
  const def = parseArgs(base);
  assert.equal(def.pivotCheckGate, "off");
  const hard = parseArgs([...base, "--pivot-check-gate", "hard"]);
  assert.equal(hard.pivotCheckGate, "hard");
  assert.throws(() => parseArgs([...base, "--pivot-check-gate", "bogus"]), /Invalid --pivot-check-gate/);
});

test("the report phrases a gate_failed run as an enforcement block, not a failed patch", () => {
  const blocked = describeHardGateOutcome({
    pivotCheckGateStatus: "gate_failed",
    pivotCheckGateFailReasons: ["checklist_not_emitted", "no_checklist_rows"],
  });
  assert.match(blocked, /enforcement gate BLOCKED the solve/);
  assert.match(blocked, /not a failed patch/);
  assert.match(blocked, /no Docker evaluation/);
  assert.match(blocked, /checklist_not_emitted/);

  // A passing, evaluated run reads as resolved/unresolved.
  assert.match(
    describeHardGateOutcome({ pivotCheckGateStatus: "docker_evaluated", phase2Resolved: true }),
    /resolved/,
  );
  assert.match(
    describeHardGateOutcome({ pivotCheckGateStatus: "docker_evaluated", phase2Resolved: false }),
    /unresolved/,
  );
});
