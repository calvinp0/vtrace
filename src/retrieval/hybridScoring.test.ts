import assert from "node:assert/strict";
import { test } from "bun:test";

import { SymbolKind } from "../domain/types";
import {
  blendLexical,
  combineFinalScore,
  computeBm25Scores,
  computeDomainRaw,
  evaluateActionability,
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
  const stripped = { graphContribution: 1.0, domainContribution: 0.9 };

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
});
