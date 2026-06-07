// Hybrid retrieval scoring.
//
// The legacy retrieval path exposes a single hand-written lexical score plus a
// shallow graph rerank bonus. A hybrid pipeline blends several INDEPENDENT
// signals — each measuring a different kind of relevance — so a candidate the
// lexical matcher under-ranks can still surface on path, symbol, graph, or
// centrality evidence.
//
// This module owns the score VOCABULARY: the per-candidate component breakdown,
// the deterministic BM25/TF-IDF scorer used for the `tfidf` component, and the
// weighting that folds the components into a single `final` score. Every score
// is normalised to [0, 1] WITHIN the candidate pool so the diagnostics read as
// comparable fractions (see Requirement 5's example) and the final score is a
// plain weighted sum — never a magic additive blob.

import { SymbolKind } from "../domain/types";
import { GENERIC_TOKEN_STOPLIST } from "../capsule/sweQueryShaping";

// The full component breakdown reported for every hybrid candidate. `fts` and
// `tfidf` are the two lexical sub-signals; `lexical` is their blend and is the
// value that actually feeds `final` (so lexical strength is not double-counted).
export interface HybridScoreComponents {
  /** Combined lexical strength (blend of `fts` and `tfidf`), in [0, 1]. */
  lexical: number;
  /** Normalised FTS5/heuristic lexical score from `searchSymbols`. */
  fts: number;
  /** Normalised BM25/TF-IDF score over the candidate-pool corpus. */
  tfidf: number;
  /**
   * Alias of `tfidf`, exposed under the scorecard vocabulary name (Requirement
   * 2). Same value; kept distinct so callers can read either name.
   */
  bm25: number;
  /** Normalised symbol-name match strength (exact/prefix on a likely symbol). */
  symbol: number;
  /** Normalised path/file match strength (candidate lives in a likely file). */
  path: number;
  /**
   * Normalised test-to-implementation strength: how strongly a FAILING TEST
   * reaches this candidate (imported by the test file, or called/asserted by the
   * test method). A first-class precision signal — not folded into `graph` —
   * because for a SWE task "the failing test exercises it" is the single best
   * predictor of the edit target. Counts toward local evidence.
   */
  testToImpl: number;
  /**
   * Normalised domain relevance: query terms (aggregate/Count/distinct/…) that
   * stem-match this candidate's path or name tokens. This is what ties an
   * aggregate-task query to `aggregates.py` even when no explicit likely-file was
   * surfaced. Counts toward local evidence.
   */
  domain: number;
  /** Normalised graph score (expansion depth + connection evidence). */
  graph: number;
  /**
   * Alias of `graph`, exposed under the scorecard vocabulary name (Requirement
   * 2): graph PROXIMITY to the working set, distinct from `centrality` (global
   * in-degree). Same value as `graph`.
   */
  graphProximity: number;
  /** Normalised graph centrality (in-degree within the working set). */
  centrality: number;
  /**
   * Edit-target actionability by symbol kind: 1 for function/method/class, 0 for
   * module-level variables/constants/aliases (rarely a micro edit target).
   */
  actionability: number;
  /** Raw count of indexed symbols that depend on this one (global in-degree). */
  inDegree: number;
  /**
   * Combined LOCAL relevance: the signals that tie a candidate to THIS task
   * (lexical above a floor, symbol-name, path, test-to-impl) — deliberately
   * excluding centrality and generic graph reach, which a hub has in abundance.
   */
  localEvidence: number;
  /**
   * Score subtracted from `final` when a generic high-centrality hub lacks local
   * evidence. 0 for everything else. Makes a downrank inspectable.
   */
  hubPenalty: number;
  /**
   * Score subtracted from `final` when a low-actionability module-level symbol
   * (a `compiler = '…'` config variable) rides graph/domain boosts without strong
   * direct evidence. 0 for everything else.
   */
  actionabilityPenalty: number;
  /**
   * Weighted sum of the components above, minus `hubPenalty` and
   * `actionabilityPenalty`; the ranking key.
   */
  final: number;
}

export interface HybridScoreWeights {
  readonly lexical: number;
  readonly symbol: number;
  readonly path: number;
  readonly domain: number;
  readonly testToImpl: number;
  readonly graph: number;
  readonly centrality: number;
}

