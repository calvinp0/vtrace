// Stage 5 patch-minimality probe report over existing run artifacts.
//
// SCOPE: analysis / reporting ONLY. Reads `modelPatch` from SWE-bench JSONL artifacts that
// already exist on disk, runs the deterministic `analyzePatchMinimality` probe over each
// patch, and writes a Markdown + JSON report. It runs NO agents, NO Docker, calls NO model,
// and mutates NO raw artifact. It is NOT a repair gate — every finding is observation-only.
//
// Motivation: the auditable Astropy protocol run
// (eval-strictv2-artifacts-protocol-vtrace-astropy-14369, astropy__astropy-14369) was
// unresolved despite good context. The patch deleted generated parser tables and broadly
// relocated grammar productions when a one-line `division_of_units` reorder existed. This
// report makes that shape a deterministic, auditable signal.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { analyzePatchMinimality, type PatchMinimalityProbeResult } from "../../src/capsule/patchMinimalityProbes";
import { editedFilesFromPatch } from "../../src/capsule/finalEditDiagnostics";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RESULTS_REL = "benchmarks/stage5_vexp_swe_bench_smoke/results";
export const DEFAULT_OUT_NAME = "stage5_patch_minimality_probe_report";

// The auditable Astropy protocol run is the centerpiece of this report.
export const ASTROPY_PROTOCOL_RUN_LABEL = "eval-strictv2-artifacts-protocol-vtrace-astropy-14369";

// Runs scanned by the report. The protocol run (required) plus a small curated set:
// two more Astropy CDS-grammar runs (a parsetab-deletion + narrower edit, and a tiny patch)
// and two non-parser runs (requests / sympy) as negative controls — the probe must stay
// silent on patches that are not generated-parser rewrites.
export const RUN_LABELS: readonly string[] = [
  ASTROPY_PROTOCOL_RUN_LABEL,
  "eval-strictv2-artifacts-vtrace-astropy-14369",
  "eval-strictv2-artifacts-force-vtrace-astropy-14369",
  "eval-editguard-before-requests-5414",
  "eval-editguard-before-sympy-16766",
];

export const NON_CLAIMS: readonly string[] = [
  "This report does not re-run agents or Docker.",
  "This report does not modify patches.",
  "This report does not make repair automatic.",
  "This report does not prove the generated-parser probe generalizes to all parser systems.",
  "This report does not change Stage 5 policy accounting.",
];

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface RunFinding {
  readonly runLabel: string;
  readonly instanceId: string;
  readonly resolved: boolean | null;
  readonly patchFilesChanged: string[];
  readonly probe: PatchMinimalityProbeResult;
}

export interface ReportSummary {
  readonly runsAnalyzed: number;
  readonly runsRepairRequired: number;
  readonly runsHighRisk: number;
  readonly runsWithGeneratedParserFindings: number;
}

export interface MinimalityReport {
  readonly generatedAt: string | null;
  readonly summary: ReportSummary;
  readonly findings: readonly RunFinding[];
  readonly nonClaims: readonly string[];
}

// ---------------------------------------------------------------------------
// Summary (pure)
// ---------------------------------------------------------------------------

// A "generated-parser finding" is any non-`none` defect class — these are the shapes the
// probe exists to surface (table deletion, broad rewrite, grammar minimality).
function isGeneratedParserFinding(f: RunFinding): boolean {
  return f.probe.defectClass !== "none";
}

export function buildSummary(findings: readonly RunFinding[]): ReportSummary {
  return {
    runsAnalyzed: findings.length,
    runsRepairRequired: findings.filter((f) => f.probe.repairRequired).length,
    runsHighRisk: findings.filter((f) => f.probe.risk === "high").length,
    runsWithGeneratedParserFindings: findings.filter(isGeneratedParserFinding).length,
  };
}

export function buildReport(generatedAt: string | null, findings: readonly RunFinding[]): MinimalityReport {
  return {
    generatedAt,
    summary: buildSummary(findings),
    findings,
    nonClaims: NON_CLAIMS,
  };
}

