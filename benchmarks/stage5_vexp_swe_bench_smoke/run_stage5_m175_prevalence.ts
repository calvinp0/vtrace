/**
 * M175-E — how often the echo mattered, what it recovered, and what it left alone.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m175_prevalence.ts
 *
 * Reads the two corpus runs and answers §43, §44, §46 and §51.
 *
 * A DISTINCTION THAT DECIDES HOW THESE NUMBERS READ. Since M172 the model-facing
 * default is a PROJECTION, and the projection never contained the request block at
 * all. So the "request-restatement share of the orientation packet" was already zero
 * before M175 and is zero after it. Measuring that would report a fix for a problem
 * M172 had already solved.
 *
 * What the echo actually governed is the ENVELOPE the packet is projected FROM. The
 * question was never how much of the packet was restatement; it was whether the
 * packet got any evidence to carry. So restatement is measured against the CEILING —
 * the 9,200-token resource the evidence and the echo actually competed for — and
 * delivery is measured on the default path, which is what the agent receives.
 *
 * Offline. No agent, no Docker, no paid API.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { envelopeTokens, REQUEST_PROSE_OMITTED, TASK_REFERENCE } from "./m175Echo";

const RESULTS = path.join(path.resolve("."), "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPORA = ["broad100a", "broad100b"] as const;

/** The ceiling a default call actually contends for: 8,000 requested + 15%. */
const CEILING_TOKENS = 9_200;

/** The non-prose remainder of a real request block. */
const REQUEST_SCAFFOLD = Object.freeze({
  maxResults: 6, maxBudgetCharacters: 2_000, intentRequested: "auto", sessionId: null,
  includeTests: true, includeFileContent: true, presetRequested: "auto",
});

interface Outcome {
  kind: string; relatedCount: number; billedTokens: number;
  focusAt: string | null; relatedFiles: string[]; relatedSymbols: string[];
}
interface Row {
  instanceId: string; taskCharacters: number; before: Outcome; after: Outcome;
  goldFileBefore: boolean | null; goldFileAfter: boolean | null;
  goldSymbolBefore: boolean | null; goldSymbolAfter: boolean | null;
  deliveryRecovered: boolean; deliveryLost: boolean; focusChanged: boolean; relatedDelta: number;
}
interface CorpusFile { corpus: string; summary: Record<string, unknown>; rows: Row[] }

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};
const pct = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 10;

const prevalence: Record<string, unknown> = {};
const recovery: Record<string, unknown> = {};
const density: Record<string, unknown> = {};
const identity: Record<string, unknown> = {};

for (const corpus of CORPORA) {
  const file = path.join(RESULTS, `stage5_m175_${corpus}.json`);
  const data = JSON.parse(readFileSync(file, "utf8")) as CorpusFile;
  const valid = data.rows.filter((row) => row.before.kind !== "not_ready" && row.after.kind !== "not_ready");

  // ── §43 prevalence, measured against the contested ceiling ──
  const echoTokens = valid.map((row) => {
    const question = "x".repeat(row.taskCharacters);
    const before = envelopeTokens({ query: question, task: question, ...REQUEST_SCAFFOLD });
    const after = envelopeTokens({ query: TASK_REFERENCE, task: REQUEST_PROSE_OMITTED, ...REQUEST_SCAFFOLD });
    return { instanceId: row.instanceId, before, after, share: before / CEILING_TOKENS };
  });
  const atLeast = (threshold: number): number => echoTokens.filter((row) => row.share >= threshold).length;

  prevalence[corpus] = {
    cases: valid.length,
    ceilingTokens: CEILING_TOKENS,
    requestBlockTokens: {
      before: { median: median(echoTokens.map((row) => row.before)), max: Math.max(...echoTokens.map((row) => row.before)) },
      after: { median: median(echoTokens.map((row) => row.after)), max: Math.max(...echoTokens.map((row) => row.after)) },
    },
    shareOfCeiling: {
      over10Percent: atLeast(0.10), over25Percent: atLeast(0.25),
      over50Percent: atLeast(0.50), over75Percent: atLeast(0.75),
    },
    effectOnDelivery: {
      changedDeliveredEvidence: valid.filter((row) => row.relatedDelta !== 0 || row.deliveryRecovered).length,
      causedAllEvidenceEviction: valid.filter((row) => row.deliveryRecovered).length,
      causedPivotEviction: valid.filter((row) => row.deliveryRecovered).length,
      triggeredDeliveryFailure: valid.filter((row) => row.before.kind === "decline").length,
      note: "A decline the repair reverses IS the all-evidence eviction: the packet had no focus "
        + "and no related entries, so pivot eviction and total eviction are the same event.",
    },
  };

  // ── §44 evidence recovery ──
  const scored = valid.filter((row) => row.goldFileBefore !== null);
  const restored = valid.filter((row) => row.relatedDelta > 0);
  const reduced = valid.filter((row) => row.relatedDelta < 0);
  recovery[corpus] = {
    cases: valid.length,
    deliveredPackets: {
      before: valid.filter((row) => row.before.kind === "orientation").length,
      after: valid.filter((row) => row.after.kind === "orientation").length,
    },
    relatedItems: {
      before: valid.reduce((sum, row) => sum + row.before.relatedCount, 0),
      after: valid.reduce((sum, row) => sum + row.after.relatedCount, 0),
    },
    additionalPreviouslySelectedItemsRestored: restored.reduce((sum, row) => sum + row.relatedDelta, 0),
    casesWithItemsRestored: restored.length,
    casesWithItemsReduced: reduced.length,
    pivotsRestored: valid.filter((row) => row.deliveryRecovered).length,
    goldFilesRestored: {
      scored: scored.length,
      before: scored.filter((row) => row.goldFileBefore === true).length,
      after: scored.filter((row) => row.goldFileAfter === true).length,
    },
    goldSymbolsRestored: {
      scored: scored.length,
      before: scored.filter((row) => row.goldSymbolBefore === true).length,
      after: scored.filter((row) => row.goldSymbolAfter === true).length,
    },
    classification: "DELIVERY_RECOVERY — retrieval is byte-identical across the arms (§45)",
  };

  // ── §46/§47 density ──
  density[corpus] = {
    requestRestatementShareOfPacket: {
      before: 0, after: 0,
      why: "The compact orientation packet has carried no request block since M172. The echo was "
        + "never IN the packet; it decided whether the packet got evidence.",
    },
    requestRestatementShareOfCeiling: {
      before: pct(median(echoTokens.map((row) => row.before)), CEILING_TOKENS),
      after: pct(median(echoTokens.map((row) => row.after)), CEILING_TOKENS),
    },
    repositoryEvidenceShareOfPacket: {
      before: 100, after: 100,
      why: "focus + related + one boundary line. The packet is evidence by construction.",
    },
    medianPacketTokens: {
      before: median(valid.map((row) => row.before.billedTokens)),
      after: median(valid.map((row) => row.after.billedTokens)),
    },
    totalPacketTokens: {
      before: valid.reduce((sum, row) => sum + row.before.billedTokens, 0),
      after: valid.reduce((sum, row) => sum + row.after.billedTokens, 0),
    },
  };

  // ── §51 non-pathological identity ──
  const bothDelivered = valid.filter(
    (row) => row.before.kind === "orientation" && row.after.kind === "orientation",
  );
  const isSuperset = (row: Row): boolean =>
    row.before.relatedFiles.every((file) => row.after.relatedFiles.includes(file))
    && row.before.relatedSymbols.every((symbol) => row.after.relatedSymbols.includes(symbol));
  const unchanged = bothDelivered.filter((row) => row.relatedDelta === 0 && !row.focusChanged);
  const supersets = bothDelivered.filter((row) => isSuperset(row));

  identity[corpus] = {
    bothDelivered: bothDelivered.length,
    focusUnchanged: bothDelivered.filter((row) => !row.focusChanged).length,
    focusChanged: bothDelivered.filter((row) => row.focusChanged).map((row) => row.instanceId),
    byteIdenticalEvidence: unchanged.length,
    afterIsSupersetOfBefore: supersets.length,
    notSuperset: bothDelivered.filter((row) => !isSuperset(row))
      .map((row) => ({
        instanceId: row.instanceId,
        lostFiles: row.before.relatedFiles.filter((file) => !row.after.relatedFiles.includes(file)),
        lostSymbols: row.before.relatedSymbols.filter((symbol) => !row.after.relatedSymbols.includes(symbol)),
      })),
    verdict: supersets.length === bothDelivered.length
      ? "EVERY_DELIVERED_PACKET_PRESERVED_OR_EXTENDED"
      : "SOME_PACKETS_LOST_EVIDENCE",
  };
}

