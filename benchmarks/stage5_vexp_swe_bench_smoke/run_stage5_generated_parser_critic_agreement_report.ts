// Stage 5 generated-parser critic agreement report generator.
//
// SCOPE: read-only documentation. This reporter records that, for the auditable
// Astropy protocol run `eval-strictv2-artifacts-protocol-vtrace-astropy-14369`
// (instance astropy__astropy-14369), the DETERMINISTIC generated-parser
// patch-minimality probe and the LIVE patch critic AGREED that repair was
// required. It establishes an OBSERVATION-ONLY agreement signal — not a repair
// conversion.
//
// It reads existing artifacts only and writes a `.md` / `.json` report. It runs
// NO agents, NO live critic, NO repair, NO Docker, and modifies NO raw
// artifacts. It changes no retrieval / ranking / Capsule / PIVOT_CHECK / critic
// / repair / evaluator / telemetry behavior.
//
// Inputs (all pre-existing):
//   results/stage5_live_critic_generated_parser_astropy.json   (critic summary)
//   results/runs/<label>/raw/vtrace/_patch_critic_report.json  (live critic verdict)
//   results/runs/<label>/raw/vtrace/_patch_critic.meta.json    (det/live/agreement)
//   results/runs/<label>/raw/vtrace/_run.meta.json             (context quality)
//   results/runs/<label>/raw/vtrace/_tool_calls.summary.json   (loop heuristics)
//   results/runs/<label>/raw/vtrace/swebench-*.jsonl           (Docker resolved)

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants: the run under audit and the report identity
// ---------------------------------------------------------------------------

export const TARGET_RUN_LABEL = "eval-strictv2-artifacts-protocol-vtrace-astropy-14369";
export const TARGET_INSTANCE = "astropy__astropy-14369";

export const REPORT_BASENAME = "stage5_generated_parser_critic_agreement";
export const CRITIC_SUMMARY_BASENAME = "stage5_live_critic_generated_parser_astropy";

export const DEFAULT_RESULTS_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "results",
);

// Interpretation prose the report MUST carry. Rendered verbatim and asserted by
// the test suite, so editing it is a deliberate, tested change.
export const INTERPRETATION =
  "The auditable Astropy protocol run had good context: indexed Capsule v2 was " +
  "injected, the lead pivot was astropy/units/format/cds.py::CDS, ordered telemetry " +
  "was available, and loop heuristics were false. Docker still failed because the " +
  "patch made a broad generated-parser rewrite. The deterministic generated-parser " +
  "minimality probe flagged this as high-risk/high-confidence, and the live critic " +
  "agreed that repair was required. This establishes an observation-only agreement " +
  "signal, not a repair conversion.";

// The repair-boundary statements the report MUST make. Verbatim + asserted.
export const REPAIR_BOUNDARY: readonly string[] = [
  "Generated-parser minimality is not yet in the repair allowlist.",
  "No repair was run.",
  "No repaired patch was evaluated.",
  "No policy accounting row should be added.",
];

// The recommended next step. Verbatim + asserted.
export const RECOMMENDED_NEXT_STEP =
  "Design a separate gated generated-parser repair milestone. It should start with " +
  "dry-run repair eligibility only, require a valid live critic report with actionable " +
  "narrow-rewrite instructions, keep one-attempt/cost-cap/run-label gates, and only " +
  "then test whether a repair can produce the narrow grammar-rule reorder without " +
  "deleting generated parser tables.";

