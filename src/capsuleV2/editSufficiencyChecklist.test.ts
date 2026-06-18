// Tests for the M41 end-of-context Edit-Sufficiency Checklist — the compact,
// DEFAULT-OFF section that re-surfaces the semantic co-edit hypothesis near the FINAL
// patch guidance (after the bulky source bodies) and forces an explicit edit-or-justify
// decision for the paired implementation. M40 found the top-placed M39 hypothesis raised
// inspection of the second `unparse` but did not convert into the edit; this targets the
// decision point. The checklist REUSES the M39 builder output (it does not re-detect) and
// references no gold/oracle/benchmark data.
//
// Env handling is isolated: every gate assertion passes an explicit env map, and every
// render passes explicit `enable*` options, so no flag leaks across tests or from the
// ambient process env.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { renderCapsuleV2Human } from "./renderHuman";
import {
  EDIT_SUFFICIENCY_CHECKLIST_ENV,
  EDIT_SUFFICIENCY_CHECKLIST_HEADING,
  SEMANTIC_EDIT_HYPOTHESIS_HEADING,
  buildSemanticEditHypothesis,
  editSufficiencyChecklistEnabled,
  renderEditSufficiencyChecklistText,
} from "./semanticEditHypothesis";
import {
  buildProductV2Accounting,
} from "../../benchmarks/stage5_vexp_swe_bench_smoke/m34_accounting";
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

function noContextResult(): CapsuleV2Result {
  return {
    intent: CapsuleIntent.Debug,
    actual_mode: CapsuleV2Mode.NoContext,
    reason: "no high-confidence edit target recovered",
    budget: { estimated_tokens: 0, max_tokens: 8_000 },
    pivots: [],
    support: [],
    discarded: [],
    diagnostics: {
      intent_confidence: "low",
      intent_reason: [],
      strategy: { role_policy: "debug_refinement" },
    } as unknown as CapsuleV2Result["diagnostics"],
  } as CapsuleV2Result;
}

const BOTH_ON = { enableSemanticEditHypothesis: true, enableEditSufficiencyChecklist: true };
const BOTH_OFF = { enableSemanticEditHypothesis: false, enableEditSufficiencyChecklist: false };

// sphinx-7462 shape: lead pivot `_parse_annotation` with a NESTED `def unparse`, plus a
// secondary pivot whose symbol IS `unparse` in another module — the paired implementations.
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
const SPHINX_PIVOTS = [PY_PARSE_ANNOTATION, AST_UNPARSE];

// --- 1. default/unset flag does not render the checklist ----------------------------

test("1. flag unset / falsy → checklist disabled (DEFAULT OFF)", () => {
  assert.equal(editSufficiencyChecklistEnabled({}), false);
  for (const v of ["0", "false", "off", "", "no"]) {
    assert.equal(editSufficiencyChecklistEnabled({ [EDIT_SUFFICIENCY_CHECKLIST_ENV]: v }), false);
  }
  for (const v of ["1", "true", "on", "yes", "TRUE", " On "]) {
    assert.equal(editSufficiencyChecklistEnabled({ [EDIT_SUFFICIENCY_CHECKLIST_ENV]: v }), true);
  }
  // Render path: checklist absent when its option is false, even on a paired-group capsule.
  const human = renderCapsuleV2Human(resultWith(SPHINX_PIVOTS), {
    enableSemanticEditHypothesis: true,
    enableEditSufficiencyChecklist: false,
  });
  assert.ok(!human.includes(EDIT_SUFFICIENCY_CHECKLIST_HEADING), "checklist absent when disabled");
});

// --- 2. checklist flag alone does NOT render without a semantic hypothesis group -----

test("2. checklist enabled but no paired-symbol group → no checklist", () => {
  // Single pivot: builder yields null → checklist must not render even with the flag on.
  const single = renderCapsuleV2Human(resultWith([AST_UNPARSE]), {
    enableEditSufficiencyChecklist: true,
  });
  assert.ok(!single.includes(EDIT_SUFFICIENCY_CHECKLIST_HEADING), "no checklist for single pivot");
  // A null hypothesis (no paired-symbol group) renders nothing.
  assert.deepEqual(renderEditSufficiencyChecklistText(null), []);
});

