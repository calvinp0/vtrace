// Capsule v2 — product-facing context capsule types.
//
// Capsule v2 is the bounded, deterministic, graph-native context primitive a
// coding agent consumes for a single task. It is assembled by the pipeline:
//
//   task signals -> intent detection -> candidate generators -> evidence
//   scorecards -> pivot/support/discard roles -> budget allocator -> renderer
//
// These types are the PRODUCT VOCABULARY: the intent surface, the per-candidate
// scorecard (snake_case keys, exactly as a JSON consumer sees them), the role-
// assigned items, and the budget accounting. They are intentionally decoupled
// from the internal capsule builder types so the product surface can evolve
// without churning the retrieval/scoring internals.

import type { HybridScoreComponents } from "../retrieval/hybridScoring";

/**
 * The intent a caller declares for a task. `Auto` is resolved from the task
 * signals into one of the four concrete intents; the rest are explicit.
 */
export enum CapsuleIntent {
  Auto = "auto",
  Debug = "debug",
  Refactor = "refactor",
  Impact = "impact",
  TestFailure = "test-failure",
}

/** The concrete intents `Auto` resolves to (never `Auto` itself). */
export type ResolvedCapsuleIntent =
  | CapsuleIntent.Debug
  | CapsuleIntent.Refactor
  | CapsuleIntent.Impact
  | CapsuleIntent.TestFailure;

/** Parse a user-supplied intent string, or undefined if unrecognised. */
export function parseCapsuleIntent(value: string): CapsuleIntent | undefined {
  const normalized = value.trim().toLowerCase();
  for (const intent of Object.values(CapsuleIntent)) {
    if (intent === normalized) {
      return intent;
    }
  }
  // Accept the underscore spelling for ergonomics (test_failure == test-failure).
  if (normalized === "test_failure" || normalized === "testfailure") {
    return CapsuleIntent.TestFailure;
  }
  return undefined;
}

/**
 * The per-candidate scorecard, in the product's snake_case vocabulary. Every
 * value is normalised to [0, 1] WITHIN the candidate pool (except `final`, the
 * weighted sum, which can exceed 1). `centrality` is a tie-breaker/support
 * signal only — it can never make a candidate a pivot on its own.
 */
export interface CapsuleV2Scorecard {
  lexical: number;
  symbol: number;
  path: number;
  test_to_impl: number;
  graph_proximity: number;
  centrality: number;
  actionability: number;
  hub_penalty: number;
  final: number;
}

/** Project the internal hybrid score components onto the product scorecard. */
export function toScorecard(scores: HybridScoreComponents): CapsuleV2Scorecard {
  return {
    lexical: scores.lexical,
    symbol: scores.symbol,
    path: scores.path,
    test_to_impl: scores.testToImpl,
    graph_proximity: scores.graphProximity,
    centrality: scores.centrality,
    actionability: scores.actionability,
    hub_penalty: scores.hubPenalty,
    final: scores.final,
  };
}

/** How a selected item's content is rendered. */
export enum CapsuleV2ContentMode {
  /** Pivot: focused source body — enough to make the edit. */
  Full = "full",
  /** Support (or budget-compressed pivot): signature/class line only. */
  Signature = "signature",
  /** Support with no signature available: skeleton/name only. */
  Skeleton = "skeleton",
}

/** A selected pivot or support item, fully rendered and accounted for. */
export interface CapsuleV2Item {
  role: "pivot" | "support";
  path: string;
  fq_name: string;
  symbol: string;
  kind: string;
  content_mode: CapsuleV2ContentMode;
  /** Focused source body (Full mode only). */
  source?: string;
  /** Signature / class line (Signature mode, and carried for Full when present). */
  signature?: string;
  /** Ordered evidence: WHY this item was selected. Never empty. */
  evidence: string[];
  scorecard: CapsuleV2Scorecard;
  estimated_tokens: number;
}

/** A candidate that did not make the capsule, with the reason it was dropped. */
export interface CapsuleV2Discarded {
  path: string;
  symbol: string;
  kind: string;
  scorecard: CapsuleV2Scorecard;
  evidence: string[];
  discard_reason: string;
}

/** Token-budget accounting for the assembled capsule. */
export interface CapsuleV2Budget {
  max_tokens: number;
  estimated_tokens: number;
  used_percent: number;
}

/** When the capsule names a real edit target, the allocator's sizing tier. */
export enum CapsuleV2Mode {
  Micro = "micro",
  Standard = "standard",
  Full = "full",
  /** No high-confidence pivot recovered — the capsule is intentionally empty. */
  NoContext = "no_context",
}

export interface CapsuleV2Diagnostics {
  /** How `auto` resolved (or that the intent was explicit), in prose. */
  intent_reason: string;
  /** Total candidates the role gate ran over (post-retrieval, pre-roles). */
  candidate_count: number;
  pivot_count: number;
  support_count: number;
  discarded_count: number;
  /** The allocator tier (micro/standard/full) the budget mapped to. */
  tier: CapsuleV2Mode;
  /** The retrieval weights this intent applied, for reproducibility. */
  weights: Record<string, number>;
  /** Shaped query signals (likely files/symbols/failing tests). */
  likely_files: string[];
  likely_symbols: string[];
  failing_tests: string[];
}

/** The complete Capsule v2 result — the value the CLI/JSON surface emits. */
export interface CapsuleV2Result {
  intent: ResolvedCapsuleIntent;
  /** Realised mode: a sizing tier, or `no_context` when no pivot was found. */
  actual_mode: CapsuleV2Mode;
  /** Present (and human-readable) only when `actual_mode === no_context`. */
  reason?: string;
  budget: CapsuleV2Budget;
  pivots: CapsuleV2Item[];
  support: CapsuleV2Item[];
  discarded: CapsuleV2Discarded[];
  diagnostics: CapsuleV2Diagnostics;
}
