// M140: the per-file module scope symbol.
//
// WHY THIS EXISTS
// ----------------
// Module-level imports need an owner. Before M140 both the Python and Cython
// parsers attributed a file's import edges to its single top-level symbol and
// emitted NOTHING when the file had zero or more than one — so adding an
// unrelated second definition silently deleted an otherwise unchanged import
// edge, and only ~19% of real Python files could carry import edges at all.
// The same rule governed the TARGET side (`import model` resolved to model's
// lone top-level symbol), making the destination just as unstable.
//
// A structural module symbol fixes both directions: it always exists, and its
// identity depends on nothing but the file path.
//
// TWO PROPERTIES ARE LOAD-BEARING
// -------------------------------
// 1. FIXED ZERO SPAN. `computeSymbolId` hashes startByte/endByte, so a
//    body-sized span would change this symbol's id — and every import edge id
//    hanging off it — whenever the file changed length. That would reintroduce
//    the very instability this fixes. The zero span also keeps the symbol out
//    of span-containment lookups, so it can never swallow a real definition.
// 2. NON-IDENTIFIER NAME. `<module>` cannot collide with a Python/Cython
//    definition in any name-keyed index, so it is never resolved as a real
//    top-level symbol and never becomes a call source.
//
// Module symbols are STRUCTURAL (`isStructuralSymbolKind`): visible to graph
// consumers, excluded from retrieval candidates, ranking, and delivery.

import {
  buildFQName,
  computeSymbolId,
  SymbolKind,
  type SymbolRecord,
} from "../domain/types";

/** Local name of the module scope symbol. Not a valid Python/Cython identifier. */
export const MODULE_SYMBOL_LOCAL_NAME = "<module>";

/** The stable, content-independent owner of `filePath`'s module-level imports. */
export function makeModuleSymbolRecord(filePath: string): SymbolRecord {
  const fqName = buildFQName({ filePath, symbolPath: [MODULE_SYMBOL_LOCAL_NAME] });

  return {
    id: computeSymbolId({
      filePath,
      fqName,
      kind: SymbolKind.Module,
      startByte: 0,
      endByte: 0,
    }),
    filePath,
    fqName,
    localName: MODULE_SYMBOL_LOCAL_NAME,
    kind: SymbolKind.Module,
    signature: "",
    startLine: 1,
    endLine: 1,
    startByte: 0,
    endByte: 0,
    exported: false,
  };
}

/** True when `symbol` is a module scope symbol produced by this module. */
export function isModuleSymbol(symbol: SymbolRecord): boolean {
  return symbol.kind === SymbolKind.Module;
}
