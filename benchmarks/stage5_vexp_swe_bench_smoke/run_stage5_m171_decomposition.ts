/**
 * M171-A — decompose the captured model-facing contract.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m171_decomposition.ts
 *
 * Answers the four things §87 asks A to establish, and nothing else:
 *   1. what the model-facing contract actually IS  -> current_contract.json
 *   2. internal vs model-visible                   -> the debug/default delta
 *   3. semantic repetition                         -> semantic_fact_graph.json
 *   4. current default cost, re-derived            -> model_visible_decomposition.json
 *
 * Offline; reads only `results/_m171_capture/`. No product change.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ResponseCategory, decompose } from "./m166Taxonomy";
import {
  M166_CALIBRATION,
  extractFacts,
  median,
  modelVisibleTokens,
  percentile,
  projectedAttributableCostUsd,
  summarizeFactGraph,
  type SemanticFact,
} from "./m171Contract";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CAPTURE = path.join(RESULTS, "_m171_capture", "dev");

interface Captured {
  readonly instanceId: string;
  readonly task: string;
  readonly workspaceRevision: string | null;
  readonly error: string | null;
  readonly default: { structuredContent: Record<string, unknown> | null; contentTextCharacters: number } | null;
  readonly debug: { structuredContent: Record<string, unknown> | null; contentTextCharacters: number } | null;
  readonly repeat: { structuredContent: Record<string, unknown> | null; contentTextCharacters: number } | null;
}

const outputOf = (frame: Captured["default"]): Record<string, unknown> | null => {
  const structured = frame?.structuredContent;
  if (structured === null || structured === undefined) return null;
  const result = (structured as { result?: { output?: unknown } }).result;
  const output = result?.output;
  return output !== null && typeof output === "object" ? (output as Record<string, unknown>) : null;
};

/** The channel the model was handed: the whole envelope, per §21/§22. */
const modelVisibleCharacters = (frame: Captured["default"]): number =>
  frame?.structuredContent === null || frame?.structuredContent === undefined
    ? 0 : JSON.stringify(frame.structuredContent).length;

const cases = readdirSync(CAPTURE).filter((f) => f.endsWith(".json")).sort()
  .map((file) => JSON.parse(readFileSync(path.join(CAPTURE, file), "utf-8")) as Captured);

/** M169's per-case amplification, so an M171 dollar is an M169 dollar. */
const AMPLIFICATION: Readonly<Record<string, number>> = Object.freeze(Object.fromEntries(
  (JSON.parse(readFileSync(path.join(RESULTS, "stage5_m169_economic_classes.json"), "utf-8")) as {
    rows: { instanceId: string; pipelineAmplificationRequests: number }[];
  }).rows.map((row) => [row.instanceId, row.pipelineAmplificationRequests]),
));

// ---- 1. the contract, key by key ----------------------------------

interface KeyRow { readonly key: string; readonly medianCharacters: number; readonly shareOfResponse: number; readonly presentIn: number }

const topLevelKeys = new Set<string>();
for (const testCase of cases) {
  const output = outputOf(testCase.default);
  if (output !== null) for (const key of Object.keys(output)) topLevelKeys.add(key);
}

const keyRows: KeyRow[] = [...topLevelKeys].map((key) => {
  const sizes: number[] = [];
  let present = 0;
  for (const testCase of cases) {
    const output = outputOf(testCase.default);
    if (output === null) continue;
    if (!(key in output)) { sizes.push(0); continue; }
    present += 1;
    sizes.push(JSON.stringify(output[key] ?? null).length);
  }
  const medianSize = median(sizes);
  return { key, medianCharacters: medianSize, shareOfResponse: 0, presentIn: present };
}).sort((a, b) => b.medianCharacters - a.medianCharacters);

const medianTotal = median(cases.map((testCase) => modelVisibleCharacters(testCase.default)));
const keyRowsWithShare: KeyRow[] = keyRows.map((row) => ({ ...row, shareOfResponse: medianTotal === 0 ? 0 : row.medianCharacters / medianTotal }));

// ---- 2. internal vs model-visible ---------------------------------

