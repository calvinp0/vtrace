// Tests for the non-source example / doc-data down-rank.
//
// Three layers: pure-classifier unit tests (path + task predicates), pure
// demotion-decision tests (the pivot-eviction policy), and a full-pipeline
// integration test proving a docs/example file never out-ranks production source
// into the pivot role.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildCapsuleV2 } from "./buildCapsuleV2";
import {
  classifyNonSourceExample,
  nonSourcePivotDemotion,
  taskMentionsNonSource,
} from "./nonSourceExample";
import { CapsuleIntent } from "./types";
import { INLINES_TASK, seedCapsuleV2Fixture, seedFile } from "./__fixtures__/capsuleV2Fixture";
import { SymbolKind } from "../domain/types";

// --- pure classifier ---------------------------------------------------------

test("classifyNonSourceExample flags docs/examples/sample/fixture paths, not real source", () => {
  const ns = (p: string) => classifyNonSourceExample(p);
  assert.equal(ns("doc/data/messages/b/bad-dunder-name/bad.py").isNonSourceExample, true);
  assert.equal(ns("doc/data/messages/b/bad-dunder-name/bad.py").reason, "path under doc/data");
  assert.equal(ns("galleries/examples/subplots/subfigures.py").isNonSourceExample, true);
  assert.equal(ns("examples/foo.py").reason, "path under examples/");
  assert.equal(ns("docs/conf.py").isNonSourceExample, true);
  assert.equal(ns("asv_bench/benchmarks/x.py").isNonSourceExample, true);
  assert.equal(ns("pkg/conf.py").reason, "non-source example file conf.py");
  // Real production source — NOT flagged.
  assert.equal(ns("pylint/config/argument.py").isNonSourceExample, false);
  assert.equal(ns("lib/matplotlib/colors.py").isNonSourceExample, false);
  assert.equal(ns("sphinx/cmd/quickstart.py").isNonSourceExample, false);
  // Bare tests/ is out of scope here (handled by the role gate), so NOT flagged.
  assert.equal(ns("tests/test_inlines.py").isNonSourceExample, false);
  assert.equal(ns("django/test/utils.py").isNonSourceExample, false);
});

test("taskMentionsNonSource allows explicit docs/examples references but not 'for example'", () => {
  assert.equal(taskMentionsNonSource("the example files under examples/ are wrong"), true);
  assert.equal(taskMentionsNonSource("documentation build fails for napoleon"), true);
  assert.equal(taskMentionsNonSource("the bug is in doc/data/messages output"), true);
  assert.equal(taskMentionsNonSource("the test fixtures are stale"), true);
  // Discourse markers and plain bug reports do NOT count.
  assert.equal(taskMentionsNonSource("Attempting to get e.g. http://x raises an error"), false);
  assert.equal(taskMentionsNonSource("bad-names-rgxs mangles regexes with commas, for example a,b"), false);
  assert.equal(taskMentionsNonSource("the parser drops a rule"), false);
});

// --- pure demotion decision --------------------------------------------------

test("nonSourcePivotDemotion: a doc-data PIVOT is demoted on a generic task", () => {
  const d = nonSourcePivotDemotion("doc/data/messages/b/x/bad.py", {
    isPivot: true,
    taskAllowsNonSource: false,
    isAnchored: false,
  });
  assert.equal(d.classification.isNonSourceExample, true);
  assert.equal(d.demote, true);
});

test("nonSourcePivotDemotion: a non-source SUPPORT item is tagged but not demoted (already not a pivot)", () => {
  const d = nonSourcePivotDemotion("examples/foo.py", { isPivot: false, taskAllowsNonSource: false, isAnchored: false });
  assert.equal(d.classification.isNonSourceExample, true);
  assert.equal(d.demote, false); // only pivots are demoted; support stays support
});

test("nonSourcePivotDemotion: an explicit task mention OR a line anchor overrides the demotion", () => {
  const allowed = nonSourcePivotDemotion("examples/foo.py", { isPivot: true, taskAllowsNonSource: true, isAnchored: false });
  assert.equal(allowed.demote, false);
  const anchored = nonSourcePivotDemotion("examples/foo.py", { isPivot: true, taskAllowsNonSource: false, isAnchored: true });
  assert.equal(anchored.demote, false);
});

test("nonSourcePivotDemotion: a production source pivot is never demoted", () => {
  const d = nonSourcePivotDemotion("pkg/argument.py", { isPivot: true, taskAllowsNonSource: false, isAnchored: false });
  assert.equal(d.classification.isNonSourceExample, false);
  assert.equal(d.demote, false);
});

// --- integration: doc-data decoy cannot out-rank production into the pivot ----

test("a doc-data decoy never out-ranks the production edit target into the pivot role", () => {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  try {
    // A doc-data sample that lexically mirrors the inlines task — the pylint
    // `doc/data/messages/**/bad.py` shape. It must never become a pivot, while the
    // real implementation (get_inline_instances) stays the lead pivot.
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

    // The production implementation is still the lead pivot.
    assert.equal(result.pivots[0]!.path, "pkg/options.py");
    assert.equal(result.pivots[0]!.symbol, "get_inline_instances");
    // No pivot is a doc-data file.
    for (const pivot of result.pivots) {
      assert.ok(!pivot.path.includes("doc/data/"), `doc-data must never be a pivot, got ${pivot.path}`);
      assert.ok(!pivot.is_non_source_example, `pivot ${pivot.path} must not be flagged non-source`);
    }
    // If the decoy reached the candidate pool at all, it is tagged non-source
    // wherever it landed (support or discarded) and is not a pivot.
    const decoy =
      result.support.find((s) => s.path.includes("doc/data/"))
      ?? result.discarded.find((d) => d.path.includes("doc/data/"));
    if (decoy) {
      assert.equal(decoy.is_non_source_example, true);
      assert.equal(decoy.non_source_reason, "path under doc/data");
    }
  } finally {
    db.close();
  }
});
