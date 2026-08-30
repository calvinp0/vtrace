/**
 * M192 — per-instance SWE-bench validation substrate audit.
 *
 * Pure classification + selection logic for the M192 infrastructure audit.
 * This module contains NO product behaviour and is never imported by `src/`.
 * It exists so that every load-bearing count in the M192 report is derived by
 * committed, tested code rather than transcribed by hand.
 *
 * The audit question is whether SWE-bench's own per-instance Docker environment
 * can serve as an *interactive* edit-and-validate substrate, i.e. whether a test
 * process provably executes the exact source state an agent just edited.
 */

// ── Instance selection (preregistered) ──────────────────────────────

export interface BenchmarkRow {
  instance_id: string;
  repo: string;
  base_commit: string;
  environment_setup_commit?: string;
  version: string;
  test_patch: string;
  /** JSON-encoded string[] in the Stage 5 fixture. */
  PASS_TO_PASS: string | string[];
  FAIL_TO_PASS: string | string[];
}

export interface SelectedInstance {
  instanceId: string;
  repo: string;
  baseCommit: string;
  environmentSetupCommit: string | null;
  version: string;
  /** Official prebuilt per-instance eval image, swebench namespace. */
  instanceImageKey: string;
  /** Python import name used for the source-provenance probe. */
  importName: string;
  /** First PASS_TO_PASS test id (the P-probe), if the instance declares any. */
  pProbe: string | null;
  /** First FAIL_TO_PASS test id (the F-probe), if the instance declares any. */
  fProbe: string | null;
}

/**
 * Repo -> importable top-level package name. Used only to *locate* the module
 * whose `__file__` is the provenance witness; the mutation target is then
 * derived from the observed path, never from this table.
 */
export const M192_IMPORT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "astropy/astropy": "astropy",
  "django/django": "django",
  "matplotlib/matplotlib": "matplotlib",
  "mwaskom/seaborn": "seaborn",
  "pallets/flask": "flask",
  "psf/requests": "requests",
  "pydata/xarray": "xarray",
  "pylint-dev/pylint": "pylint",
  "pytest-dev/pytest": "_pytest",
  "scikit-learn/scikit-learn": "sklearn",
  "sphinx-doc/sphinx": "sphinx",
  "sympy/sympy": "sympy",
});

/**
 * Official image key, reproducing `TestSpec.instance_image_key` from
 * swebench 4.1.0 (`harness/test_spec/test_spec.py`) with the default
 * namespace `swebench` and instance image tag `latest`.
 */
export function instanceImageKey(instanceId: string, arch = "x86_64"): string {
  const key = `sweb.eval.${arch}.${instanceId.toLowerCase()}:latest`;
  return `swebench/${key}`.replace(/__/g, "_1776_");
}

