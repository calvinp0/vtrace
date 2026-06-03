import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  applyTaskSetup,
  buildPrompt,
  buildClaudeArgs,
  buildClaudeToolPolicy,
  classifyOutcome,
  comparePairs,
  diffSnapshots,
  loadStage4Tasks,
  parseArgs,
  runMatrix,
  runOne,
  snapshotRunDirectory,
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
  const protectedPrompt = buildPrompt(TASK, "baseline", "", true);

  assert.match(baseline, /You are running an autonomous edit benchmark/);
  assert.doesNotMatch(baseline, /## vtrace context/);
  assert.match(vtrace, /## vtrace context/);
  assert.match(vtrace, /vtrace context/);
  assert.match(vtrace, /You may edit only the allowed files listed below/);
  assert.match(vtrace, /Changing any file outside the allowed list fails the benchmark/);
  assert.match(vtrace, /write the answer only in STAGE4_NOTES.md/);
  assert.match(vtrace, /Do not update ARC documentation files, source files, tests, or markdown files other than STAGE4_NOTES.md/);
  assert.doesNotMatch(baseline, /runner has attempted to restrict edit tools/);
  assert.match(protectedPrompt, /runner has attempted to restrict edit tools to the allowed files/);
});

test("Claude args default to autonomous edit permissions with narrow tools", () => {
  const args = buildClaudeArgs({
    claudeOutputFormat: "json",
    claudeMaxTurns: 8,
    claudeModel: null,
    claudeSystemPromptFile: null,
    claudeAppendSystemPromptFile: null,
    claudeBare: false,
    claudeDisableTools: false,
    claudeProtectAllowedFiles: false,
    claudePermissionMode: "acceptEdits",
    claudeAllowedTools: ["Read", "Grep", "Glob", "LS", "Edit", "Write"],
    claudeExtraArgs: [],
  });

  assert.deepEqual(args, [
    "-p",
    "--output-format", "json",
    "--max-turns", "8",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read,Grep,Glob,LS,Edit,Write",
  ]);
});

test("Claude args include protected edit policy when enabled", () => {
  const args = buildClaudeArgs({
    claudeOutputFormat: "json",
    claudeMaxTurns: 8,
    claudeModel: null,
    claudeSystemPromptFile: null,
    claudeAppendSystemPromptFile: null,
    claudeBare: false,
    claudeDisableTools: false,
    claudeProtectAllowedFiles: true,
    claudePermissionMode: "acceptEdits",
    claudeAllowedTools: ["Read", "Grep", "Glob", "LS", "Edit", "Write"],
    claudeExtraArgs: [],
  }, TASK);

  assert.deepEqual(args, [
    "-p",
    "--output-format", "json",
    "--max-turns", "8",
    "--permission-mode", "acceptEdits",
    "--tools", "Read,Grep,Glob,LS,Edit,Write",
    "--allowedTools", "Read",
    "--allowedTools", "Grep",
    "--allowedTools", "Glob",
    "--allowedTools", "LS",
    "--allowedTools", "Edit(STAGE4_NOTES.md)",
    "--allowedTools", "Write(STAGE4_NOTES.md)",
    "--disallowedTools", "Edit(docs/*)",
    "--disallowedTools", "Write(docs/*)",
    "--disallowedTools", "Edit(arc/*)",
    "--disallowedTools", "Write(arc/*)",
    "--disallowedTools", "Edit(leng_gauss.md)",
    "--disallowedTools", "Write(leng_gauss.md)",
    "--disallowedTools", "Edit(wang_gauss.md)",
    "--disallowedTools", "Write(wang_gauss.md)",
  ]);
});

test("--claude-protect-allowed-files is parsed", () => {
  const config = parseArgs([
    "--repo", "/tmp/arc",
    "--tasks", "/tmp/tasks.json",
    "--out", "/tmp/out",
    "--agent-source", "claude",
    "--mode", "run-one",
    "--task-id", TASK.id,
    "--condition", "baseline",
    "--claude-protect-allowed-files",
    "--yes",
  ]);

  assert.equal(config.claudeProtectAllowedFiles, true);
});

