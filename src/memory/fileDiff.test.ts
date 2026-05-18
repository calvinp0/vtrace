import assert from "node:assert/strict";
import test from "node:test";

import { Language } from "../domain/types";
import { computeFileDiff, summarizeFileDiffs } from "./computeFileDiff";
import { FileChangeType, type FileRunState } from "./types";

test("baseline runs with no previous run produce no file diffs", () => {
  const currentStates = [
    makeFileRunState({
      runId: 1,
      path: "src/a.ts",
      fileId: "file-a",
      contentHash: "hash-a",
      sizeBytes: 10,
    }),
  ];

  const diffs = computeFileDiff({
    runId: 1,
    currentStates,
  });

  assert.deepEqual(diffs, []);
  assert.deepEqual(summarizeFileDiffs(diffs), {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 0,
  });
});

test("file diffs classify added removed modified and unchanged deterministically by path", () => {
  const previousStates = [
    makeFileRunState({
      runId: 1,
      path: "src/alpha.ts",
      fileId: "file-alpha",
      contentHash: "hash-alpha",
      sizeBytes: 10,
    }),
    makeFileRunState({
      runId: 1,
      path: "src/beta.ts",
      fileId: "file-beta",
      contentHash: "hash-beta",
      sizeBytes: 20,
    }),
    makeFileRunState({
      runId: 1,
      path: "src/delta.ts",
      fileId: "file-delta",
      contentHash: "hash-delta-old",
      sizeBytes: 30,
    }),
  ];
  const currentStates = [
    makeFileRunState({
      runId: 2,
      path: "src/alpha.ts",
      fileId: "file-alpha",
      contentHash: "hash-alpha",
      sizeBytes: 10,
    }),
    makeFileRunState({
      runId: 2,
      path: "src/delta.ts",
      fileId: "file-delta",
      contentHash: "hash-delta-new",
      sizeBytes: 31,
    }),
    makeFileRunState({
      runId: 2,
      path: "src/gamma.ts",
      fileId: "file-gamma",
      contentHash: "hash-gamma",
      sizeBytes: 40,
    }),
  ];

  const diffs = computeFileDiff({
    runId: 2,
    previousRunId: 1,
    currentStates,
    previousStates,
  });

  assert.deepEqual(
    diffs.map((diff) => [diff.filePath, diff.changeType]),
    [
      ["src/alpha.ts", FileChangeType.Unchanged],
      ["src/beta.ts", FileChangeType.Removed],
      ["src/delta.ts", FileChangeType.Modified],
      ["src/gamma.ts", FileChangeType.Added],
    ],
  );
  assert.deepEqual(summarizeFileDiffs(diffs), {
    added: 1,
    removed: 1,
    modified: 1,
    unchanged: 1,
  });
});

test("repeated identical diff computation is stable", () => {
  const previousStates = [
    makeFileRunState({
      runId: 1,
      path: "src/example.ts",
      fileId: "file-example",
      contentHash: "hash-example",
      sizeBytes: 22,
    }),
  ];
  const currentStates = [
    makeFileRunState({
      runId: 2,
      path: "src/example.ts",
      fileId: "file-example",
      contentHash: "hash-example",
      sizeBytes: 22,
    }),
  ];

  const first = computeFileDiff({
    runId: 2,
    previousRunId: 1,
    currentStates,
    previousStates,
  });
  const second = computeFileDiff({
    runId: 2,
    previousRunId: 1,
    currentStates,
    previousStates,
  });

  assert.deepEqual(second, first);
});

function makeFileRunState(overrides: Partial<FileRunState>): FileRunState {
  return {
    runId: 1,
    fileId: "file-default",
    path: "src/default.ts",
    language: Language.TypeScript,
    contentHash: "hash-default",
    sizeBytes: 1,
    ...overrides,
  };
}
