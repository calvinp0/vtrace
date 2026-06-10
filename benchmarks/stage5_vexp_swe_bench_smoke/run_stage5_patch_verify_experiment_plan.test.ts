import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  AFTER_TREATMENT,
  BEFORE_TREATMENT,
  DEFAULT_OUT_NAME,
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
} from "./run_stage5_patch_verify_experiment_plan";

const EXPECTED_INSTANCES = [
  "sympy__sympy-16766",
  "matplotlib__matplotlib-22719",
  "psf__requests-5414",
] as const;

const EXPECTED_LABELS = [
  "eval-patchverify-before-sympy-16766",
  "eval-patchverify-after-sympy-16766",
  "eval-patchverify-before-matplotlib-22719",
  "eval-patchverify-after-matplotlib-22719",
  "eval-patchverify-before-requests-5414",
  "eval-patchverify-after-requests-5414",
] as const;

test("plan includes exactly the three known loss cases", () => {
  const plan = buildPlan("t");
  assert.equal(plan.cases.length, 3);
  assert.deepEqual(
    plan.cases.map((c) => c.instanceId),
    [...EXPECTED_INSTANCES],
  );
  assert.ok(plan.cases.every((c) => c.knownLossClassification === KNOWN_LOSS_CLASSIFICATION));

  const sympy = plan.cases.find((c) => c.instanceId === "sympy__sympy-16766")!;
  assert.equal(sympy.beforeLabel, "eval-patchverify-before-sympy-16766");
  assert.equal(sympy.afterLabel, "eval-patchverify-after-sympy-16766");
  assert.equal(sympy.beforeTreatment, BEFORE_TREATMENT);
  assert.equal(sympy.afterTreatment, AFTER_TREATMENT);

  assert.equal(shortId("psf__requests-5414"), "requests-5414");
  assert.equal(beforeLabelFor("psf__requests-5414"), "eval-patchverify-before-requests-5414");
  assert.equal(afterLabelFor("psf__requests-5414"), "eval-patchverify-after-requests-5414");
});

test("before commands include --disable-edit-guard and --disable-patch-verify", () => {
  const before = buildPlan("t").commands.filter((c) => c.condition === "before");
  assert.equal(before.length, 3);
  for (const c of before) {
    assert.equal(c.editGuardDisabled, true);
    assert.equal(c.patchVerifyDisabled, true);
    assert.equal(c.treatment, BEFORE_TREATMENT);
    assert.match(c.command, /--disable-edit-guard/);
    assert.match(c.command, /--disable-patch-verify/);
    assert.match(c.command, /--protocol vtrace-indexed/);
    assert.match(c.command, /--context-policy force-inject/);
    assert.match(c.command, /--capsule-engine v2/);
    assert.match(c.command, /--capsule-intent debug/);
    assert.match(c.command, /--capsule-budget 8000/);
    assert.match(c.command, new RegExp(`--run-label ${c.runLabel}`));
  }
});

test("after commands include --disable-edit-guard but not --disable-patch-verify", () => {
  const after = buildPlan("t").commands.filter((c) => c.condition === "after");
  assert.equal(after.length, 3);
  for (const c of after) {
    assert.equal(c.editGuardDisabled, true);
    assert.equal(c.patchVerifyDisabled, false);
    assert.equal(c.treatment, AFTER_TREATMENT);
    assert.match(c.command, /--disable-edit-guard/);
    assert.doesNotMatch(c.command, /--disable-patch-verify/);
    assert.match(c.command, /--context-policy force-inject/);
    assert.match(c.command, /--capsule-engine v2/);
  }
});

test("neither before nor after commands include --disable-pivot-check", () => {
  const plan = buildPlan("t");
  for (const c of plan.commands) assert.doesNotMatch(c.command, /--disable-pivot-check/);
  assert.doesNotMatch(
    buildRunCommand("a__b-1", "eval-patchverify-before-b-1", true),
    /--disable-pivot-check/,
  );
  assert.doesNotMatch(
    buildRunCommand("a__b-1", "eval-patchverify-after-b-1", false),
    /--disable-pivot-check/,
  );
});

test("all run commands include --reuse-workspace", () => {
  const plan = buildPlan("t");
  assert.equal(plan.commands.length, 6);
  for (const c of plan.commands) assert.match(c.command, /--reuse-workspace/);
});

test("evaluation commands are generated for all six labels", () => {
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
  const cmd = buildEvaluationCommand("psf__requests-5414", "eval-patchverify-after-requests-5414");
  assert.match(cmd, /--instances psf__requests-5414/);
  assert.match(cmd, /--run-label eval-patchverify-after-requests-5414/);
});

test("markdown includes all required sections and non-claims", () => {
  const md = renderMarkdown(buildPlan("2026-06-10T00:00:00.000Z"));
  for (const heading of [
    "# Stage 5 PATCH_VERIFY 3-loss experiment plan",
    "## Summary",
    "## Why these cases",
    "## Experimental design",
    "## Run commands",
    "## Evaluation commands",
    "## Expected comparison after completion",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
  assert.match(md, /isolates PATCH_VERIFY directly/);
  assert.match(md, /PIVOT_CHECK stays on and EDIT_GUARD stays off/);
  assert.match(md, /It runs no agents and no Docker/);
  assert.match(md, /resolved before vs after/);
  assert.match(md, /patch-verify injected\/text-present metadata/);
  assert.match(md, /Do not compute these until the runs exist/);
  for (const label of EXPECTED_LABELS) assert.ok(md.includes(label), `markdown missing label ${label}`);
});

test("json includes cases and command lists", () => {
  const json = JSON.parse(renderJson(buildPlan("2026-06-10T00:00:00.000Z")));
  assert.equal(json.generatedAt, "2026-06-10T00:00:00.000Z");
  assert.ok(Array.isArray(json.cases));
  assert.ok(Array.isArray(json.commands));
  assert.ok(Array.isArray(json.evaluationCommands));
  assert.equal(json.cases.length, 3);
  assert.equal(json.commands.length, 6);
  assert.equal(json.evaluationCommands.length, 6);
  for (const field of [
    "instanceId",
    "repo",
    "knownLossClassification",
    "beforeLabel",
    "afterLabel",
    "beforeTreatment",
    "afterTreatment",
    "reasonIncluded",
  ]) {
    assert.ok(field in json.cases[0], `cases[] missing ${field}`);
  }
  for (const field of [
    "instanceId",
    "condition",
    "runLabel",
    "treatment",
    "editGuardDisabled",
    "patchVerifyDisabled",
    "command",
  ]) {
    assert.ok(field in json.commands[0], `commands[] missing ${field}`);
  }
  for (const field of ["instanceId", "runLabel", "command"]) {
    assert.ok(field in json.evaluationCommands[0], `evaluationCommands[] missing ${field}`);
  }
});

test("parseArgs defaults and overrides", () => {
  assert.deepEqual(parseArgs([]), {
    resultsDir: "benchmarks/stage5_vexp_swe_bench_smoke/results",
    outName: DEFAULT_OUT_NAME,
  });
  assert.deepEqual(parseArgs(["--results", "/tmp/r", "--out-name", "x"]), {
    resultsDir: "/tmp/r",
    outName: "x",
  });
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});
