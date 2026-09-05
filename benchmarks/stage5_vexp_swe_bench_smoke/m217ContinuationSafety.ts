/**
 * M217 §5–§13 — continuation safety, kept apart from result validity.
 *
 * After a row has been evaluated the executor holds two facts that M216 left
 * conflated by omission:
 *
 *   A. is this run's result authoritative?      (the RESULT ledger's business)
 *   B. is the substrate safe for the next run?  (this module's business)
 *
 * A valid result does not imply the next row may begin, and a failed teardown
 * does not un-happen an evaluation the official harness already graded. M216's
 * binding let the result stand and let the next row start regardless; this
 * module keeps the first half and supplies the second: every row's teardown is
 * followed by an ENUMERATION of what is still there, and the next row may begin
 * only when that enumeration is empty.
 *
 * Three things this module is careful not to be.
 *
 *   * Not a second scheduler. It answers one question — `CONTINUATION_SAFE` or
 *     `CONTINUATION_BLOCKED` — and the existing cohort launcher consumes it.
 *   * Not a way to rewrite a result. Events reference a result by its digest,
 *     read from the result ledger; nothing here can produce or alter a record.
 *   * Not a judgement about harmlessness. Isolation is proven by ABSENCE of
 *     residue, never by an argument that present residue would not matter. A
 *     teardown that reported an error but left nothing behind is proven; a
 *     teardown that reported success but left a container running is not.
 */

import { createHash } from "node:crypto";

import { type RunManifestRow, canonicalize } from "./m214Preregistration";

export const M217_CONTINUATION_VERSION = "stage5.m217.continuation-safety.v1" as const;
export const M217_OPERATIONS_LEDGER_SCHEMA = "stage5.m217.cohort-operations.v1" as const;
export const M217_OPERATIONS_CHAIN_DOMAIN = "M217_OPERATIONS_CHAIN\n" as const;
export const M217_OPERATIONS_CHAIN_GENESIS = "0".repeat(64);

// ── The two states ──────────────────────────────────────────────────

export type ContinuationState = "CONTINUATION_SAFE" | "CONTINUATION_BLOCKED";

/**
 * How one teardown is classified once the residue has been enumerated.
 *
 * The classification is a function of (what the adapter reported, what is
 * actually there); the second input is the one that decides continuation, and
 * the first only names the case.
 */
export type TeardownClassification =
  | "TEARDOWN_CLEAN"
  | "TEARDOWN_FAILURE_ISOLATION_PROVEN"
  | "TEARDOWN_FAILURE_ISOLATION_UNPROVEN"
  | "RESIDUAL_STATE_AFTER_REPORTED_CLEAN_TEARDOWN"
  | "ISOLATION_PROBE_FAILED";

// ── What the adapter reports ────────────────────────────────────────

export interface TeardownReport {
  /** Whether a teardown was attempted at all. */
  readonly attempted: boolean;
  /** Whether the adapter itself produced this report (false: synthesised by the executor). */
  readonly reported: boolean;
  readonly containerRemoved: boolean;
  readonly mountRemoved: boolean;
  readonly armRootRemoved: boolean;
  readonly errors: readonly string[];
  /**
   * M218 §40 — the owned-scratch lifecycle record for this attempt (path,
   * free space before, high-water, bytes after cleanup, cleanup status). Carried
   * on the teardown event; never consulted by the classifier, which reads the
   * enumeration.
   */
  readonly scratch?: Readonly<Record<string, unknown>>;
}

export function teardownReportedClean(report: TeardownReport): boolean {
  return report.attempted
    && report.reported
    && report.containerRemoved
    && report.mountRemoved
    && report.armRootRemoved
    && report.errors.length === 0;
}

export function unreportedTeardown(reason: string): TeardownReport {
  return {
    attempted: true, reported: false, containerRemoved: false, mountRemoved: false,
    armRootRemoved: false, errors: [reason],
  };
}

// ── What is actually there ──────────────────────────────────────────

export interface ResidualContainer {
  readonly name: string;
  readonly id: string;
  readonly status: string;
  readonly image: string;
}

export interface ResidualProcess {
  readonly pid: number;
  readonly cmdline: string;
}