const debugDelta = cases.map((testCase) => {
  const defaultCharacters = modelVisibleCharacters(testCase.default);
  const debugCharacters = modelVisibleCharacters(testCase.debug);
  const defaultOutput = outputOf(testCase.default);
  const debugOutput = outputOf(testCase.debug);
  const defaultKeys = defaultOutput === null ? [] : Object.keys(defaultOutput);
  const debugKeys = debugOutput === null ? [] : Object.keys(debugOutput);
  return {
    instanceId: testCase.instanceId,
    defaultCharacters,
    debugCharacters,
    debugMultiple: defaultCharacters === 0 ? null : debugCharacters / defaultCharacters,
    keysOnlyAtDebug: debugKeys.filter((key) => !defaultKeys.includes(key)),
    keysOnlyAtDefault: defaultKeys.filter((key) => !debugKeys.includes(key)),
  };
});

// ---- 3. semantic repetition ---------------------------------------

const factRows = cases.map((testCase) => {
  const output = outputOf(testCase.default);
  const facts: readonly SemanticFact[] = output === null ? [] : extractFacts(output);
  return { instanceId: testCase.instanceId, facts, summary: summarizeFactGraph(facts) };
});

const repetitionByIdentity = new Map<string, { kind: string; observations: number; surfaceCounts: number[] }>();
for (const row of factRows) {
  for (const fact of row.facts) {
    // Group by the SHAPE of the identity, not the instance-specific value, so that
    // "the lead pivot is asserted on N surfaces" is a statement about the contract.
    const shape = fact.identity.includes("#") ? `${fact.kind}:*${fact.identity.slice(fact.identity.indexOf("#"))}` : `${fact.kind}:${/[/.]/.test(fact.identity) ? "*" : fact.identity}`;
    const bucket = repetitionByIdentity.get(shape) ?? { kind: fact.kind, observations: 0, surfaceCounts: [] };
    bucket.observations += 1;
    bucket.surfaceCounts.push(fact.surfaces.length);
    repetitionByIdentity.set(shape, bucket);
  }
}

const repetitionTable = [...repetitionByIdentity.entries()]
  .map(([shape, bucket]) => ({
    factShape: shape,
    kind: bucket.kind,
    observations: bucket.observations,
    medianSurfaces: median(bucket.surfaceCounts),
    maxSurfaces: Math.max(...bucket.surfaceCounts),
  }))
  .sort((a, b) => b.medianSurfaces - a.medianSurfaces || b.observations - a.observations);

// ---- 4. cost, re-derived ------------------------------------------

const perCase = cases.map((testCase) => {
  const output = outputOf(testCase.default);
  const characters = modelVisibleCharacters(testCase.default);
  const tokens = modelVisibleTokens(characters);
  const amplification = AMPLIFICATION[testCase.instanceId] ?? null;
  const decomposition = output === null ? null : decompose(output);
  const byCategory = decomposition === null ? null : decomposition.byCategory as unknown as Record<string, number>;
  const evidence = byCategory === null ? 0 : byCategory[ResponseCategory.RepositoryEvidence] ?? 0;
  const outputCharacters = output === null ? 0 : JSON.stringify(output).length;
  return {
    instanceId: testCase.instanceId,
    modelVisibleCharacters: characters,
    outputCharacters,
    envelopeOverheadCharacters: characters - outputCharacters,
    modelVisibleTokens: tokens,
    amplificationRequests: amplification,
    projectedAttributableCostUsd: amplification === null ? null : projectedAttributableCostUsd(tokens, amplification),
    byCategory,
    evidenceCharacters: evidence,
    evidenceDensity: characters === 0 ? 0 : evidence / characters,
    facts: factRows.find((row) => row.instanceId === testCase.instanceId)?.summary ?? null,
  };
});

const tokensList = perCase.map((row) => row.modelVisibleTokens);
const costs = perCase.map((row) => row.projectedAttributableCostUsd).filter((cost): cost is number => cost !== null);

const M169_REFERENCE = Object.freeze({
  medianDeliveredPayloadTokens: 6383,
  medianPipelineAttributableCostUsd: 0.088416,
  medianBaselineInvestigationAllUsd: 0.052438,
  medianBaselineInvestigationPreEditUsd: 0.048256,
  source: "stage5_m169_economic_classes.json medians",
});

const write = (name: string, body: unknown): void => {
  writeFileSync(path.join(RESULTS, name), `${JSON.stringify(body, null, 1)}\n`);
  process.stdout.write(`wrote ${name}\n`);
};

