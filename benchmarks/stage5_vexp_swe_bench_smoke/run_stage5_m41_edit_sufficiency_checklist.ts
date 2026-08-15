// M41 offline validation — edit-sufficiency checklist render matrix + accounting.
//
// PURE, offline, read-only: no agent, no Docker, no SWE-bench evaluation. It exercises
// the rendering-only checklist over representative fixtures (the sphinx paired-`unparse`
// shape, plus seaborn / django / no-context / single-pivot negatives) under the flag
// matrix, recomputes the M34 accounting split, and anchors against the M40 treatment
// captured context (which already shows the builder fires on the real instance). It
// references no gold/oracle data. Writes results/stage5_m41_edit_sufficiency_checklist.json.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { renderCapsuleV2Human } from "../../src/capsuleV2/renderHuman";
import {
  EDIT_SUFFICIENCY_CHECKLIST_HEADING,
  SEMANTIC_EDIT_HYPOTHESIS_HEADING,
} from "../../src/capsuleV2/semanticEditHypothesis";
import { buildProductV2Accounting } from "./m34_accounting";
import {
  CapsuleIntent,
  CapsuleV2ContentMode,
  CapsuleV2Mode,
  type CapsuleV2Item,
  type CapsuleV2Result,
  type CapsuleV2Scorecard,
} from "../../src/capsuleV2/types";

const ZERO_SCORECARD: CapsuleV2Scorecard = {
  lexical: 0, symbol: 1, path: 0, test_to_impl: 0, body_literal: 0,
  graph_proximity: 0, centrality: 0, actionability: 0, hub_penalty: 0, direct_answer: 0,
    mechanism_evidence: 0, final: 1,
};

function item(role: "pivot" | "support", p: string, symbol: string, source?: string): CapsuleV2Item {
  return {
    role, role_reason: "fixture", path: p, fq_name: `${p}::${symbol}`, symbol,
    kind: "function", content_mode: CapsuleV2ContentMode.Full, source,
    evidence: ["fixture"], scorecard: ZERO_SCORECARD, estimated_tokens: 1,
    is_entry_point: false, is_implementation_helper: false, is_generic_infrastructure: false,
    is_class_method_expansion_target: false, is_containing_class_context: false,
    is_query_builder_entrypoint: false, is_sql_rendering_implementation: false,
  };
}

function full(pivots: CapsuleV2Item[], support: CapsuleV2Item[] = []): CapsuleV2Result {
  return {
    intent: CapsuleIntent.Debug, actual_mode: CapsuleV2Mode.Full,
    budget: { estimated_tokens: 100, max_tokens: 8_000 },
    pivots, support, discarded: [],
    diagnostics: { intent_confidence: "high", intent_reason: [], strategy: { role_policy: "debug_refinement" } } as unknown as CapsuleV2Result["diagnostics"],
  } as CapsuleV2Result;
}
function noContext(): CapsuleV2Result {
  return {
    intent: CapsuleIntent.Debug, actual_mode: CapsuleV2Mode.NoContext, reason: "no high-confidence edit target recovered",
    budget: { estimated_tokens: 0, max_tokens: 8_000 }, pivots: [], support: [], discarded: [],
    diagnostics: { intent_confidence: "low", intent_reason: [], strategy: { role_policy: "debug_refinement" } } as unknown as CapsuleV2Result["diagnostics"],
  } as CapsuleV2Result;
}

const SPHINX = full(
  [
    item("pivot", "sphinx/domains/python.py", "_parse_annotation",
      ["def _parse_annotation(annotation):", "    def unparse(node):", "        elif isinstance(node, ast.Tuple):",
       "            result = []", "            for elem in node.elts:", "                result.extend(unparse(elem))",
       "            result.pop()", "            return result"].join("\n")),
    item("pivot", "sphinx/pycode/ast.py", "unparse",
      ["def unparse(node):", "    elif isinstance(node, ast.Tuple):", '        return ", ".join(unparse(e) for e in node.elts)'].join("\n")),
  ],
  [item("support", "sphinx/util/inspect.py", "stringify_annotation", "def stringify_annotation(annotation): ...")],
);
const SEABORN = full([
  item("pivot", "examples/grouped_barplot.py", "penguins", "def penguins(): ..."),
  item("pivot", "examples/joint_kde.py", "penguins", "def penguins(): ..."),
]);
const DJANGO = full([
  item("pivot", "django/http/response.py", "delete_cookie", "def delete_cookie(self): ..."),
  item("pivot", "django/http/cookie.py", "load", "def load(self): ..."),
]);
const SINGLE = full([item("pivot", "sphinx/pycode/ast.py", "unparse", "def unparse(node): ...")]);

const BOTH_ON = { enableSemanticEditHypothesis: true, enableEditSufficiencyChecklist: true };
const BOTH_OFF = { enableSemanticEditHypothesis: false, enableEditSufficiencyChecklist: false };

