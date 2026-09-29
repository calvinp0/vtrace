/**
 * M220-A3 — the pre-outcome operational amendment M214_A3_AGENT_HARNESS_COMPATIBILITY.
 *
 * M214 froze Claude Code 2.1.260 as part of the agent identity, and M216–M220
 * enforced it by spawning a versioned binary and refusing any other release.
 * That froze implementation trivia rather than the comparison: Claude Code is
 * the agent HARNESS that runs both arms identically, not the treatment under
 * test. The operator runs the currently installed release and does not want
 * minor or patch versions pinned; 2.1.260 is no longer on the host.
 *
 * A3 records, before any outcome exists, that:
 *
 *   * the exact release is OPERATIONAL METADATA (path, `--version`, digest,
 *     recorded per session and per attempt), never a launch condition;
 *   * what IS required is a behaviour contract derived from the production
 *     adapter, proven with zero provider calls before every session;
 *   * both arms of one task run on the SAME executable (by digest); a change
 *     inside a pair refuses the second arm and pauses the cohort;
 *   * a release change BETWEEN complete pairs or sessions is permitted when the
 *     contract still holds, and is recorded;
 *   * the user-level usage-credit state is read from the evidence that answers
 *     it, and the organisation-scoped profile flag (which can lag) no longer
 *     blocks when newer user-level evidence says credits are OFF.
 *
 * What A3 does not touch: the task population, manifest and order, the arms
 * and their treatment, VTRACE HEAD:src, the provider/model identity (R12 and
 * MODEL_IDENTITY_DRIFT are unchanged), budgets, native tools, prompts, the
 * evaluator, retry rules, the analysis, the stopping rule, the $735 ceiling,
 * the API-key guard and R16. M214, A1 and A2 are PARENTS: their digests are
 * checked, their artifacts are never rewritten.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  M214_AGENT,
  M214_BUDGET,
  M214_EXCLUSIONS,
  M214_MODEL,
  M214_STOPPING_RULE,
  canonicalize,
} from "./m214Preregistration";
import { M214_A1_RETRY_ATTEMPTS, type AmendmentDocument } from "./m218Amendment";
import {
  M214_A2_AMENDMENT_ID,
  M214_A2_FILE,
  M214_A2_FORBIDDEN_KEYS,
  M214_A2_PARENT,
  M220_FROZEN_A2_HASH,
} from "./m220Amendment";

export const M214_A3_AMENDMENT_ID = "M214_A3_AGENT_HARNESS_COMPATIBILITY" as const;
export const M214_A3_SCHEMA = "stage5.m214-a3.pre-outcome-amendment.v1" as const;
export const M214_A3_HASH_DOMAIN = "M214_A3_AGENT_HARNESS_COMPATIBILITY\n" as const;
export const M214_A3_FILE = "stage5_m214_a3_agent_harness_compatibility_amendment.json" as const;
export const M214_A3_HASH_FILE = "stage5_m214_a3_amendment_hash.json" as const;
export const M220A3_EXECUTABLE_AUTHORITY_DOMAIN = "M220_A3_EXECUTABLE_AUTHORITY\n" as const;
export const M220A3_HARNESS_CONTRACT_VERSION = "stage5.m220-a3.agent-harness-contract.v1" as const;

/** M214 + A1 + A2, restated from A2's own parent block plus A2's pinned digest. */
export const M214_A3_PARENT = Object.freeze({
  ...M214_A2_PARENT,
  a2AmendmentId: M214_A2_AMENDMENT_ID,
  a2AmendmentFile: M214_A2_FILE,
  a2AmendmentHash: M220_FROZEN_A2_HASH,
});

// ── §4 — the capability contract ────────────────────────────────────

