/**
 * M168-E analysis — pure functions over captured run artifacts.
 *
 * The primary comparison is PAIRED (B vs C on the same task), so every
 * aggregate is computed over tasks that actually have both arms, and the
 * denominator travels with the number. `NOT_RUN != 0` is enforced by making
 * the pair set explicit rather than by filling gaps.
 */

export interface RunRecord {
  readonly label: string;
  readonly arm: "baseline" | "vtrace_strict" | "vtrace_clean";
  readonly instanceId: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly numTurns: number;
  readonly resolved: boolean | null;
  readonly toolCalls: readonly { tool: string; category: string; path: string | null }[];
  /** Hook decisions, empty for arms with no guard. */
  readonly guardEvents: readonly { decision: "deny" | "allow"; indexPresent: boolean }[];
  readonly patchEmpty: boolean;
}

export const totalTraffic = (r: RunRecord): number =>
  r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens;

const isSearch = (tool: string): boolean => tool === "Grep" || tool === "Glob";
const isPipeline = (tool: string): boolean => tool.endsWith("__run_pipeline");
const isEdit = (tool: string): boolean =>
  tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit";

export interface Behaviour {
  readonly searchAttempts: number;
  readonly reads: number;
  readonly filesOpened: number;
  readonly pipelineCalls: number;
  /** Calls beyond the mandated first one. */
  readonly pipelineReuse: number;
  readonly edits: number;
  readonly bashCalls: number;
  readonly totalToolCalls: number;
  /** Index of the first edit in the ordered call list, or null if never. */
  readonly firstEditAtCall: number | null;
  /** Tool calls made before the first edit — the investigation phase. */
  readonly callsBeforeFirstEdit: number;
  readonly firstActionWasPipeline: boolean | null;
  readonly guardDenials: number;
  readonly guardAllows: number;
  /**
   * Four distinct states, because "the guard did not deny anything" has three
   * very different causes and pooling them would be wrong in both directions:
   *
   *   GUARDED             the hook denied at least one real attempt
   *   GUARD_UNEXERCISED   the hook was armed but the agent never attempted a
   *                       search, so there was nothing to deny. The treatment
   *                       WAS in force; it simply was not needed. A valid
   *                       strict run.
   *   GUARD_DEGRADED      the hook ran and ALLOWED a search through (the
   *                       engine's index was missing) — the strict arm was
   *                       silently not strict. Reported, never pooled.
   *   GUARD_FAULT         searches were attempted but the hook never ran at
   *                       all. That is an apparatus failure, not an outcome.
   */
  readonly guardStatus: "GUARDED" | "GUARD_UNEXERCISED" | "GUARD_DEGRADED" | "GUARD_FAULT" | "NO_GUARD";
}

export function behaviour(r: RunRecord): Behaviour {
  const calls = r.toolCalls;
  const firstEditIndex = calls.findIndex((c) => isEdit(c.tool));
  const pipelineCalls = calls.filter((c) => isPipeline(c.tool)).length;
  const denials = r.guardEvents.filter((e) => e.decision === "deny").length;
  const allows = r.guardEvents.filter((e) => e.decision === "allow").length;

  const searchAttempts = calls.filter((c) => isSearch(c.tool)).length;
  const hookRan = r.guardEvents.length > 0;

  let guardStatus: Behaviour["guardStatus"];
  if (r.arm !== "vtrace_strict") guardStatus = "NO_GUARD";
  else if (denials > 0) guardStatus = "GUARDED";
  else if (allows > 0) guardStatus = "GUARD_DEGRADED";
  else if (searchAttempts === 0 && !hookRan) guardStatus = "GUARD_UNEXERCISED";
  else guardStatus = "GUARD_FAULT";

  return {
    searchAttempts,
    reads: calls.filter((c) => c.tool === "Read").length,
    filesOpened: new Set(calls.filter((c) => c.path !== null).map((c) => c.path!)).size,
    pipelineCalls,
    pipelineReuse: Math.max(0, pipelineCalls - 1),
    edits: calls.filter((c) => isEdit(c.tool)).length,
    bashCalls: calls.filter((c) => c.tool === "Bash").length,
    totalToolCalls: calls.length,
    firstEditAtCall: firstEditIndex < 0 ? null : firstEditIndex,
    callsBeforeFirstEdit: firstEditIndex < 0 ? calls.length : firstEditIndex,
    firstActionWasPipeline: calls.length === 0 ? null : isPipeline(calls[0]!.tool),
    guardDenials: denials,
    guardAllows: allows,
    guardStatus,
  };
}

// ── paired comparison ───────────────────────────────────────────────

