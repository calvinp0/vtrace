// Stage 5 ISOLATED repaired-patch evaluator (milestone 5, follow-on). DOCKER OPT-IN.
//
// SCOPE: benchmark-only. Given a run that already carries gated-repair artifacts
// (`raw/vtrace/repair/_repaired_patch.diff`), this runner answers ONE question:
//
//   Does the REPAIRED patch resolve the SWE-bench instance under Docker, and how
//   does that compare to the ORIGINAL first patch?
//
// It does so WITHOUT touching any original artifact. It reads the original
// `swebench-*.jsonl` and the repair artifacts, builds a DERIVED evaluation JSONL
// under an isolated `raw/vtrace/repair_eval/` subdir whose only difference from the
// original is `modelPatch = contents of repair/_repaired_patch.diff` (with `resolved`
// reset so a stale value is never mistaken for a fresh result), and — ONLY when
// `--run-evaluation` is passed — invokes the existing external `evaluate` step on
// that DERIVED file. The original JSONL, first patch, repaired patch, raw agent
// output, and workspace are NEVER modified. It runs NO agent, NO live critic, NO
// repair, and changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD /
// PATCH_VERIFY / probe / critic / repair behavior.
//
// Without `--run-evaluation` no Docker runs: the derived input + metadata are still
// written (evaluationRan=false, resolved=null) and NO resolution is claimed.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { RESULTS_REL } from "./run_stage5_patch_probe_report";

export const DEFAULT_OUT_NAME = "stage5_repaired_patch_eval";
export const DEFAULT_NODE_COMMAND = "node";
export const DEFAULT_CLI_ENTRY = "dist/cli.js";
export const DEFAULT_EVAL_TIMEOUT = 1800;
// Default external checkout that ran the smoke (see _run.meta.json `cwd`).
export const DEFAULT_VEXP_SWE_BENCH_DIR = "/home/calvin/code/vexp-swe-bench";

// The isolated subdir all repaired-eval artifacts live under. NEVER the original dir.
export const REPAIR_EVAL_SUBDIR = "repair_eval";
export const DERIVED_JSONL_NAME = "_repaired_eval_input.jsonl";
export const EVAL_META_NAME = "_repaired_eval.meta.json";
export const EVAL_RESULT_NAME = "_repaired_eval.result.json";

// docker runs the real SWE-bench suite; lightweight only checks patch non-emptiness.
export type EvalMode = "docker" | "lightweight";

// ---------------------------------------------------------------------------
// Injectable process runner (tests pass a mock; Docker is NEVER called in unit tests)
// ---------------------------------------------------------------------------

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

export interface EvalDeps {
  readonly runProcess?: ProcessRunner;
}

