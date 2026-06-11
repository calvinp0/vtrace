import assert from "node:assert/strict";
import { test } from "bun:test";

import { type PatchProbeSummary, type PythonParser, summarizePatch } from "./stage5_patch_probes";
import {
  type PatchCriticInput,
  buildDeterministicPatchCriticReport,
  validatePatchCriticReport,
} from "./stage5_patch_critic";

// ---------------------------------------------------------------------------
// Fixtures — synthetic diffs modeled on (but not copied from) the real runs.
// ---------------------------------------------------------------------------

// sympy: inserted printer methods WITHIN PythonCodePrinter (class header visible) → scope pass,
// and a self-contained def block for the parse probe.
const SYMPY_SCOPE_OK = [
  "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py",
  "--- a/sympy/printing/pycode.py",
  "+++ b/sympy/printing/pycode.py",
  "@@ -349,6 +349,9 @@ def _print_NoneToken(self, arg):",
  " ",
  " class PythonCodePrinter(AbstractPythonCodePrinter):",
  " ",
  "+    def _print_Indexed(self, expr):",
  "+        indices = [self._print(i) for i in expr.indices]",
  '+        return "%s[%s]" % (self._print(expr.base.label), ", ".join(indices))',
].join("\n");

// sympy: inserted method with NO visible class header → scope unknown.
const SYMPY_SCOPE_UNKNOWN = [
  "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py",
  "--- a/sympy/printing/pycode.py",
  "+++ b/sympy/printing/pycode.py",
  "@@ -357,6 +357,9 @@ def _print_Not(self, expr):",
  "+    def _print_Indexed(self, expr):",
  "+        return base",
].join("\n");

// matplotlib: only narrows the guard; no empty-array early return → failing behavior absent.
const MPL_BEHAVIOR_ABSENT = [
  "diff --git a/lib/matplotlib/category.py b/lib/matplotlib/category.py",
  "--- a/lib/matplotlib/category.py",
  "+++ b/lib/matplotlib/category.py",
  "@@ -57,7 +57,7 @@ class StrCategoryConverter(units.ConversionInterface):",
  "-                             for v in values)",
  "+                             for v in values) if len(values) else False",
].join("\n");

// requests: broad control-flow rewrite (many deletions) → minimality fail.
const REQ_BROAD_REWRITE = [
  "diff --git a/requests/models.py b/requests/models.py",
  "--- a/requests/models.py",
  "+++ b/requests/models.py",
  "@@ -394,16 +394,16 @@ class PreparedRequest:",
  "-        if not unicode_is_ascii(host):",
  "-            try:",
  "-                host = self._get_idna_encoded_host(host)",
  "-            except UnicodeError:",
  "-                raise InvalidURL('URL has an invalid label.')",
  "-        elif host.startswith(u'*'):",
  "-            raise InvalidURL('URL has an invalid label.')",
  "-        elif host is None:",
  "-            raise ValueError('host cannot be None')",
  "-        else:",
  "+        if host is None:",
  "+            raise ValueError('host cannot be None')",
  "+        if not unicode_is_ascii(host):",
  "+            host = self._get_idna_encoded_host(host)",
  "+        elif host.startswith(u'*'):",
  "+            raise InvalidURL('bad')",
].join("\n");

const PARSE_OK: PythonParser = () => ({ ok: true });
const PARSE_FAIL: PythonParser = () => ({ ok: false, error: "invalid syntax" });

// Build a probe summary from a synthetic diff + injected parser (no tool calls → test evidence
// is `unknown`, which keeps these unit tests focused on the patch-shape dimensions).
function summaryOf(
  instanceId: string,
  runLabel: string,
  patch: string,
  parse: PythonParser,
): PatchProbeSummary {
  return summarizePatch({ instanceId, runLabel, patch, toolCalls: null, stdout: null, stderr: null, parsePython: parse });
}

// Wrap a probe summary in a minimal critic input.
function inputFrom(summary: PatchProbeSummary): PatchCriticInput {
  return {
    instanceId: summary.instanceId,
    runLabel: summary.runLabel,
    repo: "example/repo",
    issueText: null,
    firstPatch: "(elided)",
    editedFiles: summary.editedFiles,
    patchChars: summary.patchChars,
    probeSummary: summary,
    treatmentMetadata: { pivotCheckInjected: true, editGuardInjected: false, patchVerifyInjected: null },
    contextSignals: { hiddenPivotsInspected: null, hiddenPivotsEdited: null, orderedToolLogPresent: true },
  };
}

// ---------------------------------------------------------------------------
// 1. failing_behavior_pattern fail → failing_behavior_handled=false, repair_required=true.
// ---------------------------------------------------------------------------
test("failing_behavior fail maps to handled=false and forces repair", () => {
  const summary = summaryOf("matplotlib__matplotlib-22719", "mpl-absent", MPL_BEHAVIOR_ABSENT, PARSE_OK);
  const report = buildDeterministicPatchCriticReport(inputFrom(summary));
  assert.equal(report.failing_behavior_handled, false);
  assert.equal(report.repair_required, true);
  assert.ok(report.repair_instructions.toLowerCase().includes("empty-array"));
});

