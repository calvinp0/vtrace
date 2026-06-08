// Non-source example / documentation-data down-rank.
//
// WHY THIS EXISTS
// ----------------
// A production context provider must prefer real source files over docs,
// generated documentation data, test fixtures, and bad/good sample snippets. Some
// projects ship `.py` files under documentation/example trees that look like
// valid source and can ride a coincidental lexical hit into a PIVOT (e.g. pylint
// ships `doc/data/messages/**/bad.py`; matplotlib ships `galleries/examples/**`).
// Those are almost never the production edit target.
//
// This module is a GENERAL, repo-agnostic classifier: it recognises non-source
// example / doc-data paths by directory and filename conventions (no instance ids,
// no per-repo rules), and a task predicate that says whether the task explicitly
// points at docs/examples/fixtures (in which case the down-rank is suppressed).
//
// POLICY (applied by buildCapsuleV2):
//   - a non-source example candidate is NEVER a pivot by default,
//   - it may remain SUPPORT,
//   - it becomes a pivot only with explicit task/path evidence (this predicate, or
//     an explicit file-line anchor that named it outright).
// Tests are intentionally OUT OF SCOPE here — they are handled by the existing
// role gate ("a test symbol, not an edit target"); this targets non-test
// example/doc-data files.

export interface NonSourceExampleClassification {
  readonly isNonSourceExample: boolean;
  /** Why the path was treated as non-source (present only when classified). */
  readonly reason?: string;
}

export interface NonSourceDownrank {
  readonly path: string;
  readonly reason: string;
}

// Directory segments that mark a non-source example / doc-data / fixture tree.
// Matched against PATH SEGMENTS (not substrings) so `docs/` matches but a source
// file like `mypackage/docstore.py` does not. Conservative: bare `test`/`tests`
// is intentionally excluded (tests are handled by the role gate, not here).
const NON_SOURCE_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  "docs",
  "doc",
  "examples",
  "example",
  "tutorials",
  "tutorial",
  "samples",
  "sample",
  "fixtures",
  "testdata",
  "testing",
  "benchmarks",
  "asv_bench",
]);

// Multi-segment markers checked as path substrings (a single segment can't capture
// `doc/data` or `data/messages`). Ordered most-specific-first for the reason text.
const NON_SOURCE_PATH_MARKERS: readonly string[] = ["doc/data", "docs/data", "data/messages"];

// Filenames that, regardless of directory, denote a sample/config snippet rather
// than a production edit target (a pylint `bad.py`/`good.py`, a Sphinx `conf.py`).
const NON_SOURCE_FILENAMES: ReadonlySet<string> = new Set([
  "bad.py",
  "good.py",
  "example.py",
  "sample.py",
  "conf.py",
]);

// Classify a repo-relative path as a non-source example / doc-data file. Pure and
// deterministic; recognises by directory convention, multi-segment doc-data
// markers, then sample/config filename. Returns the most specific reason.
export function classifyNonSourceExample(filePath: string): NonSourceExampleClassification {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
  if (normalized.length === 0) return { isNonSourceExample: false };

  // Multi-segment markers first — most specific (`path under doc/data`).
  for (const marker of NON_SOURCE_PATH_MARKERS) {
    if (normalized.includes(`${marker}/`)) {
      return { isNonSourceExample: true, reason: `path under ${marker}` };
    }
  }

  const segments = normalized.split("/").filter((s) => s.length > 0);
  const dirSegments = segments.slice(0, -1);
  for (const segment of dirSegments) {
    if (NON_SOURCE_DIR_SEGMENTS.has(segment)) {
      return { isNonSourceExample: true, reason: `path under ${segment}/` };
    }
  }

  const base = segments[segments.length - 1] ?? "";
  if (NON_SOURCE_FILENAMES.has(base)) {
    return { isNonSourceExample: true, reason: `non-source example file ${base}` };
  }

  return { isNonSourceExample: false };
}

// The pivot-demotion decision for a single candidate, factored out so the policy
// is unit-testable without the full pipeline. A candidate is demoted out of the
// pivot role when it is a non-source example AND it currently holds the pivot role
// AND the task does not explicitly allow non-source AND no explicit line anchor
// named it. `classification` is returned regardless (so the caller can tag the
// signal even on support/discard items); `demote` is the pivot-eviction decision.
export interface NonSourcePivotDecision {
  readonly classification: NonSourceExampleClassification;
  readonly demote: boolean;
}

export function nonSourcePivotDemotion(
  filePath: string,
  opts: { readonly isPivot: boolean; readonly taskAllowsNonSource: boolean; readonly isAnchored: boolean },
): NonSourcePivotDecision {
  const classification = classifyNonSourceExample(filePath);
  if (!classification.isNonSourceExample) {
    return { classification, demote: false };
  }
  const explicitlyAllowed = opts.taskAllowsNonSource || opts.isAnchored;
  return { classification, demote: opts.isPivot && !explicitlyAllowed };
}

// Does the task EXPLICITLY point at docs / examples / fixtures / test-data? When it
// does, the down-rank is suppressed (the user is asking about those areas, so they
// are legitimate edit targets). Deliberately conservative: a bare "for example" /
// "e.g." discourse marker does NOT count — only a concrete non-source PATH, or an
// unambiguous domain phrase ("documentation", "example files", "the docs", a
// fixture / test-data mention).
export function taskMentionsNonSource(task: string): boolean {
  const t = task.toLowerCase();
  // An explicit path into a non-source tree is the strongest, least-ambiguous signal.
  if (/(?:^|[\s"'`([/])(?:docs?|examples?|tutorials?|samples?|fixtures?|testdata|testing|benchmarks|asv_bench)\//.test(t)) {
    return true;
  }
  if (/doc\/data|docs\/data|data\/messages/.test(t)) return true;
  // Unambiguous domain words (NOT bare "example", which is usually "for example").
  if (/\b(?:documentation|docstrings?|tutorials?|fixtures?|testdata)\b/.test(t)) return true;
  if (/\btest data\b/.test(t)) return true;
  if (/\b(?:example|sample) files?\b|\bexamples? (?:directory|dir|folder|gallery|page)\b/.test(t)) return true;
  // "the docs" / "in the docs" / "docs build" — docs as a standalone noun.
  if (/\bdocs\b/.test(t)) return true;
  return false;
}
