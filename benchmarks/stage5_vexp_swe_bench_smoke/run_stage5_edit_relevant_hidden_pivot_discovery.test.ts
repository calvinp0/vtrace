import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  buildCandidate,
  buildReport,
  classifyCandidate,
  parseArgs,
  renderJson,
  renderMarkdown,
  scoreCandidate,
  shortId,
  splitPivots,
  type CandidateInput,
} from "./run_stage5_edit_relevant_hidden_pivot_discovery";

const ANCHOR_REASON = "source line anchor in the issue points at this symbol — explicit edit site";
const HIDDEN_REASON = "actionable function — exercised by a failing test; symbol-name match";

// A sphinx-7462-shaped input: live split, anchored file + DISTINCT hidden pivot
// whose file IS in the gold patch.
function sphinxLikeInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    instanceId: "sphinx-doc__sphinx-7462",
    repo: "sphinx-doc/sphinx",
    goldFiles: ["sphinx/domains/python.py", "sphinx/pycode/ast.py"],
    pivots: [
      { path: "sphinx/domains/python.py", symbol: "_parse_annotation", roleReason: ANCHOR_REASON },
      { path: "sphinx/pycode/ast.py", symbol: "unparse", roleReason: HIDDEN_REASON },
    ],
    pivotSource: "live",
    anchorSource: "live_role_reason",
    retrievedGoldAnywhere: true,
    priorLiveLabels: ["eval-pivot-check-vtrace-sphinx-7462"],
    priorEditedFiles: ["sphinx/domains/python.py"],
    curatedEditRelevant: true,
    curatedClassification: "failed_to_connect_to_edit",
    ...overrides,
  };
}

// A seaborn-3187-shaped input: live split, hidden pivot NOT in gold (reproduction
// entry point), curated not-edit-relevant.
function seabornLikeInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    instanceId: "mwaskom__seaborn-3187",
    repo: "mwaskom/seaborn",
    goldFiles: ["seaborn/_core/scales.py", "seaborn/utils.py"],
    pivots: [
      { path: "seaborn/_core/scales.py", symbol: "_setup", roleReason: ANCHOR_REASON },
      { path: "seaborn/relational.py", symbol: "scatterplot", roleReason: HIDDEN_REASON },
    ],
    pivotSource: "live",
    anchorSource: "live_role_reason",
    retrievedGoldAnywhere: true,
    priorLiveLabels: ["eval-pivot-check-vtrace-seaborn-3187"],
    priorEditedFiles: ["seaborn/_core/scales.py", "seaborn/utils.py"],
    curatedEditRelevant: false,
    curatedClassification: "not_actually_edit_relevant",
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Test 1: scoring ranks hidden gold-overlap above hidden non-gold.
// --------------------------------------------------------------------------

test("scoring ranks a hidden gold-overlap pivot above a hidden non-gold pivot", () => {
  const goldOverlap = scoreCandidate(sphinxLikeInput()).score;
  const nonGold = scoreCandidate(seabornLikeInput()).score;
  assert.ok(goldOverlap > nonGold, `expected gold-overlap (${goldOverlap}) > non-gold (${nonGold})`);
  // The +3 gold-overlap factor fires for sphinx, not for seaborn.
  assert.ok(scoreCandidate(sphinxLikeInput()).factors.some((f) => f.label.includes("overlaps gold")));
  assert.ok(!scoreCandidate(seabornLikeInput()).factors.some((f) => f.label.includes("overlaps gold")));
});

// --------------------------------------------------------------------------
// Test 2: missing gold metadata => unknown edit relevance, not false certainty.
// --------------------------------------------------------------------------

test("missing gold metadata yields unknown overlap, never a fabricated yes/no", () => {
  const c = buildCandidate(
    sphinxLikeInput({ goldFiles: null, curatedEditRelevant: null, curatedClassification: null }),
  );
  assert.equal(c.hiddenGoldOverlap, "unknown");
  assert.equal(c.goldPatchFiles, null);
  // It must not be promoted to Tier 1 without gold/curated evidence.
  assert.notEqual(c.tier, "tier1");
  // And the −3 "no gold/edit-relevance evidence" factor fires.
  assert.ok(c.factors.some((f) => f.label.includes("no gold/edit-relevance evidence") && f.points === -3));
});

// --------------------------------------------------------------------------
// Test 3: a no-hidden-pivot case is rejected.
// --------------------------------------------------------------------------

