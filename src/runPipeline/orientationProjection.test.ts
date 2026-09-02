/**
 * The default disclosure contract.
 *
 * These are the properties a compact default has to have before it is allowed to
 * be the default: it must be smaller, it must not assert anything the
 * authoritative result does not support, it must not turn omission into absence,
 * and it must decline entirely on states where a terse answer would be a
 * dangerous one.
 */

import { describe, expect, test } from "bun:test";

import {
  NEIGHBOR_RELATION_PHRASES,
  ORIENTATION_BOUNDARY,
  ORIENTATION_CHARACTERS_PER_REQUESTED_TOKEN,
  ORIENTATION_FROZEN_PHRASES,
  ORIENTATION_POLICY,
  ORIENTATION_SCHEMA_VERSION,
  orientationCeilingTokens,
  orientationTokens,
  projectRunPipelineOrientation,
} from "./orientationProjection";
import { orientationAccountingOf, orientationTokensOfCharacters } from "./orientationAccounting";

/** An authoritative result shaped like the real one, with `count` related symbols. */
function authoritative(count: number, overrides: Record<string, unknown> = {}, bodyChars = 300): Record<string, unknown> {
  const items = Array.from({ length: count + 1 }, (_, index) => ({
    id: `i${index}`,
    fqName: index === 0 ? "pkg/focus.py::Focus.run" : `pkg/mod${index}.py::Sym${index}.method`,
    path: index === 0 ? "pkg/focus.py" : `pkg/mod${index}.py`,
    lineSpan: { start: index * 10 + 1, end: index * 10 + 9 },
    contentMode: "full",
    roles: index === 0 ? ["pivot"] : ["support"],
    selectionReasons: [index === 0 ? "lead pivot for this task" : "direct caller of pkg/focus.py::Focus.run"],
  }));
  const { productContext: productContextOverride, ...topLevel } = overrides;
  return {
    diagnostics: { freshness: { readiness: { ready: true } } },
    pivotNeighborhood: [],
    ...topLevel,
    // Merged last and separately: spreading `overrides` wholesale would replace
    // the whole productContext with the fragment a caller meant to amend.
    productContext: {
      resolved: true,
      retrievalFound: true,
      deliveryFailed: false,
      leadPivot: "pkg/focus.py::Focus.run",
      items,
      modelVisibleContext: items
        .map((item) => `\n## [${item.id}]\nroles: ${item.roles.join(",")}\n\n${"x".repeat(bodyChars)}`)
        .join("\n"),
      freshness: { status: "fresh", reason: "" },
      ...(productContextOverride as Record<string, unknown> ?? {}),
    },
  };
}

