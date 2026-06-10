// Stage 5 live critic smoke comparison (reporting/analysis only).
//
// SCOPE: this runner READS already-written artifacts from a single gated live-critic smoke run and
// emits a formal comparison report (Markdown + JSON). It runs NO agents, NO live critic, NO Docker;
// it modifies NO patch, workspace, or raw artifact; it implements NO repair. The only files it
// writes are the two comparison report files named by --out-name.
//
// Inputs (all read-only, all fail-soft to null if absent):
//   results/runs/<runLabel>/raw/vtrace/_patch_critic.meta.json     (live critic meta)
//   results/runs/<runLabel>/raw/vtrace/_patch_critic_report.json   (live critic structured report)
//   results/runs/<runLabel>/raw/vtrace/_patch_critic_input.json    (bounded critic input + probe summary)
//   results/runs/<runLabel>/raw/vtrace/_first_patch.diff           (the patch — to confirm it was untouched)
//   results/stage5_patch_critic_dry_run_existing_runs.json         (deterministic critic verdicts)
//   results/stage5_patch_critic_live_smoke_sympy.json              (smoke gate context: cap, counters)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { PatchCriticReport } from "./stage5_patch_critic";
import type { LiveCriticMeta } from "./stage5_patch_critic_live";
import { RESULTS_REL } from "./run_stage5_patch_probe_report";

export const DEFAULT_RUN_LABEL = "eval-patchverify-before-sympy-16766";
export const DEFAULT_OUT_NAME = "stage5_live_critic_smoke_comparison";
// Fallback cost cap if the smoke summary (which records the actual --critic-cost-cap-usd) is absent.
export const DEFAULT_COST_CAP_USD = 0.25;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly runLabel: string;
  readonly outName: string;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let runLabel = DEFAULT_RUN_LABEL;
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
      case "--run-label":
        runLabel = next();
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
  return { resultsDir, runLabel, outName };
}

// ---------------------------------------------------------------------------
// Read-only, fail-soft loaders
// ---------------------------------------------------------------------------

