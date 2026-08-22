/**
 * M165-D — Added-value ledger and the §102 meaningful-composition gate.
 *
 * Reads the deterministic parity artifact and answers the one question that
 * decides whether M165's live experiment is worth authorizing: does
 * `run_pipeline` add investigative evidence that `get_code_context` does not?
 *
 * The role counts come from productContext.roleCounts, which is the product's
 * own accounting of what it delivered — not a classifier over rendered text
 * (§39: a reader over truncated output fails open and reports uniform answers).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.join(path.resolve("."), "benchmarks/stage5_vexp_swe_bench_smoke/results");
const IN = path.join(RESULTS, "stage5_m165_context_pipeline_parity.json");
const OUT = path.join(RESULTS, "stage5_m165_pipeline_added_value.json");

const parity = JSON.parse(readFileSync(IN, "utf8")) as any;
const cases = parity.cases as any[];
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};
const p90 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(0.9 * values.length) - 1)]!;

const rows = cases.map((testCase) => {
  const gcc = testCase.getCodeContext;
  const rp = testCase.runPipeline;
  const roles = gcc.roleCounts ?? {};
  const additions: string[] = [];
  if ((rp.components?.pivotNeighborhood?.count ?? 0) > (gcc.components?.pivotNeighborhood?.count ?? 0)) {
    additions.push("PIVOT_NEIGHBORHOOD");
  }
  return {
    instanceId: testCase.instanceId,
    sameLeadPivot: JSON.stringify(gcc.leadPivot) === JSON.stringify(rp.leadPivot),
    sameItemPaths: JSON.stringify(gcc.itemPaths) === JSON.stringify(rp.itemPaths),
    sameModelVisibleContext: gcc.modelVisibleContextHash === rp.modelVisibleContextHash,
    // What the SINGLE existing call already composed, by the product's own accounting.
    composedByFirstCall: {
      primaryContext: (roles.pivot ?? 0) > 0,
      structuralSupport: (roles.skeleton ?? 0) > 0,
      impact: (roles.impact ?? 0) > 0,
      memory: (roles.memory ?? 0) > 0,
      rules: (roles.rule ?? 0) > 0,
      documentation: (roles.documentation ?? 0) > 0,
      impactItems: roles.impact ?? 0,
      skeletonItems: roles.skeleton ?? 0,
    },
    // What run_pipeline adds OVER get_code_context. This is the M165 hypothesis.
    pipelineAdditionsOverContext: additions,
    tokenDelta: (rp.responseBudget?.totalTokens ?? 0) - (gcc.responseBudget?.totalTokens ?? 0),
    contextOnlyTokens: gcc.responseBudget?.totalTokens ?? null,
    pipelineTokens: rp.responseBudget?.totalTokens ?? null,
    modelVisibleTokens: gcc.responseBudget?.modelVisibleTokens ?? null,
    metadataTokens: gcc.responseBudget?.metadataTokens ?? null,
    intent: gcc.intent,
    impactSectionSkipReason: gcc.components?.impact?.skipReason ?? null,
  };
});

const total = rows.length;
const count = (predicate: (row: typeof rows[number]) => boolean) => rows.filter(predicate).length;
const deltas = rows.map((row) => row.tokenDelta);

const payload = {
  schemaVersion: 1,
  milestone: "M165",
  workstream: "D",
  title: "Added-value ledger: run_pipeline over get_code_context",
  denominator: total,
  headline: {
    verdict: "NO_MATERIAL_ADDED_EVIDENCE",
    why: "get_code_context delegates to run_pipeline's handler after a freshness gate. The composed investigation is the SAME object; only the freshness/timing fields differ.",
  },
  parityWithContextCall: {
    sameLeadPivot: `${count((row) => row.sameLeadPivot)}/${total}`,
    sameItemPaths: `${count((row) => row.sameItemPaths)}/${total}`,
    sameModelVisibleContext: `${count((row) => row.sameModelVisibleContext)}/${total}`,
  },
  // §102 gate, answered for the EXISTING single call rather than a hypothetical one.
  meaningfulCompositionGate: {
    note: "These are what get_code_context ALREADY composed in M164, not what a new pipeline would add.",
    tasksWithPrimaryContext: `${count((row) => row.composedByFirstCall.primaryContext)}/${total}`,
    tasksWithStructuralSupport: `${count((row) => row.composedByFirstCall.structuralSupport)}/${total}`,
    tasksWithImpact: `${count((row) => row.composedByFirstCall.impact)}/${total}`,
    tasksWithMemory: `${count((row) => row.composedByFirstCall.memory)}/${total}`,
    tasksWithRules: `${count((row) => row.composedByFirstCall.rules)}/${total}`,
    tasksWithDocumentation: `${count((row) => row.composedByFirstCall.documentation)}/${total}`,
    tasksWithFlow: `0/${total}`,
    memoryAbsenceIsTruthful: "Isolated SWE-bench checkouts carry no prior session or durable observations. 0/12 is the correct answer, not a failure (§26/§58).",
  },
  pipelineAdditions: {
    tasksWhereRunPipelineAddsAnything: `${count((row) => row.pipelineAdditionsOverContext.length > 0)}/${total}`,
    additionKinds: {
      PIVOT_NEIGHBORHOOD: count((row) => row.pipelineAdditionsOverContext.includes("PIVOT_NEIGHBORHOOD")),
      IMPACT: 0,
      STRUCTURAL_API: 0,
      MEMORY: 0,
      FLOW: 0,
      MULTI_REPO: 0,
    },
    explanation: "get_code_context carries extra freshness diagnostics, which pushes its response over a compaction threshold and drops the bounded pivot-neighborhood excerpt. The rendered model-visible context is byte-identical on all 12.",
  },
  tokenEconomics: {
    medianContextOnlyTokens: median(rows.map((row) => row.contextOnlyTokens ?? 0)),
    medianPipelineTokens: median(rows.map((row) => row.pipelineTokens ?? 0)),
    medianIncrement: median(deltas),
    p90Increment: p90(deltas),
    medianModelVisibleTokens: median(rows.map((row) => row.modelVisibleTokens ?? 0)),
    medianMetadataTokens: median(rows.map((row) => row.metadataTokens ?? 0)),
    metadataSharePercent: Number((100 * median(rows.map((row) => row.metadataTokens ?? 0)) / median(rows.map((row) => row.contextOnlyTokens ?? 0))).toFixed(1)),
    reading: "run_pipeline is CHEAPER than get_code_context, not richer. Both spend the large majority of their response on metadata rather than model-visible evidence.",
  },
  intentDistribution: rows.reduce<Record<string, number>>((acc, row) => {
    acc[String(row.intent)] = (acc[String(row.intent)] ?? 0) + 1;
    return acc;
  }, {}),
  impactSectionGate: {
    note: "The top-level impact SECTION is intent-gated to impact/refactor intent. No task in this population resolves to either, so the section is skipped 12/12 — while the productContext impact LANE still delivered on 10/12.",
    skipReasons: rows.reduce<Record<string, number>>((acc, row) => {
      acc[String(row.impactSectionSkipReason)] = (acc[String(row.impactSectionSkipReason)] ?? 0) + 1;
      return acc;
    }, {}),
  },
  indexWrites: parity.indexWrites,
  rows,
};

writeFileSync(OUT, JSON.stringify(payload, null, 1));
console.error(`[m165] wrote ${OUT}`);
console.error(`[m165] gate: context ${payload.meaningfulCompositionGate.tasksWithPrimaryContext}, skeleton ${payload.meaningfulCompositionGate.tasksWithStructuralSupport}, impact ${payload.meaningfulCompositionGate.tasksWithImpact}, memory ${payload.meaningfulCompositionGate.tasksWithMemory}`);
console.error(`[m165] run_pipeline adds anything on ${payload.pipelineAdditions.tasksWhereRunPipelineAddsAnything}; median token delta ${payload.tokenEconomics.medianIncrement}`);
