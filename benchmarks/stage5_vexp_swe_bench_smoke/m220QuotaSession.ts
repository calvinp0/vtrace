/**
 * M220 §5–§15, §22–§32, §40–§43 — pair-bounded quota sessions, graceful pause,
 * outcome-blind resume, and the structured quota signal.
 *
 * PURE. Everything here is a function of the frozen manifest, the result
 * ledger, the operations ledger and injected clocks; the launcher binds it to
 * the filesystem (the pause-request file, the session journal) and the
 * executor consumes exactly one thing from it inside the cohort loop:
 * `sessionBoundaryDecision`, which answers "may the next frozen row begin in
 * THIS session" and nothing else. It never chooses WHICH row: `selectNextRow`
 * still does that, from the frozen order.
 *
 * Three things this module is careful not to be.
 *
 *   * Not a second scheduler. The unit of work is the next frozen pair; the
 *     only inputs are an operator-declared pair cap, an explicit pause
 *     request, a wall-clock deadline and the CLI's own structured rate-limit
 *     events. There is no task selector.
 *   * Not outcome-aware. No function here reads `resolved`, a pass rate or an
 *     arm comparison; the status view is checked against M217's
 *     outcome-shaped key pattern.
 *   * Not a text matcher. The quota signal is read from the CLI's
 *     `rate_limit_event` (`rate_limit_info.status`, `rateLimitType`,
 *     `resetsAt`, `isUsingOverage`); free English in a result message never
 *     classifies an attempt.
 */

import { type RunManifestRow } from "./m214Preregistration";
import { type CohortLedger, isTerminal, isTerminalValid } from "./m215CohortLedger";
import type { OperationalEvent } from "./m217ContinuationSafety";
import { rowRequiresAttempt } from "./m217RetryReserve";
import { M220_PAIR_SPLIT_MARKER, M220_PAUSE_STATE } from "./m220Amendment";

export const M220_QUOTA_SESSION_VERSION = "stage5.m220.quota-session.v1" as const;
export const M220_SESSION_JOURNAL_SCHEMA = "stage5.m220.session-journal.v1" as const;
export const M220_PAIR_TIMING_SCHEMA = "stage5.m220.pair-timing.v1" as const;
export const M220_SESSION_STATUS_SCHEMA = "stage5.m220.session-status.v1" as const;
export const M220_PAUSE_REQUEST_FILE = "PAUSE_REQUEST.json" as const;

// ── Frozen pairs (§6, §7) ───────────────────────────────────────────

export interface FrozenPair {
  readonly pairOrdinal: number;
  readonly instanceId: string;
  /** Both rows, in the manifest's frozen arm order. */
  readonly rows: readonly [RunManifestRow, RunManifestRow];
  readonly firstArm: RunManifestRow["arm"];
  readonly secondArm: RunManifestRow["arm"];
}

/**
 * Group the frozen manifest into pairs, in frozen order. The manifest is
 * validated, not trusted: every task must have exactly two rows, and the two
 * rows must be adjacent in execution order, or the pair model is undefined.
 */
export function frozenPairs(manifest: readonly RunManifestRow[]): readonly FrozenPair[] {
  const byTask = new Map<string, RunManifestRow[]>();
  for (const row of manifest) {
    const rows = byTask.get(row.instanceId) ?? [];
    rows.push(row);
    byTask.set(row.instanceId, rows);
  }
  const pairs: FrozenPair[] = [];
  for (const [instanceId, rows] of byTask) {
    if (rows.length !== 2) throw new Error(`task ${instanceId} has ${rows.length} manifest rows; the pair model needs exactly 2`);
    const sorted = [...rows].sort((left, right) => left.executionOrder - right.executionOrder) as [RunManifestRow, RunManifestRow];
    if (sorted[1].executionOrder !== sorted[0].executionOrder + 1) {
      throw new Error(`task ${instanceId}'s arms are not adjacent in the frozen order (${sorted[0].executionOrder}, ${sorted[1].executionOrder})`);
    }
    if (sorted[0].arm === sorted[1].arm) throw new Error(`task ${instanceId} has two rows of the same arm`);
    pairs.push({ pairOrdinal: 0, instanceId, rows: sorted, firstArm: sorted[0].arm, secondArm: sorted[1].arm });
  }
  pairs.sort((left, right) => left.rows[0].executionOrder - right.rows[0].executionOrder);
  return Object.freeze(pairs.map((pair, index) => ({ ...pair, pairOrdinal: index + 1 })));
}

