import assert from "node:assert/strict";
import { test } from "bun:test";

import { SymbolKind } from "../domain/types";
import { buildCapsuleV2 } from "./buildCapsuleV2";
import { seedCustomFixture, type SymbolSpec } from "./__fixtures__/capsuleV2Fixture";
import { CapsuleIntent } from "./types";

/**
 * The pivot plan and the tier cap (M208).
 *
 * The tier decides HOW MANY edit sites a request may be told to consider; it
 * must not decide WHICH one leads. Until M208 the cap ran in final-score order
 * inside the role layer and the pivot order (anchor tiers / pivot-ranking v2)
 * ran afterwards on the capped set, so a wider tier could admit a candidate the
 * order ranked above the old lead and the delivered focus changed with the
 * budget. The cap is now a prefix of the one ordered plan.
 */
const TASK = "how does the widget registry resolve a widget handler for a name";

function fixture() {
  const files: { relPath: string; specs: readonly SymbolSpec[] }[] = [];
  // A large implementation function (v2's broad-snippet penalty territory) and
  // several smaller pivot-worthy targets in distinct files.
  const bigBody = `def resolve_widget_handler(registry, name):\n${"    # widget registry handler resolution step\n".repeat(60)}    return registry.handlers.get(name)`;
  files.push({ relPath: "widgets/resolve.py", specs: [
    { localName: "resolve_widget_handler", kind: SymbolKind.Function, signature: "resolve_widget_handler(registry, name)", body: bigBody },
  ] });
  files.push({ relPath: "widgets/registry.py", specs: [
    { localName: "WidgetRegistry", kind: SymbolKind.Class, docstring: "Registry of widget handlers by name.", body: 'class WidgetRegistry:\n    """Registry of widget handlers by name."""' },
    { localName: "widget_handler_for_name", kind: SymbolKind.Method, parentLocalName: "WidgetRegistry", signature: "widget_handler_for_name(self, name)",
      body: "    def widget_handler_for_name(self, name):\n        # resolve widget handler name\n        return self.handlers[name]" },
  ] });
  for (let k = 0; k < 4; k += 1) {
    files.push({ relPath: `widgets/lanes/lane_${k}.py`, specs: [
      { localName: `resolve_widget_handler_${k}`, kind: SymbolKind.Function, signature: `resolve_widget_handler_${k}(registry, name)`,
        body: `def resolve_widget_handler_${k}(registry, name):\n    # widget registry handler resolution ${k}\n    return registry.resolve_widget_handler(name)` },
    ] });
  }
  return seedCustomFixture(files);
}

const build = (f: { db: any; repoRoot: string }, maxTokens: number) =>
  buildCapsuleV2({ db: f.db, repoRoot: f.repoRoot, task: TASK, intent: CapsuleIntent.Explain, maxTokens });

test("the smaller tier's pivots are a prefix of the larger tier's plan, so the lead never changes with the budget", () => {
  const f = fixture();
  const results = [1000, 2000, 4000, 8000, 16000].map((budget) => ({ budget, result: build(f, budget) }));
  const leads = results.map((r) => r.result.pivots[0]?.fq_name);
  assert.ok(leads.every((lead) => lead !== undefined && lead === leads[0]), `lead changed with the budget: ${leads.join(" | ")}`);
  for (let i = 1; i < results.length; i += 1) {
    const lo = results[i - 1]!.result.pivots.map((p) => p.fq_name);
    const hi = results[i]!.result.pivots.map((p) => p.fq_name);
    assert.deepEqual(hi.slice(0, lo.length), lo, `${results[i - 1]!.budget} -> ${results[i]!.budget}: pivots are not a prefix`);
  }
  assert.equal(results[0]!.result.pivots.length, 1);
  assert.ok(results.at(-1)!.result.pivots.length >= 2);
});

test("a pivot-worthy candidate beyond the cap is demoted with the historical reason and reaches support", () => {
  const f = fixture();
  const micro = build(f, 1000);
  const demoted = micro.support.filter((s) => /^strong target but beyond the pivot budget — pivot: /.test(s.role_reason));
  assert.ok(demoted.length >= 1, "expected cap-demoted support entries at the micro tier");
  const full = build(f, 16000);
  // Every entry the micro cap demoted is a pivot or support at the full tier, in the plan's order.
  const fullPivots = full.pivots.map((p) => p.fq_name);
  for (const entry of demoted) {
    assert.ok(fullPivots.includes(entry.fq_name) || full.support.some((s) => s.fq_name === entry.fq_name), `${entry.fq_name} vanished at the full tier`);
  }
});
