// Human rendering for capsule v2.
//
// Turns the assembled capsule into the product's text output: an intent + budget
// header, then the pivots (focused source, highest priority) and support
// (signatures/skeletons). Reuses `itemBlockText` so the printed capsule is the
// exact text the budget accounting counted. Deterministic — no locale-dependent
// formatting.

import {
  buildMultiPivotActionPlan,
  multiPivotActionPlanEnabled,
  renderMultiPivotActionPlanText,
} from "./multiPivotActionPlan";
import {
  buildPivotInspectionContract,
  renderPivotInspectionContractText,
} from "./pivotInspectionContract";
import {
  buildSemanticEditHypothesis,
  editSufficiencyChecklistEnabled,
  renderEditSufficiencyChecklistText,
  renderSemanticEditHypothesisText,
  semanticEditHypothesisEnabled,
} from "./semanticEditHypothesis";
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

/** Rendering-only options for {@link renderCapsuleV2Human}. */
export interface RenderCapsuleV2HumanOptions {
  /**
   * Whether to render the M35 Multi-Pivot Action Plan section (M36.1 toggle).
   * Defaults to the `VTRACE_ENABLE_MULTI_PIVOT_ACTION_PLAN` env (default ON). This
   * gates RENDERING ONLY — it changes no retrieval, ranking, pivots, or scoring.
   */
  enableMultiPivotActionPlan?: boolean;
  /**
   * Whether to render the M39 Semantic Edit Hypothesis section. Defaults to the
   * `VTRACE_ENABLE_SEMANTIC_EDIT_HYPOTHESIS` env (DEFAULT OFF — opt-in until
   * validated). Gates RENDERING ONLY — it changes no retrieval, ranking, pivots,
   * co-edit detection, or scoring.
   */
  enableSemanticEditHypothesis?: boolean;
  /**
   * Whether to render the M41 end-of-context edit-sufficiency checklist. Defaults to
   * the `VTRACE_ENABLE_EDIT_SUFFICIENCY_CHECKLIST` env (DEFAULT OFF). SEPARATE from
   * the M39 flag: when enabled the checklist renders near the FINAL patch guidance
   * (after the pivot/support bodies) whenever the semantic hypothesis builder produces
   * a paired-symbol group — even if the top M39 section is disabled. Gates RENDERING
   * ONLY — it changes no retrieval, ranking, pivots, co-edit detection, or scoring.
   */
  enableEditSufficiencyChecklist?: boolean;
}