export function pairForRow(pairs: readonly FrozenPair[], row: RunManifestRow): FrozenPair {
  const pair = pairs.find((candidate) => candidate.instanceId === row.instanceId);
  if (pair === undefined) throw new Error(`${row.runId} belongs to no frozen pair`);
  return pair;
}

/** A row is SETTLED when it needs no further attempt: valid, or unrecoverable. */
export function rowSettled(ledger: CohortLedger, row: RunManifestRow): boolean {
  return !rowRequiresAttempt(ledger, row);
}

export type PairState = "NOT_STARTED" | "FIRST_ARM_OPEN" | "FIRST_ARM_SETTLED_SECOND_OPEN" | "COMPLETE";

export interface PairStatus {
  readonly pair: FrozenPair;
  readonly state: PairState;
  readonly firstSettled: boolean;
  readonly secondSettled: boolean;
  readonly firstAttempted: boolean;
  readonly secondAttempted: boolean;
}

export function pairStatus(pair: FrozenPair, ledger: CohortLedger): PairStatus {
  const [first, second] = pair.rows;
  const firstSettled = rowSettled(ledger, first);
  const secondSettled = rowSettled(ledger, second);
  const firstAttempted = ledger.attemptsFor(first.instanceId, first.arm).length > 0;
  const secondAttempted = ledger.attemptsFor(second.instanceId, second.arm).length > 0;
  let state: PairState;
  if (firstSettled && secondSettled) state = "COMPLETE";
  else if (firstSettled) state = "FIRST_ARM_SETTLED_SECOND_OPEN";
  else if (firstAttempted) state = "FIRST_ARM_OPEN";
  else state = "NOT_STARTED";
  return { pair, state, firstSettled, secondSettled, firstAttempted, secondAttempted };
}

export function pairsComplete(pairs: readonly FrozenPair[], ledger: CohortLedger): number {
  return pairs.filter((pair) => pairStatus(pair, ledger).state === "COMPLETE").length;
}

/** The next frozen pair with an open row, or undefined when the cohort is done. */
export function nextFrozenPair(pairs: readonly FrozenPair[], ledger: CohortLedger): PairStatus | undefined {
  for (const pair of pairs) {
    const status = pairStatus(pair, ledger);
    if (status.state !== "COMPLETE") return status;
  }
  return undefined;
}

// ── The structured quota signal (§23, §24, §46) ─────────────────────

export type RateLimitStatus = "allowed" | "allowed_warning" | "rejected";

export interface RateLimitObservation {
  readonly ordinal: number;
  readonly status: RateLimitStatus;
  readonly rateLimitType: string | null;
  /** The CLI's `resetsAt` as written (epoch seconds or milliseconds); `resetsAtIso` normalises it. */
  readonly resetsAtRaw: number | null;
  readonly resetsAtIso: string | null;
  readonly utilization: number | null;
  readonly isUsingOverage: boolean;
  readonly overageStatus: string | null;
}

export type QuotaClass = "SESSION_QUOTA" | "WEEKLY_QUOTA" | "OVERAGE" | "UNKNOWN";

export function quotaClassFor(rateLimitType: string | null): QuotaClass | null {
  if (rateLimitType === null) return null;
  if (rateLimitType === "five_hour") return "SESSION_QUOTA";
  if (rateLimitType.startsWith("seven_day")) return "WEEKLY_QUOTA";
  if (rateLimitType === "overage") return "OVERAGE";
  return "UNKNOWN";
}

export function epochToIso(raw: number | null): string | null {
  if (raw === null || !Number.isFinite(raw)) return null;
  const ms = raw < 1e12 ? raw * 1000 : raw;
  return new Date(ms).toISOString();
}

/**
 * Read the CLI's rate-limit events out of a stream-json transcript. Only the
 * structured shape counts: `{type: "rate_limit_event", rate_limit_info: {...}}`.
 * Anything else — an assistant message that talks about limits, a result text
 * — is not a quota signal.
 */
export function parseRateLimitEvents(lines: readonly string[]): readonly RateLimitObservation[] {
  const observations: RateLimitObservation[] = [];
  lines.forEach((line, ordinal) => {
    if (line.trim().length === 0) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.type !== "rate_limit_event") return;
    const info = event.rate_limit_info;
    if (info === null || typeof info !== "object") return;
    const record = info as Record<string, unknown>;
    const status = record.status;
    if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected") return;
    const resets = typeof record.resetsAt === "number" ? record.resetsAt : null;
    observations.push({
      ordinal,
      status,
      rateLimitType: typeof record.rateLimitType === "string" ? record.rateLimitType : null,
      resetsAtRaw: resets,
      resetsAtIso: epochToIso(resets),
      utilization: typeof record.utilization === "number" ? record.utilization : null,
      isUsingOverage: record.isUsingOverage === true,
      overageStatus: typeof record.overageStatus === "string" ? record.overageStatus : null,
    });
  });
  return Object.freeze(observations);
}

