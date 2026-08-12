// Direct-evidence candidate anchoring (M96).
//
// WHY THIS EXISTS
// ----------------
// The M96 candidate-pool gap audit found that the dominant remaining retrieval
// failure is gold files TRULY ABSENT from the 25-candidate pool (dev 16/28 gold
// files) — plus in-pool gold squeezed out of the capsule by the standard tier's
// pivot/support caps. In most recoverable cases the issue text names the edit
// site in a shape none of the existing lanes resolves:
//
//   - a dotted module path ("utils.numberformat.format",
//     "contrib.auth.forms.UserCreationForm") — never mapped to a file;
//   - an explicit file token ("validators.py") outside quoted/anchored contexts;
//   - a bare file-stem word ("autoreload", "inspectdb", "contour");
//   - a mid-sentence capitalized class word ("Count") or a mixed-case code
//     identifier ("kernS") that plain lexical ranking treats as prose.
//
// This module is a general candidate GENERATOR + a bounded booster, following
// the title-symbol / literal-anchor pattern: extract only exact, low-ambiguity
// code mentions from the task, resolve them against the INDEX (never against
// derived/hypothetical paths — the M95-rejected `likelyFiles` expansion polluted
// the pool precisely because it skipped index verification), and emit one
// candidate per resolved symbol. The caller merges fresh candidates into the
// pool and boosts candidates already there.
//
// Two confidence tiers:
//   - STRONG (anchor-grade, like a title-symbol match): dotted module paths and
//     explicit file tokens — the author wrote a near-path to the edit file.
//   - WEAK (competitive, never anchor-grade): stems / class words / mixed-case
//     identifiers — real signals, but they must not override multi-signal
//     retrieval, join the anchor evidence tier, or disable pivot-ranking v2.
//
// Conservative by construction: exact index matches only, per-shape ambiguity
// caps, a generic-word stoplist, per-lane and overall candidate caps, and no
// repo rules or instance ids anywhere.

import type { Database } from "bun:sqlite";

import { listAllFilePaths } from "../db/repositories/filesRepository";
import { listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { SymbolKind, type SymbolRecord } from "../domain/types";
import {
  HybridCandidateSource,
  type HybridCandidate,
} from "../retrieval/hybridRetrieval";
import { GENERIC_TOKEN_STOPLIST, RUNNER_SCRIPTS } from "../capsule/sweQueryShaping";
import { GENERIC_INFRA_TOKENS } from "./genericLexicalDecoy";

/** Synthesized final for a STRONG mention — anchor tier (same as title/literal). */
export const DIRECT_EVIDENCE_STRONG_FINAL = 2.5;
/**
 * Synthesized final for a WEAK mention — competitive with ordinary retrieval
 * (typical pool finals run ~1.2–2.2) but clearly below the anchor tier, so a
 * stem/class-word candidate can enter the pool and the capsule without
 * automatically out-ranking a multi-signal edit target.
 */
export const DIRECT_EVIDENCE_WEAK_FINAL = 1.9;

const ACTIONABLE_KINDS: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Class,
]);

// Ambiguity caps: how many exact index matches a mention may have before it is
// rejected as too common to be evidence.
const MAX_DOTTED_FILE_MATCHES = 2;
const MAX_EXPLICIT_FILE_MATCHES = 3;
const MAX_STEM_FILE_MATCHES = 2;
const MAX_WORD_SYMBOL_MATCHES = 2;
const MAX_CLASS_WORD_MATCHES = 5;

// Candidate caps: recover the named site without flooding the pool.
const MAX_FILE_MENTIONS = 3;
const MAX_SYMBOLS_PER_FILE = 2;
const MAX_WEAK_CANDIDATES = 5;
const MAX_TOTAL_CANDIDATES = 8;

const MIN_STEM_LENGTH = 4;
const MIN_WORD_SYMBOL_LENGTH = 5;
const MIN_CLASS_WORD_LENGTH = 4;