describe("the default disclosure is a projection of the authoritative result", () => {
  test("it names the authoritative lead pivot as the focus", () => {
    const packet = projectRunPipelineOrientation(authoritative(4))!;
    expect(packet.focus.at).toBe("pkg/focus.py::Focus.run");
    expect(packet.schemaVersion).toBe(ORIENTATION_SCHEMA_VERSION);
  });

  test("it is an order of magnitude smaller than the result it projects", () => {
    const state = authoritative(6, {}, 4000);
    const packet = projectRunPipelineOrientation(state)!;
    const authoritativeTokens = Math.round(JSON.stringify(state).length * 0.3174032272551657);
    expect(orientationTokens(packet)).toBeLessThan(authoritativeTokens / 5);
  });

  test("it can surface no source the authoritative result did not carry", () => {
    const state = authoritative(3);
    const rendered = String((state.productContext as Record<string, unknown>).modelVisibleContext);
    const packet = projectRunPipelineOrientation(state)!;
    expect(rendered).toContain(packet.focus.code);
  });

  test("it never re-ranks: related order is the authoritative order", () => {
    const packet = projectRunPipelineOrientation(authoritative(5))!;
    expect(packet.related.map((r) => r.at)).toEqual([
      "pkg/mod1.py::Sym1.method", "pkg/mod2.py::Sym2.method", "pkg/mod3.py::Sym3.method",
      "pkg/mod4.py::Sym4.method", "pkg/mod5.py::Sym5.method",
    ]);
  });

  test("supply beyond five is delivered — there is no count cap", () => {
    expect(projectRunPipelineOrientation(authoritative(9))!.related).toHaveLength(9);
  });

  test("the ceiling bounds the evidence packet when supply is large enough to reach it", () => {
    const packet = projectRunPipelineOrientation(authoritative(300))!;
    expect(packet.related.length).toBeLessThan(300);
    // The ceiling is tested on the evidence packet, before any item states its
    // own cost; the accounting fields ride above it by exactly the amount the
    // ledger reports, and by nothing else.
    const ledger = orientationAccountingOf(packet)!;
    expect(ledger.evidence.tokens).toBeLessThanOrEqual(ORIENTATION_POLICY.ceilingTokens);
    expect(ledger.evidence.withinCeiling).toBe(true);
    expect(orientationTokens(packet)).toBe(ledger.evidence.tokens + ledger.accountingOverhead.tokens);
    // And the overhead is what one integer field per item costs, no more.
    expect(ledger.accountingOverhead.characters)
      .toBe(packet.related.length * ",\"tokens\":".length + ",\"tokens\":".length
        + [packet.focus, ...packet.related].reduce((n, item) => n + String(item.tokens).length, 0));
  });

  test("a packet complete below the ceiling is not padded to reach it", () => {
    // Enough, then stop. Nothing is added because room exists.
    const packet = projectRunPipelineOrientation(authoritative(6))!;
    expect(packet.related).toHaveLength(6);
    expect(orientationTokens(packet)).toBeLessThan(ORIENTATION_POLICY.ceilingTokens);
  });
});

describe("truthfulness", () => {
  test("every resolved packet carries the claim boundary, unconditionally", () => {
    for (const count of [0, 1, 5, 50]) {
      expect(projectRunPipelineOrientation(authoritative(count))!.boundary).toBe(ORIENTATION_BOUNDARY);
    }
  });

  test("the boundary denies exhaustiveness and denies absence", () => {
    expect(ORIENTATION_BOUNDARY).toContain("not an exhaustive repository listing");
    expect(ORIENTATION_BOUNDARY).toContain("Items not shown are not thereby absent");
  });

  test("relationship strings are verbatim authoritative or frozen — never authored", () => {
    const state = authoritative(2, {
      pivotNeighborhood: [{
        excerpts: [
          { fqName: "pkg/n.py::Near", filePath: "pkg/n.py", startLine: 1, endLine: 4, reason: "caller" },
          { fqName: "pkg/n.py::Loose", filePath: "pkg/n.py", startLine: 9, endLine: 12, reason: "fallback_symbol_window" },
        ],
      }],
    });
    const packet = projectRunPipelineOrientation(state)!;
    const authored = new Set(ORIENTATION_FROZEN_PHRASES);
    for (const related of packet.related) {
      const verbatim = related.how === "direct caller of pkg/focus.py::Focus.run";
      expect(verbatim || authored.has(related.how)).toBe(true);
    }
  });

  test("a symbol reached by no edge says exactly that, and is not called related", () => {
    const state = authoritative(0, {
      pivotNeighborhood: [{
        excerpts: [{ fqName: "pkg/focus.py::Other", filePath: "pkg/focus.py", startLine: 20, endLine: 24, reason: "fallback_symbol_window" }],
      }],
    });
    const packet = projectRunPipelineOrientation(state)!;
    expect(packet.related[0]!.how).toBe(NEIGHBOR_RELATION_PHRASES.fallback_symbol_window);
    expect(packet.related[0]!.how).toContain("no indexed relationship to it");
  });

  test("an unmapped relationship token is dropped, never shipped or strengthened", () => {
    // Fails closed: a reason the phrase table does not know carries no claim.
    const state = authoritative(0, {
      pivotNeighborhood: [{
        excerpts: [{ fqName: "pkg/x.py::Unknown", filePath: "pkg/x.py", startLine: 1, endLine: 2, reason: "some_future_edge_kind" }],
      }],
    });
    const packet = projectRunPipelineOrientation(state)!;
    expect(packet.related.map((r) => r.at)).not.toContain("pkg/x.py::Unknown");
  });

  test("a truncated excerpt says so rather than reading as the whole span", () => {
    const packet = projectRunPipelineOrientation(authoritative(1, {}, 50_000))!;
    expect(packet.focus.codeTruncated).toBe(true);
    expect(packet.notes).toContain("The excerpt above is the head of a longer span.");
  });

  test("a non-fresh index is disclosed verbatim, not re-worded", () => {
    const packet = projectRunPipelineOrientation(authoritative(2, {
      productContext: { freshness: { status: "stale", reason: "3 files changed since the last index run" } },
    }))!;
    expect(packet.notes).toContain("Index freshness: stale (3 files changed since the last index run).");
  });
});

