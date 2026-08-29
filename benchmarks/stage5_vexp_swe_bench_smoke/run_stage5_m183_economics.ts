/**
 * M183-E — whole-run token and cost attribution.
 *
 *   bun run_stage5_m183_economics.ts
 *
 * The governing question (§149): does VTRACE save money over the COMPLETE run,
 * or merely compress its first repository-orientation operation? Those have
 * different denominators and this script never lets them share one.
 *
 * FOUR SEPARATIONS THIS FILE ENFORCES.
 *
 *   PAIRED vs POOLED (§44/§45). A median of per-pair reduction ratios and a
 *   pooled aggregate ratio answer different questions. Both are computed; neither
 *   is presented as the other. Percentages are never averaged across pairs whose
 *   baselines differ by an order of magnitude.
 *
 *   TOKENS vs COST (§71). Reported separately, always. A dollar reduction with no
 *   token reduction is a cache effect, and the four token components are carried
 *   through so a reader can see which happened.
 *
 *   ORIENTATION vs WHOLE RUN (§5/§98/§145). The packet's own tokens are the
 *   treatment's OVERHEAD. They are never the numerator of a whole-run claim, and
 *   the context-reduction table is emitted with an explicit NOT MEASURABLE cell
 *   rather than a manufactured baseline denominator.
 *
 *   POOLED vs OUTCOME-CONDITIONED (§100). M174 found 95.7% of a paired cost
 *   premium in two runs. Every aggregate here is also broken out by outcome
 *   class, and the five largest tails in each direction are named.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { bootstrapInterval, describe, effectVerdict, mean, median, quantile, reductionView, sum } from "./m183Analysis";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const TOKEN_SEED = "M183-tokens/v1";
const COST_SEED = "M183-cost/v1";

interface ArmSide {
  valid: boolean; resolved: boolean; costUsd: number | null; numTurns: number | null;
  totalAgentTokens: number; toolCallCount: number; toolCallsBeforeFirstEdit: number;
  reachedAnEdit: boolean; durationMs: number | null;
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
  toolCallsByCategory: Record<string, number>;
  preEditToolCallsByCategory: Record<string, number>;
  toolCallsByTool: Record<string, number> | null;
  triggerInjected?: boolean;
}
interface PairRecord {
  instanceId: string; repo: string; stratum: string; pairValid: boolean;
  baseline: ArmSide; treatment: ArmSide;
  orientation: { orientationTokens: number; injectedSectionTokens: number; deliveryState: string } | null;
}

const cat = (side: ArmSide, key: string, preEdit: boolean): number =>
  (preEdit ? side.preEditToolCallsByCategory : side.toolCallsByCategory)[key] ?? 0;

function main(): void {
  const records = (readFileSync(path.join(RESULTS, "stage5_m183_pair_records.jsonl"), "utf8")
    .split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as PairRecord))
    .filter((r) => r.pairValid);

  const costed = records.filter((r) => typeof r.baseline.costUsd === "number" && typeof r.treatment.costUsd === "number");

  const tokenPairs = records.map((r) => ({ baseline: r.baseline.totalAgentTokens, treatment: r.treatment.totalAgentTokens }));
  const costPairs = costed.map((r) => ({ baseline: r.baseline.costUsd!, treatment: r.treatment.costUsd! }));
  const tokenDeltas = tokenPairs.map((p) => p.treatment - p.baseline);
  const costDeltas = costPairs.map((p) => p.treatment - p.baseline);

  // Bootstrapped on the BASELINE-MINUS-TREATMENT sign so a positive point
  // estimate means a saving, matching effectVerdict's convention.
  const tokenSaving = tokenPairs.map((p) => p.baseline - p.treatment);
  const costSaving = costPairs.map((p) => p.baseline - p.treatment);
  const tokenInterval = bootstrapInterval(tokenSaving, median, TOKEN_SEED);
  const costInterval = bootstrapInterval(costSaving, median, COST_SEED);

  const tokenReduction = reductionView(tokenPairs);
  const costReduction = reductionView(costPairs);

  const component = (pick: (s: ArmSide) => number) => ({
    baselineMedian: median(records.map((r) => pick(r.baseline))),
    treatmentMedian: median(records.map((r) => pick(r.treatment))),
    baselinePooled: sum(records.map((r) => pick(r.baseline))),
    treatmentPooled: sum(records.map((r) => pick(r.treatment))),
    pairedMedianDelta: median(records.map((r) => pick(r.treatment) - pick(r.baseline))),
  });

  const outcomeClass = (r: PairRecord): string =>
    r.baseline.resolved && r.treatment.resolved ? "BOTH_SOLVED"
      : r.treatment.resolved ? "TREATMENT_ONLY_WIN"
      : r.baseline.resolved ? "BASELINE_ONLY_WIN" : "NEITHER_SOLVED";

  const byOutcome: Record<string, unknown> = {};
  for (const cls of ["BOTH_SOLVED", "TREATMENT_ONLY_WIN", "BASELINE_ONLY_WIN", "NEITHER_SOLVED"]) {
    const subset = costed.filter((r) => outcomeClass(r) === cls);
    byOutcome[cls] = {
      pairs: subset.length,
      medianCostDelta: median(subset.map((r) => r.treatment.costUsd! - r.baseline.costUsd!)),
      aggregateCostDelta: sum(subset.map((r) => r.treatment.costUsd! - r.baseline.costUsd!)),
      medianTokenDelta: median(subset.map((r) => r.treatment.totalAgentTokens - r.baseline.totalAgentTokens)),
      aggregateBaselineCost: sum(subset.map((r) => r.baseline.costUsd!)),
      aggregateTreatmentCost: sum(subset.map((r) => r.treatment.costUsd!)),
    };
  }

  // §101 — the tails, named, in both directions.
  const withDelta = costed.map((r) => ({ instanceId: r.instanceId, repo: r.repo, outcome: outcomeClass(r),
    costDelta: r.treatment.costUsd! - r.baseline.costUsd!,
    baselineCost: r.baseline.costUsd!, treatmentCost: r.treatment.costUsd!,
    tokenDelta: r.treatment.totalAgentTokens - r.baseline.totalAgentTokens,
    baselineTurns: r.baseline.numTurns, treatmentTurns: r.treatment.numTurns,
    baselineToolCalls: r.baseline.toolCallCount, treatmentToolCalls: r.treatment.toolCallCount }));
  const sortedByDelta = [...withDelta].sort((a, b) => b.costDelta - a.costDelta);
  const topPremium = sortedByDelta.slice(0, 5);
  const topSaving = [...sortedByDelta].reverse().slice(0, 5);
  const aggregateDelta = sum(costDeltas);
  const tailShare = aggregateDelta === 0 ? null
    : sum(topPremium.concat(topSaving).map((t) => t.costDelta)) / aggregateDelta;

  const orientations = records.map((r) => r.orientation).filter((o): o is NonNullable<typeof o> => o !== null);
  const orientationTokens = orientations.map((o) => o.orientationTokens);
  const sectionTokens = orientations.map((o) => o.injectedSectionTokens);

  const displacement = {
    definitionOfFirstMeaningfulEdit:
      "the first tool call the harness categorised as `edit` whose target is a repository path; frozen in run_stage5_m183_pair_records.ts before any outcome was seen (§49)",
    reachedAnEdit: { baseline: records.filter((r) => r.baseline.reachedAnEdit).length, treatment: records.filter((r) => r.treatment.reachedAnEdit).length, of: records.length },
    preEditToolCalls: {
      baselineMedian: median(records.map((r) => r.baseline.toolCallsBeforeFirstEdit)),
      treatmentMedian: median(records.map((r) => r.treatment.toolCallsBeforeFirstEdit)),
      pairedMedianDelta: median(records.map((r) => r.treatment.toolCallsBeforeFirstEdit - r.baseline.toolCallsBeforeFirstEdit)),
      distribution: describe(records.map((r) => r.treatment.toolCallsBeforeFirstEdit - r.baseline.toolCallsBeforeFirstEdit)),
    },
    preEditSearches: {
      baselineMedian: median(records.map((r) => cat(r.baseline, "search", true))),
      treatmentMedian: median(records.map((r) => cat(r.treatment, "search", true))),
      pairedMedianDelta: median(records.map((r) => cat(r.treatment, "search", true) - cat(r.baseline, "search", true))),
    },
    preEditReads: {
      baselineMedian: median(records.map((r) => cat(r.baseline, "read", true))),
      treatmentMedian: median(records.map((r) => cat(r.treatment, "read", true))),
      pairedMedianDelta: median(records.map((r) => cat(r.treatment, "read", true) - cat(r.baseline, "read", true))),
    },
    whyNotWallClock: "§48 — elapsed time is provider- and machine-noise dominated; requests and tool calls before the first edit are the countable quantity.",
  };

  const toolBehaviour = {
    note: "§51 — measured, not discouraged. No arm was told to search less.",
    byCategory: Object.fromEntries(["read", "search", "edit", "test", "shell", "unknown"].map((key) => [key, {
      baselineMedian: median(records.map((r) => cat(r.baseline, key, false))),
      treatmentMedian: median(records.map((r) => cat(r.treatment, key, false))),
      pairedMedianDelta: median(records.map((r) => cat(r.treatment, key, false) - cat(r.baseline, key, false))),
      baselinePooled: sum(records.map((r) => cat(r.baseline, key, false))),
      treatmentPooled: sum(records.map((r) => cat(r.treatment, key, false))),
    }])),
    totalToolCalls: component((s) => s.toolCallCount),
    vtraceToolCalls: { baseline: 0, treatment: 0,
      note: "Structurally zero in both arms: §6 holds the tool environment fixed, so neither arm has an MCP server. The orientation arrives in the prompt." },
  };

  const orientationEconomics = {
    schemaVersion: "stage5.m183.orientation-economics.v1",
    milestone: "M183", workstream: "M183-E",
    delivered: orientations.filter((o) => o.deliveryState === "ORIENTATION_DELIVERED").length,
    declined: orientations.filter((o) => o.deliveryState === "ORIENTATION_DECLINED").length,
    packetTokens: { median: median(orientationTokens), p90: quantile(orientationTokens, 0.9), max: orientationTokens.length === 0 ? null : Math.max(...orientationTokens), mean: mean(orientationTokens), n: orientationTokens.length },
    injectedSectionTokens: { median: median(sectionTokens), p90: quantile(sectionTokens, 0.9), max: sectionTokens.length === 0 ? null : Math.max(...sectionTokens) },
    m182OfflineComparison: {
      m182Median: 1229, m182P90: 1527, m182Max: 1576,
      liveMedian: median(orientationTokens), liveP90: quantile(orientationTokens, 0.9),
      liveMax: orientationTokens.length === 0 ? null : Math.max(...orientationTokens),
      note: "§47/§130 — M182's figures are over 167 Broad default-budget orientations; M183's are over its own 30-instance manifest. A different sample legitimately gives a different median. A materially LARGER live packet would be the thing to investigate.",
    },
    ceilingNote: "§131 — the ~2k ceiling is a maximum, not a target. A packet below it is `enough, then stop`, not a broken treatment.",
    breakEven: {
      question: "§99 — does the downstream saving exceed the orientation overhead?",
      medianOrientationTokens: median(orientationTokens),
      medianPairedTokenSaving: median(tokenSaving),
      recoveredOnMedian: median(tokenSaving) > median(orientationTokens),
      warning: "The orientation tokens are ALREADY inside the treatment arm's whole-run total. This comparison is a mechanism note; subtracting it from the whole-run delta would double-count (§99).",
    },
  };

  const contextVsWholeRun = {
    schemaVersion: "stage5.m183.context-vs-whole-run.v1",
    note: "§162 — three reduction concepts, three denominators, never merged.",
    rows: [
      {
        concept: "Repository context / orientation",
        baselineDenominator: "NOT MEASURABLE",
        why: "§98/§145 — the baseline arm has no repository-context artifact to measure. It investigates with Read and Grep, which is not a context payload with a token count. Inventing a 'full repository' or 'naive full-file' denominator here would be the VEXP-style marketing figure §5 forbids. The product's own `estimatedNaiveFullFileTokens` is a compression claim about selected files, not a claim about what the baseline agent actually spent.",
        treatmentNumerator: median(orientationTokens),
        reduction: "NOT MEASURABLE",
      },
      {
        concept: "Complete agent tokens",
        baselineDenominator: tokenReduction.pooledBaseline,
        treatmentNumerator: tokenReduction.pooledTreatment,
        reductionPooledPercent: tokenReduction.pooledPercent,
        reductionMedianPairedPercent: tokenReduction.medianPairedPercent,
      },
      {
        concept: "Complete agent cost",
        baselineDenominator: costReduction.pooledBaseline,
        treatmentNumerator: costReduction.pooledTreatment,
        reductionPooledPercent: costReduction.pooledPercent,
        reductionMedianPairedPercent: costReduction.medianPairedPercent,
      },
    ],
  };

  const tokenDoc = {
    schemaVersion: "stage5.m183.token-pairs.v1", milestone: "M183", workstream: "M183-E",
    definition: "TOTAL_AGENT_TOKENS = input + output + cacheRead + cacheCreation, from the harness result row (stage5_m183_token_accounting_contract.md)",
    pairs: records.length,
    baselineMedian: median(tokenPairs.map((p) => p.baseline)),
    treatmentMedian: median(tokenPairs.map((p) => p.treatment)),
    pairedDelta: describe(tokenDeltas),
    reduction: tokenReduction,
    interval: { statistic: "median paired saving (baseline - treatment)", seed: TOKEN_SEED, ...tokenInterval },
    verdict: effectVerdict(tokenInterval, median(tokenSaving), tokenReduction.pooledPercent),
    components: {
      inputTokens: component((s) => s.tokens.inputTokens),
      outputTokens: component((s) => s.tokens.outputTokens),
      cacheReadTokens: component((s) => s.tokens.cacheReadTokens),
      cacheCreationTokens: component((s) => s.tokens.cacheCreationTokens),
      note: "§71 — cache components are reported because a cost movement without a token movement is a cache effect and must be visible as one.",
    },
    turns: component((s) => s.numTurns ?? 0),
    perPair: records.map((r) => ({ instanceId: r.instanceId, repo: r.repo,
      baseline: r.baseline.totalAgentTokens, treatment: r.treatment.totalAgentTokens,
      delta: r.treatment.totalAgentTokens - r.baseline.totalAgentTokens })),
  };

  const costDoc = {
    schemaVersion: "stage5.m183.cost-pairs.v1", milestone: "M183", workstream: "M183-E",
    authority: "costUsd on the harness result row (stage5_m183_cost_accounting_contract.md)",
    pairs: costed.length,
    pairsWithoutCost: records.length - costed.length,
    baselineMedian: median(costPairs.map((p) => p.baseline)),
    treatmentMedian: median(costPairs.map((p) => p.treatment)),
    aggregateBaseline: costReduction.pooledBaseline,
    aggregateTreatment: costReduction.pooledTreatment,
    pairedDelta: describe(costDeltas),
    reduction: costReduction,
    interval: { statistic: "median paired saving (baseline - treatment)", seed: COST_SEED, ...costInterval },
    verdict: effectVerdict(costInterval, median(costSaving), costReduction.pooledPercent),
    costPerSolved: {
      note: "§96 — 'total spend / number solved' and 'median run cost among solved' are different quantities and are not interchangeable.",
      baselineTotalPerSolved: null as number | null,
      treatmentTotalPerSolved: null as number | null,
      baselineMedianAmongSolved: median(costed.filter((r) => r.baseline.resolved).map((r) => r.baseline.costUsd!)),
      treatmentMedianAmongSolved: median(costed.filter((r) => r.treatment.resolved).map((r) => r.treatment.costUsd!)),
    },
    byOutcome,
    tails: {
      note: "§101/§161 — the five largest paired deltas in each direction, so a pooled headline cannot hide them.",
      largestTreatmentPremium: topPremium,
      largestTreatmentSaving: topSaving,
      shareOfAggregateDeltaInTheseTenPairs: tailShare,
    },
  };
  const solvedBaseline = costed.filter((r) => r.baseline.resolved).length;
  const solvedTreatment = costed.filter((r) => r.treatment.resolved).length;
  costDoc.costPerSolved.baselineTotalPerSolved = solvedBaseline === 0 ? null : costReduction.pooledBaseline / solvedBaseline;
  costDoc.costPerSolved.treatmentTotalPerSolved = solvedTreatment === 0 ? null : costReduction.pooledTreatment / solvedTreatment;

  const write = (name: string, doc: unknown): void =>
    writeFileSync(path.join(RESULTS, name), `${JSON.stringify(doc, null, 2)}\n`);
  write("stage5_m183_token_pairs.json", tokenDoc);
  write("stage5_m183_cost_pairs.json", costDoc);
  write("stage5_m183_orientation_economics.json", orientationEconomics);
  write("stage5_m183_work_displacement.json", { schemaVersion: "stage5.m183.work-displacement.v1", milestone: "M183", workstream: "M183-E", pairs: records.length, ...displacement });
  write("stage5_m183_tool_behavior.json", { schemaVersion: "stage5.m183.tool-behavior.v1", milestone: "M183", workstream: "M183-E", pairs: records.length, ...toolBehaviour });
  write("stage5_m183_tail_analysis.json", { schemaVersion: "stage5.m183.tail-analysis.v1", milestone: "M183", workstream: "M183-E", ...costDoc.tails, byOutcome });
  write("stage5_m183_context_vs_whole_run.json", contextVsWholeRun);

  console.log(`M183-E over ${records.length} valid pairs (${costed.length} with cost on both arms)`);
  console.log(`  tokens  baseline median ${tokenDoc.baselineMedian}  treatment median ${tokenDoc.treatmentMedian}  verdict ${tokenDoc.verdict}`);
  console.log(`  cost    baseline median $${Number(costDoc.baselineMedian).toFixed(4)}  treatment median $${Number(costDoc.treatmentMedian).toFixed(4)}  verdict ${costDoc.verdict}`);
  console.log(`  orientation median ${orientationEconomics.packetTokens.median} tokens (M182 offline: 1229)`);
}

main();
