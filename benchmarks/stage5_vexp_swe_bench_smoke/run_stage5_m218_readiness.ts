/**
 * M218 §39, §62 — the launch-readiness gate table, extended and still DERIVED.
 *
 * M217's derivation is re-run as a subprocess (which re-runs M216's and
 * M215's), so the M214–M217 half of the table has exactly one authority.
 * M218's gates are read out of the pure, real-host and real-container evidence
 * by CONTROL ID, plus the guard-break verdict, the scoped typecheck, the census
 * and the amendment record.
 *
 * `TECHNICAL_EXECUTOR_READY` is the conjunction of the technical gates and is
 * never assigned. G36 (spend authorisation) stays outside it and now names $735.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m218_readiness.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LaunchGate } from "./m214Preregistration";
import { M215_ADAPTER_BINDINGS } from "./m215AdapterBindings";
import { M218_FROZEN_AMENDMENT_HASH } from "./m218Amendment";
import { M218_SCRATCH_POLICY, M218_SCRATCH_VERSION } from "./m218ScratchLifecycle";
import { M218_SPEND_AUTHORITY_VERSION, loadActiveSpendAuthority } from "./m218SpendAuthority";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m218_launch_gates.json");
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
  if (!existsSync(path)) throw new Error(`${what} is absent at ${path}; a readiness table derived from nothing would be a claim about nothing`);
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
    evidence: ok ? `controls ${named} all satisfied` : `missing [${missing.join(", ")}]; unsatisfied [${unsatisfied.join(", ")}]; ${extraIssues.join("; ")}`,
  };
}

function plainGate(id: string, requirement: string, ok: boolean, evidence: string): LaunchGate {
  return { id, requirement, gateClass: "INFRASTRUCTURE", status: ok ? "PASS" : "FAIL", evidence };
}

async function main(): Promise<void> {
  const purePath = join(RESULTS_DIR, "stage5_m218_falsification.json");
  const hostPath = join(RESULTS_DIR, "stage5_m218_real_host.json");
  const realPath = join(RESULTS_DIR, "stage5_m218_real_substrate.json");
  const guardBreakPath = join(RESULTS_DIR, "stage5_m218_guard_break.json");
  const typecheckPath = join(RESULTS_DIR, "stage5_m218_scoped_typecheck.json");
  const censusPath = join(RESULTS_DIR, "stage5_m218_tmp_census.json");
  const amendmentRecordPath = join(RESULTS_DIR, "stage5_m214_a1_amendment_hash.json");
  const riskPath = join(RESULTS_DIR, "stage5_m218_launch_risk.json");
  for (const [path, what] of [
    [purePath, "the M218 pure falsification evidence"], [hostPath, "the M218 real-host evidence"], [realPath, "the M218 real-container evidence"],
    [guardBreakPath, "the M218 guard-break evidence"], [typecheckPath, "the M218 scoped typecheck evidence"], [censusPath, "the M218 census"],
    [amendmentRecordPath, "the M214-A1 amendment hash record"], [riskPath, "the M218 launch-risk artifact"],
  ] as const) require(path, what);

  // M217's derivation (which re-runs M216's and M215's), re-run rather than reimplemented.
  execFileSync("bun", [join(import.meta.dir, "run_stage5_m217_readiness.ts")], { cwd: VTRACE_ROOT, encoding: "utf8", timeout: 1_800_000 });
  const m217 = readJson<{
    gates: LaunchGate[]; technicalGateIds: string[]; authorities: Record<string, unknown>;
    runtimeGuards: Record<string, string>; requiredPrelaunchGateIds: string[]; requiredRuntimeGateIds: string[];
    m214TableUnchangedApartFromG32: boolean; technicalExecutorReady: boolean;
  }>(join(RESULTS_DIR, "stage5_m217_launch_gates.json"));

  const pure = readJson<SuiteDocument>(purePath);
  const host = readJson<SuiteDocument>(hostPath);
  const real = readJson<SuiteDocument>(realPath);
  const guardBreak = readJson<{ verdict: string; missedFailures: string[]; unexpectedFailures: string[]; breakages: { id: string; observedPureFailures: string[]; observedHostFailures: string[] }[] }>(guardBreakPath);
  const typecheck = readJson<{ m218NewTypecheckErrors: number; verdict: string }>(typecheckPath);
  const census = readJson<{ verdict: string; policyInputsAgree: boolean; lifetimeCounts: Record<string, number>; historicalScratchDisposition: { cleaned: number } }>(censusPath);
  const amendmentRecord = readJson<{ recordedHash: string; recomputedFromWrittenFile: string; matchesPinnedConstant: boolean; verified: boolean; parent: { parentRecordAgrees: boolean }; financialEnvelope: { hardCeilingUsd: number; retryReserveUsd: number; retryReserveAttempts: number; ordinaryExposureUsd: number; manifestRows: number; intendedValidOutcomes: number } }>(amendmentRecordPath);
  const risk = readJson<{ ceilingAwaitingAuthorizationUsd: number; retryReserveAttempts: number; retryReserveUsd: number; amendmentHash: string }>(riskPath);
  const m217Pure = readJson<SuiteDocument>(join(RESULTS_DIR, "stage5_m217_falsification.json"));
  const m217Real = readJson<SuiteDocument>(join(RESULTS_DIR, "stage5_m217_real_substrate.json"));
  const m216Real = readJson<SuiteDocument>(join(RESULTS_DIR, "stage5_m216_real_substrate.json"));
  const m215Suite = readJson<SuiteDocument>(join(RESULTS_DIR, "stage5_m215_falsification.json"));
  const authority = loadActiveSpendAuthority(RESULTS_DIR);
  const launcherSource = readFileSync(join(import.meta.dir, "run_stage5_m215_launch.ts"), "utf8");

  const P = { label: "pure", document: pure } as const;
  const H = { label: "host", document: host } as const;
  const R = { label: "real", document: real } as const;

  const m218Gates: LaunchGate[] = [
    gateFromControls("G68", "PRE_OUTCOME_FINANCIAL_AMENDMENT_COMMITTED: M214's bytes and digests are untouched, the committed A1 recomputes to the pinned digest, its parent is M214, and it changes only the financial reserve",
      [{ ...P, ids: ["F118", "F119", "F120", "F121", "F122", "F125"] }],
      [
        ...(amendmentRecord.matchesPinnedConstant && amendmentRecord.verified && amendmentRecord.parent.parentRecordAgrees ? [] : ["the amendment hash record does not verify"]),
        ...(authority.amendmentHash === M218_FROZEN_AMENDMENT_HASH ? [] : ["the loaded authority is not the pinned amendment"]),
        ...(amendmentRecord.financialEnvelope.manifestRows === 200 && amendmentRecord.financialEnvelope.intendedValidOutcomes === 200 ? [] : ["the amendment does not keep 200 rows / 200 outcomes"]),
      ]),

    gateFromControls("G69", "RETRY_RESERVE_10_ATTEMPTS and HARD_SPEND_CEILING_$735: the reserve is exactly 10 x $3.50 = $35 over $700, the eleventh retry is refused RETRY_RESERVE_EXHAUSTED, a non-preregistered class is refused with the reserve intact, and no retry class was created",
      [{ ...P, ids: ["F122", "F123", "F124"] }],
      [
        ...(amendmentRecord.financialEnvelope.hardCeilingUsd === 735 && amendmentRecord.financialEnvelope.retryReserveUsd === 35 && amendmentRecord.financialEnvelope.retryReserveAttempts === 10 && amendmentRecord.financialEnvelope.ordinaryExposureUsd === 700 ? [] : ["the financial envelope is not $700 + $35 = $735 / 10 attempts"]),
        ...(risk.ceilingAwaitingAuthorizationUsd === 735 && risk.retryReserveAttempts === 10 && risk.amendmentHash === M218_FROZEN_AMENDMENT_HASH ? [] : ["the launch-risk artifact disagrees with the amendment"]),
      ]),

    gateFromControls("G70", "EXECUTABLE_AUTHORITY_BINDING: the launcher and executor require M214 + A1; M214's $700 authority alone and a $700 authorisation are refused by name",
      [{ ...P, ids: ["F120", "F125B", "F125C"] }],
      launcherSource.includes("loadActiveSpendAuthority(") && launcherSource.includes("spendAuthority: authority")
        ? [] : ["the launcher does not bind the active spend authority"]),

    plainGate("G71", "TMP_LIFECYCLE_CENSUS_COMPLETE: every producer on the paid path is attributed and classified, the policy's observed inputs agree with the census, and no historical scratch was deleted",
      census.verdict === "M218_TMP_LIFECYCLE_CENSUS_COMPLETE" && census.policyInputsAgree && census.historicalScratchDisposition.cleaned === 0,
      `${census.verdict}; lifetimes ${JSON.stringify(census.lifetimeCounts)}; policyInputsAgree ${census.policyInputsAgree}; historical cleaned ${census.historicalScratchDisposition.cleaned}`),

    gateFromControls("G72", "RUN_OWNED_TMP_NAMESPACE_ENFORCED: every attempt claims an owned path under the marked namespace before use, no attempt inherits scratch, unregistered paths are never deleted, and run A cannot touch run B",
      [{ ...P, ids: ["F126", "F129", "F130", "F148"] }, { ...R, ids: ["F172", "F173"] }]),

    gateFromControls("G73", "AGENT_TMP_ISOLATED_PER_ATTEMPT: the real bwrap namespace binds the attempt's owned directory at /tmp, the agent's marker is removed with the attempt, and a sentinel from arm 1 is invisible to arm 2 in both orders",
      [{ ...P, ids: ["F127", "F141"] }, { ...R, ids: ["F173", "F174", "F178"] }]),

    gateFromControls("G74", "BASELINE_VTRACE_TMP_EQUIVALENCE: both arms receive the same private-/tmp configuration and policy, differing only in the attempt path",
      [{ ...P, ids: ["F142"] }, { ...R, ids: ["F175"] }]),

    gateFromControls("G75", "RUN_TMP_CLEANUP_VERIFIED: cleanup runs after the container is gone, is verified by measurement to 0 bytes, survives an exception, and removes large nested trees",
      [{ ...P, ids: ["F126", "F128", "F143"] }, { ...H, ids: ["F166"] }, { ...R, ids: ["F173", "F179"] }]),

    gateFromControls("G76", "STALE_TMP_RECOVERY_VERIFIED: stale owned scratch is classified by ownership facts, never by age, cleaned when safe, blocked when unsafe or unknown, and a crashed executor's scratch is recovered on resume",
      [{ ...P, ids: ["F133", "F134", "F150"] }, { ...H, ids: ["F170"] }, { ...R, ids: ["F182"] }]),

    gateFromControls("G77", "TMP_CAPACITY_GATE_VERIFIED: P13 refuses below the derived threshold or on low inodes before any container or claim, accepts above it, refuses a tmpfs-hosted namespace, and passes on the cohort's real filesystem",
      [{ ...P, ids: ["F137", "F138", "F139"] }, { ...H, ids: ["F171", "F171B"] }, { ...R, ids: ["F172"] }]),

    gateFromControls("G78", "TMP_CLEANUP_PART_OF_CONTINUATION_SAFETY: a live process, mount or container makes cleanup refuse; the valid result stands; the next row is blocked; the predeclared recovery removes exactly the owned residue and the cohort resumes without a rerun",
      [{ ...P, ids: ["F131", "F132", "F135", "F136", "F144", "F149"] }, { ...H, ids: ["F168"] }, { ...R, ids: ["F176", "F177", "F178"] }]),

    gateFromControls("G79", "TMP_PATH_SAFETY_VERIFIED: deletion never follows a symlink, never leaves the canonical namespace, and /, /tmp, $HOME, an empty path and the namespace root are structurally refused",
      [{ ...P, ids: ["F145", "F146", "F147"] }, { ...H, ids: ["F167", "F169"] }]),

    gateFromControls("G80", "EVIDENCE_PERSISTED_BEFORE_CLEANUP: the raw stream, patch and evaluation are copied out and digest-verified before cleanup and cannot be reached by it",
      [{ ...P, ids: ["F140"] }, { ...R, ids: ["F173"] }]),

    gateFromControls("G81", "SCRATCH_EMERGENCY_AND_STATUS: the per-attempt emergency threshold aborts through the real adapter and the bridge watchdog under the frozen infrastructure class, and operational views stay outcome-blind",
      [{ ...P, ids: ["F151", "F152"] }, { ...R, ids: ["F180", "F181"] }]),

    plainGate("G82", "M218_FALSIFICATION_SUITE_PASSED and M218_SUITE_IS_FALSIFYING: all three suites satisfied with both expectations present, and the three new guards demonstrably load-bearing",
      pure.suitePasses && host.suitePasses && real.suitePasses
      && pure.guardFiresControls > 0 && pure.guardSilentControls > 0 && host.guardFiresControls > 0 && real.guardSilentControls > 0
      && guardBreak.verdict === "M218_SUITE_IS_FALSIFYING",
      `pure ${pure.satisfied}/${pure.controlCount}; host ${host.satisfied}/${host.controlCount}; real ${real.satisfied}/${real.controlCount}; guard-break ${guardBreak.verdict} `
      + `(${guardBreak.breakages.map((b) => `${b.id}: [${[...b.observedPureFailures, ...b.observedHostFailures].join(", ")}]`).join("; ")}; missed [${guardBreak.missedFailures.join(", ")}]; unexpected [${guardBreak.unexpectedFailures.join(", ")}])`),

    plainGate("G83", "M218-owned harness and tests are typechecked",
      typecheck.m218NewTypecheckErrors === 0 && typecheck.verdict === "M218_SCOPED_TYPECHECK_VERIFIED",
      `tsconfig.m218.json: ${typecheck.m218NewTypecheckErrors} errors; ${typecheck.verdict}`),

    plainGate("G84", "no frozen task was touched and live model spend is $0 during M218",
      (real.frozenInstancesTouched?.length ?? 1) === 0 && (real.liveModelSpendUsd ?? 1) === 0 && (real.providerCalls ?? 1) === 0
      && (real.frozenBenchmarkTaskLiveAgentRuns ?? 1) === 0 && (pure.liveModelSpendUsd ?? 1) === 0 && (host.liveModelSpendUsd ?? 1) === 0,
      `real: frozen touched ${real.frozenInstancesTouched?.length ?? "?"}, provider calls ${real.providerCalls ?? "?"}, spend $${real.liveModelSpendUsd ?? "?"}, containers ${real.containersStarted ?? "?"}; pure/host provider calls ${pure.providerCalls ?? "?"}/${host.providerCalls ?? "?"}`),

    plainGate("G85", "M215, M216 and M217 controls preserved: the predecessor suites still pass in full under the M218 adapters, bridge and executor",
      m215Suite.suitePasses && m215Suite.satisfied === m215Suite.controlCount
      && m216Real.suitePasses && m216Real.satisfied === m216Real.controlCount
      && m217Pure.suitePasses && m217Pure.satisfied === m217Pure.controlCount
      && m217Real.suitePasses && m217Real.satisfied === m217Real.controlCount,
      `M215 ${m215Suite.satisfied}/${m215Suite.controlCount}; M216 real ${m216Real.satisfied}/${m216Real.controlCount}; M217 pure ${m217Pure.satisfied}/${m217Pure.controlCount}; M217 real ${m217Real.satisfied}/${m217Real.controlCount}`),
  ];

  // G36 is restated: the human authorisation now concerns $735 under M214 + A1.
  const inherited = m217.gates.map((gate) => (gate.id === "G36"
    ? { ...gate, requirement: `${gate.requirement} (M218: the amount awaiting authorisation is the $${authority.hardCeilingUsd} hard ceiling under M214 + ${authority.amendmentId})`, evidence: `${gate.evidence}; M218 proposes $${authority.hardCeilingUsd} = $${authority.ordinaryExposureUsd} + $${authority.retryReserveUsd}` }
    : gate));
  const allGates = [...inherited, ...m218Gates];
  const blockers = allGates.filter((gate) => gate.status === "FAIL").map((gate) => gate.id);
  const deferred = allGates.filter((gate) => gate.status === "DEFERRED_TO_LAUNCH").map((gate) => gate.id);
  const technicalGateIds = [...m217.technicalGateIds, ...m218Gates.map((gate) => gate.id)];
  const technicalGates = technicalGateIds.map((id) => allGates.find((gate) => gate.id === id));
  const missingTechnicalGates = technicalGateIds.filter((_id, index) => technicalGates[index] === undefined);
  const technicalExecutorReady = missingTechnicalGates.length === 0 && technicalGates.every((gate) => gate?.status === "PASS");

  const document = {
    schemaVersion: "stage5.m218.launch-gates.v1",
    milestone: "M218",
    generatedAt: new Date().toISOString(),
    scratchVersion: M218_SCRATCH_VERSION,
    spendAuthorityVersion: M218_SPEND_AUTHORITY_VERSION,
    authorities: { ...m217.authorities, amendment: { id: authority.amendmentId, hash: authority.amendmentHash, executableAuthority: authority.executableAuthority.identity } },
    m214TableUnchangedApartFromG32: m217.m214TableUnchangedApartFromG32,
    m217TechnicalExecutorReady: m217.technicalExecutorReady,
    adapterBindings: M215_ADAPTER_BINDINGS.map((entry) => ({ id: entry.id, status: entry.status, authoritative: entry.authoritative })),
    runtimeGuards: {
      ...m217.runtimeGuards,
      P11_RETRY_SPEND_RESERVE: `${m217.runtimeGuards.P11_RETRY_SPEND_RESERVE}; M218: a retry must also be admitted by the fixed reserve (frozen class, slot, dollars at cap, ceiling) and RETRY_RESERVE_EXHAUSTED refuses`,
      P12_EXECUTABLE_AUTHORITY: "a COHORT row requires the executable authority M214 + A1 bound with matching lineage; M214's $700 authority alone is refused",
      P13_SCRATCH_CAPACITY: "before every attempt the namespace filesystem and the shared /tmp must satisfy the frozen scratch policy (host reserve + projected attempt, inodes, tmp floor)",
    },
    requiredPrelaunchGateIds: [...m217.requiredPrelaunchGateIds, "P12_EXECUTABLE_AUTHORITY", "P13_SCRATCH_CAPACITY"].filter((id, index, list) => list.indexOf(id) === index),
    requiredRuntimeGateIds: m217.requiredRuntimeGateIds,
    technicalGateIds,
    missingTechnicalGates,
    gates: allGates,
    deferredRuntimeGates: deferred,
    blockers,
    scratchPolicy: M218_SCRATCH_POLICY,
    financialEnvelope: amendmentRecord.financialEnvelope,
    technicalExecutorReady,
    spendAuthorized: false,
    readinessVerdict: technicalExecutorReady ? "TECHNICAL_EXECUTOR_READY" : "TECHNICAL_EXECUTOR_NOT_READY",
    spendAuthorizationStatus: "SPEND_AUTHORIZATION_PENDING",
    proposedAuthorizationUsd: authority.hardCeilingUsd,
    paidRunsStarted: 0,
    liveModelSpendUsd: 0,
    frozenBenchmarkTaskLiveAgentRuns: 0,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `${document.readinessVerdict}; ${document.spendAuthorizationStatus}; blockers [${blockers.join(", ") || "none"}]\n`
    + `M218 gates: ${m218Gates.map((gate) => `${gate.id}=${gate.status}`).join(" ")}\nwrote ${OUTPUT}\n`,
  );
}

await main();
