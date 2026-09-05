/**
 * M218 §44, §45 — the falsification suite for the financial amendment and the
 * temporary-space lifecycle, with no container and no provider.
 *
 * Every control drives the real `executeManifestRow`, the real
 * `CohortOperations`, the real `ScratchAuthority` over a REAL directory tree
 * under a uniquely owned namespace, the real gates and the real amendment
 * verification. What is synthetic: the container, agent and evaluator (M215
 * fixtures), the substrate probe's residue bag (M217 fixtures), the liveness
 * facts (an explicit bag) and the capacity reader (an explicit number).
 *
 * Ids continue M217's numbering (M217 ended at F117). The brief's A1–A8 are
 * F118–F125 and T1–T25 are F126–F150; each control records the brief id it
 * answers. Ids past F150 are controls the implementation needed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { M214Arm, RunManifestRow } from "./m214Preregistration";
import {
  type ExecutorDependencies,
  type FrozenAuthorities,
  type RowSelector,
  type SpendAuthorization,
  LaunchRefusedError,
  M215_AUTHORIZED_CEILING_USD,
  M215_EXTERNAL_REFERENCE_FILE,
  M215_MANIFEST_FILE,
  M215_PREREGISTRATION_FILE,
  executeManifestRow,
  renderProgress,
  runCohort,
  selectNextRow,
} from "./m215LaunchExecutor";
import { CohortLedger, type RunResultRecord } from "./m215CohortLedger";
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
import { type M217Control, control, suitePasses } from "./m217Falsification";
import { SyntheticIsolationProbe, emptyResidue, syntheticOperationsClock } from "./m217Fixtures";
import { outcomeShapedKeys } from "./m217RetryReserve";
import {
  M214_A1_FILE,
  M218_FROZEN_AMENDMENT_HASH,
  auditAmendment,
  buildAmendmentDocument,
  m214A1AmendmentHash,
  verifyAmendment,
} from "./m218Amendment";
import { ScratchAwareIsolationProbe } from "./m218IsolationProbe";
import {
  type ScratchClaim,
  type ScratchPolicy,
  M218_SCRATCH_POLICY,
  ScratchAuthority,
  ScratchRegistry,
  ScratchSafetyError,
  SyntheticLivenessProbe,
  establishNamespace,
  measureTree,
  removeTreeNoFollow,
  sweepNamespace,
} from "./m218ScratchLifecycle";
import {
  type ActiveSpendAuthority,
  activeSpendAuthorityFromDocument,
  admitRetry,
  loadActiveSpendAuthority,
  retryReserveAccounting,
} from "./m218SpendAuthority";

export const M218_SUITE_VERSION = "stage5.m218.falsification.v1" as const;

export { control, suitePasses };
export type { M217Control as M218Control };

// ── Harness ─────────────────────────────────────────────────────────

const SYNTHETIC_AUTHORIZATION = (ceiling: number): SpendAuthorization => Object.freeze({
  authorized: true,
  authorizedByOperator: "m218-synthetic",
  authorizedCeilingUsd: ceiling,
  authorizedAt: "2026-09-05T00:00:00.000Z",
  statement: "synthetic controls only; no paid call is possible in this mode",
});

interface RunAttempt {
  readonly result: Awaited<ReturnType<typeof executeManifestRow>> | null;
  readonly error: Error | null;
}

function freshLedger(authorities: FrozenAuthorities, mode: "SYNTHETIC" | "COHORT" = "SYNTHETIC"): CohortLedger {
  return new CohortLedger(mode, authorities.preregistrationHash.actual, authorities.manifestHash.actual);
}

function withTeardown(container: SyntheticContainerAdapter, report: TeardownReport): SyntheticContainerAdapter {
  (container as SyntheticContainerAdapter & { stop: (handle: unknown) => Promise<TeardownReport> }).stop = async () => report;
  return container;
}

const CONTAINER_NOT_REMOVED: TeardownReport = Object.freeze({
  attempted: true, reported: true, containerRemoved: false, mountRemoved: false, armRootRemoved: false,
  errors: ["container removal: 500 Server Error: driver failed removing container"],
});

/** A real, uniquely owned namespace under the host's temporary directory (§49). */
export interface ScratchWorld {
  readonly base: string;
  readonly cohortDir: string;
  readonly authority: ScratchAuthority;
  readonly liveness: SyntheticLivenessProbe;
  readonly probe: SyntheticIsolationProbe;
  readonly operations: CohortOperations;
  readonly operationsLedger: CohortOperationsLedger;
  readonly capacity: { freeBytes: number; freeInodes: number };
  dispose(): void;
}

export function scratchWorld(
  policy: ScratchPolicy = M218_SCRATCH_POLICY,
  residue = emptyResidue(),
): ScratchWorld {
  const base = mkdtempSync(join(tmpdir(), "vtrace-stage5-m218-research-"));
  const cohortDir = join(base, "cohort");
  const namespace = establishNamespace(join(cohortDir, "_work"), { experiment: "M218_RESEARCH_NON_EVALUATION", cohortDir });
  const liveness = new SyntheticLivenessProbe();
  const capacity = { freeBytes: policy.hostSafetyReserveBytes + policy.projectedAttemptScratchBytes + 10 * 1024 ** 3, freeInodes: 50_000_000 };
  const authority = new ScratchAuthority({
    namespace,
    registry: new ScratchRegistry(join(cohortDir, "_scratch_registry")),
    evidenceDir: join(cohortDir, "evidence"),
    liveness,
    experiment: "M218_RESEARCH_NON_EVALUATION",
    executorVersion: "m218-suite",
    policy,
    capacityOf: (path) => ({
      path, totalBytes: 4 * capacity.freeBytes, freeBytes: capacity.freeBytes, freeFraction: 0.25,
      totalInodes: 4 * capacity.freeInodes, freeInodes: capacity.freeInodes, measuredAt: "2026-09-05T00:00:00.000Z",
    }),
    sharedTmpPath: null,
    now: syntheticOperationsClock(),
  });
  const probe = new SyntheticIsolationProbe(residue);
  const operationsLedger = new CohortOperationsLedger();
  const operations = new CohortOperations(
    operationsLedger, new ScratchAwareIsolationProbe(probe, authority, syntheticOperationsClock()),
    namespace.canonicalRoot, syntheticOperationsClock(),
  );
  return {
    base, cohortDir, authority, liveness, probe, operations, operationsLedger, capacity,
    dispose: () => rmSync(base, { recursive: true, force: true }),
  };
}

interface DepsOptions {
  readonly teardown?: TeardownReport;
  readonly spendAuthority?: ActiveSpendAuthority;
  readonly mode?: "SYNTHETIC" | "COHORT";
  /** Replace the synthetic agent with one that writes into the attempt's private /tmp. */
  readonly agentWrites?: (spec: { readonly scratch?: { readonly path: string; readonly agentTmp: string } }) => void;
  readonly agentThrows?: Error;
}

