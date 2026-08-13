// Title-symbol candidate anchoring.
//
// WHY THIS EXISTS
// ----------------
// The dominant candidate-generation gap in the cross-repo eval is: the problem
// TITLE names the important class/type/symbol, but that symbol never enters the
// candidate pool because a word mentioned in the BODY (e.g. "lambdify") or a
// generic decoy ("dict", "deprecation") dominates lexical ranking. The gold edit
// site is then absent from candidates and cannot be a pivot — no amount of
// re-ranking helps.
//
// This module is a general candidate GENERATOR (not a ranking change): it pulls
// symbol-shaped terms out of the title region, searches the index for production
// symbols bearing those names, and emits them as candidates carrying direct
// "title mentions `X`" evidence. The caller merges them into the pool so the
// title's symbol is guaranteed a slot. Scoring is strong (an exact name match
// from the title is real evidence) but deliberately BELOW an explicit line anchor
// or a body-literal diagnostic match, so those keep priority.
//
// It hardcodes no repo rules and no instance ids — terms come from the title shape
// and resolve against the index alone.

import type { Database } from "bun:sqlite";

import { getSymbolById } from "../db/repositories/symbolsRepository";
import { SymbolKind, type SymbolRecord } from "../domain/types";
import {
  HybridCandidateSource,
  type HybridCandidate,
} from "../retrieval/hybridRetrieval";
import { searchSymbols } from "../retrieval/searchSymbols";
import { isLikelyTestCandidate } from "../retrieval/searchSymbolsShared";

// Synthesized final score for a title-symbol candidate. Below the line-anchor
// lead (3) and below a strong body-literal diagnostic match, but clearly above
// normal lexical/graph expansion so an exact title-named symbol reliably enters
// the top of the pool. NOT a forced pivot — it competes on this score.
export const TITLE_SYMBOL_FINAL = 2.5;

const ACTIONABLE_KINDS: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Class,
]);

// Per-term and overall caps — recover the title's symbol without flooding the pool.
const MAX_MATCHES_PER_TERM = 3;
const MAX_TOTAL_MATCHES = 6;
const MAX_SEARCH_RESULTS = 8;
const MIN_TERM_LENGTH = 3;

// Generic words that take a symbol shape but carry no edit-target signal. Small
// and conservative; the shape filters already exclude most prose.
const GENERIC_TITLE_TERMS: ReadonlySet<string> = new Set([
  "true", "false", "none", "null", "self", "cls", "type", "object", "value",
  "error", "bug", "issue", "test", "tests", "todo", "note", "warning",
]);

export interface TitleSymbolMatch {
  /** The title term that matched (e.g. "PythonCodePrinter"). */
  readonly term: string;
  readonly path: string;
  readonly symbol: string;
  readonly symbolId: string;
}

export interface TitleSymbolResult {
  readonly used: boolean;
  /** Symbol-shaped terms extracted from the title (after filtering). */
  readonly terms: string[];
  /** The production symbols those terms resolved to. */
  readonly matches: TitleSymbolMatch[];
  /** Candidates to merge into the pool (one per match). */
  readonly candidates: HybridCandidate[];
}

const EMPTY: TitleSymbolResult = { used: false, terms: [], matches: [], candidates: [] };

export interface TitleSymbolInput {
  readonly db: Database;
  readonly task: string;
}

// Recover candidates for the symbols named in the task TITLE. Pure with respect to
// the index: extract terms, resolve them to indexed production symbols, emit one
// candidate per resolved symbol.
export function anchorTitleSymbols(input: TitleSymbolInput): TitleSymbolResult {
  const terms = extractTitleSymbolTerms(extractTitleText(input.task));
  if (terms.length === 0) return EMPTY;

  const matches: TitleSymbolMatch[] = [];
  const candidates: HybridCandidate[] = [];
  const seenSymbolIds = new Set<string>();

  for (const term of terms) {
    if (candidates.length >= MAX_TOTAL_MATCHES) break;
    for (const symbol of resolveTermToSymbols(input.db, term)) {
      if (candidates.length >= MAX_TOTAL_MATCHES) break;
      if (seenSymbolIds.has(symbol.id)) continue;
      seenSymbolIds.add(symbol.id);
      matches.push({ term, path: symbol.filePath, symbol: symbol.localName, symbolId: symbol.id });
      candidates.push(buildTitleSymbolCandidate(symbol, term));
    }
  }

  if (matches.length === 0) return { used: false, terms, matches: [], candidates: [] };
  return { used: true, terms, matches, candidates };
}

// --- title text + term extraction --------------------------------------------

// The title region: the first line, and within it the part before the em/en-dash
// the fixture builder uses to join "Title — first sentence". For a raw problem
// statement (no dash) this is the whole first line. Higher-confidence than the body.
export function extractTitleText(task: string): string {
  const firstLine = (task.split(/\r?\n/)[0] ?? "").trim();
  const beforeDash = firstLine.split(/\s+[—–]\s+/)[0] ?? firstLine;
  return beforeDash.trim();
}

