import { describe, expect, test } from "bun:test";

import {
  assessI5,
  assessI6,
  classifyI5Mechanism,
  classifyI6Mechanism,
  decisionPoints,
  deriveI5Candidates,
  deriveI6Candidates,
  reconstructEditChronology,
  scoreCandidates,
  taskTermsFrom,
  type ArmObservability,
  type AuthoritativeRelation,
  type DecisionPointEvidence,
  type MechanismEvidence,
  type TraceCall,
} from "./m189Evidence";

const call = (over: Partial<TraceCall> & { index: number }): TraceCall => ({
  tool: "Read", category: "read", path: null, command: null, output: null, args: {}, ...over,
});

const edit = (index: number, file: string, oldS: string, newS: string): TraceCall =>
  call({ index, tool: "Edit", category: "edit", args: { file_path: file, old_string: oldS, new_string: newS } });

describe("edit chronology", () => {
  test("recovers ordered replace payloads", () => {
    const c = reconstructEditChronology([call({ index: 0 }), edit(1, "a.py", "x", "y"), edit(2, "b.py", "p", "q")]);
    expect(c.ops.map((o) => [o.callIndex, o.file, o.kind])).toEqual([[1, "a.py", "replace"], [2, "b.py", "replace"]]);
    expect(c.complete).toBe(true);
  });

  test("a MultiEdit becomes one op per replacement, not one per call", () => {
    const c = reconstructEditChronology([
      call({ index: 3, tool: "MultiEdit", category: "edit", args: { file_path: "a.py", edits: [{ old_string: "x", new_string: "y" }, { old_string: "p", new_string: "q" }] } }),
    ]);
    expect(c.ops).toHaveLength(2);
    expect(c.ops.every((o) => o.callIndex === 3)).toBe(true);
  });

  test("a Write is a whole-file mutation with no old text", () => {
    const c = reconstructEditChronology([call({ index: 0, tool: "Write", category: "edit", args: { file_path: "a.py", content: "hello" } })]);
    expect(c.ops[0]!.kind).toBe("write");
    expect(c.ops[0]!.oldString).toBeNull();
  });

  test("an edit with no recoverable payload is a DEFECT, never a silent drop", () => {
    const c = reconstructEditChronology([call({ index: 0, tool: "Edit", category: "edit", args: { file_path: "a.py" } })]);
    expect(c.ops).toHaveLength(0);
    expect(c.defects).toEqual([{ callIndex: 0, defect: "NO_PAYLOAD" }]);
    expect(c.complete).toBe(false);
  });
});

describe("decision points", () => {
  const calls = [call({ index: 0 }), edit(1, "a.py", "x", "y"), call({ index: 2 }), call({ index: 3 }), call({ index: 4 })];
  const chronology = reconstructEditChronology(calls);

  test("a trace with no edit has no post-edit decision point", () => {
    expect(decisionPoints({ calls: [call({ index: 0 })], chronology: reconstructEditChronology([]), validationAttemptIndices: [], validationStartedIndices: [] })).toEqual([]);
  });

  test("validation-shaped points exist only where the trace carries validation (§13)", () => {
    const none = decisionPoints({ calls, chronology, validationAttemptIndices: [], validationStartedIndices: [] });
    expect(none.map((d) => d.kind)).toEqual(["AFTER_FIRST_EDIT", "BEFORE_FINALIZATION"]);

    const withValidation = decisionPoints({ calls, chronology, validationAttemptIndices: [3], validationStartedIndices: [3] });
    expect(withValidation.map((d) => d.kind)).toEqual(["AFTER_FIRST_EDIT", "BEFORE_FIRST_VALIDATION", "AFTER_FIRST_VALIDATION", "BEFORE_FINALIZATION"]);
  });

  test("a validation at the first post-edit ordinal does not double-name that moment", () => {
    const collapsed = decisionPoints({ calls, chronology, validationAttemptIndices: [2], validationStartedIndices: [2] });
    expect(collapsed.map((d) => d.kind)).toEqual(["AFTER_FIRST_EDIT", "AFTER_FIRST_VALIDATION", "BEFORE_FINALIZATION"]);
  });

  test("two names for one ordinal collapse to one decision point", () => {
    const one = decisionPoints({ calls: [edit(0, "a.py", "x", "y")], chronology: reconstructEditChronology([edit(0, "a.py", "x", "y")]), validationAttemptIndices: [], validationStartedIndices: [] });
    expect(one).toHaveLength(1);
  });
});

const observability = (over: Partial<ArmObservability>): ArmObservability => ({
  orderedToolTrace: true, editCalls: 1, editOps: 1, editChronologyComplete: true,
  baseTreeAvailable: true, finalPatchAvailable: true, inspectionCalls: 3, callsAfterFirstEdit: 2,
  diffReplayClean: true, validationAttempts: 0, validationRunnerStarts: 0,
  validationResultsObserved: 0, editsAfterValidationStart: 0, ...over,
});

