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

test("complex internals alone force full even with one file", () => {
  const signals: ModeRecommendationSignals = {
    failingTestCount: 1,
    problemLength: 300,
    likelyFileCount: 1,
    likelySymbolCount: 1,
    touchesComplexInternals: true,
    crossModule: false,
    hasExplicitTargets: true,
  };
  assert.equal(recommendCapsuleMode(signals).recommendedMode, RecommendedCapsuleMode.Full);
});

test("empty/unknown signal recommends skip with low confidence", () => {
  const rec = recommendCapsuleMode({
    failingTestCount: 0,
    problemLength: 40,
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
