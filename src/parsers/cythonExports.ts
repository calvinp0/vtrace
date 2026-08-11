import { Language, SymbolKind, type SymbolRecord } from "../domain/types";
import { parseCython } from "./cythonParser";

/**
 * Cross-parser symbol lookup for Python -> Cython resolution.
 *
 * When Python code imports or references a Cython-backed module (`.pyx`,
 * `.pxd`, `.pxi`), the Python resolver must NOT try to inspect that module with
 * the CPython `ast` (Cython syntax is not valid Python). Instead it asks this
 * layer, which reuses the Cython parser — the source of truth for Cython
 * structure — to extract the module's top-level exports.
 *
 * The returned `SymbolRecord`s carry the same deterministic ids the Cython
 * parser emits during indexing (ids derive from file path + fq name + kind +
 * byte span), so edges built against them point at the already-indexed Cython
 * symbols.
 */
export interface CrossLanguageExportIndex {
  /** The module scope symbol (M140): the stable target of `import module`. */
  readonly moduleSymbol?: SymbolRecord;
  /** Unambiguous top-level symbols keyed by local name. */
  readonly namedSymbols: ReadonlyMap<string, SymbolRecord>;
  /** Direct (non-inherited) members of each unambiguous top-level class. */
  readonly classMembersByClassName: ReadonlyMap<string, ReadonlyMap<string, SymbolRecord>>;
}

const EMPTY_EXPORT_INDEX: CrossLanguageExportIndex = {
  namedSymbols: new Map(),
  classMembersByClassName: new Map(),
};

/**
 * Extract the export index for a Cython-backed module. Failures (unparseable
 * source, missing interpreter) yield an empty index so resolution conservatively
 * skips rather than inventing edges.
 */
export function getCythonExportIndex(
  filePath: string,
  content: string,
): CrossLanguageExportIndex {
  let symbols: readonly SymbolRecord[];

  try {
    symbols = parseCython({ path: filePath, language: Language.Cython, content }).symbols;
  } catch {
    return EMPTY_EXPORT_INDEX;
  }

  return buildExportIndex(symbols);
}

function buildExportIndex(
  symbols: readonly SymbolRecord[],
): CrossLanguageExportIndex {
  // M140: the module scope symbol is the stable import target; it is never a
  // named export, so it is kept out of the name-keyed index.
  const allTopLevel = symbols.filter((symbol) => symbol.parentSymbolId === undefined);
  const moduleSymbol = allTopLevel.find((symbol) => symbol.kind === SymbolKind.Module);
  const topLevelSymbols = allTopLevel.filter((symbol) => symbol.kind !== SymbolKind.Module);
  const namedSymbols = collectUnambiguousByLocalName(topLevelSymbols);

  const classMembersByClassName = new Map<string, ReadonlyMap<string, SymbolRecord>>();

  for (const symbol of topLevelSymbols) {
    if (symbol.kind !== SymbolKind.Class) {
      continue;
    }

    // Only build member tables for unambiguous class names so that two classes
    // sharing a name never resolve to an arbitrary member set.
    if (namedSymbols.get(symbol.localName) !== symbol) {
      continue;
    }

    const members = symbols.filter((candidate) => candidate.parentSymbolId === symbol.id);
    classMembersByClassName.set(symbol.localName, collectUnambiguousByLocalName(members));
  }

  return {
    ...(moduleSymbol === undefined ? {} : { moduleSymbol }),
    namedSymbols,
    classMembersByClassName,
  };
}

function collectUnambiguousByLocalName(
  symbols: readonly SymbolRecord[],
): Map<string, SymbolRecord> {
  const candidates = new Map<string, SymbolRecord | undefined>();

  for (const symbol of symbols) {
    if (candidates.has(symbol.localName)) {
      candidates.set(symbol.localName, undefined);
      continue;
    }

    candidates.set(symbol.localName, symbol);
  }

  const resolved = new Map<string, SymbolRecord>();

  for (const [localName, symbol] of candidates) {
    if (symbol !== undefined) {
      resolved.set(localName, symbol);
    }
  }

  return resolved;
}
