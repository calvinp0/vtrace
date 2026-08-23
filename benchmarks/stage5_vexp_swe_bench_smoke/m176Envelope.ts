/**
 * M176 — measuring the response envelope's terminal states.
 *
 * THE DEFECT, IN ONE SENTENCE. `compactProductResponse` runs a degradation ladder
 * and, when the ladder is exhausted and the response still will not fit, throws
 * `product_response_envelope_unreachable` — which the MCP server turns into
 * `handler_failed`, so a predictable product-pressure condition leaves the caller
 * with a transport error rather than a bounded truthful answer.
 *
 * THE INSTRUMENT. Everything here is derived from ONE observable: the smallest
 * `requestedContextTokens` at which a given authoritative response still
 * terminates. Call it the response's ENVELOPE FLOOR.
 *
 *   floor <= ceiling(requested)   the response is deliverable
 *   floor >  ceiling(requested)   the ladder is exhausted and the tool throws
 *
 * WHY THE FLOOR, AND NOT A PRE-COMPACTION MEASUREMENT. M175-B established the
 * measurement trap this module is built to avoid: compaction runs before any
 * response is observable, and RAISING THE CEILING TO SEE INSIDE CHANGES WHAT IS
 * SELECTED (24 items at 120k, 10 at 8k). The floor sidesteps it. At exactly the
 * floor the full ladder HAS run — every rung, including the last-resort
 * degradation — and the resulting object is observable, so the irreducible
 * residue can be read off a specimen that was never given a different budget to
 * be observed under. One binary search, one causally neutral reading.
 *
 * A SECOND TRAP, FOUND HERE AND RECORDED SO IT IS NOT WALKED INTO AGAIN.
 * `compactProductResponse` is NOT idempotent across the delivery states. Replaying
 * it over an ALREADY-compacted snapshot whose `productContext` carries
 * `retrievalFound: true, resolved: false, items: []` reclassifies it as
 * `no_result`, because `applyProgressiveContextBudget` derives retrieval success
 * from `resolved || items.length > 0` and never consults the `retrievalFound` the
 * previous pass wrote. The live product compacts once, so this is not a shipped
 * defect — but it means M175's 8,000-token `.debug` captures CANNOT be used to
 * study delivery states, and every snapshot this module measures must be a
 * single-pass authoritative capture.
 *
 * PURE. No agent, no Docker, no paid API, no clock, no randomness.
 */

import { compactProductResponse, McpResponseDetail, responseTokenCeiling } from "../../src/mcp/responseEnvelope";

export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The message the product throws when the ladder is exhausted. */
export const UNREACHABLE_MESSAGE = "product_response_envelope_unreachable";

/**
 * The envelope's own estimator. The envelope measures itself with chars/4
 * (`estimate_method: "chars_div_4"`), so any arithmetic about its ceiling must
 * use chars/4 too — M166's 0.3174 tokens/char is the better estimate of what a
 * PROVIDER bills, and is used only for reporting model-facing cost.
 */
export const envelopeTokens = (value: unknown): number =>
  Math.ceil(JSON.stringify(value ?? null).length / 4);

/** M166's measured provider rate, for reporting what the model is billed. */
export const PROVIDER_TOKENS_PER_CHARACTER = 0.3174032272551657;
export const billedTokens = (value: unknown): number =>
  Math.max(0, Math.round(JSON.stringify(value ?? null).length * PROVIDER_TOKENS_PER_CHARACTER));

/**
 * `responseBudget` is compaction OUTPUT, not input. A snapshot that still carries
 * one would let a measurement read a previous pass's answer back to itself.
 */
export function stripBudget(value: unknown): JsonRecord {
  const draft = structuredClone(value) as JsonRecord;
  delete draft.responseBudget;
  return draft;
}

export interface CompactionOutcome {
  readonly reachable: boolean;
  readonly response: JsonRecord | null;
  /** Any error that is NOT the envelope-unreachable condition. */
  readonly unexpectedError: string | null;
}

/**
 * Compact, distinguishing the three outcomes that matter: a response, the
 * envelope-unreachable product condition, and an unexpected implementation
 * failure. The third is never folded into the second — §23 requires that a real
 * bug keeps failing as a bug.
 */