// Generic vocabulary that must never anchor on its own, even when it happens to
// resolve exactly (an `error.py` or a `query` method exists in most codebases).
// Union of the query-shaping stoplist, the generic-infrastructure decoy tokens
// (so this lane can never re-arm a decoy the suppressor just weakened — e.g.
// `deprecation` → `deprecation.py`), and capsule-wide generic terms; matching
// is exact whole-token, so compound names (`error_functions`) are untouched.
const GENERIC_WORDS: ReadonlySet<string> = new Set([
  ...GENERIC_TOKEN_STOPLIST,
  ...GENERIC_INFRA_TOKENS,
  "group", "field", "fields", "object", "objects", "type", "types", "test",
  "tests", "value", "values", "result", "results", "data", "file", "files",
  "path", "paths", "request", "response", "model", "models", "query", "queries",
  "node", "nodes", "item", "items", "parser", "manager", "handler", "wrapper",
  "base", "utils", "util", "true", "false", "none", "null", "self", "cls",
  "main", "index", "string", "text", "line", "lines", "list", "dict", "print",
  "input", "output", "using", "used", "when", "with", "this", "that", "from",
  "have", "does", "case", "code", "call", "calls", "name", "names", "version",
  "python", "setup",
  // Artifact-category prose is useful to compound retrieval as a clause, but a
  // bare category is not an exact pointer to one same-named file. Treating
  // "schemas" or "client" as a file stem can resolve to only one or two files
  // by accident and inject an unrelated weak candidate ahead of the organic
  // pool (for example, a request asking to trace all schemas and client types).
  "schema", "schemas", "migration", "migrations", "projection", "projections",
  "client", "clients", "doc", "docs", "documentation", "openapi",
]);

// Basenames that exist everywhere; an exact match is packaging, not evidence.
const GENERIC_BASENAMES: ReadonlySet<string> = new Set([
  "__init__.py", "__main__.py", "conftest.py", "setup.py",
]);

// Dotted mentions ending in a web TLD are link fragments, not module paths.
const URL_TAIL_SEGMENTS: ReadonlySet<string> = new Set([
  "org", "com", "net", "edu", "gov",
]);

export type DirectEvidenceMentionType =
  | "dotted_module_path"
  | "explicit_file"
  | "file_stem_word"
  | "class_word"
  | "mixed_case_identifier";

export type DirectEvidenceTier = "strong" | "weak";

export interface DirectEvidenceMention {
  readonly term: string;
  readonly type: DirectEvidenceMentionType;
}

export interface DirectEvidenceMatch {
  readonly term: string;
  readonly type: DirectEvidenceMentionType;
  readonly tier: DirectEvidenceTier;
  readonly path: string;
  readonly symbol: string;
  readonly symbolId: string;
  /** How the mention resolved (for evidence wording / diagnostics). */
  readonly reason: string;
}

export interface DirectEvidenceResult {
  readonly used: boolean;
  /** All extracted mentions (after shape filtering, before resolution). */
  readonly mentions: DirectEvidenceMention[];
  /** The indexed production symbols the mentions resolved to. */
  readonly matches: DirectEvidenceMatch[];
  /** Candidates, one per match; the caller injects or boosts by symbol id. */
  readonly candidates: HybridCandidate[];
  /** Symbol ids of STRONG-tier matches (anchor-grade precedence). */
  readonly strongSymbolIds: Set<string>;
  /** Mentions dropped because they matched too many files/symbols. */
  readonly rejectedAmbiguousCount: number;
  /** Mentions dropped by the generic-word stoplist. */
  readonly rejectedGenericCount: number;
}

const EMPTY: DirectEvidenceResult = {
  used: false,
  mentions: [],
  matches: [],
  candidates: [],
  strongSymbolIds: new Set(),
  rejectedAmbiguousCount: 0,
  rejectedGenericCount: 0,
};

export interface DirectEvidenceInput {
  readonly db: Database;
  readonly task: string;
  /**
   * Lowercase task terms the request grammar allows to claim an EXACT symbol-name
   * reading (M142 §10). Only the bare-word → top-level-symbol resolution consults
   * it; every file-shaped resolution is corroborated by a file that actually
   * exists and is unaffected.
   *
   * Omitted means "no grammar supplied", which keeps the pre-M142 reading. The
   * product path always supplies it.
   */
  readonly exactNameEligibleTerms?: ReadonlySet<string>;
}

