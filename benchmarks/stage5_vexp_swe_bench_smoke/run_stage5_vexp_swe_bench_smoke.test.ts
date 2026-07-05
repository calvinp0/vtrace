import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { deriveStructuredTaskFromProblemStatement } from "./stage5_task_derivation";
import {
  applyContextPolicyOverride,
  applyVtracePatch,
  assertVexpAllowed,
  assertVtraceInstructionsFileValid,
  buildBaselineCommand,
  buildCheckoutCommand,
  buildCloneCommand,
  prepareWorkspaceForInstance,
  gitWithRetry,
  isTransientGitError,
  isHttp2GitError,
  WorkspacePreparationError,
  GIT_RETRY_BACKOFF_MS,
  buildConditionSummaries,
  buildEvaluateCommand,
  buildInstanceQuery,
  buildVexpCommand,
  buildPivotCheckBlock,
  decidePivotCheckInjection,
  pivotCheckRiskSignals,
  strongRiskSignals,
  buildEditGuardBlock,
  detectEditGuardText,
  EDIT_GUARD_MARKER,
  buildPatchVerifyBlock,
  detectPatchVerifyText,
  PATCH_VERIFY_MARKER,
  buildToolUseDisciplineBlock,
  detectToolUseDisciplineText,
  TOOL_USE_DISCIPLINE_MARKER,
  STAGE5_TOOL_USE_DISCIPLINE_VERSION,
  buildToolUseDisciplinePatchBlock,
  hasToolUseDisciplinePatch,
  STAGE5_TOOL_USE_DISCIPLINE_MARKER,
  STAGE5_TOOL_USE_DISCIPLINE_LOG,
  stage5ToolUseDisciplineFilePath,
  toolCallSummaryFilePath,
  buildVtraceContextMarkdown,
  type VtraceContextSection,
  buildVtraceIndexCommand,
  buildVtracePatchBlock,
  buildVtraceStreamPatchBlock,
  buildVtraceDisallowedToolsPatchBlock,
  hasDisallowedToolsPatch,
  STAGE5_VTRACE_DISALLOWED_TOOLS_MARKER,
  PHASE1_READONLY_DISALLOWED_TOOLS,
  buildToolLoopGuardHookPatchBlock,
  hasToolLoopGuardHookPatch,
  STAGE5_TOOL_LOOP_GUARD_HOOK_MARKER,
  toolLoopGuardInjectionActive,
  toolLoopGuardHookCommand,
  toolLoopGuardHookSettingsFilePath,
  buildVtraceQueryCommand,
  decideIndexPolicy,
  buildVtraceCommand,
  buildCapsuleV2Task,
  buildAgentCompliance,
  capsuleModeForInstance,
  buildInjectedCapsuleV2DigestBlock,
  CAPSULE_V2_DIGEST_SENTINEL_END,
  CAPSULE_V2_DIGEST_SENTINEL_START,
  capsuleQueryTextFor,
  classifyCapsuleOutput,
  classifyCapsuleV2Output,
  classifyPivotSource,
  classifyInfraFailure,
  classifyOutcome,
  combineRunEvidence,
  comparePairs,
  decideContextPolicy,
  decideCapsuleV2ContextPolicy,
  deriveContextPolicySignals,
  deriveRunStatus,
  diagnoseConditionEvaluability,
  evaluateCondition,
  formatRunStatusBlock,
  extractCapsuleContext,
  extractInstanceContextSection,
  extractRow,
  executeRuleOutSufficiencyCorrectivePass,
  findCanonicalResultsFile,
  findSweBenchRecord,
  installVtracePatch,
  hasInstructionsPatch,
  hasStreamPatch,
  persistOrderedToolCalls,
  indexedContextMetaFields,
  readIndexedContextFromMeta,
  loadSmokeInstances,
  loadSweBenchData,
  normalizeEvaluationEvidence,
  parseArgs,
  parseResultRecords,
  prepareIndexedContext,
  rawConditionDir,
  reductionPct,
  renderCsv,
  renderMarkdown,
  stampCapsuleDiagnostics,
  runEvaluate,
  runAggregateRuns,
  runIngest,
  runPrepare,
  runBaseline,
  runProtocol,
  runVexp,
  runVtrace,
  STAGE5_VTRACE_INJECTION_LOG,
  STAGE5_VTRACE_INJECTION_SKIPPED,
  STAGE5_VTRACE_PATCH_MARKER,
  STAGE5_VTRACE_STREAM_MARKER,
  STAGE5_VTRACE_STREAM_LOG,
  STAGE5_VTRACE_STREAM_SENTINEL,
  toSweBenchInstance,
  truncateContext,
  verifyVtracePatch,
  vtraceAgentStreamFilePath,
  vtraceInstructionsFilePath,
  vtraceInstructionsSnapshotFilePath,
  workspacePathFor,
  type CapsuleAuditItem,
  type CapsuleClassification,
  type CapsulePolicyDiagnostics,
  type CapsuleV2PolicyDiagnostics,
  type CliConfig,
  type ProcessResult,
  type SweBenchInstance,
  type Stage5Row,
  type Stage5RunEvidence,
} from "./run_stage5_vexp_swe_bench_smoke";
import {
  RULEOUT_CORRECTIVE_ARTIFACT_FILES,
} from "../../src/capsuleV2/ruleoutCorrectivePass";
import type { RuleOutSufficiencyCheck } from "../../src/capsuleV2/ruleoutSufficiency";
import {
  buildIndexMeta,
  readIndexMeta,
  resolveIndexMetaPath,
  writeIndexMeta,
} from "../../src/indexer/indexMeta";
import {
  isBashTool,
  summarizeOrderedToolCalls,
  type OrderedToolCall,
} from "../../src/capsule/toolCallLog";
import { toCapsuleV2ProductResponse } from "../../src/capsuleV2/productAdapter";

// Minimal stand-in for the external vexp-swe-bench Claude Code adapter: it has
// the anchor line and the `claude -p <prompt>` args array, so the patcher can
// target it without needing the real checkout.
const FAKE_CLAUDE_ADAPTER = [
  'export class ClaudeCodeAdapter {',
  '    name = "claude-code";',
  '    async run(opts) {',
  "        const startMs = Date.now();",
  "        const args = [",
  '            "-p", opts.prompt,',
  '            "--output-format", "stream-json",',
  "        ];",
  '        const rawOutput = await spawnAgent("claude", args);',
  "        const durationMs = Date.now() - startMs;",
  "        return { args, startMs, rawOutput, durationMs };",
  "    }",
  "}",
  "",
].join("\n");

async function fakeVexpDir(): Promise<string> {
  const dir = await tmpDir("vexp-patch");
  await mkdir(path.join(dir, "dist", "agents"), { recursive: true });
  await writeFile(path.join(dir, "dist", "agents", "claude-code.js"), FAKE_CLAUDE_ADAPTER);
  return dir;
}

function baseConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    mode: "prepare",
    vexpSweBenchDir: null,
    instances: [],
    instancesFile: "benchmarks/stage5_vexp_swe_bench_smoke/smoke_instances.json",
    out: "benchmarks/stage5_vexp_swe_bench_smoke/results",
    nodeCommand: "node",
    cliEntry: "dist/cli.js",
    vtraceMethod: "instructions-file",
    yes: false,
    vtraceCommand: "bun src/cli/index.ts",
    vtraceIndexArgs: "--quiet",
    vtraceQueryArgs: "",
    skipVtraceIndexIfPresent: false,
    reuseWorkspace: false,
    indexPolicy: "auto",
    showVtraceIndexLog: false,
    vtraceContextMaxChars: 12000,
    vtraceContextMaxItems: 8,
    capsuleEngine: "legacy",
    capsuleIntent: "auto",
    capsuleBudget: 8000,
    contextPolicyOverride: "auto",
    // Mirror the production default (DEFAULT_CONFIG): omitting --pivot-check-policy
    // resolves to strict_risk_gated.
    pivotCheckPolicy: "strict_risk_gated",
    disablePivotCheck: false,
    disableToolUseDiscipline: false,
    toolLoopGuard: false,
    toolLoopGuardMode: "observe",
    toolLoopGuardCalibration: "v4",
    costGuard: false,
    costGuardMode: "observe",
    costGuardCalibration: "c7d",
    disableTokenDiscipline: false,
    sweBenchDataFile: null,
    runLabel: null,
    runLabels: null,
    protocol: "baseline",
    allowVexp: false,
    evalMode: "docker",
    evalDataset: null,
    evalTimeout: 1800,
    // M89: the env guard is mandatory for live agent runs. The generic mocked live-path
    // tests below exercise OTHER behavior (discipline/telemetry/meta) and never touch a real
    // environment, so they ride the test-only escape hatch. The dedicated mandatory-gate
    // tests override this back to false to assert the real fail-closed / pass behavior.
    allowUnguardedLiveEnv: true,
    // M90A agent-shell guard / host-pip firewall default ON (mirrors DEFAULT_CONFIG). The
    // generic mocked live tests ride the escape hatch above, so the guard is bypassed for them;
    // the dedicated M90A tests override allowUnguardedLiveEnv back to false to exercise it.
    stage5AgentShellGuard: true,
    stage5HostPipFirewall: true,
    ...overrides,
  };
}

async function tmpDir(label: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `stage5-${label}-`));
}

test("instances are parsed from the CLI", () => {
  const config = parseArgs(["--mode", "prepare", "--instances", "a__1, b__2 ,c__3"]);
  assert.deepEqual(config.instances, ["a__1", "b__2", "c__3"]);
  assert.equal(config.mode, "prepare");
});

test("invalid mode and vtrace-method are rejected", () => {
  assert.throws(() => parseArgs(["--mode", "bogus"]), /Invalid --mode/);
  assert.throws(() => parseArgs(["--vtrace-method", "bogus"]), /Invalid --vtrace-method/);
});

test("M86 env isolation guard flags parse and default off", () => {
  // Default: env guard off, drift check off, no expected prefix — no behavior change.
  const def = parseArgs(["--mode", "run-protocol"]);
  assert.equal(def.stage5EnvGuard, false);
  assert.equal(def.stage5EnvDriftCheck, false);
  assert.equal(def.expectedTestbedPrefix, null);
  // Opt-in flags flip on and the prefix flag captures its value.
  const on = parseArgs([
    "--mode", "run-protocol",
    "--stage5-env-guard",
    "--stage5-env-drift-check",
    "--expected-testbed-prefix", "/opt/miniconda3/envs/testbed",
  ]);
  assert.equal(on.stage5EnvGuard, true);
  assert.equal(on.stage5EnvDriftCheck, true);
  assert.equal(on.expectedTestbedPrefix, "/opt/miniconda3/envs/testbed");
});

test("M89 escape hatch flag parses and defaults off", () => {
  assert.equal(parseArgs(["--mode", "run-protocol"]).allowUnguardedLiveEnv, false);
  assert.equal(
    parseArgs(["--mode", "run-protocol", "--allow-unguarded-live-env"]).allowUnguardedLiveEnv,
    true,
  );
});

test("M90A agent shell guard flags default ON and disable flags turn them off", () => {
  const def = parseArgs(["--mode", "run-protocol"]);
  assert.equal(def.stage5AgentShellGuard, true);
  assert.equal(def.stage5HostPipFirewall, true);
  // Idempotent enable flags.
  assert.equal(parseArgs(["--mode", "run-protocol", "--stage5-agent-shell-guard"]).stage5AgentShellGuard, true);
  assert.equal(parseArgs(["--mode", "run-protocol", "--stage5-host-pip-firewall"]).stage5HostPipFirewall, true);
  // Emergency disable flags.
  assert.equal(parseArgs(["--mode", "run-protocol", "--disable-agent-shell-guard"]).stage5AgentShellGuard, false);
  assert.equal(parseArgs(["--mode", "run-protocol", "--disable-host-pip-firewall"]).stage5HostPipFirewall, false);
});

test("--tool-loop-guard is default-off and opt-in only (M75)", () => {
  // Default: the tool-loop guard is OFF (flag absent) — no behavior change.
  assert.equal(parseArgs(["--mode", "run-protocol"]).toolLoopGuard, false);
  // Opt-in: the flag flips it on.
  assert.equal(parseArgs(["--mode", "run-protocol", "--tool-loop-guard"]).toolLoopGuard, true);
});

test("M76 tool-loop guard mode is default-observe and injection is explicit-only", () => {
  // Default mode is observe even when nothing is passed.
  const def = parseArgs(["--mode", "run-protocol"]);
  assert.equal(def.toolLoopGuardMode, "observe");
  assert.equal(toolLoopGuardInjectionActive(def), false);
  // Bare --tool-loop-guard stays in OBSERVE mode (M75 back-compat): no runtime injection.
  const observe = parseArgs(["--mode", "run-protocol", "--tool-loop-guard"]);
  assert.equal(observe.toolLoopGuardMode, "observe");
  assert.equal(toolLoopGuardInjectionActive(observe), false);
  // --tool-loop-guard-mode observe is explicit and also enables the guard.
  const explicitObserve = parseArgs(["--mode", "run-protocol", "--tool-loop-guard-mode", "observe"]);
  assert.equal(explicitObserve.toolLoopGuard, true);
  assert.equal(explicitObserve.toolLoopGuardMode, "observe");
  assert.equal(toolLoopGuardInjectionActive(explicitObserve), false);
  // --tool-loop-guard-mode inject turns on runtime injection AND the guard.
  const inject = parseArgs(["--mode", "run-protocol", "--tool-loop-guard-mode", "inject"]);
  assert.equal(inject.toolLoopGuard, true);
  assert.equal(inject.toolLoopGuardMode, "inject");
  assert.equal(toolLoopGuardInjectionActive(inject), true);
  // Shorthand flag.
  const shorthand = parseArgs(["--mode", "run-protocol", "--tool-loop-guard-inject"]);
  assert.equal(toolLoopGuardInjectionActive(shorthand), true);
  // Invalid mode rejected.
  assert.throws(() => parseArgs(["--mode", "run-protocol", "--tool-loop-guard-mode", "bogus"]), /must be 'observe' or 'inject'/);
});

test("M79 tool-loop guard calibration defaults to v4 and is overridable to v0 (advanced)", () => {
  // Default: V4 is the enabled-guard behavior, even without an explicit flag.
  assert.equal(parseArgs(["--mode", "run-protocol"]).toolLoopGuardCalibration, "v4");
  // The advanced knob flips it to v0 for A/B comparison; it does NOT enable the guard.
  const v0 = parseArgs(["--mode", "run-protocol", "--tool-loop-guard-calibration", "v0"]);
  assert.equal(v0.toolLoopGuardCalibration, "v0");
  assert.equal(v0.toolLoopGuard, false);
  // Explicit v4 is accepted; inject mode uses whatever calibration is set (v4 default).
  const inject = parseArgs(["--mode", "run-protocol", "--tool-loop-guard-inject"]);
  assert.equal(inject.toolLoopGuardCalibration, "v4");
  assert.throws(
    () => parseArgs(["--mode", "run-protocol", "--tool-loop-guard-calibration", "v9"]),
    /must be 'v0' or 'v4'/,
  );
});

test("M84 cost-guard calibration defaults to c7d and is overridable to v0 (advanced, default-off-safe)", () => {
  // Default: c7d is the enabled-guard calibration, even with no flag — but the guard is OFF.
  const def = parseArgs(["--mode", "run-protocol"]);
  assert.equal(def.costGuardCalibration, "c7d");
  assert.equal(def.costGuard, false); // default-off invariant: calibration default never enables the guard
  // The advanced knob flips it to v0 for A/B; it does NOT enable the guard on its own.
  const v0 = parseArgs(["--mode", "run-protocol", "--cost-guard-calibration", "v0"]);
  assert.equal(v0.costGuardCalibration, "v0");
  assert.equal(v0.costGuard, false);
  // Explicit c7d is accepted; still does not enable the guard.
  const c7d = parseArgs(["--mode", "run-protocol", "--cost-guard-calibration", "c7d"]);
  assert.equal(c7d.costGuardCalibration, "c7d");
  assert.equal(c7d.costGuard, false);
  // When the guard IS enabled, the selected calibration rides along (observe + inject).
  const observe = parseArgs(["--mode", "run-protocol", "--cost-guard", "--cost-guard-calibration", "v0"]);
  assert.equal(observe.costGuard, true);
  assert.equal(observe.costGuardCalibration, "v0");
  const inject = parseArgs(["--mode", "run-protocol", "--cost-guard-inject"]);
  assert.equal(inject.costGuard, true);
  assert.equal(inject.costGuardCalibration, "c7d"); // inject mode uses the default calibration
  // Invalid value rejected.
  assert.throws(
    () => parseArgs(["--mode", "run-protocol", "--cost-guard-calibration", "c8"]),
    /must be 'v0' or 'c7d'/,
  );
});

test("--disable-pivot-check is off by default and opt-in only", () => {
  // Default: PIVOT_CHECK stays enabled (flag absent).
  assert.equal(parseArgs(["--mode", "prepare", "--instances", "a__1"]).disablePivotCheck, false);
  // Explicit flag flips it.
  assert.equal(
    parseArgs(["--mode", "prepare", "--instances", "a__1", "--disable-pivot-check"]).disablePivotCheck,
    true,
  );
});

test("--ruleout-sufficiency-check is default-off and opt-in only", () => {
  const base = parseArgs(["--mode", "prepare", "--instances", "a__1"]);
  assert.equal(base.ruleoutSufficiencyCheck, false);
  assert.equal(base.ruleoutSufficiencyCorrectivePass, false);
  const enabled = parseArgs([
    "--mode",
    "prepare",
    "--instances",
    "a__1",
    "--ruleout-sufficiency-check",
  ]);
  assert.equal(enabled.ruleoutSufficiencyCheck, true);
  assert.equal(enabled.ruleoutSufficiencyCorrectivePass, false);
  assert.equal(enabled.pivotRevisionPass, false);
  assert.equal(enabled.pivotInspectionEnforcement, false);
});

test("--ruleout-sufficiency-corrective-pass is default-off and implies the checker", () => {
  const base = parseArgs(["--mode", "prepare", "--instances", "a__1"]);
  assert.equal(base.ruleoutSufficiencyCorrectivePass, false);
  assert.equal(base.ruleoutSufficiencyCheck, false);
  const enabled = parseArgs([
    "--mode",
    "prepare",
    "--instances",
    "a__1",
    "--ruleout-sufficiency-corrective-pass",
  ]);
  assert.equal(enabled.ruleoutSufficiencyCorrectivePass, true);
  assert.equal(enabled.ruleoutSufficiencyCheck, true);
  assert.equal(enabled.pivotRevisionPass, false);
  assert.equal(enabled.pivotInspectionEnforcement, false);
  assert.equal(enabled.allowDockerVerify, false);
});

function triggeredRuleOutCheck(
  overrides: Partial<RuleOutSufficiencyCheck> = {},
): RuleOutSufficiencyCheck {
  return {
    enabled: true,
    triggered: true,
    oracleFree: true,
    evidence: [],
    missingEvidence: ["concrete output-preserving evidence"],
    correctivePromptWritten: true,
    ruledOutImplementation: "sphinx/pycode/ast.py::unparse",
    canonicalReplaced: false,
    adoptionEligible: false,
    ...overrides,
  };
}

const RULEOUT_FIRST_PATCH = [
  "diff --git a/sphinx/domains/python.py b/sphinx/domains/python.py",
  "--- a/sphinx/domains/python.py",
  "+++ b/sphinx/domains/python.py",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

test("checker-only execution does not call a corrective model", async () => {
  const dir = await tmpDir("ruleout-corrective-off");
  const canonical = path.join(dir, "swebench.jsonl");
  await writeFile(canonical, `${JSON.stringify({ modelPatch: RULEOUT_FIRST_PATCH })}\n`);
  let calls = 0;
  const result = await executeRuleOutSufficiencyCorrectivePass({
    enabled: false,
    outputDir: dir,
    canonicalResultsFile: canonical,
    checker: triggeredRuleOutCheck(),
    checkerArtifactText: "{}",
    correctivePrompt: "Inspect the paired implementation.",
    firstPassPatch: RULEOUT_FIRST_PATCH,
    runSecondPass: async () => {
      calls += 1;
      return { revisedPatch: null, correctiveResponse: null };
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.correctiveModelCallExecuted, false);
  assert.equal(result.canonicalReplaced, false);
  assert.equal(result.adoptionEligible, false);
});

test("corrective execution writes separate candidate artifacts and preserves modelPatch", async () => {
  const dir = await tmpDir("ruleout-corrective-run");
  const canonical = path.join(dir, "swebench.jsonl");
  const canonicalContent = `${JSON.stringify({ modelPatch: RULEOUT_FIRST_PATCH })}\n`;
  await writeFile(canonical, canonicalContent);
  const revised = [
    RULEOUT_FIRST_PATCH.trim(),
    "diff --git a/sphinx/pycode/ast.py b/sphinx/pycode/ast.py",
    "--- a/sphinx/pycode/ast.py",
    "+++ b/sphinx/pycode/ast.py",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  let receivedPrompt = "";
  const result = await executeRuleOutSufficiencyCorrectivePass({
    enabled: true,
    outputDir: dir,
    canonicalResultsFile: canonical,
    checker: triggeredRuleOutCheck(),
    checkerArtifactText: JSON.stringify(triggeredRuleOutCheck()),
    correctivePrompt: "Inspect the paired implementation using repository evidence.",
    firstPassPatch: RULEOUT_FIRST_PATCH,
    runSecondPass: async (prompt) => {
      receivedPrompt = prompt;
      return {
        revisedPatch: revised,
        correctiveResponse: "Revised the paired implementation from source evidence.",
      };
    },
  });
  assert.match(receivedPrompt, /First-pass patch/);
  assert.equal(result.correctiveModelCallExecuted, true);
  assert.equal(result.revisedPatchProduced, true);
  assert.equal(result.revisedPatchEditsRuledOutImplementation, true);
  assert.equal(result.canonicalPatchUnchanged, true);
  assert.equal(result.canonicalReplaced, false);
  assert.equal(result.adoptionEligible, false);
  assert.equal(await readFile(canonical, "utf8"), canonicalContent);
  assert.equal(
    await readFile(path.join(dir, RULEOUT_CORRECTIVE_ARTIFACT_FILES.revisedPatch), "utf8"),
    revised,
  );
  assert.match(
    await readFile(path.join(dir, RULEOUT_CORRECTIVE_ARTIFACT_FILES.response), "utf8"),
    /Revised the paired implementation/,
  );
  const persisted = JSON.parse(
    await readFile(path.join(dir, RULEOUT_CORRECTIVE_ARTIFACT_FILES.result), "utf8"),
  );
  assert.equal(persisted.canonicalReplaced, false);
  assert.equal(persisted.adoptionEligible, false);
});

test("missing artifacts and unsafe prompts fail closed without a second call", async () => {
  for (const sample of [
    { checker: null, checkerArtifactText: "", prompt: "", patch: "" },
    {
      checker: triggeredRuleOutCheck(),
      checkerArtifactText: "{}",
      prompt: "FAIL_TO_PASS must pass",
      patch: RULEOUT_FIRST_PATCH,
    },
  ]) {
    const dir = await tmpDir("ruleout-corrective-skip");
    let calls = 0;
    const result = await executeRuleOutSufficiencyCorrectivePass({
      enabled: true,
      outputDir: dir,
      canonicalResultsFile: null,
      checker: sample.checker,
      checkerArtifactText: sample.checkerArtifactText,
      correctivePrompt: sample.prompt,
      firstPassPatch: sample.patch,
      runSecondPass: async () => {
        calls += 1;
        return { revisedPatch: null, correctiveResponse: null };
      },
    });
    assert.equal(calls, 0);
    assert.equal(result.correctiveModelCallExecuted, false);
    assert.equal(result.revisedPatchProduced, false);
    assert.equal(result.canonicalReplaced, false);
    assert.equal(result.adoptionEligible, false);
  }
});

test("--disable-edit-guard is off by default and opt-in only", () => {
  // Default: EDIT_GUARD stays enabled (flag absent), independent of PIVOT_CHECK.
  const base = parseArgs(["--mode", "prepare", "--instances", "a__1"]);
  assert.equal(base.disableEditGuard, false);
  assert.equal(base.disablePivotCheck, false);
  // Explicit flag flips only the edit guard.
  const flagged = parseArgs(["--mode", "prepare", "--instances", "a__1", "--disable-edit-guard"]);
  assert.equal(flagged.disableEditGuard, true);
  assert.equal(flagged.disablePivotCheck, false); // EDIT_GUARD flag does not touch PIVOT_CHECK
});

test("--disable-patch-verify is off by default and opt-in only, independent of the other gates", () => {
  // Default: PATCH_VERIFY stays enabled (flag absent), independent of PIVOT_CHECK / EDIT_GUARD.
  const base = parseArgs(["--mode", "prepare", "--instances", "a__1"]);
  assert.equal(base.disablePatchVerify, false);
  assert.equal(base.disableEditGuard, false);
  assert.equal(base.disablePivotCheck, false);
  // Explicit flag flips only the patch-verify checkpoint.
  const flagged = parseArgs(["--mode", "prepare", "--instances", "a__1", "--disable-patch-verify"]);
  assert.equal(flagged.disablePatchVerify, true);
  assert.equal(flagged.disableEditGuard, false); // PATCH_VERIFY flag does not touch EDIT_GUARD
  assert.equal(flagged.disablePivotCheck, false); // ...nor PIVOT_CHECK
  // EDIT_GUARD and PATCH_VERIFY can be disabled together for a PIVOT_CHECK-only run.
  const both = parseArgs(["--mode", "prepare", "--instances", "a__1", "--disable-edit-guard", "--disable-patch-verify"]);
  assert.equal(both.disableEditGuard, true);
  assert.equal(both.disablePatchVerify, true);
  assert.equal(both.disablePivotCheck, false);
});

test("smoke_instances.json loads instances and notes", async () => {
  const dir = await tmpDir("instances");
  const file = path.join(dir, "smoke_instances.json");
  await writeFile(file, JSON.stringify({ instances: ["x__1", "y__2"], notes: ["pick small ones"] }));

  const loaded = await loadSmokeInstances(file);
  assert.deepEqual(loaded.instances, ["x__1", "y__2"]);
  assert.deepEqual(loaded.notes, ["pick small ones"]);
});

test("prepare mode writes a run plan with selected instances and commands", async () => {
  const out = path.join(await tmpDir("prepare"), "results");
  const vexpDir = await tmpDir("vexp");
  await mkdir(path.join(vexpDir, "dist"), { recursive: true });
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");

  await runPrepare(baseConfig({ vexpSweBenchDir: vexpDir, instances: ["a__1", "b__2"], out }));

  const plan = JSON.parse(await readFile(path.join(out, "run_plan.json"), "utf8"));
  assert.equal(plan.cliEntryExists, true);
  assert.equal(plan.vexpSweBenchDirExists, true);
  assert.deepEqual(plan.instances, ["a__1", "b__2"]);
  assert.equal(plan.instancesSelected, 2);
  assert.match(plan.commands.baseline, /--no-vexp/);
  assert.match(plan.commands.vtrace, /--no-vexp/);
});

test("baseline command construction includes --no-vexp", () => {
  const { command, args } = buildBaselineCommand(baseConfig({ vexpSweBenchDir: "/x", out: "/out" }), ["a__1", "b__2"]);
  assert.equal(command, "node");
  assert.ok(args.includes("--no-vexp"));
  assert.ok(args.includes("a__1,b__2"));
  assert.ok(args.some((arg) => arg.endsWith(path.join("raw", "baseline"))));
});

test("vtrace command construction does not enable vexp", () => {
  const { args } = buildVtraceCommand(baseConfig({ vexpSweBenchDir: "/x", out: "/out" }), ["a__1"]);
  assert.ok(args.includes("--no-vexp"));
  assert.ok(!args.some((arg) => arg === "--vexp" || arg === "--enable-vexp"));
  assert.ok(args.some((arg) => arg.endsWith(path.join("raw", "vtrace"))));
});

test("output parser handles JSON result files", () => {
  const content = JSON.stringify({
    results: [
      { instance_id: "a__1", resolved: true, total_tokens: 1000, cost_usd: 0.5, duration_ms: 1200, num_turns: 4 },
      { instance_id: "b__2", passed: false, input_tokens: 300, output_tokens: 200 },
    ],
  });
  const rows = parseResultRecords(content, "results.json", "baseline", "raw/baseline/results.json");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.resolved, true);
  assert.equal(rows[0]!.totalTokens, 1000);
  // total_tokens derived from input+output when absent
  assert.equal(rows[1]!.resolved, false);
  assert.equal(rows[1]!.totalTokens, 500);
});

test("output parser handles JSONL result logs", () => {
  const content = [
    JSON.stringify({ instance_id: "a__1", resolved: "pass", totalTokens: 900 }),
    "",
    JSON.stringify({ instanceId: "b__2", success: "fail", cost: "0.25" }),
  ].join("\n");
  const rows = parseResultRecords(content, "log.jsonl", "vtrace", "raw/vtrace/log.jsonl");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.resolved, true);
  assert.equal(rows[0]!.totalTokens, 900);
  assert.equal(rows[1]!.resolved, false);
  assert.equal(rows[1]!.costUsd, 0.25);
});

const REAL_VEXP_ROW = {
  instanceId: "django__django-11133",
  repo: "django/django",
  timestamp: "2026-06-03T14:19:22.819Z",
  commitHash: "879cc3da6249e920b8d54518a0ae06de835d7373",
  model: "claude-opus-4-5-20251101",
  agent: "claude-code",
  inputTokens: 111,
  outputTokens: 33,
  cacheReadTokens: 431051,
  cacheCreationTokens: 48496,
  costUsd: 0.24059975000000003,
  numTurns: 15,
  durationMs: 44730,
  toolCalls: { Grep: 1, Read: 1, Edit: 1, Bash: 2 },
  modelPatch:
    "diff --git a/django/http/response.py b/django/http/response.py\n" +
    "@@ -229,7 +229,7 @@ class HttpResponseBase:\n" +
    "-        if isinstance(value, bytes):\n" +
    "+        if isinstance(value, (bytes, memoryview)):\n",
  resolved: null,
  vexpMetrics: null,
};

test("parses the real vexp-swe-bench camelCase JSONL schema", () => {
  const content = JSON.stringify(REAL_VEXP_ROW);
  const rows = parseResultRecords(
    content,
    "swebench-2026-06-03.jsonl",
    "baseline",
    "raw/baseline/swebench-2026-06-03.jsonl",
  );
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.instanceId, "django__django-11133");
  assert.equal(row.inputTokens, 111);
  assert.equal(row.outputTokens, 33);
  assert.equal(row.cacheReadTokens, 431051);
  assert.equal(row.cacheCreationTokens, 48496);
  assert.equal(row.totalTokens, 479691);
  assert.equal(row.tokenAccountingMethod, "input+output+cache_read+cache_creation");
  assert.equal(row.costUsd, 0.24059975000000003);
  assert.equal(row.numTurns, 15);
  assert.equal(row.durationMs, 44730);
  assert.equal(row.toolCallsTotal, 5);
  assert.equal(row.patchAvailable, true);
  // resolved: null must stay "unknown" — a patch was generated but not evaluated.
  assert.equal(row.resolved, "unknown");
  assert.equal(row.parserKind, "vexp_swebench_jsonl");
  assert.equal(row.model, "claude-opus-4-5-20251101");
  assert.equal(row.agent, "claude-code");
});

test("canonical swebench-*.jsonl wins over _run.meta.json and other files", async () => {
  const out = path.join(await tmpDir("canonical"), "results");
  await mkdir(path.join(out, "raw", "baseline"), { recursive: true });
  // The real result row.
  await writeFile(
    path.join(out, "raw", "baseline", "swebench-2026-06-03.jsonl"),
    JSON.stringify(REAL_VEXP_ROW),
  );
  // Run metadata (prefixed) and a stray non-canonical export with conflicting
  // data — neither must contribute a row when the canonical log is present.
  await writeFile(path.join(out, "raw", "baseline", "_run.meta.json"), JSON.stringify({ instances: ["django__django-11133"] }));
  await writeFile(
    path.join(out, "raw", "baseline", "results.json"),
    JSON.stringify([{ instance_id: "django__django-11133", resolved: true, total_tokens: 144 }]),
  );

  const artifact = await runIngest(baseConfig({ out }));
  const baselineRows = artifact.rows.filter((row) => row.condition === "baseline");
  assert.equal(baselineRows.length, 1);
  const row = baselineRows[0]!;
  assert.equal(row.parserKind, "vexp_swebench_jsonl");
  assert.equal(row.totalTokens, 479691);
  assert.equal(row.resolved, "unknown");
  assert.match(row.rawResultPath, /swebench-2026-06-03\.jsonl$/);
});

test("missing fields become unknown, never guessed", () => {
  const row = extractRow({ instance_id: "a__1" }, "baseline", "raw/baseline/r.json")!;
  assert.equal(row.resolved, "unknown");
  assert.equal(row.costUsd, "unknown");
  assert.equal(row.durationMs, "unknown");
  assert.equal(row.totalTokens, "unknown");
  assert.equal(row.numTurns, "unknown");
  assert.equal(row.patchAvailable, "unknown");
});

test("records without an instance id are dropped", () => {
  assert.equal(extractRow({ resolved: true }, "baseline", "raw/baseline/r.json"), null);
});

test("pair outcome classification covers all categories", () => {
  assert.equal(classifyOutcome(true, true), "both_resolved");
  assert.equal(classifyOutcome(false, true), "vtrace_only_resolved");
  assert.equal(classifyOutcome(true, false), "baseline_only_resolved");
  assert.equal(classifyOutcome(false, false), "both_failed");
  assert.equal(classifyOutcome(true, null), "unpaired");
  assert.equal(classifyOutcome(null, true), "unpaired");
  assert.equal(classifyOutcome("unknown", true), "unknown");
  assert.equal(classifyOutcome(true, "unknown"), "unknown");
});

test("token/cost/duration reduction calculations", () => {
  assert.equal(reductionPct(1000, 600), 40);
  assert.ok(Math.abs(reductionPct(0.5, 0.4)! - 20) < 1e-6);
  assert.equal(reductionPct(100, 100), 0);
  // unknown / null / non-positive baseline yields null
  assert.equal(reductionPct("unknown", 100), null);
  assert.equal(reductionPct(100, "unknown"), null);
  assert.equal(reductionPct(0, 100), null);
  assert.equal(reductionPct(null, 100), null);
});

test("comparePairs joins baseline and vtrace per instance", () => {
  const rows: Stage5Row[] = [
    makeRow("a__1", "baseline", { resolved: true, totalTokens: 1000 }),
    makeRow("a__1", "vtrace", { resolved: true, totalTokens: 600 }),
  ];
  const pairs = comparePairs(rows);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.outcome, "both_resolved");
  assert.equal(pairs[0]!.tokenReductionPct, 40);
});

test("markdown report warns when the vtrace condition is absent", () => {
  const rows: Stage5Row[] = [makeRow("a__1", "baseline", { resolved: true, totalTokens: 1000 })];
  const artifact = { rows, pairs: comparePairs(rows), summary: summaryOf(rows) };
  const md = renderMarkdown(artifact as never, baseConfig());
  assert.match(md, /No vtrace condition/);
});

test("markdown report warns that the smoke result is not a public SWE-bench claim", () => {
  const artifact = { rows: [], pairs: [], summary: summaryOf([]) };
  const md = renderMarkdown(artifact as never, baseConfig());
  assert.match(md, /not a public SWE-bench claim/);
});

test("ingest reads raw outputs and writes csv/json/md reports", async () => {
  const out = path.join(await tmpDir("ingest"), "results");
  await mkdir(path.join(out, "raw", "baseline"), { recursive: true });
  await mkdir(path.join(out, "raw", "vtrace"), { recursive: true });
  await writeFile(
    path.join(out, "raw", "baseline", "results.json"),
    JSON.stringify([{ instance_id: "a__1", resolved: true, total_tokens: 1000, cost_usd: 0.5 }]),
  );
  await writeFile(
    path.join(out, "raw", "vtrace", "results.json"),
    JSON.stringify([{ instance_id: "a__1", resolved: true, total_tokens: 700, cost_usd: 0.4 }]),
  );
  // runner-written artifact must be skipped by the parser
  await writeFile(path.join(out, "raw", "baseline", "_run.meta.json"), JSON.stringify({ instances: ["a__1"] }));

  const artifact = await runIngest(baseConfig({ out }));
  assert.equal(artifact.rows.length, 2);
  assert.equal(artifact.pairs.length, 1);
  assert.equal(artifact.pairs[0]!.outcome, "both_resolved");
  assert.equal(artifact.pairs[0]!.tokenReductionPct, 30);

  const csv = await readFile(path.join(out, "stage5_vexp_swe_bench_smoke.csv"), "utf8");
  assert.match(csv.split(/\r?\n/)[0]!, /instance_id,condition,resolved/);
  assert.match(csv, /a__1,baseline,true/);
  const md = await readFile(path.join(out, "stage5_vexp_swe_bench_smoke.md"), "utf8");
  assert.match(md, /not a public SWE-bench claim/);
  assert.doesNotMatch(md, /No vtrace condition/);
});

test("applyVtracePatch inserts the injection block with marker and reads the env file", () => {
  const { content, changed } = applyVtracePatch(FAKE_CLAUDE_ADAPTER);
  assert.equal(changed, true);
  assert.ok(content.includes(STAGE5_VTRACE_PATCH_MARKER));
  assert.ok(content.includes("VTRACE_AGENT_INSTRUCTIONS_FILE"));
  assert.ok(content.includes("## Additional vtrace context/instructions"));
  assert.ok(content.includes("Stage5 vtrace instructions injected from"));
  // The block is inserted after the anchor and before the args array is built.
  const anchorIdx = content.indexOf("const startMs = Date.now();");
  const markerIdx = content.indexOf(STAGE5_VTRACE_PATCH_MARKER);
  const argsIdx = content.indexOf("const args = [");
  assert.ok(anchorIdx < markerIdx && markerIdx < argsIdx);
});

test("applyVtracePatch is idempotent", () => {
  const once = applyVtracePatch(FAKE_CLAUDE_ADAPTER);
  const twice = applyVtracePatch(once.content);
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once.content);
  // Exactly one marker pair, not two.
  const occurrences = once.content.split(STAGE5_VTRACE_PATCH_MARKER).length - 1;
  const occurrencesTwice = twice.content.split(STAGE5_VTRACE_PATCH_MARKER).length - 1;
  assert.equal(occurrences, occurrencesTwice);
});

test("applyVtracePatch throws when the anchor is missing", () => {
  assert.throws(() => applyVtracePatch("export const x = 1;\n"), /Could not find anchor/);
});

test("buildVtracePatchBlock injects under the documented marker heading", () => {
  const block = buildVtracePatchBlock();
  assert.ok(block.includes(`${STAGE5_VTRACE_PATCH_MARKER} begin`));
  assert.ok(block.includes(`${STAGE5_VTRACE_PATCH_MARKER} end`));
  // Logs to stderr (console.error), never stdout, to avoid corrupting stream-json.
  assert.ok(block.includes("console.error"));
  assert.ok(!block.includes("console.log"));
});

test("buildVtraceStreamPatchBlock dumps rawOutput to the stream env file via stderr", () => {
  const block = buildVtraceStreamPatchBlock();
  assert.ok(block.includes(`${STAGE5_VTRACE_STREAM_MARKER} begin`));
  assert.ok(block.includes(`${STAGE5_VTRACE_STREAM_MARKER} end`));
  assert.ok(block.includes("VTRACE_AGENT_STREAM_FILE"));
  assert.ok(block.includes("rawOutput"));
  // Telemetry must never touch stdout (parsed as stream-json) and never mutate opts.
  assert.ok(block.includes("console.error"));
  assert.ok(!block.includes("console.log"));
  assert.ok(!block.includes("opts.prompt"));
});

test("applyVtracePatch inserts the stream telemetry block after its anchor", () => {
  const { content, changed } = applyVtracePatch(FAKE_CLAUDE_ADAPTER);
  assert.equal(changed, true);
  assert.ok(content.includes(STAGE5_VTRACE_STREAM_MARKER));
  assert.ok(content.includes(STAGE5_VTRACE_STREAM_LOG));
  // Inserted after the durationMs anchor, where rawOutput is in scope.
  const anchorIdx = content.indexOf("const durationMs = Date.now() - startMs;");
  const streamIdx = content.indexOf(STAGE5_VTRACE_STREAM_MARKER);
  assert.ok(anchorIdx !== -1 && anchorIdx < streamIdx);
});

test("applyVtracePatch skips the optional stream block when its anchor is absent", () => {
  // An adapter with the required instructions anchor but no rawOutput/duration line.
  const minimal = [
    "export class ClaudeCodeAdapter {",
    "    async run(opts) {",
    "        const startMs = Date.now();",
    "        const args = [];",
    "        return { args };",
    "    }",
    "}",
    "",
  ].join("\n");
  const { content, changed } = applyVtracePatch(minimal);
  assert.equal(changed, true);
  // Instructions block still installed (required); stream block silently skipped.
  assert.ok(content.includes(STAGE5_VTRACE_PATCH_MARKER));
  assert.ok(!content.includes(STAGE5_VTRACE_STREAM_MARKER));
});

// ---- Phase-1 read-only enforcement (disallowed-tools patch block) ----

// A realistic adapter carrying the "Tool whitelist" anchor + the args array, so
// the disallowed-tools block has somewhere to insert.
const ADAPTER_WITH_TOOL_WHITELIST = [
  "export class ClaudeCodeAdapter {",
  '    name = "claude-code";',
  "    async run(opts) {",
  "        const startMs = Date.now();",
  "        const args = [",
  '            "-p", opts.prompt,',
  '            "--output-format", "stream-json",',
  "        ];",
  "        // Tool whitelist for SWE-bench (agent needs to write code)",
  "        if (opts.allowedTools && opts.allowedTools.length > 0) {",
  '            args.push("--allowedTools", opts.allowedTools.join(","));',
  "        }",
  '        const rawOutput = await spawnAgent("claude", args);',
  "        const durationMs = Date.now() - startMs;",
  "        return { args, rawOutput, durationMs };",
  "    }",
  "}",
  "",
].join("\n");

test("buildVtraceDisallowedToolsPatchBlock pushes --disallowedTools gated on the env var", () => {
  const block = buildVtraceDisallowedToolsPatchBlock();
  assert.ok(block.includes(STAGE5_VTRACE_DISALLOWED_TOOLS_MARKER));
  assert.ok(block.includes("process.env.VTRACE_AGENT_DISALLOWED_TOOLS"));
  assert.ok(block.includes('args.push("--disallowedTools"'));
});

test("applyVtracePatch inserts the disallowed-tools block after its anchor", () => {
  const { content, changed } = applyVtracePatch(ADAPTER_WITH_TOOL_WHITELIST);
  assert.equal(changed, true);
  assert.ok(hasDisallowedToolsPatch(content));
  // The block sits AFTER the "Tool whitelist" anchor (so `args` already exists).
  const anchorIdx = content.indexOf("// Tool whitelist for SWE-bench");
  const blockIdx = content.indexOf(STAGE5_VTRACE_DISALLOWED_TOOLS_MARKER);
  assert.ok(anchorIdx !== -1 && anchorIdx < blockIdx);
  // It is idempotent — re-applying does not duplicate the block.
  const twice = applyVtracePatch(content);
  assert.equal(twice.content, content);
});

test("applyVtracePatch skips the disallowed-tools block when its anchor is absent", () => {
  // FAKE_CLAUDE_ADAPTER has the instructions/stream anchors but no Tool-whitelist line.
  const { content } = applyVtracePatch(FAKE_CLAUDE_ADAPTER);
  assert.ok(content.includes(STAGE5_VTRACE_PATCH_MARKER));
  assert.ok(!hasDisallowedToolsPatch(content));
});

test("buildToolLoopGuardHookPatchBlock pushes --settings gated on the env var + fails closed on a missing file", () => {
  const block = buildToolLoopGuardHookPatchBlock();
  assert.ok(block.includes(STAGE5_TOOL_LOOP_GUARD_HOOK_MARKER));
  assert.ok(block.includes("process.env.VTRACE_TOOL_LOOP_GUARD_HOOK_SETTINGS"));
  assert.ok(block.includes('args.push("--settings"'));
  // Fail-closed: it only adds --settings when the settings file actually exists.
  assert.ok(block.includes("existsSync"));
});

test("applyVtracePatch inserts the M76 hook block after the tool-whitelist anchor and is idempotent", () => {
  const { content, changed } = applyVtracePatch(ADAPTER_WITH_TOOL_WHITELIST);
  assert.equal(changed, true);
  assert.ok(hasToolLoopGuardHookPatch(content));
  const anchorIdx = content.indexOf("// Tool whitelist for SWE-bench");
  const blockIdx = content.indexOf(STAGE5_TOOL_LOOP_GUARD_HOOK_MARKER);
  assert.ok(anchorIdx !== -1 && anchorIdx < blockIdx);
  // Re-applying does not duplicate the block (idempotent).
  const twice = applyVtracePatch(content);
  assert.equal(twice.content, content);
  assert.equal(twice.changed, false);
});

test("applyVtracePatch skips the M76 hook block when the tool-whitelist anchor is absent (fail-closed)", () => {
  // FAKE_CLAUDE_ADAPTER lacks the tool-whitelist line, so no --settings hook is wired.
  const { content } = applyVtracePatch(FAKE_CLAUDE_ADAPTER);
  assert.ok(content.includes(STAGE5_VTRACE_PATCH_MARKER));
  assert.ok(!hasToolLoopGuardHookPatch(content));
});

test("toolLoopGuardHookCommand points bun at the executable hook + settings file lives at the results root", () => {
  const cmd = toolLoopGuardHookCommand("node");
  assert.ok(cmd.startsWith("bun "));
  assert.ok(cmd.includes("toolLoopGuardHook.ts"));
  assert.ok(toolLoopGuardHookSettingsFilePath("/out").endsWith("_tool_loop_guard_hook_settings.json"));
});

test("PHASE1_READONLY_DISALLOWED_TOOLS denies the mutation/unsafe tools", () => {
  for (const tool of ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]) {
    assert.ok(PHASE1_READONLY_DISALLOWED_TOOLS.includes(tool), `expected ${tool} denied in Phase 1`);
  }
  // Read/search tools are NOT denied (they remain available to the preflight).
  for (const tool of ["Read", "Grep", "Glob"]) {
    assert.ok(!PHASE1_READONLY_DISALLOWED_TOOLS.includes(tool), `${tool} must stay allowed in Phase 1`);
  }
});

// An adapter patched by an OLDER harness: instructions block present, stream
// block absent, the stream anchor (durationMs) still there.
const INSTRUCTIONS_ONLY_ADAPTER = [
  "export class ClaudeCodeAdapter {",
  "    async run(opts) {",
  "        const startMs = Date.now();",
  `        // ${STAGE5_VTRACE_PATCH_MARKER} begin`,
  "        // ...instructions injection body...",
  `        // ${STAGE5_VTRACE_PATCH_MARKER} end`,
  '        const rawOutput = await spawnAgent("claude", args);',
  "        const durationMs = Date.now() - startMs;",
  "        return { rawOutput, durationMs };",
  "    }",
  "}",
  "",
].join("\n");

test("applyVtracePatch migrates the stream block into an instructions-only adapter", () => {
  assert.ok(hasInstructionsPatch(INSTRUCTIONS_ONLY_ADAPTER));
  assert.ok(!hasStreamPatch(INSTRUCTIONS_ONLY_ADAPTER));

  const { content, changed } = applyVtracePatch(INSTRUCTIONS_ONLY_ADAPTER);
  assert.equal(changed, true);
  // Stream block migrated in; instructions block NOT re-added (one begin+end pair).
  assert.ok(hasStreamPatch(content));
  assert.equal(content.split(STAGE5_VTRACE_PATCH_MARKER).length - 1, 2);
});

test("applyVtracePatch is a no-op on a fully patched adapter (neither block duplicated)", () => {
  const once = applyVtracePatch(FAKE_CLAUDE_ADAPTER);
  const twice = applyVtracePatch(once.content);
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once.content);
  assert.equal(twice.content.split(STAGE5_VTRACE_PATCH_MARKER).length - 1, 2);
  assert.equal(twice.content.split(STAGE5_VTRACE_STREAM_MARKER).length - 1, 2);
});

test("buildVtraceStreamPatchBlock writes a sentinel when rawOutput is not a string", () => {
  const block = buildVtraceStreamPatchBlock();
  // Always-write guard (no `typeof rawOutput === "string"` gate on the outer if).
  assert.ok(block.includes("if (process.env.VTRACE_AGENT_STREAM_FILE) {"));
  assert.ok(block.includes(STAGE5_VTRACE_STREAM_SENTINEL));
  assert.ok(block.includes("rawOutputType"));
});

test("persistOrderedToolCalls: missing stream file gives explicit false telemetry meta", async () => {
  const out = path.join(await tmpDir("persist-none"), "results");
  await mkdir(out, { recursive: true });
  const meta = await persistOrderedToolCalls(baseConfig({ out }), path.join(out, "raw", "vtrace"));
  assert.equal(meta.vtraceToolLogOrdered, false);
  assert.equal(meta.vtraceToolCallLogFile, null);
  assert.equal(meta.vtraceToolCallCount, null);
  assert.equal(meta.vtraceToolCallError, null);
  // No stream → checklist emission is unobservable, recorded honestly as null.
  assert.equal(meta.vtracePivotChecklistEmitted, null);
});

test("persistOrderedToolCalls: valid raw stream produces _tool_calls.json", async () => {
  const out = path.join(await tmpDir("persist-ok"), "results");
  await mkdir(out, { recursive: true });
  await writeFile(
    vtraceAgentStreamFilePath(out),
    [
      JSON.stringify({ type: "tool_use", name: "Read", input: { file_path: "sphinx/pycode/ast.py" } }),
      JSON.stringify({ type: "tool_use", name: "Grep", input: { pattern: "unparse" } }),
    ].join("\n"),
  );
  const rawDir = path.join(out, "raw", "vtrace");
  const meta = await persistOrderedToolCalls(baseConfig({ out }), rawDir);
  assert.equal(meta.vtraceToolLogOrdered, true);
  assert.equal(meta.vtraceToolCallCount, 2);
  assert.equal(meta.vtraceToolCallError, null);

  // This stream has no assistant text → no detectable PIVOT_CHECK emission.
  assert.equal(meta.vtracePivotChecklistEmitted, false);

  const log = JSON.parse(await readFile(path.join(rawDir, "_tool_calls.json"), "utf8"));
  assert.equal(log.length, 2);
  assert.equal(log[0].tool, "Read");
  assert.equal(log[0].path, "sphinx/pycode/ast.py");
  assert.equal(log[1].category, "search");
});

test("persistOrderedToolCalls: detects a PIVOT_CHECK emitted in the agent's assistant text", async () => {
  const out = path.join(await tmpDir("persist-checklist"), "results");
  await mkdir(out, { recursive: true });
  await writeFile(
    vtraceAgentStreamFilePath(out),
    [
      // A user/prompt message echoing the injected context must NOT trigger detection.
      JSON.stringify({ type: "user", message: { content: "## PIVOT_CHECK\ninspect every pivot" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "PIVOT_CHECK\n| pivot | ... | inspected | ..." }] },
      }),
      JSON.stringify({ type: "tool_use", name: "Read", input: { file_path: "sphinx/pycode/ast.py" } }),
    ].join("\n"),
  );
  const meta = await persistOrderedToolCalls(baseConfig({ out }), path.join(out, "raw", "vtrace"));
  assert.equal(meta.vtracePivotChecklistEmitted, true);
});

test("persistOrderedToolCalls: sentinel stream yields false meta with explanatory error", async () => {
  const out = path.join(await tmpDir("persist-sentinel"), "results");
  await mkdir(out, { recursive: true });
  await writeFile(
    vtraceAgentStreamFilePath(out),
    JSON.stringify({ sentinel: STAGE5_VTRACE_STREAM_SENTINEL, rawOutputType: "undefined" }),
  );
  const meta = await persistOrderedToolCalls(baseConfig({ out }), path.join(out, "raw", "vtrace"));
  assert.equal(meta.vtraceToolLogOrdered, false);
  assert.equal(meta.vtraceToolCallCount, null);
  assert.match(String(meta.vtraceToolCallError), /sentinel/i);
  // Sentinel stream carried no usable agent output → emission unobservable.
  assert.equal(meta.vtracePivotChecklistEmitted, null);
});

// --- Part A: anti-loop tool-use-discipline guidance -------------------------

test("--disable-tool-use-discipline is off by default and opt-in only", () => {
  // Default: the shared anti-loop block stays injected (flag absent).
  assert.equal(parseArgs(["--mode", "prepare", "--instances", "a__1"]).disableToolUseDiscipline, false);
  // Explicit flag flips it.
  assert.equal(
    parseArgs(["--mode", "prepare", "--instances", "a__1", "--disable-tool-use-discipline"]).disableToolUseDiscipline,
    true,
  );
});

test("buildToolUseDisciplineBlock carries the generic anti-loop guidance under its marker", () => {
  const block = buildToolUseDisciplineBlock();
  assert.ok(block.includes(TOOL_USE_DISCIPLINE_MARKER));
  assert.match(block, /Tool-use discipline:/);
  assert.match(block, /Prefer one focused search over repeated broad Bash loops\./);
  assert.match(block, /Do not run long grep\/find loops/);
  assert.match(block, /stop searching and make the smallest patch/);
  assert.match(block, /Avoid broad rewrites/);
  // Generic and fair: it names no hidden internal policy and is not vtrace-only.
  assert.doesNotMatch(block, /strict_risk_gated|PIVOT_CHECK|EDIT_GUARD|PATCH_VERIFY/);
  assert.ok(detectToolUseDisciplineText(block));
  assert.ok(!detectToolUseDisciplineText("no discipline here"));
});

test("STAGE5_TOOL_USE_DISCIPLINE_VERSION is v1", () => {
  assert.equal(STAGE5_TOOL_USE_DISCIPLINE_VERSION, "v1");
});

test("buildToolUseDisciplinePatchBlock appends the discipline file via stderr, never stdout", () => {
  const block = buildToolUseDisciplinePatchBlock();
  assert.ok(block.includes(`${STAGE5_TOOL_USE_DISCIPLINE_MARKER} begin`));
  assert.ok(block.includes(`${STAGE5_TOOL_USE_DISCIPLINE_MARKER} end`));
  assert.ok(block.includes("VTRACE_TOOL_USE_DISCIPLINE_FILE"));
  assert.ok(block.includes("opts.prompt"));
  assert.ok(block.includes(STAGE5_TOOL_USE_DISCIPLINE_LOG));
  assert.ok(block.includes("console.error"));
  assert.ok(!block.includes("console.log"));
});

test("applyVtracePatch installs the tool-use-discipline block alongside instructions and stream", () => {
  assert.ok(!hasToolUseDisciplinePatch(FAKE_CLAUDE_ADAPTER));
  const { content, changed } = applyVtracePatch(FAKE_CLAUDE_ADAPTER);
  assert.equal(changed, true);
  assert.ok(hasToolUseDisciplinePatch(content));
  assert.ok(content.includes("VTRACE_TOOL_USE_DISCIPLINE_FILE"));
  // Idempotent: re-applying does not duplicate the discipline marker.
  const twice = applyVtracePatch(content);
  assert.equal(twice.changed, false);
  assert.equal(content.split(STAGE5_TOOL_USE_DISCIPLINE_MARKER).length - 1, 2);
});

test("baseline and vtrace commands both export VTRACE_TOOL_USE_DISCIPLINE_FILE by default", () => {
  const config = baseConfig({ vexpSweBenchDir: "/x", out: "/out", instances: ["a__1"] });
  const baseline = buildBaselineCommand(config, ["a__1"]);
  const vtrace = buildVtraceCommand(config, ["a__1"]);
  const expected = stage5ToolUseDisciplineFilePath("/out");
  // Same shared block path on BOTH arms — fair to baseline and vtrace.
  assert.equal(baseline.env.VTRACE_TOOL_USE_DISCIPLINE_FILE, expected);
  assert.equal(vtrace.env.VTRACE_TOOL_USE_DISCIPLINE_FILE, expected);
  // Both arms also carry the universal telemetry stream env.
  assert.ok(baseline.env.VTRACE_AGENT_STREAM_FILE);
  assert.ok(vtrace.env.VTRACE_AGENT_STREAM_FILE);
  // Baseline gets the shared block but NOT vtrace context (kept fair, not weaker).
  assert.equal(baseline.env.VTRACE_AGENT_INSTRUCTIONS_FILE, undefined);
});

test("--disable-tool-use-discipline removes the discipline env from baseline and vtrace", () => {
  const config = baseConfig({ vexpSweBenchDir: "/x", out: "/out", instances: ["a__1"], disableToolUseDiscipline: true });
  const baseline = buildBaselineCommand(config, ["a__1"]);
  const vtrace = buildVtraceCommand(config, ["a__1"]);
  assert.equal(baseline.env.VTRACE_TOOL_USE_DISCIPLINE_FILE, undefined);
  assert.equal(vtrace.env.VTRACE_TOOL_USE_DISCIPLINE_FILE, undefined);
  // Telemetry stream env is independent of the discipline flag — still present.
  assert.ok(baseline.env.VTRACE_AGENT_STREAM_FILE);
  assert.ok(vtrace.env.VTRACE_AGENT_STREAM_FILE);
});

// Run a single condition with a mocked agent process that simulates the patched
// adapter dumping a stream-json to the shared stream file, and return the env it
// was spawned with plus the run meta the runner wrote.
async function runMockedCondition(
  config: CliConfig,
  condition: "baseline" | "vtrace",
  stream: string | null = null,
): Promise<{ env: Record<string, string> | undefined; meta: Record<string, unknown> }> {
  let capturedEnv: Record<string, string> | undefined;
  const runProcess = async (_cmd: string, _args: readonly string[], options?: { env?: Record<string, string> }) => {
    capturedEnv = options?.env;
    // Simulate the patched adapter writing its stream-json (telemetry) if asked.
    if (stream !== null) await writeFile(vtraceAgentStreamFilePath(config.out), stream);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  if (condition === "baseline") await runBaseline(config, { runProcess });
  else await runVtrace(config, { runProcess });
  const dir = rawConditionDir(config.out, condition, config.runLabel);
  const meta = JSON.parse(await readFile(path.join(dir, "_run.meta.json"), "utf8")) as Record<string, unknown>;
  return { env: capturedEnv, meta };
}

async function mockVexpCheckout(label: string): Promise<{ vexpDir: string; out: string }> {
  const vexpDir = await fakeVexpDir();
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");
  const out = path.join(await tmpDir(label), "results");
  // Install the local patch so a local-patch vtrace run is considered real (the
  // runner refuses to spawn a vtrace local-patch run with no patch installed).
  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  return { vexpDir, out };
}

// ----------------------------------------------------------------------------------------
// M89 — the env guard is MANDATORY for live agent runs. These tests exercise the real
// fail-closed / pass behavior end-to-end through runCondition (baseline), with the env
// probe/exists injected so no real conda environment is ever touched and no agent spawns.
// ----------------------------------------------------------------------------------------
const M89_TESTBED = "/home/calvin/miniforge3/envs/vexp_swebench";

function m89Probe(prefix: string, pipPrefix = prefix) {
  return {
    executable: `${prefix}/bin/python`,
    prefix,
    basePrefix: prefix,
    pipVersionLine: `pip 26.1 from ${pipPrefix}/lib/python3.12/site-packages/pip (python 3.12)`,
    condaPrefix: prefix,
  };
}

// Run a guarded baseline live run; records whether the agent process was spawned so a
// fail-closed assertion can prove the refusal happened BEFORE spawn.
async function runGuardedBaseline(
  config: CliConfig,
  probePrefix: string | null,
): Promise<{ spawned: boolean; meta: Record<string, unknown> | null; error: Error | null }> {
  let spawned = false;
  const runProcess = async () => {
    spawned = true;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const deps = {
    runProcess,
    envExistsFn: (p: string) => probePrefix !== null && p === `${probePrefix}/bin/python`,
    envProbeFn: (py: string) =>
      probePrefix !== null && py === `${probePrefix}/bin/python` ? m89Probe(probePrefix) : null,
  };
  let error: Error | null = null;
  try {
    await runBaseline(config, deps);
  } catch (e) {
    error = e as Error;
  }
  let meta: Record<string, unknown> | null = null;
  const dir = rawConditionDir(config.out, "baseline", config.runLabel);
  for (const name of ["_run.meta.json", "_env_guard.meta.json", "_agent_shell_guard.meta.json"]) {
    try {
      meta = JSON.parse(await readFile(path.join(dir, name), "utf8")) as Record<string, unknown>;
      break;
    } catch {
      meta = null;
    }
  }
  return { spawned, meta, error };
}

// (4) live run with expected prefix from the CLI flag PASSES and is benchmark-valid.
test("M89 live run with expected prefix from CLI passes the mandatory env guard", async () => {
  const { vexpDir, out } = await mockVexpCheckout("m89-cli-pass");
  const config = baseConfig({
    vexpSweBenchDir: vexpDir,
    out,
    instances: ["a__1"],
    stage5EnvGuard: true,
    stage5EnvDriftCheck: true,
    expectedTestbedPrefix: M89_TESTBED,
    allowUnguardedLiveEnv: false,
  });
  const { spawned, meta, error } = await runGuardedBaseline(config, M89_TESTBED);
  assert.equal(error, null);
  assert.equal(spawned, true);
  assert.equal(meta?.stage5_env_guard_status, "pass");
  assert.equal(meta?.stage5_env_guard_required, true);
  assert.equal(meta?.stage5_env_guard_mandatory_since, "M89");
  assert.equal(meta?.stage5_expected_testbed_prefix_source, "cli");
  assert.equal(meta?.stage5_env_guard_benchmark_valid, true);
  assert.equal(meta?.stage5_python_prefix_verified, true);
  assert.equal(meta?.stage5_pip_prefix_verified, true);
});

// (5) live run with expected prefix from the environment variable PASSES.
test("M89 live run with expected prefix from env var passes the mandatory env guard", async () => {
  const { vexpDir, out } = await mockVexpCheckout("m89-env-pass");
  const prev = process.env.VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX;
  process.env.VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX = M89_TESTBED;
  try {
    const config = baseConfig({
      vexpSweBenchDir: vexpDir,
      out,
      instances: ["a__1"],
      stage5EnvGuard: true,
      stage5EnvDriftCheck: true,
      expectedTestbedPrefix: null, // resolved from the env var instead
      allowUnguardedLiveEnv: false,
    });
    const { spawned, meta, error } = await runGuardedBaseline(config, M89_TESTBED);
    assert.equal(error, null);
    assert.equal(spawned, true);
    assert.equal(meta?.stage5_env_guard_status, "pass");
    assert.equal(meta?.stage5_expected_testbed_prefix_source, "env");
  } finally {
    if (prev === undefined) delete process.env.VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX;
    else process.env.VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX = prev;
  }
});

// (1) live run without env guard fails closed BEFORE spawn.
test("M89 live run without env guard fails closed before agent spawn", async () => {
  const { vexpDir, out } = await mockVexpCheckout("m89-noguard");
  const config = baseConfig({
    vexpSweBenchDir: vexpDir,
    out,
    instances: ["a__1"],
    stage5EnvGuard: false,
    stage5EnvDriftCheck: true,
    expectedTestbedPrefix: M89_TESTBED,
    allowUnguardedLiveEnv: false,
  });
  const { spawned, error, meta } = await runGuardedBaseline(config, M89_TESTBED);
  assert.ok(error, "expected a fail-closed throw");
  assert.match(error!.message, /FAILED CLOSED/);
  assert.match(error!.message, /--stage5-env-guard/);
  assert.equal(spawned, false);
  // Env metadata for the failure is still emitted.
  assert.equal(meta?.stage5_env_guard_required, true);
  assert.equal(meta?.stage5_env_guard_status, "fail");
});

// (2) live run without drift check fails closed BEFORE spawn.
test("M89 live run without drift check fails closed before agent spawn", async () => {
  const { vexpDir, out } = await mockVexpCheckout("m89-nodrift");
  const config = baseConfig({
    vexpSweBenchDir: vexpDir,
    out,
    instances: ["a__1"],
    stage5EnvGuard: true,
    stage5EnvDriftCheck: false,
    expectedTestbedPrefix: M89_TESTBED,
    allowUnguardedLiveEnv: false,
  });
  const { spawned, error } = await runGuardedBaseline(config, M89_TESTBED);
  assert.ok(error, "expected a fail-closed throw");
  assert.match(error!.message, /--stage5-env-drift-check/);
  assert.equal(spawned, false);
});

// (3) live run without an expected prefix fails closed with clear fix instructions.
test("M89 live run without expected prefix fails closed with fix instructions", async () => {
  const { vexpDir, out } = await mockVexpCheckout("m89-noprefix");
  const prev = process.env.VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX;
  delete process.env.VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX;
  try {
    const config = baseConfig({
      vexpSweBenchDir: vexpDir,
      out,
      instances: ["a__1"],
      stage5EnvGuard: true,
      stage5EnvDriftCheck: true,
      expectedTestbedPrefix: null,
      allowUnguardedLiveEnv: false,
    });
    const { spawned, error } = await runGuardedBaseline(config, M89_TESTBED);
    assert.ok(error, "expected a fail-closed throw");
    assert.match(error!.message, /--expected-testbed-prefix/);
    assert.match(error!.message, /VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX/);
    assert.equal(spawned, false);
  } finally {
    if (prev !== undefined) process.env.VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX = prev;
  }
});

// (8) a wrong-prefix interpreter (resolves to base) fails closed before spawn.
test("M89 wrong-prefix python fails closed before agent spawn", async () => {
  const { vexpDir, out } = await mockVexpCheckout("m89-wrongprefix");
  const config = baseConfig({
    vexpSweBenchDir: vexpDir,
    out,
    instances: ["a__1"],
    stage5EnvGuard: true,
    stage5EnvDriftCheck: true,
    expectedTestbedPrefix: M89_TESTBED,
    allowUnguardedLiveEnv: false,
  });
  // Interpreter EXISTS at the expected path but PROBES as the base prefix — contamination vector.
  let spawned = false;
  const deps = {
    runProcess: async () => {
      spawned = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    envExistsFn: (p: string) => p === `${M89_TESTBED}/bin/python`,
    envProbeFn: () => m89Probe("/home/calvin/miniforge3"),
  };
  await assert.rejects(() => runBaseline(config, deps), /FAILED CLOSED/);
  assert.equal(spawned, false);
});

// (9) a pip-prefix mismatch fails closed before spawn.
test("M89 pip-prefix mismatch fails closed before agent spawn", async () => {
  const { vexpDir, out } = await mockVexpCheckout("m89-pipmismatch");
  const config = baseConfig({
    vexpSweBenchDir: vexpDir,
    out,
    instances: ["a__1"],
    stage5EnvGuard: true,
    stage5EnvDriftCheck: true,
    expectedTestbedPrefix: M89_TESTBED,
    allowUnguardedLiveEnv: false,
  });
  let spawned = false;
  const deps = {
    runProcess: async () => {
      spawned = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    envExistsFn: (p: string) => p === `${M89_TESTBED}/bin/python`,
    // sys.prefix is the testbed but pip writes to the BASE prefix — mismatch must fail closed.
    envProbeFn: () => m89Probe(M89_TESTBED, "/home/calvin/miniforge3"),
  };
  await assert.rejects(() => runBaseline(config, deps), /FAILED CLOSED/);
  assert.equal(spawned, false);
});

// (10) targeting a base/dev prefix as the expected prefix fails closed before spawn.
test("M89 base-prefix target fails closed before agent spawn", async () => {
  const { vexpDir, out } = await mockVexpCheckout("m89-basetarget");
  const base = "/home/calvin/miniforge3";
  const config = baseConfig({
    vexpSweBenchDir: vexpDir,
    out,
    instances: ["a__1"],
    stage5EnvGuard: true,
    stage5EnvDriftCheck: true,
    expectedTestbedPrefix: base, // expected prefix IS the conda base — must be refused
    allowUnguardedLiveEnv: false,
  });
  const { spawned, error } = await runGuardedBaseline(config, base);
  assert.ok(error, "expected a fail-closed throw");
  assert.match(error!.message, /FAILED CLOSED/);
  assert.equal(spawned, false);
});

// (6/13) the escape hatch lets a live run proceed unguarded, but the run is recorded as
// NOT benchmark-valid (and the guard status is not a clean pass).
test("M89 escape hatch proceeds unguarded but is never benchmark-valid", async () => {
  const { vexpDir, out } = await mockVexpCheckout("m89-escape");
  const config = baseConfig({
    vexpSweBenchDir: vexpDir,
    out,
    instances: ["a__1"],
    stage5EnvGuard: false, // no guard configured...
    stage5EnvDriftCheck: false,
    expectedTestbedPrefix: null,
    allowUnguardedLiveEnv: true, // ...but the escape hatch is set
  });
  const { spawned, meta, error } = await runGuardedBaseline(config, null);
  assert.equal(error, null);
  assert.equal(spawned, true); // proceeds
  assert.equal(meta?.stage5_env_guard_required, true);
  assert.equal(meta?.stage5_unguarded_live_env_allowed, true);
  assert.equal(meta?.stage5_env_guard_benchmark_valid, false);
});

// ----------------------------------------------------------------------------------------
// M90A — agent-shell guard / host-pip firewall: mandatory live-run integration through
// runCondition (baseline). The env guard is satisfied (clean testbed prefix injected) so the
// run reaches the M90A layer; the shell guard materializes a REAL per-run wrapper bin in the
// temp out dir (no agent spawns, no conda mutation).
// ----------------------------------------------------------------------------------------

// (1) a guarded live run materializes the shell guard and PASSES (benchmark-valid path).
test("M90A live run materializes the agent shell guard and passes", async () => {
  const { vexpDir, out } = await mockVexpCheckout("m90a-pass");
  const config = baseConfig({
    vexpSweBenchDir: vexpDir,
    out,
    instances: ["a__1"],
    stage5EnvGuard: true,
    stage5EnvDriftCheck: true,
    expectedTestbedPrefix: M89_TESTBED,
    allowUnguardedLiveEnv: false,
  });
  const { spawned, meta, error } = await runGuardedBaseline(config, M89_TESTBED);
  assert.equal(error, null);
  assert.equal(spawned, true);
  assert.equal(meta?.stage5_agent_shell_guard_required, true);
  assert.equal(meta?.stage5_agent_shell_guard_enabled, true);
  assert.equal(meta?.stage5_host_pip_firewall_enabled, true);
  assert.equal(meta?.stage5_agent_shell_guard_status, "pass");
  assert.equal(meta?.stage5_agent_path_sanitized, true);
  assert.equal(meta?.stage5_agent_shell_guard_mandatory_since, "M90A");
  // The wrapper bin lives under the run dir and `pip` resolves to it (not host/base pip).
  const wrapperBin = meta?.stage5_agent_wrapper_bin as string;
  assert.ok(wrapperBin && wrapperBin.includes("_vtrace_agent_bin"));
  const pipWrapper = await readFile(path.join(wrapperBin, "pip"), "utf8");
  assert.match(pipWrapper, /VTRACE_HOST_PIP_BLOCKED/);
});

// (2) missing shell guard FAILS CLOSED before agent spawn (env guard already satisfied).
test("M90A live run with the shell guard disabled fails closed before spawn", async () => {
  const { vexpDir, out } = await mockVexpCheckout("m90a-noshell");
  const config = baseConfig({
    vexpSweBenchDir: vexpDir,
    out,
    instances: ["a__1"],
    stage5EnvGuard: true,
    stage5EnvDriftCheck: true,
    expectedTestbedPrefix: M89_TESTBED,
    allowUnguardedLiveEnv: false,
    stage5AgentShellGuard: false, // disabled ⇒ fail closed at the M90A layer
  });
  const { spawned, meta, error } = await runGuardedBaseline(config, M89_TESTBED);
  assert.ok(error, "expected a fail-closed throw");
  assert.match(error!.message, /M90A.*FAILED CLOSED/s);
  assert.equal(spawned, false);
  assert.equal(meta?.stage5_agent_shell_guard_required, true);
  assert.equal(meta?.stage5_agent_shell_guard_status, "fail");
});

// (3) escape hatch proceeds unguarded but the shell guard is NOT applied (never benchmark-valid).
test("M90A escape hatch proceeds with the shell guard bypassed", async () => {
  const { vexpDir, out } = await mockVexpCheckout("m90a-escape");
  const config = baseConfig({
    vexpSweBenchDir: vexpDir,
    out,
    instances: ["a__1"],
    stage5EnvGuard: false,
    stage5EnvDriftCheck: false,
    expectedTestbedPrefix: null,
    allowUnguardedLiveEnv: true,
  });
  const { spawned, meta, error } = await runGuardedBaseline(config, null);
  assert.equal(error, null);
  assert.equal(spawned, true);
  assert.equal(meta?.stage5_agent_shell_guard_status, "fail");
  assert.match(String(meta?.stage5_agent_shell_guard_failure_reason), /bypassed/);
  // No wrapper bin materialized on the bypass path.
  assert.equal(meta?.stage5_agent_wrapper_bin, null);
});

test("baseline run writes the shared discipline file, exports the env, and records injected metadata", async () => {
  const { vexpDir, out } = await mockVexpCheckout("baseline-discipline");
  const config = baseConfig({ vexpSweBenchDir: vexpDir, out, instances: ["a__1"] });
  const { env, meta } = await runMockedCondition(config, "baseline");

  // Discipline file written at the results root and the env points at it.
  const disciplineFile = stage5ToolUseDisciplineFilePath(out);
  assert.equal(env?.VTRACE_TOOL_USE_DISCIPLINE_FILE, disciplineFile);
  const written = await readFile(disciplineFile, "utf8");
  assert.ok(detectToolUseDisciplineText(written));

  // Metadata records the injection and version even on the baseline arm.
  assert.equal(meta.stage5ToolUseDisciplineInjected, true);
  assert.equal(meta.stage5ToolUseDisciplineVersion, "v1");
  assert.equal(meta.stage5ToolUseDisciplineDisabledByFlag, false);
});

test("vtrace run records tool-use-discipline metadata injected=true and version", async () => {
  const { vexpDir, out } = await mockVexpCheckout("vtrace-discipline");
  const config = baseConfig({ vexpSweBenchDir: vexpDir, out, vtraceMethod: "local-patch", instances: ["a__1"] });
  const { env, meta } = await runMockedCondition(config, "vtrace");
  assert.equal(env?.VTRACE_TOOL_USE_DISCIPLINE_FILE, stage5ToolUseDisciplineFilePath(out));
  assert.equal(meta.stage5ToolUseDisciplineInjected, true);
  assert.equal(meta.stage5ToolUseDisciplineVersion, "v1");
});

test("--disable-tool-use-discipline records injected=false, disabledByFlag=true, and writes no discipline file env", async () => {
  const { vexpDir, out } = await mockVexpCheckout("disabled-discipline");
  const config = baseConfig({ vexpSweBenchDir: vexpDir, out, instances: ["a__1"], disableToolUseDiscipline: true });
  const { env, meta } = await runMockedCondition(config, "baseline");
  assert.equal(env?.VTRACE_TOOL_USE_DISCIPLINE_FILE, undefined);
  assert.equal(meta.stage5ToolUseDisciplineInjected, false);
  assert.equal(meta.stage5ToolUseDisciplineVersion, null);
  assert.equal(meta.stage5ToolUseDisciplineDisabledByFlag, true);
});

// --- Part B: universal ordered telemetry ------------------------------------

test("ordered telemetry artifacts are written for a mocked baseline run", async () => {
  const { vexpDir, out } = await mockVexpCheckout("baseline-telemetry");
  const config = baseConfig({ vexpSweBenchDir: vexpDir, out, instances: ["a__1"] });
  const stream = [
    JSON.stringify({ type: "tool_use", name: "Read", input: { file_path: "pkg/mod.py" } }),
    JSON.stringify({ type: "tool_use", name: "Grep", input: { pattern: "foo" } }),
  ].join("\n");
  await runMockedCondition(config, "baseline", stream);

  const dir = rawConditionDir(out, "baseline", null);
  const log = JSON.parse(await readFile(path.join(dir, "_tool_calls.json"), "utf8"));
  assert.equal(log.length, 2);
  const summary = JSON.parse(await readFile(toolCallSummaryFilePath(dir), "utf8"));
  assert.equal(summary.orderedTelemetryAvailable, true);
  assert.equal(summary.condition, "baseline");
  assert.equal(summary.instanceId, "a__1");
  assert.equal(summary.totalToolCalls, 2);
  assert.equal(summary.fileReadToolCalls, 1);
  assert.equal(summary.grepLikeToolCalls, 1);
});

test("ordered telemetry artifacts are written for a mocked vtrace run", async () => {
  const { vexpDir, out } = await mockVexpCheckout("vtrace-telemetry");
  const config = baseConfig({ vexpSweBenchDir: vexpDir, out, vtraceMethod: "local-patch", instances: ["a__1"] });
  const stream = JSON.stringify({ type: "tool_use", name: "Edit", input: { file_path: "pkg/mod.py" } });
  const { meta } = await runMockedCondition(config, "vtrace", stream);

  const dir = rawConditionDir(out, "vtrace", null);
  const summary = JSON.parse(await readFile(toolCallSummaryFilePath(dir), "utf8"));
  assert.equal(summary.orderedTelemetryAvailable, true);
  assert.equal(summary.condition, "vtrace");
  assert.equal(summary.fileWriteToolCalls, 1);
  // The vtrace meta still carries the existing ordered-log fields.
  assert.equal(meta.vtraceToolLogOrdered, true);
  assert.equal(meta.orderedTelemetryAvailable, true);
});

test("a mocked run with no stream-json records orderedTelemetryAvailable=false with a legacy reason", async () => {
  const { vexpDir, out } = await mockVexpCheckout("legacy-telemetry");
  const config = baseConfig({ vexpSweBenchDir: vexpDir, out, instances: ["a__1"] });
  await runMockedCondition(config, "baseline", null);
  const dir = rawConditionDir(out, "baseline", null);
  const summary = JSON.parse(await readFile(toolCallSummaryFilePath(dir), "utf8"));
  assert.equal(summary.orderedTelemetryAvailable, false);
  assert.equal(summary.missingReason, "legacy-run-no-stream-json");
});

test("summarizeOrderedToolCalls computes bash/search/file counts and unique files", () => {
  const calls: OrderedToolCall[] = [
    { index: 0, tool: "Read", category: "read", path: "a.py", query: null, args: {}, output_summary: null },
    { index: 1, tool: "Read", category: "read", path: "a.py", query: null, args: {}, output_summary: null },
    { index: 2, tool: "Grep", category: "search", path: null, query: "foo", args: {}, output_summary: null },
    { index: 3, tool: "Edit", category: "edit", path: "b.py", query: null, args: {}, output_summary: null },
    { index: 4, tool: "Bash", category: "other", path: null, query: null, args: {}, output_summary: null },
  ];
  const summary = summarizeOrderedToolCalls(calls);
  assert.equal(summary.totalToolCalls, 5);
  assert.equal(summary.bashToolCalls, 1);
  assert.equal(summary.grepLikeToolCalls, 1);
  assert.equal(summary.fileReadToolCalls, 2);
  assert.equal(summary.fileWriteToolCalls, 1);
  assert.equal(summary.uniqueFilesTouchedByTools, 2); // a.py, b.py
  assert.equal(summary.orderedTelemetryAvailable, true);
  // unavailable → all zero, both heuristics false.
  const empty = summarizeOrderedToolCalls([], false);
  assert.equal(empty.totalToolCalls, 0);
  assert.equal(empty.orderedTelemetryAvailable, false);
  assert.equal(empty.longBashLoopHeuristic, false);
});

test("loop heuristics are diagnostic only: long bash loop and repeated search", () => {
  const bash = (i: number): OrderedToolCall => ({ index: i, tool: "Bash", category: "other", path: null, query: null, args: {}, output_summary: null });
  const grep = (i: number, q: string): OrderedToolCall => ({ index: i, tool: "Grep", category: "search", path: null, query: q, args: {}, output_summary: null });

  // 8 bash calls trips longBashLoop.
  const longBash = summarizeOrderedToolCalls(Array.from({ length: 8 }, (_v, i) => bash(i)));
  assert.equal(longBash.bashToolCalls, 8);
  assert.equal(longBash.longBashLoopHeuristic, true);
  assert.equal(longBash.repeatedSearchHeuristic, false);

  // 5 distinct greps trips repeatedSearch by count.
  const manyGreps = summarizeOrderedToolCalls(Array.from({ length: 5 }, (_v, i) => grep(i, `q${i}`)));
  assert.equal(manyGreps.repeatedSearchHeuristic, true);

  // 2 identical greps trips repeatedSearch by repeated pattern (below the count floor).
  const repeated = summarizeOrderedToolCalls([grep(0, "same"), grep(1, "same")]);
  assert.equal(repeated.grepLikeToolCalls, 2);
  assert.equal(repeated.repeatedSearchHeuristic, true);
});

test("isBashTool recognizes shell-family tools and rejects file tools", () => {
  assert.ok(isBashTool("Bash"));
  assert.ok(isBashTool("shell"));
  assert.ok(isBashTool("run_command"));
  assert.ok(!isBashTool("Read"));
  assert.ok(!isBashTool("Grep"));
});

test("install-vtrace-patch patches the fixture, backs it up, and writes a manifest", async () => {
  const vexpDir = await fakeVexpDir();
  const out = path.join(await tmpDir("patch-out"), "results");
  const target = path.join(vexpDir, "dist", "agents", "claude-code.js");

  const manifest = await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  assert.equal(manifest.installed, true);
  assert.equal(manifest.patchMarker, STAGE5_VTRACE_PATCH_MARKER);
  assert.deepEqual(manifest.patchedFiles, [target]);

  // Target file now carries both patch blocks.
  const patched = await readFile(target, "utf8");
  assert.ok(hasInstructionsPatch(patched));
  assert.ok(hasStreamPatch(patched));

  // Backup created and equals the pristine original.
  const backup = await readFile(`${target}.stage5-vtrace-backup`, "utf8");
  assert.equal(backup, FAKE_CLAUDE_ADAPTER);
  assert.deepEqual(manifest.backupFiles, [`${target}.stage5-vtrace-backup`]);

  // Manifest persisted to the results dir.
  const onDisk = JSON.parse(await readFile(path.join(out, "vtrace_patch_manifest.json"), "utf8"));
  assert.equal(onDisk.installed, true);
  assert.equal(onDisk.vexpSweBenchDir, vexpDir);
});

test("install-vtrace-patch is idempotent and never overwrites an existing backup", async () => {
  const vexpDir = await fakeVexpDir();
  const out = path.join(await tmpDir("patch-out2"), "results");
  const target = path.join(vexpDir, "dist", "agents", "claude-code.js");

  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  // Tamper the backup to prove a second install does not clobber it.
  await writeFile(`${target}.stage5-vtrace-backup`, "SENTINEL ORIGINAL\n");
  const manifest = await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));

  assert.ok(manifest.notes.some((note) => /already present/i.test(note)));
  const backup = await readFile(`${target}.stage5-vtrace-backup`, "utf8");
  assert.equal(backup, "SENTINEL ORIGINAL\n");
  // Neither marker pair is duplicated after re-install (begin+end => 2 occurrences each).
  const patched = await readFile(target, "utf8");
  assert.equal(patched.split(STAGE5_VTRACE_PATCH_MARKER).length - 1, 2);
  assert.equal(patched.split(STAGE5_VTRACE_STREAM_MARKER).length - 1, 2);
});

test("verify-vtrace-patch detects the marker before and after install", async () => {
  const vexpDir = await fakeVexpDir();
  const out = path.join(await tmpDir("verify-out"), "results");

  const before = await verifyVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  assert.equal(before.installed, false);
  assert.equal(before.backupPresent, false);

  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  const after = await verifyVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  assert.equal(after.installed, true);
  assert.equal(after.backupPresent, true);
  assert.equal(after.manifestPresent, true);
});

test("run-vtrace --vtrace-method local-patch fails fast when the patch is missing", async () => {
  const vexpDir = await fakeVexpDir();
  // Provide a fake CLI entry so the missing-patch guard (not a missing-CLI error) is what fires.
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");
  const out = path.join(await tmpDir("run-vtrace"), "results");

  let spawned = false;
  const runProcess = async () => {
    spawned = true;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const config = baseConfig({ vexpSweBenchDir: vexpDir, out, vtraceMethod: "local-patch", instances: ["a__1"] });
  await assert.rejects(() => runVtrace(config, { runProcess }), /local vtrace patch to be installed first/);
  // Guard must fire before any agent process is spawned (no tokens spent).
  assert.equal(spawned, false);
});

test("run-vtrace --vtrace-method local-patch proceeds once the patch is installed", async () => {
  const vexpDir = await fakeVexpDir();
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");
  const out = path.join(await tmpDir("run-vtrace2"), "results");
  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));

  let spawned = false;
  const runProcess = async () => {
    spawned = true;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const config = baseConfig({ vexpSweBenchDir: vexpDir, out, vtraceMethod: "local-patch", instances: ["a__1"] });
  await runVtrace(config, { runProcess });
  assert.equal(spawned, true);
});

test("install/verify-vtrace-patch modes are accepted by the CLI parser", () => {
  assert.equal(parseArgs(["--mode", "install-vtrace-patch"]).mode, "install-vtrace-patch");
  assert.equal(parseArgs(["--mode", "verify-vtrace-patch"]).mode, "verify-vtrace-patch");
});

test("README documents the instructions-file no-op risk and recommends local-patch", async () => {
  const readme = await readFile(path.join(import.meta.dir, "README.md"), "utf8");
  assert.match(readme, /no-op/i);
  assert.match(readme, /local-patch/);
  assert.match(readme, /install-vtrace-patch/);
  assert.match(readme, /verify-vtrace-patch/);
});

// Write a condition's raw artifacts: a canonical swebench result row plus the
// runner-written _run.meta.json / _run.stderr.txt that ingest reads for evidence.
async function seedCondition(
  out: string,
  condition: "baseline" | "vtrace" | "vexp",
  opts: {
    resolved?: boolean | null;
    vtraceMethod?: string | null;
    instructionsFile?: string;
    stderr?: string;
    indexedContext?: boolean;
    contextFileContent?: string;
    metaExtra?: Record<string, unknown>;
    instanceId?: string;
    inputTokens?: number;
    outputTokens?: number;
    runLabel?: string | null;
  } = {},
): Promise<void> {
  const root = opts.runLabel ? path.join(out, "runs", opts.runLabel) : out;
  const dir = path.join(root, "raw", condition);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "swebench-2026-06-03.jsonl"),
    JSON.stringify({
      instanceId: opts.instanceId ?? "django__django-11133",
      inputTokens: opts.inputTokens ?? 100,
      outputTokens: opts.outputTokens ?? 50,
      modelPatch: "diff --git a/x b/x\n+patch\n",
      resolved: opts.resolved ?? null,
    }),
  );
  const meta: Record<string, unknown> = {
    condition,
    vtraceMethod: opts.vtraceMethod ?? null,
    exitCode: 0,
    ...(opts.indexedContext === undefined ? {} : { vtraceIndexedContext: opts.indexedContext }),
    ...(opts.metaExtra ?? {}),
  };
  if (opts.instructionsFile) meta.env = { VTRACE_AGENT_INSTRUCTIONS_FILE: opts.instructionsFile };
  await writeFile(path.join(dir, "_run.meta.json"), JSON.stringify(meta, null, 2));
  if (opts.stderr !== undefined) await writeFile(path.join(dir, "_run.stderr.txt"), opts.stderr);
  // When provided, write the context file at the results root (where the
  // instructions/context file actually lives), so ingest sees it exists.
  if (opts.contextFileContent !== undefined) {
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, "_vtrace_instructions.md"), opts.contextFileContent);
  }
}

test("report uses the recorded vtrace run metadata method, not the config default", async () => {
  const out = path.join(await tmpDir("evidence-method"), "results");
  await seedCondition(out, "baseline", { vtraceMethod: null });
  await seedCondition(out, "vtrace", { vtraceMethod: "local-patch", instructionsFile: "/tmp/_vtrace_instructions.md" });

  // Config requests the default instructions-file; the run actually used local-patch.
  const artifact = await runIngest(baseConfig({ out, vtraceMethod: "instructions-file" }));
  assert.equal(artifact.evidence.vtraceMethod, "local-patch");
  assert.equal(artifact.evidence.vtraceInstructionsFile, "/tmp/_vtrace_instructions.md");

  const md = await readFile(path.join(out, "stage5_vexp_swe_bench_smoke.md"), "utf8");
  assert.match(md, /vtrace method \(recorded\): local-patch/);
  assert.match(md, /vtrace method \(requested\): instructions-file/);
});

test("disagreeing recorded methods are reported as mixed, never the default", async () => {
  const out = path.join(await tmpDir("evidence-mixed"), "results");
  await seedCondition(out, "baseline", { vtraceMethod: "mcp" });
  await seedCondition(out, "vtrace", { vtraceMethod: "local-patch" });
  const artifact = await runIngest(baseConfig({ out, vtraceMethod: "instructions-file" }));
  assert.equal(artifact.evidence.vtraceMethod, "mixed");
});

test("local-patch run writes the instruction file and exports VTRACE_AGENT_INSTRUCTIONS_FILE", async () => {
  const vexpDir = await fakeVexpDir();
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");
  const out = path.join(await tmpDir("vtrace-env"), "results");
  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));

  let capturedEnv: Record<string, string> | undefined;
  const runProcess = async (_cmd: string, _args: readonly string[], options?: { env?: Record<string, string> }) => {
    capturedEnv = options?.env;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const config = baseConfig({ vexpSweBenchDir: vexpDir, out, vtraceMethod: "local-patch", instances: ["a__1"] });
  await runVtrace(config, { runProcess });

  // The env exports the instructions file path at the results ROOT (NOT under
  // raw/vtrace, which vexp wipes), and that file exists & is non-empty pre-spawn.
  const expectedFile = vtraceInstructionsFilePath(out);
  assert.equal(expectedFile, path.join(out, "_vtrace_instructions.md"));
  assert.equal(capturedEnv?.VTRACE_AGENT_INSTRUCTIONS_FILE, expectedFile);
  assert.equal(capturedEnv?.VTRACE_METHOD, "local-patch");
  const instructions = await readFile(expectedFile, "utf8");
  assert.match(instructions, /vtrace instructions/i);
  assert.match(instructions, /running with vtrace assistance/i);
  assert.ok(instructions.length > 0);
});

test("injection log in captured vtrace stderr sets vtrace_injection_observed = true", async () => {
  const out = path.join(await tmpDir("evidence-observed"), "results");
  await seedCondition(out, "baseline", {});
  await seedCondition(out, "vtrace", {
    vtraceMethod: "local-patch",
    stderr: `${STAGE5_VTRACE_INJECTION_LOG} /tmp/_vtrace_instructions.md\n`,
  });
  const artifact = await runIngest(baseConfig({ out }));
  assert.equal(artifact.evidence.vtraceInjectionObserved, true);
});

test("missing injection marker under local-patch produces a markdown warning", async () => {
  const out = path.join(await tmpDir("evidence-missing"), "results");
  await seedCondition(out, "baseline", {});
  await seedCondition(out, "vtrace", { vtraceMethod: "local-patch", stderr: "some unrelated stderr output\n" });
  const artifact = await runIngest(baseConfig({ out }));
  assert.equal(artifact.evidence.vtraceInjectionObserved, false);

  const md = await readFile(path.join(out, "stage5_vexp_swe_bench_smoke.md"), "utf8");
  assert.match(md, /⚠️ Warning/);
  assert.match(md, /local-patch/);
  assert.match(md, /no runtime injection was observed/i);
});

test("an unknown/unknown resolved pair is described as patch-generation smoke, not pass/fail", async () => {
  const out = path.join(await tmpDir("smoke-mode"), "results");
  await seedCondition(out, "baseline", { resolved: null });
  await seedCondition(out, "vtrace", { resolved: null, vtraceMethod: "local-patch", stderr: `${STAGE5_VTRACE_INJECTION_LOG} /x\n` });
  const artifact = await runIngest(baseConfig({ out }));

  // Both unknown -> the pair outcome is "unknown", never a pass/fail verdict.
  assert.equal(artifact.pairs.length, 1);
  assert.equal(artifact.pairs[0]!.outcome, "unknown");

  const md = await readFile(path.join(out, "stage5_vexp_swe_bench_smoke.md"), "utf8");
  assert.match(md, /paired patch-generation smoke, not evaluated pass\/fail/);
});

test("assertVtraceInstructionsFileValid fails fast on a missing or empty file", async () => {
  const dir = await tmpDir("instr-valid");
  const missing = path.join(dir, "nope.md");
  await assert.rejects(() => assertVtraceInstructionsFileValid(missing), /missing/);

  const empty = path.join(dir, "empty.md");
  await writeFile(empty, "");
  await assert.rejects(() => assertVtraceInstructionsFileValid(empty), /empty/);

  const ok = path.join(dir, "ok.md");
  await writeFile(ok, "# vtrace instructions\n");
  await assertVtraceInstructionsFileValid(ok); // does not throw
});

test("run-vtrace local-patch writes a non-empty instruction file and validates it before spawn", async () => {
  const vexpDir = await fakeVexpDir();
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");
  const out = path.join(await tmpDir("instr-prespawn"), "results");
  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));

  // The instruction file must exist and be non-empty at the moment of spawn —
  // assert it from inside the runProcess stub, before the (fake) CLI returns.
  let sizeAtSpawn = -1;
  const runProcess = async () => {
    const stats = await stat(vtraceInstructionsFilePath(out)).catch(() => null);
    sizeAtSpawn = stats?.size ?? -1;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const config = baseConfig({ vexpSweBenchDir: vexpDir, out, vtraceMethod: "local-patch", instances: ["a__1"] });
  await runVtrace(config, { runProcess });
  assert.ok(sizeAtSpawn > 0, "instruction file should be present and non-empty when the external CLI is spawned");
});

test("vtrace stderr 'injected from' sets vtrace_injection_observed=true and treatment valid", async () => {
  const out = path.join(await tmpDir("inj-true"), "results");
  await seedCondition(out, "baseline", { resolved: null });
  await seedCondition(out, "vtrace", {
    resolved: null,
    vtraceMethod: "local-patch",
    stderr: `${STAGE5_VTRACE_INJECTION_LOG} ${out}/_vtrace_instructions.md\n`,
  });
  const artifact = await runIngest(baseConfig({ out }));
  assert.equal(artifact.evidence.vtraceInjectionObserved, true);
  assert.equal(artifact.evidence.vtraceTreatmentValid, true);

  const vtraceRow = artifact.rows.find((row) => row.condition === "vtrace")!;
  assert.equal(vtraceRow.vtraceInjectionObserved, true);
  assert.equal(vtraceRow.vtraceTreatmentValid, true);
  assert.equal(vtraceRow.vtraceMethod, "local-patch");
});

test("vtrace stderr 'injection skipped' sets vtrace_treatment_valid=false and records the error", async () => {
  const out = path.join(await tmpDir("inj-skip"), "results");
  const skipLine = `${STAGE5_VTRACE_INJECTION_SKIPPED}: ENOENT: no such file or directory, open '/gone/_vtrace_instructions.md'`;
  await seedCondition(out, "baseline", { resolved: null });
  await seedCondition(out, "vtrace", { resolved: null, vtraceMethod: "local-patch", stderr: `${skipLine}\n` });
  const artifact = await runIngest(baseConfig({ out }));

  assert.equal(artifact.evidence.vtraceInjectionObserved, false);
  assert.equal(artifact.evidence.vtraceTreatmentValid, false);
  assert.equal(artifact.evidence.vtraceInjectionError, skipLine);

  const vtraceRow = artifact.rows.find((row) => row.condition === "vtrace")!;
  assert.equal(vtraceRow.vtraceTreatmentValid, false);
  assert.equal(vtraceRow.vtraceInjectionError, skipLine);
});

test("an invalid local-patch treatment produces a markdown warning and suppresses deltas", async () => {
  const out = path.join(await tmpDir("invalid-treat"), "results");
  await seedCondition(out, "baseline", { resolved: null });
  await seedCondition(out, "vtrace", {
    resolved: null,
    vtraceMethod: "local-patch",
    stderr: `${STAGE5_VTRACE_INJECTION_SKIPPED}: ENOENT\n`,
  });
  await runIngest(baseConfig({ out }));

  const md = await readFile(path.join(out, "stage5_vexp_swe_bench_smoke.md"), "utf8");
  assert.match(md, /Vtrace injection was skipped; this run is not a valid vtrace treatment\./);
  // Efficiency deltas must not be advertised as vtrace performance.
  assert.match(md, /\| invalid \|/);
});

// ----- Stage 5B: indexed-context -----

const SAMPLE_RECORD = {
  repo: "django/django",
  instance_id: "django__django-11728",
  base_commit: "abc123def456",
  problem_statement: "replace_named_groups does not handle trailing groups",
  hints_text: "look at admindocs utils",
  FAIL_TO_PASS: '["tests.admin_docs.test_utils.TestUtils.test_replace_named_groups"]',
};

function sampleInstance(): SweBenchInstance {
  return toSweBenchInstance(SAMPLE_RECORD);
}

// A navigation-heavy instance (composed queries / SQL compiler): the cost-aware
// gate injects context for these when the capsule has strong pivot evidence.
const NAV_RECORD = {
  repo: "django/django",
  instance_id: "django__django-11490",
  base_commit: "abc123def456",
  problem_statement:
    "Composed queries cannot change the list of columns with values()/values_list(). The combinator "
    + "querysets in django/db/models/sql/compiler.py reuse the first query's columns.",
  hints_text: "See django/db/models/query.py and the SQL compiler for composed queries.",
  FAIL_TO_PASS: '["tests.queries.test_qs_combinators.QuerySetSetOperationTests.test_union_values_list"]',
};

// A capsule --json inject payload for a navigation-heavy task: real context plus
// strong pivot evidence, so the gate injects it.
function injectCapsuleJson(context: string, pivotCount = 3, supportCount = 4): string {
  return JSON.stringify({
    diagnostics: { recommended_mode: "full", actual_mode: "full", pivot_count: pivotCount, support_count: supportCount },
    context,
  });
}

// A capsule --json inject payload for a small/local task: real micro context but
// the cost-aware gate should still decline to inject it (net overhead).
function microCapsuleJson(context: string): string {
  return JSON.stringify({
    diagnostics: { recommended_mode: "micro", actual_mode: "micro", pivot_count: 1, support_count: 0 },
    context,
  });
}

// A Capsule v2 `--json` payload (the CapsuleV2Result shape): a top-level
// pivots/support array + actual_mode and NO rendered `context` string — so the
// runner must render the injectable context from the result itself. A
// "no_context" actual_mode models the v2 no-pivot skip.
function capsuleV2Json(
  opts: {
    actualMode?: string;
    pivotSymbol?: string;
    pivotPath?: string;
    pivotCount?: number;
    reason?: string;
    // When set, the pivot renders its FOCUSED SOURCE BODY (content_mode "full")
    // instead of a signature — the case the Stage 5 injection must preserve.
    pivotSource?: string;
    // Optional support items, always rendered signature-only (never a body).
    support?: ReadonlyArray<{ path?: string; symbol?: string; signature?: string }>;
    // Policy-evidence diagnostics: how many edit-risk directives fired, and whether
    // the line-anchor / SQL-rendering recovery routes ran. Default 0/false.
    editRiskDirectives?: number;
    lineAnchorResolutionUsed?: boolean;
    sqlRenderingBackfillUsed?: boolean;
  } = {},
): string {
  const actualMode = opts.actualMode ?? "full";
  // Build the optional policy-evidence diagnostics block, present only when set so
  // the default fixture stays minimal (and exercises the "absent → 0/false" path).
  const editRiskCount = opts.editRiskDirectives ?? 0;
  const policyDiagnostics: Record<string, unknown> = {};
  if (editRiskCount > 0) {
    policyDiagnostics.edit_risk_directives = Array.from({ length: editRiskCount }, () => ({
      kind: "guarded_shared_state_mutation", confidence: "high",
      reason: "pivot mutates shared state under a guard", directive: "clone before mutating",
    }));
  }
  if (opts.lineAnchorResolutionUsed) policyDiagnostics.line_anchor_resolution_used = true;
  if (opts.sqlRenderingBackfillUsed) policyDiagnostics.sql_rendering_backfill_used = true;
  const base = {
    intent: "debug",
    budget: { max_tokens: 8000, estimated_tokens: actualMode === "no_context" ? 0 : 1200, used_percent: 15 },
    discarded: [],
  };
  if (actualMode === "no_context") {
    return JSON.stringify({
      ...base,
      actual_mode: "no_context",
      reason: opts.reason ?? "no high-confidence edit target recovered",
      pivots: [],
      support: [],
      diagnostics: {
        intent_confidence: "low", intent_reason: [], strategy: { role_policy: "debug_refinement" },
        candidate_count: 3, pivot_count: 0, support_count: 0, discarded_count: 3, tier: "no_context",
        weights: {}, likely_files: [], likely_symbols: [], failing_tests: [],
      },
    });
  }
  const pivotPath = opts.pivotPath ?? "django/db/models/sql/compiler.py";
  const pivotSymbol = opts.pivotSymbol ?? "get_combinator_sql";
  // With a source body → render in "full" content mode (carries `source`);
  // otherwise the legacy default of a signature-only pivot (no body).
  const pivot = opts.pivotSource !== undefined
    ? {
        role: "pivot", role_reason: "sql rendering implementation", path: pivotPath,
        fq_name: `SQLCompiler.${pivotSymbol}`, symbol: pivotSymbol, kind: "method",
        content_mode: "full", source: opts.pivotSource,
        signature: `def ${pivotSymbol}(self, combinator, all)`,
        evidence: ["named in the issue", "on the failing test's call path"], scorecard: {}, estimated_tokens: 1200,
      }
    : {
        role: "pivot", role_reason: "sql rendering implementation", path: pivotPath,
        fq_name: `SQLCompiler.${pivotSymbol}`, symbol: pivotSymbol, kind: "method",
        content_mode: "signature", signature: `def ${pivotSymbol}(self, combinator, all)`,
        evidence: ["named in the issue", "on the failing test's call path"], scorecard: {}, estimated_tokens: 1200,
      };
  const support = (opts.support ?? []).map((item) => ({
    role: "support",
    role_reason: "query-construction API entry point",
    path: item.path ?? "django/db/models/query.py",
    fq_name: `QuerySet.${item.symbol ?? "values_list"}`,
    symbol: item.symbol ?? "values_list",
    kind: "method",
    content_mode: "signature",
    signature: item.signature ?? `def ${item.symbol ?? "values_list"}(self, *fields)`,
    evidence: ["query construction entry point"], scorecard: {}, estimated_tokens: 120,
  }));
  return JSON.stringify({
    ...base,
    actual_mode: actualMode,
    pivots: [pivot],
    support,
    diagnostics: {
      intent_confidence: "high", intent_reason: ["failing test names a compiler symbol"],
      strategy: { role_policy: "debug_refinement" }, candidate_count: 5,
      pivot_count: opts.pivotCount ?? 1, support_count: support.length, discarded_count: 4, tier: actualMode,
      weights: {}, likely_files: [pivotPath], likely_symbols: [pivotSymbol], failing_tests: [],
      ...policyDiagnostics,
    },
  });
}

async function writeSweBenchData(dir: string, records: object[]): Promise<string> {
  const file = path.join(dir, "swe-bench-100.jsonl");
  await writeFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

test("loads instance data from JSONL and finds a selected record", async () => {
  const dir = await tmpDir("swe-data");
  const file = await writeSweBenchData(dir, [
    { ...SAMPLE_RECORD, instance_id: "django__django-0001" },
    SAMPLE_RECORD,
  ]);
  const records = await loadSweBenchData(file);
  assert.equal(records.length, 2);
  const found = findSweBenchRecord(records, "django__django-11728");
  assert.ok(found);
  assert.equal((found as { repo: string }).repo, "django/django");
  assert.equal(findSweBenchRecord(records, "missing__instance"), null);
});

test("toSweBenchInstance maps fields and fails clearly when required fields are missing", () => {
  const instance = sampleInstance();
  assert.equal(instance.instanceId, "django__django-11728");
  assert.equal(instance.repo, "django/django");
  assert.equal(instance.baseCommit, "abc123def456");
  assert.deepEqual(instance.failToPass, [
    "tests.admin_docs.test_utils.TestUtils.test_replace_named_groups",
  ]);
  assert.throws(
    () => toSweBenchInstance({ instance_id: "x__1", repo: "a/b" }),
    /missing required field\(s\): base_commit, problem_statement/,
  );
});

test("workspace path is derived from the instance id (and optional run label)", () => {
  assert.equal(
    workspacePathFor("/out", "django__django-11728"),
    path.join("/out", "workspaces", "django__django-11728"),
  );
  assert.equal(
    workspacePathFor("/out", "django__django-11728", "runA"),
    path.join("/out", "workspaces", "runA", "django__django-11728"),
  );
});

test("clone/checkout commands are built from instance data", () => {
  const clone = buildCloneCommand("django/django", "/ws");
  assert.equal(clone.command, "git");
  // --progress forces git to emit clone progress even when stderr is piped (tee'd).
  assert.deepEqual(clone.args, ["clone", "--progress", "https://github.com/django/django.git", "/ws"]);
  const checkout = buildCheckoutCommand("/ws", "abc123");
  assert.deepEqual(checkout.args, ["-C", "/ws", "checkout", "abc123", "--force"]);
});

test("vtrace index/query commands embed the workspace and query", () => {
  const config = baseConfig({ vtraceCommand: "bun src/cli/index.ts", vtraceIndexArgs: "--quiet", vtraceQueryArgs: "--json" });
  const index = buildVtraceIndexCommand(config, "/ws");
  assert.equal(index.command, "bun");
  // --quiet is always dropped now (index progress is always surfaced).
  assert.deepEqual(index.args, ["src/cli/index.ts", "index", "/ws"]);
  const query = buildVtraceQueryCommand(config, "/ws", "fix the bug");
  assert.deepEqual(query.args, ["src/cli/index.ts", "capsule", "/ws", "fix the bug", "--json"]);
});

test("buildInstanceQuery uses the problem statement plus repo/instance/test signals", () => {
  const query = buildInstanceQuery(sampleInstance());
  assert.match(query, /replace_named_groups does not handle trailing groups/);
  assert.match(query, /repo: django\/django/);
  assert.match(query, /instance: django__django-11728/);
  assert.match(query, /failing tests:/);
});

test("buildVtraceQueryCommand requests a compact JSON capsule when a mode is given", () => {
  const config = baseConfig({ vtraceCommand: "bun src/cli/index.ts", vtraceQueryArgs: "" });
  const query = buildVtraceQueryCommand(config, "/ws", "fix the bug", "micro");
  assert.deepEqual(query.args, [
    "src/cli/index.ts", "capsule", "/ws", "fix the bug", "--mode", "micro", "--json",
  ]);
});

// ----- Stage 5: --capsule-engine (Capsule v2 wiring) -----

test("--capsule-engine legacy builds a capsule command with --mode (no v2 flags)", () => {
  const config = baseConfig({ vtraceCommand: "bun src/cli/index.ts", vtraceQueryArgs: "", capsuleEngine: "legacy" });
  const query = buildVtraceQueryCommand(config, "/ws", "fix the bug", "full");
  assert.deepEqual(query.args, [
    "src/cli/index.ts", "capsule", "/ws", "fix the bug", "--mode", "full", "--json",
  ]);
  assert.ok(!query.args.includes("--intent"));
  assert.ok(!query.args.includes("--budget"));
});

test("--capsule-engine v2 builds a capsule command with --intent and --budget", () => {
  const config = baseConfig({
    vtraceCommand: "bun src/cli/index.ts", vtraceQueryArgs: "",
    capsuleEngine: "v2", capsuleIntent: "auto", capsuleBudget: 8000,
  });
  // The legacy `mode` argument is supplied but MUST be ignored under v2.
  const query = buildVtraceQueryCommand(config, "/ws", "fix the bug", "full");
  assert.deepEqual(query.args, [
    "src/cli/index.ts", "capsule", "/ws", "fix the bug", "--intent", "auto", "--budget", "8000", "--pivot-neighborhood", "--json",
  ]);
});

test("--capsule-engine v2 never passes a legacy --mode flag", () => {
  const config = baseConfig({ capsuleEngine: "v2", capsuleIntent: "debug", capsuleBudget: 12000 });
  const query = buildVtraceQueryCommand(config, "/ws", "task", "micro");
  assert.ok(!query.args.includes("--mode"));
  assert.ok(query.args.includes("--intent"));
  assert.ok(query.args.includes("debug"));
  assert.ok(query.args.includes("--budget"));
  assert.ok(query.args.includes("12000"));
});

test("--capsule-engine and capsule v2 knobs parse and reject bad values", () => {
  // Migration: Capsule v2 is the DEFAULT injected engine.
  assert.equal(parseArgs(["--mode", "prepare"]).capsuleEngine, "v2");
  const cfg = parseArgs(["--capsule-engine", "v2", "--capsule-intent", "debug", "--capsule-budget", "6000"]);
  assert.equal(cfg.capsuleEngine, "v2");
  assert.equal(cfg.capsuleIntent, "debug");
  assert.equal(cfg.capsuleBudget, 6000);
  // Legacy can be forced explicitly via either `legacy` or the `v1` alias.
  assert.equal(parseArgs(["--capsule-engine", "legacy"]).capsuleEngine, "legacy");
  assert.equal(parseArgs(["--capsule-engine", "v1"]).capsuleEngine, "legacy");
  assert.equal(parseArgs(["--capsule-engine", "v1"]).capsuleEngine, "legacy");
  assert.throws(() => parseArgs(["--capsule-engine", "bogus"]), /Invalid --capsule-engine/);
  assert.throws(() => parseArgs(["--capsule-intent", "bogus"]), /Invalid --capsule-intent/);
  assert.throws(() => parseArgs(["--capsule-budget", "0"]), /--capsule-budget requires a positive integer/);
});

test("--capsule-intent maps through the shared normalized vocabulary (incl. modify/explain)", () => {
  // Every concrete intent the shared model supports must parse and flow through to
  // the spawned `capsule --intent` command verbatim — the Stage 5 flag is not a
  // narrower, drifting whitelist.
  for (const intent of ["auto", "debug", "modify", "refactor", "impact", "explain", "test-failure"] as const) {
    const cfg = parseArgs(["--capsule-engine", "v2", "--capsule-intent", intent]);
    assert.equal(cfg.capsuleIntent, intent, `--capsule-intent ${intent} must parse`);
    const query = buildVtraceQueryCommand(baseConfig({ ...cfg }), "/ws", "task", "full");
    const idx = query.args.indexOf("--intent");
    assert.ok(idx >= 0, `expected --intent in command for ${intent}`);
    assert.equal(query.args[idx + 1], intent, `--intent value must match for ${intent}`);
  }
});

test("capsuleQueryTextFor returns the shared structured task for v2 and the packed query for legacy", () => {
  const instance = sampleInstance();
  const v2Task = capsuleQueryTextFor(baseConfig({ capsuleEngine: "v2" }), instance);
  // M104: the v2 task IS the shared M103 structured derivation — byte-identical
  // to the deterministic scoreboard/fixture task for the same problem statement.
  assert.equal(v2Task, buildCapsuleV2Task(instance));
  assert.equal(v2Task, deriveStructuredTaskFromProblemStatement(instance.problemStatement).taskText);
  assert.match(v2Task, /replace_named_groups does not handle trailing groups/);
  // Model-invisible metadata never enters the task: no instance/repo header, no
  // hidden FAIL_TO_PASS test ids, no hints, no evaluation labels.
  assert.doesNotMatch(v2Task, /instance: |repo: /);
  assert.doesNotMatch(v2Task, /failing tests:|hints:/);
  assert.ok(!v2Task.includes("test_replace_named_groups"));
  assert.ok(!v2Task.includes("look at admindocs utils"));
  assert.doesNotMatch(v2Task, /resolved|gold|FAIL_TO_PASS|condition/);

  const legacy = capsuleQueryTextFor(baseConfig({ capsuleEngine: "legacy" }), instance);
  assert.equal(legacy, buildInstanceQuery(instance));
});

test("buildCapsuleV2Task never uses the full problem statement as the task", () => {
  // A long multi-paragraph issue with a traceback: the structured derivation keeps
  // the title + first prose sentence + extracted evidence, NOT the raw dump.
  const statement = [
    "Combinator querysets drop values_list() columns",
    "",
    "When composing querysets with union() the column list is reused from the first query.",
    "This is a longer paragraph of prose that the structured derivation must not include verbatim. ".repeat(20),
    "Traceback (most recent call last):",
    '  File "django/db/models/sql/compiler.py", line 428, in get_combinator_sql',
    "ValueError: too many values to unpack",
  ].join("\n");
  const instance = toSweBenchInstance({
    ...SAMPLE_RECORD,
    problem_statement: statement,
    PASS_TO_PASS: '["tests.queries.test_qs_combinators.QuerySetSetOperationTests.test_union"]',
    patch: "diff --git a/django/db/models/sql/compiler.py b/django/db/models/sql/compiler.py",
  });
  const task = buildCapsuleV2Task(instance);
  assert.equal(task, deriveStructuredTaskFromProblemStatement(statement).taskText);
  assert.notEqual(task, statement);
  assert.ok(!task.includes("longer paragraph of prose that the structured derivation must not include verbatim. This"));
  assert.ok(task.length <= 1200);
  // Structured evidence extracted FROM the issue is kept…
  assert.match(task, /ValueError/);
  assert.match(task, /compiler\.py/);
  // …while hidden benchmark metadata (FAIL_TO_PASS / PASS_TO_PASS / gold patch)
  // never reaches the task, even when present on the raw record.
  assert.ok(!task.includes("test_replace_named_groups"));
  assert.ok(!task.includes("test_union"));
  assert.ok(!task.includes("diff --git"));
});

test("assembled model-visible context excludes FAIL_TO_PASS / hints even when the instance carries them", () => {
  const instance = sampleInstance();
  const classification = classifyCapsuleV2Output(JSON.parse(capsuleV2Json()));
  const section: VtraceContextSection = {
    instance,
    rawContext: classification.context,
    error: null,
    classification,
    preformatted: true,
  };
  const { markdown } = buildVtraceContextMarkdown([section], {
    maxChars: 12000,
    maxItems: 8,
    pivotCheckPolicy: "off",
    injectTokenDiscipline: true,
  });
  // The injected file carries attribution (id/repo/base_commit) + retrieved
  // context + policy blocks — never the hidden test labels or issue hints.
  assert.match(markdown, /instance_id: django__django-11728/);
  assert.ok(!markdown.includes("test_replace_named_groups"));
  assert.ok(!markdown.includes("FAIL_TO_PASS"));
  assert.ok(!markdown.includes("PASS_TO_PASS"));
  assert.ok(!markdown.includes("look at admindocs utils"));
  assert.ok(!markdown.includes("failing tests:"));
});

test("classifyCapsuleV2Output injects rendered context for a pivot and skips no_context", () => {
  const inject = classifyCapsuleV2Output(JSON.parse(capsuleV2Json()));
  assert.equal(inject.policyAction, "inject");
  assert.equal(inject.contextInjected, true);
  assert.equal(inject.pivotCount, 1);
  assert.equal(inject.actualCapsuleMode, "full");
  // The injectable text is the v2 human render (pivot path::symbol + signature).
  assert.match(inject.context, /get_combinator_sql/);
  assert.match(inject.context, /compiler\.py/);

  const skip = classifyCapsuleV2Output(JSON.parse(capsuleV2Json({ actualMode: "no_context", reason: "no pivot" })));
  assert.equal(skip.policyAction, "skip");
  assert.equal(skip.contextInjected, false);
  assert.equal(skip.actualCapsuleMode, "no_context");
  assert.match(skip.skipReason ?? "", /no pivot/);
});

test("classifyCapsuleV2Output appends the pivot-neighborhood block to injected context", () => {
  // Simulate the `--pivot-neighborhood` capsule output: the result carries a
  // bounded pivot_neighborhood array, which must be rendered into the injected
  // context so the agent actually receives the neighbor excerpts.
  const result = JSON.parse(capsuleV2Json({ pivotSymbol: "get_combinator_sql" }));
  result.pivot_neighborhood = [
    {
      pivot: { path: "django/db/models/sql/compiler.py", symbol: "get_combinator_sql", fqName: "SQLCompiler.get_combinator_sql" },
      excerpts: [
        {
          filePath: "django/db/models/sql/query.py", symbol: "Query", fqName: "Query.combine",
          startLine: 10, endLine: 14, text: "def combine(self, other):\n    return other", reason: "caller", truncated: false,
        },
      ],
    },
  ];
  const inject = classifyCapsuleV2Output(result);
  assert.equal(inject.policyAction, "inject");
  // The compact, guidance-only inspect-first block leads the injected context.
  assert.match(inject.context, /VTRACE inspect-first/);
  assert.ok(
    inject.context.indexOf("VTRACE inspect-first") < inject.context.indexOf("intent:"),
    "inspect-first leads the injected context",
  );
  // The neighborhood header and the neighbor REFERENCE line are present...
  assert.match(inject.context, /Pivot neighborhood/);
  assert.match(inject.context, /caller: Query\.combine/);
  // ...but the excerpt BODY is no longer inlined (compacted; full body stays in
  // the structured pivotNeighborhood data for reporting).
  assert.doesNotMatch(inject.context, /def combine/);
});

test("classifyCapsuleV2Output omits the neighborhood block when none was emitted", () => {
  // A pre-neighborhood result (no pivot_neighborhood field) injects no block.
  const inject = classifyCapsuleV2Output(JSON.parse(capsuleV2Json({ pivotSymbol: "get_combinator_sql" })));
  assert.doesNotMatch(inject.context, /Pivot neighborhood/);
});

test("classifyCapsuleOutput routes a Capsule v2 payload to the v2 classifier", () => {
  const classified = classifyCapsuleOutput(capsuleV2Json({ pivotSymbol: "get_combinator_sql" }));
  assert.equal(classified.policyAction, "inject");
  assert.match(classified.context, /get_combinator_sql/);
});

// --- M55W: opt-in Capsule v2 digest injection (default-off measurability seam) ---

test("M55W: default classify (no --inject-capsule-digest) omits the digest sentinel", () => {
  const result = JSON.parse(capsuleV2Json({ pivotSymbol: "get_combinator_sql" }));
  // Default (no options) and an explicit injectDigest:false both reproduce the
  // pre-M55W injected context — no sentinel either way.
  for (const inject of [
    classifyCapsuleV2Output(result),
    classifyCapsuleV2Output(result, { injectDigest: false, query: "q" }),
  ]) {
    assert.equal(inject.policyAction, "inject");
    assert.doesNotMatch(inject.context, new RegExp(CAPSULE_V2_DIGEST_SENTINEL_START));
    assert.doesNotMatch(inject.context, new RegExp(CAPSULE_V2_DIGEST_SENTINEL_END));
  }
});

test("M55W: glyph/budget markers are NOT a reliable digest signal — only the sentinel is", () => {
  // The pre-M55 renderCapsuleV2Human output already carries ● and `budget:`; a
  // validator keying on those would false-positive on a non-digest run.
  const inject = classifyCapsuleV2Output(
    JSON.parse(capsuleV2Json({ pivotSource: "def get_combinator_sql(self): ..." })),
  );
  assert.match(inject.context, /●/); // glyph present pre-M55
  assert.match(inject.context, /budget:/); // budget line present pre-M55
  assert.doesNotMatch(inject.context, new RegExp(CAPSULE_V2_DIGEST_SENTINEL_START)); // but NOT a digest run
});

test("M55W: injectDigest prepends the sentinel-wrapped product digest, leading the context", () => {
  const result = JSON.parse(capsuleV2Json({ pivotSymbol: "get_combinator_sql" }));
  const query = "combinator SQL output is wrong";
  const inject = classifyCapsuleV2Output(result, { injectDigest: true, query });

  assert.equal(inject.policyAction, "inject");
  // Sentinel block is present...
  assert.match(inject.context, new RegExp(CAPSULE_V2_DIGEST_SENTINEL_START));
  assert.match(inject.context, new RegExp(CAPSULE_V2_DIGEST_SENTINEL_END));
  // ...and leads the injected context (before the inspect-first/human render).
  assert.ok(
    inject.context.indexOf(CAPSULE_V2_DIGEST_SENTINEL_START) === 0,
    "digest sentinel block leads the injected context",
  );
  // The digest uses the pivot fqName (SQLCompiler.get_combinator_sql), so the file
  // path `compiler.py` appears ONLY in the later human/inspect-first sections —
  // a reliable "after the digest" marker.
  assert.ok(
    inject.context.indexOf(CAPSULE_V2_DIGEST_SENTINEL_END)
      < inject.context.indexOf("compiler.py"),
    "digest precedes the human render / inspect-first sections",
  );

  // The block between the sentinels contains the EXACT MCP product digest.
  const productDigest = toCapsuleV2ProductResponse(result, { query }).digest;
  const start = inject.context.indexOf(CAPSULE_V2_DIGEST_SENTINEL_START);
  const end = inject.context.indexOf(CAPSULE_V2_DIGEST_SENTINEL_END);
  const block = inject.context.slice(start, end);
  assert.ok(block.includes(productDigest), "sentinel block carries capsuleV2.digest content");
  assert.match(block, /● pivot/);
  assert.match(block, /budget:/);
});

test("M55W: injected digest carries honest not-threaded seam warnings (no fabricated counts)", () => {
  const result = JSON.parse(capsuleV2Json({ pivotSymbol: "get_combinator_sql" }));
  const block = buildInjectedCapsuleV2DigestBlock(result, "q");
  assert.match(block, /warnings:/);
  assert.match(block, /impact_not_threaded_into_digest/);
  assert.match(block, /memory_not_threaded_into_digest/);
  assert.match(block, /rules_not_threaded_into_digest/);
  // The seams are warning-only: no fabricated → impact / ◎ memory / ◇ rule lines.
  assert.doesNotMatch(block, /→ impact/);
  assert.doesNotMatch(block, /◎ memory/);
  assert.doesNotMatch(block, /◇ rule/);
});

test("M55W: classifyCapsuleOutput threads digest options through to the v2 classifier", () => {
  const json = capsuleV2Json({ pivotSymbol: "get_combinator_sql" });
  const withDigest = classifyCapsuleOutput(json, { injectDigest: true, query: "q" });
  const without = classifyCapsuleOutput(json);
  assert.match(withDigest.context, new RegExp(CAPSULE_V2_DIGEST_SENTINEL_START));
  assert.doesNotMatch(without.context, new RegExp(CAPSULE_V2_DIGEST_SENTINEL_START));
});

// --- M56: injected digest folds impact/memory/rules when a caller supplies them ---

test("M56: supplying a seam folds it into the digest and drops its not-threaded warning", () => {
  const result = JSON.parse(capsuleV2Json({ pivotSymbol: "get_combinator_sql" }));
  const block = buildInjectedCapsuleV2DigestBlock(result, "q", {
    impact: {
      dependentCount: 4,
      crossFileDependentCount: 2,
      snippetsAvailable: true,
      available: true,
      representative: [
        { role: "caller", path: "x.py", symbol: "callX", lineStart: 3, lineEnd: 5, snippet: "callX()" },
      ],
    },
    memory: { sessionCount: 1, durableCount: 2, available: true, items: [{ source: "durable", text: "prior note" }] },
    rules: { activeCount: 1, available: true, items: [{ text: "regenerate the parser table" }] },
  });
  // Real folded sections appear...
  assert.match(block, /→ impact 4 dependents, 2 cross-file/);
  assert.match(block, /caller x\.py::callX L3-L5: callX\(\)/);
  assert.match(block, /◎ memory 1 session, 2 durable/);
  assert.match(block, /◇ rule 1 active/);
  // ...and the corresponding not-threaded warnings are dropped (never left stale).
  assert.doesNotMatch(block, /impact_not_threaded_into_digest/);
  assert.doesNotMatch(block, /memory_not_threaded_into_digest/);
  assert.doesNotMatch(block, /rules_not_threaded_into_digest/);
});

test("M56: a partially-supplied seam set keeps honest warnings only for the unthreaded sections", () => {
  const result = JSON.parse(capsuleV2Json({ pivotSymbol: "get_combinator_sql" }));
  const block = buildInjectedCapsuleV2DigestBlock(result, "q", {
    impact: { dependentCount: 2, crossFileDependentCount: 1, snippetsAvailable: true, available: true },
  });
  // Impact threaded → its warning is gone; memory + rules remain warning-only.
  assert.match(block, /→ impact 2 dependents, 1 cross-file/);
  assert.doesNotMatch(block, /impact_not_threaded_into_digest/);
  assert.match(block, /memory_not_threaded_into_digest/);
  assert.match(block, /rules_not_threaded_into_digest/);
  assert.doesNotMatch(block, /◎ memory/);
  assert.doesNotMatch(block, /◇ rule/);
});

test("M56: the digest sentinel block still appears exactly once under --inject-capsule-digest", () => {
  const result = JSON.parse(capsuleV2Json({ pivotSymbol: "get_combinator_sql" }));
  const inject = classifyCapsuleV2Output(result, { injectDigest: true, query: "q" });
  const countOf = (needle: string): number => inject.context.split(needle).length - 1;
  assert.equal(countOf(CAPSULE_V2_DIGEST_SENTINEL_START), 1);
  assert.equal(countOf(CAPSULE_V2_DIGEST_SENTINEL_END), 1);
});

// --- M56B: classifier threads a DB-backed enrichment provider into the digest ---

test("M56B: classifyCapsuleV2Output folds provider-supplied seams and drops their warnings", () => {
  const result = JSON.parse(capsuleV2Json({ pivotSymbol: "get_combinator_sql" }));
  const inject = classifyCapsuleV2Output(result, {
    injectDigest: true,
    query: "q",
    // The harness supplies this (DB-backed in the live path); here a deterministic
    // stand-in proves the seams are threaded all the way into the injected digest.
    digestEnrichmentProvider: () => ({
      impact: {
        dependentCount: 3,
        crossFileDependentCount: 2,
        snippetsAvailable: true,
        available: true,
        representative: [{ role: "caller", path: "x.py", symbol: "callX", lineStart: 1, lineEnd: 2, snippet: "callX()" }],
      },
    }),
  });
  // Real impact section is injected, and the impact not-threaded warning is dropped.
  assert.match(inject.context, /→ impact 3 dependents, 2 cross-file/);
  assert.match(inject.context, /caller x\.py::callX L1-L2: callX\(\)/);
  assert.doesNotMatch(inject.context, /impact_not_threaded_into_digest/);
  // Memory/rules were not supplied → their honest warnings remain.
  assert.match(inject.context, /memory_not_threaded_into_digest/);
  assert.match(inject.context, /rules_not_threaded_into_digest/);
  // Still exactly one sentinel block.
  const countOf = (needle: string): number => inject.context.split(needle).length - 1;
  assert.equal(countOf(CAPSULE_V2_DIGEST_SENTINEL_START), 1);
  assert.equal(countOf(CAPSULE_V2_DIGEST_SENTINEL_END), 1);
});

test("M56B: no enrichment provider → pre-M56B warning-only digest is unchanged", () => {
  const result = JSON.parse(capsuleV2Json({ pivotSymbol: "get_combinator_sql" }));
  const withProvider = classifyCapsuleV2Output(result, { injectDigest: true, query: "q" });
  // Without a provider, all three seams stay warning-only (semantically unchanged).
  assert.match(withProvider.context, /impact_not_threaded_into_digest/);
  assert.match(withProvider.context, /memory_not_threaded_into_digest/);
  assert.match(withProvider.context, /rules_not_threaded_into_digest/);
  assert.doesNotMatch(withProvider.context, /→ impact/);
});

test("M55W: --inject-capsule-digest parses default-off and on", () => {
  assert.equal(parseArgs(["--mode", "prepare", "--instances", "a__1"]).injectCapsuleDigest, false);
  assert.equal(
    parseArgs(["--mode", "prepare", "--instances", "a__1", "--inject-capsule-digest"]).injectCapsuleDigest,
    true,
  );
});

test("classifyCapsuleV2Output carries the full v2 result for artifact persistence", () => {
  // The full parsed CapsuleV2Result rides along on the classification so the runner
  // can persist the raw manifest/ranking artifacts (not just the reduced audit).
  const inject = classifyCapsuleV2Output(JSON.parse(capsuleV2Json({ pivotSymbol: "get_combinator_sql" })));
  assert.ok(inject.capsuleV2Result, "inject classification carries the v2 result");
  assert.equal(inject.capsuleV2Result?.pivots[0]?.symbol, "get_combinator_sql");

  // A no_context skip still carries the result (it documents WHY no pivot landed).
  const skip = classifyCapsuleV2Output(JSON.parse(capsuleV2Json({ actualMode: "no_context", reason: "no pivot" })));
  assert.ok(skip.capsuleV2Result, "no_context classification carries the v2 result");
  assert.equal(skip.capsuleV2Result?.actual_mode, "no_context");

  // The legacy path never produces a v2 result.
  const legacy = classifyCapsuleOutput(JSON.stringify({ context: "some legacy context", diagnostics: {} }));
  assert.equal(legacy.capsuleV2Result, null);
});

// A multi-line focused body (>maxItems non-blank lines) — the exact shape the
// per-item line truncation used to decapitate. Includes the mutation site from
// django-11490 so the test reads as the real failure it guards.
const PIVOT_BODY = [
  "def get_combinator_sql(self, combinator, all):",
  "    features = self.connection.features",
  "    compilers = [q.get_compiler(self.using) for q in self.query.combined_queries]",
  "    parts = []",
  "    for compiler in compilers:",
  "        if not compiler.query.values_select and self.query.values_select:",
  "            compiler.query.set_values(self.query.values_select)",
  "        part_sql, part_args = compiler.as_sql()",
  "        parts.append(part_sql)",
  "    return parts",
].join("\n");

test("classifyPivotSource records a full body, a missing signature-only pivot, and no pivot", () => {
  const full = classifyPivotSource({ content_mode: "full", source: PIVOT_BODY });
  assert.equal(full.hasSource, true);
  assert.equal(full.mode, "full");
  assert.equal(full.chars, PIVOT_BODY.length);

  // A signature-only pivot carries no body → missing (never pretends).
  const sig = classifyPivotSource({ content_mode: "signature", signature: "def f()" });
  assert.equal(sig.hasSource, false);
  assert.equal(sig.mode, "missing");
  assert.equal(sig.chars, null);

  // A non-"full" content mode that still carries a body → "focused" (forward-compat).
  const partial = classifyPivotSource({ content_mode: "excerpt", source: "x = 1" });
  assert.equal(partial.mode, "focused");
  assert.equal(partial.hasSource, true);

  assert.deepEqual(classifyPivotSource(undefined), { hasSource: false, chars: null, mode: "missing" });
});

test("classifyCapsuleV2Output captures the top-pivot focused-source audit", () => {
  const withSource = classifyCapsuleV2Output(JSON.parse(capsuleV2Json({ pivotSource: PIVOT_BODY })));
  assert.equal(withSource.capsuleTopPivotHasSource, true);
  assert.equal(withSource.capsuleTopPivotSourceMode, "full");
  assert.equal(withSource.capsuleTopPivotSourceChars, PIVOT_BODY.length);

  // A signature-only pivot → missing, not silently pretending a body exists.
  const noSource = classifyCapsuleV2Output(JSON.parse(capsuleV2Json()));
  assert.equal(noSource.capsuleTopPivotHasSource, false);
  assert.equal(noSource.capsuleTopPivotSourceMode, "missing");
  assert.equal(noSource.capsuleTopPivotSourceChars, null);
});

test("buildVtraceContextMarkdown keeps a multi-line body when the section is preformatted", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: PIVOT_BODY,
    error: null,
    classification: null,
  };
  // Preformatted (Capsule v2): the body survives intact — no per-item line cap.
  const pre = buildVtraceContextMarkdown([{ ...section, preformatted: true }], { maxChars: 12000, maxItems: 8 });
  assert.ok(pre.markdown.includes("def get_combinator_sql(self, combinator, all):"));
  assert.ok(pre.markdown.includes("compiler.query.set_values(self.query.values_select)"));
  assert.ok(pre.markdown.includes("return parts"));
  assert.equal(pre.truncated, false);

  // Legacy (line-item truncated): the tail of the body is chopped at maxItems.
  const post = buildVtraceContextMarkdown([{ ...section, preformatted: false }], { maxChars: 12000, maxItems: 8 });
  assert.ok(post.markdown.includes("def get_combinator_sql(self, combinator, all):"));
  assert.ok(!post.markdown.includes("return parts"), "the legacy line cap must chop the body tail");
  assert.equal(post.truncated, true);

  // The char-budget safety net still applies to preformatted context.
  const capped = buildVtraceContextMarkdown([{ ...section, preformatted: true }], { maxChars: 60, maxItems: 8 });
  assert.equal(capped.truncated, true);
  assert.match(capped.markdown, /\[truncated to 60 chars\]/);
});

// ----- M45: section-priority truncation telemetry in buildVtraceContextMarkdown -----

// A structured, section-shaped capsule (mirrors the live Capsule v2 render order): an
// optional advisory section ahead of the essential pivot/neighborhood evidence. Sized
// so the essential set fits a budget but the full render does not.
const M45_FILL = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => `  # ${tag} body line ${i} carrying real content`).join("\n");
const M45_STRUCTURED = [
  "## VTRACE inspect-first (guidance, not enforcement; confidence: high)",
  "intent: test-failure (high confidence)",
  "strategy: debug_refinement",
  "budget: 1,578 / 8,000 tokens used",
  "",
  "## Semantic Edit Hypothesis",
  "Two implementations define `unparse`; no crash does not mean correct output.",
  M45_FILL("semantic-hypothesis", 12),
  "",
  "## Multi-Pivot Action Plan",
  "1. Inspect a.py::foo, then b.py::bar.",
  M45_FILL("action-plan", 12),
  "",
  "● pivot a.py::foo",
  "  source:",
  "  def foo():",
  M45_FILL("foo-source", 16),
  "",
  "## Pivot neighborhood (nearby symbols, compact)",
  "- caller: a.py::handle",
  M45_FILL("neighborhood", 16),
  "- excerpt: ESSENTIAL_NEIGHBORHOOD_MARKER must survive section-priority truncation.",
].join("\n");

function m45Section(): VtraceContextSection {
  return {
    instance: sampleInstance(),
    rawContext: M45_STRUCTURED,
    error: null,
    classification: null,
    preformatted: true,
  };
}

test("M45-11/12. preformatted over-budget: section-priority drop, chars reflect injected text", () => {
  const budget = M45_STRUCTURED.length - 1; // just over → minimal drop, essential preserved
  const assembled = buildVtraceContextMarkdown([m45Section()], { maxChars: budget, maxItems: 1_000 });
  const b = assembled.contextBudget;
  assert.ok(b !== null, "preformatted section must produce contextBudget telemetry");
  assert.equal(b!.truncationMode, "section_priority");
  assert.equal(b!.truncationOccurred, true);
  assert.equal(b!.essentialSectionsEvicted, false);
  assert.ok(b!.droppedSectionNames.length > 0, "an advisory section must be dropped");
  // (11) the flat char count equals the ACTUAL injected (post-truncation) text size.
  assert.equal(assembled.chars, b!.postTruncationChars);
  assert.ok(b!.postTruncationChars < b!.preTruncationChars);
  // (12) the legacy truncated flag stays meaningful.
  assert.equal(assembled.truncated, true);
  // Essential neighborhood evidence survives; an optional advisory is omitted.
  assert.ok(assembled.markdown.includes("ESSENTIAL_NEIGHBORHOOD_MARKER"), "essential evidence evicted");
  assert.ok(assembled.markdown.includes("[omitted "), "no omission marker emitted");
});

test("M45-12b. under-budget preformatted context is mode=none and not truncated", () => {
  const assembled = buildVtraceContextMarkdown([m45Section()], { maxChars: 100_000, maxItems: 1_000 });
  assert.ok(assembled.contextBudget !== null);
  assert.equal(assembled.contextBudget!.truncationMode, "none");
  assert.equal(assembled.contextBudget!.truncationOccurred, false);
  assert.equal(assembled.truncated, false);
  // Nothing dropped; every section body present.
  assert.equal(assembled.contextBudget!.droppedSectionNames.length, 0);
  assert.ok(assembled.markdown.includes("## Semantic Edit Hypothesis"));
  assert.ok(assembled.markdown.includes("ESSENTIAL_NEIGHBORHOOD_MARKER"));
});

test("M45-13. contextBudget is additive; legacy (non-preformatted) context reports null", () => {
  // Legacy section (preformatted falsy) keeps the old line-cap path and emits no budget.
  const legacy = buildVtraceContextMarkdown(
    [{ instance: sampleInstance(), rawContext: PIVOT_BODY, error: null, classification: null }],
    { maxChars: 12_000, maxItems: 8 },
  );
  assert.equal(legacy.contextBudget, null);
  // The pre-existing return fields are all still present (backward compatible).
  assert.equal(typeof legacy.chars, "number");
  assert.equal(typeof legacy.items, "number");
  assert.equal(typeof legacy.truncated, "boolean");
  assert.equal(typeof legacy.pivotCheckInjected, "boolean");
});

// ----- Stage 5: PIVOT_CHECK enforcement (multi-pivot Capsule v2) -----

// One source-anchored pivot (the issue pointed straight at it) + one hidden pivot
// (surfaced by inference) — the sphinx-7462 shape PIVOT_CHECK exists to catch.
const PIVOT_CHECK_PIVOTS: CapsuleAuditItem[] = [
  {
    path: "sphinx/domains/python.py",
    symbol: "_parse_annotation",
    roleReason: "source line anchor python.py#L120",
    estimatedTokens: 200,
  },
  {
    path: "sphinx/pycode/ast.py",
    symbol: "unparse",
    roleReason: "symbol-name match on the failing call path",
    estimatedTokens: 80,
  },
];

// Build a minimal classification carrying just the pivot audit list — the only
// field buildVtraceContextMarkdown reads to decide PIVOT_CHECK injection.
function classificationWithPivots(pivots: CapsuleAuditItem[] | null): CapsuleClassification {
  return { capsulePivots: pivots } as unknown as CapsuleClassification;
}

test("buildPivotCheckBlock seeds a checklist from >=2 pivots, including hidden rows", () => {
  const block = buildPivotCheckBlock(PIVOT_CHECK_PIVOTS);
  assert.ok(block !== null, "a multi-pivot capsule must emit a PIVOT_CHECK block");
  const text = block!;
  assert.match(text, /PIVOT_CHECK/);
  // Both pivots seeded as rows — the hidden pivot is never silently omitted.
  assert.match(text, /sphinx\/domains\/python\.py/);
  assert.match(text, /sphinx\/pycode\/ast\.py/);
  assert.match(text, /unparse/);
  // The checklist table header is present.
  assert.match(text, /\| pivot \| symbol \| inspected \| relevant \| edit_needed \| reason \|/);
  // Says Search/Grep is not enough AND direct Read/open is required.
  assert.match(text, /Search\/Grep does NOT count as inspection/);
  assert.match(text, /Read, open, view, or equivalent file-content access/);
  // Does NOT require editing every pivot; smallest correct patch still preferred.
  assert.match(text, /Do not edit every pivot/);
  assert.match(text, /smallest correct patch is still preferred/);
  // The hidden-pivot note is present (one pivot is non-source-anchored).
  assert.match(text, /surfaced by VTRACE via symbol, graph, literal, or test evidence/);
});

test("buildPivotCheckBlock stays quiet for single-pivot / empty / null inputs", () => {
  assert.equal(buildPivotCheckBlock(null), null);
  assert.equal(buildPivotCheckBlock([]), null);
  assert.equal(buildPivotCheckBlock([PIVOT_CHECK_PIVOTS[0]!]), null);
});

test("buildPivotCheckBlock omits the hidden note when every pivot is source-anchored", () => {
  const anchored: CapsuleAuditItem[] = [
    { path: "a.py", symbol: "f", roleReason: "source line anchor a.py#L1", estimatedTokens: 10 },
    { path: "b.py", symbol: "g", roleReason: "source line anchor b.py#L2", estimatedTokens: 10 },
  ];
  const block = buildPivotCheckBlock(anchored);
  assert.ok(block !== null);
  assert.doesNotMatch(block!, /surfaced by VTRACE/);
  // The core enforcement wording is still present even with no hidden pivots.
  assert.match(block!, /Search\/Grep does NOT count as inspection/);
});

// A classification carrying a single pivot plus a pivot_neighborhood (the
// product-v2 `--pivot-neighborhood` shape) — the new OR-trigger case.
function classificationWithNeighborhood(
  pivots: CapsuleAuditItem[],
  neighborhoodExcerpts: number,
): CapsuleClassification {
  const excerpts = Array.from({ length: neighborhoodExcerpts }, (_unused, i) => ({
    filePath: `lib/neighbor${i}.py`, symbol: `n${i}`, fqName: `lib/neighbor${i}.py::n${i}`,
    startLine: 1, endLine: 3, text: "def n():\n    return 1", reason: "caller", truncated: false,
  }));
  const pivot_neighborhood = [{ pivot: { path: pivots[0]!.path, symbol: pivots[0]!.symbol, fqName: null }, excerpts }];
  return {
    capsulePivots: pivots,
    capsuleV2Result: { pivot_neighborhood },
  } as unknown as CapsuleClassification;
}

test("decidePivotCheckInjection triggers on pivotNeighborhood excerpts even with a single pivot", () => {
  const single: CapsuleAuditItem[] = [
    { path: "lib/a.py", symbol: "f", roleReason: "symbol-name match", estimatedTokens: 50 },
  ];
  // Single pivot + neighborhood under strict_risk_gated (which would otherwise
  // suppress) → injected because neighborhood excerpts are present.
  const withNbhd = decidePivotCheckInjection(
    "strict_risk_gated",
    classificationWithNeighborhood(single, 4),
  );
  assert.equal(withNbhd.inject, true);
  assert.match(withNbhd.reason, /neighborhood_excerpts_present/);

  // Same single pivot, no neighborhood → not injected (below the multi-pivot floor).
  const noNbhd = decidePivotCheckInjection("strict_risk_gated", classificationWithPivots(single));
  assert.equal(noNbhd.inject, false);

  // policy=off still never injects, even with neighborhood excerpts.
  const off = decidePivotCheckInjection("off", classificationWithNeighborhood(single, 4));
  assert.equal(off.inject, false);
});

test("buildPivotCheckBlock renders for a single pivot + neighborhood and adds the neighborhood_use line", () => {
  const single: CapsuleAuditItem[] = [
    { path: "lib/a.py", symbol: "f", roleReason: "symbol-name match", estimatedTokens: 50 },
  ];
  const neighborhood = [
    {
      pivot: { path: "lib/a.py", symbol: "f", fqName: null },
      excerpts: [
        { filePath: "lib/b.py", symbol: "g", fqName: "lib/b.py::g", startLine: 1, endLine: 2, text: "x", reason: "caller" as const, truncated: false },
      ],
    },
  ];
  // Single pivot would normally be below the floor; the neighborhood relaxes it.
  const block = buildPivotCheckBlock(single, 2, neighborhood);
  assert.ok(block !== null, "single pivot + neighborhood must still emit a checklist");
  assert.match(block!, /## PIVOT_CHECK/);
  assert.match(block!, /\| lib\/a\.py \|/);
  assert.match(block!, /neighborhood_use: 1 pivot-neighborhood excerpt\(s\)/);
  assert.match(block!, /ground each rule-out in source you inspected/);

  // No neighborhood and single pivot → still null (multi-pivot floor holds).
  assert.equal(buildPivotCheckBlock(single, 2, []), null);
});

test("buildVtraceContextMarkdown injects PIVOT_CHECK for a single-pivot v2 section carrying a neighborhood", () => {
  const single: CapsuleAuditItem[] = [
    { path: "lib/a.py", symbol: "f", roleReason: "symbol-name match", estimatedTokens: 50 },
  ];
  const section = {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n## pivots\n...",
    error: null,
    classification: classificationWithNeighborhood(single, 3),
    preformatted: true,
  };
  const assembled = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8 });
  assert.match(assembled.markdown, /## PIVOT_CHECK/);
  assert.match(assembled.markdown, /neighborhood_use:/);
  assert.equal(assembled.pivotCheckInjected, true);
});

test("buildVtraceContextMarkdown injects PIVOT_CHECK for a multi-pivot Capsule v2 section", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n## pivots\n...",
    error: null,
    classification: classificationWithPivots(PIVOT_CHECK_PIVOTS),
    preformatted: true,
  };
  const assembled = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8 });
  assert.match(assembled.markdown, /## PIVOT_CHECK/);
  assert.match(assembled.markdown, /sphinx\/pycode\/ast\.py/);
  // Default (flag absent): the block is reported as injected.
  assert.equal(assembled.pivotCheckInjected, true);
});

test("buildVtraceContextMarkdown suppresses PIVOT_CHECK under disablePivotCheck but keeps the context body", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n## pivots\nget_combinator_sql lives here",
    error: null,
    classification: classificationWithPivots(PIVOT_CHECK_PIVOTS),
    preformatted: true,
  };
  const enabled = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8 });
  const disabled = buildVtraceContextMarkdown([section], {
    maxChars: 12000,
    maxItems: 8,
    disablePivotCheck: true,
  });

  // The flag removes ONLY the PIVOT_CHECK block.
  assert.match(enabled.markdown, /## PIVOT_CHECK/);
  assert.doesNotMatch(disabled.markdown, /PIVOT_CHECK/);
  assert.equal(enabled.pivotCheckInjected, true);
  assert.equal(disabled.pivotCheckInjected, false);

  // Normal VTRACE context is still injected with the flag on: the retrieved body,
  // the instance header, and the standing instruction all survive.
  assert.match(disabled.markdown, /# vtrace indexed context/);
  assert.match(disabled.markdown, /get_combinator_sql lives here/);
  assert.match(disabled.markdown, /Use the vtrace context above to orient/);

  // The two renders are identical except for the excised PIVOT_CHECK block.
  const withoutBlock = enabled.markdown.replace(/## PIVOT_CHECK[\s\S]*?\n\n(?=## Instruction)/, "");
  assert.equal(disabled.markdown, withoutBlock);
});

// ----- Stage 5: M12 pivot-check ENFORCEMENT mode (--pivot-inspection-enforcement) -----

// A classification carrying a structured Capsule v2 result with pivots + actionability
// hints — the only fields the enforcement injection reads. `pivotCheckPolicy: "off"` is
// used in these tests so the enforcement block is isolated from the legacy PIVOT_CHECK.
function classificationWithV2(
  pivots: Array<{ path: string; symbol: string; evidence?: string[]; role_reason?: string }>,
  hints: unknown[] = [],
): CapsuleClassification {
  return {
    capsulePivots: null,
    capsuleV2Result: { pivots, actionability_hints: hints },
  } as unknown as CapsuleClassification;
}

// Body simulating the rendered capsule: the M11 advisory contract + a pivot body.
const ENFORCE_BODY =
  "intent: debug\n\n## Pivot inspection contract\nVTRACE surfaced multiple pivots.\n\n● pivot pkg/lead.py::lead\n<source body>";
const ENFORCE_PIVOTS = [
  { path: "pkg/lead.py", symbol: "lead", evidence: ["source line anchor"], role_reason: "lead" },
  { path: "pkg/other.py", symbol: "second", evidence: ["symbol-name match"], role_reason: "hidden" },
];

test("enforcement block renders ONLY when --pivot-inspection-enforcement is enabled", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: ENFORCE_BODY,
    error: null,
    classification: classificationWithV2(ENFORCE_PIVOTS),
    preformatted: true,
  };
  const off = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8, pivotCheckPolicy: "off" });
  const on = buildVtraceContextMarkdown([section], {
    maxChars: 12000, maxItems: 8, pivotCheckPolicy: "off", pivotInspectionEnforcement: true,
  });
  // Off by default: no enforcement block, but the advisory body survives.
  assert.doesNotMatch(off.markdown, /## Required pivot check before final patch/);
  assert.equal(off.pivotInspectionEnforcementInjected, false);
  assert.match(off.markdown, /## Pivot inspection contract/);
  // On: enforcement block injected.
  assert.match(on.markdown, /## Required pivot check before final patch/);
  assert.match(on.markdown, /- EDITED: I changed this file because/);
  assert.match(on.markdown, /pkg\/other\.py::second/);
  assert.equal(on.pivotInspectionEnforcementInjected, true);
});

test("enforcement block renders BEFORE the pivot bodies and before the 12k cutoff", () => {
  const huge = `${ENFORCE_BODY}\n${"# pad line to inflate the capsule body\n".repeat(800)}`; // >12k
  const section = {
    instance: sampleInstance(),
    rawContext: huge,
    error: null,
    classification: classificationWithV2(ENFORCE_PIVOTS),
    preformatted: true,
  };
  const on = buildVtraceContextMarkdown([section], {
    maxChars: 12000, maxItems: 8, pivotCheckPolicy: "off", pivotInspectionEnforcement: true,
  });
  const enforceIdx = on.markdown.indexOf("## Required pivot check before final patch");
  const bodyIdx = on.markdown.indexOf("● pivot pkg/lead.py::lead");
  assert.ok(enforceIdx >= 0, "enforcement block missing");
  assert.ok(bodyIdx >= 0, "pivot body missing");
  assert.ok(enforceIdx < bodyIdx, `enforcement (${enforceIdx}) must precede pivot body (${bodyIdx})`);
  assert.ok(enforceIdx < 12000, `enforcement (${enforceIdx}) must be before the 12k cutoff`);
});

test("enforcement lists related co-edit candidates and stays independent of --disable-pivot-check", () => {
  const coeditHint = {
    kind: "multi_file_coedit", sourceFile: "pkg/lead.py", relatedFile: "pkg/coupled.py",
    relatedFiles: ["pkg/coupled.py"], confidence: "high",
    evidence: ["cross-module pivots"], hint: "co-edit", patchObligation: { kind: "consider_coedit_files_in_final_diff", text: "x" },
  };
  const section = {
    instance: sampleInstance(),
    rawContext: ENFORCE_BODY,
    error: null,
    classification: classificationWithV2(ENFORCE_PIVOTS, [coeditHint]),
    preformatted: true,
  };
  // --disable-pivot-check forces the legacy policy off; enforcement is a SEPARATE mode.
  const assembled = buildVtraceContextMarkdown([section], {
    maxChars: 12000, maxItems: 8, disablePivotCheck: true, pivotInspectionEnforcement: true,
  });
  assert.doesNotMatch(assembled.markdown, /## PIVOT_CHECK/); // legacy block stays off
  assert.match(assembled.markdown, /## Required pivot check before final patch/);
  assert.match(assembled.markdown, /Co-edit candidate:\n {2}pkg\/coupled\.py/);
  assert.equal(assembled.pivotInspectionEnforcementInjected, true);
});

test("enforcement does NOT render for a single-pivot capsule even when enabled", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n● pivot pkg/lead.py::lead\n<body>",
    error: null,
    classification: classificationWithV2([ENFORCE_PIVOTS[0]!]),
    preformatted: true,
  };
  const on = buildVtraceContextMarkdown([section], {
    maxChars: 12000, maxItems: 8, pivotCheckPolicy: "off", pivotInspectionEnforcement: true,
  });
  assert.doesNotMatch(on.markdown, /## Required pivot check before final patch/);
  assert.equal(on.pivotInspectionEnforcementInjected, false);
});

test("buildVtraceContextMarkdown does not inject PIVOT_CHECK for a single-pivot capsule", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n## pivots\n...",
    error: null,
    classification: classificationWithPivots([PIVOT_CHECK_PIVOTS[0]!]),
    preformatted: true,
  };
  const md = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8 }).markdown;
  assert.doesNotMatch(md, /PIVOT_CHECK/);
});

test("buildVtraceContextMarkdown does not inject PIVOT_CHECK for legacy / no-capsule sections", () => {
  // Legacy engine: classification carries no capsulePivots (null), even multi-item.
  const legacy = {
    instance: sampleInstance(),
    rawContext: "some legacy retrieved context\nwith two lines",
    error: null,
    classification: classificationWithPivots(null),
    preformatted: false,
  };
  assert.doesNotMatch(buildVtraceContextMarkdown([legacy], { maxChars: 12000, maxItems: 8 }).markdown, /PIVOT_CHECK/);

  // No classification at all (hard-error section) → never injects.
  const noClass = { instance: sampleInstance(), rawContext: "ctx", error: null, classification: null };
  assert.doesNotMatch(buildVtraceContextMarkdown([noClass], { maxChars: 12000, maxItems: 8 }).markdown, /PIVOT_CHECK/);
});

// ----- Stage 5: deterministic PIVOT_CHECK policy (strict_risk_gated default) -----

// Two ordinary pivots: both source-anchored, no hidden / edit-risk signal. Under
// risk_gated this is exactly the case that should NOT inject (the token saving);
// under multi_pivot it must still inject (old behaviour).
const TWO_ORDINARY_PIVOTS: CapsuleAuditItem[] = [
  { path: "pkg/a.py", symbol: "f", roleReason: "source line anchor a.py#L10", estimatedTokens: 50 },
  { path: "pkg/b.py", symbol: "g", roleReason: "source line anchor b.py#L20", estimatedTokens: 50 },
];

// Three source-anchored pivots → the three_or_more_pivots risk signal fires even
// though none is hidden.
const THREE_STRONG_PIVOTS: CapsuleAuditItem[] = [
  ...TWO_ORDINARY_PIVOTS,
  { path: "pkg/c.py", symbol: "h", roleReason: "source line anchor c.py#L30", estimatedTokens: 50 },
];

// Build a classification carrying the fields the policy actually reads (pivot list +
// edit-risk directive count), so edit-relevant risk can be exercised without pivots.
function classificationWith(opts: {
  pivots: CapsuleAuditItem[] | null;
  editRiskDirectives?: number;
}): CapsuleClassification {
  return {
    capsulePivots: opts.pivots,
    capsuleEditRiskDirectivesCount: opts.editRiskDirectives ?? 0,
  } as unknown as CapsuleClassification;
}

function pivotSection(classification: CapsuleClassification | null) {
  return {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n## pivots\n...",
    error: null,
    classification,
    preformatted: true,
  };
}

test("--pivot-check-policy parses, defaults to strict_risk_gated, and rejects unknown values", () => {
  // Omitting --pivot-check-policy resolves to the internal Stage 5 default.
  assert.equal(parseArgs(["--mode", "prepare", "--instances", "a__1"]).pivotCheckPolicy, "strict_risk_gated");
  // Explicit policies are honoured exactly — old behaviour stays selectable.
  assert.equal(
    parseArgs(["--mode", "prepare", "--instances", "a__1", "--pivot-check-policy", "risk_gated"]).pivotCheckPolicy,
    "risk_gated",
  );
  assert.equal(
    parseArgs(["--mode", "prepare", "--instances", "a__1", "--pivot-check-policy", "multi_pivot"]).pivotCheckPolicy,
    "multi_pivot",
  );
  assert.equal(
    parseArgs(["--mode", "prepare", "--instances", "a__1", "--pivot-check-policy", "always"]).pivotCheckPolicy,
    "always",
  );
  assert.throws(
    () => parseArgs(["--mode", "prepare", "--instances", "a__1", "--pivot-check-policy", "bogus"]),
    /Invalid --pivot-check-policy/,
  );
  // --disable-pivot-check still sets the compat flag (policy resolves to off at injection time).
  assert.equal(parseArgs(["--mode", "prepare", "--instances", "a__1", "--disable-pivot-check"]).disablePivotCheck, true);
});

test("the default policy (omitted flag) suppresses a hidden_pivot-only capsule end to end", () => {
  // Resolve the policy the way a real run does — straight from the parsed CLI config
  // with --pivot-check-policy omitted — then feed it through the render path. The
  // hidden-pivot-only capsule meets the multi-pivot floor but carries no STRONG signal,
  // so the default must NOT inject PIVOT_CHECK (the token saving the default exists for).
  const defaultPolicy = parseArgs(["--mode", "prepare", "--instances", "a__1"]).pivotCheckPolicy;
  assert.equal(defaultPolicy, "strict_risk_gated");
  const cls = classificationWith({ pivots: PIVOT_CHECK_PIVOTS });
  assert.deepEqual(pivotCheckRiskSignals(cls), ["hidden_pivot"]); // hidden only — no strong signal
  const a = buildVtraceContextMarkdown([pivotSection(cls)], {
    maxChars: 12000,
    maxItems: 8,
    pivotCheckPolicy: defaultPolicy,
  });
  assert.doesNotMatch(a.markdown, /## PIVOT_CHECK/);
  assert.equal(a.pivotCheckInjected, false);
  assert.equal(a.pivotCheckPolicy, "strict_risk_gated");
  assert.match(a.pivotCheckReason, /hidden_pivot alone is insufficient/);
  // The old default (risk_gated) WOULD have injected on the same capsule — the change is real.
  assert.equal(decidePivotCheckInjection("risk_gated", cls).inject, true);
});

test("decidePivotCheckInjection: off never injects", () => {
  const d = decidePivotCheckInjection("off", classificationWith({ pivots: THREE_STRONG_PIVOTS }));
  assert.equal(d.inject, false);
  assert.match(d.reason, /off/);
});

test("disablePivotCheck limit forces policy off regardless of pivotCheckPolicy", () => {
  const a = buildVtraceContextMarkdown([pivotSection(classificationWith({ pivots: THREE_STRONG_PIVOTS }))], {
    maxChars: 12000,
    maxItems: 8,
    pivotCheckPolicy: "always",
    disablePivotCheck: true,
  });
  assert.doesNotMatch(a.markdown, /PIVOT_CHECK/);
  assert.equal(a.pivotCheckInjected, false);
  assert.equal(a.pivotCheckPolicy, "off");
});

test("risk_gated does not inject for two ordinary pivots with no risk signals", () => {
  const cls = classificationWith({ pivots: TWO_ORDINARY_PIVOTS });
  assert.deepEqual(pivotCheckRiskSignals(cls), []);
  const d = decidePivotCheckInjection("risk_gated", cls);
  assert.equal(d.inject, false);
  assert.deepEqual(d.riskSignals, []);
  // The OLD multi_pivot behaviour WOULD have injected — recorded for cost comparison.
  assert.equal(d.wouldInjectUnderMultiPivot, true);
  const a = buildVtraceContextMarkdown([pivotSection(cls)], { maxChars: 12000, maxItems: 8, pivotCheckPolicy: "risk_gated" });
  assert.doesNotMatch(a.markdown, /PIVOT_CHECK/);
  assert.equal(a.pivotCheckInjected, false);
});

test("risk_gated injects for >= 3 strong pivots", () => {
  const cls = classificationWith({ pivots: THREE_STRONG_PIVOTS });
  const d = decidePivotCheckInjection("risk_gated", cls);
  assert.equal(d.inject, true);
  assert.ok(d.riskSignals.includes("three_or_more_pivots"));
  const a = buildVtraceContextMarkdown([pivotSection(cls)], { maxChars: 12000, maxItems: 8, pivotCheckPolicy: "risk_gated" });
  assert.match(a.markdown, /## PIVOT_CHECK/);
  assert.equal(a.pivotCheckInjected, true);
});

test("risk_gated injects when a hidden pivot is present", () => {
  const d = decidePivotCheckInjection("risk_gated", classificationWith({ pivots: PIVOT_CHECK_PIVOTS }));
  assert.equal(d.inject, true);
  assert.ok(d.riskSignals.includes("hidden_pivot"));
});

test("risk_gated injects when edit-risk directive metadata is present (two ordinary pivots)", () => {
  const cls = classificationWith({ pivots: TWO_ORDINARY_PIVOTS, editRiskDirectives: 2 });
  assert.deepEqual(pivotCheckRiskSignals(cls), ["edit_risk_directives"]);
  const d = decidePivotCheckInjection("risk_gated", cls);
  assert.equal(d.inject, true);
  assert.ok(d.riskSignals.includes("edit_risk_directives"));
});

test("multi_pivot preserves old behaviour: injects for any two pivots; single pivot stays quiet", () => {
  const d = decidePivotCheckInjection("multi_pivot", classificationWith({ pivots: TWO_ORDINARY_PIVOTS }));
  assert.equal(d.inject, true);
  const a = buildVtraceContextMarkdown([pivotSection(classificationWith({ pivots: TWO_ORDINARY_PIVOTS }))], {
    maxChars: 12000,
    maxItems: 8,
    pivotCheckPolicy: "multi_pivot",
  });
  assert.match(a.markdown, /## PIVOT_CHECK/);
  const single = decidePivotCheckInjection("multi_pivot", classificationWith({ pivots: [TWO_ORDINARY_PIVOTS[0]!] }));
  assert.equal(single.inject, false);
});

test("always injects whenever Capsule v2 context exists, including a single pivot", () => {
  const multi = buildVtraceContextMarkdown([pivotSection(classificationWith({ pivots: TWO_ORDINARY_PIVOTS }))], {
    maxChars: 12000,
    maxItems: 8,
    pivotCheckPolicy: "always",
  });
  assert.match(multi.markdown, /## PIVOT_CHECK/);
  assert.equal(multi.pivotCheckInjected, true);
  // A single pivot also injects under `always` (the render floor drops to 1).
  const single = buildVtraceContextMarkdown([pivotSection(classificationWith({ pivots: [TWO_ORDINARY_PIVOTS[0]!] }))], {
    maxChars: 12000,
    maxItems: 8,
    pivotCheckPolicy: "always",
  });
  assert.match(single.markdown, /## PIVOT_CHECK/);
  assert.equal(single.pivotCheckInjected, true);
});

// ----- Stage 5: strict_risk_gated (hidden_pivot alone is insufficient) -----

test("--pivot-check-policy accepts strict_risk_gated", () => {
  assert.equal(
    parseArgs(["--mode", "prepare", "--instances", "a__1", "--pivot-check-policy", "strict_risk_gated"]).pivotCheckPolicy,
    "strict_risk_gated",
  );
});

test("strongRiskSignals: hidden_pivot alone is not strong; corroboration / strong signals are", () => {
  assert.deepEqual(strongRiskSignals([]), []);
  assert.deepEqual(strongRiskSignals(["hidden_pivot"]), []);
  assert.deepEqual(strongRiskSignals(["three_or_more_pivots"]), ["three_or_more_pivots"]);
  assert.deepEqual(strongRiskSignals(["edit_risk_directives"]), ["edit_risk_directives"]);
  assert.deepEqual(strongRiskSignals(["known_edit_relevant_hidden_pivot"]), ["known_edit_relevant_hidden_pivot"]);
  // hidden_pivot + a known strong signal → that strong signal carries it (no redundant label).
  assert.deepEqual(strongRiskSignals(["hidden_pivot", "edit_risk_directives"]), ["edit_risk_directives"]);
  // hidden_pivot + some other (non-known) signal → the corroboration label fires.
  assert.deepEqual(strongRiskSignals(["hidden_pivot", "some_future_signal"]), ["hidden_pivot+additional"]);
});

test("strict_risk_gated SUPPRESSES a hidden_pivot-only capsule with a clear reason", () => {
  const cls = classificationWith({ pivots: PIVOT_CHECK_PIVOTS });
  assert.deepEqual(pivotCheckRiskSignals(cls), ["hidden_pivot"]); // hidden only
  const d = decidePivotCheckInjection("strict_risk_gated", cls);
  assert.equal(d.inject, false);
  assert.equal(d.wouldInjectUnderMultiPivot, true); // multi-pivot floor IS met
  assert.match(d.reason, /strict_risk_gated: no strong risk signal/);
  assert.match(d.reason, /hidden_pivot alone is insufficient/);
  // And the rendered snapshot carries no checklist, but records the strict policy + reason.
  const a = buildVtraceContextMarkdown([pivotSection(cls)], {
    maxChars: 12000,
    maxItems: 8,
    pivotCheckPolicy: "strict_risk_gated",
  });
  assert.doesNotMatch(a.markdown, /## PIVOT_CHECK/);
  assert.equal(a.pivotCheckInjected, false);
  assert.equal(a.pivotCheckPolicy, "strict_risk_gated");
  assert.match(a.pivotCheckReason, /hidden_pivot alone is insufficient/);

  // Contrast: risk_gated (unchanged) WOULD have injected on the same hidden-only capsule.
  assert.equal(decidePivotCheckInjection("risk_gated", cls).inject, true);
});

test("strict_risk_gated injects for three_or_more_pivots", () => {
  const cls = classificationWith({ pivots: THREE_STRONG_PIVOTS });
  const d = decidePivotCheckInjection("strict_risk_gated", cls);
  assert.equal(d.inject, true);
  assert.match(d.reason, /strict_risk_gated: strong risk signals \[three_or_more_pivots\]/);
  const a = buildVtraceContextMarkdown([pivotSection(cls)], {
    maxChars: 12000,
    maxItems: 8,
    pivotCheckPolicy: "strict_risk_gated",
  });
  assert.match(a.markdown, /## PIVOT_CHECK/);
  assert.equal(a.pivotCheckInjected, true);
});

test("strict_risk_gated injects for edit_risk_directives", () => {
  const cls = classificationWith({ pivots: TWO_ORDINARY_PIVOTS, editRiskDirectives: 2 });
  const d = decidePivotCheckInjection("strict_risk_gated", cls);
  assert.equal(d.inject, true);
  assert.match(d.reason, /strong risk signals \[edit_risk_directives\]/);
});

test("strict_risk_gated injects for hidden_pivot PLUS another risk signal", () => {
  // hidden pivot present AND an edit-risk directive → hidden_pivot corroborated.
  const cls = classificationWith({ pivots: PIVOT_CHECK_PIVOTS, editRiskDirectives: 1 });
  assert.deepEqual(pivotCheckRiskSignals(cls), ["hidden_pivot", "edit_risk_directives"]);
  const d = decidePivotCheckInjection("strict_risk_gated", cls);
  assert.equal(d.inject, true);
  assert.match(d.reason, /strong risk signals/);
});

test("strict_risk_gated preserves the multi-pivot structural floor (no inject with < 2 pivots)", () => {
  const single = decidePivotCheckInjection("strict_risk_gated", classificationWith({ pivots: [PIVOT_CHECK_PIVOTS[1]!] }));
  assert.equal(single.inject, false);
  assert.match(single.reason, /below multi-pivot floor/);
  // Two ordinary pivots, no risk signal: floor met but no strong signal → suppress (no hidden note).
  const ordinary = decidePivotCheckInjection("strict_risk_gated", classificationWith({ pivots: TWO_ORDINARY_PIVOTS }));
  assert.equal(ordinary.inject, false);
  assert.match(ordinary.reason, /no strong risk signal/);
  assert.doesNotMatch(ordinary.reason, /hidden_pivot alone/);
});

test("disablePivotCheck still forces off even under strict_risk_gated", () => {
  const a = buildVtraceContextMarkdown([pivotSection(classificationWith({ pivots: THREE_STRONG_PIVOTS }))], {
    maxChars: 12000,
    maxItems: 8,
    pivotCheckPolicy: "strict_risk_gated",
    disablePivotCheck: true,
  });
  assert.doesNotMatch(a.markdown, /PIVOT_CHECK/);
  assert.equal(a.pivotCheckInjected, false);
  assert.equal(a.pivotCheckPolicy, "off");
});

test("risk_gated / multi_pivot / always are unchanged by the strict gate", () => {
  const hiddenOnly = classificationWith({ pivots: PIVOT_CHECK_PIVOTS });
  const ordinary = classificationWith({ pivots: TWO_ORDINARY_PIVOTS });
  const single = classificationWith({ pivots: [TWO_ORDINARY_PIVOTS[0]!] });
  // risk_gated still injects on hidden_pivot-only.
  assert.equal(decidePivotCheckInjection("risk_gated", hiddenOnly).inject, true);
  // multi_pivot still injects for any two pivots, stays quiet for one.
  assert.equal(decidePivotCheckInjection("multi_pivot", ordinary).inject, true);
  assert.equal(decidePivotCheckInjection("multi_pivot", single).inject, false);
  // always still injects whenever a pivot exists.
  assert.equal(decidePivotCheckInjection("always", single).inject, true);
});

test("buildVtraceContextMarkdown records policy, reason, risk signals, and would-inject", () => {
  const a = buildVtraceContextMarkdown([pivotSection(classificationWith({ pivots: THREE_STRONG_PIVOTS }))], {
    maxChars: 12000,
    maxItems: 8,
    pivotCheckPolicy: "risk_gated",
  });
  assert.equal(a.pivotCheckPolicy, "risk_gated");
  assert.match(a.pivotCheckReason, /risk_gated/);
  assert.ok(a.pivotCheckRiskSignals.includes("three_or_more_pivots"));
  assert.equal(a.pivotCheckWouldInjectUnderMultiPivot, true);

  // When risk_gated declines, the reason explains WHY and the signals are empty.
  const declined = buildVtraceContextMarkdown([pivotSection(classificationWith({ pivots: TWO_ORDINARY_PIVOTS }))], {
    maxChars: 12000,
    maxItems: 8,
    pivotCheckPolicy: "risk_gated",
  });
  assert.equal(declined.pivotCheckPolicy, "risk_gated");
  assert.match(declined.pivotCheckReason, /no high-risk signal/);
  assert.deepEqual(declined.pivotCheckRiskSignals, []);
  assert.equal(declined.pivotCheckWouldInjectUnderMultiPivot, true);
});

test("EDIT_GUARD / PATCH_VERIFY ride only on an ACTUAL PIVOT_CHECK injection (risk_gated)", () => {
  // risk_gated declines (two ordinary pivots) → no PIVOT_CHECK, hence no guard/verify.
  const declined = buildVtraceContextMarkdown([pivotSection(classificationWith({ pivots: TWO_ORDINARY_PIVOTS }))], {
    maxChars: 12000,
    maxItems: 8,
    pivotCheckPolicy: "risk_gated",
  });
  assert.equal(declined.pivotCheckInjected, false);
  assert.equal(declined.editGuardInjected, false);
  assert.equal(declined.patchVerifyInjected, false);
  assert.doesNotMatch(declined.markdown, /EDIT_GUARD/);
  assert.doesNotMatch(declined.markdown, /PATCH_VERIFY/);
  // risk_gated injects (3 pivots) → guard + verify ride along.
  const injected = buildVtraceContextMarkdown([pivotSection(classificationWith({ pivots: THREE_STRONG_PIVOTS }))], {
    maxChars: 12000,
    maxItems: 8,
    pivotCheckPolicy: "risk_gated",
  });
  assert.equal(injected.pivotCheckInjected, true);
  assert.equal(injected.editGuardInjected, true);
  assert.equal(injected.patchVerifyInjected, true);
});

// ----- Stage 5: EDIT_GUARD edit-discipline block (rides with PIVOT_CHECK) -----

test("buildEditGuardBlock contains SCOPE, FAILING BEHAVIOR, MINIMAL FIX, and RULED OUT", () => {
  const block = buildEditGuardBlock();
  assert.match(block, /## EDIT_GUARD/);
  assert.match(block, /SCOPE:/);
  assert.match(block, /FAILING BEHAVIOR:/);
  assert.match(block, /MINIMAL FIX:/);
  assert.match(block, /RULED OUT:/);
  // It targets the loss mode (bad edits after good context) and prefers minimal fixes.
  assert.match(block, /enclosing class\/function\/module/);
  assert.match(block, /avoid broad .*control-flow rewrites/);
  // It carries the detectable marker and does NOT mention PIVOT_CHECK (separate signal).
  assert.ok(block.includes(EDIT_GUARD_MARKER));
  assert.doesNotMatch(block, /PIVOT_CHECK/);
});

test("detectEditGuardText finds the marker only when the guard block is present", () => {
  assert.equal(detectEditGuardText(buildEditGuardBlock()), true);
  assert.equal(detectEditGuardText("# vtrace indexed context\n\n## Instruction\n"), false);
});

test("buildVtraceContextMarkdown injects EDIT_GUARD right after PIVOT_CHECK for a multi-pivot v2 section", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n## pivots\n...",
    error: null,
    classification: classificationWithPivots(PIVOT_CHECK_PIVOTS),
    preformatted: true,
  };
  const assembled = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8 });
  // Both blocks present, and EDIT_GUARD follows PIVOT_CHECK (rides with the checklist).
  assert.match(assembled.markdown, /## PIVOT_CHECK/);
  assert.match(assembled.markdown, /## EDIT_GUARD/);
  assert.ok(assembled.markdown.indexOf("## PIVOT_CHECK") < assembled.markdown.indexOf("## EDIT_GUARD"));
  assert.equal(assembled.pivotCheckInjected, true);
  assert.equal(assembled.editGuardInjected, true);
  // The guard carries its required headings.
  assert.match(assembled.markdown, /SCOPE:/);
  assert.match(assembled.markdown, /RULED OUT:/);
});

test("--disable-edit-guard removes ONLY the guard; PIVOT_CHECK and context body remain", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n## pivots\nget_combinator_sql lives here",
    error: null,
    classification: classificationWithPivots(PIVOT_CHECK_PIVOTS),
    preformatted: true,
  };
  const guarded = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8 });
  const noGuard = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8, disableEditGuard: true });

  // PIVOT_CHECK is untouched by the edit-guard flag; only EDIT_GUARD is excised.
  assert.match(noGuard.markdown, /## PIVOT_CHECK/);
  assert.doesNotMatch(noGuard.markdown, /EDIT_GUARD/);
  assert.equal(noGuard.pivotCheckInjected, true);
  assert.equal(noGuard.editGuardInjected, false);
  // The retrieved context body still survives, and PATCH_VERIFY (which rides after
  // EDIT_GUARD and is independent of it) is unaffected by the edit-guard flag.
  assert.match(noGuard.markdown, /get_combinator_sql lives here/);
  assert.match(noGuard.markdown, /## PATCH_VERIFY/);

  // The two renders differ ONLY by the excised EDIT_GUARD block: deleting EDIT_GUARD
  // up to the following PATCH_VERIFY block reproduces the no-guard render exactly.
  const withoutGuard = guarded.markdown.replace(/## EDIT_GUARD[\s\S]*?\n\n(?=## PATCH_VERIFY)/, "");
  assert.equal(noGuard.markdown, withoutGuard);
});

test("--disable-pivot-check also removes EDIT_GUARD (the guard rides with the checklist)", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n## pivots\n...",
    error: null,
    classification: classificationWithPivots(PIVOT_CHECK_PIVOTS),
    preformatted: true,
  };
  const both = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8 });
  const neither = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8, disablePivotCheck: true });
  assert.equal(both.editGuardInjected, true);
  // No checklist => no guard, even though --disable-edit-guard was NOT passed.
  assert.equal(neither.pivotCheckInjected, false);
  assert.equal(neither.editGuardInjected, false);
  assert.doesNotMatch(neither.markdown, /EDIT_GUARD/);
});

test("EDIT_GUARD never injects for a single-pivot capsule (no checklist to ride)", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n## pivots\n...",
    error: null,
    classification: classificationWithPivots([PIVOT_CHECK_PIVOTS[0]!]),
    preformatted: true,
  };
  const assembled = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8 });
  assert.equal(assembled.pivotCheckInjected, false);
  assert.equal(assembled.editGuardInjected, false);
  assert.doesNotMatch(assembled.markdown, /EDIT_GUARD/);
});

test("EDIT_GUARD changes no retrieval/ranking output: capsule pivots and body are identical", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n## pivots\nget_combinator_sql body here",
    error: null,
    classification: classificationWithPivots(PIVOT_CHECK_PIVOTS),
    preformatted: true,
  };
  const guarded = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8 });
  const noGuard = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8, disableEditGuard: true });
  // The injected retrieved context (pivot rows, body) is byte-identical up to the
  // appended guard block — the guard adds guidance only, never altering retrieval.
  assert.ok(guarded.markdown.includes("get_combinator_sql body here"));
  assert.ok(noGuard.markdown.includes("get_combinator_sql body here"));
  assert.match(guarded.markdown, /sphinx\/pycode\/ast\.py/); // pivot rows unchanged
  assert.match(noGuard.markdown, /sphinx\/pycode\/ast\.py/);
});

// ----- Stage 5: PATCH_VERIFY patch-quality checkpoint (rides with PIVOT_CHECK) -----

test("buildPatchVerifyBlock contains SCOPE LANDED, FAILING BEHAVIOR HANDLED, MINIMALITY, CHECK RUN, RISK", () => {
  const block = buildPatchVerifyBlock();
  assert.match(block, /## PATCH_VERIFY/);
  assert.match(block, /SCOPE LANDED:/);
  assert.match(block, /FAILING BEHAVIOR HANDLED:/);
  assert.match(block, /MINIMALITY:/);
  assert.match(block, /CHECK RUN:/);
  assert.match(block, /RISK:/);
  // It is an after-edit checkpoint that asks the agent to revise before finalizing.
  assert.match(block, /Before finalizing the patch/);
  assert.match(block, /revise the patch before finalizing/);
  // It carries its own detectable marker and is NOT another retrieval/inspection block.
  assert.ok(block.includes(PATCH_VERIFY_MARKER));
  assert.doesNotMatch(block, /PIVOT_CHECK/);
  assert.doesNotMatch(block, /EDIT_GUARD/);
});

test("detectPatchVerifyText finds the marker only when the checkpoint block is present", () => {
  assert.equal(detectPatchVerifyText(buildPatchVerifyBlock()), true);
  assert.equal(detectPatchVerifyText("# vtrace indexed context\n\n## Instruction\n"), false);
});

test("buildVtraceContextMarkdown injects PATCH_VERIFY after EDIT_GUARD for a multi-pivot v2 section", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n## pivots\n...",
    error: null,
    classification: classificationWithPivots(PIVOT_CHECK_PIVOTS),
    preformatted: true,
  };
  const assembled = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8 });
  // All three blocks present, in order: PIVOT_CHECK → EDIT_GUARD → PATCH_VERIFY.
  assert.match(assembled.markdown, /## PIVOT_CHECK/);
  assert.match(assembled.markdown, /## EDIT_GUARD/);
  assert.match(assembled.markdown, /## PATCH_VERIFY/);
  assert.ok(assembled.markdown.indexOf("## PIVOT_CHECK") < assembled.markdown.indexOf("## EDIT_GUARD"));
  assert.ok(assembled.markdown.indexOf("## EDIT_GUARD") < assembled.markdown.indexOf("## PATCH_VERIFY"));
  assert.equal(assembled.pivotCheckInjected, true);
  assert.equal(assembled.editGuardInjected, true);
  assert.equal(assembled.patchVerifyInjected, true);
  // The checkpoint carries its required items.
  assert.match(assembled.markdown, /SCOPE LANDED:/);
  assert.match(assembled.markdown, /CHECK RUN:/);
});

test("--disable-patch-verify removes ONLY the checkpoint; PIVOT_CHECK, EDIT_GUARD, and context body remain", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n## pivots\nget_combinator_sql lives here",
    error: null,
    classification: classificationWithPivots(PIVOT_CHECK_PIVOTS),
    preformatted: true,
  };
  const withVerify = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8 });
  const noVerify = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8, disablePatchVerify: true });

  // PIVOT_CHECK and EDIT_GUARD are untouched by the patch-verify flag.
  assert.match(noVerify.markdown, /## PIVOT_CHECK/);
  assert.match(noVerify.markdown, /## EDIT_GUARD/);
  assert.doesNotMatch(noVerify.markdown, /PATCH_VERIFY/);
  assert.equal(noVerify.pivotCheckInjected, true);
  assert.equal(noVerify.editGuardInjected, true);
  assert.equal(noVerify.patchVerifyInjected, false);
  // The retrieved context body still survives.
  assert.match(noVerify.markdown, /get_combinator_sql lives here/);

  // The two renders differ ONLY by the excised PATCH_VERIFY block.
  const withoutVerify = withVerify.markdown.replace(/## PATCH_VERIFY[\s\S]*?\n\n(?=## Instruction)/, "");
  assert.equal(noVerify.markdown, withoutVerify);
});

test("--disable-edit-guard leaves PATCH_VERIFY intact (the checkpoint is independent of the guard)", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n## pivots\n...",
    error: null,
    classification: classificationWithPivots(PIVOT_CHECK_PIVOTS),
    preformatted: true,
  };
  const noGuard = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8, disableEditGuard: true });
  // EDIT_GUARD gone, PATCH_VERIFY still present — and PATCH_VERIFY now follows PIVOT_CHECK directly.
  assert.match(noGuard.markdown, /## PIVOT_CHECK/);
  assert.doesNotMatch(noGuard.markdown, /EDIT_GUARD/);
  assert.match(noGuard.markdown, /## PATCH_VERIFY/);
  assert.equal(noGuard.editGuardInjected, false);
  assert.equal(noGuard.patchVerifyInjected, true);
  assert.ok(noGuard.markdown.indexOf("## PIVOT_CHECK") < noGuard.markdown.indexOf("## PATCH_VERIFY"));
});

test("--disable-edit-guard --disable-patch-verify yields PIVOT_CHECK only", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n## pivots\n...",
    error: null,
    classification: classificationWithPivots(PIVOT_CHECK_PIVOTS),
    preformatted: true,
  };
  const pivotOnly = buildVtraceContextMarkdown([section], {
    maxChars: 12000,
    maxItems: 8,
    disableEditGuard: true,
    disablePatchVerify: true,
  });
  assert.match(pivotOnly.markdown, /## PIVOT_CHECK/);
  assert.doesNotMatch(pivotOnly.markdown, /EDIT_GUARD/);
  assert.doesNotMatch(pivotOnly.markdown, /PATCH_VERIFY/);
  assert.equal(pivotOnly.pivotCheckInjected, true);
  assert.equal(pivotOnly.editGuardInjected, false);
  assert.equal(pivotOnly.patchVerifyInjected, false);
});

test("--disable-pivot-check also removes PATCH_VERIFY (the checkpoint rides with the checklist)", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n## pivots\n...",
    error: null,
    classification: classificationWithPivots(PIVOT_CHECK_PIVOTS),
    preformatted: true,
  };
  const both = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8 });
  const neither = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8, disablePivotCheck: true });
  assert.equal(both.patchVerifyInjected, true);
  // No checklist => no checkpoint, even though --disable-patch-verify was NOT passed.
  assert.equal(neither.pivotCheckInjected, false);
  assert.equal(neither.patchVerifyInjected, false);
  assert.doesNotMatch(neither.markdown, /PATCH_VERIFY/);
});

test("PATCH_VERIFY never injects for a single-pivot capsule (no checklist to ride)", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n## pivots\n...",
    error: null,
    classification: classificationWithPivots([PIVOT_CHECK_PIVOTS[0]!]),
    preformatted: true,
  };
  const assembled = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8 });
  assert.equal(assembled.pivotCheckInjected, false);
  assert.equal(assembled.patchVerifyInjected, false);
  assert.doesNotMatch(assembled.markdown, /PATCH_VERIFY/);
});

test("PATCH_VERIFY changes no retrieval/ranking output: capsule pivots and body are identical", () => {
  const section = {
    instance: sampleInstance(),
    rawContext: "intent: debug\n\n## pivots\nget_combinator_sql body here",
    error: null,
    classification: classificationWithPivots(PIVOT_CHECK_PIVOTS),
    preformatted: true,
  };
  const withVerify = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8 });
  const noVerify = buildVtraceContextMarkdown([section], { maxChars: 12000, maxItems: 8, disablePatchVerify: true });
  // The injected retrieved context (pivot rows, body) is identical except for the
  // appended checkpoint — PATCH_VERIFY adds guidance only, never altering retrieval.
  assert.ok(withVerify.markdown.includes("get_combinator_sql body here"));
  assert.ok(noVerify.markdown.includes("get_combinator_sql body here"));
  assert.match(withVerify.markdown, /sphinx\/pycode\/ast\.py/); // pivot rows unchanged
  assert.match(noVerify.markdown, /sphinx\/pycode\/ast\.py/);
});

async function v2InjectionResult(
  capsuleStdout: string,
  overrides: Record<string, unknown> = {},
): Promise<{ result: Awaited<ReturnType<typeof prepareIndexedContext>>; out: string }> {
  const out = path.join(await tmpDir("v2-pivot-source"), "results");
  const dataDir = await tmpDir("v2-pivot-source-data");
  const dataFile = await writeSweBenchData(dataDir, [NAV_RECORD]);
  const { run } = scriptedRunner([{ match: "capsule", result: { stdout: capsuleStdout } }]);
  const config = baseConfig({
    out,
    instances: ["django__django-11490"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
    capsuleEngine: "v2",
    capsuleIntent: "debug",
    capsuleBudget: 8000,
    contextPolicyOverride: "force-inject",
    ...overrides,
  });
  const result = await prepareIndexedContext(config, { runProcess: run });
  return { result, out };
}

test("v2 injection snapshot contains the top pivot's focused source body + metadata", async () => {
  const { result, out } = await v2InjectionResult(
    capsuleV2Json({ pivotSymbol: "get_combinator_sql", pivotSource: PIVOT_BODY }),
  );

  // The metadata is self-describing about the injected body.
  assert.equal(result.capsuleTopPivotHasSource, true);
  assert.equal(result.capsuleTopPivotSourceMode, "full");
  assert.equal(result.capsuleTopPivotSourceChars, PIVOT_BODY.length);
  assert.equal(result.capsuleTopPivotFile, "django/db/models/sql/compiler.py");
  assert.equal(result.capsuleTopPivotSymbol, "get_combinator_sql");

  // The written instructions snapshot carries the WHOLE body — including the deep
  // line the old 8-item line cap chopped — not just the path/symbol/reason.
  const ctx = await readFile(vtraceInstructionsFilePath(out), "utf8");
  assert.ok(ctx.includes("def get_combinator_sql(self, combinator, all):"));
  assert.ok(ctx.includes("compiler.query.set_values(self.query.values_select)"));
  assert.ok(ctx.includes("return parts"));
});

test("v2 injection keeps support signature-only (no source body) while the pivot has one", async () => {
  const { out } = await v2InjectionResult(
    capsuleV2Json({ pivotSource: PIVOT_BODY, support: [{ symbol: "values_list" }] }),
  );
  const ctx = await readFile(vtraceInstructionsFilePath(out), "utf8");

  // Support appears, as a signature, never as a source body.
  assert.ok(ctx.includes("○ support django/db/models/query.py::values_list"));
  assert.ok(ctx.includes("def values_list(self, *fields)"));
  // Exactly one focused-source block — the pivot's. Support is never given a body.
  assert.equal((ctx.match(/\n {2}source:/g) ?? []).length, 1);
});

test("v2 injection preserves budget accounting: body fits the char budget, sizes are reported", async () => {
  const { result } = await v2InjectionResult(
    capsuleV2Json({ pivotSource: PIVOT_BODY }),
  );
  // The capsule already budget-shaped the render, so at the default char budget
  // the body is present and not char-truncated; the size metadata is still recorded.
  assert.equal(result.contextTruncated, false);
  assert.ok(result.contextChars > PIVOT_BODY.length, "the assembled context must include the focused body");
  assert.ok(result.contextItems > 8, "preformatted context is not capped at the per-item line limit");
});

test("v2 injection with a signature-only pivot records missing source, not a pretend body", async () => {
  const { result, out } = await v2InjectionResult(capsuleV2Json());
  assert.equal(result.capsuleTopPivotHasSource, false);
  assert.equal(result.capsuleTopPivotSourceMode, "missing");
  assert.equal(result.capsuleTopPivotSourceChars, null);
  // The signature is still injected (it is what the capsule produced) but no body.
  const ctx = await readFile(vtraceInstructionsFilePath(out), "utf8");
  assert.ok(ctx.includes("get_combinator_sql"));
  assert.equal((ctx.match(/\n {2}source:/g) ?? []).length, 0);
});

test("prepareIndexedContext records PIVOT_CHECK enabled by default and the snapshot is untouched by the flag absent", async () => {
  // The default fixture is a single-pivot capsule, so PIVOT_CHECK never injects
  // naturally — the meta must still read enabled=true / disabledByFlag=false /
  // injected=false, distinguishing it from a flag-disabled run.
  const { result, out } = await v2InjectionResult(capsuleV2Json());
  assert.equal(result.pivotCheckEnabled, true);
  assert.equal(result.pivotCheckDisabledByFlag, false);
  assert.equal(result.pivotCheckInjected, false);
  // Telemetry is intact: real context was injected and capsule pivots recorded.
  assert.equal(result.contextInjected, true);
  assert.equal(result.capsulePivots.length, 1);

  const meta = indexedContextMetaFields(result);
  assert.equal(meta.vtracePivotCheckEnabled, true);
  assert.equal(meta.vtracePivotCheckInjected, false);
  assert.equal(meta.vtracePivotCheckDisabledByFlag, false);

  const ctx = await readFile(vtraceInstructionsFilePath(out), "utf8");
  assert.ok(!ctx.includes("PIVOT_CHECK"));
});

test("run metadata records vtracePivotCheckPolicy=strict_risk_gated when the default is used", async () => {
  // baseConfig mirrors the production default (DEFAULT_CONFIG): --pivot-check-policy
  // omitted ⇒ strict_risk_gated. The effective policy is recorded on the run metadata
  // even when nothing injects (single-pivot capsule), so the audit trail shows which
  // policy governed the run.
  const defaultPolicy = parseArgs(["--mode", "prepare", "--instances", "a__1"]).pivotCheckPolicy;
  assert.equal(defaultPolicy, "strict_risk_gated");
  const { result } = await v2InjectionResult(capsuleV2Json());
  assert.equal(result.pivotCheckPolicy, "strict_risk_gated");
  const meta = indexedContextMetaFields(result);
  assert.equal(meta.vtracePivotCheckPolicy, "strict_risk_gated");
});

test("--disable-pivot-check records disabled state and never injects the block; telemetry untouched", async () => {
  const { result, out } = await v2InjectionResult(capsuleV2Json(), { disablePivotCheck: true });
  // Flag state recorded for the before run.
  assert.equal(result.pivotCheckEnabled, false);
  assert.equal(result.pivotCheckDisabledByFlag, true);
  assert.equal(result.pivotCheckInjected, false);

  // The flag does NOT suppress the normal indexed context or its telemetry.
  assert.equal(result.contextInjected, true);
  assert.equal(result.capsulePivots.length, 1);
  assert.equal(result.capsuleTopPivotSymbol, "get_combinator_sql");

  const meta = indexedContextMetaFields(result);
  assert.equal(meta.vtracePivotCheckEnabled, false);
  assert.equal(meta.vtracePivotCheckDisabledByFlag, true);
  assert.equal(meta.vtracePivotCheckInjected, false);

  const ctx = await readFile(vtraceInstructionsFilePath(out), "utf8");
  assert.ok(!ctx.includes("PIVOT_CHECK"));
  // The retrieved capsule body is still present — only PIVOT_CHECK was removed.
  assert.ok(ctx.includes("get_combinator_sql"));
});

test("prepareIndexedContext records EDIT_GUARD enabled by default; meta + snapshot reflect it", async () => {
  // The default fixture is a single-pivot capsule, so neither PIVOT_CHECK nor the
  // guard that rides with it injects — but the meta must still read enabled=true /
  // disabledByFlag=false / injected=false (distinct from a flag-disabled run).
  const { result, out } = await v2InjectionResult(capsuleV2Json());
  assert.equal(result.editGuardEnabled, true);
  assert.equal(result.editGuardDisabledByFlag, false);
  assert.equal(result.editGuardInjected, false);
  assert.equal(result.editGuardTextPresent, false);
  // Retrieval telemetry is intact and unaffected by the guard feature.
  assert.equal(result.contextInjected, true);
  assert.equal(result.capsulePivots.length, 1);

  const meta = indexedContextMetaFields(result);
  assert.equal(meta.vtraceEditGuardEnabled, true);
  assert.equal(meta.vtraceEditGuardInjected, false);
  assert.equal(meta.vtraceEditGuardDisabledByFlag, false);
  assert.equal(meta.vtraceEditGuardTextPresent, false);

  const ctx = await readFile(vtraceInstructionsFilePath(out), "utf8");
  assert.ok(!ctx.includes("EDIT_GUARD"));
});

test("--disable-edit-guard records disabled state in result + meta; retrieval untouched", async () => {
  const { result } = await v2InjectionResult(capsuleV2Json(), { disableEditGuard: true });
  assert.equal(result.editGuardEnabled, false);
  assert.equal(result.editGuardDisabledByFlag, true);
  assert.equal(result.editGuardInjected, false);
  // PIVOT_CHECK state is independent of the edit-guard flag.
  assert.equal(result.pivotCheckEnabled, true);
  assert.equal(result.pivotCheckDisabledByFlag, false);
  // Retrieval telemetry is unaffected.
  assert.equal(result.contextInjected, true);
  assert.equal(result.capsulePivots.length, 1);

  const meta = indexedContextMetaFields(result);
  assert.equal(meta.vtraceEditGuardEnabled, false);
  assert.equal(meta.vtraceEditGuardDisabledByFlag, true);
  assert.equal(meta.vtraceEditGuardInjected, false);
});

test("prepareIndexedContext records PATCH_VERIFY enabled by default; meta + snapshot reflect it", async () => {
  // The default fixture is a single-pivot capsule, so neither PIVOT_CHECK nor the
  // checkpoint that rides with it injects — but the meta must still read enabled=true /
  // disabledByFlag=false / injected=false (distinct from a flag-disabled run).
  const { result, out } = await v2InjectionResult(capsuleV2Json());
  assert.equal(result.patchVerifyEnabled, true);
  assert.equal(result.patchVerifyDisabledByFlag, false);
  assert.equal(result.patchVerifyInjected, false);
  assert.equal(result.patchVerifyTextPresent, false);
  // Retrieval telemetry is intact and unaffected by the checkpoint feature.
  assert.equal(result.contextInjected, true);
  assert.equal(result.capsulePivots.length, 1);

  const meta = indexedContextMetaFields(result);
  assert.equal(meta.vtracePatchVerifyEnabled, true);
  assert.equal(meta.vtracePatchVerifyInjected, false);
  assert.equal(meta.vtracePatchVerifyDisabledByFlag, false);
  assert.equal(meta.vtracePatchVerifyTextPresent, false);

  const ctx = await readFile(vtraceInstructionsFilePath(out), "utf8");
  assert.ok(!ctx.includes("PATCH_VERIFY"));
});

test("--disable-patch-verify records disabled state in result + meta; EDIT_GUARD and retrieval untouched", async () => {
  const { result } = await v2InjectionResult(capsuleV2Json(), { disablePatchVerify: true });
  assert.equal(result.patchVerifyEnabled, false);
  assert.equal(result.patchVerifyDisabledByFlag, true);
  assert.equal(result.patchVerifyInjected, false);
  // PIVOT_CHECK and EDIT_GUARD state are independent of the patch-verify flag.
  assert.equal(result.pivotCheckEnabled, true);
  assert.equal(result.pivotCheckDisabledByFlag, false);
  assert.equal(result.editGuardEnabled, true);
  assert.equal(result.editGuardDisabledByFlag, false);
  // Retrieval telemetry is unaffected.
  assert.equal(result.contextInjected, true);
  assert.equal(result.capsulePivots.length, 1);

  const meta = indexedContextMetaFields(result);
  assert.equal(meta.vtracePatchVerifyEnabled, false);
  assert.equal(meta.vtracePatchVerifyDisabledByFlag, true);
  assert.equal(meta.vtracePatchVerifyInjected, false);
});

test("default config selects Capsule v2 and hard pivot-check gate stays off", () => {
  const cfg = parseArgs(["--mode", "run-protocol"]);
  // Engine-default migration: v2 is the default injected engine...
  assert.equal(cfg.capsuleEngine, "v2");
  // ...and the hard pivot-check gate is NOT made default by this migration.
  assert.equal(cfg.pivotCheckGate, "off");
});

test("default v2 injected path records effective engine v2 + compact inspect-first", async () => {
  const { result } = await v2InjectionResult(capsuleV2Json({ pivotSymbol: "get_combinator_sql" }));
  assert.equal(result.requestedCapsuleEngine, "v2");
  assert.equal(result.effectiveCapsuleEngine, "v2");
  assert.equal(result.capsuleEngineFallbackReason, null);
  assert.equal(result.compactInspectFirst, true);

  // The migration audit is exposed in the run meta and distinguishes requested vs
  // effective engine.
  const meta = indexedContextMetaFields(result);
  assert.equal(meta.vtraceRequestedCapsuleEngine, "v2");
  assert.equal(meta.vtraceEffectiveCapsuleEngine, "v2");
  assert.equal(meta.vtraceCapsuleEngineFallbackReason, null);
  assert.equal(meta.vtraceCompactInspectFirst, true);
});

test("a v2 query failure falls back to the legacy v1 engine and records the reason", async () => {
  const out = path.join(await tmpDir("v2-fallback"), "results");
  const dataDir = await tmpDir("v2-fallback-data");
  const dataFile = await writeSweBenchData(dataDir, [NAV_RECORD]);
  // The v2 capsule query (carries --pivot-neighborhood) fails; the legacy retry
  // (--mode, no --pivot-neighborhood) succeeds with a real injectable capsule.
  const { run, calls } = scriptedRunner([
    { match: "--pivot-neighborhood", result: { exitCode: 1, stderr: "v2 capsule build failed" } },
    { match: "capsule", result: { stdout: injectCapsuleJson("symbol: get_combinator_sql\nfile: django/db/models/sql/compiler.py") } },
  ]);
  const config = baseConfig({
    out,
    instances: ["django__django-11490"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
    capsuleEngine: "v2",
    contextPolicyOverride: "force-inject",
  });
  const result = await prepareIndexedContext(config, { runProcess: run });

  // Fallback happened: requested v2, effective legacy, reason recorded, compact
  // inspect-first off (legacy render), but context was still injected.
  assert.equal(result.requestedCapsuleEngine, "v2");
  assert.equal(result.effectiveCapsuleEngine, "legacy");
  assert.match(result.capsuleEngineFallbackReason ?? "", /v2 capsule build failed/);
  assert.equal(result.compactInspectFirst, false);
  assert.equal(result.indexedContext, true);
  assert.equal(result.capsuleEngine, "legacy"); // backward-compat field = effective

  // Both queries actually ran: the failing v2 one, then a legacy --mode retry.
  assert.ok(calls.some((c) => c.includes("capsule") && c.includes("--pivot-neighborhood")));
  assert.ok(calls.some((c) => c.includes("capsule") && c.includes("--mode") && !c.includes("--pivot-neighborhood")));
});

test("readIndexedContextFromMeta tolerates old runs lacking the engine-migration fields", () => {
  // An old run meta (recorded only the legacy single engine field, no migration audit).
  const old = readIndexedContextFromMeta({ vtraceCapsuleEngine: "legacy" });
  // Requested/effective default to the recorded engine; fallback null; compact unknown.
  assert.equal(old.vtraceRequestedCapsuleEngine, "legacy");
  assert.equal(old.vtraceEffectiveCapsuleEngine, "legacy");
  assert.equal(old.vtraceCapsuleEngineFallbackReason, null);
  assert.equal(old.vtraceCompactInspectFirst, null);

  // A fully empty meta degrades to nulls without throwing.
  const empty = readIndexedContextFromMeta({});
  assert.equal(empty.vtraceRequestedCapsuleEngine, null);
  assert.equal(empty.vtraceEffectiveCapsuleEngine, null);
  assert.equal(empty.vtraceCompactInspectFirst, null);
});

test("prepareIndexedContext with v2 issues a v2 query and records the engine metadata", async () => {
  const out = path.join(await tmpDir("v2-meta"), "results");
  const dataDir = await tmpDir("v2-meta-data");
  // A navigation-heavy instance whose v2 capsule recovers a strong pivot → inject.
  const dataFile = await writeSweBenchData(dataDir, [NAV_RECORD]);
  const { run, calls } = scriptedRunner([
    { match: "capsule", result: { stdout: capsuleV2Json({ pivotSymbol: "get_combinator_sql" }) } },
  ]);
  const config = baseConfig({
    out,
    instances: ["django__django-11490"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
    capsuleEngine: "v2",
    capsuleIntent: "debug",
    capsuleBudget: 8000,
  });
  const result = await prepareIndexedContext(config, { runProcess: run });

  // The capsule was queried via the v2 surface, not --mode.
  const capsuleCall = calls.find((line) => line.includes("capsule"))!;
  assert.match(capsuleCall, /--intent debug/);
  assert.match(capsuleCall, /--budget 8000/);
  assert.doesNotMatch(capsuleCall, /--mode/);

  assert.equal(result.indexedContext, true);
  assert.equal(result.capsuleEngine, "v2");
  assert.equal(result.capsuleIntent, "debug");
  assert.equal(result.capsuleBudget, 8000);
  assert.match(result.queryCommand ?? "", /--intent debug --budget 8000 --pivot-neighborhood --json/);

  // The metadata + report carry the engine.
  const written = await readFile(result.contextFile, "utf8");
  assert.match(written, /get_combinator_sql/);

  // A Capsule v2 evidence bundle is produced so the runner can persist the raw
  // manifest/ranking/context artifacts. The bundle carries the FULL result (with
  // ranking metadata) and the exact rendered Markdown that was injected.
  assert.equal(result.capsuleV2Bundles.length, 1);
  const bundle = result.capsuleV2Bundles[0]!;
  assert.equal(bundle.instanceId, "django__django-11490");
  assert.equal(bundle.result.pivots[0]?.symbol, "get_combinator_sql");
  assert.match(bundle.contextMarkdown, /get_combinator_sql/);
});

test("legacy engine records capsule_engine legacy with null intent/budget", async () => {
  const out = path.join(await tmpDir("legacy-meta"), "results");
  const dataDir = await tmpDir("legacy-meta-data");
  const dataFile = await writeSweBenchData(dataDir, [NAV_RECORD]);
  const { run } = scriptedRunner([
    { match: "capsule", result: { stdout: injectCapsuleJson("symbol: get_combinator_sql") } },
  ]);
  const config = baseConfig({
    out,
    instances: ["django__django-11490"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
  });
  const result = await prepareIndexedContext(config, { runProcess: run });
  assert.equal(result.capsuleEngine, "legacy");
  assert.equal(result.capsuleIntent, null);
  assert.equal(result.capsuleBudget, null);
  // The legacy engine produces no Capsule v2 result, so no artifact bundle exists
  // — the runner records this as "not persisted", never a false v2 claim.
  assert.equal(result.capsuleV2Bundles.length, 0);
});

test("force-inject works with the v2 engine: a cheap/local task still injects v2 context", async () => {
  const out = path.join(await tmpDir("v2-force"), "results");
  const dataDir = await tmpDir("v2-force-data");
  // 10880 is cheap/local: the auto gate declines even real context. Combined with
  // the v2 engine + force-inject, the v2-rendered context must still be injected.
  const dataFile = await writeSweBenchData(dataDir, [POLICY_RECORDS["django__django-10880"]]);
  const { run } = scriptedRunner([
    { match: "capsule", result: { stdout: capsuleV2Json({ pivotPath: "django/utils/html.py", pivotSymbol: "json_script" }) } },
  ]);
  const config = baseConfig({
    out,
    instances: ["django__django-10880"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
    capsuleEngine: "v2",
    contextPolicyOverride: "force-inject",
  });
  const result = await prepareIndexedContext(config, { runProcess: run });

  assert.equal(result.contextPolicyAction, "inject");
  assert.equal(result.contextInjected, true);
  assert.equal(result.capsuleEngine, "v2");
  assert.match(result.policyReason ?? "", /forced to inject for validation/);
  const written = await readFile(result.contextFile, "utf8");
  assert.match(written, /json_script/);
});

test("capsuleModeForInstance picks micro for a small/local single-test issue", () => {
  const mode = capsuleModeForInstance(
    toSweBenchInstance({
      repo: "django/django",
      instance_id: "django__django-10880",
      base_commit: "abc",
      problem_statement:
        "Add an encoder parameter to django.utils.html.json_script(). It hardcodes DjangoJSONEncoder.",
      hints_text: null,
      FAIL_TO_PASS: '["tests.utils_tests.test_html.TestUtilsHtml.test_json_script_custom_encoder"]',
    }),
  );
  assert.equal(mode, "micro");
});

test("capsuleModeForInstance picks full for a migrations/autodetector issue", () => {
  const mode = capsuleModeForInstance(
    toSweBenchInstance({
      repo: "django/django",
      instance_id: "django__django-11740",
      base_commit: "abc",
      problem_statement:
        "Change uuid field to FK does not create dependency. The migrations autodetector in "
        + "django/db/migrations/autodetector.py builds AlterField without a dependency on the "
        + "referenced model, and django/db/migrations/operations/fields.py is also involved.",
      hints_text: "generate_altered_fields() should add dependencies for new FK targets.",
      FAIL_TO_PASS: '["tests.migrations.test_autodetector.AutodetectorTests.test_alter_field_to_fk_dependency"]',
    }),
  );
  assert.equal(mode, "full");
});

const SAMPLE_PATCH = [
  "--- a/django/contrib/admin/options.py",
  "+++ b/django/contrib/admin/options.py",
  "@@ -580,6 +580,9 @@ class ModelAdmin(BaseModelAdmin):",
  "+    def get_inlines(self, request, obj=None):",
  "+        return self.inlines",
  "--- a/tests/admin_inlines/tests.py",
  "+++ b/tests/admin_inlines/tests.py",
  "@@ -1,0 +2,1 @@",
  "+    def test_get_inlines_override(self): pass",
].join("\n");

test("extractRow parses the final edited file/symbol from the model patch", () => {
  const row = extractRow(
    { instance_id: "django__django-11095", modelPatch: SAMPLE_PATCH },
    "vtrace",
    "raw/vtrace/r.json",
  )!;
  // Prefers the non-test source file and the added definition.
  assert.equal(row.finalEditedFile, "django/contrib/admin/options.py");
  assert.equal(row.finalEditedSymbol, "get_inlines");
});

test("extractInstanceContextSection pulls one instance's vtrace context block", () => {
  const md = buildVtraceContextMarkdown(
    [{ instance: sampleInstance(), rawContext: "file: admindocs/utils.py\nsymbol: replace_named_groups", error: null }],
    { maxChars: 12000, maxItems: 8 },
  ).markdown;
  const section = extractInstanceContextSection(md, "django__django-11728");
  assert.ok(section !== null);
  assert.match(section!, /replace_named_groups/);
  // Only the context block — not the Instruction footer or the Instance header.
  assert.doesNotMatch(section!, /Use the vtrace context above/);
  assert.doesNotMatch(section!, /instance_id:/);
  assert.equal(extractInstanceContextSection(md, "django__django-99999"), null);
});

test("stampCapsuleDiagnostics records mode + containment for a vtrace row", async () => {
  const out = await tmpDir("diag");
  const dataFile = path.join(out, "swe.jsonl");
  await writeFile(
    dataFile,
    `${JSON.stringify({
      repo: "django/django",
      instance_id: "django__django-11095",
      base_commit: "abc",
      problem_statement:
        "Add ModelAdmin.get_inlines() hook in django/contrib/admin/options.py that "
        + "get_inline_instances() calls instead of iterating self.inlines directly.",
      hints_text: "Long discussion; see https://github.com/django/django/pull/7920 for the stalled patch. "
        + "x".repeat(700),
      FAIL_TO_PASS: '["tests.admin_inlines.tests.TestInline.test_get_inlines_override"]',
    })}\n`,
  );
  const instructions = path.join(out, "_vtrace_instructions.md");
  await writeFile(
    instructions,
    [
      "## Instance",
      "",
      "- instance_id: django__django-11095",
      "",
      "## vtrace context",
      "",
      "likely edit targets: django/contrib/admin/options.py — ModelAdmin.get_inlines",
      "",
      "## Instruction",
      "",
    ].join("\n"),
  );

  const baseRow = extractRow(
    { instance_id: "django__django-11095", modelPatch: SAMPLE_PATCH },
    "vtrace",
    "raw/vtrace/r.json",
  )!;
  const row: Stage5Row = { ...baseRow, vtraceInstructionsFile: instructions };

  const [stamped] = await stampCapsuleDiagnostics([row], baseConfig({ out, sweBenchDataFile: dataFile }));

  assert.equal(stamped!.recommendedMode, "micro"); // long hints + URL must not escalate it
  assert.equal(stamped!.actualCapsuleMode, "micro");
  assert.equal(stamped!.targetConfidence, "high"); // explicit file + symbols + a failing test
  assert.equal(stamped!.topLikelyFile, "django/contrib/admin/options.py");
  // The injected context named the file and symbol the model edited.
  assert.equal(stamped!.containsFinalEditedFile, true);
  assert.equal(stamped!.containsFinalEditedSymbol, true);
});

test("stampCapsuleDiagnostics leaves rows untouched when the dataset is unavailable", async () => {
  const row = extractRow(
    { instance_id: "django__django-11095", modelPatch: SAMPLE_PATCH },
    "vtrace",
    "raw/vtrace/r.json",
  )!;
  // No dataset path configured -> recommendation fields stay null (not fabricated).
  const [stamped] = await stampCapsuleDiagnostics([row], baseConfig({ sweBenchDataFile: null, vexpSweBenchDir: null }));
  assert.equal(stamped!.recommendedMode, null);
  assert.equal(stamped!.containsFinalEditedFile, null);
  // The patch-derived field still survives from extractRow.
  assert.equal(stamped!.finalEditedFile, "django/contrib/admin/options.py");
});

test("renderCsv includes the capsule diagnostic columns and values", () => {
  const row = extractRow(
    { instance_id: "django__django-11095", modelPatch: SAMPLE_PATCH },
    "vtrace",
    "raw/vtrace/r.json",
  )!;
  const stamped: Stage5Row = {
    ...row,
    recommendedMode: "micro",
    actualCapsuleMode: "micro",
    targetConfidence: "medium",
    retrievalReason: "Small/local task",
    topLikelyFile: "django/contrib/admin/options.py",
    topLikelySymbol: "get_inlines",
    likelyTargetsCount: 1,
    containsFinalEditedFile: true,
    containsFinalEditedSymbol: true,
    vtraceContextChars: 154,
    vtraceContextItems: 3,
    // Capsule v2 audit + snapshot fields (Requirement 2): the CSV must expose
    // them under the same snake_case names the Markdown and meta-reader use.
    vtraceCapsuleEngine: "v2",
    vtraceCapsuleIntent: "debug",
    vtraceCapsuleBudget: 8000,
    vtraceCapsuleActualMode: "standard",
    vtraceCapsuleEstimatedTokens: 1685,
    vtraceCapsuleTopPivotFile: "django/db/models/sql/compiler.py",
    vtraceCapsuleTopPivotSymbol: "get_combinator_sql",
    vtraceCapsulePivots: [
      { path: "django/db/models/sql/compiler.py", symbol: "get_combinator_sql", roleReason: "anchor", estimatedTokens: 600 },
    ],
    vtraceCapsuleSupport: [
      { path: "django/db/models/query.py", symbol: "values_list", roleReason: "entry point", estimatedTokens: 200 },
    ],
    vtraceInstructionsSnapshotFile: "/out/runs/r/_vtrace_instructions.snapshot.md",
    vtraceInstructionsSha256: "c27777c51f763f4573b1b2ee356c155e0adfe614f7e10b74ddd95c6fdd55388b",
  };
  const csv = renderCsv([stamped]);
  const [header, dataRow] = csv.trim().split("\n");
  for (const col of [
    "recommended_mode",
    "actual_capsule_mode",
    "target_confidence",
    "top_likely_file",
    "final_edited_file",
    "contains_final_edited_file",
    "context_chars",
    "context_items",
    "vtrace_capsule_actual_mode",
    "vtrace_capsule_estimated_tokens",
    "vtrace_capsule_top_pivot_file",
    "vtrace_capsule_top_pivot_symbol",
    "vtrace_capsule_pivots",
    "vtrace_capsule_support",
    "vtrace_instructions_snapshot_file",
    "vtrace_instructions_sha256",
  ]) {
    assert.ok(header!.includes(col), `header missing ${col}`);
  }
  assert.ok(dataRow!.includes("django/contrib/admin/options.py"));
  assert.ok(dataRow!.includes("get_inlines"));
  assert.ok(dataRow!.includes("true"));
  // The capsule audit values land in the row, including the compact item list
  // and the snapshot hash.
  assert.ok(dataRow!.includes("get_combinator_sql"));
  assert.ok(dataRow!.includes("1685"));
  assert.ok(dataRow!.includes("django/db/models/sql/compiler.py::get_combinator_sql"));
  assert.ok(dataRow!.includes("django/db/models/query.py::values_list"));
  assert.ok(dataRow!.includes("c27777c51f763f4573b1b2ee356c155e0adfe614f7e10b74ddd95c6fdd55388b"));
});

test("extractCapsuleContext reads the context field from --json output and tolerates raw text", () => {
  const json = JSON.stringify({ diagnostics: { mode: "micro" }, context: "# vtrace context\nfoo" });
  assert.equal(extractCapsuleContext(json), "# vtrace context\nfoo");
  assert.equal(extractCapsuleContext("  plain text  "), "plain text");
  assert.equal(extractCapsuleContext("{not json"), "{not json");
});

test("buildVtraceContextMarkdown injects retrieved context without duplicating the problem statement", () => {
  const result = buildVtraceContextMarkdown(
    [{ instance: sampleInstance(), rawContext: "symbol: replace_named_groups\nfile: utils.py", error: null }],
    { maxChars: 12000, maxItems: 8 },
  );
  assert.match(result.markdown, /^# vtrace indexed context/);
  assert.match(result.markdown, /vexp is disabled/);
  assert.match(result.markdown, /## Instance/);
  assert.match(result.markdown, /- instance_id: django__django-11728/);
  assert.match(result.markdown, /## vtrace context/);
  assert.match(result.markdown, /symbol: replace_named_groups/);
  assert.match(result.markdown, /## Instruction/);
  // The full problem statement must NOT be re-dumped (the agent already has it).
  assert.doesNotMatch(result.markdown, /## Problem statement/);
  assert.doesNotMatch(result.markdown, /replace_named_groups does not handle trailing groups/);
  assert.ok(result.items > 0);
  assert.equal(result.truncated, false);
});

test("truncateContext truncates by max chars with a clear marker", () => {
  const raw = "x".repeat(500);
  const result = truncateContext(raw, 100, 50);
  assert.equal(result.truncated, true);
  assert.match(result.text, /\[truncated to 100 chars\]/);
  assert.ok(result.text.startsWith("x".repeat(100)));
});

test("truncateContext truncates by max items (non-empty lines)", () => {
  const raw = ["a", "b", "c", "d", "e"].join("\n");
  const result = truncateContext(raw, 12000, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.items, 2);
  assert.match(result.text, /^a\nb$/);
});

// A ProcessRunner that returns scripted results keyed by the first matching
// substring of the joined command, so each external step can be simulated.
function scriptedRunner(script: Array<{ match: string; result: Partial<ProcessResult> }>): {
  run: (command: string, args: readonly string[]) => Promise<ProcessResult>;
  calls: string[];
} {
  const calls: string[] = [];
  const run = async (command: string, args: readonly string[]): Promise<ProcessResult> => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    const entry = script.find((s) => line.includes(s.match));
    if (entry) return { exitCode: 0, stdout: "", stderr: "", ...entry.result };
    // Default: a valid, correctly-cloned workspace whose base commit is already present
    // — so probeUsableWorkspace/resetCleanToBase succeed without a clone/fetch.
    if (line.includes("rev-parse --is-inside-work-tree")) return { exitCode: 0, stdout: "true", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

test("prepareIndexedContext clones, indexes, queries, and writes a real context file", async () => {
  const out = path.join(await tmpDir("idx-ok"), "results");
  const dataDir = await tmpDir("idx-data");
  // A navigation-heavy instance with strong pivot evidence: the gate injects.
  const dataFile = await writeSweBenchData(dataDir, [NAV_RECORD]);
  const { run, calls } = scriptedRunner([
    { match: "capsule", result: { stdout: injectCapsuleJson("symbol: get_combinator_sql\nfile: django/db/models/sql/compiler.py") } },
  ]);
  const config = baseConfig({
    out,
    instances: ["django__django-11490"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
  });
  const result = await prepareIndexedContext(config, { runProcess: run });

  assert.equal(result.indexedContext, true);
  assert.equal(result.policyAction, "inject");
  assert.equal(result.contextPolicyAction, "inject");
  assert.ok(result.contextChars > 0);
  assert.ok(result.contextItems > 0);
  assert.match(result.indexCommand ?? "", /index/);
  assert.match(result.queryCommand ?? "", /capsule/);
  // The clone, index, and query were all invoked.
  assert.ok(calls.some((c) => c.includes("clone")));
  assert.ok(calls.some((c) => c.includes("index")));
  assert.ok(calls.some((c) => c.includes("capsule")));
  // The context file holds the real retrieval output, not generic instructions.
  const context = await readFile(vtraceInstructionsFilePath(out), "utf8");
  assert.match(context, /# vtrace indexed context/);
  assert.match(context, /symbol: get_combinator_sql/);
});

test("parseArgs parses --reuse-workspace and --show-vtrace-index-log (default off)", () => {
  const on = parseArgs(["--mode", "run-protocol", "--reuse-workspace", "--show-vtrace-index-log"]);
  assert.equal(on.reuseWorkspace, true);
  assert.equal(on.showVtraceIndexLog, true);
  const off = parseArgs(["--mode", "run-protocol"]);
  assert.equal(off.reuseWorkspace, false);
  assert.equal(off.showVtraceIndexLog, false);
});

test("buildVtraceIndexCommand always drops --quiet (index progress is always surfaced)", () => {
  // Default (no flag): --quiet still dropped so the indexer emits progress.
  const def = buildVtraceIndexCommand(baseConfig({ vtraceIndexArgs: "--quiet" }), "/ws");
  assert.deepEqual(def.args, ["src/cli/index.ts", "index", "/ws"]);
  // Flag set: same result (the flag no longer gates this).
  const loud = buildVtraceIndexCommand(baseConfig({ vtraceIndexArgs: "--quiet", showVtraceIndexLog: true }), "/ws");
  assert.deepEqual(loud.args, ["src/cli/index.ts", "index", "/ws"]);
});

test("prepareIndexedContext recreates a fresh workspace by default (clean + recheckout + reindex)", async () => {
  const out = path.join(await tmpDir("idx-fresh"), "results");
  const dataDir = await tmpDir("idx-fresh-data");
  const dataFile = await writeSweBenchData(dataDir, [NAV_RECORD]);
  // A pre-existing labeled workspace WITH a stale index present.
  const ws = workspacePathFor(out, "django__django-11490");
  await mkdir(path.join(ws, ".git"), { recursive: true });
  await mkdir(path.join(ws, ".vtrace"), { recursive: true });
  await writeFile(path.join(ws, ".vtrace", "index.sqlite"), "stale");
  const { run, calls } = scriptedRunner([
    { match: "capsule", result: { stdout: injectCapsuleJson("symbol: get_combinator_sql") } },
  ]);
  const config = baseConfig({ out, instances: ["django__django-11490"], sweBenchDataFile: dataFile, vtraceMethod: "indexed-context" });
  const result = await prepareIndexedContext(config, { runProcess: run });

  // The existing clone is scrubbed to base (reset --hard + clean -fdx), never
  // re-cloned, and re-indexed despite the stale index being present.
  assert.ok(calls.some((c) => c.includes("reset --hard")), "reset --hard to base must run");
  assert.ok(calls.some((c) => c.includes("clean") && c.includes("-fdx")), "git clean -fdx must run");
  assert.ok(calls.some((c) => c.includes(" index ")), "the index must be rebuilt");
  assert.ok(!calls.some((c) => c.includes("clone")), "an existing clone must not be re-cloned");
  assert.ok(!calls.some((c) => c.includes("pull")), "must never git pull main");
  // Meta records the fresh policy + the observed index timing.
  assert.equal(result.freshWorkspace, true);
  // The index never runs quiet now (progress is always surfaced).
  assert.equal(result.vtraceIndexQuiet, false);
  // Workspace prep observability: an existing valid workspace was reused + reset.
  assert.equal(result.workspaceReused, true);
  assert.equal(result.workspaceResetToBaseCommit, true);
  assert.equal(result.workspaceCleaned, true);
  assert.equal(result.workspaceGitRetryCount, 0);
  assert.equal(result.workspaceRecreatedAfterFailure, false);
  assert.equal(typeof result.vtraceIndexDurationMs, "number");
  assert.match(result.vtraceIndexStartedAt ?? "", /T.*Z$/);
  assert.match(result.vtraceIndexFinishedAt ?? "", /T.*Z$/);
});

test("prepareIndexedContext --reuse-workspace resets to base + cleans, reuses present index, no reclone", async () => {
  const out = path.join(await tmpDir("idx-reuse"), "results");
  const dataDir = await tmpDir("idx-reuse-data");
  const dataFile = await writeSweBenchData(dataDir, [NAV_RECORD]);
  const ws = workspacePathFor(out, "django__django-11490");
  await mkdir(path.join(ws, ".git"), { recursive: true });
  await mkdir(path.join(ws, ".vtrace"), { recursive: true });
  await writeFile(path.join(ws, ".vtrace", "index.sqlite"), "existing");
  const { run, calls } = scriptedRunner([
    { match: "capsule", result: { stdout: injectCapsuleJson("symbol: get_combinator_sql") } },
  ]);
  const config = baseConfig({
    out,
    instances: ["django__django-11490"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
    reuseWorkspace: true,
  });
  const result = await prepareIndexedContext(config, { runProcess: run });

  // Reuse still HARDENS the tree: reset --hard to base + clean -fdx run (the unsafe
  // "touch nothing" behavior is gone), but the repo is not re-cloned and a present
  // index is reused (no reindex). Never pulls main.
  assert.ok(calls.some((c) => c.includes("reset --hard")), "reuse must reset --hard to base");
  assert.ok(calls.some((c) => c.includes("clean") && c.includes("-fdx")), "reuse must git clean -fdx");
  assert.ok(!calls.some((c) => c.includes("clone")), "reuse must not re-clone");
  assert.ok(!calls.some((c) => c.includes("pull")), "reuse must never git pull main");
  assert.ok(!calls.some((c) => c.includes(" index ")), "reuse must not reindex when index.sqlite is present");
  assert.ok(calls.some((c) => c.includes("capsule")), "the query still runs");
  assert.equal(result.freshWorkspace, false);
  assert.equal(result.workspaceReused, true);
  assert.equal(result.workspaceResetToBaseCommit, true);
  assert.equal(result.workspaceCleaned, true);
  assert.equal(result.vtraceIndexStartedAt, null);
  assert.equal(result.vtraceIndexDurationMs, null);
});

// --- reusable clean workspace + git retry --------------------------------

const noSleep = async (): Promise<void> => {};

function testInstance(overrides: Partial<SweBenchInstance> = {}): SweBenchInstance {
  return {
    repo: "django/django",
    instanceId: "django__django-11490",
    baseCommit: "abc123base",
    problemStatement: "fix it",
    hintsText: null,
    failToPass: [],
    ...overrides,
  };
}

// A programmable git runner: each handler matches a command line and returns its
// results in sequence (last result repeats). Unmatched git calls succeed with empty
// output, except rev-parse --is-inside-work-tree which reports a valid tree.
// A programmable git runner. Handlers match on the git ARG TOKENS (e.g.
// args.includes("fetch")) — NOT the joined line — so a workspace path that happens to
// contain a git verb (e.g. a tmp dir named "…-fetch-…") never spuriously matches.
// Results are returned in sequence (last repeats). Unmatched calls succeed empty,
// except `rev-parse` which reports a valid work tree.
function gitMock(
  handlers: Array<{ when: (args: readonly string[]) => boolean; results: Array<Partial<ProcessResult>> }> = [],
): { run: (command: string, args: readonly string[], options?: unknown) => Promise<ProcessResult>; calls: string[] } {
  const calls: string[] = [];
  const counters = new Map<number, number>();
  const run = async (command: string, args: readonly string[]): Promise<ProcessResult> => {
    calls.push([command, ...args].join(" "));
    for (let i = 0; i < handlers.length; i += 1) {
      if (handlers[i]!.when(args)) {
        const n = counters.get(i) ?? 0;
        counters.set(i, n + 1);
        const seq = handlers[i]!.results;
        return { exitCode: 0, stdout: "", stderr: "", ...(seq[Math.min(n, seq.length - 1)] ?? {}) };
      }
    }
    if (args.includes("rev-parse")) return { exitCode: 0, stdout: "true", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

// The exact failure from the bug report (HTTP/2 reset mid-clone).
const BUG_REPORT_FETCH_ERROR =
  "error: RPC failed; curl 92 HTTP/2 stream 5 reset by server (error 0x8 CANCEL)\n" +
  "fetch-pack: unexpected disconnect while reading sideband packet\n" +
  "fatal: early EOF\nfatal: fetch-pack: invalid index-pack output";

test("isTransientGitError matches the bug-report failure and the documented transient set", () => {
  assert.equal(isTransientGitError(BUG_REPORT_FETCH_ERROR), true);
  for (const msg of [
    "remote end hung up unexpectedly",
    "Connection reset by peer",
    "GnuTLS recv error (-110): The TLS connection was non-properly terminated.",
    "fatal: early EOF",
  ]) {
    assert.equal(isTransientGitError(msg), true, msg);
  }
  // A deterministic failure is NOT retried.
  assert.equal(isTransientGitError("fatal: couldn't find remote ref abc123base"), false);
  assert.equal(isTransientGitError("Permission denied (publickey)."), false);
  // HTTP/2 detection drives the HTTP/1.1 fallback.
  assert.equal(isHttp2GitError(BUG_REPORT_FETCH_ERROR), true);
  assert.equal(isHttp2GitError("fatal: early EOF"), false);
});

test("gitWithRetry retries a transient failure then succeeds, switching to HTTP/1.1", async () => {
  const { run, calls } = gitMock([
    {
      when: (a) => a.includes("clone"),
      results: [{ exitCode: 128, stderr: BUG_REPORT_FETCH_ERROR }, { exitCode: 0 }],
    },
  ]);
  const outcome = await gitWithRetry(run, ["clone", "--progress", "url", "/ws"], { sleep: noSleep });
  assert.equal(outcome.result.exitCode, 0);
  assert.equal(outcome.retries, 1);
  assert.equal(outcome.fallbackUsed, true);
  // The retry used the HTTP/1.1 transport fallback (process-local, not global config).
  assert.ok(calls.some((c) => c.includes("-c http.version=HTTP/1.1 clone")));
});

test("gitWithRetry does NOT retry a deterministic (non-transient) failure", async () => {
  const { run, calls } = gitMock([
    { when: (a) => a.includes("fetch"), results: [{ exitCode: 128, stderr: "fatal: couldn't find remote ref deadbeef" }] },
  ]);
  const outcome = await gitWithRetry(run, ["fetch", "origin", "deadbeef"], { sleep: noSleep });
  assert.equal(outcome.result.exitCode, 128);
  assert.equal(outcome.retries, 0);
  assert.equal(calls.filter((c) => c.includes("fetch")).length, 1);
});

test("gitWithRetry respects the attempt limit on persistent transient failure", async () => {
  const { run, calls } = gitMock([
    { when: (a) => a.includes("clone"), results: [{ exitCode: 128, stderr: BUG_REPORT_FETCH_ERROR }] },
  ]);
  const outcome = await gitWithRetry(run, ["clone", "url", "/ws"], { sleep: noSleep });
  assert.equal(outcome.result.exitCode, 128);
  assert.equal(outcome.retries, GIT_RETRY_BACKOFF_MS.length - 1); // 2 retries after the first attempt
  assert.equal(calls.filter((c) => c.includes("clone")).length, 3); // 3 total attempts
});

test("reused workspace resets tracked changes to base and cleans untracked, no reclone, no main", async () => {
  const ws = path.join(await tmpDir("prep-reuse"), "ws");
  await mkdir(path.join(ws, ".git"), { recursive: true });
  const { run, calls } = gitMock(); // base commit present (cat-file → 0), reset/clean ok
  const prep = await prepareWorkspaceForInstance({ instance: testInstance(), workspace: ws, runProc: run, sleep: noSleep });

  assert.equal(prep.reused, true);
  assert.equal(prep.resetToBaseCommit, true);
  assert.equal(prep.cleaned, true);
  assert.equal(prep.recreatedAfterFailure, false);
  assert.equal(prep.gitRetryCount, 0);
  assert.equal(prep.baseCommit, "abc123base");
  // Exact safe sequence, no clone, no pull/main.
  assert.ok(calls.some((c) => c.includes("reset --hard abc123base")), "reset --hard <base>");
  assert.ok(calls.some((c) => c.includes("clean -fdx -e .vtrace")), "clean -fdx");
  assert.ok(!calls.some((c) => c.includes("clone")), "no reclone");
  assert.ok(!calls.some((c) => c.includes("pull") || c.includes(" main")), "never pulls main");
});

test("reused workspace fetches ONLY the base commit when it is missing locally (with retry)", async () => {
  const ws = path.join(await tmpDir("prep-fetch"), "ws");
  await mkdir(path.join(ws, ".git"), { recursive: true });
  const { run, calls } = gitMock([
    // base commit absent locally → must fetch it; first fetch resets transiently, then ok
    { when: (a) => a.includes("cat-file"), results: [{ exitCode: 1 }] },
    { when: (a) => a.includes("fetch"), results: [{ exitCode: 128, stderr: "fatal: early EOF" }, { exitCode: 0 }] },
  ]);
  const prep = await prepareWorkspaceForInstance({ instance: testInstance(), workspace: ws, runProc: run, sleep: noSleep });

  assert.equal(prep.reused, true);
  assert.equal(prep.gitRetryCount, 1);
  // The fetch targets the exact base commit (not main) and prunes/tags.
  assert.ok(calls.some((c) => c.includes("fetch origin abc123base --tags --prune")), "fetch targets base commit");
  assert.ok(!calls.some((c) => c.includes(" main")), "never fetches main");
});

test("wrong-repo workspace is removed and recreated safely (recreatedAfterFailure)", async () => {
  const ws = path.join(await tmpDir("prep-wrong"), "ws");
  await mkdir(path.join(ws, ".git"), { recursive: true });
  const { run, calls } = gitMock([
    // origin points at a DIFFERENT repo → probe rejects → recreate
    { when: (a) => a.includes("get-url"), results: [{ exitCode: 0, stdout: "https://github.com/other/thing.git" }] },
  ]);
  const prep = await prepareWorkspaceForInstance({ instance: testInstance(), workspace: ws, runProc: run, sleep: noSleep });

  assert.equal(prep.reused, false);
  assert.equal(prep.recreatedAfterFailure, true);
  assert.equal(prep.resetToBaseCommit, true);
  assert.ok(calls.some((c) => c.includes("clone")), "the correct repo is cloned");
});

test("corrupt workspace (rev-parse fails) is recreated safely", async () => {
  const ws = path.join(await tmpDir("prep-corrupt"), "ws");
  await mkdir(path.join(ws, ".git"), { recursive: true });
  const { run, calls } = gitMock([
    { when: (a) => a.includes("rev-parse"), results: [{ exitCode: 128, stderr: "fatal: not a git repository" }] },
  ]);
  const prep = await prepareWorkspaceForInstance({ instance: testInstance(), workspace: ws, runProc: run, sleep: noSleep });

  assert.equal(prep.recreatedAfterFailure, true);
  assert.equal(prep.reused, false);
  assert.ok(calls.some((c) => c.includes("clone")), "recreated by clone");
});

test("absent workspace clones fresh (NOT a failure recreate) and resets to base", async () => {
  const ws = path.join(await tmpDir("prep-absent"), "ws", "nested"); // does not exist
  const { run, calls } = gitMock();
  const prep = await prepareWorkspaceForInstance({ instance: testInstance(), workspace: ws, runProc: run, sleep: noSleep });

  assert.equal(prep.reused, false);
  assert.equal(prep.recreatedAfterFailure, false); // brand-new clone, no prior dir
  assert.equal(prep.resetToBaseCommit, true);
  assert.ok(calls.some((c) => c.includes("clone")), "fresh clone");
  assert.ok(calls.some((c) => c.includes("reset --hard abc123base")), "reset to base");
});

test("transient clone failures are retried then succeed; metadata records retries + fallback", async () => {
  const ws = path.join(await tmpDir("prep-retry"), "ws");
  const { run, calls } = gitMock([
    { when: (a) => a.includes("clone"), results: [{ exitCode: 128, stderr: BUG_REPORT_FETCH_ERROR }, { exitCode: 128, stderr: BUG_REPORT_FETCH_ERROR }, { exitCode: 0 }] },
  ]);
  const prep = await prepareWorkspaceForInstance({ instance: testInstance(), workspace: ws, runProc: run, sleep: noSleep });

  assert.equal(prep.gitRetryCount, 2);
  assert.equal(prep.fallbackUsed, true); // HTTP/2 error → HTTP/1.1 fallback engaged
  assert.equal(prep.resetToBaseCommit, true);
  assert.equal(calls.filter((c) => c.includes("clone")).length, 3);
});

test("persistent clone failure aborts before spawn with a clear no-tokens message", async () => {
  const ws = path.join(await tmpDir("prep-persist"), "ws");
  const { run, calls } = gitMock([
    { when: (a) => a.includes("clone"), results: [{ exitCode: 128, stderr: BUG_REPORT_FETCH_ERROR }] },
  ]);
  await assert.rejects(
    () => prepareWorkspaceForInstance({ instance: testInstance(), workspace: ws, runProc: run, sleep: noSleep }),
    (err: unknown) => {
      assert.ok(err instanceof WorkspacePreparationError);
      assert.match((err as Error).message, /no model tokens were spent/);
      return true;
    },
  );
  assert.equal(calls.filter((c) => c.includes("clone")).length, 3); // retried up to the limit, then aborted
});

test("--reuse-workspace help text documents reset-to-base + clean semantics", () => {
  // The help string is emitted by printing usage; assert the documented wording exists
  // in the module source so the operator-facing meaning ("reset to base", not "continue
  // from previous edits") cannot silently regress.
  const source = readFileSync(
    path.join(import.meta.dir, "run_stage5_vexp_swe_bench_smoke.ts"),
    "utf8",
  );
  const helpLine = source.split("\n").find((l) => l.includes('"  --reuse-workspace'));
  assert.ok(helpLine, "the --reuse-workspace help line must exist");
  assert.match(helpLine!, /RESETTING it to the SWE-bench base commit/);
  assert.match(helpLine!, /git clean -fdx/);
  assert.match(helpLine!, /never pulls main/);
});

// --- index-reuse policy --------------------------------------------------

async function workspaceWithIndex(label: string, makeStale = false): Promise<string> {
  const ws = path.join(await tmpDir(label), "ws");
  await mkdir(path.join(ws, ".vtrace"), { recursive: true });
  await writeFile(path.join(ws, ".vtrace", "index.sqlite"), "db");
  const meta = await buildIndexMeta(ws);
  await writeIndexMeta(ws, makeStale ? { ...meta, parser_fingerprint: "stale-fingerprint" } : meta);
  return ws;
}

test("decideIndexPolicy auto reuses a fresh index", async () => {
  const ws = await workspaceWithIndex("policy-auto-fresh");
  const decision = await decideIndexPolicy("auto", ws);

  assert.equal(decision.reuse, true);
  assert.equal(decision.fresh, true);
  assert.deepEqual(decision.mismatches, []);
});

test("decideIndexPolicy auto rebuilds a stale index", async () => {
  const ws = await workspaceWithIndex("policy-auto-stale", true);
  const decision = await decideIndexPolicy("auto", ws);

  assert.equal(decision.reuse, false);
  assert.equal(decision.fresh, false);
  assert.deepEqual(decision.mismatches, ["parser_fingerprint"]);
});

test("decideIndexPolicy always rebuilds even a fresh index", async () => {
  const ws = await workspaceWithIndex("policy-always-fresh");
  const decision = await decideIndexPolicy("always", ws);

  assert.equal(decision.reuse, false);
  assert.match(decision.reason, /forced rebuild/);
});

test("decideIndexPolicy reuse keeps a stale index", async () => {
  const ws = await workspaceWithIndex("policy-reuse-stale", true);
  const decision = await decideIndexPolicy("reuse", ws);

  assert.equal(decision.reuse, true);
  assert.equal(decision.fresh, false);
  assert.deepEqual(decision.mismatches, ["parser_fingerprint"]);
});

test("prepareIndexedContext --index-policy auto reuses a fresh index without reindexing", async () => {
  const out = path.join(await tmpDir("idx-pol-auto"), "results");
  const dataFile = await writeSweBenchData(await tmpDir("idx-pol-auto-data"), [NAV_RECORD]);
  const ws = workspacePathFor(out, "django__django-11490");
  await mkdir(path.join(ws, ".git"), { recursive: true });
  await mkdir(path.join(ws, ".vtrace"), { recursive: true });
  await writeFile(path.join(ws, ".vtrace", "index.sqlite"), "db");
  await writeIndexMeta(ws, await buildIndexMeta(ws));
  const { run, calls } = scriptedRunner([
    { match: "capsule", result: { stdout: injectCapsuleJson("symbol: get_combinator_sql") } },
  ]);
  const result = await prepareIndexedContext(
    baseConfig({ out, instances: ["django__django-11490"], sweBenchDataFile: dataFile, vtraceMethod: "indexed-context", indexPolicy: "auto" }),
    { runProcess: run },
  );

  // The workspace is reset --hard + cleaned (preserving .vtrace via `-e .vtrace`)
  // BEFORE the freshness check, and the still-fresh index is then reused (not rebuilt).
  assert.ok(calls.some((c) => c.includes("reset --hard")), "reset to base runs before the freshness check");
  assert.ok(calls.some((c) => c.includes("clean -fdx -e .vtrace")), "clean preserves .vtrace so a fresh index survives");
  assert.ok(!calls.some((c) => c.includes(" index ")), "a fresh index must not be rebuilt under --index-policy auto");
  assert.equal(result.vtraceIndexPolicy, "auto");
  assert.equal(result.vtraceIndexReused, true);
  assert.equal(result.vtraceIndexFresh, true);
  assert.equal(result.workspaceReused, true);
  assert.equal(result.vtraceIndexFreshnessReason, "index metadata matches");
  assert.deepEqual(result.vtraceIndexMismatches, []);
  assert.equal(result.vtraceIndexMetaFile, resolveIndexMetaPath(ws));
});

test("prepareIndexedContext --index-policy auto rebuilds a stale index", async () => {
  const out = path.join(await tmpDir("idx-pol-stale"), "results");
  const dataFile = await writeSweBenchData(await tmpDir("idx-pol-stale-data"), [NAV_RECORD]);
  const ws = workspacePathFor(out, "django__django-11490");
  await mkdir(path.join(ws, ".git"), { recursive: true });
  await mkdir(path.join(ws, ".vtrace"), { recursive: true });
  await writeFile(path.join(ws, ".vtrace", "index.sqlite"), "db");
  const meta = await buildIndexMeta(ws);
  await writeIndexMeta(ws, { ...meta, parser_fingerprint: "stale-fingerprint" });
  const { run, calls } = scriptedRunner([
    { match: "capsule", result: { stdout: injectCapsuleJson("symbol: get_combinator_sql") } },
  ]);
  const result = await prepareIndexedContext(
    baseConfig({ out, instances: ["django__django-11490"], sweBenchDataFile: dataFile, vtraceMethod: "indexed-context", indexPolicy: "auto" }),
    { runProcess: run },
  );

  assert.ok(calls.some((c) => c.includes(" index ")), "a stale index must be rebuilt under --index-policy auto");
  assert.equal(result.vtraceIndexReused, false);
  assert.equal(result.vtraceIndexFresh, false);
  assert.deepEqual(result.vtraceIndexMismatches, ["parser_fingerprint"]);
});

test("prepareIndexedContext --index-policy always rebuilds and clears .vtrace even when fresh", async () => {
  const out = path.join(await tmpDir("idx-pol-always"), "results");
  const dataFile = await writeSweBenchData(await tmpDir("idx-pol-always-data"), [NAV_RECORD]);
  const ws = workspacePathFor(out, "django__django-11490");
  await mkdir(path.join(ws, ".git"), { recursive: true });
  await mkdir(path.join(ws, ".vtrace"), { recursive: true });
  await writeFile(path.join(ws, ".vtrace", "index.sqlite"), "db");
  await writeIndexMeta(ws, await buildIndexMeta(ws));
  const { run, calls } = scriptedRunner([
    { match: "capsule", result: { stdout: injectCapsuleJson("symbol: get_combinator_sql") } },
  ]);
  const result = await prepareIndexedContext(
    baseConfig({ out, instances: ["django__django-11490"], sweBenchDataFile: dataFile, vtraceMethod: "indexed-context", indexPolicy: "always" }),
    { runProcess: run },
  );

  assert.ok(calls.some((c) => c.includes(" index ")), "--index-policy always must rebuild even a fresh index");
  assert.equal(result.vtraceIndexReused, false);
  // The pre-existing .vtrace was removed before the (scripted) rebuild.
  assert.equal(await readIndexMeta(ws), undefined);
});

test("prepareIndexedContext --index-policy reuse keeps a stale index and warns loudly", async () => {
  const out = path.join(await tmpDir("idx-pol-reuse"), "results");
  const dataFile = await writeSweBenchData(await tmpDir("idx-pol-reuse-data"), [NAV_RECORD]);
  const ws = workspacePathFor(out, "django__django-11490");
  await mkdir(path.join(ws, ".git"), { recursive: true });
  await mkdir(path.join(ws, ".vtrace"), { recursive: true });
  await writeFile(path.join(ws, ".vtrace", "index.sqlite"), "db");
  const meta = await buildIndexMeta(ws);
  await writeIndexMeta(ws, { ...meta, parser_fingerprint: "stale-fingerprint" });
  const { run, calls } = scriptedRunner([
    { match: "capsule", result: { stdout: injectCapsuleJson("symbol: get_combinator_sql") } },
  ]);

  const warnings: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    warnings.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let result;
  try {
    result = await prepareIndexedContext(
      baseConfig({ out, instances: ["django__django-11490"], sweBenchDataFile: dataFile, vtraceMethod: "indexed-context", indexPolicy: "reuse" }),
      { runProcess: run },
    );
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.ok(!calls.some((c) => c.includes(" index ")), "--index-policy reuse must not reindex a present index");
  assert.equal(result.vtraceIndexReused, true);
  assert.equal(result.vtraceIndexFresh, false);
  assert.ok(
    warnings.some((line) => line.includes("WARNING") && line.includes("STALE")),
    "a loud warning must be emitted when reusing a stale index",
  );
});

test("parseArgs parses --index-policy (default auto)", () => {
  assert.equal(parseArgs(["--mode", "run-protocol"]).indexPolicy, "auto");
  assert.equal(parseArgs(["--mode", "run-protocol", "--index-policy", "always"]).indexPolicy, "always");
  assert.equal(parseArgs(["--mode", "run-protocol", "--index-policy", "reuse"]).indexPolicy, "reuse");
  assert.throws(() => parseArgs(["--mode", "run-protocol", "--index-policy", "bogus"]), /Invalid --index-policy/);
});

// The index is TTY-aware: a real terminal inherits stdio (fancy bar); a piped stderr
// (the test runner's case, and `… | tee`) runs the index QUIETLY — no inherit, no tee,
// and crucially no forced VTRACE_PROGRESS_STREAM, so the verbose per-file fallback
// ([read] N/M …) is never dumped. `--quiet` is always dropped so the TTY bar isn't
// gated off.
async function captureIndexOpts(
  configOverrides: Record<string, unknown>,
): Promise<{ indexArgs: readonly string[]; indexOpts: { env?: Record<string, string>; inheritStdio?: boolean; streamToTerminal?: boolean } | undefined }> {
  const out = path.join(await tmpDir("idx-opts"), "results");
  const dataDir = await tmpDir("idx-opts-data");
  const dataFile = await writeSweBenchData(dataDir, [NAV_RECORD]);
  let indexArgs: readonly string[] = [];
  let indexOpts: { env?: Record<string, string>; inheritStdio?: boolean; streamToTerminal?: boolean } | undefined;
  const run = async (
    command: string,
    args: readonly string[],
    options?: { env?: Record<string, string>; inheritStdio?: boolean; streamToTerminal?: boolean },
  ): Promise<ProcessResult> => {
    const line = [command, ...args].join(" ");
    if (line.includes(" index ")) {
      indexArgs = args;
      indexOpts = options;
    }
    if (line.includes("capsule")) return { exitCode: 0, stdout: injectCapsuleJson("symbol: x"), stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const config = baseConfig({
    out,
    instances: ["django__django-11490"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
    ...configOverrides,
  });
  await prepareIndexedContext(config, { runProcess: run });
  return { indexArgs, indexOpts };
}

test("piped index runs quietly: --quiet dropped but NO verbose per-file fallback", async () => {
  // The test runner's stderr is not a TTY (the `… | tee` case). The index must NOT
  // dump the [read]/[parse] N/M per-file stream: no forced VTRACE_PROGRESS_STREAM, no
  // tee, no inherit — just a quiet captured run.
  const { indexArgs, indexOpts } = await captureIndexOpts({ showVtraceIndexLog: true });
  assert.ok(!indexArgs.includes("--quiet"), "--quiet is dropped so the TTY bar isn't gated off");
  assert.notEqual(indexOpts?.env?.VTRACE_PROGRESS_STREAM, "1", "the verbose per-file fallback must NOT be forced on when piped");
  assert.notEqual(indexOpts?.streamToTerminal, true, "a piped index is not tee'd (would echo per-file noise)");
  assert.notEqual(indexOpts?.inheritStdio, true, "a piped stderr cannot draw the fancy TTY bar");
});

test("the flag no longer changes piped index behavior (quiet either way)", async () => {
  const withFlag = await captureIndexOpts({ showVtraceIndexLog: true });
  const without = await captureIndexOpts({});
  for (const { indexArgs, indexOpts } of [withFlag, without]) {
    assert.ok(!indexArgs.includes("--quiet"));
    assert.notEqual(indexOpts?.env?.VTRACE_PROGRESS_STREAM, "1");
    assert.notEqual(indexOpts?.inheritStdio, true);
  }
});

test("prepareIndexedContext reports failure when the vtrace query fails", async () => {
  const out = path.join(await tmpDir("idx-fail"), "results");
  const dataDir = await tmpDir("idx-fail-data");
  const dataFile = await writeSweBenchData(dataDir, [SAMPLE_RECORD]);
  const { run } = scriptedRunner([{ match: "capsule", result: { exitCode: 1, stderr: "boom" } }]);
  const config = baseConfig({ out, instances: ["django__django-11728"], sweBenchDataFile: dataFile, vtraceMethod: "indexed-context" });
  const result = await prepareIndexedContext(config, { runProcess: run });

  assert.equal(result.indexedContext, false);
  assert.match(result.contextError ?? "", /vtrace query failed/);
});

test("run-vtrace indexed-context aborts before spawn when context generation fails", async () => {
  const vexpDir = await fakeVexpDir();
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");
  const out = path.join(await tmpDir("idx-abort"), "results");
  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  const dataDir = await tmpDir("idx-abort-data");
  const dataFile = await writeSweBenchData(dataDir, [SAMPLE_RECORD]);

  let vexpSpawned = false;
  const run = async (command: string, args: readonly string[]): Promise<ProcessResult> => {
    if ([command, ...args].join(" ").includes("dist/cli.js")) vexpSpawned = true;
    // Make the vtrace capsule query fail so no context is generated.
    if ([command, ...args].join(" ").includes("capsule")) return { exitCode: 1, stdout: "", stderr: "no index" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const config = baseConfig({
    vexpSweBenchDir: vexpDir,
    out,
    instances: ["django__django-11728"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
  });
  await assert.rejects(() => runVtrace(config, { runProcess: run }), /produced no vtrace context/);
  assert.equal(vexpSpawned, false);
});

test("indexed-context keeps --no-vexp in the spawned benchmark command", async () => {
  const vexpDir = await fakeVexpDir();
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");
  const out = path.join(await tmpDir("idx-novexp"), "results");
  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  const dataDir = await tmpDir("idx-novexp-data");
  const dataFile = await writeSweBenchData(dataDir, [SAMPLE_RECORD]);

  let vexpArgs: readonly string[] = [];
  const run = async (command: string, args: readonly string[]): Promise<ProcessResult> => {
    const line = [command, ...args].join(" ");
    if (line.includes("dist/cli.js")) vexpArgs = args;
    if (line.includes("capsule")) return { exitCode: 0, stdout: "real context\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const config = baseConfig({
    vexpSweBenchDir: vexpDir,
    out,
    instances: ["django__django-11728"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
  });
  await runVtrace(config, { runProcess: run });
  assert.ok(vexpArgs.includes("--no-vexp"));
  assert.ok(!vexpArgs.some((a) => a === "--vexp" || a === "--enable-vexp"));
});

test("indexed-context treatment is valid only with context + observed injection; report shows evidence", async () => {
  const out = path.join(await tmpDir("idx-valid"), "results");
  const contextFile = vtraceInstructionsFilePath(out);
  await seedCondition(out, "baseline", { resolved: null });
  await seedCondition(out, "vtrace", {
    resolved: null,
    vtraceMethod: "indexed-context",
    instructionsFile: contextFile,
    indexedContext: true,
    contextFileContent: "# vtrace indexed context\n\nreal stuff\n",
    stderr: `${STAGE5_VTRACE_INJECTION_LOG} ${contextFile}\n`,
    metaExtra: { vtraceContextFile: contextFile, vtraceContextChars: 20, vtraceContextItems: 2, vtraceContextTruncated: false },
  });
  const artifact = await runIngest(baseConfig({ out }));
  assert.equal(artifact.evidence.vtraceMethod, "indexed-context");
  assert.equal(artifact.evidence.vtraceIndexedContext, true);
  assert.equal(artifact.evidence.vtraceTreatmentValid, true);

  const md = await readFile(path.join(out, "stage5_vexp_swe_bench_smoke.md"), "utf8");
  assert.match(md, /## Vtrace indexed context evidence/);
  assert.match(md, /\| vtrace_indexed_context \| true \|/);
});

test("indexed-context is invalid when context was not generated, and the report warns", async () => {
  const out = path.join(await tmpDir("idx-invalid"), "results");
  const contextFile = vtraceInstructionsFilePath(out);
  await seedCondition(out, "baseline", { resolved: null });
  await seedCondition(out, "vtrace", {
    resolved: null,
    vtraceMethod: "indexed-context",
    instructionsFile: contextFile,
    indexedContext: false,
    contextFileContent: "# vtrace indexed context\n\n(unavailable)\n",
    stderr: `${STAGE5_VTRACE_INJECTION_LOG} ${contextFile}\n`,
  });
  const artifact = await runIngest(baseConfig({ out }));
  assert.equal(artifact.evidence.vtraceTreatmentValid, false);

  const md = await readFile(path.join(out, "stage5_vexp_swe_bench_smoke.md"), "utf8");
  assert.match(md, /Vtrace indexed context was not generated; this run is not a valid indexed-context treatment\./);
});

test("--vtrace-method indexed-context is accepted by the parser", () => {
  assert.equal(parseArgs(["--vtrace-method", "indexed-context"]).vtraceMethod, "indexed-context");
});

function makeRow(
  instanceId: string,
  condition: "baseline" | "vtrace" | "vexp",
  overrides: Partial<Stage5Row>,
): Stage5Row {
  return {
    instanceId,
    condition,
    resolved: "unknown",
    costUsd: "unknown",
    durationMs: "unknown",
    inputTokens: "unknown",
    outputTokens: "unknown",
    cacheReadTokens: "unknown",
    cacheCreationTokens: "unknown",
    totalTokens: "unknown",
    tokenAccountingMethod: "unavailable",
    numTurns: "unknown",
    toolCallsTotal: "unknown",
    toolCallsBreakdown: null,
    patchAvailable: "unknown",
    patchLines: "unknown",
    model: null,
    agent: null,
    repo: null,
    vtraceMethod: null,
    vtraceInstructionsFile: null,
    vtraceInstructionsFileExists: null,
    vtraceInstructionsFileSize: null,
    vtraceInjectionObserved: null,
    vtraceInjectionError: null,
    vtraceTreatmentValid: null,
    vtraceIndexedContext: null,
    vtraceIndexCommand: null,
    vtraceQueryCommand: null,
    vtraceWorkspacePath: null,
    vtraceContextFile: null,
    vtraceContextChars: null,
    vtraceContextItems: null,
    vtraceContextTruncated: null,
    vtraceContextError: null,
    evaluationRan: null,
    evaluationMethod: null,
    failToPassPassed: null,
    passToPassPassed: null,
    testStatus: null,
    dockerUsed: null,
    evaluationError: null,
    error: null,
    rawResultPath: `raw/${condition}/r.json`,
    parserKind: "json",
    parsedFieldCount: 1,
    notes: [],
    ...overrides,
  };
}

function summaryOf(rows: Stage5Row[]) {
  return {
    instanceCount: new Set(rows.map((row) => row.instanceId)).size,
    baselineRuns: rows.filter((row) => row.condition === "baseline").length,
    vtraceRuns: rows.filter((row) => row.condition === "vtrace").length,
    bothResolved: 0,
    vtraceOnlyResolved: 0,
    baselineOnlyResolved: 0,
    bothFailed: 0,
    unpaired: 0,
    unknown: 0,
    meanTokenReductionBothResolved: null,
    meanCostReductionBothResolved: null,
    meanDurationReductionBothResolved: null,
    vtraceConditionRun: rows.some((row) => row.condition === "vtrace"),
  };
}

// ----- Stage 5C: evaluated SWE-bench protocol --------------------------------

// Create a fake vexp-swe-bench dir whose dist/cli.js exists so the run/evaluate
// guards pass without the real external checkout.
async function fakeVexpCliDir(): Promise<string> {
  const dir = await tmpDir("vexp-cli");
  await mkdir(path.join(dir, "dist"), { recursive: true });
  await writeFile(path.join(dir, "dist", "cli.js"), "// fake cli\n");
  return dir;
}

test("resolved is detected from a record, and absent resolved stays unknown", () => {
  const yes = extractRow({ instance_id: "a__1", resolved: true }, "baseline", "raw/baseline/r.json");
  const no = extractRow({ instance_id: "a__1", solved: false }, "baseline", "raw/baseline/r.json");
  const absent = extractRow({ instance_id: "a__1" }, "baseline", "raw/baseline/r.json");
  assert.equal(yes?.resolved, true);
  assert.equal(no?.resolved, false); // via the "solved" alias
  // A generated-but-unevaluated patch must never be coerced to a pass or a fail.
  assert.equal(absent?.resolved, "unknown");
});

test("evaluation evidence is normalized from a swebench report, unknown when absent", () => {
  const report = {
    "django__django-11728": {
      resolved: true,
      tests_status: {
        FAIL_TO_PASS: { success: ["test_x"], failure: [] },
        PASS_TO_PASS: { success: ["test_y", "test_z"], failure: [] },
      },
    },
  };
  const ok = normalizeEvaluationEvidence(report, "django__django-11728", "docker");
  assert.equal(ok.resolved, true);
  assert.equal(ok.failToPassPassed, true);
  assert.equal(ok.passToPassPassed, true);
  assert.match(ok.testStatus ?? "", /FAIL_TO_PASS=1 pass \/ 0 fail/);

  // A bucket with a failure does not "pass".
  const withFailure = normalizeEvaluationEvidence(
    { x: { resolved: false, tests_status: { FAIL_TO_PASS: { success: [], failure: ["test_x"] } } } },
    "x",
    "docker",
  );
  assert.equal(withFailure.resolved, false);
  assert.equal(withFailure.failToPassPassed, false);

  // No report / no tests_status -> everything unknown, nothing fabricated.
  const missing = normalizeEvaluationEvidence(null, "x", "unknown");
  assert.equal(missing.resolved, "unknown");
  assert.equal(missing.failToPassPassed, "unknown");
  assert.equal(missing.passToPassPassed, "unknown");
  assert.equal(missing.testStatus, null);
});

test("protocol command construction: baseline/vtrace keep --no-vexp, vexp omits it", () => {
  const config = baseConfig({ vexpSweBenchDir: "/x", out: "/out" });
  const baseline = buildBaselineCommand(config, ["a__1"]);
  const vtrace = buildVtraceCommand(config, ["a__1"]);
  const vexp = buildVexpCommand(config, ["a__1"]);
  assert.ok(baseline.args.includes("--no-vexp"));
  assert.ok(vtrace.args.includes("--no-vexp"));
  // The vexp condition is the ONLY one that enables vexp (no --no-vexp).
  assert.ok(!vexp.args.includes("--no-vexp"));
  assert.ok(vexp.args.some((arg) => arg.endsWith(path.join("raw", "vexp"))));
  assert.ok(vexp.args.includes("run"));
});

test("evaluate command targets the external evaluator with the chosen mode/dataset", () => {
  const config = baseConfig({ vexpSweBenchDir: "/x", evalMode: "docker", evalDataset: "swe.jsonl", evalTimeout: 600 });
  const { command, args } = buildEvaluateCommand(config, "/out/raw/baseline/swebench-2026-06-03.jsonl");
  assert.equal(command, "node");
  assert.equal(args[1], "evaluate");
  assert.ok(args.includes("--mode"));
  assert.ok(args.includes("docker"));
  assert.ok(args.includes("--dataset"));
  assert.ok(args.includes("swe.jsonl"));
  assert.ok(args.includes("--timeout"));
  assert.ok(args.includes("600"));

  // lightweight mode never forwards a dataset.
  const light = buildEvaluateCommand(baseConfig({ evalMode: "lightweight", evalDataset: "swe.jsonl" }), "/x.jsonl");
  assert.ok(!light.args.includes("--dataset"));
  assert.ok(light.args.includes("lightweight"));
});

test("vexp protocol is blocked without --allow-vexp and never spawns", async () => {
  assert.throws(() => assertVexpAllowed(baseConfig({ allowVexp: false })), /--allow-vexp/);
  assert.doesNotThrow(() => assertVexpAllowed(baseConfig({ allowVexp: true })));

  // runVexp must reject BEFORE spawning anything.
  let spawned = false;
  const runProcess = async () => {
    spawned = true;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const vexpDir = await fakeVexpCliDir();
  await assert.rejects(
    runVexp(baseConfig({ vexpSweBenchDir: vexpDir, instances: ["a__1"], allowVexp: false }), { runProcess }),
    /--allow-vexp/,
  );
  assert.equal(spawned, false);

  // The `all` protocol runs baseline + vtrace-indexed but SKIPS vexp (no spawn of a vexp run).
  await assert.rejects(
    runProtocol(baseConfig({ vexpSweBenchDir: vexpDir, instances: ["a__1"], protocol: "vexp", allowVexp: false }), { runProcess }),
    /--allow-vexp/,
  );
  assert.equal(spawned, false);
});

test("run-label isolates raw outputs and ingest reads only that label", async () => {
  const out = path.join(await tmpDir("run-label"), "results");
  // Same instance id, different token magnitudes, under two distinct labels.
  await seedCondition(out, "baseline", { runLabel: "labelA", instanceId: "a__1", inputTokens: 1000, outputTokens: 0, resolved: true });
  await seedCondition(out, "baseline", { runLabel: "labelB", instanceId: "a__1", inputTokens: 9, outputTokens: 0, resolved: false });

  // The two labels live in separate trees.
  assert.match(rawConditionDir(out, "baseline", "labelA"), /runs[\\/]labelA[\\/]raw[\\/]baseline/);
  assert.notEqual(rawConditionDir(out, "baseline", "labelA"), rawConditionDir(out, "baseline", "labelB"));

  const artifactA = await runIngest(baseConfig({ out, runLabel: "labelA" }));
  const baselineA = artifactA.rows.find((row) => row.condition === "baseline");
  assert.equal(baselineA?.totalTokens, 1000);
  assert.equal(baselineA?.resolved, true);
});

test("aggregate resolved-rate excludes unknown from the denominator", () => {
  const rows = [
    makeRow("a__1", "baseline", { resolved: true, totalTokens: 100, costUsd: 1 }),
    makeRow("b__2", "baseline", { resolved: false, totalTokens: 200, costUsd: 2 }),
    // Unknown: generated-but-unevaluated; counts as neither pass nor fail.
    makeRow("c__3", "baseline", { resolved: "unknown", totalTokens: 300, costUsd: 3 }),
  ];
  const [baseline] = buildConditionSummaries(rows);
  assert.equal(baseline?.condition, "baseline");
  assert.equal(baseline?.instances, 3);
  assert.equal(baseline?.resolvedCount, 1);
  assert.equal(baseline?.evaluatedCount, 2); // unknown excluded
  assert.equal(baseline?.resolvedRate, 0.5); // 1 of 2 evaluated, NOT 1 of 3
});

test("all-unknown condition has a null resolved-rate (no pass/fail invented)", () => {
  const rows = [
    makeRow("a__1", "vtrace", { resolved: "unknown", totalTokens: 100 }),
    makeRow("b__2", "vtrace", { resolved: "unknown", totalTokens: 200 }),
  ];
  const [vtrace] = buildConditionSummaries(rows);
  assert.equal(vtrace?.resolvedCount, 0);
  assert.equal(vtrace?.evaluatedCount, 0);
  assert.equal(vtrace?.resolvedRate, null);
});

test("invalid vtrace treatment is excluded from the vtrace performance summary", () => {
  const rows = [
    makeRow("a__1", "vtrace", { resolved: true, totalTokens: 100, vtraceTreatmentValid: true }),
    makeRow("b__2", "vtrace", { resolved: true, totalTokens: 200, vtraceTreatmentValid: false }),
  ];
  const [vtrace] = buildConditionSummaries(rows);
  assert.equal(vtrace?.validTreatments, 1);
  assert.equal(vtrace?.invalidTreatments, 1);

  // In the paired report, an invalid treatment renders "invalid" instead of a delta.
  const pairRows = [
    makeRow("b__2", "baseline", { resolved: true, totalTokens: 400 }),
    makeRow("b__2", "vtrace", { resolved: true, totalTokens: 200, vtraceTreatmentValid: false }),
  ];
  const md = renderMarkdown(
    { rows: pairRows, pairs: comparePairs(pairRows), summary: summaryOf(pairRows) as never, evidence: undefined as never, conditionSummaries: buildConditionSummaries(pairRows), evaluations: [] },
    baseConfig({}),
  );
  assert.match(md, /invalid/);
});

test("evaluateCondition reads resolved after the external evaluator rewrites the JSONL", async () => {
  const out = path.join(await tmpDir("eval-cond"), "results");
  const vexpDir = await fakeVexpCliDir();
  await seedCondition(out, "baseline", { resolved: null, instanceId: "a__1" });
  const resultsFile = path.join(out, "raw", "baseline", "swebench-2026-06-03.jsonl");

  // The mock evaluator simulates the real one: it mutates `resolved` in-place.
  const runProcess = async (command: string, args: readonly string[]): Promise<ProcessResult> => {
    if ([command, ...args].join(" ").includes("evaluate")) {
      await writeFile(resultsFile, JSON.stringify({ instanceId: "a__1", inputTokens: 100, outputTokens: 50, resolved: true }));
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const evidence = await evaluateCondition(baseConfig({ vexpSweBenchDir: vexpDir, out }), "baseline", resultsFile, { runProcess });
  assert.equal(evidence.evaluationRan, true);
  assert.equal(evidence.evaluationMethod, "docker");
  assert.equal(evidence.dockerUsed, true);
  assert.equal(evidence.instancesEvaluated, 1);
  assert.equal(evidence.resolvedCount, 1);
});

test("runEvaluate evaluates every seeded condition and ingest reports the evidence", async () => {
  const out = path.join(await tmpDir("eval-run"), "results");
  const vexpDir = await fakeVexpCliDir();
  await seedCondition(out, "baseline", { resolved: null, instanceId: "a__1" });
  await seedCondition(out, "vtrace", { resolved: null, instanceId: "a__1", vtraceMethod: "indexed-context" });

  const runProcess = async (command: string, args: readonly string[]): Promise<ProcessResult> => {
    const line = [command, ...args].join(" ");
    if (line.includes("evaluate")) {
      // The evaluated file path is the last positional before flags.
      const file = args[2]!;
      await writeFile(file, JSON.stringify({ instanceId: "a__1", inputTokens: 100, outputTokens: 50, resolved: true }));
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const evaluations = await runEvaluate(baseConfig({ vexpSweBenchDir: vexpDir, out }), { runProcess });
  assert.equal(evaluations.length, 2);
  assert.ok(evaluations.every((evidence) => evidence.evaluationRan));

  const artifact = await runIngest(baseConfig({ out }));
  assert.equal(artifact.evaluations.length, 2);
  const baselineRow = artifact.rows.find((row) => row.condition === "baseline");
  assert.equal(baselineRow?.resolved, true);
  assert.equal(baselineRow?.evaluationRan, true);
  assert.equal(baselineRow?.evaluationMethod, "docker");
});

test("a failing evaluator records evaluation_error and does not invent resolved", async () => {
  const out = path.join(await tmpDir("eval-fail"), "results");
  const vexpDir = await fakeVexpCliDir();
  await seedCondition(out, "baseline", { resolved: null, instanceId: "a__1" });
  const resultsFile = path.join(out, "raw", "baseline", "swebench-2026-06-03.jsonl");
  const runProcess = async (): Promise<ProcessResult> => ({ exitCode: 1, stdout: "", stderr: "docker not running" });
  const evidence = await evaluateCondition(baseConfig({ vexpSweBenchDir: vexpDir, out }), "baseline", resultsFile, { runProcess });
  assert.equal(evidence.evaluationRan, false);
  assert.equal(evidence.dockerUsed, false);
  assert.match(evidence.evaluationError ?? "", /docker not running/);
  assert.equal(evidence.resolvedCount, 0);
});

test("findCanonicalResultsFile finds the swebench JSONL and ignores runner artifacts", async () => {
  const out = path.join(await tmpDir("find-canon"), "results");
  await seedCondition(out, "baseline", { resolved: null });
  const found = await findCanonicalResultsFile(path.join(out, "raw", "baseline"));
  assert.match(found ?? "", /swebench-2026-06-03\.jsonl$/);
  const none = await findCanonicalResultsFile(path.join(out, "raw", "vexp"));
  assert.equal(none, null);
});

test("run-protocol baseline runs only the baseline condition", async () => {
  const out = path.join(await tmpDir("proto-baseline"), "results");
  const vexpDir = await fakeVexpCliDir();
  const calls: string[] = [];
  const runProcess = async (command: string, args: readonly string[]): Promise<ProcessResult> => {
    calls.push([command, ...args].join(" "));
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  await runProtocol(baseConfig({ vexpSweBenchDir: vexpDir, out, instances: ["a__1"], protocol: "baseline" }), { runProcess });
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.includes("--no-vexp"));
  assert.ok(calls[0]!.includes(path.join("raw", "baseline")));
});

test("aggregate-runs combines distinct instances from multiple run-labels", async () => {
  const out = path.join(await tmpDir("aggregate"), "results");
  // Two labels, each a distinct instance with a baseline + vtrace pair.
  await seedCondition(out, "baseline", { runLabel: "lab-1", instanceId: "a__1", inputTokens: 1000, outputTokens: 0, resolved: true });
  await seedCondition(out, "vtrace", { runLabel: "lab-1", instanceId: "a__1", inputTokens: 700, outputTokens: 0, resolved: true });
  await seedCondition(out, "baseline", { runLabel: "lab-2", instanceId: "b__2", inputTokens: 500, outputTokens: 0, resolved: true });
  await seedCondition(out, "vtrace", { runLabel: "lab-2", instanceId: "b__2", inputTokens: 400, outputTokens: 0, resolved: true });

  const artifact = await runAggregateRuns(baseConfig({ out, runLabels: ["lab-1", "lab-2"] }));

  // Both instances are present and paired; nothing is dropped or double-counted.
  assert.equal(artifact.summary.instanceCount, 2);
  assert.equal(artifact.summary.bothResolved, 2);
  assert.equal(artifact.pairs.length, 2);
  const baseline = artifact.conditionSummaries.find((s) => s.condition === "baseline");
  assert.equal(baseline?.instances, 2);

  // The combined report is written under results/aggregate/, not the --out root.
  const md = await readFile(path.join(out, "aggregate", "stage5_vexp_swe_bench_smoke.md"), "utf8");
  assert.match(md, /a__1/);
  assert.match(md, /b__2/);
  // The single-run flat outputs at the root are left untouched.
  assert.equal(await stat(path.join(out, "stage5_vexp_swe_bench_smoke.md")).then(() => true).catch(() => false), false);
});

test("aggregate-runs refuses to combine a duplicate instance across labels", async () => {
  const out = path.join(await tmpDir("aggregate-dup"), "results");
  await seedCondition(out, "baseline", { runLabel: "lab-1", instanceId: "dup__1", inputTokens: 1000, outputTokens: 0, resolved: true });
  await seedCondition(out, "baseline", { runLabel: "lab-2", instanceId: "dup__1", inputTokens: 500, outputTokens: 0, resolved: true });

  await assert.rejects(
    runAggregateRuns(baseConfig({ out, runLabels: ["lab-1", "lab-2"] })),
    /Duplicate instance dup__1/,
  );
});

test("aggregate-runs requires at least one run-label", async () => {
  const out = path.join(await tmpDir("aggregate-empty"), "results");
  await assert.rejects(runAggregateRuns(baseConfig({ out, runLabels: null })), /requires --run-labels/);
  await assert.rejects(runAggregateRuns(baseConfig({ out, runLabels: [] })), /requires --run-labels/);
});

test("parseArgs understands --mode aggregate-runs and --run-labels", () => {
  const config = parseArgs(["--mode", "aggregate-runs", "--run-labels", "lab-1, lab-2 ,lab-3"]);
  assert.equal(config.mode, "aggregate-runs");
  assert.deepEqual(config.runLabels, ["lab-1", "lab-2", "lab-3"]);
});

test("combineRunEvidence reports a fact only when all runs agree", () => {
  const valid: Stage5RunEvidence = {
    vtraceMethod: "indexed-context",
    vtracePatchInstalled: true,
    vtraceInstructionsFile: "/tmp/lab-1/_vtrace_instructions.md",
    vtraceInstructionsFileExists: true,
    vtraceInstructionsFileSize: 100,
    vtraceInjectionObserved: true,
    vtraceInjectionError: null,
    vtraceTreatmentValid: true,
    vtraceIndexedContext: true,
    vtraceIndexCommand: "vtrace index .",
    vtraceQueryCommand: "vtrace capsule . q",
    vtraceWorkspacePath: "/tmp/lab-1/ws",
    vtraceContextFile: "/tmp/lab-1/ctx.md",
    vtraceContextChars: 6000,
    vtraceContextItems: 8,
    vtraceContextTruncated: true,
    vtraceContextError: null,
    notes: ["lab-1 note"],
  };

  // All-agree: the unanimous facts survive; per-run paths/counts are nulled.
  const unanimous = combineRunEvidence([valid, { ...valid, vtraceInstructionsFile: "/tmp/lab-2/x.md", notes: ["lab-2 note"] }]);
  assert.equal(unanimous.vtraceMethod, "indexed-context");
  assert.equal(unanimous.vtraceTreatmentValid, true);
  assert.equal(unanimous.vtraceIndexedContext, true);
  assert.equal(unanimous.vtraceInstructionsFile, null);
  assert.equal(unanimous.vtraceContextChars, null);
  assert.deepEqual(unanimous.notes, ["lab-1 note", "lab-2 note"]);

  // Disagreement collapses to "mixed"/"unknown" rather than picking one run's value.
  const mixed = combineRunEvidence([valid, { ...valid, vtraceMethod: "local-patch", vtraceTreatmentValid: false }]);
  assert.equal(mixed.vtraceMethod, "mixed");
  assert.equal(mixed.vtraceTreatmentValid, "unknown");
});

// ----- Stage 5: valid no-context (skip) policy -----

// A capsule --json skip payload: empty context + skip diagnostics, as emitted by
// `capsule --mode micro` when no high-confidence pivot is recovered.
function skipCapsuleJson(reason = "no high-confidence actionable target recovered"): string {
  return JSON.stringify({
    diagnostics: {
      mode: "micro",
      recommended_mode: "skip",
      actual_mode: "skip",
      pivot_count: 0,
      support_count: 0,
      context_items: 0,
      retrieval_reason: reason,
    },
    context: "",
  });
}

test("classifyCapsuleOutput treats a no-context skip payload as a valid skip, not fatal", () => {
  const skip = classifyCapsuleOutput(skipCapsuleJson("nothing actionable here"));
  assert.equal(skip.policyAction, "skip");
  assert.equal(skip.contextInjected, false);
  assert.equal(skip.skipReason, "nothing actionable here");
  assert.equal(skip.actualCapsuleMode, "skip");
  assert.equal(skip.pivotCount, 0);
  assert.equal(skip.error, null);

  // pivot_count 0 + a reason alone also classifies as skip (no explicit mode).
  const byPivot = classifyCapsuleOutput(
    JSON.stringify({ diagnostics: { pivot_count: 0, retrieval_reason: "none" }, context: "" }),
  );
  assert.equal(byPivot.policyAction, "skip");

  // Real context injects regardless of mode labels.
  const inject = classifyCapsuleOutput(
    JSON.stringify({ diagnostics: { recommended_mode: "micro", pivot_count: 1 }, context: "# vtrace context\nfoo" }),
  );
  assert.equal(inject.policyAction, "inject");
  assert.equal(inject.contextInjected, true);
  assert.equal(inject.context, "# vtrace context\nfoo");

  // Empty context with NO skip signal is a genuine error (fails fast downstream).
  const err = classifyCapsuleOutput(JSON.stringify({ diagnostics: { mode: "micro" }, context: "" }));
  assert.equal(err.policyAction, "error");
  assert.match(err.error ?? "", /empty context/);
});

test("classifyCapsuleOutput treats a skip directive body as skip, not injected context", () => {
  // The capsule CLI now emits a human-facing "do not inject" directive as context
  // on a skip. The `skip` mode must remain authoritative so the directive is not
  // mistaken for an injected treatment.
  const skip = classifyCapsuleOutput(
    JSON.stringify({
      diagnostics: { recommended_mode: "skip", actual_mode: "skip", pivot_count: 0, search_budget: "high" },
      context: "# vtrace context\n\n## Recommended first action\n\nNo high-confidence edit target recovered. Do not inject context for this task.",
    }),
  );
  assert.equal(skip.policyAction, "skip");
  assert.equal(skip.contextInjected, false);
  assert.equal(skip.context, "");
  assert.equal(skip.searchBudget, "high");
});

test("classifyCapsuleOutput captures the search budget from the diagnostics", () => {
  const inject = classifyCapsuleOutput(
    JSON.stringify({
      diagnostics: { recommended_mode: "micro", pivot_count: 1, search_budget: "low", search_budget_reason: "direct evidence" },
      context: "# vtrace context\nfoo",
    }),
  );
  assert.equal(inject.policyAction, "inject");
  assert.equal(inject.searchBudget, "low");
  assert.equal(inject.searchBudgetReason, "direct evidence");
});

// ----- Stage 5: agent-compliance diagnostics (Requirement 6) -----

test("buildAgentCompliance records unknown when the record has no ordered tool calls", () => {
  // SWE-bench records usually carry only aggregate counts — never guess from those.
  const fields = buildAgentCompliance({ tool_calls: { Read: 3, Edit: 1, Grep: 5 } }, "django/db/models/aggregates.py");
  assert.equal(fields.pivotFile, "django/db/models/aggregates.py");
  assert.equal(fields.firstReadFile, "unknown");
  assert.equal(fields.didReadPivotBeforeSearch, "unknown");
  assert.equal(fields.didEditPivot, "unknown");
  assert.equal(fields.searchCallsBeforePivot, "unknown");
});

test("buildAgentCompliance derives the compliance signals from an ordered tool-call list", () => {
  const record = {
    tool_calls: [
      { name: "Read", input: { file_path: "django/db/models/aggregates.py" } },
      { name: "Grep", input: { pattern: "distinct" } },
      { name: "Edit", input: { file_path: "django/db/models/aggregates.py" } },
    ],
  };
  const fields = buildAgentCompliance(record, "django/db/models/aggregates.py");
  assert.equal(fields.firstReadFile, "django/db/models/aggregates.py");
  assert.equal(fields.firstEditFile, "django/db/models/aggregates.py");
  // The pivot was read FIRST, before any search — the directive was followed.
  assert.equal(fields.didReadPivotBeforeSearch, true);
  assert.equal(fields.didEditPivot, true);
  assert.equal(fields.searchCallsBeforePivot, 0);
});

test("buildAgentCompliance counts searches that preceded the pivot when the directive was ignored", () => {
  const record = {
    toolCalls: [
      { tool: "grep", args: { pattern: "Count" } },
      { tool: "glob", args: { pattern: "**/*.py" } },
      { tool: "read", args: { file_path: "django/db/models/aggregates.py" } },
    ],
  };
  const fields = buildAgentCompliance(record, "django/db/models/aggregates.py");
  assert.equal(fields.didReadPivotBeforeSearch, false);
  assert.equal(fields.searchCallsBeforePivot, 2);
  assert.equal(fields.didEditPivot, false);
});

test("prepareIndexedContext records a capsule skip as a valid policy (not an error)", async () => {
  const out = path.join(await tmpDir("idx-skip"), "results");
  const dataDir = await tmpDir("idx-skip-data");
  const dataFile = await writeSweBenchData(dataDir, [SAMPLE_RECORD]);
  const { run } = scriptedRunner([{ match: "capsule", result: { stdout: skipCapsuleJson() } }]);
  const config = baseConfig({
    out,
    instances: ["django__django-11728"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
  });
  const result = await prepareIndexedContext(config, { runProcess: run });

  assert.equal(result.policyAction, "skip");
  assert.equal(result.indexedContext, false);
  assert.equal(result.contextInjected, false);
  assert.equal(result.actualCapsuleMode, "skip");
  assert.equal(result.pivotCount, 0);
  assert.match(result.skipReason ?? "", /no high-confidence actionable target/);
  // A skip is not a hard error.
  assert.equal(result.contextError, null);
});

test("run-vtrace skip policy spawns the benchmark WITHOUT VTRACE_AGENT_INSTRUCTIONS_FILE", async () => {
  const vexpDir = await fakeVexpDir();
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");
  const out = path.join(await tmpDir("idx-skip-run"), "results");
  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  const dataDir = await tmpDir("idx-skip-run-data");
  const dataFile = await writeSweBenchData(dataDir, [SAMPLE_RECORD]);

  let vexpSpawned = false;
  let vexpEnv: Record<string, string> | undefined;
  let vexpArgs: readonly string[] = [];
  const run = async (
    command: string,
    args: readonly string[],
    options?: { env?: Record<string, string> },
  ): Promise<ProcessResult> => {
    const line = [command, ...args].join(" ");
    if (line.includes("dist/cli.js")) {
      vexpSpawned = true;
      vexpEnv = options?.env;
      vexpArgs = args;
    }
    if (line.includes("capsule")) return { exitCode: 0, stdout: skipCapsuleJson(), stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const config = baseConfig({
    vexpSweBenchDir: vexpDir,
    out,
    instances: ["django__django-11728"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
  });
  // Skip must NOT abort before spawn — it runs the policy condition.
  await runVtrace(config, { runProcess: run });
  assert.equal(vexpSpawned, true, "skip policy still runs the external benchmark");
  assert.ok(vexpArgs.includes("--no-vexp"));
  // No injected context: the instructions-file env is omitted entirely.
  assert.ok(vexpEnv !== undefined);
  assert.equal(vexpEnv?.VTRACE_AGENT_INSTRUCTIONS_FILE, undefined);
  assert.equal(vexpEnv?.VTRACE_METHOD, "indexed-context");

  // The recorded meta marks the run as a valid skip policy.
  const meta = JSON.parse(
    await readFile(path.join(rawConditionDir(out, "vtrace"), "_run.meta.json"), "utf8"),
  );
  assert.equal(meta.vtracePolicyAction, "skip");
  assert.equal(meta.vtraceContextInjected, false);
});

test("non-skip empty context (no skip diagnostics) still fails fast before spawn", async () => {
  const vexpDir = await fakeVexpDir();
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");
  const out = path.join(await tmpDir("idx-empty-err"), "results");
  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  const dataDir = await tmpDir("idx-empty-err-data");
  const dataFile = await writeSweBenchData(dataDir, [SAMPLE_RECORD]);

  let vexpSpawned = false;
  const run = async (command: string, args: readonly string[]): Promise<ProcessResult> => {
    const line = [command, ...args].join(" ");
    if (line.includes("dist/cli.js")) vexpSpawned = true;
    // Empty context with NO skip diagnostics = a real failure, not a skip.
    if (line.includes("capsule")) {
      return { exitCode: 0, stdout: JSON.stringify({ diagnostics: { mode: "micro" }, context: "" }), stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const config = baseConfig({
    vexpSweBenchDir: vexpDir,
    out,
    instances: ["django__django-11728"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
  });
  await assert.rejects(() => runVtrace(config, { runProcess: run }), /produced no vtrace context/);
  assert.equal(vexpSpawned, false);
});

test("a skip-policy vtrace row is a valid treatment without an observed injection", async () => {
  const out = path.join(await tmpDir("skip-valid"), "results");
  await seedCondition(out, "baseline", { resolved: null });
  await seedCondition(out, "vtrace", {
    resolved: null,
    vtraceMethod: "indexed-context",
    // No injection log in stderr — a skip run injects nothing on purpose.
    stderr: "Stage5 vtrace policy: skip (no context injected)\n",
    indexedContext: false,
    metaExtra: {
      vtracePolicyAction: "skip",
      vtraceContextInjected: false,
      vtraceSkipReason: "no high-confidence actionable target recovered",
      vtracePivotCount: 0,
      vtraceSupportCount: 0,
    },
  });
  const artifact = await runIngest(baseConfig({ out }));
  assert.equal(artifact.evidence.vtracePolicyAction, "skip");
  assert.equal(artifact.evidence.vtraceTreatmentValid, true);
  assert.equal(artifact.evidence.vtraceContextInjected, false);

  const vtraceRow = artifact.rows.find((row) => row.condition === "vtrace");
  assert.ok(vtraceRow);
  assert.equal(vtraceRow?.vtracePolicyAction, "skip");
  assert.equal(vtraceRow?.vtraceTreatmentValid, true);
  assert.equal(vtraceRow?.actualCapsuleMode, "skip");
});

test("skip aggregates and rows appear in the summary, CSV, JSON, and Markdown", async () => {
  const out = path.join(await tmpDir("skip-report"), "results");
  await seedCondition(out, "baseline", { resolved: null });
  await seedCondition(out, "vtrace", {
    resolved: null,
    vtraceMethod: "indexed-context",
    stderr: "Stage5 vtrace policy: skip\n",
    indexedContext: false,
    metaExtra: {
      vtracePolicyAction: "skip",
      vtraceContextInjected: false,
      vtraceSkipReason: "no high-confidence actionable target recovered",
      vtracePivotCount: 0,
      vtraceSupportCount: 0,
    },
  });
  const artifact = await runIngest(baseConfig({ out }));

  // Aggregate skip_count is correct.
  assert.equal(artifact.summary.skipCount, 1);
  assert.equal(artifact.summary.contextInjectedCount, 0);
  assert.equal(artifact.summary.invalidTreatmentCount, 0);

  // CSV carries the new policy columns and a skip row.
  const csv = await readFile(path.join(out, "stage5_vexp_swe_bench_smoke.csv"), "utf8");
  const header = csv.split("\n")[0]!;
  for (const col of ["vtrace_policy_action", "vtrace_context_injected", "vtrace_skip_reason", "pivot_count", "support_count"]) {
    assert.ok(header.includes(col), `CSV header missing ${col}`);
  }
  assert.match(csv, /,skip,/);

  // JSON normalized artifact carries the policy fields on the vtrace row.
  const json = JSON.parse(await readFile(path.join(out, "stage5_vexp_swe_bench_smoke.json"), "utf8"));
  const jsonVtrace = json.rows.find((row: { condition: string }) => row.condition === "vtrace");
  assert.equal(jsonVtrace.vtracePolicyAction, "skip");
  assert.equal(json.summary.skipCount, 1);

  // Markdown explains the valid no-context policy in the documented wording.
  const md = await readFile(path.join(out, "stage5_vexp_swe_bench_smoke.md"), "utf8");
  assert.match(md, /\| vtrace_policy_action \| skip \|/);
  assert.match(md, /Vtrace skip policy \| 1/);
  assert.match(
    md,
    /VTRACE selected no-context policy for this task\. This is a valid policy decision, not an indexed-context treatment\./,
  );
});

// ----- Stage 5: cost-aware context-injection gate (decideContextPolicy) -----

// Records used by the gate classification tests. The signals are derived the
// same way the production path derives them (shapeSweQuery + recommendMode).
const POLICY_RECORDS = {
  "django__django-10880": {
    repo: "django/django", instance_id: "django__django-10880", base_commit: "abc",
    problem_statement: "Add an encoder parameter to django.utils.html.json_script(). It hardcodes DjangoJSONEncoder.",
    hints_text: null,
    FAIL_TO_PASS: '["tests.utils_tests.test_html.TestUtilsHtml.test_json_script_custom_encoder"]',
  },
  "django__django-11095": {
    repo: "django/django", instance_id: "django__django-11095", base_commit: "abc",
    problem_statement:
      "Add ModelAdmin.get_inlines() hook to allow setting inlines based on the request or model instance. "
      + "Currently you must override get_inline_instances.",
    hints_text: null,
    FAIL_TO_PASS: '["tests.admin_inlines.tests.TestInline.test_get_inlines_hook"]',
  },
  "django__django-11490": NAV_RECORD,
  "django__django-11728": {
    repo: "django/django", instance_id: "django__django-11728", base_commit: "abc",
    problem_statement:
      "replace_named_groups fails to parse trailing regex groups in the admindocs URL pattern parser. "
      + "The regex parsing loop in django/contrib/admindocs/utils.py stops early.",
    hints_text: "look at the admindocs utils regex parser",
    FAIL_TO_PASS: '["tests.admin_docs.test_utils.TestUtils.test_replace_named_groups"]',
  },
  "django__django-11740": {
    repo: "django/django", instance_id: "django__django-11740", base_commit: "abc",
    problem_statement:
      "Change uuid field to FK does not create dependency. The migrations autodetector in "
      + "django/db/migrations/autodetector.py builds AlterField without a dependency.",
    hints_text: "generate_altered_fields() should add dependencies for new FK targets.",
    FAIL_TO_PASS: '["tests.migrations.test_autodetector.AutodetectorTests.test_alter_field_to_fk_dependency"]',
  },
} as const;

function policySignals(id: keyof typeof POLICY_RECORDS) {
  return deriveContextPolicySignals(toSweBenchInstance(POLICY_RECORDS[id]));
}

// A capsule that retrieved a focused micro pivot (still a cheap/local task).
const MICRO_DIAG: CapsulePolicyDiagnostics = {
  capsuleAction: "inject", hasContext: true, pivotCount: 1, supportCount: 0, actualMode: "micro",
};
// A capsule with strong, multi-pivot evidence (navigation-heavy task).
const STRONG_DIAG: CapsulePolicyDiagnostics = {
  capsuleAction: "inject", hasContext: true, pivotCount: 3, supportCount: 4, actualMode: "full",
};

test("decideContextPolicy chooses no_context for cheap/local tasks (10880, 11095)", () => {
  // 10880: one failing test, short problem, micro capsule — a small/local edit
  // where even a focused micro pivot is net overhead.
  const d10880 = decideContextPolicy(policySignals("django__django-10880"), MICRO_DIAG);
  assert.equal(d10880.action, "no_context");
  assert.equal(d10880.expectedContextValue, "low");
  assert.equal(d10880.expectedOverheadRisk, "high");
  assert.match(d10880.reason, /Cheap\/local/);

  // 11095: another small/local hook addition — no_context (the "one-line target
  // only" alternative collapses to no_context here).
  assert.equal(decideContextPolicy(policySignals("django__django-11095"), MICRO_DIAG).action, "no_context");
});

test("decideContextPolicy chooses inject for navigation-heavy tasks with strong pivots (11490, 11728)", () => {
  const d11490 = decideContextPolicy(policySignals("django__django-11490"), STRONG_DIAG);
  assert.equal(d11490.action, "inject");
  assert.equal(d11490.expectedContextValue, "high");
  assert.equal(d11490.expectedOverheadRisk, "low");

  assert.equal(decideContextPolicy(policySignals("django__django-11728"), STRONG_DIAG).action, "inject");
});

test("decideContextPolicy is conservative on 11740: inject only with strong pivot evidence", () => {
  const signals = policySignals("django__django-11740");
  // Weak pivot evidence on a navigation-heavy task → stay no_context.
  const weak = decideContextPolicy(signals, { capsuleAction: "inject", hasContext: true, pivotCount: 0, supportCount: 0, actualMode: "full" });
  assert.equal(weak.action, "no_context");
  assert.equal(weak.expectedOverheadRisk, "medium");
  // Strong pivot evidence → inject.
  assert.equal(decideContextPolicy(signals, STRONG_DIAG).action, "inject");
});

test("decideContextPolicy chooses no_context when the capsule recovered nothing", () => {
  const d = decideContextPolicy(policySignals("django__django-11490"), {
    capsuleAction: "skip", hasContext: false, pivotCount: 0, supportCount: 0, actualMode: "skip",
  });
  assert.equal(d.action, "no_context");
  assert.match(d.reason, /no high-confidence target/);
});

test("decideContextPolicy decisions carry named decision signals", () => {
  // The legacy gate now also records its signals (audit parity with v2), without
  // changing any action/value/risk — legacy behaviour is otherwise unchanged.
  const cheap = decideContextPolicy(policySignals("django__django-10880"), MICRO_DIAG);
  assert.equal(cheap.action, "no_context");
  assert.deepEqual(cheap.decisionSignals, ["cheap_local", "micro_capsule"]);
  const nav = decideContextPolicy(policySignals("django__django-11490"), STRONG_DIAG);
  assert.equal(nav.action, "inject");
  assert.ok(nav.decisionSignals.includes("strong_pivot"));
});

// ----- Stage 5: Capsule v2 cost-aware context policy (decideCapsuleV2ContextPolicy) -----

// Capsule v2 evidence shapes drawn from the five-task force-inject validation.
// 11490: edit-risk directive + line-anchor + SQL-rendering backfill, big focused body.
const RISK_DIAG_V2: CapsuleV2PolicyDiagnostics = {
  capsuleAction: "inject", hasContext: true, actualMode: "standard", pivotCount: 2, supportCount: 4,
  topPivotHasSource: true, topPivotSourceChars: 2849, editRiskDirectiveCount: 1,
  lineAnchorResolutionUsed: true, sqlRenderingBackfillUsed: true,
};
// 11728 / 11740: internal-subsystem navigation with a real focused pivot body and
// no special recovery routes — the inject case that rests purely on task shape + source.
const INTERNAL_NAV_DIAG_V2: CapsuleV2PolicyDiagnostics = {
  capsuleAction: "inject", hasContext: true, actualMode: "standard", pivotCount: 2, supportCount: 4,
  topPivotHasSource: true, topPivotSourceChars: 1563, editRiskDirectiveCount: 0,
  lineAnchorResolutionUsed: false, sqlRenderingBackfillUsed: false,
};
// 10880 / 11095: a small/local task — micro capsule, focused body present but no
// edit-risk / anchor / SQL evidence. The cheap/local no_context case.
const LOCAL_DIAG_V2: CapsuleV2PolicyDiagnostics = {
  capsuleAction: "inject", hasContext: true, actualMode: "standard", pivotCount: 2, supportCount: 4,
  topPivotHasSource: true, topPivotSourceChars: 1160, editRiskDirectiveCount: 0,
  lineAnchorResolutionUsed: false, sqlRenderingBackfillUsed: false,
};

test("decideCapsuleV2ContextPolicy injects an 11490-like edit-risk + line-anchor + SQL task", () => {
  const d = decideCapsuleV2ContextPolicy(policySignals("django__django-11490"), RISK_DIAG_V2);
  assert.equal(d.action, "inject");
  assert.equal(d.expectedContextValue, "high");
  assert.equal(d.expectedOverheadRisk, "low");
  // The decision is backed by the capsule's own edit-risk / anchor / SQL evidence.
  assert.ok(d.decisionSignals.includes("edit_risk_directive_present"));
  assert.ok(d.decisionSignals.includes("line_anchor_resolution_used"));
  assert.ok(d.decisionSignals.includes("sql_rendering_backfill_used"));
  assert.match(d.reason, /edit-risk directive/);
});

test("decideCapsuleV2ContextPolicy injects an 11728-like regex-helper internal-subsystem bug", () => {
  const d = decideCapsuleV2ContextPolicy(policySignals("django__django-11728"), INTERNAL_NAV_DIAG_V2);
  assert.equal(d.action, "inject");
  assert.equal(d.expectedContextValue, "high");
  // Inject rests on internal-subsystem navigation with a real focused pivot body,
  // not on any edit-risk / anchor / SQL signal (those did not fire here).
  assert.ok(d.decisionSignals.includes("internal_subsystem_navigation"));
  assert.ok(d.decisionSignals.includes("top_pivot_has_source"));
  assert.ok(!d.decisionSignals.includes("edit_risk_directive_present"));
});

test("decideCapsuleV2ContextPolicy injects an 11740-like migrations/autodetector bug", () => {
  // Long problem statement + migrations/autodetector internals + focused body.
  const diag: CapsuleV2PolicyDiagnostics = { ...INTERNAL_NAV_DIAG_V2, topPivotSourceChars: 879 };
  const d = decideCapsuleV2ContextPolicy(policySignals("django__django-11740"), diag);
  assert.equal(d.action, "inject");
  assert.equal(d.expectedContextValue, "high");
  assert.ok(d.decisionSignals.includes("internal_subsystem_navigation"));
});

test("decideCapsuleV2ContextPolicy chooses no_context for an 11095-like small/local API hook", () => {
  const d = decideCapsuleV2ContextPolicy(policySignals("django__django-11095"), LOCAL_DIAG_V2);
  assert.equal(d.action, "no_context");
  assert.equal(d.expectedContextValue, "low");
  assert.equal(d.expectedOverheadRisk, "high");
  // Pinned rationale: a narrow target with no edit-risk / anchor / SQL evidence.
  assert.ok(d.decisionSignals.includes("micro_capsule"));
  assert.ok(d.decisionSignals.includes("not_internal_subsystem"));
  assert.ok(d.decisionSignals.includes("no_edit_risk_directive"));
  assert.match(d.reason, /net overhead/);
});

test("decideCapsuleV2ContextPolicy chooses no_context for a 10880-like small aggregation bug", () => {
  // 10880 may go either way per the spec; the policy chooses no_context, and the
  // rationale is PINNED here: micro/local with no edit-risk / anchor / SQL evidence,
  // a 410-char body below the meaningful-source bar, and overhead caution that
  // outweighs the marginal (+10.85% token) force-inject benefit.
  const diag: CapsuleV2PolicyDiagnostics = { ...LOCAL_DIAG_V2, topPivotSourceChars: 410 };
  const d = decideCapsuleV2ContextPolicy(policySignals("django__django-10880"), diag);
  assert.equal(d.action, "no_context");
  assert.equal(d.expectedOverheadRisk, "high");
  assert.ok(d.decisionSignals.includes("micro_capsule"));
  // Below the meaningful-source bar, so the source body is not an inject driver.
  assert.ok(!d.decisionSignals.includes("meaningful_pivot_source"));
  assert.match(d.reason, /overhead/);
});

test("decideCapsuleV2ContextPolicy chooses no_context when the capsule recovered nothing", () => {
  const d = decideCapsuleV2ContextPolicy(policySignals("django__django-11490"), {
    capsuleAction: "skip", hasContext: false, actualMode: "no_context", pivotCount: 0, supportCount: 0,
    topPivotHasSource: false, topPivotSourceChars: null, editRiskDirectiveCount: 0,
    lineAnchorResolutionUsed: false, sqlRenderingBackfillUsed: false,
  });
  assert.equal(d.action, "no_context");
  assert.deepEqual(d.decisionSignals, ["capsule_no_context"]);
});

test("force-inject / force-no-context still override the Capsule v2 auto decision", () => {
  // auto → no_context on a small/local task...
  const auto = decideCapsuleV2ContextPolicy(policySignals("django__django-11095"), LOCAL_DIAG_V2);
  assert.equal(auto.action, "no_context");
  // ...but force-inject flips it (preserving the gate's expected value/risk + signals)...
  const forcedInject = applyContextPolicyOverride(auto, "force-inject", true);
  assert.equal(forcedInject.action, "inject");
  assert.match(forcedInject.reason, /forced to inject for validation/);
  assert.deepEqual(forcedInject.decisionSignals, auto.decisionSignals);
  // ...and force-no-context overrides an inject decision the other way.
  const inject = decideCapsuleV2ContextPolicy(policySignals("django__django-11490"), RISK_DIAG_V2);
  assert.equal(inject.action, "inject");
  const forcedNo = applyContextPolicyOverride(inject, "force-no-context", true);
  assert.equal(forcedNo.action, "no_context");
  assert.match(forcedNo.reason, /forced to no_context for validation/);
});

test("classifyCapsuleV2Output captures the policy-evidence diagnostics", () => {
  // edit-risk + line-anchor + SQL backfill present → all captured.
  const rich = classifyCapsuleV2Output(
    JSON.parse(capsuleV2Json({ editRiskDirectives: 1, lineAnchorResolutionUsed: true, sqlRenderingBackfillUsed: true })),
  );
  assert.equal(rich.capsuleEditRiskDirectivesCount, 1);
  assert.equal(rich.capsuleLineAnchorResolutionUsed, true);
  assert.equal(rich.capsuleSqlRenderingBackfillUsed, true);
  // Absent in the diagnostics → 0/false, never undefined.
  const plain = classifyCapsuleV2Output(JSON.parse(capsuleV2Json()));
  assert.equal(plain.capsuleEditRiskDirectivesCount, 0);
  assert.equal(plain.capsuleLineAnchorResolutionUsed, false);
  assert.equal(plain.capsuleSqlRenderingBackfillUsed, false);
});

test("prepareIndexedContext (auto + v2) injects a navigation-heavy edit-risk task", async () => {
  const out = path.join(await tmpDir("v2-auto-inject"), "results");
  const dataDir = await tmpDir("v2-auto-inject-data");
  const dataFile = await writeSweBenchData(dataDir, [NAV_RECORD]);
  // A v2 capsule with a focused body + an edit-risk directive — high-value context.
  const { run } = scriptedRunner([
    {
      match: "capsule",
      result: {
        stdout: capsuleV2Json({
          pivotSymbol: "get_combinator_sql", pivotSource: PIVOT_BODY,
          editRiskDirectives: 1, lineAnchorResolutionUsed: true, sqlRenderingBackfillUsed: true,
        }),
      },
    },
  ]);
  const config = baseConfig({
    out, instances: ["django__django-11490"], sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context", capsuleEngine: "v2", capsuleIntent: "debug", capsuleBudget: 8000,
    contextPolicyOverride: "auto",
  });
  const result = await prepareIndexedContext(config, { runProcess: run });

  // The v2 cost-aware gate (NOT force-inject) decided to inject on its own evidence.
  assert.equal(result.contextPolicyAction, "inject");
  assert.equal(result.contextInjected, true);
  assert.equal(result.expectedContextValue, "high");
  assert.equal(result.expectedOverheadRisk, "low");
  assert.equal(result.capsuleEditRiskDirectivesCount, 1);
  assert.equal(result.capsuleLineAnchorResolutionUsed, true);
  assert.equal(result.capsuleSqlRenderingBackfillUsed, true);
  assert.ok((result.contextPolicyDecisionSignals ?? []).includes("edit_risk_directive_present"));
});

test("prepareIndexedContext (auto + v2) declines a small/local hook task to no_context", async () => {
  const out = path.join(await tmpDir("v2-auto-nc"), "results");
  const dataDir = await tmpDir("v2-auto-nc-data");
  // An 11095-like small/local additive hook: micro capsule, not an internal subsystem.
  const dataFile = await writeSweBenchData(dataDir, [POLICY_RECORDS["django__django-11095"]]);
  // The capsule retrieved a real v2 pivot, but with no edit-risk / anchor / SQL signal.
  const { run } = scriptedRunner([
    { match: "capsule", result: { stdout: capsuleV2Json({ pivotPath: "django/contrib/admin/options.py", pivotSymbol: "get_inline_formsets", pivotSource: PIVOT_BODY }) } },
  ]);
  const config = baseConfig({
    out, instances: ["django__django-11095"], sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context", capsuleEngine: "v2", capsuleIntent: "debug", capsuleBudget: 8000,
    contextPolicyOverride: "auto",
  });
  const result = await prepareIndexedContext(config, { runProcess: run });

  // The v2 gate declined: a valid no-context policy, recorded via the skip machinery.
  assert.equal(result.contextPolicyAction, "no_context");
  assert.equal(result.policyAction, "skip");
  assert.equal(result.contextInjected, false);
  assert.equal(result.indexedContext, false);
  assert.equal(result.expectedOverheadRisk, "high");
  assert.match(result.policyReason ?? "", /net overhead/);
  assert.equal(result.contextError, null);
});

test("prepareIndexedContext gates a cheap/local task to no_context even with real micro context", async () => {
  const out = path.join(await tmpDir("gate-nc"), "results");
  const dataDir = await tmpDir("gate-nc-data");
  const dataFile = await writeSweBenchData(dataDir, [POLICY_RECORDS["django__django-10880"]]);
  // The capsule DID retrieve real micro context, but the cost-aware gate declines.
  const { run } = scriptedRunner([
    { match: "capsule", result: { stdout: microCapsuleJson("symbol: json_script\nfile: django/utils/html.py") } },
  ]);
  const config = baseConfig({
    out,
    instances: ["django__django-10880"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
  });
  const result = await prepareIndexedContext(config, { runProcess: run });

  // Valid no-context policy, recorded via the legacy skip mechanism plus the gate
  // vocabulary + rationale.
  assert.equal(result.policyAction, "skip");
  assert.equal(result.contextPolicyAction, "no_context");
  assert.equal(result.contextInjected, false);
  assert.equal(result.indexedContext, false);
  assert.equal(result.expectedContextValue, "low");
  assert.equal(result.expectedOverheadRisk, "high");
  assert.match(result.policyReason ?? "", /Cheap\/local/);
  // A no-context decision is NOT a hard error.
  assert.equal(result.contextError, null);
});

test("run-vtrace no_context gate runs WITHOUT VTRACE_AGENT_INSTRUCTIONS_FILE and is treatment-valid", async () => {
  const vexpDir = await fakeVexpDir();
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");
  const out = path.join(await tmpDir("gate-run"), "results");
  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  const dataDir = await tmpDir("gate-run-data");
  const dataFile = await writeSweBenchData(dataDir, [POLICY_RECORDS["django__django-10880"]]);

  let vexpSpawned = false;
  let vexpEnv: Record<string, string> | undefined;
  let vexpArgs: readonly string[] = [];
  const run = async (
    command: string,
    args: readonly string[],
    options?: { env?: Record<string, string> },
  ): Promise<ProcessResult> => {
    const line = [command, ...args].join(" ");
    if (line.includes("dist/cli.js")) {
      vexpSpawned = true;
      vexpEnv = options?.env;
      vexpArgs = args;
    }
    // The capsule retrieved real micro context; the gate still declines it.
    if (line.includes("capsule")) {
      return { exitCode: 0, stdout: microCapsuleJson("symbol: json_script\nfile: django/utils/html.py"), stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const config = baseConfig({
    vexpSweBenchDir: vexpDir,
    out,
    instances: ["django__django-10880"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
  });
  await runVtrace(config, { runProcess: run });

  // Requirement 3: the no-context run STILL executes (--no-vexp), but without the
  // instructions-file env, so nothing is injected.
  assert.equal(vexpSpawned, true);
  assert.ok(vexpArgs.includes("--no-vexp"));
  assert.ok(vexpEnv !== undefined);
  assert.equal(vexpEnv?.VTRACE_AGENT_INSTRUCTIONS_FILE, undefined);
  assert.equal(vexpEnv?.VTRACE_METHOD, "indexed-context");

  const meta = JSON.parse(await readFile(path.join(rawConditionDir(out, "vtrace"), "_run.meta.json"), "utf8"));
  assert.equal(meta.vtracePolicyAction, "skip");
  assert.equal(meta.vtraceContextPolicyAction, "no_context");
  assert.equal(meta.vtraceContextInjected, false);
  // Requirement 3: a no-context policy run IS a valid vtrace treatment.
  assert.equal(meta.vtraceTreatmentValid, true);
});

test("the report separates injected_context_count and no_context_count", async () => {
  const out = path.join(await tmpDir("gate-report"), "results");
  await seedCondition(out, "baseline", { resolved: null });
  await seedCondition(out, "vtrace", {
    resolved: null,
    vtraceMethod: "indexed-context",
    stderr: "Stage5 vtrace policy: no_context (no context injected)\n",
    indexedContext: false,
    metaExtra: {
      vtracePolicyAction: "skip",
      vtraceContextPolicyAction: "no_context",
      vtraceContextInjected: false,
      vtracePolicyReason: "Cheap/local task: injected context is likely net overhead.",
      expectedContextValue: "low",
      expectedOverheadRisk: "high",
    },
  });
  const artifact = await runIngest(baseConfig({ out }));

  // A no-context row is counted as no_context, NOT as an injected-context win.
  assert.equal(artifact.summary.noContextCount, 1);
  assert.equal(artifact.summary.injectedContextCount, 0);

  const md = await readFile(path.join(out, "stage5_vexp_swe_bench_smoke.md"), "utf8");
  assert.match(md, /No-context rows \| 1/);
  assert.match(md, /Injected-context rows \| 0/);
  // The gate's vocabulary + rationale are surfaced in the evidence table.
  assert.match(md, /\| vtrace_context_policy_action \| no_context \|/);
  assert.match(md, /\| expected_overhead_risk \| high \|/);
});

// ----- Stage 5: --context-policy override (Capsule v2 live validation) -----

// A representative cost-aware decision the gate would otherwise return. The
// override layer rewrites the action but preserves the expected value/risk.
const NO_CONTEXT_DECISION = {
  action: "no_context" as const,
  reason: "Cheap/local task: injected context is likely net overhead.",
  expectedContextValue: "low" as const,
  expectedOverheadRisk: "high" as const,
  decisionSignals: ["cheap_local", "micro_capsule"] as const,
};

test("--context-policy parses to the override (default auto) and rejects invalid values", () => {
  assert.equal(parseArgs(["--mode", "prepare"]).contextPolicyOverride, "auto");
  assert.equal(parseArgs(["--context-policy", "force-inject"]).contextPolicyOverride, "force-inject");
  assert.equal(parseArgs(["--context-policy", "force-no-context"]).contextPolicyOverride, "force-no-context");
  assert.throws(() => parseArgs(["--context-policy", "bogus"]), /Invalid --context-policy/);
});

test("applyContextPolicyOverride forces inject/no_context but auto is a passthrough", () => {
  // auto: the cost-aware decision stands.
  assert.deepEqual(applyContextPolicyOverride(NO_CONTEXT_DECISION, "auto", true), NO_CONTEXT_DECISION);

  // force-inject WITH context: action flips to inject with the validation reason,
  // preserving the gate's expected value/risk levels.
  const forced = applyContextPolicyOverride(NO_CONTEXT_DECISION, "force-inject", true);
  assert.equal(forced.action, "inject");
  assert.match(forced.reason, /forced to inject for validation/);
  assert.equal(forced.expectedContextValue, "low");
  assert.equal(forced.expectedOverheadRisk, "high");

  // force-inject WITHOUT context: nothing to force, so the decision is unchanged
  // (the absence of context is surfaced as a failure at the run level, not here).
  assert.deepEqual(applyContextPolicyOverride(NO_CONTEXT_DECISION, "force-inject", false), NO_CONTEXT_DECISION);

  // force-no-context: always no_context with the validation reason.
  const suppressed = applyContextPolicyOverride(
    { action: "inject", reason: "...", expectedContextValue: "high", expectedOverheadRisk: "low" },
    "force-no-context",
    true,
  );
  assert.equal(suppressed.action, "no_context");
  assert.match(suppressed.reason, /forced to no_context for validation/);
});

test("force-inject injects generated context even when auto would choose no_context", async () => {
  const out = path.join(await tmpDir("force-inject"), "results");
  const dataDir = await tmpDir("force-inject-data");
  // 10880 is a cheap/local task: with real micro context the auto gate declines
  // (see the auto test above). force-inject must inject it anyway.
  const dataFile = await writeSweBenchData(dataDir, [POLICY_RECORDS["django__django-10880"]]);
  const { run } = scriptedRunner([
    { match: "capsule", result: { stdout: microCapsuleJson("symbol: json_script\nfile: django/utils/html.py") } },
  ]);
  const config = baseConfig({
    out,
    instances: ["django__django-10880"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
    contextPolicyOverride: "force-inject",
  });
  const result = await prepareIndexedContext(config, { runProcess: run });

  assert.equal(result.contextPolicyAction, "inject");
  assert.equal(result.contextInjected, true);
  assert.equal(result.indexedContext, true);
  assert.equal(result.policyAction, "inject");
  assert.equal(result.contextPolicyOverride, "force-inject");
  assert.match(result.policyReason ?? "", /forced to inject for validation/);
  // The generated context body actually made it into the assembled file.
  const written = await readFile(result.contextFile, "utf8");
  assert.match(written, /json_script/);
});

test("force-inject still fails if no context was generated (never a valid skip)", async () => {
  const out = path.join(await tmpDir("force-inject-empty"), "results");
  const dataDir = await tmpDir("force-inject-empty-data");
  const dataFile = await writeSweBenchData(dataDir, [POLICY_RECORDS["django__django-10880"]]);
  // The capsule recovered nothing actionable (a skip). Under auto this is a valid
  // no-context policy, but force-inject must NOT degrade to a skip — there is no
  // context to validate, so it is a failure.
  const { run } = scriptedRunner([{ match: "capsule", result: { stdout: skipCapsuleJson() } }]);
  const config = baseConfig({
    out,
    instances: ["django__django-10880"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
    contextPolicyOverride: "force-inject",
  });
  const result = await prepareIndexedContext(config, { runProcess: run });

  // Not a valid skip: indexedContext false + a non-skip policy → runVtrace aborts.
  assert.equal(result.indexedContext, false);
  assert.equal(result.contextInjected, false);
  assert.notEqual(result.policyAction, "skip");
  assert.equal(result.contextPolicyOverride, "force-inject");
});

test("force-inject aborts runVtrace before spawn when no context was generated", async () => {
  const vexpDir = await fakeVexpDir();
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");
  const out = path.join(await tmpDir("force-inject-abort"), "results");
  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  const dataDir = await tmpDir("force-inject-abort-data");
  const dataFile = await writeSweBenchData(dataDir, [POLICY_RECORDS["django__django-10880"]]);

  let vexpSpawned = false;
  const run = async (command: string, args: readonly string[]): Promise<ProcessResult> => {
    const line = [command, ...args].join(" ");
    if (line.includes("dist/cli.js")) vexpSpawned = true;
    if (line.includes("capsule")) return { exitCode: 0, stdout: skipCapsuleJson(), stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const config = baseConfig({
    vexpSweBenchDir: vexpDir,
    out,
    instances: ["django__django-10880"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
    contextPolicyOverride: "force-inject",
  });
  await assert.rejects(() => runVtrace(config, { runProcess: run }), /produced no vtrace context/);
  assert.equal(vexpSpawned, false);
});

test("force-no-context runs WITHOUT VTRACE_AGENT_INSTRUCTIONS_FILE and records the override", async () => {
  const vexpDir = await fakeVexpDir();
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");
  const out = path.join(await tmpDir("force-nc-run"), "results");
  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  const dataDir = await tmpDir("force-nc-run-data");
  // A navigation-heavy instance whose strong-pivot capsule auto would INJECT; the
  // override forces no-context anyway.
  const dataFile = await writeSweBenchData(dataDir, [NAV_RECORD]);

  let vexpSpawned = false;
  let vexpEnv: Record<string, string> | undefined;
  let vexpArgs: readonly string[] = [];
  const run = async (
    command: string,
    args: readonly string[],
    options?: { env?: Record<string, string> },
  ): Promise<ProcessResult> => {
    const line = [command, ...args].join(" ");
    if (line.includes("dist/cli.js")) {
      vexpSpawned = true;
      vexpEnv = options?.env;
      vexpArgs = args;
    }
    if (line.includes("capsule")) {
      return { exitCode: 0, stdout: injectCapsuleJson("symbol: get_combinator_sql"), stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const config = baseConfig({
    vexpSweBenchDir: vexpDir,
    out,
    instances: ["django__django-11490"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
    contextPolicyOverride: "force-no-context",
  });
  await runVtrace(config, { runProcess: run });

  // Still runs the benchmark with --no-vexp, but injects nothing.
  assert.equal(vexpSpawned, true);
  assert.ok(vexpArgs.includes("--no-vexp"));
  assert.equal(vexpEnv?.VTRACE_AGENT_INSTRUCTIONS_FILE, undefined);

  const meta = JSON.parse(await readFile(path.join(rawConditionDir(out, "vtrace"), "_run.meta.json"), "utf8"));
  assert.equal(meta.vtraceContextPolicyAction, "no_context");
  assert.equal(meta.vtraceContextPolicyOverride, "force-no-context");
  assert.equal(meta.vtracePolicyAction, "skip");
  assert.equal(meta.vtraceContextInjected, false);
  assert.match(meta.vtracePolicyReason, /forced to no_context for validation/);
});

test("auto override is recorded in the metadata and CSV without changing behavior", async () => {
  const out = path.join(await tmpDir("auto-override"), "results");
  const dataDir = await tmpDir("auto-override-data");
  const dataFile = await writeSweBenchData(dataDir, [POLICY_RECORDS["django__django-10880"]]);
  const { run } = scriptedRunner([
    { match: "capsule", result: { stdout: microCapsuleJson("symbol: json_script") } },
  ]);
  const config = baseConfig({
    out,
    instances: ["django__django-10880"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
  });
  const result = await prepareIndexedContext(config, { runProcess: run });
  // Default auto: behavior unchanged (cheap/local task still gated to no_context).
  assert.equal(result.contextPolicyAction, "no_context");
  assert.equal(result.contextInjected, false);
  assert.equal(result.contextPolicyOverride, "auto");

  // The override column is present in the CSV header.
  assert.match(renderCsv([]), /vtrace_context_policy_override/);
});

// ----- Run-status / infra-failure reporting (Requirement 1–8) ------------------

test("a JSONL row with api_error_status 529 is classified as infra_failed", () => {
  const infra = classifyInfraFailure({
    instance_id: "x__1",
    api_error_status: 529,
    error: "overloaded",
    total_cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
  });
  assert.ok(infra !== null);
  assert.equal(infra?.infraErrorStatus, 529);
  assert.equal(infra?.infraErrorKind, "api_overloaded");

  // A clean completed run is NOT an infra failure.
  assert.equal(
    classifyInfraFailure({ instance_id: "x__2", cost_usd: 2, input_tokens: 100, modelPatch: "diff" }),
    null,
  );

  const row = extractRow({ instanceId: "x__1", api_error_status: 529, error: "overloaded" }, "vtrace", "/p");
  assert.equal(row?.runStatus, "infra_failed");
  assert.equal(row?.shouldRerun, true);
  assert.equal(row?.infraErrorStatus, 529);
  assert.equal(row?.infraErrorKind, "api_overloaded");
});

test("deriveRunStatus puts infra first, then policy skip, then patch presence", () => {
  const infra = { infraErrorStatus: 529, infraErrorKind: "api_overloaded", infraErrorMessage: "overloaded" };
  assert.equal(deriveRunStatus({ infra, error: null, patchAvailable: true, policyAction: "skip" }).runStatus, "infra_failed");
  assert.equal(deriveRunStatus({ infra: null, error: null, patchAvailable: true, policyAction: "skip" }).runStatus, "policy_skip");
  assert.equal(deriveRunStatus({ infra: null, error: "boom", patchAvailable: false, policyAction: null }).runStatus, "agent_failed");
  assert.equal(deriveRunStatus({ infra: null, error: null, patchAvailable: true, policyAction: null }).runStatus, "completed_patch");
  assert.equal(deriveRunStatus({ infra: null, error: null, patchAvailable: false, policyAction: null }).runStatus, "completed_no_patch");
});

test("a zero-token API-error row is excluded from per-condition metrics", () => {
  const infraRow = extractRow(
    { instanceId: "a__1", api_error_status: 529, error: "overloaded", total_cost_usd: 0, input_tokens: 0, output_tokens: 0 },
    "baseline",
    "/p",
  )!;
  const okRow = extractRow(
    { instanceId: "a__2", cost_usd: 2, input_tokens: 100, output_tokens: 0, modelPatch: "diff --git a/x b/x\n+p\n" },
    "baseline",
    "/p",
  )!;
  assert.equal(infraRow.runStatus, "infra_failed");

  const summaries = buildConditionSummaries([infraRow, okRow]);
  const baseline = summaries.find((summary) => summary.condition === "baseline");
  // Only the real (ok) row counts; the infra row never deflates the means.
  assert.equal(baseline?.instances, 1);
  assert.equal(baseline?.meanCost, 2);
  assert.equal(baseline?.meanTotalTokens, 100);
});

test("diagnoseConditionEvaluability reports API overload when JSONL has an infra failure", async () => {
  const out = path.join(await tmpDir("diag-infra"), "results");
  const dir = path.join(out, "raw", "baseline");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "swebench-2026-06-03.jsonl"),
    JSON.stringify({ instanceId: "a__1", api_error_status: 529, error: "overloaded", total_cost_usd: 0, input_tokens: 0, output_tokens: 0 }),
  );
  const diag = await diagnoseConditionEvaluability(dir);
  assert.equal(diag.evaluable, false);
  assert.ok(diag.infra !== null);
  assert.match(diag.message, /API 529 overloaded\. Rerun this label\./);
});

test("evaluate does not evaluate an infra-failure JSONL and surfaces the overload reason", async () => {
  const out = path.join(await tmpDir("eval-infra"), "results");
  const vexpDir = await fakeVexpCliDir();
  const dir = path.join(out, "raw", "baseline");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "swebench-2026-06-03.jsonl"),
    JSON.stringify({ instanceId: "a__1", api_error_status: 529, error: "overloaded", total_cost_usd: 0, input_tokens: 0, output_tokens: 0 }),
  );
  let evaluatorRan = false;
  const runProcess = async (): Promise<ProcessResult> => {
    evaluatorRan = true;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    () => runEvaluate(baseConfig({ vexpSweBenchDir: vexpDir, out }), { runProcess }),
    /529 overloaded/,
  );
  assert.equal(evaluatorRan, false);
});

test("a missing JSONL with a run meta yields an artifact-aware diagnosis (not the vague message)", async () => {
  const out = path.join(await tmpDir("diag-missing"), "results");
  const dir = path.join(out, "raw", "baseline");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "_run.meta.json"), JSON.stringify({ condition: "baseline", exitCode: 1 }));
  const diag = await diagnoseConditionEvaluability(dir);
  assert.equal(diag.hasArtifacts, true);
  assert.equal(diag.hasResultsFile, false);
  assert.match(diag.message, /failed before spawn/);

  // A skip-policy meta is explained as a skip, not a spawn failure.
  await writeFile(path.join(dir, "_run.meta.json"), JSON.stringify({ condition: "baseline", vtracePolicyAction: "skip" }));
  const skipDiag = await diagnoseConditionEvaluability(dir);
  assert.match(skipDiag.message, /vtrace policy selected skip/);

  // Truly empty dir falls back to the vague message only when no artifacts exist.
  const empty = path.join(out, "raw", "vexp");
  await mkdir(empty, { recursive: true });
  const emptyDiag = await diagnoseConditionEvaluability(empty);
  assert.equal(emptyDiag.hasArtifacts, false);
  assert.match(emptyDiag.message, /No condition results found to evaluate/);
});

test("a valid policy skip is reported as policy_skip, not a missing condition", async () => {
  const out = path.join(await tmpDir("skip-valid"), "results");
  await seedCondition(out, "baseline", { resolved: null, instanceId: "a__1" });
  await seedCondition(out, "vtrace", {
    resolved: null,
    instanceId: "a__1",
    vtraceMethod: "indexed-context",
    metaExtra: {
      vtracePolicyAction: "skip",
      vtraceContextInjected: false,
      vtraceSkipReason: "small local task",
      vtraceIndexedContext: false,
    },
  });
  const artifact = await runIngest(baseConfig({ out }));
  const vtraceRow = artifact.rows.find((row) => row.condition === "vtrace");
  assert.equal(vtraceRow?.runStatus, "policy_skip");
  assert.equal(artifact.summary.policySkipCount, 1);
  assert.equal(artifact.summary.missingResultCount, 0);
  assert.ok(!artifact.missingResults.some((entry) => entry.condition === "vtrace"));
});

test("run-protocol prints a run-status summary block", async () => {
  const out = path.join(await tmpDir("proto-status"), "results");
  const vexpDir = await fakeVexpCliDir();
  const runProcess = async (): Promise<ProcessResult> => {
    // Emulate the external benchmark producing a real result for the instance.
    const dir = path.join(out, "raw", "baseline");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "swebench-2026-06-03.jsonl"),
      JSON.stringify({ instanceId: "a__1", inputTokens: 100, outputTokens: 50, modelPatch: "diff --git a/x b/x\n+p\n", resolved: null }),
    );
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const writes: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    await runProtocol(baseConfig({ vexpSweBenchDir: vexpDir, out, instances: ["a__1"], protocol: "baseline" }), { runProcess });
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
  const printed = writes.join("");
  assert.match(printed, /Stage5 run status: completed_patch/);
  assert.match(printed, /Instance: a__1/);
  assert.match(printed, /Patch: yes/);
  assert.match(printed, /Rerun recommended: no/);
});

test("the aggregate report includes infra-failure and rerun counts", async () => {
  const out = path.join(await tmpDir("infra-report"), "results");
  const dir = path.join(out, "raw", "baseline");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "swebench-2026-06-03.jsonl"),
    JSON.stringify({ instanceId: "a__1", api_error_status: 529, error: "overloaded", total_cost_usd: 0, input_tokens: 0, output_tokens: 0 }),
  );
  const artifact = await runIngest(baseConfig({ out }));
  assert.equal(artifact.summary.infraFailedCount, 1);
  assert.equal(artifact.summary.rerunRecommendedCount, 1);
  const baselineRow = artifact.rows.find((row) => row.condition === "baseline");
  assert.equal(baselineRow?.runStatus, "infra_failed");
  // An infra-only condition contributes no benchmark aggregate row.
  assert.equal(artifact.conditionSummaries.find((summary) => summary.condition === "baseline"), undefined);

  const md = await readFile(path.join(out, "stage5_vexp_swe_bench_smoke.md"), "utf8");
  assert.match(md, /infra_failed \| 1/);
  assert.match(md, /rerun_recommended \| 1/);
  assert.match(md, /Infrastructure failures detected/);
});

test("formatRunStatusBlock renders an infra failure with a rerun action line", () => {
  const block = formatRunStatusBlock({
    runStatus: "infra_failed",
    label: "eval-diagnostic-11728",
    instance: "django__django-11728",
    condition: "vtrace",
    patch: false,
    tokens: 0,
    cost: 0,
    treatmentValid: false,
    shouldRerun: true,
    reason: "Claude API 529 overloaded; no tokens spent and no patch generated.",
  });
  assert.match(block, /Stage5 run status: infra_failed/);
  assert.match(block, /Label: eval-diagnostic-11728/);
  assert.match(block, /Rerun recommended: yes/);
  assert.match(block, /Action: rerun this label\./);
});

// ----- Stage 5: per-run instructions snapshot -----

// An injecting indexed-context runVtrace using a mocked process + a capsule that
// renders the given pivot symbol into the (root) active instructions file.
async function runVtraceInjecting(opts: {
  out: string; vexpDir: string; dataFile: string; runLabel: string | null; pivotSymbol: string;
}): Promise<void> {
  const run = async (command: string, args: readonly string[]): Promise<ProcessResult> => {
    const line = [command, ...args].join(" ");
    if (line.includes("capsule")) {
      return { exitCode: 0, stdout: injectCapsuleJson(`symbol: ${opts.pivotSymbol}`), stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const config = baseConfig({
    vexpSweBenchDir: opts.vexpDir,
    out: opts.out,
    instances: ["django__django-11490"],
    sweBenchDataFile: opts.dataFile,
    vtraceMethod: "indexed-context",
    runLabel: opts.runLabel,
  });
  await runVtrace(config, { runProcess: run });
}

test("vtraceInstructionsSnapshotFilePath is per-run-label (and root when unlabeled)", () => {
  assert.equal(
    vtraceInstructionsSnapshotFilePath("/out", "labelA"),
    path.join("/out", "runs", "labelA", "_vtrace_instructions.snapshot.md"),
  );
  assert.equal(
    vtraceInstructionsSnapshotFilePath("/out", null),
    path.join("/out", "_vtrace_instructions.snapshot.md"),
  );
});

test("runVtrace writes a per-run-label snapshot equal to the injected instructions", async () => {
  const vexpDir = await fakeVexpDir();
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");
  const out = path.join(await tmpDir("snap-eq"), "results");
  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  const dataDir = await tmpDir("snap-eq-data");
  const dataFile = await writeSweBenchData(dataDir, [NAV_RECORD]);

  await runVtraceInjecting({ out, vexpDir, dataFile, runLabel: "labelA", pivotSymbol: "get_combinator_sql" });

  const snapshotPath = path.join(out, "runs", "labelA", "_vtrace_instructions.snapshot.md");
  const snapshotContent = await readFile(snapshotPath, "utf8");
  // Snapshot content equals the active instructions file at spawn time.
  assert.equal(snapshotContent, await readFile(vtraceInstructionsFilePath(out), "utf8"));
  assert.match(snapshotContent, /get_combinator_sql/);

  // The meta records the snapshot path, existence, and content SHA-256.
  const meta = JSON.parse(await readFile(path.join(rawConditionDir(out, "vtrace", "labelA"), "_run.meta.json"), "utf8"));
  assert.equal(meta.vtraceInstructionsSnapshotFile, snapshotPath);
  assert.equal(meta.vtraceInstructionsSnapshotExists, true);
  assert.match(meta.vtraceInstructionsSha256, /^[0-9a-f]{64}$/);
  assert.equal(meta.vtraceInstructionsSha256, createHash("sha256").update(snapshotContent).digest("hex"));
});

test("a later labeled run cannot overwrite an earlier run's snapshot", async () => {
  const vexpDir = await fakeVexpDir();
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");
  const out = path.join(await tmpDir("snap-immut"), "results");
  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  const dataDir = await tmpDir("snap-immut-data");
  const dataFile = await writeSweBenchData(dataDir, [NAV_RECORD]);

  await runVtraceInjecting({ out, vexpDir, dataFile, runLabel: "labelA", pivotSymbol: "alpha_pivot" });
  // The second run overwrites the SHARED active file at the root, but must not
  // touch labelA's per-run snapshot.
  await runVtraceInjecting({ out, vexpDir, dataFile, runLabel: "labelB", pivotSymbol: "beta_pivot" });

  const snapA = await readFile(path.join(out, "runs", "labelA", "_vtrace_instructions.snapshot.md"), "utf8");
  const snapB = await readFile(path.join(out, "runs", "labelB", "_vtrace_instructions.snapshot.md"), "utf8");
  assert.match(snapA, /alpha_pivot/);
  assert.doesNotMatch(snapA, /beta_pivot/);
  assert.match(snapB, /beta_pivot/);
  // The shared active file was indeed clobbered by the later run (the very reason
  // the snapshot exists).
  assert.match(await readFile(vtraceInstructionsFilePath(out), "utf8"), /beta_pivot/);
});

test("a no-context policy run records no snapshot", async () => {
  const vexpDir = await fakeVexpDir();
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");
  const out = path.join(await tmpDir("snap-skip"), "results");
  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  const dataDir = await tmpDir("snap-skip-data");
  const dataFile = await writeSweBenchData(dataDir, [POLICY_RECORDS["django__django-10880"]]);
  const run = async (command: string, args: readonly string[]): Promise<ProcessResult> => {
    const line = [command, ...args].join(" ");
    // Real micro context, but the cost-aware gate declines (cheap/local) → skip.
    if (line.includes("capsule")) return { exitCode: 0, stdout: microCapsuleJson("symbol: json_script"), stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  await runVtrace(
    baseConfig({
      vexpSweBenchDir: vexpDir, out, instances: ["django__django-10880"],
      sweBenchDataFile: dataFile, vtraceMethod: "indexed-context", runLabel: "labelS",
    }),
    { runProcess: run },
  );

  const snapshotPath = path.join(out, "runs", "labelS", "_vtrace_instructions.snapshot.md");
  assert.equal(await readFile(snapshotPath, "utf8").catch(() => null), null);
  const meta = JSON.parse(await readFile(path.join(rawConditionDir(out, "vtrace", "labelS"), "_run.meta.json"), "utf8"));
  assert.equal(meta.vtracePolicyAction, "skip");
  assert.equal(meta.vtraceInstructionsSnapshotFile, undefined);
});

test("ingest/report prefer the snapshot for audit display", async () => {
  const out = path.join(await tmpDir("snap-report"), "results");
  const content = "# vtrace indexed context\nsymbol: get_combinator_sql\n";
  const sha = createHash("sha256").update(content).digest("hex");
  const snapshotPath = path.join(out, "_vtrace_instructions.snapshot.md");
  await mkdir(out, { recursive: true });
  await writeFile(snapshotPath, content);

  await seedCondition(out, "baseline", { resolved: null });
  await seedCondition(out, "vtrace", {
    resolved: null,
    vtraceMethod: "indexed-context",
    indexedContext: true,
    instructionsFile: vtraceInstructionsFilePath(out),
    contextFileContent: content,
    metaExtra: {
      vtraceInstructionsSnapshotFile: snapshotPath,
      vtraceInstructionsSnapshotExists: true,
      vtraceInstructionsSha256: sha,
    },
  });
  await runIngest(baseConfig({ out }));

  const md = await readFile(path.join(out, "stage5_vexp_swe_bench_smoke.md"), "utf8");
  assert.match(md, /vtrace_instructions_snapshot_file/);
  assert.ok(md.includes(`| vtrace_instructions_sha256 | ${sha} |`));
  // The audit display prefers the snapshot path in the primary instructions row.
  assert.ok(md.includes(`| vtrace_instructions_file | ${snapshotPath} |`));
  assert.ok(md.includes(`| vtrace_instructions_snapshot_file | ${snapshotPath} |`));
});

// ----- Stage 5: Capsule v2 audit metadata -----

test("classifyCapsuleV2Output captures pivots, support, and estimated tokens", () => {
  const classified = classifyCapsuleV2Output(JSON.parse(capsuleV2Json({ pivotPath: "a/b.py", pivotSymbol: "foo" })));
  assert.equal(classified.capsulePivots?.length, 1);
  assert.equal(classified.capsulePivots?.[0]?.path, "a/b.py");
  assert.equal(classified.capsulePivots?.[0]?.symbol, "foo");
  assert.equal(classified.capsulePivots?.[0]?.roleReason, "sql rendering implementation");
  assert.equal(typeof classified.capsulePivots?.[0]?.estimatedTokens, "number");
  assert.equal(classified.capsuleEstimatedTokens, 1200);

  // A no-context v2 result records no injected items.
  const skip = classifyCapsuleV2Output(JSON.parse(capsuleV2Json({ actualMode: "no_context" })));
  assert.deepEqual(skip.capsulePivots, []);
});

test("a v2 runVtrace writes camelCase capsule engine/intent/budget + selected items to meta", async () => {
  const vexpDir = await fakeVexpDir();
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");
  const out = path.join(await tmpDir("v2-audit-meta"), "results");
  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  const dataDir = await tmpDir("v2-audit-data");
  const dataFile = await writeSweBenchData(dataDir, [NAV_RECORD]);
  const run = async (command: string, args: readonly string[]): Promise<ProcessResult> => {
    const line = [command, ...args].join(" ");
    if (line.includes("capsule")) {
      return {
        exitCode: 0,
        stdout: capsuleV2Json({ pivotPath: "django/db/models/sql/compiler.py", pivotSymbol: "_setup_joins" }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  await runVtrace(
    baseConfig({
      vexpSweBenchDir: vexpDir, out, instances: ["django__django-11490"], sweBenchDataFile: dataFile,
      vtraceMethod: "indexed-context", capsuleEngine: "v2", capsuleIntent: "debug", capsuleBudget: 8000,
      runLabel: "labelV2",
    }),
    { runProcess: run },
  );

  const meta = JSON.parse(await readFile(path.join(rawConditionDir(out, "vtrace", "labelV2"), "_run.meta.json"), "utf8"));
  // The _run.meta.json standard is camelCase; engine/intent/budget are recorded.
  assert.equal(meta.vtraceCapsuleEngine, "v2");
  assert.equal(meta.vtraceCapsuleIntent, "debug");
  assert.equal(meta.vtraceCapsuleBudget, 8000);
  assert.equal(meta.vtraceCapsuleActualMode, "full");
  // Selected pivots/support recorded structurally (not just counts).
  assert.equal(meta.vtraceCapsuleTopPivotFile, "django/db/models/sql/compiler.py");
  assert.equal(meta.vtraceCapsuleTopPivotSymbol, "_setup_joins");
  assert.equal(typeof meta.vtraceCapsuleEstimatedTokens, "number");
  assert.ok(Array.isArray(meta.vtraceCapsulePivots));
  assert.equal(meta.vtraceCapsulePivots[0].path, "django/db/models/sql/compiler.py");
  assert.equal(meta.vtraceCapsulePivots[0].symbol, "_setup_joins");
  assert.equal(meta.vtraceCapsulePivots[0].roleReason, "sql rendering implementation");
  assert.equal(typeof meta.vtraceCapsulePivots[0].estimatedTokens, "number");
  // The snake_case names a grep might look for are NOT what is written (camelCase
  // is the standard); the report layer exposes snake_case separately.
  assert.equal(meta.vtrace_capsule_engine, undefined);
});

test("ingest/report read the same camelCase capsule fields the run writes", async () => {
  const out = path.join(await tmpDir("v2-roundtrip"), "results");
  await seedCondition(out, "baseline", { resolved: null });
  await seedCondition(out, "vtrace", {
    resolved: null,
    vtraceMethod: "indexed-context",
    indexedContext: true,
    metaExtra: {
      vtracePolicyAction: "inject",
      vtraceContextInjected: true,
      vtraceCapsuleEngine: "v2",
      vtraceCapsuleIntent: "debug",
      vtraceCapsuleBudget: 8000,
      vtraceCapsuleActualMode: "standard",
      vtraceCapsuleEstimatedTokens: 1234,
      vtraceCapsuleTopPivotFile: "django/db/models/sql/compiler.py",
      vtraceCapsuleTopPivotSymbol: "_setup_joins",
      vtraceCapsulePivots: [
        { path: "django/db/models/sql/compiler.py", symbol: "_setup_joins", roleReason: "impl helper", estimatedTokens: 600 },
      ],
      vtraceCapsuleSupport: [
        { path: "django/db/models/query.py", symbol: "values_list", roleReason: "entry point", estimatedTokens: 200 },
      ],
    },
  });
  const artifact = await runIngest(baseConfig({ out }));

  // Ingest read the camelCase names the run wrote, onto the normalized row.
  const vtraceRow = artifact.rows.find((row) => row.condition === "vtrace")!;
  assert.equal(vtraceRow.vtraceCapsuleEngine, "v2");
  assert.equal(vtraceRow.vtraceCapsuleIntent, "debug");
  assert.equal(vtraceRow.vtraceCapsuleBudget, 8000);
  assert.equal(vtraceRow.vtraceCapsuleActualMode, "standard");
  assert.equal(vtraceRow.vtraceCapsuleEstimatedTokens, 1234);
  assert.equal(vtraceRow.vtraceCapsulePivots?.[0]?.symbol, "_setup_joins");
  assert.equal(vtraceRow.vtraceCapsuleSupport?.[0]?.path, "django/db/models/query.py");

  // The report surfaces the audit fields (snake_case display) + selected items.
  const md = await readFile(path.join(out, "stage5_vexp_swe_bench_smoke.md"), "utf8");
  assert.match(md, /\| vtrace_capsule_engine \| v2 \|/);
  assert.match(md, /\| vtrace_capsule_intent \| debug \|/);
  assert.match(md, /\| vtrace_capsule_budget \| 8000 \|/);
  assert.match(md, /\| vtrace_capsule_actual_mode \| standard \|/);
  assert.match(md, /\| vtrace_capsule_estimated_tokens \| 1234 \|/);
  assert.ok(md.includes("| vtrace_capsule_top_pivot | django/db/models/sql/compiler.py::_setup_joins |"));
  assert.match(md, /Capsule v2 selected items/);
  assert.ok(md.includes("django/db/models/query.py::values_list"));
  // top support files row lists the support path.
  assert.ok(md.includes("| vtrace_capsule_top_support_files | django/db/models/query.py |"));
});

test("a full v2 runVtrace + ingest surfaces the snapshot path and sha in the report", async () => {
  const vexpDir = await fakeVexpDir();
  await writeFile(path.join(vexpDir, "dist", "cli.js"), "// fake cli\n");
  const out = path.join(await tmpDir("v2-snap-report"), "results");
  await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  const dataDir = await tmpDir("v2-snap-report-data");
  const dataFile = await writeSweBenchData(dataDir, [NAV_RECORD]);
  const run = async (command: string, args: readonly string[]): Promise<ProcessResult> => {
    const line = [command, ...args].join(" ");
    if (line.includes("capsule")) return { exitCode: 0, stdout: capsuleV2Json({ pivotSymbol: "_setup_joins" }), stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const cfg = baseConfig({
    vexpSweBenchDir: vexpDir, out, instances: ["django__django-11490"], sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context", capsuleEngine: "v2", capsuleIntent: "debug",
  });
  await seedCondition(out, "baseline", { resolved: null });
  await runVtrace(cfg, { runProcess: run });
  await runIngest(cfg);

  const meta = JSON.parse(await readFile(path.join(rawConditionDir(out, "vtrace"), "_run.meta.json"), "utf8"));
  const md = await readFile(path.join(out, "stage5_vexp_swe_bench_smoke.md"), "utf8");
  assert.ok(md.includes(`| vtrace_instructions_snapshot_file | ${meta.vtraceInstructionsSnapshotFile} |`));
  assert.ok(md.includes(`| vtrace_instructions_sha256 | ${meta.vtraceInstructionsSha256} |`));
  assert.match(md, /\| vtrace_capsule_engine \| v2 \|/);
});

// Requirement: writer (_run.meta.json), reader (normalized row), and report
// (CSV + Markdown) must agree on the SAME audit fields. The meta is camelCase by
// the harness convention; CSV/MD expose the matching snake_case names. This test
// pins both sides of every mapping at once, end to end, so a field added to one
// layer but not the others (or a casing drift) fails loudly.
test("writer, reader, and report agree on the capsule v2 audit + snapshot fields", async () => {
  // (camelCase meta/row name, snake_case report name) for each audit field.
  const SCALAR_FIELDS: ReadonlyArray<readonly [string, string]> = [
    ["vtraceCapsuleEngine", "vtrace_capsule_engine"],
    ["vtraceCapsuleIntent", "vtrace_capsule_intent"],
    ["vtraceCapsuleBudget", "vtrace_capsule_budget"],
    ["vtraceCapsuleActualMode", "vtrace_capsule_actual_mode"],
    ["vtraceCapsuleEstimatedTokens", "vtrace_capsule_estimated_tokens"],
    ["vtraceCapsuleTopPivotFile", "vtrace_capsule_top_pivot_file"],
    ["vtraceCapsuleTopPivotSymbol", "vtrace_capsule_top_pivot_symbol"],
    ["vtraceInstructionsSnapshotFile", "vtrace_instructions_snapshot_file"],
    ["vtraceInstructionsSha256", "vtrace_instructions_sha256"],
  ];
  const LIST_FIELDS: ReadonlyArray<readonly [string, string]> = [
    ["vtraceCapsulePivots", "vtrace_capsule_pivots"],
    ["vtraceCapsuleSupport", "vtrace_capsule_support"],
  ];

  const out = path.join(await tmpDir("v2-field-consistency"), "results");
  await seedCondition(out, "baseline", { resolved: null });
  await seedCondition(out, "vtrace", {
    resolved: null,
    vtraceMethod: "indexed-context",
    indexedContext: true,
    metaExtra: {
      vtracePolicyAction: "inject",
      vtraceContextInjected: true,
      vtraceCapsuleEngine: "v2",
      vtraceCapsuleIntent: "debug",
      vtraceCapsuleBudget: 8000,
      vtraceCapsuleActualMode: "standard",
      vtraceCapsuleEstimatedTokens: 1685,
      vtraceCapsuleTopPivotFile: "django/db/models/sql/compiler.py",
      vtraceCapsuleTopPivotSymbol: "get_combinator_sql",
      vtraceCapsulePivots: [
        { path: "django/db/models/sql/compiler.py", symbol: "get_combinator_sql", roleReason: "anchor", estimatedTokens: 600 },
      ],
      vtraceCapsuleSupport: [
        { path: "django/db/models/query.py", symbol: "values_list", roleReason: "entry point", estimatedTokens: 200 },
      ],
      // The snapshot fields carry through meta → evidence → row even when the
      // snapshot file is absent at ingest (a drift note is added, not a null).
      vtraceInstructionsSnapshotFile: "/out/runs/r/_vtrace_instructions.snapshot.md",
      vtraceInstructionsSha256: "c27777c51f763f4573b1b2ee356c155e0adfe614f7e10b74ddd95c6fdd55388b",
    },
  });
  const artifact = await runIngest(baseConfig({ out }));

  const meta = JSON.parse(await readFile(path.join(rawConditionDir(out, "vtrace"), "_run.meta.json"), "utf8"));
  const vtraceRow = artifact.rows.find((row) => row.condition === "vtrace")! as unknown as Record<string, unknown>;
  const csvHeader = renderCsv(artifact.rows).split("\n")[0]!;
  const md = await readFile(path.join(out, "stage5_vexp_swe_bench_smoke.md"), "utf8");

  for (const [camel, snake] of [...SCALAR_FIELDS, ...LIST_FIELDS]) {
    // Writer: camelCase key present in _run.meta.json; snake_case NOT (convention).
    assert.ok(camel in meta, `_run.meta.json missing camelCase ${camel}`);
    assert.ok(!(snake in meta), `_run.meta.json must not carry snake_case ${snake}`);
    // Reader: the normalized row carries the same camelCase key, defined.
    assert.notEqual(vtraceRow[camel], undefined, `normalized row missing ${camel}`);
    // Report (CSV): the snake_case column exists.
    assert.ok(csvHeader.includes(snake), `CSV header missing ${snake}`);
  }
  // Report (Markdown): scalar fields appear as table rows under their snake name.
  for (const [, snake] of SCALAR_FIELDS) {
    assert.match(md, new RegExp(`\\| ${snake} \\|`), `Markdown missing row for ${snake}`);
  }
  // The pivots/support lists are rendered as the "Capsule v2 selected items"
  // block (the structured presentation), keyed by the same data the columns carry.
  assert.match(md, /Capsule v2 selected items/);
  assert.ok(md.includes("get_combinator_sql"), "the injected pivot must appear in the selected items");
});
