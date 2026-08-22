/**
 * M166-B — reconcile M165's "~7,407 metadata against ~996 evidence tokens".
 *
 * §29 requires the original observation to be upgraded or corrected, not repeated.
 * It came from the product's own `responseBudget`, whose two figures mean:
 *
 *   estimated_model_visible_tokens = estimateTokens(productContext.modelVisibleContext)
 *   estimated_metadata_tokens      = estimateTokens(whole serialized output) - the above
 *
 * (src/mcp/responseEnvelope.ts buildAccounting). So "model visible" there is a
 * DOMAIN term meaning the rendered context section — not a claim about what the
 * model receives. M166-A measured what the model actually received: all of it.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ResponseCategory } from "./m166Taxonomy";

const RESULTS = path.join(path.resolve("."), "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CAPTURE = path.join(RESULTS, "_m166_payloads");
const read = (name: string): any => JSON.parse(readFileSync(path.join(RESULTS, name), "utf8"));

const parity = read("stage5_m165_context_pipeline_parity.json");
const decomposition = read("stage5_m166_12task_decomposition.json");
const tokenAuthority = read("stage5_m166_token_authority.json");
const responsePath = read("stage5_m166_response_path.json");

const median = (values: readonly number[]): number | null => {
  const sorted = [...values].filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

// M165's own figures, re-read from its artifact rather than retyped.
const m165Rows = parity.cases.filter((c: any) => c.getCodeContext?.responseBudget?.metadataTokens != null);
const m165Metadata = median(m165Rows.map((r: any) => r.getCodeContext.responseBudget.metadataTokens))!;
const m165Evidence = median(m165Rows.map((r: any) => r.getCodeContext.responseBudget.modelVisibleTokens))!;

// The same split recomputed on the payloads the M164 agents were actually handed.
const files = readdirSync(CAPTURE).filter((f) => f.endsWith(".modelvisible.json")).sort();
const observed = files.map((file) => {
  const raw = readFileSync(path.join(CAPTURE, file), "utf8");
  const output = JSON.parse(raw).result.output;
  const budget = output.responseBudget ?? {};
  return {
    instanceId: file.replace(".modelvisible.json", ""),
    productMetadataTokens: budget.estimated_metadata_tokens ?? null,
    productEvidenceTokens: budget.estimated_model_visible_tokens ?? null,
    modelVisibleCharacters: raw.length,
  };
});
const observedMetadata = median(observed.map((o) => o.productMetadataTokens as number))!;
const observedEvidence = median(observed.map((o) => o.productEvidenceTokens as number))!;

const charsPerToken: number = tokenAuthority.calibration.resultCharactersPerToken;
/** The product estimates at chars/4; the provider bills at the measured rate. */
const rescale = (productTokens: number): number => Math.round(productTokens * 4 / charsPerToken);

const categoryTokens = decomposition.aggregate.byCategory;
const evidenceTokens: number = categoryTokens[ResponseCategory.RepositoryEvidence].tokens.median;
const modelVisibleTokens: number = decomposition.aggregate.modelVisibleTokens.median;

