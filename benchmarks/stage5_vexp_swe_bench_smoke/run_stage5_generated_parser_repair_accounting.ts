// Stage 5 GENERATED-PARSER repair ACCOUNTING row. READ-ONLY, single-instance.
//
// SCOPE: accounting/reporting only. This runner reads the already-generated, Docker-verified
// generated-parser repair CONVERSION report (stage5_generated_parser_repair_conversion_shape_gate.json)
// and records it as ONE explicit, separately-labelled Stage 5 accounting row:
//
//   single_instance_verified_generated_parser_repair_astropy
//
// It records the conversion as VERIFIED SINGLE-INSTANCE generated-parser repair evidence. It does
// NOT merge the result into any existing aggregate policy row, does NOT recompute aggregate scores,
// and explicitly emits aggregateComparable=false: the row is not directly comparable to
// strict_vtrace_first_patch (or any 10-task aggregate) unless a comparable row lineage is defined.
//
// It RE-RUNS nothing: no agent, no live critic, no repair, no Docker, no model. It reads exactly one
// committed JSON evidence file and writes its own row JSON+MD. It mutates NO existing aggregate row
// and NO raw artifact, and changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD /
// PATCH_VERIFY / probe / critic / repair / evaluator / telemetry / policy-accounting behavior.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { RESULTS_REL } from "./run_stage5_patch_probe_report";

export const DEFAULT_OUT_NAME = "stage5_generated_parser_repair_accounting";
// The Docker-verified conversion evidence this row is derived from (committed in 87d42fc).
export const DEFAULT_CONVERSION_REPORT_NAME = "stage5_generated_parser_repair_conversion_shape_gate";
// The explicit, separately-labelled accounting row name. Deliberately NOT one of the aggregate
// policy rows (baseline / old_vtrace_* / strict_vtrace_*) so it can never be confused for one.
export const ACCOUNTING_ROW_NAME = "single_instance_verified_generated_parser_repair_astropy";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly conversionReportName: string;
  readonly outName: string;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let conversionReportName = DEFAULT_CONVERSION_REPORT_NAME;
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
      case "--conversion-report":
        conversionReportName = next();
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
  return { resultsDir, conversionReportName, outName };
}

// ---------------------------------------------------------------------------
// Input model — the shape-gated conversion report (read-only).
// ---------------------------------------------------------------------------

