// Stage 5 LIVE patch critic invocation (milestone 4b of the patch critic / repair loop design).
//
// SCOPE: critic OBSERVATION ONLY. This module invokes a live critic model once over a bounded
// `PatchCriticInput`, parses + validates the response into a `PatchCriticReport`, and reports
// how it compares to the deterministic critic. It NEVER modifies the patch, never attempts
// repair, never edits files, never runs Docker, and changes no retrieval / Capsule v2 /
// PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY behavior. It is disabled by default and fail-open:
// any critic error degrades to "no valid report" while leaving the original patch untouched.
//
// The model call is behind an injectable `CriticCaller` so unit tests mock it and NEVER touch
// a live model. The only live implementation (`makeClaudeCriticCaller`) shells out to the
// Claude Code CLI and is used solely by the runner in live mode.

import {
  type Confidence,
  type PatchProbeSummary,
  type ProbeStatus,
  type RiskLevel,
} from "./stage5_patch_probes";
import {
  type PatchCriticInput,
  type PatchCriticReport,
  validatePatchCriticReport,
} from "./stage5_patch_critic";

// ---------------------------------------------------------------------------
// Caller abstraction (mockable)
// ---------------------------------------------------------------------------

export interface CriticCallResult {
  readonly raw: string; // the model's text response (expected to contain the JSON report)
  readonly model: string | null;
  readonly costUsd: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

// A critic caller takes a fully-built prompt and returns the model's raw response + usage.
// Implementations must not throw for a "model said something invalid" case (that is handled by
// parsing); they may throw only for a genuine invocation failure (which the orchestrator
// catches and turns into a fail-open outcome).
export type CriticCaller = (prompt: string, opts: { readonly model: string | null }) => Promise<CriticCallResult>;

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export interface LiveCriticMeta {
  readonly enabled: boolean;
  readonly ran: boolean;
  readonly validReport: boolean;
  readonly failedOpen: boolean;
  readonly error: string | null;
  readonly criticModel: string | null;
  readonly criticCostUsd: number;
  readonly criticInputTokens: number;
  readonly criticOutputTokens: number;
  readonly deterministicRepairRequired: boolean | null;
  readonly liveRepairRequired: boolean | null;
  readonly agreementWithDeterministic: boolean | null;
}

export const DISABLED_META: LiveCriticMeta = {
  enabled: false,
  ran: false,
  validReport: false,
  failedOpen: false,
  error: null,
  criticModel: null,
  criticCostUsd: 0,
  criticInputTokens: 0,
  criticOutputTokens: 0,
  deterministicRepairRequired: null,
  liveRepairRequired: null,
  agreementWithDeterministic: null,
};

// Project the critic meta into observability-only run-meta fields. These keys mirror the
// existing `vtrace*` run-meta convention; missing on older runs (no critic artifact) → null.
export function liveCriticRunMetaFields(meta: LiveCriticMeta): Record<string, unknown> {
  return {
    vtracePatchCriticEnabled: meta.enabled,
    vtracePatchCriticRan: meta.ran,
    vtracePatchCriticValidReport: meta.validReport,
    vtracePatchCriticFailedOpen: meta.failedOpen,
    vtracePatchCriticRepairRequired: meta.liveRepairRequired,
    vtracePatchCriticAgreementWithDeterministic: meta.agreementWithDeterministic,
    vtracePatchCriticCostUsd: meta.criticCostUsd,
    vtracePatchCriticInputTokens: meta.criticInputTokens,
    vtracePatchCriticOutputTokens: meta.criticOutputTokens,
  };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

const FIRST_PATCH_CHAR_CAP = 8000;
const ISSUE_TEXT_CHAR_CAP = 4000;

function truncate(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}\n…[truncated ${s.length - cap} chars]` : s;
}

function probeLine(p: { probeId: string; status: ProbeStatus; confidence: Confidence; evidence: string[] }): string {
  return `- ${p.probeId}: ${p.status} (${p.confidence}) — ${p.evidence.join(" ")}`;
}

// Build the strict-JSON critic prompt from the bounded input. No repository dump: only the
// issue text (capped), the first patch (capped), deterministic probe results, edited files,
// and bounded treatment/context metadata.
export function buildCriticPrompt(input: PatchCriticInput): string {
  const probes = input.probeSummary.probes.map(probeLine).join("\n");
  const probeIds = input.probeSummary.probes.map((p) => p.probeId).join(", ");
  const issue =
    input.issueText && input.issueText.trim().length > 0
      ? truncate(input.issueText.trim(), ISSUE_TEXT_CHAR_CAP)
      : "(no issue text provided)";

  return [
    "You are a patch critic. You do NOT repair the patch and you do NOT propose a second edit.",
    "Return ONLY valid JSON matching the PatchCriticReport schema below — no prose, no code fences.",
    "Do not use hidden tests or gold patches. Use only the provided issue text, patch, probe results, and bounded context.",
    "If evidence is insufficient for a dimension, use null and explain why in its *_evidence string. null is NOT a pass.",
    "Set repair_required=true ONLY when the provided evidence indicates a concrete risk (wrong scope, missing failing",
    "behavior, broad non-minimal rewrite, or a syntax error). Unknown scope or weak test evidence alone must not force repair.",
    "",
    "PatchCriticReport schema (all fields required):",
    "{",
    '  "scope_ok": true | false | null,            "scope_evidence": "<non-empty>",',
    '  "failing_behavior_handled": true|false|null, "failing_behavior_evidence": "<non-empty>",',
    '  "minimality_ok": true | false | null,        "minimality_evidence": "<non-empty>",',
    '  "test_evidence_ok": true | false | null,     "test_evidence": "<non-empty>",',
    '  "risk": "low" | "medium" | "high" | "unknown",',
    '  "repair_required": true | false,',
    '  "repair_reason": "<non-empty when repair_required>",',
    '  "repair_instructions": "<non-empty when repair_required; describe a MODIFICATION, not a restart>",',
    '  "confidence": "low" | "medium" | "high",',
    `  "evidence_probe_ids": [<subset of: ${probeIds}>]`,
    "}",
    "",
    `instance_id: ${input.instanceId}`,
    `repo: ${input.repo}`,
    `edited_files: ${input.editedFiles.join(", ") || "(none)"}`,
    `patch_chars: ${input.patchChars}`,
    `treatment: pivotCheck=${input.treatmentMetadata.pivotCheckInjected} editGuard=${input.treatmentMetadata.editGuardInjected} patchVerify=${input.treatmentMetadata.patchVerifyInjected}`,
    `context_signals: hiddenPivotsInspected=${input.contextSignals.hiddenPivotsInspected} hiddenPivotsEdited=${input.contextSignals.hiddenPivotsEdited} orderedToolLog=${input.contextSignals.orderedToolLogPresent}`,
    "",
    "Issue text:",
    issue,
    "",
    "Deterministic probe results (facts to reason over, not guesses):",
    probes,
    "",
    "First patch (unified diff):",
    truncate(input.firstPatch, FIRST_PATCH_CHAR_CAP),
    "",
    "Return only the JSON object.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Strict JSON parsing / validation
// ---------------------------------------------------------------------------

// Extract the first balanced top-level JSON object from a model response, tolerating code
// fences and surrounding prose. String-aware brace matching. Returns null if none found.
export function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function asDim(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function asRisk(v: unknown): RiskLevel {
  return v === "low" || v === "medium" || v === "high" || v === "unknown" ? v : "unknown";
}
function asConfidence(v: unknown): Confidence {
  return v === "low" || v === "medium" || v === "high" ? v : "low";
}

export interface ParseResult {
  readonly ok: boolean;
  readonly report: PatchCriticReport | null;
  readonly error: string | null;
}

// Parse + coerce a model response into a PatchCriticReport, then validate it against the
// contract. `instanceId`/`runLabel` are authoritative (taken from input, not the model).
// `evidence_probe_ids` is backfilled from the known probe ids when the model omits it (purely
// provenance); all substantive dimensions/evidence remain strictly the model's and are
// validated. Returns ok=false with a reason on any parse/validation failure.
export function parseCriticReport(
  raw: string,
  instanceId: string,
  runLabel: string,
  knownProbeIds: readonly string[],
): ParseResult {
  const json = extractJsonObject(raw);
  if (json === null) return { ok: false, report: null, error: "no JSON object found in critic response" };
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    return { ok: false, report: null, error: `JSON parse error: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { ok: false, report: null, error: "critic response is not a JSON object" };
  }
  const o = obj as Record<string, unknown>;

