// File-line anchor resolution for debug intent.
//
// An issue often points STRAIGHT at the edit site with a source anchor — a
// file path plus a line range, as a coding agent or reviewer would cite it:
//
//   compiler.py#L428-L433        (GitHub blob style, range)
//   compiler.py#L428             (GitHub blob style, single line)
//   path/to/file.py#L10          (partial-path style)
//   file.ts:42                   (editor "go to line" style)
//
// Lexical retrieval cannot use this signal: it ranks on prose overlap, so a
// nearby helper whose name matches the issue title (django-11490's
// `_setup_joins`) can out-rank the method the anchor literally names
// (`get_combinator_sql`). This module recovers the anchor's TRUE target from
// the index alone:
//
//   1. parse the anchor (path hint + line range) out of the task prose;
//   2. resolve the path hint against the indexed files (suffix match, with the
//      issue subsystem / likely-file as the tie-breaker when several match);
//   3. map the line range to the SMALLEST indexed symbol whose span encloses it
//      (nearest symbol in the file as a lower-confidence fallback).
//
// The resolved symbol is promoted as a high-confidence pivot for debug intent
// (see `refineDebugRoles`). No instance ids and no file paths are hardcoded —
// the anchor text comes from the task, everything else from the index.

import type { Database } from "bun:sqlite";

import { listAllFilePaths } from "../db/repositories/filesRepository";
import { listSymbolsForFile } from "../db/repositories/symbolsRepository";
import type { ShapedSweQuery } from "../capsule/sweQueryShaping";
import { SymbolKind, normalizeFilePath, type SymbolRecord } from "../domain/types";
import {
  HybridCandidateSource,
  type HybridCandidate,
} from "../retrieval/hybridRetrieval";
import { tokenize } from "../retrieval/hybridScoring";

// A parsed source anchor: the file the issue cited (possibly partial) and the
// 1-based line range it points at. A single-line anchor has `lineStart === lineEnd`.
export interface LineAnchor {
  /** The anchor exactly as it appeared in the task, e.g. `compiler.py#L428-L433`. */
  anchor: string;
  /** The file path hint — may be a bare basename or a partial path. */
  pathHint: string;
  lineStart: number;
  lineEnd: number;
}

/** Confidence in the symbol mapping: `high` = a symbol span encloses the range. */
export type LineAnchorConfidence = "high" | "low";

// A fully resolved anchor: the indexed file + symbol the line range maps to,
// with the resolved symbol record for candidate construction.
export interface LineAnchorResolution {
  anchor: string;
  lineStart: number;
  lineEnd: number;
  resolvedPath: string;
  resolvedSymbol: string;
  symbolId: string;
  kind: SymbolKind;
  confidence: LineAnchorConfidence;
  /** The indexed symbol record (for synthesising a candidate). */
  record: SymbolRecord;
}

// Kinds an anchor edit can land on. A module-level variable/alias the anchor
// happens to fall on is context, not the edit site — those are low-actionability
// and never promoted to a pivot.
const ACTIONABLE_KINDS: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Class,
]);

// GitHub blob anchor: `path#L428` or `path#L428-L433` (the closing `-L` is
// optional, so `#L428-433` is accepted too). The path must end in a real file
// extension (a letter-led suffix) so version numbers / fragments do not match.
const HASH_LINE_ANCHOR = /([A-Za-z0-9_./-]+\.[A-Za-z][A-Za-z0-9]*)#L(\d+)(?:-L?(\d+))?/g;

// Editor "go to line" anchor: `path:428` or `path:428-433`. A negative
// look-ahead/behind on `:` keeps this from matching a pytest node id
// (`test_x.py::TestY`), whose `::` is never followed by a digit anyway.
const COLON_LINE_ANCHOR = /([A-Za-z0-9_./-]+\.[A-Za-z][A-Za-z0-9]*):(\d+)(?:-(\d+))?(?!:)/g;

const MIN_PATH_TOKEN_LENGTH = 3;

/**
 * Parse every file-line anchor out of the task prose. Both the GitHub blob
 * (`#L`) and editor (`:`) styles are recognised; a single-line anchor reports
 * `lineStart === lineEnd`. De-duplicated by anchor text, in first-seen order.
 */
