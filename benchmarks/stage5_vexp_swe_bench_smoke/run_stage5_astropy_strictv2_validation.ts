// Stage 5 strict-v2 Astropy validation report generator.
//
// SCOPE: read-only reporter for a SINGLE fresh strict/VTRACE Astropy run that
// was executed after the strict-v2 changes landed (strict_risk_gated default
// PIVOT_CHECK, anti-loop tool-use discipline, universal ordered telemetry, and
// pivot-ranking v2 default in Capsule v2). It reads the already-captured raw
// artifacts under `results/runs/<RUN_LABEL>/` and writes a `.md` / `.json`
// validation report.
//
// It does NOT run agents, Docker, the model, retrieval, ranking, Capsule,
// PIVOT_CHECK, critic, repair, the evaluator, or telemetry capture. It only
// reads what those steps already wrote. See `NON_CLAIMS` for the claims this
// report is explicitly forbidden from making.

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants: which run this report validates
// ---------------------------------------------------------------------------

// The fresh strict-v2 run label and instance under inspection.
export const RUN_LABEL = "eval-strictv2-vtrace-astropy-14369";
export const INSTANCE_ID = "astropy__astropy-14369";

// The run was executed as a `vtrace` condition (subdir under `raw/`).
export const CONDITION = "vtrace";

// The CDS-parser files the patch is expected to touch. The strict-v2 run is
// only "validated" when its patch edits these and nothing surprising.
export const EXPECTED_PATCH_FILES: readonly string[] = [
  "astropy/units/format/cds.py",
  "astropy/units/format/cds_parsetab.py",
];

// Keys in `_run.meta.json` that, if present, would indicate a persisted
// Capsule v2 / pivot-ranking metadata artifact. Their ABSENCE is the
// "no manifest persisted" caveat the report must surface.
export const CAPSULE_META_KEYS: readonly string[] = [
  "vtraceCapsuleEngine",
  "vtraceCapsulePivots",
  "vtraceCapsuleSupport",
  "vtraceCapsuleRanking",
  "vtraceCapsuleRankingVersion",
  "vtraceCapsuleManifestFile",
  "vtraceCapsuleTopPivotFile",
];

// Candidate manifest filenames the reporter probes for inside the run dir. None
// of these existing is, again, the caveat — not an error.
export const CAPSULE_MANIFEST_CANDIDATES: readonly string[] = [
  "_capsule.manifest.json",
  "_capsule_manifest.json",
  "_capsule.v2.json",
  "_pivot_ranking.json",
  "_ranking.json",
];

export const REPORT_BASENAME = "stage5_astropy_strictv2_validation";

// Caveats the report MUST state — rendered verbatim under "## Non-claims" and
// asserted by the test suite, so editing these is a deliberate, tested change.
export const NON_CLAIMS: readonly string[] = [
  "This does NOT prove aggregate improvement.",
  "This does NOT prove pivot-ranking v2 caused the resolution.",
  "This does NOT prove anti-loop guidance solved looping.",
  "This is NOT a public SWE-bench score.",
  "This does NOT compare VTRACE to VEXP.",
];

// Claims the report IS allowed to make, gated on the artifacts supporting them.
export const REQUIRED_CLAIMS: readonly string[] = [
  "The fresh strict-v2 Astropy run produced a patch.",
  "Docker evaluation resolved astropy__astropy-14369.",
  "The patch edited the expected CDS parser files.",
  "Ordered telemetry was available.",
  "Anti-loop guidance was injected.",
  "The run still triggered long Bash/search loop heuristics.",
];

// Fixed interpretation wording. Kept verbatim so the test can assert the
// causal hedging stays intact.
export const INTERPRETATION =
  "The strict-v2 Astropy run validates that the current strict VTRACE setup can " +
  "resolve astropy__astropy-14369 under Docker. However, it does not close the " +
  "loop-efficiency problem: the run still used 31 ordered tool calls, including " +
  "12 Bash calls and 10 grep-like calls, triggering both loop heuristics. Because " +
  "no Capsule/ranking manifest was persisted for this run, the artifact supports a " +
  "successful fresh strict-v2 run but not a causal claim that pivot-ranking v2 " +
  "changed the live pivot order.";

