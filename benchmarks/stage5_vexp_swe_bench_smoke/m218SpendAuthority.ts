/**
 * M218 §8–§10, §60 — the active spend authority and the retry-reserve interlock.
 *
 * M217's P11 asks, before every attempt, whether the ceiling still admits it
 * and whether fixed-N completion is still guaranteed. Under M214 alone the
 * ceiling is $700 and the reserve is $0. Under M214 + A1 the ceiling is $735
 * and there is a fixed reserve of ten attempt slots and $35, usable only for
 * the retry classes M214 already authorised. This module:
 *
 *   * loads and verifies the committed amendment and binds it, with M214's
 *     three digests, into ONE executable authority the launcher must carry;
 *   * accounts the reserve from the result ledger (slots by attempts started,
 *     dollars by provider-reported cost) so a retry decision records the eight
 *     facts §8 names and RETRY_RESERVE_EXHAUSTED refuses the eleventh;
 *   * states the launch risk under the amended envelope.
 *
 * It creates no retry class, changes no completion rule, and asks nobody for
 * more money: the exhaustion marker is a halt, and a further increase is
 * another explicit amendment.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { M214_BUDGET, M214_EXCLUSIONS, type RunManifestRow } from "./m214Preregistration";
import type { CohortLedger, LedgerEntry } from "./m215CohortLedger";
import { isTerminalValid } from "./m215CohortLedger";
import {
  M214_A1_AMENDMENT_ID,
  M214_A1_FILE,
  M214_A1_PARENT,
  M218_FROZEN_AMENDMENT_HASH,
  type AmendmentDocument,
  type ExecutableAuthorityIdentity,
  verifyAmendment,
} from "./m218Amendment";

export const M218_SPEND_AUTHORITY_VERSION = "stage5.m218.spend-authority.v1" as const;

export interface ActiveSpendAuthority {
  readonly version: typeof M218_SPEND_AUTHORITY_VERSION;
  readonly amendmentId: string;
  readonly amendmentHash: string;
  readonly executableAuthority: ExecutableAuthorityIdentity;
  readonly ordinaryExposureUsd: number;
  readonly retryReserveUsd: number;
  readonly retryReserveAttempts: number;
  readonly perAttemptCapUsd: number;
  readonly hardCeilingUsd: number;
  readonly intendedValidOutcomes: number;
  readonly manifestRows: number;
  readonly loadedFrom: string;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

/** Build the active authority from a verified amendment document; throws on any verification issue. */
export function activeSpendAuthorityFromDocument(document: AmendmentDocument, loadedFrom: string): ActiveSpendAuthority {
  const verification = verifyAmendment(document);
  if (!verification.verified) {
    throw new Error(`the amendment at ${loadedFrom} is not the active authority: ${verification.issues.join("; ")}`);
  }
  const ordinary = document.ordinaryExposure as { usd: number };
  const reserve = document.retryReserve as { usd: number; attempts: number; perAttemptCapUsd: number };
  return {
    version: M218_SPEND_AUTHORITY_VERSION,
    amendmentId: String(document.amendmentId),
    amendmentHash: verification.recomputedHash,
    executableAuthority: verification.executableAuthority,
    ordinaryExposureUsd: ordinary.usd,
    retryReserveUsd: reserve.usd,
    retryReserveAttempts: reserve.attempts,
    perAttemptCapUsd: reserve.perAttemptCapUsd,
    hardCeilingUsd: Number(document.hardCeilingUsd),
    intendedValidOutcomes: Number(document.intendedValidOutcomes),
    manifestRows: Number(document.manifestRows),
    loadedFrom,
  };
}

/** §60 — the launcher's path: the committed amendment beside M214's artifacts. */
export function loadActiveSpendAuthority(resultsDir: string): ActiveSpendAuthority {
  const path = join(resultsDir, M214_A1_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `the active spend authority ${M214_A1_AMENDMENT_ID} is absent at ${path}; launching against the `
      + "original $700 authority alone is refused once A1 is designated active",
    );
  }
  return activeSpendAuthorityFromDocument(JSON.parse(readFileSync(path, "utf8")) as AmendmentDocument, path);
}

