// M144 — a traceback frame is only evidence about code this repository owns.
//
// M142 established that exactly ONE frame may contribute an explicit identifier,
// that the traceback must be complete, and that a language-protocol dunder is
// never the subject of the report. Those rules all survive here unchanged; M144
// adds one more question, asked before the frame is chosen: whose code is it?
//
// The frozen 50 contains four different ways a frame can name a file that is not
// part of the repository being searched — the reporter's own script, the
// standard library, an interpreter pseudo-file, and a foreign checkout — and one
// way it can look foreign while being the project's own code (an installed copy
// under `site-packages`). Path shape cannot separate those; only the index can.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { deriveQueryIntent } from "./querySemantics";
import {
  createRepositoryPathPredicate,
  normalizePathHint,
  pathsShareSuffixBoundary,
} from "./repositoryPathMembership";

/** The one frame identifier this task contributes, or `undefined`. */
function frameIdentifier(task: string, indexedPaths?: readonly string[]): string | undefined {
  const intent = deriveQueryIntent(
    task,
    indexedPaths === undefined ? {} : { isRepositoryPath: createRepositoryPathPredicate(indexedPaths) },
  );
  return intent.symbolHypotheses.find((signal) => signal.source === "traceback_frame")?.term;
}

const REQUESTS_FILES = ["requests/api.py", "requests/sessions.py", "requests/models.py", "test_requests.py"];

// ---------------------------------------------------------------------------
// Path identity
// ---------------------------------------------------------------------------

test("M144: a path hint normalizes across the shapes a traceback prints", () => {
  assert.equal(normalizePathHint("./sympy/core/evalf.py"), "sympy/core/evalf.py");
  assert.equal(normalizePathHint("\\path\\to\\sphinx\\domains\\python.py"), "path/to/sphinx/domains/python.py");
  assert.equal(normalizePathHint("/app/venv/lib/python3.8/site-packages/django/db/models/query.py"),
    "app/venv/lib/python3.8/site-packages/django/db/models/query.py");
  assert.equal(normalizePathHint("C:/Users/x/proj/main.py"), "Users/x/proj/main.py");
});

test("M144: membership is decided on a path-segment boundary, in either direction", () => {
  // The M143 §54 rule, applied to failure evidence rather than to gold paths.
  assert.ok(pathsShareSuffixBoundary("django/db/models/query.py", "db/models/query.py"));
  assert.ok(pathsShareSuffixBoundary("db/models/query.py", "django/db/models/query.py"));
  // A shared TEXT suffix that is not a segment boundary is not the same file.
  assert.ok(!pathsShareSuffixBoundary("app/unrelated.py", "related.py"));
  // Same basename, different directory, is not the same file.
  assert.ok(!pathsShareSuffixBoundary("a/widgets.py", "b/widgets.py"));
});

test("M144: an installed copy of the project's own code IS repository code", () => {
  // `site-packages` is not a synonym for "someone else's". django-12774's whole
  // traceback is inside an installed django, and it is the right localization.
  const inRepo = createRepositoryPathPredicate(["db/models/query.py", "db/models/manager.py"]);
  assert.ok(inRepo("/app/venv/lib/python3.8/site-packages/django/db/models/query.py"));
  // …while a genuinely foreign dependency at the same kind of path is not.
  assert.ok(!inRepo("/app/venv/lib/python3.8/site-packages/numpy/core/records.py"));
});

// ---------------------------------------------------------------------------
// Frame selection
// ---------------------------------------------------------------------------

test("M144: the standard library does not get to name the failure site", () => {
  // psf/requests-1724. Execution stopped in CPython's `httplib._send_output`,
  // which this repository has never contained; the last frame the project itself
  // owns is `sessions.py::send`.
  const task = 'File "/Users/hwkns/test_requests.py", line 6, in <module> | '
    + 'File "/Library/Python/2.7/site-packages/requests/api.py", line 44, in request | '
    + 'File "/Library/Python/2.7/site-packages/requests/sessions.py", line 335, in request | '
    + 'File "/Library/Python/2.7/site-packages/requests/sessions.py", line 438, in send | '
    + 'File "/System/.../lib/python2.7/httplib.py", line 809, in _send_output | '
    + "UnicodeDecodeError: 'ascii' codec can't decode byte 0xcf";
  assert.equal(frameIdentifier(task), "_send_output", "without an index, behaviour is unchanged");
  assert.equal(frameIdentifier(task, REQUESTS_FILES), "send");
});