export type QuotaSignal = "NONE" | "WARNING" | "HARD_LIMIT" | "PAID_OVERAGE_IN_USE";

export interface QuotaObservation {
  readonly signal: QuotaSignal;
  readonly sawRateLimitEvent: boolean;
  readonly events: readonly RateLimitObservation[];
  readonly quotaClass: QuotaClass | null;
  readonly resetsAtIso: string | null;
  readonly lastStatus: RateLimitStatus | null;
  readonly overageObserved: boolean;
}

/**
 * Classify one attempt's rate-limit history. Paid overage in use is the
 * strongest signal (the executor never continues into it); a final `rejected`
 * is a hard limit; a final `allowed_warning` requests a pause after the current
 * pair; a final `allowed` after an earlier warning is still a warning for
 * scheduling purposes (the window is close), but is not a hard limit.
 */
export function classifyQuota(events: readonly RateLimitObservation[]): QuotaObservation {
  const last = events[events.length - 1];
  const overage = events.some((event) => event.isUsingOverage);
  const warned = events.some((event) => event.status === "allowed_warning");
  let signal: QuotaSignal = "NONE";
  if (overage) signal = "PAID_OVERAGE_IN_USE";
  else if (last?.status === "rejected") signal = "HARD_LIMIT";
  else if (warned) signal = "WARNING";
  const governing = [...events].reverse().find((event) => event.status !== "allowed") ?? last;
  return {
    signal,
    sawRateLimitEvent: events.length > 0,
    events,
    quotaClass: governing === undefined ? null : quotaClassFor(governing.rateLimitType),
    resetsAtIso: governing?.resetsAtIso ?? null,
    lastStatus: last?.status ?? null,
    overageObserved: overage,
  };
}

/** Whether a single observation must stop the attempt now (§20, §24). */
export function quotaObservationRequiresAbort(observation: RateLimitObservation): string | null {
  if (observation.isUsingOverage) {
    return `paid overage in use (overageStatus ${observation.overageStatus ?? "unreported"}); the executor never continues into usage credits`;
  }
  if (observation.status === "rejected") {
    return `subscription usage limit reached (${observation.rateLimitType ?? "unknown window"}, resets ${observation.resetsAtIso ?? "unreported"}); provider availability interruption`;
  }
  return null;
}

/** §16 / F16 / F18 — no attempt may start while a hard limit's reset time lies ahead. */
export function quotaWindowGate(
  lastHardLimit: { readonly resetsAtIso: string | null; readonly quotaClass: QuotaClass | null; readonly observedAt: string } | null,
  now: string,
): readonly string[] {
  if (lastHardLimit === null || lastHardLimit.resetsAtIso === null) return [];
  if (Date.parse(lastHardLimit.resetsAtIso) > Date.parse(now)) {
    return [
      `QUOTA_WINDOW_NOT_YET_RESET: a hard ${lastHardLimit.quotaClass ?? "UNKNOWN"} limit observed at `
      + `${lastHardLimit.observedAt} resets at ${lastHardLimit.resetsAtIso}; no attempt starts before then`,
    ];
  }
  return [];
}

// ── Session bounds and the boundary decision (§8, §12, §29, §42) ────

export type PauseRequestKind = "AFTER_CURRENT_PAIR" | "AFTER_CURRENT_ARM";

export interface PauseRequest {
  readonly kind: PauseRequestKind;
  readonly requestedAt: string;
  readonly requestedBy: string;
}

export type PauseReason =
  | "PAIR_CAP_REACHED"
  | "EXPLICIT_PAUSE_REQUEST_AFTER_PAIR"
  | "EXPLICIT_PAUSE_REQUEST_AFTER_ARM"
  | "SESSION_QUOTA_WARNING_OBSERVED"
  | "HARD_QUOTA_LIMIT_OBSERVED"
  | "WALL_CLOCK_DEADLINE";

