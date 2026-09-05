/**
 * M217 §23, §28 — the launch-readiness gate table, extended and still DERIVED.
 *
 * M216's derivation is re-run as a subprocess (which re-runs M215's), so the
 * M214+M215+M216 half of the table has exactly one authority. M217's gates are
 * read out of the pure and real-substrate evidence by CONTROL ID, plus the
 * guard-break verdict, the scoped typecheck and the launch-risk artifact.
 *
 * `TECHNICAL_EXECUTOR_READY` is the conjunction of the technical gates and is
 * never assigned. G36 (spend authorisation) stays outside it.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m217_readiness.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LaunchGate } from "./m214Preregistration";
import { M215_ADAPTER_BINDINGS } from "./m215AdapterBindings";
import { M217_CONTINUATION_VERSION } from "./m217ContinuationSafety";
import { M217_LAUNCH_BINDING_VERSION } from "./m217LaunchBinding";
import { M217_FROZEN_RETRY_RESERVE_POLICY, frozenSpendArithmetic } from "./m217RetryReserve";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m217_launch_gates.json");
const VTRACE_ROOT = join(import.meta.dir, "..", "..");

interface SuiteDocument {
  readonly suitePasses: boolean;
  readonly controlCount: number;
  readonly satisfied: number;
  readonly failures: readonly string[];
  readonly guardFiresControls: number;
  readonly guardSilentControls: number;
  readonly controls: readonly { id: string; satisfied: boolean; expectation: string; detail: string }[];
  readonly liveModelSpendUsd?: number;
  readonly providerCalls?: number;
  readonly frozenBenchmarkTaskLiveAgentRuns?: number;
  readonly frozenInstancesTouched?: readonly string[];
  readonly containersStarted?: number;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function require(path: string, what: string): void {
  if (!existsSync(path)) {
    throw new Error(`${what} is absent at ${path}; a readiness table derived from nothing would be a claim about nothing`);
  }
}

function gateFromControls(
  id: string, requirement: string,
  sources: readonly { readonly label: string; readonly document: SuiteDocument; readonly ids: readonly string[] }[],
  extraIssues: readonly string[] = [],
): LaunchGate {
  const missing: string[] = [];
  const unsatisfied: string[] = [];
  for (const source of sources) {
    for (const controlId of source.ids) {
      const found = source.document.controls.find((entry) => entry.id === controlId);
      if (found === undefined) missing.push(`${source.label}:${controlId}`);
      else if (!found.satisfied) unsatisfied.push(`${source.label}:${controlId}`);
    }
  }
  const ok = missing.length === 0 && unsatisfied.length === 0 && extraIssues.length === 0;
  const named = sources.map((source) => `${source.label} [${source.ids.join(", ")}]`).join("; ");
  return {
    id, requirement, gateClass: "INFRASTRUCTURE", status: ok ? "PASS" : "FAIL",
    evidence: ok
      ? `controls ${named} all satisfied`
      : `missing [${missing.join(", ")}]; unsatisfied [${unsatisfied.join(", ")}]; ${extraIssues.join("; ")}`,
  };
}

function plainGate(id: string, requirement: string, ok: boolean, evidence: string): LaunchGate {
  return { id, requirement, gateClass: "INFRASTRUCTURE", status: ok ? "PASS" : "FAIL", evidence };
}

async function main(): Promise<void> {
  const purePath = join(RESULTS_DIR, "stage5_m217_falsification.json");
  const realPath = join(RESULTS_DIR, "stage5_m217_real_substrate.json");
  const guardBreakPath = join(RESULTS_DIR, "stage5_m217_guard_break.json");
  const typecheckPath = join(RESULTS_DIR, "stage5_m217_scoped_typecheck.json");
  const riskPath = join(RESULTS_DIR, "stage5_m217_launch_risk.json");
  require(purePath, "the M217 pure falsification evidence");
  require(realPath, "the M217 real-substrate evidence");
  require(guardBreakPath, "the M217 guard-break evidence");
  require(typecheckPath, "the M217 scoped typecheck evidence");
  require(riskPath, "the M217 launch-risk artifact");

  // M216's derivation (which re-runs M215's), re-run rather than reimplemented.
  execFileSync("bun", [join(import.meta.dir, "run_stage5_m216_readiness.ts")], {
    cwd: VTRACE_ROOT, encoding: "utf8", timeout: 900_000,
  });
  const m216 = readJson<{
    gates: LaunchGate[]; technicalGateIds: string[]; authorities: Record<string, unknown>;
    runtimeGuards: Record<string, string>; requiredPrelaunchGateIds: string[]; requiredRuntimeGateIds: string[];
    m214TableUnchangedApartFromG32: boolean; technicalExecutorReady: boolean;
  }>(join(RESULTS_DIR, "stage5_m216_launch_gates.json"));

  const pure = readJson<SuiteDocument>(purePath);
  const real = readJson<SuiteDocument>(realPath);
  const guardBreak = readJson<{ verdict: string; pure: { broken: { failures: string[] } | null }; real: { broken: { failures: string[] } | null }; missedFailures: string[]; unexpectedFailures: string[] }>(guardBreakPath);
  const typecheck = readJson<{ m217NewTypecheckErrors: number; verdict: string }>(typecheckPath);
  const risk = readJson<{ paidRetryReserveUsd: number; maximumPlannedExposureUsd: number; ceilingAwaitingAuthorizationUsd: number; retryPolicyBinding: { policy: string } }>(riskPath);
  const m216Real = readJson<SuiteDocument>(join(RESULTS_DIR, "stage5_m216_real_substrate.json"));
  const m215Suite = readJson<SuiteDocument>(join(RESULTS_DIR, "stage5_m215_falsification.json"));
  const arithmetic = frozenSpendArithmetic();
  const launcherSource = readFileSync(join(import.meta.dir, "run_stage5_m215_launch.ts"), "utf8");

  const P = { label: "pure", document: pure } as const;
  const R = { label: "real", document: real } as const;

  const m217Gates: LaunchGate[] = [
    gateFromControls("G56", "TEARDOWN_RESULT_VALIDITY_SEPARATED_FROM_CONTINUATION_SAFETY: a completed "
      + "result keeps its status, bytes and digest across a teardown failure, a halt and a recovery",
    [{ ...P, ids: ["F87", "F88", "F95"] }, { ...R, ids: ["F108"] }]),

    gateFromControls("G57", "TEARDOWN_ISOLATION_INTERLOCK_IMPLEMENTED: every teardown is followed by an "
      + "enumeration; residue of any class blocks, absence proves, a failed probe blocks",
    [{ ...P, ids: ["F82", "F83", "F84", "F97", "F98", "F99", "F101", "F102"] },
      { ...R, ids: ["F106", "F107", "F107B", "F112", "F113", "F114", "F115", "F117"] }]),

    gateFromControls("G58", "COHORT_HALT_ON_ISOLATION_RISK_VERIFIED: with isolation unproven no next row "
      + "launches, no container starts, and no flag or direct selection can force one",
    [{ ...P, ids: ["F84", "F85", "F103"] }, { ...R, ids: ["F104", "F109", "F109B"] }]),

    gateFromControls("G59", "ISOLATION_RECOVERY_PATH_VERIFIED: the predeclared path removes exactly the "
      + "residue, re-proves by a second enumeration, resumes at the next unstarted row and reruns nothing",
    [{ ...P, ids: ["F86", "F96", "F100"] }, { ...R, ids: ["F110", "F111"] }]),

    gateFromControls("G60", "FROZEN_SPEND_ARITHMETIC_VERIFIED and ZERO_RETRY_HEADROOM_RECORDED: 200 x the "
      + "frozen cap equals the frozen ceiling, and the launch-risk artifact records the $0 reserve",
    [{ ...P, ids: ["F89"] }],
    [
      ...(arithmetic.plannedRowsConsistent ? [] : arithmetic.inconsistencies),
      ...(risk.paidRetryReserveUsd === arithmetic.retryReserveUsd ? [] : ["launch-risk reserve differs from the arithmetic"]),
      ...(risk.maximumPlannedExposureUsd === risk.ceilingAwaitingAuthorizationUsd ? [] : ["exposure and ceiling differ"]),
    ]),

    gateFromControls("G61", "RETRY_SPEND_INTERLOCK_VERIFIED: before a paid retry the three numbers are "
      + "computed, the frozen policy is applied, the declaration is recorded, and a spend halt fabricates nothing",
    [{ ...P, ids: ["F90", "F91", "F91B", "F92", "F93"] }],
    risk.retryPolicyBinding.policy === M217_FROZEN_RETRY_RESERVE_POLICY ? [] : ["the artifact's policy is not the frozen binding"]),

    gateFromControls("G62", "OUTCOME_BLIND_OPERATIONS: halt, spend and isolation status expose no arm's performance",
      [{ ...P, ids: ["F94"] }, { ...R, ids: ["F116"] }]),

    plainGate("G63", "M217_FALSIFICATION_SUITE_PASSED and M217_SUITE_IS_FALSIFYING: both suites satisfied, "
      + "both expectations present, and the two new guards demonstrably load-bearing",
    pure.suitePasses && real.suitePasses
      && pure.guardFiresControls > 0 && pure.guardSilentControls > 0
      && real.guardFiresControls > 0 && real.guardSilentControls > 0
      && guardBreak.verdict === "M217_SUITE_IS_FALSIFYING",
    `pure ${pure.satisfied}/${pure.controlCount}; real ${real.satisfied}/${real.controlCount}; guard-break `
    + `${guardBreak.verdict} (pure broken failing [${guardBreak.pure.broken?.failures.join(", ") ?? "?"}], real `
    + `broken failing [${guardBreak.real.broken?.failures.join(", ") ?? "?"}], missed [${guardBreak.missedFailures.join(", ")}], `
    + `unexpected [${guardBreak.unexpectedFailures.join(", ")}])`),

    plainGate("G64", "M217-owned harness and tests are typechecked",
      typecheck.m217NewTypecheckErrors === 0 && typecheck.verdict === "M217_SCOPED_TYPECHECK_VERIFIED",
      `tsconfig.m217.json: ${typecheck.m217NewTypecheckErrors} errors; ${typecheck.verdict}`),

    plainGate("G65", "LAUNCHER_BINDING_RESOLUTION: the launcher resolves the DOCKER_SWEBENCH adapters through "
      + "one factory that the real-substrate controls also ran a full row through",
    launcherSource.includes("startCohortBinding(") && !launcherSource.includes("declares no adapters")
      && (real.controls.find((entry) => entry.id === "F106")?.satisfied ?? false),
    `${M217_LAUNCH_BINDING_VERSION}; launcher calls startCohortBinding; real F106 `
    + `${real.controls.find((entry) => entry.id === "F106")?.satisfied ? "satisfied" : "unsatisfied"}`),

    plainGate("G66", "no frozen task was touched and live model spend is $0 during M217",
      (real.frozenInstancesTouched?.length ?? 1) === 0 && (real.liveModelSpendUsd ?? 1) === 0
      && (real.providerCalls ?? 1) === 0 && (real.frozenBenchmarkTaskLiveAgentRuns ?? 1) === 0
      && (pure.liveModelSpendUsd ?? 1) === 0 && (pure.providerCalls ?? 1) === 0,
      `real: frozen touched ${real.frozenInstancesTouched?.length ?? "?"}, provider calls ${real.providerCalls ?? "?"}, `
      + `spend $${real.liveModelSpendUsd ?? "?"}, containers ${real.containersStarted ?? "?"}; pure: provider calls ${pure.providerCalls ?? "?"}`),

    plainGate("G67", "M215 and M216 controls preserved: the predecessor suites still pass in full",
      m215Suite.suitePasses && m215Suite.satisfied === m215Suite.controlCount
      && m216Real.suitePasses && m216Real.satisfied === m216Real.controlCount,
      `M215 ${m215Suite.satisfied}/${m215Suite.controlCount}; M216 real ${m216Real.satisfied}/${m216Real.controlCount}`),
  ];

  const allGates = [...m216.gates, ...m217Gates];
  const blockers = allGates.filter((gate) => gate.status === "FAIL").map((gate) => gate.id);
  const deferred = allGates.filter((gate) => gate.status === "DEFERRED_TO_LAUNCH").map((gate) => gate.id);
  const technicalGateIds = [...m216.technicalGateIds, ...m217Gates.map((gate) => gate.id)];
  const technicalGates = technicalGateIds.map((id) => allGates.find((gate) => gate.id === id));
  const missingTechnicalGates = technicalGateIds.filter((_id, index) => technicalGates[index] === undefined);
  const technicalExecutorReady = missingTechnicalGates.length === 0
    && technicalGates.every((gate) => gate?.status === "PASS");

  const document = {
    schemaVersion: "stage5.m217.launch-gates.v1",
    milestone: "M217",
    generatedAt: new Date().toISOString(),
    continuationVersion: M217_CONTINUATION_VERSION,
    authorities: m216.authorities,
    m214TableUnchangedApartFromG32: m216.m214TableUnchangedApartFromG32,
    m216TechnicalExecutorReady: m216.technicalExecutorReady,
    adapterBindings: M215_ADAPTER_BINDINGS.map((entry) => ({ id: entry.id, status: entry.status, authoritative: entry.authoritative })),
    runtimeGuards: {
      ...m216.runtimeGuards,
      P10_CONTINUATION_SAFETY: "the next row may begin only when the operations ledger's state is CONTINUATION_SAFE and its chain recomputes",
      P11_RETRY_SPEND_RESERVE: "before any attempt: cumulative + this attempt's cap + remaining required attempts at cap, against the ceiling, under the frozen policy",
    },
    requiredPrelaunchGateIds: [...m216.requiredPrelaunchGateIds, "P10_CONTINUATION_SAFETY", "P11_RETRY_SPEND_RESERVE"]
      .filter((id, index, list) => list.indexOf(id) === index),
    requiredRuntimeGateIds: m216.requiredRuntimeGateIds,
    technicalGateIds,
    missingTechnicalGates,
    gates: allGates,
    deferredRuntimeGates: deferred,
    blockers,
    spendArithmetic: arithmetic,
    retryReservePolicy: M217_FROZEN_RETRY_RESERVE_POLICY,
    technicalExecutorReady,
    spendAuthorized: false,
    readinessVerdict: technicalExecutorReady ? "TECHNICAL_EXECUTOR_READY" : "TECHNICAL_EXECUTOR_NOT_READY",
    spendAuthorizationStatus: "SPEND_AUTHORIZATION_PENDING",
    paidRunsStarted: 0,
    liveModelSpendUsd: 0,
    frozenBenchmarkTaskLiveAgentRuns: 0,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `${document.readinessVerdict}; ${document.spendAuthorizationStatus}; blockers [${blockers.join(", ") || "none"}]\n`
    + `M217 gates: ${m217Gates.map((gate) => `${gate.id}=${gate.status}`).join(" ")}\nwrote ${OUTPUT}\n`,
  );
}

await main();
