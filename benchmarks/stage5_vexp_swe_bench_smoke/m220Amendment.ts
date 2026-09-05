/**
 * M220 §4 — the pre-outcome operational amendment M214_A2_SUBSCRIPTION_QUOTA_SCHEDULING.
 *
 * M214 froze the experiment; A1 added a fixed financial retry reserve. Neither
 * says anything about WHEN execution may pause between already-frozen rows,
 * because both assumed one continuous launch. The operator's real execution
 * environment is a Claude MAX subscription whose usage is metered in five-hour
 * sessions and a weekly allowance, shared with the operator's other Claude
 * Code work. A2 records, before any outcome exists, that the frozen cohort may
 * be executed in outcome-blind quota-window sessions of a bounded number of
 * frozen task pairs, with a first-class non-failure pause state between them.
 *
 * Three things the amendment is careful NOT to be.
 *
 *   * Not a rewrite of M214 or A1. Their digests are A2's PARENT and are
 *     checked, never regenerated. The executable authority becomes
 *     (M214 + A1 + A2), and a launcher that binds M214 + A1 alone no longer
 *     binds the active authority.
 *   * Not a scheduler of WHAT runs. The next pair is always the next frozen
 *     pair in manifest order; the operator chooses only how many complete pairs
 *     a session may run, and may choose that number only because no interim
 *     causal outcome is visible to them.
 *   * Not a new retry class. A subscription quota exhaustion before an
 *     authoritative outcome is a provider availability interruption and is
 *     already covered by M214's frozen MODEL_SERVICE_FAILURE class (rerunnable,
 *     max 2 attempts) and A1's slot accounting. A2 clarifies only that the
 *     permitted retry is deferred to the next quota session, which is a
 *     statement about WHEN, not about eligibility.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  M214_BUDGET,
  M214_EXCLUSIONS,
  M214_EXPERIMENT_NAME,
  M214_STOPPING_RULE,
  canonicalize,
} from "./m214Preregistration";
import {
  M214_A1_AMENDMENT_ID,
  M214_A1_FILE,
  M214_A1_PARENT,
  M214_A1_RETRY_ATTEMPTS,
  M218_FROZEN_AMENDMENT_HASH,
  type AmendmentDocument,
} from "./m218Amendment";

export const M214_A2_AMENDMENT_ID = "M214_A2_SUBSCRIPTION_QUOTA_SCHEDULING" as const;
export const M214_A2_SCHEMA = "stage5.m214-a2.pre-outcome-amendment.v1" as const;
export const M214_A2_HASH_DOMAIN = "M214_A2_SUBSCRIPTION_QUOTA_SCHEDULING\n" as const;
export const M214_A2_FILE = "stage5_m214_a2_subscription_quota_scheduling_amendment.json" as const;
export const M214_A2_HASH_FILE = "stage5_m214_a2_amendment_hash.json" as const;
export const M220_EXECUTABLE_AUTHORITY_DOMAIN = "M220_EXECUTABLE_AUTHORITY\n" as const;

/** The pause state A2 introduces. It is an executor state, not a failure, a retry or a new cohort. */
export const M220_PAUSE_STATE = "COHORT_PAUSED_QUOTA_WINDOW" as const;
export const M220_PAIR_SPLIT_MARKER = "PAIR_SPLIT_BY_QUOTA_WINDOW" as const;

/**
 * The parent identities: M214's three digests (restated exactly as A1 restates
 * them) plus A1's own pinned digest. `m220Amendment.test.ts` asserts they equal
 * the executor's and A1's frozen constants.
 */
export const M214_A2_PARENT = Object.freeze({
  experimentName: M214_EXPERIMENT_NAME,
  preregistrationFile: M214_A1_PARENT.preregistrationFile,
  preregistrationHash: M214_A1_PARENT.preregistrationHash,
  manifestFile: M214_A1_PARENT.manifestFile,
  manifestHash: M214_A1_PARENT.manifestHash,
  externalReferenceFile: M214_A1_PARENT.externalReferenceFile,
  externalReferenceHash: M214_A1_PARENT.externalReferenceHash,
  a1AmendmentId: M214_A1_AMENDMENT_ID,
  a1AmendmentFile: M214_A1_FILE,
  a1AmendmentHash: M218_FROZEN_AMENDMENT_HASH,
});

