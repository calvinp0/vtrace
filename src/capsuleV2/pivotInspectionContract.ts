// Pivot inspection contract for the capsule v2 injected context.
//
// SCOPE: rendering / advisory only. This is a CHEAP, DETERMINISTIC projection over
// the capsule's ALREADY-selected pivots plus any multi-file co-edit actionability
// hint. It runs NO agents, NO Docker, calls NO model, and — critically — it NEVER
// touches retrieval: it does not generate candidates, re-rank, re-score, or change
// role assignment. It reads the final pivot list (paths/symbols/evidence) and the
// co-edit hints, and emits a compact, structured "inspect or rule out each non-lead
// pivot before finalizing" contract.
//
// Motivation (M10.1 live validation): the multi-file co-edit hint renders and helps
// when a related file is a concrete support caller, but it does NOT change behavior
// when the ignored file is already an in-context non-lead pivot — the agent still
// edits only the lead pivot. The gap is context-to-action: VTRACE surfaces useful
// pivots, but the agent can still ignore non-lead pivots. This contract makes EVERY
// non-lead pivot actionable — either edit it, or explicitly rule it out with a
// source-grounded reason — and adds a final-diff obligation when a co-edit hint fired.
//
// NOTHING HERE IS PROJECT-SPECIFIC. It keys off the capsule's own pivot ordering
// (pivots[0] is the lead) and the generic co-edit hint shape. No instance ids, no
// repo names, no hardcoded filenames.

import type { ActionabilityHint } from "./actionabilityHints";

/** The minimal view of a selected pivot the contract needs. Structurally compatible
 *  with `CapsuleV2Item` AND with the persisted Stage-5 manifest item, so the same
 *  builder runs at render time and in the offline audit over captured manifests. */
export interface ContractPivotView {
  path: string;
  symbol: string;
  /** Ordered "why selected" evidence; first entry drives the compact reason. */
  evidence?: readonly string[];
  /** Decisive role justification; reason fallback when evidence is absent. */
  role_reason?: string;
}

export interface PivotInspectionEntry {
  file: string;
  symbol?: string;
  /** `pivot` — a non-lead pivot already in context. `related_coedit` — a coupled
   *  file surfaced by a multi_file_coedit hint (may be support, not a pivot). */
  role: "pivot" | "related_coedit";
  /** Compact, source-grounded reason this file was surfaced. */
  reason: string;
}

export interface PivotInspectionContract {
  /** `file::symbol` of the lead (first) pivot — the inspect-first edit site. */
  leadPivot: string;
  /** Every non-lead pivot, then every related co-edit candidate, to inspect-or-rule-out. */
  requiredInspections: PivotInspectionEntry[];
  /** The inspect-or-rule-out obligation text (stronger final-diff language when co-edit). */
  obligation: string;
  /** True when a multi_file_coedit hint fired — adds the final-diff co-edit obligation. */
  hasCoedit: boolean;
}

// Keep each surfaced reason to a single compact line.
const MAX_REASON_CHARS = 160;
// Bound the related co-edit candidate list so the contract stays compact.
const MAX_RELATED_COEDIT = 4;

function pivotId(path: string, symbol: string | undefined): string {
  return symbol && symbol.length > 0 ? `${path}::${symbol}` : path;
}

function compact(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_REASON_CHARS
    ? `${collapsed.slice(0, MAX_REASON_CHARS - 1)}…`
    : collapsed;
}

// The most informative compact "why surfaced" line for a pivot: its first evidence
// entry, else its role reason, else a generic fallback. Never empty.
function pivotReason(pivot: ContractPivotView): string {
  const firstEvidence = (pivot.evidence ?? []).find((e) => e.trim().length > 0);
  if (firstEvidence) return compact(firstEvidence);
  if (pivot.role_reason && pivot.role_reason.trim().length > 0) return compact(pivot.role_reason);
  return "surfaced as an edit-capable pivot";
}

const OBLIGATION_BASE =
  "Inspect each non-lead pivot and either edit it or explicitly rule it out with a "
  + "source-grounded reason; do not finalize after editing only the lead pivot.";

const OBLIGATION_COEDIT =
  "This fix likely spans multiple coupled files. Inspect each non-lead pivot and "
  + "related co-edit candidate and either edit it or explicitly rule it out with a "
  + "source-grounded reason. Include all required co-edits in the final diff — do not "
  + "finalize after editing only the lead pivot.";

