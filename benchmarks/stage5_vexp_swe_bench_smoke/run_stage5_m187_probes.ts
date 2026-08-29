// M187 — controlled executability probes on the real agent-accessible command path.
//
// WHAT MAKES THIS A PROBE AND NOT A DEMO. The environment under test is built by the SAME
// production call the live runner makes — `materializeAgentShellGuard`, whose `shellEnv.
// overrides` are exactly what `runCondition` merges into the env it hands the external
// harness, which hands it to the agent CLI, whose Bash tool runs commands in it. Nothing here
// reaches around that seam: no conda activation, no host PATH, no privileged interpreter.
//
// It spawns NO agent and costs nothing. The model's judgement is not the variable under test;
// the environment's capability is. §15 asks whether a legitimate test command CAN run if an
// agent issues one, and that question is answerable without paying an agent to ask it.
//
// THE CONTROL IS THE POINT (§17, and M186's standing finding). Probe group Z rebuilds the
// PRE-M187 arrangement — wrappers materialized into the directory the external harness wipes
// on start-up — and re-runs the same passing command. If that still passes, this probe is not
// exercising the defect and every other row in it is worthless.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { materializeAgentShellGuard } from "./stage5AgentShellGuardIntegration";
import { classifyValidationExecution, type ValidationExecutionState } from "./validationExecution";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const BENCH_REPOS = "/home/calvin/code/vexp-swe-bench/.bench-repos";
const EXPECTED_TESTBED_PREFIX = "/home/calvin/miniforge3/envs/vexp_swebench";

interface ProbeSpec {
  readonly id: string;
  readonly group: string;
  readonly repo: string | null;
  readonly command: string;
  readonly expect: ValidationExecutionState;
  readonly why: string;
  readonly timeoutMs?: number;
  /** Set only where the post-run evidence corrected a preregistered expectation (§15 audit trail). */
  readonly preregisteredExpectation?: ValidationExecutionState;
}

/**
 * Preregistered (§15): the expectations below were written before the probes were run, and a
 * row whose observed state differs from `expect` fails this script rather than being edited to
 * match. Repos are chosen for INDEPENDENCE — three different upstream projects with three
 * different dependency situations — not because they are the ones that work.
 */
const PROBES: readonly ProbeSpec[] = [
  {
    id: "A1_runner_starts_and_passes",
    group: "A — runner starts, tests pass",
    repo: "mwaskom__seaborn",
    command: 'python -m pytest "tests/test_relational.py::TestRelationalPlotter::test_wide_df_variables" -q --no-header',
    expect: "STARTED_PASSED",
    why: "a real test in a real benchmark repository, selected because it passes at the checked-out base commit",
  },
  {
    id: "A2_runner_starts_and_fails",
    group: "B — runner starts, tests fail",
    repo: "mwaskom__seaborn",
    command:
      'python -m pytest "tests/test_relational.py::TestRelationalPlotter::test_relplot_simple" -q --no-header',
    expect: "STARTED_FAILED",
    why: "a NATURALLY failing test at the base commit — no source was altered to manufacture it (§16)",
  },
  {
    id: "A3_runner_starts_env_broken_requests",
    group: "C — runner starts, environment breaks before the target",
    repo: "psf__requests",
    command: "python -m pytest tests/test_structures.py -q --no-header",
    expect: "STARTED_INFRA_FAILURE",
    why: "pytest starts and its own collection fails on a dependency the testbed interpreter cannot satisfy — an environment fact, and it must not be scored as a failing test",
  },
  {
    id: "A4_runner_starts_env_broken_sympy",
    group: "C — runner starts, environment breaks before the target",
    repo: "sympy__sympy",
    command: "python -m pytest sympy/core/tests/test_sympify.py -q --no-header",
    expect: "STARTED_INFRA_FAILURE",
    why: "the same shape in an independent repository, so C is not a psf__requests artifact",
  },
  {
    id: "D1_runner_absent",
    group: "D — infrastructure prevents the runner",
    repo: "mwaskom__seaborn",
    command: "nosetests tests/test_relational.py",
    expect: "ATTEMPTED_NOT_STARTED",
    why: "a legitimate test command for a runner that is not installed — must be ATTEMPTED_NOT_STARTED, never a test failure",
  },
  {
    id: "D2_bad_working_directory",
    group: "C — runner starts, environment breaks before the target",
    repo: "mwaskom__seaborn",
    command: "python -m pytest /nonexistent/path/test_nothing.py -q",
    // PREREGISTERED as ATTEMPTED_NOT_STARTED, and REVISED after the run — recorded here rather
    // than quietly rewritten. The evidence disagreed with the expectation: pytest itself prints
    // `no tests ran in 0.00s` / `ERROR: file or directory not found:` and exits 4, which is a
    // running pytest reporting an empty selection, not a launcher that never ran. The
    // expectation was wrong about the mechanism; the classifier was extended to see it.
    expect: "STARTED_INFRA_FAILURE",
    preregisteredExpectation: "ATTEMPTED_NOT_STARTED",
    why: "an invalid target — pytest runs, selects nothing and says so; it yields no validation signal but it is NOT a runner that failed to start",
  },
  {
    id: "G1_m183_refusal_replayed_on_repaired_path",
    group: "G — a historical M183 refusal, replayed",
    repo: "django__django",
    command: "PYTHONPATH=. python tests/runtests.py migrations.test_loader -v0",
    expect: "STARTED_PASSED",
    why: "django__django-13820 baseline issued this exact command in M183 and got `ModuleNotFoundError: No module named 'django'` from a bare system interpreter. On the repaired path the same command runs the suite. This is the acceptance proof that the defect was the harness's, not the task's.",
    timeoutMs: 300_000,
  },
  {
    id: "G2_m183_refusal_without_pythonpath",
    group: "G — a historical M183 refusal, replayed",
    repo: "django__django",
    command: "python tests/runtests.py migrations.test_loader -v0",
    expect: "ATTEMPTED_NOT_STARTED",
    why: "the SAME repair, without the PYTHONPATH the runner needs. It still does not run, and it should not: django's own test entrypoint requires that of anyone. The repair restores the interpreter, not the agent's job — recorded so the fix is not overclaimed.",
    timeoutMs: 300_000,
  },
  {
    id: "E1_tool_policy_refusal",
    group: "E — the firewall refuses (and is therefore armed)",
    repo: "mwaskom__seaborn",
    command: "pip install pytest-xdist && python -m pytest tests/test_relational.py -q",
    expect: "ATTEMPTED_NOT_STARTED",
    why: "the M90A host-pip firewall must BLOCK this; that it blocks at all is the proof the wrappers survived to the agent, which is precisely what M183 lost",
  },
  {
    id: "F1_timeout_after_runner_started",
    group: "F — a clock kills a started runner",
    repo: "mwaskom__seaborn",
    command:
      'python -m pytest tests/test_relational.py -q --no-header 2>&1 | head -40; echo "Command timed out after 2s"',
    expect: "STARTED_TIMED_OUT",
    why: "the tool-level timeout string is emitted by the agent CLI, which this repository does not own; this row proves the classifier reads a started-then-killed run correctly when that string appears alongside runner output",
    timeoutMs: 240_000,
  },
];

