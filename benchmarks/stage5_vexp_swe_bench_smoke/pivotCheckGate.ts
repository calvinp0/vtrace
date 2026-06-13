// Hard context-to-action gate for the Stage 5 product-v2 enforcement path.
//
// The matplotlib canary proved that a SOFT injected PIVOT_CHECK is not enough:
// the checklist reached the agent, but the agent emitted no checklist rows and
// never mentioned the neighborhood, while tokens rose. This module turns that
// soft instruction into a HARD two-phase gate:
//
//   Phase 1 (preflight): the agent is asked ONLY to inspect/account for the
//   Capsule v2 pivots + pivotNeighborhood excerpts and emit a structured
//   PIVOT_CHECK table + neighborhood_use accounting. It must NOT patch yet.
//   `evaluatePivotCheckGate` then verifies the emitted checklist against the
//   ordered tool calls: claimed inspections must match real Read/open calls, and
//   (when neighborhood excerpts were provided) the neighborhood must be addressed.
//
//   Phase 2 (solve): runs ONLY when the gate passes. The approved checklist
//   summary is carried into the solve prompt; then the agent patches normally and
//   normal token/cost/tool/resolution telemetry is collected.
//
// This module is PURE (no I/O, no agent invocation): it takes the Phase-1
// transcript signals in and produces a deterministic gate result + the Phase-2
// decision + the approved-summary text. The harness wires the live agent run
// around it. It changes no retrieval, no Capsule v2 ranking, and is opt-in.

import {
  checklistToolAgreement,
  classifyPivotInspection,
  parseNeighborhoodUse,
  parsePivotCheckRows,
  type InspectionToolCall,
  type NeighborhoodUse,
  type PivotCheckRow,
  type PivotForInspection,
  type PivotInspectionRecord,
} from "../../src/capsule/finalEditDiagnostics";
import { PIVOT_CHECK_MARKER, neighborhoodMentionInText } from "../../src/capsule/toolCallLog";

// Raw Phase-1 transcript signals the gate evaluates. `editedFiles` are any files
// the Phase-1 agent already patched — Phase 1 is inspect-only, so a non-empty
// list is itself a violation (edit before the gate passed).
export interface PivotCheckGateInput {
  readonly assistantText: string;
  readonly toolCalls: readonly InspectionToolCall[];
  readonly editedFiles: readonly string[];
  readonly pivots: readonly PivotForInspection[];
  readonly neighborhoodExcerptCount: number;
  readonly neighborhoodIdentifiers?: readonly string[];
  readonly phase1Tokens?: number | null;
}

// Deterministic gate verdict. Field names mirror the report fields the spec asks
// for so the harness can surface them directly.
export interface PivotCheckGateResult {
  readonly pivotCheckGatePassed: boolean;
  readonly checklistEmitted: boolean;
  readonly pivotCheckRowsParsed: number;
  readonly checklistToolAgreement: number | null;
  readonly claimedInspectedWithoutRead: number;
  readonly pivotsInspected: number;
  readonly pivotsRuledOut: number;
  readonly neighborhoodMentioned: boolean;
  readonly neighborhoodUseParsed: boolean;
  readonly phase1ToolCalls: number;
  readonly phase1Tokens: number | null;
  // Ordered, human-readable reasons the gate failed (empty when it passed).
  readonly failReasons: readonly string[];
  // The parsed checklist + neighborhood-use, carried so a passing gate can build
  // the approved summary without re-parsing.
  readonly rows: readonly PivotCheckRow[];
  readonly records: readonly PivotInspectionRecord[];
  readonly neighborhoodUse: NeighborhoodUse;
}

