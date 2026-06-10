import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  CASE_SEEDS,
  buildCase,
  buildReport,
  buildRunData,
  buildSummary,
  classifyPatchShape,
  classifyVerificationBehavior,
  parseArgs,
  renderJson,
  renderMarkdown,
  treatmentSplitValid,
  type RawRunParts,
  type RunData,
} from "./run_stage5_patch_verify_comparison";

// ---------------------------------------------------------------------------
// Fixtures — synthetic before/after runs, never the live raw artifacts.
// ---------------------------------------------------------------------------

const SYMPY_BEFORE_PATCH = [
  "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py",
  "index a3f0310..173bab4 100644",
  "--- a/sympy/printing/pycode.py",
  "+++ b/sympy/printing/pycode.py",
  "@@ -349,6 +349,9 @@ def _print_NoneToken(self, arg):",
  " class PythonCodePrinter(AbstractPythonCodePrinter):",
  "+    def _print_Indexed(self, expr):",
  "+        indices = [self._print(i) for i in expr.indices]",
  "+        return base",
].join("\n");

const SYMPY_AFTER_PATCH = [
  "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py",
  "index a3f0310..db7681d 100644",
  "--- a/sympy/printing/pycode.py",
  "+++ b/sympy/printing/pycode.py",
  "@@ -357,6 +357,9 @@ def _print_Not(self, expr):",
  "+    def _print_Indexed(self, expr):",
  "+        base, *index = expr.args",
  "+        return base",
].join("\n");

// matplotlib: before only narrows the warning guard; after ADDS an empty-array early return.
const MPL_BEFORE_PATCH = [
  "diff --git a/lib/matplotlib/category.py b/lib/matplotlib/category.py",
  "index c823b68..a3012dd 100644",
  "--- a/lib/matplotlib/category.py",
  "+++ b/lib/matplotlib/category.py",
  "@@ -58,7 +58,7 @@ class StrCategoryConverter(units.ConversionInterface):",
  "-        if is_numlike:",
  "+        if is_numlike and values.size:",
].join("\n");

const MPL_AFTER_PATCH = [
  "diff --git a/lib/matplotlib/category.py b/lib/matplotlib/category.py",
  "index c823b68..44cadc8 100644",
  "--- a/lib/matplotlib/category.py",
  "+++ b/lib/matplotlib/category.py",
  "@@ -54,6 +54,8 @@ class StrCategoryConverter(units.ConversionInterface):",
  "+        if values.size == 0:",
  "+            return np.array([], dtype=float)",
].join("\n");

// requests: before deletes the existing `if not unicode_is_ascii` branch (broad rewrite);
// after still deletes it → still a broad rewrite (same defect).
const REQ_BEFORE_PATCH = [
  "diff --git a/requests/models.py b/requests/models.py",
  "index e7d292d..0eb0603 100644",
  "--- a/requests/models.py",
  "+++ b/requests/models.py",
  "@@ -394,16 +394,16 @@ class PreparedRequest:",
  "-        if not unicode_is_ascii(host):",
  "-            try:",
  "+        if host.startswith(u'*'):",
  "+            raise InvalidURL('URL has an invalid label.')",
].join("\n");

const REQ_AFTER_PATCH = [
  "diff --git a/requests/models.py b/requests/models.py",
  "index e7d292d..5915075 100644",
  "--- a/requests/models.py",
  "+++ b/requests/models.py",
  "@@ -394,16 +394,12 @@ class PreparedRequest:",
  "-        if not unicode_is_ascii(host):",
  "-            try:",
  "+        try:",
  "+            host = self._get_idna_encoded_host(host)",
].join("\n");

function parts(
  runLabel: string,
  opts: {
    instanceId: string;
    patch: string;
    cost: number;
    tokens: { input: number; output: number };
    resolvedCount: number;
    pivotCheckInjected: boolean;
    editGuardInjected: boolean;
    patchVerifyInjected: boolean;
    treatmentValid?: boolean;
    pivotPath?: string;
    readPath?: string;
    bashCalls?: number;
    finalText?: string | null;
  },
): RawRunParts {
  const tools: { category: string; path: string | null }[] = [];
  if (opts.readPath) tools.push({ category: "read", path: opts.readPath });
  for (let i = 0; i < (opts.bashCalls ?? 0); i += 1) tools.push({ category: "other", path: null });
  return {
    runLabel,
    meta: {
      vtracePivotCheckInjected: opts.pivotCheckInjected,
      vtraceEditGuardInjected: opts.editGuardInjected,
      vtracePatchVerifyInjected: opts.patchVerifyInjected,
      vtraceTreatmentValid: opts.treatmentValid ?? true,
      vtraceCapsulePivots: opts.pivotPath
        ? [{ path: opts.pivotPath, roleReason: "actionable class — symbol-name match" }]
        : [],
    },
    evalMeta: { evaluationRan: true, resolvedCount: opts.resolvedCount },
    record: {
      instanceId: opts.instanceId,
      modelPatch: opts.patch,
      costUsd: opts.cost,
      inputTokens: opts.tokens.input,
      outputTokens: opts.tokens.output,
    },
    toolCalls: tools,
    finalText: opts.finalText ?? null,
  };
}

