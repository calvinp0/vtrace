/**
 * M215 §44 — the dry-run layers, proving the executor path without spending.
 *
 * D1  full executor path against synthetic adapters, both arms.
 * D2  infrastructure-failure classification and the retry policy.
 * D3  treatment-use telemetry and the intention-to-treat rule.
 * D4  patch capture against REAL git, on a scratch repository outside the
 *     frozen 100, exercising both `.vtrace` routes and the granularity that
 *     makes the exclusion cover the directory rather than three filenames.
 *
 * No frozen benchmark task is executed with a live model, and no provider is
 * contacted at any layer.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m215_dry_run.ts
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import {
  type ExecutorDependencies,
  type FrozenAuthorities,
  M215_CONCURRENCY_POLICY,
  M215_EXECUTOR_VERSION,
  M215_EXTERNAL_REFERENCE_FILE,
  M215_MANIFEST_FILE,
  M215_PREREGISTRATION_FILE,
  auditRuntimeGateCoverage,
  canFinalizeCausalReport,
  derivedPatchExclusions,
  executeManifestRow,
  renderProgress,
  resolveManifestRow,
  retryPermitted,
  runCohort,
  verifyFrozenAuthorities,
} from "./m215LaunchExecutor";
import { CohortLedger, type RunResultRecord } from "./m215CohortLedger";
import { SYNTHETIC_AUTHORIZATION, firstVtraceLeadingOrder } from "./m215Falsification";
import { syntheticAdapters, syntheticClock, syntheticWorld, type SyntheticWorld } from "./m215Fixtures";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m215_dry_run.json");

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8")) as Record<string, unknown>;
}

function loadAuthorities(): FrozenAuthorities {
  const authorities = verifyFrozenAuthorities(
    readJson(M215_PREREGISTRATION_FILE),
    readJson(M215_MANIFEST_FILE) as unknown as { rows: RunManifestRow[]; manifestHash: string },
    readJson(M215_EXTERNAL_REFERENCE_FILE),
  );
  if (!authorities.verified) {
    throw new Error(`frozen authorities do not verify: ${authorities.issues.join("; ")}`);
  }
  return authorities;
}

function ledgerFor(authorities: FrozenAuthorities): CohortLedger {
  return new CohortLedger(
    "SYNTHETIC", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
  );
}

function depsFor(
  authorities: FrozenAuthorities, ledger: CohortLedger, world: SyntheticWorld,
): ExecutorDependencies {
  const adapters = syntheticAdapters(world);
  return {
    mode: "SYNTHETIC",
    authorities,
    container: adapters.container,
    agent: adapters.agent,
    evaluator: adapters.evaluator,
    ledger,
    now: syntheticClock(),
    spendAuthorization: SYNTHETIC_AUTHORIZATION,
  };
}

// ── D1 ──────────────────────────────────────────────────────────────

/**
 * The whole path, once per arm, read back from the produced record.
 *
 * Reported as the record's own fields rather than as assertions about them, so
 * a reader can see what the executor actually wrote — including the ordered
 * telemetry and the gate table — instead of a list of green checks.
 */
