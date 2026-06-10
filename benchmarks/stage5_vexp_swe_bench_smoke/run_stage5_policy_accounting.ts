// Stage 5 POLICY ACCOUNTING report (cost / tokens per resolved task). READ-ONLY.
//
// SCOPE: reporting/accounting only. This runner reads the already-generated
// controlled-task plan, the live-critic comparison, and the verified repair-
// conversion evidence, and compares cost, tokens, and resolved count across a set
// of POLICIES over the same controlled task set. It answers the token-reduction
// question: does gated repair improve cost/tokens per resolved task, or merely add
// overhead?
//
// It RE-RUNS nothing: no agent, no live critic, no repair, no Docker. It mutates no
// artifact and changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD /
// PATCH_VERIFY / probe / critic / repair / evaluator / conversion-report behavior.

import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { RESULTS_REL } from "./run_stage5_patch_probe_report";

export const DEFAULT_OUT_NAME = "stage5_policy_accounting";

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
// Input model
// ---------------------------------------------------------------------------

// One controlled task: its baseline and vtrace-first-patch outcomes. Resolution may
// be genuinely unknown (null); cost/tokens may be absent (null) and are never invented.
export interface ControlledTask {
  readonly instanceId: string;
  readonly vtraceRunLabel: string | null;
  readonly baselineResolved: boolean | null;
  readonly vtraceResolved: boolean | null;
  readonly baselineCostUsd: number | null;
  readonly vtraceCostUsd: number | null;
  readonly baselineTokens: number | null;
  readonly vtraceTokens: number | null;
}

// A repaired-patch evaluation conversion. Only those with
// convertedUnresolvedToResolved===true are APPLIED to the gated-repair policies.
export interface Conversion {
  readonly runLabel: string;
  readonly instanceId: string;
  readonly firstPatchResolved: boolean | null;
  readonly repairedPatchResolved: boolean | null;
  readonly convertedUnresolvedToResolved: boolean;
  readonly criticCostUsd: number | null;
  readonly repairCostUsd: number | null;
  readonly criticInputTokens: number | null;
  readonly criticOutputTokens: number | null;
  readonly repairInputTokens: number | null;
  readonly repairOutputTokens: number | null;
  readonly totalRecoveryCostUsd: number | null;
}

// Aggregated live-critic observation cost for one instance (mean across that
// instance's critic runs — one representative observation per first patch).
export interface CriticObservation {
  readonly instanceId: string;
  readonly runCount: number;
  readonly meanCostUsd: number | null;
  readonly meanInputTokens: number | null;
  readonly meanOutputTokens: number | null;
}

export interface AccountingInputs {
  readonly tasks: readonly ControlledTask[];
  readonly conversions: readonly Conversion[];
  readonly criticObservations: readonly CriticObservation[];
}

// ---------------------------------------------------------------------------
// Read-only loading
// ---------------------------------------------------------------------------

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

interface PlanDoc {
  readonly selectedTasks?: ReadonlyArray<Record<string, unknown>>;
}

export function parseControlledTasks(plan: PlanDoc | null): ControlledTask[] {
  const selected = plan?.selectedTasks ?? [];
  return selected.map((t) => ({
    instanceId: asStr(t.instanceId) ?? "unknown",
    vtraceRunLabel: asStr(t.vtraceRunLabel),
    baselineResolved: asBool(t.baselineResolved),
    vtraceResolved: asBool(t.vtraceResolved),
    baselineCostUsd: asNum(t.baselineCost),
    vtraceCostUsd: asNum(t.vtraceCost),
    baselineTokens: asNum(t.baselineTokens),
    vtraceTokens: asNum(t.vtraceTokens),
  }));
}

interface ConversionDoc {
  readonly runLabel?: string;
  readonly instanceId?: string;
  readonly conversion?: {
    readonly firstPatchResolved?: boolean | null;
    readonly repairedPatchResolved?: boolean | null;
    readonly convertedUnresolvedToResolved?: boolean;
  };
  readonly costs?: {
    readonly criticCostUsd?: number | null;
    readonly repairCostUsd?: number | null;
    readonly criticInputTokens?: number | null;
    readonly criticOutputTokens?: number | null;
    readonly repairInputTokens?: number | null;
    readonly repairOutputTokens?: number | null;
    readonly totalCriticRepairCostUsd?: number | null;
  };
}

export function parseConversion(doc: ConversionDoc | null): Conversion | null {
  if (doc === null || !doc.conversion) return null;
  const c = doc.conversion;
  const costs = doc.costs ?? {};
  return {
    runLabel: doc.runLabel ?? "unknown",
    instanceId: doc.instanceId ?? "unknown",
    firstPatchResolved: c.firstPatchResolved ?? null,
    repairedPatchResolved: c.repairedPatchResolved ?? null,
    convertedUnresolvedToResolved: c.convertedUnresolvedToResolved === true,
    criticCostUsd: costs.criticCostUsd ?? null,
    repairCostUsd: costs.repairCostUsd ?? null,
    criticInputTokens: costs.criticInputTokens ?? null,
    criticOutputTokens: costs.criticOutputTokens ?? null,
    repairInputTokens: costs.repairInputTokens ?? null,
    repairOutputTokens: costs.repairOutputTokens ?? null,
    totalRecoveryCostUsd: costs.totalCriticRepairCostUsd ?? null,
  };
}

