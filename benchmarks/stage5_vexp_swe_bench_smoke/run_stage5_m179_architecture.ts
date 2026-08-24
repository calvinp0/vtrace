/**
 * M179-A — the delivery packer, as a state machine rather than a narrative.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m179_architecture.ts
 *
 * §18 asks for transitions and §20 for every non-budget bound that can interact
 * with a budget. Both are recorded here by IMPORTING the constants they describe,
 * so an artifact claiming the metadata allowance is 1,000 tokens cannot survive
 * someone changing it to 1,200.
 *
 * Offline, pure, no corpus: this workstream reads code, not results.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  RESPONSE_METADATA_ALLOWANCE_FLOOR_TOKENS,
  RESPONSE_METADATA_ALLOWANCE_RATIO,
  responseTokenCeiling,
} from "../../src/mcp/responseEnvelope";
import { ORIENTATION_POLICY } from "../../src/runPipeline/orientationProjection";
import { CompactionStage } from "../../src/productContext/budgetDelivery";
import { hashOf } from "./m179Packing";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

/**
 * The packer's rungs, in execution order.
 *
 * `mutates` is the load-bearing column. Every rung here only ever REMOVES or
 * WEAKENS — none rebuilds the candidate set, none reorders it, and none restarts
 * selection. That is why the sequence of drafts is the SAME at every budget and
 * the budget selects only where to stop, which in turn is why this component is
 * budget-monotone on its own (§36: NOT rung-rebuild, NOT budget-dependent
 * candidate generation).
 */
const PACKER_RUNGS = [
  { rung: 0, state: "SELECTION_REASONS_COMPACTED", stage: CompactionStage.SelectionReasonsCompacted, scope: "every item", mutates: "representation", removesEvidence: false, reorders: false, rebuilds: false, restarts: false },
  { rung: 1, state: "SUPPORT_EXCERPT_SHORTENED", stage: CompactionStage.SupportExcerptShortened, scope: "optional support, weakest first", mutates: "representation", removesEvidence: false, reorders: false, rebuilds: false, restarts: false },
  { rung: 2, state: "SUPPORT_SKELETONIZED", stage: CompactionStage.SupportSkeletonized, scope: "optional support, weakest first", mutates: "representation", removesEvidence: false, reorders: false, rebuilds: false, restarts: false },
  { rung: 3, state: "SUPPORT_DROPPED", stage: CompactionStage.SupportDropped, scope: "optional support that is not answer-bearing", mutates: "selection", removesEvidence: true, reorders: false, rebuilds: false, restarts: false },
  { rung: 4, state: "SECONDARY_PIVOT_SKELETONIZED", stage: CompactionStage.SecondaryPivotSkeletonized, scope: "pivots[1..], weakest first", mutates: "representation", removesEvidence: false, reorders: false, rebuilds: false, restarts: false },
  { rung: 5, state: "SECONDARY_PIVOT_DROPPED", stage: CompactionStage.SecondaryPivotDropped, scope: "pivots[1..] that are not answer-bearing", mutates: "selection", removesEvidence: true, reorders: false, rebuilds: false, restarts: false },
  { rung: 6, state: "WEAK_CONTEXT_DROPPED", stage: CompactionStage.SupportDropped, scope: "any non-answer-bearing, non-required item; keeps at least one", mutates: "selection", removesEvidence: true, reorders: false, rebuilds: false, restarts: false },
  { rung: 7, state: "MINIMAL_REPRESENTATION", stage: CompactionStage.MinimalRepresentation, scope: "every remaining item, weakest first", mutates: "representation", removesEvidence: false, reorders: false, rebuilds: false, restarts: false },
  { rung: 8, state: "STRONGEST_ITEM_ONLY", stage: CompactionStage.MinimalRepresentation, scope: "keep the single strongest item", mutates: "selection", removesEvidence: true, reorders: false, rebuilds: false, restarts: false },
] as const;

