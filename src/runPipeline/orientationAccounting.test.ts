/**
 * The per-item accounting contract.
 *
 * What these tests hold the ledger to: it describes the packet that was
 * delivered (not one that was estimated), every delivered item is in it exactly
 * once, its identities are deterministic, its costs are measurements of the
 * serialization the model receives, absent facts are stated as absent rather
 * than as zero, and none of it moved a single item.
 */

import { describe, expect, test } from "bun:test";

import {
  ORIENTATION_TOKENS_PER_CHARACTER,
  orientationAccountingOf,
  orientationTokensOfCharacters,
  tokenDeviationBound,
  withItemTokens,
} from "./orientationAccounting";
import {
  ORIENTATION_POLICY,
  orientationTokens,
  projectRunPipelineOrientation,
} from "./orientationProjection";

type Record_ = Record<string, unknown>;

function authoritative(count: number, overrides: Record_ = {}, bodyChars = 300): Record_ {
  const items = Array.from({ length: count + 1 }, (_, index) => ({
    id: `i${index}`,
    fqName: index === 0 ? "pkg/focus.py::Focus.run" : `pkg/mod${index}.py::Sym${index}.method`,
    path: index === 0 ? "pkg/focus.py" : `pkg/mod${index}.py`,
    lineSpan: { start: index * 10 + 1, end: index * 10 + 9 },
    contentMode: "focused_source",
    roles: index === 0 ? ["pivot"] : ["support"],
    selectionReasons: [index === 0 ? "lead pivot for this task" : `direct caller ${index}`],
    estimatedTokens: 75 + index,
  }));
  const { productContext: productContextOverride, ...topLevel } = overrides;
  return {
    diagnostics: { freshness: { readiness: { ready: true } } },
    pivotNeighborhood: [],
    responseBudget: { requested_context_tokens: 8000 },
    ...topLevel,
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
      delivery: { status: "complete", selectedItemsBeforeBudget: count + 1, deliveredItems: count + 1,
        droppedForBudget: 0, finalModelTokens: 900, compactionStages: [] },
      accounting: { budgetTokens: 8000, usedTokensEstimate: 900, remainingTokensEstimate: 7100 },
      ...(productContextOverride as Record_ ?? {}),
    },
  };
}

const serializedTokens = (item: object) => orientationTokensOfCharacters(JSON.stringify(item).length);

describe("the model-facing tokens field", () => {
  test("states the item's cost with itself included, as a fixed point", () => {
    const item = withItemTokens({ at: "a::b", file: "a", lines: "1-2", how: "x".repeat(50) });
    expect(item.tokens).toBe(serializedTokens(item));
  });

  test("converges across a digit-count boundary", () => {
    // Find a body length whose cost without the field sits just under 100 and
    // whose field pushes the count into three digits; the stated value must
    // still equal the measured cost of the final serialization.
    for (let n = 280; n < 340; n += 1) {
      const item = withItemTokens({ body: "y".repeat(n) });
      expect(item.tokens).toBe(serializedTokens(item));
    }
  });

  test("is the same authority the ceiling uses", () => {
    expect(orientationTokensOfCharacters(1000)).toBe(Math.round(1000 * ORIENTATION_TOKENS_PER_CHARACTER));
    const packet = projectRunPipelineOrientation(authoritative(3))!;
    expect(orientationTokens(packet)).toBe(orientationTokensOfCharacters(JSON.stringify(packet).length));
  });
});

