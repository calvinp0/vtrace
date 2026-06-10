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

export const DEFAULT_OUT_NAME = "stage5_patch_critic_live_existing_runs";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly outName: string;
  readonly enablePatchCritic: boolean; // DEFAULT false
  readonly criticModel: string | null;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let outName = DEFAULT_OUT_NAME;
  let enablePatchCritic = false; // disabled by default
  let criticModel: string | null = null;
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
      case "--help":
      case "-h":
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { resultsDir, outName, enablePatchCritic, criticModel };
}

// ---------------------------------------------------------------------------
// Per-run processing (pure given a caller)
// ---------------------------------------------------------------------------

export interface CriticLiveRunResult {
  readonly runLabel: string;
  readonly instanceId: string;
  readonly meta: LiveCriticMeta;
  readonly report: PatchCriticReport | null;
  readonly deterministicReport: PatchCriticReport;
  readonly artifacts: Record<string, string>;
  readonly input: PatchCriticInput;
}

// Run the live critic for a single already-loaded run. Builds the deterministic baseline, the
// bounded input, then invokes the (possibly-disabled) live critic and assembles artifacts.
export async function processRun(args: {
  readonly probeSummary: PatchProbeSummary;
  readonly patch: string;
  readonly signals: Awaited<ReturnType<typeof loadRunMetaSignals>>;
  readonly enabled: boolean;
  readonly caller: CriticCaller;
  readonly criticModel: string | null;
}): Promise<CriticLiveRunResult> {
  const input = buildCriticInput(args.probeSummary, args.patch, args.signals);
  const deterministicReport = buildDeterministicPatchCriticReport(input);
  const outcome: RunLiveCriticOutcome = await runLiveCritic({
    enabled: args.enabled,
    input,
    deterministicReport,
    caller: args.caller,
    criticModel: args.criticModel,
  });
  const artifacts = args.enabled && outcome.meta.ran ? buildCriticArtifacts({ input, outcome }) : {};
  return {
    runLabel: args.probeSummary.runLabel,
    instanceId: args.probeSummary.instanceId,
    meta: outcome.meta,
    report: outcome.report,
    deterministicReport,
    artifacts,
    input,
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

export interface CriticLiveReport {
  readonly generatedAt: string | null;
  readonly summary: CriticLiveSummary;
  readonly runs: readonly {
    readonly runLabel: string;
    readonly instanceId: string;
    readonly meta: LiveCriticMeta;
    readonly liveReport: PatchCriticReport | null;
    readonly deterministicRepairRequired: boolean;
  }[];
  readonly nonClaims: readonly string[];
}

export const NON_CLAIMS: readonly string[] = [
  "Critic OBSERVATION ONLY: the live critic never modifies the patch, edited files, workspace, final patch, or evaluation input.",
  "Disabled by default; with no --enable-patch-critic flag no model is called and no critic artifacts are written.",
  "`repair_required = true` here is an OBSERVATION (what a critic would request); no repair is performed this milestone.",
  "Fail-open: a critic invocation error or invalid JSON is recorded and the original patch is preserved; the run is not failed.",
  "Agreement = (deterministicRepairRequired === liveRepairRequired); per-field agreement is not required for this milestone.",
  "This changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY behavior and runs no Docker.",
];

export function buildLiveReport(
  generatedAt: string | null,
  enabled: boolean,
  results: readonly CriticLiveRunResult[],
): CriticLiveReport {
  return {
    generatedAt,
    summary: buildLiveSummary(enabled, results),
    runs: results.map((r) => ({
      runLabel: r.runLabel,
      instanceId: r.instanceId,
      meta: r.meta,
      liveReport: r.report,
      deterministicRepairRequired: r.deterministicReport.repair_required,
    })),
    nonClaims: NON_CLAIMS,
  };
}

export function renderJson(report: CriticLiveReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderMarkdown(report: CriticLiveReport): string {
  const { summary } = report;
  const lines: string[] = [];
  lines.push("# Stage 5 live patch critic over existing runs");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");
  lines.push(
    "_Critic observation only. No repair, no patch modification, no Docker. Live critic disabled unless " +
      "`--enable-patch-critic` is passed; the model is reached only through the injectable caller._",
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `enabled=${summary.enabled}; analyzed ${summary.runsAnalyzed} run(s); critic ran on ${summary.criticRan}, ` +
      `${summary.validReports} valid report(s), ${summary.failedOpen} failed-open. Live repair_required: ` +
      `${summary.liveRepairRequired}; deterministic repair_required: ${summary.deterministicRepairRequired}; ` +
      `agreement ${summary.agreementCount}/${summary.validReports}. Critic cost $${summary.totalCriticCostUsd.toFixed(4)} ` +
      `(${summary.totalCriticInputTokens} in / ${summary.totalCriticOutputTokens} out tokens).`,
  );
  lines.push("");
  lines.push("| metric | value |");
  lines.push("| --- | --- |");
  for (const [k, v] of Object.entries(summary)) lines.push(`| ${k} | ${v} |`);
  lines.push("");
  lines.push("## Results by run");
  lines.push("");
  lines.push("| run | ran | valid | failedOpen | live repair | det repair | agreement | cost |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of report.runs) {
    lines.push(
      `| ${r.runLabel} | ${r.meta.ran} | ${r.meta.validReport} | ${r.meta.failedOpen} | ` +
        `${r.meta.liveRepairRequired ?? "—"} | ${r.deterministicRepairRequired} | ` +
        `${r.meta.agreementWithDeterministic ?? "—"} | $${r.meta.criticCostUsd.toFixed(4)} |`,
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
  const results: CriticLiveRunResult[] = [];
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
    const result = await processRun({
      probeSummary,
      patch: loaded.patch,
      signals,
      enabled: true,
      caller,
      criticModel: config.criticModel,
    });
    // Write critic artifacts into the run's raw condition dir (untracked; never overwrites the
    // patch or existing run artifacts — only adds _patch_critic*.* / _first_patch.diff).
    const vtraceDir = path.join(config.resultsDir, "runs", label, "raw", "vtrace");
    await mkdir(vtraceDir, { recursive: true });
    for (const [name, content] of Object.entries(result.artifacts)) {
      await writeFile(path.join(vtraceDir, name), content);
    }
    results.push(result);
  }

  const report = buildLiveReport(generatedAt, true, results);
  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  const s = report.summary;
  process.stdout.write(
    [
      "Stage 5 live patch critic report written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Runs analyzed: ${s.runsAnalyzed}${missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""}`,
      `Critic ran: ${s.criticRan}   Valid: ${s.validReports}   Failed-open: ${s.failedOpen}   Agreement: ${s.agreementCount}/${s.validReports}`,
      `Critic cost: $${s.totalCriticCostUsd.toFixed(4)}`,
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
