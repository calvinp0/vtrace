import assert from "node:assert/strict";
import { test } from "bun:test";

import { type PatchProbeSummary, type PythonParser, reconstructFile, summarizePatch } from "./stage5_patch_probes";
import { buildDeterministicPatchCriticReport, validatePatchCriticReport } from "./stage5_patch_critic";
import {
  type CriticRunRecord,
  buildCriticDryRunReport,
  buildCriticInput,
  loadRunMetaSignals,
  parseArgs,
  recommendedNextStep,
  renderJson,
  renderMarkdown,
} from "./run_stage5_patch_critic_dry_run";

// ---------------------------------------------------------------------------
// Fixtures — synthetic diffs (no filesystem, no agents, no Docker).
// ---------------------------------------------------------------------------

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
].join("\n");

const MPL_BEHAVIOR_ABSENT = [
  "diff --git a/lib/matplotlib/category.py b/lib/matplotlib/category.py",
  "--- a/lib/matplotlib/category.py",
  "+++ b/lib/matplotlib/category.py",
  "@@ -57,7 +57,7 @@ class StrCategoryConverter(units.ConversionInterface):",
  "-                             for v in values)",
  "+                             for v in values) if len(values) else False",
].join("\n");

const SYMPY_SCOPE_UNKNOWN = [
  "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py",
  "--- a/sympy/printing/pycode.py",
  "+++ b/sympy/printing/pycode.py",
  "@@ -357,6 +357,9 @@ def _print_Not(self, expr):",
  "+    def _print_Indexed(self, expr):",
  "+        return base",
].join("\n");

const PARSE_OK: PythonParser = () => ({ ok: true });

const SIGNALS: RunMetaSignals = {
  repo: "example/repo",
  treatmentMetadata: { pivotCheckInjected: true, editGuardInjected: false, patchVerifyInjected: null },
  contextSignals: { hiddenPivotsInspected: null, hiddenPivotsEdited: null, orderedToolLogPresent: true },
};

function summaryOf(instanceId: string, runLabel: string, patch: string): PatchProbeSummary {
  return summarizePatch({ instanceId, runLabel, patch, toolCalls: null, stdout: null, stderr: null, parsePython: PARSE_OK });
}

function recordOf(instanceId: string, runLabel: string, patch: string): CriticRunRecord {
  const probeSummary = summaryOf(instanceId, runLabel, patch);
  const input = buildCriticInput(probeSummary, patch, SIGNALS);
  const report = buildDeterministicPatchCriticReport(input);
  return { report, probeSummary, treatmentMetadata: SIGNALS.treatmentMetadata };
}

// A representative set: one requests broad rewrite (repair, high), one matplotlib missing
// behavior (repair, medium), one sympy scope-unknown (no repair, insufficient signal).
function sampleRecords(): CriticRunRecord[] {
  return [
    recordOf("psf__requests-5414", "req-rewrite", REQ_BROAD_REWRITE),
    recordOf("matplotlib__matplotlib-22719", "mpl-absent", MPL_BEHAVIOR_ABSENT),
    recordOf("sympy__sympy-16766", "sympy-unknown", SYMPY_SCOPE_UNKNOWN),
  ];
}

