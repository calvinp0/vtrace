/**
 * M215 §47, §48, §49 — the launch entry point.
 *
 * One command, and almost no knobs. Every outcome-affecting value comes from the
 * frozen preregistration and the frozen manifest; the runtime arguments are
 * operational only — where results go, which adapter binding to use, whether to
 * resume, and the explicit spend authorisation without which a COHORT launch is
 * refused.
 *
 * There is no `--force-any-task`, no `--arm`, no `--model`, no `--max-turns`.
 * Any argument naming a frozen property is rejected by name before anything
 * else happens, because the realistic way a cohort gets contaminated is an
 * operator adding a flag under time pressure, not someone editing an interface.
 *
 *   # what M215 can do today
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m215_launch.ts --plan
 *
 *   # what the paid cohort will be, once a real binding exists AND spend is authorised
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m215_launch.ts \
 *     --binding DOCKER_SWEBENCH --authorize-spend "<operator>" --results <dir> [--resume]
 *
 * M215 itself spends nothing: the only implemented binding is SYNTHETIC, and a
 * COHORT launch on it is refused.
 *
 * M217 UPDATE. The launcher now (a) resolves the DOCKER_SWEBENCH adapters
 * through `m217LaunchBinding.startCohortBinding` instead of a property no
 * binding declared, (b) keeps a second, append-only OPERATIONS ledger beside
 * the result ledger and binds it to the executor as the continuation-safety
 * authority, (c) refuses to start over residual substrate state, and (d) offers
 * exactly one way out of COHORT_HALTED_ISOLATION_RISK: `--recover-isolation`,
 * which runs the predeclared recovery path, records what it verified, and runs
 * no row. There is still no `--force`.
 *
 * M220 UPDATE. The cohort is executed in outcome-blind QUOTA-WINDOW SESSIONS
 * under the A2 amendment (M214 + A1 + A2). A COHORT launch requires
 * `--max-pairs-this-session N`; the loop runs at most N complete frozen pairs,
 * pauses (COHORT_PAUSED_QUOTA_WINDOW), proves the substrate clean, and the
 * next `--resume` continues at exactly the next frozen row. `--pause-after-
 * current-pair` / `--pause-after-current-arm` write an explicit pause request
 * a running session honours; `--session-status` prints an outcome-blind status
 * and runs nothing. There is no task selector.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import { M214_BUDGET, M214_EXPERIMENT_NAME, M214_STOPPING_RULE } from "./m214Preregistration";
import {
  type BindingId,
  M215_ADAPTER_BINDINGS,
  assertBindingUsable,
  authoritativeBindingAvailable,
  bindingFor,
} from "./m215AdapterBindings";
import {
  type CohortRunReport,
  type ExecutorDependencies,
  type FrozenAuthorities,
  type SpendAuthorization,
  M215_AUTHORIZED_CEILING_USD,
  M215_CONCURRENCY_POLICY,
  M215_EXECUTOR_VERSION,
  M215_EXTERNAL_REFERENCE_FILE,
  M215_FROZEN_PROPERTIES,
  M215_MANIFEST_FILE,
  M215_PREREGISTRATION_FILE,
  M220_PAUSED_STATUS,
  auditFrozenTreatmentTree,
  auditSpendAuthorization,
  executeManifestRow,
  projectSpend,
  renderProgress,
  resolveManifestRow,
  runCohort,
  selectNextRow,
  verifyFrozenAuthorities,
} from "./m215LaunchExecutor";
import {
  type CorrectionRecord,
  type LedgerEntry,
  type RunResultRecord,
  CohortLedger,
  M215_LEDGER_SCHEMA,
} from "./m215CohortLedger";
import { resolveAgentBinary } from "./m216ProductionAdapters";
import { SubstrateBridge } from "./m216SubstrateBridge";
import {
  type OperationalEvent,
  CohortOperations,
  CohortOperationsLedger,
  M217_OPERATIONS_LEDGER_SCHEMA,
  residualStateIssues,
} from "./m217ContinuationSafety";
import { M217IsolationProbe } from "./m217IsolationProbe";
import { startCohortBinding } from "./m217LaunchBinding";
import { cohortOperationalStatus } from "./m217RetryReserve";
import { ScratchAwareIsolationProbe } from "./m218IsolationProbe";
import {
  HostLivenessProbe,
  M218_EVIDENCE_DIRNAME,
  M218_REGISTRY_DIRNAME,
  M218_SCRATCH_POLICY,
  ScratchAuthority,
  ScratchRegistry,
  establishNamespace,
  imageAvailability,
} from "./m218ScratchLifecycle";
import {
  type ActiveSpendAuthority,
  amendedLaunchRisk,
  auditExecutableAuthorityBinding,
  loadActiveSpendAuthority,
} from "./m218SpendAuthority";
import {
  type ImageIdentityRecord,
  type ImagePreflight,
  M219_IMAGE_IDENTITY_FILE,
  dockerImageInspector,
  imagePreflight,
} from "./m219OperatorPreflight";
import {
  type ActiveSessionAuthority,
  M214_A2_AMENDMENT_ID,
  auditSessionAuthorityBinding,
  loadActiveSessionAuthority,
} from "./m220Amendment";
import {
  type PauseRequest,
  type PauseRequestKind,
  type SessionBounds,
  M220_PAIR_TIMING_SCHEMA,
  M220_PAUSE_REQUEST_FILE,
  M220_SESSION_JOURNAL_SCHEMA,
  deriveSessionJournal,
  frozenPairs,
  lastHardQuotaLimit,
  nextSessionNumber,
  pairTemporalGaps,
  parsePauseRequest,
  pauseRequestDocument,
  quotaWindowGate,
  sessionIdFor,
  sessionStatusView,
  statusViewLeaksOutcome,
  validateMaxPairs,
} from "./m220QuotaSession";

const RESULTS_DIR = join(import.meta.dir, "results");
const VTRACE_ROOT = join(import.meta.dir, "..", "..");

// ── Argument parsing (§47) ──────────────────────────────────────────

interface LaunchArgs {
  readonly binding: BindingId;
  readonly resultsDir: string;
  readonly cohortDir: string;
  readonly authorizeSpend: string | null;
  readonly resume: boolean;
  readonly plan: boolean;
  readonly row: string | null;
  readonly maxRows: number | null;
  /** M217 §12 — run the predeclared isolation recovery path; runs no row. */
  readonly recoverIsolation: boolean;
  /** M219 §24 — run every launch check up to the spend refusal; runs no row, never launches. */
  readonly preflight: boolean;
  /** M220 §8 — the operator's per-session pair cap; required for a COHORT loop launch. */
  readonly maxPairsThisSession: number | null;
  /** M220 §42 — no NEW pair after this many seconds; an active pair finishes. */
  readonly maxSessionWallClockSeconds: number | null;
  /** M220 §12 — explicit pause requests; alone they write the request and run nothing. */
  readonly pauseAfterCurrentPair: boolean;
  readonly pauseAfterCurrentArm: boolean;
  readonly clearPauseRequest: boolean;
  /** M220 §32 — the outcome-blind status; runs nothing. */
  readonly sessionStatus: boolean;
}

