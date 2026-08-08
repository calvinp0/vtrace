import type { Database } from "bun:sqlite";

import {
  isLoadedSymbolSource,
  loadSymbolSource,
} from "../capsule/loadSymbolSource";
import type { SymbolRecord } from "../domain/types";

/**
 * Bounded source excerpt attached to flow steps and impact dependents so an
 * agent can read the relevant relationship inline instead of issuing follow-up
 * Read/Grep calls after the first VTRACE response.
 *
 * Honesty contract: excerpts are always derived from a symbol's own indexed line
 * span. We never claim an `edge_site` (an exact call/reference line) we cannot
 * prove. When the whole symbol span fits the line budget we report `symbol_span`;
 * when it is trimmed to a leading window we report `signature` (signature-focused
 * window) or `fallback_symbol_window` (generic head window), never pretending the
 * trimmed window pinpoints the edge site.
 *
 * `edge_site` is emitted ONLY when the caller supplies an exact call-site line
 * the parser persisted with the edge (`anchorLine`). A window centred on a
 * textual occurrence the caller located by name (`anchorName`) is reported as
 * `call_site_scan` instead: a caller that invokes the same callee three times
 * has three occurrences, and a scan cannot say which one produced the edge.
 * Without either, the excerpt degrades to a head window rather than guessing.
 */
export interface SourceExcerpt {
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly reason: SourceExcerptReason;
  readonly truncated: boolean;
}

export type SourceExcerptReason =
  | "symbol_span"
  | "edge_site"
  | "call_site_scan"
  | "signature"
  | "fallback_symbol_window";

export const SOURCE_EXCERPT_DEFAULTS = Object.freeze({
  /** Hard ceiling on emitted lines for any single excerpt. Never emit a file. */
  maxLines: 12,
  /** Tighter line budget for signature-focused excerpts (impact dependents). */
  signatureMaxLines: 6,
  /** Per-line character cap; longer lines are trimmed with an ellipsis. */
  maxLineChars: 200,
  /** Max excerpts attached to a single returned flow path. */
  maxFlowExcerptsPerPath: 6,
  /** Max excerpts attached across all impact dependents in one response. */
  maxImpactExcerpts: 10,
});

const ELLIPSIS = "…";

export type SymbolExcerptMode = "span" | "signature";

export interface BuildSymbolExcerptOptions {
  /**
   * `span` emits a generic head window (flow edge source); `signature` emits a
   * tighter signature-focused window (impact dependents). Both fall back to the
   * full symbol span when it already fits the budget.
   */
  readonly mode?: SymbolExcerptMode;
  /** Override the emitted line budget. Always clamped to `maxLines`. */
  readonly maxLines?: number;
  /**
   * Resolved callee/reference local name. When this name occurs as a call inside
   * the symbol's own span, the emitted window is centered on that occurrence and
   * reported as `call_site_scan`; otherwise the excerpt falls back to a head
   * window. A scan is evidence, not proof of which occurrence made the edge.
   */
  readonly anchorName?: string;
  /**
   * Exact 1-based file line of the call site the parser persisted with the edge.
   * Takes precedence over `anchorName` and is the only input that earns the
   * `edge_site` reason.
   */
  readonly anchorLine?: number;
}

/**
 * Build a bounded source excerpt for an indexed symbol, or return null when the
 * source cannot be loaded freshly or the span is invalid. Never throws: any
 * failure to load source degrades to null so the calling tool still succeeds.
 */
export function buildSymbolSourceExcerpt(
  db: Database,
  repoRoot: string,
  symbolId: string,
  options?: BuildSymbolExcerptOptions,
): SourceExcerpt | null {
  let loaded;

  try {
    loaded = loadSymbolSource(db, repoRoot, symbolId);
  } catch {
    return null;
  }

  if (!isLoadedSymbolSource(loaded)) {
    return null;
  }

  return excerptFromLoadedSymbol(loaded.symbol, loaded.fileBytes, options);
}

/**
 * Pure excerpt construction from an already-loaded symbol + file bytes. Split
 * out so tests can exercise the bounding logic without touching disk.
 */
