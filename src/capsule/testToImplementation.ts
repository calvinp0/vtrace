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
  /**
   * The candidate is imported at module level by a failing test file. This is
   * the broad "the test file pulls in this implementation" route — surfaced as
   * the `test_to_impl` candidate source.
   */
  importedByTestFile: boolean;
  /**
   * The candidate is called/referenced by a failing test METHOD (test_*). This
   * is the sharper "the test body actually exercises this" route — surfaced as
   * the `failing_test` candidate source.
   */
  usedByTestMethod: boolean;
}

export interface TestToImplementationOptions {
  /** Hard cap on returned implementation candidates. Default 8. */
  maxCandidates?: number;
  /** Pool size when locating a test symbol by name. Default 6. */
  anchorPoolSize?: number;
  /**
   * Class/symbol names the issue prose surfaced. When an implementation is a
   * member of one of these (e.g. a method on `ModelAdmin`), it earns extra
   * "contained in class mentioned by issue" evidence.
   */
  issueSymbols?: readonly string[];
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

  const issueSymbols = new Set(
    (options.issueSymbols ?? []).map((name) => name.toLowerCase()),
  );

  // 2. Follow outgoing imports/calls/references edges to non-test symbols. We
  //    distinguish the ROUTE: a module-level import from the test FILE is the
  //    broad `test_to_impl` route; a call/reference from a test METHOD (test_*)
  //    is the sharper `failing_test` route — the test body exercises it directly.
  type Accumulated = {
    symbol: SymbolRecord;
    relations: Set<ExpansionRelation>;
    evidence: Set<string>;
    viaTestFiles: Set<string>;
    importedByTestFile: boolean;
    usedByTestMethod: boolean;
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
      importedByTestFile: false,
      usedByTestMethod: false,
    };
    entry.relations.add(relation);
    entry.viaTestFiles.add(testSide.filePath);
    // Keep the legacy evidence line (callers/tests match on it).
    entry.evidence.add(`test file ${testSide.filePath} ${relationVerb(relation)} ${impl.localName}`);

    if (relation === ExpansionRelation.Imports) {
      entry.importedByTestFile = true;
      entry.evidence.add(`candidate imported by failing test file ${testSide.filePath}`);
    }
    if (isTestMethodSymbol(testSide)) {
      entry.usedByTestMethod = true;
      entry.evidence.add(
        `candidate's ${implKindNoun(impl)} ${impl.localName} used by failing test method ${testSide.localName}`,
      );
    }
    accumulated.set(impl.id, entry);
  }

  const candidates = [...accumulated.values()].map((entry) => {
    const evidence = new Set(entry.evidence);
    // "contained in class mentioned by issue": the impl is a member of a class
    // whose name the issue prose surfaced (e.g. ModelAdmin.get_inlines).
    const containingClass = containingClassName(db, entry.symbol);
    if (containingClass !== undefined && issueSymbols.has(containingClass.toLowerCase())) {
      evidence.add(`candidate is contained in class ${containingClass} mentioned by issue`);
    }
    return {
      symbol: entry.symbol,
      relations: [...entry.relations].sort(),
      evidence: [...evidence].sort(),
      viaTestFiles: [...entry.viaTestFiles].sort(),
      importedByTestFile: entry.importedByTestFile,
      usedByTestMethod: entry.usedByTestMethod,
    };
  });

  // Prefer implementation symbols the test body uses directly, then the most
  // relations / tests; break ties deterministically by symbol id.
  candidates.sort(
    (left, right) =>
      Number(right.usedByTestMethod) - Number(left.usedByTestMethod)
      || right.relations.length - left.relations.length
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

// A test METHOD symbol: a method/function whose name starts with `test`. Used to
// tell "the test file imports X" (file-level) from "the test body exercises X"
// (method-level), which drives the failing_test vs test_to_impl source split.
function isTestMethodSymbol(symbol: SymbolRecord): boolean {
  return /^test[_A-Za-z0-9]*$/.test(symbol.localName);
}

// The local name of the class that directly contains `symbol`, if any.
function containingClassName(db: Database, symbol: SymbolRecord): string | undefined {
  if (symbol.parentSymbolId === undefined) {
    return undefined;
  }
  const parent = getSymbolById(db, symbol.parentSymbolId);
  return parent?.localName;
}

// A human noun for the implementation kind, for evidence prose ("class"/"function").
function implKindNoun(symbol: SymbolRecord): string {
  return symbol.kind.toString().includes("class") ? "class" : "function";
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
