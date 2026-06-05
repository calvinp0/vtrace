// Shared fixture for hybrid-retrieval tests.
//
// Builds a tiny django-shaped indexed repo WITH relationship edges (the legacy
// search testUtils seeds symbols but no edges). It mirrors the two SWE micro
// regressions the hybrid pipeline must solve:
//   - django/db/models/aggregates.py :: Aggregate / Count   (10880-style)
//   - django/contrib/admin/options.py :: ModelAdmin.get_inline_instances (11095)
// plus their failing-test files, so test-to-implementation expansion has real
// import edges to walk.

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import { persistParseResult } from "../db/persistParseResult";
import { insertEdges } from "../db/repositories/edgesRepository";
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

export interface FixtureSymbolIds {
  aggregate: string;
  aggregateAsSql: string;
  count: string;
  countInit: string;
  querySet: string;
  modelAdmin: string;
  getInlineInstances: string;
  aggregateTestCase: string;
  aggregateTestMethod: string;
  inlineAdminTest: string;
  inlineAdminTestMethod: string;
}

interface SymbolSpec {
  localName: string;
  kind: SymbolKind;
  startByte: number;
  endByte: number;
  signature?: string;
  docstring?: string;
  parentLocalName?: string;
}

// Seed the fixture and return the symbol ids by logical name for assertions.
export function seedHybridDjangoFixture(db: Database): FixtureSymbolIds {
  const ids: Record<string, string> = {};

  const aggregates = seedFile(db, "django/db/models/aggregates.py", [
    { localName: "Aggregate", kind: SymbolKind.Class, startByte: 0, endByte: 60, docstring: "Base class for aggregate expressions." },
    { localName: "as_sql", kind: SymbolKind.Method, startByte: 61, endByte: 120, parentLocalName: "Aggregate", signature: "as_sql(self, compiler, connection)" },
    { localName: "Count", kind: SymbolKind.Class, startByte: 121, endByte: 200, docstring: "Count aggregate with optional distinct." },
    { localName: "__init__", kind: SymbolKind.Method, startByte: 201, endByte: 260, parentLocalName: "Count", signature: "__init__(self, expression, distinct=False)" },
  ]);
  ids.aggregate = aggregates.Aggregate!;
  ids.aggregateAsSql = aggregates.as_sql!;
  ids.count = aggregates.Count!;
  ids.countInit = aggregates.__init__!;

  const query = seedFile(db, "django/db/models/query.py", [
    { localName: "QuerySet", kind: SymbolKind.Class, startByte: 0, endByte: 80, docstring: "Represent a lazy database lookup for a set of objects." },
  ]);
  ids.querySet = query.QuerySet!;

  const options = seedFile(db, "django/contrib/admin/options.py", [
    { localName: "ModelAdmin", kind: SymbolKind.Class, startByte: 0, endByte: 80, docstring: "Encapsulate all admin options for a given model." },
    { localName: "get_inline_instances", kind: SymbolKind.Method, startByte: 81, endByte: 160, parentLocalName: "ModelAdmin", signature: "get_inline_instances(self, request, obj=None)" },
  ]);
  ids.modelAdmin = options.ModelAdmin!;
  ids.getInlineInstances = options.get_inline_instances!;

  const aggTests = seedFile(db, "tests/aggregation/tests.py", [
    { localName: "AggregateTestCase", kind: SymbolKind.Class, startByte: 0, endByte: 80, docstring: "Regression tests for aggregate expressions." },
    { localName: "test_count_distinct_expression", kind: SymbolKind.Method, startByte: 81, endByte: 160, parentLocalName: "AggregateTestCase" },
  ]);
  ids.aggregateTestCase = aggTests.AggregateTestCase!;
  ids.aggregateTestMethod = aggTests.test_count_distinct_expression!;

  const inlineTests = seedFile(db, "tests/admin_inlines/tests.py", [
    { localName: "GenericInlineModelAdminTest", kind: SymbolKind.Class, startByte: 0, endByte: 80, docstring: "Regression tests for admin inline options." },
    { localName: "test_get_inline_instances_override_get_inlines", kind: SymbolKind.Method, startByte: 81, endByte: 180, parentLocalName: "GenericInlineModelAdminTest" },
  ]);
  ids.inlineAdminTest = inlineTests.GenericInlineModelAdminTest!;
  ids.inlineAdminTestMethod = inlineTests.test_get_inline_instances_override_get_inlines!;

  const typed = ids as unknown as FixtureSymbolIds;

  // Edges: contains/inheritance within a file, plus inter-file imports/calls.
  // Inserted directly (persistParseResult is per-file and would not carry
  // cross-file edges).
  insertEdges(db, [
    edge(typed.aggregate, typed.aggregateAsSql, EdgeType.Contains),
    edge(typed.count, typed.countInit, EdgeType.Contains),
    // Count inherits Aggregate (folded into a references edge by the Py parser).
    edge(typed.count, typed.aggregate, EdgeType.References),
    edge(typed.modelAdmin, typed.getInlineInstances, EdgeType.Contains),
    edge(typed.aggregateTestCase, typed.aggregateTestMethod, EdgeType.Contains),
    edge(typed.inlineAdminTest, typed.inlineAdminTestMethod, EdgeType.Contains),
    // QuerySet depends on Count (gives Count graph centrality).
    edge(typed.querySet, typed.count, EdgeType.Calls),
    // Failing tests import the implementation they exercise (test -> impl).
    edge(typed.aggregateTestCase, typed.count, EdgeType.Imports),
    edge(typed.aggregateTestCase, typed.aggregate, EdgeType.Imports),
    edge(typed.inlineAdminTest, typed.modelAdmin, EdgeType.Imports),
  ]);

  return typed;
}

