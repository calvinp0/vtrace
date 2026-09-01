/**
 * M194's own classification instrument, kept apart from the script that uses it
 * so it can be tested without running an acquisition.
 *
 * M193 froze what a validation event MEANS — the provenance axes, the semantic
 * result, the usability rule — but not how to recognise one in an unrestricted
 * agent's shell history, because until an agent ran there was no shell history
 * to recognise it in. This is that missing piece and nothing more: everything
 * downstream of it is M193's frozen code.
 */

import { type StreamCapture, runnerStarted } from "./m193Acquisition";

/**
 * Command-text witnesses that an agent was trying to run tests.
 *
 * Drawn from how the twelve fixture repositories are actually exercised —
 * django's `runtests.py`, sympy's own `sympy.test`, the `tox` and `setup.py
 * test` entry points — rather than from pytest alone.
 */
export const M194_RUNNER_TOKENS: readonly string[] = Object.freeze([
  "pytest",
  "py.test",
  "unittest",
  "runtests.py",
  "tox",
  "nosetests",
  "setup.py test",
  "sympy/testing",
  "bin/test",
  "make test",
  "./tests/",
  "test_",
  "_test.py",
  "sympy.test",
  "doctest",
]);

/**
 * Was this Bash call an attempt to validate?
 *
 * Two disjunctive witnesses, both structural, both blind to the outcome: the
 * command names a test runner, or a test runner demonstrably started. The
 * second catches a suite invoked by a name nobody anticipated; the first
 * catches an attempt that died before it could print a banner. Neither reads
 * the task's resolution, the gold patch, or whether the answer was convenient
 * (§27).
 *
 * Deliberately generous. A false positive adds one unusable episode to a
 * denominator that is reported; a false negative deletes an episode from the
 * corpus without leaving a trace, and the two errors are not equally
 * recoverable.
 */
export function isValidationAttempt(command: string, streams: StreamCapture): boolean {
  const c = command.toLowerCase();
  if (M194_RUNNER_TOKENS.some((t) => c.includes(t))) return true;
  return runnerStarted(streams);
}

/**
 * The stream pair as the frozen classifiers consume it.
 *
 * The container tee separates stdout from stderr but does not order them
 * against each other, so `mergedStream` is honestly absent rather than
 * fabricated from a concatenation that would claim an interleaving nobody
 * observed. `classificationText` then reads the union of the two, which is what
 * §20 requires and what M192's marker/result split made necessary.
 */
export function streamCapture(stdout: string | undefined, stderr: string | undefined): StreamCapture {
  return {
    stdout: stdout ?? "",
    stderr: stderr ?? "",
    mergedStream: null,
    mergedStreamComplete: false,
  };
}
