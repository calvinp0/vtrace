/**
 * M220 — the launch-readiness gate table, extended from M219's and still DERIVED.
 *
 * M219's derivation is re-run as a subprocess (which re-runs M218's, M217's,
 * M216's and M215's), so the M214–M219 half of the table has exactly one
 * authority. M220's gates are read out of the falsification, guard-break,
 * scoped-typecheck, subscription-audit, launch-preflight and frozen-artifact
 * evidence by control id and by field.
 *
 * Three verdict lines are kept apart on purpose:
 *   TECHNICAL_EXECUTOR_READY      every technical gate passes (never assigned)
 *   OPERATOR_PREREQUISITES        account/host conditions the launch refuses on
 *                                 until the operator changes them (today: paid
 *                                 overflow enabled at the account); not technical
 *                                 defects and not the spend gate
 *   G36                           human spend authorisation; never set here
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m220_readiness.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LaunchGate } from "./m214Preregistration";
import { M220_FROZEN_A2_HASH } from "./m220Amendment";
import { M220_QUOTA_SESSION_VERSION } from "./m220QuotaSession";
import { M220_AUTH_VERSION, M220_REQUIRED_AUTHORIZATION_TEXT } from "./m220SubscriptionAuth";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m220_launch_gates.json");
const VTRACE_ROOT = join(import.meta.dir, "..", "..");

function readJson<T>(name: string): T {
  const path = join(RESULTS_DIR, name);
  if (!existsSync(path)) throw new Error(`${name} is absent; a readiness table derived from nothing would be a claim about nothing`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

interface Suite { suitePasses: boolean; satisfied: number; controlCount: number; failures: string[]; guardFiresControls: number; guardSilentControls: number; controls: { id: string; satisfied: boolean }[]; providerCalls?: number; liveModelSpendUsd?: number; frozenInstancesTouched?: string[]; containersStarted?: number }

function controlsPass(suite: Suite, ids: readonly string[]): { ok: boolean; evidence: string } {
  const missing = ids.filter((id) => !suite.controls.some((entry) => entry.id === id));
  const unsatisfied = ids.filter((id) => suite.controls.find((entry) => entry.id === id)?.satisfied === false);
  return { ok: missing.length === 0 && unsatisfied.length === 0, evidence: `controls [${ids.join(", ")}]${missing.length > 0 ? ` missing [${missing.join(", ")}]` : ""}${unsatisfied.length > 0 ? ` unsatisfied [${unsatisfied.join(", ")}]` : " all satisfied"}` };
}

function gate(id: string, requirement: string, ok: boolean, evidence: string): LaunchGate {
  return { id, requirement, gateClass: "INFRASTRUCTURE", status: ok ? "PASS" : "FAIL", evidence };
}

async function main(): Promise<void> {
  execFileSync("bun", [join(import.meta.dir, "run_stage5_m219_readiness.ts")], { cwd: VTRACE_ROOT, encoding: "utf8", timeout: 1_800_000 });
  const m219 = readJson<{ gates: LaunchGate[]; technicalGateIds: string[]; authorities: Record<string, unknown>; runtimeGuards: Record<string, string>; requiredPrelaunchGateIds: string[]; requiredRuntimeGateIds: string[]; technicalExecutorReady: boolean; financialEnvelope: Record<string, number>; scratchPolicy: unknown }>("stage5_m219_launch_gates.json");

  const suite = readJson<Suite>("stage5_m220_falsification.json");
  const guardBreak = readJson<{ verdict: string; breakages: { id: string; missed: string[]; unexpected: string[]; observedFailures: string[] }[]; sourceFilesRestoredIntact: boolean; restored: { failures: string[] } }>("stage5_m220_guard_break.json");
  const typecheck = readJson<{ verdict: string; m220NewTypecheckErrors: number; findings: Record<string, boolean> }>("stage5_m220_scoped_typecheck.json");
  const audit = readJson<{ authModeVerdict: string; authModeStrength: string; overflowVerdict: string; launchPermitted: boolean; verdicts: Record<string, unknown>; offlineCliAuth: { verdict: string }; environment: { verdict: string }; autoUpdate: { verdict: string }; quotaAvailability: Record<string, string> }>("stage5_m220_subscription_audit.json");
  const preflight = readJson<{ verdict: string; finalBlocker: string; technicalBlockers: string[]; gates: { id: string; pass: boolean }[]; operatorPrerequisitesPending: string[]; launchWouldBeRefusedByAuthGuard: boolean; launchPerformed: boolean; rowsExecuted: number; providerCalls: number; liveModelSpendUsd: number; sessionModel: { amendmentId: string } | null; spendAuthorization: { status: string; activeCeilingUsd: number } }>("stage5_m220_launch_preflight.json");
  const artifacts = readJson<{ allFrozenIdentical: boolean; srcUnchanged: boolean; a2: { verified: boolean; tracked: boolean; recomputed: string; pinned: string; scope: string; outcomeBearingRunsBeforeAmendment: number; executableAuthority: string }; outcomeBearingRunsRecorded: number; frozen: { name: string; matchesM219Blob: boolean }[]; headSrc: string; providerCalls: number; liveModelSpendUsd: number; frozenBenchmarkTaskLiveAgentRuns: number; containersStartedByM220: number }>("stage5_m220_frozen_artifacts.json");
  const a2Record = readJson<{ verified: boolean; matchesPinnedConstant: boolean; parent: { parentRecordsAgree: boolean }; quotaInterruption: { classificationVerdict: string; frozenClass: string; newRetryClassesCreated: number } }>("stage5_m214_a2_amendment_hash.json");
  const m215 = readJson<Suite>("stage5_m215_falsification.json");
  const m217 = readJson<Suite>("stage5_m217_falsification.json");
  const m218 = readJson<Suite>("stage5_m218_falsification.json");
  const m219Suite = readJson<Suite>("stage5_m219_falsification.json");

  const preflightGate = (id: string): boolean => preflight.gates.find((entry) => entry.id === id)?.pass === true;
  const c = (ids: readonly string[]) => controlsPass(suite, ids);

  const m220Gates: LaunchGate[] = [
    gate("G97", "PRE_OUTCOME_QUOTA_SCHEDULING_AMENDMENT_COMMITTED: A2 is tracked, recomputes to the pinned digest, its parents (M214 x3 + A1) agree with their committed records, its scope is operational only, it records 0 outcome-bearing runs before it, and 0 outcome-bearing runs exist",
      artifacts.a2.tracked && artifacts.a2.verified && a2Record.verified && a2Record.matchesPinnedConstant && a2Record.parent.parentRecordsAgree && artifacts.a2.pinned === M220_FROZEN_A2_HASH && artifacts.a2.scope === "OPERATIONAL_QUOTA_WINDOW_SCHEDULING_ONLY" && artifacts.a2.outcomeBearingRunsBeforeAmendment === 0 && artifacts.outcomeBearingRunsRecorded === 0,
      `A2 ${artifacts.a2.recomputed} pinned ${artifacts.a2.pinned} tracked ${artifacts.a2.tracked}; executable authority (M214 + A1 + A2) ${artifacts.a2.executableAuthority}; outcome-bearing runs ${artifacts.outcomeBearingRunsRecorded}`),

    gate("G98", "CLAUDE_MAX_SUBSCRIPTION_MODE_AUDITED: the real host's subscription-auth audit proves the claude.ai / firstParty / max login at LOCAL_CLI_AUTH_STATE strength with no provider override present, the CLI's auth status works with networking unshared, and the claim is bounded to provider confirmation PENDING_AT_FIRST_LIVE_RUN",
      audit.authModeVerdict === "SUBSCRIPTION_AUTH_MODE_PROVEN" && audit.authModeStrength === "LOCAL_CLI_AUTH_STATE" && audit.environment.verdict === "NO_PROVIDER_OVERRIDE_PRESENT" && audit.offlineCliAuth.verdict === "ZERO_NETWORK_AUTH_STATUS_VERIFIED" && c(["F199", "F230"]).ok,
      `${audit.authModeVerdict} (${audit.authModeStrength}); offline ${audit.offlineCliAuth.verdict}; ${c(["F199", "F230"]).evidence}`),

    gate("G99", "API_KEY_BILLING_OVERRIDE_GUARDED: an injected ANTHROPIC_API_KEY refuses the production launch by name, its value leaks nowhere, wrong identities/modes are refused at preflight, P15 and the R16 init-event gate, and the guard-break's auth breakage was detected",
      c(["F200", "F201", "F202"]).ok && guardBreak.breakages.some((entry) => entry.id.startsWith("B1") && entry.observedFailures.includes("F200") && entry.missed.length === 0),
      `${c(["F200", "F201", "F202"]).evidence}; B1 observed ${JSON.stringify(guardBreak.breakages.find((entry) => entry.id.startsWith("B1"))?.observedFailures)}`),

    gate("G100", "PAID_USAGE_FALLBACK_NOT_AUTOMATICALLY_ENABLED: no launcher flag enables usage credits, an account with extra usage enabled is refused and cannot be attested past, and the production adapter aborts an attempt the moment paid overage is observed; the host's own overflow state is recorded truthfully",
      c(["F203"]).ok && ["USAGE_CREDIT_OVERFLOW_DISABLED_AT_ACCOUNT", "USAGE_CREDIT_OVERFLOW_ENABLED_AT_ACCOUNT", "USAGE_CREDIT_OVERFLOW_STATE_UNKNOWN"].includes(audit.overflowVerdict),
      `${c(["F203"]).evidence}; host overflow state ${audit.overflowVerdict} (launch permitted ${audit.launchPermitted})`),

    gate("G101", "PAIR_BOUNDED_SESSION_EXECUTION_VERIFIED: max 2 pairs runs exactly rows 0-3, resume starts at pair 3, a different cap preserves the frozen order and identity, the cap is validated, and there is no task selector",
      c(["F204", "F205", "F206", "F211", "F212", "F232"]).ok, c(["F204", "F205", "F206", "F211", "F212", "F232"]).evidence),

    gate("G102", "GRACEFUL_QUOTA_PAUSE_VERIFIED: a pending request starts no pair, a request during a pair finishes the pair, a hard limit on record starts nothing, a weekly limit pauses across the weekly reset without a scientific reset, and a cap pause consumes no retry",
      c(["F207", "F208", "F214", "F218", "F228"]).ok, c(["F207", "F208", "F214", "F218", "F228"]).evidence),

    gate("G103", "OUTCOME_BLIND_RESUME_VERIFIED: the status path names no outcome, a completed pair is refused exactly-once on resume, and a pause over residue cannot become continuation-safe",
      c(["F209", "F210", "F213"]).ok, c(["F209", "F210", "F213"]).evidence),

    gate("G104", "PAIR_SPLIT_RECOVERY_VERIFIED: a pair split by an after-arm pause resumes with the second arm only, in both arm orders, with no scratch/context crossing the session and the split recorded and measured",
      c(["F225", "F226", "F227"]).ok, c(["F225", "F226", "F227"]).evidence),

    gate("G105", "QUOTA_INTERRUPTION_ALREADY_COVERED_BY_FROZEN_RETRY_AUTHORITY: A2 classifies a subscription quota exhaustion into M214's frozen MODEL_SERVICE_FAILURE (rerunnable) and creates no class; a hard limit mid-attempt is never a valid unresolved task, the retry is deferred to the next session and bounded by the frozen attempt limit",
      a2Record.quotaInterruption.classificationVerdict === "QUOTA_INTERRUPTION_ALREADY_COVERED_BY_FROZEN_RETRY_AUTHORITY" && a2Record.quotaInterruption.frozenClass === "MODEL_SERVICE_FAILURE" && a2Record.quotaInterruption.newRetryClassesCreated === 0 && c(["F215", "F216", "F217"]).ok,
      `${a2Record.quotaInterruption.classificationVerdict} (${a2Record.quotaInterruption.frozenClass}, new classes ${a2Record.quotaInterruption.newRetryClassesCreated}); ${c(["F215", "F216", "F217"]).evidence}`),

    gate("G106", "LONG_DURATION_IDENTITY_GUARDS_VERIFIED: an agent binary of another version, a provider model other than the frozen target, a changed HEAD:src or dirty src worktree, a changed manifest, a changed image identity and a mutated A2 each refuse resume or halt the session; the real host passes every one today",
      c(["F219", "F220", "F221", "F222", "F223", "F224"]).ok && preflightGate("AGENT_IDENTITY") && preflightGate("TREATMENT_TREE") && artifacts.srcUnchanged,
      `${c(["F219", "F220", "F221", "F222", "F223", "F224"]).evidence}; preflight AGENT_IDENTITY ${preflightGate("AGENT_IDENTITY")} TREATMENT_TREE ${preflightGate("TREATMENT_TREE")}; HEAD:src ${artifacts.headSrc.slice(0, 12)} unchanged ${artifacts.srcUnchanged}`),

    gate("G107", "TMP_CLEANUP_ON_QUOTA_PAUSE_VERIFIED: after a pause no claim is CLAIMED and the namespace holds only its marker (both arm orders), residue before a pause blocks, and the M218 pure scratch suite is preserved",
      c(["F209", "F225", "F226"]).ok && m218.suitePasses && m218.satisfied === m218.controlCount,
      `${c(["F209", "F225", "F226"]).evidence}; M218 pure ${m218.satisfied}/${m218.controlCount}`),

    gate("G108", "SESSION_JOURNAL_VERIFIED: sessions are numbered sequentially from hash-chained events, the journal and status carry no outcome label, pair temporal gaps are measured as evaluation metadata, and the launcher's preflight reports the session model",
      c(["F213", "F227", "F229"]).ok && preflight.sessionModel?.amendmentId === "M214_A2_SUBSCRIPTION_QUOTA_SCHEDULING",
      `${c(["F213", "F227", "F229"]).evidence}; preflight session model ${preflight.sessionModel?.amendmentId ?? "absent"}`),

    gate("G109", "M220_FALSIFICATION_SUITE_PASSED, M220_SUITE_IS_FALSIFYING and M220_SCOPED_TYPECHECK_VERIFIED: every control satisfied with both expectations present, three guards broken alone each fell where predicted (corrections by mechanism recorded) with sources restored intact, and the scope typechecks",
      suite.suitePasses && suite.guardFiresControls > 0 && suite.guardSilentControls > 0 && guardBreak.verdict === "M220_SUITE_IS_FALSIFYING" && guardBreak.sourceFilesRestoredIntact && typecheck.verdict === "M220_SCOPED_TYPECHECK_VERIFIED" && typecheck.m220NewTypecheckErrors === 0,
      `suite ${suite.satisfied}/${suite.controlCount} (fires ${suite.guardFiresControls}, silent ${suite.guardSilentControls}; failures [${suite.failures.join(", ")}]); guard-break ${guardBreak.verdict}; typecheck ${typecheck.verdict} (${typecheck.m220NewTypecheckErrors} errors)`),

    gate("G110", "predecessor suites preserved after the M220 changes to the executor, adapter, continuation ledger and launcher: M215, M217 and M218 pure suites and the M219 suite (which runs the real launcher preflight) re-run green; the M216–M218 REAL container suites were not re-run in M220 (no container is started by this milestone) and remain preserved by their M219 evidence",
      m215.suitePasses && m215.satisfied === m215.controlCount && m217.suitePasses && m217.satisfied === m217.controlCount && m218.suitePasses && m219Suite.suitePasses && m219Suite.satisfied === m219Suite.controlCount,
      `M215 ${m215.satisfied}/${m215.controlCount}; M217 pure ${m217.satisfied}/${m217.controlCount}; M218 pure ${m218.satisfied}/${m218.controlCount}; M219 ${m219Suite.satisfied}/${m219Suite.controlCount}; container suites: not re-run (M220 starts no container)`),

    gate("G111", "FINAL_ZERO_SPEND_LAUNCH_PREFLIGHT_PASSED under A2: the production launcher's --preflight passes every technical gate including SESSION_AUTHORITY, AGENT_IDENTITY, TREATMENT_TREE, QUOTA_WINDOW and SUBSCRIPTION_AUTH, stops at SPEND_AUTHORIZATION_PENDING, reports operator prerequisites separately and runs nothing",
      preflight.verdict === "FINAL_ZERO_SPEND_LAUNCH_PREFLIGHT_PASSED" && preflight.finalBlocker === "SPEND_AUTHORIZATION_PENDING" && preflight.technicalBlockers.length === 0 && preflight.launchPerformed === false && preflight.rowsExecuted === 0 && preflight.providerCalls === 0 && preflight.spendAuthorization.activeCeilingUsd === 735,
      `${preflight.verdict}; gates ${preflight.gates.map((entry) => `${entry.id}=${entry.pass ? "PASS" : "FAIL"}`).join(" ")}; final blocker ${preflight.finalBlocker}; operator prerequisites ${JSON.stringify(preflight.operatorPrerequisitesPending)}`),

    gate("G112", "frozen artifacts and product unchanged, and zero spend: every frozen artifact (M213 x3, M214 x4, A1 x2, M219 identity record) byte-identical to the M219 final HEAD blobs, HEAD:src unchanged, 0 provider calls, $0 live model spend, 0 frozen task live-agent runs, 0 containers started",
      artifacts.allFrozenIdentical && artifacts.srcUnchanged && artifacts.providerCalls === 0 && artifacts.liveModelSpendUsd === 0 && artifacts.frozenBenchmarkTaskLiveAgentRuns === 0 && artifacts.containersStartedByM220 === 0 && (suite.providerCalls ?? 1) === 0 && (suite.containersStarted ?? 1) === 0 && preflight.liveModelSpendUsd === 0,
      `frozen identical ${artifacts.allFrozenIdentical} (${artifacts.frozen.length} artifacts); src unchanged ${artifacts.srcUnchanged}; provider calls 0; spend $0; containers 0`),
  ];

  const allGates = [...m219.gates, ...m220Gates];
  const g36 = allGates.find((entry) => entry.id === "G36");
  const blockers = allGates.filter((entry) => entry.status === "FAIL").map((entry) => entry.id);
  const technicalBlockers = blockers.filter((id) => id !== "G36");
  const technicalGateIds = [...m219.technicalGateIds, ...m220Gates.map((entry) => entry.id)];
  const technicalExecutorReady = technicalGateIds.every((id) => allGates.find((entry) => entry.id === id)?.status === "PASS");
  const operatorPrerequisitesPending = preflight.operatorPrerequisitesPending;
  const finalState = !technicalExecutorReady || technicalBlockers.length > 0
    ? "PAID_TWO_ARM_CAUSAL_BENCHMARK_NOT_READY"
    : operatorPrerequisitesPending.length > 0
      ? "TECHNICAL_EXECUTOR_READY_OPERATOR_PREREQUISITES_PENDING"
      : "PAID_TWO_ARM_CAUSAL_BENCHMARK_READY_FOR_HUMAN_AUTHORIZATION";

  const document = {
    schemaVersion: "stage5.m220.launch-gates.v1",
    milestone: "M220",
    generatedAt: new Date().toISOString(),
    quotaSessionVersion: M220_QUOTA_SESSION_VERSION,
    authVersion: M220_AUTH_VERSION,
    authorities: { ...m219.authorities, a2AmendmentHash: M220_FROZEN_A2_HASH, executableAuthorityM214A1A2: artifacts.a2.executableAuthority },
    m219TechnicalExecutorReady: m219.technicalExecutorReady,
    runtimeGuards: {
      ...m219.runtimeGuards,
      P14_QUOTA_SESSION_AUTHORITY: "M220: the executable authority is M214 + A1 + A2, A2 pinned and its parent A1 equal to the bound A1, before every row",
      P15_SUBSCRIPTION_AUTH_MODE: "M220: subscription login proven locally, no provider override present, no paid overflow enabled, before every row",
      R16_AUTH_SOURCE: "M220: the agent's init event must report apiKeySource 'none'; any other value aborts the attempt as ARM_CONFIGURATION_WRONG and halts the session",
      SESSION_BOUNDARY: "M220: before every row the session boundary decision may PAUSE (pair cap, explicit request, quota warning, deadline, hard limit); a pause is not a halt and consumes no retry",
    },
    requiredPrelaunchGateIds: [...m219.requiredPrelaunchGateIds, "P14_QUOTA_SESSION_AUTHORITY", "P15_SUBSCRIPTION_AUTH_MODE"],
    requiredRuntimeGateIds: [...m219.requiredRuntimeGateIds, "R16_AUTH_SOURCE"],
    technicalGateIds,
    gates: allGates,
    blockers,
    technicalBlockers,
    operatorPrerequisitesPending,
    pendingNonTechnical: g36 !== undefined && g36.status !== "PASS" ? ["G36", ...operatorPrerequisitesPending.map(() => "OPERATOR_PREREQUISITE")] : operatorPrerequisitesPending.map(() => "OPERATOR_PREREQUISITE"),
    financialEnvelope: m219.financialEnvelope,
    scratchPolicy: m219.scratchPolicy,
    subscriptionAudit: audit.verdicts,
    quotaAvailability: audit.quotaAvailability,
    technicalExecutorReady,
    g36: g36 === undefined ? null : { status: g36.status, requirement: g36.requirement, updatedAuthorizationText: M220_REQUIRED_AUTHORIZATION_TEXT },
    spendAuthorized: false,
    readinessVerdict: technicalExecutorReady ? "TECHNICAL_EXECUTOR_READY" : "TECHNICAL_EXECUTOR_NOT_READY",
    finalState,
    spendAuthorizationStatus: "SPEND_AUTHORIZATION_PENDING",
    proposedAuthorizationUsd: m219.financialEnvelope.hardCeilingUsd,
    accounting: {
      subscriptionQuotaConsumption: "included usage; not $0 in an economic sense (the MAX subscription has a fixed cost outside the experiment)",
      incrementalBilledProviderSpendUsd: 0,
      hardCeilingUsd: m219.financialEnvelope.hardCeilingUsd,
      hardCeilingMeaning: "maximum ADDITIONAL billed provider spend if such spend ever becomes possible; defence in depth",
    },
    paidRunsStarted: 0,
    liveModelSpendUsd: 0,
    providerCalls: 0,
    frozenBenchmarkTaskLiveAgentRuns: 0,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `${document.readinessVerdict}; ${finalState}; ${document.spendAuthorizationStatus}; technical blockers [${technicalBlockers.join(", ") || "none"}]; operator prerequisites ${JSON.stringify(operatorPrerequisitesPending)}; G36 ${g36?.status} (human)\n`
    + `M220 gates: ${m220Gates.map((entry) => `${entry.id}=${entry.status}`).join(" ")}\nwrote ${OUTPUT}\n`,
  );
  for (const entry of m220Gates.filter((candidate) => candidate.status === "FAIL")) process.stdout.write(`  ${entry.id}: ${entry.evidence}\n`);
}

await main();
