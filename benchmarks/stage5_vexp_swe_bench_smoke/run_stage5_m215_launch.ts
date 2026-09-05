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
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const RESULTS_DIR = join(import.meta.dir, "results");

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
}

const OPERATIONAL_FLAGS: readonly string[] = Object.freeze([
  "--binding", "--results", "--cohort-dir", "--authorize-spend", "--resume", "--plan", "--row",
  "--max-rows", "--recover-isolation",
]);

/**
 * Parse, refusing anything that could change an outcome.
 *
 * Unknown flags are refused rather than ignored, and a flag whose name matches a
 * frozen property gets a message saying which property and why — an operator who
 * reaches for `--model` should learn that the model is frozen, not that the flag
 * was typed wrong.
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
        + OPERATIONAL_FLAGS.join(", "),
      );
    }
    if (token.includes("=")) {
      args[name] = token.slice(token.indexOf("=") + 1);
      continue;
    }
    const next = argv[index + 1];
    if (name === "--resume" || name === "--plan" || name === "--recover-isolation") {
      args[name] = true;
      continue;
    }
    if (next === undefined || next.startsWith("--")) throw new Error(`${name} needs a value`);
    args[name] = next;
    index += 1;
  }

  const resultsDir = String(args["--results"] ?? RESULTS_DIR);
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
 * quietly start a second one either.
 */
function restoreLedger(
  authorities: FrozenAuthorities, args: LaunchArgs,
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
  if (!args.resume) {
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
  operations.recordScratchEvent("SCRATCH_CAPACITY_GATE", !gate.pass, {
    gate, images, policy: M218_SCRATCH_POLICY,
    reasons: gate.issues,
    verdict: gate.pass ? "CAPACITY_SUFFICIENT" : "CAPACITY_INSUFFICIENT",
  });
  if (!gate.pass) issues.push(...gate.issues);
  if (images.missing.length > 0) {
    issues.push(`${images.missing.length} of ${images.required} manifest images are absent from the local Docker store; ${images.note}`);
  }
  return issues;
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

// ── Plan (§47) ──────────────────────────────────────────────────────

/**
 * What the paid cohort WOULD be, printed without running anything.
 *
 * The plan is deliberately the only thing M215 can execute. It is also the
 * thing an operator should read before authorising: the frozen hashes, the
 * fixed N, the ceiling, and the named reason the launch is not yet possible.
 */
function renderPlan(authorities: FrozenAuthorities, args: LaunchArgs): Record<string, unknown> {
  const binding = bindingFor(args.binding);
  const ledger = new CohortLedger(
    "COHORT", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
  );
  const next = selectNextRow(authorities.manifest, ledger);
  return {
    executorVersion: M215_EXECUTOR_VERSION,
    frozenAuthorities: {
      preregistration: authorities.preregistrationHash,
      manifest: authorities.manifestHash,
      externalReference: authorities.externalReferenceHash,
      verified: authorities.verified,
      issues: authorities.issues,
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
      authorizedCeilingUsd: M215_AUTHORIZED_CEILING_USD,
      projection: projectSpend(ledger, authorities.manifest),
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
      args.authorizeSpend === null ? null : authorizationFor(args.authorizeSpend), "COHORT",
    ),
    launchable: authoritativeBindingAvailable() && args.authorizeSpend !== null,
  };
}

function authorizationFor(operator: string): SpendAuthorization {
  return {
    authorized: true,
    authorizedByOperator: operator,
    authorizedCeilingUsd: M215_AUTHORIZED_CEILING_USD,
    authorizedAt: new Date().toISOString(),
    statement:
      `${operator} authorised the frozen $${M215_AUTHORIZED_CEILING_USD} ceiling for `
      + "VTRACE_EXTERNAL_VEXP_100 at the preregistration and manifest hashes recorded on every run.",
  };
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

  if (args.plan) {
    process.stdout.write(`${JSON.stringify(renderPlan(authorities, args), null, 2)}\n`);
    return;
  }

  // Both refusals below are ordered before anything expensive, and neither is
  // recoverable by another flag.
  if (args.authorizeSpend === null) {
    throw new Error(
      "refusing to launch: no spend authorisation. A COHORT run makes paid model calls against a "
      + `frozen $${M215_AUTHORIZED_CEILING_USD} ceiling and requires --authorize-spend "<operator>". `
      + "Technical readiness is not financial authorisation.",
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
  const now = (): string => new Date().toISOString();

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
      spendAuthorization: authorizationFor(args.authorizeSpend),
      operations,
      scratch,
    };

    // M218 §22, §25 — stale owned scratch, capacity and image availability
    // are checked before the substrate enumeration, so a host that cannot
    // safely hold one more attempt is refused before a container exists.
    const scratchIssues = scratchPreflight(operations, scratch, authorities.manifest);
    if (scratchIssues.length > 0) {
      persistOperations(args.cohortDir, operationsRestored.ledger);
      persistLedger(args.cohortDir, ledger);
      throw new Error(
        `refusing to launch: ${scratchIssues.join("; ")}. Stale owned scratch is recovered through `
        + "--recover-isolation --resume; unknown paths and capacity are operator decisions.",
      );
    }

    // M217 §7 — a cohort does not START over residue either. The preflight is
    // an operational event, so a refused launch leaves evidence of why.
    const preflight = await operations.recordLaunchPreflight();
    if (operations.state() === "CONTINUATION_BLOCKED") {
      persistOperations(args.cohortDir, operationsRestored.ledger);
      persistLedger(args.cohortDir, ledger);
      throw new Error(
        "refusing to launch: residual substrate state under the work root — "
        + residualStateIssues((preflight.detail as { residual: Parameters<typeof residualStateIssues>[0] }).residual)
          .join("; ")
        + ". Run --recover-isolation --resume to remediate and re-verify.",
      );
    }

    try {
      if (args.row !== null) {
        const row = resolveManifestRow(authorities.manifest, { runId: args.row });
        await executeManifestRow(deps, { runId: row.runId });
      } else {
        await runCohort(deps, args.maxRows === null ? {} : { maxRows: args.maxRows });
      }
    } finally {
      // Both ledgers are persisted whatever happened, so a crash mid-row
      // cannot leave a result without its teardown event or vice versa.
      persistLedger(args.cohortDir, ledger);
      persistOperations(args.cohortDir, operationsRestored.ledger);
    }

    process.stdout.write(`${JSON.stringify({
      resumed: restored,
      ledger: cohortPath(args.cohortDir),
      operations: operationsPath(args.cohortDir),
      progress: renderProgress(authorities.manifest, ledger, null, [], operations, scratch),
    }, null, 2)}\n`);
  } finally {
    await live.bridge.shutdown();
  }
}

// Guarded so the argument parser can be imported and tested without the import
// itself attempting a launch.
if (import.meta.main) await main();
