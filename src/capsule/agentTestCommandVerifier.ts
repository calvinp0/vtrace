// M27 — diagnostic-only isolated agent-command verifier (PURE core).
//
// Given an M26 dry-run plan (`AgentTestCommandPlan`), this module decides whether the
// planner-approved agent-selected test command may be re-run inside the correct per-instance
// SWE-bench testbed, derives a CANONICAL SAFE command (never the raw shell-piped capture), and —
// from the result of a (dependency-injected, never-here-invoked) container execution — composes
// an honest diagnostic verification record.
//
// It is DIAGNOSTIC-ONLY by construction:
//   - it NEVER calls SWE-bench grading / get_eval_report / get_resolution_status,
//   - it NEVER consumes FAIL_TO_PASS/PASS_TO_PASS for scoring (injected names are only ever
//     used by the upstream provenance gate to DISALLOW),
//   - `replacementRecommended` and `canonicalReplaced` are hard-wired `false` literals, and
//   - `finalPatchProof` / `final_patch_verified` are emitted ONLY with positive, non-empty
//     evidence that the planned patch was applied and the command ran after it.
//
// All Docker / SWE-bench execution lives behind an injected runner in the benchmark glue; this
// module performs NO I/O and starts NO container.

import {
  assessFairVerification,
  outcomeMismatch as computeOutcomeMismatch,
  parsePytestOutcome,
  clipToBytes,
  OUTPUT_MAX_BYTES,
  OUTPUT_SUMMARY_MAX_BYTES,
  type ParsedTestOutcome,
  type RunPhase,
  type TestCommandEvent,
  type TestEnvironmentAssessment,
  type TestFramework,
  type VerificationPatchStateClass,
} from "./toolOutputCapture";
import type {
  AgentTestCommandPlan,
  CommandSource,
  PatchSource,
} from "./agentTestCommandPlanner";

export const VERIFY_MODE = "verify-agent-test-command" as const;

// -------------------------------------------------------------------------------------------
// Command canonicalization: derive a SAFE command from the parsed framework + selected tests.
// We NEVER execute the raw captured shell command (it may contain pipes/redirects/quirks).
// -------------------------------------------------------------------------------------------

export interface CommandCanonicalization {
  capturedCommand: string;
  /** The safe command we would actually run, or null when canonicalization is impossible. */
  executedCommand: string | null;
  commandCanonicalized: boolean;
  canonicalizationReason: string;
}

// Frameworks whose canonical invocation runs without explicit test selectors.
const FRAMEWORK_BASE_COMMAND: Partial<Record<TestFramework, string>> = {
  tox: "tox",
  npm: "npm test",
  bun: "bun test",
  cargo: "cargo test",
  go: "go test ./...",
};

// Reject a selector that could break out of single-quoting in a meaningful way (a newline or NUL).
// Everything else (parens/brackets in pytest param ids, dots, slashes, colons) is neutralized by
// single-quoting, so it is safe to pass as a literal argv token.
function selectorIsSafe(test: string): boolean {
  return test.length > 0 && !/[\n\r\0]/.test(test);
}

// POSIX single-quote a token: wrap in '…', and escape any embedded single quote as '\''.
function shellSingleQuote(token: string): string {
  return `'${token.replace(/'/g, "'\\''")}'`;
}

