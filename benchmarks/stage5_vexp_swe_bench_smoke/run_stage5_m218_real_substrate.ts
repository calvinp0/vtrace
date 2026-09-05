/**
 * M218 §50 — the scratch lifecycle on the REAL substrate.
 *
 * Real SWE-bench containers on research instances outside the frozen 100, the
 * launcher's own adapter factory with the scratch authority bound, the whole
 * of `executeManifestRow`, the real bwrap namespace with the attempt's owned
 * directory bound at /tmp, and the real Docker/proc enumeration deciding
 * continuation. The replay agent is wrapped so that, inside its namespace, it
 * writes `/tmp/m218-agent-marker`, records whether the previous arm's sentinel
 * is visible, and leaves a sentinel of its own — in BOTH arm orders. One row
 * spawns a detached holder inside the namespace so a real live owner blocks
 * cleanup until the predeclared recovery kills it. One further row floods its
 * private /tmp under a tiny research policy so the real adapter's abort path
 * runs through the bridge's watchdog.
 *
 * No frozen task. No provider call. $0.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m218_real_substrate.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { M214Arm, RunManifestRow } from "./m214Preregistration";
import {
  type AgentRunSpec,
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
  verifyFrozenAuthorities,
} from "./m215LaunchExecutor";
import { CohortLedger, resultDigest } from "./m215CohortLedger";
import { M216_SUBSTRATE_PYTHON, SubstrateBridge } from "./m216SubstrateBridge";
import { RESEARCH_AUTHORIZATION, writeAgentFixtures } from "./m216RealSubstrate";
import {
  M216_RESEARCH_INSTANCES,
  buildResearchManifest,
  frozenInstanceIds,
  loadResearchDataset,
  researchAuthorities,
} from "./m216ResearchFixture";
import { type OperationalEvent, CohortOperations, CohortOperationsLedger } from "./m217ContinuationSafety";
import { type M217Control, control, suitePasses } from "./m217Falsification";
import { loadProblemStatements, productionBinding } from "./m217LaunchBinding";
import { outcomeShapedKeys } from "./m217RetryReserve";
import {
  type ScratchPolicy,
  HostLivenessProbe,
  M218_SCRATCH_POLICY,
  ScratchAuthority,
  ScratchRegistry,
  auditArmTmpEquivalence,
  establishNamespace,
} from "./m218ScratchLifecycle";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m218_real_substrate.json");
const COHORT_DIR = join(RESULTS_DIR, "_m218_work");
const WORK_ROOT = join(COHORT_DIR, "_work");
const WITNESS_DIR = join(RESULTS_DIR, "_m218_work_witness");
const FIXTURE_DIR = join(RESULTS_DIR, "_m216_research", "fixtures");
const REPLAY_SCRIPT = join(import.meta.dir, "m216_replay_agent.py");
const RECORDED = join(import.meta.dir, "m216RecordedInit.jsonl");
const VTRACE_TREE = "b3b3e439f10c6c526cafc6001d25dd0e7552ce6d";
const VTRACE_COMMIT = "f37dc003bb0b323f34d351b5cea77c8a66f32450";

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8")) as Record<string, unknown>;
}

function lastEvent(ledger: CohortOperationsLedger, kind: OperationalEvent["kind"]): OperationalEvent | undefined {
  return [...ledger.events].reverse().find((event) => event.kind === kind);
}

function scratchOf(event: OperationalEvent | undefined): Record<string, unknown> | null {
  return ((event?.detail as { teardown?: { scratch?: Record<string, unknown> } } | undefined)?.teardown?.scratch) ?? null;
}

function refusedBy(gateId: string, error: unknown): boolean {
  return error instanceof LaunchRefusedError && error.gates.some((gate) => gate.gateId === gateId && gate.status === "FAIL");
}

function dockerNames(prefix: string): string[] {
  return execFileSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" })
    .split("\n").map((line) => line.trim()).filter((name) => name.startsWith(prefix));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The provider substitution: a bash wrapper INSIDE the sandbox that writes the
 * agent marker into /tmp (which is the attempt's owned directory), records the
 * previous arm's sentinel visibility into a witness file outside the namespace,
 * optionally spawns a detached holder or floods /tmp, then execs the replay
 * agent with the production argv after `--`.
 */
