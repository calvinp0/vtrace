/**
 * M220-A3 §16 — falsification of the harness-compatibility amendment.
 *
 * Brief ids F1–F14 are realised as F233–F246 (M220 ended at F232); F247+ are
 * controls the implementation needed. Harness controls run the REAL probe
 * (`probeAgentHarness` through the real isolated spawner) against the REAL
 * installed Claude Code and against small fake harnesses written to the
 * suite's scratch: each fake is a shell script that behaves like the CLI in
 * exactly one respect less (or one version string different). Executor
 * controls drive the real `runCohort` / `executeManifestRow` / P16 with a
 * synthetic harness gate. Subscription controls drive the real resolution.
 *
 * No model, no provider, no frozen task, no container, no outcome.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { M214_AGENT, M214_MODEL, M214_NATIVE_TOOLS, type RunManifestRow } from "./m214Preregistration";
import {
  type ExecutorDependencies,
  type FrozenAuthorities,
  LaunchRefusedError,
  M215_MANIFEST_FILE,
  auditAgentIdentity,
  auditSpendAuthorization,
  executeManifestRow,
  launchPreconditionGates,
  runCohort,
  verifyFrozenAuthorities,
} from "./m215LaunchExecutor";
import { CohortLedger } from "./m215CohortLedger";
import { syntheticAdapters, syntheticClock, syntheticWorld } from "./m215Fixtures";
import { ArmEnvironmentRegistry, M216AgentAdapter, classifyTermination, parseAgentStream } from "./m216ProductionAdapters";
import type { SubstrateBridge } from "./m216SubstrateBridge";
import type { OperationalEvent } from "./m217ContinuationSafety";
import { type M217Control, control, suitePasses } from "./m217Falsification";
import { syntheticOperations, syntheticOperationsClock } from "./m217Fixtures";
import { cohortOperationalStatus } from "./m217RetryReserve";
import {
  M214_A3_FILE,
  M214_A3_PARENT,
  M220A3_FROZEN_HASH,
  auditA3Amendment,
  buildA3AmendmentDocument,
  verifyA3Amendment,
} from "./m220A3Amendment";
import {
  AgentHarnessAuthority,
  type HarnessProbeReport,
  networkIsolationAvailable,
  networkUnsharedSpawner,
  observationFrom,
  probeAgentHarness,
  resolveAgentHarnessIdentity,
} from "./m220A3AgentHarness";
import { type AgentHarnessGate, type AgentHarnessObservation, harnessVersionSummary } from "./m220A3PairHarness";
import { sessionIdFor, type SessionBounds } from "./m220QuotaSession";
import {
  type AccountProfileFacts,
  type CliAuthStatus,
  type CredentialFileFacts,
  assessSubscriptionAuth,
  autoUpdatePosture,
  inspectAuthEnvironment,
} from "./m220SubscriptionAuth";
import { parseLaunchArgs, recordOperatorAttestation } from "./run_stage5_m215_launch";

export const M220A3_SUITE_VERSION = "stage5.m220-a3.falsification.v1" as const;
export { control, suitePasses };

const FAKE_SECRET = "FAKE-CREDENTIAL-VALUE-M220A3-0123456789";

// ── fake harnesses ──────────────────────────────────────────────────

const ALL_STATIC_TOKENS = "tool_use tool_result error_max_turns error_max_budget_usd";
const RATE_LIMIT_TOKENS = "rate_limit_event rate_limit_info allowed allowed_warning rejected rateLimitType resetsAt utilization isUsingOverage overageStatus";

interface FakeHarnessOptions {
  readonly version: string;
  readonly plainText?: boolean;
  readonly omitModel?: boolean;
  readonly omitRateLimitTokens?: boolean;
}

/**
 * A shell script that answers `--version`, `auth status --json` and the
 * production `-p` invocation the way the CLI does offline, writes into
 * CLAUDE_CONFIG_DIR, and carries the stream schema tokens in a comment. Each
 * option removes exactly one behaviour.
 */
