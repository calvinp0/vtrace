import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { CapsuleMode, type CapsuleMode as CapsuleModeT } from "../../src/capsule/capsuleModes";
import {
  RecommendedCapsuleMode,
  TargetConfidence,
  deriveModeSignals,
  recommendCapsuleMode,
  type RecommendedCapsuleMode as RecommendedCapsuleModeT,
  type TargetConfidence as TargetConfidenceT,
} from "../../src/capsule/recommendMode";
import { shapeSweQuery } from "../../src/capsule/sweQueryShaping";
import {
  contextMentionsFile,
  contextMentionsSymbol,
  primaryEditedFile,
  primaryEditedSymbol,
} from "../../src/capsule/finalEditDiagnostics";

// Stage 5 is a SMOKE integration harness around the external `vexp-swe-bench`
// benchmark. It proves the baseline-vs-vtrace measurement workflow on a tiny
// subset. It does not vendor vexp-swe-bench, does not run the full benchmark,
// and makes no public SWE-bench claim. See README.md for scope.

export type Stage5Mode =
  | "prepare"
  | "run-baseline"
  | "run-vtrace"
  | "run-vexp"
  | "run-protocol"
  | "evaluate"
  | "ingest"
  | "report"
  | "aggregate-runs"
  | "install-vtrace-patch"
  | "verify-vtrace-patch";
export type Stage5Condition = "baseline" | "vtrace" | "vexp";
export type VtraceMethod = "instructions-file" | "mcp" | "local-patch" | "indexed-context";
// Stage 5C named protocols. A protocol selects which condition(s) to run and how:
//   baseline       -> `run --no-vexp`
//   vtrace-indexed -> `run --no-vexp` + vtrace indexed-context injection
//   vexp           -> `run` (vexp ENABLED) — gated behind --allow-vexp, never default
//   all            -> baseline + vtrace-indexed (+ vexp only if --allow-vexp)
export type Stage5Protocol = "baseline" | "vtrace-indexed" | "vexp" | "all";
// vexp-swe-bench evaluation modes. Stage 5C invokes the EXTERNAL benchmark's
// separate `evaluate` step (see README "Stage 5C"); `run` alone always leaves
// `resolved: null`. "docker" runs the real SWE-bench test suite; "lightweight"
// only checks patch non-emptiness and is NOT a pass/fail signal.
export type EvalMode = "docker" | "lightweight";
export const STAGE5_CONDITIONS: readonly Stage5Condition[] = ["baseline", "vtrace", "vexp"];
export type Outcome =
  | "both_resolved"
  | "vtrace_only_resolved"
  | "baseline_only_resolved"
  | "both_failed"
  | "unpaired"
  | "unknown";

// Per-row run classification. This separates the THREE distinct situations that
// were previously collapsed into a vague "no condition results" message:
//   infra_failed           — Claude/API infrastructure error (e.g. 529 overloaded);
//                            not a vtrace treatment or model-solving failure.
//   agent_failed           — the agent run errored (non-infra), no patch produced.
//   policy_skip            — vtrace deliberately injected no context (valid policy).
//   completed_patch        — a real run that produced a model patch.
//   completed_no_patch     — a real run that completed but produced no patch.
//   missing_condition_result — no result row was written (run failed before/at spawn).
// infra_failed rows are excluded from every benchmark metric; they appear only in
// the failure/rerun diagnostics so an overloaded API never reads as a vtrace loss.
export type RunStatus =
  | "infra_failed"
  | "agent_failed"
  | "policy_skip"
  | "completed_patch"
  | "completed_no_patch"
  | "missing_condition_result";

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
  // Workspace reuse policy. By default a labeled run RECREATES its workspace
  // (git clean -fdx + recheckout to the base commit + reindex) so a re-run never
  // evaluates against a stale index or leftover untracked state. --reuse-workspace
  // opts out: the existing checkout and index are reused as-is.
  readonly reuseWorkspace: boolean;
  // When true, the vtrace `index` command keeps its normal output (the runner
  // drops --quiet) so indexing progress/logs print to the terminal. Absent, the
  // index runs quietly as before.
  readonly showVtraceIndexLog: boolean;
  readonly vtraceContextMaxChars: number;
  readonly vtraceContextMaxItems: number;
  readonly sweBenchDataFile: string | null;
  readonly runLabel: string | null;
  // Stage 5C aggregate-runs: the set of run-labels to combine into one report.
  // null unless --mode aggregate-runs --run-labels a,b,c is used.
  readonly runLabels: readonly string[] | null;
  // Stage 5C (evaluated protocol) configuration.
  readonly protocol: Stage5Protocol;
  // vexp is NEVER enabled unless this is explicitly set; guards every vexp run.
  readonly allowVexp: boolean;
  readonly evalMode: EvalMode;
  // Full SWE-bench dataset JSONL (or HF name) passed to the external Docker
  // evaluator as --dataset. null defers to the evaluator's own default.
  readonly evalDataset: string | null;
  readonly evalTimeout: number;
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
  // Stage 5 vtrace policy fields. `skip` is a first-class, VALID policy decision
  // (vtrace recovered no high-confidence target for a small/local task), distinct
  // from an indexed-context treatment. null on baseline / non-indexed rows.
  readonly vtracePolicyAction: VtracePolicyAction | "unknown" | null;
  readonly vtraceContextInjected: boolean | null;
  readonly vtraceSkipReason: string | null;
  readonly vtracePivotCount: number | null;
  readonly vtraceSupportCount: number | null;
  // Cost-aware injection gate (decideContextPolicy). `vtraceContextPolicyAction`
  // is the gate's decision in its own vocabulary (`inject`|`no_context`); a
  // `no_context` decision is RECORDED via the existing `skip` mechanism above
  // (vtracePolicyAction === "skip"), so the two never disagree. The remaining
  // fields explain WHY the gate chose as it did. All null on baseline rows.
  readonly vtraceContextPolicyAction: ContextPolicyAction | "unknown" | null;
  readonly vtracePolicyReason: string | null;
  readonly expectedContextValue: ExpectedLevel | null;
  readonly expectedOverheadRisk: ExpectedLevel | null;
}

// Stage 5C evaluation evidence, normalized per instance. resolved itself stays
// on the row (it is the primary signal); these are the supporting fields proving
// HOW it was reached. All null/"unknown" until an `evaluate` run populates them —
// a generated-but-unevaluated patch never fabricates a pass/fail.
export interface EvaluationFields {
  readonly evaluationRan: boolean | null;
  readonly evaluationMethod: EvalMode | "unknown" | null;
  readonly failToPassPassed: Unknownable<boolean> | null;
  readonly passToPassPassed: Unknownable<boolean> | null;
  readonly testStatus: string | null;
  readonly dockerUsed: boolean | "unknown" | null;
  readonly evaluationError: string | null;
}

// Capsule-sizing diagnostics, per vtrace row. recommended/actual mode + the
// reason explain WHAT context vtrace decided to inject; final_edited_* (parsed
// from the model patch) + contains_* explain whether that context actually
// pointed at what the model ended up editing. All null on baseline rows and
// whenever the source data (dataset / patch / context) is unavailable — never
// coerced to a value, so a missing input reads as "unknown", not "no".
export interface CapsuleDiagnosticFields {
  readonly recommendedMode: string | null;
  readonly actualCapsuleMode: string | null;
  readonly targetConfidence: string | null;
  readonly retrievalReason: string | null;
  // How hard the agent should search before trusting the capsule (Requirement 5),
  // captured verbatim from the capsule diagnostics. null on baseline rows.
  readonly searchBudget: string | null;
  readonly searchBudgetReason: string | null;
  readonly topLikelyFile: string | null;
  readonly topLikelySymbol: string | null;
  readonly likelyTargetsCount: number | null;
  readonly finalEditedFile: string | null;
  readonly finalEditedSymbol: string | null;
  readonly containsFinalEditedFile: boolean | null;
  readonly containsFinalEditedSymbol: boolean | null;
}

// Agent-compliance diagnostics (Requirement 6): did the agent actually follow the
// capsule's "edit here first" directive? Derived from the agent's ORDERED tool
// calls when the raw result carries them. SWE-bench result records usually report
// only AGGREGATE tool counts (no ordering), so these honestly record "unknown"
// rather than guess — the parser activates only when an ordered list is present.
export interface AgentComplianceFields {
  /** The capsule's lead pivot file the directive pointed at; null if unknown. */
  readonly pivotFile: string | null;
  readonly firstReadFile: string | "unknown" | null;
  readonly firstEditFile: string | "unknown" | null;
  readonly didReadPivotBeforeSearch: Unknownable<boolean> | null;
  readonly didEditPivot: Unknownable<boolean> | null;
  readonly searchCallsBeforePivot: Unknownable<number> | null;
}

// Per-row run-status diagnostics (Requirements 1–6). runStatus is the single
// authoritative classification; the infra_* fields carry the API-failure detail
// when runStatus === "infra_failed". All default to null on freshly parsed rows
// and are (re)derived once vtrace policy + evaluation fields are stamped.
export interface RunStatusFields {
  readonly runStatus: RunStatus | null;
  readonly shouldRerun: boolean | null;
  readonly infraErrorStatus: number | null;
  readonly infraErrorKind: string | null;
  readonly infraErrorMessage: string | null;
}

export interface Stage5Row extends IndexedContextFields, EvaluationFields, CapsuleDiagnosticFields, AgentComplianceFields, RunStatusFields {
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
  // Stage 5C: the vexp condition (null when the vexp protocol was not run), so a
  // single row can present baseline vs vtrace vs vexp side by side.
  readonly vexpResolved: Unknownable<boolean> | null;
  readonly vexpTotalTokens: Unknownable<number> | null;
  readonly vexpTokenReductionPct: number | null;
  // Whether at least two conditions produced a patch, so a diff/similarity could
  // be computed for this instance (we do not compute similarity here, only flag it).
  readonly patchDiffAvailable: boolean;
}

// Stage 5C per-condition aggregate. resolvedRate is over EVALUATED instances
// (resolved !== "unknown") only — unknown never counts as a pass or a fail.
export interface ConditionSummary {
  readonly condition: Stage5Condition;
  readonly instances: number;
  readonly resolvedCount: number;
  readonly evaluatedCount: number;
  readonly resolvedRate: number | null;
  readonly meanCost: number | null;
  readonly meanDuration: number | null;
  readonly meanTotalTokens: number | null;
  readonly meanTokensForResolved: number | null;
  readonly meanCostForResolved: number | null;
  readonly validTreatments: number;
  readonly invalidTreatments: number;
}

// Stage 5C per-condition evaluation evidence, reconstructed from the recorded
// `_eval.meta.json` an `evaluate` run writes next to each condition's results.
export interface EvaluationEvidence {
  readonly condition: Stage5Condition;
  readonly evaluationRan: boolean;
  readonly evaluationMethod: EvalMode | "unknown";
  readonly dockerUsed: boolean | "unknown";
  readonly evaluationError: string | null;
  readonly resultsFile: string | null;
  readonly instancesEvaluated: number;
  readonly resolvedCount: number;
  readonly notes: readonly string[];
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
  // Stage 5 vtrace policy aggregates (over vtrace rows).
  readonly skipCount: number;
  readonly contextInjectedCount: number;
  // Cost-aware gate aggregates (Requirement 4): injected-context rows and
  // no-context rows are counted SEPARATELY so a no-context policy run is never
  // tallied as an injected-context win. `noContextCount` is the count of valid
  // no-context policy rows (recorded via the `skip` mechanism);
  // `injectedContextCount` mirrors `contextInjectedCount` under the gate's
  // vocabulary.
  readonly injectedContextCount: number;
  readonly noContextCount: number;
  readonly invalidTreatmentCount: number;
  // Run-status / failure aggregates (Requirement 5), over ALL rows plus the
  // missing-result detector. infra_failed rows are excluded from every metric
  // above and surface only through these counts and the failure diagnostics.
  readonly infraFailedCount: number;
  readonly policySkipCount: number;
  readonly agentFailedCount: number;
  readonly completedPatchCount: number;
  readonly completedNoPatchCount: number;
  readonly missingResultCount: number;
  readonly rerunRecommendedCount: number;
}

