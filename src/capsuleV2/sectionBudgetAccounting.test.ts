// Tests for the M44-ACCT section-level budget / truncation accounting helper.
//
// The helper is PURE, ANALYSIS-ONLY telemetry over the already-rendered capsule
// text: it parses sections, classifies each by priority, and reports whether the
// injector's global head-preserving char-budget cut would clip an ESSENTIAL section
// while OPTIONAL advisory text survives. It changes no retrieval, ranking, pivots,
// scoring, or injected text. These tests exercise the parser/classifier/analysis
// over synthetic + sphinx-7462-shaped text, plus the renderHuman additivity /
// default-off / no-mutation guarantees the milestone requires.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildCapsuleV2 } from "./buildCapsuleV2";
import { renderCapsuleV2Human } from "./renderHuman";
import {
  EDIT_SUFFICIENCY_CHECKLIST_HEADING,
} from "./semanticEditHypothesis";
import {
  analyzeSectionTruncation,
  classifyHeading,
  inventorySections,
} from "./sectionBudgetAccounting";
import {
  CapsuleIntent,
  CapsuleV2ContentMode,
  type CapsuleV2Item,
  type CapsuleV2Result,
} from "./types";
import { INLINES_TASK, seedCapsuleV2Fixture } from "./__fixtures__/capsuleV2Fixture";

// A compact stand-in for the rendered capsule: framing, two optional advisories, an
// important obligation, an essential pivot body, and an essential pivot-neighborhood
// block at the TAIL (the M42 shape — neighborhood is last, so the head-preserving cut
// reaches it first).
function syntheticCapsule(): string {
  return [
    "## VTRACE inspect-first (guidance, not enforcement; confidence: high)",
    "intent: test-failure (high confidence)",
    "strategy: debug_refinement",
    "budget: 1,578 / 8,000 tokens used",
    "",
    "## Multi-Pivot Action Plan",
    "1. Inspect pkg/a.py::foo, then pkg/b.py::bar.",
    "",
    "## Semantic Edit Hypothesis",
    "Two implementations define `bar`; no crash does not mean correct output.",
    "",
    "## Pivot inspection contract",
    "- inspect pkg/a.py::foo (lead)",
    "- inspect or rule out pkg/b.py::bar",
    "",
    "● pivot pkg/a.py::foo",
    "  source:",
    "  def foo():",
    "      return bar()",
    "",
    "● pivot pkg/b.py::bar",
    "  source:",
    "  def bar():",
    "      return ', '.join(parts)",
    "",
    "## Final Edit-Sufficiency Check",
    "[ ] confirm both foo and bar are edited if behavior spans both",
    "",
    "## Pivot neighborhood (nearby symbols, compact)",
    "- caller: pkg/a.py::handle (pkg/a.py:1091-1096)",
    "- caller: pkg/b.py::render (pkg/b.py:40-52)",
    "- excerpt: def handle(): ... long neighborhood body that carries the essential",
    "  source evidence the capsule exists to preserve and must not be silently lost.",
  ].join("\n");
}

// --- 1. inventory captures known headings + item blocks + framing ------------------

test("1. inventorySections captures every heading, item block, and the framing block", () => {
  const sections = inventorySections(syntheticCapsule());
  const names = sections.map((s) => s.name);
  // Framing (the leading inspect-first/intent/strategy/budget block).
  assert.equal(sections[0].kind, "heading"); // first line is a `## ` heading here
  assert.ok(names.includes("Multi-Pivot Action Plan"));
  assert.ok(names.includes("Semantic Edit Hypothesis"));
  assert.ok(names.includes("Pivot inspection contract"));
  assert.ok(names.includes("Final Edit-Sufficiency Check"));
  assert.ok(names.includes("Pivot neighborhood (nearby symbols, compact)"));
  // Item blocks are parsed and named from the bullet line.
  assert.ok(names.includes("pivot source: pkg/a.py::foo"));
  assert.ok(names.includes("pivot source: pkg/b.py::bar"));
  assert.ok(sections.some((s) => s.kind === "pivot"));
});

test("1b. section spans are contiguous and cover the whole text", () => {
  const text = syntheticCapsule();
  const sections = inventorySections(text);
  // First section starts at 0; summed chars reproduce the full length.
  assert.equal(sections[0].startChar, 0);
  const summed = sections.reduce((acc, s) => acc + s.chars, 0);
  assert.equal(summed, text.length);
  // Spans are ordered and non-overlapping.
  for (let i = 1; i < sections.length; i += 1) {
    assert.equal(sections[i].startChar, sections[i - 1].startChar + sections[i - 1].chars);
  }
});

// --- 2. preTruncationChars >= postTruncationChars (always) -------------------------