// Weights are POLICY, kept named and out of the combine math. The defaults lean
// on test-to-implementation, symbol, and lexical evidence (the strongest
// precision signals for an exact SWE edit target) while letting path/domain/graph
// break ties and rescue candidates the lexical matcher missed. `centrality` is
// deliberately the WEAKEST: a generic framework hub must never win on reach
// alone (Requirement 2 — "centrality is weak and cannot win alone").
export const HYBRID_SCORE_WEIGHTS: HybridScoreWeights = Object.freeze({
  lexical: 1.0,
  symbol: 1.2,
  path: 0.8,
  domain: 0.9,
  // The failing test points STRAIGHT at the implementation; weight it highest.
  testToImpl: 1.3,
  graph: 1.0,
  centrality: 0.5,
});

// Blend the two lexical sub-signals into one. FTS/heuristic ranking is the
// primary lexical signal; BM25 is a corpus-aware corrective that rewards rarer,
// more discriminating term matches. Both are already in [0, 1].
const FTS_BLEND = 0.65;
const TFIDF_BLEND = 0.35;

export function blendLexical(fts: number, tfidf: number): number {
  return FTS_BLEND * fts + TFIDF_BLEND * tfidf;
}

// The subset of components that actually feed the final score. `fts`/`tfidf` are
// deliberately excluded: their strength is already carried by `lexical` (their
// blend), so including them here would double-count lexical evidence.
export interface FinalScoreComponents {
  lexical: number;
  symbol: number;
  path: number;
  domain: number;
  testToImpl: number;
  graph: number;
  centrality: number;
}

// Fold the (already normalised) components into the final ranking score.
export function combineFinalScore(
  components: FinalScoreComponents,
  weights: HybridScoreWeights = HYBRID_SCORE_WEIGHTS,
): number {
  return (
    weights.lexical * components.lexical
    + weights.symbol * components.symbol
    + weights.path * components.path
    + weights.domain * components.domain
    + weights.testToImpl * components.testToImpl
    + weights.graph * components.graph
    + weights.centrality * components.centrality
  );
}

// ----- hub penalty ------------------------------------------------------------
//
// A globally-central framework hub (django's `Model`, with ~1600 dependents) is
// almost never the edit target for a small/local task. Yet because centrality is
// normalised against the pool, such a hub pins centrality at 1.0 and can outrank
// a locally-relevant implementation that has real lexical/symbol/path evidence.
//
// The penalty fires ONLY when a candidate is a high-in-degree hub AND has no
// local evidence: weak lexical, no symbol-name match, no path match, and it was
// not surfaced by a failing test. In that case we strip exactly the graph +
// centrality contribution it was riding on, so it falls back to its (tiny) local
// score and sits below any genuinely-relevant target. Anything with local
// evidence — including the actual edit target, however central — is untouched.

// A candidate is a "hub" once this many indexed symbols depend on it. Modest on
// purpose: it only ever matters in combination with the no-local-evidence gate,
// and a real edit target at this in-degree still carries local evidence.
export const HUB_IN_DEGREE_THRESHOLD = 5;
// Below this normalised lexical score, lexical match is too weak to count as
// local evidence (django's `Model` scored 0.0329 against the aggregate query).
export const HUB_WEAK_LEXICAL_MAX = 0.1;

export interface HubEvaluationInput {
  /** Global in-degree (dependent count) of the candidate. */
  inDegree: number;
  /** Normalised lexical, symbol, path, domain components. */
  lexical: number;
  symbol: number;
  path: number;
  domain: number;
  /** Normalised test-to-implementation strength (0 when no failing test reaches it). */
  testToImpl: number;
  /** Whether a failing test imports/calls/references this candidate. */
  hasTestEvidence: boolean;
  /** Already-weighted graph and centrality contributions to strip on penalty. */
  graphContribution: number;
  centralityContribution: number;
}

export interface HubEvaluation {
  isHub: boolean;
  localEvidence: number;
  penalty: number;
}

