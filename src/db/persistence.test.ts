import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  EdgeType,
  Language,
  SymbolKind,
  buildFQName,
  computeFileId,
  computeSymbolId,
  type EdgeRecord,
  type FileRecord,
  type ParseResult,
  type SymbolRecord,
} from "../domain/types";
import { listAllEdges, listEdgesForFile } from "./repositories/edgesRepository";
import { getFileByPath, insertFile } from "./repositories/filesRepository";
import { listSymbolsForFile } from "./repositories/symbolsRepository";
import { classifyIndexTable } from "./indexTableFamilies";
import { openIndexerDatabase } from "./sqlite";
import { persistParseResult } from "./persistParseResult";

test("the index schema installs repository evidence and nothing else", () => {
  // M152: `capsule_manifests`, `sessions` and `project_rules` used to be
  // asserted here. They are not missing — they moved to `session.sqlite`, and a
  // fresh index owning any of them again would be the regression this checks
  // for (§136).
  const db = openIndexerDatabase();

  try {
    const tables = db.query(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
    `).all() as Array<{ name: string }>;

    const tableNames = new Set(tables.map((table) => table.name));

    assert.equal(tableNames.has("edges"), true);
    assert.equal(tableNames.has("files"), true);
    assert.equal(tableNames.has("file_run_states"), true);
    assert.equal(tableNames.has("index_runs"), true);
    assert.equal(tableNames.has("symbol_run_states"), true);
    assert.equal(tableNames.has("symbols"), true);
    assert.equal(tableNames.has("symbol_mechanism_facts"), true);
    assert.equal(tableNames.has("symbol_search_fts"), true);
    // M156 §60: which files `index_repo` could not parse is derived from the
    // repository's own source, so it belongs here and not in `session.sqlite`.
    assert.equal(tableNames.has("file_index_failures"), true);
    assert.equal(classifyIndexTable("file_index_failures"), "repository_derived");

    const productOwned = [...tableNames].filter(
      (name) => classifyIndexTable(name) === "product_session",
    );
    assert.deepEqual(productOwned, [], "a fresh index must own no product/session table");

    // The stronger closure: an UNCLASSIFIED table is not caught by the check
    // above, because `null !== "product_session"`. A new table added to the
    // schema and forgotten in `indexTableFamilies` would have slipped through
    // silently — which is exactly how the boundary erodes (§9, §59).
    // `sqlite_*` objects are the engine's own bookkeeping (AUTOINCREMENT creates
    // `sqlite_sequence`); they are not vtrace state and have no family.
    const unclassified = [...tableNames]
      .filter((name) => !name.startsWith("sqlite_"))
      .filter((name) => classifyIndexTable(name) === null);
    assert.deepEqual(unclassified, [], "every table in a fresh index must be classified");
  } finally {
    db.close();
  }
});

test("file records can be inserted and read back", () => {
  const db = openIndexerDatabase();
  const file = makeFileRecord("src/example.ts", "export const value = 1;\n");

  try {
    insertFile(db, file);

    assert.deepEqual(getFileByPath(db, "./src/example.ts"), file);
  } finally {
    db.close();
  }
});

test("files.path uniqueness prevents duplicate normalized paths with different IDs", () => {
  const db = openIndexerDatabase();
  const file = makeFileRecord("src/example.ts", "export const value = 1;\n");
  const duplicatePathDifferentId: FileRecord = {
    ...file,
    id: "not-the-deterministic-file-id",
    path: "./src/example.ts",
  };

  try {
    insertFile(db, file);

    assert.throws(() => insertFile(db, duplicatePathDifferentId));
    assert.deepEqual(getFileByPath(db, "src/example.ts"), file);
  } finally {
    db.close();
  }
});

test("symbols for a file are persisted and replaced on reindex", () => {
  const db = openIndexerDatabase();
  const first = makeParseResult(
    "src/example.ts",
    "class SessionManager { createSession(): void {} }\n",
    [
      { localName: "SessionManager", kind: SymbolKind.Class, startByte: 0, endByte: 48 },
      {
        localName: "createSession",
        kind: SymbolKind.Method,
        startByte: 23,
        endByte: 47,
        parentLocalName: "SessionManager",
      },
    ],
  );
  const second = makeParseResult(
    "src/example.ts",
    "function replacement(): void {}\n",
    [{ localName: "replacement", kind: SymbolKind.Function, startByte: 0, endByte: 29 }],
  );

  try {
    persistParseResult(db, first);
    assert.deepEqual(
      listSymbolsForFile(db, "src/example.ts").map((symbol) => symbol.localName),
      ["SessionManager", "createSession"],
    );

    persistParseResult(db, second);

    assert.deepEqual(
      listSymbolsForFile(db, "src/example.ts").map((symbol) => symbol.localName),
      ["replacement"],
    );
  } finally {
    db.close();
  }
});

test("edges are persisted and replaced on reindex", () => {
  const db = openIndexerDatabase();
  const first = makeClassWithMethodResult("src/example.ts", "SessionManager", "createSession");
  const second = makeParseResult(
    "src/example.ts",
    "class SessionManager {}\n",
    [{ localName: "SessionManager", kind: SymbolKind.Class, startByte: 0, endByte: 23 }],
  );

  try {
    persistParseResult(db, first);

    assert.equal(listEdgesForFile(db, "src/example.ts").length, 1);
    assert.equal(listEdgesForFile(db, "src/example.ts")[0]?.edgeType, EdgeType.Contains);
    assert.equal(listEdgesForFile(db, "src/example.ts")[0]?.confidence, 1);

    persistParseResult(db, second);

    assert.deepEqual(listEdgesForFile(db, "src/example.ts"), []);
  } finally {
    db.close();
  }
});

test("reindexing a changed file removes stale symbols and edges", () => {
  const db = openIndexerDatabase();
  const first = makeClassWithMethodResult("src/example.ts", "SessionManager", "createSession");
  const second = makeClassWithMethodResult("src/example.ts", "SessionManager", "closeSession");

  try {
    persistParseResult(db, first);
    persistParseResult(db, second);

    const symbols = listSymbolsForFile(db, "src/example.ts");
    const edges = listEdgesForFile(db, "src/example.ts");

    assert.equal(symbols.some((symbol) => symbol.localName === "createSession"), false);
    assert.equal(symbols.some((symbol) => symbol.localName === "closeSession"), true);
    assert.equal(edges.length, 1);
    assert.equal(edges[0]?.dstSymbolId, findSymbol(symbols, "closeSession").id);
  } finally {
    db.close();
  }
});

test("repeated persistence of identical ParseResult is idempotent", () => {
  const db = openIndexerDatabase();
  const result = makeClassWithMethodResult("src/example.ts", "SessionManager", "createSession");

  try {
    persistParseResult(db, result);
    const firstState = snapshotFileState(db, "src/example.ts");

    persistParseResult(db, result);
    const secondState = snapshotFileState(db, "src/example.ts");

    assert.deepEqual(secondState, firstState);
  } finally {
    db.close();
  }
});

test("foreign key integrity prevents orphaned edge state and rolls back the file write", () => {
  const db = openIndexerDatabase();
  const result = makeParseResult(
    "src/example.ts",
    "export function source(): void {}\n",
    [{ localName: "source", kind: SymbolKind.Function, startByte: 0, endByte: 32 }],
    [
      {
        id: stableHash(["edge", "orphan"]),
        srcSymbolId: stableHash(["source"]),
        dstSymbolId: "missing-symbol",
        edgeType: EdgeType.Imports,
        confidence: 1,
      },
    ],
  );
  result.edges[0] = {
    ...result.edges[0] as EdgeRecord,
    srcSymbolId: result.symbols[0]?.id ?? "",
  };

  try {
    assert.throws(() => persistParseResult(db, result));
    assert.equal(getFileByPath(db, "src/example.ts"), undefined);
    assert.deepEqual(listSymbolsForFile(db, "src/example.ts"), []);
    assert.deepEqual(listAllEdges(db), []);
  } finally {
    db.close();
  }
});

test("failed replacement preserves the prior stored file state", () => {
  const db = openIndexerDatabase();
  const previous = makeClassWithMethodResult("src/example.ts", "SessionManager", "createSession");
  const replacement = makeParseResult(
    "src/example.ts",
    "export function source(): void {}\n",
    [{ localName: "source", kind: SymbolKind.Function, startByte: 0, endByte: 32 }],
  );
  replacement.edges.push({
    id: stableHash(["edge", "bad-replacement"]),
    srcSymbolId: replacement.symbols[0]?.id ?? "",
    dstSymbolId: "missing-symbol",
    edgeType: EdgeType.Imports,
    confidence: 1,
  });

  try {
    persistParseResult(db, previous);
    const before = snapshotFileState(db, "src/example.ts");

    assert.throws(() => persistParseResult(db, replacement));

    assert.deepEqual(snapshotFileState(db, "src/example.ts"), before);
  } finally {
    db.close();
  }
});

test("foreign key integrity prevents symbols from referencing missing files", () => {
  const db = openIndexerDatabase();

  try {
    assert.throws(() => {
      db.run(
        `
          INSERT INTO symbols (
            id,
            file_id,
            fq_name,
            local_name,
            kind,
            signature,
            start_line,
            end_line,
            start_byte,
            end_byte,
            parent_symbol_id,
            exported,
            docstring
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          "symbol:orphan",
          "missing-file",
          "src/example.ts::orphan",
          "orphan",
          SymbolKind.Function,
          "function orphan()",
          1,
          1,
          0,
          18,
          null,
          0,
          null,
        ],
      );
    });
  } finally {
    db.close();
  }
});

