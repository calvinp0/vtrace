// Stage 5 gated ONE-repair-attempt runner (milestone 5). DISABLED BY DEFAULT.
//
// SCOPE: benchmark-only. Over the runs that already have VALID live-critic artifacts, this runner
// — ONLY when `--enable-patch-repair` is passed AND the run is explicitly named by `--run-label`
// — makes EXACTLY ONE bounded repair model call per eligible run, writes repair artifacts into an
// ISOLATED `raw/vtrace/repair/` subdir (the original first patch / critic artifacts are never
// overwritten), and emits a report. Without the flag it makes no model call and writes no repair
// artifacts. It NEVER loops, NEVER repairs ineligible defect classes (missing_failing_behavior is
// excluded by default), runs NO Docker, applies nothing to the original workspace, and changes no
// retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic behavior.
//
// The live model is reached only through `makeClaudeRepairCaller`; tests inject a mock caller.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PatchCriticReport } from "./stage5_patch_critic";
import type { LiveCriticMeta } from "./stage5_patch_critic_live";
import {
  type DefectClass,
  type InstructionQuality,
} from "./run_stage5_live_critic_high_risk_comparison";
import { CRITIC_RUN_LABELS } from "./run_stage5_live_critic_high_risk_comparison";
import { RESULTS_REL } from "./run_stage5_patch_probe_report";
import type { CandidateSource } from "./stage5_ad_hoc_candidates";
import {
  type PatchRepairInput,
  type PatchRepairMeta,
  type PatchRepairResult,
  type RepairCaller,
  type RepairEligibility,
  type RunPatchRepairOutcome,
  DEFAULT_ALLOWED_DEFECT_CLASSES,
  buildRepairArtifacts,
  evaluateRepairEligibility,
  makeClaudeRepairCaller,
  runPatchRepair,
} from "./stage5_patch_repair";

export const DEFAULT_OUT_NAME = "stage5_patch_repair";
export const DEFAULT_MAX_REPAIR_RUNS = 1;
export const DEFAULT_REPAIR_COST_CAP_USD = 0.25;

// The runs that may carry live-critic artifacts (the same six the high-risk observation produced).
// The candidate set; the run-label gate narrows it further (and is REQUIRED for any repair).
export const REPAIR_CANDIDATE_LABELS: readonly string[] = CRITIC_RUN_LABELS;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly outName: string;
  readonly enablePatchRepair: boolean; // DEFAULT false
  readonly repairModel: string | null;
  // Repair is restricted to EXACTLY these run labels; repair is required to be explicit, so an
  // empty set means NOTHING is repaired (every candidate is skipped run-label-required).
  readonly runLabels: readonly string[];
  readonly maxRepairRuns: number;
  readonly repairCostCapUsd: number;
  readonly allowedDefectClasses: readonly DefectClass[];
  readonly dryRun: boolean;
  // Optional, default false. This milestone does NOT run Docker: when set it only records intent
  // in metadata ("would be evaluated later"); no resolution is claimed or computed.
  readonly evaluateRepairedPatch: boolean;
  // Opt-in: also consider --run-label values outside the curated candidate universe (their live
  // critic artifacts must already exist on disk). Off by default; existing behavior is unchanged.
  readonly includeAdHocRunLabels: boolean;
}