interface Case { name: string; result: CapsuleV2Result; expectChecklist: boolean; }
const CASES: Case[] = [
  { name: "sphinx-doc__sphinx-7462 (paired unparse)", result: SPHINX, expectChecklist: true },
  { name: "mwaskom__seaborn-3187 (non-paired data symbol)", result: SEABORN, expectChecklist: false },
  { name: "django-13195 (unrelated multi-file)", result: DJANGO, expectChecklist: false },
  { name: "no-context", result: noContext(), expectChecklist: false },
  { name: "single-pivot localized", result: SINGLE, expectChecklist: false },
];

const CHECKLIST_ONLY = { enableSemanticEditHypothesis: false, enableEditSufficiencyChecklist: true };

const rows = CASES.map((c) => {
  const on = renderCapsuleV2Human(c.result, BOTH_ON);
  const off = renderCapsuleV2Human(c.result, BOTH_OFF);
  const checklistOnly = renderCapsuleV2Human(c.result, CHECKLIST_ONLY);
  const checklistRendered = on.includes(EDIT_SUFFICIENCY_CHECKLIST_HEADING);
  const acc = buildProductV2Accounting(on, 50);
  const checklistAt = on.indexOf(EDIT_SUFFICIENCY_CHECKLIST_HEADING);
  const topAt = on.indexOf(SEMANTIC_EDIT_HYPOTHESIS_HEADING);
  return {
    case: c.name,
    expectChecklist: c.expectChecklist,
    checklistRendered,
    matchesExpectation: checklistRendered === c.expectChecklist,
    mentionsBothImpls: checklistRendered
      && on.includes("sphinx/domains/python.py::unparse") && on.includes("sphinx/pycode/ast.py::unparse"),
    mentionsOutputCorrectness: checklistRendered && /correct output/i.test(on) && /only because it avoids the crash/i.test(on),
    placedAfterTopSection: checklistRendered ? checklistAt > topAt : null,
    placedAfterSourceBodies: checklistRendered ? checklistAt > on.indexOf("result.pop()") : null,
    // Additive proof: enabling ONLY the checklist appends to the off-output (off is a
    // prefix). Isolates the checklist delta from the mid-document M39 top section.
    checklistIsPureAppend: checklistOnly.startsWith(off),
    semanticEditHypothesisTokens: acc.semanticEditHypothesisTokens,
    editSufficiencyChecklistTokens: acc.editSufficiencyChecklistTokens,
    editSufficiencyChecklistChars: acc.editSufficiencyChecklistChars,
    combinedAddedTokens: (acc.semanticEditHypothesisTokens ?? 0) + (acc.editSufficiencyChecklistTokens ?? 0),
  };
});

// Real-data anchor: the M40 treatment captured context proves the builder produces the
// `unparse` group on the real instance (the checklist keys off the same group).
const RESULTS = path.join(import.meta.dir, "results");
const anchorPath = path.join(RESULTS, "runs", "eval-m40-treatment-sphinx-7462-r1", "raw", "vtrace", "_capsule_v2_context.md");
let anchor: Record<string, unknown> = { available: false };
if (existsSync(anchorPath)) {
  const ctx = readFileSync(anchorPath, "utf8");
  anchor = {
    available: true,
    path: path.relative(process.cwd(), anchorPath),
    m39HypothesisHeadingPresent: ctx.includes(SEMANTIC_EDIT_HYPOTHESIS_HEADING),
    mentionsPythonUnparse: ctx.includes("sphinx/domains/python.py::unparse"),
    mentionsAstUnparse: ctx.includes("sphinx/pycode/ast.py::unparse"),
    note: "M40 was rendered BEFORE the M41 checklist existed; this anchor confirms the shared builder fires on the real instance, so the M41 checklist (keyed off the same group) would render there.",
  };
}

const checklistText = (() => {
  const on = renderCapsuleV2Human(SPHINX, BOTH_ON);
  const start = on.indexOf(EDIT_SUFFICIENCY_CHECKLIST_HEADING);
  return start >= 0 ? on.slice(start).split("\n").slice(0, 12).join("\n") : null;
})();

const allPass = rows.every((r) => r.matchesExpectation)
  && rows.every((r) => r.checklistIsPureAppend)
  && (rows.find((r) => r.case.startsWith("sphinx"))?.mentionsOutputCorrectness === true);

const out = {
  milestone: "M41",
  generated: "(timestamp stamped by caller)",
  allPass,
  renderedChecklistSphinx: checklistText,
  matrix: rows,
  realDataAnchor: anchor,
};

mkdirSync(RESULTS, { recursive: true });
writeFileSync(path.join(RESULTS, "stage5_m41_edit_sufficiency_checklist.json"), JSON.stringify(out, null, 2) + "\n");
// eslint-disable-next-line no-console
console.log(JSON.stringify(out, null, 2));