export type HarnessCapabilityId =
  | "C1_NONINTERACTIVE_PRODUCTION_ARGV"
  | "C2_STRUCTURED_STREAM_OUTPUT"
  | "C3_INIT_MODEL_IDENTITY"
  | "C4_INIT_AUTH_SOURCE"
  | "C5_INIT_TOOL_AND_MCP_REGISTRY"
  | "C6_RESULT_ACCOUNTING"
  | "C7_TOOL_CALL_EVENTS"
  | "C8_RATE_LIMIT_EVENTS"
  | "C9_TERMINATION_SUBTYPES"
  | "C10_AUTH_STATUS_JSON"
  | "C11_PRIVATE_CONFIGURATION_DIRECTORY"
  | "C12_SELF_IDENTIFICATION";

export type HarnessEvidenceKind = "OFFLINE_PROBE" | "STATIC_SCHEMA_TOKENS" | "VERSION_OUTPUT";

export interface HarnessCapabilityRequirement {
  readonly id: HarnessCapabilityId;
  readonly requirement: string;
  readonly evidence: HarnessEvidenceKind;
  /** The production code that depends on it. A requirement with no consumer is not a requirement. */
  readonly usedBy: string;
}

/**
 * Derived from the production adapter, not from a release's feature list.
 * Every entry names the code that breaks without it. Nothing here names a
 * version, an allowed list, or a minimum/maximum release.
 */
export const M220A3_HARNESS_CAPABILITIES: readonly HarnessCapabilityRequirement[] = Object.freeze([
  {
    id: "C1_NONINTERACTIVE_PRODUCTION_ARGV",
    requirement:
      "the production argv built by buildAgentArgv (-p, --output-format stream-json, --model, --max-turns, "
      + "--verbose, --allowedTools, --max-budget-usd, --strict-mcp-config, --mcp-config) is accepted "
      + "non-interactively: the offline probe emits stream events, not an option error",
    evidence: "OFFLINE_PROBE",
    usedBy: "buildAgentArgv, M216AgentAdapter.run",
  },
  {
    id: "C2_STRUCTURED_STREAM_OUTPUT",
    requirement: "stdout is newline-delimited JSON objects and carries a system/init event and a result event",
    evidence: "OFFLINE_PROBE",
    usedBy: "parseAgentStream, M216AgentAdapter.run onEvent",
  },
  {
    id: "C3_INIT_MODEL_IDENTITY",
    requirement:
      "the init event carries a non-empty `model` equal to the --model the argv selected (configured model "
      + "selection is honoured and the identity field exists; WHICH model the provider serves is still R12's "
      + "runtime decision)",
    evidence: "OFFLINE_PROBE",
    usedBy: "R12_PROVIDER_MODEL_IDENTITY via AgentRunHooks.assertProviderModelIdentity",
  },
  {
    id: "C4_INIT_AUTH_SOURCE",
    requirement: "the init event carries `apiKeySource` as a string; with no credential in a private configuration it is 'none'",
    evidence: "OFFLINE_PROBE",
    usedBy: "R16_AUTH_SOURCE via AgentRunHooks.assertAuthSource",
  },
  {
    id: "C5_INIT_TOOL_AND_MCP_REGISTRY",
    requirement:
      "the init event carries `tools` and `mcp_servers` arrays, and under --strict-mcp-config with one probe "
      + "server `mcp_servers` names exactly that server",
    evidence: "OFFLINE_PROBE",
    usedBy: "parseAgentStream registry fields; the arms' MCP isolation argv",
  },
  {
    id: "C6_RESULT_ACCOUNTING",
    requirement: "the result event carries `subtype` (string), `total_cost_usd` (number), `num_turns` (number) and `usage` (object)",
    evidence: "OFFLINE_PROBE",
    usedBy: "parseAgentStream cost/turn/token accounting, classifyTermination, the spend ceiling",
  },
  {
    id: "C7_TOOL_CALL_EVENTS",
    requirement: "the harness emits `tool_use` / `tool_result` content blocks (schema tokens present in the executable)",
    evidence: "STATIC_SCHEMA_TOKENS",
    usedBy: "parseAgentStream ordered tool telemetry, treatment-use accounting",
  },
  {
    id: "C8_RATE_LIMIT_EVENTS",
    requirement:
      "the harness emits `rate_limit_event` with `rate_limit_info` {status allowed | allowed_warning | rejected, "
      + "rateLimitType, resetsAt, utilization, isUsingOverage, overageStatus} (schema tokens present)",
    evidence: "STATIC_SCHEMA_TOKENS",
    usedBy: "parseRateLimitEvents, quotaObservationRequiresAbort (A2 pause and paid-overage abort)",
  },
  {
    id: "C9_TERMINATION_SUBTYPES",
    requirement:
      "the harness's turn-limit and budget-stop result subtypes are among the ones classifyTermination maps to "
      + "M214's frozen TURN_LIMIT_REACHED and COST_CAP_REACHED (whole tokens present)",
    evidence: "STATIC_SCHEMA_TOKENS",
    usedBy: "classifyTermination (TURN_LIMIT_RESULT_SUBTYPES, BUDGET_STOP_RESULT_SUBTYPES)",
  },
  {
    id: "C10_AUTH_STATUS_JSON",
    requirement: "`auth status --json` prints JSON carrying loggedIn (boolean), authMethod and apiProvider (strings)",
    evidence: "OFFLINE_PROBE",
    usedBy: "readCliAuthStatus (the subscription authentication preflight)",
  },
  {
    id: "C11_PRIVATE_CONFIGURATION_DIRECTORY",
    requirement:
      "CLAUDE_CONFIG_DIR is honoured: the probe's private configuration directory is written and the probe HOME "
      + "gains no .claude or .claude.json",
    evidence: "OFFLINE_PROBE",
    usedBy: "M193A constructArmEnvironment (each arm's private configuration directory)",
  },
  {
    id: "C12_SELF_IDENTIFICATION",
    requirement: "`--version` prints a version token and the init event's claude_code_version equals it",
    evidence: "VERSION_OUTPUT",
    usedBy: "A3 §5 per-session and per-attempt harness metadata",
  },
]);

