import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// Stage 5 is a SMOKE integration harness around the external `vexp-swe-bench`
// benchmark. It proves the baseline-vs-vtrace measurement workflow on a tiny
// subset. It does not vendor vexp-swe-bench, does not run the full benchmark,
// and makes no public SWE-bench claim. See README.md for scope.

export type Stage5Mode =
  | "prepare"
  | "run-baseline"
  | "run-vtrace"
  | "ingest"
  | "report"
  | "install-vtrace-patch"
  | "verify-vtrace-patch";
export type Stage5Condition = "baseline" | "vtrace";
export type VtraceMethod = "instructions-file" | "mcp" | "local-patch" | "indexed-context";
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
  // Stage 5B (indexed-context) configuration.
  readonly vtraceCommand: string;
  readonly vtraceIndexArgs: string;
  readonly vtraceQueryArgs: string;
  readonly skipVtraceIndexIfPresent: boolean;
  readonly vtraceContextMaxChars: number;
  readonly vtraceContextMaxItems: number;
  readonly sweBenchDataFile: string | null;
  readonly runLabel: string | null;
}

export interface SmokeInstancesFile {
  readonly instances: readonly string[];
  readonly notes: readonly string[];
}

// Stage 5B (indexed-context) fields. null on baseline rows / when not run; on
// vtrace rows they describe the actual vtrace indexing + query that produced the
// injected context. Shared between normalized rows and run-level evidence.
export interface IndexedContextFields {
  readonly vtraceIndexedContext: boolean | "unknown" | null;
  readonly vtraceIndexCommand: string | null;
  readonly vtraceQueryCommand: string | null;
  readonly vtraceWorkspacePath: string | null;
  readonly vtraceContextFile: string | null;
  readonly vtraceContextChars: number | null;
  readonly vtraceContextItems: number | null;
  readonly vtraceContextTruncated: boolean | null;
  readonly vtraceContextError: string | null;
}

