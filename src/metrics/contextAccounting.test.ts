import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  buildContextAccounting,
  collectUniqueContextFilePaths,
  estimateTokensFromText,
  impactGraphOutputFilePathGroups,
  logicFlowOutputFilePathGroups,
  runPipelineOutputFilePathGroups,
  skeletonOutputFilePathGroups,
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

test("impactGraphOutputFilePathGroups counts the focal file, node files, and excerpt files", () => {
  const groups = impactGraphOutputFilePathGroups({
    resolvedSymbol: { filePath: "src/session.ts" },
    nodes: [
      // Root node (distance 0) — same file as the focal symbol.
      { filePath: "src/session.ts" },
      // A dependent whose inline excerpt names a second file.
      { filePath: "src/controller.ts", sourceExcerpt: { filePath: "src/controller.ts" } },
      // A dependent whose excerpt names a file not otherwise present as a node.
      { filePath: "src/controller.ts", sourceExcerpt: { filePath: "src/helper.ts" } },
    ],
  });
  // Deduped across resolvedSymbol, nodes, and excerpts.
  assert.deepEqual(collectUniqueContextFilePaths(groups), [
    "src/session.ts",
    "src/controller.ts",
    "src/helper.ts",
  ]);

  // An impactless symbol (no dependents) still counts its own focal file.
  const focalOnly = impactGraphOutputFilePathGroups({
    resolvedSymbol: { filePath: "src/only.ts" },
    nodes: [{ filePath: "src/only.ts" }],
  });
  assert.deepEqual(collectUniqueContextFilePaths(focalOnly), ["src/only.ts"]);
});

test("logicFlowOutputFilePathGroups counts endpoint, node, and per-step excerpt files", () => {
  const groups = logicFlowOutputFilePathGroups({
    resolvedStart: { filePath: "src/controller.ts" },
    resolvedEnd: { filePath: "src/session.ts" },
    paths: [
      {
        nodes: [{ filePath: "src/controller.ts" }, { filePath: "src/session.ts" }],
        steps: [
          { sourceExcerpt: { filePath: "src/controller.ts" } },
          { sourceExcerpt: { filePath: "src/middleware.ts" } },
        ],
      },
    ],
  });
  assert.deepEqual(collectUniqueContextFilePaths(groups), [
    "src/controller.ts",
    "src/session.ts",
    "src/middleware.ts",
  ]);

  // An unreachable result (no paths) still reports the two endpoint files.
  const unreachable = logicFlowOutputFilePathGroups({
    resolvedStart: { filePath: "src/a.ts" },
    resolvedEnd: { filePath: "src/b.ts" },
    paths: [],
  });
  assert.deepEqual(collectUniqueContextFilePaths(unreachable), ["src/a.ts", "src/b.ts"]);
});

test("skeletonOutputFilePathGroups counts each skeletonized file once", () => {
  const groups = skeletonOutputFilePathGroups({
    files: [
      { filePath: "src/a.ts" },
      { filePath: "src/b.ts" },
      { filePath: "src/a.ts" },
    ],
  });
  assert.deepEqual(collectUniqueContextFilePaths(groups), ["src/a.ts", "src/b.ts"]);

  // Tolerates a missing/empty files array.
  assert.deepEqual(collectUniqueContextFilePaths(skeletonOutputFilePathGroups({})), []);
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
