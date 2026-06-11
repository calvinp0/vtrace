// Stage 5 POLICY ACCOUNTING report (cost / tokens per resolved task). READ-ONLY.
//
// SCOPE: reporting/accounting only. This runner reads the already-generated
// controlled-task plan, the strict-gated 10-task report, the live-critic comparison,
// and the verified repair-conversion evidence, and compares cost, tokens, and resolved
// count across a set of POLICIES over the same controlled task set. It accounts for
// strict-gated first-pass VTRACE (the internal Stage 5 default) as a first-class policy
// alongside old VTRACE first patch and the old verified-repair accounting, and answers
// the token-reduction question: does the strict gate (and gated repair) improve
// cost/tokens per resolved task, or merely add overhead?
//
// REPAIR BOUNDARY: verified repaired-patch conversions are tied to the OLD VTRACE first
// patches. They are NEVER transferred to strict first-pass accounting; a strict repair
// policy row would require strict-specific repaired-patch evaluation, which does not
// exist. Strict resolution is read straight from the committed strict run artifacts.
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

// One controlled task: its baseline, OLD vtrace-first-patch, and STRICT-gated
// first-pass outcomes. Resolution may be genuinely unknown (null); cost/tokens may be
// absent (null) and are never invented. The strict legs are joined by instanceId from
// the committed strict-gated 10-task report and stay null when no strict run exists.
export interface ControlledTask {
  readonly instanceId: string;
  readonly vtraceRunLabel: string | null;
  readonly baselineResolved: boolean | null;
  readonly vtraceResolved: boolean | null;
  readonly baselineCostUsd: number | null;
  readonly vtraceCostUsd: number | null;
  readonly baselineTokens: number | null;
  readonly vtraceTokens: number | null;
  // Strict-gated first-pass leg (read straight from the strict run artifacts; never a
  // transfer of old repair conversions).
  readonly strictRunLabel: string | null;
  readonly strictResolved: boolean | null;
  readonly strictCostUsd: number | null;
  readonly strictTokens: number | null;
}

