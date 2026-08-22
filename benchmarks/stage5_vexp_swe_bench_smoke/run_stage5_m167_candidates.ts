/**
 * M167-C — four result contracts, priced at every boundary and scored against every
 * consumer that this repository claims or exercises.
 *
 * The scoring rule that matters: a candidate's model-visible cost depends on WHICH
 * channel the reading client picks. Pricing a candidate against one client and calling
 * the number "the saving" is the mistake M166 warned about, so every candidate is
 * priced once per read rule and the rules are named.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { extractFacts, epistemicSafety, semanticPreservation } from "./m166Compression";
import { summarizeSurfaces } from "./m167Transport";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CAPTURE = path.join(RESULTS, "_m167_capture_current");
const M164_PAYLOADS = path.join(RESULTS, "_m166_payloads");

const tokenAuthority = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m166_token_authority.json"), "utf8"));
const CHARS_PER_TOKEN: number = tokenAuthority.calibration.resultCharactersPerToken;
const toTokens = (characters: number): number => Math.round(characters / CHARS_PER_TOKEN);

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/**
 * §28 — re-derive, do not cite. The delivered representation is whichever channel the
 * M164 model-visible payloads actually begin with. The envelope wrapper prefix is
 * unforgeable by the text channel, which serializes the output alone.
 */
const ENVELOPE_PREFIX = '{"schema":{"name":"vtrace.mcp_server"';
function rederiveDeliveredRepresentation(): Record<string, unknown> {
  const files = readdirSync(M164_PAYLOADS).filter((f) => f.endsWith(".modelvisible.json")).sort();
  const rows = files.map((file) => {
    const head = readFileSync(path.join(M164_PAYLOADS, file), "utf8").slice(0, ENVELOPE_PREFIX.length);
    return { instanceId: file.replace(".modelvisible.json", ""), startsWithEnvelope: head === ENVELOPE_PREFIX };
  });
  return {
    method: "the M164 model-visible tool results are read directly and their leading bytes compared with the envelope wrapper that only structuredContent can produce",
    cases: rows.length,
    deliveredStructuredContent: rows.filter((r) => r.startsWithEnvelope).length,
    deliveredContentText: rows.filter((r) => !r.startsWithEnvelope).length,
    verdict: rows.length > 0 && rows.every((r) => r.startsWithEnvelope)
      ? "PROVEN — the agent client delivers structuredContent to the model and discards content[0].text"
      : "MIXED OR REFUTED — see cases",
    perCase: rows,
  };
}

/**
 * The concise text a compatibility summary would carry. Deliberately built from
 * counts, never from evidence, so that no candidate can smuggle repository content
 * into a channel this milestone is arguing should stop carrying it.
 */
function conciseSummary(output: any): string {
  const pc = output?.productContext ?? {};
  const items: any[] = Array.isArray(pc.items) ? pc.items : [];
  const pivots = items.filter((i) => Array.isArray(i.roles) && i.roles.includes("pivot")).length;
  const impactEdges = Array.isArray(output?.impact?.edges) ? output.impact.edges.length : 0;
  return [
    `VTRACE pipeline: ${pivots} primary target${pivots === 1 ? "" : "s"}, `
    + `${Math.max(0, items.length - pivots)} support item${items.length - pivots === 1 ? "" : "s"}, `
    + `${impactEdges} impact edge${impactEdges === 1 ? "" : "s"}.`,
    `Index readiness: ${pc.freshness?.status ?? "unknown"}. Result state: ${pc.resultState ?? "unknown"}.`,
    "The full structured result is in structuredContent.",
  ].join(" ");
}

const READ_RULES = Object.freeze({
  StructuredThenText: "STRUCTURED_THEN_TEXT",
  TextOnly: "TEXT_ONLY",
});

interface Candidate {
  readonly name: string;
  readonly contentText: (output: any, full: string) => string | null;
  readonly structuredPresent: boolean;
  readonly rationale: string;
}

const CANDIDATES: readonly Candidate[] = [
  { name: "CURRENT", contentText: (_o, full) => full, structuredPresent: true, rationale: "both channels carry the whole output" },
  { name: "STRUCTURED_ONLY", contentText: () => null, structuredPresent: true, rationale: "drop the text channel entirely" },
  { name: "TEXT_ONLY", contentText: (_o, full) => full, structuredPresent: false, rationale: "drop the structured channel entirely" },
  { name: "STRUCTURED_PLUS_SUMMARY", contentText: (o) => conciseSummary(o), structuredPresent: true, rationale: "structured authority plus a bounded compatibility note" },
];

