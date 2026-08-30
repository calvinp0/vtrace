import { describe, expect, test } from "bun:test";
import {
  assessRepository,
  breadthGate,
  classifyExecution,
  classifyProvenance,
  instanceImageKey,
  isM192OwnedContainer,
  selectPreregisteredInstances,
  substrateVerdict,
  type BenchmarkRow,
  type CommandResult,
  type ReadinessChecks,
  START_TEST_OUTPUT,
} from "./m192Substrate";

function cmd(over: Partial<CommandResult> = {}): CommandResult {
  return {
    processStarted: true,
    exitCode: 0,
    stdout: `${START_TEST_OUTPUT}\nok\n`,
    stderr: "",
    timedOut: false,
    durationMs: 10,
    ...over,
  };
}

function checks(over: Partial<ReadinessChecks> = {}): ReadinessChecks {
  return {
    v1EnvironmentStarts: true,
    v2SourceReadable: true,
    v3SourceWritable: true,
    v4MutationPersists: true,
    v5TestRunnerStarts: true,
    v6PassingObservable: true,
    v7FailingObservable: true,
    v8SourceProvenance: "EDITED_CHECKOUT_CONFIRMED",
    v9MutationAffectsValidation: true,
    v10SourceRestored: true,
    v11TelemetryTruthful: true,
    v12NoPrivilegedBypass: true,
    ...over,
  };
}

