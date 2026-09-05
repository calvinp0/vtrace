/**
 * M215 — the launch executor for M214's frozen two-arm causal benchmark.
 *
 * M214 closed every design question and left exactly one gate open: G32, "a
 * launch executor exists that can run the frozen manifest". This module is that
 * executor, and it is the only one. There is no `launchBaseline` and no
 * `launchVtrace`: an arm is a row field that selects an `armDefinition`, and one
 * orchestration serves both. The permanent architecture rule M214 froze — same
 * executor, same agent, same native tools, same budgets, same evaluator, and
 * VTRACE exposure as the only difference — is enforceable only if there is
 * nowhere else for a difference to hide.
 *
 * The three expensive things are injected: containers, the agent and the
 * evaluator are interfaces, not calls. That is what lets a $0 milestone prove a
 * $700 machine, because the synthetic dry run substitutes fakes for exactly
 * those three and for nothing else — every gate, every ordering rule, every
 * ledger write on the paid path is the same code the dry run exercises.
 *
 * The design principle the whole file serves: make the valid path the easy one.
 * Loading the frozen artifacts and running the next authorised row is a single
 * call; running the wrong task, the wrong arm, the wrong model, the wrong
 * source state, the wrong order, the wrong budget or a second outcome for a
 * cell already decided each requires defeating a named guard that fails closed.
 *
 * M215 spends nothing. It does not run any of the 200 frozen rows.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  M214_AGENT,
  M214_ARMS,
  M214_BUDGET,
  M214_EXCLUSIONS,
  M214_EXPERIMENT_NAME,
  M214_MODEL,
  M214_NATIVE_TOOLS,
  M214_STOPPING_RULE,
  M214_VTRACE_TREATMENT_CATALOG,
  type M214Arm,
  type RunManifestRow,
  armDefinition,
  budgetIdentity,
  canonicalize,
  m214ManifestHash,
  m214PreregistrationHash,
  mcpToolName,
} from "./m214Preregistration";
import {
  M214_EXTERNAL_REFERENCE,
  externalReferenceHash,
} from "./m214ExternalReference";
import {
  type BaselineIsolationObservation,
  type ObservedWarmth,
  M214_LIFECYCLE_ORDER,
  auditBaselineIsolation,
  auditLifecycleOrder,
  auditResetPreservedPaths,
  auditSourceStateEquivalence,
  auditTreatmentArmContainment,
  auditWarmthPolicy,
  patchCapturePathspec,
  derivePatchCaptureExclusions,
} from "./m214TreatmentLifecycle";
import { type ObservedRunConfiguration, auditRun } from "./m214Falsification";
import {
  type EnvironmentSnapshotRecord,
  type EvaluationRecord,
  type ExecutionMode,
  type LedgerEntry,
  type RunResultRecord,
  type RuntimeGateRecord,
  type TelemetryEvent,
  type TerminationReason,
  type TreatmentTelemetryRecord,
  type ValidityClassification,
  CohortIntegrityError,
  CohortLedger,
  M215_RESULT_SCHEMA,
  deriveAttemptId,
  deriveRunId,
  gateRecord,
  isTerminal,
  isTerminalValid,
  requiredGatesPass,
} from "./m215CohortLedger";
import {
  type CohortOperations,
  type IsolationScope,
  type TeardownReport,
  unreportedTeardown,
} from "./m217ContinuationSafety";
import {
  auditRetrySpendReserve,
  cohortOperationalStatus,
  completionReserve,
  retryReserveDecisionFor,
} from "./m217RetryReserve";
import type {
  ScratchAuthority,
  ScratchCheckpoint,
  ScratchClaim,
  ScratchCleanupReport,
} from "./m218ScratchLifecycle";

// ── Executor identity (§40) ─────────────────────────────────────────

/**
 * The executor's own frozen identity, carried into the readiness evidence.
 *
 * §40 forbids a material harness change once outcomes exist. That is only
 * checkable if the harness has a version to compare, so the executor names
 * itself rather than being identified by "whatever is on main today".
 */
export const M215_EXECUTOR_VERSION = "stage5.m215.launch-executor.v1" as const;

export const M215_EXPERIMENT_NAME = M214_EXPERIMENT_NAME;

// ── Frozen authorities (§2, §7, §8, §9) ─────────────────────────────

export const M215_FROZEN_PREREGISTRATION_HASH =
  "3cd3b3d2d665c559fdb66e7274e809245e82ea7373344cf32614833b8dcbfea4" as const;
export const M215_FROZEN_MANIFEST_HASH =
  "549df54b0f48b59a2bc13da2acf27cbf2469f416d90018c3d48dd87219f77ff1" as const;
export const M215_FROZEN_EXTERNAL_REFERENCE_HASH =
  "822c4c5fb69dc21b8ada04189e73fcadb3e5ab1bf7c06a855dd4582a6ec7834b" as const;

export const M215_PREREGISTRATION_FILE = "stage5_m214_preregistration.json" as const;
export const M215_MANIFEST_FILE = "stage5_m214_run_manifest.json" as const;
export const M215_EXTERNAL_REFERENCE_FILE = "stage5_m214_external_reference.json" as const;
export const M215_PREREGISTRATION_HASH_FILE = "stage5_m214_preregistration_hash.json" as const;

/**
 * Fields the preregistration hash is taken WITHOUT.
 *
 * M214's published `hashRule` string names three (`preregistrationHash`,
 * `preregistrationHashRule`, `generatedAt`) but its generator excludes six more:
 * the launch-gate table and the readiness verdict are DERIVED from the document
 * and are written into the same file after hashing. Recomputing with only the
 * documented three yields a different digest, so an executor that trusted the
 * prose would fail closed on the unmodified committed artifact and no run would
 * ever start.
 *
 * The frozen artifact is not edited to fix its own prose — that would change the
 * hash M214 froze. The exclusion set is reproduced here exactly and the
 * discrepancy is reported instead.
 */
export const M215_PREREGISTRATION_HASH_EXCLUDED_FIELDS: readonly string[] = Object.freeze([
  "preregistrationHash",
  "preregistrationHashRule",
  "generatedAt",
  "launchGates",
  "launchAuthorized",
  "preregistrationComplete",
  "deferredRuntimeGates",
  "readinessVerdict",
  "readinessBlocker",
]);

export interface HashVerification {
  readonly artifact: string;
  readonly expected: string;
  readonly actual: string;
  readonly verified: boolean;
}

export interface FrozenAuthorities {
  readonly preregistration: Record<string, unknown>;
  readonly manifest: readonly RunManifestRow[];
  readonly externalReference: Record<string, unknown>;
  readonly preregistrationHash: HashVerification;
  readonly manifestHash: HashVerification;
  readonly externalReferenceHash: HashVerification;
  readonly verified: boolean;
  readonly issues: readonly string[];
}

/**
 * Recompute the preregistration digest from a committed document.
 *
 * Exported so the falsifier can mutate one byte and watch this return a
 * different value, rather than trusting that it would.
 */
export function recomputePreregistrationHash(document: Record<string, unknown>): string {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (M215_PREREGISTRATION_HASH_EXCLUDED_FIELDS.includes(key)) continue;
    body[key] = value;
  }
  return m214PreregistrationHash(body);
}

export function recomputeExternalReferenceHash(): string {
  return externalReferenceHash(M214_EXTERNAL_REFERENCE);
}

function verifyHash(artifact: string, expected: string, actual: string): HashVerification {
  return { artifact, expected, actual, verified: expected === actual };
}

/**
 * Load and verify all three frozen authorities.
 *
 * `verified` is false, and `issues` is non-empty, on any difference. Nothing
 * regenerates: an authority that does not recompute is a different experiment,
 * and blessing the new value is the exact manipulation the preregistration was
 * written to prevent.
 */
export function loadFrozenAuthorities(resultsDir: string): FrozenAuthorities {
  const preregistration = JSON.parse(
    readFileSync(join(resultsDir, M215_PREREGISTRATION_FILE), "utf8"),
  ) as Record<string, unknown>;
  const manifestDocument = JSON.parse(
    readFileSync(join(resultsDir, M215_MANIFEST_FILE), "utf8"),
  ) as { rows: RunManifestRow[]; manifestHash: string };
  const externalReference = JSON.parse(
    readFileSync(join(resultsDir, M215_EXTERNAL_REFERENCE_FILE), "utf8"),
  ) as Record<string, unknown>;

  return verifyFrozenAuthorities(preregistration, manifestDocument, externalReference);
}

export function verifyFrozenAuthorities(
  preregistration: Record<string, unknown>,
  manifestDocument: { rows: RunManifestRow[]; manifestHash?: string },
  externalReference: Record<string, unknown>,
): FrozenAuthorities {
  const rows = manifestDocument.rows;
  const preregistrationHash = verifyHash(
    M215_PREREGISTRATION_FILE,
    M215_FROZEN_PREREGISTRATION_HASH,
    recomputePreregistrationHash(preregistration),
  );
  const manifestHash = verifyHash(
    M215_MANIFEST_FILE, M215_FROZEN_MANIFEST_HASH, m214ManifestHash(rows),
  );
  const referenceHash = verifyHash(
    M215_EXTERNAL_REFERENCE_FILE,
    M215_FROZEN_EXTERNAL_REFERENCE_HASH,
    String(externalReference.externalReferenceHash ?? recomputeExternalReferenceHash()),
  );

  const issues: string[] = [];
  for (const verification of [preregistrationHash, manifestHash, referenceHash]) {
    if (!verification.verified) {
      issues.push(
        `${verification.artifact} does not recompute to its frozen digest: expected `
        + `${verification.expected}, actual ${verification.actual}`,
      );
    }
  }
  // The document's own recorded digest must also agree, so a swap of BOTH the
  // body and its recorded hash is caught by the constant above rather than by
  // the document agreeing with itself.
  const recorded = String(preregistration.preregistrationHash ?? "");
  if (recorded !== M215_FROZEN_PREREGISTRATION_HASH) {
    issues.push(
      `preregistration records digest ${recorded || "(absent)"}, frozen authority is `
      + M215_FROZEN_PREREGISTRATION_HASH,
    );
  }
  if (rows.length !== M214_STOPPING_RULE.intendedRuns) {
    issues.push(`manifest holds ${rows.length} rows; the frozen cohort is ${M214_STOPPING_RULE.intendedRuns}`);
  }

  return {
    preregistration,
    manifest: Object.freeze([...rows]),
    externalReference,
    preregistrationHash,
    manifestHash,
    externalReferenceHash: referenceHash,
    verified: issues.length === 0,
    issues: Object.freeze(issues),
  };
}

export class FrozenAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrozenAuthorityError";
  }
}

// ── Arm admissibility (§9) ──────────────────────────────────────────

/**
 * The vendor's published result is an external reference, never an arm.
 *
 * Checked as a value rather than as a type so a string arriving from a manifest
 * file, a CLI flag or a hand-written row is rejected the same way.
 */
export function assertExecutableArm(arm: string): asserts arm is M214Arm {
  if (!(M214_ARMS as readonly string[]).includes(arm)) {
    throw new FrozenAuthorityError(
      `'${arm}' is not an executable arm of this experiment. The executable arms are `
      + `${M214_ARMS.join(" and ")}; the vendor's published figure is an EXTERNAL_VENDOR_REFERENCE `
      + "with no container, no budget and no execution order, and never enters the arm set.",
    );
  }
}

// ── Row resolution (§6, §48) ────────────────────────────────────────

export interface RowSelector {
  readonly runId?: string;
  readonly instanceId?: string;
  readonly arm?: string;
  readonly executionOrder?: number;
}

/**
 * Resolve a selector to exactly one frozen row.
 *
 * The selector may only ADDRESS a row. Every outcome-affecting property — task,
 * arm, model, budget, agent, treatment identity, container, order — comes from
 * the manifest, so there is no argument shape in which a caller can supply one.
 */
