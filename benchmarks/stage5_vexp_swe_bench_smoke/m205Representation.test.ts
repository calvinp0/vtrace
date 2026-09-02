/**
 * The representation analyzer is only trustworthy if it reproduces the frozen
 * A12 rule byte for byte and refuses the ways a class count could be faked.
 */
import { describe, expect, test } from "bun:test";

import { orientationAccountingOf } from "../../src/runPipeline/orientationAccounting";
import { ORIENTATION_POLICY, orientationCeilingTokens, projectRunPipelineOrientation } from "../../src/runPipeline/orientationProjection";
import {
  analyzeRepresentation, classDistinction, deliveredClass, frozenA12Classes, frozenA12Verdict, sourceTruthOf,
  type SourceAuthority, type SupplyItem,
} from "./m205Representation";

/** A synthetic corpus: one file per related item, its body at the item's span. */
function corpus(forms: readonly string[], requested: number) {
  const bodies = forms.map((form, k) => form === "signature" ? `def method_${k + 1}(a, b):` : form === "skeleton"
    ? `def method_${k + 1}(a, b):\n# docstring ${k + 1}`
    : `def method_${k + 1}(a, b):\n    total = a + b\n    return total * ${k + 1}`);
  const items = Array.from({ length: forms.length + 1 }, (_, index) => ({
    id: `i${index}`,
    fqName: index === 0 ? "pkg/focus.py::Focus.run" : `pkg/mod${index}.py::Sym${index}.method`,
    path: index === 0 ? "pkg/focus.py" : `pkg/mod${index}.py`,
    lineSpan: { start: index * 10 + 1, end: index * 10 + 9 },
    contentMode: index === 0 ? "focused_source" : forms[index - 1]!,
    roles: index === 0 ? ["pivot"] : ["support"],
    selectionReasons: [index === 0 ? "lead pivot for this task" : `direct caller ${index}`],
    estimatedTokens: 75 + index,
  }));
  const bodyOf = (index: number) => (index === 0 ? "def run(self):\n    return 1" : bodies[index - 1]!);
  const files = new Map<string, string>();
  for (const [index, item] of items.entries()) {
    const lines = Array.from({ length: index * 10 + 12 }, (_, l) => `# filler ${l + 1}`);
    const body = index === 0 ? bodyOf(0) : (forms[index - 1] === "signature" || forms[index - 1] === "skeleton"
      ? `def method_${index}(a, b):\n    total = a + b\n    return total * ${index}` : bodyOf(index));
    lines.splice(index * 10, body.split("\n").length, ...body.split("\n"));
    files.set(item.path, lines.join("\n"));
  }
  const state = {
    diagnostics: { freshness: { readiness: { ready: true } } },
    pivotNeighborhood: [],
    responseBudget: { requested_context_tokens: requested },
    productContext: {
      resolved: true, retrievalFound: true, deliveryFailed: false, leadPivot: "pkg/focus.py::Focus.run", items,
      modelVisibleContext: items.map((item, k) => `\n## [${item.id}]\nroles: ${item.roles.join(",")}\nmode: ${item.contentMode}\n\n${bodyOf(k)}`).join("\n"),
      freshness: { status: "fresh", reason: "" },
      delivery: { status: "complete", selectedItemsBeforeBudget: items.length, deliveredItems: items.length, droppedForBudget: 0, finalModelTokens: 900, compactionStages: [] },
      accounting: { budgetTokens: requested, usedTokensEstimate: 900, remainingTokensEstimate: requested - 900 },
    },
  };
  const supply: SupplyItem[] = items.map((item, k) => ({ id: item.id, fqName: item.fqName, path: item.path, contentMode: item.contentMode, content: bodyOf(k), lineSpan: item.lineSpan }));
  const authority: SourceAuthority = {
    readFile: (p) => files.get(p) ?? null,
    symbol: (fqName) => {
      const k = items.findIndex((i) => i.fqName === fqName);
      return k < 0 ? null : { signature: `def method_${k}(a, b):`, startLine: k * 10 + 1, endLine: k * 10 + 9, kind: "function", localName: `method_${k}` };
    },
    skeleton: (_p, fqName) => { const k = items.findIndex((i) => i.fqName === fqName); return k < 0 ? null : `def method_${k}(a, b):\n# docstring ${k}`; },
  };
  return { state, supply, authority };
}

