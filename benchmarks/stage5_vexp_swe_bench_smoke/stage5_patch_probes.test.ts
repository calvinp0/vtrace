import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  INSTANCE_CONFIGS,
  type PythonParser,
  type RawToolCall,
  editedFilesProbe,
  extractParseableBlocks,
  failingBehaviorProbe,
  findInsertedMethods,
  insertedMethodScopeProbe,
  minimalityProbe,
  pythonParseProbe,
  summarizePatch,
  testEvidenceProbe,
} from "./stage5_patch_probes";

// ---------------------------------------------------------------------------
// Fixtures — synthetic diffs modeled on (but not copied from) the real runs.
// ---------------------------------------------------------------------------

// sympy: inserted printer methods WITHIN PythonCodePrinter (class header visible).
const SYMPY_SCOPE_OK = [
  "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py",
  "index a3f0310..780baa6 100644",
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

// sympy: inserted methods with NO visible class header (scope indeterminate from the diff).
const SYMPY_SCOPE_UNKNOWN = [
  "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py",
  "index a3f0310..173bab4 100644",
  "--- a/sympy/printing/pycode.py",
  "+++ b/sympy/printing/pycode.py",
  "@@ -357,6 +357,9 @@ def _print_Not(self, expr):",
  "+    def _print_Indexed(self, expr):",
  "+        return base",
].join("\n");

// sympy: inserted method in the WRONG class (AbstractPythonCodePrinter).
const SYMPY_SCOPE_WRONG = [
  "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py",
  "--- a/sympy/printing/pycode.py",
  "+++ b/sympy/printing/pycode.py",
  "@@ -200,6 +200,9 @@",
  " class AbstractPythonCodePrinter(CodePrinter):",
  "+    def _print_Indexed(self, expr):",
  "+        return base",
].join("\n");

// matplotlib: ADDS the empty-array early return (failing behavior handled).
const MPL_BEHAVIOR_HANDLED = [
  "diff --git a/lib/matplotlib/category.py b/lib/matplotlib/category.py",
  "--- a/lib/matplotlib/category.py",
  "+++ b/lib/matplotlib/category.py",
  "@@ -53,6 +53,9 @@ class StrCategoryConverter(units.ConversionInterface):",
  "         values = np.atleast_1d(np.array(value, dtype=object))",
  "+        # empty arrays",
  "+        if not values.size:",
  "+            return np.array([], dtype=float)",
].join("\n");

// matplotlib: only narrows the guard; no empty-array early return (failing behavior absent).
const MPL_BEHAVIOR_ABSENT = [
  "diff --git a/lib/matplotlib/category.py b/lib/matplotlib/category.py",
  "--- a/lib/matplotlib/category.py",
  "+++ b/lib/matplotlib/category.py",
  "@@ -57,7 +57,7 @@ class StrCategoryConverter(units.ConversionInterface):",
  "-                             for v in values)",
  "+                             for v in values) if values.size else False",
].join("\n");

// requests: minimal additive validation (+5/-0, no deletions).
const REQ_ADDITIVE = [
  "diff --git a/requests/models.py b/requests/models.py",
  "--- a/requests/models.py",
  "+++ b/requests/models.py",
  "@@ -405,6 +405,5 @@ class PreparedRequest:",
  "         elif host.startswith(u'*'):",
  "             raise InvalidURL('URL has an invalid label.')",
  "+        else:",
  "+            try:",
  "+                self._get_idna_encoded_host(host)",
  "+            except UnicodeError:",
  "+                raise InvalidURL('URL has an invalid label.')",
].join("\n");

// requests: broad control-flow rewrite (many deletions of existing branches).
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

// A parser that accepts everything (stand-in for a working python3).
const PARSE_OK: PythonParser = () => ({ ok: true });
// A parser that reports a syntax error.
const PARSE_FAIL: PythonParser = () => ({ ok: false, error: "invalid syntax" });
// A parser that is unavailable.
const PARSE_UNAVAILABLE: PythonParser = () => null;

// ---------------------------------------------------------------------------
// 1. Parses edited files from a unified diff.
// ---------------------------------------------------------------------------
test("edited_files probe parses files and fails on empty patch", () => {
  const ok = editedFilesProbe(SYMPY_SCOPE_OK);
  assert.equal(ok.status, "pass");
  assert.ok(ok.evidence.join(" ").includes("sympy/printing/pycode.py"));

  const empty = editedFilesProbe("");
  assert.equal(empty.status, "fail");
});

// ---------------------------------------------------------------------------
// 2. Flags broad rewrite risk.
// ---------------------------------------------------------------------------
test("minimality probe flags a broad control-flow rewrite", () => {
  const r = minimalityProbe(REQ_BROAD_REWRITE);
  assert.equal(r.status, "fail");
  assert.equal(r.confidence, "high");
  assert.ok(r.evidence.join(" ").toLowerCase().includes("broad-rewrite"));
});

// ---------------------------------------------------------------------------
// 3. Does not flag a small additive patch as a broad rewrite.
// ---------------------------------------------------------------------------
test("minimality probe passes a small additive patch", () => {
  const r = minimalityProbe(REQ_ADDITIVE);
  assert.equal(r.status, "pass");
  // sympy additive insert is also minimal.
  assert.equal(minimalityProbe(SYMPY_SCOPE_OK).status, "pass");
});

// ---------------------------------------------------------------------------
// 4. Detects expected failing behavior pattern when present.
// ---------------------------------------------------------------------------
test("failing_behavior probe passes when the expected behavior is present", () => {
  const cfg = INSTANCE_CONFIGS["matplotlib__matplotlib-22719"]!;
  const r = failingBehaviorProbe(MPL_BEHAVIOR_HANDLED, cfg);
  assert.equal(r.status, "pass"); // matches "return" + "empty"
  assert.ok(r.evidence.join(" ").includes("return"));
});

// ---------------------------------------------------------------------------
// 5. Warns/fails when expected failing behavior pattern is absent.
// ---------------------------------------------------------------------------
test("failing_behavior probe fails when the expected behavior is absent", () => {
  const cfg = INSTANCE_CONFIGS["matplotlib__matplotlib-22719"]!;
  const r = failingBehaviorProbe(MPL_BEHAVIOR_ABSENT, cfg);
  assert.equal(r.status, "fail"); // none of values.size==0 / return / empty present
});

// ---------------------------------------------------------------------------
// 6. Detects inserted method scope when enough context exists.
// ---------------------------------------------------------------------------
test("scope probe passes when the method lands in the expected class and fails on the wrong class", () => {
  const cfg = INSTANCE_CONFIGS["sympy__sympy-16766"]!;

  const ok = insertedMethodScopeProbe(SYMPY_SCOPE_OK, cfg);
  assert.equal(ok.status, "pass");
  const methods = findInsertedMethods(SYMPY_SCOPE_OK, "_print_");
  assert.equal(methods[0]!.enclosingClass, "PythonCodePrinter");

  const wrong = insertedMethodScopeProbe(SYMPY_SCOPE_WRONG, cfg);
  assert.equal(wrong.status, "fail");
  assert.ok(wrong.evidence.join(" ").includes("AbstractPythonCodePrinter"));
});

// ---------------------------------------------------------------------------
// 7. Returns unknown for inserted method scope when context is insufficient.
// ---------------------------------------------------------------------------
test("scope probe returns unknown when no class header is visible", () => {
  const cfg = INSTANCE_CONFIGS["sympy__sympy-16766"]!;
  const r = insertedMethodScopeProbe(SYMPY_SCOPE_UNKNOWN, cfg);
  assert.equal(r.status, "unknown");
  assert.ok(r.evidence.join(" ").toLowerCase().includes("cannot be determined"));
});

// ---------------------------------------------------------------------------
// 8. Detects test evidence from synthetic tool-call / stdout artifacts.
// ---------------------------------------------------------------------------
test("test_evidence probe distinguishes named tests, ad-hoc checks, and none", () => {
  const pytestCall: RawToolCall[] = [
    { category: "other", path: null, command: "python -m pytest lib/matplotlib/tests/test_category.py -v" },
  ];
  assert.equal(testEvidenceProbe(pytestCall, null, null).status, "pass");

  const adhocCall: RawToolCall[] = [
    { category: "other", path: null, command: "python -c \"import matplotlib; print('ok')\"" },
  ];
  assert.equal(testEvidenceProbe(adhocCall, null, null).status, "warn");

  const noChecks: RawToolCall[] = [{ category: "read", path: "/x/foo.py", command: null }];
  assert.equal(testEvidenceProbe(noChecks, null, null).status, "fail");

  // No artifacts at all → unknown.
  assert.equal(testEvidenceProbe(null, null, null).status, "unknown");
});

// ---------------------------------------------------------------------------
// Parse-probe behavior + extraction.
// ---------------------------------------------------------------------------
test("python_parse extracts self-contained blocks and respects the injected parser", () => {
  // sympy insert is a full method → one block, parses OK.
  const blocks = extractParseableBlocks(SYMPY_SCOPE_OK);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0]!.startsWith("def _print_Indexed"));
  assert.equal(pythonParseProbe(SYMPY_SCOPE_OK, PARSE_OK).status, "pass");
  assert.equal(pythonParseProbe(SYMPY_SCOPE_OK, PARSE_FAIL).status, "fail");
  assert.equal(pythonParseProbe(SYMPY_SCOPE_OK, PARSE_UNAVAILABLE).status, "unknown");

  // matplotlib fragment (no top-level def/class) → no block → unknown, regardless of parser.
  assert.equal(extractParseableBlocks(MPL_BEHAVIOR_ABSENT).length, 0);
  assert.equal(pythonParseProbe(MPL_BEHAVIOR_ABSENT, PARSE_OK).status, "unknown");
});

