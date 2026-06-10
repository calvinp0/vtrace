// Stage 5 patch critic REPORT-ONLY dry run over the existing twelve passive-treatment runs
// (EDIT_GUARD before/after + PATCH_VERIFY before/after, for sympy / matplotlib / requests).
//
// SCOPE: analysis / reporting ONLY. For each run it reads the patch + tool-call / stdout
// artifacts that already exist on disk, runs the milestone-2 deterministic probes, feeds the
// probe summary (plus bounded run metadata) into the milestone-3 DETERMINISTIC critic, and
// writes a Markdown + JSON report describing what a critic WOULD have done. It runs NO agents,
// NO Docker, calls NO model, attempts NO repair (the sole subprocess is a local
// `python3 ast.parse` for the python_parse probe; if python3 is unavailable that probe
// degrades to `unknown`). It mutates no raw artifact.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import {
  type PatchProbeSummary,
  type PythonParser,
  type RawToolCall,
  summarizePatch,
} from "./stage5_patch_probes";
import {
  INSTANCE_CONFIGS,
  type CriticContextSignals,
  type CriticTreatmentMetadata,
  type PatchCriticInput,
  type PatchCriticReport,
  buildDeterministicPatchCriticReport,
  validatePatchCriticReport,
} from "./stage5_patch_critic";
import {
  RESULTS_REL,
  RUN_LABELS,
  loadRun,
  makePythonParser,
} from "./run_stage5_patch_probe_report";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_OUT_NAME = "stage5_patch_critic_dry_run_existing_runs";

export const NON_CLAIMS: readonly string[] = [
  "This is a REPORT-ONLY dry run of a DETERMINISTIC/mock critic; it calls no model, runs no agents, no Docker, and attempts no repair.",
  "It mutates no raw artifact; it only reads existing run outputs and writes its own report.",
  "`repair_required = true` here means a critic *would request* one bounded repair — no repair is performed, and the effect on resolution is not measured.",
  "A critic dimension that passes means a probe found no problem in the diff window — not that the patch is correct. Docker resolution remains the only ground truth.",
  "`null` (scope/failing-behavior/test) is an honest measurement gap, not a pass, and never forces repair on its own.",
  "The deterministic critic mirrors the eventual live critic's contract but not its reasoning; it is tuned to three known losses and may not generalize.",
  "This changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY behavior.",
];

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface CriticSummary {
  readonly runsAnalyzed: number;
  readonly repairRequiredCount: number;
  readonly highRiskCount: number;
  readonly mediumRiskCount: number;
  readonly lowRiskCount: number;
  readonly unknownRiskCount: number;
  readonly scopeUnknownCount: number;
  readonly missingTestEvidenceCount: number;
  readonly knownDefectLikelyCaughtCount: number;
}

export interface CriticInstanceRollup {
  readonly instanceId: string;
  readonly knownDefect: string;
  readonly targetProbeId: string;
  readonly runs: number;
  readonly repairRequiredRuns: number;
  readonly knownDefectCaughtRuns: number;
  readonly scopeUnknownRuns: number;
}

// A per-run record paired with the probe summary it was derived from (so the report can show
// both the critic's verdict and the underlying probe signal it consumed).
export interface CriticRunRecord {
  readonly report: PatchCriticReport;
  readonly probeSummary: PatchProbeSummary;
  readonly treatmentMetadata: CriticTreatmentMetadata;
}

export interface CriticDryRunReport {
  readonly generatedAt: string | null;
  readonly summary: CriticSummary;
  readonly reports: readonly PatchCriticReport[];
  readonly instances: readonly CriticInstanceRollup[];
  readonly nonClaims: readonly string[];
}

// ---------------------------------------------------------------------------
// Aggregation (pure)
// ---------------------------------------------------------------------------

function scopeProbeStatus(summary: PatchProbeSummary): string | null {
  return summary.probes.find((p) => p.probeId === "inserted_method_scope")?.status ?? null;
}

