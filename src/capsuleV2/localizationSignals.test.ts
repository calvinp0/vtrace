// Localization-signal detector — REAL-PARSER tests.
//
// These write real Python to disk and index it with the actual tree-sitter
// pipeline (`indexProject`), so file/symbol RESOLUTION is checked against a real
// index — exactly the gate the detector applies. No instance id or path is
// hardcoded in production logic; every signal comes from the issue text + index.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { detectLocalizationSignals } from "./localizationSignals";

async function indexRepo(files: Record<string, string>): Promise<Database> {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "loc-signals-"));
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(repoRoot, relPath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, content);
  }
  const db = openIndexerDatabase();
  await indexProject({ repoRoot, db });
  return db;
}

const REPO: Record<string, string> = {
  "pkg/widgets.py": [
    "class WidgetFactory:",
    "    def build_widget(self, name):",
    "        return name",
    "",
    "",
    "def render_widget(widget):",
    "    return str(widget)",
    "",
  ].join("\n"),
  "pkg/helpers.py": [
    "def normalize_path(p):",
    "    return p",
    "",
  ].join("\n"),
};

const endsWith = (items: readonly string[], suffix: string): boolean =>
  items.some((value) => value.endsWith(suffix));

// 1. Extracts a traceback file path AND its symbol, and resolves both.
test("extracts and resolves a traceback frame (path + symbol)", async () => {
  const db = await indexRepo(REPO);
  try {
    const task = [
      "Calling build_widget raises:",
      "",
      "Traceback (most recent call last):",
      '  File "pkg/widgets.py", line 2, in build_widget',
      "    return name",
      "TypeError: bad widget",
    ].join("\n");
    const s = detectLocalizationSignals(db, task);
    assert.ok(endsWith(s.tracebackPaths, "pkg/widgets.py"), "traceback path extracted");
    assert.ok(s.tracebackSymbols.includes("build_widget"), "traceback symbol extracted");
    assert.ok(endsWith(s.resolvedFiles, "pkg/widgets.py"), "traceback path resolves");
    assert.ok(s.resolvedSymbols.includes("build_widget"), "traceback symbol resolves");
    assert.equal(s.confidence, "strong");
    assert.equal(s.kind, "traceback");
  } finally {
    db.close();
  }
});

// 2. Resolves an explicit repo-relative file mention to the indexed file.
test("resolves an explicit file mention", async () => {
  const db = await indexRepo(REPO);
  try {
    const s = detectLocalizationSignals(db, "The normalization bug lives in pkg/helpers.py and nowhere else.");
    assert.ok(endsWith(s.explicitFileMentions, "pkg/helpers.py"), "file mention captured");
    assert.ok(endsWith(s.resolvedFiles, "pkg/helpers.py"), "file mention resolves to indexed file");
  } finally {
    db.close();
  }
});

// 3. Resolves an explicit (backtick) symbol mention to the indexed symbol.
test("resolves an explicit symbol mention", async () => {
  const db = await indexRepo(REPO);
  try {
    const s = detectLocalizationSignals(db, "The `WidgetFactory` class no longer builds widgets correctly.");
    assert.ok(s.explicitSymbolMentions.includes("WidgetFactory"), "symbol mention captured");
    assert.ok(s.resolvedSymbols.includes("WidgetFactory"), "symbol mention resolves to indexed symbol");
  } finally {
    db.close();
  }
});

// 4. Ignores file-like text that does NOT resolve in the repo.
test("ignores non-resolving file-like text", async () => {
  const db = await indexRepo(REPO);
  try {
    const s = detectLocalizationSignals(db, "See does/not/exist_zzz.py for the offending code.");
    assert.ok(endsWith(s.explicitFileMentions, "exist_zzz.py"), "file-like text is still captured pre-resolution");
    assert.ok(!endsWith(s.resolvedFiles, "exist_zzz.py"), "non-resolving file is NOT counted as localized");
    assert.notEqual(s.confidence, "strong");
  } finally {
    db.close();
  }
});

// 5. Ignores common words that match no symbol.
test("ignores common words that resolve to no symbol", async () => {
  const db = await indexRepo(REPO);
  try {
    const s = detectLocalizationSignals(db, "The error happened multiple times and the run failed unexpectedly.");
    assert.equal(s.resolvedSymbols.length, 0, "no generic word resolves to a symbol");
    assert.equal(s.resolvedFiles.length, 0, "no file resolves");
    assert.ok(s.confidence === "none" || s.confidence === "weak");
  } finally {
    db.close();
  }
});

// 6. Strong confidence ONLY for resolved file/symbol evidence — prose that names
//    nothing real stays weak.
test("assigns strong confidence only for resolved evidence", async () => {
  const db = await indexRepo(REPO);
  try {
    const unresolved = detectLocalizationSignals(
      db,
      "The `FooBarDoesNotExist` handler in some/made/up_path.py is wrong.",
    );
    assert.notEqual(unresolved.confidence, "strong", "unresolved mentions are not strong");

    const resolved = detectLocalizationSignals(
      db,
      "The `WidgetFactory` class in pkg/widgets.py builds the wrong widget.",
    );
    assert.equal(resolved.confidence, "strong", "a resolving file + symbol is strong");
  } finally {
    db.close();
  }
});
