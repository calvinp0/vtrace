// High-signal literal / option / acronym anchoring.
//
// WHY THIS EXISTS
// ----------------
// Title-symbol anchoring recovers the symbol named in the TITLE when it takes a
// class/function shape. But the post-title audit found a second candidate-
// generation gap: many remaining misses produce ZERO title-symbol terms because
// their highest-signal term is not a normal symbol shape — it is an ALL-CAPS
// format/acronym (`FITS`, `CDS`, `MRT`), a dunder (`__array_function__`), a CLI/
// config option (`--ignore-paths`), or a backticked config name (`napoleon_use_param`).
// Those terms are stronger anchors than ordinary prose, yet ordinary lexical
// ranking treats them as plain words, so the file/symbol they name never reliably
// enters the pool.
//
// This module is a general candidate GENERATOR complementing title-symbol
// anchoring (it does NOT replace it). It extracts only HIGH-CONFIDENCE,
// author-marked or shape-unambiguous terms from the whole task, resolves each to
// indexed production symbols by name / path segment / body literal / module
// constant / config variable, and emits candidates carrying direct
// "task mentions high-signal literal `X`" evidence. Scoring sits AROUND
// title-symbol strength — below an explicit line anchor and a body-literal
// diagnostic code, above ordinary lexical/graph expansion.
//
// Conservative by construction: no repo rules, no instance ids; generic acronyms
// and exception names are filtered, and matches are capped per anchor and overall
// so a common term cannot explode the candidate count.

import type { Database } from "bun:sqlite";

import { getSymbolById } from "../db/repositories/symbolsRepository";
import { searchBodyLiterals } from "../db/repositories/bodyLiteralsRepository";
import { SymbolKind, type SymbolRecord } from "../domain/types";
import {
  HybridCandidateSource,
  type HybridCandidate,
} from "../retrieval/hybridRetrieval";
import { searchSymbols } from "../retrieval/searchSymbols";
import { isLikelyTestCandidate } from "../retrieval/searchSymbolsShared";

// Synthesized final score for a literal-anchor candidate — the SAME tier as a
// title-symbol match (an exact high-signal-literal hit is comparable evidence to
// an exact title-symbol name). Below the line-anchor lead (3) and a body-literal
// diagnostic, above normal lexical/graph expansion.
export const LITERAL_ANCHOR_FINAL = 2.5;

const ACTIONABLE_KINDS: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Class,
]);

// Module-level kinds that a snake_case config / SCREAMING constant resolves to.
const CONFIG_KINDS: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.ModuleConstant,
  SymbolKind.ModuleVariable,
  SymbolKind.ModuleAlias,
]);

// Caps — recover the named site without flooding the pool with a common term.
const MAX_MATCHES_PER_TERM = 3;
const MAX_TOTAL_MATCHES = 8;
const MAX_TERMS = 12;
const MAX_SEARCH_RESULTS = 8;
const MIN_ACRONYM_LENGTH = 3;
const MIN_LITERAL_LENGTH = 3;

// Generic ALL-CAPS acronyms that name infrastructure, a protocol, or a serialization
// format rather than a bug domain — searching them anchors on ubiquitous helpers.
// Small and conservative; the caps still bound any survivor.
const GENERIC_ACRONYMS: ReadonlySet<string> = new Set([
  "THE", "AND", "NOT", "FOR", "ALL", "ANY", "API", "URL", "URI", "HTTP", "HTTPS",
  "HTML", "XML", "JSON", "YAML", "SQL", "TODO", "FIXME", "NOTE", "XXX", "ASCII",
  "UTF", "ID", "OK", "NaN",
]);

// Common dunders present in nearly every module — no edit-target signal on their own.
const GENERIC_DUNDERS: ReadonlySet<string> = new Set([
  "__init__", "__main__", "__name__", "__doc__", "__dict__", "__class__",
  "__module__", "__repr__", "__str__", "__file__", "__all__", "__version__",
]);

// Generic lowercase tokens that a quote/backtick must not turn into an anchor.
const GENERIC_LITERAL_TOKENS: ReadonlySet<string> = new Set([
  "true", "false", "none", "null", "self", "cls", "the", "and", "for", "not",
  "type", "value", "error", "bug", "issue", "test", "todo", "note", "warning",
]);

