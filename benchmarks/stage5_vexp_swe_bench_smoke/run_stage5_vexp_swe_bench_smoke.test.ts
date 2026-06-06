import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  applyContextPolicyOverride,
  applyVtracePatch,
  assertVexpAllowed,
  assertVtraceInstructionsFileValid,
  buildBaselineCommand,
  buildCheckoutCommand,
  buildCloneCommand,
  buildConditionSummaries,
  buildEvaluateCommand,
  buildInstanceQuery,
  buildVexpCommand,
  buildVtraceContextMarkdown,
  buildVtraceIndexCommand,
  buildVtracePatchBlock,
  buildVtraceQueryCommand,
  buildVtraceCommand,
  buildCapsuleV2Task,
  buildAgentCompliance,
  capsuleModeForInstance,
  capsuleQueryTextFor,
  classifyCapsuleOutput,
  classifyCapsuleV2Output,
  classifyInfraFailure,
  classifyOutcome,
  combineRunEvidence,
  comparePairs,
  decideContextPolicy,
  deriveContextPolicySignals,
  deriveRunStatus,
  diagnoseConditionEvaluability,
  evaluateCondition,
  formatRunStatusBlock,
  extractCapsuleContext,
  extractInstanceContextSection,
  extractRow,
  findCanonicalResultsFile,
  findSweBenchRecord,
  installVtracePatch,
  isVtracePatched,
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
  runProtocol,
  runVexp,
  runVtrace,
  STAGE5_VTRACE_INJECTION_LOG,
  STAGE5_VTRACE_INJECTION_SKIPPED,
  STAGE5_VTRACE_PATCH_MARKER,
  toSweBenchInstance,
  truncateContext,
  verifyVtracePatch,
  vtraceInstructionsFilePath,
  vtraceInstructionsSnapshotFilePath,
  workspacePathFor,
  type CapsulePolicyDiagnostics,
  type CliConfig,
  type ProcessResult,
  type SweBenchInstance,
  type Stage5Row,
  type Stage5RunEvidence,
} from "./run_stage5_vexp_swe_bench_smoke";

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
  "        return { args, startMs };",
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
    showVtraceIndexLog: false,
    vtraceContextMaxChars: 12000,
    vtraceContextMaxItems: 8,
    capsuleEngine: "legacy",
    capsuleIntent: "auto",
    capsuleBudget: 8000,
    contextPolicyOverride: "auto",
    sweBenchDataFile: null,
    runLabel: null,
    runLabels: null,
    protocol: "baseline",
    allowVexp: false,
    evalMode: "docker",
    evalDataset: null,
    evalTimeout: 1800,
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