/** Behaviours the benchmark needs that belong to the substrate, not to the CLI, and are therefore NOT harness requirements. */
export const M220A3_SUBSTRATE_OWNED: readonly { readonly behaviour: string; readonly owner: string }[] = Object.freeze([
  { behaviour: "process-group termination", owner: "m216_substrate_bridge.py agent.run: start_new_session + os.killpg(SIGKILL) on abort or timeout" },
  { behaviour: "wall-clock timeout", owner: "m216_substrate_bridge.py agent.run deadline (M214 wallClockTimeoutSecondsPerRun)" },
  { behaviour: "abort sentinel", owner: "m216_substrate_bridge.py watchdog polling the attempt's abort file" },
  { behaviour: "sandbox and per-attempt /tmp", owner: "m216_substrate_bridge.py bwrap prefix and M218 scratch claim" },
]);

export const M220A3_NOT_REQUIRED: readonly string[] = Object.freeze([
  "an exact Claude Code version",
  "an allowed-version list",
  "a minimum or maximum minor/patch version",
  "a versioned install path",
  "auto-update disabled (a moved symlink is now a recorded transition between pairs, or a refused second arm inside one)",
]);

// ── §9–§11 — subscription-state evidence ────────────────────────────

export type ExtraUsageEvidenceSource =
  | "LIVE_CLI_ACCOUNT_STATE"
  | "OPERATOR_ATTESTATION"
  | "CACHED_CLI_USAGE_SNAPSHOT"
  | "CACHED_ACCOUNT_PROFILE";

