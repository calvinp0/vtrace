import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "bun:test";

import { initRepo } from "../setup/initRepo";
import { resolveRepoLocalPaths } from "../setup/repoState";
import { reindexRepoAndRefreshState } from "../runtime/reindexRepo";
import {
  INDEX_FORMAT_VERSION,
  inspectWorktreeIndexFreshness,
  readIndexMeta,
  resolveIndexMetaPath,
} from "./indexMeta";
import { withWorktreeIndexLock, WorktreeIndexLockError } from "./worktreeIndexLock";
import { resolveWorktreeIdentity } from "./worktreeIdentity";

const execFile = promisify(execFileCallback);

test("worktree identity is stable, canonical, and distinct across linked worktrees", async () => {
  await withGitWorktrees(async ({ mainRoot, featureRoot }) => {
    const main = await resolveWorktreeIdentity(mainRoot);
    const repeated = await resolveWorktreeIdentity(mainRoot);
    const feature = await resolveWorktreeIdentity(featureRoot);
    const alias = path.join(path.dirname(mainRoot), "main-alias");
    await symlink(mainRoot, alias);
    const throughAlias = await resolveWorktreeIdentity(alias);

    assert.equal(main.repository.repositoryId, feature.repository.repositoryId);
    assert.equal(main.repository.gitCommonDir, feature.repository.gitCommonDir);
    assert.notEqual(main.worktree.worktreeId, feature.worktree.worktreeId);
    assert.notEqual(main.worktree.worktreeGitDir, feature.worktree.worktreeGitDir);
    assert.deepEqual(repeated, main);
    assert.equal(throughAlias.worktree.worktreeId, main.worktree.worktreeId);
    assert.equal(throughAlias.worktree.worktreeRoot, main.worktree.worktreeRoot);
  });
});