export interface Stage5Row extends IndexedContextFields {
  readonly instanceId: string;
  readonly condition: Stage5Condition;
  readonly resolved: Unknownable<boolean>;
  readonly costUsd: Unknownable<number>;
  readonly durationMs: Unknownable<number>;
  readonly inputTokens: Unknownable<number>;
  readonly outputTokens: Unknownable<number>;
  readonly cacheReadTokens: Unknownable<number>;
  readonly cacheCreationTokens: Unknownable<number>;
  readonly totalTokens: Unknownable<number>;
  readonly tokenAccountingMethod: string;
  readonly numTurns: Unknownable<number>;
  readonly toolCallsTotal: Unknownable<number>;
  readonly toolCallsBreakdown: string | null;
  readonly patchAvailable: Unknownable<boolean>;
  readonly patchLines: Unknownable<number>;
  readonly model: string | null;
  readonly agent: string | null;
  readonly repo: string | null;
  // vtrace local-patch run context. null on baseline rows; populated on vtrace
  // rows from the recorded run metadata + captured stderr (see collectRunEvidence).
  readonly vtraceMethod: string | null;
  readonly vtraceInstructionsFile: string | null;
  readonly vtraceInstructionsFileExists: boolean | null;
  readonly vtraceInstructionsFileSize: number | null;
  readonly vtraceInjectionObserved: boolean | "unknown" | null;
  readonly vtraceInjectionError: string | null;
  readonly vtraceTreatmentValid: boolean | "unknown" | null;
  readonly error: string | null;
  readonly rawResultPath: string;
  readonly parserKind: string;
  readonly parsedFieldCount: number;
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
  // From the vtrace row: false means the vtrace injection was skipped, so the
  // efficiency deltas must NOT be advertised as vtrace performance for this pair.
  readonly vtraceTreatmentValid: boolean | "unknown" | null;
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

// Run-level evidence reconstructed from the captured raw artifacts (run meta +
// stderr + patch manifest), NOT from the CLI config. The report trusts what the
// run actually recorded over what was requested.
export interface Stage5RunEvidence extends IndexedContextFields {
  // The vtrace method as recorded in the vtrace run meta. "unknown" if no vtrace
  // run was recorded; "mixed" if recorded vtrace runs disagree.
  readonly vtraceMethod: VtraceMethod | "unknown" | "mixed";
  readonly vtracePatchInstalled: boolean | "unknown";
  readonly vtraceInstructionsFile: string | null;
  readonly vtraceInstructionsFileExists: boolean;
  readonly vtraceInstructionsFileSize: number | null;
  // Whether "Stage5 vtrace instructions injected from ..." was seen in the
  // captured vtrace stderr. "unknown" if no vtrace run was captured.
  readonly vtraceInjectionObserved: boolean | "unknown";
  // The "Stage5 vtrace injection skipped: ..." line, if injection was skipped.
  readonly vtraceInjectionError: string | null;
  // True only for a local-patch vtrace run whose injection was actually observed.
  // false means the vtrace condition was a no-op (not a real vtrace treatment).
  readonly vtraceTreatmentValid: boolean | "unknown";
  readonly notes: readonly string[];
}

export interface NormalizedArtifact {
  readonly rows: readonly Stage5Row[];
  readonly pairs: readonly PairComparison[];
  readonly summary: Stage5Summary;
  readonly evidence: Stage5RunEvidence;
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
  // Stage 5B: the vtrace CLI invocation; index/query subcommands are appended.
  // Run Stage 5B from the vtrace repo root so `src/cli/index.ts` resolves.
  vtraceCommand: "bun src/cli/index.ts",
  vtraceIndexArgs: "--quiet",
  vtraceQueryArgs: "",
  skipVtraceIndexIfPresent: false,
  vtraceContextMaxChars: 12000,
  vtraceContextMaxItems: 8,
  sweBenchDataFile: null,
  runLabel: null,
};

const CSV_COLUMNS = [
  "instance_id",
  "condition",
  "resolved",
  "cost_usd",
  "duration_ms",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "total_tokens",
  "token_accounting_method",
  "num_turns",
  "tool_calls_total",
  "patch_available",
  "vtrace_method",
  "vtrace_injection_observed",
  "vtrace_indexed_context",
  "vtrace_treatment_valid",
  "error",
  "raw_result_path",
  "parser_kind",
  "notes",
];

const NORMALIZED_FILENAME = "stage5_normalized.json";

// Idempotency / discoverability marker embedded in the patched external file and
// recorded in the manifest. Its presence means "already patched, do not touch".
export const STAGE5_VTRACE_PATCH_MARKER = "STAGE5_VTRACE_INSTRUCTIONS_PATCH";

const VTRACE_PATCH_MANIFEST_FILENAME = "vtrace_patch_manifest.json";
const VTRACE_PATCH_BACKUP_SUFFIX = ".stage5-vtrace-backup";

// Stderr line the patched adapter logs when it actually injects the instructions
// at runtime. ingest greps the captured vtrace stderr for this exact prefix to
// prove the injection executed (not merely that the patch is installed on disk).
export const STAGE5_VTRACE_INJECTION_LOG = "Stage5 vtrace instructions injected from";

// Stderr line the patched adapter logs when the instructions file is set but
// could not be read (e.g. it was wiped from the output dir). Its presence proves
// the vtrace condition ran WITHOUT the injected context — i.e. a no-op.
export const STAGE5_VTRACE_INJECTION_SKIPPED = "Stage5 vtrace injection skipped";

// Candidate locations (relative to --vexp-swe-bench-dir) for the Claude Code
// adapter that builds the `claude -p <prompt>` invocation. dist/ is preferred
// because `node dist/cli.js run ...` executes the built output directly.
const CLAUDE_ADAPTER_CANDIDATES: readonly string[] = [
  "dist/agents/claude-code.js",
  "dist/agents/claude-code.mjs",
  "src/agents/claude-code.ts",
];

// Anchor line in the adapter's run() method; the injection block is inserted
// immediately after it, before the `claude -p` args array is assembled.
const VTRACE_PATCH_ANCHOR = "const startMs = Date.now();";

export interface VtracePatchManifest {
  readonly installed: boolean;
  readonly vexpSweBenchDir: string;
  readonly patchedFiles: readonly string[];
  readonly backupFiles: readonly string[];
  readonly patchMarker: string;
  readonly notes: readonly string[];
}

export interface VtracePatchVerification {
  readonly installed: boolean;
  readonly vexpSweBenchDir: string;
  readonly patchedFile: string | null;
  readonly backupPresent: boolean;
  readonly manifestPresent: boolean;
  readonly notes: readonly string[];
}

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

// The vtrace instructions file lives at the results ROOT, deliberately NOT under
// the per-condition raw/<condition> dir. vexp-swe-bench's `run` clears its
// `--output` dir (raw/vtrace) at start (cleanPreviousRun), which would delete an
// instructions file written there before the agent ever reads it — the original
// cause of the "injection skipped: ENOENT" no-op. The results root is never
// passed to vexp as --output, so the file survives the run.
export function vtraceInstructionsFilePath(outDir: string): string {
  return path.join(outDir, "_vtrace_instructions.md");
}

function vtraceEnv(config: CliConfig): Record<string, string> {
  return {
    VTRACE_SMOKE: "1",
    VTRACE_METHOD: config.vtraceMethod,
    VTRACE_AGENT_INSTRUCTIONS_FILE: vtraceInstructionsFilePath(config.out),
  };
}

export function vtraceInstructionsText(): string {
  return [
    "# vtrace instructions",
    "",
    "You are running with vtrace assistance enabled.",
    "",
    "Before editing, use vtrace-oriented repository navigation when useful:",
    "- identify likely files/symbols before broad exploration",
    "- prefer compact symbol/context lookup over opening many files",
    "- use vtrace context if available in this repository",
    "- keep vexp disabled",
    "",
    "If vtrace tooling is unavailable in this task environment, continue normally",
    "but do not use vexp.",
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
      vtraceTreatmentValid: vtrace?.vtraceTreatmentValid ?? null,
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
  cacheReadTokens: ["cache_read_tokens", "cacheReadTokens", "cache_read_input_tokens"],
  cacheCreationTokens: ["cache_creation_tokens", "cacheCreationTokens", "cache_creation_input_tokens"],
  totalTokens: ["total_tokens", "totalTokens", "tokens"],
  numTurns: ["num_turns", "numTurns", "turns", "iterations", "steps"],
  toolCalls: ["tool_calls", "toolCalls"],
  patch: ["modelPatch", "patch", "model_patch", "prediction", "patch_path", "model_patch_path"],
  model: ["model"],
  agent: ["agent"],
  repo: ["repo"],
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

// Sum input/output/cache token components for total_tokens, recording exactly
// which fields contributed (token_accounting_method) so the report never hides
// that cache tokens dominate. An explicit total_tokens is only trusted when no
// components are present.
function accountTokens(
  inputTokens: Unknownable<number>,
  outputTokens: Unknownable<number>,
  cacheReadTokens: Unknownable<number>,
  cacheCreationTokens: Unknownable<number>,
  explicitTotal: Unknownable<number>,
): { totalTokens: Unknownable<number>; method: string } {
  const components: Array<[string, Unknownable<number>]> = [
    ["input", inputTokens],
    ["output", outputTokens],
    ["cache_read", cacheReadTokens],
    ["cache_creation", cacheCreationTokens],
  ];
  const present = components.filter(([, value]) => isNumber(value)) as Array<[string, number]>;
  if (present.length > 0) {
    return {
      totalTokens: present.reduce((sum, [, value]) => sum + value, 0),
      method: present.map(([name]) => name).join("+"),
    };
  }
  if (isNumber(explicitTotal)) return { totalTokens: explicitTotal, method: "total_tokens" };
  return { totalTokens: "unknown", method: "unavailable" };
}

// vexp-swe-bench reports tool usage as an object of {ToolName: count}; the total
// is the sum of those counts. We also retain the raw breakdown as a JSON string.
function accountToolCalls(value: unknown): { total: Unknownable<number>; breakdown: string | null } {
  if (!isRecord(value)) return { total: "unknown", breakdown: null };
  const counts = Object.values(value).filter(isNumber);
  if (counts.length === 0) return { total: "unknown", breakdown: JSON.stringify(value) };
  return { total: counts.reduce((sum, count) => sum + count, 0), breakdown: JSON.stringify(value) };
}

export function extractRow(
  record: Record<string, unknown>,
  condition: Stage5Condition,
  rawResultPath: string,
  parserKind = "json",
): Stage5Row | null {
  const instanceRaw = pick(record, FIELD_ALIASES.instanceId!);
  if (!isString(instanceRaw)) return null;

  const inputTokens = asUnknownableNumber(pick(record, FIELD_ALIASES.inputTokens!));
  const outputTokens = asUnknownableNumber(pick(record, FIELD_ALIASES.outputTokens!));
  const cacheReadTokens = asUnknownableNumber(pick(record, FIELD_ALIASES.cacheReadTokens!));
  const cacheCreationTokens = asUnknownableNumber(pick(record, FIELD_ALIASES.cacheCreationTokens!));
  const { totalTokens, method } = accountTokens(
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    asUnknownableNumber(pick(record, FIELD_ALIASES.totalTokens!)),
  );

  const toolCalls = accountToolCalls(pick(record, FIELD_ALIASES.toolCalls!));

  // resolved is left as "unknown" when null/absent: a generated-but-unevaluated
  // patch must never be coerced to a pass or a fail.
  const resolvedValue = pick(record, FIELD_ALIASES.resolved!);
  const resolved = resolvedValue === undefined ? "unknown" : asUnknownableBoolean(resolvedValue);

  const patchValue = pick(record, FIELD_ALIASES.patch!);
  const patchIsString = isString(patchValue);
  const patchAvailable: Unknownable<boolean> =
    patchValue === undefined ? "unknown" : patchIsString ? patchValue.trim().length > 0 : Boolean(patchValue);
  const patchLines: Unknownable<number> = patchIsString
    ? patchValue.replace(/\n$/, "").split(/\r?\n/).length
    : "unknown";

  const errorValue = pick(record, FIELD_ALIASES.error!);
  const modelValue = pick(record, FIELD_ALIASES.model!);
  const agentValue = pick(record, FIELD_ALIASES.agent!);
  const repoValue = pick(record, FIELD_ALIASES.repo!);

  const row: Stage5Row = {
    instanceId: instanceRaw,
    condition,
    resolved,
    costUsd: asUnknownableNumber(pick(record, FIELD_ALIASES.costUsd!)),
    durationMs: asUnknownableNumber(pick(record, FIELD_ALIASES.durationMs!)),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    tokenAccountingMethod: method,
    numTurns: asUnknownableNumber(pick(record, FIELD_ALIASES.numTurns!)),
    toolCallsTotal: toolCalls.total,
    toolCallsBreakdown: toolCalls.breakdown,
    patchAvailable,
    patchLines,
    model: isString(modelValue) ? modelValue : null,
    agent: isString(agentValue) ? agentValue : null,
    repo: isString(repoValue) ? repoValue : null,
    // vtrace run context is stamped onto vtrace rows during ingest, not parsed
    // from the per-instance result record; default to null here.
    vtraceMethod: null,
    vtraceInstructionsFile: null,
    vtraceInstructionsFileExists: null,
    vtraceInstructionsFileSize: null,
    vtraceInjectionObserved: null,
    vtraceInjectionError: null,
    vtraceTreatmentValid: null,
    ...nullIndexedContextFields(),
    error: isString(errorValue) ? errorValue : null,
    rawResultPath,
    parserKind,
    parsedFieldCount: 0,
    notes: [],
  };
  return { ...row, parsedFieldCount: countParsedFields(row) };
}

// Count normalized fields that carry a concrete (non-"unknown", non-null) value,
// for the diagnostics block. instanceId is always present so it always counts.
function countParsedFields(row: Stage5Row): number {
  const values: Array<Unknownable<unknown> | string | null> = [
    row.instanceId,
    row.resolved,
    row.costUsd,
    row.durationMs,
    row.inputTokens,
    row.outputTokens,
    row.cacheReadTokens,
    row.cacheCreationTokens,
    row.totalTokens,
    row.numTurns,
    row.toolCallsTotal,
    row.patchAvailable,
    row.patchLines,
    row.model,
    row.agent,
    row.repo,
  ];
  return values.filter((value) => value !== "unknown" && value !== null).length;
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
  const parserKind = parserKindFor(filename);
  const rows: Stage5Row[] = [];
  for (const record of records) {
    const row = extractRow(record, condition, rawResultPath, parserKind);
    if (row !== null) rows.push(row);
  }
  return rows;
}

// Canonical vexp-swe-bench result logs are named `swebench-<date>.jsonl` and use
// the camelCase schema; tag them so the report records which reader was used.
export function parserKindFor(filename: string): string {
  const base = filename.toLowerCase();
  if (/^swebench-.*\.jsonl$/.test(base)) return "vexp_swebench_jsonl";
  const ext = path.extname(base);
  if (ext === ".jsonl") return "jsonl";
  if (ext === ".json") return "json";
  if (ext === ".csv") return "csv";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  return "unknown";
}

// True when a file is a canonical vexp-swe-bench result log. When any are
// present in a condition dir we parse ONLY those, so run metadata/stdout never
// competes with the real result rows.
export function isCanonicalResultFile(filename: string): boolean {
  return /^swebench-.*\.jsonl$/i.test(filename);
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
  await ensureOutputTree(config.out);
  // The instructions/context file lives at the results root (survives vexp's
  // --output wipe) so the patched adapter can read it at runtime.
  const instructionsPath = vtraceInstructionsFilePath(config.out);
  let extraVtraceMeta: Record<string, unknown> = {};

  if (config.vtraceMethod === "indexed-context") {
    // Stage 5B: real vtrace indexing + query produces the injected context. The
    // local prompt patch is the injection mechanism, so require it first. Then
    // build the context; if it cannot be generated, abort BEFORE spawning vexp —
    // never silently fall back to generic instructions or spend tokens on a
    // non-treatment run.
    await assertVtracePatchInstalled(config);
    const indexed = await prepareIndexedContext(config, deps);
    extraVtraceMeta = indexedContextMetaFields(indexed);
    if (!indexed.indexedContext) {
      throw new Error(
        `indexed-context preparation produced no vtrace context (${indexed.contextError ?? "unknown error"}); ` +
          "aborting before spawn so no tokens are spent on a non-treatment run.",
      );
    }
    await assertVtraceInstructionsFileValid(instructionsPath);
  } else {
    // Generic instructions-file / local-patch: write the generic instructions.
    await writeFile(instructionsPath, `${vtraceInstructionsText()}\n`);
    if (config.vtraceMethod === "local-patch") {
      await assertVtraceInstructionsFileValid(instructionsPath);
      await assertVtracePatchInstalled(config);
    }
  }
  await runCondition(config, "vtrace", deps, extraVtraceMeta);
}

// Throws unless the vtrace instructions file exists and is non-empty. Called
// before spawning the external CLI so a no-op vtrace run is caught up front.
export async function assertVtraceInstructionsFileValid(instructionsPath: string): Promise<void> {
  const stats = await stat(instructionsPath).catch(() => null);
  if (stats === null || !stats.isFile()) {
    throw new Error(`vtrace instructions file is missing at ${instructionsPath}; aborting before spawn.`);
  }
  if (stats.size === 0) {
    throw new Error(`vtrace instructions file at ${instructionsPath} is empty; aborting before spawn.`);
  }
}

// ----- Stage 5B: indexed-context mode ----------------------------------------

const DEFAULT_SWE_BENCH_DATA_RELPATH = path.join("data", "swe-bench-100.jsonl");
// Hard cap on the query string passed to the vtrace CLI as an argv element.
const MAX_VTRACE_QUERY_CHARS = 8000;

export interface SweBenchInstance {
  readonly repo: string;
  readonly instanceId: string;
  readonly baseCommit: string;
  readonly problemStatement: string;
  readonly hintsText: string | null;
  readonly failToPass: readonly string[];
}

export interface IndexedContextResult {
  readonly indexedContext: boolean;
  readonly indexCommand: string | null;
  readonly queryCommand: string | null;
  readonly workspacePath: string | null;
  readonly contextFile: string;
  readonly contextChars: number;
  readonly contextItems: number;
  readonly contextTruncated: boolean;
  readonly contextError: string | null;
}

// Resolve the bundled vexp-swe-bench dataset path (overridable via --swe-bench-data).
export function sweBenchDataPath(config: CliConfig): string {
  if (config.sweBenchDataFile !== null) return config.sweBenchDataFile;
  if (config.vexpSweBenchDir === null) {
    throw new Error("indexed-context requires --vexp-swe-bench-dir (or --swe-bench-data) to locate instance data.");
  }
  return path.join(config.vexpSweBenchDir, DEFAULT_SWE_BENCH_DATA_RELPATH);
}

// Parse the SWE-bench JSONL dataset into raw records (one JSON object per line).
export async function loadSweBenchData(dataPath: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(dataPath, "utf8").catch(() => null);
  if (content === null) throw new Error(`SWE-bench data file not found at ${dataPath}.`);
  return parseJsonlRecords(content);
}

export function findSweBenchRecord(
  records: readonly Record<string, unknown>[],
  instanceId: string,
): Record<string, unknown> | null {
  return records.find((record) => record.instance_id === instanceId || record.instanceId === instanceId) ?? null;
}

// Validate and normalize a raw record into a SweBenchInstance. Throws a clear
// error naming any missing required field — never fabricates data.
export function toSweBenchInstance(record: Record<string, unknown>): SweBenchInstance {
  const repo = pick(record, ["repo"]);
  const instanceId = pick(record, FIELD_ALIASES.instanceId!);
  const baseCommit = pick(record, ["base_commit", "baseCommit"]);
  const problemStatement = pick(record, ["problem_statement", "problemStatement"]);
  const missing = [
    !isString(repo) ? "repo" : "",
    !isString(instanceId) ? "instance_id" : "",
    !isString(baseCommit) ? "base_commit" : "",
    !isString(problemStatement) ? "problem_statement" : "",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`SWE-bench record is missing required field(s): ${missing.join(", ")}.`);
  }
  const hints = pick(record, ["hints_text", "hintsText"]);
  const failRaw = pick(record, ["FAIL_TO_PASS", "fail_to_pass", "failToPass"]);
  return {
    repo: repo as string,
    instanceId: instanceId as string,
    baseCommit: baseCommit as string,
    problemStatement: problemStatement as string,
    hintsText: isString(hints) ? hints : null,
    failToPass: normalizeTestList(failRaw),
  };
}

// FAIL_TO_PASS is sometimes a JSON array and sometimes a JSON-encoded string.
function normalizeTestList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(isString);
  if (isString(value)) {
    const parsed = parseJson(value);
    if (Array.isArray(parsed)) return parsed.filter(isString);
  }
  return [];
}

// Our own isolated checkout for an instance (Approach B), kept out of the per
// condition raw/<condition> dirs and out of vexp's .bench-repos.
export function workspacePathFor(outDir: string, instanceId: string, runLabel: string | null = null): string {
  const base = path.join(outDir, "workspaces");
  return runLabel === null ? path.join(base, instanceId) : path.join(base, runLabel, instanceId);
}

export function buildCloneCommand(repo: string, workspace: string): { command: string; args: string[] } {
  return { command: "git", args: ["clone", `https://github.com/${repo}.git`, workspace] };
}

export function buildCheckoutCommand(workspace: string, baseCommit: string): { command: string; args: string[] } {
  return { command: "git", args: ["-C", workspace, "checkout", baseCommit, "--force"] };
}

function splitArgs(value: string): string[] {
  return value.split(/\s+/).filter((part) => part.length > 0);
}

export function buildVtraceIndexCommand(config: CliConfig, workspace: string): { command: string; args: string[] } {
  const [command, ...base] = splitArgs(config.vtraceCommand);
  if (command === undefined) throw new Error("--vtrace-command is empty; cannot build the vtrace index command.");
  return { command, args: [...base, "index", workspace, ...splitArgs(config.vtraceIndexArgs)] };
}

export function buildVtraceQueryCommand(
  config: CliConfig,
  workspace: string,
  query: string,
): { command: string; args: string[] } {
  const [command, ...base] = splitArgs(config.vtraceCommand);
  if (command === undefined) throw new Error("--vtrace-command is empty; cannot build the vtrace query command.");
  return { command, args: [...base, "capsule", workspace, query, ...splitArgs(config.vtraceQueryArgs)] };
}

// Build the vtrace query string from an instance: the problem statement is the
// core, optionally augmented with repo/instance/hints/failing-test signals.
export function buildInstanceQuery(instance: SweBenchInstance): string {
  const parts = [
    `repo: ${instance.repo}`,
    `instance: ${instance.instanceId}`,
    "",
    instance.problemStatement,
  ];
  if (instance.failToPass.length > 0) {
    parts.push("", `failing tests: ${instance.failToPass.join(", ")}`);
  }
  if (instance.hintsText) parts.push("", `hints: ${instance.hintsText}`);
  const query = parts.join("\n").trim();
  return query.length > MAX_VTRACE_QUERY_CHARS ? query.slice(0, MAX_VTRACE_QUERY_CHARS) : query;
}

// Truncate one instance's raw vtrace context by item count (non-empty lines) then
// by character budget, appending a clear marker when the char budget bites.
export function truncateContext(
  raw: string,
  maxChars: number,
  maxItems: number,
): { text: string; chars: number; items: number; truncated: boolean } {
  const lines = raw.split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  let truncated = false;
  let kept = lines;
  let items = nonEmpty.length;
  if (nonEmpty.length > maxItems) {
    // Keep lines up to and including the maxItems-th non-empty line.
    let seen = 0;
    const limited: string[] = [];
    for (const line of lines) {
      if (line.trim().length > 0) {
        if (seen >= maxItems) break;
        seen += 1;
      }
      limited.push(line);
    }
    kept = limited;
    items = maxItems;
    truncated = true;
  }
  let text = kept.join("\n").trimEnd();
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n[truncated to ${maxChars} chars]`;
    truncated = true;
  }
  return { text, chars: text.length, items, truncated };
}

export interface VtraceContextSection {
  readonly instance: SweBenchInstance;
  readonly rawContext: string;
  readonly error: string | null;
}

// Assemble the full _vtrace_instructions.md content (one section per instance)
// and report aggregate size/item/truncation metadata.
export function buildVtraceContextMarkdown(
  sections: readonly VtraceContextSection[],
  limits: { maxChars: number; maxItems: number },
): { markdown: string; chars: number; items: number; truncated: boolean } {
  const lines: string[] = [
    "# vtrace indexed context",
    "",
    "This benchmark condition uses vtrace-indexed context. vexp is disabled.",
    "",
  ];
  let totalChars = 0;
  let totalItems = 0;
  let anyTruncated = false;
  for (const section of sections) {
    const { instance } = section;
    lines.push(
      "## Instance",
      "",
      `- instance_id: ${instance.instanceId}`,
      `- repo: ${instance.repo}`,
      `- base_commit: ${instance.baseCommit}`,
      "",
      "## Problem statement",
      "",
      instance.problemStatement.trim(),
      "",
      "## vtrace context",
      "",
    );
    if (section.error !== null || section.rawContext.trim().length === 0) {
      lines.push(`(vtrace context unavailable: ${section.error ?? "empty output"})`, "");
    } else {
      const truncatedContext = truncateContext(section.rawContext, limits.maxChars, limits.maxItems);
      lines.push(truncatedContext.text, "");
      totalChars += truncatedContext.chars;
      totalItems += truncatedContext.items;
      anyTruncated = anyTruncated || truncatedContext.truncated;
    }
    lines.push(
      "## Instruction",
      "",
      "Use the vtrace context above to orient before broad search. It may be incomplete; verify with local files/tests before editing.",
      "",
    );
  }
  return { markdown: `${lines.join("\n")}\n`, chars: totalChars, items: totalItems, truncated: anyTruncated };
}

// Map the orchestration result onto the flat IndexedContextFields meta keys.
function indexedContextMetaFields(result: IndexedContextResult): IndexedContextFields {
  return {
    vtraceIndexedContext: result.indexedContext,
    vtraceIndexCommand: result.indexCommand,
    vtraceQueryCommand: result.queryCommand,
    vtraceWorkspacePath: result.workspacePath,
    vtraceContextFile: result.contextFile,
    vtraceContextChars: result.contextChars,
    vtraceContextItems: result.contextItems,
    vtraceContextTruncated: result.contextTruncated,
    vtraceContextError: result.contextError,
  };
}

// Stage 5B orchestration: for each selected instance, reproduce the checkout
// (Approach B), index it with vtrace, query vtrace with the problem statement,
// and assemble a compact context block written to the instructions/context file.
// Returns aggregate metadata. Missing instance data is a hard error (thrown);
// clone/index/query failures are recorded per-instance and degrade the result
// (never silently fall back to generic instructions).
export async function prepareIndexedContext(config: CliConfig, deps: RunDeps = {}): Promise<IndexedContextResult> {
  const runProc = deps.runProcess ?? runProcess;
  const contextFile = vtraceInstructionsFilePath(config.out);
  const records = await loadSweBenchData(sweBenchDataPath(config));
  const instanceIds = await resolveInstances(config);
  if (instanceIds.length === 0) {
    throw new Error("indexed-context requires instances (via --instances or smoke_instances.json).");
  }

  const sections: VtraceContextSection[] = [];
  const errors: string[] = [];
  let indexCommand: string | null = null;
  let queryCommand: string | null = null;
  let workspacePath: string | null = null;

  for (const instanceId of instanceIds) {
    const record = findSweBenchRecord(records, instanceId);
    if (record === null) {
      throw new Error(`Instance ${instanceId} not found in SWE-bench data ${sweBenchDataPath(config)}.`);
    }
    const instance = toSweBenchInstance(record); // throws on missing fields
    const workspace = workspacePathFor(config.out, instance.instanceId, config.runLabel);
    if (workspacePath === null) workspacePath = workspace;

    let rawContext = "";
    let sectionError: string | null = null;
    try {
      await ensureWorkspaceCheckout(instance, workspace, runProc);
      const indexSpec = buildVtraceIndexCommand(config, workspace);
      indexCommand = renderCommand(indexSpec);
      if (!(config.skipVtraceIndexIfPresent && (await pathExists(path.join(workspace, ".vtrace"))))) {
        const indexResult = await runProc(indexSpec.command, indexSpec.args);
        if (indexResult.exitCode !== 0) {
          throw new Error(`vtrace index failed (exit ${indexResult.exitCode}): ${indexResult.stderr.trim() || "(no stderr)"}`);
        }
      }
      const querySpec = buildVtraceQueryCommand(config, workspace, buildInstanceQuery(instance));
      queryCommand = renderCommand(querySpec);
      const queryResult = await runProc(querySpec.command, querySpec.args);
      if (queryResult.exitCode !== 0) {
        throw new Error(`vtrace query failed (exit ${queryResult.exitCode}): ${queryResult.stderr.trim() || "(no stderr)"}`);
      }
      rawContext = queryResult.stdout.trim();
      if (rawContext.length === 0) throw new Error("vtrace query returned empty context.");
    } catch (error) {
      sectionError = error instanceof Error ? error.message : String(error);
      errors.push(`${instance.instanceId}: ${sectionError}`);
    }
    sections.push({ instance, rawContext, error: sectionError });
  }

  const assembled = buildVtraceContextMarkdown(sections, {
    maxChars: config.vtraceContextMaxChars,
    maxItems: config.vtraceContextMaxItems,
  });
  await writeFile(contextFile, assembled.markdown);

  const indexedContext = sections.some((section) => section.error === null && section.rawContext.trim().length > 0);
  return {
    indexedContext,
    indexCommand,
    queryCommand,
    workspacePath,
    contextFile,
    contextChars: assembled.chars,
    contextItems: assembled.items,
    contextTruncated: assembled.truncated,
    contextError: errors.length > 0 ? errors.join("; ") : null,
  };
}

// Reproduce the instance checkout (Approach B): clone if absent, then checkout
// the base commit. Mirrors vexp-swe-bench's shallow-clone + fetch fallback.
async function ensureWorkspaceCheckout(
  instance: SweBenchInstance,
  workspace: string,
  runProc: ProcessRunner,
): Promise<void> {
  const alreadyCloned = await pathExists(path.join(workspace, ".git"));
  if (!alreadyCloned) {
    await mkdir(path.dirname(workspace), { recursive: true });
    const clone = buildCloneCommand(instance.repo, workspace);
    const cloneResult = await runProc(clone.command, clone.args);
    if (cloneResult.exitCode !== 0) {
      throw new Error(`git clone of ${instance.repo} failed (exit ${cloneResult.exitCode}): ${cloneResult.stderr.trim() || "(no stderr)"}`);
    }
  }
  const checkout = buildCheckoutCommand(workspace, instance.baseCommit);
  const checkoutResult = await runProc(checkout.command, checkout.args);
  if (checkoutResult.exitCode !== 0) {
    // The base commit may be missing from a shallow clone; fetch it and retry.
    await runProc("git", ["-C", workspace, "fetch", "--depth", "1", "origin", instance.baseCommit]);
    const retry = await runProc(checkout.command, checkout.args);
    if (retry.exitCode !== 0) {
      throw new Error(`git checkout ${instance.baseCommit} failed (exit ${retry.exitCode}): ${retry.stderr.trim() || "(no stderr)"}`);
    }
  }
}

async function runCondition(
  config: CliConfig,
  condition: Stage5Condition,
  deps: RunDeps,
  extraVtraceMeta: Record<string, unknown> = {},
): Promise<void> {
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
  // For the vtrace condition, record the instruction-file state and the runtime
  // injection status parsed from this run's stderr, so the raw meta is itself
  // sufficient evidence of whether the treatment actually applied.
  const indexedFlag =
    typeof extraVtraceMeta.vtraceIndexedContext === "boolean" ? extraVtraceMeta.vtraceIndexedContext : null;
  const vtraceMeta =
    condition === "vtrace"
      ? { ...(await vtraceRunMetaFields(config, result.stderr, indexedFlag)), ...extraVtraceMeta }
      : {};
  const meta = {
    condition,
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    env,
    instances,
    vtraceMethod: condition === "vtrace" ? config.vtraceMethod : null,
    ...vtraceMeta,
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
  const evidence = await collectRunEvidence(config.out);
  const artifact = buildArtifact(stampVtraceRows(merged, evidence), evidence);
  await writeFile(path.join(config.out, NORMALIZED_FILENAME), `${JSON.stringify(artifact, null, 2)}\n`);
  await writeReports(config, artifact);
  return artifact;
}

// Copy the run-level vtrace evidence onto each vtrace row (baseline rows keep
// their null vtrace fields), so the normalized rows carry the treatment metadata.
function stampVtraceRows(rows: readonly Stage5Row[], evidence: Stage5RunEvidence): Stage5Row[] {
  return rows.map((row) =>
    row.condition !== "vtrace"
      ? row
      : {
          ...row,
          vtraceMethod: evidence.vtraceMethod,
          vtraceInstructionsFile: evidence.vtraceInstructionsFile,
          vtraceInstructionsFileExists: evidence.vtraceInstructionsFileExists,
          vtraceInstructionsFileSize: evidence.vtraceInstructionsFileSize,
          vtraceInjectionObserved: evidence.vtraceInjectionObserved,
          vtraceInjectionError: evidence.vtraceInjectionError,
          vtraceTreatmentValid: evidence.vtraceTreatmentValid,
          // Stage 5B indexed-context fields.
          vtraceIndexedContext: evidence.vtraceIndexedContext,
          vtraceIndexCommand: evidence.vtraceIndexCommand,
          vtraceQueryCommand: evidence.vtraceQueryCommand,
          vtraceWorkspacePath: evidence.vtraceWorkspacePath,
          vtraceContextFile: evidence.vtraceContextFile,
          vtraceContextChars: evidence.vtraceContextChars,
          vtraceContextItems: evidence.vtraceContextItems,
          vtraceContextTruncated: evidence.vtraceContextTruncated,
          vtraceContextError: evidence.vtraceContextError,
        },
  );
}

export async function runReport(config: CliConfig, deps: RunDeps = {}): Promise<NormalizedArtifact> {
  await ensureOutputTree(config.out);
  const normalized = await readJsonIfExists(path.join(config.out, NORMALIZED_FILENAME));
  if (isRecord(normalized) && Array.isArray(normalized.rows)) {
    const rows = (normalized.rows as unknown[]).filter(isRecord) as unknown as Stage5Row[];
    // Prefer evidence already stored in the normalized intermediate; otherwise
    // re-derive it from the raw artifacts (do not fall back to config).
    const evidence = isRecord(normalized.evidence)
      ? (normalized.evidence as unknown as Stage5RunEvidence)
      : await collectRunEvidence(config.out);
    const artifact = buildArtifact(stampVtraceRows(rows, evidence), evidence);
    await writeReports(config, artifact);
    return artifact;
  }
  // No normalized intermediate yet: derive it from raw outputs.
  return runIngest(config, deps);
}

// ----- vtrace local-patch mode ------------------------------------------------

// The code inserted into the external Claude Code adapter. When
// VTRACE_AGENT_INSTRUCTIONS_FILE is set it appends that file's contents to the
// prompt under a clear marker. It logs to STDERR on purpose: the adapter's
// stdout is parsed as stream-json for token/cost metrics, so a stdout line would
// corrupt parsing. vexp stays disabled — this only enriches the prompt/context.
export function buildVtracePatchBlock(): string {
  return [
    `        // ${STAGE5_VTRACE_PATCH_MARKER} begin — local Stage 5 smoke patch (injects`,
    "        // VTRACE_AGENT_INSTRUCTIONS_FILE into the Claude Code prompt; vexp stays disabled).",
    "        if (process.env.VTRACE_AGENT_INSTRUCTIONS_FILE) {",
    "            const __stage5VtraceFile = process.env.VTRACE_AGENT_INSTRUCTIONS_FILE;",
    "            try {",
    '                const { readFile: __stage5ReadFile } = await import("node:fs/promises");',
    '                const __stage5VtraceText = await __stage5ReadFile(__stage5VtraceFile, "utf8");',
    "                opts.prompt = `${opts.prompt}\\n\\n## Additional vtrace context/instructions\\n\\n${__stage5VtraceText}`;",
    `                console.error(\`${STAGE5_VTRACE_INJECTION_LOG} \${__stage5VtraceFile}\`);`,
    "            } catch (__stage5Err) {",
    "                console.error(`Stage5 vtrace injection skipped: ${__stage5Err instanceof Error ? __stage5Err.message : String(__stage5Err)}`);",
    "            }",
    "        }",
    `        // ${STAGE5_VTRACE_PATCH_MARKER} end`,
    "",
  ].join("\n");
}

