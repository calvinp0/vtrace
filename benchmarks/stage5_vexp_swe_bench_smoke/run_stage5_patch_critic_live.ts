// Stage 5 LIVE patch critic runner (milestone 4b). DISABLED BY DEFAULT.
//
// SCOPE: critic OBSERVATION ONLY. Over the existing passive-treatment runs, this runner reads
// each first patch + deterministic probe summary (the same artifacts the Stage 5 agent path
// already produced), builds a bounded `PatchCriticInput`, and — ONLY when `--enable-patch-critic`
// is passed — invokes a live critic once per run, writes critic artifacts into the run's raw
// condition dir, and emits a comparison report. It NEVER modifies a patch, attempts repair,
// edits files, or runs Docker. Without the flag it makes no model call and writes nothing live,
// leaving existing run behavior/artifacts unchanged.
//
// The live model is reached only through `makeClaudeCriticCaller`; tests inject a mock caller.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { type PatchProbeSummary, type PythonParser, summarizePatch } from "./stage5_patch_probes";
import {
  type PatchCriticInput,
  type PatchCriticReport,
  buildDeterministicPatchCriticReport,
} from "./stage5_patch_critic";
import {
  type CriticCaller,
  type LiveCriticMeta,
  type RunLiveCriticOutcome,
  buildCriticArtifacts,
  makeClaudeCriticCaller,
  runLiveCritic,
} from "./stage5_patch_critic_live";
import { RESULTS_REL, RUN_LABELS, loadRun, makePythonParser } from "./run_stage5_patch_probe_report";
import { buildCriticInput, loadRunMetaSignals } from "./run_stage5_patch_critic_dry_run";
import {
  type AdHocSkipReason,
  type CandidateSource,
  probeAdHocRun,
} from "./stage5_ad_hoc_candidates";

export const DEFAULT_OUT_NAME = "stage5_patch_critic_live_existing_runs";

// Conservative cost/scope defaults. The live critic is a quality-recovery mechanism, NOT a
// token-reduction one: it must never become always-on overhead, so by default it (a) runs on at
// most ONE run, (b) only on runs the cheap deterministic critic already flagged repair_required,
// and (c) stops once accumulated spend reaches a small cap.
export const DEFAULT_MAX_CRITIC_RUNS = 1;
export const DEFAULT_CRITIC_COST_CAP_USD = 0.25;
export const DEFAULT_ONLY_DETERMINISTIC_REPAIR_REQUIRED = true;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly outName: string;
  readonly enablePatchCritic: boolean; // DEFAULT false
  readonly criticModel: string | null;
  // --- safety gates ---------------------------------------------------------
  // When non-empty, the live critic is restricted to exactly these run labels; every other run is
  // skipped (skippedByRunLabel) before any model call.
  readonly runLabels: readonly string[];
  // Hard cap on how many runs the live critic may be invoked on this invocation (default 1). Once
  // reached, remaining eligible runs are skipped (skippedByMaxRuns) — they are NOT called.
  readonly maxCriticRuns: number;
  // When true (default), only call the live critic on runs whose DETERMINISTIC critic already
  // returned repair_required=true. Low-risk runs are skipped (skippedLowRiskRuns). `--include-low-risk`
  // flips this off and processes low-risk runs too (still bounded by the other gates).
  readonly onlyDeterministicRepairRequired: boolean;
  // Maximum live-critic spend (USD) for this invocation. Enforced on ACCUMULATED post-call cost
  // (no reliable pre-call estimate exists): once accumulated spend reaches the cap, no further
  // calls are made (stoppedByCostCap).
  readonly criticCostCapUsd: number;
  // Do everything except the live model call: discover candidates, build inputs, run the
  // deterministic critic, and report which runs WOULD be called and why. No model call, no live
  // critic artifacts.
  readonly dryRun: boolean;
  // Opt-in: for every --run-label not already in the curated candidate universe, attempt to
  // materialize an ad hoc candidate from results/runs/<runLabel>/raw/vtrace. Off by default, so
  // unknown-run-label behavior is unchanged unless explicitly requested.
  readonly includeAdHocRunLabels: boolean;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let outName = DEFAULT_OUT_NAME;
  let enablePatchCritic = false; // disabled by default
  let criticModel: string | null = null;
  const runLabels: string[] = [];
  let maxCriticRuns = DEFAULT_MAX_CRITIC_RUNS;
  let onlyDeterministicRepairRequired = DEFAULT_ONLY_DETERMINISTIC_REPAIR_REQUIRED;
  let criticCostCapUsd = DEFAULT_CRITIC_COST_CAP_USD;
  let dryRun = false;
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
      case "--enable-patch-critic":
        enablePatchCritic = true;
        break;
      case "--critic-model":
        criticModel = next();
        break;
      case "--run-label": {
        const label = next();
        if (!runLabels.includes(label)) runLabels.push(label);
        break;
      }
      case "--max-critic-runs": {
        const raw = next();
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) throw new Error(`--max-critic-runs must be a non-negative integer (got ${raw}).`);
        maxCriticRuns = n;
        break;
      }
      case "--only-deterministic-repair-required":
        onlyDeterministicRepairRequired = true;
        break;
      case "--include-low-risk":
        onlyDeterministicRepairRequired = false;
        break;
      case "--critic-cost-cap-usd": {
        const raw = next();
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) throw new Error(`--critic-cost-cap-usd must be a non-negative number (got ${raw}).`);
        criticCostCapUsd = n;
        break;
      }
      case "--dry-run":
        dryRun = true;
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
    enablePatchCritic,
    criticModel,
    runLabels,
    maxCriticRuns,
    onlyDeterministicRepairRequired,
    criticCostCapUsd,
    dryRun,
    includeAdHocRunLabels,
  };
}