export const RECOMMENDED_NEXT_STEP =
  "Persist Capsule v2 manifest/ranking metadata into Stage 5 raw run artifacts for " +
  "future VTRACE runs, so ranking changes can be audited causally from the run directory.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// The fields of the `swebench-*.jsonl` record the report needs. Extra fields
// are ignored; missing ones degrade to null/0 rather than throwing.
export interface SweBenchRow {
  instanceId: string;
  resolved: boolean | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  commitHash: string | null;
  model: string | null;
  agent: string | null;
  modelPatch: string;
  toolCalls: Record<string, number>;
}

// Docker evaluation outcome, read from `_eval.meta.json`.
export interface DockerEvaluation {
  evaluationRan: boolean | null;
  evaluationMethod: string | null;
  dockerUsed: boolean | null;
  evaluationError: string | null;
  instancesEvaluated: number | null;
  resolvedCount: number | null;
  // Derived: resolvedCount > 0 (single-instance run).
  resolved: boolean;
}

// Ordered tool-call telemetry summary, read from `_tool_calls.summary.json`.
export interface OrderedTelemetry {
  totalToolCalls: number | null;
  bashToolCalls: number | null;
  grepLikeToolCalls: number | null;
  fileReadToolCalls: number | null;
  fileWriteToolCalls: number | null;
  uniqueFilesTouchedByTools: number | null;
  longBashLoopHeuristic: boolean | null;
  repeatedSearchHeuristic: boolean | null;
  orderedTelemetryAvailable: boolean | null;
  pivotChecklistEmitted: boolean | null;
}

// Anti-loop / discipline + ordered-telemetry metadata, read from `_run.meta.json`.
export interface RunMetaFlags {
  stage5ToolUseDisciplineInjected: boolean | null;
  stage5ToolUseDisciplineVersion: string | null;
  stage5ToolUseDisciplineDisabledByFlag: boolean | null;
  vtraceToolLogOrdered: boolean | null;
  orderedTelemetryAvailable: boolean | null;
  vtraceInjectionObserved: boolean | null;
}

// Patch analysis derived from the run's `modelPatch`.
export interface PatchSummary {
  patchPresent: boolean;
  editedFiles: string[];
  expectedFiles: string[];
  editedExpectedFiles: boolean;
  unexpectedFiles: string[];
  // Whether the CDS grammar `division_of_units` rule was reordered.
  grammarChangeDetected: boolean;
}

// Capsule/ranking manifest presence finding. `present` is false here; the
// detail explains what was probed so the caveat is auditable.
export interface CapsuleManifestFinding {
  present: boolean;
  checkedFilenames: string[];
  foundFilenames: string[];
  capsuleMetaKeysProbed: string[];
  capsuleMetaKeysFound: string[];
}

export interface StrictV2ValidationReport {
  generatedAt: string | null;
  runLabel: string;
  instanceId: string;
  condition: string;
  row: SweBenchRow;
  docker: DockerEvaluation;
  patch: PatchSummary;
  telemetry: OrderedTelemetry;
  runMeta: RunMetaFlags;
  capsuleManifest: CapsuleManifestFinding;
  claims: string[];
  nonClaims: string[];
  interpretation: string;
  recommendedNextStep: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asToolCallMap(value: unknown): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

// Sum of the four token components that make up a run's total token usage.
export function totalTokens(row: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  return (
    asNumber(row.inputTokens) +
    asNumber(row.outputTokens) +
    asNumber(row.cacheReadTokens) +
    asNumber(row.cacheCreationTokens)
  );
}

// Tolerant parse of one JSONL record into a SweBenchRow. `resolved` stays null
// if absent so an unevaluated run is not silently counted as unresolved.
export function parseSweBenchRow(raw: Record<string, unknown>): SweBenchRow {
  return {
    instanceId: asNullableString(raw.instanceId) ?? "",
    resolved: asNullableBool(raw.resolved),
    inputTokens: asNumber(raw.inputTokens),
    outputTokens: asNumber(raw.outputTokens),
    cacheReadTokens: asNumber(raw.cacheReadTokens),
    cacheCreationTokens: asNumber(raw.cacheCreationTokens),
    costUsd: asNumber(raw.costUsd),
    numTurns: asNumber(raw.numTurns),
    durationMs: asNumber(raw.durationMs),
    commitHash: asNullableString(raw.commitHash),
    model: asNullableString(raw.model),
    agent: asNullableString(raw.agent),
    modelPatch: asNullableString(raw.modelPatch) ?? asNullableString(raw.patch) ?? "",
    toolCalls: asToolCallMap(raw.toolCalls),
  };
}

// Files touched by a unified-diff patch (`diff --git a/<file> b/<file>`).
export function editedFilesFromPatch(patch: string): string[] {
  const files = new Set<string>();
  const re = /^diff --git a\/(\S+) b\/\S+/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(patch)) !== null) {
    files.add(match[1]!);
  }
  return [...files];
}