function wrapped(options: {
  readonly fixture: string; readonly witnessDir: string; readonly armLabel: string;
  readonly holder?: boolean; readonly flood?: boolean; readonly hangAfter?: number;
}) {
  return (argv: readonly string[], spec: AgentRunSpec): readonly string[] => {
    const witness = join(options.witnessDir, `${spec.row.instanceId}--${spec.row.arm}.json`);
    const argvOut = join(options.witnessDir, `${spec.row.instanceId}--${spec.row.arm}.argv.json`);
    const script = [
      "set -u",
      "echo marker > /tmp/m218-agent-marker",
      "if [ -e /tmp/m218-pair-sentinel ]; then vis=VISIBLE; else vis=ABSENT; fi",
      "echo \"$1\" > /tmp/m218-pair-sentinel",
      "printf '{\"arm\":\"%s\",\"priorSentinel\":\"%s\",\"tmpMarkerWritten\":true,\"tmpDir\":\"%s\"}\\n' \"$1\" \"$vis\" \"$(readlink -f /tmp)\" > \"$2\"",
      ...(options.holder === true
        ? ["( setsid python3 -c 'import sys,time; time.sleep(600)' \"$3\" >/dev/null 2>&1 < /dev/null & )"]
        : []),
      ...(options.flood === true
        ? ["python3 -c 'import os; f=open(\"/tmp/m218-flood\",\"wb\"); [f.write(os.urandom(1<<20)) for _ in range(6)]; f.close()'"]
        : []),
      "shift 3",
      "exec \"$@\"",
    ].join("\n");
    return [
      "/bin/bash", "-c", script, "m218-wrapper", options.armLabel, witness, spec.scratch?.path ?? "(no-scratch)",
      M216_SUBSTRATE_PYTHON, REPLAY_SCRIPT, "--fixture", options.fixture, "--argv-out", argvOut,
      ...(options.hangAfter === undefined ? [] : ["--hang-after", String(options.hangAfter)]),
      "--", ...argv,
    ];
  };
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
  if (M216_RESEARCH_INSTANCES.some((entry) => frozenIds.has(entry.instanceId))) throw new Error("research population overlaps the frozen 100");
  const dataset = loadResearchDataset(RESULTS_DIR);
  if (!dataset.present) throw new Error("the research dataset is absent; run run_stage5_m216_research_dataset.py first");
  const fixtures = writeAgentFixtures(RECORDED, FIXTURE_DIR);

  rmSync(COHORT_DIR, { recursive: true, force: true });
  rmSync(WITNESS_DIR, { recursive: true, force: true });
  mkdirSync(WITNESS_DIR, { recursive: true });
  const hostSentinel = join(tmpdir(), `m218-unrelated-host-sentinel-${process.pid}`);
  writeFileSync(hostSentinel, "must survive\n");

  const now = (): string => new Date().toISOString();
  const namespace = establishNamespace(WORK_ROOT, { experiment: "M218_RESEARCH_NON_EVALUATION", cohortDir: COHORT_DIR, now });
  const liveness = new HostLivenessProbe();
  const registry = new ScratchRegistry(join(COHORT_DIR, "_scratch_registry"));
  const scratch = new ScratchAuthority({
    namespace, registry, evidenceDir: join(COHORT_DIR, "evidence"), liveness,
    experiment: "M218_RESEARCH_NON_EVALUATION", executorVersion: "m218-real-substrate", now,
  });

  const bridge = await SubstrateBridge.start({
    benchmarkDir: import.meta.dir, manifestPath: join(RESULTS_DIR, M215_MANIFEST_FILE), dataset: dataset.path,
  });
  notes.substrateIdentity = await bridge.identity();

  // Instance A: baseline then vtrace. Instance B: vtrace then baseline (the
  // vtrace row spawns the holder). Four rows, both orders.
  const [A, B] = M216_RESEARCH_INSTANCES;
  const manifest = buildResearchManifest(
    [[A!.instanceId, ["baseline", "vtrace"] as readonly M214Arm[]], [B!.instanceId, ["vtrace", "baseline"] as readonly M214Arm[]]],
    VTRACE_TREE, VTRACE_COMMIT,
  );
  const authorities = researchAuthorities(frozen, manifest);
  const ledger = new CohortLedger("SYNTHETIC", authorities.preregistrationHash.actual, authorities.manifestHash.actual);
  const operationsLedger = new CohortOperationsLedger();

  const bindingFor = (substitution: (argv: readonly string[], spec: AgentRunSpec) => readonly string[], authority: ScratchAuthority) =>
    productionBinding({
      bridge, mode: "RESEARCH", providerBoundary: "REPLAY", workRoot: WORK_ROOT, manifest: manifest.rows,
      problemStatements: loadProblemStatements(dataset.path), datasetPath: dataset.path, spendAuthorized: false,
      providerSubstitution: substitution, scratch: authority,
    });

  const holderRow = manifest.rows[2]!; // B vtrace
  const binding = bindingFor((argv, spec) => wrapped({
    fixture: fixtures.correct, witnessDir: WITNESS_DIR, armLabel: spec.row.arm,
    holder: spec.row.runId === holderRow.runId,
  })(argv, spec), scratch);
  const operations = new CohortOperations(operationsLedger, binding.probe, WORK_ROOT, now);
  const deps: ExecutorDependencies = {
    mode: "SYNTHETIC", authorities, container: binding.container, agent: binding.agent, evaluator: binding.evaluator,
    ledger, now, spendAuthorization: RESEARCH_AUTHORIZATION, operations, scratch,
  };

  const run = async (deps2: ExecutorDependencies, order: number): Promise<{ result: ExecutionResult | null; error: Error | null }> => {
    try {
      const result = await executeManifestRow(deps2, { executionOrder: order });
      executed.push({
        order, arm: result.record.arm, instanceId: result.record.instanceId, status: result.record.validity.status,
        category: result.record.validity.infrastructureCategory, phases: result.record.lifecyclePhasesObserved,
        gates: result.record.runtimeGates.filter((g) => g.gateId.startsWith("P1")).map((g) => `${g.gateId}=${g.status}`),
      });
      return { result, error: null };
    } catch (error) {
      return { result: null, error: error as Error };
    }
  };
  const witness = (row: RunManifestRow): { arm: string; priorSentinel: string; tmpMarkerWritten: boolean; tmpDir: string } | null => {
    const path = join(WITNESS_DIR, `${row.instanceId}--${row.arm}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as { arm: string; priorSentinel: string; tmpMarkerWritten: boolean; tmpDir: string } : null;
  };
  const argvEnv = (row: RunManifestRow): string[] => {
    const path = join(WITNESS_DIR, `${row.instanceId}--${row.arm}.argv.json`);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { envNames: string[] }).envNames : [];
  };

  let holderPid: number | null = null;
  try {
    // ── Preflight: sweep + capacity + images on the real host ──────────
    const sweep = scratch.sweep();
    const gate = scratch.capacityGate();
    operations.recordScratchEvent("SCRATCH_STALE_SWEEP", !sweep.pass, { sweep });
    operations.recordScratchEvent("SCRATCH_CAPACITY_GATE", !gate.pass, { gate });
    const preflight = await operations.recordLaunchPreflight();
    notes.preflight = { sweep: { pass: sweep.pass, entries: sweep.entries.length }, gate: { pass: gate.pass, issues: gate.issues, free: gate.namespaceFilesystem.freeBytes }, isolation: preflight.detail.verdict };
    controls.push(control("F172", null, "before the first row the real namespace is swept clean, the real host passes the frozen capacity gate, and the substrate enumeration is empty", "GUARD_SILENT",
      [...(sweep.pass ? [] : [`sweep blocked: ${sweep.blocking.join(", ")}`]), ...gate.issues, ...(operations.state() === "CONTINUATION_SAFE" ? [] : [`state ${operations.state()}`])], "REAL_CONTAINER"));

    // ── Row 0: A baseline — marker in the private /tmp, cleaned; sentinel survives ──
    const row0 = await run(deps, 0);
    const teardown0 = lastEvent(operationsLedger, "ROW_TEARDOWN");
    const scratch0 = scratchOf(teardown0);
    const w0 = witness(manifest.rows[0]!);
    const spawned0 = [...binding.agent.lastSpawnedArgv];
    const f173: string[] = [];
    if (row0.result?.record.validity.status !== "VALID_UNRESOLVED") f173.push(`row 0 ${row0.result?.record.validity.status ?? row0.error?.message.slice(0, 300)}`);
    if (w0 === null || !w0.tmpMarkerWritten) f173.push("the agent did not write its /tmp marker");
    const claim0 = registry.claimsForPath(scratch.pathFor(manifest.rows[0]!))[0];
    if (claim0 === undefined) f173.push("no claim for row 0");
    else {
      if (existsSync(claim0.path) || existsSync(join(claim0.agentTmp, "m218-agent-marker"))) f173.push("the attempt path or the marker survived");
      if (!spawned0.includes(claim0.agentTmp)) f173.push(`bwrap did not bind the attempt's tmp: ${JSON.stringify(spawned0).slice(0, 300)}`);
      const bindIndex = spawned0.indexOf(claim0.agentTmp);
      if (bindIndex < 1 || spawned0[bindIndex - 1] !== "--bind" || spawned0[bindIndex + 1] !== "/tmp") f173.push("the tmp bind is not `--bind <agentTmp> /tmp`");
      if (spawned0.includes("--tmpfs") && spawned0[spawned0.indexOf("--tmpfs") + 1] === "/tmp") f173.push("an anonymous tmpfs is still mounted at /tmp");
      if (claim0.state !== "RELEASED") f173.push(`claim state ${claim0.state}`);
      const evidence = scratch.verifyEvidence(claim0);
      if (!evidence.present || evidence.issues.length > 0) f173.push(`evidence ${evidence.issues.join("; ") || "absent"}`);
      if (!existsSync(join(scratch.evidenceDir, claim0.claimId, "raw", `${row0.result?.record.attemptId ?? ""}.agent_stream.jsonl`))) f173.push("raw agent stream not persisted");
    }
    if (scratch0?.cleanupStatus !== "CLEANED" || scratch0.cleanupVerified !== true) f173.push(`cleanup ${String(scratch0?.cleanupStatus)}`);
    if (teardown0?.detail.classification !== "TEARDOWN_CLEAN") f173.push(`classified ${String(teardown0?.detail.classification)}`);
    if (!existsSync(hostSentinel)) f173.push("the unrelated host /tmp sentinel did not survive");
    notes.row0 = { witness: w0, spawnedArgv: spawned0, scratch: scratch0 };
    controls.push(control("F173", "T2", "on the real substrate the agent's /tmp is the attempt's owned directory bound by bwrap; the marker it writes there is removed with the attempt, the raw stream is persisted, the claim is released, and an unrelated host /tmp sentinel survives", "GUARD_SILENT", f173, "REAL_CONTAINER"));

    // ── Row 1: A vtrace — arm 1's sentinel must be invisible (baseline → vtrace) ──
    const row1 = await run(deps, 1);
    const w1 = witness(manifest.rows[1]!);
    const spawned1 = [...binding.agent.lastSpawnedArgv];
    const scratch1 = scratchOf(lastEvent(operationsLedger, "ROW_TEARDOWN"));
    const f174: string[] = [];
    if (row1.result?.record.validity.status !== "VALID_UNRESOLVED") f174.push(`row 1 ${row1.result?.record.validity.status ?? row1.error?.message.slice(0, 300)}`);
    if (w1?.priorSentinel !== "ABSENT") f174.push(`vtrace saw baseline's sentinel: ${JSON.stringify(w1)}`);
    if (scratch1?.cleanupVerified !== true) f174.push(`cleanup ${String(scratch1?.cleanupStatus)}`);
    controls.push(control("F174", "T16", "baseline → vtrace: the sentinel baseline left in its private /tmp is not visible to the vtrace arm of the same task", "GUARD_SILENT", f174, "REAL_CONTAINER"));

    // ── T17: equivalence of the two arms' tmp configuration ─────────────
    const claim1 = registry.claimsForPath(scratch.pathFor(manifest.rows[1]!))[0];
    const f175 = claim0 === undefined || claim1 === undefined
      ? ["claims missing"]
      : [...auditArmTmpEquivalence(
        { sandboxArgv: spawned0, attemptPath: claim0.path, envNames: argvEnv(manifest.rows[0]!) },
        { sandboxArgv: spawned1, attemptPath: claim1.path, envNames: argvEnv(manifest.rows[1]!) },
      )];
    if (claim0 !== undefined && claim1 !== undefined && (claim0.agentTmp.replace(claim0.path, "") !== claim1.agentTmp.replace(claim1.path, ""))) f175.push("private /tmp shape differs");
    notes.armEquivalence = { baseline: spawned0, vtrace: spawned1 };
    controls.push(control("F175", "T17", "baseline and vtrace received identical bwrap tmp configuration and TMP-related environment after normalising the attempt path; the treatment difference is elsewhere", "GUARD_SILENT", f175, "REAL_CONTAINER"));

    // ── Row 2: B vtrace — a detached holder inside the namespace keeps the scratch ──
    const row2 = await run(deps, 2);
    const teardown2 = lastEvent(operationsLedger, "ROW_TEARDOWN");
    const scratch2 = scratchOf(teardown2);
    const residual2 = teardown2?.detail.residual as { liveProcesses: { pid: number; cmdline: string }[]; ownedScratchBytesRemaining?: number; ownedScratchInodesRemaining?: number; harnessContainers: unknown[] } | undefined;
    const claim2 = registry.claimsForPath(scratch.pathFor(holderRow))[0];
    holderPid = residual2?.liveProcesses.find((proc) => proc.cmdline.includes("time.sleep(600)"))?.pid ?? null;
    const f176: string[] = [];
    if (row2.result?.record.validity.status !== "VALID_UNRESOLVED") f176.push(`row 2 ${row2.result?.record.validity.status ?? row2.error?.message.slice(0, 300)}`);
    if (scratch2?.cleanupStatus !== "REFUSED_LIVE_OWNER") f176.push(`cleanup ${String(scratch2?.cleanupStatus)}: ${JSON.stringify(scratch2?.liveReferences).slice(0, 300)}`);
    if (claim2 === undefined || !existsSync(claim2.path)) f176.push("the held scratch was deleted");
    if (holderPid === null) f176.push(`the real enumeration did not list the holder: ${JSON.stringify(residual2?.liveProcesses).slice(0, 300)}`);
    if ((residual2?.ownedScratchInodesRemaining ?? 0) === 0) f176.push("the real probe reported no owned scratch residue");
    if ((residual2?.harnessContainers.length ?? 0) !== 0) f176.push("the container survived teardown");
    if (operations.state() !== "CONTINUATION_BLOCKED") f176.push(`state ${operations.state()}`);
    if (teardown2?.detail.classification !== "TEARDOWN_FAILURE_ISOLATION_UNPROVEN") f176.push(`classified ${String(teardown2?.detail.classification)}`);
    const digest2 = ledger.entries.find((entry) => entry.attemptId === row2.result?.record.attemptId)?.resultDigest ?? null;
    notes.row2 = { holderPid, scratch: scratch2, residual: residual2 };
    controls.push(control("F176", "T6", "a real detached process spawned inside the agent's namespace keeps the owned scratch alive: the container is gone, cleanup refuses, the real enumeration lists the process and the residue bytes, the valid result stands, and continuation is BLOCKED", "GUARD_SILENT", f176, "REAL_CONTAINER"));

    // ── Next row refused; recovery kills the holder and cleans; next row runs ──
    const refused = await run(deps, 3);
    const f177: string[] = [];
    if (!refusedBy("P10_CONTINUATION_SAFETY", refused.error)) f177.push(`row 3 not refused by P10: ${refused.result?.record.attemptId ?? refused.error?.message.slice(0, 200)}`);
    const recovery = await operations.recover();
    const recoveryDetail = recovery.detail as { remediation: { actions: string[]; errors: string[] } };
    if (recovery.kind !== "ISOLATION_RECOVERY_VERIFIED") f177.push(`recovery ${recovery.kind}: ${JSON.stringify(recoveryDetail.remediation).slice(0, 400)}`);
    if (holderPid !== null && alive(holderPid)) f177.push(`holder ${holderPid} still alive after recovery`);
    if (claim2 !== undefined && existsSync(claim2.path)) f177.push("held scratch survived recovery");
    if (claim2 !== undefined && registry.read(claim2.claimId)?.state !== "RELEASED") f177.push("claim not released by recovery");
    if (!recoveryDetail.remediation.actions.some((action) => action.includes("removed owned scratch"))) f177.push(`remediation did not remove the owned scratch through the authority: ${JSON.stringify(recoveryDetail.remediation.actions).slice(0, 300)}`);
    notes.recovery = recoveryDetail.remediation;
    controls.push(control("F177", "T19", "while blocked the next row is refused by P10; the predeclared recovery kills the real holder, removes the owned scratch through the ownership-checked authority, releases the claim, and re-proves isolation", "GUARD_SILENT", f177, "REAL_CONTAINER"));

    const row3 = await run(deps, 3);
    const w3 = witness(manifest.rows[3]!);
    const f178: string[] = [];
    if (row3.result?.record.validity.status !== "VALID_UNRESOLVED") f178.push(`row 3 ${row3.result?.record.validity.status ?? row3.error?.message.slice(0, 300)}`);
    if (w3?.priorSentinel !== "ABSENT") f178.push(`baseline saw vtrace's sentinel: ${JSON.stringify(w3)}`);
    if (ledger.attemptsFor(holderRow.instanceId, holderRow.arm).length !== 1) f178.push("the held row was rerun");
    if (digest2 !== null && ledger.entries.find((entry) => entry.attemptId === row2.result?.record.attemptId)?.resultDigest !== digest2) f178.push("row 2's digest changed");
    if (ledger.entries.length !== 4) f178.push(`${ledger.entries.length} entries`);
    controls.push(control("F178", "T11", "vtrace → baseline: after recovery the baseline arm runs without seeing vtrace's sentinel and without the held row being rerun; four rows, four results", "GUARD_SILENT", f178, "REAL_CONTAINER"));

    // ── High-water observations across the four rows ────────────────────
    const highWater = [...operationsLedger.events].filter((event) => event.kind === "ROW_TEARDOWN").map((event) => {
      const record = scratchOf(event);
      return {
        attemptId: event.attemptId, cleanupStatus: record?.cleanupStatus,
        highWaterBytes: record?.scratchHighWaterBytes, checkpoints: (record?.checkpoints as { label: string; scratchBytes: number; scratchInodes: number }[] | undefined)?.map((c) => ({ label: c.label, bytes: c.scratchBytes, inodes: c.scratchInodes })),
      };
    });
    notes.highWater = { label: "PRE-LAUNCH OBSERVED INFRASTRUCTURE HIGH-WATER (research instances, replay agent; the paid agent's /tmp usage is unknown)", rows: highWater };
    const f179: string[] = [];
    for (const entry of highWater) {
      if (Number(entry.highWaterBytes ?? 0) <= 0) f179.push(`${entry.attemptId}: no high-water`);
      const labels = (entry.checkpoints ?? []).map((c) => c.label);
      for (const required of ["AFTER_CONTAINER_SETUP", "AFTER_AGENT_COMPLETION", "AFTER_EVALUATION", "BEFORE_CLEANUP"]) {
        if (!labels.includes(required)) f179.push(`${entry.attemptId}: missing checkpoint ${required}`);
      }
    }
    if (highWater.length !== 4) f179.push(`${highWater.length} teardown records`);
    controls.push(control("F179", null, "every real row records scratch checkpoints at container setup, agent completion, evaluation and before cleanup, and a positive high-water", "GUARD_SILENT", f179, "REAL_CONTAINER"));

    // ── Emergency abort through the real adapter and the bridge watchdog ──
    const tiny: ScratchPolicy = { ...M218_SCRATCH_POLICY, warningAttemptScratchBytes: 1 << 20, hardAttemptScratchBytes: 3 << 20, monitorIntervalMs: 500 };
    const tinyScratch = new ScratchAuthority({
      namespace, registry, evidenceDir: join(COHORT_DIR, "evidence"), liveness,
      experiment: "M218_RESEARCH_NON_EVALUATION", executorVersion: "m218-real-substrate-emergency", policy: tiny, now,
    });
    const floodBinding = bindingFor((argv, spec) => wrapped({
      fixture: fixtures.correct, witnessDir: join(WITNESS_DIR, "flood"), armLabel: spec.row.arm, flood: true, hangAfter: 3,
    })(argv, spec), tinyScratch);
    mkdirSync(join(WITNESS_DIR, "flood"), { recursive: true });
    const floodOps = new CohortOperations(new CohortOperationsLedger(), floodBinding.probe, WORK_ROOT, now);
    const floodLedger = new CohortLedger("SYNTHETIC", authorities.preregistrationHash.actual, authorities.manifestHash.actual);
    const floodDeps: ExecutorDependencies = {
      mode: "SYNTHETIC", authorities, container: floodBinding.container, agent: floodBinding.agent, evaluator: floodBinding.evaluator,
      ledger: floodLedger, now, spendAuthorization: RESEARCH_AUTHORIZATION, operations: floodOps, scratch: tinyScratch,
    };
    const flood = await run(floodDeps, 0);
    const floodTeardown = lastEvent(floodOps.ledger, "ROW_TEARDOWN");
    const floodScratch = scratchOf(floodTeardown);
    const emergency = (floodScratch?.emergency ?? null) as { aborted: boolean; highWaterBytes: number; reason: string | null } | null;
    const f180: string[] = [];
    if (flood.result?.record.validity.status !== "INFRASTRUCTURE_INVALID") f180.push(`status ${flood.result?.record.validity.status ?? flood.error?.message.slice(0, 300)}`);
    if (flood.result?.record.validity.infrastructureCategory !== "ENVIRONMENT_IRREPRODUCIBLE") f180.push(`category ${flood.result?.record.validity.infrastructureCategory}`);
    if (flood.result?.record.terminationReason !== "HARNESS_ABORT") f180.push(`termination ${flood.result?.record.terminationReason}`);
    if (emergency === null || !emergency.aborted) f180.push(`no emergency recorded: ${JSON.stringify(emergency)}`);
    if (lastEvent(floodOps.ledger, "SCRATCH_EMERGENCY_ABORT") === undefined) f180.push("no SCRATCH_EMERGENCY_ABORT event");
    if (floodScratch?.cleanupVerified !== true) f180.push(`cleanup ${String(floodScratch?.cleanupStatus)}`);
    if (floodOps.state() !== "CONTINUATION_SAFE") f180.push(`state ${floodOps.state()}`);
    const floodEntry = floodLedger.entries[0];
    if (floodEntry !== undefined && floodEntry.costUsd !== 3.5) f180.push(`aborted attempt charged $${floodEntry.costUsd}, not the cap`);
    // The abort must actually stop the subtree: the first run of this control
    // took 328 s because killing bwrap left its child holding the stdout pipe.
    if ((flood.result?.record.wallClockSeconds ?? 999) > 60) f180.push(`the abort took ${flood.result?.record.wallClockSeconds}s; the process subtree was not killed promptly`);
    notes.emergency = { emergency, wallClockSeconds: flood.result?.record.wallClockSeconds, termination: flood.result?.record.terminationReason };
    controls.push(control("F180", null, "a real attempt whose private /tmp crosses a research hard threshold is aborted through the adapter's signal and the bridge's watchdog, classified ENVIRONMENT_IRREPRODUCIBLE (not rerunnable), charged at cap, recorded as SCRATCH_EMERGENCY_ABORT, and its scratch is still cleaned", "GUARD_SILENT", f180, "REAL_CONTAINER"));

    // ── Outcome-blind status; ledger integrity; accounting ──────────────
    const progress = renderProgress(manifest.rows, ledger, null, [], operations, scratch);
    const leaked = outcomeShapedKeys(progress as unknown as Record<string, unknown>);
    controls.push(control("F181", null, "the real cohort's operational view with scratch health names no arm's performance and its operations chain recomputes", "GUARD_SILENT",
      [...leaked.map((key) => `exposes ${key}`), ...operationsLedger.verifyIntegrity()], "REAL_CONTAINER"));
    notes.finalProgress = progress;
    notes.operationalEvents = operationsLedger.events.map((event) => ({ sequence: event.sequence, kind: event.kind, continuationAfter: event.continuationAfter, attemptId: event.attemptId }));

    // ── After the suite: namespace holds only evaluation/ + marker ─────
    const finalSweep = scratch.sweep();
    controls.push(control("F182", "T25", "after every row the namespace holds nothing owned: the final sweep finds only the marker and the COHORT_OWNED evaluation directory", "GUARD_SILENT",
      finalSweep.entries.filter((entry) => !["MARKER", "COHORT_OWNED"].includes(entry.classification)).map((entry) => `${entry.path}: ${entry.classification}`), "REAL_CONTAINER"));
    notes.finalSweep = finalSweep;
  } finally {
    const accounting = await bridge.shutdown();
    notes.substrateAccounting = accounting;
    if (holderPid !== null && alive(holderPid)) {
      try { process.kill(holderPid, "SIGKILL"); } catch { /* best effort */ }
    }
    for (const name of dockerNames("m193-")) {
      try { execFileSync("docker", ["rm", "-f", name]); } catch { /* best effort */ }
    }
    rmSync(hostSentinel, { force: true });
  }

  const accounting = notes.substrateAccounting as { containersStarted: number; containersTornDown: number; frozenInstancesTouched: string[]; nonFrozenInstancesTouched: string[] } | null;
  const document = {
    schemaVersion: "stage5.m218.real-substrate.v1",
    milestone: "M218",
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
    `${document.satisfied}/${document.controlCount} controls satisfied (${document.guardFiresControls} GUARD_FIRES, ${document.guardSilentControls} GUARD_SILENT); failures [${document.failures.join(", ") || "none"}]\n`
    + `containers started ${document.containersStarted}, torn down ${document.containersTornDown}, frozen tasks touched ${document.frozenInstancesTouched.length}, spend $0\nwrote ${OUTPUT}\n`,
  );
  if (!document.suitePasses) process.exitCode = 1;
}

await main();
