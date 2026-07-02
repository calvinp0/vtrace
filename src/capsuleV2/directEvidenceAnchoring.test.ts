// Tests for direct-evidence candidate anchoring (M96).
//
// Three layers: pure-extraction unit tests (which mention shapes are extracted,
// which are stoplisted), resolution tests over a seeded index (exact matching,
// ambiguity rejection, drill-must-resolve, caps), and full-pipeline integration
// tests proving the two core guarantees: a resolved mention enters the capsule,
// and a WEAK mention never steals the lead pivot from an organically-evidenced
// edit target.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildCapsuleV2 } from "./buildCapsuleV2";
import {
  anchorDirectEvidence,
  extractDirectEvidenceMentions,
  DIRECT_EVIDENCE_STRONG_FINAL,
} from "./directEvidenceAnchoring";
import { CapsuleIntent } from "./types";
import { seedCustomFixture } from "./__fixtures__/capsuleV2Fixture";
import { SymbolKind } from "../domain/types";

const mentionsOf = (task: string): Array<{ term: string; type: string }> =>
  extractDirectEvidenceMentions(task).mentions.map((m) => ({ term: m.term, type: m.type }));

const termsOfType = (task: string, type: string): string[] =>
  mentionsOf(task).filter((m) => m.type === type).map((m) => m.term);

// --- extraction: dotted module paths --------------------------------------------

test("a dotted module path is extracted; URL tails / self-chains / short segments are not", () => {
  assert.deepEqual(
    termsOfType("utils.numberformat.format renders small decimals in exponential notation", "dotted_module_path"),
    ["utils.numberformat.format"],
  );
  // A URL is stripped before extraction, and a bare domain tail is rejected.
  assert.deepEqual(
    termsOfType("see https://docs.python-requests.org/en/latest/user/advanced/ or requests.org", "dotted_module_path"),
    [],
  );
  assert.deepEqual(termsOfType("self.request fails and e.g. this", "dotted_module_path"), []);
});

// --- extraction: explicit files / runner scripts ---------------------------------

test("an explicit .py token is extracted; runner scripts and ubiquitous basenames are not", () => {
  assert.deepEqual(termsOfType("the bug is in validators.py somewhere", "explicit_file"), ["validators.py"]);
  assert.deepEqual(termsOfType("run python manage.py check and look at __init__.py", "explicit_file"), []);
});

// --- extraction: class words -----------------------------------------------------

test("a mid-sentence capitalized word is a class-word mention; sentence-initial is prose", () => {
  // "Case" is on the generic stoplist ("case"); "Count" is a real class-word mention.
  assert.deepEqual(termsOfType("A Count annotation over a Case condition fails", "class_word"), ["Count"]);
  // Sentence-initial capitals are ordinary prose.
  assert.deepEqual(termsOfType("Count annotations fail. When it runs twice.", "class_word"), []);
  // Exception names are excluded (exception-symptom de-anchoring owns them).
  assert.deepEqual(termsOfType("it raises a ValueError sometimes", "class_word"), []);
});

// --- extraction: mixed-case identifiers ------------------------------------------

test("a mixed-case code identifier is extracted (internal case flip marks code)", () => {
  assert.deepEqual(
    termsOfType("kernS: 'kern' referenced before assignment", "mixed_case_identifier"),
    ["kernS"],
  );
});

// --- extraction: file stems + generic stoplist ------------------------------------

test("bare lowercase words are stem mentions unless generic", () => {
  const stems = termsOfType("the autoreload hook breaks on empty dirs", "file_stem_word");
  assert.ok(stems.includes("autoreload"));
  // Generic vocabulary never anchors: query-shaping stoplist, milestone generics,
  // and generic-infrastructure decoy tokens (deprecation) are all rejected.
  const extraction = extractDirectEvidenceMentions("a deprecation error in the query parser model utils");
  const stemTerms = extraction.mentions.filter((m) => m.type === "file_stem_word").map((m) => m.term);
  for (const banned of ["deprecation", "error", "query", "parser", "model", "utils"]) {
    assert.ok(!stemTerms.includes(banned), `generic word "${banned}" must not be a stem mention`);
  }
  assert.ok(extraction.rejectedGeneric > 0);
});

