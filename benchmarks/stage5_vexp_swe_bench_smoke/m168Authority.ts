/**
 * M168 — VEXP benchmark protocol reproduction and differential attribution.
 *
 * PURE analysis functions over PUBLIC external artifacts (the vexp-swe-bench
 * harness at a pinned commit, its published result JSONL, its committed
 * SWE-bench evaluation logs, and the tool surfaces both products advertise).
 *
 * Nothing here reads VTRACE product state or spawns anything. The driver
 * (`run_stage5_m168_authority.ts`) supplies already-parsed inputs so every
 * verdict below is reproducible from the recorded evidence alone.
 *
 * Design rule inherited from M164/M167: a classifier that returns one
 * confident label for nearly every case is a detector smell. Every analyzer
 * here therefore has an IDENTITY CONTROL — fed a synthetic input that is
 * consistent by construction, it must return "no finding".
 */

// ── Published-result provenance ─────────────────────────────────────

export interface PublishedRunRow {
  readonly instanceId: string;
  readonly repo: string;
  readonly timestamp: string;
  readonly model: string;
  readonly agent: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number;
  readonly numTurns: number;
  readonly durationMs: number;
  readonly toolCalls: Readonly<Record<string, number>>;
  readonly modelPatch: string;
  readonly resolved: boolean | null;
  readonly vexpMetrics: unknown;
}

/**
 * What the published treatment CLAIMS the agent will do, expressed as
 * mechanically checkable expectations. Sourced from the harness's own
 * `writeClaudeMd` / `writeHooks` bytes, not from prose about them.
 */
export interface TreatmentExpectation {
  /** Tool the CLAUDE.md mandates as the first call on every task. */
  readonly mandatoryFirstTool: string;
  /** Tool names the PreToolUse hook matcher denies while the daemon is up. */
  readonly hookDeniedTools: readonly string[];
}

export interface TimestampGridFinding {
  readonly rowCount: number;
  readonly distinctDeltasSeconds: readonly number[];
  /** True when every consecutive gap is identical — a generated grid. */
  readonly isUniformGrid: boolean;
  readonly gridSpacingSeconds: number | null;
  /** Wall-clock span implied by the timestamps. */
  readonly spanSeconds: number;
  /** Sum of the rows' own reported durations. */
  readonly reportedDurationSeconds: number;
  /** Rows are ordered by instance id rather than by execution grouping. */
  readonly orderedByInstanceId: boolean;
}

export function analyzeTimestampGrid(rows: readonly PublishedRunRow[]): TimestampGridFinding {
  const times = rows.map((r) => Date.parse(r.timestamp)).sort((a, b) => a - b);
  const deltas = new Set<number>();
  for (let i = 1; i < times.length; i++) deltas.add((times[i]! - times[i - 1]!) / 1000);
  const distinct = [...deltas].sort((a, b) => a - b);
  const uniform = distinct.length === 1 && rows.length > 2;

  const ids = rows.map((r) => r.instanceId);
  const sortedIds = [...ids].sort();

  return {
    rowCount: rows.length,
    distinctDeltasSeconds: distinct,
    isUniformGrid: uniform,
    gridSpacingSeconds: uniform ? distinct[0]! : null,
    spanSeconds: times.length > 1 ? (times[times.length - 1]! - times[0]!) / 1000 : 0,
    reportedDurationSeconds: rows.reduce((s, r) => s + r.durationMs, 0) / 1000,
    orderedByInstanceId: ids.every((id, i) => id === sortedIds[i]),
  };
}

export interface TreatmentComplianceFinding {
  readonly rowCount: number;
  /** Rows carrying at least one call to the mandated first tool. */
  readonly rowsCallingMandatoryTool: number;
  readonly mandatoryToolCallTotal: number;
  /** Distinct spellings the mandated tool appears under (naming drift). */
  readonly mandatoryToolNameVariants: readonly string[];
  /** Rows using a tool the hook is configured to deny. */
  readonly rowsUsingDeniedTools: number;
  readonly deniedToolCallTotal: number;
  readonly deniedToolBreakdown: Readonly<Record<string, number>>;
  /** Rows where the product's own metrics block is present. */
  readonly rowsWithProductMetrics: number;
  /**
   * The treatment is CONSISTENT only if the mandate and the denial both show
   * up in behaviour. Anything else is reported, never explained away here.
   */
  readonly verdict: "CONSISTENT_WITH_TREATMENT" | "INCONSISTENT_WITH_TREATMENT";
}

/**
 * MCP tools reach the agent transcript as `mcp__<server>__<tool>`, so a bare
 * tool name and a prefixed one are both counted — and the fact that BOTH
 * spellings occur in one artifact is itself recorded, because a single run
 * against a single MCP config can only produce one of them.
 */
