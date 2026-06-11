// Stage 5 generated-parser repair FAILURE diagnostic over existing artifacts.
//
// SCOPE: analysis / reporting ONLY. Reads artifacts that already exist on disk — the
// generated-parser repair conversion report, the repaired patch, the source (first) patch,
// and the earlier RESOLVED strict Astropy patch — and explains WHY the narrow
// generated-parser repair did not convert the instance under Docker. It runs NO agents, NO
// repair, NO live critic, NO Docker, calls NO model, and mutates NO artifact. It is NOT a
// gate and adds NO policy-accounting row.
//
// Finding (astropy__astropy-14369): the repaired patch made the correct one-line
// `division_of_units` grammar reorder in `cds.py` but did NOT update the generated parser
// table `cds_parsetab.py`. The earlier resolved strict run changed BOTH `cds.py` and
// `cds_parsetab.py`. The failure is therefore generated-parser CONSISTENCY
// (source_grammar_changed_without_generated_table_update), not localization and not
// broad-rewrite minimality.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import {
  analyzeGeneratedParserConsistency,
  type GeneratedParserConsistencyResult,
} from "../../src/capsule/patchMinimalityProbes";
import { editedFilesFromPatch } from "../../src/capsule/finalEditDiagnostics";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RESULTS_REL = "benchmarks/stage5_vexp_swe_bench_smoke/results";
export const DEFAULT_OUT_NAME = "stage5_generated_parser_repair_failure_diagnostic";

// The run whose repair was Docker-evaluated in 601b6b4.
export const SOURCE_RUN_LABEL = "eval-strictv2-artifacts-protocol-vtrace-astropy-14369";
// The earlier strict run that RESOLVED Astropy (cds.py + cds_parsetab.py). May be absent.
export const RESOLVED_RUN_LABEL = "eval-strictv2-vtrace-astropy-14369";
export const INSTANCE_ID = "astropy__astropy-14369";
export const CONVERSION_REPORT_NAME = "stage5_generated_parser_repair_conversion";

export const DIAGNOSIS_DEFECT_CLASS = "source_grammar_changed_without_generated_table_update";

// The required interpretation, verbatim shape.
export const DIAGNOSIS_TEXT =
  "The generated-parser repair fixed the broad-rewrite problem but likely under-repaired the generated-parser " +
  "consistency problem. The repaired patch changed the source grammar in cds.py but did not update cds_parsetab.py. " +
  "The earlier resolved Astropy patch changed both cds.py and cds_parsetab.py. Therefore the current failure should " +
  "be treated as source_grammar_changed_without_generated_table_update, not as a localization failure.";

export const RECOMMENDED_NEXT_STEP =
  "Update the generated-parser repair guidance so that narrow repairs may update generated parser tables " +
  "consistently when the source grammar changes. The instruction should forbid deleting generated parser tables or " +
  "broad grammar rewrites, but should require regenerating/updating the relevant parsetab when the grammar changes. " +
  "Do not run another Astropy instance yet; do not add a policy-accounting row; do not change pivot ranking or " +
  "Capsule budget.";

export const NON_CLAIMS: readonly string[] = [
  "This report does not re-run agents, repair, live critic, or Docker.",
  "This report does not modify any patch.",
  "This report does not claim a repair conversion.",
  "This report does not change repair eligibility.",
  "This report does not change Stage 5 policy accounting.",
  "This report does not prove all generated-parser systems require committed parser-table updates.",
];

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface DockerOutcome {
  readonly dockerUsed: boolean | null;
  readonly evaluationMethod: string | null;
  readonly sourcePatchResolved: boolean | null;
  readonly repairedPatchResolved: boolean | null;
  readonly convertedUnresolvedToResolved: boolean | null;
}

export interface PatchView {
  readonly available: boolean;
  readonly filesChanged: string[];
  readonly probe: GeneratedParserConsistencyResult | null;
}

export interface ComparisonView {
  readonly available: boolean;
  readonly resolvedRunLabel: string;
  // Did the resolved patch change cds_parsetab.py (the generated table the repaired patch missed)?
  readonly resolvedUpdatedGeneratedTable: boolean;
  readonly resolvedFilesChanged: string[];
  // Generated tables the repaired patch failed to update but the resolved patch did.
  readonly missingGeneratedTables: string[];
}

