// Stage 5 product-v2 turn-reduction report — the FIRST performance gate for the
// productized Capsule v2 path.
//
// It compares the prior in-pipeline `vtrace` condition against the new
// `vtrace-product-v2` condition (Capsule v2 opted in through the `run-pipeline` /
// `get_code_context` product surface) over the four known overhead cases. The
// question it answers is NOT "is the estimated savings block large" — it is the
// only question that matters for the product: does the richer first VTRACE call
// actually buy FEWER follow-up Read/Grep/Bash turns and LOWER total / cache-read
// tokens, with NO resolution loss?
//
// Design follows the established Stage 5 report pattern: a pure analysis core
// (records -> report object -> markdown/json string, no fs/clock) plus a thin IO
// `main()` gated behind `import.meta.main`. Read/Grep/Bash counts are computed
// from each run's ordered tool-call log via `summarizeOrderedToolCalls`, the same
// canonical helper the rest of Stage 5 uses (Read = fileReadToolCalls, Grep =
// grepLikeToolCalls, Bash = bashToolCalls).

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  OrderedToolCall,
  parseOrderedToolCalls,
  summarizeOrderedToolCalls,
  toInspectionToolCalls,
} from "../../src/capsule/toolCallLog";
import {
  checklistToolAgreement,
  type PivotCheckRow,
  type PivotInspectionRecord,
} from "../../src/capsule/finalEditDiagnostics";
import { buildPivotInspection } from "./run_stage5_capsule_v2_validation_report";
import {
  PRODUCT_V2_CONDITION,
  PRODUCT_V2_DEFAULT_INSTANCES,
  PRODUCT_V2_RUN_LABEL,
  ProductV2Signals,
  productV2ProbeDir,
  productV2ProbeFilePath,
} from "./stage5_product_v2_probe";

// ---------------------------------------------------------------------------
// Record types (the pure-core inputs — tests build these directly)
// ---------------------------------------------------------------------------

// One condition's measured outcome for one instance. Every field is nullable so a
// run that never produced a figure is reported as "n/a", never as a fabricated 0.
export interface ConditionMetrics {
  readonly resolved: boolean | null;
  readonly totalTokens: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly costUsd: number | null;
  readonly durationMs: number | null;
  // The engine the run actually used, from `_run.meta.json` (vtraceCapsuleEngine).
  readonly contextEngine: string | null;
  // The ordered tool-call log, or null when telemetry was unavailable.
  readonly toolCalls: readonly OrderedToolCall[] | null;
  // Context-to-action enforcement signals (product side only; null on the prior
  // side or when the run predates enforcement telemetry). Optional so existing
  // record fixtures stay valid.
  readonly enforcement?: PivotEnforcementMetrics | null;
}

// Context-to-action enforcement telemetry for one run: did the agent emit the
// PIVOT_CHECK checklist, engage the neighborhood, and do its tool-derived pivot
// inspection match its claimed rows?
export interface PivotEnforcementMetrics {
  readonly checklistEmitted: boolean | null;
  readonly neighborhoodMentioned: boolean | null;
  readonly records: readonly PivotInspectionRecord[];
  readonly pivotCheckRows: readonly PivotCheckRow[];
}

// One instance's prior-vs-product-v2 pairing plus the product-path probe signals.
export interface ProductV2CaseRecord {
  readonly instanceId: string;
  readonly prior: ConditionMetrics;
  readonly productV2: ConditionMetrics;
  // Product-path accounting / engine signals, when the probe ran. Null when the
  // product probe was not captured (the gate still reports from the run metrics).
  readonly productSignals: ProductV2Signals | null;
  // The PRIOR condition's product-path probe signals, when available. Used only
  // to compute the first-call token delta (prior first-response size vs the
  // neighborhood-enabled first-response size). Optional/null when the prior run
  // had no probe (e.g. a non-product prior); the gate still reports run metrics.
  readonly priorSignals?: ProductV2Signals | null;
}

// ---------------------------------------------------------------------------
// Derived per-case analysis
// ---------------------------------------------------------------------------

export interface ToolCounts {
  readonly read: number;
  readonly grep: number;
  readonly bash: number;
  // Read + Grep + Bash — the follow-up "turns" this gate wants to shrink.
  readonly followups: number;
  readonly available: boolean;
}

// A signed delta plus whether both sides were measurable. `delta` is
// product - prior, so NEGATIVE means the product path improved (fewer/lower).
export interface MetricDelta {
  readonly prior: number | null;
  readonly product: number | null;
  readonly delta: number | null;
  readonly improved: boolean; // delta strictly < 0 with both sides present
  readonly measurable: boolean;
}

