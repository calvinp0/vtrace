/**
 * M164-D — the evidence-delivery state machine and the gate that depends on it.
 *
 * Pure. M163's classifiers (`m163Analysis.ts`) answer "was this evidence any
 * good, and what did the agent do with it". They are reused unchanged. What is
 * new here is the thing that must run FIRST, and which M163 discovered it needed
 * only after publishing labels it had to retract:
 *
 *   A tool call that was refused is not a tool call that returned nothing.
 *
 * With an empty result set, "ignored what it returned" and "edited somewhere it
 * did not name" are true by construction. They fired on 12 and 8 M163 runs and
 * described the emptiness, not the agent. So every downstream label is gated on
 * `evidenceDelivered`, and refusal text is counted in its own column and never
 * added to a repository-evidence total.
 */

/**
 * Exactly one of these describes a triggered run's first VTRACE call.
 *
 * `TRIGGER_NOT_COMPLIED` sits in the same enum on purpose. "The agent never
 * called" and "the agent called and was refused" are both outcomes the trigger
 * arm exists to be able to produce, and keeping them in one closed set is what
 * stops a missing call from silently becoming a zero somewhere.
 */
export type FirstCallStatus =
  | "TRIGGER_NOT_COMPLIED"
  | "CALL_NOT_MADE"
  | "TOOLS_UNAVAILABLE"
  | "INVALID_REQUEST"
  | "REPO_NOT_READY"
  | "TOOL_ERROR"
  | "VALID_EMPTY"
  | "VALID_NONEMPTY";

export interface FirstCallClassification {
  readonly status: FirstCallStatus;
  /** True for VALID_NONEMPTY alone. Never true for a refusal, however verbose. */
  readonly evidenceDelivered: boolean;
  /** Characters of returned repository evidence. Zero unless delivered. */
  readonly evidenceCharacters: number;
  /** Characters of refusal or error text. Never enters an evidence total. */
  readonly refusalCharacters: number;
  readonly returnedPaths: readonly string[];
  readonly detail: string;
}

