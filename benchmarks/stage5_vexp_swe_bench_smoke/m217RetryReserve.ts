/**
 * M217 §14–§19 — the frozen spend arithmetic, and what zero retry headroom
 * means at the moment a retry would begin.
 *
 * M216 wrote the fact down: 200 x $3.50 is $700 and the frozen ceiling is $700,
 * so the a-priori retry reserve is $0. What it did not do is make the fact act.
 * The executor's ceiling guard asked only "can one more run fit under $700";
 * a retry that fit under the ceiling but ate the budget the LAST planned row
 * would need was silently permitted, and the cohort found out at row 200.
 *
 * This module computes, before any paid retry, the three numbers the brief
 * names — current spend, the retry's own worst case, and the worst case of
 * every remaining required attempt — and states whether fixed-N completion is
 * still guaranteed under the ceiling. It then applies the FROZEN policy to the
 * answer, and the frozen policy is recovered from M214 rather than chosen:
 *
 *   M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun = 2
 *       a rerunnable infrastructure failure is ENTITLED to a second attempt
 *   M214_EXCLUSIONS.retryPolicy.bothAttemptsRemainInLedger = true
 *       the failed attempt's cost stays in the cumulative total
 *   M214_STOPPING_RULE.budgetInterlock
 *       "The $700 total cap is an infrastructure guard, not a stopping rule.
 *        If it binds, the cohort is incomplete and is reported as incomplete."
 *
 * Nothing in M214 prefers completing first attempts over honouring a permitted
 * retry. A guard that refused the retry to protect completion would be a new
 * scheduling rule, so the frozen binding PERMITS the retry and DECLARES that
 * fixed-N completion is no longer guaranteed; the ceiling itself remains the
 * refusal that binds. The refusing branch is implemented and controlled too,
 * so a future preregistration amendment could select it without new code, but
 * it is not the binding this milestone ships.
 */

import { M214_BUDGET, M214_EXCLUSIONS, M214_STOPPING_RULE, type RunManifestRow } from "./m214Preregistration";
import { type CohortLedger, isTerminal, isTerminalValid } from "./m215CohortLedger";
import type { CohortOperationsLedger } from "./m217ContinuationSafety";

export const M217_RETRY_RESERVE_VERSION = "stage5.m217.retry-reserve.v1" as const;

// ── §14, §15 — the frozen arithmetic, recomputed ────────────────────

export interface FrozenSpendArithmetic {
  readonly plannedOrdinaryRows: number;
  readonly perRowCapUsd: number;
  readonly maximumOrdinaryExposureUsd: number;
  readonly frozenCeilingUsd: number;
  readonly retryReserveUsd: number;
  readonly maxAttemptsPerRun: number;
  readonly mathematicalMaximumUsd: number;
  /** M214_BUDGET, M214_STOPPING_RULE and the manifest agree on N. */
  readonly plannedRowsConsistent: boolean;
  readonly inconsistencies: readonly string[];
}