// Recover candidates for the exact code mentions in the task. Pure with respect
// to the index: extract mentions, resolve each against indexed files/symbols,
// emit one candidate per resolved symbol.
export function anchorDirectEvidence(input: DirectEvidenceInput): DirectEvidenceResult {
  const extraction = extractDirectEvidenceMentions(input.task);
  if (extraction.mentions.length === 0) {
    return extraction.rejectedGeneric > 0
      ? { ...EMPTY, rejectedGenericCount: extraction.rejectedGeneric }
      : EMPTY;
  }

  const index = new RepoIndexView(input.db);
  const matches: DirectEvidenceMatch[] = [];
  const candidates: HybridCandidate[] = [];
  const strongSymbolIds = new Set<string>();
  const seenSymbolIds = new Set<string>();
  let rejectedAmbiguous = 0;
  let weakCount = 0;
  let fileMentionCount = 0;

  const admit = (resolved: ResolvedMention): void => {
    for (const entry of resolved.symbols) {
      if (candidates.length >= MAX_TOTAL_CANDIDATES) return;
      if (resolved.tier === "weak" && weakCount >= MAX_WEAK_CANDIDATES) return;
      if (seenSymbolIds.has(entry.symbol.id)) continue;
      seenSymbolIds.add(entry.symbol.id);
      if (resolved.tier === "weak") weakCount += 1;
      if (resolved.tier === "strong") strongSymbolIds.add(entry.symbol.id);
      matches.push({
        term: resolved.mention.term,
        type: resolved.mention.type,
        tier: resolved.tier,
        path: entry.symbol.filePath,
        symbol: entry.symbol.localName,
        symbolId: entry.symbol.id,
        reason: entry.reason,
      });
      candidates.push(buildDirectEvidenceCandidate(entry.symbol, resolved, entry.reason));
    }
  };

  for (const mention of extraction.mentions) {
    if (candidates.length >= MAX_TOTAL_CANDIDATES) break;
    const isFileMention = mention.type === "dotted_module_path" || mention.type === "explicit_file";
    if (isFileMention && fileMentionCount >= MAX_FILE_MENTIONS) continue;
    const resolved = resolveMention(mention, index, input.task, input.exactNameEligibleTerms);
    if (resolved === "ambiguous") {
      rejectedAmbiguous += 1;
      continue;
    }
    if (resolved === undefined) continue;
    if (isFileMention) fileMentionCount += 1;
    admit(resolved);
  }

  if (matches.length === 0) {
    return {
      ...EMPTY,
      mentions: extraction.mentions,
      rejectedAmbiguousCount: rejectedAmbiguous,
      rejectedGenericCount: extraction.rejectedGeneric,
    };
  }
  return {
    used: true,
    mentions: extraction.mentions,
    matches,
    candidates,
    strongSymbolIds,
    rejectedAmbiguousCount: rejectedAmbiguous,
    rejectedGenericCount: extraction.rejectedGeneric,
  };
}

// --- mention extraction ---------------------------------------------------------

interface Extraction {
  mentions: DirectEvidenceMention[];
  rejectedGeneric: number;
}