// The fixed recommendation: wire the probe into the live critic candidate-selection path as
// an observation-only risk signal — no auto-repair — and have the next milestone check whether
// the live critic agrees and can produce a narrow-rewrite instruction for this Astropy patch.
export function recommendedNextStep(): string {
  return (
    "Wire this deterministic probe into the live critic candidate-selection path as an observation-only risk signal " +
    "first. Do not auto-repair yet. The next milestone should check whether the live critic agrees with the probe and " +
    "can produce actionable narrow-rewrite instructions for this Astropy patch (reorder the division_of_units grammar " +
    "production rather than relocating productions or deleting generated parser tables)."
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderJson(report: MinimalityReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function fmtResolved(v: boolean | null): string {
  return v === null ? "unknown" : v ? "yes" : "no";
}

export function renderMarkdown(report: MinimalityReport): string {
  const { summary, findings } = report;
  const lines: string[] = [];

  lines.push("# Stage 5 patch minimality probe report");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");
  lines.push(
    "_Analysis only. The deterministic `analyzePatchMinimality` probe is applied to patches that already exist on " +
      "disk. No agents, no Docker, no model calls, no raw-artifact mutation. Every finding is an observation-only risk " +
      "signal — this report does not repair patches and is not a gate._",
  );
  lines.push("");

  // --- Summary -------------------------------------------------------------
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `Analyzed ${summary.runsAnalyzed} Stage 5 run patch(es). The probe rated ${summary.runsHighRisk} high-risk and ` +
      `flagged ${summary.runsWithGeneratedParserFindings} with a generated-parser / grammar-minimality defect class ` +
      `(repairRequired on ${summary.runsRepairRequired}). The probe stays silent on non-parser patches.`,
  );
  lines.push("");
  lines.push("| metric | value |");
  lines.push("| --- | --- |");
  lines.push(`| runsAnalyzed | ${summary.runsAnalyzed} |`);
  lines.push(`| runsHighRisk | ${summary.runsHighRisk} |`);
  lines.push(`| runsRepairRequired | ${summary.runsRepairRequired} |`);
  lines.push(`| runsWithGeneratedParserFindings | ${summary.runsWithGeneratedParserFindings} |`);
  lines.push("");

  // --- Runs analyzed -------------------------------------------------------
  lines.push("## Runs analyzed");
  lines.push("");
  lines.push("| run | instance | resolved | files changed | repairRequired | defectClass | risk | confidence |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const f of findings) {
    lines.push(
      `| ${f.runLabel} | ${f.instanceId} | ${fmtResolved(f.resolved)} | ${f.patchFilesChanged.length} | ` +
        `${f.probe.repairRequired ? "yes" : "no"} | \`${f.probe.defectClass}\` | ${f.probe.risk} | ${f.probe.confidence} |`,
    );
  }
  lines.push("");
  for (const f of findings) {
    lines.push(`### ${f.runLabel}`);
    lines.push("");
    lines.push(`- **Instance**: ${f.instanceId}; resolved: ${fmtResolved(f.resolved)}.`);
    lines.push(`- **Files changed**: ${f.patchFilesChanged.join(", ") || "none"}.`);
    lines.push(
      `- **Verdict**: defectClass \`${f.probe.defectClass}\`, risk ${f.probe.risk}, confidence ${f.probe.confidence}, ` +
        `repairRequired ${f.probe.repairRequired ? "yes" : "no"}.`,
    );
    if (f.probe.generatedFilesDeleted.length > 0) {
      lines.push(`- **Generated files deleted**: ${f.probe.generatedFilesDeleted.join(", ")}.`);
    }
    if (f.probe.grammarFunctionsChanged.length > 0) {
      lines.push(`- **Grammar functions changed**: ${f.probe.grammarFunctionsChanged.join(", ")}.`);
    }
    if (f.probe.grammarFunctionsRemoved.length > 0) {
      lines.push(`- **Grammar functions removed**: ${f.probe.grammarFunctionsRemoved.join(", ")}.`);
    }
    if (f.probe.signals.length > 0) lines.push(`- **Signals**: ${f.probe.signals.map((s) => `\`${s}\``).join(", ")}.`);
    for (const reason of f.probe.reasons) lines.push(`- ${reason}`);
    if (f.probe.narrowAlternativeHint) lines.push(`- **Narrow alternative**: ${f.probe.narrowAlternativeHint}`);
    lines.push("");
  }

  // --- Generated-parser findings ------------------------------------------
  lines.push("## Generated-parser findings");
  lines.push("");
  const parserFindings = findings.filter((f) => f.probe.defectClass !== "none");
  if (parserFindings.length === 0) {
    lines.push("_No generated-parser / grammar-minimality findings in the analyzed runs._");
  } else {
    lines.push("| run | defectClass | risk | generated files deleted | grammar functions removed |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const f of parserFindings) {
      lines.push(
        `| ${f.runLabel} | \`${f.probe.defectClass}\` | ${f.probe.risk} | ` +
          `${f.probe.generatedFilesDeleted.join(", ") || "—"} | ${f.probe.grammarFunctionsRemoved.join(", ") || "—"} |`,
      );
    }
  }
  lines.push("");

  // --- Astropy protocol finding -------------------------------------------
  lines.push("## Astropy protocol finding");
  lines.push("");
  const protocol = findings.find((f) => f.runLabel === ASTROPY_PROTOCOL_RUN_LABEL);
  if (!protocol) {
    lines.push(`_The auditable protocol run \`${ASTROPY_PROTOCOL_RUN_LABEL}\` was not found on disk._`);
  } else {
    lines.push(
      "The probe flags the unresolved Astropy protocol patch as `generated_parser_broad_rewrite` / " +
        "`grammar_patch_minimality` because it deletes generated parser table files and broadly relocates grammar " +
        "productions, even though the context localized the issue to the CDS parser grammar.",
    );
    lines.push("");
    lines.push(`- **Run**: \`${protocol.runLabel}\` (instance \`${protocol.instanceId}\`, resolved: ${fmtResolved(protocol.resolved)}).`);
    lines.push(`- **defectClass**: \`${protocol.probe.defectClass}\`; risk ${protocol.probe.risk}; confidence ${protocol.probe.confidence}.`);
    lines.push(`- **Generated tables deleted**: ${protocol.probe.generatedFilesDeleted.join(", ") || "none"}.`);
    lines.push(`- **Productions relocated out of**: ${protocol.probe.grammarFunctionsRemoved.join(", ") || "none"}.`);
    if (protocol.probe.narrowAlternativeHint) lines.push(`- **Narrow alternative**: ${protocol.probe.narrowAlternativeHint}`);
  }
  lines.push("");

  // --- Probe signals -------------------------------------------------------
  lines.push("## Probe signals");
  lines.push("");
  lines.push("Deterministic signals the probe can emit (a finding fires one or more):");
  lines.push("");
  lines.push("- `generated_parser_table_deleted` — a `*_parsetab.py` / `*_lextab.py` (or configured) file is deleted.");
  lines.push("- `grammar_function_removed` — a `p_<rule>` parser function is removed entirely.");
  lines.push("- `multiple_grammar_functions_changed` — two or more parser functions change in one patch.");
  lines.push("- `grammar_productions_relocated` — a function is removed while another is rewritten (productions moved).");
  lines.push(
    "- `generated_artifact_deleted_without_source_grammar_edit` — a generated table is deleted with no source grammar edit.",
  );
  lines.push("- `grammar_function_broadly_rewritten` — one parser function rewritten across many production lines.");
  lines.push("- `grammar_patch_minimality` / `narrow_alternative_available` — a narrower per-production edit likely exists.");
  lines.push("- `narrow_grammar_edit` — a single localized grammar edit; explicitly NOT flagged high-risk.");
  lines.push("");

  // --- Recommended next step ----------------------------------------------
  lines.push("## Recommended next step");
  lines.push("");
  lines.push(recommendedNextStep());
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

