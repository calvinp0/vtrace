// Stage 5 live critic high-risk comparison (reporting/analysis only).
//
// SCOPE: this runner READS the artifacts the six gated live-critic observation calls already wrote
// and emits a formal comparison report (Markdown + JSON) across all six. It runs NO live critic,
// NO agents, NO Docker; it implements NO repair and modifies NO patch, workspace, or raw artifact.
// The only files it writes are the two comparison report files named by --out-name.
//
// Per-run inputs (all read-only, all fail-soft to null if absent):
//   results/runs/<runLabel>/raw/vtrace/_patch_critic.meta.json     (live critic meta)
//   results/runs/<runLabel>/raw/vtrace/_patch_critic_report.json   (live critic structured report)
//   results/runs/<runLabel>/raw/vtrace/_patch_critic_input.json    (bounded critic input + probe summary)
//   results/runs/<runLabel>/raw/vtrace/_first_patch.diff           (the patch — to confirm it was untouched)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { PatchCriticReport } from "./stage5_patch_critic";
import type { LiveCriticMeta } from "./stage5_patch_critic_live";
import { RESULTS_REL } from "./run_stage5_patch_probe_report";

// The six runs that actually have live critic artifacts (one smoke + five remaining high-risk).
export const CRITIC_RUN_LABELS: readonly string[] = [
  "eval-patchverify-before-sympy-16766",
  "eval-editguard-before-matplotlib-22719",
  "eval-patchverify-after-matplotlib-22719",
  "eval-editguard-before-requests-5414",
  "eval-editguard-after-requests-5414",
  "eval-patchverify-before-requests-5414",
];

export type DefectClass = "wrong_scope" | "missing_failing_behavior" | "broad_rewrite_minimality" | "unknown";

export const DEFECT_CLASSES: readonly DefectClass[] = [
  "wrong_scope",
  "missing_failing_behavior",
  "broad_rewrite_minimality",
];

export function defectClassFor(instanceId: string): DefectClass {
  if (instanceId.startsWith("sympy__")) return "wrong_scope";
  if (instanceId.startsWith("matplotlib__")) return "missing_failing_behavior";
  if (instanceId.startsWith("psf__requests")) return "broad_rewrite_minimality";
  return "unknown";
}

export type InstructionQuality = "none" | "generic" | "concrete" | "actionable";

