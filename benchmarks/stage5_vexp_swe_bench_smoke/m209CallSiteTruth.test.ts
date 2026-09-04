import { describe, expect, test } from "bun:test";

import {
  callSiteIdentity, callSiteTruthFaults, classifyRenderability, crossFile, frozenA15Rendered, impactRole,
  renderedLineMatches, strippedEvidenceCharacters, type CallSiteTruthInput, type RelationLike,
} from "./m209CallSiteTruth";

const LINES = [
  "def handler(session):",
  "    owner = session.user",
  "    result = get_user_by_id(owner.id)",
  "    return result",
];
const FILE = { sizeBytes: 100, contentHash: "abc" };

const relation = (over: Partial<RelationLike> = {}, evidence: Partial<NonNullable<RelationLike["evidence"]>> = {}): RelationLike => ({
  id: "rel-1", edgeId: "edge-1", kind: "calls", direction: "incoming", strength: "resolved",
  source: { path: "routes/user.py", symbol: "routes/user.py::handler", nodeId: "s1", lineSpan: { start: 3, end: 3 } },
  target: { path: "services/user.py", symbol: "services/user.py::get_user_by_id", nodeId: "t1" },
  evidence: {
    resolutionMethod: "import_or_module_qualified_call_resolution", locationKind: "edge_site",
    callSites: [{ startLine: 3, endLine: 3, precision: "span" }], callSiteCount: 1,
    referenceName: "get_user_by_id", sourceText: "result = get_user_by_id(owner.id)", ...evidence,
  },
  ...over,
});

const input = (over: Partial<CallSiteTruthInput> = {}): CallSiteTruthInput => ({
  relation: relation(), sourceLines: LINES, indexedFile: FILE, actualFile: FILE,
  callerSpan: { startLine: 1, endLine: 4 }, expectedCallee: "get_user_by_id", ...over,
});

describe("callSiteTruthFaults", () => {
  test("an honest, source-anchored relation has no faults", () => {
    expect(callSiteTruthFaults(input())).toEqual([]);
  });
  test("F2: a span pointing at another valid-looking line is caught", () => {
    const faults = callSiteTruthFaults(input({ relation: relation({}, { callSites: [{ startLine: 2, endLine: 2, precision: "span" }] }) }));
    expect(faults).toContain("SPAN_TEXT_LACKS_CALLEE");
    expect(faults).toContain("SOURCE_TEXT_NOT_AT_SPAN");
  });
  test("F3: an invented line that names the callee still fails the source guard", () => {
    const faults = callSiteTruthFaults(input({ relation: relation({}, { sourceText: "user = await get_user_by_id(session.userId)" }) }));
    expect(faults).toEqual(["SOURCE_TEXT_NOT_AT_SPAN"]);
    // …and the frozen rule alone would have accepted it: that is why the guard exists.
    expect(frozenA15Rendered(relation({}, { sourceText: "user = await get_user_by_id(session.userId)" }))).toBe(true);
  });
  test("F11: a file that no longer matches the index is stale, whatever the text says", () => {
    expect(callSiteTruthFaults(input({ actualFile: { sizeBytes: 101, contentHash: "abc" } }))).toContain("SOURCE_STALE");
    expect(callSiteTruthFaults(input({ actualFile: { sizeBytes: 100, contentHash: "zzz" } }))).toContain("SOURCE_STALE");
  });
  test("F12: a relation without a persisted site is graph-only, not false", () => {
    const faults = callSiteTruthFaults(input({ relation: relation({}, { callSites: undefined, callSiteCount: undefined, sourceText: undefined, locationKind: "source_symbol_span" }) }));
    expect(faults).toEqual(["NO_CALL_SITE"]);
  });
  test("a site outside the caller's indexed span is stale provenance", () => {
    expect(callSiteTruthFaults(input({ callerSpan: { startLine: 10, endLine: 20 } }))).toContain("SITE_OUTSIDE_CALLER_SPAN");
  });
  test("a referenceName that is not the callee's local name is a mismatch", () => {
    expect(callSiteTruthFaults(input({ relation: relation({}, { referenceName: "get_user" }) }))).toContain("REFERENCE_NAME_MISMATCH");
  });
  test("text that does not name the callee is a strengthened claim", () => {
    const faults = callSiteTruthFaults(input({ relation: relation({}, { sourceText: "return result" }) }));
    expect(faults).toContain("SOURCE_TEXT_LACKS_CALLEE");
    expect(faults).toContain("SOURCE_TEXT_NOT_AT_SPAN");
  });
  test("unreadable source is reported as unreadable, not as stale", () => {
    expect(callSiteTruthFaults(input({ sourceLines: null, actualFile: null }))).toEqual(["SOURCE_UNREADABLE"]);
  });
});