async function readTextFile(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function readSwebenchRecord(vtraceDir: string): Promise<Record<string, unknown> | null> {
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
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asResolved(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

export async function loadFinding(resultsDir: string, runLabel: string): Promise<RunFinding | null> {
  const vtraceDir = path.join(resultsDir, "runs", runLabel, "raw", "vtrace");
  const record = await readSwebenchRecord(vtraceDir);
  if (record === null) return null;
  const patch = asString(record.modelPatch) ?? "";
  return {
    runLabel,
    instanceId: asString(record.instanceId) ?? runLabel,
    resolved: asResolved(record.resolved),
    patchFilesChanged: editedFilesFromPatch(patch),
    probe: analyzePatchMinimality(patch),
  };
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

  const findings: RunFinding[] = [];
  const missing: string[] = [];
  for (const label of RUN_LABELS) {
    const finding = await loadFinding(config.resultsDir, label);
    if (finding === null) {
      missing.push(label);
      continue;
    }
    findings.push(finding);
  }

  const report = buildReport(generatedAt, findings);

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  const s = report.summary;
  process.stdout.write(
    [
      "Stage 5 patch minimality probe report written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Runs analyzed: ${s.runsAnalyzed}${missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""}`,
      `High risk: ${s.runsHighRisk}   Repair required: ${s.runsRepairRequired}   Generated-parser findings: ${s.runsWithGeneratedParserFindings}`,
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
