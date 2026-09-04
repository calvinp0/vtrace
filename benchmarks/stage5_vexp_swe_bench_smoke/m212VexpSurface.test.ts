import { describe, expect, it } from "bun:test";

import {
  classifyProjection, extractVexpToolSurface, recallOf, rendererCanCarrySource, representationOf,
} from "./m212VexpSurface";

/**
 * A miniature bundle shaped like the real ones: minified `$`-bearing identifiers,
 * a two-arm tool list behind an env gate, and an impact renderer built from
 * template literals. The nesting matters — an extractor that brace-matches
 * naively returns an empty field set here, and an empty field set is exactly the
 * finding the extractor exists to make, so the fixture keeps that failure mode
 * observable.
 */
const BUNDLE = [
  'var A$={name:"run_pipeline",description:"orientation"};',
  'var B$={name:"get_impact_graph",description:"blast radius"};',
  'var C$={name:"expand_vexp_ref",description:"Expand a [V-REF:xxxx] placeholder"};',
  'var yF=[A$,B$,C$];var _F=[A$];',
  'function wF(){let t=process.env.VEXP_ALL_TOOLS;return t==="1"}',
  'e.setRequestHandler(Mp,()=>({tools:wF()?yF:_F.map(f4)}));',
  'function YL(t,e){let r=[];r.push(`# Impact Graph: \\`${t.root_fqn}\\``);',
  'for(let n of t.nodes){let i=n.repo?`[${n.repo}] `:"";',
  'r.push(`- ${i}${n.fqn} — \\`${n.edge_type}\\` (depth ${n.depth})`);',
  'r.push(`  ${n.file_path}`)}}',
  'var QL=S.object({start:S.string()});',
].join("");

describe("extractVexpToolSurface", () => {
  const surface = extractVexpToolSurface(BUNDLE, "9.9.9");

  it("separates the default catalog from the env-gated remainder", () => {
    expect(surface.defaultListed).toEqual(["run_pipeline"]);
    expect(surface.gatedOutOfDefault).toEqual(["expand_vexp_ref", "get_impact_graph"]);
    expect(surface.allToolsEnvVar).toBe("VEXP_ALL_TOOLS");
  });

  it("reads the impact renderer's node fields through nested template holes", () => {
    expect(surface.impactNodeFields).toContain("file_path");
    expect(surface.impactNodeFields).toContain("edge_type");
    expect(surface.impactNodeFields).toContain("fqn");
  });

  it("attributes V-REF to the tool whose own description carries it", () => {
    expect(surface.vrefMentioningTools).toEqual(["expand_vexp_ref"]);
    // Control F1: the expander existing is not evidence that impact output uses it.
    expect(surface.vrefMentioningTools).not.toContain("get_impact_graph");
  });

  it("reports an unlocatable renderer as unknown rather than as sourceless", () => {
    const blind = extractVexpToolSurface("var x=1;", null);
    expect(blind.impactNodeFields).toBeNull();
    expect(rendererCanCarrySource(blind.impactNodeFields)).toBe(false);
  });
});

describe("rendererCanCarrySource", () => {
  it("is false for a renderer emitting only names and paths", () => {
    expect(rendererCanCarrySource(["fqn", "edge_type", "depth", "file_path", "repo"])).toBe(false);
  });
  it("is true once any source-bearing field appears", () => {
    expect(rendererCanCarrySource(["fqn", "sourceText"])).toBe(true);
    expect(rendererCanCarrySource(["fqn", "start_line"])).toBe(true);
  });
});

describe("representationOf", () => {
  const rendered = { source: { symbol: "a.ts::caller" }, evidence: { sourceText: "return target(1)", referenceName: "target" } };
  const bare = { source: { symbol: "a.ts::caller" }, evidence: { referenceName: "target" } };

  it("separates inline-with-source from inline-without-source", () => {
    expect(representationOf("a.ts::caller", [rendered], true)).toBe("INLINE_WITH_SOURCE");
    expect(representationOf("a.ts::caller", [bare], true)).toBe("INLINE_WITHOUT_SOURCE");
  });

  it("separates a counted caller from an uncounted one", () => {
    expect(representationOf("a.ts::other", [rendered], true)).toBe("CENSUS_ONLY");
    expect(representationOf("a.ts::other", [rendered], false)).toBe("ABSENT");
  });

  it("matches on exact caller identity, never on the file (control F7)", () => {
    const sibling = { source: { symbol: "a.ts::sibling" }, evidence: { sourceText: "return target(2)", referenceName: "target" } };
    expect(representationOf("a.ts::caller", [sibling], true)).toBe("CENSUS_ONLY");
  });
});

describe("recallOf", () => {
  it("reports inline and reachable separately", () => {
    expect(recallOf(2, 10, 10)).toEqual({ inlineRecall: 20, reachableRecall: 100 });
  });
  it("is NaN rather than 100 when nothing was known", () => {
    expect(recallOf(0, 0, 0).inlineRecall).toBeNaN();
  });
});

describe("classifyProjection", () => {
  const base = { indexedCallers: 500, deliveredRelations: 2, censusTotal: 525, hasDeterministicContinuation: false, hasExpandableReferences: false };

  it("calls a fully enumerated response what it is", () => {
    expect(classifyProjection({ ...base, indexedCallers: 3, deliveredRelations: 3 })).toBe("FULL_INLINE_ENUMERATION");
  });

  it("does not let a truthful count stand in for delivery (control F5)", () => {
    expect(classifyProjection(base)).toBe("BOUNDED_INLINE_WITH_COMPLETE_CENSUS");
  });

  it("distinguishes continuation from expandable references", () => {
    expect(classifyProjection({ ...base, hasDeterministicContinuation: true })).toBe("BOUNDED_INLINE_WITH_OTHER_EXPANSION");
    expect(classifyProjection({ ...base, hasExpandableReferences: true })).toBe("BOUNDED_INLINE_WITH_EXPANDABLE_REFERENCES");
  });

  it("declines to classify a corpus with no indexed callers", () => {
    expect(classifyProjection({ ...base, indexedCallers: 0 })).toBe("UNKNOWN");
  });
});
