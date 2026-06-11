import assert from "node:assert/strict";
import { test } from "bun:test";

import type { PatchCriticReport } from "./stage5_patch_critic";
import type { LiveCriticMeta } from "./stage5_patch_critic_live";
import { type RepairCaller, DEFAULT_ALLOWED_DEFECT_CLASSES, evaluateRepairEligibility } from "./stage5_patch_repair";
import { defectClassFor } from "./run_stage5_live_critic_high_risk_comparison";
import {
  type RepairCandidate,
  type RepairGateConfig,
  DEFAULT_MAX_REPAIR_RUNS,
  DEFAULT_REPAIR_COST_CAP_USD,
  buildRepairReport,
  loadRepairCandidates,
  parseArgs,
  renderJson,
  renderMarkdown,
  runGatedRepair,
} from "./run_stage5_patch_repair";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Fixtures — synthetic repair candidates (no filesystem, no agents, no model).
// ---------------------------------------------------------------------------

const FIRST_PATCH = [
  "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py",
  "--- a/sympy/printing/pycode.py",
  "+++ b/sympy/printing/pycode.py",
  "@@ -346,6 +346,8 @@ def _print_Stream(self, strm):",
  "+    def _print_Indexed(self, expr):",
  "+        return base",
].join("\n");

const REPAIRED_PATCH = [
  "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py",
  "--- a/sympy/printing/pycode.py",
  "+++ b/sympy/printing/pycode.py",
  "@@ -360,6 +360,8 @@ class PythonCodePrinter(AbstractPythonCodePrinter):",
  "+    def _print_Indexed(self, expr):",
  "+        return relocated",
].join("\n");

function reportFor(instanceId: string, opts: { repairRequired?: boolean } = {}): PatchCriticReport {
  const repairRequired = opts.repairRequired ?? true;
  return {
    instanceId,
    runLabel: `eval-${instanceId}`,
    scope_ok: false,
    scope_evidence: "method landed in the wrong class.",
    failing_behavior_handled: true,
    failing_behavior_evidence: "handled via inheritance.",
    minimality_ok: true,
    minimality_evidence: "additive.",
    test_evidence_ok: null,
    test_evidence: "ad-hoc smoke check only.",
    risk: "medium",
    repair_required: repairRequired,
    repair_reason: repairRequired ? "Wrong scope: method landed outside the intended class." : "",
    repair_instructions: repairRequired
      ? "Relocate the existing `_print_Indexed` method into the PythonCodePrinter class body, preserving the same implementation and indentation."
      : "",
    confidence: "medium",
    evidence_probe_ids: ["inserted_method_scope"],
  };
}

function metaFor(overrides: Partial<LiveCriticMeta> = {}): LiveCriticMeta {
  return {
    enabled: true,
    ran: true,
    validReport: true,
    failedOpen: false,
    error: null,
    criticModel: "mock-critic",
    criticCostUsd: 0.12,
    criticInputTokens: 4000,
    criticOutputTokens: 2000,
    deterministicRepairRequired: true,
    liveRepairRequired: true,
    agreementWithDeterministic: true,
    ...overrides,
  };
}

function candidateFor(args: {
  runLabel: string;
  instanceId?: string;
  meta?: LiveCriticMeta;
  report?: PatchCriticReport;
  firstPatch?: string | null;
  source?: "curated_existing" | "ad_hoc_run_label";
  allowed?: readonly ("wrong_scope" | "broad_rewrite_minimality" | "missing_failing_behavior" | "unknown")[];
}): RepairCandidate {
  const instanceId = args.instanceId ?? "sympy__sympy-16766";
  const meta = args.meta ?? metaFor();
  const report = args.report ?? reportFor(instanceId);
  const firstPatch = args.firstPatch === undefined ? FIRST_PATCH : args.firstPatch;
  const allowed = args.allowed ?? ["wrong_scope", "broad_rewrite_minimality"];
  const eligibility = evaluateRepairEligibility({
    runLabel: args.runLabel,
    meta,
    report,
    firstPatch,
    allowedDefectClasses: allowed,
  });
  return {
    runLabel: args.runLabel,
    instanceId,
    source: args.source ?? "curated_existing",
    meta,
    report,
    firstPatch,
    issueText: null,
    eligibility,
  };
}