/**
 * Build the pivot inspection contract from the capsule's selected pivots and its
 * actionability hints. Returns `null` when the contract should not render — a single
 * pivot with no multi_file_coedit hint — so single-pivot cases are not bloated.
 *
 * Pure and deterministic; capsule pivot order is preserved. Related co-edit
 * candidates come only from `multi_file_coedit` hints and exclude files already
 * listed as pivots (no double-listing).
 */
export function buildPivotInspectionContract(
  pivots: readonly ContractPivotView[],
  actionabilityHints: readonly ActionabilityHint[],
): PivotInspectionContract | null {
  const coeditHints = actionabilityHints.filter((h) => h.kind === "multi_file_coedit");
  const hasCoedit = coeditHints.length > 0;

  // Gate: render only for multi-pivot capsules or when a co-edit hint fired.
  if (pivots.length < 2 && !hasCoedit) return null;
  if (pivots.length === 0) return null;

  const lead = pivots[0]!;
  const pivotPaths = new Set(pivots.map((p) => p.path));

  const requiredInspections: PivotInspectionEntry[] = [];

  // Non-lead pivots first (already in context — the ones the agent tends to skip).
  for (const pivot of pivots.slice(1)) {
    requiredInspections.push({
      file: pivot.path,
      symbol: pivot.symbol && pivot.symbol.length > 0 ? pivot.symbol : undefined,
      role: "pivot",
      reason: pivotReason(pivot),
    });
  }

  // Related co-edit candidates from multi_file_coedit hints — deduped, and excluding
  // any file already listed as a pivot (it is covered by the pivot entry above).
  const seenRelated = new Set<string>();
  for (const hint of coeditHints) {
    const related = hint.relatedFiles ?? [hint.relatedFile];
    const reason = hint.evidence.length > 0 ? compact(hint.evidence.join("; ")) : compact(hint.hint);
    for (const file of related) {
      if (pivotPaths.has(file)) continue;
      if (seenRelated.has(file)) continue;
      if (requiredInspections.filter((e) => e.role === "related_coedit").length >= MAX_RELATED_COEDIT) {
        break;
      }
      seenRelated.add(file);
      requiredInspections.push({ file, role: "related_coedit", reason });
    }
  }

  return {
    leadPivot: pivotId(lead.path, lead.symbol),
    requiredInspections,
    obligation: hasCoedit ? OBLIGATION_COEDIT : OBLIGATION_BASE,
    hasCoedit,
  };
}

/**
 * Render the pivot inspection contract to the compact Markdown block injected into
 * the Stage 5 context. Emitted BEFORE the bulky pivot bodies so it survives the
 * Stage 5 char-budget truncation. Returns an empty array when `contract` is null.
 */
export function renderPivotInspectionContractText(
  contract: PivotInspectionContract | null,
): string[] {
  if (contract === null) return [];

  const lines: string[] = [];
  lines.push("");
  lines.push("## Pivot inspection contract");
  lines.push("");
  lines.push(
    "VTRACE surfaced multiple edit-capable pivots. Do not finalize after editing only "
    + "the first pivot unless the others have been inspected and ruled out.",
  );
  lines.push("");
  lines.push("Required checklist:");
  lines.push(`  [ ] Inspect the lead pivot: ${contract.leadPivot}`);
  for (const entry of contract.requiredInspections) {
    const id = pivotId(entry.file, entry.symbol);
    if (entry.role === "related_coedit") {
      lines.push(`  [ ] Inspect or rule out related co-edit candidate: ${id}`);
    } else {
      lines.push(`  [ ] Inspect or rule out: ${id}`);
    }
  }
  if (contract.hasCoedit) {
    lines.push(
      "  [ ] If the fix spans multiple files, include all required co-edits in the final diff.",
    );
  }

  // Per-entry detail: why surfaced + the required edit-or-rule-out action.
  for (const entry of contract.requiredInspections) {
    lines.push("");
    if (entry.role === "related_coedit") {
      lines.push(`- Related co-edit candidate: ${entry.file}`);
      lines.push(`  Why surfaced: ${entry.reason}`);
      lines.push("  Action: inspect and either edit it or rule it out before finalizing.");
    } else {
      lines.push(`- ${pivotId(entry.file, entry.symbol)}`);
      lines.push(`  Why surfaced: ${entry.reason}`);
      lines.push(
        "  Action: edit this pivot if the changed behavior crosses it, otherwise "
        + "explicitly rule it out with a source-grounded reason.",
      );
    }
  }

  if (contract.hasCoedit) {
    lines.push("");
    lines.push("Co-edit obligation:");
    lines.push(
      "  The following pivots/support files are coupled. Do not finalize after editing "
      + "only the lead pivot unless each related file is explicitly ruled out. Include "
      + "all required edits in the final diff.",
    );
  }

  return lines;
}

