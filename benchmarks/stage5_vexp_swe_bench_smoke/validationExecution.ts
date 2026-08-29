// Stage 5 M187 — validation-execution truthfulness (PURE / deterministic core).
//
// WHAT THIS IS FOR. M185 audited M183's 60 preserved arms and had to abandon its first
// detector: it keyed "did the suite run" on `exitCode === 0`, and every one of M183's 335
// Bash calls carries `exitCode: null`, so the metric silently returned zero for everything.
// M185 replaced it with an output-evidence rule, which was right, but that rule still answers
// only one question ("does the output look like a run?") and collapses several that the
// benchmark has to keep apart:
//
//   the agent never tried to validate            (a CHOICE — a fact about the agent)
//   the agent tried and the runner never started (a CAPABILITY — a fact about the harness)
//   the runner started and the tests passed
//   the runner started and the tests failed      (a fact about the PATCH)
//   the runner started and was killed by a clock
//   the runner started and the environment broke (a fact about the ENVIRONMENT, not the patch)
//   the evidence does not support any of these
//
// Conflating the second with the fourth is the specific error this module exists to prevent:
// `pytest: command not found` is not a failing test, and a benchmark that scores it as one is
// measuring its own installation.
//
// AUTHORITY. This composes the existing unversioned telemetry authority rather than forking
// it. `classifyTestFramework` (src/capsule/toolOutputCapture.ts) decides what a test command
// is; `parsePytestOutcome` + `classifyTestEnvironmentOutcome` (the M22/M24 layer) decide what
// a pytest run SAID. What did not exist anywhere is the layer BENEATH those: whether the
// runner ever started, which every one of them presupposes. That layer is what this adds.
//
// PURE: no fs, no subprocess, no clock, no randomness. It reads no gold patch, no
// FAIL_TO_PASS set and no `resolved` flag — see `ValidationEvidence`, which is the whole
// input surface, and note it has no field to smuggle an outcome through (§28).

import {
  classifyTestEnvironmentOutcome,
  classifyTestFramework,
  parsePytestOutcome,
  type TestFramework,
} from "../../src/capsule/toolOutputCapture";

// ---------------------------------------------------------------------------------------
// The state model (§10)
// ---------------------------------------------------------------------------------------

/**
 * What happened to one validation attempt — or, at arm scope, to an arm's whole validation
 * story. The split that matters is `ATTEMPTED_NOT_STARTED` vs the `STARTED_*` family: only
 * the latter observed a test runner, and only `STARTED_PASSED` / `STARTED_FAILED` say
 * anything at all about the code under test.
 */
export type ValidationExecutionState =
  | "NOT_ATTEMPTED"
  | "ATTEMPTED_NOT_STARTED"
  | "STARTED_PASSED"
  | "STARTED_FAILED"
  | "STARTED_TIMED_OUT"
  | "STARTED_INFRA_FAILURE"
  | "UNKNOWN";

/** Why a validation attempt never reached a running test runner. */
export type NotStartedCause =
  | "TOOL_POLICY_REFUSAL"
  | "TEST_RUNNER_UNAVAILABLE"
  | "DEPENDENCY_ENVIRONMENT_UNAVAILABLE"
  | "COMMAND_OR_TARGET_MISSING"
  | "PERMISSION_FAILURE"
  | "TIMEOUT_BEFORE_RUNNER"
  | "UNKNOWN_INFRASTRUCTURE_FAILURE";

/** How the command's process ended, as far as the evidence actually shows. */
export type TerminationState = "exited" | "timed_out" | "refused" | "unknown";

/** The exit status, kept explicitly unknown rather than defaulted (§9, §23.2/§23.3). */
export type ExitStatus =
  | { readonly known: true; readonly code: number; readonly source: "stream_field" | "output_prefix" }
  | { readonly known: false; readonly reason: string };

// ---------------------------------------------------------------------------------------
// Input surface
// ---------------------------------------------------------------------------------------

/**
 * Everything the classifier is allowed to see about one tool call. Deliberately narrow: there
 * is no `resolved`, no gold patch and no instance metadata, so classification CANNOT depend on
 * whether the task ultimately succeeded (§28). `isTestCommandOverride` exists only so a caller
 * can declare a repository-specific runner entrypoint the shared authority does not know.
 */