const OPERATIONAL_FLAGS: readonly string[] = Object.freeze([
  "--binding", "--results", "--cohort-dir", "--authorize-spend", "--resume", "--plan", "--row",
  "--max-rows", "--recover-isolation", "--preflight",
  "--max-pairs-this-session", "--max-session-wall-clock", "--pause-after-current-pair",
  "--pause-after-current-arm", "--clear-pause-request", "--session-status",
]);

const BOOLEAN_FLAGS: readonly string[] = Object.freeze([
  "--resume", "--plan", "--recover-isolation", "--preflight", "--pause-after-current-pair",
  "--pause-after-current-arm", "--clear-pause-request", "--session-status",
]);

/**
 * Parse, refusing anything that could change an outcome.
 *
 * Unknown flags are refused rather than ignored, and a flag whose name matches a
 * frozen property gets a message saying which property and why — an operator who
 * reaches for `--model` should learn that the model is frozen, not that the flag
 * was typed wrong. There is deliberately no `--task`, `--skip-to` or
 * `--start-at`: the next pair is the next frozen pair.
 */
export function parseLaunchArgs(argv: readonly string[]): LaunchArgs {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new Error(`unexpected positional argument: ${token}`);
    const name = token.split("=")[0]!;
    const frozen = M215_FROZEN_PROPERTIES.find(
      (property) => name.slice(2).replace(/-/g, "").toLowerCase() === property.toLowerCase(),
    );
    if (frozen !== undefined) {
      throw new Error(
        `${name} would override the frozen property '${frozen}'. Frozen values come from the `
        + "preregistration and the manifest; changing one is a new cohort with a new hash, not a "
        + "command-line argument.",
      );
    }
    if (!OPERATIONAL_FLAGS.includes(name)) {
      throw new Error(
        `unknown argument ${name}. The launcher accepts only operational arguments: `
        + OPERATIONAL_FLAGS.join(", ")
        + ". There is no task selector: the next pair is always the next frozen pair.",
      );
    }
    if (token.includes("=")) {
      args[name] = token.slice(token.indexOf("=") + 1);
      continue;
    }
    const next = argv[index + 1];
    if (BOOLEAN_FLAGS.includes(name)) {
      args[name] = true;
      continue;
    }
    if (next === undefined || next.startsWith("--")) throw new Error(`${name} needs a value`);
    args[name] = next;
    index += 1;
  }

  const resultsDir = String(args["--results"] ?? RESULTS_DIR);
  const maxPairs = args["--max-pairs-this-session"] === undefined
    ? null
    : validateMaxPairs(Number(args["--max-pairs-this-session"]));
  const wallClock = args["--max-session-wall-clock"] === undefined ? null : Number(args["--max-session-wall-clock"]);
  if (wallClock !== null && (!Number.isFinite(wallClock) || wallClock <= 0)) {
    throw new Error(`--max-session-wall-clock must be a positive number of seconds (got ${String(args["--max-session-wall-clock"])})`);
  }
  if (args["--pause-after-current-pair"] === true && args["--pause-after-current-arm"] === true) {
    throw new Error("--pause-after-current-pair and --pause-after-current-arm are exclusive; choose the boundary");
  }
  return {
    binding: (args["--binding"] ?? "DOCKER_SWEBENCH") as BindingId,
    resultsDir,
    cohortDir: String(args["--cohort-dir"] ?? join(resultsDir, "_m215_cohort")),
    authorizeSpend: args["--authorize-spend"] === undefined
      ? null
      : String(args["--authorize-spend"]),
    resume: args["--resume"] === true,
    plan: args["--plan"] === true,
    row: args["--row"] === undefined ? null : String(args["--row"]),
    maxRows: args["--max-rows"] === undefined ? null : Number(args["--max-rows"]),
    recoverIsolation: args["--recover-isolation"] === true,
    preflight: args["--preflight"] === true,
    maxPairsThisSession: maxPairs,
    maxSessionWallClockSeconds: wallClock,
    pauseAfterCurrentPair: args["--pause-after-current-pair"] === true,
    pauseAfterCurrentArm: args["--pause-after-current-arm"] === true,
    clearPauseRequest: args["--clear-pause-request"] === true,
    sessionStatus: args["--session-status"] === true,
  };
}

// ── Frozen authorities and persistence ──────────────────────────────

function loadAuthorities(resultsDir: string): FrozenAuthorities {
  const read = (file: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(resultsDir, file), "utf8")) as Record<string, unknown>;
  return verifyFrozenAuthorities(
    read(M215_PREREGISTRATION_FILE),
    read(M215_MANIFEST_FILE) as unknown as { rows: RunManifestRow[]; manifestHash: string },
    read(M215_EXTERNAL_REFERENCE_FILE),
  );
}

interface PersistedCohort {
  readonly schemaVersion: typeof M215_LEDGER_SCHEMA;
  readonly preregistrationHash: string;
  readonly manifestHash: string;
  readonly executorVersion: string;
  readonly records: readonly RunResultRecord[];
  readonly entries: readonly LedgerEntry[];
  readonly corrections: readonly CorrectionRecord[];
}

function cohortPath(dir: string): string {
  return join(dir, "cohort_ledger.json");
}

/**
 * Restore a cohort, or start one.
 *
 * `--resume` is required to reuse an existing ledger, so a second launch cannot
 * quietly append to a cohort the operator has forgotten about, and cannot
 * quietly start a second one either. `readOnly` is the status path: it reads
 * whatever exists without requiring the flag, and can write nothing.
 */
function restoreLedger(
  authorities: FrozenAuthorities, args: LaunchArgs, readOnly = false,
): { readonly ledger: CohortLedger; readonly restored: boolean; readonly issues: readonly string[] } {
  const path = cohortPath(args.cohortDir);
  let persisted: PersistedCohort | null = null;
  try {
    persisted = JSON.parse(readFileSync(path, "utf8")) as PersistedCohort;
  } catch {
    persisted = null;
  }
  if (persisted === null) {
    return {
      ledger: new CohortLedger(
        "COHORT", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
      ),
      restored: false,
      issues: [],
    };
  }
  if (!args.resume && !readOnly) {
    throw new Error(
      `a cohort ledger already exists at ${path}. Pass --resume to continue it; the launcher will `
      + "not silently append to, or silently replace, an existing cohort.",
    );
  }
  if (persisted.executorVersion !== M215_EXECUTOR_VERSION) {
    throw new Error(
      `the existing cohort was produced by executor ${persisted.executorVersion}, this is `
      + `${M215_EXECUTOR_VERSION}. A material harness change after outcomes exist invalidates the `
      + "cohort; it is not resumed under a different executor.",
    );
  }
  const restored = CohortLedger.restore(
    "COHORT", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
    persisted.records, persisted.entries, persisted.corrections,
  );
  return { ledger: restored.ledger, restored: true, issues: restored.issues };
}

// ── M217 — the operations ledger, beside the result ledger ──────────

interface PersistedOperations {
  readonly schemaVersion: typeof M217_OPERATIONS_LEDGER_SCHEMA;
  readonly events: readonly OperationalEvent[];
}

function operationsPath(dir: string): string {
  return join(dir, "cohort_operations.json");
}

export function workRootFor(cohortDir: string): string {
  return join(cohortDir, "_work");
}

// ── M218 — the scratch authority, and the launch-time scratch preflight ──