function matchesTool(recorded: string, tool: string): boolean {
  return recorded === tool || recorded.endsWith(`__${tool}`);
}

export function analyzeTreatmentCompliance(
  rows: readonly PublishedRunRow[],
  expectation: TreatmentExpectation,
): TreatmentComplianceFinding {
  let rowsCalling = 0;
  let callTotal = 0;
  const variants = new Set<string>();
  let rowsDenied = 0;
  let deniedTotal = 0;
  const deniedBreakdown: Record<string, number> = {};
  let withMetrics = 0;

  for (const row of rows) {
    let rowCalls = 0;
    let rowDenied = 0;
    for (const [name, count] of Object.entries(row.toolCalls)) {
      if (matchesTool(name, expectation.mandatoryFirstTool)) {
        rowCalls += count;
        variants.add(name);
      }
      for (const denied of expectation.hookDeniedTools) {
        if (matchesTool(name, denied)) {
          rowDenied += count;
          deniedBreakdown[denied] = (deniedBreakdown[denied] ?? 0) + count;
        }
      }
    }
    if (rowCalls > 0) rowsCalling++;
    callTotal += rowCalls;
    if (rowDenied > 0) rowsDenied++;
    deniedTotal += rowDenied;
    if (row.vexpMetrics != null) withMetrics++;
  }

  // Mandate honoured on every row AND no denied tool ever got through.
  const consistent = rowsCalling === rows.length && deniedTotal === 0;

  return {
    rowCount: rows.length,
    rowsCallingMandatoryTool: rowsCalling,
    mandatoryToolCallTotal: callTotal,
    mandatoryToolNameVariants: [...variants].sort(),
    rowsUsingDeniedTools: rowsDenied,
    deniedToolCallTotal: deniedTotal,
    deniedToolBreakdown: deniedBreakdown,
    rowsWithProductMetrics: withMetrics,
    verdict: consistent ? "CONSISTENT_WITH_TREATMENT" : "INCONSISTENT_WITH_TREATMENT",
  };
}

// ── Cost / token accounting equivalence ─────────────────────────────

export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok: number;
  readonly cacheWritePerMTok: number;
}

export function priceRow(row: PublishedRunRow, pricing: ModelPricing): number {
  return (
    (row.inputTokens / 1_000_000) * pricing.inputPerMTok
    + (row.outputTokens / 1_000_000) * pricing.outputPerMTok
    + (row.cacheReadTokens / 1_000_000) * pricing.cacheReadPerMTok
    + (row.cacheCreationTokens / 1_000_000) * pricing.cacheWritePerMTok
  );
}

export interface CostReconciliation {
  readonly rowCount: number;
  /** Rows where re-pricing the published tokens reproduces the published cost. */
  readonly agreeingRows: number;
  readonly disagreeingRows: number;
  readonly maxAbsoluteDeltaUsd: number;
  /** recomputed / stored, over disagreeing rows only. */
  readonly medianRatio: number | null;
  readonly publishedMeanCostUsd: number;
  readonly repricedMeanCostUsd: number;
  readonly meanCostGapPct: number;
  /**
   * Rows that agree are typically the ones whose agent process was killed
   * before emitting a final `result` event, so the harness had to fall back
   * to its own arithmetic. Recorded as a hypothesis-bearing observation, not
   * as an assumption: the driver checks it against the cost limit.
   */
  readonly agreeingRowIds: readonly string[];
  readonly verdict:
    | "ACCOUNTING_METRICS_EQUIVALENT"
    | "ACCOUNTING_METRICS_PARTIALLY_EQUIVALENT"
    | "ACCOUNTING_DEFINITION_GAP_CONFIRMED";
}

const CENT_TOLERANCE_USD = 1e-9;

export function reconcileCost(
  rows: readonly PublishedRunRow[],
  pricing: ModelPricing,
): CostReconciliation {
  const ratios: number[] = [];
  const agreeing: string[] = [];
  let maxDelta = 0;

  for (const row of rows) {
    const repriced = priceRow(row, pricing);
    const delta = Math.abs(repriced - row.costUsd);
    if (delta > maxDelta) maxDelta = delta;
    if (delta <= CENT_TOLERANCE_USD) agreeing.push(row.instanceId);
    else if (row.costUsd > 0) ratios.push(repriced / row.costUsd);
  }

  const sorted = [...ratios].sort((a, b) => a - b);
  const median = sorted.length === 0
    ? null
    : sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]!
      : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;

  const publishedMean = rows.reduce((s, r) => s + r.costUsd, 0) / Math.max(1, rows.length);
  const repricedMean = rows.reduce((s, r) => s + priceRow(r, pricing), 0) / Math.max(1, rows.length);

  const disagreeing = rows.length - agreeing.length;
  const verdict = disagreeing === 0
    ? "ACCOUNTING_METRICS_EQUIVALENT" as const
    : agreeing.length === 0
      ? "ACCOUNTING_DEFINITION_GAP_CONFIRMED" as const
      : "ACCOUNTING_METRICS_PARTIALLY_EQUIVALENT" as const;

  return {
    rowCount: rows.length,
    agreeingRows: agreeing.length,
    disagreeingRows: disagreeing,
    maxAbsoluteDeltaUsd: maxDelta,
    medianRatio: median,
    publishedMeanCostUsd: publishedMean,
    repricedMeanCostUsd: repricedMean,
    meanCostGapPct: publishedMean === 0 ? 0 : ((repricedMean - publishedMean) / publishedMean) * 100,
    agreeingRowIds: agreeing,
    verdict,
  };
}