export function isVtracePatched(content: string): boolean {
  return content.includes(STAGE5_VTRACE_PATCH_MARKER);
}

// Pure transform: insert the injection block after the anchor line. Idempotent —
// returns changed:false if the marker is already present. Throws if the anchor
// is missing so the caller can tell the user to patch manually.
export function applyVtracePatch(content: string): { content: string; changed: boolean } {
  if (isVtracePatched(content)) return { content, changed: false };
  const anchorIndex = content.indexOf(VTRACE_PATCH_ANCHOR);
  if (anchorIndex === -1) {
    throw new Error(
      `Could not find anchor "${VTRACE_PATCH_ANCHOR}" in the Claude Code adapter. ` +
        "The external vexp-swe-bench layout may have changed; patch the prompt builder manually.",
    );
  }
  const lineEnd = content.indexOf("\n", anchorIndex);
  const insertAt = lineEnd === -1 ? content.length : lineEnd + 1;
  const patched = `${content.slice(0, insertAt)}${buildVtracePatchBlock()}${content.slice(insertAt)}`;
  return { content: patched, changed: true };
}

// Find the adapter file that builds the `claude -p <prompt>` invocation. Tries
// the known candidate paths first, then falls back to a recursive scan of dist/
// and src/ for a file that names the claude-code agent and references the anchor.
export async function locateClaudePromptFile(vexpSweBenchDir: string): Promise<string | null> {
  for (const candidate of CLAUDE_ADAPTER_CANDIDATES) {
    const absolute = path.join(vexpSweBenchDir, candidate);
    if (await pathExists(absolute)) return absolute;
  }
  for (const subdir of ["dist", "src"]) {
    const root = path.join(vexpSweBenchDir, subdir);
    const files = await listFilesRecursive(root).catch(() => [] as string[]);
    for (const file of files) {
      if (!/\.(js|mjs|ts)$/.test(file)) continue;
      const content = await readFile(file, "utf8").catch(() => "");
      if (content.includes('"claude-code"') && content.includes(VTRACE_PATCH_ANCHOR)) return file;
    }
  }
  return null;
}