function depsFor(
  authorities: FrozenAuthorities, ledger: CohortLedger, world: SyntheticWorld, scratch: ScratchWorld, options: DepsOptions = {},
): ExecutorDependencies & { readonly synthetic: ReturnType<typeof syntheticAdapters> } {
  const adapters = syntheticAdapters(world);
  const container = options.teardown === undefined ? adapters.container : withTeardown(adapters.container, options.teardown);
  const baseAgent = adapters.agent;
  const agent = options.agentWrites === undefined && options.agentThrows === undefined
    ? baseAgent
    : {
      run: async (spec: Parameters<typeof baseAgent.run>[0], hooks: Parameters<typeof baseAgent.run>[1]) => {
        options.agentWrites?.(spec);
        if (options.agentThrows !== undefined) throw options.agentThrows;
        return baseAgent.run(spec, hooks);
      },
    };
  return {
    mode: options.mode ?? "SYNTHETIC",
    authorities,
    container,
    agent,
    evaluator: adapters.evaluator,
    ledger,
    now: syntheticClock(),
    spendAuthorization: SYNTHETIC_AUTHORIZATION(options.spendAuthority?.hardCeilingUsd ?? M215_AUTHORIZED_CEILING_USD),
    operations: scratch.operations,
    scratch: scratch.authority,
    ...(options.spendAuthority === undefined ? {} : { spendAuthority: options.spendAuthority }),
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

function lastEvent(ledger: CohortOperationsLedger, kind: OperationalEvent["kind"]): OperationalEvent | undefined {
  return [...ledger.events].reverse().find((event) => event.kind === kind);
}

function scratchOf(event: OperationalEvent | undefined): Record<string, unknown> | null {
  const teardown = (event?.detail as { teardown?: { scratch?: Record<string, unknown> } } | undefined)?.teardown;
  return teardown?.scratch ?? null;
}

function claimsFor(scratch: ScratchWorld, row: RunManifestRow): readonly ScratchClaim[] {
  return scratch.authority.registry.claimsForPath(scratch.authority.pathFor(row));
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function committedBytes(resultsDir: string, file: string, commit: string): { working: string; committed: string } {
  const working = sha256(readFileSync(join(resultsDir, file)));
  const committed = sha256(execFileSync("git", [
    "-C", join(resultsDir, "..", "..", ".."), "show", `${commit}:benchmarks/stage5_vexp_swe_bench_smoke/results/${file}`,
  ]));
  return { working, committed };
}

/** Build a ledger with N retries already spent, for the exhaustion controls. */
function ledgerWithRetries(
  authorities: FrozenAuthorities, rows: readonly RunManifestRow[], retries: number, costUsd: number,
): CohortLedger {
  const ledger = freshLedger(authorities);
  let tick = 0;
  const push = (row: RunManifestRow, attemptNo: number, status: "VALID_UNRESOLVED" | "INFRASTRUCTURE_INVALID", category: string | null, cost: number): void => {
    tick += 1;
    const record = {
      schemaVersion: "stage5.m215.run-result.v1", mode: "SYNTHETIC", experimentName: "VTRACE_EXTERNAL_VEXP_100",
      preregistrationHash: authorities.preregistrationHash.actual, manifestHash: authorities.manifestHash.actual,
      externalReferenceHash: authorities.externalReferenceHash.actual,
      manifestRowId: row.runId, manifestRowOrdinal: row.executionOrder, runId: row.runId,
      attempt: attemptNo, attemptId: `${row.runId}#a${attemptNo}#s${tick}`, instanceId: row.instanceId, repo: row.repo, arm: row.arm,
      pairedTaskId: row.pairedTaskId, armOrder: row.armOrder, armOrderIndex: row.armOrderIndex,
      agent: { implementation: "x", binary: "x", version: "x", systemPromptSha256: "x", nativeToolCatalogSha256: "x", userPromptTemplateSha256: "x" },
      modelTarget: "x", providerModelIdentity: "x", modelIdentityVerified: true, vtraceCommit: null, vtraceProductTreeSha: null,
      sourceState: { baseCommit: "x", headAtAgentStart: "x", trackedSourceDigestBeforeTreatment: "x", trackedSourceDigestAfterTreatment: "x", canonicalTrackedSourceDigest: "x", preAgentUntrackedPaths: [], untrackedSourceAffectingPaths: [] },
      container: { image: "x", imageDigest: "x", workingDirectory: "/testbed", dependencyEnvironment: "x" },
      budgets: { identity: row.budgetIdentity, maxTurns: row.maxTurns, perRunCostCapUsd: row.perRunCostCapUsd, wallClockTimeoutSecondsPerRun: 3600 },
      startedAt: "2026-09-05T00:00:00.000Z", endedAt: "2026-09-05T00:01:00.000Z", wallClockSeconds: 60,
      terminationReason: "AGENT_COMPLETED", turnCount: 1, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: cost,
      treatment: { exposed: false, initialised: false, catalogSha256: null, firstInvocationTurn: null, invokedBeforeFirstEdit: false, toolNames: [], invocationCount: 0, totalOutputBytes: 0, totalLatencyMs: 0, indexBuildSeconds: null, indexSizeBytes: null },
      telemetry: [], capturedPatchSha256: "x", capturedPatchBytes: 0, capturedPatchPaths: [], patchCaptureExclusions: [],
      lifecyclePhasesObserved: [], evaluation: null,
      environment: { pathEntries: [], environmentVariableNames: [], cpuLimit: "x", memoryLimit: "x", networkPolicy: "x", redactedVariableNames: [] },
      runtimeGates: [],
      validity: { status, valid: status === "VALID_UNRESOLVED", infrastructureCategory: category, reason: `synthetic ${category ?? "valid"}` },
    } as unknown as RunResultRecord;
    ledger.append(record, `2026-09-05T00:${String(tick).padStart(2, "0")}:00.000Z`);
  };
  for (let index = 0; index < retries; index += 1) {
    push(rows[index]!, 1, "INFRASTRUCTURE_INVALID", "MODEL_SERVICE_FAILURE", costUsd);
    push(rows[index]!, 2, "VALID_UNRESOLVED", null, costUsd);
  }
  push(rows[retries]!, 1, "INFRASTRUCTURE_INVALID", "MODEL_SERVICE_FAILURE", costUsd);
  return ledger;
}

// ── The suite ───────────────────────────────────────────────────────

export interface M218SuiteInput {
  readonly authorities: FrozenAuthorities;
  readonly resultsDir: string;
  /** The predecessor's final HEAD, against which the frozen artifacts are compared byte for byte. */
  readonly predecessorHead: string;
}

export async function runM218FalsificationSuite(input: M218SuiteInput): Promise<readonly M217Control[]> {
  const { authorities, resultsDir } = input;
  const manifest = authorities.manifest;
  const controls: M217Control[] = [];
  const row = (order: number): RunManifestRow => manifest.find((candidate) => candidate.executionOrder === order)!;
  const authority = loadActiveSpendAuthority(resultsDir);
  const frozen = {
    preregistrationHash: authorities.preregistrationHash.actual,
    manifestHash: authorities.manifestHash.actual,
    externalReferenceHash: authorities.externalReferenceHash.actual,
  };

  // ════════════════ §44 — the financial amendment ════════════════════

  // ── F118 ← A1: original M214 bytes unchanged ──────────────────────
  {
    const issues: string[] = [];
    for (const file of [M215_PREREGISTRATION_FILE, M215_MANIFEST_FILE, M215_EXTERNAL_REFERENCE_FILE, "stage5_m214_preregistration_hash.json", "stage5_m213_preregistration.json"]) {
      const bytes = committedBytes(resultsDir, file, input.predecessorHead);
      if (bytes.working !== bytes.committed) issues.push(`${file} differs from ${input.predecessorHead.slice(0, 8)}`);
    }
    controls.push(control("F118", "A1", "the original M214 preregistration, manifest, external reference and hash record (and M213) are byte-identical to the M217 HEAD blobs", "GUARD_SILENT", issues));
  }

  // ── F119 ← A2: original M214 hash unchanged ───────────────────────
  {
    const issues: string[] = [];
    if (!authorities.preregistrationHash.verified) issues.push("preregistration does not recompute to the frozen digest");
    if (authorities.preregistrationHash.actual !== "3cd3b3d2d665c559fdb66e7274e809245e82ea7373344cf32614833b8dcbfea4") issues.push("preregistration digest moved");
    if (authority.executableAuthority.preregistrationHash !== authorities.preregistrationHash.actual) issues.push("the amendment's parent is not the frozen preregistration");
    controls.push(control("F119", "A2", "the M214 preregistration hash recomputes unchanged and is the amendment's parent", "GUARD_SILENT", issues));
  }

  // ── F120 ← A3: the amendment can change only the financial reserve ─
  {
    const fired: string[] = [];
    const base = buildAmendmentDocument("2026-09-05T00:00:00.000Z");
    for (const [key, value] of [["model", "claude-opus-4-6"], ["tasks", ["x"]], ["statisticalPlan", { test: "mcnemar" }], ["maxTurns", 300], ["arms", ["a", "b", "c"]]] as const) {
      const mutated = { ...base, [key]: value };
      const audit = auditAmendment(mutated);
      if (audit.some((issue) => issue.includes(`'${key}'`))) fired.push(`${key}: refused by audit`);
      let bound: string;
      try {
        activeSpendAuthorityFromDocument({ ...mutated, amendmentHash: m214A1AmendmentHash(mutated) }, "memory");
        bound = "BOUND";
      } catch (error) {
        bound = `refused: ${(error as Error).message.slice(0, 60)}`;
      }
      if (bound !== "BOUND") fired.push(`${key}: ${bound}`);
    }
    // Through the executor: a forged authority with a moved digest fails P12.
    const scratch = scratchWorld();
    try {
      const forged = { ...authority, amendmentHash: "1".repeat(64) };
      const first = await attempt(depsFor(authorities, freshLedger(authorities), syntheticWorld(), scratch, { spendAuthority: forged }), { executionOrder: 0 });
      if (refusedBy("P12_EXECUTABLE_AUTHORITY", first.error)) fired.push("forged amendment digest refused by P12");
    } finally {
      scratch.dispose();
    }
    controls.push(control("F120", "A3", "an amendment that names a task, model, analysis, turn budget or arm set is refused by the audit, cannot bind as an authority, and a forged digest is refused by P12", "GUARD_FIRES", fired.length >= 11 ? fired : []));
  }

  // ── F121 ← A4: the manifest is still 200 rows ─────────────────────
  {
    const issues: string[] = [];
    if (manifest.length !== 200) issues.push(`manifest has ${manifest.length} rows`);
    if (!authorities.manifestHash.verified) issues.push("manifest does not recompute");
    if (authority.manifestRows !== 200 || authority.intendedValidOutcomes !== 200) issues.push("the amendment does not declare 200 rows / 200 outcomes");
    controls.push(control("F121", "A4", "the frozen manifest remains 200 rows with its frozen digest, and the amendment declares 200 intended valid outcomes, not 210", "GUARD_SILENT", issues));
  }

  // ── F122 ← A5: exactly ten attempts / $35 / $735 ──────────────────
  {
    const issues: string[] = [];
    if (authority.retryReserveAttempts !== 10) issues.push(`attempts ${authority.retryReserveAttempts}`);
    if (authority.retryReserveUsd !== 35) issues.push(`reserve $${authority.retryReserveUsd}`);
    if (authority.ordinaryExposureUsd !== 700) issues.push(`ordinary $${authority.ordinaryExposureUsd}`);
    if (authority.hardCeilingUsd !== 735) issues.push(`ceiling $${authority.hardCeilingUsd}`);
    if (authority.amendmentHash !== M218_FROZEN_AMENDMENT_HASH) issues.push("amendment digest is not the pinned constant");
    const document = JSON.parse(readFileSync(join(resultsDir, M214_A1_FILE), "utf8")) as Record<string, unknown>;
    const verification = verifyAmendment(document);
    if (!verification.verified) issues.push(...verification.issues);
    if (document.outcomeBearingRunsBeforeAmendment !== 0) issues.push("the amendment does not record 0 outcome-bearing runs before it");
    controls.push(control("F122", "A5", "the committed amendment verifies to the pinned digest and states 10 attempts x $3.50 = $35 over $700 = $735, decided before any outcome", "GUARD_SILENT", issues));
  }

  // ── F123 ← A6: the eleventh maximum-cost retry is refused ─────────
  {
    const fired: string[] = [];
    const rows = [...manifest].sort((a, b) => a.executionOrder - b.executionOrder).slice(0, 12);
    const ledger = ledgerWithRetries(authorities, rows, 10, 3.5);
    const accounting = retryReserveAccounting(authority, ledger);
    if (accounting.exhausted && accounting.retryAttemptsRemaining === 0 && accounting.retryReserveRemainingUsd === 0) fired.push("reserve exhausted after ten $3.50 retries");
    const record = admitRetry(authority, ledger, rows[10]!);
    if (record !== null && !record.permitted && record.refusal === "RETRY_RESERVE_EXHAUSTED") fired.push("eleventh retry refused RETRY_RESERVE_EXHAUSTED");
    const scratch = scratchWorld();
    try {
      const deps = depsFor(authorities, ledger, syntheticWorld(), scratch, { spendAuthority: authority });
      const direct = await attempt(deps, { runId: rows[10]!.runId });
      if (refusedBy("P11_RETRY_SPEND_RESERVE", direct.error) && deps.synthetic.container.started.length === 0) fired.push("direct row selection refused by P11 before a container");
      const loop = await runCohort(deps);
      if (loop.executed.length === 0 && loop.stoppedBecause.startsWith("COHORT_HALTED_RETRY_RESERVE_EXHAUSTED")) fired.push("cohort loop halted COHORT_HALTED_RETRY_RESERVE_EXHAUSTED");
      if (loop.progress.operationalStatus === "COHORT_HALTED_RETRY_RESERVE_EXHAUSTED") fired.push("operational status names the halt");
      if (lastEvent(scratch.operationsLedger, "COHORT_HALTED_RETRY_RESERVE_EXHAUSTED") !== undefined) fired.push("halt recorded as an operational event");
      if (ledger.entries.length === 21) fired.push("no result was written for the refused retry");
    } finally {
      scratch.dispose();
    }
    controls.push(control("F123", "A6", "after ten maximum-cost retries the eleventh is refused RETRY_RESERVE_EXHAUSTED by the accounting, by P11 on direct selection, and the cohort loop halts as its own end state without asking for more budget", "GUARD_FIRES", fired.length >= 7 ? fired : []));
  }

  // ── F124 ← A7: a retry class not preregistered is refused with reserve intact ─
  {
    const fired: string[] = [];
    const ledger = freshLedger(authorities);
    const scratch = scratchWorld();
    try {
      await attempt(depsFor(authorities, ledger, syntheticWorld({ agentFailureCategory: "PATCH_EXTRACTION_FAILURE", costUsd: 1 }), scratch, { spendAuthority: authority }), { executionOrder: 0 });
      const record = admitRetry(authority, ledger, row(0));
      if (record !== null && !record.permitted && record.refusal === "RETRY_CLASS_NOT_PREREGISTERED" && !record.accountingBefore.exhausted) fired.push("refused RETRY_CLASS_NOT_PREREGISTERED with 10 slots and $35 intact");
      const retry = await attempt(depsFor(authorities, ledger, syntheticWorld(), scratch, { spendAuthority: authority }), { executionOrder: 0 });
      if (retry.error !== null && (refusedBy("P6_EXECUTION_ORDER", retry.error) || refusedBy("P11_RETRY_SPEND_RESERVE", retry.error))) fired.push("executor refused the non-preregistered retry");
    } finally {
      scratch.dispose();
    }
    controls.push(control("F124", "A7", "a retry whose prior failure is not on M214's rerunnable list is refused even though the whole reserve remains", "GUARD_FIRES", fired.length >= 2 ? fired : []));
  }

  // ── F125 ← A8: the external VEXP reference is unaffected ──────────
  {
    const issues: string[] = [];
    if (!authorities.externalReferenceHash.verified) issues.push("external reference does not recompute");
    if (authorities.externalReferenceHash.actual !== "822c4c5fb69dc21b8ada04189e73fcadb3e5ab1bf7c06a855dd4582a6ec7834b") issues.push("external reference digest moved");
    if (authority.executableAuthority.externalReferenceHash !== authorities.externalReferenceHash.actual) issues.push("the amendment's external-reference parent differs");
    controls.push(control("F125", "A8", "the external VEXP reference digest is unchanged and is the amendment's parent; the amendment neither cites nor alters it", "GUARD_SILENT", issues));
  }

  // ── F125B, F125C ← §60: M214 alone is no longer launchable ────────
  {
    const scratch = scratchWorld();
    try {
      const alone = await attempt(depsFor(authorities, freshLedger(authorities, "COHORT"), syntheticWorld(), scratch, { mode: "COHORT" }), { executionOrder: 0 });
      controls.push(control("F125B", null, "a COHORT row with no executable authority bound (M214's $700 alone) is refused by P12 before a container starts", "GUARD_FIRES",
        refusedBy("P12_EXECUTABLE_AUTHORITY", alone.error) ? [alone.error!.message.slice(0, 200)] : []));
      const deps = depsFor(authorities, freshLedger(authorities, "COHORT"), syntheticWorld(), scratch, { mode: "COHORT", spendAuthority: authority });
      const oldCeiling = await attempt({ ...deps, spendAuthorization: SYNTHETIC_AUTHORIZATION(700) }, { executionOrder: 0 });
      controls.push(control("F125C", null, "an operator authorisation of the original $700 ceiling is refused by P7 once A1 is the active authority ($735)", "GUARD_FIRES",
        refusedBy("P7_SPEND_AUTHORIZATION", oldCeiling.error) ? [oldCeiling.error!.message.slice(0, 200)] : []));
    } finally {
      scratch.dispose();
    }
  }

  // ════════════════ §45 — the temporary lifecycle ════════════════════

  // ── F126 ← T1: normal attempt cleanup ─────────────────────────────
  // ── F127 ← T2: agent-created file in the private /tmp is removed ──
  {
    const scratch = scratchWorld();
    try {
      const ledger = freshLedger(authorities);
      let seenAgentTmp: string | null = null;
      const first = await attempt(depsFor(authorities, ledger, syntheticWorld({ resolved: false }), scratch, {
        agentWrites: (spec) => {
          seenAgentTmp = spec.scratch?.agentTmp ?? null;
          if (spec.scratch !== undefined) writeFileSync(join(spec.scratch.agentTmp, "agent-created-file"), Buffer.alloc(4096, 1));
        },
      }), { executionOrder: 0 });
      const f126: string[] = [];
      if (first.result?.record.validity.status !== "VALID_UNRESOLVED") f126.push(`status ${first.result?.record.validity.status ?? first.error?.message}`);
      const teardown = lastEvent(scratch.operationsLedger, "ROW_TEARDOWN");
      const record = scratchOf(teardown);
      if (record?.cleanupStatus !== "CLEANED" || record.cleanupVerified !== true) f126.push(`cleanup ${String(record?.cleanupStatus)} verified ${String(record?.cleanupVerified)}`);
      if (record?.scratchBytesAfterCleanup !== 0) f126.push(`bytes after cleanup ${String(record?.scratchBytesAfterCleanup)}`);
      if (Number(record?.scratchHighWaterBytes ?? 0) <= 0) f126.push("no high-water recorded");
      if (existsSync(scratch.authority.pathFor(row(0)))) f126.push("attempt path still exists");
      if (teardown?.detail.classification !== "TEARDOWN_CLEAN") f126.push(`classified ${String(teardown?.detail.classification)}`);
      if (scratch.operations.state() !== "CONTINUATION_SAFE") f126.push(`state ${scratch.operations.state()}`);
      const claims = claimsFor(scratch, row(0));
      if (claims.length !== 1 || claims[0]!.state !== "RELEASED") f126.push("claim not released");
      controls.push(control("F126", "T1", "a normal attempt claims owned scratch, records checkpoints, and cleanup leaves 0 run-owned bytes, a released claim, TEARDOWN_CLEAN and SAFE continuation", "GUARD_SILENT", f126));

      const f127: string[] = [];
      if (seenAgentTmp === null) f127.push("the agent was not handed a private /tmp");
      else if (existsSync(seenAgentTmp) || existsSync(join(seenAgentTmp, "agent-created-file"))) f127.push("the agent-created file survived the attempt");
      if (seenAgentTmp !== null && !seenAgentTmp.startsWith(scratch.authority.namespace.canonicalRoot)) f127.push("the private /tmp is outside the namespace");
      controls.push(control("F127", "T2", "a file the agent creates in its private /tmp lives inside the owned attempt path and is removed after the attempt", "GUARD_SILENT", f127));
    } finally {
      scratch.dispose();
    }
  }

  // ── F128 ← T3: large nested tree ──────────────────────────────────
  {
    const scratch = scratchWorld();
    try {
      const ledger = freshLedger(authorities);
      const first = await attempt(depsFor(authorities, ledger, syntheticWorld(), scratch, {
        agentWrites: (spec) => {
          if (spec.scratch === undefined) return;
          for (let index = 0; index < 120; index += 1) {
            const dir = join(spec.scratch.agentTmp, `a${index % 6}`, `b${index % 5}`, `c${index}`);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "blob"), Buffer.alloc(8192, index));
          }
          mkdirSync(join(spec.scratch.path, "testbed", "build"), { recursive: true });
          writeFileSync(join(spec.scratch.path, "testbed", "build", "big"), Buffer.alloc(2 * 1024 * 1024, 3));
        },
      }), { executionOrder: 0 });
      const issues: string[] = [];
      const record = scratchOf(lastEvent(scratch.operationsLedger, "ROW_TEARDOWN"));
      if (first.result === null) issues.push(first.error?.message ?? "no result");
      if (record?.cleanupVerified !== true) issues.push(`cleanup ${String(record?.cleanupStatus)}`);
      if (Number(record?.scratchHighWaterBytes ?? 0) < 2 * 1024 * 1024) issues.push(`high-water ${String(record?.scratchHighWaterBytes)}`);
      if (existsSync(scratch.authority.pathFor(row(0)))) issues.push("tree survived");
      controls.push(control("F128", "T3", "a substantial nested tree (hundreds of entries, megabytes) is removed completely and its high-water is recorded", "GUARD_SILENT", issues));
    } finally {
      scratch.dispose();
    }
  }

  // ── F129 ← T4: no ownership proof → not deleted ───────────────────
  // ── F130 ← T5: unrelated temp untouched ───────────────────────────
  // ── F145 ← T20: unknown path outside the namespace never deleted ──
  {
    const scratch = scratchWorld();
    try {
      const unrelated = join(scratch.base, "unrelated-user-temp");
      mkdirSync(unrelated);
      writeFileSync(join(unrelated, "keep.txt"), "user data");
      const unregistered = join(scratch.authority.namespace.canonicalRoot, "leftover-without-claim");
      mkdirSync(unregistered);
      writeFileSync(join(unregistered, "x"), "x");
      const ledger = freshLedger(authorities);
      await attempt(depsFor(authorities, ledger, syntheticWorld(), scratch), { executionOrder: 0 });
      const sweep = scratch.authority.sweep();
      const f129: string[] = [];
      const entry = sweep.entries.find((candidate) => candidate.path === unregistered);
      if (entry?.classification !== "UNKNOWN") f129.push(`classified ${entry?.classification}`);
      if (!existsSync(join(unregistered, "x"))) f129.push("the unregistered path was deleted");
      if (sweep.pass) f129.push("the sweep passed over an unknown path");
      // A forged claim over the unregistered path is refused by the registry check.
      const forged: ScratchClaim = { ...claimsFor(scratch, row(0))[0]!, claimId: "forged", path: unregistered };
      const report = scratch.authority.cleanup(forged, { containerRemoved: true });
      if (report.status !== "REFUSED_NOT_OWNED") f129.push(`forged cleanup ${report.status}`);
      if (!existsSync(join(unregistered, "x"))) f129.push("the forged cleanup deleted the path");
      controls.push(control("F129", "T4", "a path under the namespace with no registered claim is classified UNKNOWN, blocks launch, and is never deleted, even by a forged claim", "GUARD_SILENT", f129));

      const f130: string[] = [];
      if (readFileSync(join(unrelated, "keep.txt"), "utf8") !== "user data") f130.push("unrelated temp altered");
      try {
        removeTreeNoFollow(scratch.authority.namespace, unrelated);
        f130.push("cleanup accepted a path outside the namespace");
      } catch (error) {
        if (!(error instanceof ScratchSafetyError)) f130.push(`unexpected error ${(error as Error).message}`);
      }
      if (!existsSync(join(unrelated, "keep.txt"))) f130.push("unrelated temp deleted");
      controls.push(control("F130", "T5", "an unrelated user temporary directory beside the namespace is untouched by attempts, sweeps and a direct cleanup request", "GUARD_SILENT", f130));
      // A FRESH directory outside the namespace, so this control cannot fire
      // merely because an earlier control's target is already gone.
      const outsideFresh = join(scratch.base, "unrelated-fresh-for-t20");
      mkdirSync(outsideFresh);
      writeFileSync(join(outsideFresh, "keep.txt"), "user data");
      controls.push(control("F145", "T20", "a path outside the namespace is structurally undeletable by the cleanup authority", "GUARD_FIRES",
        (() => { try { removeTreeNoFollow(scratch.authority.namespace, outsideFresh); return []; } catch (error) { return [(error as Error).message.slice(0, 120)]; } })()));
      controls.push(control("F145B", "T20", "the refused deletion did not touch the target", "GUARD_SILENT",
        existsSync(join(outsideFresh, "keep.txt")) && existsSync(join(unrelated, "keep.txt")) ? [] : ["target deleted"]));
    } finally {
      scratch.dispose();
    }
  }

  // ── F131 ← T6: a live PID owns the scratch ────────────────────────
  // ── F144 ← T19: the owned child is killed and cleanup completes ───
  {
    const scratch = scratchWorld();
    try {
      const ledger = freshLedger(authorities);
      const path = scratch.authority.pathFor(row(0));
      scratch.liveness.references.set(path, [{ kind: "PROCESS", detail: "pid 4242 bwrap --bind ... vtrace mcp-serve" }]);
      const first = await attempt(depsFor(authorities, ledger, syntheticWorld({ resolved: false }), scratch), { executionOrder: 0 });
      const f131: string[] = [];
      const record = scratchOf(lastEvent(scratch.operationsLedger, "ROW_TEARDOWN"));
      if (first.result?.record.validity.status !== "VALID_UNRESOLVED") f131.push("result not valid");
      if (record?.cleanupStatus !== "REFUSED_LIVE_OWNER") f131.push(`cleanup ${String(record?.cleanupStatus)}`);
      if (!existsSync(path)) f131.push("the path was deleted under a live owner");
      if (scratch.operations.state() !== "CONTINUATION_BLOCKED") f131.push(`state ${scratch.operations.state()}`);
      const next = await attempt(depsFor(authorities, ledger, syntheticWorld(), scratch), { executionOrder: 1 });
      if (!refusedBy("P10_CONTINUATION_SAFETY", next.error)) f131.push("next row not refused");
      controls.push(control("F131", "T6", "a live process referencing the owned scratch makes cleanup refuse destructive deletion, the valid result stands, and continuation is BLOCKED until the owner is handled", "GUARD_SILENT", f131));

      // T19 — the owner is gone (killed by the remediation); recovery cleans and continues.
      scratch.liveness.references.delete(path);
      const recovery = await scratch.operations.recover();
      const f144: string[] = [];
      if (recovery.kind !== "ISOLATION_RECOVERY_VERIFIED") f144.push(`recovery ${recovery.kind}: ${JSON.stringify(recovery.detail.reasons).slice(0, 200)}`);
      if (existsSync(path)) f144.push("scratch survived recovery");
      if (claimsFor(scratch, row(0))[0]?.state !== "RELEASED") f144.push("claim not released by recovery");
      const resumed = await runCohort(depsFor(authorities, ledger, syntheticWorld(), scratch), { maxRows: 1 });
      if (resumed.executed.length !== 1) f144.push(`resumed executed ${resumed.executed.length}`);
      if (ledger.attemptsFor(row(0).instanceId, row(0).arm).length !== 1) f144.push("the valid row was rerun");
      controls.push(control("F144", "T19", "once the owning child is gone, the predeclared recovery removes the owned scratch through the ownership-checked path, releases the claim, and the next row runs without rerunning the valid one", "GUARD_SILENT", f144));
    } finally {
      scratch.dispose();
    }
  }

  // ── F132 ← T7: a live container bind mount ────────────────────────
  {
    const scratch = scratchWorld();
    try {
      const ledger = freshLedger(authorities);
      const first = await attempt(depsFor(authorities, ledger, syntheticWorld({ resolved: false }), scratch, { teardown: CONTAINER_NOT_REMOVED }), { executionOrder: 0 });
      const issues: string[] = [];
      const record = scratchOf(lastEvent(scratch.operationsLedger, "ROW_TEARDOWN"));
      if (first.result?.record.validity.status !== "VALID_UNRESOLVED") issues.push("result not valid");
      if (record?.cleanupStatus !== "REFUSED_LIVE_OWNER") issues.push(`cleanup ${String(record?.cleanupStatus)}`);
      if (!existsSync(scratch.authority.pathFor(row(0)))) issues.push("the bind-mounted tree was deleted");
      if (scratch.operations.state() !== "CONTINUATION_BLOCKED") issues.push(`state ${scratch.operations.state()}`);
      controls.push(control("F132", "T7", "a teardown that could not remove the container leaves the bind-mounted tree in place, cleanup refuses, and continuation is BLOCKED", "GUARD_SILENT", issues));
    } finally {
      scratch.dispose();
    }
  }

  // ── F133 ← T8: stale owned scratch, no live owner ─────────────────
  // ── F134 ← T9: stale owned scratch after a simulated executor crash ─
  // ── F150 ← T25: the startup sweep ─────────────────────────────────
  {
    const scratch = scratchWorld();
    try {
      // A "previous executor" claimed and wrote, then died: the registry names
      // a pid that no longer exists and the directory is still there.
      const dead = scratch.authority.claim(row(2), `${row(2).runId}#a1#crashed`, 1);
      writeFileSync(join(dead.agentTmp, "half-written"), Buffer.alloc(16384, 9));
      writeFileSync(join(dead.rawDir, "stream.jsonl"), "{}\n");
      scratch.authority.registry.update(dead.claimId, { creator: { ...dead.creator, pid: 999_999_997 } });
      // A path an unrelated process still holds: STALE_UNSAFE.
      const unsafe = scratch.authority.claim(row(3), `${row(3).runId}#a1#held`, 1);
      scratch.authority.registry.update(unsafe.claimId, { creator: { ...unsafe.creator, pid: 999_999_996 } });
      scratch.liveness.references.set(unsafe.path, [{ kind: "MOUNT", detail: `mount at ${unsafe.path}/testbed` }]);
      const before = measureTree(dead.path).bytes;
      const sweep = scratch.authority.sweep();
      scratch.operations.recordScratchEvent("SCRATCH_STALE_SWEEP", !sweep.pass, { sweep, reasons: sweep.blocking });
      const f133: string[] = [];
      const staleEntry = sweep.entries.find((entry) => entry.path === dead.path);
      if (staleEntry?.classification !== "STALE_CLEANABLE" || !staleEntry.cleaned) f133.push(`stale entry ${staleEntry?.classification} cleaned ${staleEntry?.cleaned}`);
      if (existsSync(dead.path)) f133.push("stale scratch survived");
      if (scratch.authority.registry.read(dead.claimId)?.state !== "RELEASED") f133.push("stale claim not released");
      if ((staleEntry?.ownershipEvidence.length ?? 0) === 0 || (staleEntry?.liveChecks.length ?? 0) === 0) f133.push("no ownership evidence / live checks recorded");
      if (staleEntry?.ageSeconds === undefined) f133.push("age not recorded as diagnostic");
      if (before === 0) f133.push("nothing to sweep");
      controls.push(control("F133", "T8", "stale owned scratch whose creator is dead and which nothing references is classified by ownership facts (registry, pid, references; age diagnostic only), removed, and released", "GUARD_SILENT", f133));
      controls.push(control("F134", "T9", "after a simulated executor crash the resumed sweep records path, size, ownership evidence, live checks and the reason cleanup was safe, then cleans", "GUARD_SILENT",
        staleEntry !== undefined && staleEntry.cleaned && staleEntry.bytesRemoved > 0 && staleEntry.reason.includes("removed") ? [] : ["recovery record incomplete"]));
      const f150: string[] = [];
      const unsafeEntry = sweep.entries.find((entry) => entry.path === unsafe.path);
      if (unsafeEntry?.classification !== "STALE_UNSAFE") f150.push(`unsafe entry ${unsafeEntry?.classification}`);
      if (!existsSync(unsafe.path)) f150.push("unsafe path deleted");
      if (sweep.pass) f150.push("sweep passed with an unsafe path");
      if (scratch.operations.state() !== "CONTINUATION_BLOCKED") f150.push(`state ${scratch.operations.state()}`);
      const blocked = await attempt(depsFor(authorities, freshLedger(authorities), syntheticWorld(), scratch), { executionOrder: 0 });
      if (!refusedBy("P10_CONTINUATION_SAFETY", blocked.error)) f150.push("a row started over a blocking sweep");
      controls.push(control("F150", "T25", "the startup sweep removes safe stale paths and, for an unsafe or unknown path, blocks launch: the first row is refused by P10", "GUARD_SILENT", f150));
    } finally {
      scratch.dispose();
    }
  }

  // ── F135 ← T10: valid result + cleanup failure → retained, blocked ─
  // ── F136 ← T11: cleanup recovery → continue without rerun ─────────
  // ── F149 ← T24: the cleanup event is append-only and hash-verifiable ─
  {
    const scratch = scratchWorld();
    try {
      const ledger = freshLedger(authorities);
      const path = scratch.authority.pathFor(row(0));
      scratch.liveness.references.set(path, [{ kind: "CONTAINER", detail: "some-container (running) binds testbed" }]);
      const first = await attempt(depsFor(authorities, ledger, syntheticWorld({ resolved: true }), scratch), { executionOrder: 0 });
      const entry = ledger.entries[0]!;
      const digest = entry.resultDigest;
      const f135: string[] = [];
      if (first.result?.record.validity.status !== "VALID_RESOLVED") f135.push("result not valid");
      if (scratch.operations.state() !== "CONTINUATION_BLOCKED") f135.push(`state ${scratch.operations.state()}`);
      const teardown = lastEvent(scratch.operationsLedger, "ROW_TEARDOWN");
      if (teardown?.resultDigest !== digest) f135.push("teardown event does not reference the result");
      const next = await attempt(depsFor(authorities, ledger, syntheticWorld(), scratch), { executionOrder: 1 });
      if (!refusedBy("P10_CONTINUATION_SAFETY", next.error)) f135.push("next row not blocked");
      if (ledger.entries.length !== 1 || ledger.entries[0]!.resultDigest !== digest) f135.push("result changed or a second result was written");
      controls.push(control("F135", "T10", "a valid result whose scratch cleanup failed is retained unchanged while the next row is blocked", "GUARD_SILENT", f135));

      scratch.liveness.references.delete(path);
      const recovery = await scratch.operations.recover();
      const f136: string[] = [];
      if (recovery.kind !== "ISOLATION_RECOVERY_VERIFIED") f136.push(`recovery ${recovery.kind}`);
      if (existsSync(path)) f136.push("residue survived recovery");
      const resumed = await runCohort(depsFor(authorities, ledger, syntheticWorld(), scratch), { maxRows: 1 });
      if (resumed.executed.length !== 1) f136.push(`resumed executed ${resumed.executed.length}`);
      if (ledger.attemptsFor(row(0).instanceId, row(0).arm).length !== 1) f136.push("the valid row was rerun");
      if (ledger.entries[0]!.resultDigest !== digest) f136.push("the prior result changed");
      if (selectNextRow(manifest, ledger)?.executionOrder !== 2) f136.push("resume point wrong");
      controls.push(control("F136", "T11", "after the residue is cleaned and re-probed, the cohort continues at the next row without rerunning the prior valid result", "GUARD_SILENT", f136));

      const f149: string[] = [];
      if (scratch.operationsLedger.verifyIntegrity().length > 0) f149.push("chain does not recompute");
      const scratchRecord = scratchOf(teardown);
      if (scratchRecord === null || typeof scratchRecord.cleanupStatus !== "string") f149.push("teardown event carries no scratch record");
      for (const key of ["scratchPath", "freeBytesBefore", "scratchHighWaterBytes", "freeBytesBeforeCleanup", "scratchBytesAfterCleanup", "freeBytesAfterCleanup", "cleanupStatus"]) {
        if (scratchRecord === null || !(key in scratchRecord)) f149.push(`missing ${key}`);
      }
      (teardown as { detail: Record<string, unknown> }).detail = { ...teardown!.detail, teardown: { ...(teardown!.detail.teardown as object), scratch: { ...scratchRecord, cleanupStatus: "CLEANED" } } };
      if (scratch.operationsLedger.verifyIntegrity().length === 0) f149.push("a mutated cleanup event went undetected");
      controls.push(control("F149", "T24", "the cleanup record rides the append-only, hash-chained operations ledger with the §40 fields, and a mutation is detected", "GUARD_SILENT", f149));
    } finally {
      scratch.dispose();
    }
  }

  // ── F137 ← T12, F138 ← T13, F139 ← T14: the capacity gate ─────────
  {
    const scratch = scratchWorld();
    try {
      const required = M218_SCRATCH_POLICY.hostSafetyReserveBytes + M218_SCRATCH_POLICY.projectedAttemptScratchBytes;
      scratch.capacity.freeBytes = required - 1;
      const low = await attempt(depsFor(authorities, freshLedger(authorities), syntheticWorld(), scratch), { executionOrder: 0 });
      const deps = depsFor(authorities, freshLedger(authorities), syntheticWorld(), scratch);
      controls.push(control("F137", "T12", "with free space one byte below the derived threshold the attempt is refused by P13 before any container or claim", "GUARD_FIRES",
        refusedBy("P13_SCRATCH_CAPACITY", low.error) && deps.synthetic.container.started.length === 0 && scratch.authority.registry.list().length === 0
          ? [low.error!.message.slice(0, 160)] : []));
      scratch.capacity.freeBytes = required;
      const ok = await attempt(depsFor(authorities, freshLedger(authorities), syntheticWorld(), scratch), { executionOrder: 0 });
      controls.push(control("F138", "T13", "with free space at the threshold the valid run path is accepted", "GUARD_SILENT",
        ok.result?.record.validity.valid === true ? [] : [ok.error?.message ?? "not valid"]));
      scratch.capacity.freeBytes = required * 4;
      scratch.capacity.freeInodes = 1_000;
      const inodes = await attempt(depsFor(authorities, freshLedger(authorities), syntheticWorld(), scratch), { executionOrder: 1 });
      controls.push(control("F139", "T14", "a low free-inode condition fires the gate even with ample bytes", "GUARD_FIRES",
        refusedBy("P13_SCRATCH_CAPACITY", inodes.error) && (inodes.error?.message.includes("inodes") ?? false) ? [inodes.error!.message.slice(0, 160)] : []));
    } finally {
      scratch.dispose();
    }
  }

  // ── F140 ← T15: evidence survives cleanup and cannot be cleaned ───
  {
    const scratch = scratchWorld();
    try {
      const ledger = freshLedger(authorities);
      const first = await attempt(depsFor(authorities, ledger, syntheticWorld(), scratch, {
        agentWrites: (spec) => {
          if (spec.scratch !== undefined) writeFileSync(join(spec.scratch.path, "raw", "attempt.agent_stream.jsonl"), "{\"type\":\"system\",\"subtype\":\"init\"}\n{\"type\":\"result\"}\n");
        },
      }), { executionOrder: 0 });
      const issues: string[] = [];
      const claim = claimsFor(scratch, row(0))[0]!;
      const verification = scratch.authority.verifyEvidence(claim);
      if (!verification.present || verification.issues.length > 0) issues.push(`evidence ${verification.issues.join("; ") || "absent"}`);
      const evidenceDir = join(scratch.authority.evidenceDir, claim.claimId);
      if (!existsSync(join(evidenceDir, "raw", "attempt.agent_stream.jsonl"))) issues.push("raw stream not persisted");
      if (!existsSync(join(evidenceDir, "captured.patch"))) issues.push("patch not persisted");
      if (!existsSync(join(evidenceDir, "evaluation.json"))) issues.push("evaluation not persisted");
      const patch = readFileSync(join(evidenceDir, "captured.patch"), "utf8");
      if (first.result !== null && createHash("sha256").update(patch).digest("hex") !== first.result.record.capturedPatchSha256) issues.push("persisted patch does not match the ledger digest");
      if (existsSync(claim.path)) issues.push("scratch not cleaned");
      try {
        removeTreeNoFollow(scratch.authority.namespace, evidenceDir);
        issues.push("the cleanup authority accepted the evidence directory");
      } catch (error) {
        if (!(error instanceof ScratchSafetyError)) issues.push((error as Error).message);
      }
      if (scratch.authority.verifyEvidence(claim).issues.length > 0) issues.push("evidence altered after the refused cleanup");
      controls.push(control("F140", "T15", "the raw stream, patch and evaluation are persisted outside scratch and digest-verified before cleanup; cleanup cannot reach them and they survive with their digests", "GUARD_SILENT", issues));
    } finally {
      scratch.dispose();
    }
  }

  // ── F141 ← T16: paired-arm contamination, both orders ─────────────
  // ── F142 ← T17: baseline/vtrace tmp policy equivalence ────────────
  {
    const issues: string[] = [];
    const equivalence: string[] = [];
    for (const order of [["baseline", "vtrace"], ["vtrace", "baseline"]] as const) {
      const scratch = scratchWorld();
      try {
        const task = row(0);
        const pair = manifest.filter((candidate) => candidate.instanceId === task.instanceId).sort((a, b) => order.indexOf(a.arm as M214Arm) - order.indexOf(b.arm as M214Arm));
        const seen = new Map<string, { path: string; agentTmp: string; sentinelVisible: boolean }>();
        const ledger = freshLedger(authorities);
        for (const armRow of pair) {
          const result = await attempt({
            ...depsFor(authorities, ledger, syntheticWorld(), scratch, {
              agentWrites: (spec) => {
                if (spec.scratch === undefined) return;
                const sentinel = join(spec.scratch.agentTmp, "m218-pair-sentinel");
                const visible = existsSync(sentinel) || [...seen.values()].some((prior) => existsSync(join(prior.agentTmp, "m218-pair-sentinel")));
                seen.set(armRow.arm, { path: spec.scratch.path, agentTmp: spec.scratch.agentTmp, sentinelVisible: visible });
                writeFileSync(sentinel, `${armRow.arm}\n`);
              },
            }),
            // The synthetic executor selects by execution order; the pair's rows
            // are addressed by runId so both orders can be exercised.
          }, { runId: armRow.runId }).catch(() => ({ result: null, error: new Error("x") }));
          if (result.result === null && !(result.error instanceof LaunchRefusedError && result.error.gates.some((g) => g.gateId === "P6_EXECUTION_ORDER"))) {
            issues.push(`${order.join("->")}: ${armRow.arm} ${result.error?.message.slice(0, 120)}`);
          }
        }
        const second = seen.get(order[1]);
        if (second === undefined) issues.push(`${order.join("->")}: second arm never ran`);
        else if (second.sentinelVisible) issues.push(`${order.join("->")}: arm 1's sentinel was visible to arm 2`);
        const first = seen.get(order[0]);
        if (first !== undefined && second !== undefined && first.agentTmp === second.agentTmp) issues.push(`${order.join("->")}: both arms shared a private /tmp`);
        if (first !== undefined && second !== undefined) {
          const norm = (entry: { path: string; agentTmp: string }) => entry.agentTmp.replace(entry.path, "<ATTEMPT>");
          if (norm(first) !== norm(second)) equivalence.push(`${order.join("->")}: /tmp shape differs: ${norm(first)} vs ${norm(second)}`);
        }
      } finally {
        scratch.dispose();
      }
    }
    controls.push(control("F141", "T16", "in both arm orders, a sentinel written by arm 1 into its private /tmp is not visible to arm 2, whose private /tmp is a different owned path", "GUARD_SILENT", issues));
    controls.push(control("F142", "T17", "baseline and vtrace receive the same private-/tmp shape (<attempt>/tmp) under the same frozen scratch policy; only the attempt path differs", "GUARD_SILENT", equivalence));
  }

  // ── F143 ← T18: exception path ────────────────────────────────────
  {
    const scratch = scratchWorld();
    try {
      const ledger = freshLedger(authorities);
      const first = await attempt(depsFor(authorities, ledger, syntheticWorld(), scratch, {
        agentWrites: (spec) => { if (spec.scratch !== undefined) writeFileSync(join(spec.scratch.agentTmp, "partial"), "x"); },
        agentThrows: new Error("simulated adapter crash mid-attempt"),
      }), { executionOrder: 0 });
      const issues: string[] = [];
      if (first.result?.record.validity.status !== "INFRASTRUCTURE_INVALID") issues.push(`status ${first.result?.record.validity.status ?? first.error?.message}`);
      const record = scratchOf(lastEvent(scratch.operationsLedger, "ROW_TEARDOWN"));
      if (record?.cleanupVerified !== true) issues.push(`cleanup ${String(record?.cleanupStatus)}`);
      if (existsSync(scratch.authority.pathFor(row(0)))) issues.push("scratch survived the exception");
      if (scratch.operations.state() !== "CONTINUATION_SAFE") issues.push(`state ${scratch.operations.state()}`);
      controls.push(control("F143", "T18", "an exception thrown during the attempt still persists evidence, tears down and cleans the owned scratch, and continuation is SAFE", "GUARD_SILENT", issues));
    } finally {
      scratch.dispose();
    }
  }

  // ── F146 ← T21: symlink escape ────────────────────────────────────
  {
    const scratch = scratchWorld();
    try {
      const outside = join(scratch.base, "precious");
      mkdirSync(outside);
      writeFileSync(join(outside, "data.txt"), "must survive");
      const ledger = freshLedger(authorities);
      await attempt(depsFor(authorities, ledger, syntheticWorld(), scratch, {
        agentWrites: (spec) => {
          if (spec.scratch === undefined) return;
          symlinkSync(outside, join(spec.scratch.agentTmp, "escape"));
          symlinkSync(join(outside, "data.txt"), join(spec.scratch.path, "raw", "file-escape"));
          symlinkSync(homedir(), join(spec.scratch.agentTmp, "home-escape"));
        },
      }), { executionOrder: 0 });
      const issues: string[] = [];
      const record = scratchOf(lastEvent(scratch.operationsLedger, "ROW_TEARDOWN"));
      if (record?.cleanupVerified !== true) issues.push(`cleanup ${String(record?.cleanupStatus)} ${JSON.stringify(record?.liveReferences)}`);
      if (readFileSync(join(outside, "data.txt"), "utf8") !== "must survive") issues.push("the symlink target was deleted");
      if (!existsSync(homedir())) issues.push("the home directory is gone");
      // A claim whose PATH is itself a symlink to outside: refused, target untouched.
      const claim = scratch.authority.claim(row(1), `${row(1).runId}#a1#link`, 1);
      rmSync(claim.path, { recursive: true, force: true });
      symlinkSync(outside, claim.path);
      const report = scratch.authority.cleanup(claim, { containerRemoved: true });
      if (report.status !== "REFUSED_UNSAFE_PATH") issues.push(`symlinked claim path cleanup ${report.status}`);
      if (readFileSync(join(outside, "data.txt"), "utf8") !== "must survive") issues.push("the symlinked target was deleted");
      controls.push(control("F146", "T21", "symlinks inside owned scratch pointing outside (a directory, a file, the home directory) are unlinked never followed, and a claim path that is itself a symlink is refused", "GUARD_SILENT", issues));
    } finally {
      scratch.dispose();
    }
  }

  // ── F147 ← T22: root / path validation ────────────────────────────
  {
    const scratch = scratchWorld();
    try {
      const fired: string[] = [];
      for (const target of ["/", "/tmp", tmpdir(), "", "   ", homedir(), scratch.authority.namespace.canonicalRoot, "relative", "/proc/self"]) {
        try {
          removeTreeNoFollow(scratch.authority.namespace, target);
        } catch (error) {
          if (error instanceof ScratchSafetyError) fired.push(`${JSON.stringify(target)}: ${error.message.slice(0, 50)}`);
        }
      }
      try {
        establishNamespace("/tmp", { experiment: "x", cohortDir: "/tmp" });
      } catch (error) {
        if (error instanceof ScratchSafetyError) fired.push("namespace at /tmp refused");
      }
      try {
        establishNamespace(homedir(), { experiment: "x", cohortDir: homedir() });
      } catch (error) {
        if (error instanceof ScratchSafetyError) fired.push("namespace at $HOME refused");
      }
      controls.push(control("F147", "T22", "cleanup of /, /tmp, an empty string, the home directory, the namespace root itself, a relative path and a kernel filesystem is structurally refused, as is establishing a namespace there", "GUARD_FIRES", fired.length >= 11 ? fired : []));
    } finally {
      scratch.dispose();
    }
  }

  // ── F148 ← T23: concurrent owned scratch ──────────────────────────
  {
    const scratch = scratchWorld();
    try {
      const ledger = freshLedger(authorities);
      const other = scratch.authority.claim(row(5), `${row(5).runId}#a1#concurrent`, 1);
      writeFileSync(join(other.rawDir, "keep"), "b");
      await attempt(depsFor(authorities, ledger, syntheticWorld(), scratch), { executionOrder: 0 });
      const issues: string[] = [];
      if (!existsSync(join(other.rawDir, "keep"))) issues.push("run B's scratch was deleted by run A's cleanup");
      if (scratch.authority.registry.read(other.claimId)?.state !== "CLAIMED") issues.push("run B's claim was released");
      if (existsSync(scratch.authority.pathFor(row(0)))) issues.push("run A's scratch survived");
      controls.push(control("F148", "T23", "cleaning run A's owned scratch cannot touch run B's concurrently claimed scratch", "GUARD_SILENT", issues));
    } finally {
      scratch.dispose();
    }
  }

  // ── F151: the emergency monitor aborts at the hard threshold ──────
  {
    const tiny: ScratchPolicy = { ...M218_SCRATCH_POLICY, warningAttemptScratchBytes: 64 * 1024, hardAttemptScratchBytes: 256 * 1024, monitorIntervalMs: 250 };
    const scratch = scratchWorld(tiny);
    try {
      const ledger = freshLedger(authorities);
      const first = await attempt(depsFor(authorities, ledger, syntheticWorld(), scratch, {
        agentWrites: (spec) => {
          if (spec.scratch !== undefined) writeFileSync(join(spec.scratch.agentTmp, "flood"), Buffer.alloc(1024 * 1024, 5));
        },
      }), { executionOrder: 0 });
      // The synthetic agent returns instantly, so the monitor's final sample is
      // what observes the flood; the abort therefore lands on the stop() sample
      // and is recorded on the teardown as an emergency, not on the result.
      const issues: string[] = [];
      const record = scratchOf(lastEvent(scratch.operationsLedger, "ROW_TEARDOWN"));
      const emergency = (record?.emergency ?? null) as { aborted: boolean; highWaterBytes: number } | null;
      if (emergency === null || !emergency.aborted) issues.push(`emergency not recorded: ${JSON.stringify(emergency)}`);
      if ((emergency?.highWaterBytes ?? 0) < 256 * 1024) issues.push("high-water below the flood");
      if (lastEvent(scratch.operationsLedger, "SCRATCH_EMERGENCY_ABORT") === undefined) issues.push("no SCRATCH_EMERGENCY_ABORT event");
      if (record?.cleanupVerified !== true) issues.push("scratch not cleaned after the emergency");
      if (first.result === null) issues.push(first.error?.message ?? "no result");
      controls.push(control("F151", null, "an attempt whose owned scratch crosses the frozen hard threshold trips the emergency monitor, which is recorded as SCRATCH_EMERGENCY_ABORT with the high-water, and the scratch is still cleaned", "GUARD_SILENT", issues));
    } finally {
      scratch.dispose();
    }
  }

  // ── F152: scratch health and reserve views are outcome-blind ───────
  {
    const scratch = scratchWorld();
    try {
      const ledger = freshLedger(authorities);
      await attempt(depsFor(authorities, ledger, syntheticWorld({ resolved: true }), scratch, { spendAuthority: authority }), { executionOrder: 0 });
      const progress = renderProgress(manifest, ledger, null, [], scratch.operations, scratch.authority, authority);
      const issues: string[] = [];
      for (const key of outcomeShapedKeys(progress as unknown as Record<string, unknown>)) issues.push(`progress exposes ${key}`);
      for (const key of outcomeShapedKeys((progress.scratchHealth ?? {}) as unknown as Record<string, unknown>)) issues.push(`scratchHealth exposes ${key}`);
      for (const key of outcomeShapedKeys((progress.retryReserve ?? {}) as unknown as Record<string, unknown>)) issues.push(`retryReserve exposes ${key}`);
      if (progress.scratchHealth === null) issues.push("no scratch health");
      if (progress.retryReserve?.retryAttemptsRemaining !== 10) issues.push("reserve accounting absent");
      if (/VALID_RESOLVED|pass rate|resolved=true/i.test(JSON.stringify(progress))) issues.push("operational view carries outcome language");
      controls.push(control("F152", null, "the operational view carries scratch health (free space, owned bytes, stale paths, cleanup failures) and the retry reserve, and names no arm's performance", "GUARD_SILENT", issues));
    } finally {
      scratch.dispose();
    }
  }

  return Object.freeze(controls);
}
