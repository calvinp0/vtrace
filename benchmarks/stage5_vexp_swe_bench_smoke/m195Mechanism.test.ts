import { describe, expect, test } from "bun:test";
import {
  type I6DecisionPointEvidence,
  type RepoFacts,
  M195_MAX_TARGETS,
  candidateSetHash,
  deriveA,
  deriveB,
  deriveC,
  deriveD,
  deriveCommand,
  dottedOf,
  isTestPath,
  parseChangedPaths,
  parseChangedSymbols,
} from "./m195Mechanism";
import {
  type ObservedValidation,
  classifyDecisionPoint,
  djangoLabelToPath,
  evaluateGates,
  goldEvidence,
  isRelevant,
  parseValidationTargets,
  relateCandidate,
  relateOne,
} from "./m195Evaluation";

const FACTS: RepoFacts = {
  headSha: "deadbeef",
  trackedPaths: [
    "astropy/__init__.py",
    "astropy/io/ascii/qdp.py",
    "astropy/io/ascii/tests/__init__.py",
    "astropy/io/ascii/tests/test_qdp.py",
    "astropy/io/tests/test_registry.py",
    "tests/test_top.py",
  ],
  pyFiles: [],
  testFiles: ["astropy/io/ascii/tests/test_qdp.py", "astropy/io/tests/test_registry.py", "tests/test_top.py"],
  testImports: {
    "astropy/io/ascii/tests/test_qdp.py": {
      modules: ["astropy.io.ascii.qdp", "astropy.io.ascii.qdp._line_type"],
      names: ["_line_type"],
    },
    "astropy/io/tests/test_registry.py": { modules: ["astropy.io.ascii.qdp"], names: [] },
    "tests/test_top.py": { modules: ["os"], names: [] },
  },
  testDefs: {
    "astropy/io/ascii/tests/test_qdp.py": { functions: ["test_roundtrip"], classes: [] },
    "astropy/io/tests/test_registry.py": { functions: [], classes: [] },
    "tests/test_top.py": { functions: [], classes: [] },
  },
  packageRoots: [""],
  centralTestRoots: ["tests"],
  nativeRunners: {},
};

const DIFF = `diff --git a/astropy/io/ascii/qdp.py b/astropy/io/ascii/qdp.py
--- a/astropy/io/ascii/qdp.py
+++ b/astropy/io/ascii/qdp.py
@@ -68,7 +68,7 @@ def _line_type(line, delimiter=None):
-    _new_re = rf"NO({sep}NO)+"
+    _new_re = rf"NO({sep}NO)+"
`;

const EV = (over: Partial<I6DecisionPointEvidence> = {}): I6DecisionPointEvidence => ({
  decisionPointId: "arm#1",
  armId: "arm",
  instanceId: "astropy__astropy-14365",
  repo: "astropy/astropy",
  sequence: 1,
  kind: "DP_EDIT",
  taskText: "ascii.qdp assumes commands are upper case",
  currentDiffText: DIFF,
  changedSourcePaths: parseChangedPaths(DIFF),
  changedSymbols: parseChangedSymbols(DIFF),
  priorEvents: [],
  observedFailureText: null,
  repoFacts: FACTS,
  ...over,
});

describe("diff parsing is pre-decision only", () => {
  test("changed paths come from the snapshot's own headers", () => {
    expect(parseChangedPaths(DIFF)).toEqual(["astropy/io/ascii/qdp.py"]);
  });
  test("changed symbols come from hunk context and added definitions", () => {
    expect(parseChangedSymbols(DIFF)).toEqual(["_line_type"]);
  });
});

