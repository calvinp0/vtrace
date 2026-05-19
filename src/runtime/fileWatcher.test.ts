import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { runIndexCommand } from "../cli/commands/indexCommand";
import { scanRepo } from "../fs/scanRepo";
import { initRepo } from "../setup/initRepo";
import {
  readRepoLocalState,
  resolveRepoLocalPaths,
} from "../setup/repoState";
import {
  FileWatchChangeType,
  createDebouncedFileChangeRecorder,
  diffSourceFileSnapshots,
  recordObservedFileChanges,
} from "./fileWatcher";
import { inspectIndexFreshness } from "./indexFreshness";

test("watcher snapshot diff detects source file creation modification and deletion", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    const previousFiles = await scanRepo(repoRoot);

    await writeFile(
      path.join(repoRoot, "src", "service.ts"),
      "export function readUser() { return 'changed'; }\n",
    );
    await writeFile(path.join(repoRoot, "src", "created.ts"), "export const created = true;\n");
    await unlink(path.join(repoRoot, "src", "script.py"));

    const currentFiles = await scanRepo(repoRoot);
    const changes = diffSourceFileSnapshots({ previousFiles, currentFiles });

    assert.deepEqual(
      changes.map((change) => [change.filePath, change.changeType]),
      [
        ["src/created.ts", FileWatchChangeType.Created],
        ["src/script.py", FileWatchChangeType.Deleted],
        ["src/service.ts", FileWatchChangeType.Modified],
      ],
    );
  });
});

test("watcher stale recording ignores repo-local state, dependencies, and non-source files", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const result = await recordObservedFileChanges({
      repoRoot,
      statePath: initialized.paths.statePath,
      changedFilePaths: [
        ".vtrace/state.ts",
        "node_modules/pkg/index.ts",
        "README.md",
      ],
      nowMs: 1_000,
    });

    assert.equal(result.observedFileChanges, null);
    assert.equal((await readRepoLocalState(initialized.paths.statePath)).observedFileChanges, undefined);
  });
});

test("debounced watcher recorder collapses event bursts into one sorted flush", () => {
  let scheduled: (() => void) | null = null;
  const flushes: Array<{ paths: readonly string[]; observedAtMs: number }> = [];
  let nowMs = 100;
  const recorder = createDebouncedFileChangeRecorder({
    debounceMs: 500,
    nowMs: () => nowMs,
    setTimer(callback) {
      scheduled = callback;
      return 1 as ReturnType<typeof setTimeout>;
    },
    clearTimer() {
      scheduled = null;
    },
    onFlush(paths, observedAtMs) {
      flushes.push({ paths, observedAtMs });
    },
  });

  recorder.observe(["src/service.ts"]);
  nowMs = 125;
  recorder.observe(["src/models.ts", "src/service.ts"]);

  assert.equal(flushes.length, 0);
  assert.notEqual(scheduled, null);
  scheduled?.();

  assert.deepEqual(flushes, [
    {
      paths: ["src/models.ts", "src/service.ts"],
      observedAtMs: 125,
    },
  ]);
});

test("watcher-observed source changes mark freshness stale with bounded sorted status", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });

    await recordObservedFileChanges({
      repoRoot,
      statePath: initialized.paths.statePath,
      changedFilePaths: ["src/service.ts", "src/models.ts", "src/service.ts"],
      nowMs: 2_000,
    });

    const state = await readRepoLocalState(initialized.paths.statePath);
    const freshness = await inspectIndexFreshness({
      repoRoot,
      lastIndexSnapshot: state.lastIndexSnapshot,
      observedFileChanges: state.observedFileChanges,
    });

    assert.equal(freshness.state, "possibly_stale");
    assert.equal(freshness.isStale, true);
    assert.equal(freshness.observedFileChanges?.reason, "file_changes_detected");
    assert.deepEqual(freshness.observedFileChanges?.changedFiles, ["src/models.ts", "src/service.ts"]);
    assert.equal(freshness.observedFileChanges?.firstChangedAtMs, 2_000);
    assert.equal(freshness.observedFileChanges?.lastChangedAtMs, 2_000);
    assert.equal(freshness.reasons[0]?.code, "file_changes_detected");
    assert.equal(freshness.reasons[0]?.count, 2);
  });
});

test("successful explicit reindex clears pending watcher stale state", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });

    await recordObservedFileChanges({
      repoRoot,
      statePath: initialized.paths.statePath,
      changedFilePaths: ["src/service.ts"],
      nowMs: 3_000,
    });

    assert.notEqual((await readRepoLocalState(initialized.paths.statePath)).observedFileChanges, undefined);

    const indexed = await runIndexCommand([repoRoot], { cwd: repoRoot });
    assert.equal(indexed.exitCode, 0);

    const stateAfterReindex = await readRepoLocalState(resolveRepoLocalPaths(repoRoot).statePath);
    const freshness = await inspectIndexFreshness({
      repoRoot,
      lastIndexSnapshot: stateAfterReindex.lastIndexSnapshot,
      observedFileChanges: stateAfterReindex.observedFileChanges,
    });

    assert.equal(stateAfterReindex.observedFileChanges, undefined);
    assert.equal(freshness.state, "fresh");
  });
});

async function withFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-watch-"));
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
  await writeFile(path.join(repoRoot, "src", "models.ts"), "export interface User { id: string }\n");
  await writeFile(
    path.join(repoRoot, "src", "service.ts"),
    "export function readUser() { return 'user'; }\n",
  );
  await writeFile(path.join(repoRoot, "src", "script.py"), "value = 1\n");
}