/** Every decision in the delivery path whose outcome depends on the budget (§19). */
const BUDGET_DECISIONS = [
  { id: "P-ENTRY", file: "src/productContext/budgetDelivery.ts", line: 113, decision: "initialModelTokens <= budget -> COMPLETE, ladder skipped entirely", bound: "MODEL_VISIBLE_BUDGET", affects: "whether any compaction runs at all" },
  { id: "P-FIT", file: "src/productContext/budgetDelivery.ts", line: 142, decision: "estimateTokens(render(items)) <= budget -> publish at this rung", bound: "MODEL_VISIBLE_BUDGET", affects: "which rung is published; the ONLY budget input to the ladder" },
  { id: "P-FAILCTX", file: "src/productContext/budgetDelivery.ts", line: 255, decision: "FAILURE_CONTEXT emitted only when it itself fits the budget", bound: "MODEL_VISIBLE_BUDGET", affects: "text of an already-failed delivery" },
  { id: "E-CEILING", file: "src/mcp/responseEnvelope.ts", line: 78, decision: "responseTokenCeiling(B) = B + max(1000, ceil(0.15B))", bound: "HARD_DELIVERY_CONSTRAINT", affects: "every escalation below" },
  { id: "E-SECTIONS", file: "src/mcp/responseEnvelope.ts", line: 306, decision: "drop optional sections while total + accounting > ceiling", bound: "HARD_DELIVERY_CONSTRAINT", affects: "pivotNeighborhood, taskSummary, context, memory, rules, inspectFirst, impact" },
  { id: "E-MANDATORY", file: "src/mcp/responseEnvelope.ts", line: 419, decision: "!within_envelope -> productContext.items collapsed to the strongest one", bound: "HARD_DELIVERY_CONSTRAINT", affects: "item metadata only; modelVisibleContext is NOT touched" },
  { id: "E-NONESSENTIAL", file: "src/mcp/responseEnvelope.ts", line: 419, decision: "!within_envelope -> nonessential envelope metadata removed", bound: "HARD_DELIVERY_CONSTRAINT", affects: "envelope metadata only" },
  { id: "E-DEGRADE", file: "src/mcp/responseEnvelope.ts", line: 432, decision: "!within_envelope -> degradeOversizedProductResponse sets resultState=delivery_failure and items=[]", bound: "HARD_DELIVERY_CONSTRAINT", affects: "THE TERMINAL STATE. Discards all evidence; no rung below it returns any." },
  { id: "E-DECLINE", file: "src/mcp/responseEnvelope.ts", line: 443, decision: "!within_envelope -> buildBoundedEnvelopeDecline (M176 terminal)", bound: "HARD_DELIVERY_CONSTRAINT", affects: "bounded truthful decline" },
  { id: "O-PROJECT", file: "src/runPipeline/orientationProjection.ts", line: 239, decision: "resolved !== true || deliveryFailed === true -> no orientation packet", bound: "derived", affects: "translates E-DEGRADE into the agent-visible outcome" },
  { id: "O-CEILING", file: "src/runPipeline/orientationProjection.ts", line: 328, decision: "orientationTokens(packet) > 2000 -> stop admitting related entries", bound: "SOFT_PRODUCT_TARGET", affects: "related list length; NOT derived from max_tokens" },
] as const;

