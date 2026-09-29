/**
 * M220 §44–§51 — the quota-session, subscription-auth, pause/resume,
 * split-pair, quota-interruption and long-duration drift falsification suite.
 *
 * Brief ids F1–F30 are realised as controls F199–F228 (M219 ended at F198),
 * with the brief id on each control; F229+ are controls the implementation
 * needed and the brief did not enumerate. Pure controls drive the REAL
 * `runCohort`, `executeManifestRow`, `CohortOperations`, gates and
 * classifiers against synthetic adapters and a synthetic isolation probe.
 * REAL_PROCESS controls exercise the real launcher as a subprocess, the real
 * pinned CLI's `auth status` with networking unshared, the real production
 * agent adapter over a FAKE bridge (a recorded stream, no process), and the
 * real filesystem for scratch isolation.
 *
 * No model, no provider, no frozen task, no container.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import { M214_MODEL } from "./m214Preregistration";
import {
  type AgentRunSpec,
  type ExecutorDependencies,
  type FrozenAuthorities,
  type RowSelector,
  LaunchRefusedError,
  M215_MANIFEST_FILE,
  executeManifestRow,
  runCohort,
  selectNextRow,
  verifyFrozenAuthorities,
} from "./m215LaunchExecutor";
import { CohortLedger } from "./m215CohortLedger";
import { syntheticAdapters, syntheticClock, syntheticWorld } from "./m215Fixtures";
import {
  ArmEnvironmentRegistry,
  M216AgentAdapter,
  buildAgentArgv,
  resolveAgentBinary,
} from "./m216ProductionAdapters";
import type { SubstrateBridge } from "./m216SubstrateBridge";
import { type M217Control, control, suitePasses } from "./m217Falsification";
import { emptyResidue, staleHarnessContainer, syntheticOperations, syntheticOperationsClock } from "./m217Fixtures";
import { cohortOperationalStatus, outcomeShapedKeys } from "./m217RetryReserve";
import { HostLivenessProbe, ScratchAuthority, ScratchRegistry, establishNamespace } from "./m218ScratchLifecycle";
import { loadActiveSpendAuthority, retryReserveAccounting } from "./m218SpendAuthority";
import { type ImageIdentityRecord, M219_IMAGE_IDENTITY_FILE, imagePreflight } from "./m219OperatorPreflight";
import {
  M220_FROZEN_A2_HASH,
  auditSessionAuthorityBinding,
  buildA2AmendmentDocument,
  loadActiveSessionAuthority,
  verifyA2Amendment,
} from "./m220Amendment";
import {
  type PauseRequest,
  type SessionBounds,
  classifyQuota,
  deriveSessionJournal,
  frozenPairs,
  lastHardQuotaLimit,
  nextSessionNumber,
  pairStatus,
  pairTemporalGaps,
  parseRateLimitEvents,
  quotaWindowGate,
  sessionIdFor,
  sessionStatusView,
  statusViewLeaksOutcome,
  validateMaxPairs,
} from "./m220QuotaSession";
import {
  type AccountProfileFacts,
  type CliAuthStatus,
  type CredentialFileFacts,
  CLI_AUTH_STATUS_ARGS,
  assessSubscriptionAuth,
  auditAuthSource,
  autoUpdatePosture,
  collectSubscriptionAuth,
  inspectAuthEnvironment,
  parseCliAuthStatus,
  readAccountProfileFacts,
  readCredentialFacts,
} from "./m220SubscriptionAuth";
import { parseLaunchArgs } from "./run_stage5_m215_launch";

export const M220_SUITE_VERSION = "stage5.m220.falsification.v1" as const;
export { control, suitePasses };

const FAKE_SECRET = "FAKE-CREDENTIAL-VALUE-M220-0123456789";
const RESEARCH_EXPERIMENT = "M220_RESEARCH_NON_EVALUATION";

// ── harness ─────────────────────────────────────────────────────────

function freshLedger(authorities: FrozenAuthorities): CohortLedger {
  return new CohortLedger("SYNTHETIC", authorities.preregistrationHash.actual, authorities.manifestHash.actual);
}

function depsFor(
  authorities: FrozenAuthorities, ledger: CohortLedger, ops = syntheticOperations(syntheticOperationsClock()),
  world = syntheticWorld(), overrides: Partial<ExecutorDependencies> = {},
): ExecutorDependencies & { readonly synthetic: ReturnType<typeof syntheticAdapters> } {
  const adapters = syntheticAdapters(world);
  return {
    mode: "SYNTHETIC", authorities, container: adapters.container, agent: adapters.agent, evaluator: adapters.evaluator,
    ledger, now: syntheticClock(), spendAuthorization: null, operations: ops.operations, ...overrides, synthetic: adapters,
  };
}

function bounds(maxPairs: number, extra: Partial<SessionBounds> = {}, sessionNumber = 1): SessionBounds {
  return {
    sessionId: sessionIdFor(sessionNumber), maxPairs, deadlineAt: null,
    pauseRequest: () => null, acknowledgePauseRequest: () => undefined, ...extra,
  };
}

/** Wrap a synthetic agent so a chosen row's outcome carries a quota observation or a credential source. */
function withOutcome(
  adapters: ReturnType<typeof syntheticAdapters>,
  decorate: (spec: AgentRunSpec, outcome: Awaited<ReturnType<typeof adapters.agent.run>>) => Awaited<ReturnType<typeof adapters.agent.run>>,
): void {
  const original = adapters.agent.run.bind(adapters.agent);
  adapters.agent.run = async (spec, hooks) => decorate(spec, await original(spec, hooks));
}

const rateLimitLine = (info: Record<string, unknown>): string =>
  JSON.stringify({ type: "rate_limit_event", rate_limit_info: info, uuid: "m220", session_id: "m220" });
const quotaFrom = (info: Record<string, unknown>) => classifyQuota(parseRateLimitEvents([rateLimitLine(info)]));

async function attempt(deps: ExecutorDependencies, selector: RowSelector): Promise<{ ok: boolean; error: Error | null }> {
  try {
    await executeManifestRow(deps, selector);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error as Error };
  }
}

function refusedBy(gateId: string, error: Error | null): boolean {
  return error instanceof LaunchRefusedError && error.gates.some((gate) => gate.gateId === gateId && gate.status === "FAIL");
}

const cliOk: CliAuthStatus = { command: "claude auth status --json", available: true, loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", fieldNames: [], error: null };
const credsOk: CredentialFileFacts = { path: "/x/.credentials.json", exists: true, hasClaudeAiOauth: true, subscriptionType: "max", rateLimitTier: null, accessTokenExpiresAtIso: null, refreshTokenExpiresAtIso: "2030-01-01T00:00:00.000Z", secretsRead: false };
const accountOff: AccountProfileFacts = { path: "/x/.claude.json", exists: true, hasExtraUsageEnabled: false, organizationType: "claude_max", billingType: "stripe_subscription", profileFetchedAtIso: "2026-09-05T00:00:00.000Z", autoUpdates: false, installMethod: "native" };
const cleanEnv = { PATH: "/usr/bin:/bin", HOME: "/home/x" };
function assess(overrides: Partial<Parameters<typeof assessSubscriptionAuth>[0]> = {}) {
  return assessSubscriptionAuth({
    environment: inspectAuthEnvironment(cleanEnv), settings: [], cliAuth: cliOk, credentials: credsOk, account: accountOff,
    autoUpdate: autoUpdatePosture(accountOff, cleanEnv), at: "2026-09-05T12:00:00.000Z", ...overrides,
  });
}

/**
 * A bridge that speaks the real `agent.run` contract without a process: it
 * streams recorded lines through `onEvent`, checks whether the adapter wrote
 * the abort sentinel, and answers like the Python bridge would.
 */
function fakeBridge(lines: readonly string[], onCall?: (params: Record<string, unknown>) => void): SubstrateBridge {
  return {
    call: async (op: string, params: Record<string, unknown>, onEvent?: (event: Record<string, unknown>) => void) => {
      if (op !== "agent.run") throw new Error(`fake bridge: unexpected op ${op}`);
      onCall?.(params);
      let aborted = false;
      lines.forEach((line, ordinal) => {
        if (aborted) return;
        onEvent?.({ stream: "agent.event", ordinal, line });
        if (typeof params.abortPath === "string" && existsSync(params.abortPath)) aborted = true;
      });
      return { started: true, exitCode: aborted ? 137 : 0, timedOut: false, durationMs: 42, sandboxed: false, stderrTail: "", aborted, spawnedArgv: [], agentTmp: null };
    },
  } as unknown as SubstrateBridge;
}

function realAdapterRun(
  row: RunManifestRow, armRoot: string, lines: readonly string[], hooks: Parameters<M216AgentAdapter["run"]>[1],
): Promise<Awaited<ReturnType<M216AgentAdapter["run"]>>> {
  const registry = new ArmEnvironmentRegistry();
  const adapter = new M216AgentAdapter({
    bridge: fakeBridge(lines), mode: "RESEARCH", providerBoundary: "REPLAY", workRoot: armRoot,
    problemStatement: () => "synthetic problem statement", armRootFor: () => armRoot, hostMountFor: () => join(armRoot, "testbed"),
    armEnvironments: registry, spendAuthorized: false,
  });
  const spec: AgentRunSpec = {
    row, attemptId: `${row.runId}#m220`, workingDirectory: "/testbed", modelTarget: M214_MODEL.model,
    agentBinary: "/home/calvin/.local/bin/claude", agentVersion: "2.1.260", nativeTools: ["Read"], mcpServers: [],
    maxTurns: 1, perRunCostCapUsd: 3.5, wallClockTimeoutSeconds: 60, userPromptTemplate: "x",
  };
  return adapter.run(spec, hooks);
}

const INIT_LINE = JSON.stringify({ type: "system", subtype: "init", cwd: "/testbed", tools: ["Read"], mcp_servers: [], model: M214_MODEL.model, apiKeySource: "none", claude_code_version: "2.1.260" });
const RESULT_LINE = JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.01, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });

export interface M220SuiteInput {
  readonly benchmarkDir: string;
  readonly resultsDir: string;
  readonly cohortDir: string;
  readonly scratchDir: string;
}

export async function runM220FalsificationSuite(input: M220SuiteInput): Promise<readonly M217Control[]> {
  const controls: M217Control[] = [];
  const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(input.resultsDir, file), "utf8")) as Record<string, unknown>;
  const authorities = verifyFrozenAuthorities(
    read("stage5_m214_preregistration.json"),
    read(M215_MANIFEST_FILE) as unknown as { rows: RunManifestRow[]; manifestHash: string },
    read("stage5_m214_external_reference.json"),
  );
  if (!authorities.verified) throw new Error(`frozen authorities do not verify: ${authorities.issues.join("; ")}`);
  const manifest = authorities.manifest;
  const pairs = frozenPairs(manifest);
  const launcher = join(input.benchmarkDir, "run_stage5_m215_launch.ts");
  const launch = (args: readonly string[], env: Record<string, string | undefined> = {}) =>
    spawnSync("bun", [launcher, ...args], { encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } });
  mkdirSync(input.scratchDir, { recursive: true });
  const scratchCohort = join(input.scratchDir, "cohort");
  mkdirSync(scratchCohort, { recursive: true });

  // ── F1 (F199): subscription environment on the real host ──
  {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ANTHROPIC_") && !name.startsWith("CLAUDE_CODE_")));
    const report = collectSubscriptionAuth({ env, now: () => new Date().toISOString() });
    const issues: string[] = [];
    if (report.environment.verdict !== "NO_PROVIDER_OVERRIDE_PRESENT") issues.push(`overrides present: ${report.environment.present.map((e) => e.name).join(", ")}`);
    if (report.authModeVerdict !== "SUBSCRIPTION_AUTH_MODE_PROVEN") issues.push(`auth mode ${report.authModeVerdict}: ${report.issues.join("; ")}`);
    if (report.cliAuth.authMethod !== "claude.ai" || report.cliAuth.apiProvider !== "firstParty" || report.cliAuth.subscriptionType !== "max") issues.push(`cli auth ${JSON.stringify({ m: report.cliAuth.authMethod, p: report.cliAuth.apiProvider, s: report.cliAuth.subscriptionType })}`);
    if (report.authModeStrength !== "LOCAL_CLI_AUTH_STATE" || report.providerConfirmation !== "PENDING_AT_FIRST_LIVE_RUN") issues.push("the claim is not bounded to local CLI state");
    controls.push(control("F199", "F1", `on the real host with no provider override the subscription-auth preflight proves the claude.ai / firstParty / max login at LOCAL_CLI_AUTH_STATE strength (overflow state recorded separately: ${report.overflowVerdict})`, "GUARD_SILENT", issues, "REAL_PROCESS"));
  }

  // ── F2 (F200) + F3 (F201): ANTHROPIC_API_KEY injected → refused; value never leaks ──
  {
    const fired: string[] = [];
    const leaks: string[] = [];
    const pure = assess({ environment: inspectAuthEnvironment({ ...cleanEnv, ANTHROPIC_API_KEY: FAKE_SECRET }) });
    if (!pure.launchPermitted && pure.authModeVerdict === "SUBSCRIPTION_AUTH_MODE_NOT_PROVEN") fired.push("pure assessment refuses with SUBSCRIPTION_AUTH_MODE_NOT_PROVEN");
    if (pure.environment.apiKeyPresent) fired.push("ANTHROPIC_API_KEY_PRESENT=true recorded");
    const result = launch(["--authorize-spend", "m220-control", "--max-pairs-this-session", "1", "--cohort-dir", scratchCohort], { ANTHROPIC_API_KEY: FAKE_SECRET });
    if (result.status !== 0 && /ANTHROPIC_API_KEY is present/.test(result.stderr) && /refusing to launch/.test(result.stderr)) fired.push("the real launcher refuses the cohort launch naming ANTHROPIC_API_KEY");
    if (!/CONTAINER_START|agent\.run|bridge/.test(result.stdout)) fired.push("no substrate was started");
    const text = `${result.stdout}\n${result.stderr}\n${JSON.stringify(pure)}`;
    if (text.includes(FAKE_SECRET)) leaks.push("the injected value appears in launcher output or the report");
    for (const file of ["cohort_operations.json", "cohort_session_journal.json", "cohort_session_status.json"]) {
      const path = join(scratchCohort, file);
      if (existsSync(path) && readFileSync(path, "utf8").includes(FAKE_SECRET)) leaks.push(`${file} contains the injected value`);
    }
    controls.push(control("F200", "F2", "with ANTHROPIC_API_KEY injected into the launcher's environment the production cohort launch is refused by name before any substrate starts, and the pure assessment says SUBSCRIPTION_AUTH_MODE_NOT_PROVEN", "GUARD_FIRES", fired.length >= 4 ? fired : [], "REAL_PROCESS"));
    controls.push(control("F201", "F3", "the injected key's VALUE appears nowhere: not in the refusal, not in the assessment, not in any persisted session document; only ANTHROPIC_API_KEY_PRESENT=true is recorded", "GUARD_SILENT", leaks, "REAL_PROCESS"));
  }

  // ── F4 (F202): wrong auth identity / mode → refusal, at preflight and at runtime ──
  {
    const fired: string[] = [];
    for (const [label, cli] of [["console login", { ...cliOk, authMethod: "console" }], ["bedrock provider", { ...cliOk, apiProvider: "bedrock" }], ["pro subscription", { ...cliOk, subscriptionType: "pro" }], ["not logged in", { ...cliOk, loggedIn: false }]] as const) {
      const report = assess({ cliAuth: cli });
      if (!report.launchPermitted && report.authModeVerdict === "SUBSCRIPTION_AUTH_MODE_NOT_PROVEN") fired.push(`${label} refused`);
    }
    if (assess({ cliAuth: { ...cliOk, available: false, error: "x" } }).authModeVerdict === "SUBSCRIPTION_AUTH_MODE_UNRESOLVED") fired.push("an unreadable auth status is UNRESOLVED, never proven");
    // Runtime: the init event names an API key source → R16 fails, the attempt is ARM_CONFIGURATION_WRONG, the session halts.
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    const deps = depsFor(authorities, ledger, ops);
    withOutcome(deps.synthetic, (spec, outcome) => (spec.row.executionOrder === 0 ? { ...outcome, apiKeySource: "ANTHROPIC_API_KEY" } : outcome));
    const report = await runCohort(deps, { session: bounds(5) });
    const first = ledger.entries[0];
    if (first?.validity.infrastructureCategory === "ARM_CONFIGURATION_WRONG" && first.status === "INFRASTRUCTURE_INVALID") fired.push("runtime apiKeySource ANTHROPIC_API_KEY → ARM_CONFIGURATION_WRONG, not a valid outcome");
    if (report.executed.length === 1 && report.session?.endState === "HALTED" && /COHORT_HALTED_AUTH_MODE/.test(report.stoppedBecause)) fired.push("the session halts after the refused attempt");
    if (cohortOperationalStatus(manifest, ledger, ops.ledger).status === "COHORT_HALTED_AUTH_MODE") fired.push("operational status COHORT_HALTED_AUTH_MODE");
    if (auditAuthSource(null).length === 1 && auditAuthSource("none").length === 0) fired.push("silence fails R16; 'none' passes");
    // P15 refuses a row when the bound audit says not permitted.
    const blocked = await attempt(depsFor(authorities, freshLedger(authorities), undefined, syntheticWorld(), { mode: "SYNTHETIC", subscriptionAuth: () => assess({ cliAuth: { ...cliOk, authMethod: "console" } }) }), { executionOrder: 0 });
    if (refusedBy("P15_SUBSCRIPTION_AUTH_MODE", blocked.error)) fired.push("P15 refuses a row while the audit says not permitted");
    controls.push(control("F202", "F4", "a wrong auth identity or mode is refused: console/bedrock/pro/logged-out at the preflight, an unreadable status is UNRESOLVED, P15 refuses the row, and at runtime an init event naming an API key source makes the attempt ARM_CONFIGURATION_WRONG and halts the session with COHORT_HALTED_AUTH_MODE", "GUARD_FIRES", fired.length >= 9 ? fired : []));
  }

  // ── F5 (F203): usage-credit continuation is never automatically enabled ──
  {
    const fired: string[] = [];
    // M220-A3 restates this control: the organisation-level profile flag no
    // longer blocks on its own once a newer user-level authority says OFF, but
    // usage credits reported ON by user-level evidence still cannot be attested past.
    const enabledOrgOnly = assess({ account: { ...accountOff, hasExtraUsageEnabled: true } });
    if (!enabledOrgOnly.launchPermitted && enabledOrgOnly.overflowVerdict === "USAGE_CREDIT_OVERFLOW_ENABLED_AT_ACCOUNT") fired.push("a cached true with no newer user-level authority refuses launch");
    const enabledUser = assess({
      account: { ...accountOff, hasExtraUsageEnabled: true, usageSnapshot: { present: true, extraUsageEnabled: true, userDisabled: false, fetchedAtIso: "2026-09-05T12:30:00.000Z", accountMatches: true } },
      overflowAttestation: "operator",
    });
    if (!enabledUser.launchPermitted && enabledUser.extraUsage.decidedBy === "CACHED_CLI_USAGE_SNAPSHOT") fired.push("usage credits ON in a user-level snapshot newer than the attestation cannot be attested past");
    for (const flag of ["--allow-extra-usage", "--use-usage-credits", "--continue-paid", "--enable-overage", "--api-fallback"]) {
      try {
        parseLaunchArgs([flag]);
      } catch (error) {
        if (/unknown argument/.test((error as Error).message)) fired.push(`${flag} refused by name`);
      }
    }
    // The real adapter aborts an attempt the moment paid overage is observed.
    const armRoot = mkdtempSync(join(input.scratchDir, "f203-"));
    try {
      const outcome = await realAdapterRun(manifest[0]!, armRoot, [INIT_LINE, rateLimitLine({ status: "allowed", rateLimitType: "five_hour", isUsingOverage: true, overageStatus: "allowed" }), RESULT_LINE], {
        assertProviderModelIdentity: () => undefined, assertAuthSource: () => undefined,
      });
      if (outcome.failureCategory === "MODEL_SERVICE_FAILURE" && outcome.terminationReason === "HARNESS_ABORT") fired.push("the production adapter aborted the attempt on isUsingOverage as MODEL_SERVICE_FAILURE");
      if (outcome.quota?.signal === "PAID_OVERAGE_IN_USE") fired.push("quota signal PAID_OVERAGE_IN_USE");
      if (existsSync(join(armRoot, "raw", `${manifest[0]!.runId}#m220.abort`))) fired.push("the abort sentinel was written");
    } finally {
      rmSync(armRoot, { recursive: true, force: true });
    }
    controls.push(control("F203", "F5", "no path enables usage credits: a cached true with no newer authority is refused, credits ON in newer user-level evidence cannot be attested past (A3), every overflow-shaped flag is refused by name, and the production adapter aborts an attempt as a provider availability interruption the moment a rate_limit_event reports paid overage in use", "GUARD_FIRES", fired.length >= 9 ? fired : [], "REAL_PROCESS"));
  }

  // ── F6 (F204), F7 (F205), F14 (F212), F30 (F228): caps, resume, different caps, no retry consumed ──
  {
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    const spend = loadActiveSpendAuthority(input.resultsDir);
    const f6: string[] = [];
    const first = await runCohort(depsFor(authorities, ledger, ops), { session: bounds(2) });
    if (first.executed.length !== 4) f6.push(`${first.executed.length} rows executed`);
    if (JSON.stringify(ledger.entries.map((e) => e.manifestRowOrdinal)) !== "[0,1,2,3]") f6.push(`rows ${ledger.entries.map((e) => e.manifestRowOrdinal).join(",")}`);
    if (first.session?.pauseReason !== "PAIR_CAP_REACHED" || first.session.endState !== "PAUSED") f6.push(`ended ${first.session?.endState} ${first.session?.pauseReason}`);
    if (first.session?.counters.pairsCompleted !== 2) f6.push("pairsCompleted != 2");
    controls.push(control("F204", "F6", "with --max-pairs-this-session 2 exactly the next two frozen pairs (rows 0-3) execute in synthetic mode and the session pauses with PAIR_CAP_REACHED", "GUARD_SILENT", f6));

    const f7: string[] = [];
    const next = selectNextRow(manifest, ledger);
    if (next?.executionOrder !== 4) f7.push(`next row ${next?.executionOrder}`);
    if (first.session?.endingNextRowOrdinal !== 4) f7.push("ending cursor is not row 4");
    controls.push(control("F205", "F7", "after the pause the next session begins at pair 3 (row 4): the cursor is the frozen order, not a session count", "GUARD_SILENT", f7));

    const f14: string[] = [];
    const second = await runCohort(depsFor(authorities, ledger, ops), { session: bounds(5, {}, 2) });
    if (second.executed.length !== 10) f14.push(`${second.executed.length} rows in session 2`);
    if (JSON.stringify(ledger.entries.map((e) => e.manifestRowOrdinal)) !== JSON.stringify([...Array(14).keys()])) f14.push("order not 0..13");
    if (new Set(ledger.entries.map((e) => e.attemptId)).size !== 14) f14.push("duplicate attempt ids");
    if (ledger.manifestHash !== authorities.manifestHash.actual) f14.push("manifest identity changed");
    if (ledger.verifyIntegrity().length > 0) f14.push("ledger integrity broken");
    controls.push(control("F212", "F14", "changing the cap from 2 to 5 between sessions preserves the manifest order (rows 0..13, no duplicates, no skips) and the experiment identity", "GUARD_SILENT", f14));

    const f30: string[] = [];
    const accounting = retryReserveAccounting(spend, ledger);
    if (accounting.retryAttemptsStarted !== 0 || accounting.retryAttemptsRemaining !== 10) f30.push(`retry slots ${accounting.retryAttemptsStarted}/${accounting.retryAttemptsRemaining}`);
    if (ledger.entries.some((e) => e.attempt !== 1)) f30.push("an attempt > 1 exists after pauses");
    const paused = ops.ledger.events.filter((e) => e.kind === "PAIR_SPLIT_BY_QUOTA_WINDOW" || e.kind === "QUOTA_LIMIT_OBSERVED");
    if (paused.length !== 0) f30.push("a cap pause was recorded as a split or a quota limit");
    controls.push(control("F228", "F30", "two cap pauses before any attempt launch consumed no infrastructure retry: 0 retry slots used, every attempt is attempt 1, no split or quota event recorded", "GUARD_SILENT", f30));
  }

  // ── F8 (F206): the operator cannot ask for task 20 ──
  {
    const fired: string[] = [];
    for (const argv of [["--task", "20"], ["--instance", "x"], ["--skip-to", "41"], ["--start-at", "20"], ["--pair", "20"], ["--execution-order", "40"]]) {
      try {
        parseLaunchArgs(argv);
      } catch (error) {
        fired.push(`${argv[0]}: ${(error as Error).message.slice(0, 60)}`);
      }
    }
    const ledger = freshLedger(authorities);
    const direct = await attempt(depsFor(authorities, ledger), { executionOrder: 40 });
    if (refusedBy("P6_EXECUTION_ORDER", direct.error) && ledger.entries.length === 0) fired.push("a direct selection of row 40 with rows 0-39 open is refused by P6 and runs nothing");
    controls.push(control("F206", "F8", "there is no task selector: --task/--instance/--skip-to/--start-at/--pair/--execution-order are refused by name, and a direct selection ahead of the frozen cursor is refused by P6", "GUARD_FIRES", fired.length >= 7 ? fired : []));
  }

  // ── F9 (F207), F10 (F208): pause before the next pair; pause after the active pair ──
  {
    const ledger = freshLedger(authorities);
    const request: PauseRequest = { kind: "AFTER_CURRENT_PAIR", requestedAt: "2026-09-05T00:00:00.000Z", requestedBy: "m220" };
    let acked = 0;
    const idle = await runCohort(depsFor(authorities, ledger), { session: bounds(5, { pauseRequest: () => request, acknowledgePauseRequest: () => { acked += 1; } }) });
    const f9: string[] = [];
    if (idle.executed.length !== 0) f9.push(`${idle.executed.length} rows started`);
    if (idle.session?.pauseReason !== "EXPLICIT_PAUSE_REQUEST_AFTER_PAIR") f9.push(`reason ${idle.session?.pauseReason}`);
    if (acked !== 1) f9.push(`request acknowledged ${acked} times`);
    controls.push(control("F207", "F9", "a pause request pending while idle starts no new pair, pauses with EXPLICIT_PAUSE_REQUEST_AFTER_PAIR and consumes the request exactly once", "GUARD_SILENT", f9));

    let pending: PauseRequest | null = null;
    const deps = depsFor(authorities, ledger);
    withOutcome(deps.synthetic, (spec, outcome) => {
      if (spec.row.executionOrder === 0) pending = request;
      return outcome;
    });
    const active = await runCohort(deps, { session: bounds(5, { pauseRequest: () => pending }) });
    const f10: string[] = [];
    if (active.executed.length !== 2) f10.push(`${active.executed.length} rows executed`);
    if (pairStatus(pairs[0]!, ledger).state !== "COMPLETE") f10.push("the active pair did not finish");
    if (active.session?.pauseReason !== "EXPLICIT_PAUSE_REQUEST_AFTER_PAIR" || active.session.counters.pairSplitOccurred) f10.push("wrong pause or a split");
    controls.push(control("F208", "F10", "a pause requested while a pair is active lets the pair finish (both arms), then pauses without splitting", "GUARD_SILENT", f10));
  }

  // ── F11 (F209): cleanup failure during pause → not continuation-safe, blocked ──
  {
    const ledger = freshLedger(authorities);
    const residue = emptyResidue();
    const ops = syntheticOperations(syntheticOperationsClock(), residue);
    const fired: string[] = [];
    const report = await runCohort(depsFor(authorities, ledger, ops), { session: bounds(1) });
    if (report.session?.endState !== "PAUSED") fired.push(`unexpected end ${report.session?.endState}`);
    // Residue appears before the session may report itself paused.
    residue.harnessContainers.push(staleHarnessContainer(manifest[0]!.instanceId));
    const check = await ops.operations.recordSessionEndCheck("SESSION_001");
    if (check.continuationAfter === "CONTINUATION_BLOCKED" && (check.detail as { pauseSafe?: boolean }).pauseSafe === false) fired.push("the session-end check found residue and BLOCKED");
    if (ops.operations.state() === "CONTINUATION_BLOCKED") fired.push("continuation is BLOCKED");
    const status = cohortOperationalStatus(manifest, ledger, ops.ledger);
    if (status.status === "COHORT_HALTED_ISOLATION_RISK") fired.push("status is COHORT_HALTED_ISOLATION_RISK, not paused");
    const next = await attempt(depsFor(authorities, ledger, ops), { executionOrder: 2 });
    if (refusedBy("P10_CONTINUATION_SAFETY", next.error)) fired.push("the next row is refused by P10");
    const loop = await runCohort(depsFor(authorities, ledger, ops), { session: bounds(1, {}, 2) });
    if (loop.executed.length === 0 && loop.session?.endState === "HALTED") fired.push("a new session runs nothing while blocked");
    controls.push(control("F209", "F11", "residue found by the enumeration before a pause may be reported moves continuation to BLOCKED: the status is an isolation halt, not a pause, and no next row or session proceeds until the recovery path runs", "GUARD_FIRES", fired.length >= 5 ? fired : []));
  }

  // ── F12 (F210): a completed pair cannot be rerun ──
  {
    const ledger = freshLedger(authorities);
    await runCohort(depsFor(authorities, ledger), { session: bounds(1) });
    const fired: string[] = [];
    for (const order of [0, 1]) {
      const rerun = await attempt(depsFor(authorities, ledger), { executionOrder: order });
      if (refusedBy("P6_EXECUTION_ORDER", rerun.error) && /already has a valid outcome/.test(rerun.error?.message ?? "")) fired.push(`row ${order} rerun refused (exactly-once)`);
    }
    if (ledger.entries.length === 2) fired.push("the ledger still holds exactly two attempts");
    const again = await runCohort(depsFor(authorities, ledger), { session: bounds(1, {}, 2) });
    if (again.executed.length === 2 && ledger.entries[2]!.manifestRowOrdinal === 2) fired.push("a new session moves to pair 2, never back");
    controls.push(control("F210", "F12", "a completed pair is refused exactly-once by P6 on direct selection, and a new session never revisits it", "GUARD_FIRES", fired.length >= 4 ? fired : []));
  }

  // ── F13 (F211): session cap validation ──
  {
    const fired: string[] = [];
    for (const bad of ["0", "-1", "1.5", "abc", ""]) {
      try {
        parseLaunchArgs(["--max-pairs-this-session", bad]);
      } catch (error) {
        fired.push(`${JSON.stringify(bad)}: ${(error as Error).message.slice(0, 50)}`);
      }
    }
    for (const bad of [0, Number.NaN, 2.5, "3"]) {
      try {
        validateMaxPairs(bad);
      } catch {
        fired.push(`validateMaxPairs(${String(bad)}) refused`);
      }
    }
    try {
      parseLaunchArgs(["--max-session-wall-clock", "-5"]);
    } catch {
      fired.push("negative wall clock refused");
    }
    let accepted = false;
    try {
      accepted = parseLaunchArgs(["--max-pairs-this-session", "2"]).maxPairsThisSession === 2;
    } catch {
      accepted = false;
    }
    if (accepted) fired.push("2 accepted");
    controls.push(control("F211", "F13", "a session cap of zero, negative, fractional, non-numeric or empty is refused by input validation; a negative wall clock is refused; 2 is accepted", "GUARD_FIRES", fired.length >= 11 ? fired : []));
  }

  // ── F15 (F213): interim results do not leak through the status path ──
  {
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    await runCohort(depsFor(authorities, ledger, ops, syntheticWorld({ resolved: true })), { session: bounds(2) });
    const issues: string[] = [];
    const view = sessionStatusView({
      manifest, ledger, events: ops.ledger.events, operationalStatus: cohortOperationalStatus(manifest, ledger, ops.ledger).status,
      continuationState: ops.operations.state(), pauseRequest: null, subscriptionAuthState: "x", scratchFreeBytes: 1,
      now: "2026-09-05T00:00:00.000Z", nextRow: selectNextRow(manifest, ledger),
    });
    if (statusViewLeaksOutcome(view).length > 0) issues.push(`outcome-shaped keys: ${statusViewLeaksOutcome(view).join(", ")}`);
    if (outcomeShapedKeys(view as unknown as Record<string, unknown>).length > 0) issues.push("M217 pattern matches a key");
    const text = JSON.stringify(view);
    if (/VALID_RESOLVED|VALID_UNRESOLVED|"resolved"|passRate|pValue|discordant/.test(text)) issues.push("the status text names an outcome");
    if (view.pairsComplete !== 2 || view.rowsSettled !== 4) issues.push("the status does not report progress");
    const journal = deriveSessionJournal(ops.ledger.events, ledger);
    if (/resolved|win/i.test(JSON.stringify(journal))) issues.push("the journal names an outcome");
    const real = launch(["--session-status", "--cohort-dir", scratchCohort]);
    if (real.status !== 0) issues.push(`real --session-status exit ${real.status}: ${real.stderr.slice(-200)}`);
    else {
      const document = JSON.parse(real.stdout) as Record<string, unknown>;
      if (document.runsNothing !== true) issues.push("the real status path ran something");
      if (/VALID_RESOLVED|VALID_UNRESOLVED|passRate|pValue/.test(real.stdout)) issues.push("the real status path names an outcome");
      if (typeof document.nextRow !== "object") issues.push("no next row in the real status");
    }
    controls.push(control("F213", "F15", "the operational status (pure view on a populated ledger and the real --session-status) shows rows/pairs complete, the next frozen row, quota and auth state, and no per-arm count, pass rate, effect or p-value", "GUARD_SILENT", issues, "REAL_PROCESS"));
  }

  // ── F16 (F214): hard quota before an attempt → no attempt, normal pause ──
  {
    const fired: string[] = [];
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const gate = quotaWindowGate({ resetsAtIso: future, quotaClass: "SESSION_QUOTA", observedAt: new Date().toISOString() }, new Date().toISOString());
    if (gate.length === 1 && /QUOTA_WINDOW_NOT_YET_RESET/.test(gate[0]!)) fired.push("the window gate refuses before the reset time");
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    ops.operations.recordSessionEvent("QUOTA_LIMIT_OBSERVED", { signal: "HARD_LIMIT", quotaClass: "SESSION_QUOTA", resetsAtIso: future });
    const last = lastHardQuotaLimit(ops.ledger.events);
    if (last !== null && quotaWindowGate(last, new Date().toISOString()).length === 1) fired.push("the recorded hard limit is found from the operations ledger and gates the session");
    // The loop itself, with the hard limit on record, starts nothing.
    const report = await runCohort(depsFor(authorities, ledger, ops), { session: bounds(5) });
    if (report.executed.length === 0 && report.session?.pauseReason === "HARD_QUOTA_LIMIT_OBSERVED" && report.session.endState === "PAUSED") fired.push("the cohort loop pauses before its first row");
    if (ledger.entries.length === 0 && ops.operations.state() === "CONTINUATION_SAFE") fired.push("no attempt exists and continuation stays SAFE: a quota gate is a pause condition, not a halt");
    controls.push(control("F214", "F16", "a hard quota limit on record with an unexpired reset time refuses the next session before any attempt, at the launcher's gate and in the cohort loop itself; continuation stays SAFE (normal pause, no retry consumed)", "GUARD_FIRES", fired.length >= 4 ? fired : []));
  }

  // ── F17 (F215), F18 (F216), F19 (F217): hard quota mid-attempt; restart after reset; repeated interruption ──
  {
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    const spend = loadActiveSpendAuthority(input.resultsDir);
    let interruptions = 0;
    const make = (): ReturnType<typeof depsFor> => {
      const deps = depsFor(authorities, ledger, ops, syntheticWorld({ resolved: false }));
      withOutcome(deps.synthetic, (spec, outcome) => {
        if (spec.row.executionOrder === 1) {
          interruptions += 1;
          // The recorded reset lies in the past relative to the synthetic clock, so the
          // next session's window gate opens and the retry itself is what is under test.
          return { ...outcome, quota: quotaFrom({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1_700_000_000 }) };
        }
        return outcome;
      });
      return deps;
    };
    const f17: string[] = [];
    const first = await runCohort(make(), { session: bounds(5) });
    const interrupted = ledger.entries[1];
    if (interrupted?.status === "INFRASTRUCTURE_INVALID" && interrupted.validity.infrastructureCategory === "MODEL_SERVICE_FAILURE") f17.push("the interrupted attempt is MODEL_SERVICE_FAILURE (frozen, rerunnable)");
    if (interrupted?.status === "VALID_UNRESOLVED") f17.push("BUG: classified valid unresolved");
    if (/quota interruption/.test(interrupted?.validity.reason ?? "")) f17.push("the reason names the quota interruption");
    if (first.session?.pauseReason === "HARD_QUOTA_LIMIT_OBSERVED" && first.executed.length === 2) f17.push("the session paused immediately after the interrupted attempt");
    if (ops.ledger.events.some((e) => e.kind === "QUOTA_LIMIT_OBSERVED" && (e.detail as { signal: string }).signal === "HARD_LIMIT")) f17.push("QUOTA_LIMIT_OBSERVED recorded");
    // The REAL adapter over the fake bridge with a recorded rejected event.
    const armRoot = mkdtempSync(join(input.scratchDir, "f215-"));
    try {
      const outcome = await realAdapterRun(manifest[0]!, armRoot, [INIT_LINE, rateLimitLine({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1_788_600_000 }), JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.02, num_turns: 1, usage: {} })], {
        assertProviderModelIdentity: () => undefined, assertAuthSource: () => undefined,
      });
      if (outcome.failureCategory === "MODEL_SERVICE_FAILURE" && outcome.quota?.signal === "HARD_LIMIT" && outcome.quota.quotaClass === "SESSION_QUOTA") f17.push("the production adapter classifies a recorded rejected rate_limit_event as MODEL_SERVICE_FAILURE with SESSION_QUOTA");
      if (outcome.apiKeySource === "none") f17.push("apiKeySource read from the recorded init");
    } finally {
      rmSync(armRoot, { recursive: true, force: true });
    }
    controls.push(control("F215", "F17", "a hard quota limit mid-attempt maps to the frozen MODEL_SERVICE_FAILURE class through both the executor (synthetic) and the production adapter (recorded rate_limit_event), is never a valid unresolved task, records QUOTA_LIMIT_OBSERVED and pauses the session at once", "GUARD_FIRES", f17.length >= 6 && !f17.some((line) => line.startsWith("BUG")) ? f17 : [], "REAL_PROCESS"));

    const f18: string[] = [];
    if (selectNextRow(manifest, ledger)?.executionOrder !== 1) f18.push("the next authorized row is not the interrupted row");
    const second = await runCohort(make(), { session: bounds(5, {}, 2) });
    const attempts = ledger.attemptsFor(pairs[0]!.rows[1].instanceId, pairs[0]!.rows[1].arm);
    if (attempts.length !== 2 || attempts[1]!.attempt !== 2) f18.push(`attempts ${attempts.map((a) => a.attempt).join(",")}`);
    if (ledger.attemptsFor(pairs[0]!.rows[0].instanceId, pairs[0]!.rows[0].arm).length !== 1) f18.push("arm 1 was rerun");
    if (ledger.entries.some((e) => e.manifestRowOrdinal > 1)) f18.push("a later row ran before the retry");
    if (retryReserveAccounting(spend, ledger).retryAttemptsStarted !== 1) f18.push("the retry did not consume exactly one A1 slot");
    void second;
    controls.push(control("F216", "F18", "after the window resets only the interrupted row retries (attempt 2, one A1 slot), arm 1 is not rerun and no later row jumps ahead", "GUARD_SILENT", f18));

    const f19: string[] = [];
    const third = await runCohort(make(), { session: bounds(1, {}, 3) });
    const cell = ledger.attemptsFor(pairs[0]!.rows[1].instanceId, pairs[0]!.rows[1].arm);
    if (cell.length === 2 && interruptions === 2) f19.push("no third attempt: the frozen maxAttemptsPerRun 2 binds");
    if (third.executed.length > 0 && ledger.entries[ledger.entries.length - 1]!.manifestRowOrdinal >= 2) f19.push("the frozen order moves on; the cell is reported unrecoverable");
    if (pairStatus(pairs[0]!, ledger).state === "COMPLETE" && ledger.validOutcomeFor(pairs[0]!.rows[1].instanceId, pairs[0]!.rows[1].arm) === undefined) f19.push("the pair is settled with one unrecoverable arm (incomplete pair, per M214's pairing rule)");
    controls.push(control("F217", "F19", "repeated quota interruption of the same cell is bounded by the frozen attempt limit: no third attempt, no unlimited subscription retries, the cell is unrecoverable and the order moves on", "GUARD_FIRES", f19.length >= 3 ? f19 : []));
  }

  // ── F20 (F218): weekly quota exhausted → pause across the weekly reset, no scientific reset ──
  {
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    const deps = depsFor(authorities, ledger, ops);
    const resets = 4_100_000_000;
    withOutcome(deps.synthetic, (spec, outcome) => (spec.row.executionOrder === 3 ? { ...outcome, quota: quotaFrom({ status: "rejected", rateLimitType: "seven_day", resetsAt: resets }) } : outcome));
    const report = await runCohort(deps, { session: bounds(10) });
    const issues: string[] = [];
    if (report.session?.pauseReason !== "HARD_QUOTA_LIMIT_OBSERVED") issues.push(`reason ${report.session?.pauseReason}`);
    if (report.session?.counters.quotaClassObserved !== "WEEKLY_QUOTA") issues.push(`class ${report.session?.counters.quotaClassObserved}`);
    const last = lastHardQuotaLimit(ops.ledger.events);
    if (last?.quotaClass !== "WEEKLY_QUOTA" || quotaWindowGate(last, new Date().toISOString()).length !== 1) issues.push("the weekly limit does not gate the next session");
    if (quotaWindowGate(last, new Date((resets + 1) * 1000).toISOString()).length !== 0) issues.push("the gate does not clear after the weekly reset");
    if (ledger.entries.length !== 4 || ledger.manifestHash !== authorities.manifestHash.actual) issues.push("the cohort was reset or its identity changed");
    if (ops.operations.state() !== "CONTINUATION_SAFE") issues.push("a weekly pause is not a halt");
    controls.push(control("F218", "F20", "a seven_day rejection is classified WEEKLY_QUOTA, pauses the session, gates the next session until the weekly reset, and neither resets nor restarts the cohort", "GUARD_SILENT", issues));
  }

  // ── F21 (F219): the agent harness changes during a pause (restated under M214_A3) ──
  {
    const fired: string[] = [];
    const drifted = join(input.scratchDir, "drifted-claude");
    writeFileSync(drifted, "#!/bin/sh\necho '9.9.9 (Claude Code)'\n");
    chmodSync(drifted, 0o755);
    const resolution = resolveAgentBinary(drifted);
    if (resolution.issues.length === 0 && resolution.version === "9.9.9") fired.push("a launcher reporting another release resolves and records 9.9.9 as metadata; no version pin refuses it (A3)");
    if (resolveAgentBinary(join(input.scratchDir, "no-such-claude")).issues.length > 0) fired.push("a launcher that resolves to nothing is refused");
    const { sessionIdentityPreflight } = await import("./run_stage5_m215_launch");
    const real = sessionIdentityPreflight(manifest);
    if (real.agent.ok) fired.push("the real installed harness passes the A3 capability contract on the unchanged host");
    // The production adapter refuses a spawn whose executable changed after verification.
    const armRoot = mkdtempSync(join(input.scratchDir, "f219-"));
    try {
      const registry = new ArmEnvironmentRegistry();
      const adapter = new M216AgentAdapter({
        bridge: fakeBridge([INIT_LINE, RESULT_LINE]), mode: "RESEARCH", providerBoundary: "REPLAY", workRoot: armRoot,
        problemStatement: () => "x", armRootFor: () => armRoot, hostMountFor: () => join(armRoot, "testbed"), armEnvironments: registry,
      });
      try {
        await adapter.run({
          row: manifest[0]!, attemptId: "f219", workingDirectory: "/testbed", modelTarget: M214_MODEL.model, agentBinary: drifted, agentVersion: "9.9.9",
          harness: { resolvedBinary: drifted, sha256: "0".repeat(64), version: "9.9.9" },
          nativeTools: ["Read"], mcpServers: [], maxTurns: 1, perRunCostCapUsd: 3.5, wallClockTimeoutSeconds: 60, userPromptTemplate: "x",
        }, { assertProviderModelIdentity: () => undefined });
      } catch (error) {
        if (/refusing to launch/.test((error as Error).message) && /changed between verification and spawn/.test((error as Error).message)) fired.push("the production adapter refuses to spawn an executable whose digest differs from the verified one");
      }
    } finally {
      rmSync(armRoot, { recursive: true, force: true });
      rmSync(drifted, { force: true });
    }
    const argv = buildAgentArgv({ row: manifest[0]!, attemptId: "x", workingDirectory: "/testbed", modelTarget: M214_MODEL.model, agentBinary: "/home/calvin/.local/bin/claude", agentVersion: "x", harness: { resolvedBinary: "/resolved/claude-binary", sha256: null, version: "x" }, nativeTools: [], mcpServers: [], maxTurns: 1, perRunCostCapUsd: 1, wallClockTimeoutSeconds: 1, userPromptTemplate: "x" }, [], "p");
    if (argv[0] === "/resolved/claude-binary") fired.push("the spawned executable is the verified resolved file, never the symlink");
    controls.push(control("F219", "F21", "under M214_A3 a harness reporting another release is metadata, not a refusal; an unresolvable launcher is refused; the real harness passes the capability contract; the adapter refuses an executable changed after verification and spawns the resolved file", "GUARD_FIRES", fired.length >= 5 ? fired : [], "REAL_PROCESS"));
  }

  // ── F22 (F220): provider model identity changes → live initialization refuses and the session halts ──
  {
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    const fired: string[] = [];
    const report = await runCohort(depsFor(authorities, ledger, ops, syntheticWorld({ providerModelIdentity: "claude-opus-4-6-20260101" })), { session: bounds(5) });
    const entry = ledger.entries[0];
    if (entry?.validity.infrastructureCategory === "MODEL_IDENTITY_DRIFT") fired.push("the attempt is MODEL_IDENTITY_DRIFT (aborted at init)");
    if (report.executed.length === 1 && report.session?.endState === "HALTED" && /COHORT_HALTED_MODEL_IDENTITY/.test(report.stoppedBecause)) fired.push("the session halts instead of walking the frozen order under another model");
    if (cohortOperationalStatus(manifest, ledger, ops.ledger).status === "COHORT_HALTED_MODEL_IDENTITY") fired.push("status COHORT_HALTED_MODEL_IDENTITY");
    if (ledger.entries.every((e) => e.status !== "VALID_RESOLVED" && e.status !== "VALID_UNRESOLVED")) fired.push("no valid outcome exists under the drifted model");
    controls.push(control("F220", "F22", "a provider-served model other than the frozen target aborts at initialisation as MODEL_IDENTITY_DRIFT and halts the session with COHORT_HALTED_MODEL_IDENTITY; nothing is upgraded silently", "GUARD_FIRES", fired.length >= 4 ? fired : []));
  }

  // ── F23 (F221): VTRACE HEAD:src changes → resume refuses ──
  {
    const { sessionIdentityPreflight } = await import("./run_stage5_m215_launch");
    const { auditFrozenTreatmentTree } = await import("./m215LaunchExecutor");
    const fired: string[] = [];
    const drift = auditFrozenTreatmentTree(manifest, "0".repeat(40));
    if (drift.length === 1 && /treatment drift/.test(drift[0]!)) fired.push("a different product tree is treatment drift");
    const real = sessionIdentityPreflight(manifest);
    if (real.treatment.ok && real.treatment.srcWorktreeClean) fired.push(`the real HEAD:src ${real.treatment.headSrc.slice(0, 12)} matches the manifest and src/ is clean`);
    // A dirty src worktree would refuse too: exercised against a scratch repository.
    const repo = mkdtempSync(join(input.scratchDir, "f221-repo-"));
    try {
      const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      git("init", "-q");
      git("config", "user.email", "m220@example.invalid");
      git("config", "user.name", "m220");
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
      git("add", "."); git("commit", "-q", "-m", "init");
      const tree = git("rev-parse", "HEAD:src").stdout.trim();
      const rows = manifest.map((row) => (row.arm === "vtrace" ? { ...row, vtraceProductTreeSha: tree } : row));
      const clean = sessionIdentityPreflight(rows, repo);
      writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
      const dirty = sessionIdentityPreflight(rows, repo);
      if (clean.treatment.ok && !dirty.treatment.ok && dirty.issues.some((issue) => /uncommitted changes/.test(issue))) fired.push("an uncommitted src/ change refuses the session even though HEAD:src is unchanged");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
    controls.push(control("F221", "F23", "a VTRACE product tree that differs from the manifest, or a src/ worktree with uncommitted changes, refuses the session; the real host passes", "GUARD_FIRES", fired.length >= 3 ? fired : [], "REAL_PROCESS"));
  }

  // ── F24 (F222): manifest changes → resume refuses ──
  {
    const fired: string[] = [];
    const rows = manifest.map((row, index) => (index === 7 ? { ...row, arm: row.arm === "baseline" ? "vtrace" : "baseline" } : row)) as RunManifestRow[];
    const mutated = verifyFrozenAuthorities(read("stage5_m214_preregistration.json"), { rows, manifestHash: "" }, read("stage5_m214_external_reference.json"));
    if (!mutated.verified && mutated.issues.some((issue) => issue.includes("run_manifest"))) fired.push("a one-row arm swap fails the manifest digest");
    const reordered = [...manifest.slice(2), ...manifest.slice(0, 2)].map((row, index) => ({ ...row, executionOrder: index })) as RunManifestRow[];
    const reorder = verifyFrozenAuthorities(read("stage5_m214_preregistration.json"), { rows: reordered, manifestHash: "" }, read("stage5_m214_external_reference.json"));
    if (!reorder.verified) fired.push("a reordering fails the manifest digest");
    const tmp = mkdtempSync(join(input.scratchDir, "f222-results-"));
    try {
      for (const file of ["stage5_m214_preregistration.json", "stage5_m214_external_reference.json", "stage5_m214_a1_retry_reserve_amendment.json", "stage5_m214_a2_subscription_quota_scheduling_amendment.json"]) {
        writeFileSync(join(tmp, file), readFileSync(join(input.resultsDir, file)));
      }
      const document = JSON.parse(readFileSync(join(input.resultsDir, M215_MANIFEST_FILE), "utf8")) as { rows: RunManifestRow[] };
      document.rows[3] = { ...document.rows[3]!, executionOrder: 199 };
      document.rows[199] = { ...document.rows[199]!, executionOrder: 3 };
      writeFileSync(join(tmp, M215_MANIFEST_FILE), JSON.stringify(document));
      const result = launch(["--session-status", "--results", tmp, "--cohort-dir", join(tmp, "cohort")]);
      if (result.status !== 0 && /frozen authorities do not recompute/.test(result.stderr)) fired.push("the real launcher refuses a swapped manifest before anything else");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    controls.push(control("F222", "F24", "a manifest with one arm swapped, reordered, or with two execution orders exchanged does not recompute to the frozen digest and the launcher refuses it before any action", "GUARD_FIRES", fired.length >= 3 ? fired : [], "REAL_PROCESS"));
  }

  // ── F25 (F223): image identity changes → the M219 gate fires ──
  {
    const record = JSON.parse(readFileSync(join(input.resultsDir, M219_IMAGE_IDENTITY_FILE), "utf8")) as ImageIdentityRecord;
    const inspector = (reference: string) => {
      const entry = record.images.find((image) => image.containerImage === reference);
      return entry === undefined ? null : { imageId: entry.imageId, repoDigests: entry.repoDigest === null ? [] : [entry.repoDigest] };
    };
    const fired: string[] = [];
    const retagged = imagePreflight(manifest, record, (reference) => (reference === record.images[9]!.containerImage ? { imageId: "sha256:" + "f".repeat(64), repoDigests: [] } : inspector(reference)));
    if (retagged.verdict === "IMAGE_PREFLIGHT_FAIL" && retagged.rowsIdentityVerified === 198) fired.push("a re-tagged image fails exactly its two rows");
    const gone = imagePreflight(manifest, record, (reference) => (reference === record.images[10]!.containerImage ? null : inspector(reference)));
    if (gone.verdict === "IMAGE_PREFLIGHT_FAIL" && gone.issues.some((issue) => issue.includes("absent locally"))) fired.push("an image that disappeared during a pause fails without a pull");
    if (imagePreflight(manifest, record, inspector).verdict === "IMAGE_PREFLIGHT_PASS") fired.push("the unchanged record passes (the gate is not always-on)");
    controls.push(control("F223", "F25", "an image re-tagged or removed during a long pause is refused by the M219 identity preflight the session start runs; the unchanged record passes", "GUARD_FIRES", fired.length >= 3 ? fired : []));
  }

  // ── F26 (F224): A2 mutation → the hash guard fires ──
  {
    const fired: string[] = [];
    const document = buildA2AmendmentDocument("2026-09-05T00:00:00.000Z");
    const mutated = { ...document, pauseState: { ...(document.pauseState as Record<string, unknown>), consumesRetryAttempt: true } };
    const verification = verifyA2Amendment(mutated);
    if (!verification.verified && verification.recomputedHash !== M220_FROZEN_A2_HASH) fired.push("a mutated A2 recomputes to another digest and fails verification");
    const authority = loadActiveSessionAuthority(input.resultsDir);
    const bound = { preregistrationHash: authorities.preregistrationHash.actual, manifestHash: authorities.manifestHash.actual, externalReferenceHash: authorities.externalReferenceHash.actual, a1AmendmentHash: authority.a1AmendmentHash };
    if (auditSessionAuthorityBinding({ ...authority, amendmentHash: verification.recomputedHash }, bound).length === 1) fired.push("P14's binding audit refuses an A2 whose digest is not the pinned one");
    if (auditSessionAuthorityBinding(authority, { ...bound, a1AmendmentHash: "0".repeat(64) }).length === 1) fired.push("an A2 bound over a foreign A1 is refused");
    const ledger = freshLedger(authorities);
    const refused = await attempt(depsFor(authorities, ledger, undefined, syntheticWorld(), { sessionAuthority: { ...authority, amendmentHash: "0".repeat(64) } }), { executionOrder: 0 });
    if (refusedBy("P14_QUOTA_SESSION_AUTHORITY", refused.error) && ledger.entries.length === 0) fired.push("a row under a mutated A2 is refused by P14 before any container");
    const tmp = mkdtempSync(join(input.scratchDir, "f224-results-"));
    try {
      for (const file of ["stage5_m214_preregistration.json", M215_MANIFEST_FILE, "stage5_m214_external_reference.json", "stage5_m214_a1_retry_reserve_amendment.json"]) {
        writeFileSync(join(tmp, file), readFileSync(join(input.resultsDir, file)));
      }
      writeFileSync(join(tmp, "stage5_m214_a2_subscription_quota_scheduling_amendment.json"), JSON.stringify(mutated));
      const result = launch(["--authorize-spend", "m220-control", "--max-pairs-this-session", "1", "--results", tmp, "--cohort-dir", join(tmp, "cohort")]);
      if (result.status !== 0 && /not the active A2 authority|recomputes to/.test(result.stderr)) fired.push("the real launcher refuses a mutated committed A2");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    controls.push(control("F224", "F26", "a mutated A2 fails its digest, P14 refuses a row under it, a foreign A1 lineage is refused, and the real launcher refuses a mutated committed file", "GUARD_FIRES", fired.length >= 5 ? fired : [], "REAL_PROCESS"));
  }

  // ── F27 (F225), F28 (F226), F29 (F227): pairs split across sessions in both arm orders; timing metadata ──
  {
    const baselineFirst = pairs.find((pair) => pair.firstArm === "baseline")!;
    const vtraceFirst = pairs.find((pair) => pair.firstArm === "vtrace")!;
    const research = mkdtempSync(join(input.scratchDir, "f225-"));
    const issues27: string[] = [];
    const issues28: string[] = [];
    const issues29: string[] = [];
    try {
      const namespace = establishNamespace(join(research, "_work"), { experiment: RESEARCH_EXPERIMENT, cohortDir: research });
      const scratch = new ScratchAuthority({
        namespace, registry: new ScratchRegistry(join(research, "_scratch_registry")), evidenceDir: join(research, "evidence"),
        liveness: new HostLivenessProbe({ docker: false }), experiment: RESEARCH_EXPERIMENT, executorVersion: "m220-falsification",
      });
      const ledger = freshLedger(authorities);
      const ops = syntheticOperations(syntheticOperationsClock());
      let sessionNumber = 0;
      const startSession = (maxPairs: number, request: () => PauseRequest | null = () => null) => {
        sessionNumber = nextSessionNumber(ops.ledger.events);
        ops.operations.recordSessionEvent("QUOTA_SESSION_STARTED", { sessionId: sessionIdFor(sessionNumber), sessionNumber, maxPairs, ledgerEntriesBefore: ledger.entries.length });
        return bounds(maxPairs, { pauseRequest: request }, sessionNumber);
      };
      const endSession = (report: Awaited<ReturnType<typeof runCohort>>) => {
        ops.operations.recordSessionEvent("QUOTA_SESSION_ENDED", { sessionId: sessionIdFor(sessionNumber), endState: report.session?.endState, pauseReason: report.session?.pauseReason, counters: report.session?.counters, ledgerEntriesAfter: ledger.entries.length, incrementalBilledProviderSpend: "$0" });
      };
      const splitRun = async (pair: typeof baselineFirst, issues: string[]) => {
        // Run every pair before the target one in frozen order, then split the target.
        const before = pair.pairOrdinal - 1 - pairs.filter((p) => p.pairOrdinal < pair.pairOrdinal && pairStatus(p, ledger).state === "COMPLETE").length;
        if (before > 0) endSession(await runCohort(depsFor(authorities, ledger, ops, syntheticWorld(), { scratch }), { session: startSession(before) }));
        let pending: PauseRequest | null = null;
        const deps = depsFor(authorities, ledger, ops, syntheticWorld(), { scratch });
        withOutcome(deps.synthetic, (spec, outcome) => {
          if (spec.row.runId === pair.rows[0].runId) {
            writeFileSync(join(spec.scratch!.agentTmp, "m220-sentinel"), spec.row.arm);
            pending = { kind: "AFTER_CURRENT_ARM", requestedAt: "t", requestedBy: "m220" };
          }
          return outcome;
        });
        const first = await runCohort(deps, { session: startSession(5, () => pending) });
        endSession(first);
        if (first.session?.pauseReason !== "EXPLICIT_PAUSE_REQUEST_AFTER_ARM" || !first.session.counters.pairSplitOccurred) issues.push(`session did not split: ${first.session?.pauseReason}`);
        if (!ops.ledger.events.some((e) => e.kind === "PAIR_SPLIT_BY_QUOTA_WINDOW" && (e.detail as { instanceId: string }).instanceId === pair.instanceId)) issues.push("no PAIR_SPLIT_BY_QUOTA_WINDOW for the pair");
        const claimed = scratch.registry.list().filter((claim) => claim.state === "CLAIMED");
        if (claimed.length !== 0) issues.push(`${claimed.length} claims still CLAIMED after the pause`);
        if (!scratch.sweep().pass || scratch.sweep().entries.some((e) => e.classification !== "MARKER")) issues.push("owned scratch remained after the pause");
        // Session 2: the second arm only; its private /tmp is fresh and cannot see arm 1's sentinel.
        const deps2 = depsFor(authorities, ledger, ops, syntheticWorld(), { scratch });
        let seen: string | null = null;
        withOutcome(deps2.synthetic, (spec, outcome) => {
          if (spec.row.runId === pair.rows[1].runId) seen = existsSync(join(spec.scratch!.agentTmp, "m220-sentinel")) ? "VISIBLE" : "ABSENT";
          return outcome;
        });
        const second = await runCohort(deps2, { session: startSession(1) });
        endSession(second);
        if (seen !== "ABSENT") issues.push(`arm 1's sentinel was ${seen} to arm 2`);
        if (second.executed.length !== 1 || ledger.attemptsFor(pair.rows[0].instanceId, pair.rows[0].arm).length !== 1) issues.push("arm 1 was rerun or more than the second arm ran");
        if (pairStatus(pair, ledger).state !== "COMPLETE") issues.push("the pair is not complete after resumption");
        const order = ledger.entries.filter((e) => e.instanceId === pair.instanceId).map((e) => e.arm);
        if (JSON.stringify(order) !== JSON.stringify([pair.firstArm, pair.secondArm])) issues.push(`arm order ${order.join(",")}`);
      };
      await splitRun(baselineFirst, issues27);
      await splitRun(vtraceFirst, issues28);
      const journal = deriveSessionJournal(ops.ledger.events, ledger);
      const timing = pairTemporalGaps(pairs, ledger, journal);
      const split = timing.perPair.filter((entry) => entry.splitAcrossSessions);
      if (timing.pairsSplitAcrossSessions !== 2) issues29.push(`${timing.pairsSplitAcrossSessions} pairs split`);
      if (!split.some((e) => e.instanceId === baselineFirst.instanceId) || !split.some((e) => e.instanceId === vtraceFirst.instanceId)) issues29.push("the split pairs are not the two targets");
      if ((timing.splitsByFirstArm["baseline-first"] ?? 0) !== 1 || (timing.splitsByFirstArm["vtrace-first"] ?? 0) !== 1) issues29.push(`splits by first arm ${JSON.stringify(timing.splitsByFirstArm)}`);
      if (timing.medianSeconds === null || timing.p90Seconds === null || timing.maxSeconds === null) issues29.push("no gap statistics");
      if (split.some((e) => e.gapSeconds === null || e.firstArmSession === e.secondArmSession)) issues29.push("a split pair has no gap or the same session on both arms");
      if (timing.modifiesOutcomes !== false || timing.evaluationMetadataOnly !== true) issues29.push("timing is not declared metadata-only");
      if (journal.length < 3 || journal.some((entry, index) => entry.sessionNumber !== index + 1)) issues29.push("session numbering is not sequential");
    } finally {
      rmSync(research, { recursive: true, force: true });
    }
    controls.push(control("F225", "F27", "a BASELINE-first pair split across two sessions by an after-arm pause: arm 1's private /tmp sentinel is invisible to arm 2, no claim survives the pause, arm 1 is never rerun, arm order is preserved and the split is recorded", "GUARD_SILENT", issues27, "REAL_PROCESS"));
    controls.push(control("F226", "F28", "the same for a VTRACE-first pair: no scratch, process or context crosses the session boundary", "GUARD_SILENT", issues28, "REAL_PROCESS"));
    controls.push(control("F227", "F29", "pair temporal-gap metadata records the arm-1-end to arm-2-start gap for every pair, counts the two split pairs, attributes them by first arm (one each), reports median/p90/max and declares itself evaluation metadata that modifies no outcome; sessions are numbered sequentially", "GUARD_SILENT", issues29));
  }

  // ── F229: the real launcher's --preflight passes every technical gate including M220's, runs nothing ──
  {
    const result = launch(["--preflight", "--cohort-dir", scratchCohort]);
    const issues: string[] = [];
    let document: Record<string, unknown> | null = null;
    try {
      document = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      issues.push(`no JSON (exit ${result.status}): ${result.stderr.slice(-300)}`);
    }
    if (document !== null) {
      const gates = document.gates as { id: string; pass: boolean; detail: string }[];
      for (const id of ["SESSION_AUTHORITY", "HARNESS_AUTHORITY", "AGENT_HARNESS_CAPABILITIES", "PAIR_HARNESS_EQUALITY", "API_OVERRIDE_GUARD", "TREATMENT_TREE", "QUOTA_WINDOW", "SUBSCRIPTION_AUTH", "FROZEN_AUTHORITIES", "EXECUTABLE_AUTHORITY", "ISOLATION_PREFLIGHT", "SCRATCH_CAPACITY_IMAGES"]) {
        const gate = gates.find((entry) => entry.id === id);
        if (gate?.pass !== true) issues.push(`${id}: ${gate?.detail ?? "absent"}`);
      }
      if (document.verdict !== "FINAL_ZERO_SPEND_LAUNCH_PREFLIGHT_PASSED" || document.finalBlocker !== "SPEND_AUTHORIZATION_PENDING") issues.push(`verdict ${String(document.verdict)} / ${String(document.finalBlocker)}`);
      if (document.launchPerformed !== false || document.rowsExecuted !== 0 || document.providerCalls !== 0 || document.agentInvoked !== false) issues.push("the preflight performed work");
      if (!Array.isArray(document.operatorPrerequisitesPending)) issues.push("operator prerequisites not reported");
      if (result.status !== 0) issues.push(`exit ${result.status}`);
    }
    controls.push(control("F229", null, "the production launcher's --preflight passes every technical gate including SESSION_AUTHORITY, AGENT_IDENTITY, TREATMENT_TREE, QUOTA_WINDOW and SUBSCRIPTION_AUTH, reports operator prerequisites separately, stops at SPEND_AUTHORIZATION_PENDING and runs nothing", "GUARD_SILENT", issues, "REAL_PROCESS"));
  }

  // ── F230: the CLI's auth status is a zero-network read ──
  {
    const issues: string[] = [];
    const binary = resolveAgentBinary().binary;
    const offline = spawnSync("unshare", ["-r", "-n", binary, ...CLI_AUTH_STATUS_ARGS], { encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", TERM: "dumb" } });
    if (offline.status !== 0) issues.push(`offline auth status exit ${offline.status}: ${offline.stderr.slice(-200)}`);
    const parsed = parseCliAuthStatus("offline", offline.stdout);
    if (!parsed.available || parsed.loggedIn !== true || parsed.authMethod !== "claude.ai" || parsed.subscriptionType !== "max") issues.push(`offline status ${JSON.stringify({ a: parsed.available, l: parsed.loggedIn, m: parsed.authMethod, s: parsed.subscriptionType })}`);
    if (parsed.fieldNames.some((name) => /usage|utilization|resets|remaining|quota/i.test(name))) issues.push("auth status carries usage fields (update M220_QUOTA_AVAILABILITY)");
    const creds = readCredentialFacts();
    const account = readAccountProfileFacts();
    if (!creds.hasClaudeAiOauth || creds.subscriptionType !== "max") issues.push("the host credential file is not a max OAuth credential");
    if (account.hasExtraUsageEnabled === null) issues.push("the host profile does not expose hasExtraUsageEnabled");
    controls.push(control("F230", null, "the pinned CLI's `auth status --json` succeeds with networking unshared and reports the claude.ai / max login with no usage fields (MACHINE_READABLE_QUOTA_UNAVAILABLE pre-launch); the host credential and profile expose the non-secret facts the audit reads", "GUARD_SILENT", issues, "REAL_PROCESS"));
  }

  // ── F231: the production adapter over a normal recorded stream reports NONE / 'none' and no abort ──
  {
    const armRoot = mkdtempSync(join(input.scratchDir, "f231-"));
    const issues: string[] = [];
    try {
      let authSeen: string | null = null;
      const outcome = await realAdapterRun(manifest[1]!, armRoot, [INIT_LINE, rateLimitLine({ status: "allowed", rateLimitType: "five_hour", resetsAt: 1_788_600_000, utilization: 0.2 }), RESULT_LINE], {
        assertProviderModelIdentity: () => undefined, assertAuthSource: (source) => { authSeen = source; },
      });
      if (outcome.quota?.signal !== "NONE" || outcome.quota.sawRateLimitEvent !== true) issues.push(`quota ${outcome.quota?.signal}`);
      if (outcome.apiKeySource !== "none" || authSeen !== "none") issues.push(`apiKeySource ${outcome.apiKeySource} / hook saw ${String(authSeen)}`);
      if (outcome.failureCategory !== null || outcome.terminationReason !== "AGENT_COMPLETED") issues.push(`termination ${outcome.terminationReason} ${outcome.failureCategory}`);
      if (existsSync(join(armRoot, "raw", `${manifest[1]!.runId}#m220.abort`))) issues.push("an abort sentinel was written on an allowed stream");
      // And the auth hook throwing stops the run before anything else.
      let thrown: Error | null = null;
      try {
        await realAdapterRun(manifest[2]!, armRoot, [JSON.stringify({ type: "system", subtype: "init", model: M214_MODEL.model, apiKeySource: "ANTHROPIC_API_KEY", tools: [], mcp_servers: [], claude_code_version: "2.1.260" }), RESULT_LINE], {
          assertProviderModelIdentity: () => undefined, assertAuthSource: (source) => { if (source !== "none") throw new Error(`refused source ${source}`); },
        });
      } catch (error) {
        thrown = error as Error;
      }
      if (thrown === null || !/refused source ANTHROPIC_API_KEY/.test(thrown.message)) issues.push("the auth hook did not stop the run");
      if (!existsSync(join(armRoot, "raw", `${manifest[2]!.runId}#m220.abort`))) issues.push("no abort sentinel for the refused source");
    } finally {
      rmSync(armRoot, { recursive: true, force: true });
    }
    controls.push(control("F231", null, "the production agent adapter over a recorded allowed stream reports quota NONE (event seen), apiKeySource 'none' through the hook, a normal completion and no abort; a recorded init naming ANTHROPIC_API_KEY makes the hook stop the run and write the sentinel", "GUARD_SILENT", issues, "REAL_PROCESS"));
  }

  // ── F232: a COHORT launch without a pair cap is refused by name; the plan binds A2 ──
  {
    const fired: string[] = [];
    const noCap = launch(["--authorize-spend", "m220-control", "--cohort-dir", scratchCohort]);
    if (noCap.status !== 0 && /requires --max-pairs-this-session/.test(noCap.stderr)) fired.push("a COHORT launch without --max-pairs-this-session is refused by name");
    const plan = launch(["--plan", "--cohort-dir", scratchCohort]);
    try {
      const document = JSON.parse(plan.stdout) as { sessionAuthority: { bound: boolean; amendmentHash: string } };
      if (document.sessionAuthority.bound && document.sessionAuthority.amendmentHash === M220_FROZEN_A2_HASH) fired.push("the plan binds the pinned A2");
    } catch {
      // recorded below
    }
    const bare = launch(["--cohort-dir", scratchCohort]);
    if (bare.status !== 0 && /no spend authorisation/.test(bare.stderr) && /\$735/.test(bare.stderr)) fired.push("the bare launcher still refuses on spend naming $735 (M219 F196 preserved)");
    controls.push(control("F232", null, "a COHORT launch without a pair cap is refused by name, the plan binds the pinned A2, and the bare launcher still refuses on spend authorisation naming $735", "GUARD_FIRES", fired.length >= 3 ? fired : [], "REAL_PROCESS"));
  }

  return controls;
}

export function suiteDocument(controls: readonly M217Control[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: M220_SUITE_VERSION,
    milestone: "M220",
    generatedAt: new Date().toISOString(),
    controlCount: controls.length,
    satisfied: controls.filter((entry) => entry.satisfied).length,
    failures: controls.filter((entry) => !entry.satisfied).map((entry) => entry.id),
    guardFiresControls: controls.filter((entry) => entry.expectation === "GUARD_FIRES").length,
    guardSilentControls: controls.filter((entry) => entry.expectation === "GUARD_SILENT").length,
    realProcessControls: controls.filter((entry) => entry.substrate === "REAL_PROCESS").length,
    suitePasses: suitePasses(controls),
    briefControlMap: controls.filter((entry) => entry.briefId !== null).map((entry) => ({ id: entry.id, briefId: entry.briefId })),
    liveModelSpendUsd: 0,
    providerCalls: 0,
    frozenBenchmarkTaskLiveAgentRuns: 0,
    frozenInstancesTouched: [],
    containersStarted: 0,
    controls,
    ...extra,
  };
}

export function ensureResultsDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