// --- 3. semantic hypothesis + checklist flags render the checklist for sphinx --------

test("3. sphinx-like paired unparse + both flags → checklist renders with both targets", () => {
  const human = renderCapsuleV2Human(resultWith(SPHINX_PIVOTS), BOTH_ON);
  assert.ok(human.includes(EDIT_SUFFICIENCY_CHECKLIST_HEADING), "checklist present");
  assert.match(human, /sphinx\/domains\/python\.py::unparse/);
  assert.match(human, /sphinx\/pycode\/ast\.py::unparse/);
  // Names the operation in the decision line.
  assert.match(human, /If you changed one implementation of `unparse`/);
});

test("3b. checklist renders even when the M39 top section is DISABLED (separate flags)", () => {
  const human = renderCapsuleV2Human(resultWith(SPHINX_PIVOTS), {
    enableSemanticEditHypothesis: false,
    enableEditSufficiencyChecklist: true,
  });
  assert.ok(!human.includes(SEMANTIC_EDIT_HYPOTHESIS_HEADING), "top M39 section absent");
  assert.ok(human.includes(EDIT_SUFFICIENCY_CHECKLIST_HEADING), "checklist still renders");
});

// --- 4. checklist appears AFTER the source bodies, near final patch guidance ---------

test("4. checklist is placed at the end — after pivot/support bodies and after the M39 top section", () => {
  const support = [item("support", "sphinx/util/helper.py", "render_helper", "def render_helper(): ...")];
  const human = renderCapsuleV2Human(resultWith(SPHINX_PIVOTS, support), BOTH_ON);
  const checklistAt = human.indexOf(EDIT_SUFFICIENCY_CHECKLIST_HEADING);
  const topHypothesisAt = human.indexOf(SEMANTIC_EDIT_HYPOTHESIS_HEADING);
  // The pivot source body and the support body both precede the checklist.
  const pivotBodyAt = human.indexOf("result.pop()");
  const supportBodyAt = human.indexOf("render_helper");
  assert.ok(checklistAt > -1 && topHypothesisAt > -1, "both sections present");
  assert.ok(topHypothesisAt < pivotBodyAt, "M39 hypothesis is in the TOP cluster (before bodies)");
  assert.ok(checklistAt > pivotBodyAt, "checklist is AFTER the pivot source body");
  assert.ok(checklistAt > supportBodyAt, "checklist is AFTER the support body");
});

// --- 5. checklist forces output-correctness reasoning, not just crash avoidance ------

test("5. checklist wording targets output correctness, not only crash avoidance", () => {
  const text = renderEditSufficiencyChecklistText(buildSemanticEditHypothesis(SPHINX_PIVOTS, [])).join("\n");
  assert.match(text, /correct output/i);
  assert.match(text, /only because it avoids the crash/i);
  // empty-container signal fires (python.py body has result.pop()) → wrong-output line present.
  assert.match(text, /render the wrong\s+text/i);
});

// --- 6. no trigger for a seaborn-like non-paired (non-operation) fixture -------------

test("6. seaborn-like `penguins` across files is not operation-like → no checklist", () => {
  const a = item("pivot", "examples/grouped_barplot.py", "penguins", "def penguins(): ...");
  const b = item("pivot", "examples/joint_kde.py", "penguins", "def penguins(): ...");
  const human = renderCapsuleV2Human(resultWith([a, b]), BOTH_ON);
  assert.ok(!human.includes(EDIT_SUFFICIENCY_CHECKLIST_HEADING), "no checklist for non-paired data symbol");
});

// --- 7. no trigger for a django-like unrelated multi-file fixture -------------------

test("7. django-like unrelated multi-file (distinct symbol names) → no checklist", () => {
  const a = item("pivot", "django/http/response.py", "delete_cookie", "def delete_cookie(self): ...");
  const b = item("pivot", "django/http/cookie.py", "load", "def load(self): ...");
  // Distinct symbol names across files → no same-name paired group.
  const human = renderCapsuleV2Human(resultWith([a, b]), BOTH_ON);
  assert.ok(!human.includes(EDIT_SUFFICIENCY_CHECKLIST_HEADING), "no checklist without a same-name pair");
});

