/**
 * M215 §23–§25, §34–§36 — the cohort ledger.
 *
 * The executor decides what happened; this module decides what may be written
 * down and what may never be written twice. They are separate because the two
 * failure modes are different: an executor bug produces one wrong run, whereas
 * a ledger bug produces a cohort whose N nobody can state.
 *
 * Three properties are load-bearing and are asserted here rather than by
 * convention:
 *
 *   - EXACTLY ONCE. `(instanceId, arm)` may reach at most one VALID terminal
 *     state. A second one is a cohort-integrity failure, not a newer result;
 *     "latest run wins" is exactly how an unfavourable outcome gets rerun.
 *   - APPEND ONLY. A finalised record is never edited. Metadata repair appends
 *     a correction record that names the field and leaves the original bytes
 *     recoverable and still hashed.
 *   - MODE ISOLATION. A record produced in SYNTHETIC mode cannot enter the
 *     authoritative cohort ledger. The dry run that proves this machinery works
 *     must not be able to contribute an outcome to the experiment it proves.
 *
 * Integrity is a per-record sha256 plus a chain over the sequence, which is
 * enough to detect accidental mutation and reordering without pretending to be
 * a tamper-proof log against a motivated editor holding the file.
 */

import { createHash } from "node:crypto";

import { type M214Arm, canonicalize } from "./m214Preregistration";

// ── Modes ───────────────────────────────────────────────────────────

/**
 * COHORT writes authoritative outcomes; SYNTHETIC cannot, at any call site.
 *
 * A boolean `dryRun` flag would have made the safe path and the unsafe path the
 * same code with a different argument. A mode stamped into every record and
 * re-checked at the ledger boundary makes the isolation a property of the data,
 * so a synthetic record is refused even if it is handed to the real ledger.
 */
export type ExecutionMode = "COHORT" | "SYNTHETIC";

export const M215_RESULT_SCHEMA = "stage5.m215.run-result.v1" as const;
export const M215_LEDGER_SCHEMA = "stage5.m215.cohort-ledger.v1" as const;
export const M215_RESULT_HASH_DOMAIN = "M215_RUN_RESULT\n" as const;
export const M215_CHAIN_HASH_DOMAIN = "M215_LEDGER_CHAIN\n" as const;

// ── Statuses and validity ───────────────────────────────────────────

/**
 * The run lifecycle.
 *
 * `COMPLETED` is deliberately absent: it would be a state in which a reader
 * cannot tell whether the run counts. The two terminal valid states carry the
 * outcome, and the terminal invalid state carries the reason.
 */
export type RunStatus =
  | "PLANNED"
  | "STARTED"
  | "VALID_RESOLVED"
  | "VALID_UNRESOLVED"
  | "INFRASTRUCTURE_INVALID";

export const TERMINAL_VALID_STATUSES: readonly RunStatus[] =
  Object.freeze(["VALID_RESOLVED", "VALID_UNRESOLVED"] as RunStatus[]);

export function isTerminalValid(status: RunStatus): boolean {
  return TERMINAL_VALID_STATUSES.includes(status);
}

export function isTerminal(status: RunStatus): boolean {
  return isTerminalValid(status) || status === "INFRASTRUCTURE_INVALID";
}

/**
 * Why a run did or did not count.
 *
 * `infrastructureCategory` is constrained to M214's frozen exclusion list at
 * the executor boundary; the ledger records what it is told and the falsifier
 * checks that an invented category cannot get this far.
 */
export interface ValidityClassification {
  readonly status: RunStatus;
  readonly valid: boolean;
  readonly infrastructureCategory: string | null;
  readonly reason: string;
}

// ── Runtime gates (§10) ─────────────────────────────────────────────

export type RuntimeGateClass = "PREREGISTRATION" | "RUNTIME" | "INFRASTRUCTURE";

export type RuntimeGateStatus = "PASS" | "FAIL" | "NOT_APPLICABLE";

/**
 * One asserted condition, with its provenance kept.
 *
 * M214's gate table taught the lesson this schema encodes: collapsing a gate to
 * PASS/BLOCKED loses which question it answered, and a launch decision derived
 * from a table that cannot say "required" from "informational" is a launch
 * decision nobody can audit afterwards.
 */
