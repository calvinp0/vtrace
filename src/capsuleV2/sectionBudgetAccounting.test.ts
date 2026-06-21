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
  truncateContextByPriority,
  STRUCTURED_CONTRACT_OMITTED_MARKER,
  type AtomicSentinelBlockSpec,
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
  // Sized so essential/optional BODIES dominate the per-section omission markers,
  // giving a wide section-priority window (mirrors a real ~12k capsule, not a toy).
  const fill = (tag: string, n: number) =>
    Array.from({ length: n }, (_, i) => `  # ${tag} body line ${i} carrying real content`);
  return [
    "## VTRACE inspect-first (guidance, not enforcement; confidence: high)",
    "intent: test-failure (high confidence)",
    "strategy: debug_refinement",
    "budget: 1,578 / 8,000 tokens used",
    "",
    "## Multi-Pivot Action Plan",
    "1. Inspect pkg/a.py::foo, then pkg/b.py::bar.",
    ...fill("action-plan", 12),
    "",
    "## Semantic Edit Hypothesis",
    "Two implementations define `bar`; no crash does not mean correct output.",
    ...fill("semantic-hypothesis", 12),
    "",
    "## Pivot inspection contract",
    "- inspect pkg/a.py::foo (lead)",
    "- inspect or rule out pkg/b.py::bar",
    ...fill("contract", 8),
    "",
    "● pivot pkg/a.py::foo",
    "  source:",
    "  def foo():",
    "      return bar()",
    ...fill("foo-source", 20),
    "",
    "● pivot pkg/b.py::bar",
    "  source:",
    "  def bar():",
    "      return ', '.join(parts)",
    ...fill("bar-source", 20),
    "",
    "## Final Edit-Sufficiency Check",
    "[ ] confirm both foo and bar are edited if behavior spans both",
    ...fill("checklist", 12),
    "",
    "## Pivot neighborhood (nearby symbols, compact)",
    "- caller: pkg/a.py::handle (pkg/a.py:1091-1096)",
    "- caller: pkg/b.py::render (pkg/b.py:40-52)",
    ...fill("neighborhood", 18),
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

// === M45: section-priority truncation =============================================

// Section sizes for the synthetic capsule, derived from the parser so the budget
// thresholds in these tests track the fixture rather than magic numbers.
function sizes() {
  const text = syntheticCapsule();
  const sections = inventorySections(text);
  const sumBy = (p: string) => sections.filter((s) => s.priority === p).reduce((a, s) => a + s.chars, 0);
  return { text, total: text.length, essential: sumBy("essential"), optional: sumBy("optional"), important: sumBy("important") };
}

// --- (M45-1) no truncation under budget --------------------------------------------

test("M45-1. under budget → mode none, text unchanged, no drops", () => {
  const { text, total } = sizes();
  const r = truncateContextByPriority(text, total);
  assert.equal(r.text, text);
  assert.equal(r.budget.truncationMode, "none");
  assert.equal(r.budget.truncationOccurred, false);
  assert.equal(r.budget.droppedSectionNames.length, 0);
  assert.equal(r.budget.postTruncationChars, total);
  // Slack above budget is also a no-op.
  assert.equal(truncateContextByPriority(text, total + 5_000).text, text);
});

// --- (M45-2) drops optional before essential; essential preserved ------------------

// Generous headroom above the essential set for the per-section omission markers the
// reducer substitutes for dropped sections (a handful of short lines).
const MARKER_SLACK = 600;

test("M45-2. over budget drops optional/diagnostic before essential evidence", () => {
  const { text, essential } = sizes();
  // A budget that comfortably holds the essential set but not the full render → the
  // reducer must shed optional sections and keep every essential one.
  const budget = essential + MARKER_SLACK;
  const r = truncateContextByPriority(text, budget);
  assert.equal(r.budget.truncationMode, "section_priority");
  assert.equal(r.budget.essentialSectionsEvicted, false);
  assert.ok(r.budget.optionalSectionsDropped, "an optional section must be dropped");
  assert.ok(r.budget.postTruncationChars <= budget, "must fit the budget");
  // Essential evidence survives intact in the injected text.
  assert.ok(r.text.includes("## Pivot neighborhood"));
  assert.ok(r.text.includes("source evidence the capsule exists to preserve"));
  assert.ok(r.text.includes("● pivot pkg/a.py::foo"));
  assert.ok(r.text.includes("● pivot pkg/b.py::bar"));
});

// --- (M45-3/4/5/6) section classification used by the reducer ----------------------

test("M45-3/4/5/6. advisory sections classify optional; neighborhood essential", () => {
  assert.equal(classifyHeading("Semantic Edit Hypothesis"), "optional"); // M39
  assert.equal(classifyHeading("Final Edit-Sufficiency Check"), "optional"); // M41
  assert.equal(classifyHeading("Multi-Pivot Action Plan"), "optional"); // M35
  assert.equal(classifyHeading("Pivot neighborhood (nearby symbols, compact)"), "essential");
});

// --- (M45-7) essential preserved when dropping optional is enough ------------------

test("M45-7. essential pivot/source fully preserved when optional drops suffice", () => {
  const { text, essential, important } = sizes();
  const budget = essential + important + MARKER_SLACK; // room for essential + important, not optional
  const r = truncateContextByPriority(text, budget);
  assert.equal(r.budget.essentialSectionsEvicted, false);
  assert.equal(r.budget.truncatedSectionNames.length, 0, "no mid-section clip in section_priority mode");
  // No essential section name appears in the dropped list.
  for (const name of r.budget.droppedSectionNames) {
    assert.ok(!name.startsWith("pivot source:"), `dropped an essential pivot: ${name}`);
    assert.ok(!name.startsWith("Pivot neighborhood"), `dropped the neighborhood: ${name}`);
  }
});

// --- (M45-8) dropped optional sections get omission markers ------------------------

test("M45-8. dropped sections are replaced by an omission marker", () => {
  const { text, essential } = sizes();
  const r = truncateContextByPriority(text, essential + MARKER_SLACK);
  assert.ok(r.budget.droppedSectionNames.length > 0);
  assert.ok(r.text.includes("[omitted "), "omission marker missing");
  for (const name of r.budget.droppedSectionNames) {
    // Dropped sections are always headings (essential item bodies are never dropped),
    // so the marker carries the heading's own priority class.
    const pri = classifyHeading(name);
    assert.ok(r.text.includes(`[omitted ${pri} section: ${name}`), `no marker for ${name}`);
    assert.ok(!r.text.includes(`## ${name}\n\n`), "dropped section body still present");
  }
});

// --- (M45-9) essentialSectionsEvicted=false when essential survives ----------------

test("M45-9. essentialSectionsEvicted=false whenever essential content survives", () => {
  const { text, essential } = sizes();
  const r = truncateContextByPriority(text, essential + MARKER_SLACK);
  assert.equal(r.budget.essentialSectionsEvicted, false);
  // Every essential section's body is still in the injected text.
  assert.ok(r.text.includes("source evidence the capsule exists to preserve"));
});

// --- (M45-10) fallback evicts essentials only when essentials alone exceed budget --

test("M45-10. essentials-exceed-budget → legacy slice fallback reports eviction", () => {
  const { text } = sizes();
  const r = truncateContextByPriority(text, 200); // far below the essential floor
  assert.equal(r.budget.truncationMode, "legacy_slice_fallback");
  assert.equal(r.budget.essentialSectionsEvicted, true);
  assert.ok(r.budget.truncatedSectionNames.length > 0, "must name the clipped essential section");
  assert.match(r.text, /\[truncated to 200 chars\]/);
  // Invariant: when essential is evicted, no optional section is retained in full.
  assert.equal(r.budget.optionalSectionsRetained.length, 0);
});

// --- invariant: optional never retained while essential clipped --------------------

test("M45. invariant — optional sections are dropped before essential is clipped", () => {
  const { text, total } = sizes();
  // Sweep budgets across the whole range; the invariant must hold at every point.
  for (let budget = 50; budget <= total; budget += 137) {
    const r = truncateContextByPriority(text, budget);
    if (r.budget.essentialSectionsEvicted) {
      assert.equal(
        r.budget.optionalSectionsRetained.length, 0,
        `optional retained while essential evicted at budget=${budget}`,
      );
    }
  }
});

// --- postTruncationChars equals the actual injected text length --------------------

test("M45. postTruncationChars equals the actual injected text length", () => {
  const { text, essential, total } = sizes();
  for (const budget of [total, essential + MARKER_SLACK, 200]) {
    const r = truncateContextByPriority(text, budget);
    assert.equal(r.budget.postTruncationChars, r.text.length);
    assert.ok(r.budget.preTruncationChars >= r.budget.postTruncationChars);
    assert.equal(r.budget.truncatedChars, r.budget.preTruncationChars - r.budget.postTruncationChars);
  }
});

// --- M42 reconstruction: optional dropped, neighborhood preserved ------------------

test("M45. M42-shaped capsule: optional advisory dropped, pivot-neighborhood preserved", () => {
  // The synthetic capsule mirrors the M42 ordering: optional Final Edit-Sufficiency
  // Check sits just before the essential Pivot neighborhood at the tail. Under a budget
  // that the legacy head-slice would have used to clip the neighborhood, M45 instead
  // drops the optional advisory and keeps the neighborhood whole.
  const { text } = sizes();
  const overBy = 120;
  const r = truncateContextByPriority(text, text.length - overBy);
  assert.equal(r.budget.essentialSectionsEvicted, false);
  assert.ok(r.budget.droppedSectionNames.some((n) => classifyHeading(n) === "optional"));
  assert.ok(r.text.includes("source evidence the capsule exists to preserve"), "neighborhood tail evicted");
});

// === M61: atomic sentinel-block preservation under truncation ======================
//
// The structured bounded digest treatment injects two sentinel-delimited blocks — the
// Capsule v2 digest and the decision contract — that the strict four-sentinel validator
// requires WHOLE. M60B (pylint-8898) showed the legacy_slice fallback could clip a
// trailing sentinel and leave a dangling START with no END (a partial pair the validator
// rightly rejects). These tests pin the invariant: with `atomicBlocks` supplied, a
// sentinel block is either fully present or fully absent with an explicit omission marker.

const DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>";
const DIGEST_END = "<VTRACE_CAPSULE_V2_DIGEST_END>";
const CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>";
const CONTRACT_END = "<VTRACE_DIGEST_DECISION_CONTRACT_END>";

const ATOMIC_BLOCKS: readonly AtomicSentinelBlockSpec[] = [
  { label: "capsule_v2_digest", start: DIGEST_START, end: DIGEST_END },
  { label: "digest_decision_contract", start: CONTRACT_START, end: CONTRACT_END },
];

function countOcc(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// True when EVERY START present has its matching END present (no dangling sentinel).
function noPartialSentinels(text: string): boolean {
  const pairOk = (s: string, e: string): boolean => {
    const hasS = text.includes(s);
    const hasE = text.includes(e);
    return hasS === hasE; // both, or neither — never a lone START/END
  };
  return pairOk(DIGEST_START, DIGEST_END) && pairOk(CONTRACT_START, CONTRACT_END);
}

// A digest sentinel block of roughly `bodyChars` chars (plain text — no `## `/`●` lines,
// so the non-atomic reducer treats it as a single essential framing section).
function digestBlock(bodyChars: number): string {
  const body = Array.from({ length: Math.ceil(bodyChars / 40) }, (_, i) =>
    `digest line ${i} carrying the compact role hierarchy`,
  ).join("\n");
  return [DIGEST_START, body, DIGEST_END].join("\n");
}

function contractBlock(): string {
  return [
    CONTRACT_START,
    "Close EVERY required target below with exactly one decision.",
    "- target_id: T1",
    "  target: PIVOT pkg/a.py::foo",
    "  decision: EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT",
    "  reason: lead pivot",
    "  files_touched: <paths or none>",
    CONTRACT_END,
  ].join("\n");
}

// A large lower-priority free body: one optional advisory heading + an essential pivot
// source render + a pivot-neighborhood tail (the sections the M61 policy sheds FIRST to
// keep the atomic blocks whole).
function freeRender(sourceChars: number): string {
  const fill = (tag: string, n: number) =>
    Array.from({ length: n }, (_, i) => `  # ${tag} body line ${i} carrying real content`);
  const n = Math.max(8, Math.ceil(sourceChars / 200));
  return [
    "## Semantic Edit Hypothesis",
    "Two implementations define `bar`; no crash does not mean correct output.",
    ...fill("semantic-hypothesis", n),
    "",
    "● pivot pkg/a.py::foo",
    "  source:",
    "  def foo():",
    "      return bar()",
    ...fill("foo-source", n * 2),
    "",
    "## Pivot neighborhood (nearby symbols, compact)",
    "- caller: pkg/a.py::handle (pkg/a.py:1091-1096)",
    ...fill("neighborhood", n),
  ].join("\n");
}

// --- (M61-1) repro: legacy core clips the contract; atomic NEVER emits a partial ----

test("M61-1. legacy core can clip the contract END; atomic path never leaves a partial sentinel", () => {
  // Digest large enough that the contract END sits past the cut → the section-blind
  // core fallback slices through the contract block (the M60B failure shape).
  const text = [digestBlock(5000), contractBlock(), freeRender(6000)].join("\n\n");
  const ds = text.indexOf(DIGEST_END);
  const ce = text.indexOf(CONTRACT_END);
  const cut = ds + 250; // after digest END, BEFORE contract END

  // Pre-fix behavior: the non-atomic core produces a dangling contract START.
  const core = truncateContextByPriority(text, cut);
  assert.equal(core.budget.truncationMode, "legacy_slice_fallback");
  assert.ok(core.text.includes(CONTRACT_START), "core keeps the contract START");
  assert.equal(core.text.includes(CONTRACT_END), false, "core clips the contract END (the bug)");
  assert.equal(noPartialSentinels(core.text), false, "core leaves a partial sentinel pair");

  // After fix: the atomic path fails CLOSED — the contract cannot fit, so it is omitted
  // whole with an explicit marker rather than split. No partial sentinel either way.
  assert.ok(cut < ce, "fixture: cut must fall before the contract END");
  const atomic = truncateContextByPriority(text, cut, { atomicBlocks: ATOMIC_BLOCKS });
  assert.equal(atomic.budget.truncationMode, "atomic_omitted");
  assert.ok(noPartialSentinels(atomic.text), "atomic path never leaves a partial sentinel pair");
  assert.ok(atomic.text.includes(STRUCTURED_CONTRACT_OMITTED_MARKER), "explicit omission marker emitted");
  assert.deepEqual(atomic.budget.atomicBlocksOmitted, ["digest_decision_contract"]);
  assert.deepEqual(atomic.budget.atomicBlocksPreserved, ["capsule_v2_digest"]);
  assert.ok(atomic.text.length <= cut, "fail-closed output still fits the budget");
});

// --- (M61-2) preservation: both blocks survive whole by evicting free content -------

test("M61-2. structured bounded treatment preserves BOTH sentinel blocks under a tight budget", () => {
  // Digest + contract together fit well under budget; the large lower-priority free
  // render is what pushes the total over. The fix keeps both blocks whole and sheds the
  // free render (the pylint-8898 expected outcome).
  const digest = digestBlock(3000);
  const contract = contractBlock();
  const text = [digest, contract, freeRender(8000)].join("\n\n");
  const lockedChars = digest.length + contract.length;
  const cut = lockedChars + 2500; // room for both blocks + a slice of free content
  assert.ok(cut < text.length, "fixture: must actually truncate");

  const r = truncateContextByPriority(text, cut, { atomicBlocks: ATOMIC_BLOCKS });

  // Both sentinel pairs present exactly once → strict four-sentinel validity holds.
  assert.equal(countOcc(r.text, DIGEST_START), 1);
  assert.equal(countOcc(r.text, DIGEST_END), 1);
  assert.equal(countOcc(r.text, CONTRACT_START), 1);
  assert.equal(countOcc(r.text, CONTRACT_END), 1);
  assert.ok(noPartialSentinels(r.text));
  // The full digest body and the full contract grammar survived verbatim.
  assert.ok(r.text.includes(digest), "digest block preserved whole");
  assert.ok(r.text.includes(contract), "decision contract preserved whole");
  assert.deepEqual([...(r.budget.atomicBlocksPreserved ?? [])].sort(), [
    "capsule_v2_digest",
    "digest_decision_contract",
  ]);
  assert.deepEqual(r.budget.atomicBlocksOmitted, []);
  assert.ok(r.text.length <= cut, "fits the budget");
  assert.ok(["atomic_section_priority", "atomic_legacy_slice"].includes(r.budget.truncationMode));
});

// --- (M61-3) lower-priority free sections are evicted before the atomic blocks ------

test("M61-3. lower-priority free render is evicted before the digest/contract blocks", () => {
  const digest = digestBlock(2500);
  const contract = contractBlock();
  const text = [digest, contract, freeRender(8000)].join("\n\n");
  const cut = digest.length + contract.length + 1200;

  const r = truncateContextByPriority(text, cut, { atomicBlocks: ATOMIC_BLOCKS });
  // Atomic blocks intact...
  assert.ok(r.text.includes(digest));
  assert.ok(r.text.includes(contract));
  // ...while the free render lost content (a drop marker or a clip marker is present, and
  // the bulk of the source body is gone).
  const droppedOrClipped =
    r.text.includes("[omitted ") || r.text.includes("[truncated to ");
  assert.ok(droppedOrClipped, "free render must be reduced to make room");
  assert.ok(countOcc(r.text, "foo-source body line") < countOcc(text, "foo-source body line"));
});

// --- (M61-4) the no-partial-sentinel invariant holds at EVERY budget ----------------

test("M61-4. no budget ever produces a partial digest or contract sentinel pair", () => {
  const text = [digestBlock(4000), contractBlock(), freeRender(7000)].join("\n\n");
  for (let cut = 50; cut <= text.length + 500; cut += 173) {
    const r = truncateContextByPriority(text, cut, { atomicBlocks: ATOMIC_BLOCKS });
    assert.ok(noPartialSentinels(r.text), `partial sentinel at budget=${cut}`);
    // Whenever a block IS present, it is present exactly once (never duplicated).
    if (r.text.includes(DIGEST_START)) assert.equal(countOcc(r.text, DIGEST_END), 1);
    if (r.text.includes(CONTRACT_START)) assert.equal(countOcc(r.text, CONTRACT_END), 1);
  }
});

// --- (M61-5) a registered safety block is preserved the same way (generality) -------

test("M61-5. a registered safety block is preserved atomically alongside digest/contract", () => {
  const SAFETY_START = "<VTRACE_EDIT_GUARD_START>";
  const SAFETY_END = "<VTRACE_EDIT_GUARD_END>";
  const safety = [SAFETY_START, "Do not edit non-pivot files without justification.", SAFETY_END].join("\n");
  const digest = digestBlock(2000);
  const contract = contractBlock();
  // Safety block placed in the body region; registered as atomic with priority intent.
  const text = [digest, contract, safety, freeRender(8000)].join("\n\n");
  const blocks: AtomicSentinelBlockSpec[] = [
    ...ATOMIC_BLOCKS,
    { label: "edit_guard", start: SAFETY_START, end: SAFETY_END },
  ];
  const cut = digest.length + contract.length + safety.length + 800;
  const r = truncateContextByPriority(text, cut, { atomicBlocks: blocks });
  assert.ok(r.text.includes(safety), "safety block preserved whole after truncation");
  assert.ok(r.text.includes(digest));
  assert.ok(r.text.includes(contract));
  assert.ok((r.budget.atomicBlocksPreserved ?? []).includes("edit_guard"));
});

// --- (M61-6) default behavior is unchanged when no atomic blocks are present ---------

test("M61-6. without atomicBlocks (or with none present) truncation is byte-identical", () => {
  const { text } = sizes(); // a render with NO digest/contract sentinels
  for (const cut of [200, 1500, text.length - 100, text.length + 50]) {
    const base = truncateContextByPriority(text, cut);
    const withOpt = truncateContextByPriority(text, cut, { atomicBlocks: ATOMIC_BLOCKS });
    assert.equal(withOpt.text, base.text, `text differs at budget=${cut}`);
    assert.equal(withOpt.budget.truncationMode, base.budget.truncationMode);
    assert.equal(withOpt.budget.essentialSectionsEvicted, base.budget.essentialSectionsEvicted);
    // No atomic telemetry leaks onto the default path.
    assert.equal(withOpt.budget.atomicBlocksPreserved, undefined);
  }
  // A glyph-only text (●/○/→ but NO sentinels) must NOT activate the atomic path.
  const glyphy = "● pivot pkg/a.py::foo\n  source\n→ impact\n○ support pkg/b.py::bar";
  assert.equal(
    truncateContextByPriority(glyphy, 10, { atomicBlocks: ATOMIC_BLOCKS }).text,
    truncateContextByPriority(glyphy, 10).text,
  );
});

// --- (M61-7) untruncated atomic text is returned verbatim with telemetry ------------

test("M61-7. when everything fits, atomic blocks are reported preserved and text is unchanged", () => {
  const text = [digestBlock(1000), contractBlock(), freeRender(1500)].join("\n\n");
  const r = truncateContextByPriority(text, text.length + 100, { atomicBlocks: ATOMIC_BLOCKS });
  assert.equal(r.text, text, "no truncation → text unchanged");
  assert.equal(r.budget.truncationOccurred, false);
  assert.equal(r.budget.truncationMode, "none");
  assert.deepEqual([...(r.budget.atomicBlocksPreserved ?? [])].sort(), [
    "capsule_v2_digest",
    "digest_decision_contract",
  ]);
});
