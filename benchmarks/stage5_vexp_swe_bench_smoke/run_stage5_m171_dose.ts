/**
 * M171-C — the dose curve, and the three proofs §89 requires.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m171_dose.ts
 *
 * Every rung is projected from the SAME captured authoritative response, so the
 * internal pipeline state is identical across rungs by construction rather than
 * by assertion — the pipeline is not re-run, and the projector is verified here
 * to leave its input untouched.
 *
 * Proves, at corpus scale:
 *   no refill      a packet complete below its ceiling is not padded, and does
 *                  not move when unrelated internal bytes are freed (§17, §53)
 *   monotonicity   every location named at a smaller rung is named at a larger
 *                  one, and each excerpt is a prefix of the next (§45)
 *   identity       the projector does not mutate the authoritative state (§73)
 *
 * Offline; reads `results/_m171_capture/dev` only.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  FactKind,
  extractFacts,
  median,
  modelVisibleTokens,
  percentile,
  projectedAttributableCostUsd,
} from "./m171Contract";
import { RUNGS, projectOrientation, readPacketClaims, type OrientationPacket } from "./m171Projection";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CAPTURE = path.join(RESULTS, "_m171_capture", "dev");

/** The fact kinds that ARE repository evidence, used identically on both sides. */
const EVIDENCE_KINDS: readonly string[] = Object.freeze([
  FactKind.Identity, FactKind.Source, FactKind.Role, FactKind.Relationship,
]);

const responseEvidenceCharacters = (output: Record<string, unknown>): number =>
  extractFacts(output)
    .filter((fact) => EVIDENCE_KINDS.includes(fact.kind))
    .reduce((total, fact) => total + fact.characters, 0);

/** The same measure applied to a packet: characters spent asserting evidence. */
function packetEvidenceCharacters(packet: OrientationPacket): number {
  let total = 0;
  if (packet.focus !== null) {
    total += packet.focus.at.length + packet.focus.file.length
      + (packet.focus.lines?.length ?? 0) + (packet.focus.form?.length ?? 0)
      + (packet.focus.why?.length ?? 0) + (packet.focus.code?.length ?? 0);
  }
  for (const item of packet.related) {
    total += item.at.length + item.file.length + (item.lines?.length ?? 0) + item.how.length;
  }
  return total;
}

const AMPLIFICATION: Readonly<Record<string, number>> = Object.freeze(Object.fromEntries(
  (JSON.parse(readFileSync(path.join(RESULTS, "stage5_m169_economic_classes.json"), "utf-8")) as {
    rows: { instanceId: string; pipelineAmplificationRequests: number }[];
  }).rows.map((row) => [row.instanceId, row.pipelineAmplificationRequests]),
));

interface Captured {
  readonly instanceId: string;
  readonly default: { structuredContent: Record<string, any> } | null;
}

const cases = readdirSync(CAPTURE).filter((file) => file.endsWith(".json")).sort()
  .map((file) => JSON.parse(readFileSync(path.join(CAPTURE, file), "utf-8")) as Captured)
  .filter((captured) => captured.default?.structuredContent != null);

// ---- per case, per rung -------------------------------------------

interface RungRow {
  readonly instanceId: string;
  readonly rung: string;
  readonly characters: number;
  readonly tokens: number;
  readonly projectedCostUsd: number | null;
  readonly relatedCount: number;
  readonly focus: string | null;
  readonly focusCodeCharacters: number;
  readonly focusCodeTruncated: boolean;
  readonly evidenceCharacters: number;
  readonly evidenceDensity: number;
  readonly locations: readonly string[];
  readonly files: readonly string[];
}

const rows: RungRow[] = [];
const currentRows: Omit<RungRow, "rung" | "relatedCount" | "focusCodeCharacters" | "focusCodeTruncated">[] = [];
const monotonicityViolations: Record<string, unknown>[] = [];
const prefixViolations: Record<string, unknown>[] = [];
const refillViolations: Record<string, unknown>[] = [];
const mutationViolations: string[] = [];
const pivotDrift: Record<string, unknown>[] = [];

