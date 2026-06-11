import assert from "node:assert/strict";
import { test } from "bun:test";

import { type PatchProbeSummary, type PythonParser, summarizePatch } from "./stage5_patch_probes";
import { type PatchCriticInput, buildDeterministicPatchCriticReport } from "./stage5_patch_critic";
import { type CriticCaller, buildCriticPrompt } from "./stage5_patch_critic_live";
import { analyzePatchMinimality } from "../../src/capsule/patchMinimalityProbes";
import {
  type CriticCandidate,
  type GateConfig,
  DEFAULT_CRITIC_COST_CAP_USD,
  DEFAULT_MAX_CRITIC_RUNS,
  DEFAULT_ONLY_DETERMINISTIC_REPAIR_REQUIRED,
  buildLiveReport,
  discoverAdHocCandidates,
  parseArgs,
  renderJson,
  renderMarkdown,
  runGatedCritic,
} from "./run_stage5_patch_critic_live";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Fixtures — synthetic candidates (no filesystem, no agents, no Docker, no model).
// ---------------------------------------------------------------------------

const PARSE_OK: PythonParser = () => ({ ok: true });

// A requests broad rewrite → deterministic minimality fail → repair_required=true (high risk).
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

// A sympy diff-window-only additive patch → scope unknown → repair_required=false (low risk).
const SYMPY_LOW_RISK = [
  "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py",
  "--- a/sympy/printing/pycode.py",
  "+++ b/sympy/printing/pycode.py",
  "@@ -357,6 +357,9 @@ def _print_Not(self, expr):",
  "+    def _print_Indexed(self, expr):",
  "+        return base",
].join("\n");

function candidateFor(
  runLabel: string,
  patch: string,
  instanceId = "psf__requests-5414",
): CriticCandidate {
  const probeSummary: PatchProbeSummary = summarizePatch({
    instanceId,
    runLabel,
    patch,
    toolCalls: null,
    stdout: null,
    stderr: null,
    parsePython: PARSE_OK,
  });
  const input: PatchCriticInput = {
    instanceId,
    runLabel,
    repo: "psf/requests",
    issueText: null,
    firstPatch: patch,
    editedFiles: probeSummary.editedFiles,
    patchChars: probeSummary.patchChars,
    probeSummary,
    treatmentMetadata: { pivotCheckInjected: true, editGuardInjected: false, patchVerifyInjected: null },
    contextSignals: { hiddenPivotsInspected: null, hiddenPivotsEdited: null, orderedToolLogPresent: true },
  };
  return {
    runLabel,
    instanceId,
    source: "curated_existing",
    input,
    deterministicReport: buildDeterministicPatchCriticReport(input),
  };
}

function highRisk(runLabel: string): CriticCandidate {
  const c = candidateFor(runLabel, REQ_BROAD_REWRITE);
  assert.equal(c.deterministicReport.repair_required, true, `${runLabel} should be high-risk`);
  return c;
}

function lowRisk(runLabel: string): CriticCandidate {
  const c = candidateFor(runLabel, SYMPY_LOW_RISK, "sympy__sympy-16766");
  assert.equal(c.deterministicReport.repair_required, false, `${runLabel} should be low-risk`);
  return c;
}

// A valid critic JSON response that agrees with the deterministic verdict.
function validReportJson(repairRequired: boolean): string {
  return JSON.stringify({
    scope_ok: null,
    scope_evidence: "No inserted method pattern for this instance.",
    failing_behavior_handled: true,
    failing_behavior_evidence: "Patch references the relevant handling.",
    minimality_ok: !repairRequired,
    minimality_evidence: repairRequired ? "Broad rewrite: many deletions." : "Small additive patch.",
    test_evidence_ok: false,
    test_evidence: "No named test command observed.",
    risk: repairRequired ? "high" : "low",
    repair_required: repairRequired,
    repair_reason: repairRequired ? "Broad control-flow rewrite." : "",
    repair_instructions: repairRequired ? "Prefer a minimal additive validation." : "",
    confidence: repairRequired ? "high" : "medium",
    evidence_probe_ids: ["minimality_rewrite_risk"],
  });
}

// A counting mock caller; NEVER touches a live model. costUsd is configurable for cost-cap tests.
function mockCaller(opts: { response?: string; costUsd?: number; throws?: boolean } = {}): {
  caller: CriticCaller;
  readonly calls: number;
} {
  let calls = 0;
  const caller: CriticCaller = async () => {
    calls += 1;
    if (opts.throws) throw new Error("simulated invocation failure");
    return {
      raw: opts.response ?? validReportJson(true),
      model: "mock-critic",
      costUsd: opts.costUsd ?? 0.01,
      inputTokens: 1000,
      outputTokens: 50,
    };
  };
  return {
    caller,
    get calls() {
      return calls;
    },
  };
}

