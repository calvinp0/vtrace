import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildSearchTerms,
  estimateTokens,
  extractSnippetRanges,
  loadExpectedTargets,
  loadTasks,
  parseVtraceOutput,
  stableDeduplicateFiles,
  type ArcStage2Task,
  type ExpectedTarget,
  type ExpectedTargetsByTask,
} from "../arc_stage2_orientation/run_arc_stage2_orientation";

export type AgentSource = "claude" | "codex";
export type BenchmarkCondition = "baseline" | "vtrace";
export type BenchmarkMode = "prepare" | "snapshot" | "ingest" | "run-one" | "run-pair" | "run-matrix";
export type SnapshotLabel = "before" | "after";
export type DeltaMethod = "new_session" | "aggregate_difference" | "unavailable";
export type ResponseQuality = "strong" | "acceptable" | "weak" | "missing" | "invalid";

export interface CliConfig {
  readonly repo: string;
  readonly tasks: string;
  readonly expected: string;
  readonly out: string;
  readonly agentSource: AgentSource;
  readonly mode: BenchmarkMode;
  readonly snapshotLabel: SnapshotLabel | null;
  readonly taskId: string | null;
  readonly taskIds: readonly string[];
  readonly condition: BenchmarkCondition | null;
  readonly allowAggregateAmbiguous: boolean;
  readonly allowMissingCcusage: boolean;
  readonly yes: boolean;
  readonly ingestAfterRun: boolean | null;
  readonly baselineMaxFiles: number;
  readonly snippetContextLines: number;
  readonly maxSnippetsPerFile: number;
  readonly toolCommand: "capsule" | "handoff";
  readonly claudeCommand: string;
  readonly claudeModel: string | null;
  readonly claudeMaxTurns: number;
  readonly claudeOutputFormat: string;
  readonly claudeExtraArgs: readonly string[];
  readonly claudeSystemPromptFile: string | null;
  readonly claudeAppendSystemPromptFile: string | null;
  readonly claudeBare: boolean;
  readonly claudeDisableTools: boolean;
}

export interface PromptPair {
  readonly taskId: string;
  readonly baselinePrompt: string;
  readonly vtracePrompt: string;
  readonly baselinePromptEstTokens: number;
  readonly vtracePromptEstTokens: number;
  readonly estimatedPromptReductionPct: number | null;
}

export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

export interface UsageSession extends UsageTotals {
  readonly sessionId: string | null;
  readonly model: string | null;
}

export interface ParsedCcusageSnapshot {
  readonly sessions: readonly UsageSession[];
  readonly aggregate: UsageTotals;
}

export interface DeltaResult extends UsageTotals {
  readonly method: DeltaMethod;
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly ambiguous: boolean;
  readonly notes: readonly string[];
}

export interface ScoredResponse {
  readonly quality: ResponseQuality;
  readonly qualityScore: number;
  readonly targetFile: string | null;
  readonly targetSymbol: string | null;
  readonly matchedExpectedPath: string | null;
  readonly matchedExpectedSymbol: string | null;
  readonly parseError: string | null;
}

export interface IngestRow {
  readonly taskId: string;
  readonly condition: BenchmarkCondition;
  readonly agentSource: AgentSource;
  readonly model: string | null;
  readonly sessionId: string | null;
  readonly deltaMethod: DeltaMethod;
  readonly promptEstTokens: number;
  readonly actualInputTokens: number | null;
  readonly actualOutputTokens: number | null;
  readonly actualCacheCreationTokens: number | null;
  readonly actualCacheReadTokens: number | null;
  readonly actualTotalTokens: number | null;
  readonly actualCostUsd: number | null;
  readonly responseQuality: ResponseQuality;
  readonly responseQualityScore: number;
  readonly targetFile: string | null;
  readonly targetSymbol: string | null;
  readonly matchedExpectedPath: string | null;
  readonly matchedExpectedSymbol: string | null;
  readonly parseError: string | null;
  readonly notes: readonly string[];
}

export interface PairComparison {
  readonly taskId: string;
  readonly baselineTotalTokens: number;
  readonly vtraceTotalTokens: number;
  readonly actualTotalTokenReductionPct: number | null;
  readonly baselineQuality: ResponseQuality;
  readonly vtraceQuality: ResponseQuality;
  readonly qualityPreserving: boolean;
  readonly qualityPreservingActualReductionPct: number | null;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: { readonly stdin?: string },
) => Promise<ProcessResult>;

export interface RunDeps {
  readonly runProcess?: ProcessRunner;
}

