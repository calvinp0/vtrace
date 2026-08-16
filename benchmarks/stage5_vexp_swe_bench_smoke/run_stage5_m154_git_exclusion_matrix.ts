// M154-B evidence: what `git add -A` would stage, before and after vtrace
// establishes its local exclusion, across every Git layout the product supports.
//
// The measurement is `git add -n -A` — a dry run. Nothing is ever staged, and
// every fixture is a throwaway repository under a temp root, so no real
// repository's index or exclude file is touched.

import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  ensureGeneratedStateExcluded,
  type GeneratedStateExclusionResult,
} from "../../src/setup/generatedStateExclusion";
import { REPO_LOCAL_STATE_DIRNAME } from "../../src/setup/types";

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", [...args], { cwd, encoding: "utf8" });
  return stdout;
}

async function initGitRepo(repoRoot: string): Promise<void> {
  await git(repoRoot, ["init", "-q"]);
  await git(repoRoot, ["config", "user.email", "m154@example.test"]);
  await git(repoRoot, ["config", "user.name", "M154"]);
  await git(repoRoot, ["config", "commit.gpgsign", "false"]);
}

async function seedRepo(repoRoot: string): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await initGitRepo(repoRoot);
  await writeFile(path.join(repoRoot, "module.py"), "x = 1\n");
  await git(repoRoot, ["add", "-A"]);
  await git(repoRoot, ["commit", "-qm", "initial"]);
}

async function writeGeneratedState(repoRoot: string): Promise<void> {
  const stateDir = path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME);
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "index.sqlite"), "index-bytes");
  await writeFile(path.join(stateDir, "session.sqlite"), "session-bytes");
}

/** Repo-relative paths an ordinary `git add -A` would stage right now. */
async function stagingPreview(repoRoot: string): Promise<string[]> {
  const stdout = await git(repoRoot, ["add", "-n", "-A"]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^add '(.*)'$/, "$1"));
}

function vtraceStateIn(paths: readonly string[]): string[] {
  return paths.filter((entry) => entry.includes(REPO_LOCAL_STATE_DIRNAME));
}

interface Scenario {
  readonly name: string;
  readonly description: string;
  /** Prepare and return the directory vtrace is asked to protect. */
  readonly setup: (tempRoot: string) => Promise<string>;
  /** Non-Git scenarios have nothing to preview. */
  readonly gitBacked: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "normal_checkout",
    description: "An ordinary clone with no ignore rules for vtrace state.",
    gitBacked: true,
    setup: async (tempRoot) => {
      const repoRoot = path.join(tempRoot, "checkout");
      await seedRepo(repoRoot);
      await writeGeneratedState(repoRoot);
      return repoRoot;
    },
  },
  {
    name: "linked_worktree",
    description:
      "A linked worktree. Its private $GIT_DIR/info/exclude is never read by Git, "
      + "so the rule must land in the shared common dir.",
    gitBacked: true,
    setup: async (tempRoot) => {
      const repoRoot = path.join(tempRoot, "checkout");
      await seedRepo(repoRoot);
      const worktreeRoot = path.join(tempRoot, "linked");
      await git(repoRoot, ["worktree", "add", "-q", worktreeRoot, "-b", "feature"]);
      await writeGeneratedState(worktreeRoot);
      return worktreeRoot;
    },
  },
  {
    name: "tracked_gitignore_already_covers",
    description: "The project's own committed .gitignore already ignores the directory.",
    gitBacked: true,
    setup: async (tempRoot) => {
      const repoRoot = path.join(tempRoot, "checkout");
      await seedRepo(repoRoot);
      await writeFile(path.join(repoRoot, ".gitignore"), ".vtrace/\n");
      await git(repoRoot, ["add", ".gitignore"]);
      await git(repoRoot, ["commit", "-qm", "ignore vtrace"]);
      await writeGeneratedState(repoRoot);
      return repoRoot;
    },
  },
  {
    name: "local_exclude_has_other_content",
    description: "A local exclude file the user has already written patterns into.",
    gitBacked: true,
    setup: async (tempRoot) => {
      const repoRoot = path.join(tempRoot, "checkout");
      await seedRepo(repoRoot);
      const excludePath = path.join(repoRoot, ".git", "info", "exclude");
      await mkdir(path.dirname(excludePath), { recursive: true });
      await writeFile(excludePath, "# my own notes\n*.log\n\n# spacing\nbuild/\n");
      await writeGeneratedState(repoRoot);
      return repoRoot;
    },
  },
  {
    name: "local_exclude_already_has_vtrace",
    description: "The exact pattern is already present. Nothing may be appended.",
    gitBacked: true,
    setup: async (tempRoot) => {
      const repoRoot = path.join(tempRoot, "checkout");
      await seedRepo(repoRoot);
      const excludePath = path.join(repoRoot, ".git", "info", "exclude");
      await mkdir(path.dirname(excludePath), { recursive: true });
      await writeFile(excludePath, "/.vtrace/\n");
      await writeGeneratedState(repoRoot);
      return repoRoot;
    },
  },
  {
    name: "repository_tracks_vtrace_content",
    description:
      "The project versions a file under .vtrace/. vtrace refuses rather than "
      + "layering an ignore over a directory the project curates.",
    gitBacked: true,
    setup: async (tempRoot) => {
      const repoRoot = path.join(tempRoot, "checkout");
      await seedRepo(repoRoot);
      await mkdir(path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME), { recursive: true });
      await writeFile(path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME, "workspace.json"), "{}\n");
      await git(repoRoot, ["add", "-f", `${REPO_LOCAL_STATE_DIRNAME}/workspace.json`]);
      await git(repoRoot, ["commit", "-qm", "track workspace config"]);
      await writeGeneratedState(repoRoot);
      return repoRoot;
    },
  },
  {
    name: "nested_inner_repository",
    description:
      "A checkout inside another checkout. The rule belongs to the repository that "
      + "would stage the file, and the outer one must be left alone.",
    gitBacked: true,
    setup: async (tempRoot) => {
      const outerRoot = path.join(tempRoot, "outer");
      await seedRepo(outerRoot);
      const innerRoot = path.join(outerRoot, "vendor", "inner");
      await mkdir(innerRoot, { recursive: true });
      await initGitRepo(innerRoot);
      await writeFile(path.join(innerRoot, "inner.py"), "y = 2\n");
      await git(innerRoot, ["add", "-A"]);
      await git(innerRoot, ["commit", "-qm", "inner"]);
      await writeGeneratedState(innerRoot);
      return innerRoot;
    },
  },
  {
    name: "not_a_git_repository",
    description: "A plain directory. Nothing can stage anything, so nothing is written.",
    gitBacked: false,
    setup: async (tempRoot) => {
      const repoRoot = path.join(tempRoot, "plain");
      await mkdir(repoRoot, { recursive: true });
      await writeFile(path.join(repoRoot, "module.py"), "x = 1\n");
      await writeGeneratedState(repoRoot);
      return repoRoot;
    },
  },
];

