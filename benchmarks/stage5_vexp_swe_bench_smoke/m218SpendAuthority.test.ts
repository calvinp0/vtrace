import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import { CohortLedger, type RunResultRecord } from "./m215CohortLedger";
import { M218_FROZEN_AMENDMENT_HASH, buildAmendmentDocument } from "./m218Amendment";
import {
  activeSpendAuthorityFromDocument,
  admitRetry,
  amendedLaunchRisk,
  auditExecutableAuthorityBinding,
  loadActiveSpendAuthority,
  retryReserveAccounting,
} from "./m218SpendAuthority";
import { outcomeShapedKeys } from "./m217RetryReserve";

const RESULTS = join(import.meta.dir, "results");
const manifest = (JSON.parse(readFileSync(join(RESULTS, "stage5_m214_run_manifest.json"), "utf8")) as {
  rows: RunManifestRow[];
}).rows;
const hashes = JSON.parse(readFileSync(join(RESULTS, "stage5_m214_preregistration_hash.json"), "utf8")) as {
  recordedHash: string; manifestHash: string; externalReferenceHash: string;
};
const frozen = { preregistrationHash: hashes.recordedHash, manifestHash: hashes.manifestHash, externalReferenceHash: hashes.externalReferenceHash };

const authority = loadActiveSpendAuthority(RESULTS);

function ledgerWith(entries: readonly { row: RunManifestRow; attempt: number; status: "VALID_UNRESOLVED" | "INFRASTRUCTURE_INVALID"; category: string | null; costUsd: number }[]): CohortLedger {
  const ledger = new CohortLedger("SYNTHETIC", frozen.preregistrationHash, frozen.manifestHash);
  let tick = 0;
  for (const entry of entries) {
    tick += 1;
    const attemptId = `${entry.row.runId}#a${entry.attempt}#t${tick}`;
    const record = {
      schemaVersion: "stage5.m215.run-result.v1", mode: "SYNTHETIC", experimentName: "VTRACE_EXTERNAL_VEXP_100",
      preregistrationHash: frozen.preregistrationHash, manifestHash: frozen.manifestHash, externalReferenceHash: frozen.externalReferenceHash,
      manifestRowId: entry.row.runId, manifestRowOrdinal: entry.row.executionOrder, runId: entry.row.runId,
      attempt: entry.attempt, attemptId, instanceId: entry.row.instanceId, repo: entry.row.repo, arm: entry.row.arm,
      pairedTaskId: entry.row.pairedTaskId, armOrder: entry.row.armOrder, armOrderIndex: entry.row.armOrderIndex,
      agent: { implementation: "x", binary: "x", version: "x", systemPromptSha256: "x", nativeToolCatalogSha256: "x", userPromptTemplateSha256: "x" },
      modelTarget: "x", providerModelIdentity: "x", modelIdentityVerified: true, vtraceCommit: null, vtraceProductTreeSha: null,
      sourceState: { baseCommit: "x", headAtAgentStart: "x", trackedSourceDigestBeforeTreatment: "x", trackedSourceDigestAfterTreatment: "x", canonicalTrackedSourceDigest: "x", preAgentUntrackedPaths: [], untrackedSourceAffectingPaths: [] },
      container: { image: "x", imageDigest: "x", workingDirectory: "/testbed", dependencyEnvironment: "x" },
      budgets: { identity: entry.row.budgetIdentity, maxTurns: entry.row.maxTurns, perRunCostCapUsd: entry.row.perRunCostCapUsd, wallClockTimeoutSecondsPerRun: 3600 },
      startedAt: "2026-09-05T00:00:00.000Z", endedAt: "2026-09-05T00:01:00.000Z", wallClockSeconds: 60,
      terminationReason: "AGENT_COMPLETED", turnCount: 1, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: entry.costUsd,
      treatment: { exposed: false, initialised: false, catalogSha256: null, firstInvocationTurn: null, invokedBeforeFirstEdit: false, toolNames: [], invocationCount: 0, totalOutputBytes: 0, totalLatencyMs: 0, indexBuildSeconds: null, indexSizeBytes: null },
      telemetry: [], capturedPatchSha256: "x", capturedPatchBytes: 0, capturedPatchPaths: [], patchCaptureExclusions: [],
      lifecyclePhasesObserved: [], evaluation: null,
      environment: { pathEntries: [], environmentVariableNames: [], cpuLimit: "x", memoryLimit: "x", networkPolicy: "x", redactedVariableNames: [] },
      runtimeGates: [],
      validity: { status: entry.status, valid: entry.status === "VALID_UNRESOLVED", infrastructureCategory: entry.category, reason: `synthetic ${entry.category ?? "valid"}` },
    } as unknown as RunResultRecord;
    ledger.append(record, `2026-09-05T00:0${tick}:00.000Z`);
  }
  return ledger;
}