const payload = {
  schemaVersion: 1,
  milestone: "M166",
  workstream: "B",
  title: "Where M165's 7,407 metadata tokens actually went",
  theOriginalObservation: {
    source: "stage5_m165_pipeline_added_value.json, from each response's own responseBudget block",
    medianMetadataTokens: m165Metadata,
    medianModelVisibleTokens: m165Evidence,
    quotedRatio: "~7.4 metadata tokens per evidence token",
    whatTheFieldsActuallyMean: {
      estimated_model_visible_tokens: "estimateTokens(productContext.modelVisibleContext) — the rendered context section only",
      estimated_metadata_tokens: "estimateTokens(whole serialized output) minus the above — everything else in the payload",
      estimate_method: "chars_div_4",
      producer: "src/mcp/responseEnvelope.ts buildAccounting",
    },
    theMisreadingItInvites: "'model visible' names a section of the response, not the set of tokens the model receives; M165 reported the figure correctly and its label invited the wrong inference",
  },
  onTheRunsTheAgentsActuallyPaidFor: {
    note: "M165 measured a fresh replay against the preserved workspaces; these are the twelve payloads the M164 agents were handed",
    medianProductMetadataTokens: observedMetadata,
    medianProductEvidenceTokens: observedEvidence,
    medianModelVisibleCharacters: median(observed.map((o) => o.modelVisibleCharacters)),
  },
  theAnswer: {
    question: "Of the ~7,407 metadata tokens: how many are internal only, transmitted, model visible, in model request traffic, billed?",
    ofTheMetadataTokens: {
      internalOnly: 0,
      internalOnlyBasis: "every field of result.output is serialized into the response; nothing is held back at the handler boundary",
      mcpTransmitted: observedMetadata,
      mcpTransmittedBasis: "transmitted twice per call — once in content[0].text and once in structuredContent (src/mcp/startServer.ts)",
      modelVisible: observedMetadata,
      modelVisibleBasis: "12/12 M164 tool_result payloads parse as complete JSON with all 22 output keys; nothing was truncated by the runtime",
      modelRequestTraffic: rescale(observedMetadata),
      modelRequestTrafficBasis: `the product estimates at chars/4; billed traffic runs at ${charsPerToken.toFixed(2)} chars/token, so the real figure is ~${(4 / charsPerToken).toFixed(2)}x its own estimate`,
      billedOrCacheRelevant: rescale(observedMetadata),
      billedOrCacheRelevantBasis: "charged once as cache-creation, then re-read on every later request in the run",
      unknown: [],
    },
    ofTheEvidenceTokens: {
      internalOnly: 0,
      mcpTransmitted: observedEvidence,
      modelVisible: observedEvidence,
      modelRequestTraffic: rescale(observedEvidence),
      billedOrCacheRelevant: rescale(observedEvidence),
      note: "the rendered context section is model-visible on the same terms as everything else; it was never the only model-visible part",
    },
  },
  correctionToTheHeadline: {
    m165Said: `median ~${m165Metadata} metadata tokens against ~${m165Evidence} model-visible evidence tokens`,
    m166Says: `the model received all ~${rescale(observedMetadata + observedEvidence)} tokens; of those, ~${evidenceTokens} are repository evidence and ~${modelVisibleTokens - evidenceTokens} are not`,
    directionOfTheCorrection: "the tax is real and larger than M165 stated, but its composition is different: M165's 'metadata' bundles duplication, transport scaffolding, machine diagnostics and provenance into one word",
    refinedComposition: Object.fromEntries(Object.values(ResponseCategory).map((category) => [
      category,
      { medianTokens: categoryTokens[category].tokens.median, shareOfModelVisiblePercent: categoryTokens[category].shareOfModelVisiblePercent.median },
    ])),
  },
  twoRatios: {
    m165NominalRatio: Number((m165Metadata / m165Evidence).toFixed(1)),
    m166MeasuredRatio: Number(((modelVisibleTokens - evidenceTokens) / evidenceTokens).toFixed(1)),
    whyTheyDiffer: "M165 counted the rendered section as the evidence; M166 credits evidence wherever it appears, including pivotNeighborhood excerpts and inspectFirst, and charges the second and third renderings of the same facts to DUPLICATE",
  },
  transportLayerFinding: {
    contentTextCharactersMedian: median(responsePath.cases.filter((c: any) => c.representations).map((c: any) => c.representations.transportContentTextCharacters)),
    structuredContentCharactersMedian: median(responsePath.cases.filter((c: any) => c.representations).map((c: any) => c.representations.transportStructuredContentCharacters)),
    reading: "the payload crosses the wire twice; the model is charged for one copy, and the copy it is charged for is the envelope-wrapped one",
  },
};

writeFileSync(path.join(RESULTS, "stage5_m166_m165_token_reconciliation.json"), JSON.stringify(payload, null, 1));
console.error(`[m166-B] M165 ratio ${payload.twoRatios.m165NominalRatio} -> M166 measured ratio ${payload.twoRatios.m166MeasuredRatio}`);
console.error(`[m166-B] metadata tokens: internal-only 0, model-visible ${observedMetadata}, billed ~${rescale(observedMetadata)}`);
