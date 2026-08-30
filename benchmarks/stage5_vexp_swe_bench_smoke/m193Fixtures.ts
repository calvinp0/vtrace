/**
 * M193 §51 — synthetic lifecycle fixtures.
 *
 * Deterministic, model-free inputs covering every lifecycle shape the live
 * corpus can produce, with their classifications FROZEN before live data
 * exists. `run_stage5_m193_analyze.ts` emits expected-vs-actual; the unit test
 * asserts the same table. If M194 ever needs to change a classifier, these are
 * the fixtures whose expectations it must justify changing.
 */

import {
  type ArmOutcome,
  type CorpusAdequacy,
  type PatchSnapshot,
  type ProvenanceState,
  type RunValidity,
  type SemanticTestResult,
  type StreamCapture,
  type TraceEvent,
  type ValidationRecord,
} from "./m193Acquisition";

const CHECKOUT = "/testbed";

function streams(stdout: string, stderr = "", merged: string | null = null): StreamCapture {
  return {
    stdout,
    stderr,
    mergedStream: merged ?? (stderr ? `${stdout}${stderr}` : stdout),
    mergedStreamComplete: true,
  };
}

/** A pytest run that passes. */
const PYTEST_PASS = streams(
  "============================= test session starts ==============================\ncollected 3 items\n\ntests/test_x.py ...                                                      [100%]\n\n============================== 3 passed in 0.42s ===============================\n",
);

/** A pytest run that fails. */
const PYTEST_FAIL = streams(
  "============================= test session starts ==============================\ncollected 3 items\n\ntests/test_x.py .F.                                                      [100%]\n\n=================================== FAILURES ===================================\n________________________________ test_roundtrip ________________________________\nE   AssertionError: assert 1 == 2\n=========================== short test summary info ============================\nFAILED tests/test_x.py::test_roundtrip\n========================= 1 failed, 2 passed in 0.51s ==========================\n",
);

/**
 * §23 — the demultiplexing trap. The runner banner surfaces on stderr (set -x
 * echoes it) while results land on stdout. A classifier reading stdout alone
 * would decide no runner ever started and lose the whole execution.
 */
const SPLIT_STREAM: StreamCapture = {
  stdout: "tests/test_x.py ..F\n========================= 1 failed, 2 passed in 0.33s ==========================\n",
  stderr: "+ python -m pytest tests/test_x.py\n============================= test session starts ==============================\ncollected 3 items\n",
  mergedStream:
    "+ python -m pytest tests/test_x.py\n============================= test session starts ==============================\ncollected 3 items\ntests/test_x.py ..F\n========================= 1 failed, 2 passed in 0.33s ==========================\n",
  mergedStreamComplete: true,
};

/** The shell never reached a runner — an import blew up in the preamble. */
const RUNNER_NOT_REACHED = streams(
  "",
  "Traceback (most recent call last):\n  File \"<string>\", line 1\nModuleNotFoundError: No module named 'pytest'\n",
);

function validation(over: Partial<ValidationRecord> = {}): ValidationRecord {
  return {
    isValidationAttempt: true,
    workdir: CHECKOUT,
    routedTo: "container",
    shell: { processStarted: true, exitCode: 0, timedOut: false, signal: null, durationMs: 900 },
    streams: PYTEST_PASS,
    runnerStarted: true,
    semanticTestResult: "PASSED",
    provenance: "EDITED_CHECKOUT_CONFIRMED",
    moduleFile: `${CHECKOUT}/pkg/__init__.py`,
    ...over,
  };
}

interface Step {
  type: TraceEvent["type"];
  toolName?: string;
  validation?: ValidationRecord;
  snapshotBoundary?: PatchSnapshot["boundary"];
  diffHash?: string;
}

/** Assembles dense ordinals + aligned snapshots so every fixture is well-formed
 *  by construction, and ordering defects have to be introduced deliberately. */
function build(armId: string, instanceId: string, repo: string, steps: Step[], over: Partial<ArmOutcome> = {}): ArmOutcome {
  const events: TraceEvent[] = [];
  const snapshots: PatchSnapshot[] = [];
  let stateHash = "sha256:empty";
  steps.forEach((s, i) => {
    if (s.diffHash) stateHash = s.diffHash;
    const ev: TraceEvent = {
      ordinal: i,
      ts: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(),
      type: s.type,
      stateHash,
      ...(s.toolName ? { toolName: s.toolName } : {}),
      ...(s.validation ? { validation: s.validation } : {}),
    };
    if (s.snapshotBoundary) {
      const snap: PatchSnapshot = {
        ordinal: i,
        boundary: s.snapshotBoundary,
        diffHash: stateHash,
        diffBytes: stateHash === "sha256:empty" ? 0 : 420,
      };
      snapshots.push(snap);
      ev.snapshot = snap;
    }
    events.push(ev);
  });

  return {
    armId,
    instanceId,
    repo,
    preflightPassed: true,
    agentStarted: true,
    termination: "COMPLETED",
    authoritativeCheckoutMaintained: true,
    treatmentAbsenceVerified: true,
    telemetryComplete: true,
    traceWellFormed: true,
    finalPatchExtracted: true,
    finalPatchIsEmpty: false,
    evaluatorRan: true,
    resolved: false,
    events,
    snapshots,
    ...over,
  };
}