// The marker heading for the M12 enforcement block, exported so the Stage 5 runner and
// post-hoc tooling can detect injection without re-parsing the body.
export const PIVOT_ENFORCEMENT_HEADING = "## Required pivot check before final patch";

/**
 * Render the M12 pivot-check ENFORCEMENT block — a stronger, "required response"
 * sibling of the advisory contract. It demands an explicit, source-grounded EDITED /
 * RULED OUT decision for every non-lead pivot and co-edit candidate before finalizing,
 * with anti-over-edit / minimal-diff guardrails so it never degrades into "edit every
 * pivot". This is injected by the Stage 5 runner ONLY when the enforcement mode is
 * explicitly enabled (off by default); the advisory `renderPivotInspectionContractText`
 * keeps rendering independently.
 *
 * Returns an empty array when there is nothing to enforce (single-pivot, no co-edit) so
 * the runner never injects an empty block.
 */
export function renderPivotInspectionEnforcementText(
  contract: PivotInspectionContract | null,
): string[] {
  if (contract === null || contract.requiredInspections.length === 0) return [];

  const nonLead = contract.requiredInspections.filter((e) => e.role === "pivot");
  const coedit = contract.requiredInspections.filter((e) => e.role === "related_coedit");

  const lines: string[] = [];
  lines.push(PIVOT_ENFORCEMENT_HEADING);
  lines.push("");
  lines.push("Before finalizing your patch, complete this check:");
  lines.push("");
  lines.push("- Lead pivot:");
  lines.push(`  ${contract.leadPivot}`);
  for (const entry of nonLead) {
    lines.push("");
    lines.push("- Non-lead pivot:");
    lines.push(`  ${pivotId(entry.file, entry.symbol)}`);
    lines.push(`  why surfaced: ${entry.reason}`);
  }
  for (const entry of coedit) {
    lines.push("");
    lines.push("- Co-edit candidate:");
    lines.push(`  ${entry.file}`);
    lines.push(`  why surfaced: ${entry.reason}`);
  }
  lines.push("");
  lines.push("Required decision for each non-lead pivot / co-edit candidate:");
  lines.push("  - EDITED: I changed this file because <source-grounded reason>.");
  lines.push(
    "  - RULED OUT: I inspected this file and did not change it because <source-grounded reason>.",
  );
  lines.push("");
  lines.push("Rules:");
  lines.push("  - Do not ignore non-lead pivots.");
  lines.push("  - Do not add files to the final diff merely because they are listed.");
  lines.push("  - Prefer the minimal final diff that satisfies the failing behavior.");
  lines.push(
    "  - A pivot may be ruled out, but only after inspecting it and citing concrete source evidence.",
  );
  lines.push("  - If the behavior crosses files, include all required co-edits in the final diff.");
  lines.push("");
  lines.push(
    "Machine-readable decision (REQUIRED): in your final answer, emit ONE PIVOT_DECISION block "
    + "per non-lead pivot / co-edit candidate listed above, using exactly this format:",
  );
  lines.push("  PIVOT_DECISION:");
  lines.push("  path: <file>");
  lines.push("  decision: EDITED | RULED_OUT");
  lines.push("  evidence: <one sentence grounded in source or test behavior>");
  lines.push(
    "  - EDITED is valid only when <file> appears in your final diff.",
  );
  lines.push(
    "  - RULED_OUT requires concrete source-grounded evidence; a generic \"not needed\" is not enough.",
  );
  lines.push("");
  lines.push("Final diff check:");
  lines.push(
    "  Every non-lead pivot / co-edit candidate must be either edited or ruled out with a "
    + "source-grounded reason.",
  );
  return lines;
}