/**
 * One namespace (the cohort work root, marked), one registry and one evidence
 * directory beside it, and the host liveness probe. The registry and the
 * evidence live OUTSIDE the namespace by construction, so cleaning scratch can
 * never delete its own ownership record or the run's evidence.
 */
export function buildScratchAuthority(cohortDir: string, now: () => string): ScratchAuthority {
  const namespace = establishNamespace(workRootFor(cohortDir), {
    experiment: M214_EXPERIMENT_NAME, cohortDir, now,
  });
  return new ScratchAuthority({
    namespace,
    registry: new ScratchRegistry(join(cohortDir, M218_REGISTRY_DIRNAME)),
    evidenceDir: join(cohortDir, M218_EVIDENCE_DIRNAME),
    liveness: new HostLivenessProbe(),
    experiment: M214_EXPERIMENT_NAME,
    executorVersion: M215_EXECUTOR_VERSION,
    now,
  });
}

/**
 * §22, §25, §33 — before the first row and on resume: sweep stale owned
 * scratch, gate capacity, and report image availability. Each is an
 * operational event; a blocking one moves continuation to BLOCKED through the
 * same ledger the isolation interlock uses.
 */
export function scratchPreflight(
  operations: CohortOperations, scratch: ScratchAuthority, manifest: readonly RunManifestRow[],
  resultsDir: string = RESULTS_DIR,
): readonly string[] {
  const issues: string[] = [];
  const sweep = scratch.sweep();
  operations.recordScratchEvent("SCRATCH_STALE_SWEEP", !sweep.pass, {
    sweep,
    reasons: sweep.blocking.map((path) => {
      const entry = sweep.entries.find((candidate) => candidate.path === path);
      return `${path}: ${entry?.classification ?? "?"} — ${entry?.reason ?? ""}`;
    }),
    verdict: sweep.pass ? "SCRATCH_NAMESPACE_CLEAN" : "STALE_OR_UNKNOWN_SCRATCH_BEFORE_LAUNCH",
  });
  if (!sweep.pass) {
    issues.push(`stale or unknown owned scratch under ${sweep.namespaceRoot}: ${sweep.blocking.join(", ")}`);
  }
  const gate = scratch.capacityGate();
  const images = imageAvailability(manifest.map((row) => row.containerImage));
  // M219 §7, §8 — once the materialization identity record exists, every row
  // must also resolve (without a pull) to the recorded immutable image id.
  const identity = imageIdentityPreflight(manifest, resultsDir);
  operations.recordScratchEvent("SCRATCH_CAPACITY_GATE", !gate.pass, {
    gate, images, policy: M218_SCRATCH_POLICY,
    imageIdentity: identity === null ? null : { verdict: identity.verdict, rowsResolved: identity.rowsResolved, rowsIdentityVerified: identity.rowsIdentityVerified, issues: identity.issues.slice(0, 20) },
    reasons: gate.issues,
    verdict: gate.pass ? "CAPACITY_SUFFICIENT" : "CAPACITY_INSUFFICIENT",
  });
  if (!gate.pass) issues.push(...gate.issues);
  if (images.missing.length > 0) {
    issues.push(`${images.missing.length} of ${images.required} manifest images are absent from the local Docker store; ${images.note}`);
  }
  if (identity !== null && identity.verdict !== "IMAGE_PREFLIGHT_PASS") {
    issues.push(`image identity preflight failed for ${identity.issues.length} row check(s): ${identity.issues.slice(0, 5).join("; ")}`);
  }
  return issues;
}

/** M219 — the identity record is optional until materialization has been recorded; absent, name presence governs alone. */
export function imageIdentityPreflight(manifest: readonly RunManifestRow[], resultsDir: string): ImagePreflight | null {
  const path = join(resultsDir, M219_IMAGE_IDENTITY_FILE);
  if (!existsSync(path)) return null;
  const record = JSON.parse(readFileSync(path, "utf8")) as ImageIdentityRecord;
  return imagePreflight(manifest, record, dockerImageInspector);
}

/**
 * Restore the operations ledger, or start one.
 *
 * A result ledger that exists without an operations ledger is a cohort whose
 * isolation history is unknown, and is refused: the state it would resume in
 * cannot be proven SAFE, and CohortOperations has no way to say "unknown".
 */
function restoreOperations(
  args: LaunchArgs, resultLedgerRestored: boolean,
): { readonly ledger: CohortOperationsLedger; readonly issues: readonly string[] } {
  const path = operationsPath(args.cohortDir);
  let persisted: PersistedOperations | null = null;
  try {
    persisted = JSON.parse(readFileSync(path, "utf8")) as PersistedOperations;
  } catch {
    persisted = null;
  }
  if (persisted === null) {
    if (resultLedgerRestored) {
      throw new Error(
        `the cohort at ${args.cohortDir} has a result ledger but no operations ledger at ${path}; `
        + "its isolation history is unknown and continuation safety cannot be proven, so it is "
        + "not resumed",
      );
    }
    return { ledger: new CohortOperationsLedger(), issues: [] };
  }
  if (persisted.schemaVersion !== M217_OPERATIONS_LEDGER_SCHEMA) {
    throw new Error(
      `operations ledger schema ${persisted.schemaVersion} is not ${M217_OPERATIONS_LEDGER_SCHEMA}`,
    );
  }
  return CohortOperationsLedger.restore(persisted.events);
}

function persistOperations(dir: string, ledger: CohortOperationsLedger): string {
  mkdirSync(dir, { recursive: true });
  const document: PersistedOperations = {
    schemaVersion: M217_OPERATIONS_LEDGER_SCHEMA,
    events: ledger.events,
  };
  const path = operationsPath(dir);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}

function persistLedger(dir: string, ledger: CohortLedger): string {
  mkdirSync(dir, { recursive: true });
  const document: PersistedCohort = {
    schemaVersion: M215_LEDGER_SCHEMA,
    preregistrationHash: ledger.preregistrationHash,
    manifestHash: ledger.manifestHash,
    executorVersion: M215_EXECUTOR_VERSION,
    records: ledger.records,
    entries: ledger.entries,
    corrections: ledger.corrections,
  };
  const path = cohortPath(dir);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}

// ── M220 — pause requests, the session journal and the status view ──

export function pauseRequestPath(cohortDir: string): string {
  return join(cohortDir, M220_PAUSE_REQUEST_FILE);
}

export function readPauseRequest(cohortDir: string): PauseRequest | null {
  const path = pauseRequestPath(cohortDir);
  if (!existsSync(path)) return null;
  return parsePauseRequest(readFileSync(path, "utf8"));
}

export function writePauseRequest(cohortDir: string, kind: PauseRequestKind, requestedBy: string, now: () => string): string {
  mkdirSync(cohortDir, { recursive: true });
  const path = pauseRequestPath(cohortDir);
  writeFileSync(path, `${JSON.stringify(pauseRequestDocument(kind, now(), requestedBy), null, 2)}\n`);
  return path;
}

