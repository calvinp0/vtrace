import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { Language, SymbolKind, type ParseResult } from "../domain/types";
import {
  computeParseCacheKey,
  readParseCacheEntry,
  resolveParseCacheEntryPath,
  writeParseCacheEntry,
  type ParseCacheKeyInput,
} from "./parseCache";

const baseKey: ParseCacheKeyInput = {
  contentHash: "content-sha256",
  contentKind: "working_tree_hash",
  parserId: "vtrace-typescript",
  parserVersion: "parser-v1",
  parserConfigFingerprint: "config-v1",
  language: Language.TypeScript,
  relativePath: "src/app.ts",
  bindingContextHash: "binding-v1",
};

const result: ParseResult = {
  file: { id: "file", path: "src/app.ts", language: Language.TypeScript, contentHash: "content-sha256", sizeBytes: 10 },
  symbols: [{ id: "symbol", filePath: "src/app.ts", fqName: "src/app.ts::app", localName: "app", kind: SymbolKind.Function, signature: "app()", startLine: 1, endLine: 1, startByte: 0, endByte: 10, exported: true }],
  edges: [],
  diagnostics: [],
};

test("parse cache keys cover parser, configuration, path, content, language, and binding context", () => {
  const stable = computeParseCacheKey(baseKey);
  assert.equal(computeParseCacheKey({ ...baseKey }), stable);
  for (const changed of [
    { parserVersion: "parser-v2" },
    { parserConfigFingerprint: "config-v2" },
    { relativePath: "src/renamed.ts" },
    { contentHash: "other-content" },
    { contentKind: "git_blob" as const, gitBlobSha: "blob" },
    { language: Language.JavaScript },
    { bindingContextHash: "binding-v2" },
  ]) assert.notEqual(computeParseCacheKey({ ...baseKey, ...changed }), stable);
});

test("cache entries are atomic, concurrent identical creation is safe, and corrupt entries are rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-parse-cache-"));
  try {
    await Promise.all(Array.from({ length: 8 }, () => writeParseCacheEntry(root, baseKey, result)));
    assert.deepEqual(await readParseCacheEntry(root, baseKey), result);
    const entryPath = resolveParseCacheEntryPath(root, baseKey);
    assert.doesNotMatch(await readFile(entryPath, "utf8"), /\.tmp/);
    await writeFile(entryPath, "{partial");
    assert.equal(await readParseCacheEntry(root, baseKey), undefined);
    await writeParseCacheEntry(root, baseKey, result);
    assert.deepEqual(await readParseCacheEntry(root, baseKey), result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
