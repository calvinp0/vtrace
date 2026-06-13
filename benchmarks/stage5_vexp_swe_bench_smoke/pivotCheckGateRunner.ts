// Live two-phase orchestration for the hard context-to-action gate.
//
// `pivotCheckGate.ts` is the PURE decision core (evaluate a Phase-1 transcript →
// pass/fail + approved summary). This module wraps it in the deterministic
// two-phase SEQUENCING the live Stage 5 harness needs, while staying decoupled
// from the heavyweight harness internals (external CLI spawn, Docker eval) via
// injected `runPhase1`/`runPhase2` callbacks. The harness provides real callbacks
// that spawn `claude -p`; tests provide fakes. The contract the orchestrator
// guarantees — and that the tests pin — is the HARD STOP:
//
//   Phase 1 (inspect-only preflight)  →  evaluatePivotCheckGate  →
//     gate FAILED → status "gate_failed", phase2 NEVER invoked (no solve, no Docker)
//     gate PASSED → approved summary built → Phase 2 (solve) invoked exactly once
//
// Two separate `claude -p` invocations by design (a clean, deterministic gate over
// a single mid-run checkpoint): Phase 1 and Phase 2 each own a distinct stream and
// prompt file, so their transcripts are never mixed.

import {
  buildApprovedChecklistSummary,
  buildPivotCheckPreflightPrompt,
  decidePhase2,
  evaluatePivotCheckGate,
  type PivotCheckGateResult,
} from "./pivotCheckGate";
import type { InspectionToolCall, PivotForInspection } from "../../src/capsule/finalEditDiagnostics";

// The parsed Phase-1 (inspect-only) transcript. `editedFiles` are any files the
// preflight agent patched despite the inspect-only instruction — a non-empty list
// is itself a gate violation. `streamFile`/`promptFile` are the phase-1-only
// artifact paths, kept so the result can prove the two phases were not mixed.
export interface HardGatePhase1Outcome {
  readonly assistantText: string;
  readonly toolCalls: readonly InspectionToolCall[];
  readonly editedFiles: readonly string[];
  readonly phase1Tokens: number | null;
  readonly streamFile: string;
  readonly promptFile: string;
}

// The Phase-2 (solve) outcome. Opaque to the orchestrator beyond the progress
// flags it reports, so the same orchestrator drives both the real spawn+evaluate
// and the test fake. `solveCompleted`/`dockerEvaluated` derive the report status;
// `resolved` is null until Docker actually evaluated the patch.
export interface HardGatePhase2Outcome {
  readonly streamFile: string;
  readonly promptFile: string;
  readonly solveCompleted: boolean;
  readonly dockerEvaluated: boolean;
  readonly resolved: boolean | null;
}

export interface HardGateOrchestrationDeps {
  readonly pivots: readonly PivotForInspection[];
  readonly neighborhoodExcerptCount: number;
  readonly neighborhoodIdentifiers: readonly string[];
  // Run Phase 1 (inspect-only): the orchestrator hands over the preflight prompt;
  // the caller injects it alongside the normal Capsule v2 context, spawns the
  // agent against a phase-1-only stream file, and returns the parsed transcript.
  readonly runPhase1: (preflightPrompt: string) => Promise<HardGatePhase1Outcome>;
  // Run Phase 2 (solve): invoked ONLY on a passing gate. The caller injects the
  // normal context + the approved checklist summary, spawns against a
  // phase-2-only stream file, solves, and (when configured) runs Docker eval.
  readonly runPhase2: (approvedChecklistSummary: string) => Promise<HardGatePhase2Outcome>;
}

// The run's coarse outcome, ordered from earliest stop to fullest completion. The
// report uses this to phrase a gate_failed run as an ENFORCEMENT BLOCK rather than
// a failed patch solve.
export type HardGateStatus = "gate_failed" | "solve_started" | "solve_completed" | "docker_evaluated";

export interface HardGateRunResult {
  readonly status: HardGateStatus;
  readonly gate: PivotCheckGateResult;
  readonly phase2Started: boolean;
  readonly phase2SkippedReason: string | null;
  readonly approvedChecklistSummary: string | null;
  readonly preflightPrompt: string;
  readonly phase1: HardGatePhase1Outcome;
  readonly phase2: HardGatePhase2Outcome | null;
}

// Drive the two-phase gate. Pure control flow over the injected callbacks:
//   1. Build the inspect-only preflight prompt from the pivots + neighborhood count.
//   2. runPhase1 → evaluatePivotCheckGate.
//   3. On a FAILED gate, return immediately with status "gate_failed" — runPhase2
//      is never called, so no solve and no Docker evaluation can happen.
//   4. On a PASSED gate, build the approved checklist summary and runPhase2 once.
export async function orchestrateHardGate(deps: HardGateOrchestrationDeps): Promise<HardGateRunResult> {
  const preflightPrompt = buildPivotCheckPreflightPrompt(deps.pivots, deps.neighborhoodExcerptCount);
  const phase1 = await deps.runPhase1(preflightPrompt);
  const gate = evaluatePivotCheckGate({
    assistantText: phase1.assistantText,
    toolCalls: phase1.toolCalls,
    editedFiles: phase1.editedFiles,
    pivots: deps.pivots,
    neighborhoodExcerptCount: deps.neighborhoodExcerptCount,
    neighborhoodIdentifiers: deps.neighborhoodIdentifiers,
    phase1Tokens: phase1.phase1Tokens,
  });
  const decision = decidePhase2(gate);
  if (!decision.phase2Started) {
    return {
      status: "gate_failed",
      gate,
      phase2Started: false,
      phase2SkippedReason: decision.phase2SkippedReason,
      approvedChecklistSummary: null,
      preflightPrompt,
      phase1,
      phase2: null,
    };
  }
  const approvedChecklistSummary = buildApprovedChecklistSummary(gate);
  const phase2 = await deps.runPhase2(approvedChecklistSummary);
  const status: HardGateStatus = phase2.dockerEvaluated
    ? "docker_evaluated"
    : phase2.solveCompleted
      ? "solve_completed"
      : "solve_started";
  return {
    status,
    gate,
    phase2Started: true,
    phase2SkippedReason: null,
    approvedChecklistSummary,
    preflightPrompt,
    phase1,
    phase2,
  };
}

