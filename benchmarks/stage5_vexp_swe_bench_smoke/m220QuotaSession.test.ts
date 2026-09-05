import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import {
  M215_EXTERNAL_REFERENCE_FILE,
  M215_MANIFEST_FILE,
  M215_PREREGISTRATION_FILE,
  executeManifestRow,
  runCohort,
  selectNextRow,
  verifyFrozenAuthorities,
  type ExecutorDependencies,
} from "./m215LaunchExecutor";
import { CohortLedger } from "./m215CohortLedger";
import { syntheticAdapters, syntheticClock, syntheticWorld } from "./m215Fixtures";
import { syntheticOperations, syntheticOperationsClock } from "./m217Fixtures";
import { cohortOperationalStatus, outcomeShapedKeys } from "./m217RetryReserve";
import {
  type SessionBounds,
  classifyQuota,
  deriveSessionJournal,
  freshCounters,
  frozenPairs,
  lastHardQuotaLimit,
  nextFrozenPair,
  pairStatus,
  pairTemporalGaps,
  parsePauseRequest,
  parseRateLimitEvents,
  quotaObservationRequiresAbort,
  quotaWindowGate,
  sessionBoundaryDecision,
  sessionIdFor,
  sessionStatusView,
  statusViewLeaksOutcome,
  validateMaxPairs,
} from "./m220QuotaSession";

const RESULTS = join(import.meta.dir, "results");
const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(RESULTS, file), "utf8")) as Record<string, unknown>;
const authorities = verifyFrozenAuthorities(
  read(M215_PREREGISTRATION_FILE),
  read(M215_MANIFEST_FILE) as unknown as { rows: RunManifestRow[]; manifestHash: string },
  read(M215_EXTERNAL_REFERENCE_FILE),
);
const manifest = authorities.manifest;
const pairs = frozenPairs(manifest);

function ledger(): CohortLedger {
  return new CohortLedger("SYNTHETIC", authorities.preregistrationHash.actual, authorities.manifestHash.actual);
}

function deps(book: CohortLedger, ops = syntheticOperations(syntheticOperationsClock()), overrides: Partial<ExecutorDependencies> = {}): ExecutorDependencies {
  const adapters = syntheticAdapters(syntheticWorld());
  return {
    mode: "SYNTHETIC", authorities, container: adapters.container, agent: adapters.agent, evaluator: adapters.evaluator,
    ledger: book, now: syntheticClock(), spendAuthorization: null, operations: ops.operations, ...overrides,
  };
}

function bounds(maxPairs: number, extra: Partial<SessionBounds> = {}): SessionBounds & { requests: string[] } {
  const requests: string[] = [];
  return {
    sessionId: sessionIdFor(1), maxPairs, deadlineAt: null,
    pauseRequest: () => null, acknowledgePauseRequest: () => { requests.push("ack"); },
    ...extra, requests,
  };
}

describe("frozen pairs", () => {
  test("100 adjacent pairs in frozen order, 50/50 arm order", () => {
    expect(pairs).toHaveLength(100);
    expect(pairs[0]!.rows[0].executionOrder).toBe(0);
    expect(pairs[99]!.rows[1].executionOrder).toBe(199);
    expect(pairs.filter((pair) => pair.firstArm === "baseline")).toHaveLength(50);
    for (const pair of pairs) expect(pair.rows[1].executionOrder).toBe(pair.rows[0].executionOrder + 1);
  });

  test("the pair model refuses a manifest whose arms are not adjacent", () => {
    const swapped = manifest.map((row) => (row.executionOrder === 1 ? { ...row, executionOrder: 3 } : row.executionOrder === 3 ? { ...row, executionOrder: 1 } : row));
    expect(() => frozenPairs(swapped)).toThrow(/not adjacent/);
  });
});

