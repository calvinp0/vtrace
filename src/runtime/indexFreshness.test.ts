import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { initRepo } from "../setup/initRepo";
import { inspectIndexFreshness } from "./indexFreshness";

const execFile = promisify(execFileCallback);

test("index freshness is fresh when a clean repo still matches the indexed snapshot", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    const committedHead = await initializeGitRepo(repoRoot);
    const result = await initRepo({ repoPath: repoRoot });
    const freshness = await inspectIndexFreshness({
      repoRoot,
      lastIndexSnapshot: result.state.lastIndexSnapshot,
    });

    assert.equal(freshness.state, "fresh");
    assert.equal(freshness.summary, "The current repo appears consistent with the last indexed snapshot.");
    assert.equal(freshness.currentHead, committedHead);
    assert.equal(freshness.snapshot.lastIndexedHead, committedHead);
    assert.equal(typeof freshness.snapshot.lastIndexedSourceFingerprint, "string");
    assert.deepEqual(freshness.reasons, []);
    assert.deepEqual(freshness.comparison, {
      currentSourceFileCount: 3,
      fingerprintMatches: true,
    });
  });
});

test("index freshness is fresh immediately after indexing a dirty working tree", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    const committedHead = await initializeGitRepo(repoRoot);
    await writeFile(
      path.join(repoRoot, "src", "service.ts"),
      [
        "import { User } from \"./models\";",
        "export function readUser(): User {",
        "  return { id: \"dirty-indexed\" };",
        "}",
        "",
      ].join("\n"),
    );

    const result = await initRepo({ repoPath: repoRoot });
    const freshness = await inspectIndexFreshness({
      repoRoot,
      lastIndexSnapshot: result.state.lastIndexSnapshot,
    });

    assert.equal(freshness.state, "fresh");
    assert.equal(freshness.currentHead, committedHead);
    assert.equal(freshness.snapshot.lastIndexedHead, committedHead);
    assert.equal(typeof freshness.snapshot.lastIndexedSourceFingerprint, "string");
    assert.deepEqual(freshness.reasons, []);
    assert.deepEqual(freshness.comparison, {
      currentSourceFileCount: 3,
      fingerprintMatches: true,
    });
  });
});

test("index freshness is possibly_stale when indexed source files change again after indexing", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    await initializeGitRepo(repoRoot);
    await writeFile(
      path.join(repoRoot, "src", "service.ts"),
      [
        "import { User } from \"./models\";",
        "export function readUser(): User {",
        "  return { id: \"dirty-indexed\" };",
        "}",
        "",
      ].join("\n"),
    );

    const result = await initRepo({ repoPath: repoRoot });

    await writeFile(
      path.join(repoRoot, "src", "new-service.ts"),
      "export const changedAfterIndex = true;\n",
    );

    const freshness = await inspectIndexFreshness({
      repoRoot,
      lastIndexSnapshot: result.state.lastIndexSnapshot,
    });

    assert.equal(freshness.state, "possibly_stale");
    assert.equal(freshness.summary, "Vexb detected likely drift since the last indexed snapshot.");
    assert.deepEqual(
      freshness.reasons.map((reason) => reason.code),
      ["indexed_source_file_count_differs", "indexed_source_fingerprint_differs"],
    );
    assert.deepEqual(freshness.comparison, {
      currentSourceFileCount: 4,
      fingerprintMatches: false,
    });
  });
});

test("index freshness ignores irrelevant file changes outside the indexed source universe", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    await initializeGitRepo(repoRoot);
    const result = await initRepo({ repoPath: repoRoot });

    await writeFile(path.join(repoRoot, "README.md"), "changed but not indexed\n");
    await mkdir(path.join(repoRoot, "docs"), { recursive: true });
    await writeFile(path.join(repoRoot, "docs", "notes.txt"), "still irrelevant\n");

    const freshness = await inspectIndexFreshness({
      repoRoot,
      lastIndexSnapshot: result.state.lastIndexSnapshot,
    });

    assert.equal(freshness.state, "fresh");
    assert.deepEqual(freshness.reasons, []);
    assert.deepEqual(freshness.comparison, {
      currentSourceFileCount: 3,
      fingerprintMatches: true,
    });
  });
});

test("index freshness is unknown when the stored snapshot is incomplete", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    await initializeGitRepo(repoRoot);
    const result = await initRepo({ repoPath: repoRoot });
    const freshness = await inspectIndexFreshness({
      repoRoot,
      lastIndexSnapshot: {
        ...result.state.lastIndexSnapshot!,
        lastIndexedSourceFingerprint: undefined,
      },
    });

    assert.equal(freshness.state, "unknown");
    assert.equal(freshness.summary, "Vexb could not determine whether the current repo matches the last indexed snapshot.");
    assert.deepEqual(
      freshness.reasons.map((reason) => reason.code),
      ["last_index_metadata_missing_or_incomplete"],
    );
    assert.deepEqual(freshness.comparison, {
      currentSourceFileCount: null,
      fingerprintMatches: null,
    });
  });
});

async function withFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vexb-freshness-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(repoRoot, { recursive: true });
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFixtureRepo(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "models.ts"),
    "export interface User { id: string }\n",
  );
  await writeFile(
    path.join(repoRoot, "src", "service.ts"),
    [
      "import { User } from \"./models\";",
      "export function readUser(): User {",
      "  throw new Error(\"not implemented\");",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(repoRoot, "src", "script.py"), "value = 1\n");
}

async function initializeGitRepo(repoRoot: string): Promise<string> {
  await execGit(repoRoot, ["init"]);
  await execGit(repoRoot, ["config", "user.name", "vexb-tests"]);
  await execGit(repoRoot, ["config", "user.email", "vexb@example.com"]);
  await execGit(repoRoot, ["add", "."]);
  await execGit(repoRoot, ["commit", "-m", "initial index state"]);
  return (await execGit(repoRoot, ["rev-parse", "HEAD"])).trim();
}

async function execGit(
  repoRoot: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFile("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return stdout;
}