test("detached HEAD and non-Git directories are represented honestly", async () => {
  await withGitWorktrees(async ({ featureRoot }) => {
    await git(featureRoot, "checkout", "--detach");
    const detached = await resolveWorktreeIdentity(featureRoot);
    assert.equal(detached.snapshot.detached, true);
    assert.equal(detached.snapshot.branch, null);
    assert.match(detached.snapshot.headCommit ?? "", /^[0-9a-f]{40}$/);
  });

  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-non-git-"));
  try {
    const identity = await resolveWorktreeIdentity(root);
    assert.equal(identity.repository.isGitRepository, false);
    assert.equal(identity.worktree.isGitWorktree, false);
    assert.equal(identity.repository.gitCommonDir, null);
    assert.equal(identity.worktree.worktreeGitDir, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("freshness distinguishes HEAD, tracked, staged, deleted, untracked, ignored, schema, config, and invalid manifest changes", async () => {
  await withGitWorktrees(async ({ mainRoot }) => {
    await initRepo({ repoPath: mainRoot });
    assert.equal((await inspectWorktreeIndexFreshness(mainRoot)).reason, "fresh");

    await writeFile(path.join(mainRoot, "src", "app.ts"), "export const value = 2;\n");
    assert.equal((await inspectWorktreeIndexFreshness(mainRoot)).reason, "working_tree_changed");
    await git(mainRoot, "add", "src/app.ts");
    assert.equal((await inspectWorktreeIndexFreshness(mainRoot)).reason, "working_tree_changed");
    await git(mainRoot, "reset", "--hard", "HEAD");

    await rm(path.join(mainRoot, "src", "app.ts"));
    assert.equal((await inspectWorktreeIndexFreshness(mainRoot)).reason, "working_tree_changed");
    await git(mainRoot, "reset", "--hard", "HEAD");

    await writeFile(path.join(mainRoot, "src", "new.ts"), "export const added = true;\n");
    assert.equal((await inspectWorktreeIndexFreshness(mainRoot)).reason, "working_tree_changed");
    await rm(path.join(mainRoot, "src", "new.ts"));

    await writeFile(path.join(mainRoot, "ignored.ts"), "export const ignored = true;\n");
    await writeFile(path.join(mainRoot, ".gitignore"), "ignored.ts\n.vtrace/\n");
    await git(mainRoot, "add", ".gitignore");
    await git(mainRoot, "commit", "-m", "ignore generated file");
    assert.equal((await inspectWorktreeIndexFreshness(mainRoot)).reason, "head_mismatch");
    await refresh(mainRoot);
    assert.equal((await inspectWorktreeIndexFreshness(mainRoot)).reason, "fresh");

    const metaPath = resolveIndexMetaPath(mainRoot);
    const original = JSON.parse(await readFile(metaPath, "utf8"));
    await writeFile(metaPath, `${JSON.stringify({ ...original, config_hash: "different" }, null, 2)}\n`);
    assert.equal((await inspectWorktreeIndexFreshness(mainRoot)).reason, "configuration_changed");
    await writeFile(metaPath, `${JSON.stringify({ ...original, index_format_version: INDEX_FORMAT_VERSION + 1 }, null, 2)}\n`);
    assert.equal((await inspectWorktreeIndexFreshness(mainRoot)).reason, "index_schema_changed");
    await writeFile(metaPath, `${JSON.stringify({ ...original, manifest: null }, null, 2)}\n`);
    assert.equal((await inspectWorktreeIndexFreshness(mainRoot)).reason, "manifest_invalid");
    await refresh(mainRoot);
    assert.equal((await inspectWorktreeIndexFreshness(mainRoot)).reason, "fresh");
  });
});

test("linked worktrees retain isolated indexes and stale independently", async () => {
  await withGitWorktrees(async ({ mainRoot, featureRoot }) => {
    await initRepo({ repoPath: mainRoot });
    const mainManifestBefore = await readFile(resolveIndexMetaPath(mainRoot), "utf8");
    assert.equal((await inspectWorktreeIndexFreshness(featureRoot)).reason, "missing_index");

    await initRepo({ repoPath: featureRoot });
    assert.equal((await inspectWorktreeIndexFreshness(mainRoot)).reason, "fresh");
    assert.equal((await inspectWorktreeIndexFreshness(featureRoot)).reason, "fresh");
    const mainMeta = await readIndexMeta(mainRoot);
    const featureMeta = await readIndexMeta(featureRoot);
    assert.notEqual(mainMeta?.manifest.worktree.worktreeId, featureMeta?.manifest.worktree.worktreeId);

    const featureMetaPath = resolveIndexMetaPath(featureRoot);
    await writeFile(featureMetaPath, `${JSON.stringify(mainMeta, null, 2)}\n`);
    assert.equal((await inspectWorktreeIndexFreshness(featureRoot)).reason, "worktree_mismatch");
    await writeFile(featureMetaPath, `${JSON.stringify({
      ...featureMeta,
      manifest: {
        ...featureMeta!.manifest,
        repository: { ...featureMeta!.manifest.repository, repositoryId: "different-repository" },
      },
    }, null, 2)}\n`);
    assert.equal((await inspectWorktreeIndexFreshness(featureRoot)).reason, "repository_mismatch");
    await writeFile(featureMetaPath, `${JSON.stringify(featureMeta, null, 2)}\n`);

    await writeFile(path.join(mainRoot, "src", "main-only.ts"), "export const mainOnly = true;\n");
    await git(mainRoot, "add", "src/main-only.ts");
    await git(mainRoot, "commit", "-m", "advance main");
    assert.equal((await inspectWorktreeIndexFreshness(mainRoot)).reason, "head_mismatch");
    assert.equal((await inspectWorktreeIndexFreshness(featureRoot)).reason, "fresh");

    await writeFile(path.join(featureRoot, "src", "app.ts"), "export const value = 9;\n");
    assert.equal((await inspectWorktreeIndexFreshness(featureRoot)).reason, "working_tree_changed");
    await refresh(featureRoot);
    assert.equal((await inspectWorktreeIndexFreshness(featureRoot)).reason, "fresh");
    assert.equal(await readFile(resolveIndexMetaPath(mainRoot), "utf8"), mainManifestBefore);
    assert.equal((await inspectWorktreeIndexFreshness(mainRoot)).reason, "head_mismatch");
  });
});

test("worktree locks serialize one worktree but allow different worktrees", async () => {
  await withGitWorktrees(async ({ mainRoot, featureRoot }) => {
    let releaseMain!: () => void;
    const mainHeld = new Promise<void>((resolve) => { releaseMain = resolve; });
    let mainAcquired!: () => void;
    const mainReady = new Promise<void>((resolve) => { mainAcquired = resolve; });
    const first = withWorktreeIndexLock({
      repoRoot: mainRoot,
      operation: async () => { mainAcquired(); await mainHeld; return "main"; },
    });
    await mainReady;
    await assert.rejects(
      withWorktreeIndexLock({ repoRoot: mainRoot, operation: async () => "second" }),
      (error: unknown) => error instanceof WorktreeIndexLockError && error.code === "index_in_progress",
    );

    const feature = await withWorktreeIndexLock({
      repoRoot: featureRoot,
      operation: async () => "feature",
    });
    assert.equal(feature.value, "feature");
    releaseMain();
    assert.equal((await first).value, "main");
  });
});

test("a lock left by a dead process is recovered explicitly", async () => {
  await withGitWorktrees(async ({ mainRoot }) => {
    const lockRoot = path.join(mainRoot, ".vtrace", "index.lock");
    await mkdir(lockRoot, { recursive: true });
    await writeFile(path.join(lockRoot, "owner.json"), JSON.stringify({
      pid: 99_999_999,
      startedAt: "2000-01-01T00:00:00.000Z",
      worktreeId: "stale",
    }));
    const recovered = await withWorktreeIndexLock({
      repoRoot: mainRoot,
      operation: async () => true,
    });
    assert.equal(recovered.value, true);
    assert.equal(recovered.staleLockRecovered, true);
  });
});

async function refresh(repoRoot: string): Promise<void> {
  const paths = resolveRepoLocalPaths(repoRoot);
  await reindexRepoAndRefreshState({
    repoRoot,
    dbPath: paths.dbPath,
    statePath: paths.statePath,
    configPresent: true,
    statePresent: true,
    usesDbPathOverride: false,
  });
}

async function withGitWorktrees(run: (roots: { mainRoot: string; featureRoot: string }) => Promise<void>): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-worktrees-"));
  const mainRoot = path.join(tempRoot, "main");
  const featureRoot = path.join(tempRoot, "feature");
  try {
    await mkdir(path.join(mainRoot, "src"), { recursive: true });
    await git(mainRoot, "init", "-b", "main");
    await git(mainRoot, "config", "user.email", "vtrace@example.test");
    await git(mainRoot, "config", "user.name", "Vtrace Test");
    await writeFile(path.join(mainRoot, ".gitignore"), ".vtrace/\n");
    await writeFile(path.join(mainRoot, "src", "app.ts"), "export const value = 1;\n");
    await git(mainRoot, "add", ".gitignore", "src/app.ts");
    await git(mainRoot, "commit", "-m", "initial");
    await git(mainRoot, "worktree", "add", "-b", "feature", featureRoot);
    await run({ mainRoot, featureRoot });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, encoding: "utf8" });
}
