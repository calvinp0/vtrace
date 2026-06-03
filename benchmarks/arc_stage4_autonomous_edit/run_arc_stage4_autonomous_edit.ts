import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  computeCcusageDelta,
  type AgentSource,
  type BenchmarkCondition,
  type DeltaMethod,
  type DeltaResult,
  type ProcessResult,
  type ProcessRunner,
} from "../arc_stage3_agent_usage/run_arc_stage3_agent_usage";

export type Stage4Mode = "prepare" | "run-one" | "run-pair" | "run-matrix" | "ingest" | "validate";
export type WorktreeMode = "copy" | "git-worktree";
export type PairOutcome = "both_passed" | "vtrace_only_passed" | "baseline_only_passed" | "both_failed";

export interface Stage4Task {
  readonly id: string;
  readonly category: string;
  readonly task: string;
  readonly query: string;
  readonly allowed_files: readonly string[];
  readonly ignored_changed_paths?: readonly string[];
  readonly setup?: {
    readonly create_files?: Record<string, string>;
  };
  readonly success?: {
    readonly required_file_contains?: Record<string, readonly string[]>;
    readonly required_file_contains_any?: Record<string, readonly (readonly string[])[]>;
  };
}

export interface CliConfig {
  readonly repo: string;
  readonly tasks: string;
  readonly out: string;
  readonly agentSource: AgentSource;
  readonly mode: Stage4Mode;
  readonly taskId: string | null;
  readonly taskIds: readonly string[];
  readonly condition: BenchmarkCondition | null;
  readonly worktreeMode: WorktreeMode;
  readonly overwrite: boolean;
  readonly yes: boolean;
  readonly ingestAfterRun: boolean | null;
  readonly allowAggregateAmbiguous: boolean;
  readonly claudeCommand: string;
  readonly claudeModel: string | null;
  readonly claudeMaxTurns: number;
  readonly claudeOutputFormat: string;
  readonly claudeExtraArgs: readonly string[];
  readonly claudeSystemPromptFile: string | null;
  readonly claudeAppendSystemPromptFile: string | null;
  readonly claudeBare: boolean;
  readonly claudeDisableTools: boolean;
  readonly claudePermissionMode: string | null;
  readonly claudeAllowedTools: readonly string[];
  readonly toolCommand: "capsule" | "handoff";
}

export interface RunDeps {
  readonly runProcess?: ProcessRunnerWithCwd;
}

export type ProcessRunnerWithCwd = (
  command: string,
  args: readonly string[],
  options?: { readonly stdin?: string; readonly cwd?: string },
) => Promise<ProcessResult>;

export interface ValidationResult {
  readonly passed: boolean;
  readonly allowedFilesOnly: boolean;
  readonly changedFiles: readonly string[];
  readonly ignoredChangedFiles: readonly string[];
  readonly disallowedChangedFiles: readonly string[];
  readonly failedChecks: readonly string[];
  readonly notes: readonly string[];
}

export interface Stage4RunRow {
  readonly taskId: string;
  readonly condition: BenchmarkCondition;
  readonly agentSource: AgentSource;
  readonly model: string | null;
  readonly sessionId: string | null;
  readonly deltaMethod: DeltaMethod;
  readonly passed: boolean;
  readonly outcome: PairOutcome | "";
  readonly actualInputTokens: number | null;
  readonly actualOutputTokens: number | null;
  readonly actualCacheCreationTokens: number | null;
  readonly actualCacheReadTokens: number | null;
  readonly actualTotalTokens: number | null;
  readonly actualCostUsd: number | null;
  readonly durationMs: number | null;
  readonly changedFiles: readonly string[];
  readonly ignoredChangedFiles: readonly string[];
  readonly disallowedChangedFiles: readonly string[];
  readonly allowedFilesOnly: boolean;
  readonly validationFailedChecks: readonly string[];
  readonly responseParseError: string | null;
  readonly notes: readonly string[];
}

export interface PairComparison {
  readonly taskId: string;
  readonly baselinePassed: boolean;
  readonly vtracePassed: boolean;
  readonly baselineTotalTokens: number | null;
  readonly vtraceTotalTokens: number | null;
  readonly actualTotalTokenReductionPct: number | null;
  readonly baselineCostUsd: number | null;
  readonly vtraceCostUsd: number | null;
  readonly actualCostReductionPct: number | null;
  readonly baselineDurationMs: number | null;
  readonly vtraceDurationMs: number | null;
  readonly outcome: PairOutcome;
  readonly bothPassedTokenReductionPct: number | null;
}

const DEFAULT_CONFIG: CliConfig = {
  repo: "/home/calvin/code/ARC",
  tasks: "benchmarks/arc_stage4_autonomous_edit/tasks.arc.stage4.json",
  out: "benchmarks/arc_stage4_autonomous_edit/results",
  agentSource: "claude",
  mode: "prepare",
  taskId: null,
  taskIds: [],
  condition: null,
  worktreeMode: "copy",
  overwrite: false,
  yes: false,
  ingestAfterRun: null,
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
  claudePermissionMode: "acceptEdits",
  claudeAllowedTools: ["Read", "Grep", "Glob", "LS", "Edit", "Write"],
  toolCommand: "handoff",
};

const DEFAULT_IGNORED_CHANGED_PATH_PREFIXES = [
  ".vtrace/",
  ".mytool/",
  ".claude/",
  ".pytest_cache/",
  "__pycache__/",
  ".vexb/",
];

