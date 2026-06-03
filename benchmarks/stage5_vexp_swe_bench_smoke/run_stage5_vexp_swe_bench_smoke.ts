import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// Stage 5 is a SMOKE integration harness around the external `vexp-swe-bench`
// benchmark. It proves the baseline-vs-vtrace measurement workflow on a tiny
// subset. It does not vendor vexp-swe-bench, does not run the full benchmark,
// and makes no public SWE-bench claim. See README.md for scope.

export type Stage5Mode = "prepare" | "run-baseline" | "run-vtrace" | "ingest" | "report";
export type Stage5Condition = "baseline" | "vtrace";
export type VtraceMethod = "instructions-file" | "mcp" | "local-patch";
export type Outcome =
  | "both_resolved"
  | "vtrace_only_resolved"
  | "baseline_only_resolved"
  | "both_failed"
  | "unpaired"
  | "unknown";

// Most numeric/boolean fields can be genuinely absent in benchmark output. We
// never guess a value; an absent field is recorded as the literal "unknown".
export type Unknownable<T> = T | "unknown";

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: { readonly cwd?: string; readonly env?: Record<string, string> },
) => Promise<ProcessResult>;

export interface RunDeps {
  readonly runProcess?: ProcessRunner;
}

export interface CliConfig {
  readonly mode: Stage5Mode;
  readonly vexpSweBenchDir: string | null;
  readonly instances: readonly string[];
  readonly instancesFile: string;
  readonly out: string;
  readonly nodeCommand: string;
  readonly cliEntry: string;
  readonly vtraceMethod: VtraceMethod;
  readonly yes: boolean;
}

export interface SmokeInstancesFile {
  readonly instances: readonly string[];
  readonly notes: readonly string[];
}

export interface Stage5Row {
  readonly instanceId: string;
  readonly condition: Stage5Condition;
  readonly resolved: Unknownable<boolean>;
  readonly costUsd: Unknownable<number>;
  readonly durationMs: Unknownable<number>;
  readonly inputTokens: Unknownable<number>;
  readonly outputTokens: Unknownable<number>;
  readonly totalTokens: Unknownable<number>;
  readonly numTurns: Unknownable<number>;
  readonly patchAvailable: Unknownable<boolean>;
  readonly error: string | null;
  readonly rawResultPath: string;
  readonly notes: readonly string[];
}

export interface PairComparison {
  readonly instanceId: string;
  readonly baselineResolved: Unknownable<boolean> | null;
  readonly vtraceResolved: Unknownable<boolean> | null;
  readonly outcome: Outcome;
  readonly baselineTotalTokens: Unknownable<number> | null;
  readonly vtraceTotalTokens: Unknownable<number> | null;
  readonly tokenReductionPct: number | null;
  readonly baselineCostUsd: Unknownable<number> | null;
  readonly vtraceCostUsd: Unknownable<number> | null;
  readonly costReductionPct: number | null;
  readonly baselineDurationMs: Unknownable<number> | null;
  readonly vtraceDurationMs: Unknownable<number> | null;
  readonly durationReductionPct: number | null;
}

export interface Stage5Summary {
  readonly instanceCount: number;
  readonly baselineRuns: number;
  readonly vtraceRuns: number;
  readonly bothResolved: number;
  readonly vtraceOnlyResolved: number;
  readonly baselineOnlyResolved: number;
  readonly bothFailed: number;
  readonly unpaired: number;
  readonly unknown: number;
  readonly meanTokenReductionBothResolved: number | null;
  readonly meanCostReductionBothResolved: number | null;
  readonly meanDurationReductionBothResolved: number | null;
  readonly vtraceConditionRun: boolean;
}

export interface NormalizedArtifact {
  readonly rows: readonly Stage5Row[];
  readonly pairs: readonly PairComparison[];
  readonly summary: Stage5Summary;
}

const DEFAULT_CONFIG: CliConfig = {
  mode: "prepare",
  vexpSweBenchDir: null,
  instances: [],
  instancesFile: "benchmarks/stage5_vexp_swe_bench_smoke/smoke_instances.json",
  out: "benchmarks/stage5_vexp_swe_bench_smoke/results",
  nodeCommand: "node",
  cliEntry: "dist/cli.js",
  vtraceMethod: "instructions-file",
  yes: false,
};

const CSV_COLUMNS = [
  "instance_id",
  "condition",
  "resolved",
  "cost_usd",
  "duration_ms",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "num_turns",
  "patch_available",
  "error",
  "raw_result_path",
  "notes",
];

