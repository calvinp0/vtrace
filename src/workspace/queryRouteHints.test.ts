// M151 §73-§75 — what a product query is allowed to contribute to routing.
//
// The extractor's job is to be WRONG in one direction only. A missed hint costs a
// routing lane and falls through to the workspace's configured authority; an
// invented hint sends the request to another repository. Every rule here is
// therefore tested for what it refuses as much as for what it accepts.

import { describe, expect, test } from "bun:test";

import { extractQueryRouteHints, MAX_PATH_HINTS, MAX_SYMBOL_HINTS } from "./queryRouteHints";

describe("path hints", () => {
  test("a relative path with an extension is a hint", () => {
    expect(extractQueryRouteHints("Explain src/foo.py please").pathHints).toEqual(["src/foo.py"]);
  });

  test("an absolute path is a hint even without an extension", () => {
    expect(extractQueryRouteHints("look in /home/calvin/code/ARC/arc").pathHints)
      .toEqual(["/home/calvin/code/ARC/arc"]);
  });

  test("surrounding prose punctuation is stripped", () => {
    expect(extractQueryRouteHints("Where is `src/x.py` used, and src/y.py?").pathHints)
      .toEqual(["src/x.py", "src/y.py"]);
  });

  test("an English slash construction is not a path", () => {
    expect(extractQueryRouteHints("should this be and/or handled").pathHints).toEqual([]);
  });

  test("a URL is not a repository path", () => {
    expect(extractQueryRouteHints("see https://example.com/a/b.py").pathHints).toEqual([]);
  });

  test("explicit paths bypass the shape test because they were not guessed", () => {
    const hints = extractQueryRouteHints("no paths in this prose", ["weird thing"]);
    expect(hints.pathHints).toEqual(["weird thing"]);
  });
});

describe("symbol hints", () => {
  test("a snake_case identifier is a hint", () => {
    expect(extractQueryRouteHints("what does determine_family do").symbolHints)
      .toEqual(["determine_family"]);
  });

  test("a qualified name is a hint", () => {
    expect(extractQueryRouteHints("check arc.family::get_all").symbolHints)
      .toEqual(["arc.family::get_all"]);
  });

  test("a camelCase transition is a hint", () => {
    expect(extractQueryRouteHints("where is determineFamily called").symbolHints)
      .toEqual(["determineFamily"]);
  });

  test("a call is a hint even as a bare lowercase word", () => {
    expect(extractQueryRouteHints("who calls which()").symbolHints).toEqual(["which"]);
  });

  test("a backticked bare word is a hint because the caller marked it as code", () => {
    expect(extractQueryRouteHints("how does `cache` work").symbolHints).toEqual(["cache"]);
  });
});

// ---------------------------------------------------------------------------
// §74/§75 — repository identity must never become symbol evidence
// ---------------------------------------------------------------------------

describe("repository names do not become symbol hints (§74, §75)", () => {
  test("a bare all-caps project name is not a symbol", () => {
    // The exact token whose promotion to symbol evidence §74 exists to prevent.
    // A workspace member named ARC must not be chosen because a sentence said ARC.
    const hints = extractQueryRouteHints("How does ARC decide which reaction family wins?");
    expect(hints.symbolHints).toEqual([]);
    expect(hints.pathHints).toEqual([]);
  });

  test("other bare acronyms are equally inert", () => {
    for (const query of ["what does TCKDB store", "is HTTP handled", "the RMG database"]) {
      expect(extractQueryRouteHints(query).symbolHints).toEqual([]);
    }
  });

  test("ordinary prose contributes nothing at all", () => {
    const hints = extractQueryRouteHints(
      "What determines the precedence or order when multiple reaction families match?",
    );
    expect(hints.symbolHints).toEqual([]);
    expect(hints.pathHints).toEqual([]);
  });

  test("a project name still routes when the caller quotes it as code", () => {
    // Quoting is an explicit statement that the token names a definition. The
    // rule is about prose mentions, not about forbidding the string.
    expect(extractQueryRouteHints("what is `ARC` in this codebase").symbolHints).toEqual(["ARC"]);
  });
});

describe("bounds", () => {
  test("hint lists are bounded regardless of query length", () => {
    const query = Array.from({ length: 50 }, (_, index) => `src/f${index}.py sym_${index}`).join(" ");
    const hints = extractQueryRouteHints(query);
    expect(hints.pathHints.length).toBe(MAX_PATH_HINTS);
    expect(hints.symbolHints.length).toBe(MAX_SYMBOL_HINTS);
  });

  test("repeated mentions collapse", () => {
    const hints = extractQueryRouteHints("src/a.py and src/a.py and foo_bar and foo_bar");
    expect(hints.pathHints).toEqual(["src/a.py"]);
    expect(hints.symbolHints).toEqual(["foo_bar"]);
  });
});
