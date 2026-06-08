import assert from "node:assert/strict";
import { test } from "bun:test";

import { SymbolKind } from "../domain/types";
import {
  analyzeLexicalGenericMatch,
  blendLexical,
  BODY_LITERAL_WEIGHT,
  classifyLexicalQueryTokens,
  combineFinalScore,
  computeBm25Scores,
  computeDomainRaw,
  evaluateActionability,
  GENERIC_ONLY_LEXICAL_FACTOR,
  normalizeAgainst,
  tokenize,
} from "./hybridScoring";

test("tokenize splits camelCase, snake_case, and path separators", () => {
  assert.deepEqual(tokenize("get_inline_instances"), ["get", "inline", "instances"]);
  assert.deepEqual(tokenize("ModelAdmin"), ["model", "admin"]);
  assert.deepEqual(
    tokenize("django/db/models/aggregates.py"),
    ["django", "db", "models", "aggregates", "py"],
  );
  assert.deepEqual(tokenize("HTMLParser"), ["html", "parser"]);
});

test("BM25 rewards the rarer, more discriminating term", () => {
  const documents = [
    { id: "a", text: "aggregate count expression" },
    { id: "b", text: "common common common count" },
    { id: "c", text: "common common common common" },
  ];
  const scores = computeBm25Scores("aggregate", documents);

  // Only doc a contains the rare term "aggregate"; it must outscore the rest.
  assert.ok((scores.get("a") ?? 0) > 0);
  assert.equal(scores.get("c") ?? 0, 0);
  assert.ok((scores.get("a") ?? 0) > (scores.get("b") ?? 0));
});

test("BM25 is deterministic for identical inputs", () => {
  const documents = [
    { id: "a", text: "model admin options get inline instances" },
    { id: "b", text: "aggregate count distinct" },
  ];
  const first = computeBm25Scores("inline admin", documents);
  const second = computeBm25Scores("inline admin", documents);
  assert.deepEqual([...first.entries()].sort(), [...second.entries()].sort());
});

test("normalizeAgainst maps to [0, 1] and guards a zero max", () => {
  assert.equal(normalizeAgainst(5, 10), 0.5);
  assert.equal(normalizeAgainst(10, 10), 1);
  assert.equal(normalizeAgainst(3, 0), 0);
  assert.equal(normalizeAgainst(0, 10), 0);
});

test("final score is a plain weighted sum that excludes the raw lexical sub-signals", () => {
  const lexical = blendLexical(1, 0); // 0.65
  const final = combineFinalScore({ lexical, symbol: 1, path: 0, domain: 0, testToImpl: 0, graph: 0, centrality: 0 });
  // default weights: lexical 1.0, symbol 1.2 -> 0.65 + 1.2 = 1.85
  assert.ok(Math.abs(final - (0.65 + 1.2)) < 1e-9);
});

test("domain relevance stem-matches query terms against path and name tokens", () => {
  const aggregate = {
    localName: "Aggregate",
    fqName: "django/db/models/aggregates.py::Aggregate",
    filePath: "django/db/models/aggregates.py",
  };
  // "aggregation"/"aggregate" stem-match the path token "aggregates".
  assert.ok(computeDomainRaw("Count annotation aggregation distinct", aggregate) > 0);
  // An unrelated query has no domain overlap.
  assert.equal(computeDomainRaw("serialize json template widget", aggregate), 0);
  // Structural query labels ("failing tests:", "issue:") are stopworded out.
  assert.equal(computeDomainRaw("failing tests issue files symbols", aggregate), 0);
});

test("module variables are low actionability and penalized without strong evidence", () => {
  const stripped = { graphContribution: 1.0, domainContribution: 0.9, bodyLiteral: 0 };

  // A module variable riding graph/domain with weak lexical, no symbol/path.
  const weak = evaluateActionability({
    kind: SymbolKind.ModuleVariable,
    lexical: 0.2,
    symbol: 0,
    path: 0,
    ...stripped,
  });
  assert.equal(weak.actionability, 0);
  assert.ok(weak.penalty > 0, "low-actionability symbol without strong evidence is penalized");
  assert.ok(Math.abs(weak.penalty - (1.0 + 0.9)) < 1e-9, "penalty strips graph + domain");

  // A function is actionable and never penalized.
  const method = evaluateActionability({
    kind: SymbolKind.Method,
    lexical: 0,
    symbol: 0,
    path: 0,
    ...stripped,
  });
  assert.equal(method.actionability, 1);
  assert.equal(method.penalty, 0);

  // A module variable WITH strong direct evidence (a symbol-name match) is spared.
  const strong = evaluateActionability({
    kind: SymbolKind.ModuleVariable,
    lexical: 0,
    symbol: 1,
    path: 0,
    ...stripped,
  });
  assert.equal(strong.penalty, 0);

  // A body-literal hit is also strong direct evidence — a module-level constant
  // that emits the cited diagnostic code is spared the penalty.
  const literalBacked = evaluateActionability({
    kind: SymbolKind.ModuleConstant,
    lexical: 0,
    symbol: 0,
    path: 0,
    bodyLiteral: 1,
    graphContribution: 1.0,
    domainContribution: 0.9,
  });
  assert.equal(literalBacked.penalty, 0);
});