const write = (name: string, value: unknown): void => {
  writeFileSync(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote results/${name}`);
};

write("stage5_m175_echo_prevalence.json", {
  schemaVersion: "stage5.m175.echo-prevalence.v1", workstream: "M175-E",
  measuredAgainst: "the 9,200-token response ceiling, which is what the echo and the evidence "
    + "actually competed for",
  corpora: prevalence,
});
write("stage5_m175_evidence_recovery.json", {
  schemaVersion: "stage5.m175.evidence-recovery.v1", workstream: "M175-E",
  goldStatus: "diagnostic only (§44); movement is DELIVERY RECOVERY, never retrieval improvement (§45)",
  corpora: recovery,
});
write("stage5_m175_evidence_density.json", {
  schemaVersion: "stage5.m175.evidence-density.v1", workstream: "M175-E", corpora: density,
});
write("stage5_m175_nonpathological_identity.json", {
  schemaVersion: "stage5.m175.nonpathological-identity.v1", workstream: "M175-E",
  gate: "§51 — where the echo did not decide delivery, the packet's repository semantics must not move",
  corpora: identity,
});

for (const corpus of CORPORA) {
  const p = prevalence[corpus] as any;
  const r = recovery[corpus] as any;
  const i = identity[corpus] as any;
  console.log("");
  console.log(`${corpus}  ${p.cases} valid cases`);
  console.log(`  request block tokens   median ${p.requestBlockTokens.before.median} → ${p.requestBlockTokens.after.median}`
    + `   max ${p.requestBlockTokens.before.max} → ${p.requestBlockTokens.after.max}`);
  console.log(`  share of ceiling >10%  ${p.shareOfCeiling.over10Percent}   >25% ${p.shareOfCeiling.over25Percent}`
    + `   >50% ${p.shareOfCeiling.over50Percent}   >75% ${p.shareOfCeiling.over75Percent}`);
  console.log(`  delivered packets      ${r.deliveredPackets.before} → ${r.deliveredPackets.after}`);
  console.log(`  related items total    ${r.relatedItems.before} → ${r.relatedItems.after}`
    + `  (restored on ${r.casesWithItemsRestored}, reduced on ${r.casesWithItemsReduced})`);
  console.log(`  gold file / symbol     ${r.goldFilesRestored.before}→${r.goldFilesRestored.after}`
    + ` / ${r.goldSymbolsRestored.before}→${r.goldSymbolsRestored.after}  of ${r.goldFilesRestored.scored}`);
  console.log(`  identity               focus unchanged ${i.focusUnchanged}/${i.bothDelivered}, `
    + `superset ${i.afterIsSupersetOfBefore}/${i.bothDelivered}  ${i.verdict}`);
}
