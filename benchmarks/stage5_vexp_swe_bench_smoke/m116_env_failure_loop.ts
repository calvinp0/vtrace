/** M116 pure, gold-blind environment-failure-loop replay classifier. */

import type { OrderedToolCall } from "./m111_case_classifier";

export const E1_DIAGNOSTIC_VERSION = "e1-v1";

export type EnvironmentFailureFamily =
  | "missing_dependency"
  | "missing_pip"
  | "pip_blocked_by_policy"
  | "command_not_found"
  | "module_import_error"
  | "pytest_collection_failure"
  | "unavailable_service"
  | "missing_build_tool"
  | "unrelated_repository_failure"
  | "permission_or_execution_environment_failure"
  | "unknown_environment_failure";

export type DiagnosticState =
  | "NONE"
  | "ISOLATED_ENV_FAILURE"
  | "RECOVERED_AFTER_ENV_FAILURE"
  | "REPEATED_ENV_FAILURE"
  | "ENV_FAILURE_LOOP"
  | "AMBIGUOUS";

export type VerificationKind =
  | "repo_test"
  | "local_oracle"
  | "import_smoke"
  | "lint_or_typecheck"
  | "environment_recovery"
  | "none";

export interface E1Config {
  readonly diagnosticVersion: string;
  readonly equivalentFamilyThreshold: number;
  readonly relatedFamilyThreshold: number;
}

export const FROZEN_E1_CONFIG: E1Config = Object.freeze({
  diagnosticVersion: E1_DIAGNOSTIC_VERSION,
  equivalentFamilyThreshold: 2,
  relatedFamilyThreshold: 3,
});

export interface ProgressEvent {
  readonly turn: number;
  readonly type: "source_or_oracle_edit" | "successful_verification" | "different_hypothesis";
  readonly detail: string;
}

export interface EnvironmentFailureEvent {
  readonly turn: number;
  readonly command: string;
  readonly normalizedCommand: string;
  readonly verificationKind: VerificationKind;
  readonly family: EnvironmentFailureFamily;
}

export interface E1ReplayResult {
  readonly diagnosticVersion: string;
  readonly toolCallCount: number;
  readonly verificationCommandCount: number;
  readonly environmentFailureCount: number;
  readonly environmentFailureFamilies: EnvironmentFailureFamily[];
  readonly firstEnvironmentFailureTurn: number | null;
  readonly repeatedFailureCount: number;
  readonly materialProgressEvents: ProgressEvent[];
  readonly successfulLocalOracleDetected: boolean;
  readonly oracleTransitionTurn: number | null;
  readonly diagnosticState: DiagnosticState;
  readonly wouldFire: boolean;
  readonly firstFireTurn: number | null;
  readonly failureFamilyAtFire: EnvironmentFailureFamily | null;
  readonly suppressionOrResetReason: string | null;
  readonly progressResetCount: number;
  readonly analystReviewNeeded: boolean;
  readonly events: EnvironmentFailureEvent[];
}

