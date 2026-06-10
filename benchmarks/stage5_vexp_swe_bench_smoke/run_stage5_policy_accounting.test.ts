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
  buildReport,
  computePolicyMetrics,
  loadAccountingInputs,
  parseArgs,
  parseConversion,
  parseControlledTasks,
  parseCriticObservations,
  pickRecommendation,
  renderJson,
  renderMarkdown,
} from "./run_stage5_policy_accounting";

// --- fixtures: a tiny 3-task controlled set (no filesystem, no agents) -------
function tasks(): ControlledTask[] {
  return [
    // resolved by both baseline and vtrace
    { instanceId: "a", vtraceRunLabel: "eval-a", baselineResolved: true, vtraceResolved: true, baselineCostUsd: 0.2, vtraceCostUsd: 0.3, baselineTokens: 1000, vtraceTokens: 1500 },
    // baseline resolved, vtrace regressed (unresolved) — repair candidate
    { instanceId: "b", vtraceRunLabel: "eval-b", baselineResolved: true, vtraceResolved: false, baselineCostUsd: 0.5, vtraceCostUsd: 0.6, baselineTokens: 2000, vtraceTokens: 2500 },
    // unresolved by both
    { instanceId: "c", vtraceRunLabel: "eval-c", baselineResolved: false, vtraceResolved: false, baselineCostUsd: 0.1, vtraceCostUsd: 0.4, baselineTokens: 800, vtraceTokens: 1800 },
  ];
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

// 1. Computes resolved count per policy.
test("computes resolved count per policy", () => {
  const inp = inputs();
  assert.equal(policy("baseline", inp).resolvedCount, 2); // a, b
  assert.equal(policy("vtrace_first_patch", inp).resolvedCount, 1); // a
  assert.equal(policy("vtrace_with_observed_gated_repair", inp).resolvedCount, 2); // a + b (converted)
  assert.equal(policy("vtrace_with_verified_repair_cost", inp).resolvedCount, 2);
});

// 2. Applies a verified repair conversion to the repaired policy.
test("applies a verified conversion to the repaired policy", () => {
  const inp = inputs();
  const gated = policy("vtrace_with_observed_gated_repair", inp);
  assert.equal(gated.taskConversionCount, 1);
  assert.equal(gated.artifactConversionCount, 1);
  assert.equal(gated.resolvedCount, 2);
  // cost basis unchanged (optimistic ceiling): equals vtrace agent cost, no recovery added.
  assert.equal(gated.criticCostUsd, null);
  assert.equal(gated.repairCostUsd, null);
  assert.ok(Math.abs((gated.totalCostUsd ?? 0) - (0.3 + 0.6 + 0.4)) < 1e-9);
});

// 3. Does not apply unverified repair artifacts.
test("does not apply unverified repair artifacts", () => {
  const inp = inputs({ conversions: [unverifiedConversion()] });
  const gated = policy("vtrace_with_observed_gated_repair", inp);
  assert.equal(gated.taskConversionCount, 0);
  assert.equal(gated.artifactConversionCount, 0);
  assert.equal(gated.resolvedCount, 1); // only a; c stays unresolved
  const verified = policy("vtrace_with_verified_repair_cost", inp);
  assert.equal(verified.repairCostUsd, null); // no recovery cost added for unverified
});

// 4. Separates agent cost, critic cost, and repair cost.
test("separates agent, critic, and repair cost", () => {
  const inp = inputs();
  const verified = policy("vtrace_with_verified_repair_cost", inp);
  assert.ok(Math.abs((verified.agentCostUsd ?? 0) - (0.3 + 0.6 + 0.4)) < 1e-9);
  assert.equal(verified.criticCostUsd, 0.12); // from the verified conversion only
  assert.equal(verified.repairCostUsd, 0.2);
  assert.equal(verified.criticInputTokens, 4000);
  assert.equal(verified.repairOutputTokens, 1400);
  // total = agent + critic + repair
  assert.ok(Math.abs((verified.totalCostUsd ?? 0) - (1.3 + 0.12 + 0.2)) < 1e-9);

  // critic-observation policy adds critic cost but NOT repair, resolution unchanged.
  const obs = policy("vtrace_with_live_critic_observation_cost", inp);
  assert.equal(obs.repairCostUsd, null);
  assert.equal(obs.criticCostUsd, 0.1); // mean observation for instance b
  assert.equal(obs.resolvedCount, 1); // unchanged
  assert.equal(obs.taskConversionCount, 0);
  assert.equal(obs.artifactConversionCount, 0);
});

// 5. Computes costPerResolved and tokensPerResolved.
test("computes costPerResolved and tokensPerResolved", () => {
  const inp = inputs();
  const vtrace = policy("vtrace_first_patch", inp);
  // total cost 1.3 / resolved 1 = 1.3
  assert.ok(Math.abs((vtrace.costPerResolved ?? 0) - 1.3) < 1e-9);
  assert.equal(vtrace.tokensPerResolved, 1500 + 2500 + 1800); // /1
  const verified = policy("vtrace_with_verified_repair_cost", inp);
  // total 1.62 / resolved 2 = 0.81
  assert.ok(Math.abs((verified.costPerResolved ?? 0) - 0.81) < 1e-9);
});

// 6. Handles missing cost/token fields with null.
test("handles missing cost/token fields with null", () => {
  const nullTask: ControlledTask = { instanceId: "z", vtraceRunLabel: null, baselineResolved: null, vtraceResolved: null, baselineCostUsd: null, vtraceCostUsd: null, baselineTokens: null, vtraceTokens: null };
  const inp: AccountingInputs = { tasks: [nullTask], conversions: [], criticObservations: [] };
  const p = policy("vtrace_first_patch", inp);
  assert.equal(p.resolvedCount, 0);
  assert.equal(p.unknownCount, 1);
  assert.equal(p.totalCostUsd, null);
  assert.equal(p.costPerResolved, null); // resolvedCount 0
  assert.equal(p.totalTokens, null);
  assert.equal(p.tokensPerResolved, null);
});

test("costPerResolved is null when resolvedCount is zero", () => {
  const inp: AccountingInputs = {
    tasks: [{ instanceId: "x", vtraceRunLabel: null, baselineResolved: false, vtraceResolved: false, baselineCostUsd: 1, vtraceCostUsd: 1, baselineTokens: 10, vtraceTokens: 10 }],
    conversions: [],
    criticObservations: [],
  };
  const p = policy("vtrace_first_patch", inp);
  assert.equal(p.resolvedCount, 0);
  assert.equal(p.costPerResolved, null);
});

// 7. Emits required Markdown sections.
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
    "## Verified repair artifacts included",
    "## Unique task recoveries",
    "## Interpretation",
    "## Recommended next step",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(section), `missing section ${section}`);
  }
});