test("protected tool policy is explicit and task-scoped", () => {
  const policy = buildClaudeToolPolicy(TASK);

  assert.equal(policy.tools, "Read,Grep,Glob,LS,Edit,Write");
  assert.ok(policy.allowedTools.includes("Edit(STAGE4_NOTES.md)"));
  assert.ok(policy.allowedTools.includes("Write(STAGE4_NOTES.md)"));
  assert.ok(policy.disallowedTools.includes("Edit(docs/*)"));
  assert.ok(policy.disallowedTools.includes("Edit(arc/*)"));
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
  assert.deepEqual(result.disallowedChangedFiles, ["arc/scheduler.py"]);
  assert.deepEqual(result.ignoredChangedFiles, []);
  assert.ok(result.failedChecks.includes("allowed_files_only"));
});

test("tool state path changes are ignored for allowed-files-only validation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage4-validate-ignore-"));
  await writeFile(path.join(dir, "STAGE4_NOTES.md"), "arc/statmech/arkane.py render_arkane_input_template");

  const result = await validateTaskRun(dir, TASK, [
    "STAGE4_NOTES.md",
    ".vtrace/state.json",
    ".mytool/cache.json",
    ".claude/settings.local.json",
  ]);

  assert.equal(result.passed, true);
  assert.equal(result.allowedFilesOnly, true);
  assert.deepEqual(result.ignoredChangedFiles, [
    ".vtrace/state.json",
    ".mytool/cache.json",
    ".claude/settings.local.json",
  ]);
  assert.deepEqual(result.disallowedChangedFiles, []);
});

test("real docs changes remain disallowed while tool state is ignored", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage4-validate-docs-"));
  await writeFile(path.join(dir, "STAGE4_NOTES.md"), "arc/statmech/arkane.py render_arkane_input_template");

  const result = await validateTaskRun(dir, TASK, [
    "STAGE4_NOTES.md",
    ".vtrace/state.json",
    "docs/gaussian.md",
  ]);

  assert.equal(result.passed, false);
  assert.equal(result.allowedFilesOnly, false);
  assert.deepEqual(result.ignoredChangedFiles, [".vtrace/state.json"]);
  assert.deepEqual(result.disallowedChangedFiles, ["docs/gaussian.md"]);
  assert.ok(result.failedChecks.includes("allowed_files_only"));
});

test("task-level ignored changed paths are honored", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage4-validate-task-ignore-"));
  await writeFile(path.join(dir, "STAGE4_NOTES.md"), "arc/statmech/arkane.py render_arkane_input_template");

  const result = await validateTaskRun(dir, { ...TASK, ignored_changed_paths: ["custom_state/"] }, [
    "STAGE4_NOTES.md",
    "custom_state/cache.json",
  ]);

  assert.equal(result.passed, true);
  assert.equal(result.allowedFilesOnly, true);
  assert.deepEqual(result.ignoredChangedFiles, ["custom_state/cache.json"]);
  assert.deepEqual(result.disallowedChangedFiles, []);
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

test("run-one records protected allowed-file status in meta and reports", async () => {
  const config = { ...(await makeConfig()), claudeProtectAllowedFiles: true, ingestAfterRun: true };

  await runOne(config, { runProcess: mockRunner() });

  const meta = JSON.parse(await readFile(path.join(config.out, "agent_runs", `${TASK.id}.baseline.meta.json`), "utf8"));
  assert.equal(meta.protectAllowedFiles, true);
  assert.deepEqual(meta.allowedFiles, ["STAGE4_NOTES.md"]);
  assert.deepEqual(meta.claudeToolPolicy.allowedTools.slice(-2), ["Edit(STAGE4_NOTES.md)", "Write(STAGE4_NOTES.md)"]);

  const csv = await readFile(path.join(config.out, "arc_stage4_autonomous_edit.csv"), "utf8");
  assert.match(csv.split(/\r?\n/)[0]!, /protected_allowed_files/);
  assert.match(csv, /,true,true,/);

  const json = JSON.parse(await readFile(path.join(config.out, "arc_stage4_autonomous_edit.json"), "utf8"));
  assert.equal(json.rows[0].protectedAllowedFiles, true);

  const markdown = await readFile(path.join(config.out, "arc_stage4_autonomous_edit.md"), "utf8");
  assert.match(markdown, /Protected allowed-file runs: 1/);
});

test("agent max-turns exit does not abort the run and is ingested as a failed run", async () => {
  const config = { ...(await makeConfig()), ingestAfterRun: true };

  // Claude exits non-zero with a valid result envelope (error_max_turns) and
  // never writes STAGE4_NOTES.md, mirroring a real max-turns timeout.
  const mock: ProcessRunnerWithCwd = async (command, args, options) => {
    if (command === "claude") {
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          terminal_reason: "max_turns",
          errors: ["Reached maximum number of turns (8)"],
        }),
        stderr: "",
      };
    }
    return mockRunner()(command, args, options);
  };

  // Must resolve, not throw: an agent failure should not abort the sweep.
  await runOne(config, { runProcess: mock });

  const validation = JSON.parse(await readFile(path.join(config.out, "validation", `${TASK.id}.baseline.validation.json`), "utf8"));
  assert.equal(validation.passed, false);

  const json = JSON.parse(await readFile(path.join(config.out, "arc_stage4_autonomous_edit.json"), "utf8"));
  assert.equal(json.rows[0].passed, false);
  assert.ok(json.rows[0].notes.some((note: string) => note.includes("agent did not complete: max_turns")));
});