describe("the blind evidence object carries no future", () => {
  test("it has no field that could hold an outcome, a gold patch or a later event", () => {
    const keys = Object.keys(EV());
    for (const forbidden of ["resolved", "finalPatch", "goldPatch", "testPatch", "failToPass", "nextValidation"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("I6-A changed-source test affinity", () => {
  test("the sibling mirror is found and is a real path", () => {
    const a = deriveA(EV());
    expect(a.candidates.map((c) => c.path)).toContain("astropy/io/ascii/tests/test_qdp.py");
    expect(a.candidates[0]?.rule).toBe("A1_sibling_mirror");
  });
  test("a mirror that does not exist at the base commit is never proposed", () => {
    const a = deriveA(EV({ changedSourcePaths: ["astropy/io/ascii/absent.py"], currentDiffText: "" }));
    expect(a.candidates).toEqual([]);
    expect(a.abstained).toBe(true);
  });
  test("a changed test file never seeds a candidate", () => {
    const a = deriveA(EV({ changedSourcePaths: ["astropy/io/ascii/tests/test_qdp.py"] }));
    expect(a.candidates).toEqual([]);
  });
});

describe("I6-B affected-consumer validation", () => {
  test("symbol-qualified importers outrank plain module importers", () => {
    const b = deriveB(EV());
    expect(b.candidates[0]?.path).toBe("astropy/io/ascii/tests/test_qdp.py");
    expect(b.candidates[0]?.rule).toBe("B1_imports_changed_symbol");
    expect(b.candidates[1]?.rule).toBe("B2_imports_changed_module");
  });
  test("a test that imports nothing changed is not a consumer", () => {
    expect(deriveB(EV()).candidates.map((c) => c.path)).not.toContain("tests/test_top.py");
  });
});

describe("I6-C task cue", () => {
  test("behavioural prose alone produces nothing", () => {
    const c = deriveC(EV({ taskText: "the reader crashes on lower case input and should not" }));
    expect(c.candidates).toEqual([]);
  });
  test("an explicit test name that the repository actually defines resolves to its file", () => {
    const c = deriveC(EV({ taskText: "test_roundtrip fails" }));
    expect(c.candidates[0]?.path).toBe("astropy/io/ascii/tests/test_qdp.py");
    expect(c.candidates[0]?.node).toBe("test_roundtrip");
    expect(c.candidates[0]?.specificity).toBe("EXACT_TEST");
  });
  test("a dotted identifier reaches a test module only through a naming component", () => {
    const c = deriveC(EV({ taskText: "calling ascii.qdp fails" }));
    expect(c.candidates.map((x) => x.path)).toContain("astropy/io/ascii/tests/test_qdp.py");
  });
});

describe("I6-D prior-failure refinement", () => {
  test("it abstains where no failure has been observed yet", () => {
    expect(deriveD(EV()).abstained).toBe(true);
  });
  test("a reported failure narrows to the node the runner named", () => {
    const d = deriveD(
      EV({
        kind: "DP_POST_FAILED_VALIDATION",
        observedFailureText: "FAILED astropy/io/ascii/tests/test_qdp.py::test_roundtrip - assert",
      }),
    );
    expect(d.candidates[0]?.node).toBe("test_roundtrip");
    expect(d.candidates[0]?.specificity).toBe("EXACT_TEST");
  });
  test("a path the repository does not have is never proposed", () => {
    const d = deriveD(
      EV({ kind: "DP_POST_FAILED_VALIDATION", observedFailureText: "FAILED nope/test_absent.py::t" }),
    );
    expect(d.candidates).toEqual([]);
  });
});

describe("§8 boundedness holds for every family", () => {
  test("no family may exceed the frozen bound", () => {
    const ev = EV();
    for (const f of [deriveA(ev), deriveB(ev), deriveC(ev), deriveD(ev)]) {
      expect(f.candidates.length).toBeLessThanOrEqual(M195_MAX_TARGETS);
    }
  });
});

describe("§9 native command derivation", () => {
  test("django uses its own runner and label grammar", () => {
    expect(deriveCommand("django/django", "tests/dbshell/test_postgresql.py", null, FACTS)).toBe(
      "./tests/runtests.py dbshell.test_postgresql",
    );
  });
  test("sympy uses bin/test", () => {
    expect(deriveCommand("sympy/sympy", "sympy/core/tests/test_evalf.py", null, FACTS)).toBe(
      "bin/test sympy/core/tests/test_evalf.py",
    );
  });
  test("everything else uses pytest, with the node when there is one", () => {
    expect(deriveCommand("astropy/astropy", "a/test_b.py", "test_c", FACTS)).toBe("python -m pytest a/test_b.py::test_c");
  });
});

describe("dotted module resolution", () => {
  test("the longest package root wins", () => {
    expect(dottedOf("lib/matplotlib/colors.py", ["lib", ""])).toBe("matplotlib.colors");
  });
  test("test paths are recognised structurally", () => {
    expect(isTestPath("tests/dbshell/tests.py")).toBe(true);
    expect(isTestPath("astropy/io/ascii/qdp.py")).toBe(false);
    expect(isTestPath("astropy/io/ascii/tests/conftest.py")).toBe(false);
  });
});

describe("fingerprints", () => {
  test("the same evidence hashes to the same candidate set", () => {
    expect(candidateSetHash([deriveA(EV())])).toBe(candidateSetHash([deriveA(EV())]));
  });
  test("a different diff hashes differently", () => {
    const other = EV({ changedSourcePaths: ["astropy/io/ascii/absent.py"] });
    expect(candidateSetHash([deriveA(EV())])).not.toBe(candidateSetHash([deriveA(other)]));
  });
});

// ── evaluation layer ────────────────────────────────────────────────

const CAND = { ...deriveA(EV()).candidates[0]! };
const obs = (command: string, runnerStarted = true): ObservedValidation => ({
  targets: parseValidationTargets("astropy/astropy", command, FACTS),
  runnerStarted,
});

describe("§10 natural-agent relation", () => {
  test("naming the candidate file is an exact match", () => {
    expect(relateOne(CAND, obs("python -m pytest astropy/io/ascii/tests/test_qdp.py"), ["qdp"])).toBe("EXACT_MATCH");
  });
  test("a whole-suite run is broader, never equivalent", () => {
    expect(relateOne(CAND, obs("python -m pytest"), ["qdp"])).toBe("BROADER_THAN_CANDIDATE");
  });
  test("a directory containing the candidate is broader", () => {
    expect(relateOne(CAND, obs("python -m pytest astropy/io/ascii/tests"), ["qdp"])).toBe("BROADER_THAN_CANDIDATE");
  });
  test("a runner aimed elsewhere is a different validation", () => {
    expect(relateOne(CAND, obs("python -m pytest tests/test_top.py"), ["qdp"])).toBe("DIFFERENT_VALIDATION");
  });
  test("a reproduction script that starts no runner is no validation, not a different one", () => {
    expect(relateOne(CAND, obs("python -c 'import astropy'", false), ["qdp"])).toBe("NO_VALIDATION");
  });
  test("an empty credit window is no validation", () => {
    expect(relateCandidate(CAND, [], ["qdp"])).toBe("NO_VALIDATION");
  });
  test("the best relation across the window wins", () => {
    expect(
      relateCandidate(CAND, [obs("python -m pytest tests/test_top.py"), obs("python -m pytest astropy/io/ascii/tests/test_qdp.py")], ["qdp"]),
    ).toBe("EXACT_MATCH");
  });
});

describe("django label grammar", () => {
  const tracked = new Set(["tests/dbshell/test_postgresql.py", "tests/dbshell/__init__.py"]);
  const dirs = new Set(["tests/dbshell", "tests"]);
  test("a label naming a module resolves to that file", () => {
    expect(djangoLabelToPath("dbshell.test_postgresql", tracked, dirs)).toEqual({
      path: "tests/dbshell/test_postgresql.py",
      kind: "file",
    });
  });
  test("a label naming an app resolves to the directory", () => {
    expect(djangoLabelToPath("dbshell", tracked, dirs)).toEqual({ path: "tests/dbshell", kind: "dir" });
  });
});

describe("§11 relevance oracle", () => {
  const gold = goldEvidence(
    {
      test_patch: "diff --git a/astropy/io/ascii/tests/test_qdp.py b/astropy/io/ascii/tests/test_qdp.py\n",
      FAIL_TO_PASS: '["astropy/io/ascii/tests/test_qdp.py::test_roundtrip[True]"]',
    },
    FACTS,
  );
  test("a file the reference patch touches is relevant", () => {
    expect(isRelevant(CAND, gold)).toBe(true);
  });
  test("an unrelated test file is not", () => {
    expect(isRelevant({ ...CAND, path: "tests/test_top.py" }, gold)).toBe(false);
  });
  test("PASS_TO_PASS is deliberately not an input", () => {
    expect(Object.keys(gold)).not.toContain("passToPass");
  });
});

describe("§12 classification priority", () => {
  const base = { candidateCount: 1, anyRelevant: true, attemptsInWindow: 1, anyTrustworthyInWindow: true };
  test("no candidate means no derivable obligation", () => {
    expect(classifyDecisionPoint({ ...base, candidateCount: 0, bestRelation: "NO_VALIDATION" })).toBe(
      "I6_NO_REPOSITORY_DERIVABLE_VALIDATION_OBLIGATION",
    );
  });
  test("a natural exact match is already-selected, not a miss", () => {
    expect(classifyDecisionPoint({ ...base, bestRelation: "EXACT_MATCH" })).toBe(
      "I6_RELEVANT_VALIDATION_ALREADY_SELECTED",
    );
  });
  test("a confirmed relevant candidate the agent never aimed at is a miss", () => {
    expect(classifyDecisionPoint({ ...base, bestRelation: "NO_VALIDATION" })).toBe("I6_VALIDATION_SELECTION_MISS");
  });
  test("an unconfirmed candidate is never promoted to a miss", () => {
    expect(classifyDecisionPoint({ ...base, bestRelation: "DIFFERENT_VALIDATION", anyRelevant: false })).not.toBe(
      "I6_VALIDATION_SELECTION_MISS",
    );
  });
  test("untrustworthy evidence stays its own class", () => {
    expect(
      classifyDecisionPoint({
        ...base,
        bestRelation: "BROADER_THAN_CANDIDATE",
        anyRelevant: false,
        anyTrustworthyInWindow: false,
      }),
    ).toBe("VALIDATION_EVIDENCE_UNUSABLE");
  });
});

describe("§13 gates are conjunctive and unforgiving", () => {
  const passing = {
    family: "I6-A" as const,
    fingerprintDiffs: 0,
    medianCandidates: 1,
    p90Candidates: 3,
    maxCandidates: 3,
    emptyRatePct: 10,
    missTasks: 3,
    missRepos: 3,
    successWitnesses: 2,
    successWitnessRepos: 2,
    unnecessaryFireRatePctResolved: 10,
    redundantRecommendationRatePct: 10,
    largestTaskSharePct: 10,
    missPrecision: 0.8,
  };
  test("a clean family passes every gate", () => {
    expect(evaluateGates(passing).every((g) => g.pass)).toBe(true);
  });
  test("one hindsight leak fails the whole family", () => {
    expect(evaluateGates({ ...passing, fingerprintDiffs: 1 }).find((g) => g.id === "G1")?.pass).toBe(false);
  });
  test("witnesses in a single repository do not satisfy G5", () => {
    expect(evaluateGates({ ...passing, successWitnessRepos: 1 }).find((g) => g.id === "G5")?.pass).toBe(false);
  });
  test("a concentrated result fails G8", () => {
    expect(evaluateGates({ ...passing, largestTaskSharePct: 60 }).find((g) => g.id === "G8")?.pass).toBe(false);
  });
});
