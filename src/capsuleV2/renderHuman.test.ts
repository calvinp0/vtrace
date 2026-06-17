// Tests for the multi-pivot / hidden-pivot edit guidance in the capsule v2 human
// render. These exercise wording/structure only — the underlying result comes from
// the real pipeline fixture, and no retrieval/scoring/role behaviour is touched.
//
// The guidance exists because a traceback usually names the file where an error
// SURFACED, not the file where the fix belongs. When the capsule carries more than
// one pivot — and one of them was not pointed at by the issue's source anchor — the
// agent should inspect it before finalizing, rather than editing only the
// traceback-named file.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildCapsuleV2 } from "./buildCapsuleV2";
import {
  MULTI_PIVOT_ACTION_PLAN_ENV,
  MULTI_PIVOT_ACTION_PLAN_HEADING,
} from "./multiPivotActionPlan";
import { renderCapsuleV2Human } from "./renderHuman";
import {
  CapsuleIntent,
  type CapsuleV2Item,
  type CapsuleV2Result,
} from "./types";
import {
  INLINES_TASK,
  seedCapsuleV2Fixture,
} from "./__fixtures__/capsuleV2Fixture";

const MULTI_PIVOT_HEADING = "## Multiple edit targets";
const MULTI_PIVOT_WARNING =
  "Multiple plausible edit targets were found. Treat this as a multi-file / "
  + "root-cause localization problem, not a single-traceback edit.";
const CHECKLIST_ITEM_1 = "1. Inspect every pivot listed below.";
const CHECKLIST_ITEM_2 =
  "2. Do not edit only the traceback-named file unless the other pivots are ruled out.";
const HIDDEN_MARKER = "  hidden candidate:";

// Words that would mean the render had leaked an evaluation-only label into the
// agent-facing context. The guidance must be phrased generically.
const GOLD_LABEL_LEAKS = ["gold", "expected_file", "expected file", "FAIL_TO_PASS", "decoy"];

function buildResult(maxTokens = 8_000): CapsuleV2Result {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  try {
    return buildCapsuleV2({ db, repoRoot, task: INLINES_TASK, intent: CapsuleIntent.Debug, maxTokens });
  } finally {
    db.close();
  }
}

// Clone a real pivot, overriding identity + the evidence/role_reason that drive the
// source-anchored vs hidden classification. `anchored` items carry the line-anchor
// markers the issue's source anchor produces; hidden items carry only inference.
function makePivot(base: CapsuleV2Item, path: string, symbol: string, anchored: boolean): CapsuleV2Item {
  return anchored
    ? {
        ...base,
        path,
        symbol,
        role_reason: "source line anchor in the issue points at this symbol — explicit edit site",
        evidence: [`source anchor ${path}#L10-L14 maps to enclosing symbol ${symbol}`],
      }
    : {
        ...base,
        path,
        symbol,
        role_reason: "actionable function — symbol-name match; issue-domain relevance",
        evidence: [
          "actionable function — symbol-name match; issue-domain relevance; 9 dependents",
          `symbol name matches "${symbol}"`,
        ],
      };
}

