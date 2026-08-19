/**
 * M163-B — the adoption / compliance / aggregation invariants.
 *
 * Pure. Every rule here exists because M162's dry-run analysis broke it first:
 * an arm that had not run was being counted as an arm with zero turns, zero
 * calls and zero cost, and an arm that had not run was being labelled
 * AVAILABLE_UNUSED — which is the exact claim M163 exists to make.
 *
 * The governing rule, stated once: a NUMBER may only be produced from runs that
 * actually happened, and a NON-ADOPTION CLAIM may only be produced from runs
 * whose tool availability was proven from their own runtime evidence.
 */

import type { RawToolCall } from "./m162Telemetry";
import { isVtraceCall } from "./m162Telemetry";

/**
 * Ordinary repository actions, for trigger-compliance counting.
 *
 * `bash` is in the set: agents routinely grep, find and cat through it, and a
 * compliance rule that ignored it would let the most common form of ordinary
 * investigation pass unnoticed. `todowrite` is NOT in the set: it is agent
 * bookkeeping, touches no repository state, and excluding it is a decision
 * recorded here rather than buried in a counter (it is reported separately).
 */
export const ORDINARY_REPOSITORY_TOOLS: ReadonlySet<string> = new Set([
  "bash", "read", "grep", "glob", "edit", "write", "multiedit", "notebookedit",
]);

export const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set(["todowrite", "todoread"]);

function normalize(tool: string): string {
  return tool.trim().toLowerCase().replace(/^mcp__[^_]+__/, "");
}

// ---------------------------------------------------------------------------
// Adoption state
// ---------------------------------------------------------------------------

/**
 * NOT_RUN and TOOLS_UNAVAILABLE are separate from AVAILABLE_UNUSED on purpose.
 * All three produce "zero VTRACE calls" in the result row, and only one of them
 * is evidence about the agent.
 */
export type M163AdoptionState =
  | "NOT_RUN"
  | "TOOLS_UNAVAILABLE"
  | "AVAILABLE_UNUSED"
  | "AVAILABLE_USED"
  | "INVALID";

export interface AdoptionInput {
  /** Did a result row exist for this arm? Nothing else may substitute for this. */
  readonly executed: boolean;
  /**
   * Proven from the run's OWN init event: server connected AND the expected tool
   * inventory visible. `null` means the evidence could not be read, which is an
   * INVALID run, never a zero-adoption data point.
   */
  readonly toolsAvailable: boolean | null;
  readonly vtraceCallCount: number;
  /** Set when the trigger arm's treatment failed to reach the prompt. */
  readonly treatmentFailure?: boolean;
}

export function classifyAdoption(input: AdoptionInput): M163AdoptionState {
  if (!input.executed) return "NOT_RUN";
  if (input.treatmentFailure === true) return "INVALID";
  if (input.toolsAvailable === null) return "INVALID";
  if (input.toolsAvailable === false) return "TOOLS_UNAVAILABLE";
  return input.vtraceCallCount > 0 ? "AVAILABLE_USED" : "AVAILABLE_UNUSED";
}

export interface AdoptionRate {
  readonly used: number;
  readonly unused: number;
  /** used + unused. The ONLY denominator an adoption rate may be divided by. */
  readonly denominator: number;
  /** null when the denominator is zero — never 0, which reads as "nobody adopted". */
  readonly rate: number | null;
  readonly excluded: Readonly<Record<string, number>>;
}

/**
 * Adoption rate over runs that executed AND had proven availability.
 *
 * NOT_RUN, TOOLS_UNAVAILABLE and INVALID are excluded and counted, because a
 * rate whose denominator is not reported cannot be checked by a reader.
 */
export function adoptionRate(states: readonly M163AdoptionState[]): AdoptionRate {
  const used = states.filter((state) => state === "AVAILABLE_USED").length;
  const unused = states.filter((state) => state === "AVAILABLE_UNUSED").length;
  const denominator = used + unused;
  const excluded: Record<string, number> = {};
  for (const state of ["NOT_RUN", "TOOLS_UNAVAILABLE", "INVALID"] as const) {
    const count = states.filter((entry) => entry === state).length;
    if (count > 0) excluded[state] = count;
  }
  return {
    used,
    unused,
    denominator,
    rate: denominator === 0 ? null : used / denominator,
    excluded: Object.freeze(excluded),
  };
}

