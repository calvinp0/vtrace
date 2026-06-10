import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  type CliConfig,
  type ProcessResult,
  DERIVED_JSONL_NAME,
  EVAL_META_NAME,
  REPAIR_EVAL_SUBDIR,
  buildDerivedJsonl,
  buildReport,
  computeConvertedUnresolvedToResolved,
  findOriginalJsonl,
  loadRepairedEvalInputs,
  parseArgs,
  parseResolvedForInstance,
  readFirstPatchEvalEvidence,
  renderJson,
  renderMarkdown,
  run,
  runDerivedEvaluation,
  sha256,
} from "./run_stage5_repaired_patch_eval";

const INSTANCE = "sympy__sympy-16766";

const FIRST_PATCH = [
  "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py",
  "--- a/sympy/printing/pycode.py",
  "+++ b/sympy/printing/pycode.py",
  "@@ -346,6 +346,8 @@ def _print_Stream(self, strm):",
  "+    def _print_Indexed(self, expr):",
  "+        return base",
  "",
].join("\n");

const REPAIRED_PATCH = [
  "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py",
  "--- a/sympy/printing/pycode.py",
  "+++ b/sympy/printing/pycode.py",
  "@@ -360,6 +360,8 @@ class PythonCodePrinter(AbstractPythonCodePrinter):",
  "+    def _print_Indexed(self, expr):",
  "+        return relocated",
  "",
].join("\n");

function originalJsonlRow(opts: { resolved?: boolean | null } = {}): string {
  const row: Record<string, unknown> = {
    instanceId: INSTANCE,
    repo: "sympy/sympy",
    model: "claude",
    modelPatch: FIRST_PATCH,
    costUsd: 0.37,
  };
  if (opts.resolved !== undefined) row.resolved = opts.resolved;
  return `${JSON.stringify(row)}\n`;
}

const REPAIR_META = {
  enabled: true,
  runLabel: "eval-x",
  instanceId: INSTANCE,
  defectClass: "wrong_scope",
  result: { validPatch: true, changedPatch: true, failedOpen: false, repairCostUsd: 0.2 },
};

// Lay out an isolated run dir tree under a tmp results root and return the paths.
async function scaffold(opts: {
  resultsDir: string;
  runLabel: string;
  repairedPatch?: string | null;
  firstPatch?: string | null;
  repairMeta?: unknown;
  jsonl?: string | null;
  evalMeta?: unknown;
}): Promise<{ vtraceDir: string; repairDir: string }> {
  const vtraceDir = path.join(opts.resultsDir, "runs", opts.runLabel, "raw", "vtrace");
  const repairDir = path.join(vtraceDir, "repair");
  await mkdir(repairDir, { recursive: true });
  if (opts.repairedPatch !== null) await writeFile(path.join(repairDir, "_repaired_patch.diff"), opts.repairedPatch ?? REPAIRED_PATCH);
  if (opts.firstPatch !== null) await writeFile(path.join(repairDir, "_first_patch.diff"), opts.firstPatch ?? FIRST_PATCH);
  await writeFile(path.join(repairDir, "_patch_repair.meta.json"), `${JSON.stringify(opts.repairMeta ?? REPAIR_META, null, 2)}\n`);
  if (opts.jsonl !== null) await writeFile(path.join(vtraceDir, "swebench-2026-06-10.jsonl"), opts.jsonl ?? originalJsonlRow({ resolved: false }));
  if (opts.evalMeta !== undefined) await writeFile(path.join(vtraceDir, "_eval.meta.json"), `${JSON.stringify(opts.evalMeta, null, 2)}\n`);
  return { vtraceDir, repairDir };
}

async function withTmp<T>(fn: (resultsDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "repaired-eval-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function baseConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    resultsDir: "results",
    runLabel: "eval-x",
    outName: "stage5_repaired_patch_eval",
    runEvaluation: false,
    evalMode: "docker",
    evalTimeout: 1800,
    evalDataset: null,
    nodeCommand: "node",
    cliEntry: "dist/cli.js",
    vexpSweBenchDir: "/tmp/vexp",
    ...overrides,
  };
}

