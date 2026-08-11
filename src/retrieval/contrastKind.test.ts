import assert from "node:assert/strict";
import { test } from "bun:test";

import { deriveQueryIntent, evaluateCandidateContrast } from "./querySemantics";

/**
 * M139 workstream B: the same contrast cue means opposite things depending on
 * whether the request is choosing between implementations or asking when each
 * one runs. These tests pin both readings so neither can drift into the other.
 */

function kindOf(task: string): string {
  return deriveQueryIntent(task).contrastKind;
}

const ARC_BEHAVIORAL = "How does a species object get its 2D molecular graph when rebuilt from a "
  + "serialized dictionary, and under what conditions is connectivity re-derived from Cartesian "
  + "coordinates rather than taken from the stored adjacency list?";

const M135_DIHEDRAL = "a function that returns a dihedral angle given three vectors, "
  + "rather than given coordinates and four atom indices";

test("the ARC serialization question is a branch question, not an exclusion", () => {
  const intent = deriveQueryIntent(ARC_BEHAVIORAL);

  assert.equal(intent.contrastKind, "alternative_branches");
  assert.equal(intent.branchClauses[0]?.branchCue, "under what conditions");
  // The hard gate: the stored-adjacency branch must not be treated as unwanted.
  assert.deepEqual(intent.contrastTerms, []);
  assert.equal(intent.contrastClauses.length, 0);
  for (const term of ["adjacency", "list"]) {
    assert.equal(
      intent.contrastTerms.includes(term),
      false,
      `${term} became a negative contrast term for a behavioural query`,
    );
  }
});

test("adjacency-list code is rewarded, never penalised, for the ARC question", () => {
  const intent = deriveQueryIntent(ARC_BEHAVIORAL);
  const evaluation = evaluateCandidateContrast(intent, {
    localName: "from_dict",
    fqName: "arc/species/species.py::ARCSpecies.from_dict",
    filePath: "arc/species/species.py",
    signature: "def from_dict(self, species_dict)",
    docstring: "Rebuild from a dictionary, using the stored adjacency list or re-deriving "
      + "connectivity from Cartesian coordinates.",
  });

  assert.equal(evaluation.contrastPenalty, 0);
  assert.ok(evaluation.positiveObjectiveScore > 0);
  assert.ok(evaluation.matchedBranchTerms.length > 0);
  // Reasons must describe branch evidence, not a downranking.
  assert.equal(evaluation.reason?.includes("downranked"), false);
  assert.ok(evaluation.reason?.includes("branch"));
});

test("M135's dihedral preference still excludes the coordinate implementation", () => {
  const intent = deriveQueryIntent(M135_DIHEDRAL);

  assert.equal(intent.contrastKind, "preference_exclusion");
  assert.equal(intent.branchClauses.length, 0);
  assert.ok(intent.contrastTerms.includes("coordinates"));
  assert.ok(intent.contrastTerms.includes("indices"));

  const excluded = evaluateCandidateContrast(intent, {
    localName: "calculate_dihedral_angle",
    fqName: "arc/species/vectors.py::calculate_dihedral_angle",
    filePath: "arc/species/vectors.py",
    signature: "def calculate_dihedral_angle(coords, atoms, index=0)",
    docstring: "Calculate a dihedral angle from coordinates and four atom indices.",
  });
  assert.ok(excluded.contrastPenalty > 0, "the excluded implementation lost its penalty");
});

test("'rather than' resolves by clause structure, not by the cue word", () => {
  assert.equal(kindOf("use vectors rather than coordinates"), "preference_exclusion");
  assert.equal(kindOf("when are vectors used rather than coordinates?"), "alternative_branches");
});

test("'instead of' resolves by clause structure, not by the cue word", () => {
  assert.equal(kindOf("I need a bytes parser instead of a file parser"), "preference_exclusion");
  assert.equal(
    kindOf("When does the program choose the bytes parser instead of the file parser?"),
    "alternative_branches",
  );
});

test("conditional alternatives keep both branches positive", () => {
  for (const task of [
    "When does the parser read cached metadata rather than regenerate it?",
    "Under what conditions do we reuse the stored graph instead of rebuilding it?",
    "What determines whether we stream the file rather than buffer it?",
  ]) {
    const intent = deriveQueryIntent(task);
    assert.equal(intent.contrastKind, "alternative_branches", task);
    assert.deepEqual(intent.contrastTerms, [], task);
    assert.ok(intent.branchTerms.length > 0, task);
  }
});

test("preference requests keep their exclusion", () => {
  for (const task of [
    "Find a parser that reads bytes directly rather than opening a file.",
    "a helper that works on vectors rather than coordinates",
    "find new_parser instead of legacy_parser",
  ]) {
    const intent = deriveQueryIntent(task);
    assert.equal(intent.contrastKind, "preference_exclusion", task);
    assert.ok(intent.contrastTerms.length > 0, task);
  }
});

test("a bare 'when' does not turn a preference into a branch question", () => {
  // The frame requires an auxiliary verb after `when`. Without this guard,
  // every request that merely mentions timing would lose its exclusion.
  const intent = deriveQueryIntent("Find the helper used when parsing, rather than the one for serializing.");

  assert.equal(intent.contrastKind, "preference_exclusion");
  assert.ok(intent.contrastTerms.includes("serializing"));
});

test("comparison and causal questions still exclude nothing", () => {
  for (const task of ["compare parse_json with parse_yaml", "why doesn't Loader call validate?"]) {
    const intent = deriveQueryIntent(task);
    assert.equal(intent.contrastKind, "none", task);
    assert.deepEqual(intent.contrastTerms, [], task);
  }
});

test("branch terms exclude the interrogative frame itself", () => {
  const intent = deriveQueryIntent(ARC_BEHAVIORAL);

  for (const frameWord of ["under", "what", "conditions", "when", "is"]) {
    assert.equal(
      intent.branchTerms.includes(frameWord),
      false,
      `${frameWord} belongs to the question, not to either alternative`,
    );
  }
  assert.ok(intent.branchTerms.includes("adjacency"));
  assert.ok(intent.branchTerms.includes("coordinates"));
});

test("a candidate spanning both branches outranks one touching a single side", () => {
  const intent = deriveQueryIntent(ARC_BEHAVIORAL);
  const both = evaluateCandidateContrast(intent, {
    localName: "from_dict",
    fqName: "m.py::S.from_dict",
    filePath: "m.py",
    signature: "def from_dict(self, d)",
    docstring: "Use the stored adjacency list, or re-derive connectivity from Cartesian coordinates.",
  });
  const oneSide = evaluateCandidateContrast(intent, {
    localName: "read_adjacency",
    fqName: "m.py::read_adjacency",
    filePath: "m.py",
    signature: "def read_adjacency(d)",
    docstring: "Read the adjacency list.",
  });

  assert.ok(
    both.positiveObjectiveScore > oneSide.positiveObjectiveScore,
    "orchestration spanning the decision should score above a single-branch helper",
  );
});

test("behavioural framing does not make the request a capability lookup", () => {
  // M139 §58: `how does ...` plus function-like words must not be mistaken for
  // "find me a function that does X".
  assert.equal(deriveQueryIntent(ARC_BEHAVIORAL).kind, "general");
});
