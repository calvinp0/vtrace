// M191 Stage A — cross-repository validation-readiness probes on the agent-accessible path.
//
// The design, the instance-selection rule and the six-condition gate are preregistered in
// results/stage5_m191_readiness_prereg.md and were committed before this script was first run.
//
// WHAT IS NEW HERE, RELATIVE TO M187. M187 proved the execution MECHANISM works, with 11
// hand-authored probes over 4 repositories — two of which it expected, correctly, to be
// unrunnable. It never measured how many SWE-bench repositories actually have a working
// dependency environment, and its own §10.1 says per-task provisioning is unsolved. A
// cross-repository observational corpus cannot be acquired from a mechanism that runs in two
// repositories, so Stage A measures BREADTH, using the benchmark's own ground truth instead of
// tests this milestone chose:
//
//   P-probe = a PASS_TO_PASS test, which SWE-bench guarantees passes at the base commit
//   F-probe = a FAIL_TO_PASS test, which SWE-bench guarantees FAILS at the base commit
//
// The F-probe is therefore a NATURALLY failing test — §8's "genuine failing test execution"
// with no source altered to manufacture it. A repository is credited only when the same
// environment yields STARTED_PASSED on one and STARTED_FAILED on the other, which is exactly
// the discrimination §8 requires between "tests failed" and "the runner never started".
//
// THE CONTROL IS THE POINT. Z1 rebuilds the pre-M187 arrangement and re-runs a command the
// repaired path passes. If Z1 starts a runner, this suite cannot see the defect it reports on.
//
// No agent is spawned. No live budget is spent. The benchmark repositories are read through
// `git archive` and are never checked out, mutated or left dirty.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { materializeAgentShellGuard } from "./stage5AgentShellGuardIntegration";
import { classifyValidationExecution, type ValidationExecutionState } from "./validationExecution";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const VEXP = process.env.VEXP_DIR ?? "/home/calvin/code/vexp-swe-bench";
const BENCH_REPOS = path.join(VEXP, ".bench-repos");
const DATASET = path.join(VEXP, "data/swe-bench-100.jsonl");
const EXPECTED_TESTBED_PREFIX = "/home/calvin/miniforge3/envs/vexp_swebench";
const PROBE_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------------------
// dataset
// ---------------------------------------------------------------------------------------

interface Instance {
  readonly repo: string;
  readonly instance_id: string;
  readonly base_commit: string;
  readonly test_patch: string;
  readonly FAIL_TO_PASS: string | string[];
  readonly PASS_TO_PASS: string | string[];
}

const asList = (v: string | string[]): string[] => {
  if (Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/** The repo directory name under .bench-repos, e.g. django/django -> django__django. */
const benchDirFor = (repo: string): string => repo.replace("/", "__");

/** Files a test_patch touches — the only place a bare (non-node-id) test name can be located. */
function testFilesFromPatch(testPatch: string): string[] {
  const files = new Set<string>();
  for (const line of testPatch.split("\n")) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m && m[1] !== "/dev/null") files.add(m[1]);
  }
  return [...files];
}

// ---------------------------------------------------------------------------------------
// per-repository command construction
//
// The three shapes SWE-bench uses for a test id, and the runner each repository actually has.
// Nothing here selects an EASIER test: it selects the SAME test the official grader would run,
// expressed for the runner that repository ships.
// ---------------------------------------------------------------------------------------

type CommandShape = "pytest_nodeid" | "django_runtests" | "pytest_keyword";

interface BuiltCommand {
  readonly shape: CommandShape;
  readonly command: string;
}

function buildCommand(repo: string, testId: string, testFiles: readonly string[]): BuiltCommand | null {
  // django ships its own runner and its ids look like `test_x (module.Class)`.
  if (repo === "django/django") {
    const m = /^(\S+)\s+\((.+?)\)$/.exec(testId.trim());
    if (!m) return null;
    const [, method, suite] = m;
    // Some rows already carry the method as the last dotted segment; do not double it.
    const label = suite.endsWith(`.${method}`) ? suite : `${suite}.${method}`;
    return { shape: "django_runtests", command: `PYTHONPATH=. python tests/runtests.py ${label} -v0` };
  }
  // A pytest node id addresses itself.
  if (testId.includes("::")) {
    return { shape: "pytest_nodeid", command: `python -m pytest "${testId}" -q --no-header -p no:randomly` };
  }
  // A bare function name (sympy) — locate it in the file the test_patch touches.
  const file = testFiles.find((f) => f.endsWith(".py"));
  if (!file) return null;
  const keyword = testId.trim().split(/\s+/)[0];
  return {
    shape: "pytest_keyword",
    command: `python -m pytest "${file}" -q --no-header -p no:randomly -k "${keyword}"`,
  };
}