for (const captured of cases) {
  const envelope = captured.default!.structuredContent;
  const output = envelope.result.output as Record<string, unknown>;
  const amplification = AMPLIFICATION[captured.instanceId] ?? null;

  // §73 — the projector must not mutate what it reads.
  const before = JSON.stringify(output);

  const currentCharacters = JSON.stringify(envelope).length;
  const currentEvidence = responseEvidenceCharacters(output);
  const currentTokens = modelVisibleTokens(currentCharacters);
  const productContext = output.productContext as Record<string, unknown> | undefined;
  currentRows.push({
    instanceId: captured.instanceId,
    characters: currentCharacters,
    tokens: currentTokens,
    projectedCostUsd: amplification === null ? null : projectedAttributableCostUsd(currentTokens, amplification),
    focus: String(productContext?.leadPivot ?? "") || null,
    evidenceCharacters: currentEvidence,
    evidenceDensity: currentCharacters === 0 ? 0 : currentEvidence / currentCharacters,
    locations: Object.freeze([]),
    files: Object.freeze([]),
  });

  let previousLocations: ReadonlySet<string> | null = null;
  let previousCode: string | null = null;
  let previousSerialized: string | null = null;
  let previousRungName: string | null = null;
  let previousComplete: boolean | null = null;

  for (const rung of RUNGS) {
    const packet = projectOrientation(output, rung);
    const claims = readPacketClaims(packet);
    const characters = JSON.stringify(packet).length;
    const tokens = modelVisibleTokens(characters);
    const evidence = packetEvidenceCharacters(packet);

    if (previousLocations !== null) {
      for (const location of previousLocations) {
        if (!claims.locations.has(location)) {
          monotonicityViolations.push({ instanceId: captured.instanceId, from: previousRungName, to: rung.name, lost: location });
        }
      }
    }
    const code = packet.focus?.code ?? "";
    if (previousCode !== null && !code.startsWith(previousCode)) {
      prefixViolations.push({ instanceId: captured.instanceId, from: previousRungName, to: rung.name });
    }
    // §17 — when a rung's caps already exceed the available material, the packet
    // is COMPLETE and raising the ceiling must change nothing. The test is a
    // property of the PREVIOUS packet: a previous rung that was still truncating,
    // or still capped, has material left to deliver and is entitled to grow.
    const serialized = JSON.stringify(packet);
    if (previousComplete === true && serialized !== previousSerialized) {
      refillViolations.push({ instanceId: captured.instanceId, from: previousRungName, to: rung.name, note: "packet grew although the previous rung was already complete" });
    }

    rows.push({
      instanceId: captured.instanceId,
      rung: rung.name,
      characters,
      tokens,
      projectedCostUsd: amplification === null ? null : projectedAttributableCostUsd(tokens, amplification),
      relatedCount: packet.related.length,
      focus: packet.focus?.at ?? null,
      focusCodeCharacters: code.length,
      focusCodeTruncated: packet.focus?.codeTruncated ?? false,
      evidenceCharacters: evidence,
      evidenceDensity: characters === 0 ? 0 : evidence / characters,
      locations: Object.freeze([...claims.locations].sort()),
      files: Object.freeze([...claims.files].sort()),
    });

    const authoritativePivot = String(productContext?.leadPivot ?? "");
    if (authoritativePivot !== "" && packet.focus !== null && packet.focus.at !== authoritativePivot) {
      pivotDrift.push({ instanceId: captured.instanceId, rung: rung.name, authoritative: authoritativePivot, projected: packet.focus.at });
    }

    previousLocations = claims.locations;
    previousCode = code;
    previousSerialized = serialized;
    previousRungName = rung.name;
    previousComplete = !(packet.focus?.codeTruncated ?? false) && packet.related.length < rung.relatedCap;
  }

  if (JSON.stringify(output) !== before) mutationViolations.push(captured.instanceId);
}

// ---- aggregate -----------------------------------------------------