async function defaultRunProcess(
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
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    proc.on("error", (error) =>
      resolve({ exitCode: 1, stdout: Buffer.concat(out).toString("utf8"), stderr: `${Buffer.concat(err).toString("utf8")}${error.message}` }),
    );
    proc.on("close", (code) =>
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }),
    );
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly runLabel: string | null;
  readonly outName: string;
  // Docker is OPT-IN. Default false: derived input + metadata are written but no
  // evaluator is invoked and no resolution is claimed.
  readonly runEvaluation: boolean;
  readonly evalMode: EvalMode;
  readonly evalTimeout: number;
  readonly evalDataset: string | null;
  readonly nodeCommand: string;
  readonly cliEntry: string;
  readonly vexpSweBenchDir: string;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let runLabel: string | null = null;
  let outName = DEFAULT_OUT_NAME;
  let runEvaluation = false;
  let evalMode: EvalMode = "docker";
  let evalTimeout = DEFAULT_EVAL_TIMEOUT;
  let evalDataset: string | null = null;
  let nodeCommand = DEFAULT_NODE_COMMAND;
  let cliEntry = DEFAULT_CLI_ENTRY;
  let vexpSweBenchDir = DEFAULT_VEXP_SWE_BENCH_DIR;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`Missing value for ${arg}.`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "--results":
        resultsDir = next();
        break;
      case "--run-label":
        runLabel = next();
        break;
      case "--out-name":
        outName = next();
        break;
      case "--run-evaluation":
        runEvaluation = true;
        break;
      case "--eval-mode": {
        const mode = next();
        if (mode !== "docker" && mode !== "lightweight") {
          throw new Error(`--eval-mode must be docker|lightweight (got ${mode}).`);
        }
        evalMode = mode;
        break;
      }
      case "--eval-timeout": {
        const raw = next();
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`--eval-timeout must be a positive integer (got ${raw}).`);
        evalTimeout = n;
        break;
      }
      case "--eval-dataset":
        evalDataset = next();
        break;
      case "--node-command":
        nodeCommand = next();
        break;
      case "--cli-entry":
        cliEntry = next();
        break;
      case "--vexp-swe-bench-dir":
        vexpSweBenchDir = next();
        break;
      case "--help":
      case "-h":
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { resultsDir, runLabel, outName, runEvaluation, evalMode, evalTimeout, evalDataset, nodeCommand, cliEntry, vexpSweBenchDir };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INSTANCE_ALIASES: readonly string[] = ["instance_id", "instanceId", "instance", "id"];
const RESOLVED_ALIASES: readonly string[] = ["resolved", "passed", "pass", "is_resolved", "success", "solved"];
const PATCH_ALIASES: readonly string[] = ["modelPatch", "patch", "model_patch", "prediction"];

function pick(record: Record<string, unknown>, aliases: readonly string[]): unknown {
  for (const key of aliases) {
    const v = record[key];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

// Parse "true"/false/1/0-ish resolution flags; null when genuinely absent/ambiguous.
function asResolvedFlag(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["true", "yes", "resolved", "pass", "passed", "1"].includes(text)) return true;
    if (["false", "no", "unresolved", "fail", "failed", "0"].includes(text)) return false;
  }
  return null;
}

export function parseJsonlRecords(content: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // tolerate malformed lines
    }
  }
  return records;
}

// resolved flag for one instance from a JSONL string, or null when absent/unknown.
export function parseResolvedForInstance(content: string, instanceId: string): boolean | null {
  for (const record of parseJsonlRecords(content)) {
    if (pick(record, INSTANCE_ALIASES) === instanceId) {
      return asResolvedFlag(pick(record, RESOLVED_ALIASES));
    }
  }
  return null;
}

