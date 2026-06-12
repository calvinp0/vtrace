// Stage 5 repair COST-CAP BLOCK PROOF. READ-ONLY, no-model.
//
// SCOPE: proof/reporting only. This runner reads the committed no-model DRY-RUN generated-parser repair
// report (stage5_generated_parser_repair_cost_cap_blocked_dry_run.json) and proves that the HARDENED
// repair cost cap (pre_call_estimated_max enforcement) now blocks the historical over-cap generated-parser
// repair BEFORE any model call under a $0.40 cap: the estimated worst-case call cost ($3.00) added to the
// prior cumulative ($0.00) cannot fit the $0.40 cap, so a live repair call would be refused pre-call, and
// the dry-run itself invokes no model.
//
// It RE-RUNS nothing: no agent, no live critic, no repair, no Docker, no model. It reads one committed
// dry-run report JSON and writes its own proof JSON+MD only. It mutates NO existing report and NO raw
// artifact, adds NO generated-parser defect to the default allowlist, and changes no retrieval / ranking /
// Capsule v2 / PIVOT_CHECK / critic / repair / evaluator / telemetry / policy-accounting behavior.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { RESULTS_REL } from "./run_stage5_patch_probe_report";

export const DEFAULT_OUT_NAME = "stage5_repair_cost_cap_block_proof";
// The committed no-model dry-run repair report this proof reads.
export const DEFAULT_DRY_RUN_OUT_NAME = "stage5_generated_parser_repair_cost_cap_blocked_dry_run";
// The historical over-cap repair this proof shows is now blocked (from the cost-cap audit / conversion).
export const HISTORICAL_REPAIR_OUT_NAME = "stage5_generated_parser_astropy_repair_attempt_shape_gate";
export const HISTORICAL_REPAIR_COST_USD = 2.8185425;
export const HISTORICAL_REPAIR_CAP_USD = 0.4;

export const PRE_CALL_ESTIMATED_MAX = "pre_call_estimated_max";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly dryRunOutName: string;
  readonly outName: string;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let dryRunOutName = DEFAULT_DRY_RUN_OUT_NAME;
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
      case "--dry-run-out-name":
        dryRunOutName = next();
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
  return { resultsDir, dryRunOutName, outName };
}

// ---------------------------------------------------------------------------
// Input model — the subset of the dry-run repair report this proof consumes (read-only).
// Every field is optional on the wire and degrades to a conservative default.
// ---------------------------------------------------------------------------

