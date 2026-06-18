// Tests for the M39 Semantic Edit Hypothesis — the compact, DEFAULT-OFF section that
// names same-operation-name implementations across files and warns "no crash ≠
// correct". These exercise the pure builder/renderer/gate over hand-built pivot +
// support inputs, plus the flag-gated render path through renderCapsuleV2Human. They
// touch no retrieval, scoring, or role behaviour, and reference no gold/oracle data.
//
// Motivation (M38, sphinx-7462): the agent rules out the second `unparse` because
// `', '.join()` does not crash, missing that it renders the wrong text for an empty
// tuple. The hypothesis targets that faulty inference with non-oracle evidence
// (candidate symbols + inlined source only).

import assert from "node:assert/strict";
import { test } from "bun:test";

import { renderCapsuleV2Human } from "./renderHuman";
import {
  SEMANTIC_EDIT_HYPOTHESIS_ENV,
  SEMANTIC_EDIT_HYPOTHESIS_HEADING,
  buildSemanticEditHypothesis,
  isOperationLikeName,
  renderSemanticEditHypothesisText,
  semanticEditHypothesisEnabled,
} from "./semanticEditHypothesis";
import {
  CapsuleIntent,
  CapsuleV2ContentMode,
  CapsuleV2Mode,
  type CapsuleV2Item,
  type CapsuleV2Result,
  type CapsuleV2Scorecard,
} from "./types";

const ZERO_SCORECARD: CapsuleV2Scorecard = {
  lexical: 0,
  symbol: 1,
  path: 0,
  test_to_impl: 0,
  body_literal: 0,
  graph_proximity: 0,
  centrality: 0,
  actionability: 0,
  hub_penalty: 0,
  final: 1,
};

// Minimal CapsuleV2Item factory — fills every required field with inert defaults so
// the tests speak only the four fields the feature reads (role/path/symbol/source).
function item(
  role: "pivot" | "support",
  path: string,
  symbol: string,
  source?: string,
): CapsuleV2Item {
  return {
    role,
    role_reason: "test fixture",
    path,
    fq_name: `${path}::${symbol}`,
    symbol,
    kind: "function",
    content_mode: CapsuleV2ContentMode.Full,
    source,
    evidence: ["test fixture"],
    scorecard: ZERO_SCORECARD,
    estimated_tokens: 1,
    is_entry_point: false,
    is_implementation_helper: false,
    is_generic_infrastructure: false,
    is_class_method_expansion_target: false,
    is_containing_class_context: false,
    is_query_builder_entrypoint: false,
    is_sql_rendering_implementation: false,
  };
}

function render(
  pivots: CapsuleV2Item[],
  support: CapsuleV2Item[] = [],
  contextText?: string,
): string {
  return renderSemanticEditHypothesisText(
    buildSemanticEditHypothesis(pivots, support, contextText ? { contextText } : undefined),
  ).join("\n");
}

// The sphinx-7462 shape: lead pivot is `_parse_annotation` whose body contains a
// NESTED `def unparse`; the secondary pivot's symbol IS `unparse` in another module.
const PY_PARSE_ANNOTATION = item(
  "pivot",
  "sphinx/domains/python.py",
  "_parse_annotation",
  [
    "def _parse_annotation(annotation):",
    "    def unparse(node):",
    "        elif isinstance(node, ast.Tuple):",
    "            result = []",
    "            for elem in node.elts:",
    "                result.extend(unparse(elem))",
    "            result.pop()",
    "            return result",
  ].join("\n"),
);
const AST_UNPARSE = item(
  "pivot",
  "sphinx/pycode/ast.py",
  "unparse",
  [
    "def unparse(node):",
    "    elif isinstance(node, ast.Tuple):",
    '        return ", ".join(unparse(e) for e in node.elts)',
  ].join("\n"),
);

// --- 1. default/unset flag does not render -----------------------------------------

test("1. flag unset / falsy → disabled (default OFF); render path stays empty", () => {
  assert.equal(semanticEditHypothesisEnabled({}), false);
  assert.equal(semanticEditHypothesisEnabled({ [SEMANTIC_EDIT_HYPOTHESIS_ENV]: "0" }), false);
  assert.equal(semanticEditHypothesisEnabled({ [SEMANTIC_EDIT_HYPOTHESIS_ENV]: "false" }), false);
  assert.equal(semanticEditHypothesisEnabled({ [SEMANTIC_EDIT_HYPOTHESIS_ENV]: "off" }), false);
  assert.equal(semanticEditHypothesisEnabled({ [SEMANTIC_EDIT_HYPOTHESIS_ENV]: "" }), false);
  // Default-off via renderCapsuleV2Human (explicit option false stands in for env-unset).
  const human = renderCapsuleV2Human(resultWith([PY_PARSE_ANNOTATION, AST_UNPARSE]), {
    enableSemanticEditHypothesis: false,
  });
  assert.ok(!human.includes(SEMANTIC_EDIT_HYPOTHESIS_HEADING), "section absent when disabled");
});

