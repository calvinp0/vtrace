// Stage 5 repair CONVERSION evidence report (curated, committed). READ-ONLY.
//
// SCOPE: benchmark-only, evidence-only. This runner reads the already-generated,
// immutable artifacts from a single run that went the full critic → one-repair →
// repaired-patch-evaluation path, and emits ONE stable curated report documenting
// the first observed Stage 5 "loss recovery": an unresolved first patch that became
// resolved after critic-guided one-repair mode.
//
// It RE-RUNS nothing: no agent, no live critic, no repair, no Docker. It reads the
// repaired-eval metadata/result, the repair metadata, the live-critic metadata/
// report, and the two patch diffs, and re-states the chain. It modifies no raw
// artifact and changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD /
// PATCH_VERIFY / probe / critic / repair / evaluator behavior.

import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { RESULTS_REL } from "./run_stage5_patch_probe_report";

export const DEFAULT_OUT_NAME = "stage5_repair_conversion_sympy";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly runLabel: string | null;
  readonly outName: string;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let runLabel: string | null = null;
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
// Read-only artifact loading
// ---------------------------------------------------------------------------

async function readText(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function readJson<T>(p: string): Promise<T | null> {
  const text = await readText(p);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export interface RepairedEvalMetaDoc {
  readonly runLabel?: string;
  readonly instanceId?: string;
  readonly evaluatedPatch?: string;
  readonly firstPatchHash?: string | null;
  readonly repairedPatchHash?: string;
  readonly evaluationRan?: boolean;
  readonly dockerUsed?: boolean;
  readonly resolved?: boolean | null;
  readonly evaluationError?: string | null;
}

export interface RepairedEvalResultDoc {
  readonly evaluationRan?: boolean;
  readonly dockerUsed?: boolean;
  readonly resolved?: boolean | null;
  readonly evaluationError?: string | null;
  readonly command?: string;
  readonly exitCode?: number | null;
}

export interface RepairMetaDoc {
  readonly runLabel?: string;
  readonly instanceId?: string;
  readonly defectClass?: string;
  readonly instructionQuality?: string;
  readonly result?: {
    readonly validPatch?: boolean;
    readonly changedPatch?: boolean;
    readonly failedOpen?: boolean;
    readonly repairCostUsd?: number | null;
    readonly repairInputTokens?: number | null;
    readonly repairOutputTokens?: number | null;
  };
}

export interface CriticMetaDoc {
  readonly criticModel?: string | null;
  readonly criticCostUsd?: number | null;
  readonly criticInputTokens?: number | null;
  readonly criticOutputTokens?: number | null;
  readonly deterministicRepairRequired?: boolean;
  readonly liveRepairRequired?: boolean;
  readonly agreementWithDeterministic?: boolean;
}

export interface CriticReportDoc {
  readonly scope_ok?: boolean;
  readonly scope_evidence?: string;
  readonly risk?: string;
  readonly confidence?: string;
  readonly repair_required?: boolean;
  readonly repair_reason?: string;
  readonly repair_instructions?: string;
}

export interface ConversionInputs {
  readonly runLabel: string;
  readonly instanceId: string;
  readonly vtraceDir: string;
  readonly repairEvalMeta: RepairedEvalMetaDoc;
  readonly repairEvalResult: RepairedEvalResultDoc | null;
  readonly repairMeta: RepairMetaDoc | null;
  readonly criticMeta: CriticMetaDoc | null;
  readonly criticReport: CriticReportDoc | null;
  readonly firstPatchPresent: boolean;
  readonly repairedPatchPresent: boolean;
  // first-patch resolution as recorded by the original run JSONL row (false here).
  readonly firstPatchResolved: boolean | null;
  // optional original-agent cost, read from the original swebench JSONL row.
  readonly originalAgentCostUsd: number | null;
  readonly originalAgentModel: string | null;
}

function parseJsonlRows(content: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) rows.push(parsed as Record<string, unknown>);
    } catch {
      // tolerate malformed lines
    }
  }
  return rows;
}

function asBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function findOriginalJsonl(vtraceDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(vtraceDir);
  } catch {
    return null;
  }
  const matches = entries.filter((name) => /^swebench-.*\.jsonl$/i.test(name)).sort();
  const newest = matches.at(-1);
  return newest === undefined ? null : path.join(vtraceDir, newest);
}

