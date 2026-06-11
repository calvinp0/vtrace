import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  type AccountingInputs,
  type ControlledTask,
  type Conversion,
  type CriticObservation,
  POLICY_SPECS,
  REPAIR_BOUNDARY,
  buildReport,
  computePolicyMetrics,
  loadAccountingInputs,
  parseArgs,
  parseConversion,
  parseControlledTasks,
  parseCriticObservations,
  parseStrictResults,
  pickRecommendation,
  pickStrictRepairRecommendation,
  renderJson,
  renderMarkdown,
} from "./run_stage5_policy_accounting";

// --- fixtures: a tiny 3-task controlled set (no filesystem, no agents) -------
// strict legs are populated: a resolves under strict, b/c do not. b is the OLD-VTRACE
// repair candidate (verified conversion exists) AND is unresolved under strict.
function tasks(): ControlledTask[] {
  return [
    // resolved by baseline, old vtrace, and strict
    { instanceId: "a", vtraceRunLabel: "eval-a", baselineResolved: true, vtraceResolved: true, baselineCostUsd: 0.2, vtraceCostUsd: 0.3, baselineTokens: 1000, vtraceTokens: 1500, strictRunLabel: "eval-strict-a", strictResolved: true, strictCostUsd: 0.25, strictTokens: 1200 },
    // baseline resolved, old vtrace regressed, strict still unresolved — repair candidate
    { instanceId: "b", vtraceRunLabel: "eval-b", baselineResolved: true, vtraceResolved: false, baselineCostUsd: 0.5, vtraceCostUsd: 0.6, baselineTokens: 2000, vtraceTokens: 2500, strictRunLabel: "eval-strictgated-vtrace-b", strictResolved: false, strictCostUsd: 0.2, strictTokens: 1000 },
    // unresolved everywhere
    { instanceId: "c", vtraceRunLabel: "eval-c", baselineResolved: false, vtraceResolved: false, baselineCostUsd: 0.1, vtraceCostUsd: 0.4, baselineTokens: 800, vtraceTokens: 1800, strictRunLabel: "eval-strict-c", strictResolved: false, strictCostUsd: 0.15, strictTokens: 900 },
  ];
}

// 4-task narrative fixture where strict IMPROVES over old VTRACE (+1) AND remains one
// resolved task behind baseline, with strict using fewer tokens / lower cost than baseline.
function narrativeTasks(): ControlledTask[] {
  return [
    { instanceId: "a", vtraceRunLabel: "eval-a", baselineResolved: true, vtraceResolved: true, baselineCostUsd: 0.2, vtraceCostUsd: 0.3, baselineTokens: 1000, vtraceTokens: 1500, strictRunLabel: "eval-strict-a", strictResolved: true, strictCostUsd: 0.25, strictTokens: 1200 },
    { instanceId: "b", vtraceRunLabel: "eval-b", baselineResolved: true, vtraceResolved: false, baselineCostUsd: 0.5, vtraceCostUsd: 0.6, baselineTokens: 2000, vtraceTokens: 2500, strictRunLabel: "eval-strictgated-vtrace-b", strictResolved: false, strictCostUsd: 0.2, strictTokens: 1000 },
    { instanceId: "c", vtraceRunLabel: "eval-c", baselineResolved: false, vtraceResolved: false, baselineCostUsd: 0.1, vtraceCostUsd: 0.4, baselineTokens: 800, vtraceTokens: 1800, strictRunLabel: "eval-strict-c", strictResolved: true, strictCostUsd: 0.15, strictTokens: 900 },
    { instanceId: "d", vtraceRunLabel: "eval-d", baselineResolved: true, vtraceResolved: false, baselineCostUsd: 0.3, vtraceCostUsd: 0.35, baselineTokens: 1000, vtraceTokens: 1200, strictRunLabel: "eval-strict-d", strictResolved: false, strictCostUsd: 0.18, strictTokens: 700 },
  ];
}
function narrativeInputs(overrides: Partial<AccountingInputs> = {}): AccountingInputs {
  return { tasks: narrativeTasks(), conversions: [verifiedConversion()], criticObservations: [], ...overrides };
}

