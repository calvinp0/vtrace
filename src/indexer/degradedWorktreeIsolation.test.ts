/**
 * M156 §73/§74: a degraded repository stays isolated.
 *
 * Containment is only worth having if it does not leak. Two ways it could:
 *
 *   - a linked worktree with a malformed file could break the worktree routing
 *     and index identity M132/M145 established, or have its failure attributed
 *     to the parent checkout;
 *   - one degraded repository in a workspace could drag healthy siblings down
 *     with it, which would simply relocate the M155 availability failure rather
 *     than fix it.
 *
 * Both are tested against real Git worktrees rather than simulated ones,
 * because the identity these assertions rest on is derived from Git.
 */

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "bun:test";

import { listFileIndexFailures } from "../db/repositories/fileIndexFailuresRepository";
import { listAllFilePaths } from "../db/repositories/filesRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "./indexProject";

const execFile = promisify(execFileCallback);
const BROKEN_PYTHON = "def broken(:\n    return 1\n";

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, encoding: "utf8" });
}

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "vtrace-m156-worktree-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function makeRepo(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(root, "init", "--initial-branch", "main");
  await git(root, "config", "user.email", "m156@example.com");
  await git(root, "config", "user.name", "M156");
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.join(root, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "seed");
}

test("M156: a linked worktree with a malformed file indexes as its own degraded repository", async () => {
  const root = path.join(scratch, "main");
  await makeRepo(root, {
    "src/solver.py": "def solve():\n    return 1\n",
  });

  // A sibling linked worktree — the M132 routing case — carrying a bad file the
  // parent checkout does not have.
  const linked = path.join(scratch, "linked");
  await git(root, "worktree", "add", "-b", "feature", linked);
  await writeFile(path.join(linked, "src", "fixture_bad.py"), BROKEN_PYTHON);

  const parentDb = openIndexerDatabase();
  const linkedDb = openIndexerDatabase();
  try {
    const parent = await indexProject({ repoRoot: root, db: parentDb });
    const worktree = await indexProject({ repoRoot: linked, db: linkedDb });

    // The worktree is degraded and usable; the parent is untouched and complete.
    assert.equal(worktree.coverage.complete, false);
    assert.equal(worktree.coverage.filesFailed, 1);
    assert.equal(
      listFileIndexFailures(linkedDb).map((failure) => failure.path).join(),
      "src/fixture_bad.py",
    );
    assert.equal(listAllFilePaths(linkedDb).includes("src/solver.py"), true);

    // §73: the failure belongs to the worktree that has the file, and does not
    // migrate to the checkout that does not.
    assert.equal(parent.coverage.complete, true);
    assert.equal(parent.coverage.filesFailed, 0);
    assert.equal(listFileIndexFailures(parentDb).length, 0);
  } finally {
    parentDb.close();
    linkedDb.close();
  }
});

test("M156: a degraded repository does not make a healthy sibling unavailable", async () => {
  // §74. Two independent repositories, indexed independently, as a workspace
  // holds them. The healthy one must be complete and fully queryable.
  const degraded = path.join(scratch, "degraded");
  const healthy = path.join(scratch, "healthy");
  await makeRepo(degraded, {
    "src/solver.py": "def solve():\n    return 1\n",
    "tests/fixture_bad.py": BROKEN_PYTHON,
  });
  await makeRepo(healthy, {
    "src/engine.py": "def run_engine():\n    return 2\n",
  });

  const degradedDb = openIndexerDatabase();
  const healthyDb = openIndexerDatabase();
  try {
    const degradedResult = await indexProject({ repoRoot: degraded, db: degradedDb });
    const healthyResult = await indexProject({ repoRoot: healthy, db: healthyDb });

    assert.equal(degradedResult.coverage.complete, false);
    assert.equal(degradedResult.coverage.filesFailed, 1);
    // The degraded repository is still serving its own good files.
    assert.equal(listAllFilePaths(degradedDb).includes("src/solver.py"), true);

    // The sibling is complete, and carries no trace of the neighbour's problem.
    assert.equal(healthyResult.coverage.complete, true);
    assert.equal(healthyResult.coverage.filesFailed, 0);
    assert.equal(listFileIndexFailures(healthyDb).length, 0);
    assert.equal(listAllFilePaths(healthyDb).includes("src/engine.py"), true);
  } finally {
    degradedDb.close();
    healthyDb.close();
  }
});