// ---------------------------------------------------------------------------------------
// SOURCE-PROVENANCE DIAGNOSTIC — post-hoc, and deliberately OUTSIDE the preregistered gate.
//
// Added after the first probe run, because pytest-dev/pytest returned STARTED_PASSED on a test
// SWE-bench guarantees FAILS at the base commit. The cause is not the runner: `python -m pytest`
// in that tree imports `_pytest` from the testbed's site-packages (pytest 9.0.3), not from the
// repository's own `src/_pytest`. The runner starts, reports truthfully, and describes code the
// agent did not edit.
//
// This is recorded rather than acted upon. It CANNOT move the gate: under the rule committed
// before any probe ran, a repository whose F-probe passes is REPO_RUNNER_ONLY either way, so
// pytest-dev/pytest is not validation-ready with or without this diagnostic. It is here because
// a validation environment that answers about the wrong source is a worse readiness fact than
// one that refuses, and M187 §10.2 already flagged the shared-venv editable installs behind it.
// ---------------------------------------------------------------------------------------

/** The import name whose resolved __file__ tells us whose source a test actually exercised. */
const TOP_LEVEL_MODULE: Readonly<Record<string, string>> = {
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
};

interface SourceProvenance {
  readonly module: string | null;
  readonly resolvedFile: string | null;
  readonly resolvesToRepositoryUnderTest: boolean | null;
  readonly note: string;
}