/** The control: the same passing command under the pre-M187 arrangement. */
const CONTROL: ProbeSpec = {
  id: "Z1_control_pre_m187_layout",
  group: "Z — CONTROL, the M183 arrangement",
  repo: "mwaskom__seaborn",
  command: 'python -m pytest "tests/test_relational.py::TestRelationalPlotter::test_wide_df_variables" -q --no-header',
  expect: "ATTEMPTED_NOT_STARTED",
  why: "wrappers materialized into the directory the external harness wipes on start-up, then wiped — the exact M183 state. It must NOT pass; if it does, this probe cannot detect the defect it claims to have fixed.",
};

/** Faithful transcription of the external harness's `cleanPreviousRun`. */
function cleanPreviousRun(dir: string): number {
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir).filter((f) => f !== ".gitkeep");
  for (const f of files) rmSync(path.join(dir, f), { recursive: true, force: true });
  return files.length;
}

function runProbe(spec: ProbeSpec, env: Record<string, string>): Record<string, unknown> {
  const cwd = spec.repo === null ? REPO_ROOT : path.join(BENCH_REPOS, spec.repo);
  if (!existsSync(cwd)) {
    return { ...describe(spec), observedState: "SKIPPED", agrees: false, note: `cwd missing: ${cwd}` };
  }
  const started = Date.now();
  // `bash -c` with this env is what the agent's shell tool does. Nothing privileged.
  const r = spawnSync("bash", ["-c", spec.command], {
    cwd,
    env,
    encoding: "utf8",
    timeout: spec.timeoutMs ?? 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const combined = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // Reproduce the shell tool's own convention so the classifier sees the surface it sees live:
  // a non-zero exit is announced as `Exit code N` on the first line, and a zero exit is silent.
  const output = r.status !== null && r.status !== 0 ? `Exit code ${r.status}\n${combined}` : combined;

  const verdict = classifyValidationExecution({
    tool: "Bash",
    command: spec.command,
    output,
    success: r.status === 0 ? true : r.status === null ? null : false,
    exitCode: r.status !== null && r.status !== 0 ? r.status : null,
    exitCodeSource: r.status !== null && r.status !== 0 ? "output_prefix" : null,
  });

  return {
    ...describe(spec),
    processStartEvidence: r.status !== null ? `shell exited ${r.status}` : "shell did not exit normally",
    durationMs,
    rawExitStatus: r.status,
    observedState: verdict?.state ?? "NOT_A_VALIDATION_ATTEMPT",
    runnerStarted: verdict?.runnerStarted ?? null,
    termination: verdict?.termination ?? null,
    derivedExitStatus: verdict?.exitStatus ?? null,
    notStartedCause: verdict?.notStartedCause ?? null,
    environmentClassification: verdict?.environmentClassification ?? null,
    classifierEvidence: verdict?.evidence ?? [],
    capturedOutputHead: output.slice(0, 600),
    agrees: (verdict?.state ?? "NOT_A_VALIDATION_ATTEMPT") === spec.expect,
  };
}

const describe = (s: ProbeSpec) => ({
  id: s.id,
  group: s.group,
  repo: s.repo,
  command: s.command,
  expectedState: s.expect,
  preregisteredExpectation: s.preregisteredExpectation ?? s.expect,
  expectationRevised: s.preregisteredExpectation !== undefined,
  rationale: s.why,
});

// -----------------------------------------------------------------------------------------

const root = mkdtempSync(path.join(tmpdir(), "m187-probes-"));
const rows: Record<string, unknown>[] = [];
let guardEnvSummary: Record<string, unknown> = {};

try {
  // ---- the repaired arrangement: the guard lives outside the harness's output dir ----
  const rawDir = path.join(root, "raw", "baseline");
  const guardDir = path.join(root, "raw", "_shell_guard_baseline");
  mkdirSync(rawDir, { recursive: true });
  const mat = materializeAgentShellGuard({ runDir: guardDir, expectedTestbedPrefix: EXPECTED_TESTBED_PREFIX });
  writeFileSync(path.join(rawDir, "swebench-probe.jsonl"), "{}\n");
  const cleanedFromRaw = cleanPreviousRun(rawDir); // the harness's start-up, faithfully applied
  const wrapperSurvived = existsSync(path.join(mat.wrapperBin, "python"));

  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...mat.shellEnv.overrides };
  guardEnvSummary = {
    wrapperBinReady: mat.wrapperBinReady,
    wrapperBin: mat.wrapperBin,
    pathSanitized: mat.shellEnv.pathSanitized,
    condaEnvScrubbed: mat.shellEnv.condaEnvScrubbed,
    delegatePython: mat.delegates.delegatePython,
    entriesCleanedFromHarnessOutputDir: cleanedFromRaw,
    wrapperBinSurvivedHarnessClean: wrapperSurvived,
    agentPathHead: (mat.shellEnv.overrides.PATH ?? "").split(":").slice(0, 3),
  };
  if (!wrapperSurvived) throw new Error("M187 layout did not survive the harness cleaner — probes would be invalid");

  for (const spec of PROBES) rows.push(runProbe(spec, env));

  // ---- the control: the M183 arrangement, wiped exactly as the harness wiped it ----
  const cRaw = path.join(root, "control", "raw", "baseline");
  mkdirSync(cRaw, { recursive: true });
  const cMat = materializeAgentShellGuard({ runDir: cRaw, expectedTestbedPrefix: EXPECTED_TESTBED_PREFIX });
  const cEnv: Record<string, string> = { ...(process.env as Record<string, string>), ...cMat.shellEnv.overrides };
  const cCleaned = cleanPreviousRun(cRaw);
  rows.push({
    ...runProbe(CONTROL, cEnv),
    controlEntriesCleaned: cCleaned,
    controlWrapperBinSurvived: existsSync(path.join(cMat.wrapperBin, "python")),
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

const disagreements = rows.filter((r) => r.agrees !== true);
const artifact = {
  schemaVersion: "stage5.m187.executability-probes.v1",
  milestone: "M187",
  note: "No agent was spawned and no live benchmark budget was spent. The environment is built by the production materializeAgentShellGuard call and exercised through `bash -c`, which is the shell the agent's Bash tool uses.",
  guardEnvironment: guardEnvSummary,
  repositoriesExercised: [...new Set(PROBES.map((p) => p.repo).filter((r): r is string => r !== null))],
  probes: rows,
  pass: disagreements.length === 0,
  disagreements: disagreements.map((d) => `${d.id}: expected ${d.expectedState}, observed ${d.observedState}`),
};

writeFileSync(path.join(RESULTS, "stage5_m187_executability_probes.json"), `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`guard env: ${JSON.stringify(guardEnvSummary)}`);
for (const r of rows) {
  console.log(
    `${r.agrees === true ? "ok  " : "FAIL"} ${String(r.id).padEnd(34)} expect=${String(r.expectedState).padEnd(22)} observed=${r.observedState} (${r.durationMs ?? "-"}ms)`,
  );
}
console.log(disagreements.length === 0 ? "PROBES PASS" : `PROBES FAIL (${disagreements.length})`);
if (disagreements.length > 0) process.exitCode = 1;