describe("active spend authority", () => {
  test("loads from the committed amendment with the frozen numbers and the pinned digest", () => {
    expect(authority.amendmentHash).toBe(M218_FROZEN_AMENDMENT_HASH);
    expect(authority.ordinaryExposureUsd).toBe(700);
    expect(authority.retryReserveUsd).toBe(35);
    expect(authority.retryReserveAttempts).toBe(10);
    expect(authority.hardCeilingUsd).toBe(735);
    expect(authority.intendedValidOutcomes).toBe(200);
    expect(authority.manifestRows).toBe(200);
    expect(auditExecutableAuthorityBinding(authority, frozen)).toEqual([]);
  });

  test("an unbound, altered or mis-lineaged authority is refused (A3, §60)", () => {
    expect(auditExecutableAuthorityBinding(undefined, frozen).length).toBe(1);
    expect(auditExecutableAuthorityBinding(authority, { ...frozen, manifestHash: "0".repeat(64) }).length).toBe(1);
    const mutated = { ...buildAmendmentDocument("2026-09-05T00:00:00.000Z"), hardCeilingUsd: 1000 };
    expect(() => activeSpendAuthorityFromDocument(mutated, "memory")).toThrow(/not the active authority/);
    const forged = { ...authority, amendmentHash: "1".repeat(64) };
    expect(auditExecutableAuthorityBinding(forged, frozen).some((issue) => issue.includes("not the frozen"))).toBe(true);
  });
});