export interface ValidationEvidence {
  readonly tool: string;
  readonly command: string | null;
  readonly output: string | null;
  /** From the stream's `is_error` (success = !is_error), or null when the stream omitted it. */
  readonly success: boolean | null;
  /** Structured exit code if the transport had one; null is UNKNOWN, never 0. */
  readonly exitCode: number | null;
  readonly exitCodeSource?: "stream_field" | "output_prefix" | null;
  readonly truncated?: boolean;
}

/** The per-attempt record (§23's conceptual shape, named for what this repository calls things). */
export interface ValidationAttemptRecord {
  readonly command: string;
  readonly testFramework: TestFramework | "repo_runner_script";
  readonly attempted: true;
  readonly runnerStarted: boolean | null;
  readonly termination: TerminationState;
  readonly exitStatus: ExitStatus;
  readonly state: ValidationExecutionState;
  readonly notStartedCause: NotStartedCause | null;
  /** The M24 authority's verdict, verbatim, when a runner was observed. */
  readonly environmentClassification: string | null;
  readonly evidence: readonly string[];
}

// ---------------------------------------------------------------------------------------
// Evidence markers
// ---------------------------------------------------------------------------------------
//
// These are kept small and semantic on purpose (§22). Each set answers exactly one question,
// and none of them is allowed to answer a question a different set owns. In particular no
// marker here reads a pass/fail RESULT — that is delegated to the M22/M24 authority once a
// runner is known to have started.

/**
 * Positive proof that a test runner produced output. A banner, a collection line or a result
 * summary — never a bare "passed"/"failed" substring, which appears in ordinary prose and in
 * source code the agent happened to cat.
 */
const RUNNER_STARTED_MARKERS: readonly RegExp[] = [
  /=+ test session starts =+/,
  /^platform \w+ -- Python/m,
  /collected \d+ items?/,
  /\b\d+ (passed|failed|error|errors|skipped|xfailed|deselected)\b/,
  /=+ (FAILURES|ERRORS|short test summary info) =+/,
  /^Ran \d+ tests? in /m, // unittest / django runtests.py
  /^(OK|FAILED \()/m, // unittest verdict lines
  /^(SKIPPED|PASSED|FAILED|ERROR) \[/m, // pytest -r / -v node result lines
  /\bcongratulations :\)/, // tox
  // M187 — pytest's OWN launcher diagnostics. These are emitted by a running pytest before it
  // ever prints a session header, and no other program produces them, so they are proof the
  // runner executed. Without them a conftest that fails to import reads as "never started",
  // which understates the harness's capability and overstates its refusals: the runner was
  // reachable, the repository's dependency environment was not.
  /^ImportError while loading conftest /m,
  /\bno tests ran in /,
  /^ERROR: file or directory not found: /m,
  /^ERROR: not found: /m,
];

/** The process was never launched: the shell could not find or open the thing it was told to run. */
const LAUNCH_FAILURE_MARKERS: readonly RegExp[] = [
  /: command not found/,
  /: No such file or directory/,
  /can't open file .*: \[Errno 2\]/,
  /No such file or directory: '/,
];

/** A permission denial that happens before any process of ours runs. */
const PERMISSION_MARKERS: readonly RegExp[] = [/[Pp]ermission denied/];

/**
 * The tool layer — not the shell — declined. Includes the benchmark's own M90A host-pip
 * firewall, which is itself a tool-policy refusal and must not read as an environment defect.
 */
const TOOL_POLICY_MARKERS: readonly RegExp[] = [
  /requires explicit approval/,
  /cannot be auto-allowed by permission rules/,
  /VTRACE_HOST_(PIP|CONDA|PACKAGE_MANAGER)_BLOCKED/,
  /Dangerous \w+ operation detected/,
];

/** A clock killed it. */
const TIMEOUT_MARKERS: readonly RegExp[] = [
  /Command timed out after/,
  /\btimed out\b/i,
  /Timeout after \d+/,
];

/** The named test runner itself is not importable/installed. */
const RUNNER_UNAVAILABLE_MARKERS: readonly RegExp[] = [
  /No module named '?(pytest|nose|tox|unittest)'?/,
  // The runner EXECUTABLE is absent. Named explicitly so this outranks the generic
  // `COMMAND_OR_TARGET_MISSING`: `pytest: command not found` says the runner is unavailable,
  // while `pip: command not found` says only that some other tool is — a distinction the
  // refusal taxonomy has to keep, because the two have different owners and different fixes.
  /\b(pytest|py\.test|nosetests|tox|nose2)(-[\w.]+)?: command not found/,
  /No test runner found/,
];

/** Some other import/dependency broke before a runner could start. */
const DEPENDENCY_MARKERS: readonly RegExp[] = [
  /ModuleNotFoundError/,
  /No module named/,
  /ImportError/,
];

/**
 * Repository test entrypoints that are real runners but are plain scripts, so the shared
 * `classifyTestFramework` cannot see them. Django's `tests/runtests.py` is the one that
 * actually occurs in this corpus; the others are listed because SWE-bench's repo set uses
 * them and leaving them out would undercount ATTEMPTS, which is the conservative-wrong
 * direction here (it would flatter the harness).
 */
const REPO_RUNNER_SCRIPT = /\b(runtests\.py|nosetests|bin\/test|setup\.py\s+test|pytest\.py)\b/;

/**
 * A heredoc body is DATA, not a command. `cat > test_x.py << 'EOF' … import pytest … EOF`
 * writes a test file; it does not run one, and counting it as a validation attempt inflates
 * exactly the number this milestone exists to state honestly. Strip the body before asking
 * what the command is. (M185 counted one of these among its 51.)
 */
function stripHeredocBodies(command: string): string {
  return command.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?^\s*\1\s*$/gm, "<<REDACTED");
}

