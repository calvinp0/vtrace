import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  analyzerEligible,
  classifyFirstCall,
  classifyGoldRelation,
  extractCapsuleItems,
  classifySolve,
  extractReturnedPaths,
  pairedDelta,
  splitCalls,
  summarizeDeltas,
} from "./m164Analysis";

// §95. Every detector gets a known-positive before any zero it produces is
// trusted. M163 published labels derived from an empty result set and had to
// retract them; a detector that has never been shown firing is not evidence of
// absence when it stays quiet.

const REFUSAL = JSON.stringify({
  result: {
    output: {
      resolved: false,
      reason: "repo_not_ready",
      message: "Vtrace repository is not ready. Call index_repo, then retry get_code_context.",
    },
  },
});

const NONEMPTY = JSON.stringify({
  code: "ok",
  result: {
    output: {
      capsuleResult: {
        pivots: [{ filePath: "django/db/models/aggregates.py" }],
        supportingItems: [{ filePath: "django/db/models/sql/query.py" }],
      },
      digest: "pivot django/db/models/aggregates.py :: Count.as_sql",
    },
  },
});

const EMPTY = JSON.stringify({ code: "ok", result: { output: { capsuleResult: { pivots: [], supportingItems: [] }, digest: "no candidates" } } });

const INVALID = JSON.stringify({ code: "invalid_request", message: "get_code_context requires a non-empty string query." });

test("known-positive: the repo_not_ready detector fires, and never reports evidence", () => {
  const result = classifyFirstCall({ triggerServed: true, toolsAvailable: true, callMade: true, rawOutput: REFUSAL });
  assert.equal(result.status, "REPO_NOT_READY");
  assert.equal(result.evidenceDelivered, false);
  assert.equal(result.evidenceCharacters, 0);
  // The exact M163 accounting mistake: 1370 dynamic tokens that were all refusal.
  assert.ok(result.refusalCharacters > 0);
  assert.equal(analyzerEligible(result), false);
});

test("known-positive: VALID_NONEMPTY is distinguished from VALID_EMPTY", () => {
  const nonEmpty = classifyFirstCall({ triggerServed: true, toolsAvailable: true, callMade: true, rawOutput: NONEMPTY });
  assert.equal(nonEmpty.status, "VALID_NONEMPTY");
  assert.equal(nonEmpty.evidenceDelivered, true);
  assert.ok(nonEmpty.returnedPaths.includes("django/db/models/aggregates.py"));
  assert.equal(nonEmpty.refusalCharacters, 0);
  assert.equal(analyzerEligible(nonEmpty), true);

  const empty = classifyFirstCall({ triggerServed: true, toolsAvailable: true, callMade: true, rawOutput: EMPTY });
  assert.equal(empty.status, "VALID_EMPTY");
  // A truthful empty answer is not delivered evidence, and is not a refusal either.
  assert.equal(empty.evidenceDelivered, false);
  assert.equal(empty.refusalCharacters, 0);
  assert.equal(analyzerEligible(empty), false);
});

test("known-positive: the invalid_request detector fires on the product's own error", () => {
  const result = classifyFirstCall({ triggerServed: true, toolsAvailable: true, callMade: true, rawOutput: INVALID });
  assert.equal(result.status, "INVALID_REQUEST");
  assert.equal(result.evidenceDelivered, false);
});

test("known-positive: an uncalled trigger is TRIGGER_NOT_COMPLIED, not CALL_NOT_MADE", () => {
  const triggered = classifyFirstCall({ triggerServed: true, toolsAvailable: true, callMade: false, rawOutput: null });
  assert.equal(triggered.status, "TRIGGER_NOT_COMPLIED");

  // The neutral arm makes no call by design; that is not noncompliance.
  const neutral = classifyFirstCall({ triggerServed: false, toolsAvailable: true, callMade: false, rawOutput: null });
  assert.equal(neutral.status, "CALL_NOT_MADE");
});

test("known-positive: unavailable tools outrank noncompliance", () => {
  // An agent cannot ignore a tool it was never offered, so availability is read
  // first. Reversing these would blame the agent for a wiring failure.
  const result = classifyFirstCall({ triggerServed: true, toolsAvailable: false, callMade: false, rawOutput: null });
  assert.equal(result.status, "TOOLS_UNAVAILABLE");
});

test("known-positive: source-path extraction finds paths and ignores prose", () => {
  assert.deepEqual(extractReturnedPaths("see sklearn/utils/validation.py and lib/matplotlib/axes/_base.py"), [
    "sklearn/utils/validation.py",
    "lib/matplotlib/axes/_base.py",
  ]);
  assert.deepEqual(extractReturnedPaths("no candidates were found for this query"), []);
});