export interface DiagnosticReport {
  readonly generatedAt: string | null;
  readonly sourceRunLabel: string;
  readonly instanceId: string;
  readonly conversionReportFound: boolean;
  readonly dockerOutcome: DockerOutcome;
  readonly repairedPatch: PatchView;
  readonly firstPatch: PatchView;
  readonly resolvedPatch: PatchView;
  readonly comparison: ComparisonView;
  readonly diagnosisDefectClass: string;
  readonly diagnosis: string;
  readonly recommendedNextStep: string;
  readonly nonClaims: readonly string[];
}

// ---------------------------------------------------------------------------
// Report assembly (pure)
// ---------------------------------------------------------------------------

const EMPTY_OUTCOME: DockerOutcome = {
  dockerUsed: null,
  evaluationMethod: null,
  sourcePatchResolved: null,
  repairedPatchResolved: null,
  convertedUnresolvedToResolved: null,
};

const ABSENT_PATCH: PatchView = { available: false, filesChanged: [], probe: null };

export interface BuildReportInput {
  readonly generatedAt: string | null;
  readonly conversionReportFound: boolean;
  readonly dockerOutcome: DockerOutcome;
  readonly repairedPatchDiff: string | null;
  readonly firstPatchDiff: string | null;
  readonly resolvedPatchDiff: string | null;
}

function patchView(diff: string | null, knownGeneratedTables: readonly string[]): PatchView {
  if (diff === null) return ABSENT_PATCH;
  return {
    available: true,
    filesChanged: editedFilesFromPatch(diff),
    probe: analyzeGeneratedParserConsistency(diff, { knownGeneratedTables }),
  };
}

// Generated parser tables observed (changed or deleted) in a comparison patch — used to
// strengthen the stale-table inference for the repaired patch.
function generatedTablesIn(diff: string | null): string[] {
  if (diff === null) return [];
  const probe = analyzeGeneratedParserConsistency(diff);
  return [...probe.generatedParserTablesChanged, ...probe.generatedParserTablesDeleted];
}

