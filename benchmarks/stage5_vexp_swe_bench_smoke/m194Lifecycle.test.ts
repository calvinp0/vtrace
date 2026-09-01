/**
 * M194 §49 — the acquisition's own classification instrument, tested.
 *
 * Everything else M194 computes is M193's frozen code. This is the one rule the
 * acquisition adds, and the corpus's I6 count is downstream of it, so it is
 * tested against the shapes the twelve fixture repositories actually produce.
 */

import { describe, expect, test } from "bun:test";
import { classificationText, runnerStarted, semanticTestResult } from "./m193Acquisition";
import { M194_RUNNER_TOKENS, isValidationAttempt, streamCapture } from "./m194Lifecycle";

const NOTHING = streamCapture("", "");

describe("isValidationAttempt — command-text witness", () => {
  test.each([
    ["python -m pytest tests/test_basic.py -q", "pytest, the common case"],
    ["./tests/runtests.py --settings=test_sqlite auth", "django's own runner"],
    ["python -c 'import sympy; sympy.test(\"sympy/core\")'", "sympy's in-process runner"],
    ["python setup.py test", "the setuptools entry point"],
    ["tox -e py39", "tox"],
    ["python -m unittest discover", "unittest"],
    ["make test", "a Makefile target"],
    ["python -m pytest", "bare pytest"],
    ["bin/test", "a repository script"],
  ])("recognises %s (%s)", (command) => {
    expect(isValidationAttempt(command, NOTHING)).toBe(true);
  });

  test("is case-insensitive, because shell history is not normalised", () => {
    expect(isValidationAttempt("PYTHON -M PYTEST tests/", NOTHING)).toBe(true);
  });

  test.each([
    ["ls -la src/", "listing"],
    ["git status", "inspecting state"],
    ["cat src/flask/app.py", "reading a file"],
    ["grep -rn 'def handle' src/", "searching"],
    ["python -c 'import flask; print(flask.__version__)'", "an import probe"],
  ])("does not recognise %s (%s)", (command) => {
    expect(isValidationAttempt(command, NOTHING)).toBe(false);
  });
});

describe("isValidationAttempt — runner-started witness", () => {
  // The second witness exists because a repository can invoke its suite under a
  // name the token list never anticipated. When that happens the runner's own
  // banner is the evidence, and it is evidence about the runner starting, never
  // about whether the run passed.
  const pytestSession = streamCapture(
    "============================= test session starts ==============================\ncollected 3 items\n\n3 passed in 0.41s\n",
    "",
  );

  test("an unrecognised command that started a runner is still an attempt", () => {
    expect(isValidationAttempt("./scripts/ci-entrypoint.sh", pytestSession)).toBe(true);
  });

  test("the witness is the runner starting, not the result", () => {
    const failed = streamCapture("", "collected 3 items\n\n1 failed, 2 passed in 0.4s\n");
    expect(isValidationAttempt("./scripts/ci-entrypoint.sh", failed)).toBe(true);
    expect(runnerStarted(failed)).toBe(true);
    expect(semanticTestResult(failed)).toBe("MIXED");
  });

  test("markers on stderr alone are still seen (M192's stream split)", () => {
    // M192 found runner markers surfacing on stderr while results went to
    // stdout. A classifier reading one stream would lose the whole execution.
    const split = streamCapture("1 failed, 0 passed in 0.10s\n", "============================= test session starts ==============================\n");
    expect(classificationText(split)).toContain("test session starts");
    expect(isValidationAttempt("./run-ci", split)).toBe(true);
    expect(semanticTestResult(split)).toBe("FAILED");
  });

  test("output with no runner evidence at all is not an attempt", () => {
    const prose = streamCapture("Everything looks fine in 1.0s of reading\n", "");
    expect(isValidationAttempt("./scripts/deploy.sh", prose)).toBe(false);
  });
});

describe("the token list is a frozen, non-empty, lowercase set", () => {
  test("every token is lowercase, since the command is lowercased before matching", () => {
    for (const t of M194_RUNNER_TOKENS) expect(t).toBe(t.toLowerCase());
  });

  test("the list is frozen so an acquisition cannot widen it midway", () => {
    expect(Object.isFrozen(M194_RUNNER_TOKENS)).toBe(true);
  });
});

describe("streamCapture", () => {
  test("never claims an interleaving nobody observed", () => {
    const c = streamCapture("out", "err");
    expect(c.mergedStream).toBeNull();
    expect(c.mergedStreamComplete).toBe(false);
  });

  test("classification still reads both streams", () => {
    expect(classificationText(streamCapture("A", "B"))).toContain("A");
    expect(classificationText(streamCapture("A", "B"))).toContain("B");
  });

  test("absent streams are empty, not undefined", () => {
    const c = streamCapture(undefined, undefined);
    expect(c.stdout).toBe("");
    expect(c.stderr).toBe("");
  });
});
