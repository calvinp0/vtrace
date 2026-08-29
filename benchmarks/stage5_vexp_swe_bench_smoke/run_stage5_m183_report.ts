/**
 * M183-F — assemble the verdicts and the required tables.
 *
 *   bun run_stage5_m183_report.ts
 *
 * Every number in the report comes from a committed artifact; nothing is
 * transcribed by hand (§143). The verdicts that are mechanical are COMPUTED here
 * — resolution, statistical resolution, token, cost — so that a reader can
 * disagree with the interpretation without having to re-derive the arithmetic.
 *
 * THE PRODUCT VERDICT IS A LOOKUP, NOT A JUDGEMENT (§110/§115). It is a function
 * of the resolution verdict and the cost verdict, and the mapping is written out
 * before the results exist so that an uncomfortable cell cannot be talked into a
 * friendlier one. `CURRENT_PRODUCT_NOT_COMPETITIVE` is reachable and is not
 * treated as a failure of the milestone.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const read = <T>(name: string): T | null => {
  const p = path.join(RESULTS, name);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
};
const n = (v: unknown, digits = 4): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "n/a";
const i = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "n/a";

/**
 * §110's matrix, written down before the outcomes existed.
 *
 * "Cheaper" and "dearer" mean the cost verdict resolved in that direction; a
 * NEUTRAL or MIXED cost verdict is neither, and lands on parity or on
 * NOT_RESOLVED rather than being rounded toward the friendlier neighbour.
 */
function productVerdict(resolution: string, cost: string): string {
  const better = resolution === "OBSERVED_RESOLUTION_IMPROVEMENT";
  const worse = resolution === "OBSERVED_RESOLUTION_REGRESSION";
  const parity = resolution === "OBSERVED_RESOLUTION_PARITY";
  const cheaper = cost === "REDUCTION_CONFIRMED";
  const dearer = cost === "INCREASE_CONFIRMED";
  if (resolution === "RESOLUTION_NOT_MEASURABLE" || cost === "NOT_MEASURABLE") return "CURRENT_PRODUCT_EFFECT_NOT_RESOLVED";
  if (better && cheaper) return "QUALITY_AND_ECONOMICS_WIN";
  if (parity && cheaper) return "ECONOMIC_WIN_WITH_QUALITY_PARITY";
  if (better && dearer) return "QUALITY_GAIN_WITH_COST_PREMIUM";
  if (parity && !cheaper && !dearer) return "CURRENT_PRODUCT_UTILITY_NEUTRAL";
  if (worse || (!better && dearer)) return "CURRENT_PRODUCT_NOT_COMPETITIVE";
  return "CURRENT_PRODUCT_EFFECT_NOT_RESOLVED";
}