export interface ProductV2CaseAnalysis {
  readonly instanceId: string;
  readonly priorEngine: string | null;
  readonly productEngine: string | null;
  readonly contextEngineIsV2: boolean;
  readonly capsuleV2Present: boolean;
  readonly priorCounts: ToolCounts;
  readonly productCounts: ToolCounts;
  readonly resolvedPrior: boolean | null;
  readonly resolvedProduct: boolean | null;
  // resolution preserved: product resolved >= prior resolved (no regression).
  readonly resolvedPreserved: boolean;
  readonly totalTokens: MetricDelta;
  readonly cacheReadTokens: MetricDelta;
  readonly inputTokens: MetricDelta;
  readonly outputTokens: MetricDelta;
  readonly cost: MetricDelta;
  readonly readCalls: MetricDelta;
  readonly grepCalls: MetricDelta;
  readonly bashCalls: MetricDelta;
  readonly followupCalls: MetricDelta;
  // ---- pivot-neighborhood observability (the new response shape) ----
  // Whether the product first response carried the additive pivotNeighborhood
  // section (the discriminator that proves the new shape reached the live run).
  readonly pivotNeighborhoodPresent: boolean;
  readonly pivotNeighborhoodExcerptCount: number;
  readonly pivotNeighborhoodPivotsEnriched: number;
  // First-call token delta: the prior first-response size vs the neighborhood
  // first-response size (product - prior), from each side's accounting block.
  // A positive delta is the ~1k investment the neighborhood adds up front.
  readonly firstCallTokens: MetricDelta;
  // Diagnostic (NOT part of strict AND): true when the measured TOTAL token
  // reduction exceeded the first-call token increase — i.e. the richer first
  // response more than paid for itself. Null when either side is not measurable.
  readonly firstResponseInvestmentPaidOff: boolean | null;
  // ---- context-to-action enforcement (product side) ----
  // Did the agent emit the PIVOT_CHECK checklist it was asked for?
  readonly checklistEmitted: boolean | null;
  // Hidden (non-traceback) pivots the agent never engaged with (status=ignored).
  readonly hiddenPivotsIgnored: number | null;
  // Pivots the agent directly inspected (Read/open), tool-derived.
  readonly pivotsInspected: number | null;
  // Pivots the final patch actually edited.
  readonly pivotsEdited: number | null;
  // Did the agent reference the injected pivot-neighborhood excerpts at all?
  readonly neighborhoodMentioned: boolean | null;
  // Fraction of the agent's checklist `inspected` claims that match tool evidence
  // (1 = every claim honest; <1 = claimed inspection the tools do not support).
  // Null when no checklist rows could be matched to a pivot.
  readonly checklistVsToolAgreement: number | null;
  // Strict-AND per-case PASS (see classifyCasePass).
  readonly pass: boolean;
  // Why the case did not pass (empty when it passed).
  readonly failedCriteria: readonly string[];
}

function toolCounts(metrics: ConditionMetrics): ToolCounts {
  const summary = summarizeOrderedToolCalls(metrics.toolCalls ?? [], metrics.toolCalls !== null);
  return {
    read: summary.fileReadToolCalls,
    grep: summary.grepLikeToolCalls,
    bash: summary.bashToolCalls,
    followups: summary.fileReadToolCalls + summary.grepLikeToolCalls + summary.bashToolCalls,
    available: summary.orderedTelemetryAvailable,
  };
}

function delta(prior: number | null, product: number | null): MetricDelta {
  const measurable = prior !== null && product !== null;
  const d = measurable ? product! - prior! : null;
  return {
    prior,
    product,
    delta: d,
    improved: d !== null && d < 0,
    measurable,
  };
}

// Resolution is "preserved" when the product path did not lose a resolve. Both
// unknown counts as preserved=false only when prior resolved and product did not;
// a null product resolution is treated as unknown -> NOT preserved (honest: we
// cannot claim no loss).
function resolutionPreserved(prior: boolean | null, product: boolean | null): boolean {
  if (prior === null) return product === true ? true : product === false ? true : false;
  if (product === null) return false;
  // preserved iff product resolved is at least as good as prior (true >= false).
  return Number(product) >= Number(prior);
}

// The per-case PASS verdict: STRICT AND. A case passes only when resolution is
// preserved AND total tokens drop AND cache-read tokens drop AND the combined
// Read+Grep+Bash follow-up turns drop. This is deliberately the hardest bar — a
// large estimated-savings block in the accounting does NOT count; only measured
// reductions do.
export function classifyCasePass(analysis: {
  resolvedPreserved: boolean;
  totalTokens: MetricDelta;
  cacheReadTokens: MetricDelta;
  followupCalls: MetricDelta;
}): { pass: boolean; failedCriteria: string[] } {
  const failedCriteria: string[] = [];
  if (!analysis.resolvedPreserved) failedCriteria.push("resolution-lost-or-unknown");
  if (!analysis.totalTokens.improved) failedCriteria.push("total-tokens-not-lower");
  if (!analysis.cacheReadTokens.improved) failedCriteria.push("cache-read-tokens-not-lower");
  if (!analysis.followupCalls.improved) failedCriteria.push("read-grep-bash-not-lower");
  return { pass: failedCriteria.length === 0, failedCriteria };
}