export function excerptFromLoadedSymbol(
  symbol: SymbolRecord,
  fileBytes: Buffer,
  options?: BuildSymbolExcerptOptions,
): SourceExcerpt | null {
  if (
    symbol.startByte < 0
    || symbol.endByte < symbol.startByte
    || symbol.endByte > fileBytes.length
    || symbol.startLine < 1
    || symbol.endLine < symbol.startLine
  ) {
    return null;
  }

  const symbolText = fileBytes
    .subarray(symbol.startByte, symbol.endByte)
    .toString("utf8");

  if (symbolText.length === 0) {
    return null;
  }

  const mode: SymbolExcerptMode = options?.mode ?? "span";
  const budget = clampLineBudget(options?.maxLines, mode);

  const rawLines = symbolText.split("\n").map(stripTrailingCarriageReturn);
  // Drop a single trailing empty line introduced by a symbol span that ends on
  // a newline; keep interior blank lines so the excerpt stays faithful.
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }

  const fitsBudget = rawLines.length <= budget;
  // Anchoring only matters when the span must be trimmed: a span that already
  // fits contains the call site by construction.
  const persistedOffset = fitsBudget
    ? null
    : persistedCallSiteOffset(symbol, rawLines.length, options?.anchorLine);
  const anchorOffset = fitsBudget
    ? null
    : persistedOffset ?? locateCallSiteOffset(rawLines, options?.anchorName);
  const windowStartOffset = anchorOffset === null
    ? 0
    : Math.min(
      Math.max(0, anchorOffset - Math.floor((budget - 1) / 2)),
      Math.max(0, rawLines.length - budget),
    );
  const emittedLines = fitsBudget
    ? rawLines
    : rawLines.slice(windowStartOffset, windowStartOffset + budget);

  let lineTruncated = false;
  const boundedLines = emittedLines.map((line) => {
    if (line.length <= SOURCE_EXCERPT_DEFAULTS.maxLineChars) {
      return line;
    }

    lineTruncated = true;
    return line.slice(0, SOURCE_EXCERPT_DEFAULTS.maxLineChars) + ELLIPSIS;
  });

  const truncated = !fitsBudget || lineTruncated;
  const reason: SourceExcerptReason = fitsBudget
    ? "symbol_span"
    : persistedOffset !== null
      ? "edge_site"
      : anchorOffset !== null
        ? "call_site_scan"
        : mode === "signature"
          ? "signature"
          : "fallback_symbol_window";

  return {
    filePath: symbol.filePath,
    startLine: symbol.startLine + windowStartOffset,
    endLine: symbol.startLine + windowStartOffset + boundedLines.length - 1,
    text: boundedLines.join("\n"),
    reason,
    truncated,
  };
}

/**
 * Offset of a parser-persisted call-site line within the symbol's own span.
 *
 * Returns null when no line was supplied or the line falls outside the span:
 * a site that does not lie inside the symbol it is attributed to means the
 * index and the source have diverged, and a stale line must not be presented
 * as exact provenance.
 */
function persistedCallSiteOffset(
  symbol: SymbolRecord,
  spanLineCount: number,
  anchorLine: number | undefined,
): number | null {
  if (anchorLine === undefined || !Number.isInteger(anchorLine)) {
    return null;
  }

  const offset = anchorLine - symbol.startLine;
  return offset >= 0 && offset < spanLineCount ? offset : null;
}

/**
 * Index of the first line in the symbol's own span where `anchorName` appears as
 * a call (`name(`), ignoring attribute access on the left (`obj.name(` still
 * counts — the resolved edge already told us which symbol that is). Returns null
 * when no name is supplied or no call occurrence exists, so callers degrade to a
 * head window instead of asserting an unproven edge site.
 */
function locateCallSiteOffset(
  lines: readonly string[],
  anchorName: string | undefined,
): number | null {
  if (anchorName === undefined || !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(anchorName)) {
    return null;
  }

  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${anchorName}\\s*\\(`, "u");

  for (let offset = 0; offset < lines.length; offset += 1) {
    if (pattern.test(lines[offset]!)) {
      return offset;
    }
  }

  return null;
}

function clampLineBudget(
  requested: number | undefined,
  mode: SymbolExcerptMode,
): number {
  const fallback = mode === "signature"
    ? SOURCE_EXCERPT_DEFAULTS.signatureMaxLines
    : SOURCE_EXCERPT_DEFAULTS.maxLines;
  const desired = requested ?? fallback;

  if (!Number.isFinite(desired) || desired < 1) {
    return 1;
  }

  return Math.min(Math.floor(desired), SOURCE_EXCERPT_DEFAULTS.maxLines);
}

function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