test("2. postTruncationChars never exceeds preTruncationChars", () => {
  const text = syntheticCapsule();
  for (const budget of [0, 50, 200, text.length - 1, text.length, text.length + 1000]) {
    const a = analyzeSectionTruncation(text, budget);
    assert.ok(a.preTruncationChars >= a.postTruncationChars, `budget=${budget}`);
    assert.equal(a.truncatedChars, a.preTruncationChars - a.postTruncationChars);
    assert.ok(a.truncatedChars >= 0);
  }
});

// --- 3. truncationOccurred reflects the budget -------------------------------------

test("3. truncationOccurred is true iff the render exceeds the budget", () => {
  const text = syntheticCapsule();
  assert.equal(analyzeSectionTruncation(text, text.length).truncationOccurred, false);
  assert.equal(analyzeSectionTruncation(text, text.length + 10).truncationOccurred, false);
  assert.equal(analyzeSectionTruncation(text, text.length - 1).truncationOccurred, true);
  const tight = analyzeSectionTruncation(text, 200);
  assert.equal(tight.truncationOccurred, true);
  assert.equal(tight.postTruncationChars, 200);
});

// --- 4. truncatedSectionNames identifies the clipped tail sections -----------------

test("4. truncatedSectionNames lists the tail sections that lose chars", () => {
  const text = syntheticCapsule();
  // Cut just inside the pivot-neighborhood block (the last section).
  const neighborhood = inventorySections(text).find((s) => s.name.startsWith("Pivot neighborhood"));
  assert.ok(neighborhood);
  const cut = neighborhood!.startChar + 20; // 20 chars into the neighborhood
  const a = analyzeSectionTruncation(text, cut);
  assert.ok(a.truncatedSectionNames.includes(neighborhood!.name), "neighborhood must be flagged clipped");
  // Sections wholly before the cut are NOT flagged.
  assert.ok(!a.truncatedSectionNames.includes("Multi-Pivot Action Plan"));
});

// --- 5. essential eviction + optional retention (the M42 reproduction) -------------

test("5. essential pivot-neighborhood eviction is detected while optional advisory is retained", () => {
  const text = syntheticCapsule();
  const sections = inventorySections(text);
  const checklist = sections.find((s) => s.name.startsWith("Final Edit-Sufficiency Check"))!;
  const neighborhood = sections.find((s) => s.name.startsWith("Pivot neighborhood"))!;
  // Cut between the optional checklist (retained) and inside the essential
  // neighborhood (clipped) — exactly the M42 ordering.
  const cut = neighborhood.startChar + 30;
  assert.ok(cut > checklist.startChar + checklist.chars, "checklist must end before the cut");
  const a = analyzeSectionTruncation(text, cut);
  assert.ok(a.truncationOccurred);
  assert.ok(
    a.essentialSectionsEvicted.includes(neighborhood.name),
    "essential neighborhood must be reported evicted",
  );
  assert.ok(
    a.optionalSectionsRetained.includes("Final Edit-Sufficiency Check"),
    "optional checklist must be reported retained",
  );
});

test("5b. no false alarm when nothing essential is evicted", () => {
  const text = syntheticCapsule();
  const a = analyzeSectionTruncation(text, text.length); // no truncation
  assert.equal(a.essentialSectionsEvicted.length, 0);
  assert.equal(a.optionalSectionsRetained.length, 0); // only reported when essential evicted
});

// --- 6. optional advisory headings are classified optional -------------------------

test("6. M39/M41/M35 advisory headings classify as optional; evidence as essential", () => {
  assert.equal(classifyHeading("Semantic Edit Hypothesis"), "optional");
  assert.equal(classifyHeading("Final Edit-Sufficiency Check"), "optional");
  assert.equal(classifyHeading("Multi-Pivot Action Plan"), "optional");
  assert.equal(classifyHeading("Pivot neighborhood (nearby symbols, compact)"), "essential");
  assert.equal(classifyHeading("VTRACE inspect-first (guidance...)"), "essential");
  assert.equal(classifyHeading("Pivot inspection contract"), "important");
  assert.equal(classifyHeading("Actionability hints"), "important");
  // Unknown headings default to important (never silently droppable).
  assert.equal(classifyHeading("Some Future Section"), "important");
});

// --- input-derived only: no fabricated / leaked content ----------------------------

test("output section names are all substrings of the input (no fabricated/leaked text)", () => {
  const text = syntheticCapsule();
  const a = analyzeSectionTruncation(text, 200);
  const GOLD_LEAKS = ["gold", "FAIL_TO_PASS", "expected_file", "resolved", "decoy"];
  for (const s of a.sections) {
    if (s.kind === "framing") continue; // synthetic label
    // Heading/item names are derived verbatim from a line in the input.
    const core = s.name.replace(/^(pivot|support) source: /, "");
    assert.ok(text.includes(core), `section name not found in input: ${s.name}`);
    for (const leak of GOLD_LEAKS) assert.ok(!s.name.includes(leak));
  }
});