export const M220A3_EXTRA_USAGE_EVIDENCE: readonly {
  readonly source: ExtraUsageEvidenceSource;
  readonly scope: "USER" | "ORGANIZATION";
  readonly available: boolean;
  readonly where: string;
}[] = Object.freeze([
  {
    source: "LIVE_CLI_ACCOUNT_STATE", scope: "USER", available: false,
    where:
      "none exists with zero provider calls: `auth status --json` carries no usage-credit field, and the usage "
      + "endpoint is a network call that A3 neither invents nor makes",
  },
  {
    source: "OPERATOR_ATTESTATION", scope: "USER", available: true,
    where:
      "--attest-extra-usage-disabled / --attest-extra-usage-enabled \"<statement>\" on the invocation, appended to "
      + "the cohort's operator_attestations.jsonl with timestamp and experiment identity",
  },
  {
    source: "CACHED_CLI_USAGE_SNAPSHOT", scope: "USER", available: true,
    where:
      "~/.claude.json cachedUsageUtilization.utilization.extra_usage.is_enabled (+ fetchedAtMs, accountUuid): the "
      + "field the CLI's own 'Usage credits are off' line renders, written when the CLI fetches usage",
  },
  {
    source: "CACHED_ACCOUNT_PROFILE", scope: "ORGANIZATION", available: true,
    where:
      "~/.claude.json oauthAccount.hasExtraUsageEnabled: the CLI copies organization.has_extra_usage_enabled from the "
      + "profile endpoint (organisation-scoped). It can lag the user-level state: on 2026-09-27 it read true while the "
      + "user-level usage snapshot, fetched six minutes later, read credits OFF; by 2026-09-29 it read false",
  },
]);

export const M220A3_EXTRA_USAGE_DECISION_RULE: readonly string[] = Object.freeze([
  "user-level observations (operator attestation, CLI usage snapshot for the logged-in account) answer the question; the newest decides and a tie goes to the attestation",
  "the organisation-level profile flag decides only when no user-level observation exists: true refuses, false permits, absent refuses until attested",
  "a user-level DISABLED while the profile flag is true is reported as STALE_CACHED_EXTRA_USAGE_STATE, a warning that never blocks by itself",
  "a user-level ENABLED refuses the session, whichever source said it; no flag enables usage credits",
]);

function round(value: number): number {
  return Number(value.toFixed(6));
}

const ORDINARY_USD = round(M214_STOPPING_RULE.intendedRuns * M214_BUDGET.perRunCostCapUsd);
const RESERVE_USD = round(M214_A1_RETRY_ATTEMPTS * M214_BUDGET.perRunCostCapUsd);