const summarize = (rungName: string | null) => {
  const subset = rungName === null ? currentRows : rows.filter((row) => row.rung === rungName);
  const tokens = subset.map((row) => row.tokens);
  const costs = subset.map((row) => row.projectedCostUsd).filter((cost): cost is number => cost !== null);
  return {
    rung: rungName ?? "CURRENT",
    cases: subset.length,
    tokens: { median: median(tokens), p90: percentile(tokens, 0.9), max: Math.max(...tokens) },
    projectedAttributableCostUsd: { median: median(costs), p90: percentile(costs, 0.9), max: Math.max(...costs) },
    evidenceDensity: { median: median(subset.map((row) => row.evidenceDensity)) },
    medianEvidenceCharacters: median(subset.map((row) => row.evidenceCharacters)),
    medianLocations: rungName === null ? null : median((subset as RungRow[]).map((row) => row.locations.length)),
    medianRelated: rungName === null ? null : median((subset as RungRow[]).map((row) => row.relatedCount)),
    ceilingBinds: rungName === null ? null : (subset as RungRow[]).filter((row) => row.focusCodeTruncated || row.relatedCount >= (RUNGS.find((rung) => rung.name === rungName)?.relatedCap ?? 0)).length,
  };
};

const curve = [summarize(null), ...RUNGS.map((rung) => summarize(rung.name))];

const write = (name: string, body: unknown): void => {
  writeFileSync(path.join(RESULTS, name), `${JSON.stringify(body, null, 1)}\n`);
  process.stdout.write(`wrote ${name}\n`);
};

for (const rung of RUNGS) {
  write(`stage5_m171_projection_${rung.ceilingTokens}.json`, {
    schemaVersion: "stage5.m171.projection.v1",
    milestone: "M171",
    workstream: "M171-C",
    rung,
    corpus: "development (12 M168/M169 cases), fresh indexes",
    rows: rows.filter((row) => row.rung === rung.name),
  });
}

write("stage5_m171_dose_curve.json", {
  schemaVersion: "stage5.m171.dose-curve.v1",
  milestone: "M171",
  workstream: "M171-C",
  title: "Model-visible cost and evidence density across projection rungs",
  method: {
    internalStateAcrossRungs: "IDENTICAL BY CONSTRUCTION — the pipeline is invoked once per case and every rung is projected from that one captured authoritative response. This is why M171 does not repeat M169's non-monotone budget ladder: nothing upstream of the projector can move.",
    evidenceMeasure: "characters spent asserting IDENTITY, SOURCE, ROLE or RELATIONSHIP facts, by the same extractor on both sides. Repeated surfaces count on the response side because the model pays for each of them.",
    tokenAuthority: "M166 measured calibration, 0.3174 tokens/character",
    costAuthority: "PROJECTED ATTRIBUTABLE COST (§65): cache write at the 1h rate plus one cache read per subsequent request, per-case amplification from the M169 ledger",
  },
  proofs: {
    monotonicity: { violations: monotonicityViolations, passes: monotonicityViolations.length === 0, rule: "§45 — a location named at a smaller rung is named at a larger one" },
    excerptPrefix: { violations: prefixViolations, passes: prefixViolations.length === 0, rule: "each rung's excerpt is a prefix of the next" },
    noRefill: { violations: refillViolations, passes: refillViolations.length === 0, rule: "§17/§46 — a packet already complete below its ceiling does not grow when the ceiling rises" },
    projectorPurity: { violations: mutationViolations, passes: mutationViolations.length === 0, rule: "§73 — the projector does not mutate the authoritative state it reads" },
    pivotIdentity: { drift: pivotDrift, passes: pivotDrift.length === 0, rule: "§36/§58 — the projected focus is the authoritative lead pivot, at every rung" },
  },
  curve,
  gates: {
    medianTokensAtOrBelow: 2000,
    p90TokensAtOrBelow: 2500,
    projectedCostAtOrBelowUsd: 0.026219,
    projectedCostBasis: "50% of the M169 median baselineInvestigationAllUsd of $0.052438",
    passingRungs: curve.filter((entry) => entry.rung !== "CURRENT"
      && entry.tokens.median <= 2000 && entry.tokens.p90 <= 2500
      && entry.projectedAttributableCostUsd.median <= 0.026219).map((entry) => entry.rung),
  },
});

process.stdout.write(`\n${JSON.stringify(curve, null, 1)}\n`);