// One strict-gated first-pass result, parsed from the strict 10-task report and joined
// to a controlled task by instanceId.
export interface StrictResult {
  readonly instanceId: string;
  readonly runLabel: string | null;
  readonly resolved: boolean | null;
  readonly costUsd: number | null;
  readonly tokens: number | null;
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

export function parseControlledTasks(
  plan: PlanDoc | null,
  strictByInstance: ReadonlyMap<string, StrictResult> = new Map(),
): ControlledTask[] {
  const selected = plan?.selectedTasks ?? [];
  return selected.map((t) => {
    const instanceId = asStr(t.instanceId) ?? "unknown";
    const strict = strictByInstance.get(instanceId) ?? null;
    return {
      instanceId,
      vtraceRunLabel: asStr(t.vtraceRunLabel),
      baselineResolved: asBool(t.baselineResolved),
      vtraceResolved: asBool(t.vtraceResolved),
      baselineCostUsd: asNum(t.baselineCost),
      vtraceCostUsd: asNum(t.vtraceCost),
      baselineTokens: asNum(t.baselineTokens),
      vtraceTokens: asNum(t.vtraceTokens),
      strictRunLabel: strict?.runLabel ?? null,
      strictResolved: strict?.resolved ?? null,
      strictCostUsd: strict?.costUsd ?? null,
      strictTokens: strict?.tokens ?? null,
    };
  });
}

interface StrictReportDoc {
  readonly tasks?: ReadonlyArray<{
    readonly instanceId?: string;
    readonly strictLabel?: string | null;
    readonly strict?: {
      readonly resolved?: boolean | null;
      readonly costUsd?: number | null;
      readonly totalTokens?: number | null;
    } | null;
  }>;
}

// Parse strict-gated first-pass results from the committed strict 10-task report. Each
// task's `strict` leg is the first-pass strict run; null legs (no strict run) are
// dropped so they stay genuinely absent rather than fabricated.
export function parseStrictResults(doc: StrictReportDoc | null): StrictResult[] {
  const tasks = doc?.tasks ?? [];
  const out: StrictResult[] = [];
  for (const t of tasks) {
    const instanceId = asStr(t.instanceId);
    if (instanceId === null) continue;
    const s = t.strict ?? null;
    out.push({
      instanceId,
      runLabel: asStr(t.strictLabel),
      resolved: s ? asBool(s.resolved) : null,
      costUsd: s ? asNum(s.costUsd) : null,
      tokens: s ? asNum(s.totalTokens) : null,
    });
  }
  return out;
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
  // Strict-gated first-pass results, joined to the controlled tasks by instanceId.
  // Missing report → strict legs stay null (the policy reports as all-unknown rather
  // than inventing strict outcomes).
  const strictDoc = await readJson<StrictReportDoc>(path.join(resultsDir, "stage5_strictgated_10task_report.json"));
  const strictByInstance = new Map(parseStrictResults(strictDoc).map((s) => [s.instanceId, s]));
  const tasks = parseControlledTasks(plan, strictByInstance);

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

export type ResolutionBasis = "baseline" | "vtrace" | "strict";

// Resolution / cost / token selectors for a metric basis. "vtrace" is OLD VTRACE first
// patch; "strict" is the strict-gated first-pass leg. Centralised so adding a basis is
// a single edit, not three scattered ternaries.
function resolvedForBasis(task: ControlledTask, basis: ResolutionBasis): boolean | null {
  if (basis === "baseline") return task.baselineResolved;
  if (basis === "strict") return task.strictResolved;
  return task.vtraceResolved;
}
function costForBasis(task: ControlledTask, basis: ResolutionBasis): number | null {
  if (basis === "baseline") return task.baselineCostUsd;
  if (basis === "strict") return task.strictCostUsd;
  return task.vtraceCostUsd;
}
function tokensForBasis(task: ControlledTask, basis: ResolutionBasis): number | null {
  if (basis === "baseline") return task.baselineTokens;
  if (basis === "strict") return task.strictTokens;
  return task.vtraceTokens;
}

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

// Policy rows. Names are explicit about the first-pass leg they account for:
//   baseline                                    — no VTRACE.
//   old_vtrace_first_patch                      — OLD VTRACE first patch (pre strict gate).
//   old_vtrace_with_observed_gated_repair       — old first patch, verified conversions → resolution only.
//   old_vtrace_with_live_critic_observation_cost— old first patch + live-critic overhead, resolution unchanged.
//   old_vtrace_with_verified_repair             — old first patch + verified critic+repair recovery (realistic gated repair).
//   strict_vtrace_first_patch                   — STRICT-gated first pass (the internal Stage 5 default).
// Repair conversions are tied to the OLD first patches and are NEVER applied to the
// strict row (no strict repaired-patch artifacts exist).
export const POLICY_SPECS: readonly PolicySpec[] = [
  {
    policyName: "baseline",
    description: "Existing baseline result for each controlled task (no VTRACE).",
    resolutionBasis: "baseline",
    costBasis: "baseline",
    tokenBasis: "baseline",
    applyConversions: false,
    addCriticObservation: false,
    addVerifiedRecoveryCost: false,
  },
  {
    policyName: "old_vtrace_first_patch",
    description: "Old VTRACE first-patch result before the strict gate and before critic/repair.",
    resolutionBasis: "vtrace",
    costBasis: "vtrace",
    tokenBasis: "vtrace",
    applyConversions: false,
    addCriticObservation: false,
    addVerifiedRecoveryCost: false,
  },
  {
    policyName: "strict_vtrace_first_patch",
    description: "Strict-gated first-pass VTRACE (the internal Stage 5 default). First patch only — NO repair conversions are transferred from old VTRACE.",
    resolutionBasis: "strict",
    costBasis: "strict",
    tokenBasis: "strict",
    applyConversions: false,
    addCriticObservation: false,
    addVerifiedRecoveryCost: false,
  },
  {
    policyName: "old_vtrace_with_observed_gated_repair",
    description: "old_vtrace_first_patch with verified repaired-patch conversions applied to RESOLUTION only (recovery cost not added — optimistic ceiling).",
    resolutionBasis: "vtrace",
    costBasis: "vtrace",
    tokenBasis: "vtrace",
    applyConversions: true,
    addCriticObservation: false,
    addVerifiedRecoveryCost: false,
  },
  {
    policyName: "old_vtrace_with_live_critic_observation_cost",
    description: "old_vtrace_first_patch plus live-critic observation cost where critic was run; resolution UNCHANGED (pure overhead).",
    resolutionBasis: "vtrace",
    costBasis: "vtrace",
    tokenBasis: "vtrace",
    applyConversions: false,
    addCriticObservation: true,
    addVerifiedRecoveryCost: false,
  },
  {
    policyName: "old_vtrace_with_verified_repair",
    description: "Realistic OLD-VTRACE gated repair: verified conversions change resolution AND add critic+repair cost only for those conversions. Tied to the old first patches, never strict.",
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
    let resolved = resolvedForBasis(task, spec.resolutionBasis);
    const conv = verifiedByInstance.get(task.instanceId);
    if (spec.applyConversions && conv) {
      resolved = true;
      taskConversionCount += 1;
    }
    if (resolved === true) resolvedCount += 1;
    else if (resolved === false) unresolvedCount += 1;
    else unknownCount += 1;

    // --- agent cost / tokens ---
    agentCosts.push(costForBasis(task, spec.costBasis));
    agentTokens.push(tokensForBasis(task, spec.tokenBasis));

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
// Cross-policy deltas (vs baseline and vs old VTRACE first patch)
// ---------------------------------------------------------------------------

// Each policy reported alongside its deltas against the two reference policies.
// Resolution deltas are integer counts (always present); token/cost deltas are null
// when either side is null (never fabricated).
export interface PolicyMetricsWithDeltas extends PolicyMetrics {
  readonly resolutionDeltaVsBaseline: number;
  readonly tokensDeltaVsBaseline: number | null;
  readonly costDeltaVsBaseline: number | null;
  readonly resolutionDeltaVsOldVtrace: number;
  readonly tokensDeltaVsOldVtrace: number | null;
  readonly costDeltaVsOldVtrace: number | null;
}

function diffNullable(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a - b;
}

export function withDeltas(
  policies: readonly PolicyMetrics[],
  baseline: PolicyMetrics,
  oldVtrace: PolicyMetrics,
): PolicyMetricsWithDeltas[] {
  return policies.map((p) => ({
    ...p,
    resolutionDeltaVsBaseline: p.resolvedCount - baseline.resolvedCount,
    tokensDeltaVsBaseline: diffNullable(p.totalTokens, baseline.totalTokens),
    costDeltaVsBaseline: diffNullable(p.totalCostUsd, baseline.totalCostUsd),
    resolutionDeltaVsOldVtrace: p.resolvedCount - oldVtrace.resolvedCount,
    tokensDeltaVsOldVtrace: diffNullable(p.totalTokens, oldVtrace.totalTokens),
    costDeltaVsOldVtrace: diffNullable(p.totalCostUsd, oldVtrace.totalCostUsd),
  }));
}

// ---------------------------------------------------------------------------
// Strict-specific repair recommendation (deterministic, data-driven)
// ---------------------------------------------------------------------------

// A strict-specific repair smoke is warranted ONLY for a controlled task that is BOTH
// (a) unresolved under the strict first pass AND (b) backed by prior verified OLD-VTRACE
// repair evidence for the same instance (the defect class is plausibly recoverable). We
// never recommend duplicating old repair experiments or full 10-task reruns.
export interface StrictRepairRecommendation {
  readonly recommend: boolean;
  readonly targets: ReadonlyArray<{ readonly instanceId: string; readonly strictRunLabel: string | null }>;
  readonly statement: string;
  readonly rationale: string;
}

function shortRepoName(instanceId: string): string {
  // "psf__requests-5414" → "Requests"; "django__django-11490" → "Django".
  const repo = instanceId.includes("__") ? instanceId.split("__")[1]!.split("-")[0]! : instanceId.split("-")[0]!;
  return repo.charAt(0).toUpperCase() + repo.slice(1);
}

export function pickStrictRepairRecommendation(args: {
  readonly tasks: readonly ControlledTask[];
  readonly conversions: readonly Conversion[];
}): StrictRepairRecommendation {
  const verifiedInstances = new Set(
    args.conversions.filter((c) => c.convertedUnresolvedToResolved).map((c) => c.instanceId),
  );
  const candidates = args.tasks.filter(
    (t) => t.strictResolved === false && verifiedInstances.has(t.instanceId),
  );
  if (candidates.length === 0) {
    return {
      recommend: false,
      targets: [],
      statement:
        "No strict-specific repair experiment is warranted: every controlled task that is still unresolved under the strict first pass lacks prior verified OLD-VTRACE repair evidence, so there is no defect-class signal that strict-specific repair would recover.",
      rationale:
        "A strict repair smoke is only justified when an unresolved-under-strict task already has a verified OLD-VTRACE repaired-patch conversion (evidence the defect class is recoverable). Do not duplicate old repair experiments or run full 10-task reruns.",
    };
  }
  const targets = candidates.map((t) => ({ instanceId: t.instanceId, strictRunLabel: t.strictRunLabel }));
  const labelList = targets.map((t) => t.strictRunLabel ?? t.instanceId).join(", ");
  const repoList = [...new Set(candidates.map((t) => shortRepoName(t.instanceId)))].join(", ");
  return {
    recommend: true,
    targets,
    statement:
      `Run a strict-specific repair smoke/evaluation only for ${labelList}, because ${repoList} ` +
      `remains unresolved under strict and prior old-VTRACE repair evidence suggests this defect class may be recoverable.`,
    rationale:
      `${repoList} is unresolved under the strict first pass but was recovered by a verified OLD-VTRACE repaired patch, so a strict-specific repair smoke targets exactly the lost task. ` +
      "Do NOT transfer the old repair conversion to strict accounting, do NOT re-run already-recovered old repair experiments, and do NOT trigger a full 10-task rerun.",
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
    readonly oldVtraceFirstPatchResolved: number;
    readonly strictVtraceFirstPatchResolved: number;
    readonly gatedRepairResolved: number;
    readonly recoveryCostAddedUsd: number | null;
    readonly headline: string;
  };
  // Strict-gated first-pass accounting against the two reference policies.
  readonly strictAccounting: {
    readonly taskCount: number;
    readonly strictResolved: number;
    readonly oldVtraceResolved: number;
    readonly baselineResolved: number;
    readonly strictTotalTokens: number | null;
    readonly oldVtraceTotalTokens: number | null;
    readonly baselineTotalTokens: number | null;
    readonly strictTotalCostUsd: number | null;
    readonly oldVtraceTotalCostUsd: number | null;
    readonly baselineTotalCostUsd: number | null;
    readonly strictCostPerResolved: number | null;
    readonly strictTokensPerResolved: number | null;
    readonly resolutionDeltaVsOldVtrace: number;
    readonly tokensDeltaVsOldVtrace: number | null;
    readonly costDeltaVsOldVtrace: number | null;
    readonly resolutionDeltaVsBaseline: number;
    readonly tokensDeltaVsBaseline: number | null;
    readonly costDeltaVsBaseline: number | null;
    readonly improvesOverOldVtrace: boolean;
    readonly behindBaselineBy: number;
    readonly fewerTokensThanBaseline: boolean;
    readonly lowerCostThanBaseline: boolean;
  };
  // Distinct controlled-task instances recovered by a verified conversion (sorted).
  readonly uniqueTaskRecoveries: readonly string[];
  readonly policies: readonly PolicyMetricsWithDeltas[];
  readonly tasks: ReadonlyArray<{
    readonly instanceId: string;
    readonly baselineResolved: boolean | null;
    readonly vtraceResolved: boolean | null;
    readonly strictResolved: boolean | null;
    readonly gatedRepairResolved: boolean | null;
    readonly baselineCostUsd: number | null;
    readonly vtraceCostUsd: number | null;
    readonly strictCostUsd: number | null;
    readonly baselineTokens: number | null;
    readonly vtraceTokens: number | null;
    readonly strictTokens: number | null;
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
  // The strict-specific repair recommendation drives the "Recommended next step"
  // section; `recommendation` is retained for the OLD-VTRACE repair-experiment guidance.
  readonly strictRecommendation: StrictRepairRecommendation;
  readonly recommendation: Recommendation;
  readonly repairBoundary: readonly string[];
  readonly nonClaims: readonly string[];
}

// The accounting boundary that separates verified OLD-VTRACE repair from strict first-pass.
export const REPAIR_BOUNDARY: readonly string[] = [
  "Verified old repair conversions are tied to the old VTRACE first patches. They are not automatically counted as strict repairs unless strict-specific repaired-patch evaluation exists.",
  "These conversions are accounted under `old_vtrace_with_verified_repair`, never under a `strict_with_repair` row.",
  "No strict repair policy row exists because no strict repaired-patch artifacts exist. Strict resolution is read straight from the strict first-pass run artifacts.",
];

export const NON_CLAIMS: readonly string[] = [
  "This is not a VEXP comparison.",
  "This is not a statistically meaningful SWE-bench benchmark.",
  "This does not prove aggregate resolution improvement.",
  "This does not justify always-on critic/repair.",
  "This does not change production behavior.",
  "This only accounts for observed artifacts and verified repaired-patch evaluations.",
  "strict_vtrace_first_patch using fewer total tokens and lower total cost than baseline does NOT imply a higher success rate — strict remains behind baseline on resolved count.",
  "Verified old repair conversions are NOT transferred to strict accounting; strict carries no repair recovery.",
];

export const COST_SOURCES: readonly string[] = [
  "old agentCostUsd ← stage5_controlled_10_task_plan.json selectedTasks (baselineCost / vtraceCost).",
  "strict agentCostUsd ← stage5_strictgated_10task_report.json tasks[].strict.costUsd (joined by instanceId).",
  "criticCostUsd ← stage5_live_critic_high_risk_comparison.json (mean per-instance observation) and stage5_repair_conversion_*.json costs.criticCostUsd (verified OLD-VTRACE conversions).",
  "repairCostUsd ← stage5_repair_conversion_*.json costs.repairCostUsd (verified OLD-VTRACE conversions only).",
];

export const TOKEN_SOURCES: readonly string[] = [
  "old agent tokens ← stage5_controlled_10_task_plan.json selectedTasks (baselineTokens / vtraceTokens; total tokens incl. cache).",
  "strict agent tokens ← stage5_strictgated_10task_report.json tasks[].strict.totalTokens (joined by instanceId).",
  "critic tokens ← stage5_live_critic_high_risk_comparison.json and stage5_repair_conversion_*.json costs.criticInput/OutputTokens.",
  "repair tokens ← stage5_repair_conversion_*.json costs.repairInput/OutputTokens (verified OLD-VTRACE conversions only).",
];

function fmtUsd(v: number | null): string {
  return v === null ? "n/a" : `$${v.toFixed(4)}`;
}
// Compact 2-decimal dollars for prose (e.g. "$8.21"), to match the strict-report headline.
function fmtUsd2(v: number | null): string {
  return v === null ? "n/a" : `$${v.toFixed(2)}`;
}
// Compact millions for prose (e.g. 17074981 → "17.07M").
function fmtMillions(v: number | null): string {
  return v === null ? "n/a" : `${(v / 1_000_000).toFixed(2)}M`;
}
// Signed compact dollars for delta columns (e.g. "-$1.80", "+$0.57").
function fmtUsdDelta(v: number | null): string {
  if (v === null) return "n/a";
  const sign = v < 0 ? "-" : "+";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}
// Signed compact millions for delta columns (e.g. "-4.55M").
function fmtMillionsDelta(v: number | null): string {
  if (v === null) return "n/a";
  const sign = v < 0 ? "-" : "+";
  return `${sign}${(Math.abs(v) / 1_000_000).toFixed(2)}M`;
}
function fmtSigned(v: number): string {
  return v > 0 ? `+${v}` : String(v);
}
function fmtNum(v: number | null): string {
  return v === null ? "null" : String(Math.round(v));
}
function tri(v: boolean | null): string {
  return v === null ? "unknown" : v ? "true" : "false";
}

export function buildReport(args: { readonly generatedAt: string | null; readonly inputs: AccountingInputs }): PolicyAccountingReport {
  const { generatedAt, inputs } = args;
  const rawPolicies = POLICY_SPECS.map((spec) => computePolicyMetrics(spec, inputs));
  const rawByName = new Map(rawPolicies.map((p) => [p.policyName, p]));
  const baseline = rawByName.get("baseline")!;
  const oldVtraceFirstPatch = rawByName.get("old_vtrace_first_patch")!;
  const strictFirstPatch = rawByName.get("strict_vtrace_first_patch")!;
  const gatedRepair = rawByName.get("old_vtrace_with_observed_gated_repair")!;
  const verifiedRepair = rawByName.get("old_vtrace_with_verified_repair")!;

  // Attach deltas vs the two reference policies (baseline, old first patch).
  const policies = withDeltas(rawPolicies, baseline, oldVtraceFirstPatch);

  const verifiedConversions = inputs.conversions.filter((c) => c.convertedUnresolvedToResolved);
  const verifiedByInstance = new Map(verifiedConversions.map((c) => [c.instanceId, c]));
  const taskInstanceIds = new Set(inputs.tasks.map((t) => t.instanceId));
  const uniqueTaskRecoveries = [...new Set(verifiedConversions.filter((c) => taskInstanceIds.has(c.instanceId)).map((c) => c.instanceId))].sort();

  const recommendation = pickRecommendation({ vtraceFirstPatch: oldVtraceFirstPatch, verifiedRepair });
  const strictRecommendation = pickStrictRepairRecommendation({ tasks: inputs.tasks, conversions: inputs.conversions });
  const recoveryCostAddedUsd = addNullable(verifiedRepair.criticCostUsd, verifiedRepair.repairCostUsd);

  const verifiedRepairArtifacts = verifiedRepair.artifactConversionCount;
  const uniqueTaskConversions = verifiedRepair.taskConversionCount;

  const behindBaselineBy = baseline.resolvedCount - strictFirstPatch.resolvedCount;
  const strictAccounting = {
    taskCount: strictFirstPatch.taskCount,
    strictResolved: strictFirstPatch.resolvedCount,
    oldVtraceResolved: oldVtraceFirstPatch.resolvedCount,
    baselineResolved: baseline.resolvedCount,
    strictTotalTokens: strictFirstPatch.totalTokens,
    oldVtraceTotalTokens: oldVtraceFirstPatch.totalTokens,
    baselineTotalTokens: baseline.totalTokens,
    strictTotalCostUsd: strictFirstPatch.totalCostUsd,
    oldVtraceTotalCostUsd: oldVtraceFirstPatch.totalCostUsd,
    baselineTotalCostUsd: baseline.totalCostUsd,
    strictCostPerResolved: strictFirstPatch.costPerResolved,
    strictTokensPerResolved: strictFirstPatch.tokensPerResolved,
    resolutionDeltaVsOldVtrace: strictFirstPatch.resolvedCount - oldVtraceFirstPatch.resolvedCount,
    tokensDeltaVsOldVtrace: diffNullable(strictFirstPatch.totalTokens, oldVtraceFirstPatch.totalTokens),
    costDeltaVsOldVtrace: diffNullable(strictFirstPatch.totalCostUsd, oldVtraceFirstPatch.totalCostUsd),
    resolutionDeltaVsBaseline: strictFirstPatch.resolvedCount - baseline.resolvedCount,
    tokensDeltaVsBaseline: diffNullable(strictFirstPatch.totalTokens, baseline.totalTokens),
    costDeltaVsBaseline: diffNullable(strictFirstPatch.totalCostUsd, baseline.totalCostUsd),
    improvesOverOldVtrace: strictFirstPatch.resolvedCount > oldVtraceFirstPatch.resolvedCount,
    behindBaselineBy,
    fewerTokensThanBaseline:
      strictFirstPatch.totalTokens !== null && baseline.totalTokens !== null && strictFirstPatch.totalTokens < baseline.totalTokens,
    lowerCostThanBaseline:
      strictFirstPatch.totalCostUsd !== null && baseline.totalCostUsd !== null && strictFirstPatch.totalCostUsd < baseline.totalCostUsd,
  };

  const headline = (() => {
    const sr = strictFirstPatch;
    const ov = oldVtraceFirstPatch;
    const behind = behindBaselineBy === 1 ? "one resolved task behind" : `${behindBaselineBy} resolved tasks behind`;
    return (
      `strict_vtrace_first_patch (the internal Stage 5 default) resolved ${sr.resolvedCount}/${sr.taskCount} using ` +
      `${fmtMillions(sr.totalTokens)} tokens at ${fmtUsd2(sr.totalCostUsd)}, improving on old_vtrace_first_patch ` +
      `(${ov.resolvedCount}/${ov.taskCount}, ${fmtMillions(ov.totalTokens)}, ${fmtUsd2(ov.totalCostUsd)}) and remaining ` +
      `${behind} baseline (${baseline.resolvedCount}/${baseline.taskCount}, ${fmtMillions(baseline.totalTokens)}, ${fmtUsd2(baseline.totalCostUsd)}). ` +
      `Verified OLD-VTRACE repair (${verifiedRepairArtifacts} artifact(s), ${uniqueTaskConversions} unique task recovery(ies)) is accounted separately and never transferred to strict.`
    );
  })();

  return {
    generatedAt,
    summary: {
      taskCount: strictFirstPatch.taskCount,
      verifiedRepairArtifacts,
      uniqueTaskConversions,
      baselineResolved: baseline.resolvedCount,
      oldVtraceFirstPatchResolved: oldVtraceFirstPatch.resolvedCount,
      strictVtraceFirstPatchResolved: strictFirstPatch.resolvedCount,
      gatedRepairResolved: gatedRepair.resolvedCount,
      recoveryCostAddedUsd,
      headline,
    },
    strictAccounting,
    uniqueTaskRecoveries,
    policies,
    tasks: inputs.tasks.map((t) => {
      const verified = verifiedByInstance.has(t.instanceId);
      return {
        instanceId: t.instanceId,
        baselineResolved: t.baselineResolved,
        vtraceResolved: t.vtraceResolved,
        strictResolved: t.strictResolved,
        gatedRepairResolved: verified ? true : t.vtraceResolved,
        baselineCostUsd: t.baselineCostUsd,
        vtraceCostUsd: t.vtraceCostUsd,
        strictCostUsd: t.strictCostUsd,
        baselineTokens: t.baselineTokens,
        vtraceTokens: t.vtraceTokens,
        strictTokens: t.strictTokens,
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
    strictRecommendation,
    recommendation,
    repairBoundary: REPAIR_BOUNDARY,
    nonClaims: NON_CLAIMS,
  };
}

export function renderJson(report: PolicyAccountingReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderMarkdown(report: PolicyAccountingReport): string {
  const L: string[] = [];
  const { summary, policies, strictAccounting: sa } = report;
  const byName = new Map(policies.map((p) => [p.policyName, p]));
  const oldVtrace = byName.get("old_vtrace_first_patch")!;

  L.push("# Stage 5 policy accounting");
  L.push("");
  if (report.generatedAt) L.push(`_Generated: ${report.generatedAt}_`, "");
  L.push("_Reporting/accounting only. Re-runs nothing (no agent, no live critic, no repair, no Docker); accounts for strict-gated first-pass runs, observed artifacts, and verified repaired-patch evaluations over the controlled task set._");
  L.push("");

  L.push("## Summary");
  L.push("");
  L.push(summary.headline);
  L.push("");
  L.push(`- controlled tasks: **${summary.taskCount}**`);
  L.push(`- resolved: baseline **${summary.baselineResolved}**, old_vtrace_first_patch **${summary.oldVtraceFirstPatchResolved}**, strict_vtrace_first_patch **${summary.strictVtraceFirstPatchResolved}**`);
  L.push(`- strict vs old VTRACE: resolved **${fmtSigned(sa.resolutionDeltaVsOldVtrace)}**, tokens **${fmtMillionsDelta(sa.tokensDeltaVsOldVtrace)}**, cost **${fmtUsdDelta(sa.costDeltaVsOldVtrace)}**`);
  L.push(`- strict vs baseline: resolved **${fmtSigned(sa.resolutionDeltaVsBaseline)}**, tokens **${fmtMillionsDelta(sa.tokensDeltaVsBaseline)}**, cost **${fmtUsdDelta(sa.costDeltaVsBaseline)}**`);
  L.push(`- verified OLD-VTRACE repair artifacts: **${summary.verifiedRepairArtifacts}** (**${summary.uniqueTaskConversions}** unique task recoveries${report.uniqueTaskRecoveries.length > 0 ? `: ${report.uniqueTaskRecoveries.join(", ")}` : ""}) — accounted under \`old_vtrace_with_verified_repair\`, never transferred to strict`);
  L.push("");

  L.push("## Policies compared");
  L.push("");
  for (const p of policies) L.push(`- \`${p.policyName}\` — ${p.description}`);
  L.push("");

  L.push("## Resolution results");
  L.push("");
  L.push("| policy | tasks | resolved | unresolved | unknown | Δ vs baseline | Δ vs old VTRACE |");
  L.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const p of policies) {
    L.push(`| ${p.policyName} | ${p.taskCount} | ${p.resolvedCount} | ${p.unresolvedCount} | ${p.unknownCount} | ${fmtSigned(p.resolutionDeltaVsBaseline)} | ${fmtSigned(p.resolutionDeltaVsOldVtrace)} |`);
  }
  L.push("");

  L.push("## Cost accounting");
  L.push("");
  L.push("| policy | agent $ | critic $ | repair $ | total $ | mean $ | Δ$ vs baseline | Δ$ vs old VTRACE |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const p of policies) {
    L.push(`| ${p.policyName} | ${fmtUsd(p.agentCostUsd)} | ${fmtUsd(p.criticCostUsd)} | ${fmtUsd(p.repairCostUsd)} | ${fmtUsd(p.totalCostUsd)} | ${fmtUsd(p.meanCostUsd)} | ${fmtUsdDelta(p.costDeltaVsBaseline)} | ${fmtUsdDelta(p.costDeltaVsOldVtrace)} |`);
  }
  L.push("");

  L.push("## Token accounting");
  L.push("");
  L.push("| policy | total tokens | mean tokens | Δtok vs baseline | Δtok vs old VTRACE | critic in | critic out | repair in | repair out |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const p of policies) {
    L.push(
      `| ${p.policyName} | ${fmtNum(p.totalTokens)} | ${fmtNum(p.meanTokens)} | ${fmtMillionsDelta(p.tokensDeltaVsBaseline)} | ${fmtMillionsDelta(p.tokensDeltaVsOldVtrace)} | ${fmtNum(p.criticInputTokens)} | ${fmtNum(p.criticOutputTokens)} | ${fmtNum(p.repairInputTokens)} | ${fmtNum(p.repairOutputTokens)} |`,
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

  L.push("## Strict-gated first-pass accounting");
  L.push("");
  if (sa.improvesOverOldVtrace) {
    L.push("**strict_vtrace_first_patch improves over old_vtrace_first_patch:**");
    L.push("");
    L.push(`- resolved ${sa.oldVtraceResolved}/${sa.taskCount} → ${sa.strictResolved}/${sa.taskCount}`);
    L.push(`- tokens ${fmtMillions(sa.oldVtraceTotalTokens)} → ${fmtMillions(sa.strictTotalTokens)}`);
    L.push(`- cost ${fmtUsd2(sa.oldVtraceTotalCostUsd)} → ${fmtUsd2(sa.strictTotalCostUsd)}`);
  } else {
    L.push(`**strict_vtrace_first_patch does not improve resolved count over old_vtrace_first_patch** (${sa.strictResolved}/${sa.taskCount} vs ${sa.oldVtraceResolved}/${sa.taskCount}).`);
  }
  L.push("");
  const behind = sa.behindBaselineBy === 1 ? "one resolved task" : `${sa.behindBaselineBy} resolved tasks`;
  if (sa.behindBaselineBy > 0) {
    L.push(`**strict_vtrace_first_patch remains ${behind} behind baseline:** strict ${sa.strictResolved}/${sa.taskCount} vs baseline ${sa.baselineResolved}/${sa.taskCount}.`);
  } else {
    L.push(`strict_vtrace_first_patch is not behind baseline on resolved count (strict ${sa.strictResolved}/${sa.taskCount} vs baseline ${sa.baselineResolved}/${sa.taskCount}).`);
  }
  L.push("");
  if (sa.fewerTokensThanBaseline && sa.lowerCostThanBaseline) {
    L.push("strict_vtrace_first_patch uses fewer total tokens and lower total cost than baseline in this controlled set, but lower total cost does not imply higher success rate.");
  } else {
    L.push(`strict_vtrace_first_patch total tokens ${fmtMillions(sa.strictTotalTokens)} and total cost ${fmtUsd2(sa.strictTotalCostUsd)} vs baseline ${fmtMillions(sa.baselineTotalTokens)} / ${fmtUsd2(sa.baselineTotalCostUsd)}; lower total cost would not imply a higher success rate regardless.`);
  }
  L.push("");
  L.push("| metric | baseline | old_vtrace_first_patch | strict_vtrace_first_patch |");
  L.push("| --- | --- | --- | --- |");
  L.push(`| resolved | ${sa.baselineResolved}/${sa.taskCount} | ${sa.oldVtraceResolved}/${sa.taskCount} | ${sa.strictResolved}/${sa.taskCount} |`);
  L.push(`| total tokens | ${fmtNum(sa.baselineTotalTokens)} | ${fmtNum(sa.oldVtraceTotalTokens)} | ${fmtNum(sa.strictTotalTokens)} |`);
  L.push(`| total cost | ${fmtUsd(sa.baselineTotalCostUsd)} | ${fmtUsd(sa.oldVtraceTotalCostUsd)} | ${fmtUsd(sa.strictTotalCostUsd)} |`);
  L.push(`| cost / resolved | ${fmtUsd(byName.get("baseline")!.costPerResolved)} | ${fmtUsd(oldVtrace.costPerResolved)} | ${fmtUsd(sa.strictCostPerResolved)} |`);
  L.push(`| tokens / resolved | ${fmtNum(byName.get("baseline")!.tokensPerResolved)} | ${fmtNum(oldVtrace.tokensPerResolved)} | ${fmtNum(sa.strictTokensPerResolved)} |`);
  L.push("");

  L.push("## Repair accounting boundary");
  L.push("");
  for (const line of report.repairBoundary) L.push(`- ${line}`);
  L.push("");
  const convertedArtifacts = report.conversions.filter((c) => c.convertedUnresolvedToResolved);
  if (report.conversions.length === 0) {
    L.push("_No repair conversions found; no repair was counted for any policy._");
  } else {
    L.push(`${convertedArtifacts.length} verified repaired-patch artifact(s) resolved under Docker, corresponding to ${summary.uniqueTaskConversions} unique controlled task recovery(ies) under \`old_vtrace_with_verified_repair\`. Each artifact row is an individual OLD-VTRACE repair run; multiple rows for one instance are still one task recovery.`);
    L.push("");
    L.push("| run | instance | first resolved | repaired resolved | converted | critic $ | repair $ | recovery $ |");
    L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const c of report.conversions) {
      L.push(
        `| ${c.runLabel} | ${c.instanceId} | ${tri(c.firstPatchResolved)} | ${tri(c.repairedPatchResolved)} | ${tri(c.convertedUnresolvedToResolved)} | ${fmtUsd(c.criticCostUsd)} | ${fmtUsd(c.repairCostUsd)} | ${fmtUsd(c.totalRecoveryCostUsd)} |`,
      );
    }
    L.push("");
    if (report.uniqueTaskRecoveries.length > 0) {
      L.push(`Unique OLD-VTRACE task recoveries (de-duplicated by instance): ${report.uniqueTaskRecoveries.map((id) => `\`${id}\``).join(", ")}. These belong to \`old_vtrace_with_verified_repair\`, not to strict.`);
      L.push("");
    }
  }
  L.push("_Cost sources:_");
  for (const s of report.costSources) L.push(`- ${s}`);
  L.push("");
  L.push("_Token sources:_");
  for (const s of report.tokenSources) L.push(`- ${s}`);
  L.push("");

  L.push("## Recommended next step");
  L.push("");
  L.push(report.strictRecommendation.statement);
  L.push("");
  L.push(report.strictRecommendation.rationale);
  L.push("");
  L.push(`_OLD-VTRACE repair-experiment guidance (separate track): Option ${report.recommendation.choice} — ${report.recommendation.statement}_`);
  L.push("");

  L.push("## Non-claims");
  L.push("");
  for (const n of report.nonClaims) L.push(`- ${n}`);
  L.push("");

  return `${L.join("\n")}\n`;
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

  const old = report.policies.find((p) => p.policyName === "old_vtrace_first_patch")!;
  const strict = report.policies.find((p) => p.policyName === "strict_vtrace_first_patch")!;
  process.stdout.write(
    [
      "Stage 5 policy accounting written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Tasks: ${report.summary.taskCount}   Verified OLD-VTRACE repair artifacts: ${report.summary.verifiedRepairArtifacts}   Unique task recoveries: ${report.summary.uniqueTaskConversions}`,
      `Resolved — baseline: ${report.summary.baselineResolved}   old_vtrace_first_patch: ${report.summary.oldVtraceFirstPatchResolved}   strict_vtrace_first_patch: ${report.summary.strictVtraceFirstPatchResolved}`,
      `Cost/resolved — old_vtrace_first_patch: ${fmtUsd(old.costPerResolved)}   strict_vtrace_first_patch: ${fmtUsd(strict.costPerResolved)}`,
      `Strict next step: ${report.strictRecommendation.statement}`,
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