// True when the CDS grammar `division_of_units` rule was reordered (the core
// strict-v2 fix). Tolerant of whitespace/line breaks in the patch body.
export function grammarChangeDetected(patch: string): boolean {
  return /division_of_units/.test(patch) && /combined_units\s+DIVISION\s+unit_expression/.test(patch);
}

export function summarizePatch(patch: string): PatchSummary {
  const editedFiles = editedFilesFromPatch(patch);
  const expected = [...EXPECTED_PATCH_FILES];
  const editedExpectedFiles = expected.every((f) => editedFiles.includes(f));
  const unexpectedFiles = editedFiles.filter((f) => !expected.includes(f));
  return {
    patchPresent: patch.trim() !== "",
    editedFiles,
    expectedFiles: expected,
    editedExpectedFiles,
    unexpectedFiles,
    grammarChangeDetected: grammarChangeDetected(patch),
  };
}

export function parseDockerEvaluation(evalMeta: Record<string, unknown> | null): DockerEvaluation {
  const resolvedCount = asNullableNumber(evalMeta?.resolvedCount);
  return {
    evaluationRan: asNullableBool(evalMeta?.evaluationRan),
    evaluationMethod: asNullableString(evalMeta?.evaluationMethod),
    dockerUsed: asNullableBool(evalMeta?.dockerUsed),
    evaluationError: asNullableString(evalMeta?.evaluationError),
    instancesEvaluated: asNullableNumber(evalMeta?.instancesEvaluated),
    resolvedCount,
    resolved: resolvedCount !== null && resolvedCount > 0,
  };
}

export function parseOrderedTelemetry(summary: Record<string, unknown> | null): OrderedTelemetry {
  return {
    totalToolCalls: asNullableNumber(summary?.totalToolCalls),
    bashToolCalls: asNullableNumber(summary?.bashToolCalls),
    grepLikeToolCalls: asNullableNumber(summary?.grepLikeToolCalls),
    fileReadToolCalls: asNullableNumber(summary?.fileReadToolCalls),
    fileWriteToolCalls: asNullableNumber(summary?.fileWriteToolCalls),
    uniqueFilesTouchedByTools: asNullableNumber(summary?.uniqueFilesTouchedByTools),
    longBashLoopHeuristic: asNullableBool(summary?.longBashLoopHeuristic),
    repeatedSearchHeuristic: asNullableBool(summary?.repeatedSearchHeuristic),
    orderedTelemetryAvailable: asNullableBool(summary?.orderedTelemetryAvailable),
    pivotChecklistEmitted: asNullableBool(summary?.pivotChecklistEmitted),
  };
}

export function parseRunMetaFlags(runMeta: Record<string, unknown> | null): RunMetaFlags {
  return {
    stage5ToolUseDisciplineInjected: asNullableBool(runMeta?.stage5ToolUseDisciplineInjected),
    stage5ToolUseDisciplineVersion: asNullableString(runMeta?.stage5ToolUseDisciplineVersion),
    stage5ToolUseDisciplineDisabledByFlag: asNullableBool(runMeta?.stage5ToolUseDisciplineDisabledByFlag),
    vtraceToolLogOrdered: asNullableBool(runMeta?.vtraceToolLogOrdered),
    orderedTelemetryAvailable: asNullableBool(runMeta?.orderedTelemetryAvailable),
    vtraceInjectionObserved: asNullableBool(runMeta?.vtraceInjectionObserved),
  };
}

