// Human rendering for capsule v2.
//
// Turns the assembled capsule into the product's text output: an intent + budget
// header, then the pivots (focused source, highest priority) and support
// (signatures/skeletons). Reuses `itemBlockText` so the printed capsule is the
// exact text the budget accounting counted. Deterministic — no locale-dependent
// formatting.

import { itemBlockText } from "./renderItem";
import {
  CapsuleV2Mode,
  type CapsuleV2Item,
  type CapsuleV2Result,
  type EditRiskKind,
} from "./types";

// Section heading for an edit-risk directive. Most directives are patch hints; the
// traversal state-machine invariant is a structural hint, so it gets its own
// heading. Heading is a rendering concern (kept off the JSON directive shape).
function editRiskHeading(kind: EditRiskKind): string {
  return kind === "traversal_state_machine_invariant"
    ? "## Edit risk / state-machine invariant"
    : "## Edit risk / patch hint";
}

// Whether a pivot was selected because the issue pointed STRAIGHT at it — a source
// line anchor (`file.py#L120`) in the traceback/issue text that resolved to this
// symbol. Such a pivot is the "obvious" edit site. Every OTHER pivot was surfaced
// by inference (symbol-name / title / literal / graph / failing-test reasoning) and
// is exactly the kind a traceback-following agent tends to skip. Detection keys off
// the stable evidence/role_reason markers emitted by line-anchor resolution; it
// reads only already-rendered fields and changes no retrieval, scoring, or roles.
function isSourceAnchoredPivot(item: CapsuleV2Item): boolean {
  if (item.role_reason.includes("source line anchor")) return true;
  return item.evidence.some((reason) => reason.startsWith("source anchor "));
}

export function renderCapsuleV2Human(result: CapsuleV2Result): string {
  const lines: string[] = [];
  lines.push(`intent: ${result.intent} (${result.diagnostics.intent_confidence} confidence)`);
  if (result.diagnostics.intent_reason.length > 0) {
    lines.push(`intent_reason: ${result.diagnostics.intent_reason.join("; ")}`);
  }
  lines.push(`strategy: ${result.diagnostics.strategy.role_policy}`);
  lines.push(
    `budget: ${formatThousands(result.budget.estimated_tokens)} / `
    + `${formatThousands(result.budget.max_tokens)} tokens used`,
  );

  if (result.actual_mode === CapsuleV2Mode.NoContext) {
    lines.push("");
    lines.push(`actual_mode: ${CapsuleV2Mode.NoContext}`);
    lines.push(`reason: ${result.reason ?? "no high-confidence edit target recovered"}`);
    return lines.join("\n");
  }

  // Multi-pivot guidance. A traceback usually names the file where the error
  // surfaced, not the file where the fix belongs; when the capsule found more than
  // one plausible edit target, tell the agent to treat this as a root-cause
  // localization problem and inspect every pivot before editing — without ordering
  // it to edit them all. (Single-pivot capsules stay quiet: no noisy warning.)
  const multiPivot = result.pivots.length >= 2;
  if (multiPivot) {
    lines.push("");
    lines.push("## Multiple edit targets");
    lines.push("");
    lines.push(
      "Multiple plausible edit targets were found. Treat this as a multi-file / "
      + "root-cause localization problem, not a single-traceback edit.",
    );
    lines.push("");
    lines.push("Before editing:");
    lines.push("1. Inspect every pivot listed below.");
    lines.push(
      "2. Do not edit only the traceback-named file unless the other pivots are ruled out.",
    );
    lines.push(
      "3. If a non-traceback pivot explains the transformation/parsing/rendering "
      + "behavior, inspect it as a possible root-cause file.",
    );
    lines.push("4. Prefer the smallest patch that fixes the behavior without broad rewrites.");
  }

  // Actionability hints: a compact reminder that an edited source file likely has
  // a paired generated/co-edit artifact (e.g. a parser table) needing regeneration.
  // Rendered HERE — before the bulky pivot/support source bodies — for two reasons:
  // (1) it is the highest-signal, most compact advisory, so the agent should see it
  // before diving into source; (2) downstream consumers truncate the rendered capsule
  // to a char budget (Stage 5 injects a bounded prefix), and a hint stranded after
  // large pivot bodies would be cut off and never reach the agent.
  const actionabilityHints = result.actionability_hints ?? [];
  if (actionabilityHints.length > 0) {
    lines.push("");
    lines.push("## Actionability hints");
    for (const hint of actionabilityHints) {
      lines.push("");
      lines.push(`- generated/co-edit artifact: ${hint.relatedFile} (${hint.confidence} confidence)`);
      lines.push(`  source: ${hint.sourceFile}`);
      if (hint.evidence.length > 0) {
        lines.push(`  why: ${hint.evidence.join("; ")}`);
      }
      lines.push(`  action: ${hint.hint}`);
    }
  }

  for (const pivot of result.pivots) {
    lines.push("");
    lines.push(itemBlockText(pivot));
    // Flag a pivot the issue did NOT point straight at: in a multi-pivot capsule it
    // is the non-obvious, inference-surfaced target the agent is most likely to skip.
    // Inspect-before-edit guidance only — never an instruction to edit it.
    if (multiPivot && !isSourceAnchoredPivot(pivot)) {
      lines.push("");
      lines.push("  hidden candidate:");
      lines.push(
        "  This pivot was not selected because it appeared in a traceback or path anchor.",
      );
      lines.push(
        "  It was surfaced by symbol / graph / literal reasoning and may hold the "
        + "root-cause implementation.",
      );
      lines.push("  Inspect it before finalizing the patch.");
    }
  }

  // Edit-risk directives sit immediately after the pivots they concern: the agent
  // reads the focused source, then the warning about how NOT to edit it.
  for (const directive of result.diagnostics.edit_risk_directives ?? []) {
    lines.push("");
    lines.push(editRiskHeading(directive.kind));
    lines.push("");
    lines.push(directive.directive);
  }

  for (const item of result.support) {
    lines.push("");
    lines.push(itemBlockText(item));
  }

  return lines.join("\n");
}

// Group an integer's digits with commas, deterministically (no toLocaleString,
// whose grouping is locale-dependent). 8000 -> "8,000".
export function formatThousands(value: number): string {
  const negative = value < 0;
  const digits = Math.abs(Math.trunc(value)).toString();
  let grouped = "";
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) {
      grouped += ",";
    }
    grouped += digits[index];
  }
  return negative ? `-${grouped}` : grouped;
}
