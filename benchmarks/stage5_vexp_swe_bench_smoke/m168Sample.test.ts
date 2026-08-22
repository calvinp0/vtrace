import { describe, expect, test } from "bun:test";

import { complexityScore, selectSample, type SelectableInstance } from "./m168Sample";

function inst(
  id: string,
  repo: string,
  failToPass: number,
  patchLines: number,
): SelectableInstance {
  return {
    instance_id: id,
    repo,
    base_commit: `commit-${id}`,
    difficulty: "15 min - 1 hour",
    FAIL_TO_PASS: JSON.stringify(Array.from({ length: failToPass }, (_, i) => `t${i}`)),
    patch: ["diff --git a/x b/x", ...Array.from({ length: patchLines }, () => "+line")].join("\n"),
  };
}

describe("complexityScore reproduces the published proxy", () => {
  test("counts FAIL_TO_PASS at ten points and patch +/- lines at one", () => {
    expect(complexityScore(inst("a__a-1", "a/a", 2, 5))).toBe(25);
  });

  test("accepts an already-parsed array as well as the JSON string form", () => {
    const asArray = { FAIL_TO_PASS: ["t0", "t1"], patch: "+one\n-two\n context" };
    expect(complexityScore(asArray)).toBe(22);
  });

  test("unparseable FAIL_TO_PASS scores zero tests rather than throwing", () => {
    expect(complexityScore({ FAIL_TO_PASS: "not json", patch: "+a" })).toBe(1);
  });
});

describe("selectSample", () => {
  const pool: SelectableInstance[] = [];
  for (const [repo, count] of [["big/one", 44], ["mid/two", 17], ["small/three", 1]] as const) {
    for (let i = 0; i < count; i++) {
      pool.push(inst(`${repo.replace("/", "__")}-${100 + i}`, repo, (i % 4) + 1, i * 3 + 1));
    }
  }

  test("takes exactly one task per repository", () => {
    const result = selectSample(pool);
    expect(result.selected).toHaveLength(3);
    expect(new Set(result.selected.map((t) => t.repo)).size).toBe(3);
  });

  test("a single-task repository contributes that task", () => {
    const chosen = selectSample(pool).selected.find((t) => t.repo === "small/three");
    expect(chosen?.withinRepoTaskCount).toBe(1);
    expect(chosen?.withinRepoComplexityRank).toBe(1);
  });

  test("the holdout is exactly the complement and nothing is lost", () => {
    const result = selectSample(pool);
    const all = new Set(pool.map((i) => i.instance_id));
    expect(result.holdoutInstanceIds).toHaveLength(pool.length - result.selected.length);
    for (const id of result.holdoutInstanceIds) expect(all.has(id)).toBe(true);
    for (const t of result.selected) expect(result.holdoutInstanceIds).not.toContain(t.instanceId);
  });

  test("is deterministic — the same pool and seed give the same twelve", () => {
    const a = selectSample(pool).selected.map((t) => t.instanceId);
    const b = selectSample(pool).selected.map((t) => t.instanceId);
    expect(a).toEqual(b);
  });

  test("input order does not change the outcome", () => {
    const shuffled = [...pool].reverse();
    expect(selectSample(shuffled).selected).toEqual(selectSample(pool).selected);
  });

  test("a different seed can reassign quantiles, and never breaks one-per-repo", () => {
    const other = selectSample(pool, 7);
    expect(new Set(other.selected.map((t) => t.repo)).size).toBe(3);
    expect(other.selected).toHaveLength(3);
  });

  test("selection reads no outcome variable — identical pools differing only in "
    + "an outcome-shaped field select identically", () => {
    const tainted = pool.map((i) => ({ ...i, resolved: true, goldLocalised: false }));
    expect(selectSample(tainted).selected.map((t) => t.instanceId))
      .toEqual(selectSample(pool).selected.map((t) => t.instanceId));
  });

  test("chosen ranks track the assigned quantile within each repository", () => {
    for (const t of selectSample(pool).selected) {
      const expected = Math.min(
        t.withinRepoTaskCount - 1,
        Math.max(0, Math.round(t.targetQuantile * t.withinRepoTaskCount - 0.5)),
      );
      expect(t.withinRepoComplexityRank).toBe(expected + 1);
    }
  });
});