const NORMALIZED_FILENAME = "stage5_normalized.json";

// vexp-swe-bench output files we write ourselves are prefixed with "_" so the
// tolerant parser skips them and never mistakes run metadata for results.
const RUNNER_ARTIFACT_PREFIX = "_";

const PUBLIC_CLAIM_DISCLAIMER =
  "This is a Stage 5 smoke run against a tiny subset of vexp-swe-bench. It checks integration and measurement workflow only. It is not a public SWE-bench claim and not a comparison against vexp unless an explicit vexp-enabled condition is also run.";

export async function loadSmokeInstances(filePath: string): Promise<SmokeInstancesFile> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("smoke_instances.json must be an object.");
  const instances = Array.isArray(parsed.instances) ? parsed.instances.filter(isString) : [];
  const notes = Array.isArray(parsed.notes) ? parsed.notes.filter(isString) : [];
  return { instances, notes };
}

export async function resolveInstances(config: CliConfig): Promise<string[]> {
  if (config.instances.length > 0) return [...config.instances];
  const file = await loadSmokeInstances(config.instancesFile).catch(() => null);
  return file === null ? [] : [...file.instances];
}

export function rawConditionDir(outDir: string, condition: Stage5Condition): string {
  return path.join(outDir, "raw", condition);
}

export function buildRunArgs(config: CliConfig, instances: readonly string[], outputDir: string): string[] {
  // --no-vexp keeps vexp disabled in BOTH conditions. Stage 5 compares the
  // baseline agent against the same agent with vtrace, never vexp vs vtrace.
  return [config.cliEntry, "run", "--instances", instances.join(","), "--no-vexp", "--output", outputDir];
}

export function buildBaselineCommand(
  config: CliConfig,
  instances: readonly string[],
): { command: string; args: string[]; cwd: string | null } {
  return {
    command: config.nodeCommand,
    args: buildRunArgs(config, instances, rawConditionDir(config.out, "baseline")),
    cwd: config.vexpSweBenchDir,
  };
}

export function buildVtraceCommand(
  config: CliConfig,
  instances: readonly string[],
): { command: string; args: string[]; cwd: string | null; env: Record<string, string> } {
  // The vtrace condition uses the IDENTICAL benchmark command as baseline
  // (still --no-vexp, same model/agent/budget). vtrace is injected out-of-band
  // via environment so vexp is never enabled and command parity is preserved.
  return {
    command: config.nodeCommand,
    args: buildRunArgs(config, instances, rawConditionDir(config.out, "vtrace")),
    cwd: config.vexpSweBenchDir,
    env: vtraceEnv(config),
  };
}

function vtraceEnv(config: CliConfig): Record<string, string> {
  return {
    VTRACE_SMOKE: "1",
    VTRACE_METHOD: config.vtraceMethod,
    VTRACE_AGENT_INSTRUCTIONS_FILE: path.join(rawConditionDir(config.out, "vtrace"), "_vtrace_instructions.md"),
  };
}

function vtraceInstructionsText(): string {
  return [
    "# vtrace agent instructions (Stage 5 smoke)",
    "",
    "Before working on the task, initialize vtrace in the task repository and use it",
    "to orient: build/refresh the vtrace index, then request a handoff/capsule for the",
    "failing area instead of broad grep/file reads. Keep vexp disabled. Do not change",
    "the model, agent, or budget relative to the baseline condition.",
    "",
    "This file is consumed only if the vexp-swe-bench agent wrapper supports an",
    "instructions file (VTRACE_AGENT_INSTRUCTIONS_FILE). If it does not, this is a",
    "documented no-op for the smoke run and the vtrace method must be recorded as such",
    "in the Stage 5 report.",
  ].join("\n");
}

export function classifyOutcome(
  baselineResolved: Unknownable<boolean> | null,
  vtraceResolved: Unknownable<boolean> | null,
): Outcome {
  if (baselineResolved === null || vtraceResolved === null) return "unpaired";
  if (baselineResolved === "unknown" || vtraceResolved === "unknown") return "unknown";
  if (baselineResolved && vtraceResolved) return "both_resolved";
  if (!baselineResolved && vtraceResolved) return "vtrace_only_resolved";
  if (baselineResolved && !vtraceResolved) return "baseline_only_resolved";
  return "both_failed";
}

