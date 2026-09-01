/**
 * M197A — falsification controls F4 to F8.
 *
 * Each test states one way a claim could have been passed dishonestly and shows
 * that the scoring rule refuses it. They are written against synthetic inputs on
 * purpose: a control that only exercises the run's own output cannot show what
 * the rule would have done with a result that tried to cheat.
 */

import { describe, expect, test } from "bun:test";

import {
  callSiteIsRendered,
  countsTowardReduction,
  determinismVerdict,
  isStructuralDeclaration,
  renderSkeleton,
  satisfiedByDefaultOutput,
  semanticProjection,
  signatureFaults,
  skeletonValidity,
  supportedLanguageCount,
} from "./m197aScoring";

const SOURCE = [
  "// a leading comment",
  "export function editedFilesFromPatch(patch: string): string[] {",
  "  return [];",
  "}",
  "",
  "export async function withTempRepo(run: (repoRoot: string) => Promise<void>): Promise<void> {",
  "  await run('/tmp');",
  "}",
].join("\n");

describe("F4 — a malformed skeleton cannot count as a reduction success", () => {
  test("a signature sliced mid-identifier at both ends is rejected", () => {
    // The real shape observed on C-MED: "export" cut to "t ", ")" never closed.
    const faults = signatureFaults("t function editedFilesFromPatch(patch: string): string[", SOURCE);

    expect(faults).toContain("SLICED_MID_IDENTIFIER_START");
    expect(faults).toContain("UNBALANCED_BRACKETS");
  });

  test("a complete signature containing => is NOT flagged", () => {
    // The checker must not mistake an arrow function for an unclosed generic;
    // an earlier version did, and reported the product malformed for it.
    const faults = signatureFaults(
      "export async function withTempRepo(run: (repoRoot: string) => Promise<void>): Promise<void>",
      SOURCE,
    );

    expect(faults).toEqual([]);
  });

  test("a signature absent from the source is rejected as fabricated", () => {
    expect(signatureFaults("function neverWritten(): void", SOURCE)).toEqual(["SIGNATURE_NOT_IN_SOURCE"]);
  });

  test("a tiny malformed representation is excluded from the reduction population", () => {
    const malformed = {
      declarations: [{ kind: "function", name: "editedFilesFromPatch", members: [],
        signature: "t function editedFilesFromPatch(patch: string): string[" }],
    };
    const validity = skeletonValidity(malformed, SOURCE);

    // It would have scored a spectacular reduction had it been counted.
    expect(renderSkeleton(malformed).length).toBeLessThan(SOURCE.length);
    expect(countsTowardReduction(validity)).toBe(false);
    expect(validity.validSignatures).toBe(0);
  });

  test("a well-formed skeleton does count", () => {
    const valid = {
      declarations: [{ kind: "function", name: "editedFilesFromPatch", members: [],
        signature: "export function editedFilesFromPatch(patch: string): string[] {" }],
    };

    expect(countsTowardReduction(skeletonValidity(valid, SOURCE))).toBe(true);
  });

  test("the structural <module> symbol is not counted as a missing signature", () => {
    const file = { declarations: [{ kind: "module", name: "<module>", members: [] }] };

    expect(isStructuralDeclaration(file.declarations[0]!)).toBe(true);
    expect(skeletonValidity(file, SOURCE).declarations).toBe(0);
    expect(countsTowardReduction(skeletonValidity(file, SOURCE))).toBe(true);
  });
});

describe("F5 — file:line does not satisfy call-expression rendering", () => {
  test("coordinates alone are not a rendered expression", () => {
    expect(callSiteIsRendered({
      referenceName: "normalizeFilePath",
      callSites: [{ startLine: 238, endLine: 238 }],
    })).toBe(false);
  });

  test("source text that does not name the callee does not count", () => {
    // Observed on C-MED: the rendered line is the one before the call.
    expect(callSiteIsRendered({
      sourceText: "): string | undefined {",
      referenceName: "normalizeFilePath",
      callSites: [{ startLine: 238, endLine: 238 }],
    })).toBe(false);
  });

  test("an empty rendering does not count", () => {
    expect(callSiteIsRendered({ sourceText: "   ", referenceName: "openIndexerDatabase" })).toBe(false);
  });

  test("source text naming the callee counts", () => {
    expect(callSiteIsRendered({
      sourceText: "  const hint = normalizeFilePath(pathHint);",
      referenceName: "normalizeFilePath",
    })).toBe(true);
  });
});

