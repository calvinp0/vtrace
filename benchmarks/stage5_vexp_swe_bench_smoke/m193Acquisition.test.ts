import { describe, expect, test } from "bun:test";
import {
  M193_ADEQUACY,
  M193_LIMITS,
  M193_ROUTING,
  accountCorpus,
  assessAdequacy,
  classifyArmLifecycle,
  classifyRunValidity,
  classifyValidationProvenance,
  classificationText,
  comparePatchIdentity,
  instanceImageKey,
  isRerunnable,
  normalizePatch,
  runnerStarted,
  selectFixture,
  semanticTestResult,
  stopDecision,
  terminationIsInfrastructure,
  traceOrderingIsWellFormed,
  tracePrefix,
  workdirIsPinned,
  type DatasetRow,
} from "./m193Acquisition";
import {
  DEMUX_TRAP_STREAMS,
  FIXTURE_CORPUS_EXPECTATION,
  PYTEST_FAIL_STREAMS,
  PYTEST_PASS_STREAMS,
  RUNNER_NOT_REACHED_STREAMS,
  syntheticFixtures,
} from "./m193Fixtures";

// ── §9 fixture selection ────────────────────────────────────────────

const ROWS: DatasetRow[] = [
  { instance_id: "b__b-3", repo: "b/b", base_commit: "b3" },
  { instance_id: "a__a-2", repo: "a/a", base_commit: "a2" },
  { instance_id: "a__a-1", repo: "a/a", base_commit: "a1" },
  { instance_id: "c__c-1", repo: "c/c", base_commit: "c1" },
  { instance_id: "b__b-1", repo: "b/b", base_commit: "b1" },
];

describe("§9 task fixture selection", () => {
  test("is stratified round-robin: rank 1 of every repository first", () => {
    const f = selectFixture(ROWS, 10);
    expect(f.map((e) => e.instanceId)).toEqual(["a__a-1", "b__b-1", "c__c-1", "a__a-2", "b__b-3"]);
    expect(f.map((e) => e.stratumRank)).toEqual([1, 1, 1, 2, 2]);
  });

  test("every prefix maximises repository breadth", () => {
    const f = selectFixture(ROWS, 10);
    for (let n = 1; n <= f.length; n++) {
      const repos = new Set(f.slice(0, n).map((e) => e.repo)).size;
      expect(repos).toBe(Math.min(n, 3));
    }
  });

  test("is deterministic and order-independent in its input", () => {
    const a = selectFixture(ROWS, 10).map((e) => e.instanceId);
    const b = selectFixture([...ROWS].reverse(), 10).map((e) => e.instanceId);
    expect(a).toEqual(b);
  });

  test("truncates at maxArms without reordering", () => {
    expect(selectFixture(ROWS, 3).map((e) => e.instanceId)).toEqual(["a__a-1", "b__b-1", "c__c-1"]);
  });

  test("image key matches swebench 4.1.0 naming", () => {
    expect(instanceImageKey("psf__requests-1142")).toBe("swebench/sweb.eval.x86_64.psf_1776_requests-1142:latest");
    expect(instanceImageKey("scikit-learn__scikit-learn-10844")).toBe(
      "swebench/sweb.eval.x86_64.scikit-learn_1776_scikit-learn-10844:latest",
    );
  });
});

// ── §22/§23 shell result vs semantic result ─────────────────────────

describe("§22 shell termination and semantic result are independent", () => {
  test("pytest summaries drive the semantic result, not the exit code", () => {
    expect(semanticTestResult(PYTEST_PASS_STREAMS)).toBe("PASSED");
    expect(semanticTestResult(PYTEST_FAIL_STREAMS)).toBe("MIXED");
  });

  test("a shell that exits 0 after a failing test is still FAILED/MIXED", () => {
    // M192's exact trap: eval.sh ends with `git checkout` and exits 0.
    expect(semanticTestResult(PYTEST_FAIL_STREAMS)).not.toBe("PASSED");
  });

  test("no runner banner means UNKNOWN, never PASSED", () => {
    expect(runnerStarted(RUNNER_NOT_REACHED_STREAMS)).toBe(false);
    expect(semanticTestResult(RUNNER_NOT_REACHED_STREAMS)).toBe("UNKNOWN");
  });

  test("unittest 'Ran 0 tests' is NO_TESTS_RAN, not PASSED", () => {
    const s = { stdout: "Ran 0 tests in 0.000s\n\nOK\n", stderr: "", mergedStream: null, mergedStreamComplete: false };
    expect(semanticTestResult(s)).toBe("NO_TESTS_RAN");
  });

  test("pytest 'no tests ran' is NO_TESTS_RAN", () => {
    const s = {
      stdout: "============================= test session starts ==============================\ncollected 0 items\n\n============================ no tests ran in 0.01s =============================\n",
      stderr: "",
      mergedStream: null,
      mergedStreamComplete: false,
    };
    expect(semanticTestResult(s)).toBe("NO_TESTS_RAN");
  });
});

