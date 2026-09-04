/**
 * M215 §23–§25, §35, §36 — the ledger's three load-bearing properties.
 *
 * Exactly-once, append-only and mode isolation are tested directly rather than
 * through the executor, because each one is a property OF the ledger: an
 * executor bug produces one wrong run, a ledger bug produces a cohort whose N
 * nobody can state.
 */

import { describe, expect, test } from "bun:test";

import type { M214Arm } from "./m214Preregistration";
import {
  type ExecutionMode,
  type RunResultRecord,
  type ValidityClassification,
  CohortIntegrityError,
  CohortLedger,
  LEDGER_CHAIN_GENESIS,
  M215_RESULT_SCHEMA,
  chainDigest,
  deriveAttemptId,
  deriveRunId,
  gateRecord,
  isTerminal,
  isTerminalValid,
  requiredGatesPass,
  resultDigest,
} from "./m215CohortLedger";

const PREREG = "a".repeat(64);
const MANIFEST = "b".repeat(64);

function validity(status: ValidityClassification["status"]): ValidityClassification {
  return status === "INFRASTRUCTURE_INVALID"
    ? { status, valid: false, infrastructureCategory: "MODEL_SERVICE_FAILURE", reason: "synthetic" }
    : { status, valid: true, infrastructureCategory: null, reason: "synthetic" };
}

function record(
  instanceId: string,
  arm: M214Arm,
  attempt: number,
  status: ValidityClassification["status"],
  overrides: Partial<RunResultRecord> = {},
): RunResultRecord {
  const runId = deriveRunId("TEST", instanceId, arm);
  return {
    schemaVersion: M215_RESULT_SCHEMA,
    mode: "SYNTHETIC" as ExecutionMode,
    experimentName: "TEST",
    preregistrationHash: PREREG,
    manifestHash: MANIFEST,
    externalReferenceHash: "c".repeat(64),
    manifestRowId: runId,
    manifestRowOrdinal: 0,
    runId,
    attempt,
    attemptId: deriveAttemptId(runId, 0, attempt),
    instanceId,
    repo: "example/repo",
    arm,
    pairedTaskId: instanceId,
    armOrder: ["baseline", "vtrace"],
    armOrderIndex: arm === "baseline" ? 0 : 1,
    agent: {
      implementation: "test", binary: "/bin/true", version: "0.0.0",
      systemPromptSha256: "d".repeat(64), nativeToolCatalogSha256: "e".repeat(64),
      userPromptTemplateSha256: "f".repeat(64),
    },
    modelTarget: "model",
    providerModelIdentity: "model",
    modelIdentityVerified: true,
    vtraceCommit: null,
    vtraceProductTreeSha: null,
    sourceState: {
      baseCommit: "0".repeat(40), headAtAgentStart: "0".repeat(40),
      trackedSourceDigestBeforeTreatment: "1".repeat(64),
      trackedSourceDigestAfterTreatment: "1".repeat(64),
      canonicalTrackedSourceDigest: "1".repeat(64),
      preAgentUntrackedPaths: [], untrackedSourceAffectingPaths: [],
    },
    container: {
      image: "image", imageDigest: "2".repeat(64), workingDirectory: "/testbed",
      dependencyEnvironment: "conda:testbed",
    },
    budgets: {
      identity: "budget", maxTurns: 250, perRunCostCapUsd: 3.5,
      wallClockTimeoutSecondsPerRun: 3600,
    },
    startedAt: "2026-09-04T00:00:00.000Z",
    endedAt: "2026-09-04T00:01:00.000Z",
    wallClockSeconds: 60,
    terminationReason: "AGENT_COMPLETED",
    turnCount: 3,
    inputTokens: 1, outputTokens: 1, cachedInputTokens: 0,
    costUsd: 1.25,
    treatment: {
      exposed: false, initialised: false, catalogSha256: null, firstInvocationTurn: null,
      invokedBeforeFirstEdit: false, toolNames: [], invocationCount: 0, totalOutputBytes: 0,
      totalLatencyMs: 0, indexBuildSeconds: null, indexSizeBytes: null,
    },
    telemetry: [],
    capturedPatchSha256: "3".repeat(64),
    capturedPatchBytes: 0,
    capturedPatchPaths: [],
    patchCaptureExclusions: [],
    lifecyclePhasesObserved: [],
    evaluation: null,
    environment: {
      pathEntries: ["/usr/bin"], environmentVariableNames: ["PATH"], cpuLimit: "4",
      memoryLimit: "8g", networkPolicy: "none", redactedVariableNames: [],
    },
    runtimeGates: [],
    validity: validity(status),
    ...overrides,
  };
}

