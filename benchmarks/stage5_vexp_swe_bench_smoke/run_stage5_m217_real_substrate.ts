/**
 * M217 §22 — the continuation interlock on the REAL substrate.
 *
 * Real SWE-bench containers on a research instance outside the frozen 100,
 * the launcher's own production-adapter factory, the whole of M215's
 * `executeManifestRow` with the M217 operations authority bound, and a real
 * Docker/proc enumeration deciding whether the next row may begin. One row's
 * teardown is deliberately skipped so a real container and a real arm root are
 * left behind; the next row must be refused before a container starts; the
 * predeclared recovery path must remove exactly that residue; and the row that
 * follows must run without the previous valid row being rerun.
 *
 * No frozen task. No provider call. $0.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m217_real_substrate.ts
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { M214Arm, RunManifestRow } from "./m214Preregistration";
import {
  type ExecutionResult,
  type ExecutorDependencies,
  LaunchRefusedError,
  M215_EXTERNAL_REFERENCE_FILE,
  M215_MANIFEST_FILE,
  M215_PREREGISTRATION_FILE,
  auditSerializedArtifactForSecrets,
  executeManifestRow,
  renderProgress,
  runCohort,
  selectNextRow,
  verifyFrozenAuthorities,
} from "./m215LaunchExecutor";
import { CohortLedger, resultDigest } from "./m215CohortLedger";
import { M216_SUBSTRATE_PYTHON, SubstrateBridge } from "./m216SubstrateBridge";
import { RESEARCH_AUTHORIZATION, replaySubstitution, writeAgentFixtures } from "./m216RealSubstrate";
import {
  M216_RESEARCH_INSTANCES,
  buildResearchManifest,
  frozenInstanceIds,
  loadResearchDataset,
  researchAuthorities,
} from "./m216ResearchFixture";
import {
  type OperationalEvent,
  type TeardownReport,
  CohortOperations,
  CohortOperationsLedger,
  residualStateIssues,
} from "./m217ContinuationSafety";
import { type M217Control, control, suitePasses } from "./m217Falsification";
import { loadProblemStatements, productionBinding } from "./m217LaunchBinding";
import { cohortOperationalStatus, outcomeShapedKeys } from "./m217RetryReserve";
import { establishNamespace } from "./m218ScratchLifecycle";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m217_real_substrate.json");
const WORK_ROOT = join(RESULTS_DIR, "_m217_work");
const FIXTURE_DIR = join(RESULTS_DIR, "_m216_research", "fixtures");
const REPLAY_SCRIPT = join(import.meta.dir, "m216_replay_agent.py");
const RECORDED = join(import.meta.dir, "m216RecordedInit.jsonl");
const VTRACE_TREE = "b3b3e439f10c6c526cafc6001d25dd0e7552ce6d";
const VTRACE_COMMIT = "f37dc003bb0b323f34d351b5cea77c8a66f32450";

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8")) as Record<string, unknown>;
}

const CLEAN_REPORT: TeardownReport = {
  attempted: true, reported: true, containerRemoved: true, mountRemoved: true, armRootRemoved: true,
  errors: [],
};

function lastEvent(ledger: CohortOperationsLedger, kind: OperationalEvent["kind"]): OperationalEvent | undefined {
  return [...ledger.events].reverse().find((event) => event.kind === kind);
}

function refusedBy(gateId: string, error: unknown): boolean {
  return error instanceof LaunchRefusedError
    && error.gates.some((gate) => gate.gateId === gateId && gate.status === "FAIL");
}

function dockerNames(prefix: string): string[] {
  return execFileSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" })
    .split("\n").map((line) => line.trim()).filter((name) => name.startsWith(prefix));
}

async function tryRecover(operations: CohortOperations): Promise<OperationalEvent | null> {
  try {
    return await operations.recover();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const controls: M217Control[] = [];
  const notes: Record<string, unknown> = {};
  const executed: Record<string, unknown>[] = [];

  const frozen = verifyFrozenAuthorities(
    readJson(M215_PREREGISTRATION_FILE),
    readJson(M215_MANIFEST_FILE) as unknown as { rows: RunManifestRow[]; manifestHash: string },
    readJson(M215_EXTERNAL_REFERENCE_FILE),
  );
  if (!frozen.verified) throw new Error(`frozen authorities do not verify: ${frozen.issues.join("; ")}`);
  const frozenIds = frozenInstanceIds(frozen.manifest);
  const overlap = M216_RESEARCH_INSTANCES.filter((entry) => frozenIds.has(entry.instanceId));
  if (overlap.length > 0) throw new Error(`research population overlaps the frozen 100: ${overlap.map((e) => e.instanceId)}`);

  const dataset = loadResearchDataset(RESULTS_DIR);
  if (!dataset.present) throw new Error("the research dataset is absent; run run_stage5_m216_research_dataset.py first");
  const fixtures = writeAgentFixtures(RECORDED, FIXTURE_DIR);

  rmSync(WORK_ROOT, { recursive: true, force: true });
  mkdirSync(WORK_ROOT, { recursive: true });
  // M218 §14 — the substrate's remediation now refuses to remove a directory
  // under a work root that carries no ownership marker. This research work
  // root is owned by this runner, and says so.
  establishNamespace(WORK_ROOT, { experiment: "M217_RESEARCH_NON_EVALUATION", cohortDir: RESULTS_DIR });

  const bridge = await SubstrateBridge.start({
    benchmarkDir: import.meta.dir, manifestPath: join(RESULTS_DIR, M215_MANIFEST_FILE), dataset: dataset.path,
  });
  notes.substrateIdentity = await bridge.identity();
  const now = (): string => new Date().toISOString();

  // Three research rows: one instance in both arms (the vtrace arm's teardown
  // is the one that will be skipped), then the other instance's baseline as
  // "the next unstarted manifest row".
  const manifest = buildResearchManifest(
    [
      [M216_RESEARCH_INSTANCES[0]!.instanceId, ["baseline", "vtrace"] as readonly M214Arm[]],
      [M216_RESEARCH_INSTANCES[1]!.instanceId, ["baseline"] as readonly M214Arm[]],
    ],
    VTRACE_TREE, VTRACE_COMMIT,
  );
  const authorities = researchAuthorities(frozen, manifest);
  const ledger = new CohortLedger("SYNTHETIC", authorities.preregistrationHash.actual, authorities.manifestHash.actual);
  const operationsLedger = new CohortOperationsLedger();

  // The launcher's factory — the same code path a COHORT launch resolves its
  // adapters through — in RESEARCH mode at the REPLAY boundary.
  const binding = productionBinding({
    bridge,
    mode: "RESEARCH",
    providerBoundary: "REPLAY",
    workRoot: WORK_ROOT,
    manifest: manifest.rows,
    problemStatements: loadProblemStatements(dataset.path),
    datasetPath: dataset.path,
    spendAuthorized: false,
    providerSubstitution: replaySubstitution({
      python: M216_SUBSTRATE_PYTHON, script: REPLAY_SCRIPT, fixture: fixtures.correct,
      argvOut: join(WORK_ROOT, "argv.json"),
    }),
  });
  const operations = new CohortOperations(operationsLedger, binding.probe, WORK_ROOT, now);

  // A control-side seam: the SAME production adapter, whose teardown a control
  // can skip. Nothing in the adapter knows about it.
  const realStop = binding.container.stop.bind(binding.container);
  let skipTeardown = false;
  (binding.container as { stop: (handle: Parameters<typeof realStop>[0]) => Promise<TeardownReport> }).stop =
    async (handle) => {
      if (!skipTeardown) return realStop(handle);
      return {
        attempted: true, reported: true, containerRemoved: false, mountRemoved: false, armRootRemoved: false,
        errors: ["induced by control: teardown skipped; the container and arm root are left in place"],
      };
    };

  const deps: ExecutorDependencies = {
    mode: "SYNTHETIC",
    authorities,
    container: binding.container,
    agent: binding.agent,
    evaluator: binding.evaluator,
    ledger,
    now,
    spendAuthorization: RESEARCH_AUTHORIZATION,
    operations,
  };

  const run = async (order: number): Promise<{ result: ExecutionResult | null; error: Error | null }> => {
    try {
      const result = await executeManifestRow(deps, { executionOrder: order });
      executed.push({
        order, arm: result.record.arm, instanceId: result.record.instanceId,
        status: result.record.validity.status,
        category: result.record.validity.infrastructureCategory,
        phases: result.record.lifecyclePhasesObserved,
        container: result.record.container.image,
        gates: result.record.runtimeGates.filter((g) => g.gateId.startsWith("P1")).map((g) => `${g.gateId}=${g.status}`),
      });
      return { result, error: null };
    } catch (error) {
      return { result: null, error: error as Error };
    }
  };

  try {
    // ── Field witness + launch preflight ─────────────────────────────
    //
    // Enumerate BEFORE anything is started. Whatever a previous session left
    // is recorded as found, then cleared through the same recovery path a
    // halted cohort would use, and the launch preflight must then pass.
    const witness = await binding.probe.enumerate({
      workRoot: WORK_ROOT, armRoot: null, hostMount: null, instanceId: null, runId: null,
    });
    const witnessIssues = residualStateIssues(witness);
    notes.fieldWitness = {
      foundBeforeAnyM217Container: witnessIssues,
      harnessContainers: witness.harnessContainers,
      evaluatorContainers: witness.evaluatorContainers,
      liveProcesses: witness.liveProcesses.length,
      note: witnessIssues.length > 0
        ? "residual substrate state from a PREVIOUS session was present on this machine before M217 "
          + "started any container; it was classified BLOCKING and cleared through the recovery path"
        : "no residual substrate state was present before M217 started",
    };
    const preflight = await operations.recordLaunchPreflight();
    let recoveredWitness: OperationalEvent | null = null;
    if (operations.state() === "CONTINUATION_BLOCKED") {
      recoveredWitness = await tryRecover(operations);
      notes.fieldWitnessRecovery = {
        kind: recoveredWitness?.kind ?? "threw",
        actions: (recoveredWitness?.detail as { remediation?: { actions: string[] } } | undefined)?.remediation?.actions ?? [],
      };
      // A witness that lives only in this run's evidence is lost the moment the
      // suite is re-run over the machine it just cleaned, so it is appended to
      // its own artifact as well.
      const witnessPath = join(RESULTS_DIR, "stage5_m217_field_witness.json");
      const existing = existsSync(witnessPath)
        ? JSON.parse(readFileSync(witnessPath, "utf8")) as { witnesses: unknown[] }
        : { schemaVersion: "stage5.m217.field-witness.v1", milestone: "M217", witnesses: [] };
      existing.witnesses.push({
        observedAt: witness.probedAt,
        observedBy: "run_stage5_m217_real_substrate.ts launch preflight",
        transcribed: false,
        residual: {
          harnessContainers: witness.harnessContainers,
          evaluatorContainers: witness.evaluatorContainers,
          liveProcesses: witness.liveProcesses.length,
        },
        classification: "RESIDUAL_STATE_BEFORE_LAUNCH",
        continuation: "CONTINUATION_BLOCKED",
        recovery: notes.fieldWitnessRecovery,
      });
      writeFileSync(witnessPath, `${JSON.stringify(existing, null, 2)}\n`);
    }
    controls.push(control("F104", null,
      "the launch preflight enumerates the real substrate before any row, blocks over residue left "
      + "by a previous session if any, and the recovery path leaves it provably clean",
      "GUARD_SILENT",
      operations.state() === "CONTINUATION_SAFE"
        ? []
        : [`state ${operations.state()} after preflight ${preflight.kind} / recovery ${recoveredWitness?.kind ?? "(none)"}`],
      "REAL_CONTAINER"));

    // ── Row 0: valid result, clean teardown (brief F74 on the real substrate) ──
    const row0 = await run(0);
    const teardown0 = lastEvent(operationsLedger, "ROW_TEARDOWN");
    const f106: string[] = [];
    if (row0.result?.record.validity.status !== "VALID_UNRESOLVED") {
      f106.push(`row 0 status ${row0.result?.record.validity.status ?? row0.error?.message.slice(0, 300)}`);
    }
    if (teardown0?.detail.classification !== "TEARDOWN_CLEAN") f106.push(`classified ${String(teardown0?.detail.classification)}`);
    if (operations.state() !== "CONTINUATION_SAFE") f106.push(`state ${operations.state()}`);
    const residual0 = teardown0?.detail.residual as { harnessContainers: unknown[]; liveProcesses: unknown[]; armRootPresent: boolean } | undefined;
    if (residual0 === undefined || residual0.harnessContainers.length !== 0 || residual0.armRootPresent) {
      f106.push("the real enumeration after a clean teardown was not empty");
    }
    controls.push(control("F106", "F74",
      "on the real substrate, a row run through the launcher's own adapter factory reaches a valid "
      + "outcome, its real teardown is classified TEARDOWN_CLEAN by a real Docker/proc enumeration, "
      + "and continuation is SAFE", "GUARD_SILENT", f106, "REAL_CONTAINER"));

    // ── Row 1: valid result, teardown SKIPPED → real residue ─────────
    skipTeardown = true;
    const row1 = await run(1);
    skipTeardown = false;
    const teardown1 = lastEvent(operationsLedger, "ROW_TEARDOWN");
    const residual1 = teardown1?.detail.residual as {
      harnessContainers: { name: string }[]; armRootPresent: boolean; openBridgeHandles: string[];
    } | undefined;
    const f107: string[] = [];
    if (row1.result?.record.validity.status !== "VALID_UNRESOLVED") {
      f107.push(`row 1 status ${row1.result?.record.validity.status ?? row1.error?.message.slice(0, 300)}`);
    }
    if (teardown1?.detail.classification !== "TEARDOWN_FAILURE_ISOLATION_UNPROVEN") {
      f107.push(`classified ${String(teardown1?.detail.classification)}`);
    }
    if (operations.state() !== "CONTINUATION_BLOCKED") f107.push(`state ${operations.state()}`);
    const expectedName = `m193-${M216_RESEARCH_INSTANCES[0]!.instanceId}`;
    if (!residual1?.harnessContainers.some((box) => box.name === expectedName)) {
      f107.push(`the real enumeration did not list ${expectedName}`);
    }
    if (!residual1?.armRootPresent) f107.push("the real enumeration did not see the arm root");
    if (!dockerNames(expectedName).includes(expectedName)) f107.push("docker ps does not show the container the control left behind");
    notes.inducedResidue = residual1;
    controls.push(control("F107B", "F76",
      "the real enumeration FIRES on the residue the skipped teardown left behind",
      "GUARD_FIRES", residual1 === undefined ? [] : residualStateIssues(residual1 as never), "REAL_CONTAINER"));
    controls.push(control("F107", "F76",
      "a valid result whose real teardown was skipped is retained, the real enumeration lists the "
      + "surviving container, arm root and bridge handle, and continuation is BLOCKED",
      "GUARD_SILENT", f107, "REAL_CONTAINER"));

    // ── Immutability across the halt (brief F79) ─────────────────────
    const entry1 = ledger.entries.find((entry) => entry.attemptId === row1.result?.record.attemptId)!;
    const digest1 = entry1.resultDigest;
    const bytes1 = resultDigest(ledger.record(entry1.attemptId)!);

    // ── Next row refused before any container starts (brief F77) ────
    const accountingBefore = await bridge.accounting();
    const refused = await run(2);
    const accountingAfter = await bridge.accounting();
    const f109: string[] = [];
    if (!refusedBy("P10_CONTINUATION_SAFETY", refused.error)) {
      f109.push(`row 2 was not refused by P10: ${refused.result?.record.attemptId ?? refused.error?.message.slice(0, 200)}`);
    }
    if (accountingAfter.containersCreated !== accountingBefore.containersCreated) f109.push("a container was created for the refused row");
    const loop = await runCohort(deps);
    if (loop.executed.length !== 0) f109.push(`runCohort executed ${loop.executed.length} rows while blocked`);
    if (loop.progress.operationalStatus !== "COHORT_HALTED_ISOLATION_RISK") f109.push(`status ${loop.progress.operationalStatus}`);
    controls.push(control("F109B", "F77",
      "P10 FIRES on the next row while the real substrate is unproven",
      "GUARD_FIRES", refusedBy("P10_CONTINUATION_SAFETY", refused.error) ? [refused.error!.message.slice(0, 300)] : [], "REAL_CONTAINER"));
    controls.push(control("F109", "F77",
      "while blocked, the next research row is refused by P10 with no container created, and the "
      + "cohort loop stops with COHORT_HALTED_ISOLATION_RISK", "GUARD_SILENT", f109, "REAL_CONTAINER"));

    // ── Recovery through the real remediation (brief F78) ─────────────
    const recovery = await tryRecover(operations);
    const recoveryDetail = (recovery?.detail ?? { remediation: { actions: [], errors: ["recovery threw"] }, after: {} }) as {
      remediation: { actions: string[]; errors: string[] };
      after: { harnessContainers?: unknown[]; armRootPresent?: boolean; openBridgeHandles?: string[]; liveProcesses?: unknown[] };
    };
    notes.recovery = { kind: recovery?.kind ?? "threw", actions: recoveryDetail.remediation.actions, errors: recoveryDetail.remediation.errors };
    const f110: string[] = [];
    if (recovery?.kind !== "ISOLATION_RECOVERY_VERIFIED") f110.push(`recovery ${recovery?.kind ?? "threw"}: ${JSON.stringify(recoveryDetail.after).slice(0, 300)}`);
    if (operations.state() !== "CONTINUATION_SAFE") f110.push(`state ${operations.state()}`);
    if (!recoveryDetail.remediation.actions.some((action) => action.includes(expectedName))) f110.push("remediation did not remove the surviving container");
    if (dockerNames(expectedName).length !== 0) f110.push("docker ps still shows the container after recovery");
    if (existsSync(join(WORK_ROOT, `${M216_RESEARCH_INSTANCES[0]!.instanceId}--vtrace`))) f110.push("the arm root survived recovery");
    controls.push(control("F110", "F78",
      "the predeclared recovery path removes exactly the real residue, the second real enumeration is "
      + "empty, and continuation returns to SAFE", "GUARD_SILENT", f110, "REAL_CONTAINER"));

    // ── The next unstarted row runs; the previous valid row is not rerun (brief F88) ──
    const next = selectNextRow(manifest.rows, ledger);
    const row2 = await run(2);
    const f111: string[] = [];
    if (next?.executionOrder !== 2) f111.push(`next row was ${next?.executionOrder}`);
    if (row2.result?.record.validity.status !== "VALID_UNRESOLVED") {
      f111.push(`row 2 status ${row2.result?.record.validity.status ?? row2.error?.message.slice(0, 300)}`);
    }
    if (ledger.attemptsFor(manifest.rows[1]!.instanceId, "vtrace").length !== 1) f111.push("the previous valid row was rerun");
    if (ledger.entries.length !== 3) f111.push(`${ledger.entries.length} entries, expected 3`);
    controls.push(control("F111", "F88",
      "after recovery the cohort resumes at the next unstarted manifest row, which runs to a valid "
      + "outcome, with no duplicate result for any completed row", "GUARD_SILENT", f111, "REAL_CONTAINER"));

    const f108: string[] = [];
    if (ledger.entries.find((entry) => entry.attemptId === entry1.attemptId)!.resultDigest !== digest1) f108.push("row 1's ledger digest changed");
    if (resultDigest(ledger.record(entry1.attemptId)!) !== bytes1) f108.push("row 1's record bytes changed");
    if (ledger.statusFor(entry1.instanceId, entry1.arm) !== "VALID_UNRESOLVED") f108.push(`row 1's status is ${ledger.statusFor(entry1.instanceId, entry1.arm)}`);
    if (ledger.verifyIntegrity().length > 0) f108.push("result ledger integrity broken");
    if (teardown1?.resultDigest !== digest1) f108.push("the teardown event does not reference row 1's digest");
    controls.push(control("F108", "F79",
      "the skipped teardown, the halt, the refusal and the recovery leave row 1's status, bytes and "
      + "digest untouched on the real substrate", "GUARD_SILENT", f108, "REAL_CONTAINER"));

    // ── Fresh container per row, stated mechanically (§9) ─────────────
    const handles = ledger.records.map((record) => `${record.container.image}`);
    const hostMounts = [...operationsLedger.events]
      .filter((event) => event.kind === "ROW_TEARDOWN")
      .map((event) => (event.detail as { residual: { scope: { hostMount: string | null; armRoot: string | null } } }).residual.scope);
    const f115: string[] = [];
    if (new Set(hostMounts.map((scope) => scope.armRoot)).size !== hostMounts.length) f115.push("two rows shared an arm root");
    if (hostMounts.some((scope) => scope.armRoot === null)) f115.push("a row's arm root was not recorded on its teardown event");
    notes.rowIsolationScopes = hostMounts;
    notes.rowImages = handles;
    controls.push(control("F115", null,
      "every row received its own arm root and host mount (M193 re-extracts the tree and creates a "
      + "new container per start); freshness is recorded, and is NOT what continuation relies on",
      "GUARD_SILENT", f115, "REAL_CONTAINER"));

    // ── Stale process witness (brief F89, real process) ───────────────
    const witnessDir = join(WORK_ROOT, "process-witness");
    mkdirSync(witnessDir, { recursive: true });
    const child = spawn("python3", ["-c", "import sys, time; time.sleep(600)", witnessDir], {
      detached: true, stdio: "ignore",
    });
    child.unref();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const rowForWitness = manifest.rows[2]!;
    const staleProcessEvent = await operations.recordTeardown({
      row: rowForWitness, attemptId: `${rowForWitness.runId}#witness-process`, resultDigest: null, resultStatus: null,
      scope: { workRoot: WORK_ROOT, armRoot: null, hostMount: null, instanceId: rowForWitness.instanceId, runId: rowForWitness.runId },
    }, CLEAN_REPORT);
    const processResidual = staleProcessEvent.detail.residual as { liveProcesses: { pid: number; cmdline: string }[] };
    const f112: string[] = [];
    if (staleProcessEvent.detail.classification !== "RESIDUAL_STATE_AFTER_REPORTED_CLEAN_TEARDOWN") {
      f112.push(`classified ${String(staleProcessEvent.detail.classification)}`);
    }
    if (!processResidual.liveProcesses.some((proc) => proc.pid === child.pid)) f112.push(`the real enumeration did not list pid ${child.pid}`);
    if (operations.state() !== "CONTINUATION_BLOCKED") f112.push(`state ${operations.state()}`);
    const processRecovery = await tryRecover(operations);
    if (processRecovery?.kind !== "ISOLATION_RECOVERY_VERIFIED") f112.push(`recovery ${processRecovery?.kind ?? "threw"}`);
    let alive = true;
    try {
      process.kill(child.pid!, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      f112.push(`pid ${child.pid} is still alive after remediation`);
      try { process.kill(child.pid!, "SIGKILL"); } catch { /* best effort */ }
    }
    notes.processWitness = { pid: child.pid, listed: processResidual.liveProcesses.map((p) => p.pid) };
    controls.push(control("F112", "F89",
      "a live host process referencing the cohort work root blocks continuation even after a clean "
      + "teardown report, and the real remediation terminates it", "GUARD_SILENT", f112, "REAL_PROCESS"));

    // ── Stale evaluator container witness (brief F89, real Docker) ────
    const evalName = `sweb.eval.m217-witness.${Date.now()}`;
    execFileSync("docker", ["run", "-d", "--name", evalName, M216_RESEARCH_INSTANCES[0]!.image, "tail", "-f", "/dev/null"], { encoding: "utf8" });
    const evalEvent = await operations.recordTeardown({
      row: rowForWitness, attemptId: `${rowForWitness.runId}#witness-evaluator`, resultDigest: null, resultStatus: null,
      scope: { workRoot: WORK_ROOT, armRoot: null, hostMount: null, instanceId: rowForWitness.instanceId, runId: rowForWitness.runId },
    }, CLEAN_REPORT);
    const evalResidual = evalEvent.detail.residual as { evaluatorContainers: { name: string }[] };
    const f113: string[] = [];
    if (evalEvent.detail.classification !== "RESIDUAL_STATE_AFTER_REPORTED_CLEAN_TEARDOWN") f113.push(`classified ${String(evalEvent.detail.classification)}`);
    if (!evalResidual.evaluatorContainers.some((box) => box.name === evalName)) f113.push("the real enumeration did not list the evaluator container");
    if (operations.state() !== "CONTINUATION_BLOCKED") f113.push(`state ${operations.state()}`);
    const evalRecovery = await tryRecover(operations);
    if (evalRecovery?.kind !== "ISOLATION_RECOVERY_VERIFIED") f113.push(`recovery ${evalRecovery?.kind ?? "threw"}`);
    if (dockerNames(evalName).length !== 0) {
      f113.push("the evaluator container survived remediation");
      try { execFileSync("docker", ["rm", "-f", evalName]); } catch { /* best effort */ }
    }
    controls.push(control("F113", "F89",
      "a stale evaluator container (swebench's own naming) blocks continuation after a clean teardown "
      + "report, and the real remediation removes it", "GUARD_SILENT", f113, "REAL_CONTAINER"));

    // ── False cleanup failure with fresh isolation (brief F90) ────────
    const falseRow = manifest.rows[1]!;
    const handle = await binding.container.start(falseRow);
    const own = handle as typeof handle & { bridgeHandle: string; armRoot: string; hostMount: string };
    // Remove the container out from under the adapter, so its own teardown
    // reports a failure it did not cause.
    await bridge.call("container.stop", { handle: own.bridgeHandle, removeMount: true });
    const falseReport = await binding.container.stop(handle);
    const falseEvent = await operations.recordTeardown({
      row: falseRow, attemptId: `${falseRow.runId}#witness-false-failure`, resultDigest: null, resultStatus: null,
      scope: { workRoot: WORK_ROOT, armRoot: own.armRoot, hostMount: own.hostMount, instanceId: falseRow.instanceId, runId: falseRow.runId },
    }, falseReport);
    const f114: string[] = [];
    if (falseReport.errors.length === 0) f114.push("the adapter's teardown did not report a failure");
    if (falseEvent.detail.classification !== "TEARDOWN_FAILURE_ISOLATION_PROVEN") f114.push(`classified ${String(falseEvent.detail.classification)}`);
    if (operations.state() !== "CONTINUATION_SAFE") f114.push(`state ${operations.state()}`);
    notes.falseFailureReport = falseReport;
    controls.push(control("F114", "F90",
      "a real teardown that reports a failure (\"unknown handle\") because the container was already "
      + "gone is classified ISOLATION_PROVEN by the real enumeration, and does not deadlock the cohort",
      "GUARD_SILENT", f114, "REAL_CONTAINER"));

    // ── Outcome-blind status on a real, halted-then-recovered cohort ──
    const progress = renderProgress(manifest.rows, ledger, null, [], operations);
    const status = cohortOperationalStatus(manifest.rows, ledger, operationsLedger);
    const leaked = [...outcomeShapedKeys(progress as unknown as Record<string, unknown>), ...outcomeShapedKeys(status as unknown as Record<string, unknown>)];
    controls.push(control("F116", "F86",
      "the operational status of a real cohort that halted and recovered names no arm's performance",
      "GUARD_SILENT", leaked.map((key) => `exposes ${key}`), "REAL_CONTAINER"));
    notes.finalStatus = status;
    notes.operationalEvents = operationsLedger.events.map((event) => ({
      sequence: event.sequence, kind: event.kind, continuationAfter: event.continuationAfter,
      classification: (event.detail as { classification?: unknown }).classification ?? null,
      attemptId: event.attemptId,
    }));
    if (operationsLedger.verifyIntegrity().length > 0) {
      controls.push(control("F117", null, "the real operations ledger chain recomputes", "GUARD_SILENT", operationsLedger.verifyIntegrity(), "REAL_CONTAINER"));
    } else {
      controls.push(control("F117", null, "the real operations ledger chain recomputes", "GUARD_SILENT", [], "REAL_CONTAINER"));
    }
  } finally {
    const accounting = await bridge.shutdown();
    notes.substrateAccounting = accounting;
    // Leave the machine as found: nothing of M217's under the work root.
    for (const name of dockerNames("m193-")) {
      try { execFileSync("docker", ["rm", "-f", name]); } catch { /* best effort */ }
    }
    for (const name of dockerNames("sweb.eval.m217-witness")) {
      try { execFileSync("docker", ["rm", "-f", name]); } catch { /* best effort */ }
    }
  }

  const accounting = notes.substrateAccounting as {
    containersStarted: number; containersTornDown: number;
    frozenInstancesTouched: string[]; nonFrozenInstancesTouched: string[];
  } | null;

  const document = {
    schemaVersion: "stage5.m217.real-substrate.v1",
    milestone: "M217",
    generatedAt: new Date().toISOString(),
    controlCount: controls.length,
    satisfied: controls.filter((entry) => entry.satisfied).length,
    failures: controls.filter((entry) => !entry.satisfied).map((entry) => entry.id),
    guardFiresControls: controls.filter((entry) => entry.expectation === "GUARD_FIRES").length,
    guardSilentControls: controls.filter((entry) => entry.expectation === "GUARD_SILENT").length,
    suitePasses: suitePasses(controls),
    containersStarted: accounting?.containersStarted ?? 0,
    containersTornDown: accounting?.containersTornDown ?? 0,
    frozenInstancesTouched: accounting?.frozenInstancesTouched ?? [],
    nonFrozenInstancesTouched: accounting?.nonFrozenInstancesTouched ?? [],
    liveModelSpendUsd: 0,
    providerCalls: 0,
    frozenBenchmarkTaskLiveAgentRuns: 0,
    executedRows: executed,
    controls,
    notes,
  };
  const secretIssues = auditSerializedArtifactForSecrets(JSON.stringify(document), process.env as Record<string, string>);
  if (secretIssues.length > 0) throw new Error(`refusing to persist the evidence: ${secretIssues.join("; ")}`);
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `${document.satisfied}/${document.controlCount} controls satisfied `
    + `(${document.guardFiresControls} GUARD_FIRES, ${document.guardSilentControls} GUARD_SILENT); `
    + `failures [${document.failures.join(", ") || "none"}]\n`,
  );
  process.stdout.write(
    `containers started ${document.containersStarted}, torn down ${document.containersTornDown}, `
    + `frozen tasks touched ${document.frozenInstancesTouched.length}, spend $0\nwrote ${OUTPUT}\n`,
  );
  if (!document.suitePasses) process.exitCode = 1;
}

await main();
