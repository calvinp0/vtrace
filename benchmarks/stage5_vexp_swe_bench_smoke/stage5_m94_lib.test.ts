import { describe, expect, test } from "bun:test";

import type { CapsuleSummary } from "./run_stage5_retrieval_eval";
import {
  allGoldIn,
  anyGoldIn,
  assertNoGoldLeakage,
  capsuleFilesOf,
  classify,
  computeBudgetMetrics,
  computeFileMetrics,
  computeSymbolMetrics,
  computeTargetMetrics,
  extractGold,
  firstGoldRank,
  isTestFile,
  mean,
  median,
  mrr,
  percentile,
  rate,
  recallAtK,
  type CapsuleItemDetail,
} from "./stage5_m94_lib";

// A minimal CapsuleSummary factory — only the fields the M94 metrics read.
function summary(
  pivots: Array<{ path: string; symbol?: string; fqName?: string }>,
  support: Array<{ path: string; symbol?: string; fqName?: string }>,
  extra: Partial<CapsuleSummary> = {},
): CapsuleSummary {
  const sel = (role: "pivot" | "support") => (p: { path: string; symbol?: string; fqName?: string }) => ({
    role,
    path: p.path,
    symbol: p.symbol ?? "sym",
    fqName: p.fqName ?? `${p.path}::${p.symbol ?? "sym"}`,
    final: 1,
    roleReason: "",
    isEntryPoint: false,
    isGenericInfrastructure: false,
  });
  return {
    intent: "debug",
    actualMode: "standard",
    budgetTokens: 8000,
    estimatedTokens: 4000,
    usedPercent: 50,
    pivots: pivots.map(sel("pivot")),
    support: support.map(sel("support")),
    discarded: [],
    candidateCount: 10,
    subsystemRoot: null,
    lineAnchorResolutionUsed: false,
    filteredGenericSymbols: [],
    filteredRunnerFiles: [],
    downweightedLexicalTokens: [],
    deanchoredExceptionTokens: [],
    bodyLiteralMatches: [],
    nonSourceDownranked: [],
    titleSymbolTerms: [],
    titleSymbolMatches: [],
    literalAnchorTerms: [],
    literalAnchorMatches: [],
    graphNeighborMatches: [],
    genericLexicalDecoysSuppressed: [],
    ...extra,
  };
}

const GOLD_SINGLE = [
  "diff --git a/src/pkg/mod.py b/src/pkg/mod.py",
  "--- a/src/pkg/mod.py",
  "+++ b/src/pkg/mod.py",
  "@@ -10,7 +10,7 @@ class Widget:",
  "     def render(self):",
  "-        return 1",
  "+        return 2",
].join("\n");

const GOLD_MULTI_WITH_TEST = [
  "diff --git a/src/pkg/a.py b/src/pkg/a.py",
  "--- a/src/pkg/a.py",
  "+++ b/src/pkg/a.py",
  "@@ -1,3 +1,3 @@ def alpha():",
  "-    x = 1",
  "+    x = 2",
  "diff --git a/src/pkg/b.py b/src/pkg/b.py",
  "--- a/src/pkg/b.py",
  "+++ b/src/pkg/b.py",
  "@@ -1,3 +1,3 @@ def beta():",
  "-    y = 1",
  "+    y = 2",
  "diff --git a/tests/test_a.py b/tests/test_a.py",
  "--- a/tests/test_a.py",
  "+++ b/tests/test_a.py",
  "@@ -1,3 +1,3 @@ def test_alpha():",
  "-    assert 1",
  "+    assert 2",
].join("\n");

