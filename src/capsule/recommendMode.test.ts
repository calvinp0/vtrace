import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  RecommendedCapsuleMode,
  TargetConfidence,
  deriveModeSignals,
  recommendCapsuleMode,
  type ModeRecommendationSignals,
} from "./recommendMode";
import { shapeSweQuery } from "./sweQueryShaping";
import {
  LOCAL_FIXTURES,
  NAVIGATION_HEAVY_FIXTURES,
  SWE_10880,
  SWE_11095,
  SWE_11490,
  SWE_11728,
  SWE_11740,
} from "./__fixtures__/sweRecords";

function recommendFor(record: Parameters<typeof shapeSweQuery>[0]) {
  const shaped = shapeSweQuery(record);
  return recommendCapsuleMode(deriveModeSignals(record, shaped));
}

test("the three navigation-heavy fixtures recommend full", () => {
  for (const fixture of NAVIGATION_HEAVY_FIXTURES) {
    const rec = recommendFor(fixture);
    assert.equal(
      rec.recommendedMode,
      RecommendedCapsuleMode.Full,
      `${fixture.instanceId} should be full, got ${rec.recommendedMode}`,
    );
  }
});

test("named navigation-heavy fixtures map to full with reasons", () => {
  assert.equal(recommendFor(SWE_11490).recommendedMode, RecommendedCapsuleMode.Full);
  assert.match(recommendFor(SWE_11740).retrievalReason, /complex internals|cross-module/);
  assert.match(recommendFor(SWE_11728).retrievalReason, /Navigation-heavy/);
});

test("the small/local fixtures recommend micro", () => {
  for (const fixture of LOCAL_FIXTURES) {
    const rec = recommendFor(fixture);
    assert.equal(
      rec.recommendedMode,
      RecommendedCapsuleMode.Micro,
      `${fixture.instanceId} should be micro, got ${rec.recommendedMode}`,
    );
  }
});

test("a local fixture carries a micro rationale", () => {
  const rec = recommendFor(SWE_10880);
  assert.equal(rec.recommendedMode, RecommendedCapsuleMode.Micro);
  assert.match(rec.retrievalReason, /Small\/local/);
});

test("explicit single-file target with one test is micro", () => {
  const rec = recommendFor(SWE_11095);
  assert.equal(rec.recommendedMode, RecommendedCapsuleMode.Micro);
});

test("11095 stays micro despite a long hints body with a PR URL (regression)", () => {
  // The full fixture carries a ~900-char hints body quoting a PR URL: the exact
  // conditions that previously mis-sized it to `standard`. The URL tail must not
  // appear as a likely file, and the small problem statement keeps it micro.
  const shaped = shapeSweQuery(SWE_11095);
  assert.ok(!shaped.likelyFiles.some((file) => file.includes("pull/7920")));
  assert.ok(shaped.likelyFiles.includes("django/contrib/admin/options.py"));

  const signals = deriveModeSignals(SWE_11095, shaped);
  assert.ok(signals.problemLength > 600, "combined length should exceed the micro threshold");
  assert.ok(signals.problemStatementLength < 600, "problem statement alone stays short");
  assert.equal(recommendCapsuleMode(signals).recommendedMode, RecommendedCapsuleMode.Micro);
});

test("complex internals alone force full even with one file", () => {
  const signals: ModeRecommendationSignals = {
    failingTestCount: 1,
    problemLength: 300,
    problemStatementLength: 300,
    likelyFileCount: 1,
    likelySymbolCount: 1,
    touchesComplexInternals: true,
    crossModule: false,
    hasExplicitTargets: true,
  };
  assert.equal(recommendCapsuleMode(signals).recommendedMode, RecommendedCapsuleMode.Full);
});

test("a long hints body alone does not push a small/local task out of micro", () => {
  // Mirrors django__django-11095: a 380-char problem statement with a 740-char
  // hints body. The combined length (1124) and a long-hints body must NOT escalate
  // it — the small problem + single test + explicit target keep it micro.
  const rec = recommendCapsuleMode({
    failingTestCount: 1,
    problemLength: 1124,
    problemStatementLength: 380,
    likelyFileCount: 0,
    likelySymbolCount: 3,
    touchesComplexInternals: false,
    crossModule: false,
    hasExplicitTargets: true,
  });
  assert.equal(rec.recommendedMode, RecommendedCapsuleMode.Micro);
});

test("empty/unknown signal recommends skip with low confidence", () => {
  const rec = recommendCapsuleMode({
    failingTestCount: 0,
    problemLength: 40,
    problemStatementLength: 40,
    likelyFileCount: 0,
    likelySymbolCount: 0,
    touchesComplexInternals: false,
    crossModule: false,
    hasExplicitTargets: false,
  });
  assert.equal(rec.recommendedMode, RecommendedCapsuleMode.Skip);
  assert.equal(rec.targetConfidence, TargetConfidence.Low);
});

test("moderate task with no extreme signal falls back to standard", () => {
  const rec = recommendCapsuleMode({
    failingTestCount: 2,
    problemLength: 800,
    problemStatementLength: 800,
    likelyFileCount: 0,
    likelySymbolCount: 0,
    touchesComplexInternals: false,
    crossModule: false,
    hasExplicitTargets: false,
  });
  assert.equal(rec.recommendedMode, RecommendedCapsuleMode.Standard);
});

test("confidence is high when concrete targets and a failing test exist", () => {
  assert.equal(recommendFor(SWE_11490).targetConfidence, TargetConfidence.High);
});
