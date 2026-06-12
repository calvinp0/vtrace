// Tests for the Stage 5 token-discipline preflight (Phase 1).
//   * detects the token-discipline block IS injected for strong VTRACE context,
//   * confirms the baseline arm does NOT receive the vtrace-only block,
//   * confirms strong-context mode, budgets (2/1), and directive content,
//   * weak context falls back to weak_context_explore,
//   * the required-field gate (evaluatePreflight) passes only when all hold.
// All fixtures/synthetic sections — NO Docker, model, or agent calls occur.

import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  assessTokenDisciplinePreflight,
  evaluatePreflight,
  renderMarkdown,
  sectionFromRunMeta,
  syntheticStrongSection,
} from "./run_stage5_token_discipline_preflight";
import type { VtraceContextSection } from "./run_stage5_vexp_swe_bench_smoke";

const INSTANCE = "matplotlib__matplotlib-22719";

// Turn a strong section into a weak one by stripping the support snippets (the
// policy requires lead pivot + file + support + injected for strong context).
function weakSection(): VtraceContextSection {
  const strong = syntheticStrongSection(INSTANCE);
  return {
    ...strong,
    classification: {
      ...strong.classification!,
      capsuleSupport: [],
      supportCount: 0,
    },
  };
}

// 1. Preflight detects token discipline injected for strong VTRACE context.
test("strong context injects token discipline in strong_context_patch_first mode", () => {
  const result = assessTokenDisciplinePreflight(syntheticStrongSection(INSTANCE));
  assert.equal(result.tokenDisciplineInjected, true);
  assert.equal(result.tokenDisciplineMode, "strong_context_patch_first");
  assert.equal(result.strongContext, true);
  assert.equal(result.leadPivotPresent, true);
  assert.equal(result.leadPivotFilePresent, true);
  assert.equal(result.supportSnippetsPresent, true);
  assert.equal(result.contextInjected, true);
});

// 2. Preflight confirms baseline does not get VTRACE-specific token discipline.
test("baseline-shaped prompt carries no token-discipline block", () => {
  const result = assessTokenDisciplinePreflight(syntheticStrongSection(INSTANCE), {
    baselinePromptText: "# Task\n\nFix the matplotlib units bug.\n\n## Instruction\n\nMake the change.",
  });
  assert.equal(result.baselineTokenDisciplineInjected, false);
});

// Budgets are the shared single source of truth (2 search / 1 Bash / 1 re-read).
test("preflight renders the pre-edit budgets 2 / 1 / 1", () => {
  const result = assessTokenDisciplinePreflight(syntheticStrongSection(INSTANCE));
  assert.equal(result.preEditSearchBudget, 2);
  assert.equal(result.preEditBashBudget, 1);
  assert.equal(result.repeatedFileReadLimit, 1);
});

// Directive content: marker + budgets + patch-first must all reach the agent.
test("injected block carries marker, both budget directives, and patch-first", () => {
  const result = assessTokenDisciplinePreflight(syntheticStrongSection(INSTANCE));
  assert.equal(result.markerPresent, true);
  assert.equal(result.searchBudgetDirectivePresent, true);
  assert.equal(result.bashBudgetDirectivePresent, true);
  assert.equal(result.patchFirstDirectivePresent, true);
});

// Weak context (no support snippets) → exploratory mode, not patch-first.
test("weak context falls back to weak_context_explore", () => {
  const result = assessTokenDisciplinePreflight(weakSection());
  assert.equal(result.tokenDisciplineMode, "weak_context_explore");
  assert.equal(result.strongContext, false);
  assert.equal(result.supportSnippetsPresent, false);
  // A block is still injected (the weak block), but NOT the patch-first directive.
  assert.equal(result.tokenDisciplineInjected, true);
  assert.equal(result.patchFirstDirectivePresent, false);
});

// Reconstructing the section from a real run's `_run.meta.json` capsule yields a
// strong section (matplotlib-22719's recorded capsule had 2 pivots + 4 support).
test("sectionFromRunMeta reconstructs a strong matplotlib section", () => {
  const meta = {
    vtraceCapsulePivots: [
      { path: "lib/matplotlib/axis.py", symbol: "convert_units", roleReason: "explicit edit site", estimatedTokens: 231 },
    ],
    vtraceCapsuleSupport: [
      { path: "lib/matplotlib/category.py", symbol: "convert", roleReason: "strong target", estimatedTokens: 24 },
    ],
    vtraceContextInjected: true,
    vtraceContextChars: 3533,
    vtracePivotCount: 2,
    vtraceSupportCount: 4,
    vtraceContextError: null,
  };
  const section = sectionFromRunMeta(INSTANCE, meta);
  const result = assessTokenDisciplinePreflight(section);
  assert.equal(result.tokenDisciplineMode, "strong_context_patch_first");
  assert.equal(result.tokenDisciplineInjected, true);
});

// The required-field gate passes for a strong section and fails loudly otherwise.
test("evaluatePreflight passes for strong context, fails for weak", () => {
  const strong = evaluatePreflight(
    assessTokenDisciplinePreflight(syntheticStrongSection(INSTANCE)),
    "synthetic",
    "eval-controlled-vtrace-matplotlib-22719",
    null,
  );
  assert.equal(strong.preflightPassed, true);
  assert.equal(strong.failedAssertions.length, 0);

  const weak = evaluatePreflight(assessTokenDisciplinePreflight(weakSection()), "synthetic", null, null);
  assert.equal(weak.preflightPassed, false);
  // Weak mode is the headline failure for the gate.
  assert.ok(weak.failedAssertions.some((f) => f.includes("strong_context_patch_first")));
});

// The markdown report emits the required headings and the verbatim block.
test("renderMarkdown emits required sections and the injected block", () => {
  const report = evaluatePreflight(
    assessTokenDisciplinePreflight(syntheticStrongSection(INSTANCE)),
    "synthetic",
    "eval-controlled-vtrace-matplotlib-22719",
    "2026-06-12T00:00:00Z",
  );
  const md = renderMarkdown(report);
  assert.ok(md.includes("# Stage 5 token-discipline preflight: matplotlib-22719"));
  assert.ok(md.includes("## Required preflight fields"));
  assert.ok(md.includes("## Injected-block directive checks"));
  assert.ok(md.includes("## Non-claims"));
  assert.ok(md.includes("## STAGE5_TOKEN_DISCIPLINE"));
});