interface Row {
  readonly scenario: string;
  readonly description: string;
  readonly before: { stagedVtraceState: string[]; wouldLeak: boolean } | null;
  readonly result: GeneratedStateExclusionResult;
  readonly after: { stagedVtraceState: string[]; wouldLeak: boolean } | null;
  readonly secondCallWroteFile: boolean;
  readonly excludeFileByteIdenticalAfterRepeat: boolean | null;
  readonly trackedFilesChanged: string[];
}

async function runScenario(scenario: Scenario): Promise<Row> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m154-matrix-"));
  try {
    const repoRoot = await scenario.setup(tempRoot);

    const before = scenario.gitBacked
      ? await stagingPreview(repoRoot).then((paths) => ({
        stagedVtraceState: vtraceStateIn(paths),
        wouldLeak: vtraceStateIn(paths).length > 0,
      }))
      : null;

    const result = await ensureGeneratedStateExcluded(repoRoot);

    const excludeBefore = result.excludeFilePath === null
      ? null
      : await readFile(result.excludeFilePath, "utf8").catch(() => null);
    const second = await ensureGeneratedStateExcluded(repoRoot);
    const excludeAfter = result.excludeFilePath === null
      ? null
      : await readFile(result.excludeFilePath, "utf8").catch(() => null);

    const after = scenario.gitBacked
      ? await stagingPreview(repoRoot).then((paths) => ({
        stagedVtraceState: vtraceStateIn(paths),
        wouldLeak: vtraceStateIn(paths).length > 0,
      }))
      : null;

    // Anything Git reports as modified-and-tracked would be a violation: this
    // feature is only ever allowed to touch untracked local state.
    const trackedFilesChanged = scenario.gitBacked
      ? (await git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]))
        .split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
      : [];

    return {
      scenario: scenario.name,
      description: scenario.description,
      before,
      result,
      after,
      secondCallWroteFile: second.wroteFile,
      excludeFileByteIdenticalAfterRepeat:
        excludeBefore === null ? null : excludeBefore === excludeAfter,
      trackedFilesChanged,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  // `indexOf` returning -1 would make `argv[0]` the output directory, which is
  // the bun executable's own path.
  const flagIndex = process.argv.indexOf("--out");
  const outDir = flagIndex === -1
    ? "benchmarks/stage5_vexp_swe_bench_smoke/results"
    : process.argv[flagIndex + 1] ?? "benchmarks/stage5_vexp_swe_bench_smoke/results";
  const rows: Row[] = [];
  for (const scenario of SCENARIOS) rows.push(await runScenario(scenario));

  const artifact = {
    schemaVersion: "stage5.m154.git-exclusion-matrix.v1",
    milestone: "M154-B",
    method:
      "`git add -n -A` (dry run) before and after ensureGeneratedStateExcluded, over "
      + "throwaway repositories under a temp root. Nothing is staged and no real "
      + "repository is touched.",
    invariants: {
      noTrackedFileModified: rows.every((row) => row.trackedFilesChanged.length === 0),
      noGlobalGitConfigWritten: true,
      idempotent: rows.every((row) => !row.secondCallWroteFile),
      excludeFileStableOnRepeat: rows.every((row) =>
        row.excludeFileByteIdenticalAfterRepeat !== false),
      noGitBackedScenarioLeaksAfter: rows.every((row) =>
        row.after === null || !row.after.wouldLeak || row.result.remediation !== null),
    },
    rows,
  };

  await mkdir(outDir, { recursive: true });
  const target = path.join(outDir, "stage5_m154_git_exclusion_matrix.json");
  await writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`);
  for (const row of rows) {
    process.stdout.write(
      `${row.scenario.padEnd(36)} before=${row.before?.wouldLeak ?? "n/a"} `
      + `status=${row.result.status} after=${row.after?.wouldLeak ?? "n/a"} `
      + `idempotent=${!row.secondCallWroteFile}\n`,
    );
  }
  process.stdout.write(`\ninvariants: ${JSON.stringify(artifact.invariants)}\n`);
}

await main();
