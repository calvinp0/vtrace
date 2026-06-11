// Stage 5 gated ONE-repair-attempt mode (milestone 5 of the patch critic / repair loop design).
//
// SCOPE: benchmark-only, DISABLED BY DEFAULT. Given an existing first patch and a VALID live
// critic report that requested repair, this module makes EXACTLY ONE bounded model call to
// produce a repaired unified diff, validates it, and reports the outcome. It NEVER loops, never
// repairs ineligible defect classes (missing_failing_behavior is excluded by default), never
// touches the original first-patch / raw-agent artifacts, never edits the original workspace,
// and runs NO Docker. It changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD /
// PATCH_VERIFY / probe / deterministic-critic / live-critic behavior.
//
// Fail-open: any repair invocation error, missing diff, or invalid diff degrades to
// failedOpen=true with the original first patch preserved (repairedPatch=null). The model is
// reached only through an injectable `RepairCaller`; unit tests inject a mock and NEVER touch a
// live model. The only live implementation (`makeClaudeRepairCaller`) is used solely by the
// runner in enabled mode.

import type { PatchCriticReport } from "./stage5_patch_critic";
import type { LiveCriticMeta } from "./stage5_patch_critic_live";
import {
  type DefectClass,
  type InstructionQuality,
  classifyInstruction,
  defectClassFor,
} from "./run_stage5_live_critic_high_risk_comparison";

export type { DefectClass, InstructionQuality };

// The defect classes repair is allowed to touch by default. missing_failing_behavior is
// DELIBERATELY excluded: the live-critic evidence for that class is undecided (the deterministic
// probe is an over-conservative literal matcher and the live critic's contradicting verdict is
// unverified without executable reproduction), so it must not be repaired yet.
export const DEFAULT_ALLOWED_DEFECT_CLASSES: readonly DefectClass[] = ["wrong_scope", "broad_rewrite_minimality"];

// ---------------------------------------------------------------------------
// Caller abstraction (mockable)
// ---------------------------------------------------------------------------

