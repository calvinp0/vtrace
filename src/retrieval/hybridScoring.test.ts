import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  blendLexical,
  combineFinalScore,
  computeBm25Scores,
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
  const final = combineFinalScore({ lexical, symbol: 1, path: 0, graph: 0, centrality: 0 });
  // default weights: lexical 1.0, symbol 1.2 -> 0.65 + 1.2 = 1.85
  assert.ok(Math.abs(final - (0.65 + 1.2)) < 1e-9);
});