// ---------------------------------------------------------------------------
// Candidate construction (cheap / deterministic — no model)
// ---------------------------------------------------------------------------

// A run that COULD be sent to the live critic, with its bounded input and the deterministic
// verdict already computed. Building a candidate calls no model and is always safe; the
// deterministic verdict is the risk signal the gates consult to decide whether the (expensive)
// live critic is invoked at all.
export interface CriticCandidate {
  readonly runLabel: string;
  readonly instanceId: string;
  // Whether this candidate came from the curated run universe or was materialized on demand from a
  // requested ad hoc run label.
  readonly source: CandidateSource;
  readonly input: PatchCriticInput;
  readonly deterministicReport: PatchCriticReport;
}

// Build a candidate from an already-loaded run. Pure given its arguments; touches no disk and
// calls no model. `source` defaults to curated_existing so existing callers are unchanged.
export function buildCandidate(args: {
  readonly probeSummary: PatchProbeSummary;
  readonly patch: string;
  readonly signals: Awaited<ReturnType<typeof loadRunMetaSignals>>;
  readonly source?: CandidateSource;
}): CriticCandidate {
  const input = buildCriticInput(args.probeSummary, args.patch, args.signals);
  const deterministicReport = buildDeterministicPatchCriticReport(input);
  return {
    runLabel: args.probeSummary.runLabel,
    instanceId: args.probeSummary.instanceId,
    source: args.source ?? "curated_existing",
    input,
    deterministicReport,
  };
}

export interface CriticLiveRunResult {
  readonly runLabel: string;
  readonly instanceId: string;
  readonly meta: LiveCriticMeta;
  readonly report: PatchCriticReport | null;
  readonly deterministicReport: PatchCriticReport;
  readonly artifacts: Record<string, string>;
  readonly input: PatchCriticInput;
}

// Invoke the live critic for a single candidate (enabled), then assemble its artifacts. Only
// called once the gates have approved this run; never modifies the patch.
export async function runCandidateLive(
  candidate: CriticCandidate,
  caller: CriticCaller,
  criticModel: string | null,
): Promise<CriticLiveRunResult> {
  const outcome: RunLiveCriticOutcome = await runLiveCritic({
    enabled: true,
    input: candidate.input,
    deterministicReport: candidate.deterministicReport,
    caller,
    criticModel,
  });
  const artifacts = outcome.meta.ran ? buildCriticArtifacts({ input: candidate.input, outcome }) : {};
  return {
    runLabel: candidate.runLabel,
    instanceId: candidate.instanceId,
    meta: outcome.meta,
    report: outcome.report,
    deterministicReport: candidate.deterministicReport,
    artifacts,
    input: candidate.input,
  };
}

// ---------------------------------------------------------------------------
// Safety gates (decide which candidates the live critic may be invoked on)
// ---------------------------------------------------------------------------