// --- 8. no trigger for no-context / single-pivot localized tasks --------------------

test("8. no-context and single-pivot capsules → no checklist", () => {
  const noCtx = renderCapsuleV2Human(noContextResult(), BOTH_ON);
  assert.ok(!noCtx.includes(EDIT_SUFFICIENCY_CHECKLIST_HEADING), "no checklist for no-context");
  const single = renderCapsuleV2Human(resultWith([AST_UNPARSE]), BOTH_ON);
  assert.ok(!single.includes(EDIT_SUFFICIENCY_CHECKLIST_HEADING), "no checklist for single localized pivot");
});

// --- 9. no gold / FAIL_TO_PASS / PASS_TO_PASS / test-label leakage ------------------

test("9. checklist leaks no oracle/gold/benchmark/test tokens", () => {
  const text = renderEditSufficiencyChecklistText(buildSemanticEditHypothesis(SPHINX_PIVOTS, [])).join("\n");
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

// --- 10. accounting attributes the checklist its own chars/tokens -------------------

test("10. M34 accounting attributes checklist chars/tokens to its own bucket", () => {
  const human = renderCapsuleV2Human(resultWith(SPHINX_PIVOTS), BOTH_ON);
  const acc = buildProductV2Accounting(human, 50);
  assert.ok(acc.editSufficiencyChecklistTokens! > 0, "checklist tokens > 0 when rendered");
  assert.ok(acc.editSufficiencyChecklistChars! > 0, "checklist chars > 0 when rendered");
  // Reported separately from the M39 hypothesis bucket (both rendered here, both > 0).
  assert.ok(acc.semanticEditHypothesisTokens! > 0, "M39 hypothesis tokens reported separately");
  // Off → zero (additive / backward compatible).
  const off = buildProductV2Accounting(renderCapsuleV2Human(resultWith(SPHINX_PIVOTS), BOTH_OFF), 50);
  assert.equal(off.editSufficiencyChecklistTokens, 0);
  assert.equal(off.editSufficiencyChecklistChars, 0);
});

// --- 11. default behavior is byte-identical with the checklist off ------------------

test("11. checklist-off is a byte-identical no-op", () => {
  const result = resultWith(SPHINX_PIVOTS, [item("support", "sphinx/util/h.py", "fmt", "def fmt(): ...")]);
  // Passing the checklist option false must equal omitting it (env-unset path in tests).
  const explicitOff = renderCapsuleV2Human(result, { enableSemanticEditHypothesis: false, enableEditSufficiencyChecklist: false });
  const omitted = renderCapsuleV2Human(result, { enableSemanticEditHypothesis: false });
  assert.equal(explicitOff, omitted, "checklist-off does not perturb output");
  assert.ok(!explicitOff.includes(EDIT_SUFFICIENCY_CHECKLIST_HEADING), "no checklist heading when off");
  // Enabling the checklist is purely ADDITIVE: the off-output is a prefix of the on-output.
  const on = renderCapsuleV2Human(result, { enableSemanticEditHypothesis: false, enableEditSufficiencyChecklist: true });
  assert.ok(on.startsWith(explicitOff), "checklist is appended at the end (off-output is a prefix)");
});

// --- 12. rendering-only: builder/render does not mutate retrieval/candidate data ----

test("12. rendering-only: pivots/support are not mutated by build/render", () => {
  const pivots = SPHINX_PIVOTS.map((p) => ({ ...p }));
  const support = [item("support", "sphinx/util/h.py", "fmt", "def fmt(): ...")];
  const result = resultWith(pivots, support);
  const snapshot = JSON.stringify({ pivots: result.pivots, support: result.support });
  renderCapsuleV2Human(result, BOTH_ON);
  assert.equal(
    JSON.stringify({ pivots: result.pivots, support: result.support }),
    snapshot,
    "pivots/support unchanged — no retrieval/ranking/candidate mutation",
  );
});