export interface SessionBounds {
  readonly sessionId: string;
  /** Complete pairs this session may run; validated by `validateMaxPairs`. */
  readonly maxPairs: number;
  /** ISO timestamp after which no NEW pair begins; an active pair finishes. */
  readonly deadlineAt: string | null;
  /** The operator's explicit request, read fresh on every boundary. */
  readonly pauseRequest: () => PauseRequest | null;
  /** Called once a pause request has been honoured, so it is consumed exactly once. */
  readonly acknowledgePauseRequest: () => void;
}

export function validateMaxPairs(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`--max-pairs-this-session must be an integer >= 1 (got ${String(value)}); a session that runs zero pairs is a status request, not a launch`);
  }
  return value;
}

export interface SessionCounters {
  pairsStarted: number;
  pairsCompleted: number;
  rowsSettled: number;
  attemptsStarted: number;
  quotaWarningObserved: boolean;
  hardQuotaLimitObserved: boolean;
  pairSplitOccurred: boolean;
  pauseRequestedAfterPair: boolean;
  quotaClassObserved: QuotaClass | null;
  lastResetsAtIso: string | null;
}

export function freshCounters(): SessionCounters {
  return {
    pairsStarted: 0, pairsCompleted: 0, rowsSettled: 0, attemptsStarted: 0,
    quotaWarningObserved: false, hardQuotaLimitObserved: false, pairSplitOccurred: false,
    pauseRequestedAfterPair: false, quotaClassObserved: null, lastResetsAtIso: null,
  };
}

export interface BoundaryDecision {
  readonly proceed: boolean;
  readonly reason: PauseReason | null;
  /** Whether the next row is the second arm of a pair whose first arm is settled. */
  readonly secondArmOfOpenPair: boolean;
  /** Whether stopping here splits a pair across quota windows. */
  readonly pairSplit: boolean;
  readonly detail: string;
}

/**
 * The one decision the cohort loop asks before selecting nothing else.
 *
 * Order of precedence, deliberately:
 *   1. a hard quota limit observed in this session stops everything, at any boundary;
 *   2. an explicit AFTER_CURRENT_ARM request stops at any boundary (the operator
 *      knows the hard limit is imminent; §29) and records a split if it splits;
 *   3. the second arm of an open pair otherwise PROCEEDS — the pair is the unit;
 *   4. a new pair begins only if the pair cap, an AFTER_CURRENT_PAIR request, a
 *      quota warning and the wall-clock deadline all permit it.
 */
export function sessionBoundaryDecision(input: {
  readonly nextRow: RunManifestRow;
  readonly pairs: readonly FrozenPair[];
  readonly ledger: CohortLedger;
  readonly counters: SessionCounters;
  readonly bounds: SessionBounds;
  readonly now: string;
}): BoundaryDecision {
  const pair = pairForRow(input.pairs, input.nextRow);
  const status = pairStatus(pair, input.ledger);
  const isSecond = input.nextRow.runId === pair.rows[1].runId;
  const secondArmOfOpenPair = isSecond && status.firstSettled && !status.secondSettled;
  // A retry of an arm already attempted in this pair continues the pair; it is
  // not a new pair for the cap.
  const continuesOpenPair = secondArmOfOpenPair || status.firstAttempted;
  const request = input.bounds.pauseRequest();

  if (input.counters.hardQuotaLimitObserved) {
    return {
      proceed: false, reason: "HARD_QUOTA_LIMIT_OBSERVED", secondArmOfOpenPair,
      pairSplit: secondArmOfOpenPair,
      detail: `a hard quota limit was observed in ${input.bounds.sessionId}; no further attempt starts in this window`,
    };
  }
  if (request?.kind === "AFTER_CURRENT_ARM") {
    return {
      proceed: false, reason: "EXPLICIT_PAUSE_REQUEST_AFTER_ARM", secondArmOfOpenPair,
      pairSplit: secondArmOfOpenPair,
      detail: `operator requested a pause after the current arm at ${request.requestedAt}`,
    };
  }
  if (continuesOpenPair) {
    return { proceed: true, reason: null, secondArmOfOpenPair, pairSplit: false, detail: secondArmOfOpenPair ? "second arm of the open pair; the pair is the unit" : "continuing the open pair" };
  }
  if (input.counters.pairsCompleted >= input.bounds.maxPairs) {
    return { proceed: false, reason: "PAIR_CAP_REACHED", secondArmOfOpenPair: false, pairSplit: false, detail: `${input.counters.pairsCompleted} complete pairs reached the session cap ${input.bounds.maxPairs}` };
  }
  if (request?.kind === "AFTER_CURRENT_PAIR" || input.counters.pauseRequestedAfterPair) {
    return {
      proceed: false,
      reason: request?.kind === "AFTER_CURRENT_PAIR" ? "EXPLICIT_PAUSE_REQUEST_AFTER_PAIR" : "SESSION_QUOTA_WARNING_OBSERVED",
      secondArmOfOpenPair: false, pairSplit: false,
      detail: request?.kind === "AFTER_CURRENT_PAIR" ? `operator requested a pause after the current pair at ${request.requestedAt}` : "the CLI reported the usage window is close to its limit; no new pair begins",
    };
  }
  if (input.bounds.deadlineAt !== null && Date.parse(input.now) >= Date.parse(input.bounds.deadlineAt)) {
    return { proceed: false, reason: "WALL_CLOCK_DEADLINE", secondArmOfOpenPair: false, pairSplit: false, detail: `session wall-clock deadline ${input.bounds.deadlineAt} passed at ${input.now}; no new pair begins` };
  }
  return { proceed: true, reason: null, secondArmOfOpenPair: false, pairSplit: false, detail: `pair ${pair.pairOrdinal} (${pair.instanceId}) may begin; ${input.counters.pairsCompleted}/${input.bounds.maxPairs} complete pairs so far` };
}

