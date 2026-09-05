import { describe, expect, test } from "bun:test";

import {
  type TeardownReport,
  CohortOperationsLedger,
  classifyTeardown,
  residualStateIsEmpty,
  residualStateIssues,
  unreportedTeardown,
} from "./m217ContinuationSafety";
import {
  SYNTHETIC_WORK_ROOT,
  SyntheticIsolationProbe,
  emptyResidue,
  staleEvaluatorContainer,
  staleHarnessContainer,
  staleProcess,
  syntheticArmRoot,
  syntheticOperations,
} from "./m217Fixtures";

const CLEAN: TeardownReport = {
  attempted: true, reported: true, containerRemoved: true, mountRemoved: true, armRootRemoved: true,
  errors: [],
};

const FAILED: TeardownReport = {
  ...CLEAN, containerRemoved: false, errors: ["container removal: 500 Server Error"],
};

const scope = {
  workRoot: SYNTHETIC_WORK_ROOT, armRoot: syntheticArmRoot("x", "baseline"), hostMount: null,
  instanceId: "x", runId: "r",
};

describe("classifyTeardown", () => {
  test("clean report and empty enumeration is TEARDOWN_CLEAN and SAFE", async () => {
    const probe = new SyntheticIsolationProbe();
    const residual = await probe.enumerate(scope);
    expect(residualStateIsEmpty(residual)).toBe(true);
    const verdict = classifyTeardown(CLEAN, residual);
    expect(verdict.classification).toBe("TEARDOWN_CLEAN");
    expect(verdict.continuation).toBe("CONTINUATION_SAFE");
  });

  test("a failed report with nothing left behind is PROVEN by absence", async () => {
    const residual = await new SyntheticIsolationProbe().enumerate(scope);
    const verdict = classifyTeardown(FAILED, residual);
    expect(verdict.classification).toBe("TEARDOWN_FAILURE_ISOLATION_PROVEN");
    expect(verdict.continuation).toBe("CONTINUATION_SAFE");
    expect(verdict.reasons.join(" ")).toContain("500 Server Error");
  });

  test("a failed report with a harness container still present is UNPROVEN and BLOCKED", async () => {
    const residue = emptyResidue();
    residue.harnessContainers.push(staleHarnessContainer("x"));
    const residual = await new SyntheticIsolationProbe(residue).enumerate(scope);
    const verdict = classifyTeardown(FAILED, residual);
    expect(verdict.classification).toBe("TEARDOWN_FAILURE_ISOLATION_UNPROVEN");
    expect(verdict.continuation).toBe("CONTINUATION_BLOCKED");
  });

  test("a CLEAN report with residue is still BLOCKED: the enumeration decides", async () => {
    for (const residue of [
      (() => { const r = emptyResidue(); r.evaluatorContainers.push(staleEvaluatorContainer("x")); return r; })(),
      (() => { const r = emptyResidue(); r.liveProcesses.push(staleProcess(SYNTHETIC_WORK_ROOT, "vtrace mcp-serve")); return r; })(),
      (() => { const r = emptyResidue(); r.armRoots.add(scope.armRoot); return r; })(),
      (() => { const r = emptyResidue(); r.openBridgeHandles.push("c1"); return r; })(),
    ]) {
      const residual = await new SyntheticIsolationProbe(residue).enumerate(scope);
      const verdict = classifyTeardown(CLEAN, residual);
      expect(verdict.classification).toBe("RESIDUAL_STATE_AFTER_REPORTED_CLEAN_TEARDOWN");
      expect(verdict.continuation).toBe("CONTINUATION_BLOCKED");
      expect(residualStateIssues(residual).length).toBeGreaterThan(0);
    }
  });

  test("a probe that could not look proves nothing: BLOCKED", async () => {
    const residue = emptyResidue();
    residue.probeErrors.push("docker unreachable");
    const residual = await new SyntheticIsolationProbe(residue).enumerate(scope);
    const verdict = classifyTeardown(CLEAN, residual);
    expect(verdict.classification).toBe("ISOLATION_PROBE_FAILED");
    expect(verdict.continuation).toBe("CONTINUATION_BLOCKED");
  });

  test("an unreported teardown with an empty enumeration is PROVEN, not CLEAN", async () => {
    const residual = await new SyntheticIsolationProbe().enumerate(scope);
    const verdict = classifyTeardown(unreportedTeardown("adapter returned void"), residual);
    expect(verdict.classification).toBe("TEARDOWN_FAILURE_ISOLATION_PROVEN");
    expect(verdict.continuation).toBe("CONTINUATION_SAFE");
  });
});