export function evaluateHub(input: HubEvaluationInput): HubEvaluation {
  const lexicalLocal = input.lexical >= HUB_WEAK_LEXICAL_MAX ? input.lexical : 0;
  // Local evidence is everything that ties a candidate to THIS task — lexical,
  // symbol-name, path, issue-derived domain relevance, and being reached by a
  // FAILING TEST — but NOT generic graph reach or centrality.
  const localEvidence =
    lexicalLocal
    + input.symbol
    + input.path
    + input.domain
    + input.testToImpl;

  // The hub penalty stays STRICT: domain relevance alone does not exempt a
  // 1600-dependent framework hub. It must have direct lexical/symbol/path/test
  // evidence to escape the penalty.
  const isHub = input.inDegree >= HUB_IN_DEGREE_THRESHOLD;
  const lacksLocalEvidence =
    input.lexical < HUB_WEAK_LEXICAL_MAX
    && input.symbol <= 0
    && input.path <= 0
    && !input.hasTestEvidence;

  const penalty =
    isHub && lacksLocalEvidence
      ? input.graphContribution + input.centralityContribution
      : 0;

  return { isHub, localEvidence, penalty };
}

// ----- actionability penalty --------------------------------------------------
//
// Not every symbol is a plausible micro EDIT target. A module-level config
// variable like `compiler = 'SQLAggregateCompiler'` can ride a high graph/domain
// score yet is almost never the thing you edit to fix a behavioural bug — you
// edit a function/method/class. When such a low-actionability symbol lacks STRONG
// direct evidence (a symbol-name match, a path match, or strong lexical), strip
// the soft graph + domain boosts it was riding on, so an actionable target with
// real evidence outranks it.

// Symbol kinds that are low-actionability micro edit targets.
export const LOW_ACTIONABILITY_KINDS: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.ModuleVariable,
  SymbolKind.ModuleConstant,
  SymbolKind.ModuleAlias,
]);

// Lexical strong enough to justify a module-level symbol as a direct target.
export const STRONG_DIRECT_LEXICAL = 0.5;

export interface ActionabilityEvaluationInput {
  kind: SymbolKind;
  lexical: number;
  symbol: number;
  path: number;
  /** Already-weighted graph + domain contributions to strip on penalty. */
  graphContribution: number;
  domainContribution: number;
}

export interface ActionabilityEvaluation {
  /** 1 for actionable kinds (function/method/class), 0 for module-level. */
  actionability: number;
  penalty: number;
}

export function evaluateActionability(
  input: ActionabilityEvaluationInput,
): ActionabilityEvaluation {
  const lowActionability = LOW_ACTIONABILITY_KINDS.has(input.kind);
  const actionability = lowActionability ? 0 : 1;
  const hasStrongDirectEvidence =
    input.symbol > 0 || input.path > 0 || input.lexical >= STRONG_DIRECT_LEXICAL;
  const penalty =
    lowActionability && !hasStrongDirectEvidence
      ? input.graphContribution + input.domainContribution
      : 0;
  return { actionability, penalty };
}

// ----- domain relevance -------------------------------------------------------
//
// Reward candidates whose path or name tokens stem-match the query's CONTENT
// terms. For an aggregate task ("Count annotation … distinct … aggregation"),
// this lifts `django/db/models/aggregates.py` and a symbol named `Aggregate`
// even when no explicit likely-file was surfaced — generally, by token/path/name
// matching, never by hardcoding an instance id.

// Structural / boilerplate tokens that the shaped query injects ("failing
// tests:", "issue:", "files:") or that carry no domain signal. Kept small.
const DOMAIN_STOPWORDS: ReadonlySet<string> = new Set([
  "failing", "tests", "test", "issue", "issues", "file", "files", "symbol",
  "symbols", "repo", "the", "and", "for", "with", "that", "this", "produces",
  "produce", "wrong", "does", "not", "when", "into", "from", "based", "set",
  "add", "hook", "use", "using", "are", "can", "should", "must", "will", "has",
  "have", "but", "all", "any", "via", "per", "out", "new", "get", "self",
]);

const DOMAIN_MIN_TOKEN_LENGTH = 3;
const DOMAIN_STEM_PREFIX = 5;

