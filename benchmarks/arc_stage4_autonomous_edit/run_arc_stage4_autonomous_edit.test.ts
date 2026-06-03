import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  applyTaskSetup,
  buildPrompt,
  classifyOutcome,
  comparePairs,
  loadStage4Tasks,
  runMatrix,
  runOne,
  validateTaskRun,
  worktreePath,
  type CliConfig,
  type ProcessRunnerWithCwd,
  type Stage4RunRow,
  type Stage4Task,
} from "./run_arc_stage4_autonomous_edit";

const TASK: Stage4Task = {
  id: "doc_find_arkane_input",
  category: "docs",
  task: "Add a note.",
  query: "where is Arkane input written",
  allowed_files: ["STAGE4_NOTES.md"],
  setup: {
    create_files: {
      "STAGE4_NOTES.md": "# Stage 4 Notes\n\n",
    },
  },
  success: {
    required_file_contains: {
      "STAGE4_NOTES.md": ["arc/statmech/arkane.py", "render_arkane_input_template"],
    },
  },
};

test("task loading reads stage 4 task file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage4-tasks-"));
  const file = path.join(dir, "tasks.json");
  await writeFile(file, `${JSON.stringify([TASK])}\n`);

  const tasks = await loadStage4Tasks(file);

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.id, TASK.id);
});

test("worktree path generation is task and condition scoped", () => {
  assert.equal(
    worktreePath("/tmp/results", "task_a", "vtrace"),
    "/tmp/results/worktrees/task_a.vtrace",
  );
});

test("setup file creation writes benchmark-local files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage4-setup-"));

  await applyTaskSetup(dir, TASK);

  assert.equal(await readFile(path.join(dir, "STAGE4_NOTES.md"), "utf8"), "# Stage 4 Notes\n\n");
});

test("prompt generation separates baseline and vtrace context", () => {
  const baseline = buildPrompt(TASK, "baseline", "vtrace context");
  const vtrace = buildPrompt(TASK, "vtrace", "vtrace context");

  assert.match(baseline, /You are running an autonomous edit benchmark/);
  assert.doesNotMatch(baseline, /## vtrace context/);
  assert.match(vtrace, /## vtrace context/);
  assert.match(vtrace, /vtrace context/);
  assert.match(vtrace, /Do not modify files outside the allowed list/);
});

test("required_file_contains validation passes when all strings exist", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage4-validate-"));
  await writeFile(path.join(dir, "STAGE4_NOTES.md"), "arc/statmech/arkane.py render_arkane_input_template");

  const result = await validateTaskRun(dir, TASK, ["STAGE4_NOTES.md"]);

  assert.equal(result.passed, true);
  assert.equal(result.allowedFilesOnly, true);
});

test("allowed-files-only validation fails for outside edits", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage4-validate-"));
  await writeFile(path.join(dir, "STAGE4_NOTES.md"), "arc/statmech/arkane.py render_arkane_input_template");

  const result = await validateTaskRun(dir, TASK, ["STAGE4_NOTES.md", "arc/scheduler.py"]);

  assert.equal(result.passed, false);
  assert.equal(result.allowedFilesOnly, false);
  assert.ok(result.failedChecks.includes("allowed_files_only"));
});

test("required_file_contains_any validation accepts any complete group", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage4-validate-any-"));
  const task: Stage4Task = {
    ...TASK,
    success: {
      required_file_contains_any: {
        "STAGE4_NOTES.md": [
          ["missing.py", "Missing"],
          ["arc/molecule/graph.pyx", "Edge"],
        ],
      },
    },
  };
  await writeFile(path.join(dir, "STAGE4_NOTES.md"), "arc/molecule/graph.pyx Edge");

  const result = await validateTaskRun(dir, task, ["STAGE4_NOTES.md"]);

  assert.equal(result.passed, true);
});

test("pair outcome classification covers all cases", () => {
  assert.equal(classifyOutcome(true, true), "both_passed");
  assert.equal(classifyOutcome(false, true), "vtrace_only_passed");
  assert.equal(classifyOutcome(true, false), "baseline_only_passed");
  assert.equal(classifyOutcome(false, false), "both_failed");
});

test("pair comparison computes token and cost reductions", () => {
  const pairs = comparePairs([
    makeRow("baseline", true, 100, 0.2),
    makeRow("vtrace", true, 40, 0.1),
  ]);

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.outcome, "both_passed");
  assert.equal(pairs[0]!.actualTotalTokenReductionPct, 60);
  assert.equal(pairs[0]!.actualCostReductionPct, 50);
  assert.equal(pairs[0]!.bothPassedTokenReductionPct, 60);
});