interface CriticComparisonDoc {
  readonly runs?: ReadonlyArray<Record<string, unknown>>;
}

// Group the live-critic comparison runs by instance, computing one representative
// (mean) observation per instance — a real policy runs the critic once per first patch.
export function parseCriticObservations(doc: CriticComparisonDoc | null): CriticObservation[] {
  const runs = doc?.runs ?? [];
  const byInstance = new Map<string, { cost: number[]; input: number[]; output: number[] }>();
  for (const r of runs) {
    const id = asStr(r.instanceId);
    if (id === null) continue;
    const entry = byInstance.get(id) ?? { cost: [], input: [], output: [] };
    const cost = asNum(r.criticCostUsd);
    const input = asNum(r.criticInputTokens);
    const output = asNum(r.criticOutputTokens);
    if (cost !== null) entry.cost.push(cost);
    if (input !== null) entry.input.push(input);
    if (output !== null) entry.output.push(output);
    byInstance.set(id, entry);
  }
  const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
  return [...byInstance.entries()]
    .map(([instanceId, e]) => ({
      instanceId,
      runCount: Math.max(e.cost.length, e.input.length, e.output.length),
      meanCostUsd: mean(e.cost),
      meanInputTokens: mean(e.input),
      meanOutputTokens: mean(e.output),
    }))
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId));
}

// Load every committed input this accounting rests on. FAILS CLEARLY when the
// controlled-task plan is missing — there are no tasks to account for. Read-only.
export async function loadAccountingInputs(resultsDir: string): Promise<AccountingInputs> {
  const plan = await readJson<PlanDoc>(path.join(resultsDir, "stage5_controlled_10_task_plan.json"));
  if (plan === null || !Array.isArray(plan.selectedTasks) || plan.selectedTasks.length === 0) {
    throw new Error(
      `No controlled-task plan at ${path.join(resultsDir, "stage5_controlled_10_task_plan.json")} ` +
        `(or it has no selectedTasks); nothing to account for.`,
    );
  }
  const tasks = parseControlledTasks(plan);

  // Verified repair-conversion evidence reports: every stage5_repair_conversion_*.json.
  const conversions: Conversion[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(resultsDir);
  } catch {
    entries = [];
  }
  for (const name of entries.filter((n) => /^stage5_repair_conversion_.*\.json$/.test(n)).sort()) {
    const conv = parseConversion(await readJson<ConversionDoc>(path.join(resultsDir, name)));
    if (conv !== null) conversions.push(conv);
  }

  const criticDoc = await readJson<CriticComparisonDoc>(path.join(resultsDir, "stage5_live_critic_high_risk_comparison.json"));
  const criticObservations = parseCriticObservations(criticDoc);

  return { tasks, conversions, criticObservations };
}

// ---------------------------------------------------------------------------
// Policy computation (pure)
// ---------------------------------------------------------------------------

export type ResolutionBasis = "baseline" | "vtrace";

export interface PolicySpec {
  readonly policyName: string;
  readonly description: string;
  readonly resolutionBasis: ResolutionBasis;
  readonly costBasis: ResolutionBasis;
  readonly tokenBasis: ResolutionBasis;
  // Flip resolution to true for instances with a verified conversion.
  readonly applyConversions: boolean;
  // Add one representative live-critic observation cost+tokens per instance that had a critic run.
  readonly addCriticObservation: boolean;
  // Add critic+repair cost+tokens ONLY for verified conversions.
  readonly addVerifiedRecoveryCost: boolean;
}

export const POLICY_SPECS: readonly PolicySpec[] = [
  {
    policyName: "baseline",
    description: "Existing baseline result for each controlled task.",
    resolutionBasis: "baseline",
    costBasis: "baseline",
    tokenBasis: "baseline",
    applyConversions: false,
    addCriticObservation: false,
    addVerifiedRecoveryCost: false,
  },
  {
    policyName: "vtrace_first_patch",
    description: "Existing VTRACE result before critic/repair.",
    resolutionBasis: "vtrace",
    costBasis: "vtrace",
    tokenBasis: "vtrace",
    applyConversions: false,
    addCriticObservation: false,
    addVerifiedRecoveryCost: false,
  },
  {
    policyName: "vtrace_with_observed_gated_repair",
    description: "vtrace_first_patch with verified repaired-patch conversions applied to RESOLUTION only (recovery cost not added — optimistic ceiling).",
    resolutionBasis: "vtrace",
    costBasis: "vtrace",
    tokenBasis: "vtrace",
    applyConversions: true,
    addCriticObservation: false,
    addVerifiedRecoveryCost: false,
  },
  {
    policyName: "vtrace_with_live_critic_observation_cost",
    description: "vtrace_first_patch plus live-critic observation cost where critic was run; resolution UNCHANGED (pure overhead).",
    resolutionBasis: "vtrace",
    costBasis: "vtrace",
    tokenBasis: "vtrace",
    applyConversions: false,
    addCriticObservation: true,
    addVerifiedRecoveryCost: false,
  },
  {
    policyName: "vtrace_with_verified_repair_cost",
    description: "Realistic gated repair: verified conversions change resolution AND add critic+repair cost only for those conversions.",
    resolutionBasis: "vtrace",
    costBasis: "vtrace",
    tokenBasis: "vtrace",
    applyConversions: true,
    addCriticObservation: false,
    addVerifiedRecoveryCost: true,
  },
];