const project = (state: Record<string, unknown>) => {
  const packet: any = projectRunPipelineOrientation(state);
  return { packet, ledger: orientationAccountingOf(packet) as any };
};
const analyze = (budget: number, packet: any, ledger: any, supply: SupplyItem[] | null, authority: SourceAuthority | null) =>
  analyzeRepresentation({ packet, ledger, ceilingTokens: orientationCeilingTokens(budget), relatedBound: ORIENTATION_POLICY.relatedCodeCharacters,
    focusBound: ORIENTATION_POLICY.focusCodeCharacters, supply, authority });
const failed = (a: { gates: readonly { id: string; pass: boolean }[] }) => a.gates.filter((g) => !g.pass).map((g) => g.id);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("the frozen A12 rule, verbatim", () => {
  test("classes are the focus form, related-with-code and relationship-only; MATCH at 3, EXCEED at 5", () => {
    expect(frozenA12Classes({ focus: { form: "focused_source", code: "x" }, related: [{ code: "y" }, {}] }))
      .toEqual(["FOCUS:focused_source", "RELATED_WITH_CODE", "RELATIONSHIP_ONLY"]);
    expect(frozenA12Classes({ focus: { form: "signature", code: null }, related: [{}] })).toEqual(["RELATIONSHIP_ONLY"]);
    expect(frozenA12Verdict(2)).toBe("VTRACE_BELOW_VEXP_CLAIM");
    expect(frozenA12Verdict(3)).toBe("VTRACE_MATCHES_VEXP_CLAIM");
    expect(frozenA12Verdict(5)).toBe("VTRACE_EXCEEDS_VEXP_CLAIM");
  });

  test("a form label without code does not count: the frozen rule reads code, not labels", () => {
    expect(frozenA12Classes({ focus: { form: "focused_source", code: "x" }, related: [{ form: "skeleton" }, { form: "signature" }] }))
      .toEqual(["FOCUS:focused_source", "RELATIONSHIP_ONLY"]);
    expect(deliveredClass({ form: "skeleton" }, "related")).toBe("relationship_only");
  });
});