/** Reasons a session may pause. Every one is operational; none reads an outcome. */
export const M220_PERMITTED_PAUSE_REASONS: readonly string[] = Object.freeze([
  "PAIR_CAP_REACHED",
  "EXPLICIT_PAUSE_REQUEST_AFTER_PAIR",
  "EXPLICIT_PAUSE_REQUEST_AFTER_ARM",
  "SESSION_QUOTA_WARNING_OBSERVED",
  "HARD_QUOTA_LIMIT_OBSERVED",
  "WALL_CLOCK_DEADLINE",
  "OPERATOR_AVAILABILITY",
  "INFRASTRUCTURE_OR_SCRATCH_CONDITION",
]);

/** Inputs a pause decision may never read. Restated from M214's refused inputs. */
export const M220_FORBIDDEN_PAUSE_INPUTS: readonly string[] = Object.freeze([
  "Baseline success", "VTRACE success", "current pass rates", "discordant wins",
  "token savings", "cost comparison", "an interim effect size", "an interim p-value",
]);

function round(value: number): number {
  return Number(value.toFixed(6));
}

const ORDINARY_USD = round(M214_STOPPING_RULE.intendedRuns * M214_BUDGET.perRunCostCapUsd);
const RESERVE_USD = round(M214_A1_RETRY_ATTEMPTS * M214_BUDGET.perRunCostCapUsd);

