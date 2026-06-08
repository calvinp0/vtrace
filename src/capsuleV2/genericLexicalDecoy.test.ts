// Tests for generic-infrastructure lexical-decoy suppression.
//
// Three layers: pure-decision unit tests (the conservative classifier + the
// explicit-path predicate), a full-pipeline integration test proving a generic
// `deprecation.py` decoy is weakened out of the pivot role while the real target
// leads, and a regression test that the non-source example demotion still fires
// alongside the new pass.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildCapsuleV2 } from "./buildCapsuleV2";
import {
  classifyGenericLexicalDecoy,
  collectQueryTokens,
  taskNamesCandidatePath,
  type GenericLexicalDecoyInput,
} from "./genericLexicalDecoy";
import { CapsuleIntent } from "./types";
import { INLINES_TASK, seedCapsuleV2Fixture, seedCustomFixture, seedFile } from "./__fixtures__/capsuleV2Fixture";
import { SymbolKind } from "../domain/types";

// A candidate with NO direct evidence — the baseline a decoy guard runs against.
const NO_EVIDENCE = { symbol: 0, path: 0, testToImpl: 0, bodyLiteral: 0, graph: 0, inDegree: 0 } as const;

function decoyInput(overrides: Partial<GenericLexicalDecoyInput> = {}): GenericLexicalDecoyInput {
  return {
    filePath: "lib/matplotlib/_api/deprecation.py",
    localName: "warn_deprecation",
    queryTokens: collectQueryTokens("a deprecation is emitted while rendering the axis"),
    scores: NO_EVIDENCE,
    hasLineAnchor: false,
    hasTitleSymbol: false,
    taskNamesPath: false,
    ...overrides,
  };
}

// --- (1) a bare generic-infra filename with weak evidence is a decoy ----------

test("classifyGenericLexicalDecoy flags deprecation.py when the query shares the word and evidence is weak", () => {
  const d = classifyGenericLexicalDecoy(decoyInput());
  assert.equal(d.isDecoy, true);
  assert.equal(d.token, "deprecation");
  assert.match(d.reason ?? "", /deprecation/);
});

test("the trigger requires the generic word to actually be in the query", () => {
  // deprecation.py is in the pool but the task never says "deprecation": not a decoy.
  const d = classifyGenericLexicalDecoy(
    decoyInput({ queryTokens: collectQueryTokens("the axis renders wrong tick values") }),
  );
  assert.equal(d.isDecoy, false);
});

test("a file whose name is NOT entirely generic infra is never a decoy (no substring matching)", () => {
  // basename "base_user" -> {base, user}; `user` is not infra, so identity is not
  // generic infrastructure. And "database" is a token, not the infra token "base".
  assert.equal(
    classifyGenericLexicalDecoy(
      decoyInput({ filePath: "auth/base_user.py", queryTokens: collectQueryTokens("base user model is broken") }),
    ).isDecoy,
    false,
  );
  assert.equal(
    classifyGenericLexicalDecoy(
      decoyInput({ filePath: "db/database.py", queryTokens: collectQueryTokens("the base database connection") }),
    ).isDecoy,
    false,
  );
});

// --- (2) an explicit path mention is not suppressed ---------------------------

test("taskNamesCandidatePath matches an explicit path but not a bare generic word", () => {
  assert.equal(
    taskNamesCandidatePath("the bug is in matplotlib/_api/deprecation.py", "lib/matplotlib/_api/deprecation.py"),
    true,
  );
  assert.equal(taskNamesCandidatePath("a deprecation warning is emitted", "lib/matplotlib/_api/deprecation.py"), false);
});

test("an explicitly-named path is not suppressed", () => {
  const task = "The deprecation logic in matplotlib/_api/deprecation.py is wrong.";
  const d = classifyGenericLexicalDecoy(
    decoyInput({ queryTokens: collectQueryTokens(task), taskNamesPath: taskNamesCandidatePath(task, "lib/matplotlib/_api/deprecation.py") }),
  );
  assert.equal(d.isDecoy, false);
});

// --- (3)-(5) stronger direct evidence is never suppressed ---------------------

test("a line-anchor candidate is not suppressed", () => {
  assert.equal(classifyGenericLexicalDecoy(decoyInput({ hasLineAnchor: true })).isDecoy, false);
});

test("a body-literal diagnostic candidate is not suppressed", () => {
  assert.equal(classifyGenericLexicalDecoy(decoyInput({ scores: { ...NO_EVIDENCE, bodyLiteral: 1 } })).isDecoy, false);
});

test("a title-symbol candidate is not suppressed", () => {
  // Title-symbol candidates carry symbol evidence AND are flagged by id; either guard suffices.
  assert.equal(classifyGenericLexicalDecoy(decoyInput({ hasTitleSymbol: true })).isDecoy, false);
  assert.equal(classifyGenericLexicalDecoy(decoyInput({ scores: { ...NO_EVIDENCE, symbol: 1 } })).isDecoy, false);
});

