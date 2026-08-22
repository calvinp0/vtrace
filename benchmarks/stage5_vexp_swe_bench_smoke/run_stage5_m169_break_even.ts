/**
 * M169-D §32-§34 — the break-even test.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m169_break_even.ts
 *
 * Joins two things M169 measured separately and neither of which was computed
 * with this comparison in view:
 *
 *   how big the payload could have been      (M169-C, from displaced investigation)
 *   what the payload was actually made of    (M169-B, through M166's rule table)
 *
 * and asks the one question that discriminates H1 from H2: can the useful part
 * of the response fit under the budget the investigation it replaced would have
 * paid for?
 *
 * The dose ladder is reported alongside rather than used as the answer. §26
 * required a knob that varies the model-visible dose while holding retrieval
 * fixed, and no shipped argument does that — which is itself the finding.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");

const read = (name: string): any | null => {
  const file = path.join(RESULTS, name);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : null;
};

const economics = read("stage5_m169_economic_classes.json");
const composition = read("stage5_m169_payload_composition.json");
if (economics === null || composition === null) {
  throw new Error("run run_stage5_m169_economics.ts and run_stage5_m169_decomposition.ts first");
}

const compositionByInstance = new Map<string, any>();
for (const row of composition.perRun) {
  if (row.label?.startsWith("m168_vtrace_clean_") && row.parseStatus === "PARSED") {
    compositionByInstance.set(row.instanceId, row);
  }
}

/** Frozen in stage5_m169_plan.md before the ratio was computed (§33). */
const FIT_THRESHOLDS = Object.freeze({ comfortablyAtOrBelow: 0.75, narrowlyAtOrBelow: 1.0 });

const fitClass = (useful: number | null, budget: number | null): string => {
  if (useful === null || budget === null || budget <= 0) return "NOT_MEASURABLE";
  const ratio = useful / budget;
  if (ratio <= FIT_THRESHOLDS.comfortablyAtOrBelow) return "YES_COMFORTABLY";
  if (ratio <= FIT_THRESHOLDS.narrowlyAtOrBelow) return "YES_NARROWLY";
  return "NO";
};

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(middle)]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const rows = economics.rows.map((row: any) => {
  const comp = compositionByInstance.get(row.instanceId) ?? null;
  const delivered = row.pipelinePayloadTokens as number | null;
  const evidenceShare = comp === null ? null : comp.evidenceShare as number;
  const controlShare = comp === null || comp.decomposedCharacters === 0
    ? null
    : (comp.byCategory.AGENT_USEFUL_CONTROL ?? 0) / comp.decomposedCharacters;

  const evidenceTokens = delivered === null || evidenceShare === null ? null : Math.round(delivered * evidenceShare);
  const evidencePlusControlTokens = delivered === null || evidenceShare === null || controlShare === null
    ? null
    : Math.round(delivered * (evidenceShare + controlShare));

  const primaryBudget = row.measurable ? (row.breakEvenPayloadTokens as number | null) : null;
  const generousBudget = row.measurable ? (row.breakEvenPayloadTokensGenerous as number | null) : null;

  return {
    instanceId: row.instanceId,
    measurable: row.measurable,
    deliveredPayloadTokens: delivered,
    evidenceShare,
    controlShare: controlShare === null ? null : Number(controlShare.toFixed(4)),
    evidenceTokens,
    evidencePlusControlTokens,
    breakEvenPayloadTokens: primaryBudget,
    breakEvenPayloadTokensGenerous: generousBudget,
    fitPrimaryEvidenceOnly: fitClass(evidenceTokens, primaryBudget),
    fitPrimaryEvidencePlusControl: fitClass(evidencePlusControlTokens, primaryBudget),
    fitGenerousEvidenceOnly: fitClass(evidenceTokens, generousBudget),
    fitGenerousEvidencePlusControl: fitClass(evidencePlusControlTokens, generousBudget),
    deliveredFitsGenerous: fitClass(delivered, generousBudget),
    economicClass: row.economicClass,
    economicClassGenerous: row.economicClassGenerous,
  };
});

const tally = (key: string): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[(row as any)[key]] = (counts[(row as any)[key]] ?? 0) + 1;
  return counts;
};

