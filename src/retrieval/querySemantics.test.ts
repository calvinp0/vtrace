import { describe, expect, test } from "bun:test";

import {
  deriveQueryIntent,
  evaluateCandidateContrast,
  evaluateDirectAnswer,
  parseContrastClauses,
} from "./querySemantics";

describe("M135 deterministic contrast grammar", () => {
  test.each([
    ["use streaming rather than loading the whole file", "loading the whole file"],
    ["use streaming instead of loading the whole file", "loading the whole file"],
    ["work without blocking IO", "blocking IO"],
    ["find a parser excluding legacy_parser", "legacy_parser"],
    ["all handlers except sync_handler", "sync_handler"],
  ])("extracts bounded exclusion: %s", (task, excluded) => {
    const clauses = parseContrastClauses(task);
    expect(clauses).toHaveLength(1);
    expect(clauses[0]!.contrastPhrase.toLowerCase()).toBe(excluded.toLowerCase());
    expect(clauses[0]!.confidence).toBe("high");
  });

  test("captures both sides and bounds the motivating ARC phrase", () => {
    const intent = deriveQueryIntent(
      "a function that returns a dihedral angle given three vectors, rather than given coordinates and four atom indices",
    );
    expect(intent.positiveTerms).toEqual(expect.arrayContaining(["dihedral", "three", "vectors"]));
    expect(intent.contrastTerms).toEqual(["coordinates", "four", "atom", "indices"]);
    expect(intent.positiveSearchText).not.toContain("coordinates");
  });

  test("not B but A preserves A and excludes B", () => {
    const intent = deriveQueryIntent("not legacy_parser, but streaming_parser");
    expect(intent.positiveSearchText).toBe("streaming_parser");
    expect(intent.explicitIdentifiers).toContain("streaming_parser");
    expect(intent.contrastIdentifiers).toContain("legacy_parser");
  });

  test.each([
    "not only A but also B",
    "whether or not X",
    "does not crash when B is empty",
    "no longer calls X",
    "not X itself, but its caller",
    "Permutation raises ValueError instead of constructing the identity permutation",
    "Migrations uses the enum value instead of its name",
    "Cards seem correct, except sometimes when dealing with null strings",
    "Legends are formatted without their multiplicative offset value",
  ])("does not apply naive negation suppression: %s", (task) => {
    expect(parseContrastClauses(task)).toEqual([]);
  });

  test("comparison and causal references keep both symbols explicit", () => {
    expect(deriveQueryIntent("compare get_dihedral with calculate_dihedral_angle").comparisonIdentifiers)
      .toEqual(["get_dihedral", "calculate_dihedral_angle"]);
    expect(deriveQueryIntent("why doesn't get_dihedral call calculate_dihedral_angle?").comparisonIdentifiers)
      .toEqual(["get_dihedral", "calculate_dihedral_angle"]);
  });

  test("candidate contrast score is bounded and explicit positive anchors are protected", () => {
    const intent = deriveQueryIntent("find new_parser rather than legacy parser using raw coordinates");
    const legacy = evaluateCandidateContrast(intent, {
      localName: "legacy_parser", fqName: "pkg.legacy_parser", filePath: "pkg/parser.py",
      signature: "legacy_parser(raw_coordinates)", docstring: "parse raw coordinates",
    });
    const target = evaluateCandidateContrast(intent, {
      localName: "new_parser", fqName: "pkg.new_parser", filePath: "pkg/parser.py",
      signature: "new_parser(stream)", docstring: "streaming parser",
    });
    expect(legacy.contrastPenalty).toBeGreaterThan(0);
    expect(legacy.contrastPenalty).toBeLessThanOrEqual(0.75);
    expect(target.contrastPenalty).toBe(0);
  });
});

