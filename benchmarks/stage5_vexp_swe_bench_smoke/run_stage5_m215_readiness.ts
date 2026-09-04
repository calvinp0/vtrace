/**
 * M215 §11, §36, §58 — the launch-readiness gate table.
 *
 * Every gate below is DERIVED. G33 and G34 are read from the falsification and
 * dry-run artifacts rather than asserted, G35 is read from the binding registry,
 * G36 from whether an operator has actually authorised the spend, and G32 is the
 * conjunction of G33 and G35 rather than a judgement. Nothing here is markable
 * by hand, which is the property that makes the readiness verdict worth reading.
 *
 * It also re-derives M214's own gate table from the committed document and
 * requires it to be unchanged apart from G32, so M215 cannot quietly relax a
 * preregistration gate on its way to declaring itself ready.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m215_readiness.ts
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type GateInputs,
  type GateStatus,
  type LaunchGate,
  type RunManifestRow,
  evaluateLaunchGates,
  preregistrationComplete,
} from "./m214Preregistration";
import {
  M215_ADAPTER_BINDINGS,
  authoritativeBindingAvailable,
} from "./m215AdapterBindings";
import {
  M215_EXECUTOR_VERSION,
  M215_EXTERNAL_REFERENCE_FILE,
  M215_MANIFEST_FILE,
  M215_PREREGISTRATION_FILE,
  M215_PREREGISTRATION_HASH_EXCLUDED_FIELDS,
  M215_REQUIRED_PRELAUNCH_GATE_IDS,
  M215_REQUIRED_RUNTIME_GATE_IDS,
  auditFrozenTreatmentTree,
  verifyFrozenAuthorities,
} from "./m215LaunchExecutor";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m215_launch_gates.json");

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8")) as Record<string, unknown>;
}

/**
 * The guard each RUNTIME gate names, so "deferred" has an address (§10).
 *
 * M214 wrote the gate class and left the guard names to a launch executor that
 * did not exist. These are those names, and they resolve to real exported
 * functions rather than to intentions.
 */
const M215_RUNTIME_GUARDS: Readonly<Record<string, string>> = Object.freeze({
  sourceStateEquivalence:
    "m215LaunchExecutor preflightGates R6_SOURCE_STATE_EQUIVALENCE, which calls M214's own "
    + "auditSourceStateEquivalence on digests taken either side of treatment initialisation",
  indexingObservational:
    "the same R6 gate: the pre- and post-treatment tracked-source digests must be equal",
  treatmentStateExcludedFromPatch:
    "m215LaunchExecutor R13_PATCH_CAPTURE, over exclusions derived from the pre-agent untracked "
    + "snapshot, with no vendor directory named anywhere in the rule",
  resetWarmPolicySymmetric:
    "m215LaunchExecutor R7_RESET_WARMTH_POLICY, calling auditWarmthPolicy and "
    + "auditResetPreservedPaths against the frozen COLD_UNIFORM regime",
  modelAvailability:
    "m215LaunchExecutor R12_PROVIDER_MODEL_IDENTITY, reading the provider-returned identity from "
    + "the run's own init event via AgentRunHooks.assertProviderModelIdentity, which aborts the run",
  treatmentLifecycleOrder:
    "m215LaunchExecutor R14_LIFECYCLE_ORDER, over the phases the executor actually reached",
});

/** Rebuild M214's gate inputs from its own committed table, so nothing is re-judged. */
function gateInputsFromCommitted(
  committed: readonly LaunchGate[], launchExecutorExists: boolean,
): GateInputs {
  const status = (id: string): GateStatus => {
    const gate = committed.find((entry) => entry.id === id);
    if (gate === undefined) throw new Error(`M214 gate ${id} is missing from the committed table`);
    return gate.status;
  };
  const passed = (id: string): boolean => status(id) === "PASS";
  return {
    preregistrationCommitted: passed("G1"),
    preregistrationHashRecorded: passed("G2"),
    m213Immutable: passed("G3"),
    externalTaskArtifactVerified: passed("G4"),
    taskIdsFrozen: passed("G5"),
    manifestRowCount: passed("G6") ? 200 : 0,
    baselineTreatmentFree: passed("G7"),
    vtraceExecutable: passed("G8"),
    vtraceIdentityFrozen: passed("G9"),
    agentIdentityFrozen: passed("G10"),
    modelIdentityFrozen: passed("G11"),
    nativeToolsIdentical: passed("G12"),
    budgetsIdentical: passed("G13"),
    sourceStateEquivalence: status("G14"),
    indexingObservational: status("G15"),
    treatmentStateExcludedFromPatch: status("G16"),
    resetWarmPolicySymmetric: status("G17"),
    executionOrderFrozen: passed("G18"),
    evaluatorValidated: passed("G19"),
    pairedAnalysisFrozen: passed("G20"),
    efficiencyAnalysisFrozen: passed("G21"),
    invalidRunRulesFrozen: passed("G22"),
    stoppingRuleFrozen: passed("G23"),
    externalReferenceFrozen: passed("G24"),
    externalReferenceCannotEnterCausalAnalysis: passed("G25"),
    falsificationSuitePasses: passed("G26"),
    noOutcomeBearingRunHasOccurred: passed("G27"),
    liveModelSpendIsZero: passed("G28"),
    scopedTypecheckClean: passed("G29"),
    modelAvailabilityEvidence: status("G30"),
    treatmentLifecycleOrderVerified: status("G31"),
    launchExecutorExists,
    runtimeGuards: M215_RUNTIME_GUARDS,
  };
}