export async function installVtracePatch(config: CliConfig): Promise<VtracePatchManifest> {
  await ensureOutputTree(config.out);
  if (config.vexpSweBenchDir === null) throw new Error("--mode install-vtrace-patch requires --vexp-swe-bench-dir.");
  const target = await locateClaudePromptFile(config.vexpSweBenchDir);
  if (target === null) {
    throw new Error(
      `Could not locate the Claude Code prompt builder under ${config.vexpSweBenchDir} ` +
        `(looked for ${CLAUDE_ADAPTER_CANDIDATES.join(", ")} and scanned dist/ and src/).`,
    );
  }

  const original = await readFile(target, "utf8");
  const notes: string[] = [];
  const backupPath = `${target}${VTRACE_PATCH_BACKUP_SUFFIX}`;

  const { content: patched, changed } = applyVtracePatch(original);
  if (!changed) {
    notes.push("Patch marker already present; left the file untouched (idempotent).");
  } else {
    // Back up the pristine file exactly once, before the first edit.
    if (await pathExists(backupPath)) {
      notes.push("Backup already existed; preserved it and did not overwrite.");
    } else {
      await writeFile(backupPath, original);
    }
    await writeFile(target, patched);
  }
  if (target.includes(`${path.sep}dist${path.sep}`)) {
    notes.push("Patched the built dist/ output directly; this is a local smoke patch and is lost on rebuild.");
  }

  const manifest: VtracePatchManifest = {
    installed: true,
    vexpSweBenchDir: config.vexpSweBenchDir,
    patchedFiles: [target],
    backupFiles: [backupPath],
    patchMarker: STAGE5_VTRACE_PATCH_MARKER,
    notes,
  };
  await writeVtracePatchManifest(config.out, manifest);
  return manifest;
}