function ledger(mode: ExecutionMode = "SYNTHETIC"): CohortLedger {
  return new CohortLedger(mode, PREREG, MANIFEST);
}

describe("statuses", () => {
  test("only the two valid terminal states count as valid outcomes", () => {
    expect(isTerminalValid("VALID_RESOLVED")).toBe(true);
    expect(isTerminalValid("VALID_UNRESOLVED")).toBe(true);
    expect(isTerminalValid("INFRASTRUCTURE_INVALID")).toBe(false);
    expect(isTerminal("INFRASTRUCTURE_INVALID")).toBe(true);
    expect(isTerminal("STARTED")).toBe(false);
    expect(isTerminal("PLANNED")).toBe(false);
  });
});

describe("exactly-once", () => {
  test("a second valid outcome for one cell is refused", () => {
    const book = ledger();
    book.append(record("task-1", "baseline", 1, "VALID_RESOLVED"), "t0");
    expect(() => book.append(record("task-1", "baseline", 2, "VALID_UNRESOLVED"), "t1"))
      .toThrow(CohortIntegrityError);
    expect(book.entries).toHaveLength(1);
  });

  test("an unfavourable outcome cannot be replaced by rerunning the cell", () => {
    const book = ledger();
    book.append(record("task-1", "vtrace", 1, "VALID_UNRESOLVED"), "t0");
    expect(() => book.append(record("task-1", "vtrace", 2, "VALID_RESOLVED"), "t1"))
      .toThrow(/duplicate valid outcome/);
    expect(book.statusFor("task-1", "vtrace")).toBe("VALID_UNRESOLVED");
  });

  test("an invalid attempt does not block a later valid one, and both are retained", () => {
    const book = ledger();
    book.append(record("task-1", "baseline", 1, "INFRASTRUCTURE_INVALID"), "t0");
    book.append(record("task-1", "baseline", 2, "VALID_RESOLVED"), "t1");
    expect(book.entries).toHaveLength(2);
    expect(book.attemptsFor("task-1", "baseline")).toHaveLength(2);
    expect(book.statusFor("task-1", "baseline")).toBe("VALID_RESOLVED");
  });

  test("the same attempt id cannot be recorded twice", () => {
    const book = ledger();
    const entry = record("task-1", "baseline", 1, "INFRASTRUCTURE_INVALID");
    book.append(entry, "t0");
    expect(() => book.append(entry, "t1")).toThrow(/already recorded/);
  });
});

describe("mode isolation", () => {
  test("a SYNTHETIC result is refused by a COHORT ledger", () => {
    const cohort = ledger("COHORT");
    expect(() => cohort.append(record("task-1", "baseline", 1, "VALID_RESOLVED"), "t0"))
      .toThrow(/refusing a SYNTHETIC result in a COHORT ledger/);
  });

  test("a result declaring a different experiment identity is refused", () => {
    const book = ledger();
    const foreign = record("task-1", "baseline", 1, "VALID_RESOLVED", {
      preregistrationHash: "9".repeat(64),
    });
    expect(() => book.append(foreign, "t0")).toThrow(/declares preregistration/);
  });
});

