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
// The support number survived M206 as the support WINDOW: the ordering window
// the lane placement rules read (co-edit, path-completion and mechanism entries
// displace or follow "winners" inside it; the file-evidence lane counts the
// files inside it as already present) and the documentation-section fill count.
// M208 made the window one constant for every tier (see below), so the lanes
// partition the same ranked stream the same way at every budget.
//
// The tier is chosen from the budget alone (no per-task heuristics), so the same
// budget always yields the same allocation — easy to reason about and to tune.

import { CapsuleV2Mode } from "./types";

export interface BudgetAllocation {
  tier: CapsuleV2Mode.Micro | CapsuleV2Mode.Standard | CapsuleV2Mode.Full;
  /** Hard cap on pivots (edit targets rendered as focused source). Role semantics; see above. */
  maxPivots: number;
  /**
   * The support ORDERING WINDOW and documentation fill count. One constant for
   * every tier (M208, `SUPPORT_ORDERING_WINDOW`), never a delivery maximum:
   * support delivery is bounded by the token budget and the ranked stream
   * (M206).
   */
  supportWindow: number;
  /**
   * The CANDIDATE ALLOWANCE: how many ranked candidates retrieval returns to
   * role assignment for this budget. Budget-derived, not tiered; see
   * `candidatePoolFor`.
   */
  candidatePool: number;
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

// Per-tier pivot caps. Micro is single-pivot by policy (one decisive edit site).
const TIER_POLICY = {
  [CapsuleV2Mode.Micro]: { maxPivots: 1 },
  [CapsuleV2Mode.Standard]: { maxPivots: 2 },
  [CapsuleV2Mode.Full]: { maxPivots: 5 },
} as const;

// --- The support ordering window (M208) --------------------------------------
//
// THE WINDOW IS ONE NUMBER, NOT A TIER. Until M208 the ordering window was the
// tier's historical support count (micro 1, standard 4, full 10), so the lane
// placement rules re-partitioned the SAME ranked support at every tier boundary:
// `orderSupportWithCoedit` splits the base order at the window into protected
// winners, displacing co-edits, displaceable winners, spare co-edits and the
// rest, and the co-edit anchors, the file-evidence lane's "files already
// present" count and the path-completion / mechanism lanes all read the window.
// Measured on the frozen C-MED A13 transitions (M208 causal report): 17 of 80
// adjacent-budget transitions first diverge at the support order, 84 delivered
// entries change places purely because the window changed with the tier, and
// lane-injected entries are not reproduced at the next budget because their
// anchors were read from a different window.
//
// A caller's budget must decide HOW FAR the same ordered plan is delivered, not
// re-partition the plan. So the window is a constant: the standard tier's
// historical value, which is the product's default budget (8000 tokens) and the
// most-validated live path, so the default request's support order is
// byte-identical to M207's. Delivery is bounded by the token budget (M206) and
// the evidence budget, never by this number.
export const SUPPORT_ORDERING_WINDOW = 4;

// --- The candidate allowance (M207) ------------------------------------------
//
// THE POOL IS SIZED BY THE BUDGET, NOT BY A CONSTANT. Until M207 the capsule
// asked retrieval for a fixed 25 ranked candidates whatever the caller's
// budget (CANDIDATE_POOL_SIZE, from the first capsule commit f099c3b1, whose
// comment called it "generous" input the allocator and role gate would trim).
// Once M206 made support delivery budget-bound, that constant became the
// binding stage of the frozen A11 sweep at 8000 and 16000: the ranked stream
// ended at the pool while most of the caller's budget stood unused (39 of 100
// responses). The M207 pool-width sweep — the same product path, the same
// lexical universe and scores, only the pool varied — measured the supply
// curve on C-MED: whole-output utilisation at 16000 rose 27.9% -> 44.2% -> 73.9%
// -> 94.7% at widths 25 / 50 / 100 / uncapped, with pivot sets identical at
// every width and the universe exhausting at a median of 130 candidates.
//
// The rule: the number of ranked candidates the caller's budget could deliver
// at the product's own measured cost per delivered support entry, never below
// the historical pool (so no budget receives less than it did) and never above
// an independent hard maximum (so a pathological budget cannot turn retrieval
// into a repository scan). It grows monotonically with the budget, carries no
// tier or rung, and knows nothing about any benchmark threshold.
//
// The expected cost is the median whole-output cost of one delivered support
// entry on the M207 sweep (100-123 tokens per delivered item across widths and
// budgets; a related entry renders as a skeleton or signature plus its header),
// stated in the same chars/4 currency as `maxTokens`. It is a product
// measurement, not a tuning knob: lowering it retrieves candidates the budget
// cannot deliver, raising it leaves budget the universe could have filled.
//
// The floor is the historical pool. The hard maximum bounds the per-candidate
// downstream work (role refinement, signature loads, support rendering,
// projection) at roughly three times the largest natural universe measured on
// any corpus (143 candidates on C-MED with the lexical row budget at 100), so
// it never binds on a real repository today and still bounds a caller asking
// for a million tokens.
//
// What the allowance does NOT change: the lexical lane's row budget stays
// derived from the floor (widening it changes BM25 idf and every normalised
// score — a ranking change, not a breadth change), the backfill lanes keep
// their own search windows, and delivery stays bounded by the token budget,
// the evidence budget and the caller's ceiling. A candidate may be retrieved
// and still not delivered; that is expected.

/** The historical pool: the least allowance any budget receives. */
export const CANDIDATE_POOL_FLOOR = 25;
/** Measured median whole-output cost of one delivered support entry (M207 sweep). */
export const EXPECTED_TOKENS_PER_DELIVERED_CANDIDATE = 120;
/** Independent resource bound on the ranked candidates handed downstream. */
export const CANDIDATE_POOL_HARD_MAXIMUM = 400;

/** The candidate allowance for a token budget: clamp(ceil(budget / expected cost), floor, hard maximum). */
export function candidatePoolFor(maxTokens: number): number {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return CANDIDATE_POOL_FLOOR;
  const wanted = Math.ceil(maxTokens / EXPECTED_TOKENS_PER_DELIVERED_CANDIDATE);
  return Math.max(CANDIDATE_POOL_FLOOR, Math.min(CANDIDATE_POOL_HARD_MAXIMUM, wanted));
}

/**
 * The pivot PLAN window (M208): the largest number of edit sites any tier may
 * name. The capsule orders this many pivot-worthy candidates once, with the
 * pivot order, and every tier's cap takes a prefix of that plan — so the full
 * tier's pivots are what they were, the standard tier's are its first two, the
 * micro tier's its first one, and the lead never depends on the budget.
 */
export const PIVOT_PLAN_WINDOW = TIER_POLICY[CapsuleV2Mode.Full].maxPivots;

/** Map a token budget to its sizing tier, pivot cap, support window and candidate allowance. */
export function allocateBudget(maxTokens: number): BudgetAllocation {
  const tier = maxTokens < MICRO_MAX_TOKENS
    ? CapsuleV2Mode.Micro
    : maxTokens < STANDARD_MAX_TOKENS
      ? CapsuleV2Mode.Standard
      : CapsuleV2Mode.Full;

  return { tier, ...TIER_POLICY[tier], supportWindow: SUPPORT_ORDERING_WINDOW, candidatePool: candidatePoolFor(maxTokens) };
}