/**
 * §60 — the executable authority must be M214 + A1, and A1 must be the pinned
 * one. Checked against the authorities the executor verified, so a launcher
 * carrying the right amendment over the wrong manifest is refused too.
 */
export function auditExecutableAuthorityBinding(
  authority: ActiveSpendAuthority | undefined,
  frozen: { readonly preregistrationHash: string; readonly manifestHash: string; readonly externalReferenceHash: string },
): readonly string[] {
  if (authority === undefined) {
    return [
      `no executable authority is bound; a COHORT row requires M214 + ${M214_A1_AMENDMENT_ID} `
      + `(amendment ${M218_FROZEN_AMENDMENT_HASH.slice(0, 16)}...), never M214's $700 authority alone`,
    ];
  }
  const issues: string[] = [];
  if (authority.amendmentHash !== M218_FROZEN_AMENDMENT_HASH) {
    issues.push(`bound amendment ${authority.amendmentHash} is not the frozen ${M218_FROZEN_AMENDMENT_HASH}`);
  }
  if (authority.executableAuthority.preregistrationHash !== frozen.preregistrationHash) {
    issues.push("the bound authority's preregistration lineage differs from the verified preregistration");
  }
  if (authority.executableAuthority.manifestHash !== frozen.manifestHash) {
    issues.push("the bound authority's manifest lineage differs from the verified manifest");
  }
  if (authority.executableAuthority.externalReferenceHash !== frozen.externalReferenceHash) {
    issues.push("the bound authority's external-reference lineage differs from the verified reference");
  }
  if (authority.hardCeilingUsd !== round(authority.ordinaryExposureUsd + authority.retryReserveUsd)) {
    issues.push("the bound authority's ceiling is not ordinary exposure + retry reserve");
  }
  return Object.freeze(issues);
}

// ── §8 — reserve accounting from the ledger ────────────────────────

export interface RetryReserveAccounting {
  readonly retryAttemptsStarted: number;
  readonly retryAttemptsRemaining: number;
  readonly retrySpendUsd: number;
  readonly retryReserveRemainingUsd: number;
  readonly cumulativeUsd: number;
  readonly globalReserveRemainingUsd: number;
  readonly exhausted: boolean;
  readonly exhaustionReasons: readonly string[];
}

/**
 * Slots are consumed by every retry attempt STARTED (attempt > 1), whatever it
 * cost; dollars by the retry attempts' recorded cost. The reserve is exhausted
 * when no slot remains, when the remaining dollars cannot fund one more retry
 * at its cap, or when the hard ceiling cannot admit one more attempt at cap.
 */
export function retryReserveAccounting(authority: ActiveSpendAuthority, ledger: CohortLedger): RetryReserveAccounting {
  const retries = ledger.entries.filter((entry) => entry.attempt > 1);
  const started = retries.length;
  const spend = round(retries.reduce((total, entry) => total + entry.costUsd, 0));
  const cumulative = round(ledger.cumulativeSpendUsd());
  const slotsRemaining = authority.retryReserveAttempts - started;
  const dollarsRemaining = round(authority.retryReserveUsd - spend);
  const globalRemaining = round(authority.hardCeilingUsd - cumulative);
  const reasons: string[] = [];
  if (slotsRemaining < 1) reasons.push(`all ${authority.retryReserveAttempts} retry attempt slots are used`);
  if (dollarsRemaining < authority.perAttemptCapUsd) {
    reasons.push(`$${dollarsRemaining} of retry reserve remains, less than one attempt's $${authority.perAttemptCapUsd} cap`);
  }
  if (globalRemaining < authority.perAttemptCapUsd) {
    reasons.push(`$${globalRemaining} remains under the $${authority.hardCeilingUsd} hard ceiling, less than one attempt's cap`);
  }
  return {
    retryAttemptsStarted: started,
    retryAttemptsRemaining: Math.max(0, slotsRemaining),
    retrySpendUsd: spend,
    retryReserveRemainingUsd: dollarsRemaining,
    cumulativeUsd: cumulative,
    globalReserveRemainingUsd: globalRemaining,
    exhausted: reasons.length > 0,
    exhaustionReasons: Object.freeze(reasons),
  };
}