test("a case with no hidden pivot is rejected", () => {
  const input = sphinxLikeInput({
    // Both pivots anchored (no hidden), single concept.
    pivots: [
      { path: "sphinx/domains/python.py", symbol: "_parse_annotation", roleReason: ANCHOR_REASON },
      { path: "sphinx/domains/python.py", symbol: "_parse_arglist", roleReason: ANCHOR_REASON },
    ],
  });
  const { tier } = classifyCandidate(input);
  assert.equal(tier, "reject");
  assert.ok(scoreCandidate(input).factors.some((f) => f.label === "no hidden pivot" && f.points === -5));
});

// --------------------------------------------------------------------------
// Test 4: a retrieval-missing-hidden/gold-file case is rejected/penalized.
// --------------------------------------------------------------------------

test("a retrieval-missing-gold case is rejected and penalized", () => {
  const input = sphinxLikeInput({ retrievedGoldAnywhere: false });
  const { tier } = classifyCandidate(input);
  assert.equal(tier, "reject");
  const { factors } = scoreCandidate(input);
  assert.ok(factors.some((f) => f.label === "retrieval missing hidden/gold file" && f.points === -4));
});

// --------------------------------------------------------------------------
// Test 5: markdown includes the rubric and the telemetry-vs-curated distinction.
// --------------------------------------------------------------------------

test("markdown includes the scoring rubric and the telemetry-vs-curated distinction", () => {
  const report = buildReport([sphinxLikeInput(), seabornLikeInput()], ["fixture.json"], "2026-06-09T00:00:00.000Z");
  const md = renderMarkdown(report);
  assert.ok(md.includes("## Scoring rubric"));
  assert.ok(md.includes("hidden pivot overlaps gold patch file"));
  assert.ok(md.includes("Telemetry-derived vs curated/gold-derived"));
  assert.ok(md.includes("Gold-derived"));
  assert.ok(md.includes("never invented") || md.includes("never agent input"));
  // Required sections present.
  for (const section of [
    "## Summary",
    "## Method",
    "## Tier 1 candidates",
    "## Tier 2 candidates",
    "## Rule-out / control candidates",
    "## Rejected candidates",
    "## Known limitations",
    "## Recommended next live runs",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(section), `missing section: ${section}`);
  }
});

// --------------------------------------------------------------------------
// Test 6: JSON includes machine-readable candidate fields.
// --------------------------------------------------------------------------

test("JSON exposes machine-readable candidate fields", () => {
  const report = buildReport([sphinxLikeInput(), seabornLikeInput()], ["fixture.json"], null);
  const parsed = JSON.parse(renderJson(report));
  for (const key of ["generatedAt", "sourceArtifacts", "summary", "candidates"]) {
    assert.ok(key in parsed, `report missing key: ${key}`);
  }
  const c = parsed.candidates[0];
  for (const key of [
    "instanceId", "repo", "score", "tier", "sourceAnchorFiles", "hiddenPivotFiles",
    "hiddenPivotSymbols", "goldPatchFiles", "hiddenGoldOverlap", "priorLiveStatus",
    "priorHiddenPivotEngagement", "classificationReason", "risks",
    "recommendedBeforeLabel", "recommendedAfterLabel", "commands",
  ]) {
    assert.ok(key in c, `candidate missing key: ${key}`);
  }
  // Summary counts are present and numeric.
  for (const key of ["instancesConsidered", "tier1", "tier2", "ruleout", "reject"]) {
    assert.equal(typeof parsed.summary[key], "number");
  }
});

// --------------------------------------------------------------------------
// Test 7 + 8: run commands carry --disable-pivot-check on before, not after.
// --------------------------------------------------------------------------

test("generated before-command includes --disable-pivot-check; after-command does not", () => {
  const c = buildCandidate(sphinxLikeInput());
  assert.ok(c.commands !== null);
  const [before, after] = c.commands!;
  assert.ok(before!.includes("# before: PIVOT_CHECK disabled"));
  assert.ok(before!.includes("--disable-pivot-check"));
  assert.ok(before!.includes(c.recommendedBeforeLabel!));
  assert.ok(after!.includes("# after: PIVOT_CHECK enabled"));
  assert.ok(!after!.includes("--disable-pivot-check"));
  assert.ok(after!.includes(c.recommendedAfterLabel!));
  // Labels follow the convention.
  assert.equal(c.recommendedBeforeLabel, "eval-pivot-telemetry-vtrace-sphinx-7462-no-pivot-check");
  assert.equal(c.recommendedAfterLabel, "eval-pivot-check-vtrace-sphinx-7462");
});

// --------------------------------------------------------------------------
// Tiering + classification specifics.
// --------------------------------------------------------------------------

