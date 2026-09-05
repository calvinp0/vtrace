/**
 * M218 §3–§10 — the pre-outcome financial amendment M214_A1_RETRY_RESERVE.
 *
 * M217 wrote the fact down and made it act: 200 x $3.50 is $700, the frozen
 * ceiling is $700, so the paid retry reserve is $0 and any paid retry may make
 * fixed-N completion impossible. This module does not change that arithmetic.
 * It records a SEPARATE, separately hashed authority that adds a fixed
 * infrastructure-retry reserve on top of it, before any outcome exists:
 *
 *   original ordinary-run maximum      200 x $3.50 = $700
 *   infrastructure-retry reserve        10 x $3.50 =  $35
 *   new hard global authorisation ceiling            $735
 *
 * Three things the amendment is careful NOT to be.
 *
 *   * Not a rewrite of M214. The frozen preregistration, manifest and external
 *     reference are not touched; their digests are the amendment's PARENT and
 *     are checked, never regenerated. The executable experiment identity becomes
 *     (M214 + A1), and a launcher that verifies M214 alone no longer verifies
 *     the active authority.
 *   * Not a new retry class. The ten attempt slots are usable only for the retry
 *     classes M214 already authorised (`M214_EXCLUSIONS.retryPolicy.rerunnable`,
 *     `maxAttemptsPerRun` 2). The amendment restates them so a document that
 *     changed them would fail its own audit.
 *   * Not an estimate. 10 / 200 = 5% is an operational reserve policy chosen
 *     before any outcome-bearing run, treatment result or causal result
 *     existed; it is not a predicted failure rate and is recorded as such.
 */

import { createHash } from "node:crypto";

import {
  M214_BUDGET,
  M214_EXCLUSIONS,
  M214_EXPERIMENT_NAME,
  M214_STOPPING_RULE,
  canonicalize,
} from "./m214Preregistration";

export const M214_A1_AMENDMENT_ID = "M214_A1_RETRY_RESERVE" as const;
export const M214_A1_SCHEMA = "stage5.m214-a1.pre-outcome-amendment.v1" as const;
export const M214_A1_HASH_DOMAIN = "M214_A1_RETRY_RESERVE\n" as const;
export const M214_A1_FILE = "stage5_m214_a1_retry_reserve_amendment.json" as const;
export const M214_A1_HASH_FILE = "stage5_m214_a1_amendment_hash.json" as const;
export const M218_EXECUTABLE_AUTHORITY_DOMAIN = "M218_EXECUTABLE_AUTHORITY\n" as const;

/**
 * The parent identities, restated as literals rather than imported from the
 * executor, so this module has no import cycle with it. `m218Amendment.test.ts`
 * asserts they equal the executor's frozen constants.
 */
export const M214_A1_PARENT = Object.freeze({
  experimentName: M214_EXPERIMENT_NAME,
  preregistrationFile: "stage5_m214_preregistration.json",
  preregistrationHash: "3cd3b3d2d665c559fdb66e7274e809245e82ea7373344cf32614833b8dcbfea4",
  manifestFile: "stage5_m214_run_manifest.json",
  manifestHash: "549df54b0f48b59a2bc13da2acf27cbf2469f416d90018c3d48dd87219f77ff1",
  externalReferenceFile: "stage5_m214_external_reference.json",
  externalReferenceHash: "822c4c5fb69dc21b8ada04189e73fcadb3e5ab1bf7c06a855dd4582a6ec7834b",
});

export const M214_A1_RETRY_ATTEMPTS = 10 as const;