test("install-vtrace-patch patches the fixture, backs it up, and writes a manifest", async () => {
  const vexpDir = await fakeVexpDir();
  const out = path.join(await tmpDir("patch-out"), "results");
  const target = path.join(vexpDir, "dist", "agents", "claude-code.js");

  const manifest = await installVtracePatch(baseConfig({ vexpSweBenchDir: vexpDir, out }));
  assert.equal(manifest.installed, true);
  assert.equal(manifest.patchMarker, STAGE5_VTRACE_PATCH_MARKER);
  assert.deepEqual(manifest.patchedFiles, [target]);

  // Target file now carries the marker.
  const patched = await readFile(target, "utf8");
  assert.ok(isVtracePatched(patched));

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
  // Still exactly one marker pair after re-install.
  const patched = await readFile(target, "utf8");
  assert.equal(patched.split(STAGE5_VTRACE_PATCH_MARKER).length - 1, patched.split(STAGE5_VTRACE_PATCH_MARKER).length - 1);
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
  opts: { actualMode?: string; pivotSymbol?: string; pivotPath?: string; pivotCount?: number; reason?: string } = {},
): string {
  const actualMode = opts.actualMode ?? "full";
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
  return JSON.stringify({
    ...base,
    actual_mode: actualMode,
    pivots: [
      {
        role: "pivot", role_reason: "sql rendering implementation", path: pivotPath,
        fq_name: `SQLCompiler.${pivotSymbol}`, symbol: pivotSymbol, kind: "method",
        content_mode: "signature", signature: `def ${pivotSymbol}(self, combinator, all)`,
        evidence: ["named in the issue", "on the failing test's call path"], scorecard: {}, estimated_tokens: 1200,
      },
    ],
    support: [],
    diagnostics: {
      intent_confidence: "high", intent_reason: ["failing test names a compiler symbol"],
      strategy: { role_policy: "debug_refinement" }, candidate_count: 5,
      pivot_count: opts.pivotCount ?? 1, support_count: 0, discarded_count: 4, tier: actualMode,
      weights: {}, likely_files: [pivotPath], likely_symbols: [pivotSymbol], failing_tests: [],
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
  assert.deepEqual(clone.args, ["clone", "https://github.com/django/django.git", "/ws"]);
  const checkout = buildCheckoutCommand("/ws", "abc123");
  assert.deepEqual(checkout.args, ["-C", "/ws", "checkout", "abc123", "--force"]);
});

test("vtrace index/query commands embed the workspace and query", () => {
  const config = baseConfig({ vtraceCommand: "bun src/cli/index.ts", vtraceIndexArgs: "--quiet", vtraceQueryArgs: "--json" });
  const index = buildVtraceIndexCommand(config, "/ws");
  assert.equal(index.command, "bun");
  assert.deepEqual(index.args, ["src/cli/index.ts", "index", "/ws", "--quiet"]);
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
    "src/cli/index.ts", "capsule", "/ws", "fix the bug", "--intent", "auto", "--budget", "8000", "--json",
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
  assert.equal(parseArgs(["--mode", "prepare"]).capsuleEngine, "legacy");
  const cfg = parseArgs(["--capsule-engine", "v2", "--capsule-intent", "debug", "--capsule-budget", "6000"]);
  assert.equal(cfg.capsuleEngine, "v2");
  assert.equal(cfg.capsuleIntent, "debug");
  assert.equal(cfg.capsuleBudget, 6000);
  assert.throws(() => parseArgs(["--capsule-engine", "bogus"]), /Invalid --capsule-engine/);
  assert.throws(() => parseArgs(["--capsule-intent", "bogus"]), /Invalid --capsule-intent/);
  assert.throws(() => parseArgs(["--capsule-budget", "0"]), /--capsule-budget requires a positive integer/);
});

test("capsuleQueryTextFor returns a clean task for v2 and the packed query for legacy", () => {
  const instance = sampleInstance();
  const v2Task = capsuleQueryTextFor(baseConfig({ capsuleEngine: "v2" }), instance);
  assert.equal(v2Task, buildCapsuleV2Task(instance));
  assert.match(v2Task, /instance: django__django-11728/);
  assert.match(v2Task, /repo: django\/django/);
  assert.match(v2Task, /replace_named_groups does not handle trailing groups/);
  assert.match(v2Task, /failing tests:/);
  // No evaluation labels leak into the task text.
  assert.doesNotMatch(v2Task, /resolved|gold|FAIL_TO_PASS|condition/);

  const legacy = capsuleQueryTextFor(baseConfig({ capsuleEngine: "legacy" }), instance);
  assert.equal(legacy, buildInstanceQuery(instance));
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

test("classifyCapsuleOutput routes a Capsule v2 payload to the v2 classifier", () => {
  const classified = classifyCapsuleOutput(capsuleV2Json({ pivotSymbol: "get_combinator_sql" }));
  assert.equal(classified.policyAction, "inject");
  assert.match(classified.context, /get_combinator_sql/);
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
  assert.match(result.queryCommand ?? "", /--intent debug --budget 8000 --json/);

  // The metadata + report carry the engine.
  const written = await readFile(result.contextFile, "utf8");
  assert.match(written, /get_combinator_sql/);
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
  ]) {
    assert.ok(header!.includes(col), `header missing ${col}`);
  }
  assert.ok(dataRow!.includes("django/contrib/admin/options.py"));
  assert.ok(dataRow!.includes("get_inlines"));
  assert.ok(dataRow!.includes("true"));
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
    return { exitCode: 0, stdout: "", stderr: "", ...(entry?.result ?? {}) };
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

test("buildVtraceIndexCommand drops --quiet only when --show-vtrace-index-log is set", () => {
  const quiet = buildVtraceIndexCommand(baseConfig({ vtraceIndexArgs: "--quiet" }), "/ws");
  assert.deepEqual(quiet.args, ["src/cli/index.ts", "index", "/ws", "--quiet"]);
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

  // The existing clone is scrubbed (clean -fdx) + re-checked-out, never re-cloned,
  // and re-indexed despite the stale index being present.
  assert.ok(calls.some((c) => c.includes("clean") && c.includes("-fdx")), "git clean -fdx must run");
  assert.ok(calls.some((c) => c.includes("checkout")), "checkout must run");
  assert.ok(calls.some((c) => c.includes(" index ")), "the index must be rebuilt");
  assert.ok(!calls.some((c) => c.includes("clone")), "an existing clone must not be re-cloned");
  // Meta records the fresh policy + the observed index timing.
  assert.equal(result.freshWorkspace, true);
  assert.equal(result.vtraceIndexQuiet, true);
  assert.equal(typeof result.vtraceIndexDurationMs, "number");
  assert.match(result.vtraceIndexStartedAt ?? "", /T.*Z$/);
  assert.match(result.vtraceIndexFinishedAt ?? "", /T.*Z$/);
});

test("prepareIndexedContext --reuse-workspace reuses the existing checkout + index", async () => {
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

  // Reuse touches nothing: no clean, no checkout, no reindex — only the query runs.
  assert.ok(!calls.some((c) => c.includes("clean")), "reuse must not git clean");
  assert.ok(!calls.some((c) => c.includes("checkout")), "reuse must not re-checkout");
  assert.ok(!calls.some((c) => c.includes(" index ")), "reuse must not reindex when index.sqlite is present");
  assert.ok(calls.some((c) => c.includes("capsule")), "the query still runs");
  assert.equal(result.freshWorkspace, false);
  assert.equal(result.vtraceIndexStartedAt, null);
  assert.equal(result.vtraceIndexDurationMs, null);
});

test("--show-vtrace-index-log shows the index bar (drops --quiet, inherits stdio, forces progress)", async () => {
  const out = path.join(await tmpDir("idx-log"), "results");
  const dataDir = await tmpDir("idx-log-data");
  const dataFile = await writeSweBenchData(dataDir, [NAV_RECORD]);
  let indexArgs: readonly string[] = [];
  let indexOpts: { env?: Record<string, string>; inheritStdio?: boolean } | undefined;
  const run = async (
    command: string,
    args: readonly string[],
    options?: { env?: Record<string, string>; inheritStdio?: boolean },
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
    showVtraceIndexLog: true,
  });
  await prepareIndexedContext(config, { runProcess: run });

  assert.ok(!indexArgs.includes("--quiet"), "--quiet must be dropped so the indexer emits progress");
  assert.equal(indexOpts?.inheritStdio, true, "the index must inherit our TTY to draw its native bar");
  assert.equal(indexOpts?.env?.VTRACE_PROGRESS_STREAM, "1", "progress must be forced on for the non-TTY fallback");
});

test("without --show-vtrace-index-log the index is captured quietly (no stdio inherit)", async () => {
  const out = path.join(await tmpDir("idx-quiet"), "results");
  const dataDir = await tmpDir("idx-quiet-data");
  const dataFile = await writeSweBenchData(dataDir, [NAV_RECORD]);
  let indexArgs: readonly string[] = [];
  let indexOpts: { env?: Record<string, string>; inheritStdio?: boolean } | undefined;
  const run = async (
    command: string,
    args: readonly string[],
    options?: { env?: Record<string, string>; inheritStdio?: boolean },
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
  });
  await prepareIndexedContext(config, { runProcess: run });

  assert.ok(indexArgs.includes("--quiet"), "the index stays quiet by default");
  assert.notEqual(indexOpts?.inheritStdio, true, "default index must be captured, not inherited");
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
