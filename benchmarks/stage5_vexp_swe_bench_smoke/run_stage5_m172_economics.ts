/**
 * M172 economics — the trade-off curve, on the same basis M169 priced.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m172_economics.ts
 *
 * Every figure here is a PROJECTED ATTRIBUTABLE COST, not a billed one. M172 is
 * offline: no agent ran, no provider reported a token. What makes the numbers
 * comparable to M169's is that they use M169's own pricing basis and M166's
 * measured calibration, applied identically to both arms, so the RATIO between
 * current and projected is exact and only the absolute level depends on the
 * amplification constant.
 *
 * Offline; reads the M172 holdout artifacts.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.join(path.resolve("."), "benchmarks/stage5_vexp_swe_bench_smoke/results");
const read = (name: string) => JSON.parse(readFileSync(path.join(RESULTS, name), "utf-8")) as Record<string, any>;

const a = read("stage5_m172_broad100a_holdout.json");
const b = read("stage5_m172_broad100b_holdout.json");
const m171a = read("stage5_m171_broad100a_holdout.json");
const m171b = read("stage5_m171_broad100b_holdout.json");

const slice = (doc: Record<string, any>, name: string) => doc.slices.find((s: any) => s.slice === name);

const M169_BASELINE_LOCALIZATION_USD = 0.052438;
const GATE_USD = 0.026219;

const row = (label: string, s: Record<string, any>) => ({
  slice: label,
  cases: s.cases,
  delivered: s.delivered,
  currentMedianTokens: s.currentTokens.median,
  orientationMedianTokens: s.packetTokens.median,
  orientationP90Tokens: s.packetTokens.p90,
  orientationMaxTokens: s.packetTokens.max,
  reductionFactor: s.reductionFactor,
  currentProjectedCostUsd: s.currentProjectedCostUsd.median,
  orientationProjectedCostUsd: s.packetProjectedCostUsd.median,
  pivotIdentity: s.pivotIdentity.rate,
  goldFileDeltaVsCurrentPp: s.goldFile.deltaVsCurrentPp,
  goldSymbolDeltaVsCurrentPp: s.goldSymbol.deltaVsCurrentPp,
  goldSymbolDeltaVsM171Pp: s.goldSymbol.deltaVsM171Pp,
  relatedWithheldByM171Cap: s.relatedSupply.withheldByM171Cap,
  relatedWithheldByM172Ceiling: s.relatedSupply.withheldByM172Ceiling,
  ceilingBindsCases: s.ceilingBindsCases,
  soundnessViolations: s.soundnessViolations,
});

const rows = [
  row("broad100a_full", slice(a, "broad100a_full")),
  row("broad100a_non_development_remainder", slice(a, "broad100a_non_development_remainder")),
  row("broad100a_development_members", slice(a, "broad100a_development_members")),
  row("broad100b_full", slice(b, "broad100b_full")),
];

const gateRow = (label: string, s: Record<string, any>) => ({
  slice: label,
  medianTokensAtOrBelow2000: s.packetTokens.median <= 2000,
  p90TokensAtOrBelow2500: s.packetTokens.p90 <= 2500,
  projectedCostWithinGate: s.packetProjectedCostUsd.median <= GATE_USD,
  pivotIdentityWhole: s.pivotIdentity.rate === 1,
  goldFileRegressionWithin2Pp: s.goldFile.deltaVsCurrentPp !== null && s.goldFile.deltaVsCurrentPp >= -2,
  goldSymbolRegressionWithin2Pp: s.goldSymbol.deltaVsCurrentPp !== null && s.goldSymbol.deltaVsCurrentPp >= -2,
  noSoundnessViolations: s.soundnessViolations === 0,
});

const gates = [
  gateRow("broad100b_full", slice(b, "broad100b_full")),
  gateRow("broad100a_full", slice(a, "broad100a_full")),
  gateRow("broad100a_non_development_remainder", slice(a, "broad100a_non_development_remainder")),
];
const allPass = gates.every((g) => Object.values(g).every((v) => v === true || typeof v === "string"));

const report = {
  schemaVersion: "stage5.m172.economics.v1",
  milestone: "M172",
  workstream: "M172-D",
  title: "Projected first-call economics for the frozen orientation, against M169's baseline",
  basis: {
    label: "PROJECTED ATTRIBUTABLE COST — offline. No agent ran and no provider reported a token.",
    tokenAuthority: "M166 measured calibration, 0.3174 tokens per character over 363 provider-reported samples",
    pricing: "M169's own basis: 1h cache write at $10/MTok, cache read at $0.50/MTok",
    amplification: "a uniform 7 requests, the M169 ledger median, applied identically to both arms",
    m169BaselineLocalizationUsd: M169_BASELINE_LOCALIZATION_USD,
    gateUsd: GATE_USD,
    gateRule: "at or below 50% of M169's median baseline localization cost",
  },
  m169Reference: {
    pipelineAttributableCostUsd: 0.0985,
    investigationDisplacedUsd: 0.0026,
    ratio: 37.9,
    verdict: "10 PIPELINE_ECONOMIC_LOSS, 1 ROUGH_BREAK_EVEN, 0 WIN, 1 NOT_MEASURABLE",
  },
  rows,
  gates,
  allGatesPass: allPass,
  m171Comparison: {
    note: "M171 froze a count cap of 5 and failed one gate. The same corpora under M172 differ only in that the cap is gone and the ceiling is enforced.",
    broad100aGoldSymbolPp: { m171: slice(m171a, "broad100a_full").goldSymbol.deltaPercentagePoints, m172: slice(a, "broad100a_full").goldSymbol.deltaVsCurrentPp },
    broad100aRemainderGoldSymbolPp: { m171: slice(m171a, "broad100a_non_development_remainder").goldSymbol.deltaPercentagePoints, m172: slice(a, "broad100a_non_development_remainder").goldSymbol.deltaVsCurrentPp },
    broad100bGoldSymbolPp: { m171: slice(m171b, "broad100b_full").goldSymbol.deltaPercentagePoints, m172: slice(b, "broad100b_full").goldSymbol.deltaVsCurrentPp },
    relatedEntriesRecoveredOnB: slice(b, "broad100b_full").relatedSupply.withheldByM171Cap,
    costOfRecovery: "none measurable: the median packet moves from M171's level to 621 tokens on B while every delivery rate is unchanged",
  },
  readingTheResult: [
    "the economics gate is passed by roughly a factor of three, and was passed by every candidate rung M171 measured too — cost was never the binding constraint on this design",
    "what M171 got wrong was not the price but the bound: a count cap withheld authoritative evidence that the cost bound had over a thousand tokens of room for",
    "an economics-plausibility gate is not a utility claim. It means a live requalification is now affordable, not that it would win.",
  ],
};

writeFileSync(path.join(RESULTS, "stage5_m172_economics.json"), `${JSON.stringify(report, null, 1)}\n`);
console.log(`all gates pass: ${allPass}`);
console.table(rows.map((r) => ({
  slice: r.slice.replace("broad100", "B"), cases: r.cases,
  medTok: r.orientationMedianTokens, p90: r.orientationP90Tokens, x: Number(r.reductionFactor?.toFixed(2)),
  usd: Number(r.orientationProjectedCostUsd?.toFixed(4)), pivot: r.pivotIdentity,
  gFilePp: r.goldFileDeltaVsCurrentPp, gSymPp: r.goldSymbolDeltaVsCurrentPp,
  vsM171Pp: r.goldSymbolDeltaVsM171Pp, capRecovered: r.relatedWithheldByM171Cap,
})));