test("M144: without a resolver every frame stays eligible (no-evidence equivalence)", () => {
  // §62/§63: the capability may not change anything for a caller that cannot say
  // what the repository contains. Omitted resolver == pre-M144 selection.
  const task = 'File "/usr/lib/python3.10/sre_parse.py", line 838, in _parse\nValueError: bad escape';
  assert.equal(frameIdentifier(task), "_parse");
});

test("M144: a frame in no repository at all names nothing", () => {
  // §67: external frames stay external. Every frame foreign -> no identifier,
  // rather than falling back to the deepest foreign one.
  const task = 'File "/usr/lib/python3.10/sre_compile.py", line 764, in compile | '
    + 'File "/usr/lib/python3.10/sre_parse.py", line 838, in _parse | '
    + "ValueError: bad escape";
  assert.equal(frameIdentifier(task, ["pylint/config/argument.py"]), undefined);
});

test("M144: a truncated traceback still names no site, whichever frame is nearest", () => {
  // pylint-8898. Completeness is a property of the TRACEBACK, so it is measured
  // after the deepest frame even when the selected frame is an earlier one —
  // otherwise repository filtering would quietly re-enable a truncated stack.
  const cut = 'File "/venv/lib/python3.10/site-packages/pylint/config/config_initialization.py", line 57, in _config_initialization | '
    + 'File "/usr/lib/python3.10/sre_parse.py", line 838, in _parse';
  assert.equal(frameIdentifier(cut, ["pylint/config/config_initialization.py"]), undefined);
  assert.equal(
    frameIdentifier(`${cut} | ValueError: bad escape`, ["pylint/config/config_initialization.py"]),
    "_config_initialization",
  );
});

test("M144: the symptom-site dunder guard survives repository filtering", () => {
  // pydata/xarray-3677. The deepest IN-REPOSITORY frame is now the accessor that
  // raised, so filtering must not hand it the eligibility the dunder rule denies.
  const task = 'File "/home/u/xarray/xarray/core/dataset.py", line 3591, in merge | '
    + 'File "/home/u/xarray/xarray/core/common.py", line 233, in __getattr__ | '
    + "AttributeError: 'DataArray' object has no attribute 'items'";
  assert.equal(frameIdentifier(task, ["xarray/core/dataset.py", "xarray/core/common.py"]), undefined);
});

test("M144: a single in-repository frame is unchanged by filtering", () => {
  // sphinx-7462 preservation: the M142 gain must not depend on frame depth.
  const task = 'File "\\path\\to\\site-packages\\sphinx\\domains\\python.py", line 112, in unparse '
    + "| IndexError: pop from empty list";
  assert.equal(frameIdentifier(task, ["sphinx/domains/python.py"]), "unparse");
});

test("M144: a bare frame tail carries no path and is not filtered on an absence", () => {
  // `line 45, in render_template` says nothing about whose file it is. Rejecting
  // it for lacking a path would silently delete the M142 bare-tail rule.
  assert.equal(frameIdentifier("line 45, in render_template\nTemplateError: missing block", ["app/views.py"]),
    "render_template");
});

test("M144: prose that merely mentions a file does not become a frame", () => {
  // §64: the words `test`, `error`, `traceback` and `file` must not, alone,
  // manufacture failure evidence.
  for (const prose of [
    "tests show this is slow",
    "this error is conceptual",
    "see file format documentation in tests.md",
    "the stack implementation is in stack.py",
    "traceback support was added recently",
  ]) {
    assert.equal(frameIdentifier(prose, ["stack.py", "tests.md"]), undefined, prose);
  }
});

test("M144: an interpreter pseudo-file is never a repository path", () => {
  const inRepo = createRepositoryPathPredicate(["app/main.py"]);
  for (const pseudo of ["<stdin>", "<console>", "<string>"]) assert.ok(!inRepo(pseudo));
});
