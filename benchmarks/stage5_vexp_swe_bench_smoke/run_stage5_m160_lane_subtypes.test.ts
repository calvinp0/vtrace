import { describe, expect, test } from "bun:test";

import { assignSubtype, namesOwnerUnambiguously } from "./run_stage5_m160_lane_subtypes";

describe("M160 lane-generation subtyping (§50-§53)", () => {
  test("an unrepresented gold symbol is not a bridging question at all", () => {
    const result = assignSubtype({
      goldIndexed: false,
      namesOwnerUnambiguously: false,
      identifiersIndexed: 3,
      goldReachableFromQuery: false,
      sameSubjectOwners: 4,
    });
    expect(result.subtype).toBe("OTHER_LANE_GENERATION");
  });

  test("§51: subject indexed, gold unreachable — subject→owner qualifies", () => {
    const result = assignSubtype({
      goldIndexed: true,
      namesOwnerUnambiguously: false,
      identifiersIndexed: 2,
      goldReachableFromQuery: false,
      sameSubjectOwners: 1,
    });
    expect(result.subtype).toBe("SUBJECT_OWNER");
  });

  test("naming a nearly-unique gold symbol that generation still missed is its own subtype", () => {
    const result = assignSubtype({
      goldIndexed: true,
      namesOwnerUnambiguously: true,
      identifiersIndexed: 2,
      goldReachableFromQuery: false,
      sameSubjectOwners: 5,
    });
    expect(result.subtype).toBe("NAMED_BUT_UNSCORED");
  });

  test("§52: several owners share the subject and gold is reachable — result/effect qualifies", () => {
    const result = assignSubtype({
      goldIndexed: true,
      namesOwnerUnambiguously: false,
      identifiersIndexed: 2,
      goldReachableFromQuery: true,
      sameSubjectOwners: 3,
    });
    expect(result.subtype).toBe("RESULT_EFFECT");
  });

  test("§53: both conditions hold together and neither is forced out", () => {
    const result = assignSubtype({
      goldIndexed: true,
      namesOwnerUnambiguously: false,
      identifiersIndexed: 2,
      goldReachableFromQuery: false,
      sameSubjectOwners: 3,
    });
    expect(result.subtype).toBe("SUBJECT_OWNER + RESULT_EFFECT");
  });

  test("a query naming nothing the index represents has no subject to bridge FROM", () => {
    const result = assignSubtype({
      goldIndexed: true,
      namesOwnerUnambiguously: false,
      identifiersIndexed: 0,
      goldReachableFromQuery: false,
      sameSubjectOwners: 0,
    });
    expect(result.subtype).toBe("SUBJECT_UNREPRESENTED");
  });

  test("reachable gold with an unambiguous subject stays OTHER — the default is not a leftover bin", () => {
    const result = assignSubtype({
      goldIndexed: true,
      namesOwnerUnambiguously: false,
      identifiersIndexed: 4,
      goldReachableFromQuery: true,
      sameSubjectOwners: 1,
    });
    expect(result.subtype).toBe("OTHER_LANE_GENERATION");
  });
});

describe("M160 ownership-naming detector correction (§44)", () => {
  test("KNOWN POSITIVE: an ambiguous method name does NOT name an owner", () => {
    // scikit-learn-13142: the task says `fit_predict`, which the index defines
    // nine times, and the class the task names inherits it rather than defining
    // it. Treating that as "the task named the owner" hid a bridging failure.
    expect(namesOwnerUnambiguously(["fit_predict"], new Map([["fit_predict", 9]]))).toBe(false);
  });

  test("a nearly-unique name does name an owner", () => {
    expect(namesOwnerUnambiguously(["resolve_lookup_value"], new Map([["resolve_lookup_value", 1]]))).toBe(true);
  });

  test("a dunder never names an owner however unique the index says it is", () => {
    // matplotlib-20859's gold symbol is `__init__`, which appears in the task's
    // traceback and identifies nothing at all.
    expect(namesOwnerUnambiguously(["__init__"], new Map([["__init__", 1]]))).toBe(false);
  });

  test("a name absent from the index does not count as naming its owner", () => {
    expect(namesOwnerUnambiguously(["ghost"], new Map())).toBe(false);
  });

  test("a Class.method form is judged on the method's own ambiguity", () => {
    expect(namesOwnerUnambiguously(["BaseMixture.fit_predict"], new Map([["fit_predict", 9]]))).toBe(false);
  });
});
