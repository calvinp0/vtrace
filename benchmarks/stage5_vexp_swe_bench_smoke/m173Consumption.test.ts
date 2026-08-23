import { describe, expect, it } from "bun:test";

import {
  OrientationUse,
  PivotConsequence,
  Rediscovery,
  classifyOrientationUse,
  classifyPivotConsequence,
  classifyRediscovery,
  samePath,
  searchRediscoversDeliveredEvidence,
} from "./m173Consumption";

const INVESTIGATION = ["SEARCH", "READ", "SHELL_INSPECTION"];

const packet = {
  focusFile: "lib/matplotlib/category.py",
  focusAt: "lib/matplotlib/category.py::StrCategoryConverter.convert",
  relatedFiles: ["lib/matplotlib/axis.py", "lib/matplotlib/units.py"],
};

describe("samePath", () => {
  it("tolerates the absolute / repo-relative split", () => {
    expect(samePath("/ws/repo/lib/matplotlib/category.py", "lib/matplotlib/category.py")).toBe(true);
    expect(samePath("lib/matplotlib/category.py", "lib/matplotlib/category.py")).toBe(true);
  });

  it("does not match a different file with a shared suffix segment", () => {
    expect(samePath("lib/other/category.py", "lib/matplotlib/category.py")).toBe(false);
  });

  it("treats null as no match rather than as a wildcard", () => {
    expect(samePath(null, "a.py")).toBe(false);
    expect(samePath("a.py", null)).toBe(false);
  });
});

describe("rediscovery classification", () => {
  it("calls reading the focus file targeted confirmation, not waste", () => {
    // §33 — the packet carries a skeleton, not a file. Opening what it pointed
    // at is the work the packet exists to direct.
    const tally = classifyRediscovery(
      packet,
      [{ requestIndex: 2, kind: "READ", target: "lib/matplotlib/category.py" }],
      1, INVESTIGATION,
    );
    expect(tally.targetedConfirmation).toBe(1);
    expect(tally.redundantRediscovery).toBe(0);
  });

  it("calls a search for a delivered file redundant rediscovery", () => {
    const tally = classifyRediscovery(
      packet,
      [{ requestIndex: 2, kind: "SEARCH", target: "StrCategoryConverter" }],
      1, INVESTIGATION,
    );
    expect(tally.redundantRediscovery).toBe(1);
  });

  it("calls a search for something undelivered new information", () => {
    const tally = classifyRediscovery(
      packet,
      [{ requestIndex: 2, kind: "SEARCH", target: "deprecation_helpers" }],
      1, INVESTIGATION,
    );
    expect(tally.newInformationSearch).toBe(1);
    expect(tally.redundantRediscovery).toBe(0);
  });

  it("matches the stem an agent would actually search for", () => {
    // Agents search `category`, not `category.py`, and reach for either half of
    // `StrCategoryConverter.convert`. A needle set that missed those would
    // report zero redundancy on a run full of it.
    expect(searchRediscoversDeliveredEvidence(packet, "category")).toBe(true);
    expect(searchRediscoversDeliveredEvidence(packet, "StrCategoryConverter")).toBe(true);
    expect(searchRediscoversDeliveredEvidence(packet, "convert")).toBe(true);
  });

  it("under-counts rather than over-counts on a broad query", () => {
    // A short or generic query that happens to match is not redundancy: the
    // agent could not have known. Over-counting here would flatter the product.
    expect(searchRediscoversDeliveredEvidence(packet, "def")).toBe(false);
    expect(searchRediscoversDeliveredEvidence(packet, "py")).toBe(false);
    expect(searchRediscoversDeliveredEvidence(packet, "unit")).toBe(false);
    expect(searchRediscoversDeliveredEvidence(packet, null)).toBe(false);
  });

  it("ignores actions that preceded the orientation", () => {
    const tally = classifyRediscovery(
      packet,
      [{ requestIndex: 0, kind: "SEARCH", target: "category.py" }],
      1, INVESTIGATION,
    );
    expect(tally.classified).toHaveLength(0);
  });

  it("ignores non-investigation actions", () => {
    const tally = classifyRediscovery(
      packet,
      [{ requestIndex: 2, kind: "EDIT", target: "lib/matplotlib/category.py" }],
      1, INVESTIGATION,
    );
    expect(tally.classified).toHaveLength(0);
  });
});

