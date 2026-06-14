// Tests for the shared normalized intent model and the run_pipeline bridge that
// reconciles the preset decision, an explicit Capsule v2 intent, and explicit
// impact phrasing into one decision. These pin the unification contract: every
// surface (run_pipeline, Capsule v2) maps into the SAME vocabulary, and impact
// eligibility is intent-driven, not phrase-hack-driven.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { shapeSweQuery } from "../capsule/sweQueryShaping";
import { planIntent } from "../capsuleV2/intent";
import { CapsuleIntent } from "../capsuleV2/types";
import { defaultIntentClassifier } from "./classifier";
import {
  NormalizedIntent,
  NormalizedIntentSource,
  capsuleIntentToNormalized,
  hasExplicitImpactIntentPhrase,
  impactEligibleForIntent,
  normalizedToCapsuleIntent,
  queryIntentToNormalized,
} from "./normalizedIntent";
import { QueryIntent } from "./types";
import { resolveNormalizedIntent } from "../runPipeline/resolveNormalizedIntent";
import { selectRunPipelineIntent } from "../runPipeline/selectIntent";
import { RunPipelinePresetIntent } from "../runPipeline/types";

function presetDecision(query: string, requested: RunPipelinePresetIntent = RunPipelinePresetIntent.Auto) {
  return selectRunPipelineIntent({
    requested,
    classification: defaultIntentClassifier.classify(query),
    query,
  });
}

function resolveFor(
  query: string,
  opts: { requested?: RunPipelinePresetIntent; capsuleIntent?: CapsuleIntent; flowSupported?: boolean } = {},
) {
  return resolveNormalizedIntent({
    presetDecision: presetDecision(query, opts.requested ?? RunPipelinePresetIntent.Auto),
    capsuleIntentRequested: opts.capsuleIntent,
    query,
    flowSupported: opts.flowSupported ?? true,
  });
}

// --- shared model: eligibility + bridge maps -------------------------------

test("impact is eligible only for refactor and impact intents", () => {
  assert.equal(impactEligibleForIntent(NormalizedIntent.Refactor), true);
  assert.equal(impactEligibleForIntent(NormalizedIntent.Impact), true);
  assert.equal(impactEligibleForIntent(NormalizedIntent.Debug), false);
  assert.equal(impactEligibleForIntent(NormalizedIntent.Modify), false);
  assert.equal(impactEligibleForIntent(NormalizedIntent.Explain), false);
  assert.equal(impactEligibleForIntent(NormalizedIntent.TestFailure), false);
});

test("capsule intent <-> normalized round-trips for every resolved intent", () => {
  const resolved = [
    CapsuleIntent.Debug,
    CapsuleIntent.Modify,
    CapsuleIntent.Refactor,
    CapsuleIntent.Impact,
    CapsuleIntent.Explain,
    CapsuleIntent.TestFailure,
  ] as const;
  for (const intent of resolved) {
    assert.equal(normalizedToCapsuleIntent(capsuleIntentToNormalized(intent)), intent);
  }
});

test("query intent maps to the normalized vocabulary", () => {
  assert.equal(queryIntentToNormalized(QueryIntent.Debug), NormalizedIntent.Debug);
  assert.equal(queryIntentToNormalized(QueryIntent.Refactor), NormalizedIntent.Refactor);
  assert.equal(queryIntentToNormalized(QueryIntent.Feature), NormalizedIntent.Modify);
  assert.equal(queryIntentToNormalized(QueryIntent.Explain), NormalizedIntent.Explain);
});

test("explicit impact phrasing is detected without the refactor magic words", () => {
  assert.equal(hasExplicitImpactIntentPhrase("what is the impact of changing authenticate"), true);
  assert.equal(hasExplicitImpactIntentPhrase("show the dependents of base"), true);
  assert.equal(hasExplicitImpactIntentPhrase("the ripple effect of this change"), true);
  // Identifier-aware: a snake_case symbol name is not the English noun.
  assert.equal(hasExplicitImpactIntentPhrase("call get_impact_graph"), false);
  assert.equal(hasExplicitImpactIntentPhrase("add a new dropdown"), false);
});

// --- the bridge: resolveNormalizedIntent -----------------------------------

test("explicit refactor preset resolves to refactor intent and makes impact eligible", () => {
  const decision = resolveFor("rename base everywhere", { requested: RunPipelinePresetIntent.Refactor });
  assert.equal(decision.resolvedIntent, NormalizedIntent.Refactor);
  assert.equal(decision.intentSource, NormalizedIntentSource.Explicit);
  assert.equal(decision.impactEligible, true);
  assert.equal(decision.impactSkipReason, null);
});

test("explicit capsule impact intent makes impact eligible even when the preset is debug", () => {
  // The preset auto-resolves to debug (failure phrasing), but an explicit capsule
  // intent of impact is honoured — run_pipeline and Capsule v2 no longer diverge.
  const decision = resolveFor("why does base fail", { capsuleIntent: CapsuleIntent.Impact });
  assert.equal(decision.resolvedIntent, NormalizedIntent.Impact);
  assert.equal(decision.intentSource, NormalizedIntentSource.Explicit);
  assert.equal(decision.impactEligible, true);
  assert.equal(decision.requestedIntent, "impact");
});

test("explicit impact phrasing upgrades a non-eligible intent to impact", () => {
  const decision = resolveFor("what is the impact of changing authenticate");
  assert.equal(decision.resolvedIntent, NormalizedIntent.Impact);
  assert.equal(decision.intentSource, NormalizedIntentSource.Phrase);
  assert.equal(decision.impactEligible, true);
});

test("debug intent does not force impact and records not_requested_by_intent", () => {
  const decision = resolveFor("fix the createSession bug", { requested: RunPipelinePresetIntent.Debug });
  assert.equal(decision.resolvedIntent, NormalizedIntent.Debug);
  assert.equal(decision.impactEligible, false);
  assert.equal(decision.impactSkipReason, "not_requested_by_intent");
});

test("modify intent maps consistently between run_pipeline and Capsule v2", () => {
  const fromRunPipeline = resolveFor("add support for tenants", { requested: RunPipelinePresetIntent.Modify });
  const fromCapsule = capsuleIntentToNormalized(
    planIntent(CapsuleIntent.Modify, "add support for tenants", shapeSweQuery({ problemStatement: "add support for tenants", failToPass: [] })).intent,
  );
  assert.equal(fromRunPipeline.resolvedIntent, NormalizedIntent.Modify);
  assert.equal(fromCapsule, NormalizedIntent.Modify);
  assert.equal(fromRunPipeline.resolvedIntent, fromCapsule);
});

test("flow eligibility follows query shape support", () => {
  assert.equal(resolveFor("trace from beta to base", { flowSupported: true }).flowEligible, true);
  assert.equal(resolveFor("trace from beta to base", { flowSupported: true }).flowSkipReason, null);
  const unsupported = resolveFor("base", { flowSupported: false });
  assert.equal(unsupported.flowEligible, false);
  assert.equal(unsupported.flowSkipReason, "unsupported_query_shape");
});

test("an explicit refactor phrase trigger stays refactor (not upgraded to impact)", () => {
  // "what breaks" routes to the refactor preset upstream; it is already impact-
  // eligible, so the impact-phrase upgrade must not override it.
  const decision = resolveFor("what breaks if we refactor SessionStore");
  assert.equal(decision.resolvedIntent, NormalizedIntent.Refactor);
  assert.equal(decision.impactEligible, true);
});