export interface RepairCallResult {
  readonly raw: string; // the model's text response (expected to contain a unified diff)
  readonly model: string | null;
  readonly costUsd: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

// A repair caller takes a fully-built prompt and returns the model's raw response + usage. Like
// the critic caller it must not throw for a "model said something invalid" case (parsing handles
// that); it may throw only for a genuine invocation failure (caught upstream → fail open).
export type RepairCaller = (prompt: string, opts: { readonly model: string | null }) => Promise<RepairCallResult>;

// ---------------------------------------------------------------------------
// Input / output contracts
// ---------------------------------------------------------------------------

// Extra context attached to a generated-parser LIVE repair input. When present, the repair prompt
// uses the generated-parser narrow-rewrite guidance instead of the default per-defect-class guidance,
// and `source` marks the attempt as a generated-parser minimality repair in the artifacts/report.
export interface GeneratedParserRepairContext {
  readonly source: string; // GENERATED_PARSER_REPAIR_LIVE_SOURCE
  readonly guidance: readonly string[]; // narrow-rewrite prompt lines (already includes critic/probe)
  readonly liveCriticInstruction: string;
  readonly narrowAlternativeHint: string | null;
}

export interface PatchRepairInput {
  readonly instanceId: string;
  readonly runLabel: string;
  readonly defectClass: DefectClass;
  readonly issueText?: string | null;
  readonly firstPatch: string;
  readonly criticReport: PatchCriticReport;
  readonly repairInstructions: string;
  readonly relevantSnippets?: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  // Present ONLY for generated-parser live repair attempts; null/absent for default-path repairs.
  readonly generatedParserRepair?: GeneratedParserRepairContext | null;
}

export interface PatchRepairResult {
  readonly ran: boolean;
  readonly validPatch: boolean;
  readonly failedOpen: boolean;
  readonly error: string | null;
  readonly repairedPatch: string | null;
  readonly changedPatch: boolean;
  readonly repairCostUsd: number | null;
  readonly repairInputTokens: number | null;
  readonly repairOutputTokens: number | null;
}

// The not-run result: disabled mode, or a run the gates declined before any model call.
export const NOT_RUN_RESULT: PatchRepairResult = {
  ran: false,
  validPatch: false,
  failedOpen: false,
  error: null,
  repairedPatch: null,
  changedPatch: false,
  repairCostUsd: null,
  repairInputTokens: null,
  repairOutputTokens: null,
};

// ---------------------------------------------------------------------------
// Eligibility (pure; consumes the live critic artifacts only)
// ---------------------------------------------------------------------------

export interface RepairEligibilityInput {
  readonly runLabel: string;
  readonly meta: LiveCriticMeta | null;
  readonly report: PatchCriticReport | null;
  readonly firstPatch: string | null;
  readonly allowedDefectClasses: readonly DefectClass[];
}

export interface RepairEligibility {
  readonly eligible: boolean;
  readonly instanceId: string;
  readonly defectClass: DefectClass;
  readonly instructionQuality: InstructionQuality;
  // Empty when eligible; otherwise the first failing gate(s), in evaluation order.
  readonly reasons: readonly string[];
}

// Decide whether a run's live-critic artifacts make it repair-eligible. STRICT: every gate must
// hold. `null` is never treated as a pass. This is the artifact-derived half of eligibility; the
// runner adds the operational gates (run-label inclusion, max-runs, cost cap).
export function evaluateRepairEligibility(input: RepairEligibilityInput): RepairEligibility {
  const { meta, report } = input;
  const instanceId = report?.instanceId ?? "unknown";
  const defectClass = defectClassFor(instanceId);
  const instructionQuality = classifyInstruction(report?.repair_required ?? null, report?.repair_instructions ?? "");
  const reasons: string[] = [];

  if (meta === null) reasons.push("missing live critic meta (_patch_critic.meta.json)");
  if (report === null) reasons.push("missing live critic report (_patch_critic_report.json)");
  if (input.firstPatch === null || input.firstPatch.trim() === "") reasons.push("missing first patch (_first_patch.diff)");

  if (meta !== null) {
    if (meta.validReport !== true) reasons.push("live critic report is not valid (validReport!=true)");
    if (meta.failedOpen === true) reasons.push("live critic failed open (failedOpen=true)");
    if (meta.liveRepairRequired !== true) reasons.push("live critic did not require repair (liveRepairRequired!=true)");
  }

  if (report !== null) {
    if (report.repair_required !== true) reasons.push("report repair_required is not true");
    if (report.repair_reason.trim() === "") reasons.push("report repair_reason is empty");
    if (report.repair_instructions.trim() === "") reasons.push("report repair_instructions is empty");
    if (!input.allowedDefectClasses.includes(defectClass)) {
      reasons.push(`defectClass ${defectClass} is not in the allowed set {${input.allowedDefectClasses.join(", ")}}`);
    }
    if (instructionQuality !== "concrete" && instructionQuality !== "actionable") {
      reasons.push(`instructionQuality ${instructionQuality} is not concrete/actionable`);
    }
  }

  return { eligible: reasons.length === 0, instanceId, defectClass, instructionQuality, reasons };
}

// ---------------------------------------------------------------------------
// Generated-parser repair eligibility (DRY-RUN ONLY, explicitly opted in)
// ---------------------------------------------------------------------------
//
// SEPARATE, ADDITIVE path. Generated-parser (grammar / PLY-table) broad rewrites are NOT in
// DEFAULT_ALLOWED_DEFECT_CLASSES and are NEVER repaired by the default path (their defect class is
// `unknown`). This milestone proves that the Astropy generated-parser patch COULD become
// repair-eligible — but ONLY in dry-run, ONLY behind an explicit `--allow-generated-parser-repair`
// flag, and ONLY when every gate below holds. It NEVER produces a repaired patch, NEVER calls a
// model, and adds NO defect class to the default allowlist. Because gate (dry-run) is required for
// eligibility, a generated-parser run can never reach a live repair call in this milestone.

// The defect-class label this path recognizes (the deterministic generated-parser minimality probe
// emits this string). "or equivalent" is accepted via isGeneratedParserDefectClass.
export const GENERATED_PARSER_REPAIR_CLASS = "generated_parser_broad_rewrite / grammar_patch_minimality";

// The eligibility provenance recorded when all gates pass.
export const GENERATED_PARSER_REPAIR_SOURCE = "valid_live_critic_and_patch_minimality_agreement";

// The repair-source label stamped on a generated-parser LIVE repair attempt (its artifacts and
// report row). Distinct from the eligibility provenance above; this names what the repaired patch is.
export const GENERATED_PARSER_REPAIR_LIVE_SOURCE = "generated_parser_minimality";

// The narrow-rewrite instruction block prepended to a generated-parser LIVE repair prompt. Kept
// general (not Astropy-specific): the division_of_units / p_combined_units wording matches this
// class of grammar-minimality defect; the live critic's actionable instruction and the deterministic
// probe hint are appended per-run by buildGeneratedParserRepairGuidance so nothing is hardcoded.
export const GENERATED_PARSER_REPAIR_PROMPT_GUIDANCE: readonly string[] = [
  "The patch was flagged as a generated-parser broad rewrite. Repair narrowly:",
  "- change the division_of_units grammar production order inside its parser function",
  "- do not relocate productions into p_combined_units",
  "- do not delete generated parser tables",
  "- avoid broad grammar rewrites",
  "- preserve generated parser artifacts unless they are intentionally regenerated consistently",
];

// Build the per-run generated-parser repair guidance: the general narrow-rewrite block above plus the
// live critic's actionable instruction and the deterministic probe's narrow-alternative hint when
// present. PURE; produces prompt lines only.
export function buildGeneratedParserRepairGuidance(
  report: PatchCriticReport | null,
  probe: PatchMinimalityProbe | null,
): string[] {
  const lines = [...GENERATED_PARSER_REPAIR_PROMPT_GUIDANCE];
  const instruction = report?.repair_instructions?.trim() ?? "";
  if (instruction !== "") lines.push("", `Live critic actionable instruction: ${instruction}`);
  const hint = probe?.patchMinimalityNarrowAlternativeHint?.trim() ?? "";
  if (hint !== "") lines.push(`Deterministic narrow-alternative hint: ${hint}`);
  return lines;
}

// The INTENDED narrow-rewrite guidance a future gated repair would follow, derived from the live
// critic instructions + the deterministic probe's narrow-alternative hint. Surfaced for audit; NO
// repaired patch is produced this milestone.
export const GENERATED_PARSER_NARROW_REWRITE_GUIDANCE: readonly string[] = [
  "Change the division_of_units production order narrowly.",
  "Do not relocate productions into p_combined_units.",
  "Do not delete generated parser tables.",
  "Avoid broad grammar rewrites.",
];

// The deterministic generated-parser patch-minimality probe fields for one run, as recorded in the
// live-critic summary report's per-run row (there is no per-run raw artifact for these).
export interface PatchMinimalityProbe {
  readonly patchMinimalityRepairRequired: boolean | null;
  readonly patchMinimalityDefectClass: string | null;
  readonly patchMinimalityRisk: string | null;
  readonly patchMinimalityConfidence: string | null;
  readonly patchMinimalityNarrowAlternativeHint: string | null;
  readonly patchMinimalitySignals: readonly string[];
}

export interface GeneratedParserRepairInput {
  readonly runLabel: string;
  // The explicit opt-in flag (`--allow-generated-parser-repair`). Default false.
  readonly allowGeneratedParserRepair: boolean;
  // The master repair enable flag (`--enable-patch-repair`). REQUIRED for LIVE execution; not
  // required for dry-run eligibility (a dry run produces a report without calling any model).
  // Default false.
  readonly enablePatchRepair?: boolean;
  // Dry-run mode. When true, this evaluates dry-run ELIGIBILITY (would-repair, no model). When
  // false AND enablePatchRepair is true, this evaluates LIVE execution eligibility (one model call).
  readonly dryRun: boolean;
  // Whether this run is explicitly named by --run-label (the run-label gate already passed).
  readonly runLabelProvided: boolean;
  readonly meta: LiveCriticMeta | null;
  readonly report: PatchCriticReport | null;
  readonly firstPatch: string | null;
  readonly probe: PatchMinimalityProbe | null;
}

export interface GeneratedParserRepairEligibility {
  // The explicit flag was present.
  readonly allowed: boolean;
  // All gates pass (so the run WOULD be repair-eligible in this mode).
  readonly eligible: boolean;
  // The execution mode the flags requested: "dry-run" eligibility, "live" execution, or "blocked"
  // (neither — e.g. live without --enable-patch-repair). Eligibility can only hold for dry-run/live.
  readonly mode: "dry-run" | "live" | "blocked";
  readonly repairClass: string;
  readonly source: string;
  // Gates that PASSED, in evaluation order.
  readonly gateReasons: readonly string[];
  // Gates that FAILED, in evaluation order (empty ⇒ eligible).
  readonly blockedReasons: readonly string[];
  // Surfaced evidence fields (for the report).
  readonly patchMinimalityRepairRequired: boolean | null;
  readonly patchMinimalityDefectClass: string | null;
  readonly liveCriticRepairRequired: boolean | null;
  readonly liveCriticValid: boolean | null;
  readonly agreementWithDeterministic: boolean | null;
  readonly hasActionableNarrowRewriteGuidance: boolean;
  // The intended narrow-rewrite guidance (populated only when the guidance gate passes).
  readonly actionableNarrowRewriteGuidance: readonly string[];
}

// True when a defect-class string names the generated-parser / grammar-minimality class (the
// canonical label or an equivalent that mentions a generated parser or grammar-patch minimality).
export function isGeneratedParserDefectClass(defectClass: string | null): boolean {
  if (defectClass === null) return false;
  const s = defectClass.toLowerCase();
  return s.includes("generated_parser") || s.includes("generated-parser") || s.includes("grammar_patch_minimality");
}

// True when the live critic's repair instructions (corroborated by the probe's narrow-alternative
// hint) give ACTIONABLE narrow-rewrite guidance: a concrete/actionable instruction that names a
// narrowing action (reorder a production, keep functions separate, do not delete generated tables,
// etc.). A vague or generic instruction ("fix the patch") does NOT qualify.
export function hasNarrowRewriteGuidance(
  report: PatchCriticReport | null,
  probe: PatchMinimalityProbe | null,
): boolean {
  const instructions = report?.repair_instructions ?? "";
  const quality = classifyInstruction(report?.repair_required ?? null, instructions);
  const actionable = quality === "actionable" || quality === "concrete";
  const narrowMarker =
    /\b(narrow|reorder|production order|left[- ]?assoc|division_of_units|without deleting|do not delete|separate function|do not relocate|do not collapse|minimal(?:ity)?)\b/i;
  const hint = probe?.patchMinimalityNarrowAlternativeHint ?? "";
  const hasMarker = narrowMarker.test(instructions) || narrowMarker.test(hint);
  return actionable && hasMarker;
}

// Decide whether a run's artifacts + deterministic probe make it generated-parser-repair-eligible
// IN DRY-RUN. STRICT: every gate must hold; `null`/absent is never a pass. The runner adds the
// operational gates (max-runs, cost-cap) on top. This calls NO model and produces NO patch.
export function evaluateGeneratedParserRepairEligibility(
  input: GeneratedParserRepairInput,
): GeneratedParserRepairEligibility {
  const { meta, report, probe } = input;
  const gateReasons: string[] = [];
  const blockedReasons: string[] = [];
  const gate = (pass: boolean, ok: string, fail: string): void => {
    if (pass) gateReasons.push(ok);
    else blockedReasons.push(fail);
  };

  // (4) explicit opt-in flag.
  gate(
    input.allowGeneratedParserRepair === true,
    "generated-parser repair explicitly enabled (--allow-generated-parser-repair)",
    "missing --allow-generated-parser-repair (generated-parser repair is off by default)",
  );
  // (1) explicit run-label provided for this run.
  gate(
    input.runLabelProvided === true,
    "explicit --run-label provided for this run",
    "no explicit --run-label for this run (generated-parser repair requires an explicit run label)",
  );
  // (1)+(3)+(5) execution mode. Generated-parser repair runs in exactly one of two modes:
  //   - dry-run eligibility: dryRun=true (no --enable-patch-repair needed; no model is ever called).
  //   - live execution:      dryRun=false AND --enable-patch-repair (one bounded model call).
  // Any other combination (live without --enable-patch-repair) is blocked.
  const dryRunMode = input.dryRun === true;
  const liveMode = input.dryRun === false && input.enablePatchRepair === true;
  const mode: "dry-run" | "live" | "blocked" = liveMode ? "live" : dryRunMode ? "dry-run" : "blocked";
  gate(
    dryRunMode || liveMode,
    liveMode
      ? "live execution mode (--enable-patch-repair, dryRun=false)"
      : "dry-run eligibility mode (no model called)",
    "neither dry-run nor live-enabled (live generated-parser repair requires --enable-patch-repair with dryRun=false)",
  );
  // (5) valid live-critic artifacts present.
  gate(
    meta !== null && report !== null,
    "live critic artifacts present (_patch_critic.meta.json + _patch_critic_report.json)",
    "missing live critic artifacts (_patch_critic.meta.json / _patch_critic_report.json)",
  );
  // (6) live-critic report valid (and not failed-open).
  gate(
    meta?.validReport === true && meta?.failedOpen !== true,
    "live critic report valid (validReport=true, failedOpen=false)",
    "live critic report not valid (validReport!=true or failedOpen=true)",
  );
  // (7) live critic required repair.
  gate(
    report?.repair_required === true && meta?.liveRepairRequired === true,
    "live critic repair_required=true",
    "live critic did not require repair (repair_required!=true / liveRepairRequired!=true)",
  );
  // (8) deterministic patch-minimality probe required repair.
  gate(
    probe?.patchMinimalityRepairRequired === true,
    "deterministic patchMinimalityRepairRequired=true",
    "deterministic patchMinimalityRepairRequired!=true (missing or false)",
  );
  // (9) deterministic/live agreement.
  gate(
    meta?.agreementWithDeterministic === true,
    "deterministic/live agreement=true",
    "deterministic/live agreement!=true",
  );
  // (11) defect class is the generated-parser / grammar-minimality class.
  gate(
    isGeneratedParserDefectClass(probe?.patchMinimalityDefectClass ?? null),
    `patchMinimality defect class is generated-parser (${probe?.patchMinimalityDefectClass ?? "none"})`,
    `patchMinimality defect class is not generated-parser (${probe?.patchMinimalityDefectClass ?? "none"})`,
  );
  // (10) actionable narrow-rewrite guidance present (not vague).
  const narrow = hasNarrowRewriteGuidance(report, probe);
  gate(
    narrow,
    "live critic includes actionable narrow-rewrite guidance",
    "live critic narrow-rewrite guidance is missing or vague",
  );
  // First patch must be present to anchor a future repair.
  gate(
    input.firstPatch !== null && input.firstPatch.trim() !== "",
    "first patch present (_first_patch.diff)",
    "missing first patch (_first_patch.diff)",
  );

  return {
    allowed: input.allowGeneratedParserRepair === true,
    eligible: blockedReasons.length === 0,
    mode,
    repairClass: GENERATED_PARSER_REPAIR_CLASS,
    source: GENERATED_PARSER_REPAIR_SOURCE,
    gateReasons,
    blockedReasons,
    patchMinimalityRepairRequired: probe?.patchMinimalityRepairRequired ?? null,
    patchMinimalityDefectClass: probe?.patchMinimalityDefectClass ?? null,
    liveCriticRepairRequired: report?.repair_required ?? null,
    liveCriticValid: meta?.validReport ?? null,
    agreementWithDeterministic: meta?.agreementWithDeterministic ?? null,
    hasActionableNarrowRewriteGuidance: narrow,
    actionableNarrowRewriteGuidance: narrow ? [...GENERATED_PARSER_NARROW_REWRITE_GUIDANCE] : [],
  };
}

// ---------------------------------------------------------------------------
// Repair prompt (deliberately narrow)
// ---------------------------------------------------------------------------

const FIRST_PATCH_CHAR_CAP = 8000;
const ISSUE_TEXT_CHAR_CAP = 4000;
const SNIPPET_CHAR_CAP = 4000;

function truncate(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}\n…[truncated ${s.length - cap} chars]` : s;
}

// Per-defect-class repair guidance. Only the allowed classes get tailored guidance; an
// unexpected class (should never reach here once gated) gets a conservative generic line.
function defectGuidance(defectClass: DefectClass): string[] {
  switch (defectClass) {
    case "wrong_scope":
      return [
        "Defect class: wrong_scope.",
        "Move/re-indent the existing method to the expected class.",
        "Preserve the implementation unless the critic explicitly says otherwise.",
      ];
    case "broad_rewrite_minimality":
      return [
        "Defect class: broad_rewrite_minimality.",
        "Restore the original control-flow shape.",
        "Keep only the targeted validation/fix.",
        "Avoid rewriting the entire branch.",
      ];
    default:
      return [`Defect class: ${defectClass}. Make only the smallest correction the critic's instructions describe.`];
  }
}