describe("M137 capability lookup intent and direct answers", () => {
  test.each([
    "is there already a function that parses bytes?",
    "does a helper exist for parsing bytes?",
    "do we already have a method for parsing bytes?",
    "find the function that parses bytes",
    "which helper normalizes a vector?",
    "what function returns an angle?",
    "where is the method that parses bytes?",
    "a function that returns a dihedral angle given three vectors",
  ])("recognizes high-confidence capability form: %s", (task) => {
    expect(deriveQueryIntent(task).kind).toBe("capability_lookup");
  });

  test.each([
    "how are dihedral angles handled in ARC?",
    "who calls get_dihedral?",
    "explain how vector geometry works",
    "find calculate_dihedral_angle",
    "compare get_dihedral and calculate_dihedral_angle",
  ])("leaves non-capability control unchanged: %s", (task) => {
    expect(deriveQueryIntent(task).kind).toBe("general");
  });

  test("definition-local evidence favors the exact ARC primitive", () => {
    const intent = deriveQueryIntent("a function that returns a dihedral angle given three vectors, rather than given coordinates and four atom indices");
    const exact = evaluateDirectAnswer(intent, {
      localName: "get_dihedral", kind: "function", signature: "get_dihedral(v1, v2, v3, units='degs', tol=1e-8) -> float",
      docstring: "Calculate the dihedral angle between three vectors.",
    });
    const related = evaluateDirectAnswer(intent, {
      localName: "get_normal", kind: "function", signature: "get_normal(v1, v2)",
      docstring: "Return a normal vector used by geometry helpers.",
    });
    expect(exact.score).toBeGreaterThan(0.7);
    expect(exact.parameterShapeMatched).toBe(true);
    expect(exact.score).toBeGreaterThan(related.score);
  });

  test("repeated incidental body-like prose cannot game definition-local scoring", () => {
    const intent = deriveQueryIntent("which helper normalizes a single vector?");
    const actual = evaluateDirectAnswer(intent, {
      localName: "normalize_vector", kind: "function", signature: "normalize_vector(v)", docstring: "Normalize one vector.",
    });
    const incidental = evaluateDirectAnswer(intent, {
      localName: "interpolate_values", kind: "function", signature: "interpolate_values(values)",
      docstring: "Interpolation may consume a normalized vector; vector normalization is performed elsewhere.",
    });
    expect(actual.score).toBeGreaterThan(incidental.score);
    expect(incidental.score).toBeLessThanOrEqual(0.28);
  });
});

describe("M137 project-reference symbol hygiene", () => {
  const aliases = new Set(["arc"]);

  test("generic project reference is metadata, not an eligible symbol", () => {
    const intent = deriveQueryIntent("How does ARC calculate geometry?", { projectNameAliases: aliases });
    expect(intent.projectReferences).toEqual(["ARC"]);
    expect(intent.symbolHypotheses.map((signal) => signal.term)).not.toContain("ARC");
  });

  test("explicit project-named class remains a strong hypothesis", () => {
    const intent = deriveQueryIntent("How does the ARC class initialize project state?", { projectNameAliases: aliases });
    expect(intent.projectReferences).toEqual([]);
    expect(intent.symbolHypotheses.find((signal) => signal.term === "ARC")?.confidence).toBe("explicit_identifier");
  });

  test("ordinary adjective before method does not become a symbol hypothesis", () => {
    const intent = deriveQueryIntent("Unicode method names cause an error");
    expect(intent.symbolHypotheses.map((signal) => signal.term)).not.toContain("Unicode");
  });
});

describe("M135 short identifier confidence", () => {
  test.each(["in this parser", "as the result", "at the end", "no callers", "be careful"])(
    "ordinary prose remains weak: %s",
    (task) => {
      const intent = deriveQueryIntent(task);
      const first = task.split(" ")[0]!.toLowerCase();
      expect(intent.weakLiteralTokens).toContain(first);
      expect(intent.explicitIdentifiers.map((term) => term.toLowerCase())).not.toContain(first);
    },
  );

  test.each([
    ["element In", "In"],
    ["class In", "In"],
    ["symbol In", "In"],
    ["Element.In", "Element.In"],
    ["element.py::In", "element.py::In"],
    ["`In`", "In"],
    ["find symbol DB", "DB"],
  ])("explicit short symbol stays strong: %s", (task, symbol) => {
    expect(deriveQueryIntent(task).explicitIdentifiers).toContain(symbol);
  });

  test("short symbols on both sides of contrast remain contextual identifiers", () => {
    const intent = deriveQueryIntent("find the parser using DB rather than the one using IO");
    expect(intent.explicitIdentifiers).toContain("DB");
    expect(intent.contrastIdentifiers).toContain("IO");
    expect(intent.weakLiteralTokens).not.toEqual(expect.arrayContaining(["db", "io"]));
  });

  test("ordinary preposition metamorphism does not activate In; explicit symbol context does", () => {
    expect(deriveQueryIntent("find parser behavior in this file").explicitIdentifiers).not.toContain("In");
    expect(deriveQueryIntent("find symbol In in this file").explicitIdentifiers).toContain("In");
  });
});