// Count the distinct query content-tokens that stem-match a path or name token of
// the candidate. Returns a raw count; the caller normalises against the pool.
export function computeDomainRaw(
  query: string,
  symbol: { localName: string; fqName: string; filePath: string },
): number {
  const queryTokens = new Set(
    tokenize(query).filter(
      (token) => token.length >= DOMAIN_MIN_TOKEN_LENGTH && !DOMAIN_STOPWORDS.has(token),
    ),
  );
  if (queryTokens.size === 0) {
    return 0;
  }
  const candidateTokens = new Set([
    ...tokenize(symbol.localName),
    ...tokenize(symbol.filePath),
  ]);

  let matched = 0;
  for (const queryToken of queryTokens) {
    for (const candidateToken of candidateTokens) {
      if (stemMatch(queryToken, candidateToken)) {
        matched += 1;
        break;
      }
    }
  }
  return matched;
}

// Two tokens match for domain purposes when they are equal or share a long
// enough prefix (aggregate ~ aggregation ~ aggregates; subquery ~ subqueries).
function stemMatch(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const shared = sharedPrefixLength(a, b);
  return shared >= DOMAIN_STEM_PREFIX && shared >= Math.min(a.length, b.length) - 3;
}

function sharedPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) {
    index += 1;
  }
  return index;
}

// ----- generic-token lexical down-weighting -----------------------------------
//
// Query shaping (P1) already keeps generic bug-report words ("multiple", "error")
// out of `likely_symbols` and subsystem tokens, but — by design — leaves them in
// the raw task text so BM25/FTS recall is preserved. The side effect: a candidate
// whose NAME happens to contain a generic word (`FieldFile.multiple_chunks`) wins
// the lexical race off that one word and can become a top pivot, even though the
// word carries no edit-target signal (Stage 5R `django__django-12325`).
//
// This pass down-weights the BLENDED lexical score of a candidate whose name is
// matched ONLY by generic query tokens. A candidate whose name ALSO matches a
// MEANINGFUL query token (compound support, e.g. the query mentions "chunks") is
// left at full strength — so compound identifiers are demoted by noise, not
// destroyed. Matching is against the candidate's NAME identity (localName +
// fqName) and NOT its directory path, so an incidental dir segment ("core" from
// "django.core.exceptions") cannot masquerade as meaningful support.

// Multiplier applied to the blended lexical score when a candidate's name is
// explained ONLY by generic query tokens. Small but non-zero: the candidate can
// still surface on other evidence, it just cannot ride a generic word to a pivot.
export const GENERIC_ONLY_LEXICAL_FACTOR = 0.25;

export interface LexicalQueryTokens {
  /** Content tokens that carry edit-target signal. */
  readonly meaningful: ReadonlySet<string>;
  /** Generic bug-report tokens eligible for lexical down-weighting. */
  readonly generic: ReadonlySet<string>;
}

// Split a query's content tokens into meaningful vs generic. Structural/boilerplate
// tokens (DOMAIN_STOPWORDS) and sub-`DOMAIN_MIN_TOKEN_LENGTH` tokens are dropped
// from both sets — they never carry signal and never trigger a down-weight.
export function classifyLexicalQueryTokens(query: string): LexicalQueryTokens {
  const meaningful = new Set<string>();
  const generic = new Set<string>();
  for (const token of tokenize(query)) {
    if (token.length < DOMAIN_MIN_TOKEN_LENGTH || DOMAIN_STOPWORDS.has(token)) {
      continue;
    }
    if (GENERIC_TOKEN_STOPLIST.has(token)) {
      generic.add(token);
    } else {
      meaningful.add(token);
    }
  }
  return { meaningful, generic };
}

export interface LexicalGenericMatch {
  /** Generic query tokens that matched this candidate's name (the down-weighted ones). */
  readonly downweightedTokens: string[];
  /** Distinct meaningful query tokens that matched the candidate's name. */
  readonly meaningfulMatchCount: number;
  /** Distinct generic query tokens that matched the candidate's name. */
  readonly genericMatchCount: number;
  /** Multiplier in (0, 1] for the candidate's blended lexical score. */
  readonly factor: number;
}