describe("retry reserve accounting (§8, §9)", () => {
  const rows = manifest.slice(0, 12);

  test("a fresh ledger has ten slots and $35", () => {
    const accounting = retryReserveAccounting(authority, ledgerWith([]));
    expect(accounting.retryAttemptsRemaining).toBe(10);
    expect(accounting.retryReserveRemainingUsd).toBe(35);
    expect(accounting.globalReserveRemainingUsd).toBe(735);
    expect(accounting.exhausted).toBe(false);
  });

  test("a first attempt is not a reserve decision; a preregistered retry is admitted with the eight facts", () => {
    const ledger = ledgerWith([{ row: rows[0]!, attempt: 1, status: "INFRASTRUCTURE_INVALID", category: "MODEL_SERVICE_FAILURE", costUsd: 3.5 }]);
    expect(admitRetry(authority, ledger, rows[1]!)).toBeNull();
    const record = admitRetry(authority, ledger, rows[0]!)!;
    expect(record.permitted).toBe(true);
    expect(record.retryOrdinal).toBe(1);
    expect(record.parentManifestRow.runId).toBe(rows[0]!.runId);
    expect(record.preregisteredRetryClass).toBe("MODEL_SERVICE_FAILURE");
    expect(record.priorAttemptSpendUsd).toBe(3.5);
    expect(record.newAttemptMaximumExposureUsd).toBe(3.5);
    expect(record.remainingRetryReserveAttemptsAfter).toBe(9);
    expect(record.remainingRetryReserveUsdAfterAtCap).toBe(31.5);
    expect(record.remainingGlobalReserveUsdAfterAtCap).toBe(728);
    expect(record.retryReason).toContain("MODEL_SERVICE_FAILURE");
  });

  test("a retry outside the preregistered classes is refused even with the reserve intact (A7)", () => {
    const ledger = ledgerWith([{ row: rows[0]!, attempt: 1, status: "INFRASTRUCTURE_INVALID", category: "PATCH_EXTRACTION_FAILURE", costUsd: 1 }]);
    const record = admitRetry(authority, ledger, rows[0]!)!;
    expect(record.permitted).toBe(false);
    expect(record.refusal).toBe("RETRY_CLASS_NOT_PREREGISTERED");
    expect(record.accountingBefore.exhausted).toBe(false);
  });

  test("the eleventh retry is refused as RETRY_RESERVE_EXHAUSTED even when cheap (A6)", () => {
    const entries = rows.slice(0, 10).flatMap((row) => [
      { row, attempt: 1, status: "INFRASTRUCTURE_INVALID" as const, category: "CONTAINER_CANNOT_START", costUsd: 0 },
      { row, attempt: 2, status: "VALID_UNRESOLVED" as const, category: null, costUsd: 0.5 },
    ]);
    entries.push({ row: rows[10]!, attempt: 1, status: "INFRASTRUCTURE_INVALID", category: "MODEL_SERVICE_FAILURE", costUsd: 3.5 });
    const ledger = ledgerWith(entries);
    const accounting = retryReserveAccounting(authority, ledger);
    expect(accounting.retryAttemptsStarted).toBe(10);
    expect(accounting.retryAttemptsRemaining).toBe(0);
    expect(accounting.retrySpendUsd).toBe(5);
    expect(accounting.exhausted).toBe(true);
    const record = admitRetry(authority, ledger, rows[10]!)!;
    expect(record.permitted).toBe(false);
    expect(record.refusal).toBe("RETRY_RESERVE_EXHAUSTED");
    expect(record.refusalDetail).toContain("another explicit preregistration amendment");
  });

  test("ten maximum-cost retries consume exactly the $35 reserve, and the dollars bind before the slots when retries overrun", () => {
    const entries = rows.slice(0, 9).flatMap((row) => [
      { row, attempt: 1, status: "INFRASTRUCTURE_INVALID" as const, category: "MODEL_SERVICE_FAILURE", costUsd: 3.5 },
      { row, attempt: 2, status: "VALID_UNRESOLVED" as const, category: null, costUsd: 3.5 },
    ]);
    entries.push({ row: rows[9]!, attempt: 1, status: "INFRASTRUCTURE_INVALID", category: "MODEL_SERVICE_FAILURE", costUsd: 3.5 });
    const ledger = ledgerWith(entries);
    const tenth = admitRetry(authority, ledger, rows[9]!)!;
    expect(tenth.permitted).toBe(true);
    expect(tenth.remainingRetryReserveUsdAfterAtCap).toBe(0);
    expect(tenth.remainingRetryReserveAttemptsAfter).toBe(0);
    const overrun = ledgerWith([
      ...entries,
      { row: rows[9]!, attempt: 2, status: "VALID_UNRESOLVED", category: null, costUsd: 3.5 },
      { row: rows[10]!, attempt: 1, status: "INFRASTRUCTURE_INVALID", category: "MODEL_SERVICE_FAILURE", costUsd: 3.5 },
    ]);
    const eleventh = admitRetry(authority, overrun, rows[10]!)!;
    expect(eleventh.refusal).toBe("RETRY_RESERVE_EXHAUSTED");
  });
});

describe("amended launch risk", () => {
  test("names $735, $700 + $35, ten attempts, the exhaustion marker, and no outcome-shaped key", () => {
    const risk = amendedLaunchRisk(authority);
    expect(risk.ceilingAwaitingAuthorizationUsd).toBe(735);
    expect(risk.ordinaryExposureUsd + risk.retryReserveUsd).toBe(735);
    expect(risk.retryReserveAttempts).toBe(10);
    expect(risk.exhaustionMarker).toBe("RETRY_RESERVE_EXHAUSTED");
    expect(risk.spendAuthorizationStatus).toBe("SPEND_AUTHORIZATION_PENDING");
    expect(outcomeShapedKeys(risk as unknown as Record<string, unknown>)).toEqual([]);
  });
});
