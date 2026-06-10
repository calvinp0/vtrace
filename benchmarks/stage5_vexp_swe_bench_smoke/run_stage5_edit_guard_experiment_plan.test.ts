import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  AFTER_TREATMENT,
  BEFORE_TREATMENT,
  KNOWN_LOSS_CLASSIFICATION,
  afterLabelFor,
  beforeLabelFor,
  buildEvaluationCommand,
  buildPlan,
  buildRunCommand,
  parseArgs,
  renderJson,
  renderMarkdown,
  shortId,
} from "./run_stage5_edit_guard_experiment_plan";

const EXPECTED_INSTANCES = [
  "sympy__sympy-16766",
  "matplotlib__matplotlib-22719",
  "psf__requests-5414",
] as const;

const EXPECTED_LABELS = [
  "eval-editguard-before-sympy-16766",
  "eval-editguard-after-sympy-16766",
  "eval-editguard-before-matplotlib-22719",
  "eval-editguard-after-matplotlib-22719",
  "eval-editguard-before-requests-5414",
  "eval-editguard-after-requests-5414",
] as const;

// ---------------------------------------------------------------------------
// 1. Plan includes exactly the three known loss cases.
// ---------------------------------------------------------------------------
test("plan includes exactly the three known loss cases, all patch_mistake_despite_good_context", () => {
  const plan = buildPlan("t");
  assert.equal(plan.cases.length, 3);
  assert.deepEqual(
    plan.cases.map((c) => c.instanceId),
    [...EXPECTED_INSTANCES],
  );
  assert.ok(plan.cases.every((c) => c.knownLossClassification === KNOWN_LOSS_CLASSIFICATION));
  // Labels are derived per the required convention.
  const sympy = plan.cases.find((c) => c.instanceId === "sympy__sympy-16766")!;
  assert.equal(sympy.beforeLabel, "eval-editguard-before-sympy-16766");
  assert.equal(sympy.afterLabel, "eval-editguard-after-sympy-16766");
  assert.equal(sympy.beforeTreatment, BEFORE_TREATMENT);
  assert.equal(sympy.afterTreatment, AFTER_TREATMENT);
  // psf__requests-5414 shortId is "requests-5414" (label drops the "psf__" owner).
  assert.equal(shortId("psf__requests-5414"), "requests-5414");
  assert.equal(beforeLabelFor("psf__requests-5414"), "eval-editguard-before-requests-5414");
  assert.equal(afterLabelFor("psf__requests-5414"), "eval-editguard-after-requests-5414");
});

// ---------------------------------------------------------------------------
// 2. Before commands include --disable-edit-guard.
// ---------------------------------------------------------------------------
test("before commands include --disable-edit-guard and the normal v2 force-inject flags", () => {
  const plan = buildPlan("t");
  const before = plan.commands.filter((c) => c.condition === "before");
  assert.equal(before.length, 3);
  for (const c of before) {
    assert.equal(c.editGuardDisabled, true);
    assert.equal(c.treatment, BEFORE_TREATMENT);
    assert.match(c.command, /--disable-edit-guard/);
    assert.match(c.command, /--protocol vtrace-indexed/);
    assert.match(c.command, /--context-policy force-inject/);
    assert.match(c.command, /--capsule-engine v2/);
    assert.match(c.command, /--capsule-intent debug/);
    assert.match(c.command, /--capsule-budget 8000/);
    assert.match(c.command, new RegExp(`--run-label ${c.runLabel}`));
  }
});

// ---------------------------------------------------------------------------
// 3. After commands do not include --disable-edit-guard.
// ---------------------------------------------------------------------------
test("after commands do NOT include --disable-edit-guard (default EDIT_GUARD on)", () => {
  const plan = buildPlan("t");
  const after = plan.commands.filter((c) => c.condition === "after");
  assert.equal(after.length, 3);
  for (const c of after) {
    assert.equal(c.editGuardDisabled, false);
    assert.equal(c.treatment, AFTER_TREATMENT);
    assert.doesNotMatch(c.command, /--disable-edit-guard/);
    // Still the same controlled protocol otherwise.
    assert.match(c.command, /--context-policy force-inject/);
    assert.match(c.command, /--capsule-engine v2/);
  }
});

// ---------------------------------------------------------------------------
// 4. Neither before nor after commands include --disable-pivot-check.
// ---------------------------------------------------------------------------
test("no run command disables PIVOT_CHECK (the experiment isolates EDIT_GUARD only)", () => {
  const plan = buildPlan("t");
  for (const c of plan.commands) {
    assert.doesNotMatch(c.command, /--disable-pivot-check/);
  }
  // Direct builder check, both polarities.
  assert.doesNotMatch(buildRunCommand("a__b-1", "eval-editguard-before-b-1", true), /--disable-pivot-check/);
  assert.doesNotMatch(buildRunCommand("a__b-1", "eval-editguard-after-b-1", false), /--disable-pivot-check/);
});

