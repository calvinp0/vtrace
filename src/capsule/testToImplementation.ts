// Test-to-implementation expansion.
//
// A SWE-style task hands us a FAILING TEST, not an edit target. The test itself
// is almost never what gets edited — but it points straight at the code that is:
// the modules it imports, the functions it calls, the classes it references. The
// failing test
//   tests.admin_inlines.tests.TestInline.test_get_inlines_override
// imports and exercises django/contrib/admin/options.py::ModelAdmin, which IS the
// edit target. Lexical search for the issue prose may never surface that file;
// the test's own import/reference edges do.
//
// This module walks: failing test node id -> test symbol/file in the index ->
// its outgoing imports/calls/references -> NON-test implementation candidates,
// each carrying human-readable evidence for why it was surfaced.

import type { Database } from "bun:sqlite";

import { listEdgesForSymbols } from "../db/repositories/edgesRepository";
import { getSymbolById, listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { searchSymbols } from "../retrieval/searchSymbols";
import { isLikelyTestCandidate } from "../retrieval/searchSymbolsShared";
import { ExpansionRelation } from "../retrieval/graphExpansion";
import { EdgeType, type SymbolId, type SymbolRecord } from "../domain/types";
import { parseTestNodeId, type ShapedSweQuery } from "./sweQueryShaping";

export interface TestImplCandidate {
  symbol: SymbolRecord;
  /** imports/calls/references relations by which a test reached this symbol. */
  relations: ExpansionRelation[];
  /** Human-readable selection evidence, e.g. "test file <f> imports <sym>". */
  evidence: string[];
  /** The test file(s) that pointed at this implementation. */
  viaTestFiles: string[];
}

export interface TestToImplementationOptions {
  /** Hard cap on returned implementation candidates. Default 8. */
  maxCandidates?: number;
  /** Pool size when locating a test symbol by name. Default 6. */
  anchorPoolSize?: number;
}

const DEFAULTS = Object.freeze({ maxCandidates: 8, anchorPoolSize: 6 });

// Edge types that carry a test -> implementation relationship (outgoing from the
// test side). Contains is excluded: a class containing its own test method is
// not test->impl navigation.
const IMPL_EDGE_RELATIONS: Readonly<Partial<Record<EdgeType, ExpansionRelation>>> = Object.freeze({
  [EdgeType.Imports]: ExpansionRelation.Imports,
  [EdgeType.Calls]: ExpansionRelation.Calls,
  [EdgeType.References]: ExpansionRelation.References,
});

export function expandTestsToImplementation(
  db: Database,
  shaped: ShapedSweQuery,
  options: TestToImplementationOptions = {},
): TestImplCandidate[] {
  const maxCandidates = Math.max(0, options.maxCandidates ?? DEFAULTS.maxCandidates);
  const anchorPoolSize = Math.max(1, options.anchorPoolSize ?? DEFAULTS.anchorPoolSize);
  if (shaped.failingTests.length === 0 || maxCandidates === 0) {
    return [];
  }

  // 1. Resolve the failing tests to the set of test-side symbols in the index.
  const testSideSymbols = locateTestSideSymbols(db, shaped, anchorPoolSize);
  if (testSideSymbols.size === 0) {
    return [];
  }

  const testSideIds = new Set(testSideSymbols.keys());

  // 2. Follow outgoing imports/calls/references edges to non-test symbols.
  type Accumulated = {
    symbol: SymbolRecord;
    relations: Set<ExpansionRelation>;
    evidence: Set<string>;
    viaTestFiles: Set<string>;
  };
  const accumulated = new Map<SymbolId, Accumulated>();

  for (const edge of listEdgesForSymbols(db, [...testSideIds].sort())) {
    const relation = IMPL_EDGE_RELATIONS[edge.edgeType];
    if (relation === undefined) {
      continue;
    }
    // We want the test side to be the SOURCE (importer/caller/referencer).
    const testSide = testSideSymbols.get(edge.srcSymbolId);
    if (testSide === undefined || testSideIds.has(edge.dstSymbolId)) {
      continue;
    }
    const impl = getSymbolById(db, edge.dstSymbolId);
    if (impl === undefined || isLikelyTestCandidate(impl)) {
      continue; // The edit target is the implementation, never another test.
    }

    const entry = accumulated.get(impl.id) ?? {
      symbol: impl,
      relations: new Set<ExpansionRelation>(),
      evidence: new Set<string>(),
      viaTestFiles: new Set<string>(),
    };
    entry.relations.add(relation);
    entry.viaTestFiles.add(testSide.filePath);
    entry.evidence.add(`test file ${testSide.filePath} ${relationVerb(relation)} ${impl.localName}`);
    accumulated.set(impl.id, entry);
  }

  const candidates = [...accumulated.values()].map((entry) => ({
    symbol: entry.symbol,
    relations: [...entry.relations].sort(),
    evidence: [...entry.evidence].sort(),
    viaTestFiles: [...entry.viaTestFiles].sort(),
  }));

  // Prefer implementation symbols reached by the most relations / tests; break
  // ties deterministically by symbol id.
  candidates.sort(
    (left, right) =>
      right.relations.length - left.relations.length
      || right.viaTestFiles.length - left.viaTestFiles.length
      || left.symbol.id.localeCompare(right.symbol.id),
  );

  return candidates.slice(0, maxCandidates);
}

// Resolve failing-test node ids to indexed test-side symbols, keyed by symbol id.
// Two paths: a pytest id carries a file (use every symbol in it); a Django dotted
// id carries only class/method names (locate the matching test symbol by name).
function locateTestSideSymbols(
  db: Database,
  shaped: ShapedSweQuery,
  anchorPoolSize: number,
): Map<SymbolId, SymbolRecord> {
  const bySymbolId = new Map<SymbolId, SymbolRecord>();
  const anchorFiles = new Set<string>();

  for (const testId of shaped.failingTests) {
    const parts = parseTestNodeId(testId);
    if (parts.file && parts.file.length > 0) {
      anchorFiles.add(parts.file);
    }
    for (const symbolName of parts.symbols) {
      const anchor = findTestSymbolByName(db, symbolName, anchorPoolSize);
      if (anchor !== undefined) {
        anchorFiles.add(anchor.filePath);
      }
    }
  }

  for (const file of anchorFiles) {
    for (const symbol of listSymbolsForFile(db, file)) {
      bySymbolId.set(symbol.id, symbol);
    }
  }

  return bySymbolId;
}

// Find the indexed test symbol named `symbolName` (a test class or method). We
// require a test-like candidate so a non-test symbol that merely shares the name
// is not mistaken for the test anchor.
function findTestSymbolByName(
  db: Database,
  symbolName: string,
  poolSize: number,
): SymbolRecord | undefined {
  const results = searchSymbols(db, {
    query: symbolName,
    maxResults: poolSize,
    enableTestAwareDownweighting: false,
  });
  const match = results.find(
    (result) =>
      result.localName === symbolName
      && isLikelyTestCandidate({
        filePath: result.filePath,
        localName: result.localName,
        fqName: result.fqName,
      }),
  );
  return match === undefined ? undefined : getSymbolById(db, match.symbolId);
}

function relationVerb(relation: ExpansionRelation): string {
  switch (relation) {
    case ExpansionRelation.Imports:
      return "imports";
    case ExpansionRelation.Calls:
      return "calls";
    case ExpansionRelation.References:
      return "references";
    default:
      return "uses";
  }
}