/** The pause-request file protocol: written by the operator's launcher invocation, read by the running loop. */
export function parsePauseRequest(text: string | null): PauseRequest | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as Partial<PauseRequest>;
    if (parsed.kind !== "AFTER_CURRENT_PAIR" && parsed.kind !== "AFTER_CURRENT_ARM") return null;
    return { kind: parsed.kind, requestedAt: String(parsed.requestedAt ?? ""), requestedBy: String(parsed.requestedBy ?? "operator") };
  } catch {
    return null;
  }
}

export function pauseRequestDocument(kind: PauseRequestKind, requestedAt: string, requestedBy: string): PauseRequest {
  return { kind, requestedAt, requestedBy };
}

// ── Session identity and the journal (§9, §40, §41) ─────────────────

export const SESSION_EVENT_KINDS = Object.freeze([
  "QUOTA_SESSION_STARTED", "QUOTA_SESSION_ENDED", "PAIR_SPLIT_BY_QUOTA_WINDOW",
  "PAUSE_REQUESTED_AFTER_CURRENT_PAIR", "QUOTA_LIMIT_OBSERVED",
] as const);

export function sessionIdFor(sessionNumber: number): string {
  return `SESSION_${String(sessionNumber).padStart(3, "0")}`;
}

/** Sessions are numbered by counting QUOTA_SESSION_STARTED events in the chained operations ledger. */
export function nextSessionNumber(events: readonly OperationalEvent[]): number {
  return events.filter((event) => event.kind === "QUOTA_SESSION_STARTED").length + 1;
}

export interface SessionJournalEntry {
  readonly sessionId: string;
  readonly sessionNumber: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly endState: "PAUSED" | "HALTED" | "COMPLETE" | "REFUSED" | "IN_PROGRESS_OR_CRASHED";
  readonly pauseReason: string | null;
  readonly startingNextRowOrdinal: number | null;
  readonly endingNextRowOrdinal: number | null;
  readonly pairsPlanned: number | null;
  readonly pairsStarted: number;
  readonly pairsCompleted: number;
  readonly rowsSettled: number;
  readonly attemptsStarted: number;
  readonly quotaWarningObserved: boolean;
  readonly hardQuotaLimitObserved: boolean;
  readonly quotaClassObserved: string | null;
  readonly pairSplitOccurred: boolean;
  readonly cliReportedCostUsd: number;
  readonly incrementalBilledProviderSpend: string;
  readonly subscriptionAuth: Readonly<Record<string, unknown>> | null;
  readonly agentIdentity: Readonly<Record<string, unknown>> | null;
  readonly modelIdentityObservations: readonly string[];
  readonly cleanupResult: string | null;
  readonly scratchCapacity: Readonly<Record<string, unknown>> | null;
  readonly imagePreflight: string | null;
  readonly operationsEventRange: readonly [number, number | null];
}

/**
 * The journal is DERIVED from the hash-chained operations ledger, so its
 * integrity is the ledger's. Every field is operational; none names an
 * outcome, and the derivation is checked against the outcome-shaped key
 * pattern by the falsification suite.
 */