describe("coverage and identity", () => {
  test("every delivered item is accounted exactly once, in delivered order", () => {
    const packet = projectRunPipelineOrientation(authoritative(6))!;
    const ledger = orientationAccountingOf(packet)!;
    const delivered = [packet.focus, ...packet.related];
    expect(ledger.items).toHaveLength(delivered.length);
    expect(ledger.items.map((i) => i.at)).toEqual(delivered.map((i) => i.at));
    expect(ledger.items.map((i) => i.ordinal)).toEqual(delivered.map((_, i) => i));
    expect(new Set(ledger.items.map((i) => i.at)).size).toBe(delivered.length);
    expect(ledger.items[0]!.slot).toBe("focus");
    expect(ledger.items.slice(1).every((i) => i.slot === "related")).toBe(true);
  });

  test("every item's stated tokens is a measurement of its own serialization", () => {
    const packet = projectRunPipelineOrientation(authoritative(6))!;
    const ledger = orientationAccountingOf(packet)!;
    for (const [index, item] of [packet.focus, ...packet.related].entries()) {
      expect(item.tokens).toBe(serializedTokens(item));
      expect(ledger.items[index]!.actualTokens).toBe(item.tokens);
      expect(ledger.items[index]!.characters).toBe(JSON.stringify(item).length);
    }
  });

  test("identity is deterministic: two projections of one state produce one ledger", () => {
    const a = orientationAccountingOf(projectRunPipelineOrientation(authoritative(8))!)!;
    const b = orientationAccountingOf(projectRunPipelineOrientation(authoritative(8))!)!;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toMatch(/"(timestamp|uuid|time)"/);
  });

  test("an item proposed by two routes is delivered once and accounted once, with both origins", () => {
    const state = authoritative(3, {
      pivotNeighborhood: [{
        pivot: { fqName: "pkg/focus.py::Focus.run" },
        excerpts: [
          // Also proposed by the item supply above: deduplicated.
          { fqName: "pkg/mod1.py::Sym1.method", filePath: "pkg/mod1.py", startLine: 11, endLine: 19,
            reason: "caller", textCharacters: 120 },
          // Only proposed here: admitted via the neighbourhood.
          { fqName: "pkg/n.py::only_here", filePath: "pkg/n.py", startLine: 1, endLine: 5,
            reason: "callee", textCharacters: 80 },
        ],
      }],
    });
    const packet = projectRunPipelineOrientation(state)!;
    const ledger = orientationAccountingOf(packet)!;
    const dup = ledger.items.find((i) => i.at === "pkg/mod1.py::Sym1.method")!;
    expect(packet.related.filter((r) => r.at === "pkg/mod1.py::Sym1.method")).toHaveLength(1);
    expect(dup.origin).toBe("item_supply");
    expect(dup.origins).toEqual(["item_supply", "pivot_neighborhood"]);
    expect(dup.reasonSource).toBe("selection_reason");
    const only = ledger.items.find((i) => i.at === "pkg/n.py::only_here")!;
    expect(only.origin).toBe("pivot_neighborhood");
    expect(only.reasonSource).toBe("neighbor_relation");
    expect(only.sourceId).toBe("not_applicable");
    expect(only.upstreamEstimatedTokens).toBe("not_applicable");
    expect(only.bodyCharacters).toBe(80);
    expect(ledger.candidates.deduplicated).toBe(1);
    expect(ledger.candidates.proposed).toBe(ledger.candidates.admitted + ledger.candidates.deduplicated
      + ledger.candidates.droppedNoClaim + ledger.candidates.rejectedForCeiling + ledger.candidates.notReached);
  });

  test("a proposal with no renderable claim is counted as dropped, and nothing after a ceiling break is reached", () => {
    const state = authoritative(300, {
      pivotNeighborhood: [{ pivot: {}, excerpts: [
        { fqName: "pkg/u.py::unknown_relation", filePath: "pkg/u.py", startLine: 1, endLine: 2, reason: "made_up_token" },
      ] }],
    });
    const packet = projectRunPipelineOrientation(state)!;
    const c = orientationAccountingOf(packet)!.candidates;
    expect(packet.related.some((r) => r.at === "pkg/u.py::unknown_relation")).toBe(false);
    expect(c.droppedNoClaim).toBe(1);
    expect(c.rejectedForCeiling).toBe(1);
    expect(c.notReached).toBe(300 - packet.related.length - 1);
    expect(c.proposed).toBe(c.admitted + c.deduplicated + c.droppedNoClaim + c.rejectedForCeiling + c.notReached);
  });
});