/** §20: non-budget bounds that can interact with a budget. */
const HIDDEN_BOUNDS = [
  { id: "H-SUPPORT-EXCERPT", value: 900, unit: "characters", file: "src/productContext/budgetDelivery.ts", line: 172, governs: "optional-support excerpt head bound", interactsWithBudget: "sets the size of the rung-1 step" },
  { id: "H-MINIMAL-LINES", value: 8, unit: "lines", file: "src/productContext/budgetDelivery.ts", line: 439, governs: "minimalContent line window", interactsWithBudget: "sets the floor size of any skeletonized item" },
  { id: "H-MINIMAL-CHARS", value: 480, unit: "characters", file: "src/productContext/budgetDelivery.ts", line: 440, governs: "minimalContent character window", interactsWithBudget: "sets the floor size of any skeletonized item" },
  { id: "H-MINIMAL-FALLBACK", value: 240, unit: "characters", file: "src/productContext/budgetDelivery.ts", line: 445, governs: "minimalContent fallback slice", interactsWithBudget: "absolute floor of one item's body" },
  { id: "H-REASON", value: 160, unit: "characters", file: "src/productContext/budgetDelivery.ts", line: 424, governs: "compacted selection reason", interactsWithBudget: "sets the size of the rung-0 step" },
  { id: "H-FOCUS-CODE", value: ORIENTATION_POLICY.focusCodeCharacters, unit: "characters", file: "src/runPipeline/orientationProjection.ts", line: 125, governs: "orientation focus excerpt head bound", interactsWithBudget: "caps the focus body regardless of budget" },
  { id: "H-ORIENTATION-CEILING", value: ORIENTATION_POLICY.ceilingTokens, unit: "tokens (chars x 0.3174)", file: "src/runPipeline/orientationProjection.ts", line: 122, governs: "orientation packet ceiling; admits a prefix of related", interactsWithBudget: "INDEPENDENT of max_tokens; can bind before the caller's budget does" },
  { id: "H-METADATA-FLOOR", value: RESPONSE_METADATA_ALLOWANCE_FLOOR_TOKENS, unit: "tokens", file: "src/mcp/responseEnvelope.ts", line: 75, governs: "flat metadata allowance added to the ceiling", interactsWithBudget: "THE BINDING BOUND. Evidence may claim B; delivery affords B + allowance - actualMetadata." },
  { id: "H-METADATA-RATIO", value: RESPONSE_METADATA_ALLOWANCE_RATIO, unit: "fraction", file: "src/mcp/responseEnvelope.ts", line: 76, governs: "proportional metadata allowance", interactsWithBudget: "overtakes the floor only above max_tokens 6,667" },
  { id: "H-MANDATORY-ITEMS", value: 1, unit: "items", file: "src/mcp/responseEnvelope.ts", line: 660, governs: "last-resort item-metadata collapse", interactsWithBudget: "reduces item metadata, never modelVisibleContext" },
] as const;

/**
 * The two bounds, and the gap between them that this milestone is about.
 *
 * Evidence is packed against B. Delivery is judged against B + allowance. So the
 * evidence a response can actually carry is `ceiling - metadata`, and whenever
 * real metadata exceeds the flat allowance that quantity is SMALLER than B — the
 * packer is aiming at a target it is not permitted to hit.
 */
const affordableEvidence = (budget: number, metadataTokens: number): number =>
  responseTokenCeiling(budget) - metadataTokens;