test("1b. flag truthy values → enabled", () => {
  for (const v of ["1", "true", "on", "yes", "TRUE", " On "]) {
    assert.equal(
      semanticEditHypothesisEnabled({ [SEMANTIC_EDIT_HYPOTHESIS_ENV]: v }),
      true,
      `"${v}" should enable`,
    );
  }
});

// --- 2. flag enabled renders when same-name multi-module pivots exist ---------------

test("2. enabled + same-name multi-module pivots → section renders via renderCapsuleV2Human", () => {
  const human = renderCapsuleV2Human(resultWith([PY_PARSE_ANNOTATION, AST_UNPARSE]), {
    enableSemanticEditHypothesis: true,
  });
  assert.ok(human.includes(SEMANTIC_EDIT_HYPOTHESIS_HEADING), "section present when enabled");
  assert.match(human, /sphinx\/domains\/python\.py::unparse/);
  assert.match(human, /sphinx\/pycode\/ast\.py::unparse/);
});

// --- 3. sphinx-like fixture renders both unparse pivots -----------------------------

test("3. sphinx-like fixture: hypothesis names both unparse implementations", () => {
  const hyp = buildSemanticEditHypothesis([PY_PARSE_ANNOTATION, AST_UNPARSE], []);
  assert.notEqual(hyp, null);
  const group = hyp!.groups.find((g) => g.name === "unparse");
  assert.ok(group, "an `unparse` group exists");
  assert.deepEqual(group!.targets, [
    "sphinx/domains/python.py::unparse",
    "sphinx/pycode/ast.py::unparse",
  ]);
  const text = renderSemanticEditHypothesisText(hyp).join("\n");
  assert.match(text, /verify both implementations for output correctness, not just crash avoidance/);
  // python.py body has result.pop() → empty-container sentence fires.
  assert.equal(hyp!.emptyContainerSignal, true);
  assert.match(text, /a path can avoid crashing but still render the wrong text/);
});

// --- 4. no trigger for a single pivot ----------------------------------------------

test("4. single pivot → no hypothesis", () => {
  assert.equal(buildSemanticEditHypothesis([AST_UNPARSE], []), null);
  assert.equal(render([AST_UNPARSE]), "");
});

// --- 5. no trigger for same-file same-name candidates ------------------------------

test("5. same-name but same file → no hypothesis (needs ≥2 distinct files)", () => {
  // Two pivots in the SAME file, plus a nested same-name def — still one file.
  const a = item("pivot", "pkg/mod.py", "render", "def render(x):\n    return str(x)");
  const b = item("pivot", "pkg/mod.py", "helper", "def render(y):\n    return y");
  assert.equal(buildSemanticEditHypothesis([a, b], []), null);
});

// --- 6. no trigger for unrelated support-only lexical match ------------------------

test("6. same-name across files but NO pivot file → no hypothesis", () => {
  // Both definers are support — rule #3 requires at least one pivot file.
  const s1 = item("support", "pkg/a.py", "serialize", "def serialize(x): ...");
  const s2 = item("support", "pkg/b.py", "serialize", "def serialize(y): ...");
  // Add an unrelated lone pivot so items.length >= 2 and pivots exist.
  const lead = item("pivot", "pkg/lead.py", "fix_it", "def fix_it(): ...");
  assert.equal(buildSemanticEditHypothesis([lead], [s1, s2]), null);
});

test("6b. non-operation-like same-name across files → no hypothesis", () => {
  // `penguins` (seaborn-style example data) is defined in two files but is NOT an
  // operation name, and there is no output/parse/render context → no trigger.
  const a = item("pivot", "examples/grouped_barplot.py", "penguins", "def penguins(): ...");
  const b = item("pivot", "examples/joint_kde.py", "penguins", "def penguins(): ...");
  assert.equal(buildSemanticEditHypothesis([a, b], []), null);
});

test("6c. dunder same-name across files → no hypothesis (dunders excluded)", () => {
  const a = item("pivot", "pkg/a.py", "__repr__", "def __repr__(self): ...");
  const b = item("pivot", "pkg/b.py", "__repr__", "def __repr__(self): ...");
  assert.equal(buildSemanticEditHypothesis([a, b], []), null);
});

test("6d. context-relevance gate admits a non-operation name when context warrants", () => {
  // `build` is not in the operation lexicon, but the issue text is about output
  // rendering consistency → the relevance gate (rule #5 OR-branch) admits it.
  const a = item("pivot", "pkg/a.py", "build", "def build(): ...");
  const b = item("pivot", "pkg/b.py", "build", "def build(): ...");
  assert.equal(buildSemanticEditHypothesis([a, b], []), null, "no context → no trigger");
  const hyp = buildSemanticEditHypothesis([a, b], [], {
    contextText: "the rendered output differs between the two builders",
  });
  assert.notEqual(hyp, null, "output/render context admits the pair");
});

