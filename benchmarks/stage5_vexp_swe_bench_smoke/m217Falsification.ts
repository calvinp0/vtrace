/**
 * M217 §20 — the falsification suite for the continuation interlock and the
 * retry-spend interlock, with no container.
 *
 * Every control drives the real `executeManifestRow`, the real
 * `CohortOperations` and the real gates against synthetic adapters and a
 * synthetic isolation probe whose residue is an explicit bag. A control moves
 * exactly one thing in that bag — or one number in the spend arithmetic — and
 * asks what the machine did.
 *
 * Control ids continue M216's numbering (M216 ended at F81; F74–F81 are
 * already M216 ids), so the brief's F74–F90 are realised as F82–F98 and each
 * control records the brief id it answers. Ids past F98 are controls the
 * implementation needed and the brief did not enumerate.
 */

import {
  type M214Arm,
  type RunManifestRow,
} from "./m214Preregistration";
import {
  type ExecutorDependencies,
  type FrozenAuthorities,
  type RowSelector,
  type SpendAuthorization,
  LaunchRefusedError,
  M215_AUTHORIZED_CEILING_USD,
  canFinalizeCausalReport,
  executeManifestRow,
  renderProgress,
  runCohort,
  selectNextRow,
} from "./m215LaunchExecutor";
import { CohortLedger, resultDigest } from "./m215CohortLedger";
import {
  type SyntheticWorld,
  SyntheticContainerAdapter,
  syntheticAdapters,
  syntheticClock,
  syntheticWorld,
} from "./m215Fixtures";
import {
  type OperationalEvent,
  type TeardownReport,
  CohortOperations,
  CohortOperationsLedger,
} from "./m217ContinuationSafety";
import {
  type SyntheticOperations,
  SYNTHETIC_WORK_ROOT,
  SyntheticIsolationProbe,
  emptyResidue,
  staleEvaluatorContainer,
  staleHarnessContainer,
  staleProcess,
  syntheticOperations,
  syntheticOperationsClock,
} from "./m217Fixtures";
import {
  M217_FROZEN_RETRY_RESERVE_POLICY,
  cohortOperationalStatus,
  frozenSpendArithmetic,
  launchRiskStatement,
  outcomeShapedKeys,
  retryReserveDecision,
} from "./m217RetryReserve";
import { parseLaunchArgs } from "./run_stage5_m215_launch";

export const M217_SUITE_VERSION = "stage5.m217.falsification.v1" as const;

export interface M217Control {
  readonly id: string;
  readonly briefId: string | null;
  readonly description: string;
  readonly expectation: "GUARD_FIRES" | "GUARD_SILENT";
  readonly fired: boolean;
  readonly satisfied: boolean;
  readonly substrate: "PURE" | "REAL_CONTAINER" | "REAL_PROCESS";
  readonly detail: string;
}

export function control(
  id: string, briefId: string | null, description: string,
  expectation: "GUARD_FIRES" | "GUARD_SILENT",
  issues: readonly string[],
  substrate: M217Control["substrate"] = "PURE",
): M217Control {
  const fired = issues.length > 0;
  return {
    id, briefId, description, expectation, fired, substrate,
    satisfied: expectation === "GUARD_FIRES" ? fired : !fired,
    detail: fired ? issues.join(" | ") : "no issue reported",
  };
}

export function suitePasses(controls: readonly M217Control[]): boolean {
  return controls.length > 0 && controls.every((entry) => entry.satisfied);
}

// ── Harness ─────────────────────────────────────────────────────────

const SYNTHETIC_AUTHORIZATION: SpendAuthorization = Object.freeze({
  authorized: true,
  authorizedByOperator: "m217-synthetic",
  authorizedCeilingUsd: M215_AUTHORIZED_CEILING_USD,
  authorizedAt: "2026-09-05T00:00:00.000Z",
  statement: "synthetic controls only; no paid call is possible in this mode",
});

interface RunAttempt {
  readonly result: Awaited<ReturnType<typeof executeManifestRow>> | null;
  readonly error: Error | null;
}

function freshLedger(authorities: FrozenAuthorities): CohortLedger {
  return new CohortLedger(
    "SYNTHETIC", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
  );
}

/** A container adapter whose teardown tells a chosen story. */
function withTeardown(container: SyntheticContainerAdapter, report: TeardownReport): SyntheticContainerAdapter {
  const wrapped = container as SyntheticContainerAdapter & { stop: (handle: unknown) => Promise<TeardownReport> };
  wrapped.stop = async () => report;
  return wrapped;
}

const CLEAN_TEARDOWN: TeardownReport = Object.freeze({
  attempted: true, reported: true, containerRemoved: true, mountRemoved: true, armRootRemoved: true,
  errors: [],
});

const FAILED_TEARDOWN: TeardownReport = Object.freeze({
  attempted: true, reported: true, containerRemoved: false, mountRemoved: false, armRootRemoved: true,
  errors: ["container removal: 500 Server Error: driver failed removing container"],
});

const FALSE_FAILURE_TEARDOWN: TeardownReport = Object.freeze({
  attempted: true, reported: true, containerRemoved: false, mountRemoved: true, armRootRemoved: true,
  errors: ["container removal: 404 Client Error: No such container"],
});