/** Read the frozen numbers and multiply; nothing here may be typed by hand. */
export function frozenSpendArithmetic(manifestRows?: number): FrozenSpendArithmetic {
  const planned = M214_BUDGET.totalIntendedRuns;
  const cap = M214_BUDGET.perRunCostCapUsd;
  const ceiling = M214_BUDGET.totalSpendCapUsd;
  const maximumOrdinary = round(planned * cap);
  const inconsistencies: string[] = [];
  if (planned !== M214_STOPPING_RULE.intendedRuns) {
    inconsistencies.push(
      `M214_BUDGET.totalIntendedRuns ${planned} != M214_STOPPING_RULE.intendedRuns ${M214_STOPPING_RULE.intendedRuns}`,
    );
  }
  if (M214_STOPPING_RULE.tasks * M214_STOPPING_RULE.arms !== planned) {
    inconsistencies.push(
      `${M214_STOPPING_RULE.tasks} tasks x ${M214_STOPPING_RULE.arms} arms != ${planned} planned runs`,
    );
  }
  if (manifestRows !== undefined && manifestRows !== planned) {
    inconsistencies.push(`frozen manifest has ${manifestRows} rows, budget plans ${planned}`);
  }
  return {
    plannedOrdinaryRows: planned,
    perRowCapUsd: cap,
    maximumOrdinaryExposureUsd: maximumOrdinary,
    frozenCeilingUsd: ceiling,
    retryReserveUsd: round(ceiling - maximumOrdinary),
    maxAttemptsPerRun: M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun,
    mathematicalMaximumUsd: round(planned * cap * M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun),
    plannedRowsConsistent: inconsistencies.length === 0,
    inconsistencies: Object.freeze(inconsistencies),
  };
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

// ── Which rows still need a paid attempt ────────────────────────────

/**
 * Whether one manifest row still requires an attempt for the cohort to reach
 * a valid outcome in that cell.
 *
 * Restated from M214's frozen retry policy rather than imported from the
 * executor, so this module has no import cycle with it; the test suite asserts
 * the two agree on every case.
 */
export function rowRequiresAttempt(ledger: CohortLedger, row: RunManifestRow): boolean {
  const status = ledger.statusFor(row.instanceId, row.arm);
  if (isTerminalValid(status)) return false;
  const attempts = ledger.attemptsFor(row.instanceId, row.arm);
  if (attempts.length === 0) return true;
  const last = attempts[attempts.length - 1]!;
  if (!isTerminal(last.status)) return true;
  const category = last.validity.infrastructureCategory;
  if (category === null) return false;
  if (!(M214_EXCLUSIONS.retryPolicy.rerunnable as readonly string[]).includes(category)) return false;
  return last.attempt < M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun;
}

// ── §16 — the completion reserve ────────────────────────────────────

export interface CompletionReserve {
  readonly cumulativeUsd: number;
  readonly rowsRequiringAttempt: number;
  /** Rows whose cell can no longer reach a valid outcome (attempts exhausted). */
  readonly rowsUnrecoverable: number;
  readonly perRowCapUsd: number;
  readonly completionExposureUsd: number;
  readonly projectedCompletionUsd: number;
  readonly ceilingUsd: number;
  readonly completionReserveUsd: number;
  readonly fixedNCompletionGuaranteed: boolean;
}

/**
 * How much of the ceiling is left after every remaining required attempt is
 * charged at its cap. Negative means fixed-N completion is no longer
 * guaranteed; it does not mean the ceiling has been breached.
 */
export function completionReserve(
  ledger: CohortLedger,
  manifest: readonly RunManifestRow[],
  ceilingUsd: number = M214_BUDGET.totalSpendCapUsd,
): CompletionReserve {
  const cumulative = round(ledger.cumulativeSpendUsd());
  const cap = M214_BUDGET.perRunCostCapUsd;
  let requiring = 0;
  let unrecoverable = 0;
  for (const row of manifest) {
    if (rowRequiresAttempt(ledger, row)) requiring += 1;
    else if (!isTerminalValid(ledger.statusFor(row.instanceId, row.arm))) unrecoverable += 1;
  }
  const exposure = round(requiring * cap);
  const projected = round(cumulative + exposure);
  return {
    cumulativeUsd: cumulative,
    rowsRequiringAttempt: requiring,
    rowsUnrecoverable: unrecoverable,
    perRowCapUsd: cap,
    completionExposureUsd: exposure,
    projectedCompletionUsd: projected,
    ceilingUsd,
    completionReserveUsd: round(ceilingUsd - projected),
    fixedNCompletionGuaranteed: projected <= ceilingUsd,
  };
}

// ── §16, §17 — the retry decision ───────────────────────────────────

export type RetryReservePolicy =
  | "PERMIT_RETRY_AND_DECLARE_COMPLETION_NOT_GUARANTEED"
  | "REFUSE_RETRY_WHEN_COMPLETION_RESERVE_EXCEEDED";

/** The frozen binding, and the M214 text it is read from. */
export const M217_FROZEN_RETRY_RESERVE_POLICY: RetryReservePolicy =
  "PERMIT_RETRY_AND_DECLARE_COMPLETION_NOT_GUARANTEED";

export const M217_RETRY_RESERVE_POLICY_AUTHORITY = Object.freeze({
  policy: M217_FROZEN_RETRY_RESERVE_POLICY,
  recoveredFrom: Object.freeze([
    `M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun = ${M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun}`,
    `M214_EXCLUSIONS.retryPolicy.bothAttemptsRemainInLedger = ${M214_EXCLUSIONS.retryPolicy.bothAttemptsRemainInLedger}`,
    `M214_STOPPING_RULE.budgetInterlock = ${JSON.stringify(M214_STOPPING_RULE.budgetInterlock)}`,
  ]),
  reading:
    "A rerunnable infrastructure failure is entitled to a second attempt; the failed attempt's cost "
    + "stays in the cumulative total; and if the ceiling binds the cohort is INCOMPLETE and is "
    + "reported as incomplete. M214 contains no rule that prefers completing first attempts over "
    + "honouring a permitted retry, so refusing the retry to protect completion would be a new "
    + "scheduling rule. The frozen binding therefore PERMITS a retry that fits under the ceiling and "
    + "DECLARES, mechanically and before the retry begins, that fixed-N completion is no longer "
    + "guaranteed. The ceiling itself remains the refusal that binds.",
  notInvented:
    "The refusing branch exists in code and is controlled, so a later preregistration amendment "
    + "could select it; selecting it here would be a policy decision this milestone is not "
    + "authorised to make.",
});

export type CompletionDeclaration =
  | "FIXED_N_COMPLETION_GUARANTEED"
  | "FIXED_N_COMPLETION_NOT_GUARANTEED";

export interface RetryReserveInputs {
  readonly attempt: number;
  readonly cumulativeUsd: number;
  readonly rowsRequiringAttemptExcludingThis: number;
  readonly perRowCapUsd: number;
  readonly ceilingUsd: number;
}

export interface RetryReserveDecision extends RetryReserveInputs {
  readonly isRetry: boolean;
  readonly retryExposureUsd: number;
  readonly remainingRequiredExposureUsd: number;
  readonly projectedUsd: number;
  readonly withinCeiling: boolean;
  readonly withinCompletionReserve: boolean;
  readonly consumesCompletionReserve: boolean;
  readonly completionReserveAfterUsd: number;
  readonly policy: RetryReservePolicy;
  readonly permitted: boolean;
  readonly refusalReason: string | null;
  readonly declaration: CompletionDeclaration;
}

/**
 * The pure arithmetic: current spend + this attempt's worst case + every other
 * required attempt's worst case, against the ceiling.
 *
 * A first attempt is charged the same way; `isRetry` only decides whether the
 * decision is RECORDED as a retry decision. The ceiling check
 * (`withinCeiling`) is the executor's existing P8 restated so both numbers
 * appear on one record.
 */
export function retryReserveDecision(
  input: RetryReserveInputs,
  policy: RetryReservePolicy = M217_FROZEN_RETRY_RESERVE_POLICY,
): RetryReserveDecision {
  const retryExposure = input.perRowCapUsd;
  const remaining = round(input.rowsRequiringAttemptExcludingThis * input.perRowCapUsd);
  const projected = round(input.cumulativeUsd + retryExposure + remaining);
  const withinCeiling = round(input.cumulativeUsd + retryExposure) <= input.ceilingUsd;
  const withinReserve = projected <= input.ceilingUsd;
  const isRetry = input.attempt > 1;

  let permitted = withinCeiling;
  let refusal: string | null = withinCeiling
    ? null
    : `cumulative $${input.cumulativeUsd} plus this attempt's $${retryExposure} cap would exceed the `
      + `frozen $${input.ceilingUsd} ceiling`;
  if (permitted && isRetry && !withinReserve
    && policy === "REFUSE_RETRY_WHEN_COMPLETION_RESERVE_EXCEEDED") {
    permitted = false;
    refusal =
      `paid retry (attempt ${input.attempt}) would consume the completion reserve: $${input.cumulativeUsd} `
      + `spent + $${retryExposure} retry + $${remaining} for ${input.rowsRequiringAttemptExcludingThis} `
      + `remaining required attempts = $${projected} > $${input.ceilingUsd}; policy `
      + `${policy} refuses`;
  }
  return {
    ...input,
    isRetry,
    retryExposureUsd: retryExposure,
    remainingRequiredExposureUsd: remaining,
    projectedUsd: projected,
    withinCeiling,
    withinCompletionReserve: withinReserve,
    consumesCompletionReserve: !withinReserve,
    completionReserveAfterUsd: round(input.ceilingUsd - projected),
    policy,
    permitted,
    refusalReason: refusal,
    declaration: withinReserve ? "FIXED_N_COMPLETION_GUARANTEED" : "FIXED_N_COMPLETION_NOT_GUARANTEED",
  };
}

/** Derive the inputs from the ledger and manifest for one row about to run. */
export function retryReserveDecisionFor(
  ledger: CohortLedger,
  manifest: readonly RunManifestRow[],
  row: RunManifestRow,
  policy: RetryReservePolicy = M217_FROZEN_RETRY_RESERVE_POLICY,
  ceilingUsd: number = M214_BUDGET.totalSpendCapUsd,
): RetryReserveDecision {
  const others = manifest.filter((candidate) => candidate.runId !== row.runId);
  return retryReserveDecision({
    attempt: ledger.nextAttemptNumber(row.instanceId, row.arm),
    cumulativeUsd: round(ledger.cumulativeSpendUsd()),
    rowsRequiringAttemptExcludingThis: others.filter((candidate) => rowRequiresAttempt(ledger, candidate)).length,
    perRowCapUsd: M214_BUDGET.perRunCostCapUsd,
    ceilingUsd,
  }, policy);
}

/** Issues for the executor's P11 gate: the refusal, when the policy refuses. */
export function auditRetrySpendReserve(decision: RetryReserveDecision): readonly string[] {
  return decision.permitted ? [] : [decision.refusalReason ?? "retry refused"];
}

// ── §17, §19 — the outcome-blind operational status ─────────────────

export type CohortOperationalStatus =
  | "COHORT_NOT_STARTED"
  | "COHORT_IN_PROGRESS"
  | "COHORT_HALTED_ISOLATION_RISK"
  | "COHORT_HALTED_SPEND_CEILING"
  | "EXPERIMENT_COMPLETED_FIXED_N";

export interface OperationalStatusView {
  readonly status: CohortOperationalStatus;
  readonly rowsPlanned: number;
  readonly rowsTerminal: number;
  readonly rowsRemaining: number;
  readonly rowsRequiringAttempt: number;
  readonly rowsUnrecoverable: number;
  readonly cumulativeSpendUsd: number;
  readonly maximumRemainingExposureUsd: number;
  readonly ceilingUsd: number;
  readonly completionReserveUsd: number;
  readonly fixedNCompletionGuaranteed: boolean;
  readonly continuationState: string;
  readonly haltReason: string | null;
  readonly operationalEvents: number;
}

/**
 * The status an operator sees. Completion, spend, isolation and halt reason;
 * nothing that says how either arm is doing.
 *
 * `EXPERIMENT_COMPLETED_FIXED_N` is M214's definition — every planned run has
 * reached a terminal state — and is distinct from "every pair is complete",
 * which the finaliser reports after the fact.
 */
export function cohortOperationalStatus(
  manifest: readonly RunManifestRow[],
  ledger: CohortLedger,
  operations: CohortOperationsLedger | null,
  ceilingUsd: number = M214_BUDGET.totalSpendCapUsd,
): OperationalStatusView {
  const reserve = completionReserve(ledger, manifest, ceilingUsd);
  const terminal = manifest.filter((row) => isTerminal(ledger.statusFor(row.instanceId, row.arm))).length;
  const remaining = manifest.length - terminal;
  const continuation = operations?.state() ?? "CONTINUATION_SAFE";
  const lastEvent = operations?.events[operations.events.length - 1];
  const ceilingBinds = round(reserve.cumulativeUsd + reserve.perRowCapUsd) > ceilingUsd;

  let status: CohortOperationalStatus;
  let haltReason: string | null = null;
  if (continuation === "CONTINUATION_BLOCKED") {
    status = "COHORT_HALTED_ISOLATION_RISK";
    const blocking = operations?.blockingEvent();
    haltReason = blocking === undefined
      ? "continuation blocked"
      : `${blocking.kind} at event ${blocking.sequence}: `
        + String((blocking.detail as { classification?: unknown }).classification ?? "unclassified");
  } else if (remaining === 0) {
    status = "EXPERIMENT_COMPLETED_FIXED_N";
  } else if (ceilingBinds || lastEvent?.kind === "COHORT_HALTED_SPEND_CEILING") {
    status = "COHORT_HALTED_SPEND_CEILING";
    haltReason = `the frozen $${ceilingUsd} ceiling binds: $${reserve.cumulativeUsd} spent and one more `
      + `attempt at its $${reserve.perRowCapUsd} cap cannot fit; ${remaining} planned rows remain unstarted `
      + "or unrecovered and are reported as such, never fabricated";
  } else if (ledger.entries.length === 0) {
    status = "COHORT_NOT_STARTED";
  } else {
    status = "COHORT_IN_PROGRESS";
  }
  return {
    status,
    rowsPlanned: manifest.length,
    rowsTerminal: terminal,
    rowsRemaining: remaining,
    rowsRequiringAttempt: reserve.rowsRequiringAttempt,
    rowsUnrecoverable: reserve.rowsUnrecoverable,
    cumulativeSpendUsd: reserve.cumulativeUsd,
    maximumRemainingExposureUsd: reserve.completionExposureUsd,
    ceilingUsd,
    completionReserveUsd: reserve.completionReserveUsd,
    fixedNCompletionGuaranteed: reserve.fixedNCompletionGuaranteed,
    continuationState: continuation,
    haltReason,
    operationalEvents: operations?.events.length ?? 0,
  };
}

/** §19 — words that must not appear in any key of an operational view. */
export const OUTCOME_SHAPED_KEY_PATTERN =
  /win|passRate|resolved|pValue|mcnemar|discordant|byArm|baseline|vtrace|delta|treatmentEffect/i;

export function outcomeShapedKeys(view: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(view).filter((key) => OUTCOME_SHAPED_KEY_PATTERN.test(key));
}

// ── §18 — the launch-risk statement ─────────────────────────────────

export interface LaunchRiskStatement {
  readonly schemaVersion: string;
  readonly ceilingAwaitingAuthorizationUsd: number;
  readonly spendAuthorizationStatus: "SPEND_AUTHORIZATION_PENDING";
  readonly plannedOrdinaryRows: number;
  readonly perRowCapUsd: number;
  readonly maximumPlannedExposureUsd: number;
  readonly paidRetryReserveUsd: number;
  readonly maxAttemptsPerRun: number;
  readonly rerunnableCategories: readonly string[];
  readonly consequence: string;
  readonly retryPolicyBinding: typeof M217_RETRY_RESERVE_POLICY_AUTHORITY;
  readonly haltStatuses: readonly CohortOperationalStatus[];
  readonly outcomeBlind: true;
  readonly informationalOnly: true;
}

export function launchRiskStatement(manifestRows?: number): LaunchRiskStatement {
  const arithmetic = frozenSpendArithmetic(manifestRows);
  return {
    schemaVersion: "stage5.m217.launch-risk.v1",
    ceilingAwaitingAuthorizationUsd: arithmetic.frozenCeilingUsd,
    spendAuthorizationStatus: "SPEND_AUTHORIZATION_PENDING",
    plannedOrdinaryRows: arithmetic.plannedOrdinaryRows,
    perRowCapUsd: arithmetic.perRowCapUsd,
    maximumPlannedExposureUsd: arithmetic.maximumOrdinaryExposureUsd,
    paidRetryReserveUsd: arithmetic.retryReserveUsd,
    maxAttemptsPerRun: arithmetic.maxAttemptsPerRun,
    rerunnableCategories: M214_EXCLUSIONS.retryPolicy.rerunnable,
    consequence:
      "Any infrastructure failure that consumes paid budget before a retry may make completion of "
      + `all ${arithmetic.plannedOrdinaryRows} intended runs impossible under the frozen `
      + `$${arithmetic.frozenCeilingUsd} ceiling. The executor will permit such a retry when it fits `
      + "under the ceiling, will record FIXED_N_COMPLETION_NOT_GUARANTEED before it begins, and will "
      + "halt with COHORT_HALTED_SPEND_CEILING when the ceiling binds; the rows that never ran stay "
      + "PLANNED and the cohort is reported as incomplete.",
    retryPolicyBinding: M217_RETRY_RESERVE_POLICY_AUTHORITY,
    haltStatuses: ["COHORT_HALTED_ISOLATION_RISK", "COHORT_HALTED_SPEND_CEILING"],
    outcomeBlind: true,
    informationalOnly: true,
  };
}
