import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  CASE_SEEDS,
  buildCase,
  buildReport,
  buildRunData,
  buildSummary,
  classifyPatchShape,
  parseArgs,
  renderJson,
  renderMarkdown,
  treatmentSplitValid,
  type RawRunParts,
  type RunData,
} from "./run_stage5_edit_guard_comparison";

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

// requests: both delete the existing `if not unicode_is_ascii` branch (broad rewrite).
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
    treatmentValid?: boolean;
    pivotPath?: string;
    readPath?: string;
  },
): RawRunParts {
  return {
    runLabel,
    meta: {
      vtracePivotCheckInjected: opts.pivotCheckInjected,
      vtraceEditGuardInjected: opts.editGuardInjected,
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
    toolCalls: opts.readPath ? [{ category: "read", path: opts.readPath }] : [],
  };
}

const SYMPY_BEFORE = buildRunData(
  parts("eval-editguard-before-sympy-16766", {
    instanceId: "sympy__sympy-16766",
    patch: SYMPY_BEFORE_PATCH,
    cost: 0.4,
    tokens: { input: 1000, output: 100 },
    resolvedCount: 0,
    pivotCheckInjected: true,
    editGuardInjected: false,
    pivotPath: "sympy/printing/pycode.py",
    readPath: "/x/.bench-repos/sympy__sympy/sympy/printing/pycode.py",
  }),
);
const SYMPY_AFTER = buildRunData(
  parts("eval-editguard-after-sympy-16766", {
    instanceId: "sympy__sympy-16766",
    patch: SYMPY_AFTER_PATCH,
    cost: 0.5,
    tokens: { input: 1300, output: 130 },
    resolvedCount: 0,
    pivotCheckInjected: true,
    editGuardInjected: true,
    pivotPath: "sympy/printing/pycode.py",
    readPath: "/x/.bench-repos/sympy__sympy/sympy/printing/pycode.py",
  }),
);

const SYMPY_SEED = CASE_SEEDS.find((s) => s.instanceId === "sympy__sympy-16766")!;
const MPL_SEED = CASE_SEEDS.find((s) => s.instanceId === "matplotlib__matplotlib-22719")!;
const REQ_SEED = CASE_SEEDS.find((s) => s.instanceId === "psf__requests-5414")!;

function mplPair(): { before: RunData; after: RunData } {
  return {
    before: buildRunData(
      parts("eval-editguard-before-matplotlib-22719", {
        instanceId: "matplotlib__matplotlib-22719",
        patch: MPL_BEFORE_PATCH,
        cost: 0.45,
        tokens: { input: 1100, output: 110 },
        resolvedCount: 0,
        pivotCheckInjected: true,
        editGuardInjected: false,
      }),
    ),
    after: buildRunData(
      parts("eval-editguard-after-matplotlib-22719", {
        instanceId: "matplotlib__matplotlib-22719",
        patch: MPL_AFTER_PATCH,
        cost: 0.51,
        tokens: { input: 1250, output: 125 },
        resolvedCount: 0,
        pivotCheckInjected: true,
        editGuardInjected: true,
      }),
    ),
  };
}

function reqPair(): { before: RunData; after: RunData } {
  return {
    before: buildRunData(
      parts("eval-editguard-before-requests-5414", {
        instanceId: "psf__requests-5414",
        patch: REQ_BEFORE_PATCH,
        cost: 0.36,
        tokens: { input: 700, output: 70 },
        resolvedCount: 0,
        pivotCheckInjected: true,
        editGuardInjected: false,
      }),
    ),
    after: buildRunData(
      parts("eval-editguard-after-requests-5414", {
        instanceId: "psf__requests-5414",
        patch: REQ_AFTER_PATCH,
        cost: 0.45,
        tokens: { input: 1000, output: 100 },
        resolvedCount: 0,
        pivotCheckInjected: true,
        editGuardInjected: true,
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
  assert.equal(c.beforeLabel, "eval-editguard-before-sympy-16766");
  assert.equal(c.afterLabel, "eval-editguard-after-sympy-16766");
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
          editGuardInjected: true,
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
// 4. Reads edit-guard metadata and validates treatment split.
// ---------------------------------------------------------------------------
test("reads edit-guard metadata and validates the treatment split", () => {
  const c = buildCase(SYMPY_SEED, SYMPY_BEFORE, SYMPY_AFTER);
  assert.equal(c.beforePivotCheckInjected, true);
  assert.equal(c.afterPivotCheckInjected, true);
  assert.equal(c.beforeEditGuardInjected, false);
  assert.equal(c.afterEditGuardInjected, true);
  assert.equal(c.treatmentValid, true);

  // A split is INVALID if the before condition already injected EDIT_GUARD.
  const bad = treatmentSplitValid(
    { ...SYMPY_BEFORE, editGuardInjected: true },
    SYMPY_AFTER,
  );
  assert.equal(bad, false);
  // ...or if the after condition failed to inject it.
  assert.equal(treatmentSplitValid(SYMPY_BEFORE, { ...SYMPY_AFTER, editGuardInjected: false }), false);
});

// ---------------------------------------------------------------------------
// 5. Detects edited-file-set changes.
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
      editGuardInjected: true,
    }),
  );
  const changed = buildCase(SYMPY_SEED, SYMPY_BEFORE, otherAfter);
  assert.equal(changed.editedFileSetChanged, true);
});

// ---------------------------------------------------------------------------
// 6. Classifies unchanged unresolved cases (patch-shape vocabulary).
// ---------------------------------------------------------------------------
test("classifies patch shapes from the fixed vocabulary", () => {
  const cases = allPairs().map((p) => buildCase(p.seed, p.before, p.after));
  const bySity = Object.fromEntries(cases.map((c) => [c.instanceId, c.classification]));
  // sympy: scope unreadable from diff → can't claim improvement.
  assert.equal(bySity["sympy__sympy-16766"], "different_but_same_defect");
  // matplotlib: after adds the empty-array early return the before patch lacked.
  assert.equal(bySity["matplotlib__matplotlib-22719"], "different_and_improved_but_unresolved");
  // requests: after still deletes the existing branch → still a broad rewrite.
  assert.equal(bySity["psf__requests-5414"], "different_but_same_defect");

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
// 7. Markdown includes interpretation and non-claims.
// ---------------------------------------------------------------------------
test("markdown includes all required sections, interpretation, and non-claims", () => {
  const report = buildReport("t", allPairs());
  const md = renderMarkdown(report);
  for (const heading of [
    "# Stage 5 EDIT_GUARD 3-loss comparison",
    "## Summary",
    "## Experimental design",
    "## Result table",
    "## Per-case analysis",
    "## Patch-shape comparison",
    "## Cost and token impact",
    "## Interpretation",
    "## Recommended next engineering work",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
  assert.ok(md.includes("EDIT_GUARD did not produce a resolution improvement on the three targeted losses"));
  assert.ok(md.includes("PATCH_VERIFY"));
  assert.ok(md.includes("not a statistical benchmark"));
  assert.ok(md.includes("does not compare VTRACE to VEXP"));
});

// ---------------------------------------------------------------------------
// 8. JSON exposes summary and cases.
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
    "beforeEditGuardInjected", "afterEditGuardInjected", "treatmentValid",
    "beforeHiddenPivotsInspected", "afterHiddenPivotsInspected",
    "beforePatchSummary", "afterPatchSummary",
    "knownDefectBefore", "knownDefectAfter", "defectFixed",
    "classification", "confidence", "evidence",
  ];
  for (const key of requiredCaseKeys) {
    assert.ok(key in parsed.cases[0], `missing case key: ${key}`);
  }
  assert.equal(parsed.summary.unchangedUnresolved, 3);
  assert.equal(parsed.summary.editGuardTreatmentValidCount, 3);
  assert.equal(parsed.nonClaims.length, 5);
});

// ---------------------------------------------------------------------------
// CLI arg parsing.
// ---------------------------------------------------------------------------
test("parseArgs honors --results and --out-name with defaults", () => {
  assert.deepEqual(parseArgs([]), {
    resultsDir: "benchmarks/stage5_vexp_swe_bench_smoke/results",
    outName: "stage5_edit_guard_3_loss_comparison",
  });
  assert.deepEqual(parseArgs(["--results", "r", "--out-name", "o"]), { resultsDir: "r", outName: "o" });
  assert.throws(() => parseArgs(["--bogus"]));
});