const SOURCE_PATH = /(?:^|[\s"'`(\[])((?:[\w.\-]+\/)+[\w.\-]+\.(?:py|ts|tsx|js|jsx|rs|go|java|rb|c|cc|cpp|h|hpp))/gm;

/** Distinct source paths named by a tool result. */
export function extractReturnedPaths(text: string): string[] {
  return [...new Set([...text.matchAll(SOURCE_PATH)].map((match) => match[1]!))];
}

export interface FirstCallInput {
  /** Was the trigger present in this arm's prompt? */
  readonly triggerServed: boolean;
  /** Did the run's own init event show the tools connected and permitted? */
  readonly toolsAvailable: boolean;
  /** Did the agent make any VTRACE call at all? */
  readonly callMade: boolean;
  /** The raw first-call response payload, as captured. */
  readonly rawOutput: unknown;
}

/**
 * Classify a triggered run's first VTRACE call.
 *
 * Order matters and is not arbitrary. Availability is checked before compliance
 * because an agent cannot ignore a tool it was never offered; compliance before
 * the response tiers because a call that was never made has no response to read;
 * and refusal before emptiness because that is the exact conflation M163 made.
 */
export function classifyFirstCall(input: FirstCallInput): FirstCallClassification {
  const empty = { evidenceCharacters: 0, returnedPaths: [] as string[] };

  if (!input.toolsAvailable) {
    return { status: "TOOLS_UNAVAILABLE", evidenceDelivered: false, refusalCharacters: 0, detail: "the run's init event did not show the tools connected", ...empty };
  }
  if (!input.callMade) {
    return {
      status: input.triggerServed ? "TRIGGER_NOT_COMPLIED" : "CALL_NOT_MADE",
      evidenceDelivered: false,
      refusalCharacters: 0,
      detail: input.triggerServed
        ? "tools were available and the trigger reached the run; the agent did not call"
        : "no trigger was served and the agent did not call",
      ...empty,
    };
  }

  const text = typeof input.rawOutput === "string" ? input.rawOutput : JSON.stringify(input.rawOutput ?? "");

  let parsed: Record<string, any> | null = null;
  try { parsed = JSON.parse(text) as Record<string, any>; } catch { parsed = null; }

  const code = parsed?.["code"];
  const message = typeof parsed?.["message"] === "string" ? parsed["message"] : "";
  const output = (parsed?.["result"]?.output ?? parsed?.["output"] ?? {}) as Record<string, any>;
  const reason = typeof output["reason"] === "string" ? output["reason"] : null;

  if (code === "invalid_request" || /non-empty string query/i.test(message)) {
    return { status: "INVALID_REQUEST", evidenceDelivered: false, refusalCharacters: text.length, detail: message || "invalid_request", ...empty };
  }
  // The product reached and declined. Never re-read as empty retrieval.
  if (reason === "repo_not_ready" || output["resolved"] === false || /repo_not_ready|is not ready|not initialized/i.test(text)) {
    return { status: "REPO_NOT_READY", evidenceDelivered: false, refusalCharacters: text.length, detail: reason ?? "product declined", ...empty };
  }
  if (code !== undefined && code !== "ok") {
    return { status: "TOOL_ERROR", evidenceDelivered: false, refusalCharacters: text.length, detail: String(code), ...empty };
  }

  const returnedPaths = extractReturnedPaths(text);
  if (returnedPaths.length === 0) {
    // A truthful empty answer: the product ran retrieval and found nothing.
    return { status: "VALID_EMPTY", evidenceDelivered: false, refusalCharacters: 0, detail: "retrieval ran and named no source location", ...empty };
  }
  return {
    status: "VALID_NONEMPTY",
    evidenceDelivered: true,
    evidenceCharacters: text.length,
    refusalCharacters: 0,
    returnedPaths,
    detail: `${returnedPaths.length} distinct source paths returned`,
  };
}

/**
 * The gate every quality and reaction label must pass.
 *
 * M163's permanent correction. `USED_AS_ORIENTATION`, `IGNORED`,
 * `DISAGREED_AND_RECOVERED`, `ANCHORED_INCORRECTLY`, evidence quality and
 * gold-relation diagnostics are all statements about content. Without content
 * they are statements about nothing, and they will happily produce one.
 */
export function analyzerEligible(classification: FirstCallClassification): boolean {
  return classification.evidenceDelivered;
}

export interface PairedDelta {
  readonly instanceId: string;
  readonly metric: string;
  readonly neutral: number | null;
  readonly trigger: number | null;
  readonly delta: number | null;
}

/** TRIGGER - NEUTRAL for one metric on one task. Null-safe: a missing arm yields null, never zero. */
export function pairedDelta(
  instanceId: string,
  metric: string,
  neutral: number | null,
  trigger: number | null,
): PairedDelta {
  return {
    instanceId,
    metric,
    neutral,
    trigger,
    delta: neutral === null || trigger === null ? null : trigger - neutral,
  };
}

export interface DeltaSummary {
  readonly metric: string;
  /** Pairs where BOTH arms produced a value. The only denominator a delta may use. */
  readonly pairs: number;
  readonly meanDelta: number | null;
  readonly medianDelta: number | null;
  readonly triggerHigher: number;
  readonly neutralHigher: number;
  readonly tied: number;
}

export function summarizeDeltas(metric: string, deltas: readonly PairedDelta[]): DeltaSummary {
  const usable = deltas.filter((d) => d.delta !== null).map((d) => d.delta!);
  const sorted = [...usable].sort((left, right) => left - right);
  const median = sorted.length === 0
    ? null
    : sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]!
      : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  return {
    metric,
    pairs: usable.length,
    meanDelta: usable.length === 0 ? null : usable.reduce((total, value) => total + value, 0) / usable.length,
    medianDelta: median,
    triggerHigher: usable.filter((value) => value > 0).length,
    neutralHigher: usable.filter((value) => value < 0).length,
    tied: usable.filter((value) => value === 0).length,
  };
}

export type SolveCell = "SHARED_SUCCESS" | "TRIGGER_UNIQUE_WIN" | "NEUTRAL_UNIQUE_WIN" | "SHARED_FAILURE" | "INCOMPLETE";

export function classifySolve(neutralResolved: boolean | null, triggerResolved: boolean | null): SolveCell {
  if (neutralResolved === null || triggerResolved === null) return "INCOMPLETE";
  if (neutralResolved && triggerResolved) return "SHARED_SUCCESS";
  if (triggerResolved && !neutralResolved) return "TRIGGER_UNIQUE_WIN";
  if (neutralResolved && !triggerResolved) return "NEUTRAL_UNIQUE_WIN";
  return "SHARED_FAILURE";
}

/**
 * Required versus voluntary calls.
 *
 * The distinction carries the strongest interaction signal M164 can produce: an
 * agent that goes back to VTRACE after seeing one answer chose to, and no policy
 * made it. An error retry is not that, which is why it is subtracted here rather
 * than left for the reader to notice.
 */
export interface CallSplit {
  readonly required: number;
  readonly voluntaryFollowup: number;
  readonly errorRetries: number;
}

export function splitCalls(statuses: readonly FirstCallStatus[]): CallSplit {
  if (statuses.length === 0) return { required: 0, voluntaryFollowup: 0, errorRetries: 0 };
  const [, ...rest] = statuses;
  const errorRetries = rest.filter((status) => status === "INVALID_REQUEST" || status === "TOOL_ERROR").length;
  return { required: 1, voluntaryFollowup: rest.length - errorRetries, errorRetries };
}