// 8. Emits required JSON fields.
test("emits required JSON fields", () => {
  const report = buildReport({ generatedAt: "t", inputs: inputs() });
  const json = JSON.parse(renderJson(report));
  for (const key of ["generatedAt", "summary", "policies", "tasks", "conversions", "costSources", "tokenSources", "recommendation", "nonClaims"]) {
    assert.ok(key in json, `missing key ${key}`);
  }
  // policy entry fields
  const p0 = json.policies[0];
  for (const key of ["policyName", "taskCount", "resolvedCount", "unknownCount", "totalCostUsd", "costPerResolved", "totalTokens", "tokensPerResolved", "artifactConversionCount", "taskConversionCount"]) {
    assert.ok(key in p0, `policy missing ${key}`);
  }
  // summary exposes BOTH artifact-level and task-level conversion counts
  for (const key of ["verifiedRepairArtifacts", "uniqueTaskConversions"]) {
    assert.ok(key in json.summary, `summary missing ${key}`);
  }
  assert.ok("uniqueTaskRecoveries" in json, "missing uniqueTaskRecoveries");
  // conversion entry fields
  const c0 = json.conversions[0];
  for (const key of ["runLabel", "instanceId", "firstPatchResolved", "repairedPatchResolved", "convertedUnresolvedToResolved", "criticCostUsd", "repairCostUsd", "totalRecoveryCostUsd"]) {
    assert.ok(key in c0, `conversion missing ${key}`);
  }
  assert.equal(json.policies.length, 5);
  assert.ok(["A", "B", "C", "D"].includes(json.recommendation.choice));
});

test("recommendation: B when no verified conversion", () => {
  const rec = recFor({ conversions: [] });
  assert.equal(rec.choice, "B");
});

test("recommendation: C when one verified conversion improves cost-per-resolved", () => {
  const rec = recFor({});
  assert.equal(rec.choice, "C");
});

test("recommendation: A when >=3 verified conversions improve cost-per-resolved", () => {
  // three verified conversions on b, c, and a-extra; all improve resolved count.
  const convs: Conversion[] = [
    { ...verifiedConversion(), instanceId: "b", runLabel: "r-b" },
    { ...verifiedConversion(), instanceId: "c", runLabel: "r-c" },
    { ...verifiedConversion(), instanceId: "d", runLabel: "r-d" },
  ];
  const extraTasks: ControlledTask[] = [
    ...tasks(),
    { instanceId: "d", vtraceRunLabel: "eval-d", baselineResolved: false, vtraceResolved: false, baselineCostUsd: 0.1, vtraceCostUsd: 0.1, baselineTokens: 100, vtraceTokens: 100 },
  ];
  const rec = pickRecommendationFromInputs({ tasks: extraTasks, conversions: convs, criticObservations: [] });
  assert.equal(rec.choice, "A");
});

// --- artifact-vs-task conversion distinction ---------------------------------