// Derive a canonical safe command. pytest/unittest require selected tests; tox/npm/bun/cargo/go
// run a focused suite without selectors. Returns commandCanonicalized=false (the caller then
// skips as `command_not_canonicalizable`) when no safe form can be produced.
export function canonicalizeCommand(input: {
  capturedCommand: string;
  framework: TestFramework;
  selectedTests: readonly string[];
}): CommandCanonicalization {
  const { capturedCommand, framework, selectedTests } = input;
  const fail = (reason: string): CommandCanonicalization => ({
    capturedCommand,
    executedCommand: null,
    commandCanonicalized: false,
    canonicalizationReason: reason,
  });

  if (framework === "pytest" || framework === "unittest") {
    if (selectedTests.length === 0) {
      return fail(`framework "${framework}" needs explicit selected tests to canonicalize safely`);
    }
    if (!selectedTests.every(selectorIsSafe)) {
      return fail("a selected test contains an unsafe character (newline/NUL)");
    }
    const quoted = selectedTests.map(shellSingleQuote).join(" ");
    const executedCommand = `python -m ${framework} ${quoted}`;
    return {
      capturedCommand,
      executedCommand,
      commandCanonicalized: true,
      canonicalizationReason: `rebuilt from parsed ${framework} framework + ${selectedTests.length} selected test(s); raw captured shell pipeline discarded`,
    };
  }

  const base = FRAMEWORK_BASE_COMMAND[framework];
  if (base !== undefined) {
    return {
      capturedCommand,
      executedCommand: base,
      commandCanonicalized: true,
      canonicalizationReason: `framework "${framework}" runs a focused suite without selectors; using canonical base command`,
    };
  }

  return fail(`framework "${framework}" is not canonicalizable for fair execution`);
}

// -------------------------------------------------------------------------------------------
// Eligibility: re-assert the M26 plan's fair-execution gate before any container is started.
// -------------------------------------------------------------------------------------------

export interface VerifyEligibility {
  eligible: boolean;
  blockers: string[];
}

// Independently re-check the three execution gates on the plan (defensive: even though
// `eligibleForFutureExecution` already implies them). Returns the plan's own blocker list.
export function decideVerificationEligibility(plan: AgentTestCommandPlan): VerifyEligibility {
  const eligible =
    plan.eligibleForFutureExecution &&
    plan.commandSafety.allowed &&
    plan.fairProvenance.allowedForFairVerification;
  const blockers = [...plan.blockers];
  if (!eligible && blockers.length === 0) {
    blockers.push("plan is not eligible for fair execution");
  }
  return { eligible, blockers };
}

// -------------------------------------------------------------------------------------------
// Artifacts.
// -------------------------------------------------------------------------------------------

export type VerifySkipReason =
  | "plan_ineligible"
  | "command_not_canonicalizable"
  | "docker_not_authorized"
  | "patch_file_unavailable";

export interface SkippedVerification {
  mode: typeof VERIFY_MODE;
  sourceRunLabel: string;
  status: "skipped";
  reason: VerifySkipReason;
  blockers: string[];
  dockerStarted: false;
  commandExecuted: false;
  canonicalArtifactsUntouched: boolean;
  instanceId: string;
  patchSource: PatchSource;
  commandSource: CommandSource;
  capturedCommand: string | null;
  executedCommand: string | null;
  commandCanonicalized: boolean;
  // Diagnostic-only invariants — always false, never adoption.
  replacementRecommended: false;
  canonicalReplaced: false;
}

export interface FinalPatchProof {
  patchSource: PatchSource;
  patchSha256: string;
  patchApplied: boolean;
  commandRanAfterPatchApply: boolean;
  worktreeDiffHashBeforeCommand?: string;
  worktreeDiffHashAfterCommand?: string;
  evidence: string[];
}

export interface AgentCommandVerificationDetail {
  patchApplied: boolean;
  commandRan: boolean;
  rawToolSuccess: boolean | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputSummary: string | null;
  parsedOutcome: ParsedTestOutcome;
  environmentClassification: TestEnvironmentAssessment;
  outcomeMismatch: boolean;
  fairVerificationUsable: boolean;
  fairVerificationBlockers: string[];
  finalPatchVerified: boolean;
}

export interface AgentCommandVerification {
  mode: typeof VERIFY_MODE;
  sourceRunLabel: string;
  status: "verified" | "error";
  instanceId: string;
  patchSource: PatchSource;
  commandSource: CommandSource;
  capturedCommand: string;
  executedCommand: string | null;
  commandCanonicalized: boolean;
  canonicalizationReason: string;
  expectedImageKey: string | null;
  dockerStarted: boolean;
  commandExecuted: boolean;
  agentCommandVerification: AgentCommandVerificationDetail;
  finalPatchProof: FinalPatchProof;
  verificationPatchState: {
    classification: VerificationPatchStateClass;
    canVerifyFinalPatch: boolean;
    evidence: string[];
  };
  canonicalArtifactsUntouched: boolean;
  // Diagnostic-only invariants — always false, never adoption.
  replacementRecommended: false;
  canonicalReplaced: false;
}

