import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { REPO_LOCAL_STATE_DIRNAME } from "../setup/types";
import {
  addSiblingWorktree,
  cleanupWorkspaceFixtures,
  makeFixtureRepo,
  makeWorkspaceRoot,
} from "../workspace/workspaceFixture";
import { resolveWorktreeIdentity } from "./worktreeIdentity";
import { withWorktreeIndexLock, WorktreeIndexLockError } from "./worktreeIndexLock";

afterAll(cleanupWorkspaceFixtures);

function lockDir(repoRoot: string): string {
  return path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME, "index.lock");
}

/** Plant a lock without holding it, so the recovery rules can be exercised. */
async function plantLock(
  repoRoot: string,
  owner: { pid: number; worktreeId: string },
): Promise<void> {
  const dir = lockDir(repoRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "owner.json"),
    `${JSON.stringify({ ...owner, startedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

/** A pid that is certain not to be running. */
const DEAD_PID = 2 ** 22;

describe("M145 index lock ownership (§62-§70, §129)", () => {
  test("a busy index returns a bounded refusal naming the owner", async () => {
    const root = await makeWorkspaceRoot("m145-lock-");
    const repo = await makeFixtureRepo(path.join(root, "repo"));
    const identity = await resolveWorktreeIdentity(repo);

    // A live claim, owned by this very process.
    await plantLock(repo, { pid: process.pid, worktreeId: identity.worktree.worktreeId });

    const started = Date.now();
    const error = await withWorktreeIndexLock({ repoRoot: repo, operation: async () => true })
      .then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorktreeIndexLockError);
    expect((error as WorktreeIndexLockError).code).toBe("index_in_progress");
    expect((error as WorktreeIndexLockError).owner.pid).toBe(process.pid);
    // Bounded: it refuses rather than waiting for the other writer to finish.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a lock left by a dead process is recovered and the recovery is attributed", async () => {
    const root = await makeWorkspaceRoot("m145-lock-");
    const repo = await makeFixtureRepo(path.join(root, "repo"));
    const identity = await resolveWorktreeIdentity(repo);
    await plantLock(repo, { pid: DEAD_PID, worktreeId: identity.worktree.worktreeId });

    const result = await withWorktreeIndexLock({ repoRoot: repo, operation: async () => "done" });

    expect(result.value).toBe("done");
    expect(result.staleLockRecovered).toBe(true);
    expect(result.staleLockKind).toBe("dead_owner");
  });

  test("a lock naming another worktree never owned this index", async () => {
    const root = await makeWorkspaceRoot("m145-lock-");
    const repo = await makeFixtureRepo(path.join(root, "repo"));
    const other = await makeFixtureRepo(path.join(root, "other"));
    const otherIdentity = await resolveWorktreeIdentity(other);

    // A `.vtrace` copied from another checkout, whose owning process is alive.
    await plantLock(repo, { pid: process.pid, worktreeId: otherIdentity.worktree.worktreeId });

    const result = await withWorktreeIndexLock({ repoRoot: repo, operation: async () => "done" });

    expect(result.staleLockRecovered).toBe(true);
    expect(result.staleLockKind).toBe("foreign_worktree");
  });

  test("an unreadable owner record does not wedge the index", async () => {
    const root = await makeWorkspaceRoot("m145-lock-");
    const repo = await makeFixtureRepo(path.join(root, "repo"));
    await mkdir(lockDir(repo), { recursive: true });
    await writeFile(path.join(lockDir(repo), "owner.json"), "{ truncated");

    const result = await withWorktreeIndexLock({ repoRoot: repo, operation: async () => "done" });

    expect(result.staleLockKind).toBe("unreadable_owner");
  });

  test("locking one repository leaves another free", async () => {
    const root = await makeWorkspaceRoot("m145-lock-");
    const repoA = await makeFixtureRepo(path.join(root, "a"));
    const repoB = await makeFixtureRepo(path.join(root, "b"));
    const identityA = await resolveWorktreeIdentity(repoA);
    await plantLock(repoA, { pid: process.pid, worktreeId: identityA.worktree.worktreeId });

    await expect(withWorktreeIndexLock({ repoRoot: repoA, operation: async () => 1 }))
      .rejects.toBeInstanceOf(WorktreeIndexLockError);
    // B is a different authoritative write target and is unaffected.
    expect((await withWorktreeIndexLock({ repoRoot: repoB, operation: async () => 2 })).value).toBe(2);
  });

  test("sibling worktrees hold separate locks", async () => {
    const root = await makeWorkspaceRoot("m145-lock-");
    const main = await makeFixtureRepo(path.join(root, "repo"));
    const sibling = await addSiblingWorktree(main, path.join(root, "repo-feature"));
    const mainIdentity = await resolveWorktreeIdentity(main);
    await plantLock(main, { pid: process.pid, worktreeId: mainIdentity.worktree.worktreeId });

    // Same repository, same objects, DIFFERENT index — so B is not busy.
    const result = await withWorktreeIndexLock({ repoRoot: sibling, operation: async () => "sibling" });

    expect(result.value).toBe("sibling");
    expect(result.staleLockRecovered).toBe(false);
    // The main worktree's claim is untouched by the sibling's run.
    expect(JSON.parse(await readFile(path.join(lockDir(main), "owner.json"), "utf8")).worktreeId)
      .toBe(mainIdentity.worktree.worktreeId);
  });

  test("the lock is released even when the operation throws", async () => {
    const root = await makeWorkspaceRoot("m145-lock-");
    const repo = await makeFixtureRepo(path.join(root, "repo"));

    await expect(withWorktreeIndexLock({
      repoRoot: repo,
      operation: async () => { throw new Error("index failed"); },
    })).rejects.toThrow("index failed");

    await expect(rm(lockDir(repo))).rejects.toThrow();
    expect((await withWorktreeIndexLock({ repoRoot: repo, operation: async () => "after" })).value)
      .toBe("after");
  });
});
