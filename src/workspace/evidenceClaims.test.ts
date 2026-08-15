/**
 * M149 §119 — the claim-boundary contract, tested as logic.
 *
 * Like M147's presence proof, these cases carry no workspace, no index and no
 * database. What they pin down is not whether a scan works but what a scan's
 * RESULTS entitle a consumer to say, and that question has exactly one right
 * answer per shape of input. A bug here is a bug in the milestone's central
 * claim rather than in its plumbing.
 *
 * The governing asymmetry, restated because every case below turns on it:
 *
 *   A POSITIVE observation settles itself. No unasked member can retract it.
 *   A NEGATIVE is a claim about everyone who did not answer, so it is only ever
 *   as wide as the set that did.
 */
import { describe, expect, test } from "bun:test";

import {
  canClaimAbsence,
  CAPABILITY_SETTLES_MEMBER_ABSENCE,
  classifyNegativeClaim,
  composeCoverage,
  describeNegativeClaim,
  EvidenceCapability,
  EvidenceScope,
  MAX_REPORTED_COVERAGE_EXAMPLES,
  negativeStrengthWithin,
  NegativeClaimStrength,
  scopeWithin,
  unobservedCoverage,
  boundedJoin,
} from "./evidenceClaims";

/** An exact-source scan of `considered` members, `answered` of which replied. */
function scan(considered: number, answered: number, extra: {
  refusedWithoutEvidence?: number;
  omittedByBound?: number;
  capability?: EvidenceCapability;
} = {}) {
  const missing = considered - answered;
  return composeCoverage({
    capability: extra.capability ?? EvidenceCapability.SymbolExactLookup,
    purpose: "deciding",
    scope: EvidenceScope.EnabledMembers,
    considered,
    answered,
    refusedWithoutEvidence: extra.refusedWithoutEvidence ?? missing,
    omittedByBound: extra.omittedByBound ?? 0,
  });
}

describe("M149 claim-strength model (§30)", () => {
  test("a partial authoritative scan earns a BOUNDED absence", () => {
    // Seven members answered from an exact source and none held the target.
    // That is a real negative — it just is not a negative about the other three.
    const coverage = scan(10, 7);

    expect(coverage.complete).toBe(false);
    expect(classifyNegativeClaim(coverage)).toBe(NegativeClaimStrength.BoundedAbsence);
  });

  test("zero answered is NOT OBSERVED, however many were considered", () => {
    // §26: declining to look is not a finding. This is the case that used to
    // read as "No repository carries evidence for this request."
    const coverage = scan(10, 0);

    expect(classifyNegativeClaim(coverage)).toBe(NegativeClaimStrength.NotObserved);
    expect(canClaimAbsence(coverage, EvidenceScope.ScannedMembers)).toBe(false);
    expect(canClaimAbsence(coverage, EvidenceScope.MemberLocal)).toBe(false);
  });

  test("a complete authoritative scan earns an AUTHORITATIVE absence", () => {
    const coverage = scan(10, 10);

    expect(coverage.complete).toBe(true);
    expect(classifyNegativeClaim(coverage)).toBe(NegativeClaimStrength.AuthoritativeAbsence);
    expect(canClaimAbsence(coverage, EvidenceScope.EnabledMembers)).toBe(true);
  });

  test("a ranked-retrieval miss never earns absence, even when complete", () => {
    // §54. Every enabled member was searched and nothing came back — and that
    // still proves nothing, because the source itself is capped and fuzzy.
    const coverage = composeCoverage({
      capability: EvidenceCapability.RankedRetrieval,
      purpose: "deciding",
      scope: EvidenceScope.EnabledMembers,
      considered: 10,
      answered: 10,
    });

    expect(coverage.complete).toBe(true);
    expect(classifyNegativeClaim(coverage)).toBe(NegativeClaimStrength.NotObserved);
    expect(canClaimAbsence(coverage, EvidenceScope.MemberLocal)).toBe(false);
    expect(CAPABILITY_SETTLES_MEMBER_ABSENCE[EvidenceCapability.RankedRetrieval]).toBe(false);
  });

  test("a lane that never ran knows nothing", () => {
    const coverage = unobservedCoverage(EvidenceCapability.PathMembership, EvidenceScope.EnabledMembers, 4);

    expect(coverage.answered).toBe(0);
    expect(coverage.complete).toBe(false);
    expect(classifyNegativeClaim(coverage)).toBe(NegativeClaimStrength.NotObserved);
  });
});

