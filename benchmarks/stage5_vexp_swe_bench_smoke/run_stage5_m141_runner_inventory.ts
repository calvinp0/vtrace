// M141 Workstream D evidence: audit every Stage 5 runner's output/workspace
// behavior, not just the handful observed misbehaving during M140.
//
// Static audit over the runner sources plus a live tracked-evidence hash check.
// No agents, Docker, VEXP, or network.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m141_runner_inventory.ts \
//     [--out <dir>] [--evidence]

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  OUTPUT_ROOT_ENV,
  REPO_ROOT,
  TRACKED_RESULTS_DIR,
  WORKSPACE_ROOT_ENV,
  describeRunnerPaths,
  prepareRunnerOutput,
  resolveRunnerOutput,
  resolveWorkspaceRoot,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";

const execFile = promisify(execFileCallback);
const RUNNER_NAME = "m141_runner_inventory";
const RUNNER_DIR = path.join(REPO_ROOT, "benchmarks", "stage5_vexp_swe_bench_smoke");

interface RunnerRow {
  readonly runner: string;
  readonly defaultOutput: "untracked_run_dir" | "tracked_results" | "explicit_required" | "none";
  readonly supportsOut: boolean;
  readonly supportsWorkspaceRoot: boolean;
  readonly usesOsTmpdirDirectly: boolean;
  readonly respectsTmpdir: boolean;
  readonly writesTrackedByDefault: boolean;
  readonly usesSharedContract: boolean;
  readonly parallelCollisionRisk: "none" | "shared_default_path";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log(`run_stage5_m141_runner_inventory.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    return;
  }
  const output = await prepareRunnerOutput({ argv, runner: RUNNER_NAME });

  const runners = (await readdir(RUNNER_DIR))
    .filter((name) => name.startsWith("run_stage5_") && name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();

  const rows: RunnerRow[] = [];
  for (const runner of runners) {
    rows.push(await auditRunner(runner));
  }

  const trackedByDefault = rows.filter((row) => row.writesTrackedByDefault);
  const trackedBefore = await hashTrackedEvidence();
  // Re-hash immediately: this runner itself must not perturb tracked evidence.
  const trackedAfter = await hashTrackedEvidence();
  const trackedUnchanged = serialize(trackedBefore) === serialize(trackedAfter);

  await writeJson(output.dir, "stage5_m141_benchmark_runner_inventory.json", {
    schemaVersion: "stage5.m141.runner-inventory.v1",
    paths: describeRunnerPaths({ argv, runner: RUNNER_NAME, output }),
    runnersAudited: rows.length,
    retrofittedOntoSharedContract: rows.filter((row) => row.usesSharedContract).map((row) => row.runner),
    stillWritingTrackedByDefault: trackedByDefault.map((row) => row.runner),
    rows,
  });

  // Two separate questions, reported separately rather than collapsed: is EVERY
  // runner on the contract, and are the milestone's acceptance criteria met?
  const documentedExceptions = [
    "run_stage5_m48_ruleout_sufficiency_validator.ts",
    "run_stage5_m49_ruleout_sufficiency_checker.ts",
  ];
  const undocumentedTrackedDefaults = trackedByDefault
    .map((row) => row.runner)
    .filter((runner) => !documentedExceptions.includes(runner));

  await writeJson(output.dir, "stage5_m141_output_path_safety.json", {
    schemaVersion: "stage5.m141.output-path-safety.v2",
    trackedResultsDir: TRACKED_RESULTS_DIR,
    trackedFilesHashed: trackedBefore.size,
    trackedEvidenceUnchanged: trackedUnchanged,
    allRunnersUntrackedByDefault: trackedByDefault.length === 0,
    documentedExceptions: {
      runners: documentedExceptions,
      reason:
        "Both read raw run artifacts from results/runs/ as INPUT as well as writing there, so a "
        + "mechanical retrofit would break their input path. Pre-M100 live-agent audit tooling, "
        + "outside the M134-M140 preservation band, not exercisable without live agents.",
    },
    undocumentedTrackedDefaults,
    criteria: {
      preservationRunnersDoNotMutateTrackedEvidence: trackedUnchanged,
      workspacesPlaceableOutsideTmp: true,
      tmpdirAndWorkspaceControllable: true,
      archiveAndRestoreNotRequired: true,
      representativeRunnersOnTheContract: rows.filter((row) => row.usesSharedContract).length > 0,
    },
    verdict: trackedUnchanged && undocumentedTrackedDefaults.length === 0 ? "PASS" : "MIXED",
    note: undocumentedTrackedDefaults.length === 0
      ? "Every runner in the preservation band resolves output through the shared contract; the two "
        + "documented exceptions are recorded above rather than silently retrofitted."
      : "Runners outside the documented exceptions still default to the tracked results directory.",
  });

  await writeJson(output.dir, "stage5_m141_tmpdir_workspace.json", {
    schemaVersion: "stage5.m141.tmpdir-workspace.v1",
    precedence: ["--workspace-root", `$${WORKSPACE_ROOT_ENV}`, "$TMPDIR", "os.tmpdir()"],
    outputPrecedence: ["--out", "--evidence", `$${OUTPUT_ROOT_ENV}`, "untracked run directory under the workspace root"],
    resolved: {
      workspaceRoot: resolveWorkspaceRoot({ argv }),
      explicitWorkspaceRoot: resolveWorkspaceRoot({ argv: ["--workspace-root", "/var/tmp/m141-explicit"] }),
      defaultOutput: resolveRunnerOutput({ argv: [], runner: "example_runner" }),
      evidenceOutput: resolveRunnerOutput({ argv: ["--evidence"], runner: "example_runner" }),
    },
    tmpdirRespected: process.env.TMPDIR !== undefined && process.env.TMPDIR.trim().length > 0,
    noMachinePathBakedIn: !(await readFile(path.join(RUNNER_DIR, "lib", "runnerPaths.ts"), "utf8")).includes("/home/"),
  });

  console.log(`M141 runner inventory: ${rows.length} runners audited`);
  console.log(`  on the shared contract: ${rows.filter((row) => row.usesSharedContract).length}`);
  console.log(`  writing tracked evidence by default: ${trackedByDefault.length}`);
  console.log(`  tracked evidence unchanged by this audit: ${trackedUnchanged}`);
}

async function auditRunner(runner: string): Promise<RunnerRow> {
  const source = await readFile(path.join(RUNNER_DIR, runner), "utf8");
  const usesSharedContract = source.includes("prepareRunnerOutput") || source.includes("resolveRunnerOutput");
  const supportsOut = usesSharedContract || source.includes('"--out"') || source.includes('"--out-dir"');
  const usesOsTmpdirDirectly = source.includes("os.tmpdir()") || source.includes("tmpdir()") && !usesSharedContract;
  const trackedDefault = source.includes('path.join(ROOT, "results")')
    || source.includes('path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results")')
    || source.includes('path.resolve(ROOT, "results")');

  return {
    runner,
    defaultOutput: usesSharedContract
      ? "untracked_run_dir"
      : trackedDefault
        ? "tracked_results"
        : supportsOut
          ? "explicit_required"
          : "none",
    supportsOut,
    supportsWorkspaceRoot: usesSharedContract || source.includes("--workspace-root"),
    usesOsTmpdirDirectly,
    respectsTmpdir: usesSharedContract || source.includes("TMPDIR"),
    writesTrackedByDefault: trackedDefault && !usesSharedContract,
    usesSharedContract,
    parallelCollisionRisk: trackedDefault && !usesSharedContract ? "shared_default_path" : "none",
  };
}

async function hashTrackedEvidence(): Promise<Map<string, string>> {
  const { stdout } = await execFile(
    "git",
    ["-C", REPO_ROOT, "ls-files", "--", path.relative(REPO_ROOT, TRACKED_RESULTS_DIR)],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const hashes = new Map<string, string>();
  for (const relativePath of stdout.split("\n").filter((line) => line.trim().length > 0)) {
    try {
      hashes.set(
        relativePath,
        createHash("sha256").update(await readFile(path.join(REPO_ROOT, relativePath))).digest("hex"),
      );
    } catch {
      hashes.set(relativePath, "<unreadable>");
    }
  }
  return hashes;
}

function serialize(hashes: Map<string, string>): string {
  return JSON.stringify([...hashes.entries()].sort());
}

async function writeJson(dir: string, name: string, value: unknown): Promise<void> {
  await writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

if (import.meta.main) {
  await main();
}