function gate(
  id: string, requirement: string, gateClass: LaunchGate["gateClass"], ok: boolean, evidence: string,
): LaunchGate {
  return { id, requirement, gateClass, status: ok ? "PASS" : "FAIL", evidence };
}

async function main(): Promise<void> {
  const preregistration = readJson(M215_PREREGISTRATION_FILE);
  const manifestDocument = readJson(M215_MANIFEST_FILE) as unknown as {
    rows: RunManifestRow[]; manifestHash: string;
  };
  const authorities = verifyFrozenAuthorities(
    preregistration, manifestDocument, readJson(M215_EXTERNAL_REFERENCE_FILE),
  );

  const falsification = readJson("stage5_m215_falsification.json") as unknown as {
    suitePasses: boolean; controlCount: number; satisfied: number; failures: string[];
    guardFiresControls: number; guardSilentControls: number;
  };
  const dryRun = readJson("stage5_m215_dry_run.json") as unknown as {
    layers: { layer: string; invariants?: Record<string, boolean> }[];
    resume: { duplicateAttempts: number; restoreIssues: string[]; integrityIssues: string[] };
    liveModelSpendUsd: number; frozenBenchmarkTaskLiveAgentRuns: number;
  };
  const scopedTypecheck = readJson("stage5_m215_scoped_typecheck.json") as unknown as {
    m215NewTypecheckErrors: number;
  };

  const gitRoot = join(import.meta.dir, "..", "..");
  const observedProductTree = execFileSync(
    "git", ["-C", gitRoot, "rev-parse", "HEAD:src"],
  ).toString().trim();

  const patchInvariants = dryRun.layers.find(
    (layer) => layer.layer === "D4_REAL_GIT_PATCH_CAPTURE",
  )!.invariants!;

  // ── M215's own gates, each derived from an artifact ───────────────

  const executorImplemented = falsification.controlCount > 0
    && dryRun.layers.length === 4
    && M215_REQUIRED_RUNTIME_GATE_IDS.length > 0;
  const executorFalsified = falsification.suitePasses;
  const substrateBinding = authoritativeBindingAvailable();
  // §30 — technical readiness is not authorisation, and M215 asks for none.
  const spendAuthorized = false;

  const m215Gates: LaunchGate[] = [
    gate("G33", "LAUNCH_EXECUTOR_IMPLEMENTED: one executor runs any frozen manifest row through "
      + "the frozen lifecycle under runtime enforcement", "INFRASTRUCTURE", executorImplemented,
    `${M215_EXECUTOR_VERSION}: ${M215_REQUIRED_PRELAUNCH_GATE_IDS.length} prelaunch and `
    + `${M215_REQUIRED_RUNTIME_GATE_IDS.length} runtime gates, one arm-neutral orchestration, `
    + "cohort launcher, append-only ledger, resume, spend guard"),

    gate("G34", "LAUNCH_EXECUTOR_FALSIFIED: the enforcement is exercised by controls that fail "
      + "when the guards are removed", "INFRASTRUCTURE", executorFalsified,
    `${falsification.satisfied}/${falsification.controlCount} controls satisfied `
    + `(${falsification.guardFiresControls} GUARD_FIRES, ${falsification.guardSilentControls} `
    + `GUARD_SILENT); failures: [${falsification.failures.join(", ") || "none"}]`),

    gate("G35", "an adapter binding exists that can produce authoritative outcomes on the real "
      + "substrate", "INFRASTRUCTURE", substrateBinding,
    `bindings: ${M215_ADAPTER_BINDINGS.map((b) => `${b.id}=${b.status}`).join(", ")}. The `
    + "executor's containers, agent process and evaluator are interfaces; only the synthetic "
    + "binding is implemented, and it cannot write authoritative cohort results"),

    gate("G36", "explicit operator authorisation of the frozen $700 ceiling exists",
      "INFRASTRUCTURE", spendAuthorized,
      "M215 requested no authorisation and spent $0. Building the executor is not authorisation; "
      + "the launcher refuses a COHORT run without --authorize-spend"),

    gate("G37", "patch capture is unambiguous on both treatment-state routes, against real git",
      "INFRASTRUCTURE",
      patchInvariants.noSourceEditInitRouteIsEmpty
      && patchInvariants.noSourceEditIndexOnlyRouteIsEmpty
      && patchInvariants.oneSourceEditIsExactlyThatFile
      && patchInvariants.legacyVendorExclusionsLeakTreatmentState,
      "D4 on a scratch repository outside the frozen 100: empty on both routes with no source "
      + "edit, exactly the edited file with one, and the pre-repair vendor rule leaks where the "
      + "derived rule does not"),

    gate("G38", "the cohort survives interruption with no duplicate and no reordered outcome",
      "INFRASTRUCTURE",
      dryRun.resume.duplicateAttempts === 0
      && dryRun.resume.restoreIssues.length === 0
      && dryRun.resume.integrityIssues.length === 0,
      "D-resume: ledger persisted, restored and continued; digests and chain recomputed on replay"),

    gate("G39", "M215-owned harness and tests are typechecked", "INFRASTRUCTURE",
      scopedTypecheck.m215NewTypecheckErrors === 0,
      "tsconfig.m215.json extends M214's scope to this milestone's files"),

    gate("G40", "the frozen VTRACE treatment tree is unchanged", "PREREGISTRATION",
      auditFrozenTreatmentTree(authorities.manifest, observedProductTree).length === 0,
      `HEAD:src is ${observedProductTree}, which is the tree every vtrace manifest row declares; `
      + "M215 changed no src/ file"),

    gate("G41", "M214's frozen authorities are unmodified", "PREREGISTRATION",
      authorities.verified,
      `preregistration ${authorities.preregistrationHash.actual.slice(0, 16)}, manifest `
      + `${authorities.manifestHash.actual.slice(0, 16)}, external reference `
      + `${authorities.externalReferenceHash.actual.slice(0, 16)}, all recomputed from the `
      + "committed bytes"),

    gate("G42", "no frozen-population outcome-bearing run occurred and live model spend is $0 "
      + "during M215", "INFRASTRUCTURE",
    dryRun.frozenBenchmarkTaskLiveAgentRuns === 0 && dryRun.liveModelSpendUsd === 0,
    "every layer ran against synthetic adapters or real git; no provider was contacted"),
  ];

  // ── M214's table, re-derived and required to be unchanged ─────────

  const committed = preregistration.launchGates as LaunchGate[];
  // G32 is the conjunction of "the orchestration exists" and "a substrate
  // binding exists", so it is computed rather than judged, and it is still FAIL.
  const m214Gates = evaluateLaunchGates(
    gateInputsFromCommitted(committed, executorImplemented && substrateBinding),
  );

  const unchangedApartFromG32 = committed
    .filter((entry) => entry.id !== "G32")
    .every((entry) => {
      const rederived = m214Gates.find((candidate) => candidate.id === entry.id);
      return rederived !== undefined
        && rederived.status === entry.status
        && rederived.gateClass === entry.gateClass
        && rederived.requirement === entry.requirement;
    });

  const allGates = [...m214Gates, ...m215Gates];
  const blockers = allGates.filter((entry) => entry.status === "FAIL").map((entry) => entry.id);
  const deferred = allGates.filter((entry) => entry.status === "DEFERRED_TO_LAUNCH");

  const technicalGateIds = ["G32", "G33", "G34", "G35", "G37", "G38", "G39"];
  const technicalExecutorReady = allGates
    .filter((entry) => technicalGateIds.includes(entry.id))
    .every((entry) => entry.status === "PASS");

  const document = {
    schemaVersion: "stage5.m215.launch-gates.v1",
    milestone: "M215",
    generatedAt: new Date().toISOString(),
    executorVersion: M215_EXECUTOR_VERSION,
    authorities: {
      preregistration: authorities.preregistrationHash,
      manifest: authorities.manifestHash,
      externalReference: authorities.externalReferenceHash,
      preregistrationHashExcludedFields: M215_PREREGISTRATION_HASH_EXCLUDED_FIELDS,
      documentedExclusionsAreIncomplete: true,
      documentedExclusionNote:
        "M214's published hashRule names three excluded fields; its generator excludes nine, the "
        + "six extra being outputs derived from the document and written into it after hashing. "
        + "The executor reproduces the generator's rule exactly. The frozen artifact is NOT edited "
        + "to correct its own prose, because that would change the digest it froze.",
    },
    m214PreregistrationComplete: preregistrationComplete(m214Gates),
    m214TableUnchangedApartFromG32: unchangedApartFromG32,
    runtimeGuards: M215_RUNTIME_GUARDS,
    requiredPrelaunchGateIds: M215_REQUIRED_PRELAUNCH_GATE_IDS,
    requiredRuntimeGateIds: M215_REQUIRED_RUNTIME_GATE_IDS,
    gates: allGates,
    deferredRuntimeGates: deferred.map((entry) => entry.id),
    blockers,
    technicalExecutorReady,
    spendAuthorized,
    readinessVerdict: technicalExecutorReady
      ? "TECHNICAL_EXECUTOR_READY"
      : "TECHNICAL_EXECUTOR_NOT_READY",
    spendAuthorizationStatus: "SPEND_AUTHORIZATION_PENDING",
    paidRunsStarted: 0,
    liveModelSpendUsd: 0,
  };

  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`${document.readinessVerdict}; blockers [${blockers.join(", ")}]\n`);
  process.stdout.write(
    `m214 table unchanged apart from G32: ${document.m214TableUnchangedApartFromG32}\n`,
  );
  process.stdout.write(`wrote ${OUTPUT}\n`);
}

await main();
