/**
 * M219 — the launch-readiness gate table, extended from M218's and still DERIVED.
 *
 * M218's derivation is re-run as a subprocess (which re-runs M217's, M216's
 * and M215's), so the M214–M218 half of the table has exactly one authority.
 * M219's gates are read out of the materialization, container-census, host
 * preflight, launch preflight and falsification evidence.
 *
 * The final verdict is PAID_TWO_ARM_CAUSAL_BENCHMARK_READY_FOR_HUMAN_AUTHORIZATION
 * only when every technical gate passes AND the only remaining blocker is G36
 * (spend authorisation), which this file never sets.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m219_readiness.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LaunchGate } from "./m214Preregistration";
import { M219_PREFLIGHT_VERSION } from "./m219OperatorPreflight";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m219_launch_gates.json");
const VTRACE_ROOT = join(import.meta.dir, "..", "..");

function readJson<T>(name: string): T {
  const path = join(RESULTS_DIR, name);
  if (!existsSync(path)) throw new Error(`${name} is absent; a readiness table derived from nothing would be a claim about nothing`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function gate(id: string, requirement: string, ok: boolean, evidence: string): LaunchGate {
  return { id, requirement, gateClass: "INFRASTRUCTURE", status: ok ? "PASS" : "FAIL", evidence };
}

interface Suite { suitePasses: boolean; satisfied: number; controlCount: number; failures: string[]; guardFiresControls: number; guardSilentControls: number; controls: { id: string; satisfied: boolean }[]; liveModelSpendUsd?: number; providerCalls?: number; frozenInstancesTouched?: string[] }

async function main(): Promise<void> {
  // M218's derivation (which re-runs M217's, M216's and M215's), re-run rather than reimplemented.
  execFileSync("bun", [join(import.meta.dir, "run_stage5_m218_readiness.ts")], { cwd: VTRACE_ROOT, encoding: "utf8", timeout: 1_800_000 });
  const m218 = readJson<{ gates: LaunchGate[]; technicalGateIds: string[]; authorities: Record<string, unknown>; runtimeGuards: Record<string, string>; requiredPrelaunchGateIds: string[]; requiredRuntimeGateIds: string[]; technicalExecutorReady: boolean; financialEnvelope: Record<string, number>; scratchPolicy: unknown }>("stage5_m218_launch_gates.json");

  const before = readJson<{ census: { required: number; present: number; absent: number }; dockerStore: { imageBytes: number }; capacity: { dockerRoot: { freeBytes: number }; sharedTmp: { freeBytes: number } } }>("stage5_m219_image_census_before.json");
  const after = readJson<{ census: { required: number; present: number; absent: number; localNotRequired: string[] }; dockerStore: { imageBytes: number }; capacity: { dockerRoot: { freeBytes: number }; sharedTmp: { freeBytes: number } }; population: { taskCount: number; rowCount: number; uniqueImages: number } }>("stage5_m219_image_census_after.json");
  const pulls = readJson<{ pulled: number; failed: string[]; requestedImages: string[]; onlyRequiredImagesPulled: boolean; pruneOperationsPerformed: number }>("stage5_m219_image_pulls.json");
  const imagePreflight = readJson<{ verdict: string; rowsResolved: string; rowsIdentityVerified: string; adapterResolution: { imagesResolved: number; issues: string[] }; cliPreflight: { rows: number; rowsResolved: number; rowsIdentityVerified: number; uniqueImages: number } }>("stage5_m219_image_preflight.json");
  const containers = readJson<{ verdict: string; uniqueImages: number; validated: number; containersStarted: number; containersTornDown: number; survivingPreflightContainers: number; tasksMappedToValidatedImage: number; agentInvoked: boolean; providerCalls: number; liveModelSpendUsd: number; benchmarkPatchesApplied: number; writableLayerHighWaterBytes: number }>("stage5_m219_container_census.json");
  const host = readJson<{ verdicts: Record<string, string>; cohortNamespace: { sweep: { pass: boolean; cleaned: string[]; blocking: string[] }; capacityGate: { pass: boolean; requiredFreeBytes: number; namespaceFilesystem: { freeBytes: number } } }; provablyOwnedStaleCleanup: { bytesRemoved: number; adHocDeletions: number; cohortCleaned: string[]; researchCleaned: string[] }; historicalTmp: { byClassification: Record<string, { entries: number; bytes: number }>; deleted: number; verdict: string }; residue: { pass: boolean; blocking: string[]; containers: unknown[] }; hostResourceHealth: { pass: boolean; issues: string[]; memoryAvailableBytes: number; processCount: number }; dockerCapacity: { evaluated: boolean; materializationDeltaBytes?: number; gate?: { pass: boolean; requirement: { requiredFreeBytes: number }; filesystem: { freeBytes: number }; issues: string[] } } }>("stage5_m219_host_preflight_after.json");
  const launch = readJson<{ verdict: string; finalBlocker: string; technicalBlockers: string[]; gates: { id: string; pass: boolean }[]; launchPerformed: boolean; rowsExecuted: number; providerCalls: number; liveModelSpendUsd: number; spendAuthorization: { present: boolean; status: string; activeCeilingUsd: number; retryReserveAttempts: number } }>("stage5_m219_launch_preflight.json");
  const suite = readJson<Suite>("stage5_m219_falsification.json");
  const typecheck = readJson<{ m219NewTypecheckErrors: number; verdict: string }>("stage5_m219_scoped_typecheck.json");
  const m218Host = readJson<Suite>("stage5_m218_real_host.json");
  const m218Real = readJson<Suite & { containersStarted: number; frozenBenchmarkTaskLiveAgentRuns: number }>("stage5_m218_real_substrate.json");
  const m218Pure = readJson<Suite>("stage5_m218_falsification.json");

  const m219Gates: LaunchGate[] = [
    gate("G86", "ALL_FROZEN_SWEBENCH_IMAGES_LOCAL: the population derives from the frozen manifest as exactly 100 tasks / 200 rows / 100 unique images, the pre-M219 absence was reproduced and recorded, only the absent required images were pulled with zero failures and zero prune operations, and every required image is now present",
      after.population.taskCount === 100 && after.population.rowCount === 200 && after.population.uniqueImages === 100
      && before.census.required === 100 && after.census.required === 100 && after.census.absent === 0 && after.census.present === 100
      && pulls.failed.length === 0 && pulls.pulled === before.census.absent && pulls.onlyRequiredImagesPulled && pulls.pruneOperationsPerformed === 0
      && pulls.requestedImages.length === before.census.absent,
      `before ${before.census.present}/${before.census.required} present (${before.census.absent} absent); pulled ${pulls.pulled} (requested ${pulls.requestedImages.length}, failed ${pulls.failed.length}); after ${after.census.present}/${after.census.required}; image store ${before.dockerStore.imageBytes} → ${after.dockerStore.imageBytes} bytes`),

    gate("G87", "FROZEN_IMAGE_MAPPING_VERIFIED: all 200 frozen rows resolve without a pull, through docker inspect AND the adapter's own images.get, to a local image whose immutable id and registry digest match the recorded identity",
      imagePreflight.verdict === "IMAGE_PREFLIGHT_PASS" && imagePreflight.cliPreflight.rowsResolved === 200 && imagePreflight.cliPreflight.rowsIdentityVerified === 200
      && imagePreflight.cliPreflight.uniqueImages === 100 && imagePreflight.adapterResolution.imagesResolved === 100 && imagePreflight.adapterResolution.issues.length === 0,
      `${imagePreflight.verdict}; rows resolved ${imagePreflight.rowsResolved}; identity verified ${imagePreflight.rowsIdentityVerified}; adapter resolved ${imagePreflight.adapterResolution.imagesResolved}/100`),

    gate("G88", "REAL_CONTAINER_PREFLIGHT_VERIFIED: every unique required image starts, /testbed exists and is writable, the task's base commit is present and an ancestor of HEAD, a trivial command runs, source identity is unchanged across the probe, and the container tears down; every task maps to a validated image; no agent, patch or model",
      containers.verdict === "REAL_CONTAINER_PREFLIGHT_VERIFIED" && containers.validated === containers.uniqueImages && containers.uniqueImages === 100
      && containers.tasksMappedToValidatedImage === 100 && containers.survivingPreflightContainers === 0 && containers.agentInvoked === false
      && containers.providerCalls === 0 && containers.liveModelSpendUsd === 0 && containers.benchmarkPatchesApplied === 0,
      `${containers.verdict}; ${containers.validated}/${containers.uniqueImages} validated; started ${containers.containersStarted} torn down ${containers.containersTornDown}; tasks mapped ${containers.tasksMappedToValidatedImage}; survivors ${containers.survivingPreflightContainers}; writable high-water ${containers.writableLayerHighWaterBytes} bytes`),

    gate("G89", "PROVABLY_OWNED_STALE_TMP_CLEANED and AMBIGUOUS_HISTORICAL_TMP_PRESERVED: the production sweep ran on the cohort namespace and cleaned exactly what its registry owned with no ad hoc deletion; every historical /tmp entry is classified; none is PROVABLY_OWNED-and-uncleaned or ACTIVE; nothing AMBIGUOUS was deleted",
      host.cohortNamespace.sweep.pass && host.provablyOwnedStaleCleanup.adHocDeletions === 0 && host.historicalTmp.deleted === 0
      && host.historicalTmp.byClassification.ACTIVE!.entries === 0 && host.historicalTmp.verdict === "AMBIGUOUS_HISTORICAL_TMP_PRESERVED",
      `cohort sweep pass ${host.cohortNamespace.sweep.pass} cleaned ${host.provablyOwnedStaleCleanup.cohortCleaned.length}+${host.provablyOwnedStaleCleanup.researchCleaned.length} (${host.provablyOwnedStaleCleanup.bytesRemoved} bytes); historical ${JSON.stringify(host.historicalTmp.byClassification)}; deleted ${host.historicalTmp.deleted}`),

    gate("G90", "TMP_CAPACITY_GATE_PASSED: the exact M218 P13 capacity authority passes on the cohort namespace after materialization, with the frozen threshold unchanged",
      host.cohortNamespace.capacityGate.pass && host.verdicts.TMP_CAPACITY_GATE === "TMP_CAPACITY_GATE_PASS" && host.cohortNamespace.capacityGate.requiredFreeBytes === 34_484_901_888,
      `free ${host.cohortNamespace.capacityGate.namespaceFilesystem.freeBytes} vs required ${host.cohortNamespace.capacityGate.requiredFreeBytes}; /tmp free ${after.capacity.sharedTmp.freeBytes}`),

    gate("G91", "DOCKER_CAPACITY_PREFLIGHT_PASSED: the Docker root filesystem clears a requirement derived from the measured materialization, the largest required image and the observed container writable high-water; no global prune was used",
      host.dockerCapacity.evaluated && host.dockerCapacity.gate?.pass === true && pulls.pruneOperationsPerformed === 0,
      host.dockerCapacity.evaluated ? `free ${host.dockerCapacity.gate?.filesystem.freeBytes} vs required ${host.dockerCapacity.gate?.requirement.requiredFreeBytes}; materialization delta ${host.dockerCapacity.materializationDeltaBytes} bytes; ${host.dockerCapacity.gate?.issues.join("; ") || "no issue"}` : "not evaluated"),

    gate("G92", "NO_ACTIVE_BENCHMARK_RESIDUE and host health: no harness or evaluator container, no substrate/sandbox/evaluator process, no mount under a benchmark root; memory, pid and process-limit headroom present",
      host.residue.pass && host.verdicts.RESIDUE === "NO_ACTIVE_BENCHMARK_RESIDUE" && host.hostResourceHealth.pass,
      `residue blocking [${host.residue.blocking.join(", ")}]; containers enumerated ${host.residue.containers.length}; health issues [${host.hostResourceHealth.issues.join(", ")}]; mem available ${host.hostResourceHealth.memoryAvailableBytes}; processes ${host.hostResourceHealth.processCount}`),

    gate("G93", "FINAL_ZERO_SPEND_LAUNCH_PREFLIGHT_PASSED: the production launcher's --preflight passes frozen identity, executable authority, envelope, binding, ledgers, scratch namespace, substrate identity, scratch/capacity/image identity and isolation, runs no row, and stops at SPEND_AUTHORIZATION_PENDING",
      launch.verdict === "FINAL_ZERO_SPEND_LAUNCH_PREFLIGHT_PASSED" && launch.finalBlocker === "SPEND_AUTHORIZATION_PENDING" && launch.technicalBlockers.length === 0
      && launch.launchPerformed === false && launch.rowsExecuted === 0 && launch.providerCalls === 0 && launch.liveModelSpendUsd === 0
      && launch.spendAuthorization.present === false && launch.spendAuthorization.activeCeilingUsd === 735 && launch.spendAuthorization.retryReserveAttempts === 10,
      `${launch.verdict}; gates ${launch.gates.map((entry) => `${entry.id}=${entry.pass ? "PASS" : "FAIL"}`).join(" ")}; final blocker ${launch.finalBlocker}; ceiling $${launch.spendAuthorization.activeCeilingUsd}`),

    gate("G94", "M219_FALSIFICATION_SUITE_PASSED with both expectations present, and the M219 scope typechecks",
      suite.suitePasses && suite.guardFiresControls > 0 && suite.guardSilentControls > 0 && typecheck.m219NewTypecheckErrors === 0 && typecheck.verdict === "M219_SCOPED_TYPECHECK_VERIFIED",
      `suite ${suite.satisfied}/${suite.controlCount} (fires ${suite.guardFiresControls}, silent ${suite.guardSilentControls}; failures [${suite.failures.join(", ")}]); typecheck ${typecheck.verdict} (${typecheck.m219NewTypecheckErrors} errors)`),

    gate("G95", "M218 scratch controls preserved after materialization: the real-host and real-container suites re-run in full on the materialized host, and the pure suite still passes",
      m218Host.suitePasses && m218Host.satisfied === m218Host.controlCount && m218Real.suitePasses && m218Real.satisfied === m218Real.controlCount && m218Pure.suitePasses,
      `M218 real-host ${m218Host.satisfied}/${m218Host.controlCount}; real-container ${m218Real.satisfied}/${m218Real.controlCount} (containers ${m218Real.containersStarted}, frozen agent runs ${m218Real.frozenBenchmarkTaskLiveAgentRuns}); pure ${m218Pure.satisfied}/${m218Pure.controlCount}`),

    gate("G96", "no frozen task was run with an agent and live model spend is $0 during M219 (image pulls are network traffic, not model spend)",
      containers.providerCalls === 0 && containers.liveModelSpendUsd === 0 && launch.providerCalls === 0 && launch.liveModelSpendUsd === 0
      && (suite.providerCalls ?? 1) === 0 && (suite.liveModelSpendUsd ?? 1) === 0 && (suite.frozenInstancesTouched?.length ?? 1) === 0
      && (m218Real.frozenInstancesTouched?.length ?? 1) === 0,
      `container census provider calls ${containers.providerCalls} spend $${containers.liveModelSpendUsd}; launch preflight provider calls ${launch.providerCalls}; suite provider calls ${suite.providerCalls}; M218 real frozen touched ${m218Real.frozenInstancesTouched?.length}`),
  ];

  const allGates = [...m218.gates, ...m219Gates];
  // G36 (human spend authorisation) is recorded FAIL by the inherited table
  // until a human authorises; it is the one gate this file must never set.
  const g36 = allGates.find((entry) => entry.id === "G36");
  const blockers = allGates.filter((entry) => entry.status === "FAIL").map((entry) => entry.id);
  const technicalBlockers = blockers.filter((id) => id !== "G36");
  const technicalGateIds = [...m218.technicalGateIds, ...m219Gates.map((entry) => entry.id)];
  const technicalGates = technicalGateIds.map((id) => allGates.find((entry) => entry.id === id));
  const technicalExecutorReady = technicalGates.every((entry) => entry?.status === "PASS");
  const pendingNonTechnical = g36 !== undefined && g36.status !== "PASS" ? ["G36"] : [];
  const onlySpendPending = technicalExecutorReady && technicalBlockers.length === 0 && g36 !== undefined && g36.status !== "PASS";

  const document = {
    schemaVersion: "stage5.m219.launch-gates.v1",
    milestone: "M219",
    generatedAt: new Date().toISOString(),
    preflightVersion: M219_PREFLIGHT_VERSION,
    authorities: m218.authorities,
    m218TechnicalExecutorReady: m218.technicalExecutorReady,
    runtimeGuards: {
      ...m218.runtimeGuards,
      P13_SCRATCH_CAPACITY: `${m218.runtimeGuards.P13_SCRATCH_CAPACITY}; M219: the launch preflight also requires every manifest row to resolve to the recorded immutable image identity without a pull`,
    },
    requiredPrelaunchGateIds: m218.requiredPrelaunchGateIds,
    requiredRuntimeGateIds: m218.requiredRuntimeGateIds,
    technicalGateIds,
    gates: allGates,
    blockers,
    technicalBlockers,
    pendingNonTechnical,
    financialEnvelope: m218.financialEnvelope,
    scratchPolicy: m218.scratchPolicy,
    technicalExecutorReady,
    g36: g36 === undefined ? null : { status: g36.status, requirement: g36.requirement },
    spendAuthorized: false,
    readinessVerdict: technicalExecutorReady ? "TECHNICAL_EXECUTOR_READY" : "TECHNICAL_EXECUTOR_NOT_READY",
    finalState: onlySpendPending ? "PAID_TWO_ARM_CAUSAL_BENCHMARK_READY_FOR_HUMAN_AUTHORIZATION" : "PAID_TWO_ARM_CAUSAL_BENCHMARK_NOT_READY",
    spendAuthorizationStatus: "SPEND_AUTHORIZATION_PENDING",
    proposedAuthorizationUsd: m218.financialEnvelope.hardCeilingUsd,
    paidRunsStarted: 0,
    liveModelSpendUsd: 0,
    providerCalls: 0,
    frozenBenchmarkTaskLiveAgentRuns: 0,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `${document.readinessVerdict}; ${document.finalState}; ${document.spendAuthorizationStatus}; technical blockers [${technicalBlockers.join(", ") || "none"}]; G36 ${g36?.status} (human)\n`
    + `M219 gates: ${m219Gates.map((entry) => `${entry.id}=${entry.status}`).join(" ")}\nwrote ${OUTPUT}\n`,
  );
  for (const entry of m219Gates.filter((candidate) => candidate.status === "FAIL")) process.stdout.write(`  ${entry.id}: ${entry.evidence}\n`);
}

await main();