async function main(): Promise<void> {
  const crossover = (() => {
    for (let budget = 1; budget <= 20_000; budget += 1) {
      if (Math.ceil(budget * RESPONSE_METADATA_ALLOWANCE_RATIO) > RESPONSE_METADATA_ALLOWANCE_FLOOR_TOKENS) return budget;
    }
    return null;
  })();

  const stateMachine = {
    schemaVersion: "stage5.m179.packer-state-machine.v1",
    milestone: "M179",
    workstream: "A",
    component: "src/productContext/budgetDelivery.ts :: applyProgressiveContextBudget",
    entryStates: [
      { state: "NO_RESULT", condition: "no items and not resolved", terminal: true },
      { state: "COMPLETE", condition: "initialModelTokens <= budget", terminal: true, note: "source items verbatim; the ladder never runs" },
      { state: "LADDER", condition: "initialModelTokens > budget", terminal: false },
    ],
    rungs: PACKER_RUNGS,
    terminalState: { state: "DELIVERY_FAILURE", condition: "no rung fits the budget", note: "sets resultState=delivery_failure and empties items" },
    invariants: {
      rungSequenceIsBudgetIndependent: true,
      rungSequenceIsNonIncreasingInSize: true,
      budgetSelectsOnlyTheStoppingIndex: true,
      consequence:
        "Because the drafts are the same at every budget and never grow, the largest "
        + "publishable rung is non-decreasing in the budget. This component is "
        + "budget-monotone ON ITS OWN, and M179-B confirms it empirically on the known "
        + "positive: the packer resolves at every budget of the Django ladder.",
    },
  };

  const budgetDecisions = {
    schemaVersion: "stage5.m179.budget-decisions.v1",
    milestone: "M179",
    workstream: "A",
    contracts: {
      MODEL_VISIBLE_BUDGET: "max_tokens. Bounds the rendered model-visible context. Enforced by the packer (M178 P1).",
      HARD_DELIVERY_CONSTRAINT: "responseTokenCeiling(max_tokens). Bounds the complete serialized response. Enforced by the envelope (M178 P2/P3).",
      SOFT_PRODUCT_TARGET: "the orientation packet ceiling. Not derived from max_tokens (M178 P6).",
    },
    decisions: BUDGET_DECISIONS,
    separationOfSelectionAndRendering: {
      selectionDecidedBy: ["P-FIT rungs 3, 5, 6, 8 (items removed)", "E-MANDATORY (item metadata collapsed)", "E-DEGRADE (all evidence discarded)"],
      renderingDecidedBy: ["P-FIT rungs 0, 1, 2, 4, 7 (bodies weakened)", "O-CEILING (related prefix)", "H-FOCUS-CODE (focus head bound)"],
      note:
        "The packer owns productContext.modelVisibleContext, and NOTHING downstream "
        + "of it can shrink that string. E-MANDATORY and E-NONESSENTIAL reduce metadata "
        + "only. So once the packer has chosen a rung, the envelope's sole remaining "
        + "move against an oversized response is to discard the evidence entirely.",
    },
  };

  const hiddenBounds = {
    schemaVersion: "stage5.m179.hidden-bounds.v1",
    milestone: "M179",
    workstream: "A",
    bounds: HIDDEN_BOUNDS,
    twoBoundArithmetic: {
      ceilingFormula: "B + max(RESPONSE_METADATA_ALLOWANCE_FLOOR_TOKENS, ceil(B * RESPONSE_METADATA_ALLOWANCE_RATIO))",
      allowanceFloorTokens: RESPONSE_METADATA_ALLOWANCE_FLOOR_TOKENS,
      allowanceRatio: RESPONSE_METADATA_ALLOWANCE_RATIO,
      ratioOvertakesFloorAtBudget: crossover,
      affordableEvidenceFormula: "responseTokenCeiling(B) - actualMetadataTokens",
      worked: [400, 600, 800, 1_000, 1_600].map((budget) => ({
        budget,
        ceiling: responseTokenCeiling(budget),
        affordableEvidenceAtMetadata1221: affordableEvidence(budget, 1_221),
        packerMayClaim: budget,
        packerOverclaimsBy: budget - affordableEvidence(budget, 1_221),
      })),
      finding:
        "Whenever real metadata exceeds the flat allowance, affordable evidence is "
        + "strictly LESS than the budget the packer is permitted to spend. The packer "
        + "is not misreading its bound; it is enforcing a bound nobody can honour.",
    },
  };

  const artifacts: Array<[string, unknown]> = [
    ["stage5_m179_packer_state_machine.json", stateMachine],
    ["stage5_m179_budget_decisions.json", budgetDecisions],
    ["stage5_m179_hidden_bounds.json", hiddenBounds],
  ];
  for (const [name, value] of artifacts) {
    writeFileSync(path.join(RESULTS, name), `${JSON.stringify(value, null, 1)}\n`);
    console.log(`wrote ${name} (${hashOf(value)})`);
  }
  console.log(`\nallowance floor=${RESPONSE_METADATA_ALLOWANCE_FLOOR_TOKENS} ratio=${RESPONSE_METADATA_ALLOWANCE_RATIO} ratio-overtakes-floor at max_tokens=${crossover}`);
  for (const row of hiddenBounds.twoBoundArithmetic.worked) {
    console.log(`  B=${String(row.budget).padStart(5)} ceiling=${String(row.ceiling).padStart(5)} affordable(meta=1221)=${String(row.affordableEvidenceAtMetadata1221).padStart(5)} overclaim=${row.packerOverclaimsBy}`);
  }
}

await main();