function probeSourceProvenance(repo: string, cwd: string, env: Record<string, string>): SourceProvenance {
  const mod = TOP_LEVEL_MODULE[repo] ?? null;
  if (mod === null) return { module: null, resolvedFile: null, resolvesToRepositoryUnderTest: null, note: "no top-level module mapped" };
  const r = spawnSync("bash", ["-c", `python -c "import ${mod}, sys; print(getattr(${mod}, '__file__', '') or '')"`], {
    cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  const resolved = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  if (r.status !== 0 || resolved.length === 0) {
    return { module: mod, resolvedFile: null, resolvesToRepositoryUnderTest: null, note: "the module could not be imported at all" };
  }
  const inTree = path.resolve(resolved).startsWith(path.resolve(cwd) + path.sep);
  return {
    module: mod,
    resolvedFile: resolved,
    resolvesToRepositoryUnderTest: inTree,
    note: inTree
      ? "tests exercise the checked-out source"
      : "tests exercise an INSTALLED copy — a validation result here does not describe the repository under edit",
  };
}

// ---------------------------------------------------------------------------------------
// probe execution
// ---------------------------------------------------------------------------------------

interface ProbeRow {
  readonly id: string;
  readonly role: "P" | "F" | "CONTROL";
  readonly repo: string;
  readonly instanceId: string | null;
  readonly baseCommit: string | null;
  readonly testId: string | null;
  readonly commandShape: CommandShape | null;
  readonly command: string;
  readonly agentAccessiblePath: string;
  readonly requiredPrivilegedBypass: false;
  readonly runnerStartEvidence: string;
  readonly durationMs: number;
  readonly rawExitStatus: number | null;
  readonly observedState: ValidationExecutionState | "NOT_A_VALIDATION_ATTEMPT";
  readonly runnerStarted: boolean | null;
  readonly termination: string | null;
  readonly notStartedCause: string | null;
  readonly environmentClassification: string | null;
  readonly classifierEvidence: readonly string[];
  readonly capturedOutputHead: string;
}

function runProbe(
  id: string,
  role: ProbeRow["role"],
  repo: string,
  cwd: string,
  command: string,
  env: Record<string, string>,
  meta: { instanceId: string | null; baseCommit: string | null; testId: string | null; shape: CommandShape | null },
): ProbeRow {
  const started = Date.now();
  // `bash -c` with this env is exactly what the agent's Bash tool does. Nothing privileged.
  const r = spawnSync("bash", ["-c", command], {
    cwd,
    env,
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const combined = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // Reproduce the shell tool's own convention so the classifier reads the surface it reads live.
  const output = r.status !== null && r.status !== 0 ? `Exit code ${r.status}\n${combined}` : combined;

  const verdict = classifyValidationExecution({
    tool: "Bash",
    command,
    output,
    success: r.status === 0 ? true : r.status === null ? null : false,
    exitCode: r.status !== null && r.status !== 0 ? r.status : null,
    exitCodeSource: r.status !== null && r.status !== 0 ? "output_prefix" : null,
  });

  return {
    id,
    role,
    repo,
    instanceId: meta.instanceId,
    baseCommit: meta.baseCommit,
    testId: meta.testId,
    commandShape: meta.shape,
    command,
    agentAccessiblePath: "bash -c, env = materializeAgentShellGuard(...).shellEnv.overrides",
    requiredPrivilegedBypass: false,
    runnerStartEvidence: r.status !== null ? `shell exited ${r.status}` : "shell did not exit normally",
    durationMs,
    rawExitStatus: r.status,
    observedState: verdict?.state ?? "NOT_A_VALIDATION_ATTEMPT",
    runnerStarted: verdict?.runnerStarted ?? null,
    termination: verdict?.termination ?? null,
    notStartedCause: verdict?.notStartedCause ?? null,
    environmentClassification: verdict?.environmentClassification ?? null,
    classifierEvidence: verdict?.evidence ?? [],
    capturedOutputHead: output.slice(0, 900),
  };
}

/** Faithful transcription of the external harness's `cleanPreviousRun`. */
function cleanPreviousRun(dir: string): number {
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir).filter((f) => f !== ".gitkeep");
  for (const f of files) rmSync(path.join(dir, f), { recursive: true, force: true });
  return files.length;
}

function sh(cmd: string, cwd?: string): { ok: boolean; out: string } {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ---------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------

const dataset: Instance[] = readFileSync(DATASET, "utf8")
  .split("\n")
  .filter((l: string) => l.trim().length > 0)
  .map((l: string) => JSON.parse(l));

// §3 selection: per repo, instances sorted by id, FIRST with non-empty F2P, non-empty P2P and a
// derivable test file. Blind to any outcome; no repository excluded in advance.
const byRepo = new Map<string, Instance[]>();
for (const inst of dataset) {
  const list = byRepo.get(inst.repo) ?? [];
  list.push(inst);
  byRepo.set(inst.repo, list);
}

interface Selection {
  readonly repo: string;
  readonly instance: Instance | null;
  readonly reason: string;
  readonly f2p: string | null;
  readonly p2p: string | null;
  readonly testFiles: readonly string[];
}

const selections: Selection[] = [];
for (const repo of [...byRepo.keys()].sort()) {
  const candidates = (byRepo.get(repo) ?? []).slice().sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  let chosen: Selection = { repo, instance: null, reason: "no candidate satisfied the selection rule", f2p: null, p2p: null, testFiles: [] };
  for (const inst of candidates) {
    const f2p = asList(inst.FAIL_TO_PASS);
    const p2p = asList(inst.PASS_TO_PASS);
    const files = testFilesFromPatch(inst.test_patch ?? "");
    if (f2p.length === 0 || p2p.length === 0 || files.length === 0) continue;
    if (!buildCommand(repo, f2p[0], files) || !buildCommand(repo, p2p[0], files)) continue;
    chosen = { repo, instance: inst, reason: "first instance by id with non-empty F2P/P2P and a derivable test file", f2p: f2p[0], p2p: p2p[0], testFiles: files };
    break;
  }
  selections.push(chosen);
}

const scratchRoot = mkdtempSync(path.join(process.env.M191_SCRATCH ?? tmpdir(), "m191-readiness-"));
const guardRoot = mkdtempSync(path.join(tmpdir(), "m191-guard-"));
const rows: ProbeRow[] = [];
const repoVerdicts: Record<string, unknown>[] = [];
let guardEnvSummary: Record<string, unknown> = {};

try {
  // The repaired (M187) arrangement: the guard lives OUTSIDE the harness's --output directory.
  const rawDir = path.join(guardRoot, "raw", "baseline");
  const guardDir = path.join(guardRoot, "raw", "_shell_guard_baseline");
  mkdirSync(rawDir, { recursive: true });
  const mat = materializeAgentShellGuard({ runDir: guardDir, expectedTestbedPrefix: EXPECTED_TESTBED_PREFIX });
  writeFileSync(path.join(rawDir, "swebench-probe.jsonl"), "{}\n");
  const cleanedFromRaw = cleanPreviousRun(rawDir); // the harness's start-up, faithfully applied
  const wrapperSurvived = existsSync(path.join(mat.wrapperBin, "python"));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...mat.shellEnv.overrides };
  guardEnvSummary = {
    wrapperBinReady: mat.wrapperBinReady,
    pathSanitized: mat.shellEnv.pathSanitized,
    condaEnvScrubbed: mat.shellEnv.condaEnvScrubbed,
    delegatePython: mat.delegates.delegatePython,
    entriesCleanedFromHarnessOutputDir: cleanedFromRaw,
    wrapperBinSurvivedHarnessClean: wrapperSurvived,
  };
  if (!wrapperSurvived) throw new Error("M187 layout did not survive the harness cleaner — probes would be invalid");

  for (const sel of selections) {
    const dirName = benchDirFor(sel.repo);
    const benchRepo = path.join(BENCH_REPOS, dirName);
    if (sel.instance === null || !existsSync(benchRepo)) {
      repoVerdicts.push({ repo: sel.repo, instanceId: sel.instance?.instance_id ?? null, verdict: "REPO_NOT_PROBED", note: sel.instance === null ? sel.reason : `bench checkout missing: ${benchRepo}` });
      continue;
    }
    const inst = sel.instance;
    const work = path.join(scratchRoot, inst.instance_id);
    mkdirSync(work, { recursive: true });

    // Read-only export of the base tree. The shared checkout is never mutated.
    const exported = sh(`git -C ${JSON.stringify(benchRepo)} archive ${inst.base_commit} | tar -x -C ${JSON.stringify(work)}`);
    if (!exported.ok) {
      repoVerdicts.push({ repo: sel.repo, instanceId: inst.instance_id, verdict: "REPO_NOT_PROBED", note: `base tree export failed: ${exported.out.slice(0, 300)}` });
      rmSync(work, { recursive: true, force: true });
      continue;
    }
    // The instance's own test_patch, so the FAIL_TO_PASS test exists to be run at all.
    const patchFile = path.join(work, "_m191_test.patch");
    writeFileSync(patchFile, inst.test_patch);
    const applied = sh(`git apply -p1 --unsafe-paths --directory=. ${JSON.stringify(patchFile)} 2>&1 || patch -p1 --forward --batch < ${JSON.stringify(patchFile)}`, work);

    const pCmd = buildCommand(sel.repo, sel.p2p!, sel.testFiles)!;
    const fCmd = buildCommand(sel.repo, sel.f2p!, sel.testFiles)!;
    const meta = { instanceId: inst.instance_id, baseCommit: inst.base_commit, shape: pCmd.shape };
    const pRow = runProbe(`P_${dirName}`, "P", sel.repo, work, pCmd.command, env, { ...meta, testId: sel.p2p });
    const fRow = runProbe(`F_${dirName}`, "F", sel.repo, work, fCmd.command, env, { ...meta, testId: sel.f2p, shape: fCmd.shape });
    rows.push(pRow, fRow);

    const provenance = probeSourceProvenance(sel.repo, work, env);
    const verdict =
      pRow.observedState === "STARTED_PASSED" && fRow.observedState === "STARTED_FAILED"
        ? "REPO_VALIDATION_READY"
        : pRow.runnerStarted === true && fRow.runnerStarted === true
          ? "REPO_RUNNER_ONLY"
          : "REPO_NOT_RUNNABLE";
    repoVerdicts.push({
      repo: sel.repo,
      instanceId: inst.instance_id,
      baseCommit: inst.base_commit,
      testPatchApplied: applied.ok,
      pProbe: pRow.observedState,
      fProbe: fRow.observedState,
      sourceProvenance: provenance,
      verdict,
    });
    console.log(`${verdict.padEnd(22)} ${sel.repo.padEnd(28)} P=${pRow.observedState.padEnd(22)} F=${fRow.observedState}`);
    rmSync(work, { recursive: true, force: true }); // bound peak scratch usage
  }

  // ---- Z1 CONTROL: the pre-M187 arrangement, wiped exactly as the harness wipes it ----
  const readyRepo = repoVerdicts.find((v) => v.verdict === "REPO_VALIDATION_READY");
  const controlSel = selections.find((s) => s.instance?.instance_id === readyRepo?.instanceId);
  if (controlSel?.instance) {
    const inst = controlSel.instance;
    const work = path.join(scratchRoot, `control_${inst.instance_id}`);
    mkdirSync(work, { recursive: true });
    sh(`git -C ${JSON.stringify(path.join(BENCH_REPOS, benchDirFor(controlSel.repo)))} archive ${inst.base_commit} | tar -x -C ${JSON.stringify(work)}`);
    const pf = path.join(work, "_m191_test.patch");
    writeFileSync(pf, inst.test_patch);
    sh(`git apply -p1 --unsafe-paths --directory=. ${JSON.stringify(pf)} 2>&1 || patch -p1 --forward --batch < ${JSON.stringify(pf)}`, work);

    const cRaw = path.join(guardRoot, "control", "raw", "baseline");
    mkdirSync(cRaw, { recursive: true });
    const cMat = materializeAgentShellGuard({ runDir: cRaw, expectedTestbedPrefix: EXPECTED_TESTBED_PREFIX });
    const cEnv: Record<string, string> = { ...(process.env as Record<string, string>), ...cMat.shellEnv.overrides };
    cleanPreviousRun(cRaw); // the pre-M187 defect, reproduced
    const cCmd = buildCommand(controlSel.repo, controlSel.p2p!, controlSel.testFiles)!;
    rows.push(
      runProbe("Z1_control_pre_m187_layout", "CONTROL", controlSel.repo, work, cCmd.command, cEnv, {
        instanceId: inst.instance_id, baseCommit: inst.base_commit, testId: controlSel.p2p, shape: cCmd.shape,
      }),
    );
    rmSync(work, { recursive: true, force: true });
  }
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
  rmSync(guardRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------
// the preregistered six-condition gate
// ---------------------------------------------------------------------------------------

const control = rows.find((r) => r.role === "CONTROL") ?? null;
const pPassed = rows.filter((r) => r.role === "P" && r.observedState === "STARTED_PASSED").map((r) => r.repo);
const fFailed = rows.filter((r) => r.role === "F" && r.observedState === "STARTED_FAILED").map((r) => r.repo);
const ready = repoVerdicts.filter((v) => v.verdict === "REPO_VALIDATION_READY").map((v) => v.repo as string);

const conditions = [
  { id: "R1", requirement: ">= 3 repositories reach STARTED_PASSED on the P-probe", observed: pPassed.length, threshold: 3, pass: pPassed.length >= 3 },
  { id: "R2", requirement: ">= 3 repositories reach STARTED_FAILED on the F-probe", observed: fFailed.length, threshold: 3, pass: fFailed.length >= 3 },
  { id: "R3", requirement: ">= 1 repository proves both on the same instance", observed: ready.length, threshold: 1, pass: ready.length >= 1 },
  { id: "R4", requirement: "the Z1 control does NOT start a runner", observed: control === null ? "not run" : String(control.runnerStarted), threshold: "false", pass: control !== null && control.runnerStarted !== true },
  { id: "R5", requirement: "no probe required a privileged bypass", observed: rows.filter((r) => r.requiredPrivilegedBypass).length, threshold: 0, pass: rows.every((r) => r.requiredPrivilegedBypass === false) },
  { id: "R6", requirement: ">= 4 repositories are REPO_VALIDATION_READY", observed: ready.length, threshold: 4, pass: ready.length >= 4 },
];
const gate = conditions.every((c) => c.pass) ? "VALIDATION_ENVIRONMENT_READY" : "VALIDATION_ENVIRONMENT_NOT_READY";

const artifact = {
  schemaVersion: "stage5.m191.readiness-probes.v1",
  milestone: "M191",
  stage: "A",
  prereg: "results/stage5_m191_readiness_prereg.md",
  note: "No agent was spawned and no live benchmark budget was spent. The environment is built by the production materializeAgentShellGuard call and exercised through `bash -c`, which is the shell the agent's Bash tool uses. Benchmark repositories are read via `git archive` and never mutated.",
  guardEnvironment: guardEnvSummary,
  externalHarness: {
    dir: VEXP,
    head: sh(`git -C ${JSON.stringify(VEXP)} rev-parse HEAD`).out.trim(),
    workingTreeEntries: sh(`git -C ${JSON.stringify(VEXP)} status --porcelain | wc -l`).out.trim(),
    methodologicalClaimsUseImmutableHead: true,
  },
  selection: selections.map((s) => ({ repo: s.repo, instanceId: s.instance?.instance_id ?? null, reason: s.reason, passToPassTest: s.p2p, failToPassTest: s.f2p })),
  repositoriesProbed: selections.length,
  repoVerdicts,
  probes: rows,
  gateConditions: conditions,
  repositoriesValidationReady: ready,
  gate,
};

writeFileSync(path.join(RESULTS, "stage5_m191_readiness_probes.json"), `${JSON.stringify(artifact, null, 2)}\n`);

// -----------------------------------------------------------------------------------------
// §35 readiness report — rendered from the artifact above, so the table cannot drift from
// the evidence it describes.
// -----------------------------------------------------------------------------------------

const cell = (v: unknown) => String(v ?? "—").replace(/\|/g, "\\|");
const md: string[] = [
  "# M191 Stage A — validation readiness report",
  "",
  "Generated by `run_stage5_m191_readiness.ts`. Design and gate preregistered in",
  "`stage5_m191_readiness_prereg.md`, committed before the first probe ran.",
  "",
  `**Gate: \`${gate}\`** — ${conditions.filter((c) => c.pass).length} of ${conditions.length} preregistered conditions met.`,
  "",
  "No agent was spawned. Live spend: $0.",
  "",
  "## Per-probe evidence",
  "",
  "| probe | repo | instance | command | runner-start evidence | classification | termination | ms | runner started |",
  "|---|---|---|---|---|---|---|---:|---|",
];
for (const r of rows) {
  // The control is the one row where NOT starting is the correct outcome.
  const started = r.role === "CONTROL"
    ? (r.runnerStarted === true ? "**yes — the control failed**" : "no (correct: this is the control)")
    : (r.runnerStarted === true ? "yes" : "**no**");
  md.push(
    `| \`${cell(r.id)}\` | ${cell(r.repo)} | ${cell(r.instanceId)} | \`${cell(r.command)}\` | ${cell(r.runnerStartEvidence)} | \`${cell(r.observedState)}\` | ${cell(r.termination)} | ${cell(r.durationMs)} | ${started} |`,
  );
}
md.push(
  "",
  "Every probe ran through `bash -c` with the environment built by the production",
  "`materializeAgentShellGuard` call — the agent's own path. No probe used a privileged bypass.",
  "",
  "## Per-repository verdict",
  "",
  "| repository | instance | P-probe | F-probe | source the tests actually exercised | verdict |",
  "|---|---|---|---|---|---|",
);
for (const v of repoVerdicts) {
  const sp = (v as { sourceProvenance?: SourceProvenance }).sourceProvenance;
  const prov = sp === undefined ? "—"
    : sp.resolvesToRepositoryUnderTest === true ? "checked-out source"
      : sp.resolvesToRepositoryUnderTest === false ? "**an installed copy**"
        : "not importable";
  md.push(`| ${cell(v.repo)} | ${cell(v.instanceId)} | \`${cell(v.pProbe)}\` | \`${cell(v.fProbe)}\` | ${prov} | \`${cell(v.verdict)}\` |`);
}
md.push("", "## Preregistered gate", "", "| id | requirement | observed | threshold | result |", "|---|---|---|---|---|");
for (const c of conditions) {
  md.push(`| ${c.id} | ${c.requirement} | ${cell(c.observed)} | ${cell(c.threshold)} | ${c.pass ? "pass" : "**FAIL**"} |`);
}
md.push("", `**${gate}**`, "");

writeFileSync(path.join(RESULTS, "stage5_m191_readiness_report.md"), `${md.join("\n")}\n`);

console.log("");
for (const c of conditions) console.log(`${c.pass ? "ok  " : "FAIL"} ${c.id}  ${c.requirement}  (observed ${c.observed})`);
console.log(`\n${gate}`);
if (gate !== "VALIDATION_ENVIRONMENT_READY") process.exitCode = 2;