// --- resolution: exact file / basename / stem ------------------------------------

function seededIndex() {
  return seedCustomFixture([
    {
      relPath: "pkg/utils/numberformat.py",
      specs: [{ localName: "format", kind: SymbolKind.Function, body: "def format(number):\n    return str(number)" }],
    },
    {
      relPath: "pkg/db/aggregates.py",
      specs: [{ localName: "Count", kind: SymbolKind.Class, body: "class Count:\n    def as_sql(self):\n        return 'COUNT'" }],
    },
    {
      relPath: "pkg/template/autoreload.py",
      specs: [{ localName: "watch_templates", kind: SymbolKind.Function, body: "def watch_templates():\n    return 1" }],
    },
    {
      relPath: "pkg/core/validators.py",
      specs: [{ localName: "validate_email", kind: SymbolKind.Function, body: "def validate_email(v):\n    return v" }],
    },
  ]);
}

test("a dotted module path resolves to its file and drills into the named symbol (strong tier)", () => {
  const { db } = seededIndex();
  try {
    const result = anchorDirectEvidence({ db, task: "utils.numberformat.format renders wrong output" });
    const match = result.matches.find((m) => m.term === "utils.numberformat.format");
    assert.ok(match, "dotted mention must resolve");
    assert.equal(match.tier, "strong");
    assert.equal(match.path, "pkg/utils/numberformat.py");
    assert.equal(match.symbol, "format");
    assert.ok(result.strongSymbolIds.has(match.symbolId));
  } finally {
    db.close();
  }
});

test("a dotted path whose drill symbol does not resolve contributes nothing", () => {
  const { db } = seededIndex();
  try {
    // `utils.numberformat.parse` names a symbol the module does not define —
    // falling back to unrelated symbols would promote noise at anchor strength.
    const result = anchorDirectEvidence({ db, task: "utils.numberformat.parse is broken" });
    assert.ok(!result.matches.some((m) => m.term === "utils.numberformat.parse"));
  } finally {
    db.close();
  }
});

test("an exact basename and a bare file stem resolve (weak tier for stems)", () => {
  const { db } = seededIndex();
  try {
    const byFile = anchorDirectEvidence({ db, task: "the bug lives in validators.py it seems" });
    assert.ok(byFile.matches.some((m) => m.path === "pkg/core/validators.py" && m.tier === "strong"));

    const byStem = anchorDirectEvidence({ db, task: "the autoreload hook ignores template dirs" });
    const stem = byStem.matches.find((m) => m.term === "autoreload");
    assert.ok(stem, "stem mention must resolve to autoreload.py");
    assert.equal(stem.tier, "weak");
    assert.equal(stem.path, "pkg/template/autoreload.py");
  } finally {
    db.close();
  }
});

test("a mid-sentence class word resolves to the exact class (weak tier)", () => {
  const { db } = seededIndex();
  try {
    const result = anchorDirectEvidence({ db, task: "A Count annotation with distinct produces wrong SQL" });
    const match = result.matches.find((m) => m.term === "Count");
    assert.ok(match, "Count must resolve to the class");
    assert.equal(match.tier, "weak");
    assert.equal(match.path, "pkg/db/aggregates.py");
  } finally {
    db.close();
  }
});

// --- resolution: ambiguity rejection ---------------------------------------------

test("an ambiguous stem (too many matching files) is rejected and counted", () => {
  const { db } = seedCustomFixture(
    ["a", "b", "c"].map((dir) => ({
      relPath: `pkg/${dir}/widget.py`,
      specs: [{ localName: `make_${dir}`, kind: SymbolKind.Function, body: `def make_${dir}():\n    return 1` }],
    })),
  );
  try {
    // Three widget.py files exceed the 2-file stem cap.
    const result = anchorDirectEvidence({ db, task: "the widget breaks on resize" });
    assert.ok(!result.matches.some((m) => m.term === "widget"));
    assert.ok(result.rejectedAmbiguousCount >= 1);
  } finally {
    db.close();
  }
});