describe("integrity", () => {
  test("the chain starts at genesis and each link recomputes", () => {
    const book = ledger();
    const first = book.append(record("task-1", "baseline", 1, "VALID_RESOLVED"), "t0");
    const second = book.append(record("task-2", "baseline", 1, "VALID_UNRESOLVED"), "t1");
    expect(first.previousChainDigest).toBe(LEDGER_CHAIN_GENESIS);
    expect(second.previousChainDigest).toBe(first.chainDigest);
    expect(second.chainDigest).toBe(chainDigest(first.chainDigest, second.resultDigest));
    expect(book.verifyIntegrity()).toEqual([]);
    expect(book.headChainDigest()).toBe(second.chainDigest);
  });

  test("a mutated record no longer hashes to its recorded digest", () => {
    const book = ledger();
    const original = record("task-1", "baseline", 1, "VALID_RESOLVED");
    const entry = book.append(original, "t0");
    const mutated = { ...original, costUsd: original.costUsd + 0.01 };
    expect(resultDigest(mutated)).not.toBe(entry.resultDigest);
    const restored = CohortLedger.restore("SYNTHETIC", PREREG, MANIFEST, [mutated], [entry]);
    expect(restored.issues.join(" ")).toContain("does not match the restored record");
  });

  test("restore replays a persisted cohort byte-for-byte", () => {
    const book = ledger();
    book.append(record("task-1", "baseline", 1, "VALID_RESOLVED"), "t0");
    book.append(record("task-1", "vtrace", 1, "VALID_UNRESOLVED"), "t1");
    const restored = CohortLedger.restore(
      "SYNTHETIC", PREREG, MANIFEST, book.records, book.entries,
    );
    expect(restored.issues).toEqual([]);
    expect(restored.ledger.headChainDigest()).toBe(book.headChainDigest());
    expect(restored.ledger.entries).toHaveLength(2);
  });
});

describe("corrections", () => {
  test("a correction is appended and the original outcome is left intact", () => {
    const book = ledger();
    const entry = book.append(record("task-1", "baseline", 1, "VALID_RESOLVED"), "t0");
    const correction = book.appendCorrection(
      entry.attemptId, "container.imageDigest", "registry digest re-read after the run", "t1",
    );
    expect(correction.originalResultDigest).toBe(entry.resultDigest);
    expect(book.corrections).toHaveLength(1);
    // The outcome itself is untouched: same digest, same chain, still verifying.
    expect(book.entries[0]!.resultDigest).toBe(entry.resultDigest);
    expect(book.verifyIntegrity()).toEqual([]);
  });

  test("correcting an unknown attempt is refused", () => {
    const book = ledger();
    expect(() => book.appendCorrection("nope", "field", "note", "t0"))
      .toThrow(CohortIntegrityError);
  });
});

describe("gate records", () => {
  test("a gate with no issues passes and carries no failure reason", () => {
    const gate = gateRecord("R1", "RUNTIME", true, [], "evidence", "t0");
    expect(gate.status).toBe("PASS");
    expect(gate.failureReason).toBeNull();
    expect(requiredGatesPass([gate])).toBe(true);
  });

  test("one failing required gate fails the derived decision", () => {
    const pass = gateRecord("R1", "RUNTIME", true, [], "evidence");
    const fail = gateRecord("R2", "RUNTIME", true, ["broken"], "evidence");
    expect(requiredGatesPass([pass, fail])).toBe(false);
  });

  test("a failing gate that is not required does not fail the decision", () => {
    const pass = gateRecord("R1", "RUNTIME", true, [], "evidence");
    const advisory = gateRecord("R2", "RUNTIME", false, ["noted"], "evidence");
    expect(requiredGatesPass([pass, advisory])).toBe(true);
  });
});

describe("identity", () => {
  test("run ids are deterministic and attempt ids are not shared between attempts", () => {
    const runId = deriveRunId("EXP", "task-1", "vtrace");
    expect(runId).toBe("EXP:task-1:vtrace");
    expect(deriveRunId("EXP", "task-1", "vtrace")).toBe(runId);
    expect(deriveAttemptId(runId, 3, 1)).not.toBe(deriveAttemptId(runId, 3, 2));
    expect(deriveAttemptId(runId, 3, 1)).toBe(deriveAttemptId(runId, 3, 1));
  });
});