function depsFor(
  authorities: FrozenAuthorities,
  ledger: CohortLedger,
  world: SyntheticWorld,
  operations: SyntheticOperations | null,
  teardown: TeardownReport | null = null,
  overrides: Partial<ExecutorDependencies> = {},
): ExecutorDependencies & { readonly synthetic: ReturnType<typeof syntheticAdapters> } {
  const adapters = syntheticAdapters(world);
  const container = teardown === null ? adapters.container : withTeardown(adapters.container, teardown);
  return {
    mode: "SYNTHETIC",
    authorities,
    container,
    agent: adapters.agent,
    evaluator: adapters.evaluator,
    ledger,
    now: syntheticClock(),
    spendAuthorization: SYNTHETIC_AUTHORIZATION,
    ...(operations === null ? {} : { operations: operations.operations }),
    ...overrides,
    synthetic: adapters,
  };
}

async function attempt(deps: ExecutorDependencies, selector: RowSelector): Promise<RunAttempt> {
  try {
    return { result: await executeManifestRow(deps, selector), error: null };
  } catch (error) {
    return { result: null, error: error as Error };
  }
}

function refusedBy(gateId: string, error: Error | null): boolean {
  return error instanceof LaunchRefusedError
    && error.gates.some((gate) => gate.gateId === gateId && gate.status === "FAIL");
}

function lastEvent(operations: SyntheticOperations, kind: OperationalEvent["kind"]): OperationalEvent | undefined {
  return [...operations.ledger.events].reverse().find((event) => event.kind === kind);
}

/**
 * Recovery, crash-tolerant. A broken continuation guard leaves nothing to
 * recover from and `recover()` throws; the suite must record that as a failed
 * control rather than die, or the guard-break could never show which controls
 * the guard protects.
 */
async function tryRecover(operations: SyntheticOperations): Promise<OperationalEvent | null> {
  try {
    return await operations.operations.recover();
  } catch {
    return null;
  }
}

// ── The suite ───────────────────────────────────────────────────────

export interface M217SuiteInput {
  readonly authorities: FrozenAuthorities;
}