async function d1(authorities: FrozenAuthorities): Promise<Record<string, unknown>> {
  const ledger = ledgerFor(authorities);
  const vtraceLead = firstVtraceLeadingOrder(authorities.manifest);
  const records: RunResultRecord[] = [];

  for (let ordinal = 0; ordinal <= vtraceLead; ordinal += 1) {
    const deps = depsFor(authorities, ledger, syntheticWorld());
    const { record } = await executeManifestRow(deps, { executionOrder: ordinal });
    if (ordinal === 0 || ordinal === vtraceLead) records.push(record);
  }

  const summarise = (record: RunResultRecord): Record<string, unknown> => ({
    attemptId: record.attemptId,
    arm: record.arm,
    instanceId: record.instanceId,
    manifestRowOrdinal: record.manifestRowOrdinal,
    status: record.validity.status,
    providerModelIdentity: record.providerModelIdentity,
    modelIdentityVerified: record.modelIdentityVerified,
    lifecyclePhasesObserved: record.lifecyclePhasesObserved,
    gateCount: record.runtimeGates.length,
    gatesAllPass: record.runtimeGates.every((gate) => gate.status === "PASS"),
    gateCoverageIssues: auditRuntimeGateCoverage(record.runtimeGates),
    telemetryEvents: record.telemetry.length,
    telemetryKinds: [...new Set(record.telemetry.map((event) => event.kind))],
    treatment: record.treatment,
    capturedPatchPaths: record.capturedPatchPaths,
    patchCaptureExclusions: record.patchCaptureExclusions,
    evaluation: record.evaluation,
    environmentRedactedNames: record.environment.redactedVariableNames,
  });

  return {
    layer: "D1_SYNTHETIC_NO_MODEL",
    description: "the full executor path for both arms, with no provider contacted",
    rowsExecuted: ledger.entries.length,
    records: records.map(summarise),
    ledgerIntegrityIssues: ledger.verifyIntegrity(),
    ledgerChainHead: ledger.headChainDigest(),
    progress: renderProgress(authorities.manifest, ledger, null),
    finalizationRefusal: canFinalizeCausalReport(authorities.manifest, ledger, "COHORT"),
  };
}

// ── D2 ──────────────────────────────────────────────────────────────

async function d2(authorities: FrozenAuthorities): Promise<Record<string, unknown>> {
  const cases: Record<string, unknown>[] = [];

  const scenarios: readonly (readonly [string, Partial<SyntheticWorld>, string])[] = Object.freeze([
    ["EVALUATOR_INFRA_FAILURE", { evaluatorRan: false, evaluatorExitStatus: 137 },
      "an evaluator that did not run is never an unresolved task"],
    ["MODEL_IDENTITY_DRIFT", { providerModelIdentity: "claude-sonnet-4-5-20250929" },
      "a provider serving another model aborts the run before it counts"],
    ["TREATMENT_INITIALISATION_FAILURE",
      { treatmentInitialises: false, treatmentInitFailureCategory: "TREATMENT_INITIALISATION_FAILURE" },
      "a treatment that did not initialise is classified, not silently run untreated"],
  ]);

  const vtraceLead = firstVtraceLeadingOrder(authorities.manifest);
  for (const [expected, overrides, why] of scenarios) {
    const ledger = ledgerFor(authorities);
    const isTreatmentCase = expected === "TREATMENT_INITIALISATION_FAILURE";
    const ordinal = isTreatmentCase ? vtraceLead : 0;
    for (let index = 0; index < ordinal; index += 1) {
      await executeManifestRow(
        depsFor(authorities, ledger, syntheticWorld()), { executionOrder: index },
      );
    }
    const { record } = await executeManifestRow(
      depsFor(authorities, ledger, syntheticWorld(overrides)), { executionOrder: ordinal },
    );
    const entry = ledger.entries[ledger.entries.length - 1]!;
    cases.push({
      expectedCategory: expected,
      observedCategory: record.validity.infrastructureCategory,
      matches: record.validity.infrastructureCategory === expected,
      status: record.validity.status,
      why,
      retryDecision: retryPermitted(entry),
      lifecyclePhasesObserved: record.lifecyclePhasesObserved,
      costUsd: record.costUsd,
    });
  }

  return {
    layer: "D2_SYNTHETIC_INFRASTRUCTURE_FAILURE",
    description: "invalid-run classification and the frozen retry policy",
    cases,
    allClassifiedCorrectly: cases.every((entry) => entry.matches === true),
  };
}

// ── D3 ──────────────────────────────────────────────────────────────