describe("execution classification preserves exit status and start/failure distinctions", () => {
  test("a command that never produced a process is not a test failure", () => {
    expect(classifyExecution(cmd({ processStarted: false, exitCode: null, stdout: "" })))
      .toBe("PROCESS_NOT_STARTED");
  });

  test("runner failure differs from infrastructure failure", () => {
    // Shell ran, runner never reached, and the reason is a missing dependency.
    expect(
      classifyExecution(
        cmd({ exitCode: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'numpy'" }),
      ),
    ).toBe("STARTED_INFRA_FAILURE");

    // Shell ran, runner never reached, no recognisable infra cause.
    expect(classifyExecution(cmd({ exitCode: 2, stdout: "usage: pytest", stderr: "" })))
      .toBe("STARTED_RUNNER_NOT_REACHED");
  });

  test("exit status is preserved once the runner is reached", () => {
    expect(classifyExecution(cmd({ exitCode: 0 }))).toBe("STARTED_TESTS_PASSED");
    expect(classifyExecution(cmd({ exitCode: 1 }))).toBe("STARTED_TESTS_FAILED");
    expect(classifyExecution(cmd({ exitCode: null }))).toBe("UNKNOWN");
  });

  test("timeout outranks exit status", () => {
    expect(classifyExecution(cmd({ timedOut: true, exitCode: 137 }))).toBe("STARTED_TIMEOUT");
  });
});

describe("source provenance is independent of test pass/fail", () => {
  test("a passing test against an installed copy is still wrong-source", () => {
    expect(
      classifyProvenance({
        moduleFile: "/opt/miniconda3/envs/testbed/lib/python3.9/site-packages/sympy/__init__.py",
        checkoutRoot: "/testbed",
        mutationExecuted: false,
        runnerStarted: true,
      }),
    ).toBe("INSTALLED_COPY_CONFIRMED");
  });

  test("edited checkout requires both the path and the execution witness", () => {
    const base = { moduleFile: "/testbed/django/__init__.py", checkoutRoot: "/testbed", runnerStarted: true };
    expect(classifyProvenance({ ...base, mutationExecuted: true })).toBe("EDITED_CHECKOUT_CONFIRMED");
    // Path looks right but the sentinel never fired: the runner executed something else.
    expect(classifyProvenance({ ...base, mutationExecuted: false })).toBe("INSTALLED_COPY_CONFIRMED");
    // No witness collected at all is not a confirmation.
    expect(classifyProvenance({ ...base, mutationExecuted: null })).toBe("AMBIGUOUS_SOURCE");
  });

  test("provenance does not read the test outcome", () => {
    // Identical evidence, and the caller has no way to pass a pass/fail signal in.
    const ev = {
      moduleFile: "/testbed/flask/__init__.py",
      checkoutRoot: "/testbed",
      mutationExecuted: true,
      runnerStarted: true,
    };
    expect(classifyProvenance(ev)).toBe("EDITED_CHECKOUT_CONFIRMED");
    expect(Object.keys(ev)).not.toContain("exitCode");
  });

  test("a checkout path that also lives in site-packages is ambiguous, not confirmed", () => {
    expect(
      classifyProvenance({
        moduleFile: "/testbed/.venv/lib/python3.9/site-packages/pkg/__init__.py",
        checkoutRoot: "/testbed",
        mutationExecuted: true,
        runnerStarted: true,
      }),
    ).toBe("AMBIGUOUS_SOURCE");
  });

  test("no runner means no provenance claim", () => {
    expect(
      classifyProvenance({
        moduleFile: null,
        checkoutRoot: "/testbed",
        mutationExecuted: null,
        runnerStarted: false,
      }),
    ).toBe("RUNNER_NOT_STARTED");
  });
});

describe("repository readiness", () => {
  test("all checks green is READY", () => {
    expect(assessRepository(checks())).toBe("READY");
  });

  test("wrong-source execution overrides apparent validation success", () => {
    const state = assessRepository(
      checks({ v8SourceProvenance: "INSTALLED_COPY_CONFIRMED", v6PassingObservable: true, v7FailingObservable: true }),
    );
    expect(state).toBe("WRONG_SOURCE");
    expect(state).not.toBe("READY");
  });

  test("a mutation the validation never executes is wrong-source, not READY", () => {
    expect(assessRepository(checks({ v9MutationAffectsValidation: false }))).toBe("WRONG_SOURCE");
  });

  test("container starting is not readiness", () => {
    expect(assessRepository(checks({ v5TestRunnerStarts: false, v6PassingObservable: false })))
      .toBe("DEPENDENCY_FAILURE");
    expect(assessRepository(checks({ v6PassingObservable: false }))).toBe("RUNNER_ONLY");
  });

  test("an absent F-probe does not disqualify, an observed non-failure does", () => {
    expect(assessRepository(checks({ v7FailingObservable: null }))).toBe("READY");
    expect(assessRepository(checks({ v7FailingObservable: false }))).toBe("RUNNER_ONLY");
  });

  test("non-persistent state and unwritable source are distinguished", () => {
    expect(assessRepository(checks({ v3SourceWritable: false }))).toBe("SOURCE_NOT_WRITABLE");
    expect(assessRepository(checks({ v4MutationPersists: false }))).toBe("NON_PERSISTENT_ENV");
  });
});

describe("preregistered selection and gate", () => {
  const rows: BenchmarkRow[] = [
    row("django__django-11039", "django/django"),
    row("django__django-10880", "django/django"),
    row("sympy__sympy-12419", "sympy/sympy"),
  ];

  function row(id: string, repo: string): BenchmarkRow {
    return {
      instance_id: id,
      repo,
      base_commit: "deadbeef",
      version: "1.0",
      test_patch: "",
      PASS_TO_PASS: JSON.stringify(["t_b", "t_a"]),
      FAIL_TO_PASS: JSON.stringify(["f_b", "f_a"]),
    };
  }

  test("selection is lexicographically first per repo and outcome-blind", () => {
    const sel = selectPreregisteredInstances(rows);
    expect(sel.map((s) => s.instanceId)).toEqual(["django__django-10880", "sympy__sympy-12419"]);
    // Probes are deterministic too, so a rerun cannot drift onto a friendlier test.
    expect(sel[0]!.pProbe).toBe("t_a");
    expect(sel[0]!.fProbe).toBe("f_a");
  });

  test("image key reproduces swebench 4.1.0 naming", () => {
    expect(instanceImageKey("sphinx-doc__sphinx-7462"))
      .toBe("swebench/sweb.eval.x86_64.sphinx-doc_1776_sphinx-7462:latest");
  });

  test("breadth gate is 8/12, with the proportional fallback below that", () => {
    expect(breadthGate(12).requiredReady).toBe(8);
    expect(breadthGate(9).requiredReady).toBe(6);
  });

  test("verdict is measured against the frozen gate", () => {
    const gate = breadthGate(12);
    const ready = (n: number) =>
      Array.from({ length: 12 }, (_, i) => (i < n ? "READY" : "DEPENDENCY_FAILURE") as const);
    expect(substrateVerdict(ready(8), gate)).toBe("PER_INSTANCE_SUBSTRATE_VIABLE");
    expect(substrateVerdict(ready(3), gate)).toBe("PER_INSTANCE_SUBSTRATE_PARTIAL");
    expect(substrateVerdict(ready(0), gate)).toBe("PER_INSTANCE_SUBSTRATE_NOT_VIABLE");
    expect(substrateVerdict([], gate)).toBe("PER_INSTANCE_SUBSTRATE_NOT_EVALUABLE");
  });
});

describe("cleanup targets only M192-owned resources", () => {
  test("pre-existing swebench and user containers are never ours", () => {
    expect(isM192OwnedContainer("sweb.eval.django__django-10880.vexp-swebench-1780507214049")).toBe(false);
    expect(isM192OwnedContainer("some-user-postgres")).toBe(false);
    expect(isM192OwnedContainer("m192-django__django-10880")).toBe(true);
    expect(isM192OwnedContainer("/m192-sympy__sympy-12419")).toBe(true);
  });
});
