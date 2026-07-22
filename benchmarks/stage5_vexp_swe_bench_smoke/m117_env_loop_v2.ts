/** M117 pure, strategy-aware, gold-blind environment-loop replay classifier. */

import type { OrderedToolCall } from "./m111_case_classifier";

export const E1_V2_DIAGNOSTIC_VERSION = "e1-v2";

export type FailureRoot =
  | "dependency_unavailable"
  | "package_manager_unavailable"
  | "test_runner_unavailable"
  | "import_environment_unavailable"
  | "build_tool_unavailable"
  | "service_unavailable"
  | "permission_or_execution_environment"
  | "unrelated_repository_failure"
  | "genuine_behavioral_failure"
  | "unknown";

export type VerificationStrategy =
  | "repo_test_suite"
  | "focused_repo_test"
  | "dependency_installation"
  | "import_smoke"
  | "syntax_or_compile_check"
  | "minimal_issue_reproduction"
  | "standalone_behavioral_oracle"
  | "property_assertion"
  | "lint_or_typecheck"
  | "static_repository_reasoning"
  | "unknown";

export type E1V2State =
  | "NONE"
  | "ISOLATED_FAILURE"
  | "RETRY_SAME_STRATEGY"
  | "ADAPTATION_ATTEMPT"
  | "RECOVERED"
  | "REPEATED_NONPROGRESS"
  | "LOOP"
  | "AMBIGUOUS";

export interface E1V2Config {
  readonly diagnosticVersion: string;
  readonly equivalentStrategyRootThreshold: number;
  readonly relatedNoTransitionThreshold: number;
  readonly protectRecoveryPermanently: boolean;
  readonly deferCandidateBeforeStandaloneOracle: boolean;
}

export const FROZEN_E1_V2_CONFIG: E1V2Config = Object.freeze({
  diagnosticVersion: E1_V2_DIAGNOSTIC_VERSION,
  equivalentStrategyRootThreshold: 2,
  relatedNoTransitionThreshold: 3,
  protectRecoveryPermanently: true,
  deferCandidateBeforeStandaloneOracle: true,
});

export interface E1V2Event {
  readonly turn: number;
  readonly command: string;
  readonly normalizedCommand: string;
  readonly strategySignature: string;
  readonly failureRoot: FailureRoot | null;
  readonly verificationStrategy: VerificationStrategy;
  readonly outcome: "environment_failure" | "behavioral_failure" | "success" | "unknown_failure";
  readonly opensRecoveryOpportunity: boolean;
}

export interface E1V2ProgressEvent {
  readonly turn: number;
  readonly type: "source_edit" | "test_oracle_edit" | "oracle_construction" | "strategy_transition" | "successful_verification";
  readonly detail: string;
}

export interface E1V2ReplayResult {
  readonly diagnosticVersion: string;
  readonly toolCallCount: number;
  readonly verificationCommandCount: number;
  readonly environmentFailureCount: number;
  readonly failureRoots: FailureRoot[];
  readonly verificationStrategies: VerificationStrategy[];
  readonly firstEnvironmentFailureTurn: number | null;
  readonly diagnosticState: E1V2State;
  readonly wouldFire: boolean;
  readonly firstFireTurn: number | null;
  readonly failureRootAtFire: FailureRoot | null;
  readonly verificationStrategyAtFire: VerificationStrategy | null;
  readonly loopKind: "same_strategy" | "dependency_install" | "repo_test_environment" | "related_no_transition" | null;
  readonly progressEvents: E1V2ProgressEvent[];
  readonly recoveryProtected: boolean;
  readonly recoveryTurn: number | null;
  readonly productiveTransitionTurns: number[];
  readonly sourceEditAllowances: number;
  readonly oracleEditAllowances: number;
  readonly pendingCandidateSuppressedByOracle: boolean;
  readonly analystReviewNeeded: boolean;
  readonly events: E1V2Event[];
}

