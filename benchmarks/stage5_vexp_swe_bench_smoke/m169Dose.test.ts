import { describe, expect, test } from "bun:test";

import {
  BUDGET_LADDER,
  REFERENCE_BUDGET,
  RemovedMaterialClass,
  RetentionClass,
  classifyRemovedMaterial,
  classifyRetention,
  readSurface,
} from "./m169Dose";

function envelope(output: unknown): string {
  return JSON.stringify({ schema: { name: "vtrace.mcp_server", version: "1.0.0" }, result: { ok: true, output } });
}

const FULL = {
  schemaVersion: "run_pipeline.vnext/1",
  productContext: {
    resultState: "resolved",
    retrievalFound: true,
    resolved: true,
    deliveryFailed: false,
    coverage: { covered: 1 },
    freshness: { status: "fresh" },
    delivery: { status: "complete" },
    accounting: { claimBoundary: "indexed symbols only" },
    leadPivot: "a/b.py::Thing",
    modelVisibleContext: "● pivot a/b.py::Thing\n○ skel c/d.py::Helper\n",
    items: [
      { path: "a/b.py", fqName: "a/b.py::Thing", roles: ["pivot", "required"] },
      { path: "c/d.py", fqName: "c/d.py::Helper", roles: ["support"] },
    ],
  },
  pivotNeighborhood: [{ excerpts: [{ text: "x" }, { text: "y" }] }],
  impact: { included: true },
  flow: { included: false, skipReason: "intent_deemphasized" },
  memory: { session: { included: false, skipReason: "no_session_requested" }, durable: { included: false } },
  rules: { included: true },
  workspaceRouting: { outcome: "single_repo" },
  responseBudget: { within_envelope: true, compaction_applied: false, compacted_fields: [] },
};

const reference = readSurface(envelope(FULL));

describe("readSurface", () => {
  test("reads the semantic surface, not the whole payload", () => {
    expect(reference.parseStatus).toBe("PARSED");
    expect(reference.pivotPaths).toEqual(["a/b.py"]);
    expect(reference.supportPaths).toEqual(["c/d.py"]);
    expect(reference.leadPivot).toBe("a/b.py::Thing");
    expect(reference.pivotNeighborhoodExcerpts).toBe(2);
    expect(Object.values(reference.truthfulness).every(Boolean)).toBe(true);
  });

  test("KNOWN NEGATIVE: unparseable text is PARSE_FAILURE, never an empty delivery", () => {
    const broken = readSurface("not json at all");
    expect(broken.parseStatus).toBe("PARSE_FAILURE");
    expect(broken.pivotPaths).toEqual([]);
  });

  test("KNOWN NEGATIVE: a tool error is TOOL_ERROR, distinct from a missing output field", () => {
    expect(readSurface(JSON.stringify({ result: { ok: false } })).parseStatus).toBe("TOOL_ERROR");
    expect(readSurface(JSON.stringify({ result: { ok: true } })).parseStatus).toBe("NO_OUTPUT_FIELD");
  });
});

describe("classifyRetention", () => {
  test("IDENTITY CONTROL: the reference against itself is SEMANTICALLY_EQUIVALENT", () => {
    const verdict = classifyRetention(reference, readSurface(envelope(FULL)));
    expect(verdict.retention).toBe(RetentionClass.Equivalent);
    expect(verdict.lostPivotPaths).toEqual([]);
    expect(verdict.modelVisibleContextDeltaCharacters).toBe(0);
  });

  test("KNOWN POSITIVE: a dropped support file is MATERIAL_SUPPORT_LOSS", () => {
    const reduced = readSurface(envelope({
      ...FULL,
      productContext: { ...FULL.productContext, items: [FULL.productContext.items[0]] },
    }));
    const verdict = classifyRetention(reference, reduced);
    expect(verdict.retention).toBe(RetentionClass.SupportLoss);
    expect(verdict.lostSupportPaths).toEqual(["c/d.py"]);
  });

  test("KNOWN POSITIVE: a dropped pivot is MATERIAL_PRIMARY_LOSS, which outranks support loss", () => {
    const reduced = readSurface(envelope({
      ...FULL,
      productContext: { ...FULL.productContext, leadPivot: null, items: [] },
    }));
    expect(classifyRetention(reference, reduced).retention).toBe(RetentionClass.PrimaryLoss);
  });

  test("KNOWN POSITIVE: shedding a truthfulness field outranks every evidence outcome (§28)", () => {
    const { coverage, ...withoutCoverage } = FULL.productContext;
    const reduced = readSurface(envelope({ ...FULL, productContext: withoutCoverage }));
    const verdict = classifyRetention(reference, reduced);
    expect(verdict.retention).toBe(RetentionClass.TruthfulnessLoss);
    expect(verdict.lostTruthfulnessFields).toEqual(["coverage"]);
  });

  test("a rung that keeps every file but shortens the rendering is PRIMARY_EVIDENCE_PRESERVED", () => {
    const reduced = readSurface(envelope({
      ...FULL,
      productContext: { ...FULL.productContext, modelVisibleContext: "● pivot a/b.py::Thing\n" },
    }));
    const verdict = classifyRetention(reference, reduced);
    expect(verdict.retention).toBe(RetentionClass.PrimaryPreserved);
    expect(verdict.modelVisibleContextDeltaCharacters).toBeLessThan(0);
  });

  test("KNOWN NEGATIVE: an unparseable rung is NOT_COMPARABLE, not a total loss", () => {
    const verdict = classifyRetention(reference, readSurface("{"));
    expect(verdict.retention).toBe(RetentionClass.NotComparable);
    expect(verdict.lostPivotPaths).toEqual([]);
  });
});

describe("classifyRemovedMaterial", () => {
  test("a removed pivot is useful by construction", () => {
    expect(classifyRemovedMaterial("a/b.py", true, "")).toBe(RemovedMaterialClass.UsefulDistinct);
  });

  test("KNOWN NEGATIVE: a removed support still named by the surviving rendering is REDUNDANT", () => {
    expect(classifyRemovedMaterial("c/d.py", false, "see also c/d.py")).toBe(RemovedMaterialClass.Redundant);
  });

  test("a removed support named nowhere else is LOW_VALUE_SUPPORT", () => {
    expect(classifyRemovedMaterial("c/d.py", false, "nothing here")).toBe(RemovedMaterialClass.LowValueSupport);
  });

  test("an unnamed removal is UNKNOWN, never quietly redundant", () => {
    expect(classifyRemovedMaterial("", false, "")).toBe(RemovedMaterialClass.Unknown);
  });
});

describe("ladder", () => {
  test("frozen, descending, and led by the current default", () => {
    expect(BUDGET_LADDER[0]).toBe(REFERENCE_BUDGET);
    expect([...BUDGET_LADDER].sort((a, b) => b - a)).toEqual([...BUDGET_LADDER]);
    expect(BUDGET_LADDER).toEqual([8_000, 6_000, 4_000, 2_640, 2_000]);
  });
});
