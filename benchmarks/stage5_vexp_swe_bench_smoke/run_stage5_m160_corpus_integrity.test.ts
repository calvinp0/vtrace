import { describe, expect, test } from "bun:test";

import { goldFilePresent, treeSizeOutliers, type IntegrityRow } from "./run_stage5_m160_corpus_integrity";

function row(overrides: Partial<IntegrityRow> & { instanceId: string; repo: string }): IntegrityRow {
  return {
    baseCommit: "0".repeat(40),
    difficulty: "<15 min fix",
    verdict: "VALID",
    failure: null,
    detail: "",
    treeFileCount: 800,
    treePythonFileCount: 800,
    expectedFiles: [],
    missingGoldFiles: [],
    fetched: false,
    ...overrides,
  };
}

describe("M160 gold-file integrity detector — known positives (§42, §116)", () => {
  const tree = new Set([
    "django/db/models/aggregates.py",
    "django/db/models/query.py",
    "django/contrib/admin/utils.py",
  ]);

  test("finds a gold file that is present", () => {
    expect(goldFilePresent("django/db/models/aggregates.py", tree)).toBe(true);
  });

  test("KNOWN POSITIVE: catches the django-13590 shape — a truncated tree missing the gold subtree", () => {
    // The real defect: the extraction stopped part-way through the alphabet, so
    // `db/` never landed while `apps/` and `contrib/` did. A gate that only
    // counted files would have called this healthy.
    const truncated = new Set(["django/apps/registry.py", "django/contrib/admin/utils.py"]);
    expect(goldFilePresent("django/db/models/sql/query.py", truncated)).toBe(false);
  });

  test("does not match on a suffix that crosses a path boundary", () => {
    // §24 — the comparator M157 proved can invert a conclusion when it is naive.
    expect(goldFilePresent("utils.py", new Set(["django/contrib/admindocs_utils.py"]))).toBe(false);
  });

  test("resolves a gold path against a workspace-prefixed candidate", () => {
    expect(goldFilePresent("db/models/aggregates.py", tree)).toBe(true);
  });

  test("an empty tree fails every gold file rather than passing vacuously", () => {
    expect(goldFilePresent("django/db/models/aggregates.py", new Set())).toBe(false);
  });
});

describe("M160 tree-size outlier probe", () => {
  test("KNOWN POSITIVE: flags the 442-against-827 shape M159 found", () => {
    const rows = [
      row({ instanceId: "a", repo: "django/django", treeFileCount: 827 }),
      row({ instanceId: "b", repo: "django/django", treeFileCount: 865 }),
      row({ instanceId: "c", repo: "django/django", treeFileCount: 869 }),
      row({ instanceId: "truncated", repo: "django/django", treeFileCount: 442 }),
    ];
    const flagged = treeSizeOutliers(rows);
    expect(flagged.map((f) => f.instanceId)).toEqual(["truncated"]);
  });

  test("does not flag ordinary variation between revisions", () => {
    const rows = [
      row({ instanceId: "a", repo: "sympy/sympy", treeFileCount: 1100 }),
      row({ instanceId: "b", repo: "sympy/sympy", treeFileCount: 1116 }),
      row({ instanceId: "c", repo: "sympy/sympy", treeFileCount: 1150 }),
    ];
    expect(treeSizeOutliers(rows)).toEqual([]);
  });

  test("compares only within a repository, never across them", () => {
    const rows = [
      row({ instanceId: "small-repo", repo: "psf/requests", treeFileCount: 90 }),
      row({ instanceId: "big-repo", repo: "sympy/sympy", treeFileCount: 1116 }),
    ];
    expect(treeSizeOutliers(rows)).toEqual([]);
  });
});