/** The amendment, computed from the frozen numbers; nothing here is typed as a total. */
export const M214_A1_RETRY_RESERVE = Object.freeze({
  schemaVersion: M214_A1_SCHEMA,
  amendmentId: M214_A1_AMENDMENT_ID,
  amendmentKind: "PRE_OUTCOME_AMENDMENT",
  scope: "FINANCIAL_RETRY_RESERVE_ONLY",
  parent: M214_A1_PARENT,
  lineage: Object.freeze([
    "M214 (frozen preregistration, manifest, external reference)",
    "A1 — financial retry reserve only",
    "launchable experiment authority = M214 + A1",
  ]),
  outcomeBearingRunsBeforeAmendment: 0,
  decidedBefore: Object.freeze([
    "any outcome-bearing run",
    "any treatment result",
    "any causal result",
  ]),
  notOutcomeInformed: true,
  ordinaryExposure: Object.freeze({
    intendedValidOutcomes: M214_STOPPING_RULE.intendedRuns,
    perRowCapUsd: M214_BUDGET.perRunCostCapUsd,
    usd: round(M214_STOPPING_RULE.intendedRuns * M214_BUDGET.perRunCostCapUsd),
    source: "M214_BUDGET.totalIntendedRuns x M214_BUDGET.perRunCostCapUsd; unchanged",
  }),
  retryReserve: Object.freeze({
    attempts: M214_A1_RETRY_ATTEMPTS,
    perAttemptCapUsd: M214_BUDGET.perRunCostCapUsd,
    usd: round(M214_A1_RETRY_ATTEMPTS * M214_BUDGET.perRunCostCapUsd),
    fractionOfIntendedRuns: round(M214_A1_RETRY_ATTEMPTS / M214_STOPPING_RULE.intendedRuns),
    rationale:
      "10 / 200 = 5% is an OPERATIONAL RESERVE POLICY, not an estimated expected failure rate. "
      + "The purpose is bounded resilience: a small, fixed number of infrastructure retries can be "
      + "funded without making fixed-N completion impossible. The choice was made before any "
      + "outcome-bearing run, before any treatment result and before any causal result, and "
      + "therefore cannot be treatment-outcome-driven.",
    usableOnlyFor:
      "retry classes already authorised by the frozen preregistration "
      + "(M214_EXCLUSIONS.retryPolicy.rerunnable); a retry outside those classes is refused even "
      + "while the reserve remains",
    newRetryClassesCreated: 0,
    slotAccounting:
      "a slot is consumed by every retry attempt STARTED (attempt > 1), whatever it later costs; "
      + "dollars are consumed by the retry attempt's provider-reported cost, charged at the "
      + "per-attempt cap when the provider reports none",
  }),
  hardCeilingUsd: round(
    M214_STOPPING_RULE.intendedRuns * M214_BUDGET.perRunCostCapUsd
    + M214_A1_RETRY_ATTEMPTS * M214_BUDGET.perRunCostCapUsd,
  ),
  manifestRows: M214_STOPPING_RULE.intendedRuns,
  intendedValidOutcomes: M214_STOPPING_RULE.intendedRuns,
  observationsStatement:
    "The experiment still contains 200 intended valid observations, not 210. Retries are attempts "
    + "associated with an existing manifest row, never new planned experimental rows; the same "
    + "200-row manifest remains authoritative and is not regenerated.",
  retryEligibilityUnchanged: Object.freeze({
    rerunnable: M214_EXCLUSIONS.retryPolicy.rerunnable,
    notRerunnable: M214_EXCLUSIONS.retryPolicy.notRerunnable,
    maxAttemptsPerRun: M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun,
    bothAttemptsRemainInLedger: M214_EXCLUSIONS.retryPolicy.bothAttemptsRemainInLedger,
    preregisteredInfrastructureInvalidRetriesRemainPermissible: true,
  }),
  exhaustion: Object.freeze({
    marker: "RETRY_RESERVE_EXHAUSTED",
    rule:
      "After the tenth retry attempt, or once the remaining reserve dollars cannot fund another "
      + "allowed retry at its cap, or once cumulative spend plus one attempt at cap would exceed "
      + "the hard ceiling, no further paid retry is permitted. The operator is never asked "
      + "dynamically to raise the budget; a further increase requires another explicit "
      + "preregistration amendment.",
  }),
  completionSemantics: Object.freeze({
    statement:
      "The reserve exists to improve the chance of reaching the 200 valid outcomes the frozen "
      + "fixed-N rules require. It does not redefine completion.",
    endStates: Object.freeze([
      "FIXED_N_COMPLETE",
      "HALTED_RETRY_RESERVE_EXHAUSTED",
      "HALTED_GLOBAL_SPEND_CEILING",
      "HALTED_ISOLATION_RISK",
      "other preregistered infrastructure halt",
    ]),
  }),
  unchanged: Object.freeze([
    "task population", "task order", "arm allocation", "agent", "model target",
    "VTRACE treatment identity", "native tools", "per-run budget", "primary outcome",
    "statistical analysis", "stopping target", "ITT semantics", "retry eligibility",
    "external VEXP reference",
  ]),
  supersedesInformationally:
    "M217's ZERO_RETRY_HEADROOM_RECORDED statement; M217's arithmetic remains correct for M214 "
    + "alone and is not edited",
  spendAuthorizationStatus: "SPEND_AUTHORIZATION_PENDING",
  authorizesSpend: false,
  amendmentHashRule:
    `sha256 over "${M214_A1_AMENDMENT_ID}\\n" followed by the canonical (recursively key-sorted) JSON `
    + "of every field except amendmentHash, amendmentHashRule and generatedAt",
});