test("genuine infrastructure failure with no result envelope still aborts the run", async () => {
  const config = await makeConfig();

  const mock: ProcessRunnerWithCwd = async (command, args, options) => {
    if (command === "claude") {
      return { exitCode: 1, stdout: "", stderr: "claude: command crashed" };
    }
    return mockRunner()(command, args, options);
  };

  await assert.rejects(
    () => runOne(config, { runProcess: mock }),
    /Claude run failed for .*: claude: command crashed/,
  );
});

test("copied dirty source file does not count as changed if unchanged after initial snapshot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage4-snap-clean-"));
  await writeFile(path.join(dir, "STAGE4_NOTES.md"), "# Stage 4 Notes\n\n");
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs", "gaussian.md"), "pre-existing dirty source content\n");

  const initial = await snapshotRunDirectory(dir);
  // Agent only edits the allowed file; the dirty copied source file is left alone.
  await writeFile(path.join(dir, "STAGE4_NOTES.md"), "arc/statmech/arkane.py render_arkane_input_template\n");
  const changed = diffSnapshots(initial, await snapshotRunDirectory(dir));

  assert.deepEqual(changed, ["STAGE4_NOTES.md"]);

  const result = await validateTaskRun(dir, TASK, changed, {
    sourceRepoDirtyFiles: ["docs/gaussian.md"],
    changeDetectionMethod: "initial_snapshot",
  });
  assert.equal(result.passed, true);
  assert.equal(result.allowedFilesOnly, true);
  assert.deepEqual(result.disallowedChangedFiles, []);
  assert.deepEqual(result.sourceRepoDirtyFiles, ["docs/gaussian.md"]);
});

test("allowed file modified after snapshot counts as allowed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage4-snap-allowed-"));
  await writeFile(path.join(dir, "STAGE4_NOTES.md"), "# Stage 4 Notes\n\n");

  const initial = await snapshotRunDirectory(dir);
  await writeFile(path.join(dir, "STAGE4_NOTES.md"), "arc/statmech/arkane.py render_arkane_input_template\n");
  const changed = diffSnapshots(initial, await snapshotRunDirectory(dir));

  const result = await validateTaskRun(dir, TASK, changed);
  assert.deepEqual(changed, ["STAGE4_NOTES.md"]);
  assert.deepEqual(result.allowedChangedFiles, ["STAGE4_NOTES.md"]);
  assert.equal(result.allowedFilesOnly, true);
});

test("disallowed file modified after snapshot counts as disallowed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage4-snap-disallowed-"));
  await writeFile(path.join(dir, "STAGE4_NOTES.md"), "# Stage 4 Notes\n\n");
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs", "gaussian.md"), "original\n");

  const initial = await snapshotRunDirectory(dir);
  await writeFile(path.join(dir, "docs", "gaussian.md"), "edited by the agent\n");
  const changed = diffSnapshots(initial, await snapshotRunDirectory(dir));

  const result = await validateTaskRun(dir, TASK, changed);
  assert.deepEqual(changed, ["docs/gaussian.md"]);
  assert.equal(result.allowedFilesOnly, false);
  assert.deepEqual(result.disallowedChangedFiles, ["docs/gaussian.md"]);
  assert.ok(result.failedChecks.includes("allowed_files_only"));
});