function mockCaller(opts: { response?: string; costUsd?: number; throws?: boolean } = {}): {
  caller: RepairCaller;
  readonly calls: number;
} {
  let calls = 0;
  const caller: RepairCaller = async () => {
    calls += 1;
    if (opts.throws) throw new Error("simulated failure");
    return {
      raw: opts.response ?? REPAIRED_PATCH,
      model: "mock-repair",
      costUsd: opts.costUsd ?? 0.05,
      inputTokens: 2000,
      outputTokens: 200,
    };
  };
  return {
    caller,
    get calls() {
      return calls;
    },
  };
}

function gateOf(overrides: Partial<RepairGateConfig> = {}): RepairGateConfig {
  return {
    runLabels: ["run-a"],
    maxRepairRuns: 1,
    repairCostCapUsd: 0.25,
    allowedDefectClasses: ["wrong_scope", "broad_rewrite_minimality"],
    dryRun: false,
    evaluateRepairedPatch: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseArgs — disabled by default; conservative defaults; validation.
// ---------------------------------------------------------------------------
test("parseArgs defaults are conservative and disabled-by-default", () => {
  const cfg = parseArgs([]);
  assert.equal(cfg.enablePatchRepair, false);
  assert.equal(cfg.maxRepairRuns, DEFAULT_MAX_REPAIR_RUNS);
  assert.equal(cfg.maxRepairRuns, 1);
  assert.equal(cfg.repairCostCapUsd, DEFAULT_REPAIR_COST_CAP_USD);
  assert.equal(cfg.repairCostCapUsd, 0.25);
  assert.deepEqual(cfg.runLabels, []);
  assert.equal(cfg.dryRun, false);
  assert.equal(cfg.evaluateRepairedPatch, false);
  assert.equal(cfg.includeAdHocRunLabels, false); // ad hoc inclusion is opt-in
  // missing_failing_behavior is NOT in the default allowed set.
  assert.deepEqual([...cfg.allowedDefectClasses].sort(), ["broad_rewrite_minimality", "wrong_scope"]);
});

test("parseArgs --include-ad-hoc-run-labels opts into ad hoc candidate inclusion", () => {
  assert.equal(parseArgs(["--include-ad-hoc-run-labels"]).includeAdHocRunLabels, true);
});

test("parseArgs supports the smoke-target flags", () => {
  const cfg = parseArgs([
    "--results",
    "some/dir",
    "--enable-patch-repair",
    "--run-label",
    "eval-patchverify-before-sympy-16766",
    "--max-repair-runs",
    "1",
    "--repair-cost-cap-usd",
    "0.25",
    "--out-name",
    "stage5_patch_repair_smoke_sympy",
  ]);
  assert.equal(cfg.resultsDir, "some/dir");
  assert.equal(cfg.enablePatchRepair, true);
  assert.deepEqual(cfg.runLabels, ["eval-patchverify-before-sympy-16766"]);
  assert.equal(cfg.maxRepairRuns, 1);
  assert.equal(cfg.repairCostCapUsd, 0.25);
  assert.equal(cfg.outName, "stage5_patch_repair_smoke_sympy");
});

test("parseArgs validates numerics and defect classes", () => {
  assert.throws(() => parseArgs(["--max-repair-runs", "-1"]), /non-negative integer/);
  assert.throws(() => parseArgs(["--max-repair-runs", "1.5"]), /non-negative integer/);
  assert.throws(() => parseArgs(["--repair-cost-cap-usd", "-1"]), /non-negative number/);
  assert.throws(() => parseArgs(["--allow-defect-class", "nonsense"]), /allow-defect-class must be one of/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
  // Explicitly allowing missing_failing_behavior is permitted (operator opt-in).
  const cfg = parseArgs(["--allow-defect-class", "missing_failing_behavior"]);
  assert.deepEqual(cfg.allowedDefectClasses, ["missing_failing_behavior"]);
});

// ---------------------------------------------------------------------------
// 2. Explicit run-label is required for repair.
// ---------------------------------------------------------------------------
test("repair requires an explicit --run-label; none provided ⇒ nothing repaired", async () => {
  const candidates = [candidateFor({ runLabel: "run-a" }), candidateFor({ runLabel: "run-b" })];
  const m = mockCaller();
  const { decisions, counters } = await runGatedRepair({
    candidates,
    gate: gateOf({ runLabels: [], maxRepairRuns: 5 }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 0); // model never reached
  assert.equal(counters.eligibleRuns, 0);
  assert.equal(counters.skippedByRunLabel, 2);
  for (const d of decisions) assert.equal(d.skipReason, "run-label-required");
});

test("--run-label restricts repair to the requested run", async () => {
  const candidates = [
    candidateFor({ runLabel: "run-a" }),
    candidateFor({ runLabel: "run-b" }),
    candidateFor({ runLabel: "run-c" }),
  ];
  const m = mockCaller();
  const { decisions, counters } = await runGatedRepair({
    candidates,
    gate: gateOf({ runLabels: ["run-b"], maxRepairRuns: 5 }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 1);
  assert.equal(counters.eligibleRuns, 1);
  const repaired = decisions.filter((d) => d.repaired);
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0]!.runLabel, "run-b");
  for (const d of decisions.filter((d) => !d.repaired)) assert.equal(d.skipReason, "not-in-run-label");
});

// ---------------------------------------------------------------------------
// 3. Only liveRepairRequired=true runs are eligible.
// 4. failedOpen/invalid live critic report is ineligible.
// 5. missing_failing_behavior is ineligible by default.
// ---------------------------------------------------------------------------
test("ineligible runs are skipped with reasons and never call the model", async () => {
  const candidates = [
    candidateFor({ runLabel: "no-repair", meta: metaFor({ liveRepairRequired: false }), report: reportFor("sympy__sympy-16766", { repairRequired: false }) }),
    candidateFor({ runLabel: "failed-open", meta: metaFor({ failedOpen: true, liveRepairRequired: null }) }),
    candidateFor({ runLabel: "invalid", meta: metaFor({ validReport: false, liveRepairRequired: null }) }),
    candidateFor({ runLabel: "mfb", instanceId: "matplotlib__matplotlib-22719" }),
  ];
  const m = mockCaller();
  const { decisions, counters } = await runGatedRepair({
    candidates,
    gate: gateOf({ runLabels: ["no-repair", "failed-open", "invalid", "mfb"], maxRepairRuns: 5 }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 0);
  assert.equal(counters.eligibleRuns, 0);
  assert.equal(counters.skippedIneligible, 4);
  for (const d of decisions) {
    assert.equal(d.skipReason, "ineligible");
    assert.ok(d.ineligibleReasons.length > 0);
  }
  // The matplotlib (missing_failing_behavior) run is excluded specifically for its defect class.
  const mfb = decisions.find((d) => d.runLabel === "mfb")!;
  assert.ok(mfb.ineligibleReasons.some((r) => r.includes("missing_failing_behavior")));
});

// ---------------------------------------------------------------------------
// 9. max-repair-runs gates calls.
// ---------------------------------------------------------------------------
test("--max-repair-runs caps the number of repair calls", async () => {
  const candidates = [
    candidateFor({ runLabel: "run-a" }),
    candidateFor({ runLabel: "run-b" }),
    candidateFor({ runLabel: "run-c" }),
  ];
  const m = mockCaller();
  const { decisions, counters } = await runGatedRepair({
    candidates,
    gate: gateOf({ runLabels: ["run-a", "run-b", "run-c"], maxRepairRuns: 1 }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 1);
  assert.equal(counters.eligibleRuns, 3);
  assert.equal(counters.repairCallsAttempted, 1);
  assert.equal(counters.skippedByMaxRuns, 2);
  assert.equal(decisions.filter((d) => d.skipReason === "max-repair-runs").length, 2);
});

// ---------------------------------------------------------------------------
// 10. cost cap gates calls.
// ---------------------------------------------------------------------------
test("--repair-cost-cap-usd stops further calls once accumulated spend reaches the cap", async () => {
  const candidates = [
    candidateFor({ runLabel: "run-a" }),
    candidateFor({ runLabel: "run-b" }),
    candidateFor({ runLabel: "run-c" }),
  ];
  const m = mockCaller({ costUsd: 0.3 }); // first call exceeds the 0.25 cap
  const { counters } = await runGatedRepair({
    candidates,
    gate: gateOf({ runLabels: ["run-a", "run-b", "run-c"], maxRepairRuns: 5, repairCostCapUsd: 0.25 }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 1);
  assert.equal(counters.repairCallsAttempted, 1);
  assert.equal(counters.stoppedByCostCap, 2);
  assert.ok(Math.abs(counters.totalRepairCostUsd - 0.3) < 1e-9);
});

// ---------------------------------------------------------------------------
// 8. --dry-run makes no model calls.
// ---------------------------------------------------------------------------
test("--dry-run invokes no caller and records would-repair decisions", async () => {
  const candidates = [candidateFor({ runLabel: "run-a" }), candidateFor({ runLabel: "run-b" })];
  const m = mockCaller();
  const { decisions, counters } = await runGatedRepair({
    candidates,
    gate: gateOf({ runLabels: ["run-a", "run-b"], maxRepairRuns: 5, dryRun: true }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 0);
  assert.equal(counters.repairCallsAttempted, 0);
  assert.equal(counters.totalRepairCostUsd, 0);
  const wouldRepair = decisions.filter((d) => d.wouldRepair);
  assert.equal(wouldRepair.length, 2);
  for (const d of wouldRepair) {
    assert.equal(d.repaired, false);
    assert.equal(d.invocation, null);
  }
});

// ---------------------------------------------------------------------------
// 11. invalid repair output fails open (through the gate).
// ---------------------------------------------------------------------------
test("invalid repair output fails open through the gate and produces no repaired patch", async () => {
  const candidates = [candidateFor({ runLabel: "run-a" })];
  const m = mockCaller({ response: "I refuse to emit a diff." });
  const { decisions, counters } = await runGatedRepair({
    candidates,
    gate: gateOf({ runLabels: ["run-a"], maxRepairRuns: 5 }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 1);
  assert.equal(counters.repairCallsAttempted, 1);
  assert.equal(counters.repairCallsFailedOpen, 1);
  assert.equal(counters.repairCallsSucceeded, 0);
  assert.equal(counters.repairedPatchProduced, 0);
  const d = decisions[0]!;
  assert.equal(d.repaired, true);
  assert.equal(d.invocation!.result.failedOpen, true);
  assert.equal(d.invocation!.result.repairedPatch, null);
  // No repaired patch artifact on fail-open; first patch copy is still present.
  assert.ok(!("_repaired_patch.diff" in d.invocation!.artifacts));
  assert.ok("_first_patch.diff" in d.invocation!.artifacts);
});

// ---------------------------------------------------------------------------
// 12 & 14. valid repair accepted; repair artifacts built for enabled eligible runs.
// ---------------------------------------------------------------------------
test("a valid repair is accepted and its artifacts are built", async () => {
  const candidates = [candidateFor({ runLabel: "run-a" })];
  const m = mockCaller();
  const { decisions, counters } = await runGatedRepair({
    candidates,
    gate: gateOf({ runLabels: ["run-a"], maxRepairRuns: 5 }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 1);
  assert.equal(counters.repairCallsSucceeded, 1);
  assert.equal(counters.repairedPatchProduced, 1);
  assert.equal(counters.changedPatchCount, 1);
  const inv = decisions[0]!.invocation!;
  assert.equal(inv.result.validPatch, true);
  assert.equal(inv.result.repairedPatch, REPAIRED_PATCH);
  for (const name of [
    "_patch_repair_input.json",
    "_patch_repair.raw.txt",
    "_patch_repair_result.json",
    "_patch_repair.meta.json",
    "_first_patch.diff",
    "_repaired_patch.diff",
  ]) {
    assert.ok(name in inv.artifacts, `missing artifact ${name}`);
  }
  // 13. The copied first patch matches the candidate's first patch (original untouched in code).
  assert.ok(inv.artifacts["_first_patch.diff"]!.startsWith(FIRST_PATCH));
  // Evaluation is recorded as deferred / not performed (no resolution claim).
  assert.equal(inv.meta.evaluation.performed, false);
});

// ---------------------------------------------------------------------------
// Report shape + rendering.
// ---------------------------------------------------------------------------
test("buildRepairReport surfaces the required summary fields and renders without throwing", async () => {
  const candidates = [candidateFor({ runLabel: "run-a" }), candidateFor({ runLabel: "run-b" })];
  const gate = gateOf({ runLabels: ["run-a"], maxRepairRuns: 1 });
  const m = mockCaller();
  const outcome = await runGatedRepair({ candidates, gate, caller: m.caller, repairModel: null });
  const report = buildRepairReport({ generatedAt: "2026-01-01T00:00:00.000Z", enabled: true, gate, outcome });

  const parsed = JSON.parse(renderJson(report));
  for (const field of [
    "candidateRuns",
    "eligibleRuns",
    "repairCallsAttempted",
    "repairCallsSucceeded",
    "repairCallsFailedOpen",
    "repairedPatchProduced",
    "changedPatchCount",
    "totalRepairCostUsd",
  ]) {
    assert.ok(field in parsed.summary, `missing summary field ${field}`);
  }
  assert.equal(parsed.summary.candidateRuns, 2);
  assert.equal(parsed.summary.repairCallsSucceeded, 1);
  assert.ok(Array.isArray(parsed.nonClaims) && parsed.nonClaims.length > 0);
  assert.ok(Array.isArray(parsed.runs) && parsed.runs.length === 2);

  const md = renderMarkdown(report);
  for (const section of [
    "# Stage 5 patch repair run",
    "## Summary",
    "## Eligibility gates",
    "## Runs repaired",
    "## Runs skipped",
    "## Repair artifact summary",
    "## Cost and token impact",
    "## Safety properties",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(section), `missing markdown section ${section}`);
  }
});

// ---------------------------------------------------------------------------
// 8. Repair dry-run can see an ad hoc candidate once its live-critic artifacts exist on disk.
// ---------------------------------------------------------------------------
test("an ad hoc run with live-critic artifacts loads as an eligible candidate (source ad_hoc_run_label)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stage5-repair-adhoc-"));
  try {
    const results = path.join(root, "results");
    const runLabel = "eval-strictgated-vtrace-requests-5414";
    const dir = path.join(results, "runs", runLabel, "raw", "vtrace");
    await mkdir(dir, { recursive: true });
    // The live-critic artifacts the critic runner would have written for this ad hoc run.
    const report = reportFor("psf__requests-5414");
    await writeFile(path.join(dir, "_patch_critic_report.json"), JSON.stringify(report));
    await writeFile(path.join(dir, "_patch_critic.meta.json"), JSON.stringify(metaFor()));
    await writeFile(
      path.join(dir, "_patch_critic_input.json"),
      JSON.stringify({ instanceId: "psf__requests-5414", issueText: null, firstPatch: FIRST_PATCH }),
    );
    await writeFile(path.join(dir, "_first_patch.diff"), FIRST_PATCH);

    // Loaded as an ad hoc candidate (the runner builds this label set when --include-ad-hoc-run-labels).
    const candidates = await loadRepairCandidates(
      results,
      [{ runLabel, source: "ad_hoc_run_label" }],
      ["wrong_scope", "broad_rewrite_minimality"],
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.source, "ad_hoc_run_label");
    assert.equal(candidates[0]!.eligibility.eligible, true);

    // Dry-run sees it and would repair it — without calling any model.
    const m = mockCaller();
    const { decisions, counters } = await runGatedRepair({
      candidates,
      gate: gateOf({ runLabels: [runLabel], maxRepairRuns: 1, dryRun: true }),
      caller: m.caller,
      repairModel: null,
    });
    assert.equal(m.calls, 0);
    assert.equal(counters.eligibleRuns, 1);
    const d = decisions[0]!;
    assert.equal(d.wouldRepair, true);
    assert.equal(d.source, "ad_hoc_run_label");

    // The report carries the source and an ad hoc audit trail.
    const built = buildRepairReport({
      generatedAt: null,
      enabled: true,
      gate: gateOf({ runLabels: [runLabel], maxRepairRuns: 1, dryRun: true }),
      outcome: { decisions, counters },
      adHoc: { adHocRequested: 1, adHocCandidates: 1 },
    });
    const parsed = JSON.parse(renderJson(built));
    assert.equal(parsed.adHoc.adHocRequested, 1);
    assert.equal(parsed.runs[0].source, "ad_hoc_run_label");
    assert.ok(renderMarkdown(built).includes("ad_hoc_run_label"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 9. Existing curated candidates still default to source=curated_existing.
test("curated candidates are tagged source=curated_existing by default", async () => {
  const candidates = [candidateFor({ runLabel: "run-a" })];
  assert.equal(candidates[0]!.source, "curated_existing");
});

// 8 (this milestone). The repair runner does NOT automatically treat a generated-parser
// (astropy) broad rewrite as repair-eligible: its defect class is `unknown`, which is excluded
// from the default allowlist, so even WITH a valid live-critic artifact requesting repair the run
// is ineligible. The patch-minimality milestone adds NO generated-parser class to the allowlist.
test("generated-parser (astropy) run is NOT repair-eligible by default even with a valid critic artifact", () => {
  // The repair allowlist is unchanged: only wrong_scope + broad_rewrite_minimality, no parser class.
  assert.deepEqual([...DEFAULT_ALLOWED_DEFECT_CLASSES], ["wrong_scope", "broad_rewrite_minimality"]);
  assert.equal(defectClassFor("astropy__astropy-14369"), "unknown");
  assert.ok(!DEFAULT_ALLOWED_DEFECT_CLASSES.includes("unknown"));

  // A fully-valid live-critic artifact (validReport, not failed-open, liveRepairRequired) that
  // requests repair on the astropy run — still ineligible because its defect class is not allowed.
  const eligibility = evaluateRepairEligibility({
    runLabel: "eval-strictv2-artifacts-protocol-vtrace-astropy-14369",
    meta: metaFor(),
    report: reportFor("astropy__astropy-14369", { repairRequired: true }),
    firstPatch: FIRST_PATCH,
    allowedDefectClasses: DEFAULT_ALLOWED_DEFECT_CLASSES,
  });
  assert.equal(eligibility.defectClass, "unknown");
  assert.equal(eligibility.eligible, false);
  assert.ok(eligibility.reasons.some((r) => /not in the allowed set/.test(r)));

  // And with NO critic artifacts at all, it is likewise ineligible (nothing to act on).
  const noArtifacts = evaluateRepairEligibility({
    runLabel: "eval-strictv2-artifacts-protocol-vtrace-astropy-14369",
    meta: null,
    report: null,
    firstPatch: null,
    allowedDefectClasses: DEFAULT_ALLOWED_DEFECT_CLASSES,
  });
  assert.equal(noArtifacts.eligible, false);
});