export function buildCriticSummary(records: readonly CriticRunRecord[]): CriticSummary {
  return {
    runsAnalyzed: records.length,
    repairRequiredCount: records.filter((r) => r.report.repair_required).length,
    highRiskCount: records.filter((r) => r.report.risk === "high").length,
    mediumRiskCount: records.filter((r) => r.report.risk === "medium").length,
    lowRiskCount: records.filter((r) => r.report.risk === "low").length,
    unknownRiskCount: records.filter((r) => r.report.risk === "unknown").length,
    scopeUnknownCount: records.filter((r) => scopeProbeStatus(r.probeSummary) === "unknown").length,
    missingTestEvidenceCount: records.filter((r) => r.report.test_evidence_ok === false).length,
    knownDefectLikelyCaughtCount: records.filter((r) => r.probeSummary.knownDefectLikelyCaught === true)
      .length,
  };
}

export function buildCriticInstanceRollups(records: readonly CriticRunRecord[]): CriticInstanceRollup[] {
  const byInstance = new Map<string, CriticRunRecord[]>();
  for (const r of records) {
    const list = byInstance.get(r.report.instanceId) ?? [];
    list.push(r);
    byInstance.set(r.report.instanceId, list);
  }
  const rollups: CriticInstanceRollup[] = [];
  for (const [instanceId, list] of byInstance) {
    const config = INSTANCE_CONFIGS[instanceId];
    rollups.push({
      instanceId,
      knownDefect: config?.knownDefect ?? "(unknown)",
      targetProbeId: config?.targetProbeId ?? "(none)",
      runs: list.length,
      repairRequiredRuns: list.filter((r) => r.report.repair_required).length,
      knownDefectCaughtRuns: list.filter((r) => r.probeSummary.knownDefectLikelyCaught === true).length,
      scopeUnknownRuns: list.filter((r) => scopeProbeStatus(r.probeSummary) === "unknown").length,
    });
  }
  return rollups;
}

// Choose one of the three milestone-defined next steps from the actual dry-run results.
export function recommendedNextStep(
  summary: CriticSummary,
  instances: readonly CriticInstanceRollup[],
): string {
  const sympy = instances.find((i) => i.instanceId === "sympy__sympy-16766");
  // The scope dimension is "blind" when its known-defect runs were never caught and scope was
  // indeterminate from the diff.
  const scopeBlind =
    summary.scopeUnknownCount > 0 && (sympy ? sympy.knownDefectCaughtRuns === 0 : false);

  if (summary.repairRequiredCount === 0) {
    return (
      "C. Improve the deterministic probes before involving a critic. On these runs the critic " +
      "requested repair on zero runs, so it would be reasoning over pass/unknown-only input — strengthen " +
      "scope reconstruction and failing-behavior detection first."
    );
  }

  if (scopeBlind) {
    return (
      "B (with an A prerequisite for one dimension). Add a disabled-by-default LIVE critic invocation that writes " +
      "`_patch_critic_input.json` / `_patch_critic_report.json` but takes NO repair action. The deterministic critic " +
      `already converts ${summary.repairRequiredCount} run(s) of real risk (broad-rewrite and missing-failing-behavior ` +
      "signals) into concrete, actionable repair instructions, which is enough deterministic grounding to justify a " +
      "report-only live critic next. HOWEVER, the sympy wrong-scope defect remains invisible to cheap probes " +
      `(scope undetermined in ${summary.scopeUnknownCount} run(s), 0 caught), so implement full-file reconstruction for ` +
      "the scope probe (option A) FIRST for that dimension — otherwise the live critic inherits the same blind spot."
    );
  }

  return (
    "B. Add a disabled-by-default LIVE critic invocation that writes the critic input/report artifacts but takes NO " +
    `repair action. The deterministic critic converts ${summary.repairRequiredCount} run(s) of real risk into concrete ` +
    "repair instructions with no blind dimensions remaining."
  );
}

