/**
 * M216 §59 — the launch-readiness gate table, extended and still DERIVED.
 *
 * Nothing here is markable by hand. M215's own derivation is re-run as a
 * subprocess rather than reimplemented, so the M214+M215 half of the table has
 * exactly one authority; M216's gates are then read out of the real-substrate
 * evidence by CONTROL ID, so a control that stops being emitted takes its gate
 * down with it rather than leaving a green row behind.
 *
 * `TECHNICAL_EXECUTOR_READY` is the conjunction of the technical gates. It is
 * never assigned.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m216_readiness.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LaunchGate } from "./m214Preregistration";
import { M214_BUDGET } from "./m214Preregistration";
import { M215_ADAPTER_BINDINGS, dockerSwebenchEvidence } from "./m215AdapterBindings";
import { M216_ADAPTER_VERSION } from "./m216ProductionAdapters";
import { auditSpendProjection } from "./m216RealSubstrate";
import { reductionVerdict } from "./m216SubstrateAudit";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m216_launch_gates.json");
const VTRACE_ROOT = join(import.meta.dir, "..", "..");

interface RealSubstrateDocument {
  readonly suitePasses: boolean;
  readonly controlCount: number;
  readonly satisfied: number;
  readonly failures: readonly string[];
  readonly guardFiresControls: number;
  readonly guardSilentControls: number;
  readonly containersStarted: number;
  readonly containersTornDown: number;
  readonly frozenInstancesTouched: readonly string[];
  readonly nonFrozenInstancesTouched: readonly string[];
  readonly liveModelSpendUsd: number;
  readonly providerCalls: number;
  readonly frozenBenchmarkTaskLiveAgentRuns: number;
  readonly controls: readonly {
    id: string; satisfied: boolean; expectation: string; detail: string;
  }[];
  readonly executedRows: readonly Record<string, unknown>[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * A gate that names the controls it stands on.
 *
 * Requiring the control to be PRESENT as well as satisfied is the same rule
 * M215 applied to runtime gates: `every(satisfied)` over a list that has lost a
 * member is trivially true, and subtraction is the realistic way enforcement
 * decays.
 */
function gateFromControls(
  id: string, requirement: string, document: RealSubstrateDocument,
  controlIds: readonly string[],
): LaunchGate {
  const found = controlIds.map(
    (controlId) => document.controls.find((entry) => entry.id === controlId),
  );
  const missing = controlIds.filter((_id, index) => found[index] === undefined);
  const unsatisfied = found
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .filter((entry) => !entry.satisfied)
    .map((entry) => entry.id);
  const ok = missing.length === 0 && unsatisfied.length === 0;
  return {
    id, requirement, gateClass: "INFRASTRUCTURE", status: ok ? "PASS" : "FAIL",
    evidence: ok
      ? `controls ${controlIds.join(", ")} all satisfied`
      : `missing [${missing.join(", ")}]; unsatisfied [${unsatisfied.join(", ")}]`,
  };
}

function plainGate(
  id: string, requirement: string, ok: boolean, evidence: string,
): LaunchGate {
  return { id, requirement, gateClass: "INFRASTRUCTURE", status: ok ? "PASS" : "FAIL", evidence };
}