const SYMPY_BEFORE = buildRunData(
  parts("eval-patchverify-before-sympy-16766", {
    instanceId: "sympy__sympy-16766",
    patch: SYMPY_BEFORE_PATCH,
    cost: 0.4,
    tokens: { input: 1000, output: 100 },
    resolvedCount: 0,
    pivotCheckInjected: true,
    editGuardInjected: false,
    patchVerifyInjected: false,
    pivotPath: "sympy/printing/pycode.py",
    readPath: "/x/.bench-repos/sympy__sympy/sympy/printing/pycode.py",
    bashCalls: 2,
  }),
);
const SYMPY_AFTER = buildRunData(
  parts("eval-patchverify-after-sympy-16766", {
    instanceId: "sympy__sympy-16766",
    patch: SYMPY_AFTER_PATCH,
    cost: 0.5,
    tokens: { input: 1300, output: 130 },
    resolvedCount: 0,
    pivotCheckInjected: true,
    editGuardInjected: false,
    patchVerifyInjected: true,
    pivotPath: "sympy/printing/pycode.py",
    readPath: "/x/.bench-repos/sympy__sympy/sympy/printing/pycode.py",
    bashCalls: 2,
  }),
);

const SYMPY_SEED = CASE_SEEDS.find((s) => s.instanceId === "sympy__sympy-16766")!;
const MPL_SEED = CASE_SEEDS.find((s) => s.instanceId === "matplotlib__matplotlib-22719")!;
const REQ_SEED = CASE_SEEDS.find((s) => s.instanceId === "psf__requests-5414")!;

function mplPair(): { before: RunData; after: RunData } {
  return {
    before: buildRunData(
      parts("eval-patchverify-before-matplotlib-22719", {
        instanceId: "matplotlib__matplotlib-22719",
        patch: MPL_BEFORE_PATCH,
        cost: 0.45,
        tokens: { input: 1100, output: 110 },
        resolvedCount: 0,
        pivotCheckInjected: true,
        editGuardInjected: false,
        patchVerifyInjected: false,
        bashCalls: 5,
      }),
    ),
    after: buildRunData(
      parts("eval-patchverify-after-matplotlib-22719", {
        instanceId: "matplotlib__matplotlib-22719",
        patch: MPL_AFTER_PATCH,
        cost: 0.51,
        tokens: { input: 1250, output: 125 },
        resolvedCount: 0,
        pivotCheckInjected: true,
        editGuardInjected: false,
        patchVerifyInjected: true,
        bashCalls: 6,
      }),
    ),
  };
}

function reqPair(): { before: RunData; after: RunData } {
  return {
    before: buildRunData(
      parts("eval-patchverify-before-requests-5414", {
        instanceId: "psf__requests-5414",
        patch: REQ_BEFORE_PATCH,
        cost: 0.36,
        tokens: { input: 700, output: 70 },
        resolvedCount: 0,
        pivotCheckInjected: true,
        editGuardInjected: false,
        patchVerifyInjected: false,
        bashCalls: 2,
      }),
    ),
    after: buildRunData(
      parts("eval-patchverify-after-requests-5414", {
        instanceId: "psf__requests-5414",
        patch: REQ_AFTER_PATCH,
        cost: 0.45,
        tokens: { input: 1000, output: 100 },
        resolvedCount: 0,
        pivotCheckInjected: true,
        editGuardInjected: false,
        patchVerifyInjected: true,
        bashCalls: 2,
      }),
    ),
  };
}

function allPairs() {
  const mpl = mplPair();
  const req = reqPair();
  return [
    { seed: SYMPY_SEED, before: SYMPY_BEFORE, after: SYMPY_AFTER },
    { seed: MPL_SEED, before: mpl.before, after: mpl.after },
    { seed: REQ_SEED, before: req.before, after: req.after },
  ];
}