// 1. Loads the repaired patch artifact (and derives instance + hashes).
test("loads repaired patch artifact", async () => {
  await withTmp(async (resultsDir) => {
    await scaffold({ resultsDir, runLabel: "eval-x" });
    const inputs = await loadRepairedEvalInputs(resultsDir, "eval-x");
    assert.equal(inputs.repairedPatch, REPAIRED_PATCH);
    assert.equal(inputs.instanceId, INSTANCE);
    assert.equal(inputs.repairedPatchHash, sha256(REPAIRED_PATCH));
    assert.equal(inputs.firstPatchHash, sha256(FIRST_PATCH));
    assert.ok(inputs.originalJsonlPath.endsWith("swebench-2026-06-10.jsonl"));
  });
});

// 2. Refuses to evaluate when _repaired_patch.diff is missing or empty.
test("refuses when repaired patch missing", async () => {
  await withTmp(async (resultsDir) => {
    await scaffold({ resultsDir, runLabel: "eval-x", repairedPatch: null });
    await assert.rejects(() => loadRepairedEvalInputs(resultsDir, "eval-x"), /No repaired patch to evaluate/);
  });
});

test("refuses when repaired patch empty", async () => {
  await withTmp(async (resultsDir) => {
    await scaffold({ resultsDir, runLabel: "eval-x", repairedPatch: "   \n" });
    await assert.rejects(() => loadRepairedEvalInputs(resultsDir, "eval-x"), /missing or empty/);
  });
});

// 3. Builds the derived JSONL with modelPatch swapped, WITHOUT mutating the original.
test("builds derived JSONL without mutating the original", async () => {
  await withTmp(async (resultsDir) => {
    const { vtraceDir } = await scaffold({ resultsDir, runLabel: "eval-x" });
    const originalPath = path.join(vtraceDir, "swebench-2026-06-10.jsonl");
    const originalBefore = await readFile(originalPath, "utf8");

    const derived = buildDerivedJsonl(originalBefore, REPAIRED_PATCH);
    const derivedRow = JSON.parse(derived.trim());
    assert.equal(derivedRow.modelPatch, REPAIRED_PATCH);
    assert.equal(derivedRow.resolved, null);
    assert.equal(derivedRow.instanceId, INSTANCE);

    // Original file on disk is untouched and still carries the FIRST patch.
    const originalAfter = await readFile(originalPath, "utf8");
    assert.equal(originalAfter, originalBefore);
    assert.ok(JSON.parse(originalAfter.trim()).modelPatch.includes("return base"));
    assert.ok(!derived.includes("return base"));
  });
});

// 4. Computes patch hashes deterministically.
test("computes patch hashes", () => {
  assert.equal(sha256("abc"), sha256("abc"));
  assert.notEqual(sha256(FIRST_PATCH), sha256(REPAIRED_PATCH));
  assert.match(sha256(REPAIRED_PATCH), /^[0-9a-f]{64}$/);
});

// 5. Reads existing first-patch eval metadata when present.
test("reads existing first-patch eval metadata", async () => {
  await withTmp(async (resultsDir) => {
    const { vtraceDir } = await scaffold({
      resultsDir,
      runLabel: "eval-x",
      jsonl: originalJsonlRow({ resolved: false }),
      evalMeta: { evaluationRan: true, dockerUsed: true, resolvedCount: 0, instancesEvaluated: 1 },
    });
    const content = await readFile(path.join(vtraceDir, "swebench-2026-06-10.jsonl"), "utf8");
    const ev = await readFirstPatchEvalEvidence(vtraceDir, content, INSTANCE);
    assert.equal(ev.evalMetaPresent, true);
    assert.equal(ev.evaluationRan, true);
    assert.equal(ev.firstPatchResolved, false);
    assert.equal(ev.source, "jsonl_row");
  });
});

