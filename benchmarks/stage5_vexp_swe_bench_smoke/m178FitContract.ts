/**
 * M178 — instrumenting what "the response fits its budget" actually means.
 *
 * THE QUESTION, IN ONE SENTENCE. `get_impact_graph`'s compaction ladder is gated
 * on a three-condition `fits()`, while the terminal that decides whether the
 * finished draft may be returned tests only two of them — so M177 closed with a
 * measured mismatch it deliberately did not resolve, and this module is the
 * instrument that resolves it.
 *
 * THE THREE CONDITIONS, NAMED. `impactResponseEnvelope.ts:183` reads:
 *
 *   estimatedTotalTokens        <= totalCeiling                     (C1)
 *   serializedCharacters        <= HARD_SERIALIZED_CHARACTER_CEILING (C2)
 *   modelVisibleEstimatedTokens <= requestedMaxTokens               (C3)
 *
 * and the terminal at `:330` tests `C1 && C2`. C3 is the one that governs the
 * ladder and not the delivery decision.
 *
 * WHY THAT IS MEASURABLE WITHOUT TOUCHING THE PRODUCT. Every quantity all three
 * conditions read is published on the delivered response's `responseBudget`
 * block. For a NORMALLY DELIVERED response that block describes the very bytes
 * the caller received, so evaluating C1/C2/C3 on it reproduces the predicate the
 * product would have applied to what it actually returned. No fork, no shim, no
 * re-implementation of the ladder.
 *
 * THE ONE THING THAT INSTRUMENT CANNOT SEE, STATED SO IT IS NOT MISREAD. On a
 * DECLINED response `responseBudget` describes the DECLINE RECORD — a few hundred
 * tokens that trivially fit — and NOT the exhausted draft whose size caused the
 * decline. Reading C1/C2/C3 off a decline therefore reports `fits = true` for a
 * call that declined, which is an artefact of where the block is measured and not
 * a second disagreement class. `classify()` below refuses to score declines for
 * that reason, and `DISAGREEMENT_UNOBSERVABLE_ON_DECLINE` documents it at the one
 * place a future reader would otherwise draw the wrong conclusion.
 *
 * THE `limits.maxTokens` TRAP (§14). `limits.maxTokens` and
 * `responseBudget.requestedMaxTokens` are the caller's BUDGET PARAMETER echoed
 * back. They are serialized into the response and therefore do consume the
 * budget, but a difference in them between two budgets is not a difference in
 * CONTENT. M177's first residue check mistook exactly this for seven distinct
 * terminal bodies. `budgetParameterFields()` names them and
 * `contentIdentity()` strips them, so a content comparison across budgets
 * compares content.
 *
 * THE FIXTURE TRAP (§15). M177's `graph()` fixture was evidence-heavy and
 * metadata-light and so fitted at `max_tokens=1` — the exact opposite of the
 * shape that fails — and never reached the branch it was believed to test. Every
 * control here reports the predicate state it actually reached
 * (`reachedState`), so "this control exercises the disagreement" is a
 * measurement rather than an assumption.
 *
 * PURE. No agent, no Docker, no paid API, no network, no randomness. The only
 * clock readings are `timing`/`accounting.latencyMs`, which the identity
 * functions strip.
 */

import { createHash } from "node:crypto";

import {
  IMPACT_HARD_SERIALIZED_CHARACTER_CEILING,
  IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS,
  type ImpactProductResponse,
  type ImpactResponseBudget,
} from "../../src/impact/impactResponseEnvelope";
import type { ResponseBudgetAccounting } from "../../src/mcp/responseEnvelope";

/* ------------------------------------------------------------------ *
 * The conditions, one function each.
 * ------------------------------------------------------------------ */

/** C1 — the complete serialized response against `max_tokens + metadata allowance`. */
export const impactC1TotalWithinCeiling = (budget: ImpactResponseBudget): boolean =>
  budget.estimatedTotalTokens <= budget.totalCeiling;

/** C2 — the complete serialized response against the flat 80,000-character bound. */
export const impactC2WithinCharacterCeiling = (budget: ImpactResponseBudget): boolean =>
  budget.serializedCharacters <= IMPACT_HARD_SERIALIZED_CHARACTER_CEILING;

