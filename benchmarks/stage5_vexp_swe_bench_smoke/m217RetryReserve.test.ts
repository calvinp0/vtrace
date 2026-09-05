import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { M214_BUDGET, M214_EXCLUSIONS, type RunManifestRow } from "./m214Preregistration";
import { CohortLedger, type RunResultRecord } from "./m215CohortLedger";
import { retryPermitted } from "./m215LaunchExecutor";
import { CohortOperationsLedger } from "./m217ContinuationSafety";
import {
  M217_FROZEN_RETRY_RESERVE_POLICY,
  cohortOperationalStatus,
  completionReserve,
  frozenSpendArithmetic,
  launchRiskStatement,
  outcomeShapedKeys,
  retryReserveDecision,
  rowRequiresAttempt,
} from "./m217RetryReserve";

const RESULTS = join(import.meta.dir, "results");
const manifest = (JSON.parse(readFileSync(join(RESULTS, "stage5_m214_run_manifest.json"), "utf8")) as {
  rows: RunManifestRow[];
}).rows;

describe("frozen spend arithmetic", () => {
  test("200 x $3.50 = $700 = the ceiling, so the retry reserve is exactly $0", () => {
    const arithmetic = frozenSpendArithmetic(manifest.length);
    expect(arithmetic.plannedOrdinaryRows).toBe(200);
    expect(arithmetic.perRowCapUsd).toBe(3.5);
    expect(arithmetic.maximumOrdinaryExposureUsd).toBe(700);
    expect(arithmetic.frozenCeilingUsd).toBe(700);
    expect(arithmetic.retryReserveUsd).toBe(0);
    expect(arithmetic.mathematicalMaximumUsd).toBe(1400);
    expect(arithmetic.plannedRowsConsistent).toBe(true);
  });
});

describe("retryReserveDecision", () => {
  const base = { perRowCapUsd: 3.5, ceilingUsd: 700 };

  test("a zero-cost failed attempt leaves the reserve intact", () => {
    const decision = retryReserveDecision({ ...base, attempt: 2, cumulativeUsd: 0, rowsRequiringAttemptExcludingThis: 199 });
    expect(decision.projectedUsd).toBe(700);
    expect(decision.withinCompletionReserve).toBe(true);
    expect(decision.permitted).toBe(true);
    expect(decision.declaration).toBe("FIXED_N_COMPLETION_GUARANTEED");
  });

  test("a failed attempt charged at cap consumes the reserve: refused under REFUSE, permitted and declared under the frozen binding", () => {
    const input = { ...base, attempt: 2, cumulativeUsd: 3.5, rowsRequiringAttemptExcludingThis: 199 };
    const strict = retryReserveDecision(input, "REFUSE_RETRY_WHEN_COMPLETION_RESERVE_EXCEEDED");
    expect(strict.projectedUsd).toBe(703.5);
    expect(strict.consumesCompletionReserve).toBe(true);
    expect(strict.permitted).toBe(false);
    expect(strict.refusalReason).toContain("completion reserve");

    const frozen = retryReserveDecision(input);
    expect(frozen.policy).toBe(M217_FROZEN_RETRY_RESERVE_POLICY);
    expect(frozen.permitted).toBe(true);
    expect(frozen.declaration).toBe("FIXED_N_COMPLETION_NOT_GUARANTEED");
    expect(frozen.withinCeiling).toBe(true);
  });

  test("under-spent earlier rows create real headroom under the frozen ceiling", () => {
    const decision = retryReserveDecision({
      ...base, attempt: 2, cumulativeUsd: 10.1, rowsRequiringAttemptExcludingThis: 189,
    }, "REFUSE_RETRY_WHEN_COMPLETION_RESERVE_EXCEEDED");
    expect(decision.projectedUsd).toBe(675.1);
    expect(decision.permitted).toBe(true);
    expect(decision.declaration).toBe("FIXED_N_COMPLETION_GUARANTEED");
  });

  test("the ceiling itself refuses under every policy", () => {
    for (const policy of ["PERMIT_RETRY_AND_DECLARE_COMPLETION_NOT_GUARANTEED", "REFUSE_RETRY_WHEN_COMPLETION_RESERVE_EXCEEDED"] as const) {
      const decision = retryReserveDecision({ ...base, attempt: 2, cumulativeUsd: 699, rowsRequiringAttemptExcludingThis: 0 }, policy);
      expect(decision.withinCeiling).toBe(false);
      expect(decision.permitted).toBe(false);
    }
  });
});