export function reductionPct(baseline: Unknownable<number> | null, vtrace: Unknownable<number> | null): number | null {
  if (!isNumber(baseline) || !isNumber(vtrace) || baseline <= 0) return null;
  return (100 * (baseline - vtrace)) / baseline;
}

export function comparePairs(rows: readonly Stage5Row[]): PairComparison[] {
  const byInstance = new Map<string, Map<Stage5Condition, Stage5Row>>();
  for (const row of rows) {
    const conditions = byInstance.get(row.instanceId) ?? new Map<Stage5Condition, Stage5Row>();
    conditions.set(row.condition, row);
    byInstance.set(row.instanceId, conditions);
  }

  const pairs: PairComparison[] = [];
  for (const [instanceId, conditions] of byInstance) {
    const baseline = conditions.get("baseline") ?? null;
    const vtrace = conditions.get("vtrace") ?? null;
    pairs.push({
      instanceId,
      baselineResolved: baseline?.resolved ?? null,
      vtraceResolved: vtrace?.resolved ?? null,
      outcome: classifyOutcome(baseline?.resolved ?? null, vtrace?.resolved ?? null),
      baselineTotalTokens: baseline?.totalTokens ?? null,
      vtraceTotalTokens: vtrace?.totalTokens ?? null,
      tokenReductionPct: reductionPct(baseline?.totalTokens ?? null, vtrace?.totalTokens ?? null),
      baselineCostUsd: baseline?.costUsd ?? null,
      vtraceCostUsd: vtrace?.costUsd ?? null,
      costReductionPct: reductionPct(baseline?.costUsd ?? null, vtrace?.costUsd ?? null),
      baselineDurationMs: baseline?.durationMs ?? null,
      vtraceDurationMs: vtrace?.durationMs ?? null,
      durationReductionPct: reductionPct(baseline?.durationMs ?? null, vtrace?.durationMs ?? null),
    });
  }
  return pairs.sort((left, right) => left.instanceId.localeCompare(right.instanceId));
}

// ----- tolerant parsing of benchmark output -----------------------------------

const FIELD_ALIASES: Record<string, readonly string[]> = {
  instanceId: ["instance_id", "instanceId", "instance", "id"],
  resolved: ["resolved", "passed", "pass", "is_resolved", "success", "solved"],
  costUsd: ["cost_usd", "cost", "total_cost_usd", "costUSD", "totalCostUsd", "costUsd"],
  durationMs: ["duration_ms", "durationMs", "duration", "elapsed_ms", "wall_ms"],
  inputTokens: ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"],
  outputTokens: ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"],
  totalTokens: ["total_tokens", "totalTokens", "tokens"],
  numTurns: ["num_turns", "numTurns", "turns", "iterations", "steps"],
  patch: ["patch", "model_patch", "prediction", "patch_path", "model_patch_path"],
  error: ["error", "error_message", "exception", "failure"],
};

function pick(record: Record<string, unknown>, aliases: readonly string[]): unknown {
  for (const key of aliases) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return undefined;
}

function asUnknownableNumber(value: unknown): Unknownable<number> {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return "unknown";
}

function asUnknownableBoolean(value: unknown): Unknownable<boolean> {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["true", "yes", "resolved", "pass", "passed", "1"].includes(text)) return true;
    if (["false", "no", "unresolved", "fail", "failed", "0"].includes(text)) return false;
  }
  return "unknown";
}

export function extractRow(
  record: Record<string, unknown>,
  condition: Stage5Condition,
  rawResultPath: string,
): Stage5Row | null {
  const instanceRaw = pick(record, FIELD_ALIASES.instanceId!);
  if (!isString(instanceRaw)) return null;

  const inputTokens = asUnknownableNumber(pick(record, FIELD_ALIASES.inputTokens!));
  const outputTokens = asUnknownableNumber(pick(record, FIELD_ALIASES.outputTokens!));
  let totalTokens = asUnknownableNumber(pick(record, FIELD_ALIASES.totalTokens!));
  if (totalTokens === "unknown" && isNumber(inputTokens) && isNumber(outputTokens)) {
    totalTokens = inputTokens + outputTokens;
  }
  const patchValue = pick(record, FIELD_ALIASES.patch!);
  const patchAvailable: Unknownable<boolean> =
    patchValue === undefined ? "unknown" : isString(patchValue) ? patchValue.trim().length > 0 : Boolean(patchValue);
  const errorValue = pick(record, FIELD_ALIASES.error!);

  return {
    instanceId: instanceRaw,
    condition,
    resolved: asUnknownableBoolean(pick(record, FIELD_ALIASES.resolved!)),
    costUsd: asUnknownableNumber(pick(record, FIELD_ALIASES.costUsd!)),
    durationMs: asUnknownableNumber(pick(record, FIELD_ALIASES.durationMs!)),
    inputTokens,
    outputTokens,
    totalTokens,
    numTurns: asUnknownableNumber(pick(record, FIELD_ALIASES.numTurns!)),
    patchAvailable,
    error: isString(errorValue) ? errorValue : null,
    rawResultPath,
    notes: [],
  };
}

