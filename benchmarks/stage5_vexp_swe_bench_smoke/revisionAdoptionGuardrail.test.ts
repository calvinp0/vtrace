// M18 — tests for the shadow-eval-based replacement/adoption guardrail.
//
// M17.1 proved compliance improvement is NOT a safe adoption signal: sphinx r1 and r2
// both improved compliance yet only r2's revised patch resolved in a shadow Docker eval.
// `decideRevisionAdoption` therefore gates `replacementRecommended` on a verification
// outcome (shadow eval), never on compliance improvement alone. These tests pin that.

import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  decideRevisionAdoption,
  classifyShadowEval,
  type ShadowClassification,
} from "./revisedPatchShadowEval";

// Build a shadow input from resolution booleans, going through the real classifier so the
// test exercises the same classification path the orchestrator uses.
function shadowFrom(originalResolved: boolean, revisedResolved: boolean) {
  const classification = classifyShadowEval({
    ran: true,
    evaluationError: null,
    originalResolved,
    revisedResolved,
  });
  return { classification, originalResolved, revisedResolved };
}

// 1. Compliance improvement WITHOUT a shadow eval cannot recommend replacement.
test("compliance improvement without shadow eval does not recommend replacement", () => {
  const d = decideRevisionAdoption({ complianceImproved: true, shadow: null });
  assert.equal(d.revisionCandidate, true); // it is a candidate
  assert.equal(d.replacementRecommended, false); // but NOT adoptable
  assert.equal(d.replacementReason, "no_shadow_eval");
  assert.equal(d.replacementEvidence.kind, "not_verified");
});

// 2. original unresolved + revised resolved => recommend.
test("original unresolved + revised resolved recommends replacement", () => {
  const d = decideRevisionAdoption({ complianceImproved: true, shadow: shadowFrom(false, true) });
  assert.equal(d.replacementRecommended, true);
  assert.equal(d.replacementReason, "shadow_resolution_success");
  assert.equal(d.replacementEvidence.kind, "shadow_eval");
  assert.equal(d.replacementEvidence.originalResolved, false);
  assert.equal(d.replacementEvidence.revisedResolved, true);
});

// 3. original unresolved + revised unresolved => reject.
test("original unresolved + revised unresolved rejects replacement", () => {
  const d = decideRevisionAdoption({ complianceImproved: true, shadow: shadowFrom(false, false) });
  assert.equal(d.replacementRecommended, false);
  assert.equal(d.replacementReason, "shadow_no_effect");
});

// 4. original resolved + revised unresolved => reject (harm).
test("original resolved + revised unresolved rejects replacement", () => {
  const d = decideRevisionAdoption({ complianceImproved: true, shadow: shadowFrom(true, false) });
  assert.equal(d.replacementRecommended, false);
  assert.equal(d.replacementReason, "shadow_harm");
});

// 5. empty/identical revised patch (skip) => reject.
test("empty/identical revised patch rejects replacement", () => {
  const skip: ShadowClassification = "shadow_skipped_empty_or_identical";
  const d = decideRevisionAdoption({ complianceImproved: false, shadow: { classification: skip } });
  assert.equal(d.replacementRecommended, false);
  assert.equal(d.replacementReason, "shadow_skipped_empty_or_identical");
  assert.equal(d.replacementEvidence.kind, "skipped_empty_or_identical");
});

// 6. canonicalReplaced is ALWAYS false here — this function only recommends.
test("canonicalReplaced remains false in read-only shadow-eval mode", () => {
  for (const shadow of [null, shadowFrom(false, true), shadowFrom(true, true)]) {
    const d = decideRevisionAdoption({ complianceImproved: true, shadow });
    assert.equal(d.canonicalReplaced, false);
  }
});

// 7. The three concepts are SEPARATE fields and not conflated.
test("field names distinguish candidate / recommended / replaced", () => {
  const d = decideRevisionAdoption({ complianceImproved: true, shadow: shadowFrom(false, true) });
  assert.deepEqual(
    Object.keys(d).sort(),
    ["canonicalReplaced", "replacementEvidence", "replacementReason", "replacementRecommended", "revisionCandidate"],
  );
  // candidate (compliance) is distinct from recommended (verification) is distinct from replaced (action).
  assert.equal(d.revisionCandidate, true);
  assert.equal(d.replacementRecommended, true);
  assert.equal(d.canonicalReplaced, false);
});

// 8. sphinx r1-shaped: compliance improved, shadow no_effect => candidate but rejected.
test("sphinx r1-shaped case (compliance improved, shadow no_effect) is rejected", () => {
  const d = decideRevisionAdoption({ complianceImproved: true, shadow: shadowFrom(false, false) });
  assert.equal(d.revisionCandidate, true);
  assert.equal(d.replacementRecommended, false);
  assert.equal(d.replacementReason, "shadow_no_effect");
  assert.equal(d.canonicalReplaced, false);
});

// 9. sphinx r2-shaped: compliance improved, shadow resolution_success => recommended.
test("sphinx r2-shaped case (compliance improved, shadow resolution_success) is recommended", () => {
  const d = decideRevisionAdoption({ complianceImproved: true, shadow: shadowFrom(false, true) });
  assert.equal(d.revisionCandidate, true);
  assert.equal(d.replacementRecommended, true);
  assert.equal(d.replacementReason, "shadow_resolution_success");
  assert.equal(d.canonicalReplaced, false);
});

// 10. seaborn-shaped: identical revision (skipped), no compliance improvement => rejected.
test("seaborn identical-revision case is rejected and not even a candidate", () => {
  const skip: ShadowClassification = "shadow_skipped_empty_or_identical";
  const d = decideRevisionAdoption({ complianceImproved: false, shadow: { classification: skip } });
  assert.equal(d.revisionCandidate, false);
  assert.equal(d.replacementRecommended, false);
  assert.equal(d.replacementReason, "shadow_skipped_empty_or_identical");
});

// Extra: preserves-resolution recommends, but over-edit downgrades it (rule from spec).
test("shadow_preserves_resolution recommends unless over-edited", () => {
  const ok = decideRevisionAdoption({ complianceImproved: true, shadow: shadowFrom(true, true) });
  assert.equal(ok.replacementRecommended, true);
  assert.equal(ok.replacementReason, "shadow_preserves_resolution");

  const over = decideRevisionAdoption({ complianceImproved: true, shadow: shadowFrom(true, true), overEdited: true });
  assert.equal(over.replacementRecommended, false);
  assert.equal(over.replacementReason, "shadow_preserves_resolution_over_edit");
});

// Extra: inconclusive shadow eval is not verified => reject.
test("shadow_inconclusive rejects replacement as not verified", () => {
  const d = decideRevisionAdoption({
    complianceImproved: true,
    shadow: { classification: "shadow_inconclusive" satisfies ShadowClassification },
  });
  assert.equal(d.replacementRecommended, false);
  assert.equal(d.replacementReason, "shadow_inconclusive");
  assert.equal(d.replacementEvidence.kind, "not_verified");
});
