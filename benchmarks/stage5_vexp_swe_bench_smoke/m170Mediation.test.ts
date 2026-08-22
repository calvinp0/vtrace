import { describe, expect, test } from "bun:test";

import {
  MediationVerdict,
  WINDOW_PARAMETERS,
  WindowPolicy,
  classifyMediation,
  disclosureFor,
  renderCatN,
  selectWindow,
  unionSpan,
  type RankedSpan,
} from "./m170Mediation";

const ranked = (entries: readonly [string, number, number, number][], scopes: Record<string, [number, number]> = {}): RankedSpan[] =>
  entries.map(([fqName, rank, first, last]) => ({
    fqName, rank, first, last,
    ...(scopes[fqName] === undefined ? {} : { scope: { first: scopes[fqName]![0], last: scopes[fqName]![1] } }),
  }));

describe("window selection", () => {
  test("a small file is never mediated: there is nothing to save", () => {
    const spans = ranked([["a::f", 0, 10, 20]]);
    expect(selectWindow(WindowPolicy.TopSymbol, spans, WINDOW_PARAMETERS.minimumFileLines - 1)).toBeNull();
    expect(selectWindow(WindowPolicy.TopSymbol, spans, WINDOW_PARAMETERS.minimumFileLines + 1)).not.toBeNull();
  });

  test("no ranked symbol in the file means decline, not a guess", () => {
    expect(selectWindow(WindowPolicy.TopSymbol, [], 500)).toBeNull();
    expect(selectWindow(WindowPolicy.CoverTopK, [], 500)).toBeNull();
  });

  test("a window that would deliver most of the file declines instead", () => {
    const spans = ranked([["a::C", 0, 10, 480]]);
    expect(selectWindow(WindowPolicy.TopSymbol, spans, 500)).toBeNull();
  });

  test("the margin is applied and clamped to the file", () => {
    const spans = ranked([["a::f", 0, 5, 40]]);
    expect(selectWindow(WindowPolicy.TopSymbol, spans, 500)).toEqual({ first: 1, last: 60 });
  });

  test("scope widening reaches a sibling the top-ranked symbol excludes", () => {
    // The django shape: the issue quotes __init__, the fix is in execute.
    const spans = ranked([["m::U.__init__", 0, 188, 193]], { "m::U.__init__": [184, 408] });
    expect(selectWindow(WindowPolicy.TopSymbol, spans, 415)).toEqual({ first: 168, last: 213 });
    expect(selectWindow(WindowPolicy.TopSymbolScope, spans, 415)).toEqual({ first: 164, last: 415 });
  });

  test("covering more ranked symbols widens monotonically", () => {
    const spans = ranked([["a::f", 0, 100, 120], ["a::g", 1, 300, 330], ["a::h", 2, 500, 520]]);
    const top = selectWindow(WindowPolicy.TopSymbol, spans, 2000)!;
    const cover = selectWindow(WindowPolicy.CoverAllRanked, spans, 2000)!;
    expect(cover.first).toBeLessThanOrEqual(top.first);
    expect(cover.last).toBeGreaterThanOrEqual(top.last);
  });

  test("the oracle policy reads the future and is labelled as doing so", () => {
    expect(WindowPolicy.Oracle).toContain("UPPER_BOUND");
    expect(selectWindow(WindowPolicy.Oracle, [], 500, [{ first: 300, last: 305 }])).toEqual({ first: 280, last: 325 });
  });

  test("unionSpan of nothing is nothing", () => {
    expect(unionSpan([])).toBeNull();
  });
});

describe("rendering and disclosure", () => {
  test("renders exactly what Read renders", () => {
    const lines = ["alpha", "beta", "gamma", "delta"];
    expect(renderCatN(lines, { first: 2, last: 3 })).toBe("2\tbeta\n3\tgamma");
  });

  test("a window past the end of the file stops at the end", () => {
    expect(renderCatN(["a", "b"], { first: 1, last: 99 })).toBe("1\ta\n2\tb");
  });

  test("the disclosure states the bound the harness would not have stated", () => {
    const text = disclosureFor("pkg/mod.py", { first: 40, last: 90 }, 900);
    expect(text).toContain("PARTIAL view");
    expect(text).toContain("lines 40-90 of 900");
    expect(text).toContain("offset/limit");
  });
});

describe("mediation verdicts", () => {
  const window = { first: 100, last: 200 };

  test("declining is its own outcome", () => {
    expect(classifyMediation(null, { editAnchors: [1], rereadSpans: [] })).toBe(MediationVerdict.Declined);
  });

  test("everything the agent used inside the window is safe", () => {
    expect(classifyMediation(window, { editAnchors: [150], rereadSpans: [{ first: 120, last: 180 }] }))
      .toBe(MediationVerdict.Safe);
  });

  test("an edit outside the window that the agent never paged to is unsafe", () => {
    expect(classifyMediation(window, { editAnchors: [347], rereadSpans: [] })).toBe(MediationVerdict.Unsafe);
  });

  test("an edit outside the window the agent DID page to is credited, not condemned", () => {
    expect(classifyMediation(window, { editAnchors: [347], rereadSpans: [{ first: 330, last: 360 }] }))
      .toBe(MediationVerdict.RecoverableOverprune);
  });

  test("a further page with no edit at stake is recoverable, not safe", () => {
    expect(classifyMediation(window, { editAnchors: [150], rereadSpans: [{ first: 400, last: 450 }] }))
      .toBe(MediationVerdict.RecoverableOverprune);
  });
});