// ---------------------------------------------------------------------------
// Trigger compliance
// ---------------------------------------------------------------------------

export type M163TriggerState =
  | "NOT_APPLICABLE"
  | "NOT_MEASURABLE"
  | "TRIGGER_COMPLIED"
  | "TRIGGER_NOT_COMPLIED";

export interface TriggerComplianceResult {
  readonly state: M163TriggerState;
  /** Ordinary repository actions taken before the first VTRACE call. */
  readonly ordinaryCallsBefore: number;
  /** Bookkeeping calls before it, reported but never counted against compliance. */
  readonly bookkeepingCallsBefore: number;
  readonly firstVtraceCallIndex: number | null;
  readonly reason: string;
}

/**
 * Strict compliance: the required call must be the FIRST repository action.
 *
 * The frozen trigger says "your first action ... must be a single call", so any
 * completed trigger-arm run that touched the repository first is
 * TRIGGER_NOT_COMPLIED — including runs that eventually called VTRACE. That is
 * data, not a defect, and it is explicitly not a rerun condition.
 */
export function classifyTriggerCompliance(
  calls: readonly RawToolCall[],
  context: { readonly isTriggerArm: boolean; readonly adoption: M163AdoptionState },
): TriggerComplianceResult {
  if (!context.isTriggerArm) {
    return {
      state: "NOT_APPLICABLE",
      ordinaryCallsBefore: 0,
      bookkeepingCallsBefore: 0,
      firstVtraceCallIndex: null,
      reason: "arm carries no task-level trigger",
    };
  }
  if (context.adoption === "NOT_RUN" || context.adoption === "TOOLS_UNAVAILABLE" || context.adoption === "INVALID") {
    return {
      state: "NOT_MEASURABLE",
      ordinaryCallsBefore: 0,
      bookkeepingCallsBefore: 0,
      firstVtraceCallIndex: null,
      reason: `compliance is undefined for adoption state ${context.adoption}`,
    };
  }

  const firstIndex = calls.findIndex(isVtraceCall);
  const before = firstIndex === -1 ? calls : calls.slice(0, firstIndex);
  const ordinaryCallsBefore = before.filter((call) => ORDINARY_REPOSITORY_TOOLS.has(normalize(call.tool))).length;
  const bookkeepingCallsBefore = before.filter((call) => BOOKKEEPING_TOOLS.has(normalize(call.tool))).length;

  if (firstIndex === -1) {
    return {
      state: "TRIGGER_NOT_COMPLIED",
      ordinaryCallsBefore,
      bookkeepingCallsBefore,
      firstVtraceCallIndex: null,
      reason: "the trigger was delivered and the agent never called VTRACE",
    };
  }
  if (ordinaryCallsBefore > 0) {
    return {
      state: "TRIGGER_NOT_COMPLIED",
      ordinaryCallsBefore,
      bookkeepingCallsBefore,
      firstVtraceCallIndex: firstIndex,
      reason: `${ordinaryCallsBefore} ordinary repository action(s) preceded the required call`,
    };
  }
  return {
    state: "TRIGGER_COMPLIED",
    ordinaryCallsBefore: 0,
    bookkeepingCallsBefore,
    firstVtraceCallIndex: firstIndex,
    reason: "the required VTRACE call was the first repository action",
  };
}

export interface TriggerComplianceRate {
  readonly complied: number;
  readonly notComplied: number;
  readonly denominator: number;
  readonly rate: number | null;
  readonly excluded: Readonly<Record<string, number>>;
}

export function triggerComplianceRate(states: readonly M163TriggerState[]): TriggerComplianceRate {
  const complied = states.filter((state) => state === "TRIGGER_COMPLIED").length;
  const notComplied = states.filter((state) => state === "TRIGGER_NOT_COMPLIED").length;
  const denominator = complied + notComplied;
  const excluded: Record<string, number> = {};
  for (const state of ["NOT_APPLICABLE", "NOT_MEASURABLE"] as const) {
    const count = states.filter((entry) => entry === state).length;
    if (count > 0) excluded[state] = count;
  }
  return {
    complied,
    notComplied,
    denominator,
    rate: denominator === 0 ? null : complied / denominator,
    excluded: Object.freeze(excluded),
  };
}