async function d3(authorities: FrozenAuthorities): Promise<Record<string, unknown>> {
  const vtraceLead = firstVtraceLeadingOrder(authorities.manifest);
  const cases: Record<string, unknown>[] = [];

  const worlds: readonly (readonly [string, Partial<SyntheticWorld>])[] = Object.freeze([
    ["INVOKED_BEFORE_FIRST_EDIT", { treatmentInvocations: 4, treatmentInvokedBeforeFirstEdit: true }],
    ["INVOKED_AFTER_FIRST_EDIT", { treatmentInvocations: 2, treatmentInvokedBeforeFirstEdit: false }],
    ["EXPOSED_NEVER_INVOKED", { treatmentInvocations: 0 }],
  ]);

  for (const [label, overrides] of worlds) {
    const ledger = ledgerFor(authorities);
    for (let index = 0; index < vtraceLead; index += 1) {
      await executeManifestRow(
        depsFor(authorities, ledger, syntheticWorld()), { executionOrder: index },
      );
    }
    const { record } = await executeManifestRow(
      depsFor(authorities, ledger, syntheticWorld(overrides)), { executionOrder: vtraceLead },
    );
    cases.push({
      label,
      status: record.validity.status,
      validUnderIntentionToTreat: record.validity.valid,
      treatment: record.treatment,
    });
  }

  return {
    layer: "D3_SYNTHETIC_TREATMENT_USE",
    description:
      "treatment-use telemetry, and the rule that exposure rather than invocation decides validity",
    cases,
    everyCaseValid: cases.every((entry) => entry.validUnderIntentionToTreat === true),
  };
}

// ── D4 — real git ───────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.fileMode=false", ...args], { cwd }).toString();
}

interface GitScenario {
  readonly label: string;
  readonly route: "INIT_WRITES_GIT_EXCLUDE" | "INDEX_ONLY_NO_GIT_EXCLUDE";
  readonly editSource: boolean;
  readonly treatmentFileAfterSnapshot: boolean;
  readonly snapshotGranularity: "DIRECTORY" | "FILE";
  readonly useLegacyVendorExclusions: boolean;
}

/**
 * Exercise the derived patch-capture rule against real git.
 *
 * The simulation in the falsification suite reproduces the RULE; this one
 * reproduces the TOOL, on a repository outside the frozen 100 with no model and
 * no container. The two disagree on nothing here, which is the point: if the
 * simulation had drifted from git's actual pathspec semantics, this layer is
 * where it would show.
 */