/** The amendment, computed from the frozen numbers; nothing here is typed as a total. */
export const M214_A2_SUBSCRIPTION_QUOTA_SCHEDULING = Object.freeze({
  schemaVersion: M214_A2_SCHEMA,
  amendmentId: M214_A2_AMENDMENT_ID,
  amendmentKind: "PRE_OUTCOME_AMENDMENT",
  scope: "OPERATIONAL_QUOTA_WINDOW_SCHEDULING_ONLY",
  parent: M214_A2_PARENT,
  lineage: Object.freeze([
    "M214 (frozen preregistration, manifest, external reference)",
    "A1 — financial retry reserve only",
    "A2 — subscription quota-window scheduling only",
    "launchable experiment authority = M214 + A1 + A2",
  ]),
  outcomeBearingRunsBeforeAmendment: 0,
  decidedBefore: Object.freeze([
    "any outcome-bearing run",
    "any treatment result",
    "any causal result",
  ]),
  notOutcomeInformed: true,
  whyPermissible:
    "No outcome-bearing benchmark run has occurred. A2 changes only WHEN execution pauses between "
    + "already-frozen rows, never WHAT is executed, HOW outcomes are evaluated or WHICH arm receives "
    + "which treatment. The decision to pause depends only on the operator-declared session cap, "
    + "subscription/quota state, infrastructure state, scratch/disk state and explicit interruption.",
  executionModel: Object.freeze({
    executionUnit: "the next frozen task pair: both arms of one task, in the manifest's frozen arm order",
    preferredPauseBoundary: "after the complete pair",
    sessionCap:
      "an operator-declared maximum number of COMPLETE pairs per quota session (N >= 1), supplied per "
      + "session and enforced by the launcher; N is operational, may differ between sessions, and is "
      + "chosen outcome-blind because no interim causal outcome is visible to the operator",
    noPermanentSessionSize:
      "no fixed pairs-per-window capacity is asserted or hardcoded; usage depends on task complexity, "
      + "context, model, tool use and reasoning effort, so the operator starts conservatively",
    orderingRule:
      "quota scheduling consumes the existing frozen order; the next pair is always the next frozen "
      + "pair; there is no task selector, no skip and no outcome-dependent ordering",
    sessionNumbering:
      "deterministic sequential SESSION_001, SESSION_002, ...; every launcher invocation that reaches "
      + "the row loop is a new session, including a resumed invocation inside the same quota window; "
      + "session ids encode no treatment outcome",
    manualPacingAuthoritative:
      "no stable zero-call machine-readable remaining-quota API is assumed; the operator checks their "
      + "usage, chooses a conservative pair count, and the launcher enforces it. In-run structured "
      + "rate-limit events, when the CLI emits them, may only request a pause or classify an "
      + "interruption; they never select rows",
  }),
  pauseState: Object.freeze({
    marker: M220_PAUSE_STATE,
    isFailure: false,
    isRetry: false,
    isNewCohort: false,
    consumesRetryAttempt: false,
    consumesRetryReserveSlot: false,
    preserves: Object.freeze([
      "completed authoritative results", "manifest cursor", "operations ledger",
      "spend and subscription accounting", "scratch cleanliness", "continuation safety",
    ]),
    requiredBeforeReporting: Object.freeze([
      "no active coding agent", "no run-owned container", "no run-owned mount",
      "no run-owned process", "run-owned scratch cleaned and verified",
      "continuation safety proven", "authoritative evidence persisted",
    ]),
    permittedReasons: M220_PERMITTED_PAUSE_REASONS,
    forbiddenInputs: M220_FORBIDDEN_PAUSE_INPUTS,
  }),
  resume: Object.freeze({
    verifies: Object.freeze([
      "M214 + A1 + A2 identities", "manifest", "VTRACE treatment identity (HEAD:src)",
      "model target and agent identity (pinned binary version)", "image identity",
      "scratch cleanliness (stale sweep)", "continuation safety", "next frozen row/pair",
      "subscription authentication mode", "quota window reset when a hard limit was observed",
    ]),
    resumesAt: "the next unfinished authorized row in frozen order; no valid completed row is ever rerun",
    noSessionLevelReuse: Object.freeze([
      "Claude conversation", "agent context", "tool transcript", "patch", "process state",
    ]),
    eachArmRemainsAFreshAgentRun: true,
  }),
  pairSplit: Object.freeze({
    marker: M220_PAIR_SPLIT_MARKER,
    permittedOnlyWhen:
      "quota safety requires it: a hard quota limit was observed, or the operator explicitly requested "
      + "a pause after the current arm because the hard limit is known to be imminent",
    neverForConvenience: true,
    measured:
      "the time between the end of arm 1 and the start of arm 2 is recorded for every task; the "
      + "median, p90, max and the number of pairs split across quota windows are reported "
      + "descriptively, separately for BASELINE-first and VTRACE-first pairs, and never modify an outcome",
    armOrderNeverRebalanced: true,
  }),
  quotaLimits: Object.freeze({
    SESSION_QUOTA: "the five-hour session allowance (CLI rateLimitType five_hour)",
    WEEKLY_QUOTA: "the weekly allowance (CLI rateLimitType seven_day and its model-specific variants)",
    distinct: true,
    note: "a five-hour reset does not guarantee weekly capacity; either may pause a session",
  }),
  quotaInterruption: Object.freeze({
    classificationVerdict: "QUOTA_INTERRUPTION_ALREADY_COVERED_BY_FROZEN_RETRY_AUTHORITY",
    frozenClass: "MODEL_SERVICE_FAILURE",
    principle:
      "subscription quota exhaustion before an authoritative outcome = provider availability "
      + "interruption; the attempt is non-authoritative and is never a valid unresolved task",
    schedulingClarification:
      "the frozen policy already permits one retry of MODEL_SERVICE_FAILURE (maxAttemptsPerRun 2) and "
      + "A1 funds it from the fixed reserve; A2 adds only that the executor does not START that retry "
      + "inside the exhausted window: the cohort pauses, and the retry is the next authorized row of "
      + "the next session",
    retryConsumption:
      "a quota-interrupted attempt consumes one of the two permitted attempts for its cell and, when "
      + "retried, one of A1's ten retry slots; a second interruption of the same cell leaves it "
      + "unrecoverable under the frozen maximum. There are no unlimited retries because subscription "
      + "usage is not billed per token",
    detection:
      "structured evidence only: the CLI's rate_limit_event (status rejected) and its result event; "
      + "no benchmark decision is built on matching free English text",
    newRetryClassesCreated: 0,
  }),
  authenticationMode: Object.freeze({
    intended: "CLAUDE_MAX_SUBSCRIPTION",
    apiKeyBillingOverrideRefused:
      "a cohort session is refused when ANTHROPIC_API_KEY or any other documented provider override "
      + "that would switch Claude Code to pay-as-you-go authentication is present in the launcher's "
      + "environment; secrets are recorded by presence only, never by value",
    childEnvironmentConstructed:
      "each arm runs in the M193A allow-listed environment, which drops every ANTHROPIC_* and "
      + "CLAUDE_* key and copies only the CLI's own credential file into a private configuration directory",
    runtimeGate:
      "the agent's own init event must report apiKeySource 'none' (no API key in use); any other value "
      + "aborts the attempt before it can become an outcome, exactly as model identity works",
    usageCreditOverflow:
      "the executor never opts into usage credits / extra usage; a session is refused while the cached "
      + "account profile reports extra usage enabled, and an in-run structured signal that paid overage "
      + "is being used aborts the attempt as a provider availability interruption",
    usageLimitBehaviour: "pause or halt; never a prompt answered automatically with 'continue paid'",
  }),
  accounting: Object.freeze({
    subscriptionQuotaConsumption: "reported as included usage, never as $0 cost in an economic sense",
    incrementalBilledProviderSpend: "reported separately; expected $0 under subscription-only execution",
    hardCeilingUsd: round(ORDINARY_USD + RESERVE_USD),
    hardCeilingMeaning: "the maximum ADDITIONAL billed provider spend permitted if such spend ever becomes possible; kept as defence in depth",
    subscriptionHasAFixedCostOutsideTheExperiment: true,
  }),
  financialEnvelopeUnchanged: Object.freeze({
    ordinaryExposureUsd: ORDINARY_USD,
    retryReserveUsd: RESERVE_USD,
    retryReserveAttempts: M214_A1_RETRY_ATTEMPTS,
    hardCeilingUsd: round(ORDINARY_USD + RESERVE_USD),
    manifestRows: M214_STOPPING_RULE.intendedRuns,
    intendedValidOutcomes: M214_STOPPING_RULE.intendedRuns,
  }),
  retryEligibilityUnchanged: Object.freeze({
    rerunnable: M214_EXCLUSIONS.retryPolicy.rerunnable,
    notRerunnable: M214_EXCLUSIONS.retryPolicy.notRerunnable,
    maxAttemptsPerRun: M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun,
    bothAttemptsRemainInLedger: M214_EXCLUSIONS.retryPolicy.bothAttemptsRemainInLedger,
    exceptWhereExplicitlyRequired:
      "no change; the only quota-related statement is the scheduling clarification above, which "
      + "classifies a quota interruption into an existing frozen class and defers its retry",
  }),
  unchanged: Object.freeze([
    "100 task identities", "200-row manifest", "arm assignments", "within-task arm order",
    "task order", "agent", "model target", "VTRACE treatment identity", "native tools",
    "per-run reasoning/task budget", "authoritative evaluator", "primary outcome",
    "statistical analysis", "ITT semantics", "fixed-N target", "external VEXP reference",
    "retry eligibility", "financial envelope (A1)",
  ]),
  interimAnalysis:
    "a pause for a quota reset authorises no interim analysis; the finaliser continues to refuse "
    + "before the preregistered completion or halt rules are satisfied",
  spendAuthorizationStatus: "SPEND_AUTHORIZATION_PENDING",
  authorizesSpend: false,
  amendmentHashRule:
    `sha256 over "${M214_A2_AMENDMENT_ID}\\n" followed by the canonical (recursively key-sorted) JSON `
    + "of every field except amendmentHash, amendmentHashRule and generatedAt",
});

