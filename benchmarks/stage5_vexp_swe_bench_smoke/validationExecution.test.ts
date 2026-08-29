// M187 — regression coverage for validation-execution truthfulness.
//
// The fixtures are REAL preserved M183 output shapes, not invented ones. Where a test quotes
// a string it is because that string appeared in the corpus; the classifier is asserted on
// semantic markers, so the exact surrounding prose is free to vary (§22).

import { describe, expect, test } from "bun:test";
import {
  classifyValidationAttempt,
  classifyValidationExecution,
  readExitStatus,
  summarizeArmValidation,
  type ValidationEvidence,
} from "./validationExecution";

const call = (over: Partial<ValidationEvidence>): ValidationEvidence => ({
  tool: "Bash",
  command: null,
  output: null,
  success: null,
  exitCode: null,
  exitCodeSource: null,
  ...over,
});

// Real preserved M183 outputs, verbatim heads.
const PYTEST_PASS = `============================= test session starts ==============================
platform linux -- Python 3.9.25, pytest-8.4.2, pluggy-1.6.0
rootdir: /repo
collected 7 items

sympy/physics/quantum/tests/test_tensorproduct.py .......                 [100%]

============================== 7 passed in 0.42s ===============================`;

const PYTEST_FAIL = `============================= test session starts ==============================
platform linux -- Python 3.9.25, pytest-8.4.2, pluggy-1.6.0
collected 7 items

tests/test_x.py F......                                                  [100%]

=================================== FAILURES ===================================
______________________________ test_thing ______________________________
>       assert 0
E       assert 0
=========================== 1 failed, 6 passed in 0.5s =========================`;

const PYTEST_COLLECTION_ERROR = `============================= test session starts ==============================
platform linux -- Python 3.13.12, pytest-0.1.dev1+ge6e300e72
rootdir: /tmp
collected 0 items / 1 error

==================================== ERRORS ====================================
______________________ ERROR collecting test_skip_loc.py _______________________
ImportError: cannot import name 'x'`;

const RUNNER_MISSING = "/usr/bin/python: No module named pytest";
const PIP_MISSING = "Exit code 127\n/usr/bin/bash: line 1: pip: command not found";
const DJANGO_IMPORT_FAIL = `Traceback (most recent call last):
  File "/repo/tests/runtests.py", line 14, in <module>
    import django
ModuleNotFoundError: No module named 'django'`;
const TOOL_REFUSAL =
  "Dangerous rm operation detected: '/tmp/pytest_test_dir'\n\nThis command would remove a workspace directory. This requires explicit approval and cannot be auto-allowed by permission rules.";
const UNITTEST_OK = "Creating test database...\nRan 12 tests in 3.201s\n\nOK";
const UNITTEST_FAILED = "Ran 12 tests in 3.201s\n\nFAILED (failures=2)";

describe("attempt detection is a property of the command alone", () => {
  test("a non-test command is not an attempt", () => {
    expect(classifyValidationAttempt(call({ command: "cat setup.py" }))).toBeNull();
    expect(classifyValidationExecution(call({ command: "grep -rn foo ." }))).toBeNull();
  });

  test("pytest and django's runtests.py both count as attempts", () => {
    expect(classifyValidationAttempt(call({ command: "python -m pytest tests/ -x" }))).toBe("pytest");
    expect(classifyValidationAttempt(call({ command: "python tests/runtests.py model_inheritance" }))).toBe(
      "repo_runner_script",
    );
  });

  test("an attempt stays an attempt no matter how badly it went", () => {
    const r = classifyValidationExecution(call({ command: "pytest tests/", output: RUNNER_MISSING }));
    expect(r?.attempted).toBe(true);
  });
});

describe("§26 — the mandated state mapping", () => {
  test("no attempt at all => NOT_ATTEMPTED", () => {
    expect(summarizeArmValidation([call({ command: "ls -la" }), call({ command: "cat x.py" })]).state).toBe(
      "NOT_ATTEMPTED",
    );
  });

  test("test-like command issued but the runner never starts => ATTEMPTED_NOT_STARTED", () => {
    const r = classifyValidationExecution(call({ command: "python -m pytest tests/", output: RUNNER_MISSING }));
    expect(r?.state).toBe("ATTEMPTED_NOT_STARTED");
    expect(r?.notStartedCause).toBe("TEST_RUNNER_UNAVAILABLE");
    expect(r?.runnerStarted).toBe(false);
  });

  test("runner starts and tests pass => STARTED_PASSED", () => {
    const r = classifyValidationExecution(call({ command: "pytest tests/x.py", output: PYTEST_PASS }));
    expect(r?.state).toBe("STARTED_PASSED");
    expect(r?.runnerStarted).toBe(true);
  });

  test("runner starts and tests fail => STARTED_FAILED", () => {
    const r = classifyValidationExecution(call({ command: "pytest tests/x.py", output: PYTEST_FAIL }));
    expect(r?.state).toBe("STARTED_FAILED");
    expect(r?.runnerStarted).toBe(true);
  });

  test("execution times out after the runner started => STARTED_TIMED_OUT", () => {
    const r = classifyValidationExecution(
      call({ command: "pytest tests/", output: `${PYTEST_PASS}\nCommand timed out after 120s` }),
    );
    expect(r?.state).toBe("STARTED_TIMED_OUT");
    expect(r?.termination).toBe("timed_out");
  });

  test("timeout BEFORE the runner started is not a started state", () => {
    const r = classifyValidationExecution(
      call({ command: "pytest tests/", output: "Command timed out after 120s" }),
    );
    expect(r?.state).toBe("ATTEMPTED_NOT_STARTED");
    expect(r?.notStartedCause).toBe("TIMEOUT_BEFORE_RUNNER");
  });

  test("insufficient evidence => UNKNOWN, never a failure", () => {
    const r = classifyValidationExecution(call({ command: "pytest tests/", output: "" }));
    expect(r?.state).toBe("UNKNOWN");
    expect(r?.runnerStarted).toBeNull();
  });
});

