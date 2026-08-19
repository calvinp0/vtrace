/**
 * M162-D/E — three-arm architecture analysis (pure).
 *
 * The classification rules below decide what the pilot MEANS, so they are kept
 * separate from the IO that loads runs and are unit-tested. The distinctions
 * they preserve are the ones M161 and M155 got wrong in opposite directions:
 * a tool that was never offered is not a tool that was declined, and an arm
 * that returned nothing is not an arm that failed.
 */

export type Arm = "baseline" | "static" | "callable";

export interface ArmOutcome {
  readonly arm: Arm;
  readonly instanceId: string;
  readonly resolved: boolean | null;
  readonly costUsd: number | null;
  readonly numTurns: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly durationMs: number | null;
  readonly ordinarySearches: number;
  readonly fileReads: number;
  readonly edits: number;
  readonly totalOrdinaryToolCalls: number;
  readonly vtraceCalls: number;
  readonly firstEditPosition: number | null;
  /** STATIC only: the injected capsule's estimated tokens. */
  readonly staticCapsuleTokens: number | null;
  /** CALLABLE only: were the tools actually connected and visible? */
  readonly toolsAvailable: boolean | null;
  readonly indexBuildMs: number | null;
}

/**
 * How the three arms landed on one task.
 *
 * `CALLABLE_ONLY_WIN` is the pattern that would most directly support the
 * ambitious thesis, and it is deliberately given no special weight here — it is
 * one label among several, and every discordant task is inspected regardless.
 */
export type DiscordancePattern =
  | "ALL_SUCCESS"
  | "ALL_FAIL"
  | "CALLABLE_ONLY_WIN"
  | "STATIC_ONLY_WIN"
  | "BASELINE_ONLY_WIN"
  | "VTRACE_BOTH_WIN"
  | "CALLABLE_ONLY_LOSS"
  | "STATIC_ONLY_LOSS"
  | "BASELINE_ONLY_LOSS"
  | "MIXED"
  | "INCOMPLETE";

export function classifyDiscordance(
  baseline: boolean | null,
  staticArm: boolean | null,
  callable: boolean | null,
): DiscordancePattern {
  if (baseline === null || staticArm === null || callable === null) return "INCOMPLETE";
  const wins = [baseline, staticArm, callable].filter(Boolean).length;
  if (wins === 3) return "ALL_SUCCESS";
  if (wins === 0) return "ALL_FAIL";
  if (callable && !baseline && !staticArm) return "CALLABLE_ONLY_WIN";
  if (staticArm && !baseline && !callable) return "STATIC_ONLY_WIN";
  if (baseline && !staticArm && !callable) return "BASELINE_ONLY_WIN";
  if (!callable && baseline && staticArm) return "CALLABLE_ONLY_LOSS";
  if (!staticArm && baseline && callable) return "STATIC_ONLY_LOSS";
  if (!baseline && staticArm && callable) return "VTRACE_BOTH_WIN";
  return "MIXED";
}

/**
 * What the CALLABLE agent actually did with the affordance.
 *
 * The five states exist because "callable architecture failed" is a conclusion
 * that could be reached from at least four different underlying facts, and
 * collapsing them would make the verdict unactionable.
 */
export type CallableBehaviour =
  | "TOOLS_UNAVAILABLE"
  | "AVAILABLE_UNUSED"
  | "USED_EFFECTIVELY"
  | "USED_REDUNDANTLY"
  | "USED_HARMFULLY"
  | "USED_LATE_ADAPTIVE";

export interface CallableBehaviourInput {
  readonly toolsAvailable: boolean | null;
  readonly vtraceCalls: number;
  readonly resultUsedCount: number;
  readonly redundantLookupCount: number;
  readonly callsAfterFirstEdit: number;
  readonly resolved: boolean | null;
  readonly baselineResolved: boolean | null;
  readonly staticResolved: boolean | null;
}

export function classifyCallableBehaviour(input: CallableBehaviourInput): CallableBehaviour {
  if (input.toolsAvailable === false) return "TOOLS_UNAVAILABLE";
  if (input.vtraceCalls === 0) return "AVAILABLE_UNUSED";

  // Unique harm: this arm alone failed a task both others solved, having used
  // the tools. Checked before the positive labels so a harmful run is never
  // reported as an effective one.
  if (input.resolved === false && input.baselineResolved === true && input.staticResolved === true) {
    return "USED_HARMFULLY";
  }

  // Adaptation the static arm structurally cannot do: a query issued after the
  // agent had already started editing, i.e. after its understanding changed.
  if (input.callsAfterFirstEdit > 0 && input.resultUsedCount > 0) return "USED_LATE_ADAPTIVE";

  if (input.redundantLookupCount > 0 && input.resultUsedCount === 0) return "USED_REDUNDANTLY";
  if (input.resultUsedCount > 0) return "USED_EFFECTIVELY";
  return "USED_REDUNDANTLY";
}

export function median(values: readonly number[]): number | null {
  const present = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (present.length === 0) return null;
  const middle = Math.floor(present.length / 2);
  return present.length % 2 === 1
    ? present[middle]!
    : (present[middle - 1]! + present[middle]!) / 2;
}

export interface VtraceExposure {
  readonly fixedTokens: number;
  readonly dynamicTokens: number;
  readonly totalTokens: number;
}

/**
 * Total VTRACE-specific context exposure per arm.
 *
 * STATIC's is entirely fixed and re-read every turn. CALLABLE's is a smaller
 * fixed part plus whatever it chose to fetch. Reporting only the fixed halves
 * would make CALLABLE look cheaper by construction, which is precisely the
 * claim the pilot must not assume.
 */
export function vtraceExposure(
  arm: Arm,
  options: {
    staticCapsuleTokens: number | null;
    schemaTokens: number;
    policyTokens: number;
    dynamicResultTokens: number;
  },
): VtraceExposure {
  if (arm === "baseline") return { fixedTokens: 0, dynamicTokens: 0, totalTokens: 0 };
  if (arm === "static") {
    const fixed = options.staticCapsuleTokens ?? 0;
    return { fixedTokens: fixed, dynamicTokens: 0, totalTokens: fixed };
  }
  const fixed = options.schemaTokens + options.policyTokens;
  return {
    fixedTokens: fixed,
    dynamicTokens: options.dynamicResultTokens,
    totalTokens: fixed + options.dynamicResultTokens,
  };
}