describe("estimated versus actual", () => {
  test("the admission-time figure is kept beside the delivered one, and is smaller", () => {
    const ledger = orientationAccountingOf(projectRunPipelineOrientation(authoritative(4))!)!;
    for (const item of ledger.items) {
      expect(item.estimatedTokens).toBeLessThan(item.actualTokens);
      expect(item.admissionPacketTokens).toBeLessThanOrEqual(ORIENTATION_POLICY.ceilingTokens);
    }
    // The packet the ceiling was tested on is the one recorded as evidence.
    expect(ledger.items.at(-1)!.admissionPacketTokens).toBe(ledger.evidence.tokens);
  });

  test("the upstream evidence-budget estimate is carried verbatim in its own units", () => {
    const ledger = orientationAccountingOf(projectRunPipelineOrientation(authoritative(2))!)!;
    expect(ledger.items[0]!.upstreamEstimatedTokens).toBe(75);
    expect(ledger.items[1]!.upstreamEstimatedTokens).toBe(76);
    expect(ledger.evidenceBudget).toEqual({
      method: "characters_div_4", requestedTokens: 8000, modelVisibleTokens: 900, remainingTokens: 7100,
      deliveryStatus: "complete", selectedItemsBeforeBudget: 3, deliveredItems: 3, droppedForBudget: 0,
      compactionStages: [],
    });
  });

  test("a fact the projector cannot see is unavailable, never zero", () => {
    const state = authoritative(1);
    const product = state.productContext as Record_;
    delete product.delivery;
    delete product.accounting;
    delete state.responseBudget;
    for (const item of product.items as Record_[]) delete item.estimatedTokens;
    const ledger = orientationAccountingOf(projectRunPipelineOrientation(state)!)!;
    expect(ledger.evidenceBudget.requestedTokens).toBe("unavailable");
    expect(ledger.evidenceBudget.modelVisibleTokens).toBe("unavailable");
    expect(ledger.evidenceBudget.deliveryStatus).toBe("unavailable");
    expect(ledger.items[0]!.upstreamEstimatedTokens).toBe("unavailable");
  });
});

describe("representation truth", () => {
  test("a truncated focus is accounted at its delivered size, with the body size beside it", () => {
    const packet = projectRunPipelineOrientation(authoritative(1, {}, 5000))!;
    const ledger = orientationAccountingOf(packet)!;
    const focus = ledger.items[0]!;
    expect(packet.focus.codeTruncated).toBe(true);
    expect(focus.truncated).toBe(true);
    expect(focus.bodyCharacters).toBe(5000);
    expect(focus.deliveredCodeCharacters).toBe(packet.focus.code!.length);
    expect(focus.deliveredCodeCharacters).toBeLessThanOrEqual(ORIENTATION_POLICY.focusCodeCharacters);
    expect(focus.actualTokens).toBe(serializedTokens(packet.focus));
    expect(focus.representation).toBe("focused_source");
  });

  test("a related entry that carries its upstream body is accounted at the code it delivers", () => {
    // M205: a code-bearing upstream form is delivered when the ceiling allows.
    const packet = projectRunPipelineOrientation(authoritative(2))!;
    const ledger = orientationAccountingOf(packet)!;
    const related = ledger.items[1]!;
    expect(packet.related[0]!.code).toBe("x".repeat(300));
    expect(related.representation).toBe("focused_source");
    expect(related.representationReason).toBe("upstream_form_delivered");
    expect(related.codeDelivered).toBe(true);
    expect(related.deliveredCodeCharacters).toBe(300);
    expect(related.bodyCharacters).toBe(300);
    expect(related.actualTokens).toBe(serializedTokens(packet.related[0]!));
  });

  test("a related entry whose body is not source delivers no code and says so", () => {
    const state = authoritative(2);
    const items = (state.productContext as Record_).items as Record_[];
    items[1]!.contentMode = "summary";
    const packet = projectRunPipelineOrientation(state)!;
    const ledger = orientationAccountingOf(packet)!;
    const related = ledger.items[1]!;
    expect("code" in packet.related[0]!).toBe(false);
    expect(related.representation).toBe("relationship_only");
    expect(related.representationReason).toBe("form_not_code_bearing");
    expect(related.codeDelivered).toBe(false);
    expect(related.deliveredCodeCharacters).toBe(0);
    expect(related.bodyCharacters).toBe(300);
  });
});