export type VerifyArtifact = SkippedVerification | AgentCommandVerification;

// Build the skipped artifact (plan ineligible / non-canonicalizable / Docker not authorized).
export function buildSkippedVerification(input: {
  plan: AgentTestCommandPlan;
  reason: VerifySkipReason;
  blockers: string[];
  canonicalization?: CommandCanonicalization;
  canonicalArtifactsUntouched?: boolean;
}): SkippedVerification {
  const { plan, canonicalization } = input;
  return {
    mode: VERIFY_MODE,
    sourceRunLabel: plan.sourceRunLabel,
    status: "skipped",
    reason: input.reason,
    blockers: [...input.blockers],
    dockerStarted: false,
    commandExecuted: false,
    canonicalArtifactsUntouched: input.canonicalArtifactsUntouched ?? true,
    instanceId: plan.instanceId,
    patchSource: plan.patchSource,
    commandSource: plan.commandSource,
    capturedCommand: plan.selectedCommand,
    executedCommand: canonicalization?.executedCommand ?? null,
    commandCanonicalized: canonicalization?.commandCanonicalized ?? false,
    replacementRecommended: false,
    canonicalReplaced: false,
  };
}

// The result of a single isolated container execution (provided by the injected runner / mock).
export interface AgentCommandExecutionResult {
  dockerStarted: boolean;
  patchApplied: boolean;
  /** SHA-256 of the patch the container actually applied (echoed back by the seam script). */
  appliedPatchSha256: string | null;
  commandRan: boolean;
  exitCode: number | null;
  /** Raw tool success (e.g. from the exec wrapper); unreliable, kept for the mismatch check. */
  rawToolSuccess: boolean | null;
  stdout: string;
  stderr: string;
  worktreeDiffHashBeforeCommand?: string;
  worktreeDiffHashAfterCommand?: string;
}

function phaseForCommandSource(source: CommandSource): RunPhase {
  return source === "first_pass_test_commands" ? "first_pass" : "pivot_revision";
}

function parsedOutcomeFor(framework: TestFramework, stdout: string): ParsedTestOutcome {
  if (framework === "pytest") return parsePytestOutcome(stdout);
  return {
    framework,
    status: "unknown",
    evidence: [`no output parser for framework "${framework}"`],
    confidence: "low",
  };
}