/**
 * Where to look.
 *
 * `workRoot` is the cohort's whole scratch root and is always enumerated: the
 * cohort is sequential, so BETWEEN rows nothing of the harness should be alive
 * anywhere under it. The per-row fields sharpen the report rather than narrow
 * the search.
 */
export interface IsolationScope {
  readonly workRoot: string;
  readonly armRoot: string | null;
  readonly hostMount: string | null;
  readonly instanceId: string | null;
  readonly runId: string | null;
}

export interface ResidualStateReport {
  readonly probeVersion: string;
  readonly probedAt: string;
  readonly scope: IsolationScope;
  /** Containers carrying the harness's own resource prefix, running or not. */
  readonly harnessContainers: readonly ResidualContainer[];
  /** Containers the official evaluator creates, which it also removes. */
  readonly evaluatorContainers: readonly ResidualContainer[];
  /** Host processes whose command line references the cohort work root. */
  readonly liveProcesses: readonly ResidualProcess[];
  readonly armRootPresent: boolean;
  readonly hostMountPresent: boolean;
  /** Container handles the substrate bridge still holds open. */
  readonly openBridgeHandles: readonly string[];
  /** A probe that could not look is a probe that proves nothing. */
  readonly probeErrors: readonly string[];
  /** M218 §20 — bytes and entries still under the row's owned scratch path; absence is proven by zero of both. */
  readonly ownedScratchBytesRemaining?: number;
  readonly ownedScratchInodesRemaining?: number;
  /** M218 §19 — containers of ANY name whose bind source lies under the work root. */
  readonly containerMountReferences?: readonly { name: string; id: string; status: string; source: string }[];
}

/** One issue per piece of residue; empty means isolation is proven. */
export function residualStateIssues(report: ResidualStateReport): readonly string[] {
  const issues: string[] = [];
  for (const error of report.probeErrors) issues.push(`probe error: ${error}`);
  for (const box of report.harnessContainers) {
    issues.push(`harness container still present: ${box.name} (${box.status}, ${box.id})`);
  }
  for (const box of report.evaluatorContainers) {
    issues.push(`evaluator container still present: ${box.name} (${box.status}, ${box.id})`);
  }
  for (const proc of report.liveProcesses) {
    issues.push(`live process references the work root: pid ${proc.pid} ${proc.cmdline.slice(0, 160)}`);
  }
  if (report.armRootPresent) issues.push(`arm root still present: ${report.scope.armRoot ?? "(unknown)"}`);
  if (report.hostMountPresent) {
    issues.push(`host mount still present: ${report.scope.hostMount ?? "(unknown)"}`);
  }
  for (const handle of report.openBridgeHandles) {
    issues.push(`substrate bridge still holds container handle ${handle}`);
  }
  if ((report.ownedScratchBytesRemaining ?? 0) > 0 || (report.ownedScratchInodesRemaining ?? 0) > 0) {
    issues.push(
      `owned scratch still holds ${report.ownedScratchBytesRemaining ?? 0} bytes / `
      + `${report.ownedScratchInodesRemaining ?? 0} entries under ${report.scope.armRoot ?? "(unknown)"}`,
    );
  }
  for (const reference of report.containerMountReferences ?? []) {
    issues.push(`container ${reference.name} (${reference.status}, ${reference.id}) still binds ${reference.source}`);
  }
  return Object.freeze(issues);
}

export function residualStateIsEmpty(report: ResidualStateReport): boolean {
  return residualStateIssues(report).length === 0;
}

// ── The probe ───────────────────────────────────────────────────────

export interface RemediationReport {
  readonly actions: readonly string[];
  readonly errors: readonly string[];
}

/**
 * The only thing a substrate has to provide for continuation safety.
 *
 * `enumerate` looks; `remediate` removes exactly what `enumerate` would have
 * listed and nothing else. The predeclared recovery path is: enumerate,
 * remediate, enumerate again, and require the second enumeration to be empty.
 * Remediation never proves anything by itself.
 */
export interface IsolationProbe {
  enumerate(scope: IsolationScope): Promise<ResidualStateReport>;
  remediate(scope: IsolationScope, residual: ResidualStateReport): Promise<RemediationReport>;
}

// ── Classification ──────────────────────────────────────────────────