// Pull candidate result records out of one file's contents, trying JSON, then
// JSONL, then CSV, then a GFM markdown table. Returns whatever records carry an
// instance id; files with none yield an empty list.
export function parseResultRecords(
  content: string,
  filename: string,
  condition: Stage5Condition,
  rawResultPath: string,
): Stage5Row[] {
  const records = collectRecords(content, filename);
  const rows: Stage5Row[] = [];
  for (const record of records) {
    const row = extractRow(record, condition, rawResultPath);
    if (row !== null) rows.push(row);
  }
  return rows;
}

function collectRecords(content: string, filename: string): Record<string, unknown>[] {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".csv") return parseCsvRecords(content);
  if (ext === ".md" || ext === ".markdown") return parseMarkdownTableRecords(content);

  const whole = parseJson(content);
  if (whole !== null) return flattenJsonRecords(whole);

  // Fall back to JSONL: one JSON object per non-empty line.
  return parseJsonlRecords(content);
}

function flattenJsonRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of ["results", "predictions", "instances", "items", "runs"]) {
    if (Array.isArray(value[key])) return (value[key] as unknown[]).filter(isRecord);
  }
  // A single result object, or a map of instance_id -> result object.
  if (pick(value, FIELD_ALIASES.instanceId!) !== undefined) return [value];
  const mapValues = Object.entries(value)
    .filter(([, entry]) => isRecord(entry))
    .map(([instanceKey, entry]) => ({ instance_id: instanceKey, ...(entry as Record<string, unknown>) }));
  return mapValues.length > 0 ? mapValues : [];
}

function parseJsonlRecords(content: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parsed = parseJson(line);
    if (isRecord(parsed)) records.push(parsed);
  }
  return records;
}

function parseCsvRecords(content: string): Record<string, unknown>[] {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const record: Record<string, unknown> = {};
    header.forEach((key, index) => {
      record[key] = cells[index] ?? "";
    });
    return record;
  });
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function parseMarkdownTableRecords(content: string): Record<string, unknown>[] {
  const tableLines = content.split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
  if (tableLines.length < 2) return [];
  const header = splitMarkdownRow(tableLines[0]!);
  const bodyStart = isMarkdownSeparator(tableLines[1]!) ? 2 : 1;
  return tableLines.slice(bodyStart).map((line) => {
    const cells = splitMarkdownRow(line);
    const record: Record<string, unknown> = {};
    header.forEach((key, index) => {
      record[normalizeHeaderKey(key)] = cells[index] ?? "";
    });
    return record;
  });
}

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

function normalizeHeaderKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, "_");
}

// ----- modes ------------------------------------------------------------------

export async function runPrepare(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  void deps;
  await ensureOutputTree(config.out);
  const instances = await resolveInstances(config);
  const cliPath = config.vexpSweBenchDir === null ? null : path.join(config.vexpSweBenchDir, config.cliEntry);
  const plan = {
    mode: "prepare" as const,
    vexpSweBenchDir: config.vexpSweBenchDir,
    vexpSweBenchDirExists: config.vexpSweBenchDir === null ? false : await pathExists(config.vexpSweBenchDir),
    cliEntry: config.cliEntry,
    cliEntryPath: cliPath,
    cliEntryExists: cliPath === null ? false : await pathExists(cliPath),
    instances,
    instancesSelected: instances.length,
    vtraceMethod: config.vtraceMethod,
    outputDirs: {
      baselineRaw: rawConditionDir(config.out, "baseline"),
      vtraceRaw: rawConditionDir(config.out, "vtrace"),
    },
    commands: {
      baseline: renderCommand(buildBaselineCommand(config, instances)),
      vtrace: renderCommand(buildVtraceCommand(config, instances)),
    },
    notes: [
      instances.length === 0 ? "No instances selected; pass --instances or populate smoke_instances.json." : "",
      config.vexpSweBenchDir === null ? "No --vexp-swe-bench-dir provided." : "",
    ].filter((note) => note.length > 0),
  };
  await writeFile(path.join(config.out, "run_plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
}

export async function runBaseline(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  await runCondition(config, "baseline", deps);
}

export async function runVtrace(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  const dir = rawConditionDir(config.out, "vtrace");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "_vtrace_instructions.md"), `${vtraceInstructionsText()}\n`);
  await runCondition(config, "vtrace", deps);
}