test("a missing arm yields a null delta, never a zero", () => {
  // §94. NOT_RUN must never become 0 in an aggregate.
  assert.equal(pairedDelta("x", "turns", null, 12).delta, null);
  assert.equal(pairedDelta("x", "turns", 10, null).delta, null);
  assert.equal(pairedDelta("x", "turns", 10, 12).delta, 2);

  const summary = summarizeDeltas("turns", [
    pairedDelta("a", "turns", 10, 12),
    pairedDelta("b", "turns", 8, 6),
    pairedDelta("c", "turns", null, 9),
  ]);
  // Three tasks, two usable pairs. The denominator is the pairs, not the tasks.
  assert.equal(summary.pairs, 2);
  assert.equal(summary.meanDelta, 0);
  assert.equal(summary.triggerHigher, 1);
  assert.equal(summary.neutralHigher, 1);
});

test("the paired solve matrix keeps an incomplete pair out of every cell", () => {
  assert.equal(classifySolve(true, true), "SHARED_SUCCESS");
  assert.equal(classifySolve(false, true), "TRIGGER_UNIQUE_WIN");
  assert.equal(classifySolve(true, false), "NEUTRAL_UNIQUE_WIN");
  assert.equal(classifySolve(false, false), "SHARED_FAILURE");
  assert.equal(classifySolve(null, true), "INCOMPLETE");
});

test("a retry of a rejected required call is not voluntary reuse", () => {
  // The live M164 shape: the opening call was malformed and the agent retried it.
  // Scoring that second call as a voluntary return to VTRACE would invert the
  // finding — it is the agent repairing its own call, not choosing to come back.
  const repaired = splitCalls(["INVALID_REQUEST", "VALID_NONEMPTY"]);
  assert.equal(repaired.required, 1);
  assert.equal(repaired.errorRetries, 1);
  assert.equal(repaired.voluntaryFollowup, 0);

  // Never answered at all: every call was an attempt at the required one.
  const neverAnswered = splitCalls(["INVALID_REQUEST", "INVALID_REQUEST"]);
  assert.equal(neverAnswered.voluntaryFollowup, 0);
  assert.equal(neverAnswered.errorRetries, 1);
});

test("an error retry is not counted as voluntary reuse", () => {
  // §71. A malformed call the agent immediately retried is not a signal that it
  // found the first answer worth returning to.
  const withRetry = splitCalls(["INVALID_REQUEST", "INVALID_REQUEST", "VALID_NONEMPTY"]);
  assert.equal(withRetry.required, 1);
  assert.equal(withRetry.errorRetries, 2);
  assert.equal(withRetry.voluntaryFollowup, 0);

  const genuine = splitCalls(["VALID_NONEMPTY", "VALID_NONEMPTY"]);
  assert.equal(genuine.voluntaryFollowup, 1);
  assert.equal(genuine.errorRetries, 0);

  assert.deepEqual(splitCalls([]), { required: 0, voluntaryFollowup: 0, errorRetries: 0 });
});

// The capture artefact that would have inverted the headline result: a parser
// fed a truncated payload reports zero items, and a gold classifier fed zero
// items reports ABSENT for every run in the sweep.
const TRUNCATED = '{"result":{"output":{"capsuleResult":{"pivots":[{"role":"pivot","path":"sympy/printing/latex.py","symbol":"latex","kind":"function"}],"support":[{"role":"support","path":"sympy/printing/pretty/pretty.py"},{"role":"support","path":"sympy/printing/tests/test_lat';

test("known-positive: capsule items survive a truncated payload", () => {
  assert.throws(() => JSON.parse(TRUNCATED) as unknown, "the fixture must actually be unparseable");

  const items = extractCapsuleItems(TRUNCATED);
  assert.deepEqual(items, [
    { role: "pivot", path: "sympy/printing/latex.py" },
    { role: "support", path: "sympy/printing/pretty/pretty.py" },
  ]);
});

test("known-positive: the gold relation distinguishes TOP_1 from ANYWHERE from ABSENT", () => {
  const items = extractCapsuleItems(TRUNCATED);

  // The real sympy-13798 case: the lead pivot IS the gold file. The pre-fix
  // reader called this ABSENT.
  const top1 = classifyGoldRelation(items, ["sympy/printing/latex.py"]);
  assert.equal(top1.relation, "TOP_1");
  assert.equal(top1.leadPath, "sympy/printing/latex.py");
  assert.deepEqual(top1.goldFilesReturned, ["sympy/printing/latex.py"]);

  const anywhere = classifyGoldRelation(items, ["sympy/printing/pretty/pretty.py"]);
  assert.equal(anywhere.relation, "ANYWHERE");

  const absent = classifyGoldRelation(items, ["sympy/core/numbers.py"]);
  assert.equal(absent.relation, "ABSENT");
  assert.deepEqual(absent.goldFilesReturned, []);

  // No items recovered must not read as "gold absent from good evidence".
  assert.equal(classifyGoldRelation([], ["anything.py"]).leadPath, null);
});