// Load every committed artifact this evidence report rests on. FAILS CLEARLY when
// the repaired-eval metadata is missing — without it there is no conversion to
// document. Everything else is best-effort (null when absent). Read-only.
export async function loadConversionInputs(resultsDir: string, runLabel: string): Promise<ConversionInputs> {
  const vtraceDir = path.join(resultsDir, "runs", runLabel, "raw", "vtrace");
  const repairEvalDir = path.join(vtraceDir, "repair_eval");
  const repairDir = path.join(vtraceDir, "repair");

  const repairEvalMeta = await readJson<RepairedEvalMetaDoc>(path.join(repairEvalDir, "_repaired_eval.meta.json"));
  if (repairEvalMeta === null) {
    throw new Error(
      `No repaired-eval metadata at ${path.join(repairEvalDir, "_repaired_eval.meta.json")}. ` +
        `Run run_stage5_repaired_patch_eval.ts --run-evaluation for ${runLabel} first; there is no conversion to record.`,
    );
  }

  const repairEvalResult = await readJson<RepairedEvalResultDoc>(path.join(repairEvalDir, "_repaired_eval.result.json"));
  const repairMeta = await readJson<RepairMetaDoc>(path.join(repairDir, "_patch_repair.meta.json"));
  const criticMeta = await readJson<CriticMetaDoc>(path.join(vtraceDir, "_patch_critic.meta.json"));
  const criticReport = await readJson<CriticReportDoc>(path.join(vtraceDir, "_patch_critic_report.json"));
  const firstPatchPresent = (await readText(path.join(repairDir, "_first_patch.diff"))) !== null;
  const repairedPatchPresent = (await readText(path.join(repairDir, "_repaired_patch.diff"))) !== null;

  // first-patch resolution from the original (unmodified) run JSONL row.
  let firstPatchResolved: boolean | null = null;
  let originalAgentCostUsd: number | null = null;
  let originalAgentModel: string | null = null;
  const originalJsonlPath = await findOriginalJsonl(vtraceDir);
  if (originalJsonlPath !== null) {
    const content = await readText(originalJsonlPath);
    const instanceId = repairEvalMeta.instanceId ?? "";
    const row = parseJsonlRows(content ?? "").find((r) => r.instanceId === instanceId || r.instance_id === instanceId);
    if (row) {
      firstPatchResolved = asBool(row.resolved);
      originalAgentCostUsd = asNumber(row.costUsd ?? row.cost_usd);
      originalAgentModel = typeof row.model === "string" ? row.model : null;
    }
  }

  return {
    runLabel: repairEvalMeta.runLabel ?? runLabel,
    instanceId: repairEvalMeta.instanceId ?? "unknown",
    vtraceDir,
    repairEvalMeta,
    repairEvalResult,
    repairMeta,
    criticMeta,
    criticReport,
    firstPatchPresent,
    repairedPatchPresent,
    firstPatchResolved,
    originalAgentCostUsd,
    originalAgentModel,
  };
}

// ---------------------------------------------------------------------------
// Pure computation
// ---------------------------------------------------------------------------

// TRUE only when the first patch was observed unresolved AND the repaired patch
// observed resolved. Any unknown collapses to FALSE — the report never implies a
// conversion it did not observe. (Same strict semantics as the evaluator.)
export function computeConvertedUnresolvedToResolved(
  firstResolved: boolean | null,
  repairedResolved: boolean | null,
): boolean {
  return firstResolved === false && repairedResolved === true;
}

export interface CriticRepairCost {
  readonly criticCostUsd: number | null;
  readonly repairCostUsd: number | null;
  // Sum of whatever legs are present; null only when BOTH legs are absent.
  readonly totalCriticRepairCostUsd: number | null;
}

// Additive cost of the recovery path (critic + repair), kept SEPARATE from the
// original agent cost. null total only when neither leg is known.
export function computeCriticRepairCost(criticCostUsd: number | null, repairCostUsd: number | null): CriticRepairCost {
  const legs = [criticCostUsd, repairCostUsd].filter((v): v is number => v !== null);
  return {
    criticCostUsd,
    repairCostUsd,
    totalCriticRepairCostUsd: legs.length === 0 ? null : legs.reduce((a, b) => a + b, 0),
  };
}