// ---------------------------------------------------------------------------
// summarizePatch wiring + knownDefectLikelyCaught semantics.
// ---------------------------------------------------------------------------
test("summarizePatch wires probes and computes knownDefectLikelyCaught per target probe", () => {
  // matplotlib, behavior absent → failing_behavior fails → known defect caught.
  const mplAbsent = summarizePatch({
    instanceId: "matplotlib__matplotlib-22719",
    runLabel: "synthetic-mpl-absent",
    patch: MPL_BEHAVIOR_ABSENT,
    toolCalls: [{ category: "other", path: null, command: "python -m pytest tests/test_category.py" }],
    stdout: null,
    stderr: null,
    parsePython: PARSE_OK,
  });
  assert.equal(mplAbsent.knownDefectLikelyCaught, true);
  assert.ok(["medium", "high"].includes(mplAbsent.overallRisk));
  // The matplotlib config has no scope probe.
  assert.ok(!mplAbsent.probes.some((p) => p.probeId === "inserted_method_scope"));

  // matplotlib, behavior handled → failing_behavior passes → defect not flagged.
  const mplOk = summarizePatch({
    instanceId: "matplotlib__matplotlib-22719",
    runLabel: "synthetic-mpl-ok",
    patch: MPL_BEHAVIOR_HANDLED,
    toolCalls: null,
    stdout: null,
    stderr: null,
    parsePython: PARSE_OK,
  });
  assert.equal(mplOk.knownDefectLikelyCaught, false);

  // requests broad rewrite → minimality fails (target probe) → defect caught.
  const reqRewrite = summarizePatch({
    instanceId: "psf__requests-5414",
    runLabel: "synthetic-req-rewrite",
    patch: REQ_BROAD_REWRITE,
    toolCalls: null,
    stdout: null,
    stderr: null,
    parsePython: PARSE_OK,
  });
  assert.equal(reqRewrite.knownDefectLikelyCaught, true);
  assert.equal(reqRewrite.overallRisk, "high");

  // sympy scope unknown → target probe unknown → knownDefectLikelyCaught null.
  const sympyUnknown = summarizePatch({
    instanceId: "sympy__sympy-16766",
    runLabel: "synthetic-sympy-unknown",
    patch: SYMPY_SCOPE_UNKNOWN,
    toolCalls: null,
    stdout: null,
    stderr: null,
    parsePython: PARSE_OK,
  });
  assert.equal(sympyUnknown.knownDefectLikelyCaught, null);
});
