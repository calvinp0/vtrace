import assert from "node:assert/strict";
import { test } from "bun:test";

import { SymbolKind } from "../domain/types";
import { computeSymbolDiff, summarizeSymbolDiffs } from "./computeSymbolDiff";
import { FileChangeType, type SymbolRunState } from "./types";

test("baseline runs with no previous run produce no symbol diffs", () => {
  const currentStates = [
    makeSymbolRunState({
      runId: 1,
      symbolId: "symbol-user",
      filePath: "src/models.ts",
      fqName: "src/models.ts::User",
      localName: "User",
      kind: SymbolKind.Interface,
    }),
  ];

  const diffs = computeSymbolDiff({
    runId: 1,
    currentStates,
  });

  assert.deepEqual(diffs, []);
  assert.deepEqual(summarizeSymbolDiffs(diffs), {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 0,
  });
});

test("symbol diffs classify added removed modified and unchanged deterministically", () => {
  const previousStates = [
    makeSymbolRunState({
      runId: 1,
      symbolId: "symbol-alpha",
      filePath: "src/alpha.ts",
      fqName: "src/alpha.ts::alpha",
      localName: "alpha",
    }),
    makeSymbolRunState({
      runId: 1,
      symbolId: "symbol-beta",
      filePath: "src/beta.ts",
      fqName: "src/beta.ts::beta",
      localName: "beta",
    }),
    makeSymbolRunState({
      runId: 1,
      symbolId: "symbol-delta",
      filePath: "src/delta.ts",
      fqName: "src/delta.ts::delta",
      localName: "delta",
      signature: "function delta(): string",
    }),
  ];
  const currentStates = [
    makeSymbolRunState({
      runId: 2,
      symbolId: "symbol-alpha",
      filePath: "src/alpha.ts",
      fqName: "src/alpha.ts::alpha",
      localName: "alpha",
    }),
    makeSymbolRunState({
      runId: 2,
      symbolId: "symbol-delta",
      filePath: "src/delta.ts",
      fqName: "src/delta.ts::delta",
      localName: "delta",
      signature: "function delta(input: string): string",
    }),
    makeSymbolRunState({
      runId: 2,
      symbolId: "symbol-gamma",
      filePath: "src/gamma.ts",
      fqName: "src/gamma.ts::gamma",
      localName: "gamma",
    }),
  ];

  const diffs = computeSymbolDiff({
    runId: 2,
    previousRunId: 1,
    currentStates,
    previousStates,
  });

  assert.deepEqual(
    diffs.map((diff) => [diff.filePath, diff.fqName, diff.symbolKind, diff.changeType]),
    [
      ["src/alpha.ts", "src/alpha.ts::alpha", SymbolKind.Function, FileChangeType.Unchanged],
      ["src/beta.ts", "src/beta.ts::beta", SymbolKind.Function, FileChangeType.Removed],
      ["src/delta.ts", "src/delta.ts::delta", SymbolKind.Function, FileChangeType.Modified],
      ["src/gamma.ts", "src/gamma.ts::gamma", SymbolKind.Function, FileChangeType.Added],
    ],
  );
  assert.deepEqual(summarizeSymbolDiffs(diffs), {
    added: 1,
    removed: 1,
    modified: 1,
    unchanged: 1,
  });
});

test("span-sensitive symbol ids do not force removed and added when structural identity is stable", () => {
  const previousStates = [
    makeSymbolRunState({
      runId: 1,
      symbolId: "symbol-before-shift",
      filePath: "src/service.ts",
      fqName: "src/service.ts::readUser",
      localName: "readUser",
      startLine: 2,
      endLine: 2,
      startByte: 10,
      endByte: 42,
    }),
  ];
  const currentStates = [
    makeSymbolRunState({
      runId: 2,
      symbolId: "symbol-after-shift",
      filePath: "src/service.ts",
      fqName: "src/service.ts::readUser",
      localName: "readUser",
      startLine: 4,
      endLine: 4,
      startByte: 24,
      endByte: 56,
    }),
  ];

  const diffs = computeSymbolDiff({
    runId: 2,
    previousRunId: 1,
    currentStates,
    previousStates,
  });

  assert.equal(diffs.length, 1);
  assert.equal(diffs[0]?.changeType, FileChangeType.Modified);
  assert.equal(diffs[0]?.previousState?.symbolId, "symbol-before-shift");
  assert.equal(diffs[0]?.currentState?.symbolId, "symbol-after-shift");
});

test("repeated identical symbol diff computation is stable", () => {
  const previousStates = [
    makeSymbolRunState({
      runId: 1,
      symbolId: "symbol-user",
      filePath: "src/models.ts",
      fqName: "src/models.ts::User",
      localName: "User",
      kind: SymbolKind.Interface,
    }),
  ];
  const currentStates = [
    makeSymbolRunState({
      runId: 2,
      symbolId: "symbol-user",
      filePath: "src/models.ts",
      fqName: "src/models.ts::User",
      localName: "User",
      kind: SymbolKind.Interface,
    }),
  ];

  const first = computeSymbolDiff({
    runId: 2,
    previousRunId: 1,
    currentStates,
    previousStates,
  });
  const second = computeSymbolDiff({
    runId: 2,
    previousRunId: 1,
    currentStates,
    previousStates,
  });

  assert.deepEqual(second, first);
});

function makeSymbolRunState(overrides: Partial<SymbolRunState>): SymbolRunState {
  return {
    runId: 1,
    symbolId: "symbol-default",
    filePath: "src/default.ts",
    fqName: "src/default.ts::defaultSymbol",
    localName: "defaultSymbol",
    kind: SymbolKind.Function,
    signature: "function defaultSymbol(): void",
    exported: true,
    startLine: 1,
    endLine: 1,
    startByte: 0,
    endByte: 32,
    ...overrides,
  };
}
