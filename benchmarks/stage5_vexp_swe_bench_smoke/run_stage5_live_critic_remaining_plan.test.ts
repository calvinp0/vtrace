import assert from "node:assert/strict";
import { test } from "bun:test";

import type { PatchCriticReport } from "./stage5_patch_critic";
import {
  COST_CAP_USD,
  MAX_CRITIC_RUNS,
  SMOKED_LABEL,
  buildPlan,
  deriveLabels,
  parseArgs,
  renderJson,
  renderMarkdown,
} from "./run_stage5_live_critic_remaining_plan";

const RESULTS = "benchmarks/stage5_vexp_swe_bench_smoke/results";

// Build a minimal but contract-shaped deterministic report.
function rep(runLabel: string, instanceId: string, repair: boolean): PatchCriticReport {
  return {
    instanceId,
    runLabel,
    scope_ok: repair ? false : true,
    scope_evidence: "—",
    failing_behavior_handled: null,
    failing_behavior_evidence: "—",
    minimality_ok: !repair,
    minimality_evidence: "—",
    test_evidence_ok: false,
    test_evidence: "—",
    risk: repair ? "high" : "low",
    repair_required: repair,
    repair_reason: repair ? "defect" : "",
    repair_instructions: repair ? "fix" : "",
    confidence: repair ? "high" : "medium",
    evidence_probe_ids: [],
  };
}

// The full 12-run deterministic picture: 6 repair_required (incl. the smoked sympy run), 6 low-risk.
function fullReports(): PatchCriticReport[] {
  return [
    rep("eval-editguard-before-sympy-16766", "sympy__sympy-16766", false),
    rep("eval-editguard-after-sympy-16766", "sympy__sympy-16766", false),
    rep(SMOKED_LABEL, "sympy__sympy-16766", true), // already-smoked
    rep("eval-patchverify-after-sympy-16766", "sympy__sympy-16766", false),
    rep("eval-editguard-before-matplotlib-22719", "matplotlib__matplotlib-22719", true),
    rep("eval-editguard-after-matplotlib-22719", "matplotlib__matplotlib-22719", false),
    rep("eval-patchverify-before-matplotlib-22719", "matplotlib__matplotlib-22719", false),
    rep("eval-patchverify-after-matplotlib-22719", "matplotlib__matplotlib-22719", true),
    rep("eval-editguard-before-requests-5414", "psf__requests-5414", true),
    rep("eval-editguard-after-requests-5414", "psf__requests-5414", true),
    rep("eval-patchverify-before-requests-5414", "psf__requests-5414", true),
    rep("eval-patchverify-after-requests-5414", "psf__requests-5414", false),
  ];
}

const EXPECTED_FIVE = [
  "eval-editguard-before-matplotlib-22719",
  "eval-patchverify-after-matplotlib-22719",
  "eval-editguard-before-requests-5414",
  "eval-editguard-after-requests-5414",
  "eval-patchverify-before-requests-5414",
];

function planFromFull() {
  const derived = deriveLabels(fullReports());
  return buildPlan({ generatedAt: "2026-06-10T00:00:00.000Z", resultsDir: RESULTS, derived });
}

// ---------------------------------------------------------------------------
// 1 + 2 + 3: exactly the five remaining repair_required labels; excludes smoked + low-risk.
// ---------------------------------------------------------------------------
test("includes exactly the five remaining deterministic repair_required labels; excludes smoked + low-risk", () => {
  const plan = planFromFull();
  const included = plan.labels.map((l) => l.runLabel);
  assert.deepEqual(included, EXPECTED_FIVE);

  // (2) the smoked sympy label is excluded.
  assert.ok(!included.includes(SMOKED_LABEL));
  assert.ok(plan.excludedLabels.some((l) => l.runLabel === SMOKED_LABEL && /already-smoked/.test(l.reasonExcluded)));

  // (3) every low-risk (repair_required=false) run is excluded, none leak into included.
  for (const l of plan.labels) assert.equal(l.deterministicRepairRequired, true);
  assert.ok(plan.excludedLabels.some((l) => /low-risk/.test(l.reasonExcluded)));
  assert.equal(plan.excludedLabels.length, 7); // smoked + 6 low-risk

  // Each label carries the required per-entry fields.
  for (const l of plan.labels) {
    assert.ok(l.runLabel && l.instanceId && l.reasonIncluded && l.knownRiskType);
  }
  // Known risk types are correctly attributed.
  const mpl = plan.labels.find((l) => l.instanceId.startsWith("matplotlib__"))!;
  const req = plan.labels.find((l) => l.instanceId.startsWith("psf__requests"))!;
  assert.match(mpl.knownRiskType, /empty-array/);
  assert.match(req.knownRiskType, /broad rewrite/);
});