export interface GateConfig {
  readonly runLabels: readonly string[]; // empty = no restriction
  readonly maxCriticRuns: number;
  readonly onlyDeterministicRepairRequired: boolean;
  readonly criticCostCapUsd: number;
  readonly dryRun: boolean;
}

export type SkipReason =
  | "not-in-run-label"
  | "low-risk-deterministic"
  | "ad-hoc-probe-not-repair-required"
  | "ad-hoc-missing-run-dir"
  | "ad-hoc-missing-jsonl"
  | "ad-hoc-no-model-patch"
  | "max-critic-runs"
  | "cost-cap";

// Per-run gate outcome. Exactly one of {called, wouldCall} is true for an approved run; a skipped
// run carries the reason it was excluded. `result` is present only for actually-called runs.
export interface CriticRunDecision {
  readonly runLabel: string;
  readonly instanceId: string;
  readonly source: CandidateSource;
  readonly deterministicRepairRequired: boolean;
  readonly eligible: boolean; // passed the static (run-label + risk) filters
  readonly called: boolean; // live critic actually invoked
  readonly wouldCall: boolean; // dry-run: would have been invoked
  readonly skipReason: SkipReason | null;
  readonly reason: string; // human-readable include/exclude explanation
  readonly result: CriticLiveRunResult | null;
}

// Counters mirrored into the comparison report (the gate audit trail).
export interface GateCounters {
  readonly candidateRuns: number;
  readonly eligibleRuns: number;
  readonly skippedLowRiskRuns: number;
  readonly skippedByRunLabel: number;
  readonly skippedByMaxRuns: number;
  readonly stoppedByCostCap: number;
  readonly liveCallsAttempted: number;
  readonly liveCallsSucceeded: number;
  readonly liveCallsFailedOpen: number;
  readonly totalCriticCostUsd: number;
}

export interface GatedCriticOutcome {
  readonly decisions: readonly CriticRunDecision[];
  readonly counters: GateCounters;
}

// Audit trail for opt-in ad hoc run-label materialization. `adHocRequested` counts requested
// --run-label values outside the curated universe; `adHocFound` counts those whose run dir + JSONL
// row were present (materialized OR empty-patch); `adHocMaterialized` counts those that produced a
// candidate; `adHocMissing` counts those whose run dir or JSONL row was absent.
export interface AdHocCounters {
  readonly adHocRequested: number;
  readonly adHocFound: number;
  readonly adHocMaterialized: number;
  readonly adHocMissing: number;
}

export const EMPTY_AD_HOC_COUNTERS: AdHocCounters = {
  adHocRequested: 0,
  adHocFound: 0,
  adHocMaterialized: 0,
  adHocMissing: 0,
};

