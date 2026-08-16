import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { promisify } from "node:util";

import {
  ensureGeneratedStateExcluded,
  GeneratedStateExclusionStatus,
} from "./generatedStateExclusion";
import { REPO_LOCAL_STATE_DIRNAME } from "./types";

const execFile = promisify(execFileCallback);

test("a fresh checkout stops staging vtrace state once the exclusion is established", async () => {
  await withGitRepo(async (repoRoot) => {
    await writeGeneratedState(repoRoot);

    const before = await stagingPreview(repoRoot);
    assert.ok(
      before.includes(`${REPO_LOCAL_STATE_DIRNAME}/index.sqlite`),
      "the defect must reproduce before the fix is applied",
    );

    const result = await ensureGeneratedStateExcluded(repoRoot);

    assert.equal(result.status, GeneratedStateExclusionStatus.Established);
    assert.equal(result.pattern, "/.vtrace/");
    assert.equal(result.wroteFile, true);
    assert.equal(result.remediation, null);

    const after = await stagingPreview(repoRoot);
    assert.ok(!after.includes(REPO_LOCAL_STATE_DIRNAME), `still stageable: ${after}`);
  });
});

// The case the whole module is shaped around. `$GIT_DIR/info/exclude` inside a
// linked worktree is never read by Git, so an implementation that resolved the
// wrong directory would pass every single-checkout test and silently do nothing
// in the exact workflow that motivated M154.
test("a linked worktree is protected through the shared common dir", async () => {
  await withGitRepo(async (repoRoot, tempRoot) => {
    const worktreeRoot = path.join(tempRoot, "linked");
    await git(repoRoot, ["worktree", "add", "-q", worktreeRoot, "-b", "feature"]);
    await writeGeneratedState(worktreeRoot);

    assert.ok((await stagingPreview(worktreeRoot)).includes(REPO_LOCAL_STATE_DIRNAME));

    const result = await ensureGeneratedStateExcluded(worktreeRoot);

    assert.equal(result.status, GeneratedStateExclusionStatus.Established);
    // Written to the shared `.git/info/exclude`, never to `.git/worktrees/<n>/info`.
    assert.equal(result.excludeFilePath, path.join(repoRoot, ".git", "info", "exclude"));
    assert.ok(!(await stagingPreview(worktreeRoot)).includes(REPO_LOCAL_STATE_DIRNAME));

    await git(repoRoot, ["worktree", "remove", "--force", worktreeRoot]);
  });
});

test("repeated indexing never appends a second copy", async () => {
  await withGitRepo(async (repoRoot) => {
    await writeGeneratedState(repoRoot);

    const first = await ensureGeneratedStateExcluded(repoRoot);
    const afterFirst = await readFile(first.excludeFilePath!, "utf8");

    const second = await ensureGeneratedStateExcluded(repoRoot);
    const afterSecond = await readFile(first.excludeFilePath!, "utf8");

    assert.equal(second.wroteFile, false);
    assert.equal(second.status, GeneratedStateExclusionStatus.AlreadyIgnored);
    // Byte-wise idempotence: a hundred index runs leave one line.
    assert.equal(afterSecond, afterFirst);
    assert.equal(afterSecond.split("/.vtrace/").length - 1, 1);
  });
});

test("existing exclude content is preserved exactly", async () => {
  await withGitRepo(async (repoRoot) => {
    const excludePath = path.join(repoRoot, ".git", "info", "exclude");
    const original = "# my own notes\n*.log\n\n# keep this spacing\nbuild/\n";
    await mkdir(path.dirname(excludePath), { recursive: true });
    await writeFile(excludePath, original);
    await writeGeneratedState(repoRoot);

    await ensureGeneratedStateExcluded(repoRoot);

    const updated = await readFile(excludePath, "utf8");
    assert.ok(updated.startsWith(original), "user content must survive byte-for-byte");
    assert.ok(updated.includes("/.vtrace/"));
    // The user's own patterns still work.
    await writeFile(path.join(repoRoot, "noisy.log"), "x");
    assert.ok(!(await stagingPreview(repoRoot)).includes("noisy.log"));
  });
});

test("an exclude file that already names the directory is left alone", async () => {
  await withGitRepo(async (repoRoot) => {
    const excludePath = path.join(repoRoot, ".git", "info", "exclude");
    await mkdir(path.dirname(excludePath), { recursive: true });
    await writeFile(excludePath, "/.vtrace/\n");
    await writeGeneratedState(repoRoot);

    const result = await ensureGeneratedStateExcluded(repoRoot);

    assert.equal(result.status, GeneratedStateExclusionStatus.AlreadyIgnored);
    assert.equal(result.wroteFile, false);
    assert.equal(await readFile(excludePath, "utf8"), "/.vtrace/\n");
  });
});

