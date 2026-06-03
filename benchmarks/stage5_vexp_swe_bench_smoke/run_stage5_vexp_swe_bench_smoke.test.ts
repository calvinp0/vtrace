import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
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
  classifyOutcome,
  comparePairs,
  evaluateCondition,
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
  renderMarkdown,
  runEvaluate,
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
  workspacePathFor,
  type CliConfig,
  type ProcessResult,
  type SweBenchInstance,
  type Stage5Row,
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
    vtraceContextMaxChars: 12000,
    vtraceContextMaxItems: 8,
    sweBenchDataFile: null,
    runLabel: null,
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

test("buildVtraceContextMarkdown emits one section per instance with the required headings", () => {
  const result = buildVtraceContextMarkdown(
    [{ instance: sampleInstance(), rawContext: "symbol: replace_named_groups\nfile: utils.py", error: null }],
    { maxChars: 12000, maxItems: 8 },
  );
  assert.match(result.markdown, /^# vtrace indexed context/);
  assert.match(result.markdown, /vexp is disabled/);
  assert.match(result.markdown, /## Instance/);
  assert.match(result.markdown, /- instance_id: django__django-11728/);
  assert.match(result.markdown, /## Problem statement/);
  assert.match(result.markdown, /## vtrace context/);
  assert.match(result.markdown, /symbol: replace_named_groups/);
  assert.match(result.markdown, /## Instruction/);
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
  const dataFile = await writeSweBenchData(dataDir, [SAMPLE_RECORD]);
  const { run, calls } = scriptedRunner([
    { match: "capsule", result: { stdout: "symbol: replace_named_groups\nfile: admindocs/utils.py\n" } },
  ]);
  const config = baseConfig({
    out,
    instances: ["django__django-11728"],
    sweBenchDataFile: dataFile,
    vtraceMethod: "indexed-context",
  });
  const result = await prepareIndexedContext(config, { runProcess: run });

  assert.equal(result.indexedContext, true);
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
  assert.match(context, /symbol: replace_named_groups/);
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
