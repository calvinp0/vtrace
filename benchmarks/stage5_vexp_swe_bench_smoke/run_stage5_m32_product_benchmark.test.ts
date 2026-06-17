// Tests for the M32 product-benchmark report helper. Pure-function only: no Docker, no live
// agents, no command execution, no artifact mutation. Synthetic inputs.

import { describe, expect, it } from "bun:test";

import {
  UNKNOWN,
} from "./run_stage5_m31_context_actionability_scorecard";
import {
  classifyM32,
  extractToolFilePaths,
  pathTouchesPivot,
  pivotEngagement,
  type M32Signals,
} from "./run_stage5_m32_product_benchmark";

const PIVOT = "django/contrib/admindocs/utils.py";
const ABS = "/home/calvin/code/vexp-swe-bench/.bench-repos/django__django/" + PIVOT;

describe("M32 — tool file path extraction", () => {
  it("separates reads from edits, ignoring bash/grep and null paths", () => {
    const { reads, edits } = extractToolFilePaths([
      { tool: "Read", category: "read", args: { file_path: ABS } },
      { tool: "Edit", category: "edit", args: { file_path: ABS } },
      { tool: "Bash", category: "other", path: null },
      { tool: "Grep", category: "search", args: { pattern: "x" } },
      { tool: "Write", category: "write", args: { file_path: "/x/other.py" } },
    ]);
    expect(reads).toEqual([ABS]);
    expect(edits).toEqual([ABS, "/x/other.py"]);
  });
  it("returns empty arrays for null input", () => {
    expect(extractToolFilePaths(null)).toEqual({ reads: [], edits: [] });
  });
});

describe("M32 — pathTouchesPivot suffix match", () => {
  it("matches an absolute tool path against a repo-relative pivot", () => {
    expect(pathTouchesPivot([ABS], [PIVOT])).toBe(true);
  });
  it("does not match an unrelated file", () => {
    expect(pathTouchesPivot(["/repo/tests/test_other.py"], [PIVOT])).toBe(false);
  });
});

describe("M32 — pivotEngagement", () => {
  it("inspected+edited when the pivot was both read and patched", () => {
    const e = pivotEngagement([PIVOT], [ABS], [ABS], [PIVOT]);
    expect(e.inspected).toBe(true);
    expect(e.edited).toBe(true);
  });
  it("inspected-only when read but never edited", () => {
    const e = pivotEngagement([PIVOT], [ABS], [], []);
    expect(e.inspected).toBe(true);
    expect(e.edited).toBe(false);
  });
  it("edited via final patch even if no Edit tool path was captured", () => {
    const e = pivotEngagement([PIVOT], [], [], [PIVOT]);
    expect(e.edited).toBe(true);
  });
  it("unknown when no pivots were surfaced", () => {
    const e = pivotEngagement([], [ABS], [ABS], [PIVOT]);
    expect(e.inspected).toBe(UNKNOWN);
    expect(e.edited).toBe(UNKNOWN);
  });
});

describe("M32 — classifyM32 (6-way)", () => {
  const base = (over: Partial<M32Signals>): M32Signals => ({
    conditionIsVtrace: true,
    hasResult: true,
    treatmentValid: true,
    contextInjected: true,
    pivotFiles: [PIVOT],
    goldFiles: [PIVOT],
    goldSurfaced: true,
    goldEditedComplete: true,
    pivotInspected: true,
    pivotEdited: true,
    ...over,
  });
  it("baseline condition is not classified as a treatment class", () => {
    expect(classifyM32(base({ conditionIsVtrace: false }))).toBe("unknown");
  });
  it("no result = unknown", () => {
    expect(classifyM32(base({ hasResult: false }))).toBe("unknown");
  });
  it("context not injected = safe_no_context", () => {
    expect(classifyM32(base({ contextInjected: false }))).toBe("safe_no_context");
  });
  it("gold surfaced + ALL gold files edited = actionability_success", () => {
    expect(classifyM32(base({ goldSurfaced: true, goldEditedComplete: true }))).toBe("actionability_success");
  });
  it("gold surfaced + NOT all gold edited (multi-pivot gap) = context_to_action_gap", () => {
    // sphinx-7462 shape: lead pivot edited, second gold pivot skipped.
    expect(classifyM32(base({ goldSurfaced: true, goldEditedComplete: false }))).toBe("context_to_action_gap");
  });
  it("gold surfaced but agent edited the WRONG file = context_to_action_gap", () => {
    // xarray-3677 shape: gold dataset.py surfaced, agent edited merge.py instead.
    expect(
      classifyM32(base({ goldSurfaced: true, goldEditedComplete: false, pivotEdited: true })),
    ).toBe("context_to_action_gap");
  });
  it("non-gold pivot but agent acted on it = retrieval_success", () => {
    expect(
      classifyM32(base({ goldSurfaced: false, goldEditedComplete: false, pivotFiles: ["a/b.py"], pivotEdited: true })),
    ).toBe("retrieval_success");
  });
  it("injected off-target + ignored = overhead_without_benefit", () => {
    expect(
      classifyM32(base({ goldSurfaced: false, goldEditedComplete: false, pivotFiles: ["a/b.py"], pivotEdited: false })),
    ).toBe("overhead_without_benefit");
  });
  it("context injected but no pivots = unknown", () => {
    expect(classifyM32(base({ goldSurfaced: false, goldEditedComplete: false, pivotFiles: [] }))).toBe("unknown");
  });
});
