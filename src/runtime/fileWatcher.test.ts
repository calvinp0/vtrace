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
  createAutoReindexCoordinator,
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
      fileWatcher: state.fileWatcher,
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
      fileWatcher: stateAfterReindex.fileWatcher,
    });

    assert.equal(stateAfterReindex.observedFileChanges, undefined);
    assert.equal(freshness.state, "fresh");
  });
});

test("auto-reindex opt-in runs after watcher records source changes and clears stale state", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    let reindexCount = 0;
    const coordinator = createAutoReindexCoordinator({
      repoRoot,
      statePath: initialized.paths.statePath,
      enabled: true,
      nowMs: nextClock([4_000, 4_001, 4_002]),
      async reindex() {
        reindexCount += 1;
      },
    });

    const result = await recordObservedFileChanges({
      repoRoot,
      statePath: initialized.paths.statePath,
      changedFilePaths: ["src/service.ts"],
      nowMs: 4_000,
      autoReindexEnabled: true,
    });
    coordinator.handleObservedChanges(result);
    await waitFor(async () => {
      const state = await readRepoLocalState(initialized.paths.statePath);
      return reindexCount === 1 && state.fileWatcher?.reindexState === "idle";
    });

    const state = await readRepoLocalState(initialized.paths.statePath);
    assert.equal(state.observedFileChanges, undefined);
    assert.equal(state.fileWatcher?.autoReindexEnabled, true);
    assert.equal(state.fileWatcher?.reindexState, "idle");
    assert.equal(state.fileWatcher?.lastAutoReindexFinishedAtMs, 4_001);
  });
});

test("auto-reindex debounced burst triggers one reindex", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    let scheduled: (() => void) | null = null;
    let reindexCount = 0;
    let nowMs = 5_000;
    const coordinator = createAutoReindexCoordinator({
      repoRoot,
      statePath: initialized.paths.statePath,
      enabled: true,
      nowMs: () => nowMs++,
      async reindex() {
        reindexCount += 1;
      },
    });
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
      async onFlush(changedFilePaths, observedAtMs) {
        const result = await recordObservedFileChanges({
          repoRoot,
          statePath: initialized.paths.statePath,
          changedFilePaths,
          nowMs: observedAtMs,
          autoReindexEnabled: true,
        });
        coordinator.handleObservedChanges(result);
      },
    });

    recorder.observe(["src/service.ts"]);
    recorder.observe(["src/models.ts", "src/service.ts"]);
    scheduled?.();
    await waitFor(async () => {
      const state = await readRepoLocalState(initialized.paths.statePath);
      return reindexCount === 1 && state.fileWatcher?.reindexState === "idle";
    });

    const state = await readRepoLocalState(initialized.paths.statePath);
    assert.equal(reindexCount, 1);
    assert.equal(state.fileWatcher?.pendingChangedFileCount, 0);
    assert.deepEqual(state.fileWatcher?.changedFiles, []);
  });
});

test("auto-reindex prevents overlapping index runs and reruns after changes during an active run", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    let activeRuns = 0;
    let maxActiveRuns = 0;
    let runCount = 0;
    const releases: Array<() => void> = [];
    const coordinator = createAutoReindexCoordinator({
      repoRoot,
      statePath: initialized.paths.statePath,
      enabled: true,
      nowMs: nextClock([6_000, 6_001, 6_002, 6_003, 6_004, 6_005]),
      async reindex() {
        runCount += 1;
        activeRuns += 1;
        maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
        await new Promise<void>((resolve) => releases.push(resolve));
        activeRuns -= 1;
      },
    });

    const first = await recordObservedFileChanges({
      repoRoot,
      statePath: initialized.paths.statePath,
      changedFilePaths: ["src/service.ts"],
      nowMs: 6_000,
      autoReindexEnabled: true,
    });
    coordinator.handleObservedChanges(first);
    await waitFor(() => runCount === 1);

    const second = await recordObservedFileChanges({
      repoRoot,
      statePath: initialized.paths.statePath,
      changedFilePaths: ["src/models.ts"],
      nowMs: 6_001,
      autoReindexEnabled: true,
    });
    coordinator.handleObservedChanges(second);
    assert.equal(runCount, 1);
    assert.equal(maxActiveRuns, 1);

    releases.shift()?.();
    await waitFor(() => runCount === 2);
    releases.shift()?.();
    await waitFor(async () => {
      const state = await readRepoLocalState(initialized.paths.statePath);
      return state.fileWatcher?.reindexState === "idle";
    });

    assert.equal(maxActiveRuns, 1);
  });
});

test("auto-reindex failure leaves stale state and compact failure metadata visible", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const coordinator = createAutoReindexCoordinator({
      repoRoot,
      statePath: initialized.paths.statePath,
      enabled: true,
      nowMs: nextClock([7_000, 7_001]),
      async reindex() {
        throw new Error("synthetic indexing failure with stack details");
      },
    });
    const result = await recordObservedFileChanges({
      repoRoot,
      statePath: initialized.paths.statePath,
      changedFilePaths: ["src/service.ts"],
      nowMs: 7_000,
      autoReindexEnabled: true,
    });

    coordinator.handleObservedChanges(result);
    await waitFor(async () => {
      const state = await readRepoLocalState(initialized.paths.statePath);
      return state.fileWatcher?.reindexState === "stale_after_failed_reindex";
    });

    const state = await readRepoLocalState(initialized.paths.statePath);
    assert.notEqual(state.observedFileChanges, undefined);
    assert.equal(state.fileWatcher?.lastAutoReindexFailedAtMs, 7_001);
    assert.equal(state.fileWatcher?.lastAutoReindexError, "synthetic indexing failure with stack details");
    assert.deepEqual(state.fileWatcher?.changedFiles, ["src/service.ts"]);
  });
});

test("explicit index clears auto-reindex failure and pending stale state", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const coordinator = createAutoReindexCoordinator({
      repoRoot,
      statePath: initialized.paths.statePath,
      enabled: true,
      nowMs: nextClock([8_000, 8_001]),
      async reindex() {
        throw new Error("synthetic failure");
      },
    });
    const result = await recordObservedFileChanges({
      repoRoot,
      statePath: initialized.paths.statePath,
      changedFilePaths: ["src/service.ts"],
      nowMs: 8_000,
      autoReindexEnabled: true,
    });
    coordinator.handleObservedChanges(result);
    await waitFor(async () => {
      const state = await readRepoLocalState(initialized.paths.statePath);
      return state.fileWatcher?.reindexState === "stale_after_failed_reindex";
    });

    const indexed = await runIndexCommand([repoRoot], { cwd: repoRoot });
    assert.equal(indexed.exitCode, 0);

    const state = await readRepoLocalState(initialized.paths.statePath);
    assert.equal(state.observedFileChanges, undefined);
    assert.equal(state.fileWatcher?.autoReindexEnabled, true);
    assert.equal(state.fileWatcher?.reindexState, "idle");
    assert.equal(state.fileWatcher?.lastAutoReindexError, null);
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

function nextClock(values: number[]): () => number {
  return () => values.shift() ?? values.at(-1) ?? Date.now();
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  if (lastError !== undefined) {
    throw lastError;
  }
  throw new Error("Timed out waiting for condition");
}