export function analyzeProductV2Case(record: ProductV2CaseRecord): ProductV2CaseAnalysis {
  const priorCounts = toolCounts(record.prior);
  const productCounts = toolCounts(record.productV2);
  const resolvedPreserved = resolutionPreserved(record.prior.resolved, record.productV2.resolved);
  const totalTokens = delta(record.prior.totalTokens, record.productV2.totalTokens);
  const cacheReadTokens = delta(record.prior.cacheReadTokens, record.productV2.cacheReadTokens);
  const followupCalls = delta(
    priorCounts.available ? priorCounts.followups : null,
    productCounts.available ? productCounts.followups : null,
  );
  const { pass, failedCriteria } = classifyCasePass({
    resolvedPreserved,
    totalTokens,
    cacheReadTokens,
    followupCalls,
  });
  // First-call token investment: prior vs product first-response size (chars/4
  // of the serialized run-pipeline response, from each side's accounting block).
  const firstCallTokens = delta(
    record.priorSignals?.accounting?.estimatedOutputTokens ?? null,
    record.productSignals?.accounting?.estimatedOutputTokens ?? null,
  );
  // Paid off when the measured total-token reduction exceeded the first-call
  // increase. totalTokens.delta is product - prior (negative = saved), so the
  // reduction magnitude is -totalTokens.delta.
  const firstResponseInvestmentPaidOff =
    totalTokens.measurable && firstCallTokens.measurable
      && totalTokens.delta !== null && firstCallTokens.delta !== null
      ? -totalTokens.delta > firstCallTokens.delta
      : null;
  // Context-to-action enforcement (product side). Null fields when the run carried
  // no enforcement telemetry (legacy run / pre-enforcement build).
  const enforcement = record.productV2.enforcement ?? null;
  const records = enforcement?.records ?? [];
  const hasRecords = records.length > 0;
  const checklistEmitted = enforcement?.checklistEmitted ?? null;
  const neighborhoodMentioned = enforcement?.neighborhoodMentioned ?? null;
  const pivotsInspected = hasRecords ? records.filter((r) => r.inspected).length : null;
  const pivotsEdited = hasRecords ? records.filter((r) => r.edited).length : null;
  const hiddenPivotsIgnored = hasRecords
    ? records.filter((r) => r.hidden && r.status === "ignored").length
    : null;
  const checklistVsToolAgreement = enforcement
    ? checklistToolAgreement(enforcement.pivotCheckRows, records).agreement
    : null;
  return {
    instanceId: record.instanceId,
    priorEngine: record.prior.contextEngine,
    productEngine: record.productV2.contextEngine,
    contextEngineIsV2:
      record.productSignals?.contextEngineIsV2 ??
      record.productV2.contextEngine?.toLowerCase() === "v2",
    capsuleV2Present: record.productSignals?.capsuleV2Present ?? false,
    priorCounts,
    productCounts,
    resolvedPrior: record.prior.resolved,
    resolvedProduct: record.productV2.resolved,
    resolvedPreserved,
    totalTokens,
    cacheReadTokens,
    inputTokens: delta(record.prior.inputTokens, record.productV2.inputTokens),
    outputTokens: delta(record.prior.outputTokens, record.productV2.outputTokens),
    cost: delta(record.prior.costUsd, record.productV2.costUsd),
    readCalls: delta(
      priorCounts.available ? priorCounts.read : null,
      productCounts.available ? productCounts.read : null,
    ),
    grepCalls: delta(
      priorCounts.available ? priorCounts.grep : null,
      productCounts.available ? productCounts.grep : null,
    ),
    bashCalls: delta(
      priorCounts.available ? priorCounts.bash : null,
      productCounts.available ? productCounts.bash : null,
    ),
    followupCalls,
    pivotNeighborhoodPresent: record.productSignals?.pivotNeighborhoodPresent ?? false,
    pivotNeighborhoodExcerptCount: record.productSignals?.pivotNeighborhoodExcerptCount ?? 0,
    pivotNeighborhoodPivotsEnriched: record.productSignals?.pivotNeighborhoodPivotsEnriched ?? 0,
    firstCallTokens,
    firstResponseInvestmentPaidOff,
    checklistEmitted,
    hiddenPivotsIgnored,
    pivotsInspected,
    pivotsEdited,
    neighborhoodMentioned,
    checklistVsToolAgreement,
    pass,
    failedCriteria,
  };
}

// ---------------------------------------------------------------------------
// Aggregate report
// ---------------------------------------------------------------------------

export interface AggregateDeltas {
  readonly caseCount: number;
  readonly casesPassed: number;
  // Resolution: prior vs product resolved counts (lower product = loss).
  readonly resolvedPrior: number;
  readonly resolvedProduct: number;
  readonly resolvedDelta: number;
  readonly noResolutionLoss: boolean;
  // Summed deltas (product - prior). Negative = improvement. Only cases where
  // BOTH sides were measurable contribute to a sum.
  readonly totalTokensDelta: number | null;
  readonly cacheReadTokensDelta: number | null;
  readonly readCallsDelta: number | null;
  readonly grepCallsDelta: number | null;
  readonly bashCallsDelta: number | null;
  readonly followupCallsDelta: number | null;
  readonly costDelta: number | null;
}

export interface ProductV2TurnReductionReport {
  readonly generatedAt: string;
  readonly priorCondition: string;
  readonly productCondition: string;
  readonly runLabel: string;
  readonly cases: readonly ProductV2CaseAnalysis[];
  readonly aggregate: AggregateDeltas;
  // Experiment-level verdict: distinct from per-case PASS. "promising" requires
  // no aggregate resolution loss, aggregate token + cache-read + turn reductions,
  // and at least PROMISING_MIN_CASES_PASSED of the cases passing strict AND.
  readonly experimentVerdict: "promising" | "not-promising" | "insufficient-data";
  readonly experimentReasons: readonly string[];
}