test("sphinx-shaped live candidate is Tier 1; seaborn-shaped non-gold is rule-out", () => {
  assert.equal(buildCandidate(sphinxLikeInput()).tier, "tier1");
  const seaborn = buildCandidate(seabornLikeInput());
  assert.equal(seaborn.tier, "ruleout");
  assert.equal(seaborn.hiddenGoldOverlap, false);
});

test("deterministic rank-proxy gold-overlap is capped at Tier 2, not Tier 1", () => {
  // Same gold overlap + distinct hidden file, but the split came from the rank
  // proxy (no live capsule) — must not be promoted to Tier 1.
  const proxy = sphinxLikeInput({
    pivotSource: "deterministic",
    anchorSource: "deterministic_rank_proxy",
    priorLiveLabels: [],
    priorEditedFiles: null,
    curatedEditRelevant: null,
    curatedClassification: null,
    // role reasons are deterministic (no "source line anchor"); rank proxy decides.
    pivots: [
      { path: "sympy/core/sympify.py", symbol: "sympify", roleReason: "actionable class — strong lexical match" },
      { path: "sympy/core/evalf.py", symbol: "evalf", roleReason: "actionable function — strong lexical match" },
    ],
    goldFiles: ["sympy/core/evalf.py"],
    instanceId: "sympy__sympy-13372",
    repo: "sympy/sympy",
  });
  const c = buildCandidate(proxy);
  assert.equal(c.tier, "tier2");
  assert.equal(c.hiddenGoldOverlap, true);
  assert.ok(c.risks.some((r) => r.includes("rank proxy")));
});

test("splitPivots uses role-reason live, rank proxy otherwise", () => {
  const pivots = [
    { path: "a.py", symbol: "x", roleReason: ANCHOR_REASON },
    { path: "b.py", symbol: "y", roleReason: HIDDEN_REASON },
  ];
  const live = splitPivots(pivots, "live_role_reason");
  assert.deepEqual(live.anchored.map((p) => p.path), ["a.py"]);
  assert.deepEqual(live.hidden.map((p) => p.path), ["b.py"]);

  // Rank proxy: top-1 file anchored regardless of role reason.
  const proxyPivots = [
    { path: "top.py", symbol: "x", roleReason: "lexical" },
    { path: "second.py", symbol: "y", roleReason: "lexical" },
  ];
  const proxy = splitPivots(proxyPivots, "deterministic_rank_proxy");
  assert.deepEqual(proxy.anchored.map((p) => p.path), ["top.py"]);
  assert.deepEqual(proxy.hidden.map((p) => p.path), ["second.py"]);
});

test("example/test-only hidden pivots are penalized", () => {
  const input = sphinxLikeInput({
    goldFiles: ["tests/test_foo.py"],
    pivots: [
      { path: "src/foo.py", symbol: "f", roleReason: ANCHOR_REASON },
      { path: "tests/test_foo.py", symbol: "test_f", roleReason: HIDDEN_REASON },
    ],
    curatedEditRelevant: null,
    curatedClassification: null,
  });
  const { factors } = scoreCandidate(input);
  assert.ok(factors.some((f) => f.label.includes("example/test-only") && f.points === -3));
});

test("buildReport sorts Tier 1 above Tier 2 above rule-out above reject", () => {
  const reject = sphinxLikeInput({
    instanceId: "x__reject-1",
    pivots: [{ path: "only.py", symbol: "f", roleReason: ANCHOR_REASON }],
  });
  const report = buildReport([seabornLikeInput(), reject, sphinxLikeInput()], ["s"], null);
  const tiers = report.candidates.map((c) => c.tier);
  // First must be tier1, last must be reject.
  assert.equal(tiers[0], "tier1");
  assert.equal(tiers[tiers.length - 1], "reject");
  assert.equal(report.summary.tier1, 1);
  assert.equal(report.summary.ruleout, 1);
  assert.equal(report.summary.reject, 1);
});

// --------------------------------------------------------------------------
// CLI parsing.
// --------------------------------------------------------------------------

test("parseArgs reads --results and --out-name with sensible defaults", () => {
  const def = parseArgs([]);
  assert.ok(def.resultsDir.length > 0);
  assert.equal(def.outName, "stage5_edit_relevant_hidden_pivot_candidates");
  const custom = parseArgs(["--results", "/tmp/r", "--out-name", "my_out"]);
  assert.equal(custom.resultsDir, "/tmp/r");
  assert.equal(custom.outName, "my_out");
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});

test("shortId strips the repo prefix", () => {
  assert.equal(shortId("sphinx-doc__sphinx-7462"), "sphinx-7462");
  assert.equal(shortId("django__django-12325"), "django-12325");
  assert.equal(shortId("mwaskom__seaborn-3187"), "seaborn-3187");
});