export function deriveSessionJournal(
  events: readonly OperationalEvent[], ledger: CohortLedger,
): readonly SessionJournalEntry[] {
  const entries: SessionJournalEntry[] = [];
  const starts = events.filter((event) => event.kind === "QUOTA_SESSION_STARTED");
  for (const start of starts) {
    const detail = start.detail as Record<string, unknown>;
    const sessionId = String(detail.sessionId);
    const end = events.find((event) => event.kind === "QUOTA_SESSION_ENDED" && event.sequence > start.sequence
      && String((event.detail as Record<string, unknown>).sessionId) === sessionId);
    const endDetail = (end?.detail ?? {}) as Record<string, unknown>;
    const counters = (endDetail.counters ?? {}) as Partial<SessionCounters>;
    // The session's attempts are the ledger entries appended between its
    // start and end events, correlated by SEQUENCE (recorded on both events)
    // rather than by clock, so two clocks can never disagree about membership.
    const before = typeof detail.ledgerEntriesBefore === "number" ? detail.ledgerEntriesBefore : null;
    const after = typeof endDetail.ledgerEntriesAfter === "number" ? endDetail.ledgerEntriesAfter : null;
    const window = before === null
      ? ledger.records.filter((record) => record.startedAt >= start.at && (end === undefined || record.endedAt <= end.at))
      : ledger.entries.filter((entry) => entry.sequence >= before && (after === null || entry.sequence < after))
        .map((entry) => ledger.record(entry.attemptId))
        .filter((record): record is NonNullable<typeof record> => record !== undefined);
    const models = [...new Set(window.map((record) => record.providerModelIdentity ?? "(absent)"))].sort();
    entries.push({
      sessionId,
      sessionNumber: Number(detail.sessionNumber),
      startedAt: start.at,
      endedAt: end?.at ?? null,
      endState: (endDetail.endState as SessionJournalEntry["endState"] | undefined) ?? "IN_PROGRESS_OR_CRASHED",
      pauseReason: (endDetail.pauseReason as string | null | undefined) ?? null,
      startingNextRowOrdinal: (detail.startingNextRowOrdinal as number | null | undefined) ?? null,
      endingNextRowOrdinal: (endDetail.endingNextRowOrdinal as number | null | undefined) ?? null,
      pairsPlanned: (detail.maxPairs as number | null | undefined) ?? null,
      pairsStarted: counters.pairsStarted ?? 0,
      pairsCompleted: counters.pairsCompleted ?? 0,
      rowsSettled: counters.rowsSettled ?? 0,
      attemptsStarted: counters.attemptsStarted ?? 0,
      quotaWarningObserved: counters.quotaWarningObserved ?? false,
      hardQuotaLimitObserved: counters.hardQuotaLimitObserved ?? false,
      quotaClassObserved: counters.quotaClassObserved ?? null,
      pairSplitOccurred: counters.pairSplitOccurred ?? false,
      cliReportedCostUsd: Number(window.reduce((total, record) => total + record.costUsd, 0).toFixed(6)),
      incrementalBilledProviderSpend: String(endDetail.incrementalBilledProviderSpend ?? "UNKNOWN_SESSION_NOT_ENDED"),
      subscriptionAuth: (detail.subscriptionAuth as Record<string, unknown> | undefined) ?? null,
      agentIdentity: (detail.agentIdentity as Record<string, unknown> | undefined) ?? null,
      modelIdentityObservations: models,
      cleanupResult: (endDetail.cleanupResult as string | undefined) ?? null,
      scratchCapacity: (detail.scratchCapacity as Record<string, unknown> | undefined) ?? null,
      imagePreflight: (detail.imagePreflight as string | undefined) ?? null,
      operationsEventRange: [start.sequence, end?.sequence ?? null],
    });
  }
  return Object.freeze(entries);
}

/** The most recent hard-limit observation, for the quota-window gate at the next session start. */
export function lastHardQuotaLimit(events: readonly OperationalEvent[]): { resetsAtIso: string | null; quotaClass: QuotaClass | null; observedAt: string } | null {
  const event = [...events].reverse().find((candidate) => candidate.kind === "QUOTA_LIMIT_OBSERVED"
    && ((candidate.detail as { signal?: unknown }).signal === "HARD_LIMIT" || (candidate.detail as { signal?: unknown }).signal === "PAID_OVERAGE_IN_USE"));
  if (event === undefined) return null;
  const detail = event.detail as { resetsAtIso?: string | null; quotaClass?: QuotaClass | null };
  return { resetsAtIso: detail.resetsAtIso ?? null, quotaClass: detail.quotaClass ?? null, observedAt: event.at };
}

// ── Pair temporal separation (§30, §31) ─────────────────────────────