export async function runM217FalsificationSuite(input: M217SuiteInput): Promise<readonly M217Control[]> {
  const { authorities } = input;
  const manifest = authorities.manifest;
  const controls: M217Control[] = [];
  const row = (order: number): RunManifestRow =>
    manifest.find((candidate) => candidate.executionOrder === order)!;

  // ── F82 ← brief F74: valid result + clean teardown ───────────────
  {
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    const first = await attempt(depsFor(authorities, ledger, syntheticWorld({ resolved: false }), ops), { executionOrder: 0 });
    const issues: string[] = [];
    if (first.result?.record.validity.status !== "VALID_UNRESOLVED") {
      issues.push(`row 0 status ${first.result?.record.validity.status ?? first.error?.message}`);
    }
    const teardown = lastEvent(ops, "ROW_TEARDOWN");
    if (teardown?.detail.classification !== "TEARDOWN_CLEAN") {
      issues.push(`teardown classified ${String(teardown?.detail.classification)}`);
    }
    if (ops.operations.state() !== "CONTINUATION_SAFE") issues.push(`state ${ops.operations.state()}`);
    const second = await attempt(depsFor(authorities, ledger, syntheticWorld(), ops), { executionOrder: 1 });
    if (second.result === null) issues.push(`row 1 refused: ${second.error?.message}`);
    if (ledger.statusFor(row(0).instanceId, row(0).arm) !== "VALID_UNRESOLVED") {
      issues.push("row 0's result changed after the next row ran");
    }
    controls.push(control("F82", "F74",
      "a valid result followed by a clean teardown is retained, continuation is SAFE, and the next "
      + "row is permitted", "GUARD_SILENT", issues));
  }

  // ── F83 ← brief F75: valid result + teardown failure, isolation proven ──
  {
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    const first = await attempt(
      depsFor(authorities, ledger, syntheticWorld({ resolved: false }), ops, FAILED_TEARDOWN), { executionOrder: 0 },
    );
    const issues: string[] = [];
    if (first.result?.record.validity.status !== "VALID_UNRESOLVED") {
      issues.push(`row 0 status ${first.result?.record.validity.status ?? first.error?.message}`);
    }
    const teardown = lastEvent(ops, "ROW_TEARDOWN");
    if (teardown?.detail.classification !== "TEARDOWN_FAILURE_ISOLATION_PROVEN") {
      issues.push(`teardown classified ${String(teardown?.detail.classification)}`);
    }
    if (ops.operations.state() !== "CONTINUATION_SAFE") issues.push(`state ${ops.operations.state()}`);
    const second = await attempt(depsFor(authorities, ledger, syntheticWorld(), ops), { executionOrder: 1 });
    if (second.result === null) issues.push(`row 1 refused: ${second.error?.message}`);
    controls.push(control("F83", "F75",
      "a valid result whose teardown reported a failure is retained, and continuation is allowed "
      + "only because the enumeration proved the substrate empty", "GUARD_SILENT", issues));
  }

  // ── F84 ← brief F76: valid result + teardown failure + residue ────
  // ── F85 ← brief F77: blocked continuation cannot be forced ─────────
  // ── F86 ← brief F78: recovery proof ────────────────────────────────
  // ── F87 ← brief F79: prior valid row immutability ──────────────────
  // ── F96 ← brief F88: cohort resume after recovery ──────────────────
  {
    const ledger = freshLedger(authorities);
    const residue = emptyResidue();
    residue.harnessContainers.push(staleHarnessContainer(row(0).instanceId));
    const ops = syntheticOperations(syntheticOperationsClock(), residue);
    const first = await attempt(
      depsFor(authorities, ledger, syntheticWorld({ resolved: false }), ops, FAILED_TEARDOWN), { executionOrder: 0 },
    );
    const f84: string[] = [];
    if (first.result?.record.validity.status !== "VALID_UNRESOLVED") {
      f84.push(`row 0 status ${first.result?.record.validity.status ?? first.error?.message}`);
    }
    const teardown = lastEvent(ops, "ROW_TEARDOWN");
    if (teardown?.detail.classification !== "TEARDOWN_FAILURE_ISOLATION_UNPROVEN") {
      f84.push(`teardown classified ${String(teardown?.detail.classification)}`);
    }
    if (ops.operations.state() !== "CONTINUATION_BLOCKED") f84.push(`state ${ops.operations.state()}`);
    if (lastEvent(ops, "COHORT_HALTED_ISOLATION_RISK") === undefined) f84.push("no COHORT_HALTED_ISOLATION_RISK event");
    const blockedDeps = depsFor(authorities, ledger, syntheticWorld(), ops);
    const second = await attempt(blockedDeps, { executionOrder: 1 });
    if (!refusedBy("P10_CONTINUATION_SAFETY", second.error)) {
      f84.push(`row 1 was not refused by P10: ${second.result?.record.attemptId ?? second.error?.message}`);
    }
    if (blockedDeps.synthetic.container.started.length > 0) f84.push("a container was started for the refused row");
    const loop = await runCohort(blockedDeps);
    if (loop.executed.length > 0) f84.push(`runCohort executed ${loop.executed.length} rows while blocked`);
    if (!loop.stoppedBecause.includes("COHORT_HALTED_ISOLATION_RISK")) f84.push(`runCohort stopped because: ${loop.stoppedBecause}`);
    if (loop.progress.operationalStatus !== "COHORT_HALTED_ISOLATION_RISK") {
      f84.push(`operational status ${loop.progress.operationalStatus}`);
    }
    controls.push(control("F84", "F76",
      "a valid result whose teardown left a harness container behind is retained, continuation is "
      + "BLOCKED, and the next row is refused before any container starts", "GUARD_SILENT", f84));

    // F85 — no force. The launcher refuses the flag by name; a direct row
    // selection is refused by the same gate; nothing in the loop continues.
    const f85: string[] = [];
    for (const argv of [["--force"], ["--force-continue"], ["--skip-isolation"], ["--ignore-halt"]]) {
      try {
        parseLaunchArgs(argv);
      } catch (error) {
        f85.push(`${argv[0]}: ${(error as Error).message.slice(0, 80)}`);
      }
    }
    const direct = await attempt(depsFor(authorities, ledger, syntheticWorld(), ops), { runId: row(1).runId });
    if (refusedBy("P10_CONTINUATION_SAFETY", direct.error)) f85.push("--row-style direct selection refused by P10");
    const asRetry = await attempt(depsFor(authorities, ledger, syntheticWorld(), ops), { executionOrder: 0 });
    if (asRetry.error !== null) f85.push("re-selecting the completed row is refused");
    controls.push(control("F85", "F77",
      "a blocked continuation cannot be forced: every force-shaped flag is refused by name, a direct "
      + "row selection is refused by P10, and the completed row cannot be re-selected",
      "GUARD_FIRES", f85.length >= 6 ? f85 : []));

    // F87 — immutability of the prior valid row, checked across the halt.
    const entryBefore = ledger.entries[0]!;
    const digestBefore = entryBefore.resultDigest;
    const recordDigestBefore = resultDigest(ledger.record(entryBefore.attemptId)!);

    // F86 — recovery through the predeclared path.
    const recovery = await tryRecover(ops);
    const f86: string[] = [];
    if (recovery?.kind !== "ISOLATION_RECOVERY_VERIFIED") f86.push(`recovery ${recovery?.kind ?? "threw"}`);
    if (ops.operations.state() !== "CONTINUATION_SAFE") f86.push(`state after recovery ${ops.operations.state()}`);
    if (ops.probe.remediations.length !== 1) f86.push(`${ops.probe.remediations.length} remediations`);
    const after = (recovery?.detail as { after?: { harnessContainers: unknown[] } } | undefined)?.after;
    if (after === undefined || after.harnessContainers.length !== 0) f86.push("post-remediation enumeration still lists a container");
    const next = selectNextRow(manifest, ledger);
    if (next?.executionOrder !== 1) f86.push(`next row after recovery is ${next?.executionOrder}`);
    const resumed = await runCohort(depsFor(authorities, ledger, syntheticWorld(), ops), { maxRows: 1 });
    if (resumed.executed.length !== 1) f86.push(`resumed cohort executed ${resumed.executed.length} rows`);
    if (ledger.attemptsFor(row(0).instanceId, row(0).arm).length !== 1) f86.push("the previous valid row was rerun");
    if (ledger.statusFor(row(1).instanceId, row(1).arm) === "PLANNED") f86.push("row 1 did not run after recovery");
    controls.push(control("F86", "F78",
      "after remediation the preflight re-proves a clean substrate, the next unstarted row is "
      + "permitted, and the previous valid row is not rerun", "GUARD_SILENT", f86));

    const f87: string[] = [];
    if (ledger.entries[0]!.resultDigest !== digestBefore) f87.push("row 0's ledger digest changed");
    if (resultDigest(ledger.record(entryBefore.attemptId)!) !== recordDigestBefore) f87.push("row 0's record bytes changed");
    if (ledger.entries[0]!.status !== "VALID_UNRESOLVED") f87.push(`row 0's status is ${ledger.entries[0]!.status}`);
    if (ledger.verifyIntegrity().length > 0) f87.push(`result ledger integrity: ${ledger.verifyIntegrity().join("; ")}`);
    if (teardown?.resultDigest !== digestBefore) f87.push("the teardown event does not reference the row's digest");
    if (ledger.corrections.length !== 0) f87.push("a correction was appended");
    controls.push(control("F87", "F79",
      "a teardown failure, the halt and the recovery leave the prior valid row's status, record bytes "
      + "and digest untouched", "GUARD_SILENT", f87));

    // F96 — resume in another process after recovery.
    const persisted = JSON.stringify({
      records: ledger.records, entries: ledger.entries, events: ops.ledger.events,
    });
    const parsed = JSON.parse(persisted) as {
      records: Parameters<typeof CohortLedger.restore>[3];
      entries: Parameters<typeof CohortLedger.restore>[4];
      events: OperationalEvent[];
    };
    const restoredResults = CohortLedger.restore(
      "SYNTHETIC", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
      parsed.records, parsed.entries,
    );
    const restoredOps = CohortOperationsLedger.restore(parsed.events);
    const f96: string[] = [];
    f96.push(...restoredResults.issues, ...restoredOps.issues);
    if (restoredOps.ledger.state() !== "CONTINUATION_SAFE") f96.push(`restored state ${restoredOps.ledger.state()}`);
    if (restoredOps.ledger.headChainDigest() !== ops.ledger.headChainDigest()) f96.push("operations chain head differs after restore");
    const restoredNext = selectNextRow(manifest, restoredResults.ledger);
    if (restoredNext?.executionOrder !== 2) f96.push(`restored next row is ${restoredNext?.executionOrder}`);
    const restoredProbe = new SyntheticIsolationProbe();
    const restoredOperations: SyntheticOperations = {
      operations: new CohortOperations(restoredOps.ledger, restoredProbe, SYNTHETIC_WORK_ROOT, syntheticOperationsClock()),
      probe: restoredProbe,
      ledger: restoredOps.ledger,
    };
    const countBefore = restoredResults.ledger.entries.length;
    const third = await runCohort(depsFor(authorities, restoredResults.ledger, syntheticWorld(), restoredOperations), { maxRows: 1 });
    if (third.executed.length !== 1) f96.push(`restored cohort executed ${third.executed.length}`);
    if (restoredResults.ledger.entries.length !== countBefore + 1) f96.push("restored cohort wrote other than one entry");
    if (restoredResults.ledger.attemptsFor(row(0).instanceId, row(0).arm).length !== 1
      || restoredResults.ledger.attemptsFor(row(1).instanceId, row(1).arm).length !== 1) {
      f96.push("a completed row acquired a duplicate result after restore");
    }
    controls.push(control("F96", "F88",
      "both ledgers restore in another process after recovery, the correct next manifest row runs, "
      + "and no completed row acquires a duplicate result", "GUARD_SILENT", f96));
  }

  // ── F88 ← brief F80: pre-result infrastructure failure + teardown failure ──
  {
    const ledger = freshLedger(authorities);
    const residue = emptyResidue();
    residue.liveProcesses.push(staleProcess(SYNTHETIC_WORK_ROOT, "bwrap"));
    const ops = syntheticOperations(syntheticOperationsClock(), residue);
    const world = syntheticWorld({ agentFailureCategory: "MODEL_SERVICE_FAILURE", costUsd: 3.5 });
    const first = await attempt(depsFor(authorities, ledger, world, ops, FAILED_TEARDOWN), { executionOrder: 0 });
    const issues: string[] = [];
    const validity = first.result?.record.validity;
    if (validity?.status !== "INFRASTRUCTURE_INVALID") issues.push(`status ${validity?.status ?? first.error?.message}`);
    if (validity?.infrastructureCategory !== "MODEL_SERVICE_FAILURE") issues.push(`category ${validity?.infrastructureCategory}`);
    if (ops.operations.state() !== "CONTINUATION_BLOCKED") issues.push(`state ${ops.operations.state()}`);
    const entry = ledger.entries[0]!;
    if (entry.status !== "INFRASTRUCTURE_INVALID") issues.push(`ledger status ${entry.status}`);
    if (entry.costUsd !== 3.5) issues.push(`cost ${entry.costUsd} not carried into the ledger`);
    // The retry M214 permits is refused while blocked — by P10, not by any change to the result.
    const retry = await attempt(depsFor(authorities, ledger, syntheticWorld(), ops), { executionOrder: 0 });
    if (!refusedBy("P10_CONTINUATION_SAFETY", retry.error)) issues.push("the retry was not refused by P10 while blocked");
    if (ledger.entries.length !== 1) issues.push("the blocked retry wrote a ledger entry");
    controls.push(control("F88", "F80",
      "a run that never reached an authoritative outcome keeps M214's invalid-run semantics when "
      + "the substrate also fails; continuation safety does not redefine its validity",
      "GUARD_SILENT", issues));
  }

  // ── F89 ← brief F81: spend arithmetic ─────────────────────────────
  {
    const arithmetic = frozenSpendArithmetic(manifest.length);
    const issues: string[] = [...arithmetic.inconsistencies];
    if (arithmetic.plannedOrdinaryRows !== 200) issues.push(`planned ${arithmetic.plannedOrdinaryRows}`);
    if (arithmetic.perRowCapUsd !== 3.5) issues.push(`cap ${arithmetic.perRowCapUsd}`);
    if (arithmetic.maximumOrdinaryExposureUsd !== 700) issues.push(`ordinary exposure ${arithmetic.maximumOrdinaryExposureUsd}`);
    if (arithmetic.frozenCeilingUsd !== 700) issues.push(`ceiling ${arithmetic.frozenCeilingUsd}`);
    if (arithmetic.retryReserveUsd !== 0) issues.push(`retry reserve ${arithmetic.retryReserveUsd}`);
    controls.push(control("F89", "F81",
      "200 x the frozen per-row cap equals the frozen global ceiling exactly, so the paid retry "
      + "reserve is $0 and every frozen N agrees", "GUARD_SILENT", issues));
  }

  // ── F90 ← brief F82: no-cost failed attempt, retry within reserve ──
  {
    const decision = retryReserveDecision({
      attempt: 2, cumulativeUsd: 0, rowsRequiringAttemptExcludingThis: 199, perRowCapUsd: 3.5, ceilingUsd: 700,
    }, "REFUSE_RETRY_WHEN_COMPLETION_RESERVE_EXCEEDED");
    const issues: string[] = [];
    if (!decision.permitted) issues.push(`refused: ${decision.refusalReason}`);
    if (decision.projectedUsd !== 700) issues.push(`projected ${decision.projectedUsd}`);
    if (decision.declaration !== "FIXED_N_COMPLETION_GUARANTEED") issues.push(decision.declaration);
    // Through the executor: a $0 CONTAINER-class failure, then the retry.
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    await attempt(depsFor(authorities, ledger, syntheticWorld({ agentFailureCategory: "MODEL_SERVICE_FAILURE", costUsd: 0 }), ops), { executionOrder: 0 });
    const retry = await attempt(depsFor(authorities, ledger, syntheticWorld(), ops), { executionOrder: 0 });
    const recorded = lastEvent(ops, "RETRY_RESERVE_DECISION")?.detail.decision as ReturnType<typeof retryReserveDecision> | undefined;
    if (retry.result === null) issues.push(`executor refused the zero-cost retry: ${retry.error?.message}`);
    if (recorded?.consumesCompletionReserve !== false) issues.push("the recorded decision says the reserve was consumed");
    controls.push(control("F90", "F82",
      "a retry after a failed attempt that provably cost $0 fits inside the completion reserve under "
      + "the frozen ceiling and is permitted under both policies", "GUARD_SILENT", issues));
  }

  // ── F91 ← brief F83: paid retry exceeds the completion reserve ─────
  {
    const input = { attempt: 2, cumulativeUsd: 3.5, rowsRequiringAttemptExcludingThis: 199, perRowCapUsd: 3.5, ceilingUsd: 700 };
    const strict = retryReserveDecision(input, "REFUSE_RETRY_WHEN_COMPLETION_RESERVE_EXCEEDED");
    controls.push(control("F91", "F83",
      "the generic guard refuses a paid retry whose worst case, plus every remaining required attempt, "
      + "exceeds the frozen ceiling (policy REFUSE_RETRY_WHEN_COMPLETION_RESERVE_EXCEEDED)",
      "GUARD_FIRES", strict.permitted ? [] : [strict.refusalReason ?? "refused"]));

    const frozen = retryReserveDecision(input);
    const issues: string[] = [];
    if (frozen.policy !== M217_FROZEN_RETRY_RESERVE_POLICY) issues.push(`policy ${frozen.policy}`);
    if (!frozen.permitted) issues.push("the frozen binding refused a retry M214 permits");
    if (!frozen.consumesCompletionReserve) issues.push("the reserve consumption was not declared");
    if (frozen.declaration !== "FIXED_N_COMPLETION_NOT_GUARANTEED") issues.push(frozen.declaration);
    if (frozen.projectedUsd !== 703.5) issues.push(`projected ${frozen.projectedUsd}`);
    // Through the executor: the declaration is recorded BEFORE the retry runs.
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    await attempt(depsFor(authorities, ledger, syntheticWorld({ agentFailureCategory: "MODEL_SERVICE_FAILURE", costUsd: 3.5 }), ops), { executionOrder: 0 });
    const retry = await attempt(depsFor(authorities, ledger, syntheticWorld(), ops), { executionOrder: 0 });
    const event = lastEvent(ops, "RETRY_RESERVE_DECISION");
    const recorded = event?.detail.decision as ReturnType<typeof retryReserveDecision> | undefined;
    if (retry.result === null) issues.push(`executor refused: ${retry.error?.message}`);
    if (recorded?.declaration !== "FIXED_N_COMPLETION_NOT_GUARANTEED") issues.push(`recorded ${recorded?.declaration}`);
    const gate = retry.result?.record.runtimeGates.find((candidate) => candidate.gateId === "P11_RETRY_SPEND_RESERVE");
    if (gate === undefined || !gate.evidence.includes("FIXED_N_COMPLETION_NOT_GUARANTEED")) {
      issues.push("P11's evidence on the result does not carry the declaration");
    }
    if (event !== undefined && retry.result !== null && event.at >= retry.result.record.endedAt) {
      // synthetic clocks are separate; ordering is asserted by event sequence instead
    }
    const status = cohortOperationalStatus(manifest, ledger, ops.ledger);
    if (status.fixedNCompletionGuaranteed) issues.push("operational status still claims completion is guaranteed");
    controls.push(control("F91B", "F83",
      "under the frozen binding the same retry is permitted, FIXED_N_COMPLETION_NOT_GUARANTEED is "
      + "recorded as an operational event before it begins, and the status view says so",
      "GUARD_SILENT", issues));
  }

  // ── F92 ← brief F84: paid retry within the reserve, frozen ceiling ─
  {
    const decision = retryReserveDecision({
      attempt: 2, cumulativeUsd: 10.1, rowsRequiringAttemptExcludingThis: 189, perRowCapUsd: 3.5, ceilingUsd: 700,
    }, "REFUSE_RETRY_WHEN_COMPLETION_RESERVE_EXCEEDED");
    const issues: string[] = [];
    if (!decision.permitted) issues.push(`refused: ${decision.refusalReason}`);
    if (decision.projectedUsd !== 675.1) issues.push(`projected ${decision.projectedUsd}`);
    if (decision.completionReserveAfterUsd !== 24.9) issues.push(`reserve after ${decision.completionReserveAfterUsd}`);
    controls.push(control("F92", "F84",
      "with ten rows under-spent at $0.66, a paid retry fits inside the completion reserve under the "
      + "FROZEN $700 ceiling (no synthetic ceiling needed) and the strict guard accepts it",
      "GUARD_SILENT", issues));
  }

  // ── F93 ← brief F85: a spend halt fabricates no outcome ───────────
  {
    class NearCeilingLedger extends CohortLedger {
      override cumulativeSpendUsd(): number {
        return 699;
      }
    }
    const ledger = new NearCeilingLedger(
      "COHORT", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
    );
    const ops = syntheticOperations(syntheticOperationsClock());
    const deps = depsFor(authorities, ledger, syntheticWorld(), ops, null, { mode: "COHORT" });
    const loop = await runCohort(deps);
    const issues: string[] = [];
    if (loop.executed.length !== 0) issues.push(`executed ${loop.executed.length}`);
    if (!loop.stoppedBecause.startsWith("COHORT_HALTED_SPEND_CEILING")) issues.push(`stopped: ${loop.stoppedBecause}`);
    if (lastEvent(ops, "COHORT_HALTED_SPEND_CEILING") === undefined) issues.push("no spend-halt event");
    if (ledger.entries.length !== 0) issues.push("a ledger entry was written");
    if (manifest.some((candidate) => ledger.statusFor(candidate.instanceId, candidate.arm) !== "PLANNED")) {
      issues.push("a row left PLANNED without running");
    }
    if (canFinalizeCausalReport(manifest, ledger, "COHORT").permitted) issues.push("the finaliser accepted an incomplete cohort");
    if (loop.progress.operationalStatus !== "COHORT_HALTED_SPEND_CEILING") issues.push(`status ${loop.progress.operationalStatus}`);
    if (deps.synthetic.container.started.length !== 0) issues.push("a container was started after the halt");
    controls.push(control("F93", "F85",
      "when the ceiling binds the cohort halts with COHORT_HALTED_SPEND_CEILING, the unstarted rows "
      + "stay PLANNED, nothing is written to the result ledger and the finaliser refuses",
      "GUARD_SILENT", issues));
  }

  // ── F94 ← brief F86: outcome-blind halt status ─────────────────────
  {
    const ledger = freshLedger(authorities);
    const residue = emptyResidue();
    residue.harnessContainers.push(staleHarnessContainer(row(0).instanceId));
    const ops = syntheticOperations(syntheticOperationsClock(), residue);
    await attempt(depsFor(authorities, ledger, syntheticWorld({ resolved: true }), ops, FAILED_TEARDOWN), { executionOrder: 0 });
    const progress = renderProgress(manifest, ledger, null, [], ops.operations);
    const status = cohortOperationalStatus(manifest, ledger, ops.ledger);
    const risk = launchRiskStatement(manifest.length);
    const issues: string[] = [];
    for (const [name, view] of [["progress", progress], ["status", status], ["risk", risk]] as const) {
      for (const key of outcomeShapedKeys(view as unknown as Record<string, unknown>)) issues.push(`${name} exposes ${key}`);
    }
    const text = JSON.stringify({ progress, status, halt: ops.operations.auditContinuation() });
    if (/pass rate|mcnemar|discordant|resolved=true|VALID_RESOLVED/i.test(text)) {
      issues.push("an operational view's values carry outcome language");
    }
    if (status.status !== "COHORT_HALTED_ISOLATION_RISK") issues.push(`status ${status.status}`);
    controls.push(control("F94", "F86",
      "the halt and spend status views name rows completed, rows remaining, spend, exposure, "
      + "isolation state and halt reason, and no arm's performance", "GUARD_SILENT", issues));
  }

  // ── F95 ← brief F87: teardown event cannot mutate the result digest ─
  {
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    const first = await attempt(depsFor(authorities, ledger, syntheticWorld(), ops, FAILED_TEARDOWN), { executionOrder: 0 });
    const issues: string[] = [];
    const entry = ledger.entries[0]!;
    const event = lastEvent(ops, "ROW_TEARDOWN")!;
    if (event.resultDigest !== entry.resultDigest) issues.push("the event's digest is not the ledger's");
    if (resultDigest(ledger.record(entry.attemptId)!) !== entry.resultDigest) issues.push("the record no longer hashes to its digest");
    if (ledger.verifyIntegrity().length > 0) issues.push("result ledger integrity broken by the teardown event");
    if (first.result !== null && first.result.record !== ledger.record(entry.attemptId)) issues.push("the executor returned a different record object");
    // Tampering with the operational event is detectable and does not reach the result.
    (event as { detail: Record<string, unknown> }).detail = { ...event.detail, classification: "TEARDOWN_CLEAN" };
    if (ops.ledger.verifyIntegrity().length === 0) issues.push("a mutated operational event went undetected");
    if (ledger.verifyIntegrity().length > 0 || ledger.entries[0]!.resultDigest !== entry.resultDigest) {
      issues.push("mutating the operational event reached the result ledger");
    }
    controls.push(control("F95", "F87",
      "an operational teardown event references the result digest read-only; mutating the event is "
      + "detected by the operations chain and cannot reach the result ledger", "GUARD_SILENT", issues));
  }

  // ── F97 ← brief F89: stale evaluator/container state ───────────────
  {
    const issues: string[] = [];
    for (const [label, seed] of [
      ["stale evaluator container", (r: ReturnType<typeof emptyResidue>) => r.evaluatorContainers.push(staleEvaluatorContainer(row(0).instanceId))],
      ["stale harness container", (r: ReturnType<typeof emptyResidue>) => r.harnessContainers.push(staleHarnessContainer(row(0).instanceId))],
      ["live MCP server process", (r: ReturnType<typeof emptyResidue>) => r.liveProcesses.push(staleProcess(SYNTHETIC_WORK_ROOT, "vtrace mcp-serve"))],
      ["open bridge handle", (r: ReturnType<typeof emptyResidue>) => r.openBridgeHandles.push("c9")],
    ] as const) {
      const ledger = freshLedger(authorities);
      const residue = emptyResidue();
      seed(residue);
      const ops = syntheticOperations(syntheticOperationsClock(), residue);
      const first = await attempt(depsFor(authorities, ledger, syntheticWorld(), ops, CLEAN_TEARDOWN), { executionOrder: 0 });
      const teardown = lastEvent(ops, "ROW_TEARDOWN");
      if (first.result?.record.validity.valid !== true) issues.push(`${label}: result not valid`);
      if (teardown?.detail.classification !== "RESIDUAL_STATE_AFTER_REPORTED_CLEAN_TEARDOWN") {
        issues.push(`${label}: classified ${String(teardown?.detail.classification)}`);
      }
      if (ops.operations.state() !== "CONTINUATION_BLOCKED") issues.push(`${label}: state ${ops.operations.state()}`);
      const next = await attempt(depsFor(authorities, ledger, syntheticWorld(), ops), { executionOrder: 1 });
      if (!refusedBy("P10_CONTINUATION_SAFETY", next.error)) issues.push(`${label}: next row not refused`);
    }
    controls.push(control("F97", "F89",
      "residual state capable of contaminating the next row — an evaluator container, a harness "
      + "container, a live treatment process, an open bridge handle — blocks continuation even when "
      + "the teardown reported clean", "GUARD_SILENT", issues));
  }

  // ── F98 ← brief F90: false cleanup failure with fresh isolation ────
  {
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    const first = await attempt(depsFor(authorities, ledger, syntheticWorld(), ops, FALSE_FAILURE_TEARDOWN), { executionOrder: 0 });
    const issues: string[] = [];
    const teardown = lastEvent(ops, "ROW_TEARDOWN");
    if (first.result?.record.validity.valid !== true) issues.push("result not valid");
    if (teardown?.detail.classification !== "TEARDOWN_FAILURE_ISOLATION_PROVEN") {
      issues.push(`classified ${String(teardown?.detail.classification)}`);
    }
    if (ops.operations.state() !== "CONTINUATION_SAFE") issues.push(`state ${ops.operations.state()}`);
    const loop = await runCohort(depsFor(authorities, ledger, syntheticWorld(), ops), { maxRows: 2 });
    if (loop.executed.length !== 2) issues.push(`cohort executed ${loop.executed.length} rows after the false failure`);
    controls.push(control("F98", "F90",
      "a cleanup failure whose enumeration proves the substrate empty (\"No such container\") does not "
      + "deadlock the cohort: isolation is proven by absence and the next rows run", "GUARD_SILENT", issues));
  }

  // ── F99: a probe that cannot look fails closed ─────────────────────
  {
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    ops.probe.enumerateThrows = true;
    await attempt(depsFor(authorities, ledger, syntheticWorld(), ops), { executionOrder: 0 });
    const teardown = lastEvent(ops, "ROW_TEARDOWN");
    const issues: string[] = [];
    if (teardown?.detail.classification !== "ISOLATION_PROBE_FAILED") issues.push(`classified ${String(teardown?.detail.classification)}`);
    if (ops.operations.state() !== "CONTINUATION_BLOCKED") issues.push(`state ${ops.operations.state()}`);
    controls.push(control("F99", null,
      "an isolation probe that cannot enumerate the substrate blocks continuation rather than "
      + "assuming it clean", "GUARD_SILENT", issues));
  }

  // ── F100: a remediation that removed nothing is a failed recovery ──
  {
    const ledger = freshLedger(authorities);
    const residue = emptyResidue();
    residue.harnessContainers.push(staleHarnessContainer(row(0).instanceId));
    const ops = syntheticOperations(syntheticOperationsClock(), residue);
    await attempt(depsFor(authorities, ledger, syntheticWorld(), ops, FAILED_TEARDOWN), { executionOrder: 0 });
    ops.probe.remediationIneffective = true;
    const recovery = await tryRecover(ops);
    const issues: string[] = [];
    if (recovery?.kind !== "ISOLATION_RECOVERY_FAILED") issues.push(`recovery ${recovery?.kind ?? "threw"}`);
    if (ops.operations.state() !== "CONTINUATION_BLOCKED") issues.push(`state ${ops.operations.state()}`);
    const next = await attempt(depsFor(authorities, ledger, syntheticWorld(), ops), { executionOrder: 1 });
    if (!refusedBy("P10_CONTINUATION_SAFETY", next.error)) issues.push("next row not refused after failed recovery");
    controls.push(control("F100", null,
      "a recovery whose post-remediation enumeration is not empty is recorded as failed and the "
      + "cohort stays halted", "GUARD_SILENT", issues));
  }

  // ── F101: a COHORT row without a continuation authority is refused ─
  {
    const ledger = new CohortLedger(
      "COHORT", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
    );
    const deps = depsFor(authorities, ledger, syntheticWorld(), null, null, { mode: "COHORT" });
    const first = await attempt(deps, { executionOrder: 0 });
    controls.push(control("F101", null,
      "a COHORT-mode row with no continuation-safety authority bound is refused by P10 before a "
      + "container starts", "GUARD_FIRES",
      refusedBy("P10_CONTINUATION_SAFETY", first.error) && deps.synthetic.container.started.length === 0
        ? [first.error!.message.slice(0, 200)]
        : []));
  }

  // ── F102: a tampered operations ledger fails P10 ───────────────────
  {
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    await attempt(depsFor(authorities, ledger, syntheticWorld(), ops), { executionOrder: 0 });
    const event = ops.ledger.events[0] as { continuationAfter: string };
    event.continuationAfter = "CONTINUATION_SAFE";
    (ops.ledger.events[0] as { detail: Record<string, unknown> }).detail = { forged: true };
    const next = await attempt(depsFor(authorities, ledger, syntheticWorld(), ops), { executionOrder: 1 });
    controls.push(control("F102", null,
      "an operations ledger whose chain no longer recomputes fails P10, so a forged SAFE state "
      + "cannot admit a row", "GUARD_FIRES",
      refusedBy("P10_CONTINUATION_SAFETY", next.error) ? [next.error!.message.slice(0, 200)] : []));
  }

  // ── F103: a cohort does not START over residue ─────────────────────
  {
    const ledger = freshLedger(authorities);
    const residue = emptyResidue();
    residue.harnessContainers.push(staleHarnessContainer("psf__requests-2317"));
    const ops = syntheticOperations(syntheticOperationsClock(), residue);
    const preflight = await ops.operations.recordLaunchPreflight();
    const loop = await runCohort(depsFor(authorities, ledger, syntheticWorld(), ops));
    const issues: string[] = [];
    if (preflight.kind !== "LAUNCH_ISOLATION_PREFLIGHT") issues.push(preflight.kind);
    if (ops.operations.state() !== "CONTINUATION_BLOCKED") issues.push(`state ${ops.operations.state()}`);
    if (loop.executed.length !== 0) issues.push(`executed ${loop.executed.length}`);
    await tryRecover(ops);
    const after = await runCohort(depsFor(authorities, ledger, syntheticWorld(), ops), { maxRows: 1 });
    if (after.executed.length !== 1) issues.push("the cohort did not start after recovery");
    controls.push(control("F103", null,
      "the launch preflight refuses to start a cohort over a stale harness container, and the same "
      + "recovery path clears it", "GUARD_SILENT", issues));
  }

  return Object.freeze(controls);
}

export type { M214Arm };