// Two verified converted artifacts for the SAME instance "b" (e.g. patchverify-before
// and editguard-before on the same task), like the real psf__requests-5414 case.
function duplicateArtifacts(): Conversion[] {
  return [
    { ...verifiedConversion(), runLabel: "eval-patchverify-before-b" },
    { ...verifiedConversion(), runLabel: "eval-editguard-before-b" },
  ];
}

// 1 + 2. Duplicate artifacts on one instance: many artifacts, one unique task recovery.
test("duplicate converted artifacts on one instance: many artifacts, one task conversion", () => {
  const inp = inputs({ conversions: duplicateArtifacts() });
  const gated = policy("vtrace_with_observed_gated_repair", inp);
  assert.equal(gated.artifactConversionCount, 2); // both artifacts counted
  assert.equal(gated.taskConversionCount, 1); // but only one unique task recovery
});

// 3. Resolved-count effect uses unique task conversions, not artifact rows.
test("resolved count uses unique task conversions, not artifact rows", () => {
  const inp = inputs({ conversions: duplicateArtifacts() });
  const gated = policy("vtrace_with_observed_gated_repair", inp);
  // a (already resolved) + b (recovered once) = 2; NOT 3 despite two artifacts.
  assert.equal(gated.resolvedCount, 2);
  const verified = policy("vtrace_with_verified_repair_cost", inp);
  assert.equal(verified.resolvedCount, 2);
  // recovery cost counted once per unique task (deduped by instance), not per artifact.
  assert.equal(verified.criticCostUsd, 0.12);
  assert.equal(verified.repairCostUsd, 0.2);
});

// 4. The repair artifact table lists ALL artifact conversions (both duplicate rows).
test("repair artifact table lists all artifact conversions", () => {
  const report = buildReport({ generatedAt: "t", inputs: inputs({ conversions: duplicateArtifacts() }) });
  assert.equal(report.conversions.length, 2);
  const md = renderMarkdown(report);
  assert.ok(md.includes("## Verified repair artifacts included"));
  assert.ok(md.includes("eval-patchverify-before-b"));
  assert.ok(md.includes("eval-editguard-before-b"));
});

// 5. Summary exposes BOTH artifact and unique-task conversion counts + the unique list.
test("summary exposes both artifact and task conversion counts", () => {
  const report = buildReport({ generatedAt: "t", inputs: inputs({ conversions: duplicateArtifacts() }) });
  assert.equal(report.summary.verifiedRepairArtifacts, 2);
  assert.equal(report.summary.uniqueTaskConversions, 1);
  assert.deepEqual(report.uniqueTaskRecoveries, ["b"]);
});

// 6. Recommendation moves away from "one more smoke" (C) to D when duplicate artifacts
//    exist but no NEW unique candidate was added — i.e. re-running the same instance.
test("recommendation: D when duplicate artifacts add no new unique task conversion", () => {
  const rec = recFor({ conversions: duplicateArtifacts() });
  assert.equal(rec.choice, "D");
  assert.ok(!rec.statement.includes("one more"), "must not recommend another duplicate smoke");
  assert.ok(/duplicate/i.test(rec.statement));
});

function recFor(overrides: Partial<AccountingInputs>) {
  return pickRecommendationFromInputs(inputs(overrides));
}
function pickRecommendationFromInputs(inp: AccountingInputs) {
  return pickRecommendation({
    vtraceFirstPatch: policy("vtrace_first_patch", inp),
    verifiedRepair: policy("vtrace_with_verified_repair_cost", inp),
  });
}

// --- parsing of real artifact shapes -----------------------------------------
test("parses controlled tasks, conversion, and critic observations from doc shapes", () => {
  const t = parseControlledTasks({ selectedTasks: [{ instanceId: "a", vtraceRunLabel: "eval-a", baselineResolved: true, vtraceResolved: false, baselineCost: 0.2, vtraceCost: 0.3, baselineTokens: 10, vtraceTokens: 20 }] });
  assert.equal(t[0]!.instanceId, "a");
  assert.equal(t[0]!.vtraceResolved, false);
  assert.equal(t[0]!.vtraceCostUsd, 0.3);

  const conv = parseConversion({ runLabel: "r", instanceId: "a", conversion: { firstPatchResolved: false, repairedPatchResolved: true, convertedUnresolvedToResolved: true }, costs: { criticCostUsd: 0.1, repairCostUsd: 0.2, totalCriticRepairCostUsd: 0.3 } });
  assert.equal(conv?.convertedUnresolvedToResolved, true);
  assert.equal(conv?.totalRecoveryCostUsd, 0.3);

  const obs = parseCriticObservations({ runs: [{ instanceId: "a", criticCostUsd: 0.1, criticInputTokens: 100, criticOutputTokens: 50 }, { instanceId: "a", criticCostUsd: 0.3, criticInputTokens: 300, criticOutputTokens: 150 }] });
  assert.equal(obs[0]!.runCount, 2);
  assert.ok(Math.abs((obs[0]!.meanCostUsd ?? 0) - 0.2) < 1e-9);
});

// 7-fail: loader fails clearly when the controlled plan is missing.
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
