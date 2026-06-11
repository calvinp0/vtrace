// Stage 5 repair COST-CAP AUDIT report. READ-ONLY.
//
// SCOPE: audit/reporting only. This runner reads the committed historical generated-parser repair
// CONVERSION evidence (stage5_generated_parser_repair_conversion_shape_gate.json) — which recorded a
// repair call that EXCEEDED its configured cap — and documents:
//   - the historical over-cap repair (the fact, with figures),
//   - the EXISTING (pre-fix) cost-cap enforcement behavior (pre-call cumulative-only; a single call
//     was never bounded), and
//   - the FIX now in run_stage5_patch_repair.ts: pre-call ESTIMATED-MAX enforcement that refuses a
//     call whose estimated worst-case would not fit the remaining cap, plus the honest
//     cumulative-only fallback labelling (singleCallMayExceedCap).
//
// It RE-RUNS nothing: no agent, no live critic, no repair, no Docker, no model. It reads committed
// JSON and writes its own audit JSON+MD. It mutates NO existing aggregate/accounting row, does NOT
// recompute the generated-parser conversion row, and changes no retrieval / Capsule v2 / PIVOT_CHECK
// / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair / evaluator / telemetry / policy-accounting
// behavior.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { RESULTS_REL } from "./run_stage5_patch_probe_report";
import {
  type RepairCostCapEnforcementMode,
  DEFAULT_REPAIR_COST_CAP_USD,
  DEFAULT_REPAIR_ESTIMATED_MAX_CALL_COST_USD,
  repairCostCapEnforcementMode,
  singleCallMayExceedCap,
} from "./run_stage5_patch_repair";

export const DEFAULT_OUT_NAME = "stage5_repair_cost_cap_audit";
// The committed historical conversion evidence that recorded the over-cap repair call.
export const DEFAULT_CONVERSION_REPORT_NAME = "stage5_generated_parser_repair_conversion_shape_gate";

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
// Input model — the historical conversion evidence (read-only, fail-soft).
// ---------------------------------------------------------------------------

