import { describe, expect, test } from "bun:test";

import { classifyTaskLanguage } from "./m160TaskLanguage";

describe("M160 task-language classification (§57)", () => {
  test("a task naming the gold symbol is identifier-driven", () => {
    const result = classifyTaskLanguage(
      "resolve_lookup_value crashes on a named tuple",
      ["resolve_lookup_value"],
      ["django/db/models/sql/query.py"],
    );
    expect(result.primary).toBe("IDENTIFIER_DRIVEN");
    expect(result.namesGoldSymbol).toBe(true);
  });

  test("a task naming only a path is path-driven", () => {
    const result = classifyTaskLanguage("Something is wrong in astropy/io/ascii/qdp.py here.", [], []);
    expect(result.flags.pathDriven).toBe(true);
  });

  test("a traceback makes a task error-message-driven", () => {
    const result = classifyTaskLanguage(
      "It breaks.\nErrors: ValueError\nTraceback: ValueError: Unrecognized QDP line",
      [],
      [],
    );
    expect(result.flags.errorMessageDriven).toBe(true);
  });

  test("pure prose about a wrong result is result/effect-driven", () => {
    const result = classifyTaskLanguage("The call returns the wrong output for empty input.", [], []);
    expect(result.primary).toBe("RESULT_EFFECT_DRIVEN");
    expect(result.flags.resultEffectDriven).toBe(true);
  });

  test("prose describing only wrong behaviour falls through to behaviour-driven", () => {
    const result = classifyTaskLanguage("It should not happen this way.", [], []);
    expect(result.primary).toBe("BEHAVIOR_DRIVEN");
  });

  test("a short gold symbol is not matched as a word (avoids accidental hits)", () => {
    const result = classifyTaskLanguage("the sum is off by one", ["f"], []);
    expect(result.namesGoldSymbol).toBe(false);
  });

  test("gold file stem detection is case-insensitive and stem-only", () => {
    const result = classifyTaskLanguage("Aggregates behave oddly", [], ["django/db/models/aggregates.py"]);
    expect(result.namesGoldFileStem).toBe(true);
  });

  test("flags are non-exclusive — one task can offer several handles", () => {
    const result = classifyTaskLanguage(
      "`polyval` returns wrong output; see xarray/core/computation.py; test_polyval fails",
      ["polyval"],
      ["xarray/core/computation.py"],
    );
    expect(result.flags.identifierDriven).toBe(true);
    expect(result.flags.pathDriven).toBe(true);
    expect(result.flags.testFailureDriven).toBe(true);
    expect(result.flags.resultEffectDriven).toBe(true);
    expect(result.primary).toBe("IDENTIFIER_DRIVEN");
  });
});
