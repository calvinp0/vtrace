// Stage 5 remaining live critic observation PLAN (planning/reporting only).
//
// SCOPE: this runner reads the deterministic critic verdicts and emits a PLAN (Markdown + JSON) for
// the remaining gated, no-repair live critic observation runs. It runs NO live critic, NO agents,
// NO Docker; it implements NO repair and modifies NO patch, workspace, or raw artifact. The only
// files it writes are the two plan files named by --out-name.
//
// The target run set is DERIVED from the deterministic dry-run report: every run the cheap critic
// flagged repair_required, minus the already-smoked sympy run. Low-risk runs (repair_required=false)
// are excluded structurally by the same predicate. If the dry-run report is absent, a canonical
// fallback set is used so the plan is still emitted.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { PatchCriticReport } from "./stage5_patch_critic";
import { RESULTS_REL } from "./run_stage5_patch_probe_report";

// The run already covered by the one-call smoke comparison (7d44cd7). Excluded here.
export const SMOKED_LABEL = "eval-patchverify-before-sympy-16766";

// Gates for the remaining observation batch.
export const MAX_CRITIC_RUNS = 5;
export const COST_CAP_USD = 0.75;

// Out-names of the INNER live-critic runner's artifacts (distinct from this plan's own out-name).
export const LIVE_OUT_NAME = "stage5_patch_critic_live_remaining_high_risk";
export const DRY_RUN_OUT_NAME = "stage5_patch_critic_live_remaining_high_risk_dry_run";

// Per-run artifact files the live critic runner writes into each run's raw/vtrace dir.
export const ARTIFACT_FILES: readonly string[] = [
  "_patch_critic.meta.json",
  "_patch_critic_report.json",
  "_patch_critic_input.json",
  "_patch_critic.raw.txt",
  "_first_patch.diff",
];

// Canonical fallback (used only if the deterministic dry-run report cannot be read).
const FALLBACK_INCLUDED: ReadonlyArray<{ runLabel: string; instanceId: string }> = [
  { runLabel: "eval-editguard-before-matplotlib-22719", instanceId: "matplotlib__matplotlib-22719" },
  { runLabel: "eval-patchverify-after-matplotlib-22719", instanceId: "matplotlib__matplotlib-22719" },
  { runLabel: "eval-editguard-before-requests-5414", instanceId: "psf__requests-5414" },
  { runLabel: "eval-editguard-after-requests-5414", instanceId: "psf__requests-5414" },
  { runLabel: "eval-patchverify-before-requests-5414", instanceId: "psf__requests-5414" },
];