// Extract exact code mentions from the task, strongest shape first (dotted
// module paths, explicit files, then class words / mixed-case identifiers /
// file stems). Order matters: candidate caps admit the strongest evidence
// before the circumstantial shapes. URLs are stripped so link tails never
// masquerade as module paths.
export function extractDirectEvidenceMentions(task: string): Extraction {
  const text = task.replace(/\bhttps?:\/\/\S+/gi, " ");
  const mentions: DirectEvidenceMention[] = [];
  const seen = new Set<string>();
  let rejectedGeneric = 0;

  const push = (term: string, type: DirectEvidenceMentionType): void => {
    const t = term.trim();
    const key = `${type}|${t}`;
    if (t.length === 0 || seen.has(key)) return;
    seen.add(key);
    mentions.push({ term: t, type });
  };

  // (1) Dotted module paths: >=2 identifier segments, each >=2 chars, at least
  // one lowercase-start segment (a pure Class.attr chain belongs to the title
  // lane), and not a URL tail.
  for (const m of text.matchAll(/\b[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+\b/g)) {
    const segments = m[0].split(".");
    if (segments.length < 2) continue;
    if (segments.some((s) => s.length < 2)) continue;
    if (!segments.some((s) => /^[a-z_]/.test(s))) continue;
    if (URL_TAIL_SEGMENTS.has(segments[segments.length - 1]!.toLowerCase())) continue;
    if (segments[0] === "self" || segments[0] === "cls") continue;
    push(m[0], "dotted_module_path");
  }

  // (2) Explicit .py file tokens (bare or pathed), minus runner scripts and
  // ubiquitous basenames.
  for (const m of text.matchAll(/\b[\w./-]+\.py\b/g)) {
    const token = m[0].replace(/^[ab]\//, "");
    const basename = token.slice(token.lastIndexOf("/") + 1).toLowerCase();
    if (GENERIC_BASENAMES.has(basename)) continue;
    if (!token.includes("/") && RUNNER_SCRIPTS.has(basename)) continue;
    push(token, "explicit_file");
  }

  // (3) Mid-sentence capitalized class words ("a Count annotation"). A
  // sentence-initial capital is ordinary prose; a mid-sentence one is a proper
  // noun or a code name. Multi-hump CamelCase belongs to the title/identifier
  // lanes; this shape is the single-hump word they all skip.
  for (const m of text.matchAll(/\b[A-Z][a-z0-9]+\b/g)) {
    const term = m[0];
    if (term.length < MIN_CLASS_WORD_LENGTH) continue;
    if (!isMidSentence(text, m.index ?? 0)) continue;
    if (/(?:Error|Exception|Warning)$/.test(term)) continue;
    if (GENERIC_WORDS.has(term.toLowerCase())) {
      rejectedGeneric += 1;
      continue;
    }
    push(term, "class_word");
  }

  // (4) Mixed-case code identifiers ("kernS", "getLogger") — an internal case
  // flip never occurs in English prose, so the shape alone marks code.
  for (const m of text.matchAll(/\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g)) {
    const term = m[0];
    if (term.length < MIN_CLASS_WORD_LENGTH) continue;
    if (/(?:Error|Exception|Warning)$/.test(term)) continue;
    push(term, "mixed_case_identifier");
  }

  // (5) Bare lowercase words — candidate file stems ("autoreload") or top-level
  // symbol names ("session"). The weakest shape: heavily stoplisted here and
  // ambiguity-capped at resolution.
  for (const m of text.matchAll(/\b[a-z][a-z0-9_]{3,}\b/g)) {
    const term = m[0];
    if (term.length < MIN_STEM_LENGTH) continue;
    if (GENERIC_WORDS.has(term)) {
      rejectedGeneric += 1;
      continue;
    }
    push(term, "file_stem_word");
  }

  return { mentions, rejectedGeneric };
}

// True when the capitalized word at `index` is not the start of a sentence /
// line / quotation: the nearest preceding non-space character exists and is a
// word character, comma, or closing bracket.
function isMidSentence(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = text[i]!;
    if (ch === " " || ch === "\t") continue;
    return /[\w,)\]]/.test(ch);
  }
  return false;
}

// --- index resolution -------------------------------------------------------------

// A cached view of the repo index, loaded once per anchoring pass: all file
// paths (for stem/suffix matching) and lazy per-file symbol lists.
class RepoIndexView {
  private readonly db: Database;
  readonly filePaths: string[];
  private readonly symbolsByFile = new Map<string, SymbolRecord[]>();

  constructor(db: Database) {
    this.db = db;
    this.filePaths = listAllFilePaths(this.db);
  }

  symbolsFor(filePath: string): SymbolRecord[] {
    const cached = this.symbolsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const symbols = listSymbolsForFile(this.db, filePath);
    this.symbolsByFile.set(filePath, symbols);
    return symbols;
  }

  /** Non-test files whose basename equals `basename` exactly. */
  filesWithBasename(basename: string): string[] {
    return this.filePaths.filter(
      (p) => p.slice(p.lastIndexOf("/") + 1) === basename && !isTestPath(p),
    );
  }

  /** Non-test files matching `relPath` exactly or as a path suffix. */
  filesWithSuffix(relPath: string): string[] {
    return this.filePaths.filter(
      (p) => (p === relPath || p.endsWith(`/${relPath}`)) && !isTestPath(p),
    );
  }
}

function isTestPath(filePath: string): boolean {
  return /(^|\/)tests?\//.test(filePath) || /(^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(filePath);
}

interface ResolvedSymbol {
  readonly symbol: SymbolRecord;
  readonly reason: string;
}

interface ResolvedMention {
  readonly mention: DirectEvidenceMention;
  readonly tier: DirectEvidenceTier;
  readonly symbols: ResolvedSymbol[];
}

