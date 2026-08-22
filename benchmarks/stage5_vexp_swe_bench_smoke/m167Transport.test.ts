import { describe, expect, test } from "bun:test";

import {
  CategoryChannel,
  Observability,
  RepresentationRelation,
  Surface,
  categoryChannels,
  classifyRepresentations,
  locateFacts,
  summarizeSurfaces,
} from "./m167Transport";

/** A payload shaped like the real one, small enough to reason about by hand. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productContext: {
      modelVisibleContext: "PIVOT django/contrib/auth/backends.py\nCONTAINS ModelBackend.authenticate\n",
      items: [
        { path: "django/contrib/auth/backends.py", fqName: "ModelBackend.authenticate", roles: ["pivot", "documentation"] },
        { path: "django/contrib/auth/hashers.py", fqName: "check_password", roles: ["support", "documentation"] },
      ],
      freshness: { status: "fresh" },
    },
    capsuleResult: { digest: "django/contrib/auth/backends.py#ModelBackend.authenticate" },
    pivotNeighborhood: [{ excerpts: [{ filePath: "django/contrib/auth/backends.py", startLine: 10, endLine: 40 }] }],
    memory: { session: { included: false, skipReason: "no_relevant_observations" }, durable: { included: false, skipReason: "no_relevant_observations" } },
    impact: { included: false, skipReason: "not_applicable" },
    flow: { included: false },
    deferred: [],
    runtime: { commit: "749434ee" },
    diagnostics: {},
    responseBudget: { estimated_total_response_tokens: 1 },
    ...overrides,
  };
}

function envelope(output: unknown): Record<string, unknown> {
  return { schema: { name: "vtrace.mcp_server", version: "1.0.0" }, requestId: "jsonrpc:2:get_code_context", toolId: "get_code_context", result: { ok: true, output } };
}

describe("channel relation", () => {
  test("the text channel carries the output verbatim under a wrapper, which is a subset not an equality", () => {
    const output = payload();
    const verdict = classifyRepresentations(JSON.stringify(output), envelope(output));
    expect(verdict.relation).toBe(RepresentationRelation.Subset);
    expect(verdict.observability).toBe(Observability.Observed);
    expect(verdict.detail).toContain("requestId");
  });

  test("identical channels with no wrapper read as byte-equivalent", () => {
    const output = payload();
    expect(classifyRepresentations(JSON.stringify(output), { result: { output } }).relation)
      .toBe(RepresentationRelation.ByteEquivalent);
  });

  test("a short compatibility note is a partial summary, not a duplicate", () => {
    const output = payload();
    const summary = JSON.stringify({ productContext: { modelVisibleContext: "1 pivot, 1 support" } });
    expect(classifyRepresentations(summary, envelope(output)).relation).toBe(RepresentationRelation.PartialSummary);
  });

  test("unparseable text is unobservable, never absent", () => {
    const verdict = classifyRepresentations("{\"truncated\": ", envelope(payload()));
    expect(verdict.observability).toBe(Observability.ParseFailure);
    expect(verdict.relation).toBe(RepresentationRelation.Unobservable);
    // The point of the control: nothing in the vocabulary lets this read as empty.
    expect(verdict.relation).not.toBe(RepresentationRelation.PartialSummary);
  });
});

describe("surface duplication", () => {
  test("a fact rendered on the prose surface and the item list is counted on both", () => {
    const facts = locateFacts(payload());
    const backends = facts.find((f) => f.fact === "django/contrib/auth/backends.py");
    expect(backends?.surfaces).toContain(Surface.Rendering);
    expect(backends?.surfaces).toContain(Surface.Items);
    expect(backends?.surfaces).toContain(Surface.Digest);
  });

  test("a fact carried by only one surface is not reported as duplicated", () => {
    const facts = locateFacts(payload());
    const hashers = facts.find((f) => f.fact === "django/contrib/auth/hashers.py");
    expect(hashers?.surfaces).toEqual([Surface.Items]);
    expect(summarizeSurfaces(payload()).multiSurfaceFactCount).toBeGreaterThan(0);
  });

  test("short repeated enum labels are not facts, so shared roles never merge two items", () => {
    // Both items carry the role "documentation". If that counted as a fact the two
    // items would look like one, which is the M166 defect this control exists for.
    const facts = locateFacts(payload());
    expect(facts.some((f) => f.fact === "documentation")).toBe(false);
    expect(facts.filter((f) => f.kind === "path").map((f) => f.fact).sort())
      .toEqual(["django/contrib/auth/backends.py", "django/contrib/auth/hashers.py"]);
  });

  test("two components sharing a skip reason stay two components", () => {
    const channels = categoryChannels(JSON.stringify(payload()), envelope(payload()));
    // memory carries session and durable with the identical skip reason; the category
    // is present once but the payload still holds both members.
    const memory = (payload() as any).memory;
    expect(Object.keys(memory)).toEqual(["session", "durable"]);
    expect(memory.session.skipReason).toBe(memory.durable.skipReason);
    expect(channels.find((c) => c.category === "memory")?.channel).toBe(CategoryChannel.Both);
  });
});

describe("category channels", () => {
  test("every category the output carries is present in both channels today", () => {
    const output = payload();
    const channels = categoryChannels(JSON.stringify(output), envelope(output));
    expect(channels.filter((c) => c.channel === CategoryChannel.StructuredOnly)).toEqual([]);
    expect(channels.filter((c) => c.channel === CategoryChannel.TextOnly)).toEqual([]);
  });

  test("dropping the text channel makes every category structured-only", () => {
    const output = payload();
    const channels = categoryChannels(null, envelope(output));
    const named = channels.filter((c) => c.channel !== CategoryChannel.Neither);
    expect(named.every((c) => c.channel === CategoryChannel.StructuredOnly)).toBe(true);
    expect(named.length).toBeGreaterThan(8);
  });

  test("a category absent from both channels is neither, not structured-only", () => {
    const output = payload({ memory: null });
    expect(categoryChannels(JSON.stringify(output), envelope(output)).find((c) => c.category === "memory")?.channel)
      .toBe(CategoryChannel.Neither);
  });
});
