// Multi-Pivot Action Plan for the capsule v2 injected context (M35).
//
// SCOPE: rendering / advisory only — a compact, FIRST-PASS summary placed at the
// very top of the injected block. It runs NO agents, NO Docker, calls NO model,
// and — critically — it NEVER touches retrieval: it does not generate candidates,
// re-rank, re-score, or change role assignment. It is a pure, deterministic
// projection over evidence the capsule ALREADY computed: the selected pivots and
// the multi-file co-edit actionability hints (via the pivot inspection contract).
//
// Motivation (M32/M34): on multi-pivot / co-edit tasks the genuine failure is
// `retrieval_success_action_failure` — the gold IS surfaced, the agent edits the
// lead pivot, but skips the required secondary co-edit and finalizes. The secondary
// pivot was already in the injected block, but framed as "inspect or rule out /
// supporting context" and buried BELOW the bulky pivot/support source bodies. The
// agent edits the first plausible file and stops.
//
// This section does not add new evidence; it raises the SALIENCE of the evidence
// that exists. It renders a tight numbered "required inspection set" (lead +
// secondary pivots/co-edit candidates) with edit-or-rule-out wording at the TOP of
// the block, before the verbose sections — so the multi-location obligation is the
// first thing the agent reads. It is NOT hard enforcement (it requests no
// machine-readable decision markers and is independent of the M12 enforcement block)
// and NOT a post-patch corrective pass; it is a clearer first-pass action plan.
//
// NOTHING HERE IS PROJECT-SPECIFIC. It keys off the capsule's own pivot ordering
// (pivots[0] is the lead) and the generic co-edit hint shape. No instance ids, no
// repo names, no hardcoded filenames, no gold-patch data.

import type { ActionabilityHint } from "./actionabilityHints";
import {
  buildPivotInspectionContract,
  pivotReason,
  type ContractPivotView,
} from "./pivotInspectionContract";

/** One entry in the required-inspection set: the lead pivot, a non-lead pivot, or a
 *  related co-edit candidate, each with a compact source-grounded reason. */
export interface MultiPivotActionPlanEntry {
  file: string;
  symbol?: string;
  /** `lead` — the inspect-first edit site (pivots[0]). `pivot` — a non-lead pivot
   *  already in context. `related_coedit` — a coupled file from a co-edit hint. */
  role: "lead" | "pivot" | "related_coedit";
  /** Compact (≤ MAX_REASON_CHARS) "why this matters" line. No source excerpt. */
  reason: string;
}

export interface MultiPivotActionPlan {
  /** Lead first, then secondary pivots / co-edit candidates. 2..MAX_PLAN_PIVOTS. */
  entries: MultiPivotActionPlanEntry[];
  /** True when the plan was driven by a multi_file_coedit hint (vs ≥2 pivots). */
  hasCoedit: boolean;
}

// Compactness bounds (M35 requirement): at most 3 required pivots (lead included),
// one short reason per pivot, no source excerpts.
const MAX_PLAN_PIVOTS = 3;
const MAX_REASON_CHARS = 90;

/** Heading marker — exported so the runner and the M34 accounting split can detect
 *  and attribute this section without re-parsing the body. */
export const MULTI_PIVOT_ACTION_PLAN_HEADING = "## Multi-Pivot Action Plan";

/** Env var that gates the action-plan section (M36.1). Default ON; set to a falsy
 *  string to suppress the section for the A/B control arm. Rendering-only. */
export const MULTI_PIVOT_ACTION_PLAN_ENV = "VTRACE_ENABLE_MULTI_PIVOT_ACTION_PLAN";

/**
 * Whether the Multi-Pivot Action Plan section should render. Default ON — only an
 * explicit falsy value (`0`, `false`, `off`, case-insensitive, trimmed) suppresses
 * it; unset or any other value preserves the M35 default. This gates RENDERING ONLY:
 * it changes no retrieval, ranking, pivot selection, co-edit detection, or scoring.
 *
 * Env is read via an injectable map so tests stay isolated (no process.env mutation).
 */
