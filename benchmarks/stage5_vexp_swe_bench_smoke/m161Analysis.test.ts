import { describe, expect, test } from "bun:test";

import {
  LEAD_QUALITIES,
  buildMatrix,
  classifyPair,
  computeOrientation,
  crossTab,
  discordantExactP,
  pairedDelta,
  stats,
  touchesGold,
  type CrossTabCase,
  type ToolCall,
} from "./m161Analysis";

function call(index: number, category: string, path: string | null = null): ToolCall {
  return { index, tool: category === "search" ? "Grep" : category === "edit" ? "Edit" : "Read", category, path };
}

describe("M161 gold-path matching", () => {
  test("matches a repo-relative gold path against an absolute call path", () => {
    expect(touchesGold("/bench/sphinx-doc__sphinx/sphinx/util/inspect.py", ["sphinx/util/inspect.py"])).toBe(true);
  });

  test("does NOT match on basename alone", () => {
    // `utils.py` exists in a hundred packages; matching it would make every run
    // look like it reached gold.
    expect(touchesGold("/bench/repo/other/pkg/inspect.py", ["sphinx/util/inspect.py"])).toBe(false);
  });

  test("a null or empty path never matches", () => {
    expect(touchesGold(null, ["a.py"])).toBe(false);
    expect(touchesGold("", ["a.py"])).toBe(false);
  });
});

describe("M161 orientation (§60)", () => {
  const gold = ["pkg/mod.py"];
  const calls = [
    call(0, "search"),
    call(1, "read", "/w/pkg/other.py"),
    call(2, "read", "/w/pkg/mod.py"),
    call(3, "edit", "/w/pkg/mod.py"),
    call(4, "read", "/w/pkg/mod.py"),
  ];

  test("counts work before the first edit", () => {
    const got = computeOrientation(calls, gold);
    expect(got).toMatchObject({
      toolCalls: 5, searches: 1, reads: 3, edits: 1,
      firstEditIndex: 3, toolCallsBeforeFirstEdit: 3,
      searchesBeforeFirstEdit: 1, readsBeforeFirstEdit: 2,
      firstGoldTouchIndex: 2, goldTouchedBeforeFirstEdit: true,
    });
  });

  test("a run that never edits reports null rather than 0", () => {
    // 0 would say "edited immediately"; null says "never edited". Collapsing them
    // would make a run that produced no patch look like the fastest one.
    const got = computeOrientation([call(0, "search"), call(1, "read")], gold);
    expect(got.firstEditIndex).toBeNull();
    expect(got.toolCallsBeforeFirstEdit).toBeNull();
  });

  test("gold touched only AFTER the first edit is not counted as oriented", () => {
    const got = computeOrientation([call(0, "edit", "/w/pkg/wrong.py"), call(1, "read", "/w/pkg/mod.py")], gold);
    expect(got.firstGoldTouchIndex).toBe(1);
    expect(got.goldTouchedBeforeFirstEdit).toBe(false);
  });

  test("out-of-order input is sorted by index first", () => {
    const shuffled = [call(3, "edit", "/w/pkg/mod.py"), call(0, "search"), call(1, "read", "/w/pkg/mod.py")];
    expect(computeOrientation(shuffled, gold).firstEditIndex).toBe(2);
  });
});

describe("M161 paired matrix (§52)", () => {
  test("every cell of the matrix", () => {
    expect(classifyPair("PASS", "PASS")).toBe("shared success");
    expect(classifyPair("FAIL", "PASS")).toBe("VTRACE unique win");
    expect(classifyPair("PASS", "FAIL")).toBe("VTRACE unique loss");
    expect(classifyPair("FAIL", "FAIL")).toBe("shared failure");
  });

  test("an ungraded arm makes the pair incomplete, never a loss", () => {
    // §69: baseline PASS with no VTRACE result is an availability failure, not a
    // unique loss — the treatment agent never ran, so there is nothing to lose.
    expect(classifyPair("PASS", "UNGRADED")).toBe("incomplete");
    expect(classifyPair("UNGRADED", "PASS")).toBe("incomplete");
  });

  test("the matrix counts every pair exactly once", () => {
    const pairs = [
      { classification: classifyPair("PASS", "PASS") },
      { classification: classifyPair("FAIL", "PASS") },
      { classification: classifyPair("PASS", "FAIL") },
      { classification: classifyPair("FAIL", "FAIL") },
      { classification: classifyPair("PASS", "UNGRADED") },
    ];
    const matrix = buildMatrix(pairs);
    expect(Object.values(matrix).reduce((a, b) => a + b, 0)).toBe(5);
    expect(matrix["VTRACE unique win"]).toBe(1);
    expect(matrix.incomplete).toBe(1);
  });
});