function resolveMention(
  mention: DirectEvidenceMention,
  index: RepoIndexView,
  task: string,
  exactNameEligibleTerms: ReadonlySet<string> | undefined,
): ResolvedMention | "ambiguous" | undefined {
  switch (mention.type) {
    case "dotted_module_path":
      return resolveDottedModulePath(mention, index, task);
    case "explicit_file":
      return resolveExplicitFile(mention, index, task);
    case "class_word":
      return resolveClassWord(mention, index);
    case "mixed_case_identifier":
      return resolveMixedCaseIdentifier(mention, index);
    case "file_stem_word":
      return resolveFileStemWord(mention, index, task, exactNameEligibleTerms);
  }
}

// Resolve a dotted module path by its longest >=2-segment prefix that names an
// indexed file (`a.b.c` -> `a/b/c.py` | `a/b/__init__.py`, then `a/b.py` with
// `c` as a symbol drill). Requiring two consumed segments keeps stdlib chains
// (`inspect.signature`) and attribute chains from resolving via a bare-stem
// coincidence.
function resolveDottedModulePath(
  mention: DirectEvidenceMention,
  index: RepoIndexView,
  task: string,
): ResolvedMention | "ambiguous" | undefined {
  const segments = mention.term.split(".");
  for (let take = segments.length; take >= 2; take -= 1) {
    const rel = `${segments.slice(0, take).join("/")}.py`;
    const pkg = `${segments.slice(0, take).join("/")}/__init__.py`;
    const moduleFiles = index.filesWithSuffix(rel);
    const pkgFiles = index.filesWithSuffix(pkg);
    const files = [...new Set([...moduleFiles, ...pkgFiles])];
    if (files.length === 0) continue;
    if (files.length > MAX_DOTTED_FILE_MATCHES) return "ambiguous";
    const drill = segments.slice(take);
    const pkgSet = new Set(pkgFiles);
    const symbols = files.flatMap((file) => {
      // A package `__init__.py` match is only a pointer when the drill symbol
      // actually resolves inside it — a bare package name ("astropy.table") is
      // not an edit-file pointer, and a re-exported name whose definition lives
      // elsewhere must not promote a random top-level symbol of the package.
      const requireDrill = pkgSet.has(file);
      return symbolsForResolvedFile(
        index, file, drill, task, MAX_SYMBOLS_PER_FILE, `module path \`${mention.term}\``,
        { drillRequired: requireDrill || drill.length > 0 },
      );
    });
    if (symbols.length === 0) return undefined;
    return { mention, tier: "strong", symbols };
  }
  return undefined;
}

// Resolve an explicit file token: a pathed token must match as an exact path
// suffix; a bare basename must match at most MAX_EXPLICIT_FILE_MATCHES files.
function resolveExplicitFile(
  mention: DirectEvidenceMention,
  index: RepoIndexView,
  task: string,
): ResolvedMention | "ambiguous" | undefined {
  const files = mention.term.includes("/")
    ? index.filesWithSuffix(mention.term)
    : index.filesWithBasename(mention.term);
  if (files.length === 0) return undefined;
  if (files.length > MAX_EXPLICIT_FILE_MATCHES) return "ambiguous";
  const symbols = files.flatMap((file) =>
    symbolsForResolvedFile(index, file, [], task, MAX_SYMBOLS_PER_FILE, `file \`${mention.term}\``),
  );
  if (symbols.length === 0) return undefined;
  return { mention, tier: "strong", symbols };
}

// Resolve a mid-sentence capitalized word to indexed CLASSES bearing that exact
// name (the Python naming convention a capitalized prose word implies).
function resolveClassWord(
  mention: DirectEvidenceMention,
  index: RepoIndexView,
): ResolvedMention | "ambiguous" | undefined {
  const matches: ResolvedSymbol[] = [];
  let total = 0;
  for (const path of index.filePaths) {
    if (isTestPath(path)) continue;
    for (const symbol of index.symbolsFor(path)) {
      if (symbol.kind !== SymbolKind.Class || symbol.localName !== mention.term) continue;
      total += 1;
      if (total > MAX_CLASS_WORD_MATCHES) return "ambiguous";
      if (matches.length < MAX_SYMBOLS_PER_FILE) {
        matches.push({ symbol, reason: `class name \`${mention.term}\`` });
      }
    }
  }
  if (matches.length === 0) return undefined;
  return { mention, tier: "weak", symbols: matches };
}