// ---------------------------------------------------------------------------
// 4-8: live command shape (flags + gates).
// ---------------------------------------------------------------------------
test("live command carries enable flag, five run-labels, and the exact gates", () => {
  const plan = planFromFull();
  const cmd = plan.liveCommand;

  assert.ok(cmd.includes("--enable-patch-critic")); // (4)
  const runLabelCount = (cmd.match(/--run-label /g) ?? []).length;
  assert.equal(runLabelCount, 5); // (5)
  for (const lbl of EXPECTED_FIVE) assert.ok(cmd.includes(`--run-label ${lbl}`), `missing ${lbl}`);
  assert.ok(cmd.includes(`--max-critic-runs ${MAX_CRITIC_RUNS}`)); // (6)
  assert.ok(cmd.includes("--max-critic-runs 5"));
  assert.ok(cmd.includes("--only-deterministic-repair-required")); // (7)
  assert.ok(cmd.includes(`--critic-cost-cap-usd ${COST_CAP_USD.toFixed(2)}`)); // (8)
  assert.ok(cmd.includes("--critic-cost-cap-usd 0.75"));
  assert.ok(cmd.includes("--out-name stage5_patch_critic_live_remaining_high_risk"));

  // The dry-run command mirrors the gates but adds --dry-run and its own out-name.
  const dry = plan.dryRunCommand;
  assert.ok(dry.includes("--dry-run"));
  assert.ok(dry.includes("--out-name stage5_patch_critic_live_remaining_high_risk_dry_run"));
  assert.equal((dry.match(/--run-label /g) ?? []).length, 5);
});

// ---------------------------------------------------------------------------
// 9: markdown includes non-claims, safety gates, inspection commands.
// ---------------------------------------------------------------------------
test("markdown includes all sections, safety gates, non-claims, and inspection commands", () => {
  const plan = planFromFull();
  const md = renderMarkdown(plan);

  for (const heading of [
    "# Stage 5 remaining live critic observation plan",
    "## Summary",
    "## Why these runs",
    "## Safety gates",
    "## Dry-run command",
    "## Live observation command",
    "## Expected artifacts",
    "## What to inspect after running",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(heading), `markdown missing section: ${heading}`);
  }

  // Safety gate bullets stated literally.
  for (const gate of [
    "no repair",
    "no patch modification",
    "no Docker",
    "no agent rerun",
    "run-label constrained",
    "deterministic-repair-required only",
    "max 5 calls",
    "cost cap $0.75",
  ]) {
    assert.ok(md.includes(gate), `markdown missing safety gate: ${gate}`);
  }

  // Inspection commands present.
  assert.ok(md.includes("for LABEL in"));
  assert.ok(md.includes("_patch_critic.meta.json"));
  assert.ok(md.includes("_patch_critic_report.json"));
  assert.ok(md.includes("sed -n '1,260p'"));

  // Recommended next report named with its measures.
  assert.ok(md.includes("stage5_live_critic_high_risk_comparison.md/json"));
  assert.ok(md.includes("one-repair-attempt mode"));

  // Non-claims rendered.
  assert.ok(md.includes("This plan runs no live critic, no agents, and no Docker."));
});

// ---------------------------------------------------------------------------
// 10: JSON exposes labels, excludedLabels, commands, and safety gates.
// ---------------------------------------------------------------------------
test("JSON exposes the required shape (labels, commands, gates, artifacts, non-claims)", () => {
  const plan = planFromFull();
  const parsed = JSON.parse(renderJson(plan));

  for (const field of [
    "generatedAt",
    "labels",
    "excludedLabels",
    "dryRunCommand",
    "liveCommand",
    "safetyGates",
    "expectedArtifacts",
    "nonClaims",
  ]) {
    assert.ok(field in parsed, `missing JSON field ${field}`);
  }
  assert.equal(parsed.labels.length, 5);
  for (const entry of parsed.labels) {
    for (const f of ["runLabel", "instanceId", "deterministicRepairRequired", "reasonIncluded", "knownRiskType"]) {
      assert.ok(f in entry, `label entry missing ${f}`);
    }
  }
  assert.equal(parsed.safetyGates.maxCriticRuns, 5);
  assert.equal(parsed.safetyGates.criticCostCapUsd, 0.75);
  assert.equal(parsed.safetyGates.enablePatchCritic, true);
  assert.equal(parsed.safetyGates.noRepair, true);
  assert.equal(parsed.safetyGates.noDocker, true);
});

// ---------------------------------------------------------------------------
// Fallback: no deterministic reports still yields the canonical five.
// ---------------------------------------------------------------------------
test("deriveLabels falls back to the canonical five when no reports are available", () => {
  const derived = deriveLabels([]);
  assert.equal(derived.derivedFrom, "fallback");
  assert.deepEqual(derived.included.map((l) => l.runLabel), EXPECTED_FIVE);
  assert.ok(derived.excluded.some((l) => l.runLabel === SMOKED_LABEL));
});

// ---------------------------------------------------------------------------
// parseArgs honors documented flags.
// ---------------------------------------------------------------------------
test("parseArgs honors --results / --out-name with defaults", () => {
  const cfg = parseArgs(["--results", "some/dir", "--out-name", "custom"]);
  assert.equal(cfg.resultsDir, "some/dir");
  assert.equal(cfg.outName, "custom");
  const def = parseArgs([]);
  assert.equal(def.outName, "stage5_live_critic_remaining_plan");
  assert.throws(() => parseArgs(["--nope"]));
});
