import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  buildClaudeArgs,
  buildPrompt,
  buildSharedInstruction,
  comparePairs,
  computeCcusageDelta,
  computePromptPair,
  extractResponseJson,
  parseCcusageSnapshot,
  qualityScore,
  renderIngestMarkdown,
  renderPrepareMarkdown,
  runMatrix,
  runOne,
  runPair,
  scoreResponseJson,
  type CliConfig,
  type IngestRow,
  type ProcessRunner,
} from "./run_arc_stage3_agent_usage";
import type { ArcStage2Task, ExpectedTarget } from "../arc_stage2_orientation/run_arc_stage2_orientation";

const TASK: ArcStage2Task = {
  id: "workflow_arkane_input",
  category: "workflow",
  task: "Identify where Arkane input files are written or rendered.",
  query: "where is Arkane input written",
};

const EXPECTED: ExpectedTarget = {
  expected_paths: ["arc/statmech/arkane.py"],
  expected_symbols: ["render_arkane_input_template", "ArkaneAdapter.render_arkane_input_template"],
};

test("prompt generation creates baseline and vtrace condition prompts", () => {
  const pair = computePromptPair(TASK, "grep context", "vtrace context");

  assert.match(pair.baselinePrompt, /## Provided context: grep snippets/);
  assert.match(pair.vtracePrompt, /## Provided context: vtrace capsule/);
  assert.match(pair.baselinePrompt, /Do not use vtrace or MCP tools/);
  assert.match(pair.vtracePrompt, /Use the provided vtrace capsule/);
  assert.equal(pair.baselinePromptEstTokens, Math.ceil(pair.baselinePrompt.length / 4));
  assert.equal(pair.vtracePromptEstTokens, Math.ceil(pair.vtracePrompt.length / 4));
});

test("shared instruction is identical across conditions except condition context", () => {
  const baseline = buildPrompt(TASK, "baseline", "grep context");
  const vtrace = buildPrompt(TASK, "vtrace", "vtrace context");
  const shared = buildSharedInstruction(TASK);

  assert.equal(baseline.startsWith(shared), true);
  assert.equal(vtrace.startsWith(shared), true);
  assert.match(shared, /Use only the provided context\. Do not edit files\. Do not run commands\./);
  assert.match(shared, /Return JSON only with this shape:/);
});

test("ccusage parser handles mocked Claude-style session data", () => {
  const parsed = parseCcusageSnapshot({
    sessions: [
      {
        sessionId: "claude-1",
        model: "claude-sonnet-4",
        inputTokens: 100,
        outputTokens: 25,
        cacheCreationTokens: 10,
        cacheReadTokens: 40,
        totalTokens: 175,
        costUSD: 0.12,
      },
    ],
    totals: {
      inputTokens: 100,
      outputTokens: 25,
      cacheCreationTokens: 10,
      cacheReadTokens: 40,
      totalTokens: 175,
      costUSD: 0.12,
    },
  });

  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.sessions[0]!.sessionId, "claude-1");
  assert.equal(parsed.sessions[0]!.model, "claude-sonnet-4");
  assert.equal(parsed.aggregate.totalTokens, 175);
  assert.equal(parsed.aggregate.costUsd, 0.12);
});

test("ccusage parser handles mocked Codex-style session data", () => {
  const parsed = parseCcusageSnapshot({
    data: {
      rows: [
        {
          id: "codex-1",
          model_name: "gpt-5-codex",
          input_tokens: 200,
          output_tokens: 50,
          cache_creation_tokens: 15,
          cache_read_tokens: 35,
          total_tokens: 300,
          cost_usd: 0.2,
        },
      ],
      summary: {
        input_tokens: 200,
        output_tokens: 50,
        cache_creation_tokens: 15,
        cache_read_tokens: 35,
        total_tokens: 300,
        cost_usd: 0.2,
      },
    },
  });

  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.sessions[0]!.sessionId, "codex-1");
  assert.equal(parsed.sessions[0]!.model, "gpt-5-codex");
  assert.equal(parsed.aggregate.totalTokens, 300);
});

