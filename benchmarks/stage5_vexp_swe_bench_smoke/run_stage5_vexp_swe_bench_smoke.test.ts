import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  buildBaselineCommand,
  buildVtraceCommand,
  classifyOutcome,
  comparePairs,
  extractRow,
  loadSmokeInstances,
  parseArgs,
  parseResultRecords,
  reductionPct,
  renderMarkdown,
  runIngest,
  runPrepare,
  type CliConfig,
  type Stage5Row,
} from "./run_stage5_vexp_swe_bench_smoke";

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