export type RetryRefusal = "RETRY_RESERVE_EXHAUSTED" | "RETRY_CLASS_NOT_PREREGISTERED" | "PRIOR_ATTEMPT_VALID" | "NO_PRIOR_ATTEMPT";

/** §8 — everything recorded for one retry decision. */
export interface RetryAdmissionRecord {
  readonly retryOrdinal: number;
  readonly parentManifestRow: {
    readonly runId: string; readonly executionOrder: number; readonly instanceId: string; readonly arm: string;
  };
  readonly attempt: number;
  readonly retryReason: string;
  readonly preregisteredRetryClass: string | null;
  readonly priorAttemptSpendUsd: number;
  readonly newAttemptMaximumExposureUsd: number;
  readonly remainingRetryReserveAttemptsAfter: number;
  readonly remainingRetryReserveUsdAfterAtCap: number;
  readonly remainingGlobalReserveUsdAfterAtCap: number;
  readonly accountingBefore: RetryReserveAccounting;
  readonly permitted: boolean;
  readonly refusal: RetryRefusal | null;
  readonly refusalDetail: string | null;
  readonly amendmentHash: string;
}

function lastAttempt(ledger: CohortLedger, row: RunManifestRow): LedgerEntry | undefined {
  const attempts = ledger.attemptsFor(row.instanceId, row.arm);
  return attempts[attempts.length - 1];
}

/**
 * Decide, and record, whether a retry of this row may begin under the reserve.
 * Returns null for a first attempt: the reserve is not consulted.
 */
export function admitRetry(
  authority: ActiveSpendAuthority, ledger: CohortLedger, row: RunManifestRow,
): RetryAdmissionRecord | null {
  const attempt = ledger.nextAttemptNumber(row.instanceId, row.arm);
  if (attempt <= 1) return null;
  const previous = lastAttempt(ledger, row);
  const accounting = retryReserveAccounting(authority, ledger);
  const cap = authority.perAttemptCapUsd;
  const base = {
    retryOrdinal: accounting.retryAttemptsStarted + 1,
    parentManifestRow: { runId: row.runId, executionOrder: row.executionOrder, instanceId: row.instanceId, arm: row.arm },
    attempt,
    retryReason: previous?.validity.reason ?? "(no prior attempt recorded)",
    preregisteredRetryClass: previous?.validity.infrastructureCategory ?? null,
    priorAttemptSpendUsd: previous?.costUsd ?? 0,
    newAttemptMaximumExposureUsd: cap,
    remainingRetryReserveAttemptsAfter: Math.max(0, accounting.retryAttemptsRemaining - 1),
    remainingRetryReserveUsdAfterAtCap: round(accounting.retryReserveRemainingUsd - cap),
    remainingGlobalReserveUsdAfterAtCap: round(accounting.globalReserveRemainingUsd - cap),
    accountingBefore: accounting,
    amendmentHash: authority.amendmentHash,
  };
  const refuse = (refusal: RetryRefusal, detail: string): RetryAdmissionRecord =>
    ({ ...base, permitted: false, refusal, refusalDetail: detail });
  if (previous === undefined) return refuse("NO_PRIOR_ATTEMPT", "attempt > 1 with no prior attempt in the ledger");
  if (isTerminalValid(previous.status)) return refuse("PRIOR_ATTEMPT_VALID", `${previous.attemptId} is a valid outcome; a valid run is never retried`);
  const category = previous.validity.infrastructureCategory;
  if (category === null || !(M214_EXCLUSIONS.retryPolicy.rerunnable as readonly string[]).includes(category)) {
    return refuse("RETRY_CLASS_NOT_PREREGISTERED",
      `${category ?? "(no category)"} is not on M214's frozen rerunnable list [${M214_EXCLUSIONS.retryPolicy.rerunnable.join(", ")}]; `
      + "the reserve funds only preregistered classes");
  }
  if (accounting.exhausted) {
    return refuse("RETRY_RESERVE_EXHAUSTED", accounting.exhaustionReasons.join("; ")
      + "; no further paid retry is permitted and the operator is not asked to raise the budget: a "
      + "further increase requires another explicit preregistration amendment");
  }
  return { ...base, permitted: true, refusal: null, refusalDetail: null };
}

