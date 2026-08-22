import { describe, expect, test } from "bun:test";

import { FeatureFamily, FeatureTier, FAMILY_TIERS, retrievalAmbiguity, separation, taskExplicitness } from "./m169Features";

describe("taskExplicitness", () => {
  test("KNOWN POSITIVE: an explicit task names its files, symbols and traceback", () => {
    const features = taskExplicitness(
      "Traceback (most recent call last):\n  File \"astropy/units/format/cds.py\", line 10\n"
      + "in def p_product_of_units. See also astropy/io/ascii/cds.py and the CompoundModel class.",
    );
    expect(features.tracebackPresent).toBe(true);
    expect(features.namedDefinitionPresent).toBe(true);
    expect(features.distinctExplicitFilePaths).toBe(2);
    expect(features.codeIdentifiers).toBeGreaterThan(0);
  });

  test("KNOWN NEGATIVE: a vague task scores zero on every explicitness signal", () => {
    const features = taskExplicitness("The output is wrong when the values are large. Please fix it.");
    expect(features.explicitFilePaths).toBe(0);
    expect(features.tracebackPresent).toBe(false);
    expect(features.namedDefinitionPresent).toBe(false);
    expect(features.codeIdentifiers).toBe(0);
  });

  test("KNOWN NEGATIVE: prose sentences are not file paths", () => {
    // "sentence. Another" must not read as a path, and version numbers are not files.
    expect(taskExplicitness("One thing broke. Another thing broke. Version 3.11 is affected.").explicitFilePaths).toBe(0);
  });

  test("IDENTITY CONTROL: empty text yields zeroes, not nulls or throws", () => {
    const features = taskExplicitness("");
    expect(features.characters).toBe(0);
    expect(features.codeIdentifiers).toBe(0);
  });
});

describe("retrievalAmbiguity", () => {
  test("KNOWN POSITIVE: a decisive top candidate has a wide margin and few near-ties", () => {
    const ambiguity = retrievalAmbiguity([
      { path: "a.py", pivotRankScore: 9 }, { path: "b.py", pivotRankScore: 2 }, { path: "c.py", pivotRankScore: 1 },
    ]);
    expect(ambiguity.scoreMargin).toBe(7);
    expect(ambiguity.nearTopCandidates).toBe(1);
    expect(ambiguity.distinctFilesInTopTen).toBe(3);
  });

  test("KNOWN POSITIVE: a torn ranking has a narrow margin and many near-ties", () => {
    const ambiguity = retrievalAmbiguity([
      { path: "a.py", pivotRankScore: 2.6 }, { path: "b.py", pivotRankScore: 2.58 }, { path: "a.py", pivotRankScore: 2.55 },
    ]);
    expect(ambiguity.scoreMargin!).toBeLessThan(0.05);
    expect(ambiguity.nearTopCandidates).toBe(3);
    expect(ambiguity.distinctFilesInTopTen).toBe(2);
  });

  test("KNOWN NEGATIVE: an empty ranking reports nulls, never zeroes that look like decisiveness", () => {
    const ambiguity = retrievalAmbiguity([]);
    expect(ambiguity.topScore).toBeNull();
    expect(ambiguity.scoreMargin).toBeNull();
    expect(ambiguity.nearTopCandidates).toBeNull();
  });

  test("a single candidate has no margin at all, and says so", () => {
    expect(retrievalAmbiguity([{ path: "a.py", pivotRankScore: 3 }]).scoreMargin).toBeNull();
  });
});

describe("separation", () => {
  test("KNOWN POSITIVE: fully disjoint groups SEPARATE", () => {
    const result = separation("f", FeatureFamily.TaskExplicitness, "hi", [10, 11, 12], "lo", [1, 2, 3]);
    expect(result.verdict).toBe("SEPARATES");
    expect(result.cleanlySeparated).toBe(true);
    expect(result.rankOverlapStatistic).toBe(1);
  });

  test("KNOWN NEGATIVE: identical groups are NULL and sit at 0.5", () => {
    const result = separation("f", FeatureFamily.RepositoryScale, "a", [1, 2, 3], "b", [1, 2, 3]);
    expect(result.verdict).toBe("NULL");
    expect(result.rankOverlapStatistic).toBe(0.5);
  });

  test("IDENTITY CONTROL: groups too small report NOT_ENOUGH_DATA rather than a verdict", () => {
    const result = separation("f", FeatureFamily.RetrievalAmbiguity, "a", [1, 2], "b", [3, 4, 5]);
    expect(result.verdict).toBe("NOT_ENOUGH_DATA");
    expect(result.rankOverlapStatistic).toBeNull();
  });

  test("overlapping but shifted groups are WEAK, not SEPARATES", () => {
    const result = separation("f", FeatureFamily.TaskExplicitness, "a", [5, 6, 9], "b", [1, 2, 7]);
    expect(result.verdict).toBe("WEAK");
    expect(result.cleanlySeparated).toBe(false);
  });
});

describe("tiers", () => {
  test("only task text and repository size are available before invocation", () => {
    expect(FAMILY_TIERS[FeatureFamily.TaskExplicitness]).toBe(FeatureTier.PreInvocation);
    expect(FAMILY_TIERS[FeatureFamily.RepositoryScale]).toBe(FeatureTier.PreInvocation);
    expect(FAMILY_TIERS[FeatureFamily.RetrievalAmbiguity]).toBe(FeatureTier.PreDelivery);
    expect(FAMILY_TIERS[FeatureFamily.ExpectedImpactBreadth]).toBe(FeatureTier.PreDelivery);
  });
});