export interface PolicyMetrics {
  readonly policyName: string;
  readonly description: string;
  readonly taskCount: number;
  readonly resolvedCount: number;
  readonly unresolvedCount: number;
  readonly unknownCount: number;
  readonly totalCostUsd: number | null;
  readonly meanCostUsd: number | null;
  readonly costPerResolved: number | null;
  readonly totalTokens: number | null;
  readonly meanTokens: number | null;
  readonly tokensPerResolved: number | null;
  readonly agentCostUsd: number | null;
  readonly criticCostUsd: number | null;
  readonly repairCostUsd: number | null;
  readonly criticInputTokens: number | null;
  readonly criticOutputTokens: number | null;
  readonly repairInputTokens: number | null;
  readonly repairOutputTokens: number | null;
  // Verified repaired-patch evaluation artifacts whose instance is in the controlled set
  // (artifact-level: multiple converted artifacts for the SAME instance each count).
  readonly artifactConversionCount: number;
  // Unique controlled tasks flipped to resolved by a verified conversion
  // (task-level: many artifacts for one instance count as ONE recovery).
  readonly taskConversionCount: number;
}

// Sum a list of (number | null), returning null only when NO value was present
// (so a metric absent from every task stays null rather than fabricating 0).
function sumNullable(values: ReadonlyArray<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

function div(numerator: number | null, denominator: number): number | null {
  if (numerator === null || denominator === 0) return null;
  return numerator / denominator;
}

export function computePolicyMetrics(spec: PolicySpec, inputs: AccountingInputs): PolicyMetrics {
  const verified = inputs.conversions.filter((c) => c.convertedUnresolvedToResolved);
  const verifiedByInstance = new Map(verified.map((c) => [c.instanceId, c]));
  const criticByInstance = new Map(inputs.criticObservations.map((o) => [o.instanceId, o]));
  const taskInstanceIds = new Set(inputs.tasks.map((t) => t.instanceId));

  let resolvedCount = 0;
  let unresolvedCount = 0;
  let unknownCount = 0;
  // Task-level: counts unique controlled tasks flipped to resolved (one per instance).
  let taskConversionCount = 0;

  const agentCosts: Array<number | null> = [];
  const agentTokens: Array<number | null> = [];
  let criticCostUsd: number | null = null;
  let repairCostUsd: number | null = null;
  let criticInputTokens: number | null = null;
  let criticOutputTokens: number | null = null;
  let repairInputTokens: number | null = null;
  let repairOutputTokens: number | null = null;

  for (const task of inputs.tasks) {
    // --- resolution ---
    let resolved = spec.resolutionBasis === "baseline" ? task.baselineResolved : task.vtraceResolved;
    const conv = verifiedByInstance.get(task.instanceId);
    if (spec.applyConversions && conv) {
      resolved = true;
      taskConversionCount += 1;
    }
    if (resolved === true) resolvedCount += 1;
    else if (resolved === false) unresolvedCount += 1;
    else unknownCount += 1;

    // --- agent cost / tokens ---
    agentCosts.push(spec.costBasis === "baseline" ? task.baselineCostUsd : task.vtraceCostUsd);
    agentTokens.push(spec.tokenBasis === "baseline" ? task.baselineTokens : task.vtraceTokens);

    // --- critic observation overhead (resolution unchanged) ---
    if (spec.addCriticObservation) {
      const obs = criticByInstance.get(task.instanceId);
      if (obs) {
        criticCostUsd = addNullable(criticCostUsd, obs.meanCostUsd);
        criticInputTokens = addNullable(criticInputTokens, obs.meanInputTokens);
        criticOutputTokens = addNullable(criticOutputTokens, obs.meanOutputTokens);
      }
    }

    // --- verified recovery cost (critic + repair) only for verified conversions ---
    if (spec.addVerifiedRecoveryCost && conv) {
      criticCostUsd = addNullable(criticCostUsd, conv.criticCostUsd);
      repairCostUsd = addNullable(repairCostUsd, conv.repairCostUsd);
      criticInputTokens = addNullable(criticInputTokens, conv.criticInputTokens);
      criticOutputTokens = addNullable(criticOutputTokens, conv.criticOutputTokens);
      repairInputTokens = addNullable(repairInputTokens, conv.repairInputTokens);
      repairOutputTokens = addNullable(repairOutputTokens, conv.repairOutputTokens);
    }
  }

  const taskCount = inputs.tasks.length;
  // Artifact-level: every verified conversion artifact for an instance in the set.
  // Many artifacts for one instance each count here, but only ONE task recovery above.
  const artifactConversionCount = spec.applyConversions
    ? verified.filter((c) => taskInstanceIds.has(c.instanceId)).length
    : 0;
  const agentCostUsd = sumNullable(agentCosts);
  const agentTokensTotal = sumNullable(agentTokens);

  const totalCostUsd = [agentCostUsd, criticCostUsd, repairCostUsd].some((v) => v !== null)
    ? (agentCostUsd ?? 0) + (criticCostUsd ?? 0) + (repairCostUsd ?? 0)
    : null;
  const criticTokenTotal = addNullable(criticInputTokens, criticOutputTokens);
  const repairTokenTotal = addNullable(repairInputTokens, repairOutputTokens);
  const totalTokens =
    agentTokensTotal === null && criticTokenTotal === null && repairTokenTotal === null
      ? null
      : (agentTokensTotal ?? 0) + (criticTokenTotal ?? 0) + (repairTokenTotal ?? 0);

  return {
    policyName: spec.policyName,
    description: spec.description,
    taskCount,
    resolvedCount,
    unresolvedCount,
    unknownCount,
    totalCostUsd,
    meanCostUsd: div(totalCostUsd, taskCount),
    costPerResolved: div(totalCostUsd, resolvedCount),
    totalTokens,
    meanTokens: div(totalTokens, taskCount),
    tokensPerResolved: div(totalTokens, resolvedCount),
    agentCostUsd,
    criticCostUsd,
    repairCostUsd,
    criticInputTokens,
    criticOutputTokens,
    repairInputTokens,
    repairOutputTokens,
    artifactConversionCount,
    taskConversionCount,
  };
}

// ---------------------------------------------------------------------------
// Recommendation (deterministic, data-driven)
// ---------------------------------------------------------------------------

export type RecommendationChoice = "A" | "B" | "C" | "D";

export interface Recommendation {
  readonly choice: RecommendationChoice;
  readonly statement: string;
  readonly rationale: string;
}

export const RECOMMENDATION_TEXT: Record<RecommendationChoice, string> = {
  A: "Scale up repair experiments: the unique-task evidence base is now broad enough to justify a batch of new unique candidates.",
  B: "Do not run more repairs yet; first reduce default Capsule/agent tokens because recovery cost is too high.",
  C: "Run only one more repair smoke on a NEW unique candidate, then update the policy accounting.",
  D: "Stop duplicate Requests repair runs. Shift back to reducing default VTRACE first-pass token use and/or expand the controlled set with new unique high-risk tasks before more repair experiments.",
};

// Pick exactly one recommendation from the computed metrics. The decision is driven by
// UNIQUE TASK conversions, never by artifact rows — re-running repair on an already-
// recovered instance produces more artifacts but no new resolved task.
// - No unique task conversion → B (no evidence repair helps; the lever is token reduction).
// - Unique conversions did NOT improve cost-per-resolved → B.
// - >=3 unique task conversions improved cost-per-resolved → A (scale).
// - Improved, <3 unique, but duplicate artifacts already exist for recovered instances → D
//   (stop duplicate runs; the marginal artifact added no unique recovery).
// - Improved, <3 unique, no duplicate artifacts yet → C (one more smoke on a NEW unique candidate).
export function pickRecommendation(args: {
  readonly vtraceFirstPatch: PolicyMetrics;
  readonly verifiedRepair: PolicyMetrics;
}): Recommendation {
  const { vtraceFirstPatch, verifiedRepair } = args;
  const taskConversions = verifiedRepair.taskConversionCount;
  const artifacts = verifiedRepair.artifactConversionCount;
  const duplicateArtifacts = artifacts > taskConversions;
  const before = vtraceFirstPatch.costPerResolved;
  const after = verifiedRepair.costPerResolved;
  const improvedCostPerResolved = before !== null && after !== null && after < before;

  if (taskConversions === 0) {
    return {
      choice: "B",
      statement: RECOMMENDATION_TEXT.B,
      rationale: "No verified repaired-patch conversion exists, so there is no evidence gated repair improves resolution; the dominant lever is reducing default Capsule/agent tokens.",
    };
  }
  if (!improvedCostPerResolved) {
    return {
      choice: "B",
      statement: RECOMMENDATION_TEXT.B,
      rationale: "The verified conversion(s) did not improve cost-per-resolved over vtrace_first_patch; repair overhead currently outweighs the resolution gain, so reduce default tokens first.",
    };
  }
  if (taskConversions >= 3) {
    return {
      choice: "A",
      statement: RECOMMENDATION_TEXT.A,
      rationale: `${taskConversions} unique task conversions improved cost-per-resolved (from ${fmtUsd(before)} to ${fmtUsd(after)} per resolved); the evidence base is now broad enough to justify a batch of new unique candidates.`,
    };
  }
  if (duplicateArtifacts) {
    return {
      choice: "D",
      statement: RECOMMENDATION_TEXT.D,
      rationale: `${artifacts} verified repair artifacts improved cost-per-resolved (from ${fmtUsd(before)} to ${fmtUsd(after)} per resolved), but they cover only ${taskConversions} unique controlled task${taskConversions === 1 ? "" : "s"}; the extra artifacts re-ran repair on an already-recovered instance and added no new task recovery. Running more duplicate Requests repairs cannot raise the unique-task count, so stop duplicate runs and instead reduce default VTRACE first-pass tokens and/or add new unique high-risk tasks.`,
    };
  }
  return {
    choice: "C",
    statement: RECOMMENDATION_TEXT.C,
    rationale: `${taskConversions} unique task conversion${taskConversions === 1 ? "" : "s"} improved cost-per-resolved within vtrace (from ${fmtUsd(before)} to ${fmtUsd(after)} per resolved) and recovery was cheap (${fmtUsd(verifiedRepair.criticCostUsd)} critic + ${fmtUsd(verifiedRepair.repairCostUsd)} repair), but n=${taskConversions} is still too thin to commit to a batch (the batch threshold is 3 unique task conversions); gather one more verified conversion on a NEW unique instance and re-account.`,
  };
}

// ---------------------------------------------------------------------------
// Report (pure)
// ---------------------------------------------------------------------------

export interface PolicyAccountingReport {
  readonly generatedAt: string | null;
  readonly summary: {
    readonly taskCount: number;
    // Artifact-level: total verified repaired-patch artifacts resolved under Docker.
    readonly verifiedRepairArtifacts: number;
    // Task-level: unique controlled tasks recovered (de-duplicated by instance).
    readonly uniqueTaskConversions: number;
    readonly baselineResolved: number;
    readonly vtraceFirstPatchResolved: number;
    readonly gatedRepairResolved: number;
    readonly recoveryCostAddedUsd: number | null;
    readonly headline: string;
  };
  // Distinct controlled-task instances recovered by a verified conversion (sorted).
  readonly uniqueTaskRecoveries: readonly string[];
  readonly policies: readonly PolicyMetrics[];
  readonly tasks: ReadonlyArray<{
    readonly instanceId: string;
    readonly baselineResolved: boolean | null;
    readonly vtraceResolved: boolean | null;
    readonly gatedRepairResolved: boolean | null;
    readonly baselineCostUsd: number | null;
    readonly vtraceCostUsd: number | null;
    readonly baselineTokens: number | null;
    readonly vtraceTokens: number | null;
    readonly verifiedConversion: boolean;
  }>;
  readonly conversions: ReadonlyArray<{
    readonly runLabel: string;
    readonly instanceId: string;
    readonly firstPatchResolved: boolean | null;
    readonly repairedPatchResolved: boolean | null;
    readonly convertedUnresolvedToResolved: boolean;
    readonly criticCostUsd: number | null;
    readonly repairCostUsd: number | null;
    readonly totalRecoveryCostUsd: number | null;
  }>;
  readonly costSources: readonly string[];
  readonly tokenSources: readonly string[];
  readonly recommendation: Recommendation;
  readonly nonClaims: readonly string[];
}

export const NON_CLAIMS: readonly string[] = [
  "This is not a VEXP comparison.",
  "This is not a statistically meaningful SWE-bench benchmark.",
  "This does not prove aggregate resolution improvement.",
  "This does not justify always-on critic/repair.",
  "This does not change production behavior.",
  "This only accounts for observed artifacts and verified repaired-patch evaluations.",
];

export const COST_SOURCES: readonly string[] = [
  "agentCostUsd ← stage5_controlled_10_task_plan.json selectedTasks (baselineCost / vtraceCost).",
  "criticCostUsd ← stage5_live_critic_high_risk_comparison.json (mean per-instance observation) and stage5_repair_conversion_*.json costs.criticCostUsd (verified conversions).",
  "repairCostUsd ← stage5_repair_conversion_*.json costs.repairCostUsd (verified conversions only).",
];

export const TOKEN_SOURCES: readonly string[] = [
  "agent tokens ← stage5_controlled_10_task_plan.json selectedTasks (baselineTokens / vtraceTokens; total tokens incl. cache).",
  "critic tokens ← stage5_live_critic_high_risk_comparison.json and stage5_repair_conversion_*.json costs.criticInput/OutputTokens.",
  "repair tokens ← stage5_repair_conversion_*.json costs.repairInput/OutputTokens (verified conversions only).",
];

function fmtUsd(v: number | null): string {
  return v === null ? "n/a" : `$${v.toFixed(4)}`;
}
function fmtNum(v: number | null): string {
  return v === null ? "null" : String(Math.round(v));
}
function tri(v: boolean | null): string {
  return v === null ? "unknown" : v ? "true" : "false";
}

export function buildReport(args: { readonly generatedAt: string | null; readonly inputs: AccountingInputs }): PolicyAccountingReport {
  const { generatedAt, inputs } = args;
  const policies = POLICY_SPECS.map((spec) => computePolicyMetrics(spec, inputs));
  const byName = new Map(policies.map((p) => [p.policyName, p]));
  const baseline = byName.get("baseline")!;
  const vtraceFirstPatch = byName.get("vtrace_first_patch")!;
  const gatedRepair = byName.get("vtrace_with_observed_gated_repair")!;
  const verifiedRepair = byName.get("vtrace_with_verified_repair_cost")!;

  const verifiedConversions = inputs.conversions.filter((c) => c.convertedUnresolvedToResolved);
  const verifiedByInstance = new Map(verifiedConversions.map((c) => [c.instanceId, c]));
  const taskInstanceIds = new Set(inputs.tasks.map((t) => t.instanceId));
  const uniqueTaskRecoveries = [...new Set(verifiedConversions.filter((c) => taskInstanceIds.has(c.instanceId)).map((c) => c.instanceId))].sort();

  const recommendation = pickRecommendation({ vtraceFirstPatch, verifiedRepair });
  const recoveryCostAddedUsd = addNullable(verifiedRepair.criticCostUsd, verifiedRepair.repairCostUsd);

  const verifiedRepairArtifacts = verifiedRepair.artifactConversionCount;
  const uniqueTaskConversions = verifiedRepair.taskConversionCount;

  const headline = (() => {
    const before = vtraceFirstPatch.costPerResolved;
    const after = verifiedRepair.costPerResolved;
    const dir = before !== null && after !== null ? (after < before ? "improved" : after > before ? "worsened" : "unchanged") : "n/a";
    return (
      `${verifiedRepairArtifacts} verified repaired-patch artifact(s) resolved under Docker, corresponding to ${uniqueTaskConversions} unique controlled task recovery(ies). ` +
      `vtrace_first_patch resolved ${vtraceFirstPatch.resolvedCount}/${vtraceFirstPatch.taskCount} → ` +
      `gated repair ${gatedRepair.resolvedCount}/${gatedRepair.taskCount}. Cost-per-resolved ${dir} ` +
      `(${fmtUsd(before)} → ${fmtUsd(after)} with recovery cost included). Baseline remains ${baseline.resolvedCount}/${baseline.taskCount} at ${fmtUsd(baseline.costPerResolved)}/resolved.`
    );
  })();

  return {
    generatedAt,
    summary: {
      taskCount: vtraceFirstPatch.taskCount,
      verifiedRepairArtifacts,
      uniqueTaskConversions,
      baselineResolved: baseline.resolvedCount,
      vtraceFirstPatchResolved: vtraceFirstPatch.resolvedCount,
      gatedRepairResolved: gatedRepair.resolvedCount,
      recoveryCostAddedUsd,
      headline,
    },
    uniqueTaskRecoveries,
    policies,
    tasks: inputs.tasks.map((t) => {
      const verified = verifiedByInstance.has(t.instanceId);
      return {
        instanceId: t.instanceId,
        baselineResolved: t.baselineResolved,
        vtraceResolved: t.vtraceResolved,
        gatedRepairResolved: verified ? true : t.vtraceResolved,
        baselineCostUsd: t.baselineCostUsd,
        vtraceCostUsd: t.vtraceCostUsd,
        baselineTokens: t.baselineTokens,
        vtraceTokens: t.vtraceTokens,
        verifiedConversion: verified,
      };
    }),
    conversions: inputs.conversions.map((c) => ({
      runLabel: c.runLabel,
      instanceId: c.instanceId,
      firstPatchResolved: c.firstPatchResolved,
      repairedPatchResolved: c.repairedPatchResolved,
      convertedUnresolvedToResolved: c.convertedUnresolvedToResolved,
      criticCostUsd: c.criticCostUsd,
      repairCostUsd: c.repairCostUsd,
      totalRecoveryCostUsd: c.totalRecoveryCostUsd,
    })),
    costSources: COST_SOURCES,
    tokenSources: TOKEN_SOURCES,
    recommendation,
    nonClaims: NON_CLAIMS,
  };
}

export function renderJson(report: PolicyAccountingReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderMarkdown(report: PolicyAccountingReport): string {
  const L: string[] = [];
  const { summary, policies } = report;
  const byName = new Map(policies.map((p) => [p.policyName, p]));
  const baseline = byName.get("baseline")!;
  const vtrace = byName.get("vtrace_first_patch")!;
  const gated = byName.get("vtrace_with_observed_gated_repair")!;
  const verified = byName.get("vtrace_with_verified_repair_cost")!;

  L.push("# Stage 5 policy accounting");
  L.push("");
  if (report.generatedAt) L.push(`_Generated: ${report.generatedAt}_`, "");
  L.push("_Reporting/accounting only. Re-runs nothing (no agent, no live critic, no repair, no Docker); accounts for observed artifacts and verified repaired-patch evaluations over the controlled task set._");
  L.push("");

  L.push("## Summary");
  L.push("");
  L.push(summary.headline);
  L.push("");
  L.push(`- controlled tasks: **${summary.taskCount}**`);
  L.push(`- verified repair artifacts: **${summary.verifiedRepairArtifacts}**`);
  L.push(`- unique task recoveries: **${summary.uniqueTaskConversions}**${report.uniqueTaskRecoveries.length > 0 ? ` (${report.uniqueTaskRecoveries.join(", ")})` : ""}`);
  L.push(`- resolved: baseline **${summary.baselineResolved}**, vtrace_first_patch **${summary.vtraceFirstPatchResolved}**, gated repair **${summary.gatedRepairResolved}**`);
  L.push(`- recovery cost added (critic+repair): **${fmtUsd(summary.recoveryCostAddedUsd)}**`);
  L.push("");

  L.push("## Policies compared");
  L.push("");
  for (const p of policies) L.push(`- \`${p.policyName}\` — ${p.description}`);
  L.push("");

  L.push("## Resolution results");
  L.push("");
  L.push("| policy | tasks | resolved | unresolved | unknown | task conversions |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const p of policies) {
    L.push(`| ${p.policyName} | ${p.taskCount} | ${p.resolvedCount} | ${p.unresolvedCount} | ${p.unknownCount} | ${p.taskConversionCount} |`);
  }
  L.push("");
  L.push("_`task conversions` counts unique controlled tasks recovered (de-duplicated by instance), not artifact rows._");
  L.push("");

  L.push("## Cost accounting");
  L.push("");
  L.push("| policy | agent $ | critic $ | repair $ | total $ | mean $ |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const p of policies) {
    L.push(`| ${p.policyName} | ${fmtUsd(p.agentCostUsd)} | ${fmtUsd(p.criticCostUsd)} | ${fmtUsd(p.repairCostUsd)} | ${fmtUsd(p.totalCostUsd)} | ${fmtUsd(p.meanCostUsd)} |`);
  }
  L.push("");

  L.push("## Token accounting");
  L.push("");
  L.push("| policy | total tokens | mean tokens | critic in | critic out | repair in | repair out |");
  L.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const p of policies) {
    L.push(
      `| ${p.policyName} | ${fmtNum(p.totalTokens)} | ${fmtNum(p.meanTokens)} | ${fmtNum(p.criticInputTokens)} | ${fmtNum(p.criticOutputTokens)} | ${fmtNum(p.repairInputTokens)} | ${fmtNum(p.repairOutputTokens)} |`,
    );
  }
  L.push("");

  L.push("## Cost per resolved task");
  L.push("");
  L.push("| policy | resolved | total $ | cost / resolved |");
  L.push("| --- | --- | --- | --- |");
  for (const p of policies) L.push(`| ${p.policyName} | ${p.resolvedCount} | ${fmtUsd(p.totalCostUsd)} | ${fmtUsd(p.costPerResolved)} |`);
  L.push("");

  L.push("## Token per resolved task");
  L.push("");
  L.push("| policy | resolved | total tokens | tokens / resolved |");
  L.push("| --- | --- | --- | --- |");
  for (const p of policies) L.push(`| ${p.policyName} | ${p.resolvedCount} | ${fmtNum(p.totalTokens)} | ${fmtNum(p.tokensPerResolved)} |`);
  L.push("");

  L.push("## Verified repair artifacts included");
  L.push("");
  const convertedArtifacts = report.conversions.filter((c) => c.convertedUnresolvedToResolved);
  if (report.conversions.length === 0) {
    L.push("_No repair conversions found._");
  } else {
    L.push(`${convertedArtifacts.length} verified repaired-patch artifact(s) resolved under Docker, corresponding to ${report.summary.uniqueTaskConversions} unique controlled task recovery(ies). Each artifact row below is an individual repair run; multiple rows for one instance are still one task recovery.`);
    L.push("");
    L.push("| run | instance | first resolved | repaired resolved | converted | critic $ | repair $ | recovery $ |");
    L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const c of report.conversions) {
      L.push(
        `| ${c.runLabel} | ${c.instanceId} | ${tri(c.firstPatchResolved)} | ${tri(c.repairedPatchResolved)} | ${tri(c.convertedUnresolvedToResolved)} | ${fmtUsd(c.criticCostUsd)} | ${fmtUsd(c.repairCostUsd)} | ${fmtUsd(c.totalRecoveryCostUsd)} |`,
      );
    }
  }
  L.push("");

  L.push("## Unique task recoveries");
  L.push("");
  if (report.uniqueTaskRecoveries.length === 0) {
    L.push("_No unique controlled task recoveries._");
  } else {
    L.push(`${report.uniqueTaskRecoveries.length} unique controlled task(s) recovered (de-duplicated by instance):`);
    L.push("");
    for (const id of report.uniqueTaskRecoveries) L.push(`- \`${id}\``);
    L.push("");
    L.push("_Resolved-count effect and the recommendation are driven by these unique task recoveries, not by the artifact rows above. Recovery cost counts one representative repair artifact per unique task recovery (a realistic gated policy runs repair once per task), so duplicate artifacts for the same instance do not multiply cost._");
  }
  L.push("");
  L.push("_Cost sources:_");
  for (const s of report.costSources) L.push(`- ${s}`);
  L.push("");
  L.push("_Token sources:_");
  for (const s of report.tokenSources) L.push(`- ${s}`);
  L.push("");

  L.push("## Interpretation");
  L.push("");
  const improvedCost = vtrace.costPerResolved !== null && verified.costPerResolved !== null && verified.costPerResolved < vtrace.costPerResolved;
  const improvedTokens = vtrace.tokensPerResolved !== null && gated.tokensPerResolved !== null && gated.tokensPerResolved < vtrace.tokensPerResolved;
  L.push(`1. **Did the verified repair conversion improve resolved count?** ${summary.gatedRepairResolved > summary.vtraceFirstPatchResolved ? `Yes — vtrace_first_patch ${summary.vtraceFirstPatchResolved} → gated repair ${summary.gatedRepairResolved} (+${summary.gatedRepairResolved - summary.vtraceFirstPatchResolved}).` : "No change."}`);
  L.push(`2. **How much extra cost/tokens did recovery add?** ${fmtUsd(summary.recoveryCostAddedUsd)} and ${fmtNum(addNullableForReport(verified.criticInputTokens, verified.criticOutputTokens, verified.repairInputTokens, verified.repairOutputTokens))} tokens, for the verified conversion(s) only.`);
  L.push(`3. **Did cost per resolved improve or worsen?** Within vtrace it ${improvedCost ? "**improved**" : "did not improve"} (${fmtUsd(vtrace.costPerResolved)} → ${fmtUsd(verified.costPerResolved)} with recovery cost). Baseline is still cheaper at ${fmtUsd(baseline.costPerResolved)}/resolved.`);
  L.push(`4. **Did tokens per resolved improve or worsen?** Within vtrace it ${improvedTokens ? "**improved**" : "did not improve"} (${fmtNum(vtrace.tokensPerResolved)} → ${fmtNum(gated.tokensPerResolved)}). Baseline is still leaner at ${fmtNum(baseline.tokensPerResolved)}/resolved.`);
  L.push(`5. **Is there enough unique-task evidence to scale up repair experiments?** ${summary.uniqueTaskConversions >= 3 ? `Yes — ${summary.uniqueTaskConversions} unique task conversions.` : `Not yet — ${summary.verifiedRepairArtifacts} verified repair artifacts, but only ${summary.uniqueTaskConversions} unique controlled task conversions (re-running repair on an already-recovered instance adds artifacts, not unique recoveries).`}`);
  L.push("6. **Does this support always-on critic/repair?** **No.** Gated, disabled-by-default repair recovered one lost resolution cheaply, but vtrace_first_patch is still behind baseline; the dominant lever is reducing default Capsule/agent tokens, not always-on repair.");
  L.push("");

  L.push("## Recommended next step");
  L.push("");
  L.push(`**Option ${report.recommendation.choice}.** ${report.recommendation.statement}`);
  L.push("");
  L.push(report.recommendation.rationale);
  L.push("");

  L.push("## Non-claims");
  L.push("");
  for (const n of report.nonClaims) L.push(`- ${n}`);
  L.push("");

  return `${L.join("\n")}\n`;
}

