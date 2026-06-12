import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  buildContextAccounting,
  collectUniqueContextFilePaths,
  estimateTokensFromText,
  runPipelineOutputFilePathGroups,
} from "./contextAccounting";

async function withTempRepo(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-accounting-"));
  try {
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

test("estimateTokensFromText is deterministic and handles empty text", () => {
  assert.equal(estimateTokensFromText(""), 0);
  // chars/4, rounded up: 8 chars -> 2 tokens, 9 chars -> 3 tokens.
  assert.equal(estimateTokensFromText("abcdefgh"), 2);
  assert.equal(estimateTokensFromText("abcdefghi"), 3);
  // Deterministic: same input, same output.
  assert.equal(estimateTokensFromText("hello world"), estimateTokensFromText("hello world"));
});

test("collectUniqueContextFilePaths dedupes path/filePath fields order-preservingly", () => {
  const groups = [
    [{ path: "src/a.ts" }, { path: "src/b.ts" }],
    [{ filePath: "src/a.ts" }, { filePath: "src/c.ts" }],
    [{ path: "  " }, { path: undefined }, {}],
  ];
  assert.deepEqual(collectUniqueContextFilePaths(groups), [
    "src/a.ts",
    "src/b.ts",
    "src/c.ts",
  ]);
});

test("accounting computes positive savings when emitted context is smaller than full files", async () => {
  await withTempRepo(async (repoRoot) => {
    // A large source file; the emitted context is a tiny excerpt of it.
    const big = "x".repeat(4_000);
    await writeFile(path.join(repoRoot, "big.ts"), big, "utf8");

    const accounting = await buildContextAccounting({
      repoRoot,
      emittedValue: { excerpt: "x".repeat(40) },
      filePathGroups: [[{ filePath: "big.ts" }]],
      latencyMs: 12,
    });

    assert.equal(accounting.method, "chars_div_4");
    assert.equal(accounting.latencyMs, 12);
    assert.equal(accounting.uniqueFilesCounted, 1);
    assert.equal(accounting.estimatedNaiveFullFileTokens, 1_000);
    assert.equal(accounting.estimatedNaiveFullFileTokens > accounting.estimatedOutputTokens, true);
    assert.equal(accounting.estimatedTokensSavedVsNaiveFullFile > 0, true);
    assert.equal(
      accounting.estimatedTokensSavedVsNaiveFullFile,
      accounting.estimatedNaiveFullFileTokens - accounting.estimatedOutputTokens,
    );
    assert.notEqual(accounting.estimatedSavingsPercentVsNaiveFullFile, null);
    assert.equal(accounting.estimatedSavingsPercentVsNaiveFullFile! > 0, true);
    assert.equal(accounting.skippedFiles, undefined);
  });
});

test("accounting clamps negative savings to zero and reports them safely", async () => {
  await withTempRepo(async (repoRoot) => {
    // A tiny source file but a large emitted response: naive < emitted.
    await writeFile(path.join(repoRoot, "tiny.ts"), "y", "utf8");

    const accounting = await buildContextAccounting({
      repoRoot,
      emittedValue: { blob: "z".repeat(4_000) },
      filePathGroups: [[{ filePath: "tiny.ts" }]],
      latencyMs: 1,
    });

    assert.equal(accounting.uniqueFilesCounted, 1);
    assert.equal(accounting.estimatedOutputTokens > accounting.estimatedNaiveFullFileTokens, true);
    // Savings never goes negative.
    assert.equal(accounting.estimatedTokensSavedVsNaiveFullFile, 0);
    // Percent is relative to naive; with savings clamped to 0 it is 0, not negative.
    assert.equal(accounting.estimatedSavingsPercentVsNaiveFullFile, 0);
  });
});

test("missing, unreadable, and out-of-repo files are recorded as skips, not failures", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeFile(path.join(repoRoot, "present.ts"), "a".repeat(400), "utf8");

    const accounting = await buildContextAccounting({
      repoRoot,
      emittedValue: { ok: true },
      filePathGroups: [
        [{ filePath: "present.ts" }],
        [{ filePath: "missing.ts" }],
        [{ filePath: "../escape.ts" }],
      ],
      latencyMs: 3,
    });

    // The present file is still counted; the others are skipped, not thrown.
    assert.equal(accounting.uniqueFilesCounted, 1);
    assert.equal(accounting.estimatedNaiveFullFileTokens, 100);
    assert.notEqual(accounting.skippedFiles, undefined);
    const skipped = accounting.skippedFiles!;
    assert.equal(skipped.length, 2);
    const escape = skipped.find((entry) => entry.path === "../escape.ts");
    assert.equal(escape?.reason, "outside_repo");
    const missing = skipped.find((entry) => entry.path === "missing.ts");
    assert.notEqual(missing, undefined);
  });
});

test("accounting with no files counted reports null savings percent", async () => {
  await withTempRepo(async (repoRoot) => {
    const accounting = await buildContextAccounting({
      repoRoot,
      emittedValue: { empty: true },
      filePathGroups: [[]],
      latencyMs: 0,
    });
    assert.equal(accounting.uniqueFilesCounted, 0);
    assert.equal(accounting.estimatedNaiveFullFileTokens, 0);
    assert.equal(accounting.estimatedTokensSavedVsNaiveFullFile, 0);
    assert.equal(accounting.estimatedSavingsPercentVsNaiveFullFile, null);
  });
});

test("runPipelineOutputFilePathGroups gathers v1 context and v2 section files", () => {
  const groups = runPipelineOutputFilePathGroups({
    context: {
      pivots: [{ filePath: "src/a.ts" }],
      supports: [{ filePath: "src/b.ts" }],
    },
    capsuleV2: {
      pivots: [{ path: "src/c.ts" }],
      support: [{ path: "src/d.ts" }],
    },
  });
  assert.deepEqual(collectUniqueContextFilePaths(groups), [
    "src/a.ts",
    "src/b.ts",
    "src/c.ts",
    "src/d.ts",
  ]);

  // Absent v2 section is tolerated (default v1-only path).
  const v1Only = runPipelineOutputFilePathGroups({
    context: { pivots: [{ filePath: "src/a.ts" }], supports: [] },
  });
  assert.deepEqual(collectUniqueContextFilePaths(v1Only), ["src/a.ts"]);
});

test("runPipelineOutputFilePathGroups counts pivot-neighborhood excerpt files", () => {
  const groups = runPipelineOutputFilePathGroups({
    capsuleV2: { pivots: [{ path: "src/pivot.ts" }], support: [] },
    pivotNeighborhood: [
      { excerpts: [{ filePath: "src/neighbor1.ts" }, { filePath: "src/neighbor2.ts" }] },
      { excerpts: [{ filePath: "src/neighbor1.ts" }] },
    ],
  });
  // Pivot file plus the two unique neighbor files (deduped) enter the naive baseline.
  assert.deepEqual(collectUniqueContextFilePaths(groups), [
    "src/pivot.ts",
    "src/neighbor1.ts",
    "src/neighbor2.ts",
  ]);
});