  const rawIds = Array.isArray(o.evidence_probe_ids)
    ? (o.evidence_probe_ids as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const evidence_probe_ids = rawIds.length > 0 ? rawIds : [...knownProbeIds];

  const report: PatchCriticReport = {
    instanceId,
    runLabel,
    scope_ok: asDim(o.scope_ok),
    scope_evidence: asStr(o.scope_evidence),
    failing_behavior_handled: asDim(o.failing_behavior_handled),
    failing_behavior_evidence: asStr(o.failing_behavior_evidence),
    minimality_ok: asDim(o.minimality_ok),
    minimality_evidence: asStr(o.minimality_evidence),
    test_evidence_ok: asDim(o.test_evidence_ok),
    test_evidence: asStr(o.test_evidence),
    risk: asRisk(o.risk),
    repair_required: o.repair_required === true,
    repair_reason: asStr(o.repair_reason),
    repair_instructions: asStr(o.repair_instructions),
    confidence: asConfidence(o.confidence),
    evidence_probe_ids,
  };

  const violations = validatePatchCriticReport(report);
  if (violations.length > 0) {
    return { ok: false, report: null, error: `contract violations: ${violations.join("; ")}` };
  }
  return { ok: true, report, error: null };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface RunLiveCriticArgs {
  readonly enabled: boolean;
  readonly input: PatchCriticInput;
  // The deterministic critic's verdict for the same input (for agreement comparison).
  readonly deterministicReport: PatchCriticReport;
  readonly caller: CriticCaller;
  readonly criticModel: string | null;
  // Max retries on a parse/validation failure. Clamped to at most 1 (one retry).
  readonly maxRetries?: number;
}

export interface RunLiveCriticOutcome {
  readonly meta: LiveCriticMeta;
  readonly report: PatchCriticReport | null;
  readonly raw: string | null;
  readonly prompt: string | null;
}

// Invoke the live critic once (with at most one retry on invalid output), fail-open. NEVER
// touches the patch. When disabled, short-circuits without calling the caller.
export async function runLiveCritic(args: RunLiveCriticArgs): Promise<RunLiveCriticOutcome> {
  const deterministicRepairRequired = args.deterministicReport.repair_required;

  if (!args.enabled) {
    return { meta: DISABLED_META, report: null, raw: null, prompt: null };
  }

  const prompt = buildCriticPrompt(args.input);
  const knownProbeIds = args.input.probeSummary.probes.map((p) => p.probeId);
  const attempts = 1 + Math.min(1, Math.max(0, args.maxRetries ?? 1));

  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let model: string | null = args.criticModel;
  let lastRaw: string | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let call: CriticCallResult;
    try {
      call = await args.caller(prompt, { model: args.criticModel });
    } catch (e) {
      // Genuine invocation failure → fail open immediately (do not keep retrying a broken call).
      lastError = `critic invocation failed: ${e instanceof Error ? e.message : String(e)}`;
      return {
        meta: {
          enabled: true,
          ran: true,
          validReport: false,
          failedOpen: true,
          error: lastError,
          criticModel: model,
          criticCostUsd: costUsd,
          criticInputTokens: inputTokens,
          criticOutputTokens: outputTokens,
          deterministicRepairRequired,
          liveRepairRequired: null,
          agreementWithDeterministic: null,
        },
        report: null,
        raw: lastRaw,
        prompt,
      };
    }

    costUsd += call.costUsd ?? 0;
    inputTokens += call.inputTokens ?? 0;
    outputTokens += call.outputTokens ?? 0;
    if (call.model) model = call.model;
    lastRaw = call.raw;

    const parsed = parseCriticReport(call.raw, args.input.instanceId, args.input.runLabel, knownProbeIds);
    if (parsed.ok && parsed.report) {
      const liveRepairRequired = parsed.report.repair_required;
      return {
        meta: {
          enabled: true,
          ran: true,
          validReport: true,
          failedOpen: false,
          error: null,
          criticModel: model,
          criticCostUsd: costUsd,
          criticInputTokens: inputTokens,
          criticOutputTokens: outputTokens,
          deterministicRepairRequired,
          liveRepairRequired,
          agreementWithDeterministic: deterministicRepairRequired === liveRepairRequired,
        },
        report: parsed.report,
        raw: call.raw,
        prompt,
      };
    }
    lastError = parsed.error;
  }

  // Exhausted attempts without a valid report → fail open, patch untouched.
  return {
    meta: {
      enabled: true,
      ran: true,
      validReport: false,
      failedOpen: true,
      error: lastError,
      criticModel: model,
      criticCostUsd: costUsd,
      criticInputTokens: inputTokens,
      criticOutputTokens: outputTokens,
      deterministicRepairRequired,
      liveRepairRequired: null,
      agreementWithDeterministic: null,
    },
    report: null,
    raw: lastRaw,
    prompt,
  };
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export const CRITIC_ARTIFACT_NAMES = {
  input: "_patch_critic_input.json",
  report: "_patch_critic_report.json",
  raw: "_patch_critic.raw.txt",
  meta: "_patch_critic.meta.json",
  firstPatch: "_first_patch.diff",
} as const;

// Build the artifact file contents (filename → content). The runner writes these into the
// run's raw condition dir in live mode only. Pure: builds strings, touches no disk.
export function buildCriticArtifacts(args: {
  readonly input: PatchCriticInput;
  readonly outcome: RunLiveCriticOutcome;
}): Record<string, string> {
  const { input, outcome } = args;
  const metaWithFields = { ...outcome.meta, runMetaFields: liveCriticRunMetaFields(outcome.meta) };
  const reportContent = outcome.report
    ? JSON.stringify(outcome.report, null, 2)
    : JSON.stringify({ report: null, error: outcome.meta.error }, null, 2);
  return {
    [CRITIC_ARTIFACT_NAMES.input]: `${JSON.stringify(input, null, 2)}\n`,
    [CRITIC_ARTIFACT_NAMES.report]: `${reportContent}\n`,
    [CRITIC_ARTIFACT_NAMES.raw]: `${outcome.raw ?? ""}\n`,
    [CRITIC_ARTIFACT_NAMES.meta]: `${JSON.stringify(metaWithFields, null, 2)}\n`,
    // No-repair milestone: the first patch IS the final patch; record it explicitly.
    [CRITIC_ARTIFACT_NAMES.firstPatch]: input.firstPatch.endsWith("\n") ? input.firstPatch : `${input.firstPatch}\n`,
  };
}

// ---------------------------------------------------------------------------
// Live caller (used only by the runner in live mode; never in tests)
// ---------------------------------------------------------------------------

// A CriticCaller backed by the Claude Code CLI (`claude -p`). Requests JSON output and parses
// usage/cost when available; falls back to treating raw stdout as the response text. This is
// the only place a live model is contacted, and it is invoked solely from the runner's
// enabled-mode path. Returns a result; throws only on a hard spawn failure (caught upstream).
export function makeClaudeCriticCaller(): CriticCaller {
  return async (prompt, opts) => {
    const cliArgs = ["-p", prompt, "--output-format", "json"];
    if (opts.model) cliArgs.push("--model", opts.model);
    const proc = Bun.spawnSync(["claude", ...cliArgs], { stdout: "pipe", stderr: "pipe" });
    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);
    if (proc.exitCode !== 0 && stdout.trim().length === 0) {
      throw new Error(`claude exited ${proc.exitCode}: ${stderr.trim().slice(0, 200)}`);
    }
    // Claude Code --output-format json wraps the response in an envelope; tolerate either an
    // envelope or bare text.
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

export type { PatchProbeSummary, PatchCriticInput, PatchCriticReport };