export async function verifyVtracePatch(config: CliConfig): Promise<VtracePatchVerification> {
  await ensureOutputTree(config.out);
  if (config.vexpSweBenchDir === null) throw new Error("--mode verify-vtrace-patch requires --vexp-swe-bench-dir.");
  const target = await locateClaudePromptFile(config.vexpSweBenchDir);
  const notes: string[] = [];
  if (target === null) {
    notes.push("Could not locate the Claude Code prompt builder; nothing to verify.");
    return {
      installed: false,
      vexpSweBenchDir: config.vexpSweBenchDir,
      patchedFile: null,
      backupPresent: false,
      manifestPresent: await pathExists(path.join(config.out, VTRACE_PATCH_MANIFEST_FILENAME)),
      notes,
    };
  }
  const content = await readFile(target, "utf8").catch(() => "");
  const installed = isVtracePatched(content);
  const backupPresent = await pathExists(`${target}${VTRACE_PATCH_BACKUP_SUFFIX}`);
  notes.push(installed ? `Patch marker present in ${target}.` : `Patch marker NOT found in ${target}.`);
  return {
    installed,
    vexpSweBenchDir: config.vexpSweBenchDir,
    patchedFile: target,
    backupPresent,
    manifestPresent: await pathExists(path.join(config.out, VTRACE_PATCH_MANIFEST_FILENAME)),
    notes,
  };
}