test("falls back to eval-meta counts when JSONL lacks resolved", async () => {
  await withTmp(async (resultsDir) => {
    const { vtraceDir } = await scaffold({
      resultsDir,
      runLabel: "eval-x",
      jsonl: originalJsonlRow(), // no resolved field
      evalMeta: { evaluationRan: true, dockerUsed: true, resolvedCount: 1, instancesEvaluated: 1 },
    });
    const content = await readFile(path.join(vtraceDir, "swebench-2026-06-10.jsonl"), "utf8");
    const ev = await readFirstPatchEvalEvidence(vtraceDir, content, INSTANCE);
    assert.equal(ev.firstPatchResolved, true);
    assert.equal(ev.source, "eval_meta_counts");
  });
});

test("first-patch evidence is null when never evaluated", async () => {
  await withTmp(async (resultsDir) => {
    const { vtraceDir } = await scaffold({ resultsDir, runLabel: "eval-x", jsonl: originalJsonlRow() });
    const content = await readFile(path.join(vtraceDir, "swebench-2026-06-10.jsonl"), "utf8");
    const ev = await readFirstPatchEvalEvidence(vtraceDir, content, INSTANCE);
    assert.equal(ev.evalMetaPresent, false);
    assert.equal(ev.firstPatchResolved, null);
    assert.equal(ev.source, "none");
  });
});

// 6. Computes convertedUnresolvedToResolved under the strict semantics.
test("computes convertedUnresolvedToResolved", () => {
  assert.equal(computeConvertedUnresolvedToResolved(false, true), true);
  assert.equal(computeConvertedUnresolvedToResolved(true, true), false); // first already resolved
  assert.equal(computeConvertedUnresolvedToResolved(false, false), false);
  assert.equal(computeConvertedUnresolvedToResolved(null, true), false); // first unknown
  assert.equal(computeConvertedUnresolvedToResolved(false, null), false); // repaired unknown
  assert.equal(computeConvertedUnresolvedToResolved(null, null), false);
});

test("parseResolvedForInstance reads the per-instance flag", () => {
  assert.equal(parseResolvedForInstance(originalJsonlRow({ resolved: false }), INSTANCE), false);
  assert.equal(parseResolvedForInstance(originalJsonlRow({ resolved: true }), INSTANCE), true);
  assert.equal(parseResolvedForInstance(originalJsonlRow(), INSTANCE), null);
  assert.equal(parseResolvedForInstance(originalJsonlRow({ resolved: false }), "other__inst-1"), null);
});