async function main(): Promise<void> {
  const substratePath = join(RESULTS_DIR, "stage5_m216_real_substrate.json");
  if (!existsSync(substratePath)) {
    throw new Error(
      "the real-substrate evidence is absent; run run_stage5_m216_real_substrate.ts first. A "
      + "readiness table derived from nothing would be a readiness claim about nothing.",
    );
  }

  // M215's derivation, re-run rather than reimplemented. It reads the binding
  // registry, which now resolves DOCKER_SWEBENCH from the evidence above, so
  // G32 and G35 move only because the binding really is exercised.
  execFileSync(
    "bun", [join(import.meta.dir, "run_stage5_m215_readiness.ts")],
    { cwd: VTRACE_ROOT, encoding: "utf8", timeout: 900_000 },
  );
  const m215 = readJson<{
    gates: LaunchGate[]; deferredRuntimeGates: string[];
    m214TableUnchangedApartFromG32: boolean;
    authorities: Record<string, unknown>;
    requiredPrelaunchGateIds: string[]; requiredRuntimeGateIds: string[];
    runtimeGuards: Record<string, string>;
  }>(join(RESULTS_DIR, "stage5_m215_launch_gates.json"));

  const substrate = readJson<RealSubstrateDocument>(substratePath);
  const typecheck = readJson<{ m216NewTypecheckErrors: number; verdict: string }>(
    join(RESULTS_DIR, "stage5_m216_scoped_typecheck.json"),
  );
  const reduction = readJson<{ verdict: string }>(
    join(RESULTS_DIR, "stage5_m216_substrate_reduction.json"),
  );
  const binding = dockerSwebenchEvidence();
  const projection = auditSpendProjection();

  const m216Gates: LaunchGate[] = [
    plainGate("G43", "M216_SUBSTRATE_REDUCTION_COMPLETE: every obligation M215's interfaces impose "
      + "is matched to an existing authority or named as a missing primitive",
    reduction.verdict === "M216_SUBSTRATE_REDUCTION_COMPLETE"
      && reductionVerdict().verdict === "M216_SUBSTRATE_REDUCTION_COMPLETE",
    `${reduction.verdict}; ${reductionVerdict().directReuse} DIRECT_REUSE, `
    + `${reductionVerdict().thinAdapter} THIN_ADAPTER, `
    + `${reductionVerdict().missingPrimitive} MISSING_PRIMITIVE`),

    plainGate("G44", "REAL_CONTAINER_ADAPTER_BOUND: the production container adapter exists and "
      + "started real containers", binding.adaptersPresent && substrate.containersStarted > 0,
    `${M216_ADAPTER_VERSION}; ${substrate.containersStarted} containers started, `
    + `${substrate.containersTornDown} torn down`),

    gateFromControls("G45", "REAL_AGENT_ADAPTER_BOUND: the production argv, environment and "
      + "process reach a real child, and the two arms differ only in MCP configuration",
    substrate, [
      "F51A", "F51", "F21", "F21B", "F79",
      "F59_BASELINE_FIRST", "F59_VTRACE_FIRST", "F26_BASELINE_FIRST", "F26_VTRACE_FIRST",
    ]),

    gateFromControls("G46", "REAL_EVALUATOR_ADAPTER_BOUND: the official swebench evaluator is "
      + "invoked and infrastructure failure stays distinct from an unresolved task",
    substrate, ["E1", "F56", "F56B", "F57"]),

    gateFromControls("G47", "REAL_SOURCE_STATE_AUTHORITY_VERIFIED: source identity is measured, "
      + "moves when source moves, and is equal across both arms of a pair",
    substrate, [
      "F45", "F45B", "F46", "F46A", "F70", "F71", "F74",
      "F50_BASELINE_FIRST", "F50_VTRACE_FIRST",
    ]),

    gateFromControls("G48", "REAL_PATCH_CAPTURE_VERIFIED: the derived rule is unambiguous on both "
      + "treatment routes, captures real edits exactly, and excludes treatment state written "
      + "during the run", substrate, [
      "F41P1", "F41P2", "F41P4", "F41P5", "F41P6", "F47", "F48", "F47R", "F47RB", "F72", "F75",
    ]),

    gateFromControls("G49", "REAL_PAIR_ISOLATION_VERIFIED: both arm orders run on the real "
      + "substrate with no treatment state surviving between them",
    substrate, [
      "F49_BASELINE_FIRST", "F49_VTRACE_FIRST", "F62", "F76", "F77", "F73",
    ]),

    gateFromControls("G50", "MODEL_IDENTITY_RUNTIME_GATE_BOUND: the production agent path aborts "
      + "on a wrong or absent provider identity, and accepts a recorded correct one",
    substrate, ["F53", "F54", "F55", "F53R", "F54R", "F69", "F80", "F81"]),

    gateFromControls("G51", "REAL_RESUME_PATH_VERIFIED: a ledger restores in another process, a "
      + "decided row is refused rather than rerun, and no duplicate outcome is possible",
    substrate, ["F61A", "F61", "F58"]),

    plainGate("G52", "M216_FALSIFICATION_SUITE_PASSED: every real-substrate control is satisfied "
      + "and the suite carries both expectations",
    substrate.suitePasses
      && substrate.satisfied === substrate.controlCount
      && substrate.guardFiresControls > 0
      && substrate.guardSilentControls > 0,
    `${substrate.satisfied}/${substrate.controlCount} controls satisfied `
    + `(${substrate.guardFiresControls} GUARD_FIRES, ${substrate.guardSilentControls} `
    + `GUARD_SILENT); failures [${substrate.failures.join(", ") || "none"}]`),

    plainGate("G53", "no frozen task was touched by the real substrate and live model spend is $0",
      substrate.frozenInstancesTouched.length === 0
      && substrate.liveModelSpendUsd === 0
      && substrate.providerCalls === 0
      && substrate.frozenBenchmarkTaskLiveAgentRuns === 0,
      `frozen tasks touched ${substrate.frozenInstancesTouched.length}; non-frozen `
      + `[${substrate.nonFrozenInstancesTouched.join(", ")}]; provider calls `
      + `${substrate.providerCalls}; spend $${substrate.liveModelSpendUsd}`),

    plainGate("G54", "SPEND_PROJECTION_RECONCILED: the mathematically possible cohort is "
      + "reconciled with the frozen ceiling, retry exposure included",
    projection.firstAttemptFitsCeiling && projection.guardBoundsActualSpend,
    `200 x $${projection.perRunCapUsd} = $${projection.firstAttemptMaximumUsd} against a `
    + `$${projection.ceilingUsd} ceiling; retry headroom $${projection.retryHeadroomUsd}; a fully `
    + `retried cohort would be $${projection.mathematicalMaximumUsd}, which the guard refuses `
    + "rather than funds"),

    plainGate("G55", "M216-owned harness, adapters and tests are typechecked",
      typecheck.m216NewTypecheckErrors === 0
      && typecheck.verdict === "M216_SCOPED_TYPECHECK_VERIFIED",
      `tsconfig.m216.json: ${typecheck.m216NewTypecheckErrors} errors; ${typecheck.verdict}`),
  ];

  const allGates = [...m215.gates, ...m216Gates];
  const blockers = allGates.filter((gate) => gate.status === "FAIL").map((gate) => gate.id);
  const deferred = allGates
    .filter((gate) => gate.status === "DEFERRED_TO_LAUNCH").map((gate) => gate.id);

  // M215's technical set, plus M216's. G36 is deliberately absent: it is spend
  // authorisation, which is a separate fact from technical readiness in both
  // directions and which this milestone neither has nor requests.
  const technicalGateIds = [
    "G32", "G33", "G34", "G35", "G37", "G38", "G39",
    "G43", "G44", "G45", "G46", "G47", "G48", "G49", "G50", "G51", "G52", "G53", "G54", "G55",
  ];
  const technicalGates = technicalGateIds.map(
    (id) => allGates.find((gate) => gate.id === id),
  );
  const missingTechnicalGates = technicalGateIds.filter((_id, index) => technicalGates[index] === undefined);
  const technicalExecutorReady = missingTechnicalGates.length === 0
    && technicalGates.every((gate) => gate?.status === "PASS");

  const document = {
    schemaVersion: "stage5.m216.launch-gates.v1",
    milestone: "M216",
    generatedAt: new Date().toISOString(),
    adapterVersion: M216_ADAPTER_VERSION,
    authorities: m215.authorities,
    m214TableUnchangedApartFromG32: m215.m214TableUnchangedApartFromG32,
    adapterBindings: M215_ADAPTER_BINDINGS.map((entry) => ({
      id: entry.id, status: entry.status, authoritative: entry.authoritative,
    })),
    dockerSwebenchBindingEvidence: {
      exercised: binding.exercised,
      adaptersPresent: binding.adaptersPresent,
      evidencePresent: binding.evidencePresent,
      reasons: binding.reasons,
    },
    runtimeGuards: m215.runtimeGuards,
    requiredPrelaunchGateIds: m215.requiredPrelaunchGateIds,
    requiredRuntimeGateIds: m215.requiredRuntimeGateIds,
    technicalGateIds,
    missingTechnicalGates,
    gates: allGates,
    deferredRuntimeGates: deferred,
    blockers,
    spendProjection: projection,
    technicalExecutorReady,
    // §61 — no authorisation has been given, and building the binding is not it.
    spendAuthorized: false,
    readinessVerdict: technicalExecutorReady
      ? "TECHNICAL_EXECUTOR_READY"
      : "TECHNICAL_EXECUTOR_NOT_READY",
    spendAuthorizationStatus: "SPEND_AUTHORIZATION_PENDING",
    paidRunsStarted: 0,
    liveModelSpendUsd: 0,
    frozenBenchmarkTaskLiveAgentRuns: 0,
  };

  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `${document.readinessVerdict}; ${document.spendAuthorizationStatus}; `
    + `blockers [${blockers.join(", ") || "none"}]\n`,
  );
  process.stdout.write(
    `bindings ${document.adapterBindings.map((b) => `${b.id}=${b.status}`).join(", ")}\n`,
  );
  process.stdout.write(`wrote ${OUTPUT}\n`);
  void M214_BUDGET;
}

await main();
