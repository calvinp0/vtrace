// Capsule v2 — edit-risk directive tests.
//
// The directive is a deterministic patch-planning hint that fires on the SHAPE of
// the pivot source + task prose, never on a framework/file/symbol/instance id.
// Two diagnoses with precedence: a GUARDED shared-state mutation (`if not X and
// Y:` then `X.mutating_call(...)` — the `django-11490` regression shape) takes
// priority over a bare shared-state mutation. These tests pin the trigger
// conjunctions, that the directive reaches both the human output and the Stage 5
// injected context, that benign / guard-only code does NOT trigger it, and that
// the emitted text stays generic.

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

// A composed-query bug, get_combinator_sql shape: the pivot mutates an aliased
// compiler.query in place UNDER a relaxable `if not X and Y:` guard.
const GUARDED_SOURCE = [
  "def get_combinator_sql(self, combinator, all):",
  "    compilers = [q.get_compiler(self.using) for q in self.query.combined_queries]",
  "    for compiler in compilers:",
  "        if not compiler.query.values_select and self.query.values_select:",
  "            compiler.query.set_values((*self.query.extra_select, *self.query.values_select))",
  "        part_sql, part_args = compiler.as_sql()",
  "    return combined_sql, combined_args",
].join("\n");

// The same shared-state mutation, but with NO guard around it — the bare-mutation
// fallback diagnosis, not the guarded one.
const UNGUARDED_SOURCE = [
  "def set_combined_columns(self, compiler):",
  "    compiler.query.set_values((*self.query.extra_select, *self.query.values_select))",
  "    return compiler.as_sql()",
].join("\n");

// A guard with a BENIGN body — no shared-state mutation. Unrelated guarded code
// must not trigger the directive even under a composed-query task.
const GUARD_ONLY_SOURCE = [
  "def should_render(self, compiler):",
  "    if not compiler.is_ready and self.is_ready:",
  "        return False",
  "    return True",
].join("\n");

// A benign getter/setter pair: assigns an instance attribute, no shared query
// state, no guard.
const BENIGN_SOURCE = [
  "def get_name(self):",
  "    return self._name",
  "",
  "def set_name(self, value):",
  "    self._name = value",
].join("\n");

// A task that describes composed/combined query output and the mutation-leak
// symptom ("cannot change", "same columns").
const COMPOSED_QUERY_TASK = [
  "instance: acme__widgets-4242",
  "repo: acme/widgets",
  "",
  "Composed queries cannot change the same columns: composing a combined query",
  "via union() leaks the wrong values across the combined query parts.",
].join("\n");

// A chained lookup/path traversal: the pivot loops over split path segments and
// resolves each to a concrete field, following relations to the next hop. The
// `pk` alias segment is the trap — the tempting wrong fix is `continue`.
const TRAVERSAL_SOURCE = [
  "def _check_ordering(cls):",
  "    for part in field.split(LOOKUP_SEP):",
  "        fld = _cls._meta.get_field(part)",
  "        if fld.is_relation:",
  "            _cls = fld.get_path_info()[-1].to_opts.model",
  "    return errors",
].join("\n");

// A plain loop over split strings: a segment loop with NO field-resolution helper.
// It must NOT trigger the traversal directive even under a traversal task.
const PLAIN_SPLIT_LOOP_SOURCE = [
  "def join_words(text):",
  "    result = []",
  "    for word in text.split(' '):",
  "        result.append(word.strip())",
  "    return ' '.join(result)",
].join("\n");