export interface PairedDelta {
  readonly metric: string;
  readonly pairs: number;
  readonly leftMedian: number;
  readonly rightMedian: number;
  readonly medianPairedDelta: number;
  readonly meanPairedDelta: number;
  /** Tasks where left < right, left > right, and left == right. */
  readonly leftLower: number;
  readonly rightLower: number;
  readonly tied: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function pairedDelta(
  metric: string,
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): PairedDelta {
  const shared = [...left.keys()].filter((k) => right.has(k)).sort();
  const deltas = shared.map((k) => left.get(k)! - right.get(k)!);
  return {
    metric,
    pairs: shared.length,
    leftMedian: median(shared.map((k) => left.get(k)!)),
    rightMedian: median(shared.map((k) => right.get(k)!)),
    medianPairedDelta: median(deltas),
    meanPairedDelta: deltas.length === 0 ? 0 : deltas.reduce((a, b) => a + b, 0) / deltas.length,
    leftLower: deltas.filter((d) => d < 0).length,
    rightLower: deltas.filter((d) => d > 0).length,
    tied: deltas.filter((d) => d === 0).length,
  };
}

export interface OutcomeMatrix {
  readonly left: string;
  readonly right: string;
  readonly pairs: number;
  readonly sharedSuccess: number;
  readonly leftUniqueWin: number;
  readonly rightUniqueWin: number;
  readonly sharedFailure: number;
  /** Tasks where either side has no grade yet. Never counted as a failure. */
  readonly ungraded: number;
}

export function outcomeMatrix(
  leftName: string,
  rightName: string,
  left: ReadonlyMap<string, boolean | null>,
  right: ReadonlyMap<string, boolean | null>,
): OutcomeMatrix {
  const shared = [...left.keys()].filter((k) => right.has(k)).sort();
  let both = 0, l = 0, r = 0, neither = 0, ungraded = 0;
  for (const key of shared) {
    const a = left.get(key)!;
    const b = right.get(key)!;
    if (a === null || b === null) { ungraded++; continue; }
    if (a && b) both++;
    else if (a) l++;
    else if (b) r++;
    else neither++;
  }
  return {
    left: leftName,
    right: rightName,
    pairs: shared.length,
    sharedSuccess: both,
    leftUniqueWin: l,
    rightUniqueWin: r,
    sharedFailure: neither,
    ungraded,
  };
}

/**
 * The question the primary comparison exists to answer, stated as a check
 * rather than left to narrative: did coercion remove work, and did removing it
 * cost outcomes?
 */
export interface CoercionVerdict {
  readonly searchDelta: PairedDelta;
  readonly costDelta: PairedDelta;
  readonly trafficDelta: PairedDelta;
  readonly outcomes: OutcomeMatrix;
  readonly guardedRuns: number;
  readonly guardUnexercisedRuns: number;
  readonly guardDegradedRuns: number;
  readonly guardFaultRuns: number;
  readonly verdict:
    | "COERCION_REDUCES_WORK_WITHOUT_OUTCOME_COST"
    | "COERCION_REDUCES_WORK_AT_OUTCOME_COST"
    | "COERCION_NEUTRAL"
    | "COERCION_INCREASES_WORK"
    | "INCONCLUSIVE_GUARD_INACTIVE";
}

export function coercionVerdict(input: {
  searchDelta: PairedDelta;
  costDelta: PairedDelta;
  trafficDelta: PairedDelta;
  outcomes: OutcomeMatrix;
  guardedRuns: number;
  guardUnexercisedRuns: number;
  guardDegradedRuns: number;
  guardFaultRuns: number;
}): CoercionVerdict {
  const { searchDelta, costDelta, outcomes, guardedRuns, guardUnexercisedRuns } = input;

  // The treatment must have been in force somewhere. A run where the hook was
  // armed but never needed still counts: the agent was under the policy and
  // chose not to search, which is itself the effect being measured. Only a
  // sweep where the policy was NOWHERE in force cannot answer the question.
  if (guardedRuns + guardUnexercisedRuns === 0) {
    return { ...input, verdict: "INCONCLUSIVE_GUARD_INACTIVE" };
  }

  const workFell = searchDelta.medianPairedDelta < 0;
  const workRose = searchDelta.medianPairedDelta > 0;
  const costRose = costDelta.medianPairedDelta > 0;
  const lostTasks = outcomes.rightUniqueWin > outcomes.leftUniqueWin;

  if (workRose || (costRose && !workFell)) {
    return { ...input, verdict: "COERCION_INCREASES_WORK" };
  }
  if (!workFell) return { ...input, verdict: "COERCION_NEUTRAL" };
  return {
    ...input,
    verdict: lostTasks
      ? "COERCION_REDUCES_WORK_AT_OUTCOME_COST"
      : "COERCION_REDUCES_WORK_WITHOUT_OUTCOME_COST",
  };
}