// ---------------------------------------------------------------------------
// 7. Dry-run report emits Markdown and JSON with required sections/fields.
// ---------------------------------------------------------------------------
test("dry-run report emits Markdown with all required sections and JSON with required fields", () => {
  const records = sampleRecords();
  const report = buildCriticDryRunReport("2026-01-01T00:00:00.000Z", records);

  // Every report is contract-valid.
  for (const r of records) assert.deepEqual(validatePatchCriticReport(r.report), []);

  // --- JSON shape ---
  const parsed = JSON.parse(renderJson(report));
  for (const field of ["generatedAt", "summary", "reports", "instances", "nonClaims"]) {
    assert.ok(field in parsed, `missing JSON field ${field}`);
  }
  for (const field of [
    "runsAnalyzed",
    "repairRequiredCount",
    "highRiskCount",
    "mediumRiskCount",
    "lowRiskCount",
    "unknownRiskCount",
    "scopeUnknownCount",
    "missingTestEvidenceCount",
    "knownDefectLikelyCaughtCount",
  ]) {
    assert.ok(field in parsed.summary, `missing summary field ${field}`);
  }
  assert.equal(parsed.summary.runsAnalyzed, 3);
  assert.equal(parsed.summary.repairRequiredCount, 2); // requests + matplotlib
  assert.equal(parsed.summary.highRiskCount, 1); // requests broad rewrite
  assert.equal(parsed.summary.scopeUnknownCount, 1); // sympy
  assert.equal(parsed.reports.length, 3);
  assert.equal(parsed.instances.length, 3);

  // --- Markdown sections ---
  const md = renderMarkdown(report, records);
  for (const heading of [
    "# Stage 5 patch critic dry run over existing runs",
    "## Summary",
    "## Method",
    "## Critic input/output contract",
    "## Results by run",
    "## Results by instance",
    "## Repair-required analysis",
    "## Unknown / insufficient-signal cases",
    "## Probe limitations exposed",
    "## Recommended next step",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(heading), `markdown missing section: ${heading}`);
  }
  // The recommendation is one of the three milestone options.
  assert.ok(/(^|\n)A\.|(^|\n)B |(^|\n)B \(|(^|\n)C\./.test(md));
});

// ---------------------------------------------------------------------------
// 8. The dry-run path requires no live agents, Docker, or raw-artifact mutation.
// ---------------------------------------------------------------------------
test("report building is pure in-memory; metadata loading is read-only and fails soft", async () => {
  // buildCriticDryRunReport / render* operate purely on in-memory records (no fs touched).
  const report = buildCriticDryRunReport(null, sampleRecords());
  assert.equal(report.generatedAt, null);
  assert.ok(renderMarkdown(report, sampleRecords()).length > 0);

  // Loading metadata from a non-existent results dir must not throw or mutate anything; it
  // degrades to null signals and an empty repo (read-only behavior).
  const signals = await loadRunMetaSignals("/tmp/does-not-exist-vtrace-critic", "no-such-run");
  assert.equal(signals.repo, "");
  assert.equal(signals.treatmentMetadata.pivotCheckInjected, null);
  assert.equal(signals.contextSignals.orderedToolLogPresent, null);

  // parseArgs honors the documented flags with sane defaults.
  const cfg = parseArgs(["--results", "some/dir", "--out-name", "custom"]);
  assert.equal(cfg.resultsDir, "some/dir");
  assert.equal(cfg.outName, "custom");
});

// ---------------------------------------------------------------------------
// Extra: recommendation reflects the scope-blind case (B with an A prerequisite).
// ---------------------------------------------------------------------------
test("recommendedNextStep flags the scope-blind case when sympy scope is never caught", () => {
  const report = buildCriticDryRunReport("t", sampleRecords());
  const rec = recommendedNextStep(report.summary, report.instances);
  assert.ok(rec.startsWith("B"));
  assert.ok(rec.toLowerCase().includes("full-file reconstruction"));
});

// ---------------------------------------------------------------------------
// 9. Critic dry run consumes the improved (reconstruction-based) scope result.
// ---------------------------------------------------------------------------
test("critic consumes a reconstruction-derived scope FAIL as a high-confidence repair", () => {
  const original = [
    "class AbstractPythonCodePrinter(CodePrinter):",
    "",
    "    def _print_NoneToken(self, arg):",
    "        return 'None'",
    "",
    "",
    "class PythonCodePrinter(AbstractPythonCodePrinter):",
    "",
    "    def _print_sign(self, e):",
    "        return e",
    "",
  ].join("\n");
  // Diff-window-unknown patch that lands _print_Indexed in AbstractPythonCodePrinter.
  const patch = [
    "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py",
    "--- a/sympy/printing/pycode.py",
    "+++ b/sympy/printing/pycode.py",
    "@@ -3,6 +3,9 @@ def _print_NoneToken(self, arg):",
    "     def _print_NoneToken(self, arg):",
    "         return 'None'",
    " ",
    "+    def _print_Indexed(self, expr):",
    "+        return base",
    "+",
    " ",
    " class PythonCodePrinter(AbstractPythonCodePrinter):",
  ].join("\n");
  const reconstructed = reconstructFile(original, patch, "sympy/printing/pycode.py").content!;

  const probeSummary = summarizePatch({
    instanceId: "sympy__sympy-16766",
    runLabel: "eval-patchverify-before-sympy-16766",
    patch,
    toolCalls: null,
    stdout: null,
    stderr: null,
    parsePython: PARSE_OK,
    reconstructedSources: { "sympy/printing/pycode.py": reconstructed },
    reconstruction: {
      attempted: true,
      source: "workspace_plus_patch",
      filesReconstructed: ["sympy/printing/pycode.py"],
      filesFailed: [],
      errors: [],
    },
  });
  const report = buildDeterministicPatchCriticReport(buildCriticInput(probeSummary, patch, SIGNALS));
  assert.equal(report.scope_ok, false);
  assert.equal(report.risk, "high");
  assert.equal(report.repair_required, true);
  assert.equal(report.confidence, "high");
  assert.deepEqual(validatePatchCriticReport(report), []);
});
