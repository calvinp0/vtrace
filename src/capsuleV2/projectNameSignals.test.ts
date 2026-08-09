// M132 — repository-name ranking suppression.
//
// The rule must be narrow in both directions: a project-name reference must lose
// its high-signal literal anchoring, and an explicit symbol reference to the same
// token — in this repository or in a repository that merely contains a symbol of
// that name — must keep it.

import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { extractLiteralAnchors } from "./literalAnchoring";
import {
  hasExplicitSymbolEvidence,
  isGenericProjectReference,
  resolveProjectNameAliases,
} from "./projectNameSignals";

const ARC_ALIASES = resolveProjectNameAliases("/home/calvin/code/ARC");

/** The real query that exposed the incident. Recorded verbatim. */
const ARC_GEOMETRY_QUERY =
  "How does ARC handle linear segments and dummy atoms in Z-matrices?";

describe("project name aliases", () => {
  test("the repository basename is the alias, case-folded", () => {
    assert.deepEqual([...ARC_ALIASES], ["arc"]);
    assert.deepEqual([...resolveProjectNameAliases("/x/TCKDB")], ["tckdb"]);
  });

  test("separator spellings are folded together", () => {
    const aliases = resolveProjectNameAliases("/x/my-project");
    assert.equal(aliases.has("my-project"), true);
    assert.equal(aliases.has("my_project"), true);
  });

  test("names too short or oddly shaped are not aliases", () => {
    assert.equal(resolveProjectNameAliases("/x/ab").size, 0);
    assert.equal(resolveProjectNameAliases("/x/.hidden").size, 0);
  });
});

describe("generic project reference vs explicit symbol reference", () => {
  test("the ARC geometry query is a generic project reference", () => {
    assert.equal(
      isGenericProjectReference({ term: "ARC", task: ARC_GEOMETRY_QUERY, aliases: ARC_ALIASES }),
      true,
    );
  });

  test("common project-reference phrasings are all generic", () => {
    for (const task of [
      "How does ARC handle geometry?",
      "Where does ARC write its output files?",
      "Why does ARC retry failed jobs?",
      "In ARC, what determines the conformer count?",
      "arc/ has a scheduler somewhere — how does it work?",
    ]) {
      assert.equal(
        isGenericProjectReference({ term: "ARC", task, aliases: ARC_ALIASES }),
        true,
        `expected generic: ${task}`,
      );
    }
  });

  test("explicit symbol targeting is preserved", () => {
    for (const task of [
      "How does the ARC class initialize project-level state?",
      "What does the ARC class constructor do?",
      "Walk me through class ARC and its attributes",
      "What happens in ARC.__init__?",
      "Where is ARC() constructed?",
      "Explain arc/main.py::ARC",
      "What is the `ARC` object responsible for?",
    ]) {
      assert.equal(
        isGenericProjectReference({ term: "ARC", task, aliases: ARC_ALIASES }),
        false,
        `expected symbol-targeting: ${task}`,
      );
      assert.equal(hasExplicitSymbolEvidence(task, "ARC"), true, task);
    }
  });

  test("a token that is not this repository's name is never suppressed", () => {
    // Same question shape, different repository: `ARC` is a real symbol here.
    const tckdbAliases = resolveProjectNameAliases("/x/TCKDB");
    assert.equal(
      isGenericProjectReference({ term: "ARC", task: "How does ARC handle geometry?", aliases: tckdbAliases }),
      false,
    );
    // And other high-signal literals in the ARC repo keep anchoring.
    for (const term of ["FITS", "CDS", "QDP"]) {
      assert.equal(
        isGenericProjectReference({ term, task: `How does ARC read ${term} files?`, aliases: ARC_ALIASES }),
        false,
      );
    }
  });

  test("suppression is inert when no aliases are known", () => {
    assert.equal(
      isGenericProjectReference({ term: "ARC", task: ARC_GEOMETRY_QUERY, aliases: new Set() }),
      false,
    );
  });
});

describe("interaction with anchor extraction", () => {
  test("the extractor still produces ARC; suppression is a separate, later decision", () => {
    // Keeping extraction untouched means the diagnostic can report what was
    // dropped and why, instead of the term silently never existing.
    assert.equal(extractLiteralAnchors(ARC_GEOMETRY_QUERY).some((a) => a.term === "ARC"), true);
  });

  test("the geometry query's other terms are unaffected", () => {
    const terms = extractLiteralAnchors(ARC_GEOMETRY_QUERY).map((anchor) => anchor.term);
    for (const term of terms.filter((candidate) => candidate !== "ARC")) {
      assert.equal(
        isGenericProjectReference({ term, task: ARC_GEOMETRY_QUERY, aliases: ARC_ALIASES }),
        false,
        `${term} must not be suppressed`,
      );
    }
  });
});