export type AmendmentDocument = Record<string, unknown>;

function round(value: number): number {
  return Number(value.toFixed(6));
}

/** The domain-separated digest. `generatedAt` is excluded for M214's reason: a no-op must not move it. */
export function m214A1AmendmentHash(document: AmendmentDocument): string {
  const { amendmentHash: _hash, amendmentHashRule: _rule, generatedAt: _at, ...rest } = document;
  return createHash("sha256")
    .update(M214_A1_HASH_DOMAIN)
    .update(JSON.stringify(canonicalize(rest)))
    .digest("hex");
}

/**
 * The frozen amendment digest, pinned the way M215 pins M214's. A committed
 * amendment file that does not recompute to this value is not the active
 * authority, whatever it says about itself.
 */
export const M218_FROZEN_AMENDMENT_HASH =
  "0ed156bc924a4817122c46b5c9fc0334e5f046c2dce0547eef2573b2483b76c1" as const;

/** M214 + A1, as one identity the launcher must bind before any paid row. */
export interface ExecutableAuthorityIdentity {
  readonly preregistrationHash: string;
  readonly manifestHash: string;
  readonly externalReferenceHash: string;
  readonly amendmentHash: string;
  readonly identity: string;
}

export function executableAuthorityIdentity(input: {
  readonly preregistrationHash: string;
  readonly manifestHash: string;
  readonly externalReferenceHash: string;
  readonly amendmentHash: string;
}): ExecutableAuthorityIdentity {
  const identity = createHash("sha256")
    .update(M218_EXECUTABLE_AUTHORITY_DOMAIN)
    .update(JSON.stringify(canonicalize({
      preregistrationHash: input.preregistrationHash,
      manifestHash: input.manifestHash,
      externalReferenceHash: input.externalReferenceHash,
      amendmentHash: input.amendmentHash,
    })))
    .digest("hex");
  return { ...input, identity };
}

/**
 * Keys that name a frozen experimental property. An amendment document carrying
 * any of them at top level is trying to change something a financial amendment
 * may not touch, and is refused by name (A3).
 */
export const M214_A1_FORBIDDEN_KEYS: readonly string[] = Object.freeze([
  "task", "tasks", "taskPopulation", "taskOrder", "instances", "instanceIds", "manifest", "rows",
  "arm", "arms", "armAllocation", "armOrders", "agent", "agentVersion", "model", "modelTarget",
  "vtraceCommit", "vtraceProductTreeSha", "treatment", "treatmentCatalog", "nativeTools", "tools",
  "budget", "maxTurns", "perRunCostCapUsd", "primaryOutcome", "primaryEstimand",
  "statisticalPlan", "analysis", "stoppingRule", "stoppingTarget", "ittPolicy", "seed",
  "randomization", "executionOrder", "externalReference", "retryPolicy", "exclusions",
]);

/**
 * §4, §5, §7 — audit an amendment document against the frozen parent.
 *
 * Every number is recomputed from the frozen constants rather than trusted, and
 * the retry policy is compared field by field with M214's: an amendment that
 * quietly changed `maxAttemptsPerRun` would fail here before it could reach the
 * executor's gate.
 */
