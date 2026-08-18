import { describe, expect, test } from "bun:test";

import {
  allocateDifficultyQuota,
  allocateRepositoryQuota,
  archiveSubtree,
  assertDisjoint,
  createdFilesInPatch,
  goldPathInWorkspace,
  hashOrder,
  selectCorpus,
  selectionKey,
  SELECTION_SALT,
  withinArchiveSubtree,
  type PoolCandidate,
} from "./m160Corpus";

function candidate(instanceId: string, repo: string, difficulty: string): PoolCandidate {
  return {
    instanceId,
    repo,
    baseCommit: "0".repeat(40),
    difficulty,
    expectedFiles: [`${repo.split("/")[1]}/mod.py`],
    expectedSymbols: ["f"],
    goldFilesCreatedByPatch: [],
  };
}

describe("M160 repository quota (§18)", () => {
  test("fills every eligible repository equally when the pool allows", () => {
    const quota = allocateRepositoryQuota(new Map([["a", 50], ["b", 50], ["c", 50]]), 90);
    expect([...quota.values()]).toEqual([30, 30, 30]);
  });

  test("a repository smaller than its share is filled to its pool and redistributes the rest", () => {
    const quota = allocateRepositoryQuota(new Map([["big", 100], ["small", 2]]), 20);
    expect(quota.get("small")).toBe(2);
    expect(quota.get("big")).toBe(18);
  });

  test("never allocates more than a repository actually has", () => {
    const pool = new Map([["a", 3], ["b", 4]]);
    const quota = allocateRepositoryQuota(pool, 100);
    expect(quota.get("a")).toBe(3);
    expect(quota.get("b")).toBe(4);
  });

  test("the balanced rule caps the largest repository far below its proportional share", () => {
    // The real Broad100-B shape: django is 47% of the pool but must not become
    // 47% of the corpus, or repository breadth cannot be measured (§55).
    const pool = new Map([
      ["django/django", 187],
      ["sympy/sympy", 58],
      ["sphinx-doc/sphinx", 37],
      ["scikit-learn/scikit-learn", 30],
      ["matplotlib/matplotlib", 27],
      ["astropy/astropy", 17],
      ["pydata/xarray", 16],
      ["pytest-dev/pytest", 15],
      ["pylint-dev/pylint", 8],
      ["psf/requests", 4],
      ["mwaskom/seaborn", 1],
    ]);
    const quota = allocateRepositoryQuota(pool, 100);
    expect([...quota.values()].reduce((s, v) => s + v, 0)).toBe(100);
    expect(quota.get("django/django")).toBeLessThanOrEqual(12);
    expect(quota.get("mwaskom/seaborn")).toBe(1);
    expect(quota.get("psf/requests")).toBe(4);
  });

  test("the total never exceeds the pool", () => {
    const quota = allocateRepositoryQuota(new Map([["a", 2], ["b", 2]]), 100);
    expect([...quota.values()].reduce((s, v) => s + v, 0)).toBe(4);
  });
});

describe("M160 difficulty strata (§14)", () => {
  test("splits a repository quota in proportion to its own difficulty profile", () => {
    const quota = allocateDifficultyQuota(new Map([["easy", 75], ["hard", 25]]), 8);
    expect(quota.get("easy")).toBe(6);
    expect(quota.get("hard")).toBe(2);
  });

  test("never asks a stratum for more rows than it holds", () => {
    const quota = allocateDifficultyQuota(new Map([["easy", 1], ["hard", 99]]), 10);
    expect(quota.get("easy")).toBeLessThanOrEqual(1);
    expect([...quota.values()].reduce((s, v) => s + v, 0)).toBe(10);
  });

  test("an empty repository quota selects nothing", () => {
    const quota = allocateDifficultyQuota(new Map([["easy", 5]]), 0);
    expect(quota.get("easy")).toBe(0);
  });
});

describe("M160 deterministic ordering (§16)", () => {
  test("the salt is the seed: the same pool always yields the same order", () => {
    const items = [candidate("z-1", "r/r", "d"), candidate("a-1", "r/r", "d"), candidate("m-1", "r/r", "d")];
    expect(hashOrder(items).map((i) => i.instanceId)).toEqual(hashOrder([...items].reverse()).map((i) => i.instanceId));
  });

  test("a different salt yields a different permutation", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => candidate(id, "r/r", "d"));
    const withDefault = hashOrder(ids).map((i) => i.instanceId).join(",");
    const withOther = hashOrder(ids, "other-salt").map((i) => i.instanceId).join(",");
    expect(withDefault).not.toBe(withOther);
  });

  test("the selection key is stable for the frozen salt", () => {
    expect(selectionKey("django__django-10554")).toBe(selectionKey("django__django-10554", SELECTION_SALT));
  });
});