describe("CohortOperationsLedger", () => {
  test("state is the last event's continuation; empty is SAFE", () => {
    const ledger = new CohortOperationsLedger();
    expect(ledger.state()).toBe("CONTINUATION_SAFE");
    ledger.append("ROW_TEARDOWN", "t1", "CONTINUATION_BLOCKED", { reasons: ["x"] });
    expect(ledger.state()).toBe("CONTINUATION_BLOCKED");
    ledger.append("ISOLATION_RECOVERY_VERIFIED", "t2", "CONTINUATION_SAFE", {});
    expect(ledger.state()).toBe("CONTINUATION_SAFE");
  });

  test("the chain recomputes, and a tampered event is detected", () => {
    const ledger = new CohortOperationsLedger();
    ledger.append("ROW_TEARDOWN", "t1", "CONTINUATION_SAFE", { classification: "TEARDOWN_CLEAN" });
    ledger.append("ROW_TEARDOWN", "t2", "CONTINUATION_SAFE", { classification: "TEARDOWN_CLEAN" });
    expect(ledger.verifyIntegrity()).toEqual([]);
    const tampered = JSON.parse(JSON.stringify(ledger.events)) as { detail: Record<string, unknown> }[];
    tampered[0]!.detail.classification = "TEARDOWN_FAILURE_ISOLATION_UNPROVEN";
    const restored = CohortOperationsLedger.restore(tampered as never);
    expect(restored.issues.length).toBeGreaterThan(0);
  });

  test("blockingEvent names the teardown that halted the cohort", () => {
    const ledger = new CohortOperationsLedger();
    ledger.append("ROW_TEARDOWN", "t1", "CONTINUATION_SAFE", {});
    ledger.append("ROW_TEARDOWN", "t2", "CONTINUATION_BLOCKED", { classification: "X" }, { attemptId: "a2" });
    ledger.append("COHORT_HALTED_ISOLATION_RISK", "t3", "CONTINUATION_BLOCKED", {});
    expect(ledger.blockingEvent()?.attemptId).toBe("a2");
    expect(ledger.blockingEvent()?.kind).toBe("ROW_TEARDOWN");
  });
});

describe("CohortOperations", () => {
  test("recover is only defined from BLOCKED, and requires the second enumeration to be empty", async () => {
    const residue = emptyResidue();
    residue.harnessContainers.push(staleHarnessContainer("x"));
    const { operations, probe } = syntheticOperations(undefined, residue);
    await expect(operations.recover()).rejects.toThrow(/not halted/);

    await operations.recordTeardown({
      row: { runId: "r", instanceId: "x", arm: "baseline" } as never,
      attemptId: "a1", resultDigest: "d".repeat(64), resultStatus: "VALID_UNRESOLVED", scope,
    }, CLEAN);
    expect(operations.state()).toBe("CONTINUATION_BLOCKED");
    expect(operations.auditContinuation()[0]).toContain("COHORT_HALTED_ISOLATION_RISK");

    probe.remediationIneffective = true;
    const failed = await operations.recover();
    expect(failed.kind).toBe("ISOLATION_RECOVERY_FAILED");
    expect(operations.state()).toBe("CONTINUATION_BLOCKED");

    probe.remediationIneffective = false;
    const verified = await operations.recover();
    expect(verified.kind).toBe("ISOLATION_RECOVERY_VERIFIED");
    expect(operations.state()).toBe("CONTINUATION_SAFE");
    expect(operations.ledger.verifyIntegrity()).toEqual([]);
  });

  test("the teardown event carries the result digest it was handed and never a record", async () => {
    const { operations } = syntheticOperations();
    const event = await operations.recordTeardown({
      row: { runId: "r", instanceId: "x", arm: "baseline" } as never,
      attemptId: "a1", resultDigest: "e".repeat(64), resultStatus: "VALID_RESOLVED", scope,
    }, CLEAN);
    expect(event.resultDigest).toBe("e".repeat(64));
    expect(event.detail.resultImmutable).toBe(true);
    expect(Object.keys(event.detail)).not.toContain("record");
  });
});
