// Shared, normalized intent vocabulary — the single decision model every major
// context consumer agrees on.
//
// VTRACE historically grew THREE parallel intent vocabularies:
//   - `QueryIntent`            (src/intent/types.ts)        debug|refactor|explain|feature
//   - `RunPipelinePresetIntent`(src/runPipeline/types.ts)   auto|explore|debug|modify|refactor
//   - `CapsuleIntent`          (src/capsuleV2/types.ts)     auto|debug|refactor|modify|explain|impact|test-failure
//
// They drifted: run_pipeline could skip its impact section as "not refactor-like"
// while Capsule v2 — handed an explicit `impact` intent — simultaneously built a
// blast-radius capsule. This module is the BRIDGE: one normalized intent the
// run_pipeline orchestrator, get_code_context, get_context_capsule, Capsule v2,
// and the Stage 5 harness all map into, so `debug / modify / refactor / impact /
// explain / test-failure` mean the same thing everywhere. It deliberately does
// NOT introduce a fourth resolver — the existing `selectRunPipelineIntent`
// (preset/retrieval routing) and `planIntent` (Capsule v2 strategy) keep their
// jobs; this layer reconciles their outputs into a shared decision and drives the
// one behaviour that previously relied on fragile phrase matching: impact
// section eligibility.

import { CapsuleIntent, type ResolvedCapsuleIntent } from "../capsuleV2/types";
import { QueryIntent } from "./types";

/**
 * The canonical normalized intent. Mirrors the concrete (resolved) Capsule v2
 * intents — the richest of the three vocabularies — using the underscore
 * spelling (`test_failure`) the product surface exposes.
 */
export type NormalizedIntent =
  | "debug"
  | "modify"
  | "refactor"
  | "impact"
  | "explain"
  | "test_failure";

export const NormalizedIntent = Object.freeze({
  Debug: "debug",
  Modify: "modify",
  Refactor: "refactor",
  Impact: "impact",
  Explain: "explain",
  TestFailure: "test_failure",
}) satisfies Record<string, NormalizedIntent>;

/** How the normalized intent was decided, in precedence order. */
export type NormalizedIntentSource = "explicit" | "phrase" | "classifier" | "default";

export const NormalizedIntentSource = Object.freeze({
  Explicit: "explicit",
  Phrase: "phrase",
  Classifier: "classifier",
  Default: "default",
}) satisfies Record<string, NormalizedIntentSource>;

/** Intent-level reason the impact section was not requested by the resolved intent. */
export const NormalizedImpactSkipReason = "not_requested_by_intent" as const;
export type NormalizedImpactSkipReason = typeof NormalizedImpactSkipReason;

/** Intent-level reason the flow section is not eligible for the query shape. */
export const NormalizedFlowSkipReason = "unsupported_query_shape" as const;
export type NormalizedFlowSkipReason = typeof NormalizedFlowSkipReason;

/**
 * The unified intent decision every consumer can read. `impactEligible` /
 * `flowEligible` answer "did the intent (and query shape) ASK for this section";
 * the section itself may still skip for a concrete reason (no focal symbol,
 * multiple focal symbols, missing endpoints) recorded separately on that section.
 */
export interface NormalizedIntentDecision {
  /** The raw intent the caller requested (a preset, a capsule intent, or "auto"). */
  readonly requestedIntent: string;
  /** The resolved normalized intent. */
  readonly resolvedIntent: NormalizedIntent;
  /** How `resolvedIntent` was decided. */
  readonly intentSource: NormalizedIntentSource;
  /** Whether the resolved intent makes the impact section eligible to run. */
  readonly impactEligible: boolean;
  /** Set when impact is ineligible purely because the intent did not request it. */
  readonly impactSkipReason: NormalizedImpactSkipReason | null;
  /** Whether the query shape makes the flow section eligible to run. */
  readonly flowEligible: boolean;
  /** Set when flow is ineligible because the query shape does not support it. */
  readonly flowSkipReason: NormalizedFlowSkipReason | null;
  /** Human-readable justification for the decision. */
  readonly rationale: string;
}