// ---------------------------------------------------------------------------
// 1. Pairs before/after labels correctly.
// ---------------------------------------------------------------------------
test("pairs before/after labels per case", () => {
  const c = buildCase(SYMPY_SEED, SYMPY_BEFORE, SYMPY_AFTER);
  assert.equal(c.beforeLabel, "eval-patchverify-before-sympy-16766");
  assert.equal(c.afterLabel, "eval-patchverify-after-sympy-16766");
  assert.equal(c.instanceId, "sympy__sympy-16766");
  // Seeds carry exactly the three controlled-pilot losses, before/after first.
  assert.deepEqual(
    CASE_SEEDS.map((s) => s.instanceId),
    ["sympy__sympy-16766", "matplotlib__matplotlib-22719", "psf__requests-5414"],
  );
});

// ---------------------------------------------------------------------------
// 2. Computes before/after resolution counts.
// ---------------------------------------------------------------------------
test("computes before/after resolution counts and transitions", () => {
  const summary = buildSummary(allPairs().map((p) => buildCase(p.seed, p.before, p.after)));
  assert.equal(summary.cases, 3);
  assert.equal(summary.beforeResolvedCount, 0);
  assert.equal(summary.afterResolvedCount, 0);
  assert.equal(summary.conversionsToResolved, 0);
  assert.equal(summary.regressionsToUnresolved, 0);
  assert.equal(summary.unchangedUnresolved, 3);
  assert.equal(summary.unchangedResolved, 0);

  // A synthetic conversion (before false, after true) is counted as a conversion.
  const converted = buildSummary([
    buildCase(
      SYMPY_SEED,
      SYMPY_BEFORE,
      buildRunData(
        parts("after", {
          instanceId: "sympy__sympy-16766",
          patch: SYMPY_AFTER_PATCH,
          cost: 0.5,
          tokens: { input: 1, output: 1 },
          resolvedCount: 1,
          pivotCheckInjected: true,
          editGuardInjected: false,
          patchVerifyInjected: true,
        }),
      ),
    ),
  ]);
  assert.equal(converted.afterResolvedCount, 1);
  assert.equal(converted.conversionsToResolved, 1);
  assert.equal(converted.unchangedUnresolved, 0);
});

// ---------------------------------------------------------------------------
// 3. Computes token/cost deltas.
// ---------------------------------------------------------------------------
test("computes token and cost deltas (after - before)", () => {
  const c = buildCase(SYMPY_SEED, SYMPY_BEFORE, SYMPY_AFTER);
  assert.equal(c.beforeCost, 0.4);
  assert.equal(c.afterCost, 0.5);
  assert.ok(Math.abs(c.costDelta! - 0.1) < 1e-9);
  assert.equal(c.beforeTokens, 1100); // 1000 + 100
  assert.equal(c.afterTokens, 1430); // 1300 + 130
  assert.equal(c.tokenDelta, 330);
  assert.ok(c.tokenDeltaPct! > 0);
  assert.equal(c.patchCharDelta, SYMPY_AFTER_PATCH.length - SYMPY_BEFORE_PATCH.length);

  const summary = buildSummary(allPairs().map((p) => buildCase(p.seed, p.before, p.after)));
  // All three after runs cost more — mean cost delta is positive.
  assert.ok(summary.meanCostDelta! > 0);
  assert.ok(summary.meanTokenDelta! > 0);
});

// ---------------------------------------------------------------------------
// 4. Reads patch-verify metadata and validates the treatment split.
// ---------------------------------------------------------------------------
test("reads patch-verify metadata and validates the treatment split", () => {
  const c = buildCase(SYMPY_SEED, SYMPY_BEFORE, SYMPY_AFTER);
  assert.equal(c.beforePivotCheckInjected, true);
  assert.equal(c.afterPivotCheckInjected, true);
  assert.equal(c.beforePatchVerifyInjected, false);
  assert.equal(c.afterPatchVerifyInjected, true);
  assert.equal(c.treatmentValid, true);

  // A split is INVALID if the before condition already injected PATCH_VERIFY.
  assert.equal(treatmentSplitValid({ ...SYMPY_BEFORE, patchVerifyInjected: true }, SYMPY_AFTER), false);
  // ...or if the after condition failed to inject it.
  assert.equal(treatmentSplitValid(SYMPY_BEFORE, { ...SYMPY_AFTER, patchVerifyInjected: false }), false);
});

