import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "bun:test";

// M93A product-honesty guards. These lock the two tracked product-truth docs so a
// future edit cannot silently reintroduce the stale `vexb` brand or drop the core
// honesty surfaces. Intentionally coarse (existence + a few required phrases) to
// avoid brittle full-content snapshots.

const DOCS_DIR = path.resolve(import.meta.dir, "..", "docs");
const REPO_ROOT = path.resolve(import.meta.dir, "..");

function readDoc(name: string): string {
  return readFileSync(path.join(DOCS_DIR, name), "utf8");
}

function readRepoFile(name: string): string {
  return readFileSync(path.join(REPO_ROOT, name), "utf8");
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

// M93B README token-claim guards. Keep the README's token-reduction claim honest:
// measured downstream agent-side, not a tokenizer-accurate budget, and not a pure
// deterministic-core / SWE-bench claim.
test("README token-reduction claim stays qualified and traceable", () => {
  const readme = readRepoFile("README.md");
  // The old untraceable "74%" headline must not come back.
  assert.equal(/74\s*%/.test(readme), false, "README must not resurrect the untraceable 74% figure");
  // No stale brand.
  assert.equal(/vexb/i.test(readme), false, "README must not contain stale `vexb`");
  // If the README talks about tokens, it must disclose the character-based budgeter
  // and the chars/4 estimate rather than implying tokenizer-accurate packing.
  if (/token/i.test(readme)) {
    assert.match(readme, /character-based/, "README must state budgeting is character-based");
    assert.match(readme, /chars\/4/, "README must state tokens are a chars/4 estimate");
    assert.match(readme, /downstream agent/i, "README must frame token savings as measured downstream agent-side");
  }
  // Stage 5 must be framed as integrated downstream validation, not a pure core benchmark.
  assert.match(readme, /integrated downstream validation/i);
  assert.match(readme, /not a public SWE-bench pass@1 claim/i);
  // V4/C7_D must be described as default-off diagnostics that are NOT the token-reduction
  // mechanism, never promoted as a core/default reduction feature.
  assert.match(readme, /default-off diagnostics/i);
  assert.match(readme, /not the token-reduction mechanism/i);
});

test("M94_DETERMINISTIC_SCOREBOARD_PLAN.md exists and states its no-live-agents non-goals", () => {
  const doc = readDoc("M94_DETERMINISTIC_SCOREBOARD_PLAN.md");
  assert.equal(/vexb/i.test(doc), false, "M94 plan must not contain stale `vexb`");
  assert.match(doc, /gold_file_recall/);
  assert.match(doc, /[Nn]o live agents/);
  assert.match(doc, /[Nn]o Docker/);
});