/**
 * Impact eligibility is INTENT-DRIVEN: a refactor or impact/blast-radius intent
 * makes the impact section eligible, full stop — no magic wording required. Debug
 * and modify deliberately do NOT pull impact by default (it is expensive noise for
 * an edit-site task) unless the query explicitly asks what is affected, which the
 * orchestrator handles as a narrow opt-in.
 */
export function impactEligibleForIntent(intent: NormalizedIntent): boolean {
  return intent === NormalizedIntent.Refactor || intent === NormalizedIntent.Impact;
}

/** Map a resolved Capsule v2 intent to the normalized vocabulary. */
export function capsuleIntentToNormalized(intent: ResolvedCapsuleIntent): NormalizedIntent {
  switch (intent) {
    case CapsuleIntent.Debug:
      return NormalizedIntent.Debug;
    case CapsuleIntent.Modify:
      return NormalizedIntent.Modify;
    case CapsuleIntent.Refactor:
      return NormalizedIntent.Refactor;
    case CapsuleIntent.Impact:
      return NormalizedIntent.Impact;
    case CapsuleIntent.Explain:
      return NormalizedIntent.Explain;
    case CapsuleIntent.TestFailure:
      return NormalizedIntent.TestFailure;
  }
}

/** Map a normalized intent back to its concrete Capsule v2 intent. */
export function normalizedToCapsuleIntent(intent: NormalizedIntent): ResolvedCapsuleIntent {
  switch (intent) {
    case NormalizedIntent.Debug:
      return CapsuleIntent.Debug;
    case NormalizedIntent.Modify:
      return CapsuleIntent.Modify;
    case NormalizedIntent.Refactor:
      return CapsuleIntent.Refactor;
    case NormalizedIntent.Impact:
      return CapsuleIntent.Impact;
    case NormalizedIntent.Explain:
      return CapsuleIntent.Explain;
    case NormalizedIntent.TestFailure:
      return CapsuleIntent.TestFailure;
  }
}

/** Map the legacy `QueryIntent` (run_pipeline retrieval vocabulary) to normalized. */
export function queryIntentToNormalized(intent: QueryIntent): NormalizedIntent {
  switch (intent) {
    case QueryIntent.Debug:
      return NormalizedIntent.Debug;
    case QueryIntent.Refactor:
      return NormalizedIntent.Refactor;
    case QueryIntent.Feature:
      return NormalizedIntent.Modify;
    case QueryIntent.Explain:
      return NormalizedIntent.Explain;
  }
}

// Explicit "tell me the blast radius" language that the preset vocabulary cannot
// express (run_pipeline has no `impact` preset). Phrases that already route to the
// refactor preset upstream (`blast radius`, `what breaks`, `who calls`,
// `public api`) are intentionally NOT duplicated here — they arrive already
// impact-eligible, so this detector only has to catch the residue (`impact`,
// `impacted`, `ripple`, `dependents`) that would otherwise fall through to a
// non-eligible intent. `dependents`/`depend on` preserve the legacy
// dependents-keyword impact trigger, now expressed as impact intent. Identifier-
// aware boundaries keep a snake_case symbol like `impact_graph` from masquerading
// as the English noun.
const EXPLICIT_IMPACT_INTENT_PATTERN =
  /\b(impact|impacts|impacted|impacting|ripple|ripples|rippling|dependent|dependents|depend on)\b/i;

/**
 * Whether the query carries explicit impact/blast-radius intent that the preset
 * vocabulary could not capture. Used to upgrade an otherwise non-eligible intent
 * to `impact` so an explicit "what is the impact of …" request ungates the impact
 * section without relying on the refactor preset.
 */
export function hasExplicitImpactIntentPhrase(query: string): boolean {
  return EXPLICIT_IMPACT_INTENT_PATTERN.test(query);
}