export interface RuntimeGateRecord {
  readonly gateId: string;
  readonly gateClass: RuntimeGateClass;
  readonly required: boolean;
  readonly status: RuntimeGateStatus;
  readonly evidence: string;
  readonly failureReason: string | null;
  readonly assertedAt: string | null;
}

export function gateRecord(
  gateId: string,
  gateClass: RuntimeGateClass,
  required: boolean,
  issues: readonly string[],
  evidence: string,
  assertedAt: string | null = null,
): RuntimeGateRecord {
  return {
    gateId,
    gateClass,
    required,
    status: issues.length === 0 ? "PASS" : "FAIL",
    evidence,
    failureReason: issues.length === 0 ? null : issues.join("; "),
    assertedAt,
  };
}

/** The launch decision, derived mechanically from the required gates (§10). */
export function requiredGatesPass(gates: readonly RuntimeGateRecord[]): boolean {
  return gates.filter((entry) => entry.required).every((entry) => entry.status === "PASS");
}

// ── Ordered telemetry (§26) ─────────────────────────────────────────

export type TelemetryKind =
  | "AGENT_INIT"
  | "MODEL_IDENTITY"
  | "NATIVE_TOOL_CALL"
  | "TREATMENT_TOOL_CALL"
  | "SHELL_COMMAND"
  | "FILE_READ"
  | "EDIT"
  | "TEST_RUN"
  | "TERMINATION";

export interface TelemetryEvent {
  readonly ordinal: number;
  readonly kind: TelemetryKind;
  readonly turn: number;
  readonly name: string;
  readonly detail: string;
  readonly outputBytes: number;
  readonly latencyMs: number;
}

export type TerminationReason =
  | "AGENT_COMPLETED"
  | "TURN_LIMIT_REACHED"
  | "COST_CAP_REACHED"
  | "WALL_CLOCK_TIMEOUT"
  | "AGENT_ERROR"
  | "HARNESS_ABORT";

// ── The immutable result record (§34) ───────────────────────────────

export interface AgentIdentityRecord {
  readonly implementation: string;
  readonly binary: string;
  readonly version: string;
  readonly systemPromptSha256: string;
  readonly nativeToolCatalogSha256: string;
  readonly userPromptTemplateSha256: string;
}

export interface SourceStateRecord {
  readonly baseCommit: string;
  readonly headAtAgentStart: string;
  readonly trackedSourceDigestBeforeTreatment: string;
  readonly trackedSourceDigestAfterTreatment: string;
  readonly canonicalTrackedSourceDigest: string;
  readonly preAgentUntrackedPaths: readonly string[];
  readonly untrackedSourceAffectingPaths: readonly string[];
}

export interface ContainerIdentityRecord {
  readonly image: string;
  readonly imageDigest: string;
  readonly workingDirectory: string;
  readonly dependencyEnvironment: string;
}

export interface BudgetRecord {
  readonly identity: string;
  readonly maxTurns: number;
  readonly perRunCostCapUsd: number;
  readonly wallClockTimeoutSecondsPerRun: number;
}

export interface TreatmentTelemetryRecord {
  readonly exposed: boolean;
  readonly initialised: boolean;
  readonly catalogSha256: string | null;
  readonly firstInvocationTurn: number | null;
  readonly invokedBeforeFirstEdit: boolean;
  readonly toolNames: readonly string[];
  readonly invocationCount: number;
  readonly totalOutputBytes: number;
  readonly totalLatencyMs: number;
  readonly indexBuildSeconds: number | null;
  readonly indexSizeBytes: number | null;
}

export interface EvaluationRecord {
  readonly command: string;
  readonly evaluatorIdentity: string;
  readonly exitStatus: number;
  readonly rawResultSha256: string;
  readonly resolved: boolean;
  readonly evaluatorRan: boolean;
}

export interface EnvironmentSnapshotRecord {
  readonly pathEntries: readonly string[];
  readonly environmentVariableNames: readonly string[];
  readonly cpuLimit: string;
  readonly memoryLimit: string;
  readonly networkPolicy: string;
  readonly redactedVariableNames: readonly string[];
}