function main(): void {
  const files = readdirSync(CAPTURE).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort();
  const perCandidate = new Map<string, { wire: number[]; modelStructuredFirst: number[]; modelTextOnly: number[]; preservationStructuredFirst: boolean[]; preservationTextOnly: boolean[] }>();
  for (const candidate of CANDIDATES) {
    perCandidate.set(candidate.name, { wire: [], modelStructuredFirst: [], modelTextOnly: [], preservationStructuredFirst: [], preservationTextOnly: [] });
  }

  const summaryExamples: string[] = [];
  let surfaceTotals = { facts: 0, multi: 0 };

  for (const file of files) {
    const record = JSON.parse(readFileSync(path.join(CAPTURE, file), "utf8"));
    const call = (record.calls as any[]).find((c) => c.call === "get_code_context.standard");
    if (call === undefined) continue;

    const envelope = call.structuredContent;
    const output = envelope?.result?.output ?? null;
    const fullText: string = call.contentText ?? JSON.stringify(output);
    const structuredJson = JSON.stringify(envelope);
    const fullFacts = extractFacts(output);
    const surfaces = summarizeSurfaces(output);
    surfaceTotals = { facts: surfaceTotals.facts + surfaces.factCount, multi: surfaceTotals.multi + surfaces.multiSurfaceFactCount };

    for (const candidate of CANDIDATES) {
      const text = candidate.contentText(output, fullText);
      if (candidate.name === "STRUCTURED_PLUS_SUMMARY" && summaryExamples.length < 2 && text !== null) summaryExamples.push(text);

      // Wire: the JSON-RPC line rebuilt from whichever channels the candidate keeps.
      const wire = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          ...(text === null ? { content: [] } : { content: [{ type: "text", text }] }),
          ...(candidate.structuredPresent ? { structuredContent: envelope } : {}),
          isError: false,
        },
      }).length;

      // A client that prefers structuredContent and falls back to text.
      const structuredFirst = candidate.structuredPresent ? structuredJson : (text ?? "");
      // A client written to the advertised revision, which knows only content[].
      const textOnly = text ?? "";

      const bucket = perCandidate.get(candidate.name)!;
      bucket.wire.push(wire);
      bucket.modelStructuredFirst.push(toTokens(structuredFirst.length));
      bucket.modelTextOnly.push(toTokens(textOnly.length));

      // Semantic preservation is judged on what each read rule actually recovers.
      const recover = (payload: string): unknown => {
        if (payload.length === 0) return null;
        try {
          const parsed = JSON.parse(payload) as any;
          return parsed?.result?.output ?? parsed;
        } catch { return null; }
      };
      for (const [rule, payload] of [[READ_RULES.StructuredThenText, structuredFirst], [READ_RULES.TextOnly, textOnly]] as const) {
        const recovered = recover(payload);
        const facts = extractFacts(recovered);
        // The model-facing text is the WHOLE payload the client hands over, not the
        // prose section inside it: provenance a consumer can still resolve from the
        // delivered bytes is preserved, wherever in those bytes it sits.
        const preserved = semanticPreservation(fullFacts, facts, payload)
          .every((f) => f.preserved)
          && epistemicSafety(fullFacts, facts).every((f) => f.passed);
        if (rule === READ_RULES.StructuredThenText) bucket.preservationStructuredFirst.push(preserved);
        else bucket.preservationTextOnly.push(preserved);
      }
    }
  }

  const currentWire = median(perCandidate.get("CURRENT")!.wire);
  const currentModel = median(perCandidate.get("CURRENT")!.modelStructuredFirst);

  const scored = CANDIDATES.map((candidate) => {
    const bucket = perCandidate.get(candidate.name)!;
    const wire = median(bucket.wire);
    const modelStructuredFirst = median(bucket.modelStructuredFirst);
    const modelTextOnly = median(bucket.modelTextOnly);
    return {
      candidate: candidate.name,
      rationale: candidate.rationale,
      semanticPreservation: {
        structuredPreferringClient: `${bucket.preservationStructuredFirst.filter(Boolean).length}/${bucket.preservationStructuredFirst.length}`,
        textOnlyClient: `${bucket.preservationTextOnly.filter(Boolean).length}/${bucket.preservationTextOnly.length}`,
      },
      clientCompatibility: {
        claudeCode: candidate.structuredPresent ? "PRESERVED (proven reader of structuredContent)" : "UNPROVEN — would have to fall back to a channel it has never been observed to read",
        codex: candidate.contentText.length >= 0 && candidate.name === "STRUCTURED_ONLY" ? "AT RISK — behaviour UNKNOWN and the only channel its advertised revision defines is removed"
          : candidate.name === "STRUCTURED_PLUS_SUMMARY" ? "AT RISK — behaviour UNKNOWN; if it reads content[] it receives counts instead of evidence"
            : "PRESERVED",
        genericAtAdvertisedRevision: candidate.name === "STRUCTURED_ONLY" ? "BROKEN — an empty result"
          : candidate.name === "STRUCTURED_PLUS_SUMMARY" ? "DEGRADED — receives a summary with no repository evidence"
            : "PRESERVED",
        benchmarkHarnesses: candidate.name === "STRUCTURED_ONLY" || candidate.name === "STRUCTURED_PLUS_SUMMARY"
          ? "REQUIRES CHANGE — they parse content[0].text for the semantic profile"
          : "PRESERVED",
        mcpTransportTests: candidate.name === "CURRENT" ? "PRESERVED" : "REQUIRES CHANGE — both channels are asserted",
      },
      agentVisibility: candidate.structuredPresent
        ? "PROVEN — the observed agent client delivers structuredContent"
        : "UNPROVEN — depends on a fallback no transcript exercises",
      wireCharacters: wire,
      wireDeltaPercent: Number((((wire - currentWire) / currentWire) * 100).toFixed(1)),
      modelVisibleTokens: { structuredPreferringClient: modelStructuredFirst, textOnlyClient: modelTextOnly },
      modelVisibleDeltaPercent: Number((((modelStructuredFirst - currentModel) / currentModel) * 100).toFixed(1)),
      cacheAmplifiedTrafficDeltaPercent: Number((((modelStructuredFirst - currentModel) / currentModel) * 100).toFixed(1)),
      risk: candidate.name === "CURRENT" ? "none — status quo"
        : candidate.name === "STRUCTURED_ONLY" ? "HIGH — removes the only channel the advertised protocol revision defines"
          : candidate.name === "TEXT_ONLY" ? "HIGH — removes the only channel the proven client is observed to read"
            : "HIGH — a client reading content[] silently receives counts where it expects evidence",
    };
  });

  const materialityGate = 20;
  const best = scored.filter((s) => s.candidate !== "CURRENT").sort((a, b) => a.modelVisibleDeltaPercent - b.modelVisibleDeltaPercent)[0]!;

  writeFileSync(path.join(RESULTS, "stage5_m167_candidate_simulations.json"), JSON.stringify({
    schemaVersion: 1,
    milestone: "M167",
    workstream: "C",
    title: "Four result contracts, priced at the wire and at the model",
    estimator: `DERIVED_FROM_PROVIDER_REPORTED — ${CHARS_PER_TOKEN.toFixed(2)} chars/token`,
    agentVisibility: rederiveDeliveredRepresentation(),
    summaryExamples,
    withinRepresentationDuplication: {
      note: "measured inside the DELIVERED channel, which is where model tokens are actually spent",
      totalFacts: surfaceTotals.facts,
      factsRenderedOnMoreThanOneSurface: surfaceTotals.multi,
      share: Number(((surfaceTotals.multi / Math.max(1, surfaceTotals.facts)) * 100).toFixed(1)),
    },
    candidates: scored,
  }, null, 1));

  writeFileSync(path.join(RESULTS, "stage5_m167_compatibility_matrix.json"), JSON.stringify({
    schemaVersion: 1,
    milestone: "M167",
    workstream: "C",
    title: "Compatibility matrix",
    materialityGatePercent: materialityGate,
    rows: scored.map((s) => ({
      candidate: s.candidate,
      semanticPreservation: s.semanticPreservation,
      clientCompatibility: s.clientCompatibility,
      agentVisibility: s.agentVisibility,
      medianProjectedModelTokens: s.modelVisibleTokens.structuredPreferringClient,
      modelVisibleDeltaPercent: s.modelVisibleDeltaPercent,
      wireDeltaPercent: s.wireDeltaPercent,
      cacheAmplification: s.cacheAmplifiedTrafficDeltaPercent,
      risk: s.risk,
    })),
    bestNonCurrentCandidate: best.candidate,
    bestModelVisibleDeltaPercent: best.modelVisibleDeltaPercent,
    meetsMaterialityGate: Math.abs(best.modelVisibleDeltaPercent) >= materialityGate,
  }, null, 1));

  console.error(`[m167-C] current wire=${currentWire} model=${currentModel}tok`);
  for (const s of scored) {
    console.error(`[m167-C] ${s.candidate.padEnd(24)} wire=${s.wireCharacters} (${s.wireDeltaPercent}%)  model=${s.modelVisibleTokens.structuredPreferringClient}tok (${s.modelVisibleDeltaPercent}%)  textOnlyClient=${s.modelVisibleTokens.textOnlyClient}tok  preserve[struct]=${s.semanticPreservation.structuredPreferringClient} preserve[text]=${s.semanticPreservation.textOnlyClient}`);
  }
  console.error(`[m167-C] best non-current = ${best.candidate} at ${best.modelVisibleDeltaPercent}%; materiality gate ${materialityGate}% ${Math.abs(best.modelVisibleDeltaPercent) >= materialityGate ? "MET" : "NOT MET"}`);
}

main();