export function renderCapsuleV2Human(
  result: CapsuleV2Result,
  options?: RenderCapsuleV2HumanOptions,
): string {
  const lines: string[] = [];
  const actionPlanEnabled =
    options?.enableMultiPivotActionPlan ?? multiPivotActionPlanEnabled();
  const semanticHypothesisEnabled =
    options?.enableSemanticEditHypothesis ?? semanticEditHypothesisEnabled();
  const checklistEnabled =
    options?.enableEditSufficiencyChecklist ?? editSufficiencyChecklistEnabled();
  // Build the semantic hypothesis at most ONCE, reused by both the top M39 section
  // and the M41 end-of-context checklist (they must agree on the paired implementations).
  // Skipped entirely when both flags are off, so default-off output is byte-identical.
  const semanticHypothesis =
    semanticHypothesisEnabled || checklistEnabled
      ? buildSemanticEditHypothesis(result.pivots, result.support)
      : null;
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

  // Multi-Pivot Action Plan (M35): a compact, FIRST-PASS summary of the required
  // inspection set, rendered at the very TOP of the capsule — before the verbose
  // multi-pivot guidance and the bulky pivot bodies. M34 found the genuine failure
  // on multi-pivot tasks is context-to-action: the secondary co-edit pivot is already
  // in the block but framed as "supporting / inspect-or-rule-out" and buried, so the
  // agent edits the lead and stops. This raises the SALIENCE of the secondary pivot
  // without adding evidence, changing retrieval, or enabling enforcement. It reuses
  // the pivot inspection contract's gate, so it fires only when there is a real
  // secondary inspection obligation (≥2 pivots or a multi-file co-edit hint).
  if (actionPlanEnabled) {
    const actionPlan = buildMultiPivotActionPlan(
      result.pivots,
      result.actionability_hints ?? [],
    );
    for (const line of renderMultiPivotActionPlanText(actionPlan)) {
      lines.push(line);
    }
  }

  // Semantic Edit Hypothesis (M39, DEFAULT OFF): when two surfaced candidates define
  // the SAME operation-like name in DIFFERENT files, name them as paired
  // implementations and warn that the second may avoid the crash yet still produce
  // wrong output — verify output correctness, not crash avoidance. M38 found the
  // sphinx-7462 failure is `seen_but_deemed_unnecessary`: the agent rules out the
  // second `unparse` because `', '.join()` does not crash, missing that it renders
  // the wrong text for an empty tuple. Generic obligation text (already saturated)
  // did not help; this targets the faulty inference. Rendered in the top advisory
  // cluster (before the bulky pivot bodies) so it survives char-budget truncation.
  // Non-oracle: derived from candidate symbols + inlined source only. Gated OFF by
  // default; changes no retrieval, ranking, pivots, or scoring.
  if (semanticHypothesisEnabled) {
    for (const line of renderSemanticEditHypothesisText(semanticHypothesis)) {
      lines.push(line);
    }
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

  // Pivot inspection contract: a compact, STRUCTURED checklist that makes every
  // non-lead pivot actionable. M10.1 live validation found the multi-file co-edit
  // hint helps when a related file is a concrete support caller, but the agent still
  // ignores non-lead pivots already in context (it edits the lead pivot and stops).
  // This contract names the lead pivot as inspect-first, then requires inspect-or-
  // rule-out for each additional pivot (and each related co-edit candidate, with a
  // final-diff obligation, when a co-edit hint fired). Rendered HERE — before the
  // bulky pivot/support bodies — so it survives the Stage 5 char-budget truncation.
  // Null (and silent) for single-pivot capsules with no co-edit hint: no bloat.
  const inspectionContract = buildPivotInspectionContract(
    result.pivots,
    result.actionability_hints ?? [],
  );
  for (const line of renderPivotInspectionContractText(inspectionContract)) {
    lines.push(line);
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
      if (hint.kind === "multi_file_coedit") {
        // A coordinated multi-file fix: name the lead pivot and every co-edit
        // candidate, then a short inspect/rule-out checklist so the agent does not
        // finalize after editing only the lead file. Kept compact (checklist is
        // emitted ONLY for this kind, so single-file/generated hints stay terse).
        const related = hint.relatedFiles ?? [hint.relatedFile];
        lines.push(`- multi-file co-edit likely (${hint.confidence} confidence):`);
        lines.push(`  Lead pivot: ${hint.sourceFile}`);
        lines.push(`  Related edit candidate(s): ${related.join(", ")}`);
        if (hint.evidence.length > 0) {
          lines.push(`  Why: ${hint.evidence.join("; ")}`);
        }
        if (hint.patchObligation) {
          lines.push(`  Obligation: ${hint.patchObligation.text}`);
        }
        lines.push("  Co-edit checklist:");
        lines.push("    [ ] inspect lead pivot");
        lines.push("    [ ] inspect related candidate(s)");
        lines.push("    [ ] decide edit vs rule-out for each");
        lines.push("    [ ] ensure all required co-edits are in the final diff");
        continue;
      }
      lines.push(`- generated/co-edit artifact: ${hint.relatedFile} (${hint.confidence} confidence)`);
      lines.push(`  source: ${hint.sourceFile}`);
      if (hint.evidence.length > 0) {
        lines.push(`  why: ${hint.evidence.join("; ")}`);
      }
      lines.push(`  action: ${hint.hint}`);
      // Follow-through obligation on its own line so it stands out: regenerating the
      // artifact locally is not enough — it must land in the submitted diff.
      if (hint.patchObligation) {
        lines.push(`  ensure-in-diff: ${hint.patchObligation.text}`);
      }
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

  // M41 end-of-context edit-sufficiency checklist (DEFAULT OFF): rendered LAST — after
  // the bulky pivot/support bodies, near the final patch decision — so it re-surfaces
  // the semantic co-edit hypothesis at the moment the agent finalizes its edit set.
  // M40 found the top-placed M39 hypothesis (above) raised inspection of the paired
  // implementation but did not convert into the edit; this targets that decision point.
  // Reuses the SAME hypothesis object; renders only when a paired-symbol group exists.
  // Non-enforcing (no markers, no gate). Gated OFF by default; changes no retrieval.
  if (checklistEnabled) {
    for (const line of renderEditSufficiencyChecklistText(semanticHypothesis)) {
      lines.push(line);
    }
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