// A task describing a chained lookup over a related-field path with a `pk` alias
// segment and the `__` lookup separator the issue prose uses.
const TRAVERSAL_TASK = [
  "instance: acme__widgets-7777",
  "repo: acme/widgets",
  "",
  "Ordering by a related field path like author__profile__pk raises on the",
  "nonexistent field because the lookup traversal mishandles the pk segment.",
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

function detectFor(source: string, task = COMPOSED_QUERY_TASK, debugRefinement = true): EditRiskDirective[] {
  return detectEditRiskDirectives({ task, pivots: [pivotItem(source)], debugRefinement });
}

test("a guarded compiler.query.set_values + composed task emits guarded_shared_state_mutation", () => {
  const directives = detectFor(GUARDED_SOURCE);

  assert.equal(directives.length, 1);
  const directive = directives[0]!;
  assert.equal(directive.kind, "guarded_shared_state_mutation");
  assert.equal(directive.confidence, "medium");
  assert.match(directive.reason, /mutates shared\/query state under a guard/);
  assert.match(directive.reason, /composed\/combined query/);
});

test("the guarded directive appears in the rendered human output, near the pivot", () => {
  const directives = detectFor(GUARDED_SOURCE);
  const human = renderCapsuleV2Human(resultWith([pivotItem(GUARDED_SOURCE)], directives));

  assert.match(human, /^## Edit risk \/ patch hint$/m);
  assert.match(human, /mutates shared state under a guard/);
  assert.match(human, /preserving guard semantics/);
  assert.match(human, /clone\/copy state before calling mutating helpers/);
  // It sits after the pivot it concerns.
  assert.ok(
    human.indexOf("## Edit risk / patch hint") > human.indexOf("get_combinator_sql"),
    "the directive must render after the pivot source it warns about",
  );
});

test("the guarded directive appears in the Stage 5 injected snapshot", () => {
  const directives = detectFor(GUARDED_SOURCE);
  // Stage 5 re-renders the v2 result through renderCapsuleV2Human and injects the
  // returned `context`. Exercise that exact path.
  const classification = classifyCapsuleV2Output(resultWith([pivotItem(GUARDED_SOURCE)], directives));

  assert.equal(classification.policyAction, "inject");
  assert.match(classification.context, /## Edit risk \/ patch hint/);
  assert.match(classification.context, /relaxing\/removing the guard/);
  assert.match(classification.context, /clone\/copy state before calling mutating helpers/);
});

test("unrelated guarded code (guard with a benign body) emits no directive", () => {
  const directives = detectFor(GUARD_ONLY_SOURCE);
  assert.equal(directives.length, 0);

  const human = renderCapsuleV2Human(resultWith([pivotItem(GUARD_ONLY_SOURCE)], directives));
  assert.doesNotMatch(human, /Edit risk \/ patch hint/);
});

test("an unguarded shared-state mutation still emits the bare shared_state_mutation directive", () => {
  const directives = detectFor(UNGUARDED_SOURCE);
  assert.equal(directives.length, 1);
  assert.equal(directives[0]!.kind, "shared_state_mutation");
});

test("benign getter/setter code emits no directive, even under a composed-query task", () => {
  const directives = detectFor(BENIGN_SOURCE);
  assert.equal(directives.length, 0);
});

test("a non-debug intent does not emit the directive", () => {
  const directives = detectFor(GUARDED_SOURCE, COMPOSED_QUERY_TASK, false);
  assert.equal(directives.length, 0);
});

test("a task without composed-query / leak signals does not emit the directive", () => {
  const directives = detectFor(GUARDED_SOURCE, "instance: acme__widgets-1\n\nFix a typo in the docstring.");
  assert.equal(directives.length, 0);
});

test("the guarded directive text is generic — no instance ids or hardcoded framework paths", () => {
  const directive = detectFor(GUARDED_SOURCE)[0]!;
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

test("a split-segment loop that resolves fields + a traversal task emits chained_lookup_alias_traversal", () => {
  const directives = detectFor(TRAVERSAL_SOURCE, TRAVERSAL_TASK);

  assert.equal(directives.length, 1);
  const directive = directives[0]!;
  assert.equal(directive.kind, "chained_lookup_alias_traversal");
  // The task names a `pk` alias token next to a split-segment loop — the strong
  // trigger.
  assert.equal(directive.confidence, "high");
  assert.match(directive.reason, /alias/);
  assert.match(directive.reason, /split path segments/);
});

test("the traversal directive appears in the rendered human output, near the pivot", () => {
  const directives = detectFor(TRAVERSAL_SOURCE, TRAVERSAL_TASK);
  const human = renderCapsuleV2Human(resultWith([pivotItem(TRAVERSAL_SOURCE)], directives));

  assert.match(human, /^## Edit risk \/ patch hint$/m);
  assert.match(human, /chained lookup\/path traversal/);
  assert.match(human, /do not skip alias segments outright/);
  assert.match(human, /Resolve aliases to their concrete field\/target/);
  assert.match(human, /clear the traversal cursor/);
  assert.match(human, /later path segments still fail correctly/);
  assert.ok(
    human.indexOf("## Edit risk / patch hint") > human.indexOf("_check_ordering"),
    "the directive must render after the pivot source it warns about",
  );
});

test("the traversal directive appears in the Stage 5 injected snapshot", () => {
  const directives = detectFor(TRAVERSAL_SOURCE, TRAVERSAL_TASK);
  const classification = classifyCapsuleV2Output(resultWith([pivotItem(TRAVERSAL_SOURCE)], directives));

  assert.equal(classification.policyAction, "inject");
  assert.match(classification.context, /## Edit risk \/ patch hint/);
  assert.match(classification.context, /chained lookup\/path traversal/);
  assert.match(classification.context, /do not skip alias segments outright/);
  assert.match(classification.context, /Resolve aliases to their concrete field\/target/);
});

test("a plain loop over split strings (no field resolution) emits no traversal directive", () => {
  const directives = detectFor(PLAIN_SPLIT_LOOP_SOURCE, TRAVERSAL_TASK);
  assert.equal(directives.length, 0);
});

test("a task mentioning pk without a traversal source emits no traversal directive", () => {
  // BENIGN_SOURCE has no split-segment loop or resolution helper, so even a task
  // that names `pk` must not trigger the traversal directive.
  const pkTask = "instance: acme__widgets-9\n\nThe pk of the model is wrong somewhere.";
  const directives = detectFor(BENIGN_SOURCE, pkTask);
  assert.equal(directives.length, 0);
});

test("the traversal directive text is generic — no instance ids or gold-patch tokens", () => {
  const directive = detectFor(TRAVERSAL_SOURCE, TRAVERSAL_TASK)[0]!;
  const corpus = directive.directive.toLowerCase();

  for (const banned of [
    "django",
    "11820",
    "models.e015",
    "_check_ordering",
    "to_opts.model",
    "get_path_info",
    "_meta.pk",
    "aggregates",
    "acme",
    "widgets",
    "continue",
  ]) {
    assert.ok(!corpus.includes(banned), `directive text must not mention "${banned}"`);
  }
});