function verifiedConversion(): Conversion {
  return {
    runLabel: "eval-b-repair",
    instanceId: "b",
    firstPatchResolved: false,
    repairedPatchResolved: true,
    convertedUnresolvedToResolved: true,
    criticCostUsd: 0.12,
    repairCostUsd: 0.2,
    criticInputTokens: 4000,
    criticOutputTokens: 2000,
    repairInputTokens: 6000,
    repairOutputTokens: 1400,
    totalRecoveryCostUsd: 0.32,
  };
}

function unverifiedConversion(): Conversion {
  return { ...verifiedConversion(), instanceId: "c", runLabel: "eval-c-repair", repairedPatchResolved: false, convertedUnresolvedToResolved: false };
}

function criticObs(): CriticObservation[] {
  return [{ instanceId: "b", runCount: 2, meanCostUsd: 0.1, meanInputTokens: 4000, meanOutputTokens: 1800 }];
}

function inputs(overrides: Partial<AccountingInputs> = {}): AccountingInputs {
  return { tasks: tasks(), conversions: [verifiedConversion()], criticObservations: criticObs(), ...overrides };
}

function policy(name: string, inp: AccountingInputs) {
  const spec = POLICY_SPECS.find((s) => s.policyName === name)!;
  return computePolicyMetrics(spec, inp);
}

// ---------------------------------------------------------------------------
// 1. strict_vtrace_first_patch is a first-class policy row.
// ---------------------------------------------------------------------------
test("adds strict_vtrace_first_patch as a policy row", () => {
  const names = POLICY_SPECS.map((s) => s.policyName);
  for (const required of ["baseline", "old_vtrace_first_patch", "old_vtrace_with_verified_repair", "strict_vtrace_first_patch"]) {
    assert.ok(names.includes(required), `missing required policy ${required}`);
  }
  const strict = POLICY_SPECS.find((s) => s.policyName === "strict_vtrace_first_patch")!;
  // strict reads the strict leg and applies NO repair conversions.
  assert.equal(strict.resolutionBasis, "strict");
  assert.equal(strict.costBasis, "strict");
  assert.equal(strict.tokenBasis, "strict");
  assert.equal(strict.applyConversions, false);
  assert.equal(strict.addVerifiedRecoveryCost, false);
});

// ---------------------------------------------------------------------------
// 2. Computes strict cost/tokens per resolved.
// ---------------------------------------------------------------------------
test("computes strict cost/tokens per resolved from the strict leg", () => {
  const inp = inputs();
  const strict = policy("strict_vtrace_first_patch", inp);
  assert.equal(strict.resolvedCount, 1); // only a
  // strict agent cost = 0.25 + 0.2 + 0.15 = 0.6; no critic/repair added.
  assert.ok(Math.abs((strict.totalCostUsd ?? 0) - 0.6) < 1e-9);
  assert.equal(strict.criticCostUsd, null);
  assert.equal(strict.repairCostUsd, null);
  assert.ok(Math.abs((strict.costPerResolved ?? 0) - 0.6) < 1e-9);
  // strict tokens = 1200 + 1000 + 900 = 3100; /1 resolved.
  assert.equal(strict.totalTokens, 3100);
  assert.equal(strict.tokensPerResolved, 3100);
});