function main(): void {
  const stats = read<Record<string, any>>("stage5_m183_resolution_stats.json");
  const pairsDoc = read<Record<string, any>>("stage5_m183_resolution_pairs.json");
  const tokens = read<Record<string, any>>("stage5_m183_token_pairs.json");
  const cost = read<Record<string, any>>("stage5_m183_cost_pairs.json");
  const orient = read<Record<string, any>>("stage5_m183_orientation_economics.json");
  const gold = read<Record<string, any>>("stage5_m183_gold_diagnostics.json");
  const causal = read<Record<string, any>>("stage5_m183_causal_attribution.json");
  const repos = read<Record<string, any>>("stage5_m183_repo_breakdown.json");
  const ctx = read<Record<string, any>>("stage5_m183_context_vs_whole_run.json");
  const witness = read<Record<string, any>>("stage5_m183_treatment_witness.json");
  const auth = read<Record<string, any>>("stage5_m183_cost_authorization.json");
  const protocolHash = read<Record<string, any>>("stage5_m183_protocol_hash.json");
  const equivalence = read<Record<string, any>>("stage5_m183_arm_equivalence.json");
  const manifest = read<Record<string, any>>("stage5_m183_sample_manifest.json");

  if (stats === null || tokens === null || cost === null) {
    throw new Error("run the outcomes and economics steps before the report");
  }

  const c = stats.counts;
  const resolutionV = stats.verdicts.resolution as string;
  const statisticalV = stats.verdicts.statistical as string;
  const tokenV = tokens.verdict as string;
  const costV = cost.verdict as string;
  const tokenVerdict = { REDUCTION_CONFIRMED: "WHOLE_RUN_TOKEN_REDUCTION_CONFIRMED", NEUTRAL: "WHOLE_RUN_TOKEN_USAGE_NEUTRAL", INCREASE_CONFIRMED: "WHOLE_RUN_TOKEN_INCREASE_CONFIRMED", MIXED: "WHOLE_RUN_TOKEN_EFFECT_MIXED", NOT_MEASURABLE: "WHOLE_RUN_TOKENS_NOT_MEASURABLE" }[tokenV] ?? "WHOLE_RUN_TOKENS_NOT_MEASURABLE";
  const costVerdict = { REDUCTION_CONFIRMED: "WHOLE_RUN_COST_REDUCTION_CONFIRMED", NEUTRAL: "WHOLE_RUN_COST_NEUTRAL", INCREASE_CONFIRMED: "WHOLE_RUN_COST_INCREASE_CONFIRMED", MIXED: "WHOLE_RUN_COST_EFFECT_MIXED", NOT_MEASURABLE: "WHOLE_RUN_COST_NOT_MEASURABLE" }[costV] ?? "WHOLE_RUN_COST_NOT_MEASURABLE";
  const product = productVerdict(resolutionV, costV);

  const wins = (causal?.classifications ?? []).filter((r: any) => r.winner === "VTRACE");
  const losses = (causal?.classifications ?? []).filter((r: any) => r.winner === "BASELINE");
  const causalV = wins.some((w: any) => w.causal === "VTRACE_CAUSALLY_PLAUSIBLE")
    ? "VTRACE_CAUSAL_UTILITY_EVIDENCE_OBSERVED"
    : wins.some((w: any) => w.causal === "VTRACE_CONTRIBUTORY") ? "VTRACE_CONTRIBUTORY_EVIDENCE_OBSERVED"
    : losses.some((l: any) => l.causal === "VTRACE_HARM_EVIDENCE") ? "VTRACE_HARM_EVIDENCE_OBSERVED"
    : (causal?.discordantPairs ?? 0) === 0 ? "CAUSALITY_NOT_MEASURABLE"
    : "NO_CLEAR_VTRACE_CAUSAL_UTILITY_EVIDENCE";

  const tailShare = cost.tails?.shareOfAggregateDeltaInTheseTenPairs;
  const economicsV = costV === "NOT_MEASURABLE" ? "ECONOMIC_MECHANISM_NOT_MEASURABLE"
    : typeof tailShare === "number" && Math.abs(tailShare) > 0.8 ? "TAILS_DOMINATE_ECONOMIC_EFFECT"
    : costV === "REDUCTION_CONFIRMED" ? "ORIENTATION_DISPLACES_DOWNSTREAM_WORK"
    : costV === "INCREASE_CONFIRMED" ? "ORIENTATION_OVERHEAD_NOT_RECOVERED"
    : "ECONOMIC_MECHANISM_MULTI_FACTOR";

  const vexpV = product === "QUALITY_AND_ECONOMICS_WIN" || product === "ECONOMIC_WIN_WITH_QUALITY_PARITY"
    ? "VEXP_CLASS_VALUE_PROPOSITION_SUPPORTED"
    : product === "QUALITY_GAIN_WITH_COST_PREMIUM" ? "VEXP_CLASS_VALUE_PROPOSITION_PARTIALLY_SUPPORTED"
    : product === "CURRENT_PRODUCT_EFFECT_NOT_RESOLVED" ? "VEXP_COMPARISON_NOT_LICENSED"
    : "VEXP_CLASS_VALUE_PROPOSITION_NOT_YET_SUPPORTED";

  const verdicts = {
    schemaVersion: "stage5.m183.verdicts.v1", milestone: "M183", workstream: "M183-F",
    resolution: resolutionV, statisticalResolution: statisticalV,
    wholeRunToken: tokenVerdict, wholeRunCost: costVerdict,
    product, vtraceCausality: causalV, economicsMechanism: economicsV, vexpClass: vexpV,
    productVerdictMapping: "computed by productVerdict() in run_stage5_m183_report.ts, written before any outcome existed; CURRENT_PRODUCT_NOT_COMPETITIVE is reachable",
  };
  writeFileSync(path.join(RESULTS, "stage5_m183_verdicts.json"), `${JSON.stringify(verdicts, null, 2)}\n`);

  // ── tables ──
  const outcomeTable = (pairsDoc?.pairs ?? []).map((p: any) => {
    const t = (tokens.perPair ?? []).find((x: any) => x.instanceId === p.instanceId);
    const k = (cost.tails?.largestTreatmentPremium ?? []).concat(cost.tails?.largestTreatmentSaving ?? [])
      .find((x: any) => x.instanceId === p.instanceId);
    const g = (gold?.rows ?? []).find((x: any) => x.instanceId === p.instanceId);
    return `| ${p.instanceId} | ${p.repo.split("/")[1]} | ${(p.armOrder ?? []).map((a: string) => a === "baseline" ? "A" : "B").join("→")} | ${p.baselineResolved ? "yes" : "no"} | ${p.treatmentResolved ? "yes" : "no"} | ${t === undefined ? "n/a" : i(t.delta)} | ${k === undefined ? "n/a" : n(k.costDelta)} | ${g === undefined ? "n/a" : (g.treatmentEditedFocus ? "yes" : "no")} |`;
  }).join("\n");

  const repoTable = Object.entries(repos?.repositories ?? {}).map(([repo, v]: [string, any]) =>
    `| ${repo} | ${v.pairs} | ${v.baselineResolved} | ${v.treatmentResolved} | $${n(v.aggregateBaselineCost)} | $${n(v.aggregateTreatmentCost)} |`).join("\n");

  const discordantTable = (causal?.classifications ?? []).map((r: any) =>
    `| ${r.instanceId} | ${r.winner} | ${r.focusCorrect ? "yes" : "no"} | ${r.orientationUsed ? "yes" : "no"} | ${r.classification} | ${r.mechanism} |`).join("\n");

  const tailTable = (cost.tails?.largestTreatmentPremium ?? []).concat(cost.tails?.largestTreatmentSaving ?? [])
    .map((t: any) => `| ${t.instanceId} | ${t.outcome} | $${n(t.baselineCost)} | $${n(t.treatmentCost)} | $${n(t.costDelta)} | ${i(t.tokenDelta)} |`).join("\n");

  const ctxTable = (ctx?.rows ?? []).map((r: any) =>
    `| ${r.concept} | ${typeof r.baselineDenominator === "number" ? i(r.baselineDenominator) : r.baselineDenominator} | ${typeof r.treatmentNumerator === "number" ? i(r.treatmentNumerator) : r.treatmentNumerator} | ${r.reduction ?? (typeof r.reductionPooledPercent === "number" ? `${n(r.reductionPooledPercent, 2)}% pooled / ${n(r.reductionMedianPairedPercent, 2)}% median paired` : "n/a")} |`).join("\n");

  const spent = (cost.aggregateBaseline ?? 0) + (cost.aggregateTreatment ?? 0);

  const report = `# M183 — Current-Product Live SWE-bench Requalification (final report)

\`\`\`text
M183 overall              ${stats.counts.validPairs === 0 ? "INCOMPLETE" : "see workstreams"}
A  protocol freeze        ${equivalence?.verdict === "ARM_DIFFERENCE_IS_TREATMENT_ACTIVATION_ONLY" ? "PASS" : "NOT PASS"}
B  sample and treatment   ${witness?.delivered ?? 0}/${manifest?.plannedPairs ?? 30} treatments delivered
C  paired live execution  ${stats.counts.validPairs} valid pairs
D  grading and outcomes   ${pairsDoc?.gradedPairs ?? 0} graded pairs
E  economics attribution  ${tokens.pairs} token pairs / ${cost.pairs} cost pairs
F  closure                this document

sample                    ${manifest?.plannedPairs ?? 30} planned pairs, ${stats.counts.validPairs} valid pairs
live spend                $${n(spent, 2)}   (authorised cap $${n(auth?.hardCapUsd, 2)})
baseline resolved         ${c.baselineResolved} / ${c.validPairs}
VTRACE   resolved         ${c.treatmentResolved} / ${c.validPairs}
both solved               ${c.bothSolved}
VTRACE-only wins          ${c.treatmentOnly}
baseline-only wins        ${c.baselineOnly}
neither solved            ${c.neither}

resolution verdict        ${verdicts.resolution}
statistical resolution    ${verdicts.statisticalResolution}
whole-run token verdict   ${verdicts.wholeRunToken}
whole-run cost verdict    ${verdicts.wholeRunCost}
product verdict           ${verdicts.product}
VTRACE-causality verdict  ${verdicts.vtraceCausality}
economics mechanism       ${verdicts.economicsMechanism}
VEXP-class verdict        ${verdicts.vexpClass}

baseline median tokens    ${i(tokens.baselineMedian)}
VTRACE   median tokens    ${i(tokens.treatmentMedian)}
paired median delta       ${i(tokens.pairedDelta?.median)}
pooled token reduction    ${n(tokens.reduction?.pooledPercent, 2)}%
baseline median cost      $${n(cost.baselineMedian)}
VTRACE   median cost      $${n(cost.treatmentMedian)}
paired median cost delta  $${n(cost.pairedDelta?.median)}
aggregate cost reduction  ${n(cost.reduction?.pooledPercent, 2)}%

orientation median tokens ${orient?.packetTokens?.median ?? "n/a"}
orientation p90 tokens    ${orient?.packetTokens?.p90 ?? "n/a"}
orientation max tokens    ${orient?.packetTokens?.max ?? "n/a"}

gold-file diagnostic      ${gold?.rates?.goldFileInOrientation ?? "n/a"} orientations name a gold file
gold-symbol diagnostic    ${gold?.rates?.goldSymbolInOrientation ?? "n/a"}
focus-use diagnostic      ${gold?.rates?.treatmentEditedFocus ?? "n/a"} treatment runs edited the focus file

product changed           NO
retrieval changed         NO
ranking changed           NO
fit contract changed      NO
ownership contract        NO
live work                 RUN
product HEAD              ${protocolHash?.productHead ?? "n/a"}
protocol hash             ${protocolHash?.protocolHash ?? "n/a"}
pushed                    NO
\`\`\`

## Required paired outcome table (§158)

| Task | Repo | Order | Baseline resolved | VTRACE resolved | Δ tokens | Δ cost | Orientation used? |
|---|---|---|---|---|---|---|---|
${outcomeTable || "| (no graded pairs) | | | | | | | |"}

## Required economics table (§159)

| Metric | Baseline | VTRACE | Paired / aggregate change |
|---|---|---|---|
| Resolved | ${c.baselineResolved} / ${c.validPairs} | ${c.treatmentResolved} / ${c.validPairs} | ${c.treatmentResolved - c.baselineResolved} tasks |
| Median input tokens | ${i(tokens.components?.inputTokens?.baselineMedian)} | ${i(tokens.components?.inputTokens?.treatmentMedian)} | ${i(tokens.components?.inputTokens?.pairedMedianDelta)} |
| Median output tokens | ${i(tokens.components?.outputTokens?.baselineMedian)} | ${i(tokens.components?.outputTokens?.treatmentMedian)} | ${i(tokens.components?.outputTokens?.pairedMedianDelta)} |
| Median cache-read tokens | ${i(tokens.components?.cacheReadTokens?.baselineMedian)} | ${i(tokens.components?.cacheReadTokens?.treatmentMedian)} | ${i(tokens.components?.cacheReadTokens?.pairedMedianDelta)} |
| Median cache-write tokens | ${i(tokens.components?.cacheCreationTokens?.baselineMedian)} | ${i(tokens.components?.cacheCreationTokens?.treatmentMedian)} | ${i(tokens.components?.cacheCreationTokens?.pairedMedianDelta)} |
| Median total tokens | ${i(tokens.baselineMedian)} | ${i(tokens.treatmentMedian)} | ${i(tokens.pairedDelta?.median)} |
| Aggregate total tokens | ${i(tokens.reduction?.pooledBaseline)} | ${i(tokens.reduction?.pooledTreatment)} | ${n(tokens.reduction?.pooledPercent, 2)}% |
| Median cost | $${n(cost.baselineMedian)} | $${n(cost.treatmentMedian)} | $${n(cost.pairedDelta?.median)} |
| Aggregate cost | $${n(cost.aggregateBaseline)} | $${n(cost.aggregateTreatment)} | ${n(cost.reduction?.pooledPercent, 2)}% |
| Median turns | ${i(tokens.turns?.baselineMedian)} | ${i(tokens.turns?.treatmentMedian)} | ${i(tokens.turns?.pairedMedianDelta)} |
| Cost per solved task | $${n(cost.costPerSolved?.baselineTotalPerSolved)} | $${n(cost.costPerSolved?.treatmentTotalPerSolved)} | — |

## Required discordant-pair table (§160)

| Task | Winner | Focus correct? | Orientation used? | Causal classification | Short mechanism |
|---|---|---|---|---|---|
${discordantTable || "| (no discordant pairs) | | | | | |"}

## Required cost-tail table (§161)

| Task | Outcome | Baseline | VTRACE | Δ cost | Δ tokens |
|---|---|---|---|---|---|
${tailTable || "| (no cost pairs) | | | | | |"}

## Required context-vs-whole-run table (§162)

| Reduction concept | Baseline denominator | VTRACE numerator | Reduction |
|---|---|---|---|
${ctxTable || "| (not computed) | | | |"}

## Repository breakdown (§128)

| Repository | Pairs | Baseline resolved | VTRACE resolved | Baseline cost | VTRACE cost |
|---|---|---|---|---|---|
${repoTable || "| (none) | | | | | |"}
`;
  writeFileSync(path.join(RESULTS, "stage5_m183_final_report.md"), report);

  console.log("M183-F verdicts");
  for (const [k, v] of Object.entries(verdicts)) {
    if (k.startsWith("schema") || k.endsWith("Mapping") || k === "milestone" || k === "workstream") continue;
    console.log(`  ${k.padEnd(24)} ${v}`);
  }
  console.log("\n  wrote results/stage5_m183_verdicts.json");
  console.log("  wrote results/stage5_m183_final_report.md");
}

main();
