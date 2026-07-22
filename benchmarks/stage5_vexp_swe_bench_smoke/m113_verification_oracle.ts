/** Pure M113 verification-oracle classifiers over captured tool evidence. */

import type { OrderedToolCall } from "./m111_case_classifier";

export type Tri = "yes" | "no" | "unknown";
export type RepoTestResult =
  | "passed"
  | "failed_relevant"
  | "failed_irrelevant"
  | "failed_environment"
  | "not_run"
  | "unknown";
export type LocalOracleType =
  | "exact_issue_reproduction"
  | "minimal_script"
  | "import_smoke"
  | "unit_test_added"
  | "property_assertion"
  | "doctest_or_docstring_check"
  | "static_reasoning_only"
  | "lint_or_typecheck"
  | "irrelevant_oracle"
  | "none"
  | "unknown";
export type OracleQuality = "strong" | "medium" | "weak" | "wrong" | "none" | "unknown";
export type EnvFailureSignature =
  | "missing_dependency"
  | "missing_pip"
  | "import_error"
  | "command_not_found"
  | "pytest_collection_failure"
  | "unavailable_service"
  | "unrelated_repo_failure"
  | "none"
  | "unknown";

export interface VerificationSignals {
  readonly commands: string[];
  readonly verificationAttempted: Tri;
  readonly repoTestAttempted: Tri;
  readonly repoTestResult: RepoTestResult;
  readonly localOracleAttempted: Tri;
  readonly localOracleType: LocalOracleType;
  readonly envFailureSignature: EnvFailureSignature;
  readonly commandLoop: boolean;
  readonly successfulLocalOracle: boolean;
  readonly evidenceQuotes: string[];
}

