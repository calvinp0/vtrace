// Capsule v2 — edit-risk directive tests.
//
// The directive is a deterministic patch-planning hint that fires on the SHAPE of
// the pivot source + task prose (shared-state mutation while a combined query is
// rendered), never on a framework/file/symbol/instance id. These tests pin: the
// trigger conjunction, that the directive reaches both the human output and the
// Stage 5 injected context, that benign getter/setter code does NOT trigger it,
// and that the emitted text stays generic.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { classifyCapsuleV2Output } from "../../benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke";
import { detectEditRiskDirectives } from "./editRiskDirectives";
import { renderCapsuleV2Human } from "./renderHuman";
import {
  CapsuleIntent,
  CapsuleV2ContentMode,
  CapsuleV2Mode,
  type CapsuleV2Item,
  type CapsuleV2Result,
  type EditRiskDirective,
} from "./types";

// A composed-query bug: the pivot mutates an aliased compiler.query in place while
// rendering a combined query, behind a relaxable `if not X and Y:` guard.
const MUTATING_SOURCE = [
  "def get_combinator_sql(self, combinator, all):",
  "    compilers = [q.get_compiler(self.using) for q in self.query.combined_queries]",
  "    for compiler in compilers:",
  "        if not compiler.query.values_select and self.query.values_select:",
  "            compiler.query.set_values((*self.query.extra_select, *self.query.values_select))",
  "        part_sql, part_args = compiler.as_sql()",
  "    return combined_sql, combined_args",
].join("\n");

// A benign getter/setter pair: assigns an instance attribute, no shared query
// state, no combined-query rendering.
const BENIGN_SOURCE = [
  "def get_name(self):",
  "    return self._name",
  "",
  "def set_name(self, value):",
  "    self._name = value",
].join("\n");

// A task that describes composed/combined query output.
const COMPOSED_QUERY_TASK = [
  "instance: acme__widgets-4242",
  "repo: acme/widgets",
  "",
  "Composing a combined query via union() drops the selected columns: the",
  "combined query renders without the values_select the parts declared.",
].join("\n");

function pivotItem(source: string): CapsuleV2Item {
  return {
    role: "pivot",
    role_reason: "implementation that renders the combined query",
    is_entry_point: false,
    is_implementation_helper: false,
    is_generic_infrastructure: false,
    is_class_method_expansion_target: false,
    is_containing_class_context: false,
    is_query_builder_entrypoint: false,
    is_sql_rendering_implementation: true,
    path: "pkg/sql/render.py",
    fq_name: "pkg.sql.render.Renderer.get_combinator_sql",
    symbol: "get_combinator_sql",
    kind: "method",
    content_mode: CapsuleV2ContentMode.Full,
    source,
    evidence: ["renders the combined query"],
    scorecard: {
      lexical: 1, symbol: 1, path: 0, test_to_impl: 0, graph_proximity: 0,
      centrality: 0, actionability: 1, hub_penalty: 0, final: 2,
    },
    estimated_tokens: 100,
  };
}

// Wrap pivots + directives into a minimal, well-formed CapsuleV2Result so the
// rendering / Stage 5 paths can be exercised without the full build pipeline.
function resultWith(pivots: CapsuleV2Item[], directives: EditRiskDirective[]): CapsuleV2Result {
  return {
    intent: CapsuleIntent.Debug,
    actual_mode: CapsuleV2Mode.Standard,
    budget: { max_tokens: 8_000, estimated_tokens: 100, used_percent: 1.25 },
    pivots,
    support: [],
    discarded: [],
    diagnostics: {
      intent_reason: ["debug"],
      intent_confidence: "high",
      strategy: { candidate_generators: [], role_policy: "debug_refinement", budget_policy: "standard" },
      candidate_count: 1,
      pivot_count: pivots.length,
      support_count: 0,
      discarded_count: 0,
      tier: CapsuleV2Mode.Standard,
      weights: {},
      likely_files: [],
      likely_symbols: [],
      failing_tests: [],
      ...(directives.length > 0 ? { edit_risk_directives: directives } : {}),
    },
  };
}