// With only four stochastic live cases, a single regression should not sink the
// gate — but a majority must clear the strict bar for the result to be promising.
export const PROMISING_MIN_CASES_PASSED = 3;

function sumDeltas(cases: readonly ProductV2CaseAnalysis[], pick: (c: ProductV2CaseAnalysis) => MetricDelta): number | null {
  const measurable = cases.map(pick).filter((d) => d.measurable && d.delta !== null);
  if (measurable.length === 0) return null;
  return measurable.reduce((acc, d) => acc + (d.delta ?? 0), 0);
}

export function buildProductV2TurnReductionReport(
  records: readonly ProductV2CaseRecord[],
  generatedAt: string,
): ProductV2TurnReductionReport {
  const cases = records.map(analyzeProductV2Case);
  const resolvedPrior = cases.filter((c) => c.resolvedPrior === true).length;
  const resolvedProduct = cases.filter((c) => c.resolvedProduct === true).length;
  const casesPassed = cases.filter((c) => c.pass).length;

  const totalTokensDelta = sumDeltas(cases, (c) => c.totalTokens);
  const cacheReadTokensDelta = sumDeltas(cases, (c) => c.cacheReadTokens);
  const readCallsDelta = sumDeltas(cases, (c) => c.readCalls);
  const grepCallsDelta = sumDeltas(cases, (c) => c.grepCalls);
  const bashCallsDelta = sumDeltas(cases, (c) => c.bashCalls);
  const followupCallsDelta = sumDeltas(cases, (c) => c.followupCalls);
  const costDelta = sumDeltas(cases, (c) => c.cost);

  const aggregate: AggregateDeltas = {
    caseCount: cases.length,
    casesPassed,
    resolvedPrior,
    resolvedProduct,
    resolvedDelta: resolvedProduct - resolvedPrior,
    noResolutionLoss: resolvedProduct >= resolvedPrior,
    totalTokensDelta,
    cacheReadTokensDelta,
    readCallsDelta,
    grepCallsDelta,
    bashCallsDelta,
    followupCallsDelta,
    costDelta,
  };

  const { verdict, reasons } = classifyExperiment(aggregate);
  return {
    generatedAt,
    priorCondition: "vtrace",
    productCondition: PRODUCT_V2_CONDITION,
    runLabel: PRODUCT_V2_RUN_LABEL,
    cases,
    aggregate,
    experimentVerdict: verdict,
    experimentReasons: reasons,
  };
}