describe("§11/§12 — infrastructure refusal is never a test failure", () => {
  test("`command not found` is not a failing test", () => {
    const r = classifyValidationExecution(call({ command: "pytest tests/", output: PIP_MISSING, exitCode: 127 }));
    expect(r?.state).toBe("ATTEMPTED_NOT_STARTED");
    expect(r?.state).not.toBe("STARTED_FAILED");
  });

  test("a missing repository dependency is not a failing test", () => {
    const r = classifyValidationExecution(
      call({ command: "python tests/runtests.py migrations", output: DJANGO_IMPORT_FAIL }),
    );
    expect(r?.state).toBe("ATTEMPTED_NOT_STARTED");
    expect(r?.notStartedCause).toBe("DEPENDENCY_ENVIRONMENT_UNAVAILABLE");
  });

  test("a tool-policy refusal is neither a test failure nor an environment defect", () => {
    const r = classifyValidationExecution(call({ command: "pytest /tmp/x.py", output: TOOL_REFUSAL }));
    expect(r?.state).toBe("ATTEMPTED_NOT_STARTED");
    expect(r?.notStartedCause).toBe("TOOL_POLICY_REFUSAL");
    expect(r?.termination).toBe("refused");
  });

  test("the benchmark's own host-pip firewall reads as tool policy, not a broken environment", () => {
    const r = classifyValidationExecution(
      call({ command: "pip install -e . && pytest", output: "VTRACE_HOST_PIP_BLOCKED\nVTRACE blocked this command" }),
    );
    expect(r?.notStartedCause).toBe("TOOL_POLICY_REFUSAL");
  });

  test("a runner that STARTED and then hit an import error is a started state, not a refusal", () => {
    const r = classifyValidationExecution(
      call({ command: "pytest /tmp/test_skip_loc.py", output: PYTEST_COLLECTION_ERROR }),
    );
    expect(r?.runnerStarted).toBe(true);
    expect(r?.state).toBe("STARTED_INFRA_FAILURE");
    // and it must NOT be scored as the patch failing its tests
    expect(r?.state).not.toBe("STARTED_FAILED");
  });
});

describe("pytest's own launcher diagnostics prove the runner ran", () => {
  // These three shapes were produced by the M187 probes against real benchmark repositories.
  // Before the probes, all three read as ATTEMPTED_NOT_STARTED, which understated harness
  // capability: the runner WAS reachable, the repository's dependencies were not.
  test("a conftest that fails to import is a started runner, not a missing one", () => {
    const r = classifyValidationExecution(
      call({
        command: "python -m pytest tests/test_structures.py -q",
        output: `Exit code 4\nImportError while loading conftest '/repo/tests/conftest.py'.\ntests/__init__.py:8: in <module>\n    from urllib3.exceptions import SNIMissingWarning\nE   ImportError: cannot import name 'SNIMissingWarning'`,
        exitCode: 4,
        exitCodeSource: "output_prefix",
      }),
    );
    expect(r?.runnerStarted).toBe(true);
    expect(r?.state).toBe("STARTED_INFRA_FAILURE");
    expect(r?.state).not.toBe("STARTED_FAILED");
  });

  test("an empty selection is a started runner reporting nothing to run", () => {
    const r = classifyValidationExecution(
      call({
        command: "python -m pytest /nonexistent/test_nothing.py -q",
        output: "Exit code 4\n\nno tests ran in 0.00s\nERROR: file or directory not found: /nonexistent/test_nothing.py",
        exitCode: 4,
        exitCodeSource: "output_prefix",
      }),
    );
    expect(r?.runnerStarted).toBe(true);
    expect(r?.environmentClassification).toBe("test_not_run");
  });

  test("but a runner that is not installed at all is still ATTEMPTED_NOT_STARTED", () => {
    const r = classifyValidationExecution(
      call({ command: "nosetests tests/", output: "Exit code 127\nbash: nosetests: command not found", exitCode: 127 }),
    );
    expect(r?.runnerStarted).toBe(false);
    expect(r?.notStartedCause).toBe("TEST_RUNNER_UNAVAILABLE");
  });
});

