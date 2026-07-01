import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "bun:test";

// M93A product-honesty guards. These lock the two tracked product-truth docs so a
// future edit cannot silently reintroduce the stale `vexb` brand or drop the core
// honesty surfaces. Intentionally coarse (existence + a few required phrases) to
// avoid brittle full-content snapshots.

const DOCS_DIR = path.resolve(import.meta.dir, "..", "docs");

function readDoc(name: string): string {
  return readFileSync(path.join(DOCS_DIR, name), "utf8");
}

test("current_product_state.md exists and carries no stale vexb brand", () => {
  const doc = readDoc("current_product_state.md");
  // `vexb` is the retired internal brand; `vexp`/`vexp-swe-bench` (external) is fine
  // and must not trip this guard.
  assert.equal(/vexb/i.test(doc), false, "current_product_state.md must not contain stale `vexb`");
  assert.match(doc, /vexp-swe-bench|expand_vexp_ref/, "external vexp references are still expected");
});

test("current_product_state.md documents the load-bearing honesty facts", () => {
  const doc = readDoc("current_product_state.md");
  // Character-based budget limitation is documented.
  assert.match(doc, /[Cc]haracter-based/);
  assert.match(doc, /CapsuleBudgetModel\.CharacterCount/);
  // search_logic_flow is not oversold as a runtime/semantic call tracer.
  assert.match(doc, /search_logic_flow/);
  assert.match(doc, /runtime\/semantic call-path tracer/i);
  // Capsule-manifest staleness and session compression are documented as wired.
  assert.match(doc, /check_capsule_staleness/);
  assert.match(doc, /compress-sessions/);
  // V4/C7_D are documented as default-off diagnostics, not the reduction path.
  assert.match(doc, /V4/);
  assert.match(doc, /C7_D/);
  assert.match(doc, /default-off/i);
});

test("M94_DETERMINISTIC_SCOREBOARD_PLAN.md exists and states its no-live-agents non-goals", () => {
  const doc = readDoc("M94_DETERMINISTIC_SCOREBOARD_PLAN.md");
  assert.equal(/vexb/i.test(doc), false, "M94 plan must not contain stale `vexb`");
  assert.match(doc, /gold_file_recall/);
  assert.match(doc, /[Nn]o live agents/);
  assert.match(doc, /[Nn]o Docker/);
});