describe("corpus adequacy", () => {
  test("I5 needs a replayable diff and does NOT need a test runner", () => {
    const ok = assessI5(observability({}));
    expect(ok).toEqual({ usable: true, blockers: [] });
    expect(assessI5(observability({ diffReplayClean: false })).blockers).toEqual(["DIFF_NOT_REPLAYABLE"]);
    expect(assessI5(observability({ editOps: 0 })).blockers).toEqual(["NO_EDIT"]);
  });

  test("I6 requires an OBSERVED runner start — the attributability condition", () => {
    const i5 = assessI5(observability({}));
    expect(assessI6(observability({ validationAttempts: 0 }), i5).blockers).toEqual(["NO_VALIDATION_ATTEMPT"]);
    expect(assessI6(observability({ validationAttempts: 4 }), i5).blockers).toEqual(["NO_RUNNER_START"]);
    expect(assessI6(observability({ validationAttempts: 4, validationRunnerStarts: 1 }), i5).blockers).toEqual(["NO_VALIDATION_RESULT"]);
    expect(assessI6(observability({ validationAttempts: 4, validationRunnerStarts: 1, validationResultsObserved: 1 }), i5).usable).toBe(true);
  });

  test("an I5-unusable arm can never be I6-usable", () => {
    const o = observability({ editOps: 0, validationAttempts: 2, validationRunnerStarts: 1, validationResultsObserved: 1 });
    expect(assessI6(o, assessI5(o)).blockers).toContain("I5_UNUSABLE");
  });
});

const relation = (over: Partial<AuthoritativeRelation>): AuthoritativeRelation => ({
  fromFqName: "a.py::f", toFqName: "b.py::g", toFile: "b.py", toKind: "function",
  edgeType: "calls", strength: "exact", direction: "dependent_of_change", ...over,
});

const evidence = (over: Partial<DecisionPointEvidence>): DecisionPointEvidence => ({
  atIndex: 5, kind: "AFTER_FIRST_EDIT", taskTerms: [], changedFiles: ["a.py"], changedSymbols: [],
  inspectedFiles: [], relations: [], relatedTestFiles: [], validatedTargets: [],
  anyRunnerStartedBefore: false, ...over,
});

describe("candidate derivation", () => {
  test("names a dependent in an untouched, uninspected file", () => {
    const out = deriveI5Candidates(evidence({ relations: [relation({})] }), "DEPENDENTS");
    expect(out.map((c) => c.targetFile)).toEqual(["b.py"]);
  });

  test("never names a file the agent already changed or already opened", () => {
    expect(deriveI5Candidates(evidence({ relations: [relation({ toFile: "a.py" })] }), "DEPENDENTS")).toHaveLength(0);
    expect(deriveI5Candidates(evidence({ relations: [relation({})], inspectedFiles: ["b.py"] }), "DEPENDENTS")).toHaveLength(0);
  });

  test("the two arms read opposite edge directions and never bleed into each other", () => {
    const both = evidence({ relations: [relation({}), relation({ toFile: "c.py", toFqName: "c.py::h", direction: "dependency_of_change" })] });
    expect(deriveI5Candidates(both, "DEPENDENTS").map((c) => c.targetFile)).toEqual(["b.py"]);
    expect(deriveI5Candidates(both, "DEPENDENCIES").map((c) => c.targetFile)).toEqual(["c.py"]);
  });

  test("task relevance narrows, and cannot invent a candidate the relation did not license", () => {
    const e = evidence({ relations: [relation({ toFqName: "b.py::serializer", toFile: "b.py" })], taskTerms: ["serializer"] });
    expect(deriveI5Candidates(e, "DEPENDENTS_TASK_RELEVANT").map((c) => c.targetFile)).toEqual(["b.py"]);
    const unrelated = evidence({ relations: [relation({})], taskTerms: ["serializer"] });
    expect(deriveI5Candidates(unrelated, "DEPENDENTS_TASK_RELEVANT")).toHaveLength(0);
    // a task term with no relation behind it produces nothing at all
    expect(deriveI5Candidates(evidence({ taskTerms: ["serializer"] }), "DEPENDENTS_TASK_RELEVANT")).toHaveLength(0);
  });

  test("I6 drops tests the agent has already run and keeps the edge that produced each one", () => {
    const e = evidence({
      relatedTestFiles: [{ file: "tests/test_a.py", viaFqName: "a.py::f", edgeType: "test_entrypoint" }, { file: "tests/test_b.py", viaFqName: "a.py::f", edgeType: "test_entrypoint" }],
      validatedTargets: ["tests/test_a.py"],
    });
    const out = deriveI6Candidates(e);
    expect(out.map((c) => c.targetFile)).toEqual(["tests/test_b.py"]);
    expect(out[0]!.fromChangedSymbol).toBe("a.py::f");
  });

  test("stopwords and short tokens cannot make relevance free", () => {
    const terms = taskTermsFrom("The Model self test raises FieldError in ordering");
    expect(terms).toContain("fielderror");
    expect(terms).toContain("ordering");
    expect(terms).not.toContain("self");
    expect(terms).not.toContain("test");
  });
});

