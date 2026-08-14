/**
 * M146-A. Derivation of the text stored in `symbol_search_fts`.
 *
 * This tokenizer runs at INDEX WRITE TIME — `replaceSymbolSearchIndexForFile`
 * calls it for every stored local name, FQN, signature, docstring and path —
 * and again at query time, where the query must be tokenized the same way for a
 * match to be possible. That makes it index-DERIVING semantics, not query
 * semantics, even though both sides use it.
 *
 * It lives under `src/indexer` because that directory feeds
 * `indexer_fingerprint`. Its previous home, `src/retrieval/searchSymbolsShared`,
 * is deliberately excluded from every fingerprint so that ranking changes do not
 * invalidate indexes — which meant a change to the tokenization here altered the
 * stored FTS rows while every existing index still reported `ready: true`.
 * M146-A measured exactly that: identical fingerprints, `ready`, and a genuinely
 * different derivation ("parsejson" and "computetotal" silently disappearing).
 *
 * Keep this module free of ranking policy. Anything added here invalidates every
 * index in existence; anything that only affects how stored terms are SCORED
 * belongs in the retrieval layer instead.
 */

/**
 * Split a value into the term set stored in / matched against the FTS table.
 *
 * Emits, for each alphanumeric run: the lowercased run, its camelCase segments,
 * and every multi-segment prefix combination — so `parseJsonBody` is findable as
 * `parse`, `json`, `body`, `parsejson`, `jsonbody` and `parsejsonbody`.
 */
export function collectSearchTerms(value: string): string[] {
  const rawSegments = value.replace(/\\/g, "/").match(/[A-Za-z0-9]+/g) ?? [];
  const terms = new Set<string>();

  for (const rawSegment of rawSegments) {
    const lowerRawSegment = rawSegment.toLowerCase();

    if (lowerRawSegment.length === 0) {
      continue;
    }

    terms.add(lowerRawSegment);

    const splitSegments = rawSegment
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/\s+/)
      .filter((segment) => segment.length > 0);

    for (const segment of splitSegments) {
      terms.add(segment);
    }

    for (let start = 0; start < splitSegments.length; start += 1) {
      let combined = "";

      for (let end = start; end < splitSegments.length; end += 1) {
        combined += splitSegments[end] ?? "";

        if (end > start) {
          terms.add(combined);
        }
      }
    }
  }

  return [...terms].sort();
}

/** The exact string persisted into an FTS column for `value`. */
export function buildFtsSearchText(value: string): string {
  return collectSearchTerms(value).join(" ");
}
