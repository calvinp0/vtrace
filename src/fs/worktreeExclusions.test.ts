import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, test } from "bun:test";

import { captureRepoSourceSnapshot, scanRepo } from "./scanRepo";
import {
  computeWorktreeTopologyFingerprint,
  isPathInsideExcludedWorktree,
  parseWorktreePorcelain,
  relativeDescendantPath,
  resolveWorktreeExclusions,
  summarizeWorktreeExclusions,
} from "./worktreeExclusions";

const execFile = promisify(execFileCallback);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8" });
  return stdout;
}

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "vtrace-m132-wt-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A parent repository with `src/` and `tests/`, one commit, no worktrees yet. */
async function createParentRepo(name = "parent"): Promise<string> {
  const root = path.join(scratch, name);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(path.join(root, "src", "app.py"), "def parent_entry():\n    return 'parent'\n");
  await writeFile(path.join(root, "src", "util.py"), "def parent_util():\n    return 1\n");
  await writeFile(path.join(root, "tests", "test_app.py"), "def test_parent():\n    assert True\n");
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.email", "m132@example.com");
  await git(root, "config", "user.name", "M132");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  return root;
}

/** Add a linked worktree at `relativePath` beneath `root` on a new branch. */
async function addNestedWorktree(
  root: string,
  relativePath: string,
  branch: string,
): Promise<string> {
  const target = path.join(root, relativePath);
  await git(root, "worktree", "add", "-b", branch, target);
  return target;
}