export function writeFakeHarness(dir: string, name: string, options: FakeHarnessOptions): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const tokens = options.omitRateLimitTokens === true ? ALL_STATIC_TOKENS : `${ALL_STATIC_TOKENS} ${RATE_LIMIT_TOKENS}`;
  const init = options.omitModel === true
    ? `{"type":"system","subtype":"init","apiKeySource":"none","tools":["Read"],"mcp_servers":[{"name":"harness_probe","status":"failed"}],"claude_code_version":"$VERSION"}`
    : `{"type":"system","subtype":"init","model":"$MODEL","apiKeySource":"none","tools":["Read"],"mcp_servers":[{"name":"harness_probe","status":"failed"}],"claude_code_version":"$VERSION"}`;
  const body = options.plainText === true
    ? 'echo "Not logged in. Please run /login"'
    : [
      `echo "${init.replace(/"/g, '\\"')}"`,
      `echo '{"type":"result","subtype":"success","is_error":true,"total_cost_usd":0,"num_turns":1,"usage":{"input_tokens":0,"output_tokens":0}}'`,
    ].join("\n");
  writeFileSync(path, [
    "#!/bin/sh",
    `# schema tokens: ${tokens}`,
    `VERSION='${options.version}'`,
    'if [ "$1" = "--version" ]; then echo "$VERSION (Claude Code)"; exit 0; fi',
    'mkdir -p "$CLAUDE_CONFIG_DIR" && : > "$CLAUDE_CONFIG_DIR/.claude.json"',
    `if [ "$1" = "auth" ]; then echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'; exit 0; fi`,
    'MODEL=""',
    'while [ $# -gt 0 ]; do if [ "$1" = "--model" ]; then MODEL="$2"; fi; shift; done',
    body,
    "exit 1",
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
  return path;
}

// ── synthetic harness gates for the executor controls ───────────────

export function syntheticObservation(version: string, sha: string, verdict: AgentHarnessObservation["capabilityVerdict"] = "AGENT_HARNESS_CAPABILITIES_PASS"): AgentHarnessObservation {
  return {
    contractVersion: "stage5.m220-a3.agent-harness-contract.v1", declaredBinary: M214_AGENT.binary,
    resolvedBinary: `/synthetic/claude/${version}`, versionOutput: `${version} (Claude Code)`, version, sha256: sha,
    capabilityVerdict: verdict, capabilityFingerprint: "synthetic",
    issues: verdict === "AGENT_HARNESS_CAPABILITIES_PASS" ? [] : ["AGENT_HARNESS_CAPABILITY_MISMATCH C2_STRUCTURED_STREAM_OUTPUT: synthetic"],
  };
}

const HARNESS_A = syntheticObservation("2.1.284", "a".repeat(64));
const HARNESS_B = syntheticObservation("2.1.290", "b".repeat(64));

function gateFrom(select: () => AgentHarnessObservation): AgentHarnessGate {
  return { observe: select, amendmentHash: M220A3_FROZEN_HASH };
}

function freshLedger(authorities: FrozenAuthorities): CohortLedger {
  return new CohortLedger("SYNTHETIC", authorities.preregistrationHash.actual, authorities.manifestHash.actual);
}

/** Synthetic deps whose arm surface reports the release the gate currently resolves. */
function harnessDeps(
  authorities: FrozenAuthorities, ledger: CohortLedger, gate: AgentHarnessGate,
  ops = syntheticOperations(syntheticOperationsClock()), worldOverrides: Parameters<typeof syntheticWorld>[0] = {},
): ExecutorDependencies & { readonly ops: ReturnType<typeof syntheticOperations> } {
  const world = { ...syntheticWorld(worldOverrides) };
  Object.defineProperty(world, "agentVersion", { get: () => gate.observe().version, enumerable: true });
  const adapters = syntheticAdapters(world);
  return {
    mode: "SYNTHETIC", authorities, container: adapters.container, agent: adapters.agent, evaluator: adapters.evaluator,
    ledger, now: syntheticClock(), spendAuthorization: null, operations: ops.operations, agentHarness: gate, ops,
  };
}

function bounds(maxPairs: number, sessionNumber = 1): SessionBounds {
  return { sessionId: sessionIdFor(sessionNumber), maxPairs, deadlineAt: null, pauseRequest: () => null, acknowledgePauseRequest: () => undefined };
}

function kinds(events: readonly OperationalEvent[], kind: string): readonly OperationalEvent[] {
  return events.filter((event) => event.kind === kind);
}

// ── subscription fixtures ───────────────────────────────────────────

const cliOk: CliAuthStatus = { command: "claude auth status --json", available: true, loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", fieldNames: [], error: null };
const credsOk: CredentialFileFacts = { path: "/x/.credentials.json", exists: true, hasClaudeAiOauth: true, subscriptionType: "max", rateLimitTier: null, accessTokenExpiresAtIso: null, refreshTokenExpiresAtIso: "2030-01-01T00:00:00.000Z", secretsRead: false };
const AT = "2026-09-28T12:00:00.000Z";
const profileTrueOnly: AccountProfileFacts = {
  path: "/x/.claude.json", exists: true, hasExtraUsageEnabled: true, organizationType: "claude_max", billingType: "stripe_subscription",
  profileFetchedAtIso: "2026-09-27T20:45:40.141Z", autoUpdates: false, installMethod: "native",
  usageSnapshot: { present: false, extraUsageEnabled: null, userDisabled: null, fetchedAtIso: null, accountMatches: null },
};
const cleanEnv = { PATH: "/usr/bin:/bin", HOME: "/home/x" };
function assess(overrides: Partial<Parameters<typeof assessSubscriptionAuth>[0]> = {}) {
  const account = overrides.account ?? profileTrueOnly;
  return assessSubscriptionAuth({
    environment: inspectAuthEnvironment(cleanEnv), settings: [], cliAuth: cliOk, credentials: credsOk, account,
    autoUpdate: autoUpdatePosture(account, cleanEnv), at: AT, ...overrides,
  });
}

/** A bridge that speaks `agent.run` without a process, recording the argv it was handed. */
function fakeBridge(lines: readonly string[], seen: { argv: string[] }): SubstrateBridge {
  return {
    call: async (op: string, params: Record<string, unknown>, onEvent?: (event: Record<string, unknown>) => void) => {
      if (op !== "agent.run") throw new Error(`fake bridge: unexpected op ${op}`);
      seen.argv = [...(params.argv as string[])];
      lines.forEach((line, ordinal) => onEvent?.({ stream: "agent.event", ordinal, line }));
      return { started: true, exitCode: 0, timedOut: false, durationMs: 1, sandboxed: false, stderrTail: "", aborted: false, spawnedArgv: [], agentTmp: null };
    },
  } as unknown as SubstrateBridge;
}

export interface M220A3SuiteInput {
  readonly benchmarkDir: string;
  readonly resultsDir: string;
  readonly scratchDir: string;
  readonly repoRoot: string;
}

export async function runM220A3FalsificationSuite(input: M220A3SuiteInput): Promise<readonly M217Control[]> {
  const controls: M217Control[] = [];
  const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(input.resultsDir, file), "utf8")) as Record<string, unknown>;
  const authorities = verifyFrozenAuthorities(
    read("stage5_m214_preregistration.json"),
    read(M215_MANIFEST_FILE) as unknown as { rows: RunManifestRow[]; manifestHash: string },
    read("stage5_m214_external_reference.json"),
  );
  if (!authorities.verified) throw new Error(`frozen authorities do not verify: ${authorities.issues.join("; ")}`);
  const manifest = authorities.manifest;
  mkdirSync(input.scratchDir, { recursive: true });
  const fakes = join(input.scratchDir, "fake-harnesses");
  const probeRoot = join(input.scratchDir, "probe");
  mkdirSync(probeRoot, { recursive: true });
  const probe = (binary: string): HarnessProbeReport => probeAgentHarness(resolveAgentHarnessIdentity(binary), { scratchRoot: probeRoot });
  const failed = (report: HarnessProbeReport): string[] => report.capabilities.filter((entry) => !entry.satisfied).map((entry) => entry.id);
  const launcher = join(input.benchmarkDir, "run_stage5_m215_launch.ts");
  const scratchCohort = join(input.scratchDir, "cohort");
  mkdirSync(scratchCohort, { recursive: true });
  const launch = (args: readonly string[], env: Record<string, string | undefined> = {}) =>
    spawnSync("bun", [launcher, ...args], { encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } });

  // ── F1 (F233): the currently installed release passes, although it is not 2.1.260 ──
  {
    const report = probe(M214_AGENT.binary);
    const issues: string[] = [];
    if (report.verdict !== "AGENT_HARNESS_CAPABILITIES_PASS") issues.push(`verdict ${report.verdict}: ${report.issues.join("; ")}`);
    if (report.capabilities.length !== 12) issues.push(`${report.capabilities.length} capabilities evaluated`);
    if (report.isolation !== "NETWORK_UNSHARED_NO_CREDENTIAL" || report.providerCalls !== 0 || report.probeReportedCostUsd !== 0) issues.push(`isolation ${report.isolation}, cost ${String(report.probeReportedCostUsd)}`);
    const note = report.identity.version === M214_AGENT.version ? " (the host happens to run the M214 release; the gate did not consult it)" : "";
    controls.push(control("F233", "F1", `the currently installed Claude Code ${report.identity.version} at ${report.identity.resolvedBinary} is not M214's ${M214_AGENT.version} and satisfies all 12 capabilities with zero provider calls${note}`, "GUARD_SILENT", issues, "REAL_PROCESS"));
  }

  // ── F2 (F234): same behaviour, harmless different version string → passes ──
  {
    const fake = writeFakeHarness(fakes, "claude-9.9.9", { version: "9.9.9" });
    const report = probe(fake);
    const issues: string[] = [];
    if (report.verdict !== "AGENT_HARNESS_CAPABILITIES_PASS") issues.push(`verdict ${report.verdict}: ${failed(report).join(", ")}`);
    if (report.identity.version !== "9.9.9") issues.push(`version ${report.identity.version}`);
    if (auditAgentIdentity("9.9.9", M214_AGENT.userPromptText, M214_NATIVE_TOOLS).length !== 0) issues.push("R2 still compares the release to a pin");
    const ledger = freshLedger(authorities);
    const gate = new AgentHarnessAuthority({ declaredBinary: fake, scratchRoot: probeRoot });
    const deps = harnessDeps(authorities, ledger, gate);
    const p16 = launchPreconditionGates(deps, manifest[0]!).find((entry) => entry.gateId === "P16_AGENT_HARNESS");
    if (p16?.status !== "PASS") issues.push(`P16 ${p16?.status}: ${p16?.failureReason}`);
    controls.push(control("F234", "F2", "a harness with identical behaviour and a different version string (9.9.9) passes the capability contract, R2 and P16: the release is metadata", "GUARD_SILENT", issues, "REAL_PROCESS"));
  }

  // ── F3 (F235): missing structured output → refused ──
  {
    const fake = writeFakeHarness(fakes, "claude-plaintext", { version: "2.1.999", plainText: true });
    const report = probe(fake);
    const fired: string[] = [];
    if (report.verdict === "AGENT_HARNESS_CAPABILITY_MISMATCH" && failed(report).includes("C2_STRUCTURED_STREAM_OUTPUT")) fired.push(`AGENT_HARNESS_CAPABILITY_MISMATCH on [${failed(report).join(", ")}]`);
    const gate = new AgentHarnessAuthority({ declaredBinary: fake, scratchRoot: probeRoot });
    const ledger = freshLedger(authorities);
    const deps = harnessDeps(authorities, ledger, gate);
    try {
      await executeManifestRow(deps, { executionOrder: 0 });
    } catch (error) {
      if (error instanceof LaunchRefusedError && error.gates.some((entry) => entry.gateId === "P16_AGENT_HARNESS" && entry.status === "FAIL")) fired.push("P16 refuses the row");
    }
    const session = await runCohort(harnessDeps(authorities, freshLedger(authorities), gate), { session: bounds(3) });
    if (session.executed.length === 0 && session.session?.pauseReason === "AGENT_HARNESS_CAPABILITY_MISMATCH") fired.push("the session starts nothing and pauses AGENT_HARNESS_CAPABILITY_MISMATCH");
    if (ledger.entries.length === 0) fired.push("no attempt was recorded");
    controls.push(control("F235", "F3", "a harness without structured stream output is AGENT_HARNESS_CAPABILITY_MISMATCH: P16 refuses the row and the cohort loop starts nothing", "GUARD_FIRES", fired.length >= 4 ? fired : [], "REAL_PROCESS"));
  }

  // ── F4 (F236): no model identity in the init event → refused ──
  {
    const report = probe(writeFakeHarness(fakes, "claude-nomodel", { version: "2.1.999", omitModel: true }));
    const fired = report.verdict === "AGENT_HARNESS_CAPABILITY_MISMATCH" && failed(report).includes("C3_INIT_MODEL_IDENTITY")
      ? [`AGENT_HARNESS_CAPABILITY_MISMATCH on [${failed(report).join(", ")}]`] : [];
    controls.push(control("F236", "F4", "a harness whose init event carries no model identity is refused (C3), so R12 always has a field to read", "GUARD_FIRES", fired, "REAL_PROCESS"));
  }

  // ── F5 (F237): no rate-limit event support → refused ──
  {
    const report = probe(writeFakeHarness(fakes, "claude-noratelimit", { version: "2.1.999", omitRateLimitTokens: true }));
    const fired = report.verdict === "AGENT_HARNESS_CAPABILITY_MISMATCH" && failed(report).join(",") === "C8_RATE_LIMIT_EVENTS"
      ? [`AGENT_HARNESS_CAPABILITY_MISMATCH on exactly [C8_RATE_LIMIT_EVENTS]: ${report.capabilities.find((entry) => entry.id === "C8_RATE_LIMIT_EVENTS")?.evidence}`] : [];
    controls.push(control("F237", "F5", "a harness that cannot emit the rate_limit_event A2 depends on is refused, and nothing else about it is", "GUARD_FIRES", fired, "REAL_PROCESS"));
  }

  // ── F6 (F238): the harness changes between the two arms of one pair ──
  {
    const fired: string[] = [];
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    let stabilised = false;
    const gate = gateFrom(() => (!stabilised && ledger.entries.length >= 1 ? HARNESS_B : HARNESS_A));
    const first = await runCohort(harnessDeps(authorities, ledger, gate, ops), { session: bounds(5) });
    if (first.executed.length === 1 && first.session?.pauseReason === "PAIR_HARNESS_DRIFT" && first.session.endState === "PAUSED") fired.push("arm 1 ran, arm 2 was not started, the session PAUSED with PAIR_HARNESS_DRIFT");
    const drift = kinds(ops.ledger.events, "PAIR_HARNESS_DRIFT");
    if (drift.length === 1 && (drift[0]!.detail as { partnerSha256?: unknown }).partnerSha256 === HARNESS_A.sha256 && (drift[0]!.detail as { currentSha256?: unknown }).currentSha256 === HARNESS_B.sha256) fired.push("PAIR_HARNESS_DRIFT recorded with both digests");
    if (ops.operations.state() === "CONTINUATION_SAFE" && cohortOperationalStatus(manifest, ledger, ops.ledger).status !== "COHORT_HALTED_ISOLATION_RISK") fired.push("the pause is not an isolation halt");
    // The executor's own backstop: arm 2 called directly is refused by P16.
    try {
      await executeManifestRow(harnessDeps(authorities, ledger, gate, ops), { executionOrder: 1 });
    } catch (error) {
      if (error instanceof LaunchRefusedError && error.gates.some((entry) => entry.gateId === "P16_AGENT_HARNESS" && entry.status === "FAIL" && /PAIR_HARNESS_DRIFT/.test(entry.failureReason ?? ""))) fired.push("a direct arm-2 call is refused by P16 naming PAIR_HARNESS_DRIFT");
    }
    // The environment stabilises: the resolved harness is arm 1's executable again.
    stabilised = true;
    const second = await runCohort(harnessDeps(authorities, ledger, gate, ops), { session: bounds(1, 2) });
    const arm1Attempts = ledger.entries.filter((entry) => entry.runId === manifest[0]!.runId).length;
    if (second.executed.length === 1 && ledger.entries.length === 2 && arm1Attempts === 1) fired.push("the next session resumes at arm 2 on the same harness; arm 1 is never rerun");
    if (harnessVersionSummary(manifest, ops.ledger.events).pairsCrossingHarnessBoundary === 0) fired.push("no pair crosses a harness boundary");
    controls.push(control("F238", "F6", "a harness change between the two arms of one pair refuses arm 2 (loop pause + P16), records PAIR_HARNESS_DRIFT, and after the harness is restored resumes at arm 2 without rerunning arm 1; no pair crosses a harness boundary", "GUARD_FIRES", fired.length >= 6 ? fired : []));
  }

  // ── F7 (F239): the harness changes between complete pairs → permitted and recorded ──
  {
    const issues: string[] = [];
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    const gate = gateFrom(() => (ledger.entries.length >= 2 ? HARNESS_B : HARNESS_A));
    const report = await runCohort(harnessDeps(authorities, ledger, gate, ops), { session: bounds(3) });
    if (report.executed.length !== 6 || report.session?.pauseReason !== "PAIR_CAP_REACHED") issues.push(`executed ${report.executed.length}, pause ${report.session?.pauseReason}`);
    if (kinds(ops.ledger.events, "PAIR_HARNESS_DRIFT").length !== 0) issues.push("a cross-pair change was treated as drift");
    const transitions = kinds(ops.ledger.events, "AGENT_HARNESS_TRANSITION");
    if (transitions.length !== 1 || (transitions[0]!.detail as { toVersion?: unknown }).toVersion !== HARNESS_B.version) issues.push(`${transitions.length} transitions recorded`);
    const summary = harnessVersionSummary(manifest, ops.ledger.events);
    if (summary.pairsCrossingHarnessBoundary !== 0 || summary.versionsObserved.length !== 2 || summary.singleHarnessPairsByVersion[HARNESS_A.version] !== 1 || summary.singleHarnessPairsByVersion[HARNESS_B.version] !== 2) issues.push(`summary ${JSON.stringify(summary.singleHarnessPairsByVersion)} crossing ${summary.pairsCrossingHarnessBoundary}`);
    if (kinds(ops.ledger.events, "AGENT_HARNESS_OBSERVED").length !== 6) issues.push("not every attempt recorded its harness");
    // The capability preflight re-runs on the new executable: the real authority probes each digest once.
    const nine = writeFakeHarness(fakes, "claude-9.9.9-b", { version: "9.9.9" });
    let useFake = false;
    let probes = 0;
    const authority = new AgentHarnessAuthority({
      scratchRoot: probeRoot,
      resolve: () => resolveAgentHarnessIdentity(useFake ? nine : M214_AGENT.binary),
      spawner: (binary, args, options) => { if (args[0] === "-p") probes += 1; return networkUnsharedSpawner(binary, args, options); },
    });
    const before = authority.observe();
    authority.observe();
    useFake = true;
    const after = authority.observe();
    if (probes !== 2 || before.capabilityVerdict !== "AGENT_HARNESS_CAPABILITIES_PASS" || after.capabilityVerdict !== "AGENT_HARNESS_CAPABILITIES_PASS" || before.sha256 === after.sha256) issues.push(`probes ${probes}, verdicts ${before.capabilityVerdict}/${after.capabilityVerdict}`);
    controls.push(control("F239", "F7", "a harness change between complete pairs is permitted: every pair completes on one harness, the change is recorded as AGENT_HARNESS_TRANSITION, versions are counted per pair, and the real authority re-proves the contract once per new executable (cached otherwise)", "GUARD_SILENT", issues, "REAL_PROCESS"));
  }

  // ── F8 (F240): model identity changes → still refused ──
  {
    const fired: string[] = [];
    const ledger = freshLedger(authorities);
    const ops = syntheticOperations(syntheticOperationsClock());
    const report = await runCohort(harnessDeps(authorities, ledger, gateFrom(() => HARNESS_A), ops, { providerModelIdentity: "claude-opus-4-6-20260101" }), { session: bounds(5) });
    if (ledger.entries[0]?.validity.infrastructureCategory === "MODEL_IDENTITY_DRIFT") fired.push("MODEL_IDENTITY_DRIFT at initialisation");
    if (report.session?.endState === "HALTED" && /COHORT_HALTED_MODEL_IDENTITY/.test(report.stoppedBecause)) fired.push("the session halts COHORT_HALTED_MODEL_IDENTITY");
    if (cohortOperationalStatus(manifest, ledger, ops.ledger).status === "COHORT_HALTED_MODEL_IDENTITY") fired.push("operational status COHORT_HALTED_MODEL_IDENTITY");
    controls.push(control("F240", "F8", "with a passing harness bound, a provider-served model other than the frozen target is still MODEL_IDENTITY_DRIFT and halts the session; A3 did not touch R12", "GUARD_FIRES", fired.length >= 3 ? fired : []));
  }

  // ── F9 (F241): API key present → still refused ──
  {
    const fired: string[] = [];
    const pure = assess({ environment: inspectAuthEnvironment({ ...cleanEnv, ANTHROPIC_API_KEY: FAKE_SECRET }), overflowAttestation: "operator checked: credits off" });
    if (!pure.launchPermitted && pure.technicalIssues.some((issue) => issue.includes("ANTHROPIC_API_KEY"))) fired.push("pure assessment refuses even with an OFF attestation");
    const result = launch(["--authorize-spend", "m220a3-control", "--max-pairs-this-session", "1", "--attest-extra-usage-disabled", "m220a3 control", "--cohort-dir", scratchCohort], { ANTHROPIC_API_KEY: FAKE_SECRET });
    if (result.status !== 0 && /refusing to launch/.test(result.stderr) && /ANTHROPIC_API_KEY is present/.test(result.stderr)) fired.push("the real launcher refuses the cohort launch naming ANTHROPIC_API_KEY");
    if (!`${result.stdout}${result.stderr}`.includes(FAKE_SECRET)) fired.push("the value never appears");
    controls.push(control("F241", "F9", "ANTHROPIC_API_KEY in the launcher environment still refuses the session, attestation or not, and its value is never printed", "GUARD_FIRES", fired.length >= 3 ? fired : [], "REAL_PROCESS"));
  }

  // ── F10 (F242): stale cached TRUE + newer OFF attestation → passes with a warning ──
  {
    const issues: string[] = [];
    const report = assess({ overflowAttestation: { state: "DISABLED", statement: "checked Settings > Usage: credits are off", attestedAt: AT } });
    if (!report.launchPermitted || report.overflowVerdict !== "USAGE_CREDIT_OVERFLOW_DISABLED_AT_ACCOUNT") issues.push(`permitted ${report.launchPermitted}: ${report.issues.join("; ")}`);
    if (report.extraUsage.decidedBy !== "OPERATOR_ATTESTATION" || !report.extraUsage.staleCachedState) issues.push(`decided by ${report.extraUsage.decidedBy}, stale ${report.extraUsage.staleCachedState}`);
    if (!report.warnings.some((warning) => warning.startsWith("STALE_CACHED_EXTRA_USAGE_STATE"))) issues.push("no STALE_CACHED_EXTRA_USAGE_STATE warning");
    // The same resolution from the CLI's own user-level usage snapshot.
    const snapshot = assess({ account: { ...profileTrueOnly, usageSnapshot: { present: true, extraUsageEnabled: false, userDisabled: true, fetchedAtIso: "2026-09-27T20:51:58.836Z", accountMatches: true } } });
    if (!snapshot.launchPermitted || snapshot.extraUsage.decidedBy !== "CACHED_CLI_USAGE_SNAPSHOT" || !snapshot.extraUsage.staleCachedState) issues.push(`snapshot path: ${snapshot.extraUsage.decidedBy} ${snapshot.launchPermitted}`);
    // The attestation is recorded append-only.
    const log = join(input.scratchDir, "attestation-cohort");
    const path = recordOperatorAttestation(log, { state: "DISABLED", statement: "first", attestedAt: AT }, { experiment: "control" });
    const firstLine = readFileSync(path, "utf8");
    recordOperatorAttestation(log, { state: "DISABLED", statement: "second", attestedAt: AT }, { experiment: "control" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    if (lines.length !== 2 || !readFileSync(path, "utf8").startsWith(firstLine)) issues.push("the attestation log is not append-only");
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    if (record.authorizesSpend !== false || record.grantsG36 !== false || record.attestedAt !== AT || record.experimentIdentity === undefined) issues.push("the record lacks timestamp, identity or its non-authorisation");
    controls.push(control("F242", "F10", "a cached hasExtraUsageEnabled=true with a newer OFF attestation (or a newer user-level CLI usage snapshot reporting OFF) passes with STALE_CACHED_EXTRA_USAGE_STATE; the attestation is appended with timestamp and experiment identity", "GUARD_SILENT", issues));
  }

  // ── F11 (F243): stale cached TRUE with no newer authority → refused ──
  {
    const report = assess();
    const fired = !report.launchPermitted && report.overflowVerdict === "USAGE_CREDIT_OVERFLOW_ENABLED_AT_ACCOUNT"
      && report.overflowIssues.length === 1 && report.technicalIssues.length === 0 && report.extraUsage.decidedBy === "CACHED_ACCOUNT_PROFILE"
      ? ["refused as an operator prerequisite (overflow issue), not a technical defect"] : [];
    controls.push(control("F243", "F11", "a cached hasExtraUsageEnabled=true with no user-level snapshot and no attestation refuses the session", "GUARD_FIRES", fired));
  }

  // ── F12 (F244): the attestation says extra usage is enabled → refused ──
  {
    const fired: string[] = [];
    const enabled = assess({ account: { ...profileTrueOnly, hasExtraUsageEnabled: false }, overflowAttestation: { state: "ENABLED", statement: "credits are on", attestedAt: AT } });
    if (!enabled.launchPermitted && enabled.extraUsage.decidedBy === "OPERATOR_ATTESTATION") fired.push("an ENABLED attestation refuses even beside a profile reading false");
    const newerOn = assess({
      account: { ...profileTrueOnly, hasExtraUsageEnabled: false, usageSnapshot: { present: true, extraUsageEnabled: true, userDisabled: false, fetchedAtIso: "2026-09-28T13:00:00.000Z", accountMatches: true } },
      overflowAttestation: { state: "DISABLED", statement: "off", attestedAt: AT },
    });
    if (!newerOn.launchPermitted && newerOn.extraUsage.decidedBy === "CACHED_CLI_USAGE_SNAPSHOT") fired.push("a user-level snapshot reporting ON, newer than an OFF attestation, refuses");
    try {
      parseLaunchArgs(["--attest-extra-usage-disabled", "a", "--attest-extra-usage-enabled", "b"]);
    } catch (error) {
      if (/exclusive/.test((error as Error).message)) fired.push("contradictory attestations on one invocation are refused");
    }
    controls.push(control("F244", "F12", "an attestation that usage credits are enabled refuses the session; newer user-level evidence of ON beats an older OFF attestation; contradictory attestations are refused", "GUARD_FIRES", fired.length >= 3 ? fired : []));
  }

  // ── F13 (F245): the attestation does not grant G36 ──
  {
    const fired: string[] = [];
    if (auditSpendAuthorization(null, "COHORT", 735).length > 0) fired.push("spend authorisation absent ⇒ P7 issues regardless of attestation");
    const result = launch(["--max-pairs-this-session", "1", "--attest-extra-usage-disabled", "m220a3 control", "--cohort-dir", scratchCohort]);
    if (result.status !== 0 && /no spend authorisation/.test(result.stderr)) fired.push("the launcher with an attestation and no --authorize-spend refuses on spend authorisation");
    controls.push(control("F245", "F13", "an operator attestation authorises nothing but the usage-credit state: without --authorize-spend the launch is still refused (G36 absent)", "GUARD_FIRES", fired.length >= 2 ? fired : [], "REAL_PROCESS"));
  }

  // ── F14 (F246): outcome-bearing runs remain zero ──
  {
    const issues: string[] = [];
    const cohortLedger = join(input.resultsDir, "_m215_cohort", "cohort_ledger.json");
    if (existsSync(cohortLedger)) {
      const entries = (JSON.parse(readFileSync(cohortLedger, "utf8")) as { entries?: unknown[] }).entries ?? [];
      if (entries.length > 0) issues.push(`the production cohort ledger holds ${entries.length} entries`);
    }
    const a3 = read(M214_A3_FILE);
    if (a3.outcomeBearingRunsBeforeAmendment !== 0) issues.push("A3 does not record zero outcome-bearing runs");
    controls.push(control("F246", "F14", "outcome-bearing runs remain zero: the production cohort ledger has no entry and A3 records 0 before it", "GUARD_SILENT", issues, "REAL_PROCESS"));
  }

  // ── F247: the committed A3 is the pinned authority, and its parents are untouched ──
  {
    const issues: string[] = [];
    const committed = read(M214_A3_FILE);
    const verification = verifyA3Amendment(committed);
    if (!verification.verified) issues.push(...verification.issues);
    const parents = [M214_A3_PARENT.preregistrationFile, M214_A3_PARENT.manifestFile, M214_A3_PARENT.externalReferenceFile, M214_A3_PARENT.a1AmendmentFile, M214_A3_PARENT.a2AmendmentFile]
      .map((file) => join("benchmarks", "stage5_vexp_swe_bench_smoke", "results", file));
    const diff = spawnSync("git", ["-C", input.repoRoot, "status", "--porcelain", "--", ...parents], { encoding: "utf8" });
    if (diff.status !== 0 || diff.stdout.trim().length > 0) issues.push(`parent artifacts changed: ${diff.stdout.trim() || diff.stderr.trim()}`);
    controls.push(control("F247", null, `the committed A3 recomputes to the pinned ${M220A3_FROZEN_HASH.slice(0, 16)}…, binds M214 + A1 + A2 as its parents, and none of the parent artifacts differs from git`, "GUARD_SILENT", issues, "REAL_PROCESS"));
  }

  // ── F248: an A3 that re-pins a release or touches a frozen property is refused ──
  {
    const fired: string[] = [];
    const base = buildA3AmendmentDocument(AT);
    const repin = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    ((repin.capabilityContract as { capabilities: Record<string, unknown>[] }).capabilities)[0]!.requirement = "Claude Code == 2.1.283";
    if (auditA3Amendment(repin).some((issue) => /forbids version pinning/.test(issue))) fired.push("a capability naming a release is refused");
    if (auditA3Amendment({ ...base, agentVersion: "2.1.283" }).some((issue) => /frozen property 'agentVersion'/.test(issue))) fired.push("a top-level agentVersion is refused");
    if (auditA3Amendment({ ...base, modelIdentityUnchanged: { frozenModel: "claude-opus-4-6", weakened: true } }).length >= 2) fired.push("a changed model identity is refused");
    if (!verifyA3Amendment({ ...base, outcomeBearingRunsBeforeAmendment: 1 }).verified) fired.push("an amendment after an outcome does not verify");
    controls.push(control("F248", null, "an A3 variant that pins a release, carries agentVersion, weakens model identity or follows an outcome does not verify", "GUARD_FIRES", fired.length >= 4 ? fired : []));
  }

  // ── F249: the probe is actually isolated ──
  {
    const issues: string[] = [];
    if (!networkIsolationAvailable(networkUnsharedSpawner, probeRoot)) issues.push("isolation unavailable");
    // /proc/self/net/dev is the calling process's network namespace (sysfs would
    // show the namespace it was mounted in, i.e. the host's).
    const net = networkUnsharedSpawner("/bin/sh", ["-c", "tail -n +3 /proc/self/net/dev | cut -d: -f1 | tr -d ' '; echo ---; ls -A /tmp"], { env: { PATH: "/usr/bin:/bin" }, cwd: "/", timeoutMs: 10_000, privateRoot: probeRoot });
    const [interfaces, tmp] = net.stdout.split("---");
    if ((interfaces ?? "").trim() !== "lo") issues.push(`interfaces inside the probe: ${(interfaces ?? "").trim().replace(/\n/g, ",")}`);
    if ((tmp ?? "").trim().length !== 0) issues.push(`the probe /tmp is not private: ${(tmp ?? "").trim().slice(0, 120)}`);
    const refused = probeAgentHarness(resolveAgentHarnessIdentity(M214_AGENT.binary), { scratchRoot: probeRoot, isolationAvailable: false });
    if (refused.verdict !== "AGENT_HARNESS_CAPABILITY_MISMATCH" || refused.isolation !== "UNAVAILABLE" || refused.capabilities.length !== 0) issues.push("without isolation the probe still ran the harness");
    controls.push(control("F249", null, "the probe runs with only a loopback interface and an empty private /tmp; without namespace isolation it refuses to execute the harness at all", "GUARD_SILENT", issues, "REAL_PROCESS"));
  }

  // ── F250: the budget-stop spelling every installed release emits is COST_CAP_REACHED ──
  {
    const issues: string[] = [];
    const stream = [JSON.stringify({ type: "system", subtype: "init", model: M214_MODEL.model, apiKeySource: "none" }), JSON.stringify({ type: "result", subtype: "error_max_budget_usd", total_cost_usd: 3.1, num_turns: 40, usage: {} })];
    const classified = classifyTermination(parseAgentStream(stream), false, true, 3.5);
    if (classified.reason !== "COST_CAP_REACHED" || classified.failureCategory !== null) issues.push(`${classified.reason}/${classified.failureCategory}`);
    const turns = classifyTermination(parseAgentStream([stream[0]!, JSON.stringify({ type: "result", subtype: "error_max_turns", total_cost_usd: 1, num_turns: 250, usage: {} })]), false, true, 3.5);
    if (turns.reason !== "TURN_LIMIT_REACHED") issues.push(`turn limit ${turns.reason}`);
    controls.push(control("F250", null, "a --max-budget-usd stop reported as error_max_budget_usd below the cap is the frozen COST_CAP_REACHED (it was misfiled as MODEL_SERVICE_FAILURE before A3); turn limits unchanged", "GUARD_SILENT", issues));
  }

  // ── F251: the adapter spawns the verified executable and refuses one changed since ──
  {
    const fired: string[] = [];
    const fake = writeFakeHarness(fakes, "claude-spawn", { version: "9.9.9" });
    const identity = resolveAgentHarnessIdentity(fake);
    const armRoot = join(input.scratchDir, "f251");
    mkdirSync(armRoot, { recursive: true });
    const seen = { argv: [] as string[] };
    const adapter = new M216AgentAdapter({
      bridge: fakeBridge([JSON.stringify({ type: "system", subtype: "init", model: M214_MODEL.model, apiKeySource: "none" }), JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.01, num_turns: 1, usage: {} })], seen),
      mode: "RESEARCH", providerBoundary: "REPLAY", workRoot: armRoot, problemStatement: () => "x", armRootFor: () => armRoot,
      hostMountFor: () => join(armRoot, "testbed"), armEnvironments: new ArmEnvironmentRegistry(),
    });
    const spec = {
      row: manifest[0]!, attemptId: "f251", workingDirectory: "/testbed", modelTarget: M214_MODEL.model, agentBinary: M214_AGENT.binary,
      agentVersion: identity.version, nativeTools: ["Read"], mcpServers: [], maxTurns: 1, perRunCostCapUsd: 3.5, wallClockTimeoutSeconds: 60, userPromptTemplate: "x",
    };
    await adapter.run({ ...spec, harness: { resolvedBinary: identity.resolvedBinary, sha256: identity.sha256, version: identity.version } }, { assertProviderModelIdentity: () => undefined });
    if (seen.argv[0] === identity.resolvedBinary) fired.push("argv[0] is the verified resolved executable");
    writeFileSync(fake, `${readFileSync(fake, "utf8")}# replaced after verification\n`);
    try {
      await adapter.run({ ...spec, harness: { resolvedBinary: identity.resolvedBinary, sha256: identity.sha256, version: identity.version } }, { assertProviderModelIdentity: () => undefined });
    } catch (error) {
      if (/changed between verification and spawn/.test((error as Error).message)) fired.push("an executable replaced after verification is refused before spawn");
    }
    controls.push(control("F251", null, "the production adapter spawns exactly the verified executable and refuses one whose bytes changed after verification", "GUARD_FIRES", fired.length >= 2 ? fired : [], "REAL_PROCESS"));
  }

  // ── F252: R2 keeps what is frozen and drops only the pin ──
  {
    const issues: string[] = [];
    if (auditAgentIdentity("2.1.290", M214_AGENT.userPromptText, M214_NATIVE_TOOLS).length !== 0) issues.push("another release still fails R2");
    if (auditAgentIdentity("", M214_AGENT.userPromptText, M214_NATIVE_TOOLS).length !== 1) issues.push("an unobserved release passes R2");
    if (auditAgentIdentity("2.1.290", M214_AGENT.userPromptText, M214_NATIVE_TOOLS, "2.1.291").length !== 1) issues.push("a surface/verified release mismatch passes R2");
    if (auditAgentIdentity("2.1.290", `${M214_AGENT.userPromptText} extra`, M214_NATIVE_TOOLS).length !== 1) issues.push("a changed prompt template passes R2");
    if (auditAgentIdentity("2.1.290", M214_AGENT.userPromptText, [...M214_NATIVE_TOOLS, "WebFetch"]).length !== 1) issues.push("a changed native-tool catalogue passes R2");
    controls.push(control("F252", null, "R2 no longer compares the release to a pin, but still requires an observed release, the surface to match the verified harness, the frozen prompt template and the frozen native tools", "GUARD_SILENT", issues));
  }

  // ── F253: in COHORT mode P16 needs a harness authority enforcing the frozen A3 ──
  {
    const fired: string[] = [];
    const ledger = freshLedger(authorities);
    const base = harnessDeps(authorities, ledger, gateFrom(() => HARNESS_A));
    const p16 = (deps: ExecutorDependencies) => launchPreconditionGates(deps, manifest[0]!).find((entry) => entry.gateId === "P16_AGENT_HARNESS");
    const { agentHarness: _omit, ...withoutGate } = base;
    if (p16({ ...withoutGate, mode: "COHORT" })?.status === "FAIL") fired.push("COHORT without a harness authority fails P16");
    if (p16({ ...base, mode: "COHORT", agentHarness: { observe: () => HARNESS_A, amendmentHash: "0".repeat(64) } })?.status === "FAIL") fired.push("COHORT with a gate enforcing another amendment fails P16");
    if (p16({ ...base, mode: "COHORT" })?.status === "PASS") fired.push("COHORT with the frozen A3 gate and a passing harness passes P16");
    if (p16({ ...base, mode: "COHORT", agentHarness: { observe: () => { throw new Error("probe crashed"); }, amendmentHash: M220A3_FROZEN_HASH } })?.status === "FAIL") fired.push("a gate that throws fails P16 rather than escaping it");
    controls.push(control("F253", null, "P16 fails closed in COHORT mode without a harness authority, with one enforcing a non-frozen amendment, or with one that throws; it passes with the frozen A3 gate", "GUARD_FIRES", fired.length >= 4 ? fired : []));
  }

  // ── F254: the crossing detector itself works ──
  {
    const events = [
      { sequence: 1, kind: "AGENT_HARNESS_OBSERVED", at: AT, runId: manifest[0]!.runId, attemptId: "x1", detail: { instanceId: manifest[0]!.instanceId, version: "2.1.284", sha256: "a".repeat(64), resolvedBinary: "/a" } },
      { sequence: 2, kind: "AGENT_HARNESS_OBSERVED", at: AT, runId: manifest[1]!.runId, attemptId: "x2", detail: { instanceId: manifest[1]!.instanceId, version: "2.1.290", sha256: "b".repeat(64), resolvedBinary: "/b" } },
    ] as unknown as OperationalEvent[];
    const summary = harnessVersionSummary(manifest, events);
    const fired = summary.pairsCrossingHarnessBoundary === 1 && summary.pairsCrossingHarnessBoundaryIds[0] === manifest[0]!.instanceId ? ["a pair recorded on two digests is counted as crossing"] : [];
    controls.push(control("F254", null, "the final-report metadata detects a pair that crossed a harness boundary (the expected count of 0 is therefore a measurement, not a default)", "GUARD_FIRES", fired));
  }

  return controls;
}

export function suiteDocument(controls: readonly M217Control[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: M220A3_SUITE_VERSION,
    milestone: "M220-A3",
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
    outcomeBearingRuns: 0,
    containersStarted: 0,
    controls,
    ...extra,
  };
}
