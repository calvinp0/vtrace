import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { initRepo } from "../setup/initRepo";
import { REPO_LOCAL_DB_FILENAME, REPO_LOCAL_STATE_DIRNAME } from "../setup/types";
import {
  INDEX_FORMAT_VERSION,
  buildExpectedIndexMeta,
  checkIndexFreshness,
  readIndexMeta,
  resolveIndexMetaPath,
} from "./indexMeta";

test("index metadata is written after indexing", async () => {
  await withIndexedRepo(async (repoRoot) => {
    const meta = await readIndexMeta(repoRoot);

    assert.ok(meta, "index.meta.json should exist after init");
    assert.equal(meta.index_format_version, INDEX_FORMAT_VERSION);
    assert.equal(typeof meta.schema_version, "string");
    assert.equal(typeof meta.parser_fingerprint, "string");
    assert.equal(typeof meta.indexer_fingerprint, "string");
    assert.equal(typeof meta.config_hash, "string");
    assert.equal(typeof meta.created_at, "string");
    assert.equal(meta.manifest.files?.fileCount, 1);
    assert.equal(meta.manifest.files?.files[0]?.relativePath, "src/models.ts");
    assert.equal(typeof meta.manifest.files?.snapshotHash, "string");
    assert.equal(typeof meta.manifest.files?.files[0]?.parseCacheKey, "string");
    assert.equal(typeof meta.manifest.performance?.parsedFiles, "number");
  });
});

test("matching metadata means fresh", async () => {
  await withIndexedRepo(async (repoRoot) => {
    const expected = await buildExpectedIndexMeta(repoRoot);
    const freshness = await checkIndexFreshness(repoRoot, expected);

    assert.equal(freshness.fresh, true);
    assert.equal(freshness.reason, "index metadata matches");
    assert.deepEqual(freshness.mismatches, []);
  });
});

test("parser fingerprint mismatch means stale", async () => {
  await withIndexedRepo(async (repoRoot) => {
    const expected = await buildExpectedIndexMeta(repoRoot);
    const freshness = await checkIndexFreshness(repoRoot, {
      ...expected,
      parser_fingerprint: "deadbeef-changed",
    });

    assert.equal(freshness.fresh, false);
    assert.equal(freshness.reason, "parser fingerprint changed");
    assert.deepEqual(freshness.mismatches, ["parser_fingerprint"]);
  });
});

test("repo commit mismatch means stale", async () => {
  await withIndexedRepo(async (repoRoot) => {
    const expected = await buildExpectedIndexMeta(repoRoot);
    const freshness = await checkIndexFreshness(repoRoot, {
      ...expected,
      repo_head: "0000000000000000000000000000000000000000",
    });

    assert.equal(freshness.fresh, false);
    assert.equal(freshness.reason, "repo head changed");
    assert.deepEqual(freshness.mismatches, ["repo_head"]);
  });
});

test("missing index.sqlite means stale", async () => {
  await withIndexedRepo(async (repoRoot) => {
    await rm(path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME, REPO_LOCAL_DB_FILENAME), { force: true });

    const expected = await buildExpectedIndexMeta(repoRoot);
    const freshness = await checkIndexFreshness(repoRoot, expected);

    assert.equal(freshness.fresh, false);
    assert.equal(freshness.reason, "index database missing");
    assert.deepEqual(freshness.mismatches, ["index_sqlite"]);
  });
});

test("missing index.meta.json means stale", async () => {
  await withIndexedRepo(async (repoRoot) => {
    await rm(resolveIndexMetaPath(repoRoot), { force: true });

    const expected = await buildExpectedIndexMeta(repoRoot);
    const freshness = await checkIndexFreshness(repoRoot, expected);

    assert.equal(freshness.fresh, false);
    assert.equal(freshness.reason, "index metadata missing");
    assert.deepEqual(freshness.mismatches, ["index_meta_file"]);
  });
});

async function withIndexedRepo(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-index-meta-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "src", "models.ts"),
      "export interface User { id: string }\n",
    );
    await initRepo({ repoPath: repoRoot });
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