// Walk the candidates IN ORDER, applying the safety gates, and invoke the live critic only on
// approved runs. The gates are consulted strictly via the cheap deterministic verdict + running
// counters (call count, accumulated cost) — never the model. Fail-open per run is preserved by
// `runLiveCritic`; the gate never throws on a critic failure. In `dryRun` mode no model is called
// and approved runs are recorded as `wouldCall` instead of `called`.
export async function runGatedCritic(args: {
  readonly candidates: readonly CriticCandidate[];
  readonly gate: GateConfig;
  readonly caller: CriticCaller;
  readonly criticModel: string | null;
}): Promise<GatedCriticOutcome> {
  const { candidates, gate, caller, criticModel } = args;
  const decisions: CriticRunDecision[] = [];

  let eligibleRuns = 0;
  let skippedLowRiskRuns = 0;
  let skippedByRunLabel = 0;
  let skippedByMaxRuns = 0;
  let stoppedByCostCap = 0;
  let liveCallsAttempted = 0;
  let liveCallsSucceeded = 0;
  let liveCallsFailedOpen = 0;
  let totalCriticCostUsd = 0;

  // Runs we have committed to (real calls + dry-run would-calls) — counted against maxCriticRuns.
  let committed = 0;

  for (const candidate of candidates) {
    const detRepair = candidate.deterministicReport.repair_required;
    const base = {
      runLabel: candidate.runLabel,
      instanceId: candidate.instanceId,
      source: candidate.source,
      deterministicRepairRequired: detRepair,
    };

    // --- static filters (run-label, then deterministic risk) ----------------
    if (gate.runLabels.length > 0 && !gate.runLabels.includes(candidate.runLabel)) {
      skippedByRunLabel += 1;
      decisions.push({
        ...base,
        eligible: false,
        called: false,
        wouldCall: false,
        skipReason: "not-in-run-label",
        reason: `not in --run-label set {${gate.runLabels.join(", ")}}`,
        result: null,
      });
      continue;
    }
    if (gate.onlyDeterministicRepairRequired && !detRepair) {
      skippedLowRiskRuns += 1;
      const adHoc = candidate.source === "ad_hoc_run_label";
      decisions.push({
        ...base,
        eligible: false,
        called: false,
        wouldCall: false,
        skipReason: adHoc ? "ad-hoc-probe-not-repair-required" : "low-risk-deterministic",
        reason: adHoc
          ? "ad hoc run materialized but its deterministic probe did not flag repair_required (low risk); --include-low-risk to process"
          : "deterministic critic did not flag repair_required (low risk); --include-low-risk to process",
        result: null,
      });
      continue;
    }

    // --- eligible: now bounded by call count + cost cap ---------------------
    eligibleRuns += 1;

    if (committed >= gate.maxCriticRuns) {
      skippedByMaxRuns += 1;
      decisions.push({
        ...base,
        eligible: true,
        called: false,
        wouldCall: false,
        skipReason: "max-critic-runs",
        reason: `--max-critic-runs=${gate.maxCriticRuns} reached`,
        result: null,
      });
      continue;
    }
    // Accumulated-cost enforcement (no reliable pre-call estimate): stop before additional calls
    // once spend has reached the cap. In dry-run there are no real calls, so this never trips.
    if (!gate.dryRun && totalCriticCostUsd >= gate.criticCostCapUsd) {
      stoppedByCostCap += 1;
      decisions.push({
        ...base,
        eligible: true,
        called: false,
        wouldCall: false,
        skipReason: "cost-cap",
        reason: `accumulated $${totalCriticCostUsd.toFixed(4)} >= --critic-cost-cap-usd $${gate.criticCostCapUsd.toFixed(4)}`,
        result: null,
      });
      continue;
    }

    committed += 1;

    if (gate.dryRun) {
      decisions.push({
        ...base,
        eligible: true,
        called: false,
        wouldCall: true,
        skipReason: null,
        reason: "would call live critic (dry-run: model NOT invoked)",
        result: null,
      });
      continue;
    }

    const result = await runCandidateLive(candidate, caller, criticModel);
    liveCallsAttempted += 1;
    totalCriticCostUsd += result.meta.criticCostUsd;
    if (result.meta.validReport) liveCallsSucceeded += 1;
    if (result.meta.failedOpen) liveCallsFailedOpen += 1;
    decisions.push({
      ...base,
      eligible: true,
      called: true,
      wouldCall: false,
      skipReason: null,
      reason: "live critic invoked",
      result,
    });
  }

  return {
    decisions,
    counters: {
      candidateRuns: candidates.length,
      eligibleRuns,
      skippedLowRiskRuns,
      skippedByRunLabel,
      skippedByMaxRuns,
      stoppedByCostCap,
      liveCallsAttempted,
      liveCallsSucceeded,
      liveCallsFailedOpen,
      totalCriticCostUsd,
    },
  };
}

// ---------------------------------------------------------------------------
// Summary report (pure)
// ---------------------------------------------------------------------------

export interface CriticLiveSummary {
  readonly enabled: boolean;
  readonly runsAnalyzed: number;
  readonly criticRan: number;
  readonly validReports: number;
  readonly failedOpen: number;
  readonly liveRepairRequired: number;
  readonly deterministicRepairRequired: number;
  readonly agreementCount: number;
  readonly disagreementCount: number;
  readonly totalCriticCostUsd: number;
  readonly totalCriticInputTokens: number;
  readonly totalCriticOutputTokens: number;
}