/** The domain-separated digest. `generatedAt` is excluded for M214's reason: a no-op must not move it. */
export function m214A2AmendmentHash(document: AmendmentDocument): string {
  const { amendmentHash: _hash, amendmentHashRule: _rule, generatedAt: _at, ...rest } = document;
  return createHash("sha256")
    .update(M214_A2_HASH_DOMAIN)
    .update(JSON.stringify(canonicalize(rest)))
    .digest("hex");
}

/**
 * The frozen A2 digest, pinned the way M218 pins A1's. A committed amendment
 * file that does not recompute to this value is not the active authority.
 */
export const M220_FROZEN_A2_HASH =
  "e3264880b4ec1e7242192b22b141cfb75bd28cf5475a339fbb4f37d4101e1428" as const;

/** M214 + A1 + A2, as one identity the launcher must bind before any paid row. */
export interface ExecutableAuthorityIdentityA2 {
  readonly preregistrationHash: string;
  readonly manifestHash: string;
  readonly externalReferenceHash: string;
  readonly a1AmendmentHash: string;
  readonly a2AmendmentHash: string;
  readonly identity: string;
}

export function executableAuthorityIdentityA2(input: {
  readonly preregistrationHash: string;
  readonly manifestHash: string;
  readonly externalReferenceHash: string;
  readonly a1AmendmentHash: string;
  readonly a2AmendmentHash: string;
}): ExecutableAuthorityIdentityA2 {
  const identity = createHash("sha256")
    .update(M220_EXECUTABLE_AUTHORITY_DOMAIN)
    .update(JSON.stringify(canonicalize({
      preregistrationHash: input.preregistrationHash,
      manifestHash: input.manifestHash,
      externalReferenceHash: input.externalReferenceHash,
      a1AmendmentHash: input.a1AmendmentHash,
      a2AmendmentHash: input.a2AmendmentHash,
    })))
    .digest("hex");
  return { ...input, identity };
}

