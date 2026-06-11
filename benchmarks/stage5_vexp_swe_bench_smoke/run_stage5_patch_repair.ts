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
  type GeneratedParserRepairEligibility,
  type PatchMinimalityProbe,
  type PatchRepairInput,
  type PatchRepairMeta,
  type PatchRepairResult,
  type RepairCaller,
  type RepairEligibility,
  type RunPatchRepairOutcome,
  DEFAULT_ALLOWED_DEFECT_CLASSES,
  GENERATED_PARSER_NARROW_REWRITE_GUIDANCE,
  GENERATED_PARSER_REPAIR_LIVE_SOURCE,
  buildGeneratedParserRepairGuidance,
  buildRepairArtifacts,
  evaluateGeneratedParserRepairEligibility,
  evaluateRepairEligibility,
  makeClaudeRepairCaller,
  runPatchRepair,
} from "./stage5_patch_repair";
import { findRunRow } from "./run_stage5_generated_parser_critic_agreement_report";

export const DEFAULT_OUT_NAME = "stage5_patch_repair";
export const DEFAULT_MAX_REPAIR_RUNS = 1;
export const DEFAULT_REPAIR_COST_CAP_USD = 0.25;

// The live-critic summary report that carries the deterministic generated-parser patch-minimality
// probe per run row (there is no per-run raw artifact for these fields). Read-only.
export const GENERATED_PARSER_PROBE_SUMMARY_BASENAME = "stage5_live_critic_generated_parser_astropy";

// The dry-run-only boundary the generated-parser report MUST state.
export const GENERATED_PARSER_DRY_RUN_BOUNDARY =
  "This is dry-run eligibility only. No repaired patch was generated, no patch was modified, and no Docker evaluation was run.";

// The boundary a generated-parser LIVE repair attempt MUST state: it produces a repaired patch only,
// runs no Docker, and makes no repair-conversion (resolution) claim.
export const GENERATED_PARSER_LIVE_REPAIR_BOUNDARY =
  "This generated a repaired patch only. It did not run Docker and does not claim a repair conversion.";

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
  // Opt-in: enable the SEPARATE generated-parser repair eligibility path (dry-run only). DEFAULT
  // false. When false, generated-parser runs stay ineligible exactly as before. This adds NO defect
  // class to the default allowlist and NEVER produces a repaired patch.
  readonly allowGeneratedParserRepair: boolean;
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
  let allowGeneratedParserRepair = false;

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
      case "--allow-generated-parser-repair":
        allowGeneratedParserRepair = true;
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
    allowGeneratedParserRepair,
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
  // Deterministic generated-parser patch-minimality probe for this run (from the live-critic
  // summary report), or null when no probe row exists. Only the generated-parser repair path reads
  // it; null leaves the run ineligible for that path.
  readonly patchMinimalityProbe: PatchMinimalityProbe | null;
}