/** The shape an anchor was recognised by — drives the evidence wording. */
export type LiteralAnchorKind = "acronym" | "dunder" | "option" | "literal";

export interface LiteralAnchor {
  readonly term: string;
  readonly kind: LiteralAnchorKind;
}

export interface LiteralAnchorMatch {
  /** The high-signal term that matched (e.g. "FITS", "--ignore-paths"). */
  readonly term: string;
  readonly path: string;
  readonly symbol: string;
  readonly symbolId: string;
}

export interface LiteralAnchorResult {
  readonly used: boolean;
  /** High-signal terms extracted from the task (after filtering). */
  readonly terms: string[];
  /** The production symbols those terms resolved to. */
  readonly matches: LiteralAnchorMatch[];
  /** Candidates to merge into the pool (one per match). */
  readonly candidates: HybridCandidate[];
}

const EMPTY: LiteralAnchorResult = { used: false, terms: [], matches: [], candidates: [] };

export interface LiteralAnchorInput {
  readonly db: Database;
  readonly task: string;
}

// Recover candidates for the high-signal literals named anywhere in the task. Pure
// with respect to the index: extract anchors, resolve each to indexed production
// symbols, emit one candidate per resolved symbol.
export function anchorLiterals(input: LiteralAnchorInput): LiteralAnchorResult {
  const anchors = extractLiteralAnchors(input.task);
  if (anchors.length === 0) return EMPTY;

  const matches: LiteralAnchorMatch[] = [];
  const candidates: HybridCandidate[] = [];
  const seenSymbolIds = new Set<string>();

  for (const anchor of anchors) {
    if (candidates.length >= MAX_TOTAL_MATCHES) break;
    for (const resolved of resolveAnchor(input.db, anchor)) {
      if (candidates.length >= MAX_TOTAL_MATCHES) break;
      if (seenSymbolIds.has(resolved.symbol.id)) continue;
      seenSymbolIds.add(resolved.symbol.id);
      matches.push({
        term: anchor.term,
        path: resolved.symbol.filePath,
        symbol: resolved.symbol.localName,
        symbolId: resolved.symbol.id,
      });
      candidates.push(buildLiteralAnchorCandidate(resolved.symbol, anchor, resolved.reason));
    }
  }

  if (matches.length === 0) return { used: false, terms: anchors.map((a) => a.term), matches: [], candidates: [] };
  return { used: true, terms: anchors.map((a) => a.term), matches, candidates };
}

// --- anchor extraction --------------------------------------------------------