// ---------------------------------------------------------------------------
// 5. Confirms EDIT_GUARD stayed disabled in BOTH arms.
// ---------------------------------------------------------------------------
test("confirms edit-guard stayed disabled in both arms", () => {
  const c = buildCase(SYMPY_SEED, SYMPY_BEFORE, SYMPY_AFTER);
  assert.equal(c.beforeEditGuardInjected, false);
  assert.equal(c.afterEditGuardInjected, false);

  // If EDIT_GUARD leaked into the before arm, the split is invalid (no longer isolated).
  assert.equal(treatmentSplitValid({ ...SYMPY_BEFORE, editGuardInjected: true }, SYMPY_AFTER), false);
  // ...likewise if it leaked into the after arm.
  assert.equal(treatmentSplitValid(SYMPY_BEFORE, { ...SYMPY_AFTER, editGuardInjected: true }), false);

  // Every case in the suite keeps EDIT_GUARD off in both arms.
  for (const p of allPairs()) {
    assert.equal(p.before.editGuardInjected, false);
    assert.equal(p.after.editGuardInjected, false);
  }
});

// ---------------------------------------------------------------------------
// 6. Detects edited-file-set changes.
// ---------------------------------------------------------------------------
test("detects edited-file-set changes", () => {
  // Same gold file before/after → unchanged.
  const same = buildCase(SYMPY_SEED, SYMPY_BEFORE, SYMPY_AFTER);
  assert.deepEqual([...same.beforeEditedFiles], ["sympy/printing/pycode.py"]);
  assert.deepEqual([...same.afterEditedFiles], ["sympy/printing/pycode.py"]);
  assert.equal(same.editedFileSetChanged, false);

  // A patch touching a different file flips the flag.
  const otherPatch = SYMPY_AFTER_PATCH.replace(/pycode\.py/g, "other.py");
  const otherAfter = buildRunData(
    parts("after", {
      instanceId: "sympy__sympy-16766",
      patch: otherPatch,
      cost: 0.5,
      tokens: { input: 1, output: 1 },
      resolvedCount: 0,
      pivotCheckInjected: true,
      editGuardInjected: false,
      patchVerifyInjected: true,
    }),
  );
  const changed = buildCase(SYMPY_SEED, SYMPY_BEFORE, otherAfter);
  assert.equal(changed.editedFileSetChanged, true);
});

// ---------------------------------------------------------------------------
// 7. Classifies unchanged unresolved cases (patch-shape vocabulary).
// ---------------------------------------------------------------------------
test("classifies patch shapes from the fixed vocabulary", () => {
  const cases = allPairs().map((p) => buildCase(p.seed, p.before, p.after));
  const byId = Object.fromEntries(cases.map((c) => [c.instanceId, c.classification]));
  // sympy: scope unreadable from diff → can't claim improvement.
  assert.equal(byId["sympy__sympy-16766"], "different_but_same_defect");
  // matplotlib: after adds the empty-array early return the before patch lacked.
  assert.equal(byId["matplotlib__matplotlib-22719"], "different_and_improved_but_unresolved");
  // requests: after still deletes the existing branch → still a broad rewrite.
  assert.equal(byId["psf__requests-5414"], "different_but_same_defect");

  // Identical patches classify as same_or_nearly_same (index line ignored).
  assert.equal(
    classifyPatchShape(SYMPY_BEFORE_PATCH, SYMPY_BEFORE_PATCH.replace("173bab4", "999aaaa"), () => null),
    "same_or_nearly_same",
  );
  // Empty patch → insufficient evidence.
  assert.equal(classifyPatchShape("", SYMPY_AFTER_PATCH, () => null), "insufficient_evidence");
  // None of the cases converted, so defectFixed is false everywhere.
  assert.ok(cases.every((c) => c.defectFixed === false));
});

// ---------------------------------------------------------------------------
// 7b. Verification-behavior is not_observable without captured final text.
// ---------------------------------------------------------------------------
test("verification behavior is not_observable when no final text is captured", () => {
  const cases = allPairs().map((p) => buildCase(p.seed, p.before, p.after));
  // No final-response text in any fixture → not_observable, checklist not followed.
  assert.ok(cases.every((c) => c.verificationBehavior === "not_observable"));
  assert.ok(cases.every((c) => c.patchVerifyChecklistFollowed === false));
  assert.ok(cases.every((c) => c.patchVerifyMentionedInFinal === false));
  // matplotlib bumped Bash calls 5→6, so its verification behavior is flagged as changed.
  const mpl = cases.find((c) => c.instanceId === "matplotlib__matplotlib-22719")!;
  assert.equal(mpl.verificationBehaviorChanged, true);
  // sympy held Bash calls at 2→2, so unchanged.
  const sympy = cases.find((c) => c.instanceId === "sympy__sympy-16766")!;
  assert.equal(sympy.verificationBehaviorChanged, false);

  // When a final response IS captured with >=3 checklist headings → substantively_followed.
  const followed = buildRunData(
    parts("after", {
      instanceId: "sympy__sympy-16766",
      patch: SYMPY_AFTER_PATCH,
      cost: 0.5,
      tokens: { input: 1, output: 1 },
      resolvedCount: 0,
      pivotCheckInjected: true,
      editGuardInjected: false,
      patchVerifyInjected: true,
      finalText: "PATCH_VERIFY: SCOPE LANDED in PythonCodePrinter. FAILING BEHAVIOR HANDLED. CHECK RUN: pytest passed.",
    }),
  );
  assert.equal(classifyVerificationBehavior(followed), "substantively_followed");
  // A bare mention with no headings → mentioned_but_superficial.
  const mention = { ...followed, checklistTokens: [], finalText: "I considered patch verify but moved on." };
  assert.equal(classifyVerificationBehavior(mention as RunData), "mentioned_but_superficial");
});