export interface RunResultRecord {
  readonly schemaVersion: typeof M215_RESULT_SCHEMA;
  readonly mode: ExecutionMode;
  readonly experimentName: string;
  readonly preregistrationHash: string;
  readonly manifestHash: string;
  readonly externalReferenceHash: string;
  readonly manifestRowId: string;
  readonly manifestRowOrdinal: number;
  readonly runId: string;
  readonly attempt: number;
  readonly attemptId: string;
  readonly instanceId: string;
  readonly repo: string;
  readonly arm: M214Arm;
  readonly pairedTaskId: string;
  readonly armOrder: readonly M214Arm[];
  readonly armOrderIndex: number;
  readonly agent: AgentIdentityRecord;
  readonly modelTarget: string;
  readonly providerModelIdentity: string | null;
  readonly modelIdentityVerified: boolean;
  readonly vtraceCommit: string | null;
  readonly vtraceProductTreeSha: string | null;
  readonly sourceState: SourceStateRecord;
  readonly container: ContainerIdentityRecord;
  readonly budgets: BudgetRecord;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly wallClockSeconds: number;
  readonly terminationReason: TerminationReason;
  readonly turnCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly costUsd: number;
  readonly treatment: TreatmentTelemetryRecord;
  readonly telemetry: readonly TelemetryEvent[];
  readonly capturedPatchSha256: string;
  readonly capturedPatchBytes: number;
  readonly capturedPatchPaths: readonly string[];
  readonly patchCaptureExclusions: readonly string[];
  readonly lifecyclePhasesObserved: readonly string[];
  readonly evaluation: EvaluationRecord | null;
  readonly environment: EnvironmentSnapshotRecord;
  readonly runtimeGates: readonly RuntimeGateRecord[];
  readonly validity: ValidityClassification;
}

/** Domain-separated digest over the whole record, canonicalised key-sorted. */
export function resultDigest(record: RunResultRecord): string {
  return createHash("sha256")
    .update(M215_RESULT_HASH_DOMAIN)
    .update(JSON.stringify(canonicalize(record as unknown as Record<string, unknown>)))
    .digest("hex");
}

// ── Run and attempt identity (§25) ──────────────────────────────────

/**
 * Run identity is deterministic; only the attempt suffix is not.
 *
 * A wall-clock id would make a resumed cohort unable to say whether a row had
 * already run, which is the same defect as having no ledger at all.
 */
export function deriveRunId(experimentName: string, instanceId: string, arm: M214Arm): string {
  return `${experimentName}:${instanceId}:${arm}`;
}

export function deriveAttemptId(runId: string, ordinal: number, attempt: number): string {
  const seed = createHash("sha256").update(`${runId}#${ordinal}#${attempt}`).digest("hex").slice(0, 12);
  return `${runId}#a${attempt}#${seed}`;
}

// ── Ledger entries ──────────────────────────────────────────────────

export interface LedgerEntry {
  readonly sequence: number;
  readonly mode: ExecutionMode;
  readonly attemptId: string;
  readonly runId: string;
  readonly manifestRowOrdinal: number;
  readonly instanceId: string;
  readonly arm: M214Arm;
  readonly attempt: number;
  readonly status: RunStatus;
  readonly validity: ValidityClassification;
  readonly costUsd: number;
  readonly resultDigest: string;
  readonly previousChainDigest: string;
  readonly chainDigest: string;
  readonly recordedAt: string;
}

export interface CorrectionRecord {
  readonly sequence: number;
  readonly attemptId: string;
  readonly field: string;
  readonly note: string;
  readonly appendedAt: string;
  readonly originalResultDigest: string;
}

export const LEDGER_CHAIN_GENESIS = "0".repeat(64);

export function chainDigest(previous: string, digest: string): string {
  return createHash("sha256")
    .update(M215_CHAIN_HASH_DOMAIN)
    .update(`${previous}\n${digest}`)
    .digest("hex");
}

export class CohortIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CohortIntegrityError";
  }
}

/**
 * The append-only ledger for one cohort.
 *
 * Held in memory and serialised by the caller; persistence format is the
 * caller's business, exactly-once is not.
 */
export class CohortLedger {
  private readonly entriesInternal: LedgerEntry[] = [];
  private readonly recordsInternal = new Map<string, RunResultRecord>();
  private readonly correctionsInternal: CorrectionRecord[] = [];

