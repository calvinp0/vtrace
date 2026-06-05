// Intent detection + intent-aware retrieval weighting for capsule v2.
//
// Intent is the first stage of the pipeline: it both labels the task and steers
// the candidate scorers. Detection is deterministic and explainable — a small
// ordered set of signal rules over the task prose and the shaped query, never an
// opaque classifier. `auto` resolves to exactly one concrete intent and reports
// WHY; an explicit intent is honoured verbatim.
//
// Each intent maps to a weight vector over the hybrid score components. The
// overrides are deliberately conservative: they nudge which precision signal
// leads (a failing test points straight at the impl; a refactor leans on
// symbol/path identity; an impact query leans on graph reach) WITHOUT ever
// letting `centrality` overtake direct local evidence — it stays the smallest
// weight under every intent, so a generic hub can never win on reach alone.

import type { ShapedSweQuery } from "../capsule/sweQueryShaping";
import {
  HYBRID_SCORE_WEIGHTS,
  type HybridScoreWeights,
} from "../retrieval/hybridScoring";
import {
  CapsuleIntent,
  type ResolvedCapsuleIntent,
} from "./types";

export interface IntentDecision {
  intent: ResolvedCapsuleIntent;
  /** Human-readable justification — the diagnostics' `intent_reason`. */
  reason: string;
}

// Phrase signals per intent, checked in priority order. Test-failure wins first
// because a named failing test is the single most decisive routing signal.
const REFACTOR_SIGNALS =
  /\b(refactor|rename|extract|move|inline|deduplicat|clean up|cleanup|simplif|restructure|consolidat)\w*/i;
const IMPACT_SIGNALS =
  /\b(impact|blast radius|what breaks|breaks if|affected|dependents|depend on|ripple|callers of|who calls)\b/i;
const DEBUG_SIGNALS =
  /\b(bug|fix|broken|crash|traceback|exception|stack trace|regression|incorrect|wrong|fails?|failing|error|does not|doesn't|should not|unexpected)\b/i;

/**
 * Resolve the effective intent. An explicit intent is returned as-is; `auto`
 * is resolved from the task signals in priority order:
 *   1. a named failing test  -> test-failure
 *   2. refactor vocabulary    -> refactor
 *   3. impact/blast-radius     -> impact
 *   4. debug/error vocabulary  -> debug
 *   5. default                 -> debug (the most common coding-agent task)
 */
export function resolveIntent(
  requested: CapsuleIntent,
  task: string,
  shaped: ShapedSweQuery,
): IntentDecision {
  if (requested !== CapsuleIntent.Auto) {
    return { intent: requested, reason: `intent set explicitly to ${requested}` };
  }

  if (shaped.failingTests.length > 0) {
    return {
      intent: CapsuleIntent.TestFailure,
      reason: `auto -> test-failure: task names ${shaped.failingTests.length} failing test(s)`,
    };
  }
  if (REFACTOR_SIGNALS.test(task)) {
    return { intent: CapsuleIntent.Refactor, reason: "auto -> refactor: task mentions a refactor/rename/extract" };
  }
  if (IMPACT_SIGNALS.test(task)) {
    return { intent: CapsuleIntent.Impact, reason: "auto -> impact: task asks what is affected / what breaks" };
  }
  if (DEBUG_SIGNALS.test(task)) {
    return { intent: CapsuleIntent.Debug, reason: "auto -> debug: task mentions a bug/error/incorrect behaviour" };
  }
  return { intent: CapsuleIntent.Debug, reason: "auto -> debug: default (no stronger signal found)" };
}

// Centrality is held at the base (smallest) weight under EVERY intent so it can
// never overtake direct evidence — even `impact`, which leans hardest on the
// graph, raises `graph` (proximity to the working set) rather than `centrality`
// (global in-degree). This encodes "centrality cannot win alone" at the policy
// layer, complementing the hub-penalty that enforces it at the scoring layer.
const INTENT_WEIGHT_OVERRIDES: Record<ResolvedCapsuleIntent, Partial<HybridScoreWeights>> = {
  [CapsuleIntent.TestFailure]: { testToImpl: 1.6, symbol: 1.3 },
  [CapsuleIntent.Debug]: { lexical: 1.1, testToImpl: 1.4 },
  [CapsuleIntent.Refactor]: { symbol: 1.4, path: 1.0 },
  [CapsuleIntent.Impact]: { graph: 1.3, centrality: 0.6 },
};

/** The retrieval weights for a resolved intent (base defaults + overrides). */
export function weightsForIntent(intent: ResolvedCapsuleIntent): HybridScoreWeights {
  return { ...HYBRID_SCORE_WEIGHTS, ...INTENT_WEIGHT_OVERRIDES[intent] };
}