describe("reconciliation", () => {
  test("items plus wrapper equals the packet, exactly, in characters", () => {
    const packet = projectRunPipelineOrientation(authoritative(7))!;
    const ledger = orientationAccountingOf(packet)!;
    const items = [packet.focus, ...packet.related].reduce((n, i) => n + JSON.stringify(i).length, 0);
    expect(ledger.reconciliation.itemCharacters).toBe(items);
    expect(ledger.reconciliation.itemCharacters + ledger.reconciliation.wrapperCharacters)
      .toBe(JSON.stringify(packet).length);
    expect(ledger.reconciliation.charactersExact).toBe(true);
    expect(ledger.items.at(-1)!.cumulativeCharacters).toBe(items);
  });

  test("tokens reconcile within the stated rounding bound", () => {
    const ledger = orientationAccountingOf(projectRunPipelineOrientation(authoritative(9))!)!;
    expect(ledger.reconciliation.tokenDeviation).toBeLessThanOrEqual(ledger.reconciliation.tokenDeviationBound);
    expect(ledger.reconciliation.tokenDeviationBound).toBe(tokenDeviationBound(ledger.items.length + 2));
  });

  test("the accounting overhead is the packet minus the evidence packet, and is charged", () => {
    const packet = projectRunPipelineOrientation(authoritative(5))!;
    const ledger = orientationAccountingOf(packet)!;
    expect(ledger.packet.tokens).toBe(orientationTokens(packet));
    expect(ledger.packet.tokens - ledger.evidence.tokens).toBe(ledger.accountingOverhead.tokens);
    expect(ledger.accountingOverhead.characters).toBeGreaterThan(0);
  });

  test("a budget-exhausted packet reconciles exactly and records what the ceiling rejected", () => {
    const packet = projectRunPipelineOrientation(authoritative(300))!;
    const ledger = orientationAccountingOf(packet)!;
    expect(ledger.candidates.rejectedForCeiling).toBe(1);
    expect(ledger.candidates.rejected[0]!.admissionPacketTokens).toBeGreaterThan(ORIENTATION_POLICY.ceilingTokens);
    expect(ledger.candidates.rejected[0]!.proposedOrdinal).toBe(packet.related.length + 1);
    expect(ledger.evidence.withinCeiling).toBe(true);
    expect(ledger.reconciliation.charactersExact).toBe(true);
    expect(ledger.items).toHaveLength(1 + packet.related.length);
  });
});

describe("accounting never decides", () => {
  test("adding accounting moved no item and changed no order", () => {
    const state = authoritative(12, {
      pivotNeighborhood: [{ pivot: {}, excerpts: [
        { fqName: "pkg/z.py::z", filePath: "pkg/z.py", startLine: 1, endLine: 2, reason: "sibling" },
      ] }],
    });
    const packet = projectRunPipelineOrientation(state)!;
    // Strip the one model-facing accounting field and the packet is the
    // pre-accounting packet: same focus, same related, same order, same framing.
    const strip = ({ tokens: _t, ...rest }: { tokens: number }) => rest;
    const stripped = { ...packet, focus: strip(packet.focus), related: packet.related.map(strip) };
    expect(stripped.related.map((r) => r.at)).toEqual(
      [...Array.from({ length: 12 }, (_, i) => `pkg/mod${i + 1}.py::Sym${i + 1}.method`), "pkg/z.py::z"]);
    expect(JSON.stringify(stripped).length).toBe(orientationAccountingOf(packet)!.evidence.characters);
  });

  test("a projection that declines publishes no ledger", () => {
    const declined = projectRunPipelineOrientation(authoritative(2, { productContext: { resolved: false } }));
    expect(declined).toBeNull();
    expect(orientationAccountingOf({})).toBeUndefined();
  });
});