const KNOWN_DEFECT_CLASSES: readonly DefectClass[] = [
  "wrong_scope",
  "broad_rewrite_minimality",
  "missing_failing_behavior",
  "unknown",
];

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let outName = DEFAULT_OUT_NAME;
  let enablePatchRepair = false;
  let repairModel: string | null = null;
  const runLabels: string[] = [];
  let maxRepairRuns = DEFAULT_MAX_REPAIR_RUNS;
  let repairCostCapUsd = DEFAULT_REPAIR_COST_CAP_USD;
  const allowedDefectClasses: DefectClass[] = [];
  let dryRun = false;
  let evaluateRepairedPatch = false;
  let includeAdHocRunLabels = false;

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
      case "--enable-patch-repair":
        enablePatchRepair = true;
        break;
      case "--repair-model":
        repairModel = next();
        break;
      case "--run-label": {
        const label = next();
        if (!runLabels.includes(label)) runLabels.push(label);
        break;
      }
      case "--max-repair-runs": {
        const raw = next();
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) throw new Error(`--max-repair-runs must be a non-negative integer (got ${raw}).`);
        maxRepairRuns = n;
        break;
      }
      case "--repair-cost-cap-usd": {
        const raw = next();
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) throw new Error(`--repair-cost-cap-usd must be a non-negative number (got ${raw}).`);
        repairCostCapUsd = n;
        break;
      }
      case "--allow-defect-class": {
        const cls = next() as DefectClass;
        if (!KNOWN_DEFECT_CLASSES.includes(cls)) {
          throw new Error(`--allow-defect-class must be one of {${KNOWN_DEFECT_CLASSES.join(", ")}} (got ${cls}).`);
        }
        if (!allowedDefectClasses.includes(cls)) allowedDefectClasses.push(cls);
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      case "--evaluate-repaired-patch":
        evaluateRepairedPatch = true;
        break;
      case "--include-ad-hoc-run-labels":
        includeAdHocRunLabels = true;
        break;
      case "--help":
      case "-h":
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    resultsDir,
    outName,
    enablePatchRepair,
    repairModel,
    runLabels,
    maxRepairRuns,
    repairCostCapUsd,
    // Default allowed classes deliberately EXCLUDE missing_failing_behavior.
    allowedDefectClasses: allowedDefectClasses.length > 0 ? allowedDefectClasses : DEFAULT_ALLOWED_DEFECT_CLASSES,
    dryRun,
    evaluateRepairedPatch,
    includeAdHocRunLabels,
  };
}