export interface DryRunRepairReportDoc {
  readonly gates?: {
    readonly dryRun?: boolean;
    readonly allowGeneratedParserRepair?: boolean;
    readonly repairCostCapUsd?: number | null;
    readonly runLabels?: readonly string[];
  };
  readonly costCapEnforcement?: {
    readonly repairCostCapUsd?: number | null;
    readonly repairCostCapEnforcementMode?: string;
    readonly repairEstimatedMaxCallCostUsd?: number | null;
    readonly singleCallMayExceedCap?: boolean;
    readonly repairPreCallCumulativeCostUsd?: number | null;
    readonly repairStoppedByCostCap?: number;
  };
  readonly summary?: {
    readonly eligibleRuns?: number;
    readonly repairCallsAttempted?: number;
    readonly repairExecuted?: boolean;
  };
  readonly generatedParser?: {
    readonly allowed?: boolean;
    readonly eligibleRuns?: number;
    readonly wouldRepairRuns?: number;
    readonly repairExecuted?: boolean;
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
// Required fixed wording (kept verbatim so downstream readers / tests can rely on it).
// ---------------------------------------------------------------------------

export const REQUIRED_INTERPRETATION =
  "The hardened repair cost cap now blocks the historical generated-parser repair before a model call " +
  "under a $0.40 cap. With pre_call_estimated_max enforcement, the estimated maximum call cost of $3.00 " +
  "cannot fit inside the remaining $0.40 cap, so the runner performs no repair call. This proves the " +
  "historical over-cap path is now blocked in no-model dry-run form.";

export const RECOMMENDED_NEXT_STEP =
  "Add a first-pass-vs-recovery-cost report that keeps strict-v2 first-pass token/cost reduction separate " +
  "from critic/repair recovery cost.";

export const NON_CLAIMS: readonly string[] = [
  "This proof does not run a model, repair, critic, agent, or Docker.",
  "This proof does not evaluate any patch.",
  "This proof does not change the historical conversion evidence.",
  "This proof does not enable broader generated-parser repair usage.",
  "This proof does not change Stage 5 policy accounting.",
];

export const REQUIRED_MARKDOWN_SECTIONS: readonly string[] = [
  "# Stage 5 repair cost-cap block proof",
  "## Summary",
  "## Historical over-cap repair",
  "## Hardened dry-run command",
  "## Dry-run result",
  "## Cost-cap enforcement evidence",
  "## Generated-parser repair boundary",
  "## Recommended next step",
  "## Non-claims",
];

// The hardened no-model dry-run command this proof is derived from (shown verbatim for reproducibility).
export const HARDENED_DRY_RUN_COMMAND: readonly string[] = [
  "bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_patch_repair.ts \\",
  "  --results benchmarks/stage5_vexp_swe_bench_smoke/results \\",
  "  --dry-run \\",
  "  --run-label eval-strictv2-artifacts-protocol-vtrace-astropy-14369 \\",
  "  --include-ad-hoc-run-labels \\",
  "  --allow-generated-parser-repair \\",
  "  --max-repair-runs 1 \\",
  "  --repair-cost-cap-usd 0.40 \\",
  `  --out-name ${DEFAULT_DRY_RUN_OUT_NAME}`,
];

// ---------------------------------------------------------------------------
// Proof (pure). Required fields are TOP-LEVEL for unambiguous downstream reads.
// ---------------------------------------------------------------------------

export interface CostCapBlockProof {
  readonly generatedAt: string;
  readonly sourceRunLabel: string;
  readonly historicalRepairOutName: string;
  readonly dryRunOutName: string;
  readonly repairCostCapUsd: number;
  readonly repairEstimatedMaxCallCostUsd: number | null;
  readonly repairCostCapEnforcementMode: string;
  readonly priorCumulativeCostUsd: number;
  readonly estimatedTotalIfCalledUsd: number;
  readonly blockedBeforeModelCall: boolean;
  readonly repairStoppedByCostCap: boolean;
  readonly repairCallsAttempted: number;
  readonly repairExecuted: boolean;
  readonly wouldRepair: boolean;
  readonly modelCalled: boolean;
  readonly generatedParserRepairAllowed: boolean;
  readonly generatedParserRepairEligibleBeforeCostCap: boolean;
  readonly singleCallMayExceedCap: boolean;
  readonly proofPassed: boolean;
  // ---- narrative / provenance (added; required fields above) ----
  readonly historicalRepairCostUsd: number;
  readonly interpretation: string;
  readonly recommendedNextStep: string;
  readonly nonClaims: readonly string[];
  readonly dryRunReportAvailable: boolean;
}

export interface BuildProofInput {
  readonly generatedAt: string;
  readonly dryRunOutName: string;
  readonly doc: DryRunRepairReportDoc | null;
}

export function buildProof(input: BuildProofInput): CostCapBlockProof {
  const { doc } = input;
  const cap = doc?.costCapEnforcement ?? {};
  const gates = doc?.gates ?? {};
  const summary = doc?.summary ?? {};
  const gp = doc?.generatedParser ?? {};

  const repairCostCapUsd = cap.repairCostCapUsd ?? gates.repairCostCapUsd ?? HISTORICAL_REPAIR_CAP_USD;
  const repairEstimatedMaxCallCostUsd = cap.repairEstimatedMaxCallCostUsd ?? null;
  const repairCostCapEnforcementMode = cap.repairCostCapEnforcementMode ?? "unknown";
  const priorCumulativeCostUsd = cap.repairPreCallCumulativeCostUsd ?? 0;
  const singleCallMayExceedCap = cap.singleCallMayExceedCap === true;

  const estimatedTotalIfCalledUsd = priorCumulativeCostUsd + (repairEstimatedMaxCallCostUsd ?? 0);

  const repairCallsAttempted = summary.repairCallsAttempted ?? 0;
  const repairExecuted = summary.repairExecuted === true || gp.repairExecuted === true;
  // Dry-run mode never invokes a model; outside dry-run a model is only called when an attempt is made.
  const modelCalled = gates.dryRun === true ? false : repairCallsAttempted > 0;
  // wouldRepair reflects DEFECT/critic eligibility from the dry-run (model NOT invoked), not a model call.
  const wouldRepair = (gp.wouldRepairRuns ?? 0) > 0;
  const generatedParserRepairAllowed = gates.allowGeneratedParserRepair === true || gp.allowed === true;
  const generatedParserRepairEligibleBeforeCostCap = (gp.eligibleRuns ?? summary.eligibleRuns ?? 0) > 0;

  // The core arithmetic claim: under pre_call_estimated_max, the estimated worst-case call cost added to
  // the prior cumulative exceeds the cap, so a LIVE repair call is refused BEFORE the model is invoked.
  const blockedBeforeModelCall =
    repairCostCapEnforcementMode === PRE_CALL_ESTIMATED_MAX &&
    repairEstimatedMaxCallCostUsd !== null &&
    estimatedTotalIfCalledUsd > repairCostCapUsd &&
    !singleCallMayExceedCap;

  const repairStoppedByCostCap = blockedBeforeModelCall;

  const proofPassed =
    blockedBeforeModelCall &&
    !modelCalled &&
    repairCallsAttempted === 0 &&
    !repairExecuted &&
    generatedParserRepairAllowed;

  return {
    generatedAt: input.generatedAt,
    sourceRunLabel: gates.runLabels?.[0] ?? "eval-strictv2-artifacts-protocol-vtrace-astropy-14369",
    historicalRepairOutName: HISTORICAL_REPAIR_OUT_NAME,
    dryRunOutName: input.dryRunOutName,
    repairCostCapUsd,
    repairEstimatedMaxCallCostUsd,
    repairCostCapEnforcementMode,
    priorCumulativeCostUsd,
    estimatedTotalIfCalledUsd,
    blockedBeforeModelCall,
    repairStoppedByCostCap,
    repairCallsAttempted,
    repairExecuted,
    wouldRepair,
    modelCalled,
    generatedParserRepairAllowed,
    generatedParserRepairEligibleBeforeCostCap,
    singleCallMayExceedCap,
    proofPassed,
    historicalRepairCostUsd: HISTORICAL_REPAIR_COST_USD,
    interpretation: REQUIRED_INTERPRETATION,
    recommendedNextStep: RECOMMENDED_NEXT_STEP,
    nonClaims: NON_CLAIMS,
    dryRunReportAvailable: doc !== null,
  };
}

// ---------------------------------------------------------------------------
// Render (pure)
// ---------------------------------------------------------------------------

export function renderJson(proof: CostCapBlockProof): string {
  return `${JSON.stringify(proof, null, 2)}\n`;
}

function usd(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

export function renderMarkdown(proof: CostCapBlockProof): string {
  const L: string[] = [];

  L.push("# Stage 5 repair cost-cap block proof");
  L.push("");
  L.push(`_Generated: ${proof.generatedAt}_`);
  L.push("");
  L.push(
    "_Proof/reporting only. Reads the committed no-model dry-run repair report " +
      `(\`${proof.dryRunOutName}.json\`) and proves the hardened repair cost cap blocks the historical ` +
      "generated-parser repair before any model call. Runs no agent / live critic / repair / Docker / model; " +
      "mutates no existing report and no raw artifact; adds no generated-parser defect to the default allowlist._",
  );
  L.push("");
  if (!proof.dryRunReportAvailable) {
    L.push(`> Dry-run repair report \`${proof.dryRunOutName}.json\` unavailable; proof fields degraded to conservative defaults.`);
    L.push("");
  }

  L.push("## Summary");
  L.push("");
  L.push(
    `Proof ${proof.proofPassed ? "PASSED" : "NOT PASSED"}: under \`${proof.repairCostCapEnforcementMode}\` enforcement, ` +
      `the estimated worst-case repair call cost ${usd(proof.repairEstimatedMaxCallCostUsd)} added to the prior ` +
      `cumulative ${usd(proof.priorCumulativeCostUsd)} (= ${usd(proof.estimatedTotalIfCalledUsd)}) cannot fit the ` +
      `${usd(proof.repairCostCapUsd)} cap, so the historical generated-parser repair is blocked BEFORE any model ` +
      `call (blockedBeforeModelCall=${proof.blockedBeforeModelCall}). No model/repair call was made ` +
      `(modelCalled=${proof.modelCalled}, repairCallsAttempted=${proof.repairCallsAttempted}, repairExecuted=${proof.repairExecuted}).`,
  );
  L.push("");

  L.push("## Historical over-cap repair");
  L.push("");
  L.push(
    `The historical repair \`${proof.historicalRepairOutName}\` recorded ` +
      `repairCostUsd=${usd(proof.historicalRepairCostUsd)} despite repairCostCapUsd=${usd(HISTORICAL_REPAIR_CAP_USD)} ` +
      "(repairCostExceededCap=true). Under the old pre_call_cumulative_only enforcement the first/only call saw " +
      "prior cumulative $0.0000 < cap and always proceeded, so a single call was never bounded by the cap.",
  );
  L.push("");

  L.push("## Hardened dry-run command");
  L.push("");
  L.push("```bash");
  for (const line of HARDENED_DRY_RUN_COMMAND) L.push(line);
  L.push("```");
  L.push("");

  L.push("## Dry-run result");
  L.push("");
  L.push(`- sourceRunLabel: \`${proof.sourceRunLabel}\``);
  L.push(`- generatedParserRepairAllowed: ${proof.generatedParserRepairAllowed}`);
  L.push(`- generatedParserRepairEligibleBeforeCostCap: ${proof.generatedParserRepairEligibleBeforeCostCap}`);
  L.push(`- wouldRepair (dry-run defect-eligibility only, model NOT invoked): ${proof.wouldRepair}`);
  L.push(`- repairCallsAttempted: ${proof.repairCallsAttempted}`);
  L.push(`- repairExecuted: ${proof.repairExecuted}`);
  L.push(`- modelCalled: ${proof.modelCalled}`);
  L.push("");
  L.push(
    "The run is eligible by defect class / critic agreement, but the cost cap blocks the actual call: no " +
      "model was invoked and no repair was attempted or executed.",
  );
  L.push("");

  L.push("## Cost-cap enforcement evidence");
  L.push("");
  L.push("| field | value |");
  L.push("| --- | --- |");
  L.push(`| repairCostCapEnforcementMode | \`${proof.repairCostCapEnforcementMode}\` |`);
  L.push(`| repairCostCapUsd | ${usd(proof.repairCostCapUsd)} |`);
  L.push(`| repairEstimatedMaxCallCostUsd | ${usd(proof.repairEstimatedMaxCallCostUsd)} |`);
  L.push(`| priorCumulativeCostUsd | ${usd(proof.priorCumulativeCostUsd)} |`);
  L.push(`| estimatedTotalIfCalledUsd | ${usd(proof.estimatedTotalIfCalledUsd)} |`);
  L.push(`| singleCallMayExceedCap | ${proof.singleCallMayExceedCap} |`);
  L.push(`| blockedBeforeModelCall | ${proof.blockedBeforeModelCall} |`);
  L.push(`| repairStoppedByCostCap | ${proof.repairStoppedByCostCap} |`);
  L.push(`| proofPassed | ${proof.proofPassed} |`);
  L.push("");
  L.push(
    `${usd(proof.priorCumulativeCostUsd)} + ${usd(proof.repairEstimatedMaxCallCostUsd)} = ` +
      `${usd(proof.estimatedTotalIfCalledUsd)} > ${usd(proof.repairCostCapUsd)} ⇒ the call is refused pre-call.`,
  );
  L.push("");
  L.push(proof.interpretation);
  L.push("");

  L.push("## Generated-parser repair boundary");
  L.push("");
  L.push(
    "Generated-parser repair stays OFF by default behind ALL of: `--enable-patch-repair`, " +
      "`--allow-generated-parser-repair`, an explicit `--run-label`, a valid live critic, deterministic/live " +
      "agreement, actionable narrow guidance, max-repair-runs, and the cost cap. This proof adds NO " +
      "generated-parser defect class to `DEFAULT_ALLOWED_DEFECT_CLASSES`; broader use must wait until the " +
      "estimated worst-case call cost is configured to fit the cap.",
  );
  L.push("");

  L.push("## Recommended next step");
  L.push("");
  L.push(`- ${proof.recommendedNextStep}`);
  L.push("");
  L.push("_Generated-parser repair is NOT recommended for broad enablement yet._");
  L.push("");

  L.push("## Non-claims");
  L.push("");
  for (const n of proof.nonClaims) L.push(`- ${n}`);
  L.push("");

  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main (impure). One read-only JSON load (degrading gracefully); writes its own proof JSON+MD only.
// ---------------------------------------------------------------------------

export async function run(config: CliConfig): Promise<CostCapBlockProof> {
  const generatedAt = new Date().toISOString();
  const dryRunPath = path.join(config.resultsDir, `${config.dryRunOutName}.json`);
  const doc = await readJson<DryRunRepairReportDoc>(dryRunPath);
  if (doc === null) {
    throw new Error(
      `No dry-run repair report at ${dryRunPath}; nothing to prove. ` +
        `Generate it first via run_stage5_patch_repair.ts --dry-run ... --out-name ${config.dryRunOutName}.`,
    );
  }

  const proof = buildProof({ generatedAt, dryRunOutName: config.dryRunOutName, doc });

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(proof));
  await writeFile(jsonPath, renderJson(proof));

  process.stdout.write(
    [
      "Stage 5 repair cost-cap block proof written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `proofPassed=${proof.proofPassed}`,
      `mode=${proof.repairCostCapEnforcementMode}  cap=${usd(proof.repairCostCapUsd)}  estMaxCall=${usd(proof.repairEstimatedMaxCallCostUsd)}`,
      `${usd(proof.priorCumulativeCostUsd)} + ${usd(proof.repairEstimatedMaxCallCostUsd)} = ${usd(proof.estimatedTotalIfCalledUsd)} > ${usd(proof.repairCostCapUsd)}  blockedBeforeModelCall=${proof.blockedBeforeModelCall}`,
      `modelCalled=${proof.modelCalled}  repairCallsAttempted=${proof.repairCallsAttempted}  repairExecuted=${proof.repairExecuted}`,
      "",
    ].join("\n"),
  );

  return proof;
}

if (import.meta.main) {
  try {
    await run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