describe("failure states are never projected", () => {
  const declines = (overrides: Record<string, unknown>): void => {
    expect(projectRunPipelineOrientation(authoritative(3, overrides))).toBeNull();
  };

  test("an unready repository keeps its full envelope", () => {
    expect(projectRunPipelineOrientation({
      ...authoritative(3),
      diagnostics: { freshness: { readiness: { ready: false, reason: "repo_not_ready" } } },
    })).toBeNull();
  });

  test("an unresolved, empty, or failed delivery keeps its full envelope", () => {
    declines({ productContext: { resolved: false } });
    declines({ productContext: { retrievalFound: false } });
    declines({ productContext: { deliveryFailed: true } });
    declines({ productContext: { items: [] } });
  });

  test("a result with no productContext at all is left alone", () => {
    expect(projectRunPipelineOrientation({ resolved: false, reason: "missing_index" })).toBeNull();
    expect(projectRunPipelineOrientation(null)).toBeNull();
    expect(projectRunPipelineOrientation("not a result")).toBeNull();
  });
});

describe("the projector is pure", () => {
  test("it does not mutate the authoritative result", () => {
    const state = authoritative(8);
    const before = JSON.stringify(state);
    projectRunPipelineOrientation(state);
    expect(JSON.stringify(state)).toBe(before);
  });

  test("it is deterministic", () => {
    const state = authoritative(8);
    const once = JSON.stringify(projectRunPipelineOrientation(state));
    expect(JSON.stringify(projectRunPipelineOrientation(state))).toBe(once);
  });

  test("freeing unrelated internal bytes does not move the orientation", () => {
    const lean = authoritative(6);
    const fat = { ...authoritative(6), someLargeInternalBlock: "y".repeat(200_000) };
    expect(JSON.stringify(projectRunPipelineOrientation(fat)))
      .toBe(JSON.stringify(projectRunPipelineOrientation(lean)));
  });
});