// ---------------------------------------------------------------------------
// 3. Compares strict against old VTRACE and baseline.
// ---------------------------------------------------------------------------
test("compares strict against old VTRACE and baseline (deltas + statements)", () => {
  const report = buildReport({ generatedAt: "t", inputs: narrativeInputs() });
  const sa = report.strictAccounting;
  assert.equal(sa.strictResolved, 2); // a, c
  assert.equal(sa.oldVtraceResolved, 1); // a
  assert.equal(sa.baselineResolved, 3); // a, b, d
  assert.equal(sa.resolutionDeltaVsOldVtrace, 1); // strict improves over old VTRACE
  assert.equal(sa.resolutionDeltaVsBaseline, -1); // one behind baseline
  assert.equal(sa.improvesOverOldVtrace, true);
  assert.equal(sa.behindBaselineBy, 1);
  assert.equal(sa.fewerTokensThanBaseline, true);
  assert.equal(sa.lowerCostThanBaseline, true);

  // per-policy deltas are attached to the policy rows
  const strict = report.policies.find((p) => p.policyName === "strict_vtrace_first_patch")!;
  assert.equal(strict.resolutionDeltaVsOldVtrace, 1);
  assert.equal(strict.resolutionDeltaVsBaseline, -1);

  const md = renderMarkdown(report);
  assert.ok(md.includes("## Strict-gated first-pass accounting"));
  assert.ok(md.includes("strict_vtrace_first_patch improves over old_vtrace_first_patch"));
  assert.ok(md.includes("resolved 1/4 → 2/4"));
  assert.ok(md.includes("strict_vtrace_first_patch remains one resolved task behind baseline"));
  assert.ok(md.includes("strict 2/4 vs baseline 3/4"));
  assert.ok(md.includes("lower total cost does not imply higher success rate"));
});

// ---------------------------------------------------------------------------
// 4. Does NOT apply old repair conversions to strict.
// ---------------------------------------------------------------------------
test("does not apply old repair conversions to strict", () => {
  const inp = inputs(); // verified conversion for instance b
  const strict = policy("strict_vtrace_first_patch", inp);
  // b has a verified OLD-VTRACE conversion but strictResolved=false → strict stays unresolved.
  assert.equal(strict.resolvedCount, 1); // only a, NOT a+b
  assert.equal(strict.taskConversionCount, 0);
  assert.equal(strict.artifactConversionCount, 0);
  assert.equal(strict.criticCostUsd, null);
  assert.equal(strict.repairCostUsd, null);
});

// ---------------------------------------------------------------------------
// 5. Keeps old_vtrace_with_verified_repair separate (the old repair lives there).
// ---------------------------------------------------------------------------
test("keeps old_vtrace_with_verified_repair separate from strict", () => {
  const inp = inputs();
  const oldRepair = policy("old_vtrace_with_verified_repair", inp);
  assert.equal(oldRepair.resolvedCount, 2); // a + b (converted)
  assert.equal(oldRepair.taskConversionCount, 1);
  assert.equal(oldRepair.criticCostUsd, 0.12);
  assert.equal(oldRepair.repairCostUsd, 0.2);
  // strict carries none of that recovery
  const strict = policy("strict_vtrace_first_patch", inp);
  assert.equal(strict.criticCostUsd, null);
  assert.equal(strict.repairCostUsd, null);
  // there is NO strict repair policy row
  assert.equal(POLICY_SPECS.some((s) => s.policyName === "strict_with_repair"), false);
});

// ---------------------------------------------------------------------------
// 6. Emits the repair-boundary caution.
// ---------------------------------------------------------------------------
test("emits the repair-boundary caution", () => {
  const report = buildReport({ generatedAt: "t", inputs: inputs() });
  assert.ok(report.repairBoundary.some((s) => /tied to the old VTRACE first patches/.test(s)));
  const md = renderMarkdown(report);
  assert.ok(md.includes("## Repair accounting boundary"));
  assert.ok(md.includes("Verified old repair conversions are tied to the old VTRACE first patches. They are not automatically counted as strict repairs unless strict-specific repaired-patch evaluation exists."));
  assert.ok(md.includes("`old_vtrace_with_verified_repair`"));
  assert.ok(!md.includes("strict_with_repair") || md.includes("never under a `strict_with_repair` row"));
});