describe("session cap (F6, F7, F14)", () => {
  test("max 2 pairs executes exactly rows 0-3 and pauses with PAIR_CAP_REACHED; the next session starts at row 4", async () => {
    const book = ledger();
    const first = await runCohort(deps(book), { session: bounds(2) });
    expect(first.executed).toHaveLength(4);
    expect(first.session?.endState).toBe("PAUSED");
    expect(first.session?.pauseReason).toBe("PAIR_CAP_REACHED");
    expect(first.session?.counters.pairsCompleted).toBe(2);
    expect(first.session?.endingNextRowOrdinal).toBe(4);
    expect(book.entries.map((entry) => entry.manifestRowOrdinal)).toEqual([0, 1, 2, 3]);
    // Session 2 with a DIFFERENT cap continues at pair 3 in frozen order; no duplicates, no skips.
    const second = await runCohort(deps(book), { session: { ...bounds(3), sessionId: sessionIdFor(2) } });
    expect(second.executed).toHaveLength(6);
    expect(book.entries.map((entry) => entry.manifestRowOrdinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(book.entries.map((entry) => entry.attemptId)).size).toBe(10);
    expect(second.session?.startingNextRowOrdinal).toBe(4);
    expect(second.session?.endingNextRowOrdinal).toBe(10);
  });

  test("a session cap of zero or a non-integer is refused (F13)", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, "2", undefined]) expect(() => validateMaxPairs(bad)).toThrow(/integer >= 1/);
    expect(validateMaxPairs(2)).toBe(2);
  });
});

describe("explicit pause requests (F9, F10)", () => {
  test("a request pending before the first pair starts nothing", async () => {
    const book = ledger();
    const request = { kind: "AFTER_CURRENT_PAIR" as const, requestedAt: "2026-09-05T00:00:00.000Z", requestedBy: "op" };
    const b = bounds(5, { pauseRequest: () => request });
    const report = await runCohort(deps(book), { session: b });
    expect(report.executed).toHaveLength(0);
    expect(report.session?.pauseReason).toBe("EXPLICIT_PAUSE_REQUEST_AFTER_PAIR");
    expect(b.requests).toEqual(["ack"]);
  });

  test("a request arriving mid-pair lets the pair finish, then pauses", async () => {
    const book = ledger();
    let pending: ReturnType<SessionBounds["pauseRequest"]> = null;
    const adapters = syntheticAdapters(syntheticWorld());
    const agent = adapters.agent;
    const original = agent.run.bind(agent);
    agent.run = async (spec, hooks) => {
      const outcome = await original(spec, hooks);
      if (spec.row.executionOrder === 0) pending = { kind: "AFTER_CURRENT_PAIR", requestedAt: "t", requestedBy: "op" };
      return outcome;
    };
    const d = deps(book, undefined, { agent, container: adapters.container, evaluator: adapters.evaluator });
    const report = await runCohort(d, { session: bounds(5, { pauseRequest: () => pending }) });
    expect(report.executed).toHaveLength(2);
    expect(report.session?.pauseReason).toBe("EXPLICIT_PAUSE_REQUEST_AFTER_PAIR");
    expect(report.session?.counters.pairSplitOccurred).toBe(false);
  });

  test("an after-arm request splits the pair, records it, and the next session resumes the second arm only (F45)", async () => {
    const book = ledger();
    let pending: ReturnType<SessionBounds["pauseRequest"]> = null;
    const adapters = syntheticAdapters(syntheticWorld());
    const agent = adapters.agent;
    const original = agent.run.bind(agent);
    agent.run = async (spec, hooks) => {
      const outcome = await original(spec, hooks);
      if (spec.row.executionOrder === 0) pending = { kind: "AFTER_CURRENT_ARM", requestedAt: "t", requestedBy: "op" };
      return outcome;
    };
    const ops = syntheticOperations(syntheticOperationsClock());
    const d = deps(book, ops, { agent, container: adapters.container, evaluator: adapters.evaluator });
    const report = await runCohort(d, { session: bounds(5, { pauseRequest: () => pending }) });
    expect(report.executed).toHaveLength(1);
    expect(report.session?.pauseReason).toBe("EXPLICIT_PAUSE_REQUEST_AFTER_ARM");
    expect(report.session?.counters.pairSplitOccurred).toBe(true);
    expect(ops.ledger.events.some((event) => event.kind === "PAIR_SPLIT_BY_QUOTA_WINDOW")).toBe(true);
    expect(pairStatus(pairs[0]!, book).state).toBe("FIRST_ARM_SETTLED_SECOND_OPEN");
    // Resume: arm 1 is never rerun; the second arm runs; then the pair count includes the finished split pair.
    const resumed = await runCohort(deps(book, ops), { session: { ...bounds(1), sessionId: sessionIdFor(2) } });
    expect(resumed.executed).toHaveLength(1);
    expect(book.entries.map((entry) => entry.manifestRowOrdinal)).toEqual([0, 1]);
    expect(book.attemptsFor(pairs[0]!.rows[0].instanceId, pairs[0]!.rows[0].arm)).toHaveLength(1);
    expect(resumed.session?.counters.pairsCompleted).toBe(1);
    expect(resumed.session?.pauseReason).toBe("PAIR_CAP_REACHED");
  });
});