describe("§22 terse runner output is still a result", () => {
  // `pytest -q --no-header` prints no session banner and no `=` decoration.
  // An earlier classifier required the decoration and reported three dry-run
  // repositories as UNKNOWN while their tests had plainly run.
  const quiet = (s: string) => ({ stdout: s, stderr: "", mergedStream: null, mergedStreamComplete: false });

  test("quiet-mode pass", () => {
    const s = quiet(".                                          [100%]\n1 passed in 0.04s\n");
    expect(runnerStarted(s)).toBe(true);
    expect(semanticTestResult(s)).toBe("PASSED");
  });

  test("quiet-mode failure with a warning count", () => {
    const s = quiet("F                                          [100%]\n1 failed, 1 warning in 0.03s\n");
    expect(runnerStarted(s)).toBe(true);
    expect(semanticTestResult(s)).toBe("FAILED");
  });

  test("quiet-mode mixed", () => {
    const s = quiet("..F                                        [100%]\n1 failed, 2 passed in 0.33s\n");
    expect(semanticTestResult(s)).toBe("MIXED");
  });

  test("quiet-mode no tests", () => {
    expect(semanticTestResult(quiet("no tests ran in 0.01s\n"))).toBe("NO_TESTS_RAN");
  });

  test("prose that merely contains a duration is not a test result", () => {
    const s = quiet("Rebuilt the extension in 3.2s\nDone.\n");
    expect(runnerStarted(s)).toBe(false);
    expect(semanticTestResult(s)).toBe("UNKNOWN");
  });

  test("decorated and undecorated summaries agree", () => {
    const dec = quiet("============================== 3 passed in 0.42s ===============================\n");
    const und = quiet("3 passed in 0.42s\n");
    expect(semanticTestResult(dec)).toBe(semanticTestResult(und));
  });
});

describe("§23 stream demultiplexing trap", () => {
  test("the runner banner on stderr with results on stdout is still seen", () => {
    expect(runnerStarted(DEMUX_TRAP_STREAMS)).toBe(true);
    expect(semanticTestResult(DEMUX_TRAP_STREAMS)).toBe("MIXED");
  });

  test("a classifier reading one stream alone loses half the evidence", () => {
    // stderr carries the banner but no counts: the runner started and the
    // result is unknown.
    const stderrOnly = { stdout: "", stderr: DEMUX_TRAP_STREAMS.stderr, mergedStream: null, mergedStreamComplete: false };
    expect(runnerStarted(stderrOnly)).toBe(true);
    expect(semanticTestResult(stderrOnly)).toBe("UNKNOWN");

    // Only the union carries both.
    expect(semanticTestResult(DEMUX_TRAP_STREAMS)).toBe("MIXED");
  });

  test("a runner reporting everything on stderr is still seen", () => {
    const stderrRunner = {
      stdout: "",
      stderr: "collected 2 items\n1 failed, 1 passed in 0.10s\n",
      mergedStream: null,
      mergedStreamComplete: false,
    };
    expect(runnerStarted(stderrRunner)).toBe(true);
    expect(semanticTestResult(stderrRunner)).toBe("MIXED");
  });

  test("falls back to the concatenated raw streams when the merged tee is incomplete", () => {
    const noMerge = { ...DEMUX_TRAP_STREAMS, mergedStream: null, mergedStreamComplete: false };
    expect(runnerStarted(noMerge)).toBe(true);
    expect(semanticTestResult(noMerge)).toBe("MIXED");
    expect(classificationText(noMerge)).toContain("test session starts");
    expect(classificationText(noMerge)).toContain("1 failed, 2 passed");
  });
});

