// Capsule v2 budget allocator.
//
// The allocator turns a raw token budget into a SIZING POLICY: a tier (micro /
// standard / full) that fixes how many PIVOTS the capsule may name and how wide
// the support ORDERING WINDOW is. The renderer then fills the capsule greedily
// in rank order, packing every support candidate whose rendering fits the
// remaining token budget.
//
// PIVOTS ARE A ROLE, NOT A SIZE. A pivot is an edit target: the product context
// marks it `required` (EDIT_OR_RULE_OUT) and the M112 action contract turns it
// into an obligation the agent must discharge. The pivot count is therefore
// role semantics — how many edit sites a request may be told to consider —
// and it stays tiered:
//   * a tiny budget must be DECISIVE — one pivot, so the agent sees a single
//     edit target rather than a vague pile of "maybe";
//   * a generous budget can afford several pivots.
// The M101 anchored exemption is the only bounded exception, and it is one.
//
// SUPPORT IS BOUNDED BY THE BUDGET, NOT BY A COUNT (M206). Until M206 the tier
// also carried a hard support MAXIMUM (micro 1, standard 4, full 10) and the
// packing loop discarded every ranked support candidate past it. Measured on
// the frozen C-MED A11 sweep (20 tasks x 5 budgets), that count discarded
// 2,573 support-authorised candidates over 100 responses — candidates that
// fit the caller's ceiling with no rejection at any budget — and was the
// binding stage on 95 of the 100 responses while the token budget bound none.
// The number was a historical default from the first capsule commit
// (f099c3b1) with no measured rationale; the comment beside `full` claimed the
// token budget was the real bound there, which the measurement contradicted.
// So the count is no longer a maximum. What bounds support delivery is:
//   * the caller's token budget, tested per item by the renderer;
//   * the ranked stream itself (the retrieval pool and the lanes' own caps);
//   * downstream, the evidence budget on the model-visible context.
//
// The tier's support number survives as the support WINDOW: the ordering window
// the lane placement rules read (co-edit, path-completion and mechanism entries
// displace or follow "winners" inside it; the file-evidence lane counts the
// files inside it as already present) and the documentation-section fill count.
// Keeping the window at its historical size keeps every lane's placement and
// gating arithmetic exactly as it was, so lifting the maximum changed only how
// much of the SAME ordered stream is delivered.
//
// The tier is chosen from the budget alone (no per-task heuristics), so the same
// budget always yields the same allocation — easy to reason about and to tune.

import { CapsuleV2Mode } from "./types";

export interface BudgetAllocation {
  tier: CapsuleV2Mode.Micro | CapsuleV2Mode.Standard | CapsuleV2Mode.Full;
  /** Hard cap on pivots (edit targets rendered as focused source). Role semantics; see above. */
  maxPivots: number;
  /**
   * The support ORDERING WINDOW and documentation fill count for the tier.
   * Not a delivery maximum: support delivery is bounded by the token budget
   * and the ranked stream (M206).
   */
  supportWindow: number;
}

// --- Tier thresholds (the tunable policy) ------------------------------------
//
// A budget BELOW MICRO_MAX_TOKENS is "micro": one focused source body and a
// one-entry support window. A budget below STANDARD_MAX_TOKENS is "standard":
// one or two pivots and a small window. At or above it the capsule is "full".
//
// These two numbers are the main dial between a precise, decisive capsule and a
// broad, multi-target one. Lower them to bias toward terse, single-target
// capsules; raise them to let mid-size budgets name more edit targets.
export const MICRO_MAX_TOKENS = 1_500;
export const STANDARD_MAX_TOKENS = 12_000;

// Per-tier pivot caps and support windows. Micro is single-pivot by policy
// (one decisive edit site). The windows are the historical support counts,
// kept for the lane placement arithmetic they parameterise.
const TIER_POLICY = {
  [CapsuleV2Mode.Micro]: { maxPivots: 1, supportWindow: 1 },
  [CapsuleV2Mode.Standard]: { maxPivots: 2, supportWindow: 4 },
  [CapsuleV2Mode.Full]: { maxPivots: 5, supportWindow: 10 },
} as const;

/** Map a token budget to its sizing tier, pivot cap and support window. */
export function allocateBudget(maxTokens: number): BudgetAllocation {
  const tier = maxTokens < MICRO_MAX_TOKENS
    ? CapsuleV2Mode.Micro
    : maxTokens < STANDARD_MAX_TOKENS
      ? CapsuleV2Mode.Standard
      : CapsuleV2Mode.Full;

  return { tier, ...TIER_POLICY[tier] };
}