const REPO_TEST_RE = /(?:^|[;&|]\s*|\s)(?:python\d*(?:\.\d+)?\s+-m\s+(?:pytest|unittest|django\s+test)|pytest\b|python\d*(?:\.\d+)?\s+tests\/runtests\.py|tox(?:\s|$)|nox(?:\s|$)|make\s+(?:test|check)\b|bun\s+test|npm\s+(?:test|run\s+test)|cargo\s+test|go\s+test)/i;
const INSTALL_RE = /(?:^|[;&|]\s*|\s)(?:python\d*(?:\.\d+)?\s+-m\s+pip|pip\d*|conda|mamba|apt(?:-get)?|pacman)\s+(?:install|add|-S|create|sync)\b/i;
const LINT_RE = /\b(?:mypy|ruff|flake8|pylint|eslint|tsc|typecheck)\b/i;
const SYNTAX_RE = /(?:py_compile|compileall|ast\.parse|Syntax OK)/i;
const PYTHON_EXEC_RE = /(?:^|[;&|]\s*|\s)python\d*(?:\.\d+)?\s+(?:-c\b|-m\s+doctest\b|[^;&|\s]+\.py\b)/i;
const ASSERTION_RE = /(?:\bassert\b|Expected:|Match:|all_passed|PASS:|FAIL:|should (?:be|equal)|property)/i;
const PROJECT_IMPORT_RE = /(?:from|import)\s+(?:astropy|django|matplotlib|pylint|sphinx|sympy|xarray|seaborn)\b/i;
const IMPORT_RE = /(?:from|import)\s+[A-Za-z_]/i;
const SUCCESS_RE = /(?:\b\d+ passed\b|\btests? passed\b|\ball tests passed\b|\bPASS(?:ED)?\b|\bSUCCESS\b|\bSyntax OK\b|\bMatch:\s*True\b)/i;
const BEHAVIOR_FAILURE_RE = /(?:AssertionError|\bassertion failed\b|\bFAILED\b[^\n]*(?:test_|::)|\d+ failed(?:,|\s|$)|expected .+ (?:but got|got)|\bMatch:\s*False\b)/i;

function commandOf(call: OrderedToolCall): string {
  if (typeof call.command === "string" && call.command !== "None") return call.command;
  const value = call.args?.["command"];
  return typeof value === "string" ? value : "";
}

function outputOf(call: OrderedToolCall): string {
  return typeof call.output === "string" ? call.output : "";
}

function turnOf(call: OrderedToolCall, fallback: number): number {
  const turn = Number(call.index);
  return Number.isFinite(turn) ? turn : fallback;
}