test("docstrings and decorator metadata round-trip through symbol persistence", () => {
  const db = openIndexerDatabase();
  const result = makeParseResult(
    "src/example.py",
    "def decorated():\n    pass\n",
    [
      {
        localName: "decorated",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 25,
        docstring: "Decorated function docstring.",
        decorators: ["task", "trace(...)"],
      },
    ],
  );

  try {
    persistParseResult(db, result);

    assert.deepEqual(listSymbolsForFile(db, "src/example.py"), result.symbols);
  } finally {
    db.close();
  }
});

interface SymbolSpec {
  localName: string;
  kind: SymbolKind;
  startByte: number;
  endByte: number;
  parentLocalName?: string;
  docstring?: string;
  decorators?: readonly string[];
}

function makeParseResult(
  path: string,
  content: string,
  symbolSpecs: readonly SymbolSpec[],
  edges: readonly EdgeRecord[] = [],
): ParseResult {
  const file = makeFileRecord(path, content);
  const symbolsByLocalName = new Map<string, SymbolRecord>();
  const symbols = symbolSpecs.map((spec) => {
    const parent = spec.parentLocalName === undefined
      ? undefined
      : symbolsByLocalName.get(spec.parentLocalName);
    const symbolPath = parent === undefined
      ? [spec.localName]
      : [parent.localName, spec.localName];
    const fqName = buildFQName({ filePath: path, symbolPath });
    const symbol: SymbolRecord = {
      id: computeSymbolId({
        filePath: path,
        fqName,
        kind: spec.kind,
        startByte: spec.startByte,
        endByte: spec.endByte,
      }),
      filePath: path,
      fqName,
      localName: spec.localName,
      kind: spec.kind,
      signature: `${spec.kind} ${spec.localName}`,
      startLine: 1,
      endLine: 1,
      startByte: spec.startByte,
      endByte: spec.endByte,
      ...(parent === undefined ? {} : { parentSymbolId: parent.id }),
      exported: false,
      ...(spec.docstring === undefined ? {} : { docstring: spec.docstring }),
      ...(spec.decorators === undefined ? {} : { decorators: [...spec.decorators] }),
    };

    symbolsByLocalName.set(symbol.localName, symbol);

    return symbol;
  });

  return {
    file,
    symbols,
    edges: [...edges],
    diagnostics: [],
  };
}

