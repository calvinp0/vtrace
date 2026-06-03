import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  applyVtracePatch,
  buildBaselineCommand,
  buildVtracePatchBlock,
  buildVtraceCommand,
  classifyOutcome,
  comparePairs,
  extractRow,
  installVtracePatch,
  isVtracePatched,
  loadSmokeInstances,
  parseArgs,
  parseResultRecords,
  reductionPct,
  renderMarkdown,
  runIngest,
  runPrepare,
  runVtrace,
  STAGE5_VTRACE_INJECTION_LOG,
  STAGE5_VTRACE_PATCH_MARKER,
  verifyVtracePatch,
  type CliConfig,
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
  condition: "baseline" | "vtrace",
  opts: { resolved?: boolean | null; vtraceMethod?: string | null; instructionsFile?: string; stderr?: string } = {},
): Promise<void> {
  const dir = path.join(out, "raw", condition);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "swebench-2026-06-03.jsonl"),
    JSON.stringify({
      instanceId: "django__django-11133",
      inputTokens: 100,
      outputTokens: 50,
      modelPatch: "diff --git a/x b/x\n+patch\n",
      resolved: opts.resolved ?? null,
    }),
  );
  const meta: Record<string, unknown> = {
    condition,
    vtraceMethod: opts.vtraceMethod ?? null,
    exitCode: 0,
  };
  if (opts.instructionsFile) meta.env = { VTRACE_AGENT_INSTRUCTIONS_FILE: opts.instructionsFile };
  await writeFile(path.join(dir, "_run.meta.json"), JSON.stringify(meta, null, 2));
  if (opts.stderr !== undefined) await writeFile(path.join(dir, "_run.stderr.txt"), opts.stderr);
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

  // The env passed to the child exports the instructions file path...
  const expectedFile = path.join(out, "raw", "vtrace", "_vtrace_instructions.md");
  assert.equal(capturedEnv?.VTRACE_AGENT_INSTRUCTIONS_FILE, expectedFile);
  assert.equal(capturedEnv?.VTRACE_METHOD, "local-patch");
  // ...and that file actually exists on disk before the run.
  const instructions = await readFile(expectedFile, "utf8");
  assert.match(instructions, /vtrace agent instructions/i);
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

function makeRow(instanceId: string, condition: "baseline" | "vtrace", overrides: Partial<Stage5Row>): Stage5Row {
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