/**
 * Keys that name a frozen experimental OR frozen financial property. An
 * operational amendment carrying any of them at top level is trying to change
 * something it may not touch, and is refused by name.
 */
export const M214_A2_FORBIDDEN_KEYS: readonly string[] = Object.freeze([
  "task", "tasks", "taskPopulation", "taskOrder", "instances", "instanceIds", "manifest", "rows",
  "arm", "arms", "armAllocation", "armOrders", "agent", "agentVersion", "model", "modelTarget",
  "vtraceCommit", "vtraceProductTreeSha", "treatment", "treatmentCatalog", "nativeTools", "tools",
  "budget", "maxTurns", "perRunCostCapUsd", "primaryOutcome", "primaryEstimand",
  "statisticalPlan", "analysis", "stoppingRule", "stoppingTarget", "ittPolicy", "seed",
  "randomization", "executionOrder", "externalReference", "retryPolicy", "exclusions",
  "hardCeilingUsd", "retryReserve", "ordinaryExposure", "retryReserveAttempts",
]);

/** §4 — audit an amendment document against the frozen parents; every number is recomputed. */
export function auditA2Amendment(document: AmendmentDocument): readonly string[] {
  const issues: string[] = [];
  const get = (path: string): unknown =>
    path.split(".").reduce<unknown>((acc, key) =>
      (acc !== null && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), document);

  if (get("schemaVersion") !== M214_A2_SCHEMA) issues.push(`schemaVersion is ${String(get("schemaVersion"))}`);
  if (get("amendmentId") !== M214_A2_AMENDMENT_ID) issues.push(`amendmentId is ${String(get("amendmentId"))}`);
  if (get("amendmentKind") !== "PRE_OUTCOME_AMENDMENT") issues.push("amendmentKind is not PRE_OUTCOME_AMENDMENT");
  if (get("scope") !== "OPERATIONAL_QUOTA_WINDOW_SCHEDULING_ONLY") issues.push("scope is not OPERATIONAL_QUOTA_WINDOW_SCHEDULING_ONLY");
  if (get("outcomeBearingRunsBeforeAmendment") !== 0) issues.push("the amendment does not record 0 outcome-bearing runs before it");
  if (get("authorizesSpend") !== false) issues.push("an amendment cannot authorise spend");
  if (get("notOutcomeInformed") !== true) issues.push("the amendment does not declare itself outcome-blind");

  for (const key of Object.keys(document)) {
    if (M214_A2_FORBIDDEN_KEYS.includes(key)) {
      issues.push(`the amendment carries the frozen property '${key}'; an operational amendment may not alter it`);
    }
  }

  const parent = get("parent") as Record<string, unknown> | undefined;
  for (const [key, expected] of Object.entries(M214_A2_PARENT)) {
    if (parent?.[key] !== expected) {
      issues.push(`parent.${key} is ${String(parent?.[key])}, the frozen value is ${expected}`);
    }
  }

  const checks: readonly [string, unknown][] = [
    ["pauseState.marker", M220_PAUSE_STATE],
    ["pauseState.isFailure", false],
    ["pauseState.consumesRetryAttempt", false],
    ["pauseState.consumesRetryReserveSlot", false],
    ["pairSplit.marker", M220_PAIR_SPLIT_MARKER],
    ["pairSplit.armOrderNeverRebalanced", true],
    ["quotaInterruption.classificationVerdict", "QUOTA_INTERRUPTION_ALREADY_COVERED_BY_FROZEN_RETRY_AUTHORITY"],
    ["quotaInterruption.frozenClass", "MODEL_SERVICE_FAILURE"],
    ["quotaInterruption.newRetryClassesCreated", 0],
    ["authenticationMode.intended", "CLAUDE_MAX_SUBSCRIPTION"],
    ["financialEnvelopeUnchanged.ordinaryExposureUsd", ORDINARY_USD],
    ["financialEnvelopeUnchanged.retryReserveUsd", RESERVE_USD],
    ["financialEnvelopeUnchanged.retryReserveAttempts", M214_A1_RETRY_ATTEMPTS],
    ["financialEnvelopeUnchanged.hardCeilingUsd", round(ORDINARY_USD + RESERVE_USD)],
    ["financialEnvelopeUnchanged.manifestRows", M214_STOPPING_RULE.intendedRuns],
    ["financialEnvelopeUnchanged.intendedValidOutcomes", M214_STOPPING_RULE.intendedRuns],
    ["accounting.hardCeilingUsd", round(ORDINARY_USD + RESERVE_USD)],
    ["retryEligibilityUnchanged.maxAttemptsPerRun", M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun],
    ["retryEligibilityUnchanged.bothAttemptsRemainInLedger", M214_EXCLUSIONS.retryPolicy.bothAttemptsRemainInLedger],
  ];
  for (const [path, expected] of checks) {
    if (get(path) !== expected) issues.push(`${path} is ${String(get(path))}, the frozen derivation gives ${String(expected)}`);
  }
  if (!(M214_EXCLUSIONS.retryPolicy.rerunnable as readonly string[]).includes(String(get("quotaInterruption.frozenClass")))) {
    issues.push("quotaInterruption.frozenClass is not on M214's frozen rerunnable list");
  }
  if (JSON.stringify(get("retryEligibilityUnchanged.rerunnable")) !== JSON.stringify(M214_EXCLUSIONS.retryPolicy.rerunnable)) {
    issues.push("retryEligibilityUnchanged.rerunnable differs from M214_EXCLUSIONS.retryPolicy.rerunnable");
  }
  const reasons = get("pauseState.permittedReasons");
  if (!Array.isArray(reasons) || reasons.some((reason) => /win|pass|resolved|delta|effect|p-?value|discordant|saving/i.test(String(reason)))) {
    issues.push("pauseState.permittedReasons names an outcome-shaped reason");
  }
  return Object.freeze(issues);
}