test("single pivot: no multi-pivot warning, checklist, or hidden marker", () => {
  const result = buildResult();
  assert.ok(result.pivots.length >= 1, "fixture should produce at least one pivot");
  const single: CapsuleV2Result = { ...result, pivots: result.pivots.slice(0, 1) };

  const human = renderCapsuleV2Human(single);

  assert.doesNotMatch(human, /## Multiple edit targets/);
  assert.ok(!human.includes(MULTI_PIVOT_WARNING), "no multi-pivot warning for a single pivot");
  assert.ok(!human.includes(CHECKLIST_ITEM_1), "no checklist for a single pivot");
  assert.ok(!human.includes(HIDDEN_MARKER), "no hidden marker for a single pivot");
  // The pivot itself still renders.
  assert.match(human, /^● pivot /m);
});

test("multiple pivots get the edit-target checklist and warning", () => {
  const result = buildResult();
  const base = result.pivots[0]!;
  const anchored = makePivot(base, "pkg/surface.py", "raise_here", true);
  const hidden = makePivot(base, "pkg/rootcause.py", "transform_value", false);
  const multi: CapsuleV2Result = { ...result, pivots: [anchored, hidden] };

  const human = renderCapsuleV2Human(multi);

  assert.ok(human.includes(MULTI_PIVOT_HEADING), "multi-pivot heading present");
  assert.ok(human.includes(MULTI_PIVOT_WARNING), "multi-pivot warning present");
  assert.ok(human.includes(CHECKLIST_ITEM_1), "checklist item 1 present");
  assert.ok(human.includes(CHECKLIST_ITEM_2), "checklist item 2 present");
  assert.match(human, /3\. If a non-traceback pivot explains/);
  assert.match(human, /4\. Prefer the smallest patch/);
  // The warning/checklist precede the pivot blocks.
  assert.ok(human.indexOf(MULTI_PIVOT_HEADING) < human.indexOf("● pivot pkg/surface.py"));
});

test("hidden (non-traceback) pivot gets an inspect-before-edit warning; anchored does not", () => {
  const result = buildResult();
  const base = result.pivots[0]!;
  const anchored = makePivot(base, "pkg/surface.py", "raise_here", true);
  const hidden = makePivot(base, "pkg/rootcause.py", "transform_value", false);
  const multi: CapsuleV2Result = { ...result, pivots: [anchored, hidden] };

  const human = renderCapsuleV2Human(multi);

  // Exactly one hidden-candidate note — for the non-anchored pivot only.
  const hiddenCount = human.split(HIDDEN_MARKER).length - 1;
  assert.equal(hiddenCount, 1, "exactly one hidden-candidate note (the non-anchored pivot)");
  assert.match(human, /Inspect it before finalizing the patch\./);

  // The note attaches AFTER the hidden pivot block, and the anchored pivot (which
  // comes first) is not flagged.
  const anchoredIdx = human.indexOf("● pivot pkg/surface.py::raise_here");
  const hiddenIdx = human.indexOf("● pivot pkg/rootcause.py::transform_value");
  const noteIdx = human.indexOf(HIDDEN_MARKER);
  assert.ok(anchoredIdx >= 0 && hiddenIdx >= 0 && noteIdx > hiddenIdx, "note follows the hidden pivot");
  // Nothing between the anchored pivot and the hidden pivot is a hidden note.
  assert.ok(noteIdx > anchoredIdx, "anchored pivot is not flagged hidden");

  // Guidance is inspect/rule-out, not an order to edit every pivot.
  assert.ok(!/edit (all|every) pivot/i.test(human), "must not command editing every pivot");
});

test("two inferred pivots: both flagged hidden when neither is source-anchored", () => {
  const result = buildResult();
  const base = result.pivots[0]!;
  const a = makePivot(base, "pkg/one.py", "alpha", false);
  const b = makePivot(base, "pkg/two.py", "beta", false);
  const multi: CapsuleV2Result = { ...result, pivots: [a, b] };

  const human = renderCapsuleV2Human(multi);
  const hiddenCount = human.split(HIDDEN_MARKER).length - 1;
  assert.equal(hiddenCount, 2, "both non-anchored pivots flagged in a multi-pivot capsule");
});

test("guidance wording does not leak any evaluation-only / gold labels", () => {
  const result = buildResult();
  const base = result.pivots[0]!;
  const multi: CapsuleV2Result = {
    ...result,
    pivots: [
      makePivot(base, "pkg/surface.py", "raise_here", true),
      makePivot(base, "pkg/rootcause.py", "transform_value", false),
    ],
  };

  const human = renderCapsuleV2Human(multi).toLowerCase();
  for (const leak of GOLD_LABEL_LEAKS) {
    assert.ok(!human.includes(leak.toLowerCase()), `rendered context must not contain "${leak}"`);
  }
});

// --- M36.1 Multi-Pivot Action Plan render toggle ---------------------------------

// A multi-pivot result that triggers the action plan (two non-anchored pivots).
function multiPivotResult(): CapsuleV2Result {
  const result = buildResult();
  const base = result.pivots[0]!;
  return {
    ...result,
    pivots: [
      makePivot(base, "pkg/surface.py", "raise_here", true),
      makePivot(base, "pkg/rootcause.py", "transform_value", false),
    ],
  };
}

// Run `fn` with VTRACE_ENABLE_MULTI_PIVOT_ACTION_PLAN set to `value`, then restore the
// previous value — so env changes never leak across tests (single-process bun test).
function withEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env[MULTI_PIVOT_ACTION_PLAN_ENV];
  if (value === undefined) delete process.env[MULTI_PIVOT_ACTION_PLAN_ENV];
  else process.env[MULTI_PIVOT_ACTION_PLAN_ENV] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[MULTI_PIVOT_ACTION_PLAN_ENV];
    else process.env[MULTI_PIVOT_ACTION_PLAN_ENV] = prev;
  }
}