// Non-claims the report MUST state. Verbatim + asserted.
export const NON_CLAIMS: readonly string[] = [
  "This report does not re-run agents, live critic, repair, or Docker.",
  "This report does not modify any patch.",
  "This report does not claim a repair conversion.",
  "This report does not add generated-parser defects to the repair allowlist.",
  "This report does not change Stage 5 policy accounting.",
  "This report does not prove the probe generalizes to all generated-parser systems.",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunIdentity {
  runLabel: string;
  instanceId: string | null;
  source: string | null;
}

export interface ContextQuality {
  vtraceMethod: string | null;
  vtraceTreatmentValid: boolean | null;
  capsuleV2ArtifactsPersisted: boolean | null;
  capsuleEngine: string | null;
  pivotRankingVersion: string | null;
  leadPivotFile: string | null;
  leadPivotSymbol: string | null;
  leadPivot: string | null;
  orderedTelemetryAvailable: boolean | null;
  longBashLoopHeuristic: boolean | null;
  repeatedSearchHeuristic: boolean | null;
  dockerResolved: boolean | null;
}

export interface DeterministicProbe {
  patchMinimalityRepairRequired: boolean | null;
  patchMinimalityDefectClass: string | null;
  patchMinimalityRisk: string | null;
  patchMinimalityConfidence: string | null;
  patchMinimalitySignals: string[];
  patchMinimalityReasons: string[];
  patchMinimalityNarrowAlternativeHint: string | null;
}

export interface LiveCriticFinding {
  scopeOk: boolean | null;
  failingBehaviorHandled: boolean | null;
  minimalityOk: boolean | null;
  testEvidenceOk: boolean | null;
  risk: string | null;
  repairRequired: boolean | null;
  repairReason: string | null;
  repairInstructions: string | null;
  confidence: string | null;
  criticCostUsd: number | null;
  criticInputTokens: number | null;
  criticOutputTokens: number | null;
}

export interface Agreement {
  deterministicRepairRequired: boolean | null;
  liveRepairRequired: boolean | null;
  agreementWithDeterministic: boolean | null;
}

export interface AgreementReport {
  generatedAt: string | null;
  runIdentity: RunIdentity;
  contextQuality: ContextQuality;
  deterministicProbe: DeterministicProbe;
  liveCritic: LiveCriticFinding;
  agreement: Agreement;
  interpretation: string;
  repairBoundary: string[];
  recommendedNextStep: string;
  nonClaims: string[];
}

// ---------------------------------------------------------------------------
// Pure coercion helpers
// ---------------------------------------------------------------------------

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Robust run-row finder
// ---------------------------------------------------------------------------
//
// The critic summary JSON's top-level array is `runs` — NOT `.decisions` (the
// shape the earlier manual jq command wrongly assumed, which failed with
// "Cannot iterate over null"). Rather than hardcode one key, probe every known
// candidate array key, plus a top-level array, plus a single-object document
// that IS the run. Returns the first row whose `runLabel` matches.
export const RUN_ARRAY_KEYS: readonly string[] = ["runs", "decisions", "instances", "rows"];

export function collectRunRows(summary: unknown): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const push = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) if (isObject(entry)) rows.push(entry);
    }
  };

  if (Array.isArray(summary)) {
    push(summary);
    return rows;
  }
  if (isObject(summary)) {
    for (const key of RUN_ARRAY_KEYS) push(summary[key]);
    // A single-object document that is itself a run row (has a runLabel).
    if (rows.length === 0 && typeof summary.runLabel === "string") rows.push(summary);
  }
  return rows;
}