// ---------------------------------------------------------------------------
// 7. Recommends strict-specific Requests repair ONLY when strict Requests is unresolved.
// ---------------------------------------------------------------------------
test("recommends a strict-specific repair only for an unresolved-under-strict task with verified old evidence", () => {
  const requestsUnresolved: ControlledTask = {
    instanceId: "psf__requests-5414", vtraceRunLabel: "eval-requests", baselineResolved: true, vtraceResolved: false,
    baselineCostUsd: 0.4, vtraceCostUsd: 0.4, baselineTokens: 900, vtraceTokens: 950,
    strictRunLabel: "eval-strictgated-vtrace-requests-5414", strictResolved: false, strictCostUsd: 0.3, strictTokens: 800,
  };
  const conv: Conversion = { ...verifiedConversion(), instanceId: "psf__requests-5414", runLabel: "eval-patchverify-before-requests-5414" };

  const rec = pickStrictRepairRecommendation({ tasks: [requestsUnresolved], conversions: [conv] });
  assert.equal(rec.recommend, true);
  assert.equal(rec.targets[0]!.instanceId, "psf__requests-5414");
  assert.ok(rec.statement.includes("eval-strictgated-vtrace-requests-5414"));
  assert.ok(/Requests remains unresolved under strict/.test(rec.statement));
  assert.ok(/recoverable/.test(rec.statement));

  // When strict Requests is RESOLVED, no strict-specific repair is recommended.
  const resolvedReq: ControlledTask = { ...requestsUnresolved, strictResolved: true };
  const none = pickStrictRepairRecommendation({ tasks: [resolvedReq], conversions: [conv] });
  assert.equal(none.recommend, false);
  assert.ok(!none.statement.includes("eval-strictgated-vtrace-requests-5414"));

  // Unresolved under strict but NO verified old evidence → not recommended (no duplicate hunts).
  const noEvidence = pickStrictRepairRecommendation({ tasks: [requestsUnresolved], conversions: [] });
  assert.equal(noEvidence.recommend, false);
});

test("the strict recommendation does not propose full reruns or duplicate old repair experiments", () => {
  const report = buildReport({ generatedAt: "t", inputs: inputs() });
  // b is unresolved under strict and has a verified conversion → recommend strict-specific repair for b.
  assert.equal(report.strictRecommendation.recommend, true);
  assert.ok(report.strictRecommendation.statement.includes("eval-strictgated-vtrace-b"));
  assert.ok(/do NOT trigger a full 10-task rerun/i.test(report.strictRecommendation.rationale));
  assert.ok(/do NOT re-run already-recovered old repair experiments/i.test(report.strictRecommendation.rationale));
});

// ---------------------------------------------------------------------------
// 8. Emits required Markdown sections.
// ---------------------------------------------------------------------------
test("emits required Markdown sections", () => {
  const md = renderMarkdown(buildReport({ generatedAt: "t", inputs: inputs() }));
  for (const section of [
    "# Stage 5 policy accounting",
    "## Summary",
    "## Policies compared",
    "## Resolution results",
    "## Cost accounting",
    "## Token accounting",
    "## Cost per resolved task",
    "## Token per resolved task",
    "## Strict-gated first-pass accounting",
    "## Repair accounting boundary",
    "## Recommended next step",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(section), `missing section ${section}`);
  }
});

