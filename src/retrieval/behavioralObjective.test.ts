import { expect, test } from "bun:test";

import { deriveQueryIntent } from "./querySemantics";
import { deriveBehavioralObjective, subjectTermsOf } from "./behavioralObjective";

function objectiveFor(task: string) {
  return deriveBehavioralObjective(deriveQueryIntent(task));
}

// --- §11 the same subject, four different questions ---------------------------
//
// This block is the milestone's core claim in one place: the nouns are identical
// and the requested operation is not.

test("a winner question over a subject asks for selection", () => {
  const objective = objectiveFor("How does ARC decide which reaction family wins?");
  expect(objective.operation).toBe("selection");
});

test("a cache question over the SAME subject asks for caching, not selection", () => {
  const objective = objectiveFor("How is reaction-family lookup cached?");
  expect(objective.operation).toBe("caching");
});

test("a storage question is not a selection question even when it says `selected`", () => {
  // The adjective describes the value; the sentence asks where it is kept. If
  // cue PRESENCE decided this, every storage question about a chosen value would
  // be misread as a question about the choosing.
  const objective = objectiveFor("Where is the selected reaction family stored on ARCReaction?");
  expect(objective.operation).toBe("storage");
});

test("a precedence question asks for ordering, not selection", () => {
  const objective = objectiveFor(
    "What determines the precedence/order when multiple reaction families match?",
  );
  expect(objective.operation).toBe("ordering");
  expect(objective.operation === "ordering" && objective.qualifiers).toContain("multiple_alternatives");
});

// --- §10 / §44 explicit identifier lookup stays a lookup -----------------------

test("an explicit definition lookup declares no operation", () => {
  const objective = objectiveFor("Where is `choose_candidate()` defined?");
  expect(objective.operation).toBeNull();
  expect(objective.operation === null && objective.suppressedBy).toBe("explicit symbol lookup command");
});

test("an operation word INSIDE an identifier is not an operation cue", () => {
  // `\b` does not match across `_`, so the cue cannot fire on `choose_candidate`.
  // Without this, M142's prose/identifier hygiene would be re-broken from the
  // other direction: an identifier would start declaring behavioural intent.
  const objective = objectiveFor("Explain choose_candidate and sort_entries.");
  expect(objective.operation).toBeNull();
});

// --- §33 / §34 / §35 generic behavioural questions -----------------------------

test("a passive selection question is a predicate cue", () => {
  const objective = objectiveFor("How is the preferred item selected?");
  expect(objective.operation).toBe("selection");
  expect(objective.operation === "selection" && objective.strength).toBe("predicate");
});

test("a backend-choice question asks for selection", () => {
  expect(objectiveFor("How does the system decide which backend to use?").operation).toBe("selection");
});

test("a takeover question asks for fallback", () => {
  expect(objectiveFor("When does the fallback implementation take over?").operation).toBe("fallback");
});

test("a precedence-between-candidates question asks for ordering", () => {
  expect(objectiveFor("How is precedence between candidates determined?").operation).toBe("ordering");
});

// --- §67 / §68 / §69 the operation survives a low-confidence request -----------

test("an operation is derived from grammar, not from overall intent confidence", () => {
  // The real ARC request was classified low-confidence with a fallback applied
  // and still contained an unambiguous operator. Nothing in this derivation
  // consults a classifier confidence, so a fallback cannot switch it off.
  const vague = objectiveFor("so which one actually wins here");
  expect(vague.operation).toBe("selection");
});

// --- §7 subject terms are preserved, never suppressed --------------------------

test("subject nouns survive; only question vocabulary is removed", () => {
  // Project aliases are supplied on the product path by `shapeSweQuery`; without
  // them nothing knows `ARC` names the repository, so the test provides them the
  // same way retrieval does.
  const intent = deriveQueryIntent("How does ARC decide which reaction family wins?", {
    projectNameAliases: new Set(["arc"]),
  });
  const terms = subjectTermsOf(intent);
  expect(terms).toContain("reaction");
  expect(terms).toContain("family");
  // The project name is context, not subject matter to match code against.
  expect(terms).not.toContain("arc");
  // Operation vocabulary is not subject matter either.
  expect(terms).not.toContain("decide");
  expect(terms).not.toContain("wins");
});

test("an ordinary request declares no operation and pays nothing", () => {
  const objective = objectiveFor(
    "AttributeError raised when saving a model with a null foreign key in admin",
  );
  expect(objective.operation).toBeNull();
});