export interface TeardownClassificationResult {
  readonly classification: TeardownClassification;
  readonly continuation: ContinuationState;
  readonly reasons: readonly string[];
}

/**
 * §9 — classify one teardown from the report AND the enumeration.
 *
 * Not every cleanup error is the same. "No such container" from a removal that
 * had already happened leaves nothing behind and is PROVEN; a removal that
 * returned success while a container carrying the harness prefix is still
 * running is UNPROVEN however the adapter felt about it. The enumeration
 * decides; the report only names which of the two stories is being told.
 */
export function classifyTeardown(
  teardown: TeardownReport,
  residual: ResidualStateReport,
): TeardownClassificationResult {
  const residue = residualStateIssues(residual);
  const reportedClean = teardownReportedClean(teardown);

  if (residual.probeErrors.length > 0) {
    return {
      classification: "ISOLATION_PROBE_FAILED",
      continuation: "CONTINUATION_BLOCKED",
      reasons: Object.freeze([
        "the isolation probe could not enumerate the substrate, so isolation cannot be proven",
        ...residue,
      ]),
    };
  }
  if (residue.length > 0) {
    return {
      classification: reportedClean
        ? "RESIDUAL_STATE_AFTER_REPORTED_CLEAN_TEARDOWN"
        : "TEARDOWN_FAILURE_ISOLATION_UNPROVEN",
      continuation: "CONTINUATION_BLOCKED",
      reasons: Object.freeze([...residue, ...teardown.errors.map((error) => `teardown: ${error}`)]),
    };
  }
  if (reportedClean) {
    return {
      classification: "TEARDOWN_CLEAN",
      continuation: "CONTINUATION_SAFE",
      reasons: Object.freeze([]),
    };
  }
  return {
    classification: "TEARDOWN_FAILURE_ISOLATION_PROVEN",
    continuation: "CONTINUATION_SAFE",
    reasons: Object.freeze([
      "teardown reported a failure but the enumeration found no residue; isolation is proven by "
      + "absence, not by the report",
      ...teardown.errors.map((error) => `teardown: ${error}`),
    ]),
  };
}

// ── The operations ledger ───────────────────────────────────────────

export type OperationalEventKind =
  | "LAUNCH_ISOLATION_PREFLIGHT"
  | "ROW_TEARDOWN"
  | "COHORT_HALTED_ISOLATION_RISK"
  | "ISOLATION_RECOVERY_VERIFIED"
  | "ISOLATION_RECOVERY_FAILED"
  | "RETRY_RESERVE_DECISION"
  | "COHORT_HALTED_SPEND_CEILING"
  // M218 — scratch lifecycle events. The sweep and the capacity gate may
  // block; the emergency abort and the retry-reserve exhaustion record.
  | "SCRATCH_STALE_SWEEP"
  | "SCRATCH_CAPACITY_GATE"
  | "SCRATCH_EMERGENCY_ABORT"
  | "COHORT_HALTED_RETRY_RESERVE_EXHAUSTED";

/**
 * One operational event.
 *
 * `resultDigest` is the digest of the RESULT record this event is about, copied
 * from the result ledger and never computed here. That is the whole of the
 * result-immutability argument: an operational event can point at a result, and
 * cannot be anything a result reader would consult.
 */
export interface OperationalEvent {
  readonly sequence: number;
  readonly kind: OperationalEventKind;
  readonly at: string;
  readonly runId: string | null;
  readonly attemptId: string | null;
  readonly resultDigest: string | null;
  readonly continuationAfter: ContinuationState;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly previousChainDigest: string;
  readonly chainDigest: string;
}

export class ContinuationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContinuationIntegrityError";
  }
}

function eventDigest(previous: string, body: Omit<OperationalEvent, "previousChainDigest" | "chainDigest">): string {
  return createHash("sha256")
    .update(M217_OPERATIONS_CHAIN_DOMAIN)
    .update(`${previous}\n`)
    .update(JSON.stringify(canonicalize(body as unknown as Record<string, unknown>)))
    .digest("hex");
}

/**
 * Append-only, hash-chained, and the single authority for the current state.
 *
 * `state()` is the `continuationAfter` of the LAST event, so a halt is not a
 * flag someone can forget to clear and a recovery is not a flag someone can
 * set without an event that says what was verified.
 */