async function writeVtracePatchManifest(outDir: string, manifest: VtracePatchManifest): Promise<void> {
  await writeFile(
    path.join(outDir, VTRACE_PATCH_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

// Guard for run-vtrace --vtrace-method local-patch: the external prompt builder
// MUST already carry the marker, or the run would silently behave like baseline.
// We fail here, before any agent process is spawned, so no tokens are spent.
async function assertVtracePatchInstalled(config: CliConfig): Promise<void> {
  if (config.vexpSweBenchDir === null) throw new Error("--mode run-vtrace requires --vexp-swe-bench-dir.");
  const target = await locateClaudePromptFile(config.vexpSweBenchDir);
  const content = target === null ? "" : await readFile(target, "utf8").catch(() => "");
  if (target === null || !isVtracePatched(content)) {
    throw new Error(
      "--vtrace-method local-patch requires the local vtrace patch to be installed first, but its marker " +
        `(${STAGE5_VTRACE_PATCH_MARKER}) was not found in the external checkout. Run --mode install-vtrace-patch ` +
        "before run-vtrace so the vtrace condition is real and no tokens are wasted on a no-op run.",
    );
  }
}

async function parseConditionDir(dir: string, condition: Stage5Condition): Promise<Stage5Row[]> {
  const files = await listFilesRecursive(dir).catch(() => [] as string[]);
  const readable = files.filter((absolute) => !path.basename(absolute).startsWith(RUNNER_ARTIFACT_PREFIX));
  // Prefer canonical `swebench-*.jsonl` logs over anything else when present, so
  // run metadata/stdout (or any stray export) never shadows the real result row.
  const canonical = readable.filter((absolute) => isCanonicalResultFile(path.basename(absolute)));
  const chosen = canonical.length > 0 ? canonical : readable;

  const rows: Stage5Row[] = [];
  for (const absolute of chosen) {
    const filename = path.basename(absolute);
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
    const key = `${row.instanceId} ${row.condition}`;
    const existing = byKey.get(key);
    byKey.set(key, existing === undefined ? row : mergeRow(existing, row));
  }
  return [...byKey.values()].sort((left, right) =>
    left.instanceId.localeCompare(right.instanceId) || left.condition.localeCompare(right.condition),
  );
}

function mergeRow(base: Stage5Row, next: Stage5Row): Stage5Row {
  const fill = <T>(a: Unknownable<T>, b: Unknownable<T>): Unknownable<T> => (a === "unknown" ? b : a);
  const merged: Stage5Row = {
    ...base,
    resolved: fill(base.resolved, next.resolved),
    costUsd: fill(base.costUsd, next.costUsd),
    durationMs: fill(base.durationMs, next.durationMs),
    inputTokens: fill(base.inputTokens, next.inputTokens),
    outputTokens: fill(base.outputTokens, next.outputTokens),
    cacheReadTokens: fill(base.cacheReadTokens, next.cacheReadTokens),
    cacheCreationTokens: fill(base.cacheCreationTokens, next.cacheCreationTokens),
    totalTokens: fill(base.totalTokens, next.totalTokens),
    tokenAccountingMethod: base.tokenAccountingMethod === "unavailable" ? next.tokenAccountingMethod : base.tokenAccountingMethod,
    numTurns: fill(base.numTurns, next.numTurns),
    toolCallsTotal: fill(base.toolCallsTotal, next.toolCallsTotal),
    toolCallsBreakdown: base.toolCallsBreakdown ?? next.toolCallsBreakdown,
    patchAvailable: fill(base.patchAvailable, next.patchAvailable),
    patchLines: fill(base.patchLines, next.patchLines),
    model: base.model ?? next.model,
    agent: base.agent ?? next.agent,
    repo: base.repo ?? next.repo,
    error: base.error ?? next.error,
    parserKind: base.parserKind === "unknown" ? next.parserKind : base.parserKind,
    notes: [...new Set([...base.notes, ...next.notes])],
  };
  return { ...merged, parsedFieldCount: countParsedFields(merged) };
}

function buildArtifact(rows: readonly Stage5Row[], evidence: Stage5RunEvidence): NormalizedArtifact {
  const pairs = comparePairs(rows);
  return { rows: [...rows], pairs, summary: summarize(rows, pairs), evidence };
}

// The IndexedContextFields, all null — used to default baseline/result rows and
// any run that did not produce indexed context.
function nullIndexedContextFields(): IndexedContextFields {
  return {
    vtraceIndexedContext: null,
    vtraceIndexCommand: null,
    vtraceQueryCommand: null,
    vtraceWorkspacePath: null,
    vtraceContextFile: null,
    vtraceContextChars: null,
    vtraceContextItems: null,
    vtraceContextTruncated: null,
    vtraceContextError: null,
  };
}

function emptyEvidence(): Stage5RunEvidence {
  return {
    vtraceMethod: "unknown",
    vtracePatchInstalled: "unknown",
    vtraceInstructionsFile: null,
    vtraceInstructionsFileExists: false,
    vtraceInstructionsFileSize: null,
    vtraceInjectionObserved: "unknown",
    vtraceInjectionError: null,
    vtraceTreatmentValid: "unknown",
    ...nullIndexedContextFields(),
    notes: [],
  };
}

// Parse a captured vtrace stderr for the runtime injection outcome. A null stderr
// means none was captured (observed = "unknown").
function parseVtraceInjection(stderr: string | null): { observed: boolean | "unknown"; error: string | null } {
  if (stderr === null) return { observed: "unknown", error: null };
  if (stderr.includes(STAGE5_VTRACE_INJECTION_LOG)) return { observed: true, error: null };
  const skipped = stderr.split(/\r?\n/).find((line) => line.includes(STAGE5_VTRACE_INJECTION_SKIPPED));
  return { observed: false, error: skipped ? skipped.trim() : null };
}

// Treatment validity rules per method:
//  - local-patch: valid iff runtime injection was observed.
//  - indexed-context: valid iff injection observed AND real vtrace context was
//    generated AND the context file exists & is non-empty.
//  - any other method / unobserved injection: not assertable ("unknown").
function computeTreatmentValid(opts: {
  method: VtraceMethod | "unknown" | "mixed";
  injectionObserved: boolean | "unknown";
  instructionsFileExists?: boolean;
  instructionsFileSize?: number | null;
  indexedContext?: boolean | "unknown" | null;
}): boolean | "unknown" {
  if (opts.injectionObserved === "unknown") return "unknown";
  if (opts.method === "local-patch") return opts.injectionObserved === true;
  if (opts.method === "indexed-context") {
    return (
      opts.injectionObserved === true &&
      opts.indexedContext === true &&
      opts.instructionsFileExists === true &&
      (opts.instructionsFileSize ?? 0) > 0
    );
  }
  return "unknown";
}

// Run-level vtrace metadata stamped into the vtrace _run.meta.json at run time and
// recomputed at ingest. `stderr` is the captured vtrace stderr (null if absent).
async function vtraceRunMetaFields(
  config: CliConfig,
  stderr: string | null,
  indexedContext: boolean | null = null,
): Promise<{
  vtraceInstructionsFile: string;
  vtraceInstructionsFileExists: boolean;
  vtraceInstructionsFileSize: number | null;
  vtraceInjectionObserved: boolean | "unknown";
  vtraceInjectionError: string | null;
  vtraceTreatmentValid: boolean | "unknown";
}> {
  const file = vtraceInstructionsFilePath(config.out);
  const stats = await stat(file).catch(() => null);
  const exists = stats !== null && stats.isFile();
  const size = exists ? stats!.size : null;
  const injection = parseVtraceInjection(stderr);
  return {
    vtraceInstructionsFile: file,
    vtraceInstructionsFileExists: exists,
    vtraceInstructionsFileSize: size,
    vtraceInjectionObserved: injection.observed,
    vtraceInjectionError: injection.error,
    vtraceTreatmentValid: computeTreatmentValid({
      method: config.vtraceMethod,
      injectionObserved: injection.observed,
      instructionsFileExists: exists,
      instructionsFileSize: size,
      indexedContext,
    }),
  };
}

// Reconstruct run-level vtrace evidence from the captured raw artifacts: the per
// condition `_run.meta.json` (method + instructions-file path), the vtrace
// `_run.stderr.txt` (runtime injection log), and the patch manifest (install
// state). Everything here is observed, never inferred from the requested config.
async function collectRunEvidence(outDir: string): Promise<Stage5RunEvidence> {
  const notes: string[] = [];

  // Resolve the vtrace method from RECORDED run metas only (non-null values),
  // and recover the instructions-file path the run actually used.
  const methods = new Set<VtraceMethod>();
  let instructionsFile: string | null = null;
  let vtraceRunRecorded = false;
  let indexed: IndexedContextFields = nullIndexedContextFields();
  for (const condition of ["baseline", "vtrace"] as const) {
    const meta = await readJsonIfExists(path.join(rawConditionDir(outDir, condition), "_run.meta.json"));
    if (!isRecord(meta)) continue;
    if (condition === "vtrace") vtraceRunRecorded = true;
    if (isString(meta.vtraceMethod) && isVtraceMethod(meta.vtraceMethod)) methods.add(meta.vtraceMethod);
    // Prefer the explicit field (new meta); fall back to the env path (old meta).
    if (condition === "vtrace") {
      if (isString(meta.vtraceInstructionsFile)) instructionsFile = meta.vtraceInstructionsFile;
      else if (isRecord(meta.env) && isString(meta.env.VTRACE_AGENT_INSTRUCTIONS_FILE)) {
        instructionsFile = meta.env.VTRACE_AGENT_INSTRUCTIONS_FILE;
      }
      indexed = readIndexedContextFromMeta(meta);
    }
  }
  const vtraceMethod: VtraceMethod | "unknown" | "mixed" =
    methods.size === 0 ? "unknown" : methods.size === 1 ? [...methods][0]! : "mixed";
  if (vtraceMethod === "mixed") notes.push("Recorded vtrace run metadata disagree on the method.");

  // Instruction-file existence/size, observed at ingest time.
  const stats = instructionsFile === null ? null : await stat(instructionsFile).catch(() => null);
  const vtraceInstructionsFileExists = stats !== null && stats.isFile();
  const vtraceInstructionsFileSize = vtraceInstructionsFileExists ? stats!.size : null;

  // Patch install state from the manifest (on-disk install, distinct from runtime injection).
  const manifest = await readJsonIfExists(path.join(outDir, VTRACE_PATCH_MANIFEST_FILENAME));
  const vtracePatchInstalled: boolean | "unknown" = isRecord(manifest) && typeof manifest.installed === "boolean"
    ? manifest.installed
    : "unknown";

  // Runtime injection evidence: parse the captured vtrace stderr.
  const stderrPath = path.join(rawConditionDir(outDir, "vtrace"), "_run.stderr.txt");
  const stderr = await readFile(stderrPath, "utf8").catch(() => null);
  const injection = stderr === null && !vtraceRunRecorded ? { observed: "unknown" as const, error: null } : parseVtraceInjection(stderr ?? "");
  const vtraceInjectionObserved = injection.observed;
  const vtraceInjectionError = injection.error;
  if (vtraceInjectionObserved === true) {
    notes.push("Runtime vtrace injection log observed in captured vtrace stderr.");
  } else if (vtraceInjectionObserved === false) {
    notes.push("No runtime vtrace injection log found in captured vtrace stderr.");
  }
  if (vtraceInjectionError !== null) notes.push(vtraceInjectionError);

  const vtraceTreatmentValid = computeTreatmentValid({
    method: vtraceMethod,
    injectionObserved: vtraceInjectionObserved,
    instructionsFileExists: vtraceInstructionsFileExists,
    instructionsFileSize: vtraceInstructionsFileSize,
    indexedContext: typeof indexed.vtraceIndexedContext === "boolean" ? indexed.vtraceIndexedContext : null,
  });
  if (vtraceMethod === "local-patch" && vtraceTreatmentValid === false) {
    notes.push("Vtrace injection was skipped; this run is not a valid vtrace treatment.");
  }
  if (vtraceMethod === "indexed-context" && vtraceTreatmentValid === false) {
    notes.push(
      indexed.vtraceIndexedContext === true
        ? "Vtrace injection was skipped; this run is not a valid indexed-context treatment."
        : "Vtrace indexed context was not generated; this run is not a valid indexed-context treatment.",
    );
  }

  return {
    vtraceMethod,
    vtracePatchInstalled,
    vtraceInstructionsFile: instructionsFile,
    vtraceInstructionsFileExists,
    vtraceInstructionsFileSize,
    vtraceInjectionObserved,
    vtraceInjectionError,
    vtraceTreatmentValid,
    ...indexed,
    // The context file path defaults to the instructions file when recorded.
    vtraceContextFile: indexed.vtraceContextFile ?? instructionsFile,
    notes,
  };
}

// Read the Stage 5B indexed-context fields out of a recorded vtrace _run.meta.json.
function readIndexedContextFromMeta(meta: Record<string, unknown>): IndexedContextFields {
  const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
  const str = (value: unknown): string | null => (isString(value) ? value : null);
  const num = (value: unknown): number | null => (isNumber(value) ? value : null);
  return {
    vtraceIndexedContext: bool(meta.vtraceIndexedContext),
    vtraceIndexCommand: str(meta.vtraceIndexCommand),
    vtraceQueryCommand: str(meta.vtraceQueryCommand),
    vtraceWorkspacePath: str(meta.vtraceWorkspacePath),
    vtraceContextFile: str(meta.vtraceContextFile),
    vtraceContextChars: num(meta.vtraceContextChars),
    vtraceContextItems: num(meta.vtraceContextItems),
    vtraceContextTruncated: bool(meta.vtraceContextTruncated),
    vtraceContextError: str(meta.vtraceContextError),
  };
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
        cell(row.cacheReadTokens),
        cell(row.cacheCreationTokens),
        cell(row.totalTokens),
        row.tokenAccountingMethod,
        cell(row.numTurns),
        cell(row.toolCallsTotal),
        cell(row.patchAvailable),
        row.vtraceMethod ?? "",
        row.vtraceInjectionObserved === null ? "" : String(row.vtraceInjectionObserved),
        row.vtraceIndexedContext === null ? "" : String(row.vtraceIndexedContext),
        row.vtraceTreatmentValid === null ? "" : String(row.vtraceTreatmentValid),
        row.error ?? "",
        row.rawResultPath,
        row.parserKind,
        row.notes.join("; "),
      ]
        .map(csvEscape)
        .join(","),
    ),
  ].join("\n")}\n`;
}

export function renderMarkdown(artifact: NormalizedArtifact, config: CliConfig): string {
  const { rows, pairs, summary } = artifact;
  const evidence = artifact.evidence ?? emptyEvidence();
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
    `- vtrace method (recorded): ${evidence.vtraceMethod}`,
    `- vtrace method (requested): ${config.vtraceMethod}`,
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
    "## Vtrace injection evidence",
    "",
    ...renderVtraceEvidence(evidence),
    "",
    ...renderIndexedContextEvidence(evidence),
    "## Result mode",
    "",
    describeResultMode(pairs, rows),
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
    "Pass/resolution is primary. Token, cost, and duration reductions are only meaningful for instances where both conditions resolved. A `vtrace_only_resolved` instance is a qualitative win even if tokens are higher. When all paired `resolved` values are `unknown`, this is a patch-generation smoke — patches were produced but not evaluated pass/fail — and must not be read as a win/loss. Any `unknown` field means the benchmark output did not expose that value; it was not guessed.",
    "",
    "## Next step",
    "",
    "If the workflow holds on this tiny subset, expand the instance set gradually and, separately, add an explicit vexp-enabled condition before making any vexp-vs-vtrace comparison. This smoke run does not authorize public SWE-bench claims.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

// Run-level injection evidence table plus a warning when local-patch was the
// method but the runtime injection was not actually observed (a no-op treatment).
function renderVtraceEvidence(evidence: Stage5RunEvidence): string[] {
  const lines = [
    "| Field | Value |",
    "| --- | --- |",
    `| vtrace_method | ${evidence.vtraceMethod} |`,
    `| vtrace_patch_installed | ${String(evidence.vtracePatchInstalled)} |`,
    `| vtrace_instructions_file | ${evidence.vtraceInstructionsFile ?? "(none)"} |`,
    `| vtrace_instructions_file_exists | ${String(evidence.vtraceInstructionsFileExists)} |`,
    `| vtrace_instructions_file_size | ${evidence.vtraceInstructionsFileSize ?? "(n/a)"} |`,
    `| vtrace_injection_observed | ${String(evidence.vtraceInjectionObserved)} |`,
    `| vtrace_injection_error | ${evidence.vtraceInjectionError ?? "(none)"} |`,
    `| vtrace_treatment_valid | ${String(evidence.vtraceTreatmentValid)} |`,
  ];
  if (evidence.vtraceMethod === "local-patch" && evidence.vtraceTreatmentValid !== true) {
    lines.push(
      "",
      "> ⚠️ Warning: Vtrace injection was skipped; this run is not a valid vtrace treatment. The recorded " +
        "vtrace method is `local-patch`, but no runtime injection was observed in the captured vtrace stderr " +
        `(\`${STAGE5_VTRACE_INJECTION_LOG} ...\` was not found). The vtrace condition ran WITHOUT the injected ` +
        "vtrace context, making it indistinguishable from baseline, so its token/cost/duration deltas must NOT " +
        "be advertised as vtrace performance. Confirm the patch is installed and that the instructions file " +
        "survives into the run, then re-run the vtrace condition until the injection log appears.",
    );
    if (evidence.vtraceInjectionError !== null) {
      lines.push("", `> Injection error: \`${evidence.vtraceInjectionError}\``);
    }
  }
  return lines;
}