// Resolve a mixed-case identifier to indexed symbols with that exact name.
function resolveMixedCaseIdentifier(
  mention: DirectEvidenceMention,
  index: RepoIndexView,
): ResolvedMention | "ambiguous" | undefined {
  const matches: ResolvedSymbol[] = [];
  let total = 0;
  for (const path of index.filePaths) {
    if (isTestPath(path)) continue;
    for (const symbol of index.symbolsFor(path)) {
      if (symbol.localName !== mention.term) continue;
      if (!ACTIONABLE_KINDS.has(symbol.kind)) continue;
      total += 1;
      if (total > MAX_CLASS_WORD_MATCHES) return "ambiguous";
      if (matches.length < MAX_SYMBOLS_PER_FILE) {
        matches.push({ symbol, reason: `identifier \`${mention.term}\`` });
      }
    }
  }
  if (matches.length === 0) return undefined;
  return { mention, tier: "weak", symbols: matches };
}

// Resolve a bare lowercase word as (a) an exact file stem, else (b) an exact
// TOP-LEVEL function/class name.
//
// The top-level requirement was the whole distinctiveness bar: prose words
// coincide with method names constantly (`using`, `save`) but were assumed to
// coincide rarely with a module's top-level def. `which` disproved that (M142
// §19) — "…decide which Gaussian route keywords to emit" resolved the grammatical
// determiner to `arc/job/adapters/common.py::which` and handed it the synthesized
// WEAK final of 1.9, which was the strongest score in the pool.
//
// Branch (b) asserts "the task NAMES this symbol", and only the request grammar
// can license that assertion, so it now requires exact-symbol eligibility.
// Branch (a) asserts something different and independently corroborated — a file
// with that exact basename exists — and is deliberately left alone, so the M96
// stem recoveries (`autoreload`, `inspectdb`, `contour`) are untouched.
function resolveFileStemWord(
  mention: DirectEvidenceMention,
  index: RepoIndexView,
  task: string,
  exactNameEligibleTerms: ReadonlySet<string> | undefined,
): ResolvedMention | "ambiguous" | undefined {
  const files = index.filesWithBasename(`${mention.term}.py`);
  if (files.length > MAX_STEM_FILE_MATCHES) return "ambiguous";
  if (files.length > 0) {
    const symbols = files.flatMap((file) =>
      symbolsForResolvedFile(index, file, [], task, 1, `file stem \`${mention.term}\``),
    );
    if (symbols.length === 0) return undefined;
    return { mention, tier: "weak", symbols };
  }

  if (mention.term.length < MIN_WORD_SYMBOL_LENGTH) return undefined;
  if (
    exactNameEligibleTerms !== undefined
    && !exactNameEligibleTerms.has(mention.term.toLowerCase())
  ) {
    return undefined;
  }
  const matches: ResolvedSymbol[] = [];
  let total = 0;
  for (const path of index.filePaths) {
    if (isTestPath(path)) continue;
    for (const symbol of index.symbolsFor(path)) {
      if (symbol.localName !== mention.term) continue;
      if (symbol.parentSymbolId !== undefined) continue;
      if (symbol.kind !== SymbolKind.Function && symbol.kind !== SymbolKind.Class) continue;
      total += 1;
      if (total > MAX_WORD_SYMBOL_MATCHES) return "ambiguous";
      matches.push({ symbol, reason: `top-level symbol \`${mention.term}\`` });
    }
  }
  if (matches.length === 0) return undefined;
  return { mention, tier: "weak", symbols: matches };
}