// ---------------------------------------------------------------------------
// 8. Markdown includes verification-behavior, interpretation, recommendation, non-claims.
// ---------------------------------------------------------------------------
test("markdown includes all required sections and key statements", () => {
  const report = buildReport("t", allPairs());
  const md = renderMarkdown(report);
  for (const heading of [
    "# Stage 5 PATCH_VERIFY 3-loss comparison",
    "## Summary",
    "## Experimental design",
    "## Result table",
    "## Per-case analysis",
    "## Patch-shape comparison",
    "## Verification-behavior analysis",
    "## Cost and token impact",
    "## Interpretation",
    "## Recommended next engineering work",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
  assert.ok(md.includes("PATCH_VERIFY did not produce a resolution improvement on the three targeted losses"));
  assert.ok(md.includes("patch-critic / repair loop"));
  assert.ok(md.includes("not_observable"));
  assert.ok(md.includes("not a statistical benchmark"));
  assert.ok(md.includes("does not compare VTRACE to VEXP"));
  assert.ok(md.includes("should not become always-on"));
});

// ---------------------------------------------------------------------------
// 9. JSON exposes summary and cases.
// ---------------------------------------------------------------------------
test("json exposes the required top-level and per-case shape", () => {
  const report = buildReport("2026-01-01T00:00:00Z", allPairs());
  const parsed = JSON.parse(renderJson(report));
  for (const key of ["generatedAt", "summary", "cases", "recommendation", "nonClaims"]) {
    assert.ok(key in parsed, `missing top-level key: ${key}`);
  }
  assert.equal(parsed.cases.length, 3);
  const requiredCaseKeys = [
    "instanceId", "repo", "beforeLabel", "afterLabel",
    "beforeResolved", "afterResolved", "resolutionChanged",
    "beforeCost", "afterCost", "costDelta", "costDeltaPct",
    "beforeTokens", "afterTokens", "tokenDelta", "tokenDeltaPct",
    "beforePatchChars", "afterPatchChars", "patchCharDelta",
    "beforeEditedFiles", "afterEditedFiles", "editedFileSetChanged",
    "beforePivotCheckInjected", "afterPivotCheckInjected",
    "beforeEditGuardInjected", "afterEditGuardInjected",
    "beforePatchVerifyInjected", "afterPatchVerifyInjected", "treatmentValid",
    "beforeHiddenPivotsInspected", "afterHiddenPivotsInspected",
    "beforePatchSummary", "afterPatchSummary",
    "knownDefectBefore", "knownDefectAfter", "defectFixed",
    "patchVerifyMentionedInFinal", "patchVerifyChecklistFollowed", "verificationBehaviorChanged",
    "verificationBehavior",
    "classification", "confidence", "evidence",
  ];
  for (const key of requiredCaseKeys) {
    assert.ok(key in parsed.cases[0], `missing case key: ${key}`);
  }
  assert.equal(parsed.summary.unchangedUnresolved, 3);
  assert.equal(parsed.summary.patchVerifyTreatmentValidCount, 3);
  assert.equal(parsed.nonClaims.length, 6);
});

// ---------------------------------------------------------------------------
// CLI arg parsing.
// ---------------------------------------------------------------------------
test("parseArgs honors --results and --out-name with defaults", () => {
  assert.deepEqual(parseArgs([]), {
    resultsDir: "benchmarks/stage5_vexp_swe_bench_smoke/results",
    outName: "stage5_patch_verify_3_loss_comparison",
  });
  assert.deepEqual(parseArgs(["--results", "r", "--out-name", "o"]), { resultsDir: "r", outName: "o" });
  assert.throws(() => parseArgs(["--bogus"]));
});