// 7. Writes report JSON/Markdown with the required fields.
test("report JSON and Markdown carry required fields", async () => {
  await withTmp(async (resultsDir) => {
    await scaffold({
      resultsDir,
      runLabel: "eval-x",
      jsonl: originalJsonlRow({ resolved: false }),
      evalMeta: { evaluationRan: true, dockerUsed: true, resolvedCount: 0, instancesEvaluated: 1 },
    });
    const runProcess = async (): Promise<ProcessResult> => ({ exitCode: 0, stdout: "", stderr: "" });
    // Mock the evaluator to mark the derived row resolved=true.
    const config = baseConfig({ resultsDir, runLabel: "eval-x", runEvaluation: true, vexpSweBenchDir: "/tmp/vexp" });
    const report = await run(config, {
      runProcess: async (command, args, options) => {
        // The evaluator mutates the derived JSONL in place; emulate that.
        const derivedPath = args[2]!;
        const content = await readFile(derivedPath, "utf8");
        const row = JSON.parse(content.trim());
        row.resolved = true;
        await writeFile(derivedPath, `${JSON.stringify(row)}\n`);
        assert.equal(options?.cwd, "/tmp/vexp");
        return runProcess();
      },
    });

    // Required JSON shape.
    const json = JSON.parse(renderJson(report));
    for (const key of ["generatedAt", "runLabel", "instanceId", "summary", "firstPatch", "repairedPatch", "evaluation", "safety", "nonClaims"]) {
      assert.ok(key in json, `missing key ${key}`);
    }
    assert.equal(json.summary.convertedUnresolvedToResolved, true);
    assert.equal(json.evaluation.resolved, true);
    assert.equal(json.safety.firstPatchReEvaluated, false);
    assert.ok(json.nonClaims.length > 0);

    // Required Markdown sections.
    const md = renderMarkdown(report);
    for (const section of [
      "## Summary",
      "## Input artifacts",
      "## Evaluation method",
      "## First patch vs repaired patch",
      "## Docker result",
      "## Safety properties",
      "## Interpretation",
      "## Non-claims",
    ]) {
      assert.ok(md.includes(section), `missing section ${section}`);
    }

    // Report + isolated artifacts were written; original JSONL untouched.
    const reportJson = await readFile(path.join(resultsDir, "stage5_repaired_patch_eval.json"), "utf8");
    assert.ok(reportJson.includes(INSTANCE));
    const meta = JSON.parse(await readFile(path.join(resultsDir, "runs", "eval-x", "raw", "vtrace", REPAIR_EVAL_SUBDIR, EVAL_META_NAME), "utf8"));
    assert.equal(meta.evaluatedPatch, "repaired");
    assert.equal(meta.resolved, true);
    const original = await readFile(path.join(resultsDir, "runs", "eval-x", "raw", "vtrace", "swebench-2026-06-10.jsonl"), "utf8");
    assert.ok(original.includes("return base"));
  });
});

// 8. Handles evaluator/Docker failure with evaluationError and no resolution.
test("records evaluationError on evaluator failure", async () => {
  const config = baseConfig({ runEvaluation: true, vexpSweBenchDir: "/tmp/vexp" });
  const failing = await runDerivedEvaluation({
    config,
    derivedJsonlPath: "/tmp/does-not-matter.jsonl",
    instanceId: INSTANCE,
    deps: { runProcess: async () => ({ exitCode: 2, stdout: "", stderr: "docker boom" }) },
  });
  assert.equal(failing.evaluationRan, false);
  assert.equal(failing.dockerUsed, false);
  assert.equal(failing.resolved, null);
  assert.match(failing.evaluationError ?? "", /exited 2: docker boom/);
});

test("passes an absolute derived-JSONL path to the evaluator (different cwd)", async () => {
  const config = baseConfig({ runEvaluation: true, vexpSweBenchDir: "/tmp/vexp" });
  let seenPath: string | undefined;
  await runDerivedEvaluation({
    config,
    derivedJsonlPath: "relative/repair_eval/_repaired_eval_input.jsonl",
    instanceId: INSTANCE,
    deps: {
      runProcess: async (_cmd, args) => {
        seenPath = args[2];
        return { exitCode: 1, stdout: "", stderr: "no file (expected)" };
      },
    },
  });
  assert.ok(seenPath !== undefined && path.isAbsolute(seenPath), `evaluator path must be absolute, got ${seenPath}`);
  assert.ok(seenPath!.endsWith("relative/repair_eval/_repaired_eval_input.jsonl"));
});

test("records evaluationError when the runner throws", async () => {
  const config = baseConfig({ runEvaluation: true });
  const thrown = await runDerivedEvaluation({
    config,
    derivedJsonlPath: "/tmp/x.jsonl",
    instanceId: INSTANCE,
    deps: {
      runProcess: async () => {
        throw new Error("spawn ENOENT");
      },
    },
  });
  assert.equal(thrown.evaluationRan, false);
  assert.match(thrown.evaluationError ?? "", /evaluator threw: spawn ENOENT/);
});