export function parseLineAnchors(task: string): LineAnchor[] {
  const anchors: LineAnchor[] = [];
  const seen = new Set<string>();

  const collect = (pattern: RegExp): void => {
    for (const match of task.matchAll(pattern)) {
      const pathHint = match[1]!;
      const lineStart = Number.parseInt(match[2]!, 10);
      const lineEnd = match[3] === undefined ? lineStart : Number.parseInt(match[3], 10);
      if (!Number.isFinite(lineStart) || lineStart <= 0) {
        continue;
      }
      const anchor = match[0]!;
      if (seen.has(anchor)) {
        continue;
      }
      seen.add(anchor);
      anchors.push({
        anchor,
        pathHint,
        lineStart,
        // A reversed range (end < start) is treated as a single line.
        lineEnd: lineEnd >= lineStart ? lineEnd : lineStart,
      });
    }
  };

  collect(HASH_LINE_ANCHOR);
  collect(COLON_LINE_ANCHOR);
  return anchors;
}

/**
 * Resolve each parsed anchor to an indexed file + enclosing symbol. Anchors whose
 * path hint matches no indexed file (or whose file has no symbols) are dropped.
 * Deterministic: ties in path resolution and symbol mapping break on stable keys.
 */
export function resolveLineAnchors(
  db: Database,
  anchors: readonly LineAnchor[],
  shaped: ShapedSweQuery,
): LineAnchorResolution[] {
  if (anchors.length === 0) {
    return [];
  }
  const allPaths = listAllFilePaths(db);
  const issueTokens = collectPathTokens(shaped);
  const resolutions: LineAnchorResolution[] = [];
  const seenSymbol = new Set<string>();

  for (const anchor of anchors) {
    const path = resolvePathHint(anchor.pathHint, allPaths, shaped, issueTokens);
    if (path === undefined) {
      continue;
    }
    const mapped = mapLineToSymbol(db, path, anchor.lineStart, anchor.lineEnd);
    if (mapped === undefined) {
      continue;
    }
    // One pivot per symbol: a file cited twice for lines in the same method
    // should not duplicate the candidate.
    if (seenSymbol.has(mapped.symbol.id)) {
      continue;
    }
    seenSymbol.add(mapped.symbol.id);
    resolutions.push({
      anchor: anchor.anchor,
      lineStart: anchor.lineStart,
      lineEnd: anchor.lineEnd,
      resolvedPath: path,
      resolvedSymbol: mapped.symbol.localName,
      symbolId: mapped.symbol.id,
      kind: mapped.symbol.kind,
      confidence: mapped.confidence,
      record: mapped.symbol,
    });
  }

  return resolutions;
}

/**
 * Synthesise a candidate for an anchor-resolved symbol. The scorecard records
 * an explicit symbol/path/lexical pointer (the issue literally names the line),
 * so the candidate clears the base pivot gate on direct evidence alone; debug
 * role refinement then promotes it with an anchor-specific reason.
 */
export function buildLineAnchorCandidate(resolution: LineAnchorResolution): HybridCandidate {
  const actionable = ACTIONABLE_KINDS.has(resolution.kind);
  return {
    symbolId: resolution.symbolId,
    filePath: resolution.record.filePath,
    fqName: resolution.record.fqName,
    localName: resolution.record.localName,
    kind: resolution.kind,
    scores: {
      lexical: 1,
      fts: 1,
      tfidf: 1,
      bm25: 1,
      symbol: 1,
      path: 1,
      testToImpl: 0,
      domain: 0,
      graph: 0,
      graphProximity: 0,
      centrality: 0,
      actionability: actionable ? 1 : 0,
      inDegree: 0,
      localEvidence: 1,
      hubPenalty: 0,
      actionabilityPenalty: 0,
      // A strong, leading final so the anchor target out-ranks the lexical pool
      // it was meant to correct. Role refinement orders anchors first regardless;
      // this keeps the base gate (non-debug intents) ranking it as an edit target.
      final: 3,
    },
    sources: [HybridCandidateSource.Symbol],
    evidence: [evidenceLine(resolution)],
    matches: [],
  };
}

/** The evidence line a resolved anchor contributes (also drives the role reason). */
export function evidenceLine(resolution: LineAnchorResolution): string {
  const relation = resolution.confidence === "high" ? "maps to enclosing symbol" : "nearest symbol is";
  return `source anchor ${resolution.anchor} ${relation} ${resolution.resolvedSymbol}`;
}

// --- path resolution ----------------------------------------------------------

