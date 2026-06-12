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
 * Honesty contract: indexed edges carry no call-site line, so excerpts are
 * always derived from a symbol's own indexed line span. We never claim an
 * `edge_site` (an exact call/reference line) we cannot prove. When the whole
 * symbol span fits the line budget we report `symbol_span`; when it is trimmed
 * to a leading window we report `signature` (signature-focused window) or
 * `fallback_symbol_window` (generic head window), never pretending the trimmed
 * window pinpoints the edge site.
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
  const emittedLines = fitsBudget ? rawLines : rawLines.slice(0, budget);

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
    : mode === "signature"
      ? "signature"
      : "fallback_symbol_window";

  return {
    filePath: symbol.filePath,
    startLine: symbol.startLine,
    endLine: symbol.startLine + boundedLines.length - 1,
    text: boundedLines.join("\n"),
    reason,
    truncated,
  };
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