export function resolveManifestRow(
  manifest: readonly RunManifestRow[],
  selector: RowSelector,
): RunManifestRow {
  if (selector.arm !== undefined) assertExecutableArm(selector.arm);
  const candidates = manifest.filter((row) => {
    if (selector.runId !== undefined && row.runId !== selector.runId) return false;
    if (selector.instanceId !== undefined && row.instanceId !== selector.instanceId) return false;
    if (selector.arm !== undefined && row.arm !== selector.arm) return false;
    if (selector.executionOrder !== undefined && row.executionOrder !== selector.executionOrder) return false;
    return true;
  });
  if (candidates.length === 0) {
    throw new FrozenAuthorityError(
      `no frozen manifest row matches ${JSON.stringify(selector)}; a task or arm outside the `
      + "frozen 100x2 cohort cannot be executed by this executor",
    );
  }
  if (candidates.length > 1) {
    throw new FrozenAuthorityError(
      `${candidates.length} frozen manifest rows match ${JSON.stringify(selector)}; a row must be `
      + "addressed uniquely",
    );
  }
  return candidates[0]!;
}

/**
 * Reject any attempt to override a frozen property (§6).
 *
 * Overrides arrive as a bag of extra keys rather than as typed fields, because
 * the realistic route to a contaminated run is an operator adding
 * `--max-turns 400` to a launch command, not editing an interface.
 */
export const M215_FROZEN_PROPERTIES: readonly string[] = Object.freeze([
  "task", "instance", "instanceId", "arm", "model", "budget", "maxTurns", "perRunCostCapUsd",
  "agent", "agentVersion", "vtraceCommit", "vtraceProductTreeSha", "vtraceSha", "prompt",
  "systemPrompt", "nativeTools", "tools", "seed", "randomization", "executionOrder", "order",
  "containerImage", "evaluator", "treatmentCatalog",
]);

export function auditRuntimeOverrides(overrides: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(overrides)
    .filter((key) => M215_FROZEN_PROPERTIES.includes(key))
    .map((key) =>
      `runtime override of frozen property '${key}' refused; frozen values come from the `
      + "preregistration and the manifest, never from the command line");
}

// ── Execution order and scheduling (§22, §49) ───────────────────────

/**
 * Whether this row may run next, given what the ledger already holds.
 *
 * Two distinct protections, and they fail for different reasons. The pair rule
 * stops the second arm of a task preceding the first, which would give one arm
 * a systematic position advantage the randomisation was designed to remove. The
 * global rule stops an operator choosing WHICH row runs next, which is how
 * outcome-driven selection enters a cohort that has no interim analysis.
 */
export function auditRowPermitted(
  row: RunManifestRow,
  manifest: readonly RunManifestRow[],
  ledger: CohortLedger,
): readonly string[] {
  const issues: string[] = [];

  const existingValid = ledger.validOutcomeFor(row.instanceId, row.arm);
  if (existingValid !== undefined) {
    issues.push(
      `(${row.instanceId}, ${row.arm}) already has a valid outcome (${existingValid.attemptId}, `
      + `${existingValid.status}); rerunning a decided cell is refused`,
    );
  }

  const attempts = ledger.attemptsFor(row.instanceId, row.arm);
  if (attempts.length >= M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun) {
    issues.push(
      `(${row.instanceId}, ${row.arm}) has used all `
      + `${M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun} permitted attempts`,
    );
  }
  if (attempts.length > 0) {
    const last = attempts[attempts.length - 1]!;
    const retry = retryPermitted(last);
    if (!retry.permitted) issues.push(retry.reason);
  }

  const earlierUnfinished = manifest
    .filter((candidate) => candidate.executionOrder < row.executionOrder)
    .filter((candidate) => !isTerminal(ledger.statusFor(candidate.instanceId, candidate.arm)));
  if (earlierUnfinished.length > 0) {
    const first = earlierUnfinished[0]!;
    issues.push(
      `execution-order violation: row ${row.executionOrder} (${row.instanceId}, ${row.arm}) was `
      + `requested while row ${first.executionOrder} (${first.instanceId}, ${first.arm}) has not `
      + "reached a terminal state; the frozen order is not an operator choice",
    );
  }
  return issues;
}

/** The next row the cohort launcher is permitted to run, or undefined when done. */
export function selectNextRow(
  manifest: readonly RunManifestRow[],
  ledger: CohortLedger,
): RunManifestRow | undefined {
  const ordered = [...manifest].sort((left, right) => left.executionOrder - right.executionOrder);
  for (const row of ordered) {
    const status = ledger.statusFor(row.instanceId, row.arm);
    if (isTerminalValid(status)) continue;
    if (auditRowPermitted(row, manifest, ledger).length === 0) return row;
    if (!isTerminal(status)) return undefined;
    // A terminal-invalid row with no retry left is skipped rather than blocking:
    // its pair is reported as incomplete, which is M214's frozen pairing rule.
  }
  return undefined;
}

// ── Retry classification (§52) ──────────────────────────────────────

export interface RetryDecision {
  readonly permitted: boolean;
  readonly reason: string;
}

/**
 * §52 — only preregistered infrastructure categories may retry.
 *
 * A bad patch is not retryable because it was bad, and a model reasoning
 * failure is not infrastructure. Reading the permitted list from M214's frozen
 * object rather than restating it means a category invented later cannot become
 * retryable without changing the preregistration hash.
 */
export function retryPermitted(previous: LedgerEntry): RetryDecision {
  if (isTerminalValid(previous.status)) {
    return {
      permitted: false,
      reason:
        `${previous.attemptId} produced a valid outcome (${previous.status}); a valid run is never `
        + "retried, whichever way it went",
    };
  }
  const category = previous.validity.infrastructureCategory;
  if (category === null) {
    return { permitted: false, reason: `${previous.attemptId} has no infrastructure category to retry on` };
  }
  if (!(M214_EXCLUSIONS.retryPolicy.rerunnable as readonly string[]).includes(category)) {
    return {
      permitted: false,
      reason:
        `${category} is a frozen invalid-run category but is not on the frozen rerunnable list `
        + `[${M214_EXCLUSIONS.retryPolicy.rerunnable.join(", ")}]`,
    };
  }
  if (previous.attempt >= M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun) {
    return { permitted: false, reason: `attempt ${previous.attempt} is the last permitted attempt` };
  }
  return { permitted: true, reason: `${category} is a frozen rerunnable infrastructure category` };
}

export function assertLegitimateInfrastructureCategory(category: string): void {
  if (!(M214_EXCLUSIONS.legitimate as readonly string[]).includes(category)) {
    throw new CohortIntegrityError(
      `'${category}' is not one of M214's frozen invalid-run categories; an exclusion category `
      + "cannot be created after outcomes exist",
    );
  }
}

// ── Spend authorisation and ceiling (§29, §30) ──────────────────────

/**
 * Explicit human authorisation to spend, kept separate from technical readiness.
 *
 * Building the executor is not authorisation. The token is a string the
 * operator must supply and which the guard checks against the frozen ceiling, so
 * "we were ready, so we ran it" is not expressible.
 */
export interface SpendAuthorization {
  readonly authorized: true;
  readonly authorizedByOperator: string;
  readonly authorizedCeilingUsd: number;
  readonly authorizedAt: string;
  readonly statement: string;
}

export const M215_AUTHORIZED_CEILING_USD = M214_BUDGET.totalSpendCapUsd;

export function auditSpendAuthorization(
  authorization: SpendAuthorization | null,
  mode: ExecutionMode,
): readonly string[] {
  if (mode === "SYNTHETIC") return [];
  if (authorization === null) {
    return [
      "no spend authorisation supplied; a COHORT run makes paid model calls and requires explicit "
      + "operator authorisation of the frozen $"
      + `${M215_AUTHORIZED_CEILING_USD} ceiling. Technical readiness is not authorisation.`,
    ];
  }
  const issues: string[] = [];
  if (authorization.authorized !== true) issues.push("spend authorisation is not affirmative");
  if (authorization.authorizedCeilingUsd !== M215_AUTHORIZED_CEILING_USD) {
    issues.push(
      `authorised ceiling $${authorization.authorizedCeilingUsd} differs from the frozen `
      + `$${M215_AUTHORIZED_CEILING_USD}`,
    );
  }
  if (authorization.authorizedByOperator.trim().length === 0) {
    issues.push("spend authorisation names no operator");
  }
  return issues;
}

export interface SpendProjection {
  readonly cumulativeUsd: number;
  readonly remainingRuns: number;
  readonly projectedMaximumUsd: number;
  readonly ceilingUsd: number;
  readonly withinCeiling: boolean;
}

/**
 * §29 — the ceiling binds on the PROJECTION, not on what has been spent.
 *
 * Checking only the running total would let the cohort start a run that cannot
 * finish inside the authorised budget, which is how a hard ceiling becomes an
 * apology. The projection charges every remaining run at its per-run cap, since
 * that is the only number the executor can guarantee.
 */
export function projectSpend(
  ledger: CohortLedger,
  manifest: readonly RunManifestRow[],
  ceilingUsd: number = M215_AUTHORIZED_CEILING_USD,
): SpendProjection {
  const cumulative = ledger.cumulativeSpendUsd();
  const remaining = manifest.filter(
    (row) => !isTerminalValid(ledger.statusFor(row.instanceId, row.arm)),
  ).length;
  const projected = cumulative + remaining * M214_BUDGET.perRunCostCapUsd;
  return {
    cumulativeUsd: Number(cumulative.toFixed(6)),
    remainingRuns: remaining,
    projectedMaximumUsd: Number(projected.toFixed(6)),
    ceilingUsd,
    withinCeiling: projected <= ceilingUsd,
  };
}

/** Whether one more model call may begin without risking the hard ceiling. */
export function auditSpendCeiling(
  ledger: CohortLedger,
  ceilingUsd: number = M215_AUTHORIZED_CEILING_USD,
): readonly string[] {
  const cumulative = ledger.cumulativeSpendUsd();
  const worstCase = cumulative + M214_BUDGET.perRunCostCapUsd;
  if (worstCase > ceilingUsd) {
    return [
      `refusing to begin another model call: $${cumulative.toFixed(4)} spent, and one more run at `
      + `its $${M214_BUDGET.perRunCostCapUsd} cap could reach $${worstCase.toFixed(4)} against an `
      + `authorised ceiling of $${ceilingUsd}`,
    ];
  }
  return [];
}

// ── Secret handling (§42, §43) ──────────────────────────────────────

export const SECRET_NAME_PATTERN =
  /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|LICEN[CS]E_?KEY|AUTH|SESSION_?ID)/i;

/**
 * Environment snapshot with values dropped and secret-shaped names flagged.
 *
 * Values never enter a persisted artifact at all: recording "which variables
 * existed" is enough to audit comparability, and recording their contents is
 * how a credential reaches a committed result file.
 */
export function redactEnvironmentSnapshot(
  environment: Readonly<Record<string, string>>,
  limits: { cpuLimit: string; memoryLimit: string; networkPolicy: string },
): EnvironmentSnapshotRecord {
  const names = Object.keys(environment).sort();
  return {
    pathEntries: (environment.PATH ?? "").split(":").filter((entry) => entry.length > 0),
    environmentVariableNames: names,
    cpuLimit: limits.cpuLimit,
    memoryLimit: limits.memoryLimit,
    networkPolicy: limits.networkPolicy,
    redactedVariableNames: names.filter((name) => SECRET_NAME_PATTERN.test(name)),
  };
}

/** Scan a serialised artifact for any secret VALUE the environment held (§43). */
export function auditSerializedArtifactForSecrets(
  serialized: string,
  environment: Readonly<Record<string, string>>,
): readonly string[] {
  const issues: string[] = [];
  for (const [name, value] of Object.entries(environment)) {
    if (!SECRET_NAME_PATTERN.test(name)) continue;
    if (value.length < 8) continue;
    if (serialized.includes(value)) {
      issues.push(`persisted artifact contains the value of ${name} in plaintext`);
    }
  }
  return issues;
}

// ── Adapters (§44) ──────────────────────────────────────────────────

export interface ContainerHandle {
  readonly image: string;
  readonly imageDigest: string;
  readonly workingDirectory: string;
  readonly dependencyEnvironment: string;
}

