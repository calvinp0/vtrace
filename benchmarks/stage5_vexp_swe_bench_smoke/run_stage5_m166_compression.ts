/**
 * M166-C — simulate compression over the twelve real payloads, before changing anything.
 *
 * §32: nothing is deleted from the product here. Each variant is an offline
 * transformation of a captured response, measured for token cost and audited for
 * what it would have cost in meaning. §43's primary decision is issued from the
 * numbers this produces, not from an impression that the output looks verbose.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  CompressionVariant,
  buildVariant,
  epistemicSafety,
  extractFacts,
  semanticPreservation,
} from "./m166Compression";
import { ResponseCategory, decompose } from "./m166Taxonomy";

const RESULTS = path.join(path.resolve("."), "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CAPTURE = path.join(RESULTS, "_m166_payloads");
const tokenAuthority = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m166_token_authority.json"), "utf8"));
const CHARS_PER_TOKEN: number = tokenAuthority.calibration.resultCharactersPerToken;
const toTokens = (characters: number): number => Math.round(characters / CHARS_PER_TOKEN);

const ORDER: readonly CompressionVariant[] = [
  CompressionVariant.FullCurrent,
  CompressionVariant.NoDuplicates,
  CompressionVariant.NoMachineDiagnostics,
  CompressionVariant.CompactProvenance,
  CompressionVariant.AgentMinimalSafe,
  CompressionVariant.EvidenceOnly,
];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

const files = readdirSync(CAPTURE).filter((f) => f.endsWith(".modelvisible.json")).sort();
const perVariant = new Map<CompressionVariant, { tokens: number[]; evidenceTokens: number[]; safetyFailures: string[][]; preservationFailures: string[][]; construction: string }>();
const cases: Record<string, unknown>[] = [];

for (const file of files) {
  const instanceId = file.replace(".modelvisible.json", "");
  const raw = readFileSync(path.join(CAPTURE, file), "utf8");
  const output = JSON.parse(raw).result.output;
  const full = extractFacts(output);
  const fullDecomposition = decompose(output);
  // The wrapper the runtime adds around result.output; charged to every variant
  // that would still be delivered as a tool envelope.
  const envelopeWrapper = raw.length - JSON.stringify(output).length;

  const row: Record<string, unknown> = { instanceId, deliveredCharacters: raw.length, deliveredTokens: toTokens(raw.length), variants: {} };
  for (const variant of ORDER) {
    const built = buildVariant(output, variant);
    const characters = built.modelFacingCharacters + (variant === CompressionVariant.AgentMinimalSafe || variant === CompressionVariant.EvidenceOnly ? 0 : envelopeWrapper);
    const safety = epistemicSafety(full, built.retained);
    const preservation = semanticPreservation(full, built.retained, built.modelFacingText);
    const evidenceCharacters = decompose(JSON.parse(JSON.stringify(output))).byCategory[ResponseCategory.RepositoryEvidence];

    const bucket = perVariant.get(variant) ?? { tokens: [], evidenceTokens: [], safetyFailures: [], preservationFailures: [], construction: built.construction };
    bucket.tokens.push(toTokens(characters));
    bucket.evidenceTokens.push(toTokens(evidenceCharacters));
    bucket.safetyFailures.push(safety.filter((s) => !s.passed).map((s) => s.check));
    bucket.preservationFailures.push(preservation.filter((p) => !p.preserved).map((p) => p.dimension));
    perVariant.set(variant, bucket);

    (row.variants as Record<string, unknown>)[variant] = {
      modelFacingCharacters: characters,
      modelFacingTokens: toTokens(characters),
      reductionPercent: Number((100 * (1 - characters / raw.length)).toFixed(1)),
      safetyFailures: safety.filter((s) => !s.passed).map((s) => `${s.check}: ${s.detail}`),
      preservationFailures: preservation.filter((p) => !p.preserved).map((p) => `${p.dimension}: ${p.detail}`),
    };
  }
  row.categoryTokens = Object.fromEntries(Object.entries(fullDecomposition.byCategory).map(([k, v]) => [k, toTokens(v)]));
  cases.push(row);
}

const deliveredMedian = median(cases.map((c) => c.deliveredTokens as number));
const variants = ORDER.map((variant) => {
  const bucket = perVariant.get(variant)!;
  const medianTokens = median(bucket.tokens);
  const allSafetyFailures = [...new Set(bucket.safetyFailures.flat())];
  const allPreservationFailures = [...new Set(bucket.preservationFailures.flat())];
  return {
    variant,
    construction: bucket.construction,
    medianModelFacingTokens: medianTokens,
    deltaVersusCurrent: medianTokens - deliveredMedian,
    reductionPercent: Number((100 * (1 - medianTokens / deliveredMedian)).toFixed(1)),
    evidenceTokensRetained: median(bucket.evidenceTokens),
    tasksWithSafetyFailure: bucket.safetyFailures.filter((f) => f.length > 0).length,
    tasksWithPreservationFailure: bucket.preservationFailures.filter((f) => f.length > 0).length,
    safetyFailureKinds: allSafetyFailures,
    preservationFailureKinds: allPreservationFailures,
    safe: allSafetyFailures.length === 0 && allPreservationFailures.length === 0,
    machineRequiredMetadataRetainedElsewhere: variant === CompressionVariant.FullCurrent
      ? "n/a"
      : "yes — the authoritative structured result is unchanged and still reaches CLI and programmatic MCP consumers; only the model-facing rendering is simulated smaller",
  };
});

const safest = variants.filter((v) => v.safe && v.variant !== CompressionVariant.FullCurrent).sort((a, b) => a.medianModelFacingTokens - b.medianModelFacingTokens)[0];
const categoryMedian = (category: ResponseCategory): number => median(cases.map((c) => (c.categoryTokens as Record<string, number>)[category]!));
const duplicateShare = categoryMedian(ResponseCategory.Duplicate) / deliveredMedian;
const transportShare = categoryMedian(ResponseCategory.TransportStructure) / deliveredMedian;
const provenanceShare = categoryMedian(ResponseCategory.Provenance) / deliveredMedian;
const diagnosticShare = categoryMedian(ResponseCategory.MachineDiagnostic) / deliveredMedian;

const savingIsMaterial = safest !== undefined && (deliveredMedian - safest.medianModelFacingTokens) >= 1000;
const primaryDecision = !savingIsMaterial
  ? (safest === undefined ? "MODEL_VISIBLE_TAX_NOT_SAFELY_COMPRESSIBLE" : "MODEL_VISIBLE_TAX_NOT_SAFELY_COMPRESSIBLE")
  : transportShare >= Math.max(duplicateShare, provenanceShare, diagnosticShare)
    ? "MODEL_VISIBLE_TAX_DOMINATED_BY_TRANSPORT"
    : duplicateShare >= Math.max(provenanceShare, diagnosticShare)
      ? "MODEL_VISIBLE_TAX_DOMINATED_BY_DUPLICATION"
      : provenanceShare >= diagnosticShare
        ? "MODEL_VISIBLE_TAX_DOMINATED_BY_PROVENANCE"
        : "MODEL_VISIBLE_TAX_SAFE_COMPRESSION_AVAILABLE";

writeFileSync(path.join(RESULTS, "stage5_m166_compression_variants.json"), JSON.stringify({
  schemaVersion: 1, milestone: "M166", workstream: "C",
  title: "Counterfactual model-facing representations — analysis variants, not product APIs",
  disclaimer: "§33: none of these is implemented as responseV2/compactV2/pipelineV2; they exist only to price a decision",
  variants: ORDER.map((v) => ({ variant: v, construction: perVariant.get(v)!.construction })),
}, null, 1));

writeFileSync(path.join(RESULTS, "stage5_m166_compression_simulation.json"), JSON.stringify({
  schemaVersion: 1, milestone: "M166", workstream: "C",
  title: "Token cost of each counterfactual, over the twelve payloads the agents received",
  tokenConversion: { charactersPerToken: Number(CHARS_PER_TOKEN.toFixed(3)), authority: "DERIVED_FROM_PROVIDER_REPORTED" },
  currentMedianModelFacingTokens: deliveredMedian,
  variants,
  compositionOfTheTax: {
    duplicatePercent: Number((100 * duplicateShare).toFixed(1)),
    transportStructurePercent: Number((100 * transportShare).toFixed(1)),
    machineDiagnosticPercent: Number((100 * diagnosticShare).toFixed(1)),
    provenancePercent: Number((100 * provenanceShare).toFixed(1)),
    repositoryEvidencePercent: Number((100 * categoryMedian(ResponseCategory.RepositoryEvidence) / deliveredMedian).toFixed(1)),
    agentUsefulControlPercent: Number((100 * categoryMedian(ResponseCategory.AgentUsefulControl) / deliveredMedian).toFixed(1)),
  },
  bestSafeVariant: safest ?? null,
  materialityTest: {
    rule: "§45 — a saving on the order of thousands of model-visible tokens per call is material; tens are not",
    medianSavingTokens: safest === undefined ? null : deliveredMedian - safest.medianModelFacingTokens,
    material: savingIsMaterial,
  },
  primaryDecision,
  secondaryCharacterizations: [
    duplicateShare >= 0.15 ? "MODEL_VISIBLE_TAX_DOMINATED_BY_DUPLICATION (secondary)" : null,
    transportShare >= 0.15 ? "MODEL_VISIBLE_TAX_DOMINATED_BY_TRANSPORT (secondary)" : null,
  ].filter((v): v is string => v !== null),
  cases,
}, null, 1));

writeFileSync(path.join(RESULTS, "stage5_m166_semantic_preservation.json"), JSON.stringify({
  schemaVersion: 1, milestone: "M166", workstream: "C",
  title: "What each counterfactual preserves (§34)",
  dimensions: ["primary context", "item paths", "symbols", "roles", "source text", "impact evidence", "skeletons", "neighborhood excerpts", "memory and flow statuses", "provenance for external consumers"],
  byVariant: variants.map((v) => ({ variant: v.variant, tasksWithPreservationFailure: v.tasksWithPreservationFailure, failureKinds: v.preservationFailureKinds })),
  cases: cases.map((c) => ({ instanceId: c.instanceId, variants: Object.fromEntries(Object.entries(c.variants as Record<string, any>).map(([k, v]) => [k, v.preservationFailures])) })),
}, null, 1));

writeFileSync(path.join(RESULTS, "stage5_m166_epistemic_safety.json"), JSON.stringify({
  schemaVersion: 1, milestone: "M166", workstream: "C",
  title: "Whether each counterfactual could let a bounded result read as an authoritative one (§36/§37/§38)",
  checks: ["component statuses distinguishable", "readiness truth", "degraded/result state", "absence semantics", "authority limitations", "material omission disclosed", "roles retained"],
  controlThatMustFail: {
    variant: CompressionVariant.EvidenceOnly,
    why: "a safety suite that never fails is not evidence that the other variants are safe",
    failed: variants.find((v) => v.variant === CompressionVariant.EvidenceOnly)!.safetyFailureKinds,
  },
  standingDefectFound: {
    what: "duplicate ACCOUNTING and duplicate REMOVAL are different operations",
    detail: "memory.durable.skipReason and memory.capsuleSurfaced.skipReason can carry the identical string; removing the second as a duplicate collapses NO_RELEVANT_EVIDENCE into NOT_OBSERVED",
    consequence: "control leaves are exempt from duplicate removal in every variant; the exemption is asserted by m166Compression.test.ts",
  },
  byVariant: variants.map((v) => ({ variant: v.variant, tasksWithSafetyFailure: v.tasksWithSafetyFailure, failureKinds: v.safetyFailureKinds })),
}, null, 1));

writeFileSync(path.join(RESULTS, "stage5_m166_token_deltas.json"), JSON.stringify({
  schemaVersion: 1, milestone: "M166", workstream: "C",
  title: "Token deltas per variant (§39)",
  currentMedian: deliveredMedian,
  rows: variants.map((v) => ({
    variant: v.variant,
    medianModelFacingTokens: v.medianModelFacingTokens,
    delta: v.deltaVersusCurrent,
    reductionPercent: v.reductionPercent,
    evidenceTokensRetained: v.evidenceTokensRetained,
    agentUsefulControlRetained: v.safetyFailureKinds.length === 0,
    machineRequiredMetadataRetainedElsewhere: v.machineRequiredMetadataRetainedElsewhere,
  })),
  noArbitraryTarget: "§39 — no target was set; the decision is made from measured deltas and safety, not from a percentage goal",
}, null, 1));

console.error(`[m166-C] current median ${deliveredMedian} tokens`);
for (const v of variants) console.error(`[m166-C]   ${v.variant.padEnd(24)} ${String(v.medianModelFacingTokens).padStart(6)}  ${String(v.reductionPercent).padStart(6)}%  safe=${v.safe}${v.safe ? "" : ` (${v.safetyFailureKinds.length + v.preservationFailureKinds.length} kinds)`}`);
console.error(`[m166-C] primary decision: ${primaryDecision}`);