const anyMatch = (text: string, res: readonly RegExp[]): RegExp | null =>
  res.find((re) => re.test(text)) ?? null;

// ---------------------------------------------------------------------------------------
// Attempt detection
// ---------------------------------------------------------------------------------------

/**
 * Is this tool call an attempt to validate? Composes the shared authority and adds the
 * repository runner scripts it does not model. Returns the framework label, or null when the
 * call is not a validation attempt at all.
 *
 * An ATTEMPT is a property of the COMMAND alone. It is deliberately decided without looking
 * at the output, so that "the agent tried" can never be revised away by how badly it went.
 */
export function classifyValidationAttempt(
  evidence: ValidationEvidence,
): TestFramework | "repo_runner_script" | null {
  if (evidence.command === null || evidence.command.trim().length === 0) return null;
  const command = stripHeredocBodies(evidence.command);
  const framework = classifyTestFramework(command);
  if (framework !== "unknown") return framework;
  if (REPO_RUNNER_SCRIPT.test(command)) return "repo_runner_script";
  return null;
}

// ---------------------------------------------------------------------------------------
// Exit status
// ---------------------------------------------------------------------------------------

/**
 * Read the exit status WITHOUT inventing one. Three surfaces exist, in descending
 * trustworthiness: a structured transport field (never present under MCP 2024-11-05), the
 * shell tool's own `Exit code N` first line, and `is_error`. The third is used only to
 * conclude "exited 0", and only when the second is absent — and even that is withheld behind
 * `known:false` when the command was piped, because a pipeline reports the exit status of its
 * LAST stage. `cmd | head` returns 0 no matter how hard `cmd` failed, which is exactly how
 * M183's `No module named pytest` calls came back flagged successful.
 */
export function readExitStatus(evidence: ValidationEvidence): ExitStatus {
  if (evidence.exitCode !== null) {
    return { known: true, code: evidence.exitCode, source: evidence.exitCodeSource ?? "stream_field" };
  }
  if (evidence.success === true) {
    const piped = evidence.command !== null && /\|\s*(head|tail|grep|sed|awk|cut|sort|uniq|wc|less|more)\b/.test(evidence.command);
    if (piped) {
      return { known: false, reason: "pipeline masks the exit status of the command under test" };
    }
    return { known: true, code: 0, source: "output_prefix" };
  }
  if (evidence.success === false) {
    return { known: false, reason: "is_error set but no exit code on any surface" };
  }
  return { known: false, reason: "no exit status on any available surface" };
}

// ---------------------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------------------

/**
 * Classify one validation attempt.
 *
 * PRECEDENCE, and why it is in this order:
 *
 *   1. A tool-policy refusal is decided FIRST, because the tool layer sits above the shell:
 *      when it declines, nothing downstream ran and no other marker can be trusted.
 *   2. Runner-started evidence is decided SECOND, before any failure marker. This is the
 *      load-bearing rule. A run that starts and then hits `ImportError` during collection is
 *      a STARTED state, not a not-started one, and only the M22/M24 authority gets to say
 *      which — otherwise a dependency marker anywhere in a long log would demote a real run.
 *   3. Only with NO runner evidence do the not-started markers get to speak, most specific
 *      first (runner missing > dependency missing > command missing).
 *   4. Anything left is UNKNOWN. It is never quietly folded into a failure: an attempt whose
 *      output we cannot read is a gap in the evidence, not a result (§23.3).
 */