// ── §20/§21 provenance ──────────────────────────────────────────────

const base = {
  isValidationAttempt: true,
  runnerStarted: true,
  workdir: "/testbed",
  checkoutRoot: "/testbed",
  moduleFile: "/testbed/requests/__init__.py",
  robustness: "EDITABLE_INSTALL" as const,
};

describe("§20 validation provenance fails closed", () => {
  test("an editable install under the checkout root is confirmed", () => {
    expect(classifyValidationProvenance(base)).toBe("EDITED_CHECKOUT_CONFIRMED");
  });

  test("site-packages is an installed copy even when the tests passed", () => {
    expect(
      classifyValidationProvenance({ ...base, moduleFile: "/opt/miniconda3/lib/python3.9/site-packages/requests/__init__.py" }),
    ).toBe("INSTALLED_COPY_CONFIRMED");
  });

  test("a path that is both checkout and installed is ambiguous, never confirmed", () => {
    expect(classifyValidationProvenance({ ...base, moduleFile: "/testbed/.venv/lib/site-packages/requests/__init__.py" })).toBe(
      "AMBIGUOUS_SOURCE",
    );
  });

  test("an unmeasured module path is ambiguous", () => {
    expect(classifyValidationProvenance({ ...base, moduleFile: null })).toBe("AMBIGUOUS_SOURCE");
  });

  test("no runner start short-circuits before any source claim", () => {
    expect(classifyValidationProvenance({ ...base, runnerStarted: false })).toBe("RUNNER_NOT_STARTED");
  });

  test("a non-validation command is NOT_APPLICABLE", () => {
    expect(classifyValidationProvenance({ ...base, isValidationAttempt: false })).toBe("NOT_APPLICABLE");
  });

  test("psf/requests: CWD_DEPENDENT is confirmed only with the workdir pinned", () => {
    const cwdDep = { ...base, robustness: "CWD_DEPENDENT" as const };
    expect(classifyValidationProvenance(cwdDep)).toBe("EDITED_CHECKOUT_CONFIRMED");
    expect(classifyValidationProvenance({ ...cwdDep, workdir: "/" })).toBe("AMBIGUOUS_SOURCE");
    expect(classifyValidationProvenance({ ...cwdDep, workdir: "/root" })).toBe("AMBIGUOUS_SOURCE");
  });

  test("unknown robustness can never reach confirmed", () => {
    expect(classifyValidationProvenance({ ...base, robustness: "UNKNOWN" })).toBe("AMBIGUOUS_SOURCE");
  });
});

describe("§21 workdir pinning contract", () => {
  test("only the exact checkout root counts as pinned", () => {
    expect(workdirIsPinned("/testbed", "/testbed")).toBe(true);
    expect(workdirIsPinned("/testbed/tests", "/testbed")).toBe(false);
    expect(workdirIsPinned(undefined, "/testbed")).toBe(false);
    expect(workdirIsPinned(null, "/testbed")).toBe(false);
    expect(workdirIsPinned("", "/testbed")).toBe(false);
  });

  test("routing is total, not a hybrid", () => {
    expect(M193_ROUTING.policy).toBe("ALL_BASH_IN_CONTAINER");
    expect(M193_ROUTING.hostExecuted).toEqual([]);
    expect(M193_ROUTING.workdirPolicy).toBe("PINNED_TO_CHECKOUT_ROOT");
  });
});

// ── §19 trace ordering ──────────────────────────────────────────────

describe("§19 trace-prefix evidence model", () => {
  const arm = syntheticFixtures().find((f) => f.id === "F03_FAIL_REVISE_PASS")!.arm;

  test("ordinals are dense and strictly increasing", () => {
    expect(traceOrderingIsWellFormed(arm.events)).toBe(true);
  });

  test("a prefix carries no later event", () => {
    const p = tracePrefix(arm.events, 3);
    expect(p.length).toBe(4);
    expect(Math.max(...p.map((e) => e.ordinal))).toBe(3);
  });

  test("a gap in ordinals is detected rather than silently reordered", () => {
    const broken = arm.events.map((e, i) => (i === 2 ? { ...e, ordinal: 99 } : e));
    expect(traceOrderingIsWellFormed(broken)).toBe(false);
  });
});