test("run-matrix requires --yes", async () => {
  const config = await makeConfig();

  await assert.rejects(
    () => runMatrix({ ...config, mode: "run-matrix", taskIds: [TASK.id], yes: false }, { runProcess: mockRunner() }),
    /--yes/,
  );
});

test("run-one uses isolated worktree cwd and captures patch status with mocked runner", async () => {
  const config = await makeConfig();
  const cwdValues: string[] = [];
  const mock = mockRunner(cwdValues);

  await runOne(config, { runProcess: mock });

  const expectedWorktree = worktreePath(config.out, TASK.id, "baseline");
  assert.ok(cwdValues.includes(expectedWorktree));
  assert.ok(!cwdValues.includes(config.repo));
  assert.match(await readFile(path.join(config.out, "patches", `${TASK.id}.baseline.status.txt`), "utf8"), /STAGE4_NOTES.md/);
  const validation = JSON.parse(await readFile(path.join(config.out, "validation", `${TASK.id}.baseline.validation.json`), "utf8"));
  assert.equal(validation.passed, true);
});

function makeRow(condition: "baseline" | "vtrace", passed: boolean, totalTokens: number, costUsd: number): Stage4RunRow {
  return {
    taskId: TASK.id,
    condition,
    agentSource: "claude",
    model: "claude-sonnet-4",
    sessionId: `${TASK.id}.${condition}`,
    deltaMethod: "new_session",
    passed,
    outcome: "",
    actualInputTokens: totalTokens - 10,
    actualOutputTokens: 10,
    actualCacheCreationTokens: 0,
    actualCacheReadTokens: 0,
    actualTotalTokens: totalTokens,
    actualCostUsd: costUsd,
    durationMs: 1000,
    changedFiles: ["STAGE4_NOTES.md"],
    allowedFilesOnly: true,
    validationFailedChecks: [],
    responseParseError: null,
    notes: [],
  };
}

async function makeConfig(): Promise<CliConfig> {
  const out = await mkdtemp(path.join(os.tmpdir(), "stage4-run-"));
  const repo = path.join(out, "source-arc");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await mkdir(path.join(repo, "arc", "statmech"), { recursive: true });
  await writeFile(path.join(repo, "arc", "statmech", "arkane.py"), "def render_arkane_input_template(): pass\n");
  const tasks = path.join(out, "tasks.json");
  await writeFile(tasks, `${JSON.stringify([TASK])}\n`);
  return {
    repo,
    tasks,
    out: path.join(out, "results"),
    agentSource: "claude",
    mode: "run-one",
    taskId: TASK.id,
    taskIds: [],
    condition: "baseline",
    worktreeMode: "copy",
    overwrite: false,
    yes: true,
    ingestAfterRun: false,
    allowAggregateAmbiguous: false,
    claudeCommand: "claude",
    claudeModel: null,
    claudeMaxTurns: 8,
    claudeOutputFormat: "json",
    claudeExtraArgs: [],
    claudeSystemPromptFile: null,
    claudeAppendSystemPromptFile: null,
    claudeBare: false,
    claudeDisableTools: false,
    toolCommand: "handoff",
  };
}

function mockRunner(cwdValues: string[] = []): ProcessRunnerWithCwd {
  let snapshotCount = 0;
  return async (command, args, options) => {
    if (options?.cwd !== undefined) cwdValues.push(options.cwd);
    if (command.endsWith("vtrace")) {
      return { exitCode: 0, stdout: "vtrace context", stderr: "" };
    }
    if (command === "bunx") {
      snapshotCount += 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ sessions: [{ sessionId: `s${snapshotCount}`, inputTokens: snapshotCount, outputTokens: 1, totalTokens: snapshotCount + 1, costUSD: snapshotCount / 100 }] }),
        stderr: "",
      };
    }
    if (command === "claude") {
      const cwd = options?.cwd;
      assert.ok(cwd);
      await writeFile(path.join(cwd, "STAGE4_NOTES.md"), "arc/statmech/arkane.py render_arkane_input_template\n");
      return {
        exitCode: 0,
        stdout: JSON.stringify({ edited_files: ["STAGE4_NOTES.md"], target_files_or_symbols_used: ["arc/statmech/arkane.py"], success_claim: true, reason: "done" }),
        stderr: "",
      };
    }
    if (command === "git" && args.includes("status")) {
      return { exitCode: 0, stdout: " M STAGE4_NOTES.md\n", stderr: "" };
    }
    if (command === "git" && args.includes("diff") && args.includes("--stat")) {
      return { exitCode: 0, stdout: " STAGE4_NOTES.md | 1 +\n", stderr: "" };
    }
    if (command === "git" && args.includes("diff")) {
      return { exitCode: 0, stdout: "diff --git a/STAGE4_NOTES.md b/STAGE4_NOTES.md\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}