describe("M160 selection (§13, §27)", () => {
  const pool: PoolCandidate[] = [];
  for (let i = 0; i < 40; i += 1) pool.push(candidate(`a-${i}`, "org/a", i % 2 === 0 ? "easy" : "hard"));
  for (let i = 0; i < 40; i += 1) pool.push(candidate(`b-${i}`, "org/b", i % 4 === 0 ? "hard" : "easy"));
  for (let i = 0; i < 3; i += 1) pool.push(candidate(`c-${i}`, "org/c", "easy"));

  test("hits the target size exactly", () => {
    expect(selectCorpus(pool, 30).selected.length).toBe(30);
  });

  test("is reproducible", () => {
    const first = selectCorpus(pool, 30).selected.map((c) => c.instanceId);
    const second = selectCorpus(pool, 30).selected.map((c) => c.instanceId);
    expect(first).toEqual(second);
  });

  test("respects the repository quota it reports", () => {
    const result = selectCorpus(pool, 30);
    for (const [repo, quota] of result.quotaByRepo) {
      expect(result.selected.filter((c) => c.repo === repo).length).toBe(quota);
    }
  });

  test("selects only pool members, without duplicates", () => {
    const result = selectCorpus(pool, 30);
    const ids = new Set(result.selected.map((c) => c.instanceId));
    expect(ids.size).toBe(result.selected.length);
    for (const id of ids) expect(pool.some((c) => c.instanceId === id)).toBe(true);
  });

  test("selection order does not depend on pool order", () => {
    const shuffled = [...pool].reverse();
    expect(selectCorpus(shuffled, 30).selected.map((c) => c.instanceId))
      .toEqual(selectCorpus(pool, 30).selected.map((c) => c.instanceId));
  });
});

describe("M160 disjointness (§11)", () => {
  test("reports a clean zero overlap", () => {
    const result = assertDisjoint(["x", "y"], ["p", "q"]);
    expect(result.disjoint).toBe(true);
    expect(result.overlap).toEqual([]);
  });

  test("names every overlapping instance rather than just failing", () => {
    const result = assertDisjoint(["x", "y"], ["y", "x", "z"]);
    expect(result.disjoint).toBe(false);
    expect(result.overlap).toEqual(["x", "y"]);
  });
});

describe("M160 archived subtree scope (§80)", () => {
  test("django workspaces are rooted at the package, inherited from Broad100-A", () => {
    expect(archiveSubtree("django/django")).toBe("django");
    expect(archiveSubtree("astropy/astropy")).toBe("");
  });

  test("a gold path inside the package is in scope; one outside it is not", () => {
    expect(withinArchiveSubtree("django/django", "django/db/models/aggregates.py")).toBe(true);
    expect(withinArchiveSubtree("django/django", "scripts/manage_translations.py")).toBe(false);
    expect(withinArchiveSubtree("django/django", "docs/ref/models.txt")).toBe(false);
  });

  test("a repo-rooted workspace puts every gold path in scope", () => {
    expect(withinArchiveSubtree("sympy/sympy", "sympy/core/mul.py")).toBe(true);
    expect(withinArchiveSubtree("sympy/sympy", "setup.py")).toBe(true);
  });

  test("the archive strips the subtree prefix, so gold resolves at the workspace path", () => {
    expect(goldPathInWorkspace("django/django", "django/db/models/aggregates.py"))
      .toBe("db/models/aggregates.py");
    expect(goldPathInWorkspace("astropy/astropy", "astropy/io/ascii/qdp.py"))
      .toBe("astropy/io/ascii/qdp.py");
  });
});

describe("M160 created-file gold (§80)", () => {
  test("recognises a file the patch creates via `new file mode`", () => {
    const patch = [
      "diff --git a/pkg/new_mod.py b/pkg/new_mod.py",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/pkg/new_mod.py",
      "+def f(): pass",
    ].join("\n");
    expect(createdFilesInPatch(patch)).toEqual(["pkg/new_mod.py"]);
  });

  test("does not mistake an edited file for a created one", () => {
    const patch = [
      "diff --git a/pkg/mod.py b/pkg/mod.py",
      "--- a/pkg/mod.py",
      "+++ b/pkg/mod.py",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    expect(createdFilesInPatch(patch)).toEqual([]);
  });

  test("separates created from edited inside one multi-file patch", () => {
    // The real shape of astropy-13398: three edits plus one new module.
    const patch = [
      "diff --git a/pkg/a.py b/pkg/a.py",
      "--- a/pkg/a.py",
      "+++ b/pkg/a.py",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/pkg/b.py b/pkg/b.py",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/pkg/b.py",
      "+def g(): pass",
    ].join("\n");
    expect(createdFilesInPatch(patch)).toEqual(["pkg/b.py"]);
  });
});