// Classify a live repair instruction. "none" when no repair was requested or the field is empty;
// "actionable" when it names specific code AND a concrete edit action AND is detailed; "concrete"
// when it has one of those; "generic" otherwise.
export function classifyInstruction(repairRequired: boolean | null, instructions: string): InstructionQuality {
  if (repairRequired !== true || instructions.trim() === "") return "none";
  const hasAction =
    /\b(relocate|move|restore|add|replace|keep|extend|re-?indent|insert|wrap|guard|modify|limit|preserv)\w*/i.test(
      instructions,
    );
  const hasIdentifier =
    /`[^`]+`/.test(instructions) ||
    /[A-Za-z_]+\.[A-Za-z_]+/.test(instructions) ||
    /[a-z]+_[a-z]+/.test(instructions) ||
    /[A-Z][a-z]+[A-Z][A-Za-z]+/.test(instructions);
  const detailed = instructions.length >= 80;
  if (hasAction && hasIdentifier && detailed) return "actionable";
  if (hasAction || hasIdentifier) return "concrete";
  return "generic";
}

function addedValueSummary(defectClass: DefectClass, agreement: boolean | null, repairRequired: boolean | null): string {
  switch (defectClass) {
    case "wrong_scope":
      return "Recognized the wrong-scope insertion the deterministic probe flagged and added a concrete move/re-indent repair instruction; interpretive value plus an actionable bounded fix.";
    case "broad_rewrite_minimality":
      return "Explained the concrete regression risk behind the minimality fail (removing the unicode_is_ascii gate forces all ASCII hosts through IDNA encoding) and gave concrete restore-and-narrow-guard repair instructions.";
    case "missing_failing_behavior":
      return agreement === false && repairRequired === false
        ? "Recognized a semantically-equivalent truthiness guard (`values.size`) that the literal failing_behavior_pattern probe missed, judged the failing behavior handled, and declined repair — contradicting the deterministic critic. The correction is plausible but unverified without executable reproduction."
        : "Live judgment on the missing-failing-behavior class; correctness unverified without executable reproduction.";
    default:
      return "No defect-class-specific added-value characterization available.";
  }
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
  let outName = "stage5_live_critic_high_risk_comparison";
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
// Read-only, fail-soft loaders
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
  readonly firstPatch?: string;
}

// A single run's raw live-critic artifacts (any of which may be absent).
export interface RunRecord {
  readonly runLabel: string;
  readonly meta: LiveCriticMeta | null;
  readonly report: PatchCriticReport | null;
  readonly firstPatch: string | null; // from the critic input doc
  readonly firstPatchDiff: string | null; // from _first_patch.diff
}

export async function loadRunRecord(resultsDir: string, runLabel: string): Promise<RunRecord> {
  const dir = path.join(resultsDir, "runs", runLabel, "raw", "vtrace");
  const [meta, report, input, firstPatchDiff] = await Promise.all([
    readJson<LiveCriticMeta>(path.join(dir, "_patch_critic.meta.json")),
    readJson<PatchCriticReport>(path.join(dir, "_patch_critic_report.json")),
    readJson<CriticInputDoc>(path.join(dir, "_patch_critic_input.json")),
    readText(path.join(dir, "_first_patch.diff")),
  ]);
  return { runLabel, meta, report, firstPatch: input?.firstPatch ?? null, firstPatchDiff };
}

export async function loadAllRunRecords(resultsDir: string, labels: readonly string[]): Promise<RunRecord[]> {
  return Promise.all(labels.map((l) => loadRunRecord(resultsDir, l)));
}

// ---------------------------------------------------------------------------
// Comparison model (pure)
// ---------------------------------------------------------------------------

export type RunStatus = "ok" | "skipped-missing-artifacts" | "invalid-live-report";

export interface RunComparison {
  readonly runLabel: string;
  readonly instanceId: string;
  readonly defectClass: DefectClass;
  readonly status: RunStatus;
  readonly deterministicRepairRequired: boolean | null;
  readonly liveRepairRequired: boolean | null;
  readonly agreementWithDeterministic: boolean | null;
  readonly liveRisk: string | null;
  readonly liveConfidence: string | null;
  readonly criticCostUsd: number | null;
  readonly criticInputTokens: number | null;
  readonly criticOutputTokens: number | null;
  readonly failedOpen: boolean | null;
  readonly validReport: boolean | null;
  readonly repairReason: string | null;
  readonly repairInstructions: string | null;
  readonly addedValueSummary: string;
  readonly instructionQuality: InstructionQuality;
  readonly patchUnchanged: boolean | null;
}

function normalizePatch(s: string): string {
  return s.replace(/\r\n/g, "\n").trim();
}

export function buildRunComparison(rec: RunRecord): RunComparison {
  const { meta, report } = rec;
  const instanceId = report?.instanceId ?? "unknown";
  const defectClass = defectClassFor(instanceId);
  const status: RunStatus =
    meta === null || report === null
      ? "skipped-missing-artifacts"
      : meta.validReport === false
        ? "invalid-live-report"
        : "ok";
  const liveRepairRequired = meta?.liveRepairRequired ?? report?.repair_required ?? null;
  const repairInstructions = report?.repair_instructions ?? "";
  const patchUnchanged =
    rec.firstPatch !== null && rec.firstPatchDiff !== null
      ? normalizePatch(rec.firstPatch) === normalizePatch(rec.firstPatchDiff)
      : null;
  return {
    runLabel: rec.runLabel,
    instanceId,
    defectClass,
    status,
    deterministicRepairRequired: meta?.deterministicRepairRequired ?? null,
    liveRepairRequired,
    agreementWithDeterministic: meta?.agreementWithDeterministic ?? null,
    liveRisk: report?.risk ?? null,
    liveConfidence: report?.confidence ?? null,
    criticCostUsd: meta?.criticCostUsd ?? null,
    criticInputTokens: meta?.criticInputTokens ?? null,
    criticOutputTokens: meta?.criticOutputTokens ?? null,
    failedOpen: meta?.failedOpen ?? null,
    validReport: meta?.validReport ?? null,
    repairReason: report?.repair_reason ?? null,
    repairInstructions,
    addedValueSummary: addedValueSummary(defectClass, meta?.agreementWithDeterministic ?? null, liveRepairRequired),
    instructionQuality: classifyInstruction(liveRepairRequired, repairInstructions),
    patchUnchanged,
  };
}

export interface ClassRollup {
  readonly total: number;
  readonly agree: number;
  readonly disagree: number;
  readonly agreementRate: number | null;
}

export interface ClassRepairRollup {
  readonly total: number;
  readonly liveRepairRequired: number;
  readonly deterministicRepairRequired: number;
}

export interface Summary {
  readonly runsAnalyzed: number;
  readonly validReportCount: number;
  readonly failedOpenCount: number;
  readonly agreementCount: number;
  readonly disagreementCount: number;
  readonly liveRepairRequiredCount: number;
  readonly deterministicRepairRequiredCount: number;
  readonly totalCostUsd: number;
  readonly meanCostUsd: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly agreementByDefectClass: Record<DefectClass, ClassRollup>;
  readonly liveRepairRequiredByDefectClass: Record<DefectClass, ClassRepairRollup>;
}

function emptyClassMap<T>(make: () => T): Record<DefectClass, T> {
  return {
    wrong_scope: make(),
    missing_failing_behavior: make(),
    broad_rewrite_minimality: make(),
    unknown: make(),
  };
}

export function buildSummary(runs: readonly RunComparison[]): Summary {
  const analyzed = runs.filter((r) => r.status !== "skipped-missing-artifacts");
  const runsAnalyzed = analyzed.length;
  const validReportCount = analyzed.filter((r) => r.validReport === true).length;
  const failedOpenCount = analyzed.filter((r) => r.failedOpen === true).length;
  const agreementCount = analyzed.filter((r) => r.agreementWithDeterministic === true).length;
  const disagreementCount = analyzed.filter((r) => r.agreementWithDeterministic === false).length;
  const liveRepairRequiredCount = analyzed.filter((r) => r.liveRepairRequired === true).length;
  const deterministicRepairRequiredCount = analyzed.filter((r) => r.deterministicRepairRequired === true).length;
  const totalCostUsd = analyzed.reduce((a, r) => a + (r.criticCostUsd ?? 0), 0);
  const totalInputTokens = analyzed.reduce((a, r) => a + (r.criticInputTokens ?? 0), 0);
  const totalOutputTokens = analyzed.reduce((a, r) => a + (r.criticOutputTokens ?? 0), 0);

  const agreementByDefectClass = emptyClassMap<ClassRollup>(() => ({ total: 0, agree: 0, disagree: 0, agreementRate: null }));
  const liveRepairRequiredByDefectClass = emptyClassMap<ClassRepairRollup>(() => ({
    total: 0,
    liveRepairRequired: 0,
    deterministicRepairRequired: 0,
  }));

  for (const r of analyzed) {
    const a = agreementByDefectClass[r.defectClass];
    const newAgree = a.agree + (r.agreementWithDeterministic === true ? 1 : 0);
    const newDisagree = a.disagree + (r.agreementWithDeterministic === false ? 1 : 0);
    const newTotal = a.total + 1;
    agreementByDefectClass[r.defectClass] = {
      total: newTotal,
      agree: newAgree,
      disagree: newDisagree,
      agreementRate: newTotal > 0 ? newAgree / newTotal : null,
    };
    const rep = liveRepairRequiredByDefectClass[r.defectClass];
    liveRepairRequiredByDefectClass[r.defectClass] = {
      total: rep.total + 1,
      liveRepairRequired: rep.liveRepairRequired + (r.liveRepairRequired === true ? 1 : 0),
      deterministicRepairRequired: rep.deterministicRepairRequired + (r.deterministicRepairRequired === true ? 1 : 0),
    };
  }

  return {
    runsAnalyzed,
    validReportCount,
    failedOpenCount,
    agreementCount,
    disagreementCount,
    liveRepairRequiredCount,
    deterministicRepairRequiredCount,
    totalCostUsd,
    meanCostUsd: runsAnalyzed > 0 ? totalCostUsd / runsAnalyzed : 0,
    totalInputTokens,
    totalOutputTokens,
    agreementByDefectClass,
    liveRepairRequiredByDefectClass,
  };
}

export interface DefectClassReport {
  readonly defectClass: DefectClass;
  readonly instanceIds: readonly string[];
  readonly runs: number;
  readonly deterministicRepairRequired: number;
  readonly liveRepairRequired: number;
  readonly agree: number;
  readonly disagree: number;
  readonly deterministicKnew: string;
  readonly liveAdded: string;
  readonly justifiesCost: "yes" | "no" | "uncertain";
  readonly note: string;
}

const CLASS_NARRATIVE: Record<
  Exclude<DefectClass, "unknown">,
  { deterministicKnew: string; liveAdded: string; justifiesCost: "yes" | "no" | "uncertain"; note: string }
> = {
  wrong_scope: {
    deterministicKnew:
      "inserted_method_scope probe FAILED (high): _print_Indexed landed in AbstractPythonCodePrinter, not PythonCodePrinter; repair required.",
    liveAdded:
      "Human-readable synthesis plus a concrete move/re-indent repair instruction (relocate the method, preserving implementation/indentation).",
    justifiesCost: "yes",
    note: "Both critics agreed; live critic's instruction is actionable.",
  },
  broad_rewrite_minimality: {
    deterministicKnew:
      "minimality_rewrite_risk probe FAILED (high): broad control-flow rewrite (deletions / deleted control-flow lines); repair required.",
    liveAdded:
      "Concrete regression-risk explanation (removing the unicode_is_ascii gate routes all ASCII hosts through IDNA, risking rejection of previously-valid hosts) plus concrete restore-and-narrow-guard repair instructions.",
    justifiesCost: "yes",
    note: "All three requests runs agreed; live critic instructions are actionable.",
  },
  missing_failing_behavior: {
    deterministicKnew:
      "failing_behavior_pattern probe FAILED (medium): none of the literal tokens [values.size == 0, return, empty] matched the added code; deterministic critic requested repair.",
    liveAdded:
      "Recognized a semantically-equivalent truthiness guard (`values.size`) the literal probe missed, judged the failing behavior handled, and DECLINED repair — contradicting the deterministic critic.",
    justifiesCost: "uncertain",
    note:
      "The disagreement points to the deterministic probe being over-conservative (string matching), not obviously to the live critic under-calling. But the live critic's 'handled' verdict is unverified without executable reproduction; treat this class as undecided.",
  },
};

export function buildDefectClassReports(runs: readonly RunComparison[]): DefectClassReport[] {
  const out: DefectClassReport[] = [];
  for (const dc of DEFECT_CLASSES) {
    const members = runs.filter((r) => r.defectClass === dc && r.status !== "skipped-missing-artifacts");
    if (members.length === 0) continue;
    const narrative = CLASS_NARRATIVE[dc as Exclude<DefectClass, "unknown">];
    out.push({
      defectClass: dc,
      instanceIds: Array.from(new Set(members.map((r) => r.instanceId))),
      runs: members.length,
      deterministicRepairRequired: members.filter((r) => r.deterministicRepairRequired === true).length,
      liveRepairRequired: members.filter((r) => r.liveRepairRequired === true).length,
      agree: members.filter((r) => r.agreementWithDeterministic === true).length,
      disagree: members.filter((r) => r.agreementWithDeterministic === false).length,
      deterministicKnew: narrative.deterministicKnew,
      liveAdded: narrative.liveAdded,
      justifiesCost: narrative.justifiesCost,
      note: narrative.note,
    });
  }
  return out;
}

export interface Recommendation {
  readonly primary: string;
  readonly secondary: string;
  readonly eligibleForRepair: readonly string[];
  readonly excludedDefectClasses: readonly DefectClass[];
  readonly criteria: readonly string[];
}

export function buildRecommendation(runs: readonly RunComparison[]): Recommendation {
  // One-repair-attempt eligibility: live requested repair, valid, not failed-open, a reliable defect
  // class (scope/minimality), and concrete/actionable instructions.
  const eligible = runs.filter(
    (r) =>
      r.status === "ok" &&
      r.liveRepairRequired === true &&
      r.validReport === true &&
      r.failedOpen !== true &&
      (r.defectClass === "wrong_scope" || r.defectClass === "broad_rewrite_minimality") &&
      (r.instructionQuality === "concrete" || r.instructionQuality === "actionable"),
  );
  return {
    primary:
      "Implement a gated one-repair-attempt mode ONLY for live critic reports where liveRepairRequired=true, " +
      "validReport=true, failedOpen=false, defectClass is wrong_scope or broad_rewrite_minimality, and " +
      "repairInstructions are concrete/actionable. Exclude missing_failing_behavior for now.",
    secondary:
      "Add executable / narrow reproduction probes (or issue-specific expectations) for missing_failing_behavior " +
      "before allowing repair on that class, since the deterministic signal there is a literal pattern match and the " +
      "live critic's contradicting 'handled' verdict is unverified.",
    eligibleForRepair: eligible.map((r) => r.runLabel),
    excludedDefectClasses: ["missing_failing_behavior"],
    criteria: [
      "liveRepairRequired === true",
      "validReport === true",
      "failedOpen === false",
      "defectClass ∈ {wrong_scope, broad_rewrite_minimality}",
      "instructionQuality ∈ {concrete, actionable}",
    ],
  };
}

export interface ComparisonReport {
  readonly generatedAt: string | null;
  readonly summary: Summary;
  readonly runs: readonly RunComparison[];
  readonly defectClasses: readonly DefectClassReport[];
  readonly cost: {
    readonly totalCostUsd: number;
    readonly meanCostUsd: number;
    readonly totalInputTokens: number;
    readonly totalOutputTokens: number;
    readonly perRun: ReadonlyArray<{
      readonly runLabel: string;
      readonly criticCostUsd: number | null;
      readonly criticInputTokens: number | null;
      readonly criticOutputTokens: number | null;
    }>;
  };
  readonly safety: {
    readonly observationOnly: boolean;
    readonly repairPerformed: boolean;
    readonly dockerRun: boolean;
    readonly failedOpenCount: number;
    readonly validReportCount: number;
    readonly allPatchesUnchanged: boolean | null;
  };
  readonly recommendation: Recommendation;
  readonly skipped: readonly string[];
  readonly nonClaims: readonly string[];
}

export const NON_CLAIMS: readonly string[] = [
  "This report does not run agents, Docker, live critic calls, or repair.",
  "This report does not modify patches or workspaces.",
  "This report does not prove repair would improve SWE-bench resolution.",
  "This report does not justify always-on live critic usage.",
  "This report does not compare VTRACE against VEXP.",
  "This is a six-call high-risk observation, not a statistical benchmark.",
];

export function buildComparison(args: { readonly generatedAt: string | null; readonly records: readonly RunRecord[] }): ComparisonReport {
  const runs = args.records.map(buildRunComparison);
  const summary = buildSummary(runs);
  const analyzed = runs.filter((r) => r.status !== "skipped-missing-artifacts");
  const patchFlags = analyzed.map((r) => r.patchUnchanged);
  const allPatchesUnchanged = patchFlags.some((f) => f === null)
    ? null
    : patchFlags.every((f) => f === true);
  return {
    generatedAt: args.generatedAt,
    summary,
    runs,
    defectClasses: buildDefectClassReports(runs),
    cost: {
      totalCostUsd: summary.totalCostUsd,
      meanCostUsd: summary.meanCostUsd,
      totalInputTokens: summary.totalInputTokens,
      totalOutputTokens: summary.totalOutputTokens,
      perRun: runs.map((r) => ({
        runLabel: r.runLabel,
        criticCostUsd: r.criticCostUsd,
        criticInputTokens: r.criticInputTokens,
        criticOutputTokens: r.criticOutputTokens,
      })),
    },
    safety: {
      observationOnly: true,
      repairPerformed: false,
      dockerRun: false,
      failedOpenCount: summary.failedOpenCount,
      validReportCount: summary.validReportCount,
      allPatchesUnchanged,
    },
    recommendation: buildRecommendation(runs),
    skipped: runs.filter((r) => r.status === "skipped-missing-artifacts").map((r) => r.runLabel),
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

function fmtPct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

export function renderMarkdown(report: ComparisonReport): string {
  const L: string[] = [];
  const s = report.summary;

  L.push("# Stage 5 live critic high-risk comparison");
  L.push("");
  if (report.generatedAt) L.push(`_Generated: ${report.generatedAt}_`, "");
  L.push(
    "_Reporting/analysis only. This report runs no agents, no live critic, and no Docker; it implements no repair and " +
      "modifies no patch, workspace, or raw artifact. It only reads the artifacts the six gated live-critic observation " +
      "calls already wrote._",
  );
  L.push("");

  L.push("## Summary");
  L.push("");
  L.push(
    `Across ${s.runsAnalyzed} gated high-risk live critic calls, the critic was a reliable structured-output observer: ` +
      `${s.validReportCount}/${s.runsAnalyzed} valid reports, ${s.failedOpenCount}/${s.runsAnalyzed} failed-open. It agreed ` +
      `with the deterministic critic's repair_required on ${s.agreementCount}/${s.runsAnalyzed} runs ` +
      `(${s.disagreementCount} disagreements). Agreement was defect-class dependent: wrong_scope agreed, ` +
      `broad_rewrite_minimality agreed, missing_failing_behavior disagreed. Total cost $${s.totalCostUsd.toFixed(4)} ` +
      `(mean $${s.meanCostUsd.toFixed(4)}/run; ${s.totalInputTokens} in / ${s.totalOutputTokens} out tokens).`,
  );
  L.push("");
  L.push("| metric | value |");
  L.push("| --- | --- |");
  L.push(`| runsAnalyzed | ${s.runsAnalyzed} |`);
  L.push(`| validReportCount | ${s.validReportCount} |`);
  L.push(`| failedOpenCount | ${s.failedOpenCount} |`);
  L.push(`| agreementCount | ${s.agreementCount} |`);
  L.push(`| disagreementCount | ${s.disagreementCount} |`);
  L.push(`| liveRepairRequiredCount | ${s.liveRepairRequiredCount} |`);
  L.push(`| deterministicRepairRequiredCount | ${s.deterministicRepairRequiredCount} |`);
  L.push(`| totalCostUsd | $${s.totalCostUsd.toFixed(4)} |`);
  L.push(`| meanCostUsd | $${s.meanCostUsd.toFixed(4)} |`);
  L.push(`| totalInputTokens | ${s.totalInputTokens} |`);
  L.push(`| totalOutputTokens | ${s.totalOutputTokens} |`);
  L.push("");

  L.push("## Method");
  L.push("");
  L.push(
    "For each of the six runs that have live critic artifacts, this report reads `_patch_critic.meta.json` and " +
      "`_patch_critic_report.json` (and `_patch_critic_input.json` / `_first_patch.diff` for safety checks), then " +
      "compares the live critic's `repair_required` and per-field verdicts against the deterministic critic, grouped by " +
      "defect class. Agreement is the milestone definition: `deterministicRepairRequired === liveRepairRequired`. No " +
      "model is called; Docker resolution remains the only ground truth and is not consulted here.",
  );
  L.push("");

  L.push("## Runs included");
  L.push("");
  L.push("| run | instance | defect class | det repair | live repair | agree | live risk | live conf | cost | valid | failed-open |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of report.runs) {
    L.push(
      `| ${r.runLabel} | ${r.instanceId} | ${r.defectClass} | ${fmtBool(r.deterministicRepairRequired)} | ` +
        `${fmtBool(r.liveRepairRequired)} | ${fmtBool(r.agreementWithDeterministic)} | ${r.liveRisk ?? "—"} | ` +
        `${r.liveConfidence ?? "—"} | ${fmtUsd(r.criticCostUsd)} | ${fmtBool(r.validReport)} | ${fmtBool(r.failedOpen)} |`,
    );
  }
  if (report.skipped.length > 0) {
    L.push("");
    L.push(`_Skipped (missing artifacts): ${report.skipped.join(", ")}._`);
  }
  L.push("");

  L.push("## Agreement with deterministic critic");
  L.push("");
  L.push(`Overall: ${s.agreementCount}/${s.runsAnalyzed} agreed; ${s.disagreementCount} disagreed.`);
  L.push("");
  L.push("| defect class | runs | agree | disagree | agreement rate | live repair_required | det repair_required |");
  L.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const dc of DEFECT_CLASSES) {
    const a = s.agreementByDefectClass[dc];
    const rep = s.liveRepairRequiredByDefectClass[dc];
    if (a.total === 0) continue;
    L.push(
      `| ${dc} | ${a.total} | ${a.agree} | ${a.disagree} | ${fmtPct(a.agreementRate)} | ${rep.liveRepairRequired} | ${rep.deterministicRepairRequired} |`,
    );
  }
  L.push("");

  L.push("## Results by defect class");
  L.push("");
  for (const dc of report.defectClasses) {
    L.push(`### ${dc.defectClass}`);
    L.push("");
    L.push(`- instances: ${dc.instanceIds.join(", ")}`);
    L.push(`- runs: ${dc.runs}  ·  agree: ${dc.agree}  ·  disagree: ${dc.disagree}  ·  live repair_required: ${dc.liveRepairRequired}/${dc.runs}`);
    L.push(`- note: ${dc.note}`);
    L.push("");
  }

  L.push("## Added value over deterministic probes");
  L.push("");
  for (const dc of report.defectClasses) {
    L.push(`**${dc.defectClass}** (justifies cost: ${dc.justifiesCost})`);
    L.push("");
    L.push(`- deterministic probes already knew: ${dc.deterministicKnew}`);
    L.push(`- live critic added: ${dc.liveAdded}`);
    L.push("");
  }

  L.push("## Cost and token impact");
  L.push("");
  L.push("| metric | value |");
  L.push("| --- | --- |");
  L.push(`| total cost (USD) | $${report.cost.totalCostUsd.toFixed(4)} |`);
  L.push(`| mean cost/run (USD) | $${report.cost.meanCostUsd.toFixed(4)} |`);
  L.push(`| total input tokens | ${report.cost.totalInputTokens} |`);
  L.push(`| total output tokens | ${report.cost.totalOutputTokens} |`);
  L.push("");
  L.push("| run | cost | input tok | output tok |");
  L.push("| --- | --- | --- | --- |");
  for (const r of report.cost.perRun) {
    L.push(`| ${r.runLabel} | ${fmtUsd(r.criticCostUsd)} | ${r.criticInputTokens ?? "—"} | ${r.criticOutputTokens ?? "—"} |`);
  }
  L.push("");

  L.push("## Repair-instruction quality");
  L.push("");
  L.push("Classification: `none` (no repair requested) · `generic` · `concrete` · `actionable`.");
  L.push("");
  L.push("| run | defect class | live repair | instruction quality |");
  L.push("| --- | --- | --- | --- |");
  for (const r of report.runs) {
    L.push(`| ${r.runLabel} | ${r.defectClass} | ${fmtBool(r.liveRepairRequired)} | ${r.instructionQuality} |`);
  }
  L.push("");
  L.push(
    "SymPy (wrong_scope) and the three Requests (broad_rewrite_minimality) runs produced **actionable** repair " +
      "instructions; Matplotlib (missing_failing_behavior) produced **none** because the live critic did not request repair.",
  );
  L.push("");

  L.push("## Safety properties");
  L.push("");
  L.push("| property | value |");
  L.push("| --- | --- |");
  L.push(`| observation only | ${fmtBool(report.safety.observationOnly)} |`);
  L.push(`| repair performed | ${fmtBool(report.safety.repairPerformed)} |`);
  L.push(`| Docker run | ${fmtBool(report.safety.dockerRun)} |`);
  L.push(`| failed-open count | ${report.safety.failedOpenCount} |`);
  L.push(`| valid report count | ${report.safety.validReportCount} |`);
  L.push(`| all patches unchanged | ${fmtBool(report.safety.allPatchesUnchanged)} |`);
  L.push("");

  L.push("## Interpretation");
  L.push("");
  L.push(
    "The live critic was reliable as a structured-output observer (6/6 valid, 0 failed-open) and agreed with the " +
      "deterministic critic on 4/6 high-risk runs. Agreement was defect-class dependent: it agreed on every wrong_scope " +
      "and broad_rewrite_minimality run, and disagreed on both missing_failing_behavior (Matplotlib) runs, where it did " +
      "not request repair.",
  );
  L.push("");
  L.push(
    "On the Matplotlib disagreement, the available evidence points to the **deterministic probe being over-conservative** " +
      "rather than the live critic clearly under-calling: `failing_behavior_pattern` is a literal token matcher looking for " +
      "`[values.size == 0, return, empty]`, and the patch implements a semantically-equivalent truthiness guard " +
      "(`and values.size` / `if values.size else False`) that the probe could not match. The live critic recognized the " +
      "equivalent guard and judged the failing behavior handled. However, missing-behavior defects are genuinely harder to " +
      "judge without executable reproduction or issue-specific expectations, and the live critic's 'handled' verdict is " +
      "itself unverified here. So the honest read is: the deterministic signal for this class is unreliable (string match), " +
      "and the live correction is plausible but unconfirmed — the class is undecided, not resolved.",
  );
  L.push("");
  L.push(
    "Net: the live critic looks useful for scope/minimality problems (agreement + actionable repair instructions) and " +
      "should not be trusted to drive repair on missing-behavior defects until those defects have stronger executable evidence.",
  );
  L.push("");

  L.push("## Recommended next step");
  L.push("");
  L.push(`**Primary:** ${report.recommendation.primary}`);
  L.push("");
  L.push("Eligibility criteria:");
  L.push("");
  for (const c of report.recommendation.criteria) L.push(`- ${c}`);
  L.push("");
  L.push(
    report.recommendation.eligibleForRepair.length > 0
      ? `Runs eligible under these criteria today: ${report.recommendation.eligibleForRepair.join(", ")}.`
      : "No runs are eligible under these criteria today.",
  );
  L.push("");
  L.push(`**Secondary:** ${report.recommendation.secondary}`);
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
  const records = await loadAllRunRecords(config.resultsDir, CRITIC_RUN_LABELS);
  const generatedAt = new Date().toISOString();
  const report = buildComparison({ generatedAt, records });

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  const s = report.summary;
  process.stdout.write(
    [
      "Stage 5 live critic high-risk comparison written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Runs analyzed: ${s.runsAnalyzed}   valid: ${s.validReportCount}   failed-open: ${s.failedOpenCount}`,
      `Agreement: ${s.agreementCount}/${s.runsAnalyzed}   (disagreements: ${s.disagreementCount})`,
      `Live repair_required: ${s.liveRepairRequiredCount}   deterministic repair_required: ${s.deterministicRepairRequiredCount}`,
      `Cost: $${s.totalCostUsd.toFixed(4)} total, $${s.meanCostUsd.toFixed(4)}/run`,
      report.skipped.length > 0 ? `Skipped (missing artifacts): ${report.skipped.join(", ")}` : "",
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
