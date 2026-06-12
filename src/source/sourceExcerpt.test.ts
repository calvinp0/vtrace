import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { listSymbolsByFqName } from "../db/repositories/symbolsRepository";
import type { SymbolRecord } from "../domain/types";
import {
  SOURCE_EXCERPT_DEFAULTS,
  buildSymbolSourceExcerpt,
  excerptFromLoadedSymbol,
} from "./sourceExcerpt";

function symbolFromText(text: string, overrides: Partial<SymbolRecord> = {}): {
  symbol: SymbolRecord;
  bytes: Buffer;
} {
  const bytes = Buffer.from(text, "utf8");
  const symbol: SymbolRecord = {
    id: "sym",
    filePath: "src/example.ts",
    fqName: "src/example.ts::example",
    localName: "example",
    kind: "function",
    signature: "function example()",
    startLine: 1,
    endLine: text.split("\n").length,
    startByte: 0,
    endByte: bytes.length,
    exported: true,
    ...overrides,
  };

  return { symbol, bytes };
}

test("excerpt returns the full symbol span when it fits the line budget", () => {
  const { symbol, bytes } = symbolFromText("line one\nline two\nline three");
  const excerpt = excerptFromLoadedSymbol(symbol, bytes);

  assert.ok(excerpt);
  assert.equal(excerpt.reason, "symbol_span");
  assert.equal(excerpt.truncated, false);
  assert.equal(excerpt.startLine, 1);
  assert.equal(excerpt.endLine, 3);
  assert.equal(excerpt.text, "line one\nline two\nline three");
  assert.equal(excerpt.filePath, "src/example.ts");
});

test("excerpt bounds the emitted line count for an oversized symbol (span mode)", () => {
  const lines = Array.from({ length: 40 }, (_unused, index) => `line ${index + 1}`);
  const { symbol, bytes } = symbolFromText(lines.join("\n"), { startLine: 10 });
  const excerpt = excerptFromLoadedSymbol(symbol, bytes, { mode: "span" });

  assert.ok(excerpt);
  assert.equal(excerpt.reason, "fallback_symbol_window");
  assert.equal(excerpt.truncated, true);
  assert.equal(excerpt.text.split("\n").length, SOURCE_EXCERPT_DEFAULTS.maxLines);
  assert.equal(excerpt.startLine, 10);
  assert.equal(excerpt.endLine, 10 + SOURCE_EXCERPT_DEFAULTS.maxLines - 1);
});

test("signature mode uses the tighter budget and reason", () => {
  const lines = Array.from({ length: 40 }, (_unused, index) => `line ${index + 1}`);
  const { symbol, bytes } = symbolFromText(lines.join("\n"));
  const excerpt = excerptFromLoadedSymbol(symbol, bytes, { mode: "signature" });

  assert.ok(excerpt);
  assert.equal(excerpt.reason, "signature");
  assert.equal(excerpt.truncated, true);
  assert.equal(excerpt.text.split("\n").length, SOURCE_EXCERPT_DEFAULTS.signatureMaxLines);
});

test("excerpt never exceeds the hard maxLines ceiling even when a larger budget is requested", () => {
  const lines = Array.from({ length: 40 }, (_unused, index) => `line ${index + 1}`);
  const { symbol, bytes } = symbolFromText(lines.join("\n"));
  const excerpt = excerptFromLoadedSymbol(symbol, bytes, { maxLines: 100 });

  assert.ok(excerpt);
  assert.equal(excerpt.text.split("\n").length, SOURCE_EXCERPT_DEFAULTS.maxLines);
});

test("a very long single line is trimmed and marked truncated", () => {
  const longLine = "x".repeat(SOURCE_EXCERPT_DEFAULTS.maxLineChars + 50);
  const { symbol, bytes } = symbolFromText(longLine);
  const excerpt = excerptFromLoadedSymbol(symbol, bytes);

  assert.ok(excerpt);
  // Line count still fit, so the span reason is preserved...
  assert.equal(excerpt.reason, "symbol_span");
  // ...but the per-line cap forces truncated and trims the emitted text.
  assert.equal(excerpt.truncated, true);
  assert.ok(excerpt.text.length <= SOURCE_EXCERPT_DEFAULTS.maxLineChars + 1);
  assert.ok(excerpt.text.endsWith("…"));
});

test("a trailing newline does not add a phantom blank line", () => {
  const { symbol, bytes } = symbolFromText("only line\n");
  const excerpt = excerptFromLoadedSymbol(symbol, bytes);

  assert.ok(excerpt);
  assert.equal(excerpt.startLine, 1);
  assert.equal(excerpt.endLine, 1);
  assert.equal(excerpt.text, "only line");
});

test("an invalid byte span yields no excerpt instead of throwing", () => {
  const { symbol, bytes } = symbolFromText("hello");
  const excerpt = excerptFromLoadedSymbol(
    { ...symbol, endByte: bytes.length + 100 },
    bytes,
  );

  assert.equal(excerpt, null);
});

test("buildSymbolSourceExcerpt loads fresh source for an indexed symbol", async () => {
  await withSourceFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const symbols = listSymbolsByFqName(db, "src/widget.ts::buildWidget");
      assert.equal(symbols.length, 1);

      const excerpt = buildSymbolSourceExcerpt(db, repoRoot, symbols[0]!.id, { mode: "span" });

      assert.ok(excerpt);
      assert.equal(excerpt.filePath, "src/widget.ts");
      assert.ok(excerpt.text.includes("buildWidget"));
      assert.ok(excerpt.text.split("\n").length <= SOURCE_EXCERPT_DEFAULTS.maxLines);
    } finally {
      db.close();
    }
  });
});

test("buildSymbolSourceExcerpt returns null when the source file is missing", async () => {
  await withSourceFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const symbols = listSymbolsByFqName(db, "src/widget.ts::buildWidget");
      assert.equal(symbols.length, 1);

      // Remove the indexed file so the freshness-gated loader cannot read it.
      await rm(path.join(repoRoot, "src", "widget.ts"));

      const excerpt = buildSymbolSourceExcerpt(db, repoRoot, symbols[0]!.id);
      assert.equal(excerpt, null);
    } finally {
      db.close();
    }
  });
});

test("buildSymbolSourceExcerpt returns null for an unknown symbol id", async () => {
  await withSourceFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const excerpt = buildSymbolSourceExcerpt(db, repoRoot, "does-not-exist");
      assert.equal(excerpt, null);
    } finally {
      db.close();
    }
  });
});

async function withSourceFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-source-excerpt-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "src", "widget.ts"),
      [
        "export function buildWidget(name: string): string {",
        "  return `widget:${name}`;",
        "}",
        "",
      ].join("\n"),
    );
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