export interface ClaudeRunMeta {
  readonly taskId: string;
  readonly condition: BenchmarkCondition;
  readonly agentSource: AgentSource;
  readonly command: string;
  readonly args: readonly string[];
  readonly promptPath: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

const DEFAULT_CONFIG: CliConfig = {
  repo: "/home/calvin/code/ARC",
  tasks: "benchmarks/arc_stage2_orientation/tasks.arc.stage2.json",
  expected: "benchmarks/arc_stage2_orientation/expected.arc.stage2.json",
  out: "benchmarks/arc_stage3_agent_usage/results",
  agentSource: "claude",
  mode: "prepare",
  snapshotLabel: null,
  taskId: null,
  taskIds: [],
  condition: null,
  allowAggregateAmbiguous: false,
  allowMissingCcusage: false,
  yes: false,
  ingestAfterRun: null,
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
  claudeAppendSystemPromptFile: "benchmarks/arc_stage3_agent_usage/claude_orientation_system_prompt.md",
  claudeBare: false,
  claudeDisableTools: false,
};

const SHARED_INSTRUCTION_TEMPLATE = `You are evaluating repository orientation context.

Task:
<task text>

Query:
<query>

Use only the provided context. Do not edit files. Do not run commands. Do not ask for more context.

Return JSON only with this shape:
{
  "target_file": "repo-relative path or null",
  "target_symbol": "symbol/function/class name or null",
  "quality": "strong|acceptable|weak|missing",
  "confidence": "high|medium|low",
  "reason": "one short sentence"
}`;

const CSV_COLUMNS = [
  "task_id",
  "condition",
  "agent_source",
  "model",
  "session_id",
  "delta_method",
  "prompt_est_tokens",
  "actual_input_tokens",
  "actual_output_tokens",
  "actual_cache_creation_tokens",
  "actual_cache_read_tokens",
  "actual_total_tokens",
  "actual_cost_usd",
  "response_quality",
  "target_file",
  "target_symbol",
  "matched_expected_path",
  "matched_expected_symbol",
  "parse_error",
  "notes",
];

export function buildSharedInstruction(task: ArcStage2Task): string {
  return SHARED_INSTRUCTION_TEMPLATE
    .replace("<task text>", task.task)
    .replace("<query>", task.query);
}

export function buildPrompt(task: ArcStage2Task, condition: BenchmarkCondition, context: string): string {
  const title = condition === "baseline"
    ? "## Provided context: grep snippets"
    : "## Provided context: vtrace capsule";
  const guard = condition === "baseline"
    ? "Condition: baseline. Do not use vtrace or MCP tools."
    : "Condition: vtrace. Use the provided vtrace capsule as the complete context.";

  return `${buildSharedInstruction(task)}

${guard}

${title}

${context.trim() || "(no context provided)"}
`;
}

export function computePromptPair(task: ArcStage2Task, baselineContext: string, vtraceContext: string): PromptPair {
  const baselinePrompt = buildPrompt(task, "baseline", baselineContext);
  const vtracePrompt = buildPrompt(task, "vtrace", vtraceContext);
  const baselinePromptEstTokens = estimateTokens(baselinePrompt.length);
  const vtracePromptEstTokens = estimateTokens(vtracePrompt.length);

  return {
    taskId: task.id,
    baselinePrompt,
    vtracePrompt,
    baselinePromptEstTokens,
    vtracePromptEstTokens,
    estimatedPromptReductionPct: baselinePromptEstTokens <= 0
      ? null
      : 100 * (baselinePromptEstTokens - vtracePromptEstTokens) / baselinePromptEstTokens,
  };
}

export function buildClaudeArgs(config: Pick<CliConfig,
  | "claudeOutputFormat"
  | "claudeMaxTurns"
  | "claudeModel"
  | "claudeSystemPromptFile"
  | "claudeAppendSystemPromptFile"
  | "claudeBare"
  | "claudeDisableTools"
  | "claudeExtraArgs"
>): string[] {
  const args = [
    "-p",
    "--output-format", config.claudeOutputFormat,
    "--max-turns", String(config.claudeMaxTurns),
  ];

  if (config.claudeModel !== null) {
    args.push("--model", config.claudeModel);
  }
  if (config.claudeSystemPromptFile !== null) {
    args.push("--system-prompt-file", config.claudeSystemPromptFile);
  }
  if (config.claudeAppendSystemPromptFile !== null) {
    args.push("--append-system-prompt-file", config.claudeAppendSystemPromptFile);
  }
  if (config.claudeBare) {
    args.push("--bare");
  }
  if (config.claudeDisableTools) {
    args.push("--tools", "");
  }
  args.push(...config.claudeExtraArgs);

  return args;
}

export function extractResponseJson(stdout: string): unknown {
  const direct = parseJsonIfPossible(stdout);
  const directMatch = findBenchmarkResponseObject(direct);
  if (directMatch !== null) {
    return directMatch;
  }

  for (const fenced of extractFencedJsonBlocks(stdout)) {
    const fencedMatch = findBenchmarkResponseObject(parseJsonIfPossible(fenced));
    if (fencedMatch !== null) {
      return fencedMatch;
    }
  }

  throw new Error("Could not extract benchmark response JSON from Claude stdout.");
}

export function parseCcusageSnapshot(snapshot: unknown): ParsedCcusageSnapshot {
  const sessions = findSessionRecords(snapshot).map(parseUsageSession);
  const aggregate = findAggregateTotals(snapshot, sessions);

  if (sessions.length === 0 && !hasAnyUsageSignal(aggregate)) {
    throw new Error("Could not identify ccusage token or cost totals.");
  }

  return { sessions, aggregate };
}

export function computeCcusageDelta(
  beforeSnapshot: unknown,
  afterSnapshot: unknown,
  options: { readonly allowAggregateAmbiguous?: boolean } = {},
): DeltaResult {
  const before = parseCcusageSnapshot(beforeSnapshot);
  const after = parseCcusageSnapshot(afterSnapshot);
  const beforeIds = new Set(before.sessions.map((session) => session.sessionId).filter(isString));
  const afterSessionsWithIds = after.sessions.filter((session) => session.sessionId !== null);
  const newSessions = afterSessionsWithIds.filter((session) => !beforeIds.has(session.sessionId!));
  const notes: string[] = [];

  if (newSessions.length === 1) {
    return makeDeltaResult("new_session", newSessions[0]!, false, notes);
  }

  if (newSessions.length > 1) {
    notes.push(`multiple new sessions found: ${newSessions.length}`);
    if (options.allowAggregateAmbiguous !== true) {
      return makeUnavailableDelta(true, notes);
    }
  }

  const aggregate = subtractTotals(after.aggregate, before.aggregate);
  if (!hasAnyUsageSignal(aggregate)) {
    notes.push("aggregate after-minus-before totals were empty");
    return makeUnavailableDelta(newSessions.length > 1, notes);
  }

  return {
    method: "aggregate_difference",
    sessionId: null,
    model: dominantModel(after.sessions),
    ambiguous: newSessions.length > 1,
    notes,
    ...aggregate,
  };
}

export function scoreResponseJson(responseJson: unknown, expectation: ExpectedTarget | undefined): ScoredResponse {
  if (!isRecord(responseJson)) {
    return makeScoredResponse("invalid", null, null, null, null, "response JSON must be an object");
  }

  const targetFile = nullableString(responseJson.target_file);
  const targetSymbol = nullableString(responseJson.target_symbol);

  if (targetFile === null && targetSymbol === null) {
    return makeScoredResponse("missing", null, null, null, null, null);
  }

  if (expectation === undefined) {
    return makeScoredResponse("weak", targetFile, targetSymbol, null, null, null);
  }

  const directPath = firstMatch(expectation.expected_paths, (expectedPath) => directlyMatchesPath(targetFile, expectedPath));
  const directSymbol = firstMatch(expectation.expected_symbols, (expectedSymbol) => directlyMatchesSymbol(targetSymbol, expectedSymbol));

  if (directPath !== null || directSymbol !== null) {
    return makeScoredResponse("strong", targetFile, targetSymbol, directPath, directSymbol, null);
  }

  const broadPath = firstMatch(expectation.expected_paths, (expectedPath) => broadlyMatchesPath(targetFile, expectedPath));
  const broadSymbol = firstMatch(expectation.expected_symbols, (expectedSymbol) => broadlyMatchesSymbol(targetSymbol, expectedSymbol));

  if (broadPath !== null || broadSymbol !== null) {
    return makeScoredResponse("acceptable", targetFile, targetSymbol, broadPath, broadSymbol, null);
  }

  return makeScoredResponse("weak", targetFile, targetSymbol, null, null, null);
}

export function qualityScore(label: ResponseQuality): number {
  switch (label) {
    case "invalid":
    case "missing":
      return 0;
    case "weak":
      return 1;
    case "acceptable":
      return 2;
    case "strong":
      return 3;
  }
}

export function comparePairs(rows: readonly IngestRow[]): PairComparison[] {
  const rowsByTask = new Map<string, Map<BenchmarkCondition, IngestRow>>();

  for (const row of rows) {
    const taskRows = rowsByTask.get(row.taskId) ?? new Map<BenchmarkCondition, IngestRow>();
    taskRows.set(row.condition, row);
    rowsByTask.set(row.taskId, taskRows);
  }

  const comparisons: PairComparison[] = [];

  for (const [taskId, taskRows] of rowsByTask) {
    const baseline = taskRows.get("baseline");
    const vtrace = taskRows.get("vtrace");

    if (
      baseline === undefined
      || vtrace === undefined
      || baseline.actualTotalTokens === null
      || vtrace.actualTotalTokens === null
    ) {
      continue;
    }

    const actualTotalTokenReductionPct = baseline.actualTotalTokens <= 0
      ? null
      : 100 * (baseline.actualTotalTokens - vtrace.actualTotalTokens) / baseline.actualTotalTokens;
    const qualityPreserving = vtrace.responseQualityScore >= baseline.responseQualityScore;

    comparisons.push({
      taskId,
      baselineTotalTokens: baseline.actualTotalTokens,
      vtraceTotalTokens: vtrace.actualTotalTokens,
      actualTotalTokenReductionPct,
      baselineQuality: baseline.responseQuality,
      vtraceQuality: vtrace.responseQuality,
      qualityPreserving,
      qualityPreservingActualReductionPct: qualityPreserving ? actualTotalTokenReductionPct : null,
    });
  }

  return comparisons.sort((left, right) => left.taskId.localeCompare(right.taskId));
}

export function renderPrepareMarkdown(
  promptPairs: readonly PromptPair[],
  metadata: Record<string, unknown>,
): string {
  return `${[
    "# ARC Stage 3 Agent Usage Report",
    "",
    "## Prepare summary",
    "",
    `Prompts generated: ${promptPairs.length * 2}`,
    "",
    "No actual ccusage claims are made yet. Run controlled agent sessions, save responses, then ingest before/after snapshots.",
    "",
    "## Estimated prompt token comparison",
    "",
    "| task | baseline est tokens | vtrace est tokens | estimated reduction |",
    "| --- | ---: | ---: | ---: |",
    ...promptPairs.map((pair) => [
      pair.taskId,
      pair.baselinePromptEstTokens,
      pair.vtracePromptEstTokens,
      formatPct(pair.estimatedPromptReductionPct),
    ].join(" | ")).map((line) => `| ${line} |`),
    "",
    "## Scope",
    "",
    "These token counts come from ccusage local CLI usage data. They measure controlled orientation sessions, not full autonomous patch-solving.",
    "",
    "## Metadata",
    "",
    `- Repo: ${String(metadata.arcRepoPath ?? "")}`,
    `- Agent source: ${String(metadata.agentSource ?? "")}`,
    `- Mode: prepare`,
    "",
  ].join("\n")}\n`;
}

export function summarizeIngestRows(rows: readonly IngestRow[], pairs: readonly PairComparison[]) {
  const reductions = pairs
    .map((pair) => pair.actualTotalTokenReductionPct)
    .filter((value): value is number => value !== null);
  const preservingReductions = pairs
    .map((pair) => pair.qualityPreservingActualReductionPct)
    .filter((value): value is number => value !== null);

  return {
    completedRuns: rows.length,
    pairedTasks: pairs.length,
    meanActualTotalTokenReductionPct: mean(reductions),
    medianActualTotalTokenReductionPct: median(reductions),
    meanQualityPreservingActualReductionPct: mean(preservingReductions),
    vtraceQualitySameCount: pairs.filter((pair) => qualityScore(pair.vtraceQuality) === qualityScore(pair.baselineQuality)).length,
    vtraceQualityBetterCount: pairs.filter((pair) => qualityScore(pair.vtraceQuality) > qualityScore(pair.baselineQuality)).length,
    vtraceQualityWorseCount: pairs.filter((pair) => qualityScore(pair.vtraceQuality) < qualityScore(pair.baselineQuality)).length,
    ambiguousCcusageDeltaCount: rows.filter((row) => row.notes.some((note) => note.includes("multiple new sessions"))).length,
    invalidResponseCount: rows.filter((row) => row.responseQuality === "invalid").length,
  };
}

export function renderIngestMarkdown(
  rows: readonly IngestRow[],
  pairs: readonly PairComparison[],
  summary: ReturnType<typeof summarizeIngestRows>,
  metadata: Record<string, unknown>,
): string {
  return `${[
    "# ARC Stage 3 Agent Usage Report",
    "",
    "## Scope",
    "",
    "These token counts come from ccusage local CLI usage data. They measure controlled orientation sessions, not full autonomous patch-solving.",
    "",
    "## Summary",
    "",
    `- Completed task/condition runs: ${summary.completedRuns}`,
    `- Paired tasks: ${summary.pairedTasks}`,
    `- Mean actual total token reduction: ${formatPct(summary.meanActualTotalTokenReductionPct) || "n/a"}`,
    `- Median actual total token reduction: ${formatPct(summary.medianActualTotalTokenReductionPct) || "n/a"}`,
    `- Mean quality-preserving actual reduction: ${formatPct(summary.meanQualityPreservingActualReductionPct) || "n/a"}`,
    `- vtrace quality same/better/worse: ${summary.vtraceQualitySameCount}/${summary.vtraceQualityBetterCount}/${summary.vtraceQualityWorseCount}`,
    `- Ambiguous ccusage delta count: ${summary.ambiguousCcusageDeltaCount}`,
    `- Invalid response count: ${summary.invalidResponseCount}`,
    "",
    "## Per-task paired table",
    "",
    renderPairTable(pairs),
    "",
    "## Metadata",
    "",
    `- Repo: ${String(metadata.arcRepoPath ?? "")}`,
    `- Agent source: ${String(metadata.agentSource ?? "")}`,
    `- Mode: ingest`,
    "",
  ].join("\n")}\n`;
}

export async function runPrepare(config: CliConfig): Promise<void> {
  const tasks = await loadTasks(config.tasks);
  const expected = await loadExpectedTargets(config.expected);
  const promptPairs: PromptPair[] = [];
  const promptsDir = path.join(config.out, "prompts");

  await mkdir(promptsDir, { recursive: true });
  await mkdir(path.join(config.out, "snapshots"), { recursive: true });
  await mkdir(path.join(config.out, "responses"), { recursive: true });

  for (const task of tasks) {
    const [baselineContext, vtraceContext] = await Promise.all([
      collectBaselineContext(config.repo, task.query, config),
      collectVtraceContext(config.repo, task.query, config.toolCommand),
    ]);
    const pair = computePromptPair(task, baselineContext, vtraceContext);
    promptPairs.push(pair);

    await writeFile(path.join(promptsDir, `${task.id}.baseline.md`), pair.baselinePrompt);
    await writeFile(path.join(promptsDir, `${task.id}.vtrace.md`), pair.vtracePrompt);
  }

  const metadata = makeMetadata(config);
  const manifest = {
    metadata,
    tasks,
    expected,
    prompts: promptPairs.map((pair) => ({
      task_id: pair.taskId,
      baseline_prompt: `prompts/${pair.taskId}.baseline.md`,
      vtrace_prompt: `prompts/${pair.taskId}.vtrace.md`,
      baseline_prompt_est_tokens: pair.baselinePromptEstTokens,
      vtrace_prompt_est_tokens: pair.vtracePromptEstTokens,
      estimated_prompt_reduction_pct: pair.estimatedPromptReductionPct,
    })),
  };

  await writeFile(path.join(config.out, "arc_stage3_agent_usage_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(config.out, "arc_stage3_agent_usage.csv"), `${CSV_COLUMNS.join(",")}\n`);
  await writeFile(path.join(config.out, "arc_stage3_agent_usage.json"), `${JSON.stringify({ metadata, prompts: manifest.prompts, rows: [], pairs: [], summary: null }, null, 2)}\n`);
  await writeFile(path.join(config.out, "arc_stage3_agent_usage.md"), renderPrepareMarkdown(promptPairs, metadata));
}

export async function runSnapshot(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  if (config.taskId === null || config.condition === null || config.snapshotLabel === null) {
    throw new Error("--mode snapshot requires --task-id, --condition, and --snapshot-label.");
  }

  const result = await (deps.runProcess ?? runProcess)("bunx", ["ccusage", config.agentSource, "session", "--json"]);
  if (result.exitCode !== 0) {
    throw new Error(`ccusage snapshot failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }

  const snapshotsDir = path.join(config.out, "snapshots");
  await mkdir(snapshotsDir, { recursive: true });
  JSON.parse(result.stdout);
  await writeFile(
    path.join(snapshotsDir, `${config.taskId}.${config.condition}.${config.snapshotLabel}.json`),
    result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`,
  );
}

export async function runOne(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  if (config.agentSource !== "claude") {
    throw new Error("--mode run-one currently requires --agent-source claude.");
  }
  if (config.taskId === null || config.condition === null) {
    throw new Error("--mode run-one requires --task-id and --condition.");
  }

  await ensurePromptExists(config, config.taskId, config.condition);
  await takeSnapshotForRun(config, config.taskId, config.condition, "before", deps);
  await runPreparedClaudePrompt(config, config.taskId, config.condition, deps);
  await takeSnapshotForRun(config, config.taskId, config.condition, "after", deps);
  await updateAutomatedRunManifest(config, config.taskId, config.condition);

  if (shouldIngestAfterRun(config, false)) {
    await runIngest(config);
  }
}

export async function runPair(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  if (config.taskId === null) {
    throw new Error("--mode run-pair requires --task-id.");
  }

  await runOne({ ...config, mode: "run-one", condition: "baseline", ingestAfterRun: false }, deps);
  await runOne({ ...config, mode: "run-one", condition: "vtrace", ingestAfterRun: false }, deps);

  if (shouldIngestAfterRun(config, true)) {
    await runIngest(config);
  }
}

export async function runMatrix(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  if (!config.yes) {
    throw new Error("--mode run-matrix spends real Claude Code tokens; pass --yes to confirm.");
  }
  if (config.taskIds.length === 0) {
    throw new Error("--mode run-matrix requires explicit --task-ids.");
  }

  for (const taskId of config.taskIds) {
    await runOne({ ...config, mode: "run-one", taskId, condition: "baseline", ingestAfterRun: false }, deps);
    await runOne({ ...config, mode: "run-one", taskId, condition: "vtrace", ingestAfterRun: false }, deps);
  }

  if (shouldIngestAfterRun(config, true)) {
    await runIngest(config);
  }
}

export async function runIngest(config: CliConfig): Promise<void> {
  const tasks = await loadTasks(config.tasks);
  const expectedTargets = await loadExpectedTargets(config.expected);
  const manifest = await loadManifest(config.out);
  const rows: IngestRow[] = [];

  for (const task of tasks) {
    for (const condition of ["baseline", "vtrace"] as const) {
      const row = await ingestRun(config, task, condition, expectedTargets[task.id], manifest);
      if (row !== null) {
        rows.push(row);
      }
    }
  }

  const pairs = comparePairs(rows);
  const summary = summarizeIngestRows(rows, pairs);
  const metadata = makeMetadata(config);
  const report = { metadata, rows, pairs, summary };

  await mkdir(config.out, { recursive: true });
  await writeFile(path.join(config.out, "arc_stage3_agent_usage.csv"), renderCsv(rows));
  await writeFile(path.join(config.out, "arc_stage3_agent_usage.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(config.out, "arc_stage3_agent_usage.md"), renderIngestMarkdown(rows, pairs, summary, metadata));
}

async function runPreparedClaudePrompt(
  config: CliConfig,
  taskId: string,
  condition: BenchmarkCondition,
  deps: RunDeps,
): Promise<void> {
  const promptPath = path.join(config.out, "prompts", `${taskId}.${condition}.md`);
  const prompt = await readFile(promptPath, "utf8");
  const args = buildClaudeArgs(config);
  const startedAt = new Date();
  const startedMs = Date.now();
  const result = await (deps.runProcess ?? runProcess)(config.claudeCommand, args, { stdin: prompt });
  const finishedAt = new Date();
  const meta: ClaudeRunMeta = {
    taskId,
    condition,
    agentSource: config.agentSource,
    command: config.claudeCommand,
    args,
    promptPath,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    exitCode: result.exitCode,
    durationMs: Date.now() - startedMs,
  };

  const agentRunsDir = path.join(config.out, "agent_runs");
  const responsesDir = path.join(config.out, "responses");
  await mkdir(agentRunsDir, { recursive: true });
  await mkdir(responsesDir, { recursive: true });
  await writeFile(path.join(agentRunsDir, `${taskId}.${condition}.claude.stdout.json`), result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
  await writeFile(path.join(agentRunsDir, `${taskId}.${condition}.claude.stderr.txt`), result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  await writeFile(path.join(agentRunsDir, `${taskId}.${condition}.claude.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);

  let responseJson: unknown;
  try {
    responseJson = extractResponseJson(result.stdout);
  } catch (error) {
    responseJson = {
      target_file: null,
      target_symbol: null,
      quality: "invalid",
      confidence: "low",
      reason: "Claude stdout did not contain a parseable benchmark response object.",
      parse_error: error instanceof Error ? error.message : String(error),
    };
  }
  await writeFile(path.join(responsesDir, `${taskId}.${condition}.response.json`), `${JSON.stringify(responseJson, null, 2)}\n`);

  if (result.exitCode !== 0) {
    throw new Error(`Claude run failed for ${taskId}.${condition}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
}

async function takeSnapshotForRun(
  config: CliConfig,
  taskId: string,
  condition: BenchmarkCondition,
  snapshotLabel: SnapshotLabel,
  deps: RunDeps,
): Promise<void> {
  try {
    await runSnapshot({ ...config, mode: "snapshot", taskId, condition, snapshotLabel }, deps);
  } catch (error) {
    if (!config.allowMissingCcusage) {
      throw error;
    }
    const snapshotsDir = path.join(config.out, "snapshots");
    await mkdir(snapshotsDir, { recursive: true });
    await writeFile(path.join(snapshotsDir, `${taskId}.${condition}.${snapshotLabel}.json`), `${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      allowMissingCcusage: true,
      capturedAt: new Date().toISOString(),
    }, null, 2)}\n`);
  }
}

async function ensurePromptExists(config: CliConfig, taskId: string, condition: BenchmarkCondition): Promise<void> {
  const promptPath = path.join(config.out, "prompts", `${taskId}.${condition}.md`);
  try {
    await readFile(promptPath, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
    await runPrepare(config);
    await readFile(promptPath, "utf8");
  }
}

async function updateAutomatedRunManifest(config: CliConfig, taskId: string, condition: BenchmarkCondition): Promise<void> {
  const manifestPath = path.join(config.out, "arc_stage3_agent_usage_manifest.json");
  const manifest = await readJsonIfExists(manifestPath);
  const record = {
    task_id: taskId,
    condition,
    agent_source: config.agentSource,
    prompt: `prompts/${taskId}.${condition}.md`,
    stdout: `agent_runs/${taskId}.${condition}.claude.stdout.json`,
    stderr: `agent_runs/${taskId}.${condition}.claude.stderr.txt`,
    meta: `agent_runs/${taskId}.${condition}.claude.meta.json`,
    response: `responses/${taskId}.${condition}.response.json`,
    before_snapshot: `snapshots/${taskId}.${condition}.before.json`,
    after_snapshot: `snapshots/${taskId}.${condition}.after.json`,
    updated_at: new Date().toISOString(),
  };

  if (!isRecord(manifest)) {
    await writeFile(manifestPath, `${JSON.stringify({ metadata: makeMetadata(config), automated_runs: [record] }, null, 2)}\n`);
    return;
  }

  const existingRuns = Array.isArray(manifest.automated_runs) ? manifest.automated_runs.filter(isRecord) : [];
  const filteredRuns = existingRuns.filter((item) => item.task_id !== taskId || item.condition !== condition);
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, automated_runs: [...filteredRuns, record] }, null, 2)}\n`);
}

function shouldIngestAfterRun(config: CliConfig, defaultValue: boolean): boolean {
  return config.ingestAfterRun ?? defaultValue;
}

async function ingestRun(
  config: CliConfig,
  task: ArcStage2Task,
  condition: BenchmarkCondition,
  expected: ExpectedTarget | undefined,
  manifest: ManifestPromptLookup,
): Promise<IngestRow | null> {
  const beforePath = path.join(config.out, "snapshots", `${task.id}.${condition}.before.json`);
  const afterPath = path.join(config.out, "snapshots", `${task.id}.${condition}.after.json`);
  const responsePath = path.join(config.out, "responses", `${task.id}.${condition}.response.json`);
  const notes: string[] = [];

  const [beforeSnapshot, afterSnapshot] = await Promise.all([
    readJsonIfExists(beforePath),
    readJsonIfExists(afterPath),
  ]);

  if (beforeSnapshot === null || afterSnapshot === null) {
    return null;
  }

  let delta: DeltaResult;
  try {
    delta = computeCcusageDelta(beforeSnapshot, afterSnapshot, {
      allowAggregateAmbiguous: config.allowAggregateAmbiguous,
    });
  } catch (error) {
    delta = makeUnavailableDelta(false, [error instanceof Error ? error.message : String(error)]);
  }
  notes.push(...delta.notes);

  const responseJson = await readJsonIfExists(responsePath);
  const response = responseJson === null
    ? makeScoredResponse("invalid", null, null, null, null, "response file missing")
    : scoreResponseJson(responseJson, expected);
  const promptEstTokens = manifest.get(`${task.id}.${condition}`) ?? 0;

  return {
    taskId: task.id,
    condition,
    agentSource: config.agentSource,
    model: delta.model,
    sessionId: delta.sessionId,
    deltaMethod: delta.method,
    promptEstTokens,
    actualInputTokens: delta.method === "unavailable" ? null : delta.inputTokens,
    actualOutputTokens: delta.method === "unavailable" ? null : delta.outputTokens,
    actualCacheCreationTokens: delta.method === "unavailable" ? null : delta.cacheCreationTokens,
    actualCacheReadTokens: delta.method === "unavailable" ? null : delta.cacheReadTokens,
    actualTotalTokens: delta.method === "unavailable" ? null : delta.totalTokens,
    actualCostUsd: delta.method === "unavailable" ? null : delta.costUsd,
    responseQuality: response.quality,
    responseQualityScore: response.qualityScore,
    targetFile: response.targetFile,
    targetSymbol: response.targetSymbol,
    matchedExpectedPath: response.matchedExpectedPath,
    matchedExpectedSymbol: response.matchedExpectedSymbol,
    parseError: response.parseError,
    notes,
  };
}

async function collectBaselineContext(
  repoRoot: string,
  query: string,
  config: Pick<CliConfig, "baselineMaxFiles" | "snippetContextLines" | "maxSnippetsPerFile">,
): Promise<string> {
  const matches = await collectBaselineMatches(repoRoot, query);
  const files = stableDeduplicateFiles(matches.map((match) => match.file), config.baselineMaxFiles);
  const sections: string[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const lines = content.split(/\r?\n/);
    const matchLines = matches.filter((match) => match.file === file).map((match) => match.lineNumber);
    const ranges = extractSnippetRanges(matchLines, lines.length, config.snippetContextLines, config.maxSnippetsPerFile);
    const relativeFile = path.relative(repoRoot, file).replaceAll("\\", "/");

    for (const range of ranges) {
      const text = lines.slice(range.startLine - 1, range.endLine).join("\n");
      sections.push(`### ${relativeFile}:${range.startLine}-${range.endLine}

\`\`\`
${text}
\`\`\``);
    }
  }

  return sections.join("\n\n");
}

async function collectBaselineMatches(repoRoot: string, query: string): Promise<BaselineMatch[]> {
  const matches: BaselineMatch[] = [];

  for (const term of buildSearchTerms(query)) {
    const result = await runProcess("rg", [
      "--json",
      "--line-number",
      "--ignore-case",
      "--fixed-strings",
      "--glob", "!.git/**",
      "--glob", "!__pycache__/**",
      "--glob", "!.pytest_cache/**",
      "--glob", "!venv/**",
      "--glob", "!.venv/**",
      "--glob", "!env/**",
      "--glob", "!build/**",
      "--glob", "!dist/**",
      "--glob", "!*.egg-info/**",
      term,
      repoRoot,
    ]);

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      continue;
    }

    matches.push(...parseRipgrepJsonMatches(result.stdout));
  }

  return deduplicateMatches(matches);
}

async function collectVtraceContext(repoRoot: string, query: string, toolCommand: "capsule" | "handoff"): Promise<string> {
  const result = await runProcess(path.resolve("bin/vtrace"), [toolCommand, repoRoot, query]);

  if (result.exitCode !== 0) {
    return JSON.stringify({
      error: `${toolCommand} failed`,
      stderr: result.stderr.trim(),
      stdoutPreview: result.stdout.slice(0, 1000),
    }, null, 2);
  }

  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const packageSummary = parseVtraceOutput(parsed, toolCommand);
    return JSON.stringify({
      selectedIntent: packageSummary.selectedIntent,
      routingProfile: packageSummary.routingProfile,
      capsuleProfile: packageSummary.capsuleProfile,
      topResult: packageSummary.topResult,
      topFile: packageSummary.topFile,
      files: packageSummary.files,
      symbols: packageSummary.symbols,
      items: packageSummary.items,
      capsule: parsed,
    }, null, 2);
  } catch (error) {
    return JSON.stringify({
      error: `${toolCommand} JSON parse failed`,
      message: error instanceof Error ? error.message : String(error),
      stdoutPreview: result.stdout.slice(0, 2000),
    }, null, 2);
  }
}

function findSessionRecords(snapshot: unknown): unknown[] {
  const direct = findArrays(snapshot)
    .filter((array) => array.some((item) => isRecord(item) && hasSessionLikeSignal(item)));

  if (direct.length === 0) {
    return isRecord(snapshot) && hasSessionLikeSignal(snapshot) ? [snapshot] : [];
  }

  return direct
    .sort((left, right) => right.length - left.length)[0]!
    .filter(isRecord);
}

function findAggregateTotals(snapshot: unknown, sessions: readonly UsageSession[]): UsageTotals {
  const records = findRecords(snapshot)
    .filter((record) => hasTotalLikeSignal(record) && !hasSessionLikeSignal(record));
  const parsed = records.map(parseUsageTotals).filter(hasAnyUsageSignal);
  const best = parsed.sort((left, right) => signalScore(right) - signalScore(left))[0];

  if (best !== undefined) {
    return best;
  }

  return sumTotals(sessions);
}

function parseUsageSession(value: unknown): UsageSession {
  if (!isRecord(value)) {
    throw new Error("Session row must be an object.");
  }

  return {
    ...parseUsageTotals(value),
    sessionId: findStringByKey(value, ["sessionid", "session_id", "session", "id"]),
    model: findStringByKey(value, ["model", "modelname", "model_name"]),
  };
}

function parseUsageTotals(value: unknown): UsageTotals {
  if (!isRecord(value)) {
    return zeroTotals();
  }

  const inputTokens = findNumberByKey(value, ["inputtokens", "input_tokens", "prompttokens", "prompt_tokens", "input"]) ?? 0;
  const outputTokens = findNumberByKey(value, ["outputtokens", "output_tokens", "completiontokens", "completion_tokens", "output"]) ?? 0;
  const cacheCreationTokens = findNumberByKey(value, ["cachecreationtokens", "cache_creation_tokens", "cachewriteinputtokens", "cache_creation_input_tokens"]) ?? 0;
  const cacheReadTokens = findNumberByKey(value, ["cachereadtokens", "cache_read_tokens", "cachereadinputtokens", "cache_read_input_tokens"]) ?? 0;
  const totalTokens = findNumberByKey(value, ["totaltokens", "total_tokens", "tokens", "total"]) ?? (
    inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
  );
  const costUsd = findNumberByKey(value, ["costusd", "cost_usd", "totalcost", "total_cost", "cost"]) ?? 0;

  return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalTokens, costUsd };
}

function findNumberByKey(value: unknown, aliases: readonly string[]): number | null {
  const matches: number[] = [];
  visit(value, (record) => {
    for (const [key, fieldValue] of Object.entries(record)) {
      if (aliases.includes(normalizeKey(key)) && typeof fieldValue === "number" && Number.isFinite(fieldValue)) {
        matches.push(fieldValue);
      }
    }
  }, 3);
  return matches[0] ?? null;
}

function findStringByKey(value: unknown, aliases: readonly string[]): string | null {
  let match: string | null = null;
  visit(value, (record) => {
    if (match !== null) {
      return;
    }
    for (const [key, fieldValue] of Object.entries(record)) {
      if (aliases.includes(normalizeKey(key)) && typeof fieldValue === "string" && fieldValue.length > 0) {
        match = fieldValue;
        return;
      }
    }
  }, 2);
  return match;
}

function hasSessionLikeSignal(record: Record<string, unknown>): boolean {
  const keys = new Set(Object.keys(record).map(normalizeKey));
  return ["sessionid", "session_id", "session", "id"].some((key) => keys.has(key)) && hasTotalLikeSignal(record);
}

function hasTotalLikeSignal(record: Record<string, unknown>): boolean {
  const keys = new Set(Object.keys(record).map(normalizeKey));
  return [
    "inputtokens",
    "input_tokens",
    "outputtokens",
    "output_tokens",
    "cachecreationtokens",
    "cache_creation_tokens",
    "cachereadtokens",
    "cache_read_tokens",
    "totaltokens",
    "total_tokens",
    "costusd",
    "cost_usd",
  ].some((key) => keys.has(key));
}

function makeDeltaResult(
  method: DeltaMethod,
  session: UsageSession,
  ambiguous: boolean,
  notes: readonly string[],
): DeltaResult {
  return {
    method,
    sessionId: session.sessionId,
    model: session.model,
    ambiguous,
    notes,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    cacheCreationTokens: session.cacheCreationTokens,
    cacheReadTokens: session.cacheReadTokens,
    totalTokens: session.totalTokens,
    costUsd: session.costUsd,
  };
}

function makeUnavailableDelta(ambiguous: boolean, notes: readonly string[]): DeltaResult {
  return {
    method: "unavailable",
    sessionId: null,
    model: null,
    ambiguous,
    notes,
    ...zeroTotals(),
  };
}

function subtractTotals(after: UsageTotals, before: UsageTotals): UsageTotals {
  return {
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
    cacheCreationTokens: Math.max(0, after.cacheCreationTokens - before.cacheCreationTokens),
    cacheReadTokens: Math.max(0, after.cacheReadTokens - before.cacheReadTokens),
    totalTokens: Math.max(0, after.totalTokens - before.totalTokens),
    costUsd: Math.max(0, after.costUsd - before.costUsd),
  };
}

function sumTotals(sessions: readonly UsageSession[]): UsageTotals {
  return sessions.reduce((total, session) => ({
    inputTokens: total.inputTokens + session.inputTokens,
    outputTokens: total.outputTokens + session.outputTokens,
    cacheCreationTokens: total.cacheCreationTokens + session.cacheCreationTokens,
    cacheReadTokens: total.cacheReadTokens + session.cacheReadTokens,
    totalTokens: total.totalTokens + session.totalTokens,
    costUsd: total.costUsd + session.costUsd,
  }), zeroTotals());
}

function zeroTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

function hasAnyUsageSignal(totals: UsageTotals): boolean {
  return totals.inputTokens !== 0
    || totals.outputTokens !== 0
    || totals.cacheCreationTokens !== 0
    || totals.cacheReadTokens !== 0
    || totals.totalTokens !== 0
    || totals.costUsd !== 0;
}

function signalScore(totals: UsageTotals): number {
  return [
    totals.inputTokens,
    totals.outputTokens,
    totals.cacheCreationTokens,
    totals.cacheReadTokens,
    totals.totalTokens,
    totals.costUsd,
  ].filter((value) => value !== 0).length;
}

function dominantModel(sessions: readonly UsageSession[]): string | null {
  return sessions.find((session) => session.model !== null)?.model ?? null;
}

function makeScoredResponse(
  quality: ResponseQuality,
  targetFile: string | null,
  targetSymbol: string | null,
  matchedExpectedPath: string | null,
  matchedExpectedSymbol: string | null,
  parseError: string | null,
): ScoredResponse {
  return {
    quality,
    qualityScore: qualityScore(quality),
    targetFile,
    targetSymbol,
    matchedExpectedPath,
    matchedExpectedSymbol,
    parseError,
  };
}

function directlyMatchesPath(actualPath: string | null, expectedPath: string): boolean {
  if (actualPath === null) {
    return false;
  }
  const actual = normalizePath(actualPath);
  const expected = normalizePath(expectedPath);
  return actual === expected || actual.endsWith(`/${expected}`);
}

function broadlyMatchesPath(actualPath: string | null, expectedPath: string): boolean {
  if (actualPath === null) {
    return false;
  }
  const actual = normalizePath(actualPath);
  const expected = normalizePath(expectedPath);
  const expectedDir = expected.includes("/") ? expected.slice(0, expected.lastIndexOf("/")) : expected;
  return actual.startsWith(`${expected}/`)
    || actual.startsWith(`${expectedDir}/`)
    || expected.startsWith(`${actual}/`);
}

function directlyMatchesSymbol(actualSymbol: string | null, expectedSymbol: string): boolean {
  if (actualSymbol === null) {
    return false;
  }
  const actual = actualSymbol.toLowerCase();
  const expected = expectedSymbol.toLowerCase();
  return actual === expected || actual.endsWith(`.${expected}`) || actual.endsWith(`::${expected}`);
}

function broadlyMatchesSymbol(actualSymbol: string | null, expectedSymbol: string): boolean {
  if (actualSymbol === null) {
    return false;
  }
  const actual = actualSymbol.toLowerCase();
  const expected = expectedSymbol.toLowerCase();
  return expected.length >= 3 && (actual.includes(expected) || expected.includes(actual));
}

function renderCsv(rows: readonly IngestRow[]): string {
  return `${[
    CSV_COLUMNS.join(","),
    ...rows.map((row) => [
      row.taskId,
      row.condition,
      row.agentSource,
      row.model,
      row.sessionId,
      row.deltaMethod,
      row.promptEstTokens,
      row.actualInputTokens,
      row.actualOutputTokens,
      row.actualCacheCreationTokens,
      row.actualCacheReadTokens,
      row.actualTotalTokens,
      row.actualCostUsd,
      row.responseQuality,
      row.targetFile,
      row.targetSymbol,
      row.matchedExpectedPath,
      row.matchedExpectedSymbol,
      row.parseError,
      row.notes.join("; "),
    ].map(csvEscape).join(",")),
  ].join("\n")}\n`;
}

function renderPairTable(pairs: readonly PairComparison[]): string {
  if (pairs.length === 0) {
    return "No paired baseline/vtrace runs have been ingested yet.";
  }

  return [
    "| task | baseline tokens | vtrace tokens | actual reduction | baseline quality | vtrace quality | quality preserving | preserving reduction |",
    "| --- | ---: | ---: | ---: | --- | --- | --- | ---: |",
    ...pairs.map((pair) => [
      pair.taskId,
      pair.baselineTotalTokens,
      pair.vtraceTotalTokens,
      formatPct(pair.actualTotalTokenReductionPct),
      pair.baselineQuality,
      pair.vtraceQuality,
      pair.qualityPreserving ? "yes" : "no",
      formatPct(pair.qualityPreservingActualReductionPct),
    ].join(" | ")).map((line) => `| ${line} |`),
  ].join("\n");
}

interface BaselineMatch {
  readonly file: string;
  readonly lineNumber: number;
}

function parseRipgrepJsonMatches(output: string): BaselineMatch[] {
  const matches: BaselineMatch[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }

    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || parsed.type !== "match" || !isRecord(parsed.data)) {
      continue;
    }

    const data = parsed.data;
    const pathValue = isRecord(data.path) && typeof data.path.text === "string" ? data.path.text : null;
    const lineNumber = typeof data.line_number === "number" ? data.line_number : null;

    if (pathValue !== null && lineNumber !== null) {
      matches.push({ file: normalizePath(pathValue), lineNumber });
    }
  }