function gateOf(overrides: Partial<GateConfig> = {}): GateConfig {
  return {
    runLabels: [],
    maxCriticRuns: 1,
    onlyDeterministicRepairRequired: true,
    criticCostCapUsd: 0.25,
    dryRun: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseArgs: conservative defaults + the new safety-gate flags.
// ---------------------------------------------------------------------------
test("parseArgs defaults are conservative and disabled-by-default", () => {
  const cfg = parseArgs([]);
  assert.equal(cfg.enablePatchCritic, false); // 7. disabled mode is the default
  assert.equal(cfg.maxCriticRuns, DEFAULT_MAX_CRITIC_RUNS);
  assert.equal(cfg.maxCriticRuns, 1);
  assert.equal(cfg.onlyDeterministicRepairRequired, DEFAULT_ONLY_DETERMINISTIC_REPAIR_REQUIRED);
  assert.equal(cfg.onlyDeterministicRepairRequired, true);
  assert.equal(cfg.criticCostCapUsd, DEFAULT_CRITIC_COST_CAP_USD);
  assert.equal(cfg.criticCostCapUsd, 0.25);
  assert.deepEqual(cfg.runLabels, []);
  assert.equal(cfg.dryRun, false);
  assert.equal(cfg.includeAdHocRunLabels, false); // ad hoc materialization is opt-in
});

test("parseArgs --include-ad-hoc-run-labels opts into ad hoc materialization", () => {
  assert.equal(parseArgs(["--include-ad-hoc-run-labels"]).includeAdHocRunLabels, true);
});

test("parseArgs supports the smoke-target flags (repeatable run-label, caps, dry-run)", () => {
  const cfg = parseArgs([
    "--results",
    "some/dir",
    "--enable-patch-critic",
    "--run-label",
    "eval-patchverify-before-sympy-16766",
    "--run-label",
    "eval-editguard-after-requests-5414",
    "--max-critic-runs",
    "2",
    "--only-deterministic-repair-required",
    "--critic-cost-cap-usd",
    "0.10",
    "--dry-run",
    "--out-name",
    "custom",
  ]);
  assert.equal(cfg.resultsDir, "some/dir");
  assert.equal(cfg.enablePatchCritic, true);
  assert.deepEqual(cfg.runLabels, ["eval-patchverify-before-sympy-16766", "eval-editguard-after-requests-5414"]);
  assert.equal(cfg.maxCriticRuns, 2);
  assert.equal(cfg.onlyDeterministicRepairRequired, true);
  assert.equal(cfg.criticCostCapUsd, 0.1);
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.outName, "custom");
});

test("parseArgs --include-low-risk flips off the repair-required gate; bad numeric flags throw", () => {
  assert.equal(parseArgs(["--include-low-risk"]).onlyDeterministicRepairRequired, false);
  assert.throws(() => parseArgs(["--max-critic-runs", "-1"]), /non-negative integer/);
  assert.throws(() => parseArgs(["--max-critic-runs", "1.5"]), /non-negative integer/);
  assert.throws(() => parseArgs(["--critic-cost-cap-usd", "-0.5"]), /non-negative number/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});

// ---------------------------------------------------------------------------
// 1. Default max critic runs prevents accidental all-run live invocation.
// ---------------------------------------------------------------------------
test("default --max-critic-runs=1 calls the critic on at most one run", async () => {
  const candidates = [highRisk("run-a"), highRisk("run-b"), highRisk("run-c")];
  const m = mockCaller();
  const { decisions, counters } = await runGatedCritic({
    candidates,
    gate: gateOf({ maxCriticRuns: 1 }),
    caller: m.caller,
    criticModel: null,
  });
  assert.equal(m.calls, 1); // exactly one live call despite three eligible runs
  assert.equal(counters.candidateRuns, 3);
  assert.equal(counters.eligibleRuns, 3);
  assert.equal(counters.liveCallsAttempted, 1);
  assert.equal(counters.skippedByMaxRuns, 2);
  assert.equal(decisions.filter((d) => d.called).length, 1);
  assert.equal(decisions.filter((d) => d.skipReason === "max-critic-runs").length, 2);
});

// ---------------------------------------------------------------------------
// 2. --run-label restricts to the requested run.
// ---------------------------------------------------------------------------
test("--run-label restricts the live critic to the requested run(s)", async () => {
  const candidates = [highRisk("run-a"), highRisk("run-b"), highRisk("run-c")];
  const m = mockCaller();
  const { decisions, counters } = await runGatedCritic({
    candidates,
    gate: gateOf({ runLabels: ["run-b"], maxCriticRuns: 5 }),
    caller: m.caller,
    criticModel: null,
  });
  assert.equal(m.calls, 1);
  assert.equal(counters.skippedByRunLabel, 2);
  assert.equal(counters.eligibleRuns, 1);
  const called = decisions.filter((d) => d.called);
  assert.equal(called.length, 1);
  assert.equal(called[0]!.runLabel, "run-b");
  // The other runs are skipped with the run-label reason recorded.
  for (const d of decisions.filter((d) => !d.called)) {
    assert.equal(d.skipReason, "not-in-run-label");
  }
});

// ---------------------------------------------------------------------------
// 3. --only-deterministic-repair-required skips low-risk runs (default ON).
// ---------------------------------------------------------------------------
test("--only-deterministic-repair-required skips deterministic low-risk runs", async () => {
  const candidates = [lowRisk("low-1"), highRisk("high-1"), lowRisk("low-2")];
  const m = mockCaller();
  const { decisions, counters } = await runGatedCritic({
    candidates,
    gate: gateOf({ onlyDeterministicRepairRequired: true, maxCriticRuns: 5 }),
    caller: m.caller,
    criticModel: null,
  });
  assert.equal(m.calls, 1); // only the high-risk run is called
  assert.equal(counters.skippedLowRiskRuns, 2);
  assert.equal(counters.eligibleRuns, 1);
  const skippedLow = decisions.filter((d) => d.skipReason === "low-risk-deterministic");
  assert.equal(skippedLow.length, 2);
  for (const d of skippedLow) assert.ok(/low risk/i.test(d.reason)); // skip reason recorded
});

test("--include-low-risk (onlyDeterministicRepairRequired=false) processes low-risk runs too", async () => {
  const candidates = [lowRisk("low-1"), highRisk("high-1")];
  const m = mockCaller();
  const { counters } = await runGatedCritic({
    candidates,
    gate: gateOf({ onlyDeterministicRepairRequired: false, maxCriticRuns: 5 }),
    caller: m.caller,
    criticModel: null,
  });
  assert.equal(counters.skippedLowRiskRuns, 0);
  assert.equal(counters.eligibleRuns, 2);
  assert.equal(counters.liveCallsAttempted, 2);
});

// ---------------------------------------------------------------------------
// 4. --dry-run performs no live calls.
// ---------------------------------------------------------------------------
test("--dry-run invokes no caller and records would-call decisions", async () => {
  const candidates = [highRisk("run-a"), highRisk("run-b")];
  const m = mockCaller();
  const { decisions, counters } = await runGatedCritic({
    candidates,
    gate: gateOf({ dryRun: true, maxCriticRuns: 5 }),
    caller: m.caller,
    criticModel: null,
  });
  assert.equal(m.calls, 0); // the model is NEVER reached in dry-run
  assert.equal(counters.liveCallsAttempted, 0);
  assert.equal(counters.totalCriticCostUsd, 0);
  const wouldCall = decisions.filter((d) => d.wouldCall);
  assert.equal(wouldCall.length, 2);
  for (const d of wouldCall) {
    assert.equal(d.called, false);
    assert.equal(d.result, null); // no live critic artifacts produced
  }
});

// ---------------------------------------------------------------------------
// 5. Cost cap stops additional calls.
// ---------------------------------------------------------------------------
test("--critic-cost-cap-usd stops further calls once accumulated spend reaches the cap", async () => {
  const candidates = [highRisk("run-a"), highRisk("run-b"), highRisk("run-c")];
  // Each call costs 0.30; cap 0.25 → after the first call accumulated spend exceeds the cap.
  const m = mockCaller({ costUsd: 0.3 });
  const { decisions, counters } = await runGatedCritic({
    candidates,
    gate: gateOf({ criticCostCapUsd: 0.25, maxCriticRuns: 5 }),
    caller: m.caller,
    criticModel: null,
  });
  assert.equal(m.calls, 1); // one call made, then stopped
  assert.equal(counters.liveCallsAttempted, 1);
  assert.equal(counters.stoppedByCostCap, 2);
  assert.ok(Math.abs(counters.totalCriticCostUsd - 0.3) < 1e-9);
  const stopped = decisions.filter((d) => d.skipReason === "cost-cap");
  assert.equal(stopped.length, 2);
  for (const d of stopped) assert.ok(/cost-cap-usd/.test(d.reason)); // 6. stop reason recorded
});

// ---------------------------------------------------------------------------
// 6. Candidate / skip reasons are reported, and the report carries the gate counters.
// ---------------------------------------------------------------------------
test("buildLiveReport surfaces gate config, counters, and per-run decisions", async () => {
  const candidates = [highRisk("run-a"), highRisk("run-b"), lowRisk("low-1")];
  const gate = gateOf({ maxCriticRuns: 1 });
  const m = mockCaller();
  const outcome = await runGatedCritic({ candidates, gate, caller: m.caller, criticModel: null });
  const report = buildLiveReport({ generatedAt: "2026-01-01T00:00:00.000Z", enabled: true, gate, outcome });

  // Required report fields are all present.
  const parsed = JSON.parse(renderJson(report));
  for (const field of [
    "candidateRuns",
    "eligibleRuns",
    "skippedLowRiskRuns",
    "skippedByRunLabel",
    "skippedByMaxRuns",
    "stoppedByCostCap",
    "liveCallsAttempted",
    "liveCallsSucceeded",
    "liveCallsFailedOpen",
    "totalCriticCostUsd",
  ]) {
    assert.ok(field in parsed.counters, `missing counter ${field}`);
  }
  assert.equal(parsed.counters.candidateRuns, 3);
  assert.equal(parsed.counters.eligibleRuns, 2); // two high-risk
  assert.equal(parsed.counters.skippedLowRiskRuns, 1);
  assert.equal(parsed.counters.skippedByMaxRuns, 1);
  assert.equal(parsed.counters.liveCallsSucceeded, 1);
  assert.equal(parsed.gates.maxCriticRuns, 1);
  assert.equal(parsed.gates.onlyDeterministicRepairRequired, true);

  // Every candidate has a decision row with a human-readable reason.
  assert.equal(report.runs.length, 3);
  for (const r of report.runs) assert.ok(r.reason.length > 0);

  // Markdown renders the gates + decisions sections without throwing.
  const md = renderMarkdown(report);
  assert.ok(md.includes("## Gates"));
  assert.ok(md.includes("## Decisions by run"));
  assert.ok(md.includes("candidateRuns"));
});

// ---------------------------------------------------------------------------
// 8. Existing fail-open behavior remains unchanged through the gate.
// ---------------------------------------------------------------------------
test("a thrown invocation fails open through the gate without aborting the run set", async () => {
  const candidates = [highRisk("run-a")];
  const m = mockCaller({ throws: true });
  const { decisions, counters } = await runGatedCritic({
    candidates,
    gate: gateOf({ maxCriticRuns: 5 }),
    caller: m.caller,
    criticModel: null,
  });
  assert.equal(m.calls, 1);
  assert.equal(counters.liveCallsAttempted, 1);
  assert.equal(counters.liveCallsFailedOpen, 1);
  assert.equal(counters.liveCallsSucceeded, 0);
  const d = decisions[0]!;
  assert.equal(d.called, true);
  assert.equal(d.result!.meta.failedOpen, true);
  assert.equal(d.result!.report, null); // patch/input preserved; no valid report
});

test("invalid critic JSON fails open and is reported, but the run is still 'called'", async () => {
  const candidates = [highRisk("run-a")];
  const m = mockCaller({ response: "the model refused to emit JSON" });
  const { counters } = await runGatedCritic({
    candidates,
    gate: gateOf({ maxCriticRuns: 5 }),
    caller: m.caller,
    criticModel: null,
  });
  assert.equal(counters.liveCallsFailedOpen, 1);
  assert.equal(counters.liveCallsSucceeded, 0);
});

// ---------------------------------------------------------------------------
// Ad hoc run-label materialization (filesystem fixtures only; no agents/Docker/model).
// ---------------------------------------------------------------------------

// Build a raw VTRACE run dir on disk. `dir: false` → no run dir at all; `jsonl: false` → dir but no
// swebench row; `patch: null` → row with empty modelPatch.
async function makeRun(
  resultsDir: string,
  runLabel: string,
  opts: { instanceId?: string; patch?: string | null; jsonl?: boolean; dir?: boolean } = {},
): Promise<void> {
  if (opts.dir === false) return;
  const dir = path.join(resultsDir, "runs", runLabel, "raw", "vtrace");
  await mkdir(dir, { recursive: true });
  if (opts.jsonl === false) return;
  const row: Record<string, unknown> = {
    instanceId: opts.instanceId ?? "psf__requests-5414",
    repo: "psf/requests",
    resolved: false,
    modelPatch: opts.patch === null ? "" : opts.patch ?? REQ_BROAD_REWRITE,
  };
  await writeFile(path.join(dir, "swebench-2026-01-01.jsonl"), `${JSON.stringify(row)}\n`);
}

async function withTempResults(fn: (results: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "stage5-adhoc-"));
  try {
    await fn(path.join(root, "results"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 2 & 3. An existing raw run with a modelPatch is materialized and tagged source=ad_hoc_run_label.
test("discoverAdHocCandidates materializes an existing raw run and tags it ad_hoc_run_label", async () => {
  await withTempResults(async (results) => {
    await makeRun(results, "eval-strictgated-vtrace-requests-5414", { patch: REQ_BROAD_REWRITE });
    const d = await discoverAdHocCandidates({
      resultsDir: results,
      requestedLabels: ["eval-strictgated-vtrace-requests-5414"],
      knownLabels: new Set(),
      parsePython: PARSE_OK,
    });
    assert.equal(d.candidates.length, 1);
    const c = d.candidates[0]!;
    assert.equal(c.source, "ad_hoc_run_label");
    assert.equal(c.instanceId, "psf__requests-5414");
    assert.equal(c.deterministicReport.repair_required, true);
    assert.deepEqual(d.counters, {
      adHocRequested: 1,
      adHocFound: 1,
      adHocMaterialized: 1,
      adHocMissing: 0,
    });
    assert.equal(d.skips.length, 0);
  });
});

// 4. Missing ad hoc run dir is reported clearly.
test("discoverAdHocCandidates reports a missing run dir", async () => {
  await withTempResults(async (results) => {
    const d = await discoverAdHocCandidates({
      resultsDir: results,
      requestedLabels: ["eval-does-not-exist"],
      knownLabels: new Set(),
      parsePython: PARSE_OK,
    });
    assert.equal(d.candidates.length, 0);
    assert.equal(d.skips.length, 1);
    assert.equal(d.skips[0]!.skipReason, "ad-hoc-missing-run-dir");
    assert.equal(d.counters.adHocMissing, 1);
    assert.equal(d.counters.adHocMaterialized, 0);
  });
});

// 5. Missing JSONL row is reported clearly.
test("discoverAdHocCandidates reports a run dir with no JSONL row", async () => {
  await withTempResults(async (results) => {
    await makeRun(results, "eval-no-jsonl", { jsonl: false });
    const d = await discoverAdHocCandidates({
      resultsDir: results,
      requestedLabels: ["eval-no-jsonl"],
      knownLabels: new Set(),
      parsePython: PARSE_OK,
    });
    assert.equal(d.skips[0]!.skipReason, "ad-hoc-missing-jsonl");
    assert.equal(d.counters.adHocMissing, 1);
  });
});

// 6. JSONL with empty modelPatch is not materialized.
test("discoverAdHocCandidates does not materialize a run with an empty modelPatch", async () => {
  await withTempResults(async (results) => {
    await makeRun(results, "eval-empty-patch", { patch: null });
    const d = await discoverAdHocCandidates({
      resultsDir: results,
      requestedLabels: ["eval-empty-patch"],
      knownLabels: new Set(),
      parsePython: PARSE_OK,
    });
    assert.equal(d.candidates.length, 0);
    assert.equal(d.skips[0]!.skipReason, "ad-hoc-no-model-patch");
    assert.equal(d.counters.adHocFound, 1); // dir+jsonl present...
    assert.equal(d.counters.adHocMaterialized, 0); // ...but no candidate built
  });
});

// 9. A label already in the curated set is not re-processed as ad hoc.
test("discoverAdHocCandidates skips labels already in the curated known set", async () => {
  await withTempResults(async (results) => {
    await makeRun(results, "eval-editguard-before-requests-5414", { patch: REQ_BROAD_REWRITE });
    const d = await discoverAdHocCandidates({
      resultsDir: results,
      requestedLabels: ["eval-editguard-before-requests-5414"],
      knownLabels: new Set(["eval-editguard-before-requests-5414"]),
      parsePython: PARSE_OK,
    });
    assert.equal(d.candidates.length, 0);
    assert.equal(d.counters.adHocRequested, 0);
  });
});

// 7. The live critic candidate table includes the ad hoc candidate, tagged ad_hoc_run_label.
test("buildLiveReport includes a materialized ad hoc candidate in the run table with its source", async () => {
  await withTempResults(async (results) => {
    await makeRun(results, "eval-strictgated-vtrace-requests-5414", { patch: REQ_BROAD_REWRITE });
    const d = await discoverAdHocCandidates({
      resultsDir: results,
      requestedLabels: ["eval-strictgated-vtrace-requests-5414"],
      knownLabels: new Set(),
      parsePython: PARSE_OK,
    });
    const gate = gateOf({ runLabels: ["eval-strictgated-vtrace-requests-5414"], maxCriticRuns: 1 });
    const m = mockCaller();
    const outcome = await runGatedCritic({ candidates: d.candidates, gate, caller: m.caller, criticModel: null });
    const report = buildLiveReport({
      generatedAt: "2026-01-01T00:00:00.000Z",
      enabled: true,
      gate,
      outcome,
      adHocSkips: d.skips,
      adHoc: d.counters,
    });
    const row = report.runs.find((r) => r.runLabel === "eval-strictgated-vtrace-requests-5414")!;
    assert.equal(row.source, "ad_hoc_run_label");
    assert.equal(row.called, true);
    assert.equal(report.adHoc.adHocMaterialized, 1);
    // The report renders the source column and ad hoc counters.
    const md = renderMarkdown(report);
    assert.ok(md.includes("ad_hoc_run_label"));
    assert.ok(md.includes("adHocMaterialized"));
    // JSON is self-describing about the ad hoc audit trail.
    const parsed = JSON.parse(renderJson(report));
    assert.equal(parsed.adHoc.adHocRequested, 1);
  });
});

// ===========================================================================
// Generated-parser patch-minimality wiring into critic candidate selection.
// All fixtures are synthetic diffs; the mock caller NEVER reaches a live model.
// ===========================================================================

// Deletes both PLY generated tables + relocates productions out of p_product_of_units /
// p_division_of_units into p_combined_units. Mirrors the auditable Astropy protocol patch.
const ASTROPY_GENERATED_PARSER = [
  "diff --git a/astropy/units/format/cds.py b/astropy/units/format/cds.py",
  "--- a/astropy/units/format/cds.py",
  "+++ b/astropy/units/format/cds.py",
  "@@ -164,18 +164,10 @@ class CDS(Base):",
  "         def p_combined_units(p):",
  "             \"\"\"",
  "-            combined_units : product_of_units",
  "-                           | division_of_units",
  "-            \"\"\"",
  "-        def p_product_of_units(p):",
  "-            \"\"\"",
  "-            product_of_units : unit_expression PRODUCT combined_units",
  "-        def p_division_of_units(p):",
  "-            \"\"\"",
  "-            division_of_units : DIVISION unit_expression",
  "+            combined_units : combined_units DIVISION unit_expression",
  "+                           | unit_expression",
  "             \"\"\"",
  "diff --git a/astropy/units/format/cds_lextab.py b/astropy/units/format/cds_lextab.py",
  "deleted file mode 100644",
  "--- a/astropy/units/format/cds_lextab.py",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-# generated",
  "diff --git a/astropy/units/format/cds_parsetab.py b/astropy/units/format/cds_parsetab.py",
  "deleted file mode 100644",
  "--- a/astropy/units/format/cds_parsetab.py",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-# generated",
].join("\n");

// Deletes ONLY a generated parsetab (no source grammar edit). The generic minimality probe stays
// silent on this; only the generated-parser probe fires — proving the wiring's independence.
const TABLE_DELETION_ONLY = [
  "diff --git a/astropy/units/format/cds_parsetab.py b/astropy/units/format/cds_parsetab.py",
  "deleted file mode 100644",
  "--- a/astropy/units/format/cds_parsetab.py",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-# cds_parsetab.py generated by PLY",
  "-_lr_method = 'LALR'",
].join("\n");

// A narrow one-line grammar production reorder — the known-good shape. Must NOT become eligible.
const NARROW_REORDER = [
  "diff --git a/astropy/units/format/cds.py b/astropy/units/format/cds.py",
  "--- a/astropy/units/format/cds.py",
  "+++ b/astropy/units/format/cds.py",
  "@@ -190,3 +190,3 @@ class CDS(Base):",
  "         def p_division_of_units(p):",
  "             \"\"\"",
  "-            division_of_units : unit_expression DIVISION combined_units",
  "+            division_of_units : combined_units DIVISION unit_expression",
  "             \"\"\"",
].join("\n");

// Build a candidate whose input carries the deterministic patch-minimality observation, exactly as
// the runner's buildCriticInput does. No filesystem, no model.
function parserCandidate(
  runLabel: string,
  patch: string,
  instanceId = "astropy__astropy-14369",
): CriticCandidate {
  const probeSummary: PatchProbeSummary = summarizePatch({
    instanceId,
    runLabel,
    patch,
    toolCalls: null,
    stdout: null,
    stderr: null,
    parsePython: PARSE_OK,
  });
  const input: PatchCriticInput = {
    instanceId,
    runLabel,
    repo: "astropy/astropy",
    issueText: null,
    firstPatch: patch,
    editedFiles: probeSummary.editedFiles,
    patchChars: probeSummary.patchChars,
    probeSummary,
    treatmentMetadata: { pivotCheckInjected: null, editGuardInjected: null, patchVerifyInjected: null },
    contextSignals: { hiddenPivotsInspected: null, hiddenPivotsEdited: null, orderedToolLogPresent: null },
    patchMinimality: analyzePatchMinimality(patch),
  };
  return {
    runLabel,
    instanceId,
    source: "curated_existing",
    input,
    deterministicReport: buildDeterministicPatchCriticReport(input),
  };
}

// 1. Candidate construction includes the patchMinimalityProbe output on the input.
test("candidate input carries the deterministic patchMinimality observation", () => {
  const c = parserCandidate("astropy-broad", ASTROPY_GENERATED_PARSER);
  const pm = c.input.patchMinimality!;
  assert.ok(pm);
  assert.equal(pm.repairRequired, true);
  assert.equal(pm.defectClass, "generated_parser_broad_rewrite");
  assert.ok(pm.generatedFilesDeleted.length >= 2);
  assert.ok(pm.grammarFunctionsRemoved.includes("p_division_of_units"));
  assert.ok(typeof pm.narrowAlternativeHint === "string");
});

// 2. The Astropy-style generated-parser patch makes the deterministic critic repair_required=true,
//    and the patch-minimality probe drives it INDEPENDENTLY of the generic minimality probe.
test("generated-parser patch becomes deterministicRepairRequired=true via the patch-minimality probe", () => {
  const c = parserCandidate("astropy-broad", ASTROPY_GENERATED_PARSER);
  assert.equal(c.deterministicReport.repair_required, true);
  assert.equal(c.deterministicReport.risk, "high");
  // The repair reason/instructions surface the generated-parser observation + narrow alternative.
  assert.ok(/generated-parser minimality risk/i.test(c.deterministicReport.repair_reason));
  assert.ok(/grammar production/i.test(c.deterministicReport.repair_instructions));

  // Independence: a table-deletion-only patch is NOT repair_required without the probe, but IS with it.
  const ps = summarizePatch({
    instanceId: "astropy__astropy-14369",
    runLabel: "table-only",
    patch: TABLE_DELETION_ONLY,
    toolCalls: null,
    stdout: null,
    stderr: null,
    parsePython: PARSE_OK,
  });
  const baseInput: PatchCriticInput = {
    instanceId: "astropy__astropy-14369",
    runLabel: "table-only",
    repo: "astropy/astropy",
    issueText: null,
    firstPatch: TABLE_DELETION_ONLY,
    editedFiles: ps.editedFiles,
    patchChars: ps.patchChars,
    probeSummary: ps,
    treatmentMetadata: { pivotCheckInjected: null, editGuardInjected: null, patchVerifyInjected: null },
    contextSignals: { hiddenPivotsInspected: null, hiddenPivotsEdited: null, orderedToolLogPresent: null },
  };
  assert.equal(buildDeterministicPatchCriticReport(baseInput).repair_required, false);
  assert.equal(
    buildDeterministicPatchCriticReport({ ...baseInput, patchMinimality: analyzePatchMinimality(TABLE_DELETION_ONLY) })
      .repair_required,
    true,
  );
});

// 3. The generated-parser patch becomes eligible for live critic observation (would-call in dry-run).
test("generated-parser patch is eligible for live critic observation", async () => {
  const m = mockCaller();
  const { decisions, counters } = await runGatedCritic({
    candidates: [parserCandidate("astropy-broad", ASTROPY_GENERATED_PARSER)],
    gate: gateOf({ dryRun: true, runLabels: ["astropy-broad"], maxCriticRuns: 1 }),
    caller: m.caller,
    criticModel: null,
  });
  assert.equal(m.calls, 0); // 11. dry-run reaches no model/agent/Docker
  assert.equal(counters.eligibleRuns, 1);
  const d = decisions[0]!;
  assert.equal(d.wouldCall, true);
  assert.equal(d.patchMinimality?.repairRequired, true);
  // The eligibility basis is auditable in the decision reason.
  assert.ok(/generated-parser-minimality/.test(d.reason));
});

// 4 & 5. The live critic prompt includes generated-parser deletion reasons AND the narrow hint.
test("live critic prompt surfaces generated-parser deletions and the narrowAlternativeHint", () => {
  const c = parserCandidate("astropy-broad", ASTROPY_GENERATED_PARSER);
  const prompt = buildCriticPrompt(c.input);
  // 4. deletion reasons
  assert.ok(prompt.includes("generated parser files deleted"));
  assert.ok(prompt.includes("cds_parsetab.py"));
  assert.ok(prompt.includes("parser grammar functions removed"));
  // 5. narrow alternative hint + the concrete Astropy-style emphasis (derived, not hardcoded)
  assert.ok(prompt.includes("narrow alternative hint"));
  assert.ok(prompt.includes(c.input.patchMinimality!.narrowAlternativeHint!));
  assert.ok(/change the division_of_units production order/.test(prompt));
  assert.ok(/relocating productions into p_combined_units/.test(prompt));
});

// 6. Ordinary non-parser patches are unaffected: probe silent, verdict unchanged, not eligible.
test("ordinary non-parser patch is unaffected by the patch-minimality wiring", async () => {
  const c = parserCandidate("sympy-additive", SYMPY_LOW_RISK, "sympy__sympy-16766");
  assert.equal(c.input.patchMinimality!.defectClass, "none");
  assert.equal(c.input.patchMinimality!.repairRequired, false);
  assert.equal(c.deterministicReport.repair_required, false);
  // The generated-parser section is omitted from the prompt.
  assert.ok(!buildCriticPrompt(c.input).includes("Generated-parser / grammar-minimality observation"));
  const m = mockCaller();
  const { counters } = await runGatedCritic({
    candidates: [c],
    gate: gateOf({ dryRun: true, runLabels: ["sympy-additive"], maxCriticRuns: 1 }),
    caller: m.caller,
    criticModel: null,
  });
  assert.equal(counters.eligibleRuns, 0); // low-risk → not eligible
});

// 7. A narrow one-line grammar reorder stays low-risk and does not become eligible.
test("narrow one-line grammar reorder stays low risk and is not eligible", async () => {
  const c = parserCandidate("astropy-narrow", NARROW_REORDER);
  assert.notEqual(c.input.patchMinimality!.risk, "high");
  assert.equal(c.input.patchMinimality!.repairRequired, false);
  assert.equal(c.deterministicReport.repair_required, false);
  const m = mockCaller();
  const { counters } = await runGatedCritic({
    candidates: [c],
    gate: gateOf({ dryRun: true, runLabels: ["astropy-narrow"], maxCriticRuns: 1 }),
    caller: m.caller,
    criticModel: null,
  });
  assert.equal(m.calls, 0);
  assert.equal(counters.eligibleRuns, 0);
});

// 9 & 10. The live critic report exposes the patchMinimality fields in JSON and Markdown.
test("live report exposes patchMinimality fields in JSON and Markdown", async () => {
  const gate = gateOf({ dryRun: true, runLabels: ["astropy-broad"], maxCriticRuns: 1 });
  const m = mockCaller();
  const outcome = await runGatedCritic({
    candidates: [parserCandidate("astropy-broad", ASTROPY_GENERATED_PARSER)],
    gate,
    caller: m.caller,
    criticModel: null,
  });
  const report = buildLiveReport({ generatedAt: "2026-01-01T00:00:00.000Z", enabled: true, gate, outcome });

  // 9. JSON row fields.
  const parsed = JSON.parse(renderJson(report));
  const row = parsed.runs.find((r: { runLabel: string }) => r.runLabel === "astropy-broad");
  for (const field of [
    "patchMinimalityRepairRequired",
    "patchMinimalityDefectClass",
    "patchMinimalityRisk",
    "patchMinimalityConfidence",
    "patchMinimalitySignals",
    "patchMinimalityReasons",
    "patchMinimalityNarrowAlternativeHint",
  ]) {
    assert.ok(field in row, `missing JSON field ${field}`);
  }
  assert.equal(row.patchMinimalityRepairRequired, true);
  assert.equal(row.patchMinimalityDefectClass, "generated_parser_broad_rewrite / grammar_patch_minimality");

  // 10. Markdown section + field labels + reasons.
  const md = renderMarkdown(report);
  assert.ok(md.includes("## Patch minimality (generated-parser) signal"));
  assert.ok(md.includes("patchMinimalityRepairRequired"));
  assert.ok(md.includes("patchMinimalityDefectClass"));
  assert.ok(md.includes("patchMinimalityNarrowAlternativeHint"));
  assert.ok(md.includes("generated_parser_broad_rewrite / grammar_patch_minimality"));
});

// Non-materialized ad hoc labels appear as skip rows even when no candidate was built.
test("buildLiveReport surfaces ad hoc skip rows for non-materialized labels", async () => {
  await withTempResults(async (results) => {
    const d = await discoverAdHocCandidates({
      resultsDir: results,
      requestedLabels: ["eval-missing"],
      knownLabels: new Set(),
      parsePython: PARSE_OK,
    });
    const gate = gateOf({ runLabels: ["eval-missing"], maxCriticRuns: 1 });
    const m = mockCaller();
    const outcome = await runGatedCritic({ candidates: d.candidates, gate, caller: m.caller, criticModel: null });
    assert.equal(m.calls, 0); // nothing materialized → nothing called
    const report = buildLiveReport({
      generatedAt: null,
      enabled: true,
      gate,
      outcome,
      adHocSkips: d.skips,
      adHoc: d.counters,
    });
    const row = report.runs.find((r) => r.runLabel === "eval-missing")!;
    assert.equal(row.source, "ad_hoc_run_label");
    assert.equal(row.skipReason, "ad-hoc-missing-run-dir");
  });
});
