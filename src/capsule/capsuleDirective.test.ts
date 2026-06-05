// Capsule directive tests.
//
// Covers the three pieces that make a capsule decisive (Requirements 1/2/4/5):
//   * deriveEditIntentHint — pattern-based "what to look for" cue;
//   * classifySearchBudget — how hard to search before trusting the capsule;
//   * composeCapsuleDirective + the five Django fixtures — the end-to-end action
//     header (open/edit <pivot> first) the agent actually sees.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { renderCompactCapsule } from "./capsuleDiagnostics";
import {
  classifySearchBudget,
  composeCapsuleDirective,
  deriveEditIntentHint,
} from "./capsuleDirective";
import { recoverMicroCapsule } from "./microTargets";
import { deriveModeSignals, recommendCapsuleMode, RecommendedCapsuleMode, TargetConfidence } from "./recommendMode";
import { shapeSweQuery, type ShapedSweQuery } from "./sweQueryShaping";
import {
  seedStage5DjangoFixture,
  STAGE5_SCENARIOS,
  type Stage5Scenario,
} from "./__fixtures__/stage5DjangoFixture";

// ---- deriveEditIntentHint (Requirement 4) ----

test("deriveEditIntentHint maps subsystem vocabulary to a generic action cue", () => {
  const hint = (text: string): string | undefined =>
    deriveEditIntentHint({ query: text, failingTests: [], likelyFiles: [], likelySymbols: [], identifiers: [] });

  assert.match(hint("add a ModelAdmin.get_inlines() hook") ?? "", /inline selection methods/);
  assert.match(hint("Count annotation with distinct=True produces wrong SQL") ?? "", /aggregate SQL rendering/);
  assert.match(hint("replace_named_groups does not handle trailing named groups") ?? "", /regex group replacement/);
  assert.match(hint("the migrations autodetector misses a dependency") ?? "", /dependency generation/);
  assert.match(hint("composed queries cannot change selected columns with values()") ?? "", /combined-query column propagation/);
});

test("deriveEditIntentHint falls back to the pivot symbol when no rule matches", () => {
  const shaped: ShapedSweQuery = {
    query: "something entirely unrelated to known subsystems",
    failingTests: [],
    likelyFiles: [],
    likelySymbols: [],
    identifiers: [],
  };
  assert.equal(deriveEditIntentHint(shaped), undefined);
  assert.match(deriveEditIntentHint(shaped, "doStuff") ?? "", /inspect `doStuff` and the methods it calls/);
});

// ---- classifySearchBudget (Requirement 5) ----

test("classifySearchBudget is low only for a high-confidence pivot with direct evidence", () => {
  assert.equal(
    classifySearchBudget({ hasPivot: true, ambiguous: false, confidence: TargetConfidence.High, directEvidence: true }).budget,
    "low",
  );
  // High confidence but only graph/domain reach → moderate, not low.
  assert.equal(
    classifySearchBudget({ hasPivot: true, ambiguous: false, confidence: TargetConfidence.High, directEvidence: false }).budget,
    "moderate",
  );
  // Medium confidence → moderate even with direct evidence.
  assert.equal(
    classifySearchBudget({ hasPivot: true, ambiguous: false, confidence: TargetConfidence.Medium, directEvidence: true }).budget,
    "moderate",
  );
  // No pivot, or ambiguous → high.
  assert.equal(
    classifySearchBudget({ hasPivot: false, ambiguous: false, confidence: TargetConfidence.Low, directEvidence: false }).budget,
    "high",
  );
  assert.equal(
    classifySearchBudget({ hasPivot: true, ambiguous: true, confidence: TargetConfidence.High, directEvidence: true }).budget,
    "high",
  );
});

// ---- composeCapsuleDirective (Requirements 1/2) ----