const REPO_TEST_RE = /(?:^|[;&|]\s*|\s)(?:python\d*\s+-m\s+pytest|pytest\b|python\d*\s+tests\/runtests\.py|python\d*\s+-m\s+django\s+test|tox(?:\s|$)|python\d*\s+-m\s+doctest)/i;
const LINT_RE = /py_compile|ast\.parse|\b(?:mypy|ruff|flake8|eslint|tsc)\b/i;
const PYTHON_RE = /(?:^|[\s/;&|])python\d*(?:\.\d+)?\s+(?:-c|<<|\/tmp\/)/i;
const IMPORT_ONLY_RE = /python\d*(?:\.\d+)?\s+-c\s+["']\s*(?:import|from)\s+[^;\n]+(?:;\s*print\([^)]*(?:import|OK|successful)[^)]*\))?\s*["']?$/i;
const FAILURE_RE = /(?:Exit code [1-9]|Traceback \(most recent call last\)|ModuleNotFoundError|ImportError:|No module named|command not found|No such file or directory|FAILED|ERROR collecting)/i;
const ENV_RE = /ModuleNotFoundError|ImportError:|No module named|distutils|requires? .* installed|dependency|not installed|externally managed/i;
const ENV_DIAGNOSTIC_RE = /print\(sys\.(?:version|executable|path)|which python|command -v|pip (?:show|list)|conda (?:info|list)|import [\w.]+;\s*print\([^)]*(?:version|available|found|OK)|ls .*venv/i;

function commandOf(call: OrderedToolCall): string {
  if (typeof call.command === "string" && call.command !== "None") return call.command;
  const command = call.args?.["command"];
  return typeof command === "string" ? command : "";
}

function outputOf(call: OrderedToolCall): string {
  return typeof call.output === "string" ? call.output : "";
}

export function clipEvidence(value: string, limit = 220): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

export function isRepoTestCommand(command: string): boolean {
  return REPO_TEST_RE.test(command);
}

export function isLintOrTypecheckCommand(command: string): boolean {
  return LINT_RE.test(command);
}

export function commandFailed(call: OrderedToolCall): boolean {
  const output = outputOf(call);
  if (call.tool !== "Bash") return false;
  if ((call as OrderedToolCall & { success?: boolean }).success === false) return true;
  return FAILURE_RE.test(output);
}

export function classifyEnvFailure(calls: readonly OrderedToolCall[]): EnvFailureSignature {
  const joined = calls.map((c) => `${commandOf(c)}\n${outputOf(c)}`).join("\n");
  if (!joined.trim()) return "none";
  if (/pip(?:: command not found|3?: command not found)|No module named pip/i.test(joined)) return "missing_pip";
  if (/pytest.*(?:ERROR collecting|collection error)|ERROR collecting/i.test(joined)) return "pytest_collection_failure";
  if (/ModuleNotFoundError|No module named|distutils|requires? .* installed|dependency|not installed|externally managed/i.test(joined)) return "missing_dependency";
  if (/ImportError:/i.test(joined)) return "import_error";
  if (/command not found/i.test(joined)) return "command_not_found";
  if (/connection refused|service unavailable|could not connect/i.test(joined)) return "unavailable_service";
  return "none";
}

export function hasCommandFailureLoop(calls: readonly OrderedToolCall[], threshold = 3): boolean {
  let consecutive = 0;
  for (const call of calls) {
    if (call.tool !== "Bash") continue;
    if (commandFailed(call)) {
      consecutive += 1;
      if (consecutive >= threshold) return true;
    } else {
      consecutive = 0;
    }
  }
  return false;
}

function inferLocalOracleType(command: string): LocalOracleType {
  if (isLintOrTypecheckCommand(command)) return "lint_or_typecheck";
  if (/doctest|__doc__|docstring/i.test(command)) return "doctest_or_docstring_check";
  if (/\bassert\b|is_zero|is_finite|is_even|property\b|Invariant|PASS|Expected:/i.test(command)) return "property_assertion";
  if (IMPORT_ONLY_RE.test(command)) return "import_smoke";
  return "minimal_script";
}

export function classifyVerificationSignals(
  calls: readonly OrderedToolCall[],
  finalText = "",
): VerificationSignals {
  const bash = calls.filter((c) => c.tool === "Bash");
  const commands = bash.map(commandOf).filter(Boolean);
  const repo = bash.filter((c) => isRepoTestCommand(commandOf(c)));
  const semantic = bash.filter((c) => {
    const command = commandOf(c);
    return PYTHON_RE.test(command) && !isRepoTestCommand(command) && !isLintOrTypecheckCommand(command) && !ENV_DIAGNOSTIC_RE.test(command);
  });
  const successfulSemantic = semantic.filter((c) => !commandFailed(c) && outputOf(c).trim().length > 0);
  const lint = bash.filter((c) => isLintOrTypecheckCommand(commandOf(c)));
  const staticReasoning = /code inspection|logic (?:is|verified)|verified by reading|manual trace|pattern consistency|follows the (?:same|exact|established) pattern/i.test(finalText);

  let repoTestResult: RepoTestResult = "not_run";
  if (repo.length > 0) {
    const passed = repo.some((c) => !commandFailed(c) && !ENV_RE.test(outputOf(c)) && /pass(?:ed|ing)?|\d+ passed/i.test(outputOf(c)));
    const envFailed = repo.some((c) => ENV_RE.test(outputOf(c)) || /command not found/i.test(outputOf(c))) || bash.some((c) => ENV_RE.test(outputOf(c)));
    repoTestResult = passed ? "passed" : envFailed ? "failed_environment" : repo.every(commandFailed) ? "failed_relevant" : "unknown";
  }

  let localOracleType: LocalOracleType = "none";
  if (successfulSemantic.length > 0) localOracleType = inferLocalOracleType(commandOf(successfulSemantic.at(-1)!));
  else if (semantic.length > 0) localOracleType = inferLocalOracleType(commandOf(semantic.at(-1)!));
  else if (lint.length > 0) localOracleType = "lint_or_typecheck";
  else if (staticReasoning) localOracleType = "static_reasoning_only";

  const evidenceQuotes: string[] = [];
  const repoEvidence = repo.at(-1);
  const localEvidence = (successfulSemantic.length ? successfulSemantic : semantic).at(-1);
  if (repoEvidence) evidenceQuotes.push(`repo-test: ${clipEvidence(commandOf(repoEvidence), 150)} → ${clipEvidence(outputOf(repoEvidence), 150)}`);
  if (localEvidence && localEvidence !== repoEvidence) evidenceQuotes.push(`local: ${clipEvidence(commandOf(localEvidence), 150)} → ${clipEvidence(outputOf(localEvidence), 150)}`);
  const check = finalText.match(/CHECK RUN[^\n]*/i)?.[0];
  if (check) evidenceQuotes.push(`final: ${clipEvidence(check, 180)}`);
  else if (finalText) evidenceQuotes.push(`final: ${clipEvidence(finalText, 180)}`);

  const localOracleAttempted: Tri = localOracleType === "none" ? "no" : "yes";
  return {
    commands,
    verificationAttempted: repo.length || localOracleAttempted === "yes" ? "yes" : "no",
    repoTestAttempted: repo.length ? "yes" : "no",
    repoTestResult,
    localOracleAttempted,
    localOracleType,
    envFailureSignature: classifyEnvFailure(bash),
    commandLoop: hasCommandFailureLoop(bash),
    successfulLocalOracle: successfulSemantic.length > 0,
    evidenceQuotes: evidenceQuotes.slice(0, 3),
  };
}

export interface OutcomeAggregateRow {
  readonly live_resolved: boolean;
  readonly local_oracle_quality: OracleQuality;
  readonly verification_attempted: Tri;
  readonly repo_test_attempted: Tri;
  readonly repo_test_result: RepoTestResult;
  readonly local_oracle_attempted: Tri;
  readonly verification_failure_mode: string;
  readonly primary_verification_cause: string;
}

export function countBy<T extends string>(values: readonly T[]): Record<T, number> {
  const out = {} as Record<T, number>;
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

export function aggregateByOutcome(rows: readonly OutcomeAggregateRow[]) {
  const summarize = (subset: readonly OutcomeAggregateRow[]) => ({
    cases: subset.length,
    verification_attempted: subset.filter((r) => r.verification_attempted === "yes").length,
    repo_test_attempted: subset.filter((r) => r.repo_test_attempted === "yes").length,
    local_oracle_attempted: subset.filter((r) => r.local_oracle_attempted === "yes").length,
    oracle_quality: countBy(subset.map((r) => r.local_oracle_quality)),
    repo_test_result: countBy(subset.map((r) => r.repo_test_result)),
    failure_mode: countBy(subset.map((r) => r.verification_failure_mode)),
    primary_cause: countBy(subset.map((r) => r.primary_verification_cause)),
  });
  return {
    overall: summarize(rows),
    resolved: summarize(rows.filter((r) => r.live_resolved)),
    unresolved: summarize(rows.filter((r) => !r.live_resolved)),
  };
}

export function csvEscape(value: unknown): string {
  const rendered = Array.isArray(value) ? value.join(" | ") : value == null ? "" : String(value);
  return /[",\n]/.test(rendered) ? `"${rendered.replace(/"/g, '""')}"` : rendered;
}

export function toCsv(rows: readonly Record<string, unknown>[], columns: readonly string[]): string {
  return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")).join("\n")}\n`;
}