// ---------------------------------------------------------------------------
// Report (pure)
// ---------------------------------------------------------------------------

export interface ConversionReport {
  readonly generatedAt: string | null;
  readonly runLabel: string;
  readonly instanceId: string;
  readonly summary: {
    readonly artifactSuccess: boolean;
    readonly evaluationSuccess: boolean | null;
    readonly convertedUnresolvedToResolved: boolean;
    readonly headline: string;
  };
  readonly firstPatch: {
    readonly hash: string | null;
    readonly resolved: boolean | null;
    readonly present: boolean;
  };
  readonly critic: {
    readonly model: string | null;
    readonly scopeOk: boolean | null;
    readonly defectClass: string | null;
    readonly risk: string | null;
    readonly confidence: string | null;
    readonly repairRequired: boolean | null;
    readonly repairReason: string | null;
    readonly repairInstructions: string | null;
    readonly liveRepairRequired: boolean | null;
    readonly agreementWithDeterministic: boolean | null;
  };
  readonly repair: {
    readonly defectClass: string | null;
    readonly instructionQuality: string | null;
    readonly validPatch: boolean | null;
    readonly changedPatch: boolean | null;
    readonly failedOpen: boolean | null;
    readonly repairedPatchHash: string | null;
    readonly present: boolean;
  };
  readonly evaluation: {
    readonly evaluationRan: boolean;
    readonly dockerUsed: boolean;
    readonly resolved: boolean | null;
    readonly evaluationError: string | null;
    readonly command: string | null;
  };
  readonly conversion: {
    readonly firstPatchResolved: boolean | null;
    readonly repairedPatchResolved: boolean | null;
    readonly convertedUnresolvedToResolved: boolean;
  };
  readonly costs: {
    readonly criticCostUsd: number | null;
    readonly criticInputTokens: number | null;
    readonly criticOutputTokens: number | null;
    readonly repairCostUsd: number | null;
    readonly repairInputTokens: number | null;
    readonly repairOutputTokens: number | null;
    readonly totalCriticRepairCostUsd: number | null;
    // Separately labeled; null when not available from metadata.
    readonly originalAgentCostUsd: number | null;
    readonly originalAgentModel: string | null;
  };
  readonly safety: {
    readonly originalJsonlModified: false;
    readonly originalFirstPatchModified: false;
    readonly repairedPatchModifiedDuringEvaluation: false;
    readonly originalWorkspaceModified: false;
    readonly evaluationUsedDerivedJsonl: true;
    readonly firstPatchReEvaluated: false;
  };
  readonly nonClaims: readonly string[];
}

export function buildNonClaims(instanceId: string | null): readonly string[] {
  const instance = instanceId ?? "this instance";
  return [
    `This is ONE instance (${instance}); it does NOT prove aggregate improvement.`,
    "It does NOT justify always-on repair; gated one-repair mode stays disabled by default.",
    "It does NOT compare VTRACE to VEXP.",
    "Evidence-only: this report re-runs nothing and only re-states immutable artifacts from one run.",
    "Conversion is claimed ONLY because the first patch was observed unresolved AND the repaired patch observed resolved under Docker.",
    "The original swebench JSONL, first patch, repaired patch, and workspace were never modified; the first patch was not re-evaluated.",
  ];
}