// The experiment-level bar (distinct from per-case strict AND). Promising iff:
//  - no aggregate resolution loss,
//  - aggregate total tokens decrease,
//  - aggregate cache-read tokens decrease,
//  - aggregate Read/Grep/Bash calls decrease, and
//  - >= PROMISING_MIN_CASES_PASSED cases clear the per-case strict AND bar.
// Missing aggregate figures (no measurable cases) yield "insufficient-data".
function classifyExperiment(
  aggregate: AggregateDeltas,
): { verdict: ProductV2TurnReductionReport["experimentVerdict"]; reasons: string[] } {
  const reasons: string[] = [];
  if (
    aggregate.totalTokensDelta === null ||
    aggregate.cacheReadTokensDelta === null ||
    aggregate.followupCallsDelta === null
  ) {
    reasons.push("insufficient measurable telemetry across cases (live run required)");
    return { verdict: "insufficient-data", reasons };
  }
  let promising = true;
  if (!aggregate.noResolutionLoss) {
    promising = false;
    reasons.push(`aggregate resolution loss (${aggregate.resolvedPrior} -> ${aggregate.resolvedProduct})`);
  }
  if (!(aggregate.totalTokensDelta < 0)) {
    promising = false;
    reasons.push("aggregate total tokens did not decrease");
  }
  if (!(aggregate.cacheReadTokensDelta < 0)) {
    promising = false;
    reasons.push("aggregate cache-read tokens did not decrease");
  }
  if (!(aggregate.followupCallsDelta < 0)) {
    promising = false;
    reasons.push("aggregate Read/Grep/Bash calls did not decrease");
  }
  if (aggregate.casesPassed < PROMISING_MIN_CASES_PASSED) {
    promising = false;
    reasons.push(
      `${aggregate.casesPassed}/${aggregate.caseCount} cases passed strict AND (need >= ${PROMISING_MIN_CASES_PASSED})`,
    );
  }
  if (promising) reasons.push("all aggregate gates met and majority of cases passed strict AND");
  return { verdict: promising ? "promising" : "not-promising", reasons };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtNum(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function fmtSigned(value: number | null): string {
  if (value === null) return "n/a";
  if (value === 0) return "0";
  return value > 0 ? `+${value}` : String(value);
}

function fmtCost(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(4)}`;
}

function fmtBool(value: boolean | null): string {
  return value === null ? "n/a" : value ? "yes" : "no";
}

function deltaCell(d: MetricDelta): string {
  if (!d.measurable) return "n/a";
  const arrow = d.delta! < 0 ? "↓" : d.delta! > 0 ? "↑" : "·";
  // Round non-integer deltas (cost) to 4 dp so the cell stays readable.
  const value = Number.isInteger(d.delta!) ? d.delta! : Number(d.delta!.toFixed(4));
  return `${fmtSigned(value)} ${arrow}`;
}

export function renderMarkdown(report: ProductV2TurnReductionReport): string {
  const lines: string[] = [];
  lines.push("# Stage 5 — Product Capsule v2 turn-reduction gate");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push(
    `Comparison: \`${report.priorCondition}\` (prior in-pipeline path) vs ` +
      `\`${report.productCondition}\` (Capsule v2 via the product \`run-pipeline\` / \`get_code_context\` surface).`,
  );
  lines.push(`Run label: \`${report.runLabel}\``);
  lines.push("");

  lines.push("## What success means here");
  lines.push("");
  lines.push(
    "This is the FIRST performance gate for the product v2 path, **not** a VEXP parity proof. " +
      "Success is defined by MEASURED reductions, not by the size of the estimated-savings accounting block:",
  );
  lines.push("");
  lines.push("- fewer follow-up **Read / Grep / Bash** turns,");
  lines.push("- lower **total** and **cache-read** tokens,");
  lines.push("- **no resolution loss**.");
  lines.push("");
  lines.push(
    "Per-case **PASS** is strict AND of all four (resolution preserved, total tokens down, " +
      "cache-read down, Read+Grep+Bash down). A high `estimatedSavingsPercentVsNaiveFullFile` " +
      "in the accounting block does NOT by itself pass a case.",
  );
  lines.push("");
  lines.push(
    "Because the prior condition here is **product-v2 before pivotNeighborhood** and the product " +
      "condition is **product-v2 + pivotNeighborhood**, the question is whether the richer first " +
      "response (the ~1k-token neighborhood investment) buys back more than its cost in follow-up " +
      "turns. Each case therefore also reports a NON-gating diagnostic — **first-response investment " +
      "paid off** = total token reduction exceeded the first-call token increase — so the experiment " +
      "stays interpretable even when strict AND fails.",
  );
  lines.push("");

  // Experiment verdict
  lines.push("## Experiment verdict");
  lines.push("");
  lines.push(`**${report.experimentVerdict.toUpperCase()}**`);
  lines.push("");
  for (const reason of report.experimentReasons) lines.push(`- ${reason}`);
  lines.push("");

  // Aggregate
  const a = report.aggregate;
  lines.push("## Aggregate deltas (product − prior; negative = improvement)");
  lines.push("");
  lines.push("| Metric | Delta |");
  lines.push("| --- | --- |");
  lines.push(`| Cases | ${a.caseCount} |`);
  lines.push(`| Cases passed (strict AND) | ${a.casesPassed}/${a.caseCount} |`);
  lines.push(`| Resolved (prior → product) | ${a.resolvedPrior} → ${a.resolvedProduct} (${fmtSigned(a.resolvedDelta)}) |`);
  lines.push(`| No resolution loss | ${a.noResolutionLoss ? "yes" : "no"} |`);
  lines.push(`| Total tokens | ${fmtSigned(a.totalTokensDelta)} |`);
  lines.push(`| Cache-read tokens | ${fmtSigned(a.cacheReadTokensDelta)} |`);
  lines.push(`| Read calls | ${fmtSigned(a.readCallsDelta)} |`);
  lines.push(`| Grep/search calls | ${fmtSigned(a.grepCallsDelta)} |`);
  lines.push(`| Bash calls | ${fmtSigned(a.bashCallsDelta)} |`);
  lines.push(`| Read+Grep+Bash (follow-ups) | ${fmtSigned(a.followupCallsDelta)} |`);
  lines.push(`| Cost (USD) | ${a.costDelta === null ? "n/a" : fmtSigned(Number(a.costDelta.toFixed(4)))} |`);
  lines.push("");

  // Per-case
  lines.push("## Per-case detail");
  lines.push("");
  lines.push(
    "| Instance | PASS | engine=v2 | capsuleV2 | resolved (p→v2) | total tok | cache-read tok | Read | Grep | Bash | cost |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of report.cases) {
    lines.push(
      `| ${c.instanceId} | ${c.pass ? "✅" : "❌"} | ${c.contextEngineIsV2 ? "yes" : "no"} | ` +
        `${c.capsuleV2Present ? "yes" : "no"} | ` +
        `${fmtBool(c.resolvedPrior)}→${fmtBool(c.resolvedProduct)} | ` +
        `${deltaCell(c.totalTokens)} | ${deltaCell(c.cacheReadTokens)} | ` +
        `${deltaCell(c.readCalls)} | ${deltaCell(c.grepCalls)} | ${deltaCell(c.bashCalls)} | ${deltaCell(c.cost)} |`,
    );
  }
  lines.push("");

  // Per-case failure reasons + accounting
  for (const c of report.cases) {
    lines.push(`### ${c.instanceId}`);
    lines.push("");
    lines.push(`- Verdict: ${c.pass ? "PASS" : `NOT-PASS (${c.failedCriteria.join(", ")})`}`);
    lines.push(
      `- Read ${fmtNum(c.priorCounts.available ? c.priorCounts.read : null)}→${fmtNum(c.productCounts.available ? c.productCounts.read : null)}, ` +
        `Grep ${fmtNum(c.priorCounts.available ? c.priorCounts.grep : null)}→${fmtNum(c.productCounts.available ? c.productCounts.grep : null)}, ` +
        `Bash ${fmtNum(c.priorCounts.available ? c.priorCounts.bash : null)}→${fmtNum(c.productCounts.available ? c.productCounts.bash : null)}`,
    );
    lines.push(
      `- Telemetry available: prior=${c.priorCounts.available ? "yes" : "no"}, product=${c.productCounts.available ? "yes" : "no"}`,
    );
    // Pivot-neighborhood observability: did the new response shape reach this run?
    lines.push(
      `- pivotNeighborhood: present=${c.pivotNeighborhoodPresent ? "yes" : "no"}, ` +
        `excerpts=${c.pivotNeighborhoodExcerptCount}, pivots enriched=${c.pivotNeighborhoodPivotsEnriched}`,
    );
    // The interpretive diagnostic the experiment hinges on.
    const reduction = c.totalTokens.measurable && c.totalTokens.delta !== null ? -c.totalTokens.delta : null;
    lines.push(
      `- First-call token delta (neighborhood investment): ${deltaCell(c.firstCallTokens)}`,
    );
    lines.push(
      `- Total token reduction: ${reduction === null ? "n/a" : fmtSigned(reduction)} ` +
        `(saved follow-up tokens ${reduction === null ? "n/a" : reduction > 0 ? "exceed" : "do not exceed"} 0)`,
    );
    lines.push(
      `- First-response investment paid off (total reduction > first-call increase): ${fmtBool(c.firstResponseInvestmentPaidOff)}`,
    );
    // Context-to-action enforcement: did the agent account for the pivots/neighborhood?
    lines.push(
      `- Context-to-action: checklist emitted=${fmtBool(c.checklistEmitted)}, `
        + `neighborhood mentioned=${fmtBool(c.neighborhoodMentioned)}`,
    );
    lines.push(
      `- Pivots: inspected=${fmtNum(c.pivotsInspected)}, edited=${fmtNum(c.pivotsEdited)}, `
        + `hidden ignored=${fmtNum(c.hiddenPivotsIgnored)}`,
    );
    lines.push(
      `- Checklist vs tool agreement (claimed inspection matches tool evidence): `
        + `${c.checklistVsToolAgreement === null ? "n/a" : c.checklistVsToolAgreement.toFixed(2)}`,
    );
    lines.push("");
  }

  lines.push("## Non-claims");
  lines.push("");
  lines.push("- This gate does not change retrieval, context selection, or make v2 the default.");
  lines.push("- It is a focused 4-case validation, not a 100-task benchmark and not VEXP parity.");
  lines.push("- Estimated accounting figures are context for the first call only; the gate is decided on measured run metrics.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

export function renderJson(report: ProductV2TurnReductionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Thin IO layer (loads on-disk run trees; gated behind import.meta.main)
// ---------------------------------------------------------------------------

const RESULTS_REL = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");
const DEFAULT_OUT_NAME = "stage5_vtrace_product_v2_turn_reduction";

// On disk, the product-v2 run is still the `vtrace` Stage5Condition (we did NOT
// add a new condition to the harness union — that would ripple through hundreds
// of sites). Prior and product runs are distinguished by their `--run-label`, not
// by the condition directory. `vtrace-product-v2` is the LOGICAL name surfaced in
// the report; both runs read from `raw/vtrace` (under their respective labels).
const ON_DISK_CONDITION = "vtrace";

export interface ReportCliConfig {
  readonly resultsDir: string;
  // Single fallback labels (applied to every instance when no per-instance list).
  readonly priorLabel: string | null;
  readonly productLabel: string;
  // Per-instance labels, index-parallel with `instances`. Each Stage 5 case is a
  // SEPARATE single-instance run with its own label (a multi-instance run mixes
  // tool-call telemetry into one log), so the report resolves each instance to its
  // own run. Empty => use the single fallback above for every instance.
  readonly priorLabels: readonly string[];
  readonly productLabels: readonly string[];
  readonly instances: readonly string[];
  readonly outName: string;
}

// Resolve the run label for one instance: the index-parallel per-instance label
// when provided, else the single fallback. A single-entry list applies to all.
export function resolveLabelForInstance(
  index: number,
  perInstance: readonly string[],
  fallback: string | null,
): string | null {
  if (perInstance.length === 0) return fallback;
  if (perInstance.length === 1) return perInstance[0]!;
  return perInstance[index] ?? fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// The raw/<condition> directory for a run, honoring the optional run label.
function rawConditionDir(resultsDir: string, label: string | null, condition: string): string {
  return label === null
    ? path.join(resultsDir, "raw", condition)
    : path.join(resultsDir, "runs", label, "raw", condition);
}

async function readJsonFile(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readToolCalls(dir: string): Promise<readonly OrderedToolCall[] | null> {
  // Prefer the parsed `_tool_calls.json`; fall back to parsing a raw stream-json.
  const parsed = await readJsonFile(path.join(dir, "_tool_calls.json"));
  if (Array.isArray(parsed)) return parsed as OrderedToolCall[];
  try {
    const stream = await readFile(path.join(dir, "_agent_stream.json"), "utf8");
    return parseOrderedToolCalls(stream);
  } catch {
    return null;
  }
}

// SWE-bench instance ids are canonical (`matplotlib__matplotlib-22719`) on disk,
// but runs are commonly referenced by the short form (`matplotlib-22719`) in
// labels and on the CLI. Normalize to the short form so either spelling matches.
export function normalizeInstanceId(id: string): string {
  const idx = id.indexOf("__");
  return idx >= 0 ? id.slice(idx + 2) : id;
}

// Read every JSONL row from the single `swebench-*.jsonl` file(s) in `dir`.
async function readSweBenchRows(dir: string): Promise<Record<string, unknown>[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  for (const name of entries.filter((n) => n.endsWith(".jsonl")).sort()) {
    let text: string;
    try {
      text = await readFile(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line);
        if (isRecord(parsed)) rows.push(parsed);
      } catch {
        // skip malformed lines
      }
    }
  }
  return rows;
}

function findRowForInstance(
  rows: readonly Record<string, unknown>[],
  instanceId: string,
): Record<string, unknown> | null {
  const target = normalizeInstanceId(instanceId);
  return (
    rows.find((r) => {
      const rid = asString(r.instanceId);
      return rid !== null && (rid === instanceId || normalizeInstanceId(rid) === target);
    }) ?? null
  );
}

// Total tokens billed for a row, summed exactly as the Stage 5 capsule-v2 report
// does (input + output + cache-read + cache-creation). There is no `totalTokens`
// field on the row, so it is always computed.
function rowTotalTokens(r: Record<string, unknown>): number | null {
  const parts = [r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens].map(asNumber);
  if (parts.every((p) => p === null)) return null;
  return parts.reduce<number>((acc, p) => acc + (p ?? 0), 0);
}

// Pull one instance's metrics out of a condition's run tree: the matching
// `swebench-*.jsonl` row (tokens/cost/resolution/tool-call counts), the run meta
// (engine), and the ordered tool-call log. Returns the metrics plus the canonical
// instance id found on the row (used to locate the product probe file).
async function loadConditionMetrics(
  resultsDir: string,
  label: string | null,
  condition: string,
  instanceId: string,
): Promise<{ metrics: ConditionMetrics; matchedInstanceId: string | null }> {
  const dir = rawConditionDir(resultsDir, label, condition);
  const rows = await readSweBenchRows(dir);
  const row = findRowForInstance(rows, instanceId);
  const meta = await readJsonFile(path.join(dir, "_run.meta.json"));
  const toolCalls = await readToolCalls(dir);
  const r = row ?? {};
  const m = isRecord(meta) ? meta : {};
  const metrics: ConditionMetrics = {
    resolved: asBool(r.resolved),
    totalTokens: row === null ? null : rowTotalTokens(r),
    inputTokens: asNumber(r.inputTokens),
    outputTokens: asNumber(r.outputTokens),
    cacheReadTokens: asNumber(r.cacheReadTokens),
    costUsd: asNumber(r.costUsd),
    durationMs: asNumber(r.durationMs),
    contextEngine: asString(m.vtraceCapsuleEngine) ?? asString(m.capsuleEngine),
    toolCalls,
    enforcement: buildEnforcementMetrics(m, row, toolCalls),
  };
  return { metrics, matchedInstanceId: asString(r.instanceId) };
}

// Derive context-to-action enforcement metrics for a run from its meta + record +
// ordered tool calls. Returns null when the run carried no enforcement telemetry
// (no `vtracePivotChecklistEmitted` / `vtraceNeighborhoodMentioned` keys — a
// legacy / pre-enforcement build), so the report shows n/a rather than fabricated
// values. Reuses the shared pivot-inspection classifier.
function buildEnforcementMetrics(
  meta: Record<string, unknown>,
  row: Record<string, unknown> | null,
  toolCalls: readonly OrderedToolCall[] | null,
): PivotEnforcementMetrics | null {
  const hasTelemetry =
    "vtracePivotChecklistEmitted" in meta || "vtraceNeighborhoodMentioned" in meta;
  if (!hasTelemetry) return null;
  const inspection = buildPivotInspection(
    meta,
    row,
    toolCalls === null ? null : toInspectionToolCalls(toolCalls),
  );
  const pivotCheckRows = Array.isArray(meta.vtracePivotCheckRows)
    ? (meta.vtracePivotCheckRows as PivotCheckRow[])
    : [];
  return {
    checklistEmitted: asBool(meta.vtracePivotChecklistEmitted),
    neighborhoodMentioned: asBool(meta.vtraceNeighborhoodMentioned),
    records: inspection.records,
    pivotCheckRows,
  };
}

// The harness persists the already-parsed ProductV2Signals object (not the raw
// run-pipeline stdout), so we read it back directly with a light shape check.
// The probe lives in the per-run LABEL dir (the external vexp `run` cleans
// raw/vtrace, so the probe is written one level up) and is keyed by the canonical
// instance id the harness saw.
async function loadProductSignals(
  resultsDir: string,
  label: string,
  instanceId: string,
): Promise<ProductV2Signals | null> {
  const dir = productV2ProbeDir(resultsDir, label);
  const parsed = await readJsonFile(productV2ProbeFilePath(dir, instanceId));
  if (!isRecord(parsed)) return null;
  return {
    parseOk: parsed.parseOk === true,
    contextEngine: asString(parsed.contextEngine),
    contextEngineIsV2: parsed.contextEngineIsV2 === true,
    capsuleV2Present: parsed.capsuleV2Present === true,
    // The neighborhood fields are absent on a pre-neighborhood probe; default to
    // honest negatives so an older baseline reads as "no neighborhood".
    pivotNeighborhoodPresent: parsed.pivotNeighborhoodPresent === true,
    pivotNeighborhoodExcerptCount: asNumber(parsed.pivotNeighborhoodExcerptCount) ?? 0,
    pivotNeighborhoodPivotsEnriched: asNumber(parsed.pivotNeighborhoodPivotsEnriched) ?? 0,
    accounting: isRecord(parsed.accounting)
      ? (parsed.accounting as unknown as ProductV2Signals["accounting"])
      : null,
  };
}

export async function loadProductV2CaseInputs(
  config: ReportCliConfig,
): Promise<readonly ProductV2CaseRecord[]> {
  const records: ProductV2CaseRecord[] = [];
  for (let index = 0; index < config.instances.length; index += 1) {
    const instanceId = config.instances[index]!;
    const priorLabel = resolveLabelForInstance(index, config.priorLabels, config.priorLabel);
    const productLabel = resolveLabelForInstance(index, config.productLabels, config.productLabel) ?? config.productLabel;
    const prior = await loadConditionMetrics(config.resultsDir, priorLabel, ON_DISK_CONDITION, instanceId);
    const productV2 = await loadConditionMetrics(config.resultsDir, productLabel, ON_DISK_CONDITION, instanceId);
    // Locate the probe by the canonical id the harness wrote, falling back to the
    // requested id when no row matched.
    const probeId = productV2.matchedInstanceId ?? instanceId;
    const productSignals = await loadProductSignals(config.resultsDir, productLabel, probeId);
    // The prior probe (if the prior run was itself a product-v2 run) gives the
    // pre-neighborhood first-response size for the first-call token delta.
    const priorProbeId = prior.matchedInstanceId ?? instanceId;
    const priorSignals = priorLabel === null
      ? null
      : await loadProductSignals(config.resultsDir, priorLabel, priorProbeId);
    records.push({
      instanceId,
      prior: prior.metrics,
      productV2: productV2.metrics,
      productSignals,
      priorSignals,
    });
  }
  return records;
}

export function parseArgs(argv: readonly string[]): ReportCliConfig {
  let resultsDir = path.resolve(RESULTS_REL);
  let priorLabel: string | null = null;
  let productLabel = PRODUCT_V2_RUN_LABEL;
  let priorLabels: readonly string[] = [];
  let productLabels: readonly string[] = [];
  let instances: readonly string[] = PRODUCT_V2_DEFAULT_INSTANCES;
  let outName = DEFAULT_OUT_NAME;
  const splitList = (v: string): string[] => v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = argv[index + 1];
    if (arg === "--results") {
      if (value === undefined) throw new Error("--results requires a value");
      resultsDir = path.resolve(value);
      index += 1;
    } else if (arg === "--prior-label") {
      if (value === undefined) throw new Error("--prior-label requires a value");
      priorLabel = value;
      index += 1;
    } else if (arg === "--product-label") {
      if (value === undefined) throw new Error("--product-label requires a value");
      productLabel = value;
      index += 1;
    } else if (arg === "--prior-labels") {
      if (value === undefined) throw new Error("--prior-labels requires a value");
      priorLabels = splitList(value);
      index += 1;
    } else if (arg === "--product-labels") {
      if (value === undefined) throw new Error("--product-labels requires a value");
      productLabels = splitList(value);
      index += 1;
    } else if (arg === "--instances") {
      if (value === undefined) throw new Error("--instances requires a value");
      instances = splitList(value);
      index += 1;
    } else if (arg === "--out-name") {
      if (value === undefined) throw new Error("--out-name requires a value");
      outName = value;
      index += 1;
    }
  }
  if (productLabels.length > 1 && productLabels.length !== instances.length) {
    throw new Error(`--product-labels count (${productLabels.length}) must be 1 or match --instances count (${instances.length}).`);
  }
  if (priorLabels.length > 1 && priorLabels.length !== instances.length) {
    throw new Error(`--prior-labels count (${priorLabels.length}) must be 1 or match --instances count (${instances.length}).`);
  }
  return { resultsDir, priorLabel, productLabel, priorLabels, productLabels, instances, outName };
}

export async function main(config: ReportCliConfig, generatedAt: string): Promise<ProductV2TurnReductionReport> {
  const records = await loadProductV2CaseInputs(config);
  const report = buildProductV2TurnReductionReport(records, generatedAt);
  await mkdir(config.resultsDir, { recursive: true });
  await writeFile(path.join(config.resultsDir, `${config.outName}.md`), renderMarkdown(report));
  await writeFile(path.join(config.resultsDir, `${config.outName}.json`), renderJson(report));
  return report;
}

if (import.meta.main) {
  main(parseArgs(process.argv.slice(2)), new Date().toISOString())
    .then((report) => {
      // eslint-disable-next-line no-console
      console.log(
        `[product-v2-turn-reduction] verdict=${report.experimentVerdict} ` +
          `cases=${report.aggregate.casesPassed}/${report.aggregate.caseCount}`,
      );
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error);
      process.exit(1);
    });
}
