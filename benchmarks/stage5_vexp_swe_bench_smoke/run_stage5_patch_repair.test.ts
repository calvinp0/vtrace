import assert from "node:assert/strict";
import { test } from "bun:test";

import type { PatchCriticReport } from "./stage5_patch_critic";
import type { LiveCriticMeta } from "./stage5_patch_critic_live";
import {
  type PatchMinimalityProbe,
  type RepairCaller,
  DEFAULT_ALLOWED_DEFECT_CLASSES,
  GENERATED_PARSER_CONSISTENCY_DEFECT_CLASS,
  GENERATED_PARSER_NARROW_REWRITE_GUIDANCE,
  GENERATED_PARSER_REPAIR_CLASS,
  GENERATED_PARSER_REPAIR_CONSISTENCY_GUIDANCE,
  GENERATED_PARSER_REPAIR_MINIMALITY_GUIDANCE,
  GENERATED_PARSER_REPAIR_SOURCE,
  buildGeneratedParserConsistencyContext,
  buildGeneratedParserRepairGuidance,
  evaluateGeneratedParserRepairEligibility,
  evaluateRepairEligibility,
  hasNarrowRewriteGuidance,
  isGeneratedParserDefectClass,
} from "./stage5_patch_repair";
import { defectClassFor } from "./run_stage5_live_critic_high_risk_comparison";
import {
  type RepairCandidate,
  type RepairGateConfig,
  DEFAULT_MAX_REPAIR_RUNS,
  DEFAULT_REPAIR_COST_CAP_USD,
  DEFAULT_REPAIR_ESTIMATED_MAX_CALL_COST_USD,
  GENERATED_PARSER_DRY_RUN_BOUNDARY,
  buildRepairReport,
  evaluateCostCapPreCall,
  loadPatchMinimalityProbe,
  loadRepairCandidates,
  parseArgs,
  renderJson,
  renderMarkdown,
  repairCostCapEnforcementMode,
  runGatedRepair,
  singleCallMayExceedCap,
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
  patchMinimalityProbe?: PatchMinimalityProbe | null;
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
    patchMinimalityProbe: args.patchMinimalityProbe ?? null,
  };
}

// --------------------------------------------------------------------------
// Generated-parser fixtures (the Astropy run that the agreement report covered).
// --------------------------------------------------------------------------

const GP_RUN_LABEL = "eval-strictv2-artifacts-protocol-vtrace-astropy-14369";
const GP_INSTANCE = "astropy__astropy-14369";

// A live-critic report mirroring the real Astropy generated-parser verdict: repair required, with
// ACTIONABLE narrow-rewrite instructions (keep functions separate, reorder the division production,
// do not delete generated tables).
function gpReport(opts: { repairRequired?: boolean; instructions?: string } = {}): PatchCriticReport {
  const repairRequired = opts.repairRequired ?? true;
  return {
    instanceId: GP_INSTANCE,
    runLabel: GP_RUN_LABEL,
    scope_ok: true,
    scope_evidence: "edits astropy/units/format/cds.py.",
    failing_behavior_handled: true,
    failing_behavior_evidence: "added combined_units production.",
    minimality_ok: false,
    minimality_evidence: "broad generated-parser rewrite.",
    test_evidence_ok: false,
    test_evidence: "ad-hoc import check only.",
    risk: "high",
    repair_required: repairRequired,
    repair_reason: repairRequired ? "Broad non-minimal rewrite of a generated parser." : "",
    repair_instructions: repairRequired
      ? (opts.instructions ??
        "Keep p_product_of_units and p_division_of_units as separate functions and confine the fix to making the division production left-associative within p_division_of_units. Do not delete cds_lextab.py/cds_parsetab.py by hand; let PLY regenerate them.")
      : "",
    confidence: "high",
    evidence_probe_ids: ["minimality_rewrite_risk"],
  };
}

function gpProbe(overrides: Partial<PatchMinimalityProbe> = {}): PatchMinimalityProbe {
  return {
    patchMinimalityRepairRequired: true,
    patchMinimalityDefectClass: GENERATED_PARSER_REPAIR_CLASS,
    patchMinimalityRisk: "high",
    patchMinimalityConfidence: "high",
    patchMinimalityNarrowAlternativeHint:
      "Narrower alternative likely exists: reorder the division_of_units grammar production within its own parser function.",
    patchMinimalitySignals: ["generated_parser_table_deleted", "grammar_function_removed"],
    ...overrides,
  };
}

// A fully-valid generated-parser candidate (all artifact-side gates satisfied). Its DEFAULT-path
// eligibility is still false (defect class `unknown`), so only the generated-parser path can make it
// eligible — and only in dry-run with the explicit flag.
function gpCandidate(args: {
  meta?: LiveCriticMeta;
  report?: PatchCriticReport;
  firstPatch?: string | null;
  probe?: PatchMinimalityProbe | null;
} = {}): RepairCandidate {
  return candidateFor({
    runLabel: GP_RUN_LABEL,
    instanceId: GP_INSTANCE,
    source: "ad_hoc_run_label",
    meta: args.meta ?? metaFor(),
    report: args.report ?? gpReport(),
    firstPatch: args.firstPatch === undefined ? FIRST_PATCH : args.firstPatch,
    patchMinimalityProbe: args.probe === undefined ? gpProbe() : args.probe,
  });
}