export interface FixtureExpectation {
  id: string;
  description: string;
  arm: ArmOutcome;
  expect: {
    validity: RunValidity;
    i6Usable: boolean;
    i6UnusableReason: string | null;
    runtimeDiagnosisUsable: boolean;
    postEditValidationAttempts: number;
    usableValidationEvents: number;
    postValidationRevisions: number;
    wrongSourceEvents: number;
  };
}

const SETUP: Step = { type: "agent_start", snapshotBoundary: "SETUP" };
const EDIT = (hash: string): Step => ({ type: "tool_call", toolName: "Edit", snapshotBoundary: "AFTER_EDIT", diffHash: hash });
const PRE_VAL: Step = { type: "patch_snapshot", snapshotBoundary: "BEFORE_VALIDATION" };
const POST_VAL: Step = { type: "patch_snapshot", snapshotBoundary: "AFTER_VALIDATION" };
const VAL = (v: ValidationRecord): Step => ({ type: "tool_call", toolName: "Bash", validation: v });
const END: Step = { type: "agent_end", snapshotBoundary: "BEFORE_SUBMIT" };

export function syntheticFixtures(): FixtureExpectation[] {
  return [
    {
      id: "F01_EDIT_NO_VALIDATION",
      description: "edit → no validation → final. A valid run; the agent is allowed not to test (§39).",
      arm: build("F01", "django__django-10880", "django/django", [SETUP, EDIT("sha256:a1"), END]),
      expect: {
        validity: "RUN_VALID",
        i6Usable: false,
        i6UnusableReason: "NO_POST_EDIT_VALIDATION_ATTEMPT",
        runtimeDiagnosisUsable: false,
        postEditValidationAttempts: 0,
        usableValidationEvents: 0,
        postValidationRevisions: 0,
        wrongSourceEvents: 0,
      },
    },
    {
      id: "F02_EDIT_VALIDATION_PASS",
      description: "edit → validation pass → final.",
      arm: build("F02", "astropy__astropy-14365", "astropy/astropy", [
        SETUP, EDIT("sha256:b1"), PRE_VAL, VAL(validation()), POST_VAL, END,
      ]),
      expect: {
        validity: "RUN_VALID",
        i6Usable: true,
        i6UnusableReason: null,
        runtimeDiagnosisUsable: false,
        postEditValidationAttempts: 1,
        usableValidationEvents: 1,
        postValidationRevisions: 0,
        wrongSourceEvents: 0,
      },
    },
    {
      id: "F03_FAIL_REVISE_PASS",
      description: "edit → validation fail → revision → validation pass. The shape I6 exists to study.",
      arm: build("F03", "sympy__sympy-12419", "sympy/sympy", [
        SETUP,
        EDIT("sha256:c1"),
        PRE_VAL,
        VAL(validation({ streams: PYTEST_FAIL, semanticTestResult: "MIXED", shell: { processStarted: true, exitCode: 1, timedOut: false, signal: null, durationMs: 1200 } })),
        POST_VAL,
        EDIT("sha256:c2"),
        PRE_VAL,
        VAL(validation()),
        POST_VAL,
        END,
      ]),
      expect: {
        validity: "RUN_VALID",
        i6Usable: true,
        i6UnusableReason: null,
        runtimeDiagnosisUsable: true,
        postEditValidationAttempts: 2,
        usableValidationEvents: 2,
        postValidationRevisions: 1,
        wrongSourceEvents: 0,
      },
    },
    {
      id: "F04_FAIL_NO_REVISION",
      description: "edit → validation fail → no revision → final. Usable, and a negative repair observation.",
      arm: build("F04", "sphinx-doc__sphinx-7462", "sphinx-doc/sphinx", [
        SETUP,
        EDIT("sha256:d1"),
        PRE_VAL,
        VAL(validation({ streams: PYTEST_FAIL, semanticTestResult: "MIXED", shell: { processStarted: true, exitCode: 1, timedOut: false, signal: null, durationMs: 800 } })),
        POST_VAL,
        END,
      ]),
      expect: {
        validity: "RUN_VALID",
        i6Usable: true,
        i6UnusableReason: null,
        runtimeDiagnosisUsable: true,
        postEditValidationAttempts: 1,
        usableValidationEvents: 1,
        postValidationRevisions: 0,
        wrongSourceEvents: 0,
      },
    },
    {
      id: "F05_RUNNER_NOT_STARTED",
      description: "validation attempted but the runner never started. Attempt counted; result is not.",
      arm: build("F05", "pylint-dev__pylint-4551", "pylint-dev/pylint", [
        SETUP,
        EDIT("sha256:e1"),
        PRE_VAL,
        VAL(validation({
          streams: RUNNER_NOT_REACHED,
          runnerStarted: false,
          semanticTestResult: "UNKNOWN",
          provenance: "RUNNER_NOT_STARTED",
          moduleFile: null,
          shell: { processStarted: true, exitCode: 1, timedOut: false, signal: null, durationMs: 120 },
        })),
        POST_VAL,
        END,
      ]),
      expect: {
        validity: "RUN_VALID",
        i6Usable: false,
        i6UnusableReason: "NO_TRUSTWORTHY_VALIDATION_RESULT",
        runtimeDiagnosisUsable: false,
        postEditValidationAttempts: 1,
        usableValidationEvents: 0,
        postValidationRevisions: 0,
        wrongSourceEvents: 0,
      },
    },
    {
      id: "F06_WRONG_SOURCE",
      description: "M191/M192's failure: tests pass loudly against an installed copy. Never a usable result (§20).",
      arm: build("F06", "psf__requests-1142", "psf/requests", [
        SETUP,
        EDIT("sha256:f1"),
        PRE_VAL,
        VAL(validation({
          provenance: "INSTALLED_COPY_CONFIRMED",
          moduleFile: "/opt/miniconda3/lib/python3.9/site-packages/requests/__init__.py",
        })),
        POST_VAL,
        END,
      ]),
      expect: {
        validity: "RUN_VALID",
        i6Usable: false,
        i6UnusableReason: "NO_TRUSTWORTHY_VALIDATION_RESULT",
        runtimeDiagnosisUsable: false,
        postEditValidationAttempts: 1,
        usableValidationEvents: 0,
        postValidationRevisions: 0,
        wrongSourceEvents: 1,
      },
    },
    {
      id: "F07_TIMEOUT",
      description: "validation timed out. No exit code is invented (§17); the episode is not usable.",
      arm: build("F07", "matplotlib__matplotlib-22719", "matplotlib/matplotlib", [
        SETUP,
        EDIT("sha256:g1"),
        PRE_VAL,
        VAL(validation({
          streams: streams("============================= test session starts ==============================\ncollected 900 items\n"),
          semanticTestResult: "UNKNOWN",
          provenance: "EDITED_CHECKOUT_CONFIRMED",
          shell: { processStarted: true, exitCode: null, timedOut: true, signal: "SIGKILL", durationMs: 600000 },
        })),
        POST_VAL,
        END,
      ]),
      expect: {
        validity: "RUN_VALID",
        i6Usable: false,
        i6UnusableReason: "NO_TRUSTWORTHY_VALIDATION_RESULT",
        runtimeDiagnosisUsable: false,
        postEditValidationAttempts: 1,
        usableValidationEvents: 0,
        postValidationRevisions: 0,
        wrongSourceEvents: 0,
      },
    },
    {
      id: "F08_INFRA_FAILURE",
      description: "the container died mid-run. An experiment outcome, never a coding failure (§38).",
      arm: build(
        "F08",
        "pydata__xarray-2905",
        "pydata/xarray",
        [SETUP, EDIT("sha256:h1"), END],
        { termination: "HARNESS_CRASH", evaluatorRan: false, finalPatchExtracted: false, resolved: null },
      ),
      expect: {
        validity: "RUN_INVALID",
        i6Usable: false,
        i6UnusableReason: "RUN_INVALID",
        runtimeDiagnosisUsable: false,
        postEditValidationAttempts: 0,
        usableValidationEvents: 0,
        postValidationRevisions: 0,
        wrongSourceEvents: 0,
      },
    },
    {
      id: "F09_EMPTY_PATCH",
      description: "the agent produced nothing. A truthful empty patch is a VALID run (§39).",
      arm: build(
        "F09",
        "pallets__flask-5014",
        "pallets/flask",
        [SETUP, { type: "assistant_text" }, END],
        { finalPatchIsEmpty: true },
      ),
      expect: {
        validity: "RUN_VALID",
        i6Usable: false,
        i6UnusableReason: "NO_SOURCE_EDIT",
        runtimeDiagnosisUsable: false,
        postEditValidationAttempts: 0,
        usableValidationEvents: 0,
        postValidationRevisions: 0,
        wrongSourceEvents: 0,
      },
    },
    {
      id: "F10_MULTIPLE_CYCLES",
      description: "three validation cycles with two revisions, and the runner banner split across streams (§23).",
      arm: build("F10", "scikit-learn__scikit-learn-10844", "scikit-learn/scikit-learn", [
        SETUP,
        EDIT("sha256:i1"),
        PRE_VAL,
        VAL(validation({ streams: SPLIT_STREAM, semanticTestResult: "MIXED", shell: { processStarted: true, exitCode: 1, timedOut: false, signal: null, durationMs: 700 } })),
        POST_VAL,
        EDIT("sha256:i2"),
        PRE_VAL,
        VAL(validation({ streams: PYTEST_FAIL, semanticTestResult: "MIXED", shell: { processStarted: true, exitCode: 1, timedOut: false, signal: null, durationMs: 700 } })),
        POST_VAL,
        EDIT("sha256:i3"),
        PRE_VAL,
        VAL(validation()),
        POST_VAL,
        END,
      ]),
      expect: {
        validity: "RUN_VALID",
        i6Usable: true,
        i6UnusableReason: null,
        runtimeDiagnosisUsable: true,
        postEditValidationAttempts: 3,
        usableValidationEvents: 3,
        postValidationRevisions: 2,
        wrongSourceEvents: 0,
      },
    },
    {
      id: "F11_AMBIGUOUS_UNPINNED_WORKDIR",
      description:
        "a CWD_DEPENDENT repository validated from outside the checkout root. Path says checkout, but nothing proves it would have won — AMBIGUOUS, not confirmed (§20/§21).",
      arm: build("F12_ARM", "psf__requests-1142", "psf/requests", [
        SETUP,
        EDIT("sha256:j1"),
        PRE_VAL,
        VAL(validation({ workdir: "/", provenance: "AMBIGUOUS_SOURCE" })),
        POST_VAL,
        END,
      ]),
      expect: {
        validity: "RUN_VALID",
        i6Usable: false,
        i6UnusableReason: "NO_TRUSTWORTHY_VALIDATION_RESULT",
        runtimeDiagnosisUsable: false,
        postEditValidationAttempts: 1,
        usableValidationEvents: 0,
        postValidationRevisions: 0,
        wrongSourceEvents: 0,
      },
    },
    {
      id: "F12_TREATMENT_CONTAMINATION",
      description: "an otherwise clean run whose startup audit found VTRACE exposure. Invalid regardless of quality (§33).",
      arm: build(
        "F12",
        "pytest-dev__pytest-10051",
        "pytest-dev/pytest",
        [SETUP, EDIT("sha256:k1"), PRE_VAL, VAL(validation()), POST_VAL, END],
        { treatmentAbsenceVerified: false },
      ),
      expect: {
        validity: "RUN_INVALID",
        i6Usable: false,
        i6UnusableReason: "RUN_INVALID",
        runtimeDiagnosisUsable: false,
        postEditValidationAttempts: 1,
        usableValidationEvents: 1,
        postValidationRevisions: 0,
        wrongSourceEvents: 0,
      },
    },
  ];
}

