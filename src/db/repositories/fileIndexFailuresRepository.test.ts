/**
 * M156 §68/§71/§79: the failed-file record stays bounded, ordered and small.
 *
 * A repository with one bad fixture and a repository with a thousand generated
 * files that will not parse must produce responses of the SAME shape. The count
 * is exact either way; only the detail is capped. That is the M149/M151 rule
 * applied to a new lane, and the reason it is tested at a scale nobody has hit
 * yet is that bounded-by-accident is how the 290-entry index response happened.
 */
import { describe, expect, test } from "bun:test";

import { openIndexerDatabase } from "../sqlite";
import { FileFailureClass, boundFailureMessage, MAX_FAILURE_MESSAGE_LENGTH } from "../../indexer/fileFailureClassification";
import {
  countFileIndexFailures,
  findFileIndexFailure,
  listFailedFileLanguages,
  listFileIndexFailures,
  listFileIndexFailuresBounded,
  replaceFileIndexFailures,
  type FileIndexFailureRecord,
} from "./fileIndexFailuresRepository";

function failure(path: string, language = "python"): FileIndexFailureRecord {
  return {
    path,
    language,
    status: "parse_failed",
    failureClass: FileFailureClass.SyntaxError,
    message: "SyntaxError: invalid syntax",
    contentHash: "hash",
    sizeBytes: 10,
  };
}

describe("M156 file index failures", () => {
  test("a thousand failed files produce a bounded response with a truthful total", () => {
    const db = openIndexerDatabase();
    try {
      // Deliberately unsorted input, so the ordering guarantee is not an
      // accident of insertion order.
      const many = Array.from({ length: 1000 }, (_unused, index) => failure(`src/bad${999 - index}.py`));
      replaceFileIndexFailures(db, many);

      expect(countFileIndexFailures(db)).toBe(1000);

      const bounded = listFileIndexFailuresBounded(db, 4);
      expect(bounded.failures.length).toBe(4);
      // The bound caps the DETAIL, never the count the caller reasons with.
      expect(bounded.total).toBe(1000);
      // §77: returned detail never exceeds the total it is drawn from.
      expect(bounded.failures.length).toBeLessThanOrEqual(bounded.total);
    } finally {
      db.close();
    }
  });

  test("the failed-file set is deterministic and path-ordered", () => {
    const first = openIndexerDatabase();
    const second = openIndexerDatabase();
    try {
      replaceFileIndexFailures(first, [failure("src/z.py"), failure("src/a.py"), failure("src/m.py")]);
      replaceFileIndexFailures(second, [failure("src/m.py"), failure("src/z.py"), failure("src/a.py")]);

      const paths = (rows: readonly FileIndexFailureRecord[]): string[] => rows.map((row) => row.path);
      expect(paths(listFileIndexFailures(first))).toEqual(["src/a.py", "src/m.py", "src/z.py"]);
      // §71: same inputs, same rows, same order, regardless of arrival order.
      expect(listFileIndexFailures(first)).toEqual(listFileIndexFailures(second));
    } finally {
      first.close();
      second.close();
    }
  });

  test("replacing the set clears failures a later run no longer sees", () => {
    // §37: a repaired file must not keep a stale failure row.
    const db = openIndexerDatabase();
    try {
      replaceFileIndexFailures(db, [failure("src/a.py"), failure("src/b.py")]);
      replaceFileIndexFailures(db, [failure("src/b.py")]);

      expect(listFileIndexFailures(db).map((row) => row.path)).toEqual(["src/b.py"]);
      expect(findFileIndexFailure(db, "src/a.py")).toBeUndefined();
      // §23: a path-scoped question about a failed file gets a real answer.
      expect(findFileIndexFailure(db, "src/b.py")?.failureClass).toBe(FileFailureClass.SyntaxError);
    } finally {
      db.close();
    }
  });

  test("failed languages are reported distinctly so relevance can be judged", () => {
    const db = openIndexerDatabase();
    try {
      replaceFileIndexFailures(db, [
        failure("src/a.py", "python"),
        failure("src/b.pyx", "cython"),
        failure("src/c.py", "python"),
      ]);
      // §24: the caller needs to know WHICH languages are missing, not just how
      // many files, or it cannot tell a relevant gap from an irrelevant one.
      expect(listFailedFileLanguages(db)).toEqual(["cython", "python"]);
    } finally {
      db.close();
    }
  });

  test("failure messages are truncated rather than carrying source or stacks", () => {
    // §79. A parser that dumps a 40 KB payload must not put 40 KB per file into
    // repository-derived state that every coverage read then pays for.
    const enormous = `SyntaxError: ${"x".repeat(50_000)}`;
    const bounded = boundFailureMessage(enormous);

    expect(bounded.length).toBeLessThanOrEqual(MAX_FAILURE_MESSAGE_LENGTH);
    expect(bounded.startsWith("SyntaxError:")).toBe(true);
    // Whitespace is collapsed so a multi-line exception cannot smuggle a stack
    // in under the character bound.
    expect(boundFailureMessage("a\n\n   b\tc")).toBe("a b c");
  });
});