describe("§9/§26 — exitCode = null must not mean failed, and must not mean did-not-execute", () => {
  test("null exit code with passing runner output is still a pass", () => {
    const r = classifyValidationExecution(
      call({ command: "pytest tests/x.py", output: PYTEST_PASS, exitCode: null, success: null }),
    );
    expect(r?.state).toBe("STARTED_PASSED");
    expect(r?.exitStatus.known).toBe(false);
  });

  test("null exit code with no other evidence is UNKNOWN, not NOT_STARTED", () => {
    const r = classifyValidationExecution(call({ command: "pytest tests/", output: "  ", exitCode: null }));
    expect(r?.state).toBe("UNKNOWN");
  });

  test("exit status is never synthesized to zero from absence", () => {
    const s = readExitStatus(call({ command: "pytest tests/", output: "whatever" }));
    expect(s.known).toBe(false);
  });

  test("a piped command's success flag does not become a known exit status", () => {
    // The exact M183 shape: `... | head -100` returns head's 0 while pytest was never found.
    const s = readExitStatus(
      call({ command: "python -m pytest tests/ 2>&1 | head -100", output: RUNNER_MISSING, success: true }),
    );
    expect(s.known).toBe(false);
    const r = classifyValidationExecution(
      call({ command: "python -m pytest tests/ 2>&1 | head -100", output: RUNNER_MISSING, success: true }),
    );
    expect(r?.state).toBe("ATTEMPTED_NOT_STARTED");
  });

  test("an unpiped success flag does yield a known zero", () => {
    const s = readExitStatus(call({ command: "pytest tests/x.py", output: PYTEST_PASS, success: true }));
    expect(s).toEqual({ known: true, code: 0, source: "output_prefix" });
  });

  test("an exit code recovered from the output prefix is reported with its source", () => {
    const s = readExitStatus(
      call({ command: "pytest tests/", output: PIP_MISSING, exitCode: 127, exitCodeSource: "output_prefix" }),
    );
    expect(s).toEqual({ known: true, code: 127, source: "output_prefix" });
  });
});

describe("§28 — classification cannot depend on the task outcome", () => {
  test("the evidence surface carries no outcome to depend on", () => {
    // Structural, not behavioural: if this ever fails, someone widened the input.
    const allowed = ["command", "exitCode", "exitCodeSource", "output", "success", "tool", "truncated"];
    const keys = Object.keys(call({ command: "pytest", output: "x", truncated: false }));
    for (const k of keys) expect(allowed).toContain(k);
    for (const forbidden of ["resolved", "goldPatch", "failToPass", "instanceId"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  test("identical evidence classifies identically regardless of any caller context", () => {
    const e = call({ command: "pytest tests/x.py", output: PYTEST_FAIL });
    expect(classifyValidationExecution(e)).toEqual(classifyValidationExecution({ ...e }));
  });
});

describe("non-pytest runners", () => {
  test("django/unittest OK is a pass", () => {
    const r = classifyValidationExecution(
      call({ command: "python tests/runtests.py migrations", output: UNITTEST_OK }),
    );
    expect(r?.state).toBe("STARTED_PASSED");
  });

  test("django/unittest FAILED is a failure", () => {
    const r = classifyValidationExecution(
      call({ command: "python tests/runtests.py migrations", output: UNITTEST_FAILED }),
    );
    expect(r?.state).toBe("STARTED_FAILED");
  });
});

describe("arm roll-up", () => {
  test("an arm that eventually got a suite running is not counted as prevented", () => {
    const s = summarizeArmValidation([
      call({ command: "pytest tests/", output: RUNNER_MISSING }),
      call({ command: "pytest tests/", output: PIP_MISSING, exitCode: 127 }),
      call({ command: ".venv/bin/python -m pytest tests/", output: PYTEST_PASS }),
    ]);
    expect(s.state).toBe("STARTED_PASSED");
    expect(s.attemptCount).toBe(3);
    expect(s.runnerStartedCount).toBe(1);
    expect(s.notStartedCount).toBe(2);
  });

  test("an arm whose every attempt was prevented reports prevention, with causes counted", () => {
    const s = summarizeArmValidation([
      call({ command: "pytest tests/", output: RUNNER_MISSING }),
      call({ command: "python tests/runtests.py x", output: DJANGO_IMPORT_FAIL }),
    ]);
    expect(s.state).toBe("ATTEMPTED_NOT_STARTED");
    expect(s.notStartedCauses).toEqual({
      TEST_RUNNER_UNAVAILABLE: 1,
      DEPENDENCY_ENVIRONMENT_UNAVAILABLE: 1,
    });
  });

  test("a proven prevention outranks an unreadable attempt", () => {
    const s = summarizeArmValidation([
      call({ command: "pytest tests/", output: "" }),
      call({ command: "pytest tests/", output: RUNNER_MISSING }),
    ]);
    expect(s.state).toBe("ATTEMPTED_NOT_STARTED");
  });
});
