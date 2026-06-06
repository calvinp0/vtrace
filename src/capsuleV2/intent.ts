// Capsule v2 intent planner.
//
// Intent is the first pipeline stage: it both labels the task and selects the
// STRATEGY — which candidate generators lead, which role policy runs, and how the
// budget is spent. Detection is deterministic and explainable: a small ordered
// set of signal rules over the task prose and the shaped query, never an opaque
// classifier. `auto` resolves to exactly one concrete intent, reports WHY (an
// ordered list of matched signals) and a confidence; an explicit intent is
// honoured verbatim at high confidence.
//
// The planner is a real behavioural lever, not a printed label: each intent maps
// to a `role_policy` (e.g. `debug_refinement` vs the base gate) and a weight
// vector over the hybrid score components. The weight overrides stay
// conservative — they nudge which precision signal leads WITHOUT ever letting
// `centrality` overtake direct local evidence (it stays the smallest weight under
// every intent, so a generic hub can never win on reach alone).

import type { ShapedSweQuery } from "../capsule/sweQueryShaping";
import {
  HYBRID_SCORE_WEIGHTS,
  type HybridScoreWeights,
} from "../retrieval/hybridScoring";
import {
  CapsuleIntent,
  type IntentConfidence,
  type IntentStrategy,
  type ResolvedCapsuleIntent,
} from "./types";

export interface IntentDecision {
  intent: ResolvedCapsuleIntent;
  /** Human-readable justification — the diagnostics' `intent_reason` (joined). */
  reason: string;
}

/** The full intent plan: the detected intent, why, how sure, and the strategy. */
export interface IntentPlan {
  intent: ResolvedCapsuleIntent;
  intent_confidence: IntentConfidence;
  /** Ordered list of the signals behind the decision. */
  intent_reason: string[];
  strategy: IntentStrategy;
  weights: HybridScoreWeights;
}

// Phrase signals per intent. Each entry is a labelled rule so a match contributes
// a human-readable reason. Word boundaries are identifier-aware: `\bsimplify\b`
// deliberately does NOT match the function name `simplify_regexp` (no boundary
// between `y` and `_`), so a snake_case symbol mention never masquerades as a
// refactor verb — only the English verb "simplify" does.
interface SignalRule {
  readonly intent: ResolvedCapsuleIntent;
  readonly pattern: RegExp;
  readonly reason: string;
}

const SIGNAL_RULES: readonly SignalRule[] = [
  // impact / blast-radius
  {
    intent: CapsuleIntent.Impact,
    pattern: /\b(impact\w*|blast radius|what breaks|breaks if|affected|dependents?|depend on|ripple|callers? of|who calls)\b/i,
    reason: "impact/blast-radius language (callers, dependents, affected)",
  },
  // explain / understand
  {
    intent: CapsuleIntent.Explain,
    pattern: /\b(explain|understand|how does|how do|how is|walk through|walkthrough|what is|what are|why does|overview)\b/i,
    reason: "explanation language (explain, understand, how does)",
  },
  // refactor / rename / cleanup (identifier-aware: not snake_case symbol names)
  {
    // `inline` is deliberately omitted: as a refactor verb it is rare, but as a
    // noun ("admin inlines") it is common — letting it trigger refactor would
    // misroute inline-feature tasks. Explicit refactor verbs only.
    intent: CapsuleIntent.Refactor,
    pattern: /\b(refactor(?:s|ed|ing)?|rename(?:s|d|ing)?|restructur\w*|consolidat\w*|deduplicat\w*|extract(?:s|ed|ing)?|simplif(?:y|ies|ied|ication)|clean[- ]?up)\b/i,
    reason: "refactor language (refactor, rename, simplify, cleanup)",
  },
  // debug / bug / failing behaviour
  {
    intent: CapsuleIntent.Debug,
    pattern: /\b(bug|fix(?:es|ed|ing)?|broken|crash\w*|traceback|exception|stack trace|regression|incorrect|wrong|fails?|failing|errors?|does not|doesn't|should not|shouldn't|unexpected)\b/i,
    reason: "fix/bug language (fix, bug, error, failing, regression)",
  },
  // modify / add feature / hook
  {
    intent: CapsuleIntent.Modify,
    pattern: /\b(add(?:s|ed|ing)?|implement\w*|support(?:s|ed|ing)?|feature|hook|introduc\w*|new |enable|extend)\b/i,
    reason: "feature language (add, implement, support, hook)",
  },
];

// Priority order when several intents match. A named failing test (handled
// separately) is the single most decisive signal and wins outright. Impact and
// explain are intent-shaping questions that should not be overridden by an
// incidental verb; refactor precedes debug so "refactor the error handler" stays
// a refactor; debug precedes modify so "fix the get_inlines hook" stays debug.
const INTENT_PRIORITY: readonly ResolvedCapsuleIntent[] = [
  CapsuleIntent.Impact,
  CapsuleIntent.Explain,
  CapsuleIntent.Refactor,
  CapsuleIntent.Debug,
  CapsuleIntent.Modify,
];

/**
 * Plan the effective intent + strategy. An explicit intent is honoured at high
 * confidence; `auto` resolves from the signals:
 *   1. a named failing test -> test-failure (high confidence)
 *   2. the highest-priority intent with a matched signal (high if >=2 signals
 *      corroborate it, else medium)
 *   3. default -> debug (low confidence)
 */