export function classifyValidationExecution(evidence: ValidationEvidence): ValidationAttemptRecord | null {
  const framework = classifyValidationAttempt(evidence);
  if (framework === null) return null;

  const command = evidence.command ?? "";
  const output = evidence.output ?? "";
  const exitStatus = readExitStatus(evidence);
  const ev: string[] = [];

  const base = {
    command,
    testFramework: framework,
    attempted: true as const,
    exitStatus,
  };

  // 1 — the tool layer declined.
  const policy = anyMatch(output, TOOL_POLICY_MARKERS);
  if (policy !== null) {
    return {
      ...base,
      runnerStarted: false,
      termination: "refused",
      state: "ATTEMPTED_NOT_STARTED",
      notStartedCause: "TOOL_POLICY_REFUSAL",
      environmentClassification: null,
      evidence: [`tool policy refused the command (${policy.source})`],
    };
  }

  // 2 — did a test runner actually produce output?
  const runnerMarker = anyMatch(output, RUNNER_STARTED_MARKERS);
  const timedOut = anyMatch(output, TIMEOUT_MARKERS);
  if (runnerMarker !== null) {
    ev.push(`runner output observed (${runnerMarker.source})`);
    if (timedOut !== null) {
      return {
        ...base,
        runnerStarted: true,
        termination: "timed_out",
        state: "STARTED_TIMED_OUT",
        notStartedCause: null,
        environmentClassification: null,
        evidence: [...ev, `timeout after the runner started (${timedOut.source})`],
      };
    }
    const outcome = readRunnerOutcome(framework, output, evidence.truncated === true);
    return {
      ...base,
      runnerStarted: true,
      termination: exitStatus.known || evidence.success !== null ? "exited" : "unknown",
      state: outcome.state,
      notStartedCause: null,
      environmentClassification: outcome.classification,
      evidence: [...ev, ...outcome.evidence],
    };
  }

  // 3 — no runner output: was the attempt prevented, and by what?
  if (timedOut !== null) {
    return {
      ...base,
      runnerStarted: false,
      termination: "timed_out",
      state: "ATTEMPTED_NOT_STARTED",
      notStartedCause: "TIMEOUT_BEFORE_RUNNER",
      environmentClassification: null,
      evidence: [`timed out with no runner output (${timedOut.source})`],
    };
  }
  const cause = notStartedCause(output);
  if (cause !== null) {
    return {
      ...base,
      runnerStarted: false,
      termination: cause.cause === "PERMISSION_FAILURE" ? "refused" : "exited",
      state: "ATTEMPTED_NOT_STARTED",
      notStartedCause: cause.cause,
      environmentClassification: null,
      evidence: [cause.evidence],
    };
  }

  // 4 — an attempt we cannot account for. Say so.
  return {
    ...base,
    runnerStarted: null,
    termination: "unknown",
    state: "UNKNOWN",
    notStartedCause: null,
    environmentClassification: null,
    evidence: [
      output.trim().length === 0
        ? "no output captured for this attempt"
        : "no test-runner evidence and no recognized prevention marker",
    ],
  };
}

/** Most specific prevention marker wins; returns null when none applies. */
function notStartedCause(output: string): { cause: NotStartedCause; evidence: string } | null {
  const runnerMissing = anyMatch(output, RUNNER_UNAVAILABLE_MARKERS);
  if (runnerMissing !== null) {
    return { cause: "TEST_RUNNER_UNAVAILABLE", evidence: `test runner not available (${runnerMissing.source})` };
  }
  const launch = anyMatch(output, LAUNCH_FAILURE_MARKERS);
  const dependency = anyMatch(output, DEPENDENCY_MARKERS);
  // A missing dependency is more informative than the generic launch failure it often causes,
  // but a bare `command not found` with no import trace is a launch failure and nothing more.
  if (dependency !== null) {
    return {
      cause: "DEPENDENCY_ENVIRONMENT_UNAVAILABLE",
      evidence: `dependency/import failure before any runner started (${dependency.source})`,
    };
  }
  if (launch !== null) {
    return { cause: "COMMAND_OR_TARGET_MISSING", evidence: `process was never launched (${launch.source})` };
  }
  const perm = anyMatch(output, PERMISSION_MARKERS);
  if (perm !== null) {
    return { cause: "PERMISSION_FAILURE", evidence: `permission denied before launch (${perm.source})` };
  }
  return null;
}

