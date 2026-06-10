import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  type ConversionInputs,
  buildConversionReport,
  computeConvertedUnresolvedToResolved,
  computeCriticRepairCost,
  loadConversionInputs,
  parseArgs,
  renderJson,
  renderMarkdown,
} from "./run_stage5_repair_conversion_report";

const INSTANCE = "sympy__sympy-16766";
const RUN_LABEL = "eval-patchverify-before-sympy-16766";

const FIRST_HASH = "428bc414f215b92ce1db8bd1366af22018cc2b4dc1bf6fa5051b81b65a18e0be";
const REPAIRED_HASH = "c3abb49e99bbd71788f3ddf96fe735695ed830ebb08660683587335e996ac2ee";

function baseInputs(overrides: Partial<ConversionInputs> = {}): ConversionInputs {
  return {
    runLabel: RUN_LABEL,
    instanceId: INSTANCE,
    vtraceDir: "/v",
    repairEvalMeta: {
      runLabel: RUN_LABEL,
      instanceId: INSTANCE,
      evaluatedPatch: "repaired",
      firstPatchHash: FIRST_HASH,
      repairedPatchHash: REPAIRED_HASH,
      evaluationRan: true,
      dockerUsed: true,
      resolved: true,
      evaluationError: null,
    },
    repairEvalResult: { evaluationRan: true, dockerUsed: true, resolved: true, evaluationError: null, command: "node dist/cli.js evaluate ...", exitCode: 0 },
    repairMeta: {
      runLabel: RUN_LABEL,
      instanceId: INSTANCE,
      defectClass: "wrong_scope",
      instructionQuality: "actionable",
      result: { validPatch: true, changedPatch: true, failedOpen: false, repairCostUsd: 0.20761925, repairInputTokens: 6021, repairOutputTokens: 1396 },
    },
    criticMeta: {
      criticModel: null,
      criticCostUsd: 0.12178375,
      criticInputTokens: 4343,
      criticOutputTokens: 2487,
      deterministicRepairRequired: true,
      liveRepairRequired: true,
      agreementWithDeterministic: true,
    },
    criticReport: {
      scope_ok: false,
      scope_evidence: "wrong scope",
      risk: "medium",
      confidence: "medium",
      repair_required: true,
      repair_reason: "Wrong scope: _print_Indexed landed in AbstractPythonCodePrinter.",
      repair_instructions: "Relocate the existing _print_Indexed method into the PythonCodePrinter class body.",
    },
    firstPatchPresent: true,
    repairedPatchPresent: true,
    firstPatchResolved: false,
    originalAgentCostUsd: 0.3718555,
    originalAgentModel: "claude-opus-4-5-20251101",
    ...overrides,
  };
}

