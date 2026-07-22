import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { computeFileId, Language, type ParseResult } from "../domain/types";
import { isAdvertisedIndexableLanguage } from "../fs/languageDetection";
import { createParserRegistry, type LanguageParser } from "../parsers";
import { normalizedGraphHash } from "./normalizedGraph";
import { createDefaultParserRegistry, indexProject } from "./indexProject";

test("default parser capabilities match advertised indexable languages", () => {
  const registered = createDefaultParserRegistry([]).registeredLanguages();
  const advertised = Object.values(Language).filter(isAdvertisedIndexableLanguage).sort();
  assert.deepEqual(registered, advertised);
  assert.equal(registered.includes(Language.JavaScript), false);
});

test("TCKDB-shaped full and incremental indexes preserve unsupported JavaScript outcomes", async () => {
  await withFixture(async (repoRoot) => {
    await writeSupportedFixture(repoRoot);
    await writeFile(path.join(repoRoot, "frontend", "eslint.config.js"), "export default [{ rules: {} }];\n");
    await writeFile(path.join(repoRoot, "frontend", "component.jsx"), "export const View = () => <main />;\n");

    const incrementalDb = openIndexerDatabase();
    const cleanFullDb = openIndexerDatabase();
    try {
      const first = await indexProject({ repoRoot, db: incrementalDb, refreshMode: "full", parserVersion: "m124", parserConfigFingerprint: "m124-config" });
      assert.equal(first.totalFilesSuccessfullyIndexed, 2);
      assert.equal(first.totalSkippedUnregisteredLanguage, 2);
      assert.deepEqual(first.files.filter((file) => file.status === "unregistered_language").map((file) => file.path), [
        "frontend/component.jsx",
        "frontend/eslint.config.js",
      ]);
      assert.equal(first.snapshot?.files.length, 4);
      assert.equal(first.snapshot?.files.find((file) => file.relativePath === "frontend/eslint.config.js")?.indexOutcome, "skipped");
      assert.equal(first.performance?.mode, "full_rebuild");
      assert.equal(first.performance?.previousGraphSnapshotUsedForMutation, false);

      const noop = await indexProject({ repoRoot, db: incrementalDb, previousSnapshot: first.snapshot, parserVersion: "m124", parserConfigFingerprint: "m124-config", refreshMode: "incremental" });
      assert.equal(noop.performance?.mode, "noop");
      assert.equal(noop.performance?.unsupportedFilesCarriedForward, 2);
      assert.equal(noop.totalSkippedUnregisteredLanguage, 2);

      await writeFile(path.join(repoRoot, "src", "helper.ts"), "export function helper(): number { return 2; }\n");
      const incremental = await indexProject({ repoRoot, db: incrementalDb, previousSnapshot: noop.snapshot, parserVersion: "m124", parserConfigFingerprint: "m124-config", refreshMode: "incremental" });
      assert.equal(incremental.totalSkippedUnregisteredLanguage, 2);
      assert.equal(incremental.performance?.unsupportedFilesCarriedForward, 2);

      const cleanFull = await indexProject({ repoRoot, db: cleanFullDb, refreshMode: "full", parserVersion: "m124", parserConfigFingerprint: "m124-config" });
      assert.equal(normalizedGraphHash(incrementalDb), normalizedGraphHash(cleanFullDb));
      assert.deepEqual(incremental.snapshot?.files, cleanFull.snapshot?.files);
      assert.deepEqual(
        incremental.files.filter((file) => file.status !== "indexed"),
        cleanFull.files.filter((file) => file.status !== "indexed"),
      );

      const explicitFull = await indexProject({ repoRoot, db: incrementalDb, previousSnapshot: incremental.snapshot, parserVersion: "m124", parserConfigFingerprint: "m124-config", refreshMode: "full" });
      assert.equal(explicitFull.performance?.mode, "full_rebuild");
      assert.equal(explicitFull.performance?.previousGraphSnapshotUsedForMutation, false);
      assert.equal(explicitFull.performance?.parseCacheHits, 2);
      assert.equal(explicitFull.performance?.parsedFiles, 2);
      assert.equal(normalizedGraphHash(incrementalDb), normalizedGraphHash(cleanFullDb));
    } finally {
      incrementalDb.close();
      cleanFullDb.close();
    }
  });
});

test("new, deleted, and renamed unsupported files follow the same snapshot policy", async () => {
  await withFixture(async (repoRoot) => {
    await writeSupportedFixture(repoRoot);
    const db = openIndexerDatabase();
    try {
      const first = await indexProject({ repoRoot, db, parserVersion: "m124", parserConfigFingerprint: "m124-config" });
      await writeFile(path.join(repoRoot, "frontend", "eslint.config.js"), "module.exports = [];\n");
      const added = await indexProject({ repoRoot, db, previousSnapshot: first.snapshot, parserVersion: "m124", parserConfigFingerprint: "m124-config" });
      assert.equal(added.totalSkippedUnregisteredLanguage, 1);
      assert.equal(added.snapshot?.files.find((file) => file.relativePath === "frontend/eslint.config.js")?.indexOutcome, "skipped");

      await rename(path.join(repoRoot, "frontend", "eslint.config.js"), path.join(repoRoot, "frontend", "lint.config.js"));
      const renamed = await indexProject({ repoRoot, db, previousSnapshot: added.snapshot, parserVersion: "m124", parserConfigFingerprint: "m124-config" });
      assert.equal(renamed.snapshot?.files.some((file) => file.relativePath === "frontend/eslint.config.js"), false);
      assert.equal(renamed.snapshot?.files.find((file) => file.relativePath === "frontend/lint.config.js")?.indexOutcome, "skipped");

      await unlink(path.join(repoRoot, "frontend", "lint.config.js"));
      const deleted = await indexProject({ repoRoot, db, previousSnapshot: renamed.snapshot, parserVersion: "m124", parserConfigFingerprint: "m124-config" });
      assert.equal(deleted.totalSkippedUnregisteredLanguage, 0);
      assert.equal(deleted.snapshot?.files.length, 2);
    } finally {
      db.close();
    }
  });
});