export function knownRiskType(instanceId: string): string {
  if (instanceId.startsWith("matplotlib__")) return "matplotlib missing failing behavior / empty-array handling";
  if (instanceId.startsWith("psf__requests")) return "requests broad rewrite / minimality risk";
  if (instanceId.startsWith("sympy__")) return "sympy wrong class-scope placement";
  return "unknown risk type";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly outName: string;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let outName = "stage5_live_critic_remaining_plan";
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
// Read-only loader (fail-soft)
// ---------------------------------------------------------------------------

interface DryRunDoc {
  readonly reports?: readonly PatchCriticReport[];
}

// Read the deterministic dry-run verdicts. Read-only; returns [] if the file is absent/unreadable.
export async function loadDeterministicReports(resultsDir: string): Promise<readonly PatchCriticReport[]> {
  try {
    const doc = JSON.parse(
      await readFile(path.join(resultsDir, "stage5_patch_critic_dry_run_existing_runs.json"), "utf8"),
    ) as DryRunDoc;
    return doc.reports ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Plan model (pure)
// ---------------------------------------------------------------------------

export interface PlanLabel {
  readonly runLabel: string;
  readonly instanceId: string;
  readonly deterministicRepairRequired: boolean;
  readonly reasonIncluded: string;
  readonly knownRiskType: string;
}

export interface ExcludedLabel {
  readonly runLabel: string;
  readonly instanceId: string;
  readonly deterministicRepairRequired: boolean;
  readonly reasonExcluded: string;
}

export interface DerivedLabels {
  readonly included: readonly PlanLabel[];
  readonly excluded: readonly ExcludedLabel[];
  readonly derivedFrom: "deterministic-dry-run" | "fallback";
}

const REASON_INCLUDED =
  "deterministic critic flagged repair_required (high-risk); included for gated no-repair live critic observation";

// Derive the included/excluded sets from the deterministic reports. Included = repair_required &&
// not the already-smoked run. Excluded = the smoked run (already covered) plus every low-risk
// (repair_required=false) run. Falls back to the canonical five if no reports are available.
export function deriveLabels(reports: readonly PatchCriticReport[]): DerivedLabels {
  if (reports.length === 0) {
    return {
      included: FALLBACK_INCLUDED.map((l) => ({
        runLabel: l.runLabel,
        instanceId: l.instanceId,
        deterministicRepairRequired: true,
        reasonIncluded: REASON_INCLUDED,
        knownRiskType: knownRiskType(l.instanceId),
      })),
      excluded: [
        {
          runLabel: SMOKED_LABEL,
          instanceId: "sympy__sympy-16766",
          deterministicRepairRequired: true,
          reasonExcluded: "already-smoked: the one-call live critic comparison already covered this run",
        },
      ],
      derivedFrom: "fallback",
    };
  }

  const included: PlanLabel[] = [];
  const excluded: ExcludedLabel[] = [];
  for (const r of reports) {
    if (r.runLabel === SMOKED_LABEL) {
      excluded.push({
        runLabel: r.runLabel,
        instanceId: r.instanceId,
        deterministicRepairRequired: r.repair_required,
        reasonExcluded: "already-smoked: the one-call live critic comparison already covered this run",
      });
      continue;
    }
    if (r.repair_required) {
      included.push({
        runLabel: r.runLabel,
        instanceId: r.instanceId,
        deterministicRepairRequired: true,
        reasonIncluded: REASON_INCLUDED,
        knownRiskType: knownRiskType(r.instanceId),
      });
    } else {
      excluded.push({
        runLabel: r.runLabel,
        instanceId: r.instanceId,
        deterministicRepairRequired: false,
        reasonExcluded: "low-risk: deterministic critic did not flag repair_required",
      });
    }
  }
  return { included, excluded, derivedFrom: "deterministic-dry-run" };
}

// --- command construction (single source of truth for the printed + JSON commands) ---

function joinCmd(lines: readonly string[]): string {
  return lines.join(" \\\n");
}

export function buildLiveCommand(resultsDir: string, labels: readonly string[]): string {
  return joinCmd([
    "bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_patch_critic_live.ts",
    `  --results ${resultsDir}`,
    "  --enable-patch-critic",
    ...labels.map((l) => `  --run-label ${l}`),
    `  --max-critic-runs ${MAX_CRITIC_RUNS}`,
    "  --only-deterministic-repair-required",
    `  --critic-cost-cap-usd ${COST_CAP_USD.toFixed(2)}`,
    `  --out-name ${LIVE_OUT_NAME}`,
  ]);
}

export function buildDryRunCommand(resultsDir: string, labels: readonly string[]): string {
  return joinCmd([
    "bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_patch_critic_live.ts",
    `  --results ${resultsDir}`,
    "  --enable-patch-critic",
    "  --dry-run",
    ...labels.map((l) => `  --run-label ${l}`),
    `  --max-critic-runs ${MAX_CRITIC_RUNS}`,
    "  --only-deterministic-repair-required",
    `  --critic-cost-cap-usd ${COST_CAP_USD.toFixed(2)}`,
    `  --out-name ${DRY_RUN_OUT_NAME}`,
  ]);
}

export function buildInspectionScript(resultsDir: string, labels: readonly string[]): string {
  const lines: string[] = ["for LABEL in \\"];
  labels.forEach((l, i) => {
    lines.push(`  ${l}${i === labels.length - 1 ? "" : " \\"}`);
  });
  lines.push("do");
  lines.push(`  RAW="${resultsDir}/runs/$LABEL/raw/vtrace"`);
  lines.push('  echo "===== $LABEL ====="');
  lines.push(
    "  jq '{enabled, ran, validReport, failedOpen, criticCostUsd, criticInputTokens, criticOutputTokens, deterministicRepairRequired, liveRepairRequired, agreementWithDeterministic}' \"$RAW/_patch_critic.meta.json\"",
  );
  lines.push(
    "  jq '{risk, confidence, repair_required, repair_reason, repair_instructions, evidence_probe_ids}' \"$RAW/_patch_critic_report.json\"",
  );
  lines.push("done");
  return lines.join("\n");
}

export interface SafetyGates {
  readonly enablePatchCritic: boolean;
  readonly runLabelConstrained: boolean;
  readonly onlyDeterministicRepairRequired: boolean;
  readonly maxCriticRuns: number;
  readonly criticCostCapUsd: number;
  readonly noRepair: boolean;
  readonly noPatchModification: boolean;
  readonly noDocker: boolean;
  readonly noAgentRerun: boolean;
}

export interface ExpectedArtifacts {
  readonly artifactFilesPerRun: readonly string[];
  readonly perRunArtifactDirTemplate: string;
  readonly runDirs: readonly string[];
  readonly liveReportFiles: readonly string[];
  readonly dryRunReportFiles: readonly string[];
}

export interface RecommendedNextReport {
  readonly name: string;
  readonly measures: readonly string[];
}

export interface PlanReport {
  readonly generatedAt: string | null;
  readonly derivedFrom: DerivedLabels["derivedFrom"];
  readonly labels: readonly PlanLabel[];
  readonly excludedLabels: readonly ExcludedLabel[];
  readonly dryRunCommand: string;
  readonly liveCommand: string;
  readonly inspectionScript: string;
  readonly reportPreviewCommand: string;
  readonly safetyGates: SafetyGates;
  readonly expectedArtifacts: ExpectedArtifacts;
  readonly recommendedNextReport: RecommendedNextReport;
  readonly nonClaims: readonly string[];
}

export const NON_CLAIMS: readonly string[] = [
  "This plan runs no live critic, no agents, and no Docker.",
  "This plan implements no repair and modifies no patch or workspace.",
  "This plan modifies no raw artifact; it only reads deterministic verdicts and writes its own plan files.",
  "The live critic remains disabled by default and gated (run-label, deterministic-repair-required, max 5 calls, $0.75 cap).",
  "`repair_required` is an OBSERVATION (what a critic would request); no repair is performed.",
  "This plan does not prove the live critic improves SWE-bench resolution.",
  "This plan does not compare VTRACE against VEXP.",
  "The $0.75 cap is an upper bound; actual spend depends on per-run tokens and is expected to be lower.",
];

const NEXT_REPORT: RecommendedNextReport = {
  name: "stage5_live_critic_high_risk_comparison.md/json",
  measures: [
    "valid report rate",
    "fail-open rate",
    "agreement with deterministic critic",
    "per-field agreement/disagreement",
    "whether the live critic adds new information beyond deterministic probes",
    "cost/tokens",
    "whether repair instructions are concrete enough to justify one-repair-attempt mode",
  ],
};

export function buildPlan(args: {
  readonly generatedAt: string | null;
  readonly resultsDir: string;
  readonly derived: DerivedLabels;
}): PlanReport {
  const { generatedAt, resultsDir, derived } = args;
  const labels = derived.included.map((l) => l.runLabel);
  return {
    generatedAt,
    derivedFrom: derived.derivedFrom,
    labels: derived.included,
    excludedLabels: derived.excluded,
    dryRunCommand: buildDryRunCommand(resultsDir, labels),
    liveCommand: buildLiveCommand(resultsDir, labels),
    inspectionScript: buildInspectionScript(resultsDir, labels),
    reportPreviewCommand: `sed -n '1,260p' ${resultsDir}/${LIVE_OUT_NAME}.md`,
    safetyGates: {
      enablePatchCritic: true,
      runLabelConstrained: true,
      onlyDeterministicRepairRequired: true,
      maxCriticRuns: MAX_CRITIC_RUNS,
      criticCostCapUsd: COST_CAP_USD,
      noRepair: true,
      noPatchModification: true,
      noDocker: true,
      noAgentRerun: true,
    },
    expectedArtifacts: {
      artifactFilesPerRun: ARTIFACT_FILES,
      perRunArtifactDirTemplate: `${resultsDir}/runs/<runLabel>/raw/vtrace`,
      runDirs: labels.map((l) => `${resultsDir}/runs/${l}/raw/vtrace`),
      liveReportFiles: [`${LIVE_OUT_NAME}.md`, `${LIVE_OUT_NAME}.json`],
      dryRunReportFiles: [`${DRY_RUN_OUT_NAME}.md`, `${DRY_RUN_OUT_NAME}.json`],
    },
    recommendedNextReport: NEXT_REPORT,
    nonClaims: NON_CLAIMS,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderJson(plan: PlanReport): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function renderMarkdown(plan: PlanReport): string {
  const L: string[] = [];
  const g = plan.safetyGates;

  L.push("# Stage 5 remaining live critic observation plan");
  L.push("");
  if (plan.generatedAt) L.push(`_Generated: ${plan.generatedAt}_`, "");
  L.push(
    "_Planning/reporting only. This document runs no live critic, no agents, and no Docker; it implements no repair " +
      "and modifies no patch, workspace, or raw artifact. It only reads deterministic verdicts and writes these plan files._",
  );
  L.push("");

  L.push("## Summary");
  L.push("");
  L.push(
    `Plan for ${plan.labels.length} remaining gated, no-repair live critic observation run(s), derived from the ` +
      `deterministic dry-run verdicts (source: ${plan.derivedFrom}). The already-smoked run \`${SMOKED_LABEL}\` and ` +
      `all low-risk runs are excluded. The live critic stays disabled by default and bounded by run-label, ` +
      `deterministic-repair-required, a ${g.maxCriticRuns}-call cap, and a $${g.criticCostCapUsd.toFixed(2)} cost cap.`,
  );
  L.push("");
  L.push("| field | value |");
  L.push("| --- | --- |");
  L.push(`| included runs | ${plan.labels.length} |`);
  L.push(`| excluded runs | ${plan.excludedLabels.length} |`);
  L.push(`| max critic runs | ${g.maxCriticRuns} |`);
  L.push(`| cost cap (USD) | $${g.criticCostCapUsd.toFixed(2)} |`);
  L.push("");

  L.push("## Why these runs");
  L.push("");
  L.push(
    "These are exactly the runs the cheap deterministic critic flagged `repair_required`, minus the run already " +
      "covered by the one-call smoke comparison. Low-risk runs (deterministic `repair_required=false`) are excluded. " +
      "The goal is no-repair live critic OBSERVATION: confirm the live critic agrees with the deterministic critic, " +
      "identifies the same core defect, and yields concrete repair instructions — before any repair is implemented.",
  );
  L.push("");
  L.push("| run | instance | det repair_required | known risk type | reason included |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const l of plan.labels) {
    L.push(`| ${l.runLabel} | ${l.instanceId} | ${l.deterministicRepairRequired} | ${l.knownRiskType} | ${l.reasonIncluded} |`);
  }
  L.push("");
  L.push("Excluded:");
  L.push("");
  L.push("| run | instance | det repair_required | reason excluded |");
  L.push("| --- | --- | --- | --- |");
  for (const l of plan.excludedLabels) {
    L.push(`| ${l.runLabel} | ${l.instanceId} | ${l.deterministicRepairRequired} | ${l.reasonExcluded} |`);
  }
  L.push("");

  L.push("## Safety gates");
  L.push("");
  L.push("- no repair");
  L.push("- no patch modification");
  L.push("- no Docker");
  L.push("- no agent rerun");
  L.push("- run-label constrained");
  L.push("- deterministic-repair-required only");
  L.push(`- max ${g.maxCriticRuns} calls`);
  L.push(`- cost cap $${g.criticCostCapUsd.toFixed(2)}`);
  L.push("");

  L.push("## Dry-run command");
  L.push("");
  L.push("Run this first to confirm the gates select exactly the five runs (no model is called in dry-run):");
  L.push("");
  L.push("```bash");
  L.push(plan.dryRunCommand);
  L.push("```");
  L.push("");

  L.push("## Live observation command");
  L.push("");
  L.push("```bash");
  L.push(plan.liveCommand);
  L.push("```");
  L.push("");

  L.push("## Expected artifacts");
  L.push("");
  L.push("Per included run, under `" + plan.expectedArtifacts.perRunArtifactDirTemplate + "`:");
  L.push("");
  for (const f of plan.expectedArtifacts.artifactFilesPerRun) L.push(`- ${f}`);
  L.push("");
  L.push("Comparison report files (written by the live runner):");
  L.push("");
  for (const f of plan.expectedArtifacts.liveReportFiles) L.push(`- ${f}`);
  L.push("");
  L.push("Dry-run report files:");
  L.push("");
  for (const f of plan.expectedArtifacts.dryRunReportFiles) L.push(`- ${f}`);
  L.push("");
  L.push(
    "_All per-run artifacts land under `results/runs/...` and remain untracked; do not commit them._",
  );
  L.push("");

  L.push("## What to inspect after running");
  L.push("");
  L.push("Per-run live critic meta + structured report:");
  L.push("");
  L.push("```bash");
  L.push(plan.inspectionScript);
  L.push("```");
  L.push("");
  L.push("Preview the comparison report:");
  L.push("");
  L.push("```bash");
  L.push(plan.reportPreviewCommand);
  L.push("```");
  L.push("");
  L.push(
    `After the ${plan.labels.length} observations are complete, the next task should add ` +
      `\`${plan.recommendedNextReport.name}\`, measuring:`,
  );
  L.push("");
  for (const m of plan.recommendedNextReport.measures) L.push(`- ${m}`);
  L.push("");

  L.push("## Non-claims");
  L.push("");
  for (const n of plan.nonClaims) L.push(`- ${n}`);
  L.push("");

  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main (impure)
// ---------------------------------------------------------------------------

async function main(config: CliConfig): Promise<void> {
  const reports = await loadDeterministicReports(config.resultsDir);
  const derived = deriveLabels(reports);
  const generatedAt = new Date().toISOString();
  const plan = buildPlan({ generatedAt, resultsDir: config.resultsDir, derived });

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(plan));
  await writeFile(jsonPath, renderJson(plan));

  process.stdout.write(
    [
      "Stage 5 remaining live critic observation plan written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Derived from: ${derived.derivedFrom}`,
      `Included (${plan.labels.length}): ${plan.labels.map((l) => l.runLabel).join(", ")}`,
      `Excluded (${plan.excludedLabels.length}): ${plan.excludedLabels.map((l) => l.runLabel).join(", ")}`,
      `Gates: --max-critic-runs ${MAX_CRITIC_RUNS}, --only-deterministic-repair-required, --critic-cost-cap-usd ${COST_CAP_USD.toFixed(2)}`,
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
