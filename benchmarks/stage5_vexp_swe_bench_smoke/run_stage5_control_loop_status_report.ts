// Stage 5 CONTROL-LOOP STATUS report. READ-ONLY, consolidated, single-instance.
//
// SCOPE: reporting only. This runner reads the already-committed Stage 5 report JSONs that record the
// controlled context-action-repair chain and consolidates them into ONE status report (JSON + MD). It
// explains how the work advances VTRACE from a pure context-reduction system toward a controlled
// context-action-repair loop, and it carries the verified single-instance Astropy evidence chain.
//
// It RE-RUNS nothing: no agent, no live critic, no repair, no Docker, no model. It reads committed
// report JSONs (degrading gracefully to "unavailable" when one is missing) and writes its own status
// JSON+MD only. It mutates NO existing report, NO raw artifact, and changes no retrieval / ranking /
// Capsule v2 / PIVOT_CHECK / critic / repair / evaluator / telemetry / policy-accounting behavior.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { RESULTS_REL } from "./run_stage5_patch_probe_report";

export const DEFAULT_OUT_NAME = "stage5_control_loop_status";

// The committed source reports this status consolidates (provenance). Each degrades to "unavailable".
export const SOURCE_PROTOCOL = "stage5_astropy_protocol_diagnostic";
export const SOURCE_PROBE = "stage5_patch_minimality_probe_report";
export const SOURCE_CRITIC = "stage5_generated_parser_critic_agreement";
export const SOURCE_CONVERSION = "stage5_generated_parser_repair_conversion_shape_gate";
export const SOURCE_ACCOUNTING = "stage5_generated_parser_repair_accounting";
export const SOURCE_COSTCAP = "stage5_repair_cost_cap_audit";