function asList(v: string | string[]): string[] {
  if (Array.isArray(v)) return v;
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * PREREGISTERED SELECTION RULE (frozen before any probe result was inspected):
 * for every repository represented in the fixture, take the lexicographically
 * first instance id. The rule is a total function of the fixture and is blind
 * to Docker availability, image size, gold topology and probe outcome.
 */
export function selectPreregisteredInstances(rows: BenchmarkRow[]): SelectedInstance[] {
  const byRepo = new Map<string, BenchmarkRow>();
  for (const row of rows) {
    const current = byRepo.get(row.repo);
    if (!current || row.instance_id < current.instance_id) byRepo.set(row.repo, row);
  }
  return [...byRepo.keys()].sort().map((repo) => {
    const row = byRepo.get(repo)!;
    const p2p = asList(row.PASS_TO_PASS);
    const f2p = asList(row.FAIL_TO_PASS);
    return {
      instanceId: row.instance_id,
      repo: row.repo,
      baseCommit: row.base_commit,
      environmentSetupCommit: row.environment_setup_commit ?? null,
      version: row.version,
      instanceImageKey: instanceImageKey(row.instance_id),
      importName: M192_IMPORT_NAMES[row.repo] ?? repo.split("/")[1]!,
      pProbe: p2p.length > 0 ? [...p2p].sort()[0]! : null,
      fProbe: f2p.length > 0 ? [...f2p].sort()[0]! : null,
    };
  });
}

// ── Execution classification (M187 semantic discipline) ─────────────

export type ExecutionState =
  | "PROCESS_NOT_STARTED"
  | "STARTED_RUNNER_NOT_REACHED"
  | "STARTED_TESTS_PASSED"
  | "STARTED_TESTS_FAILED"
  | "STARTED_TIMEOUT"
  | "STARTED_INFRA_FAILURE"
  | "UNKNOWN";

export interface CommandResult {
  /** False when the container/exec itself never produced a process. */
  processStarted: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Markers emitted by swebench's own eval script around the test command
 * (`harness/constants/__init__.py`). Their presence is the only truthful
 * witness that the *test runner* was reached, as distinct from the shell
 * preamble succeeding.
 */
export const START_TEST_OUTPUT = ">>>>> Start Test Output";
export const END_TEST_OUTPUT = ">>>>> End Test Output";

/**
 * Classify a validation command. Deliberately keeps "did the runner start"
 * separate from "did the tests pass": M191's central failure was a repository
 * that answered cleanly while executing the wrong source, and a taxonomy that
 * collapses those two axes cannot express that.
 */
export function classifyExecution(result: CommandResult): ExecutionState {
  if (!result.processStarted) return "PROCESS_NOT_STARTED";
  if (result.timedOut) return "STARTED_TIMEOUT";

  const combined = `${result.stdout}\n${result.stderr}`;
  const runnerReached = combined.includes(START_TEST_OUTPUT);
  if (!runnerReached) {
    if (looksLikeInfraFailure(combined)) return "STARTED_INFRA_FAILURE";
    return "STARTED_RUNNER_NOT_REACHED";
  }
  if (result.exitCode === null) return "UNKNOWN";
  return result.exitCode === 0 ? "STARTED_TESTS_PASSED" : "STARTED_TESTS_FAILED";
}

const INFRA_MARKERS = [
  "ModuleNotFoundError: No module named",
  "ImportError: cannot import name",
  "command not found",
  "No such file or directory",
  "Killed",
  "MemoryError",
  "error: subprocess-exited-with-error",
];

function looksLikeInfraFailure(text: string): boolean {
  return INFRA_MARKERS.some((m) => text.includes(m));
}

// ── Source provenance (load-bearing; §12, §24) ──────────────────────

export type ProvenanceState =
  | "EDITED_CHECKOUT_CONFIRMED"
  | "INSTALLED_COPY_CONFIRMED"
  | "AMBIGUOUS_SOURCE"
  | "RUNNER_NOT_STARTED"
  | "NOT_APPLICABLE";

export interface ProvenanceEvidence {
  /** `<pkg>.__file__` as observed inside the container, or null. */
  moduleFile: string | null;
  /** The benchmark checkout root, `/testbed` in swebench 4.1.0. */
  checkoutRoot: string;
  /** Whether the runtime sentinel written into the checkout fired during the
   *  actual benchmark test command (not during a bare import). */
  mutationExecuted: boolean | null;
  /** Whether the validation command reached the test runner at all. */
  runnerStarted: boolean;
}

const INSTALLED_ROOTS = ["site-packages", "dist-packages", "/opt/miniconda3/lib", "/usr/lib/python"];

/**
 * Decide, from runtime evidence, whether validation executed the checkout under
 * edit. `STARTED_PASSED` is never accepted as a substitute: a test can pass
 * loudly against an installed copy, which is exactly the M191 finding.
 */
export function classifyProvenance(ev: ProvenanceEvidence): ProvenanceState {
  if (!ev.runnerStarted) return "RUNNER_NOT_STARTED";
  if (ev.moduleFile === null) return "AMBIGUOUS_SOURCE";

  const underCheckout = ev.moduleFile.startsWith(`${ev.checkoutRoot}/`);
  const underInstalled = INSTALLED_ROOTS.some((r) => ev.moduleFile!.includes(r));

  // A path that is both, or neither, is not a proof.
  if (underCheckout && underInstalled) return "AMBIGUOUS_SOURCE";
  if (underInstalled) return "INSTALLED_COPY_CONFIRMED";
  if (!underCheckout) return "AMBIGUOUS_SOURCE";

  // Path says checkout. Require the execution witness to agree.
  if (ev.mutationExecuted === true) return "EDITED_CHECKOUT_CONFIRMED";
  if (ev.mutationExecuted === false) return "INSTALLED_COPY_CONFIRMED";
  return "AMBIGUOUS_SOURCE";
}

// ── Repository readiness (V1..V12) ──────────────────────────────────

export interface ReadinessChecks {
  v1EnvironmentStarts: boolean;
  v2SourceReadable: boolean;
  v3SourceWritable: boolean;
  v4MutationPersists: boolean;
  v5TestRunnerStarts: boolean;
  v6PassingObservable: boolean;
  v7FailingObservable: boolean | null; // null when the contract offers no F-probe
  v8SourceProvenance: ProvenanceState;
  v9MutationAffectsValidation: boolean;
  v10SourceRestored: boolean;
  v11TelemetryTruthful: boolean;
  v12NoPrivilegedBypass: boolean;
}

export type RepositoryState =
  | "READY"
  | "RUNNER_ONLY"
  | "WRONG_SOURCE"
  | "DEPENDENCY_FAILURE"
  | "IMAGE_FAILURE"
  | "SOURCE_NOT_WRITABLE"
  | "NON_PERSISTENT_ENV"
  | "TELEMETRY_FAILURE"
  | "OTHER";

/**
 * §24 hard rule: demonstrated wrong-source execution overrides every apparent
 * validation success. It is checked before anything else can return READY.
 */
export function assessRepository(c: ReadinessChecks): RepositoryState {
  if (!c.v1EnvironmentStarts) return "IMAGE_FAILURE";
  if (!c.v2SourceReadable) return "IMAGE_FAILURE";
  if (!c.v3SourceWritable) return "SOURCE_NOT_WRITABLE";
  if (!c.v4MutationPersists) return "NON_PERSISTENT_ENV";
  if (c.v8SourceProvenance === "INSTALLED_COPY_CONFIRMED") return "WRONG_SOURCE";
  if (!c.v11TelemetryTruthful || !c.v12NoPrivilegedBypass) return "TELEMETRY_FAILURE";
  if (!c.v5TestRunnerStarts) return "DEPENDENCY_FAILURE";
  if (!c.v6PassingObservable) return "RUNNER_ONLY";
  if (c.v7FailingObservable === false) return "RUNNER_ONLY";
  if (c.v8SourceProvenance !== "EDITED_CHECKOUT_CONFIRMED") return "OTHER";
  if (!c.v9MutationAffectsValidation) return "WRONG_SOURCE";
  if (!c.v10SourceRestored) return "OTHER";
  return "READY";
}

// ── Preregistered breadth gate (§23) ────────────────────────────────

export interface BreadthGate {
  representedRepositories: number;
  requiredReady: number;
  rule: string;
}

/**
 * Frozen before probes: >= 8/12 when all twelve repositories are represented,
 * otherwise the proportional >= ceil(2/3 * represented) fallback of §23.
 */
export function breadthGate(representedRepositories: number): BreadthGate {
  if (representedRepositories === 12) {
    return {
      representedRepositories,
      requiredReady: 8,
      rule: ">= 8 / 12 repositories REPO_INTERACTIVE_VALIDATION_READY, zero WRONG_SOURCE among them",
    };
  }
  return {
    representedRepositories,
    requiredReady: Math.ceil((2 / 3) * representedRepositories),
    rule: ">= ceil(2/3 * represented) repositories READY, zero WRONG_SOURCE among them",
  };
}

export type SubstrateVerdict =
  | "PER_INSTANCE_SUBSTRATE_VIABLE"
  | "PER_INSTANCE_SUBSTRATE_PARTIAL"
  | "PER_INSTANCE_SUBSTRATE_NOT_VIABLE"
  | "PER_INSTANCE_SUBSTRATE_NOT_EVALUABLE";

export function substrateVerdict(
  states: RepositoryState[],
  gate: BreadthGate,
): SubstrateVerdict {
  if (states.length === 0) return "PER_INSTANCE_SUBSTRATE_NOT_EVALUABLE";
  const ready = states.filter((s) => s === "READY").length;
  if (ready >= gate.requiredReady) return "PER_INSTANCE_SUBSTRATE_VIABLE";
  if (ready > 0) return "PER_INSTANCE_SUBSTRATE_PARTIAL";
  return "PER_INSTANCE_SUBSTRATE_NOT_VIABLE";
}

// ── Cleanup ownership (§29) ─────────────────────────────────────────

export const M192_RESOURCE_PREFIX = "m192-";

/**
 * Only M192-created containers may be removed. Pre-existing user containers —
 * including swebench evaluation containers from earlier milestones — are not
 * ours to destroy.
 */
export function isM192OwnedContainer(name: string): boolean {
  return name.startsWith(M192_RESOURCE_PREFIX) || name.startsWith(`/${M192_RESOURCE_PREFIX}`);
}
