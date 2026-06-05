// Capsule v2 budget allocator.
//
// The allocator turns a raw token budget into a SIZING POLICY: a tier (micro /
// standard / full) that caps how many pivots and support items the capsule may
// carry. The renderer then fills that allocation greedily, dropping anything
// that does not fit the actual token budget.
//
// This is the product's core precision/coverage lever:
//   * a tiny budget must be DECISIVE — one pivot, at most one support item, so
//     the agent sees a single edit target rather than a vague pile of "maybe";
//   * a generous budget can afford broader CONTEXT — several pivots and a ring
//     of supporting signatures.
//
// The tier is chosen from the budget alone (no per-task heuristics), so the same
// budget always yields the same allocation — easy to reason about and to tune.

import { CapsuleV2Mode } from "./types";

export interface BudgetAllocation {
  tier: CapsuleV2Mode.Micro | CapsuleV2Mode.Standard | CapsuleV2Mode.Full;
  /** Hard cap on pivots (edit targets rendered as focused source). */
  maxPivots: number;
  /** Hard cap on support items (rendered as signatures/skeletons). */
  maxSupport: number;
}

// --- Tier thresholds (the tunable policy) ------------------------------------
//
// A budget BELOW MICRO_MAX_TOKENS is "micro": only room for one focused source
// body plus a single supporting signature. A budget below STANDARD_MAX_TOKENS is
// "standard": one or two pivots and a small ring of support. At or above it the
// capsule is "full" and bounded only by the token budget itself.
//
// These two numbers are the main dial between a precise, decisive capsule and a
// broad, high-coverage one. Lower them to bias toward terse, single-target
// capsules; raise them to let mid-size budgets carry more supporting context.
export const MICRO_MAX_TOKENS = 1_500;
export const STANDARD_MAX_TOKENS = 12_000;

// Per-tier item caps. Micro is single-pivot by policy (one decisive edit site);
// full's caps are generous ceilings — the token budget is the real bound there.
const TIER_CAPS = {
  [CapsuleV2Mode.Micro]: { maxPivots: 1, maxSupport: 1 },
  [CapsuleV2Mode.Standard]: { maxPivots: 2, maxSupport: 4 },
  [CapsuleV2Mode.Full]: { maxPivots: 5, maxSupport: 10 },
} as const;

/** Map a token budget to its sizing tier and item caps. */
export function allocateBudget(maxTokens: number): BudgetAllocation {
  const tier = maxTokens < MICRO_MAX_TOKENS
    ? CapsuleV2Mode.Micro
    : maxTokens < STANDARD_MAX_TOKENS
      ? CapsuleV2Mode.Standard
      : CapsuleV2Mode.Full;

  return { tier, ...TIER_CAPS[tier] };
}
