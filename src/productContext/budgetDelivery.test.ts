import assert from "node:assert/strict";
import { test } from "bun:test";

import { applyProgressiveContextBudget, CompactionStage } from "./budgetDelivery";

/**
 * The selection-reason contract (M181).
 *
 * `selectionReasons` is not a bag of interchangeable justifications. The assembly
 * layer builds it as `unique([roleReason, ...evidence])` and `roleReason` is
 * declared at its definition as "The decisive reason this item landed in its
 * role"; `projectRunPipelineOrientation` then reuses position 0 verbatim as the
 * relationship claim the agent is told. Compaction may SHORTEN that array. It may
 * not RESELECT within it — doing so made which authoritative claim reached the
 * agent depend on whether the response happened to be compacted.
 *
 * This file exists because `budgetDelivery.ts` had no test of its own, which is
 * how a second, undeclared reason selector lived here for two milestones.
 */

const SCORER_DIAGNOSTIC = "preferred contrast side matched: alpha, beta, gamma (+0.24)";
const DECISIVE = "entry point/caller delegating to local helpers — the edit site is the helper it calls";

/** A draft heavy enough that the budget cannot be met without compacting. */
function draftWith(reasons: string[]): Record<string, unknown> {
  const body = `def target(self):\n${"    # body line\n".repeat(60)}    return None`;
  const items = [
    {
      id: "T", fqName: "pkg/mod.py::target", path: "pkg/mod.py", symbol: "target",
      lineSpan: { start: 1, end: 61 }, roles: ["pivot", "required"], contentMode: "full",
      selectionReasons: reasons, content: body,
    },
    ...Array.from({ length: 6 }, (_unused, index) => ({
      id: `S${index + 1}`, fqName: `pkg/mod.py::support_${index + 1}`, path: "pkg/mod.py",
      symbol: `support_${index + 1}`, lineSpan: { start: 1, end: 61 }, roles: ["support"],
      contentMode: "full", selectionReasons: [`selected as support ${index + 1}`], content: body,
    })),
  ];
  const modelVisibleContext = [
    "# VTRACE product context",
    ...items.flatMap((item) => [
      "", `## [${item.id}] ${item.fqName}`, `roles: ${item.roles.join(", ")}`,
      `mode: ${item.contentMode}`, ...item.selectionReasons.map((reason) => `why: ${reason}`),
      "", item.content,
    ]),
  ].join("\n");
  return { productContext: { resolved: true, items, modelVisibleContext, leadPivot: "pkg/mod.py::target" } };
}

const reasonsOf = (draft: Record<string, unknown>): string[] => {
  const product = draft.productContext as Record<string, unknown>;
  const items = product.items as Array<Record<string, unknown>>;
  const target = items.find((item) => item.id === "T");
  return (target?.selectionReasons ?? []) as string[];
};

test("compaction keeps the decisive reason even when a later reason matches the answer-bearing vocabulary", () => {
  const draft = draftWith([DECISIVE, SCORER_DIAGNOSTIC, "3 indexed symbol(s) depend on this"]);
  const result = applyProgressiveContextBudget(draft, 400);

  assert.ok(result !== undefined);
  assert.ok(result.accounting.compactionStages.includes(CompactionStage.SelectionReasonsCompacted));
  // Reduced to one — and it is position 0, not the substring match.
  assert.deepEqual(reasonsOf(draft), [DECISIVE]);
});

test("compaction preserves position 0 when position 0 is itself the substring match", () => {
  const draft = draftWith([SCORER_DIAGNOSTIC, DECISIVE]);
  const result = applyProgressiveContextBudget(draft, 400);

  assert.ok(result !== undefined);
  assert.deepEqual(reasonsOf(draft), [SCORER_DIAGNOSTIC]);
});

test("a reason past the ellipsis bound is shortened, never swapped for a shorter sibling", () => {
  const long = `${DECISIVE} ${"and further qualifying detail ".repeat(12)}`.trim();
  const draft = draftWith([long, SCORER_DIAGNOSTIC]);
  const result = applyProgressiveContextBudget(draft, 400);

  assert.ok(result !== undefined);
  const [reason] = reasonsOf(draft);
  assert.ok(reason !== undefined);
  assert.equal(reason.length, 160);
  assert.ok(reason.endsWith("…"));
  assert.ok(long.startsWith(reason.slice(0, -1)));
});

test("an item with a single reason keeps it whatever its wording", () => {
  const draft = draftWith([SCORER_DIAGNOSTIC]);
  const result = applyProgressiveContextBudget(draft, 400);

  assert.ok(result !== undefined);
  assert.deepEqual(reasonsOf(draft), [SCORER_DIAGNOSTIC]);
});

test("compaction never invents a reason the authoritative set does not contain", () => {
  const authoritative = [DECISIVE, SCORER_DIAGNOSTIC, "3 indexed symbol(s) depend on this"];
  for (const budget of [100, 200, 400, 800, 1_600, 8_000]) {
    const draft = draftWith([...authoritative]);
    applyProgressiveContextBudget(draft, budget);
    for (const reason of reasonsOf(draft)) {
      const supported = authoritative.some((candidate) =>
        candidate === reason || (reason.endsWith("…") && candidate.startsWith(reason.slice(0, -1))));
      assert.ok(supported, `budget ${budget} produced an unsupported reason: ${reason}`);
    }
  }
});