describe("F6 — a debug-only capability does not satisfy a default-output claim", () => {
  test("present only at detail=debug does not satisfy the claim", () => {
    expect(satisfiedByDefaultOutput({ inDefaultResponse: false, inDebugResponse: true })).toBe(false);
  });

  test("present in the default response satisfies it", () => {
    expect(satisfiedByDefaultOutput({ inDefaultResponse: true, inDebugResponse: true })).toBe(true);
  });
});

describe("F7 — a declared enum without a parser does not satisfy A1", () => {
  test("only parser-backed families count", () => {
    expect(supportedLanguageCount({
      declaredEnum: ["typescript", "javascript", "python", "cython", "yaml", "toml", "go", "rust"],
      extensionDetected: ["typescript", "javascript", "python", "cython", "yaml", "toml"],
      parserBacked: ["typescript", "python", "cython"],
    })).toBe(3);
  });

  test("a detection rule with no parser does not count", () => {
    expect(supportedLanguageCount({
      declaredEnum: ["yaml"], extensionDetected: ["yaml"], parserBacked: [],
    })).toBe(0);
  });

  test("thirty declared members with no parsers still score zero", () => {
    const declared = Array.from({ length: 30 }, (_u, i) => `lang${i}`);

    expect(supportedLanguageCount({
      declaredEnum: declared, extensionDetected: declared, parserBacked: [],
    })).toBe(0);
  });
});

describe("F8 — repeated semantic output that differs fails the measurement", () => {
  test("two distinct hashes for one query is non-deterministic", () => {
    const verdict = determinismVerdict(new Map([
      ["stable query", new Set(["hash-a"])],
      ["unstable query", new Set(["hash-a", "hash-b"])],
    ]));

    expect(verdict.deterministic).toBe(false);
    expect(verdict.unstableQueries).toEqual(["unstable query"]);
  });

  test("one hash per query across every repetition is deterministic", () => {
    const verdict = determinismVerdict(new Map([
      ["q1", new Set(["hash-a"])],
      ["q2", new Set(["hash-b"])],
    ]));

    expect(verdict.deterministic).toBe(true);
    expect(verdict.unstableQueries).toEqual([]);
  });

  test("the projection removes latency, so a timing difference is not instability", () => {
    const a = { nodes: ["x"], timing: { totalMs: 45.9 }, responseBudget: { serializedCharacters: 7757 } };
    const b = { nodes: ["x"], timing: { totalMs: 20.1 }, responseBudget: { serializedCharacters: 7756 } };

    expect(JSON.stringify(semanticProjection(a))).toBe(JSON.stringify(semanticProjection(b)));
  });

  test("the projection still exposes a genuine content change", () => {
    const a = { nodes: ["x"], timing: { totalMs: 45.9 } };
    const b = { nodes: ["y"], timing: { totalMs: 45.9 } };

    expect(JSON.stringify(semanticProjection(a))).not.toBe(JSON.stringify(semanticProjection(b)));
  });

  test("latency-derived size counters are stripped, content counters are not invented", () => {
    // Observed on C-MED: two flow responses identical but for these counters,
    // which are computed over a string that still contains the timing floats.
    const a = { paths: [{ n: 1 }], accounting: { estimatedOutputTokens: 1420, latencyMs: 13.8 } };
    const b = { paths: [{ n: 1 }], accounting: { estimatedOutputTokens: 1422, latencyMs: 14.3 } };

    expect(JSON.stringify(semanticProjection(a))).toBe(JSON.stringify(semanticProjection(b)));
    // ... and a real change to the evidence itself still differs.
    const c = { paths: [{ n: 2 }], accounting: { estimatedOutputTokens: 1420, latencyMs: 13.8 } };
    expect(JSON.stringify(semanticProjection(a))).not.toBe(JSON.stringify(semanticProjection(c)));
  });

  test("the projection preserves spans, paths and ordering", () => {
    const a = { steps: [{ file: "a.ts", line: 3 }, { file: "b.ts", line: 9 }] };
    const reordered = { steps: [{ file: "b.ts", line: 9 }, { file: "a.ts", line: 3 }] };

    expect(JSON.stringify(semanticProjection(a))).not.toBe(JSON.stringify(semanticProjection(reordered)));
    expect(semanticProjection(a)).toEqual(a);
  });
});