export class CohortOperationsLedger {
  private readonly eventsInternal: OperationalEvent[] = [];

  get events(): readonly OperationalEvent[] {
    return this.eventsInternal;
  }

  state(): ContinuationState {
    const last = this.eventsInternal[this.eventsInternal.length - 1];
    return last === undefined ? "CONTINUATION_SAFE" : last.continuationAfter;
  }

  /** The event that put the cohort in its current BLOCKED state, if any. */
  blockingEvent(): OperationalEvent | undefined {
    if (this.state() !== "CONTINUATION_BLOCKED") return undefined;
    for (let index = this.eventsInternal.length - 1; index >= 0; index -= 1) {
      const event = this.eventsInternal[index]!;
      if (event.continuationAfter !== "CONTINUATION_BLOCKED") break;
      if (event.kind === "ROW_TEARDOWN" || event.kind === "LAUNCH_ISOLATION_PREFLIGHT"
        || event.kind === "ISOLATION_RECOVERY_FAILED" || event.kind === "SCRATCH_STALE_SWEEP"
        || event.kind === "SCRATCH_CAPACITY_GATE") {
        return event;
      }
    }
    return this.eventsInternal[this.eventsInternal.length - 1];
  }

  headChainDigest(): string {
    const last = this.eventsInternal[this.eventsInternal.length - 1];
    return last === undefined ? M217_OPERATIONS_CHAIN_GENESIS : last.chainDigest;
  }

  append(
    kind: OperationalEventKind,
    at: string,
    continuationAfter: ContinuationState,
    detail: Readonly<Record<string, unknown>>,
    reference: { runId?: string | null; attemptId?: string | null; resultDigest?: string | null } = {},
  ): OperationalEvent {
    const previous = this.headChainDigest();
    const body = {
      sequence: this.eventsInternal.length,
      kind,
      at,
      runId: reference.runId ?? null,
      attemptId: reference.attemptId ?? null,
      resultDigest: reference.resultDigest ?? null,
      continuationAfter,
      detail,
    };
    const event: OperationalEvent = {
      ...body,
      previousChainDigest: previous,
      chainDigest: eventDigest(previous, body),
    };
    this.eventsInternal.push(event);
    return event;
  }

  verifyIntegrity(): readonly string[] {
    const issues: string[] = [];
    let previous = M217_OPERATIONS_CHAIN_GENESIS;
    this.eventsInternal.forEach((event, index) => {
      if (event.sequence !== index) issues.push(`operational event ${index} declares sequence ${event.sequence}`);
      if (event.previousChainDigest !== previous) issues.push(`operational chain break before event ${index}`);
      const { previousChainDigest: _p, chainDigest: _c, ...body } = event;
      if (eventDigest(event.previousChainDigest, body) !== event.chainDigest) {
        issues.push(`operational event ${index} (${event.kind}) does not recompute`);
      }
      previous = event.chainDigest;
    });
    return Object.freeze(issues);
  }

  static restore(events: readonly OperationalEvent[]): {
    readonly ledger: CohortOperationsLedger; readonly issues: readonly string[];
  } {
    const ledger = new CohortOperationsLedger();
    const issues: string[] = [];
    for (const event of events) {
      const replayed = ledger.append(event.kind, event.at, event.continuationAfter, event.detail, {
        runId: event.runId, attemptId: event.attemptId, resultDigest: event.resultDigest,
      });
      if (replayed.chainDigest !== event.chainDigest) {
        issues.push(`persisted operational event ${event.sequence} (${event.kind}) does not replay to its digest`);
      }
    }
    return { ledger, issues: Object.freeze(issues) };
  }
}

// ── The authority the launcher consumes ─────────────────────────────

export interface RowTeardownContext {
  readonly row: RunManifestRow;
  readonly attemptId: string;
  /** Read from the result ledger by the executor; null when no record was appended. */
  readonly resultDigest: string | null;
  readonly resultStatus: string | null;
  readonly scope: IsolationScope;
}