// Build the DERIVED evaluation JSONL: every row keeps its fields except `modelPatch`
// is replaced with the repaired diff and `resolved` is reset to null (so a stale
// pre-repair verdict is never read as a fresh result). PURE — the input string is
// never mutated; a new string is returned.
export function buildDerivedJsonl(originalContent: string, repairedPatch: string): string {
  const lines: string[] = [];
  for (const line of originalContent.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // drop unparseable lines from the derived input
    }
    if (!isRecord(record)) continue;
    const derived: Record<string, unknown> = { ...record, modelPatch: repairedPatch, resolved: null };
    lines.push(JSON.stringify(derived));
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Resolution-conversion semantics
// ---------------------------------------------------------------------------
//
// `convertedUnresolvedToResolved` is the strict, conservative reading of "the
// repair actually mattered": it is TRUE only when we KNOW the first patch failed
// (firstResolved === false) AND we KNOW the repaired patch passed
// (repairedResolved === true). Any unknown (null) on either side — no first-patch
// eval, no Docker run — yields FALSE: we never IMPLY a conversion we did not
// observe. This keeps "artifact success" (a changed patch was produced) strictly
// separate from "evaluation success" (Docker says resolved) and from "conversion".
export function computeConvertedUnresolvedToResolved(
  firstResolved: boolean | null,
  repairedResolved: boolean | null,
): boolean {
  return firstResolved === false && repairedResolved === true;
}

// ---------------------------------------------------------------------------
// Read-only input loading (refuses without a repaired patch)
// ---------------------------------------------------------------------------

async function readText(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function readJson<T>(p: string): Promise<T | null> {
  const text = await readText(p);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// Newest canonical `swebench-*.jsonl` in a dir (the original run result log).
export async function findOriginalJsonl(vtraceDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(vtraceDir);
  } catch {
    return null;
  }
  const matches = entries.filter((name) => /^swebench-.*\.jsonl$/i.test(name)).sort();
  const newest = matches.at(-1);
  return newest === undefined ? null : path.join(vtraceDir, newest);
}

export interface RepairMetaDoc {
  readonly instanceId?: string;
  readonly runLabel?: string;
  readonly defectClass?: string;
  readonly result?: {
    readonly validPatch?: boolean;
    readonly changedPatch?: boolean;
    readonly failedOpen?: boolean;
    readonly repairCostUsd?: number | null;
  };
}

export interface RepairedEvalInputs {
  readonly runLabel: string;
  readonly instanceId: string;
  readonly vtraceDir: string;
  readonly repairEvalDir: string;
  readonly repairedPatch: string;
  readonly repairedPatchHash: string;
  readonly firstPatch: string | null;
  readonly firstPatchHash: string | null;
  readonly repairMeta: RepairMetaDoc | null;
  readonly originalJsonlPath: string;
  readonly originalJsonlContent: string;
}

// Load every input needed to evaluate the repaired patch. REFUSES (throws) when the
// repaired patch is missing/empty — there is nothing to evaluate. Read-only.
export async function loadRepairedEvalInputs(resultsDir: string, runLabel: string): Promise<RepairedEvalInputs> {
  const vtraceDir = path.join(resultsDir, "runs", runLabel, "raw", "vtrace");
  const repairDir = path.join(vtraceDir, "repair");
  const repairEvalDir = path.join(vtraceDir, REPAIR_EVAL_SUBDIR);

  const repairedPatch = await readText(path.join(repairDir, "_repaired_patch.diff"));
  if (repairedPatch === null || repairedPatch.trim().length === 0) {
    throw new Error(
      `No repaired patch to evaluate: ${path.join(repairDir, "_repaired_patch.diff")} is missing or empty. ` +
        `Run gated patch repair for ${runLabel} first.`,
    );
  }

  const firstPatch = await readText(path.join(repairDir, "_first_patch.diff"));
  const repairMeta = await readJson<RepairMetaDoc>(path.join(repairDir, "_patch_repair.meta.json"));

  const originalJsonlPath = await findOriginalJsonl(vtraceDir);
  if (originalJsonlPath === null) {
    throw new Error(`No original swebench-*.jsonl found in ${vtraceDir}; cannot build a derived evaluation input.`);
  }
  const originalJsonlContent = await readFile(originalJsonlPath, "utf8");

  const runMeta = await readJson<{ instances?: readonly string[] }>(path.join(vtraceDir, "_run.meta.json"));
  const jsonlInstance = parseJsonlRecords(originalJsonlContent)
    .map((r) => pick(r, INSTANCE_ALIASES))
    .find((v): v is string => typeof v === "string");
  const instanceId = repairMeta?.instanceId ?? jsonlInstance ?? runMeta?.instances?.[0] ?? "unknown";

  return {
    runLabel,
    instanceId,
    vtraceDir,
    repairEvalDir,
    repairedPatch,
    repairedPatchHash: sha256(repairedPatch),
    firstPatch,
    firstPatchHash: firstPatch === null ? null : sha256(firstPatch),
    repairMeta,
    originalJsonlPath,
    originalJsonlContent,
  };
}

// ---------------------------------------------------------------------------
// Existing first-patch evaluation evidence (read-only; never re-evaluated)
// ---------------------------------------------------------------------------

export interface FirstPatchEvalEvidence {
  // The `_eval.meta.json` the original `evaluate` run wrote, if present.
  readonly evalMetaPresent: boolean;
  readonly evaluationRan: boolean | null;
  readonly dockerUsed: boolean | "unknown" | null;
  readonly resolvedCount: number | null;
  readonly instancesEvaluated: number | null;
  // Per-instance resolution: prefer the original JSONL row; fall back to the
  // _eval.meta.json counts. null when the first patch was never evaluated.
  readonly firstPatchResolved: boolean | null;
  readonly source: "jsonl_row" | "eval_meta_counts" | "none";
}

interface EvalMetaDoc {
  readonly evaluationRan?: boolean;
  readonly dockerUsed?: boolean | "unknown";
  readonly resolvedCount?: number;
  readonly instancesEvaluated?: number;
}

export async function readFirstPatchEvalEvidence(
  vtraceDir: string,
  originalJsonlContent: string,
  instanceId: string,
): Promise<FirstPatchEvalEvidence> {
  const meta = await readJson<EvalMetaDoc>(path.join(vtraceDir, "_eval.meta.json"));
  const rowResolved = parseResolvedForInstance(originalJsonlContent, instanceId);

  let firstPatchResolved: boolean | null = null;
  let source: FirstPatchEvalEvidence["source"] = "none";
  if (rowResolved !== null) {
    firstPatchResolved = rowResolved;
    source = "jsonl_row";
  } else if (meta && meta.evaluationRan === true && (meta.instancesEvaluated ?? 0) > 0) {
    // Single-instance smoke: resolvedCount>0 ⇒ resolved.
    firstPatchResolved = (meta.resolvedCount ?? 0) > 0;
    source = "eval_meta_counts";
  }

  return {
    evalMetaPresent: meta !== null,
    evaluationRan: meta?.evaluationRan ?? null,
    dockerUsed: meta?.dockerUsed ?? null,
    resolvedCount: meta?.resolvedCount ?? null,
    instancesEvaluated: meta?.instancesEvaluated ?? null,
    firstPatchResolved,
    source,
  };
}

// ---------------------------------------------------------------------------
// Derived evaluation (Docker; opt-in)
// ---------------------------------------------------------------------------

// Mirror the external evaluator invocation the smoke runner uses, but ALWAYS on the
// DERIVED JSONL — never the original. `evaluate <jsonl>` mutates `resolved` in place.
export function buildEvaluateCommand(
  config: CliConfig,
  derivedJsonlPath: string,
): { command: string; args: string[]; cwd: string } {
  const args = [config.cliEntry, "evaluate", derivedJsonlPath, "--mode", config.evalMode, "--timeout", String(config.evalTimeout)];
  if (config.evalMode === "docker" && config.evalDataset !== null) args.push("--dataset", config.evalDataset);
  return { command: config.nodeCommand, args, cwd: config.vexpSweBenchDir };
}

export interface DerivedEvaluationResult {
  readonly evaluationRan: boolean;
  readonly dockerUsed: boolean;
  readonly resolved: boolean | null;
  readonly evaluationError: string | null;
  readonly command: string;
  readonly exitCode: number | null;
}

// Invoke the external evaluator on the DERIVED file and read `resolved` back. Never
// throws on a non-zero exit — the failure is recorded as evaluationError so the
// report can state it honestly. Reads the derived file (the evaluator mutated it).
export async function runDerivedEvaluation(args: {
  readonly config: CliConfig;
  readonly derivedJsonlPath: string;
  readonly instanceId: string;
  readonly deps?: EvalDeps;
}): Promise<DerivedEvaluationResult> {
  const { config, derivedJsonlPath, instanceId, deps } = args;
  // The external evaluator runs with cwd=vexpSweBenchDir, so the derived file must
  // be passed as an ABSOLUTE path or it would be resolved against the wrong dir.
  const absDerivedPath = path.resolve(derivedJsonlPath);
  const spec = buildEvaluateCommand(config, absDerivedPath);
  const commandLine = `${spec.command} ${spec.args.join(" ")} (cwd: ${spec.cwd})`;
  let result: ProcessResult;
  try {
    result = await (deps?.runProcess ?? defaultRunProcess)(spec.command, spec.args, { cwd: spec.cwd });
  } catch (error) {
    return {
      evaluationRan: false,
      dockerUsed: false,
      resolved: null,
      evaluationError: `evaluator threw: ${error instanceof Error ? error.message : String(error)}`,
      command: commandLine,
      exitCode: null,
    };
  }
  const ran = result.exitCode === 0;
  if (!ran) {
    return {
      evaluationRan: false,
      dockerUsed: false,
      resolved: null,
      evaluationError: `evaluate exited ${result.exitCode}: ${result.stderr.trim() || "(no stderr)"}`,
      command: commandLine,
      exitCode: result.exitCode,
    };
  }
  // Re-read the DERIVED file the evaluator rewrote in place.
  const updated = await readText(absDerivedPath);
  const resolved = updated === null ? null : parseResolvedForInstance(updated, instanceId);
  return {
    evaluationRan: true,
    dockerUsed: config.evalMode === "docker",
    resolved,
    evaluationError: resolved === null ? "evaluator ran but no resolved flag was found for the instance." : null,
    command: commandLine,
    exitCode: result.exitCode,
  };
}

// ---------------------------------------------------------------------------
// Report (pure)
// ---------------------------------------------------------------------------

export interface RepairedEvalMeta {
  readonly runLabel: string;
  readonly instanceId: string;
  readonly evaluatedPatch: "repaired";
  readonly firstPatchHash: string | null;
  readonly repairedPatchHash: string;
  readonly evaluationRan: boolean;
  readonly dockerUsed: boolean;
  readonly resolved: boolean | null;
  readonly evaluationError: string | null;
}

export interface RepairedEvalReport {
  readonly generatedAt: string | null;
  readonly runLabel: string;
  readonly instanceId: string;
  readonly summary: {
    readonly artifactSuccess: boolean; // a repaired patch was produced and changed the first patch
    readonly evaluationSuccess: boolean | null; // Docker says resolved=true (null when not run)
    readonly convertedUnresolvedToResolved: boolean; // first unresolved AND repaired resolved
    readonly headline: string;
  };
  readonly firstPatch: {
    readonly hash: string | null;
    readonly evaluated: boolean | null;
    readonly resolved: boolean | null;
    readonly source: FirstPatchEvalEvidence["source"];
    readonly evalMetaPresent: boolean;
  };
  readonly repairedPatch: {
    readonly hash: string;
    readonly changedFirstPatch: boolean | null;
    readonly validPatch: boolean | null;
    readonly failedOpen: boolean | null;
  };
  readonly evaluation: {
    readonly requested: boolean;
    readonly evaluationRan: boolean;
    readonly dockerUsed: boolean;
    readonly resolved: boolean | null;
    readonly evaluationError: string | null;
    readonly derivedJsonlPath: string;
    readonly command: string | null;
  };
  readonly safety: {
    readonly originalJsonlModified: false;
    readonly originalFirstPatchModified: false;
    readonly originalRepairedPatchModified: false;
    readonly originalWorkspaceModified: false;
    readonly isolatedEvalDir: string;
    readonly firstPatchReEvaluated: false;
  };
  readonly nonClaims: readonly string[];
}

export const NON_CLAIMS: readonly string[] = [
  "Benchmark-only and isolated: the original swebench JSONL, first patch, repaired patch, raw agent output, and workspace are never modified.",
  "Docker is OPT-IN; without --run-evaluation no evaluator runs, resolved stays null, and NO resolution is claimed.",
  "Evaluation runs ONLY against a derived JSONL under repair_eval/ whose sole change is modelPatch=repaired diff (resolved reset).",
  "The first patch is NOT re-evaluated here; its resolution is read from existing artifacts (original JSONL row / _eval.meta.json).",
  "Artifact success (a changed repaired patch was produced) is NOT a resolution claim; only Docker resolved=true is evaluation success.",
  "convertedUnresolvedToResolved is true ONLY when the first patch was observed unresolved AND the repaired patch observed resolved.",
  "This runs no agent, no live critic, and no repair, and changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair behavior.",
];

export function buildReport(args: {
  readonly generatedAt: string | null;
  readonly inputs: RepairedEvalInputs;
  readonly firstEval: FirstPatchEvalEvidence;
  readonly evaluation: DerivedEvaluationResult | null;
  readonly requested: boolean;
  readonly derivedJsonlPath: string;
}): RepairedEvalReport {
  const { generatedAt, inputs, firstEval, evaluation, requested, derivedJsonlPath } = args;
  const changedFirstPatch = inputs.repairMeta?.result?.changedPatch ?? null;
  const validPatch = inputs.repairMeta?.result?.validPatch ?? null;
  const failedOpen = inputs.repairMeta?.result?.failedOpen ?? null;

  const artifactSuccess = validPatch === true && changedFirstPatch === true && failedOpen !== true;
  const repairedResolved = evaluation?.resolved ?? null;
  const evaluationSuccess = evaluation === null || !evaluation.evaluationRan ? null : repairedResolved === true;
  const converted = computeConvertedUnresolvedToResolved(firstEval.firstPatchResolved, repairedResolved);

  const headline = (() => {
    if (!requested || evaluation === null || !evaluation.evaluationRan) {
      return artifactSuccess
        ? "Repaired patch produced and changed the first patch; NOT evaluated (Docker opt-in not run). No resolution claimed."
        : "Repaired patch artifact present; NOT evaluated (Docker opt-in not run). No resolution claimed.";
    }
    if (converted) return "Docker: repaired patch RESOLVES the instance where the first patch did NOT — resolution conversion.";
    if (repairedResolved === true) return "Docker: repaired patch resolves the instance (first-patch resolution unknown — no conversion claim).";
    if (repairedResolved === false) return "Docker: repaired patch does NOT resolve the instance.";
    return "Docker ran but produced no resolved flag for the instance.";
  })();

  return {
    generatedAt,
    runLabel: inputs.runLabel,
    instanceId: inputs.instanceId,
    summary: { artifactSuccess, evaluationSuccess, convertedUnresolvedToResolved: converted, headline },
    firstPatch: {
      hash: inputs.firstPatchHash,
      evaluated: firstEval.evaluationRan,
      resolved: firstEval.firstPatchResolved,
      source: firstEval.source,
      evalMetaPresent: firstEval.evalMetaPresent,
    },
    repairedPatch: { hash: inputs.repairedPatchHash, changedFirstPatch, validPatch, failedOpen },
    evaluation: {
      requested,
      evaluationRan: evaluation?.evaluationRan ?? false,
      dockerUsed: evaluation?.dockerUsed ?? false,
      resolved: repairedResolved,
      evaluationError: evaluation?.evaluationError ?? null,
      derivedJsonlPath,
      command: evaluation?.command ?? null,
    },
    safety: {
      originalJsonlModified: false,
      originalFirstPatchModified: false,
      originalRepairedPatchModified: false,
      originalWorkspaceModified: false,
      isolatedEvalDir: inputs.repairEvalDir,
      firstPatchReEvaluated: false,
    },
    nonClaims: NON_CLAIMS,
  };
}

export function buildMeta(report: RepairedEvalReport): RepairedEvalMeta {
  return {
    runLabel: report.runLabel,
    instanceId: report.instanceId,
    evaluatedPatch: "repaired",
    firstPatchHash: report.firstPatch.hash,
    repairedPatchHash: report.repairedPatch.hash,
    evaluationRan: report.evaluation.evaluationRan,
    dockerUsed: report.evaluation.dockerUsed,
    resolved: report.evaluation.resolved,
    evaluationError: report.evaluation.evaluationError,
  };
}

export function renderJson(report: RepairedEvalReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function tri(value: boolean | null): string {
  return value === null ? "unknown" : value ? "yes" : "no";
}

export function renderMarkdown(report: RepairedEvalReport): string {
  const L: string[] = [];
  const { summary, firstPatch, repairedPatch, evaluation, safety } = report;

  L.push("# Stage 5 repaired patch evaluation");
  L.push("");
  if (report.generatedAt) L.push(`_Generated: ${report.generatedAt}_`, "");
  L.push(
    "_Benchmark-only, isolated. Docker is opt-in (`--run-evaluation`). The original swebench JSONL, first patch, repaired " +
      "patch, raw agent output, and workspace are never modified; evaluation runs only against a derived JSONL under " +
      "`repair_eval/` whose sole change is `modelPatch=repaired diff`._",
  );
  L.push("");

  L.push("## Summary");
  L.push("");
  L.push(report.summary.headline);
  L.push("");
  L.push(`- run: \`${report.runLabel}\``);
  L.push(`- instance: \`${report.instanceId}\``);
  L.push(`- artifact success (changed repaired patch produced): **${tri(summary.artifactSuccess)}**`);
  L.push(`- evaluation success (Docker resolved=true): **${tri(summary.evaluationSuccess)}**`);
  L.push(`- resolution conversion (first unresolved → repaired resolved): **${tri(summary.convertedUnresolvedToResolved)}**`);
  L.push("");

  L.push("## Input artifacts");
  L.push("");
  L.push("| artifact | value |");
  L.push("| --- | --- |");
  L.push(`| first patch sha256 | ${firstPatch.hash ?? "—"} |`);
  L.push(`| repaired patch sha256 | ${repairedPatch.hash} |`);
  L.push(`| repaired changed first patch | ${tri(repairedPatch.changedFirstPatch)} |`);
  L.push(`| repaired valid patch | ${tri(repairedPatch.validPatch)} |`);
  L.push(`| repaired failed-open | ${tri(repairedPatch.failedOpen)} |`);
  L.push(`| derived eval JSONL | \`${evaluation.derivedJsonlPath}\` |`);
  L.push("");

  L.push("## Evaluation method");
  L.push("");
  L.push(
    "A derived JSONL is written under `repair_eval/` identical to the original run JSONL except `modelPatch` is the " +
      "repaired diff and `resolved` is reset. When `--run-evaluation` is passed, the existing external `evaluate <jsonl>` " +
      "step runs against that derived file (Docker mutates `resolved` in place) and the flag is read back. The original " +
      "JSONL is never passed to the evaluator.",
  );
  if (evaluation.command) L.push("", `Command: \`${evaluation.command}\``);
  L.push("");

  L.push("## First patch vs repaired patch");
  L.push("");
  L.push("| patch | resolved | source |");
  L.push("| --- | --- | --- |");
  L.push(`| first | ${tri(firstPatch.resolved)} | ${firstPatch.source} |`);
  L.push(`| repaired | ${tri(evaluation.resolved)} | ${evaluation.evaluationRan ? "derived eval" : "not evaluated"} |`);
  L.push("");
  L.push(`Resolution conversion: **${tri(summary.convertedUnresolvedToResolved)}**.`);
  L.push("");

  L.push("## Docker result");
  L.push("");
  L.push("| field | value |");
  L.push("| --- | --- |");
  L.push(`| requested | ${evaluation.requested} |`);
  L.push(`| evaluationRan | ${evaluation.evaluationRan} |`);
  L.push(`| dockerUsed | ${evaluation.dockerUsed} |`);
  L.push(`| resolved | ${evaluation.resolved === null ? "null" : evaluation.resolved} |`);
  L.push(`| evaluationError | ${evaluation.evaluationError ?? "—"} |`);
  L.push("");
  if (!evaluation.requested) {
    L.push("_Docker was not run because `--run-evaluation` was not passed. No resolution is claimed._");
    L.push("");
  }

  L.push("## Safety properties");
  L.push("");
  L.push("| property | value |");
  L.push("| --- | --- |");
  L.push(`| original swebench JSONL modified | ${safety.originalJsonlModified} |`);
  L.push(`| original first patch modified | ${safety.originalFirstPatchModified} |`);
  L.push(`| original repaired patch modified | ${safety.originalRepairedPatchModified} |`);
  L.push(`| original workspace modified | ${safety.originalWorkspaceModified} |`);
  L.push(`| first patch re-evaluated | ${safety.firstPatchReEvaluated} |`);
  L.push(`| isolated eval dir | \`${safety.isolatedEvalDir}\` |`);
  L.push("");

  L.push("## Interpretation");
  L.push("");
  L.push(
    "**Artifact success** means the repair produced a valid patch that changed the first patch — it is NOT a resolution " +
      "claim. **Evaluation success** means Docker reported `resolved=true` for the repaired patch. **Resolution conversion** " +
      "is the strongest claim: the first patch was observed unresolved AND the repaired patch observed resolved. Each is " +
      "reported independently; an unknown on either side never implies the next.",
  );
  L.push("");

  L.push("## Non-claims");
  L.push("");
  for (const n of report.nonClaims) L.push(`- ${n}`);
  L.push("");

  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main (impure)
// ---------------------------------------------------------------------------

export async function run(config: CliConfig, deps: EvalDeps = {}): Promise<RepairedEvalReport> {
  if (config.runLabel === null) {
    throw new Error("--run-label is required (the run carrying repair/_repaired_patch.diff).");
  }
  const generatedAt = new Date().toISOString();

  // --- Phase 1: load inputs (read-only; refuses without a repaired patch) ------
  const inputs = await loadRepairedEvalInputs(config.resultsDir, config.runLabel);

  // --- Phase 2: build the DERIVED evaluation input (isolated; never the original)
  await mkdir(inputs.repairEvalDir, { recursive: true });
  const derivedJsonlPath = path.join(inputs.repairEvalDir, DERIVED_JSONL_NAME);
  const derivedJsonl = buildDerivedJsonl(inputs.originalJsonlContent, inputs.repairedPatch);
  await writeFile(derivedJsonlPath, derivedJsonl);

  // --- Phase 3: read existing first-patch eval evidence (never re-evaluated) ----
  const firstEval = await readFirstPatchEvalEvidence(inputs.vtraceDir, inputs.originalJsonlContent, inputs.instanceId);

  // --- Phase 4: optionally run Docker against the DERIVED file (opt-in) ---------
  let evaluation: DerivedEvaluationResult | null = null;
  if (config.runEvaluation) {
    evaluation = await runDerivedEvaluation({ config, derivedJsonlPath, instanceId: inputs.instanceId, deps });
  }

  // --- Phase 5: write isolated metadata + result + report ----------------------
  const report = buildReport({ generatedAt, inputs, firstEval, evaluation, requested: config.runEvaluation, derivedJsonlPath });
  const meta = buildMeta(report);
  await writeFile(path.join(inputs.repairEvalDir, EVAL_META_NAME), `${JSON.stringify(meta, null, 2)}\n`);
  if (evaluation !== null) {
    await writeFile(path.join(inputs.repairEvalDir, EVAL_RESULT_NAME), `${JSON.stringify(evaluation, null, 2)}\n`);
  }

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  process.stdout.write(
    [
      `Stage 5 repaired patch evaluation written:`,
      `  ${mdPath}`,
      `  ${jsonPath}`,
      `  ${derivedJsonlPath} (derived input)`,
      `  ${path.join(inputs.repairEvalDir, EVAL_META_NAME)}`,
      "",
      `Instance: ${inputs.instanceId}`,
      `Artifact success: ${report.summary.artifactSuccess}   Evaluation success: ${report.summary.evaluationSuccess === null ? "null (not run)" : report.summary.evaluationSuccess}   Converted: ${report.summary.convertedUnresolvedToResolved}`,
      config.runEvaluation
        ? `Docker: ran=${report.evaluation.evaluationRan} resolved=${report.evaluation.resolved === null ? "null" : report.evaluation.resolved}${report.evaluation.evaluationError ? ` error=${report.evaluation.evaluationError}` : ""}`
        : `Docker NOT run (pass --run-evaluation to evaluate). No resolution claimed.`,
      "",
    ].join("\n"),
  );

  return report;
}

if (import.meta.main) {
  try {
    await run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