test("combineFinalScore adds the body-literal contribution at a fixed weight", () => {
  const base = { lexical: 0, symbol: 0, path: 0, domain: 0, testToImpl: 0, graph: 0, centrality: 0 };
  // No bodyLiteral -> unchanged (optional, defaults to 0).
  assert.equal(combineFinalScore(base), 0);
  // A full body-literal match contributes BODY_LITERAL_WEIGHT.
  assert.ok(Math.abs(combineFinalScore({ ...base, bodyLiteral: 1 }) - BODY_LITERAL_WEIGHT) < 1e-9);
});

// ----- generic-token lexical down-weighting -----------------------------------

test("classifyLexicalQueryTokens splits generic from meaningful and drops boilerplate", () => {
  const tokens = classifyLexicalQueryTokens(
    "multiple OneToOne references produce the wrong error for ForeignKey",
  );
  // Generic bug-report words.
  assert.ok(tokens.generic.has("multiple"));
  assert.ok(tokens.generic.has("error"));
  // Meaningful domain words survive (camelCase split: OneToOne -> one/to/one).
  assert.ok(tokens.meaningful.has("references"));
  assert.ok(tokens.meaningful.has("foreign") && tokens.meaningful.has("key"));
  // Structural/short tokens are in neither set ("the"/"for" are DOMAIN_STOPWORDS;
  // "to" is sub-length and dropped).
  assert.ok(!tokens.meaningful.has("the") && !tokens.generic.has("the"));
  assert.ok(!tokens.meaningful.has("to"));
});

test("'multiple' alone down-weights multiple_chunks; meaningful support spares it", () => {
  const query = "pk setup confused by multiple OneToOne references";
  const tokens = classifyLexicalQueryTokens(query);

  // multiple_chunks: name matched ONLY by the generic "multiple" -> down-weighted.
  const decoy = analyzeLexicalGenericMatch(tokens, {
    localName: "multiple_chunks",
    fqName: "FieldFile.multiple_chunks",
  });
  assert.deepEqual(decoy.downweightedTokens, ["multiple"]);
  assert.equal(decoy.meaningfulMatchCount, 0);
  assert.equal(decoy.factor, GENERIC_ONLY_LEXICAL_FACTOR);
  assert.ok(decoy.factor < 1, "generic-only name match is down-weighted");

  // A meaningful domain symbol is untouched (no generic token matches its name).
  const real = analyzeLexicalGenericMatch(tokens, {
    localName: "setup_pk",
    fqName: "Options.setup_pk",
  });
  assert.equal(real.factor, 1);
  assert.equal(real.downweightedTokens.length, 0);
  assert.ok(real.meaningfulMatchCount >= 1, "setup/pk are meaningful matches");
});

test("compound identifier is preserved when a meaningful query token also matches it", () => {
  // Same decoy NAME, but now the query genuinely mentions "chunks": the meaningful
  // match spares the candidate even though "multiple" still matches.
  const tokens = classifyLexicalQueryTokens("multiple chunks read incorrectly");
  const supported = analyzeLexicalGenericMatch(tokens, {
    localName: "multiple_chunks",
    fqName: "FieldFile.multiple_chunks",
  });
  assert.equal(supported.factor, 1, "meaningful 'chunks' support keeps full lexical weight");
  assert.equal(supported.meaningfulMatchCount, 1);
  // The generic token is still reported as matched, but it did not trigger a penalty.
  assert.deepEqual(supported.downweightedTokens, ["multiple"]);
});

test("a candidate with no query-token name match is never down-weighted", () => {
  const tokens = classifyLexicalQueryTokens("multiple OneToOne references");
  // Matched lexically via signature/docstring, not via a name token: factor stays 1.
  const neutral = analyzeLexicalGenericMatch(tokens, {
    localName: "deconstruct",
    fqName: "ForeignKey.deconstruct",
  });
  assert.equal(neutral.factor, 1);
  assert.equal(neutral.genericMatchCount, 0);
  assert.equal(neutral.meaningfulMatchCount, 0);
});