export function findRunRow(summary: unknown, runLabel: string): Record<string, unknown> | null {
  for (const row of collectRunRows(summary)) {
    if (asNullableString(row.runLabel) === runLabel) return row;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

// Deterministic probe fields live on the summary run row. Read defensively: a
// missing row degrades every field to null/[] rather than throwing.
export function extractDeterministicProbe(
  runRow: Record<string, unknown> | null,
): DeterministicProbe {
  const row = runRow ?? {};
  return {
    patchMinimalityRepairRequired: asNullableBool(row.patchMinimalityRepairRequired),
    patchMinimalityDefectClass: asNullableString(row.patchMinimalityDefectClass),
    patchMinimalityRisk: asNullableString(row.patchMinimalityRisk),
    patchMinimalityConfidence: asNullableString(row.patchMinimalityConfidence),
    patchMinimalitySignals: asStringArray(row.patchMinimalitySignals),
    patchMinimalityReasons: asStringArray(row.patchMinimalityReasons),
    patchMinimalityNarrowAlternativeHint: asNullableString(row.patchMinimalityNarrowAlternativeHint),
  };
}

// Agreement triple. Prefer the raw `_patch_critic.meta.json`; fall back to the
// summary run row's `meta` object so the report still builds from either source.
export function extractAgreement(
  criticMeta: Record<string, unknown> | null,
  runRow: Record<string, unknown> | null,
): Agreement {
  const rowMeta = runRow && isObject(runRow.meta) ? runRow.meta : null;
  const pick = (key: string): unknown => criticMeta?.[key] ?? rowMeta?.[key];
  return {
    deterministicRepairRequired: asNullableBool(pick("deterministicRepairRequired")),
    liveRepairRequired: asNullableBool(pick("liveRepairRequired")),
    agreementWithDeterministic: asNullableBool(pick("agreementWithDeterministic")),
  };
}

// Live critic verdict. Prefer the raw `_patch_critic_report.json`; fall back to
// the summary run row's `liveReport` object. Cost/token come from the meta.
export function extractLiveCritic(
  criticReport: Record<string, unknown> | null,
  criticMeta: Record<string, unknown> | null,
  runRow: Record<string, unknown> | null,
): LiveCriticFinding {
  const rowReport = runRow && isObject(runRow.liveReport) ? runRow.liveReport : null;
  const report = criticReport ?? rowReport ?? {};
  const rowMeta = runRow && isObject(runRow.meta) ? runRow.meta : null;
  const meta = criticMeta ?? rowMeta ?? {};
  return {
    scopeOk: asNullableBool(report.scope_ok),
    failingBehaviorHandled: asNullableBool(report.failing_behavior_handled),
    minimalityOk: asNullableBool(report.minimality_ok),
    testEvidenceOk: asNullableBool(report.test_evidence_ok),
    risk: asNullableString(report.risk),
    repairRequired: asNullableBool(report.repair_required),
    repairReason: asNullableString(report.repair_reason),
    repairInstructions: asNullableString(report.repair_instructions),
    confidence: asNullableString(report.confidence),
    criticCostUsd: asNullableNumber(meta.criticCostUsd),
    criticInputTokens: asNullableNumber(meta.criticInputTokens),
    criticOutputTokens: asNullableNumber(meta.criticOutputTokens),
  };
}

// Context-quality evidence from `_run.meta.json`, the tool-call summary (loop
// heuristics), and the SWE-bench JSONL (Docker resolved).
export function extractContextQuality(
  runMeta: Record<string, unknown> | null,
  toolSummary: Record<string, unknown> | null,
  sweRow: Record<string, unknown> | null,
): ContextQuality {
  const meta = runMeta ?? {};
  const summary = toolSummary ?? {};
  const leadPivotFile = asNullableString(meta.vtraceCapsuleTopPivotFile);
  const leadPivotSymbol = asNullableString(meta.vtraceCapsuleTopPivotSymbol);
  const leadPivot =
    leadPivotFile === null
      ? null
      : leadPivotSymbol === null
        ? leadPivotFile
        : `${leadPivotFile}::${leadPivotSymbol}`;
  return {
    vtraceMethod: asNullableString(meta.vtraceMethod),
    vtraceTreatmentValid: asNullableBool(meta.vtraceTreatmentValid),
    capsuleV2ArtifactsPersisted: asNullableBool(meta.capsuleV2ArtifactsPersisted),
    capsuleEngine: asNullableString(meta.capsuleEngine) ?? asNullableString(meta.vtraceCapsuleEngine),
    pivotRankingVersion: asNullableString(meta.pivotRankingVersion),
    leadPivotFile,
    leadPivotSymbol,
    leadPivot,
    // orderedTelemetry is recorded in both meta and the tool-call summary; prefer meta.
    orderedTelemetryAvailable:
      asNullableBool(meta.orderedTelemetryAvailable) ?? asNullableBool(summary.orderedTelemetryAvailable),
    longBashLoopHeuristic: asNullableBool(summary.longBashLoopHeuristic),
    repeatedSearchHeuristic: asNullableBool(summary.repeatedSearchHeuristic),
    dockerResolved: sweRow === null ? null : asNullableBool(sweRow.resolved),
  };
}

export function extractRunIdentity(runRow: Record<string, unknown> | null): RunIdentity {
  const row = runRow ?? {};
  return {
    runLabel: asNullableString(row.runLabel) ?? TARGET_RUN_LABEL,
    instanceId: asNullableString(row.instanceId),
    source: asNullableString(row.source),
  };
}

// ---------------------------------------------------------------------------
// IO layer
// ---------------------------------------------------------------------------

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Parse a JSON file that may be an object OR a top-level array (the critic
// summary is an object; defensive against either).
async function readJsonDoc(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

// First non-empty record from the single `swebench-*.jsonl` file in `dir`.
async function readFirstJsonlRecord(dir: string): Promise<Record<string, unknown> | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of entries.filter((n) => n.endsWith(".jsonl")).sort()) {
    let text: string;
    try {
      text = await readFile(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    const firstLine = text.split("\n").find((line) => line.trim() !== "");
    if (!firstLine) continue;
    try {
      const parsed = JSON.parse(firstLine);
      if (isObject(parsed)) return parsed;
    } catch {
      // try next file
    }
  }
  return null;
}

export interface LoadOptions {
  resultsDir: string;
  runLabel?: string;
  criticSummaryBasename?: string;
}

export async function buildReport(
  options: LoadOptions,
  generatedAt: string | null,
): Promise<AgreementReport> {
  const runLabel = options.runLabel ?? TARGET_RUN_LABEL;
  const summaryBase = options.criticSummaryBasename ?? CRITIC_SUMMARY_BASENAME;

  const summaryDoc = await readJsonDoc(path.join(options.resultsDir, `${summaryBase}.json`));
  const runRow = findRunRow(summaryDoc, runLabel);

  const rawDir = path.join(options.resultsDir, "runs", runLabel, "raw", "vtrace");
  const criticReport = await readJsonFile(path.join(rawDir, "_patch_critic_report.json"));
  const criticMeta = await readJsonFile(path.join(rawDir, "_patch_critic.meta.json"));
  const runMeta = await readJsonFile(path.join(rawDir, "_run.meta.json"));
  const toolSummary = await readJsonFile(path.join(rawDir, "_tool_calls.summary.json"));
  const sweRow = await readFirstJsonlRecord(rawDir);

  return {
    generatedAt,
    runIdentity: extractRunIdentity(runRow),
    contextQuality: extractContextQuality(runMeta, toolSummary, sweRow),
    deterministicProbe: extractDeterministicProbe(runRow),
    liveCritic: extractLiveCritic(criticReport, criticMeta, runRow),
    agreement: extractAgreement(criticMeta, runRow),
    interpretation: INTERPRETATION,
    repairBoundary: [...REPAIR_BOUNDARY],
    recommendedNextStep: RECOMMENDED_NEXT_STEP,
    nonClaims: [...NON_CLAIMS],
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function boolMark(value: boolean | null): string {
  if (value === null) return "n/a";
  return value ? "true" : "false";
}

function fmtUsd(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(4)}`;
}

export function renderJson(report: AgreementReport): string {
  const out = {
    report: "stage5_generated_parser_critic_agreement",
    generatedAt: report.generatedAt,
    runIdentity: report.runIdentity,
    contextQuality: report.contextQuality,
    deterministicProbe: report.deterministicProbe,
    liveCritic: report.liveCritic,
    agreement: report.agreement,
    // Top-level agreement field for downstream consumers / jq.
    agreementWithDeterministic: report.agreement.agreementWithDeterministic,
    liveRepairRequired: report.agreement.liveRepairRequired,
    deterministicRepairRequired: report.agreement.deterministicRepairRequired,
    interpretation: report.interpretation,
    repairBoundary: report.repairBoundary,
    recommendedNextStep: report.recommendedNextStep,
    nonClaims: report.nonClaims,
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function renderMarkdown(report: AgreementReport): string {
  const id = report.runIdentity;
  const cq = report.contextQuality;
  const dp = report.deterministicProbe;
  const lc = report.liveCritic;
  const ag = report.agreement;
  const lines: string[] = [];

  lines.push("# Stage 5 generated-parser critic agreement");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");
  lines.push(
    "_Documentation only. No agents, no live critic, no repair, no Docker, no patch " +
      "modification. Reads existing artifacts and records that the deterministic " +
      "generated-parser minimality probe and the live patch critic agreed repair was " +
      "required for this run._",
  );
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push(report.interpretation);
  lines.push("");

  // Run identity
  lines.push("## Run identity");
  lines.push("");
  lines.push(`- runLabel: ${id.runLabel}`);
  lines.push(`- instanceId: ${id.instanceId ?? "n/a"}`);
  lines.push(`- source: ${id.source ?? "n/a"}`);
  lines.push("");

  // Context quality
  lines.push("## Context quality");
  lines.push("");
  lines.push(
    "Context-quality evidence read from the run's `_run.meta.json`, " +
      "`_tool_calls.summary.json`, and `swebench-*.jsonl`. The run had good context " +
      "yet Docker still failed — because the patch was a broad generated-parser rewrite, " +
      "not because retrieval was poor.",
  );
  lines.push("");
  lines.push("| field | value |");
  lines.push("| --- | --- |");
  lines.push(`| vtraceMethod | ${cq.vtraceMethod ?? "n/a"} |`);
  lines.push(`| vtraceTreatmentValid | ${boolMark(cq.vtraceTreatmentValid)} |`);
  lines.push(`| capsuleV2ArtifactsPersisted | ${boolMark(cq.capsuleV2ArtifactsPersisted)} |`);
  lines.push(`| capsuleEngine | ${cq.capsuleEngine ?? "n/a"} |`);
  lines.push(`| pivotRankingVersion | ${cq.pivotRankingVersion ?? "n/a"} |`);
  lines.push(`| lead pivot | ${cq.leadPivot ?? "n/a"} |`);
  lines.push(`| orderedTelemetryAvailable | ${boolMark(cq.orderedTelemetryAvailable)} |`);
  lines.push(`| longBashLoopHeuristic | ${boolMark(cq.longBashLoopHeuristic)} |`);
  lines.push(`| repeatedSearchHeuristic | ${boolMark(cq.repeatedSearchHeuristic)} |`);
  lines.push(`| Docker resolved | ${boolMark(cq.dockerResolved)} |`);
  lines.push("");

  // Deterministic probe finding
  lines.push("## Deterministic probe finding");
  lines.push("");
  lines.push(
    "The deterministic generated-parser patch-minimality probe (observation-only) " +
      "flagged this patch.",
  );
  lines.push("");
  lines.push(`- patchMinimalityRepairRequired: ${boolMark(dp.patchMinimalityRepairRequired)}`);
  lines.push(`- patchMinimalityDefectClass: ${dp.patchMinimalityDefectClass ?? "n/a"}`);
  lines.push(`- patchMinimalityRisk: ${dp.patchMinimalityRisk ?? "n/a"}`);
  lines.push(`- patchMinimalityConfidence: ${dp.patchMinimalityConfidence ?? "n/a"}`);
  lines.push(
    `- patchMinimalitySignals: ${dp.patchMinimalitySignals.length > 0 ? dp.patchMinimalitySignals.join(", ") : "none"}`,
  );
  for (const reason of dp.patchMinimalityReasons) lines.push(`- reason: ${reason}`);
  if (dp.patchMinimalityNarrowAlternativeHint) {
    lines.push(`- narrowAlternativeHint: ${dp.patchMinimalityNarrowAlternativeHint}`);
  }
  lines.push("");

  // Live critic finding
  lines.push("## Live critic finding");
  lines.push("");
  lines.push(
    "The live patch critic ran once on this run (observation-only; the critic never " +
      "modifies the patch).",
  );
  lines.push("");
  lines.push(`- scope_ok: ${boolMark(lc.scopeOk)}`);
  lines.push(`- failing_behavior_handled: ${boolMark(lc.failingBehaviorHandled)}`);
  lines.push(`- minimality_ok: ${boolMark(lc.minimalityOk)}`);
  lines.push(`- test_evidence_ok: ${boolMark(lc.testEvidenceOk)}`);
  lines.push(`- risk: ${lc.risk ?? "n/a"}`);
  lines.push(`- repair_required: ${boolMark(lc.repairRequired)}`);
  lines.push(`- confidence: ${lc.confidence ?? "n/a"}`);
  lines.push(
    `- critic cost: ${fmtUsd(lc.criticCostUsd)} (${lc.criticInputTokens ?? "n/a"} in / ${lc.criticOutputTokens ?? "n/a"} out tokens)`,
  );
  if (lc.repairReason) lines.push(`- repair_reason: ${lc.repairReason}`);
  if (lc.repairInstructions) lines.push(`- repair_instructions: ${lc.repairInstructions}`);
  lines.push("");

  // Agreement
  lines.push("## Agreement");
  lines.push("");
  lines.push(`- deterministicRepairRequired: ${boolMark(ag.deterministicRepairRequired)}`);
  lines.push(`- liveRepairRequired: ${boolMark(ag.liveRepairRequired)}`);
  lines.push(`- agreementWithDeterministic: ${boolMark(ag.agreementWithDeterministic)}`);
  lines.push("");
  lines.push(
    "Agreement = (deterministicRepairRequired === liveRepairRequired). Both are true: " +
      "the deterministic probe and the live critic independently concluded repair was " +
      "required. This is an observation-only agreement signal, not a repair conversion.",
  );
  lines.push("");

  // Observation-only boundary
  lines.push("## Observation-only boundary");
  lines.push("");
  lines.push("- No repair was run.");
  lines.push("- No generated-parser defect class was added to the repair allowlist.");
  lines.push(
    "- Repair remains disabled-by-default and ineligible for this defect class unless a " +
      "later explicit milestone adds a gated generated-parser repair path.",
  );
  lines.push(
    "- The generated-parser patch-minimality probe is an OBSERVATION-ONLY deterministic " +
      "signal: it makes a run eligible for live critic observation but never triggers " +
      "automatic repair.",
  );
  lines.push("");

  // Repair boundary
  lines.push("## Repair boundary");
  lines.push("");
  for (const statement of report.repairBoundary) lines.push(`- ${statement}`);
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

export interface ReportCliConfig {
  resultsDir: string;
  runLabel: string;
  outDir: string;
}

export function parseReportArgs(argv: readonly string[]): ReportCliConfig {
  const config: ReportCliConfig = {
    resultsDir: DEFAULT_RESULTS_DIR,
    runLabel: TARGET_RUN_LABEL,
    outDir: DEFAULT_RESULTS_DIR,
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
      case "--run-label":
        config.runLabel = next();
        break;
      case "--out":
        config.outDir = next();
        outExplicit = true;
        break;
      case "--help":
      case "-h":
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  // Default the output dir to the results dir unless overridden.
  if (!outExplicit) config.outDir = config.resultsDir;
  return config;
}

async function main(config: ReportCliConfig): Promise<void> {
  const generatedAt = new Date().toISOString();
  const report = await buildReport(
    { resultsDir: config.resultsDir, runLabel: config.runLabel },
    generatedAt,
  );

  await mkdir(config.outDir, { recursive: true });
  const mdPath = path.join(config.outDir, `${REPORT_BASENAME}.md`);
  const jsonPath = path.join(config.outDir, `${REPORT_BASENAME}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  const ag = report.agreement;
  process.stdout.write(
    [
      "Stage 5 generated-parser critic agreement report written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Run: ${report.runIdentity.runLabel} (${report.runIdentity.instanceId ?? "n/a"})`,
      `deterministicRepairRequired: ${boolMark(ag.deterministicRepairRequired)}`,
      `liveRepairRequired:          ${boolMark(ag.liveRepairRequired)}`,
      `agreementWithDeterministic:  ${boolMark(ag.agreementWithDeterministic)}`,
      "",
      "Observation-only: no repair was run; generated-parser minimality is not in the repair allowlist.",
      "",
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