// Stage 5B evidence table. Only rendered when the run used (or recorded any)
// indexed-context, so plain local-patch / instructions-file runs are unaffected.
function renderIndexedContextEvidence(evidence: Stage5RunEvidence): string[] {
  if (evidence.vtraceMethod !== "indexed-context" && evidence.vtraceIndexedContext === null) return [];
  const lines = [
    "## Vtrace indexed context evidence",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| vtrace_method | ${evidence.vtraceMethod} |`,
    `| vtrace_indexed_context | ${String(evidence.vtraceIndexedContext)} |`,
    `| vtrace_index_command | ${evidence.vtraceIndexCommand ?? "(none)"} |`,
    `| vtrace_query_command | ${evidence.vtraceQueryCommand ?? "(none)"} |`,
    `| vtrace_workspace_path | ${evidence.vtraceWorkspacePath ?? "(none)"} |`,
    `| vtrace_context_file | ${evidence.vtraceContextFile ?? "(none)"} |`,
    `| vtrace_context_chars | ${evidence.vtraceContextChars ?? "(n/a)"} |`,
    `| vtrace_context_items | ${evidence.vtraceContextItems ?? "(n/a)"} |`,
    `| vtrace_context_truncated | ${String(evidence.vtraceContextTruncated)} |`,
    `| vtrace_context_error | ${evidence.vtraceContextError ?? "(none)"} |`,
    `| vtrace_treatment_valid | ${String(evidence.vtraceTreatmentValid)} |`,
    "",
  ];
  if (evidence.vtraceMethod === "indexed-context" && evidence.vtraceTreatmentValid !== true) {
    lines.push(
      evidence.vtraceIndexedContext === true
        ? "> ⚠️ Warning: Vtrace injection was skipped; this run is not a valid indexed-context treatment. The " +
            "indexed context was generated but was not observed being injected at runtime, so its deltas must NOT " +
            "be advertised as vtrace performance."
        : "> ⚠️ Warning: Vtrace indexed context was not generated; this run is not a valid indexed-context " +
            "treatment. The vtrace condition ran without real retrieval context, so its token/cost/duration " +
            "deltas must NOT be advertised as vtrace performance.",
      "",
    );
    if (evidence.vtraceContextError !== null) {
      lines.push(`> Context error: \`${evidence.vtraceContextError}\``, "");
    }
  }
  return lines;
}