  constructor(
    readonly mode: ExecutionMode,
    readonly preregistrationHash: string,
    readonly manifestHash: string,
  ) {}

  get entries(): readonly LedgerEntry[] {
    return this.entriesInternal;
  }

  get corrections(): readonly CorrectionRecord[] {
    return this.correctionsInternal;
  }

  record(attemptId: string): RunResultRecord | undefined {
    return this.recordsInternal.get(attemptId);
  }

  get records(): readonly RunResultRecord[] {
    return [...this.recordsInternal.values()];
  }

  private key(instanceId: string, arm: M214Arm): string {
    return `${instanceId} ${arm}`;
  }

  /** Every attempt already written for one manifest row, in order. */
  attemptsFor(instanceId: string, arm: M214Arm): readonly LedgerEntry[] {
    const key = this.key(instanceId, arm);
    return this.entriesInternal.filter((entry) => this.key(entry.instanceId, entry.arm) === key);
  }

  validOutcomeFor(instanceId: string, arm: M214Arm): LedgerEntry | undefined {
    return this.attemptsFor(instanceId, arm).find((entry) => isTerminalValid(entry.status));
  }

  statusFor(instanceId: string, arm: M214Arm): RunStatus {
    const attempts = this.attemptsFor(instanceId, arm);
    const valid = attempts.find((entry) => isTerminalValid(entry.status));
    if (valid !== undefined) return valid.status;
    if (attempts.length === 0) return "PLANNED";
    return attempts[attempts.length - 1]!.status;
  }

  nextAttemptNumber(instanceId: string, arm: M214Arm): number {
    return this.attemptsFor(instanceId, arm).length + 1;
  }

  /**
   * Append one finalised result.
   *
   * Every refusal below is a cohort-integrity failure rather than a warning,
   * because each one leaves an N that cannot be stated: a synthetic outcome
   * among real ones, two outcomes for one cell, or a record whose declared
   * identity is not this cohort's.
   */
  append(record: RunResultRecord, recordedAt: string): LedgerEntry {
    if (record.mode !== this.mode) {
      throw new CohortIntegrityError(
        `refusing a ${record.mode} result in a ${this.mode} ledger: ${record.attemptId}`,
      );
    }
    if (record.preregistrationHash !== this.preregistrationHash) {
      throw new CohortIntegrityError(
        `result ${record.attemptId} declares preregistration ${record.preregistrationHash}, `
        + `cohort is ${this.preregistrationHash}`,
      );
    }
    if (record.manifestHash !== this.manifestHash) {
      throw new CohortIntegrityError(
        `result ${record.attemptId} declares manifest ${record.manifestHash}, `
        + `cohort is ${this.manifestHash}`,
      );
    }
    if (this.recordsInternal.has(record.attemptId)) {
      throw new CohortIntegrityError(`attempt already recorded: ${record.attemptId}`);
    }
    if (isTerminalValid(record.validity.status)) {
      const existing = this.validOutcomeFor(record.instanceId, record.arm);
      if (existing !== undefined) {
        throw new CohortIntegrityError(
          `duplicate valid outcome for (${record.instanceId}, ${record.arm}): `
          + `${existing.attemptId} already valid, refusing ${record.attemptId}`,
        );
      }
    }
    const digest = resultDigest(record);
    const previous = this.entriesInternal.length === 0
      ? LEDGER_CHAIN_GENESIS
      : this.entriesInternal[this.entriesInternal.length - 1]!.chainDigest;
    const entry: LedgerEntry = {
      sequence: this.entriesInternal.length,
      mode: record.mode,
      attemptId: record.attemptId,
      runId: record.runId,
      manifestRowOrdinal: record.manifestRowOrdinal,
      instanceId: record.instanceId,
      arm: record.arm,
      attempt: record.attempt,
      status: record.validity.status,
      validity: record.validity,
      costUsd: record.costUsd,
      resultDigest: digest,
      previousChainDigest: previous,
      chainDigest: chainDigest(previous, digest),
      recordedAt,
    };
    this.entriesInternal.push(entry);
    this.recordsInternal.set(record.attemptId, record);
    return entry;
  }