const REPO_TEST_RE = /(?:^|[;&|]\s*|\s)(?:python\d*(?:\.\d+)?\s+-m\s+(?:pytest|unittest|django\s+test)|pytest\b|python\d*(?:\.\d+)?\s+tests\/runtests\.py|tox(?:\s|$)|nox(?:\s|$)|make\s+(?:test|check)\b|bun\s+test|npm\s+(?:test|run\s+test)|cargo\s+test|go\s+test)/i;
const LINT_RE = /(?:py_compile|compileall|ast\.parse|\b(?:mypy|ruff|flake8|pylint|eslint|tsc|typecheck)\b)/i;
const PYTHON_EXEC_RE = /(?:^|[;&|]\s*|\s)python\d*(?:\.\d+)?\s+(?:-c\b|-m\s+doctest\b|[^;&|\s]+\.py\b)/i;
const IMPORT_SMOKE_RE = /python\d*(?:\.\d+)?\s+-c\s+["'][\s\S]*(?:import|from)\s+[A-Za-z_]/i;
const RECOVERY_RE = /(?:^|[;&|]\s*)(?:python\d*(?:\.\d+)?\s+-m\s+pip|pip\d*|conda|mamba|apt(?:-get)?|which|command\s+-v)\b/i;
const ASSERTION_FAILURE_RE = /(?:AssertionError|\bassertion failed\b|\bFAILED\b[^\n]*(?:test_|::)|\d+ failed(?:,|\s|$)|expected .+ (?:but got|got)|actual:)/i;
const SUCCESS_RE = /(?:\b\d+ passed\b|\btests? passed\b|\ball tests passed\b|\bPASS(?:ED)?\b|\bSUCCESS\b|\bSyntax OK\b|\bMatch:\s*True\b|\bExpected:\b)/i;

function commandOf(call: OrderedToolCall): string {
  if (typeof call.command === "string" && call.command !== "None") return call.command;
  const value = call.args?.["command"];
  return typeof value === "string" ? value : "";
}

function outputOf(call: OrderedToolCall): string {
  return typeof call.output === "string" ? call.output : "";
}

function turnOf(call: OrderedToolCall, fallback: number): number {
  const parsed = Number(call.index);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function classifyVerificationCommand(command: string): VerificationKind {
  if (REPO_TEST_RE.test(command)) return "repo_test";
  if (LINT_RE.test(command)) return "lint_or_typecheck";
  if (IMPORT_SMOKE_RE.test(command) && !/\bassert\b|Expected:|Match:|PASS|SUCCESS/i.test(command)) return "import_smoke";
  if (PYTHON_EXEC_RE.test(command)) return "local_oracle";
  if (RECOVERY_RE.test(command)) return "environment_recovery";
  return "none";
}

export function classifyEnvironmentFailure(
  command: string,
  output: string,
): EnvironmentFailureFamily | null {
  const joined = `${command}\n${output}`;
  if (ASSERTION_FAILURE_RE.test(output) && !/(?:ModuleNotFoundError|No module named|ImportError|command not found)/i.test(output)) return null;
  if (/externally[- ]managed|PEP\s*668|blocked by (?:environment|policy)|host pip.*(?:blocked|disabled)/i.test(joined)) return "pip_blocked_by_policy";
  if (/(?:pip\d*: command not found|No module named ['"]?pip|python[^\n]*-m pip[^\n]*No module named pip)/i.test(joined)) return "missing_pip";
  if (/(?:ERROR collecting|collection errors?|Interrupted:\s*\d+ errors? during collection)/i.test(output)) return "pytest_collection_failure";
  if (/(?:ModuleNotFoundError|No module named)[:\s]+['"]?[^\s'"]+/i.test(output)) return "missing_dependency";
  if (/ImportError:/i.test(output)) return "module_import_error";
  if (/(?:permission denied|operation not permitted|read-only file system|cannot execute|exec format error)/i.test(output)) return "permission_or_execution_environment_failure";
  if (/(?:connection refused|service unavailable|could not connect|connection timed out)/i.test(output)) return "unavailable_service";
  if (/(?:gcc|g\+\+|cmake|make|cargo|rustc|node|npm|bun): command not found/i.test(output)) return "missing_build_tool";
  if (/command not found/i.test(output)) return "command_not_found";
  if (/(?:repository is broken|unrelated (?:test|repository) failure|baseline tests? fail)/i.test(output)) return "unrelated_repository_failure";
  if (/(?:environment (?:failure|error|unavailable)|unable to execute in this environment)/i.test(output)) return "unknown_environment_failure";
  return null;
}

export function isRelevantAssertionFailure(output: string): boolean {
  return ASSERTION_FAILURE_RE.test(output) && classifyEnvironmentFailure("", output) === null;
}

export function normalizeVerificationCommand(command: string): string {
  let normalized = command
    .replace(/\s+2>\/?dev\/null/g, "")
    .replace(/\s+2>&1/g, "")
    .replace(/\s*\|\s*(?:head|tail)\b[^;&|]*/gi, "")
    .replace(/\bpython3(?:\.\d+)?\b/g, "python")
    .replace(/\s+/g, " ")
    .trim();
  const chainedVerification = normalized.match(/(?:&&|;)\s*((?:python\s+|pytest\b)[\s\S]*)/i);
  if (chainedVerification && RECOVERY_RE.test(normalized.slice(0, chainedVerification.index))) normalized = chainedVerification[1]!.trim();
  return normalized;
}

function successfulVerification(kind: VerificationKind, output: string): boolean {
  if (kind === "none" || kind === "environment_recovery") return false;
  if (classifyEnvironmentFailure("", output) || isRelevantAssertionFailure(output) || /Exit code [1-9]|Traceback \(most recent call last\)/i.test(output)) return false;
  if (kind === "import_smoke" || kind === "lint_or_typecheck") return output.trim().length > 0;
  return SUCCESS_RE.test(output);
}

function commandsEquivalent(a: EnvironmentFailureEvent, b: EnvironmentFailureEvent): boolean {
  if (a.normalizedCommand === b.normalizedCommand) return true;
  if (a.verificationKind === "environment_recovery" && b.verificationKind === "environment_recovery") {
    return /\bpip\b/i.test(a.command) === /\bpip\b/i.test(b.command);
  }
  return false;
}

export function replayEnvironmentFailureLoop(
  calls: readonly OrderedToolCall[],
  config: E1Config = FROZEN_E1_CONFIG,
): E1ReplayResult {
  const failures: EnvironmentFailureEvent[] = [];
  const progress: ProgressEvent[] = [];
  let episode: EnvironmentFailureEvent[] = [];
  let verificationCount = 0;
  let firstFireTurn: number | null = null;
  let familyAtFire: EnvironmentFailureFamily | null = null;
  let successfulLocalOracleDetected = false;
  let oracleTransitionTurn: number | null = null;
  let resetCount = 0;
  let resetReason: string | null = null;
  let ambiguous = false;

  const reset = (event: ProgressEvent) => {
    if (episode.length > 0) {
      progress.push(event);
      episode = [];
      resetCount += 1;
      resetReason = `${event.type}@${event.turn}`;
    }
  };

  calls.forEach((call, offset) => {
    const turn = turnOf(call, offset);
    if ((call.tool === "Edit" || call.tool === "Write") && episode.length > 0) {
      const file = String(call.args?.["file_path"] ?? call.path ?? "unknown");
      reset({ turn, type: "source_or_oracle_edit", detail: file });
      return;
    }
    if (call.tool !== "Bash") return;
    const command = commandOf(call);
    const output = outputOf(call);
    const kind = classifyVerificationCommand(command);
    if (kind === "none") return;
    verificationCount += 1;
    if (successfulVerification(kind, output)) {
      if (kind === "local_oracle") {
        successfulLocalOracleDetected = true;
        oracleTransitionTurn ??= turn;
      }
      reset({ turn, type: "successful_verification", detail: kind });
      return;
    }
    const family = classifyEnvironmentFailure(command, output);
    if (!family) return;
    const event: EnvironmentFailureEvent = {
      turn,
      command,
      normalizedCommand: normalizeVerificationCommand(command),
      verificationKind: kind,
      family,
    };
    failures.push(event);

    const prior = episode.at(-1);
    if (prior && prior.family === family && !commandsEquivalent(prior, event)) {
      const bothRecovery = prior.verificationKind === "environment_recovery" && kind === "environment_recovery";
      if (!bothRecovery) {
        reset({ turn, type: "different_hypothesis", detail: `${prior.verificationKind}->${kind}` });
        ambiguous = true;
      }
    }
    episode.push(event);
    if (firstFireTurn !== null) return;
    const sameFamilyEquivalent = episode.filter((candidate) => candidate.family === family && commandsEquivalent(candidate, event)).length;
    const relatedFailures = episode.length;
    if (sameFamilyEquivalent >= config.equivalentFamilyThreshold || relatedFailures >= config.relatedFamilyThreshold) {
      firstFireTurn = turn;
      familyAtFire = family;
    }
  });

  const recovered = failures.length > 0 && progress.some((event) => event.type === "successful_verification");
  let state: DiagnosticState = "NONE";
  if (firstFireTurn !== null) state = "ENV_FAILURE_LOOP";
  else if (recovered) state = "RECOVERED_AFTER_ENV_FAILURE";
  else if (failures.length === 1) state = "ISOLATED_ENV_FAILURE";
  else if (failures.length > 1) state = ambiguous ? "AMBIGUOUS" : "REPEATED_ENV_FAILURE";

  return {
    diagnosticVersion: config.diagnosticVersion,
    toolCallCount: calls.length,
    verificationCommandCount: verificationCount,
    environmentFailureCount: failures.length,
    environmentFailureFamilies: [...new Set(failures.map((event) => event.family))],
    firstEnvironmentFailureTurn: failures[0]?.turn ?? null,
    repeatedFailureCount: Math.max(0, failures.length - 1),
    materialProgressEvents: progress,
    successfulLocalOracleDetected,
    oracleTransitionTurn,
    diagnosticState: state,
    wouldFire: firstFireTurn !== null,
    firstFireTurn,
    failureFamilyAtFire: familyAtFire,
    suppressionOrResetReason: resetReason,
    progressResetCount: resetCount,
    analystReviewNeeded: ambiguous || failures.some((event) => event.family === "unknown_environment_failure"),
    events: failures,
  };
}

export function runtimeDetectorInput(input: { calls: readonly OrderedToolCall[] }): E1ReplayResult {
  return replayEnvironmentFailureLoop(input.calls);
}
