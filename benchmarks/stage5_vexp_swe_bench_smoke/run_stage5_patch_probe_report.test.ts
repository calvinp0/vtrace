import assert from "node:assert/strict";
import { test } from "bun:test";

import { summarizePatch, type PythonParser } from "./stage5_patch_probes";
import {
  PROBE_DEFINITIONS,
  buildInstanceRollups,
  buildReport,
  buildSummary,
  parseArgs,
  recommendedNextStep,
  renderJson,
  renderMarkdown,
} from "./run_stage5_patch_probe_report";

const PARSE_OK: PythonParser = () => ({ ok: true });

// Synthetic diffs (no live artifacts) covering the three instances' defect signatures.
const MPL_ABSENT = [
  "diff --git a/lib/matplotlib/category.py b/lib/matplotlib/category.py",
  "--- a/lib/matplotlib/category.py",
  "+++ b/lib/matplotlib/category.py",
  "@@ -57,7 +57,7 @@ class StrCategoryConverter(units.ConversionInterface):",
  "-                             for v in values)",
  "+                             for v in values) if values.size else False",
].join("\n");

const REQ_REWRITE = [
  "diff --git a/requests/models.py b/requests/models.py",
  "--- a/requests/models.py",
  "+++ b/requests/models.py",
  "@@ -394,16 +394,12 @@ class PreparedRequest:",
  "-        if not unicode_is_ascii(host):",
  "-            try:",
  "-                host = self._get_idna_encoded_host(host)",
  "-            except UnicodeError:",
  "-                raise InvalidURL('URL has an invalid label.')",
  "-        elif host.startswith(u'*'):",
  "-            raise InvalidURL('URL has an invalid label.')",
  "-        else:",
  "+        if host is None:",
  "+            raise ValueError('x')",
  "+        if not unicode_is_ascii(host):",
  "+            host = self._get_idna_encoded_host(host)",
].join("\n");

const SYMPY_UNKNOWN = [
  "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py",
  "--- a/sympy/printing/pycode.py",
  "+++ b/sympy/printing/pycode.py",
  "@@ -357,6 +357,9 @@ def _print_Not(self, expr):",
  "+    def _print_Indexed(self, expr):",
  "+        return base",
].join("\n");

function syntheticRuns() {
  return [
    summarizePatch({
      instanceId: "matplotlib__matplotlib-22719",
      runLabel: "eval-patchverify-after-matplotlib-22719",
      patch: MPL_ABSENT,
      toolCalls: [{ category: "other", path: null, command: "python -m pytest tests/test_category.py" }],
      stdout: null,
      stderr: null,
      parsePython: PARSE_OK,
    }),
    summarizePatch({
      instanceId: "psf__requests-5414",
      runLabel: "eval-editguard-before-requests-5414",
      patch: REQ_REWRITE,
      toolCalls: [{ category: "other", path: null, command: "python -c \"import requests\"" }],
      stdout: null,
      stderr: null,
      parsePython: PARSE_OK,
    }),
    summarizePatch({
      instanceId: "sympy__sympy-16766",
      runLabel: "eval-editguard-after-sympy-16766",
      patch: SYMPY_UNKNOWN,
      toolCalls: null,
      stdout: null,
      stderr: null,
      parsePython: PARSE_OK,
    }),
  ];
}

// ---------------------------------------------------------------------------
// 9. Report runner emits Markdown and JSON with required sections/fields.
// ---------------------------------------------------------------------------
test("markdown has all required sections; json has the required shape", () => {
  const report = buildReport("t", syntheticRuns());

  const md = renderMarkdown(report);
  for (const heading of [
    "# Stage 5 patch probe report over existing runs",
    "## Summary",
    "## Method",
    "## Probe definitions",
    "## Results by run",
    "## Results by instance",
    "## Which known defects were caught",
    "## Probe limitations",
    "## Recommended next step",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
  // The recommendation should point at the critic dry run (probes caught real risk here).
  assert.ok(md.includes("critic schema"));

  const parsed = JSON.parse(renderJson(report));
  for (const key of ["generatedAt", "summary", "runs", "instances", "probeDefinitions", "nonClaims"]) {
    assert.ok(key in parsed, `missing top-level key: ${key}`);
  }
  for (const key of [
    "runsAnalyzed",
    "runsWithHighRisk",
    "runsWithKnownDefectLikelyCaught",
    "runsWithUnknownScope",
    "runsWithNoTestEvidence",
  ]) {
    assert.ok(key in parsed.summary, `missing summary key: ${key}`);
  }
  assert.equal(parsed.runs.length, 3);
  assert.ok("probeId" in parsed.runs[0].probes[0]);
  assert.equal(parsed.probeDefinitions.length, PROBE_DEFINITIONS.length);
});

// ---------------------------------------------------------------------------
// Summary / rollup math.
// ---------------------------------------------------------------------------
test("summary counts high-risk, caught, unknown-scope, and no-test-evidence runs", () => {
  const runs = syntheticRuns();
  const summary = buildSummary(runs);
  assert.equal(summary.runsAnalyzed, 3);
  // requests rewrite is high-risk; matplotlib-absent is medium.
  assert.ok(summary.runsWithHighRisk >= 1);
  // matplotlib (failing behavior absent) + requests (broad rewrite) are caught.
  assert.equal(summary.runsWithKnownDefectLikelyCaught, 2);
  // sympy run has unknown scope.
  assert.equal(summary.runsWithUnknownScope, 1);
  // requests ran only an ad-hoc check (warn) → counts as no named-test evidence; matplotlib ran pytest (pass).
  assert.ok(summary.runsWithNoTestEvidence >= 1);

  const rollups = buildInstanceRollups(runs);
  const req = rollups.find((r) => r.instanceId === "psf__requests-5414")!;
  assert.equal(req.knownDefectCaughtRuns, 1);
  const sympy = rollups.find((r) => r.instanceId === "sympy__sympy-16766")!;
  assert.equal(sympy.knownDefectUnknownRuns, 1);
});

test("recommendedNextStep points to a critic dry run only when probes caught risk", () => {
  const caught = recommendedNextStep({
    runsAnalyzed: 12,
    runsWithHighRisk: 3,
    runsWithKnownDefectLikelyCaught: 4,
    runsWithUnknownScope: 2,
    runsWithNoTestEvidence: 6,
  });
  assert.ok(caught.includes("critic schema"));

  const nothing = recommendedNextStep({
    runsAnalyzed: 12,
    runsWithHighRisk: 0,
    runsWithKnownDefectLikelyCaught: 0,
    runsWithUnknownScope: 12,
    runsWithNoTestEvidence: 0,
  });
  assert.ok(nothing.toLowerCase().includes("improve the probes"));
});

// ---------------------------------------------------------------------------
// 10. (covered above) Report runner does not require live raw artifacts — all
//     tests above build runs from synthetic in-memory diffs, never from disk.
// ---------------------------------------------------------------------------
test("parseArgs honors --results and --out-name with defaults", () => {
  assert.deepEqual(parseArgs([]), {
    resultsDir: "benchmarks/stage5_vexp_swe_bench_smoke/results",
    outName: "stage5_patch_probe_existing_runs",
  });
  assert.deepEqual(parseArgs(["--results", "r", "--out-name", "o"]), { resultsDir: "r", outName: "o" });
  assert.throws(() => parseArgs(["--bogus"]));
});