export function planIntent(
  requested: CapsuleIntent,
  task: string,
  shaped: ShapedSweQuery,
): IntentPlan {
  if (requested !== CapsuleIntent.Auto) {
    const intent = requested as ResolvedCapsuleIntent;
    return makePlan(intent, "high", [`intent set explicitly to ${requested}`]);
  }

  // A named failing test is the single most decisive routing signal.
  if (shaped.failingTests.length > 0) {
    return makePlan(CapsuleIntent.TestFailure, "high", [
      `failing test(s) named: ${shaped.failingTests.length} (failing-test -> implementation routing)`,
    ]);
  }

  // Collect every matched signal, grouped by intent (in rule order so reasons are
  // stable). A signal that hits more than once still counts once per rule.
  const reasonsByIntent = new Map<ResolvedCapsuleIntent, string[]>();
  for (const rule of SIGNAL_RULES) {
    if (rule.pattern.test(task)) {
      const list = reasonsByIntent.get(rule.intent) ?? [];
      list.push(rule.reason);
      reasonsByIntent.set(rule.intent, list);
    }
  }

  for (const intent of INTENT_PRIORITY) {
    const reasons = reasonsByIntent.get(intent);
    if (reasons && reasons.length > 0) {
      // Corroboration: count distinct OTHER intents that also fired — a single
      // unambiguous signal is medium; multiple aligned cues raise confidence.
      const totalSignals = [...reasonsByIntent.values()].reduce((sum, r) => sum + r.length, 0);
      const confidence: IntentConfidence = reasons.length >= 2 || totalSignals === reasons.length ? "high" : "medium";
      const detail = [...reasons];
      const others = [...reasonsByIntent.entries()].filter(([key]) => key !== intent);
      if (others.length > 0) {
        detail.push(`other cues present (${others.map(([key]) => key).join(", ")}) — chose ${intent} by priority`);
      }
      return makePlan(intent, confidence, detail);
    }
  }

  return makePlan(CapsuleIntent.Debug, "low", ["no strong signal — defaulting to debug (most common coding task)"]);
}

/**
 * Backwards-compatible resolver: the intent + a single joined reason string.
 * Prefer `planIntent` for the full strategy + confidence.
 */
export function resolveIntent(
  requested: CapsuleIntent,
  task: string,
  shaped: ShapedSweQuery,
): IntentDecision {
  const plan = planIntent(requested, task, shaped);
  return { intent: plan.intent, reason: plan.intent_reason.join("; ") };
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
  [CapsuleIntent.Modify]: { symbol: 1.2, domain: 1.2, path: 1.0 },
  [CapsuleIntent.Explain]: { graph: 1.2, symbol: 1.1 },
  [CapsuleIntent.Impact]: { graph: 1.3, centrality: 0.6 },
};

/** The retrieval weights for a resolved intent (base defaults + overrides). */
export function weightsForIntent(intent: ResolvedCapsuleIntent): HybridScoreWeights {
  return { ...HYBRID_SCORE_WEIGHTS, ...INTENT_WEIGHT_OVERRIDES[intent] };
}

// The strategy each intent maps to. test-failure shares the debug strategy (same
// routing/role policy) but keeps its own intent label + reason. Refactor and
// impact share a caller/dependent-oriented strategy.
const INTENT_STRATEGIES: Record<ResolvedCapsuleIntent, IntentStrategy> = {
  [CapsuleIntent.Debug]: debugStrategy(),
  [CapsuleIntent.TestFailure]: debugStrategy(),
  [CapsuleIntent.Refactor]: callerStrategy(),
  [CapsuleIntent.Impact]: callerStrategy(),
  [CapsuleIntent.Modify]: {
    candidate_generators: [
      "similar_sibling_implementations",
      "extension_points",
      "nearby_tests",
      "docs_spec_sections",
      "symbol_path",
      "lexical",
    ],
    role_policy: "sibling_oriented",
    budget_policy: "exemplar-led: similar siblings + extension points + nearby tests as context for the new code",
  },
  [CapsuleIntent.Explain]: {
    candidate_generators: ["entry_points", "call_graph", "docs_sections", "skeletons"],
    role_policy: "entry_point_oriented",
    budget_policy: "map-first: entry points + call graph as skeletons, minimal source body",
  },
};

function debugStrategy(): IntentStrategy {
  return {
    candidate_generators: [
      "failing_test_to_implementation",
      "production_backfill",
      "class_method_expansion",
      "graph_neighbours",
      "symbol_path",
      "lexical",
    ],
    role_policy: "debug_refinement",
    budget_policy: "pivot-led: focused source on implementation edit-site helpers; generic infrastructure support-only",
  };
}

function callerStrategy(): IntentStrategy {
  return {
    candidate_generators: [
      "callers",
      "dependents",
      "imports",
      "public_api_surfaces",
      "graph_blast_radius",
      "symbol_path",
    ],
    role_policy: "caller_oriented",
    budget_policy: "breadth-first: signatures of callers/dependents/public API over deep source bodies",
  };
}

/** The strategy a resolved intent selects. */
export function strategyForIntent(intent: ResolvedCapsuleIntent): IntentStrategy {
  return INTENT_STRATEGIES[intent];
}

function makePlan(
  intent: ResolvedCapsuleIntent,
  confidence: IntentConfidence,
  reason: string[],
): IntentPlan {
  return {
    intent,
    intent_confidence: confidence,
    intent_reason: reason,
    strategy: strategyForIntent(intent),
    weights: weightsForIntent(intent),
  };
}