/**
 * Given that a runner DID start, what did it say? pytest is delegated to the M22/M24
 * authority verbatim. The other frameworks get a deliberately small reader here rather than a
 * second parser in src/: this is the only place that needs them, and inventing framework
 * parsers upstream would grow a surface no product consumer asked for.
 */
function readRunnerOutcome(
  framework: TestFramework | "repo_runner_script",
  output: string,
  truncated: boolean,
): { state: ValidationExecutionState; classification: string; evidence: string[] } {
  if (framework === "pytest") {
    const parsed = parsePytestOutcome(output, { truncated });
    const assessment = classifyTestEnvironmentOutcome({ parsedOutcome: parsed, output });
    const state: ValidationExecutionState =
      assessment.classification === "test_passed"
        ? "STARTED_PASSED"
        : assessment.classification === "test_failed" || assessment.classification === "test_error_target"
          ? "STARTED_FAILED"
          : assessment.classification === "test_error_environment" || assessment.classification === "test_not_run"
            ? "STARTED_INFRA_FAILURE"
            : "UNKNOWN";
    return { state, classification: assessment.classification, evidence: assessment.evidence };
  }
  // unittest / django runtests.py / tox verdict lines.
  if (/^OK\b/m.test(output) && /^Ran \d+ tests?/m.test(output)) {
    return { state: "STARTED_PASSED", classification: "test_passed", evidence: ["unittest reported OK"] };
  }
  if (/^FAILED \(/m.test(output) || /\b\d+ failed\b/.test(output)) {
    return { state: "STARTED_FAILED", classification: "test_failed", evidence: ["runner reported failures"] };
  }
  if (/^Ran 0 tests?/m.test(output)) {
    return { state: "STARTED_INFRA_FAILURE", classification: "test_not_run", evidence: ["runner selected no tests"] };
  }
  if (/\b\d+ passed\b/.test(output) || /\bcongratulations :\)/.test(output)) {
    return { state: "STARTED_PASSED", classification: "test_passed", evidence: ["runner reported passes"] };
  }
  return {
    state: "UNKNOWN",
    classification: "unknown",
    evidence: ["runner output observed but no verdict could be read from it"],
  };
}

// ---------------------------------------------------------------------------------------
// Arm scope
// ---------------------------------------------------------------------------------------

export interface ArmValidationSummary {
  readonly state: ValidationExecutionState;
  readonly attempts: readonly ValidationAttemptRecord[];
  readonly attemptCount: number;
  readonly runnerStartedCount: number;
  readonly notStartedCount: number;
  readonly unknownCount: number;
  readonly notStartedCauses: Readonly<Record<string, number>>;
}

/**
 * Roll one arm's calls up to a single state. The arm's state is its BEST-EVIDENCED outcome,
 * because an arm that eventually got a suite running did have validation capability even if
 * it fought the environment first; the individual attempts keep the full story.
 *
 * The one state that is not "best" is `ATTEMPTED_NOT_STARTED`: it outranks `UNKNOWN` because
 * a proven prevention is stronger evidence than an unreadable attempt.
 */
export function summarizeArmValidation(calls: readonly ValidationEvidence[]): ArmValidationSummary {
  const attempts = calls
    .map((c) => classifyValidationExecution(c))
    .filter((r): r is ValidationAttemptRecord => r !== null);

  const causes: Record<string, number> = {};
  for (const a of attempts) {
    if (a.notStartedCause !== null) causes[a.notStartedCause] = (causes[a.notStartedCause] ?? 0) + 1;
  }
  const counts = {
    attemptCount: attempts.length,
    runnerStartedCount: attempts.filter((a) => a.runnerStarted === true).length,
    notStartedCount: attempts.filter((a) => a.state === "ATTEMPTED_NOT_STARTED").length,
    unknownCount: attempts.filter((a) => a.state === "UNKNOWN").length,
    notStartedCauses: causes,
  };

  if (attempts.length === 0) {
    return { state: "NOT_ATTEMPTED", attempts, ...counts };
  }
  const RANK: readonly ValidationExecutionState[] = [
    "STARTED_FAILED",
    "STARTED_PASSED",
    "STARTED_TIMED_OUT",
    "STARTED_INFRA_FAILURE",
    "ATTEMPTED_NOT_STARTED",
    "UNKNOWN",
  ];
  const state = RANK.find((s) => attempts.some((a) => a.state === s)) ?? "UNKNOWN";
  return { state, attempts, ...counts };
}
