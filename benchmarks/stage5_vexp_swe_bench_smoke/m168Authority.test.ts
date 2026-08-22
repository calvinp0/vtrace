import { describe, expect, test } from "bun:test";

import {
  analyzeEvalLogProvenance,
  analyzeTimestampGrid,
  analyzeTreatmentCompliance,
  diffToolSurfaces,
  priceRow,
  reconcileCost,
  type ModelPricing,
  type PublishedRunRow,
  type ToolSurface,
  type TreatmentExpectation,
} from "./m168Authority";

const PRICING: ModelPricing = {
  inputPerMTok: 5,
  outputPerMTok: 25,
  cacheReadPerMTok: 0.5,
  cacheWritePerMTok: 6.25,
};

const EXPECTATION: TreatmentExpectation = {
  mandatoryFirstTool: "run_pipeline",
  hookDeniedTools: ["Grep", "Glob"],
};

function row(over: Partial<PublishedRunRow> & { instanceId: string }): PublishedRunRow {
  const base: PublishedRunRow = {
    instanceId: over.instanceId,
    repo: "acme/widget",
    timestamp: "2026-03-22T08:00:00Z",
    model: "claude-opus-4-5-20251101",
    agent: "claude-code",
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 500_000,
    cacheCreationTokens: 20_000,
    costUsd: 0,
    numTurns: 10,
    durationMs: 60_000,
    toolCalls: { run_pipeline: 1, Read: 3, Edit: 1 },
    modelPatch: "diff --git a/x b/x\n",
    resolved: true,
    vexpMetrics: { tokenBudget: { total: 10_000, used: 4_000, saved: 6_000, savingPct: 60 } },
    ...over,
  };
  // Default to a SELF-CONSISTENT cost unless the caller overrode it.
  return over.costUsd === undefined ? { ...base, costUsd: priceRow(base, PRICING) } : base;
}

/**
 * A compliant run: the mandated tool is called on every task, no denied tool
 * ever appears, timestamps are irregular the way real wall-clock is, costs
 * re-price exactly, and the eval logs come from one grading pass.
 */
function compliantRows(): PublishedRunRow[] {
  return [
    row({ instanceId: "a__a-1", timestamp: "2026-03-22T08:00:00Z" }),
    row({ instanceId: "a__a-2", timestamp: "2026-03-22T08:02:11Z" }),
    row({ instanceId: "a__a-3", timestamp: "2026-03-22T08:09:47Z" }),
  ];
}

describe("M168 identity controls — an analyzer must clear the consistent case first", () => {
  test("timestamp grid: irregular real spacing is not flagged as generated", () => {
    const finding = analyzeTimestampGrid(compliantRows());
    expect(finding.isUniformGrid).toBe(false);
    expect(finding.gridSpacingSeconds).toBeNull();
    expect(finding.distinctDeltasSeconds.length).toBeGreaterThan(1);
  });

  test("treatment compliance: a run that honours mandate and denial is CONSISTENT", () => {
    const finding = analyzeTreatmentCompliance(compliantRows(), EXPECTATION);
    expect(finding.verdict).toBe("CONSISTENT_WITH_TREATMENT");
    expect(finding.rowsCallingMandatoryTool).toBe(3);
    expect(finding.deniedToolCallTotal).toBe(0);
    expect(finding.rowsWithProductMetrics).toBe(3);
  });

  test("cost reconciliation: self-consistent rows return EQUIVALENT with zero gap", () => {
    const finding = reconcileCost(compliantRows(), PRICING);
    expect(finding.verdict).toBe("ACCOUNTING_METRICS_EQUIVALENT");
    expect(finding.disagreeingRows).toBe(0);
    expect(finding.maxAbsoluteDeltaUsd).toBeLessThanOrEqual(1e-9);
    expect(finding.meanCostGapPct).toBeCloseTo(0, 9);
  });

  test("eval-log provenance: logs referencing only their own run id are SINGLE_RUN", () => {
    const finding = analyzeEvalLogProvenance("run-1", { "run-1": 40 }, 40);
    expect(finding.verdict).toBe("SINGLE_RUN");
    expect(finding.filesMatchingDeclaredRunId).toBe(40);
  });

  test("tool surface: a surface compared against itself reports no difference", () => {
    const surface: ToolSurface = {
      system: "self",
      visible: [
        { toolId: "run_pipeline", descriptionChars: 900 },
        { toolId: "get_skeleton", descriptionChars: 700 },
      ],
      hiddenCount: 3,
    };
    const diff = diffToolSurfaces(surface, surface);
    expect(diff.identical).toBe(true);
    expect(diff.leftOnlyToolIds).toEqual([]);
    expect(diff.rightOnlyToolIds).toEqual([]);
  });
});