// Decide how much of a candidate's name match is generic-only. The factor is
// `GENERIC_ONLY_LEXICAL_FACTOR` exactly when a generic query token matches the
// name AND no meaningful query token does; otherwise it is 1 (untouched).
export function analyzeLexicalGenericMatch(
  queryTokens: LexicalQueryTokens,
  symbol: { localName: string; fqName: string },
): LexicalGenericMatch {
  const nameTokens = new Set([
    ...tokenize(symbol.localName),
    ...tokenize(symbol.fqName),
  ]);

  let meaningfulMatchCount = 0;
  for (const token of queryTokens.meaningful) {
    if (matchesNameToken(token, nameTokens)) {
      meaningfulMatchCount += 1;
    }
  }
  const downweightedTokens: string[] = [];
  for (const token of queryTokens.generic) {
    if (matchesNameToken(token, nameTokens)) {
      downweightedTokens.push(token);
    }
  }
  const genericMatchCount = downweightedTokens.length;
  const factor =
    genericMatchCount > 0 && meaningfulMatchCount === 0 ? GENERIC_ONLY_LEXICAL_FACTOR : 1;
  return { downweightedTokens, meaningfulMatchCount, genericMatchCount, factor };
}

function matchesNameToken(queryToken: string, nameTokens: ReadonlySet<string>): boolean {
  if (nameTokens.has(queryToken)) {
    return true;
  }
  for (const nameToken of nameTokens) {
    if (stemMatch(queryToken, nameToken)) {
      return true;
    }
  }
  return false;
}

// Normalise a raw value against the pool maximum so every component lands in
// [0, 1]. A non-positive max (no signal anywhere in the pool) maps to 0, which
// keeps the component honest rather than dividing by zero.
export function normalizeAgainst(value: number, max: number): number {
  if (max <= 0 || value <= 0) {
    return 0;
  }
  return value >= max ? 1 : value / max;
}

// ----- tokenization -----------------------------------------------------------

// Split identifiers the way both retrieval and a human reader would: camelCase
// and snake_case boundaries become separate tokens, dotted paths split on dots,
// everything lowercased. "get_inline_instances" -> [get, inline, instances];
// "ModelAdmin" -> [model, admin]; "django/db/models/aggregates.py" ->
// [django, db, models, aggregates, py].
export function tokenize(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const withBoundaries = text
    // camelCase / PascalCase boundary: insert a space before an interior capital.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // Acronym -> word boundary, e.g. "HTMLParser" -> "HTML Parser".
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return withBoundaries
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

// ----- BM25 / TF-IDF ----------------------------------------------------------

export interface Bm25Document {
  readonly id: string;
  readonly text: string;
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

// Score each document against the query terms with Okapi BM25 over the supplied
// corpus. The corpus is the CANDIDATE POOL, not the whole index: IDF is computed
// over the documents actually in contention, which is what makes a rare,
// discriminating term (e.g. "aggregate") outweigh a ubiquitous one (e.g. "get").
//
// Deterministic: same query + same documents (same order) -> same scores.
export function computeBm25Scores(
  query: string,
  documents: readonly Bm25Document[],
): Map<string, number> {
  const scores = new Map<string, number>();
  if (documents.length === 0) {
    return scores;
  }

  const queryTerms = unique(tokenize(query));
  for (const doc of documents) {
    scores.set(doc.id, 0);
  }
  if (queryTerms.length === 0) {
    return scores;
  }

  const docTokens = documents.map((doc) => tokenize(doc.text));
  const docLengths = docTokens.map((tokens) => tokens.length);
  const totalLength = docLengths.reduce((sum, length) => sum + length, 0);
  const avgLength = totalLength / documents.length;

  // Document frequency per query term.
  const termFrequencies = docTokens.map((tokens) => countTokens(tokens));
  const docFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    let df = 0;
    for (const frequencies of termFrequencies) {
      if (frequencies.has(term)) {
        df += 1;
      }
    }
    docFrequency.set(term, df);
  }

  const n = documents.length;
  for (let index = 0; index < documents.length; index += 1) {
    const doc = documents[index] as Bm25Document;
    const frequencies = termFrequencies[index] as Map<string, number>;
    const length = docLengths[index] as number;
    let score = 0;
    for (const term of queryTerms) {
      const tf = frequencies.get(term) ?? 0;
      if (tf === 0) {
        continue;
      }
      const df = docFrequency.get(term) ?? 0;
      // Standard BM25 idf with the +1 smoothing that keeps it non-negative.
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const denominator = tf + BM25_K1 * (1 - BM25_B + (BM25_B * length) / (avgLength || 1));
      score += idf * ((tf * (BM25_K1 + 1)) / (denominator || 1));
    }
    scores.set(doc.id, score);
  }

  return scores;
}

function countTokens(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