describe("the ceiling is the caller's budget", () => {
  const budgeted = (count: number, requested: number, bodyChars?: number) =>
    authoritative(count, { responseBudget: { requested_context_tokens: requested } }, bodyChars);

  test("one rule: the caller's chars/4 budget stated in the packet's unit", () => {
    for (const requested of [0, 1000, 1575, 3000, 8000, 16000, 123457]) {
      expect(orientationCeilingTokens(requested))
        .toBe(orientationTokensOfCharacters(requested * ORIENTATION_CHARACTERS_PER_REQUESTED_TOKEN));
    }
    // A caller token is four characters; four characters cost 1.27 packet tokens.
    expect(orientationCeilingTokens(16000)).toBe(20314);
    expect(orientationCeilingTokens(1000)).toBe(1270);
  });

  test("the frozen 2000 is the default for a budget the projector cannot see, and nothing else", () => {
    expect(orientationCeilingTokens("unavailable")).toBe(ORIENTATION_POLICY.ceilingTokens);
    expect(orientationCeilingTokens("not_applicable")).toBe(ORIENTATION_POLICY.ceilingTokens);
    expect(orientationCeilingTokens(Number.NaN)).toBe(ORIENTATION_POLICY.ceilingTokens);
    expect(orientationCeilingTokens(-1)).toBe(ORIENTATION_POLICY.ceilingTokens);
    // 1575 is the budget whose ceiling happens to equal the default; 1576 is not.
    expect(orientationCeilingTokens(1575)).toBe(ORIENTATION_POLICY.ceilingTokens);
    expect(orientationCeilingTokens(1576)).not.toBe(ORIENTATION_POLICY.ceilingTokens);
  });

  test("the ceiling is monotonic in the budget", () => {
    let previous = -1;
    for (const requested of [0, 1, 10, 100, 1000, 1575, 2000, 4000, 8000, 16000, 64000]) {
      const ceiling = orientationCeilingTokens(requested);
      expect(ceiling).toBeGreaterThanOrEqual(previous);
      previous = ceiling;
    }
  });

  test("a larger budget admits more of the SAME ranked supply, as a prefix, and acquires nothing", () => {
    const small = projectRunPipelineOrientation(budgeted(300, 1000))!;
    const large = projectRunPipelineOrientation(budgeted(300, 16000))!;
    expect(small.related.length).toBeLessThan(large.related.length);
    expect(large.related.length).toBeLessThanOrEqual(300);
    expect(large.related.map((r) => r.at).slice(0, small.related.length)).toEqual(small.related.map((r) => r.at));
    expect(small.focus.at).toBe(large.focus.at);
    const ledger = orientationAccountingOf(large)!;
    expect(ledger.ceilingTokens).toBe(orientationCeilingTokens(16000));
    expect(ledger.ceilingDerivation).toEqual({
      source: "requested_context_tokens", requestedContextTokens: 16000,
      charactersPerRequestedToken: ORIENTATION_CHARACTERS_PER_REQUESTED_TOKEN,
      defaultCeilingTokens: ORIENTATION_POLICY.ceilingTokens,
    });
    expect(ledger.evidence.tokens).toBeLessThanOrEqual(ledger.ceilingTokens);
  });

  test("the fixed default would have stopped the same supply at 2000 packet tokens", () => {
    // The pre-M204 policy, reproduced: no visible budget falls back to the default.
    const state = authoritative(300);
    delete (state as Record<string, unknown>).responseBudget;
    const packet = projectRunPipelineOrientation(state)!;
    const ledger = orientationAccountingOf(packet)!;
    expect(ledger.ceilingDerivation.source).toBe("policy_default");
    expect(ledger.ceilingTokens).toBe(ORIENTATION_POLICY.ceilingTokens);
    expect(ledger.candidates.rejectedForCeiling).toBe(1);
    const budgetedPacket = projectRunPipelineOrientation(budgeted(300, 16000))!;
    expect(budgetedPacket.related.length).toBeGreaterThan(packet.related.length);
  });

  test("a packet complete below the ceiling is identical at every budget: nothing is added because room exists", () => {
    const at = (requested: number) => JSON.stringify(projectRunPipelineOrientation(budgeted(6, requested)));
    expect(at(2000)).toBe(at(16000));
    expect(at(16000)).toBe(at(1_000_000));
    expect(projectRunPipelineOrientation(budgeted(6, 1_000_000))!.related).toHaveLength(6);
  });

  test("the same effective ceiling gives the byte-identical packet", () => {
    const state = authoritative(300);
    delete (state as Record<string, unknown>).responseBudget;
    expect(JSON.stringify(projectRunPipelineOrientation(budgeted(300, 1575))))
      .toBe(JSON.stringify(projectRunPipelineOrientation(state)));
  });

  test("the focus is never evicted by the ceiling, and its head bound does not move with the budget", () => {
    const tiny = projectRunPipelineOrientation(budgeted(4, 0, 300))!;
    expect(tiny.focus.at).toBe("pkg/focus.py::Focus.run");
    expect(tiny.related).toHaveLength(0);
    const big = projectRunPipelineOrientation(budgeted(1, 1_000_000, 50_000))!;
    expect(big.focus.code!.length).toBeLessThanOrEqual(ORIENTATION_POLICY.focusCodeCharacters);
    expect(big.focus.codeTruncated).toBe(true);
  });

  test("the budget the ceiling was derived from is the one the ledger reports upstream", () => {
    const ledger = orientationAccountingOf(projectRunPipelineOrientation(budgeted(3, 4000))!)!;
    expect(ledger.ceilingDerivation.requestedContextTokens).toBe(ledger.evidenceBudget.requestedTokens);
  });
});