export interface PairTiming {
  readonly instanceId: string;
  readonly pairOrdinal: number;
  readonly firstArmEndedAt: string | null;
  readonly secondArmStartedAt: string | null;
  readonly gapSeconds: number | null;
  readonly firstArmSession: string | null;
  readonly secondArmSession: string | null;
  readonly splitAcrossSessions: boolean;
}

export interface PairTimingSummary {
  readonly schemaVersion: typeof M220_PAIR_TIMING_SCHEMA;
  readonly pairsMeasured: number;
  readonly medianSeconds: number | null;
  readonly p90Seconds: number | null;
  readonly maxSeconds: number | null;
  readonly pairsSplitAcrossSessions: number;
  /** Descriptive only; named by the FIRST arm of the split pair (§31). */
  readonly splitsByFirstArm: Readonly<Record<string, number>>;
  readonly perPair: readonly PairTiming[];
  readonly evaluationMetadataOnly: true;
  readonly modifiesOutcomes: false;
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

/** Time between the end of arm 1 (its last attempt) and the start of arm 2 (its first attempt). */
export function pairTemporalGaps(
  pairs: readonly FrozenPair[], ledger: CohortLedger, journal: readonly SessionJournalEntry[],
): PairTimingSummary {
  const sessionAt = (iso: string | null): string | null => {
    if (iso === null) return null;
    const entry = journal.find((session) => session.startedAt <= iso && (session.endedAt === null || iso <= session.endedAt));
    return entry?.sessionId ?? null;
  };
  const perPair: PairTiming[] = [];
  for (const pair of pairs) {
    const firstAttempts = ledger.attemptsFor(pair.rows[0].instanceId, pair.rows[0].arm);
    const secondAttempts = ledger.attemptsFor(pair.rows[1].instanceId, pair.rows[1].arm);
    const firstEnd = firstAttempts.length === 0 ? null : (ledger.record(firstAttempts[firstAttempts.length - 1]!.attemptId)?.endedAt ?? null);
    const secondStart = secondAttempts.length === 0 ? null : (ledger.record(secondAttempts[0]!.attemptId)?.startedAt ?? null);
    const gap = firstEnd !== null && secondStart !== null ? (Date.parse(secondStart) - Date.parse(firstEnd)) / 1000 : null;
    const firstSession = sessionAt(firstEnd);
    const secondSession = sessionAt(secondStart);
    perPair.push({
      instanceId: pair.instanceId, pairOrdinal: pair.pairOrdinal,
      firstArmEndedAt: firstEnd, secondArmStartedAt: secondStart, gapSeconds: gap,
      firstArmSession: firstSession, secondArmSession: secondSession,
      splitAcrossSessions: firstSession !== null && secondSession !== null && firstSession !== secondSession,
    });
  }
  const gaps = perPair.map((entry) => entry.gapSeconds).filter((gap): gap is number => gap !== null).sort((left, right) => left - right);
  const splits = perPair.filter((entry) => entry.splitAcrossSessions);
  const byFirstArm: Record<string, number> = {};
  for (const split of splits) {
    const arm = pairs.find((pair) => pair.instanceId === split.instanceId)!.firstArm;
    byFirstArm[`${arm}-first`] = (byFirstArm[`${arm}-first`] ?? 0) + 1;
  }
  return {
    schemaVersion: M220_PAIR_TIMING_SCHEMA,
    pairsMeasured: gaps.length,
    medianSeconds: percentile(gaps, 0.5),
    p90Seconds: percentile(gaps, 0.9),
    maxSeconds: gaps.length === 0 ? null : gaps[gaps.length - 1]!,
    pairsSplitAcrossSessions: splits.length,
    splitsByFirstArm: Object.freeze(byFirstArm),
    perPair: Object.freeze(perPair),
    evaluationMetadataOnly: true,
    modifiesOutcomes: false,
  };
}

// ── The outcome-blind session status (§32) ──────────────────────────

export interface SessionStatusView {
  readonly schemaVersion: typeof M220_SESSION_STATUS_SCHEMA;
  readonly rowsSettled: number;
  readonly rowsTerminal: number;
  readonly rowsPlanned: number;
  readonly pairsComplete: number;
  readonly pairsPlanned: number;
  readonly sessionsSoFar: number;
  readonly currentOrLastSession: string | null;
  readonly lastSessionEndState: string | null;
  readonly lastPauseReason: string | null;
  readonly nextRow: { readonly executionOrder: number; readonly instanceId: string; readonly arm: string; readonly positionInPair: "first" | "second"; readonly pairOrdinal: number } | null;
  readonly nextPairIsSplitResumption: boolean;
  readonly operationalStatus: string;
  readonly continuationState: string;
  readonly pauseRequestPending: string | null;
  readonly quotaLimitState: { readonly hardLimitObservedAt: string | null; readonly resetsAt: string | null; readonly quotaClass: string | null; readonly resetGateIssues: readonly string[] };
  readonly pairsSplitAcrossSessions: number;
  readonly cliReportedCostUsd: number;
  readonly incrementalBilledProviderSpendUsd: number | "UNKNOWN_OVERAGE_OBSERVED";
  readonly subscriptionAuthState: string | null;
  readonly scratchFreeBytes: number | null;
  readonly containersClean: boolean;
}

export function sessionStatusView(input: {
  readonly manifest: readonly RunManifestRow[];
  readonly ledger: CohortLedger;
  readonly events: readonly OperationalEvent[];
  readonly operationalStatus: string;
  readonly continuationState: string;
  readonly pauseRequest: PauseRequest | null;
  readonly subscriptionAuthState: string | null;
  readonly scratchFreeBytes: number | null;
  readonly now: string;
  readonly nextRow: RunManifestRow | undefined;
}): SessionStatusView {
  const pairs = frozenPairs(input.manifest);
  const journal = deriveSessionJournal(input.events, input.ledger);
  const last = journal[journal.length - 1];
  const hard = lastHardQuotaLimit(input.events);
  const timing = pairTemporalGaps(pairs, input.ledger, journal);
  const overage = input.events.some((event) => event.kind === "QUOTA_LIMIT_OBSERVED" && (event.detail as { signal?: unknown }).signal === "PAID_OVERAGE_IN_USE");
  const nextPair = input.nextRow === undefined ? null : pairStatus(pairForRow(pairs, input.nextRow), input.ledger);
  return {
    schemaVersion: M220_SESSION_STATUS_SCHEMA,
    rowsSettled: input.manifest.filter((row) => rowSettled(input.ledger, row)).length,
    rowsTerminal: input.manifest.filter((row) => isTerminal(input.ledger.statusFor(row.instanceId, row.arm))).length,
    rowsPlanned: input.manifest.length,
    pairsComplete: pairsComplete(pairs, input.ledger),
    pairsPlanned: pairs.length,
    sessionsSoFar: journal.length,
    currentOrLastSession: last?.sessionId ?? null,
    lastSessionEndState: last?.endState ?? null,
    lastPauseReason: last?.pauseReason ?? null,
    nextRow: input.nextRow === undefined || nextPair === null ? null : {
      executionOrder: input.nextRow.executionOrder, instanceId: input.nextRow.instanceId, arm: input.nextRow.arm,
      positionInPair: input.nextRow.runId === nextPair.pair.rows[0].runId ? "first" : "second",
      pairOrdinal: nextPair.pair.pairOrdinal,
    },
    nextPairIsSplitResumption: nextPair !== null && nextPair.state === "FIRST_ARM_SETTLED_SECOND_OPEN",
    operationalStatus: input.operationalStatus,
    continuationState: input.continuationState,
    pauseRequestPending: input.pauseRequest?.kind ?? null,
    quotaLimitState: { hardLimitObservedAt: hard?.observedAt ?? null, resetsAt: hard?.resetsAtIso ?? null, quotaClass: hard?.quotaClass ?? null, resetGateIssues: quotaWindowGate(hard, input.now) },
    pairsSplitAcrossSessions: timing.pairsSplitAcrossSessions,
    cliReportedCostUsd: Number(input.ledger.cumulativeSpendUsd().toFixed(6)),
    incrementalBilledProviderSpendUsd: overage ? "UNKNOWN_OVERAGE_OBSERVED" : 0,
    subscriptionAuthState: input.subscriptionAuthState,
    scratchFreeBytes: input.scratchFreeBytes,
    containersClean: input.continuationState === "CONTINUATION_SAFE",
  };
}

/** Whether the status view carries anything an operator could read as an interim result (§32, F15). */
export function statusViewLeaksOutcome(view: SessionStatusView): readonly string[] {
  const issues: string[] = [];
  const forbiddenKey = /win|passRate|resolved|pValue|mcnemar|discordant|byArm|effect|delta/i;
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (forbiddenKey.test(key)) issues.push(`${path}.${key}`);
      walk(child, `${path}.${key}`);
    }
  };
  walk(view, "status");
  return Object.freeze(issues);
}

export { M220_PAUSE_STATE, M220_PAIR_SPLIT_MARKER, isTerminalValid };