test("ignored path modified after snapshot counts as ignored", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage4-snap-ignored-"));
  await writeFile(path.join(dir, "STAGE4_NOTES.md"), "# Stage 4 Notes\n\n");
  await mkdir(path.join(dir, ".vtrace"), { recursive: true });
  await writeFile(path.join(dir, ".vtrace", "state.json"), "{}\n");

  const initial = await snapshotRunDirectory(dir);
  await writeFile(path.join(dir, ".vtrace", "state.json"), "{\"updated\":true}\n");
  const changed = diffSnapshots(initial, await snapshotRunDirectory(dir));

  const result = await validateTaskRun(dir, TASK, changed);
  assert.deepEqual(changed, [".vtrace/state.json"]);
  assert.deepEqual(result.ignoredChangedFiles, [".vtrace/state.json"]);
  assert.deepEqual(result.disallowedChangedFiles, []);
  assert.equal(result.allowedFilesOnly, true);
});

test("deleted file after snapshot is detected", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage4-snap-deleted-"));
  await writeFile(path.join(dir, "STAGE4_NOTES.md"), "# Stage 4 Notes\n\n");
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs", "gaussian.md"), "original\n");

  const initial = await snapshotRunDirectory(dir);
  await rm(path.join(dir, "docs", "gaussian.md"));
  const changed = diffSnapshots(initial, await snapshotRunDirectory(dir));

  assert.deepEqual(changed, ["docs/gaussian.md"]);
});

test("created file after snapshot is detected", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage4-snap-created-"));
  await writeFile(path.join(dir, "STAGE4_NOTES.md"), "# Stage 4 Notes\n\n");

  const initial = await snapshotRunDirectory(dir);
  await mkdir(path.join(dir, "arc"), { recursive: true });
  await writeFile(path.join(dir, "arc", "new_module.py"), "x = 1\n");
  const changed = diffSnapshots(initial, await snapshotRunDirectory(dir));

  assert.deepEqual(changed, ["arc/new_module.py"]);
});

test("snapshot scan excludes git internals", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage4-snap-git-"));
  await writeFile(path.join(dir, "STAGE4_NOTES.md"), "# Stage 4 Notes\n\n");
  await mkdir(path.join(dir, ".git"), { recursive: true });
  await writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");

  const snapshot = await snapshotRunDirectory(dir);

  assert.ok("STAGE4_NOTES.md" in snapshot.files);
  assert.ok(!Object.keys(snapshot.files).some((file) => file.startsWith(".git/")));
});

test("--require-clean-source fails before running Claude when source is dirty", async () => {
  const config = { ...(await makeConfig()), requireCleanSource: true };

  await assert.rejects(
    () => runOne(config, { runProcess: mockRunner() }),
    /require-clean-source/,
  );
});

test("--require-clean-source is parsed", () => {
  const config = parseArgs([
    "--repo", "/tmp/arc",
    "--tasks", "/tmp/tasks.json",
    "--out", "/tmp/out",
    "--mode", "run-one",
    "--task-id", TASK.id,
    "--condition", "baseline",
    "--require-clean-source",
    "--yes",
  ]);

  assert.equal(config.requireCleanSource, true);
});

test("validation JSON records changeDetectionMethod initial_snapshot", async () => {
  const config = await makeConfig();

  await runOne(config, { runProcess: mockRunner() });

  const validation = JSON.parse(await readFile(path.join(config.out, "validation", `${TASK.id}.baseline.validation.json`), "utf8"));
  assert.equal(validation.changeDetectionMethod, "initial_snapshot");
  assert.equal(validation.passed, true);
  assert.deepEqual(validation.changedFiles, ["STAGE4_NOTES.md"]);
  assert.deepEqual(validation.allowedChangedFiles, ["STAGE4_NOTES.md"]);

  const snapshot = JSON.parse(await readFile(path.join(config.out, "validation", `${TASK.id}.baseline.initial_snapshot.json`), "utf8"));
  assert.ok("STAGE4_NOTES.md" in snapshot.files);
  assert.equal(snapshot.files["STAGE4_NOTES.md"].exists, true);
  assert.equal(typeof snapshot.files["STAGE4_NOTES.md"].hash, "string");
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
    allowedChangedFiles: ["STAGE4_NOTES.md"],
    ignoredChangedFiles: [],
    disallowedChangedFiles: [],
    sourceRepoDirtyFiles: [],
    changeDetectionMethod: "initial_snapshot",
    protectedAllowedFiles: false,
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
    claudeProtectAllowedFiles: false,
    claudePermissionMode: "acceptEdits",
    claudeAllowedTools: ["Read", "Grep", "Glob", "LS", "Edit", "Write"],
    toolCommand: "handoff",
    requireCleanSource: false,
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