// Extract symbol-shaped terms from the title: backticked/quoted identifiers,
// multi-hump CamelCase, snake_case, SCREAMING_CONSTANT, and Class.method. Generic
// words and exception names (handled by de-anchoring) are filtered out. Ordinary
// prose words (single Capitalized words, lowercase words) are NOT terms.
export function extractTitleSymbolTerms(title: string): string[] {
  const out = new Set<string>();
  // A quoted/backticked identifier was MARKED as a symbol by the author, so it
  // bypasses the shape requirement (a single Capitalized word like `Config` or
  // `Permutation` counts); a shape-derived term must look like a symbol on its own.
  const add = (raw: string, quoted: boolean): void => {
    const term = raw.trim();
    if (isTitleSymbolTerm(term, quoted)) out.add(term);
  };

  // (1) Explicitly quoted / backticked identifiers.
  for (const m of title.matchAll(/[`'"]([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*)[`'"]/g)) {
    add(m[1]!, true);
  }
  // (2) CamelCase with >=2 humps: PythonCodePrinter, BadNamesTuple, FilenameUniqDict.
  for (const m of title.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g)) add(m[0], false);
  // (3) Class.method / Class.attr: ModelAdmin.get_inlines.
  for (const m of title.matchAll(/\b[A-Z][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\b/g)) add(m[0], false);
  // (4) snake_case (>=1 underscore, lowercase): get_inline_instances, regexp_csv.
  for (const m of title.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) add(m[0], false);
  // (5) SCREAMING_CONSTANT (>=1 underscore, upper): MAX_LENGTH, DEFAULT_TIMEOUT.
  for (const m of title.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) add(m[0], false);

  return [...out];
}

// A term is a usable title symbol when it is long enough, not a generic word, and
// not an exception name (those tokenise into symptom nouns the de-anchoring layer
// already handles — searching the exception class anchors on the symptom, not the
// cause). A bare (unquoted) term must additionally LOOK like a symbol (a hump,
// underscore, dot, or SCREAMING shape) so ordinary Capitalized prose is excluded.
function isTitleSymbolTerm(term: string, quoted: boolean): boolean {
  const last = term.includes(".") ? term.slice(term.lastIndexOf(".") + 1) : term;
  if (last.length < MIN_TERM_LENGTH) return false;
  if (GENERIC_TITLE_TERMS.has(term.toLowerCase()) || GENERIC_TITLE_TERMS.has(last.toLowerCase())) return false;
  if (/(?:Error|Exception|Warning)$/.test(term)) return false;
  if (quoted) return true;
  return /[._]/.test(term) || /[a-z][A-Z]/.test(term) || /^[A-Z][A-Z0-9_]+$/.test(term);
}

// --- index resolution ---------------------------------------------------------

// Resolve a title term to indexed PRODUCTION symbols bearing that name. A bare term
// matches a symbol whose local name equals it; a `Class.method` term matches the
// method under that class (and, failing that, the class itself).
function resolveTermToSymbols(db: Database, term: string): SymbolRecord[] {
  if (term.includes(".")) {
    const [classPart, memberPart] = splitDotted(term);
    const members = matchByLocalName(db, memberPart).filter((s) =>
      parentClassNameMatches(db, s, classPart),
    );
    if (members.length > 0) return members.slice(0, MAX_MATCHES_PER_TERM);
    // Fall back to the class itself (its method neighbourhood is the edit site).
    return matchByLocalName(db, classPart).slice(0, MAX_MATCHES_PER_TERM);
  }
  return matchByLocalName(db, term).slice(0, MAX_MATCHES_PER_TERM);
}

// Indexed non-test symbols whose LOCAL NAME equals `name` (case-sensitive first,
// then a case-insensitive fallback), best search-rank first.
function matchByLocalName(db: Database, name: string): SymbolRecord[] {
  const out: SymbolRecord[] = [];
  const seen = new Set<string>();
  const lower = name.toLowerCase();
  for (const result of searchSymbols(db, {
    query: name,
    maxResults: MAX_SEARCH_RESULTS,
    enableTestAwareDownweighting: true,
  })) {
    if (seen.has(result.symbolId)) continue;
    if (result.localName !== name && result.localName.toLowerCase() !== lower) continue;
    const symbol = getSymbolById(db, result.symbolId);
    if (symbol === undefined || isLikelyTestCandidate(symbol)) continue;
    seen.add(result.symbolId);
    out.push(symbol);
  }
  return out;
}

function parentClassNameMatches(db: Database, symbol: SymbolRecord, className: string): boolean {
  if (symbol.parentSymbolId === undefined) return false;
  const parent = getSymbolById(db, symbol.parentSymbolId);
  return parent !== undefined && parent.localName === className;
}

function splitDotted(term: string): [string, string] {
  const idx = term.lastIndexOf(".");
  return [term.slice(0, idx), term.slice(idx + 1)];
}

// --- candidate construction ---------------------------------------------------

// A title-injected candidate asserts exactly ONE thing: the title names this
// symbol, exactly. That is a `symbol` (name-identity) match and nothing else.
//
// It used to also claim `lexical`/`fts`/`tfidf`/`bm25` = 1 — the maximum of four
// MEASURED retrieval quantities that were never measured for it, because the
// premise of the injection is that retrieval did not produce this candidate. The
// role gate and the decoy classifier read those fields and were being told the
// candidate had the strongest possible lexical match in the pool. M143 §13
// forbids replacing the organic scorecard with synthesized values; a component
// vtrace did not measure reports 0, not 1.
function buildTitleSymbolCandidate(symbol: SymbolRecord, term: string): HybridCandidate {
  const actionable = ACTIONABLE_KINDS.has(symbol.kind);
  return {
    symbolId: symbol.id,
    filePath: symbol.filePath,
    fqName: symbol.fqName,
    localName: symbol.localName,
    kind: symbol.kind,
    scores: {
      lexical: 0,
      fts: 0,
      tfidf: 0,
      bm25: 0,
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
      final: TITLE_SYMBOL_FINAL,
    },
    sources: [HybridCandidateSource.Symbol],
    evidence: [`title mentions symbol-like term \`${term}\``],
    matches: [],
  };
}