// Build the narrow repair prompt. It is a MODIFICATION of the first patch, never a from-scratch
// solve. No repository dump: only the (capped) issue text if present, the first patch, the
// critic's structured report, the repair instructions, and bounded relevant snippets if given.
export function buildRepairPrompt(input: PatchRepairInput): string {
  const issue =
    input.issueText && input.issueText.trim().length > 0
      ? truncate(input.issueText.trim(), ISSUE_TEXT_CHAR_CAP)
      : "(no issue text provided)";

  const snippetLines: string[] = [];
  if (input.relevantSnippets && input.relevantSnippets.length > 0) {
    snippetLines.push("", "Relevant file snippets (bounded; for placement only):");
    for (const s of input.relevantSnippets) {
      snippetLines.push(`--- ${s.path} ---`, truncate(s.content, SNIPPET_CHAR_CAP));
    }
  }

  return [
    "You are repairing an existing patch, not solving the issue from scratch.",
    "",
    "Use only:",
    "- issue text if present",
    "- first patch",
    "- live critic report",
    "- repair instructions",
    "- bounded relevant file snippets if available",
    "",
    "Make the smallest possible edit to the first patch.",
    "",
    "Do not broaden scope.",
    "Do not rewrite unrelated logic.",
    "Do not add new files unless the first patch already did.",
    "Return only a unified diff.",
    "",
    // Generated-parser live repairs use the dedicated narrow-rewrite guidance (which already folds in
    // the live critic instruction + deterministic probe hint); all other repairs use per-class guidance.
    ...(input.generatedParserRepair ? input.generatedParserRepair.guidance : defectGuidance(input.defectClass)),
    "",
    `instance_id: ${input.instanceId}`,
    "",
    "Issue text:",
    issue,
    "",
    "Live critic report (JSON):",
    JSON.stringify(input.criticReport, null, 2),
    "",
    "Repair instructions:",
    input.repairInstructions.trim(),
    ...snippetLines,
    "",
    "First patch (unified diff):",
    truncate(input.firstPatch, FIRST_PATCH_CHAR_CAP),
    "",
    "Return only the repaired unified diff (no prose, no code fences).",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Unified-diff extraction / validation
// ---------------------------------------------------------------------------

// Extract a unified diff from a model response, tolerating ```diff / ``` code fences and
// surrounding prose. Returns the diff text (trimmed) or null if nothing diff-like is present.
export function extractUnifiedDiff(raw: string): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;

  // Prefer a fenced block if present (```diff … ``` or a bare ``` … ```).
  const fence = raw.match(/```(?:diff|patch)?\s*\n([\s\S]*?)```/);
  const candidate = fence ? fence[1]! : raw;

  // Find the first diff-like anchor: a `diff --git` line or a `--- ` file header.
  const lines = candidate.split("\n");
  let startIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ") || line.startsWith("--- ")) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return null;
  const diff = lines.slice(startIdx).join("\n").trim();
  return diff.length > 0 ? diff : null;
}

// Validate that a string is a plausible unified diff. Returns a list of violations (empty = ok).
// This is a structural check only — it does NOT confirm the patch applies; that would require the
// repository, which is out of scope for this artifact-only milestone.
export function validateUnifiedDiff(diff: string): string[] {
  const violations: string[] = [];
  if (diff.trim() === "") {
    violations.push("repaired diff is empty");
    return violations;
  }
  const hasFileHeader = /^diff --git /m.test(diff) || (/^--- /m.test(diff) && /^\+\+\+ /m.test(diff));
  if (!hasFileHeader) violations.push("no file header (expected `diff --git` or `--- `/`+++ ` pair)");
  if (!/^@@ .* @@/m.test(diff)) violations.push("no hunk header (expected an `@@ … @@` line)");
  return violations;
}

function normalizePatch(s: string): string {
  return s.replace(/\r\n/g, "\n").trim();
}

// ---------------------------------------------------------------------------
// Orchestrator — EXACTLY ONE bounded attempt, fail-open, NEVER loops
// ---------------------------------------------------------------------------

export interface RunPatchRepairArgs {
  readonly enabled: boolean;
  readonly input: PatchRepairInput;
  readonly caller: RepairCaller;
  readonly repairModel: string | null;
}

export interface RunPatchRepairOutcome {
  readonly result: PatchRepairResult;
  readonly prompt: string | null;
  readonly raw: string | null;
}

// Run the single bounded repair attempt. When disabled, short-circuits without calling the model.
// On any failure (invocation throw, missing/invalid diff) it fails open: the original first patch
// is preserved and repairedPatch is null. There is no retry and no loop — exactly one call.
export async function runPatchRepair(args: RunPatchRepairArgs): Promise<RunPatchRepairOutcome> {
  if (!args.enabled) {
    return { result: NOT_RUN_RESULT, prompt: null, raw: null };
  }

  const prompt = buildRepairPrompt(args.input);

  let call: RepairCallResult;
  try {
    call = await args.caller(prompt, { model: args.repairModel });
  } catch (e) {
    return {
      result: {
        ran: true,
        validPatch: false,
        failedOpen: true,
        error: `repair invocation failed: ${e instanceof Error ? e.message : String(e)}`,
        repairedPatch: null,
        changedPatch: false,
        repairCostUsd: null,
        repairInputTokens: null,
        repairOutputTokens: null,
      },
      prompt,
      raw: null,
    };
  }

  const costUsd = call.costUsd ?? null;
  const inputTokens = call.inputTokens ?? null;
  const outputTokens = call.outputTokens ?? null;

  const diff = extractUnifiedDiff(call.raw);
  if (diff === null) {
    return {
      result: {
        ran: true,
        validPatch: false,
        failedOpen: true,
        error: "no unified diff found in repair response",
        repairedPatch: null,
        changedPatch: false,
        repairCostUsd: costUsd,
        repairInputTokens: inputTokens,
        repairOutputTokens: outputTokens,
      },
      prompt,
      raw: call.raw,
    };
  }

  const violations = validateUnifiedDiff(diff);
  if (violations.length > 0) {
    return {
      result: {
        ran: true,
        validPatch: false,
        failedOpen: true,
        error: `invalid repaired diff: ${violations.join("; ")}`,
        repairedPatch: null,
        changedPatch: false,
        repairCostUsd: costUsd,
        repairInputTokens: inputTokens,
        repairOutputTokens: outputTokens,
      },
      prompt,
      raw: call.raw,
    };
  }

  const changedPatch = normalizePatch(diff) !== normalizePatch(args.input.firstPatch);
  return {
    result: {
      ran: true,
      validPatch: true,
      failedOpen: false,
      error: null,
      repairedPatch: diff,
      changedPatch,
      repairCostUsd: costUsd,
      repairInputTokens: inputTokens,
      repairOutputTokens: outputTokens,
    },
    prompt,
    raw: call.raw,
  };
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export const REPAIR_ARTIFACT_NAMES = {
  input: "_patch_repair_input.json",
  raw: "_patch_repair.raw.txt",
  result: "_patch_repair_result.json",
  meta: "_patch_repair.meta.json",
  firstPatch: "_first_patch.diff",
  repairedPatch: "_repaired_patch.diff",
} as const;

// The metadata persisted alongside a repair attempt: the bounded gate context plus the result.
export interface PatchRepairMeta {
  readonly enabled: boolean;
  readonly runLabel: string;
  readonly instanceId: string;
  readonly defectClass: DefectClass;
  readonly instructionQuality: InstructionQuality;
  readonly result: PatchRepairResult;
  // Set to GENERATED_PARSER_REPAIR_LIVE_SOURCE when this attempt was a generated-parser live repair;
  // null for default-path repairs. Marks the source so artifacts are unambiguous.
  readonly generatedParserRepairSource?: string | null;
  // Evaluation is NOT performed this milestone; this records intent only (no resolution claim).
  readonly evaluation: {
    readonly requested: boolean;
    readonly performed: false;
    readonly note: string;
  };
}

// Build the repair artifact file contents (filename → content). PURE: builds strings, touches no
// disk. The runner writes these into an ISOLATED `repair/` subdir so the original critic
// artifacts (_first_patch.diff, _patch_critic*.*) are never overwritten. `_first_patch.diff` here
// is a verbatim COPY of the input first patch (for side-by-side comparison), not the original.
// `_repaired_patch.diff` is written only when a valid repaired patch was produced.
export function buildRepairArtifacts(args: {
  readonly input: PatchRepairInput;
  readonly outcome: RunPatchRepairOutcome;
  readonly meta: PatchRepairMeta;
}): Record<string, string> {
  const { input, outcome, meta } = args;
  const ensureNl = (s: string): string => (s.endsWith("\n") ? s : `${s}\n`);
  const artifacts: Record<string, string> = {
    [REPAIR_ARTIFACT_NAMES.input]: `${JSON.stringify(input, null, 2)}\n`,
    [REPAIR_ARTIFACT_NAMES.raw]: `${outcome.raw ?? ""}\n`,
    [REPAIR_ARTIFACT_NAMES.result]: `${JSON.stringify(outcome.result, null, 2)}\n`,
    [REPAIR_ARTIFACT_NAMES.meta]: `${JSON.stringify(meta, null, 2)}\n`,
    // Copy of the first patch (the original artifact is left untouched in its own location).
    [REPAIR_ARTIFACT_NAMES.firstPatch]: ensureNl(input.firstPatch),
  };
  if (outcome.result.repairedPatch !== null) {
    artifacts[REPAIR_ARTIFACT_NAMES.repairedPatch] = ensureNl(outcome.result.repairedPatch);
  }
  return artifacts;
}

// ---------------------------------------------------------------------------
// Live caller (used only by the runner in enabled mode; never in tests)
// ---------------------------------------------------------------------------

// A RepairCaller backed by the Claude Code CLI (`claude -p`), mirroring makeClaudeCriticCaller.
// This is the only place a live model is contacted for repair, and it is invoked solely from the
// runner's enabled path. Returns a result; throws only on a hard spawn failure (caught upstream).
export function makeClaudeRepairCaller(): RepairCaller {
  return async (prompt, opts) => {
    const cliArgs = ["-p", prompt, "--output-format", "json"];
    if (opts.model) cliArgs.push("--model", opts.model);
    const proc = Bun.spawnSync(["claude", ...cliArgs], { stdout: "pipe", stderr: "pipe" });
    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);
    if (proc.exitCode !== 0 && stdout.trim().length === 0) {
      throw new Error(`claude exited ${proc.exitCode}: ${stderr.trim().slice(0, 200)}`);
    }
    try {
      const env = JSON.parse(stdout) as Record<string, unknown>;
      const usage = (env.usage as Record<string, unknown> | undefined) ?? {};
      return {
        raw: typeof env.result === "string" ? env.result : stdout,
        model: typeof env.model === "string" ? env.model : (opts.model ?? null),
        costUsd: typeof env.total_cost_usd === "number" ? env.total_cost_usd : null,
        inputTokens: typeof usage.input_tokens === "number" ? (usage.input_tokens as number) : null,
        outputTokens: typeof usage.output_tokens === "number" ? (usage.output_tokens as number) : null,
      };
    } catch {
      return { raw: stdout, model: opts.model ?? null, costUsd: null, inputTokens: null, outputTokens: null };
    }
  };
}