// === renderHuman additivity / default-off / no-mutation guarantees =================

// A sphinx-7462-shaped pair: two pivots defining `unparse` in different files, which
// triggers the M39 semantic hypothesis and the M41 checklist (paired-symbol group).
function unparsePivot(path: string, body: string[]): CapsuleV2Item {
  return {
    role: "pivot",
    role_reason: "test fixture",
    path,
    fq_name: `${path}::unparse`,
    symbol: "unparse",
    kind: "function",
    content_mode: CapsuleV2ContentMode.Full,
    source: body.join("\n"),
    evidence: ["test fixture"],
    scorecard: {
      lexical: 0, symbol: 1, path: 0, test_to_impl: 0, body_literal: 0,
      graph_proximity: 0, centrality: 0, actionability: 0, hub_penalty: 0, final: 1,
    },
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

function pairedResult(): CapsuleV2Result {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  let base: CapsuleV2Result;
  try {
    base = buildCapsuleV2({ db, repoRoot, task: INLINES_TASK, intent: CapsuleIntent.Debug, maxTokens: 8_000 });
  } finally {
    db.close();
  }
  return {
    ...base,
    pivots: [
      unparsePivot("a/python.py", ["def unparse(node):", "    return walk(node)"]),
      unparsePivot("a/ast.py", ["def unparse(node):", "    return ', '.join(parts)"]),
    ],
    support: [],
  };
}

// --- 7. M39 + M41 buckets are additive --------------------------------------------

test("7. enabling M39 + M41 only ADDS optional sections; off output is a subsequence", () => {
  const result = pairedResult();
  const off = renderCapsuleV2Human(result, {
    enableSemanticEditHypothesis: false,
    enableEditSufficiencyChecklist: false,
  });
  const on = renderCapsuleV2Human(result, {
    enableSemanticEditHypothesis: true,
    enableEditSufficiencyChecklist: true,
  });
  // The two optional headings appear only when enabled, and classify as optional.
  assert.ok(!off.includes("## Semantic Edit Hypothesis"));
  assert.ok(on.includes("## Semantic Edit Hypothesis"));
  assert.ok(!off.includes(EDIT_SUFFICIENCY_CHECKLIST_HEADING));
  assert.ok(on.includes(EDIT_SUFFICIENCY_CHECKLIST_HEADING));
  assert.equal(classifyHeading("Semantic Edit Hypothesis"), "optional");
  // Additive: every pivot source line present with the flags OFF is still present ON.
  for (const line of off.split("\n")) {
    if (line.trim().length === 0) continue;
    assert.ok(on.includes(line), `enabling optional sections dropped a base line: ${line}`);
  }
  // Enabling the optional sections grows the render (it never shrinks essential text).
  assert.ok(on.length > off.length);
});

// --- 8. default-off output is byte-identical ---------------------------------------

test("8. default render equals all-optional-off render, byte for byte", () => {
  const result = pairedResult();
  const def = renderCapsuleV2Human(result);
  const explicitOff = renderCapsuleV2Human(result, {
    enableSemanticEditHypothesis: false,
    enableEditSufficiencyChecklist: false,
  });
  assert.equal(def, explicitOff);
});

// --- 9. enabling optional sections does not mutate pivots/support ------------------

test("9. rendering (any flags) does not mutate the result's pivots/support", () => {
  const result = pairedResult();
  const snapshot = JSON.stringify({ pivots: result.pivots, support: result.support });
  renderCapsuleV2Human(result, {
    enableSemanticEditHypothesis: true,
    enableEditSufficiencyChecklist: true,
    enableMultiPivotActionPlan: true,
  });
  assert.equal(JSON.stringify({ pivots: result.pivots, support: result.support }), snapshot);
});

// --- 10. no gold / hidden-test / benchmark-label leakage in the analysis -----------

test("10. analysis of a rendered capsule leaks no gold/hidden-test/benchmark labels", () => {
  const rendered = renderCapsuleV2Human(pairedResult(), {
    enableSemanticEditHypothesis: true,
    enableEditSufficiencyChecklist: true,
  });
  const a = analyzeSectionTruncation(rendered, 300);
  const blob = JSON.stringify(a);
  for (const leak of ["FAIL_TO_PASS", "expected_file", "gold patch", "resolved=", "decoy"]) {
    assert.ok(!blob.includes(leak), `analysis leaked: ${leak}`);
  }
});