// Evaluate the Phase-1 transcript against the hard gate. A gate PASSES only when:
//   - the agent emitted a PIVOT_CHECK section (the marker), and
//   - it emitted at least one parseable checklist row, and
//   - every pivot is accounted for by a row, and
//   - no row claims `inspected=yes` for a pivot the tools never opened, and
//   - it did not edit any file during the inspect-only phase, and
//   - when neighborhood excerpts were provided: it mentioned the neighborhood AND
//     emitted a neighborhood_use accounting.
// Pure and deterministic.
export function evaluatePivotCheckGate(input: PivotCheckGateInput): PivotCheckGateResult {
  const checklistEmitted = input.assistantText.includes(PIVOT_CHECK_MARKER);
  const rows = parsePivotCheckRows(input.assistantText);
  // A row that claims edit_needed=no is a rule-out claim; the classifier honors it
  // only for pivots the tools actually opened (you cannot rule out what you never
  // read), so a false "ruled out without reading" still surfaces via the agreement.
  const ruledOutClaims = rows
    .filter((row) => row.editNeeded === false)
    .map((row) => ({ path: row.path }));
  const records = classifyPivotInspection(
    input.pivots,
    input.toolCalls,
    input.editedFiles,
    ruledOutClaims,
  );
  const agreement = checklistToolAgreement(rows, records);
  const neighborhoodUse = parseNeighborhoodUse(input.assistantText);
  const neighborhoodMentioned = neighborhoodMentionInText(
    input.assistantText,
    input.neighborhoodIdentifiers ?? [],
  );
  const pivotsInspected = records.filter((record) => record.inspected).length;
  const pivotsRuledOut = records.filter((record) => record.status === "ruled_out").length;

  const failReasons: string[] = [];
  if (!checklistEmitted) failReasons.push("checklist_not_emitted");
  if (rows.length === 0) failReasons.push("no_checklist_rows");
  // Every pivot must be accounted for by a matched row.
  const accountedPaths = new Set(rows.map((row) => row.path));
  const unaccounted = input.pivots.filter(
    (pivot) => !rows.some((row) => pathMatches(row.path, pivot.path)),
  );
  if (rows.length > 0 && unaccounted.length > 0) {
    failReasons.push(`pivots_unaccounted (${unaccounted.map((p) => p.path).join(", ")})`);
  }
  if (agreement.claimedInspectedButNot > 0) {
    failReasons.push(`claimed_inspected_without_read (${agreement.claimedInspectedButNot})`);
  }
  if (input.editedFiles.length > 0) {
    failReasons.push(`edit_before_gate (${input.editedFiles.length} file(s) patched in preflight)`);
  }
  if (input.neighborhoodExcerptCount > 0) {
    if (!neighborhoodMentioned) failReasons.push("neighborhood_not_mentioned");
    if (!neighborhoodUse.present) failReasons.push("neighborhood_use_not_parsed");
  }

  // Touch accountedPaths so the lint of an unused set never fires while keeping the
  // intent explicit (the set is the basis for the unaccounted check above).
  void accountedPaths;

  return {
    pivotCheckGatePassed: failReasons.length === 0,
    checklistEmitted,
    pivotCheckRowsParsed: rows.length,
    checklistToolAgreement: agreement.agreement,
    claimedInspectedWithoutRead: agreement.claimedInspectedButNot,
    pivotsInspected,
    pivotsRuledOut,
    neighborhoodMentioned,
    neighborhoodUseParsed: neighborhoodUse.present,
    phase1ToolCalls: input.toolCalls.length,
    phase1Tokens: input.phase1Tokens ?? null,
    failReasons,
    rows,
    records,
    neighborhoodUse,
  };
}

function pathMatches(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith(`/${b}`) || b.endsWith(`/${a}`)) return true;
  const aBase = a.split("/").pop() ?? a;
  const bBase = b.split("/").pop() ?? b;
  return aBase.length > 0 && aBase === bBase;
}

// The Phase-2 decision: solve runs only on a passing gate. On failure, Phase 2 is
// skipped and the joined fail reasons are surfaced so the report explains why.
export interface Phase2Decision {
  readonly phase2Started: boolean;
  readonly phase2SkippedReason: string | null;
}