describe("M168 known-positive controls — each analyzer must also fire when it should", () => {
  test("timestamp grid: a uniform generated grid is detected", () => {
    const rows = [
      row({ instanceId: "a__a-1", timestamp: "2026-03-22T08:00:00Z" }),
      row({ instanceId: "a__a-2", timestamp: "2026-03-22T08:05:00Z" }),
      row({ instanceId: "a__a-3", timestamp: "2026-03-22T08:10:00Z" }),
    ];
    const finding = analyzeTimestampGrid(rows);
    expect(finding.isUniformGrid).toBe(true);
    expect(finding.gridSpacingSeconds).toBe(300);
    expect(finding.orderedByInstanceId).toBe(true);
  });

  test("treatment compliance: denied tools present and mandate skipped is INCONSISTENT", () => {
    const rows = [
      row({ instanceId: "a__a-1", toolCalls: { Grep: 20, Read: 4, Edit: 2 } }),
      row({ instanceId: "a__a-2", toolCalls: { Glob: 3, Bash: 9 } }),
    ];
    const finding = analyzeTreatmentCompliance(rows, EXPECTATION);
    expect(finding.verdict).toBe("INCONSISTENT_WITH_TREATMENT");
    expect(finding.rowsCallingMandatoryTool).toBe(0);
    expect(finding.deniedToolCallTotal).toBe(23);
    expect(finding.deniedToolBreakdown).toEqual({ Grep: 20, Glob: 3 });
  });

  test("treatment compliance: MCP-prefixed and bare spellings are both counted, and both recorded", () => {
    const rows = [
      row({ instanceId: "a__a-1", toolCalls: { run_pipeline: 1 } }),
      row({ instanceId: "a__a-2", toolCalls: { "mcp__vexp-mcp__run_pipeline": 1 } }),
    ];
    const finding = analyzeTreatmentCompliance(rows, EXPECTATION);
    expect(finding.rowsCallingMandatoryTool).toBe(2);
    expect(finding.mandatoryToolNameVariants).toEqual([
      "mcp__vexp-mcp__run_pipeline",
      "run_pipeline",
    ]);
  });

  test("cost reconciliation: a stored cost from a different accounting is flagged", () => {
    const rows = [
      row({ instanceId: "a__a-1", costUsd: 0.4 }),
      row({ instanceId: "a__a-2", costUsd: 0.5 }),
    ];
    const finding = reconcileCost(rows, PRICING);
    expect(finding.verdict).toBe("ACCOUNTING_DEFINITION_GAP_CONFIRMED");
    expect(finding.disagreeingRows).toBe(2);
    expect(finding.medianRatio).not.toBeNull();
    // The direction of the disagreement is not part of the contract — only
    // that re-pricing the published tokens does not reproduce the published cost.
    expect(Math.abs(finding.medianRatio! - 1)).toBeGreaterThan(0.01);
  });

  test("cost reconciliation: a mixed file is PARTIALLY equivalent and names the agreeing rows", () => {
    const rows = [row({ instanceId: "agrees" }), row({ instanceId: "differs", costUsd: 0.4 })];
    const finding = reconcileCost(rows, PRICING);
    expect(finding.verdict).toBe("ACCOUNTING_METRICS_PARTIALLY_EQUIVALENT");
    expect(finding.agreeingRowIds).toEqual(["agrees"]);
  });

  test("eval-log provenance: logs citing several run ids are ASSEMBLED", () => {
    const finding = analyzeEvalLogProvenance(
      "run-declared",
      { "run-a": 32, "run-b": 28, "run-declared": 1 },
      61,
    );
    expect(finding.verdict).toBe("ASSEMBLED_FROM_MULTIPLE_RUNS");
    expect(finding.distinctReferencedRunIds).toBe(3);
    expect(finding.filesMatchingDeclaredRunId).toBe(1);
  });

  test("tool surface: a narrower surface with louder descriptions is described exactly", () => {
    const wide: ToolSurface = {
      system: "wide",
      visible: [
        { toolId: "run_pipeline", descriptionChars: 223 },
        { toolId: "get_skeleton", descriptionChars: 74 },
        { toolId: "search_memory", descriptionChars: 109 },
      ],
      hiddenCount: 7,
    };
    const narrow: ToolSurface = {
      system: "narrow",
      visible: [
        { toolId: "run_pipeline", descriptionChars: 949 },
        { toolId: "get_skeleton", descriptionChars: 718 },
      ],
      hiddenCount: 7,
    };
    const diff = diffToolSurfaces(wide, narrow);
    expect(diff.identical).toBe(false);
    expect(diff.leftOnlyToolIds).toEqual(["search_memory"]);
    expect(diff.rightOnlyToolIds).toEqual([]);
    expect(diff.sharedDescriptionChars).toEqual([
      { toolId: "get_skeleton", left: 74, right: 718 },
      { toolId: "run_pipeline", left: 223, right: 949 },
    ]);
  });
});

describe("M168 boundary behaviour", () => {
  test("an empty result set makes no claim in either direction", () => {
    const grid = analyzeTimestampGrid([]);
    expect(grid.isUniformGrid).toBe(false);
    expect(grid.rowCount).toBe(0);

    const cost = reconcileCost([], PRICING);
    expect(cost.verdict).toBe("ACCOUNTING_METRICS_EQUIVALENT");
    expect(cost.medianRatio).toBeNull();
  });

  test("a two-row file is never called a generated grid on one gap alone", () => {
    const rows = [
      row({ instanceId: "a__a-1", timestamp: "2026-03-22T08:00:00Z" }),
      row({ instanceId: "a__a-2", timestamp: "2026-03-22T08:05:00Z" }),
    ];
    expect(analyzeTimestampGrid(rows).isUniformGrid).toBe(false);
  });

  test("a null product-metrics block is counted as absent, not as zero savings", () => {
    const rows = [row({ instanceId: "a__a-1", vexpMetrics: null })];
    expect(analyzeTreatmentCompliance(rows, EXPECTATION).rowsWithProductMetrics).toBe(0);
  });
});