// ---------------------------------------------------------------------------
// 9. Emits required JSON fields.
// ---------------------------------------------------------------------------
test("emits required JSON fields", () => {
  const report = buildReport({ generatedAt: "t", inputs: inputs() });
  const json = JSON.parse(renderJson(report));
  for (const key of ["generatedAt", "summary", "strictAccounting", "policies", "tasks", "conversions", "costSources", "tokenSources", "strictRecommendation", "recommendation", "repairBoundary", "nonClaims"]) {
    assert.ok(key in json, `missing key ${key}`);
  }
  // every required policy row is present by name
  const names = json.policies.map((p: { policyName: string }) => p.policyName);
  for (const required of ["baseline", "old_vtrace_first_patch", "old_vtrace_with_verified_repair", "strict_vtrace_first_patch"]) {
    assert.ok(names.includes(required), `policies missing ${required}`);
  }
  // policy entry fields: counts + per-resolved + the six deltas.
  const p0 = json.policies[0];
  for (const key of [
    "policyName", "taskCount", "resolvedCount", "unresolvedCount", "unknownCount",
    "totalCostUsd", "meanCostUsd", "costPerResolved", "totalTokens", "meanTokens", "tokensPerResolved",
    "resolutionDeltaVsBaseline", "tokensDeltaVsBaseline", "costDeltaVsBaseline",
    "resolutionDeltaVsOldVtrace", "tokensDeltaVsOldVtrace", "costDeltaVsOldVtrace",
  ]) {
    assert.ok(key in p0, `policy missing ${key}`);
  }
  // strictAccounting required quantities
  for (const key of [
    "strictResolved", "oldVtraceResolved", "baselineResolved",
    "strictTotalTokens", "strictTotalCostUsd", "strictCostPerResolved", "strictTokensPerResolved",
    "resolutionDeltaVsOldVtrace", "tokensDeltaVsOldVtrace", "costDeltaVsOldVtrace",
    "resolutionDeltaVsBaseline", "tokensDeltaVsBaseline", "costDeltaVsBaseline",
  ]) {
    assert.ok(key in json.strictAccounting, `strictAccounting missing ${key}`);
  }
  // summary exposes strict + old resolution
  for (const key of ["oldVtraceFirstPatchResolved", "strictVtraceFirstPatchResolved", "verifiedRepairArtifacts", "uniqueTaskConversions"]) {
    assert.ok(key in json.summary, `summary missing ${key}`);
  }
  // task rows carry the strict leg
  for (const key of ["strictResolved", "strictCostUsd", "strictTokens"]) {
    assert.ok(key in json.tasks[0], `task missing ${key}`);
  }
  // strict recommendation shape
  for (const key of ["recommend", "targets", "statement", "rationale"]) {
    assert.ok(key in json.strictRecommendation, `strictRecommendation missing ${key}`);
  }
  assert.equal(json.policies.length, 6);
});

// ---------------------------------------------------------------------------
// Carried-over computation tests (renamed policies)
// ---------------------------------------------------------------------------
test("computes resolved count per policy", () => {
  const inp = inputs();
  assert.equal(policy("baseline", inp).resolvedCount, 2); // a, b
  assert.equal(policy("old_vtrace_first_patch", inp).resolvedCount, 1); // a
  assert.equal(policy("strict_vtrace_first_patch", inp).resolvedCount, 1); // a (strict)
  assert.equal(policy("old_vtrace_with_observed_gated_repair", inp).resolvedCount, 2); // a + b (converted)
  assert.equal(policy("old_vtrace_with_verified_repair", inp).resolvedCount, 2);
});

test("applies a verified conversion to the old repaired policy", () => {
  const inp = inputs();
  const gated = policy("old_vtrace_with_observed_gated_repair", inp);
  assert.equal(gated.taskConversionCount, 1);
  assert.equal(gated.artifactConversionCount, 1);
  assert.equal(gated.resolvedCount, 2);
  assert.equal(gated.criticCostUsd, null);
  assert.equal(gated.repairCostUsd, null);
  assert.ok(Math.abs((gated.totalCostUsd ?? 0) - (0.3 + 0.6 + 0.4)) < 1e-9);
});

test("does not apply unverified repair artifacts", () => {
  const inp = inputs({ conversions: [unverifiedConversion()] });
  const gated = policy("old_vtrace_with_observed_gated_repair", inp);
  assert.equal(gated.taskConversionCount, 0);
  assert.equal(gated.artifactConversionCount, 0);
  assert.equal(gated.resolvedCount, 1); // only a; c stays unresolved
  const verified = policy("old_vtrace_with_verified_repair", inp);
  assert.equal(verified.repairCostUsd, null); // no recovery cost added for unverified
});

test("separates agent, critic, and repair cost", () => {
  const inp = inputs();
  const verified = policy("old_vtrace_with_verified_repair", inp);
  assert.ok(Math.abs((verified.agentCostUsd ?? 0) - (0.3 + 0.6 + 0.4)) < 1e-9);
  assert.equal(verified.criticCostUsd, 0.12); // from the verified conversion only
  assert.equal(verified.repairCostUsd, 0.2);
  assert.equal(verified.criticInputTokens, 4000);
  assert.equal(verified.repairOutputTokens, 1400);
  assert.ok(Math.abs((verified.totalCostUsd ?? 0) - (1.3 + 0.12 + 0.2)) < 1e-9);

  const obs = policy("old_vtrace_with_live_critic_observation_cost", inp);
  assert.equal(obs.repairCostUsd, null);
  assert.equal(obs.criticCostUsd, 0.1); // mean observation for instance b
  assert.equal(obs.resolvedCount, 1); // unchanged
  assert.equal(obs.taskConversionCount, 0);
});