/** C3 — the five evidence keys against the caller's declared `max_tokens`. */
export const impactC3EvidenceWithinRequested = (budget: ImpactResponseBudget): boolean =>
  budget.modelVisibleEstimatedTokens <= budget.requestedMaxTokens;

/** The ladder's gate: all three. Reproduces `impactResponseEnvelope.ts:183`. */
export const impactLadderFits = (budget: ImpactResponseBudget): boolean =>
  impactC1TotalWithinCeiling(budget)
  && impactC2WithinCharacterCeiling(budget)
  && impactC3EvidenceWithinRequested(budget);

/** The terminal's gate: C1 && C2. Reproduces `impactResponseEnvelope.ts:330`. */
export const impactTerminalAccepts = (budget: ImpactResponseBudget): boolean =>
  impactC1TotalWithinCeiling(budget) && impactC2WithinCharacterCeiling(budget);

/**
 * `run_pipeline`'s delivery contract — the model-visible context against
 * `max_tokens`. Enforced in a SEPARATE component (`budgetDelivery.ts:136`), which
 * is the structural difference this milestone turns out to be about.
 */
export const pipelineDeliveryFits = (budget: ResponseBudgetAccounting): boolean =>
  budget.estimated_model_visible_tokens <= budget.requested_context_tokens;

/** `run_pipeline`'s envelope contract. Ladder and terminal both read this one. */
export const pipelineEnvelopeFits = (budget: ResponseBudgetAccounting): boolean =>
  budget.within_envelope;

/* ------------------------------------------------------------------ *
 * Classification.
 * ------------------------------------------------------------------ */

export const DISAGREEMENT_UNOBSERVABLE_ON_DECLINE = "unobservable_on_decline" as const;

export type FitClassification =
  /** Delivered normally and every condition the ladder gates on holds. */
  | "agree_normal"
  /** Delivered normally while C3 — the ladder's own gate — is false. §75 row 1. */
  | "emitted_with_ladder_gate_false"
  /** Delivered normally while the TERMINAL's own conditions are false. Must be empty. */
  | "emitted_with_terminal_gate_false"
  /** A truthful bounded decline. See the header: not scoreable from its own block. */
  | typeof DISAGREEMENT_UNOBSERVABLE_ON_DECLINE;

export interface ImpactObservation {
  readonly symbolFqn: string;
  readonly maxTokens: number;
  readonly declined: boolean;
  readonly c1: boolean;
  readonly c2: boolean;
  readonly c3: boolean;
  readonly ladderFits: boolean;
  readonly terminalAccepts: boolean;
  readonly classification: FitClassification;
  readonly modelVisibleEstimatedTokens: number;
  readonly metadataEstimatedTokens: number;
  readonly estimatedTotalTokens: number;
  readonly totalCeiling: number;
  readonly serializedCharacters: number;
  readonly retainedEdges: number;
  readonly omittedEdges: number;
  /** Which predicate state this observation actually reached. §15. */
  readonly reachedState: string;
}

export function isImpactDecline(response: ImpactProductResponse): boolean {
  const diagnostics = (response as unknown as { diagnostics?: { envelopeDecline?: unknown } }).diagnostics;
  return diagnostics?.envelopeDecline === true;
}

export function classify(response: ImpactProductResponse): FitClassification {
  if (isImpactDecline(response)) return DISAGREEMENT_UNOBSERVABLE_ON_DECLINE;
  const budget = response.responseBudget;
  if (!impactTerminalAccepts(budget)) return "emitted_with_terminal_gate_false";
  if (!impactC3EvidenceWithinRequested(budget)) return "emitted_with_ladder_gate_false";
  return "agree_normal";
}

export function observe(symbolFqn: string, maxTokens: number, response: ImpactProductResponse): ImpactObservation {
  const budget = response.responseBudget;
  const declined = isImpactDecline(response);
  const c1 = impactC1TotalWithinCeiling(budget);
  const c2 = impactC2WithinCharacterCeiling(budget);
  const c3 = impactC3EvidenceWithinRequested(budget);
  const classification = classify(response);
  return {
    symbolFqn,
    maxTokens,
    declined,
    c1,
    c2,
    c3,
    ladderFits: impactLadderFits(budget),
    terminalAccepts: impactTerminalAccepts(budget),
    classification,
    modelVisibleEstimatedTokens: budget.modelVisibleEstimatedTokens,
    metadataEstimatedTokens: budget.metadataEstimatedTokens,
    estimatedTotalTokens: budget.estimatedTotalTokens,
    totalCeiling: budget.totalCeiling,
    serializedCharacters: budget.serializedCharacters,
    retainedEdges: budget.retainedEdges,
    omittedEdges: budget.omittedEdges,
    reachedState: declined
      ? `decline(resultState=${budget.resultState})`
      : `normal(resultState=${budget.resultState},edges=${budget.retainedEdges},c3=${c3 ? "T" : "F"})`,
  };
}