test("registry capability changes reconsider a previously unsupported file", async () => {
  await withFixture(async (repoRoot) => {
    await writeSupportedFixture(repoRoot);
    await writeFile(path.join(repoRoot, "frontend", "eslint.config.js"), "module.exports = [];\n");
    const db = openIndexerDatabase();
    try {
      const first = await indexProject({ repoRoot, db, parserVersion: "m124", parserConfigFingerprint: "m124-config" });
      assert.equal(first.snapshot?.files.find((file) => file.relativePath.endsWith(".js"))?.indexOutcome, "skipped");

      const supported = await indexProject({
        repoRoot,
        db,
        previousSnapshot: first.snapshot,
        parserVersion: "m124",
        parserConfigFingerprint: "m124-config",
        createParserRegistry(files) {
          const registry = createDefaultParserRegistry(files);
          registry.registerParser(Language.JavaScript, javascriptFixtureParser);
          return registry;
        },
      });
      assert.equal(supported.performance?.fallbackReason, "parser_incompatible");
      assert.equal(supported.files.find((file) => file.path.endsWith(".js"))?.status, "indexed");
      assert.equal(supported.snapshot?.files.find((file) => file.relativePath.endsWith(".js"))?.parserCapability, "supported");
    } finally {
      db.close();
    }
  });
});

test("full rebuild reuses parse cache only when the complete binding context is unchanged", async () => {
  await withFixture(async (repoRoot) => {
    await writeSupportedFixture(repoRoot);
    await writeFile(path.join(repoRoot, "frontend", "eslint.config.js"), "export default [];\n");
    const db = openIndexerDatabase();
    try {
      const first = await indexProject({ repoRoot, db, parserVersion: "m124", parserConfigFingerprint: "m124-config" });
      const unchangedFull = await indexProject({ repoRoot, db, previousSnapshot: first.snapshot, refreshMode: "full", parserVersion: "m124", parserConfigFingerprint: "m124-config" });
      assert.equal(unchangedFull.performance?.parseCacheHits, 2);
      assert.equal(unchangedFull.performance?.parsedFiles, 1);

      await writeFile(path.join(repoRoot, "src", "helper.ts"), "export function renamedHelper(): number { return 2; }\n");
      const changedFull = await indexProject({ repoRoot, db, previousSnapshot: unchangedFull.snapshot, refreshMode: "full", parserVersion: "m124", parserConfigFingerprint: "m124-config" });
      assert.equal(changedFull.performance?.parseCacheHits, 0);
      assert.equal(changedFull.performance?.parsedFiles, 3);
      assert.equal(changedFull.performance?.previousGraphSnapshotUsedForMutation, false);
    } finally {
      db.close();
    }
  });
});

test("legacy snapshots rebuild safely and persistence failures roll back", async () => {
  await withFixture(async (repoRoot) => {
    await writeSupportedFixture(repoRoot);
    const db = openIndexerDatabase();
    try {
      const first = await indexProject({ repoRoot, db, parserVersion: "m124", parserConfigFingerprint: "m124-config" });
      const before = normalizedGraphHash(db);
      const legacy = { ...first.snapshot!, schemaVersion: 2 } as never;
      const migrated = await indexProject({ repoRoot, db, previousSnapshot: legacy, parserVersion: "m124", parserConfigFingerprint: "m124-config" });
      assert.equal(migrated.performance?.mode, "full_rebuild");
      assert.equal(migrated.performance?.fallbackReason, "schema_incompatible");

      db.run("CREATE TRIGGER m124_fail_insert BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END");
      await writeFile(path.join(repoRoot, "src", "helper.ts"), "export function helper(): number { return 3; }\n");
      await assert.rejects(
        indexProject({ repoRoot, db, previousSnapshot: migrated.snapshot, parserVersion: "m124", parserConfigFingerprint: "m124-config" }),
        /injected persistence failure/,
      );
      assert.equal(normalizedGraphHash(db), before);
    } finally {
      db.close();
    }
  });
});

const javascriptFixtureParser: LanguageParser = {
  language: Language.JavaScript,
  async parse(input): Promise<ParseResult> {
    return {
      file: {
        id: computeFileId(input.path),
        path: input.path,
        language: input.language,
        contentHash: createHash("sha256").update(input.content).digest("hex"),
        sizeBytes: Buffer.byteLength(input.content),
      },
      symbols: [],
      edges: [],
      diagnostics: [],
    };
  },
};

async function writeSupportedFixture(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await mkdir(path.join(repoRoot, "frontend"), { recursive: true });
  await writeFile(path.join(repoRoot, "src", "app.py"), "def app():\n    return 1\n");
  await writeFile(path.join(repoRoot, "src", "helper.ts"), "export function helper(): number { return 1; }\n");
}

async function withFixture(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m124-"));
  try {
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}