// Resolution was never evaluated when all paired outcomes are "unknown"; say so
// plainly instead of letting an "unknown" outcome read like a pass/fail verdict.
function describeResultMode(pairs: readonly PairComparison[], rows: readonly Stage5Row[]): string {
  const pairedKnown = pairs.filter((pair) => pair.baselineResolved !== null && pair.vtraceResolved !== null);
  const allUnknownResolution = pairedKnown.length > 0 && pairedKnown.every((pair) => pair.outcome === "unknown");
  if (!allUnknownResolution) {
    return "Resolution pass/fail was evaluated for at least one paired instance; see the per-instance table.";
  }
  const patchesGenerated = rows.some((row) => row.patchAvailable === true);
  const patchClause = patchesGenerated
    ? "Patches were generated for both conditions but resolution was not evaluated."
    : "Resolution was not evaluated for any paired instance.";
  return (
    `This run is a **paired patch-generation smoke, not evaluated pass/fail**. ${patchClause} ` +
    "All paired `resolved` values are `unknown`, so this must NOT be read as a pass/fail or win/loss result. " +
    "Token/cost/duration deltas here describe effort, not correctness."
  );
}

function renderPairTable(pairs: readonly PairComparison[]): string {
  if (pairs.length === 0) return "No paired instances have been ingested yet.";
  // When the vtrace treatment is invalid (injection skipped) the efficiency
  // deltas are NOT vtrace performance, so we show "invalid" instead of a number.
  const reductionCell = (pair: PairComparison, value: number | null): string =>
    pair.vtraceTreatmentValid === false ? "invalid" : formatPct(value);
  return [
    "| instance | baseline resolved | vtrace resolved | outcome | treatment valid | baseline tokens | vtrace tokens | token reduction | cost reduction | duration reduction |",
    "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...pairs.map((pair) =>
      `| ${pair.instanceId} | ${cellOrDash(pair.baselineResolved)} | ${cellOrDash(pair.vtraceResolved)} | ${pair.outcome} | ${cellOrDash(pair.vtraceTreatmentValid)} | ${cellOrDash(pair.baselineTotalTokens)} | ${cellOrDash(pair.vtraceTotalTokens)} | ${reductionCell(pair, pair.tokenReductionPct)} | ${reductionCell(pair, pair.costReductionPct)} | ${reductionCell(pair, pair.durationReductionPct)} |`,
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
    ["cache_read_tokens", row.cacheReadTokens],
    ["cache_creation_tokens", row.cacheCreationTokens],
    ["total_tokens", row.totalTokens],
    ["num_turns", row.numTurns],
    ["tool_calls_total", row.toolCallsTotal],
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

function isVtraceMethod(value: string): value is VtraceMethod {
  return value === "instructions-file" || value === "mcp" || value === "local-patch" || value === "indexed-context";
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
        if (
          ![
            "prepare",
            "run-baseline",
            "run-vtrace",
            "ingest",
            "report",
            "install-vtrace-patch",
            "verify-vtrace-patch",
          ].includes(value)
        )
          throw new Error("Invalid --mode.");
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
        if (!["instructions-file", "mcp", "local-patch", "indexed-context"].includes(value)) throw new Error("Invalid --vtrace-method.");
        config.vtraceMethod = value as VtraceMethod;
        break;
      }
      case "--vtrace-command": config.vtraceCommand = requireValue(argv, ++index, arg); break;
      case "--vtrace-index-args": config.vtraceIndexArgs = requireValue(argv, ++index, arg); break;
      case "--vtrace-query-args": config.vtraceQueryArgs = requireValue(argv, ++index, arg); break;
      case "--skip-vtrace-index-if-present": config.skipVtraceIndexIfPresent = true; break;
      case "--vtrace-context-max-chars": config.vtraceContextMaxChars = requirePositiveInt(argv, ++index, arg); break;
      case "--vtrace-context-max-items": config.vtraceContextMaxItems = requirePositiveInt(argv, ++index, arg); break;
      case "--swe-bench-data": config.sweBenchDataFile = requireValue(argv, ++index, arg); break;
      case "--run-label": config.runLabel = requireValue(argv, ++index, arg); break;
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
    sweBenchDataFile: config.sweBenchDataFile === null ? null : path.resolve(config.sweBenchDataFile),
  };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function requirePositiveInt(argv: readonly string[], index: number, flag: string): number {
  const value = Number.parseInt(requireValue(argv, index, flag), 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} requires a positive integer.`);
  return value;
}

function printUsageAndExit(exitCode: number): never {
  process.stdout.write(
    "Usage: bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts --mode prepare|run-baseline|run-vtrace|ingest|report|install-vtrace-patch|verify-vtrace-patch --vexp-swe-bench-dir /path/to/vexp-swe-bench --instances id1,id2,id3 --out benchmarks/stage5_vexp_swe_bench_smoke/results\n",
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
    case "install-vtrace-patch": {
      const manifest = await installVtracePatch(config);
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      break;
    }
    case "verify-vtrace-patch": {
      const verification = await verifyVtracePatch(config);
      process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
      if (!verification.installed) process.exitCode = 1;
      break;
    }
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