write("stage5_m171_current_contract.json", {
  schemaVersion: "stage5.m171.current-contract.v1",
  milestone: "M171",
  workstream: "M171-A",
  title: "The actual model-facing run_pipeline contract, measured on structuredContent",
  channel: {
    measured: "result.structuredContent",
    authority: "M167 — the proven client's tool_result block carries the envelope; the pretty renderer and wire bytes are not the model-token surface",
    contentTextIsAlsoPresent: true,
    contentTextNote: "content[0].text is a near-identical duplicate on the wire and costs ~0 additional model tokens in the proven client (M167). It is NOT a place to hide the full result (§22).",
  },
  cases: cases.length,
  medianModelVisibleCharacters: medianTotal,
  topLevelKeys: keyRowsWithShare,
  debugDelta,
  observation: {
    detailDebugIsLarger: debugDelta.every((row) => row.debugMultiple === null || row.debugMultiple >= 1),
    medianDebugMultiple: median(debugDelta.map((row) => row.debugMultiple ?? 0)),
    keysExclusiveToDebug: [...new Set(debugDelta.flatMap((row) => row.keysOnlyAtDebug))],
  },
});

write("stage5_m171_semantic_fact_graph.json", {
  schemaVersion: "stage5.m171.semantic-fact-graph.v1",
  milestone: "M171",
  workstream: "M171-A",
  title: "How many distinct facts the default response asserts, and how many times it asserts each",
  method: {
    rule: "duplicate accounting != semantic duplicate (M166/M167 permanent invariant)",
    implementation: "named extractors in m171Contract.ts; a surface is a JSON path at which a NAMED extractor found the fact, never a string that happened to match",
    limitation: "an extractor can be wrong or incomplete; a fact this file does not model is not thereby absent from the response",
  },
  aggregate: {
    medianFacts: median(factRows.map((row) => row.summary.facts)),
    medianSurfaces: median(factRows.map((row) => row.summary.totalSurfaces)),
    medianRepetitionRate: median(factRows.map((row) => row.summary.repetitionRate)),
    medianMaxSurfacesForOneFact: median(factRows.map((row) => row.summary.maxSurfacesForOneFact)),
  },
  repetitionByFactShape: repetitionTable,
  perCase: factRows.map((row) => ({ instanceId: row.instanceId, ...row.summary })),
});

write("stage5_m171_model_visible_decomposition.json", {
  schemaVersion: "stage5.m171.model-visible-decomposition.v1",
  milestone: "M171",
  workstream: "M171-A",
  title: "Current default model-visible cost, independently re-derived (§87)",
  tokenAuthority: M166_CALIBRATION,
  pricingAuthority: {
    model: "payload written to cache once at the 1h rate, then re-read by every subsequent request",
    perCaseAmplificationSource: "stage5_m169_economic_classes.json rows[].pipelineAmplificationRequests",
    note: "PROJECTED ATTRIBUTABLE COST (§65). No provider telemetry exists for these offline calls.",
  },
  aggregate: {
    cases: perCase.length,
    modelVisibleCharacters: {
      median: median(perCase.map((row) => row.modelVisibleCharacters)),
      p90: percentile(perCase.map((row) => row.modelVisibleCharacters), 0.9),
      max: Math.max(...perCase.map((row) => row.modelVisibleCharacters)),
    },
    modelVisibleTokens: { median: median(tokensList), p90: percentile(tokensList, 0.9), max: Math.max(...tokensList) },
    projectedAttributableCostUsd: { median: median(costs), p90: percentile(costs, 0.9), max: Math.max(...costs) },
    evidenceDensity: {
      median: median(perCase.map((row) => row.evidenceDensity)),
      note: "REPOSITORY_EVIDENCE characters / total model-facing characters, M166 taxonomy",
    },
  },
  reconciliation: {
    m169Reference: M169_REFERENCE,
    m171MedianTokens: median(tokensList),
    deltaVsM169Tokens: median(tokensList) - M169_REFERENCE.medianDeliveredPayloadTokens,
    m171MedianProjectedCostUsd: median(costs),
    deltaVsM169CostUsd: median(costs) - M169_REFERENCE.medianPipelineAttributableCostUsd,
    reading: "M171 re-derives the current default independently, on fresh indexes and the frozen fixture task rather than the live agent's composed task. The two are close but not identical and neither is a correction of the other.",
  },
  perCase,
});