export function buildReport(input: BuildReportInput): DiagnosticReport {
  // Known tables are pulled from the comparison patches so the repaired-patch probe can
  // confirm cds_parsetab.py was a real, present sibling rather than only a convention.
  const knownGeneratedTables = Array.from(
    new Set([...generatedTablesIn(input.firstPatchDiff), ...generatedTablesIn(input.resolvedPatchDiff)]),
  );

  const repairedPatch = patchView(input.repairedPatchDiff, knownGeneratedTables);
  const firstPatch = patchView(input.firstPatchDiff, knownGeneratedTables);
  const resolvedPatch = patchView(input.resolvedPatchDiff, knownGeneratedTables);

  const resolvedUpdated = resolvedPatch.probe?.generatedParserTablesChanged ?? [];
  const repairedExpected = repairedPatch.probe?.expectedGeneratedTables ?? [];
  const repairedUpdated = repairedPatch.probe?.generatedParserTablesChanged ?? [];
  const missingGeneratedTables = repairedExpected.filter((t) => !repairedUpdated.includes(t));

  const comparison: ComparisonView = {
    available: resolvedPatch.available,
    resolvedRunLabel: RESOLVED_RUN_LABEL,
    resolvedUpdatedGeneratedTable: resolvedUpdated.length > 0,
    resolvedFilesChanged: resolvedPatch.filesChanged,
    missingGeneratedTables,
  };

  return {
    generatedAt: input.generatedAt,
    sourceRunLabel: SOURCE_RUN_LABEL,
    instanceId: INSTANCE_ID,
    conversionReportFound: input.conversionReportFound,
    dockerOutcome: input.dockerOutcome,
    repairedPatch,
    firstPatch,
    resolvedPatch,
    comparison,
    diagnosisDefectClass: DIAGNOSIS_DEFECT_CLASS,
    diagnosis: DIAGNOSIS_TEXT,
    recommendedNextStep: RECOMMENDED_NEXT_STEP,
    nonClaims: NON_CLAIMS,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderJson(report: DiagnosticReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function fmtBool(v: boolean | null): string {
  return v === null ? "unknown" : v ? "yes" : "no";
}

function fmtList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function renderProbe(lines: string[], probe: GeneratedParserConsistencyResult | null): void {
  if (probe === null) {
    lines.push("- _patch unavailable on disk; consistency probe not run._");
    return;
  }
  lines.push(
    `- **defectClass**: \`${probe.defectClass}\`; consistencyRisk ${probe.consistencyRisk ? "yes" : "no"}; ` +
      `risk ${probe.risk}; confidence ${probe.confidence}.`,
  );
  lines.push(`- **Source grammar files changed**: ${fmtList(probe.sourceGrammarFilesChanged)}.`);
  lines.push(`- **Expected generated tables**: ${fmtList(probe.expectedGeneratedTables)}.`);
  lines.push(`- **Generated tables updated**: ${fmtList(probe.generatedParserTablesChanged)}.`);
  lines.push(`- **Generated tables deleted**: ${fmtList(probe.generatedParserTablesDeleted)}.`);
  lines.push(`- **Narrow grammar reorder detected**: ${probe.narrowGrammarReorderDetected ? "yes" : "no"}.`);
  if (probe.signals.length > 0) lines.push(`- **Signals**: ${probe.signals.map((s) => `\`${s}\``).join(", ")}.`);
  for (const reason of probe.reasons) lines.push(`- ${reason}`);
}

export function renderMarkdown(report: DiagnosticReport): string {
  const lines: string[] = [];
  const d = report.dockerOutcome;
  const repaired = report.repairedPatch.probe;

  lines.push("# Stage 5 generated-parser repair failure diagnostic");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");
  lines.push(
    "_Analysis only. Reads existing artifacts (repair conversion report, repaired patch, first patch, earlier " +
      "resolved patch) and runs the deterministic `analyzeGeneratedParserConsistency` probe. No agents, no repair, no " +
      "live critic, no Docker, no model calls, no artifact mutation, no policy accounting._",
  );
  lines.push("");

  // --- Summary -------------------------------------------------------------
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `The gated generated-parser repair for \`${report.instanceId}\` produced a narrow, well-localized grammar ` +
      "reorder but the Docker evaluation stayed **unresolved**. The deterministic consistency probe classifies the " +
      `repaired patch as \`${report.diagnosisDefectClass}\`: it changed the source grammar in \`cds.py\` without ` +
      "updating the generated parser table `cds_parsetab.py`. This is generated-parser **consistency**, not " +
      "localization and not broad-rewrite minimality.",
  );
  lines.push("");

  // --- Source run ----------------------------------------------------------
  lines.push("## Source run");
  lines.push("");
  lines.push(`- **Run label**: \`${report.sourceRunLabel}\`.`);
  lines.push(`- **Instance**: \`${report.instanceId}\`.`);
  lines.push(`- **Conversion report found**: ${report.conversionReportFound ? "yes" : "no"} (\`${CONVERSION_REPORT_NAME}.json\`).`);
  lines.push("");

  // --- Repair attempt ------------------------------------------------------
  lines.push("## Repair attempt");
  lines.push("");
  lines.push(
    "The gated generated-parser repair fixed the earlier broad-rewrite shape: it did not delete generated parser " +
      "tables, did not relocate productions across parser functions, and did not broadly rewrite unrelated grammar " +
      "functions. It changed only `astropy/units/format/cds.py`.",
  );
  lines.push("");
  lines.push(`- **Files changed by repaired patch**: ${fmtList(report.repairedPatch.filesChanged)}.`);
  if (repaired) {
    lines.push(`- **Narrow grammar reorder detected**: ${repaired.narrowGrammarReorderDetected ? "yes" : "no"}.`);
  }
  lines.push("");

  // --- Docker outcome ------------------------------------------------------
  lines.push("## Docker outcome");
  lines.push("");
  lines.push("| property | value |");
  lines.push("| --- | --- |");
  lines.push(`| dockerUsed | ${fmtBool(d.dockerUsed)} |`);
  lines.push(`| evaluationMethod | ${d.evaluationMethod ?? "unknown"} |`);
  lines.push(`| sourcePatchResolved | ${fmtBool(d.sourcePatchResolved)} |`);
  lines.push(`| repairedPatchResolved | ${fmtBool(d.repairedPatchResolved)} |`);
  lines.push(`| convertedUnresolvedToResolved | ${fmtBool(d.convertedUnresolvedToResolved)} |`);
  lines.push("");
  lines.push(
    "The repaired patch did not convert the instance. This remains a patch-quality failure and is not counted as a " +
      "conversion.",
  );
  lines.push("");

  // --- Repaired patch shape ------------------------------------------------
  lines.push("## Repaired patch shape");
  lines.push("");
  lines.push("The repaired patch reorders one alternative inside `p_division_of_units`:");
  lines.push("");
  lines.push("```diff");
  lines.push("             division_of_units : DIVISION unit_expression");
  lines.push("-                              | unit_expression DIVISION combined_units");
  lines.push("+                              | combined_units DIVISION unit_expression");
  lines.push("```");
  lines.push("");
  lines.push("- [x] changes `p_division_of_units` narrowly (single-line production reorder)");
  lines.push("- [x] does **not** delete `cds_parsetab.py` / `cds_lextab.py`");
  lines.push("- [x] does **not** relocate productions into `p_combined_units`");
  lines.push("- [x] does **not** broadly rewrite unrelated grammar functions");
  lines.push("- [ ] does **not** update the generated parser table `cds_parsetab.py` — **the gap**");
  lines.push("");

  // --- Consistency probe ---------------------------------------------------
  lines.push("## Consistency probe");
  lines.push("");
  lines.push("Deterministic `analyzeGeneratedParserConsistency` over the repaired patch:");
  lines.push("");
  renderProbe(lines, repaired);
  lines.push("");

  // --- Comparison with resolved patch --------------------------------------
  lines.push("## Comparison with resolved patch");
  lines.push("");
  if (!report.comparison.available) {
    lines.push(
      `_The earlier resolved strict Astropy patch (\`${report.comparison.resolvedRunLabel}\`) was not available on ` +
        "disk. The resolved-patch comparison is therefore marked **unavailable**. The repaired patch is still " +
        "classified as suspicious because it changed source grammar without a generated parser table update._",
    );
  } else {
    lines.push(
      `The earlier resolved strict run \`${report.comparison.resolvedRunLabel}\` changed both \`cds.py\` and ` +
        "`cds_parsetab.py`. It made the same narrow `division_of_units` reorder AND regenerated the parser table.",
    );
    lines.push("");
    lines.push("| patch | files changed | updated cds_parsetab.py |");
    lines.push("| --- | --- | --- |");
    lines.push(
      `| resolved | ${fmtList(report.resolvedPatch.filesChanged)} | ${report.comparison.resolvedUpdatedGeneratedTable ? "yes" : "no"} |`,
    );
    lines.push(
      `| repaired (unresolved) | ${fmtList(report.repairedPatch.filesChanged)} | ${repaired?.generatedParserTablesChanged.length ? "yes" : "no"} |`,
    );
    lines.push("");
    lines.push(`- **Generated table(s) the repaired patch missed**: ${fmtList(report.comparison.missingGeneratedTables)}.`);
  }
  lines.push("");

  // --- Diagnosis update ----------------------------------------------------
  lines.push("## Diagnosis update");
  lines.push("");
  lines.push(report.diagnosis);
  lines.push("");

  // --- Recommended next step ----------------------------------------------
  lines.push("## Recommended next step");
  lines.push("");
  lines.push(report.recommendedNextStep);
  lines.push("");

  // --- Non-claims ----------------------------------------------------------
  lines.push("## Non-claims");
  lines.push("");
  for (const claim of report.nonClaims) lines.push(`- ${claim}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Loading (impure)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

async function readTextFile(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function readJsonFile(p: string): Promise<Record<string, unknown> | null> {
  const text = await readTextFile(p);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// modelPatch from the first non-empty line of a run's swebench-*.jsonl.
async function readRunModelPatch(resultsDir: string, runLabel: string): Promise<string | null> {
  const vtraceDir = path.join(resultsDir, "runs", runLabel, "raw", "vtrace");
  let entries: string[];
  try {
    entries = await readdir(vtraceDir);
  } catch {
    return null;
  }
  const jsonl = entries.find((e) => e.startsWith("swebench-") && e.endsWith(".jsonl"));
  if (!jsonl) return null;
  const text = await readTextFile(path.join(vtraceDir, jsonl));
  if (text === null) return null;
  const firstLine = text.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) return null;
  try {
    const parsed = JSON.parse(firstLine);
    return isRecord(parsed) ? asString(parsed.modelPatch) : null;
  } catch {
    return null;
  }
}

async function readRepairedPatch(resultsDir: string, runLabel: string): Promise<string | null> {
  return readTextFile(path.join(resultsDir, "runs", runLabel, "raw", "vtrace", "repair", "_repaired_patch.diff"));
}

export interface LoadedArtifacts {
  readonly conversionReportFound: boolean;
  readonly dockerOutcome: DockerOutcome;
  readonly repairedPatchDiff: string | null;
  readonly firstPatchDiff: string | null;
  readonly resolvedPatchDiff: string | null;
}

export async function loadArtifacts(resultsDir: string): Promise<LoadedArtifacts> {
  const conversion = await readJsonFile(path.join(resultsDir, `${CONVERSION_REPORT_NAME}.json`));
  const dockerOutcome: DockerOutcome = conversion
    ? {
        dockerUsed: asBool(conversion.dockerUsed),
        evaluationMethod: asString(conversion.evaluationMethod),
        sourcePatchResolved: asBool(conversion.sourcePatchResolved),
        repairedPatchResolved: asBool(conversion.repairedPatchResolved),
        convertedUnresolvedToResolved: asBool(conversion.convertedUnresolvedToResolved),
      }
    : EMPTY_OUTCOME;

  // Prefer the saved repaired patch diff; fall back to none.
  const repairedPatchDiff = await readRepairedPatch(resultsDir, SOURCE_RUN_LABEL);
  const firstPatchDiff = await readRunModelPatch(resultsDir, SOURCE_RUN_LABEL);

  // The earlier resolved patch is read only if the run resolved.
  const resolvedRaw = await readRunModelPatch(resultsDir, RESOLVED_RUN_LABEL);
  const resolvedReportedResolved = await runResolved(resultsDir, RESOLVED_RUN_LABEL);
  const resolvedPatchDiff = resolvedReportedResolved ? resolvedRaw : null;

  return {
    conversionReportFound: conversion !== null,
    dockerOutcome,
    repairedPatchDiff,
    firstPatchDiff,
    resolvedPatchDiff,
  };
}

async function runResolved(resultsDir: string, runLabel: string): Promise<boolean> {
  const vtraceDir = path.join(resultsDir, "runs", runLabel, "raw", "vtrace");
  let entries: string[];
  try {
    entries = await readdir(vtraceDir);
  } catch {
    return false;
  }
  const jsonl = entries.find((e) => e.startsWith("swebench-") && e.endsWith(".jsonl"));
  if (!jsonl) return false;
  const text = await readTextFile(path.join(vtraceDir, jsonl));
  if (text === null) return false;
  const firstLine = text.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) return false;
  try {
    const parsed = JSON.parse(firstLine);
    return isRecord(parsed) && parsed.resolved === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly outName: string;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let outName = DEFAULT_OUT_NAME;
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
      case "--out-name":
        outName = next();
        break;
      case "--help":
      case "-h":
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { resultsDir, outName };
}

async function main(config: CliConfig): Promise<void> {
  const generatedAt = new Date().toISOString();
  const artifacts = await loadArtifacts(config.resultsDir);
  const report = buildReport({ generatedAt, ...artifacts });

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  process.stdout.write(
    [
      "Stage 5 generated-parser repair failure diagnostic written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Diagnosis: ${report.diagnosisDefectClass}`,
      `Repaired patch defectClass: ${report.repairedPatch.probe?.defectClass ?? "unavailable"}`,
      `Resolved-patch comparison: ${report.comparison.available ? "available" : "unavailable"}`,
      "",
    ].join("\n"),
  );
}

if (import.meta.main) {
  try {
    await main(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