/** Issues for the executor's P11 gate. */
export function auditRetryAdmission(record: RetryAdmissionRecord | null): readonly string[] {
  if (record === null || record.permitted) return [];
  return [`${record.refusal}: ${record.refusalDetail ?? ""}`];
}

// ── §61, §62 — the amended launch-risk statement ────────────────────

export interface AmendedLaunchRisk {
  readonly schemaVersion: "stage5.m218.launch-risk.v1";
  readonly amendmentId: string;
  readonly amendmentHash: string;
  readonly executableAuthorityIdentity: string;
  readonly ceilingAwaitingAuthorizationUsd: number;
  readonly ordinaryExposureUsd: number;
  readonly retryReserveUsd: number;
  readonly retryReserveAttempts: number;
  readonly perAttemptCapUsd: number;
  readonly intendedValidOutcomes: number;
  readonly manifestRows: number;
  readonly rerunnableCategories: readonly string[];
  readonly maxAttemptsPerRun: number;
  readonly exhaustionMarker: "RETRY_RESERVE_EXHAUSTED";
  readonly haltStatuses: readonly string[];
  readonly consequence: string;
  readonly spendAuthorizationStatus: "SPEND_AUTHORIZATION_PENDING";
  readonly outcomeBlind: true;
  readonly informationalOnly: true;
}

export function amendedLaunchRisk(authority: ActiveSpendAuthority): AmendedLaunchRisk {
  return {
    schemaVersion: "stage5.m218.launch-risk.v1",
    amendmentId: authority.amendmentId,
    amendmentHash: authority.amendmentHash,
    executableAuthorityIdentity: authority.executableAuthority.identity,
    ceilingAwaitingAuthorizationUsd: authority.hardCeilingUsd,
    ordinaryExposureUsd: authority.ordinaryExposureUsd,
    retryReserveUsd: authority.retryReserveUsd,
    retryReserveAttempts: authority.retryReserveAttempts,
    perAttemptCapUsd: authority.perAttemptCapUsd,
    intendedValidOutcomes: authority.intendedValidOutcomes,
    manifestRows: authority.manifestRows,
    rerunnableCategories: M214_EXCLUSIONS.retryPolicy.rerunnable,
    maxAttemptsPerRun: M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun,
    exhaustionMarker: "RETRY_RESERVE_EXHAUSTED",
    haltStatuses: ["COHORT_HALTED_ISOLATION_RISK", "COHORT_HALTED_SPEND_CEILING", "COHORT_HALTED_RETRY_RESERVE_EXHAUSTED"],
    consequence:
      `Up to ${authority.retryReserveAttempts} preregistered infrastructure retries can be funded at the `
      + `$${authority.perAttemptCapUsd} cap without making completion of all ${authority.intendedValidOutcomes} `
      + `intended runs impossible under the $${authority.hardCeilingUsd} hard ceiling. An eleventh needed retry, `
      + "or a reserve that cannot fund one more retry at cap, halts the cohort with "
      + "COHORT_HALTED_RETRY_RESERVE_EXHAUSTED; the rows that never ran stay PLANNED and the cohort is "
      + "reported as incomplete. No outcome is fabricated and no budget is raised at runtime.",
    spendAuthorizationStatus: "SPEND_AUTHORIZATION_PENDING",
    outcomeBlind: true,
    informationalOnly: true,
  };
}

export { M214_A1_PARENT, M214_BUDGET as M214_BUDGET_FOR_REFERENCE };
