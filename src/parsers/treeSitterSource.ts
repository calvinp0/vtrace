/**
 * The tree-sitter text boundary, shared by every tree-sitter-backed family.
 *
 * Two facts about `node-tree-sitter` 0.21.1 decide everything here, and both
 * were learned by losing files from the index (M196A, M198):
 *
 *   1. A string input is fed through a fixed buffer of 32768 UTF-16 code units
 *      and a longer source throws `Invalid argument` instead of chunking. The
 *      buffer is therefore sized to the source on every parse.
 *   2. Every node offset (`startIndex`, `endIndex`) is a UTF-16 code-unit index
 *      into the JavaScript string, while the domain contract for
 *      `SymbolRecord.startByte`/`endByte` is a UTF-8 BYTE offset — what the
 *      Python parser emits from CPython's `ast` and what every consumer that
 *      slices a file Buffer assumes. The two agree up to the first non-ASCII
 *      character and diverge by a growing constant after it.
 *
 * Coordinate system declared once, converted once: tree-sitter (UTF-16 units,
 * 0-based row/column) → VTRACE (UTF-8 bytes, 1-based lines). A family that
 * bypasses this module re-creates the M198 defect.
 */
import type Parser from "tree-sitter";

/** `node-tree-sitter` 0.21.1's default input buffer, in UTF-16 code units. */
export const TREE_SITTER_DEFAULT_BUFFER_UNITS = 32768;

/** Parse `content` with a buffer that cannot overflow on it. */
export function parseWithSizedBuffer(parser: Parser, content: string): Parser.Tree {
  return parser.parse(content, undefined, {
    bufferSize: Math.max(TREE_SITTER_DEFAULT_BUFFER_UNITS, content.length + 1),
  });
}

export interface OffsetTranslator {
  /** UTF-8 byte offset of the character at `utf16Index`. */
  byteOffsetAt(utf16Index: number): number;
  /** Inverse: the UTF-16 index of the character starting at `byteOffset`. */
  utf16IndexAt(byteOffset: number): number;
}

/**
 * Translation is exact in both directions at character boundaries, which is all
 * a node offset ever is. Pure-ASCII files — the overwhelming majority — record
 * no entries and translate by identity.
 */
export function createOffsetTranslator(content: string): OffsetTranslator {
  // `positions[i]` is a UTF-16 index whose character costs more bytes than
  // units; `deltas[i]` is the cumulative surplus INCLUDING that unit.
  const positions: number[] = [];
  const deltas: number[] = [];
  let delta = 0;

  for (let i = 0; i < content.length;) {
    const code = content.charCodeAt(i);

    if (code < 0x80) {
      i += 1;
      continue;
    }

    if (code < 0x800) {
      delta += 1;
      positions.push(i);
      deltas.push(delta);
      i += 1;
      continue;
    }

    const next = i + 1 < content.length ? content.charCodeAt(i + 1) : 0;

    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      // A surrogate pair is 2 units and 4 bytes: one surplus byte per unit, so
      // the running delta stays monotone at either half of the pair.
      delta += 1;
      positions.push(i);
      deltas.push(delta);
      delta += 1;
      positions.push(i + 1);
      deltas.push(delta);
      i += 2;
      continue;
    }

    // A BMP character at or above U+0800, or an unpaired surrogate, which
    // `Buffer` encodes as the 3-byte replacement character.
    delta += 2;
    positions.push(i);
    deltas.push(delta);
    i += 1;
  }

  if (positions.length === 0) {
    return { byteOffsetAt: (index) => index, utf16IndexAt: (offset) => offset };
  }

  /** Cumulative surplus contributed by every unit STRICTLY BEFORE `utf16Index`. */
  const surplusBefore = (utf16Index: number): number => {
    let low = 0;
    let high = positions.length - 1;
    let found = -1;

    while (low <= high) {
      const mid = (low + high) >> 1;

      if (positions[mid]! < utf16Index) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return found < 0 ? 0 : deltas[found]!;
  };

  return {
    byteOffsetAt: (utf16Index) => utf16Index + surplusBefore(utf16Index),
    utf16IndexAt: (byteOffset) => {
      // The largest index whose byte offset does not exceed `byteOffset`. Byte
      // offsets are strictly increasing in the index, so a binary search over
      // the recorded positions bounds the answer and the surplus is constant
      // between them.
      let low = 0;
      let high = positions.length - 1;
      let found = -1;

      while (low <= high) {
        const mid = (low + high) >> 1;

        if (positions[mid]! + deltas[mid]! <= byteOffset) {
          found = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      return found < 0 ? byteOffset : byteOffset - deltas[found]!;
    },
  };
}

/**
 * One-entry memo. Parsing is per-file and single-threaded, so the translator for
 * the file being parsed is built once and reused by every symbol and edge in it
 * rather than rebuilt per span.
 */
let memoizedContent: string | null = null;
let memoizedTranslator: OffsetTranslator | null = null;

export function offsetsFor(content: string): OffsetTranslator {
  if (memoizedContent !== content || memoizedTranslator === null) {
    memoizedContent = content;
    memoizedTranslator = createOffsetTranslator(content);
  }

  return memoizedTranslator;
}