export function classifyFailureRoot(command: string, output: string): FailureRoot | null {
  const joined = `${command}\n${output}`;
  if (BEHAVIOR_FAILURE_RE.test(output) && !/(?:ModuleNotFoundError|No module named|ImportError|command not found)/i.test(output)) return "genuine_behavioral_failure";
  if (/(?:externally[- ]managed|PEP\s*668|blocked by (?:environment|policy)|host pip.*(?:blocked|disabled)|pip(?:\d*)?: command not found|No module named ['"]?pip)/i.test(joined)) return "package_manager_unavailable";
  if (INSTALL_RE.test(command) && /Exit code 127/i.test(output)) return "package_manager_unavailable";
  if (REPO_TEST_RE.test(command) && /(?:No module named ['"]?(?:pytest|nose)|pytest: command not found|tox: command not found|nox: command not found)/i.test(output)) return "test_runner_unavailable";
  if (/(?:permission denied|operation not permitted|read-only file system|cannot execute|exec format error)/i.test(output)) return "permission_or_execution_environment";
  if (/(?:connection refused|service unavailable|could not connect|connection timed out)/i.test(output)) return "service_unavailable";
  if (/(?:gcc|g\+\+|cmake|make|cargo|rustc|node|npm|bun): command not found/i.test(output)) return "build_tool_unavailable";
  if (/(?:ERROR collecting|collection errors?|Interrupted:\s*\d+ errors? during collection)/i.test(output)) return "import_environment_unavailable";
  if (/(?:ModuleNotFoundError|No module named)[:\s]+['"]?[^\s'"]+/i.test(output)) return "dependency_unavailable";
  if (/ImportError:/i.test(output)) return "import_environment_unavailable";
  if (/(?:repository is broken|unrelated (?:test|repository) failure|baseline tests? fail)/i.test(output)) return "unrelated_repository_failure";
  if (/(?:environment (?:failure|error|unavailable)|unable to execute in this environment|command not found)/i.test(output)) return "unknown";
  return null;
}

export function classifyVerificationStrategy(command: string): VerificationStrategy {
  if (INSTALL_RE.test(command)) return "dependency_installation";
  if (REPO_TEST_RE.test(command)) {
    return /(?:\s-k\s|::|test_[A-Za-z0-9_]+|tests?\/[A-Za-z0-9_./*-]+)/i.test(command) ? "focused_repo_test" : "repo_test_suite";
  }
  if (SYNTAX_RE.test(command)) return "syntax_or_compile_check";
  if (LINT_RE.test(command)) return "lint_or_typecheck";
  if (PYTHON_EXEC_RE.test(command) || /cat\s+>[^\n]+(?:\.py)?\s*<<[\s\S]*python\d*\s+[^\s;&|]+\.py/i.test(command)) {
    if (ASSERTION_RE.test(command)) return PROJECT_IMPORT_RE.test(command) ? "minimal_issue_reproduction" : "standalone_behavioral_oracle";
    if (PROJECT_IMPORT_RE.test(command)) return "minimal_issue_reproduction";
    if (IMPORT_RE.test(command) && !/(?:def\s+|class\s+)/i.test(command)) return "import_smoke";
    if (IMPORT_RE.test(command)) return "property_assertion";
    return /(?:def\s+|class\s+|==|!=|print\s*\()/i.test(command) ? "property_assertion" : "unknown";
  }
  if (/\b(?:rg|grep|sed|git\s+diff|git\s+show)\b/i.test(command)) return "static_repository_reasoning";
  return "unknown";
}

function canonicalTestTarget(command: string): string {
  const normalized = command
    .replace(/\bpython\d*(?:\.\d+)?\s+-m\s+pytest\b/gi, "pytest")
    .replace(/\bpython\d*(?:\.\d+)?\s+tests\/runtests\.py\b/gi, "django-test")
    .replace(/(?:^|\s)\.\//g, " ")
    .replace(/\s+(?:2>\/?dev\/null|2>&1)/g, "")
    .replace(/\s*\|\s*(?:head|tail)\b[^;&|]*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized;
}

export function normalizeStrategyCommand(command: string, strategy = classifyVerificationStrategy(command)): string {
  let normalized = command
    .replace(/\bpython3(?:\.\d+)?\b/g, "python")
    .replace(/\s+(?:2>\/?dev\/null|2>&1)/g, "")
    .replace(/\s*\|\s*(?:head|tail)\b[^;&|]*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (strategy === "focused_repo_test" || strategy === "repo_test_suite") return canonicalTestTarget(normalized);
  if (strategy === "dependency_installation") {
    const match = normalized.match(/(?:python\s+-m\s+pip|pip|conda|mamba|apt(?:-get)?|pacman)\s+(?:install|add|-S|create|sync)\s+([^;&|]+)/i);
    const packages = (match?.[1] ?? "unknown").replace(/\s+-[A-Za-z][^\s]*/g, "").replace(/\s+/g, " ").trim();
    return `install:${packages}`;
  }
  return normalized.replace(/(?:^|\s)\.\//g, " ").trim();
}

function successfulVerification(strategy: VerificationStrategy, command: string, output: string, root: FailureRoot | null): boolean {
  if (root || strategy === "unknown" || strategy === "dependency_installation" || strategy === "static_repository_reasoning") return false;
  if (BEHAVIOR_FAILURE_RE.test(output) || /Exit code [1-9]|Traceback \(most recent call last\)/i.test(output)) return false;
  if (strategy === "syntax_or_compile_check" || strategy === "lint_or_typecheck" || strategy === "import_smoke") return output.trim().length > 0;
  return SUCCESS_RE.test(output);
}

function isRecoveryStrategy(strategy: VerificationStrategy): boolean {
  return strategy === "minimal_issue_reproduction"
    || strategy === "standalone_behavioral_oracle"
    || strategy === "property_assertion"
    || strategy === "focused_repo_test"
    || strategy === "import_smoke";
}

function sameRootBoundary(a: FailureRoot, b: FailureRoot): boolean {
  if (a === b) return true;
  return new Set([a, b]).size === 2
    && [a, b].every((root) => root === "dependency_unavailable" || root === "import_environment_unavailable" || root === "test_runner_unavailable");
}

function semanticTokens(command: string): Set<string> {
  const ignored = new Set(["python", "print", "import", "from", "class", "def", "self", "none", "true", "false", "string"]);
  return new Set((command.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []).filter((token) => !ignored.has(token)));
}

function equivalentStrategyAttempt(a: E1V2Event, b: E1V2Event): boolean {
  if (a.verificationStrategy !== b.verificationStrategy || a.failureRoot !== b.failureRoot) return false;
  if (a.strategySignature === b.strategySignature) return true;
  if (a.verificationStrategy === "dependency_installation") return a.normalizedCommand === b.normalizedCommand;
  if (a.verificationStrategy !== "minimal_issue_reproduction"
    && a.verificationStrategy !== "standalone_behavioral_oracle"
    && a.verificationStrategy !== "property_assertion") return false;
  const left = semanticTokens(a.normalizedCommand);
  const right = semanticTokens(b.normalizedCommand);
  if (left.size === 0 || right.size === 0) return false;
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return intersection / union >= 0.65;
}

function isOracleEditPath(file: string): boolean {
  return /(?:^|\/)(?:tests?|test_[^/]+|[^/]*(?:oracle|repro)[^/]*)/i.test(file) || /\/tmp\//.test(file);
}

export function replayEnvironmentLoopV2(
  calls: readonly OrderedToolCall[],
  config: E1V2Config = FROZEN_E1_V2_CONFIG,
): E1V2ReplayResult {
  const events: E1V2Event[] = [];
  const progressEvents: E1V2ProgressEvent[] = [];
  const productiveTransitionTurns: number[] = [];
  let episode: E1V2Event[] = [];
  let verificationCommandCount = 0;
  let state: E1V2State = "NONE";
  let firstFireTurn: number | null = null;
  let failureRootAtFire: FailureRoot | null = null;
  let strategyAtFire: VerificationStrategy | null = null;
  let loopKind: E1V2ReplayResult["loopKind"] = null;
  let recoveryTurn: number | null = null;
  let recoveryProtected = false;
  let sourceEditAllowances = 0;
  let oracleEditAllowances = 0;
  let pendingCandidate: { turn: number; root: FailureRoot; strategy: VerificationStrategy; kind: NonNullable<E1V2ReplayResult["loopKind"]> } | null = null;
  let pendingCandidateSuppressedByOracle = false;
  let ambiguous = false;

  const finalizeCandidate = () => {
    if (!pendingCandidate || firstFireTurn !== null || recoveryProtected) return;
    firstFireTurn = pendingCandidate.turn;
    failureRootAtFire = pendingCandidate.root;
    strategyAtFire = pendingCandidate.strategy;
    loopKind = pendingCandidate.kind;
    pendingCandidate = null;
    state = "LOOP";
  };

  calls.forEach((call, offset) => {
    const turn = turnOf(call, offset);
    if (call.tool === "Edit" || call.tool === "Write") {
      const file = String(call.args?.["file_path"] ?? call.path ?? "unknown");
      const oracleEdit = isOracleEditPath(file);
      progressEvents.push({ turn, type: oracleEdit ? "test_oracle_edit" : "source_edit", detail: file });
      if (oracleEdit) oracleEditAllowances += 1;
      else sourceEditAllowances += 1;
      episode = [];
      pendingCandidate = null;
      if (!recoveryProtected) state = "ADAPTATION_ATTEMPT";
      return;
    }
    if (call.tool !== "Bash") return;
    const command = commandOf(call);
    const strategy = classifyVerificationStrategy(command);
    if (strategy === "unknown" || strategy === "static_repository_reasoning") return;
    const output = outputOf(call);
    const root = classifyFailureRoot(command, output);
    const normalizedCommand = normalizeStrategyCommand(command, strategy);
    const preceding = events.at(-1);
    const transition = preceding !== undefined && preceding.verificationStrategy !== strategy;
    const recoveryOpportunity = transition && isRecoveryStrategy(strategy);

    if (pendingCandidate) {
      if (config.deferCandidateBeforeStandaloneOracle && recoveryOpportunity
        && (strategy === "standalone_behavioral_oracle" || strategy === "property_assertion")) {
        pendingCandidate = null;
        pendingCandidateSuppressedByOracle = true;
      } else {
        finalizeCandidate();
      }
    }

    verificationCommandCount += 1;
    if (transition) {
      progressEvents.push({ turn, type: "strategy_transition", detail: `${preceding.verificationStrategy}->${strategy}` });
      if (recoveryOpportunity) productiveTransitionTurns.push(turn);
      episode = [];
      if (!recoveryProtected) state = "ADAPTATION_ATTEMPT";
    }
    if (/cat\s+>[^\n]+<<|cat\s+>[^\n]+\s+<<|python\d*\s+-c\s+["'][\s\S]*(?:assert|Expected:|Match:)/i.test(command)
      && isRecoveryStrategy(strategy)) {
      progressEvents.push({ turn, type: "oracle_construction", detail: strategy });
    }

    const outcome: E1V2Event["outcome"] = root === "genuine_behavioral_failure"
      ? "behavioral_failure"
      : root
        ? "environment_failure"
        : successfulVerification(strategy, command, output, root)
          ? "success"
          : "unknown_failure";
    const event: E1V2Event = {
      turn,
      command,
      normalizedCommand,
      strategySignature: `${strategy}:${normalizedCommand}`,
      failureRoot: root,
      verificationStrategy: strategy,
      outcome,
      opensRecoveryOpportunity: recoveryOpportunity,
    };
    events.push(event);

    if (outcome === "success") {
      progressEvents.push({ turn, type: "successful_verification", detail: strategy });
      recoveryTurn ??= turn;
      recoveryProtected = config.protectRecoveryPermanently;
      episode = [];
      pendingCandidate = null;
      state = "RECOVERED";
      return;
    }
    if (outcome !== "environment_failure" || !root || recoveryProtected) return;

    episode.push(event);
    const equivalent = episode.filter((candidate) => equivalentStrategyAttempt(candidate, event)).length;
    const dependencyInstall = strategy === "dependency_installation"
      && episode.filter((candidate) => candidate.verificationStrategy === strategy && candidate.failureRoot === "package_manager_unavailable").length;
    const repoBoundary = (strategy === "focused_repo_test" || strategy === "repo_test_suite")
      && episode.filter((candidate) => (candidate.verificationStrategy === "focused_repo_test" || candidate.verificationStrategy === "repo_test_suite")
        && candidate.failureRoot !== null && sameRootBoundary(candidate.failureRoot, root)).length;
    let candidateKind: E1V2ReplayResult["loopKind"] = null;
    if (equivalent >= config.equivalentStrategyRootThreshold) candidateKind = "same_strategy";
    else if (dependencyInstall >= config.equivalentStrategyRootThreshold) candidateKind = "dependency_install";
    else if (repoBoundary >= config.equivalentStrategyRootThreshold) candidateKind = "repo_test_environment";
    else if (episode.length >= config.relatedNoTransitionThreshold) candidateKind = "related_no_transition";

    if (candidateKind && firstFireTurn === null) {
      pendingCandidate = { turn, root, strategy, kind: candidateKind };
      state = "REPEATED_NONPROGRESS";
    } else if (episode.length === 1) state = transition ? "ADAPTATION_ATTEMPT" : "ISOLATED_FAILURE";
    else state = "RETRY_SAME_STRATEGY";
    if (root === "unknown") ambiguous = true;
  });

  finalizeCandidate();
  const environmentFailures = events.filter((event) => event.outcome === "environment_failure");
  if (firstFireTurn !== null) state = "LOOP";
  else if (recoveryTurn !== null) state = "RECOVERED";
  else if (ambiguous) state = "AMBIGUOUS";
  else if (environmentFailures.length === 0) state = "NONE";
  else if (episode.length > 1) state = "RETRY_SAME_STRATEGY";
  else if (productiveTransitionTurns.length > 0) state = "ADAPTATION_ATTEMPT";
  else state = "ISOLATED_FAILURE";

  return {
    diagnosticVersion: config.diagnosticVersion,
    toolCallCount: calls.length,
    verificationCommandCount,
    environmentFailureCount: environmentFailures.length,
    failureRoots: [...new Set(environmentFailures.flatMap((event) => event.failureRoot ? [event.failureRoot] : []))],
    verificationStrategies: [...new Set(events.map((event) => event.verificationStrategy))],
    firstEnvironmentFailureTurn: environmentFailures[0]?.turn ?? null,
    diagnosticState: state,
    wouldFire: firstFireTurn !== null,
    firstFireTurn,
    failureRootAtFire,
    verificationStrategyAtFire: strategyAtFire,
    loopKind,
    progressEvents,
    recoveryProtected,
    recoveryTurn,
    productiveTransitionTurns,
    sourceEditAllowances,
    oracleEditAllowances,
    pendingCandidateSuppressedByOracle,
    analystReviewNeeded: ambiguous || events.some((event) => event.outcome === "unknown_failure"),
    events,
  };
}

export function e1V2DetectorInput(input: { calls: readonly OrderedToolCall[] }): E1V2ReplayResult {
  return replayEnvironmentLoopV2(input.calls);
}