describe("the analyzer holds a rich packet to its sources", () => {
  test("a production packet with three code-bearing forms passes every gate", () => {
    const { state, supply, authority } = corpus(["focused_source", "skeleton", "signature", "summary"], 16000);
    const { packet, ledger } = project(state);
    const a = analyze(16000, packet, ledger, supply, authority);
    expect(a.verdict).toBe("REPRESENTATION_INTEGRITY_PASS");
    expect(a.frozenClasses).toEqual(["FOCUS:focused_source", "RELATED_WITH_CODE", "RELATIONSHIP_ONLY"]);
    expect(a.items.slice(1).map((i) => i.sourceTruth)).toEqual(["ANCHORED_IN_SPAN", "SKELETON_MATCHES_INDEX", "PARSER_SIGNATURE", "NOT_APPLICABLE"]);
    expect(a.items.slice(1).map((i) => i.reason)).toEqual(["upstream_form_delivered", "upstream_form_delivered", "upstream_form_delivered", "form_not_code_bearing"]);
  });

  test("an invented excerpt fails source truth", () => {
    const { state, supply, authority } = corpus(["focused_source"], 16000);
    const { packet, ledger } = project(state);
    const forged = clone(packet); forged.related[0].code = "def stolen():\n    pass";
    const a = analyze(16000, forged, ledger, supply, authority);
    expect(a.verdict).toBe("REPRESENTATION_INTEGRITY_FAIL");
    expect(a.items[1]!.sourceTruth).toBe("NOT_LOCATED");
  });

  test("a wrong signature fails against the parser authority", () => {
    const { state, supply, authority } = corpus(["signature"], 16000);
    const { packet, ledger } = project(state);
    const forged = clone(packet); forged.related[0].code = "def method_1(a):";
    const a = analyze(16000, forged, ledger, supply, authority);
    expect(a.items[1]!.sourceTruth).toBe("SIGNATURE_NOT_PARSER");
    expect(a.verdict).toBe("REPRESENTATION_INTEGRITY_FAIL");
  });

  test("relabelling a skeleton as a signature fails: same bytes, wrong authority", () => {
    const { state, supply, authority } = corpus(["skeleton"], 16000);
    const { packet, ledger } = project(state);
    const relabelled = clone(packet); relabelled.related[0].form = "signature";
    const relabelledLedger = clone(ledger); relabelledLedger.items[1].representation = "signature"; relabelledLedger.items[1].availableRepresentation = "signature";
    const a = analyze(16000, relabelled, relabelledLedger, supply, authority);
    expect(a.items[1]!.sourceTruth).toBe("SIGNATURE_NOT_PARSER");
    expect(a.verdict).toBe("REPRESENTATION_INTEGRITY_FAIL");
  });

  test("an oversized code fails the bound; a stale compact cost fails accounting", () => {
    const { state, supply, authority } = corpus(["focused_source"], 16000);
    const { packet, ledger } = project(state);
    const big = clone(packet); big.related[0].code = "y".repeat(ORIENTATION_POLICY.relatedCodeCharacters + 1);
    expect(failed(analyze(16000, big, ledger, supply, authority))).toContain("every_item_passes");
    expect(analyze(16000, big, ledger, supply, authority).items[1]!.gates.find((g) => g.id === "bound_respected")!.pass).toBe(false);
    const stale = clone(ledger); stale.items[1].actualTokens = 40; stale.items[1].characters = 120;
    expect(failed(analyze(16000, packet, stale, supply, authority))).toContain("m203_accounting");
  });

  test("a code under a non-source form, or a ledger class that is not the packet's, is refused", () => {
    const { state, supply, authority } = corpus(["summary"], 16000);
    const { packet, ledger } = project(state);
    const forced = clone(packet); forced.related[0].form = "summary"; forced.related[0].code = "CALLS x"; forced.related[0].codeTruncated = false;
    const a = analyze(16000, forced, ledger, supply, authority);
    expect(a.items[1]!.gates.find((g) => g.id === "form_is_code_bearing")!.pass).toBe(false);
    const hardcoded = clone(ledger); hardcoded.items[1].representation = "signature";
    expect(analyze(16000, packet, hardcoded, supply, authority).items[1]!.gates.find((g) => g.id === "class_is_ledger_class")!.pass).toBe(false);
  });

  test("a duplicated identity, however represented, is refused", () => {
    const { state, supply, authority } = corpus(["focused_source", "skeleton"], 16000);
    const { packet, ledger } = project(state);
    const dup = clone(packet); dup.related.push({ ...clone(dup.related[0]), form: undefined, code: undefined, codeTruncated: undefined });
    const dupLedger = clone(ledger); dupLedger.items.push({ ...clone(dupLedger.items[1]), ordinal: 3, representation: "relationship_only" });
    expect(failed(analyze(16000, dup, dupLedger, supply, authority))).toContain("no_duplicate_identity");
  });
});

describe("source truth tiers and class distinction", () => {
  test("in span, in file, line-wise, or nowhere", () => {
    const file = "a\nb\ndef f():\n    return 1\nz\n";
    expect(sourceTruthOf({ form: "focused_source", code: "def f():\n    return 1", file, lines: "3-4" })).toBe("ANCHORED_IN_SPAN");
    expect(sourceTruthOf({ form: "focused_source", code: "def f():\n    return 1", file, lines: "1-2" })).toBe("ANCHORED_IN_FILE");
    expect(sourceTruthOf({ form: "excerpt", code: "def f():\n\n\n    return 1\n# … excerpt compacted for budget …", file, lines: "3-4" })).toBe("LINEWISE_VERBATIM");
    expect(sourceTruthOf({ form: "focused_source", code: "def g():", file, lines: "3-4" })).toBe("NOT_LOCATED");
  });

  test("two classes that never differ on any item are a collapse; classes that differ somewhere are distinct", () => {
    expect(classDistinction([{ a: "skeleton", b: "signature", textA: "def f():", textB: "def f():" }]).pass).toBe(false);
    expect(classDistinction([
      { a: "skeleton", b: "signature", textA: "def f():", textB: "def f():" },
      { a: "skeleton", b: "signature", textA: "class A:\n  def m()", textB: "class A:" },
    ]).pass).toBe(true);
  });
});