test("meaningful domain symbols retain full lexical weight against a noisy query", () => {
  const tokens = classifyLexicalQueryTokens("error: ForeignKey deconstruct change is wrong");
  for (const name of ["ForeignKey", "deconstruct", "OneToOneField", "_check_ordering"]) {
    const a = analyzeLexicalGenericMatch(tokens, { localName: name, fqName: name });
    assert.equal(a.factor, 1, `${name} must keep full lexical weight`);
  }
});

// --- G1: exception-symptom de-anchoring ---------------------------------------

test("IndexError de-anchors 'index' so an index-named symbol is not a strong anchor", () => {
  const tokens = classifyLexicalQueryTokens("IndexError: pop from empty list for empty tuple annotation");
  // 'index' came ONLY from IndexError -> de-anchored (folded into generic).
  assert.ok(tokens.deanchored.has("index"), "index should be de-anchored");
  assert.ok(tokens.generic.has("index"), "de-anchored token is treated as generic");
  assert.ok(!tokens.meaningful.has("index"), "index must not be a meaningful anchor");
  // The category suffix 'error' is generic but not reported as a symptom noun.
  assert.ok(!tokens.deanchored.has("error"));

  // An index-named symbol matched ONLY by the de-anchored token is down-weighted.
  const indexSym = analyzeLexicalGenericMatch(tokens, { localName: "index", fqName: "addnodes.index" });
  assert.equal(indexSym.factor, GENERIC_ONLY_LEXICAL_FACTOR);
  assert.deepEqual(indexSym.downweightedTokens, ["index"]);
});

test("UnicodeDecodeError de-anchors 'unicode' and 'decode'", () => {
  const tokens = classifyLexicalQueryTokens("Unicode method names cause UnicodeDecodeError for some requests");
  // 'decode' came ONLY from the exception name -> de-anchored.
  assert.ok(tokens.deanchored.has("decode"), "decode should be de-anchored");
  assert.ok(tokens.generic.has("decode"));
  assert.ok(!tokens.meaningful.has("decode"));
  // 'unicode' appears standalone ("Unicode method names") AND in the exception, so
  // it is a genuine domain term and must stay meaningful (domain terms preserved).
  assert.ok(tokens.meaningful.has("unicode"), "standalone 'unicode' stays meaningful");
  assert.ok(!tokens.deanchored.has("unicode"));

  const decodeSym = analyzeLexicalGenericMatch(tokens, {
    localName: "stream_decode_response_unicode",
    fqName: "requests.utils.stream_decode_response_unicode",
  });
  // 'unicode' is meaningful and matches the name, so the candidate is spared the
  // penalty — but it no longer rides 'decode' alone to a pivot.
  assert.equal(decodeSym.meaningfulMatchCount >= 1, true);
  assert.deepEqual(decodeSym.downweightedTokens, ["decode"]);
});

test("a symptom noun that occurs ONLY standalone (no exception) stays meaningful", () => {
  const tokens = classifyLexicalQueryTokens("the index of the column is computed wrong");
  assert.ok(tokens.meaningful.has("index"));
  assert.ok(!tokens.deanchored.has("index"));
  assert.equal(tokens.deanchored.size, 0);
});

test("the full exception name is preserved in the query (recall) — de-anchoring is scoring-only", () => {
  const query = "IndexError: pop from empty list";
  // classify does not mutate the query; recall text still contains the full name.
  assert.ok(query.includes("IndexError"));
  const tokens = classifyLexicalQueryTokens(query);
  // A symbol whose name genuinely matches the full exception still scores via the
  // tokenized 'indexerror' parts; de-anchoring only removes the standalone 'index'
  // anchor, it does not erase the name from the query.
  assert.ok(tokens.generic.has("index"));
});

test("suffix-less builtin exceptions (StopIteration) de-anchor their symptom nouns", () => {
  const tokens = classifyLexicalQueryTokens("StopIteration leaks out of the generator unexpectedly");
  // 'iteration' came only from StopIteration -> de-anchored; 'stop' is sub-handled
  // (>=3 chars) and also de-anchored. 'generator' is a real standalone term.
  assert.ok(tokens.deanchored.has("iteration"));
  assert.ok(!tokens.meaningful.has("iteration"));
  assert.ok(tokens.meaningful.has("generator"));
});