test("computes costPerResolved and tokensPerResolved", () => {
  const inp = inputs();
  const old = policy("old_vtrace_first_patch", inp);
  assert.ok(Math.abs((old.costPerResolved ?? 0) - 1.3) < 1e-9);
  assert.equal(old.tokensPerResolved, 1500 + 2500 + 1800); // /1
  const verified = policy("old_vtrace_with_verified_repair", inp);
  assert.ok(Math.abs((verified.costPerResolved ?? 0) - 0.81) < 1e-9); // 1.62 / 2
});

test("handles missing cost/token fields (incl. strict) with null", () => {
  const nullTask: ControlledTask = { instanceId: "z", vtraceRunLabel: null, baselineResolved: null, vtraceResolved: null, baselineCostUsd: null, vtraceCostUsd: null, baselineTokens: null, vtraceTokens: null, strictRunLabel: null, strictResolved: null, strictCostUsd: null, strictTokens: null };
  const inp: AccountingInputs = { tasks: [nullTask], conversions: [], criticObservations: [] };
  const strict = policy("strict_vtrace_first_patch", inp);
  assert.equal(strict.resolvedCount, 0);
  assert.equal(strict.unknownCount, 1);
  assert.equal(strict.totalCostUsd, null);
  assert.equal(strict.costPerResolved, null);
  assert.equal(strict.totalTokens, null);
  assert.equal(strict.tokensPerResolved, null);
});

// --- artifact-vs-task conversion distinction (old repair) ---------------------
function duplicateArtifacts(): Conversion[] {
  return [
    { ...verifiedConversion(), runLabel: "eval-patchverify-before-b" },
    { ...verifiedConversion(), runLabel: "eval-editguard-before-b" },
  ];
}

test("duplicate converted artifacts on one instance: many artifacts, one task conversion", () => {
  const inp = inputs({ conversions: duplicateArtifacts() });
  const gated = policy("old_vtrace_with_observed_gated_repair", inp);
  assert.equal(gated.artifactConversionCount, 2);
  assert.equal(gated.taskConversionCount, 1);
  assert.equal(gated.resolvedCount, 2);
  const verified = policy("old_vtrace_with_verified_repair", inp);
  assert.equal(verified.criticCostUsd, 0.12); // counted once per unique task
  assert.equal(verified.repairCostUsd, 0.2);
});

test("repair artifact table lists all artifact conversions under the boundary section", () => {
  const report = buildReport({ generatedAt: "t", inputs: inputs({ conversions: duplicateArtifacts() }) });
  assert.equal(report.conversions.length, 2);
  const md = renderMarkdown(report);
  assert.ok(md.includes("## Repair accounting boundary"));
  assert.ok(md.includes("eval-patchverify-before-b"));
  assert.ok(md.includes("eval-editguard-before-b"));
});

test("summary exposes both artifact and unique-task conversion counts", () => {
  const report = buildReport({ generatedAt: "t", inputs: inputs({ conversions: duplicateArtifacts() }) });
  assert.equal(report.summary.verifiedRepairArtifacts, 2);
  assert.equal(report.summary.uniqueTaskConversions, 1);
  assert.deepEqual(report.uniqueTaskRecoveries, ["b"]);
});

// --- OLD-VTRACE repair-experiment recommendation (separate track) -------------
test("old repair recommendation: B when no verified conversion", () => {
  const rec = pickRecommendation({ vtraceFirstPatch: policy("old_vtrace_first_patch", inputs({ conversions: [] })), verifiedRepair: policy("old_vtrace_with_verified_repair", inputs({ conversions: [] })) });
  assert.equal(rec.choice, "B");
});

test("old repair recommendation: C when one verified conversion improves cost-per-resolved", () => {
  const inp = inputs();
  const rec = pickRecommendation({ vtraceFirstPatch: policy("old_vtrace_first_patch", inp), verifiedRepair: policy("old_vtrace_with_verified_repair", inp) });
  assert.equal(rec.choice, "C");
});