/** Build the committed document: the frozen object plus its digest and a timestamp. */
export function buildA2AmendmentDocument(generatedAt: string): AmendmentDocument {
  const body = JSON.parse(JSON.stringify(M214_A2_SUBSCRIPTION_QUOTA_SCHEDULING)) as AmendmentDocument;
  const amendmentHash = m214A2AmendmentHash(body);
  return { ...body, amendmentHash, generatedAt };
}

export interface A2AmendmentVerification {
  readonly document: AmendmentDocument;
  readonly recordedHash: string;
  readonly recomputedHash: string;
  readonly frozenHash: string;
  readonly auditIssues: readonly string[];
  readonly verified: boolean;
  readonly issues: readonly string[];
  readonly executableAuthority: ExecutableAuthorityIdentityA2;
}

/** §4, §26 — verify a committed A2: recorded, recomputed and pinned digests must agree, audit clean. */
export function verifyA2Amendment(document: AmendmentDocument): A2AmendmentVerification {
  const recorded = String(document.amendmentHash ?? "");
  const recomputed = m214A2AmendmentHash(document);
  const auditIssues = auditA2Amendment(document);
  const issues: string[] = [...auditIssues];
  if (recorded !== recomputed) issues.push(`the amendment records ${recorded || "(absent)"} but recomputes to ${recomputed}`);
  if (recomputed !== M220_FROZEN_A2_HASH) {
    issues.push(`the amendment recomputes to ${recomputed}; the frozen A2 authority is ${M220_FROZEN_A2_HASH}`);
  }
  return {
    document,
    recordedHash: recorded,
    recomputedHash: recomputed,
    frozenHash: M220_FROZEN_A2_HASH,
    auditIssues,
    verified: issues.length === 0,
    issues: Object.freeze(issues),
    executableAuthority: executableAuthorityIdentityA2({
      preregistrationHash: M214_A2_PARENT.preregistrationHash,
      manifestHash: M214_A2_PARENT.manifestHash,
      externalReferenceHash: M214_A2_PARENT.externalReferenceHash,
      a1AmendmentHash: M214_A2_PARENT.a1AmendmentHash,
      a2AmendmentHash: recomputed,
    }),
  };
}