/** The amendment, computed from frozen numbers and the contract above. */
export const M214_A3_AGENT_HARNESS_COMPATIBILITY = Object.freeze({
  schemaVersion: M214_A3_SCHEMA,
  amendmentId: M214_A3_AMENDMENT_ID,
  amendmentKind: "PRE_OUTCOME_AMENDMENT",
  scope: "OPERATIONAL_AGENT_HARNESS_IDENTITY_ONLY",
  parent: M214_A3_PARENT,
  lineage: Object.freeze([
    "M214 (frozen preregistration, manifest, external reference)",
    "A1 — financial retry reserve only",
    "A2 — subscription quota-window scheduling only",
    "A3 — agent-harness compatibility only",
    "launchable experiment authority = M214 + A1 + A2 + A3",
  ]),
  outcomeBearingRunsBeforeAmendment: 0,
  notOutcomeInformed: true,
  whyPermissible:
    "No outcome-bearing benchmark run has occurred. A3 changes only how the Claude Code harness is identified "
    + "and how the usage-credit state is read. It changes no task, arm, treatment, model, prompt, tool, budget, "
    + "evaluator, retry rule, analysis or stopping rule.",
  supersededRule: Object.freeze({
    m214Field: "agent.version / agent.versionPinNote",
    m214FrozenValue: M214_AGENT.version,
    previousRule: M214_AGENT.versionPinNote,
    retainedInM214Artifact: true,
    newRule:
      "the Claude Code release is operational metadata; the harness must satisfy the capability contract before "
      + "every session, and both arms of one task must run on one executable",
  }),
  harnessIdentity: Object.freeze({
    principle: "Claude Code is the agent harness, not the scientific treatment",
    declaredLauncher: M214_AGENT.binary,
    spawned: "the declared launcher path resolved to its executable at the attempt; never a versioned path chosen by the executor",
    recordedPerSessionAndAttempt: Object.freeze([
      "resolved binary path", "`--version` output", "sha256 of the executable", "capability-probe result",
    ]),
    role: "OBSERVED_OPERATIONAL_METADATA",
    notRequired: M220A3_NOT_REQUIRED,
  }),
  capabilityContract: Object.freeze({
    contractVersion: M220A3_HARNESS_CONTRACT_VERSION,
    derivedFrom: "the production agent adapter (m216ProductionAdapters) and the executor's runtime gates",
    capabilities: M220A3_HARNESS_CAPABILITIES,
    substrateOwned: M220A3_SUBSTRATE_OWNED,
    probe:
      "zero provider calls: the resolved executable runs the production argv shape with networking unshared and a private /tmp "
      + "(unshare -r -n -m) and an empty private configuration directory (no credential), plus `auth status --json` "
      + "and `--version` under the same isolation; the executable's bytes are scanned for whole schema tokens",
    whenProved: "before every quota session, and again whenever the executable's digest changes",
    onFailure: "AGENT_HARNESS_CAPABILITY_MISMATCH: the session is refused; mid-session the cohort pauses before the next row",
  }),
  pairLocalHarnessEquality: Object.freeze({
    identityKey: "sha256 of the executable actually spawned",
    rule: "both arms of one task run on one executable; the second arm's harness must equal the first arm's settled attempt's",
    onDrift:
      "PAIR_HARNESS_DRIFT: the second arm is not started, the drift is recorded, the cohort pauses; it resumes at "
      + "the same frozen row once the resolved executable is the first arm's again; the first arm is never rerun",
    spawnTimeRecheck: "the adapter re-reads the executable's digest immediately before the spawn and refuses a mismatch",
  }),
  crossSessionHarnessChanges: Object.freeze({
    permitted: true,
    condition: "the capability contract passes on the new executable, and no pair spans the change",
    recorded: "AGENT_HARNESS_TRANSITION with from/to version, path and digest",
    finalReporting: Object.freeze([
      "Claude Code versions observed", "complete pairs per version",
      "pairs crossing a harness boundary (expected 0)",
    ]),
    neverStratifiedOrTuned: true,
  }),
  modelIdentityUnchanged: Object.freeze({
    frozenModel: M214_MODEL.model,
    runtimeGate: "R12_PROVIDER_MODEL_IDENTITY",
    onDrift: "MODEL_IDENTITY_DRIFT; the session halts (COHORT_HALTED_MODEL_IDENTITY)",
    weakened: false,
  }),
  terminationSubtypeCompatibility: Object.freeze({
    frozenCategoriesUnchanged: Object.freeze(["TURN_LIMIT_REACHED", "COST_CAP_REACHED"]),
    finding:
      "every installed release from 2.1.240 to 2.1.283 emits `error_max_budget_usd` for a --max-budget-usd stop; "
      + "the classifier recognised only `error_max_budget` / `error_budget_exceeded`",
    repair: "`error_max_budget_usd` is recognised as the frozen COST_CAP_REACHED; nothing is reclassified otherwise",
  }),
  subscriptionState: Object.freeze({
    intended: "CLAUDE_MAX_SUBSCRIPTION",
    evidence: M220A3_EXTRA_USAGE_EVIDENCE,
    decisionRule: M220A3_EXTRA_USAGE_DECISION_RULE,
    staleWarning: "STALE_CACHED_EXTRA_USAGE_STATE",
    attestationMeans:
      "only that the operator checked the current Claude account UI/CLI and confirms Extra Usage / Usage Credits are OFF; "
      + "it authorises no spend, no API fallback and no G36",
    attestationRecord: "append-only, with timestamp, experiment identity and the operator's statement; no secret",
    apiKeyAndOverrideGuard: "unchanged and hard: ANTHROPIC_API_KEY and every provider override refuse the session",
    firstLiveRunConfirmation: "unchanged: R16 requires apiKeySource 'none' at initialisation, else ARM_CONFIGURATION_WRONG and the session halts",
    paidOverage: "prohibited; the in-run isUsingOverage abort is unchanged; quota exhausted means pause",
  }),
  financialEnvelopeUnchanged: Object.freeze({
    ordinaryExposureUsd: ORDINARY_USD,
    retryReserveUsd: RESERVE_USD,
    retryReserveAttempts: M214_A1_RETRY_ATTEMPTS,
    hardCeilingUsd: round(ORDINARY_USD + RESERVE_USD),
    manifestRows: M214_STOPPING_RULE.intendedRuns,
  }),
  retryEligibilityUnchanged: Object.freeze({
    rerunnable: M214_EXCLUSIONS.retryPolicy.rerunnable,
    notRerunnable: M214_EXCLUSIONS.retryPolicy.notRerunnable,
    maxAttemptsPerRun: M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun,
    newRetryClassesCreated: 0,
  }),
  newPauseReasons: Object.freeze(["PAIR_HARNESS_DRIFT", "AGENT_HARNESS_CAPABILITY_MISMATCH"]),
  unchanged: Object.freeze([
    "100 task identities", "200-row manifest", "arm assignments", "within-task arm order", "task order",
    "Baseline vs VTRACE treatment", "VTRACE HEAD:src", "provider/model target", "per-run budgets",
    "native tools", "system/task prompt construction", "authoritative evaluator", "retry rules",
    "statistical analysis", "stopping rule", "financial envelope (A1)", "quota-window scheduling (A2)",
  ]),
  spendAuthorizationStatus: "SPEND_AUTHORIZATION_PENDING",
  authorizesSpend: false,
  amendmentHashRule:
    `sha256 over "${M214_A3_AMENDMENT_ID}\\n" followed by the canonical (recursively key-sorted) JSON `
    + "of every field except amendmentHash, amendmentHashRule and generatedAt",
});