async function runCondition(config: CliConfig, condition: Stage5Condition, deps: RunDeps): Promise<void> {
  if (config.vexpSweBenchDir === null) throw new Error(`--mode run-${condition} requires --vexp-swe-bench-dir.`);
  const cliPath = path.join(config.vexpSweBenchDir, config.cliEntry);
  if (!(await pathExists(cliPath))) {
    throw new Error(`vexp-swe-bench CLI not found at ${cliPath}. Run ./setup.sh in the external checkout first.`);
  }
  const instances = await resolveInstances(config);
  if (instances.length === 0) throw new Error(`--mode run-${condition} requires instances (via --instances or smoke_instances.json).`);

  const dir = rawConditionDir(config.out, condition);
  await mkdir(dir, { recursive: true });
  const spec = condition === "baseline" ? buildBaselineCommand(config, instances) : buildVtraceCommand(config, instances);
  const env = condition === "vtrace" ? (spec as { env: Record<string, string> }).env : {};
  const startedMs = Date.now();
  const result = await (deps.runProcess ?? runProcess)(spec.command, spec.args, {
    cwd: spec.cwd ?? undefined,
    env,
  });
  const meta = {
    condition,
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    env,
    instances,
    vtraceMethod: condition === "vtrace" ? config.vtraceMethod : null,
    exitCode: result.exitCode,
    durationMs: Date.now() - startedMs,
  };
  await writeFile(path.join(dir, "_run.stdout.txt"), result.stdout);
  await writeFile(path.join(dir, "_run.stderr.txt"), result.stderr);
  await writeFile(path.join(dir, "_run.meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  if (result.exitCode !== 0) {
    throw new Error(`run-${condition} exited ${result.exitCode}: ${result.stderr.trim() || "(no stderr)"}`);
  }
}

export async function runIngest(config: CliConfig, deps: RunDeps = {}): Promise<NormalizedArtifact> {
  void deps;
  await ensureOutputTree(config.out);
  const rows: Stage5Row[] = [];
  for (const condition of ["baseline", "vtrace"] as const) {
    rows.push(...(await parseConditionDir(rawConditionDir(config.out, condition), condition)));
  }
  const merged = mergeRows(rows);
  const artifact = buildArtifact(merged);
  await writeFile(path.join(config.out, NORMALIZED_FILENAME), `${JSON.stringify(artifact, null, 2)}\n`);
  await writeReports(config, artifact);
  return artifact;
}

export async function runReport(config: CliConfig, deps: RunDeps = {}): Promise<NormalizedArtifact> {
  await ensureOutputTree(config.out);
  const normalized = await readJsonIfExists(path.join(config.out, NORMALIZED_FILENAME));
  if (isRecord(normalized) && Array.isArray(normalized.rows)) {
    const rows = (normalized.rows as unknown[]).filter(isRecord) as unknown as Stage5Row[];
    const artifact = buildArtifact(rows);
    await writeReports(config, artifact);
    return artifact;
  }
  // No normalized intermediate yet: derive it from raw outputs.
  return runIngest(config, deps);
}

async function parseConditionDir(dir: string, condition: Stage5Condition): Promise<Stage5Row[]> {
  const files = await listFilesRecursive(dir).catch(() => [] as string[]);
  const rows: Stage5Row[] = [];
  for (const absolute of files) {
    const filename = path.basename(absolute);
    if (filename.startsWith(RUNNER_ARTIFACT_PREFIX)) continue;
    const content = await readFile(absolute, "utf8").catch(() => "");
    if (content.length === 0) continue;
    const rawResultPath = path.join("raw", condition, path.relative(dir, absolute));
    rows.push(...parseResultRecords(content, filename, condition, rawResultPath));
  }
  return rows;
}

// Merge duplicate (instance, condition) records, filling "unknown" fields from
// later records so partial outputs across files combine into one row.
function mergeRows(rows: readonly Stage5Row[]): Stage5Row[] {
  const byKey = new Map<string, Stage5Row>();
  for (const row of rows) {
    const key = `${row.instanceId} ${row.condition}`;
    const existing = byKey.get(key);
    byKey.set(key, existing === undefined ? row : mergeRow(existing, row));
  }
  return [...byKey.values()].sort((left, right) =>
    left.instanceId.localeCompare(right.instanceId) || left.condition.localeCompare(right.condition),
  );
}

function mergeRow(base: Stage5Row, next: Stage5Row): Stage5Row {
  const fill = <T>(a: Unknownable<T>, b: Unknownable<T>): Unknownable<T> => (a === "unknown" ? b : a);
  return {
    ...base,
    resolved: fill(base.resolved, next.resolved),
    costUsd: fill(base.costUsd, next.costUsd),
    durationMs: fill(base.durationMs, next.durationMs),
    inputTokens: fill(base.inputTokens, next.inputTokens),
    outputTokens: fill(base.outputTokens, next.outputTokens),
    totalTokens: fill(base.totalTokens, next.totalTokens),
    numTurns: fill(base.numTurns, next.numTurns),
    patchAvailable: fill(base.patchAvailable, next.patchAvailable),
    error: base.error ?? next.error,
    notes: [...new Set([...base.notes, ...next.notes])],
  };
}

function buildArtifact(rows: readonly Stage5Row[]): NormalizedArtifact {
  const pairs = comparePairs(rows);
  return { rows: [...rows], pairs, summary: summarize(rows, pairs) };
}

function summarize(rows: readonly Stage5Row[], pairs: readonly PairComparison[]): Stage5Summary {
  const bothResolved = pairs.filter((pair) => pair.outcome === "both_resolved");
  return {
    instanceCount: new Set(rows.map((row) => row.instanceId)).size,
    baselineRuns: rows.filter((row) => row.condition === "baseline").length,
    vtraceRuns: rows.filter((row) => row.condition === "vtrace").length,
    bothResolved: bothResolved.length,
    vtraceOnlyResolved: pairs.filter((pair) => pair.outcome === "vtrace_only_resolved").length,
    baselineOnlyResolved: pairs.filter((pair) => pair.outcome === "baseline_only_resolved").length,
    bothFailed: pairs.filter((pair) => pair.outcome === "both_failed").length,
    unpaired: pairs.filter((pair) => pair.outcome === "unpaired").length,
    unknown: pairs.filter((pair) => pair.outcome === "unknown").length,
    meanTokenReductionBothResolved: mean(bothResolved.map((pair) => pair.tokenReductionPct).filter(isNumber)),
    meanCostReductionBothResolved: mean(bothResolved.map((pair) => pair.costReductionPct).filter(isNumber)),
    meanDurationReductionBothResolved: mean(bothResolved.map((pair) => pair.durationReductionPct).filter(isNumber)),
    vtraceConditionRun: rows.some((row) => row.condition === "vtrace"),
  };
}

async function writeReports(config: CliConfig, artifact: NormalizedArtifact): Promise<void> {
  await writeFile(path.join(config.out, "stage5_vexp_swe_bench_smoke.csv"), renderCsv(artifact.rows));
  await writeFile(
    path.join(config.out, "stage5_vexp_swe_bench_smoke.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  await writeFile(
    path.join(config.out, "stage5_vexp_swe_bench_smoke.md"),
    renderMarkdown(artifact, config),
  );
}

export function renderCsv(rows: readonly Stage5Row[]): string {
  return `${[
    CSV_COLUMNS.join(","),
    ...rows.map((row) =>
      [
        row.instanceId,
        row.condition,
        cell(row.resolved),
        cell(row.costUsd),
        cell(row.durationMs),
        cell(row.inputTokens),
        cell(row.outputTokens),
        cell(row.totalTokens),
        cell(row.numTurns),
        cell(row.patchAvailable),
        row.error ?? "",
        row.rawResultPath,
        row.notes.join("; "),
      ]
        .map(csvEscape)
        .join(","),
    ),
  ].join("\n")}\n`;
}

export function renderMarkdown(artifact: NormalizedArtifact, config: CliConfig): string {
  const { rows, pairs, summary } = artifact;
  const lines: string[] = [
    "# Stage 5 vexp-swe-bench Smoke Benchmark",
    "",
    "## Scope",
    "",
    `> ${PUBLIC_CLAIM_DISCLAIMER}`,
    "",
    "Stage 5 is an external smoke benchmark. It does not claim that vtrace beats vexp, that vtrace has better SWE-bench pass@1, public leaderboard performance, full 100-task results, or statistical significance. It only checks whether the benchmark workflow runs on a tiny subset.",
    "",
    "## Setup",
    "",
    `- External benchmark dir: ${config.vexpSweBenchDir ?? "(not provided)"}`,
    `- CLI entry: ${config.cliEntry}`,
    `- vtrace method: ${config.vtraceMethod}`,
    "",
    "See README.md for the full clone/setup workflow. vexp-swe-bench is not vendored.",
    "",
    "## Instance set",
    "",
    summary.instanceCount === 0
      ? "No instances have been ingested yet."
      : [...new Set(rows.map((row) => row.instanceId))].sort().map((id) => `- ${id}`).join("\n"),
    "",
    "## Baseline vs vtrace summary",
    "",
  ];

  if (!summary.vtraceConditionRun) {
    lines.push(
      "> Note: No vtrace condition results were found. Only the baseline condition has been ingested so far, so no baseline-vs-vtrace comparison is possible yet. Run `--mode run-vtrace` (with a documented vtrace method) and re-ingest.",
      "",
    );
  }

  lines.push(
    "| Metric | Value |",
    "| --- | ---: |",
    `| Instances | ${summary.instanceCount} |`,
    `| Baseline runs | ${summary.baselineRuns} |`,
    `| Vtrace runs | ${summary.vtraceRuns} |`,
    `| Both resolved | ${summary.bothResolved} |`,
    `| Vtrace only resolved | ${summary.vtraceOnlyResolved} |`,
    `| Baseline only resolved | ${summary.baselineOnlyResolved} |`,
    `| Both failed | ${summary.bothFailed} |`,
    `| Unpaired | ${summary.unpaired} |`,
    `| Unknown | ${summary.unknown} |`,
    `| Mean token reduction (both resolved) | ${formatPct(summary.meanTokenReductionBothResolved)} |`,
    `| Mean cost reduction (both resolved) | ${formatPct(summary.meanCostReductionBothResolved)} |`,
    `| Mean duration reduction (both resolved) | ${formatPct(summary.meanDurationReductionBothResolved)} |`,
    "",
    "## Per-instance table",
    "",
    renderPairTable(pairs),
    "",
    "## Missing/unknown fields",
    "",
    renderUnknownFields(rows),
    "",
    "## Failures/errors",
    "",
    renderFailures(rows),
    "",
    "## Interpretation",
    "",
    "Pass/resolution is primary. Token, cost, and duration reductions are only meaningful for instances where both conditions resolved. A `vtrace_only_resolved` instance is a qualitative win even if tokens are higher. Any `unknown` field means the benchmark output did not expose that value; it was not guessed.",
    "",
    "## Next step",
    "",
    "If the workflow holds on this tiny subset, expand the instance set gradually and, separately, add an explicit vexp-enabled condition before making any vexp-vs-vtrace comparison. This smoke run does not authorize public SWE-bench claims.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function renderPairTable(pairs: readonly PairComparison[]): string {
  if (pairs.length === 0) return "No paired instances have been ingested yet.";
  return [
    "| instance | baseline resolved | vtrace resolved | outcome | baseline tokens | vtrace tokens | token reduction | cost reduction | duration reduction |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...pairs.map((pair) =>
      `| ${pair.instanceId} | ${cellOrDash(pair.baselineResolved)} | ${cellOrDash(pair.vtraceResolved)} | ${pair.outcome} | ${cellOrDash(pair.baselineTotalTokens)} | ${cellOrDash(pair.vtraceTotalTokens)} | ${formatPct(pair.tokenReductionPct)} | ${formatPct(pair.costReductionPct)} | ${formatPct(pair.durationReductionPct)} |`,
    ),
  ].join("\n");
}

function renderUnknownFields(rows: readonly Stage5Row[]): string {
  const withUnknown = rows
    .map((row) => ({ row, fields: unknownFieldsOf(row) }))
    .filter((entry) => entry.fields.length > 0);
  if (withUnknown.length === 0) return "No unknown fields; all expected fields were present in benchmark output.";
  return withUnknown.map((entry) => `- ${entry.row.instanceId}.${entry.row.condition}: ${entry.fields.join(", ")}`).join("\n");
}

function unknownFieldsOf(row: Stage5Row): string[] {
  const fields: Array<[string, Unknownable<unknown>]> = [
    ["resolved", row.resolved],
    ["cost_usd", row.costUsd],
    ["duration_ms", row.durationMs],
    ["input_tokens", row.inputTokens],
    ["output_tokens", row.outputTokens],
    ["total_tokens", row.totalTokens],
    ["num_turns", row.numTurns],
    ["patch_available", row.patchAvailable],
  ];
  return fields.filter(([, value]) => value === "unknown").map(([name]) => name);
}

function renderFailures(rows: readonly Stage5Row[]): string {
  const failures = rows.filter((row) => row.error !== null || row.resolved === false);
  if (failures.length === 0) return "No errors or unresolved instances recorded.";
  return failures
    .map((row) => `- ${row.instanceId}.${row.condition}: ${row.error ?? (row.resolved === false ? "unresolved" : "")}`)
    .join("\n");
}

// ----- low-level helpers ------------------------------------------------------

function renderCommand(spec: { command: string; args: readonly string[] }): string {
  return [spec.command, ...spec.args].join(" ");
}

function cell(value: Unknownable<unknown>): string {
  if (value === "unknown") return "unknown";
  if (value === null || value === undefined) return "";
  return String(value);
}

function cellOrDash(value: Unknownable<unknown> | null): string {
  if (value === null || value === undefined) return "—";
  return cell(value);
}

async function ensureOutputTree(outDir: string): Promise<void> {
  for (const subdir of ["raw/baseline", "raw/vtrace"]) {
    await mkdir(path.join(outDir, subdir), { recursive: true });
  }
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesRecursive(absolute)));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

async function pathExists(target: string): Promise<boolean> {
  return stat(target).then(() => true).catch(() => false);
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    return null;
  }
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
): Promise<ProcessResult> {
  return await new Promise((resolve) => {
    const proc = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on("error", (error) =>
      resolve({ exitCode: 1, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: `${Buffer.concat(stderrChunks).toString("utf8")}${error.message}` }),
    );
    proc.on("close", (code) =>
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: Buffer.concat(stderrChunks).toString("utf8") }),
    );
  });
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function formatPct(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "n/a" : `${value.toFixed(2)}%`;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
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

export function parseArgs(argv: readonly string[]): CliConfig {
  const config = { ...DEFAULT_CONFIG };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case "--mode": {
        const value = requireValue(argv, ++index, arg);
        if (!["prepare", "run-baseline", "run-vtrace", "ingest", "report"].includes(value)) throw new Error("Invalid --mode.");
        config.mode = value as Stage5Mode;
        break;
      }
      case "--vexp-swe-bench-dir": config.vexpSweBenchDir = requireValue(argv, ++index, arg); break;
      case "--instances": config.instances = requireValue(argv, ++index, arg).split(",").map((value) => value.trim()).filter(Boolean); break;
      case "--instances-file": config.instancesFile = requireValue(argv, ++index, arg); break;
      case "--out": config.out = requireValue(argv, ++index, arg); break;
      case "--node-command": config.nodeCommand = requireValue(argv, ++index, arg); break;
      case "--cli-entry": config.cliEntry = requireValue(argv, ++index, arg); break;
      case "--vtrace-method": {
        const value = requireValue(argv, ++index, arg);
        if (!["instructions-file", "mcp", "local-patch"].includes(value)) throw new Error("Invalid --vtrace-method.");
        config.vtraceMethod = value as VtraceMethod;
        break;
      }
      case "--yes": config.yes = true; break;
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
    vexpSweBenchDir: config.vexpSweBenchDir === null ? null : path.resolve(config.vexpSweBenchDir),
    instancesFile: path.resolve(config.instancesFile),
    out: path.resolve(config.out),
  };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function printUsageAndExit(exitCode: number): never {
  process.stdout.write(
    "Usage: bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts --mode prepare|run-baseline|run-vtrace|ingest|report --vexp-swe-bench-dir /path/to/vexp-swe-bench --instances id1,id2,id3 --out benchmarks/stage5_vexp_swe_bench_smoke/results\n",
  );
  process.exit(exitCode);
}

async function main(config: CliConfig): Promise<void> {
  switch (config.mode) {
    case "prepare": await runPrepare(config); break;
    case "run-baseline": await runBaseline(config); break;
    case "run-vtrace": await runVtrace(config); break;
    case "ingest": await runIngest(config); break;
    case "report": await runReport(config); break;
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
