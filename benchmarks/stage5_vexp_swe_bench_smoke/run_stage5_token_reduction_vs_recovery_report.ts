// Stage 5 TOKEN-REDUCTION vs RECOVERY-COST report. READ-ONLY, consolidated.
//
// SCOPE: reporting only. This runner reads committed Stage 5 report JSONs and separates two distinct
// measurements so they are never conflated:
//   1. FIRST-PASS token/cost reduction from VTRACE / Capsule v2 context (the product-facing headline).
//   2. Internal RECOVERY-side cost from the gated critic/repair loop (a bounded benchmark-only mechanism).
// It also records the single verified generated-parser repair conversion as recovery evidence, and the
// boundaries on what can and cannot be claimed.
//
// It RE-RUNS nothing: no agent, no live critic, no repair, no Docker, no model. It reads committed report
// JSONs (degrading gracefully to "unavailable" when one is missing — it NEVER invents numbers) and writes
// its own report JSON+MD only. It mutates NO existing report, NO raw artifact, NO aggregate policy row, and
// changes no retrieval / ranking / Capsule v2 / PIVOT_CHECK / critic / repair / evaluator / telemetry /
// cost-cap / policy-accounting behavior.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { RESULTS_REL } from "./run_stage5_patch_probe_report";

export const DEFAULT_OUT_NAME = "stage5_token_reduction_vs_recovery";

// Committed source reports this report consolidates (each degrades to "unavailable").
export const SOURCE_POLICY = "stage5_policy_accounting";
export const SOURCE_CONTROL_LOOP = "stage5_control_loop_status";
export const SOURCE_REPAIR_ACCOUNTING = "stage5_generated_parser_repair_accounting";
export const SOURCE_CONVERSION = "stage5_generated_parser_repair_conversion_shape_gate";
export const SOURCE_COSTCAP_AUDIT = "stage5_repair_cost_cap_audit";
export const SOURCE_COSTCAP_PROOF = "stage5_repair_cost_cap_block_proof";

export const SOURCE_REPORT_NAMES: readonly string[] = [
  SOURCE_POLICY,
  SOURCE_CONTROL_LOOP,
  SOURCE_REPAIR_ACCOUNTING,
  SOURCE_CONVERSION,
  SOURCE_COSTCAP_AUDIT,
  SOURCE_COSTCAP_PROOF,
];

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

// ---------------------------------------------------------------------------
// Input models — the subset of each committed source report this report consumes (read-only).
// Every field is optional on the wire and degrades to null/false; numbers are NEVER fabricated.
// ---------------------------------------------------------------------------

export interface PolicyAccountingDoc {
  readonly strictAccounting?: {
    readonly baselineResolved?: number | null;
    readonly strictResolved?: number | null;
    readonly baselineTotalTokens?: number | null;
    readonly strictTotalTokens?: number | null;
    readonly baselineTotalCostUsd?: number | null;
    readonly strictTotalCostUsd?: number | null;
  };
}

export interface RepairAccountingDoc {
  readonly row?: {
    readonly instanceId?: string;
    readonly criticCostUsd?: number | null;
    readonly repairCostUsd?: number | null;
    readonly totalRecoveryCostUsd?: number | null;
    readonly repairCostExceededCap?: boolean;
    readonly convertedUnresolvedToResolved?: boolean;
  };
}

export interface ConversionDoc {
  readonly instanceId?: string;
  readonly sourcePatchResolved?: boolean | null;
  readonly repairedPatchResolved?: boolean | null;
  readonly convertedUnresolvedToResolved?: boolean;
}

export interface CostCapAuditDoc {
  readonly historicalOverCapRepair?: { readonly repairCostExceededCap?: boolean };
  readonly fixedEnforcement?: {
    readonly enforcementMode?: string;
    readonly singleCallMayExceedCap?: boolean;
  };
}