export interface TreatmentInitialisation {
  readonly initialised: boolean;
  readonly catalogSha256: string | null;
  readonly exposedToolNames: readonly string[];
  readonly indexBuildSeconds: number | null;
  readonly indexSizeBytes: number | null;
  readonly failureCategory: string | null;
}

export interface CapturedPatch {
  readonly patch: string;
  readonly paths: readonly string[];
  readonly exclusions: readonly string[];
}

/**
 * Everything that touches a real container.
 *
 * The lifecycle phase each method belongs to is named in the docstring rather
 * than inferred, because M214's whole patch-capture repair turns on the ORDER
 * these are called in and the executor records the order it actually used.
 */
export interface ContainerAdapter {
  /**
   * CONTAINER_START. M218: when the executor has claimed run-owned scratch
   * for the attempt, the claim is handed in and the adapter must place the
   * arm's tree under `scratch.path`; arm-root removal then belongs to the
   * scratch authority, not to `stop`.
   */
  start(row: RunManifestRow, scratch?: ScratchClaim): Promise<ContainerHandle>;
  /** SOURCE_CHECKOUT_AT_BASE_COMMIT — authoritative reset to the frozen commit. */
  resetToBaseCommit(handle: ContainerHandle, row: RunManifestRow): Promise<void>;
  /** SOURCE_STATE_DIGEST_* — a digest over tracked source only. */
  trackedSourceDigest(handle: ContainerHandle): Promise<string>;
  head(handle: ContainerHandle): Promise<string>;
  /** Untracked paths git can enumerate; the pre-agent snapshot's raw input. */
  untrackedPaths(handle: ContainerHandle): Promise<readonly string[]>;
  /** Source-affecting untracked state, which must be empty at agent start. */
  untrackedSourceAffectingPaths(handle: ContainerHandle): Promise<readonly string[]>;
  /** TREATMENT_INITIALISATION — only ever called for an arm that has treatment. */
  initialiseTreatment(handle: ContainerHandle, row: RunManifestRow): Promise<TreatmentInitialisation>;
  /** What the agent will actually be able to see, read back rather than assumed. */
  inspectArmSurface(handle: ContainerHandle, row: RunManifestRow): Promise<ArmSurfaceObservation>;
  /** PATCH_CAPTURE — derived exclusions in, source patch out. */
  capturePatch(handle: ContainerHandle, exclusions: readonly string[]): Promise<CapturedPatch>;
  /**
   * Teardown. M217: reports rather than throws, and what it reports is only
   * the adapter's own story — the executor hands it to the continuation
   * authority, which enumerates what is actually left before deciding whether
   * another row may begin. A `void` return is treated as an unreported teardown.
   */
  stop(handle: ContainerHandle): Promise<TeardownReport | void>;
}

export interface ArmSurfaceObservation extends BaselineIsolationObservation {
  readonly nativeToolNames: readonly string[];
  readonly userPromptTemplate: string;
  readonly agentVersion: string;
  readonly canonicalTrackedSourceDigest: string;
  readonly goldArtifactsInAgentContext: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly resetPreservedPaths: readonly string[];
  readonly treatmentStateInheritedFromPreviousRun: readonly string[];
  readonly cpuLimit: string;
  readonly memoryLimit: string;
  readonly networkPolicy: string;
  readonly systemPromptSha256: string;
}

export interface AgentRunSpec {
  readonly row: RunManifestRow;
  readonly attemptId: string;
  readonly workingDirectory: string;
  readonly modelTarget: string;
  readonly agentBinary: string;
  readonly agentVersion: string;
  readonly nativeTools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly maxTurns: number;
  readonly perRunCostCapUsd: number;
  readonly wallClockTimeoutSeconds: number;
  readonly userPromptTemplate: string;
  /** M218 §35 — the attempt's owned scratch; `agentTmp` is bound at /tmp for the agent. */
  readonly scratch?: { readonly path: string; readonly agentTmp: string };
}

/**
 * The hook the model-identity gate rides on.
 *
 * Handing the adapter a callback rather than reading the identity afterwards is
 * what makes §12 true: the assertion executes DURING initialisation, before the
 * run can accumulate anything that would tempt someone to keep it. Throwing
 * from here aborts the run.
 */
export interface AgentRunHooks {
  readonly assertProviderModelIdentity: (providerModelIdentity: string | null) => void;
  /**
   * M218 §30 — the scratch emergency monitor aborts through this signal. An
   * adapter that honours it stops the process and reports HARNESS_ABORT with
   * the frozen emergency category; an adapter that ignores it changes nothing.
   */
  readonly abortSignal?: AbortSignal;
}

export interface AgentRunOutcome {
  /** Read from the run's own init event, never from a CLI alias or a config file. */
  readonly providerModelIdentity: string | null;
  readonly telemetry: readonly TelemetryEvent[];
  readonly turnCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly costUsd: number;
  readonly wallClockSeconds: number;
  readonly terminationReason: TerminationReason;
  readonly failureCategory: string | null;
}

export interface AgentAdapter {
  run(spec: AgentRunSpec, hooks: AgentRunHooks): Promise<AgentRunOutcome>;
}

export interface EvaluationOutcome {
  readonly command: string;
  readonly evaluatorIdentity: string;
  readonly exitStatus: number;
  readonly rawResult: string;
  readonly resolved: boolean;
  readonly evaluatorRan: boolean;
}

export interface EvaluatorAdapter {
  evaluate(row: RunManifestRow, patch: string): Promise<EvaluationOutcome>;
}

// ── Model identity (§12, §45) ───────────────────────────────────────

export class ModelIdentityError extends Error {
  readonly observed: string | null;
  constructor(observed: string | null) {
    super(
      `provider-returned model identity ${observed ?? "(absent)"} is not the frozen target `
      + `${M214_MODEL.model}; the run is aborted before it can become an authoritative outcome`,
    );
    this.name = "ModelIdentityError";
    this.observed = observed;
  }
}

/**
 * §12 — the provider's own answer, or nothing.
 *
 * An absent identity is a failure, not a pass: M214 could only establish
 * PRESENT_IN_AGENT_MODEL_REGISTRY_NOT_PROVIDER_CONFIRMED, and a gate that
 * treated silence as confirmation would leave the cohort with exactly the
 * evidence M214 already had.
 */
export function auditProviderModelIdentity(observed: string | null): readonly string[] {
  if (observed === null || observed.trim().length === 0) {
    return [
      "no authoritative provider model-identity event was observed; the CLI alias and the local "
      + "model registry are not evidence of what the provider served",
    ];
  }
  if (observed !== M214_MODEL.model) {
    return [`provider served ${observed}, the frozen target is ${M214_MODEL.model}`];
  }
  return [];
}

// ── Agent and tool identity (§14, §15, §16) ─────────────────────────