// The analytic summary is computed over the runs the live critic ACTUALLY ran on (a subset of
// candidates the gates approved), not over every candidate. `deterministicRepairRequired` here is
// the deterministic flag count over those same ran runs; the gate counters carry the deterministic
// picture across all candidates.
export function buildLiveSummary(enabled: boolean, results: readonly CriticLiveRunResult[]): CriticLiveSummary {
  const ran = results.filter((r) => r.meta.ran);
  const valid = ran.filter((r) => r.meta.validReport);
  return {
    enabled,
    runsAnalyzed: results.length,
    criticRan: ran.length,
    validReports: valid.length,
    failedOpen: ran.filter((r) => r.meta.failedOpen).length,
    liveRepairRequired: valid.filter((r) => r.meta.liveRepairRequired === true).length,
    deterministicRepairRequired: results.filter((r) => r.deterministicReport.repair_required).length,
    agreementCount: valid.filter((r) => r.meta.agreementWithDeterministic === true).length,
    disagreementCount: valid.filter((r) => r.meta.agreementWithDeterministic === false).length,
    totalCriticCostUsd: ran.reduce((a, r) => a + r.meta.criticCostUsd, 0),
    totalCriticInputTokens: ran.reduce((a, r) => a + r.meta.criticInputTokens, 0),
    totalCriticOutputTokens: ran.reduce((a, r) => a + r.meta.criticOutputTokens, 0),
  };
}

// The gate configuration as recorded in the report (so a report is self-describing about the
// guardrails that produced it).
export interface GateConfigReport {
  readonly runLabels: readonly string[];
  readonly maxCriticRuns: number;
  readonly onlyDeterministicRepairRequired: boolean;
  readonly criticCostCapUsd: number;
  readonly dryRun: boolean;
}

export interface CriticLiveRunReportRow {
  readonly runLabel: string;
  readonly instanceId: string;
  readonly source: CandidateSource;
  readonly deterministicRepairRequired: boolean;
  readonly eligible: boolean;
  readonly called: boolean;
  readonly wouldCall: boolean;
  readonly skipReason: SkipReason | null;
  readonly reason: string;
  readonly meta: LiveCriticMeta | null;
  readonly liveReport: PatchCriticReport | null;
}

export interface CriticLiveReport {
  readonly generatedAt: string | null;
  readonly enabled: boolean;
  readonly dryRun: boolean;
  readonly gates: GateConfigReport;
  readonly counters: GateCounters;
  readonly adHoc: AdHocCounters;
  readonly summary: CriticLiveSummary;
  readonly runs: readonly CriticLiveRunReportRow[];
  readonly nonClaims: readonly string[];
}

export const NON_CLAIMS: readonly string[] = [
  "Critic OBSERVATION ONLY: the live critic never modifies the patch, edited files, workspace, final patch, or evaluation input.",
  "Disabled by default; with no --enable-patch-critic flag no model is called and no critic artifacts are written.",
  "Cost/scope GATED: by default the live critic runs on at most --max-critic-runs run(s), only on deterministic repair_required runs, and stops at --critic-cost-cap-usd.",
  "`repair_required = true` here is an OBSERVATION (what a critic would request); no repair is performed this milestone.",
  "Fail-open: a critic invocation error or invalid JSON is recorded and the original patch is preserved; the run is not failed.",
  "Agreement = (deterministicRepairRequired === liveRepairRequired); per-field agreement is not required for this milestone.",
  "This changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY behavior and runs no Docker.",
];

export function buildLiveReport(args: {
  readonly generatedAt: string | null;
  readonly enabled: boolean;
  readonly gate: GateConfig;
  readonly outcome: GatedCriticOutcome;
  // Synthetic decision rows for ad hoc run labels that could NOT be materialized into candidates
  // (missing run dir / JSONL / model patch). Appended to the per-run table so they are surfaced.
  readonly adHocSkips?: readonly CriticRunDecision[];
  readonly adHoc?: AdHocCounters;
}): CriticLiveReport {
  const { generatedAt, enabled, gate, outcome } = args;
  const adHocSkips = args.adHocSkips ?? [];
  const adHoc = args.adHoc ?? EMPTY_AD_HOC_COUNTERS;
  const calledResults = outcome.decisions
    .map((d) => d.result)
    .filter((r): r is CriticLiveRunResult => r !== null);
  const toRow = (d: CriticRunDecision): CriticLiveRunReportRow => ({
    runLabel: d.runLabel,
    instanceId: d.instanceId,
    source: d.source,
    deterministicRepairRequired: d.deterministicRepairRequired,
    eligible: d.eligible,
    called: d.called,
    wouldCall: d.wouldCall,
    skipReason: d.skipReason,
    reason: d.reason,
    meta: d.result ? d.result.meta : null,
    liveReport: d.result ? d.result.report : null,
  });
  return {
    generatedAt,
    enabled,
    dryRun: gate.dryRun,
    gates: {
      runLabels: gate.runLabels,
      maxCriticRuns: gate.maxCriticRuns,
      onlyDeterministicRepairRequired: gate.onlyDeterministicRepairRequired,
      criticCostCapUsd: gate.criticCostCapUsd,
      dryRun: gate.dryRun,
    },
    counters: outcome.counters,
    adHoc,
    summary: buildLiveSummary(enabled, calledResults),
    runs: [...outcome.decisions, ...adHocSkips].map(toRow),
    nonClaims: NON_CLAIMS,
  };
}

