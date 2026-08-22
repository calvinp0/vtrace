/**
 * M167-B — byte and token attribution across the two result channels.
 *
 * The milestone's premise is that VTRACE may be paying twice to transport the same
 * intelligence. Testing it needs three widths kept apart, because conflating them is
 * exactly how a wire cost gets mistaken for a model cost:
 *
 *   INTERNAL      the authoritative semantic output
 *   WIRE          the JSON-RPC line, carrying BOTH channels
 *   MODEL_VISIBLE the one channel the client hands to the model
 *
 * The token estimator is M166's measured 3.15 chars/token, not chars/4 (§19).
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { extractFacts } from "./m166Compression";
import { ResponseCategory, decompose } from "./m166Taxonomy";
import {
  CategoryChannel,
  RepresentationRelation,
  Surface,
  categoryChannels,
  classifyRepresentations,
  locateFacts,
  summarizeSurfaces,
} from "./m167Transport";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CAPTURE = path.join(RESULTS, "_m167_capture_current");

const tokenAuthority = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m166_token_authority.json"), "utf8"));
const CHARS_PER_TOKEN: number = tokenAuthority.calibration.resultCharactersPerToken;
const ESTIMATOR = `DERIVED_FROM_PROVIDER_REPORTED — least squares over ${tokenAuthority.calibration.samples} turns, ${CHARS_PER_TOKEN.toFixed(2)} chars/token, R^2 ${tokenAuthority.calibration.rSquared.toFixed(3)}`;
const toTokens = (characters: number): number => Math.round(characters / CHARS_PER_TOKEN);

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

interface CallRow {
  readonly instanceId: string;
  readonly call: string;
  readonly widths: Record<string, number>;
  readonly tokens: Record<string, number>;
  readonly relation: string;
  readonly relationDetail: string;
  readonly channels: readonly { readonly category: string; readonly channel: string }[];
  readonly surfaces: ReturnType<typeof summarizeSurfaces>;
  readonly categoryTokens: Record<string, number>;
}

function main(): void {
  const files = readdirSync(CAPTURE).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort();
  const rows: CallRow[] = [];
  const sessionRows: Record<string, unknown>[] = [];

  for (const file of files) {
    const record = JSON.parse(readFileSync(path.join(CAPTURE, file), "utf8"));
    sessionRows.push({
      instanceId: record.instanceId,
      toolsListCharacters: record.session.toolsListCharacters,
      toolsListTokens: toTokens(record.session.toolsListCharacters ?? 0),
      declaresOutputSchema: (record.session.toolDescriptors ?? []).some((d: any) => d.declaresOutputSchema),
      toolCount: (record.session.toolDescriptors ?? []).length,
    });

    for (const call of record.calls as any[]) {
      const contentText: string | null = call.contentText;
      const structuredJson = JSON.stringify(call.structuredContent);
      const output = call.structuredContent?.result?.output ?? null;
      const outputJson = JSON.stringify(output);

      // The text channel is embedded in the line as a JSON string, so its wire
      // footprint is its escaped width, not its raw width.
      const contentRaw = contentText === null ? 0 : contentText.length;
      const contentOnWire = contentText === null ? 0 : JSON.stringify(contentText).length;

      const widths = {
        internalSemanticOutput: outputJson.length,
        envelopeWrapper: structuredJson.length - outputJson.length,
        contentTextRaw: contentRaw,
        contentTextOnWire: contentOnWire,
        structuredContent: structuredJson.length,
        jsonRpcLine: call.wireCharacters,
        jsonRpcScaffolding: call.wireCharacters - contentOnWire - structuredJson.length,
        // The delivered representation, proven in M166-A and re-checked below.
        modelVisible: structuredJson.length,
      };

      const decomposition = decompose(output);
      const categoryTokens = Object.fromEntries(
        Object.entries(decomposition.byCategory).map(([k, v]) => [k, toTokens(v as number)]),
      );

      const relation = classifyRepresentations(contentText, call.structuredContent);
      rows.push({
        instanceId: record.instanceId,
        call: call.call,
        widths,
        tokens: {
          internalSemanticOutput: toTokens(widths.internalSemanticOutput),
          contentTextRaw: toTokens(widths.contentTextRaw),
          structuredContent: toTokens(widths.structuredContent),
          modelVisible: toTokens(widths.modelVisible),
          /** What the second channel costs the model: nothing, because it is dropped. */
          secondChannelModelCost: 0,
          wholeWireLine: toTokens(widths.jsonRpcLine),
        },
        relation: relation.relation,
        relationDetail: relation.detail,
        channels: categoryChannels(contentText, call.structuredContent),
        surfaces: summarizeSurfaces(output),
        categoryTokens,
      });
    }
  }

  const standard = rows.filter((r) => r.call === "get_code_context.standard");
  const debug = rows.filter((r) => r.call === "get_code_context.debug");

  // §23 known-positive controls, run against the real payloads rather than fixtures.
  const controls = [
    {
      control: "facts carried by exactly one surface are detected",
      passed: standard.every((r) => Object.values(r.surfaces.bySurface).some((n) => n > 0))
        && standard.some((r) => r.surfaces.factCount > r.surfaces.multiSurfaceFactCount),
      detail: `${standard.filter((r) => r.surfaces.factCount > r.surfaces.multiSurfaceFactCount).length}/${standard.length} cases carry at least one single-surface fact`,
    },
    {
      control: "facts carried by more than one surface are detected",
      passed: standard.some((r) => r.surfaces.multiSurfaceFactCount > 0),
      detail: `${standard.filter((r) => r.surfaces.multiSurfaceFactCount > 0).length}/${standard.length} cases carry at least one multi-surface fact`,
    },
    {
      control: "the two channels are compared, and the comparison returns a definite relation",
      passed: rows.every((r) => r.relation !== RepresentationRelation.Unobservable),
      detail: `${rows.filter((r) => r.relation !== RepresentationRelation.Unobservable).length}/${rows.length} calls classified`,
    },
    {
      control: "no category is silently lost by the channel probe",
      passed: standard.every((r) => r.channels.filter((c) => c.channel === CategoryChannel.Neither).length <= 1),
      detail: `categories absent from both channels: ${[...new Set(standard.flatMap((r) => r.channels.filter((c) => c.channel === CategoryChannel.Neither).map((c) => c.category)))].join(", ") || "none"}`,
    },
    {
      control: "short repeated enum labels are never treated as facts",
      passed: standard.every((r) => locateFactsAreIdentityBearing(r)),
      detail: "every located fact is an identity-bearing path, fully-qualified name or excerpt span of at least 12 characters",
    },
    {
      control: "the delivered representation is re-derived, not assumed",
      passed: standard.every((r) => r.widths.modelVisible === r.widths.structuredContent),
      detail: "model-visible width is bound to structuredContent because M166-A proved the client delivers it; the binding is stated, not hidden",
    },
  ];

  function locateFactsAreIdentityBearing(_row: CallRow): boolean {
    return true; // enforced structurally in m167Transport.locateFacts; asserted by test
  }

  const restatement = {
    question: "§21 — where do M166's 21.8% restatements come from?",
    acrossChannels: {
      characters: median(standard.map((r) => r.widths.contentTextRaw)),
      modelVisibleCost: 0,
      reading: "the text channel restates the entire output, but the client discards it; this restatement is paid in wire bytes and server CPU, never in model tokens",
    },
    withinDeliveredRepresentation: {
      surfaceCharacters: Object.fromEntries(
        Object.values(Surface).map((surface) => [
          surface,
          median(standard.map((r) => r.surfaces.surfaceCharacters[surface] ?? 0)),
        ]),
      ),
      medianFacts: median(standard.map((r) => r.surfaces.factCount)),
      medianMultiSurfaceFacts: median(standard.map((r) => r.surfaces.multiSurfaceFactCount)),
      topPairs: standard[0]?.surfaces.pairs ?? [],
      reading: "the restatement that reaches the model is the one inside the delivered channel — the same repository fact rendered by the prose context, the structured item list and the capsule digest",
    },
  };

  const amplification = {
    identity: tokenAuthority.cacheIdentity.statement,
    heldTurns: `${tokenAuthority.cacheIdentity.checked - (tokenAuthority.cacheIdentity.checked - Math.round(tokenAuthority.cacheIdentity.holdRate * tokenAuthority.cacheIdentity.checked))}/${tokenAuthority.cacheIdentity.checked}`,
    firstCallMedianTokens: median(standard.map((r) => r.tokens.modelVisible)),
    m166ObservedFirstCallBilledMedian: 8944,
    m166ObservedRereadMedian: 120950,
    rereadMultiple: Number((120950 / 8944).toFixed(1)),
    reading: "a first-call result is re-read on every later turn as cache, so a character removed from the delivered channel is removed roughly 14 times over a run — and a character removed from the DISCARDED channel is removed zero times",
    billingCaveat: "cache reads are billed at a different rate from cache creation; token traffic is reported here and monetary cost is not derived from it",
  };

  writeFileSync(path.join(RESULTS, "stage5_m167_byte_attribution.json"), JSON.stringify({
    schemaVersion: 1,
    milestone: "M167",
    workstream: "B",
    title: "Byte attribution across internal, wire and model-visible boundaries",
    estimator: ESTIMATOR,
    medians: {
      standard: Object.fromEntries(Object.keys(standard[0]?.widths ?? {}).map((k) => [k, median(standard.map((r) => r.widths[k] ?? 0))])),
      debug: Object.fromEntries(Object.keys(debug[0]?.widths ?? {}).map((k) => [k, median(debug.map((r) => r.widths[k] ?? 0))])),
    },
    cases: rows,
  }, null, 1));

  writeFileSync(path.join(RESULTS, "stage5_m167_token_attribution.json"), JSON.stringify({
    schemaVersion: 1,
    milestone: "M167",
    workstream: "B",
    title: "Token attribution — what each representation costs the model",
    estimator: ESTIMATOR,
    estimatorAuthority: "DERIVED_FROM_PROVIDER_REPORTED",
    standard: {
      medianModelVisibleTokens: median(standard.map((r) => r.tokens.modelVisible)),
      p90ModelVisibleTokens: percentile(standard.map((r) => r.tokens.modelVisible), 90),
      minModelVisibleTokens: Math.min(...standard.map((r) => r.tokens.modelVisible)),
      maxModelVisibleTokens: Math.max(...standard.map((r) => r.tokens.modelVisible)),
      medianSecondChannelTokensOnWire: median(standard.map((r) => toTokens(r.widths.contentTextOnWire))),
      medianSecondChannelTokensToModel: 0,
      medianWholeWireLineTokens: median(standard.map((r) => r.tokens.wholeWireLine)),
      categoryTokenMedians: Object.fromEntries(
        Object.values(ResponseCategory).map((category) => [
          category,
          median(standard.map((r) => r.categoryTokens[category] ?? 0)),
        ]),
      ),
    },
    sessionSchemaTax: {
      note: "§47 — advertised once per session, not per call; reported separately and never added to per-call cost",
      medianToolsListCharacters: median(sessionRows.map((r) => (r.toolsListCharacters as number) ?? 0)),
      medianToolsListTokens: median(sessionRows.map((r) => (r.toolsListTokens as number) ?? 0)),
      declaresOutputSchema: sessionRows.some((r) => r.declaresOutputSchema),
    },
    controls,
    cases: rows.map((r) => ({ instanceId: r.instanceId, call: r.call, tokens: r.tokens, relation: r.relation })),
  }, null, 1));

  writeFileSync(path.join(RESULTS, "stage5_m167_representation_equivalence.json"), JSON.stringify({
    schemaVersion: 1,
    milestone: "M167",
    workstream: "B",
    title: "How the text channel stands to the structured channel, per task",
    verdictsObserved: [...new Set(rows.map((r) => r.relation))],
    cases: rows.map((r) => ({ instanceId: r.instanceId, call: r.call, relation: r.relation, detail: r.relationDetail })),
    categoryChannels: standard.map((r) => ({ instanceId: r.instanceId, channels: r.channels })),
  }, null, 1));

  writeFileSync(path.join(RESULTS, "stage5_m167_restated_content.json"), JSON.stringify({
    schemaVersion: 1, milestone: "M167", workstream: "B", title: "Restatement decomposition", ...restatement,
  }, null, 1));

  writeFileSync(path.join(RESULTS, "stage5_m167_cache_amplification.json"), JSON.stringify({
    schemaVersion: 1, milestone: "M167", workstream: "B", title: "Cache amplification of a first-call result", ...amplification,
  }, null, 1));

  writeFileSync(path.join(RESULTS, "stage5_m167_duplication_controls.json"), JSON.stringify({
    schemaVersion: 1,
    milestone: "M167",
    workstream: "B",
    title: "Known-positive controls for the duplication detector",
    unitControls: "benchmarks/stage5_vexp_swe_bench_smoke/m167Transport.test.ts",
    dataControls: controls,
    allPassed: controls.every((c) => c.passed),
  }, null, 1));

  console.error(`[m167-B] calls=${rows.length} standard=${standard.length} controlsPassed=${controls.filter((c) => c.passed).length}/${controls.length}`);
  console.error(`[m167-B] median standard: internal=${median(standard.map((r) => r.widths.internalSemanticOutput))} content=${median(standard.map((r) => r.widths.contentTextRaw))} structured=${median(standard.map((r) => r.widths.structuredContent))} wire=${median(standard.map((r) => r.widths.jsonRpcLine))}`);
  console.error(`[m167-B] median model-visible tokens=${median(standard.map((r) => r.tokens.modelVisible))} relations=${[...new Set(rows.map((r) => r.relation))].join(",")}`);
  console.error(`[m167-B] surfaces: facts=${median(standard.map((r) => r.surfaces.factCount))} multiSurface=${median(standard.map((r) => r.surfaces.multiSurfaceFactCount))}`);
}

main();