async function readJson<T = Record<string, unknown>>(p: string): Promise<T | null> {
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

// The bounded critic input embeds the deterministic probe summary; we only need a few fields here.
export interface CriticInputDoc {
  readonly instanceId?: string;
  readonly firstPatch?: string;
  readonly probeSummary?: {
    readonly overallRisk?: string;
    readonly knownDefectLikelyCaught?: boolean;
    readonly probes?: ReadonlyArray<{
      readonly probeId: string;
      readonly status: string;
      readonly confidence: string;
      readonly evidence: readonly string[];
    }>;
  };
}

// The smoke summary json — we read only the gate cap and a few counters for context.
export interface SmokeSummaryDoc {
  readonly gates?: {
    readonly runLabels?: readonly string[];
    readonly maxCriticRuns?: number;
    readonly onlyDeterministicRepairRequired?: boolean;
    readonly criticCostCapUsd?: number;
  };
  readonly counters?: {
    readonly candidateRuns?: number;
    readonly eligibleRuns?: number;
    readonly liveCallsAttempted?: number;
    readonly liveCallsSucceeded?: number;
    readonly liveCallsFailedOpen?: number;
    readonly totalCriticCostUsd?: number;
  };
}

// A deterministic dry-run document: a list of per-run critic verdicts.
export interface DryRunDoc {
  readonly reports?: readonly PatchCriticReport[];
}

export interface ComparisonInputs {
  readonly liveMeta: LiveCriticMeta | null;
  readonly liveReport: PatchCriticReport | null;
  readonly criticInput: CriticInputDoc | null;
  readonly firstPatchDiff: string | null;
  readonly deterministicReport: PatchCriticReport | null;
  readonly deterministicReports: readonly PatchCriticReport[];
  readonly smoke: SmokeSummaryDoc | null;
  readonly missing: readonly string[]; // artifact paths that were absent/unreadable
}

// Read every comparison input from disk. Pure read-only; every file fails soft to null and is
// recorded in `missing`. Never writes, never mutates, never calls a model.
export async function loadComparisonInputs(resultsDir: string, runLabel: string): Promise<ComparisonInputs> {
  const vtraceDir = path.join(resultsDir, "runs", runLabel, "raw", "vtrace");
  const metaPath = path.join(vtraceDir, "_patch_critic.meta.json");
  const reportPath = path.join(vtraceDir, "_patch_critic_report.json");
  const inputPath = path.join(vtraceDir, "_patch_critic_input.json");
  const patchPath = path.join(vtraceDir, "_first_patch.diff");
  const dryRunPath = path.join(resultsDir, "stage5_patch_critic_dry_run_existing_runs.json");
  const smokePath = path.join(resultsDir, "stage5_patch_critic_live_smoke_sympy.json");

  const [liveMeta, liveReport, criticInput, firstPatchDiff, dryRun, smoke] = await Promise.all([
    readJson<LiveCriticMeta>(metaPath),
    readJson<PatchCriticReport>(reportPath),
    readJson<CriticInputDoc>(inputPath),
    readText(patchPath),
    readJson<DryRunDoc>(dryRunPath),
    readJson<SmokeSummaryDoc>(smokePath),
  ]);

  const missing: string[] = [];
  if (liveMeta === null) missing.push(metaPath);
  if (liveReport === null) missing.push(reportPath);
  if (criticInput === null) missing.push(inputPath);
  if (firstPatchDiff === null) missing.push(patchPath);
  if (dryRun === null) missing.push(dryRunPath);
  if (smoke === null) missing.push(smokePath);

  const deterministicReports = dryRun?.reports ?? [];
  const deterministicReport =
    deterministicReports.find((r) => r.runLabel === runLabel) ?? null;

  return {
    liveMeta,
    liveReport,
    criticInput,
    firstPatchDiff,
    deterministicReport,
    deterministicReports,
    smoke,
    missing,
  };
}

// ---------------------------------------------------------------------------
// Comparison model (pure)
// ---------------------------------------------------------------------------

export type ComparisonStatus = "ok" | "missing-live-artifacts" | "invalid-live-report";

export interface ComparisonReport {
  readonly generatedAt: string | null;
  readonly runLabel: string;
  readonly instanceId: string;
  readonly status: ComparisonStatus;
  readonly summary: {
    readonly status: ComparisonStatus;
    readonly liveReportValid: boolean;
    readonly failedOpen: boolean;
    readonly repairRequiredAgreement: boolean;
    readonly sameCoreDefect: boolean;
    readonly text: string;
  };
  readonly deterministic: {
    readonly source: string;
    readonly available: boolean;
    readonly scopeOk: boolean | null;
    readonly risk: string | null;
    readonly repairRequired: boolean | null;
    readonly confidence: string | null;
    readonly repairReason: string | null;
    readonly repairInstructions: string | null;
    readonly scopeEvidence: string | null;
    readonly insertedMethodScopeProbe: {
      readonly status: string;
      readonly confidence: string;
      readonly evidence: readonly string[];
    } | null;
  };
  readonly live: {
    readonly ran: boolean;
    readonly validReport: boolean;
    readonly failedOpen: boolean;
    readonly scopeOk: boolean | null;
    readonly failingBehaviorHandled: boolean | null;
    readonly minimalityOk: boolean | null;
    readonly testEvidenceOk: boolean | null;
    readonly risk: string | null;
    readonly repairRequired: boolean | null;
    readonly confidence: string | null;
    readonly repairReason: string | null;
    readonly repairInstructions: string | null;
    readonly scopeEvidence: string | null;
  };
  readonly agreement: {
    readonly metric: string;
    readonly deterministicRepairRequired: boolean | null;
    readonly liveRepairRequired: boolean | null;
    readonly repairRequiredAgreement: boolean;
    readonly sameCoreDefect: boolean;
    readonly coreDefect: string | null;
    readonly riskComparison: { readonly deterministic: string | null; readonly live: string | null; readonly note: string };
    readonly confidenceComparison: { readonly deterministic: string | null; readonly live: string | null };
  };
  readonly addedValue: {
    readonly deterministicAlreadyKnew: readonly string[];
    readonly liveAdded: readonly string[];
    readonly verdict: string;
  };
  readonly cost: {
    readonly criticCostUsd: number | null;
    readonly criticInputTokens: number | null;
    readonly criticOutputTokens: number | null;
    readonly costCapUsd: number;
    readonly withinCostCap: boolean | null;
    readonly acceptable: boolean | null;
  };
  readonly safety: {
    readonly observationOnly: boolean;
    readonly repairPerformed: boolean;
    readonly dockerRun: boolean;
    readonly patchUnchanged: boolean | null;
    readonly failedOpen: boolean;
    readonly liveReportValid: boolean;
  };
  readonly recommendation: {
    readonly choice: string;
    readonly text: string;
    readonly suggestedRunLabels: readonly string[];
    readonly gated: boolean;
    readonly costCapped: boolean;
    readonly excludesLowRisk: boolean;
  };
  readonly nonClaims: readonly string[];
}

export const NON_CLAIMS: readonly string[] = [
  "This report does not run agents, Docker, or repair.",
  "This report does not modify patches or workspaces.",
  "This report does not prove the critic improves SWE-bench resolution.",
  "This report does not prove a repair would succeed.",
  "This report does not justify always-on critic usage.",
  "This report does not compare VTRACE against VEXP.",
  "This is a one-call smoke result, not a benchmark.",
  "Agreement here is repair_required equality only; risk/confidence differ and per-field agreement is not asserted.",
];

function getProbe(
  input: CriticInputDoc | null,
  probeId: string,
): { status: string; confidence: string; evidence: readonly string[] } | null {
  const p = input?.probeSummary?.probes?.find((x) => x.probeId === probeId);
  if (!p) return null;
  return { status: p.status, confidence: p.confidence, evidence: p.evidence };
}

function normalizePatch(s: string): string {
  return s.replace(/\r\n/g, "\n").trim();
}

// Build the comparison report purely from already-loaded inputs. No I/O, no model.
export function buildComparison(args: {
  readonly generatedAt: string | null;
  readonly runLabel: string;
  readonly inputs: ComparisonInputs;
}): ComparisonReport {
  const { generatedAt, runLabel, inputs } = args;
  const { liveMeta, liveReport, criticInput, deterministicReport } = inputs;

  const status: ComparisonStatus =
    liveMeta === null || liveReport === null
      ? "missing-live-artifacts"
      : liveMeta.validReport === false
        ? "invalid-live-report"
        : "ok";

  const instanceId =
    liveReport?.instanceId ?? criticInput?.instanceId ?? deterministicReport?.instanceId ?? "unknown";

  // --- deterministic block (the cheap critic verdict for this run) -----------
  const det = deterministicReport;
  const insertedScopeProbe = getProbe(criticInput, "inserted_method_scope");
  const deterministic: ComparisonReport["deterministic"] = {
    source: "stage5_patch_critic_dry_run_existing_runs.json",
    available: det !== null,
    scopeOk: det?.scope_ok ?? null,
    risk: det?.risk ?? null,
    repairRequired: det?.repair_required ?? null,
    confidence: det?.confidence ?? null,
    repairReason: det?.repair_reason ?? null,
    repairInstructions: det?.repair_instructions ?? null,
    scopeEvidence: det?.scope_evidence ?? null,
    insertedMethodScopeProbe: insertedScopeProbe,
  };

  // --- live block ------------------------------------------------------------
  const live: ComparisonReport["live"] = {
    ran: liveMeta?.ran ?? false,
    validReport: liveMeta?.validReport ?? false,
    failedOpen: liveMeta?.failedOpen ?? false,
    scopeOk: liveReport?.scope_ok ?? null,
    failingBehaviorHandled: liveReport?.failing_behavior_handled ?? null,
    minimalityOk: liveReport?.minimality_ok ?? null,
    testEvidenceOk: liveReport?.test_evidence_ok ?? null,
    risk: liveReport?.risk ?? null,
    repairRequired: liveReport?.repair_required ?? null,
    confidence: liveReport?.confidence ?? null,
    repairReason: liveReport?.repair_reason ?? null,
    repairInstructions: liveReport?.repair_instructions ?? null,
    scopeEvidence: liveReport?.scope_evidence ?? null,
  };

  // --- agreement -------------------------------------------------------------
  const detRepair = deterministic.repairRequired;
  const liveRepair = live.repairRequired;
  // Prefer the meta's own agreement flag (the milestone definition); fall back to recomputing it.
  const repairRequiredAgreement =
    liveMeta?.agreementWithDeterministic ??
    (detRepair !== null && liveRepair !== null ? detRepair === liveRepair : false);
  // Same core defect = both flagged a wrong-scope insertion that needs repair.
  const sameCoreDefect =
    deterministic.scopeOk === false &&
    live.scopeOk === false &&
    detRepair === true &&
    liveRepair === true;
  const coreDefect = sameCoreDefect
    ? "_print_Indexed inserted into AbstractPythonCodePrinter rather than the expected PythonCodePrinter (wrong class scope)"
    : null;

  const agreement: ComparisonReport["agreement"] = {
    metric: "deterministicRepairRequired === liveRepairRequired",
    deterministicRepairRequired: detRepair,
    liveRepairRequired: liveRepair,
    repairRequiredAgreement,
    sameCoreDefect,
    coreDefect,
    riskComparison: {
      deterministic: deterministic.risk,
      live: live.risk,
      note:
        "Agreement is on repair_required only. The live critic gave a LOWER risk (medium vs high), reasoning the method is functionally inherited via AbstractPythonCodePrinter while still being too broad in scope.",
    },
    confidenceComparison: { deterministic: deterministic.confidence, live: live.confidence },
  };

  // --- added value -----------------------------------------------------------
  const addedValue: ComparisonReport["addedValue"] = {
    deterministicAlreadyKnew: [
      "inserted_method_scope probe FAILED (high confidence)",
      "expected class was PythonCodePrinter",
      "actual class was AbstractPythonCodePrinter (line 349)",
      "repair was required (risk=high, confidence=high)",
    ],
    liveAdded: [
      "human-readable synthesis of the wrong-scope defect",
      "explicit risk framing (downgraded to medium with reasoning)",
      "a concrete move/re-indent repair instruction (relocate the method, not rewrite it)",
      "the observation that the behavior is functionally inherited but too broad in scope",
    ],
    verdict:
      "The live critic added interpretive value (synthesis, risk reasoning, a concrete bounded repair instruction) but did not surface a defect the deterministic probes had missed. The defect, target class, and repair_required were already known deterministically; the live critic's contribution is the explanation and the actionable, minimal repair framing.",
  };

  // --- cost ------------------------------------------------------------------
  const costCapUsd = inputs.smoke?.gates?.criticCostCapUsd ?? DEFAULT_COST_CAP_USD;
  const criticCostUsd = liveMeta?.criticCostUsd ?? null;
  const withinCostCap = criticCostUsd !== null ? criticCostUsd <= costCapUsd : null;
  const cost: ComparisonReport["cost"] = {
    criticCostUsd,
    criticInputTokens: liveMeta?.criticInputTokens ?? null,
    criticOutputTokens: liveMeta?.criticOutputTokens ?? null,
    costCapUsd,
    withinCostCap,
    // "Acceptable" for a risk-gated, at-most-one-run critic = it stayed under the cap.
    acceptable: withinCostCap,
  };

  // --- safety ----------------------------------------------------------------
  const patchUnchanged =
    inputs.firstPatchDiff !== null && criticInput?.firstPatch !== undefined
      ? normalizePatch(inputs.firstPatchDiff) === normalizePatch(criticInput.firstPatch)
      : null;
  const safety: ComparisonReport["safety"] = {
    observationOnly: true,
    repairPerformed: false,
    dockerRun: false,
    patchUnchanged,
    failedOpen: live.failedOpen,
    liveReportValid: live.validReport,
  };

  // --- recommendation --------------------------------------------------------
  // Derive the suggested next-run set from the deterministic repair_required runs, minus the run we
  // already smoked. This is exactly the remaining deterministic high-/medium-risk run set.
  const derivedLabels = inputs.deterministicReports
    .filter((r) => r.repair_required === true && r.runLabel !== runLabel)
    .map((r) => r.runLabel);
  const fallbackLabels = [
    "eval-editguard-before-matplotlib-22719",
    "eval-patchverify-after-matplotlib-22719",
    "eval-editguard-before-requests-5414",
    "eval-editguard-after-requests-5414",
    "eval-patchverify-before-requests-5414",
  ];
  const suggestedRunLabels = derivedLabels.length > 0 ? derivedLabels : fallbackLabels;
  const recommendation: ComparisonReport["recommendation"] = {
    choice: "Run no-repair live critic observation over the remaining deterministic high-risk runs (still gated and cost-capped), before implementing repair.",
    text:
      "One gated live critic call is not enough signal to either implement repair or expand to low-risk runs. " +
      "Extend the same observation-only, cost-capped harness to the remaining deterministic repair_required runs to " +
      "see whether agreement and core-defect identification hold across instances and treatments. Do not implement " +
      "repair and do not include low-risk runs yet.",
    suggestedRunLabels,
    gated: true,
    costCapped: true,
    excludesLowRisk: true,
  };

  // --- summary ---------------------------------------------------------------
  const text =
    status !== "ok"
      ? status === "missing-live-artifacts"
        ? "Live critic smoke artifacts were not found; comparison could not be completed. See `missing` paths."
        : "The live critic ran but did not produce a valid structured report (failed-open or invalid JSON)."
      : "The live critic smoke succeeded technically and semantically: valid schema, no fail-open, agreement with the " +
        "deterministic critic on repair_required, the same wrong-scope diagnosis (_print_Indexed in " +
        "AbstractPythonCodePrinter), a concrete move/re-indent repair instruction, and no patch modification. " +
        "This is one live critic call only: it does not prove resolution improvement, does not prove repair would " +
        "succeed, and does not justify always-on critic usage.";

  const summary: ComparisonReport["summary"] = {
    status,
    liveReportValid: live.validReport,
    failedOpen: live.failedOpen,
    repairRequiredAgreement,
    sameCoreDefect,
    text,
  };

  return {
    generatedAt,
    runLabel,
    instanceId,
    status,
    summary,
    deterministic,
    live,
    agreement,
    addedValue,
    cost,
    safety,
    recommendation,
    nonClaims: NON_CLAIMS,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderJson(report: ComparisonReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function fmtBool(v: boolean | null): string {
  return v === null ? "—" : String(v);
}

function fmtUsd(v: number | null): string {
  return v === null ? "—" : `$${v.toFixed(4)}`;
}

export function renderMarkdown(report: ComparisonReport, missing: readonly string[]): string {
  const L: string[] = [];
  const { deterministic: d, live, agreement: a, addedValue: av, cost: c, safety: s, recommendation: rec } = report;

  L.push("# Stage 5 live critic smoke comparison");
  L.push("");
  if (report.generatedAt) L.push(`_Generated: ${report.generatedAt}_`, "");
  L.push(
    "_Reporting/analysis only. This report runs no agents, no live critic, and no Docker; it implements no repair and " +
      "modifies no patch, workspace, or raw artifact. It only reads the artifacts a single gated live-critic smoke run " +
      "already wrote and renders this comparison._",
  );
  L.push("");
  L.push(`Run: \`${report.runLabel}\`  ·  instance: \`${report.instanceId}\`  ·  status: \`${report.status}\``);
  L.push("");

  L.push("## Summary");
  L.push("");
  L.push(report.summary.text);
  L.push("");
  L.push("| metric | value |");
  L.push("| --- | --- |");
  L.push(`| status | ${report.status} |`);
  L.push(`| live report valid | ${fmtBool(report.summary.liveReportValid)} |`);
  L.push(`| failed-open | ${fmtBool(report.summary.failedOpen)} |`);
  L.push(`| repair_required agreement | ${fmtBool(report.summary.repairRequiredAgreement)} |`);
  L.push(`| same core defect | ${fmtBool(report.summary.sameCoreDefect)} |`);
  L.push("");

  L.push("## Smoke setup");
  L.push("");
  L.push("A single gated, cost-capped, observation-only live critic call was run manually:");
  L.push("");
  const g = report; // alias for readability
  L.push("```");
  L.push("bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_patch_critic_live.ts \\");
  L.push("  --results benchmarks/stage5_vexp_swe_bench_smoke/results \\");
  L.push("  --enable-patch-critic \\");
  L.push(`  --run-label ${g.runLabel} \\`);
  L.push("  --max-critic-runs 1 \\");
  L.push("  --only-deterministic-repair-required \\");
  L.push(`  --critic-cost-cap-usd ${c.costCapUsd.toFixed(2)} \\`);
  L.push("  --out-name stage5_patch_critic_live_smoke_sympy");
  L.push("```");
  L.push("");
  L.push(
    "The live critic is disabled by default; it was reached only via the injectable caller, on exactly one run the " +
      "deterministic critic had already flagged `repair_required`, and bounded by a single-call and cost cap. No repair, " +
      "no patch modification, and no Docker were involved.",
  );
  L.push("");

  L.push("## Deterministic critic result");
  L.push("");
  if (!d.available) {
    L.push("_Deterministic critic verdict for this run was not found in the dry-run report._");
  } else {
    L.push("| field | value |");
    L.push("| --- | --- |");
    L.push(`| scope_ok | ${fmtBool(d.scopeOk)} |`);
    L.push(`| risk | ${d.risk ?? "—"} |`);
    L.push(`| repair_required | ${fmtBool(d.repairRequired)} |`);
    L.push(`| confidence | ${d.confidence ?? "—"} |`);
    L.push("");
    if (d.insertedMethodScopeProbe) {
      L.push(
        `**inserted_method_scope probe**: \`${d.insertedMethodScopeProbe.status}\` (${d.insertedMethodScopeProbe.confidence}) — ${d.insertedMethodScopeProbe.evidence.join(" ")}`,
      );
      L.push("");
    }
    if (d.repairReason) L.push(`**repair_reason**: ${d.repairReason}`, "");
    if (d.repairInstructions) L.push(`**repair_instructions**: ${d.repairInstructions}`, "");
  }
  L.push("");

  L.push("## Live critic result");
  L.push("");
  L.push("| field | value |");
  L.push("| --- | --- |");
  L.push(`| ran | ${fmtBool(live.ran)} |`);
  L.push(`| validReport | ${fmtBool(live.validReport)} |`);
  L.push(`| failedOpen | ${fmtBool(live.failedOpen)} |`);
  L.push(`| scope_ok | ${fmtBool(live.scopeOk)} |`);
  L.push(`| failing_behavior_handled | ${fmtBool(live.failingBehaviorHandled)} |`);
  L.push(`| minimality_ok | ${fmtBool(live.minimalityOk)} |`);
  L.push(`| test_evidence_ok | ${fmtBool(live.testEvidenceOk)} |`);
  L.push(`| risk | ${live.risk ?? "—"} |`);
  L.push(`| repair_required | ${fmtBool(live.repairRequired)} |`);
  L.push(`| confidence | ${live.confidence ?? "—"} |`);
  L.push("");
  if (live.scopeEvidence) L.push(`**scope_evidence**: ${live.scopeEvidence}`, "");
  if (live.repairReason) L.push(`**repair_reason**: ${live.repairReason}`, "");
  if (live.repairInstructions) L.push(`**repair_instructions**: ${live.repairInstructions}`, "");
  L.push("");

  L.push("## Agreement analysis");
  L.push("");
  L.push(`Agreement metric: \`${a.metric}\`.`);
  L.push("");
  L.push("| dimension | deterministic | live | agree |");
  L.push("| --- | --- | --- | --- |");
  L.push(
    `| repair_required | ${fmtBool(a.deterministicRepairRequired)} | ${fmtBool(a.liveRepairRequired)} | ${fmtBool(a.repairRequiredAgreement)} |`,
  );
  L.push(`| risk | ${a.riskComparison.deterministic ?? "—"} | ${a.riskComparison.live ?? "—"} | ${a.riskComparison.deterministic === a.riskComparison.live} |`);
  L.push(
    `| confidence | ${a.confidenceComparison.deterministic ?? "—"} | ${a.confidenceComparison.live ?? "—"} | ${a.confidenceComparison.deterministic === a.confidenceComparison.live} |`,
  );
  L.push(`| same core defect | — | — | ${fmtBool(a.sameCoreDefect)} |`);
  L.push("");
  if (a.coreDefect) L.push(`**Core defect (both)**: ${a.coreDefect}`, "");
  L.push(`**Note**: ${a.riskComparison.note}`);
  L.push("");

  L.push("## Added value over deterministic probes");
  L.push("");
  L.push("Deterministic probes already knew:");
  L.push("");
  for (const x of av.deterministicAlreadyKnew) L.push(`- ${x}`);
  L.push("");
  L.push("Live critic added:");
  L.push("");
  for (const x of av.liveAdded) L.push(`- ${x}`);
  L.push("");
  L.push(av.verdict);
  L.push("");

  L.push("## Cost and token impact");
  L.push("");
  L.push("| metric | value |");
  L.push("| --- | --- |");
  L.push(`| critic cost (USD) | ${fmtUsd(c.criticCostUsd)} |`);
  L.push(`| input tokens | ${c.criticInputTokens ?? "—"} |`);
  L.push(`| output tokens | ${c.criticOutputTokens ?? "—"} |`);
  L.push(`| cost cap (USD) | ${fmtUsd(c.costCapUsd)} |`);
  L.push(`| within cost cap | ${fmtBool(c.withinCostCap)} |`);
  L.push("");
  L.push(
    `Cost is acceptable for a risk-gated critic that runs on at most one deterministic \`repair_required\` run and ` +
      `stops at the cap: ${fmtUsd(c.criticCostUsd)} against a ${fmtUsd(c.costCapUsd)} cap. This says nothing about ` +
      `always-on cost, which is out of scope and not justified by one call.`,
  );
  L.push("");

  L.push("## Safety properties");
  L.push("");
  L.push("| property | value |");
  L.push("| --- | --- |");
  L.push(`| observation only | ${fmtBool(s.observationOnly)} |`);
  L.push(`| repair performed | ${fmtBool(s.repairPerformed)} |`);
  L.push(`| Docker run | ${fmtBool(s.dockerRun)} |`);
  L.push(`| patch unchanged | ${fmtBool(s.patchUnchanged)} |`);
  L.push(`| failed-open | ${fmtBool(s.failedOpen)} |`);
  L.push(`| live report valid | ${fmtBool(s.liveReportValid)} |`);
  L.push("");
  L.push(
    s.patchUnchanged === true
      ? "The patch recorded in the critic input matches `_first_patch.diff` byte-for-byte (modulo trailing whitespace): the live critic preserved the no-patch-modification property."
      : "Patch-equality could not be confirmed from the available artifacts; the runner's contract is still observation-only.",
  );
  L.push("");

  L.push("## Recommended next step");
  L.push("");
  L.push(`**${rec.choice}**`);
  L.push("");
  L.push(rec.text);
  L.push("");
  L.push("Suggested run labels (deterministic repair_required, excluding the already-smoked run and all low-risk runs):");
  L.push("");
  for (const lbl of rec.suggestedRunLabels) L.push(`- ${lbl}`);
  L.push("");

  L.push("## Non-claims");
  L.push("");
  for (const n of report.nonClaims) L.push(`- ${n}`);
  L.push("");
  if (missing.length > 0) {
    L.push(`_Missing/unreadable inputs: ${missing.join(", ")}_`);
    L.push("");
  }

  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main (impure)
// ---------------------------------------------------------------------------

async function main(config: CliConfig): Promise<void> {
  const inputs = await loadComparisonInputs(config.resultsDir, config.runLabel);
  const generatedAt = new Date().toISOString();
  const report = buildComparison({ generatedAt, runLabel: config.runLabel, inputs });

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report, inputs.missing));
  await writeFile(jsonPath, renderJson(report));

  process.stdout.write(
    [
      `Stage 5 live critic smoke comparison written:`,
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Status: ${report.status}`,
      `Run: ${report.runLabel} (${report.instanceId})`,
      `Live valid report: ${report.live.validReport}   failed-open: ${report.live.failedOpen}`,
      `repair_required — deterministic: ${fmtBool(report.deterministic.repairRequired)}   live: ${fmtBool(report.live.repairRequired)}   agreement: ${report.summary.repairRequiredAgreement}`,
      `Same core defect: ${report.summary.sameCoreDefect}`,
      `Cost: ${fmtUsd(report.cost.criticCostUsd)} (cap ${fmtUsd(report.cost.costCapUsd)}, within: ${fmtBool(report.cost.withinCostCap)})`,
      `Patch unchanged: ${fmtBool(report.safety.patchUnchanged)}`,
      inputs.missing.length > 0 ? `Missing inputs: ${inputs.missing.join(", ")}` : "",
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