// ---------------------------------------------------------------------------
// 2. minimality_rewrite_risk fail → minimality_ok=false, repair_required=true.
// ---------------------------------------------------------------------------
test("minimality fail maps to minimality_ok=false and forces repair at high confidence", () => {
  const summary = summaryOf("psf__requests-5414", "req-rewrite", REQ_BROAD_REWRITE, PARSE_OK);
  const report = buildDeterministicPatchCriticReport(inputFrom(summary));
  assert.equal(report.minimality_ok, false);
  assert.equal(report.repair_required, true);
  assert.equal(report.risk, "high");
  assert.equal(report.confidence, "high");
  // The requests minimality instruction names the original guard and a narrow alternative.
  assert.ok(report.repair_instructions.includes("unicode_is_ascii"));
  assert.ok(report.repair_instructions.toLowerCase().includes("guard"));
});

// ---------------------------------------------------------------------------
// 3. inserted_method_scope unknown → scope_ok=null and does NOT force repair alone.
// ---------------------------------------------------------------------------
test("scope unknown maps to scope_ok=null without forcing repair", () => {
  const summary = summaryOf("sympy__sympy-16766", "sympy-unknown", SYMPY_SCOPE_UNKNOWN, PARSE_OK);
  const report = buildDeterministicPatchCriticReport(inputFrom(summary));
  assert.equal(report.scope_ok, null);
  assert.equal(report.repair_required, false);
  // The dimension must be documented as a gap, not silently passed.
  assert.ok(report.scope_evidence.length > 0);
});

// ---------------------------------------------------------------------------
// 4. python_parse fail → high risk and repair_required=true.
// ---------------------------------------------------------------------------
test("python_parse fail maps to high risk and forces repair", () => {
  // SYMPY_SCOPE_OK has a self-contained def block; PARSE_FAIL makes the parse probe fail.
  const summary = summaryOf("sympy__sympy-16766", "sympy-parsefail", SYMPY_SCOPE_OK, PARSE_FAIL);
  const report = buildDeterministicPatchCriticReport(inputFrom(summary));
  assert.equal(report.risk, "high");
  assert.equal(report.repair_required, true);
  assert.equal(report.confidence, "high");
  assert.ok(report.repair_instructions.toLowerCase().includes("syntax"));
});

// ---------------------------------------------------------------------------
// 5. Evidence strings are non-empty (and the report validates).
// ---------------------------------------------------------------------------
test("every report carries non-empty evidence and passes validation", () => {
  for (const [instanceId, label, patch, parse] of [
    ["matplotlib__matplotlib-22719", "mpl-absent", MPL_BEHAVIOR_ABSENT, PARSE_OK],
    ["psf__requests-5414", "req-rewrite", REQ_BROAD_REWRITE, PARSE_OK],
    ["sympy__sympy-16766", "sympy-ok", SYMPY_SCOPE_OK, PARSE_OK],
    ["sympy__sympy-16766", "sympy-unknown", SYMPY_SCOPE_UNKNOWN, PARSE_OK],
  ] as const) {
    const report = buildDeterministicPatchCriticReport(inputFrom(summaryOf(instanceId, label, patch, parse)));
    for (const s of [
      report.scope_evidence,
      report.failing_behavior_evidence,
      report.minimality_evidence,
      report.test_evidence,
    ]) {
      assert.ok(s.trim().length > 0, `evidence empty for ${label}`);
    }
    assert.ok(report.evidence_probe_ids.length > 0);
    assert.deepEqual(validatePatchCriticReport(report), []);
  }
});

// ---------------------------------------------------------------------------
// 6. Missing test evidence is recorded but does not force repair alone.
// ---------------------------------------------------------------------------
test("missing test evidence is recorded but never forces repair on its own", () => {
  // sympy scope-ok patch (scope pass, minimality pass, parse pass) but a non-test tool call →
  // test_evidence fails. The only negative signal is test evidence, which must not force repair.
  const summary = summarizePatch({
    instanceId: "sympy__sympy-16766",
    runLabel: "sympy-no-tests",
    patch: SYMPY_SCOPE_OK,
    toolCalls: [{ category: "read", path: "/x/foo.py", command: null }],
    stdout: null,
    stderr: null,
    parsePython: PARSE_OK,
  });
  const report = buildDeterministicPatchCriticReport(inputFrom(summary));
  assert.equal(report.test_evidence_ok, false);
  assert.equal(report.repair_required, false);
  assert.equal(report.scope_ok, true);
});

// ---------------------------------------------------------------------------
// Extra: validation flags a contrived high-confidence fail that skips repair.
// ---------------------------------------------------------------------------
test("validation rejects a high-confidence fail that does not request repair", () => {
  const base = buildDeterministicPatchCriticReport(
    inputFrom(summaryOf("psf__requests-5414", "req-rewrite", REQ_BROAD_REWRITE, PARSE_OK)),
  );
  const tampered = { ...base, repair_required: false, repair_reason: "", repair_instructions: "" };
  const violations = validatePatchCriticReport(tampered);
  assert.ok(violations.length > 0);
  assert.ok(violations.some((v) => v.toLowerCase().includes("repair_required")));
});