test("a symbol/path/test pointer or strong graph reach is not suppressed", () => {
  assert.equal(classifyGenericLexicalDecoy(decoyInput({ scores: { ...NO_EVIDENCE, path: 1 } })).isDecoy, false);
  assert.equal(classifyGenericLexicalDecoy(decoyInput({ scores: { ...NO_EVIDENCE, testToImpl: 1 } })).isDecoy, false);
  assert.equal(classifyGenericLexicalDecoy(decoyInput({ scores: { ...NO_EVIDENCE, graph: 0.6 } })).isDecoy, false);
  // A weak graph hit (incidental reach) does NOT protect a bare generic name.
  assert.equal(classifyGenericLexicalDecoy(decoyInput({ scores: { ...NO_EVIDENCE, graph: 0.2 } })).isDecoy, true);
});

test("a high-in-degree symbol (real, widely-used infrastructure) is not suppressed", () => {
  // A `@deprecated` decorator with many dependents has strong graph-neighbourhood
  // evidence — it is genuinely relevant infrastructure, not a coincidental match.
  assert.equal(classifyGenericLexicalDecoy(decoyInput({ scores: { ...NO_EVIDENCE, inDegree: 116 } })).isDecoy, false);
  // A low-in-degree generic-named helper is still a decoy.
  assert.equal(classifyGenericLexicalDecoy(decoyInput({ scores: { ...NO_EVIDENCE, inDegree: 1 } })).isDecoy, true);
});

// --- integration: a deprecation.py decoy never out-ranks the real target ------

test("a generic deprecation.py decoy is weakened out of the pivot and surfaced in diagnostics", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "pkg/scale.py",
      specs: [
        {
          localName: "compute_ticks",
          kind: SymbolKind.Function,
          signature: "compute_ticks(vmin, vmax)",
          body:
            "def compute_ticks(vmin, vmax):\n"
            + "    # rescale the tick values for the axis\n"
            + "    return [vmin, vmax]",
        },
      ],
    },
    {
      relPath: "pkg/_api/deprecation.py",
      specs: [
        {
          localName: "warn_deprecation",
          kind: SymbolKind.Function,
          signature: "warn_deprecation(message)",
          body:
            "def warn_deprecation(message):\n"
            + "    # emit a deprecation warning\n"
            + "    import warnings\n"
            + "    warnings.warn(message)",
        },
      ],
    },
  ]);
  try {
    // The task names the real edit target (compute_ticks) and mentions "deprecation"
    // only as an unrelated generic word — exactly the over-anchoring the rule targets.
    // Both symbols enter the lexical pool; deprecation.py rides only the generic word.
    const task = "When a deprecation occurs, compute_ticks produces wrong tick values during rescale.";
    const result = buildCapsuleV2({ db, repoRoot, task, intent: CapsuleIntent.Auto, maxTokens: 8_000 });

    // The decoy was identified and recorded.
    const decoys = result.diagnostics.generic_lexical_decoys_suppressed ?? [];
    assert.ok(
      decoys.some((d) => d.path.includes("deprecation.py") && d.token === "deprecation"),
      `expected deprecation.py to be suppressed, got ${JSON.stringify(decoys)}`,
    );

    // It is never a pivot; the real target leads.
    for (const pivot of result.pivots) {
      assert.ok(!pivot.path.includes("deprecation.py"), `decoy must not be a pivot, got ${pivot.path}`);
    }
    assert.equal(result.pivots[0]?.symbol, "compute_ticks");

    // Not removed: if it landed anywhere, its lexical was weakened (<= the factor).
    const decoyItem =
      result.support.find((s) => s.path.includes("deprecation.py"))
      ?? result.pivots.find((p) => p.path.includes("deprecation.py"));
    if (decoyItem) {
      assert.ok(decoyItem.scorecard.lexical <= 0.5, `weakened lexical expected, got ${decoyItem.scorecard.lexical}`);
    }
  } finally {
    db.close();
  }
});

// --- (6) the non-source example demotion still fires alongside the new pass ----

test("non-source example demotion still works with decoy suppression enabled", () => {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  try {
    seedFile(db, repoRoot, "doc/data/messages/inlines/bad.py", [
      {
        localName: "get_inline_instances_demo",
        kind: SymbolKind.Function,
        signature: "get_inline_instances_demo()",
        body:
          "def get_inline_instances_demo():\n"
          + "    # example: get_inline_instances should consult get_inlines\n"
          + "    return get_inlines(request)",
      },
    ]);
    const result = buildCapsuleV2({ db, repoRoot, task: INLINES_TASK, intent: CapsuleIntent.Auto, maxTokens: 8_000 });

    // The production implementation is still the lead pivot; no doc-data pivot.
    assert.equal(result.pivots[0]!.symbol, "get_inline_instances");
    for (const pivot of result.pivots) {
      assert.ok(!pivot.path.includes("doc/data/"), `doc-data must never be a pivot, got ${pivot.path}`);
    }
    const decoy =
      result.support.find((s) => s.path.includes("doc/data/"))
      ?? result.discarded.find((d) => d.path.includes("doc/data/"));
    if (decoy) {
      assert.equal(decoy.is_non_source_example, true);
    }
  } finally {
    db.close();
  }
});
