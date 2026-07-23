import { describe, expect, test } from "bun:test";

import { extractEmbeddedPathClues, shapeSweQuery } from "../capsule/sweQueryShaping";
import { matchPathClues } from "./pathScopedRelevance";

describe("M128 embedded path clues", () => {
  test("retains component-aware subtree, directory, and filename clues in prose", () => {
    const task = "Run for clients/python changes, inspect .github/workflows and python-client-ci.yml.";
    const shaped = shapeSweQuery({ problemStatement: task });
    expect(shaped.pathClues?.map((clue) => clue.normalized)).toEqual([
      "clients/python",
      ".github/workflows",
      "python-client-ci.yml",
    ]);
    expect(shaped.query).toContain("issue:");
    expect(matchPathClues("clients/python/tests/test_client.py", shaped.pathClues ?? [])[0]).toMatchObject({
      normalizedClue: "clients/python",
      matchType: "directory_prefix",
      subtreeMatch: true,
    });
    expect(matchPathClues("backend/python_tools.py", shaped.pathClues ?? [])).toEqual([]);
  });

  test("normalizes requested variants without consuming URLs or spaced slash prose", () => {
    for (const value of ["clients/python", "clients/python changes", "clients/python/", "./clients/python"]) {
      expect(extractEmbeddedPathClues(value)[0]?.normalized).toBe("clients/python");
    }
    expect(extractEmbeddedPathClues("immutability / supersession")).toEqual([]);
    expect(extractEmbeddedPathClues("see https://example.test/clients/python/file.py")).toEqual([]);
    expect(extractEmbeddedPathClues("C:\\repo\\clients\\python")).toEqual([]);
    expect(extractEmbeddedPathClues("Traceback at src/file.py:12")[0]?.normalized).toBe("src/file.py");
  });
});