describe("wall clock and rerun refusal (F12, F42)", () => {
  test("a passed deadline stops new pairs but finishes the active pair", async () => {
    const book = ledger();
    const report = await runCohort(deps(book), { session: bounds(5, { deadlineAt: "2026-09-04T00:00:02.000Z" }) });
    // The synthetic clock starts at 2026-09-04T00:00:00Z; the first pair begins before the deadline.
    expect(report.executed).toHaveLength(2);
    expect(report.session?.pauseReason).toBe("WALL_CLOCK_DEADLINE");
  });

  test("a completed pair cannot be rerun by a direct selection", async () => {
    const book = ledger();
    await runCohort(deps(book), { session: bounds(1) });
    await expect(executeManifestRow(deps(book), { executionOrder: 0 })).rejects.toThrow(/already has a valid outcome/);
    await expect(executeManifestRow(deps(book), { executionOrder: 1 })).rejects.toThrow(/already has a valid outcome/);
  });
});

describe("structured quota signal (F17, F46)", () => {
  const init = JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-5-20251101", apiKeySource: "none", tools: [], mcp_servers: [] });
  const event = (info: Record<string, unknown>): string => JSON.stringify({ type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: "s" });

  test("only the structured event counts; English text is ignored", () => {
    const lines = [init, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "You've hit your limit; usage limit reached" }] } })];
    expect(parseRateLimitEvents(lines)).toHaveLength(0);
    expect(classifyQuota(parseRateLimitEvents(lines)).signal).toBe("NONE");
  });

  test("allowed_warning is a WARNING, rejected is a HARD_LIMIT, isUsingOverage is PAID_OVERAGE_IN_USE", () => {
    const warn = parseRateLimitEvents([init, event({ status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1_788_600_000 })]);
    expect(classifyQuota(warn).signal).toBe("WARNING");
    expect(classifyQuota(warn).quotaClass).toBe("SESSION_QUOTA");
    expect(classifyQuota(warn).resetsAtIso).toBe(new Date(1_788_600_000 * 1000).toISOString());
    const hard = parseRateLimitEvents([init, event({ status: "allowed" }), event({ status: "rejected", rateLimitType: "seven_day", resetsAt: 1_789_000_000 })]);
    expect(classifyQuota(hard).signal).toBe("HARD_LIMIT");
    expect(classifyQuota(hard).quotaClass).toBe("WEEKLY_QUOTA");
    expect(quotaObservationRequiresAbort(hard[1]!)).toMatch(/usage limit reached/);
    expect(quotaObservationRequiresAbort(hard[0]!)).toBeNull();
    const overage = parseRateLimitEvents([init, event({ status: "allowed", rateLimitType: "five_hour", isUsingOverage: true, overageStatus: "allowed" })]);
    expect(classifyQuota(overage).signal).toBe("PAID_OVERAGE_IN_USE");
    expect(quotaObservationRequiresAbort(overage[0]!)).toMatch(/never continues into usage credits/);
  });

  test("a hard limit mid-attempt is MODEL_SERVICE_FAILURE, never valid unresolved, and the session pauses (F17, F19)", async () => {
    const book = ledger();
    const ops = syntheticOperations(syntheticOperationsClock());
    const adapters = syntheticAdapters(syntheticWorld({ resolved: false }));
    const agent = adapters.agent;
    const original = agent.run.bind(agent);
    let hits = 0;
    agent.run = async (spec, hooks) => {
      const outcome = await original(spec, hooks);
      if (spec.row.executionOrder === 1) {
        hits += 1;
        return { ...outcome, quota: classifyQuota(parseRateLimitEvents([event({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1_700_000_000 })])) };
      }
      return outcome;
    };
    const d = deps(book, ops, { agent, container: adapters.container, evaluator: adapters.evaluator });
    const first = await runCohort(d, { session: bounds(5) });
    expect(first.executed).toHaveLength(2);
    const interrupted = book.entries[1]!;
    expect(interrupted.status).toBe("INFRASTRUCTURE_INVALID");
    expect(interrupted.validity.infrastructureCategory).toBe("MODEL_SERVICE_FAILURE");
    expect(interrupted.validity.reason).toMatch(/quota interruption/);
    expect(first.session?.pauseReason).toBe("HARD_QUOTA_LIMIT_OBSERVED");
    expect(first.session?.counters.hardQuotaLimitObserved).toBe(true);
    expect(ops.ledger.events.some((e) => e.kind === "QUOTA_LIMIT_OBSERVED")).toBe(true);
    // The recorded limit is found from the operations ledger; a future reset gates a session, a past one does not.
    expect(lastHardQuotaLimit(ops.ledger.events)?.resetsAtIso).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(quotaWindowGate(lastHardQuotaLimit(ops.ledger.events), "2026-09-05T00:00:00.000Z")).toHaveLength(0);
    expect(quotaWindowGate({ resetsAtIso: "2026-09-05T01:00:00.000Z", quotaClass: "SESSION_QUOTA", observedAt: "2026-09-05T00:00:00.000Z" }, "2026-09-05T00:00:00.000Z")).toHaveLength(1);
    // Resume: the same row retries (attempt 2), and the frozen 2-attempt maximum binds after a second interruption.
    expect(selectNextRow(manifest, book)?.executionOrder).toBe(1);
    const second = await runCohort(d, { session: { ...bounds(5), sessionId: sessionIdFor(2) } });
    expect(hits).toBe(2);
    expect(book.attemptsFor(pairs[0]!.rows[1].instanceId, pairs[0]!.rows[1].arm)).toHaveLength(2);
    expect(second.session?.pauseReason).toBe("HARD_QUOTA_LIMIT_OBSERVED");
    const third = await runCohort(d, { session: { ...bounds(1), sessionId: sessionIdFor(3) } });
    // The cell is unrecoverable; the frozen order moves on to pair 2 without a third attempt.
    expect(book.attemptsFor(pairs[0]!.rows[1].instanceId, pairs[0]!.rows[1].arm)).toHaveLength(2);
    expect(third.executed.length).toBeGreaterThan(0);
    expect(book.entries[book.entries.length - 1]!.manifestRowOrdinal).toBeGreaterThanOrEqual(2);
  });

  test("a warning requests a pause after the current pair", async () => {
    const book = ledger();
    const ops = syntheticOperations(syntheticOperationsClock());
    const adapters = syntheticAdapters(syntheticWorld());
    const agent = adapters.agent;
    const original = agent.run.bind(agent);
    agent.run = async (spec, hooks) => {
      const outcome = await original(spec, hooks);
      return spec.row.executionOrder === 0
        ? { ...outcome, quota: classifyQuota(parseRateLimitEvents([event({ status: "allowed_warning", rateLimitType: "five_hour" })])) }
        : outcome;
    };
    const report = await runCohort(deps(book, ops, { agent, container: adapters.container, evaluator: adapters.evaluator }), { session: bounds(5) });
    expect(report.executed).toHaveLength(2);
    expect(report.session?.pauseReason).toBe("SESSION_QUOTA_WARNING_OBSERVED");
    expect(ops.ledger.events.some((e) => e.kind === "PAUSE_REQUESTED_AFTER_CURRENT_PAIR")).toBe(true);
    expect(book.entries.every((entry) => entry.status === "VALID_RESOLVED")).toBe(true);
  });
});