// ── Evaluation-log provenance ───────────────────────────────────────

export interface EvalLogProvenance {
  /** Directory the logs are committed under. */
  readonly declaredRunId: string;
  /** Run ids the log CONTENTS reference, with the number of files each covers. */
  readonly referencedRunIds: Readonly<Record<string, number>>;
  readonly distinctReferencedRunIds: number;
  readonly filesMatchingDeclaredRunId: number;
  readonly totalLogFiles: number;
  readonly verdict: "SINGLE_RUN" | "ASSEMBLED_FROM_MULTIPLE_RUNS";
}

export function analyzeEvalLogProvenance(
  declaredRunId: string,
  referencedRunIds: Readonly<Record<string, number>>,
  totalLogFiles: number,
): EvalLogProvenance {
  const distinct = Object.keys(referencedRunIds).length;
  return {
    declaredRunId,
    referencedRunIds,
    distinctReferencedRunIds: distinct,
    filesMatchingDeclaredRunId: referencedRunIds[declaredRunId] ?? 0,
    totalLogFiles,
    verdict: distinct <= 1 ? "SINGLE_RUN" : "ASSEMBLED_FROM_MULTIPLE_RUNS",
  };
}

// ── Tool-surface differential ───────────────────────────────────────

export interface ToolSurfaceEntry {
  readonly toolId: string;
  readonly descriptionChars: number;
}

export interface ToolSurface {
  readonly system: string;
  /** Tools the agent sees in tools/list under the shipped default config. */
  readonly visible: readonly ToolSurfaceEntry[];
  /** Registered but withheld from tools/list. */
  readonly hiddenCount: number;
}

export interface ToolSurfaceDifferential {
  readonly left: string;
  readonly right: string;
  readonly leftVisibleCount: number;
  readonly rightVisibleCount: number;
  readonly sharedToolIds: readonly string[];
  readonly leftOnlyToolIds: readonly string[];
  readonly rightOnlyToolIds: readonly string[];
  readonly leftDescriptionChars: number;
  readonly rightDescriptionChars: number;
  /**
   * Per-tool description length for tools BOTH systems expose. The schema
   * channel is re-read every turn (M162), so a description gap on a shared
   * tool is a routing-signal gap, not a cosmetic one.
   */
  readonly sharedDescriptionChars: readonly {
    readonly toolId: string;
    readonly left: number;
    readonly right: number;
  }[];
  readonly identical: boolean;
}

export function diffToolSurfaces(left: ToolSurface, right: ToolSurface): ToolSurfaceDifferential {
  const leftById = new Map(left.visible.map((t) => [t.toolId, t] as const));
  const rightById = new Map(right.visible.map((t) => [t.toolId, t] as const));

  const shared = [...leftById.keys()].filter((id) => rightById.has(id)).sort();
  const leftOnly = [...leftById.keys()].filter((id) => !rightById.has(id)).sort();
  const rightOnly = [...rightById.keys()].filter((id) => !leftById.has(id)).sort();

  const sum = (s: ToolSurface) => s.visible.reduce((n, t) => n + t.descriptionChars, 0);

  return {
    left: left.system,
    right: right.system,
    leftVisibleCount: left.visible.length,
    rightVisibleCount: right.visible.length,
    sharedToolIds: shared,
    leftOnlyToolIds: leftOnly,
    rightOnlyToolIds: rightOnly,
    leftDescriptionChars: sum(left),
    rightDescriptionChars: sum(right),
    sharedDescriptionChars: shared.map((id) => ({
      toolId: id,
      left: leftById.get(id)!.descriptionChars,
      right: rightById.get(id)!.descriptionChars,
    })),
    identical:
      leftOnly.length === 0
      && rightOnly.length === 0
      && shared.every((id) => leftById.get(id)!.descriptionChars === rightById.get(id)!.descriptionChars),
  };
}