export function m214A3AmendmentHash(document: AmendmentDocument): string {
  const { amendmentHash: _hash, amendmentHashRule: _rule, generatedAt: _at, ...rest } = document;
  return createHash("sha256")
    .update(M214_A3_HASH_DOMAIN)
    .update(JSON.stringify(canonicalize(rest)))
    .digest("hex");
}

/** The frozen A3 digest. A committed amendment that does not recompute to this is not the active authority. */
export const M220A3_FROZEN_HASH =
  "e27a09cee58e7c78433cb5aa837e4bd7890cc016b6cfa5c71106482990d2e12a" as const;

export interface ExecutableAuthorityIdentityA3 {
  readonly preregistrationHash: string;
  readonly manifestHash: string;
  readonly externalReferenceHash: string;
  readonly a1AmendmentHash: string;
  readonly a2AmendmentHash: string;
  readonly a3AmendmentHash: string;
  readonly identity: string;
}

export function executableAuthorityIdentityA3(input: Omit<ExecutableAuthorityIdentityA3, "identity">): ExecutableAuthorityIdentityA3 {
  const identity = createHash("sha256")
    .update(M220A3_EXECUTABLE_AUTHORITY_DOMAIN)
    .update(JSON.stringify(canonicalize({ ...input })))
    .digest("hex");
  return { ...input, identity };
}