// --- resolution: caps -------------------------------------------------------------

test("total candidates stay within the lane caps and output is deterministic", () => {
  const { db } = seededIndex();
  try {
    const task =
      "utils.numberformat.format and validators.py and autoreload and a Count annotation and watch_templates";
    const first = anchorDirectEvidence({ db, task });
    const second = anchorDirectEvidence({ db, task });
    assert.ok(first.candidates.length <= 8, `total cap: got ${first.candidates.length}`);
    assert.deepEqual(
      first.matches.map((m) => `${m.term}|${m.path}|${m.symbol}|${m.tier}`),
      second.matches.map((m) => `${m.term}|${m.path}|${m.symbol}|${m.tier}`),
    );
  } finally {
    db.close();
  }
});

// --- integration: recovery + no-lead-theft ----------------------------------------

test("a class-word mention recovers an absent gold file into the capsule", () => {
  const { db, repoRoot } = seededIndex();
  try {
    const result = buildCapsuleV2({
      db,
      repoRoot,
      task: "Query error with distinct combination — a Count annotation with distinct=True produces invalid SQL.",
      intent: CapsuleIntent.Debug,
      maxTokens: 8_000,
    });
    const files = [...result.pivots, ...result.support].map((it) => it.path);
    assert.ok(files.includes("pkg/db/aggregates.py"), `expected aggregates.py in ${JSON.stringify(files)}`);
    assert.equal(result.diagnostics.direct_evidence_search_used, true);
  } finally {
    db.close();
  }
});

test("a weak stem mention never steals the lead from an organically-evidenced pivot", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "pkg/db/loader.py",
      specs: [{
        localName: "load_migrations",
        kind: SymbolKind.Function,
        body: "def load_migrations(namespace):\n    # permit migrations without __file__\n    return namespace",
      }],
    },
    {
      relPath: "pkg/gis/feature.py",
      specs: [{ localName: "Feature", kind: SymbolKind.Class, body: "class Feature:\n    pass" }],
    },
  ]);
  try {
    // The task names load_migrations directly (organic lexical+symbol evidence);
    // "feature" appears only as a prose word that happens to match feature.py.
    const result = buildCapsuleV2({
      db,
      repoRoot,
      task: "load_migrations rejects a namespace feature without __file__ in pkg loader",
      intent: CapsuleIntent.Debug,
      maxTokens: 8_000,
    });
    assert.ok(result.pivots.length > 0, "expected a lead pivot");
    assert.equal(result.pivots[0]!.path, "pkg/db/loader.py");
  } finally {
    db.close();
  }
});

test("a weak mention leads only when nothing organic clears the pivot bar", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "pkg/net/sessions.py",
      specs: [{ localName: "session", kind: SymbolKind.Function, body: "def session():\n    return Session()" }],
    },
  ]);
  try {
    // Nothing in the prose matches lexically except the bare word "session".
    const result = buildCapsuleV2({
      db,
      repoRoot,
      task: "Removing a default header of a session has no effect",
      intent: CapsuleIntent.Debug,
      maxTokens: 8_000,
    });
    assert.ok(result.pivots.length > 0, "the weak mention should anchor an otherwise empty capsule");
    assert.equal(result.pivots[0]!.path, "pkg/net/sessions.py");
  } finally {
    db.close();
  }
});

test("a strong dotted mention carries anchor-grade score and evidence", () => {
  const { db } = seededIndex();
  try {
    const result = anchorDirectEvidence({ db, task: "utils.numberformat.format is wrong" });
    const candidate = result.candidates.find((c) => c.filePath === "pkg/utils/numberformat.py");
    assert.ok(candidate);
    assert.equal(candidate.scores.final, DIRECT_EVIDENCE_STRONG_FINAL);
    assert.equal(candidate.scores.path, 1);
    assert.ok(candidate.evidence[0]!.includes("module path"));
  } finally {
    db.close();
  }
});