// The symbols a resolved FILE contributes. A drill segment (the dotted path's
// tail) selects the exact symbol it names; otherwise prefer symbols whose name
// the task mentions, then top-level actionable symbols in source order.
function symbolsForResolvedFile(
  index: RepoIndexView,
  filePath: string,
  drill: readonly string[],
  task: string,
  cap: number,
  reason: string,
  options: { drillRequired?: boolean } = {},
): ResolvedSymbol[] {
  const symbols = index.symbolsFor(filePath);
  if (symbols.length === 0) return [];

  if (drill.length > 0) {
    const target = drill[0]!;
    const exact = symbols
      .filter((s) => s.localName === target && ACTIONABLE_KINDS.has(s.kind))
      .slice(0, cap);
    if (exact.length > 0) {
      return exact.map((symbol) => ({ symbol, reason: `${reason} → symbol \`${target}\`` }));
    }
  }
  // The mention named a symbol this file does not define (a re-export, or a
  // package with no such member) — falling back to unrelated representative
  // symbols would promote noise at anchor strength. Contribute nothing.
  if (options.drillRequired === true) return [];

  const taskTokens = new Set(
    (task.toLowerCase().match(/[a-z_][\w]*/g) ?? []).filter((t) => t.length >= 3),
  );
  const actionable = symbols.filter((s) => ACTIONABLE_KINDS.has(s.kind));
  const mentioned = actionable.filter((s) => taskTokens.has(s.localName.toLowerCase()));
  const topLevel = actionable.filter((s) => s.parentSymbolId === undefined);
  const ordered = [...new Set([...mentioned, ...topLevel, ...actionable])];
  return ordered.slice(0, cap).map((symbol) => ({ symbol, reason }));
}

// --- candidate construction --------------------------------------------------------

function buildDirectEvidenceCandidate(
  symbol: SymbolRecord,
  resolved: ResolvedMention,
  reason: string,
): HybridCandidate {
  const actionable = ACTIONABLE_KINDS.has(symbol.kind);
  const strong = resolved.tier === "strong";
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
      // A file-resolved mention is a path pointer ("in a likely edit file");
      // a symbol-resolved mention is a symbol pointer. Either keeps the
      // candidate pivot-eligible and shields it from the generic-lexical-decoy
      // down-weight (which gates on a direct pointer).
      symbol: strong ? 0 : 1,
      path: strong ? 1 : 0,
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
      final: strong ? DIRECT_EVIDENCE_STRONG_FINAL : DIRECT_EVIDENCE_WEAK_FINAL,
    },
    sources: [HybridCandidateSource.Symbol],
    evidence: [`task names ${reason} (direct evidence, ${resolved.tier})`],
    matches: [],
  };
}

/**
 * Apply a bounded direct-evidence boost to a candidate that is ALREADY in the
 * pool: floor its final at the tier score, add the matching direct pointer
 * (path for file-resolved mentions, symbol otherwise), and floor localEvidence
 * so the role gate sees the pointer. Everything else is preserved — this is a
 * promotion of an existing candidate, never a rescore of the pool.
 *
 * The boosted final buys BUDGET competition (a support slot, a pivot slot when
 * one is free) — the WEAK tier's lead protection lives in pivot ORDERING, where
 * weak-lane candidates always rank behind organically-evidenced pivots (see the
 * weak-rank keys in buildCapsuleV2 / capPivots), so a circumstantial mention
 * can never steal the lead from multi-signal retrieval.
 */
export function boostScoresForDirectEvidence(
  scores: HybridCandidate["scores"],
  match: DirectEvidenceMatch,
): HybridCandidate["scores"] {
  const tierFinal = match.tier === "strong" ? DIRECT_EVIDENCE_STRONG_FINAL : DIRECT_EVIDENCE_WEAK_FINAL;
  const fileResolved = match.type === "dotted_module_path" || match.type === "explicit_file";
  return {
    ...scores,
    path: fileResolved ? Math.max(scores.path, 1) : scores.path,
    symbol: fileResolved ? scores.symbol : Math.max(scores.symbol, 1),
    localEvidence: Math.max(scores.localEvidence, 1),
    // Preserve an upstream contrast penalty when a later direct-evidence lane
    // floors the candidate at its confidence tier.
    final: Math.max(scores.final, tierFinal - (scores.contrastPenalty ?? 0)),
  };
}

/**
 * Ordering metadata for the WEAK tier: which pool candidates owe their rank to
 * a weak direct-evidence mention, and what their ORGANIC final was before the
 * lane touched them (0 for freshly injected candidates). Pivot ordering ranks
 * every weak-lane candidate behind every organically-evidenced pivot, and weak
 * candidates among themselves by organic final — weak evidence fills gaps and
 * breaks ties; it never reorders organic evidence.
 */
export interface WeakDirectEvidenceOrdering {
  readonly symbolIds: ReadonlySet<string>;
  readonly organicFinalById: ReadonlyMap<string, number>;
}