/** Audit an A3 document against its parents; every number is recomputed. */
export function auditA3Amendment(document: AmendmentDocument): readonly string[] {
  const issues: string[] = [];
  const get = (path: string): unknown =>
    path.split(".").reduce<unknown>((acc, key) =>
      (acc !== null && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), document);

  if (get("schemaVersion") !== M214_A3_SCHEMA) issues.push(`schemaVersion is ${String(get("schemaVersion"))}`);
  if (get("amendmentId") !== M214_A3_AMENDMENT_ID) issues.push(`amendmentId is ${String(get("amendmentId"))}`);
  if (get("amendmentKind") !== "PRE_OUTCOME_AMENDMENT") issues.push("amendmentKind is not PRE_OUTCOME_AMENDMENT");
  if (get("scope") !== "OPERATIONAL_AGENT_HARNESS_IDENTITY_ONLY") issues.push("scope is not OPERATIONAL_AGENT_HARNESS_IDENTITY_ONLY");
  if (get("outcomeBearingRunsBeforeAmendment") !== 0) issues.push("the amendment does not record 0 outcome-bearing runs before it");
  if (get("authorizesSpend") !== false) issues.push("an amendment cannot authorise spend");
  if (get("notOutcomeInformed") !== true) issues.push("the amendment does not declare itself outcome-blind");
  for (const key of Object.keys(document)) {
    if (M214_A2_FORBIDDEN_KEYS.includes(key)) {
      issues.push(`the amendment carries the frozen property '${key}'; an operational amendment may not alter it`);
    }
  }
  const parent = get("parent") as Record<string, unknown> | undefined;
  for (const [key, expected] of Object.entries(M214_A3_PARENT)) {
    if (parent?.[key] !== expected) issues.push(`parent.${key} is ${String(parent?.[key])}, the frozen value is ${expected}`);
  }
  const checks: readonly [string, unknown][] = [
    ["modelIdentityUnchanged.frozenModel", M214_MODEL.model],
    ["modelIdentityUnchanged.weakened", false],
    ["financialEnvelopeUnchanged.hardCeilingUsd", round(ORDINARY_USD + RESERVE_USD)],
    ["financialEnvelopeUnchanged.retryReserveAttempts", M214_A1_RETRY_ATTEMPTS],
    ["financialEnvelopeUnchanged.manifestRows", M214_STOPPING_RULE.intendedRuns],
    ["retryEligibilityUnchanged.maxAttemptsPerRun", M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun],
    ["retryEligibilityUnchanged.newRetryClassesCreated", 0],
    ["capabilityContract.contractVersion", M220A3_HARNESS_CONTRACT_VERSION],
    ["crossSessionHarnessChanges.neverStratifiedOrTuned", true],
    ["subscriptionState.intended", "CLAUDE_MAX_SUBSCRIPTION"],
  ];
  for (const [path, expected] of checks) {
    if (get(path) !== expected) issues.push(`${path} is ${String(get(path))}, the frozen derivation gives ${String(expected)}`);
  }
  // No capability may name a release: a contract that pins a version is the rule A3 retired.
  const capabilities = get("capabilityContract.capabilities");
  if (!Array.isArray(capabilities) || capabilities.length === 0) issues.push("the capability contract is empty");
  else if (capabilities.some((entry) => /\b\d+\.\d+\.\d+\b/.test(JSON.stringify(entry)))) {
    issues.push("a capability requirement names a release number; A3 forbids version pinning");
  }
  return Object.freeze(issues);
}

export function buildA3AmendmentDocument(generatedAt: string): AmendmentDocument {
  const body = JSON.parse(JSON.stringify(M214_A3_AGENT_HARNESS_COMPATIBILITY)) as AmendmentDocument;
  return { ...body, amendmentHash: m214A3AmendmentHash(body), generatedAt };
}

export interface A3AmendmentVerification {
  readonly recordedHash: string;
  readonly recomputedHash: string;
  readonly frozenHash: string;
  readonly auditIssues: readonly string[];
  readonly verified: boolean;
  readonly issues: readonly string[];
  readonly executableAuthority: ExecutableAuthorityIdentityA3;
}