  return matches.sort((left, right) => left.file.localeCompare(right.file) || left.lineNumber - right.lineNumber);
}

function deduplicateMatches(matches: readonly BaselineMatch[]): BaselineMatch[] {
  const deduped: BaselineMatch[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    const key = `${match.file}:${match.lineNumber}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(match);
  }

  return deduped;
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: { readonly stdin?: string } = {},
): Promise<ProcessResult> {
  return await new Promise((resolve) => {
    const proc = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on("error", (error) => {
      resolve({
        exitCode: 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: `${Buffer.concat(stderrChunks).toString("utf8")}${error.message}`,
      });
    });
    proc.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });

    if (options.stdin !== undefined) {
      proc.stdin.end(options.stdin);
    } else {
      proc.stdin.end();
    }
  });
}

type ManifestPromptLookup = Map<string, number>;

async function loadManifest(outDir: string): Promise<ManifestPromptLookup> {
  const manifestPath = path.join(outDir, "arc_stage3_agent_usage_manifest.json");
  const manifest = await readJsonIfExists(manifestPath);
  const lookup: ManifestPromptLookup = new Map();

  if (!isRecord(manifest) || !Array.isArray(manifest.prompts)) {
    return lookup;
  }

  for (const item of manifest.prompts) {
    if (!isRecord(item) || typeof item.task_id !== "string") {
      continue;
    }
    if (typeof item.baseline_prompt_est_tokens === "number") {
      lookup.set(`${item.task_id}.baseline`, item.baseline_prompt_est_tokens);
    }
    if (typeof item.vtrace_prompt_est_tokens === "number") {
      lookup.set(`${item.task_id}.vtrace`, item.vtrace_prompt_est_tokens);
    }
  }

  return lookup;
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function ensureOutputTree(outDir: string): Promise<void> {
  await mkdir(path.join(outDir, "agent_runs"), { recursive: true });
  await mkdir(path.join(outDir, "prompts"), { recursive: true });
  await mkdir(path.join(outDir, "snapshots"), { recursive: true });
  await mkdir(path.join(outDir, "responses"), { recursive: true });
}

function makeMetadata(config: CliConfig): Record<string, unknown> {
  return {
    benchmark: "arc_stage3_agent_usage",
    timestamp: new Date().toISOString(),
    arcRepoPath: config.repo,
    taskFile: config.tasks,
    expectedFile: config.expected,
    outputDirectory: config.out,
    agentSource: config.agentSource,
    mode: config.mode,
    ccusageCommand: `bunx ccusage ${config.agentSource} session --json`,
    tokenEstimate: "Math.ceil(prompt.length / 4)",
  };
}

function findArrays(value: unknown): unknown[][] {
  const arrays: unknown[][] = [];
  visitAny(value, (item) => {
    if (Array.isArray(item)) {
      arrays.push(item);
    }
  }, 5);
  return arrays;
}

function findRecords(value: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  visitAny(value, (item) => {
    if (isRecord(item)) {
      records.push(item);
    }
  }, 5);
  return records;
}

function parseJsonIfPossible(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function findBenchmarkResponseObject(value: unknown): Record<string, unknown> | null {
  if (isBenchmarkResponseObject(value)) {
    return value;
  }

  if (isRecord(value)) {
    for (const field of ["result", "response", "content", "message", "text"]) {
      const fieldValue = value[field];
      if (typeof fieldValue === "string") {
        const parsed = parseJsonIfPossible(fieldValue);
        const parsedMatch = findBenchmarkResponseObject(parsed);
        if (parsedMatch !== null) {
          return parsedMatch;
        }
        for (const fenced of extractFencedJsonBlocks(fieldValue)) {
          const fencedMatch = findBenchmarkResponseObject(parseJsonIfPossible(fenced));
          if (fencedMatch !== null) {
            return fencedMatch;
          }
        }
      } else {
        const nestedMatch = findBenchmarkResponseObject(fieldValue);
        if (nestedMatch !== null) {
          return nestedMatch;
        }
      }
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findBenchmarkResponseObject(item);
      if (match !== null) {
        return match;
      }
    }
  }

  return null;
}

function isBenchmarkResponseObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  return ["target_file", "target_symbol", "quality", "confidence", "reason"].every((key) => key in value);
}

function extractFencedJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  const pattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    blocks.push(match[1]!.trim());
  }
  return blocks;
}

function visit(
  value: unknown,
  callback: (record: Record<string, unknown>) => void,
  maxDepth: number,
): void {
  visitAny(value, (item) => {
    if (isRecord(item)) {
      callback(item);
    }
  }, maxDepth);
}

function visitAny(value: unknown, callback: (value: unknown) => void, maxDepth: number): void {
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];

  while (queue.length > 0) {
    const item = queue.shift()!;
    callback(item.value);

    if (item.depth >= maxDepth) {
      continue;
    }

    if (Array.isArray(item.value)) {
      for (const child of item.value) {
        queue.push({ value: child, depth: item.depth + 1 });
      }
    } else if (isRecord(item.value)) {
      for (const child of Object.values(item.value)) {
        if (typeof child === "object" && child !== null) {
          queue.push({ value: child, depth: item.depth + 1 });
        }
      }
    }
  }
}

function firstMatch(values: readonly string[], predicate: (value: string) => boolean): string | null {
  return values.find(predicate) ?? null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9_]/g, "");
}

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);
  if (!/[",\n\r]/.test(text)) {
    return text;
  }

  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function formatPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "";
  }
  return `${value.toFixed(2)}%`;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function parseArgs(argv: readonly string[]): CliConfig {
  const config = { ...DEFAULT_CONFIG };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case "--repo":
        config.repo = requireValue(argv, ++index, arg);
        break;
      case "--tasks":
        config.tasks = requireValue(argv, ++index, arg);
        break;
      case "--expected":
        config.expected = requireValue(argv, ++index, arg);
        break;
      case "--out":
        config.out = requireValue(argv, ++index, arg);
        break;
      case "--agent-source": {
        const value = requireValue(argv, ++index, arg);
        if (value !== "claude" && value !== "codex") {
          throw new Error("--agent-source must be claude or codex.");
        }
        config.agentSource = value;
        break;
      }
      case "--mode": {
        const value = requireValue(argv, ++index, arg);
        if (value !== "prepare" && value !== "snapshot" && value !== "ingest" && value !== "run-one" && value !== "run-pair" && value !== "run-matrix") {
          throw new Error("--mode must be prepare, snapshot, ingest, run-one, run-pair, or run-matrix.");
        }
        config.mode = value;
        break;
      }
      case "--snapshot-label": {
        const value = requireValue(argv, ++index, arg);
        if (value !== "before" && value !== "after") {
          throw new Error("--snapshot-label must be before or after.");
        }
        config.snapshotLabel = value;
        break;
      }
      case "--task-id":
        config.taskId = requireValue(argv, ++index, arg);
        break;
      case "--task-ids":
        config.taskIds = requireValue(argv, ++index, arg).split(",").map((value) => value.trim()).filter((value) => value.length > 0);
        break;
      case "--condition": {
        const value = requireValue(argv, ++index, arg);
        if (value !== "baseline" && value !== "vtrace") {
          throw new Error("--condition must be baseline or vtrace.");
        }
        config.condition = value;
        break;
      }
      case "--allow-aggregate-ambiguous":
        config.allowAggregateAmbiguous = true;
        break;
      case "--allow-missing-ccusage":
        config.allowMissingCcusage = true;
        break;
      case "--yes":
        config.yes = true;
        break;
      case "--ingest-after-run":
        config.ingestAfterRun = true;
        break;
      case "--no-ingest-after-run":
        config.ingestAfterRun = false;
        break;
      case "--baseline-max-files":
        config.baselineMaxFiles = parsePositiveInt(requireValue(argv, ++index, arg), arg);
        break;
      case "--snippet-context-lines":
        config.snippetContextLines = parseNonNegativeInt(requireValue(argv, ++index, arg), arg);
        break;
      case "--max-snippets-per-file":
        config.maxSnippetsPerFile = parsePositiveInt(requireValue(argv, ++index, arg), arg);
        break;
      case "--tool-command": {
        const value = requireValue(argv, ++index, arg);
        if (value !== "capsule" && value !== "handoff") {
          throw new Error("--tool-command must be capsule or handoff.");
        }
        config.toolCommand = value;
        break;
      }
      case "--claude-command":
        config.claudeCommand = requireValue(argv, ++index, arg);
        break;
      case "--claude-model":
        config.claudeModel = requireValue(argv, ++index, arg);
        break;
      case "--claude-max-turns":
        config.claudeMaxTurns = parsePositiveInt(requireValue(argv, ++index, arg), arg);
        break;
      case "--claude-output-format":
        config.claudeOutputFormat = requireValue(argv, ++index, arg);
        break;
      case "--claude-extra-arg":
        config.claudeExtraArgs = [...config.claudeExtraArgs, requireValue(argv, ++index, arg)];
        break;
      case "--claude-system-prompt-file":
        config.claudeSystemPromptFile = requireValue(argv, ++index, arg);
        break;
      case "--claude-append-system-prompt-file":
        config.claudeAppendSystemPromptFile = requireValue(argv, ++index, arg);
        break;
      case "--no-claude-append-system-prompt-file":
        config.claudeAppendSystemPromptFile = null;
        break;
      case "--claude-bare":
        config.claudeBare = true;
        break;
      case "--claude-disable-tools":
        config.claudeDisableTools = true;
        break;
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
    expected: path.resolve(config.expected),
    out: path.resolve(config.out),
    claudeSystemPromptFile: config.claudeSystemPromptFile === null ? null : path.resolve(config.claudeSystemPromptFile),
    claudeAppendSystemPromptFile: config.claudeAppendSystemPromptFile === null ? null : path.resolve(config.claudeAppendSystemPromptFile),
  };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function parseNonNegativeInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

function printUsageAndExit(exitCode: number): never {
  process.stdout.write([
    "Usage:",
    "  bun benchmarks/arc_stage3_agent_usage/run_arc_stage3_agent_usage.ts --repo /home/calvin/code/ARC --tasks benchmarks/arc_stage2_orientation/tasks.arc.stage2.json --expected benchmarks/arc_stage2_orientation/expected.arc.stage2.json --out benchmarks/arc_stage3_agent_usage/results --agent-source claude --mode prepare",
    "  bun benchmarks/arc_stage3_agent_usage/run_arc_stage3_agent_usage.ts --out benchmarks/arc_stage3_agent_usage/results --agent-source claude --mode snapshot --snapshot-label before --task-id workflow_arkane_input --condition baseline",
    "  bun benchmarks/arc_stage3_agent_usage/run_arc_stage3_agent_usage.ts --repo /home/calvin/code/ARC --tasks benchmarks/arc_stage2_orientation/tasks.arc.stage2.json --expected benchmarks/arc_stage2_orientation/expected.arc.stage2.json --out benchmarks/arc_stage3_agent_usage/results --agent-source claude --mode ingest",
    "  bun benchmarks/arc_stage3_agent_usage/run_arc_stage3_agent_usage.ts --repo /home/calvin/code/ARC --tasks benchmarks/arc_stage2_orientation/tasks.arc.stage2.json --expected benchmarks/arc_stage2_orientation/expected.arc.stage2.json --out benchmarks/arc_stage3_agent_usage/results --agent-source claude --mode run-pair --task-id workflow_arkane_input --yes",
    "  bun benchmarks/arc_stage3_agent_usage/run_arc_stage3_agent_usage.ts --repo /home/calvin/code/ARC --tasks benchmarks/arc_stage2_orientation/tasks.arc.stage2.json --expected benchmarks/arc_stage2_orientation/expected.arc.stage2.json --out benchmarks/arc_stage3_agent_usage/results --agent-source claude --mode run-matrix --task-ids exact_scheduler,workflow_conformer_filtering,known_weak_rotor_scans --yes",
    "",
  ].join("\n"));
  process.exit(exitCode);
}

async function main(config: CliConfig): Promise<void> {
  await ensureOutputTree(config.out);
  switch (config.mode) {
    case "prepare":
      await runPrepare(config);
      break;
    case "snapshot":
      await runSnapshot(config);
      break;
    case "ingest":
      await runIngest(config);
      break;
    case "run-one":
      await runOne(config);
      break;
    case "run-pair":
      await runPair(config);
      break;
    case "run-matrix":
      await runMatrix(config);
      break;
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