// The flat run-meta fields persisted for a hard-gate run. Field names mirror the
// gate report fields the spec asks for so the harness can spread them directly
// into `_run.meta.json`.
export interface HardGateMetaFields {
  readonly pivotCheckGateMode: "hard";
  readonly pivotCheckGateStatus: HardGateStatus;
  readonly pivotCheckGatePassed: boolean;
  readonly pivotCheckRowsParsed: number;
  readonly checklistEmitted: boolean;
  readonly checklistToolAgreement: number | null;
  readonly claimedInspectedWithoutRead: number;
  readonly pivotsInspected: number;
  readonly pivotsRuledOut: number;
  readonly neighborhoodMentioned: boolean;
  readonly neighborhoodUseParsed: boolean;
  readonly phase1ToolCalls: number;
  readonly phase1Tokens: number | null;
  readonly phase2Started: boolean;
  readonly phase2SkippedReason: string | null;
  readonly pivotCheckGateFailReasons: readonly string[];
  readonly phase1StreamFile: string;
  readonly phase1PromptFile: string;
  readonly phase2StreamFile: string | null;
  readonly phase2PromptFile: string | null;
  readonly phase2Resolved: boolean | null;
}

export function hardGateMetaFields(result: HardGateRunResult): HardGateMetaFields {
  return {
    pivotCheckGateMode: "hard",
    pivotCheckGateStatus: result.status,
    pivotCheckGatePassed: result.gate.pivotCheckGatePassed,
    pivotCheckRowsParsed: result.gate.pivotCheckRowsParsed,
    checklistEmitted: result.gate.checklistEmitted,
    checklistToolAgreement: result.gate.checklistToolAgreement,
    claimedInspectedWithoutRead: result.gate.claimedInspectedWithoutRead,
    pivotsInspected: result.gate.pivotsInspected,
    pivotsRuledOut: result.gate.pivotsRuledOut,
    neighborhoodMentioned: result.gate.neighborhoodMentioned,
    neighborhoodUseParsed: result.gate.neighborhoodUseParsed,
    phase1ToolCalls: result.gate.phase1ToolCalls,
    phase1Tokens: result.gate.phase1Tokens,
    phase2Started: result.phase2Started,
    phase2SkippedReason: result.phase2SkippedReason,
    pivotCheckGateFailReasons: result.gate.failReasons,
    phase1StreamFile: result.phase1.streamFile,
    phase1PromptFile: result.phase1.promptFile,
    phase2StreamFile: result.phase2?.streamFile ?? null,
    phase2PromptFile: result.phase2?.promptFile ?? null,
    phase2Resolved: result.phase2?.resolved ?? null,
  };
}

// The minimal meta shape the report needs to phrase a hard-gate outcome. Accepts a
// loose record so the report can pass a parsed `_run.meta.json` without re-typing.
export interface HardGateOutcomeMeta {
  readonly pivotCheckGateStatus?: unknown;
  readonly pivotCheckGateFailReasons?: unknown;
  readonly phase2Resolved?: unknown;
}

// Phrase a hard-gate run for the report. The point of this helper is that a
// `gate_failed` run is NOT a failed patch solve — the enforcement gate blocked the
// solve before it ran — so the report must never tally it as an unresolved patch.
export function describeHardGateOutcome(meta: HardGateOutcomeMeta): string {
  const status = typeof meta.pivotCheckGateStatus === "string" ? meta.pivotCheckGateStatus : null;
  switch (status) {
    case "gate_failed": {
      const reasons = Array.isArray(meta.pivotCheckGateFailReasons)
        ? meta.pivotCheckGateFailReasons.filter((r): r is string => typeof r === "string")
        : [];
      const why = reasons.length > 0 ? `: ${reasons.join("; ")}` : "";
      return `enforcement gate BLOCKED the solve${why} (not a failed patch — Phase 2 never ran, no Docker evaluation)`;
    }
    case "solve_started":
      return "gate passed; solve started (no completion signal captured)";
    case "solve_completed":
      return "gate passed; solve completed; not Docker-evaluated";
    case "docker_evaluated":
      return meta.phase2Resolved === true
        ? "gate passed; solve completed; Docker evaluated: resolved"
        : "gate passed; solve completed; Docker evaluated: unresolved";
    default:
      return "no hard-gate outcome recorded";
  }
}