export function auditAmendment(document: AmendmentDocument): readonly string[] {
  const issues: string[] = [];
  const get = (path: string): unknown =>
    path.split(".").reduce<unknown>((acc, key) =>
      (acc !== null && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), document);

  if (get("schemaVersion") !== M214_A1_SCHEMA) issues.push(`schemaVersion is ${String(get("schemaVersion"))}`);
  if (get("amendmentId") !== M214_A1_AMENDMENT_ID) issues.push(`amendmentId is ${String(get("amendmentId"))}`);
  if (get("amendmentKind") !== "PRE_OUTCOME_AMENDMENT") issues.push("amendmentKind is not PRE_OUTCOME_AMENDMENT");
  if (get("scope") !== "FINANCIAL_RETRY_RESERVE_ONLY") issues.push("scope is not FINANCIAL_RETRY_RESERVE_ONLY");
  if (get("outcomeBearingRunsBeforeAmendment") !== 0) issues.push("the amendment does not record 0 outcome-bearing runs before it");
  if (get("authorizesSpend") !== false) issues.push("an amendment cannot authorise spend");

  for (const key of Object.keys(document)) {
    if (M214_A1_FORBIDDEN_KEYS.includes(key)) {
      issues.push(`the amendment carries the frozen experimental property '${key}'; a financial amendment may not alter it`);
    }
  }

  const parent = get("parent") as Record<string, unknown> | undefined;
  for (const [key, expected] of Object.entries(M214_A1_PARENT)) {
    if (parent?.[key] !== expected) {
      issues.push(`parent.${key} is ${String(parent?.[key])}, the frozen M214 value is ${expected}`);
    }
  }

  const rows = M214_STOPPING_RULE.intendedRuns;
  const cap = M214_BUDGET.perRunCostCapUsd;
  const attempts = M214_A1_RETRY_ATTEMPTS;
  const ordinary = round(rows * cap);
  const reserve = round(attempts * cap);
  const ceiling = round(ordinary + reserve);
  const checks: readonly [string, unknown][] = [
    ["ordinaryExposure.intendedValidOutcomes", rows],
    ["ordinaryExposure.perRowCapUsd", cap],
    ["ordinaryExposure.usd", ordinary],
    ["retryReserve.attempts", attempts],
    ["retryReserve.perAttemptCapUsd", cap],
    ["retryReserve.usd", reserve],
    ["retryReserve.newRetryClassesCreated", 0],
    ["hardCeilingUsd", ceiling],
    ["manifestRows", rows],
    ["intendedValidOutcomes", rows],
    ["retryEligibilityUnchanged.maxAttemptsPerRun", M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun],
    ["retryEligibilityUnchanged.bothAttemptsRemainInLedger", M214_EXCLUSIONS.retryPolicy.bothAttemptsRemainInLedger],
  ];
  for (const [path, expected] of checks) {
    if (get(path) !== expected) issues.push(`${path} is ${String(get(path))}, the frozen derivation gives ${String(expected)}`);
  }
  const rerunnable = get("retryEligibilityUnchanged.rerunnable");
  if (JSON.stringify(rerunnable) !== JSON.stringify(M214_EXCLUSIONS.retryPolicy.rerunnable)) {
    issues.push("retryEligibilityUnchanged.rerunnable differs from M214_EXCLUSIONS.retryPolicy.rerunnable");
  }
  if (M214_BUDGET.totalSpendCapUsd !== ordinary) {
    issues.push(`M214_BUDGET.totalSpendCapUsd ${M214_BUDGET.totalSpendCapUsd} is not the ordinary exposure ${ordinary}; the amendment's arithmetic assumes M217's identity`);
  }
  return Object.freeze(issues);
}

/** Build the committed document: the frozen object plus its digest and a timestamp. */
export function buildAmendmentDocument(generatedAt: string): AmendmentDocument {
  const body = JSON.parse(JSON.stringify(M214_A1_RETRY_RESERVE)) as AmendmentDocument;
  const amendmentHash = m214A1AmendmentHash(body);
  return { ...body, amendmentHash, generatedAt };
}

export interface AmendmentVerification {
  readonly document: AmendmentDocument;
  readonly recordedHash: string;
  readonly recomputedHash: string;
  readonly frozenHash: string;
  readonly auditIssues: readonly string[];
  readonly verified: boolean;
  readonly issues: readonly string[];
  readonly executableAuthority: ExecutableAuthorityIdentity;
}

/**
 * §6, §60 — verify a committed amendment: recorded digest, recomputed digest and
 * the pinned constant must all agree, and the audit must be clean.
 */
export function verifyAmendment(document: AmendmentDocument): AmendmentVerification {
  const recorded = String(document.amendmentHash ?? "");
  const recomputed = m214A1AmendmentHash(document);
  const auditIssues = auditAmendment(document);
  const issues: string[] = [...auditIssues];
  if (recorded !== recomputed) issues.push(`the amendment records ${recorded || "(absent)"} but recomputes to ${recomputed}`);
  if (recomputed !== M218_FROZEN_AMENDMENT_HASH) {
    issues.push(`the amendment recomputes to ${recomputed}; the frozen A1 authority is ${M218_FROZEN_AMENDMENT_HASH}`);
  }
  return {
    document,
    recordedHash: recorded,
    recomputedHash: recomputed,
    frozenHash: M218_FROZEN_AMENDMENT_HASH,
    auditIssues,
    verified: issues.length === 0,
    issues: Object.freeze(issues),
    executableAuthority: executableAuthorityIdentity({
      preregistrationHash: M214_A1_PARENT.preregistrationHash,
      manifestHash: M214_A1_PARENT.manifestHash,
      externalReferenceHash: M214_A1_PARENT.externalReferenceHash,
      amendmentHash: recomputed,
    }),
  };
}