describe("gold extraction", () => {
  test("isTestFile recognizes common test paths", () => {
    expect(isTestFile("tests/test_a.py")).toBe(true);
    expect(isTestFile("src/pkg/test_mod.py")).toBe(true);
    expect(isTestFile("src/pkg/mod_test.py")).toBe(true);
    expect(isTestFile("src/pkg/mod.py")).toBe(false);
  });

  test("single-file source patch", () => {
    const g = extractGold(GOLD_SINGLE);
    expect(g.allFiles).toEqual(["src/pkg/mod.py"]);
    expect(g.sourceFiles).toEqual(["src/pkg/mod.py"]);
    expect(g.testFiles).toEqual([]);
    expect(g.scoredFiles).toEqual(["src/pkg/mod.py"]);
    expect(g.sourceOnly).toBe(true);
    expect(g.multiFile).toBe(false);
    expect(g.symbolStatus).toBe("available");
    expect(g.symbols).toContain("Widget");
    expect(g.symbols).toContain("render");
  });

  test("multi-file patch classifies test vs source and scores source only", () => {
    const g = extractGold(GOLD_MULTI_WITH_TEST);
    expect(g.sourceFiles.sort()).toEqual(["src/pkg/a.py", "src/pkg/b.py"]);
    expect(g.testFiles).toEqual(["tests/test_a.py"]);
    expect(g.scoredFiles.sort()).toEqual(["src/pkg/a.py", "src/pkg/b.py"]);
    expect(g.sourceOnly).toBe(false);
    expect(g.multiFile).toBe(true);
    // Symbols only from scored (source) files, not the test file.
    expect(g.symbols).not.toContain("test_alpha");
  });

  test("test-only patch falls back to test files as scored set", () => {
    const patch = [
      "--- a/tests/test_only.py",
      "+++ b/tests/test_only.py",
      "@@ -1,2 +1,2 @@ def test_x():",
      "-    assert 1",
      "+    assert 2",
    ].join("\n");
    const g = extractGold(patch);
    expect(g.sourceFiles).toEqual([]);
    expect(g.scoredFiles).toEqual(["tests/test_only.py"]);
    expect(g.sourceOnly).toBe(false);
  });

  test("/dev/null (deleted file) is excluded", () => {
    const patch = ["--- a/gone.py", "+++ /dev/null", "@@ -1 +0,0 @@", "-x = 1"].join("\n");
    const g = extractGold(patch);
    expect(g.allFiles).toEqual([]);
  });
});

describe("gold leakage guard", () => {
  test("flags a full path in the task", () => {
    const g = extractGold(GOLD_SINGLE);
    expect(assertNoGoldLeakage("please fix src/pkg/mod.py behaviour", g)).toBe("src/pkg/mod.py");
  });
  test("does not flag a bare basename", () => {
    const g = extractGold(GOLD_SINGLE);
    expect(assertNoGoldLeakage("the mod.py rendering is wrong", g)).toBeNull();
  });
});

describe("recall@k, MRR, first rank", () => {
  const ranked = ["a/x.py", "b/y.py", "c/z.py", "d/w.py"];
  test("firstGoldRank is 1-indexed and null when absent", () => {
    expect(firstGoldRank(ranked, ["c/z.py"])).toBe(3);
    expect(firstGoldRank(ranked, ["nope.py"])).toBeNull();
  });
  test("recallAtK fraction over gold set", () => {
    expect(recallAtK(ranked, ["a/x.py", "c/z.py"], 1)).toBe(0.5);
    expect(recallAtK(ranked, ["a/x.py", "c/z.py"], 3)).toBe(1);
    expect(recallAtK(ranked, ["nope.py"], 10)).toBe(0);
    expect(recallAtK(ranked, [], 10)).toBe(0);
  });
  test("mrr is reciprocal rank", () => {
    expect(mrr(1)).toBe(1);
    expect(mrr(4)).toBe(0.25);
    expect(mrr(null)).toBe(0);
  });
  test("anyGoldIn / allGoldIn", () => {
    expect(anyGoldIn(ranked, ["c/z.py", "nope.py"])).toBe(true);
    expect(allGoldIn(ranked, ["a/x.py", "c/z.py"])).toBe(true);
    expect(allGoldIn(ranked, ["a/x.py", "nope.py"])).toBe(false);
    expect(allGoldIn(ranked, [])).toBe(false);
  });
});