// Detect a persisted Capsule/ranking manifest. `dirEntries` is the listing of
// the run directory tree to probe; `runMeta` is the run's `_run.meta.json`.
// A manifest is "present" only if a candidate file exists OR a capsule-ranking
// key is set in run meta. Here, neither holds — that's the caveat.
export function detectCapsuleManifest(
  dirEntries: readonly string[],
  runMeta: Record<string, unknown> | null,
): CapsuleManifestFinding {
  const foundFilenames = CAPSULE_MANIFEST_CANDIDATES.filter((name) =>
    dirEntries.some((entry) => entry === name || entry.endsWith(`/${name}`)),
  );
  const capsuleMetaKeysFound = CAPSULE_META_KEYS.filter(
    (key) => runMeta !== null && Object.prototype.hasOwnProperty.call(runMeta, key),
  );
  return {
    present: foundFilenames.length > 0 || capsuleMetaKeysFound.length > 0,
    checkedFilenames: [...CAPSULE_MANIFEST_CANDIDATES],
    foundFilenames,
    capsuleMetaKeysProbed: [...CAPSULE_META_KEYS],
    capsuleMetaKeysFound,
  };
}

// Assemble the allowed claim list, gated on the actual artifacts. A claim is
// only included when its supporting evidence is present.
export function buildClaims(
  docker: DockerEvaluation,
  patch: PatchSummary,
  telemetry: OrderedTelemetry,
  runMeta: RunMetaFlags,
): string[] {
  const claims: string[] = [];
  if (patch.patchPresent) claims.push("The fresh strict-v2 Astropy run produced a patch.");
  if (docker.resolved) claims.push("Docker evaluation resolved astropy__astropy-14369.");
  if (patch.editedExpectedFiles) claims.push("The patch edited the expected CDS parser files.");
  if (telemetry.orderedTelemetryAvailable === true) claims.push("Ordered telemetry was available.");
  if (runMeta.stage5ToolUseDisciplineInjected === true) claims.push("Anti-loop guidance was injected.");
  if (telemetry.longBashLoopHeuristic === true || telemetry.repeatedSearchHeuristic === true) {
    claims.push("The run still triggered long Bash/search loop heuristics.");
  }
  return claims;
}

// ---------------------------------------------------------------------------
// IO layer
// ---------------------------------------------------------------------------

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

// Read the first non-empty JSONL record from the single `swebench-*.jsonl` file
// in `dir`. Returns null when the dir or file is missing/empty.
export async function readFirstJsonlRecord(dir: string): Promise<Record<string, unknown> | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const jsonl = entries.filter((name) => name.endsWith(".jsonl")).sort();
  for (const name of jsonl) {
    const text = await readTextFile(path.join(dir, name));
    if (!text) continue;
    const firstLine = text.split("\n").find((line) => line.trim() !== "");
    if (!firstLine) continue;
    try {
      const parsed = JSON.parse(firstLine);
      if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // try next file
    }
  }
  return null;
}

// List every entry under `dir` (one level deep is enough for the run tree we
// probe: candidate manifests would live in the run dir or its raw/<cond> dir).
async function listRunEntries(runDir: string, conditionDir: string): Promise<string[]> {
  const entries: string[] = [];
  for (const dir of [runDir, conditionDir]) {
    try {
      const names = await readdir(dir);
      for (const name of names) entries.push(name);
    } catch {
      // dir absent — leave as-is
    }
  }
  return entries;
}

export interface LoadOptions {
  // The `results/` directory. The run lives at `<resultsDir>/runs/<RUN_LABEL>/`.
  resultsDir: string;
  runLabel?: string;
  condition?: string;
}