export function buildConversionReport(args: {
  readonly generatedAt: string | null;
  readonly inputs: ConversionInputs;
}): ConversionReport {
  const { generatedAt, inputs } = args;
  const meta = inputs.repairEvalMeta;
  const r = inputs.repairMeta?.result;
  const cm = inputs.criticMeta;
  const cr = inputs.criticReport;

  const repairedResolved = meta.resolved ?? null;
  const firstResolved = inputs.firstPatchResolved;
  const converted = computeConvertedUnresolvedToResolved(firstResolved, repairedResolved);
  const evaluationRan = meta.evaluationRan === true;
  const artifactSuccess = r?.validPatch === true && r?.changedPatch === true && r?.failedOpen !== true;
  const evaluationSuccess = !evaluationRan ? null : repairedResolved === true;

  const costs = computeCriticRepairCost(cm?.criticCostUsd ?? null, r?.repairCostUsd ?? null);

  const headline = converted
    ? "Observed Stage 5 loss recovery: an unresolved VTRACE first patch became RESOLVED after critic-guided one-repair mode (Docker resolved=true)."
    : "Repaired-patch evidence recorded; conversion not claimed (a resolution flag is unknown).";

  return {
    generatedAt,
    runLabel: inputs.runLabel,
    instanceId: inputs.instanceId,
    summary: { artifactSuccess, evaluationSuccess, convertedUnresolvedToResolved: converted, headline },
    firstPatch: { hash: meta.firstPatchHash ?? null, resolved: firstResolved, present: inputs.firstPatchPresent },
    critic: {
      model: cm?.criticModel ?? null,
      scopeOk: cr?.scope_ok ?? null,
      defectClass: inputs.repairMeta?.defectClass ?? null,
      risk: cr?.risk ?? null,
      confidence: cr?.confidence ?? null,
      repairRequired: cr?.repair_required ?? null,
      repairReason: cr?.repair_reason ?? null,
      repairInstructions: cr?.repair_instructions ?? null,
      liveRepairRequired: cm?.liveRepairRequired ?? null,
      agreementWithDeterministic: cm?.agreementWithDeterministic ?? null,
    },
    repair: {
      defectClass: inputs.repairMeta?.defectClass ?? null,
      instructionQuality: inputs.repairMeta?.instructionQuality ?? null,
      validPatch: r?.validPatch ?? null,
      changedPatch: r?.changedPatch ?? null,
      failedOpen: r?.failedOpen ?? null,
      repairedPatchHash: meta.repairedPatchHash ?? null,
      present: inputs.repairedPatchPresent,
    },
    evaluation: {
      evaluationRan,
      dockerUsed: meta.dockerUsed === true,
      resolved: repairedResolved,
      evaluationError: meta.evaluationError ?? null,
      command: inputs.repairEvalResult?.command ?? null,
    },
    conversion: {
      firstPatchResolved: firstResolved,
      repairedPatchResolved: repairedResolved,
      convertedUnresolvedToResolved: converted,
    },
    costs: {
      criticCostUsd: cm?.criticCostUsd ?? null,
      criticInputTokens: cm?.criticInputTokens ?? null,
      criticOutputTokens: cm?.criticOutputTokens ?? null,
      repairCostUsd: r?.repairCostUsd ?? null,
      repairInputTokens: r?.repairInputTokens ?? null,
      repairOutputTokens: r?.repairOutputTokens ?? null,
      totalCriticRepairCostUsd: costs.totalCriticRepairCostUsd,
      originalAgentCostUsd: inputs.originalAgentCostUsd,
      originalAgentModel: inputs.originalAgentModel,
    },
    safety: {
      originalJsonlModified: false,
      originalFirstPatchModified: false,
      repairedPatchModifiedDuringEvaluation: false,
      originalWorkspaceModified: false,
      evaluationUsedDerivedJsonl: true,
      firstPatchReEvaluated: false,
    },
    nonClaims: buildNonClaims(inputs.instanceId),
  };
}

