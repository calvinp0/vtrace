/**
 * M177 — measuring `get_impact_graph`'s response-envelope terminal states.
 *
 * THE DEFECT, IN ONE SENTENCE. `compactImpactProductResponse` runs a degradation
 * ladder over an impact result the engine has ALREADY computed and, when the
 * ladder is exhausted and the response still will not fit, throws
 * `impact_response_envelope_unreachable` — which the MCP server turns into
 * `handler_failed`, so a predictable product-pressure condition reaches the
 * caller as a transport fault rather than a bounded truthful answer. Same defect
 * class as the `run_pipeline` envelope M176 repaired, in a separate
 * implementation with a separate output contract.
 *
 * THE INSTRUMENT, INHERITED FROM M176. Everything here is derived from one
 * observable: the smallest `max_tokens` at which a given authoritative impact
 * result still terminates. Call it the ENVELOPE FLOOR.
 *
 *   floor <= max_tokens   the response is deliverable
 *   floor >  max_tokens   the ladder is exhausted and the tool throws
 *
 * WHY THE FLOOR. M175-B established that RAISING THE CEILING TO SEE INSIDE
 * CHANGES WHAT IS SELECTED, so a residue read at a comfortable budget is not the
 * residue that failed at a tight one. At exactly the floor every rung has fired,
 * including the last-resort `bounded_degradation`, and the irreducible residue is
 * readable on a specimen that was never given a different budget in order to be
 * observed.
 *
 * WHY THE RESIDUE IS CONSTANT BELOW THE FLOOR. Every rung of the ladder is
 * guarded by `!fits()`, and `fits()` is monotone in the requested budget, so at
 * ANY budget below the floor every rung fires and the terminal draft is identical
 * apart from the `responseBudget` block that reports the budget back. That is why
 * one floor measurement characterises the whole failing range, and it is asserted
 * rather than assumed by `residueIsConstantBelowFloor` below.
 *
 * ONE PLACE THIS DIFFERS FROM `run_pipeline`, AND IT MATTERS FOR IDENTITY.
 * `max_tokens` is not purely a response bound here: `getImpactGraph` itself spends
 * it at `getImpactGraph.ts:705` (`takePathsWithinTokenBudget`), so the
 * AUTHORITATIVE result is already a function of the budget in its `paths`
 * dimension. Authoritative identity is therefore only ever compared at EQUAL
 * budget — never across the ladder — and `authoritativeIdentity` deliberately
 * hashes the pre-envelope engine output rather than anything the envelope built.
 *
 * PURE. No agent, no Docker, no paid API, no randomness. The only clock readings
 * are `timing`/`accounting.latencyMs`, which every identity function here strips.
 */

import { createHash } from "node:crypto";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { getImpactGraph, type ImpactFormat, type ImpactGraphOutput } from "../../src/impact/getImpactGraph";
import {
  compactImpactProductResponse,
  impactResponseTokenCeiling,
  type ImpactProductResponse,
  type ImpactResponseBudget,
} from "../../src/impact/impactResponseEnvelope";
import { buildContextAccounting, impactGraphOutputFilePathGroups } from "../../src/metrics/contextAccounting";

/** The message the product throws when the impact ladder is exhausted. */
export const IMPACT_UNREACHABLE_MESSAGE = "impact_response_envelope_unreachable";

/** The tool's own defaults, so a harness request is the request an agent makes. */
export const IMPACT_DEFAULT_MAX_TOKENS = 1200;
export const IMPACT_DEFAULT_DEPTH = 5;
export const IMPACT_DEFAULT_FORMAT: ImpactFormat = "tree";

export interface ImpactRequest {
  readonly symbolFqn: string;
  readonly maxTokens: number;
  readonly depth?: number;
  readonly format?: ImpactFormat;
  readonly maxEdges?: number;
  readonly maxPaths?: number;
}

/**
 * The envelope measures itself with chars/4 (`estimate_method: "chars_div_4"`),
 * so any arithmetic about its ceiling must use chars/4 too. M166's measured
 * provider rate is a different question and is not used for gate arithmetic.
 */
export const envelopeTokens = (value: unknown): number =>
  Math.ceil(JSON.stringify(value ?? null).length / 4);

export const PROVIDER_TOKENS_PER_CHARACTER = 0.3174032272551657;
export const billedTokens = (value: unknown): number =>
  Math.max(0, Math.round(JSON.stringify(value ?? null).length * PROVIDER_TOKENS_PER_CHARACTER));

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Stable serialization with object keys sorted, so an identity hash reports a
 * change in CONTENT and never a change in property insertion order.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = canonicalize(record[key]);
  return sorted;
}

/**
 * Fields whose value is a clock reading. They are stripped from every identity
 * hash: a milestone that let latency into an identity comparison would report
 * drift on every second run and prove nothing on any of them.
 */
const CLOCK_DERIVED_KEYS = new Set(["timing", "accounting"]);