describe("journal, timing and outcome blindness (F15, F29)", () => {
  test("the journal derives from session events, timing measures the arm gap, the status names no outcome", async () => {
    const book = ledger();
    const ops = syntheticOperations(syntheticOperationsClock());
    ops.operations.recordSessionEvent("QUOTA_SESSION_STARTED", { sessionId: "SESSION_001", sessionNumber: 1, maxPairs: 2, startingNextRowOrdinal: 0, ledgerEntriesBefore: 0 });
    const report = await runCohort(deps(book, ops), { session: bounds(2) });
    ops.operations.recordSessionEvent("QUOTA_SESSION_ENDED", { sessionId: "SESSION_001", endState: "PAUSED", pauseReason: report.session?.pauseReason, counters: report.session?.counters, endingNextRowOrdinal: 4, ledgerEntriesAfter: book.entries.length, incrementalBilledProviderSpend: "$0" });
    const journal = deriveSessionJournal(ops.ledger.events, book);
    expect(journal).toHaveLength(1);
    expect(journal[0]!.pairsCompleted).toBe(2);
    expect(journal[0]!.endState).toBe("PAUSED");
    expect(journal[0]!.modelIdentityObservations).toEqual(["claude-opus-4-5-20251101"]);
    const timing = pairTemporalGaps(pairs, book, journal);
    expect(timing.pairsMeasured).toBe(2);
    expect(timing.medianSeconds).not.toBeNull();
    expect(timing.pairsSplitAcrossSessions).toBe(0);
    const status = sessionStatusView({
      manifest, ledger: book, events: ops.ledger.events,
      operationalStatus: cohortOperationalStatus(manifest, book, ops.ledger).status, continuationState: ops.operations.state(),
      pauseRequest: null, subscriptionAuthState: "SUBSCRIPTION_AUTH_MODE_PROVEN", scratchFreeBytes: 1, now: "2026-09-05T00:00:00.000Z",
      nextRow: selectNextRow(manifest, book),
    });
    expect(statusViewLeaksOutcome(status)).toEqual([]);
    expect(outcomeShapedKeys(status as unknown as Record<string, unknown>)).toEqual([]);
    expect(JSON.stringify(status)).not.toMatch(/VALID_RESOLVED|VALID_UNRESOLVED|"resolved"/);
    expect(status.pairsComplete).toBe(2);
    expect(status.nextRow?.executionOrder).toBe(4);
    expect(status.operationalStatus).toBe("COHORT_PAUSED_QUOTA_WINDOW");
    expect(nextFrozenPair(pairs, book)?.pair.pairOrdinal).toBe(3);
  });

  test("pause requests parse strictly and the pause is not a halt", () => {
    expect(parsePauseRequest(null)).toBeNull();
    expect(parsePauseRequest("{\"kind\":\"NOW\"}")).toBeNull();
    expect(parsePauseRequest("{\"kind\":\"AFTER_CURRENT_ARM\",\"requestedAt\":\"t\"}")?.kind).toBe("AFTER_CURRENT_ARM");
    const counters = freshCounters();
    counters.pairsCompleted = 1;
    const decision = sessionBoundaryDecision({ nextRow: manifest.find((row) => row.executionOrder === 2)!, pairs, ledger: ledger(), counters, bounds: bounds(1), now: "2026-09-05T00:00:00.000Z" });
    expect(decision.proceed).toBe(false);
    expect(decision.reason).toBe("PAIR_CAP_REACHED");
  });
});