describe("renderedLineMatches", () => {
  test("accepts the trimmed line and the 240-character cap", () => {
    expect(renderedLineMatches("result = get_user_by_id(owner.id)", LINES[2]!)).toBe(true);
    const long = `    x = ${"y".repeat(400)}`;
    expect(renderedLineMatches(long.trim().slice(0, 240), long)).toBe(true);
  });
  test("rejects any other text", () => {
    expect(renderedLineMatches("result = get_user_by_id(owner)", LINES[2]!)).toBe(false);
  });
});

describe("classifyRenderability", () => {
  test("no core relation is NO_TRUTH", () => {
    expect(classifyRenderability(null, [])).toBe("NO_TRUTH");
  });
  test("a faultless relation with core text is renderable from existing truth", () => {
    expect(classifyRenderability(relation(), [])).toBe("RENDERABLE_FROM_EXISTING_TRUTH");
  });
  test("a faultless relation without core text, or without a site, is graph-only", () => {
    expect(classifyRenderability(relation({}, { sourceText: undefined }), [])).toBe("GRAPH_ONLY_TRUTH");
    expect(classifyRenderability(relation(), ["NO_CALL_SITE"])).toBe("GRAPH_ONLY_TRUTH");
  });
  test("stale beats ambiguous beats graph-only", () => {
    expect(classifyRenderability(relation(), ["SOURCE_STALE", "SOURCE_TEXT_LACKS_CALLEE"])).toBe("STALE_TRUTH");
    expect(classifyRenderability(relation(), ["SITE_OUTSIDE_CALLER_SPAN"])).toBe("STALE_TRUTH");
    expect(classifyRenderability(relation(), ["SPAN_TEXT_LACKS_CALLEE"])).toBe("AMBIGUOUS_TRUTH");
    expect(classifyRenderability(relation(), ["REFERENCE_NAME_MISMATCH"])).toBe("AMBIGUOUS_TRUTH");
  });
});

describe("frozenA15Rendered", () => {
  test("delegates to the committed scorer: coordinates alone do not count", () => {
    expect(frozenA15Rendered(relation({}, { sourceText: undefined }))).toBe(false);
    expect(frozenA15Rendered(relation({}, { referenceName: undefined }))).toBe(false);
    expect(frozenA15Rendered(relation())).toBe(true);
    expect(frozenA15Rendered(null)).toBe(false);
  });
});

describe("identities and roles", () => {
  test("F6/F7: identity is the edge plus the rendered site", () => {
    expect(callSiteIdentity(relation())).toBe("edge-1@3-3");
    expect(callSiteIdentity(relation({}, { callSites: [{ startLine: 9, endLine: 10, precision: "span" }] }))).toBe("edge-1@9-10");
    expect(callSiteIdentity(relation({}, { callSites: undefined }))).toBe("edge-1@none");
  });
  test("roles come from the relation's own fields and never say potential", () => {
    expect(impactRole(relation())).toBe("resolved caller (persisted call site)");
    expect(impactRole(relation({ strength: "exact" }, { locationKind: "caller_span_scan" }))).toBe("exact caller (located occurrence)");
    expect(impactRole(relation({ kind: "imports", direction: "outgoing", strength: "resolved" }, { locationKind: "source_symbol_span" }))).toBe("outgoing resolved importer (symbol span only)");
    expect(impactRole(relation())).not.toContain("potential");
  });
  test("cross-file is decided from the delivered endpoints", () => {
    expect(crossFile(relation())).toBe(true);
    expect(crossFile(relation({ target: { path: "routes/user.py", symbol: "x", nodeId: "t" } }))).toBe(false);
    expect(crossFile(relation({ target: {} }))).toBeNull();
  });
});

describe("strippedEvidenceCharacters", () => {
  test("counts exactly the two keys the frozen rule reads, each with its separator", () => {
    const characters = strippedEvidenceCharacters({ sourceText: "a()", referenceName: "a" });
    expect(characters).toBe(`,"sourceText":"a()"`.length + `,"referenceName":"a"`.length);
    expect(strippedEvidenceCharacters({})).toBe(0);
  });
});
