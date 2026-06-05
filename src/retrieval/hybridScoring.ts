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
  /** Normalised symbol-name match strength (exact/prefix on a likely symbol). */
  symbol: number;
  /** Normalised path/file match strength (candidate lives in a likely file). */
  path: number;
  /** Normalised graph score (expansion depth + connection evidence). */
  graph: number;
  /** Normalised graph centrality (in-degree within the working set). */
  centrality: number;
  /** Weighted sum of the components above; the ranking key. */
  final: number;
}

export interface HybridScoreWeights {
  readonly lexical: number;
  readonly symbol: number;
  readonly path: number;
  readonly graph: number;
  readonly centrality: number;
}

// Weights are POLICY, kept named and out of the combine math. The defaults lean
// on symbol and lexical evidence (the strongest precision signals for an exact
// edit target) while letting path/graph/centrality break ties and rescue
// candidates the lexical matcher missed.
export const HYBRID_SCORE_WEIGHTS: HybridScoreWeights = Object.freeze({
  lexical: 1.0,
  symbol: 1.2,
  path: 0.8,
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
    + weights.graph * components.graph
    + weights.centrality * components.centrality
  );
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