function runGitScenario(scenario: GitScenario): Record<string, unknown> {
  const root = mkdtempSync(join(tmpdir(), "m215-d4-"));
  try {
    git(root, "init", "--quiet", "-b", "main");
    git(root, "config", "user.email", "m215@example.invalid");
    git(root, "config", "user.name", "M215 dry run");
    mkdirSync(join(root, "pkg"), { recursive: true });
    writeFileSync(join(root, "pkg", "core.py"), "def f():\n    return 1\n");
    writeFileSync(join(root, "README.md"), "scratch repository, outside the frozen 100\n");
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "base");
    const baseCommit = git(root, "rev-parse", "HEAD").trim();

    // TREATMENT_INITIALISATION: the two real routes M214's probe found.
    if (scenario.route === "INIT_WRITES_GIT_EXCLUDE") {
      appendFileSync(join(root, ".git", "info", "exclude"), "/.vtrace/\n");
    }
    mkdirSync(join(root, ".vtrace"), { recursive: true });
    for (const name of ["index.sqlite", "session.sqlite", "config.json"]) {
      writeFileSync(join(root, ".vtrace", name), `${name} contents\n`);
    }

    // PRE_AGENT_UNTRACKED_SNAPSHOT, after initialisation.
    const args = ["ls-files", "--others", "--exclude-standard"];
    if (scenario.snapshotGranularity === "DIRECTORY") args.push("--directory");
    const snapshot = git(root, ...args).split("\n").filter((line) => line.length > 0);
    const exclusions = scenario.useLegacyVendorExclusions
      ? [".vexp"]
      : [...derivedPatchExclusions(snapshot)];

    // AGENT_RUN.
    if (scenario.editSource) {
      writeFileSync(join(root, "pkg", "core.py"), "def f():\n    return 2\n");
    }
    if (scenario.treatmentFileAfterSnapshot) {
      writeFileSync(join(root, ".vtrace", "wal.sqlite"), "written during the run\n");
    }

    // PATCH_CAPTURE, with the derived pathspec.
    const pathspec = ["--", ".", ...exclusions.map((entry) => `:(exclude)${entry}`)];
    const trackedNames = git(root, "diff", "--no-renames", "--name-only", "HEAD", ...pathspec)
      .split("\n").filter((line) => line.length > 0);
    const trackedPatch = git(root, "diff", "--no-renames", "HEAD", ...pathspec);
    const untrackedNames = git(root, "ls-files", "--others", "--exclude-standard", ...pathspec)
      .split("\n").filter((line) => line.length > 0);
    const capturedPaths = [...trackedNames, ...untrackedNames].sort();

    return {
      label: scenario.label,
      route: scenario.route,
      snapshotGranularity: scenario.snapshotGranularity,
      useLegacyVendorExclusions: scenario.useLegacyVendorExclusions,
      baseCommit,
      preAgentUntrackedSnapshot: snapshot,
      derivedExclusions: exclusions,
      capturedPaths,
      capturedTrackedPatchBytes: Buffer.byteLength(trackedPatch, "utf8"),
      capturedTreatmentPaths: capturedPaths.filter((path) => path.startsWith(".vtrace")),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function d4(): Record<string, unknown> {
  const scenarios: readonly GitScenario[] = Object.freeze([
    {
      label: "D4a_INIT_ROUTE_NO_SOURCE_EDIT", route: "INIT_WRITES_GIT_EXCLUDE", editSource: false,
      treatmentFileAfterSnapshot: false, snapshotGranularity: "DIRECTORY",
      useLegacyVendorExclusions: false,
    },
    {
      label: "D4b_INDEX_ONLY_ROUTE_NO_SOURCE_EDIT", route: "INDEX_ONLY_NO_GIT_EXCLUDE",
      editSource: false, treatmentFileAfterSnapshot: false, snapshotGranularity: "DIRECTORY",
      useLegacyVendorExclusions: false,
    },
    {
      label: "D4c_ONE_SOURCE_EDIT", route: "INDEX_ONLY_NO_GIT_EXCLUDE", editSource: true,
      treatmentFileAfterSnapshot: false, snapshotGranularity: "DIRECTORY",
      useLegacyVendorExclusions: false,
    },
    {
      label: "D4d_TREATMENT_FILE_WRITTEN_DURING_RUN_DIRECTORY_GRANULARITY",
      route: "INDEX_ONLY_NO_GIT_EXCLUDE", editSource: true, treatmentFileAfterSnapshot: true,
      snapshotGranularity: "DIRECTORY", useLegacyVendorExclusions: false,
    },
    {
      label: "D4e_TREATMENT_FILE_WRITTEN_DURING_RUN_FILE_GRANULARITY",
      route: "INDEX_ONLY_NO_GIT_EXCLUDE", editSource: true, treatmentFileAfterSnapshot: true,
      snapshotGranularity: "FILE", useLegacyVendorExclusions: false,
    },
    {
      label: "D4f_LEGACY_VENDOR_EXCLUSIONS", route: "INDEX_ONLY_NO_GIT_EXCLUDE", editSource: false,
      treatmentFileAfterSnapshot: false, snapshotGranularity: "DIRECTORY",
      useLegacyVendorExclusions: true,
    },
  ]);

  const results = scenarios.map(runGitScenario);
  const byLabel = new Map(results.map((entry) => [entry.label as string, entry] as const));
  const treatmentPaths = (label: string): string[] =>
    (byLabel.get(label)!.capturedTreatmentPaths as string[]);

  return {
    layer: "D4_REAL_GIT_PATCH_CAPTURE",
    description:
      "the derived patch-capture rule against real git, on a scratch repository outside the frozen "
      + "100; no model, no container, no frozen task",
    scenarios: results,
    invariants: {
      noSourceEditInitRouteIsEmpty:
        (byLabel.get("D4a_INIT_ROUTE_NO_SOURCE_EDIT")!.capturedPaths as string[]).length === 0,
      noSourceEditIndexOnlyRouteIsEmpty:
        (byLabel.get("D4b_INDEX_ONLY_ROUTE_NO_SOURCE_EDIT")!.capturedPaths as string[]).length === 0,
      oneSourceEditIsExactlyThatFile:
        JSON.stringify(byLabel.get("D4c_ONE_SOURCE_EDIT")!.capturedPaths) === '["pkg/core.py"]',
      legacyVendorExclusionsLeakTreatmentState:
        treatmentPaths("D4f_LEGACY_VENDOR_EXCLUSIONS").length > 0,
      directoryGranularityCoversFilesWrittenDuringTheRun:
        treatmentPaths("D4d_TREATMENT_FILE_WRITTEN_DURING_RUN_DIRECTORY_GRANULARITY").length === 0,
      fileGranularityDoesNotCoverFilesWrittenDuringTheRun:
        treatmentPaths("D4e_TREATMENT_FILE_WRITTEN_DURING_RUN_FILE_GRANULARITY").length > 0,
    },
    granularityContract:
      "The pre-agent untracked snapshot MUST be taken at directory granularity (git ls-files "
      + "--others --exclude-standard --directory). At file granularity the derived exclusions name "
      + "the three files that existed at snapshot time, and a treatment file written during the "
      + "agent run is captured as agent output — the same leak M213 found, arriving through the "
      + "snapshot instead of through the pathspec. D4d and D4e are that difference, measured.",
  };
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const authorities = loadAuthorities();

  const layers = [await d1(authorities), await d2(authorities), await d3(authorities), d4()];

  // Resume, exercised on the cohort launcher rather than on the row executor.
  const ledger = ledgerFor(authorities);
  const first = await runCohort(depsFor(authorities, ledger, syntheticWorld()), { maxRows: 6 });
  const persisted = JSON.parse(JSON.stringify({
    records: ledger.records, entries: ledger.entries,
  })) as { records: RunResultRecord[]; entries: (typeof ledger.entries)[number][] };
  const restored = CohortLedger.restore(
    "SYNTHETIC", ledger.preregistrationHash, ledger.manifestHash,
    persisted.records, persisted.entries,
  );
  const second = await runCohort({
    ...depsFor(authorities, restored.ledger, syntheticWorld()), ledger: restored.ledger,
  }, { maxRows: 4 });

  const document = {
    schemaVersion: "stage5.m215.dry-run.v1",
    milestone: "M215",
    generatedAt: new Date().toISOString(),
    executorVersion: M215_EXECUTOR_VERSION,
    liveModelSpendUsd: 0,
    frozenBenchmarkTaskLiveAgentRuns: 0,
    providerCallsMade: 0,
    dockerContainersStarted: 0,
    concurrencyPolicy: M215_CONCURRENCY_POLICY,
    authorities: {
      preregistration: authorities.preregistrationHash,
      manifest: authorities.manifestHash,
      externalReference: authorities.externalReferenceHash,
    },
    layers,
    resume: {
      firstLegRows: first.executed.length,
      resumedLegRows: second.executed.length,
      duplicateAttempts: first.executed.filter((id) => second.executed.includes(id)).length,
      completedOrdinals: restored.ledger.entries.map((entry) => entry.manifestRowOrdinal),
      restoreIssues: restored.issues,
      integrityIssues: restored.ledger.verifyIntegrity(),
      chainHead: restored.ledger.headChainDigest(),
    },
  };

  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`wrote ${OUTPUT}\n`);
  for (const layer of layers) {
    process.stdout.write(`${String(layer.layer)}: ok\n`);
  }
  const invariants = (layers[3] as { invariants: Record<string, boolean> }).invariants;
  for (const [name, value] of Object.entries(invariants)) {
    process.stdout.write(`  ${name}: ${value}\n`);
  }
}

await main();
