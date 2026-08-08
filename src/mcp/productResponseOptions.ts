import { McpResponseDetail, responseTokenCeiling, type McpResponseDetail as McpResponseDetailValue } from "./responseEnvelope";

/**
 * The single place that decides how large a product response may be.
 *
 * M130's response incident had two causes. The visible one was that nothing
 * bounded the serialized payload. The quieter one was that `max_tokens` reached
 * the v1 capsule but never the authoritative product context, which silently
 * defaulted to 8000 — because the resolution `capsule_budget_tokens ?? max_tokens
 * ?? default` was written out by hand at each call site, and one of them was
 * written differently. A budget rule duplicated across call sites is a budget
 * rule that will eventually disagree with itself.
 *
 * This module is small on purpose: it is the typed contract that the context
 * budget, the product context builder and the response envelope all read from,
 * so they cannot drift apart.
 */

/** Budget applied when a caller expresses no preference at all. */
export const CAPSULE_V2_PRODUCT_DEFAULT_BUDGET_TOKENS = 8_000;

export interface ProductResponseOptionsInput {
  /** The caller's model-visible context budget (`max_tokens`). */
  readonly maxTokens?: number | undefined;
  /** Explicit capsule budget (`capsule_budget_tokens`), which wins when present. */
  readonly capsuleBudgetTokens?: number | undefined;
  readonly detail?: string | undefined;
  readonly includeItemContent?: boolean | undefined;
}

export interface ProductResponseOptions {
  /**
   * Tokens of MODEL-VISIBLE context the caller asked for. This bounds the
   * rendered context; it is not a bound on the serialized response.
   */
  readonly requestedContextTokens: number;
  /** Hard ceiling on the COMPLETE serialized response, in estimated tokens. */
  readonly responseTokenCeiling: number;
  readonly detail: McpResponseDetailValue;
  readonly includeItemContent: boolean;
}

export function resolveProductResponseOptions(
  input: ProductResponseOptionsInput,
): ProductResponseOptions {
  const requestedContextTokens = resolveRequestedContextTokens(input);

  return {
    requestedContextTokens,
    responseTokenCeiling: responseTokenCeiling(requestedContextTokens),
    detail: input.detail !== undefined && isKnownDetail(input.detail)
      ? input.detail
      : McpResponseDetail.Standard,
    includeItemContent: input.includeItemContent === true,
  };
}

/**
 * An explicit capsule budget wins over `max_tokens`; `max_tokens` wins over the
 * default. Non-finite or non-positive values are treated as absent rather than
 * propagated, so a malformed request cannot produce a zero-token context.
 */
export function resolveRequestedContextTokens(input: ProductResponseOptionsInput): number {
  return usableBudget(input.capsuleBudgetTokens)
    ?? usableBudget(input.maxTokens)
    ?? CAPSULE_V2_PRODUCT_DEFAULT_BUDGET_TOKENS;
}

function usableBudget(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function isKnownDetail(value: string): value is McpResponseDetailValue {
  return (Object.values(McpResponseDetail) as string[]).includes(value);
}