test("a mutating pivot + composed-query task emits a shared_state_mutation directive", () => {
  const directives = detectEditRiskDirectives({
    task: COMPOSED_QUERY_TASK,
    pivots: [pivotItem(MUTATING_SOURCE)],
    debugRefinement: true,
  });

  assert.equal(directives.length, 1);
  const directive = directives[0]!;
  assert.equal(directive.kind, "shared_state_mutation");
  assert.equal(directive.confidence, "medium");
  assert.match(directive.reason, /mutates compiler\/query state/);
  assert.match(directive.reason, /composed\/combined query/);
});

test("the directive appears in the rendered human output, near the pivot", () => {
  const directives = detectEditRiskDirectives({
    task: COMPOSED_QUERY_TASK,
    pivots: [pivotItem(MUTATING_SOURCE)],
    debugRefinement: true,
  });
  const human = renderCapsuleV2Human(resultWith([pivotItem(MUTATING_SOURCE)], directives));

  assert.match(human, /^## Edit risk \/ patch hint$/m);
  assert.match(human, /clone\/copy state before calling mutating helpers/);
  // It sits after the pivot it concerns.
  assert.ok(
    human.indexOf("## Edit risk / patch hint") > human.indexOf("get_combinator_sql"),
    "the directive must render after the pivot source it warns about",
  );
});

test("the directive appears in the Stage 5 injected snapshot", () => {
  const directives = detectEditRiskDirectives({
    task: COMPOSED_QUERY_TASK,
    pivots: [pivotItem(MUTATING_SOURCE)],
    debugRefinement: true,
  });
  // Stage 5 re-renders the v2 result through renderCapsuleV2Human and injects the
  // returned `context`. Exercise that exact path.
  const classification = classifyCapsuleV2Output(resultWith([pivotItem(MUTATING_SOURCE)], directives));

  assert.equal(classification.policyAction, "inject");
  assert.match(classification.context, /## Edit risk \/ patch hint/);
  assert.match(classification.context, /clone\/copy state before calling mutating helpers/);
});

test("benign getter/setter code emits no directive, even under a composed-query task", () => {
  const directives = detectEditRiskDirectives({
    task: COMPOSED_QUERY_TASK,
    pivots: [pivotItem(BENIGN_SOURCE)],
    debugRefinement: true,
  });
  assert.equal(directives.length, 0);

  const human = renderCapsuleV2Human(resultWith([pivotItem(BENIGN_SOURCE)], directives));
  assert.doesNotMatch(human, /Edit risk \/ patch hint/);
});

test("a non-debug intent does not emit the directive", () => {
  const directives = detectEditRiskDirectives({
    task: COMPOSED_QUERY_TASK,
    pivots: [pivotItem(MUTATING_SOURCE)],
    debugRefinement: false,
  });
  assert.equal(directives.length, 0);
});

test("a task without composed-query signals does not emit the directive", () => {
  const directives = detectEditRiskDirectives({
    task: "instance: acme__widgets-1\nrepo: acme/widgets\n\nFix a typo in the docstring.",
    pivots: [pivotItem(MUTATING_SOURCE)],
    debugRefinement: true,
  });
  assert.equal(directives.length, 0);
});

test("the directive text is generic — no instance ids or hardcoded framework paths", () => {
  const directives = detectEditRiskDirectives({
    task: COMPOSED_QUERY_TASK,
    pivots: [pivotItem(MUTATING_SOURCE)],
    debugRefinement: true,
  });
  const directive = directives[0]!;
  const corpus = `${directive.directive}\n${directive.reason}`.toLowerCase();

  for (const banned of [
    "django",
    "11490",
    "get_combinator_sql",
    "compiler.py",
    "sql/compiler",
    "acme",
    "widgets",
    "values_select",
  ]) {
    assert.ok(!corpus.includes(banned), `directive text must not mention "${banned}"`);
  }
});
