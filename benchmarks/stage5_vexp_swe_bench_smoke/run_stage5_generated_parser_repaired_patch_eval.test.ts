import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type CliConfig,
  CONVERSION_NOT_RESOLVED_SENTENCE,
  CONVERSION_RESOLVED_SENTENCE,
  EVALUATION_METHOD,
  analyzeRepairedPatchShape,
  buildConversionReport,
  computeRecoveryCost,
  parseArgs,
  renderJson,
  renderMarkdown,
  run,
} from "./run_stage5_generated_parser_repaired_patch_eval";
import type { ProcessResult } from "./run_stage5_repaired_patch_eval";

// ---------------------------------------------------------------------------
// Fixtures — the real Astropy generated-parser diffs (narrow repaired vs broad first).
// ---------------------------------------------------------------------------

const RL = "eval-strictv2-artifacts-protocol-vtrace-astropy-14369";
const INSTANCE = "astropy__astropy-14369";

// The narrow repaired patch: one file, a single grammar-production reorder, no table deletions.
const REPAIRED_DIFF = [
  "diff --git a/astropy/units/format/cds.py b/astropy/units/format/cds.py",
  "index 307e987..a1b2c3d 100644",
  "--- a/astropy/units/format/cds.py",
  "+++ b/astropy/units/format/cds.py",
  "@@ -182,7 +182,7 @@ class CDS(Base):",
  "         def p_division_of_units(p):",
  '             """',
  "             division_of_units : DIVISION unit_expression",
  "-                              | unit_expression DIVISION combined_units",
  "+                              | combined_units DIVISION unit_expression",
  '             """',
  "             if len(p) == 3:",
  "                 p[0] = p[2] ** -1",
].join("\n");

// The broad first patch: rewrites cds.py AND deletes both generated parser tables.
const FIRST_DIFF = [
  "diff --git a/astropy/units/format/cds.py b/astropy/units/format/cds.py",
  "--- a/astropy/units/format/cds.py",
  "+++ b/astropy/units/format/cds.py",
  "@@ -164,30 +164,20 @@ class CDS(Base):",
  ...Array.from({ length: 20 }, (_, i) => `-        old_line_${i}`),
  ...Array.from({ length: 12 }, (_, i) => `+        new_line_${i}`),
  "diff --git a/astropy/units/format/cds_lextab.py b/astropy/units/format/cds_lextab.py",
  "deleted file mode 100644",
  "--- a/astropy/units/format/cds_lextab.py",
  "+++ /dev/null",
  "@@ -1,21 +0,0 @@",
  ...Array.from({ length: 21 }, (_, i) => `-lextab_line_${i}`),
  "diff --git a/astropy/units/format/cds_parsetab.py b/astropy/units/format/cds_parsetab.py",
  "deleted file mode 100644",
  "--- a/astropy/units/format/cds_parsetab.py",
  "+++ /dev/null",
  "@@ -1,68 +0,0 @@",
  ...Array.from({ length: 68 }, (_, i) => `-parsetab_line_${i}`),
].join("\n");

const CRITIC_COST = 0.18575950000000002;
const REPAIR_COST = 0.25599150000000004;