// ── The active session authority the launcher binds ─────────────────

export const M220_SESSION_AUTHORITY_VERSION = "stage5.m220.session-authority.v1" as const;

export interface ActiveSessionAuthority {
  readonly version: typeof M220_SESSION_AUTHORITY_VERSION;
  readonly amendmentId: string;
  readonly amendmentHash: string;
  readonly a1AmendmentHash: string;
  readonly executableAuthority: ExecutableAuthorityIdentityA2;
  readonly pauseState: typeof M220_PAUSE_STATE;
  readonly pairSplitMarker: typeof M220_PAIR_SPLIT_MARKER;
  readonly quotaInterruptionClass: string;
  readonly loadedFrom: string;
}

export function activeSessionAuthorityFromDocument(document: AmendmentDocument, loadedFrom: string): ActiveSessionAuthority {
  const verification = verifyA2Amendment(document);
  if (!verification.verified) {
    throw new Error(`the amendment at ${loadedFrom} is not the active A2 authority: ${verification.issues.join("; ")}`);
  }
  return {
    version: M220_SESSION_AUTHORITY_VERSION,
    amendmentId: String(document.amendmentId),
    amendmentHash: verification.recomputedHash,
    a1AmendmentHash: M214_A2_PARENT.a1AmendmentHash,
    executableAuthority: verification.executableAuthority,
    pauseState: M220_PAUSE_STATE,
    pairSplitMarker: M220_PAIR_SPLIT_MARKER,
    quotaInterruptionClass: String((document.quotaInterruption as { frozenClass?: unknown }).frozenClass),
    loadedFrom,
  };
}

/** The launcher's path: the committed A2 beside M214's artifacts and A1. */
export function loadActiveSessionAuthority(resultsDir: string): ActiveSessionAuthority {
  const path = join(resultsDir, M214_A2_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `the active session authority ${M214_A2_AMENDMENT_ID} is absent at ${path}; launching a quota-window `
      + "session against M214 + A1 alone is refused once A2 is designated active",
    );
  }
  return activeSessionAuthorityFromDocument(JSON.parse(readFileSync(path, "utf8")) as AmendmentDocument, path);
}

/**
 * The executable authority must be M214 + A1 + A2: A2 pinned, A2's parent A1
 * equal to the BOUND A1, and the M214 lineage equal to the verified authorities.
 */
export function auditSessionAuthorityBinding(
  authority: ActiveSessionAuthority | undefined,
  bound: {
    readonly preregistrationHash: string;
    readonly manifestHash: string;
    readonly externalReferenceHash: string;
    readonly a1AmendmentHash: string | undefined;
  },
): readonly string[] {
  if (authority === undefined) {
    return [
      `no session authority is bound; a COHORT row under quota-window scheduling requires M214 + `
      + `${M214_A1_AMENDMENT_ID} + ${M214_A2_AMENDMENT_ID} (A2 ${M220_FROZEN_A2_HASH.slice(0, 16)}...)`,
    ];
  }
  const issues: string[] = [];
  if (authority.amendmentHash !== M220_FROZEN_A2_HASH) {
    issues.push(`bound A2 ${authority.amendmentHash} is not the frozen ${M220_FROZEN_A2_HASH}`);
  }
  if (bound.a1AmendmentHash === undefined) {
    issues.push("A2 is bound but no A1 spend authority is bound; A2's parent is A1");
  } else if (authority.a1AmendmentHash !== bound.a1AmendmentHash) {
    issues.push(`A2's parent A1 ${authority.a1AmendmentHash} differs from the bound A1 ${bound.a1AmendmentHash}`);
  }
  if (authority.executableAuthority.preregistrationHash !== bound.preregistrationHash) {
    issues.push("the bound session authority's preregistration lineage differs from the verified preregistration");
  }
  if (authority.executableAuthority.manifestHash !== bound.manifestHash) {
    issues.push("the bound session authority's manifest lineage differs from the verified manifest");
  }
  if (authority.executableAuthority.externalReferenceHash !== bound.externalReferenceHash) {
    issues.push("the bound session authority's external-reference lineage differs from the verified reference");
  }
  return Object.freeze(issues);
}
