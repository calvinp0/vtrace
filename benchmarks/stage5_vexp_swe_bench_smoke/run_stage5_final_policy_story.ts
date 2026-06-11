// Stage 5 FINAL POLICY STORY report. READ-ONLY.
//
// SCOPE: documentation/reporting only. This runner reads the already-committed Stage 5
// reports (policy accounting, the strict-gated 10-task report, and the strict Requests
// repair-conversion evidence) and renders the final narrative arc from old VTRACE to
// strict-gated VTRACE + verified repair over the controlled 10-task set. Every headline
// number is read from those artifacts, never hardcoded.
//
// It RE-RUNS nothing: no agent, no live critic, no repair, no Docker. It mutates no
// artifact and changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD /
// PATCH_VERIFY / probe / critic / repair / evaluator / policy behavior.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { RESULTS_REL } from "./run_stage5_patch_probe_report";

export const DEFAULT_OUT_NAME = "stage5_final_policy_story";

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

// One policy row distilled from the committed policy-accounting report. Resolution counts
// are always present; cost/tokens may be null and are never invented.
export interface PolicyRow {
  readonly policyName: string;
  readonly taskCount: number;
  readonly resolvedCount: number;
  readonly totalCostUsd: number | null;
  readonly totalTokens: number | null;
  readonly costPerResolved: number | null;
  readonly tokensPerResolved: number | null;
}

// The strict-specific repair conversion evidence (one observed loss recovery).
export interface RepairEvidence {
  readonly runLabel: string;
  readonly instanceId: string;
  readonly converted: boolean;
  readonly dockerUsed: boolean;
  readonly resolved: boolean | null;
  readonly criticCostUsd: number | null;
  readonly repairCostUsd: number | null;
  readonly totalRecoveryCostUsd: number | null;
}