describe("orientation use classification", () => {
  const base = { packet, inspectedFiles: [], goldFiles: ["lib/matplotlib/category.py"], resolved: true };

  it("is DIRECTLY_USED when the focus file is edited", () => {
    const v = classifyOrientationUse({ ...base, editedFiles: ["lib/matplotlib/category.py"] });
    expect(v.use).toBe(OrientationUse.DirectlyUsed);
    expect(v.focusIsGold).toBe(true);
  });

  it("is PARTIALLY_USED when only a related file is edited", () => {
    const v = classifyOrientationUse({ ...base, editedFiles: ["lib/matplotlib/axis.py"] });
    expect(v.use).toBe(OrientationUse.PartiallyUsed);
  });

  it("is PARTIALLY_USED when the focus is read but the edit lands elsewhere", () => {
    const v = classifyOrientationUse({
      ...base,
      editedFiles: ["lib/other/thing.py"],
      inspectedFiles: ["lib/matplotlib/category.py"],
    });
    expect(v.use).toBe(OrientationUse.PartiallyUsed);
  });

  it("is IGNORED when nothing delivered is touched and the run still passed", () => {
    const v = classifyOrientationUse({
      ...base,
      editedFiles: ["lib/other/thing.py"],
      goldFiles: ["lib/other/thing.py"],
    });
    expect(v.use).toBe(OrientationUse.Ignored);
    expect(v.focusIsGold).toBe(false);
  });

  it("is MISLEADING only when a non-gold focus coincides with a failure", () => {
    const v = classifyOrientationUse({
      ...base,
      editedFiles: ["lib/other/thing.py"],
      goldFiles: ["lib/gold/real.py"],
      resolved: false,
    });
    expect(v.use).toBe(OrientationUse.Misleading);
  });

  it("is UNOBSERVABLE with no focus or no edit", () => {
    expect(classifyOrientationUse({
      ...base, packet: { focusFile: null, focusAt: null, relatedFiles: [] }, editedFiles: ["a.py"],
    }).use).toBe(OrientationUse.Unobservable);
    expect(classifyOrientationUse({ ...base, editedFiles: [] }).use).toBe(OrientationUse.Unobservable);
  });
});

describe("pivot consequence", () => {
  const base = {
    focusIsGold: false as boolean | null,
    use: OrientationUse.DirectlyUsed as OrientationUse,
    resolved: false as boolean | null,
    preEditInvestigationDelta: 0 as number | null,
    editedFocus: false,
    editedAnyGold: false,
  };

  it("does not apply when the pivot was correct", () => {
    expect(classifyPivotConsequence({ ...base, focusIsGold: true })).toBe(PivotConsequence.NotApplicable);
  });

  it("is a wrong edit when the agent edited the wrong focus and failed", () => {
    expect(classifyPivotConsequence({ ...base, editedFocus: true }))
      .toBe(PivotConsequence.CausedWrongEdit);
  });

  it("is extra investigation when the treatment investigated more pre-edit", () => {
    expect(classifyPivotConsequence({ ...base, preEditInvestigationDelta: 3 }))
      .toBe(PivotConsequence.CausedExtraInvestigation);
  });

  it("is recovery when the agent reached gold anyway", () => {
    expect(classifyPivotConsequence({ ...base, editedAnyGold: true, resolved: true }))
      .toBe(PivotConsequence.IgnoredOrRecovered);
  });

  it("returns NO_MEASURABLE_EFFECT for a wrong pivot with no observed consequence", () => {
    // §36 — the cheap move at the end of a neutral milestone is to point at a
    // wrong pivot and call it the bottleneck. This is the guard against it.
    expect(classifyPivotConsequence({ ...base, use: OrientationUse.PartiallyUsed }))
      .toBe(PivotConsequence.NoMeasurableEffect);
  });

  it("is unobservable without gold", () => {
    expect(classifyPivotConsequence({ ...base, focusIsGold: null })).toBe(PivotConsequence.Unobservable);
  });
});