/** §51 — the corpus-level expectation over the whole fixture set, also frozen. */
export const FIXTURE_CORPUS_EXPECTATION: {
  validRuns: number;
  i6UsableArms: number;
  runtimeDiagnosisUsableArms: number;
  adequacy: CorpusAdequacy;
} = {
  validRuns: 10,
  i6UsableArms: 4,
  runtimeDiagnosisUsableArms: 3,
  adequacy: "INADEQUATE",
};

export const DEMUX_TRAP_STREAMS: StreamCapture = SPLIT_STREAM;
export const PYTEST_PASS_STREAMS: StreamCapture = PYTEST_PASS;
export const PYTEST_FAIL_STREAMS: StreamCapture = PYTEST_FAIL;
export const RUNNER_NOT_REACHED_STREAMS: StreamCapture = RUNNER_NOT_REACHED;
export const FIXTURE_PROVENANCE_STATES: readonly ProvenanceState[] = Object.freeze([
  "EDITED_CHECKOUT_CONFIRMED",
  "INSTALLED_COPY_CONFIRMED",
  "AMBIGUOUS_SOURCE",
  "RUNNER_NOT_STARTED",
  "NOT_APPLICABLE",
]);
export const FIXTURE_SEMANTIC_STATES: readonly SemanticTestResult[] = Object.freeze([
  "PASSED",
  "FAILED",
  "MIXED",
  "NO_TESTS_RAN",
  "UNKNOWN",
]);