// ---------------------------------------------------------------------------
// Read-only, fail-soft candidate loading
// ---------------------------------------------------------------------------

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readText(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

interface CriticInputDoc {
  readonly instanceId?: string;
  readonly issueText?: string | null;
  readonly firstPatch?: string;
}

// A run considered for repair, with its live-critic artifacts loaded (any may be absent) and its
// artifact-derived eligibility already computed. Building a candidate calls NO model.
export interface RepairCandidate {
  readonly runLabel: string;
  readonly instanceId: string;
  // Whether this candidate came from the curated universe or an opt-in ad hoc run label.
  readonly source: CandidateSource;
  readonly meta: LiveCriticMeta | null;
  readonly report: PatchCriticReport | null;
  readonly firstPatch: string | null;
  readonly issueText: string | null;
  readonly eligibility: RepairEligibility;
}

export async function loadRepairCandidate(
  resultsDir: string,
  runLabel: string,
  allowedDefectClasses: readonly DefectClass[],
  source: CandidateSource = "curated_existing",
): Promise<RepairCandidate> {
  const dir = path.join(resultsDir, "runs", runLabel, "raw", "vtrace");
  const [meta, report, inputDoc, firstPatchDiff] = await Promise.all([
    readJson<LiveCriticMeta>(path.join(dir, "_patch_critic.meta.json")),
    readJson<PatchCriticReport>(path.join(dir, "_patch_critic_report.json")),
    readJson<CriticInputDoc>(path.join(dir, "_patch_critic_input.json")),
    readText(path.join(dir, "_first_patch.diff")),
  ]);
  // Prefer the canonical _first_patch.diff; fall back to the patch recorded in the critic input.
  const firstPatch = firstPatchDiff ?? inputDoc?.firstPatch ?? null;
  const eligibility = evaluateRepairEligibility({ runLabel, meta, report, firstPatch, allowedDefectClasses });
  return {
    runLabel,
    instanceId: report?.instanceId ?? inputDoc?.instanceId ?? "unknown",
    source,
    meta,
    report,
    firstPatch,
    issueText: inputDoc?.issueText ?? null,
    eligibility,
  };
}

// Each label paired with its provenance, so curated and ad hoc candidates are tagged consistently.
export interface LabeledRunSource {
  readonly runLabel: string;
  readonly source: CandidateSource;
}

export async function loadRepairCandidates(
  resultsDir: string,
  labels: readonly (string | LabeledRunSource)[],
  allowedDefectClasses: readonly DefectClass[],
): Promise<RepairCandidate[]> {
  return Promise.all(
    labels.map((l) => {
      const { runLabel, source } = typeof l === "string" ? { runLabel: l, source: "curated_existing" as const } : l;
      return loadRepairCandidate(resultsDir, runLabel, allowedDefectClasses, source);
    }),
  );
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export interface RepairGateConfig {
  readonly runLabels: readonly string[]; // REQUIRED: empty ⇒ nothing repaired
  readonly maxRepairRuns: number;
  readonly repairCostCapUsd: number;
  readonly allowedDefectClasses: readonly DefectClass[];
  readonly dryRun: boolean;
  readonly evaluateRepairedPatch: boolean;
}

export type RepairSkipReason =
  | "run-label-required"
  | "not-in-run-label"
  | "ineligible"
  | "max-repair-runs"
  | "cost-cap";

// What an actually-invoked repair produced (carried so the runner can write artifacts).
export interface RepairInvocation {
  readonly result: PatchRepairResult;
  readonly input: PatchRepairInput;
  readonly meta: PatchRepairMeta;
  readonly artifacts: Record<string, string>;
}

export interface RepairRunDecision {
  readonly runLabel: string;
  readonly instanceId: string;
  readonly source: CandidateSource;
  readonly defectClass: DefectClass;
  readonly instructionQuality: InstructionQuality;
  readonly eligible: boolean; // passed run-label + artifact eligibility
  readonly repaired: boolean; // repair model actually invoked
  readonly wouldRepair: boolean; // dry-run: would have been invoked
  readonly skipReason: RepairSkipReason | null;
  readonly reason: string;
  readonly ineligibleReasons: readonly string[];
  readonly invocation: RepairInvocation | null;
}

export interface RepairCounters {
  readonly candidateRuns: number;
  readonly eligibleRuns: number;
  readonly skippedByRunLabel: number;
  readonly skippedIneligible: number;
  readonly skippedByMaxRuns: number;
  readonly stoppedByCostCap: number;
  readonly repairCallsAttempted: number;
  readonly repairCallsSucceeded: number;
  readonly repairCallsFailedOpen: number;
  readonly repairedPatchProduced: number;
  readonly changedPatchCount: number;
  readonly totalRepairCostUsd: number;
}

export interface GatedRepairOutcome {
  readonly decisions: readonly RepairRunDecision[];
  readonly counters: RepairCounters;
}

function buildRepairInput(candidate: RepairCandidate): PatchRepairInput {
  // Only called for eligible candidates, so report/firstPatch are present.
  const report = candidate.report!;
  return {
    instanceId: candidate.instanceId,
    runLabel: candidate.runLabel,
    defectClass: candidate.eligibility.defectClass,
    issueText: candidate.issueText,
    firstPatch: candidate.firstPatch!,
    criticReport: report,
    repairInstructions: report.repair_instructions,
  };
}

function buildRepairMeta(args: {
  readonly candidate: RepairCandidate;
  readonly outcome: RunPatchRepairOutcome;
  readonly evaluateRepairedPatch: boolean;
}): PatchRepairMeta {
  const { candidate, outcome, evaluateRepairedPatch } = args;
  return {
    enabled: true,
    runLabel: candidate.runLabel,
    instanceId: candidate.instanceId,
    defectClass: candidate.eligibility.defectClass,
    instructionQuality: candidate.eligibility.instructionQuality,
    result: outcome.result,
    evaluation: {
      requested: evaluateRepairedPatch,
      performed: false,
      note: evaluateRepairedPatch
        ? "Evaluation requested but DEFERRED: no Docker in this milestone. The repaired patch artifact was produced and would be evaluated later. No resolution is claimed."
        : "Evaluation not requested. The repaired patch artifact would be evaluated later. No resolution is claimed.",
    },
  };
}

// Walk the candidates IN ORDER, applying the gates, and invoke the single-attempt repair only on
// approved runs. Gates are consulted via the cheap artifact-derived eligibility + running counters
// (call count, accumulated cost) — never the model. Fail-open per run is preserved by
// `runPatchRepair`; the gate never throws on a repair failure. In `dryRun` mode no model is called
// and approved runs are recorded as `wouldRepair`.
export async function runGatedRepair(args: {
  readonly candidates: readonly RepairCandidate[];
  readonly gate: RepairGateConfig;
  readonly caller: RepairCaller;
  readonly repairModel: string | null;
}): Promise<GatedRepairOutcome> {
  const { candidates, gate, caller, repairModel } = args;
  const decisions: RepairRunDecision[] = [];

  let eligibleRuns = 0;
  let skippedByRunLabel = 0;
  let skippedIneligible = 0;
  let skippedByMaxRuns = 0;
  let stoppedByCostCap = 0;
  let repairCallsAttempted = 0;
  let repairCallsSucceeded = 0;
  let repairCallsFailedOpen = 0;
  let repairedPatchProduced = 0;
  let changedPatchCount = 0;
  let totalRepairCostUsd = 0;

  let committed = 0;

  for (const candidate of candidates) {
    const base = {
      runLabel: candidate.runLabel,
      instanceId: candidate.instanceId,
      source: candidate.source,
      defectClass: candidate.eligibility.defectClass,
      instructionQuality: candidate.eligibility.instructionQuality,
    };
    const skip = (skipReason: RepairSkipReason, reason: string, eligible: boolean): void => {
      decisions.push({
        ...base,
        eligible,
        repaired: false,
        wouldRepair: false,
        skipReason,
        reason,
        ineligibleReasons: candidate.eligibility.reasons,
        invocation: null,
      });
    };

    // --- run-label gate (REQUIRED) -----------------------------------------
    if (gate.runLabels.length === 0) {
      skippedByRunLabel += 1;
      skip("run-label-required", "no --run-label provided; repair requires explicit run labels", false);
      continue;
    }
    if (!gate.runLabels.includes(candidate.runLabel)) {
      skippedByRunLabel += 1;
      skip("not-in-run-label", `not in --run-label set {${gate.runLabels.join(", ")}}`, false);
      continue;
    }

    // --- artifact-derived eligibility --------------------------------------
    if (!candidate.eligibility.eligible) {
      skippedIneligible += 1;
      skip("ineligible", `ineligible: ${candidate.eligibility.reasons.join("; ")}`, false);
      continue;
    }

    eligibleRuns += 1;

    // --- bounded by call count + cost cap ----------------------------------
    if (committed >= gate.maxRepairRuns) {
      skippedByMaxRuns += 1;
      skip("max-repair-runs", `--max-repair-runs=${gate.maxRepairRuns} reached`, true);
      continue;
    }
    if (!gate.dryRun && totalRepairCostUsd >= gate.repairCostCapUsd) {
      stoppedByCostCap += 1;
      skip(
        "cost-cap",
        `accumulated $${totalRepairCostUsd.toFixed(4)} >= --repair-cost-cap-usd $${gate.repairCostCapUsd.toFixed(4)}`,
        true,
      );
      continue;
    }

    committed += 1;

    if (gate.dryRun) {
      decisions.push({
        ...base,
        eligible: true,
        repaired: false,
        wouldRepair: true,
        skipReason: null,
        reason: "would attempt one repair (dry-run: model NOT invoked)",
        ineligibleReasons: [],
        invocation: null,
      });
      continue;
    }

    // --- the single bounded repair attempt ---------------------------------
    const input = buildRepairInput(candidate);
    const outcome = await runPatchRepair({ enabled: true, input, caller, repairModel });
    repairCallsAttempted += 1;
    totalRepairCostUsd += outcome.result.repairCostUsd ?? 0;
    if (outcome.result.validPatch) repairCallsSucceeded += 1;
    if (outcome.result.failedOpen) repairCallsFailedOpen += 1;
    if (outcome.result.repairedPatch !== null) repairedPatchProduced += 1;
    if (outcome.result.changedPatch) changedPatchCount += 1;

    const meta = buildRepairMeta({ candidate, outcome, evaluateRepairedPatch: gate.evaluateRepairedPatch });
    const artifacts = buildRepairArtifacts({ input, outcome, meta });

    decisions.push({
      ...base,
      eligible: true,
      repaired: true,
      wouldRepair: false,
      skipReason: null,
      reason: outcome.result.failedOpen ? "repair attempted; failed open (first patch preserved)" : "repair attempted",
      ineligibleReasons: [],
      invocation: { result: outcome.result, input, meta, artifacts },
    });
  }

  return {
    decisions,
    counters: {
      candidateRuns: candidates.length,
      eligibleRuns,
      skippedByRunLabel,
      skippedIneligible,
      skippedByMaxRuns,
      stoppedByCostCap,
      repairCallsAttempted,
      repairCallsSucceeded,
      repairCallsFailedOpen,
      repairedPatchProduced,
      changedPatchCount,
      totalRepairCostUsd,
    },
  };
}

// ---------------------------------------------------------------------------
// Report (pure)
// ---------------------------------------------------------------------------

export interface RepairSummary {
  readonly candidateRuns: number;
  readonly eligibleRuns: number;
  readonly repairCallsAttempted: number;
  readonly repairCallsSucceeded: number;
  readonly repairCallsFailedOpen: number;
  readonly repairedPatchProduced: number;
  readonly changedPatchCount: number;
  readonly totalRepairCostUsd: number;
}

export interface RepairGateConfigReport {
  readonly enabled: boolean;
  readonly runLabels: readonly string[];
  readonly maxRepairRuns: number;
  readonly repairCostCapUsd: number;
  readonly allowedDefectClasses: readonly DefectClass[];
  readonly dryRun: boolean;
  readonly evaluateRepairedPatch: boolean;
}

export interface RepairRunReportRow {
  readonly runLabel: string;
  readonly instanceId: string;
  readonly source: CandidateSource;
  readonly defectClass: DefectClass;
  readonly instructionQuality: InstructionQuality;
  readonly eligible: boolean;
  readonly repaired: boolean;
  readonly wouldRepair: boolean;
  readonly skipReason: RepairSkipReason | null;
  readonly reason: string;
  readonly ineligibleReasons: readonly string[];
  readonly result: PatchRepairResult | null;
}

// Ad hoc audit trail: how many requested labels were outside the curated universe, and how many of
// those produced a candidate (always = requested here, since loadRepairCandidate is fail-soft and a
// non-existent run still yields an ineligible candidate that is reported, not dropped).
export interface RepairAdHocCounters {
  readonly adHocRequested: number;
  readonly adHocCandidates: number;
}

export const EMPTY_REPAIR_AD_HOC_COUNTERS: RepairAdHocCounters = { adHocRequested: 0, adHocCandidates: 0 };

export interface RepairReport {
  readonly generatedAt: string | null;
  readonly enabled: boolean;
  readonly summary: RepairSummary;
  readonly gates: RepairGateConfigReport;
  readonly counters: RepairCounters;
  readonly adHoc: RepairAdHocCounters;
  readonly runs: readonly RepairRunReportRow[];
  readonly nonClaims: readonly string[];
}

export const NON_CLAIMS: readonly string[] = [
  "Benchmark-only and DISABLED by default; without --enable-patch-repair no model is called and no repair artifacts are written.",
  "Repair requires an explicit --run-label; with none provided nothing is repaired.",
  "EXACTLY ONE bounded repair attempt per eligible run — never a loop and never a retry.",
  "Only wrong_scope and broad_rewrite_minimality are repaired by default; missing_failing_behavior is excluded (undecided class).",
  "Fail-open: any invocation error or invalid diff preserves the original first patch (repairedPatch=null, failedOpen=true).",
  "The original first patch, raw agent output, and workspace are never modified; repair artifacts live in an isolated repair/ subdir.",
  "No Docker / evaluation is run this milestone; a repaired patch artifact is produced and would be evaluated later. No resolution is claimed.",
  "This changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / deterministic-critic / live-critic behavior.",
];

export function buildRepairReport(args: {
  readonly generatedAt: string | null;
  readonly enabled: boolean;
  readonly gate: RepairGateConfig;
  readonly outcome: GatedRepairOutcome;
  readonly adHoc?: RepairAdHocCounters;
}): RepairReport {
  const { generatedAt, enabled, gate, outcome } = args;
  const adHoc = args.adHoc ?? EMPTY_REPAIR_AD_HOC_COUNTERS;
  const c = outcome.counters;
  return {
    generatedAt,
    enabled,
    summary: {
      candidateRuns: c.candidateRuns,
      eligibleRuns: c.eligibleRuns,
      repairCallsAttempted: c.repairCallsAttempted,
      repairCallsSucceeded: c.repairCallsSucceeded,
      repairCallsFailedOpen: c.repairCallsFailedOpen,
      repairedPatchProduced: c.repairedPatchProduced,
      changedPatchCount: c.changedPatchCount,
      totalRepairCostUsd: c.totalRepairCostUsd,
    },
    gates: {
      enabled,
      runLabels: gate.runLabels,
      maxRepairRuns: gate.maxRepairRuns,
      repairCostCapUsd: gate.repairCostCapUsd,
      allowedDefectClasses: gate.allowedDefectClasses,
      dryRun: gate.dryRun,
      evaluateRepairedPatch: gate.evaluateRepairedPatch,
    },
    counters: c,
    adHoc,
    runs: outcome.decisions.map((d) => ({
      runLabel: d.runLabel,
      instanceId: d.instanceId,
      source: d.source,
      defectClass: d.defectClass,
      instructionQuality: d.instructionQuality,
      eligible: d.eligible,
      repaired: d.repaired,
      wouldRepair: d.wouldRepair,
      skipReason: d.skipReason,
      reason: d.reason,
      ineligibleReasons: d.ineligibleReasons,
      result: d.invocation ? d.invocation.result : null,
    })),
    nonClaims: NON_CLAIMS,
  };
}

export function renderJson(report: RepairReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function decisionLabel(r: RepairRunReportRow): string {
  if (r.repaired) return r.result?.failedOpen ? "repaired (failed-open)" : "repaired";
  if (r.wouldRepair) return "would-repair (dry-run)";
  return `skipped: ${r.skipReason ?? "—"}`;
}

export function renderMarkdown(report: RepairReport): string {
  const { summary, counters, gates } = report;
  const L: string[] = [];

  L.push("# Stage 5 patch repair run");
  L.push("");
  if (report.generatedAt) L.push(`_Generated: ${report.generatedAt}_`, "");
  L.push(
    "_Benchmark-only gated one-repair-attempt mode. Disabled unless `--enable-patch-repair`; repair requires an explicit " +
      "`--run-label`. Exactly one bounded attempt per eligible run, no loop, no Docker. The original first patch, raw " +
      "agent output, and workspace are never modified; repair artifacts live in an isolated `repair/` subdir._",
  );
  L.push("");

  L.push("## Summary");
  L.push("");
  L.push(
    `enabled=${report.enabled}; ${summary.candidateRuns} candidate run(s), ${summary.eligibleRuns} eligible. ` +
      `Repair calls attempted ${summary.repairCallsAttempted}, succeeded ${summary.repairCallsSucceeded}, ` +
      `failed-open ${summary.repairCallsFailedOpen}. Repaired patches produced ${summary.repairedPatchProduced} ` +
      `(changed ${summary.changedPatchCount}). Total repair cost $${summary.totalRepairCostUsd.toFixed(4)}.`,
  );
  L.push("");
  L.push("| metric | value |");
  L.push("| --- | --- |");
  L.push(`| candidateRuns | ${summary.candidateRuns} |`);
  L.push(`| eligibleRuns | ${summary.eligibleRuns} |`);
  L.push(`| repairCallsAttempted | ${summary.repairCallsAttempted} |`);
  L.push(`| repairCallsSucceeded | ${summary.repairCallsSucceeded} |`);
  L.push(`| repairCallsFailedOpen | ${summary.repairCallsFailedOpen} |`);
  L.push(`| repairedPatchProduced | ${summary.repairedPatchProduced} |`);
  L.push(`| changedPatchCount | ${summary.changedPatchCount} |`);
  L.push(`| totalRepairCostUsd | $${summary.totalRepairCostUsd.toFixed(4)} |`);
  L.push("");

  L.push("## Eligibility gates");
  L.push("");
  L.push(
    `enabled=${gates.enabled}; dryRun=${gates.dryRun}; runLabels=${gates.runLabels.length > 0 ? `{${gates.runLabels.join(", ")}}` : "(none — repair requires explicit labels)"}; ` +
      `maxRepairRuns=${gates.maxRepairRuns}; repairCostCapUsd=$${gates.repairCostCapUsd.toFixed(4)}; ` +
      `allowedDefectClasses={${gates.allowedDefectClasses.join(", ")}}; evaluateRepairedPatch=${gates.evaluateRepairedPatch}.`,
  );
  L.push("");
  L.push("A run is repair-eligible only when ALL hold: valid live-critic report; failedOpen=false; liveRepairRequired=true; ");
  L.push("report repair_required=true with non-empty repair_reason and repair_instructions; first patch present; defect class ");
  L.push("in the allowed set; instruction quality concrete or actionable; AND the run is explicitly named by --run-label.");
  L.push("");
  L.push("| gate counter | value |");
  L.push("| --- | --- |");
  for (const [k, v] of Object.entries(counters)) {
    L.push(`| ${k} | ${k === "totalRepairCostUsd" ? `$${(v as number).toFixed(4)}` : v} |`);
  }
  for (const [k, v] of Object.entries(report.adHoc)) L.push(`| ${k} | ${v} |`);
  L.push("");

  const repaired = report.runs.filter((r) => r.repaired || r.wouldRepair);
  const skipped = report.runs.filter((r) => !r.repaired && !r.wouldRepair);

  L.push("## Runs repaired");
  L.push("");
  if (repaired.length === 0) {
    L.push("_No runs were repaired in this invocation._");
  } else {
    L.push("| run | source | instance | defect class | instruction | decision | valid | changed | failed-open | cost |");
    L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of repaired) {
      const res = r.result;
      L.push(
        `| ${r.runLabel} | ${r.source} | ${r.instanceId} | ${r.defectClass} | ${r.instructionQuality} | ${decisionLabel(r)} | ` +
          `${res ? res.validPatch : "—"} | ${res ? res.changedPatch : "—"} | ${res ? res.failedOpen : "—"} | ` +
          `${res?.repairCostUsd != null ? `$${res.repairCostUsd.toFixed(4)}` : "—"} |`,
      );
    }
  }
  L.push("");

  L.push("## Runs skipped");
  L.push("");
  if (skipped.length === 0) {
    L.push("_No runs were skipped._");
  } else {
    L.push("| run | source | instance | defect class | skip reason | detail |");
    L.push("| --- | --- | --- | --- | --- | --- |");
    for (const r of skipped) {
      L.push(`| ${r.runLabel} | ${r.source} | ${r.instanceId} | ${r.defectClass} | ${r.skipReason ?? "—"} | ${r.reason} |`);
    }
  }
  L.push("");

  L.push("## Repair artifact summary");
  L.push("");
  L.push(
    "For each repaired run, artifacts are written to `results/runs/<runLabel>/raw/vtrace/repair/`: " +
      "`_patch_repair_input.json`, `_patch_repair.raw.txt`, `_patch_repair_result.json`, `_patch_repair.meta.json`, " +
      "`_first_patch.diff` (a copy — the original is untouched), and `_repaired_patch.diff` (only when a valid repaired " +
      "patch was produced).",
  );
  L.push("");

  L.push("## Cost and token impact");
  L.push("");
  L.push("| run | cost | input tok | output tok |");
  L.push("| --- | --- | --- | --- |");
  for (const r of report.runs) {
    const res = r.result;
    L.push(
      `| ${r.runLabel} | ${res?.repairCostUsd != null ? `$${res.repairCostUsd.toFixed(4)}` : "—"} | ` +
        `${res?.repairInputTokens ?? "—"} | ${res?.repairOutputTokens ?? "—"} |`,
    );
  }
  L.push("");
  L.push(`Total repair cost: $${summary.totalRepairCostUsd.toFixed(4)}.`);
  L.push("");

  L.push("## Safety properties");
  L.push("");
  L.push("| property | value |");
  L.push("| --- | --- |");
  L.push(`| disabled by default | ${!report.enabled || gates.dryRun ? "respected" : "enabled this run"} |`);
  L.push(`| run-label required | true |`);
  L.push(`| one attempt only (no loop) | true |`);
  L.push(`| missing_failing_behavior excluded by default | ${!gates.allowedDefectClasses.includes("missing_failing_behavior")} |`);
  L.push(`| Docker / evaluation run | false |`);
  L.push(`| original first patch modified | false |`);
  L.push(`| original workspace modified | false |`);
  L.push(`| repair failed-open count | ${summary.repairCallsFailedOpen} |`);
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

async function main(config: CliConfig): Promise<void> {
  if (!config.enablePatchRepair) {
    process.stdout.write(
      [
        "Stage 5 gated patch repair is DISABLED (pass --enable-patch-repair to invoke it).",
        "No model was called, no repair artifacts were written, and no run behavior changed.",
        "",
      ].join("\n"),
    );
    return;
  }

  const generatedAt = new Date().toISOString();
  const caller = makeClaudeRepairCaller();

  // --- Phase 1: load candidates (read-only; no model) ------------------------
  // Curated candidates always; with opt-in, also any requested --run-label outside the curated set
  // (its live-critic artifacts must already exist on disk — repair never invokes the critic).
  const curated = new Set(REPAIR_CANDIDATE_LABELS);
  const adHocLabels = config.includeAdHocRunLabels
    ? config.runLabels.filter((l) => !curated.has(l))
    : [];
  const labeled: LabeledRunSource[] = [
    ...REPAIR_CANDIDATE_LABELS.map((runLabel) => ({ runLabel, source: "curated_existing" as const })),
    ...adHocLabels.map((runLabel) => ({ runLabel, source: "ad_hoc_run_label" as const })),
  ];
  const candidates = await loadRepairCandidates(config.resultsDir, labeled, config.allowedDefectClasses);
  const adHocCounters: RepairAdHocCounters = {
    adHocRequested: adHocLabels.length,
    adHocCandidates: adHocLabels.length,
  };

  // Surface a --run-label that matches no candidate (it would silently repair nothing).
  const known = new Set(candidates.map((c) => c.runLabel));
  const unknownLabels = config.runLabels.filter((l) => !known.has(l));
  if (unknownLabels.length > 0) {
    const hint = config.includeAdHocRunLabels ? "" : " (pass --include-ad-hoc-run-labels to include new runs)";
    process.stderr.write(`WARNING: --run-label not found among candidates: ${unknownLabels.join(", ")}${hint}\n`);
  }

  // --- Phase 2: apply gates, attempt one repair per approved run -------------
  const gate: RepairGateConfig = {
    runLabels: config.runLabels,
    maxRepairRuns: config.maxRepairRuns,
    repairCostCapUsd: config.repairCostCapUsd,
    allowedDefectClasses: config.allowedDefectClasses,
    dryRun: config.dryRun,
    evaluateRepairedPatch: config.evaluateRepairedPatch,
  };
  const outcome = await runGatedRepair({ candidates, gate, caller, repairModel: config.repairModel });

  // --- Phase 3: write repair artifacts (real attempts only; isolated subdir) -
  if (!config.dryRun) {
    for (const decision of outcome.decisions) {
      if (!decision.repaired || decision.invocation === null) continue;
      // Isolated repair/ subdir — never overwrites the original critic/first-patch artifacts.
      const repairDir = path.join(config.resultsDir, "runs", decision.runLabel, "raw", "vtrace", "repair");
      await mkdir(repairDir, { recursive: true });
      for (const [name, content] of Object.entries(decision.invocation.artifacts)) {
        await writeFile(path.join(repairDir, name), content);
      }
    }
  }

  const report = buildRepairReport({ generatedAt, enabled: true, gate, outcome, adHoc: adHocCounters });
  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  const c = outcome.counters;
  process.stdout.write(
    [
      `Stage 5 gated patch repair report written${config.dryRun ? " (DRY RUN — no model called)" : ""}:`,
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Candidates: ${c.candidateRuns}   Eligible: ${c.eligibleRuns}`,
      config.includeAdHocRunLabels
        ? `Ad hoc — requested: ${adHocCounters.adHocRequested}   candidates: ${adHocCounters.adHocCandidates}${adHocLabels.length > 0 ? ` (${adHocLabels.join(", ")})` : ""}`
        : "",
      `Skipped — runLabel: ${c.skippedByRunLabel}   ineligible: ${c.skippedIneligible}   maxRuns: ${c.skippedByMaxRuns}   costCap: ${c.stoppedByCostCap}`,
      config.dryRun
        ? `Would repair: ${outcome.decisions.filter((d) => d.wouldRepair).length} run(s).`
        : `Repair calls — attempted: ${c.repairCallsAttempted}   succeeded: ${c.repairCallsSucceeded}   failed-open: ${c.repairCallsFailedOpen}   produced: ${c.repairedPatchProduced}   changed: ${c.changedPatchCount}   cost: $${c.totalRepairCostUsd.toFixed(4)}`,
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