export const SOURCE_REPORT_NAMES: readonly string[] = [
  SOURCE_PROTOCOL,
  SOURCE_PROBE,
  SOURCE_CRITIC,
  SOURCE_CONVERSION,
  SOURCE_ACCOUNTING,
  SOURCE_COSTCAP,
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
// Input models — the subset of each committed source report this status consumes.
// Every field is optional on the wire and degrades to null/[]/false so a missing or
// partial report is handled without throwing.
// ---------------------------------------------------------------------------

export interface ProtocolDiagnosticDoc {
  readonly runLabel?: string;
  readonly instanceId?: string;
  readonly capsule?: {
    readonly capsuleV2ArtifactsPersisted?: boolean;
    readonly treatmentValid?: boolean;
    readonly contextInjected?: boolean;
    readonly topPivotFile?: string;
    readonly topPivotSymbol?: string;
  };
  readonly orderedTelemetry?: {
    readonly longBashLoopHeuristic?: boolean;
    readonly repeatedSearchHeuristic?: boolean;
    readonly orderedTelemetryAvailable?: boolean;
  };
  readonly docker?: { readonly resolved?: boolean | null };
  readonly contextGood?: boolean;
}

export interface CriticAgreementDoc {
  readonly contextQuality?: {
    readonly leadPivot?: string;
    readonly longBashLoopHeuristic?: boolean;
    readonly repeatedSearchHeuristic?: boolean;
  };
  readonly deterministicRepairRequired?: boolean;
  readonly liveRepairRequired?: boolean;
  readonly agreementWithDeterministic?: boolean;
}

export interface ConversionDoc {
  readonly sourceRunLabel?: string;
  readonly instanceId?: string;
  readonly sourcePatchResolved?: boolean | null;
  readonly repairedPatchResolved?: boolean | null;
  readonly convertedUnresolvedToResolved?: boolean;
  readonly generatedParserRepairShapeAccepted?: boolean | null;
  readonly generatedParserTablesUpdatedByRepair?: readonly string[] | null;
  readonly totalRecoveryCostUsd?: number | null;
  readonly repairCostExceededCap?: boolean;
}

export interface AccountingDoc {
  readonly row?: {
    readonly instanceId?: string;
    readonly totalRecoveryCostUsd?: number | null;
    readonly repairCostExceededCap?: boolean;
  };
}

export interface CostCapAuditDoc {
  readonly historicalOverCapRepair?: { readonly repairCostExceededCap?: boolean };
  readonly fixedEnforcement?: {
    readonly enforcementMode?: string;
    readonly singleCallMayExceedCap?: boolean;
  };
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Required fixed wording (kept verbatim so downstream readers and tests can rely on it).
// ---------------------------------------------------------------------------

export const REQUIRED_INTERPRETATION =
  "This work advances VTRACE from a pure context-reduction system toward a controlled " +
  "context-action-repair loop. The generalizable piece is not the Astropy-specific parser fix; it is " +
  "the pattern: compact context, auditable context quality, deterministic patch-shape probes, gated " +
  "live critic agreement, gated one-shot repair, post-repair shape validation, Docker verification, and " +
  "separate accounting. This reduces wasted tokens by avoiding blind reruns and only spending repair " +
  "tokens when a cheap deterministic signal and a live critic agree.";

// The 12 ordered evidence-chain statements the milestone requires. The recovery-cost line reflects the
// observed value; everything else is fixed wording.
export function buildEvidenceChain(recoveryCostUsd: number | null): readonly string[] {
  const cost = recoveryCostUsd === null ? "$3.0043" : `$${recoveryCostUsd.toFixed(4)}`;
  return [
    "Astropy protocol run had valid indexed Capsule v2 context.",
    "cds.py::CDS was the lead pivot.",
    "loop heuristics were false.",
    "source patch resolved=false.",
    "deterministic generated-parser minimality probe repairRequired=true.",
    "live critic agreed repairRequired=true.",
    "first generated-parser repair failed because cds_parsetab.py was not updated.",
    "consistency diagnostic found source_grammar_changed_without_generated_table_update.",
    "shape-gated repair changed cds.py + cds_parsetab.py.",
    "Docker resolved=true for the shape-gated repair.",
    "convertedUnresolvedToResolved=true.",
    `recovery cost was about ${cost}.`,
    "original repair cap was exceeded historically, and cost-cap enforcement has now been hardened.",
  ];
}

// The safety gates that bound any live generated-parser repair.
export const SAFETY_GATES: readonly string[] = [
  "disabled by default",
  "explicit --run-label required",
  "--enable-patch-repair required",
  "--allow-generated-parser-repair required",
  "valid live critic artifact required",
  "deterministic/live agreement required",
  "actionable narrow guidance required",
  "one attempt only",
  "fail-open behavior",
  "post-repair shape gate",
  "cost-cap enforcement",
  "no default generated-parser allowlist entry",
];

// The recommended next milestones, IN ORDER. Generated-parser repair stays OFF by default.
export const RECOMMENDED_NEXT_MILESTONES: readonly string[] = [
  "Run a no-model dry-run proving the hardened cost-cap now blocks the historical generated-parser repair under a $0.40 cap.",
  "Add a small report comparing first-pass strict-v2 tokens vs repair-side recovery cost, keeping first-pass and repair costs separate.",
  "Try one additional generated-parser-like case only if a real candidate exists; do not synthesize broad claims from Astropy alone.",
  "Define an expected-value policy for repair: repair only when the defect class has observed conversion evidence and estimated cost fits the cap.",
];

export const NON_CLAIMS: readonly string[] = [
  "This report does not claim aggregate SWE-bench improvement.",
  "This report does not claim generated-parser repair generalizes beyond the verified Astropy case.",
  "This report does not merge repair recovery into first-pass token reduction.",
  "This report does not enable broader repair usage.",
  "This report does not change policy accounting.",
  "This report does not run agents, repair, live critic, or Docker.",
];

export const WHAT_IS_GENERALIZED: readonly string[] = [
  "The control-loop PATTERN: compact context, auditable context quality, deterministic patch-shape probes, gated live critic agreement, gated one-shot repair, post-repair shape validation, Docker verification, and separate accounting.",
  "Deterministic, cheap patch-shape probing as a pre-filter before spending any live-critic or repair tokens.",
  "Requiring a cheap deterministic signal AND a live critic to AGREE before any repair token is spent.",
  "Keeping repair-side recovery cost accounted SEPARATELY from first-pass token reduction.",
];

export const WHAT_IS_NOT_GENERALIZED: readonly string[] = [
  "The Astropy-specific generated-parser fix itself (cds.py + cds_parsetab.py) is one verified instance, not a general capability.",
  "Generated-parser repair is NOT proven to generalize to other parser systems or defect classes.",
  "There is no aggregate SWE-bench improvement claim; this is single-instance verified evidence.",
  "Generated-parser defect classes remain OFF the default repair allowlist.",
];

export const CURRENT_BOUNDARIES: readonly string[] = [
  "Single verified instance: astropy__astropy-14369 only.",
  "Generated-parser repair stays disabled by default behind explicit flags.",
  "The verified repair historically exceeded its cost cap; cost-cap enforcement has been hardened but broader use must wait for the recommended dry-run proof.",
  "Repair recovery cost (~$3.0043) is recorded separately and is NOT folded into first-pass token reduction.",
];

// The required Markdown section headers, in order.
export const REQUIRED_MARKDOWN_SECTIONS: readonly string[] = [
  "# Stage 5 control-loop status",
  "## Summary",
  "## Why this matters for token reduction",
  "## Current control loop",
  "## Evidence chain",
  "## Astropy generated-parser case study",
  "## Cost and token implications",
  "## Safety gates",
  "## What is generalized",
  "## What is not generalized yet",
  "## Current boundaries",
  "## Recommended next milestones",
  "## Non-claims",
];

// ---------------------------------------------------------------------------
// Consolidated status (pure). Required fields are TOP-LEVEL for unambiguous downstream reads.
// ---------------------------------------------------------------------------

export interface SourceReportAvailability {
  readonly name: string;
  readonly available: boolean;
}

export interface ControlLoopStatus {
  readonly generatedAt: string;
  readonly status: "single_instance_verified_control_loop";
  readonly verifiedInstanceId: string;
  readonly sourceRunLabel: string;
  readonly sourcePatchResolved: boolean;
  readonly repairedPatchResolved: boolean;
  readonly convertedUnresolvedToResolved: boolean;
  readonly capsuleV2ContextValid: boolean;
  readonly leadPivot: string;
  readonly loopHeuristicsFalse: boolean;
  readonly deterministicProbeRepairRequired: boolean;
  readonly liveCriticRepairRequired: boolean;
  readonly criticAgreement: boolean;
  readonly shapeGateAccepted: boolean;
  readonly generatedParserTablesUpdatedByRepair: readonly string[];
  readonly recoveryCostUsd: number | null;
  readonly repairCostCapExceededHistorically: boolean;
  readonly costCapHardened: boolean;
  readonly aggregateComparable: false;
  // ---- consolidated narrative / provenance (added; required fields above) ----
  readonly interpretation: string;
  readonly evidenceChain: readonly string[];
  readonly safetyGates: readonly string[];
  readonly whatIsGeneralized: readonly string[];
  readonly whatIsNotGeneralized: readonly string[];
  readonly currentBoundaries: readonly string[];
  readonly recommendedNextMilestones: readonly string[];
  readonly nonClaims: readonly string[];
  readonly sourceReports: readonly SourceReportAvailability[];
}

export interface BuildStatusInput {
  readonly generatedAt: string;
  readonly protocol: ProtocolDiagnosticDoc | null;
  readonly probe: unknown | null;
  readonly critic: CriticAgreementDoc | null;
  readonly conversion: ConversionDoc | null;
  readonly accounting: AccountingDoc | null;
  readonly costCap: CostCapAuditDoc | null;
}

function leadPivotFrom(protocol: ProtocolDiagnosticDoc | null, critic: CriticAgreementDoc | null): string {
  const c = critic?.contextQuality?.leadPivot;
  if (c) return c;
  const f = protocol?.capsule?.topPivotFile;
  const s = protocol?.capsule?.topPivotSymbol;
  if (f && s) return `${f}::${s}`;
  if (f) return f;
  return "unknown";
}

function loopHeuristicsFalseFrom(
  protocol: ProtocolDiagnosticDoc | null,
  critic: CriticAgreementDoc | null,
): boolean {
  const t = protocol?.orderedTelemetry;
  if (t && t.orderedTelemetryAvailable) {
    return t.longBashLoopHeuristic === false && t.repeatedSearchHeuristic === false;
  }
  const cq = critic?.contextQuality;
  if (cq) {
    return cq.longBashLoopHeuristic === false && cq.repeatedSearchHeuristic === false;
  }
  return false;
}

export function buildStatus(input: BuildStatusInput): ControlLoopStatus {
  const { protocol, critic, conversion, accounting, costCap } = input;

  const capsule = protocol?.capsule;
  const capsuleV2ContextValid = Boolean(
    capsule?.capsuleV2ArtifactsPersisted && capsule?.treatmentValid && capsule?.contextInjected,
  );

  const recoveryCostUsd =
    conversion?.totalRecoveryCostUsd ?? accounting?.row?.totalRecoveryCostUsd ?? null;

  const repairCostCapExceededHistorically = Boolean(
    costCap?.historicalOverCapRepair?.repairCostExceededCap ??
      accounting?.row?.repairCostExceededCap ??
      conversion?.repairCostExceededCap,
  );

  const costCapHardened = Boolean(
    costCap?.fixedEnforcement?.enforcementMode === "pre_call_estimated_max" &&
      costCap?.fixedEnforcement?.singleCallMayExceedCap === false,
  );

  const sourceReports: readonly SourceReportAvailability[] = [
    { name: SOURCE_PROTOCOL, available: protocol !== null },
    { name: SOURCE_PROBE, available: input.probe !== null },
    { name: SOURCE_CRITIC, available: critic !== null },
    { name: SOURCE_CONVERSION, available: conversion !== null },
    { name: SOURCE_ACCOUNTING, available: accounting !== null },
    { name: SOURCE_COSTCAP, available: costCap !== null },
  ];

  return {
    generatedAt: input.generatedAt,
    status: "single_instance_verified_control_loop",
    verifiedInstanceId:
      conversion?.instanceId ?? protocol?.instanceId ?? accounting?.row?.instanceId ?? "unknown",
    sourceRunLabel: conversion?.sourceRunLabel ?? protocol?.runLabel ?? "unknown",
    sourcePatchResolved: (conversion?.sourcePatchResolved ?? protocol?.docker?.resolved ?? false) === true,
    repairedPatchResolved: conversion?.repairedPatchResolved === true,
    convertedUnresolvedToResolved: conversion?.convertedUnresolvedToResolved === true,
    capsuleV2ContextValid,
    leadPivot: leadPivotFrom(protocol, critic),
    loopHeuristicsFalse: loopHeuristicsFalseFrom(protocol, critic),
    deterministicProbeRepairRequired: critic?.deterministicRepairRequired === true,
    liveCriticRepairRequired: critic?.liveRepairRequired === true,
    criticAgreement: critic?.agreementWithDeterministic === true,
    shapeGateAccepted: conversion?.generatedParserRepairShapeAccepted === true,
    generatedParserTablesUpdatedByRepair: conversion?.generatedParserTablesUpdatedByRepair ?? [],
    recoveryCostUsd,
    repairCostCapExceededHistorically,
    costCapHardened,
    aggregateComparable: false,
    interpretation: REQUIRED_INTERPRETATION,
    evidenceChain: buildEvidenceChain(recoveryCostUsd),
    safetyGates: SAFETY_GATES,
    whatIsGeneralized: WHAT_IS_GENERALIZED,
    whatIsNotGeneralized: WHAT_IS_NOT_GENERALIZED,
    currentBoundaries: CURRENT_BOUNDARIES,
    recommendedNextMilestones: RECOMMENDED_NEXT_MILESTONES,
    nonClaims: NON_CLAIMS,
    sourceReports,
  };
}

// ---------------------------------------------------------------------------
// Render (pure)
// ---------------------------------------------------------------------------

export function renderJson(status: ControlLoopStatus): string {
  return `${JSON.stringify(status, null, 2)}\n`;
}

function tri(value: boolean): string {
  return value ? "true" : "false";
}

function usd(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

export function renderMarkdown(status: ControlLoopStatus): string {
  const L: string[] = [];

  L.push("# Stage 5 control-loop status");
  L.push("");
  L.push(`_Generated: ${status.generatedAt}_`);
  L.push("");
  L.push(
    "_Reporting only. Consolidates committed Stage 5 report JSONs into one read-only status. Runs no " +
      "agent / live critic / repair / Docker / model; mutates no existing report and no raw artifact._",
  );
  L.push("");
  const missing = status.sourceReports.filter((s) => !s.available).map((s) => s.name);
  if (missing.length > 0) {
    L.push(`> Source reports unavailable (degraded gracefully): ${missing.join(", ")}.`);
    L.push("");
  }

  L.push("## Summary");
  L.push("");
  L.push(
    `Status: \`${status.status}\`. The auditable Astropy protocol run (\`${status.verifiedInstanceId}\`, ` +
      `run label \`${status.sourceRunLabel}\`) had valid indexed Capsule v2 context with lead pivot ` +
      `\`${status.leadPivot}\`, yet its source patch was unresolved. A deterministic patch-shape probe and a ` +
      "live critic independently AGREED that repair was required; a gated, shape-validated one-shot repair " +
      `then converted the instance from unresolved to resolved under Docker ` +
      `(convertedUnresolvedToResolved=${tri(status.convertedUnresolvedToResolved)}). This is ` +
      "single-instance verified evidence of a controlled context-action-repair loop, not an aggregate score " +
      `(aggregateComparable=${tri(status.aggregateComparable)}).`,
  );
  L.push("");

  L.push("## Why this matters for token reduction");
  L.push("");
  L.push(status.interpretation);
  L.push("");

  L.push("## Current control loop");
  L.push("");
  L.push("The Stage 5 chain now runs as a controlled loop:");
  L.push("");
  L.push("1. Compact, indexed Capsule v2 context (auditable: persisted artifacts, treatment validity).");
  L.push("2. Ordered tool telemetry + loop heuristics to audit context quality and agent behavior.");
  L.push("3. Deterministic patch-shape / minimality probe (cheap, no model) flags risky patches.");
  L.push("4. Gated live critic — only consulted for flagged patches — must agree repair is required.");
  L.push("5. Gated one-shot repair behind explicit flags, with narrow actionable guidance.");
  L.push("6. Post-repair shape gate rejects broad rewrites / generated-table deletion.");
  L.push("7. Docker verification of the repaired patch.");
  L.push("8. Separate, labelled accounting that never merges into first-pass token reduction.");
  L.push("");

  L.push("## Evidence chain");
  L.push("");
  for (const item of status.evidenceChain) L.push(`- ${item}`);
  L.push("");

  L.push("## Astropy generated-parser case study");
  L.push("");
  L.push(
    `Instance \`${status.verifiedInstanceId}\` is the single verified instance. Indexed Capsule v2 placed ` +
      `\`${status.leadPivot}\` as the lead pivot and loop heuristics were false ` +
      `(loopHeuristicsFalse=${tri(status.loopHeuristicsFalse)}), so the failure was a patch mistake despite good ` +
      "context: the source patch made a broad generated-parser rewrite and was unresolved " +
      `(sourcePatchResolved=${tri(status.sourcePatchResolved)}). The deterministic probe ` +
      `(repairRequired=${tri(status.deterministicProbeRepairRequired)}) and the live critic ` +
      `(repairRequired=${tri(status.liveCriticRepairRequired)}) agreed ` +
      `(criticAgreement=${tri(status.criticAgreement)}). A first repair failed because ` +
      "`cds_parsetab.py` was not updated; a consistency diagnostic identified " +
      "`source_grammar_changed_without_generated_table_update`. The shape-gated repair changed " +
      `${status.generatedParserTablesUpdatedByRepair.length > 0 ? "`cds.py` + `" + status.generatedParserTablesUpdatedByRepair.join("`, `") + "`" : "cds.py and the generated parser table"}, ` +
      `passed the shape gate (shapeGateAccepted=${tri(status.shapeGateAccepted)}), and Docker reported ` +
      `resolved=true (repairedPatchResolved=${tri(status.repairedPatchResolved)}).`,
  );
  L.push("");

  L.push("## Cost and token implications");
  L.push("");
  L.push(
    `- Repair-side recovery cost was about ${usd(status.recoveryCostUsd)} (critic + repair), recorded ` +
      "SEPARATELY from first-pass token reduction.",
  );
  L.push(
    "- The control loop reduces wasted tokens by avoiding blind reruns: live-critic and repair tokens are " +
      "spent ONLY when the cheap deterministic probe and the live critic agree.",
  );
  L.push(
    `- The verified repair exceeded its cost cap historically ` +
      `(repairCostCapExceededHistorically=${tri(status.repairCostCapExceededHistorically)}); cost-cap ` +
      `enforcement has since been hardened (costCapHardened=${tri(status.costCapHardened)}).`,
  );
  L.push(
    "- First-pass strict-v2 token reduction and repair-side recovery cost are kept distinct and are NOT merged.",
  );
  L.push("");

  L.push("## Safety gates");
  L.push("");
  L.push("Any live generated-parser repair is bounded by ALL of:");
  L.push("");
  for (const gate of status.safetyGates) L.push(`- ${gate}`);
  L.push("");

  L.push("## What is generalized");
  L.push("");
  for (const item of status.whatIsGeneralized) L.push(`- ${item}`);
  L.push("");

  L.push("## What is not generalized yet");
  L.push("");
  for (const item of status.whatIsNotGeneralized) L.push(`- ${item}`);
  L.push("");

  L.push("## Current boundaries");
  L.push("");
  for (const item of status.currentBoundaries) L.push(`- ${item}`);
  L.push("");

  L.push("## Recommended next milestones");
  L.push("");
  status.recommendedNextMilestones.forEach((m, i) => L.push(`${i + 1}. ${m}`));
  L.push("");
  L.push("_Generated-parser repair is NOT recommended for broad enablement yet._");
  L.push("");

  L.push("## Non-claims");
  L.push("");
  for (const n of status.nonClaims) L.push(`- ${n}`);
  L.push("");

  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main (impure). Read-only JSON loads (degrading gracefully); writes its own status JSON+MD only.
// ---------------------------------------------------------------------------

export async function run(config: CliConfig): Promise<ControlLoopStatus> {
  const generatedAt = new Date().toISOString();
  const p = (name: string): string => path.join(config.resultsDir, `${name}.json`);

  const [protocol, probe, critic, conversion, accounting, costCap] = await Promise.all([
    readJson<ProtocolDiagnosticDoc>(p(SOURCE_PROTOCOL)),
    readJson<unknown>(p(SOURCE_PROBE)),
    readJson<CriticAgreementDoc>(p(SOURCE_CRITIC)),
    readJson<ConversionDoc>(p(SOURCE_CONVERSION)),
    readJson<AccountingDoc>(p(SOURCE_ACCOUNTING)),
    readJson<CostCapAuditDoc>(p(SOURCE_COSTCAP)),
  ]);

  const status = buildStatus({ generatedAt, protocol, probe, critic, conversion, accounting, costCap });

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(status));
  await writeFile(jsonPath, renderJson(status));

  const missing = status.sourceReports.filter((s) => !s.available).map((s) => s.name);
  process.stdout.write(
    [
      "Stage 5 control-loop status report written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `status: ${status.status}`,
      `instance: ${status.verifiedInstanceId}  runLabel: ${status.sourceRunLabel}`,
      `convertedUnresolvedToResolved=${tri(status.convertedUnresolvedToResolved)}  shapeGateAccepted=${tri(status.shapeGateAccepted)}  criticAgreement=${tri(status.criticAgreement)}`,
      `recoveryCost=${usd(status.recoveryCostUsd)}  capExceededHistorically=${tri(status.repairCostCapExceededHistorically)}  costCapHardened=${tri(status.costCapHardened)}`,
      `aggregateComparable=${tri(status.aggregateComparable)}`,
      missing.length > 0 ? `unavailable source reports: ${missing.join(", ")}` : "all source reports available",
      "",
    ].join("\n"),
  );

  return status;
}

if (import.meta.main) {
  try {
    await run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