/* ------------------------------------------------------------------ *
 * The mechanism, stated as arithmetic so it can be checked rather than believed.
 * ------------------------------------------------------------------ */

/**
 * The width of the disagreement window for one authoritative result.
 *
 * DERIVATION. Below its floor the ladder is exhausted, so the draft it hands the
 * terminal is a CONSTANT: `mvFloor` evidence tokens and `metaFloor` metadata
 * tokens, total `mvFloor + metaFloor`. Over that constant draft,
 *
 *   the terminal accepts   <=>  mvFloor + metaFloor <= B + allowance
 *                          <=>  B >= mvFloor + metaFloor - allowance
 *   the ladder's C3 holds  <=>  mvFloor <= B
 *
 * so a normal response is emitted with C3 false exactly on
 *
 *   B in [ mvFloor + metaFloor - allowance , mvFloor - 1 ]
 *
 * whose width is `allowance - metaFloor`. The window is the SURPLUS METADATA
 * ALLOWANCE: the amount by which the flat 800-token grant exceeds what the
 * metadata on that specimen actually costs. Nothing about the evidence enters it.
 *
 * Returns 0 when the metadata floor meets or exceeds the allowance.
 */
export function predictedDisagreementWindow(
  modelVisibleFloorTokens: number,
  metadataFloorTokens: number,
  allowanceTokens: number = IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS,
): { readonly lowBudget: number; readonly highBudget: number; readonly width: number } {
  const lowBudget = modelVisibleFloorTokens + metadataFloorTokens - allowanceTokens;
  const highBudget = modelVisibleFloorTokens - 1;
  return { lowBudget, highBudget, width: Math.max(0, highBudget - lowBudget + 1) };
}

/* ------------------------------------------------------------------ *
 * Identity, with the budget-parameter trap controlled.
 * ------------------------------------------------------------------ */

/**
 * Fields whose value IS the caller's budget parameter echoed back, or a direct
 * report of it. They are legitimately part of the response and legitimately
 * consume it; they are simply not CONTENT, so they are excluded from any
 * comparison whose question is "did the evidence change?". §14.
 */
export function budgetParameterFields(): readonly string[] {
  return Object.freeze([
    "limits.maxTokens",
    "responseBudget.requestedMaxTokens",
    "responseBudget.totalCeiling",
    "responseBudget.serializedCharacters",
    "responseBudget.estimatedTotalTokens",
    "responseBudget.metadataEstimatedTokens",
  ]);
}

const CLOCK_DERIVED_KEYS = new Set(["timing", "accounting"]);

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = canonicalize(record[key]);
  return sorted;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Identity of the CONTENT of a response: clock fields and budget-parameter fields
 * removed. Two responses at different budgets that differ only because the budget
 * differs hash the same here, which is the whole point.
 */
export function contentIdentity(response: ImpactProductResponse): string {
  const record = structuredClone(response) as unknown as Record<string, unknown>;
  for (const key of CLOCK_DERIVED_KEYS) delete record[key];
  const limits = record.limits as Record<string, unknown> | undefined;
  if (limits !== undefined) delete limits.maxTokens;
  const budget = record.responseBudget as Record<string, unknown> | undefined;
  if (budget !== undefined) {
    delete budget.requestedMaxTokens;
    delete budget.totalCeiling;
    delete budget.serializedCharacters;
    delete budget.estimatedTotalTokens;
    delete budget.metadataEstimatedTokens;
  }
  return sha256(JSON.stringify(canonicalize(record)));
}

/** Identity of everything the caller receives, budget echo included. */
export function fullIdentity(response: ImpactProductResponse): string {
  const record = structuredClone(response) as unknown as Record<string, unknown>;
  for (const key of CLOCK_DERIVED_KEYS) delete record[key];
  return sha256(JSON.stringify(canonicalize(record)));
}