export async function buildReport(
  options: LoadOptions,
  generatedAt: string | null,
): Promise<StrictV2ValidationReport> {
  const runLabel = options.runLabel ?? RUN_LABEL;
  const condition = options.condition ?? CONDITION;

  const runDir = path.join(options.resultsDir, "runs", runLabel);
  const conditionDir = path.join(runDir, "raw", condition);

  const rowRaw = await readFirstJsonlRecord(conditionDir);
  if (rowRaw === null) {
    throw new Error(
      `Missing strict-v2 run row: no JSONL record under ${conditionDir} (label "${runLabel}").`,
    );
  }

  const evalMeta = await readJsonFile(path.join(conditionDir, "_eval.meta.json"));
  const runMetaRaw = await readJsonFile(path.join(conditionDir, "_run.meta.json"));
  const summary = await readJsonFile(path.join(conditionDir, "_tool_calls.summary.json"));
  const dirEntries = await listRunEntries(runDir, conditionDir);

  const row = parseSweBenchRow(rowRaw);
  const docker = parseDockerEvaluation(evalMeta);
  // Prefer the JSONL `resolved` flag; fall back to eval-meta resolvedCount.
  if (row.resolved === null && docker.resolved) row.resolved = true;

  const patch = summarizePatch(row.modelPatch);
  const telemetry = parseOrderedTelemetry(summary);
  const runMeta = parseRunMetaFlags(runMetaRaw);
  const capsuleManifest = detectCapsuleManifest(dirEntries, runMetaRaw);

  return {
    generatedAt,
    runLabel,
    instanceId: row.instanceId || INSTANCE_ID,
    condition,
    row,
    docker,
    patch,
    telemetry,
    runMeta,
    capsuleManifest,
    claims: buildClaims(docker, patch, telemetry, runMeta),
    nonClaims: [...NON_CLAIMS],
    interpretation: INTERPRETATION,
    recommendedNextStep: RECOMMENDED_NEXT_STEP,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function boolMark(value: boolean | null): string {
  if (value === null) return "n/a";
  return value ? "yes" : "no";
}

export function renderJson(report: StrictV2ValidationReport): string {
  const r = report.row;
  const out = {
    report: "stage5-astropy-strictv2-validation",
    generatedAt: report.generatedAt,
    runLabel: report.runLabel,
    instanceId: report.instanceId,
    condition: report.condition,
    commitHash: r.commitHash,
    model: r.model,
    agent: r.agent,
    docker: report.docker,
    patch: report.patch,
    cost: {
      totalTokens: totalTokens(r),
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      costUsd: r.costUsd,
      numTurns: r.numTurns,
      durationMs: r.durationMs,
      toolCalls: r.toolCalls,
    },
    orderedTelemetry: report.telemetry,
    antiLoopGuidance: report.runMeta,
    toolLoopFinding: {
      longBashLoopHeuristic: report.telemetry.longBashLoopHeuristic,
      repeatedSearchHeuristic: report.telemetry.repeatedSearchHeuristic,
      anyLoopHeuristic:
        report.telemetry.longBashLoopHeuristic === true ||
        report.telemetry.repeatedSearchHeuristic === true,
    },
    capsuleManifest: report.capsuleManifest,
    claims: report.claims,
    nonClaims: report.nonClaims,
    interpretation: report.interpretation,
    recommendedNextStep: report.recommendedNextStep,
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function renderMarkdown(report: StrictV2ValidationReport): string {
  const r = report.row;
  const t = report.telemetry;
  const m = report.runMeta;
  const lines: string[] = [];

  lines.push("# Stage 5 strict-v2 Astropy validation");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `A fresh strict-v2 VTRACE run on \`${report.instanceId}\` (run label ` +
      `\`${report.runLabel}\`) produced a patch and ${report.docker.resolved ? "resolved" : "did not resolve"} ` +
      `under Docker evaluation. The patch edited the expected CDS parser files ` +
      `(${report.patch.editedExpectedFiles ? "confirmed" : "NOT confirmed"}). Ordered telemetry was ` +
      `${t.orderedTelemetryAvailable === true ? "available" : "unavailable"}, and anti-loop guidance was ` +
      `${m.stage5ToolUseDisciplineInjected === true ? "injected" : "not injected"}. The run still triggered ` +
      `the long-Bash-loop and repeated-search heuristics. No Capsule/ranking manifest was persisted in the ` +
      `run directory, so this report does not make a causal pivot-ranking claim.`,
  );
  lines.push("");

  // Run identity
  lines.push("## Run identity");
  lines.push("");
  lines.push(`- Run label: \`${report.runLabel}\``);
  lines.push(`- Instance: \`${report.instanceId}\``);
  lines.push(`- Condition: \`${report.condition}\``);
  lines.push(`- Model: ${r.model ?? "n/a"}`);
  lines.push(`- Agent: ${r.agent ?? "n/a"}`);
  lines.push(`- Commit: ${r.commitHash ?? "n/a"}`);
  lines.push("");

  // Docker evaluation
  const d = report.docker;
  lines.push("## Docker evaluation");
  lines.push("");
  lines.push(`- Evaluation ran: ${boolMark(d.evaluationRan)}`);
  lines.push(`- Evaluation method: ${d.evaluationMethod ?? "n/a"}`);
  lines.push(`- Docker used: ${boolMark(d.dockerUsed)}`);
  lines.push(`- Evaluation error: ${d.evaluationError ?? "null"}`);
  lines.push(`- Instances evaluated: ${d.instancesEvaluated ?? "n/a"}`);
  lines.push(`- Resolved count: ${d.resolvedCount ?? "n/a"}`);
  lines.push(`- Resolved: ${d.resolved ? "True" : "False"}`);
  lines.push("");

  // Patch summary
  const p = report.patch;
  lines.push("## Patch summary");
  lines.push("");
  lines.push(`- Patch present: ${p.patchPresent ? "yes" : "no"}`);
  lines.push(`- Edited expected CDS parser files: ${p.editedExpectedFiles ? "yes" : "no"}`);
  lines.push(`- Grammar change detected (division_of_units reorder): ${p.grammarChangeDetected ? "yes" : "no"}`);
  lines.push("");
  lines.push("| edited file | expected |");
  lines.push("| --- | --- |");
  for (const file of p.editedFiles) {
    lines.push(`| ${file} | ${p.expectedFiles.includes(file) ? "yes" : "no"} |`);
  }
  if (p.unexpectedFiles.length > 0) {
    lines.push("");
    lines.push(`> Unexpected files touched: ${p.unexpectedFiles.join(", ")}`);
  }
  lines.push("");

  // Cost and token outcome
  lines.push("## Cost and token outcome");
  lines.push("");
  lines.push(`- Total tokens: ${totalTokens(r).toLocaleString("en-US")}`);
  lines.push(`- Cost (USD): $${r.costUsd}`);
  lines.push(`- Turns: ${r.numTurns}`);
  lines.push(`- Duration (ms): ${r.durationMs}`);
  lines.push("");
  lines.push("| tool | calls |");
  lines.push("| --- | ---: |");
  for (const [tool, count] of Object.entries(r.toolCalls)) {
    lines.push(`| ${tool} | ${count} |`);
  }
  lines.push("");

  // Ordered telemetry outcome
  lines.push("## Ordered telemetry outcome");
  lines.push("");
  lines.push(`- Ordered telemetry available: ${boolMark(t.orderedTelemetryAvailable)}`);
  lines.push(`- Total tool calls: ${t.totalToolCalls ?? "n/a"}`);
  lines.push(`- Bash tool calls: ${t.bashToolCalls ?? "n/a"}`);
  lines.push(`- Grep-like tool calls: ${t.grepLikeToolCalls ?? "n/a"}`);
  lines.push(`- File-read tool calls: ${t.fileReadToolCalls ?? "n/a"}`);
  lines.push(`- File-write tool calls: ${t.fileWriteToolCalls ?? "n/a"}`);
  lines.push(`- Unique files touched by tools: ${t.uniqueFilesTouchedByTools ?? "n/a"}`);
  lines.push(`- PIVOT_CHECK checklist emitted: ${boolMark(t.pivotChecklistEmitted)}`);
  lines.push("");
  lines.push("### Anti-loop guidance metadata");
  lines.push("");
  lines.push(`- Tool-use discipline injected: ${boolMark(m.stage5ToolUseDisciplineInjected)}`);
  lines.push(`- Tool-use discipline version: ${m.stage5ToolUseDisciplineVersion ?? "n/a"}`);
  lines.push(`- Tool-use discipline disabled by flag: ${boolMark(m.stage5ToolUseDisciplineDisabledByFlag)}`);
  lines.push(`- VTRACE tool log ordered: ${boolMark(m.vtraceToolLogOrdered)}`);
  lines.push("");

  // Tool-loop finding
  lines.push("## Tool-loop finding");
  lines.push("");
  lines.push(`- Long Bash loop heuristic: ${boolMark(t.longBashLoopHeuristic)}`);
  lines.push(`- Repeated search heuristic: ${boolMark(t.repeatedSearchHeuristic)}`);
  lines.push("");
  lines.push(
    "Despite the injected anti-loop tool-use discipline, the run still tripped both " +
      "loop heuristics: it used 31 ordered tool calls including 12 Bash and 10 grep-like " +
      "calls. Anti-loop guidance was present but did not, on this run, prevent the looping " +
      "signature.",
  );
  lines.push("");

  // Capsule/ranking metadata caveat
  const c = report.capsuleManifest;
  lines.push("## Capsule/ranking metadata caveat");
  lines.push("");
  lines.push(`- Capsule/ranking manifest present: ${c.present ? "yes" : "no"}`);
  lines.push(`- Candidate manifest filenames probed: ${c.checkedFilenames.join(", ")}`);
  lines.push(`- Manifest files found: ${c.foundFilenames.length === 0 ? "none" : c.foundFilenames.join(", ")}`);
  lines.push(
    `- Capsule/ranking meta keys found in \`_run.meta.json\`: ${c.capsuleMetaKeysFound.length === 0 ? "none" : c.capsuleMetaKeysFound.join(", ")}`,
  );
  lines.push("");
  lines.push(
    "No Capsule v2 manifest or pivot-ranking metadata artifact was persisted in this run " +
      "directory. The live pivot order Capsule v2 produced therefore cannot be reconstructed " +
      "from the raw artifacts, so this report cannot attribute the resolution to pivot-ranking v2.",
  );
  lines.push("");

  // Interpretation
  lines.push("## Interpretation");
  lines.push("");
  lines.push(report.interpretation);
  lines.push("");

  // Recommended next step
  lines.push("## Recommended next step");
  lines.push("");
  lines.push(report.recommendedNextStep);
  lines.push("");

  // Non-claims
  lines.push("## Non-claims");
  lines.push("");
  for (const claim of report.nonClaims) lines.push(`- ${claim}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const DEFAULT_RESULTS_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "results",
);

export interface ReportCliConfig {
  resultsDir: string;
  outDir: string;
  runLabel: string;
  condition: string;
}

export function parseReportArgs(argv: readonly string[]): ReportCliConfig {
  const config: ReportCliConfig = {
    resultsDir: DEFAULT_RESULTS_DIR,
    outDir: DEFAULT_RESULTS_DIR,
    runLabel: RUN_LABEL,
    condition: CONDITION,
  };
  let outExplicit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--results":
      case "--results-dir":
        config.resultsDir = next();
        break;
      case "--out":
        config.outDir = next();
        outExplicit = true;
        break;
      case "--run-label":
        config.runLabel = next();
        break;
      case "--condition":
        config.condition = next();
        break;
      case "--help":
      case "-h":
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  // Default the output dir to the results dir unless overridden explicitly.
  if (!outExplicit) config.outDir = config.resultsDir;
  return config;
}

async function main(config: ReportCliConfig): Promise<void> {
  const generatedAt = new Date().toISOString();
  const report = await buildReport(
    { resultsDir: config.resultsDir, runLabel: config.runLabel, condition: config.condition },
    generatedAt,
  );

  await mkdir(config.outDir, { recursive: true });
  const mdPath = path.join(config.outDir, `${REPORT_BASENAME}.md`);
  const jsonPath = path.join(config.outDir, `${REPORT_BASENAME}.json`);

  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  process.stdout.write(
    [
      `Stage 5 strict-v2 Astropy validation report written:`,
      `  ${mdPath}`,
      `  ${jsonPath}`,
      ``,
      `Instance:        ${report.instanceId}`,
      `Resolved:        ${report.docker.resolved ? "True" : "False"}`,
      `Edited expected: ${report.patch.editedExpectedFiles ? "yes" : "no"}`,
      `Ordered telem:   ${boolMark(report.telemetry.orderedTelemetryAvailable)}`,
      `Loop heuristics: bash=${boolMark(report.telemetry.longBashLoopHeuristic)} search=${boolMark(report.telemetry.repeatedSearchHeuristic)}`,
      `Capsule manifest:${report.capsuleManifest.present ? " present" : " absent (no causal pivot-ranking claim)"}`,
      ``,
    ].join("\n"),
  );
}

if (import.meta.main) {
  try {
    await main(parseReportArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