async function withTmp<T>(fn: (resultsDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "repair-conv-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function scaffold(resultsDir: string, opts: { withRepairedEvalMeta?: boolean } = {}): Promise<void> {
  const vtraceDir = path.join(resultsDir, "runs", RUN_LABEL, "raw", "vtrace");
  const repairDir = path.join(vtraceDir, "repair");
  const repairEvalDir = path.join(vtraceDir, "repair_eval");
  await mkdir(repairEvalDir, { recursive: true });
  await mkdir(repairDir, { recursive: true });
  if (opts.withRepairedEvalMeta !== false) {
    await writeFile(
      path.join(repairEvalDir, "_repaired_eval.meta.json"),
      `${JSON.stringify({ runLabel: RUN_LABEL, instanceId: INSTANCE, evaluatedPatch: "repaired", firstPatchHash: FIRST_HASH, repairedPatchHash: REPAIRED_HASH, evaluationRan: true, dockerUsed: true, resolved: true, evaluationError: null }, null, 2)}\n`,
    );
  }
  await writeFile(
    path.join(repairEvalDir, "_repaired_eval.result.json"),
    `${JSON.stringify({ evaluationRan: true, dockerUsed: true, resolved: true, evaluationError: null, command: "node dist/cli.js evaluate x --mode docker", exitCode: 0 }, null, 2)}\n`,
  );
  await writeFile(
    path.join(repairDir, "_patch_repair.meta.json"),
    `${JSON.stringify({ runLabel: RUN_LABEL, instanceId: INSTANCE, defectClass: "wrong_scope", instructionQuality: "actionable", result: { validPatch: true, changedPatch: true, failedOpen: false, repairCostUsd: 0.20761925, repairInputTokens: 6021, repairOutputTokens: 1396 } }, null, 2)}\n`,
  );
  await writeFile(path.join(repairDir, "_first_patch.diff"), "diff first\n");
  await writeFile(path.join(repairDir, "_repaired_patch.diff"), "diff repaired\n");
  await writeFile(
    path.join(vtraceDir, "_patch_critic.meta.json"),
    `${JSON.stringify({ criticModel: null, criticCostUsd: 0.12178375, criticInputTokens: 4343, criticOutputTokens: 2487, deterministicRepairRequired: true, liveRepairRequired: true, agreementWithDeterministic: true }, null, 2)}\n`,
  );
  await writeFile(
    path.join(vtraceDir, "_patch_critic_report.json"),
    `${JSON.stringify({ scope_ok: false, risk: "medium", confidence: "medium", repair_required: true, repair_reason: "Wrong scope.", repair_instructions: "Relocate it." }, null, 2)}\n`,
  );
  await writeFile(
    path.join(vtraceDir, "swebench-2026-06-10.jsonl"),
    `${JSON.stringify({ instanceId: INSTANCE, resolved: false, costUsd: 0.3718555, model: "claude-opus-4-5-20251101", modelPatch: "diff first" })}\n`,
  );
}

// 1 + 2. Loads repaired-eval metadata and repair metadata from disk.
test("loads repaired-eval and repair metadata", async () => {
  await withTmp(async (resultsDir) => {
    await scaffold(resultsDir);
    const inputs = await loadConversionInputs(resultsDir, RUN_LABEL);
    assert.equal(inputs.repairEvalMeta.resolved, true);
    assert.equal(inputs.repairEvalMeta.repairedPatchHash, REPAIRED_HASH);
    assert.equal(inputs.repairMeta?.defectClass, "wrong_scope");
    assert.equal(inputs.repairMeta?.result?.repairCostUsd, 0.20761925);
    assert.equal(inputs.criticMeta?.criticCostUsd, 0.12178375);
    assert.equal(inputs.firstPatchResolved, false);
    assert.equal(inputs.originalAgentCostUsd, 0.3718555);
  });
});

// 3. Computes convertedUnresolvedToResolved (strict three-valued).
test("computes convertedUnresolvedToResolved", () => {
  assert.equal(computeConvertedUnresolvedToResolved(false, true), true);
  assert.equal(computeConvertedUnresolvedToResolved(true, true), false);
  assert.equal(computeConvertedUnresolvedToResolved(false, false), false);
  assert.equal(computeConvertedUnresolvedToResolved(null, true), false);
  assert.equal(computeConvertedUnresolvedToResolved(false, null), false);
});

// 4. Computes critic+repair cost when critic metadata exists (and degrades gracefully).
test("computes critic+repair cost", () => {
  const both = computeCriticRepairCost(0.12178375, 0.20761925);
  assert.ok(Math.abs((both.totalCriticRepairCostUsd ?? 0) - 0.329403) < 1e-6);
  const repairOnly = computeCriticRepairCost(null, 0.2);
  assert.equal(repairOnly.totalCriticRepairCostUsd, 0.2);
  const neither = computeCriticRepairCost(null, null);
  assert.equal(neither.totalCriticRepairCostUsd, null);
});

// 5. Emits required Markdown sections.
test("emits required Markdown sections", () => {
  const md = renderMarkdown(buildConversionReport({ generatedAt: "t", inputs: baseInputs() }));
  for (const section of [
    "# Stage 5 repair conversion evidence: SymPy",
    "## Summary",
    "## Pipeline",
    "## First patch",
    "## Critic finding",
    "## Repair",
    "## Repaired-patch evaluation",
    "## Conversion claim",
    "## Cost and token accounting",
    "## Safety properties",
    "## Why this matters",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(section), `missing section ${section}`);
  }
  // Required facts surfaced verbatim.
  assert.ok(md.includes("firstPatchResolved=**false**"));
  assert.ok(md.includes("repairedPatchResolved=**true**"));
  assert.ok(md.includes("convertedUnresolvedToResolved=**true**"));
  assert.ok(md.includes(FIRST_HASH));
  assert.ok(md.includes(REPAIRED_HASH));
  // Costs reported separately.
  assert.ok(md.includes("$0.1218")); // critic
  assert.ok(md.includes("$0.2076")); // repair
  assert.ok(md.includes("$0.3294")); // total critic+repair
  assert.ok(md.includes("$0.3719")); // original agent, labeled separately
});

// 6. Emits required JSON fields.
test("emits required JSON fields", () => {
  const report = buildConversionReport({ generatedAt: "t", inputs: baseInputs() });
  const json = JSON.parse(renderJson(report));
  for (const key of ["generatedAt", "runLabel", "instanceId", "summary", "firstPatch", "critic", "repair", "evaluation", "conversion", "costs", "safety", "nonClaims"]) {
    assert.ok(key in json, `missing key ${key}`);
  }
  assert.equal(json.conversion.firstPatchResolved, false);
  assert.equal(json.conversion.repairedPatchResolved, true);
  assert.equal(json.conversion.convertedUnresolvedToResolved, true);
  assert.equal(json.evaluation.evaluationRan, true);
  assert.equal(json.evaluation.dockerUsed, true);
  assert.equal(json.evaluation.evaluationError, null);
  assert.equal(json.costs.repairCostUsd, 0.20761925);
  assert.equal(json.costs.repairInputTokens, 6021);
  assert.equal(json.costs.repairOutputTokens, 1396);
  assert.equal(json.costs.criticCostUsd, 0.12178375);
  assert.equal(json.summary.artifactSuccess, true);
  assert.equal(json.summary.evaluationSuccess, true);
  assert.equal(json.safety.firstPatchReEvaluated, false);
  assert.ok(json.nonClaims.length >= 4);
});

// 7. Fails clearly when repaired-eval metadata is missing.
test("fails clearly when repaired-eval metadata is missing", async () => {
  await withTmp(async (resultsDir) => {
    await scaffold(resultsDir, { withRepairedEvalMeta: false });
    await assert.rejects(() => loadConversionInputs(resultsDir, RUN_LABEL), /No repaired-eval metadata/);
  });
});

test("degrades when critic metadata absent (no conversion overclaim)", () => {
  const report = buildConversionReport({ generatedAt: "t", inputs: baseInputs({ criticMeta: null, criticReport: null }) });
  assert.equal(report.costs.criticCostUsd, null);
  // total falls back to repair-only leg.
  assert.equal(report.costs.totalCriticRepairCostUsd, 0.20761925);
  assert.equal(report.conversion.convertedUnresolvedToResolved, true);
});

test("does not claim conversion when first patch resolution is unknown", () => {
  const report = buildConversionReport({ generatedAt: "t", inputs: baseInputs({ firstPatchResolved: null }) });
  assert.equal(report.conversion.convertedUnresolvedToResolved, false);
  assert.ok(!report.summary.headline.includes("loss recovery"));
});

test("parseArgs reads run label and out name", () => {
  const cfg = parseArgs(["--results", "r", "--run-label", "lbl", "--out-name", "o"]);
  assert.equal(cfg.resultsDir, "r");
  assert.equal(cfg.runLabel, "lbl");
  assert.equal(cfg.outName, "o");
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});