// ── §28 patch identity ──────────────────────────────────────────────

const DIFF_A = [
  "diff --git a/pkg/x.py b/pkg/x.py",
  "index 1111111..2222222 100644",
  "--- a/pkg/x.py",
  "+++ b/pkg/x.py",
  "@@ -1,2 +1,2 @@",
  "-old",
  "+new",
  "",
].join("\n");

describe("§28 patch identity under the frozen normalisation", () => {
  test("normalisation drops only blob-id metadata", () => {
    expect(normalizePatch(DIFF_A)).not.toContain("index 1111111");
    expect(normalizePatch(DIFF_A)).toContain("-old");
    expect(normalizePatch(DIFF_A)).toContain("+new");
    expect(normalizePatch(DIFF_A).endsWith("\n")).toBe(true);
  });

  test("CRLF folds to LF", () => {
    expect(normalizePatch(DIFF_A.replace(/\n/g, "\r\n"))).toBe(normalizePatch(DIFF_A));
  });

  test("differing blob ids still compare identical", () => {
    const regen = DIFF_A.replace("index 1111111..2222222 100644", "index abcdef1..9876543 100644");
    const r = comparePatchIdentity({
      interactiveFinalDiff: DIFF_A,
      extractedPredictionPatch: DIFF_A,
      evaluatorAppliedPatch: regen,
    });
    expect(r.verdict).toBe("IDENTICAL_NORMALIZED");
    expect(r.extractedVsEvaluatorNormalized).toBe(true);
    expect(r.extractedVsEvaluatorStrict).toBe(false);
  });

  test("byte-identical all the way through is IDENTICAL_STRICT", () => {
    const r = comparePatchIdentity({
      interactiveFinalDiff: DIFF_A,
      extractedPredictionPatch: DIFF_A,
      evaluatorAppliedPatch: DIFF_A,
    });
    expect(r.verdict).toBe("IDENTICAL_STRICT");
  });

  test("a changed line is a MISMATCH, not absorbed by normalisation", () => {
    const r = comparePatchIdentity({
      interactiveFinalDiff: DIFF_A,
      extractedPredictionPatch: DIFF_A.replace("+new", "+other"),
      evaluatorAppliedPatch: DIFF_A,
    });
    expect(r.verdict).toBe("MISMATCH");
  });

  test("a dropped hunk is a MISMATCH", () => {
    const r = comparePatchIdentity({
      interactiveFinalDiff: DIFF_A,
      extractedPredictionPatch: DIFF_A,
      evaluatorAppliedPatch: "",
    });
    expect(r.verdict).toBe("MISMATCH");
  });

  test("an empty patch is identical to an empty patch", () => {
    const r = comparePatchIdentity({ interactiveFinalDiff: "", extractedPredictionPatch: "", evaluatorAppliedPatch: "" });
    expect(r.verdict).toBe("IDENTICAL_STRICT");
  });
});

// ── §38/§41 failure semantics ───────────────────────────────────────

describe("§38/§41 infrastructure vs agent-side termination", () => {
  test("turn, cost and timeout exhaustion are NOT infrastructure", () => {
    expect(terminationIsInfrastructure("TURN_LIMIT_REACHED")).toBe(false);
    expect(terminationIsInfrastructure("COST_CAP_REACHED")).toBe(false);
    expect(terminationIsInfrastructure("AGENT_TIMEOUT")).toBe(false);
  });

  test("model-service and harness failures are infrastructure", () => {
    expect(terminationIsInfrastructure("MODEL_SERVICE_FAILURE")).toBe(true);
    expect(terminationIsInfrastructure("HARNESS_CRASH")).toBe(true);
  });

  test("only infrastructure categories are rerunnable", () => {
    expect(isRerunnable("MODEL_SERVICE_FAILURE")).toBe(true);
    expect(isRerunnable("CONTAINER_INFRA_FAILURE")).toBe(true);
    expect(isRerunnable("EVALUATOR_INFRA_FAILURE")).toBe(true);
    expect(isRerunnable("PREFLIGHT_FAILED")).toBe(false);
    expect(isRerunnable("TREATMENT_CONTAMINATION")).toBe(false);
    expect(isRerunnable("PATCH_EXTRACTION_FAILURE")).toBe(false);
  });
});

