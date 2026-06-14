// run_pipeline's reconciler: collapse the preset decision, an optional explicit
// Capsule v2 intent, and explicit impact phrasing into ONE shared
// `NormalizedIntentDecision`. This is the bridge between `src/intent`
// (preset/retrieval routing) and `src/capsuleV2` (strategy) — it is what makes
// run_pipeline and Capsule v2 agree about debug/modify/refactor/impact behaviour
// and what drives impact-section eligibility from intent rather than magic words.

import { CapsuleIntent, type ResolvedCapsuleIntent } from "../capsuleV2/types";
import {
  NormalizedImpactSkipReason,
  NormalizedIntent,
  NormalizedIntentSource,
  NormalizedFlowSkipReason,
  capsuleIntentToNormalized,
  hasExplicitImpactIntentPhrase,
  impactEligibleForIntent,
  queryIntentToNormalized,
  type NormalizedIntentDecision,
} from "../intent/normalizedIntent";
import { RunPipelineIntentSource, type RunPipelineIntentDecision } from "./types";

function presetSourceToNormalizedSource(
  source: RunPipelineIntentDecision["source"],
): NormalizedIntentSource {
  switch (source) {
    case RunPipelineIntentSource.Explicit:
      return NormalizedIntentSource.Explicit;
    case RunPipelineIntentSource.AutoPhraseTrigger:
      return NormalizedIntentSource.Phrase;
    case RunPipelineIntentSource.AutoClassifier:
      return NormalizedIntentSource.Classifier;
    case RunPipelineIntentSource.AutoDefault:
    default:
      return NormalizedIntentSource.Default;
  }
}

export interface ResolveNormalizedIntentInput {
  /** The preset decision produced by `selectRunPipelineIntent`. */
  readonly presetDecision: RunPipelineIntentDecision;
  /**
   * An explicit Capsule v2 intent supplied by the caller (run_pipeline's
   * `capsule_intent`). `Auto`/undefined means "let the preset/query decide".
   */
  readonly capsuleIntentRequested?: CapsuleIntent;
  readonly query: string;
  /** Whether the query shape supports a logic-flow trace (endpoint inference). */
  readonly flowSupported: boolean;
}

/**
 * Resolve the unified intent. Precedence:
 *   1. An explicit (non-auto) Capsule v2 intent is honoured verbatim — so
 *      `capsule_intent=impact` ungates run_pipeline's impact section exactly as it
 *      drives the v2 strategy, instead of the two diverging.
 *   2. Otherwise the preset decision's intent is used (explore→explain,
 *      debug→debug, modify→modify, refactor→refactor), carrying its source.
 *   3. If that intent is not already impact-eligible but the query carries
 *      explicit impact/blast-radius phrasing, it is upgraded to `impact`. Refactor
 *      and impact intents are already eligible, so this never downgrades them.
 */
export function resolveNormalizedIntent(
  input: ResolveNormalizedIntentInput,
): NormalizedIntentDecision {
  const { presetDecision, capsuleIntentRequested, query, flowSupported } = input;

  let resolvedIntent: NormalizedIntent;
  let intentSource: NormalizedIntentSource;
  let requestedIntent: string;
  let rationale: string;

  if (
    capsuleIntentRequested !== undefined
    && capsuleIntentRequested !== CapsuleIntent.Auto
  ) {
    resolvedIntent = capsuleIntentToNormalized(capsuleIntentRequested as ResolvedCapsuleIntent);
    intentSource = NormalizedIntentSource.Explicit;
    requestedIntent = capsuleIntentRequested;
    rationale = `Explicit capsule intent '${capsuleIntentRequested}' -> normalized '${resolvedIntent}'.`;
  } else {
    resolvedIntent = queryIntentToNormalized(presetDecision.mappedQueryIntent);
    intentSource = presetSourceToNormalizedSource(presetDecision.source);
    requestedIntent = presetDecision.requested;
    rationale = `Preset '${presetDecision.selected}' -> normalized '${resolvedIntent}' (${intentSource}).`;

    // Upgrade to impact ONLY when the preset-derived intent did not already pull
    // impact. Refactor (and any explicit impact) is already eligible, so a query
    // like "what breaks if we refactor X" stays refactor; "what is the impact of
    // changing X" — which the preset vocabulary cannot express — becomes impact.
    if (!impactEligibleForIntent(resolvedIntent) && hasExplicitImpactIntentPhrase(query)) {
      resolvedIntent = NormalizedIntent.Impact;
      intentSource = NormalizedIntentSource.Phrase;
      rationale = `Explicit impact phrasing upgraded '${queryIntentToNormalized(presetDecision.mappedQueryIntent)}' to impact.`;
    }
  }

  const impactEligible = impactEligibleForIntent(resolvedIntent);

  return {
    requestedIntent,
    resolvedIntent,
    intentSource,
    impactEligible,
    impactSkipReason: impactEligible ? null : NormalizedImpactSkipReason,
    flowEligible: flowSupported,
    flowSkipReason: flowSupported ? null : NormalizedFlowSkipReason,
    rationale,
  };
}