const CSV_COLUMNS = [
  "task_id",
  "condition",
  "agent_source",
  "model",
  "session_id",
  "delta_method",
  "passed",
  "outcome",
  "actual_input_tokens",
  "actual_output_tokens",
  "actual_cache_creation_tokens",
  "actual_cache_read_tokens",
  "actual_total_tokens",
  "actual_cost_usd",
  "duration_ms",
  "changed_files",
  "ignored_changed_files",
  "disallowed_changed_files",
  "allowed_files_only",
  "validation_failed_checks",
  "response_parse_error",
  "notes",
];

export async function loadStage4Tasks(filePath: string): Promise<Stage4Task[]> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Stage 4 task file must contain an array.");
  }
  return parsed.map(parseTask);
}

export function worktreePath(outDir: string, taskId: string, condition: BenchmarkCondition): string {
  return path.join(outDir, "worktrees", `${taskId}.${condition}`);
}

export async function applyTaskSetup(worktree: string, task: Stage4Task): Promise<void> {
  for (const [relativePath, content] of Object.entries(task.setup?.create_files ?? {})) {
    assertSafeRelativePath(relativePath);
    const target = path.join(worktree, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export function buildPrompt(task: Stage4Task, condition: BenchmarkCondition, vtraceContext: string): string {
  const allowedFiles = task.allowed_files.map((file) => `- ${file}`).join("\n");
  const initialDocTaskInstruction = task.allowed_files.length === 1 && task.allowed_files[0] === "STAGE4_NOTES.md"
    ? "\nFor this task, write the answer only in STAGE4_NOTES.md.\nDo not update ARC documentation files, source files, tests, or markdown files other than STAGE4_NOTES.md.\n"
    : "";
  const vtraceSection = condition === "vtrace"
    ? `\n## vtrace context\n\n${vtraceContext.trim() || "(no vtrace context available)"}\n`
    : "";

  return `You are running an autonomous edit benchmark on an isolated copy of ARC.

You may edit only the allowed files listed below.

For this task, the allowed files are:
${allowedFiles}

Do not edit, create, delete, reformat, or otherwise modify any other file.
Changing any file outside the allowed list fails the benchmark.
You may inspect other files for information, but all written changes must go only into the allowed file(s).
If you cannot complete the task by editing only the allowed file(s), leave other files unchanged and explain that in the final JSON.
${initialDocTaskInstruction}

Do not change git history.
Do not install packages.
Do not access the network.
Do not run destructive commands.

Complete the requested edit, then return JSON only with this shape:
{
  "edited_files": ["repo-relative path"],
  "target_files_or_symbols_used": ["repo-relative path or symbol"],
  "success_claim": true,
  "reason": "one short sentence"
}

Task:
${task.task}

Query:
${task.query}

Allowed files:
${allowedFiles}
${vtraceSection}`;
}

export function buildClaudeArgs(config: Pick<CliConfig,
  | "claudeOutputFormat"
  | "claudeMaxTurns"
  | "claudeModel"
  | "claudeSystemPromptFile"
  | "claudeAppendSystemPromptFile"
  | "claudeBare"
  | "claudeDisableTools"
  | "claudePermissionMode"
  | "claudeAllowedTools"
  | "claudeExtraArgs"
>): string[] {
  const args = ["-p", "--output-format", config.claudeOutputFormat, "--max-turns", String(config.claudeMaxTurns)];
  if (config.claudeModel !== null) args.push("--model", config.claudeModel);
  if (config.claudeSystemPromptFile !== null) args.push("--system-prompt-file", config.claudeSystemPromptFile);
  if (config.claudeAppendSystemPromptFile !== null) args.push("--append-system-prompt-file", config.claudeAppendSystemPromptFile);
  if (config.claudeBare) args.push("--bare");
  if (config.claudeDisableTools) args.push("--tools", "");
  if (!config.claudeDisableTools && config.claudePermissionMode !== null) args.push("--permission-mode", config.claudePermissionMode);
  if (!config.claudeDisableTools && config.claudeAllowedTools.length > 0) args.push("--allowedTools", config.claudeAllowedTools.join(","));
  args.push(...config.claudeExtraArgs);
  return args;
}

export async function validateTaskRun(worktree: string, task: Stage4Task, changedFiles: readonly string[]): Promise<ValidationResult> {
  const failedChecks: string[] = [];
  const notes: string[] = [];
  const allowed = new Set(task.allowed_files.map(normalizePath));
  const normalizedChanged = [...changedFiles].map(normalizePath).filter((file) => file.length > 0);
  const ignoredPrefixes = ignoredChangedPathPrefixes(task);
  const ignoredChangedFiles = normalizedChanged.filter((file) => isIgnoredChangedPath(file, ignoredPrefixes));
  const relevantChangedFiles = normalizedChanged.filter((file) => !isIgnoredChangedPath(file, ignoredPrefixes));
  const disallowedChangedFiles = relevantChangedFiles.filter((file) => !allowed.has(file));
  const allowedFilesOnly = disallowedChangedFiles.length === 0;
  if (!allowedFilesOnly) {
    failedChecks.push("allowed_files_only");
  }

  for (const [relativePath, requiredStrings] of Object.entries(task.success?.required_file_contains ?? {})) {
    const text = await readFile(path.join(worktree, relativePath), "utf8").catch(() => "");
    for (const required of requiredStrings) {
      if (!text.includes(required)) {
        failedChecks.push(`required_file_contains:${relativePath}:${required}`);
      }
    }
  }

  for (const [relativePath, groups] of Object.entries(task.success?.required_file_contains_any ?? {})) {
    const text = await readFile(path.join(worktree, relativePath), "utf8").catch(() => "");
    const matched = groups.some((group) => group.every((required) => text.includes(required)));
    if (!matched) {
      failedChecks.push(`required_file_contains_any:${relativePath}`);
    }
  }

  if (normalizedChanged.length === 0) {
    notes.push("no changed files detected");
  }

  return {
    passed: failedChecks.length === 0,
    allowedFilesOnly,
    changedFiles: normalizedChanged,
    ignoredChangedFiles,
    disallowedChangedFiles,
    failedChecks,
    notes,
  };
}

export function classifyOutcome(baselinePassed: boolean, vtracePassed: boolean): PairOutcome {
  if (baselinePassed && vtracePassed) return "both_passed";
  if (!baselinePassed && vtracePassed) return "vtrace_only_passed";
  if (baselinePassed && !vtracePassed) return "baseline_only_passed";
  return "both_failed";
}

export function comparePairs(rows: readonly Stage4RunRow[]): PairComparison[] {
  const byTask = new Map<string, Map<BenchmarkCondition, Stage4RunRow>>();
  for (const row of rows) {
    const taskRows = byTask.get(row.taskId) ?? new Map<BenchmarkCondition, Stage4RunRow>();
    taskRows.set(row.condition, row);
    byTask.set(row.taskId, taskRows);
  }

  const pairs: PairComparison[] = [];
  for (const [taskId, taskRows] of byTask) {
    const baseline = taskRows.get("baseline");
    const vtrace = taskRows.get("vtrace");
    if (baseline === undefined || vtrace === undefined) continue;
    const outcome = classifyOutcome(baseline.passed, vtrace.passed);
    const tokenReduction = reductionPct(baseline.actualTotalTokens, vtrace.actualTotalTokens);
    pairs.push({
      taskId,
      baselinePassed: baseline.passed,
      vtracePassed: vtrace.passed,
      baselineTotalTokens: baseline.actualTotalTokens,
      vtraceTotalTokens: vtrace.actualTotalTokens,
      actualTotalTokenReductionPct: tokenReduction,
      baselineCostUsd: baseline.actualCostUsd,
      vtraceCostUsd: vtrace.actualCostUsd,
      actualCostReductionPct: reductionPct(baseline.actualCostUsd, vtrace.actualCostUsd),
      baselineDurationMs: baseline.durationMs,
      vtraceDurationMs: vtrace.durationMs,
      outcome,
      bothPassedTokenReductionPct: outcome === "both_passed" ? tokenReduction : null,
    });
  }
  return pairs.sort((left, right) => left.taskId.localeCompare(right.taskId));
}

export async function runPrepare(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  await ensureOutputTree(config.out);
  const tasks = await loadStage4Tasks(config.tasks);
  for (const task of tasks) {
    await writePromptsForTask(config, task, deps);
  }
  await writeFile(path.join(config.out, "arc_stage4_autonomous_edit.csv"), `${CSV_COLUMNS.join(",")}\n`);
  await writeFile(path.join(config.out, "arc_stage4_autonomous_edit.json"), `${JSON.stringify({ rows: [], pairs: [], summary: null }, null, 2)}\n`);
  await writeFile(path.join(config.out, "arc_stage4_autonomous_edit.md"), renderMarkdown([], [], summarize([], []), config));
}

export async function runOne(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  if (!config.yes) throw new Error("--mode run-one spends real Claude Code tokens; pass --yes to confirm.");
  if (config.agentSource !== "claude") throw new Error("Stage 4 currently supports --agent-source claude only.");
  if (config.taskId === null || config.condition === null) throw new Error("--mode run-one requires --task-id and --condition.");
  if (path.resolve(config.repo) === path.resolve(worktreePath(config.out, config.taskId, config.condition))) {
    throw new Error("Refusing to use source repo as isolated worktree.");
  }

  await ensureOutputTree(config.out);
  const task = findTask(await loadStage4Tasks(config.tasks), config.taskId);
  const wt = worktreePath(config.out, task.id, config.condition);
  await prepareWorktree(config, task, wt, deps);
  const promptPath = await writePromptForCondition(config, task, config.condition, deps);
  await takeSnapshot(config, task.id, config.condition, "before", deps);
  await runClaude(config, task, config.condition, wt, promptPath, deps);
  await takeSnapshot(config, task.id, config.condition, "after", deps);
  await capturePatch(config, task.id, config.condition, wt, deps);
  await validateOne(config, task, config.condition, deps);

  if (config.ingestAfterRun === true) await runIngest(config);
}

export async function runPair(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  if (config.taskId === null) throw new Error("--mode run-pair requires --task-id.");
  await runOne({ ...config, mode: "run-one", condition: "baseline", ingestAfterRun: false }, deps);
  await runOne({ ...config, mode: "run-one", condition: "vtrace", ingestAfterRun: false }, deps);
  if (config.ingestAfterRun !== false) await runIngest(config);
}

export async function runMatrix(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  if (!config.yes) throw new Error("--mode run-matrix spends real Claude Code tokens; pass --yes to confirm.");
  if (config.taskIds.length === 0) throw new Error("--mode run-matrix requires explicit --task-ids.");
  for (const taskId of config.taskIds) {
    await runPair({ ...config, mode: "run-pair", taskId, ingestAfterRun: false }, deps);
  }
  if (config.ingestAfterRun !== false) await runIngest(config);
}

export async function runValidate(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  await ensureOutputTree(config.out);
  const tasks = await loadStage4Tasks(config.tasks);
  for (const task of tasks) {
    for (const condition of ["baseline", "vtrace"] as const) {
      const wt = worktreePath(config.out, task.id, condition);
      await capturePatch(config, task.id, condition, wt, deps);
      await validateOne(config, task, condition, deps);
    }
  }
}

export async function runIngest(config: CliConfig): Promise<void> {
  await ensureOutputTree(config.out);
  const tasks = await loadStage4Tasks(config.tasks);
  const rows: Stage4RunRow[] = [];
  for (const task of tasks) {
    for (const condition of ["baseline", "vtrace"] as const) {
      const row = await ingestRun(config, task, condition);
      if (row !== null) rows.push(row);
    }
  }
  const pairs = comparePairs(rows);
  const rowsWithOutcomes = rows.map((row) => {
    const pair = pairs.find((item) => item.taskId === row.taskId);
    return { ...row, outcome: pair?.outcome ?? "" };
  });
  const summary = summarize(rowsWithOutcomes, pairs);
  await writeFile(path.join(config.out, "arc_stage4_autonomous_edit.csv"), renderCsv(rowsWithOutcomes));
  await writeFile(path.join(config.out, "arc_stage4_autonomous_edit.json"), `${JSON.stringify({ rows: rowsWithOutcomes, pairs, summary }, null, 2)}\n`);
  await writeFile(path.join(config.out, "arc_stage4_autonomous_edit.md"), renderMarkdown(rowsWithOutcomes, pairs, summary, config));
}

async function prepareWorktree(config: CliConfig, task: Stage4Task, wt: string, deps: RunDeps): Promise<void> {
  if (path.resolve(wt) === path.resolve(config.repo)) throw new Error("Refusing to mutate source ARC repo.");
  if (config.overwrite) {
    await rm(wt, { recursive: true, force: true });
  }
  try {
    await mkdir(wt, { recursive: false });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`Worktree already exists: ${wt}. Pass --overwrite to replace it.`);
    }
    throw error;
  }
  await rm(wt, { recursive: true, force: true });
  if (config.worktreeMode === "git-worktree") {
    await (deps.runProcess ?? runProcess)("git", ["-C", config.repo, "worktree", "add", "--detach", wt], {});
  } else {
    await cp(config.repo, wt, { recursive: true, force: true, verbatimSymlinks: true });
  }
  await applyTaskSetup(wt, task);
}

async function writePromptsForTask(config: CliConfig, task: Stage4Task, deps: RunDeps): Promise<void> {
  await writePromptForCondition(config, task, "baseline", deps);
  await writePromptForCondition(config, task, "vtrace", deps);
}

async function writePromptForCondition(config: CliConfig, task: Stage4Task, condition: BenchmarkCondition, deps: RunDeps): Promise<string> {
  const context = condition === "vtrace" ? await collectVtraceContext(config, task, deps) : "";
  const prompt = buildPrompt(task, condition, context);
  const promptPath = path.join(config.out, "prompts", `${task.id}.${condition}.md`);
  await mkdir(path.dirname(promptPath), { recursive: true });
  await writeFile(promptPath, prompt);
  return promptPath;
}

async function collectVtraceContext(config: CliConfig, task: Stage4Task, deps: RunDeps): Promise<string> {
  const result = await (deps.runProcess ?? runProcess)(path.resolve("bin/vtrace"), [config.toolCommand, config.repo, task.query]);
  if (result.exitCode !== 0) {
    return JSON.stringify({ error: "vtrace failed", stderr: result.stderr.trim(), stdoutPreview: result.stdout.slice(0, 1000) }, null, 2);
  }
  return result.stdout.trim();
}

async function runClaude(config: CliConfig, task: Stage4Task, condition: BenchmarkCondition, wt: string, promptPath: string, deps: RunDeps): Promise<void> {
  if (path.resolve(wt) === path.resolve(config.repo)) throw new Error("Refusing to run Claude in source ARC repo.");
  const prompt = await readFile(promptPath, "utf8");
  const args = buildClaudeArgs(config);
  const startedAt = new Date();
  const startedMs = Date.now();
  const result = await (deps.runProcess ?? runProcess)(config.claudeCommand, args, { stdin: prompt, cwd: wt });
  const finishedAt = new Date();
  const meta = {
    taskId: task.id,
    condition,
    agentSource: config.agentSource,
    worktreePath: wt,
    command: config.claudeCommand,
    args,
    promptPath,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    exitCode: result.exitCode,
    durationMs: Date.now() - startedMs,
  };
  await writeRunArtifact(config.out, "agent_runs", `${task.id}.${condition}.stdout.json`, result.stdout);
  await writeRunArtifact(config.out, "agent_runs", `${task.id}.${condition}.stderr.txt`, result.stderr);
  await writeRunArtifact(config.out, "agent_runs", `${task.id}.${condition}.meta.json`, JSON.stringify(meta, null, 2));
  let response: unknown;
  try {
    response = extractResponseJson(result.stdout);
  } catch (error) {
    response = { parse_error: error instanceof Error ? error.message : String(error) };
  }
  await writeRunArtifact(config.out, "responses", `${task.id}.${condition}.response.json`, JSON.stringify(response, null, 2));
  if (result.exitCode !== 0) {
    throw new Error(`Claude run failed for ${task.id}.${condition}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
}

async function takeSnapshot(config: CliConfig, taskId: string, condition: BenchmarkCondition, label: "before" | "after", deps: RunDeps): Promise<void> {
  const result = await (deps.runProcess ?? runProcess)("bunx", ["ccusage", config.agentSource, "session", "--json"]);
  if (result.exitCode !== 0) throw new Error(`ccusage snapshot failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  JSON.parse(result.stdout);
  await writeRunArtifact(config.out, "snapshots", `${taskId}.${condition}.${label}.json`, result.stdout);
}

async function capturePatch(config: CliConfig, taskId: string, condition: BenchmarkCondition, wt: string, deps: RunDeps): Promise<void> {
  const runner = deps.runProcess ?? runProcess;
  const diff = await runner("git", ["-C", wt, "diff", "--", "STAGE4_NOTES.md"]);
  const stat = await runner("git", ["-C", wt, "diff", "--stat"]);
  const status = await runner("git", ["-C", wt, "status", "--short"]);
  await writeRunArtifact(config.out, "patches", `${taskId}.${condition}.diff`, diff.stdout);
  await writeRunArtifact(config.out, "patches", `${taskId}.${condition}.stat.txt`, stat.stdout);
  await writeRunArtifact(config.out, "patches", `${taskId}.${condition}.status.txt`, status.stdout);
}

async function validateOne(config: CliConfig, task: Stage4Task, condition: BenchmarkCondition, deps: RunDeps): Promise<ValidationResult> {
  const wt = worktreePath(config.out, task.id, condition);
  const statusPath = path.join(config.out, "patches", `${task.id}.${condition}.status.txt`);
  const status = await readFile(statusPath, "utf8").catch(async () => {
    const result = await (deps.runProcess ?? runProcess)("git", ["-C", wt, "status", "--short"]);
    return result.stdout;
  });
  const changedFiles = parseGitStatusChangedFiles(status);
  const validation = await validateTaskRun(wt, task, changedFiles);
  await writeRunArtifact(config.out, "validation", `${task.id}.${condition}.validation.json`, JSON.stringify(validation, null, 2));
  return validation;
}

async function ingestRun(config: CliConfig, task: Stage4Task, condition: BenchmarkCondition): Promise<Stage4RunRow | null> {
  const before = await readJsonIfExists(path.join(config.out, "snapshots", `${task.id}.${condition}.before.json`));
  const after = await readJsonIfExists(path.join(config.out, "snapshots", `${task.id}.${condition}.after.json`));
  const validation = await readJsonIfExists(path.join(config.out, "validation", `${task.id}.${condition}.validation.json`));
  if (before === null || after === null || !isRecord(validation)) return null;
  let delta: DeltaResult;
  try {
    delta = computeCcusageDelta(before, after, { allowAggregateAmbiguous: config.allowAggregateAmbiguous });
  } catch (error) {
    delta = unavailableDelta(error instanceof Error ? error.message : String(error));
  }
  const meta = await readJsonIfExists(path.join(config.out, "agent_runs", `${task.id}.${condition}.meta.json`));
  const response = await readJsonIfExists(path.join(config.out, "responses", `${task.id}.${condition}.response.json`));
  const notes = [...delta.notes];
  const parseError = isRecord(response) && typeof response.parse_error === "string" ? response.parse_error : null;
  const durationMs = isRecord(meta) && typeof meta.durationMs === "number" ? meta.durationMs : null;
  return {
    taskId: task.id,
    condition,
    agentSource: config.agentSource,
    model: delta.model,
    sessionId: delta.sessionId,
    deltaMethod: delta.method,
    passed: validation.passed === true,
    outcome: "",
    actualInputTokens: delta.method === "unavailable" ? null : delta.inputTokens,
    actualOutputTokens: delta.method === "unavailable" ? null : delta.outputTokens,
    actualCacheCreationTokens: delta.method === "unavailable" ? null : delta.cacheCreationTokens,
    actualCacheReadTokens: delta.method === "unavailable" ? null : delta.cacheReadTokens,
    actualTotalTokens: delta.method === "unavailable" ? null : delta.totalTokens,
    actualCostUsd: delta.method === "unavailable" ? null : delta.costUsd,
    durationMs,
    changedFiles: Array.isArray(validation.changedFiles) ? validation.changedFiles.filter(isString) : [],
    ignoredChangedFiles: Array.isArray(validation.ignoredChangedFiles) ? validation.ignoredChangedFiles.filter(isString) : [],
    disallowedChangedFiles: Array.isArray(validation.disallowedChangedFiles) ? validation.disallowedChangedFiles.filter(isString) : [],
    allowedFilesOnly: validation.allowedFilesOnly === true,
    validationFailedChecks: Array.isArray(validation.failedChecks) ? validation.failedChecks.filter(isString) : [],
    responseParseError: parseError,
    notes,
  };
}

function summarize(rows: readonly Stage4RunRow[], pairs: readonly PairComparison[]) {
  return {
    completedRuns: rows.length,
    pairedTasks: pairs.length,
    baselinePassCount: rows.filter((row) => row.condition === "baseline" && row.passed).length,
    vtracePassCount: rows.filter((row) => row.condition === "vtrace" && row.passed).length,
    bothPassed: pairs.filter((pair) => pair.outcome === "both_passed").length,
    vtraceOnlyPassed: pairs.filter((pair) => pair.outcome === "vtrace_only_passed").length,
    baselineOnlyPassed: pairs.filter((pair) => pair.outcome === "baseline_only_passed").length,
    bothFailed: pairs.filter((pair) => pair.outcome === "both_failed").length,
    meanTokenReductionBothPassed: mean(pairs.map((pair) => pair.bothPassedTokenReductionPct).filter(isNumber)),
    meanTokenReductionAllPairs: mean(pairs.map((pair) => pair.actualTotalTokenReductionPct).filter(isNumber)),
    meanCostReduction: mean(pairs.map((pair) => pair.actualCostReductionPct).filter(isNumber)),
    changedFilesSafetyFailures: rows.filter((row) => !row.allowedFilesOnly).length,
    ambiguousCcusageDeltas: rows.filter((row) => row.notes.some((note) => note.includes("multiple new sessions"))).length,
    invalidResponses: rows.filter((row) => row.responseParseError !== null).length,
  };
}

function renderMarkdown(rows: readonly Stage4RunRow[], pairs: readonly PairComparison[], summary: ReturnType<typeof summarize>, config: CliConfig): string {
  return `${[
    "# ARC Stage 4 Autonomous Edit Benchmark",
    "",
    "## Scope",
    "",
    "Stage 4 measures small autonomous edit tasks on isolated ARC copies/worktrees. It does not measure SWE-bench performance or broad patch-generation ability.",
    "",
    "## Summary",
    "",
    `- Completed runs: ${summary.completedRuns}`,
    `- Paired tasks: ${summary.pairedTasks}`,
    `- Baseline pass count: ${summary.baselinePassCount}`,
    `- Vtrace pass count: ${summary.vtracePassCount}`,
    `- both/vtrace-only/baseline-only/failed: ${summary.bothPassed}/${summary.vtraceOnlyPassed}/${summary.baselineOnlyPassed}/${summary.bothFailed}`,
    `- Mean token reduction for both-passed pairs: ${formatPct(summary.meanTokenReductionBothPassed) || "n/a"}`,
    `- Mean token reduction across all pairs: ${formatPct(summary.meanTokenReductionAllPairs) || "n/a"}`,
    `- Mean cost reduction: ${formatPct(summary.meanCostReduction) || "n/a"}`,
    `- Changed-files safety failures: ${summary.changedFilesSafetyFailures}`,
    `- Ambiguous ccusage deltas: ${summary.ambiguousCcusageDeltas}`,
    `- Invalid responses: ${summary.invalidResponses}`,
    "",
    "## Pass/fail matrix",
    "",
    renderPassFailTable(pairs),
    "",
    "## Token/cost comparison",
    "",
    renderTokenTable(pairs),
    "",
    "## Per-task paired table",
    "",
    renderPairTable(pairs),
    "",
    "## Validation failures",
    "",
    renderValidationFailures(rows),
    "",
    "## Changed-file safety summary",
    "",
    renderSafetySummary(rows),
    "",
    "## Interpretation",
    "",
    "Token reductions are meaningful only alongside pass/fail. A vtrace-only pass is a qualitative win even if tokens are higher; token reduction is quality-preserving only when both conditions pass.",
    "",
    "## Next step",
    "",
    "Stage 4B can add small unit-test additions, docstring/comment updates near real target code, low-risk refactors on temp worktrees, and actual bug-fix tasks with test commands.",
    "",
    "## Metadata",
    "",
    `- Repo source: ${config.repo}`,
    `- Worktree mode: ${config.worktreeMode}`,
    `- Agent source: ${config.agentSource}`,
    "",
  ].join("\n")}\n`;
}

function renderCsv(rows: readonly Stage4RunRow[]): string {
  return `${[
    CSV_COLUMNS.join(","),
    ...rows.map((row) => [
      row.taskId,
      row.condition,
      row.agentSource,
      row.model,
      row.sessionId,
      row.deltaMethod,
      row.passed,
      row.outcome,
      row.actualInputTokens,
      row.actualOutputTokens,
      row.actualCacheCreationTokens,
      row.actualCacheReadTokens,
      row.actualTotalTokens,
      row.actualCostUsd,
      row.durationMs,
      row.changedFiles.join("; "),
      row.ignoredChangedFiles.join("; "),
      row.disallowedChangedFiles.join("; "),
      row.allowedFilesOnly,
      row.validationFailedChecks.join("; "),
      row.responseParseError,
      row.notes.join("; "),
    ].map(csvEscape).join(",")),
  ].join("\n")}\n`;
}

function renderPassFailTable(pairs: readonly PairComparison[]): string {
  if (pairs.length === 0) return "No paired runs have been ingested yet.";
  return [
    "| task | baseline passed | vtrace passed | outcome |",
    "| --- | --- | --- | --- |",
    ...pairs.map((pair) => `| ${pair.taskId} | ${yesNo(pair.baselinePassed)} | ${yesNo(pair.vtracePassed)} | ${pair.outcome} |`),
  ].join("\n");
}

function renderTokenTable(pairs: readonly PairComparison[]): string {
  if (pairs.length === 0) return "No paired runs have been ingested yet.";
  return [
    "| task | baseline tokens | vtrace tokens | token reduction | baseline cost | vtrace cost | cost reduction |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...pairs.map((pair) => `| ${pair.taskId} | ${pair.baselineTotalTokens ?? ""} | ${pair.vtraceTotalTokens ?? ""} | ${formatPct(pair.actualTotalTokenReductionPct)} | ${formatUsd(pair.baselineCostUsd)} | ${formatUsd(pair.vtraceCostUsd)} | ${formatPct(pair.actualCostReductionPct)} |`),
  ].join("\n");
}

function renderPairTable(pairs: readonly PairComparison[]): string {
  if (pairs.length === 0) return "No paired runs have been ingested yet.";
  return [
    "| task | outcome | both-passed token reduction | baseline duration ms | vtrace duration ms |",
    "| --- | --- | ---: | ---: | ---: |",
    ...pairs.map((pair) => `| ${pair.taskId} | ${pair.outcome} | ${formatPct(pair.bothPassedTokenReductionPct)} | ${pair.baselineDurationMs ?? ""} | ${pair.vtraceDurationMs ?? ""} |`),
  ].join("\n");
}

function renderValidationFailures(rows: readonly Stage4RunRow[]): string {
  const failures = rows.filter((row) => row.validationFailedChecks.length > 0);
  if (failures.length === 0) return "No validation failures.";
  return failures.map((row) => {
    const details = row.disallowedChangedFiles.length > 0 ? `; disallowed: ${row.disallowedChangedFiles.join(", ")}` : "";
    return `- ${row.taskId}.${row.condition}: ${row.validationFailedChecks.join("; ")}${details}`;
  }).join("\n");
}

function renderSafetySummary(rows: readonly Stage4RunRow[]): string {
  if (rows.length === 0) return "No completed runs.";
  const failures = rows.filter((row) => !row.allowedFilesOnly);
  const ignoredRows = rows.filter((row) => row.ignoredChangedFiles.length > 0);
  const lines: string[] = [];
  if (failures.length === 0) {
    lines.push("All completed runs changed only allowed files, apart from ignored benchmark/tool state paths.");
  } else {
    lines.push("Disallowed changed files:");
    lines.push(...failures.map((row) => `- ${row.taskId}.${row.condition}: ${row.disallowedChangedFiles.join(", ")}`));
  }
  if (ignoredRows.length > 0) {
    lines.push("");
    lines.push("Ignored changed files:");
    lines.push(...ignoredRows.map((row) => `- ${row.taskId}.${row.condition}: ${row.ignoredChangedFiles.join(", ")}`));
  }
  return lines.join("\n");
}

function parseGitStatusChangedFiles(status: string): string[] {
  const files: string[] = [];
  for (const line of status.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const text = line.slice(3).trim();
    const renamed = text.includes(" -> ") ? text.split(" -> ").at(-1)! : text;
    files.push(normalizePath(renamed));
  }
  return [...new Set(files)].sort();
}

function ignoredChangedPathPrefixes(task: Stage4Task): string[] {
  return [...DEFAULT_IGNORED_CHANGED_PATH_PREFIXES, ...(task.ignored_changed_paths ?? [])]
    .map(normalizePath)
    .filter((prefix) => prefix.length > 0)
    .map((prefix) => prefix.endsWith("/") ? prefix : `${prefix}/`);
}

function isIgnoredChangedPath(file: string, prefixes: readonly string[]): boolean {
  const normalized = normalizePath(file);
  return prefixes.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function extractResponseJson(stdout: string): unknown {
  const direct = parseJson(stdout);
  if (direct !== null) return direct;
  const match = /```(?:json)?\s*([\s\S]*?)```/i.exec(stdout);
  if (match !== null) {
    const fenced = parseJson(match[1]!);
    if (fenced !== null) return fenced;
  }
  throw new Error("Could not parse Claude response JSON.");
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function unavailableDelta(note: string): DeltaResult {
  return {
    method: "unavailable",
    sessionId: null,
    model: null,
    ambiguous: false,
    notes: [note],
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

async function writeRunArtifact(outDir: string, subdir: string, filename: string, content: string): Promise<void> {
  const filePath = path.join(outDir, subdir, filename);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content.endsWith("\n") ? content : `${content}\n`);
}

async function ensureOutputTree(outDir: string): Promise<void> {
  for (const subdir of ["worktrees", "prompts", "snapshots", "agent_runs", "responses", "patches", "validation"]) {
    await mkdir(path.join(outDir, subdir), { recursive: true });
  }
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function runProcess(command: string, args: readonly string[], options: { readonly stdin?: string; readonly cwd?: string } = {}): Promise<ProcessResult> {
  return await new Promise((resolve) => {
    const proc = spawn(command, [...args], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on("error", (error) => resolve({ exitCode: 1, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: `${Buffer.concat(stderrChunks).toString("utf8")}${error.message}` }));
    proc.on("close", (code) => resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: Buffer.concat(stderrChunks).toString("utf8") }));
    proc.stdin.end(options.stdin ?? "");
  });
}

function parseTask(value: unknown): Stage4Task {
  if (!isRecord(value) || !isString(value.id) || !isString(value.category) || !isString(value.task) || !isString(value.query) || !Array.isArray(value.allowed_files)) {
    throw new Error("Invalid Stage 4 task entry.");
  }
  return value as unknown as Stage4Task;
}

function findTask(tasks: readonly Stage4Task[], taskId: string): Stage4Task {
  const task = tasks.find((item) => item.id === taskId);
  if (task === undefined) throw new Error(`Unknown task id: ${taskId}`);
  return task;
}

function assertSafeRelativePath(value: string): void {
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    throw new Error(`Unsafe relative path: ${value}`);
  }
}

function reductionPct(baseline: number | null, vtrace: number | null): number | null {
  if (baseline === null || vtrace === null || baseline <= 0) return null;
  return 100 * (baseline - vtrace) / baseline;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function formatPct(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "" : `${value.toFixed(2)}%`;
}

function formatUsd(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "" : value.toFixed(4);
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseArgs(argv: readonly string[]): CliConfig {
  const config = { ...DEFAULT_CONFIG };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case "--repo": config.repo = requireValue(argv, ++index, arg); break;
      case "--tasks": config.tasks = requireValue(argv, ++index, arg); break;
      case "--out": config.out = requireValue(argv, ++index, arg); break;
      case "--agent-source": {
        const value = requireValue(argv, ++index, arg);
        if (value !== "claude") throw new Error("--agent-source currently supports claude only.");
        config.agentSource = value;
        break;
      }
      case "--mode": {
        const value = requireValue(argv, ++index, arg);
        if (!["prepare", "run-one", "run-pair", "run-matrix", "ingest", "validate"].includes(value)) throw new Error("Invalid --mode.");
        config.mode = value as Stage4Mode;
        break;
      }
      case "--task-id": config.taskId = requireValue(argv, ++index, arg); break;
      case "--task-ids": config.taskIds = requireValue(argv, ++index, arg).split(",").map((value) => value.trim()).filter(Boolean); break;
      case "--condition": {
        const value = requireValue(argv, ++index, arg);
        if (value !== "baseline" && value !== "vtrace") throw new Error("--condition must be baseline or vtrace.");
        config.condition = value;
        break;
      }
      case "--worktree-mode": {
        const value = requireValue(argv, ++index, arg);
        if (value !== "copy" && value !== "git-worktree") throw new Error("--worktree-mode must be copy or git-worktree.");
        config.worktreeMode = value;
        break;
      }
      case "--overwrite": config.overwrite = true; break;
      case "--yes": config.yes = true; break;
      case "--ingest-after-run": config.ingestAfterRun = true; break;
      case "--no-ingest-after-run": config.ingestAfterRun = false; break;
      case "--allow-aggregate-ambiguous": config.allowAggregateAmbiguous = true; break;
      case "--claude-command": config.claudeCommand = requireValue(argv, ++index, arg); break;
      case "--claude-model": config.claudeModel = requireValue(argv, ++index, arg); break;
      case "--claude-max-turns": config.claudeMaxTurns = parsePositiveInt(requireValue(argv, ++index, arg), arg); break;
      case "--claude-output-format": config.claudeOutputFormat = requireValue(argv, ++index, arg); break;
      case "--claude-extra-arg": config.claudeExtraArgs = [...config.claudeExtraArgs, requireValue(argv, ++index, arg)]; break;
      case "--claude-system-prompt-file": config.claudeSystemPromptFile = requireValue(argv, ++index, arg); break;
      case "--claude-append-system-prompt-file": config.claudeAppendSystemPromptFile = requireValue(argv, ++index, arg); break;
      case "--claude-bare": config.claudeBare = true; break;
      case "--claude-disable-tools": config.claudeDisableTools = true; break;
      case "--claude-permission-mode": config.claudePermissionMode = requireValue(argv, ++index, arg); break;
      case "--no-claude-permission-mode": config.claudePermissionMode = null; break;
      case "--claude-allowed-tool": config.claudeAllowedTools = [...config.claudeAllowedTools, requireValue(argv, ++index, arg)]; break;
      case "--claude-allowed-tools": config.claudeAllowedTools = requireValue(argv, ++index, arg).split(",").map((value) => value.trim()).filter(Boolean); break;
      case "--tool-command": {
        const value = requireValue(argv, ++index, arg);
        if (value !== "capsule" && value !== "handoff") throw new Error("--tool-command must be capsule or handoff.");
        config.toolCommand = value;
        break;
      }
      case "--help":
      case "-h":
        printUsageAndExit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return {
    ...config,
    repo: path.resolve(config.repo),
    tasks: path.resolve(config.tasks),
    out: path.resolve(config.out),
    claudeSystemPromptFile: config.claudeSystemPromptFile === null ? null : path.resolve(config.claudeSystemPromptFile),
    claudeAppendSystemPromptFile: config.claudeAppendSystemPromptFile === null ? null : path.resolve(config.claudeAppendSystemPromptFile),
  };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer.`);
  return parsed;
}

function printUsageAndExit(exitCode: number): never {
  process.stdout.write("Usage: bun benchmarks/arc_stage4_autonomous_edit/run_arc_stage4_autonomous_edit.ts --repo /home/calvin/code/ARC --tasks benchmarks/arc_stage4_autonomous_edit/tasks.arc.stage4.json --out benchmarks/arc_stage4_autonomous_edit/results --agent-source claude --mode run-pair --task-id doc_find_arkane_input --yes\n");
  process.exit(exitCode);
}

async function main(config: CliConfig): Promise<void> {
  switch (config.mode) {
    case "prepare": await runPrepare(config); break;
    case "run-one": await runOne(config); break;
    case "run-pair": await runPair(config); break;
    case "run-matrix": await runMatrix(config); break;
    case "ingest": await runIngest(config); break;
    case "validate": await runValidate(config); break;
  }
}

if (import.meta.main) {
  try {
    await main(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