// 9. Default (no --run-evaluation) writes the derived input but NEVER calls Docker.
test("default mode writes derived input and never calls the evaluator", async () => {
  await withTmp(async (resultsDir) => {
    await scaffold({ resultsDir, runLabel: "eval-x", jsonl: originalJsonlRow({ resolved: false }) });
    let called = false;
    const config = baseConfig({ resultsDir, runLabel: "eval-x", runEvaluation: false });
    const report = await run(config, {
      runProcess: async () => {
        called = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(called, false, "evaluator must NOT be called without --run-evaluation");
    assert.equal(report.evaluation.evaluationRan, false);
    assert.equal(report.evaluation.resolved, null);
    assert.equal(report.summary.evaluationSuccess, null);
    assert.equal(report.summary.convertedUnresolvedToResolved, false);
    assert.equal(report.summary.artifactSuccess, true);

    // Derived input + metadata exist; no result file (no eval ran).
    const derived = await readFile(path.join(resultsDir, "runs", "eval-x", "raw", "vtrace", REPAIR_EVAL_SUBDIR, DERIVED_JSONL_NAME), "utf8");
    assert.ok(derived.includes("relocated"));
    assert.ok(!derived.includes("return base"));
  });
});

test("parseArgs defaults to opt-out Docker and requires nothing extra", () => {
  const cfg = parseArgs(["--results", "r", "--run-label", "lbl", "--out-name", "o"]);
  assert.equal(cfg.runEvaluation, false);
  assert.equal(cfg.runLabel, "lbl");
  assert.equal(cfg.outName, "o");
  assert.equal(cfg.evalMode, "docker");
});

test("parseArgs --run-evaluation enables Docker and validates eval-mode", () => {
  const cfg = parseArgs(["--run-label", "lbl", "--run-evaluation", "--eval-mode", "lightweight"]);
  assert.equal(cfg.runEvaluation, true);
  assert.equal(cfg.evalMode, "lightweight");
  assert.throws(() => parseArgs(["--eval-mode", "bogus"]), /docker\|lightweight/);
});

test("findOriginalJsonl returns null when absent and the newest when present", async () => {
  await withTmp(async (resultsDir) => {
    const dir = path.join(resultsDir, "v");
    await mkdir(dir, { recursive: true });
    assert.equal(await findOriginalJsonl(dir), null);
    await writeFile(path.join(dir, "swebench-2026-06-09.jsonl"), "{}\n");
    await writeFile(path.join(dir, "swebench-2026-06-10.jsonl"), "{}\n");
    const found = await findOriginalJsonl(dir);
    assert.ok(found?.endsWith("swebench-2026-06-10.jsonl"));
  });
});

test("buildReport keeps artifact, evaluation, and conversion claims independent", () => {
  const inputs = {
    runLabel: "eval-x",
    instanceId: INSTANCE,
    vtraceDir: "/v",
    repairEvalDir: "/v/repair_eval",
    repairedPatch: REPAIRED_PATCH,
    repairedPatchHash: sha256(REPAIRED_PATCH),
    firstPatch: FIRST_PATCH,
    firstPatchHash: sha256(FIRST_PATCH),
    repairMeta: REPAIR_META,
    originalJsonlPath: "/v/swebench.jsonl",
    originalJsonlContent: originalJsonlRow({ resolved: false }),
  };
  // Artifact success but evaluation not run.
  const noEval = buildReport({
    generatedAt: "t",
    inputs,
    firstEval: { evalMetaPresent: true, evaluationRan: true, dockerUsed: true, resolvedCount: 0, instancesEvaluated: 1, firstPatchResolved: false, source: "jsonl_row" },
    evaluation: null,
    requested: false,
    derivedJsonlPath: "/v/repair_eval/in.jsonl",
  });
  assert.equal(noEval.summary.artifactSuccess, true);
  assert.equal(noEval.summary.evaluationSuccess, null);
  assert.equal(noEval.summary.convertedUnresolvedToResolved, false);
});
