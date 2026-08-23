/**
 * M173-C — the pairwise table (§40) and the aggregate distributions (§41-§42).
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m173_pairwise.ts
 *
 * Writes `stage5_m173_pairwise_outcomes.json` and the markdown table the final
 * report embeds. §42 is the reason the per-task rows are printed in full rather
 * than summarised: a default-on product with a small median saving and a large
 * regression tail is not acceptable, and only the distribution shows that.
 *
 * Offline. Reads the M173-C artifacts only.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");

const economics = JSON.parse(
  readFileSync(path.join(RESULTS, "stage5_m173_task_economics.json"), "utf-8"),
) as Record<string, any>;

const usd = (value: number | null | undefined, digits = 4): string =>
  typeof value === "number" ? `$${value.toFixed(digits)}` : "—";
const num = (value: number | null | undefined): string =>
  typeof value === "number" ? String(value) : "—";
const solve = (value: boolean | null | undefined): string =>
  value === true ? "yes" : value === false ? "no" : "—";

const rows = economics.rows as Record<string, any>[];

const header = [
  "| Task | A solve | B solve | A cost | B cost | Δ cost | Orientation tokens | Economic class |",
  "| --- | :---: | :---: | ---: | ---: | ---: | ---: | --- |",
];

const body = rows.map((r) => {
  const a = r.outcome?.baselineResolved;
  const b = r.outcome?.compactResolved;
  const aCost = economicsCost(r.instanceId, "costBaselineUsd");
  const bCost = economicsCost(r.instanceId, "costCompactUsd");
  return `| ${r.instanceId} | ${solve(a)} | ${solve(b)} | ${usd(aCost)} | ${usd(bCost)} `
    + `| ${usd(r.deltaCostUsd)} | ${num(r.orientationPayloadTokens)} | ${r.economicClass} |`;
});

function economicsCost(instanceId: string, key: string): number | null {
  const ledger = JSON.parse(
    readFileSync(path.join(RESULTS, "stage5_m173_paired_ledger.json"), "utf-8"),
  ) as { pairs: Record<string, any>[] };
  const pair = ledger.pairs.find((p) => p.instanceId === instanceId);
  const value = pair?.[key];
  return typeof value === "number" ? value : null;
}

const table = [...header, ...body].join("\n");

const distributionTable = [
  "| Metric | n | median | mean | p10 | p90 | min | max | worse on |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...(economics.distributions as Record<string, any>[]).map((d) =>
    `| ${d.metric} | ${d.n} | ${num(d.median)} | ${num(d.mean)} | ${num(d.p10)} | ${num(d.p90)} `
    + `| ${num(d.min)} | ${num(d.max)} | ${d.positive}/${d.n} |`),
].join("\n");

const solves = economics.solves as Record<string, any>;
const aggregate = economics.aggregate as Record<string, any>;
const comparison = economics.comparison as Record<string, any>;

const markdown = `# M173 pairwise outcomes

**${solves.gradedPairs} graded pairs. Baseline ${solves.baselineResolved}, compact VTRACE ${solves.compactResolved}.**

${table}

## Solve-rate classification (§39)

\`\`\`text
shared success        ${solves.sharedSuccess}
baseline unique win   ${solves.baselineUniqueWin}   ${solves.baselineUniqueWinCases.join(", ") || "—"}
VTRACE unique win     ${solves.compactUniqueWin}   ${solves.compactUniqueWinCases.join(", ") || "—"}
shared failure        ${solves.sharedFailure}
\`\`\`

## Paired distributions (§41, §42)

${distributionTable}

## The M169 diagnostic, recomputed (§26, §83)

\`\`\`text
                                    M169 (rich)      M173 (compact)
orientation attributable cost       $${comparison.m169.pipelineAttributableCostUsdPerTask} / task    ${usd(aggregate.orientationAttributableCostUsdPerTask)} / task
investigation displaced             $${comparison.m169.investigationDisplacedPerTaskUsd} / task    ${usd(aggregate.netInvestigationDisplacedPreEditUsdPerTask)} / task
whole-run investigation net         $${comparison.m169.wholeRunInvestigationNetDisplacedUsd}          ${usd(aggregate.wholeRunInvestigationNetDisplacedUsd)}
aggregate economic ratio            ${comparison.m169.aggregateEconomicRatio}x               ${aggregate.aggregateEconomicRatio ?? "—"}x
\`\`\`

## Offline projection vs live actual (§82)

\`\`\`text
M172 projected orientation cost   $${comparison.m172Projection.projectedOrientationCostUsd}
M173 actual median                ${usd(comparison.projectionError?.m173ActualMedianUsd)}
ratio                             ${comparison.projectionError?.ratio ?? "—"}x
\`\`\`

${comparison.projectionError?.note ?? ""}

## Treatment delivery (§49)

\`\`\`text
delivered as the compact orientation   ${economics.treatmentDelivery.deliveredAsCompact}
fell back to the authoritative result  ${economics.treatmentDelivery.fellBackToAuthoritative}
no pipeline call at all                ${economics.treatmentDelivery.noPipelineCall}
\`\`\`
`;

writeFileSync(path.join(RESULTS, "stage5_m173_pairwise_outcomes.md"), markdown);
writeFileSync(path.join(RESULTS, "stage5_m173_pairwise_outcomes.json"), `${JSON.stringify({
  schemaVersion: "stage5.m173.pairwise.v1",
  milestone: "M173",
  workstream: "M173-C",
  solves,
  aggregate,
  comparison,
  distributions: economics.distributions,
  treatmentDelivery: economics.treatmentDelivery,
  rows,
}, null, 2)}\n`);

console.log(markdown);