export interface ConversionEvidenceDoc {
  readonly instanceId?: string;
  readonly sourceRunLabel?: string;
  readonly convertedUnresolvedToResolved?: boolean;
  readonly criticCostUsd?: number | null;
  readonly repairCostUsd?: number | null;
  readonly totalRecoveryCostUsd?: number | null;
  readonly repairCostCapUsd?: number | null;
  readonly repairCostExceededCap?: boolean;
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Audit report (pure)
// ---------------------------------------------------------------------------

export const AUDIT_HEADLINE =
  "The accepted generated-parser repair conversion exceeded the configured repair cap. This audit clarifies/fixes the cap semantics before broader repair use.";

export const ROOT_CAUSE =
  "The pre-fix cost cap was checked ONLY against accumulated PRIOR cost before each call " +
  "(`totalRepairCostUsd >= cap`). With maxRepairRuns=1 the first/only repair call sees prior " +
  "cumulative $0.0000 < cap, so it always proceeded; its ACTUAL cost was added only AFTER the call. " +
  "A single call was therefore never bounded by the cap — so a $2.8185 call ran under a $0.4000 cap.";

// The required non-claims, verbatim.
export const AUDIT_NON_CLAIMS: readonly string[] = [
  "This audit does not run repair, live critic, agents, or Docker.",
  "This audit does not change the generated-parser conversion result.",
  "This audit does not add new policy accounting rows.",
  "This audit does not enable broader generated-parser repair usage by itself.",
];

export interface HistoricalOverCapRepair {
  readonly instanceId: string | null;
  readonly sourceRunLabel: string | null;
  readonly convertedUnresolvedToResolved: boolean | null;
  readonly repairCostUsd: number | null;
  readonly repairCostCapUsd: number | null;
  readonly repairCostExceededCap: boolean | null;
  readonly totalRecoveryCostUsd: number | null;
  // Whether the committed evidence file was found (false ⇒ figures are null but the audit still emits).
  readonly evidenceFound: boolean;
}

export interface EnforcementSemantics {
  readonly enforcementMode: RepairCostCapEnforcementMode;
  readonly singleCallMayExceedCap: boolean;
  readonly description: string;
}

export interface CostCapAuditReport {
  readonly generatedAt: string | null;
  readonly conversionReportName: string;
  readonly headline: string;
  readonly rootCause: string;
  readonly historicalOverCapRepair: HistoricalOverCapRepair;
  // The EXISTING (pre-fix) behavior that allowed the overrun.
  readonly existingEnforcement: EnforcementSemantics;
  // The FIXED / clarified semantics now implemented in the repair runner.
  readonly fixedEnforcement: EnforcementSemantics & {
    readonly defaultRepairCostCapUsd: number;
    readonly defaultRepairEstimatedMaxCallCostUsd: number;
    // The required repair-report field names the runner now emits.
    readonly reportedFields: readonly string[];
  };
  readonly generatedParserRepairImplications: readonly string[];
  readonly recommendedNextStep: string;
  // This audit changes NO accounting/conversion row.
  readonly policyAccountingUpdated: false;
  readonly conversionResultChanged: false;
  readonly nonClaims: readonly string[];
}

export function buildAuditReport(args: {
  readonly generatedAt: string | null;
  readonly conversionReportName: string;
  readonly evidence: ConversionEvidenceDoc | null;
}): CostCapAuditReport {
  const { generatedAt, conversionReportName, evidence } = args;
  const historicalOverCapRepair: HistoricalOverCapRepair = {
    instanceId: evidence?.instanceId ?? null,
    sourceRunLabel: evidence?.sourceRunLabel ?? null,
    convertedUnresolvedToResolved: evidence?.convertedUnresolvedToResolved ?? null,
    repairCostUsd: evidence?.repairCostUsd ?? null,
    repairCostCapUsd: evidence?.repairCostCapUsd ?? null,
    repairCostExceededCap: evidence?.repairCostExceededCap ?? null,
    totalRecoveryCostUsd: evidence?.totalRecoveryCostUsd ?? null,
    evidenceFound: evidence !== null,
  };

  const existingMode = repairCostCapEnforcementMode(null);
  const fixedMode = repairCostCapEnforcementMode(DEFAULT_REPAIR_ESTIMATED_MAX_CALL_COST_USD);

  return {
    generatedAt,
    conversionReportName,
    headline: AUDIT_HEADLINE,
    rootCause: ROOT_CAUSE,
    historicalOverCapRepair,
    existingEnforcement: {
      enforcementMode: existingMode,
      singleCallMayExceedCap: singleCallMayExceedCap(existingMode),
      description:
        "Pre-call CUMULATIVE-ONLY: the cap is checked against accumulated PRIOR cost only. The first " +
        "call (prior $0.0000) is never bounded, so a single call can exceed the cap. This is honest only " +
        "as a cumulative bound across MULTIPLE calls; it cannot bound one call.",
    },
    fixedEnforcement: {
      enforcementMode: fixedMode,
      singleCallMayExceedCap: singleCallMayExceedCap(fixedMode),
      description:
        "Pre-call ESTIMATED-MAX (now the default): a repair call is permitted ONLY when prior cumulative " +
        "PLUS an estimated worst-case call cost still fits the cap; otherwise the call is skipped with " +
        "repairStoppedByCostCap=true. An allowed call cannot push cumulative past the cap to the accuracy " +
        "of the estimate. The `claude -p` caller passes no max-output-tokens budget, so the bound is the " +
        "estimate, not a hard model-API limit; when no estimate is configured the runner falls back to the " +
        "honest cumulative-only mode and flags singleCallMayExceedCap=true.",
      defaultRepairCostCapUsd: DEFAULT_REPAIR_COST_CAP_USD,
      defaultRepairEstimatedMaxCallCostUsd: DEFAULT_REPAIR_ESTIMATED_MAX_CALL_COST_USD,
      reportedFields: [
        "repairCostCapUsd",
        "repairCostCapEnforcementMode",
        "repairPreCallCumulativeCostUsd",
        "repairEstimatedMaxCallCostUsd",
        "repairActualCostUsd",
        "repairExceededCap",
        "repairStoppedByCostCap",
        "singleCallMayExceedCap",
      ],
    },
    generatedParserRepairImplications: [
      "Generated-parser LIVE repair remains gated, unchanged, by ALL of: --enable-patch-repair, --allow-generated-parser-repair, an explicit --run-label, a valid live critic, deterministic/live agreement, actionable narrow-rewrite guidance, max-repair-runs, and the cost cap.",
      "Generated-parser defect classes are STILL NOT in DEFAULT_ALLOWED_DEFECT_CLASSES; the cap fix loosens no gate.",
      "Under the fixed default (cap $" +
        DEFAULT_REPAIR_COST_CAP_USD.toFixed(2) +
        ", estimated worst-case call $" +
        DEFAULT_REPAIR_ESTIMATED_MAX_CALL_COST_USD.toFixed(2) +
        ") a generated-parser repair call is REFUSED pre-call unless the operator raises the cap above the estimate (or supplies a tighter, justified estimate), so the historical over-cap call could not recur silently.",
    ],
    recommendedNextStep:
      "Keep generated-parser repair OFF by default. Before any broader generated-parser repair usage, set " +
      "--repair-cost-cap-usd and --repair-estimated-max-call-cost-usd to values that make the estimated " +
      "worst-case call fit the cap, confirm the repair report shows repairCostCapEnforcementMode=" +
      "pre_call_estimated_max with singleCallMayExceedCap=false, and only then widen usage. Do NOT recompute " +
      "the historical conversion row; leave its over-cap caveat as historical evidence.",
    policyAccountingUpdated: false,
    conversionResultChanged: false,
    nonClaims: AUDIT_NON_CLAIMS,
  };
}

// ---------------------------------------------------------------------------
// Render (pure)
// ---------------------------------------------------------------------------

export function renderJson(report: CostCapAuditReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function usd(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

function tri(value: boolean | null): string {
  return value === null ? "unknown" : value ? "true" : "false";
}

export function renderMarkdown(report: CostCapAuditReport): string {
  const h = report.historicalOverCapRepair;
  const L: string[] = [];

  L.push("# Stage 5 repair cost-cap audit");
  L.push("");
  if (report.generatedAt) L.push(`_Generated: ${report.generatedAt}_`, "");
  L.push(
    "_Audit/reporting only. Reads the committed generated-parser repair conversion evidence and documents the " +
      "cost-cap root cause + fix. Runs no agent / critic / repair / Docker / model; mutates no accounting or " +
      "conversion row._",
  );
  L.push("");

  L.push("## Summary");
  L.push("");
  L.push(report.headline);
  L.push("");
  L.push(`Root cause: ${report.rootCause}`);
  L.push("");

  L.push("## Historical over-cap repair");
  L.push("");
  if (!h.evidenceFound) {
    L.push(`_Conversion evidence \`${report.conversionReportName}.json\` not found; figures unavailable._`, "");
  }
  L.push("| field | value |");
  L.push("| --- | --- |");
  L.push(`| instanceId | ${h.instanceId ?? "—"} |`);
  L.push(`| sourceRunLabel | ${h.sourceRunLabel ? `\`${h.sourceRunLabel}\`` : "—"} |`);
  L.push(`| convertedUnresolvedToResolved | ${tri(h.convertedUnresolvedToResolved)} |`);
  L.push(`| repairCostUsd | ${usd(h.repairCostUsd)} |`);
  L.push(`| repairCostCapUsd | ${usd(h.repairCostCapUsd)} |`);
  L.push(`| repairCostExceededCap | ${tri(h.repairCostExceededCap)} |`);
  L.push(`| totalRecoveryCostUsd | ${usd(h.totalRecoveryCostUsd)} |`);
  L.push("");
  L.push(
    `The accepted generated-parser repair recorded repairCostUsd=${usd(h.repairCostUsd)} despite a configured ` +
      `repairCostCapUsd=${usd(h.repairCostCapUsd)} (repairCostExceededCap=${tri(h.repairCostExceededCap)}). The conversion ` +
      "row is left as historical evidence and is NOT recomputed here.",
  );
  L.push("");

  L.push("## Existing enforcement behavior");
  L.push("");
  L.push(`Mode: \`${report.existingEnforcement.enforcementMode}\` (singleCallMayExceedCap=${report.existingEnforcement.singleCallMayExceedCap}).`);
  L.push("");
  L.push(report.existingEnforcement.description);
  L.push("");

  L.push("## Fix or clarified semantics");
  L.push("");
  L.push(`Mode (new default): \`${report.fixedEnforcement.enforcementMode}\` (singleCallMayExceedCap=${report.fixedEnforcement.singleCallMayExceedCap}).`);
  L.push("");
  L.push(report.fixedEnforcement.description);
  L.push("");
  L.push(
    `Defaults: repairCostCapUsd=$${report.fixedEnforcement.defaultRepairCostCapUsd.toFixed(4)}, ` +
      `repairEstimatedMaxCallCostUsd=$${report.fixedEnforcement.defaultRepairEstimatedMaxCallCostUsd.toFixed(4)}.`,
  );
  L.push("");
  L.push("The repair report now records these fields:");
  for (const f of report.fixedEnforcement.reportedFields) L.push(`- \`${f}\``);
  L.push("");

  L.push("## Generated-parser repair implications");
  L.push("");
  for (const line of report.generatedParserRepairImplications) L.push(`- ${line}`);
  L.push("");

  L.push("## Recommended next step");
  L.push("");
  L.push(report.recommendedNextStep);
  L.push("");

  L.push("## Non-claims");
  L.push("");
  for (const n of report.nonClaims) L.push(`- ${n}`);
  L.push("");

  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main (impure). One read-only JSON load; writes its own audit JSON+MD only.
// ---------------------------------------------------------------------------

export async function run(config: CliConfig): Promise<CostCapAuditReport> {
  const generatedAt = new Date().toISOString();
  const conversionPath = path.join(config.resultsDir, `${config.conversionReportName}.json`);
  const evidence = await readJson<ConversionEvidenceDoc>(conversionPath);

  const report = buildAuditReport({ generatedAt, conversionReportName: config.conversionReportName, evidence });

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  process.stdout.write(
    [
      "Stage 5 repair cost-cap audit written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `historical over-cap: ${report.historicalOverCapRepair.instanceId ?? "—"} repairCostUsd=${usd(report.historicalOverCapRepair.repairCostUsd)} cap=${usd(report.historicalOverCapRepair.repairCostCapUsd)} exceeded=${tri(report.historicalOverCapRepair.repairCostExceededCap)}`,
      `existing mode: ${report.existingEnforcement.enforcementMode} (singleCallMayExceedCap=${report.existingEnforcement.singleCallMayExceedCap})`,
      `fixed mode: ${report.fixedEnforcement.enforcementMode} (singleCallMayExceedCap=${report.fixedEnforcement.singleCallMayExceedCap})`,
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