// Small helper used only for the interpretation token line (sum of present token legs).
function addNullableForReport(...values: ReadonlyArray<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// Main (impure)
// ---------------------------------------------------------------------------

export async function run(config: CliConfig): Promise<PolicyAccountingReport> {
  const generatedAt = new Date().toISOString();
  const inputs = await loadAccountingInputs(config.resultsDir);
  const report = buildReport({ generatedAt, inputs });

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  const v = report.policies.find((p) => p.policyName === "vtrace_first_patch")!;
  const r = report.policies.find((p) => p.policyName === "vtrace_with_verified_repair_cost")!;
  process.stdout.write(
    [
      "Stage 5 policy accounting written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Tasks: ${report.summary.taskCount}   Verified repair artifacts: ${report.summary.verifiedRepairArtifacts}   Unique task recoveries: ${report.summary.uniqueTaskConversions}`,
      `Resolved — baseline: ${report.summary.baselineResolved}   vtrace_first_patch: ${report.summary.vtraceFirstPatchResolved}   gated repair: ${report.summary.gatedRepairResolved}`,
      `Cost/resolved — vtrace_first_patch: ${fmtUsd(v.costPerResolved)}   verified repair: ${fmtUsd(r.costPerResolved)}`,
      `Recommendation: Option ${report.recommendation.choice} — ${report.recommendation.statement}`,
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