describe("capsule file projection + file metrics", () => {
  test("lead pivot gold, all gold in capsule ⇒ perfect recall", () => {
    const g = extractGold(GOLD_SINGLE);
    const s = summary([{ path: "src/pkg/mod.py", symbol: "render" }], [{ path: "src/other.py" }]);
    const cf = capsuleFilesOf(s);
    expect(cf.leadPivotFile).toBe("src/pkg/mod.py");
    expect(cf.requiredFiles).toEqual(["src/pkg/mod.py"]);
    const fm = computeFileMetrics(s, g, cf);
    expect(fm.gold_file_recall_at_1).toBe(1);
    expect(fm.first_gold_file_rank).toBe(1);
    expect(fm.lead_pivot_is_source_gold).toBe(true);
    expect(fm.all_gold_in_capsule).toBe(true);
    expect(fm.hidden_coedit_recall).toBeNull();
  });

  test("multi-file hidden co-edit recall reflects missing co-edit", () => {
    const g = extractGold(GOLD_MULTI_WITH_TEST); // scored: a.py, b.py
    // Capsule has a.py (lead) but not b.py.
    const s = summary([{ path: "src/pkg/a.py" }], [{ path: "src/unrelated.py" }]);
    const cf = capsuleFilesOf(s);
    const fm = computeFileMetrics(s, g, cf);
    expect(fm.lead_pivot_is_source_gold).toBe(true);
    expect(fm.hidden_coedit_recall).toBe(0); // b.py missing
    expect(fm.all_gold_in_capsule).toBe(false);
  });

  test("non-gold lead pivot", () => {
    const g = extractGold(GOLD_SINGLE);
    const s = summary([{ path: "src/wrong.py" }], [{ path: "src/pkg/mod.py" }]);
    const cf = capsuleFilesOf(s);
    const fm = computeFileMetrics(s, g, cf);
    expect(fm.lead_pivot_is_gold).toBe(false);
    expect(fm.any_gold_in_capsule).toBe(true); // in support
  });
});

describe("target metrics", () => {
  test("precision and overpacking", () => {
    const g = extractGold(GOLD_SINGLE);
    const s = summary(
      [{ path: "src/pkg/mod.py" }],
      [{ path: "n1.py" }, { path: "n2.py" }, { path: "n3.py" }],
    );
    const cf = capsuleFilesOf(s);
    const tm = computeTargetMetrics(g, cf);
    expect(tm.required_target_count).toBe(1);
    expect(tm.optional_target_count).toBe(3);
    expect(tm.required_gold_file_count).toBe(1);
    expect(tm.required_precision_file_level).toBe(1);
    expect(tm.capsule_file_count).toBe(4);
    expect(tm.capsule_gold_file_count).toBe(1);
    expect(tm.overpacking_ratio).toBe(4); // 4 files / 1 gold
    expect(tm.gold_file_density).toBe(0.25);
  });

  test("overpacking_ratio null when no gold in capsule", () => {
    const g = extractGold(GOLD_SINGLE);
    const s = summary([{ path: "n1.py" }], [{ path: "n2.py" }]);
    const cf = capsuleFilesOf(s);
    const tm = computeTargetMetrics(g, cf);
    expect(tm.overpacking_ratio).toBeNull();
    expect(tm.gold_file_in_required).toBe(false);
  });
});

describe("budget metrics", () => {
  test("gold vs non-gold char accounting + mode counts", () => {
    const g = extractGold(GOLD_SINGLE);
    const s = summary([{ path: "src/pkg/mod.py" }], [{ path: "other.py" }]);
    const cf = capsuleFilesOf(s);
    const items: CapsuleItemDetail[] = [
      { path: "src/pkg/mod.py", role: "pivot", contentMode: "full", chars: 300, estTokens: 75 },
      { path: "other.py", role: "support", contentMode: "signature", chars: 100, estTokens: 25 },
    ];
    const bm = computeBudgetMetrics(s, items, g, cf, ["low_score", "low_score", "budget"]);
    expect(bm.capsule_char_count).toBe(400);
    expect(bm.gold_chars).toBe(300);
    expect(bm.non_gold_chars).toBe(100);
    expect(bm.mode_counts).toEqual({ full: 1, signature: 1 });
    expect(bm.compression_reason_counts).toEqual({ low_score: 2, budget: 1 });
    expect(bm.digest_est_tokens).toBeNull();
    expect(bm.chars_per_gold_file_in_capsule).toBe(400);
  });
});

