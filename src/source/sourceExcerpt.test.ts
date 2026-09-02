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

/**
 * M198 C3 / C4. An excerpt declares `startLine` as the line its text BEGINS on,
 * and `persistedOccurrence` indexes into the text by `site.startLine -
 * excerpt.startLine`. If the two disagree the rendered "call site" is some other
 * line of the file — most often the comment attached above the declaration,
 * because that is what a span that starts early reaches back into.
 *
 * The fixture puts non-ASCII text above the caller (so a byte/unit skew would
 * show) and a comment immediately above the call (so a skew has something
 * misleading to land on).
 */
test("an excerpt's declared start line is the line its text actually begins on", async () => {
  await withAnchoringFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const caller = listSymbolsByFqName(db, "src/anchor.ts::runPipeline")[0]!;
      const source = (await import("node:fs")).readFileSync(path.join(repoRoot, "src/anchor.ts"), "utf8").split("\n");

      const excerpt = buildSymbolSourceExcerpt(db, repoRoot, caller.id, { mode: "span" });

      assert.ok(excerpt);
      const emitted = excerpt.text.split("\n");
      // A symbol span starts at the DECLARATION, which for an exported symbol is
      // mid-line (`export ` precedes the node), so the first emitted line is a
      // suffix of its source line. Every line after it must be exact — that is
      // the property `persistedOccurrence` indexes on, and the property a
      // byte/unit skew breaks.
      assert.ok(source[excerpt.startLine - 1]!.endsWith(emitted[0]!),
        `line ${excerpt.startLine} is ${JSON.stringify(source[excerpt.startLine - 1])}, excerpt begins ${JSON.stringify(emitted[0])}`);
      for (let offset = 1; offset < emitted.length; offset += 1) {
        assert.equal(source[excerpt.startLine - 1 + offset], emitted[offset],
          `excerpt line ${offset} must be source line ${excerpt.startLine + offset}`);
      }
      assert.equal(excerpt.endLine, excerpt.startLine + emitted.length - 1);
    } finally {
      db.close();
    }
  });
});

test("a persisted call site renders the call, not the comment above it", async () => {
  await withAnchoringFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const { listAllEdges, listCallSitesForEdges } = await import("../db/repositories/edgesRepository");
      const { getSymbolById } = await import("../db/repositories/symbolsRepository");
      const { buildStaticRelationEvidence } = await import("../impact/staticEvidence");

      const caller = listSymbolsByFqName(db, "src/anchor.ts::runPipeline")[0]!;
      const callee = listSymbolsByFqName(db, "src/anchor.ts::determineAtoms")[0]!;
      const edge = listAllEdges(db).find((candidate) => (
        candidate.srcSymbolId === caller.id && candidate.dstSymbolId === callee.id
      ));

      assert.ok(edge, "the fixture's call must produce an edge");
      const callSites = listCallSitesForEdges(db, [edge.id]).get(edge.id) ?? [];
      assert.ok(callSites.length > 0, "the parser must record the occurrence");

      const relation = buildStaticRelationEvidence(db, edge, getSymbolById(db, caller.id)!, getSymbolById(db, callee.id)!, {
        direction: "outgoing",
        repoRoot,
        includeSourceEvidence: true,
        callSites,
      });

      const rendered = relation.evidence.sourceText;
      assert.ok(typeof rendered === "string" && rendered.length > 0, "the call must render as an expression");
      assert.ok(rendered.includes("determineAtoms"), `rendered text must name the callee, got ${JSON.stringify(rendered)}`);
      assert.ok(!rendered.trimStart().startsWith("//"), `rendered text must not be the comment, got ${JSON.stringify(rendered)}`);

      // C3 proper: the rendered line is the line the declared coordinates name.
      const source = (await import("node:fs")).readFileSync(path.join(repoRoot, "src/anchor.ts"), "utf8").split("\n");
      assert.equal(rendered, source[callSites[0]!.startLine - 1]!.trim());
    } finally {
      db.close();
    }
  });
});

async function withAnchoringFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-anchor-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "src", "anchor.ts"),
      [
        "// Résumé — two non-ASCII characters, so every byte offset below is",
        "// two greater than its UTF-16 index.",
        "",
        "export function determineAtoms(atoms: number, coords: string): string {",
        "  return `${atoms}:${coords}`;",
        "}",
        "",
        "export function runPipeline(atoms: number): string {",
        "  // Still try to determine the atoms before giving up.",
        "  return determineAtoms(atoms, \"xyz\");",
        "}",
        "",
      ].join("\n"),
    );
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * M198 C5. Where no call site was persisted, the line can only be found by
 * scanning the caller's body — and a scan hit is not proof that this occurrence
 * produced the edge. The rendering must say so rather than present the line as
 * exact provenance, because a reader cannot tell the difference from the text.
 */
test("an unpersisted occurrence is rendered as a scan, never as an exact site", async () => {
  await withAnchoringFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const { listAllEdges } = await import("../db/repositories/edgesRepository");
      const { getSymbolById } = await import("../db/repositories/symbolsRepository");
      const { buildStaticRelationEvidence } = await import("../impact/staticEvidence");

      const caller = listSymbolsByFqName(db, "src/anchor.ts::runPipeline")[0]!;
      const callee = listSymbolsByFqName(db, "src/anchor.ts::determineAtoms")[0]!;
      const edge = listAllEdges(db).find((candidate) => (
        candidate.srcSymbolId === caller.id && candidate.dstSymbolId === callee.id
      ))!;

      const relation = buildStaticRelationEvidence(db, edge, getSymbolById(db, caller.id)!, getSymbolById(db, callee.id)!, {
        direction: "outgoing",
        repoRoot,
        includeSourceEvidence: true,
        callSites: [],
      });

      assert.notEqual(relation.evidence.locationKind, "edge_site");
      assert.equal(relation.evidence.callSites, undefined);
      assert.ok(
        relation.limitations.some((limitation) => limitation.includes("not proof")),
        `an unproven occurrence must be labelled, got ${JSON.stringify(relation.limitations)}`,
      );
    } finally {
      db.close();
    }
  });
});
