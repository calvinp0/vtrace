import assert from "node:assert/strict";
import { test } from "bun:test";

import { Language, type FileRecord } from "../domain/types";
import {
  FILE_SNAPSHOT_SCHEMA_VERSION,
  computeSnapshotHash,
  planIncrementalRefresh,
  type IndexedFileSnapshot,
  type IndexedFileSnapshotSet,
} from "./incrementalIndex";

function file(path: string, contentHash: string): FileRecord {
  return { id: path, path, language: Language.TypeScript, contentHash, sizeBytes: contentHash.length };
}

function snap(path: string, contentHash: string): IndexedFileSnapshot {
  return { relativePath: path, language: Language.TypeScript, contentHash, contentKind: "working_tree_hash", parserId: "ts", parserVersion: "v1", parserConfigFingerprint: "c1", bindingContextHash: "b1", parseCacheKey: `${path}:${contentHash}`, sizeBytes: contentHash.length };
}

function snapshot(files: IndexedFileSnapshot[]): IndexedFileSnapshotSet {
  return { schemaVersion: FILE_SNAPSHOT_SCHEMA_VERSION, files, fileCount: files.length, snapshotHash: computeSnapshotHash(files), graphSchemaVersion: 1, retrievalSchemaVersion: 1, bindingContextHash: "b1", semanticContextHash: "s1" };
}

test("planner emits deterministic noop and modified-only incremental plans", () => {
  const previous = snapshot([snap("a.ts", "aa"), snap("b.ts", "bb")]);
  const noop = planIncrementalRefresh({ requestedMode: "auto", currentFiles: [file("b.ts", "bb"), file("a.ts", "aa")], previous, compatible: true });
  assert.equal(noop.mode, "noop");
  assert.deepEqual(noop.unchanged.map((entry) => entry.relativePath), ["a.ts", "b.ts"]);
  const changed = planIncrementalRefresh({ requestedMode: "auto", currentFiles: [file("b.ts", "bc"), file("a.ts", "aa")], previous, compatible: true });
  assert.equal(changed.mode, "incremental");
  assert.deepEqual(changed.modified.map((entry) => entry.relativePath), ["b.ts"]);
});

test("planner classifies same-content rename and conservatively falls back", () => {
  const previous = snapshot([snap("old.ts", "same")]);
  const plan = planIncrementalRefresh({ requestedMode: "auto", currentFiles: [file("new.ts", "same")], previous, compatible: true });
  assert.equal(plan.mode, "full_rebuild");
  assert.equal(plan.fullRebuildReason, "closure_uncertain");
  assert.deepEqual(plan.renamed, [{ from: "old.ts", to: "new.ts", contentHash: "same" }]);
});

test("planner reports legacy and explicit full fallbacks precisely", () => {
  const current = [file("a.ts", "aa")];
  assert.equal(planIncrementalRefresh({ requestedMode: "auto", currentFiles: current, compatible: true }).fullRebuildReason, "snapshot_missing");
  assert.equal(planIncrementalRefresh({ requestedMode: "auto", currentFiles: current, compatible: false, incompatibilityReason: "parser_incompatible" }).fullRebuildReason, "parser_incompatible");
  assert.equal(planIncrementalRefresh({ requestedMode: "full", currentFiles: current, compatible: true }).mode, "full_rebuild");
});

test("measured lightweight-parser crossover selects a precise large-change fallback", () => {
  const oldFiles = Array.from({ length: 20 }, (_, index) => snap(`f${index}.ts`, "old"));
  const current = oldFiles.map((entry, index) => file(entry.relativePath, index < 4 ? "new" : "old"));
  const plan = planIncrementalRefresh({ requestedMode: "auto", currentFiles: current, previous: snapshot(oldFiles), compatible: true });
  assert.equal(plan.mode, "full_rebuild");
  assert.equal(plan.fullRebuildReason, "change_set_too_large");
});