export function authoritativeIdentity(output: ImpactGraphOutput): string {
  const record = { ...output } as Record<string, unknown>;
  for (const key of CLOCK_DERIVED_KEYS) delete record[key];
  return sha256(JSON.stringify(canonicalize(record)));
}

/**
 * Identity of a DELIVERED response. `responseBudget` is included — it is part of
 * what the caller receives and a change in it is a real change — but the clock
 * fields are not.
 */
export function responseIdentity(response: ImpactProductResponse): string {
  const record = { ...response } as Record<string, unknown>;
  for (const key of CLOCK_DERIVED_KEYS) delete record[key];
  return sha256(JSON.stringify(canonicalize(record)));
}

export interface AuthoritativeResult {
  readonly ok: boolean;
  readonly output: ImpactGraphOutput | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly identity: string | null;
}

/**
 * Run the engine exactly as `tools.ts` does, including the best-effort accounting
 * block, and stop before the envelope. This is the AUTHORITATIVE impact result:
 * everything M177 must leave untouched.
 */
export async function authoritativeImpact(
  db: ReturnType<typeof openIndexerDatabase>,
  repoRoot: string,
  request: ImpactRequest,
): Promise<AuthoritativeResult> {
  const startedAt = performance.now();
  const result = getImpactGraph(db, {
    symbolFqn: request.symbolFqn,
    depth: request.depth ?? IMPACT_DEFAULT_DEPTH,
    format: request.format ?? IMPACT_DEFAULT_FORMAT,
    maxTokens: request.maxTokens,
    ...(request.maxEdges === undefined ? {} : { maxEdges: request.maxEdges }),
    ...(request.maxPaths === undefined ? {} : { maxPaths: request.maxPaths }),
  }, { repoRoot, measureTiming: true });

  // `in` rather than `!result.ok`: the benchmarks project compiles with
  // `strict: false`, where the `ok` literal types widen and the discriminated
  // union stops narrowing.
  if ("error" in result) {
    return {
      ok: false,
      output: null,
      errorCode: result.error.code ?? null,
      errorMessage: result.error.message ?? null,
      identity: null,
    };
  }

  let accounting;
  try {
    accounting = await buildContextAccounting({
      repoRoot,
      emittedValue: result.output,
      filePathGroups: impactGraphOutputFilePathGroups(result.output),
      latencyMs: performance.now() - startedAt,
    });
  } catch {
    accounting = undefined;
  }
  const output = (accounting === undefined
    ? result.output
    : { ...result.output, accounting }) as ImpactGraphOutput;

  return { ok: true, output, errorCode: null, errorMessage: null, identity: authoritativeIdentity(output) };
}

export interface EnvelopeOutcome {
  /** The envelope produced a response — before the repair, or after it. */
  readonly reachable: boolean;
  readonly response: ImpactProductResponse | null;
  readonly budget: ImpactResponseBudget | null;
  /** Set only for the known envelope-unreachable condition. */
  readonly unreachable: boolean;
  /** Any error that is NOT the envelope-unreachable condition — a real fault. */
  readonly unexpectedError: string | null;
}

/**
 * Run the real product envelope over an authoritative result.
 *
 * The unreachable condition is separated from every other throw on purpose. A
 * harness that swallowed both would report a genuine implementation fault as the
 * defect under study and then report it repaired.
 */
export function runImpactEnvelope(output: ImpactGraphOutput): EnvelopeOutcome {
  try {
    const response = compactImpactProductResponse(output);
    return { reachable: true, response, budget: response.responseBudget, unreachable: false, unexpectedError: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === IMPACT_UNREACHABLE_MESSAGE) {
      return { reachable: false, response: null, budget: null, unreachable: true, unexpectedError: null };
    }
    return { reachable: false, response: null, budget: null, unreachable: false, unexpectedError: message };
  }
}

export interface LadderRung {
  readonly maxTokens: number;
  readonly totalCeiling: number;
  readonly authoritativeOk: boolean;
  readonly authoritativeIdentity: string | null;
  readonly reachable: boolean;
  readonly unreachable: boolean;
  readonly unexpectedError: string | null;
  readonly responseIdentity: string | null;
  readonly budget: ImpactResponseBudget | null;
  readonly serializedCharacters: number | null;
  readonly modelVisibleEstimatedTokens: number | null;
  readonly billedTokensOfResponse: number | null;
}