describe("M161 uncertainty (§54)", () => {
  test("no discordant pairs is maximally uninformative", () => {
    expect(discordantExactP(0, 0)).toBe(1);
  });

  test("a 2-vs-2 split is nowhere near significant", () => {
    expect(discordantExactP(2, 2)).toBeGreaterThan(0.9);
  });

  test("even a clean 4-0 sweep of discordant pairs is only p=0.125", () => {
    // The number that stops "4 unique wins, 0 losses" being read as a result.
    expect(discordantExactP(4, 0)).toBeCloseTo(0.125, 5);
  });

  test("it takes 6-0 to clear 0.05", () => {
    expect(discordantExactP(5, 0)).toBeCloseTo(0.0625, 5);
    expect(discordantExactP(6, 0)).toBeCloseTo(0.03125, 5);
  });

  test("it is symmetric in wins and losses", () => {
    expect(discordantExactP(5, 1)).toBe(discordantExactP(1, 5));
  });
});

describe("M161 statistics", () => {
  test("median and p90 on a known series", () => {
    const got = stats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(got).toMatchObject({ n: 10, total: 55, mean: 5.5, median: 5.5, p90: 10 });
  });

  test("an empty series reports nulls rather than zeros", () => {
    expect(stats([])).toMatchObject({ n: 0, mean: null, median: null, p90: null });
  });

  test("paired deltas drop pairs where either side is missing", () => {
    const got = pairedDelta([
      { baseline: 10, vtrace: 15 },
      { baseline: 20, vtrace: 18 },
      { baseline: null, vtrace: 100 },
    ]);
    expect(got.n).toBe(2);
    expect(got.median).toBe(1.5);
  });
});

describe("M161 lead-quality cross-tab (§135)", () => {
  const cases: CrossTabCase[] = [
    {
      instanceId: "a-1", leadQuality: "LEAD_GOLD", treatmentState: "VALID_NONEMPTY",
      classification: "VTRACE unique win", baselineGrade: "FAIL", vtraceGrade: "PASS",
      tokenDelta: -1000, searchDelta: -2, turnDelta: -3, wallDelta: -5000, firstEditDelta: -1,
    },
    {
      instanceId: "a-2", leadQuality: "LEAD_GOLD", treatmentState: "VALID_NONEMPTY",
      classification: "shared success", baselineGrade: "PASS", vtraceGrade: "PASS",
      tokenDelta: 1000, searchDelta: 0, turnDelta: 1, wallDelta: 1000, firstEditDelta: 1,
    },
    {
      instanceId: "b-1", leadQuality: "LEAD_WRONG_NO_GOLD", treatmentState: "VALID_NONEMPTY",
      classification: "VTRACE unique loss", baselineGrade: "PASS", vtraceGrade: "FAIL",
      tokenDelta: 5000, searchDelta: 3, turnDelta: 8, wallDelta: 20000, firstEditDelta: 4,
    },
  ];

  test("rows aggregate per lead-quality label", () => {
    const rows = crossTab(cases);
    const gold = rows.find((r) => r.leadQuality === "LEAD_GOLD")!;
    expect(gold).toMatchObject({ cases: 2, baselinePass: 1, vtracePass: 2, uniqueWins: 1, uniqueLosses: 0, medianTokenDelta: 0 });
    expect(gold.instanceIds).toEqual(["a-1", "a-2"]);
  });

  test("labels with zero cases still get a row (§123)", () => {
    // A silently missing row and "0 cases" read identically in a report, and only
    // one of them is a finding.
    const rows = crossTab(cases);
    expect(rows.map((r) => r.leadQuality)).toEqual([...LEAD_QUALITIES]);
    const empty = rows.find((r) => r.leadQuality === "LEAD_WRONG_GOLD_ELSEWHERE")!;
    expect(empty.cases).toBe(0);
    expect(empty.medianTokenDelta).toBeNull();
  });

  test("every case lands in exactly one row", () => {
    expect(crossTab(cases).reduce((sum, r) => sum + r.cases, 0)).toBe(cases.length);
  });
});