// The subset of the conversion report this accounting row consumes. Every field is optional on the
// wire and degrades to null/[]/false so a malformed or partial report is handled without throwing.
export interface ConversionReportDoc {
  readonly sourceRunLabel?: string;
  readonly repairOutName?: string;
  readonly instanceId?: string;
  readonly sourcePatchResolved?: boolean | null;
  readonly repairedPatchResolved?: boolean | null;
  readonly convertedUnresolvedToResolved?: boolean;
  readonly criticCostUsd?: number | null;
  readonly repairCostUsd?: number | null;
  readonly totalRecoveryCostUsd?: number | null;
  readonly repairCostCapUsd?: number | null;
  readonly repairCostExceededCap?: boolean;
  readonly generatedParserRepairShapeAccepted?: boolean | null;
  readonly generatedParserTablesUpdatedByRepair?: readonly string[] | null;
  readonly generatedParserTablesDeletedByRepair?: boolean | null;
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Accounting row (pure). Required fields are TOP-LEVEL for unambiguous downstream reads.
// ---------------------------------------------------------------------------

export interface GeneratedParserRepairAccountingRow {
  // Explicit, separately-labelled row name. Never an aggregate policy row.
  readonly rowName: string;
  // ---- required fields ----
  readonly sourceRunLabel: string;
  readonly repairOutName: string;
  readonly instanceId: string;
  readonly sourcePatchResolved: boolean | null;
  readonly repairedPatchResolved: boolean | null;
  readonly convertedUnresolvedToResolved: boolean;
  readonly criticCostUsd: number | null;
  readonly repairCostUsd: number | null;
  readonly totalRecoveryCostUsd: number | null;
  readonly repairCostCapUsd: number | null;
  readonly repairCostExceededCap: boolean;
  readonly generatedParserRepairShapeAccepted: boolean | null;
  readonly generatedParserTablesUpdatedByRepair: readonly string[];
  readonly generatedParserTablesDeletedByRepair: boolean;
  // This report DID add a (separate, labelled) accounting row.
  readonly policyAccountingUpdated: true;
  // The row is single-instance evidence; it is NOT a comparable aggregate score.
  readonly aggregateComparable: false;
  // ---- explicit lineage / limitation statements ----
  readonly lineageLimitations: readonly string[];
  readonly interpretation: string;
  readonly costCapFollowUp: string;
  readonly nonClaims: readonly string[];
}

export interface GeneratedParserRepairAccountingReport {
  readonly generatedAt: string | null;
  // The source evidence file this row was derived from (provenance).
  readonly conversionReportName: string;
  readonly headline: string;
  // The single explicit accounting row (kept entirely separate from aggregate policy rows).
  readonly row: GeneratedParserRepairAccountingRow;
}

// The exact lineage / limitation statements the milestone requires the row to carry.
export const LINEAGE_LIMITATIONS: readonly string[] = [
  "This is single-instance generated-parser repair evidence.",
  "It is not a full 10-task aggregate.",
  "It is not directly comparable to strict_vtrace_first_patch unless the lineage is explicitly normalized.",
];

// The exact interpretation sentence the milestone requires.
export const REQUIRED_INTERPRETATION =
  "The shape-gated generated-parser repair converted astropy__astropy-14369 from unresolved to resolved under Docker. " +
  "This is verified single-instance repair-conversion evidence. It should not be counted as a new aggregate Stage 5 score " +
  "until a comparable row lineage is defined. The repair also exceeded the configured repair cost cap, so broader " +
  "generated-parser repair usage should wait for a separate cost-cap enforcement audit.";

// The recommended cost-cap audit follow-up item. The concrete $ figures are filled from the row.
export function buildCostCapFollowUp(repairCostUsd: number | null, repairCostCapUsd: number | null): string {
  const cost = repairCostUsd === null ? "unknown" : `$${repairCostUsd.toFixed(4)}`;
  const cap = repairCostCapUsd === null ? "unknown" : `$${repairCostCapUsd.toFixed(4)}`;
  return (
    "Audit repair cost-cap enforcement before enabling broader generated-parser repair usage. " +
    `The accepted repair call recorded repairCostUsd=${cost} despite repairCostCapUsd=${cap}.`
  );
}

export function buildNonClaims(): readonly string[] {
  return [
    "Single-instance evidence only; this is NOT a full 10-task aggregate and does NOT prove aggregate improvement.",
    "aggregateComparable=false: this row is NOT directly comparable to strict_vtrace_first_patch (or any aggregate policy row) until a comparable row lineage is explicitly normalized.",
    "No existing aggregate Stage 5 policy row was mutated, merged into, or recomputed by this report; this is a SEPARATE labelled row.",
    "The conversion result is READ from the committed Docker-verified conversion report; this runs no agent, no live critic, no repair, no Docker, and no model.",
    "The repair exceeded the configured repair cost cap; this report records that fact for a SEPARATE cost-cap enforcement audit and does NOT change cost-cap enforcement.",
    "This changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair / evaluator / telemetry / policy-accounting behavior.",
  ];
}

export function buildAccountingRow(doc: ConversionReportDoc): GeneratedParserRepairAccountingRow {
  const repairCostUsd = doc.repairCostUsd ?? null;
  const repairCostCapUsd = doc.repairCostCapUsd ?? null;
  return {
    rowName: ACCOUNTING_ROW_NAME,
    sourceRunLabel: doc.sourceRunLabel ?? "unknown",
    repairOutName: doc.repairOutName ?? "unknown",
    instanceId: doc.instanceId ?? "unknown",
    sourcePatchResolved: doc.sourcePatchResolved ?? null,
    repairedPatchResolved: doc.repairedPatchResolved ?? null,
    convertedUnresolvedToResolved: doc.convertedUnresolvedToResolved === true,
    criticCostUsd: doc.criticCostUsd ?? null,
    repairCostUsd,
    totalRecoveryCostUsd: doc.totalRecoveryCostUsd ?? null,
    repairCostCapUsd,
    repairCostExceededCap: doc.repairCostExceededCap === true,
    generatedParserRepairShapeAccepted: doc.generatedParserRepairShapeAccepted ?? null,
    generatedParserTablesUpdatedByRepair: doc.generatedParserTablesUpdatedByRepair ?? [],
    generatedParserTablesDeletedByRepair: doc.generatedParserTablesDeletedByRepair === true,
    policyAccountingUpdated: true,
    aggregateComparable: false,
    lineageLimitations: LINEAGE_LIMITATIONS,
    interpretation: REQUIRED_INTERPRETATION,
    costCapFollowUp: buildCostCapFollowUp(repairCostUsd, repairCostCapUsd),
    nonClaims: buildNonClaims(),
  };
}

export function buildReport(args: {
  readonly generatedAt: string | null;
  readonly conversionReportName: string;
  readonly doc: ConversionReportDoc;
}): GeneratedParserRepairAccountingReport {
  const row = buildAccountingRow(args.doc);
  const headline = row.convertedUnresolvedToResolved
    ? `Recorded single-instance verified generated-parser repair conversion for ${row.instanceId} as row \`${row.rowName}\` (aggregateComparable=false).`
    : `Recorded generated-parser repair accounting row \`${row.rowName}\` for ${row.instanceId}; no verified conversion (aggregateComparable=false).`;
  return {
    generatedAt: args.generatedAt,
    conversionReportName: args.conversionReportName,
    headline,
    row,
  };
}

// ---------------------------------------------------------------------------
// Render (pure)
// ---------------------------------------------------------------------------

export function renderJson(report: GeneratedParserRepairAccountingReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function tri(value: boolean | null): string {
  return value === null ? "unknown" : value ? "true" : "false";
}

function usd(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

export function renderMarkdown(report: GeneratedParserRepairAccountingReport): string {
  const { row } = report;
  const L: string[] = [];

  L.push("# Stage 5 generated-parser repair accounting (single-instance, labelled)");
  L.push("");
  if (report.generatedAt) L.push(`_Generated: ${report.generatedAt}_`, "");
  L.push(
    "_Accounting/reporting only. Reads the committed Docker-verified generated-parser repair conversion " +
      `report (\`${report.conversionReportName}.json\`) and records ONE explicit, separately-labelled row. ` +
      "Mutates no existing aggregate row and no raw artifact; runs no agent / critic / repair / Docker / model._",
  );
  L.push("");

  L.push("## Summary");
  L.push("");
  L.push(report.headline);
  L.push("");

  L.push(`## Accounting row: \`${row.rowName}\``);
  L.push("");
  for (const limitation of row.lineageLimitations) L.push(`- ${limitation}`);
  L.push("");

  L.push("| field | value |");
  L.push("| --- | --- |");
  L.push(`| sourceRunLabel | \`${row.sourceRunLabel}\` |`);
  L.push(`| repairOutName | ${row.repairOutName} |`);
  L.push(`| instanceId | ${row.instanceId} |`);
  L.push(`| sourcePatchResolved | ${tri(row.sourcePatchResolved)} |`);
  L.push(`| repairedPatchResolved | ${tri(row.repairedPatchResolved)} |`);
  L.push(`| convertedUnresolvedToResolved | ${tri(row.convertedUnresolvedToResolved)} |`);
  L.push(`| criticCostUsd | ${usd(row.criticCostUsd)} |`);
  L.push(`| repairCostUsd | ${usd(row.repairCostUsd)} |`);
  L.push(`| totalRecoveryCostUsd | ${usd(row.totalRecoveryCostUsd)} |`);
  L.push(`| repairCostCapUsd | ${usd(row.repairCostCapUsd)} |`);
  L.push(`| repairCostExceededCap | ${row.repairCostExceededCap} |`);
  L.push(`| generatedParserRepairShapeAccepted | ${tri(row.generatedParserRepairShapeAccepted)} |`);
  L.push(`| generatedParserTablesUpdatedByRepair | ${row.generatedParserTablesUpdatedByRepair.join(", ") || "—"} |`);
  L.push(`| generatedParserTablesDeletedByRepair | ${row.generatedParserTablesDeletedByRepair} |`);
  L.push(`| policyAccountingUpdated | ${row.policyAccountingUpdated} |`);
  L.push(`| aggregateComparable | ${row.aggregateComparable} |`);
  L.push("");

  L.push("## Interpretation");
  L.push("");
  L.push(row.interpretation);
  L.push("");

  L.push("## Aggregate-comparability boundary");
  L.push("");
  L.push(
    "This row is **single-instance** verified generated-parser repair-conversion evidence. It is NOT a full " +
      "10-task aggregate and is recorded with `aggregateComparable=false`. It must not be counted as a new " +
      "aggregate Stage 5 score, and is not directly comparable to `strict_vtrace_first_patch` (or any aggregate " +
      "policy row) until a comparable row lineage is explicitly normalized. No existing aggregate row was mutated.",
  );
  L.push("");

  L.push("## Cost-cap follow-up");
  L.push("");
  L.push(`- ${row.costCapFollowUp}`);
  L.push("");
  L.push(
    "This is a recommended follow-up audit item only. This report records the cost-cap exceedance but does NOT " +
      "change cost-cap enforcement; broader generated-parser repair usage should wait for that separate audit.",
  );
  L.push("");

  L.push("## Non-claims");
  L.push("");
  for (const n of row.nonClaims) L.push(`- ${n}`);
  L.push("");

  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main (impure). One read-only JSON load; writes its own row JSON+MD only.
// ---------------------------------------------------------------------------

export async function run(config: CliConfig): Promise<GeneratedParserRepairAccountingReport> {
  const generatedAt = new Date().toISOString();
  const conversionPath = path.join(config.resultsDir, `${config.conversionReportName}.json`);
  const doc = await readJson<ConversionReportDoc>(conversionPath);
  if (doc === null) {
    throw new Error(
      `No generated-parser conversion report at ${conversionPath}; nothing to account for. ` +
        "Generate it first via run_stage5_generated_parser_repaired_patch_eval (Docker-verified).",
    );
  }

  const report = buildReport({ generatedAt, conversionReportName: config.conversionReportName, doc });

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  process.stdout.write(
    [
      "Stage 5 generated-parser repair accounting row written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `row: ${report.row.rowName}`,
      `instance: ${report.row.instanceId}`,
      `convertedUnresolvedToResolved=${tri(report.row.convertedUnresolvedToResolved)}  shapeAccepted=${tri(report.row.generatedParserRepairShapeAccepted)}`,
      `recovery cost=${usd(report.row.totalRecoveryCostUsd)} (critic ${usd(report.row.criticCostUsd)} + repair ${usd(report.row.repairCostUsd)})`,
      `repairCostExceededCap=${report.row.repairCostExceededCap}  policyAccountingUpdated=${report.row.policyAccountingUpdated}  aggregateComparable=${report.row.aggregateComparable}`,
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