test("old repair recommendation: D when duplicate artifacts add no new unique task conversion", () => {
  const inp = inputs({ conversions: duplicateArtifacts() });
  const rec = pickRecommendation({ vtraceFirstPatch: policy("old_vtrace_first_patch", inp), verifiedRepair: policy("old_vtrace_with_verified_repair", inp) });
  assert.equal(rec.choice, "D");
  assert.ok(/duplicate/i.test(rec.statement));
});

// --- parsing of real artifact shapes -----------------------------------------
test("parses controlled tasks joined with strict results by instanceId", () => {
  const strict = parseStrictResults({
    tasks: [
      { instanceId: "a", strictLabel: "eval-strictgated-vtrace-a", strict: { resolved: true, costUsd: 0.25, totalTokens: 1200 } },
      { instanceId: "b", strictLabel: "eval-strictgated-vtrace-b", strict: null },
    ],
  });
  assert.equal(strict.length, 2);
  assert.equal(strict[0]!.resolved, true);
  assert.equal(strict[0]!.tokens, 1200);
  assert.equal(strict[1]!.resolved, null); // null strict leg → genuinely absent

  const byInstance = new Map(strict.map((s) => [s.instanceId, s]));
  const t = parseControlledTasks(
    { selectedTasks: [{ instanceId: "a", vtraceRunLabel: "eval-a", baselineResolved: true, vtraceResolved: false, baselineCost: 0.2, vtraceCost: 0.3, baselineTokens: 10, vtraceTokens: 20 }] },
    byInstance,
  );
  assert.equal(t[0]!.instanceId, "a");
  assert.equal(t[0]!.vtraceResolved, false);
  assert.equal(t[0]!.strictResolved, true);
  assert.equal(t[0]!.strictTokens, 1200);
  assert.equal(t[0]!.strictRunLabel, "eval-strictgated-vtrace-a");
});

test("parseControlledTasks leaves strict legs null when no strict result is joined", () => {
  const t = parseControlledTasks({ selectedTasks: [{ instanceId: "a", baselineResolved: true }] });
  assert.equal(t[0]!.strictResolved, null);
  assert.equal(t[0]!.strictTokens, null);
  assert.equal(t[0]!.strictRunLabel, null);
});

test("parses conversion and critic observations from doc shapes", () => {
  const conv = parseConversion({ runLabel: "r", instanceId: "a", conversion: { firstPatchResolved: false, repairedPatchResolved: true, convertedUnresolvedToResolved: true }, costs: { criticCostUsd: 0.1, repairCostUsd: 0.2, totalCriticRepairCostUsd: 0.3 } });
  assert.equal(conv?.convertedUnresolvedToResolved, true);
  assert.equal(conv?.totalRecoveryCostUsd, 0.3);

  const obs = parseCriticObservations({ runs: [{ instanceId: "a", criticCostUsd: 0.1, criticInputTokens: 100, criticOutputTokens: 50 }, { instanceId: "a", criticCostUsd: 0.3, criticInputTokens: 300, criticOutputTokens: 150 }] });
  assert.equal(obs[0]!.runCount, 2);
  assert.ok(Math.abs((obs[0]!.meanCostUsd ?? 0) - 0.2) < 1e-9);
});

test("REPAIR_BOUNDARY carries the strict/old separation caution", () => {
  assert.ok(REPAIR_BOUNDARY.some((s) => /not automatically counted as strict repairs/.test(s)));
  assert.ok(REPAIR_BOUNDARY.some((s) => /old_vtrace_with_verified_repair/.test(s)));
});

// 10. No Docker / model / agent in tests — loader fails clearly when plan missing.
test("loader fails clearly when the controlled plan is missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "policy-acct-"));
  try {
    await assert.rejects(() => loadAccountingInputs(dir), /No controlled-task plan/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseArgs reads results and out-name", () => {
  const cfg = parseArgs(["--results", "r", "--out-name", "o"]);
  assert.equal(cfg.resultsDir, "r");
  assert.equal(cfg.outName, "o");
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});