// --- 7. output is bounded -----------------------------------------------------------

test("7. bounded: ≤2 groups, ≤3 files/group, ≤150 words, no source excerpts", () => {
  // Build many same-name multi-module groups and many files per name.
  const pivots: CapsuleV2Item[] = [];
  for (const name of ["parse", "render", "encode", "decode", "serialize"]) {
    for (let f = 0; f < 5; f++) {
      pivots.push(item("pivot", `pkg/${name}_${f}.py`, name, `def ${name}(): ...`));
    }
  }
  const hyp = buildSemanticEditHypothesis(pivots, []);
  assert.notEqual(hyp, null);
  assert.ok(hyp!.groups.length <= 2, "at most 2 groups");
  for (const g of hyp!.groups) assert.ok(g.targets.length <= 3, "at most 3 files per group");
  const text = renderSemanticEditHypothesisText(hyp).join("\n");
  const words = text.split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 150, `bounded to ≤150 words (was ${words})`);
  assert.ok(!text.includes("def "), "no source excerpts duplicated");
});

// --- 8. no benchmark / gold / test-label leakage -----------------------------------

test("8. rendered text leaks no oracle/gold/benchmark/test tokens", () => {
  const text = renderSemanticEditHypothesisText(
    buildSemanticEditHypothesis([PY_PARSE_ANNOTATION, AST_UNPARSE], []),
  ).join("\n");
  const banned = [
    "FAIL_TO_PASS",
    "PASS_TO_PASS",
    "gold",
    "expected_file",
    "test_unparse",
    "tests/",
    "swe-bench",
    "sphinx-doc__",
    "resolved",
  ];
  for (const b of banned) {
    assert.ok(!text.toLowerCase().includes(b.toLowerCase()), `must not leak "${b}"`);
  }
  // Only references the provided file/symbol identities.
  assert.match(text, /sphinx\/domains\/python\.py::unparse/);
  assert.match(text, /sphinx\/pycode\/ast\.py::unparse/);
});

// --- 9. accounting helper classifies the section (chars/tokens > 0) -----------------
// Accounting unit lives in benchmarks/m34_accounting.test.ts; here we assert the
// heading is stable so the classifier keyed on it stays in sync.

test("9. heading is the stable accounting key", () => {
  const text = renderSemanticEditHypothesisText(
    buildSemanticEditHypothesis([PY_PARSE_ANNOTATION, AST_UNPARSE], []),
  ).join("\n");
  assert.ok(text.startsWith("\n" + SEMANTIC_EDIT_HYPOTHESIS_HEADING) || text.includes(SEMANTIC_EDIT_HYPOTHESIS_HEADING));
  assert.equal(SEMANTIC_EDIT_HYPOTHESIS_HEADING, "## Semantic Edit Hypothesis");
});

// --- 10. rendering-only: builder does not mutate inputs ----------------------------

test("10. rendering-only: inputs are not mutated by build/render", () => {
  const pivots = [PY_PARSE_ANNOTATION, AST_UNPARSE];
  const snapshot = JSON.stringify(pivots);
  const hyp = buildSemanticEditHypothesis(pivots, []);
  renderSemanticEditHypothesisText(hyp);
  assert.equal(JSON.stringify(pivots), snapshot, "pivots unchanged (no retrieval/role mutation)");
});

// isOperationLikeName spot checks (lexicon + to_/from_ shape + dunder exclusion).
test("isOperationLikeName: lexicon, prefixes, exclusions", () => {
  for (const yes of ["unparse", "parse", "render", "serialize", "to_json", "from_dict", "as_text", "encode"]) {
    assert.equal(isOperationLikeName(yes), true, `${yes} is operation-like`);
  }
  for (const no of ["__repr__", "handle", "get", "run", "PythonDomain", "penguins", ""]) {
    assert.equal(isOperationLikeName(no), false, `${no} is not operation-like`);
  }
});

// --- helpers ------------------------------------------------------------------------

function resultWith(pivots: CapsuleV2Item[], support: CapsuleV2Item[] = []): CapsuleV2Result {
  return {
    intent: CapsuleIntent.Debug,
    actual_mode: CapsuleV2Mode.Full,
    budget: { estimated_tokens: 100, max_tokens: 8_000 },
    pivots,
    support,
    discarded: [],
    diagnostics: {
      intent_confidence: "high",
      intent_reason: [],
      strategy: { role_policy: "debug_refinement" },
    } as unknown as CapsuleV2Result["diagnostics"],
  } as CapsuleV2Result;
}