test("composeCapsuleDirective downgrades an ambiguous, non-high-confidence pick to standard", () => {
  const shaped: ShapedSweQuery = { query: "x", failingTests: [], likelyFiles: [], likelySymbols: [], identifiers: [] };
  const ambiguousMedium = composeCapsuleDirective({
    shaped,
    pivot: { filePath: "a.py", localName: "foo", evidence: ["symbol-name match"], directEvidence: true },
    confidence: TargetConfidence.Medium,
    ambiguous: true,
  });
  assert.equal(ambiguousMedium.recommendedModeOverride, RecommendedCapsuleMode.Standard);

  // Ambiguous but already high confidence → no override (trust the lead), but the
  // search budget still reflects the ambiguity.
  const ambiguousHigh = composeCapsuleDirective({
    shaped,
    pivot: { filePath: "a.py", localName: "foo", evidence: ["symbol-name match"], directEvidence: true },
    confidence: TargetConfidence.High,
    ambiguous: true,
  });
  assert.equal(ambiguousHigh.recommendedModeOverride, undefined);
  assert.equal(ambiguousHigh.searchBudget, "high");
});

test("composeCapsuleDirective emits a no-target header when no pivot was recovered", () => {
  const directive = composeCapsuleDirective({
    shaped: { query: "x", failingTests: [], likelyFiles: [], likelySymbols: [], identifiers: [] },
    confidence: TargetConfidence.Low,
    ambiguous: false,
  });
  assert.equal(directive.actionHeader.has_target, false);
  assert.equal(directive.actionHeader.pivot_file, null);
  assert.equal(directive.searchBudget, "high");
});

// ---- Fixture-driven end-to-end (Requirements 1/2/7) ----

// Mirror the capsule command's micro directive composition on the seeded index.
function microDirectiveFor(scenario: Stage5Scenario) {
  const db = openIndexerDatabase();
  try {
    seedStage5DjangoFixture(db);
    const shaped = shapeSweQuery(scenario.record);
    const recovery = recoverMicroCapsule(db, shaped, { maxTargets: 1, poolSize: 12 });
    const recommendation = recommendCapsuleMode(deriveModeSignals(scenario.record, shaped));
    const lead = recovery.pivots[0];
    const directive = composeCapsuleDirective({
      shaped,
      ...(lead !== undefined
        ? {
            pivot: {
              filePath: lead.filePath,
              localName: lead.localName,
              evidence: lead.evidence,
              directEvidence: lead.scores.testToImpl > 0 || lead.scores.symbol > 0 || lead.scores.path > 0,
            },
          }
        : {}),
      confidence: recommendation.targetConfidence,
      ambiguous: recovery.ambiguous,
    });
    return { recovery, directive };
  } finally {
    db.close();
  }
}

test("micro recovery yields at most one primary edit target for every scenario", () => {
  for (const scenario of STAGE5_SCENARIOS) {
    const { recovery } = microDirectiveFor(scenario);
    assert.ok(recovery.pivots.length <= 1, `${scenario.instanceId}: expected ≤1 pivot, got ${recovery.pivots.length}`);
  }
});

test("11095: the action header says to open/edit admin/options.py first", () => {
  const scenario = STAGE5_SCENARIOS.find((s) => s.instanceId === "django__django-11095")!;
  const { directive } = microDirectiveFor(scenario);

  assert.equal(directive.actionHeader.has_target, true);
  assert.equal(directive.actionHeader.pivot_file, "django/contrib/admin/options.py");
  assert.equal(directive.actionHeader.pivot_symbol, "get_inline_instances");
  // It is a high-confidence pivot reached by a direct (failing-test/symbol) route.
  assert.equal(directive.searchBudget, "low");

  const rendered = renderCompactCapsule(
    { query: "x", pivots: [], supportingItems: [], budget: { maxCharacters: 0, usedCharacters: 0, remainingCharacters: 0 }, truncated: false, compressed: false },
    { maxChars: 4_000, actionHeader: directive.actionHeader, searchBudget: directive.searchBudget },
  );
  assert.match(
    rendered.text,
    /Open\/edit `django\/contrib\/admin\/options\.py::get_inline_instances` first\./,
  );
});

test("10880: when a pivot is recovered the action header points at aggregates.py", () => {
  const scenario = STAGE5_SCENARIOS.find((s) => s.instanceId === "django__django-10880")!;
  const { recovery, directive } = microDirectiveFor(scenario);

  // 10880 is pivot-or-skip: IF a pivot is recovered it must be aggregates.py, and
  // the action header must point at it (never at the sql/subqueries distractor).
  if (recovery.pivots.length > 0) {
    assert.equal(directive.actionHeader.pivot_file, "django/db/models/aggregates.py");
    assert.equal(directive.actionHeader.has_target, true);
  } else {
    assert.equal(directive.actionHeader.has_target, false);
  }
});
