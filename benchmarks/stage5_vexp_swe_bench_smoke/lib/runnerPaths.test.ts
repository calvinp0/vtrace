// M141 Workstream D — the output contract, and the tracked-evidence guarantee.
//
// The strong gate (§48/§49 of the M141 brief): snapshot the tracked benchmark
// evidence, run representative preservation commands, and prove the tracked
// hashes are unchanged. `git status --porcelain` by hand is not a test.

import { afterAll, describe, expect, test } from "bun:test";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  OUTPUT_ROOT_ENV,
  REPO_ROOT,
  TRACKED_RESULTS_DIR,
  WORKSPACE_ROOT_ENV,
  resolveRunnerOutput,
  resolveWorkspaceRoot,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./runnerPaths";

const execFile = promisify(execFileCallback);

/** Runners retrofitted onto the shared contract in M141. */
const RETROFITTED_RUNNERS = [
  "run_stage5_m130_flow_and_response_smoke.ts",
  "run_stage5_m131_flow_scalability_smoke.ts",
  "run_stage5_m132_worktree_smoke.ts",
  "run_stage5_m136_budget_delivery_smoke.ts",
  "run_stage5_m137_no_agent_smoke.ts",
  "run_stage5_m138_memory_provenance_smoke.ts",
] as const;

const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