// The gate config for a generated-parser dry-run with the explicit flag and all operational gates.
function gpGate(overrides: Partial<RepairGateConfig> = {}): RepairGateConfig {
  return gateOf({
    runLabels: [GP_RUN_LABEL],
    maxRepairRuns: 1,
    repairCostCapUsd: 0.25,
    dryRun: true,
    allowGeneratedParserRepair: true,
    ...overrides,
  });
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

// ===========================================================================
// Generated-parser repair eligibility gate (DRY-RUN ONLY, explicit flag).
// ===========================================================================

// parseArgs default + flag.
test("parseArgs: --allow-generated-parser-repair is off by default and opt-in", () => {
  assert.equal(parseArgs([]).allowGeneratedParserRepair, false);
  assert.equal(parseArgs(["--allow-generated-parser-repair"]).allowGeneratedParserRepair, true);
});

// Pure helpers.
test("isGeneratedParserDefectClass recognizes the canonical label and equivalents", () => {
  assert.equal(isGeneratedParserDefectClass(GENERATED_PARSER_REPAIR_CLASS), true);
  assert.equal(isGeneratedParserDefectClass("generated_parser_broad_rewrite"), true);
  assert.equal(isGeneratedParserDefectClass("grammar_patch_minimality"), true);
  assert.equal(isGeneratedParserDefectClass("wrong_scope"), false);
  assert.equal(isGeneratedParserDefectClass(null), false);
});

test("hasNarrowRewriteGuidance requires actionable instructions with a narrow marker", () => {
  assert.equal(hasNarrowRewriteGuidance(gpReport(), gpProbe()), true);
  // Vague / generic instruction ⇒ not narrow guidance.
  assert.equal(
    hasNarrowRewriteGuidance(gpReport({ instructions: "Fix the patch." }), gpProbe({ patchMinimalityNarrowAlternativeHint: null })),
    false,
  );
});

// 1. Blocked by default (no flag), even with every artifact-side gate satisfied.
test("generated-parser repair is BLOCKED by default (no --allow-generated-parser-repair)", () => {
  const e = evaluateGeneratedParserRepairEligibility({
    runLabel: GP_RUN_LABEL,
    allowGeneratedParserRepair: false,
    dryRun: true,
    runLabelProvided: true,
    meta: metaFor(),
    report: gpReport(),
    firstPatch: FIRST_PATCH,
    probe: gpProbe(),
  });
  assert.equal(e.allowed, false);
  assert.equal(e.eligible, false);
  assert.ok(e.blockedReasons.some((r) => /allow-generated-parser-repair/.test(r)));
});

// 7. Eligible in dry-run with the explicit flag and ALL gates satisfied.
test("generated-parser repair is ELIGIBLE in dry-run with the flag and all gates satisfied", () => {
  const e = evaluateGeneratedParserRepairEligibility({
    runLabel: GP_RUN_LABEL,
    allowGeneratedParserRepair: true,
    dryRun: true,
    runLabelProvided: true,
    meta: metaFor(),
    report: gpReport(),
    firstPatch: FIRST_PATCH,
    probe: gpProbe(),
  });
  assert.equal(e.allowed, true);
  assert.equal(e.eligible, true);
  assert.deepEqual(e.blockedReasons, []);
  assert.equal(e.repairClass, GENERATED_PARSER_REPAIR_CLASS);
  assert.equal(e.source, GENERATED_PARSER_REPAIR_SOURCE);
  assert.deepEqual([...e.actionableNarrowRewriteGuidance], [...GENERATED_PARSER_NARROW_REWRITE_GUIDANCE]);
});

// 2. Blocked without an explicit run-label for this run.
test("generated-parser repair is BLOCKED without an explicit run-label", () => {
  const e = evaluateGeneratedParserRepairEligibility({
    runLabel: GP_RUN_LABEL,
    allowGeneratedParserRepair: true,
    dryRun: true,
    runLabelProvided: false,
    meta: metaFor(),
    report: gpReport(),
    firstPatch: FIRST_PATCH,
    probe: gpProbe(),
  });
  assert.equal(e.eligible, false);
  assert.ok(e.blockedReasons.some((r) => /run-label/.test(r)));
});

// 3. Blocked without valid live-critic artifacts.
test("generated-parser repair is BLOCKED without valid live-critic artifacts", () => {
  const e = evaluateGeneratedParserRepairEligibility({
    runLabel: GP_RUN_LABEL,
    allowGeneratedParserRepair: true,
    dryRun: true,
    runLabelProvided: true,
    meta: null,
    report: null,
    firstPatch: FIRST_PATCH,
    probe: gpProbe(),
  });
  assert.equal(e.eligible, false);
  assert.ok(e.blockedReasons.some((r) => /missing live critic artifacts/.test(r)));
});

// 4. Blocked when live critic repair_required=false.
test("generated-parser repair is BLOCKED when live critic repair_required=false", () => {
  const e = evaluateGeneratedParserRepairEligibility({
    runLabel: GP_RUN_LABEL,
    allowGeneratedParserRepair: true,
    dryRun: true,
    runLabelProvided: true,
    meta: metaFor({ liveRepairRequired: false }),
    report: gpReport({ repairRequired: false }),
    firstPatch: FIRST_PATCH,
    probe: gpProbe(),
  });
  assert.equal(e.eligible, false);
  assert.ok(e.blockedReasons.some((r) => /did not require repair/.test(r)));
});

// 5. Blocked when deterministic/live agreement is false.
test("generated-parser repair is BLOCKED when deterministic/live agreement is false", () => {
  const e = evaluateGeneratedParserRepairEligibility({
    runLabel: GP_RUN_LABEL,
    allowGeneratedParserRepair: true,
    dryRun: true,
    runLabelProvided: true,
    meta: metaFor({ agreementWithDeterministic: false }),
    report: gpReport(),
    firstPatch: FIRST_PATCH,
    probe: gpProbe(),
  });
  assert.equal(e.eligible, false);
  assert.ok(e.blockedReasons.some((r) => /agreement/.test(r)));
});

// 5b. Blocked when the deterministic probe did not require repair.
test("generated-parser repair is BLOCKED when deterministic patchMinimalityRepairRequired!=true", () => {
  const e = evaluateGeneratedParserRepairEligibility({
    runLabel: GP_RUN_LABEL,
    allowGeneratedParserRepair: true,
    dryRun: true,
    runLabelProvided: true,
    meta: metaFor(),
    report: gpReport(),
    firstPatch: FIRST_PATCH,
    probe: gpProbe({ patchMinimalityRepairRequired: false }),
  });
  assert.equal(e.eligible, false);
  assert.ok(e.blockedReasons.some((r) => /patchMinimalityRepairRequired/.test(r)));
});

// 6. Blocked when the narrow-rewrite guidance is missing or vague.
test("generated-parser repair is BLOCKED when narrow-rewrite guidance is missing or vague", () => {
  const e = evaluateGeneratedParserRepairEligibility({
    runLabel: GP_RUN_LABEL,
    allowGeneratedParserRepair: true,
    dryRun: true,
    runLabelProvided: true,
    meta: metaFor(),
    report: gpReport({ instructions: "Fix the patch." }),
    firstPatch: FIRST_PATCH,
    probe: gpProbe({ patchMinimalityNarrowAlternativeHint: null }),
  });
  assert.equal(e.eligible, false);
  assert.ok(e.blockedReasons.some((r) => /narrow-rewrite guidance/.test(r)));
  assert.deepEqual([...e.actionableNarrowRewriteGuidance], []);
});

// Live mode requires --enable-patch-repair. Blocked when NOT in dry-run AND --enable-patch-repair
// is absent (this is the boundary that prevents an accidental live repair).
test("generated-parser repair is BLOCKED when not in --dry-run and --enable-patch-repair is absent", () => {
  const e = evaluateGeneratedParserRepairEligibility({
    runLabel: GP_RUN_LABEL,
    allowGeneratedParserRepair: true,
    enablePatchRepair: false,
    dryRun: false,
    runLabelProvided: true,
    meta: metaFor(),
    report: gpReport(),
    firstPatch: FIRST_PATCH,
    probe: gpProbe(),
  });
  assert.equal(e.eligible, false);
  assert.equal(e.mode, "blocked");
  assert.ok(e.blockedReasons.some((r) => /enable-patch-repair/.test(r)));
});

// ===========================================================================
// Generated-parser LIVE repair execution (explicit gated path; injected caller).
// ===========================================================================

// 10. Eligible in LIVE mode with the flags and ALL gates satisfied; mode=live.
test("generated-parser repair is ELIGIBLE in live mode with --enable-patch-repair + flag + all gates", () => {
  const e = evaluateGeneratedParserRepairEligibility({
    runLabel: GP_RUN_LABEL,
    allowGeneratedParserRepair: true,
    enablePatchRepair: true,
    dryRun: false,
    runLabelProvided: true,
    meta: metaFor(),
    report: gpReport(),
    firstPatch: FIRST_PATCH,
    probe: gpProbe(),
  });
  assert.equal(e.allowed, true);
  assert.equal(e.eligible, true);
  assert.equal(e.mode, "live");
  assert.deepEqual(e.blockedReasons, []);
});

// 2. Live blocked without --enable-patch-repair (already covered above at the function level); here
// end-to-end through the runner the run stays ineligible and the model is never called.
test("runGatedRepair: generated-parser live run is BLOCKED without --enable-patch-repair (no model)", async () => {
  const m = mockCaller();
  const { decisions, counters } = await runGatedRepair({
    candidates: [gpCandidate()],
    gate: gpGate({ dryRun: false, enablePatchRepair: false, allowGeneratedParserRepair: true }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 0);
  assert.equal(counters.eligibleRuns, 0);
  const d = decisions[0]!;
  assert.equal(d.viaGeneratedParser, false);
  assert.ok(d.generatedParser?.blockedReasons.some((r) => /enable-patch-repair/.test(r)));
});

// 3. Live blocked without --allow-generated-parser-repair (no model).
test("runGatedRepair: generated-parser live run is BLOCKED without --allow-generated-parser-repair (no model)", async () => {
  const m = mockCaller();
  const { counters } = await runGatedRepair({
    candidates: [gpCandidate()],
    gate: gpGate({ dryRun: false, enablePatchRepair: true, allowGeneratedParserRepair: false }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 0);
  assert.equal(counters.eligibleRuns, 0);
});

// 10 & 14. Live mode with ALL gates satisfied invokes the injected caller EXACTLY ONCE.
test("runGatedRepair: generated-parser live run calls the injected caller exactly once", async () => {
  const m = mockCaller();
  const { decisions, counters } = await runGatedRepair({
    candidates: [gpCandidate()],
    gate: gpGate({ dryRun: false, enablePatchRepair: true, allowGeneratedParserRepair: true }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 1); // exactly one bounded attempt
  assert.equal(counters.eligibleRuns, 1);
  assert.equal(counters.repairCallsAttempted, 1);
  assert.equal(counters.repairCallsSucceeded, 1);
  assert.equal(counters.repairedPatchProduced, 1);
  const d = decisions[0]!;
  assert.equal(d.repaired, true);
  assert.equal(d.viaGeneratedParser, true);
  assert.equal(d.invocation!.result.validPatch, true);
  // The repair input carried the generated-parser narrow-rewrite guidance and source marker.
  assert.equal(d.invocation!.input.generatedParserRepair?.source, "generated_parser_minimality");
  const gpGuidance = d.invocation!.input.generatedParserRepair!.guidance;
  // Refined guidance: flags the consistency issue, keeps minimality + consistency blocks.
  assert.ok(gpGuidance.some((g) => /generated-parser repair consistency issue/.test(g)));
  assert.ok(gpGuidance.some((g) => /update\/regenerate the corresponding generated parser table/.test(g)));
  assert.ok(gpGuidance.some((g) => /do not relocate productions into.*p_combined_units/.test(g)));
  // The meta marks the source as a generated-parser minimality repair.
  assert.equal(d.invocation!.meta.generatedParserRepairSource, "generated_parser_minimality");
  // A repaired patch artifact was produced.
  assert.ok("_repaired_patch.diff" in d.invocation!.artifacts);
});

// 11. Live report surfaces the required generated-parser live-attempt fields with executed=true.
test("buildRepairReport: generated-parser live report carries the live-attempt fields (executed=true)", async () => {
  const gate = gpGate({ dryRun: false, enablePatchRepair: true, allowGeneratedParserRepair: true });
  const m = mockCaller();
  const outcome = await runGatedRepair({ candidates: [gpCandidate()], gate, caller: m.caller, repairModel: null });
  const report = buildRepairReport({ generatedAt: null, enabled: true, gate, outcome });

  const parsed = JSON.parse(renderJson(report));
  assert.equal(parsed.generatedParser.mode, "live");
  assert.equal(parsed.generatedParser.repairExecuted, true);
  assert.equal(parsed.generatedParser.repairAttemptedRuns, 1);
  assert.equal(parsed.generatedParser.repairSucceededRuns, 1);

  const gpRun = parsed.generatedParser.runs[0];
  for (const field of [
    "generatedParserRepairAllowed",
    "generatedParserRepairEligible",
    "generatedParserRepairExecuted",
    "generatedParserRepairSource",
    "generatedParserRepairGuidance",
    "patchMinimalityRepairRequired",
    "patchMinimalityDefectClass",
    "liveCriticRepairRequired",
    "agreementWithDeterministic",
    "repairAttempted",
    "repairSucceeded",
    "repairFailedOpen",
    "repairCostUsd",
  ]) {
    assert.ok(field in gpRun, `missing generated-parser live field ${field}`);
  }
  assert.equal(gpRun.generatedParserRepairExecuted, true);
  assert.equal(gpRun.generatedParserRepairSource, "generated_parser_minimality");
  assert.equal(gpRun.repairAttempted, true);
  assert.equal(gpRun.repairSucceeded, true);
  assert.equal(gpRun.repairFailedOpen, false);
  assert.equal(typeof gpRun.repairCostUsd, "number");

  // The non-claim and the live boundary must both appear.
  assert.ok(parsed.nonClaims.some((n: string) => /did not run Docker and does not claim a repair conversion/.test(n)));
  const md = renderMarkdown(report);
  assert.ok(md.includes("## Generated-parser repair (live execution)"));
  assert.ok(md.includes("This generated a repaired patch only. It did not run Docker and does not claim a repair conversion."));
});

// 12. Fail-open: an invalid model response preserves the first patch and records the error, while
// still being counted as a generated-parser attempt.
test("runGatedRepair: generated-parser live fail-open preserves the first patch and records error", async () => {
  const m = mockCaller({ response: "I will not emit a diff." });
  const { decisions, counters } = await runGatedRepair({
    candidates: [gpCandidate()],
    gate: gpGate({ dryRun: false, enablePatchRepair: true, allowGeneratedParserRepair: true }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 1);
  assert.equal(counters.repairCallsAttempted, 1);
  assert.equal(counters.repairCallsFailedOpen, 1);
  assert.equal(counters.repairCallsSucceeded, 0);
  const d = decisions[0]!;
  assert.equal(d.viaGeneratedParser, true);
  assert.equal(d.invocation!.result.failedOpen, true);
  assert.equal(d.invocation!.result.repairedPatch, null);
  assert.ok(d.invocation!.result.error);
  // First-patch copy present; no repaired patch artifact on fail-open.
  assert.ok("_first_patch.diff" in d.invocation!.artifacts);
  assert.ok(!("_repaired_patch.diff" in d.invocation!.artifacts));
});

// 9 (dry-run preserved). With --allow-generated-parser-repair and --dry-run the run reports
// wouldRepair=true and repairExecuted=false, and NO model is called — unchanged from before.
test("generated-parser dry-run with the flag still reports wouldRepair=true / repairExecuted=false (no model)", async () => {
  const m = mockCaller();
  const { decisions, counters } = await runGatedRepair({
    candidates: [gpCandidate()],
    gate: gpGate({ dryRun: true, allowGeneratedParserRepair: true }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 0);
  assert.equal(counters.repairCallsAttempted, 0);
  const d = decisions[0]!;
  assert.equal(d.wouldRepair, true);
  assert.equal(d.repaired, false); // dry-run never executes ⇒ generatedParserRepairExecuted stays false
  assert.equal(d.generatedParser?.mode, "dry-run");
});

// End-to-end through the runner: eligible dry-run, no model call, repairExecuted=false.
test("runGatedRepair: generated-parser run is would-repair in dry-run with the flag (no model)", async () => {
  const m = mockCaller();
  const { decisions, counters } = await runGatedRepair({
    candidates: [gpCandidate()],
    gate: gpGate(),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 0); // 11. no model/agent/live-repair call
  assert.equal(counters.eligibleRuns, 1);
  assert.equal(counters.repairCallsAttempted, 0);
  const d = decisions[0]!;
  assert.equal(d.wouldRepair, true);
  assert.equal(d.repaired, false);
  assert.equal(d.viaGeneratedParser, true);
  assert.ok(d.generatedParser);
  assert.equal(d.generatedParser?.eligible, true);
});

// End-to-end through the runner: blocked without the flag, eligibleRuns=0.
test("runGatedRepair: generated-parser run stays blocked without the flag (no model)", async () => {
  const m = mockCaller();
  const { decisions, counters } = await runGatedRepair({
    candidates: [gpCandidate()],
    gate: gpGate({ allowGeneratedParserRepair: false }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 0);
  assert.equal(counters.eligibleRuns, 0);
  assert.equal(counters.skippedIneligible, 1);
  const d = decisions[0]!;
  assert.equal(d.wouldRepair, false);
  assert.equal(d.viaGeneratedParser, false);
  assert.ok(d.generatedParser?.blockedReasons.some((r) => /allow-generated-parser-repair/.test(r)));
});

// 8 & 9. Dry-run report says repairExecuted=false and includes the narrow-rewrite guidance.
test("buildRepairReport: generated-parser dry-run report carries repairExecuted=false and guidance", async () => {
  const gate = gpGate();
  const m = mockCaller();
  const outcome = await runGatedRepair({ candidates: [gpCandidate()], gate, caller: m.caller, repairModel: null });
  const report = buildRepairReport({ generatedAt: null, enabled: false, gate, outcome });

  const parsed = JSON.parse(renderJson(report));
  assert.equal(parsed.summary.repairExecuted, false);
  assert.equal(parsed.gates.allowGeneratedParserRepair, true);
  assert.equal(parsed.generatedParser.allowed, true);
  assert.equal(parsed.generatedParser.eligibleRuns, 1);
  assert.equal(parsed.generatedParser.wouldRepairRuns, 1);
  assert.equal(parsed.generatedParser.repairExecuted, false);
  assert.equal(parsed.generatedParser.boundary, GENERATED_PARSER_DRY_RUN_BOUNDARY);

  const gpRun = parsed.generatedParser.runs[0];
  for (const field of [
    "generatedParserRepairAllowed",
    "generatedParserRepairEligible",
    "generatedParserRepairGateReasons",
    "generatedParserRepairBlockedReasons",
    "patchMinimalityRepairRequired",
    "patchMinimalityDefectClass",
    "liveCriticRepairRequired",
    "liveCriticValid",
    "agreementWithDeterministic",
    "actionableNarrowRewriteGuidance",
    "repairExecuted",
  ]) {
    assert.ok(field in gpRun, `missing generated-parser field ${field}`);
  }
  assert.equal(gpRun.generatedParserRepairEligible, true);
  assert.equal(gpRun.repairExecuted, false);
  assert.equal(gpRun.patchMinimalityRepairRequired, true);
  assert.equal(gpRun.liveCriticRepairRequired, true);
  assert.equal(gpRun.agreementWithDeterministic, true);
  assert.deepEqual(gpRun.actionableNarrowRewriteGuidance, [...GENERATED_PARSER_NARROW_REWRITE_GUIDANCE]);

  const md = renderMarkdown(report);
  assert.ok(md.includes("## Generated-parser repair (dry-run eligibility)"));
  assert.ok(md.includes(GENERATED_PARSER_DRY_RUN_BOUNDARY));
  for (const line of GENERATED_PARSER_NARROW_REWRITE_GUIDANCE) assert.ok(md.includes(line), `missing guidance: ${line}`);
});

// 10. Existing wrong_scope / broad_rewrite_minimality eligibility behavior is unchanged: a
// curated run with no probe still repairs via the default path (real model call) when not dry-run.
test("default-path wrong_scope repair is unaffected by the generated-parser gate", async () => {
  const m = mockCaller();
  const { decisions, counters } = await runGatedRepair({
    candidates: [candidateFor({ runLabel: "run-a" })], // no probe, defect class wrong_scope
    gate: gateOf({ runLabels: ["run-a"], maxRepairRuns: 1, allowGeneratedParserRepair: true }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 1); // default path still calls the model when eligible + not dry-run
  assert.equal(counters.eligibleRuns, 1);
  assert.equal(counters.repairCallsSucceeded, 1);
  const d = decisions[0]!;
  assert.equal(d.repaired, true);
  assert.equal(d.viaGeneratedParser, false);
  assert.equal(d.generatedParser, null); // no probe ⇒ no generated-parser detail
});

// loadPatchMinimalityProbe reads the deterministic probe row from the critic summary report.
test("loadPatchMinimalityProbe reads the probe row from the live-critic summary report", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stage5-gp-probe-"));
  try {
    const results = path.join(root, "results");
    await mkdir(results, { recursive: true });
    // The critic summary report shape: top-level `runs` array (NOT `.decisions`).
    const summary = {
      runs: [
        { runLabel: "other", instanceId: "x", patchMinimalityRepairRequired: false },
        {
          runLabel: GP_RUN_LABEL,
          instanceId: GP_INSTANCE,
          patchMinimalityRepairRequired: true,
          patchMinimalityDefectClass: GENERATED_PARSER_REPAIR_CLASS,
          patchMinimalityRisk: "high",
          patchMinimalityConfidence: "high",
          patchMinimalityNarrowAlternativeHint: "reorder the division_of_units production.",
          patchMinimalitySignals: ["generated_parser_table_deleted"],
        },
      ],
    };
    await writeFile(
      path.join(results, "stage5_live_critic_generated_parser_astropy.json"),
      JSON.stringify(summary),
    );
    const probe = await loadPatchMinimalityProbe(results, GP_RUN_LABEL);
    assert.ok(probe);
    assert.equal(probe?.patchMinimalityRepairRequired, true);
    assert.equal(probe?.patchMinimalityDefectClass, GENERATED_PARSER_REPAIR_CLASS);
    // A run absent from the summary yields null (fail-soft).
    assert.equal(await loadPatchMinimalityProbe(results, "missing-run"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// Refined generated-parser repair CONSISTENCY guidance (table-consistency milestone).
// ===========================================================================

// A broad generated-parser first patch: narrow cds.py grammar edit AND deletes both generated
// tables. The consistency probe derives expectedGeneratedTables = [cds_parsetab.py] from it.
const GP_FIRST_PATCH_BROAD = [
  "diff --git a/astropy/units/format/cds.py b/astropy/units/format/cds.py",
  "--- a/astropy/units/format/cds.py",
  "+++ b/astropy/units/format/cds.py",
  "@@ -164,12 +164,8 @@ class CDS(Base):",
  "         def p_combined_units(p):",
  '             """',
  "-            combined_units : product_of_units",
  "-                           | division_of_units",
  '-            """',
  "-        def p_division_of_units(p):",
  '-            """',
  "-            division_of_units : DIVISION unit_expression",
  "+            combined_units : combined_units DIVISION unit_expression",
  "+                           | unit_expression",
  '             """',
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

const GP_EXPECTED_TABLE = "astropy/units/format/cds_parsetab.py";

// 1, 2, 3, 4, 5. The repair prompt guidance includes consistency guidance, names the expected
// generated table, still forbids table deletion + broad rewrite/relocation, and distinguishes the
// minimality block from the consistency block.
test("buildGeneratedParserRepairGuidance includes consistency guidance + expected tables + minimality", () => {
  const consistency = buildGeneratedParserConsistencyContext(GP_FIRST_PATCH_BROAD);
  assert.ok(consistency, "consistency context should be derived from a generated-parser patch");
  assert.equal(consistency!.defectClass, GENERATED_PARSER_CONSISTENCY_DEFECT_CLASS);
  assert.deepEqual([...consistency!.expectedGeneratedTables], [GP_EXPECTED_TABLE]);

  const guidance = buildGeneratedParserRepairGuidance(gpReport(), gpProbe(), consistency);
  const text = guidance.join("\n");

  // 1. Consistency guidance present and references the flagged consistency defect class.
  assert.ok(/generated-parser repair consistency issue/.test(text));
  assert.ok(text.includes(GENERATED_PARSER_CONSISTENCY_DEFECT_CLASS));
  assert.ok(/update\/regenerate the corresponding generated parser table consistently/.test(text));
  // 2. Names the expected generated parser table path (artifact-derived).
  assert.ok(text.includes(GP_EXPECTED_TABLE));
  // 3. Still forbids generated parser table deletion (parsetab + lextab).
  assert.ok(/do not delete generated parser tables/.test(text));
  assert.ok(/do not delete lextab\/parsetab files/.test(text));
  // 4. Still forbids broad rewrites / production relocation into unrelated functions.
  assert.ok(/do not relocate productions into unrelated parser functions such as p_combined_units/.test(text));
  assert.ok(/do not broadly rewrite grammar structure/.test(text));
  // 5. Distinguishes the minimality block from the consistency block.
  assert.ok(text.includes("Minimality guidance"));
  assert.ok(text.includes("Consistency guidance"));
  // The two guidance constants are distinct and both fold into the prompt.
  assert.notDeepEqual(
    [...GENERATED_PARSER_REPAIR_MINIMALITY_GUIDANCE],
    [...GENERATED_PARSER_REPAIR_CONSISTENCY_GUIDANCE],
  );
  for (const line of GENERATED_PARSER_REPAIR_CONSISTENCY_GUIDANCE) assert.ok(guidance.includes(line));
  for (const line of GENERATED_PARSER_REPAIR_MINIMALITY_GUIDANCE) assert.ok(guidance.includes(line));
});

// A non-parser first patch yields no consistency context (default-path repairs are unaffected).
test("buildGeneratedParserConsistencyContext returns null for a non-parser patch", () => {
  assert.equal(buildGeneratedParserConsistencyContext(FIRST_PATCH), null);
  assert.equal(buildGeneratedParserConsistencyContext(null), null);
  assert.equal(buildGeneratedParserConsistencyContext(""), null);
});

// 1 (required behavior). A LIVE generated-parser repair on the broad patch carries, in its prompt,
// the consistency defect class, the expected table, the update/regenerate instruction, and the
// no-delete / no-relocate instructions.
test("runGatedRepair: live generated-parser repair input carries the consistency guidance", async () => {
  const m = mockCaller();
  const { decisions } = await runGatedRepair({
    candidates: [gpCandidate({ firstPatch: GP_FIRST_PATCH_BROAD })],
    gate: gpGate({ dryRun: false, enablePatchRepair: true, allowGeneratedParserRepair: true }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 1);
  const d = decisions[0]!;
  assert.equal(d.viaGeneratedParser, true);
  const ctx = d.invocation!.input.generatedParserRepair!;
  assert.equal(ctx.consistency?.defectClass, GENERATED_PARSER_CONSISTENCY_DEFECT_CLASS);
  assert.deepEqual([...ctx.consistency!.expectedGeneratedTables], [GP_EXPECTED_TABLE]);
  const text = ctx.guidance.join("\n");
  assert.ok(text.includes(GENERATED_PARSER_CONSISTENCY_DEFECT_CLASS));
  assert.ok(text.includes(GP_EXPECTED_TABLE));
  assert.ok(/update\/regenerate the corresponding generated parser table/.test(text));
  assert.ok(/do not delete generated parser tables/.test(text));
  assert.ok(/do not relocate productions into unrelated parser functions such as p_combined_units/.test(text));
});

// 6 & 7. The report JSON includes the generatedParserConsistency* fields and the Markdown includes
// the consistency guidance, when a live generated-parser repair ran on a parser patch.
test("buildRepairReport: generated-parser consistency fields in JSON + consistency guidance in Markdown", async () => {
  const gate = gpGate({ dryRun: false, enablePatchRepair: true, allowGeneratedParserRepair: true });
  const m = mockCaller();
  const outcome = await runGatedRepair({
    candidates: [gpCandidate({ firstPatch: GP_FIRST_PATCH_BROAD })],
    gate,
    caller: m.caller,
    repairModel: null,
  });
  const report = buildRepairReport({ generatedAt: null, enabled: true, gate, outcome });

  // 6. JSON consistency fields.
  const parsed = JSON.parse(renderJson(report));
  const gpRun = parsed.generatedParser.runs[0];
  for (const field of [
    "generatedParserConsistencyRisk",
    "generatedParserConsistencyDefectClass",
    "generatedParserConsistencyExpectedTables",
    "generatedParserConsistencyReasons",
    "generatedParserConsistencyGuidanceIncluded",
  ]) {
    assert.ok(field in gpRun, `missing consistency field ${field}`);
  }
  assert.equal(gpRun.generatedParserConsistencyRisk, true);
  assert.equal(gpRun.generatedParserConsistencyDefectClass, GENERATED_PARSER_CONSISTENCY_DEFECT_CLASS);
  assert.deepEqual(gpRun.generatedParserConsistencyExpectedTables, [GP_EXPECTED_TABLE]);
  assert.equal(gpRun.generatedParserConsistencyGuidanceIncluded, true);

  // 7. Markdown consistency guidance.
  const md = renderMarkdown(report);
  assert.ok(md.includes("consistency guidance (update the generated parser table when the source grammar changes)"));
  assert.ok(md.includes(GENERATED_PARSER_CONSISTENCY_DEFECT_CLASS));
  assert.ok(md.includes(GP_EXPECTED_TABLE));
});

// 8 & 9. Existing dry-run eligibility and live gates remain unchanged when consistency context is
// present: dry-run still calls no model and reports wouldRepair; live still runs EXACTLY ONE attempt.
test("consistency context does not change dry-run eligibility or the one-attempt live gate", async () => {
  // Dry-run: no model, wouldRepair=true (unchanged).
  const mDry = mockCaller();
  const dry = await runGatedRepair({
    candidates: [gpCandidate({ firstPatch: GP_FIRST_PATCH_BROAD })],
    gate: gpGate({ dryRun: true, allowGeneratedParserRepair: true }),
    caller: mDry.caller,
    repairModel: null,
  });
  assert.equal(mDry.calls, 0);
  assert.equal(dry.decisions[0]!.wouldRepair, true);
  assert.equal(dry.decisions[0]!.repaired, false);

  // Live: exactly one bounded attempt (unchanged).
  const mLive = mockCaller();
  const live = await runGatedRepair({
    candidates: [gpCandidate({ firstPatch: GP_FIRST_PATCH_BROAD })],
    gate: gpGate({ dryRun: false, enablePatchRepair: true, allowGeneratedParserRepair: true }),
    caller: mLive.caller,
    repairModel: null,
  });
  assert.equal(mLive.calls, 1);
  assert.equal(live.counters.repairCallsAttempted, 1);
});

// ---------------------------------------------------------------------------
// Cost-cap enforcement — root-cause fix for the single-call overrun.
// ---------------------------------------------------------------------------

// parseArgs: estimated-max is the default; "none" opts back to cumulative-only; numerics validated.
test("parseArgs: --repair-estimated-max-call-cost-usd defaults on, accepts none, validates", () => {
  const def = parseArgs([]);
  assert.equal(def.repairEstimatedMaxCallCostUsd, DEFAULT_REPAIR_ESTIMATED_MAX_CALL_COST_USD);
  assert.equal(parseArgs(["--repair-estimated-max-call-cost-usd", "1.5"]).repairEstimatedMaxCallCostUsd, 1.5);
  assert.equal(parseArgs(["--repair-estimated-max-call-cost-usd", "none"]).repairEstimatedMaxCallCostUsd, null);
  assert.throws(() => parseArgs(["--repair-estimated-max-call-cost-usd", "-1"]), /non-negative number or "none"/);
});

// 5. enforcement mode is determined by whether a per-call estimate is configured.
test("repairCostCapEnforcementMode + singleCallMayExceedCap reflect the configured estimate", () => {
  assert.equal(repairCostCapEnforcementMode(3), "pre_call_estimated_max");
  assert.equal(repairCostCapEnforcementMode(null), "pre_call_cumulative_only");
  assert.equal(repairCostCapEnforcementMode(undefined), "pre_call_cumulative_only");
  assert.equal(singleCallMayExceedCap("pre_call_cumulative_only"), true);
  assert.equal(singleCallMayExceedCap("pre_call_estimated_max"), false);
});

// 1/2. pre-call decision: cumulative-only never bounds the first call; estimated-max does.
test("evaluateCostCapPreCall: cumulative-only allows an unbounded first call; estimated-max skips it", () => {
  // ROOT CAUSE reproduction: cumulative-only with prior=0 ALLOWS the call even though the cap is tiny.
  const cumulativeFirst = evaluateCostCapPreCall({
    mode: "pre_call_cumulative_only",
    preCallCumulativeCostUsd: 0,
    repairCostCapUsd: 0.4,
    estimatedMaxCallCostUsd: null,
  });
  assert.equal(cumulativeFirst.allowed, true); // the bug: first call is NOT bounded
  assert.equal(cumulativeFirst.stoppedByCostCap, false);

  // 1. cumulative-only skips once accumulated prior cost has reached the cap.
  const cumulativeAfter = evaluateCostCapPreCall({
    mode: "pre_call_cumulative_only",
    preCallCumulativeCostUsd: 0.5,
    repairCostCapUsd: 0.4,
    estimatedMaxCallCostUsd: null,
  });
  assert.equal(cumulativeAfter.allowed, false);
  assert.equal(cumulativeAfter.stoppedByCostCap, true);

  // 2. estimated-max SKIPS the first call when the estimate cannot fit the remaining cap.
  const estSkip = evaluateCostCapPreCall({
    mode: "pre_call_estimated_max",
    preCallCumulativeCostUsd: 0,
    repairCostCapUsd: 0.4,
    estimatedMaxCallCostUsd: 3.0, // 0 + 3.0 > 0.4 ⇒ skip
  });
  assert.equal(estSkip.allowed, false);
  assert.equal(estSkip.stoppedByCostCap, true);
  assert.match(estSkip.reason, /pre_call_estimated_max/);

  // estimated-max ALLOWS a call whose estimate fits the remaining cap.
  const estAllow = evaluateCostCapPreCall({
    mode: "pre_call_estimated_max",
    preCallCumulativeCostUsd: 0,
    repairCostCapUsd: 0.5,
    estimatedMaxCallCostUsd: 0.3, // 0 + 0.3 <= 0.5 ⇒ allow
  });
  assert.equal(estAllow.allowed, true);
  assert.equal(estAllow.stoppedByCostCap, false);
});

// 2/3. runGatedRepair in estimated-max mode SKIPS the call and records repairStoppedByCostCap=true.
test("runGatedRepair: estimated-max skips the call when the estimate cannot fit the cap", async () => {
  const candidates = [candidateFor({ runLabel: "run-a" })];
  const m = mockCaller({ costUsd: 2.8185 }); // would be a huge overrun if it ran
  const { decisions, counters } = await runGatedRepair({
    candidates,
    gate: gateOf({
      runLabels: ["run-a"],
      maxRepairRuns: 1,
      repairCostCapUsd: 0.4,
      repairEstimatedMaxCallCostUsd: 3.0, // estimated worst-case > cap ⇒ skip pre-call
    }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 0); // 9. NO model/repair call occurred
  assert.equal(counters.repairCallsAttempted, 0);
  assert.equal(counters.stoppedByCostCap, 1);
  assert.equal(counters.totalRepairCostUsd, 0);
  const d = decisions[0]!;
  assert.equal(d.skipReason, "cost-cap");
  // 3. per-run cost-cap context records the stop.
  assert.equal(d.costCap?.repairStoppedByCostCap, true);
  assert.equal(d.costCap?.repairCostCapEnforcementMode, "pre_call_estimated_max");
  assert.equal(d.costCap?.singleCallMayExceedCap, false);
  assert.equal(d.costCap?.repairActualCostUsd, null);
});

// estimated-max ALLOWS the call when the cap is wide enough to absorb the estimate.
test("runGatedRepair: estimated-max allows the call when the cap covers the estimate", async () => {
  const candidates = [candidateFor({ runLabel: "run-a" })];
  const m = mockCaller({ costUsd: 0.2 });
  const { decisions, counters } = await runGatedRepair({
    candidates,
    gate: gateOf({
      runLabels: ["run-a"],
      maxRepairRuns: 1,
      repairCostCapUsd: 1.0,
      repairEstimatedMaxCallCostUsd: 0.3, // 0 + 0.3 <= 1.0 ⇒ allowed
    }),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 1);
  assert.equal(counters.repairCallsAttempted, 1);
  assert.equal(counters.stoppedByCostCap, 0);
  assert.equal(decisions[0]!.costCap?.repairExceededCap, false);
});

// 4. cumulative-only historical over-cap: the call runs and the report records repairExceededCap=true.
test("runGatedRepair: cumulative-only records a single-call over-cap overrun honestly", async () => {
  const candidates = [candidateFor({ runLabel: "run-a" })];
  const m = mockCaller({ costUsd: 2.8185 }); // mirrors the historical generated-parser overrun
  const gate = gateOf({
    runLabels: ["run-a"],
    maxRepairRuns: 1,
    repairCostCapUsd: 0.4,
    repairEstimatedMaxCallCostUsd: null, // cumulative-only (honest weak fallback)
  });
  const outcome = await runGatedRepair({ candidates, gate, caller: m.caller, repairModel: null });
  assert.equal(m.calls, 1); // the unbounded first call ran
  const d = outcome.decisions[0]!;
  assert.equal(d.repaired, true);
  assert.equal(d.costCap?.repairExceededCap, true); // 4. records the overrun
  assert.equal(d.costCap?.singleCallMayExceedCap, true);

  // 5. report carries the enforcement summary + mode.
  const report = buildRepairReport({ generatedAt: null, enabled: true, gate, outcome });
  assert.equal(report.costCapEnforcement.repairCostCapEnforcementMode, "pre_call_cumulative_only");
  assert.equal(report.costCapEnforcement.singleCallMayExceedCap, true);
  assert.equal(report.costCapEnforcement.repairExceededCap, true);
  assert.equal(report.costCapEnforcement.repairPreCallCumulativeCostUsd, 0); // the first call saw $0 prior
  assert.ok(Math.abs(report.costCapEnforcement.repairActualCostUsd - 2.8185) < 1e-9);

  // Markdown surfaces the mode + the cumulative-only warning.
  const md = renderMarkdown(report);
  assert.ok(md.includes("## Cost-cap enforcement"));
  assert.ok(md.includes("repairCostCapEnforcementMode | pre_call_cumulative_only"));
  assert.ok(md.includes("WARNING"));
  assert.ok(md.includes("singleCallMayExceedCap | true"));
});

// 8. existing default-path (wrong_scope/broad_rewrite) behavior is unchanged in cumulative-only mode.
test("runGatedRepair: cumulative-only default-path repair behavior is unchanged", async () => {
  const candidates = [candidateFor({ runLabel: "run-a" })];
  const m = mockCaller({ costUsd: 0.05 });
  const { counters, decisions } = await runGatedRepair({
    candidates,
    gate: gateOf({ runLabels: ["run-a"], repairCostCapUsd: 0.25 }), // no estimate ⇒ cumulative-only
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 1);
  assert.equal(counters.repairCallsAttempted, 1);
  assert.equal(decisions[0]!.repaired, true);
  assert.equal(decisions[0]!.costCap?.repairExceededCap, false); // 0.05 < 0.25
});