export function compactOutcome(
  response: unknown,
  requestedContextTokens: number,
  detail: McpResponseDetail = McpResponseDetail.Standard,
): CompactionOutcome {
  try {
    const compacted = compactProductResponse(stripBudget(response), {
      requestedContextTokens,
      detail,
    }) as unknown as JsonRecord;
    return { reachable: true, response: compacted, unexpectedError: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message === UNREACHABLE_MESSAGE) {
      return { reachable: false, response: null, unexpectedError: null };
    }
    return { reachable: false, response: null, unexpectedError: message };
  }
}

/** Above any budget a caller can plausibly request; used as the search ceiling. */
export const FLOOR_SEARCH_LIMIT = 1_000_000;

/**
 * The smallest `requestedContextTokens` at which this response still terminates.
 * `Infinity` when no budget in the search range does.
 *
 * Monotonicity is what makes the binary search sound: every rung of the ladder is
 * gated on `withinBudget()`, so a larger budget applies a subset of the rungs a
 * smaller one applies and can never turn a deliverable response into an
 * undeliverable one. §48 tests that property rather than assuming it.
 */
export function envelopeFloorTokens(
  response: unknown,
  detail: McpResponseDetail = McpResponseDetail.Standard,
): number {
  const reachableAt = (tokens: number): boolean => compactOutcome(response, tokens, detail).reachable;
  if (!reachableAt(FLOOR_SEARCH_LIMIT)) return Infinity;
  let low = 0;
  let high = FLOOR_SEARCH_LIMIT;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (reachableAt(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * The irreducible residue: serialized size of each top-level section of the
 * response as it stands AT its own floor, where the whole ladder has run.
 */
export function residualSections(
  response: unknown,
  detail: McpResponseDetail = McpResponseDetail.Standard,
): { readonly floorTokens: number; readonly sections: Readonly<Record<string, number>>; readonly totalCharacters: number } {
  const floorTokens = envelopeFloorTokens(response, detail);
  if (!Number.isFinite(floorTokens)) {
    return { floorTokens, sections: {}, totalCharacters: 0 };
  }
  const outcome = compactOutcome(response, floorTokens, detail);
  const compacted = outcome.response ?? {};
  const sections: Record<string, number> = {};
  for (const [key, value] of Object.entries(compacted)) {
    sections[key] = JSON.stringify(value ?? null).length;
  }
  return {
    floorTokens,
    sections,
    totalCharacters: JSON.stringify(compacted).length,
  };
}

/** Headroom in estimator tokens between a response's floor and its ceiling. */
export function floorHeadroomTokens(response: unknown, requestedContextTokens: number): number {
  const floor = envelopeFloorTokens(response);
  if (!Number.isFinite(floor)) return -Infinity;
  const outcome = compactOutcome(response, floor);
  const budget = isRecord(outcome.response?.responseBudget) ? outcome.response!.responseBudget : {};
  const total = typeof budget.estimated_total_response_tokens === "number"
    ? budget.estimated_total_response_tokens
    : 0;
  return responseTokenCeiling(requestedContextTokens) - total;
}

// ── field injection, for the §12 contributor classification ──

export const filler = (characters: number, seed: string): string => {
  if (characters <= 0) return "";
  const unit = `${seed} `;
  return unit.repeat(Math.ceil(characters / unit.length)).slice(0, characters);
};

/**
 * Write `value` at a dotted path, creating intermediate records. `a.b[]` appends
 * to an array at `a.b`, so a contributor that scales with a COUNT (workspace
 * members, warnings) can be grown the way the product would grow it.
 */
export function setPath(draft: JsonRecord, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cursor: JsonRecord = draft;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index]!;
    if (!isRecord(cursor[key])) cursor[key] = {};
    cursor = cursor[key] as JsonRecord;
  }
  const last = parts[parts.length - 1]!;
  if (last.endsWith("[]")) {
    const key = last.slice(0, -2);
    const existing = Array.isArray(cursor[key]) ? (cursor[key] as unknown[]) : [];
    cursor[key] = [...existing, value];
    return;
  }
  cursor[last] = value;
}

/**
 * How a response's floor responds to growth in one field.
 *
 * The classification is measured, not asserted. A field whose floor stops growing
 * has a rung that bounds it; a field whose floor tracks the injected size does
 * not, and can carry any response over any ceiling.
 */
export enum ContributorBound {
  /** The floor does not move at all. The field is not in the response, or is replaced wholesale. */
  Constant = "CONSTANT",
  /** The floor grows and then stops: some rung caps this field. */
  ProductBounded = "PRODUCT_BOUNDED",
  /** The floor tracks the injected size without limit. */
  PotentiallyUnbounded = "POTENTIALLY_UNBOUNDED",
}

export interface ContributorMeasurement {
  readonly field: string;
  readonly supplier: "caller" | "repository" | "product" | "derived";
  readonly injectedCharacters: readonly number[];
  readonly floorTokens: readonly number[];
  readonly bound: ContributorBound;
  readonly floorGrowthPerInjectedToken: number;
  /**
   * How much content in this ONE field takes an otherwise ordinary response past
   * the DEFAULT budget's ceiling — the point at which growing it alone is enough
   * to make the tool throw for a caller who asked for nothing unusual. Null when
   * no size within the search range does.
   */
  readonly charactersToExceedDefaultCeiling: number | null;
  readonly note: string;
}

/** What a Stage 5 / Claude Code call actually requests, and its resulting ceiling. */
export const DEFAULT_REQUESTED_CONTEXT_TOKENS = 8_000;

/**
 * Grow one field across the sweep and read the floor at each size.
 *
 * `growth` is the marginal floor increase per injected estimator token across the
 * LARGEST step, which is where a cap has had every chance to bind. Near 1.0 means
 * the field is paid for in full at any size; near 0.0 means a rung ate it.
 */
export function measureContributor(
  base: unknown,
  options: {
    readonly field: string;
    readonly supplier: ContributorMeasurement["supplier"];
    readonly sizes?: readonly number[];
    readonly seed?: string;
    /** Build the injected value; defaults to filler text. */
    readonly build?: (characters: number) => unknown;
    readonly note?: string;
  },
): ContributorMeasurement {
  const sizes = options.sizes ?? [0, 2_000, 20_000, 200_000];
  const build = options.build ?? ((characters: number) => filler(characters, options.seed ?? "irreducible metadata"));
  const floors: number[] = [];
  for (const size of sizes) {
    const draft = stripBudget(base);
    if (size > 0) setPath(draft, options.field, build(size));
    floors.push(envelopeFloorTokens(draft));
  }

  const lastIndex = sizes.length - 1;
  const injectedDelta = (sizes[lastIndex]! - sizes[lastIndex - 1]!) / 4;
  const floorDelta = floors[lastIndex]! - floors[lastIndex - 1]!;
  const growth = injectedDelta === 0 ? 0 : floorDelta / injectedDelta;

  const bound = floors.every((value) => value === floors[0])
    ? ContributorBound.Constant
    : growth > 0.5
      ? ContributorBound.PotentiallyUnbounded
      : ContributorBound.ProductBounded;

  // The reachability threshold, searched only where growth actually occurs.
  // Monotone in the injected size, so a binary search is exact.
  const floorAt = (characters: number): number => {
    const draft = stripBudget(base);
    if (characters > 0) setPath(draft, options.field, build(characters));
    return envelopeFloorTokens(draft);
  };
  let threshold: number | null = null;
  if (bound === ContributorBound.PotentiallyUnbounded) {
    const limit = 4_000_000;
    if (floorAt(limit) > DEFAULT_REQUESTED_CONTEXT_TOKENS) {
      let low = 0;
      let high = limit;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (floorAt(middle) > DEFAULT_REQUESTED_CONTEXT_TOKENS) high = middle;
        else low = middle + 1;
      }
      threshold = low;
    }
  }

  return {
    field: options.field,
    supplier: options.supplier,
    injectedCharacters: sizes,
    floorTokens: floors,
    bound,
    floorGrowthPerInjectedToken: Number(growth.toFixed(4)),
    charactersToExceedDefaultCeiling: threshold,
    note: options.note ?? "",
  };
}