/**
 * §7 — the one authority for "may another row begin".
 *
 * `recordTeardown` is called by the executor after EVERY row, valid or not.
 * `recover` is called only by an explicit operator action, never by the
 * cohort loop: the brief's rule is no automatic continuation, and the way to
 * make that true is for the loop to have no method it could call.
 */
export class CohortOperations {
  constructor(
    readonly ledger: CohortOperationsLedger,
    readonly probe: IsolationProbe,
    readonly workRoot: string,
    readonly now: () => string,
  ) {}

  state(): ContinuationState {
    return this.ledger.state();
  }

  /** Issues for the launch gate: empty when the next row may begin. */
  auditContinuation(): readonly string[] {
    if (this.state() === "CONTINUATION_SAFE") return [];
    const blocking = this.ledger.blockingEvent();
    return [
      "COHORT_HALTED_ISOLATION_RISK: continuation is blocked"
      + (blocking === undefined
        ? ""
        : ` by operational event ${blocking.sequence} (${blocking.kind}${
          blocking.attemptId === null ? "" : ` after ${blocking.attemptId}`}): ${
          String((blocking.detail as { reasons?: unknown }).reasons ?? "no reason recorded")
            .slice(0, 400)}`)
      + ". No next manifest row may launch until the isolation condition has been remediated and "
      + "re-verified through the recovery path; there is no override.",
    ];
  }

  private scopeFor(partial: Partial<IsolationScope> = {}): IsolationScope {
    return {
      workRoot: this.workRoot,
      armRoot: partial.armRoot ?? null,
      hostMount: partial.hostMount ?? null,
      instanceId: partial.instanceId ?? null,
      runId: partial.runId ?? null,
    };
  }

  /**
   * Enumerate the whole work root. Used at launch (before the first row) and
   * as the re-verification step of recovery.
   */
  async preflight(): Promise<ResidualStateReport> {
    return this.probe.enumerate(this.scopeFor());
  }

  /** §7 — refuse to START a cohort over residue, recording what was found. */
  async recordLaunchPreflight(): Promise<OperationalEvent> {
    const residual = await this.preflight();
    const issues = residualStateIssues(residual);
    const safe = issues.length === 0;
    return this.ledger.append("LAUNCH_ISOLATION_PREFLIGHT", this.now(),
      safe ? "CONTINUATION_SAFE" : "CONTINUATION_BLOCKED",
      { residual, reasons: issues, verdict: safe ? "SUBSTRATE_CLEAN" : "RESIDUAL_STATE_BEFORE_LAUNCH" });
  }

  /**
   * §5, §11 — after a row: classify, record, and halt if unproven.
   *
   * The result is not consulted, let alone modified. Its digest is carried on
   * the event so a reader can see which result the teardown followed.
   */
  async recordTeardown(context: RowTeardownContext, teardown: TeardownReport): Promise<OperationalEvent> {
    let residual: ResidualStateReport;
    try {
      residual = await this.probe.enumerate(context.scope);
    } catch (error) {
      residual = {
        probeVersion: M217_CONTINUATION_VERSION,
        probedAt: this.now(),
        scope: context.scope,
        harnessContainers: [], evaluatorContainers: [], liveProcesses: [],
        armRootPresent: false, hostMountPresent: false, openBridgeHandles: [],
        probeErrors: [`enumeration threw: ${(error as Error).message}`],
      };
    }
    const verdict = classifyTeardown(teardown, residual);
    const reference = {
      runId: context.row.runId, attemptId: context.attemptId, resultDigest: context.resultDigest,
    };
    const event = this.ledger.append("ROW_TEARDOWN", this.now(), verdict.continuation, {
      classification: verdict.classification,
      reasons: verdict.reasons,
      teardown,
      residual,
      resultStatus: context.resultStatus,
      resultImmutable: true,
    }, reference);
    if (verdict.continuation === "CONTINUATION_BLOCKED") {
      this.ledger.append("COHORT_HALTED_ISOLATION_RISK", this.now(), "CONTINUATION_BLOCKED", {
        haltedAfter: context.attemptId,
        classification: verdict.classification,
        reasons: verdict.reasons,
        recoveryPath: M217_RECOVERY_PATH,
      }, reference);
    }
    return event;
  }