export function verifyA3Amendment(document: AmendmentDocument): A3AmendmentVerification {
  const recorded = String(document.amendmentHash ?? "");
  const recomputed = m214A3AmendmentHash(document);
  const auditIssues = auditA3Amendment(document);
  const issues: string[] = [...auditIssues];
  if (recorded !== recomputed) issues.push(`the amendment records ${recorded || "(absent)"} but recomputes to ${recomputed}`);
  if (recomputed !== M220A3_FROZEN_HASH) issues.push(`the amendment recomputes to ${recomputed}; the frozen A3 authority is ${M220A3_FROZEN_HASH}`);
  return {
    recordedHash: recorded,
    recomputedHash: recomputed,
    frozenHash: M220A3_FROZEN_HASH,
    auditIssues,
    verified: issues.length === 0,
    issues: Object.freeze(issues),
    executableAuthority: executableAuthorityIdentityA3({
      preregistrationHash: M214_A3_PARENT.preregistrationHash,
      manifestHash: M214_A3_PARENT.manifestHash,
      externalReferenceHash: M214_A3_PARENT.externalReferenceHash,
      a1AmendmentHash: M214_A3_PARENT.a1AmendmentHash,
      a2AmendmentHash: M214_A3_PARENT.a2AmendmentHash,
      a3AmendmentHash: recomputed,
    }),
  };
}

// ── The active harness authority the launcher binds ─────────────────

export interface ActiveHarnessAmendment {
  readonly amendmentId: string;
  readonly amendmentHash: string;
  readonly a2AmendmentHash: string;
  readonly contractVersion: string;
  readonly executableAuthority: ExecutableAuthorityIdentityA3;
  readonly loadedFrom: string;
}

export function loadActiveHarnessAmendment(resultsDir: string): ActiveHarnessAmendment {
  const path = join(resultsDir, M214_A3_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `the active harness authority ${M214_A3_AMENDMENT_ID} is absent at ${path}; the executor no longer pins a `
      + "Claude Code release and refuses to run without the contract that replaced the pin",
    );
  }
  const document = JSON.parse(readFileSync(path, "utf8")) as AmendmentDocument;
  const verification = verifyA3Amendment(document);
  if (!verification.verified) {
    throw new Error(`the amendment at ${path} is not the active A3 authority: ${verification.issues.join("; ")}`);
  }
  return {
    amendmentId: M214_A3_AMENDMENT_ID,
    amendmentHash: verification.recomputedHash,
    a2AmendmentHash: M214_A3_PARENT.a2AmendmentHash,
    contractVersion: M220A3_HARNESS_CONTRACT_VERSION,
    executableAuthority: verification.executableAuthority,
    loadedFrom: path,
  };
}

/** The bound A3 must be pinned, and its parent A2/A1/M214 must be the ones the launcher bound. */
export function auditHarnessAmendmentBinding(
  authority: ActiveHarnessAmendment | undefined,
  bound: {
    readonly preregistrationHash: string;
    readonly manifestHash: string;
    readonly externalReferenceHash: string;
    readonly a1AmendmentHash: string | undefined;
    readonly a2AmendmentHash: string | undefined;
  },
): readonly string[] {
  if (authority === undefined) {
    return [`no harness authority is bound; the executable authority is M214 + A1 + A2 + ${M214_A3_AMENDMENT_ID}`];
  }
  const issues: string[] = [];
  if (authority.amendmentHash !== M220A3_FROZEN_HASH) issues.push(`bound A3 ${authority.amendmentHash} is not the frozen ${M220A3_FROZEN_HASH}`);
  if (bound.a2AmendmentHash === undefined) issues.push("A3 is bound but no A2 session authority is bound; A3's parent is A2");
  else if (authority.a2AmendmentHash !== bound.a2AmendmentHash) issues.push(`A3's parent A2 ${authority.a2AmendmentHash} differs from the bound A2 ${bound.a2AmendmentHash}`);
  const identity = authority.executableAuthority;
  if (bound.a1AmendmentHash !== undefined && identity.a1AmendmentHash !== bound.a1AmendmentHash) issues.push("A3's A1 lineage differs from the bound A1");
  if (identity.preregistrationHash !== bound.preregistrationHash) issues.push("A3's preregistration lineage differs from the verified preregistration");
  if (identity.manifestHash !== bound.manifestHash) issues.push("A3's manifest lineage differs from the verified manifest");
  if (identity.externalReferenceHash !== bound.externalReferenceHash) issues.push("A3's external-reference lineage differs from the verified reference");
  return Object.freeze(issues);
}