// A condition that has run artifacts (meta / stdout / stderr) but produced no
// usable result row, with an artifact-aware reason. Surfaced in the report so a
// missing JSONL is never silently dropped.
export interface MissingConditionResult {
  readonly condition: Stage5Condition;
  readonly reason: string;
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
  // Stage 5C aggregate report fields.
  readonly conditionSummaries: readonly ConditionSummary[];
  readonly evaluations: readonly EvaluationEvidence[];
  // Conditions that ran but produced no usable result row (artifact-aware).
  readonly missingResults: readonly MissingConditionResult[];
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
  reuseWorkspace: false,
  showVtraceIndexLog: false,
  vtraceContextMaxChars: 12000,
  vtraceContextMaxItems: 8,
  sweBenchDataFile: null,
  runLabel: null,
  runLabels: null,
  // Stage 5C: baseline protocol by default; vexp stays off unless --allow-vexp.
  protocol: "baseline",
  allowVexp: false,
  evalMode: "docker",
  evalDataset: null,
  evalTimeout: 1800,
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
  "vtrace_policy_action",
  "vtrace_context_policy_action",
  "vtrace_policy_reason",
  "expected_context_value",
  "expected_overhead_risk",
  "vtrace_context_injected",
  "vtrace_skip_reason",
  "pivot_count",
  "support_count",
  "recommended_mode",
  "actual_capsule_mode",
  "target_confidence",
  "retrieval_reason",
  "search_budget",
  "search_budget_reason",
  "top_likely_file",
  "top_likely_symbol",
  "likely_targets_count",
  "final_edited_file",
  "final_edited_symbol",
  "contains_final_edited_file",
  "contains_final_edited_symbol",
  "pivot_file",
  "first_read_file",
  "first_edit_file",
  "did_read_pivot_before_search",
  "did_edit_pivot",
  "search_calls_before_pivot",
  "context_chars",
  "context_items",
  "run_status",
  "should_rerun",
  "infra_error_status",
  "infra_error_kind",
  "infra_error_message",
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

// Per-condition raw output dir. With --run-label, runs are isolated under
// runs/<label>/ so multiple instances/protocols do not overwrite each other:
//   results/runs/<label>/raw/{baseline,vtrace,vexp}
// Without a label the legacy flat layout (results/raw/<condition>) is kept.
export function rawConditionDir(outDir: string, condition: Stage5Condition, runLabel: string | null = null): string {
  const root = runLabel === null ? outDir : path.join(outDir, "runs", runLabel);
  return path.join(root, "raw", condition);
}

export function buildRunArgs(
  config: CliConfig,
  instances: readonly string[],
  outputDir: string,
  enableVexp: boolean,
): string[] {
  const args = [config.cliEntry, "run", "--instances", instances.join(","), "--output", outputDir];
  // --no-vexp keeps vexp disabled for the baseline and vtrace conditions. Only
  // the explicit, --allow-vexp-gated vexp condition omits it to enable vexp.
  if (!enableVexp) args.splice(4, 0, "--no-vexp");
  return args;
}

export function buildBaselineCommand(
  config: CliConfig,
  instances: readonly string[],
): { command: string; args: string[]; cwd: string | null } {
  return {
    command: config.nodeCommand,
    args: buildRunArgs(config, instances, rawConditionDir(config.out, "baseline", config.runLabel), false),
    cwd: config.vexpSweBenchDir,
  };
}

export function buildVtraceCommand(
  config: CliConfig,
  instances: readonly string[],
  injectContext = true,
): { command: string; args: string[]; cwd: string | null; env: Record<string, string> } {
  // The vtrace condition uses the IDENTICAL benchmark command as baseline
  // (still --no-vexp, same model/agent/budget). vtrace is injected out-of-band
  // via environment so vexp is never enabled and command parity is preserved.
  // A SKIP-policy run (injectContext=false) omits the instructions-file env, so
  // the benchmark runs WITHOUT any injected context — a real vtrace-policy row.
  return {
    command: config.nodeCommand,
    args: buildRunArgs(config, instances, rawConditionDir(config.out, "vtrace", config.runLabel), false),
    cwd: config.vexpSweBenchDir,
    env: vtraceEnv(config, injectContext),
  };
}

// The vexp condition runs the EXTERNAL benchmark with vexp ENABLED (no --no-vexp).
// It is the only condition that turns vexp on, and only callers that have already
// asserted --allow-vexp should build it. No vtrace env is attached.
export function buildVexpCommand(
  config: CliConfig,
  instances: readonly string[],
): { command: string; args: string[]; cwd: string | null } {
  return {
    command: config.nodeCommand,
    args: buildRunArgs(config, instances, rawConditionDir(config.out, "vexp", config.runLabel), true),
    cwd: config.vexpSweBenchDir,
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

function vtraceEnv(config: CliConfig, injectContext = true): Record<string, string> {
  const env: Record<string, string> = {
    VTRACE_SMOKE: "1",
    VTRACE_METHOD: config.vtraceMethod,
  };
  // Only point the adapter at the instructions file when we actually inject. A
  // skip-policy run leaves it unset so nothing is injected.
  if (injectContext) {
    env.VTRACE_AGENT_INSTRUCTIONS_FILE = vtraceInstructionsFilePath(config.out);
  }
  return env;
}

function isVtracePolicyAction(value: unknown): value is VtracePolicyAction {
  return value === "inject" || value === "skip" || value === "error";
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
    const vexp = conditions.get("vexp") ?? null;
    // A diff/similarity could be computed only if at least two conditions actually
    // produced a patch. We flag availability; we do not compute the diff here.
    const patchCount = [baseline, vtrace, vexp].filter((row) => row?.patchAvailable === true).length;
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
      vexpResolved: vexp?.resolved ?? null,
      vexpTotalTokens: vexp?.totalTokens ?? null,
      vexpTokenReductionPct: reductionPct(baseline?.totalTokens ?? null, vexp?.totalTokens ?? null),
      patchDiffAvailable: patchCount >= 2,
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

// Tool-name classification for agent-compliance parsing (Requirement 6).
const READ_TOOLS = new Set(["read", "view", "open", "cat", "readfile"]);
const EDIT_TOOLS = new Set(["edit", "write", "str_replace", "str_replace_editor", "notebookedit", "apply_patch", "multiedit"]);
const SEARCH_TOOLS = new Set(["grep", "glob", "search", "find", "ripgrep", "rg", "codebase_search", "ls"]);

interface OrderedToolCall {
  readonly tool: string;
  readonly target: string | null;
}

// Pull an ORDERED tool-call sequence out of a result record, if one is present.
// SWE-bench records usually carry only aggregate counts (an object), so this
// returns null in that common case — the caller then records "unknown".
function readOrderedToolCalls(record: Record<string, unknown>): OrderedToolCall[] | null {
  const raw = pick(record, ["tool_calls", "toolCalls", "tool_uses", "toolUses", "tool_call_log", "actions"]);
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const calls: OrderedToolCall[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = pick(entry, ["name", "tool", "tool_name", "type", "function"]);
    if (!isString(name)) continue;
    const input = pick(entry, ["input", "args", "arguments", "parameters", "params"]);
    const target = isRecord(input)
      ? (pick(input, ["file_path", "filePath", "path", "file", "filename", "notebook_path"]) as unknown)
      : null;
    calls.push({ tool: name.toLowerCase().trim(), target: isString(target) ? target : null });
  }
  return calls.length > 0 ? calls : null;
}

// True when `target` names the pivot file (exact, or by path-suffix so a relative
// vs absolute mismatch still matches).
function targetsFile(target: string | null, file: string): boolean {
  if (target === null) return false;
  return target === file || target.endsWith(`/${file}`) || file.endsWith(`/${target}`);
}

// Build the agent-compliance diagnostics for one result record (Requirement 6).
// When the record carries an ordered tool-call list we report whether the agent
// followed the capsule's "edit here first" directive; otherwise every signal is
// "unknown" — we never guess from aggregate counts.
export function buildAgentCompliance(
  record: Record<string, unknown>,
  pivotFile: string | null,
): AgentComplianceFields {
  const calls = readOrderedToolCalls(record);
  if (calls === null) {
    return { ...nullAgentComplianceFields(), pivotFile };
  }

  const firstReadFile = calls.find((call) => READ_TOOLS.has(call.tool) && call.target !== null)?.target ?? "unknown";
  const firstEditFile = calls.find((call) => EDIT_TOOLS.has(call.tool) && call.target !== null)?.target ?? "unknown";

  // Pivot-relative signals require knowing which file the directive pointed at.
  if (pivotFile === null) {
    return {
      pivotFile: null,
      firstReadFile,
      firstEditFile,
      didReadPivotBeforeSearch: "unknown",
      didEditPivot: "unknown",
      searchCallsBeforePivot: "unknown",
    };
  }

  const firstSearchIdx = calls.findIndex((call) => SEARCH_TOOLS.has(call.tool));
  const firstPivotTouchIdx = calls.findIndex(
    (call) => (READ_TOOLS.has(call.tool) || EDIT_TOOLS.has(call.tool)) && targetsFile(call.target, pivotFile),
  );
  const didEditPivot = calls.some((call) => EDIT_TOOLS.has(call.tool) && targetsFile(call.target, pivotFile));
  const didReadPivotBeforeSearch =
    firstPivotTouchIdx !== -1 && (firstSearchIdx === -1 || firstPivotTouchIdx < firstSearchIdx);
  const searchCallsBeforePivot = calls
    .slice(0, firstPivotTouchIdx === -1 ? calls.length : firstPivotTouchIdx)
    .filter((call) => SEARCH_TOOLS.has(call.tool)).length;

  return {
    pivotFile,
    firstReadFile,
    firstEditFile,
    didReadPivotBeforeSearch,
    didEditPivot,
    searchCallsBeforePivot,
  };
}

// Detail about a Claude/API infrastructure failure detected in a raw result.
// Distinct from an agent failure (the model ran but did not solve) and from a
// vtrace treatment failure — an infra failure means no real attempt happened.
export interface InfraFailure {
  // The HTTP-ish status when one was reported (e.g. 529), else null.
  readonly infraErrorStatus: number | null;
  // Coarse machine-readable kind: "api_overloaded" | "api_error" | "zero_cost_no_output".
  readonly infraErrorKind: string;
  readonly infraErrorMessage: string;
}

// Classify a raw vexp/Claude result record as an infrastructure failure when ANY
// of the documented signals are present (Requirement 1):
//   - api_error_status is present
//   - the error text contains "API Error"
//   - the error text contains "overloaded"
//   - error_status is 529
//   - total_cost_usd == 0 AND all token counts are 0 AND the patch is empty/null
// Returns null when none match (i.e. this is a real run, however it turned out).
export function classifyInfraFailure(record: Record<string, unknown>): InfraFailure | null {
  const apiErrorStatus = toNumberOrNull(record.api_error_status ?? record.apiErrorStatus);
  const errorStatus = toNumberOrNull(record.error_status ?? record.errorStatus);
  const status = apiErrorStatus ?? errorStatus;

  const errorValue = pick(record, FIELD_ALIASES.error!);
  const errorText = isString(errorValue) ? errorValue : null;
  const errorLower = (errorText ?? "").toLowerCase();

  const overloaded = errorLower.includes("overloaded") || status === 529;
  const apiError = apiErrorStatus !== null || errorLower.includes("api error");

  // Zero-cost / zero-token / no-patch: the run produced nothing chargeable, which
  // in practice means the API rejected the request before any real work happened.
  const cost = asUnknownableNumber(pick(record, FIELD_ALIASES.costUsd!));
  const inputTokens = asUnknownableNumber(pick(record, FIELD_ALIASES.inputTokens!));
  const outputTokens = asUnknownableNumber(pick(record, FIELD_ALIASES.outputTokens!));
  const patchValue = pick(record, FIELD_ALIASES.patch!);
  const patchEmpty =
    patchValue === undefined ||
    patchValue === null ||
    patchValue === false ||
    (isString(patchValue) && patchValue.trim().length === 0);
  const zeroCostNoOutput = cost === 0 && inputTokens === 0 && outputTokens === 0 && patchEmpty;

  if (!overloaded && !apiError && !zeroCostNoOutput && status === null) return null;

  const kind = overloaded ? "api_overloaded" : apiError ? "api_error" : "zero_cost_no_output";
  const message =
    errorText ??
    (apiErrorStatus !== null
      ? `api_error_status ${apiErrorStatus}`
      : status !== null
        ? `error_status ${status}`
        : "no tokens spent and no patch generated");
  return { infraErrorStatus: status, infraErrorKind: kind, infraErrorMessage: message };
}

// Number coercion that, unlike asUnknownableNumber, returns null (not "unknown")
// for absent/invalid values — used for the optional infra status fields.
function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// Derive the authoritative run status from the classification inputs. Precedence:
// infra failure first (never let an API error read as a model result), then a
// valid vtrace skip policy, then a non-infra agent error, then patch presence.
// Only infra failures recommend a rerun — an agent failure or a no-patch run is
// a real (if unsuccessful) attempt, not a transient infrastructure problem.
export function deriveRunStatus(opts: {
  infra: InfraFailure | null;
  error: string | null;
  patchAvailable: Unknownable<boolean>;
  policyAction: VtracePolicyAction | "unknown" | null;
}): { runStatus: RunStatus; shouldRerun: boolean } {
  if (opts.infra !== null) return { runStatus: "infra_failed", shouldRerun: true };
  if (opts.policyAction === "skip") return { runStatus: "policy_skip", shouldRerun: false };
  if (opts.error !== null) return { runStatus: "agent_failed", shouldRerun: false };
  if (opts.patchAvailable === true) return { runStatus: "completed_patch", shouldRerun: false };
  return { runStatus: "completed_no_patch", shouldRerun: false };
}

function nullRunStatusFields(): RunStatusFields {
  return {
    runStatus: null,
    shouldRerun: null,
    infraErrorStatus: null,
    infraErrorKind: null,
    infraErrorMessage: null,
  };
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
  // Parse the file/symbol the model actually edited straight from the patch. The
  // recommendation + containment diagnostics are filled later (post-merge), where
  // the dataset and injected context are available.
  const finalEditedFile = patchIsString ? primaryEditedFile(patchValue) : null;
  const finalEditedSymbol = patchIsString ? primaryEditedSymbol(patchValue) : null;

  const errorValue = pick(record, FIELD_ALIASES.error!);
  const modelValue = pick(record, FIELD_ALIASES.model!);
  const agentValue = pick(record, FIELD_ALIASES.agent!);
  const repoValue = pick(record, FIELD_ALIASES.repo!);

  // Detect API/infra failures straight from the raw record. The vtrace policy
  // action is unknown at parse time (it is stamped during ingest), so runStatus
  // is provisional here and re-derived once the policy is known.
  const infra = classifyInfraFailure(record);
  const provisionalStatus = deriveRunStatus({
    infra,
    error: isString(errorValue) ? errorValue : null,
    patchAvailable,
    policyAction: null,
  });

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
    ...nullEvaluationFields(),
    ...nullCapsuleDiagnosticFields(),
    // Agent-compliance: parsed from the record's ordered tool calls when present
    // (pivot-relative fields are re-stamped once the pivot file is known).
    ...buildAgentCompliance(record, null),
    runStatus: provisionalStatus.runStatus,
    shouldRerun: provisionalStatus.shouldRerun,
    infraErrorStatus: infra?.infraErrorStatus ?? null,
    infraErrorKind: infra?.infraErrorKind ?? null,
    infraErrorMessage: infra?.infraErrorMessage ?? null,
    finalEditedFile,
    finalEditedSymbol,
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
    protocol: config.protocol,
    allowVexp: config.allowVexp,
    runLabel: config.runLabel,
    outputDirs: {
      baselineRaw: rawConditionDir(config.out, "baseline", config.runLabel),
      vtraceRaw: rawConditionDir(config.out, "vtrace", config.runLabel),
      vexpRaw: rawConditionDir(config.out, "vexp", config.runLabel),
    },
    commands: {
      baseline: renderCommand(buildBaselineCommand(config, instances)),
      vtrace: renderCommand(buildVtraceCommand(config, instances)),
      // The vexp command is shown for transparency; it only RUNS with --allow-vexp.
      vexp: renderCommand(buildVexpCommand(config, instances)),
    },
    notes: [
      instances.length === 0 ? "No instances selected; pass --instances or populate smoke_instances.json." : "",
      config.vexpSweBenchDir === null ? "No --vexp-swe-bench-dir provided." : "",
      !config.allowVexp ? "vexp condition is gated: pass --allow-vexp to run the vexp protocol." : "",
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
  // Whether to inject vtrace context into the spawned run. A valid SKIP policy
  // runs the benchmark WITHOUT injection (no instructions file env) — a real
  // vtrace-policy row, not an indexed-context treatment.
  let injectContext = true;

  if (config.vtraceMethod === "indexed-context") {
    // Stage 5B: real vtrace indexing + query produces the injected context. The
    // local prompt patch is the injection mechanism, so require it first. Then
    // build the context; if it cannot be generated, abort BEFORE spawning vexp —
    // never silently fall back to generic instructions or spend tokens on a
    // non-treatment run — UNLESS vtrace deliberately skipped (a valid policy).
    await assertVtracePatchInstalled(config);
    const indexed = await prepareIndexedContext(config, deps);
    extraVtraceMeta = { ...indexedContextMetaFields(indexed), ...indexRunMetaFields(indexed) };
    if (indexed.policyAction === "skip") {
      // VALID no-context policy (cost-aware gate, decideContextPolicy): the
      // expected value of injected context did not exceed its overhead — either
      // vtrace recovered no high-confidence target, or the task is cheap/local
      // enough that even action-oriented context is net overhead. Run the
      // external benchmark with --no-vexp and NO instructions file, so we still
      // measure a real resolved/cost/tokens row for the vtrace-policy condition
      // while recording that nothing was injected.
      injectContext = false;
      process.stderr.write(
        `Stage5 vtrace policy: no_context (no context injected) — ${indexed.policyReason ?? indexed.skipReason ?? "no high-confidence actionable target recovered"}\n`,
      );
    } else if (!indexed.indexedContext) {
      throw new Error(
        `indexed-context preparation produced no vtrace context (${indexed.contextError ?? "unknown error"}); ` +
          "aborting before spawn so no tokens are spent on a non-treatment run.",
      );
    } else {
      await assertVtraceInstructionsFileValid(instructionsPath);
    }
  } else {
    // Generic instructions-file / local-patch: write the generic instructions.
    await writeFile(instructionsPath, `${vtraceInstructionsText()}\n`);
    if (config.vtraceMethod === "local-patch") {
      await assertVtraceInstructionsFileValid(instructionsPath);
      await assertVtracePatchInstalled(config);
    }
  }
  await runCondition(config, "vtrace", deps, extraVtraceMeta, injectContext);
}

// Stage 5C: run the EXTERNAL benchmark with vexp ENABLED. This is the only
// condition that turns vexp on, so it is hard-gated behind --allow-vexp. The
// guard fires BEFORE any spawn so an accidental vexp run is impossible.
export async function runVexp(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  assertVexpAllowed(config);
  await ensureOutputTree(config.out);
  await runCondition(config, "vexp", deps);
}

// Throws unless --allow-vexp was explicitly passed. Centralized so every vexp
// entry point (run-vexp, protocol vexp/all) shares the identical guard.
export function assertVexpAllowed(config: CliConfig): void {
  if (!config.allowVexp) {
    throw new Error(
      "Refusing to run the vexp-enabled condition without --allow-vexp. The vexp protocol runs " +
        "`node dist/cli.js run` WITHOUT --no-vexp; pass --allow-vexp to opt in explicitly.",
    );
  }
}

// Stage 5C: dispatch a named protocol to the underlying condition runner(s).
// `all` runs baseline + vtrace-indexed always, and vexp only when --allow-vexp
// is set (otherwise it is skipped with a clear note rather than failing the run).
export async function runProtocol(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  switch (config.protocol) {
    case "baseline":
      await runBaseline(config, deps);
      return;
    case "vtrace-indexed":
      // The vtrace-indexed protocol always means the indexed-context method.
      await runVtrace({ ...config, vtraceMethod: "indexed-context" }, deps);
      return;
    case "vexp":
      await runVexp(config, deps);
      return;
    case "all": {
      await runBaseline(config, deps);
      await runVtrace({ ...config, vtraceMethod: "indexed-context" }, deps);
      if (config.allowVexp) {
        await runVexp(config, deps);
      } else {
        process.stderr.write(
          "Stage5 protocol all: skipping vexp condition (no --allow-vexp). Baseline and vtrace-indexed ran.\n",
        );
      }
      return;
    }
  }
}

// ----- Stage 5C: evaluate mode ------------------------------------------------

// Canonical evidence file written next to each condition's results when an
// evaluate run completes, so ingest can report HOW resolved was reached.
const EVAL_META_FILENAME = "_eval.meta.json";

// Build the external evaluator command. vexp-swe-bench evaluates as a SEPARATE
// step from `run` (which always leaves resolved=null): `evaluate <jsonl>` mutates
// `resolved` IN-PLACE in the same JSONL. docker mode runs the real SWE-bench
// suite; lightweight only checks patch non-emptiness and is NOT a pass/fail signal.
export function buildEvaluateCommand(
  config: CliConfig,
  resultsFile: string,
): { command: string; args: string[]; cwd: string | null } {
  const args = [config.cliEntry, "evaluate", resultsFile, "--mode", config.evalMode, "--timeout", String(config.evalTimeout)];
  if (config.evalMode === "docker" && config.evalDataset !== null) args.push("--dataset", config.evalDataset);
  return { command: config.nodeCommand, args, cwd: config.vexpSweBenchDir };
}

// Find the canonical `swebench-*.jsonl` result log in a condition dir (the file
// the evaluator reads and rewrites). Returns null when no result has been run.
export async function findCanonicalResultsFile(dir: string): Promise<string | null> {
  const files = await listFilesRecursive(dir).catch(() => [] as string[]);
  const canonical = files.filter((absolute) => isCanonicalResultFile(path.basename(absolute)));
  return canonical.sort().at(-1) ?? null;
}

// Count rows with a concrete resolved=true in a JSONL results file (post-eval),
// tolerating the same field aliases the row parser uses.
async function summarizeResolvedFromFile(resultsFile: string): Promise<{ evaluated: number; resolved: number }> {
  const content = await readFile(resultsFile, "utf8").catch(() => "");
  const records = parseJsonlRecords(content);
  let evaluated = 0;
  let resolved = 0;
  for (const record of records) {
    const value = pick(record, FIELD_ALIASES.resolved!);
    if (value === undefined || value === null) continue;
    const flag = asUnknownableBoolean(value);
    if (flag === "unknown") continue;
    evaluated += 1;
    if (flag === true) resolved += 1;
  }
  return { evaluated, resolved };
}

// Invoke the external evaluator for ONE condition's results file and capture
// per-condition evidence. The evaluator mutates `resolved` in-place; we re-read
// the file to count outcomes. Never throws on a non-zero evaluator exit — the
// failure is recorded as evaluation_error so a later run can be retried.
export async function evaluateCondition(
  config: CliConfig,
  condition: Stage5Condition,
  resultsFile: string,
  deps: RunDeps = {},
): Promise<EvaluationEvidence> {
  const spec = buildEvaluateCommand(config, resultsFile);
  const result = await (deps.runProcess ?? runProcess)(spec.command, spec.args, { cwd: spec.cwd ?? undefined });
  const ran = result.exitCode === 0;
  const evaluationError = ran ? null : `evaluate exited ${result.exitCode}: ${result.stderr.trim() || "(no stderr)"}`;
  const counts = await summarizeResolvedFromFile(resultsFile);
  const notes: string[] = [];
  if (config.evalMode === "lightweight") {
    notes.push("Lightweight evaluation does NOT run tests; resolved=unknown patches stay unevaluated.");
  }
  if (!ran) notes.push("Evaluation command failed; resolved values were not updated.");
  return {
    condition,
    evaluationRan: ran,
    evaluationMethod: config.evalMode,
    // docker_used is true only when docker mode actually completed.
    dockerUsed: config.evalMode === "docker" ? ran : false,
    evaluationError,
    resultsFile,
    instancesEvaluated: counts.evaluated,
    resolvedCount: counts.resolved,
    notes,
  };
}

// The vague-but-only-honest-when-truly-empty fallback. Kept as a named constant
// so evaluate prints it ONLY when no artifacts of any kind exist for a condition.
const NO_ARTIFACTS_MESSAGE =
  "No condition results found to evaluate. Run a protocol/condition first, then --mode evaluate.";

// Artifact-aware diagnosis of why a condition can or cannot be evaluated
// (Requirement 3). Inspects the canonical JSONL plus the `_run.*` artifacts so
// the report distinguishes "ran but API-overloaded", "ran but no patch",
// "skipped by policy", "failed before spawn", and "never run".
export interface ConditionEvalDiagnosis {
  readonly hasArtifacts: boolean;
  readonly hasResultsFile: boolean;
  readonly infra: InfraFailure | null;
  // True only when a non-infra JSONL with at least one patch row is present.
  readonly evaluable: boolean;
  readonly message: string;
}

export async function diagnoseConditionEvaluability(dir: string): Promise<ConditionEvalDiagnosis> {
  const resultsFile = await findCanonicalResultsFile(dir);
  const meta = await readJsonIfExists(path.join(dir, "_run.meta.json"));
  const stderr = await readFile(path.join(dir, "_run.stderr.txt"), "utf8").catch(() => null);
  const stdout = await readFile(path.join(dir, "_run.stdout.txt"), "utf8").catch(() => null);
  const hasArtifacts = resultsFile !== null || meta !== null || stderr !== null || stdout !== null;

  if (resultsFile !== null) {
    const content = await readFile(resultsFile, "utf8").catch(() => "");
    const records = parseJsonlRecords(content);
    const infra = records.map((record) => classifyInfraFailure(record)).find((value): value is InfraFailure => value !== null) ?? null;
    if (infra !== null) {
      const statusText = infra.infraErrorStatus !== null ? `API ${infra.infraErrorStatus}` : "API error";
      const kindText = infra.infraErrorKind === "api_overloaded" ? "overloaded" : infra.infraErrorKind;
      return {
        hasArtifacts: true,
        hasResultsFile: true,
        infra,
        evaluable: false,
        message: `JSONL found but contains infra failure: ${statusText} ${kindText}. Rerun this label.`,
      };
    }
    const hasPatch = records.some((record) => {
      const patch = pick(record, FIELD_ALIASES.patch!);
      return isString(patch) ? patch.trim().length > 0 : Boolean(patch);
    });
    if (!hasPatch) {
      return {
        hasArtifacts: true,
        hasResultsFile: true,
        infra: null,
        evaluable: false,
        message: "JSONL found but contains no patch/model output.",
      };
    }
    return {
      hasArtifacts: true,
      hasResultsFile: true,
      infra: null,
      evaluable: true,
      message: "JSONL found with patch/model output; ready to evaluate.",
    };
  }

  // No canonical results file — decide why from the surrounding artifacts.
  if (!hasArtifacts) {
    return { hasArtifacts: false, hasResultsFile: false, infra: null, evaluable: false, message: NO_ARTIFACTS_MESSAGE };
  }
  if (isRecord(meta) && meta.vtracePolicyAction === "skip") {
    return {
      hasArtifacts: true,
      hasResultsFile: false,
      infra: null,
      evaluable: false,
      message: "No JSONL found because vtrace policy selected skip and no execution was requested.",
    };
  }
  return {
    hasArtifacts: true,
    hasResultsFile: false,
    infra: null,
    evaluable: false,
    message: "No JSONL found because run-protocol failed before spawn.",
  };
}

// Stage 5C evaluate mode: run the external evaluator for every condition that has
// an evaluable result file, writing per-condition `_eval.meta.json`. Conditions
// that cannot be evaluated get an artifact-aware explanation on stderr instead of
// a single vague message (Requirement 3). Returns the collected evidence.
export async function runEvaluate(config: CliConfig, deps: RunDeps = {}): Promise<EvaluationEvidence[]> {
  if (config.vexpSweBenchDir === null) throw new Error("--mode evaluate requires --vexp-swe-bench-dir.");
  const cliPath = path.join(config.vexpSweBenchDir, config.cliEntry);
  if (!(await pathExists(cliPath))) {
    throw new Error(`vexp-swe-bench CLI not found at ${cliPath}. Run ./setup.sh in the external checkout first.`);
  }
  await ensureOutputTree(config.out);
  const evaluations: EvaluationEvidence[] = [];
  const diagnoses: Array<{ condition: Stage5Condition; diagnosis: ConditionEvalDiagnosis }> = [];
  for (const condition of STAGE5_CONDITIONS) {
    const dir = rawConditionDir(config.out, condition, config.runLabel);
    const diagnosis = await diagnoseConditionEvaluability(dir);
    diagnoses.push({ condition, diagnosis });
    // Explain every condition that has artifacts but is not evaluable, so an
    // API-overloaded or no-patch run is never silently skipped.
    if (!diagnosis.evaluable) {
      if (diagnosis.hasArtifacts) process.stderr.write(`Stage5 evaluate [${condition}]: ${diagnosis.message}\n`);
      continue;
    }
    const resultsFile = await findCanonicalResultsFile(dir);
    if (resultsFile === null) continue; // defensive: evaluable implies a file exists
    const evidence = await evaluateCondition(config, condition, resultsFile, deps);
    await writeFile(path.join(dir, EVAL_META_FILENAME), `${JSON.stringify(evidence, null, 2)}\n`);
    evaluations.push(evidence);
  }
  if (evaluations.length === 0) {
    // Only fall back to the vague message when there are truly no artifacts for
    // any condition; otherwise surface the artifact-aware reasons we collected.
    const withArtifacts = diagnoses.filter((entry) => entry.diagnosis.hasArtifacts);
    if (withArtifacts.length === 0) throw new Error(NO_ARTIFACTS_MESSAGE);
    const detail = withArtifacts.map((entry) => `  ${entry.condition}: ${entry.diagnosis.message}`).join("\n");
    throw new Error(`No condition results were evaluable. Per-condition diagnosis:\n${detail}`);
  }
  return evaluations;
}

// Normalize one instance's evaluation evidence out of a SWE-bench per-instance
// report object (the structure swebench writes to report.json), keeping every
// field "unknown" when the report does not expose it. Pure + easily testable:
//
//   { "<id>": { resolved, tests_status: { FAIL_TO_PASS: {success, failure}, ... } } }
//
export function normalizeEvaluationEvidence(
  report: unknown,
  instanceId: string,
  method: EvalMode | "unknown",
): {
  resolved: Unknownable<boolean>;
  failToPassPassed: Unknownable<boolean>;
  passToPassPassed: Unknownable<boolean>;
  testStatus: string | null;
} {
  const unknown = { resolved: "unknown" as const, failToPassPassed: "unknown" as const, passToPassPassed: "unknown" as const, testStatus: null };
  if (!isRecord(report)) return unknown;
  // Reports may be keyed by instance id, or be the instance entry directly.
  const entry = isRecord(report[instanceId]) ? (report[instanceId] as Record<string, unknown>) : report;
  const resolved = typeof entry.resolved === "boolean" ? entry.resolved : ("unknown" as const);
  const status = isRecord(entry.tests_status) ? entry.tests_status : null;
  // A bucket "passed" iff it has at least one success and no failures.
  const bucketPassed = (name: string): Unknownable<boolean> => {
    if (status === null || !isRecord(status[name])) return "unknown";
    const bucket = status[name] as Record<string, unknown>;
    const success = Array.isArray(bucket.success) ? bucket.success.length : null;
    const failure = Array.isArray(bucket.failure) ? bucket.failure.length : null;
    if (success === null && failure === null) return "unknown";
    return (failure ?? 0) === 0 && (success ?? 0) > 0;
  };
  const failToPassPassed = bucketPassed("FAIL_TO_PASS");
  const passToPassPassed = bucketPassed("PASS_TO_PASS");
  const testStatus =
    status === null
      ? null
      : `FAIL_TO_PASS=${describeBucket(status.FAIL_TO_PASS)}; PASS_TO_PASS=${describeBucket(status.PASS_TO_PASS)} (${method})`;
  return { resolved, failToPassPassed, passToPassPassed, testStatus };
}

function describeBucket(bucket: unknown): string {
  if (!isRecord(bucket)) return "n/a";
  const success = Array.isArray(bucket.success) ? bucket.success.length : 0;
  const failure = Array.isArray(bucket.failure) ? bucket.failure.length : 0;
  return `${success} pass / ${failure} fail`;
}

// Reconstruct per-condition evaluation evidence from the recorded _eval.meta.json
// files. Returns [] when no evaluation has been run (resolved fields stay unknown).
async function collectEvaluationEvidence(outDir: string, runLabel: string | null = null): Promise<EvaluationEvidence[]> {
  const evaluations: EvaluationEvidence[] = [];
  for (const condition of STAGE5_CONDITIONS) {
    const dir = rawConditionDir(outDir, condition, runLabel);
    const meta = await readJsonIfExists(path.join(dir, EVAL_META_FILENAME));
    if (!isRecord(meta)) continue;
    evaluations.push(evaluationEvidenceFromMeta(meta, condition));
  }
  return evaluations;
}

function evaluationEvidenceFromMeta(meta: Record<string, unknown>, condition: Stage5Condition): EvaluationEvidence {
  const method = meta.evaluationMethod === "docker" || meta.evaluationMethod === "lightweight" ? meta.evaluationMethod : "unknown";
  return {
    condition,
    evaluationRan: meta.evaluationRan === true,
    evaluationMethod: method,
    dockerUsed: typeof meta.dockerUsed === "boolean" ? meta.dockerUsed : "unknown",
    evaluationError: isString(meta.evaluationError) ? meta.evaluationError : null,
    resultsFile: isString(meta.resultsFile) ? meta.resultsFile : null,
    instancesEvaluated: isNumber(meta.instancesEvaluated) ? meta.instancesEvaluated : 0,
    resolvedCount: isNumber(meta.resolvedCount) ? meta.resolvedCount : 0,
    notes: Array.isArray(meta.notes) ? meta.notes.filter(isString) : [],
  };
}

// Stamp the per-condition evaluation evidence onto each row so the normalized
// rows carry the run-level eval status. Per-instance test detail (FAIL_TO_PASS
// counts) stays "unknown" here: it lives in swebench's own report.json, which the
// evaluator does not surface into the JSONL, so we never fabricate it.
function stampEvaluationRows(rows: readonly Stage5Row[], evaluations: readonly EvaluationEvidence[]): Stage5Row[] {
  const byCondition = new Map<Stage5Condition, EvaluationEvidence>();
  for (const evidence of evaluations) byCondition.set(evidence.condition, evidence);
  return rows.map((row) => {
    const evidence = byCondition.get(row.condition);
    if (evidence === undefined) return row;
    return {
      ...row,
      evaluationRan: evidence.evaluationRan,
      evaluationMethod: evidence.evaluationMethod,
      dockerUsed: evidence.dockerUsed,
      evaluationError: evidence.evaluationError,
    };
  });
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
  // Workspace/index run metadata, surfaced into the vtrace _run.meta.json.
  readonly freshWorkspace: boolean;
  readonly vtraceIndexQuiet: boolean;
  readonly vtraceIndexStartedAt: string | null;
  readonly vtraceIndexFinishedAt: string | null;
  readonly vtraceIndexDurationMs: number | null;
  readonly contextFile: string;
  readonly contextChars: number;
  readonly contextItems: number;
  readonly contextTruncated: boolean;
  readonly contextError: string | null;
  // Run-level vtrace policy: "inject" when any real context was produced, "skip"
  // when none was AND every empty result was an intentional capsule skip (no hard
  // error), "error" when an empty result was a genuine failure.
  readonly policyAction: VtracePolicyAction;
  readonly contextInjected: boolean;
  readonly skipReason: string | null;
  readonly pivotCount: number | null;
  readonly supportCount: number | null;
  readonly actualCapsuleMode: string | null;
  // Cost-aware gate decision + its rationale (see decideContextPolicy).
  readonly contextPolicyAction: ContextPolicyAction;
  readonly policyReason: string | null;
  readonly expectedContextValue: ExpectedLevel | null;
  readonly expectedOverheadRisk: ExpectedLevel | null;
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
  // --show-vtrace-index-log drops --quiet so the index command prints its log;
  // absent the flag, the configured index args (which include --quiet) stand.
  const indexArgs = splitArgs(config.vtraceIndexArgs).filter(
    (arg) => !(config.showVtraceIndexLog && arg === "--quiet"),
  );
  return { command, args: [...base, "index", workspace, ...indexArgs] };
}

export function buildVtraceQueryCommand(
  config: CliConfig,
  workspace: string,
  query: string,
  mode?: CapsuleModeT,
): { command: string; args: string[] } {
  const [command, ...base] = splitArgs(config.vtraceCommand);
  if (command === undefined) throw new Error("--vtrace-command is empty; cannot build the vtrace query command.");
  // When a mode is chosen, request the compact JSON capsule (`--mode <m> --json`)
  // so retrieved context — not a copy of the issue — is what gets injected.
  const modeArgs = mode === undefined ? [] : ["--mode", mode, "--json"];
  return {
    command,
    args: [...base, "capsule", workspace, query, ...modeArgs, ...splitArgs(config.vtraceQueryArgs)],
  };
}

// The capsule `--json` output is `{ diagnostics, context }`; older raw output is
// plain text. Extract the injectable context from either, tolerating non-JSON.
export function extractCapsuleContext(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { context?: unknown };
    return typeof parsed.context === "string" ? parsed.context.trim() : trimmed;
  } catch {
    return trimmed;
  }
}

// The vtrace POLICY a capsule query expressed for one instance:
//  - inject: real retrieved context was produced → inject it (the treatment).
//  - skip:   vtrace deliberately recovered no high-confidence target → a VALID
//            no-context policy decision (small/local task), not an error.
//  - error:  empty/unusable output that is NOT an intentional skip → fail fast.
export type VtracePolicyAction = "inject" | "skip" | "error";

export interface CapsuleClassification {
  readonly policyAction: VtracePolicyAction;
  readonly contextInjected: boolean;
  readonly context: string;
  readonly skipReason: string | null;
  readonly recommendedMode: string | null;
  readonly actualCapsuleMode: string | null;
  readonly pivotCount: number | null;
  readonly supportCount: number | null;
  // How hard the agent should search before trusting the capsule (Requirement 5),
  // captured verbatim from the capsule diagnostics. null when not reported.
  readonly searchBudget: string | null;
  readonly searchBudgetReason: string | null;
  /** Set only when policyAction === "error" (genuinely unusable output). */
  readonly error: string | null;
}

// Classify a capsule `--json` (or raw) query output into a vtrace policy action.
// A capsule SKIP is recorded honestly as a valid policy, never thrown as fatal:
// it is detected from empty context paired with skip diagnostics — an explicit
// `recommended_mode`/`actual_mode` of `skip`, or `pivot_count === 0` accompanied
// by a retrieval reason. Empty context WITHOUT any of those signals is a real
// error (e.g. a broken index) and still fails fast.
export function classifyCapsuleOutput(stdout: string): CapsuleClassification {
  const trimmed = stdout.trim();

  // Non-JSON (legacy raw text): context iff non-empty, else an error.
  if (!trimmed.startsWith("{")) {
    return trimmed.length > 0
      ? injectClassification(trimmed, null, null, null, null)
      : errorClassification("vtrace query returned empty context.");
  }

  let parsed: { context?: unknown; diagnostics?: Record<string, unknown> };
  try {
    parsed = JSON.parse(trimmed) as typeof parsed;
  } catch {
    // Malformed JSON we cannot reason about: treat as injectable raw text if any.
    return trimmed.length > 0
      ? injectClassification(trimmed, null, null, null, null)
      : errorClassification("vtrace query returned empty context.");
  }

  const diagnostics = isRecord(parsed.diagnostics) ? parsed.diagnostics : {};
  const context = typeof parsed.context === "string" ? parsed.context.trim() : "";
  const recommendedMode = isString(diagnostics.recommended_mode) ? diagnostics.recommended_mode : null;
  const actualMode = isString(diagnostics.actual_mode) ? diagnostics.actual_mode : null;
  const pivotCount = isNumber(diagnostics.pivot_count) ? diagnostics.pivot_count : null;
  const supportCount = isNumber(diagnostics.support_count) ? diagnostics.support_count : null;
  const reason = isString(diagnostics.retrieval_reason) ? diagnostics.retrieval_reason : null;
  const searchBudget = isString(diagnostics.search_budget) ? diagnostics.search_budget : null;
  const searchBudgetReason = isString(diagnostics.search_budget_reason) ? diagnostics.search_budget_reason : null;

  // A `skip` mode is AUTHORITATIVE, even when the CLI emitted a human-facing
  // directive ("No high-confidence edit target recovered…") as the context body:
  // a skip injects no oriented context. Checked before the context test so the
  // skip directive is never mistaken for a real treatment.
  if (recommendedMode === "skip" || actualMode === "skip") {
    return skipClassification(reason, recommendedMode, actualMode, pivotCount, supportCount, searchBudget, searchBudgetReason);
  }

  // Real context present → inject it.
  if (context.length > 0) {
    return injectClassification(context, recommendedMode, actualMode, pivotCount, supportCount, searchBudget, searchBudgetReason);
  }

  // Empty context with no skip mode: a deliberate skip iff pivot_count 0 + reason.
  if (pivotCount === 0 && reason !== null) {
    return skipClassification(reason, recommendedMode, actualMode, pivotCount, supportCount, searchBudget, searchBudgetReason);
  }

  // Empty context with no skip signal: a genuine failure — fail fast.
  return errorClassification("vtrace query returned empty context.");
}

function skipClassification(
  reason: string | null,
  recommendedMode: string | null,
  actualMode: string | null,
  pivotCount: number | null,
  supportCount: number | null,
  searchBudget: string | null = "high",
  searchBudgetReason: string | null = null,
): CapsuleClassification {
  return {
    policyAction: "skip",
    contextInjected: false,
    context: "",
    skipReason: reason ?? "no high-confidence actionable target recovered",
    recommendedMode,
    actualCapsuleMode: actualMode ?? "skip",
    pivotCount: pivotCount ?? 0,
    supportCount: supportCount ?? 0,
    searchBudget,
    searchBudgetReason,
    error: null,
  };
}

function injectClassification(
  context: string,
  recommendedMode: string | null,
  actualMode: string | null,
  pivotCount: number | null,
  supportCount: number | null,
  searchBudget: string | null = null,
  searchBudgetReason: string | null = null,
): CapsuleClassification {
  return {
    policyAction: "inject",
    contextInjected: true,
    context,
    skipReason: null,
    recommendedMode,
    actualCapsuleMode: actualMode,
    pivotCount,
    supportCount,
    searchBudget,
    searchBudgetReason,
    error: null,
  };
}

function errorClassification(message: string): CapsuleClassification {
  return {
    policyAction: "error",
    contextInjected: false,
    context: "",
    skipReason: null,
    recommendedMode: null,
    actualCapsuleMode: null,
    pivotCount: null,
    supportCount: null,
    searchBudget: null,
    searchBudgetReason: null,
    error: message,
  };
}

// Build the vtrace query string from an instance. Rather than dumping the whole
// problem statement, shape it into a compact, signal-first query (failing tests,
// explicit files/symbols, a short issue lead) via the shared shaping helper. The
// instance id is prepended so multi-instance context stays attributable.
export function buildInstanceQuery(instance: SweBenchInstance): string {
  const shaped = shapeSweQuery(instance, { maxQueryChars: MAX_VTRACE_QUERY_CHARS });
  const header = `instance: ${instance.instanceId}`;
  const query = shaped.query.length > 0 ? `${header}\n${shaped.query}` : header;
  return query.length > MAX_VTRACE_QUERY_CHARS ? query.slice(0, MAX_VTRACE_QUERY_CHARS) : query;
}

// Recommend a capsule mode for an instance from its shaped signals. Diagnostic
// first: navigation-heavy issues get `full`, small/local edits get `micro`.
export function recommendedCapsuleModeFor(instance: SweBenchInstance): RecommendedCapsuleModeT {
  const shaped = shapeSweQuery(instance);
  return recommendCapsuleMode(deriveModeSignals(instance, shaped)).recommendedMode;
}

// Map a recommendation onto a concrete capsule CLI mode. `skip` has no CLI
// equivalent, so it degrades to `micro` (the smallest real envelope).
export function capsuleModeForInstance(instance: SweBenchInstance): CapsuleModeT {
  const recommended = recommendedCapsuleModeFor(instance);
  return recommended === RecommendedCapsuleMode.Skip ? CapsuleMode.Micro : recommended;
}

// ---------------------------------------------------------------------------
// Cost-aware context-injection gate
// ---------------------------------------------------------------------------
//
// Stage 5C showed that vtrace helps large/navigation-heavy tasks but HURTS
// small/local tasks: even action-oriented micro context is net overhead when
// baseline Claude already solves the task cheaply. The gate below decides,
// BEFORE the agent prompt is modified, whether the expected value of injected
// context exceeds its overhead. When it does not, vtrace deliberately injects
// nothing (a valid no-context policy), instead of paying for context that does
// not earn its keep. This is product behaviour, not benchmark gaming.
export type ContextPolicyAction = "inject" | "no_context";
export type ExpectedLevel = "low" | "medium" | "high";

// Task-shape signals derived from the SWE instance (independent of what the
// capsule retrieved). These describe how "cheap/local" vs "navigation-heavy"
// the task looks before any context is produced.
export interface ContextPolicySignals {
  readonly failingTestCount: number;
  readonly problemStatementLength: number;
  readonly crossModule: boolean;
  readonly touchesComplexInternals: boolean;
  readonly likelyFileCount: number;
  readonly likelySymbolCount: number;
  readonly hasExplicitTargets: boolean;
  readonly recommendedMode: RecommendedCapsuleModeT;
  readonly targetConfidence: TargetConfidenceT;
}

// What the capsule actually retrieved — the evidence side of the trade-off. A
// strong pivot count is what turns a navigation-heavy task from "speculative"
// into "worth the overhead".
export interface CapsulePolicyDiagnostics {
  readonly capsuleAction: VtracePolicyAction;
  readonly hasContext: boolean;
  readonly pivotCount: number | null;
  readonly supportCount: number | null;
  readonly actualMode: string | null;
}

export interface ContextPolicyDecision {
  readonly action: ContextPolicyAction;
  readonly reason: string;
  readonly expectedContextValue: ExpectedLevel;
  readonly expectedOverheadRisk: ExpectedLevel;
}

// A short problem statement is one cheap/local signal (mirrors the capsule
// recommender's SHORT_ISSUE_CHARS threshold).
const SHORT_PROBLEM_CHARS = 600;

// Derive the gate's task-shape signals from an instance, reusing the same
// shaping + mode recommendation the capsule itself runs on, so the gate and the
// capsule never disagree about what the task looks like.
export function deriveContextPolicySignals(instance: SweBenchInstance): ContextPolicySignals {
  const shaped = shapeSweQuery(instance);
  const signals = deriveModeSignals(instance, shaped);
  const recommendation = recommendCapsuleMode(signals);
  return {
    failingTestCount: signals.failingTestCount,
    problemStatementLength: signals.problemStatementLength,
    crossModule: signals.crossModule,
    touchesComplexInternals: signals.touchesComplexInternals,
    likelyFileCount: signals.likelyFileCount,
    likelySymbolCount: signals.likelySymbolCount,
    hasExplicitTargets: signals.hasExplicitTargets,
    recommendedMode: recommendation.recommendedMode,
    targetConfidence: recommendation.targetConfidence,
  };
}

// The cost-aware injection gate. Returns `inject` only when the expected value
// of oriented context plausibly exceeds the overhead of injecting it.
//
//  - no_context when the capsule recovered nothing actionable (low value).
//  - no_context for cheap/local tasks (one failing test, short problem, no
//    cross-module signal, micro capsule, no high-confidence test→impl edge):
//    baseline solves these cheaply, so context is pure overhead.
//  - inject for navigation-heavy tasks, but CONSERVATIVELY — only when the
//    capsule produced real pivot evidence; weak evidence on a big task is not
//    worth the overhead.
//  - inject for moderate tasks that retrieved real context.
export function decideContextPolicy(
  signals: ContextPolicySignals,
  capsule: CapsulePolicyDiagnostics,
): ContextPolicyDecision {
  // 1. The capsule itself recovered no high-confidence target → nothing to inject.
  if (capsule.capsuleAction === "skip" || !capsule.hasContext) {
    return {
      action: "no_context",
      reason: "Capsule recovered no high-confidence target; nothing actionable to inject.",
      expectedContextValue: "low",
      expectedOverheadRisk: "low",
    };
  }

  const strongPivot = (capsule.pivotCount ?? 0) >= 1;
  const microCapsule =
    signals.recommendedMode === RecommendedCapsuleMode.Micro
    || signals.recommendedMode === RecommendedCapsuleMode.Skip;
  const navigationHeavy =
    signals.recommendedMode === RecommendedCapsuleMode.Full
    || signals.touchesComplexInternals
    || signals.crossModule
    || signals.likelyFileCount >= 2;
  // A high-confidence DIRECT test→implementation edge: the capsule pinned a
  // confident pivot ON A TASK THAT ACTUALLY SPANS IMPLEMENTATION STRUCTURE.
  // Crucially this is NOT the recommender's issue-text `targetConfidence` alone
  // (a short issue naming three symbols reads "high" but is still a local edit);
  // it requires the task to be navigation-heavy AND the capsule to back it with
  // a real pivot. Cheap/local micro tasks never have one.
  const highConfidenceDirectEdge =
    navigationHeavy && strongPivot && signals.targetConfidence === TargetConfidence.High;

  // 2. Cheap/local task: one failing test, short problem statement, low
  //    cross-module signal, the capsule would be micro, and there is no
  //    high-confidence direct test→implementation edge — so likely baseline
  //    search/edit cost is low and injected context is net overhead.
  const cheapLocal =
    signals.failingTestCount <= 1
    && signals.problemStatementLength < SHORT_PROBLEM_CHARS
    && !signals.crossModule
    && !signals.touchesComplexInternals
    && microCapsule
    && !highConfidenceDirectEdge;
  if (cheapLocal) {
    return {
      action: "no_context",
      reason:
        "Cheap/local task: one failing test, short problem statement, low cross-module signal, micro capsule, "
        + "and no high-confidence test-to-implementation edge — injected context is likely net overhead.",
      expectedContextValue: "low",
      expectedOverheadRisk: "high",
    };
  }

  // 3. Navigation-heavy task: inject only with strong pivot evidence; otherwise
  //    stay conservative (the Stage 5 11740 lesson).
  if (navigationHeavy) {
    return strongPivot
      ? {
          action: "inject",
          reason: "Navigation-heavy task with strong pivot evidence; oriented context is expected to pay off.",
          expectedContextValue: "high",
          expectedOverheadRisk: "low",
        }
      : {
          action: "no_context",
          reason:
            "Navigation-heavy task but capsule pivot evidence is weak; injecting risks overhead without payoff.",
          expectedContextValue: "low",
          expectedOverheadRisk: "medium",
        };
  }

  // 4. Moderate task that retrieved real context → worth a standard injection.
  return {
    action: "inject",
    reason: "Moderate task with retrieved context and no strong cheap/local signal; a standard capsule is worthwhile.",
    expectedContextValue: "medium",
    expectedOverheadRisk: "medium",
  };
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
  /** The capsule policy classification for this instance (null on a hard error). */
  readonly classification: CapsuleClassification | null;
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
    // NOTE: the full problem statement is intentionally NOT repeated here. The
    // agent already receives the issue text from the SWE-bench harness; dumping
    // it again is pure overhead (it inflated small/local tasks in Stage 5C).
    // vtrace injects retrieved context only.
    lines.push(
      "## Instance",
      "",
      `- instance_id: ${instance.instanceId}`,
      `- repo: ${instance.repo}`,
      `- base_commit: ${instance.baseCommit}`,
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

// Workspace/index-run metadata for the vtrace _run.meta.json (alongside the flat
// IndexedContextFields). `vtraceIndexCommand` is already carried by
// indexedContextMetaFields; these record the freshness/quiet policy and the
// observed index timing (started/finished/duration are null when the index was
// reused rather than re-run).
function indexRunMetaFields(result: IndexedContextResult): Record<string, unknown> {
  return {
    freshWorkspace: result.freshWorkspace,
    vtraceIndexQuiet: result.vtraceIndexQuiet,
    vtraceIndexStartedAt: result.vtraceIndexStartedAt,
    vtraceIndexFinishedAt: result.vtraceIndexFinishedAt,
    vtraceIndexDurationMs: result.vtraceIndexDurationMs,
  };
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
    vtracePolicyAction: result.policyAction,
    vtraceContextInjected: result.contextInjected,
    vtraceSkipReason: result.skipReason,
    vtracePivotCount: result.pivotCount,
    vtraceSupportCount: result.supportCount,
    vtraceContextPolicyAction: result.contextPolicyAction,
    vtracePolicyReason: result.policyReason,
    expectedContextValue: result.expectedContextValue,
    expectedOverheadRisk: result.expectedOverheadRisk,
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
  // Index-run metadata (last instance wins; smoke runs are single-instance). Null
  // started/finished/duration means the index was reused, not re-run.
  let indexQuiet = false;
  let indexStartedAt: string | null = null;
  let indexFinishedAt: string | null = null;
  let indexDurationMs: number | null = null;

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
    let classification: CapsuleClassification | null = null;
    try {
      await ensureWorkspaceCheckout(instance, workspace, runProc, config.reuseWorkspace);
      const indexSpec = buildVtraceIndexCommand(config, workspace);
      indexCommand = renderCommand(indexSpec);
      indexQuiet = indexSpec.args.includes("--quiet");
      // Reuse the index only when keeping the workspace (or the legacy skip flag)
      // AND a real index.sqlite is present — never a half-built `.vtrace` dir. A
      // fresh run cleaned `.vtrace` away above, so it always re-indexes.
      const indexPresent = await pathExists(path.join(workspace, ".vtrace", "index.sqlite"));
      const reuseIndex = (config.reuseWorkspace || config.skipVtraceIndexIfPresent) && indexPresent;
      if (!reuseIndex) {
        const startMs = Date.now();
        indexStartedAt = new Date(startMs).toISOString();
        const indexResult = await runProc(indexSpec.command, indexSpec.args);
        const endMs = Date.now();
        indexFinishedAt = new Date(endMs).toISOString();
        indexDurationMs = endMs - startMs;
        if (indexResult.exitCode !== 0) {
          throw new Error(`vtrace index failed (exit ${indexResult.exitCode}): ${indexResult.stderr.trim() || "(no stderr)"}`);
        }
      }
      const mode = capsuleModeForInstance(instance);
      const querySpec = buildVtraceQueryCommand(config, workspace, buildInstanceQuery(instance), mode);
      queryCommand = renderCommand(querySpec);
      const queryResult = await runProc(querySpec.command, querySpec.args);
      if (queryResult.exitCode !== 0) {
        throw new Error(`vtrace query failed (exit ${queryResult.exitCode}): ${queryResult.stderr.trim() || "(no stderr)"}`);
      }
      // Classify the policy. A SKIP (no high-confidence target) is recorded as a
      // valid policy decision, not an error — only a genuinely unusable output
      // (empty WITHOUT skip diagnostics) throws and fails the section.
      classification = classifyCapsuleOutput(queryResult.stdout);
      if (classification.policyAction === "error") {
        throw new Error(classification.error ?? "vtrace query returned empty context.");
      }
      rawContext = classification.context;
    } catch (error) {
      sectionError = error instanceof Error ? error.message : String(error);
      errors.push(`${instance.instanceId}: ${sectionError}`);
      classification = null;
    }
    sections.push({ instance, rawContext, error: sectionError, classification });
  }

  // Apply the cost-aware injection gate per section. Even REAL retrieved context
  // is dropped when the gate decides `no_context` (cheap/local task), so the
  // benchmark spends nothing on context that would be net overhead. A section
  // with a hard error has no classification and is left untouched (its error
  // still drives the abort/skip aggregation below).
  const decisions = new Map<string, ContextPolicyDecision>();
  const gatedSections: VtraceContextSection[] = sections.map((section) => {
    if (section.classification === null) return section;
    const decision = decideContextPolicy(deriveContextPolicySignals(section.instance), {
      capsuleAction: section.classification.policyAction,
      hasContext: section.rawContext.trim().length > 0,
      pivotCount: section.classification.pivotCount,
      supportCount: section.classification.supportCount,
      actualMode: section.classification.actualCapsuleMode,
    });
    decisions.set(section.instance.instanceId, decision);
    // Drop the context body when the gate declines to inject it.
    return decision.action === "inject" ? section : { ...section, rawContext: "" };
  });

  const assembled = buildVtraceContextMarkdown(gatedSections, {
    maxChars: config.vtraceContextMaxChars,
    maxItems: config.vtraceContextMaxItems,
  });
  await writeFile(contextFile, assembled.markdown);

  const indexedContext = gatedSections.some((section) => section.error === null && section.rawContext.trim().length > 0);
  const hardErrors = sections.filter((section) => section.error !== null);
  const noContextSections = sections.filter(
    (section) => section.error === null && decisions.get(section.instance.instanceId)?.action === "no_context",
  );
  // The run is a valid no-context policy only when nothing was injected, at
  // least one instance was gated to no_context, and there was no hard error to
  // fail on. A no-context decision is recorded via the existing `skip` action so
  // the run-status / treatment-validity machinery treats it as a valid policy.
  const noContext = !indexedContext && noContextSections.length > 0 && hardErrors.length === 0;
  const policyAction: VtracePolicyAction = noContext ? "skip" : "inject";
  const contextPolicyAction: ContextPolicyAction = noContext ? "no_context" : "inject";
  const pivotCount = sumClassification(sections, (c) => c.pivotCount);
  const supportCount = sumClassification(sections, (c) => c.supportCount);
  // The section/decision that explains the run-level policy: the first
  // no_context section when we declined, else the first inject decision.
  const repSection = noContext ? (noContextSections[0] ?? null) : null;
  const repDecision = noContext
    ? (repSection ? decisions.get(repSection.instance.instanceId) ?? null : null)
    : [...decisions.values()].find((d) => d.action === "inject") ?? null;
  // Recorded as the legacy `skip` mode for a no-context policy (the gate's
  // `no_context` decision is carried separately by contextPolicyAction).
  const actualCapsuleMode = noContext
    ? "skip"
    : (gatedSections.find((s) => s.rawContext.trim().length > 0)
        ? (sections.find((s) => s.classification?.actualCapsuleMode != null)?.classification?.actualCapsuleMode ?? null)
        : null);

  return {
    indexedContext,
    indexCommand,
    queryCommand,
    workspacePath,
    freshWorkspace: !config.reuseWorkspace,
    vtraceIndexQuiet: indexQuiet,
    vtraceIndexStartedAt: indexStartedAt,
    vtraceIndexFinishedAt: indexFinishedAt,
    vtraceIndexDurationMs: indexDurationMs,
    contextFile,
    contextChars: assembled.chars,
    contextItems: assembled.items,
    contextTruncated: assembled.truncated,
    contextError: errors.length > 0 ? errors.join("; ") : null,
    policyAction,
    contextInjected: indexedContext,
    // Capsule-level reason when a capsule skip drove the no-context decision;
    // otherwise the gate's own rationale (cheap/local / weak-pivot).
    skipReason: noContext
      ? (repSection?.classification?.skipReason ?? repDecision?.reason ?? "no high-confidence actionable target recovered")
      : null,
    pivotCount,
    supportCount,
    actualCapsuleMode,
    contextPolicyAction,
    policyReason: repDecision?.reason ?? null,
    expectedContextValue: repDecision?.expectedContextValue ?? null,
    expectedOverheadRisk: repDecision?.expectedOverheadRisk ?? null,
  };
}

// Sum a per-section classification number (pivot/support counts), returning null
// only when no section reported the value at all.
function sumClassification(
  sections: readonly VtraceContextSection[],
  pick: (c: CapsuleClassification) => number | null,
): number | null {
  let total = 0;
  let seen = false;
  for (const section of sections) {
    const value = section.classification === null ? null : pick(section.classification);
    if (value !== null) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : null;
}

// Reproduce the instance checkout (Approach B): clone if absent, then checkout
// the base commit. Mirrors vexp-swe-bench's shallow-clone + fetch fallback.
//
// Workspace freshness: a re-run of an existing labeled workspace is, by default,
// scrubbed back to a clean base-commit tree (`git clean -fdx` removes untracked
// state — a stale `.vtrace` index, files a prior patch added — and the forced
// checkout resets tracked files) before it is re-indexed. `reuseWorkspace` opts
// out: an existing checkout is left exactly as-is (no clean, no checkout).
async function ensureWorkspaceCheckout(
  instance: SweBenchInstance,
  workspace: string,
  runProc: ProcessRunner,
  reuseWorkspace: boolean,
): Promise<void> {
  const alreadyCloned = await pathExists(path.join(workspace, ".git"));
  if (!alreadyCloned) {
    await mkdir(path.dirname(workspace), { recursive: true });
    const clone = buildCloneCommand(instance.repo, workspace);
    const cloneResult = await runProc(clone.command, clone.args);
    if (cloneResult.exitCode !== 0) {
      throw new Error(`git clone of ${instance.repo} failed (exit ${cloneResult.exitCode}): ${cloneResult.stderr.trim() || "(no stderr)"}`);
    }
  } else if (reuseWorkspace) {
    // --reuse-workspace: trust the existing checkout + index; touch nothing.
    return;
  } else {
    // Fresh (default): scrub all untracked state so the re-checkout + re-index
    // starts from a clean tree at the base commit (no stale index, no leftovers).
    const clean = await runProc("git", ["-C", workspace, "clean", "-fdx"]);
    if (clean.exitCode !== 0) {
      throw new Error(`git clean of ${workspace} failed (exit ${clean.exitCode}): ${clean.stderr.trim() || "(no stderr)"}`);
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

interface RunStatusBlockInput {
  readonly runStatus: RunStatus;
  readonly label: string | null;
  readonly instance: string | null;
  readonly condition: Stage5Condition;
  readonly patch: Unknownable<boolean> | null;
  readonly tokens: Unknownable<number> | null;
  readonly cost: Unknownable<number> | null;
  readonly treatmentValid: unknown;
  readonly shouldRerun: boolean;
  readonly reason: string;
}

// Render the per-instance run-status block printed after each run-protocol /
// condition run (Requirement 4). Infra failures additionally print an explicit
// rerun action line so the operator knows the label needs re-running.
export function formatRunStatusBlock(input: RunStatusBlockInput): string {
  const yesNo = (value: Unknownable<boolean> | null): string =>
    value === true ? "yes" : value === false ? "no" : "unknown";
  const numText = (value: Unknownable<number> | null): string =>
    typeof value === "number" ? String(value) : "unknown";
  const costText = typeof input.cost === "number" ? `$${input.cost}` : "unknown";
  const treatmentText =
    input.treatmentValid === null || input.treatmentValid === undefined ? "n/a" : String(input.treatmentValid);
  const lines = [
    `Stage5 run status: ${input.runStatus}`,
    `Label: ${input.label ?? "(none)"}`,
    `Instance: ${input.instance ?? "(none)"}`,
    `Condition: ${input.condition}`,
    `Patch: ${yesNo(input.patch)}`,
    `Tokens: ${numText(input.tokens)}`,
    `Cost: ${costText}`,
    `Treatment valid: ${treatmentText}`,
    `Rerun recommended: ${input.shouldRerun ? "yes" : "no"}`,
    `Reason: ${input.reason}`,
  ];
  if (input.runStatus === "infra_failed") lines.push("Action: rerun this label.");
  return lines.join("\n");
}

// A human-readable reason for a given run status, used in the terminal summary.
function runStatusReason(
  status: RunStatus,
  row: Stage5Row,
  infra: InfraFailure | null,
  skipReason: string | null,
): string {
  switch (status) {
    case "infra_failed": {
      const detail =
        infra !== null && infra.infraErrorStatus !== null
          ? `Claude API ${infra.infraErrorStatus} ${infra.infraErrorKind === "api_overloaded" ? "overloaded" : infra.infraErrorKind}`
          : "Claude/API infrastructure error";
      return `${detail}; no tokens spent and no patch generated.`;
    }
    case "policy_skip":
      return skipReason ?? "vtrace selected no-context policy (valid skip).";
    case "agent_failed":
      return row.error ?? "agent run failed without producing a patch.";
    case "completed_patch":
      return "Run completed and produced a model patch.";
    case "completed_no_patch":
      return "Run completed but produced no patch.";
    case "missing_condition_result":
      return "No result row was written.";
  }
}

// Build the one-block-per-instance run-status summary for a just-completed
// condition run. When no result row was produced it reports
// missing_condition_result with the artifact-aware reason (Requirement 4).
async function formatRunStatusSummary(
  config: CliConfig,
  condition: Stage5Condition,
  dir: string,
  vtraceMeta: Record<string, unknown>,
): Promise<string> {
  const policyAction = isVtracePolicyAction(vtraceMeta.vtracePolicyAction) ? vtraceMeta.vtracePolicyAction : null;
  const treatmentValid = "vtraceTreatmentValid" in vtraceMeta ? vtraceMeta.vtraceTreatmentValid : null;
  const skipReason = isString(vtraceMeta.vtraceSkipReason) ? vtraceMeta.vtraceSkipReason : null;
  const resultsFile = await findCanonicalResultsFile(dir);
  const records = resultsFile === null ? [] : parseJsonlRecords(await readFile(resultsFile, "utf8").catch(() => ""));

  if (records.length === 0) {
    const diagnosis = await diagnoseConditionEvaluability(dir);
    return formatRunStatusBlock({
      runStatus: "missing_condition_result",
      label: config.runLabel,
      instance: null,
      condition,
      patch: null,
      tokens: null,
      cost: null,
      treatmentValid,
      shouldRerun: true,
      reason: diagnosis.message,
    });
  }

  const blocks: string[] = [];
  for (const record of records) {
    const row = extractRow(record, condition, resultsFile ?? "(none)");
    if (row === null) continue;
    const infra = classifyInfraFailure(record);
    const { runStatus, shouldRerun } = deriveRunStatus({
      infra,
      error: row.error,
      patchAvailable: row.patchAvailable,
      policyAction,
    });
    blocks.push(
      formatRunStatusBlock({
        runStatus,
        label: config.runLabel,
        instance: row.instanceId,
        condition,
        patch: row.patchAvailable,
        tokens: row.totalTokens,
        cost: row.costUsd,
        treatmentValid,
        shouldRerun,
        reason: runStatusReason(runStatus, row, infra, skipReason),
      }),
    );
  }
  return blocks.join("\n\n");
}

async function runCondition(
  config: CliConfig,
  condition: Stage5Condition,
  deps: RunDeps,
  extraVtraceMeta: Record<string, unknown> = {},
  injectContext = true,
): Promise<void> {
  if (config.vexpSweBenchDir === null) throw new Error(`--mode run-${condition} requires --vexp-swe-bench-dir.`);
  const cliPath = path.join(config.vexpSweBenchDir, config.cliEntry);
  if (!(await pathExists(cliPath))) {
    throw new Error(`vexp-swe-bench CLI not found at ${cliPath}. Run ./setup.sh in the external checkout first.`);
  }
  const instances = await resolveInstances(config);
  if (instances.length === 0) throw new Error(`--mode run-${condition} requires instances (via --instances or smoke_instances.json).`);

  // The vexp condition is the only one that enables vexp, so re-assert the gate
  // here as a defense-in-depth check even though runVexp already asserted it.
  if (condition === "vexp") assertVexpAllowed(config);

  const dir = rawConditionDir(config.out, condition, config.runLabel);
  await mkdir(dir, { recursive: true });
  const spec =
    condition === "baseline"
      ? buildBaselineCommand(config, instances)
      : condition === "vexp"
        ? buildVexpCommand(config, instances)
        : buildVtraceCommand(config, instances, injectContext);
  const env = condition === "vtrace" ? (spec as { env: Record<string, string> }).env : {};
  const startedMs = Date.now();
  const result = await (deps.runProcess ?? runProcess)(spec.command, spec.args, {
    cwd: spec.cwd ?? undefined,
    env,
  });
  // For the vtrace condition, record the instruction-file state and the runtime
  // injection status parsed from this run's stderr, so the raw meta is itself
  // sufficient evidence of whether the treatment actually applied. A SKIP policy
  // run injects nothing on purpose, so its validity does not require an observed
  // injection (a no-context policy is a valid treatment).
  const indexedFlag =
    typeof extraVtraceMeta.vtraceIndexedContext === "boolean" ? extraVtraceMeta.vtraceIndexedContext : null;
  const policyAction = isVtracePolicyAction(extraVtraceMeta.vtracePolicyAction)
    ? extraVtraceMeta.vtracePolicyAction
    : null;
  const vtraceMeta =
    condition === "vtrace"
      ? { ...(await vtraceRunMetaFields(config, result.stderr, indexedFlag, policyAction)), ...extraVtraceMeta }
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
  // Always print the run-status summary BEFORE the exit-code check so an infra
  // failure (which may still exit 0) or a non-zero exit both get classified and
  // explained, not just swallowed by the thrown error (Requirement 4).
  process.stdout.write(`${await formatRunStatusSummary(config, condition, dir, vtraceMeta)}\n`);
  if (result.exitCode !== 0) {
    throw new Error(`run-${condition} exited ${result.exitCode}: ${result.stderr.trim() || "(no stderr)"}`);
  }
}

export async function runIngest(config: CliConfig, deps: RunDeps = {}): Promise<NormalizedArtifact> {
  void deps;
  await ensureOutputTree(config.out);
  const rows: Stage5Row[] = [];
  for (const condition of STAGE5_CONDITIONS) {
    rows.push(...(await parseConditionDir(rawConditionDir(config.out, condition, config.runLabel), condition)));
  }
  const merged = mergeRows(rows);
  const evidence = await collectRunEvidence(config.out, config.runLabel);
  const evaluations = await collectEvaluationEvidence(config.out, config.runLabel);
  const stamped = stampEvaluationRows(stampVtraceRows(merged, evidence), evaluations);
  const withDiagnostics = await stampCapsuleDiagnostics(stamped, config);
  const missingResults = await detectMissingResults(config.out, config.runLabel, withDiagnostics);
  const artifact = buildArtifact(withDiagnostics, evidence, evaluations, missingResults);
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
          // Stage 5 vtrace policy fields (skip support + cost-aware gate).
          vtracePolicyAction: evidence.vtracePolicyAction,
          vtraceContextInjected: evidence.vtraceContextInjected,
          vtraceSkipReason: evidence.vtraceSkipReason,
          vtracePivotCount: evidence.vtracePivotCount,
          vtraceSupportCount: evidence.vtraceSupportCount,
          vtraceContextPolicyAction: evidence.vtraceContextPolicyAction,
          vtracePolicyReason: evidence.vtracePolicyReason,
          expectedContextValue: evidence.expectedContextValue,
          expectedOverheadRisk: evidence.expectedOverheadRisk,
        },
  );
}

// Enrich vtrace rows with capsule-sizing diagnostics: the recommended/actual
// mode + reason (from the instance), and whether the injected context mentioned
// the file/symbol the model actually edited. Best-effort — a missing dataset,
// instructions file, or patch leaves the affected fields null rather than
// failing ingest or fabricating a value.
export async function stampCapsuleDiagnostics(
  rows: readonly Stage5Row[],
  config: CliConfig,
): Promise<Stage5Row[]> {
  const recordsById = await loadDatasetById(config);

  const contextCache = new Map<string, string | null>();
  const out: Stage5Row[] = [];
  for (const row of rows) {
    // A valid skip policy is recorded directly on the row, so reflect the ACTUAL
    // capsule mode (`skip`) even when the dataset is unavailable for the richer
    // recommendation/containment diagnostics.
    const skipped = row.condition === "vtrace" && row.vtracePolicyAction === "skip";
    const record = row.condition === "vtrace" ? recordsById.get(row.instanceId) : undefined;
    if (record === undefined) {
      // A skip is always a high search budget (no target to trust).
      out.push(
        skipped
          ? { ...row, actualCapsuleMode: "skip", recommendedMode: row.recommendedMode ?? "skip", searchBudget: row.searchBudget ?? "high" }
          : row,
      );
      continue;
    }
    let instance: SweBenchInstance;
    try {
      instance = toSweBenchInstance(record);
    } catch {
      out.push(row);
      continue;
    }

    const shaped = shapeSweQuery(instance);
    const recommendation = recommendCapsuleMode(deriveModeSignals(instance, shaped));
    const context = await readInstanceContext(row, contextCache);
    const haveContext = context !== null && context.trim().length > 0;

    // When vtrace exercised its valid no-context policy, the ACTUAL capsule mode
    // is skip — not the micro envelope the recommendation degrades to.
    // The likely target the capsule directive would point at; also the pivot file
    // for agent-compliance (Requirement 6). A skip points at nothing.
    const pivotFile = skipped ? null : (shaped.likelyFiles[0] ?? null);
    out.push({
      ...row,
      recommendedMode: recommendation.recommendedMode,
      actualCapsuleMode: skipped ? "skip" : capsuleModeForInstance(instance),
      targetConfidence: recommendation.targetConfidence,
      retrievalReason: recommendation.retrievalReason,
      ...(skipped ? { searchBudget: row.searchBudget ?? "high" } : {}),
      pivotFile,
      topLikelyFile: shaped.likelyFiles[0] ?? null,
      topLikelySymbol: shaped.likelySymbols[0] ?? null,
      likelyTargetsCount: shaped.likelyFiles.length,
      containsFinalEditedFile:
        row.finalEditedFile !== null && haveContext ? contextMentionsFile(context, row.finalEditedFile) : null,
      containsFinalEditedSymbol:
        row.finalEditedSymbol !== null && haveContext
          ? contextMentionsSymbol(context, row.finalEditedSymbol)
          : null,
    });
  }
  return out;
}

// Best-effort dataset load keyed by instance id. Returns an empty map (not an
// error) when the dataset path is not configured, so diagnostics simply stay
// null on report-only runs that lack --vexp-swe-bench-dir / --swe-bench-data.
async function loadDatasetById(config: CliConfig): Promise<Map<string, Record<string, unknown>>> {
  const byId = new Map<string, Record<string, unknown>>();
  try {
    for (const record of await loadSweBenchData(sweBenchDataPath(config))) {
      const id = record.instance_id ?? record.instanceId;
      if (typeof id === "string") byId.set(id, record);
    }
  } catch {
    return byId;
  }
  return byId;
}

// Read the injected context for this row's instance from its instructions file
// (cached per file), extracting the per-instance section when present.
async function readInstanceContext(
  row: Stage5Row,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const file = row.vtraceInstructionsFile;
  if (file === null) return null;
  if (!cache.has(file)) {
    cache.set(file, await readFile(file, "utf8").catch(() => null));
  }
  const markdown = cache.get(file) ?? null;
  if (markdown === null) return null;
  return extractInstanceContextSection(markdown, row.instanceId) ?? markdown;
}

// Pull one instance's "## vtrace context" block out of the assembled
// _vtrace_instructions.md (see buildVtraceContextMarkdown). Returns null when the
// instance marker or context heading is absent.
export function extractInstanceContextSection(markdown: string, instanceId: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const markerAt = lines.findIndex((line) => line.trim() === `- instance_id: ${instanceId}`);
  if (markerAt === -1) return null;
  let start = -1;
  for (let i = markerAt; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "## vtrace context") {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i]?.startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
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
      : await collectRunEvidence(config.out, config.runLabel);
    const evaluations = Array.isArray(normalized.evaluations)
      ? ((normalized.evaluations as unknown[]).filter(isRecord) as unknown as EvaluationEvidence[])
      : await collectEvaluationEvidence(config.out, config.runLabel);
    const artifact = buildArtifact(stampVtraceRows(rows, evidence), evidence, evaluations);
    await writeReports(config, artifact);
    return artifact;
  }
  // No normalized intermediate yet: derive it from raw outputs.
  return runIngest(config, deps);
}

// Subdir under --out where the combined aggregate report is written, so it never
// clobbers the single-run flat outputs at the --out root.
export const AGGREGATE_SUBDIR = "aggregate";

// Stage 5C aggregate-runs: combine several isolated runs (each its own --run-label)
// into one normalized artifact + report. Each label is parsed and stamped exactly
// as `ingest` does for a single run, then their rows are concatenated so the
// shared, row-pure machinery (comparePairs, buildConditionSummaries, summarize)
// produces the combined paired comparison and per-condition aggregate for free.
//
// Duplicate-instance policy: if the same instance_id appears under more than one
// label (e.g. an accidental re-run), this errors out rather than silently mixing
// or double-counting — the caller must pick one canonical label per instance.
export async function runAggregateRuns(config: CliConfig, deps: RunDeps = {}): Promise<NormalizedArtifact> {
  void deps;
  const labels = config.runLabels;
  if (labels === null || labels.length === 0) {
    throw new Error("--mode aggregate-runs requires --run-labels label1,label2,...");
  }
  await ensureOutputTree(config.out);

  const allRows: Stage5Row[] = [];
  const allEvaluations: EvaluationEvidence[] = [];
  const perRunEvidence: Stage5RunEvidence[] = [];
  // instance_id -> the run-label that first contributed it; guards against the
  // same instance being counted under two labels.
  const instanceOwner = new Map<string, string>();

  for (const label of labels) {
    const rows: Stage5Row[] = [];
    for (const condition of STAGE5_CONDITIONS) {
      rows.push(...(await parseConditionDir(rawConditionDir(config.out, condition, label), condition)));
    }
    const evidence = await collectRunEvidence(config.out, label);
    const evaluations = await collectEvaluationEvidence(config.out, label);
    const stamped = await stampCapsuleDiagnostics(
      stampEvaluationRows(stampVtraceRows(mergeRows(rows), evidence), evaluations),
      config,
    );

    for (const row of stamped) {
      const prior = instanceOwner.get(row.instanceId);
      if (prior !== undefined && prior !== label) {
        throw new Error(
          `Duplicate instance ${row.instanceId} found in run-labels "${prior}" and "${label}". ` +
            "aggregate-runs refuses to combine repeated instances; pick one canonical run-label per instance.",
        );
      }
      instanceOwner.set(row.instanceId, label);
    }

    allRows.push(...stamped);
    allEvaluations.push(...evaluations);
    perRunEvidence.push(evidence);
  }

  const artifact = buildArtifact(allRows, combineRunEvidence(perRunEvidence), allEvaluations);
  const aggregateOut = path.join(config.out, AGGREGATE_SUBDIR);
  await ensureOutputTree(aggregateOut);
  await writeFile(path.join(aggregateOut, NORMALIZED_FILENAME), `${JSON.stringify(artifact, null, 2)}\n`);
  await writeReports({ ...config, out: aggregateOut }, artifact);
  return artifact;
}

// Reconcile per-run evidence into one summary for the aggregate report. A boolean
// or method fact is reported only when ALL runs agree (unanimous); otherwise it
// collapses to "mixed"/"unknown" rather than implying a single run's value holds
// for the whole set. Per-run-specific fields (file paths, byte/item counts) are
// not aggregatable, so they are nulled — the authoritative per-instance treatment
// validity lives in the per-condition aggregate's valid_treatments/invalid_treatments.
export function combineRunEvidence(perRun: readonly Stage5RunEvidence[]): Stage5RunEvidence {
  if (perRun.length === 0) return emptyEvidence();
  const first = perRun[0]!;
  function unanimous<T>(pick: (e: Stage5RunEvidence) => T, fallback: T): T {
    const head = pick(first);
    return perRun.every((e) => pick(e) === head) ? head : fallback;
  }
  const firstError = (pick: (e: Stage5RunEvidence) => string | null): string | null =>
    perRun.map(pick).find((value) => value !== null) ?? null;
  return {
    vtraceMethod: unanimous((e) => e.vtraceMethod, "mixed"),
    vtracePatchInstalled: unanimous((e) => e.vtracePatchInstalled, "unknown"),
    vtraceInstructionsFile: null,
    vtraceInstructionsFileExists: perRun.every((e) => e.vtraceInstructionsFileExists),
    vtraceInstructionsFileSize: null,
    vtraceInjectionObserved: unanimous((e) => e.vtraceInjectionObserved, "unknown"),
    vtraceInjectionError: firstError((e) => e.vtraceInjectionError),
    vtraceTreatmentValid: unanimous((e) => e.vtraceTreatmentValid, "unknown"),
    vtraceIndexedContext: unanimous((e) => e.vtraceIndexedContext, null),
    vtraceIndexCommand: null,
    vtraceQueryCommand: null,
    vtraceWorkspacePath: null,
    vtraceContextFile: null,
    vtraceContextChars: null,
    vtraceContextItems: null,
    vtraceContextTruncated: null,
    vtraceContextError: firstError((e) => e.vtraceContextError),
    // Policy facts are per-instance, not aggregatable, so they collapse to null
    // here; the authoritative per-instance policy lives on each row.
    vtracePolicyAction: null,
    vtraceContextInjected: null,
    vtraceSkipReason: null,
    vtracePivotCount: null,
    vtraceSupportCount: null,
    vtraceContextPolicyAction: null,
    vtracePolicyReason: null,
    expectedContextValue: null,
    expectedOverheadRisk: null,
    notes: perRun.flatMap((e) => e.notes),
  };
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

// Detect conditions that ran (have artifacts) but produced no usable result row,
// attaching the artifact-aware reason (Requirement 3/5). A condition with no
// artifacts at all is simply "not run" and is NOT reported as missing.
async function detectMissingResults(
  outDir: string,
  runLabel: string | null,
  rows: readonly Stage5Row[],
): Promise<MissingConditionResult[]> {
  const missing: MissingConditionResult[] = [];
  for (const condition of STAGE5_CONDITIONS) {
    if (rows.some((row) => row.condition === condition)) continue;
    const diagnosis = await diagnoseConditionEvaluability(rawConditionDir(outDir, condition, runLabel));
    if (!diagnosis.hasArtifacts) continue;
    missing.push({ condition, reason: diagnosis.message });
  }
  return missing;
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
    finalEditedFile: base.finalEditedFile ?? next.finalEditedFile,
    finalEditedSymbol: base.finalEditedSymbol ?? next.finalEditedSymbol,
    searchBudget: base.searchBudget ?? next.searchBudget,
    searchBudgetReason: base.searchBudgetReason ?? next.searchBudgetReason,
    pivotFile: base.pivotFile ?? next.pivotFile,
    firstReadFile: base.firstReadFile === "unknown" ? next.firstReadFile : base.firstReadFile,
    firstEditFile: base.firstEditFile === "unknown" ? next.firstEditFile : base.firstEditFile,
    didReadPivotBeforeSearch: fill(base.didReadPivotBeforeSearch ?? "unknown", next.didReadPivotBeforeSearch ?? "unknown"),
    didEditPivot: fill(base.didEditPivot ?? "unknown", next.didEditPivot ?? "unknown"),
    searchCallsBeforePivot: fill(base.searchCallsBeforePivot ?? "unknown", next.searchCallsBeforePivot ?? "unknown"),
    error: base.error ?? next.error,
    // Infra-failure detail is preserved from whichever fragment observed it;
    // runStatus/shouldRerun are re-derived in buildArtifact after stamping.
    infraErrorStatus: base.infraErrorStatus ?? next.infraErrorStatus,
    infraErrorKind: base.infraErrorKind ?? next.infraErrorKind,
    infraErrorMessage: base.infraErrorMessage ?? next.infraErrorMessage,
    parserKind: base.parserKind === "unknown" ? next.parserKind : base.parserKind,
    notes: [...new Set([...base.notes, ...next.notes])],
  };
  return { ...merged, parsedFieldCount: countParsedFields(merged) };
}

function buildArtifact(
  rows: readonly Stage5Row[],
  evidence: Stage5RunEvidence,
  evaluations: readonly EvaluationEvidence[] = [],
  missingResults: readonly MissingConditionResult[] = [],
): NormalizedArtifact {
  // Re-derive run status now that vtrace policy + patch fields are stamped, so a
  // valid skip reads as policy_skip rather than its provisional parse-time value.
  const statusedRows = rows.map(deriveRowRunStatus);
  const pairs = comparePairs(statusedRows);
  return {
    rows: [...statusedRows],
    pairs,
    summary: summarize(statusedRows, pairs, missingResults),
    evidence,
    conditionSummaries: buildConditionSummaries(statusedRows),
    evaluations: [...evaluations],
    missingResults: [...missingResults],
  };
}

// Recompute a row's runStatus/shouldRerun from its now-complete fields. The infra
// detail captured at parse time is authoritative; the vtrace policy action is the
// only thing that can change between parse and ingest.
function deriveRowRunStatus(row: Stage5Row): Stage5Row {
  const infra: InfraFailure | null =
    row.infraErrorKind !== null
      ? {
          infraErrorStatus: row.infraErrorStatus,
          infraErrorKind: row.infraErrorKind,
          infraErrorMessage: row.infraErrorMessage ?? "",
        }
      : null;
  const derived = deriveRunStatus({
    infra,
    error: row.error,
    patchAvailable: row.patchAvailable,
    policyAction: row.vtracePolicyAction,
  });
  return { ...row, runStatus: derived.runStatus, shouldRerun: derived.shouldRerun };
}

// Stage 5C per-condition aggregate. resolvedRate divides resolved by EVALUATED
// instances (resolved is a concrete true/false), so `unknown` patches — generated
// but never run through tests — pull neither toward pass nor fail.
export function buildConditionSummaries(rows: readonly Stage5Row[]): ConditionSummary[] {
  const summaries: ConditionSummary[] = [];
  for (const condition of STAGE5_CONDITIONS) {
    // Infra failures (e.g. API 529) are not real attempts; exclude them from
    // every aggregate so their zero cost/tokens never deflate the means and a
    // never-attempted instance never counts as resolved/unresolved (Requirement 6).
    const conditionRows = rows.filter(
      (row) => row.condition === condition && row.runStatus !== "infra_failed",
    );
    if (conditionRows.length === 0) continue;
    const evaluated = conditionRows.filter((row) => row.resolved !== "unknown");
    const resolved = conditionRows.filter((row) => row.resolved === true);
    const numbersOf = (pick: (row: Stage5Row) => Unknownable<number>): number[] =>
      conditionRows.map(pick).filter(isNumber);
    // Treatment validity is only meaningful for the injected conditions.
    const treatmentRows =
      condition === "baseline" ? [] : conditionRows.filter((row) => row.vtraceTreatmentValid !== null);
    summaries.push({
      condition,
      instances: new Set(conditionRows.map((row) => row.instanceId)).size,
      resolvedCount: resolved.length,
      evaluatedCount: evaluated.length,
      resolvedRate: evaluated.length === 0 ? null : resolved.length / evaluated.length,
      meanCost: mean(numbersOf((row) => row.costUsd)),
      meanDuration: mean(numbersOf((row) => row.durationMs)),
      meanTotalTokens: mean(numbersOf((row) => row.totalTokens)),
      meanTokensForResolved: mean(resolved.map((row) => row.totalTokens).filter(isNumber)),
      meanCostForResolved: mean(resolved.map((row) => row.costUsd).filter(isNumber)),
      validTreatments: treatmentRows.filter((row) => row.vtraceTreatmentValid === true).length,
      invalidTreatments: treatmentRows.filter((row) => row.vtraceTreatmentValid === false).length,
    });
  }
  return summaries;
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
    vtracePolicyAction: null,
    vtraceContextInjected: null,
    vtraceSkipReason: null,
    vtracePivotCount: null,
    vtraceSupportCount: null,
    vtraceContextPolicyAction: null,
    vtracePolicyReason: null,
    expectedContextValue: null,
    expectedOverheadRisk: null,
  };
}

function nullEvaluationFields(): EvaluationFields {
  return {
    evaluationRan: null,
    evaluationMethod: null,
    failToPassPassed: null,
    passToPassPassed: null,
    testStatus: null,
    dockerUsed: null,
    evaluationError: null,
  };
}

function nullCapsuleDiagnosticFields(): CapsuleDiagnosticFields {
  return {
    recommendedMode: null,
    actualCapsuleMode: null,
    targetConfidence: null,
    retrievalReason: null,
    searchBudget: null,
    searchBudgetReason: null,
    topLikelyFile: null,
    topLikelySymbol: null,
    likelyTargetsCount: null,
    finalEditedFile: null,
    finalEditedSymbol: null,
    containsFinalEditedFile: null,
    containsFinalEditedSymbol: null,
  };
}

// Agent-compliance fields default to "unknown" (or null for the pivot/file fields)
// — the honest state when the result record carries no ORDERED tool-call list.
function nullAgentComplianceFields(): AgentComplianceFields {
  return {
    pivotFile: null,
    firstReadFile: "unknown",
    firstEditFile: "unknown",
    didReadPivotBeforeSearch: "unknown",
    didEditPivot: "unknown",
    searchCallsBeforePivot: "unknown",
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
  policyAction?: VtracePolicyAction | "unknown" | null;
}): boolean | "unknown" {
  // A SKIP policy is a VALID treatment by construction: vtrace deliberately
  // injected no context, so its validity does NOT require an observed injection.
  if (opts.policyAction === "skip") return true;
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
  policyAction: VtracePolicyAction | "unknown" | null = null,
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
      policyAction,
    }),
  };
}

// Reconstruct run-level vtrace evidence from the captured raw artifacts: the per
// condition `_run.meta.json` (method + instructions-file path), the vtrace
// `_run.stderr.txt` (runtime injection log), and the patch manifest (install
// state). Everything here is observed, never inferred from the requested config.
async function collectRunEvidence(outDir: string, runLabel: string | null = null): Promise<Stage5RunEvidence> {
  const notes: string[] = [];

  // Resolve the vtrace method from RECORDED run metas only (non-null values),
  // and recover the instructions-file path the run actually used.
  const methods = new Set<VtraceMethod>();
  let instructionsFile: string | null = null;
  let vtraceRunRecorded = false;
  let indexed: IndexedContextFields = nullIndexedContextFields();
  for (const condition of ["baseline", "vtrace"] as const) {
    const meta = await readJsonIfExists(path.join(rawConditionDir(outDir, condition, runLabel), "_run.meta.json"));
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
  const stderrPath = path.join(rawConditionDir(outDir, "vtrace", runLabel), "_run.stderr.txt");
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
    policyAction: indexed.vtracePolicyAction,
  });
  if (indexed.vtracePolicyAction === "skip") {
    notes.push(
      "VTRACE selected no-context policy for this task. This is a valid policy decision, not an indexed-context "
      + "treatment. Token/cost comparison for this row measures the vtrace policy runner, not injected context.",
    );
  } else if (vtraceMethod === "local-patch" && vtraceTreatmentValid === false) {
    notes.push("Vtrace injection was skipped; this run is not a valid vtrace treatment.");
  } else if (vtraceMethod === "indexed-context" && vtraceTreatmentValid === false) {
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
  const policy = (value: unknown): VtracePolicyAction | "unknown" | null =>
    value === "inject" || value === "skip" || value === "error" || value === "unknown"
      ? (value as VtracePolicyAction | "unknown")
      : null;
  const contextPolicy = (value: unknown): ContextPolicyAction | "unknown" | null =>
    value === "inject" || value === "no_context" || value === "unknown"
      ? (value as ContextPolicyAction | "unknown")
      : null;
  const level = (value: unknown): ExpectedLevel | null =>
    value === "low" || value === "medium" || value === "high" ? (value as ExpectedLevel) : null;
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
    vtracePolicyAction: policy(meta.vtracePolicyAction),
    vtraceContextInjected: bool(meta.vtraceContextInjected),
    vtraceSkipReason: str(meta.vtraceSkipReason),
    vtracePivotCount: num(meta.vtracePivotCount),
    vtraceSupportCount: num(meta.vtraceSupportCount),
    vtraceContextPolicyAction: contextPolicy(meta.vtraceContextPolicyAction),
    vtracePolicyReason: str(meta.vtracePolicyReason),
    expectedContextValue: level(meta.expectedContextValue),
    expectedOverheadRisk: level(meta.expectedOverheadRisk),
  };
}

function summarize(
  rows: readonly Stage5Row[],
  pairs: readonly PairComparison[],
  missingResults: readonly MissingConditionResult[] = [],
): Stage5Summary {
  const bothResolved = pairs.filter((pair) => pair.outcome === "both_resolved");
  const vtraceRows = rows.filter((row) => row.condition === "vtrace");
  const countStatus = (status: RunStatus): number => rows.filter((row) => row.runStatus === status).length;
  const infraFailedCount = countStatus("infra_failed");
  const missingResultCount = missingResults.length;
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
    skipCount: vtraceRows.filter((row) => row.vtracePolicyAction === "skip").length,
    contextInjectedCount: vtraceRows.filter((row) => row.vtraceContextInjected === true).length,
    // A no-context row is a valid policy run that injected nothing — count it
    // SEPARATELY from injected-context rows so its efficiency deltas are never
    // advertised as a retrieval/injection win (Requirement 4). A row is
    // no_context when the gate said so OR the legacy skip mechanism recorded it.
    injectedContextCount: vtraceRows.filter((row) => row.vtraceContextInjected === true).length,
    noContextCount: vtraceRows.filter(
      (row) => row.vtraceContextPolicyAction === "no_context" || row.vtracePolicyAction === "skip",
    ).length,
    invalidTreatmentCount: vtraceRows.filter((row) => row.vtraceTreatmentValid === false).length,
    infraFailedCount,
    policySkipCount: countStatus("policy_skip"),
    agentFailedCount: countStatus("agent_failed"),
    completedPatchCount: countStatus("completed_patch"),
    completedNoPatchCount: countStatus("completed_no_patch"),
    missingResultCount,
    // A rerun is warranted for every infra failure and every missing result; a
    // completed/agent/skip row is a real attempt and is not re-run automatically.
    rerunRecommendedCount: infraFailedCount + missingResultCount,
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
        row.vtracePolicyAction ?? "",
        row.vtraceContextPolicyAction ?? "",
        row.vtracePolicyReason ?? "",
        row.expectedContextValue ?? "",
        row.expectedOverheadRisk ?? "",
        row.vtraceContextInjected === null ? "" : String(row.vtraceContextInjected),
        row.vtraceSkipReason ?? "",
        row.vtracePivotCount === null ? "" : String(row.vtracePivotCount),
        row.vtraceSupportCount === null ? "" : String(row.vtraceSupportCount),
        row.recommendedMode ?? "",
        row.actualCapsuleMode ?? "",
        row.targetConfidence ?? "",
        row.retrievalReason ?? "",
        row.searchBudget ?? "",
        row.searchBudgetReason ?? "",
        row.topLikelyFile ?? "",
        row.topLikelySymbol ?? "",
        row.likelyTargetsCount === null ? "" : String(row.likelyTargetsCount),
        row.finalEditedFile ?? "",
        row.finalEditedSymbol ?? "",
        row.containsFinalEditedFile === null ? "" : String(row.containsFinalEditedFile),
        row.containsFinalEditedSymbol === null ? "" : String(row.containsFinalEditedSymbol),
        row.pivotFile ?? "",
        row.firstReadFile === null ? "" : String(row.firstReadFile),
        row.firstEditFile === null ? "" : String(row.firstEditFile),
        row.didReadPivotBeforeSearch === null ? "" : String(row.didReadPivotBeforeSearch),
        row.didEditPivot === null ? "" : String(row.didEditPivot),
        row.searchCallsBeforePivot === null ? "" : String(row.searchCallsBeforePivot),
        row.vtraceContextChars === null ? "" : String(row.vtraceContextChars),
        row.vtraceContextItems === null ? "" : String(row.vtraceContextItems),
        row.runStatus ?? "",
        row.shouldRerun === null ? "" : String(row.shouldRerun),
        row.infraErrorStatus === null ? "" : String(row.infraErrorStatus),
        row.infraErrorKind ?? "",
        row.infraErrorMessage ?? "",
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
    `| Vtrace context injected | ${summary.contextInjectedCount} |`,
    `| Vtrace skip policy | ${summary.skipCount} |`,
    `| Injected-context rows | ${summary.injectedContextCount} |`,
    `| No-context rows | ${summary.noContextCount} |`,
    `| Invalid treatments | ${summary.invalidTreatmentCount} |`,
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
    ...renderConditionSummaryTable(artifact.conditionSummaries ?? []),
    ...renderEvaluationEvidence(artifact.evaluations ?? []),
    "## Result mode",
    "",
    describeResultMode(pairs, rows),
    "",
    "## Per-instance table (baseline vs vtrace)",
    "",
    renderPairTable(pairs),
    "",
    "## Per-instance comparison (baseline vs vtrace vs vexp)",
    "",
    renderTripleTable(pairs),
    "",
    "## Missing/unknown fields",
    "",
    renderUnknownFields(rows),
    "",
    ...renderRunStatusSection(artifact),
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
    `| vtrace_policy_action | ${evidence.vtracePolicyAction ?? "(n/a)"} |`,
    // The cost-aware gate's decision in its own vocabulary (`inject`|`no_context`);
    // a recorded `skip` policy is reported here as `no_context`.
    `| vtrace_context_policy_action | ${evidence.vtraceContextPolicyAction ?? (evidence.vtracePolicyAction === "skip" ? "no_context" : evidence.vtracePolicyAction) ?? "(n/a)"} |`,
    `| vtrace_policy_reason | ${evidence.vtracePolicyReason ?? evidence.vtraceSkipReason ?? "(none)"} |`,
    `| expected_context_value | ${evidence.expectedContextValue ?? "(n/a)"} |`,
    `| expected_overhead_risk | ${evidence.expectedOverheadRisk ?? "(n/a)"} |`,
    `| vtrace_context_injected | ${evidence.vtraceContextInjected === null ? "(n/a)" : String(evidence.vtraceContextInjected)} |`,
    `| vtrace_indexed_context | ${String(evidence.vtraceIndexedContext)} |`,
    `| vtrace_skip_reason | ${evidence.vtraceSkipReason ?? "(none)"} |`,
    `| pivot_count | ${evidence.vtracePivotCount ?? "(n/a)"} |`,
    `| support_count | ${evidence.vtraceSupportCount ?? "(n/a)"} |`,
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
  // A SKIP policy is a valid, intentional no-context decision — explain it
  // honestly rather than warning, so the row is not mistaken for a failed
  // treatment or read as injected-context performance.
  if (evidence.vtracePolicyAction === "skip") {
    lines.push(
      "> VTRACE selected no-context policy for this task. This is a valid policy decision, not an indexed-context "
        + "treatment. Token/cost comparison for this row measures the vtrace policy runner, not injected context.",
      "",
    );
    if (evidence.vtraceSkipReason !== null) {
      lines.push(`> Skip reason: \`${evidence.vtraceSkipReason}\``, "");
    }
  } else if (evidence.vtraceMethod === "indexed-context" && evidence.vtraceTreatmentValid !== true) {
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

// Stage 5C aggregate: one row per condition. resolved_rate is over EVALUATED
// instances only (the denominator is shown so `unknown` is never read as a fail).
function renderConditionSummaryTable(summaries: readonly ConditionSummary[]): string[] {
  if (summaries.length === 0) return [];
  const rate = (summary: ConditionSummary): string =>
    summary.resolvedRate === null ? "n/a" : `${(summary.resolvedRate * 100).toFixed(1)}% (${summary.resolvedCount}/${summary.evaluatedCount})`;
  const num = (value: number | null): string => (value === null ? "n/a" : value.toFixed(2));
  return [
    "## Per-condition aggregate",
    "",
    "| condition | instances | resolved | resolved_rate (of evaluated) | mean_cost | mean_duration_ms | mean_total_tokens | mean_tokens_resolved | mean_cost_resolved | valid_treatments | invalid_treatments |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summaries.map((summary) =>
      `| ${summary.condition} | ${summary.instances} | ${summary.resolvedCount} | ${rate(summary)} | ${num(summary.meanCost)} | ${num(summary.meanDuration)} | ${num(summary.meanTotalTokens)} | ${num(summary.meanTokensForResolved)} | ${num(summary.meanCostForResolved)} | ${summary.validTreatments} | ${summary.invalidTreatments} |`,
    ),
    "",
  ];
}

// Stage 5C evaluation evidence: proves HOW resolved was reached (or why it is
// still unknown) per condition. Only rendered once an evaluate run has recorded it.
function renderEvaluationEvidence(evaluations: readonly EvaluationEvidence[]): string[] {
  if (evaluations.length === 0) {
    return [
      "## Evaluation evidence",
      "",
      "No evaluation has been run yet. `resolved` is `unknown` (patch-generation only) until " +
        "`--mode evaluate` runs the external `node dist/cli.js evaluate` step. `--eval-mode docker` is the only " +
        "real pass/fail signal; `lightweight` does not run tests.",
      "",
    ];
  }
  return [
    "## Evaluation evidence",
    "",
    "| condition | evaluation_ran | method | docker_used | instances_evaluated | resolved | error |",
    "| --- | --- | --- | --- | ---: | ---: | --- |",
    ...evaluations.map((evidence) =>
      `| ${evidence.condition} | ${String(evidence.evaluationRan)} | ${evidence.evaluationMethod} | ${String(evidence.dockerUsed)} | ${evidence.instancesEvaluated} | ${evidence.resolvedCount} | ${evidence.evaluationError ?? "(none)"} |`,
    ),
    "",
    ...(evaluations.some((evidence) => evidence.evaluationMethod === "lightweight")
      ? ["> ⚠️ Lightweight evaluation does not run tests; it is NOT a pass/fail signal. Use `--eval-mode docker`.", ""]
      : []),
  ];
}

// Stage 5C three-condition comparison (requirement #7 paired table). vexp columns
// are dashes until the vexp protocol is run with --allow-vexp.
function renderTripleTable(pairs: readonly PairComparison[]): string {
  if (pairs.length === 0) return "No paired instances have been ingested yet.";
  return [
    "| instance | baseline_resolved | vtrace_resolved | vexp_resolved | baseline_tokens | vtrace_tokens | vexp_tokens | vtrace_token_reduction | vexp_token_reduction | patch_diff_available |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...pairs.map((pair) =>
      `| ${pair.instanceId} | ${cellOrDash(pair.baselineResolved)} | ${cellOrDash(pair.vtraceResolved)} | ${cellOrDash(pair.vexpResolved)} | ${cellOrDash(pair.baselineTotalTokens)} | ${cellOrDash(pair.vtraceTotalTokens)} | ${cellOrDash(pair.vexpTotalTokens)} | ${pair.vtraceTreatmentValid === false ? "invalid" : formatPct(pair.tokenReductionPct)} | ${formatPct(pair.vexpTokenReductionPct)} | ${String(pair.patchDiffAvailable)} |`,
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

// Run-status / failures-and-errors section (Requirement 5): aggregate counts plus
// a per-row table for everything that needs attention (infra/agent failures and
// policy skips) and the artifact-aware list of missing condition results.
function renderRunStatusSection(artifact: NormalizedArtifact): string[] {
  const { summary, rows } = artifact;
  const missingResults = artifact.missingResults ?? [];
  const lines: string[] = [
    "## Run status",
    "",
    "| Status | Count |",
    "| --- | ---: |",
    `| infra_failed | ${summary.infraFailedCount} |`,
    `| agent_failed | ${summary.agentFailedCount} |`,
    `| policy_skip | ${summary.policySkipCount} |`,
    `| completed_patch | ${summary.completedPatchCount} |`,
    `| completed_no_patch | ${summary.completedNoPatchCount} |`,
    `| missing_condition_result | ${summary.missingResultCount} |`,
    `| rerun_recommended | ${summary.rerunRecommendedCount} |`,
    "",
  ];
  if (summary.infraFailedCount > 0) {
    lines.push(
      "> ⚠️ Infrastructure failures detected (e.g. Claude API 529 overloaded). These rows are EXCLUDED from " +
        "resolved-rate, token/cost/duration reductions, and per-condition means — an API failure is not a vtrace " +
        "treatment or model-solving result. Rerun the affected labels.",
      "",
    );
  }
  const attention = rows.filter(
    (row) => row.runStatus === "infra_failed" || row.runStatus === "agent_failed" || row.runStatus === "policy_skip",
  );
  if (attention.length > 0) {
    lines.push(
      "| instance | condition | run_status | should_rerun | infra_error_status | infra_error_kind | vtrace_policy_action | vtrace_skip_reason |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...attention.map(
        (row) =>
          `| ${row.instanceId} | ${row.condition} | ${row.runStatus} | ${row.shouldRerun === null ? "unknown" : String(row.shouldRerun)} | ${row.infraErrorStatus ?? "(n/a)"} | ${row.infraErrorKind ?? "(n/a)"} | ${row.vtracePolicyAction ?? "(n/a)"} | ${row.vtraceSkipReason ?? "(none)"} |`,
      ),
      "",
    );
  }
  if (missingResults.length > 0) {
    lines.push(
      "Missing condition results (artifacts present but no usable result row):",
      "",
      ...missingResults.map((entry) => `- ${entry.condition}: ${entry.reason}`),
      "",
    );
  }
  if (attention.length === 0 && missingResults.length === 0 && summary.infraFailedCount === 0) {
    lines.push("All ingested rows completed without infra/agent failures or policy skips.", "");
  }
  return lines;
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
            "run-vexp",
            "run-protocol",
            "evaluate",
            "ingest",
            "report",
            "aggregate-runs",
            "install-vtrace-patch",
            "verify-vtrace-patch",
          ].includes(value)
        )
          throw new Error("Invalid --mode.");
        config.mode = value as Stage5Mode;
        break;
      }
      case "--protocol": {
        const value = requireValue(argv, ++index, arg);
        if (!["baseline", "vtrace-indexed", "vexp", "all"].includes(value)) throw new Error("Invalid --protocol.");
        config.protocol = value as Stage5Protocol;
        break;
      }
      case "--allow-vexp": config.allowVexp = true; break;
      case "--eval-mode": {
        const value = requireValue(argv, ++index, arg);
        if (!["docker", "lightweight"].includes(value)) throw new Error("Invalid --eval-mode.");
        config.evalMode = value as EvalMode;
        break;
      }
      case "--eval-dataset": config.evalDataset = requireValue(argv, ++index, arg); break;
      case "--eval-timeout": config.evalTimeout = requirePositiveInt(argv, ++index, arg); break;
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
      case "--reuse-workspace": config.reuseWorkspace = true; break;
      case "--show-vtrace-index-log": config.showVtraceIndexLog = true; break;
      case "--vtrace-context-max-chars": config.vtraceContextMaxChars = requirePositiveInt(argv, ++index, arg); break;
      case "--vtrace-context-max-items": config.vtraceContextMaxItems = requirePositiveInt(argv, ++index, arg); break;
      case "--swe-bench-data": config.sweBenchDataFile = requireValue(argv, ++index, arg); break;
      case "--run-label": config.runLabel = requireValue(argv, ++index, arg); break;
      case "--run-labels":
        config.runLabels = requireValue(argv, ++index, arg).split(",").map((value) => value.trim()).filter(Boolean);
        break;
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
    [
      "Usage: bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \\",
      "  --mode prepare|run-baseline|run-vtrace|run-vexp|run-protocol|evaluate|ingest|report|aggregate-runs|install-vtrace-patch|verify-vtrace-patch \\",
      "  --vexp-swe-bench-dir /path/to/vexp-swe-bench --instances id1,id2,id3 --out benchmarks/stage5_vexp_swe_bench_smoke/results",
      "",
      "Stage 5C protocol/evaluation flags:",
      "  --protocol baseline|vtrace-indexed|vexp|all   (with --mode run-protocol)",
      "  --allow-vexp                                  required before any vexp-enabled run",
      "  --eval-mode docker|lightweight                (with --mode evaluate; docker is the only real signal)",
      "  --eval-dataset <jsonl-or-hf-name>             full SWE-bench dataset for docker evaluation",
      "  --eval-timeout <seconds>                      per-instance evaluation timeout",
      "  --run-label <label>                           isolate runs under results/runs/<label>/",
      "  --reuse-workspace                             reuse an existing labeled workspace + index (default: recreate fresh)",
      "  --show-vtrace-index-log                       print the vtrace index log to the terminal (drops --quiet)",
      "  --run-labels a,b,c                            (with --mode aggregate-runs) combine those run-labels into results/aggregate/",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

async function main(config: CliConfig): Promise<void> {
  switch (config.mode) {
    case "prepare": await runPrepare(config); break;
    case "run-baseline": await runBaseline(config); break;
    case "run-vtrace": await runVtrace(config); break;
    case "run-vexp": await runVexp(config); break;
    case "run-protocol": await runProtocol(config); break;
    case "evaluate": {
      const evaluations = await runEvaluate(config);
      process.stdout.write(`${JSON.stringify(evaluations, null, 2)}\n`);
      break;
    }
    case "ingest": await runIngest(config); break;
    case "report": await runReport(config); break;
    case "aggregate-runs": {
      const artifact = await runAggregateRuns(config);
      process.stdout.write(`${JSON.stringify(artifact.summary, null, 2)}\n`);
      break;
    }
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