// Resolve a (possibly partial) path hint to a single indexed file path. An exact
// match wins; otherwise the files whose path ENDS WITH the hint (so a bare
// `compiler.py` resolves `django/db/models/sql/compiler.py`). When several match,
// prefer the one the rest of the task supports: a likely-edit-file, then the most
// issue-subsystem overlap, then the shortest path, then lexicographic — all
// deterministic.
function resolvePathHint(
  pathHint: string,
  allPaths: readonly string[],
  shaped: ShapedSweQuery,
  issueTokens: ReadonlySet<string>,
): string | undefined {
  const hint = normalizeFilePath(pathHint);

  const exact = allPaths.find((path) => path === hint);
  if (exact !== undefined) {
    return exact;
  }

  let matches = allPaths.filter((path) => path.endsWith(`/${hint}`));
  // A partial path that matched nothing by suffix falls back to its basename, so
  // a stale directory prefix in the anchor still resolves the file.
  if (matches.length === 0 && hint.includes("/")) {
    const base = basename(hint);
    matches = allPaths.filter((path) => path === base || path.endsWith(`/${base}`));
  }
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length === 1) {
    return matches[0];
  }

  const likely = new Set(shaped.likelyFiles.map((file) => normalizeFilePath(file)));
  const supportsLikelyFile = (path: string): boolean =>
    likely.has(path) || [...likely].some((file) => path.endsWith(`/${file}`) || file.endsWith(`/${path}`));

  return [...matches].sort(
    (left, right) =>
      Number(supportsLikelyFile(right)) - Number(supportsLikelyFile(left))
      || pathTokenOverlap(right, issueTokens) - pathTokenOverlap(left, issueTokens)
      || left.length - right.length
      || left.localeCompare(right),
  )[0];
}

// --- line -> symbol mapping ---------------------------------------------------

interface MappedSymbol {
  symbol: SymbolRecord;
  confidence: LineAnchorConfidence;
}

// Map a 1-based line range to the best symbol in `filePath`. The smallest symbol
// whose span ENCLOSES the whole range wins (so a method beats its containing
// class); ties prefer an actionable function/method, then the deeper (later-
// starting) symbol, then a stable id. With no enclosing symbol, the nearest
// symbol by line distance is returned at LOW confidence.
function mapLineToSymbol(
  db: Database,
  filePath: string,
  lineStart: number,
  lineEnd: number,
): MappedSymbol | undefined {
  const symbols = listSymbolsForFile(db, filePath);
  if (symbols.length === 0) {
    return undefined;
  }

  const enclosing = symbols.filter(
    (symbol) => symbol.startLine <= lineStart && symbol.endLine >= lineEnd,
  );
  if (enclosing.length > 0) {
    const best = [...enclosing].sort(
      (left, right) =>
        span(left) - span(right)
        || Number(isFunctionLike(right.kind)) - Number(isFunctionLike(left.kind))
        || right.startLine - left.startLine
        || left.id.localeCompare(right.id),
    )[0]!;
    return { symbol: best, confidence: "high" };
  }

  const nearest = [...symbols].sort(
    (left, right) =>
      lineDistance(left, lineStart, lineEnd) - lineDistance(right, lineStart, lineEnd)
      || Number(isFunctionLike(right.kind)) - Number(isFunctionLike(left.kind))
      || left.id.localeCompare(right.id),
  )[0]!;
  return { symbol: nearest, confidence: "low" };
}

function span(symbol: SymbolRecord): number {
  return symbol.endLine - symbol.startLine;
}

function isFunctionLike(kind: SymbolKind): boolean {
  return kind === SymbolKind.Function || kind === SymbolKind.Method;
}

// Distance from a symbol's span to the anchor range: 0 when they overlap, else
// the gap to the nearer end.
function lineDistance(symbol: SymbolRecord, lineStart: number, lineEnd: number): number {
  if (symbol.endLine < lineStart) {
    return lineStart - symbol.endLine;
  }
  if (symbol.startLine > lineEnd) {
    return symbol.startLine - lineEnd;
  }
  return 0;
}

// --- token helpers ------------------------------------------------------------

function collectPathTokens(shaped: ShapedSweQuery): Set<string> {
  const tokens = new Set<string>();
  for (const token of tokenize(shaped.query)) {
    if (token.length >= MIN_PATH_TOKEN_LENGTH) {
      tokens.add(token);
    }
  }
  for (const identifier of shaped.identifiers) {
    for (const token of tokenize(identifier)) {
      if (token.length >= MIN_PATH_TOKEN_LENGTH) {
        tokens.add(token);
      }
    }
  }
  return tokens;
}

// How many distinct path segments of `path` appear in the issue tokens — the
// signal that a candidate file is in the subsystem the issue is about.
function pathTokenOverlap(path: string, issueTokens: ReadonlySet<string>): number {
  const segments = new Set(
    path
      .split("/")
      .flatMap((segment) => tokenize(segment))
      .filter((token) => issueTokens.has(token)),
  );
  return segments.size;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}