describe("symbol metrics", () => {
  test("available symbols recalled in pivot", () => {
    const g = extractGold(GOLD_SINGLE); // symbols: Widget, render
    const s = summary([{ path: "src/pkg/mod.py", symbol: "render", fqName: "src/pkg/mod.py::Widget.render" }], []);
    const sm = computeSymbolMetrics(s, g);
    expect(sm.gold_symbol_status).toBe("available");
    expect(sm.gold_symbol_in_capsule).toBe(true);
    expect(sm.gold_symbol_in_required).toBe(true);
  });
  test("unavailable when no gold symbols", () => {
    const patch = ["--- a/data.txt", "+++ b/data.txt", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    const g = extractGold(patch);
    const sm = computeSymbolMetrics(summary([], []), g);
    expect(sm.gold_symbol_status).toBe("unavailable");
    expect(sm.gold_symbol_recall_at_5).toBeNull();
  });
});

describe("failure-mode classification", () => {
  test("excellent: lead pivot is source gold, all gold packed, low overpack", () => {
    const g = extractGold(GOLD_SINGLE);
    const s = summary([{ path: "src/pkg/mod.py" }], []);
    const cf = capsuleFilesOf(s);
    const c = classify(g, computeFileMetrics(s, g, cf), computeTargetMetrics(g, cf));
    expect(c.outcome).toBe("excellent");
    expect(c.reasons).toEqual([]);
  });

  test("miss: no gold anywhere", () => {
    const g = extractGold(GOLD_SINGLE);
    const s = summary([{ path: "n1.py" }], [{ path: "n2.py" }]);
    const cf = capsuleFilesOf(s);
    const c = classify(g, computeFileMetrics(s, g, cf), computeTargetMetrics(g, cf));
    expect(c.outcome).toBe("miss");
    expect(c.reasons).toContain("lexical_mismatch");
  });

  test("miss flags zero_required when capsule named no pivot", () => {
    const g = extractGold(GOLD_SINGLE);
    const s = summary([], []);
    const cf = capsuleFilesOf(s);
    const c = classify(g, computeFileMetrics(s, g, cf), computeTargetMetrics(g, cf), {
      unparsedLanguageGold: false,
      zeroRequired: true,
    });
    expect(c.outcome).toBe("miss");
    expect(c.reasons).toContain("zero_required_but_gold_exists");
  });

  test("overpacked: gold present but too much non-gold context", () => {
    const g = extractGold(GOLD_SINGLE);
    const s = summary(
      [{ path: "n0.py" }],
      [
        { path: "src/pkg/mod.py" },
        { path: "n1.py" },
        { path: "n2.py" },
        { path: "n3.py" },
        { path: "n4.py" },
        { path: "n5.py" },
      ],
    );
    const cf = capsuleFilesOf(s);
    const c = classify(g, computeFileMetrics(s, g, cf), computeTargetMetrics(g, cf));
    expect(c.outcome).toBe("overpacked");
    expect(c.reasons).toContain("too_many_optional_targets");
  });

  test("partial: hidden co-edit missing in multi-file", () => {
    const g = extractGold(GOLD_MULTI_WITH_TEST); // a.py + b.py
    const s = summary([{ path: "src/pkg/a.py" }], [{ path: "src/pkg/c.py" }]);
    const cf = capsuleFilesOf(s);
    const c = classify(g, computeFileMetrics(s, g, cf), computeTargetMetrics(g, cf));
    expect(["partial", "good"]).toContain(c.outcome);
    expect(c.reasons).toContain("hidden_coedit_missing");
  });

  test("language coverage gap surfaces for unparsed gold", () => {
    const g = extractGold(GOLD_SINGLE);
    const s = summary([], []);
    const cf = capsuleFilesOf(s);
    const c = classify(g, computeFileMetrics(s, g, cf), computeTargetMetrics(g, cf), {
      unparsedLanguageGold: true,
      zeroRequired: true,
    });
    expect(c.reasons).toContain("language_coverage_gap");
  });
});

describe("aggregation helpers", () => {
  test("mean/median/percentile/rate", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([5])).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(rate([true, false, true, true])).toBe(0.75);
    expect(rate([])).toBe(0);
  });
});

describe("determinism", () => {
  test("same inputs ⇒ identical metric rows", () => {
    const g = extractGold(GOLD_MULTI_WITH_TEST);
    const s = summary([{ path: "src/pkg/a.py" }], [{ path: "src/pkg/b.py" }, { path: "n.py" }]);
    const cf = capsuleFilesOf(s);
    const run = () => JSON.stringify(computeFileMetrics(s, g, cf)) + JSON.stringify(computeTargetMetrics(g, cf));
    expect(run()).toBe(run());
  });
});