export function sha256Of(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** One authority for the native-tool catalogue, hashed the same way for both arms. */
export function nativeToolCatalogSha256(tools: readonly string[] = M214_NATIVE_TOOLS): string {
  return sha256Of(JSON.stringify([...tools].sort()));
}

export function treatmentCatalogSha256(
  catalog: readonly string[] = M214_VTRACE_TREATMENT_CATALOG,
): string {
  return sha256Of(JSON.stringify([...catalog].sort()));
}

/**
 * §15 — both arms derive their native tools from one authority.
 *
 * The comparison is between each arm's OBSERVED catalogue and the single frozen
 * hash, not between the two arms: two arms that drifted identically would pass a
 * pairwise check and fail this one.
 */
export function auditNativeToolEquality(
  baselineObserved: readonly string[],
  vtraceObserved: readonly string[],
): readonly string[] {
  const issues: string[] = [];
  const authority = nativeToolCatalogSha256();
  const baselineHash = nativeToolCatalogSha256(baselineObserved);
  const vtraceHash = nativeToolCatalogSha256(vtraceObserved);
  if (baselineHash !== authority) {
    issues.push(`baseline native-tool catalogue does not hash to the frozen authority (${baselineHash})`);
  }
  if (vtraceHash !== authority) {
    issues.push(`vtrace native-tool catalogue does not hash to the frozen authority (${vtraceHash})`);
  }
  if (baselineHash !== vtraceHash) {
    issues.push("baseline and vtrace native-tool catalogues differ before treatment augmentation");
  }
  return issues;
}

/**
 * §16 — the exposed treatment catalogue is exactly the frozen one.
 *
 * Both directions are failures. An unexpected new tool means the treatment
 * under test is not the treatment that was frozen; a missing tool means the
 * agent was given less than the product and a null result would be unreadable.
 */
export function auditTreatmentCatalogue(
  arm: M214Arm,
  exposedToolNames: readonly string[],
): readonly string[] {
  const definition = armDefinition(arm);
  const issues: string[] = [];
  if (definition.treatmentToolCatalog.length === 0) {
    if (exposedToolNames.length > 0) {
      issues.push(`${arm} arm exposes treatment tools: ${exposedToolNames.join(", ")}`);
    }
    return issues;
  }
  const expected = new Set(definition.treatmentToolCatalog.map((id) => mcpToolName("vtrace", id)));
  const observed = new Set(exposedToolNames);
  const unexpected = [...observed].filter((name) => !expected.has(name)).sort();
  const missing = [...expected].filter((name) => !observed.has(name)).sort();
  if (unexpected.length > 0) {
    issues.push(`${arm} arm exposes treatment tools outside the frozen catalogue: ${unexpected.join(", ")}`);
  }
  if (missing.length > 0) {
    issues.push(`${arm} arm is missing frozen treatment tools: ${missing.join(", ")}`);
  }
  return issues;
}

/** §14 — exact agent pinning; "close enough" is not a version match. */
export function auditAgentIdentity(
  observedVersion: string,
  observedPromptTemplate: string,
  observedNativeTools: readonly string[],
): readonly string[] {
  const issues: string[] = [];
  if (observedVersion !== M214_AGENT.version) {
    issues.push(`agent version ${observedVersion} is not the frozen pin ${M214_AGENT.version}`);
  }
  if (observedPromptTemplate !== M214_AGENT.userPromptText) {
    issues.push("user prompt template differs from the frozen text");
  }
  if (nativeToolCatalogSha256(observedNativeTools) !== nativeToolCatalogSha256()) {
    issues.push("native tool catalogue differs from the frozen authority");
  }
  return issues;
}

// ── Patch capture (§31, §54) ────────────────────────────────────────

/**
 * The derived exclusion set, and the legacy behaviour it replaced.
 *
 * `legacyVendorPatchExclusions` exists so §54's historical-defect control has
 * something to fail. Reproducing the old rule is what proves the new one is a
 * repair rather than a rename: the same fixture, the same treatment state, one
 * captures `.vtrace` and the other does not.
 */
export function derivedPatchExclusions(preAgentUntrackedPaths: readonly string[]): readonly string[] {
  return derivePatchCaptureExclusions(preAgentUntrackedPaths);
}

export function derivedPatchPathspec(preAgentUntrackedPaths: readonly string[]): string {
  return patchCapturePathspec(preAgentUntrackedPaths);
}

export const LEGACY_VENDOR_PATCH_EXCLUSIONS: readonly string[] = Object.freeze([".vexp"]);

/** §31 — the captured patch may not contain any path the exclusion set covers. */
export function auditCapturedPatch(
  captured: CapturedPatch,
  preAgentUntrackedPaths: readonly string[],
): readonly string[] {
  const expected = derivedPatchExclusions(preAgentUntrackedPaths);
  const issues: string[] = [];
  const missing = expected.filter((entry) => !captured.exclusions.includes(entry));
  if (missing.length > 0) {
    issues.push(`patch capture omitted derived exclusions: ${missing.join(", ")}`);
  }
  for (const path of captured.paths) {
    const covered = expected.find((entry) => path === entry || path.startsWith(`${entry}/`));
    if (covered !== undefined) {
      issues.push(`captured patch contains treatment state under ${covered}: ${path}`);
    }
  }
  return issues;
}

// ── Preflight (§17, §18, §19, §33) ──────────────────────────────────

export interface PreflightInputs {
  readonly row: RunManifestRow;
  readonly surface: ArmSurfaceObservation;
  readonly treatment: TreatmentInitialisation | null;
  readonly digestBeforeTreatment: string;
  readonly digestAfterTreatment: string;
  readonly headAtAgentStart: string;
  readonly untrackedSourceAffectingPaths: readonly string[];
  readonly preAgentUntrackedPaths: readonly string[];
  readonly assertedAt: string;
}

/**
 * Everything asserted before a single model token is spent.
 *
 * Every gate here is REQUIRED. There is no advisory preflight check, because a
 * preflight warning that does not stop the run is a note about a contaminated
 * outcome that has already been paid for.
 */
export function preflightGates(input: PreflightInputs): readonly RuntimeGateRecord[] {
  const { row, surface, assertedAt } = input;
  const definition = armDefinition(row.arm);
  const gates: RuntimeGateRecord[] = [];

  gates.push(gateRecord(
    "R1_ARM_ADMISSIBLE", "RUNTIME", true,
    (M214_ARMS as readonly string[]).includes(row.arm)
      ? []
      : [`${row.arm} is not an executable arm`],
    `manifest row declares arm ${row.arm}; executable arms are ${M214_ARMS.join(", ")}`,
    assertedAt,
  ));

  gates.push(gateRecord(
    "R2_AGENT_IDENTITY", "RUNTIME", true,
    auditAgentIdentity(surface.agentVersion, surface.userPromptTemplate, surface.nativeToolNames),
    `agent ${M214_AGENT.version}, frozen prompt template, frozen native-tool catalogue`,
    assertedAt,
  ));

  gates.push(gateRecord(
    "R3_NATIVE_TOOL_AUTHORITY", "RUNTIME", true,
    nativeToolCatalogSha256(surface.nativeToolNames) === nativeToolCatalogSha256()
      ? []
      : ["native-tool catalogue does not hash to the single frozen authority"],
    `native-tool catalogue sha256 ${nativeToolCatalogSha256()}`,
    assertedAt,
  ));

  const exposedTreatmentTools = surface.modelVisibleToolNames
    .filter((name) => !surface.nativeToolNames.includes(name));
  gates.push(gateRecord(
    "R4_TREATMENT_CATALOGUE", "RUNTIME", true,
    auditTreatmentCatalogue(row.arm, exposedTreatmentTools),
    row.arm === "vtrace"
      ? `frozen catalogue of ${definition.treatmentToolCatalog.length} treatment tools`
      : "baseline exposes zero treatment tools",
    assertedAt,
  ));

  gates.push(gateRecord(
    "R5_ARM_ISOLATION", "RUNTIME", true,
    row.arm === "baseline"
      ? auditBaselineIsolation(surface)
      : auditTreatmentArmContainment(surface, row.arm),
    row.arm === "baseline"
      ? "MCP config, tool schemas, env vars, daemon sockets, workspace entries, injected context, "
        + "system prompt"
      : "treatment arm containment: exactly its own surface, no foreign treatment state",
    assertedAt,
  ));

  gates.push(gateRecord(
    "R6_SOURCE_STATE_EQUIVALENCE", "RUNTIME", true,
    auditSourceStateEquivalence({
      arm: row.arm,
      instanceId: row.instanceId,
      baseCommit: row.baseCommit,
      headAtAgentStart: input.headAtAgentStart,
      trackedSourceDigestBeforeTreatment: input.digestBeforeTreatment,
      trackedSourceDigestAfterTreatment: input.digestAfterTreatment,
      canonicalTrackedSourceDigest: surface.canonicalTrackedSourceDigest,
      untrackedSourceAffectingPaths: input.untrackedSourceAffectingPaths,
    }),
    "M214 G14: HEAD at the frozen base commit, tracked-source digest unchanged by treatment "
    + "initialisation and equal to the canonical state, no untracked source-affecting state",
    assertedAt,
  ));

  const warmth: ObservedWarmth = {
    arm: row.arm,
    treatmentStateInheritedFromPreviousRun: surface.treatmentStateInheritedFromPreviousRun,
    resetPreservedPaths: surface.resetPreservedPaths,
  };
  gates.push(gateRecord(
    "R7_RESET_WARMTH_POLICY", "RUNTIME", true,
    [
      ...auditWarmthPolicy([warmth]),
      ...auditResetPreservedPaths(surface.resetPreservedPaths, [".vtrace", ".vexp"]),
    ],
    "frozen COLD_UNIFORM: nothing inherited, nothing preserved across runs, same policy both arms",
    assertedAt,
  ));

  gates.push(gateRecord(
    "R8_GOLD_LEAKAGE", "RUNTIME", true,
    surface.goldArtifactsInAgentContext.length === 0
      ? []
      : [`evaluation artifacts reachable from agent context: ${surface.goldArtifactsInAgentContext.join(", ")}`],
    "no gold patch, reference solution, evaluation-only file or post-hoc label in agent context",
    assertedAt,
  ));

  gates.push(gateRecord(
    "R9_BUDGET_SYMMETRY", "RUNTIME", true,
    auditRowBudget(row),
    `one frozen budget object, identity ${budgetIdentity()}, carried on every row`,
    assertedAt,
  ));

  gates.push(gateRecord(
    "R10_TREATMENT_IDENTITY", "RUNTIME", true,
    auditTreatmentIdentity(row, input.treatment),
    row.arm === "vtrace"
      ? `VTRACE pinned by product-tree identity ${row.vtraceProductTreeSha ?? "(absent)"}`
      : "baseline declares no treatment identity",
    assertedAt,
  ));

  gates.push(gateRecord(
    "R11_SECRET_HYGIENE", "RUNTIME", true,
    surface.injectedContextDocuments.filter((doc) => SECRET_NAME_PATTERN.test(doc)).length === 0
      ? []
      : ["a credential-shaped document is reachable from the agent's context"],
    "credentials never enter agent-visible context; persisted artifacts carry names, not values",
    assertedAt,
  ));

  return Object.freeze(gates);
}

/**
 * The gates that must appear in a valid run's evidence, by name.
 *
 * §31's failure mode is subtraction rather than falsification: a gate that is
 * quietly no longer emitted leaves a result whose `runtimeGates` all pass, and
 * `requiredGatesPass` over a table missing a row is trivially true. Coverage is
 * therefore checked against a frozen list rather than against the table itself.
 */
export const M215_REQUIRED_PRELAUNCH_GATE_IDS: readonly string[] = Object.freeze([
  "P1_PREREGISTRATION_HASH", "P2_MANIFEST_HASH", "P3_EXTERNAL_REFERENCE_HASH", "P4_ROW_IS_FROZEN",
  "P5_NO_RUNTIME_OVERRIDES", "P6_EXECUTION_ORDER", "P7_SPEND_AUTHORIZATION", "P8_SPEND_CEILING",
  "P9_LEDGER_INTEGRITY", "P10_CONTINUATION_SAFETY", "P11_RETRY_SPEND_RESERVE",
  "P13_SCRATCH_CAPACITY",
]);

export const M215_REQUIRED_RUNTIME_GATE_IDS: readonly string[] = Object.freeze([
  "R1_ARM_ADMISSIBLE", "R2_AGENT_IDENTITY", "R3_NATIVE_TOOL_AUTHORITY", "R4_TREATMENT_CATALOGUE",
  "R5_ARM_ISOLATION", "R6_SOURCE_STATE_EQUIVALENCE", "R7_RESET_WARMTH_POLICY", "R8_GOLD_LEAKAGE",
  "R9_BUDGET_SYMMETRY", "R10_TREATMENT_IDENTITY", "R11_SECRET_HYGIENE",
  "R12_PROVIDER_MODEL_IDENTITY", "R13_PATCH_CAPTURE", "R14_LIFECYCLE_ORDER",
  "R15_EVALUATOR_AUTHORITY",
]);

/** A valid outcome must carry every required gate, asserted and passing. */
export function auditRuntimeGateCoverage(gates: readonly RuntimeGateRecord[]): readonly string[] {
  const present = new Set(gates.map((gate) => gate.gateId));
  const issues: string[] = [];
  for (const id of [...M215_REQUIRED_PRELAUNCH_GATE_IDS, ...M215_REQUIRED_RUNTIME_GATE_IDS]) {
    if (!present.has(id)) issues.push(`required gate ${id} is absent from the run's evidence`);
  }
  for (const gate of gates) {
    if (gate.required && gate.status !== "PASS") {
      issues.push(`required gate ${gate.gateId} did not pass: ${gate.failureReason ?? gate.status}`);
    }
  }
  return issues;
}

/** §28, §34 — the budget on the row is the one frozen budget, unmodified. */
export function auditRowBudget(row: RunManifestRow): readonly string[] {
  const issues: string[] = [];
  if (row.budgetIdentity !== budgetIdentity()) {
    issues.push(
      `row budget identity ${row.budgetIdentity} is not the frozen ${budgetIdentity()}`,
    );
  }
  if (row.maxTurns !== M214_BUDGET.maxTurns) {
    issues.push(`row turn budget ${row.maxTurns} is not the frozen ${M214_BUDGET.maxTurns}`);
  }
  if (row.perRunCostCapUsd !== M214_BUDGET.perRunCostCapUsd) {
    issues.push(`row cost cap ${row.perRunCostCapUsd} is not the frozen ${M214_BUDGET.perRunCostCapUsd}`);
  }
  return issues;
}

/**
 * §18, §39 — the treatment is pinned by PRODUCT TREE, not by repository HEAD.
 *
 * M214 chose `HEAD:src` deliberately so that harness and evidence commits do not
 * mutate the treatment under test. Substituting the whole-repository commit
 * would make every M215 commit a treatment change, which is the tuning §39
 * forbids expressed as a merge.
 */
export function auditTreatmentIdentity(
  row: RunManifestRow,
  treatment: TreatmentInitialisation | null,
): readonly string[] {
  const issues: string[] = [];
  if (row.arm !== "vtrace") {
    if (row.vtraceCommit !== null || row.vtraceProductTreeSha !== null) {
      issues.push(`${row.arm} row declares a VTRACE identity`);
    }
    if (treatment !== null) issues.push(`${row.arm} row initialised a treatment`);
    return issues;
  }
  if (row.vtraceProductTreeSha === null || row.vtraceProductTreeSha.length !== 40) {
    issues.push("vtrace row carries no product-tree identity");
  }
  if (row.vtraceCommit === null || row.vtraceCommit.length !== 40) {
    issues.push("vtrace row carries no commit identity");
  }
  if (treatment === null) {
    issues.push("vtrace row did not initialise its treatment");
    return issues;
  }
  if (!treatment.initialised) {
    issues.push(`treatment initialisation failed: ${treatment.failureCategory ?? "unclassified"}`);
  }
  if (treatment.catalogSha256 !== null && treatment.catalogSha256 !== treatmentCatalogSha256()) {
    issues.push("exposed treatment catalogue does not hash to the frozen catalogue");
  }
  return issues;
}

/**
 * §39 — the treatment identity the executor was configured with is the frozen
 * one, checked once before the cohort's first run.
 *
 * After the first valid outcome, a treatment change invalidates the cohort. The
 * check that makes that policy enforceable is this one: the product tree
 * actually present must equal the tree every manifest row declares.
 */
export function auditFrozenTreatmentTree(
  manifest: readonly RunManifestRow[],
  observedProductTreeSha: string,
): readonly string[] {
  const declared = new Set(
    manifest.filter((row) => row.arm === "vtrace").map((row) => row.vtraceProductTreeSha),
  );
  if (declared.size !== 1) {
    return [`manifest declares ${declared.size} distinct VTRACE product trees`];
  }
  const frozen = [...declared][0];
  if (frozen !== observedProductTreeSha) {
    return [
      `VTRACE treatment drift: the manifest freezes product tree ${frozen}, the working tree is `
      + `${observedProductTreeSha}. A changed treatment is a different treatment and needs a new `
      + "preregistration hash.",
    ];
  }
  return [];
}

// ── Execution (§4, §21, §27, §32) ───────────────────────────────────

export interface ExecutorDependencies {
  readonly mode: ExecutionMode;
  readonly authorities: FrozenAuthorities;
  readonly container: ContainerAdapter;
  readonly agent: AgentAdapter;
  readonly evaluator: EvaluatorAdapter;
  readonly ledger: CohortLedger;
  readonly now: () => string;
  readonly spendAuthorization: SpendAuthorization | null;
  /** Extra runtime arguments, audited for frozen-property overrides (§6). */
  readonly runtimeOverrides?: Readonly<Record<string, unknown>>;
  /**
   * M217 — the continuation-safety authority. Required in COHORT mode (a
   * cohort without one cannot prove isolation between rows and P10 fails
   * closed); optional in SYNTHETIC mode so M215's controls, which have no
   * substrate to isolate, are unchanged.
   */
  readonly operations?: CohortOperations;
  /**
   * M218 — the scratch authority. Required in COHORT mode (a cohort that
   * cannot claim, gate and verify its scratch may not begin a row; P13 fails
   * closed); optional in SYNTHETIC mode so the predecessor suites are
   * unchanged.
   */
  readonly scratch?: ScratchAuthority;
}

export class LaunchRefusedError extends Error {
  readonly gates: readonly RuntimeGateRecord[];
  constructor(message: string, gates: readonly RuntimeGateRecord[] = []) {
    super(message);
    this.name = "LaunchRefusedError";
    this.gates = gates;
  }
}

/**
 * Everything that must hold before the executor touches a container.
 *
 * Ordered cheapest-first on purpose: a mutated preregistration is caught before
 * a container image is pulled, and an unauthorised cohort is refused before any
 * of it happens.
 */
export function launchPreconditionGates(
  deps: ExecutorDependencies,
  row: RunManifestRow,
): readonly RuntimeGateRecord[] {
  const at = deps.now();
  const gates: RuntimeGateRecord[] = [];

  gates.push(gateRecord(
    "P1_PREREGISTRATION_HASH", "PREREGISTRATION", true,
    deps.authorities.preregistrationHash.verified
      ? []
      : [
        `expected ${deps.authorities.preregistrationHash.expected}, actual `
        + deps.authorities.preregistrationHash.actual,
      ],
    `preregistration recomputes to ${deps.authorities.preregistrationHash.expected}`,
    at,
  ));

  gates.push(gateRecord(
    "P2_MANIFEST_HASH", "PREREGISTRATION", true,
    deps.authorities.manifestHash.verified
      ? []
      : [`expected ${deps.authorities.manifestHash.expected}, actual ${deps.authorities.manifestHash.actual}`],
    `200-row manifest recomputes to ${deps.authorities.manifestHash.expected}`,
    at,
  ));

  gates.push(gateRecord(
    "P3_EXTERNAL_REFERENCE_HASH", "PREREGISTRATION", true,
    deps.authorities.externalReferenceHash.verified
      ? []
      : [
        `expected ${deps.authorities.externalReferenceHash.expected}, actual `
        + deps.authorities.externalReferenceHash.actual,
      ],
    "the external vendor reference is part of experiment identity and influences no execution",
    at,
  ));

  gates.push(gateRecord(
    "P4_ROW_IS_FROZEN", "PREREGISTRATION", true,
    deps.authorities.manifest.some((candidate) => candidate.runId === row.runId)
      ? []
      : [`${row.runId} is not a row of the frozen manifest`],
    "the row was resolved from the frozen manifest, not constructed",
    at,
  ));

  gates.push(gateRecord(
    "P5_NO_RUNTIME_OVERRIDES", "PREREGISTRATION", true,
    auditRuntimeOverrides(deps.runtimeOverrides ?? {}),
    `frozen properties: ${M215_FROZEN_PROPERTIES.length} names refused as runtime arguments`,
    at,
  ));

  gates.push(gateRecord(
    "P6_EXECUTION_ORDER", "INFRASTRUCTURE", true,
    auditRowPermitted(row, deps.authorities.manifest, deps.ledger),
    `frozen execution order ${row.executionOrder}/200, arm order [${row.armOrder.join(" then ")}]`,
    at,
  ));

  gates.push(gateRecord(
    "P7_SPEND_AUTHORIZATION", "INFRASTRUCTURE", true,
    auditSpendAuthorization(deps.spendAuthorization, deps.mode),
    deps.mode === "SYNTHETIC"
      ? "SYNTHETIC mode makes no paid call and requires no authorisation"
      : `explicit operator authorisation of the frozen $${M215_AUTHORIZED_CEILING_USD} ceiling`,
    at,
  ));

  gates.push(gateRecord(
    "P8_SPEND_CEILING", "INFRASTRUCTURE", true,
    deps.mode === "SYNTHETIC" ? [] : auditSpendCeiling(deps.ledger),
    "cumulative spend plus one more run at its cap must stay inside the authorised ceiling",
    at,
  ));

  gates.push(gateRecord(
    "P9_LEDGER_INTEGRITY", "INFRASTRUCTURE", true,
    deps.ledger.verifyIntegrity(),
    `ledger chain head ${deps.ledger.headChainDigest().slice(0, 16)}`,
    at,
  ));

  // M217 §7 — the next row may begin IFF every gate above passes AND
  // continuation safety is proven. A valid previous result is not proof.
  gates.push(gateRecord(
    "P10_CONTINUATION_SAFETY", "INFRASTRUCTURE", true,
    deps.operations === undefined
      ? (deps.mode === "SYNTHETIC"
        ? []
        : [
          "no continuation-safety authority is bound; isolation between rows cannot be proven, so a "
          + "COHORT row may not begin",
        ])
      : [...deps.operations.auditContinuation(), ...deps.operations.ledger.verifyIntegrity()],
    deps.operations === undefined
      ? "SYNTHETIC mode with no substrate to isolate"
      : `continuation ${deps.operations.state()} after ${deps.operations.ledger.events.length} `
        + `operational events; operations chain head `
        + deps.operations.ledger.headChainDigest().slice(0, 16),
    at,
  ));

  // M217 §16 — before an attempt that could consume paid budget, the three
  // numbers the brief names are computed and the frozen policy applied. Under
  // the frozen binding this gate refuses only what the ceiling refuses; its
  // evidence carries the completion-reserve declaration either way.
  const reserve = deps.mode === "SYNTHETIC" && deps.operations === undefined
    ? null
    : retryReserveDecisionFor(deps.ledger, deps.authorities.manifest, row);
  gates.push(gateRecord(
    "P11_RETRY_SPEND_RESERVE", "INFRASTRUCTURE", true,
    reserve === null ? [] : auditRetrySpendReserve(reserve),
    reserve === null
      ? "SYNTHETIC mode without an operations authority makes no paid call"
      : `attempt ${reserve.attempt}: $${reserve.cumulativeUsd} spent + $${reserve.retryExposureUsd} this `
        + `attempt + $${reserve.remainingRequiredExposureUsd} for ${reserve.rowsRequiringAttemptExcludingThis} `
        + `remaining required attempts = $${reserve.projectedUsd} against $${reserve.ceilingUsd}; `
        + `${reserve.declaration}; policy ${reserve.policy}`,
    at,
  ));

  // M218 §25–§28 — before every attempt the filesystem hosting the owned
  // scratch is measured against the frozen policy. The gate prefers refusing
  // one run to crashing the host mid-run; in COHORT mode a missing scratch
  // authority is itself a refusal.
  gates.push(gateRecord(
    "P13_SCRATCH_CAPACITY", "INFRASTRUCTURE", true,
    scratchCapacityIssues(deps),
    scratchCapacityEvidence(deps),
    at,
  ));

  return Object.freeze(gates);
}

function scratchCapacityIssues(deps: ExecutorDependencies): readonly string[] {
  if (deps.scratch === undefined) {
    return deps.mode === "SYNTHETIC"
      ? []
      : ["no scratch authority is bound; owned scratch cannot be claimed, gated or verified, so a COHORT row may not begin"];
  }
  try {
    const gate = deps.scratch.capacityGate();
    return gate.issues;
  } catch (error) {
    return [`the capacity gate could not measure the host: ${(error as Error).message}`];
  }
}

function scratchCapacityEvidence(deps: ExecutorDependencies): string {
  if (deps.scratch === undefined) return "SYNTHETIC mode with no scratch authority; no host filesystem is consumed";
  try {
    const gate = deps.scratch.capacityGate();
    return `namespace ${gate.namespaceRoot}: ${gate.namespaceFilesystem.freeBytes} bytes / `
      + `${gate.namespaceFilesystem.freeInodes} inodes free; required ${gate.requiredFreeBytes} bytes `
      + `(${gate.hostSafetyReserveBytes} host reserve + ${gate.projectedAttemptScratchBytes} projected attempt) / `
      + `${gate.requiredFreeInodes} inodes; shared tmp free ${gate.sharedTmp?.freeBytes ?? "n/a"}`;
  } catch (error) {
    return `capacity gate unavailable: ${(error as Error).message}`;
  }
}

export interface ExecutionResult {
  readonly record: RunResultRecord;
  readonly entry: LedgerEntry;
}

function invalid(category: string, reason: string): ValidityClassification {
  assertLegitimateInfrastructureCategory(category);
  return { status: "INFRASTRUCTURE_INVALID", valid: false, infrastructureCategory: category, reason };
}

function valid(resolved: boolean, reason: string): ValidityClassification {
  return {
    status: resolved ? "VALID_RESOLVED" : "VALID_UNRESOLVED",
    valid: true,
    infrastructureCategory: null,
    reason,
  };
}

/**
 * Execute exactly one frozen manifest row.
 *
 * The order of the body is M214's frozen lifecycle, and the executor records
 * the phases it actually reached rather than the phases it intended — so an
 * abort halfway through produces a record that says where it stopped instead of
 * a plausible-looking one.
 *
 * A treatment-exposed run the agent never invoked is VALID under intention to
 * treat. That is not leniency: excluding it would turn the primary estimand
 * from "does offering the treatment help" into "does the treatment help when
 * the agent likes it", which is a different question and an unblinded one.
 */
export async function executeManifestRow(
  deps: ExecutorDependencies,
  selector: RowSelector,
): Promise<ExecutionResult> {
  const row = resolveManifestRow(deps.authorities.manifest, selector);
  assertExecutableArm(row.arm);

  const preconditions = launchPreconditionGates(deps, row);
  if (!requiredGatesPass(preconditions)) {
    const failed = preconditions.filter((gate) => gate.status === "FAIL");
    throw new LaunchRefusedError(
      `launch refused for ${row.runId}: `
      + failed.map((gate) => `${gate.gateId} ${gate.failureReason}`).join(" | "),
      preconditions,
    );
  }

  const attempt = deps.ledger.nextAttemptNumber(row.instanceId, row.arm);
  const runId = deriveRunId(M215_EXPERIMENT_NAME, row.instanceId, row.arm);
  const attemptId = deriveAttemptId(runId, row.executionOrder, attempt);
  const definition = armDefinition(row.arm);
  const startedAt = deps.now();
  const phases: string[] = [];

  // M217 §16 — a retry's spend decision is an operational event, recorded
  // before the attempt can cost anything and outside the result ledger.
  if (deps.operations !== undefined && attempt > 1) {
    const decision = retryReserveDecisionFor(deps.ledger, deps.authorities.manifest, row);
    deps.operations.recordRetryReserve({ runId, attemptId }, { decision });
  }

  // M218 §14 — ownership is registered OUTSIDE the ephemeral directory before
  // the directory is used. A claim that cannot be made is a refusal, not a
  // row that runs unowned.
  let claim: ScratchClaim | null = null;
  if (deps.scratch !== undefined) {
    claim = deps.scratch.claim(row, attemptId, attempt);
  }
  // Evidence the finally block must persist before cleanup; hoisted so an
  // early return inside the try cannot strand it in RUN_OWNED scratch.
  let capturedForEvidence: CapturedPatch | null = null;
  let evaluationForEvidence: EvaluationOutcome | null = null;
  let emergency: { readonly aborted: boolean; readonly highWaterBytes: number; readonly warned: boolean; readonly reason: string | null } | null = null;

  const handle = await deps.container.start(row, claim ?? undefined);
  phases.push("CONTAINER_START");
  const checkpoint = (label: string): ScratchCheckpoint | null =>
    (deps.scratch !== undefined && claim !== null ? deps.scratch.checkpoint(claim, label) : null);
  checkpoint("AFTER_CONTAINER_SETUP");
  try {
    await deps.container.resetToBaseCommit(handle, row);
    phases.push("SOURCE_CHECKOUT_AT_BASE_COMMIT");

    const digestBefore = await deps.container.trackedSourceDigest(handle);
    phases.push("SOURCE_STATE_DIGEST_BEFORE_TREATMENT");

    let treatment: TreatmentInitialisation | null = null;
    if (definition.treatmentStatePaths.length > 0) {
      treatment = await deps.container.initialiseTreatment(handle, row);
      phases.push("TREATMENT_INITIALISATION");
    } else {
      // The baseline has no treatment to initialise. The phase is still recorded
      // so the two arms produce comparable traces and the ordering audit sees the
      // same sequence in both.
      phases.push("TREATMENT_INITIALISATION");
    }

    checkpoint("AFTER_TREATMENT_INITIALISATION");
    const digestAfter = await deps.container.trackedSourceDigest(handle);
    phases.push("SOURCE_STATE_DIGEST_AFTER_TREATMENT");

    // AFTER initialisation, deliberately: this ordering is what makes treatment
    // metadata invisible to patch capture, and reversing it reintroduces the
    // vendor's defect by scheduling rather than by pathspec.
    const preAgentUntracked = await deps.container.untrackedPaths(handle);
    phases.push("PRE_AGENT_UNTRACKED_SNAPSHOT");

    const surface = await deps.container.inspectArmSurface(handle, row);
    const headAtStart = await deps.container.head(handle);
    const untrackedSourceAffecting = await deps.container.untrackedSourceAffectingPaths(handle);
    const assertedAt = deps.now();

    const preflight = preflightGates({
      row,
      surface,
      treatment,
      digestBeforeTreatment: digestBefore,
      digestAfterTreatment: digestAfter,
      headAtAgentStart: headAtStart,
      untrackedSourceAffectingPaths: untrackedSourceAffecting,
      preAgentUntrackedPaths: preAgentUntracked,
      assertedAt,
    });

    const environment = redactEnvironmentSnapshot(surface.environment, {
      cpuLimit: surface.cpuLimit,
      memoryLimit: surface.memoryLimit,
      networkPolicy: surface.networkPolicy,
    });

    const base = {
      row, runId, attempt, attemptId, startedAt, handle, environment, surface,
      preAgentUntracked, digestBefore, digestAfter, headAtStart, untrackedSourceAffecting,
      treatment,
    };

    if (!requiredGatesPass(preflight)) {
      const category = treatment !== null && !treatment.initialised
        ? "TREATMENT_INITIALISATION_FAILURE"
        : preflightFailureCategory(preflight);
      return await finalize(deps, base, phases, [...preconditions, ...preflight], null, null, null,
        invalid(category, preflight.filter((gate) => gate.status === "FAIL")
          .map((gate) => `${gate.gateId}: ${gate.failureReason}`).join(" | ")));
    }

    // From here a model may be called, so the identity assertion is armed first.
    let identityIssue: string | null = null;
    // M218 §30 — the emergency monitor's abort travels on the hooks.
    const abortController = new AbortController();
    const hooks: AgentRunHooks = {
      assertProviderModelIdentity: (observed) => {
        const issues = auditProviderModelIdentity(observed);
        if (issues.length > 0) {
          identityIssue = issues.join("; ");
          throw new ModelIdentityError(observed);
        }
      },
      abortSignal: abortController.signal,
    };

    const spec: AgentRunSpec = {
      row,
      attemptId,
      workingDirectory: handle.workingDirectory,
      modelTarget: M214_MODEL.model,
      agentBinary: M214_AGENT.binary,
      agentVersion: M214_AGENT.version,
      nativeTools: M214_NATIVE_TOOLS,
      mcpServers: definition.mcpServers,
      maxTurns: row.maxTurns,
      perRunCostCapUsd: row.perRunCostCapUsd,
      wallClockTimeoutSeconds: M214_BUDGET.wallClockTimeoutSecondsPerRun,
      userPromptTemplate: M214_AGENT.userPromptText,
      ...(claim === null ? {} : { scratch: { path: claim.path, agentTmp: claim.agentTmp } }),
    };

    let outcome: AgentRunOutcome;
    const monitor = deps.scratch !== undefined && claim !== null
      ? deps.scratch.startEmergencyMonitor(claim, abortController)
      : null;
    try {
      outcome = await deps.agent.run(spec, hooks);
      phases.push("AGENT_RUN");
    } catch (error) {
      phases.push("AGENT_RUN");
      if (monitor !== null) {
        const stopped = monitor.stop();
        emergency = { ...stopped, reason: abortController.signal.aborted ? String(abortController.signal.reason) : null };
      }
      const runtimeGates = [
        ...preconditions,
        ...preflight,
        gateRecord("R12_PROVIDER_MODEL_IDENTITY", "RUNTIME", true,
          [identityIssue ?? (error as Error).message],
          "provider-returned model identity read from the run's own init event", deps.now()),
      ];
      const category = error instanceof ModelIdentityError
        ? "MODEL_IDENTITY_DRIFT"
        : "AGENT_INFRASTRUCTURE_FAILURE_BEFORE_TREATMENT_EXPOSURE";
      return await finalize(deps, base, phases, runtimeGates, null, null, null,
        invalid(category, (error as Error).message));
    }
    if (monitor !== null) {
      const stopped = monitor.stop();
      emergency = { ...stopped, reason: abortController.signal.aborted ? String(abortController.signal.reason) : null };
    }
    checkpoint("AFTER_AGENT_COMPLETION");

    const identityGate = gateRecord(
      "R12_PROVIDER_MODEL_IDENTITY", "RUNTIME", true,
      auditProviderModelIdentity(outcome.providerModelIdentity),
      `provider-returned identity from the run's own init event; frozen target ${M214_MODEL.model}`,
      deps.now(),
    );

    const runtimeGates: RuntimeGateRecord[] = [...preconditions, ...preflight, identityGate];

    if (identityGate.status !== "PASS") {
      return await finalize(deps, base, phases, runtimeGates, outcome, null, null,
        invalid("MODEL_IDENTITY_DRIFT", identityGate.failureReason ?? "identity not confirmed"));
    }

    if (outcome.failureCategory !== null) {
      return await finalize(deps, base, phases, runtimeGates, outcome, null, null,
        invalid(outcome.failureCategory, `agent adapter reported ${outcome.failureCategory}`));
    }

    const exclusions = derivedPatchExclusions(preAgentUntracked);
    const captured = await deps.container.capturePatch(handle, exclusions);
    capturedForEvidence = captured;
    phases.push("PATCH_CAPTURE");

    const patchGate = gateRecord(
      "R13_PATCH_CAPTURE", "RUNTIME", true,
      auditCapturedPatch(captured, preAgentUntracked),
      `derived exclusions ${derivedPatchPathspec(preAgentUntracked) || "(none)"}; treatment `
      + "metadata is excluded by derivation, never by a hardcoded vendor name",
      deps.now(),
    );
    runtimeGates.push(patchGate);
    if (patchGate.status !== "PASS") {
      return await finalize(deps, base, phases, runtimeGates, outcome, captured, null,
        invalid("PATCH_EXTRACTION_FAILURE", patchGate.failureReason ?? "patch capture failed"));
    }

    const evaluation = await deps.evaluator.evaluate(row, captured.patch);
    evaluationForEvidence = evaluation;
    phases.push("EVALUATION");
    checkpoint("AFTER_EVALUATION");

    // Asserted only once the whole lifecycle has run: a gate that reads the
    // phase list halfway through would report the phases it had not reached yet
    // as missing, which is a guard that fails every compliant run.
    const lifecycleGate = gateRecord(
      "R14_LIFECYCLE_ORDER", "RUNTIME", true,
      auditLifecycleOrder(phases),
      `frozen lifecycle: ${M214_LIFECYCLE_ORDER.join(" -> ")}`,
      deps.now(),
    );
    runtimeGates.push(lifecycleGate);

    const evaluationGate = gateRecord(
      "R15_EVALUATOR_AUTHORITY", "RUNTIME", true,
      evaluation.evaluatorRan ? [] : [`evaluator did not run: exit ${evaluation.exitStatus}`],
      `${evaluation.evaluatorIdentity}; resolved status comes from the evaluator, never from the agent`,
      deps.now(),
    );
    runtimeGates.push(evaluationGate);

    if (lifecycleGate.status !== "PASS") {
      return await finalize(deps, base, phases, runtimeGates, outcome, captured, evaluation,
        invalid("TELEMETRY_CORRUPT", lifecycleGate.failureReason ?? "lifecycle order violated"));
    }
    if (!evaluation.evaluatorRan) {
      // An evaluation that did not run is NOT an unresolved task. Collapsing the
      // two would silently score infrastructure failures as agent failures, and
      // would do so on whichever arm happened to break.
      return await finalize(deps, base, phases, runtimeGates, outcome, captured, evaluation,
        invalid("EVALUATOR_INFRA_FAILURE", `evaluator exit ${evaluation.exitStatus}`));
    }

    // Last check before a run becomes an authoritative outcome: every required
    // gate is PRESENT, not merely every present gate passing. A gate that stops
    // being emitted would otherwise silently widen what counts as valid.
    const coverage = auditRuntimeGateCoverage(runtimeGates);
    if (coverage.length > 0) {
      return await finalize(deps, base, phases, runtimeGates, outcome, captured, evaluation,
        invalid("TELEMETRY_CORRUPT", coverage.join(" | ")));
    }

    return await finalize(deps, base, phases, runtimeGates, outcome, captured, evaluation,
      valid(evaluation.resolved,
        `evaluator ${evaluation.evaluatorIdentity} reported resolved=${evaluation.resolved}`));
  } finally {
    // M218 §18, §31 — the order is fixed: persist evidence out of RUN_OWNED
    // scratch, stop the container, THEN clean the owned scratch and verify.
    // Evidence persistence never deletes; a persistence failure is recorded
    // and leaves the scratch in place for the enumeration to report.
    const entryBeforeTeardown = deps.ledger.entries.find((candidate) => candidate.attemptId === attemptId);
    let evidenceIssue: string | null = null;
    if (deps.scratch !== undefined && claim !== null) {
      checkpoint("BEFORE_CLEANUP");
      try {
        deps.scratch.persistEvidence(claim, {
          patch: capturedForEvidence?.patch ?? null,
          evaluation: evaluationForEvidence === null ? null : {
            command: evaluationForEvidence.command,
            evaluatorIdentity: evaluationForEvidence.evaluatorIdentity,
            exitStatus: evaluationForEvidence.exitStatus,
            rawResult: evaluationForEvidence.rawResult,
            resolved: evaluationForEvidence.resolved,
            evaluatorRan: evaluationForEvidence.evaluatorRan,
          },
          extra: {
            "result_reference.json": JSON.stringify({
              attemptId, runId, resultDigest: entryBeforeTeardown?.resultDigest ?? null,
              resultStatus: entryBeforeTeardown?.status ?? null, phases,
            }, null, 2),
          },
        });
      } catch (error) {
        evidenceIssue = `evidence persistence failed: ${(error as Error).message}`;
      }
    }

    // M217 §5, §11 — teardown is reported, never thrown, and never touches the
    // result. Whatever the row produced is already in the result ledger with
    // its digest; the continuation authority reads that digest and decides a
    // DIFFERENT question: whether the next row may begin.
    const adapterTeardown = await teardownContainer(deps, handle);

    // M218 §19, §20, §42 — owned scratch is cleaned only after the container
    // is gone, only when evidence was persisted, and the result is measured.
    let scratchReport: ScratchCleanupReport | null = null;
    if (deps.scratch !== undefined && claim !== null) {
      if (evidenceIssue === null) {
        scratchReport = deps.scratch.cleanup(claim, { containerRemoved: adapterTeardown.containerRemoved });
      }
    }
    const teardown: TeardownReport = {
      ...adapterTeardown,
      armRootRemoved: adapterTeardown.armRootRemoved || scratchReport?.verified === true,
      errors: Object.freeze([
        ...adapterTeardown.errors,
        ...(evidenceIssue === null ? [] : [evidenceIssue]),
        ...(scratchReport === null || scratchReport.verified ? [] : [`scratch cleanup ${scratchReport.status}: ${scratchReport.errors.join("; ") || scratchReport.liveReferences.map((r) => r.detail).join("; ")}`]),
      ]),
      ...(claim === null ? {} : {
        scratch: {
          claimId: claim.claimId,
          scratchPath: claim.path,
          agentTmp: claim.agentTmp,
          freeBytesBefore: claim.freeBytesAtClaim,
          scratchHighWaterBytes: scratchReport?.scratchHighWaterBytes ?? null,
          freeBytesBeforeCleanup: scratchReport?.freeBytesBeforeCleanup ?? null,
          scratchBytesAfterCleanup: scratchReport?.scratchBytesAfterCleanup ?? null,
          freeBytesAfterCleanup: scratchReport?.freeBytesAfterCleanup ?? null,
          cleanupStatus: evidenceIssue !== null ? "SKIPPED_EVIDENCE_NOT_PERSISTED" : (scratchReport?.status ?? "NOT_RUN"),
          cleanupVerified: scratchReport?.verified ?? false,
          liveReferences: scratchReport?.liveReferences ?? [],
          checkpoints: scratchReport?.checkpoints ?? (deps.scratch?.checkpointsFor(claim) ?? []),
          emergency,
        },
      }),
    };

    if (deps.operations !== undefined) {
      const entry = deps.ledger.entries.find((candidate) => candidate.attemptId === attemptId);
      const own = handle as ContainerHandle & { armRoot?: string; hostMount?: string };
      const scope: IsolationScope = {
        workRoot: deps.operations.workRoot,
        armRoot: claim?.path ?? own.armRoot ?? null,
        hostMount: claim?.hostMount ?? own.hostMount ?? null,
        instanceId: row.instanceId,
        runId: row.runId,
      };
      if (emergency?.aborted === true) {
        deps.operations.recordScratchEvent("SCRATCH_EMERGENCY_ABORT", false, {
          reason: emergency.reason, highWaterBytes: emergency.highWaterBytes,
          category: "ENVIRONMENT_IRREPRODUCIBLE",
          note: "a forced abort to protect the host; mapped to the closest frozen infrastructure class, not rerunnable, no new retry class",
        }, { runId: row.runId, attemptId, resultDigest: entry?.resultDigest ?? null });
      }
      await deps.operations.recordTeardown({
        row,
        attemptId,
        resultDigest: entry?.resultDigest ?? null,
        resultStatus: entry?.status ?? null,
        scope,
      }, teardown);
    }
  }
}

/**
 * Tear down and REPORT.
 *
 * Without an operations authority (M215's synthetic controls) a thrown teardown
 * still propagates, so M215's behaviour is unchanged. With one, every failure
 * becomes part of the report the authority classifies, because a teardown that
 * threw past the authority would be a teardown nobody enumerated.
 */
async function teardownContainer(
  deps: ExecutorDependencies, handle: ContainerHandle,
): Promise<TeardownReport> {
  try {
    const report = (await deps.container.stop(handle)) as TeardownReport | undefined;
    return report ?? unreportedTeardown("the container adapter returned no teardown report");
  } catch (error) {
    if (deps.operations === undefined) throw error;
    return unreportedTeardown(`teardown threw: ${(error as Error).message}`);
  }
}

function preflightFailureCategory(gates: readonly RuntimeGateRecord[]): string {
  const failed = gates.filter((gate) => gate.status === "FAIL").map((gate) => gate.gateId);
  if (failed.includes("R5_ARM_ISOLATION") || failed.includes("R4_TREATMENT_CATALOGUE")) {
    return "TREATMENT_CONTAMINATION";
  }
  if (failed.includes("R6_SOURCE_STATE_EQUIVALENCE") || failed.includes("R7_RESET_WARMTH_POLICY")) {
    return "ENVIRONMENT_IRREPRODUCIBLE";
  }
  if (failed.includes("R10_TREATMENT_IDENTITY")) return "TREATMENT_INITIALISATION_FAILURE";
  return "ARM_CONFIGURATION_WRONG";
}

interface FinalizeBase {
  readonly row: RunManifestRow;
  readonly runId: string;
  readonly attempt: number;
  readonly attemptId: string;
  readonly startedAt: string;
  readonly handle: ContainerHandle;
  readonly environment: EnvironmentSnapshotRecord;
  readonly surface: ArmSurfaceObservation;
  readonly preAgentUntracked: readonly string[];
  readonly digestBefore: string;
  readonly digestAfter: string;
  readonly headAtStart: string;
  readonly untrackedSourceAffecting: readonly string[];
  readonly treatment: TreatmentInitialisation | null;
}

async function finalize(
  deps: ExecutorDependencies,
  base: FinalizeBase,
  phases: readonly string[],
  runtimeGates: readonly RuntimeGateRecord[],
  outcome: AgentRunOutcome | null,
  captured: CapturedPatch | null,
  evaluation: EvaluationOutcome | null,
  validity: ValidityClassification,
): Promise<ExecutionResult> {
  const endedAt = deps.now();
  const telemetry = outcome?.telemetry ?? [];
  const treatmentEvents = telemetry.filter((event) => event.kind === "TREATMENT_TOOL_CALL");
  const firstEdit = telemetry.find((event) => event.kind === "EDIT");
  const firstTreatment = treatmentEvents[0];

  const treatmentRecord: TreatmentTelemetryRecord = {
    exposed: armDefinition(base.row.arm).treatmentToolCatalog.length > 0,
    initialised: base.treatment?.initialised ?? false,
    catalogSha256: base.treatment?.catalogSha256 ?? null,
    firstInvocationTurn: firstTreatment?.turn ?? null,
    invokedBeforeFirstEdit: firstTreatment !== undefined
      && (firstEdit === undefined || firstTreatment.ordinal < firstEdit.ordinal),
    toolNames: Object.freeze([...new Set(treatmentEvents.map((event) => event.name))].sort()),
    invocationCount: treatmentEvents.length,
    totalOutputBytes: treatmentEvents.reduce((total, event) => total + event.outputBytes, 0),
    totalLatencyMs: treatmentEvents.reduce((total, event) => total + event.latencyMs, 0),
    indexBuildSeconds: base.treatment?.indexBuildSeconds ?? null,
    indexSizeBytes: base.treatment?.indexSizeBytes ?? null,
  };

  const evaluationRecord: EvaluationRecord | null = evaluation === null ? null : {
    command: evaluation.command,
    evaluatorIdentity: evaluation.evaluatorIdentity,
    exitStatus: evaluation.exitStatus,
    rawResultSha256: sha256Of(evaluation.rawResult),
    resolved: evaluation.resolved,
    evaluatorRan: evaluation.evaluatorRan,
  };

  const record: RunResultRecord = {
    schemaVersion: M215_RESULT_SCHEMA,
    mode: deps.mode,
    experimentName: M215_EXPERIMENT_NAME,
    preregistrationHash: deps.authorities.preregistrationHash.actual,
    manifestHash: deps.authorities.manifestHash.actual,
    externalReferenceHash: deps.authorities.externalReferenceHash.actual,
    manifestRowId: base.row.runId,
    manifestRowOrdinal: base.row.executionOrder,
    runId: base.runId,
    attempt: base.attempt,
    attemptId: base.attemptId,
    instanceId: base.row.instanceId,
    repo: base.row.repo,
    arm: base.row.arm,
    pairedTaskId: base.row.pairedTaskId,
    armOrder: base.row.armOrder,
    armOrderIndex: base.row.armOrderIndex,
    agent: {
      implementation: M214_AGENT.implementation,
      binary: M214_AGENT.binary,
      version: base.surface.agentVersion,
      systemPromptSha256: base.surface.systemPromptSha256,
      nativeToolCatalogSha256: nativeToolCatalogSha256(base.surface.nativeToolNames),
      userPromptTemplateSha256: sha256Of(base.surface.userPromptTemplate),
    },
    modelTarget: M214_MODEL.model,
    providerModelIdentity: outcome?.providerModelIdentity ?? null,
    modelIdentityVerified: outcome !== null
      && auditProviderModelIdentity(outcome.providerModelIdentity).length === 0,
    vtraceCommit: base.row.vtraceCommit,
    vtraceProductTreeSha: base.row.vtraceProductTreeSha,
    sourceState: {
      baseCommit: base.row.baseCommit,
      headAtAgentStart: base.headAtStart,
      trackedSourceDigestBeforeTreatment: base.digestBefore,
      trackedSourceDigestAfterTreatment: base.digestAfter,
      canonicalTrackedSourceDigest: base.surface.canonicalTrackedSourceDigest,
      preAgentUntrackedPaths: base.preAgentUntracked,
      untrackedSourceAffectingPaths: base.untrackedSourceAffecting,
    },
    container: {
      image: base.handle.image,
      imageDigest: base.handle.imageDigest,
      workingDirectory: base.handle.workingDirectory,
      dependencyEnvironment: base.handle.dependencyEnvironment,
    },
    budgets: {
      identity: base.row.budgetIdentity,
      maxTurns: base.row.maxTurns,
      perRunCostCapUsd: base.row.perRunCostCapUsd,
      wallClockTimeoutSecondsPerRun: M214_BUDGET.wallClockTimeoutSecondsPerRun,
    },
    startedAt: base.startedAt,
    endedAt,
    wallClockSeconds: outcome?.wallClockSeconds ?? 0,
    terminationReason: outcome?.terminationReason ?? "HARNESS_ABORT",
    turnCount: outcome?.turnCount ?? 0,
    inputTokens: outcome?.inputTokens ?? 0,
    outputTokens: outcome?.outputTokens ?? 0,
    cachedInputTokens: outcome?.cachedInputTokens ?? 0,
    costUsd: outcome?.costUsd ?? 0,
    treatment: treatmentRecord,
    telemetry,
    capturedPatchSha256: captured === null ? sha256Of("") : sha256Of(captured.patch),
    capturedPatchBytes: captured === null ? 0 : Buffer.byteLength(captured.patch, "utf8"),
    capturedPatchPaths: captured?.paths ?? [],
    patchCaptureExclusions: captured?.exclusions ?? [],
    lifecyclePhasesObserved: Object.freeze([...phases]),
    evaluation: evaluationRecord,
    environment: base.environment,
    runtimeGates: Object.freeze([...runtimeGates]),
    validity,
  };

  const secretIssues = auditSerializedArtifactForSecrets(
    JSON.stringify(canonicalize(record as unknown as Record<string, unknown>)),
    base.surface.environment,
  );
  if (secretIssues.length > 0) {
    throw new CohortIntegrityError(`refusing to persist a result: ${secretIssues.join("; ")}`);
  }

  const entry = deps.ledger.append(record, endedAt);
  return { record, entry };
}

// ── Cohort launcher (§49, §50, §51) ─────────────────────────────────

/** §50 — frozen before launch, never adapted to how the runs are going. */
export const M215_CONCURRENCY_POLICY = Object.freeze({
  concurrency: 1,
  policy: "SEQUENTIAL",
  rationale:
    "One run at a time. M207 and M208 both found timing contamination from unrelated machine load, "
    + "and while resolution is the primary outcome, the secondary efficiency measures are read from "
    + "the same runs. Sequential execution also makes the arm-order randomisation mean what it says: "
    + "with concurrency the second arm of a pair could start before the first finished and inherit a "
    + "different machine state.",
  loadPolicy:
    "The same policy for both arms and no arm-specific waiting: a run starts when the previous run "
    + "has reached a terminal state, whatever the machine is doing. An arm-specific idle-wait rule "
    + "would be a treatment.",
  machineMetadataRecorded: ["cpuLimit", "memoryLimit", "networkPolicy", "wallClockSeconds"],
  frozenBeforeLaunch: true,
});

export interface CohortProgress {
  readonly plannedRuns: number;
  readonly terminalRuns: number;
  readonly validRuns: number;
  readonly infrastructureInvalidRuns: number;
  readonly currentRunId: string | null;
  readonly cumulativeSpendUsd: number;
  readonly projectedMaximumSpendUsd: number;
  readonly ceilingUsd: number;
  readonly ledgerChainHead: string;
  readonly runtimeErrors: readonly string[];
  // M217 §17, §19 — operational status: completion, reserve, isolation, halt.
  readonly operationalStatus: string;
  readonly rowsRemaining: number;
  readonly maximumRemainingExposureUsd: number;
  readonly completionReserveUsd: number;
  readonly fixedNCompletionGuaranteed: boolean;
  readonly continuationState: string;
  readonly haltReason: string | null;
  readonly operationsChainHead: string | null;
  // M218 §41 — scratch health: free space, owned bytes, stale paths, cleanup
  // failures. Operational, outcome-blind.
  readonly scratchHealth: ScratchHealth | null;
}

export interface ScratchHealth {
  readonly namespaceRoot: string;
  readonly freeBytes: number;
  readonly freeInodes: number;
  readonly capacityGatePass: boolean;
  readonly ownedScratchBytes: number;
  readonly claimedPaths: number;
  readonly staleOwnedPathsAtLastSweep: number;
  readonly unknownPathsAtLastSweep: number;
  readonly cleanupFailures: number;
  readonly emergencyAborts: number;
}

/** Derived from the operations ledger and the authority's live measurements; names no arm. */
export function scratchHealth(
  operations: CohortOperations | null, scratch: ScratchAuthority | null,
): ScratchHealth | null {
  if (scratch === null) return null;
  const events = operations?.ledger.events ?? [];
  const lastSweep = [...events].reverse().find((event) => event.kind === "SCRATCH_STALE_SWEEP");
  const sweep = (lastSweep?.detail as { sweep?: { entries?: { classification: string }[] } } | undefined)?.sweep;
  const entries = sweep?.entries ?? [];
  let gate: ReturnType<ScratchAuthority["capacityGate"]> | null = null;
  try {
    gate = scratch.capacityGate();
  } catch {
    gate = null;
  }
  const claimed = scratch.registry.list().filter((claim) => claim.state === "CLAIMED");
  const ownedBytes = claimed.reduce((total, claim) => total + scratch.residue(claim).bytes, 0);
  return {
    namespaceRoot: scratch.namespace.canonicalRoot,
    freeBytes: gate?.namespaceFilesystem.freeBytes ?? -1,
    freeInodes: gate?.namespaceFilesystem.freeInodes ?? -1,
    capacityGatePass: gate?.pass ?? false,
    ownedScratchBytes: ownedBytes,
    claimedPaths: claimed.length,
    staleOwnedPathsAtLastSweep: entries.filter((entry) => entry.classification.startsWith("STALE")).length,
    unknownPathsAtLastSweep: entries.filter((entry) => entry.classification === "UNKNOWN").length,
    cleanupFailures: events.filter((event) => event.kind === "ROW_TEARDOWN"
      && (event.detail as { teardown?: { scratch?: { cleanupVerified?: boolean } } }).teardown?.scratch?.cleanupVerified === false).length,
    emergencyAborts: events.filter((event) => event.kind === "SCRATCH_EMERGENCY_ABORT").length,
  };
}

/**
 * §37, §38 — operational monitoring that cannot answer "who is winning".
 *
 * The fields are the whole point: completion, spend, infrastructure health and
 * errors, and deliberately no per-arm counts, no pass rate and no test
 * statistic. An operator watching a running cohort has no legitimate use for
 * the outcome comparison and a strong temptation to intervene on it, so the
 * dashboard cannot compute one.
 */
export function renderProgress(
  manifest: readonly RunManifestRow[],
  ledger: CohortLedger,
  currentRunId: string | null,
  runtimeErrors: readonly string[] = [],
  operations: CohortOperations | null = null,
  scratch: ScratchAuthority | null = null,
): CohortProgress {
  const projection = projectSpend(ledger, manifest);
  const terminal = manifest.filter((row) => isTerminal(ledger.statusFor(row.instanceId, row.arm)));
  const validRuns = manifest.filter((row) => isTerminalValid(ledger.statusFor(row.instanceId, row.arm)));
  const operational = cohortOperationalStatus(manifest, ledger, operations?.ledger ?? null);
  return {
    scratchHealth: scratchHealth(operations, scratch),
    operationalStatus: operational.status,
    rowsRemaining: operational.rowsRemaining,
    maximumRemainingExposureUsd: operational.maximumRemainingExposureUsd,
    completionReserveUsd: operational.completionReserveUsd,
    fixedNCompletionGuaranteed: operational.fixedNCompletionGuaranteed,
    continuationState: operational.continuationState,
    haltReason: operational.haltReason,
    operationsChainHead: operations?.ledger.headChainDigest() ?? null,
    plannedRuns: manifest.length,
    terminalRuns: terminal.length,
    validRuns: validRuns.length,
    infrastructureInvalidRuns: ledger.entries
      .filter((entry) => entry.status === "INFRASTRUCTURE_INVALID").length,
    currentRunId,
    cumulativeSpendUsd: projection.cumulativeUsd,
    projectedMaximumSpendUsd: projection.projectedMaximumUsd,
    ceilingUsd: projection.ceilingUsd,
    ledgerChainHead: ledger.headChainDigest(),
    runtimeErrors,
  };
}

export interface CohortRunReport {
  readonly executed: readonly string[];
  readonly progress: CohortProgress;
  readonly stoppedBecause: string;
}

/**
 * Run rows until the cohort is complete or a guard stops it.
 *
 * The operator does not choose rows. `selectNextRow` does, from the frozen
 * order, which is what removes the possibility of outcome-driven scheduling
 * without requiring anyone to resist it.
 */
export async function runCohort(
  deps: ExecutorDependencies,
  options: { readonly maxRows?: number } = {},
): Promise<CohortRunReport> {
  const executed: string[] = [];
  const errors: string[] = [];
  const limit = options.maxRows ?? Number.POSITIVE_INFINITY;
  let stoppedBecause = "cohort complete: every planned run has reached a terminal state";

  while (executed.length < limit) {
    // M217 §10 — a blocked continuation stops the loop BEFORE a row is
    // selected. There is no branch that continues, retries the next row, or
    // consults the previous result: the previous result is not the question.
    if (deps.operations !== undefined && deps.operations.state() === "CONTINUATION_BLOCKED") {
      const reasons = deps.operations.auditContinuation();
      stoppedBecause = reasons.join("; ");
      errors.push(...reasons);
      break;
    }
    const row = selectNextRow(deps.authorities.manifest, deps.ledger);
    if (row === undefined) break;
    if (deps.mode === "COHORT") {
      const ceiling = auditSpendCeiling(deps.ledger);
      if (ceiling.length > 0) {
        stoppedBecause = `COHORT_HALTED_SPEND_CEILING: ${ceiling.join("; ")}`;
        errors.push(...ceiling);
        // §17 — the halt is an operational event; the rows that never ran
        // stay PLANNED and nothing is written to the result ledger for them.
        deps.operations?.recordSpendHalt({
          reasons: ceiling,
          reserve: completionReserve(deps.ledger, deps.authorities.manifest),
          nextUnstartedRow: row.runId,
        });
        break;
      }
    }
    try {
      const result = await executeManifestRow(deps, { runId: row.runId });
      executed.push(result.record.attemptId);
    } catch (error) {
      const message = `${row.runId}: ${(error as Error).message}`;
      errors.push(message);
      stoppedBecause = message;
      break;
    }
  }
  if (executed.length >= limit) stoppedBecause = `row limit ${limit} reached`;

  return {
    executed: Object.freeze(executed),
    progress: renderProgress(
      deps.authorities.manifest, deps.ledger, null, Object.freeze(errors), deps.operations ?? null,
      deps.scratch ?? null,
    ),
    stoppedBecause,
  };
}

// ── Fixed-N finalisation (§37) ──────────────────────────────────────

export interface FinalizationDecision {
  readonly permitted: boolean;
  readonly reasons: readonly string[];
  readonly completePairs: number;
  readonly incompletePairs: number;
}

/**
 * §37 — the production finaliser refuses a partial cohort.
 *
 * M214's stopping rule is FIXED_N with no interim analysis, and the way that
 * rule is broken in practice is not by someone deciding to stop early but by
 * someone running the report "just to look". A finaliser that refuses is the
 * only version of the rule that survives curiosity.
 */
export function canFinalizeCausalReport(
  manifest: readonly RunManifestRow[],
  ledger: CohortLedger,
  mode: ExecutionMode,
): FinalizationDecision {
  const reasons: string[] = [];
  if (mode !== "COHORT") {
    reasons.push("a SYNTHETIC ledger can never produce a final causal report");
  }
  const nonTerminal = manifest.filter((row) => !isTerminal(ledger.statusFor(row.instanceId, row.arm)));
  if (nonTerminal.length > 0) {
    reasons.push(
      `${nonTerminal.length} of ${manifest.length} planned runs have not reached a terminal state; `
      + `${M214_STOPPING_RULE.design} admits no interim analysis`,
    );
  }
  const tasks = [...new Set(manifest.map((row) => row.instanceId))];
  const complete = tasks.filter((instanceId) =>
    M214_ARMS.every((arm) => ledger.validOutcomeFor(instanceId, arm) !== undefined));
  const incomplete = tasks.length - complete.length;
  if (complete.length === 0) {
    reasons.push("no task has a valid outcome in both arms; there is nothing paired to analyse");
  }
  return {
    permitted: reasons.length === 0,
    reasons: Object.freeze(reasons),
    completePairs: complete.length,
    incompletePairs: incomplete,
  };
}

// ── Observed-configuration bridge ───────────────────────────────────

/**
 * Present a live run to M214's own per-run auditor.
 *
 * Rebuilding those checks against the executor's own types would let the two
 * copies drift, and the copy that mattered would be the one nobody re-derived.
 */
export function observedConfigurationFrom(
  row: RunManifestRow,
  surface: ArmSurfaceObservation,
  headAtAgentStart: string,
  trackedSourceDigestAtAgentStart: string,
  treatmentInvocationCount: number,
): ObservedRunConfiguration {
  return {
    runId: row.runId,
    instanceId: row.instanceId,
    arm: row.arm,
    agentVersion: surface.agentVersion,
    model: M214_MODEL.model,
    maxTurns: row.maxTurns,
    perRunCostCapUsd: row.perRunCostCapUsd,
    wallClockTimeoutSecondsPerRun: M214_BUDGET.wallClockTimeoutSecondsPerRun,
    nativeTools: surface.nativeToolNames,
    mcpServers: surface.mcpServers,
    modelVisibleToolNames: surface.modelVisibleToolNames,
    environmentVariableNames: Object.keys(surface.environment).sort(),
    workspaceRootEntries: surface.workspaceRootEntries,
    systemPromptAppendix: surface.systemPromptAppendix,
    userPromptTemplate: surface.userPromptTemplate,
    vtraceCommit: row.vtraceCommit,
    vtraceProductTreeSha: row.vtraceProductTreeSha,
    conversationSeededFromRunId: null,
    patchSeededFromRunId: null,
    treatmentResultSeededFromRunId: null,
    injectedContextDocuments: surface.injectedContextDocuments,
    goldArtifactsInAgentContext: surface.goldArtifactsInAgentContext,
    baseCommit: row.baseCommit,
    headAtAgentStart,
    trackedSourceDigestAtAgentStart,
    treatmentExposed: armDefinition(row.arm).treatmentToolCatalog.length > 0,
    treatmentInvocationCount,
  };
}

export { auditRun };