// Read the deterministic generated-parser patch-minimality probe for one run from the live-critic
// summary report. Read-only and fail-soft: returns null when the file or the run row is absent.
export async function loadPatchMinimalityProbe(
  resultsDir: string,
  runLabel: string,
  summaryBasename: string = GENERATED_PARSER_PROBE_SUMMARY_BASENAME,
): Promise<PatchMinimalityProbe | null> {
  const doc = await readJson<unknown>(path.join(resultsDir, `${summaryBasename}.json`));
  const row = findRunRow(doc, runLabel);
  if (row === null) return null;
  const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  const asStr = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const asStrArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  // Only treat this as a probe row when a generated-parser minimality field is actually present.
  const hasProbeFields =
    "patchMinimalityRepairRequired" in row ||
    "patchMinimalityDefectClass" in row ||
    "patchMinimalitySignals" in row;
  if (!hasProbeFields) return null;
  return {
    patchMinimalityRepairRequired: asBool(row.patchMinimalityRepairRequired),
    patchMinimalityDefectClass: asStr(row.patchMinimalityDefectClass),
    patchMinimalityRisk: asStr(row.patchMinimalityRisk),
    patchMinimalityConfidence: asStr(row.patchMinimalityConfidence),
    patchMinimalityNarrowAlternativeHint: asStr(row.patchMinimalityNarrowAlternativeHint),
    patchMinimalitySignals: asStrArr(row.patchMinimalitySignals),
  };
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
  const patchMinimalityProbe = await loadPatchMinimalityProbe(resultsDir, runLabel);
  return {
    runLabel,
    instanceId: report?.instanceId ?? inputDoc?.instanceId ?? "unknown",
    source,
    meta,
    report,
    firstPatch,
    issueText: inputDoc?.issueText ?? null,
    eligibility,
    patchMinimalityProbe,
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
  // Opt-in generated-parser repair path. DEFAULT false ⇒ behavior unchanged. Dry-run produces an
  // eligibility report; LIVE execution additionally requires enablePatchRepair=true (and dryRun=false).
  readonly allowGeneratedParserRepair?: boolean;
  // The master repair enable flag (`--enable-patch-repair`). REQUIRED for any LIVE generated-parser
  // execution; not consulted by the default path (which is gated by main() before runGatedRepair is
  // reached). Optional/false ⇒ generated-parser repair can only ever reach dry-run would-repair.
  readonly enablePatchRepair?: boolean;
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
  // Whether this run became eligible via the generated-parser path (dry-run only) rather than the
  // default allowlist path. False for every default-path decision.
  readonly viaGeneratedParser: boolean;
  // The generated-parser eligibility evaluation for this run, when its run-label gate passed and a
  // probe/flag made it relevant; null otherwise. Carries the gate/blocked reasons for the report.
  readonly generatedParser: GeneratedParserRepairEligibility | null;
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

// Build the LIVE repair input for a generated-parser candidate. Like buildRepairInput, but it
// attaches the generated-parser narrow-rewrite guidance (folding in the live critic instruction and
// the deterministic probe hint) and marks the source as generated_parser_minimality. Only called for
// runs that became eligible via the generated-parser path in live mode.
function buildGeneratedParserRepairInput(candidate: RepairCandidate): PatchRepairInput {
  const report = candidate.report!;
  const probe = candidate.patchMinimalityProbe;
  return {
    instanceId: candidate.instanceId,
    runLabel: candidate.runLabel,
    defectClass: candidate.eligibility.defectClass,
    issueText: candidate.issueText,
    firstPatch: candidate.firstPatch!,
    criticReport: report,
    repairInstructions: report.repair_instructions,
    generatedParserRepair: {
      source: GENERATED_PARSER_REPAIR_LIVE_SOURCE,
      guidance: buildGeneratedParserRepairGuidance(report, probe),
      liveCriticInstruction: report.repair_instructions,
      narrowAlternativeHint: probe?.patchMinimalityNarrowAlternativeHint ?? null,
    },
  };
}

function buildRepairMeta(args: {
  readonly candidate: RepairCandidate;
  readonly outcome: RunPatchRepairOutcome;
  readonly evaluateRepairedPatch: boolean;
  readonly viaGeneratedParser: boolean;
}): PatchRepairMeta {
  const { candidate, outcome, evaluateRepairedPatch, viaGeneratedParser } = args;
  return {
    enabled: true,
    runLabel: candidate.runLabel,
    instanceId: candidate.instanceId,
    defectClass: candidate.eligibility.defectClass,
    instructionQuality: candidate.eligibility.instructionQuality,
    result: outcome.result,
    generatedParserRepairSource: viaGeneratedParser ? GENERATED_PARSER_REPAIR_LIVE_SOURCE : null,
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

    // --- run-label gate (REQUIRED) — generated-parser eligibility is N/A out of scope -----
    const skipRunLabel = (skipReason: RepairSkipReason, reason: string): void => {
      decisions.push({
        ...base,
        eligible: false,
        repaired: false,
        wouldRepair: false,
        skipReason,
        reason,
        ineligibleReasons: candidate.eligibility.reasons,
        invocation: null,
        viaGeneratedParser: false,
        generatedParser: null,
      });
    };
    if (gate.runLabels.length === 0) {
      skippedByRunLabel += 1;
      skipRunLabel("run-label-required", "no --run-label provided; repair requires explicit run labels");
      continue;
    }
    if (!gate.runLabels.includes(candidate.runLabel)) {
      skippedByRunLabel += 1;
      skipRunLabel("not-in-run-label", `not in --run-label set {${gate.runLabels.join(", ")}}`);
      continue;
    }

    // --- generated-parser eligibility (SEPARATE path: dry-run eligibility OR live execution) ----
    // Computed only for runs that carry a deterministic patch-minimality probe; null otherwise so
    // default-path decisions stay clean. Eligibility requires the explicit flag, and either dry-run
    // (would-repair, no model) or --enable-patch-repair with dryRun=false (one bounded model call).
    const gpRelevant = candidate.patchMinimalityProbe != null;
    const gpElig = gpRelevant
      ? evaluateGeneratedParserRepairEligibility({
          runLabel: candidate.runLabel,
          allowGeneratedParserRepair: gate.allowGeneratedParserRepair === true,
          enablePatchRepair: gate.enablePatchRepair === true,
          dryRun: gate.dryRun,
          runLabelProvided: true,
          meta: candidate.meta,
          report: candidate.report,
          firstPatch: candidate.firstPatch,
          probe: candidate.patchMinimalityProbe,
        })
      : null;
    const generatedParser = gpElig;

    const standardEligible = candidate.eligibility.eligible;
    const eligibleViaGp = gpElig?.eligible === true;
    const viaGeneratedParser = !standardEligible && eligibleViaGp;

    const skip = (skipReason: RepairSkipReason, reason: string, eligible: boolean): void => {
      decisions.push({
        ...base,
        eligible,
        repaired: false,
        wouldRepair: false,
        skipReason,
        reason,
        ineligibleReasons:
          eligible || viaGeneratedParser
            ? []
            : gpElig !== null && !standardEligible
              ? gpElig.blockedReasons
              : candidate.eligibility.reasons,
        invocation: null,
        viaGeneratedParser,
        generatedParser,
      });
    };

    // --- artifact-derived eligibility (default path) OR generated-parser path ----
    if (!standardEligible && !eligibleViaGp) {
      skippedIneligible += 1;
      const reason =
        gpElig !== null
          ? `ineligible (generated-parser): ${gpElig.blockedReasons.join("; ")}`
          : `ineligible: ${candidate.eligibility.reasons.join("; ")}`;
      skip("ineligible", reason, false);
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
        reason: viaGeneratedParser
          ? "would attempt one generated-parser repair (dry-run ONLY: model NOT invoked, no patch produced)"
          : "would attempt one repair (dry-run: model NOT invoked)",
        ineligibleReasons: [],
        invocation: null,
        viaGeneratedParser,
        generatedParser,
      });
      continue;
    }

    // --- the single bounded repair attempt --------------------------------
    // Two live paths reach here: the default allowlist path, and the generated-parser path when it
    // became eligible in LIVE mode (--enable-patch-repair, dryRun=false). The generated-parser path
    // uses a dedicated narrow-rewrite input; both go through the same one-attempt, fail-open runner.
    const input = viaGeneratedParser ? buildGeneratedParserRepairInput(candidate) : buildRepairInput(candidate);
    const outcome = await runPatchRepair({ enabled: true, input, caller, repairModel });
    repairCallsAttempted += 1;
    totalRepairCostUsd += outcome.result.repairCostUsd ?? 0;
    if (outcome.result.validPatch) repairCallsSucceeded += 1;
    if (outcome.result.failedOpen) repairCallsFailedOpen += 1;
    if (outcome.result.repairedPatch !== null) repairedPatchProduced += 1;
    if (outcome.result.changedPatch) changedPatchCount += 1;

    const meta = buildRepairMeta({ candidate, outcome, evaluateRepairedPatch: gate.evaluateRepairedPatch, viaGeneratedParser });
    const artifacts = buildRepairArtifacts({ input, outcome, meta });

    const attemptKind = viaGeneratedParser ? "generated-parser repair" : "repair";
    decisions.push({
      ...base,
      eligible: true,
      repaired: true,
      wouldRepair: false,
      skipReason: null,
      reason: outcome.result.failedOpen
        ? `${attemptKind} attempted; failed open (first patch preserved)`
        : `${attemptKind} attempted`,
      ineligibleReasons: [],
      invocation: { result: outcome.result, input, meta, artifacts },
      viaGeneratedParser,
      generatedParser,
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
  // Whether any live repair model call was actually executed. ALWAYS false in dry-run (and thus
  // always false for the generated-parser path, which is dry-run-only).
  readonly repairExecuted: boolean;
}

export interface RepairGateConfigReport {
  readonly enabled: boolean;
  readonly runLabels: readonly string[];
  readonly maxRepairRuns: number;
  readonly repairCostCapUsd: number;
  readonly allowedDefectClasses: readonly DefectClass[];
  readonly dryRun: boolean;
  readonly evaluateRepairedPatch: boolean;
  readonly allowGeneratedParserRepair: boolean;
}

// Per-run generated-parser repair eligibility + (live) outcome, surfaced in the report. In dry-run
// `generatedParserRepairExecuted` / `repairExecuted` are false; in live mode they reflect the actual
// single bounded attempt.
export interface GeneratedParserRunReport {
  readonly runLabel: string;
  readonly instanceId: string;
  readonly generatedParserRepairAllowed: boolean;
  readonly generatedParserRepairEligible: boolean;
  readonly generatedParserRepairExecuted: boolean;
  readonly generatedParserRepairSource: string;
  readonly generatedParserRepairGuidance: readonly string[];
  readonly generatedParserRepairGateReasons: readonly string[];
  readonly generatedParserRepairBlockedReasons: readonly string[];
  readonly repairClass: string;
  readonly source: string;
  readonly mode: "dry-run" | "live" | "blocked";
  readonly patchMinimalityRepairRequired: boolean | null;
  readonly patchMinimalityDefectClass: string | null;
  readonly liveCriticRepairRequired: boolean | null;
  readonly liveCriticValid: boolean | null;
  readonly agreementWithDeterministic: boolean | null;
  readonly actionableNarrowRewriteGuidance: readonly string[];
  readonly wouldRepair: boolean;
  // The live one-attempt outcome (all false/null in dry-run or when no live attempt was made).
  readonly repairAttempted: boolean;
  readonly repairSucceeded: boolean;
  readonly repairFailedOpen: boolean;
  readonly repairCostUsd: number | null;
  readonly repairExecuted: boolean;
}

// Top-level generated-parser eligibility + (live) outcome summary.
export interface GeneratedParserReportSummary {
  readonly allowed: boolean;
  readonly mode: "dry-run" | "live";
  readonly eligibleRuns: number;
  readonly wouldRepairRuns: number;
  // Live one-attempt rollups (0 in dry-run).
  readonly repairAttemptedRuns: number;
  readonly repairSucceededRuns: number;
  readonly repairFailedOpenRuns: number;
  readonly repairExecuted: boolean;
  readonly narrowRewriteGuidance: readonly string[];
  // The dry-run eligibility boundary.
  readonly boundary: string;
  // The live-attempt boundary (a repaired patch only; no Docker; no repair-conversion claim).
  readonly liveBoundary: string;
  readonly runs: readonly GeneratedParserRunReport[];
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
  // True when the run became eligible via the generated-parser path (dry-run only).
  readonly viaGeneratedParser: boolean;
  // The generated-parser eligibility detail for this run, when relevant; null otherwise.
  readonly generatedParser: GeneratedParserRunReport | null;
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
  readonly generatedParser: GeneratedParserReportSummary;
  readonly nonClaims: readonly string[];
}

// Project a decision's generated-parser eligibility + (live) outcome into its report row (or null
// when not relevant). The live one-attempt fields are populated only when the run was actually
// repaired via the generated-parser path; dry-run and skipped runs leave them false/null.
function generatedParserRunReport(d: RepairRunDecision): GeneratedParserRunReport | null {
  const gp = d.generatedParser;
  if (gp === null) return null;
  const executed = d.viaGeneratedParser && d.repaired;
  const result = executed ? d.invocation?.result ?? null : null;
  return {
    runLabel: d.runLabel,
    instanceId: d.instanceId,
    generatedParserRepairAllowed: gp.allowed,
    generatedParserRepairEligible: gp.eligible,
    generatedParserRepairExecuted: executed,
    generatedParserRepairSource: GENERATED_PARSER_REPAIR_LIVE_SOURCE,
    generatedParserRepairGuidance: gp.actionableNarrowRewriteGuidance,
    generatedParserRepairGateReasons: gp.gateReasons,
    generatedParserRepairBlockedReasons: gp.blockedReasons,
    repairClass: gp.repairClass,
    source: gp.source,
    mode: gp.mode,
    patchMinimalityRepairRequired: gp.patchMinimalityRepairRequired,
    patchMinimalityDefectClass: gp.patchMinimalityDefectClass,
    liveCriticRepairRequired: gp.liveCriticRepairRequired,
    liveCriticValid: gp.liveCriticValid,
    agreementWithDeterministic: gp.agreementWithDeterministic,
    actionableNarrowRewriteGuidance: gp.actionableNarrowRewriteGuidance,
    wouldRepair: d.viaGeneratedParser && d.wouldRepair,
    repairAttempted: result !== null,
    repairSucceeded: result?.validPatch ?? false,
    repairFailedOpen: result?.failedOpen ?? false,
    repairCostUsd: result?.repairCostUsd ?? null,
    repairExecuted: executed,
  };
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
  "Generated-parser repair is a SEPARATE eligibility path behind --allow-generated-parser-repair; it is off by default and adds NO defect class to the default allowlist. Dry-run reports eligibility only; live execution additionally requires --enable-patch-repair with dryRun=false and runs exactly one bounded attempt.",
  "A generated-parser live attempt generates a repaired patch only. It did not run Docker and does not claim a repair conversion.",
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

  const gpRuns = outcome.decisions
    .map(generatedParserRunReport)
    .filter((r): r is GeneratedParserRunReport => r !== null);
  const generatedParser: GeneratedParserReportSummary = {
    allowed: gate.allowGeneratedParserRepair === true,
    mode: gate.dryRun ? "dry-run" : "live",
    eligibleRuns: gpRuns.filter((r) => r.generatedParserRepairEligible).length,
    wouldRepairRuns: gpRuns.filter((r) => r.wouldRepair).length,
    repairAttemptedRuns: gpRuns.filter((r) => r.repairAttempted).length,
    repairSucceededRuns: gpRuns.filter((r) => r.repairSucceeded).length,
    repairFailedOpenRuns: gpRuns.filter((r) => r.repairFailedOpen).length,
    repairExecuted: gpRuns.some((r) => r.repairExecuted),
    narrowRewriteGuidance: [...GENERATED_PARSER_NARROW_REWRITE_GUIDANCE],
    boundary: GENERATED_PARSER_DRY_RUN_BOUNDARY,
    liveBoundary: GENERATED_PARSER_LIVE_REPAIR_BOUNDARY,
    runs: gpRuns,
  };

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
      repairExecuted: c.repairCallsAttempted > 0,
    },
    gates: {
      enabled,
      runLabels: gate.runLabels,
      maxRepairRuns: gate.maxRepairRuns,
      repairCostCapUsd: gate.repairCostCapUsd,
      allowedDefectClasses: gate.allowedDefectClasses,
      dryRun: gate.dryRun,
      evaluateRepairedPatch: gate.evaluateRepairedPatch,
      allowGeneratedParserRepair: gate.allowGeneratedParserRepair === true,
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
      viaGeneratedParser: d.viaGeneratedParser,
      generatedParser: generatedParserRunReport(d),
    })),
    generatedParser,
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

  const gpLive = report.generatedParser.mode === "live";
  L.push(`## Generated-parser repair (${gpLive ? "live execution" : "dry-run eligibility"})`);
  L.push("");
  L.push(
    "SEPARATE eligibility path behind `--allow-generated-parser-repair`. Off by default; adds NO " +
      "defect class to the default allowlist. Dry-run reports eligibility only (no model); live " +
      "execution additionally requires `--enable-patch-repair` with dryRun=false and runs EXACTLY ONE " +
      "bounded attempt (fail-open, no loop).",
  );
  L.push("");
  L.push(gpLive ? `${report.generatedParser.liveBoundary}` : `${report.generatedParser.boundary}`);
  L.push("");
  L.push(
    `allowGeneratedParserRepair=${report.gates.allowGeneratedParserRepair}; mode=${report.generatedParser.mode}; ` +
      `eligible run(s): ${report.generatedParser.eligibleRuns}; ` +
      `would-repair run(s): ${report.generatedParser.wouldRepairRuns}; ` +
      `attempted: ${report.generatedParser.repairAttemptedRuns}; succeeded: ${report.generatedParser.repairSucceededRuns}; ` +
      `failed-open: ${report.generatedParser.repairFailedOpenRuns}; repairExecuted=${report.generatedParser.repairExecuted}.`,
  );
  L.push("");
  if (report.generatedParser.runs.length === 0) {
    L.push("_No generated-parser candidate runs were in scope this invocation._");
    L.push("");
  } else {
    L.push(
      "| run | instance | allowed | eligible | repairClass | det. minimality | live repair_required | agreement | narrow guidance | repairExecuted |",
    );
    L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of report.generatedParser.runs) {
      L.push(
        `| ${r.runLabel} | ${r.instanceId} | ${r.generatedParserRepairAllowed} | ${r.generatedParserRepairEligible} | ` +
          `${r.repairClass} | ${r.patchMinimalityRepairRequired} | ${r.liveCriticRepairRequired} | ` +
          `${r.agreementWithDeterministic} | ${r.actionableNarrowRewriteGuidance.length > 0 ? "yes" : "no"} | ${r.repairExecuted} |`,
      );
    }
    L.push("");
    for (const r of report.generatedParser.runs) {
      L.push(`### ${r.runLabel} — generated-parser ${r.mode === "live" ? "live repair" : "eligibility"}`);
      L.push("");
      L.push(`- eligible: ${r.generatedParserRepairEligible}`);
      L.push(`- wouldRepair: ${r.wouldRepair}`);
      L.push(`- repairClass: ${r.repairClass}`);
      L.push(`- source: ${r.source}`);
      L.push(`- mode: ${r.mode}`);
      L.push(`- generatedParserRepairSource: ${r.generatedParserRepairSource}`);
      L.push(`- repairExecuted: ${r.repairExecuted}`);
      L.push(`- repairAttempted: ${r.repairAttempted}`);
      L.push(`- repairSucceeded: ${r.repairSucceeded}`);
      L.push(`- repairFailedOpen: ${r.repairFailedOpen}`);
      L.push(`- repairCostUsd: ${r.repairCostUsd != null ? `$${r.repairCostUsd.toFixed(4)}` : "—"}`);
      L.push(`- patchMinimalityRepairRequired: ${r.patchMinimalityRepairRequired}`);
      L.push(`- patchMinimalityDefectClass: ${r.patchMinimalityDefectClass ?? "none"}`);
      L.push(`- liveCriticRepairRequired: ${r.liveCriticRepairRequired}`);
      L.push(`- liveCriticValid: ${r.liveCriticValid}`);
      L.push(`- agreementWithDeterministic: ${r.agreementWithDeterministic}`);
      if (r.generatedParserRepairGateReasons.length > 0) {
        L.push("- gates satisfied:");
        for (const g of r.generatedParserRepairGateReasons) L.push(`  - ${g}`);
      }
      if (r.generatedParserRepairBlockedReasons.length > 0) {
        L.push("- gates blocked:");
        for (const b of r.generatedParserRepairBlockedReasons) L.push(`  - ${b}`);
      }
      if (r.actionableNarrowRewriteGuidance.length > 0) {
        L.push(
          r.mode === "live"
            ? "- narrow-rewrite guidance (applied to the repair prompt):"
            : "- intended narrow-rewrite guidance (dry-run only; NOT applied):",
        );
        for (const g of r.actionableNarrowRewriteGuidance) L.push(`  - ${g}`);
      }
      L.push("");
    }
  }

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
  // DISABLED unless --enable-patch-repair OR --dry-run. A dry run calls no model and writes no
  // repair artifacts, so it is allowed to produce an eligibility report without --enable-patch-repair
  // (this is how the generated-parser dry-run eligibility report is generated). Without either flag,
  // nothing runs — existing disabled-by-default behavior is preserved.
  if (!config.enablePatchRepair && !config.dryRun) {
    process.stdout.write(
      [
        "Stage 5 gated patch repair is DISABLED (pass --enable-patch-repair to invoke it, or --dry-run for an eligibility-only report).",
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
    allowGeneratedParserRepair: config.allowGeneratedParserRepair,
    enablePatchRepair: config.enablePatchRepair,
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

  const report = buildRepairReport({ generatedAt, enabled: config.enablePatchRepair, gate, outcome, adHoc: adHocCounters });
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
      `Generated-parser repair — allowed: ${report.generatedParser.allowed}   mode: ${report.generatedParser.mode}   eligible: ${report.generatedParser.eligibleRuns}   wouldRepair: ${report.generatedParser.wouldRepairRuns}   attempted: ${report.generatedParser.repairAttemptedRuns}   succeeded: ${report.generatedParser.repairSucceededRuns}   repairExecuted: ${report.generatedParser.repairExecuted}`,
      ...report.generatedParser.runs.flatMap((r) =>
        r.generatedParserRepairEligible
          ? [
              `  ${r.runLabel}:`,
              `    eligible: ${r.generatedParserRepairEligible}`,
              `    mode: ${r.mode}`,
              `    wouldRepair: ${r.wouldRepair}`,
              `    repairClass: ${r.repairClass}`,
              `    source: ${r.source}`,
              `    generatedParserRepairSource: ${r.generatedParserRepairSource}`,
              `    repairExecuted: ${r.repairExecuted}`,
              `    repairAttempted: ${r.repairAttempted}`,
              `    repairSucceeded: ${r.repairSucceeded}`,
              `    repairFailedOpen: ${r.repairFailedOpen}`,
              `    repairCostUsd: ${r.repairCostUsd != null ? `$${r.repairCostUsd.toFixed(4)}` : "—"}`,
              `    liveCriticRepairRequired: ${r.liveCriticRepairRequired}`,
              `    agreementWithDeterministic: ${r.agreementWithDeterministic}`,
            ]
          : [`  ${r.runLabel}: blocked — ${r.generatedParserRepairBlockedReasons.join("; ")}`],
      ),
      report.generatedParser.runs.length > 0
        ? `  ${report.generatedParser.mode === "live" ? GENERATED_PARSER_LIVE_REPAIR_BOUNDARY : GENERATED_PARSER_DRY_RUN_BOUNDARY}`
        : "",
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