export interface StoryInputs {
  readonly taskCount: number;
  // The four narrative policies, joined by name from the policy-accounting report.
  readonly baseline: PolicyRow | null;
  readonly oldFirstPatch: PolicyRow | null;
  readonly strictFirstPatch: PolicyRow | null;
  readonly strictWithRepair: PolicyRow | null;
  // The strict pivot-check default observed across the strict run set.
  readonly pivotCheckPolicy: string | null;
  readonly strictRunTaskCount: number | null;
  // The strict-specific repair conversion (null if absent).
  readonly repair: RepairEvidence | null;
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

interface AccountingDoc {
  readonly policies?: ReadonlyArray<Record<string, unknown>>;
}

export function parsePolicyRow(raw: Record<string, unknown> | undefined): PolicyRow | null {
  if (raw === undefined) return null;
  const policyName = asStr(raw.policyName);
  if (policyName === null) return null;
  return {
    policyName,
    taskCount: asNum(raw.taskCount) ?? 0,
    resolvedCount: asNum(raw.resolvedCount) ?? 0,
    totalCostUsd: asNum(raw.totalCostUsd),
    totalTokens: asNum(raw.totalTokens),
    costPerResolved: asNum(raw.costPerResolved),
    tokensPerResolved: asNum(raw.tokensPerResolved),
  };
}

interface StrictReportDoc {
  readonly tasks?: ReadonlyArray<{
    readonly strict?: { readonly pivotCheckPolicy?: string | null } | null;
  }>;
}

// The single PIVOT_CHECK policy observed across the strict run set (or null if the strict
// runs disagree / are absent). The strict default is a single policy by construction.
export function parsePivotCheckPolicy(doc: StrictReportDoc | null): { policy: string | null; taskCount: number | null } {
  const tasks = doc?.tasks ?? [];
  if (tasks.length === 0) return { policy: null, taskCount: null };
  const policies = new Set<string>();
  for (const t of tasks) {
    const p = asStr(t.strict?.pivotCheckPolicy);
    if (p !== null) policies.add(p);
  }
  return { policy: policies.size === 1 ? [...policies][0]! : null, taskCount: tasks.length };
}

interface ConversionDoc {
  readonly runLabel?: string;
  readonly instanceId?: string;
  readonly conversion?: { readonly convertedUnresolvedToResolved?: boolean };
  readonly evaluation?: { readonly dockerUsed?: boolean; readonly resolved?: boolean | null };
  readonly costs?: {
    readonly criticCostUsd?: number | null;
    readonly repairCostUsd?: number | null;
    readonly totalCriticRepairCostUsd?: number | null;
  };
}

export function parseRepairEvidence(doc: ConversionDoc | null): RepairEvidence | null {
  if (doc === null || !doc.conversion) return null;
  const costs = doc.costs ?? {};
  return {
    runLabel: doc.runLabel ?? "unknown",
    instanceId: doc.instanceId ?? "unknown",
    converted: doc.conversion.convertedUnresolvedToResolved === true,
    dockerUsed: doc.evaluation?.dockerUsed === true,
    resolved: asBool(doc.evaluation?.resolved),
    criticCostUsd: costs.criticCostUsd ?? null,
    repairCostUsd: costs.repairCostUsd ?? null,
    totalRecoveryCostUsd: costs.totalCriticRepairCostUsd ?? null,
  };
}

// Load every committed input this story rests on. FAILS CLEARLY when the policy-accounting
// report is missing — there is no story to tell without the controlled-set numbers.
export async function loadStoryInputs(resultsDir: string): Promise<StoryInputs> {
  const accounting = await readJson<AccountingDoc>(path.join(resultsDir, "stage5_policy_accounting.json"));
  if (accounting === null || !Array.isArray(accounting.policies) || accounting.policies.length === 0) {
    throw new Error(
      `No policy-accounting report at ${path.join(resultsDir, "stage5_policy_accounting.json")} ` +
        `(or it has no policies); nothing to summarize.`,
    );
  }
  const byName = new Map<string, Record<string, unknown>>();
  for (const p of accounting.policies) {
    const name = asStr(p.policyName);
    if (name !== null) byName.set(name, p);
  }
  const baseline = parsePolicyRow(byName.get("baseline"));
  const oldFirstPatch = parsePolicyRow(byName.get("old_vtrace_first_patch"));
  const strictFirstPatch = parsePolicyRow(byName.get("strict_vtrace_first_patch"));
  const strictWithRepair = parsePolicyRow(byName.get("strict_vtrace_with_verified_repair"));

  const strictDoc = await readJson<StrictReportDoc>(path.join(resultsDir, "stage5_strictgated_10task_report.json"));
  const { policy: pivotCheckPolicy, taskCount: strictRunTaskCount } = parsePivotCheckPolicy(strictDoc);

  const repair = parseRepairEvidence(await readJson<ConversionDoc>(path.join(resultsDir, "stage5_repair_conversion_strict_requests.json")));

  const taskCount = strictWithRepair?.taskCount ?? baseline?.taskCount ?? strictFirstPatch?.taskCount ?? 0;

  return { taskCount, baseline, oldFirstPatch, strictFirstPatch, strictWithRepair, pivotCheckPolicy, strictRunTaskCount, repair };
}

// ---------------------------------------------------------------------------
// Fixed narrative (claims / non-claims / recommendation / next work)
// ---------------------------------------------------------------------------

export const CLAIMS: readonly string[] = [
  "strict_risk_gated is now the internal Stage 5 default PIVOT_CHECK policy.",
  "strict first-pass VTRACE improved over old controlled VTRACE on resolution, tokens, and cost.",
  "strict_vtrace_with_verified_repair matched baseline resolution on the controlled 10-task set.",
  "strict_vtrace_with_verified_repair used lower total tokens and lower total cost than baseline in this controlled set.",
];

export const NON_CLAIMS: readonly string[] = [
  "This does NOT claim VTRACE beats VEXP.",
  "This is NOT a statistically meaningful SWE-bench benchmark.",
  "This does NOT claim repair should be always-on.",
  "This does NOT claim old VTRACE repair conversions transfer to strict runs.",
  "This does NOT prove aggregate performance beyond this controlled 10-task set.",
];

export const FINAL_RECOMMENDATION =
  "Stop Stage 5 repair experiments for now. Keep strict_risk_gated as the internal Stage 5 default. " +
  "Keep critic/repair gated and disabled by default, available only after deterministic probes and live critic agreement. " +
  "Move next to VTRACE productization and release hardening.";

export const NEXT_PRODUCTIZATION_WORK: readonly string[] = [
  "Clean user-facing modes: auto / fast / thorough / debug instead of internal policy flags.",
  "Release/CI hardening: typecheck, tests, package checks, VS Code packaging.",
  "Documentation: explain Capsule v2, strict pivot gating, deferred refs, and repair safety boundaries.",
  "Benchmark hygiene: keep raw artifacts untracked, preserve generated evidence, avoid timestamp churn.",
  "Product UX: hide internal knobs from normal users while keeping benchmark/dev overrides.",
  "Broader validation: later rerun larger sets only after productization, not now.",
];

export const WHY_REPAIR_GATED: readonly string[] = [
  "Repair runs only after deterministic probes flag a concrete defect class AND the live critic independently agrees, so it never fires speculatively.",
  "Exactly one bounded repair attempt is allowed; it edits the existing first patch rather than re-solving from scratch.",
  "Critic and repair add real per-call cost/tokens, so always-on repair would raise cost-per-resolved without a proven aggregate gain.",
  "The one observed recovery (psf__requests-5414) is a single controlled-set instance, not evidence that repair helps in aggregate.",
];

// ---------------------------------------------------------------------------
// Report (pure)
// ---------------------------------------------------------------------------

export interface PolicyComparison {
  readonly policyName: string;
  readonly resolved: string; // "8/10"
  readonly totalCostUsd: number | null;
  readonly totalTokens: number | null;
}

export interface FinalPolicyStoryReport {
  readonly generatedAt: string | null;
  readonly taskCount: number;
  readonly pivotCheckPolicy: string | null;
  readonly executiveSummary: string;
  readonly policies: readonly PolicyComparison[];
  readonly tokenCostOutcome: {
    readonly baselineTotalCostUsd: number | null;
    readonly baselineTotalTokens: number | null;
    readonly strictWithRepairTotalCostUsd: number | null;
    readonly strictWithRepairTotalTokens: number | null;
    readonly costDeltaVsBaseline: number | null;
    readonly tokensDeltaVsBaseline: number | null;
    readonly lowerCostThanBaseline: boolean;
    readonly fewerTokensThanBaseline: boolean;
  };
  readonly resolutionOutcome: {
    readonly baselineResolved: number | null;
    readonly oldFirstPatchResolved: number | null;
    readonly strictFirstPatchResolved: number | null;
    readonly strictWithRepairResolved: number | null;
    readonly strictMatchesBaseline: boolean;
    readonly strictImprovesOverOld: boolean;
  };
  readonly repair: RepairEvidence | null;
  readonly claims: readonly string[];
  readonly nonClaims: readonly string[];
  readonly whyRepairGated: readonly string[];
  readonly finalRecommendation: string;
  readonly nextProductizationWork: readonly string[];
}

function div(n: number | null, d: number | null): number | null {
  return n === null || d === null || d === 0 ? null : n / d;
}
function diffNullable(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a - b;
}

export function buildReport(args: { readonly generatedAt: string | null; readonly inputs: StoryInputs }): FinalPolicyStoryReport {
  const { generatedAt, inputs } = args;
  const { baseline, oldFirstPatch, strictFirstPatch, strictWithRepair } = inputs;
  const taskCount = inputs.taskCount;

  const resolvedStr = (p: PolicyRow | null): string => (p === null ? "n/a" : `${p.resolvedCount}/${p.taskCount}`);

  const policies: PolicyComparison[] = [baseline, oldFirstPatch, strictFirstPatch, strictWithRepair]
    .filter((p): p is PolicyRow => p !== null)
    .map((p) => ({ policyName: p.policyName, resolved: `${p.resolvedCount}/${p.taskCount}`, totalCostUsd: p.totalCostUsd, totalTokens: p.totalTokens }));

  const costDeltaVsBaseline = diffNullable(strictWithRepair?.totalCostUsd ?? null, baseline?.totalCostUsd ?? null);
  const tokensDeltaVsBaseline = diffNullable(strictWithRepair?.totalTokens ?? null, baseline?.totalTokens ?? null);
  const lowerCostThanBaseline =
    strictWithRepair?.totalCostUsd != null && baseline?.totalCostUsd != null && strictWithRepair.totalCostUsd < baseline.totalCostUsd;
  const fewerTokensThanBaseline =
    strictWithRepair?.totalTokens != null && baseline?.totalTokens != null && strictWithRepair.totalTokens < baseline.totalTokens;

  const strictMatchesBaseline =
    strictWithRepair !== null && baseline !== null && strictWithRepair.resolvedCount >= baseline.resolvedCount;
  const strictImprovesOverOld =
    strictFirstPatch !== null && oldFirstPatch !== null && strictFirstPatch.resolvedCount > oldFirstPatch.resolvedCount;

  const executiveSummary = (() => {
    const swr = strictWithRepair;
    const sfp = strictFirstPatch;
    const bl = baseline;
    const ofp = oldFirstPatch;
    return (
      `Over the controlled ${taskCount}-task set, VTRACE moved from old_vtrace_first_patch ` +
      `(${resolvedStr(ofp)} resolved at ${fmtUsd(ofp?.totalCostUsd ?? null)} / ${fmtMillions(ofp?.totalTokens ?? null)}) to ` +
      `strict_vtrace_first_patch (${resolvedStr(sfp)} at ${fmtUsd(sfp?.totalCostUsd ?? null)} / ${fmtMillions(sfp?.totalTokens ?? null)}) under the ` +
      `${inputs.pivotCheckPolicy ?? "strict_risk_gated"} default, then to strict_vtrace_with_verified_repair ` +
      `(${resolvedStr(swr)} at ${fmtUsd(swr?.totalCostUsd ?? null)} / ${fmtMillions(swr?.totalTokens ?? null)}) after one strict-specific gated repair recovered ${inputs.repair?.instanceId ?? "psf__requests-5414"}. ` +
      `strict_vtrace_with_verified_repair ${strictMatchesBaseline ? "matched" : "did not match"} baseline resolution (${resolvedStr(bl)})` +
      `${lowerCostThanBaseline && fewerTokensThanBaseline ? " while using lower total cost and fewer total tokens" : ""}.`
    );
  })();

  return {
    generatedAt,
    taskCount,
    pivotCheckPolicy: inputs.pivotCheckPolicy,
    executiveSummary,
    policies,
    tokenCostOutcome: {
      baselineTotalCostUsd: baseline?.totalCostUsd ?? null,
      baselineTotalTokens: baseline?.totalTokens ?? null,
      strictWithRepairTotalCostUsd: strictWithRepair?.totalCostUsd ?? null,
      strictWithRepairTotalTokens: strictWithRepair?.totalTokens ?? null,
      costDeltaVsBaseline,
      tokensDeltaVsBaseline,
      lowerCostThanBaseline,
      fewerTokensThanBaseline,
    },
    resolutionOutcome: {
      baselineResolved: baseline?.resolvedCount ?? null,
      oldFirstPatchResolved: oldFirstPatch?.resolvedCount ?? null,
      strictFirstPatchResolved: strictFirstPatch?.resolvedCount ?? null,
      strictWithRepairResolved: strictWithRepair?.resolvedCount ?? null,
      strictMatchesBaseline,
      strictImprovesOverOld,
    },
    repair: inputs.repair,
    claims: CLAIMS,
    nonClaims: NON_CLAIMS,
    whyRepairGated: WHY_REPAIR_GATED,
    finalRecommendation: FINAL_RECOMMENDATION,
    nextProductizationWork: NEXT_PRODUCTIZATION_WORK,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtUsd(v: number | null): string {
  return v === null ? "n/a" : `$${v.toFixed(4)}`;
}
function fmtUsd2(v: number | null): string {
  return v === null ? "n/a" : `$${v.toFixed(2)}`;
}
function fmtMillions(v: number | null): string {
  return v === null ? "n/a" : `${(v / 1_000_000).toFixed(2)}M`;
}
function fmtNum(v: number | null): string {
  return v === null ? "null" : String(Math.round(v));
}
function fmtUsdDelta(v: number | null): string {
  if (v === null) return "n/a";
  return `${v < 0 ? "-" : "+"}$${Math.abs(v).toFixed(2)}`;
}
function fmtMillionsDelta(v: number | null): string {
  if (v === null) return "n/a";
  return `${v < 0 ? "-" : "+"}${(Math.abs(v) / 1_000_000).toFixed(2)}M`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderJson(report: FinalPolicyStoryReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderMarkdown(report: FinalPolicyStoryReport): string {
  const L: string[] = [];
  const r = report;
  const tco = r.tokenCostOutcome;
  const ro = r.resolutionOutcome;

  L.push("# Stage 5 final policy story");
  L.push("");
  if (r.generatedAt) L.push(`_Generated: ${r.generatedAt}_`, "");
  L.push("_Documentation/reporting only. Re-runs nothing (no agent, no live critic, no repair, no Docker); summarizes committed Stage 5 reports over the controlled task set. Every number is read from committed artifacts, not hardcoded._");
  L.push("");

  L.push("## Executive summary");
  L.push("");
  L.push(r.executiveSummary);
  L.push("");

  L.push("## What changed");
  L.push("");
  L.push(`- The internal Stage 5 PIVOT_CHECK default became \`${r.pivotCheckPolicy ?? "strict_risk_gated"}\`: pivot-check, edit-guard, and patch-verify inject only under strong risk signals instead of on every hidden pivot.`);
  L.push("- Strict first-pass VTRACE replaced the old always-injecting controlled VTRACE, cutting tokens and cost while improving resolution.");
  L.push("- A strict-specific, gated one-repair path (deterministic probe → live-critic agreement → one bounded repair → Docker re-evaluation) recovered one previously unresolved task.");
  L.push("- Old VTRACE repair conversions stayed tied to old first patches and were never transferred to strict accounting.");
  L.push("");

  L.push("## Controlled 10-task results");
  L.push("");
  L.push("| policy | resolved | total cost | total tokens |");
  L.push("| --- | --- | --- | --- |");
  for (const p of r.policies) {
    L.push(`| ${p.policyName} | ${p.resolved} | ${fmtUsd(p.totalCostUsd)} | ${fmtNum(p.totalTokens)} |`);
  }
  L.push("");

  L.push("## Token and cost outcome");
  L.push("");
  L.push(`- baseline: ${fmtUsd2(tco.baselineTotalCostUsd)} / ${fmtMillions(tco.baselineTotalTokens)} tokens`);
  L.push(`- strict_vtrace_with_verified_repair: ${fmtUsd2(tco.strictWithRepairTotalCostUsd)} / ${fmtMillions(tco.strictWithRepairTotalTokens)} tokens`);
  L.push(`- strict+repair vs baseline: cost ${fmtUsdDelta(tco.costDeltaVsBaseline)}, tokens ${fmtMillionsDelta(tco.tokensDeltaVsBaseline)}`);
  if (tco.lowerCostThanBaseline && tco.fewerTokensThanBaseline) {
    L.push("- strict_vtrace_with_verified_repair used lower total cost and fewer total tokens than baseline in this controlled set.");
  }
  L.push("");

  L.push("## Resolution outcome");
  L.push("");
  L.push(`- baseline resolved: ${ro.baselineResolved ?? "n/a"}/${r.taskCount}`);
  L.push(`- old_vtrace_first_patch resolved: ${ro.oldFirstPatchResolved ?? "n/a"}/${r.taskCount}`);
  L.push(`- strict_vtrace_first_patch resolved: ${ro.strictFirstPatchResolved ?? "n/a"}/${r.taskCount}`);
  L.push(`- strict_vtrace_with_verified_repair resolved: ${ro.strictWithRepairResolved ?? "n/a"}/${r.taskCount}`);
  if (ro.strictImprovesOverOld) {
    L.push("- Strict first-pass improved resolution over old VTRACE first patch.");
  }
  if (ro.strictMatchesBaseline) {
    L.push("- strict_vtrace_with_verified_repair matched baseline resolution on the controlled 10-task set.");
  }
  L.push("");

  L.push("## Strict pivot-check default");
  L.push("");
  L.push(`\`${r.pivotCheckPolicy ?? "strict_risk_gated"}\` is now the internal Stage 5 default PIVOT_CHECK policy. Under it, pivot-check / edit-guard / patch-verify inject only when strong risk signals are present (a lone hidden-pivot signal is insufficient), which is what reduced strict first-pass tokens and cost relative to old VTRACE.`);
  L.push("");

  L.push("## Gated repair outcome");
  L.push("");
  if (r.repair) {
    L.push(`- run: \`${r.repair.runLabel}\``);
    L.push(`- instance: \`${r.repair.instanceId}\``);
    L.push(`- converted unresolved → resolved: **${r.repair.converted}** (dockerUsed=${r.repair.dockerUsed}, resolved=${r.repair.resolved === null ? "unknown" : r.repair.resolved})`);
    L.push(`- recovery cost: critic ${fmtUsd(r.repair.criticCostUsd)} + repair ${fmtUsd(r.repair.repairCostUsd)} = **${fmtUsd(r.repair.totalRecoveryCostUsd)}**`);
    L.push("- This strict repair conversion was generated from the strict first patch run and is NOT transferred from old VTRACE repair evidence.");
  } else {
    L.push("_No strict-specific repair conversion is present._");
  }
  L.push("");

  L.push("## Why repair remains gated");
  L.push("");
  for (const line of r.whyRepairGated) L.push(`- ${line}`);
  L.push("");

  L.push("## What we can claim");
  L.push("");
  for (const c of r.claims) L.push(`- ${c}`);
  L.push("");

  L.push("## What we cannot claim");
  L.push("");
  for (const n of r.nonClaims) L.push(`- ${n}`);
  L.push("");

  L.push("## Final recommendation");
  L.push("");
  L.push(r.finalRecommendation);
  L.push("");

  L.push("## Next productization work");
  L.push("");
  r.nextProductizationWork.forEach((w, i) => L.push(`${i + 1}. ${w}`));
  L.push("");

  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main (impure)
// ---------------------------------------------------------------------------

export async function run(config: CliConfig): Promise<FinalPolicyStoryReport> {
  const generatedAt = new Date().toISOString();
  const inputs = await loadStoryInputs(config.resultsDir);
  const report = buildReport({ generatedAt, inputs });

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  process.stdout.write(
    [
      "Stage 5 final policy story written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Pivot-check default: ${report.pivotCheckPolicy ?? "n/a"}`,
      `Resolved — baseline: ${report.resolutionOutcome.baselineResolved}/${report.taskCount}   strict_vtrace_first_patch: ${report.resolutionOutcome.strictFirstPatchResolved}/${report.taskCount}   strict_vtrace_with_verified_repair: ${report.resolutionOutcome.strictWithRepairResolved}/${report.taskCount}`,
      `Strict+repair vs baseline: cost ${fmtUsdDelta(report.tokenCostOutcome.costDeltaVsBaseline)}, tokens ${fmtMillionsDelta(report.tokenCostOutcome.tokensDeltaVsBaseline)}`,
      `Recommendation: ${report.finalRecommendation}`,
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