// Extract only high-confidence anchors from the task. Each shape is unambiguous on
// its own (ALL-CAPS acronym, dunder, `--option`) or author-marked (backticks /
// quotes). Ordinary lowercase prose is never extracted unless quoted/backticked or
// option-shaped. Exception class names are excluded (the exception-symptom
// de-anchoring already handles that noise). Order-preserving, de-duplicated, capped.
export function extractLiteralAnchors(task: string): LiteralAnchor[] {
  const out: LiteralAnchor[] = [];
  const seen = new Set<string>();
  const push = (term: string, kind: LiteralAnchorKind): void => {
    const trimmed = term.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    if (isExceptionName(trimmed)) return;
    seen.add(trimmed);
    out.push({ term: trimmed, kind });
  };

  // (1) Backticked / quoted code-like literals (author-marked → highest confidence).
  // Includes snake_case config names, dotted names, file/format tokens, options.
  for (const m of task.matchAll(/[`'"]([^`'"\n]+)[`'"]/g)) {
    const inner = (m[1] ?? "").trim();
    const kind = classifyLiteral(inner);
    if (kind !== undefined) push(inner, kind);
  }
  // (2) CLI / config options: --ignore-paths, --some-option.
  for (const m of task.matchAll(/(?<![\w-])--[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b/g)) {
    push(m[0], "option");
  }
  // (3) Dunder names: __array_function__, __set_name__.
  for (const m of task.matchAll(/(?<![\w])__[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*__(?![\w])/g)) {
    const term = m[0];
    if (!GENERIC_DUNDERS.has(term)) push(term, "dunder");
  }
  // (4) ALL-CAPS acronyms (letters only, length >= 3): FITS, CDS, MRT.
  for (const m of task.matchAll(/\b[A-Z]{3,}\b/g)) {
    const term = m[0];
    if (term.length >= MIN_ACRONYM_LENGTH && !GENERIC_ACRONYMS.has(term)) push(term, "acronym");
  }

  return out.slice(0, MAX_TERMS);
}

// Classify a quoted/backticked literal's inner text, or undefined if it is not
// code-like enough to anchor (multi-word prose, too short, or a generic token).
function classifyLiteral(inner: string): LiteralAnchorKind | undefined {
  if (inner.length === 0 || /\s/.test(inner)) return undefined;
  if (GENERIC_LITERAL_TOKENS.has(inner.toLowerCase())) return undefined;
  if (isExceptionName(inner)) return undefined;
  if (/^--[A-Za-z][\w-]*$/.test(inner)) return "option";
  if (/^__[A-Za-z][\w]*__$/.test(inner) && !GENERIC_DUNDERS.has(inner)) return "dunder";
  if (/^[A-Z]{3,}$/.test(inner) && !GENERIC_ACRONYMS.has(inner)) return "acronym";
  // An identifier / dotted name / snake_case / file or format token. The last
  // dotted segment must clear the length floor so a bare `a.b` is not an anchor.
  const last = inner.includes(".") ? inner.slice(inner.lastIndexOf(".") + 1) : inner;
  const codeLike = /^[A-Za-z_][\w.]*$/.test(inner) || /^[\w./-]+\.[A-Za-z0-9]+$/.test(inner);
  if (codeLike && last.length >= MIN_LITERAL_LENGTH) return "literal";
  return undefined;
}

// An exception/warning class name. Excluded as an anchor unless explicit path/symbol
// evidence surfaces it some other way — exception-symptom de-anchoring owns this noise.
function isExceptionName(term: string): boolean {
  const last = term.includes(".") ? term.slice(term.lastIndexOf(".") + 1) : term;
  return /(?:Error|Exception|Warning)$/.test(last);
}

// --- index resolution ---------------------------------------------------------

interface ResolvedAnchor {
  readonly symbol: SymbolRecord;
  /** How this symbol matched the anchor (for evidence wording). */
  readonly reason: string;
}

// Resolve an anchor to indexed production symbols via, in precedence order:
// exact symbol/local-name (incl. config/constant), a path-segment match, then a
// body-literal match. Capped to MAX_MATCHES_PER_TERM. Tests are excluded; the
// non-source down-rank runs downstream so docs/examples are never silently promoted.
function resolveAnchor(db: Database, anchor: LiteralAnchor): ResolvedAnchor[] {
  const out: ResolvedAnchor[] = [];
  const seen = new Set<string>();
  const want = anchor.term.toLowerCase();
  const segment = optionToSegment(anchor.term);
  // An ALL-CAPS acronym is high-signal ONLY as a format/path identifier or an
  // exact-case symbol (a class literally named `CDS`/`QDP`). Matching an acronym
  // case-INSENSITIVELY to a common lowercase identifier (a SQL/English word like
  // COUNT/WHEN/GROUP hitting a `count` method) or via a single short body-literal
  // token is pure noise, so the acronym branch is restricted to path-segment and
  // exact-case symbol matches. Author-marked literals, dunders, and options are
  // inherently distinctive and keep the broader case-insensitive + body matching.
  const isAcronym = anchor.kind === "acronym";

  const add = (symbol: SymbolRecord, reason: string): void => {
    if (out.length >= MAX_MATCHES_PER_TERM || seen.has(symbol.id)) return;
    if (isLikelyTestCandidate(symbol)) return;
    seen.add(symbol.id);
    out.push({ symbol, reason });
  };

  // Symbol-name / path-segment matches via the symbol index.
  for (const result of searchSymbols(db, {
    query: anchor.term,
    maxResults: MAX_SEARCH_RESULTS,
    enableTestAwareDownweighting: true,
  })) {
    if (out.length >= MAX_MATCHES_PER_TERM) break;
    const symbol = getSymbolById(db, result.symbolId);
    if (symbol === undefined) continue;
    const localLower = symbol.localName.toLowerCase();
    const nameMatches = isAcronym
      ? symbol.localName === anchor.term // exact case only for acronyms
      : localLower === want || localLower === segment;
    if (nameMatches) {
      add(symbol, CONFIG_KINDS.has(symbol.kind) ? "config/constant name" : "symbol name");
    } else if (pathSegments(symbol.filePath).has(segment)) {
      add(symbol, "path segment");
    }
  }

  // Exact body-literal match (a distinctive literal cited in the task appears in a
  // symbol's source body). Uses a precise quoted FTS expression; failures are inert.
  // Skipped for acronyms — a short all-caps token matches far too many bodies.
  if (!isAcronym && out.length < MAX_MATCHES_PER_TERM) {
    const expr = bodyLiteralExpr(anchor.term);
    if (expr !== undefined) {
      let rows: ReturnType<typeof searchBodyLiterals> = [];
      try {
        rows = searchBodyLiterals(db, expr, MAX_SEARCH_RESULTS);
      } catch {
        rows = [];
      }
      for (const row of rows) {
        if (out.length >= MAX_MATCHES_PER_TERM) break;
        const symbol = getSymbolById(db, row.symbol_id);
        if (symbol !== undefined) add(symbol, "body literal");
      }
    }
  }

  return out;
}

// The path segments of a file (directory names + basename without extension),
// lowercased — so the acronym `CDS` matches `astropy/units/format/cds.py`.
function pathSegments(filePath: string): Set<string> {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const out = new Set<string>();
  for (const raw of normalized.split("/")) {
    if (raw.length === 0) continue;
    const dot = raw.lastIndexOf(".");
    out.add(dot > 0 ? raw.slice(0, dot) : raw);
  }
  return out;
}

// The comparable segment form of an anchor: an option `--ignore-paths` compares as
// `ignore-paths` and (joined) `ignore_paths`; everything else is its lowercase self.
function optionToSegment(term: string): string {
  return term.replace(/^--/, "").toLowerCase();
}

// A precise FTS MATCH expression for a body-literal search: the anchor's alphanumeric
// tokens, each quoted and AND-ed (so a multi-token anchor cannot match on one common
// token). Undefined when no usable token remains.
function bodyLiteralExpr(term: string): string | undefined {
  const tokens = term
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return undefined;
  return tokens.map((t) => `"${t}"`).join(" AND ");
}

// --- candidate construction ----------------------------------------------------

function buildLiteralAnchorCandidate(
  symbol: SymbolRecord,
  anchor: LiteralAnchor,
  reason: string,
): HybridCandidate {
  const actionable = ACTIONABLE_KINDS.has(symbol.kind);
  return {
    symbolId: symbol.id,
    filePath: symbol.filePath,
    fqName: symbol.fqName,
    localName: symbol.localName,
    kind: symbol.kind,
    scores: {
      lexical: 1,
      fts: 1,
      tfidf: 1,
      bm25: 1,
      // A symbol-name pointer: an exact high-signal-literal hit is direct evidence,
      // the same way a title-symbol match is. Keeps it pivot-eligible and shields it
      // from the generic-lexical-decoy down-weight (which gates on symbol > 0).
      symbol: 1,
      path: 0,
      testToImpl: 0,
      bodyLiteral: 0,
      domain: 0,
      graph: 0,
      graphProximity: 0,
      centrality: 0,
      actionability: actionable ? 1 : 0,
      inDegree: 0,
      localEvidence: 1,
      hubPenalty: 0,
      actionabilityPenalty: 0,
      final: LITERAL_ANCHOR_FINAL,
    },
    sources: [HybridCandidateSource.Symbol],
    evidence: [`task mentions ${anchorNoun(anchor.kind)} \`${anchor.term}\` (${reason})`],
    matches: [],
  };
}

function anchorNoun(kind: LiteralAnchorKind): string {
  switch (kind) {
    case "acronym":
      return "high-signal literal";
    case "dunder":
      return "dunder anchor";
    case "option":
      return "option/config anchor";
    case "literal":
      return "high-signal literal";
  }
}