describe("M149 scope escalation (§32)", () => {
  test("a bounded absence may be stated over the scanned set and no wider", () => {
    const coverage = scan(10, 7);

    expect(canClaimAbsence(coverage, EvidenceScope.MemberLocal)).toBe(true);
    expect(canClaimAbsence(coverage, EvidenceScope.ScannedMembers)).toBe(true);
    // The three members that never answered are exactly the ones these two
    // scopes would be speaking for.
    expect(canClaimAbsence(coverage, EvidenceScope.EnabledMembers)).toBe(false);
    expect(canClaimAbsence(coverage, EvidenceScope.Workspace)).toBe(false);
  });

  test("even a complete enabled-member scan cannot speak for the workspace", () => {
    // A disabled member is outside the population the lane asked, so no lane
    // may make a claim about the workspace as a whole.
    const coverage = scan(10, 10);

    expect(canClaimAbsence(coverage, EvidenceScope.EnabledMembers)).toBe(true);
    expect(canClaimAbsence(coverage, EvidenceScope.Workspace)).toBe(false);
  });

  test("the scope and strength orders are total and correctly directed", () => {
    expect(scopeWithin(EvidenceScope.MemberLocal, EvidenceScope.Workspace)).toBe(true);
    expect(scopeWithin(EvidenceScope.Workspace, EvidenceScope.MemberLocal)).toBe(false);
    expect(scopeWithin(EvidenceScope.EnabledMembers, EvidenceScope.EnabledMembers)).toBe(true);

    expect(negativeStrengthWithin(
      NegativeClaimStrength.NotObserved,
      NegativeClaimStrength.AuthoritativeAbsence,
    )).toBe(true);
    expect(negativeStrengthWithin(
      NegativeClaimStrength.AuthoritativeAbsence,
      NegativeClaimStrength.BoundedAbsence,
    )).toBe(false);
  });
});

describe("M149 refusal vs bound (§49)", () => {
  test("both prevent escalation identically", () => {
    const refused = scan(10, 7, { refusedWithoutEvidence: 3, omittedByBound: 0 });
    const bounded = scan(10, 7, { refusedWithoutEvidence: 0, omittedByBound: 3 });

    expect(classifyNegativeClaim(refused)).toBe(classifyNegativeClaim(bounded));
    expect(canClaimAbsence(refused, EvidenceScope.EnabledMembers)).toBe(false);
    expect(canClaimAbsence(bounded, EvidenceScope.EnabledMembers)).toBe(false);
  });

  test("but stay distinguishable in coverage, because the remedies differ", () => {
    // Repair an index; raise a bound. A consumer that cannot tell these apart
    // sends someone to the wrong fix.
    const refused = scan(10, 7, { refusedWithoutEvidence: 3, omittedByBound: 0 });
    const bounded = scan(10, 7, { refusedWithoutEvidence: 0, omittedByBound: 3 });

    expect(refused.refusedWithoutEvidence).toBe(3);
    expect(refused.omittedByBound).toBe(0);
    expect(bounded.refusedWithoutEvidence).toBe(0);
    expect(bounded.omittedByBound).toBe(3);
  });
});

describe("M149 bounded presentation (§51)", () => {
  test("coverage examples are capped and the remainder is counted", () => {
    const examples = Array.from({ length: 999 }, (_, index) => ({
      alias: `m${index}`,
      reason: "index_refused",
    }));
    const coverage = composeCoverage({
      capability: EvidenceCapability.SymbolExactLookup,
      purpose: "deciding",
      scope: EvidenceScope.EnabledMembers,
      considered: 1000,
      answered: 1,
      refusedWithoutEvidence: 999,
      examples,
    });

    expect(coverage.examples).toHaveLength(MAX_REPORTED_COVERAGE_EXAMPLES);
    expect(coverage.examplesOmitted).toBe(999 - MAX_REPORTED_COVERAGE_EXAMPLES);
    // The counts are the truth; the list is only ever a sample of it.
    expect(coverage.refusedWithoutEvidence).toBe(999);
    expect(JSON.stringify(coverage).length).toBeLessThan(600);
  });

  test("truncating the report cannot change what the report concludes", () => {
    const many = composeCoverage({
      capability: EvidenceCapability.SymbolExactLookup,
      purpose: "deciding",
      scope: EvidenceScope.EnabledMembers,
      considered: 1000,
      answered: 1000,
      examples: [],
    });

    expect(classifyNegativeClaim(many)).toBe(NegativeClaimStrength.AuthoritativeAbsence);
  });

  test("boundedJoin names a few and counts the rest", () => {
    expect(boundedJoin(["a", "b"])).toBe("a, b");
    expect(boundedJoin(["a", "b", "c", "d", "e", "f"])).toBe("a, b, c, d and 2 more");
  });
});

describe("M149 negative wording (§109/§110/§111)", () => {
  const subject = { verb: "defines", noun: "this name" };

  test("a complete negative is stated plainly, with its scope", () => {
    expect(describeNegativeClaim(scan(3, 3), subject))
      .toBe("No eligible repository defines this name; all 3 were checked.");
  });

  test("an incomplete negative carries its qualifier rather than omitting it", () => {
    const sentence = describeNegativeClaim(scan(10, 7), subject);

    expect(sentence).toContain("7 repositories checked");
    expect(sentence).toContain("3 of 10 could not be checked");
    // §110: incompleteness must be visible, never dropped to look decisive.
    expect(sentence).toContain("not a claim about the whole workspace");
  });

  test("an unobserved negative claims nothing about the world", () => {
    const sentence = describeNegativeClaim(scan(10, 0), subject);

    expect(sentence).toContain("nothing is known");
    expect(sentence).not.toContain("all 10 were checked");
  });
});