// ---------------------------------------------------------------------------
// Aggregation with honest denominators
// ---------------------------------------------------------------------------

export interface Aggregate {
  readonly median: number | null;
  readonly mean: number | null;
  /** How many values were actually present. Always reported next to the number. */
  readonly n: number;
  /** How many entries contributed nothing because they were absent. */
  readonly missing: number;
}

/**
 * Aggregate a column that may contain absent values.
 *
 * `null` and non-finite entries are DROPPED and counted, never coerced to 0.
 * The M162 defect this replaces produced a median that was pulled toward zero by
 * arms that had not run, which made a partially-complete sweep look like a
 * cheap one.
 */
export function aggregate(values: readonly (number | null | undefined)[]): Aggregate {
  const present = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  const missing = values.length - present.length;
  if (present.length === 0) return { median: null, mean: null, n: 0, missing };
  const mid = Math.floor(present.length / 2);
  const median = present.length % 2 === 0
    ? ((present[mid - 1] ?? 0) + (present[mid] ?? 0)) / 2
    : (present[mid] ?? 0);
  const mean = present.reduce((sum, value) => sum + value, 0) / present.length;
  return { median, mean, n: present.length, missing };
}

export interface TokenTraffic {
  readonly inputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly outputTokens: number | null;
  /**
   * Every token the model actually processed, cache reads included.
   *
   * M162 found uncached input+output in the hundreds while cache reads were
   * ~1e6. Reporting only the former describes a different experiment than the
   * one that ran. This is deliberately NOT a cost proxy — see billedCostUsd.
   */
  readonly totalModelTraffic: number | null;
}

export function tokenTraffic(row: {
  readonly inputTokens?: number | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheCreationTokens?: number | null;
  readonly outputTokens?: number | null;
}): TokenTraffic {
  const parts = [row.inputTokens, row.cacheReadTokens, row.cacheCreationTokens, row.outputTokens];
  const present = parts.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    inputTokens: row.inputTokens ?? null,
    cacheReadTokens: row.cacheReadTokens ?? null,
    cacheCreationTokens: row.cacheCreationTokens ?? null,
    outputTokens: row.outputTokens ?? null,
    // All-absent stays null. A zero here would claim the model processed nothing.
    totalModelTraffic: present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0),
  };
}

export interface PairedDelta {
  readonly instanceId: string;
  readonly from: number | null;
  readonly to: number | null;
  readonly delta: number | null;
}

/** Paired per-task deltas. A pair with either side absent yields a null delta. */
export function pairedDeltas(
  instanceIds: readonly string[],
  from: ReadonlyMap<string, number | null>,
  to: ReadonlyMap<string, number | null>,
): readonly PairedDelta[] {
  return Object.freeze(instanceIds.map((instanceId) => {
    const a = from.get(instanceId) ?? null;
    const b = to.get(instanceId) ?? null;
    const delta = a === null || b === null ? null : b - a;
    return { instanceId, from: a, to: b, delta };
  }));
}

export interface PairedSummary {
  readonly improved: number;
  readonly worsened: number;
  readonly unchanged: number;
  readonly comparable: number;
  readonly incomparable: number;
  readonly medianDelta: number | null;
}

/**
 * Summarize paired deltas. `lowerIsBetter` is explicit because the same routine
 * serves turns (lower better) and resolution (higher better), and a silent
 * default would silently invert a verdict.
 */
export function summarizePairedDeltas(
  deltas: readonly PairedDelta[],
  options: { readonly lowerIsBetter: boolean },
): PairedSummary {
  const comparable = deltas.filter((entry) => entry.delta !== null);
  const sign = options.lowerIsBetter ? -1 : 1;
  return {
    improved: comparable.filter((entry) => Math.sign(entry.delta ?? 0) === sign).length,
    worsened: comparable.filter((entry) => Math.sign(entry.delta ?? 0) === -sign).length,
    unchanged: comparable.filter((entry) => entry.delta === 0).length,
    comparable: comparable.length,
    incomparable: deltas.length - comparable.length,
    medianDelta: aggregate(comparable.map((entry) => entry.delta)).median,
  };
}