export function buildCriticDryRunReport(
  generatedAt: string | null,
  records: readonly CriticRunRecord[],
): CriticDryRunReport {
  return {
    generatedAt,
    summary: buildCriticSummary(records),
    reports: records.map((r) => r.report),
    instances: buildCriticInstanceRollups(records),
    nonClaims: NON_CLAIMS,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderJson(report: CriticDryRunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function fmtDim(v: boolean | null): string {
  return v === null ? "null" : v ? "true" : "false";
}

export function renderMarkdown(report: CriticDryRunReport, records: readonly CriticRunRecord[]): string {
  const { summary, instances } = report;
  const lines: string[] = [];

  lines.push("# Stage 5 patch critic dry run over existing runs");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");
  lines.push(
    "_Report-only dry run of a DETERMINISTIC/mock critic over patches that already exist on disk. No agents, no " +
      "Docker, no model calls, NO repair (the sole subprocess is a local `python3 ast.parse`); no raw-artifact " +
      "mutation. The critic dimensions are warning signals, not correctness oracles._",
  );
  lines.push("");

  // --- Summary -------------------------------------------------------------
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `A deterministic critic consumed the milestone-2 probe outputs for ${summary.runsAnalyzed} passive-treatment runs ` +
      "(EDIT_GUARD + PATCH_VERIFY, before/after, across sympy / matplotlib / requests). It would have requested a " +
      `bounded repair on ${summary.repairRequiredCount} run(s): ${summary.highRiskCount} high-risk, ` +
      `${summary.mediumRiskCount} medium-risk. ${summary.lowRiskCount} run(s) were low-risk and ` +
      `${summary.unknownRiskCount} unknown-risk. The known target defect was likely caught in ` +
      `${summary.knownDefectLikelyCaughtCount} run(s). Scope stayed indeterminate from the diff in ` +
      `${summary.scopeUnknownCount} sympy run(s); ${summary.missingTestEvidenceCount} run(s) showed no named-test evidence.`,
  );
  lines.push("");
  lines.push("| metric | value |");
  lines.push("| --- | --- |");
  lines.push(`| runsAnalyzed | ${summary.runsAnalyzed} |`);
  lines.push(`| repairRequiredCount | ${summary.repairRequiredCount} |`);
  lines.push(`| highRiskCount | ${summary.highRiskCount} |`);
  lines.push(`| mediumRiskCount | ${summary.mediumRiskCount} |`);
  lines.push(`| lowRiskCount | ${summary.lowRiskCount} |`);
  lines.push(`| unknownRiskCount | ${summary.unknownRiskCount} |`);
  lines.push(`| scopeUnknownCount | ${summary.scopeUnknownCount} |`);
  lines.push(`| missingTestEvidenceCount | ${summary.missingTestEvidenceCount} |`);
  lines.push(`| knownDefectLikelyCaughtCount | ${summary.knownDefectLikelyCaughtCount} |`);
  lines.push("");

  // --- Method --------------------------------------------------------------
  lines.push("## Method");
  lines.push("");
  lines.push(
    "For each run we ran the deterministic milestone-2 probes over the first patch (`modelPatch`) plus the ordered " +
      "tool-call / stdout artifacts, then passed the resulting `PatchProbeSummary` — together with bounded run " +
      "metadata (treatment flags, ordered-tool-log presence) — into `buildDeterministicPatchCriticReport`. The critic " +
      "maps each probe status onto a structured dimension: a probe `pass` passes the dimension; `fail`/`warn` fails it " +
      "and (except for test evidence) becomes a repair signal; `unknown`/absent leaves the dimension `null` (NOT a " +
      "pass) and never forces repair on its own. A high-confidence fail (wrong scope, broad rewrite, syntax error) " +
      "forces `repair_required` at high confidence; medium signals (missing failing behavior, non-minimal patch) " +
      "request repair at medium confidence; unknown scope and weak test evidence are recorded but cannot force repair " +
      "alone. Every report was validated against the contract; all passed.",
  );
  lines.push("");

  // --- Contract ------------------------------------------------------------
  lines.push("## Critic input/output contract");
  lines.push("");
  lines.push(
    "**Input** (`PatchCriticInput`, bounded — no full repo, no gold patch, no hidden tests): `instanceId`, `runLabel`, " +
      "`repo`, optional `issueText`, `firstPatch` (unified diff), `editedFiles`, `patchChars`, `probeSummary` (the " +
      "deterministic probe output), `treatmentMetadata` (pivotCheck/editGuard/patchVerify injected), and " +
      "`contextSignals` (hidden-pivot engagement, ordered-tool-log presence).",
  );
  lines.push("");
  lines.push(
    "**Output** (`PatchCriticReport`): four dimensions each with `*_ok | null` + a non-empty `*_evidence` string " +
      "(`scope`, `failing_behavior`, `minimality`, `test_evidence`); an overall `risk` " +
      "(`low|medium|high|unknown`); a `repair_required` boolean with `repair_reason` + `repair_instructions`; a " +
      "`confidence` (`low|medium|high`); and `evidence_probe_ids` listing the probes consumed. Validation rules: " +
      "evidence strings must be non-empty; `null` is not a pass; high-confidence fail signals must set " +
      "`repair_required=true`; unknown scope or weak test evidence alone must not.",
  );
  lines.push("");

  // --- Results by run ------------------------------------------------------
  lines.push("## Results by run");
  lines.push("");
  lines.push(
    "| run | instance | scope_ok | failing_behavior | minimality_ok | test_evidence_ok | risk | confidence | repair |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const { report: r } of records) {
    lines.push(
      `| ${r.runLabel} | ${r.instanceId} | ${fmtDim(r.scope_ok)} | ${fmtDim(r.failing_behavior_handled)} | ` +
        `${fmtDim(r.minimality_ok)} | ${fmtDim(r.test_evidence_ok)} | ${r.risk} | ${r.confidence} | ` +
        `${r.repair_required ? "yes" : "no"} |`,
    );
  }
  lines.push("");
  for (const { report: r } of records) {
    lines.push(`### ${r.runLabel}`);
    lines.push("");
    lines.push(`- **Instance**: ${r.instanceId}; risk: ${r.risk}; confidence: ${r.confidence}.`);
    lines.push(`- **scope_ok**: ${fmtDim(r.scope_ok)} — ${r.scope_evidence}`);
    lines.push(`- **failing_behavior_handled**: ${fmtDim(r.failing_behavior_handled)} — ${r.failing_behavior_evidence}`);
    lines.push(`- **minimality_ok**: ${fmtDim(r.minimality_ok)} — ${r.minimality_evidence}`);
    lines.push(`- **test_evidence_ok**: ${fmtDim(r.test_evidence_ok)} — ${r.test_evidence}`);
    lines.push(`- **repair_required**: ${r.repair_required ? "yes" : "no"} — ${r.repair_reason}`);
    if (r.repair_required) lines.push(`- **repair_instructions**: ${r.repair_instructions}`);
    lines.push(`- **evidence probes**: ${r.evidence_probe_ids.join(", ")}.`);
    lines.push("");
  }

  // --- Results by instance -------------------------------------------------
  lines.push("## Results by instance");
  lines.push("");
  lines.push("| instance | known defect | target probe | runs | repair required | defect caught | scope unknown |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const inst of instances) {
    lines.push(
      `| ${inst.instanceId} | ${inst.knownDefect} | \`${inst.targetProbeId}\` | ${inst.runs} | ` +
        `${inst.repairRequiredRuns} | ${inst.knownDefectCaughtRuns} | ${inst.scopeUnknownRuns} |`,
    );
  }
  lines.push("");

  // --- Repair-required analysis --------------------------------------------
  lines.push("## Repair-required analysis");
  lines.push("");
  const repairRuns = records.filter((r) => r.report.repair_required);
  if (repairRuns.length === 0) {
    lines.push("The critic requested repair on no runs.");
  } else {
    lines.push(
      `The critic would request repair on ${repairRuns.length}/${summary.runsAnalyzed} run(s). Each request is backed ` +
        "by a concrete probe fail and carries actionable, patch-modifying instructions:",
    );
    lines.push("");
    for (const { report: r } of repairRuns) {
      lines.push(
        `- **${r.runLabel}** (${r.risk} risk, ${r.confidence} confidence): ${r.repair_reason} ` +
          `→ ${r.repair_instructions}`,
      );
    }
  }
  lines.push("");
  lines.push(
    "Strong (high-confidence) signals that force repair: wrong inserted-method scope, broad control-flow rewrite, and " +
      "inserted-block syntax errors. Medium signals that request repair: missing/partial failing-behavior handling and " +
      "non-minimal (control-flow-deleting) patches. Weak test evidence and unknown scope are recorded but never force " +
      "repair on their own.",
  );
  lines.push("");

  // --- Unknown / insufficient-signal cases ---------------------------------
  lines.push("## Unknown / insufficient-signal cases");
  lines.push("");
  const unknownRuns = records.filter(
    (r) =>
      scopeProbeStatus(r.probeSummary) === "unknown" ||
      r.report.risk === "unknown" ||
      (r.report.confidence === "low" && !r.report.repair_required),
  );
  if (unknownRuns.length === 0) {
    lines.push("No runs were left in an insufficient-signal state.");
  } else {
    lines.push(
      "These runs lack enough deterministic signal for the critic to act. They are reported honestly as `null` / " +
        "`unknown` rather than passed, and would need better probes (full-file reconstruction) or a live critic with " +
        "wider context to resolve:",
    );
    lines.push("");
    for (const { report: r, probeSummary } of unknownRuns) {
      const why =
        scopeProbeStatus(probeSummary) === "unknown"
          ? "inserted-method scope not visible in the diff window"
          : r.risk === "unknown"
            ? "overall risk indeterminate"
            : "low confidence with no actionable fail signal";
      lines.push(`- **${r.runLabel}** (${r.instanceId}): ${why}. ${r.scope_evidence}`);
    }
  }
  lines.push("");
  lines.push(
    "The sympy wrong-scope defect is the clearest gap: the deterministic `inserted_method_scope` probe can only see " +
      "the diff window, so when no `class` header is present it returns `unknown` and the critic correctly declines to " +
      "force a repair. Catching that defect reliably requires full-file reconstruction (apply the patch to a snapshot " +
      "and AST-resolve the enclosing class), not a cheap diff heuristic.",
  );
  lines.push("");

  // --- Probe limitations exposed -------------------------------------------
  lines.push("## Probe limitations exposed");
  lines.push("");
  lines.push(
    "- **Scope is diff-window-only.** The critic inherits `inserted_method_scope`'s blindness: it cannot judge landing " +
      "scope when the enclosing `class` header is off-screen, so the sympy defect stays `null` and uncaught.",
  );
  lines.push(
    "- **failing_behavior is a substring heuristic.** `failing_behavior_handled` is only as good as the per-instance " +
      "pattern list; textual matches can mask a behaviorally-incomplete patch.",
  );
  lines.push(
    "- **minimality is a size/control-flow heuristic.** A legitimately larger fix can read as a broad rewrite, and a " +
      "subtly-wrong tiny patch reads as minimal.",
  );
  lines.push(
    "- **test_evidence proves a command ran, not that it passed.** `test_evidence_ok` never asserts an outcome, which " +
      "is why it cannot force repair on its own.",
  );
  lines.push(
    "- **No first-vs-final ground truth.** This dry run cannot say a requested repair would have resolved the task; " +
      "only Docker can.",
  );
  lines.push("");

  // --- Recommended next step ----------------------------------------------
  lines.push("## Recommended next step");
  lines.push("");
  lines.push(recommendedNextStep(summary, instances));
  lines.push("");

  // --- Non-claims ----------------------------------------------------------
  lines.push("## Non-claims");
  lines.push("");
  for (const claim of report.nonClaims) lines.push(`- ${claim}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Loading (impure) — bounded run metadata beyond what loadRun returns.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(p, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readRepo(vtraceDir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(vtraceDir);
  } catch {
    return "";
  }
  const jsonl = entries.find((e) => e.startsWith("swebench-") && e.endsWith(".jsonl"));
  if (!jsonl) return "";
  try {
    const text = await readFile(path.join(vtraceDir, jsonl), "utf8");
    const firstLine = text.split("\n").find((l) => l.trim().length > 0);
    if (!firstLine) return "";
    const rec = JSON.parse(firstLine);
    return isRecord(rec) && typeof rec.repo === "string" ? rec.repo : "";
  } catch {
    return "";
  }
}

export interface RunMetaSignals {
  readonly treatmentMetadata: CriticTreatmentMetadata;
  readonly contextSignals: CriticContextSignals;
  readonly repo: string;
}

export async function loadRunMetaSignals(resultsDir: string, runLabel: string): Promise<RunMetaSignals> {
  const vtraceDir = path.join(resultsDir, "runs", runLabel, "raw", "vtrace");
  const [meta, repo] = await Promise.all([
    readJson(path.join(vtraceDir, "_run.meta.json")),
    readRepo(vtraceDir),
  ]);
  const m = meta ?? {};
  return {
    repo,
    treatmentMetadata: {
      pivotCheckInjected: asBool(m.vtracePivotCheckInjected),
      editGuardInjected: asBool(m.vtraceEditGuardInjected),
      patchVerifyInjected: asBool(m.vtracePatchVerifyInjected),
    },
    contextSignals: {
      hiddenPivotsInspected: asNum(m.vtraceHiddenPivotsInspected),
      hiddenPivotsEdited: asNum(m.vtraceHiddenPivotsEdited),
      orderedToolLogPresent: asBool(m.vtraceToolLogOrdered),
    },
  };
}

// Build a critic input from a probe summary + bounded run metadata. Pure given its arguments.
export function buildCriticInput(
  probeSummary: PatchProbeSummary,
  patch: string,
  signals: RunMetaSignals,
): PatchCriticInput {
  return {
    instanceId: probeSummary.instanceId,
    runLabel: probeSummary.runLabel,
    repo: signals.repo,
    issueText: null,
    firstPatch: patch,
    editedFiles: probeSummary.editedFiles,
    patchChars: probeSummary.patchChars,
    probeSummary,
    treatmentMetadata: signals.treatmentMetadata,
    contextSignals: signals.contextSignals,
  };
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

async function main(config: CliConfig): Promise<void> {
  const generatedAt = new Date().toISOString();
  const parsePython: PythonParser = makePythonParser();

  const records: CriticRunRecord[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
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
      toolCalls: loaded.toolCalls as RawToolCall[] | null,
      stdout: loaded.stdout,
      stderr: loaded.stderr,
      parsePython,
    });
    const signals = await loadRunMetaSignals(config.resultsDir, label);
    const input = buildCriticInput(probeSummary, loaded.patch, signals);
    const report = buildDeterministicPatchCriticReport(input);
    const violations = validatePatchCriticReport(report);
    if (violations.length > 0) invalid.push(`${label}: ${violations.join("; ")}`);
    records.push({ report, probeSummary, treatmentMetadata: signals.treatmentMetadata });
  }

  if (invalid.length > 0) {
    throw new Error(`Critic produced invalid report(s):\n  ${invalid.join("\n  ")}`);
  }

  const report = buildCriticDryRunReport(generatedAt, records);

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report, records));
  await writeFile(jsonPath, renderJson(report));

  const s = report.summary;
  process.stdout.write(
    [
      "Stage 5 patch critic dry-run report written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Runs analyzed: ${s.runsAnalyzed}${missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""}`,
      `Repair required: ${s.repairRequiredCount}   High risk: ${s.highRiskCount}   Scope unknown: ${s.scopeUnknownCount}   No test evidence: ${s.missingTestEvidenceCount}`,
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