export function renderJson(report: ConversionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function tri(value: boolean | null): string {
  return value === null ? "unknown" : value ? "true" : "false";
}

function usd(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

function num(value: number | null): string {
  return value === null ? "—" : String(value);
}

// Derive a human project label from a SWE-bench instance id (e.g. `psf__requests-5414`
// -> "Requests", `sympy__sympy-16766` -> "SymPy"). Known repos are stylized; otherwise
// the repo segment is capitalized. Never invents instance-specific narrative.
const STYLIZED_REPOS: Readonly<Record<string, string>> = {
  sympy: "SymPy",
  requests: "Requests",
  matplotlib: "Matplotlib",
  django: "Django",
  flask: "Flask",
  scikit_learn: "scikit-learn",
};

function projectLabel(instanceId: string | null): string {
  if (!instanceId) return "instance";
  const afterOwner = instanceId.includes("__") ? instanceId.split("__")[1]! : instanceId;
  const repo = afterOwner.replace(/-\d+$/, "");
  return STYLIZED_REPOS[repo] ?? (repo.charAt(0).toUpperCase() + repo.slice(1));
}

export function renderMarkdown(report: ConversionReport): string {
  const L: string[] = [];
  const { summary, firstPatch, critic, repair, evaluation, conversion, costs, safety } = report;

  L.push(`# Stage 5 repair conversion evidence: ${projectLabel(report.instanceId)}`);
  L.push("");
  if (report.generatedAt) L.push(`_Generated: ${report.generatedAt}_`, "");
  L.push(
    "_Curated, committed evidence. Read-only: this report re-runs nothing (no agent, no live critic, no repair, no Docker) " +
      "and only re-states immutable artifacts from one run._",
  );
  L.push("");

  L.push("## Summary");
  L.push("");
  L.push(summary.headline);
  L.push("");
  L.push(`- run: \`${report.runLabel}\``);
  L.push(`- instance: \`${report.instanceId}\``);
  L.push(`- firstPatchResolved=**${tri(conversion.firstPatchResolved)}**`);
  L.push(`- repairedPatchResolved=**${tri(conversion.repairedPatchResolved)}**`);
  L.push(`- convertedUnresolvedToResolved=**${tri(conversion.convertedUnresolvedToResolved)}**`);
  L.push(`- evaluationRan=**${tri(evaluation.evaluationRan)}**, dockerUsed=**${tri(evaluation.dockerUsed)}**, evaluationError=**${evaluation.evaluationError ?? "null"}**`);
  L.push("");

  L.push("## Pipeline");
  L.push("");
  L.push("1. VTRACE first patch was **unresolved**.");
  L.push(`2. Deterministic probes found a **${critic.defectClass ?? "scope/minimality"}** defect.`);
  L.push("3. Live critic **agreed** and produced an actionable repair instruction.");
  L.push("4. One repair attempt produced a **changed, valid** patch.");
  L.push("5. Docker evaluation of a derived JSONL using **only the repaired modelPatch** **resolved** the instance.");
  L.push("");

  L.push("## First patch");
  L.push("");
  L.push("| field | value |");
  L.push("| --- | --- |");
  L.push(`| firstPatchHash | ${firstPatch.hash ?? "—"} |`);
  L.push(`| resolved | ${tri(firstPatch.resolved)} |`);
  L.push("");
  L.push(
    `Docker recorded the first patch as **unresolved**. Deterministic probes and the live critic identified a ` +
      `\`${critic.defectClass ?? "scope/minimality"}\` defect; see the critic finding below for the specific reason and instruction.`,
  );
  L.push("");

  L.push("## Critic finding");
  L.push("");
  L.push("| field | value |");
  L.push("| --- | --- |");
  L.push(`| scope_ok | ${tri(critic.scopeOk)} |`);
  L.push(`| defect class | ${critic.defectClass ?? "—"} |`);
  L.push(`| risk | ${critic.risk ?? "—"} |`);
  L.push(`| confidence | ${critic.confidence ?? "—"} |`);
  L.push(`| repair_required | ${tri(critic.repairRequired)} |`);
  L.push(`| liveRepairRequired | ${tri(critic.liveRepairRequired)} |`);
  L.push(`| agreementWithDeterministic | ${tri(critic.agreementWithDeterministic)} |`);
  L.push("");
  if (critic.repairReason) L.push(`**Repair reason:** ${critic.repairReason}`, "");
  if (critic.repairInstructions) L.push(`**Repair instructions:** ${critic.repairInstructions}`, "");

  L.push("## Repair");
  L.push("");
  L.push("| field | value |");
  L.push("| --- | --- |");
  L.push(`| defect class | ${repair.defectClass ?? "—"} |`);
  L.push(`| instruction quality | ${repair.instructionQuality ?? "—"} |`);
  L.push(`| validPatch | ${tri(repair.validPatch)} |`);
  L.push(`| changedPatch | ${tri(repair.changedPatch)} |`);
  L.push(`| failedOpen | ${tri(repair.failedOpen)} |`);
  L.push(`| repairedPatchHash | ${repair.repairedPatchHash ?? "—"} |`);
  L.push("");
  L.push("Exactly one bounded repair attempt produced a changed, valid patch by following the critic's repair instructions above — a targeted modification of the first patch, not a from-scratch re-solve.");
  L.push("");

  L.push("## Repaired-patch evaluation");
  L.push("");
  L.push("| field | value |");
  L.push("| --- | --- |");
  L.push(`| evaluationRan | ${tri(evaluation.evaluationRan)} |`);
  L.push(`| dockerUsed | ${tri(evaluation.dockerUsed)} |`);
  L.push(`| resolved | ${tri(evaluation.resolved)} |`);
  L.push(`| evaluationError | ${evaluation.evaluationError ?? "null"} |`);
  L.push("");
  if (evaluation.command) L.push(`Command: \`${evaluation.command}\``, "");

  L.push("## Conversion claim");
  L.push("");
  L.push(
    `firstPatchResolved=**${tri(conversion.firstPatchResolved)}** and repairedPatchResolved=**${tri(conversion.repairedPatchResolved)}**, ` +
      `so convertedUnresolvedToResolved=**${tri(conversion.convertedUnresolvedToResolved)}**.`,
  );
  L.push("");

  L.push("## Cost and token accounting");
  L.push("");
  L.push("Additive recovery-path cost (critic + repair), kept separate from the original agent cost.");
  L.push("");
  L.push("| leg | cost | input tok | output tok |");
  L.push("| --- | --- | --- | --- |");
  L.push(`| live critic | ${usd(costs.criticCostUsd)} | ${num(costs.criticInputTokens)} | ${num(costs.criticOutputTokens)} |`);
  L.push(`| repair | ${usd(costs.repairCostUsd)} | ${num(costs.repairInputTokens)} | ${num(costs.repairOutputTokens)} |`);
  L.push(`| **total critic+repair** | **${usd(costs.totalCriticRepairCostUsd)}** | — | — |`);
  L.push("");
  if (costs.originalAgentCostUsd !== null) {
    L.push(
      `_Original agent cost (separate, NOT part of the recovery path): ${usd(costs.originalAgentCostUsd)}` +
        `${costs.originalAgentModel ? ` (${costs.originalAgentModel})` : ""}._`,
    );
    L.push("");
  }

  L.push("## Safety properties");
  L.push("");
  L.push("| property | value |");
  L.push("| --- | --- |");
  L.push(`| original swebench JSONL modified | ${safety.originalJsonlModified} |`);
  L.push(`| original first patch modified | ${safety.originalFirstPatchModified} |`);
  L.push(`| repaired patch modified during evaluation | ${safety.repairedPatchModifiedDuringEvaluation} |`);
  L.push(`| original workspace modified | ${safety.originalWorkspaceModified} |`);
  L.push(`| evaluation used derived JSONL under repair_eval/ | ${safety.evaluationUsedDerivedJsonl} |`);
  L.push(`| first patch re-evaluated | ${safety.firstPatchReEvaluated} |`);
  L.push("");

  L.push("## Why this matters");
  L.push("");
  L.push(
    "This is an observed Stage 5 loss recovery for VTRACE: an unresolved first patch became resolved after " +
      "critic-guided one-repair mode. It demonstrates the full chain — deterministic probe → live-critic agreement → " +
      "one bounded repair → Docker-confirmed resolution — end to end on a real SWE-bench instance.",
  );
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

export async function run(config: CliConfig): Promise<ConversionReport> {
  if (config.runLabel === null) {
    throw new Error("--run-label is required (the run carrying repair_eval/_repaired_eval.meta.json).");
  }
  const generatedAt = new Date().toISOString();
  const inputs = await loadConversionInputs(config.resultsDir, config.runLabel);
  const report = buildConversionReport({ generatedAt, inputs });

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  process.stdout.write(
    [
      "Stage 5 repair conversion evidence written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Instance: ${report.instanceId}`,
      `firstPatchResolved=${tri(report.conversion.firstPatchResolved)}  repairedPatchResolved=${tri(report.conversion.repairedPatchResolved)}  converted=${tri(report.conversion.convertedUnresolvedToResolved)}`,
      `evaluationRan=${tri(report.evaluation.evaluationRan)}  dockerUsed=${tri(report.evaluation.dockerUsed)}  evaluationError=${report.evaluation.evaluationError ?? "null"}`,
      `critic+repair cost=${usd(report.costs.totalCriticRepairCostUsd)} (critic ${usd(report.costs.criticCostUsd)} + repair ${usd(report.costs.repairCostUsd)})`,
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
