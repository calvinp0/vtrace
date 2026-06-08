// Tests for high-signal literal / option / acronym anchoring.
//
// Two layers: pure-extraction unit tests (which shapes become anchors, which are
// filtered), and full-pipeline integration tests proving an anchored symbol enters
// the pool, that the non-source down-rank still applies to anchored candidates, and
// that an explicit line anchor still out-ranks a literal anchor.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildCapsuleV2 } from "./buildCapsuleV2";
import { extractLiteralAnchors } from "./literalAnchoring";
import { CapsuleIntent } from "./types";
import { seedCustomFixture } from "./__fixtures__/capsuleV2Fixture";
import { SymbolKind } from "../domain/types";

const terms = (task: string): string[] => extractLiteralAnchors(task).map((a) => a.term);

// --- (1) ALL_CAPS acronym ------------------------------------------------------

test("an ALL_CAPS acronym (len >= 3) is extracted; generic acronyms are not", () => {
  assert.deepEqual(terms("FITS card parsing fails reading CDS format"), ["FITS", "CDS"]);
  // Generic protocol/format acronyms carry no edit-target signal.
  assert.deepEqual(terms("the JSON over HTTP API returns HTML"), []);
  // Two-letter caps are below the acronym floor.
  assert.deepEqual(terms("IO is fine"), []);
});

// --- (2) dunder ----------------------------------------------------------------

test("a dunder name is extracted; ubiquitous dunders are not", () => {
  assert.deepEqual(terms("__array_function__ protocol is not honoured"), ["__array_function__"]);
  assert.deepEqual(terms("the __init__ and __repr__ are fine"), []);
});

// --- (3) hyphenated option -----------------------------------------------------

test("a --hyphenated CLI/config option is extracted", () => {
  assert.deepEqual(terms("--ignore-paths does not apply to symlinks"), ["--ignore-paths"]);
  // A bare double-dash word with no hyphen segment is not an option anchor.
  assert.deepEqual(terms("pass --verbose to the runner"), []);
});

// --- (4) backticked config name ------------------------------------------------

test("a backticked snake_case config name is extracted", () => {
  assert.deepEqual(terms("the `napoleon_use_param` setting is ignored"), ["napoleon_use_param"]);
  // A quoted lowercase format token is a high-signal literal too.
  assert.deepEqual(terms("the 'qdp' writer drops a column"), ["qdp"]);
});

// --- (5) ordinary prose is ignored ---------------------------------------------

test("ordinary lowercase prose is never extracted unless quoted/backticked or option-shaped", () => {
  assert.deepEqual(terms("the parser drops a column when reading the table header"), []);
  // A capitalised prose word is not an anchor either (not all-caps, not quoted).
  assert.deepEqual(terms("Parsing The Header Fails"), []);
});

// --- (6) exception names ignored -----------------------------------------------

test("exception/warning class names are not anchors (de-anchoring owns that noise)", () => {
  assert.deepEqual(terms("a ValueError is raised and a DeprecationWarning too"), []);
  // Even backticked, an exception name is excluded.
  assert.deepEqual(terms("`RuntimeError` surfaces here"), []);
});

// --- (7) a literal-anchor candidate enters the pool ----------------------------

test("an acronym path-segment anchor pulls the right file's symbol into the pool", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "astropy/units/format/cds.py",
      specs: [{ localName: "CdsFormat", kind: SymbolKind.Class, body: "class CdsFormat:\n    def parse(self):\n        return 1" }],
    },
    {
      relPath: "astropy/io/ascii/core.py",
      specs: [{ localName: "BaseReader", kind: SymbolKind.Class, body: "class BaseReader:\n    pass" }],
    },
  ]);
  try {
    const result = buildCapsuleV2({
      db,
      repoRoot,
      task: "CDS format parsing fails when reading a units header.",
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
    const matches = result.diagnostics.literal_anchor_matches ?? [];
    assert.ok(
      matches.some((m) => m.term === "CDS" && m.path.includes("cds.py")),
      `expected a CDS literal-anchor match, got ${JSON.stringify(matches)}`,
    );
    assert.equal(result.diagnostics.literal_anchor_search_used, true);
    // The cds.py symbol reached the capsule as a pivot (the file the acronym names).
    assert.ok(
      result.pivots.some((p) => p.path.includes("cds.py")),
      `expected cds.py as a pivot, got ${result.pivots.map((p) => p.path)}`,
    );
  } finally {
    db.close();
  }
});

// --- (8) non-source demotion still applies to an anchored candidate ------------

test("a literal anchor that lands on a non-source example file is not promoted to pivot", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "pkg/scale.py",
      specs: [{ localName: "compute_ticks", kind: SymbolKind.Function, signature: "compute_ticks()", body: "def compute_ticks():\n    return []" }],
    },
    {
      relPath: "examples/demo.py",
      specs: [{ localName: "TickHelper", kind: SymbolKind.Class, body: "class TickHelper:\n    pass" }],
    },
  ]);
  try {
    const result = buildCapsuleV2({
      db,
      repoRoot,
      task: "compute_ticks is broken; see `TickHelper` for the intended pattern.",
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
    // The anchor resolved TickHelper, but examples/ is non-source: never a pivot.
    for (const pivot of result.pivots) {
      assert.ok(!pivot.path.includes("examples/"), `non-source must not be a pivot, got ${pivot.path}`);
    }
    const demoted =
      result.support.find((s) => s.path.includes("examples/"))
      ?? result.discarded.find((d) => d.path.includes("examples/"));
    if (demoted) {
      assert.equal(demoted.is_non_source_example, true);
    }
  } finally {
    db.close();
  }
});

// --- (9) an explicit line/file anchor still out-ranks a literal anchor ---------

test("an explicit line anchor leads the pivots ahead of a literal anchor", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "pkg/core.py",
      specs: [{ localName: "run", kind: SymbolKind.Function, signature: "run()", body: "def run():\n    return 1" }],
    },
    {
      relPath: "astropy/units/format/cds.py",
      specs: [{ localName: "CdsFormat", kind: SymbolKind.Class, body: "class CdsFormat:\n    pass" }],
    },
  ]);
  try {
    const result = buildCapsuleV2({
      db,
      repoRoot,
      task: "Crash originates at pkg/core.py#L1 during CDS format parsing.",
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
    assert.equal(result.diagnostics.line_anchor_resolution_used, true);
    // The explicit source anchor leads; the CDS literal anchor sits behind it.
    assert.equal(result.pivots[0]?.path, "pkg/core.py");
    assert.equal(result.pivots[0]?.symbol, "run");
  } finally {
    db.close();
  }
});
