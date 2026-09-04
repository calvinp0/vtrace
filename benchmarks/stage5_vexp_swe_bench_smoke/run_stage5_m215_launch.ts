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
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import { M214_BUDGET, M214_STOPPING_RULE } from "./m214Preregistration";
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
}

const OPERATIONAL_FLAGS: readonly string[] = Object.freeze([
  "--binding", "--results", "--cohort-dir", "--authorize-spend", "--resume", "--plan", "--row",
  "--max-rows",
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
    if (name === "--resume" || name === "--plan") {
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

  // Unreachable today: no authoritative binding is implemented, so
  // `assertBindingUsable` above has already thrown. The wiring is kept whole so
  // that implementing the binding is the ONLY remaining step.
  const adapters = (binding as unknown as { adapters?: never }).adapters;
  if (adapters === undefined) {
    throw new Error(`binding ${binding.id} declares no adapters`);
  }

  const deps: ExecutorDependencies = {
    mode: "COHORT",
    authorities,
    container: (adapters as ExecutorDependencies).container,
    agent: (adapters as ExecutorDependencies).agent,
    evaluator: (adapters as ExecutorDependencies).evaluator,
    ledger,
    now: () => new Date().toISOString(),
    spendAuthorization: authorizationFor(args.authorizeSpend),
  };

  if (args.row !== null) {
    const row = resolveManifestRow(authorities.manifest, { runId: args.row });
    await executeManifestRow(deps, { runId: row.runId });
  } else {
    await runCohort(deps, args.maxRows === null ? {} : { maxRows: args.maxRows });
  }

  const path = persistLedger(args.cohortDir, ledger);
  process.stdout.write(`${JSON.stringify({
    resumed: restored,
    ledger: path,
    progress: renderProgress(authorities.manifest, ledger, null),
  }, null, 2)}\n`);
}

// Guarded so the argument parser can be imported and tested without the import
// itself attempting a launch.
if (import.meta.main) await main();