describe("M132 nested linked worktree exclusion", () => {
  test("a directly nested worktree is discovered and excluded from the parent scan", async () => {
    const root = await createParentRepo();
    const before = await scanRepo(root);
    await addNestedWorktree(root, "nested-worktree", "feature");

    const exclusions = await resolveWorktreeExclusions(root);
    assert.equal(exclusions.gitAvailable, true);
    assert.deepEqual([...exclusions.excludedRelativeDirs], ["nested-worktree"]);

    const summary = summarizeWorktreeExclusions(exclusions);
    assert.equal(summary.nestedWorktreesDiscovered, 1);
    assert.equal(summary.nestedWorktreesExcluded, 1);
    assert.deepEqual(summary.excludedRelativePaths, ["nested-worktree"]);

    const after = await scanRepo(root);
    assert.deepEqual(after.map((file) => file.path), before.map((file) => file.path));
    assert.equal(after.some((file) => file.path.startsWith("nested-worktree/")), false);
    // The parent's own sources are untouched by the exclusion.
    assert.equal(after.some((file) => file.path === "src/app.py"), true);
    assert.equal(after.some((file) => file.path === "tests/test_app.py"), true);
  });

  test("the requested root is never excluded from its own scan", async () => {
    const root = await createParentRepo();
    const nested = await addNestedWorktree(root, "nested-worktree", "feature");
    await writeFile(path.join(nested, "src", "app.py"), "def nested_entry():\n    return 'nested'\n");

    const exclusions = await resolveWorktreeExclusions(nested);
    assert.equal(exclusions.excludedRelativeDirs.size, 0);
    assert.equal(exclusions.registered.some((entry) => entry.isRequestedRoot), true);

    const files = await scanRepo(nested);
    assert.equal(files.some((file) => file.path === "src/app.py"), true);
    // The nested worktree does not inherit parent content outside its own root.
    assert.equal(files.every((file) => !file.path.startsWith("..")), true);
  });

  test("a deeply nested worktree is excluded without a name heuristic", async () => {
    const root = await createParentRepo();
    await mkdir(path.join(root, ".claude", "worktrees"), { recursive: true });
    await addNestedWorktree(root, path.join(".claude", "worktrees", "agent-abc"), "agent-abc");
    await addNestedWorktree(root, path.join("tmp", "worktree-bar"), "bar");
    await addNestedWorktree(root, path.join("arbitrary", "nested", "path"), "deep");

    const exclusions = await resolveWorktreeExclusions(root);
    assert.deepEqual([...exclusions.excludedRelativeDirs].sort(), [
      ".claude/worktrees/agent-abc",
      "arbitrary/nested/path",
      "tmp/worktree-bar",
    ]);

    const files = await scanRepo(root);
    for (const excluded of exclusions.excludedRelativeDirs) {
      assert.equal(files.some((file) => file.path.startsWith(`${excluded}/`)), false);
    }
  });

  test("correctness is invariant to the number of nested worktrees (0, 1, 5)", async () => {
    const root = await createParentRepo();
    const baseline = (await scanRepo(root)).map((file) => `${file.path}:${file.contentHash}`);
    const baselineSnapshot = await captureRepoSourceSnapshot(root);

    for (let count = 1; count <= 5; count += 1) {
      await addNestedWorktree(root, `wt-${count}`, `branch-${count}`);
      const files = (await scanRepo(root)).map((file) => `${file.path}:${file.contentHash}`);
      assert.deepEqual(files, baseline, `scan changed after adding worktree ${count}`);
      const snapshot = await captureRepoSourceSnapshot(root);
      assert.equal(snapshot.fileCount, baselineSnapshot.fileCount);
      assert.equal(snapshot.fingerprint, baselineSnapshot.fingerprint);
    }

    const exclusions = await resolveWorktreeExclusions(root);
    assert.equal(summarizeWorktreeExclusions(exclusions).nestedWorktreesExcluded, 5);
  });

  test("a large duplicate worktree does not enlarge the parent file set", async () => {
    const root = await createParentRepo();
    const before = await scanRepo(root);
    const nested = await addNestedWorktree(root, "big", "big");
    await mkdir(path.join(nested, "generated"), { recursive: true });
    for (let index = 0; index < 200; index += 1) {
      await writeFile(
        path.join(nested, "generated", `mod_${index}.py`),
        `def generated_${index}():\n    return ${index}\n`,
      );
    }

    const after = await scanRepo(root);
    assert.equal(after.length, before.length);
  });

  test("a sibling directory sharing a name prefix is not treated as nested", async () => {
    // `/scratch/parent.worktrees/x` string-prefixes `/scratch/parent` but is not
    // a descendant. Matching must be path-segment aware.
    assert.equal(relativeDescendantPath("/code/ARC", "/code/ARC.worktrees/x"), null);
    assert.equal(relativeDescendantPath("/code/ARC", "/code/ARC/feature"), "feature");
    assert.equal(relativeDescendantPath("/code/ARC", "/code/ARC"), null);
    assert.equal(relativeDescendantPath("/code/ARC", "/code"), null);
    assert.equal(relativeDescendantPath("/code/ARC", "/other/ARC/feature"), null);
  });

  test("a sibling worktree outside the root stays out of the exclusion set", async () => {
    const root = await createParentRepo("parent");
    const sibling = path.join(scratch, "parent.worktrees", "outside");
    await mkdir(path.dirname(sibling), { recursive: true });
    await git(root, "worktree", "add", "-b", "outside", sibling);

    const exclusions = await resolveWorktreeExclusions(root);
    assert.equal(exclusions.excludedRelativeDirs.size, 0);
    assert.equal(exclusions.registered.some((entry) => entry.root.endsWith("outside")), true);
    assert.equal(exclusions.registered.every((entry) => !entry.isNested), true);
  });

  test("a submodule keeps current behaviour: it is never a registered worktree", async () => {
    const child = await createParentRepo("child-lib");
    const root = await createParentRepo("super");
    await git(root, "-c", "protocol.file.allow=always", "submodule", "add", child, "vendored");
    await git(root, "-c", "protocol.file.allow=always", "commit", "-m", "add submodule");

    const exclusions = await resolveWorktreeExclusions(root);
    assert.equal(exclusions.excludedRelativeDirs.size, 0, "submodules must not be excluded by this rule");

    const files = await scanRepo(root);
    // Submodule content remains enumerated exactly as it was before M132.
    assert.equal(files.some((file) => file.path.startsWith("vendored/")), true);
  });

  test("an unregistered nested Git repository keeps current behaviour", async () => {
    const root = await createParentRepo();
    const inner = path.join(root, "third_party", "clone");
    await mkdir(path.join(inner, "src"), { recursive: true });
    await writeFile(path.join(inner, "src", "vendor.py"), "def vendored():\n    return 2\n");
    await git(inner, "init", "--initial-branch=main");

    const exclusions = await resolveWorktreeExclusions(root);
    assert.equal(exclusions.excludedRelativeDirs.size, 0);

    const files = await scanRepo(root);
    assert.equal(files.some((file) => file.path === "third_party/clone/src/vendor.py"), true);
  });

  test("a non-Git directory degrades to an empty exclusion set", async () => {
    const root = path.join(scratch, "plain");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.py"), "def a():\n    return 1\n");

    const exclusions = await resolveWorktreeExclusions(root);
    assert.equal(exclusions.gitAvailable, false);
    assert.equal(exclusions.excludedRelativeDirs.size, 0);
    assert.equal((await scanRepo(root)).length, 1);
  });

  test("removing a nested worktree restores it to the parent scan only if it stays on disk", async () => {
    const root = await createParentRepo();
    const nested = await addNestedWorktree(root, "temp-wt", "temp");
    assert.equal((await resolveWorktreeExclusions(root)).excludedRelativeDirs.size, 1);

    await git(root, "worktree", "remove", "--force", nested);
    const after = await resolveWorktreeExclusions(root);
    assert.equal(after.excludedRelativeDirs.size, 0);
    // `git worktree remove` deletes the directory, so nothing re-enters the scan.
    assert.equal((await scanRepo(root)).some((file) => file.path.startsWith("temp-wt/")), false);
  });

  test("topology fingerprint is path-relative and order-independent", async () => {
    const root = await createParentRepo();
    await addNestedWorktree(root, "b-wt", "b");
    await addNestedWorktree(root, "a-wt", "a");
    const fingerprint = computeWorktreeTopologyFingerprint(await resolveWorktreeExclusions(root));
    assert.equal(fingerprint, "a-wt\nb-wt");
    assert.equal(fingerprint.includes(scratch), false, "fingerprint must not embed absolute paths");
  });

  test("path membership covers files inside an excluded worktree", async () => {
    const exclusions = {
      root: "/repo",
      excludedRelativeDirs: new Set(["feature_docker_ux", ".claude/worktrees/a"]),
      registered: [],
      gitAvailable: true,
    };
    assert.equal(isPathInsideExcludedWorktree(exclusions, "feature_docker_ux/arc/main.py"), true);
    assert.equal(isPathInsideExcludedWorktree(exclusions, ".claude/worktrees/a/x.py"), true);
    assert.equal(isPathInsideExcludedWorktree(exclusions, "feature_docker_uxx/arc/main.py"), false);
    assert.equal(isPathInsideExcludedWorktree(exclusions, "arc/main.py"), false);
  });

  test("porcelain parsing takes only worktree records", () => {
    const stdout = [
      "worktree /home/x/repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /home/x/repo/nested",
      "HEAD def",
      "detached",
      "",
    ].join("\n");
    assert.deepEqual(parseWorktreePorcelain(stdout), ["/home/x/repo", "/home/x/repo/nested"]);
  });
});