export function multiPivotActionPlanEnabled(
  env: { [key: string]: string | undefined } = process.env,
): boolean {
  const raw = env[MULTI_PIVOT_ACTION_PLAN_ENV];
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return !(normalized === "0" || normalized === "false" || normalized === "off");
}

function pivotId(path: string, symbol: string | undefined): string {
  return symbol && symbol.length > 0 ? `${path}::${symbol}` : path;
}

// Tighter than the contract's compaction (160) — the action plan is a TL;DR, so
// reasons are clipped harder to keep the whole section to a handful of lines.
function shorten(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_REASON_CHARS
    ? `${collapsed.slice(0, MAX_REASON_CHARS - 1)}…`
    : collapsed;
}

/**
 * Build the multi-pivot action plan from the capsule's selected pivots and its
 * actionability hints. Returns `null` when there is no genuine multi-pivot / co-edit
 * risk to summarize — a single-pivot capsule with no co-edit hint, or a capsule with
 * no secondary inspection target — so single-localized / no-context tasks render
 * NOTHING. The plan reuses the pivot inspection contract's gate and ordering, so it
 * fires exactly when that contract has a secondary obligation.
 *
 * Pure and deterministic; capsule pivot order is preserved. Bounded to
 * MAX_PLAN_PIVOTS entries (lead included).
 */
export function buildMultiPivotActionPlan(
  pivots: readonly ContractPivotView[],
  actionabilityHints: readonly ActionabilityHint[],
): MultiPivotActionPlan | null {
  const contract = buildPivotInspectionContract(pivots, actionabilityHints);
  // No contract → single pivot, no co-edit hint → nothing to summarize.
  if (contract === null) return null;
  // A plan needs at least one secondary to inspect besides the lead; a lone lead is
  // not a "multi-pivot" plan (can happen if the only co-edit file IS a pivot).
  if (contract.requiredInspections.length === 0) return null;
  if (pivots.length === 0) return null;

  const lead = pivots[0]!;
  const entries: MultiPivotActionPlanEntry[] = [
    {
      file: lead.path,
      symbol: lead.symbol && lead.symbol.length > 0 ? lead.symbol : undefined,
      role: "lead",
      reason: shorten(pivotReason(lead)),
    },
  ];

  for (const entry of contract.requiredInspections) {
    if (entries.length >= MAX_PLAN_PIVOTS) break;
    entries.push({
      file: entry.file,
      symbol: entry.symbol,
      role: entry.role,
      reason: shorten(entry.reason),
    });
  }

  return { entries, hasCoedit: contract.hasCoedit };
}

/**
 * Render the multi-pivot action plan to a compact Markdown block. Emitted at the TOP
 * of the injected capsule (before the verbose multi-pivot guidance and the bulky
 * pivot bodies) so the multi-location obligation survives any char-budget truncation
 * and is the first thing the agent reads. Returns an empty array when `plan` is null.
 *
 * Compact by construction: the numbered inspection set is bounded to MAX_PLAN_PIVOTS
 * one-line entries, followed by exactly three obligation bullets. No source excerpts.
 */
export function renderMultiPivotActionPlanText(
  plan: MultiPivotActionPlan | null,
): string[] {
  if (plan === null) return [];

  const lines: string[] = [];
  lines.push("");
  lines.push(MULTI_PIVOT_ACTION_PLAN_HEADING);
  lines.push("");
  lines.push("This task likely requires checking more than one location before finalizing.");
  lines.push("");
  lines.push("Required inspection set:");
  plan.entries.forEach((entry, index) => {
    const role =
      entry.role === "lead"
        ? "lead pivot"
        : entry.role === "related_coedit"
          ? "co-edit candidate"
          : "pivot";
    lines.push(`${index + 1}. ${pivotId(entry.file, entry.symbol)} (${role}) — ${entry.reason}`);
  });
  lines.push("");
  lines.push("Before final answer:");
  lines.push("- inspect each required pivot,");
  lines.push("- either edit it, or rule it out with a source-grounded reason it is not needed,");
  lines.push(
    "- do not stop after the first plausible file while a required pivot is still unchecked.",
  );
  return lines;
}
