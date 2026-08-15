// The bounded source region that shows a decision being made.
//
// `product_dicts[0]` being visible because the whole function happened to be
// delivered is luck, not evidence (§48). A decision slice is the deliberate
// version: the smallest coherent region that answers three questions about the
// deciding statement — what value is selected, where that value came from
// locally, and what happens to it.
//
// It is REAL SOURCE, never a synthesized paraphrase (§24). "chooses the first
// family" is a claim; the line that does it is evidence, and only the second can
// be checked by the reader.

import { readFileSync } from "node:fs";
import path from "node:path";

import type { MechanismFact } from "../indexer/extractMechanismFacts";
import type { SymbolRecord } from "../domain/types";

/** Lines kept above the deciding statement, for the value's local origin. */
const LINES_BEFORE = 4;
/** Lines kept below it, for the immediate consequence. */
const LINES_AFTER = 2;
/** Absolute ceiling on a slice, whatever the surrounding structure suggests. */
const MAX_SLICE_LINES = 12;

export interface MechanismSlice {
  /** Real source text, dedented, with no elisions inside the kept region. */
  readonly source: string;
  /** 1-based inclusive file lines, so the reader can go and look. */
  readonly startLine: number;
  readonly endLine: number;
  /** The 1-based file line carrying the deciding statement itself. */
  readonly decisionLine: number;
  readonly lines: number;
  readonly bytes: number;
  /** Whether the region was clipped by the ceiling rather than by structure. */
  readonly truncated: boolean;
}

/**
 * Cut the slice around a fact's statement.
 *
 * The window is anchored on the fact's recorded line OFFSET, which is why that
 * offset is stored relative to the definition: an edit anywhere above the symbol
 * moves the file's absolute lines and would otherwise invalidate every anchor.
 *
 * Bounds prefer STRUCTURE over a fixed count. The upper edge stops at the
 * enclosing block — a blank line or a dedent below the statement's own
 * indentation — because that is where the local context genuinely begins, and a
 * fixed four lines would as often cut a statement in half as capture one.
 */
export function buildMechanismSlice(
  repoRoot: string,
  symbol: SymbolRecord,
  fact: MechanismFact,
): MechanismSlice | undefined {
  let content: string;
  try {
    content = readFileSync(path.resolve(repoRoot, symbol.filePath), "utf8");
  } catch {
    return undefined;
  }
  const all = content.split("\n");
  const decisionIndex = symbol.startLine - 1 + fact.lineOffset;
  if (decisionIndex < 0 || decisionIndex >= all.length) return undefined;

  const definitionStart = symbol.startLine - 1;
  const definitionEnd = Math.min(all.length - 1, symbol.endLine - 1);
  const decisionIndent = indentOf(all[decisionIndex] ?? "");

  // Walk up to the nearest structural boundary, never past the definition.
  let start = decisionIndex;
  for (let step = 0; step < LINES_BEFORE; step += 1) {
    const next = start - 1;
    if (next < definitionStart) break;
    const line = all[next] ?? "";
    // A blank line or a line less indented than the statement opens a new block;
    // include that opener (it is usually the `if`/`for` the decision sits under)
    // and stop.
    if (line.trim().length === 0) break;
    start = next;
    if (indentOf(line) < decisionIndent) break;
  }
  let end = decisionIndex;
  for (let step = 0; step < LINES_AFTER; step += 1) {
    const next = end + 1;
    if (next > definitionEnd) break;
    if ((all[next] ?? "").trim().length === 0) break;
    end = next;
  }

  let truncated = false;
  if (end - start + 1 > MAX_SLICE_LINES) {
    end = start + MAX_SLICE_LINES - 1;
    truncated = true;
  }

  const kept = all.slice(start, end + 1);
  const source = dedent(kept).join("\n");
  return {
    source,
    startLine: start + 1,
    endLine: end + 1,
    decisionLine: decisionIndex + 1,
    lines: kept.length,
    bytes: Buffer.byteLength(source, "utf8"),
    truncated,
  };
}

/** Strip the common leading whitespace so a nested slice reads on its own. */
function dedent(lines: readonly string[]): string[] {
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => indentOf(line));
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => (line.length >= common ? line.slice(common) : line.trimStart()));
}

function indentOf(line: string): number {
  const match = /^[ \t]*/u.exec(line);
  return match === null ? 0 : match[0].length;
}