describe("scoring is separate from derivation", () => {
  test("gold enters only here, and unaddressed hits are the I5 target", () => {
    const candidates = deriveI5Candidates(evidence({ relations: [relation({}), relation({ toFile: "d.py", toFqName: "d.py::k" })] }), "DEPENDENTS");
    const score = scoreCandidates({ candidates, goldFiles: ["b.py", "z.py"], finalPatchFiles: ["z.py"], resolved: false });
    expect(score.goldHits).toEqual(["b.py"]);
    expect(score.unaddressedGoldHits).toEqual(["b.py"]);
    expect(score.candidateCount).toBe(2);
    expect(score.precision).toBe(0.5);
  });

  test("a gold file the final patch already covered is not an unaddressed hit", () => {
    const candidates = deriveI5Candidates(evidence({ relations: [relation({})] }), "DEPENDENTS");
    expect(scoreCandidates({ candidates, goldFiles: ["b.py"], finalPatchFiles: ["b.py"], resolved: true }).unaddressedGoldHits).toEqual([]);
  });
});

const mechanism = (over: Partial<MechanismEvidence>): MechanismEvidence => ({
  touchedNoGoldFile: false, missedGoldFiles: [], candidateNamedMissedGold: false,
  namedByDependentArm: false, allMissedGoldAlreadyInspected: false, anyMissedGoldReachable: false,
  i6Usable: false, ranReferenceTest: false, derivedUnrunReferenceTest: false,
  validationAttemptedNeverStarted: false, ...over,
});

describe("mechanism classification", () => {
  test("editing every reference file and still failing is not an edit-set miss", () => {
    expect(classifyI5Mechanism(mechanism({}))).toBe("MODEL_REASONING_FAILURE_WITH_EVIDENCE_VISIBLE");
  });

  test("a missed file the agent already opened is a reasoning failure, not an obligation", () => {
    expect(classifyI5Mechanism(mechanism({ missedGoldFiles: ["b.py"], anyMissedGoldReachable: true, allMissedGoldAlreadyInspected: true })))
      .toBe("MODEL_REASONING_FAILURE_WITH_EVIDENCE_VISIBLE");
  });

  test("an unreachable missed file is a derivability ceiling, not a mechanism", () => {
    expect(classifyI5Mechanism(mechanism({ missedGoldFiles: ["b.py"] }))).toBe("I5_NO_REPOSITORY_DERIVABLE_OBLIGATION");
  });

  test("reachable-but-never-emitted is its own state and is NOT counted as a consumer miss", () => {
    expect(classifyI5Mechanism(mechanism({ missedGoldFiles: ["b.py"], anyMissedGoldReachable: true })))
      .toBe("I5_REACHABLE_BUT_NOT_NAMED_BY_DERIVATION");
  });

  test("only a FROZEN candidate naming the missed file scores as a specimen", () => {
    expect(classifyI5Mechanism(mechanism({ missedGoldFiles: ["b.py"], candidateNamedMissedGold: true, namedByDependentArm: true })))
      .toBe("I5_AFFECTED_CONSUMER_MISS");
    expect(classifyI5Mechanism(mechanism({ missedGoldFiles: ["b.py"], candidateNamedMissedGold: true })))
      .toBe("I5_EDIT_SET_MISS");
  });

  test("an arm that cannot witness validation says so instead of scoring an absence", () => {
    expect(classifyI6Mechanism(mechanism({}))).toBe("INSUFFICIENT_TRACE");
    expect(classifyI6Mechanism(mechanism({ validationAttemptedNeverStarted: true }))).toBe("I6_VALIDATION_SELECTED_BUT_NOT_EXECUTED");
  });

  test("the two hypotheses are labelled independently", () => {
    const e = mechanism({ missedGoldFiles: ["b.py"], i6Usable: true, ranReferenceTest: true });
    expect(classifyI5Mechanism(e)).toBe("I5_NO_REPOSITORY_DERIVABLE_OBLIGATION");
    expect(classifyI6Mechanism(e)).toBe("I6_VALIDATION_EXECUTED_BUT_REASONING_FAILED");
  });
});
