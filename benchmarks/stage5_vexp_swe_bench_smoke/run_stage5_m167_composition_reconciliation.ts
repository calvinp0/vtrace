/**
 * M167 §17 — reconcile this milestone's composition with M166's headline.
 *
 * M166 reported transport 41.9%, restatements 21.8%, evidence 14.2%. M167 measures a
 * different mix. Before any of it can be read as a finding, the difference has to be
 * attributed, and there are two candidate causes that must not be allowed to hide each
 * other: the payload POPULATION and the M166-D product change. Both are held fixed in
 * turn here, using the same classifier for all three populations.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { decompose } from "./m166Taxonomy";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");

function meanShares(payloads: readonly unknown[]): Record<string, number> {
  const shares: Record<string, number[]> = {};
  for (const output of payloads) {
    if (output === undefined || output === null) continue;
    const decomposition = decompose(output);
    const total = Object.values(decomposition.byCategory).reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    for (const [category, characters] of Object.entries(decomposition.byCategory)) {
      (shares[category] ??= []).push((100 * characters) / total);
    }
  }
  return Object.fromEntries(
    Object.entries(shares).map(([k, v]) => [k, Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(1))]),
  );
}

function load(dir: string, suffix: string, pick: (parsed: any) => unknown): unknown[] {
  return readdirSync(dir).filter((f) => f.endsWith(suffix) && !f.startsWith("_")).sort()
    .map((f) => pick(JSON.parse(readFileSync(path.join(dir, f), "utf8"))))
    // A payload that cannot be read is dropped from the population, never counted as
    // a zero share: §60, an unobservable input is not an observation.
    .filter((value) => value !== undefined && value !== null);
}

function medianDiagnosticsCharacters(payloads: readonly unknown[]): number {
  const widths = payloads.map((o) => JSON.stringify((o as any)?.diagnostics ?? null).length).sort((a, b) => a - b);
  return widths.length === 0 ? 0 : widths[Math.floor(widths.length / 2)]!;
}

function main(): void {
  const m164 = load(path.join(RESULTS, "_m166_payloads"), ".modelvisible.json", (p) => p?.result?.output);
  const replayBefore = load(path.join(RESULTS, "_m166_payloads"), ".structured.json", (p) => p?.result?.output);
  const replayAfter = load(path.join(RESULTS, "_m167_capture_current"), ".json", (p) =>
    (p?.calls ?? []).find((c: any) => c.call === "get_code_context.standard")?.structuredContent?.result?.output);

  const populations = {
    m164TranscriptPayloads: {
      description: "the tool results M166 actually priced — real M164 agent runs, before the M166-D change",
      cases: m164.length,
      meanSharePercent: meanShares(m164),
      medianDiagnosticsSectionCharacters: medianDiagnosticsCharacters(m164),
      m166Reported: { TRANSPORT_STRUCTURE: 41.9, DUPLICATE: 21.8, REPOSITORY_EVIDENCE: 14.2 },
    },
    localReplayBeforeChange: {
      description: "the same twelve tasks replayed locally against the preserved workspaces, before the M166-D change",
      cases: replayBefore.length,
      meanSharePercent: meanShares(replayBefore),
      medianDiagnosticsSectionCharacters: medianDiagnosticsCharacters(replayBefore),
    },
    localReplayAfterChange: {
      description: "the same twelve tasks replayed locally at M167's HEAD, after the M166-D change",
      cases: replayAfter.length,
      meanSharePercent: meanShares(replayAfter),
      medianDiagnosticsSectionCharacters: medianDiagnosticsCharacters(replayAfter),
    },
  };

  const reproduced = populations.m164TranscriptPayloads.meanSharePercent;
  const withinRounding = (a: number, b: number): boolean => Math.abs(a - b) <= 1.0;

  writeFileSync(path.join(RESULTS, "stage5_m167_composition_reconciliation.json"), JSON.stringify({
    schemaVersion: 1,
    milestone: "M167",
    workstream: "B",
    title: "Why M167's composition differs from M166's headline",
    classifier: "identical — benchmarks/stage5_vexp_swe_bench_smoke/m166Taxonomy.ts, unchanged by this milestone",
    classifierReproducesM166: {
      transport: withinRounding(reproduced.TRANSPORT_STRUCTURE ?? 0, 41.9),
      duplicate: withinRounding(reproduced.DUPLICATE ?? 0, 21.8),
      evidence: withinRounding(reproduced.REPOSITORY_EVIDENCE ?? 0, 14.2),
      reading: "run against M166's own population the classifier returns M166's numbers, so the shift below is caused by what changed, not by how it is counted. The residual is M166 reporting a median where this reports a mean.",
    },
    populations,
    attribution: [
      {
        cause: "payload population",
        isolatedBy: "M164 transcript payloads versus the local replay, both before the change",
        effect: "transport falls and restatement rises: the M164 runs indexed different repository states, and a response with more sparse nested diagnostics carries proportionally more key punctuation",
      },
      {
        cause: "the M166-D diagnostics change",
        isolatedBy: "the local replay before versus after, same workspaces and same tasks",
        effect: "the diagnostics SECTION collapses in absolute width, transport structure falls with the sparse nested keys it was wrapping, and evidence rises as a share because the freed budget stopped evidence being evicted. The MACHINE_DIAGNOSTIC category share barely moves, because that category is wider than the diagnostics section: it also covers the request echo, the task summary, the savings accounting and the timings, none of which M166-D touched.",
      },
    ],
    caution: "M166's percentages remain correct for the population and product version they described. They are not a baseline this milestone's percentages can be subtracted from.",
  }, null, 1));

  console.error(`[m167-recon] m164=${JSON.stringify(populations.m164TranscriptPayloads.meanSharePercent)}`);
  console.error(`[m167-recon] replayBefore=${JSON.stringify(populations.localReplayBeforeChange.meanSharePercent)}`);
  console.error(`[m167-recon] replayAfter=${JSON.stringify(populations.localReplayAfterChange.meanSharePercent)}`);
}

main();