export function clearPauseRequest(cohortDir: string): boolean {
  const path = pauseRequestPath(cohortDir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * The journal, the pair-timing metadata and the status view are all DERIVED
 * from the two ledgers, written after every persist. The status view is
 * checked against the outcome-shaped key pattern before it is written: a
 * status that could leak an interim result is a defect, not a document.
 */
export function persistSessionDocuments(
  dir: string, manifest: readonly RunManifestRow[], ledger: CohortLedger, operations: CohortOperationsLedger,
  extra: { readonly subscriptionAuthState: string | null; readonly scratchFreeBytes: number | null; readonly now: () => string },
): { readonly journal: string; readonly timing: string; readonly status: string } {
  mkdirSync(dir, { recursive: true });
  const journal = deriveSessionJournal(operations.events, ledger);
  const pairs = frozenPairs(manifest);
  const timing = pairTemporalGaps(pairs, ledger, journal);
  const operational = cohortOperationalStatus(manifest, ledger, operations);
  const status = sessionStatusView({
    manifest, ledger, events: operations.events,
    operationalStatus: operational.status, continuationState: operations.state(),
    pauseRequest: readPauseRequest(dir), subscriptionAuthState: extra.subscriptionAuthState,
    scratchFreeBytes: extra.scratchFreeBytes, now: extra.now(), nextRow: selectNextRow(manifest, ledger),
  });
  const leaks = statusViewLeaksOutcome(status);
  if (leaks.length > 0) throw new Error(`refusing to write a session status that names an outcome: ${leaks.join(", ")}`);
  const journalPath = join(dir, "cohort_session_journal.json");
  writeFileSync(journalPath, `${JSON.stringify({
    schemaVersion: M220_SESSION_JOURNAL_SCHEMA, derivedFromOperationsChainHead: operations.headChainDigest(),
    sessions: journal, outcomeLabels: "none by construction", generatedAt: extra.now(),
  }, null, 2)}\n`);
  const timingPath = join(dir, "cohort_pair_timing.json");
  writeFileSync(timingPath, `${JSON.stringify({ ...timing, schemaVersion: M220_PAIR_TIMING_SCHEMA, generatedAt: extra.now() }, null, 2)}\n`);
  const statusPath = join(dir, "cohort_session_status.json");
  writeFileSync(statusPath, `${JSON.stringify({ ...status, generatedAt: extra.now() }, null, 2)}\n`);
  return { journal: journalPath, timing: timingPath, status: statusPath };
}

/** M220 §37–§39 — the identities a session must re-prove before its first row. */
export interface SessionIdentityPreflight {
  readonly agent: { readonly ok: boolean; readonly detail: string; readonly pinnedBinary: string; readonly version: string };
  readonly treatment: { readonly ok: boolean; readonly detail: string; readonly headSrc: string; readonly srcWorktreeClean: boolean };
  readonly issues: readonly string[];
}

export function sessionIdentityPreflight(manifest: readonly RunManifestRow[], vtraceRoot: string = VTRACE_ROOT): SessionIdentityPreflight {
  const agent = resolveAgentBinary();
  let headSrc = "";
  let dirty = "";
  let treatmentIssues: readonly string[] = [];
  try {
    headSrc = execFileSync("git", ["-C", vtraceRoot, "rev-parse", "HEAD:src"], { encoding: "utf8" }).trim();
    dirty = execFileSync("git", ["-C", vtraceRoot, "status", "--porcelain", "--", "src"], { encoding: "utf8" }).trim();
    treatmentIssues = auditFrozenTreatmentTree(manifest, headSrc);
  } catch (error) {
    treatmentIssues = [`could not read the VTRACE product tree: ${(error as Error).message}`];
  }
  const srcClean = dirty.length === 0;
  const issues: string[] = [
    ...agent.issues,
    ...treatmentIssues,
    ...(srcClean ? [] : [`the VTRACE src/ working tree has uncommitted changes; the treatment the agent would run is not HEAD:src: ${dirty.split("\n").slice(0, 5).join(" | ")}`]),
  ];
  return {
    agent: { ok: agent.issues.length === 0, detail: agent.issues.join("; ") || `pinned ${agent.binary} reports ${agent.pinnedBinaryVersion}; declared symlink reports ${agent.declaredBinaryVersion}`, pinnedBinary: agent.binary, version: agent.pinnedBinaryVersion },
    treatment: { ok: treatmentIssues.length === 0 && srcClean, detail: treatmentIssues.join("; ") || `HEAD:src ${headSrc}${srcClean ? "" : " (src worktree dirty)"}`, headSrc, srcWorktreeClean: srcClean },
    issues: Object.freeze(issues),
  };
}

// ── Plan (§47) ──────────────────────────────────────────────────────

/**
 * What the paid cohort WOULD be, printed without running anything.
 *
 * The plan is deliberately the only thing M215 can execute. It is also the
 * thing an operator should read before authorising: the frozen hashes, the
 * fixed N, the ceiling, and the named reason the launch is not yet possible.
 */
function renderPlan(
  authorities: FrozenAuthorities, args: LaunchArgs, authority: ActiveSpendAuthority | null,
  sessionAuthority: ActiveSessionAuthority | null,
): Record<string, unknown> {
  const binding = bindingFor(args.binding);
  const ledger = new CohortLedger(
    "COHORT", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
  );
  const next = selectNextRow(authorities.manifest, ledger);
  const ceiling = authority?.hardCeilingUsd ?? M215_AUTHORIZED_CEILING_USD;
  return {
    executorVersion: M215_EXECUTOR_VERSION,
    frozenAuthorities: {
      preregistration: authorities.preregistrationHash,
      manifest: authorities.manifestHash,
      externalReference: authorities.externalReferenceHash,
      verified: authorities.verified,
      issues: authorities.issues,
    },
    // M218 §60 — the executable authority is M214 + A1; the plan says which
    // ceiling the launcher will actually enforce and why.
    executableAuthority: authority === null
      ? { bound: false, reason: "the M214_A1 amendment could not be loaded; a COHORT launch is refused" }
      : {
        bound: true,
        amendmentId: authority.amendmentId,
        amendmentHash: authority.amendmentHash,
        identity: authority.executableAuthority.identity,
        lineageIssues: auditExecutableAuthorityBinding(authority, {
          preregistrationHash: authorities.preregistrationHash.actual,
          manifestHash: authorities.manifestHash.actual,
          externalReferenceHash: authorities.externalReferenceHash.actual,
        }),
        launchRisk: amendedLaunchRisk(authority),
      },
    // M220 — and A2 on top of it: the session model the launch will run under.
    sessionAuthority: sessionAuthority === null
      ? { bound: false, reason: `the ${M214_A2_AMENDMENT_ID} amendment could not be loaded; a quota-window session is refused` }
      : {
        bound: true,
        amendmentId: sessionAuthority.amendmentId,
        amendmentHash: sessionAuthority.amendmentHash,
        identity: sessionAuthority.executableAuthority.identity,
        pauseState: sessionAuthority.pauseState,
        quotaInterruptionClass: sessionAuthority.quotaInterruptionClass,
        requiredLaunchArgument: "--max-pairs-this-session N (N >= 1, operator-chosen, outcome-blind)",
        pairsInFrozenOrder: frozenPairs(authorities.manifest).length,
      },
    cohort: {
      design: M214_STOPPING_RULE.design,
      tasks: M214_STOPPING_RULE.tasks,
      arms: M214_STOPPING_RULE.arms,
      intendedRuns: M214_STOPPING_RULE.intendedRuns,
      firstRow: next === undefined ? null : {
        executionOrder: next.executionOrder,
        instanceId: next.instanceId,
        arm: next.arm,
        armOrder: next.armOrder,
      },
    },
    budgets: {
      maxTurns: M214_BUDGET.maxTurns,
      perRunCostCapUsd: M214_BUDGET.perRunCostCapUsd,
      m214CeilingUsd: M215_AUTHORIZED_CEILING_USD,
      activeCeilingUsd: ceiling,
      retryReserveUsd: authority?.retryReserveUsd ?? 0,
      retryReserveAttempts: authority?.retryReserveAttempts ?? 0,
      projection: projectSpend(ledger, authorities.manifest, ceiling),
    },
    concurrency: M215_CONCURRENCY_POLICY,
    scratchPolicy: M218_SCRATCH_POLICY,
    binding: {
      requested: binding.id,
      status: binding.status,
      authoritative: binding.authoritative,
      outstandingWork: binding.outstandingWork,
    },
    availableBindings: M215_ADAPTER_BINDINGS.map((entry) => ({
      id: entry.id, status: entry.status, authoritative: entry.authoritative,
    })),
    spendAuthorizationIssues: auditSpendAuthorization(
      args.authorizeSpend === null ? null : authorizationFor(args.authorizeSpend, authority), "COHORT", ceiling,
    ),
    launchable: authoritativeBindingAvailable() && args.authorizeSpend !== null && authority !== null && sessionAuthority !== null,
  };
}

/**
 * M218 §60 — the operator's authorisation names the ACTIVE ceiling and the
 * amendment that produced it. An authorisation of M214's $700 alone fails P7
 * once A1 is active; there is no "old or new budget" choice.
 */
function authorizationFor(operator: string, authority: ActiveSpendAuthority | null): SpendAuthorization {
  const ceiling = authority?.hardCeilingUsd ?? M215_AUTHORIZED_CEILING_USD;
  return {
    authorized: true,
    authorizedByOperator: operator,
    authorizedCeilingUsd: ceiling,
    authorizedAt: new Date().toISOString(),
    statement:
      `${operator} authorised the $${ceiling} hard ceiling for VTRACE_EXTERNAL_VEXP_100 under `
      + (authority === null
        ? "M214 alone"
        : `M214 + ${authority.amendmentId} (${authority.amendmentHash}; $${authority.ordinaryExposureUsd} ordinary `
          + `+ $${authority.retryReserveUsd} retry reserve for ${authority.retryReserveAttempts} attempts)`)
      + " at the preregistration and manifest hashes recorded on every run.",
  };
}

function tryLoadAuthority(resultsDir: string): { readonly authority: ActiveSpendAuthority | null; readonly error: string | null } {
  try {
    return { authority: loadActiveSpendAuthority(resultsDir), error: null };
  } catch (error) {
    return { authority: null, error: (error as Error).message };
  }
}

function tryLoadSessionAuthority(resultsDir: string): { readonly authority: ActiveSessionAuthority | null; readonly error: string | null } {
  try {
    return { authority: loadActiveSessionAuthority(resultsDir), error: null };
  } catch (error) {
    return { authority: null, error: (error as Error).message };
  }
}

// ── M219 §24, §25 — the production launch preflight, without a launch ──

/**
 * Run the launch checks as far as they can go with no spend authorisation and
 * no row: binding, ledgers, scratch authority, the real bridge, the scratch /
 * capacity / image preflight, the substrate residual-state preflight and the
 * substrate identity. Then evaluate the spend refusal LAST and stop. Nothing
 * here can start an agent: `runCohort` and `executeManifestRow` are not
 * reached, and G36 is never set by this path.
 *
 * Exit 0 means: every technical gate passed and the only blocker is
 * SPEND_AUTHORIZATION_PENDING. Any technical failure exits 1.
 */
async function launchPreflight(
  args: LaunchArgs, authorities: FrozenAuthorities, authority: ActiveSpendAuthority,
  sessionAuthority: ActiveSessionAuthority | null, sessionAuthorityError: string | null,
): Promise<void> {
  const now = (): string => new Date().toISOString();
  const gates: { id: string; pass: boolean; detail: string }[] = [];
  const gate = (id: string, pass: boolean, detail: string): void => { gates.push({ id, pass, detail }); };
  gate("FROZEN_AUTHORITIES", authorities.verified, `preregistration ${authorities.preregistrationHash.actual}; manifest ${authorities.manifestHash.actual}; external reference ${authorities.externalReferenceHash.actual}`);
  const lineage = auditExecutableAuthorityBinding(authority, {
    preregistrationHash: authorities.preregistrationHash.actual,
    manifestHash: authorities.manifestHash.actual,
    externalReferenceHash: authorities.externalReferenceHash.actual,
  });
  gate("EXECUTABLE_AUTHORITY", lineage.length === 0, `${authority.amendmentId} ${authority.amendmentHash}; executable ${authority.executableAuthority.identity}; ${lineage.join("; ") || "lineage binds"}`);
  // M220 — A2 must bind on top of A1.
  const sessionLineage = auditSessionAuthorityBinding(sessionAuthority ?? undefined, {
    preregistrationHash: authorities.preregistrationHash.actual,
    manifestHash: authorities.manifestHash.actual,
    externalReferenceHash: authorities.externalReferenceHash.actual,
    a1AmendmentHash: authority.amendmentHash,
  });
  gate("SESSION_AUTHORITY", sessionAuthority !== null && sessionLineage.length === 0,
    sessionAuthority === null ? (sessionAuthorityError ?? "A2 not loaded") : `${sessionAuthority.amendmentId} ${sessionAuthority.amendmentHash}; executable (M214 + A1 + A2) ${sessionAuthority.executableAuthority.identity}; ${sessionLineage.join("; ") || "lineage binds"}`);
  gate("SPEND_ENVELOPE", authority.hardCeilingUsd === 735 && authority.retryReserveUsd === 35 && authority.retryReserveAttempts === 10 && authority.ordinaryExposureUsd === 700,
    `$${authority.ordinaryExposureUsd} ordinary + $${authority.retryReserveUsd} retry reserve (${authority.retryReserveAttempts} attempts) = $${authority.hardCeilingUsd} hard ceiling; manifest rows ${authorities.manifest.length}`);
  let binding: ReturnType<typeof assertBindingUsable> | null = null;
  try {
    binding = assertBindingUsable(args.binding);
    gate("BINDING", binding.authoritative, `${binding.id} ${binding.status} authoritative=${binding.authoritative}`);
  } catch (error) {
    gate("BINDING", false, (error as Error).message);
  }
  let ledgerState = "new cohort";
  let operationsEvents: readonly OperationalEvent[] = [];
  try {
    const restored = restoreLedger(authorities, args, true);
    ledgerState = restored.restored ? `resumed (${restored.issues.length} issues)` : "new cohort";
    const operationsRestored = restoreOperations(args, restored.restored);
    operationsEvents = operationsRestored.ledger.events;
    gate("LEDGERS", restored.issues.length === 0 && operationsRestored.issues.length === 0, `${ledgerState}; operations ${operationsRestored.ledger.events.length} events`);
  } catch (error) {
    gate("LEDGERS", false, (error as Error).message);
  }
  const scratch = buildScratchAuthority(args.cohortDir, now);
  gate("SCRATCH_NAMESPACE", existsSync(scratch.namespace.markerPath), `${scratch.namespace.canonicalRoot} marked for ${scratch.namespace.experiment}`);

  // M220 §37–§39 — agent binary, treatment tree and the quota window.
  const identity = sessionIdentityPreflight(authorities.manifest);
  gate("AGENT_IDENTITY", identity.agent.ok, identity.agent.detail);
  gate("TREATMENT_TREE", identity.treatment.ok, identity.treatment.detail);
  const windowIssues = quotaWindowGate(lastHardQuotaLimit(operationsEvents), now());
  gate("QUOTA_WINDOW", windowIssues.length === 0, windowIssues.join("; ") || "no unexpired hard quota limit on record");
  const pending = readPauseRequest(args.cohortDir);
  gate("PAUSE_REQUEST", true, pending === null ? "no pause request pending" : `pause request pending: ${pending.kind} at ${pending.requestedAt} (a launch would pause before its first new pair)`);

  let substrate: Record<string, unknown> | null = null;
  let scratchIssues: readonly string[] = [];
  let isolation = "NOT_RUN";
  let residualIssues: readonly string[] = [];
  if (binding !== null && binding.id === "DOCKER_SWEBENCH") {
    const live = await startCohortBinding({
      benchmarkDir: import.meta.dir, manifestPath: join(args.resultsDir, M215_MANIFEST_FILE),
      manifest: authorities.manifest, workRoot: workRootFor(args.cohortDir), scratch,
    });
    try {
      substrate = (await live.bridge.identity()) as unknown as Record<string, unknown>;
      const operations = new CohortOperations(new CohortOperationsLedger(), live.probe, workRootFor(args.cohortDir), now);
      scratchIssues = scratchPreflight(operations, scratch, authorities.manifest, args.resultsDir);
      const preflight = await operations.recordLaunchPreflight();
      isolation = operations.state();
      residualIssues = residualStateIssues((preflight.detail as { residual: Parameters<typeof residualStateIssues>[0] }).residual);
    } finally {
      await live.bridge.shutdown();
    }
    gate("SUBSTRATE_IDENTITY", substrate !== null && Number(substrate.frozenPopulationSize) === 100, JSON.stringify(substrate));
    gate("SCRATCH_CAPACITY_IMAGES", scratchIssues.length === 0, scratchIssues.join("; ") || "sweep clean; P13 capacity pass; every manifest image present and identity-verified");
    gate("ISOLATION_PREFLIGHT", isolation === "CONTINUATION_SAFE", `${isolation}; ${residualIssues.join("; ") || "no residual substrate state"}`);
  }

  // The spend refusal is evaluated LAST and is the only gate this path is
  // allowed to fail while still exiting 0.
  const spendIssues = auditSpendAuthorization(
    args.authorizeSpend === null ? null : authorizationFor(args.authorizeSpend, authority), "COHORT", authority.hardCeilingUsd,
  );
  const technicalBlockers = gates.filter((entry) => !entry.pass).map((entry) => entry.id);
  const spendPending = args.authorizeSpend === null || spendIssues.length > 0;
  const document = {
    schemaVersion: "stage5.m219.launch-preflight.v1",
    generatedAt: now(),
    executorVersion: M215_EXECUTOR_VERSION,
    mode: "PREFLIGHT_NO_LAUNCH",
    gates,
    technicalBlockers,
    spendAuthorization: {
      present: args.authorizeSpend !== null,
      issues: spendIssues,
      status: spendPending ? "SPEND_AUTHORIZATION_PENDING" : "SPEND_AUTHORIZATION_PRESENT_BUT_PREFLIGHT_RUNS_NO_ROW",
      activeCeilingUsd: authority.hardCeilingUsd,
      retryReserveAttempts: authority.retryReserveAttempts,
    },
    sessionModel: sessionAuthority === null ? null : {
      amendmentId: sessionAuthority.amendmentId,
      requiredLaunchArgument: "--max-pairs-this-session N",
      pauseState: sessionAuthority.pauseState,
      maxPairsThisSessionSupplied: args.maxPairsThisSession,
    },
    finalBlocker: technicalBlockers.length > 0 ? `TECHNICAL: ${technicalBlockers.join(", ")}` : spendPending ? "SPEND_AUTHORIZATION_PENDING" : "NONE (preflight never launches)",
    verdict: technicalBlockers.length === 0 ? "FINAL_ZERO_SPEND_LAUNCH_PREFLIGHT_PASSED" : "FINAL_ZERO_SPEND_LAUNCH_PREFLIGHT_FAILED",
    rowsExecuted: 0,
    agentInvoked: false,
    providerCalls: 0,
    liveModelSpendUsd: 0,
    launchPerformed: false,
  };
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  if (technicalBlockers.length > 0) process.exitCode = 1;
}

// ── M220 §32 — the outcome-blind status, without a bridge ───────────

function printSessionStatus(args: LaunchArgs, authorities: FrozenAuthorities): void {
  const now = (): string => new Date().toISOString();
  const restored = restoreLedger(authorities, args, true);
  const operationsRestored = restoreOperations(args, restored.restored);
  const scratch = buildScratchAuthority(args.cohortDir, now);
  let free: number | null = null;
  try {
    free = scratch.capacityGate().namespaceFilesystem.freeBytes;
  } catch {
    free = null;
  }
  const operational = cohortOperationalStatus(authorities.manifest, restored.ledger, operationsRestored.ledger);
  const view = sessionStatusView({
    manifest: authorities.manifest, ledger: restored.ledger, events: operationsRestored.ledger.events,
    operationalStatus: operational.status, continuationState: operationsRestored.ledger.state(),
    pauseRequest: readPauseRequest(args.cohortDir), subscriptionAuthState: null,
    scratchFreeBytes: free, now: now(), nextRow: selectNextRow(authorities.manifest, restored.ledger),
  });
  const leaks = statusViewLeaksOutcome(view);
  if (leaks.length > 0) throw new Error(`refusing to print a session status that names an outcome: ${leaks.join(", ")}`);
  process.stdout.write(`${JSON.stringify({
    ...view,
    ledgerIssues: [...restored.issues, ...operationsRestored.issues],
    journal: deriveSessionJournal(operationsRestored.ledger.events, restored.ledger).map((entry) => ({
      sessionId: entry.sessionId, startedAt: entry.startedAt, endedAt: entry.endedAt, endState: entry.endState,
      pauseReason: entry.pauseReason, pairsPlanned: entry.pairsPlanned, pairsCompleted: entry.pairsCompleted,
      rowsSettled: entry.rowsSettled, pairSplitOccurred: entry.pairSplitOccurred,
    })),
    runsNothing: true,
  }, null, 2)}\n`);
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseLaunchArgs(process.argv.slice(2));
  const authorities = loadAuthorities(args.resultsDir);
  if (!authorities.verified) {
    throw new Error(
      "frozen authorities do not recompute; refusing to launch: " + authorities.issues.join("; "),
    );
  }

  const loaded = tryLoadAuthority(args.resultsDir);
  const loadedSession = tryLoadSessionAuthority(args.resultsDir);
  if (args.plan) {
    process.stdout.write(`${JSON.stringify({
      ...renderPlan(authorities, args, loaded.authority, loadedSession.authority),
      ...(loaded.error === null ? {} : { executableAuthorityError: loaded.error }),
      ...(loadedSession.error === null ? {} : { sessionAuthorityError: loadedSession.error }),
    }, null, 2)}\n`);
    return;
  }

  // M220 §32 — status runs nothing and needs no authorisation, binding or bridge.
  if (args.sessionStatus) {
    printSessionStatus(args, authorities);
    return;
  }

  // M220 §12 — pause requests and their clearance. Alone, they write the
  // request for a running (or the next) session and run nothing. With a
  // launch, the request is written first so the session honours it in-process.
  const now = (): string => new Date().toISOString();
  if (args.clearPauseRequest) {
    const cleared = clearPauseRequest(args.cohortDir);
    process.stdout.write(`${JSON.stringify({ pauseRequestCleared: cleared, path: pauseRequestPath(args.cohortDir) })}\n`);
    if (args.authorizeSpend === null) return;
  }
  if (args.pauseAfterCurrentPair || args.pauseAfterCurrentArm) {
    const kind: PauseRequestKind = args.pauseAfterCurrentArm ? "AFTER_CURRENT_ARM" : "AFTER_CURRENT_PAIR";
    const path = writePauseRequest(args.cohortDir, kind, args.authorizeSpend ?? "operator", now);
    if (args.authorizeSpend === null) {
      process.stdout.write(`${JSON.stringify({
        pauseRequested: kind, path,
        effect: kind === "AFTER_CURRENT_ARM"
          ? "a running session stops after the current arm (recording PAIR_SPLIT_BY_QUOTA_WINDOW if that splits a pair); an idle cohort will not begin another arm until the request is honoured or cleared"
          : "a running session finishes the current pair and pauses; an idle cohort will not begin another pair until the request is honoured or cleared",
        runsNothing: true,
      }, null, 2)}\n`);
      return;
    }
  }

  // M218 §60 — the executable authority (M214 + A1) is required before the
  // spend refusal is even evaluated, so the ceiling the operator is asked to
  // authorise is the active one and never M214's alone.
  if (loaded.authority === null) {
    throw new Error(`refusing to launch: ${loaded.error ?? "no executable authority"}`);
  }
  const authority = loaded.authority;
  const lineage = auditExecutableAuthorityBinding(authority, {
    preregistrationHash: authorities.preregistrationHash.actual,
    manifestHash: authorities.manifestHash.actual,
    externalReferenceHash: authorities.externalReferenceHash.actual,
  });
  if (lineage.length > 0) throw new Error(`refusing to launch: executable authority does not bind: ${lineage.join("; ")}`);

  // M219 §24 — the zero-spend launch preflight: every technical check the
  // launch would make, in launch order, then the spend refusal — and no row.
  if (args.preflight) {
    await launchPreflight(args, authorities, authority, loadedSession.authority, loadedSession.error);
    return;
  }

  // Both refusals below are ordered before anything expensive, and neither is
  // recoverable by another flag.
  if (args.authorizeSpend === null) {
    throw new Error(
      "refusing to launch: no spend authorisation. A COHORT run makes paid model calls against the "
      + `active $${authority.hardCeilingUsd} hard ceiling (M214 + ${authority.amendmentId}) and requires `
      + "--authorize-spend \"<operator>\". Technical readiness is not financial authorisation.",
    );
  }
  // M220 §4, §8 — A2 is the active session authority, and a cohort loop needs
  // an explicit, operator-chosen pair cap. Neither is inferable.
  if (loadedSession.authority === null) {
    throw new Error(`refusing to launch: ${loadedSession.error ?? "no session authority"}`);
  }
  const sessionAuthority = loadedSession.authority;
  const sessionLineage = auditSessionAuthorityBinding(sessionAuthority, {
    preregistrationHash: authorities.preregistrationHash.actual,
    manifestHash: authorities.manifestHash.actual,
    externalReferenceHash: authorities.externalReferenceHash.actual,
    a1AmendmentHash: authority.amendmentHash,
  });
  if (sessionLineage.length > 0) throw new Error(`refusing to launch: session authority does not bind: ${sessionLineage.join("; ")}`);
  if (args.row === null && args.maxPairsThisSession === null) {
    throw new Error(
      `refusing to launch: no per-session pair cap. Under M214 + A1 + ${M214_A2_AMENDMENT_ID} a COHORT launch `
      + "runs in outcome-blind quota-window sessions and requires --max-pairs-this-session N (N >= 1, chosen "
      + "by the operator from their own usage view). There is no continuous-launch mode and no task selector.",
    );
  }
  const binding = assertBindingUsable(args.binding);
  if (!binding.authoritative) {
    throw new Error(
      `binding ${binding.id} cannot produce authoritative cohort outcomes; it exists to falsify the `
      + "executor, not to run the experiment",
    );
  }

  const { ledger, restored, issues } = restoreLedger(authorities, args);
  if (issues.length > 0) {
    throw new Error(`refusing to resume a cohort whose ledger does not verify: ${issues.join("; ")}`);
  }
  const operationsRestored = restoreOperations(args, restored);
  if (operationsRestored.issues.length > 0) {
    throw new Error(
      `refusing to resume a cohort whose operations ledger does not verify: `
      + operationsRestored.issues.join("; "),
    );
  }
  const workRoot = workRootFor(args.cohortDir);

  // M217 §12 — recovery is its own action. It needs the probe and nothing
  // else, runs no row, and leaves an event saying what it verified.
  // M218 — the scratch authority exists before anything can create scratch,
  // and the recovery path's probe is ownership-aware.
  const scratch = buildScratchAuthority(args.cohortDir, now);

  if (args.recoverIsolation) {
    if (!args.resume) throw new Error("--recover-isolation requires --resume: recovery is for an existing cohort");
    const bridge = await SubstrateBridge.start({
      benchmarkDir: import.meta.dir, manifestPath: join(args.resultsDir, M215_MANIFEST_FILE),
    });
    try {
      const operations = new CohortOperations(
        operationsRestored.ledger,
        new ScratchAwareIsolationProbe(new M217IsolationProbe(bridge), scratch, now),
        workRoot, now,
      );
      const event = await operations.recover();
      const path = persistOperations(args.cohortDir, operationsRestored.ledger);
      process.stdout.write(`${JSON.stringify({
        recovery: event.kind,
        continuation: operations.state(),
        operations: path,
        progress: renderProgress(authorities.manifest, ledger, null, [], operations, scratch),
      }, null, 2)}\n`);
    } finally {
      await bridge.shutdown();
    }
    return;
  }

  // M217 — the DOCKER_SWEBENCH adapters are constructed by the one factory
  // the real-substrate controls also exercise; there is no second way to
  // obtain them and no property a binding could fail to declare.
  if (binding.id !== "DOCKER_SWEBENCH") {
    throw new Error(`binding ${binding.id} has no production adapter factory`);
  }
  const live = await startCohortBinding({
    benchmarkDir: import.meta.dir,
    manifestPath: join(args.resultsDir, M215_MANIFEST_FILE),
    manifest: authorities.manifest,
    workRoot,
    scratch,
  });
  try {
    const operations = new CohortOperations(operationsRestored.ledger, live.probe, workRoot, now);
    const deps: ExecutorDependencies = {
      mode: "COHORT",
      authorities,
      container: live.container,
      agent: live.agent,
      evaluator: live.evaluator,
      ledger,
      now,
      spendAuthorization: authorizationFor(args.authorizeSpend, authority),
      operations,
      scratch,
      spendAuthority: authority,
      sessionAuthority,
    };
    const persistAll = (): void => {
      persistLedger(args.cohortDir, ledger);
      persistOperations(args.cohortDir, operationsRestored.ledger);
      let free: number | null = null;
      try {
        free = scratch.capacityGate().namespaceFilesystem.freeBytes;
      } catch {
        free = null;
      }
      persistSessionDocuments(args.cohortDir, authorities.manifest, ledger, operationsRestored.ledger, {
        subscriptionAuthState: null, scratchFreeBytes: free, now,
      });
    };

    // M218 §22, §25 — stale owned scratch, capacity and image availability
    // are checked before the substrate enumeration, so a host that cannot
    // safely hold one more attempt is refused before a container exists.
    const scratchIssues = scratchPreflight(operations, scratch, authorities.manifest, args.resultsDir);
    if (scratchIssues.length > 0) {
      persistAll();
      throw new Error(
        `refusing to launch: ${scratchIssues.join("; ")}. Stale owned scratch is recovered through `
        + "--recover-isolation --resume; unknown paths and capacity are operator decisions.",
      );
    }

    // M217 §7 — a cohort does not START over residue either. The preflight is
    // an operational event, so a refused launch leaves evidence of why.
    const preflight = await operations.recordLaunchPreflight();
    if (operations.state() === "CONTINUATION_BLOCKED") {
      persistAll();
      throw new Error(
        "refusing to launch: residual substrate state under the work root — "
        + residualStateIssues((preflight.detail as { residual: Parameters<typeof residualStateIssues>[0] }).residual)
          .join("; ")
        + ". Run --recover-isolation --resume to remediate and re-verify.",
      );
    }

    // M220 §14, §35–§39 — every session re-proves the identities that can
    // drift across hours or weeks, and the quota window, before its first row.
    const identity = sessionIdentityPreflight(authorities.manifest);
    const windowIssues = quotaWindowGate(lastHardQuotaLimit(operationsRestored.ledger.events), now());
    const sessionIssues = [...identity.issues, ...windowIssues];
    if (sessionIssues.length > 0) {
      persistAll();
      throw new Error(`refusing to start a session: ${sessionIssues.join("; ")}`);
    }

    // M220 §40, §41 — the session begins as an operational event; the journal
    // is derived from it and its end event.
    const sessionNumber = nextSessionNumber(operationsRestored.ledger.events);
    const sessionId = sessionIdFor(sessionNumber);
    const startedAt = now();
    const deadlineAt = args.maxSessionWallClockSeconds === null
      ? null
      : new Date(Date.parse(startedAt) + args.maxSessionWallClockSeconds * 1000).toISOString();
    const maxPairs = args.maxPairsThisSession ?? 1;
    const imageIdentity = imageIdentityPreflight(authorities.manifest, args.resultsDir);
    operations.recordSessionEvent("QUOTA_SESSION_STARTED", {
      sessionId, sessionNumber, maxPairs, deadlineAt,
      startingNextRowOrdinal: selectNextRow(authorities.manifest, ledger)?.executionOrder ?? null,
      ledgerEntriesBefore: ledger.entries.length,
      pauseRequestPending: readPauseRequest(args.cohortDir)?.kind ?? null,
      agentIdentity: { pinnedBinary: identity.agent.pinnedBinary, version: identity.agent.version },
      treatmentTree: identity.treatment.headSrc,
      imagePreflight: imageIdentity?.verdict ?? "NO_IDENTITY_RECORD",
      scratchCapacity: (() => {
        try {
          const gate = scratch.capacityGate();
          return { freeBytes: gate.namespaceFilesystem.freeBytes, requiredFreeBytes: gate.requiredFreeBytes, pass: gate.pass };
        } catch {
          return null;
        }
      })(),
      executableAuthority: sessionAuthority.executableAuthority.identity,
      directRow: args.row,
    });
    const bounds: SessionBounds = {
      sessionId, maxPairs, deadlineAt,
      pauseRequest: () => readPauseRequest(args.cohortDir),
      acknowledgePauseRequest: () => { clearPauseRequest(args.cohortDir); },
    };

    let report: CohortRunReport | null = null;
    let failure: string | null = null;
    try {
      if (args.row !== null) {
        const row = resolveManifestRow(authorities.manifest, { runId: args.row });
        await executeManifestRow(deps, { runId: row.runId });
      } else {
        report = await runCohort(deps, {
          ...(args.maxRows === null ? {} : { maxRows: args.maxRows }),
          session: bounds,
        });
      }
    } catch (error) {
      failure = (error as Error).message;
      throw error;
    } finally {
      // M220 §34 — before the session may report itself paused the whole work
      // root is enumerated again; residue blocks. Then the end event, then
      // both ledgers and the derived documents, whatever happened.
      const check = await operations.recordSessionEndCheck(sessionId);
      const cleanupResult = String((check.detail as { verdict: string }).verdict);
      const counters = report?.session?.counters ?? null;
      const overage = counters !== null && operationsRestored.ledger.events.some((event) =>
        event.kind === "QUOTA_LIMIT_OBSERVED" && event.at >= startedAt && (event.detail as { signal?: unknown }).signal === "PAID_OVERAGE_IN_USE");
      const endState = failure !== null ? "HALTED"
        : operations.state() === "CONTINUATION_BLOCKED" ? "HALTED"
          : report?.session?.endState === "PAUSED" ? "PAUSED"
            : report?.session?.endState === "COMPLETE" && selectNextRow(authorities.manifest, ledger) === undefined ? "COMPLETE"
              : report?.session?.endState ?? "PAUSED";
      operations.recordSessionEvent("QUOTA_SESSION_ENDED", {
        sessionId, sessionNumber, endState,
        pauseReason: endState === "PAUSED" ? (report?.session?.pauseReason ?? (args.row !== null ? "DIRECT_ROW_COMPLETE" : null)) : null,
        stoppedBecause: failure ?? report?.stoppedBecause ?? "direct row complete",
        counters,
        endingNextRowOrdinal: selectNextRow(authorities.manifest, ledger)?.executionOrder ?? null,
        ledgerEntriesAfter: ledger.entries.length,
        cleanupResult,
        continuationState: operations.state(),
        incrementalBilledProviderSpend: overage ? "UNKNOWN_OVERAGE_OBSERVED" : "$0 (subscription mode; no paid overage observed)",
        pauseState: endState === "PAUSED" && operations.state() === "CONTINUATION_SAFE" ? M220_PAUSED_STATUS : null,
      });
      persistAll();
    }

    const operational = cohortOperationalStatus(authorities.manifest, ledger, operationsRestored.ledger, authority.hardCeilingUsd);
    process.stdout.write(`${JSON.stringify({
      resumed: restored,
      sessionId,
      session: report?.session ?? null,
      stoppedBecause: report?.stoppedBecause ?? null,
      operationalStatus: operational.status,
      ledger: cohortPath(args.cohortDir),
      operations: operationsPath(args.cohortDir),
      journal: join(args.cohortDir, "cohort_session_journal.json"),
      progress: renderProgress(authorities.manifest, ledger, null, [], operations, scratch, authority),
    }, null, 2)}\n`);
  } finally {
    await live.bridge.shutdown();
  }
}

// Guarded so the argument parser can be imported and tested without the import
// itself attempting a launch.
if (import.meta.main) await main();