test("a project that already ignores the directory keeps its own rule", async () => {
  await withGitRepo(async (repoRoot) => {
    await writeFile(path.join(repoRoot, ".gitignore"), ".vtrace/\n");
    await git(repoRoot, ["add", ".gitignore"]);
    await git(repoRoot, ["commit", "-qm", "ignore vtrace"]);
    await writeGeneratedState(repoRoot);

    const result = await ensureGeneratedStateExcluded(repoRoot);

    assert.equal(result.status, GeneratedStateExclusionStatus.AlreadyIgnored);
    assert.equal(result.wroteFile, false);
    assert.ok(result.ignoredBy?.includes(".gitignore"));
    // The tracked file is reported as the source and is never rewritten.
    assert.equal(await readFile(path.join(repoRoot, ".gitignore"), "utf8"), ".vtrace/\n");
  });
});

test("the tracked .gitignore is never modified when vtrace establishes the exclusion", async () => {
  await withGitRepo(async (repoRoot) => {
    await writeFile(path.join(repoRoot, ".gitignore"), "*.pyc\n");
    await git(repoRoot, ["add", ".gitignore"]);
    await git(repoRoot, ["commit", "-qm", "ignore pyc"]);
    await writeGeneratedState(repoRoot);

    await ensureGeneratedStateExcluded(repoRoot);

    assert.equal(await readFile(path.join(repoRoot, ".gitignore"), "utf8"), "*.pyc\n");
    // No tracked file changed at all.
    const status = await git(repoRoot, ["status", "--porcelain"]);
    assert.ok(!status.includes(".gitignore"), status);
  });
});

// §24: a repository that versions something under `.vtrace/` gets a truthful
// refusal, not a quiet ignore layered over a curated directory.
test("a repository that tracks .vtrace content is refused with remediation", async () => {
  await withGitRepo(async (repoRoot) => {
    await mkdir(path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME), { recursive: true });
    await writeFile(path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME, "workspace.json"), "{}\n");
    await git(repoRoot, ["add", "-f", `${REPO_LOCAL_STATE_DIRNAME}/workspace.json`]);
    await git(repoRoot, ["commit", "-qm", "track workspace config"]);

    const result = await ensureGeneratedStateExcluded(repoRoot);

    assert.equal(result.status, GeneratedStateExclusionStatus.TrackedPathsPresent);
    assert.equal(result.wroteFile, false);
    assert.deepEqual([...result.trackedPaths], [`${REPO_LOCAL_STATE_DIRNAME}/workspace.json`]);
    // The refusal must state that state is still stageable, or it is not a
    // refusal a caller can act on.
    assert.ok(result.remediation !== null);
    assert.ok(result.remediation!.includes("git add -A"));
  });
});

test("a directory with no Git metadata reports the truth and blocks nothing", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-exclusion-"));
  try {
    await writeFile(path.join(tempRoot, "module.py"), "x = 1\n");

    const result = await ensureGeneratedStateExcluded(tempRoot);

    assert.equal(result.status, GeneratedStateExclusionStatus.NotAGitRepository);
    assert.equal(result.excludeFilePath, null);
    // Nothing could stage it, so nothing needs remediating.
    assert.equal(result.remediation, null);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// §71: the exclusion belongs to the repository that would do the staging. An
// inner checkout must not have its state hidden by the outer repository's rule.
test("a nested checkout is excluded in its own repository, not its parent's", async () => {
  await withGitRepo(async (outerRoot) => {
    const innerRoot = path.join(outerRoot, "vendor", "inner");
    await mkdir(innerRoot, { recursive: true });
    await initGitRepo(innerRoot);
    await writeFile(path.join(innerRoot, "inner.py"), "y = 2\n");
    await git(innerRoot, ["add", "-A"]);
    await git(innerRoot, ["commit", "-qm", "inner"]);
    await writeGeneratedState(innerRoot);

    const result = await ensureGeneratedStateExcluded(innerRoot);

    assert.equal(result.status, GeneratedStateExclusionStatus.Established);
    assert.equal(result.excludeFilePath, path.join(innerRoot, ".git", "info", "exclude"));

    const outerExclude = path.join(outerRoot, ".git", "info", "exclude");
    const outerContent = await readFile(outerExclude, "utf8").catch(() => "");
    assert.ok(!outerContent.includes(".vtrace"), "the parent's exclude must be untouched");
  });
});

async function writeGeneratedState(repoRoot: string): Promise<void> {
  const stateDir = path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME);
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "index.sqlite"), "index-bytes");
  await writeFile(path.join(stateDir, "session.sqlite"), "session-bytes");
}

/** `git add -n -A`: what an ordinary staging sweep would pick up. Never stages. */
async function stagingPreview(repoRoot: string): Promise<string> {
  return git(repoRoot, ["add", "-n", "-A"]);
}

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

async function withGitRepo(
  run: (repoRoot: string, tempRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-exclusion-"));
  const repoRoot = path.join(tempRoot, "checkout");
  try {
    await mkdir(repoRoot, { recursive: true });
    await initGitRepo(repoRoot);
    await writeFile(path.join(repoRoot, "module.py"), "x = 1\n");
    await git(repoRoot, ["add", "-A"]);
    await git(repoRoot, ["commit", "-qm", "initial"]);
    await run(repoRoot, tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