export async function runLadder(
  db: ReturnType<typeof openIndexerDatabase>,
  repoRoot: string,
  symbolFqn: string,
  budgets: readonly number[],
  overrides: Omit<ImpactRequest, "symbolFqn" | "maxTokens"> = {},
): Promise<readonly LadderRung[]> {
  const rungs: LadderRung[] = [];
  for (const maxTokens of budgets) {
    const authoritative = await authoritativeImpact(db, repoRoot, { symbolFqn, maxTokens, ...overrides });
    if (!authoritative.ok || authoritative.output === null) {
      rungs.push({
        maxTokens,
        totalCeiling: impactResponseTokenCeiling(maxTokens),
        authoritativeOk: false,
        authoritativeIdentity: null,
        reachable: false,
        unreachable: false,
        unexpectedError: `engine:${authoritative.errorCode ?? "unknown"}`,
        responseIdentity: null,
        budget: null,
        serializedCharacters: null,
        modelVisibleEstimatedTokens: null,
        billedTokensOfResponse: null,
      });
      continue;
    }
    const outcome = runImpactEnvelope(authoritative.output);
    rungs.push({
      maxTokens,
      totalCeiling: impactResponseTokenCeiling(maxTokens),
      authoritativeOk: true,
      authoritativeIdentity: authoritative.identity,
      reachable: outcome.reachable,
      unreachable: outcome.unreachable,
      unexpectedError: outcome.unexpectedError,
      responseIdentity: outcome.response === null ? null : responseIdentity(outcome.response),
      budget: outcome.budget,
      serializedCharacters: outcome.budget?.serializedCharacters ?? null,
      modelVisibleEstimatedTokens: outcome.budget?.modelVisibleEstimatedTokens ?? null,
      billedTokensOfResponse: outcome.response === null ? null : billedTokens(outcome.response),
    });
  }
  return rungs;
}

export interface EnvelopeFloor {
  /** Smallest `max_tokens` at which the PRE-REPAIR envelope still terminates. */
  readonly floor: number | null;
  /** Largest probed `max_tokens` that did not terminate. */
  readonly largestFailing: number | null;
  readonly probes: number;
  readonly searchedRange: readonly [number, number];
  /** True when even the upper bound failed: the floor is above the range. */
  readonly aboveRange: boolean;
}

/**
 * Binary search for the envelope floor.
 *
 * `fits()` is monotone in the requested budget — every rung is guarded by
 * `!fits()` and a larger budget can only make `fits()` truer — so a binary search
 * is sound here even though M176 measured the DELIVERY packer to be non-monotone
 * one layer up. Those are different functions; this one is the envelope's own
 * gate and its monotonicity is a property of the code above, not an assumption
 * about the corpus.
 */
export async function findEnvelopeFloor(
  db: ReturnType<typeof openIndexerDatabase>,
  repoRoot: string,
  symbolFqn: string,
  low: number,
  high: number,
  overrides: Omit<ImpactRequest, "symbolFqn" | "maxTokens"> = {},
): Promise<EnvelopeFloor> {
  let probes = 0;
  const terminates = async (maxTokens: number): Promise<boolean> => {
    probes += 1;
    const authoritative = await authoritativeImpact(db, repoRoot, { symbolFqn, maxTokens, ...overrides });
    if (!authoritative.ok || authoritative.output === null) return false;
    return runImpactEnvelope(authoritative.output).reachable;
  };

  if (!await terminates(high)) {
    return { floor: null, largestFailing: high, probes, searchedRange: [low, high], aboveRange: true };
  }
  if (await terminates(low)) {
    return { floor: low, largestFailing: null, probes, searchedRange: [low, high], aboveRange: false };
  }

  let failing = low;
  let passing = high;
  while (passing - failing > 1) {
    const middle = Math.floor((failing + passing) / 2);
    if (await terminates(middle)) passing = middle;
    else failing = middle;
  }
  return { floor: passing, largestFailing: failing, probes, searchedRange: [low, high], aboveRange: false };
}

/**
 * Assert the claim the floor instrument rests on: below the floor, the terminal
 * draft does not depend on the budget.
 *
 * Two blocks are removed before comparing, and neither is a concession. `limits`
 * is the REQUEST echoed back — `limits.maxTokens` is the budget itself, so it
 * differs across the ladder by definition. `responseBudget` REPORTS the budget,
 * and its `serializedCharacters` measures a draft that still contains `timing`,
 * whose full-precision floats vary in decimal length between runs. Everything
 * else — every fact about the repository and every claim about delivery — must
 * be identical, and the first draft of this check failed only because it
 * compared these two blocks as if they were content.
 */
export function residueIsConstantBelowFloor(
  responses: readonly (ImpactProductResponse | null)[],
): { readonly constant: boolean; readonly identities: readonly string[] } {
  const identities = responses.map((response) => {
    if (response === null) return "null";
    const record = { ...response } as Record<string, unknown>;
    for (const key of CLOCK_DERIVED_KEYS) delete record[key];
    delete record.responseBudget;
    delete record.limits;
    return sha256(JSON.stringify(canonicalize(record)));
  });
  return { constant: new Set(identities).size === 1, identities };
}

export function openWorkspace(repoRoot: string): ReturnType<typeof openIndexerDatabase> {
  return openIndexerDatabase(`${repoRoot}/.vtrace/index.sqlite`);
}