// ---------------------------------------------------------------------------
// 5. Evaluation commands are generated for all six labels.
// ---------------------------------------------------------------------------
test("evaluation commands are generated for all six labels (docker, verified-full)", () => {
  const plan = buildPlan("t");
  assert.equal(plan.evaluationCommands.length, 6);
  assert.deepEqual(
    plan.evaluationCommands.map((e) => e.runLabel),
    [...EXPECTED_LABELS],
  );
  for (const e of plan.evaluationCommands) {
    assert.match(e.command, /--mode evaluate/);
    assert.match(e.command, /--eval-mode docker/);
    assert.match(e.command, /--eval-dataset swebench-verified-full\.jsonl/);
    assert.match(e.command, new RegExp(`--run-label ${e.runLabel}`));
    assert.match(e.command, new RegExp(`--instances ${e.instanceId}`));
  }
  // Direct builder shape check.
  const cmd = buildEvaluationCommand("psf__requests-5414", "eval-editguard-after-requests-5414");
  assert.match(cmd, /--instances psf__requests-5414/);
  assert.match(cmd, /--run-label eval-editguard-after-requests-5414/);
});

// ---------------------------------------------------------------------------
// 6. Markdown includes non-claims (and all required sections).
// ---------------------------------------------------------------------------
test("markdown includes all required sections and the non-claims", () => {
  const md = renderMarkdown(buildPlan("2026-06-10T00:00:00.000Z"));
  for (const h of [
    "# Stage 5 EDIT_GUARD 3-loss experiment plan",
    "## Summary",
    "## Why these cases",
    "## Experimental design",
    "## Run commands",
    "## Evaluation commands",
    "## Expected comparison after completion",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(h), `missing section: ${h}`);
  }
  // Non-claims content.
  assert.match(md, /isolates the INCREMENTAL effect of EDIT_GUARD/);
  assert.match(md, /does not claim EDIT_GUARD fixes these losses/);
  assert.match(md, /computes NO resolved\/token\/cost deltas here/);
  // Expected-comparison fields are listed but explicitly not computed yet.
  assert.match(md, /resolved before vs after/);
  assert.match(md, /token\/cost deltas/);
  assert.match(md, /None of these are computed here/);
  // Every label appears in the rendered commands.
  for (const label of EXPECTED_LABELS) assert.ok(md.includes(label), `markdown missing label ${label}`);
});

// ---------------------------------------------------------------------------
// 7. JSON includes cases and command lists.
// ---------------------------------------------------------------------------
test("json exposes generatedAt, cases[], commands[], and evaluationCommands[]", () => {
  const json = JSON.parse(renderJson(buildPlan("2026-06-10T00:00:00.000Z")));
  assert.equal(json.generatedAt, "2026-06-10T00:00:00.000Z");
  assert.ok(Array.isArray(json.cases));
  assert.ok(Array.isArray(json.commands));
  assert.ok(Array.isArray(json.evaluationCommands));
  assert.equal(json.cases.length, 3);
  assert.equal(json.commands.length, 6);
  assert.equal(json.evaluationCommands.length, 6);
  for (const f of [
    "instanceId",
    "repo",
    "knownLossClassification",
    "beforeLabel",
    "afterLabel",
    "beforeTreatment",
    "afterTreatment",
    "reasonIncluded",
  ]) {
    assert.ok(f in json.cases[0], `cases[] missing ${f}`);
  }
  for (const f of ["instanceId", "condition", "runLabel", "treatment", "editGuardDisabled", "command"]) {
    assert.ok(f in json.commands[0], `commands[] missing ${f}`);
  }
  for (const f of ["instanceId", "runLabel", "command"]) {
    assert.ok(f in json.evaluationCommands[0], `evaluationCommands[] missing ${f}`);
  }
});

// ---------------------------------------------------------------------------
// CLI parsing.
// ---------------------------------------------------------------------------
test("parseArgs defaults and overrides", () => {
  const def = parseArgs([]);
  assert.equal(def.outName, "stage5_edit_guard_3_loss_experiment_plan");
  assert.equal(def.resultsDir, "benchmarks/stage5_vexp_swe_bench_smoke/results");
  const custom = parseArgs(["--results", "/tmp/r", "--out-name", "x"]);
  assert.equal(custom.resultsDir, "/tmp/r");
  assert.equal(custom.outName, "x");
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});
