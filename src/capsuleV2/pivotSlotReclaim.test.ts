// M157-C — a candidate disqualified from the pivot role must release its slot.
//
// The pivot cap runs BEFORE the scoped-objective and non-source demotions, so a
// candidate those rules later disqualify keeps the slot it consumed, while a
// candidate that MET the pivot bar stays demoted behind a budget that is no
// longer spent. Measured on the M156 broad100 this empties an entire capsule:
// sphinx-9320 spends both standard slots on two `doc/conf.py` candidates, the
// non-source rule disqualifies both, and seventeen eligible edit targets —
// three of them gold symbols — are discarded as "no actionable edit target".
//
// The fixture reproduces that shape generically: two doc-tree candidates that
// outrank everything, and real source candidates that clear the pivot bar.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { SymbolKind } from "../domain/types";
import { buildCapsuleV2 } from "./buildCapsuleV2";
import { seedFile } from "./__fixtures__/capsuleV2Fixture";
import { CapsuleIntent, CapsuleV2Mode } from "./types";

const TASK =
  "quickstart prompt does not exit when a conf.py already exists. "
  + "The quickstart prompt loop should detect the existing conf.py and exit.";

/**
 * A repo whose two best-ranked candidates live under `doc/` (so the non-source
 * rule will disqualify them AFTER they have consumed the pivot budget), plus
 * real source candidates that clear the pivot bar.
 */
function seedDocTreeOutranksSource() {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "vtrace-m157-reclaim-"));
  const db = openIndexerDatabase();

  seedFile(db, repoRoot, "doc/conf.py", [
    {
      localName: "quickstart_prompt_exit",
      kind: SymbolKind.Function,
      signature: "def quickstart_prompt_exit(conf)",
      body: "def quickstart_prompt_exit(conf):\n    # quickstart prompt exit conf.py existing\n    return conf",
    },
    {
      localName: "quickstart_prompt_conf",
      kind: SymbolKind.Function,
      signature: "def quickstart_prompt_conf(conf)",
      body: "def quickstart_prompt_conf(conf):\n    # quickstart prompt conf.py exists detect\n    return conf",
    },
  ]);

  seedFile(db, repoRoot, "pkg/quickstart.py", [
    {
      localName: "quickstart_prompt_loop",
      kind: SymbolKind.Function,
      signature: "def quickstart_prompt_loop(conf)",
      body: "def quickstart_prompt_loop(conf):\n    # quickstart prompt loop exit existing conf\n    return conf",
    },
    {
      localName: "quickstart_detect_conf",
      kind: SymbolKind.Function,
      signature: "def quickstart_detect_conf(conf)",
      body: "def quickstart_detect_conf(conf):\n    # quickstart detect conf exists prompt\n    return conf",
    },
  ]);

  return { db, repoRoot };
}

function build(task = TASK) {
  const { db, repoRoot } = seedDocTreeOutranksSource();
  try {
    return buildCapsuleV2({ db, repoRoot, task, intent: CapsuleIntent.Auto, maxTokens: 8_000 });
  } finally {
    db.close();
  }
}

test("a pivot slot vacated by the non-source demotion is refilled from real source", () => {
  const result = build();

  assert.notEqual(result.actual_mode, CapsuleV2Mode.NoContext);
  assert.ok(result.pivots.length > 0, "expected the released slot to be filled");
  // Whatever else happens, a doc-tree candidate must never end up a pivot.
  for (const pivot of result.pivots) {
    assert.ok(
      !pivot.path.startsWith("doc/"),
      `non-source candidate ${pivot.path} must never hold a pivot slot`,
    );
  }
});

test("reclaiming a slot is reported, and only reports candidates it actually promoted", () => {
  const result = build();

  const reclaimed = result.diagnostics.reclaimed_pivot_slots ?? [];
  assert.ok(reclaimed.length > 0, "expected the reclaim to be reported");
  assert.ok(reclaimed.length <= result.pivots.length);
  const pivotIdentities = new Set(result.pivots.map((item) => `${item.path}::${item.symbol}`));
  for (const entry of reclaimed) {
    assert.ok(
      pivotIdentities.has(`${entry.path}::${entry.symbol}`),
      `reclaimed ${entry.path}::${entry.symbol} is not among the delivered pivots`,
    );
  }
});

test("a reclaimed pivot never exceeds the tier's pivot budget", () => {
  const result = build();
  // Standard tier (8k budget) allows two pivots. The reclaim fills free slots;
  // it must never create extra ones.
  assert.ok(result.pivots.length <= 2, `expected at most 2 pivots, got ${result.pivots.length}`);
});

test("nothing is reclaimed when the task legitimately points at the doc tree", () => {
  // The non-source rule is suppressed when the task names docs explicitly, so no
  // slot is vacated and there is nothing to reclaim. This pins that the reclaim
  // reacts to a VACATED slot rather than to doc-tree paths.
  const result = build(`${TASK} Update the documentation under doc/ as well.`);
  assert.equal(result.diagnostics.reclaimed_pivot_slots, undefined);
});

test("a capsule with no budget-demoted candidate reclaims nothing", () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "vtrace-m157-noreclaim-"));
  const db = openIndexerDatabase();
  try {
    seedFile(db, repoRoot, "doc/conf.py", [
      {
        localName: "quickstart_prompt_exit",
        kind: SymbolKind.Function,
        signature: "def quickstart_prompt_exit(conf)",
        body: "def quickstart_prompt_exit(conf):\n    # quickstart prompt exit conf.py existing\n    return conf",
      },
    ]);
    const result = buildCapsuleV2({
      db, repoRoot, task: TASK, intent: CapsuleIntent.Auto, maxTokens: 8_000,
    });
    // The only candidate is disqualified, and no candidate was ever priced out
    // of a slot — so the capsule stays empty rather than promoting the
    // disqualified one to fill its own vacancy.
    assert.equal(result.diagnostics.reclaimed_pivot_slots, undefined);
    assert.equal(result.pivots.length, 0);
  } finally {
    db.close();
  }
});