const measurable = rows.filter((r: any) => r.measurable);

const document = {
  schemaVersion: "stage5.m169.break-even.v1",
  milestone: "M169",
  workstream: "M169-D",
  fitThresholds: FIT_THRESHOLDS,
  fitThresholdProvenance: "frozen in stage5_m169_plan.md after both inputs existed but before their ratio was computed; the weaker blindness claim is stated there",
  usefulPayloadDefinitions: {
    EVIDENCE_ONLY: "REPOSITORY_EVIDENCE characters, as classified by M166's frozen rule table",
    EVIDENCE_PLUS_CONTROL: "REPOSITORY_EVIDENCE + AGENT_USEFUL_CONTROL — §28 forbids counting truthfulness as fat",
  },
  denominators: economics.denominator,
  medians: {
    deliveredPayloadTokens: median(measurable.map((r: any) => r.deliveredPayloadTokens ?? 0)),
    evidenceTokens: median(measurable.map((r: any) => r.evidenceTokens ?? 0)),
    evidencePlusControlTokens: median(measurable.map((r: any) => r.evidencePlusControlTokens ?? 0)),
    breakEvenPayloadTokens: median(measurable.map((r: any) => r.breakEvenPayloadTokens ?? 0)),
    breakEvenPayloadTokensGenerous: median(measurable.map((r: any) => r.breakEvenPayloadTokensGenerous ?? 0)),
    evidenceSharePercent: Number((100 * median(rows.map((r: any) => r.evidenceShare ?? 0))).toFixed(1)),
    controlSharePercent: Number((100 * median(rows.map((r: any) => r.controlShare ?? 0))).toFixed(1)),
  },
  fitCounts: {
    primaryEvidenceOnly: tally("fitPrimaryEvidenceOnly"),
    primaryEvidencePlusControl: tally("fitPrimaryEvidencePlusControl"),
    generousEvidenceOnly: tally("fitGenerousEvidenceOnly"),
    generousEvidencePlusControl: tally("fitGenerousEvidencePlusControl"),
    generousDeliveredAsShipped: tally("deliveredFitsGenerous"),
  },
  rows,
};

writeFileSync(path.join(RESULTS, "stage5_m169_break_even_budget.json"), `${JSON.stringify(document, null, 2)}\n`);
console.log("wrote stage5_m169_break_even_budget.json\n");

console.log(`${"instance".padEnd(32)} ${"deliv".padStart(6)} ${"evid".padStart(5)} ${"ev+ctl".padStart(6)} ${"BE".padStart(6)} ${"BE-gen".padStart(6)}  ${"fit(primary)".padEnd(16)} ${"fit(generous)".padEnd(16)}`);
for (const row of rows as any[]) {
  console.log(
    `${row.instanceId.padEnd(32)} ${String(row.deliveredPayloadTokens ?? "-").padStart(6)} ${String(row.evidenceTokens ?? "-").padStart(5)} `
    + `${String(row.evidencePlusControlTokens ?? "-").padStart(6)} ${String(row.breakEvenPayloadTokens ?? "-").padStart(6)} `
    + `${String(row.breakEvenPayloadTokensGenerous ?? "-").padStart(6)}  ${row.fitPrimaryEvidencePlusControl.padEnd(16)} ${row.fitGenerousEvidencePlusControl.padEnd(16)}`,
  );
}
console.log(`\nmedian delivered ${document.medians.deliveredPayloadTokens} tok | evidence ${document.medians.evidenceTokens} | evidence+control ${document.medians.evidencePlusControlTokens}`);
console.log(`median break-even ${document.medians.breakEvenPayloadTokens} tok (primary) / ${document.medians.breakEvenPayloadTokensGenerous} tok (generous)`);
console.log(`\nfit, evidence+control vs primary break-even:  ${JSON.stringify(tally("fitPrimaryEvidencePlusControl"))}`);
console.log(`fit, evidence+control vs generous break-even: ${JSON.stringify(tally("fitGenerousEvidencePlusControl"))}`);
console.log(`fit, delivered as shipped vs generous:        ${JSON.stringify(tally("deliveredFitsGenerous"))}`);