  /**
   * §35 — repair metadata without touching the original.
   *
   * The correction names the field and keeps the superseded digest, so the raw
   * outcome stays recoverable and a reader can see that a repair happened
   * rather than finding a record that quietly disagrees with its own hash.
   */
  appendCorrection(
    attemptId: string,
    field: string,
    note: string,
    appendedAt: string,
  ): CorrectionRecord {
    const entry = this.entriesInternal.find((candidate) => candidate.attemptId === attemptId);
    if (entry === undefined) {
      throw new CohortIntegrityError(`cannot correct an unknown attempt: ${attemptId}`);
    }
    const correction: CorrectionRecord = {
      sequence: this.correctionsInternal.length,
      attemptId,
      field,
      note,
      appendedAt,
      originalResultDigest: entry.resultDigest,
    };
    this.correctionsInternal.push(correction);
    return correction;
  }

  /** §36 — recompute every digest and the chain over them. */
  verifyIntegrity(): readonly string[] {
    const issues: string[] = [];
    let previous = LEDGER_CHAIN_GENESIS;
    this.entriesInternal.forEach((entry, index) => {
      if (entry.sequence !== index) {
        issues.push(`ledger entry ${index} declares sequence ${entry.sequence}`);
      }
      const record = this.recordsInternal.get(entry.attemptId);
      if (record === undefined) {
        issues.push(`ledger entry ${entry.attemptId} has no result record`);
        return;
      }
      const digest = resultDigest(record);
      if (digest !== entry.resultDigest) {
        issues.push(
          `result bytes for ${entry.attemptId} no longer hash to the recorded digest: `
          + `${entry.resultDigest} became ${digest}`,
        );
      }
      if (entry.previousChainDigest !== previous) {
        issues.push(`chain break before ${entry.attemptId}`);
      }
      const expectedChain = chainDigest(entry.previousChainDigest, entry.resultDigest);
      if (entry.chainDigest !== expectedChain) {
        issues.push(`chain digest for ${entry.attemptId} does not recompute`);
      }
      previous = entry.chainDigest;
    });
    return issues;
  }

  /** The head of the chain: one value that changes if anything before it does. */
  headChainDigest(): string {
    return this.entriesInternal.length === 0
      ? LEDGER_CHAIN_GENESIS
      : this.entriesInternal[this.entriesInternal.length - 1]!.chainDigest;
  }

  cumulativeSpendUsd(): number {
    return this.entriesInternal.reduce((total, entry) => total + entry.costUsd, 0);
  }

  /** Rehydrate a ledger from persisted entries and records, verifying as it goes. */
  static restore(
    mode: ExecutionMode,
    preregistrationHash: string,
    manifestHash: string,
    records: readonly RunResultRecord[],
    entries: readonly LedgerEntry[],
    corrections: readonly CorrectionRecord[] = [],
  ): { readonly ledger: CohortLedger; readonly issues: readonly string[] } {
    const ledger = new CohortLedger(mode, preregistrationHash, manifestHash);
    const issues: string[] = [];
    const byAttempt = new Map(records.map((record) => [record.attemptId, record] as const));
    for (const entry of entries) {
      const record = byAttempt.get(entry.attemptId);
      if (record === undefined) {
        issues.push(`persisted ledger entry ${entry.attemptId} has no persisted result record`);
        continue;
      }
      try {
        const replayed = ledger.append(record, entry.recordedAt);
        if (replayed.resultDigest !== entry.resultDigest) {
          issues.push(`persisted digest for ${entry.attemptId} does not match the restored record`);
        }
        if (replayed.chainDigest !== entry.chainDigest) {
          issues.push(`persisted chain digest for ${entry.attemptId} does not match the replay`);
        }
      } catch (error) {
        issues.push(`replaying ${entry.attemptId} failed: ${(error as Error).message}`);
      }
    }
    for (const correction of corrections) {
      try {
        ledger.appendCorrection(
          correction.attemptId, correction.field, correction.note, correction.appendedAt,
        );
      } catch (error) {
        issues.push(`replaying correction for ${correction.attemptId}: ${(error as Error).message}`);
      }
    }
    return { ledger, issues: Object.freeze(issues) };
  }
}