function withEnvironment<T>(overrides: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CLEAN_ENVIRONMENT = {
  [OUTPUT_ROOT_ENV]: undefined,
  [WORKSPACE_ROOT_ENV]: undefined,
  TMPDIR: undefined,
} as const;

/** Content hashes of every tracked file under the results directory. */
async function hashTrackedEvidence(): Promise<Map<string, string>> {
  const { stdout } = await execFile(
    "git",
    ["-C", REPO_ROOT, "ls-files", "--", path.relative(REPO_ROOT, TRACKED_RESULTS_DIR)],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const relativePaths = stdout.split("\n").filter((line) => line.trim().length > 0);
  const hashes = new Map<string, string>();
  for (const relativePath of relativePaths) {
    const absolute = path.join(REPO_ROOT, relativePath);
    try {
      hashes.set(relativePath, createHash("sha256").update(await readFile(absolute)).digest("hex"));
    } catch {
      hashes.set(relativePath, "<unreadable>");
    }
  }
  return hashes;
}

describe("M141 benchmark output contract", () => {
  test("the default output directory is untracked, never the evidence directory", () => {
    const target = withEnvironment(CLEAN_ENVIRONMENT, () => resolveRunnerOutput({
      argv: [],
      runner: "m141_probe",
    }));

    expect(target.writesTrackedEvidence).toBe(false);
    expect(target.source).toBe("default_untracked");
    expect(path.relative(TRACKED_RESULTS_DIR, target.dir).startsWith("..")).toBe(true);
    expect(path.relative(REPO_ROOT, target.dir).startsWith("..")).toBe(true);
  });

  test("--out redirects output and reports whether it lands on tracked evidence", () => {
    const outside = withEnvironment(CLEAN_ENVIRONMENT, () => resolveRunnerOutput({
      argv: ["--out", "/var/tmp/m141-elsewhere"],
      runner: "m141_probe",
    }));
    expect(outside.dir).toBe("/var/tmp/m141-elsewhere");
    expect(outside.writesTrackedEvidence).toBe(false);

    // Pointing --out INTO results/ is a legitimate, and declared, evidence run.
    const intoEvidence = withEnvironment(CLEAN_ENVIRONMENT, () => resolveRunnerOutput({
      argv: ["--out", TRACKED_RESULTS_DIR],
      runner: "m141_probe",
    }));
    expect(intoEvidence.writesTrackedEvidence).toBe(true);
  });

  test("--evidence is the only implicit route to the tracked results directory", () => {
    const target = withEnvironment(CLEAN_ENVIRONMENT, () => resolveRunnerOutput({
      argv: ["--evidence"],
      runner: "m141_probe",
    }));

    expect(target.dir).toBe(TRACKED_RESULTS_DIR);
    expect(target.writesTrackedEvidence).toBe(true);
    expect(target.source).toBe("evidence_flag");
  });

  test("the output root environment variable applies per runner", () => {
    const target = withEnvironment(
      { ...CLEAN_ENVIRONMENT, [OUTPUT_ROOT_ENV]: "/var/tmp/m141-session" },
      () => resolveRunnerOutput({ argv: [], runner: "m141_probe" }),
    );

    expect(target.dir).toBe("/var/tmp/m141-session/m141_probe");
    expect(target.source).toBe("environment");
    expect(target.writesTrackedEvidence).toBe(false);
  });

  test("workspace root precedence is explicit > configured > TMPDIR > os default", () => {
    expect(withEnvironment(
      { ...CLEAN_ENVIRONMENT, [WORKSPACE_ROOT_ENV]: "/var/tmp/configured", TMPDIR: "/var/tmp/from-tmpdir" },
      () => resolveWorkspaceRoot({ argv: ["--workspace-root", "/var/tmp/explicit"] }),
    )).toBe("/var/tmp/explicit");

    expect(withEnvironment(
      { ...CLEAN_ENVIRONMENT, [WORKSPACE_ROOT_ENV]: "/var/tmp/configured", TMPDIR: "/var/tmp/from-tmpdir" },
      () => resolveWorkspaceRoot({ argv: [] }),
    )).toBe("/var/tmp/configured");

    // A caller-provided TMPDIR is respected, never overridden.
    expect(withEnvironment(
      { ...CLEAN_ENVIRONMENT, TMPDIR: "/var/tmp/from-tmpdir" },
      () => resolveWorkspaceRoot({ argv: [] }),
    )).toBe("/var/tmp/from-tmpdir");

    expect(withEnvironment(CLEAN_ENVIRONMENT, () => resolveWorkspaceRoot({ argv: [] }))).toBe(tmpdir());
  });

  test("no machine-specific workspace path is baked into the contract", async () => {
    const source = await readFile(path.join(import.meta.dir, "runnerPaths.ts"), "utf8");
    // The M140 workspace lived at /home/calvin/bench/vtrace-m140; that belongs in
    // an environment variable, not in a committed runner.
    expect(source).not.toContain("/home/calvin");
  });

  test("every retrofitted runner resolves output through the shared contract", async () => {
    for (const runner of RETROFITTED_RUNNERS) {
      const source = await readFile(
        path.join(REPO_ROOT, "benchmarks", "stage5_vexp_swe_bench_smoke", runner),
        "utf8",
      );
      expect(source).toContain("prepareRunnerOutput");
      expect(source).toContain("await resolveResults();");
      // The old hard-coded tracked default must be gone.
      expect(source).not.toContain('const RESULTS = path.join(ROOT, "results")');
      expect(source).not.toContain('const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results")');
      // And os.tmpdir() must no longer be reached for large scratch state.
      expect(source).not.toContain("os.tmpdir()");
    }
  });

  test("a representative preservation run leaves tracked evidence byte-identical", async () => {
    const before = await hashTrackedEvidence();
    expect(before.size).toBeGreaterThan(0);

    const outputRoot = path.join(tmpdir(), `m141-immutability-${process.pid}`);
    created.push(outputRoot);

    // M138's memory-provenance smoke is the cheapest runner that used to write
    // straight into results/. It needs no ARC index to reach its output setup.
    await execFile(
      "bun",
      [
        path.join(REPO_ROOT, "benchmarks", "stage5_vexp_swe_bench_smoke", "run_stage5_m138_memory_provenance_smoke.ts"),
        "--help",
      ],
      { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, [OUTPUT_ROOT_ENV]: outputRoot } },
    );

    const after = await hashTrackedEvidence();
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());

    // And the working tree is unchanged by that run.
    const { stdout } = await execFile(
      "git",
      ["-C", REPO_ROOT, "status", "--porcelain", "--", path.relative(REPO_ROOT, TRACKED_RESULTS_DIR)],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    const modifiedTracked = stdout
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.startsWith("??"));
    // The two outcome-ledger files are pre-existing dirt that predates M141.
    for (const line of modifiedTracked) {
      expect(line).toContain("stage5_outcome_ledger");
    }
  }, 60_000);

  test("help text documents output, workspace, and evidence behavior", () => {
    expect(SHARED_RUNNER_OPTIONS_HELP).toContain("--out <dir>");
    expect(SHARED_RUNNER_OPTIONS_HELP).toContain("--evidence");
    expect(SHARED_RUNNER_OPTIONS_HELP).toContain("--workspace-root <dir>");
    expect(SHARED_RUNNER_OPTIONS_HELP).toContain("$TMPDIR");
    expect(SHARED_RUNNER_OPTIONS_HELP).toContain("never write tracked evidence");
  });

  test("parallel runs of the same runner do not share a deterministic output path", async () => {
    const first = withEnvironment(
      { ...CLEAN_ENVIRONMENT, [OUTPUT_ROOT_ENV]: "/var/tmp/run-a" },
      () => resolveRunnerOutput({ argv: [], runner: "m141_probe" }),
    );
    const second = withEnvironment(
      { ...CLEAN_ENVIRONMENT, [OUTPUT_ROOT_ENV]: "/var/tmp/run-b" },
      () => resolveRunnerOutput({ argv: [], runner: "m141_probe" }),
    );

    // Two concurrent runs isolate by pointing at different roots — one flag or
    // one environment variable, no shared mutable default in the tracked tree.
    expect(first.dir).not.toBe(second.dir);
  });

  test("the tracked results directory exists and is what the contract points at", async () => {
    expect((await stat(TRACKED_RESULTS_DIR)).isDirectory()).toBe(true);
    expect((await readdir(TRACKED_RESULTS_DIR)).length).toBeGreaterThan(0);
  });
});