test("ccusage parser sums sessions when no separate aggregate object exists", () => {
  const parsed = parseCcusageSnapshot({
    sessions: [
      { sessionId: "one", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { sessionId: "two", inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    ],
  });

  assert.equal(parsed.aggregate.inputTokens, 30);
  assert.equal(parsed.aggregate.outputTokens, 15);
  assert.equal(parsed.aggregate.totalTokens, 45);
});

test("aggregate before/after delta calculation works without session IDs", () => {
  const delta = computeCcusageDelta(
    { totals: { input_tokens: 100, output_tokens: 50, total_tokens: 150, cost_usd: 0.1 } },
    { totals: { input_tokens: 180, output_tokens: 70, total_tokens: 250, cost_usd: 0.18 } },
  );

  assert.equal(delta.method, "aggregate_difference");
  assert.equal(delta.inputTokens, 80);
  assert.equal(delta.outputTokens, 20);
  assert.equal(delta.totalTokens, 100);
  assert.equal(delta.costUsd.toFixed(2), "0.08");
});

test("new-session delta calculation uses the newly added session row", () => {
  const delta = computeCcusageDelta(
    { sessions: [{ sessionId: "old", inputTokens: 10, outputTokens: 5, totalTokens: 15 }] },
    { sessions: [
      { sessionId: "old", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { sessionId: "new", model: "claude-sonnet-4", inputTokens: 80, outputTokens: 20, totalTokens: 100, costUSD: 0.05 },
    ] },
  );

  assert.equal(delta.method, "new_session");
  assert.equal(delta.sessionId, "new");
  assert.equal(delta.model, "claude-sonnet-4");
  assert.equal(delta.totalTokens, 100);
});

test("multiple new sessions are ambiguous unless aggregate fallback is allowed", () => {
  const delta = computeCcusageDelta(
    { sessions: [{ sessionId: "old", inputTokens: 10, outputTokens: 5, totalTokens: 15 }] },
    { sessions: [
      { sessionId: "old", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { sessionId: "new-a", inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      { sessionId: "new-b", inputTokens: 30, outputTokens: 5, totalTokens: 35 },
    ] },
  );

  assert.equal(delta.method, "unavailable");
  assert.equal(delta.ambiguous, true);
  assert.match(delta.notes.join("; "), /multiple new sessions found: 2/);
});

test("response JSON scoring covers strong acceptable weak missing and invalid", () => {
  assert.equal(scoreResponseJson({ target_file: "arc/statmech/arkane.py", target_symbol: null }, EXPECTED).quality, "strong");
  assert.equal(scoreResponseJson({ target_file: "arc/statmech/helper.py", target_symbol: null }, EXPECTED).quality, "acceptable");
  assert.equal(scoreResponseJson({ target_file: "arc/common.py", target_symbol: "helper" }, EXPECTED).quality, "weak");
  assert.equal(scoreResponseJson({ target_file: null, target_symbol: null }, EXPECTED).quality, "missing");
  assert.equal(scoreResponseJson("not-object", EXPECTED).quality, "invalid");
  assert.equal(scoreResponseJson({ target_file: null, target_symbol: "ArkaneAdapter.render_arkane_input_template" }, EXPECTED).quality, "strong");
});

test("pair comparison computes token reduction", () => {
  const pairs = comparePairs([
    makeRow("baseline", 100, "acceptable"),
    makeRow("vtrace", 40, "acceptable"),
  ]);

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.actualTotalTokenReductionPct, 60);
  assert.equal(pairs[0]!.qualityPreserving, true);
});

test("quality-preserving reduction is null when vtrace quality regresses", () => {
  const pairs = comparePairs([
    makeRow("baseline", 100, "strong"),
    makeRow("vtrace", 40, "weak"),
  ]);

  assert.equal(pairs[0]!.actualTotalTokenReductionPct, 60);
  assert.equal(pairs[0]!.qualityPreserving, false);
  assert.equal(pairs[0]!.qualityPreservingActualReductionPct, null);
});

test("quality scores follow benchmark ordering", () => {
  assert.equal(qualityScore("invalid"), 0);
  assert.equal(qualityScore("missing"), 0);
  assert.equal(qualityScore("weak"), 1);
  assert.equal(qualityScore("acceptable"), 2);
  assert.equal(qualityScore("strong"), 3);
});

test("markdown prepare-mode summary avoids actual ccusage claims", () => {
  const pair = computePromptPair(TASK, "a".repeat(400), "b".repeat(100));
  const markdown = renderPrepareMarkdown([pair], {
    arcRepoPath: "/home/calvin/code/ARC",
    agentSource: "claude",
  });

  assert.match(markdown, /Prompts generated: 2/);
  assert.match(markdown, /No actual ccusage claims are made yet/);
  assert.match(markdown, /Estimated prompt token comparison/);
});

test("ingest markdown reports tools-disabled status and methodology caveat", () => {
  const rows = [
    makeRow("baseline", 100, "strong"),
    makeRow("vtrace", 60, "strong"),
  ];
  const pairs = comparePairs(rows);
  const markdown = renderIngestMarkdown(rows, pairs, {
    completedRuns: rows.length,
    pairedTasks: pairs.length,
    meanActualTotalTokenReductionPct: 40,
    medianActualTotalTokenReductionPct: 40,
    meanQualityPreservingActualReductionPct: 40,
    vtraceQualitySameCount: 1,
    vtraceQualityBetterCount: 0,
    vtraceQualityWorseCount: 0,
    ambiguousCcusageDeltaCount: 0,
    invalidResponseCount: 0,
  }, {
    arcRepoPath: "/tmp/arc",
    agentSource: "claude",
  });

  assert.match(markdown, /Tools disabled: yes/);
  assert.match(markdown, /ccusage local CLI usage data/);
  assert.match(markdown, /session\/system\/cache behavior/);
});

test("Claude command arg construction includes configured options", () => {
  const args = buildClaudeArgs({
    claudeOutputFormat: "json",
    claudeMaxTurns: 2,
    claudeModel: "claude-sonnet-4",
    claudeSystemPromptFile: "/tmp/system.md",
    claudeAppendSystemPromptFile: "/tmp/append.md",
    claudeBare: true,
    claudeDisableTools: true,
    claudeExtraArgs: ["--permission-mode", "plan"],
  });

  assert.deepEqual(args, [
    "-p",
    "--output-format", "json",
    "--max-turns", "2",
    "--model", "claude-sonnet-4",
    "--system-prompt-file", "/tmp/system.md",
    "--append-system-prompt-file", "/tmp/append.md",
    "--bare",
    "--tools", "",
    "--permission-mode", "plan",
  ]);
});

test("response extraction handles direct JSON stdout", () => {
  const extracted = extractResponseJson(JSON.stringify(responseObject("strong")));
  assert.deepEqual(extracted, responseObject("strong"));
});

test("response extraction handles Claude wrapper JSON field", () => {
  const extracted = extractResponseJson(JSON.stringify({ result: JSON.stringify(responseObject("acceptable")) }));
  assert.deepEqual(extracted, responseObject("acceptable"));
});

test("response extraction handles fenced JSON", () => {
  const extracted = extractResponseJson([
    "Here is the answer:",
    "```json",
    JSON.stringify(responseObject("weak")),
    "```",
  ].join("\n"));
  assert.deepEqual(extracted, responseObject("weak"));
});

test("invalid extraction through run-one produces parse error response", async () => {
  const { config } = await makeRunFixture();
  const calls: string[] = [];
  const mock = makeRunner(calls, "not json");

  await runOne(config, { runProcess: mock });

  const response = JSON.parse(await readFile(path.join(config.out, "responses", `${TASK.id}.baseline.response.json`), "utf8"));
  assert.equal(response.quality, "invalid");
  assert.equal(typeof response.parse_error, "string");
});

test("run-one passes prompt through stdin and writes stdout stderr meta", async () => {
  const { config, prompt } = await makeRunFixture();
  const stdinValues: string[] = [];
  const mock: ProcessRunner = async (command, args, options) => {
    if (command === "claude") {
      stdinValues.push(options?.stdin ?? "");
      return { exitCode: 0, stdout: JSON.stringify(responseObject("strong")), stderr: "warn" };
    }
    return { exitCode: 0, stdout: JSON.stringify({ sessions: [{ sessionId: `${args[3]}-${stdinValues.length}`, inputTokens: 1, outputTokens: 1, totalTokens: 2 }] }), stderr: "" };
  };

  await runOne(config, { runProcess: mock });

  assert.deepEqual(stdinValues, [prompt]);
  assert.equal(await readFile(path.join(config.out, "agent_runs", `${TASK.id}.baseline.claude.stdout.json`), "utf8"), `${JSON.stringify(responseObject("strong"))}\n`);
  assert.equal(await readFile(path.join(config.out, "agent_runs", `${TASK.id}.baseline.claude.stderr.txt`), "utf8"), "warn\n");
  const meta = JSON.parse(await readFile(path.join(config.out, "agent_runs", `${TASK.id}.baseline.claude.meta.json`), "utf8"));
  assert.equal(meta.command, "claude");
  assert.equal(meta.toolsDisabled, true);
  assert.deepEqual(meta.args.slice(0, 5), ["-p", "--output-format", "json", "--max-turns", "1"]);
});

test("run-one calls snapshot before and after using mocked ccusage", async () => {
  const { config } = await makeRunFixture();
  const calls: string[] = [];

  await runOne(config, { runProcess: makeRunner(calls, JSON.stringify(responseObject("strong"))) });

  assert.deepEqual(calls, ["bunx ccusage", "claude", "bunx ccusage"]);
  assert.notEqual(await readFile(path.join(config.out, "snapshots", `${TASK.id}.baseline.before.json`), "utf8"), "");
  assert.notEqual(await readFile(path.join(config.out, "snapshots", `${TASK.id}.baseline.after.json`), "utf8"), "");
});

test("run-pair runs baseline then vtrace", async () => {
  const { config } = await makeRunFixture("baseline", true);
  await writePrompt(config, "vtrace");
  const claudeRuns: string[] = [];
  const mock: ProcessRunner = async (command, args, options) => {
    if (command === "claude") {
      claudeRuns.push(options?.stdin?.includes("vtrace prompt") ? "vtrace" : "baseline");
      return { exitCode: 0, stdout: JSON.stringify(responseObject("strong")), stderr: "" };
    }
    return { exitCode: 0, stdout: JSON.stringify({ sessions: [{ sessionId: `${claudeRuns.length}`, inputTokens: 1, outputTokens: 1, totalTokens: 2 }] }), stderr: "" };
  };

  await runPair({ ...config, mode: "run-pair", condition: null, ingestAfterRun: false }, { runProcess: mock });

  assert.deepEqual(claudeRuns, ["baseline", "vtrace"]);
});

test("run-matrix respects explicit task IDs", async () => {
  const { config } = await makeRunFixture("baseline", false);
  for (const taskId of ["exact_scheduler", "known_weak_rotor_scans"]) {
    await writePrompt({ ...config, taskId }, "baseline");
    await writePrompt({ ...config, taskId }, "vtrace");
  }
  const claudeRuns: string[] = [];
  const mock: ProcessRunner = async (command, _args, options) => {
    if (command === "claude") {
      claudeRuns.push(options?.stdin ?? "");
      return { exitCode: 0, stdout: JSON.stringify(responseObject("strong")), stderr: "" };
    }
    return { exitCode: 0, stdout: JSON.stringify({ sessions: [{ sessionId: `${claudeRuns.length}`, inputTokens: 1, outputTokens: 1, totalTokens: 2 }] }), stderr: "" };
  };

  await runMatrix({ ...config, mode: "run-matrix", taskIds: ["exact_scheduler", "known_weak_rotor_scans"], yes: true, ingestAfterRun: false }, { runProcess: mock });

  assert.deepEqual(claudeRuns, [
    "exact_scheduler baseline prompt",
    "exact_scheduler vtrace prompt",
    "known_weak_rotor_scans baseline prompt",
    "known_weak_rotor_scans vtrace prompt",
  ]);
});

test("run-matrix requires --yes", async () => {
  const { config } = await makeRunFixture();
  await assert.rejects(
    () => runMatrix({ ...config, mode: "run-matrix", taskIds: ["exact_scheduler"], yes: false, ingestAfterRun: false }, { runProcess: makeRunner([], JSON.stringify(responseObject("strong"))) }),
    /--yes/,
  );
});

function makeRow(condition: "baseline" | "vtrace", totalTokens: number, quality: "strong" | "acceptable" | "weak"): IngestRow {
  return {
    taskId: TASK.id,
    condition,
    agentSource: "claude",
    toolsDisabled: true,
    model: "claude-sonnet-4",
    sessionId: `${TASK.id}.${condition}`,
    deltaMethod: "new_session",
    promptEstTokens: 10,
    actualInputTokens: totalTokens - 10,
    actualOutputTokens: 10,
    actualCacheCreationTokens: 0,
    actualCacheReadTokens: 0,
    actualTotalTokens: totalTokens,
    actualCostUsd: 0.01,
    responseQuality: quality,
    responseQualityScore: qualityScore(quality),
    targetFile: "arc/statmech/arkane.py",
    targetSymbol: "render_arkane_input_template",
    matchedExpectedPath: "arc/statmech/arkane.py",
    matchedExpectedSymbol: "render_arkane_input_template",
    parseError: null,
    notes: [],
  };
}

function responseObject(quality: "strong" | "acceptable" | "weak") {
  return {
    target_file: "arc/statmech/arkane.py",
    target_symbol: "render_arkane_input_template",
    quality,
    confidence: "high",
    reason: "Located the benchmark target.",
  };
}

async function makeRunFixture(condition: "baseline" | "vtrace" = "baseline", writeInitialPrompt = true): Promise<{ config: CliConfig; prompt: string }> {
  const out = await mkdtemp(path.join(os.tmpdir(), "arc-stage3-"));
  const config: CliConfig = {
    repo: "/tmp/arc",
    tasks: path.join(out, "tasks.json"),
    expected: path.join(out, "expected.json"),
    out,
    agentSource: "claude",
    mode: "run-one",
    snapshotLabel: null,
    taskId: TASK.id,
    taskIds: [],
    condition,
    allowAggregateAmbiguous: false,
    allowMissingCcusage: false,
    yes: false,
    ingestAfterRun: false,
    baselineMaxFiles: 5,
    snippetContextLines: 40,
    maxSnippetsPerFile: 3,
    toolCommand: "handoff",
    claudeCommand: "claude",
    claudeModel: null,
    claudeMaxTurns: 1,
    claudeOutputFormat: "json",
    claudeExtraArgs: [],
    claudeSystemPromptFile: null,
    claudeAppendSystemPromptFile: "/tmp/system.md",
    claudeBare: false,
    claudeDisableTools: true,
  };

  await writeFile(config.tasks, `${JSON.stringify([TASK])}\n`);
  await writeFile(config.expected, `${JSON.stringify({ [TASK.id]: EXPECTED })}\n`);
  await mkdir(path.join(out, "prompts"), { recursive: true });
  await mkdir(path.join(out, "snapshots"), { recursive: true });
  await mkdir(path.join(out, "responses"), { recursive: true });
  await mkdir(path.join(out, "agent_runs"), { recursive: true });
  await writeFile(path.join(out, "arc_stage3_agent_usage_manifest.json"), `${JSON.stringify({
    metadata: {},
    prompts: [{
      task_id: TASK.id,
      baseline_prompt_est_tokens: 10,
      vtrace_prompt_est_tokens: 8,
    }],
  })}\n`);

  const prompt = `${TASK.id} ${condition} prompt`;
  if (writeInitialPrompt) {
    await writePrompt(config, condition, prompt);
  }
  return { config, prompt };
}

async function writePrompt(config: CliConfig, condition: "baseline" | "vtrace", prompt = `${config.taskId} ${condition} prompt`): Promise<void> {
  await mkdir(path.join(config.out, "prompts"), { recursive: true });
  await writeFile(path.join(config.out, "prompts", `${config.taskId}.${condition}.md`), prompt);
}

function makeRunner(calls: string[], claudeStdout: string): ProcessRunner {
  return async (command, args) => {
    if (command === "claude") {
      calls.push("claude");
      return { exitCode: 0, stdout: claudeStdout, stderr: "" };
    }
    calls.push(`${command} ${args[0]}`);
    return {
      exitCode: 0,
      stdout: JSON.stringify({ sessions: [{ sessionId: `${calls.length}`, inputTokens: 1, outputTokens: 1, totalTokens: 2 }] }),
      stderr: "",
    };
  };
}