function seedFile(
  db: Database,
  filePath: string,
  specs: readonly SymbolSpec[],
): Record<string, string> {
  const file = makeFileRecord(filePath);
  const byLocalName = new Map<string, SymbolRecord>();
  const idsByLocalName: Record<string, string> = {};

  const symbols = specs.map((spec) => {
    const parent = spec.parentLocalName === undefined
      ? undefined
      : byLocalName.get(spec.parentLocalName);
    const symbolPath = parent === undefined
      ? [spec.localName]
      : [parent.localName, spec.localName];
    const fqName = buildFQName({ filePath, symbolPath });
    const symbol: SymbolRecord = {
      id: computeSymbolId({ filePath, fqName, kind: spec.kind, startByte: spec.startByte, endByte: spec.endByte }),
      filePath,
      fqName,
      localName: spec.localName,
      kind: spec.kind,
      signature: spec.signature ?? `${spec.kind} ${spec.localName}`,
      startLine: 1,
      endLine: 1,
      startByte: spec.startByte,
      endByte: spec.endByte,
      ...(parent === undefined ? {} : { parentSymbolId: parent.id }),
      exported: false,
      ...(spec.docstring === undefined ? {} : { docstring: spec.docstring }),
    };
    byLocalName.set(spec.localName, symbol);
    idsByLocalName[spec.localName] = symbol.id;
    return symbol;
  });

  const parseResult: ParseResult = { file, symbols, edges: [], diagnostics: [] };
  persistParseResult(db, parseResult);
  return idsByLocalName;
}

function makeFileRecord(filePath: string): FileRecord {
  const content = `# ${filePath}\n`;
  return {
    id: computeFileId(filePath),
    path: filePath,
    language: Language.Python,
    contentHash: stableHash([content]),
    sizeBytes: Buffer.byteLength(content),
  };
}

function edge(src: string, dst: string, edgeType: EdgeType): EdgeRecord {
  return {
    id: stableHash([src, dst, edgeType]),
    srcSymbolId: src,
    dstSymbolId: dst,
    edgeType,
    confidence: 1,
  };
}

function stableHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