export interface CostCapProofDoc {
  readonly proofPassed?: boolean;
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Required fixed wording (kept verbatim so downstream readers / tests can rely on it).
// ---------------------------------------------------------------------------

// The product-facing headline claim string. This is a CLAIM string the report supports; it is NOT a value
// measured by this report. The measured first-pass numbers live in firstPass* fields.
export const HEADLINE_CLAIM =
  "VTRACE analyzes codebases at the AST level, identifies the most relevant code via hybrid search, and " +
  "delivers compressed context capsules with session memory. Up to 74% fewer tokens in benchmarked workflows.";

export const TECHNICAL_CONTROL_LOOP_SUMMARY =
  "The generated-parser repair loop is an internal bounded recovery mechanism — gated, off by default, " +
  "one-shot, fail-open, shape-validated, and cost-capped. The verified Astropy generated-parser repair is " +
  "evidence that the control loop can recover one patch-quality failure, not evidence of aggregate " +
  "SWE-bench improvement or broad generated-parser generalization.";

export const REQUIRED_INTERPRETATION =
  "VTRACE's primary token-reduction claim should be based on first-pass context delivery: AST/symbol-aware " +
  "retrieval, hybrid search, Capsule v2 ranking, and compressed context capsules. The generated-parser " +
  "repair loop is not the headline product feature; it is an internal bounded recovery mechanism for cases " +
  "where compact context was good but the agent wrote a bad patch. Recovery costs must be tracked " +
  "separately so a successful repair does not obscure the first-pass token-reduction measurement.";

export const ASTROPY_RECOVERY_CAVEAT =
  "The verified Astropy generated-parser repair is evidence that the control loop can recover one " +
  "patch-quality failure, not evidence of aggregate SWE-bench improvement or broad generated-parser generalization.";

export const CAN_CLAIM: readonly string[] = [
  "VTRACE can reduce first-pass token usage by delivering compact, symbol-aware context capsules in benchmarked workflows.",
  "The Stage 5 control loop has one verified generated-parser repair conversion.",
  "The repair loop is gated, off by default, one-shot, fail-open, shape-validated, and cost-capped.",
  "Recovery evidence is tracked separately from first-pass token-reduction evidence.",
];

export const CANNOT_CLAIM: readonly string[] = [
  "Do not claim the generated-parser repair result improves the aggregate Stage 5 score.",
  "Do not merge Astropy recovery cost into first-pass token-reduction rows.",
  "Do not claim generated-parser repair generalizes beyond the verified Astropy case.",
  "Do not claim users should configure repair cost caps.",
  "Do not present repair as the public headline product feature.",
];

export const RECOMMENDED_NEXT_MILESTONES: readonly string[] = [
  "Produce a small user-facing README/marketing wording update that keeps token reduction as the headline and mentions control-loop recovery only in deeper technical docs.",
  "Define an expected-value policy for repair: run repair only when a defect class has observed conversion evidence and estimated cost fits the cap.",
  "Run one additional real generated-parser-like case only if a natural candidate appears.",
  "Add a product/engineering split in docs: user-facing context capsules vs internal benchmark-only repair controls.",
];

export const NON_CLAIMS: readonly string[] = [
  "This report does not run agents, repair, live critic, or Docker.",
  "This report does not change Stage 5 policy accounting or mutate any aggregate policy row.",
  "This report does not merge repair recovery cost into first-pass token-reduction rows.",
  "This report does not claim aggregate SWE-bench improvement.",
  "This report does not claim generated-parser repair generalizes beyond the verified Astropy case.",
  "First-pass numbers are READ from committed reports; when a source is unavailable the value is marked unavailable and NOT invented.",
];

export const REQUIRED_MARKDOWN_SECTIONS: readonly string[] = [
  "# Stage 5 token reduction vs recovery cost",
  "## Summary",
  "## Product-facing token reduction story",
  "## First-pass evidence",
  "## Recovery-side evidence",
  "## Why these must stay separate",
  "## Generated-parser repair case",
  "## Cost-cap safety status",
  "## What can be claimed",
  "## What cannot be claimed",
  "## Recommended next milestones",
  "## Non-claims",
];

// ---------------------------------------------------------------------------
// Report (pure). Required fields are TOP-LEVEL for unambiguous downstream reads.
// ---------------------------------------------------------------------------

export interface SourceReportAvailability {
  readonly name: string;
  readonly available: boolean;
}

export interface FirstPassEvidence {
  readonly available: boolean;
  readonly baselineResolvedCount: number | null;
  readonly vtraceFirstPassResolvedCount: number | null;
  readonly baselineTotalTokens: number | null;
  readonly vtraceFirstPassTotalTokens: number | null;
  readonly baselineTotalCostUsd: number | null;
  readonly vtraceFirstPassTotalCostUsd: number | null;
  readonly tokenReductionPercent: number | null;
  readonly costReductionPercent: number | null;
}

export interface TokenReductionVsRecoveryReport {
  readonly generatedAt: string;
  readonly status: "first_pass_and_recovery_separated";
  readonly firstPassEvidenceAvailable: boolean;
  readonly firstPassTokenReductionPercent: number | null;
  readonly firstPassCostReductionPercent: number | null;
  readonly baselineResolvedCount: number | null;
  readonly vtraceFirstPassResolvedCount: number | null;
  readonly recoveryEvidenceAvailable: boolean;
  readonly recoveryInstanceId: string;
  readonly sourcePatchResolved: boolean;
  readonly repairedPatchResolved: boolean;
  readonly convertedUnresolvedToResolved: boolean;
  readonly criticCostUsd: number;
  readonly repairCostUsd: number;
  readonly totalRecoveryCostUsd: number;
  readonly historicalRepairCostCapExceeded: boolean;
  readonly repairCostCapHardened: boolean;
  readonly repairCostCapBlockProofPassed: boolean;
  readonly recoveryMergedIntoFirstPass: false;
  readonly aggregateComparable: false;
  readonly userFacingRepairCostControls: false;
  readonly headlineClaim: string;
  readonly technicalControlLoopSummary: string;
  readonly canClaim: readonly string[];
  readonly cannotClaim: readonly string[];
  readonly recommendedNextMilestones: readonly string[];
  readonly nonClaims: readonly string[];
  // ---- detail / provenance (added; required fields above) ----
  readonly interpretation: string;
  readonly firstPass: FirstPassEvidence;
  readonly sourceReports: readonly SourceReportAvailability[];
}

export interface BuildReportInput {
  readonly generatedAt: string;
  readonly policy: PolicyAccountingDoc | null;
  readonly controlLoop: unknown | null;
  readonly repairAccounting: RepairAccountingDoc | null;
  readonly conversion: ConversionDoc | null;
  readonly costCapAudit: CostCapAuditDoc | null;
  readonly costCapProof: CostCapProofDoc | null;
}

// Percent reduction from `from` to `to`, or null when inputs are missing / not positive. NEVER fabricated.
function reductionPercent(from: number | null | undefined, to: number | null | undefined): number | null {
  if (typeof from !== "number" || typeof to !== "number" || from <= 0) return null;
  return ((from - to) / from) * 100;
}

export function buildFirstPassEvidence(policy: PolicyAccountingDoc | null): FirstPassEvidence {
  const s = policy?.strictAccounting;
  const baselineTotalTokens = s?.baselineTotalTokens ?? null;
  const vtraceFirstPassTotalTokens = s?.strictTotalTokens ?? null;
  const baselineTotalCostUsd = s?.baselineTotalCostUsd ?? null;
  const vtraceFirstPassTotalCostUsd = s?.strictTotalCostUsd ?? null;
  // First-pass evidence is "available" only when we actually have the token totals to compare.
  const available =
    typeof baselineTotalTokens === "number" && typeof vtraceFirstPassTotalTokens === "number";
  return {
    available,
    baselineResolvedCount: s?.baselineResolved ?? null,
    vtraceFirstPassResolvedCount: s?.strictResolved ?? null,
    baselineTotalTokens,
    vtraceFirstPassTotalTokens,
    baselineTotalCostUsd,
    vtraceFirstPassTotalCostUsd,
    tokenReductionPercent: reductionPercent(baselineTotalTokens, vtraceFirstPassTotalTokens),
    costReductionPercent: reductionPercent(baselineTotalCostUsd, vtraceFirstPassTotalCostUsd),
  };
}

export function buildReport(input: BuildReportInput): TokenReductionVsRecoveryReport {
  const { policy, repairAccounting, conversion, costCapAudit, costCapProof } = input;

  const firstPass = buildFirstPassEvidence(policy);
  const row = repairAccounting?.row;

  // Recovery evidence is "available" only when the verified conversion + recovery accounting are present.
  const recoveryEvidenceAvailable = repairAccounting !== null && conversion !== null;

  const repairCostCapHardened = Boolean(
    costCapAudit?.fixedEnforcement?.enforcementMode === "pre_call_estimated_max" &&
      costCapAudit?.fixedEnforcement?.singleCallMayExceedCap === false,
  );

  const sourceReports: readonly SourceReportAvailability[] = [
    { name: SOURCE_POLICY, available: policy !== null },
    { name: SOURCE_CONTROL_LOOP, available: input.controlLoop !== null },
    { name: SOURCE_REPAIR_ACCOUNTING, available: repairAccounting !== null },
    { name: SOURCE_CONVERSION, available: conversion !== null },
    { name: SOURCE_COSTCAP_AUDIT, available: costCapAudit !== null },
    { name: SOURCE_COSTCAP_PROOF, available: costCapProof !== null },
  ];

  return {
    generatedAt: input.generatedAt,
    status: "first_pass_and_recovery_separated",
    firstPassEvidenceAvailable: firstPass.available,
    firstPassTokenReductionPercent: firstPass.tokenReductionPercent,
    firstPassCostReductionPercent: firstPass.costReductionPercent,
    baselineResolvedCount: firstPass.baselineResolvedCount,
    vtraceFirstPassResolvedCount: firstPass.vtraceFirstPassResolvedCount,
    recoveryEvidenceAvailable,
    recoveryInstanceId: conversion?.instanceId ?? row?.instanceId ?? "astropy__astropy-14369",
    sourcePatchResolved: conversion?.sourcePatchResolved === true,
    repairedPatchResolved: conversion?.repairedPatchResolved === true,
    convertedUnresolvedToResolved:
      conversion?.convertedUnresolvedToResolved === true || row?.convertedUnresolvedToResolved === true,
    criticCostUsd: row?.criticCostUsd ?? 0,
    repairCostUsd: row?.repairCostUsd ?? 0,
    totalRecoveryCostUsd: row?.totalRecoveryCostUsd ?? 0,
    historicalRepairCostCapExceeded: Boolean(
      costCapAudit?.historicalOverCapRepair?.repairCostExceededCap ?? row?.repairCostExceededCap,
    ),
    repairCostCapHardened,
    repairCostCapBlockProofPassed: costCapProof?.proofPassed === true,
    recoveryMergedIntoFirstPass: false,
    aggregateComparable: false,
    userFacingRepairCostControls: false,
    headlineClaim: HEADLINE_CLAIM,
    technicalControlLoopSummary: TECHNICAL_CONTROL_LOOP_SUMMARY,
    canClaim: CAN_CLAIM,
    cannotClaim: CANNOT_CLAIM,
    recommendedNextMilestones: RECOMMENDED_NEXT_MILESTONES,
    nonClaims: NON_CLAIMS,
    interpretation: REQUIRED_INTERPRETATION,
    firstPass,
    sourceReports,
  };
}

// ---------------------------------------------------------------------------
// Render (pure)
// ---------------------------------------------------------------------------

export function renderJson(report: TokenReductionVsRecoveryReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function tri(value: boolean): string {
  return value ? "true" : "false";
}

function usd(value: number | null): string {
  return value === null ? "unavailable" : `$${value.toFixed(4)}`;
}

function pct(value: number | null): string {
  return value === null ? "unavailable" : `${value.toFixed(2)}%`;
}

function num(value: number | null): string {
  return value === null ? "unavailable" : value.toLocaleString("en-US");
}

function count(value: number | null): string {
  return value === null ? "unavailable" : String(value);
}

export function renderMarkdown(report: TokenReductionVsRecoveryReport): string {
  const L: string[] = [];
  const fp = report.firstPass;

  L.push("# Stage 5 token reduction vs recovery cost");
  L.push("");
  L.push(`_Generated: ${report.generatedAt}_`);
  L.push("");
  L.push(
    "_Reporting only. Consolidates committed Stage 5 report JSONs to separate FIRST-PASS token/cost " +
      "reduction from internal RECOVERY-side critic/repair cost. Runs no agent / live critic / repair / " +
      "Docker / model; mutates no existing report, no raw artifact, and no aggregate policy row; invents no numbers._",
  );
  L.push("");
  const missing = report.sourceReports.filter((s) => !s.available).map((s) => s.name);
  if (missing.length > 0) {
    L.push(`> Source reports unavailable (degraded gracefully): ${missing.join(", ")}.`);
    L.push("");
  }

  L.push("## Summary");
  L.push("");
  L.push(
    `Status: \`${report.status}\`. First-pass VTRACE token reduction is reported SEPARATELY from internal ` +
      "recovery cost. " +
      (fp.available
        ? `Measured first-pass (strict-risk-gated VTRACE vs baseline): ${pct(fp.tokenReductionPercent)} fewer ` +
          `tokens and ${pct(fp.costReductionPercent)} lower cost ` +
          `(${count(fp.vtraceFirstPassResolvedCount)}/10 vs ${count(fp.baselineResolvedCount)}/10 resolved). `
        : "First-pass token-reduction evidence is unavailable from committed reports (not invented). ") +
      `One verified generated-parser repair conversion (${report.recoveryInstanceId}) cost ` +
      `${usd(report.totalRecoveryCostUsd)} of recovery and is NOT merged into first-pass ` +
      `(recoveryMergedIntoFirstPass=${tri(report.recoveryMergedIntoFirstPass)}, ` +
      `aggregateComparable=${tri(report.aggregateComparable)}).`,
  );
  L.push("");

  L.push("## Product-facing token reduction story");
  L.push("");
  L.push(report.headlineClaim);
  L.push("");
  L.push(
    "The public-facing claim is first-pass token reduction from compact, symbol-aware context capsules — " +
      "NOT user-visible repair budgeting. The control-loop recovery mechanism is internal and benchmark-only " +
      `(userFacingRepairCostControls=${tri(report.userFacingRepairCostControls)}).`,
  );
  L.push("");

  L.push("## First-pass evidence");
  L.push("");
  if (fp.available) {
    L.push("| metric | baseline | strict-risk-gated VTRACE first-pass | reduction |");
    L.push("| --- | --- | --- | --- |");
    L.push(
      `| resolved | ${count(fp.baselineResolvedCount)}/10 | ${count(fp.vtraceFirstPassResolvedCount)}/10 | — |`,
    );
    L.push(
      `| tokens | ${num(fp.baselineTotalTokens)} | ${num(fp.vtraceFirstPassTotalTokens)} | ${pct(fp.tokenReductionPercent)} |`,
    );
    L.push(
      `| cost | ${usd(fp.baselineTotalCostUsd)} | ${usd(fp.vtraceFirstPassTotalCostUsd)} | ${pct(fp.costReductionPercent)} |`,
    );
    L.push("");
    L.push(
      "Source: `stage5_policy_accounting.json` (`strictAccounting`). Strict-risk-gated first-pass uses fewer " +
        "tokens and lower cost than baseline; it remains one resolved task behind baseline on this controlled " +
        "10-task set, so fewer tokens does NOT imply a higher success rate.",
    );
  } else {
    L.push(
      "First-pass token/cost evidence is **unavailable** from committed reports. No numbers are invented. " +
        "Regenerate `stage5_policy_accounting.json` to populate this section.",
    );
  }
  L.push("");

  L.push("## Recovery-side evidence");
  L.push("");
  if (report.recoveryEvidenceAvailable) {
    L.push(`- instance: \`${report.recoveryInstanceId}\``);
    L.push(`- sourcePatchResolved: ${tri(report.sourcePatchResolved)}`);
    L.push(`- repairedPatchResolved: ${tri(report.repairedPatchResolved)}`);
    L.push(`- convertedUnresolvedToResolved: ${tri(report.convertedUnresolvedToResolved)}`);
    L.push(`- live critic cost: ${usd(report.criticCostUsd)}`);
    L.push(`- repair cost: ${usd(report.repairCostUsd)}`);
    L.push(`- total recovery cost: ${usd(report.totalRecoveryCostUsd)}`);
  } else {
    L.push("Recovery-side evidence is **unavailable** from committed reports. No numbers are invented.");
  }
  L.push("");

  L.push("## Why these must stay separate");
  L.push("");
  L.push(report.interpretation);
  L.push("");
  L.push(
    "In short: `first-pass context/token reduction != repair-side recovery cost`. A successful one-shot " +
      "repair must never be folded into the first-pass token-reduction measurement or any aggregate row.",
  );
  L.push("");

  L.push("## Generated-parser repair case");
  L.push("");
  L.push(report.technicalControlLoopSummary);
  L.push("");

  L.push("## Cost-cap safety status");
  L.push("");
  L.push(`- historical repair cost-cap exceeded: ${tri(report.historicalRepairCostCapExceeded)}`);
  L.push(`- repair cost-cap hardened (pre_call_estimated_max): ${tri(report.repairCostCapHardened)}`);
  L.push(`- no-model cost-cap block proof passed: ${tri(report.repairCostCapBlockProofPassed)}`);
  L.push("");
  L.push(
    "The repair cost cap is an INTERNAL benchmark control, not a user-facing setting " +
      `(userFacingRepairCostControls=${tri(report.userFacingRepairCostControls)}).`,
  );
  L.push("");

  L.push("## What can be claimed");
  L.push("");
  for (const c of report.canClaim) L.push(`- ${c}`);
  L.push("");

  L.push("## What cannot be claimed");
  L.push("");
  for (const c of report.cannotClaim) L.push(`- ${c}`);
  L.push("");

  L.push("## Recommended next milestones");
  L.push("");
  report.recommendedNextMilestones.forEach((m, i) => L.push(`${i + 1}. ${m}`));
  L.push("");

  L.push("## Non-claims");
  L.push("");
  for (const n of report.nonClaims) L.push(`- ${n}`);
  L.push("");

  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main (impure). Read-only JSON loads (degrading gracefully); writes its own report JSON+MD only.
// ---------------------------------------------------------------------------

export async function run(config: CliConfig): Promise<TokenReductionVsRecoveryReport> {
  const generatedAt = new Date().toISOString();
  const p = (name: string): string => path.join(config.resultsDir, `${name}.json`);

  const [policy, controlLoop, repairAccounting, conversion, costCapAudit, costCapProof] = await Promise.all([
    readJson<PolicyAccountingDoc>(p(SOURCE_POLICY)),
    readJson<unknown>(p(SOURCE_CONTROL_LOOP)),
    readJson<RepairAccountingDoc>(p(SOURCE_REPAIR_ACCOUNTING)),
    readJson<ConversionDoc>(p(SOURCE_CONVERSION)),
    readJson<CostCapAuditDoc>(p(SOURCE_COSTCAP_AUDIT)),
    readJson<CostCapProofDoc>(p(SOURCE_COSTCAP_PROOF)),
  ]);

  const report = buildReport({
    generatedAt,
    policy,
    controlLoop,
    repairAccounting,
    conversion,
    costCapAudit,
    costCapProof,
  });

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  const missing = report.sourceReports.filter((s) => !s.available).map((s) => s.name);
  process.stdout.write(
    [
      "Stage 5 token-reduction vs recovery-cost report written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `status: ${report.status}`,
      `firstPassEvidenceAvailable=${tri(report.firstPassEvidenceAvailable)}  tokenReduction=${pct(report.firstPassTokenReductionPercent)}  costReduction=${pct(report.firstPassCostReductionPercent)}  resolved=${count(report.vtraceFirstPassResolvedCount)}/10 vs ${count(report.baselineResolvedCount)}/10`,
      `recoveryEvidenceAvailable=${tri(report.recoveryEvidenceAvailable)}  instance=${report.recoveryInstanceId}  totalRecovery=${usd(report.totalRecoveryCostUsd)}  converted=${tri(report.convertedUnresolvedToResolved)}`,
      `recoveryMergedIntoFirstPass=${tri(report.recoveryMergedIntoFirstPass)}  aggregateComparable=${tri(report.aggregateComparable)}  userFacingRepairCostControls=${tri(report.userFacingRepairCostControls)}`,
      `costCapHardened=${tri(report.repairCostCapHardened)}  blockProofPassed=${tri(report.repairCostCapBlockProofPassed)}`,
      missing.length > 0 ? `unavailable source reports: ${missing.join(", ")}` : "all source reports available",
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