  /**
   * §12 — the predeclared recovery path, and the only way out of BLOCKED.
   *
   * enumerate → remediate → enumerate again → the second enumeration must be
   * empty. A remediation that "succeeded" but left residue is a failed
   * recovery, and the cohort stays halted.
   */
  async recover(): Promise<OperationalEvent> {
    if (this.state() !== "CONTINUATION_BLOCKED") {
      throw new ContinuationIntegrityError(
        "recovery is only defined from CONTINUATION_BLOCKED; the cohort is not halted",
      );
    }
    const blocking = this.ledger.blockingEvent();
    const scope = this.scopeFor(
      (blocking?.detail as { residual?: { scope?: Partial<IsolationScope> } } | undefined)?.residual?.scope ?? {},
    );
    const before = await this.probe.enumerate(scope);
    const remediation = await this.probe.remediate(scope, before);
    const after = await this.probe.enumerate(scope);
    const remaining = residualStateIssues(after);
    const verified = remaining.length === 0 && remediation.errors.length === 0;
    return this.ledger.append(
      verified ? "ISOLATION_RECOVERY_VERIFIED" : "ISOLATION_RECOVERY_FAILED",
      this.now(),
      verified ? "CONTINUATION_SAFE" : "CONTINUATION_BLOCKED",
      {
        recoveredFrom: blocking?.sequence ?? null,
        before, remediation, after,
        reasons: verified
          ? ["post-remediation enumeration is empty; isolation re-proven by absence"]
          : [...remaining, ...remediation.errors.map((error) => `remediation: ${error}`)],
        resumesAt: "the next unstarted manifest row in frozen order; no completed row is rerun",
      },
      { runId: blocking?.runId ?? null, attemptId: blocking?.attemptId ?? null, resultDigest: blocking?.resultDigest ?? null },
    );
  }

  /** Commit 2 — spend-side operational events; see m217RetryReserve.ts. */
  recordRetryReserve(
    reference: { runId: string; attemptId: string },
    detail: Readonly<Record<string, unknown>>,
  ): OperationalEvent {
    return this.ledger.append("RETRY_RESERVE_DECISION", this.now(), this.state(), detail, reference);
  }

  recordSpendHalt(detail: Readonly<Record<string, unknown>>): OperationalEvent {
    return this.ledger.append("COHORT_HALTED_SPEND_CEILING", this.now(), this.state(), detail);
  }

  /**
   * M218 — scratch-lifecycle events.
   *
   * A blocking sweep or capacity gate moves continuation to BLOCKED through
   * the same ledger the isolation interlock uses, so the cohort loop's one
   * check (`state()`) covers scratch state too. Recovery from a scratch block
   * is the existing predeclared path: the probe wrapper enumerates the owned
   * residue and remediates only what the registry owns.
   */
  recordScratchEvent(
    kind: "SCRATCH_STALE_SWEEP" | "SCRATCH_CAPACITY_GATE" | "SCRATCH_EMERGENCY_ABORT" | "COHORT_HALTED_RETRY_RESERVE_EXHAUSTED",
    blocking: boolean,
    detail: Readonly<Record<string, unknown>>,
    reference: { runId?: string | null; attemptId?: string | null; resultDigest?: string | null } = {},
  ): OperationalEvent {
    const after: ContinuationState = blocking ? "CONTINUATION_BLOCKED" : this.state();
    return this.ledger.append(kind, this.now(), after, detail, reference);
  }
}

/** §12 — written down once, so "recovery" cannot mean whatever was convenient. */
export const M217_RECOVERY_PATH: readonly string[] = Object.freeze([
  "the cohort loop stops; no next row is selected",
  "an operator invokes the launcher's --recover-isolation action (no other flag reaches BLOCKED state)",
  "the probe enumerates residual substrate state under the cohort work root",
  "the probe remediates exactly what it enumerated: harness containers, evaluator containers, "
  + "processes referencing the work root, the stale arm root",
  "the probe enumerates again and the second enumeration must be empty",
  "ISOLATION_RECOVERY_VERIFIED is appended and continuation returns to CONTINUATION_SAFE",
  "the operator relaunches with --resume; selectNextRow resumes at the next unstarted row in "
  + "frozen order, and a row with a valid outcome is refused rather than rerun",
]);