function makeClassWithMethodResult(
  path: string,
  className: string,
  methodName: string,
): ParseResult {
  const result = makeParseResult(
    path,
    `class ${className} { ${methodName}(): void {} }\n`,
    [
      { localName: className, kind: SymbolKind.Class, startByte: 0, endByte: 64 },
      {
        localName: methodName,
        kind: SymbolKind.Method,
        startByte: 23,
        endByte: 47,
        parentLocalName: className,
      },
    ],
  );
  const classSymbol = findSymbol(result.symbols, className);
  const methodSymbol = findSymbol(result.symbols, methodName);

  result.edges.push({
    id: stableHash([classSymbol.id, methodSymbol.id, EdgeType.Contains]),
    srcSymbolId: classSymbol.id,
    dstSymbolId: methodSymbol.id,
    edgeType: EdgeType.Contains,
    confidence: 1,
  });

  return result;
}

function makeFileRecord(path: string, content: string): FileRecord {
  return {
    id: computeFileId(path),
    path,
    language: Language.TypeScript,
    contentHash: stableHash([content]),
    sizeBytes: Buffer.byteLength(content),
  };
}

function snapshotFileState(db: ReturnType<typeof openIndexerDatabase>, path: string) {
  return {
    file: getFileByPath(db, path),
    symbols: listSymbolsForFile(db, path),
    edges: listEdgesForFile(db, path),
  };
}

function findSymbol(symbols: readonly SymbolRecord[], localName: string): SymbolRecord {
  const symbol = symbols.find((candidate) => candidate.localName === localName);

  assert.notEqual(symbol, undefined);

  return symbol as SymbolRecord;
}

function stableHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