export function renderJson(report: CriticLiveReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function decisionLabel(r: CriticLiveRunReportRow): string {
  if (r.called) return "called";
  if (r.wouldCall) return "would-call (dry-run)";
  return `skipped: ${r.skipReason ?? "—"}`;
}

export function renderMarkdown(report: CriticLiveReport): string {
  const { summary, counters, gates } = report;
  const lines: string[] = [];
  lines.push("# Stage 5 live patch critic over existing runs");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");
  lines.push(
    "_Critic observation only. No repair, no patch modification, no Docker. Live critic disabled unless " +
      "`--enable-patch-critic` is passed; the model is reached only through the injectable caller, and only on " +
      "gated (cost/scope-bounded) runs._",
  );
  lines.push("");
  lines.push("## Gates");
  lines.push("");
  lines.push(
    `enabled=${report.enabled}; dryRun=${gates.dryRun}; runLabels=${gates.runLabels.length > 0 ? `{${gates.runLabels.join(", ")}}` : "(none — all)"}; ` +
      `maxCriticRuns=${gates.maxCriticRuns}; onlyDeterministicRepairRequired=${gates.onlyDeterministicRepairRequired}; ` +
      `criticCostCapUsd=$${gates.criticCostCapUsd.toFixed(4)}.`,
  );
  lines.push("");
  lines.push("| gate metric | value |");
  lines.push("| --- | --- |");
  for (const [k, v] of Object.entries(counters)) {
    lines.push(`| ${k} | ${k === "totalCriticCostUsd" ? `$${(v as number).toFixed(4)}` : v} |`);
  }
  for (const [k, v] of Object.entries(report.adHoc)) lines.push(`| ${k} | ${v} |`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `enabled=${summary.enabled}; ${counters.candidateRuns} candidate run(s), ${counters.eligibleRuns} eligible; ` +
      `critic ran on ${summary.criticRan}, ${summary.validReports} valid report(s), ${summary.failedOpen} failed-open. ` +
      `Live repair_required: ${summary.liveRepairRequired}; deterministic repair_required (over ran): ` +
      `${summary.deterministicRepairRequired}; agreement ${summary.agreementCount}/${summary.validReports}. ` +
      `Critic cost $${summary.totalCriticCostUsd.toFixed(4)} (${summary.totalCriticInputTokens} in / ` +
      `${summary.totalCriticOutputTokens} out tokens).`,
  );
  lines.push("");
  lines.push("| metric | value |");
  lines.push("| --- | --- |");
  for (const [k, v] of Object.entries(summary)) lines.push(`| ${k} | ${v} |`);
  lines.push("");
  lines.push("## Decisions by run");
  lines.push("");
  lines.push("| run | source | det repair | decision | ran | valid | live repair | agreement | cost | reason |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of report.runs) {
    const m = r.meta;
    lines.push(
      `| ${r.runLabel} | ${r.source} | ${r.deterministicRepairRequired} | ${decisionLabel(r)} | ${m ? m.ran : "—"} | ` +
        `${m ? m.validReport : "—"} | ${m?.liveRepairRequired ?? "—"} | ${m?.agreementWithDeterministic ?? "—"} | ` +
        `${m ? `$${m.criticCostUsd.toFixed(4)}` : "—"} | ${r.reason} |`,
    );
  }
  lines.push("");
  lines.push("## Non-claims");
  lines.push("");
  for (const c of report.nonClaims) lines.push(`- ${c}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Ad hoc candidate discovery (cheap / read-only — no model)
// ---------------------------------------------------------------------------

export interface AdHocDiscovery {
  readonly candidates: readonly CriticCandidate[];
  readonly skips: readonly CriticRunDecision[];
  readonly counters: AdHocCounters;
}

// A synthetic skip row for an ad hoc run label that could not be materialized into a candidate.
function adHocSkipDecision(
  runLabel: string,
  instanceId: string | null,
  skipReason: AdHocSkipReason,
  detail: string,
): CriticRunDecision {
  return {
    runLabel,
    instanceId: instanceId ?? runLabel,
    source: "ad_hoc_run_label",
    deterministicRepairRequired: false,
    eligible: false,
    called: false,
    wouldCall: false,
    skipReason,
    reason: detail,
    result: null,
  };
}

// Materialize ad hoc candidates for requested run labels OUTSIDE the curated `knownLabels` set. For
// each: probe the raw run; on success build a candidate (source=ad_hoc_run_label) using the exact
// same deterministic probe + critic logic as curated candidates; on failure record a synthetic skip
// decision with the precise reason. Read-only; calls no model.
export async function discoverAdHocCandidates(args: {
  readonly resultsDir: string;
  readonly requestedLabels: readonly string[];
  readonly knownLabels: ReadonlySet<string>;
  readonly parsePython: PythonParser;
}): Promise<AdHocDiscovery> {
  const { resultsDir, requestedLabels, knownLabels, parsePython } = args;
  const candidates: CriticCandidate[] = [];
  const skips: CriticRunDecision[] = [];
  let adHocRequested = 0;
  let adHocFound = 0;
  let adHocMaterialized = 0;
  let adHocMissing = 0;

  for (const label of requestedLabels) {
    if (knownLabels.has(label)) continue; // already a curated candidate
    adHocRequested += 1;
    const probe = await probeAdHocRun(resultsDir, label);

    if (probe.status === "materialized") {
      adHocFound += 1;
      const loaded = await loadRun(resultsDir, label);
      if (loaded === null || loaded.patch.trim() === "") {
        // Defensive: the probe already confirmed a non-empty patch; stay fail-soft if it vanished.
        adHocMissing += 1;
        skips.push(adHocSkipDecision(label, probe.instanceId, "ad-hoc-missing-jsonl", probe.detail));
        continue;
      }
      const probeSummary = summarizePatch({
        instanceId: loaded.instanceId,
        runLabel: loaded.runLabel,
        patch: loaded.patch,
        toolCalls: loaded.toolCalls,
        stdout: loaded.stdout,
        stderr: loaded.stderr,
        parsePython,
        reconstructedSources: loaded.reconstructedSources,
        reconstruction: loaded.reconstruction,
      });
      const signals = await loadRunMetaSignals(resultsDir, label);
      candidates.push(buildCandidate({ probeSummary, patch: loaded.patch, signals, source: "ad_hoc_run_label" }));
      adHocMaterialized += 1;
      continue;
    }

    // no-model-patch still means the run dir + JSONL row were found; missing-* means they were not.
    if (probe.status === "no-model-patch") adHocFound += 1;
    else adHocMissing += 1;
    skips.push(adHocSkipDecision(label, probe.instanceId, probe.skipReason!, probe.detail));
  }

  return {
    candidates,
    skips,
    counters: { adHocRequested, adHocFound, adHocMaterialized, adHocMissing },
  };
}

// ---------------------------------------------------------------------------
// Main (impure)
// ---------------------------------------------------------------------------

async function main(config: CliConfig): Promise<void> {
  const parsePython: PythonParser = makePythonParser();
  const caller = makeClaudeCriticCaller();

  if (!config.enablePatchCritic) {
    process.stdout.write(
      [
        "Stage 5 live patch critic is DISABLED (pass --enable-patch-critic to invoke it).",
        "No model was called, no critic artifacts were written, and no run behavior changed.",
        "",
      ].join("\n"),
    );
    return;
  }

  const generatedAt = new Date().toISOString();

  // --- Phase 1: discover candidates (cheap / deterministic — no model) -------
  const candidates: CriticCandidate[] = [];
  const missing: string[] = [];
  for (const label of RUN_LABELS) {
    const loaded = await loadRun(config.resultsDir, label);
    if (loaded === null) {
      missing.push(label);
      continue;
    }
    const probeSummary = summarizePatch({
      instanceId: loaded.instanceId,
      runLabel: loaded.runLabel,
      patch: loaded.patch,
      toolCalls: loaded.toolCalls,
      stdout: loaded.stdout,
      stderr: loaded.stderr,
      parsePython,
      reconstructedSources: loaded.reconstructedSources,
      reconstruction: loaded.reconstruction,
    });
    const signals = await loadRunMetaSignals(config.resultsDir, label);
    candidates.push(buildCandidate({ probeSummary, patch: loaded.patch, signals }));
  }

  // Opt-in: materialize ad hoc candidates for requested run labels outside the curated universe.
  const curatedKnown = new Set(candidates.map((c) => c.runLabel));
  const adHoc = config.includeAdHocRunLabels
    ? await discoverAdHocCandidates({
        resultsDir: config.resultsDir,
        requestedLabels: config.runLabels,
        knownLabels: curatedKnown,
        parsePython,
      })
    : { candidates: [], skips: [], counters: EMPTY_AD_HOC_COUNTERS };
  candidates.push(...adHoc.candidates);

  // A misspelled --run-label that matches no candidate would silently make zero calls; surface it.
  // Labels handled by ad hoc discovery (materialized OR reported as a skip) are NOT "unknown".
  const handled = new Set<string>([
    ...candidates.map((c) => c.runLabel),
    ...adHoc.skips.map((s) => s.runLabel),
  ]);
  const unknownLabels = config.runLabels.filter((l) => !handled.has(l));
  if (unknownLabels.length > 0) {
    const hint = config.includeAdHocRunLabels ? "" : " (pass --include-ad-hoc-run-labels to materialize new runs)";
    process.stderr.write(`WARNING: --run-label not found among candidates: ${unknownLabels.join(", ")}${hint}\n`);
  }

  // --- Phase 2: apply safety gates, invoke the live critic only when approved -
  const gate: GateConfig = {
    runLabels: config.runLabels,
    maxCriticRuns: config.maxCriticRuns,
    onlyDeterministicRepairRequired: config.onlyDeterministicRepairRequired,
    criticCostCapUsd: config.criticCostCapUsd,
    dryRun: config.dryRun,
  };
  const outcome = await runGatedCritic({ candidates, gate, caller, criticModel: config.criticModel });

  // --- Phase 3: write live critic artifacts (real calls only; never in dry-run)
  if (!config.dryRun) {
    for (const decision of outcome.decisions) {
      if (!decision.called || decision.result === null) continue;
      // Write critic artifacts into the run's raw condition dir (untracked; never overwrites the
      // patch or existing run artifacts — only adds _patch_critic*.* / _first_patch.diff).
      const vtraceDir = path.join(config.resultsDir, "runs", decision.runLabel, "raw", "vtrace");
      await mkdir(vtraceDir, { recursive: true });
      for (const [name, content] of Object.entries(decision.result.artifacts)) {
        await writeFile(path.join(vtraceDir, name), content);
      }
    }
  }

  // The comparison report (this is the runner's report, NOT a per-run live critic artifact) is
  // written in both real and dry-run modes; it is self-describing about the gates and decisions.
  const report = buildLiveReport({
    generatedAt,
    enabled: true,
    gate,
    outcome,
    adHocSkips: adHoc.skips,
    adHoc: adHoc.counters,
  });
  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  const c = outcome.counters;
  const s = report.summary;
  const moreEligible = c.skippedByMaxRuns > 0 || c.stoppedByCostCap > 0;
  process.stdout.write(
    [
      `Stage 5 live patch critic report written${config.dryRun ? " (DRY RUN — no model called)" : ""}:`,
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Candidates: ${c.candidateRuns}${missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""}   Eligible: ${c.eligibleRuns}`,
      config.includeAdHocRunLabels
        ? `Ad hoc — requested: ${adHoc.counters.adHocRequested}   found: ${adHoc.counters.adHocFound}   materialized: ${adHoc.counters.adHocMaterialized}   missing: ${adHoc.counters.adHocMissing}`
        : "",
      `Skipped — runLabel: ${c.skippedByRunLabel}   lowRisk: ${c.skippedLowRiskRuns}   maxRuns: ${c.skippedByMaxRuns}   costCap: ${c.stoppedByCostCap}`,
      `Live calls — attempted: ${c.liveCallsAttempted}   succeeded: ${c.liveCallsSucceeded}   failed-open: ${c.liveCallsFailedOpen}   cost: $${c.totalCriticCostUsd.toFixed(4)}`,
      config.dryRun
        ? `Would call: ${report.runs.filter((r) => r.wouldCall).length} run(s).`
        : `Agreement: ${s.agreementCount}/${s.validReports}.`,
      moreEligible
        ? `NOTE: more eligible run(s) were not processed (maxRuns/costCap). Raise --max-critic-runs / --critic-cost-cap-usd or pass --run-label to target a specific run.`
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