// A process runner that simulates the external `evaluate` step: it finds the derived JSONL in the
// args, rewrites every row's `resolved` to the configured verdict, and exits 0. NO Docker, NO model.
function mockEvaluator(verdict: boolean): {
  runProcess: (command: string, args: readonly string[]) => Promise<ProcessResult>;
  readonly calls: number;
} {
  let calls = 0;
  return {
    async runProcess(_command, args) {
      calls += 1;
      const jsonlPath = args.find((a) => a.endsWith(".jsonl"));
      if (jsonlPath) {
        const content = await readFile(jsonlPath, "utf8");
        const rewritten = content
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.stringify({ ...(JSON.parse(l) as Record<string, unknown>), resolved: verdict }))
          .join("\n");
        await writeFile(jsonlPath, `${rewritten}\n`);
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    get calls() {
      return calls;
    },
  };
}

// Build a temp results tree carrying the repair artifacts the runner reads. Returns the resultsDir.
async function makeFixture(root: string, opts: { firstResolved?: boolean } = {}): Promise<string> {
  const results = path.join(root, "results");
  const vtrace = path.join(results, "runs", RL, "raw", "vtrace");
  const repair = path.join(vtrace, "repair");
  await mkdir(repair, { recursive: true });

  await writeFile(path.join(repair, "_repaired_patch.diff"), `${REPAIRED_DIFF}\n`);
  await writeFile(path.join(repair, "_first_patch.diff"), `${FIRST_DIFF}\n`);
  await writeFile(
    path.join(repair, "_patch_repair.meta.json"),
    JSON.stringify({
      runLabel: RL,
      instanceId: INSTANCE,
      defectClass: "unknown",
      instructionQuality: "actionable",
      result: { validPatch: true, changedPatch: true, failedOpen: false, repairCostUsd: REPAIR_COST },
      generatedParserRepairSource: "generated_parser_minimality",
    }),
  );
  await writeFile(
    path.join(vtrace, "_patch_critic.meta.json"),
    JSON.stringify({ criticCostUsd: CRITIC_COST, liveRepairRequired: true, agreementWithDeterministic: true }),
  );
  // The original run JSONL row: first patch unresolved (or per opts).
  await writeFile(
    path.join(vtrace, "swebench-2026-06-11.jsonl"),
    `${JSON.stringify({ instanceId: INSTANCE, modelPatch: FIRST_DIFF, resolved: opts.firstResolved ?? false })}\n`,
  );
  await writeFile(
    path.join(vtrace, "_eval.meta.json"),
    JSON.stringify({ evaluationRan: true, dockerUsed: true, resolvedCount: 0, instancesEvaluated: 1 }),
  );
  return results;
}

function cfg(resultsDir: string, overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    resultsDir,
    runLabel: RL,
    outName: "stage5_generated_parser_repair_conversion",
    repairOutName: "stage5_generated_parser_astropy_repair_attempt",
    runEvaluation: true,
    evalMode: "docker",
    evalTimeout: 1800,
    evalDataset: null,
    nodeCommand: "node",
    cliEntry: "dist/cli.js",
    vexpSweBenchDir: "/tmp/does-not-run",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseArgs.
// ---------------------------------------------------------------------------
test("parseArgs: Docker is opt-in and defaults are conservative", () => {
  const c = parseArgs(["--run-label", RL]);
  assert.equal(c.runLabel, RL);
  assert.equal(c.runEvaluation, false); // opt-in
  assert.equal(c.outName, "stage5_generated_parser_repair_conversion");
  assert.equal(parseArgs(["--run-label", RL, "--run-evaluation"]).runEvaluation, true);
  assert.throws(() => parseArgs(["--eval-mode", "nonsense"]), /eval-mode must be/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});

// ---------------------------------------------------------------------------
// 2/3/4. Patch-shape analysis (pure), with broad first-patch positive controls.
// ---------------------------------------------------------------------------
test("analyzeRepairedPatchShape: narrow repaired patch — reorder, no deletion, not broad", () => {
  const s = analyzeRepairedPatchShape(REPAIRED_DIFF);
  assert.deepEqual([...s.filesChanged], ["astropy/units/format/cds.py"]); // 2. only one file
  assert.equal(s.narrowGrammarReorder, true); // 2. detects narrow grammar reorder
  assert.equal(s.generatedParserTablesDeleted, false); // 3. no table deletion
  assert.equal(s.broadGrammarRewrite, false); // 4. no broad rewrite
});

test("analyzeRepairedPatchShape: broad first patch — deletes tables and is broad (positive control)", () => {
  const s = analyzeRepairedPatchShape(FIRST_DIFF);
  assert.equal(s.generatedParserTablesDeleted, true);
  assert.equal(s.broadGrammarRewrite, true);
  assert.ok(s.deletedFiles.includes("astropy/units/format/cds_lextab.py"));
  assert.ok(s.deletedFiles.includes("astropy/units/format/cds_parsetab.py"));
  assert.equal(s.filesChanged.length, 3);
});

// ---------------------------------------------------------------------------
// 8. Recovery cost from critic + repair.
// ---------------------------------------------------------------------------
test("computeRecoveryCost: sums critic + repair; null only when both absent", () => {
  const c = computeRecoveryCost(CRITIC_COST, REPAIR_COST);
  assert.equal(c.criticCostUsd, CRITIC_COST);
  assert.equal(c.repairCostUsd, REPAIR_COST);
  assert.ok(Math.abs(c.totalRecoveryCostUsd! - 0.4417510000000001) < 1e-9);
  assert.equal(computeRecoveryCost(null, null).totalRecoveryCostUsd, null);
  assert.equal(computeRecoveryCost(CRITIC_COST, null).totalRecoveryCostUsd, CRITIC_COST);
});

// ---------------------------------------------------------------------------
// 1/5/6/7/9/12. End-to-end with a MOCKED evaluator (no Docker, no model, no agent).
// ---------------------------------------------------------------------------
test("run: locates artifacts, reads source resolved=false, mock evaluator resolves=true ⇒ converted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gp-conv-"));
  try {
    const results = await makeFixture(root);
    const ev = mockEvaluator(true); // 6. repaired evaluation resolved=true (fixture/mock)
    const report = await run(cfg(results), { runProcess: ev.runProcess });

    assert.equal(ev.calls, 1); // 12. exactly one mocked eval call; no real Docker
    // 1. located the repaired patch artifact (hash present, files read).
    assert.ok(report.repairedPatchHash.length === 64);
    assert.equal(report.instanceId, INSTANCE);
    // 5. source resolved=false read from the original JSONL row.
    assert.equal(report.sourcePatchResolved, false);
    // 6. repaired evaluation resolved=true.
    assert.equal(report.repairedPatchResolved, true);
    // 7. conversion computed true.
    assert.equal(report.convertedUnresolvedToResolved, true);
    assert.equal(report.evaluationRan, true);
    assert.equal(report.dockerUsed, true);
    assert.equal(report.evaluationMethod, EVALUATION_METHOD);
    // 9. policy accounting untouched.
    assert.equal(report.policyAccountingUpdated, false);
    // shape carried through.
    assert.equal(report.narrowGrammarReorderDetected, true);
    assert.equal(report.generatedParserTablesDeletedByRepair, false);
    assert.equal(report.broadGrammarRewriteDetectedInRepair, false);
    // 8. recovery cost end-to-end.
    assert.ok(Math.abs(report.totalRecoveryCostUsd! - (CRITIC_COST + REPAIR_COST)) < 1e-9);
    // resolved interpretation sentence.
    assert.equal(report.interpretation, CONVERSION_RESOLVED_SENTENCE);

    // The isolated derived JSONL was written under repair_eval/ (never the original).
    const derived = await readFile(
      path.join(results, "runs", RL, "raw", "vtrace", "repair_eval", "_repaired_eval_input.jsonl"),
      "utf8",
    );
    assert.ok(derived.includes(INSTANCE));
    // The original JSONL is unchanged (first patch still unresolved).
    const original = await readFile(path.join(results, "runs", RL, "raw", "vtrace", "swebench-2026-06-11.jsonl"), "utf8");
    assert.ok(original.includes('"resolved":false'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run: mock evaluator does NOT resolve ⇒ not a conversion, patch-quality-failure sentence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gp-conv-nores-"));
  try {
    const results = await makeFixture(root);
    const ev = mockEvaluator(false);
    const report = await run(cfg(results), { runProcess: ev.runProcess });
    assert.equal(report.sourcePatchResolved, false);
    assert.equal(report.repairedPatchResolved, false);
    assert.equal(report.convertedUnresolvedToResolved, false);
    assert.equal(report.interpretation, CONVERSION_NOT_RESOLVED_SENTENCE);
    assert.equal(report.policyAccountingUpdated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10/11. Required Markdown sections and JSON fields.
// ---------------------------------------------------------------------------
test("renderMarkdown emits all required sections; renderJson emits all required fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gp-conv-render-"));
  try {
    const results = await makeFixture(root);
    const report = await run(cfg(results), { runProcess: mockEvaluator(true).runProcess });

    const md = renderMarkdown(report);
    for (const section of [
      "# Stage 5 generated-parser repair conversion",
      "## Summary",
      "## Source run",
      "## Repair attempt",
      "## Repaired patch shape",
      "## Docker evaluation",
      "## Conversion result",
      "## Cost accounting",
      "## Policy accounting boundary",
      "## Non-claims",
    ]) {
      assert.ok(md.includes(section), `missing markdown section ${section}`);
    }
    assert.ok(md.includes("No Stage 5 policy accounting row was added or modified."));
    assert.ok(md.includes(CONVERSION_RESOLVED_SENTENCE));

    const parsed = JSON.parse(renderJson(report));
    for (const field of [
      "sourceRunLabel",
      "repairOutName",
      "instanceId",
      "sourcePatchResolved",
      "repairedPatchResolved",
      "convertedUnresolvedToResolved",
      "evaluationRan",
      "evaluationMethod",
      "dockerUsed",
      "evaluationError",
      "repairCostUsd",
      "criticCostUsd",
      "totalRecoveryCostUsd",
      "repairedPatchFilesChanged",
      "generatedParserTablesDeletedByRepair",
      "broadGrammarRewriteDetectedInRepair",
      "narrowGrammarReorderDetected",
      "policyAccountingUpdated",
    ]) {
      assert.ok(field in parsed, `missing JSON field ${field}`);
    }
    assert.equal(parsed.policyAccountingUpdated, false);
    assert.equal(parsed.sourceRunLabel, RL);
    assert.deepEqual(parsed.repairedPatchFilesChanged, ["astropy/units/format/cds.py"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Docker opt-out: without --run-evaluation, no eval call and resolved stays null.
// ---------------------------------------------------------------------------
test("run: without --run-evaluation no eval runs and no resolution is claimed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gp-conv-noeval-"));
  try {
    const results = await makeFixture(root);
    const ev = mockEvaluator(true);
    const report = await run(cfg(results, { runEvaluation: false }), { runProcess: ev.runProcess });
    assert.equal(ev.calls, 0); // 12. no eval invoked
    assert.equal(report.evaluationRan, false);
    assert.equal(report.repairedPatchResolved, null);
    assert.equal(report.convertedUnresolvedToResolved, false);
    // Shape analysis still ran (read-only).
    assert.equal(report.narrowGrammarReorderDetected, true);
    assert.equal(report.policyAccountingUpdated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// buildConversionReport pure-path: converted requires first=false AND repaired=true.
test("buildConversionReport: conversion is strict (any unknown ⇒ not converted)", () => {
  const base = {
    runLabel: RL,
    instanceId: INSTANCE,
    vtraceDir: "/x",
    repairEvalDir: "/x/repair_eval",
    repairedPatch: REPAIRED_DIFF,
    repairedPatchHash: "h".repeat(64),
    firstPatch: FIRST_DIFF,
    firstPatchHash: "f".repeat(64),
    repairMeta: { result: { validPatch: true, changedPatch: true, failedOpen: false, repairCostUsd: REPAIR_COST } },
    originalJsonlPath: "/x/swebench.jsonl",
    originalJsonlContent: "",
  };
  const shape = analyzeRepairedPatchShape(REPAIRED_DIFF);
  const cost = computeRecoveryCost(CRITIC_COST, REPAIR_COST);
  const mk = (firstResolved: boolean | null, repairedResolved: boolean | null) =>
    buildConversionReport({
      generatedAt: null,
      inputs: base as never,
      firstEval: { firstPatchResolved: firstResolved } as never,
      evaluation:
        repairedResolved === null
          ? null
          : ({ evaluationRan: true, dockerUsed: true, resolved: repairedResolved, evaluationError: null, command: "c", exitCode: 0 } as never),
      shape,
      cost,
      criticMeta: { criticCostUsd: CRITIC_COST },
      repairOutName: "r",
      derivedJsonlPath: "/x/repair_eval/_repaired_eval_input.jsonl",
    });
  assert.equal(mk(false, true).convertedUnresolvedToResolved, true);
  assert.equal(mk(null, true).convertedUnresolvedToResolved, false);
  assert.equal(mk(false, null).convertedUnresolvedToResolved, false);
  assert.equal(mk(true, true).convertedUnresolvedToResolved, false);
});