export function decidePhase2(gate: PivotCheckGateResult): Phase2Decision {
  if (gate.pivotCheckGatePassed) {
    return { phase2Started: true, phase2SkippedReason: null };
  }
  return {
    phase2Started: false,
    phase2SkippedReason: `pivot_check_gate_failed: ${gate.failReasons.join("; ")}`,
  };
}

// Build the compact approved-checklist summary injected into the Phase-2 solve
// prompt on a passing gate. It restates what the agent already established in
// Phase 1 — which pivots are edit-relevant and which neighborhood excerpts were
// used — so the solve phase acts on the inspection instead of redoing it.
export function buildApprovedChecklistSummary(gate: PivotCheckGateResult): string {
  const lines: string[] = ["## APPROVED_PIVOT_CHECK", ""];
  lines.push("Phase 1 inspection passed the gate. Act on this approved analysis:");
  for (const row of gate.rows) {
    const inspected = row.inspected === null ? "?" : row.inspected ? "yes" : "no";
    const editNeeded = row.editNeeded === null ? "?" : row.editNeeded ? "yes" : "no";
    lines.push(
      `- ${row.path}: inspected=${inspected}, edit_needed=${editNeeded}`
        + (row.reason.length > 0 ? ` — ${row.reason}` : ""),
    );
  }
  if (gate.neighborhoodUse.present) {
    if (gate.neighborhoodUse.used.length > 0) {
      lines.push(`- neighborhood used: ${gate.neighborhoodUse.used.join(", ")}`);
    }
    if (gate.neighborhoodUse.ruledOut.length > 0) {
      lines.push(`- neighborhood ruled out: ${gate.neighborhoodUse.ruledOut.join(", ")}`);
    }
  }
  lines.push("");
  lines.push("Make the smallest correct patch for the pivots marked edit_needed; do not re-inspect ruled-out pivots.");
  return lines.join("\n");
}

// The Phase-1 (inspect-only) preflight prompt. It reuses the SAME injected Capsule
// v2 context (pivots + pivotNeighborhood, assembled by the harness) and adds a
// hard inspect-only instruction: produce the structured checklist + neighborhood
// accounting, and DO NOT patch. This is a gate, not soft wording — the harness
// refuses to run Phase 2 until `evaluatePivotCheckGate` passes.
export function buildPivotCheckPreflightPrompt(
  pivots: readonly PivotForInspection[],
  neighborhoodExcerptCount: number,
): string {
  const lines: string[] = [
    "## PIVOT_CHECK — preflight (inspection only)",
    "",
    "This is an INSPECTION-ONLY phase. Do NOT edit, write, or patch any file yet. "
      + "First account for every pivot and neighborhood excerpt VTRACE supplied.",
    "",
    "Directly inspect (Read/open — not Grep) each pivot below, then output a "
      + "PIVOT_CHECK table with one row per pivot:",
    "",
    "| pivot | symbol | inspected | relevant | edit_needed | reason |",
    "|---|---|---:|---:|---:|---|",
  ];
  for (const pivot of pivots) {
    lines.push(`| ${pivot.path} | ${pivot.symbol || "?"} | yes/no | yes/no | yes/no | ... |`);
  }
  lines.push("");
  lines.push("Rules:");
  lines.push("- You may mark inspected=yes only for a pivot you actually opened/Read this phase.");
  lines.push("- You may rule a pivot out (edit_needed=no) only with a source-grounded reason.");
  if (neighborhoodExcerptCount > 0) {
    lines.push(
      `- ${neighborhoodExcerptCount} pivot-neighborhood excerpt(s) were provided. Output a `
        + "`neighborhood_use:` block with `used:` and `ruled_out:` lines, each grounded in inspected source.",
    );
  }
  lines.push("- Do not produce a patch in this phase. The solve phase runs only after this checklist is accepted.");
  return lines.join("\n");
}
