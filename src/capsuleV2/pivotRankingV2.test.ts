import { describe, it, expect } from "bun:test";

import { SymbolKind } from "../domain/types";
import {
  countEvidenceTypes,
  DEFAULT_PIVOT_RANKING_VERSION,
  parsePivotRankingVersion,
  scorePivot,
  scorePivotLegacy,
  scorePivotV2,
  type PivotRankInput,
} from "./pivotRankingV2";
import type { CapsuleV2Scorecard } from "./types";

// A neutral scorecard; tests override only the fields they exercise.
function scorecard(over: Partial<CapsuleV2Scorecard> = {}): CapsuleV2Scorecard {
  return {
    lexical: 0,
    symbol: 0,
    path: 0,
    test_to_impl: 0,
    body_literal: 0,
    graph_proximity: 0,
    centrality: 0,
    actionability: 1,
    hub_penalty: 0,
    final: 0.5,
    ...over,
  };
}

function input(over: Partial<PivotRankInput> = {}): PivotRankInput {
  return {
    path: "pkg/core/widget.py",
    kind: SymbolKind.Function,
    scorecard: scorecard(),
    evidenceSources: [],
    snippetTokens: 100,
    ...over,
  };
}

describe("pivot ranking v2", () => {
  // (1) v2 boosts candidates with multiple evidence types.
  it("boosts candidates supported by multiple evidence types", () => {
    const single = scorePivotV2(
      input({ kind: SymbolKind.Class, scorecard: scorecard({ symbol: 0.6, final: 0.6 }) }),
    );
    const multi = scorePivotV2(
      input({ kind: SymbolKind.Class, scorecard: scorecard({ lexical: 0.4, path: 0.4, symbol: 0.6, final: 0.6 }) }),
    );
    expect(multi.score).toBeGreaterThan(single.score);
    expect(multi.signals.some((s) => s.startsWith("multi-evidence"))).toBe(true);
  });

  it("countEvidenceTypes counts only signals above the presence threshold", () => {
    expect(countEvidenceTypes(scorecard({ lexical: 0.4, path: 0.4, symbol: 0.6 }))).toBe(3);
    expect(countEvidenceTypes(scorecard({ lexical: 0.1, symbol: 0.6 }))).toBe(1); // 0.1 below threshold
  });

  // (2) v2 prefers specific function/method pivots over broad class/module pivots
  // when evidence supports it.
  it("prefers a specific function over a broad class at equal evidence", () => {
    const sc = scorecard({ lexical: 0.4, path: 0.4, final: 0.6 });
    const fn = scorePivotV2(input({ kind: SymbolKind.Function, scorecard: sc }));
    const cls = scorePivotV2(input({ kind: SymbolKind.Class, scorecard: sc }));
    expect(fn.score).toBeGreaterThan(cls.score);
  });

  // (3) Broad-snippet penalty applies only when support is weak.
  it("penalizes a large broad snippet only when support is weak", () => {
    const weak = scorePivotV2(
      input({ kind: SymbolKind.Class, snippetTokens: 800, scorecard: scorecard({ symbol: 0.5, final: 0.7 }) }),
    );
    expect(weak.penalties.some((p) => p.includes("broad+weak"))).toBe(true);

    const supported = scorePivotV2(
      input({
        kind: SymbolKind.Class,
        snippetTokens: 800,
        scorecard: scorecard({ lexical: 0.4, path: 0.4, symbol: 0.5, final: 0.7 }),
      }),
    );
    expect(supported.penalties.some((p) => p.includes("broad+weak"))).toBe(false);
  });

  // (4) v2 does not penalize large snippets that have strong exact/multi-evidence support.
  it("does not penalize a large snippet with a strong exact match", () => {
    const r = scorePivotV2(
      input({ kind: SymbolKind.Class, snippetTokens: 1200, scorecard: scorecard({ symbol: 0.95, final: 0.8 }) }),
    );
    expect(r.penalties.some((p) => p.includes("broad+weak"))).toBe(false);
    expect(r.signals.some((s) => s.startsWith("strong-exact"))).toBe(true);
  });

  // (5) v2 prefers implementation paths over docs/tests/config when otherwise similar.
  it("prefers an implementation path over a docs/test/config path", () => {
    const sc = scorecard({ lexical: 0.4, path: 0.4, final: 0.6 });
    const impl = scorePivotV2(input({ path: "pkg/core/widget.py", scorecard: sc }));
    const docs = scorePivotV2(input({ path: "docs/usage/widget.py", scorecard: sc }));
    const tests = scorePivotV2(input({ path: "pkg/tests/test_widget.py", scorecard: sc }));
    expect(impl.score).toBeGreaterThan(docs.score);
    expect(impl.score).toBeGreaterThan(tests.score);
    expect(docs.penalties.some((p) => p.includes("non-impl-path"))).toBe(true);
  });

  it("treats a pre-classified non-source example as a non-impl path", () => {
    const r = scorePivotV2(input({ path: "pkg/core/widget.py", isNonSourceExample: true }));
    expect(r.penalties.some((p) => p.includes("non-impl-path"))).toBe(true);
  });

  // (6) v2 emits compact ranking metadata.
  it("emits compact ranking metadata", () => {
    const r = scorePivotV2(input({ scorecard: scorecard({ lexical: 0.4, path: 0.4, final: 0.6 }) }));
    expect(r.version).toBe("v2");
    expect(typeof r.score).toBe("number");
    expect(Array.isArray(r.signals)).toBe(true);
    expect(Array.isArray(r.penalties)).toBe(true);
    expect(typeof r.reason).toBe("string");
    expect(r.reason.length).toBeGreaterThan(0);
  });

  // (7) legacy ranking remains available for comparison.
  it("keeps legacy ranking available (raw final, no deltas)", () => {
    const r = scorePivotLegacy(input({ scorecard: scorecard({ final: 0.42 }) }));
    expect(r.version).toBe("legacy");
    expect(r.score).toBe(0.42);
    expect(r.signals).toEqual([]);
    expect(r.penalties).toEqual([]);
    expect(scorePivot(input(), "legacy").version).toBe("legacy");
    expect(scorePivot(input(), "v2").version).toBe("v2");
    expect(parsePivotRankingVersion(undefined)).toBe(DEFAULT_PIVOT_RANKING_VERSION);
    expect(parsePivotRankingVersion("legacy")).toBe("legacy");
    expect(parsePivotRankingVersion("garbage")).toBe(DEFAULT_PIVOT_RANKING_VERSION);
  });

  // (8) Astropy-like fixture: cds.py-style specific/multi-evidence candidate ranks
  // above the vounit.py-style broad, weakly-supported class — WITHOUT any
  // Astropy/CDS/VOUnit special-casing in the ranker. legacy ranks them the other way.
  it("ranks the cds.py-style candidate above the vounit.py-style broad class", () => {
    // Candidate A: broad class, large snippet, single weak evidence type, HIGHER legacy final.
    const candidateA: PivotRankInput = {
      path: "astropy/units/format/vounit.py",
      kind: SymbolKind.Class,
      snippetTokens: 900,
      evidenceSources: ["symbol"],
      scorecard: scorecard({ symbol: 0.6, test_to_impl: 0.1, final: 0.7 }),
    };
    // Candidate B: specific method, small snippet, three evidence types, LOWER legacy final.
    const candidateB: PivotRankInput = {
      path: "astropy/units/format/cds.py",
      kind: SymbolKind.Method,
      snippetTokens: 120,
      evidenceSources: ["lexical", "path", "symbol"],
      scorecard: scorecard({ lexical: 0.5, path: 0.6, symbol: 0.5, final: 0.6 }),
    };

    // legacy: A above B (raw final 0.7 > 0.6).
    expect(scorePivotLegacy(candidateA).score).toBeGreaterThan(scorePivotLegacy(candidateB).score);
    // v2: B above A.
    expect(scorePivotV2(candidateB).score).toBeGreaterThan(scorePivotV2(candidateA).score);
  });

  // (9) Ranker does not accept or use edited/resolved/outcome fields.
  it("ignores any outcome fields a caller might smuggle in", () => {
    const clean = input({ scorecard: scorecard({ lexical: 0.4, path: 0.4, final: 0.6 }) });
    const leaky = {
      ...clean,
      // None of these are part of PivotRankInput; the ranker must not read them.
      editedFiles: ["pkg/core/widget.py"],
      resolved: true,
      outcome: "resolved",
      repairedPatch: "diff",
      dockerResult: "pass",
    } as unknown as PivotRankInput;
    expect(scorePivotV2(leaky).score).toBe(scorePivotV2(clean).score);
  });
});