test("toggle: default (unset env) renders the action plan when evidence exists", () => {
  withEnv(undefined, () => {
    const human = renderCapsuleV2Human(multiPivotResult());
    assert.ok(human.includes(MULTI_PIVOT_ACTION_PLAN_HEADING), "action plan present by default");
  });
});

test("toggle: explicit option=false suppresses the action plan (isolated)", () => {
  const human = renderCapsuleV2Human(multiPivotResult(), { enableMultiPivotActionPlan: false });
  assert.ok(!human.includes(MULTI_PIVOT_ACTION_PLAN_HEADING), "action plan suppressed by option");
});

test("toggle: env 0 / false / off suppress the action plan", () => {
  for (const v of ["0", "false", "off"]) {
    withEnv(v, () => {
      const human = renderCapsuleV2Human(multiPivotResult());
      assert.ok(!human.includes(MULTI_PIVOT_ACTION_PLAN_HEADING), `env=${v} suppresses the plan`);
    });
  }
});

test("toggle: truthy env preserves rendering", () => {
  withEnv("1", () => {
    const human = renderCapsuleV2Human(multiPivotResult());
    assert.ok(human.includes(MULTI_PIVOT_ACTION_PLAN_HEADING), "truthy env keeps the plan");
  });
});

test("toggle: single-pivot case omits the action plan regardless of env", () => {
  const result = buildResult();
  const single: CapsuleV2Result = { ...result, pivots: result.pivots.slice(0, 1) };
  for (const v of [undefined, "1", "0"]) {
    withEnv(v, () => {
      const human = renderCapsuleV2Human(single);
      assert.ok(!human.includes(MULTI_PIVOT_ACTION_PLAN_HEADING), `no plan for single pivot (env=${v})`);
    });
  }
});

test("toggle: disabling changes ONLY the action plan — pivots/sections are unchanged", () => {
  const result = multiPivotResult();
  const pivotsBefore = JSON.stringify(result.pivots);

  const on = renderCapsuleV2Human(result, { enableMultiPivotActionPlan: true });
  const off = renderCapsuleV2Human(result, { enableMultiPivotActionPlan: false });

  // The render does not mutate the result's pivots/candidates.
  assert.equal(JSON.stringify(result.pivots), pivotsBefore, "render must not mutate pivots");

  // Only difference: the action plan section. Every other section + pivot block is
  // byte-identical. Strip the leading action-plan block (it renders first, before
  // "## Multiple edit targets") from the enabled output and compare to disabled.
  assert.ok(on.includes(MULTI_PIVOT_ACTION_PLAN_HEADING));
  assert.ok(!off.includes(MULTI_PIVOT_ACTION_PLAN_HEADING));
  const planStart = on.indexOf(MULTI_PIVOT_ACTION_PLAN_HEADING);
  const nextSection = on.indexOf(MULTI_PIVOT_HEADING);
  const onWithoutPlan = (on.slice(0, planStart) + on.slice(nextSection)).trim();
  assert.equal(onWithoutPlan, off.trim(), "disabling removes only the action-plan section");

  // Both still carry the pivot blocks and the other multi-pivot sections.
  for (const text of [on, off]) {
    assert.match(text, /● pivot pkg\/surface\.py/);
    assert.match(text, /● pivot pkg\/rootcause\.py/);
    assert.ok(text.includes(MULTI_PIVOT_HEADING), "## Multiple edit targets still present");
  }
});