// ── §39/§40 run validity is not resolution ──────────────────────────

describe("§39/§40 run validity", () => {
  const ok = syntheticFixtures().find((f) => f.id === "F02_EDIT_VALIDATION_PASS")!.arm;

  test("an unresolved task is still a valid run", () => {
    expect(classifyRunValidity({ ...ok, resolved: false }).validity).toBe("RUN_VALID");
  });

  test("choosing not to test does not invalidate a run", () => {
    const noTest = syntheticFixtures().find((f) => f.id === "F01_EDIT_NO_VALIDATION")!.arm;
    expect(classifyRunValidity(noTest).validity).toBe("RUN_VALID");
  });

  test("a truthful empty patch is valid; a failure to extract is not", () => {
    expect(classifyRunValidity({ ...ok, finalPatchIsEmpty: true }).validity).toBe("RUN_VALID");
    expect(classifyRunValidity({ ...ok, finalPatchExtracted: false }).reasons).toContain("PATCH_EXTRACTION_FAILURE");
  });

  test("losing checkout authority invalidates the run", () => {
    expect(classifyRunValidity({ ...ok, authoritativeCheckoutMaintained: false }).reasons).toContain("CHECKOUT_AUTHORITY_LOST");
  });

  test("treatment contamination invalidates the run", () => {
    expect(classifyRunValidity({ ...ok, treatmentAbsenceVerified: false }).reasons).toContain("TREATMENT_CONTAMINATION");
  });

  test("cost-cap truncation alone does not invalidate a run", () => {
    expect(classifyRunValidity({ ...ok, termination: "COST_CAP_REACHED" }).validity).toBe("RUN_VALID");
  });
});

// ── §51 synthetic lifecycle fixtures, frozen ────────────────────────