// Compose the diagnostic verification record from a plan + canonicalization + execution result.
// PURE. Reuses the M22/M24 analyzers (`parsePytestOutcome`, `assessFairVerification`,
// `classifyTestEnvironmentOutcome` via assess) and promotes to `final_patch_verified` ONLY when
// the planned patch was applied, the command ran after it, the applied SHA matches the plan, and
// evidence is non-empty. `provenanceContext` carries the SAME injected-names / prior-exploration
// the planner used so provenance recomputes consistently (it can only ever DISALLOW).
export function buildAgentCommandVerification(input: {
  plan: AgentTestCommandPlan;
  canonicalization: CommandCanonicalization;
  execution: AgentCommandExecutionResult;
  provenanceContext: { injectedTestNames: readonly string[] | null; priorCommandText: readonly string[] };
}): AgentCommandVerification {
  const { plan, canonicalization, execution } = input;
  const framework = plan.commandFramework ?? "unknown";
  const phase = phaseForCommandSource(plan.commandSource);

  const stdout = clipToBytes(execution.stdout, OUTPUT_MAX_BYTES);
  const stderr = clipToBytes(execution.stderr, OUTPUT_MAX_BYTES);
  const outputSummaryClip = clipToBytes(execution.stdout, OUTPUT_SUMMARY_MAX_BYTES);
  const outputSummary = execution.stdout.trim().length === 0 ? null : outputSummaryClip.value;

  const parsedOutcome = parsedOutcomeFor(framework, execution.stdout);

  // Final-patch proof: the patch must be applied, the command must have run after it, and the
  // SHA the container applied must match the plan's planned patch SHA.
  const planSha = plan.patchSha256;
  const shaMatches = planSha !== null && execution.appliedPatchSha256 === planSha;
  const commandRanAfterPatchApply = execution.patchApplied && execution.commandRan;
  const finalApplied = execution.patchApplied && commandRanAfterPatchApply && shaMatches;
  const evidence: string[] = [];
  if (execution.patchApplied) evidence.push("planned patch applied to the testbed before the command");
  if (commandRanAfterPatchApply) evidence.push("command executed after the patch was applied");
  if (shaMatches) evidence.push(`applied patch sha256 ${planSha} matches the planned patch`);

  const finalPatchProof: FinalPatchProof = {
    patchSource: plan.patchSource,
    patchSha256: planSha ?? "",
    patchApplied: execution.patchApplied,
    commandRanAfterPatchApply,
    ...(execution.worktreeDiffHashBeforeCommand !== undefined
      ? { worktreeDiffHashBeforeCommand: execution.worktreeDiffHashBeforeCommand }
      : {}),
    ...(execution.worktreeDiffHashAfterCommand !== undefined
      ? { worktreeDiffHashAfterCommand: execution.worktreeDiffHashAfterCommand }
      : {}),
    evidence,
  };

  const event: TestCommandEvent = {
    phase,
    command: canonicalization.executedCommand ?? canonicalization.capturedCommand,
    testFramework: framework,
    selectedTests: [...plan.selectedTests],
    outputSummary,
    exitCode: execution.exitCode,
    success: execution.rawToolSuccess,
    patchState:
      phase === "first_pass" ? "first_pass_before_model_patch" : "revision_phase_before_revised_patch",
    parsedOutcome,
  };

  const assessment = assessFairVerification({
    policy: "agent_discovered",
    event,
    injectedTestNames: input.provenanceContext.injectedTestNames,
    priorCommandText: input.provenanceContext.priorCommandText,
    editToolBeforeTest: false,
    finalPatchProof: { applied: finalApplied, evidence },
    fullOutput: execution.stdout,
  });

  const finalPatchVerified = assessment.verificationPatchState.canVerifyFinalPatch;
  const status: AgentCommandVerification["status"] = commandRanAfterPatchApply ? "verified" : "error";

  return {
    mode: VERIFY_MODE,
    sourceRunLabel: plan.sourceRunLabel,
    status,
    instanceId: plan.instanceId,
    patchSource: plan.patchSource,
    commandSource: plan.commandSource,
    capturedCommand: canonicalization.capturedCommand,
    executedCommand: canonicalization.executedCommand,
    commandCanonicalized: canonicalization.commandCanonicalized,
    canonicalizationReason: canonicalization.canonicalizationReason,
    expectedImageKey: plan.imagePlan.expectedImageKey,
    dockerStarted: execution.dockerStarted,
    commandExecuted: execution.commandRan,
    agentCommandVerification: {
      patchApplied: execution.patchApplied,
      commandRan: execution.commandRan,
      rawToolSuccess: execution.rawToolSuccess,
      exitCode: execution.exitCode,
      stdout: stdout.value,
      stderr: stderr.value,
      outputSummary,
      parsedOutcome,
      environmentClassification: assessment.environmentClassification,
      outcomeMismatch: computeOutcomeMismatch(execution.rawToolSuccess, parsedOutcome),
      fairVerificationUsable: assessment.fairVerificationUsable,
      fairVerificationBlockers: assessment.fairVerificationBlockers,
      finalPatchVerified,
    },
    finalPatchProof,
    verificationPatchState: {
      classification: assessment.verificationPatchState.classification,
      canVerifyFinalPatch: assessment.verificationPatchState.canVerifyFinalPatch,
      evidence: [...assessment.verificationPatchState.evidence],
    },
    canonicalArtifactsUntouched: true,
    replacementRecommended: false,
    canonicalReplaced: false,
  };
}
