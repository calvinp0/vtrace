/**
 * M166-B — decompose the twelve model-facing responses the M164 agents actually paid for.
 *
 * The inputs are the tool_result strings recovered from the M164 transcripts, not a
 * fresh replay: those are the payloads whose token cost M166-A measured, and no
 * other artefact can claim to be what the model was handed.
 *
 * Characters are converted to tokens at the rate M166-A calibrated against real
 * billed traffic, and every reported token figure carries that authority. The
 * product's own chars/4 estimate is reported alongside, never instead.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ResponseCategory, type Decomposition, decompose, detectorControls } from "./m166Taxonomy";

const RESULTS = path.join(path.resolve("."), "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CAPTURE = path.join(RESULTS, "_m166_payloads");

const tokenAuthority = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m166_token_authority.json"), "utf8"));
const CHARS_PER_TOKEN: number = tokenAuthority.calibration.resultCharactersPerToken;

const toTokens = (characters: number): number => Math.round(characters / CHARS_PER_TOKEN);

function stat(values: readonly number[]) {
  if (values.length === 0) return { median: null, p90: null, mean: null, min: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2),
    p90: sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)]!,
    mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

function main(): void {
  const files = existsSync(CAPTURE) ? readdirSync(CAPTURE).filter((f) => f.endsWith(".modelvisible.json")).sort() : [];
  const rows: Record<string, unknown>[] = [];
  const decompositions: Decomposition[] = [];

  for (const file of files) {
    const instanceId = file.replace(".modelvisible.json", "");
    const raw = readFileSync(path.join(CAPTURE, file), "utf8");
    const envelope = JSON.parse(raw) as { result?: { output?: unknown } };
    const output = envelope.result?.output;
    if (output === undefined) continue;
    const result = decompose(output);
    decompositions.push(result);

    const envelopeWrapperCharacters = raw.length - JSON.stringify(output).length;
    const productBudget = (output as any).responseBudget ?? {};
    const categoryTokens = Object.fromEntries(
      Object.entries(result.byCategory).map(([category, characters]) => [category, toTokens(characters)]),
    );
    const evidenceTokens = categoryTokens[ResponseCategory.RepositoryEvidence]!;
    const modelVisibleTokens = toTokens(raw.length);

    rows.push({
      instanceId,
      modelVisibleCharacters: raw.length,
      outputCharacters: result.totalCharacters,
      envelopeWrapperCharacters,
      modelVisibleTokens,
      authority: "DERIVED_FROM_PROVIDER_REPORTED (chars converted at the M166-A calibrated rate)",
      categoryCharacters: result.byCategory,
      categoryTokens,
      evidenceSharePercent: Number((100 * evidenceTokens / modelVisibleTokens).toFixed(1)),
      nonEvidenceTokens: modelVisibleTokens - evidenceTokens,
      metadataToEvidenceRatio: evidenceTokens === 0 ? null : Number(((modelVisibleTokens - evidenceTokens) / evidenceTokens).toFixed(2)),
      productSelfReport: {
        estimated_model_visible_tokens: productBudget.estimated_model_visible_tokens ?? null,
        estimated_metadata_tokens: productBudget.estimated_metadata_tokens ?? null,
        estimated_total_response_tokens: productBudget.estimated_total_response_tokens ?? null,
        estimate_method: productBudget.estimate_method ?? null,
        note: "the product's 'model visible' means the rendered context field only; the runtime gave the model the whole payload",
      },
      topGroups: result.topGroups.slice(0, 12).map((g) => ({ ...g, tokens: toTokens(g.characters) })),
    });
  }

  const categories = Object.values(ResponseCategory);
  const aggregate = Object.fromEntries(categories.map((category) => {
    const chars = rows.map((r) => (r.categoryCharacters as Record<string, number>)[category] ?? 0);
    const tokens = rows.map((r) => (r.categoryTokens as Record<string, number>)[category] ?? 0);
    const shares = rows.map((r) => 100 * ((r.categoryTokens as Record<string, number>)[category] ?? 0) / (r.modelVisibleTokens as number));
    return [category, {
      characters: stat(chars),
      tokens: stat(tokens),
      shareOfModelVisiblePercent: { median: Number((stat(shares).median ?? 0).toFixed(1)), p90: Number((stat(shares).p90 ?? 0).toFixed(1)) },
    }];
  }));

  // §94. Offenders are named by group, after duplication has been charged out, so a
  // group is not credited with tokens another group already paid for.
  const groupTotals = new Map<string, { characters: number; category: ResponseCategory; tasks: number }>();
  for (const row of rows) {
    for (const group of row.topGroups as { group: string; characters: number; category: ResponseCategory }[]) {
      const existing = groupTotals.get(group.group) ?? { characters: 0, category: group.category, tasks: 0 };
      groupTotals.set(group.group, { characters: existing.characters + group.characters, category: group.category, tasks: existing.tasks + 1 });
    }
  }

  const payload = {
    schemaVersion: 1,
    milestone: "M166",
    workstream: "B",
    title: "What the twelve model-facing responses were actually made of",
    inputs: {
      source: "tool_result strings recovered from the M164 trigger-arm transcripts",
      cases: rows.length,
      whyNotAReplay: "these are the payloads whose billed cost M166-A measured; a fresh replay would be a different response against a different index",
    },
    tokenConversion: {
      charactersPerToken: Number(CHARS_PER_TOKEN.toFixed(3)),
      derivedFrom: "M166-A calibration against provider-reported cache-creation, R^2 " + tokenAuthority.calibration.rSquared.toFixed(3),
      productAssumption: 4,
      authority: "DERIVED_FROM_PROVIDER_REPORTED",
    },
    aggregate: {
      modelVisibleTokens: stat(rows.map((r) => r.modelVisibleTokens as number)),
      evidenceTokens: stat(rows.map((r) => (r.categoryTokens as Record<string, number>)[ResponseCategory.RepositoryEvidence]!)),
      nonEvidenceTokens: stat(rows.map((r) => r.nonEvidenceTokens as number)),
      metadataToEvidenceRatio: stat(rows.map((r) => r.metadataToEvidenceRatio as number)),
      duplicateFractionPercent: stat(rows.map((r) => Number((100 * (r.categoryTokens as Record<string, number>)[ResponseCategory.Duplicate]! / (r.modelVisibleTokens as number)).toFixed(1)))),
      transportFractionPercent: stat(rows.map((r) => Number((100 * (r.categoryTokens as Record<string, number>)[ResponseCategory.TransportStructure]! / (r.modelVisibleTokens as number)).toFixed(1)))),
      byCategory: aggregate,
    },
    topOffenderGroups: [...groupTotals.entries()]
      .map(([group, value]) => ({
        group,
        category: value.category,
        tasksPresent: value.tasks,
        medianTokens: Math.round(toTokens(value.characters) / Math.max(1, value.tasks)),
      }))
      .sort((a, b) => b.medianTokens - a.medianTokens)
      .slice(0, 20),
    detectorControls: detectorControls(decompositions),
    cases: rows,
  };
  writeFileSync(path.join(RESULTS, "stage5_m166_12task_decomposition.json"), JSON.stringify(payload, null, 1));

  const suspicious = payload.detectorControls.filter((c) => c.suspicious);
  console.error(`[m166-B] ${rows.length} decomposed; median model-visible ${payload.aggregate.modelVisibleTokens.median} tokens, evidence ${payload.aggregate.evidenceTokens.median}, ratio ${payload.aggregate.metadataToEvidenceRatio.median}`);
  console.error(`[m166-B] duplicate ${payload.aggregate.duplicateFractionPercent.median}% transport ${payload.aggregate.transportFractionPercent.median}%`);
  console.error(`[m166-B] suspicious detectors: ${suspicious.length === 0 ? "none" : suspicious.map((c) => c.category).join(", ")}`);
}

main();