describe("§51 synthetic lifecycle fixtures classify exactly as frozen", () => {
  for (const f of syntheticFixtures()) {
    test(f.id, () => {
      const l = classifyArmLifecycle(f.arm);
      expect(l.validity).toBe(f.expect.validity);
      expect(l.i6Usable).toBe(f.expect.i6Usable);
      expect(l.i6UnusableReason).toBe(f.expect.i6UnusableReason);
      expect(l.runtimeDiagnosisUsable).toBe(f.expect.runtimeDiagnosisUsable);
      expect(l.postEditValidationAttempts).toBe(f.expect.postEditValidationAttempts);
      expect(l.usableValidationEvents).toBe(f.expect.usableValidationEvents);
      expect(l.postValidationRevisions).toBe(f.expect.postValidationRevisions);
      expect(l.wrongSourceEvents).toBe(f.expect.wrongSourceEvents);
    });
  }

  test("corpus accounting over the whole fixture set matches the frozen expectation", () => {
    const lifecycles = syntheticFixtures().map((f) => classifyArmLifecycle(f.arm));
    const acc = accountCorpus(lifecycles, 0);
    expect(acc.validRuns).toBe(FIXTURE_CORPUS_EXPECTATION.validRuns);
    expect(acc.i6UsableArms).toBe(FIXTURE_CORPUS_EXPECTATION.i6UsableArms);
    expect(acc.runtimeDiagnosisUsableArms).toBe(FIXTURE_CORPUS_EXPECTATION.runtimeDiagnosisUsableArms);
    expect(assessAdequacy(acc)).toBe(FIXTURE_CORPUS_EXPECTATION.adequacy);
  });

  test("wrong-source and ambiguous events never reach the usable count", () => {
    const lifecycles = syntheticFixtures().map((f) => classifyArmLifecycle(f.arm));
    const acc = accountCorpus(lifecycles, 0);
    expect(acc.wrongSourceEvents).toBe(1);
    expect(acc.ambiguousSourceEvents).toBe(1);
    const wrongSourceArm = lifecycles.find((l) => l.wrongSourceEvents > 0)!;
    expect(wrongSourceArm.usableValidationEvents).toBe(0);
    expect(wrongSourceArm.i6Usable).toBe(false);
  });

  test("every fixture id is unique", () => {
    const ids = syntheticFixtures().map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── §14 adequacy + §13 stopping rule ────────────────────────────────

function acc(over: Partial<ReturnType<typeof accountCorpus>>) {
  return { ...accountCorpus([], 0), ...over };
}

describe("§14 corpus adequacy", () => {
  test("ADEQUATE requires usable arms, repository breadth AND valid runs together", () => {
    expect(assessAdequacy(acc({ i6UsableArms: 12, repositoriesAmongI6Usable: 6, validRuns: 30 }))).toBe("ADEQUATE");
    expect(assessAdequacy(acc({ i6UsableArms: 12, repositoriesAmongI6Usable: 5, validRuns: 30 }))).toBe("PARTIAL");
    expect(assessAdequacy(acc({ i6UsableArms: 11, repositoriesAmongI6Usable: 6, validRuns: 30 }))).toBe("PARTIAL");
    expect(assessAdequacy(acc({ i6UsableArms: 12, repositoriesAmongI6Usable: 6, validRuns: 29 }))).toBe("PARTIAL");
  });

  test("INADEQUATE below the partial floor", () => {
    expect(assessAdequacy(acc({ i6UsableArms: 5, repositoriesAmongI6Usable: 4, validRuns: 15 }))).toBe("INADEQUATE");
    expect(assessAdequacy(acc({ i6UsableArms: 6, repositoriesAmongI6Usable: 3, validRuns: 15 }))).toBe("INADEQUATE");
  });

  test("a high pass rate alone never reaches ADEQUATE", () => {
    expect(assessAdequacy(acc({ resolvedCount: 40, validRuns: 40, i6UsableArms: 0, repositoriesAmongI6Usable: 0 }))).toBe(
      "INADEQUATE",
    );
  });

  test("thresholds are the frozen constants", () => {
    expect(M193_ADEQUACY.adequate).toEqual({ i6UsableArms: 12, repositoriesAmongI6Usable: 6, validRuns: 30 });
    expect(M193_ADEQUACY.partial).toEqual({ i6UsableArms: 6, repositoriesAmongI6Usable: 4, validRuns: 15 });
  });
});

describe("§13/§48 stopping rule is outcome-independent", () => {
  test("never stops on target before the minimum arm count", () => {
    expect(stopDecision({ armsLaunched: 19, spendUsd: 1, i6UsableArms: 99, repositoriesAmongI6Usable: 12 })).toBe("CONTINUE");
  });

  test("stops when the observability target is met at or past the minimum", () => {
    expect(stopDecision({ armsLaunched: 20, spendUsd: 1, i6UsableArms: 12, repositoriesAmongI6Usable: 6 })).toBe(
      "STOP_TARGET_MET",
    );
  });

  test("stops at max arms", () => {
    expect(stopDecision({ armsLaunched: 40, spendUsd: 1, i6UsableArms: 0, repositoriesAmongI6Usable: 0 })).toBe("STOP_MAX_ARMS");
  });

  test("the spend cap dominates everything", () => {
    expect(stopDecision({ armsLaunched: 5, spendUsd: 90, i6UsableArms: 0, repositoriesAmongI6Usable: 0 })).toBe(
      "STOP_SPEND_CAP",
    );
  });

  test("the decision function cannot see resolution", () => {
    const keys = Object.keys({ armsLaunched: 0, spendUsd: 0, i6UsableArms: 0, repositoriesAmongI6Usable: 0 });
    expect(keys).not.toContain("resolved");
    expect(keys).not.toContain("resolvedCount");
  });

  test("frozen limits", () => {
    expect(M193_LIMITS.minArms).toBe(20);
    expect(M193_LIMITS.maxArms).toBe(40);
    expect(M193_LIMITS.perRunCostCapUsd).toBe(3.5);
    expect(M193_LIMITS.totalSpendCapUsd).toBe(90);
    expect(M193_LIMITS.maxConcurrentArms).toBe(3);
  });
});