function fakeRecord(row: RunManifestRow, attempt: number, status: RunResultRecord["validity"]["status"], category: string | null, costUsd: number): RunResultRecord {
  return {
    schemaVersion: "stage5.m215.run-result.v1", mode: "SYNTHETIC", experimentName: "E",
    preregistrationHash: "p", manifestHash: "m", externalReferenceHash: "x",
    manifestRowId: row.runId, manifestRowOrdinal: row.executionOrder,
    runId: `E:${row.instanceId}:${row.arm}`, attempt, attemptId: `E:${row.instanceId}:${row.arm}#a${attempt}`,
    instanceId: row.instanceId, repo: row.repo, arm: row.arm, pairedTaskId: row.instanceId,
    armOrder: row.armOrder, armOrderIndex: row.armOrderIndex,
    agent: { implementation: "", binary: "", version: "", systemPromptSha256: "", nativeToolCatalogSha256: "", userPromptTemplateSha256: "" },
    modelTarget: "", providerModelIdentity: null, modelIdentityVerified: false,
    vtraceCommit: null, vtraceProductTreeSha: null,
    sourceState: { baseCommit: "", headAtAgentStart: "", trackedSourceDigestBeforeTreatment: "", trackedSourceDigestAfterTreatment: "", canonicalTrackedSourceDigest: "", preAgentUntrackedPaths: [], untrackedSourceAffectingPaths: [] },
    container: { image: "", imageDigest: "", workingDirectory: "", dependencyEnvironment: "" },
    budgets: { identity: "", maxTurns: 0, perRunCostCapUsd: 3.5, wallClockTimeoutSecondsPerRun: 0 },
    startedAt: "", endedAt: "", wallClockSeconds: 0, terminationReason: "AGENT_COMPLETED",
    turnCount: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd,
    treatment: { exposed: false, initialised: false, catalogSha256: null, firstInvocationTurn: null, invokedBeforeFirstEdit: false, toolNames: [], invocationCount: 0, totalOutputBytes: 0, totalLatencyMs: 0, indexBuildSeconds: null, indexSizeBytes: null },
    telemetry: [], capturedPatchSha256: "", capturedPatchBytes: 0, capturedPatchPaths: [], patchCaptureExclusions: [],
    lifecyclePhasesObserved: [], evaluation: null,
    environment: { pathEntries: [], environmentVariableNames: [], cpuLimit: "", memoryLimit: "", networkPolicy: "", redactedVariableNames: [] },
    runtimeGates: [],
    validity: { status, valid: status !== "INFRASTRUCTURE_INVALID", infrastructureCategory: category, reason: "" },
  };
}

describe("rowRequiresAttempt agrees with the executor's retryPermitted", () => {
  test("across every frozen category and attempt number", () => {
    const row = manifest[0]!;
    const categories = [...M214_EXCLUSIONS.legitimate];
    for (const category of categories) {
      for (const attempt of [1, 2]) {
        const ledger = new CohortLedger("SYNTHETIC", "p", "m");
        for (let index = 1; index <= attempt; index += 1) {
          ledger.append(fakeRecord(row, index, "INFRASTRUCTURE_INVALID", category, 0), "t");
        }
        const last = ledger.attemptsFor(row.instanceId, row.arm).at(-1)!;
        expect(rowRequiresAttempt(ledger, row)).toBe(retryPermitted(last).permitted);
      }
    }
    const valid = new CohortLedger("SYNTHETIC", "p", "m");
    valid.append(fakeRecord(row, 1, "VALID_UNRESOLVED", null, 1), "t");
    expect(rowRequiresAttempt(valid, row)).toBe(false);
    expect(retryPermitted(valid.entries[0]!).permitted).toBe(false);
  });
});

describe("completion reserve and operational status", () => {
  test("an empty cohort has $0 reserve and completion guaranteed", () => {
    const ledger = new CohortLedger("SYNTHETIC", "p", "m");
    const reserve = completionReserve(ledger, manifest);
    expect(reserve.rowsRequiringAttempt).toBe(200);
    expect(reserve.completionReserveUsd).toBe(0);
    expect(reserve.fixedNCompletionGuaranteed).toBe(true);
    const status = cohortOperationalStatus(manifest, ledger, new CohortOperationsLedger());
    expect(status.status).toBe("COHORT_NOT_STARTED");
    expect(outcomeShapedKeys(status as unknown as Record<string, unknown>)).toEqual([]);
  });

  test("a rerunnable failure charged at cap makes completion NOT guaranteed", () => {
    const ledger = new CohortLedger("SYNTHETIC", "p", "m");
    ledger.append(fakeRecord(manifest[0]!, 1, "INFRASTRUCTURE_INVALID", "MODEL_SERVICE_FAILURE", M214_BUDGET.perRunCostCapUsd), "t");
    const reserve = completionReserve(ledger, manifest);
    expect(reserve.rowsRequiringAttempt).toBe(200);
    expect(reserve.completionReserveUsd).toBe(-3.5);
    expect(reserve.fixedNCompletionGuaranteed).toBe(false);
    expect(cohortOperationalStatus(manifest, ledger, new CohortOperationsLedger()).status).toBe("COHORT_IN_PROGRESS");
  });

  test("the launch-risk statement is informational, outcome-blind and states the $0 reserve", () => {
    const risk = launchRiskStatement(manifest.length);
    expect(risk.paidRetryReserveUsd).toBe(0);
    expect(risk.maximumPlannedExposureUsd).toBe(700);
    expect(risk.spendAuthorizationStatus).toBe("SPEND_AUTHORIZATION_PENDING");
    expect(risk.informationalOnly).toBe(true);
    expect(outcomeShapedKeys(risk as unknown as Record<string, unknown>)).toEqual([]);
    expect(risk.consequence).toContain("impossible under the frozen $700 ceiling");
  });
});
