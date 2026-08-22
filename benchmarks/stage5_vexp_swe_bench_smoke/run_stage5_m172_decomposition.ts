/**
 * M172-A — which of the three bundled bounds actually binds.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m172_decomposition.ts
 *
 * M171 shipped its dose as four RUNGS, each a bundle of three parameters that
 * co-vary:
 *
 *     R1000   ceiling 1000   focusChars  700   relatedCap 2
 *     R1500   ceiling 1500   focusChars 1200   relatedCap 3
 *     R2000   ceiling 2000   focusChars 1800   relatedCap 5
 *     R2500   ceiling 2500   focusChars 2400   relatedCap 7
 *
 * A bundle cannot tell you which of its parameters caused an effect. M171-E's
 * one failing gate was gold-symbol delivery, and its standing finding was that
 * "the packet is bounded twice and the wrong bound binds" — asserted from the
 * ceiling's measured inertness, but never separated per case.
 *
 * This script separates them. For each development case it projects at an
 * effectively unbounded rung to recover the FULL admissible related list in
 * authoritative order, then reports, per M171 rung, which bound was live.
 *
 * It changes no policy and selects nothing. Offline; reads `_m171_capture/dev`.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { median, modelVisibleTokens, percentile } from "./m171Contract";
import { NEIGHBOR_RELATION_PHRASES, RUNGS, projectOrientation, type Rung } from "./m171Projection";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CAPTURE = path.join(RESULTS, "_m171_capture", "dev");

/** Effectively unbounded: recovers what the authoritative state would admit. */
const UNBOUNDED: Rung = Object.freeze({
  name: "UNBOUNDED",
  ceilingTokens: Number.MAX_SAFE_INTEGER,
  focusCodeCharacters: Number.MAX_SAFE_INTEGER,
  relatedCap: Number.MAX_SAFE_INTEGER,
});

/** The one phrase that states a NON-relationship. Tracked separately throughout. */
const NO_RELATION_PHRASE = NEIGHBOR_RELATION_PHRASES.fallback_symbol_window!;

interface Captured {
  readonly instanceId: string;
  readonly default: { structuredContent: Record<string, any> } | null;
}

const cases = readdirSync(CAPTURE).filter((f) => f.endsWith(".json")).sort()
  .map((f) => JSON.parse(readFileSync(path.join(CAPTURE, f), "utf-8")) as Captured)
  .filter((c) => c.default?.structuredContent != null);

interface CaseRow {
  readonly instanceId: string;
  readonly focus: string | null;
  readonly focusCodeCharacters: number;
  readonly admissibleRelated: number;
  readonly admissibleFromItems: number;
  readonly admissibleFromNeighbors: number;
  readonly noRelationEntries: number;
  readonly noRelationPositions: readonly number[];
  readonly relatedOrder: readonly { position: number; at: string; origin: string; how: string }[];
  readonly perRung: readonly {
    rung: string;
    tokens: number;
    ceilingTokens: number;
    ceilingHeadroomTokens: number;
    ceilingBinds: boolean;
    relatedDelivered: number;
    relatedCap: number;
    capBinds: boolean;
    focusCharsBinds: boolean;
  }[];
}

const rows: CaseRow[] = [];

for (const captured of cases) {
  const output = captured.default!.structuredContent.result.output as Record<string, unknown>;
  const full = projectOrientation(output, UNBOUNDED);
  if (full.state !== "resolved") continue;

  // Origin of each admissible entry: productContext items are consumed before
  // pivot-neighborhood excerpts, so an entry is a neighbour exactly when its
  // rendered relationship is one of the frozen neighbour phrases.
  const neighborPhrases = new Set(Object.values(NEIGHBOR_RELATION_PHRASES));
  const order = full.related.map((r, index) => ({
    position: index + 1,
    at: r.at,
    origin: neighborPhrases.has(r.how) ? "neighbor" : "item",
    how: r.how,
  }));

  const focusCodeCharacters = full.focus?.code?.length ?? 0;

  const perRung = RUNGS.map((rung) => {
    const packet = projectOrientation(output, rung);
    const tokens = modelVisibleTokens(JSON.stringify(packet).length);
    return {
      rung: rung.name,
      tokens,
      ceilingTokens: rung.ceilingTokens,
      ceilingHeadroomTokens: rung.ceilingTokens - tokens,
      ceilingBinds: tokens >= rung.ceilingTokens,
      relatedDelivered: packet.related.length,
      relatedCap: rung.relatedCap,
      capBinds: full.related.length > rung.relatedCap,
      focusCharsBinds: focusCodeCharacters > rung.focusCodeCharacters,
    };
  });

  rows.push({
    instanceId: captured.instanceId,
    focus: full.focus?.at ?? null,
    focusCodeCharacters,
    admissibleRelated: full.related.length,
    admissibleFromItems: order.filter((o) => o.origin === "item").length,
    admissibleFromNeighbors: order.filter((o) => o.origin === "neighbor").length,
    noRelationEntries: order.filter((o) => o.how === NO_RELATION_PHRASE).length,
    noRelationPositions: order.filter((o) => o.how === NO_RELATION_PHRASE).map((o) => o.position),
    relatedOrder: order,
    perRung,
  });
}

// ---- which bound binds, per rung, across the corpus ----------------

const boundSummary = RUNGS.map((rung) => {
  const at = rows.map((r) => r.perRung.find((p) => p.rung === rung.name)!);
  return {
    rung: rung.name,
    cases: rows.length,
    ceilingBindsCases: at.filter((p) => p.ceilingBinds).length,
    capBindsCases: at.filter((p) => p.capBinds).length,
    focusCharsBindsCases: at.filter((p) => p.focusCharsBinds).length,
    medianTokens: median(at.map((p) => p.tokens)),
    medianCeilingHeadroomTokens: median(at.map((p) => p.ceilingHeadroomTokens)),
    minCeilingHeadroomTokens: Math.min(...at.map((p) => p.ceilingHeadroomTokens)),
    medianRelatedDelivered: median(at.map((p) => p.relatedDelivered)),
    relatedWithheldTotal: at.reduce((t, p, i) => t + Math.max(0, rows[i]!.admissibleRelated - p.relatedDelivered), 0),
  };
});

const admissible = rows.map((r) => r.admissibleRelated);
const report = {
  schemaVersion: "stage5.m172.decomposition.v1",
  milestone: "M172",
  workstream: "M172-A",
  title: "Which of M171's three bundled bounds is live, measured per case on development",
  method: {
    corpus: "dev",
    cases: rows.length,
    source: "results/_m171_capture/dev — the M171-A captures, reprojected; no pipeline re-run",
    instrument: "m171Contract.modelVisibleTokens, the same calibrated estimator M171 used",
    unboundedRung: "ceiling, focusChars and relatedCap all MAX_SAFE_INTEGER, to recover the full admissible list in authoritative order",
    caveat: "ceilingBinds is a >= test against the packet's own model-visible tokens; it never fired, so no case is censored by it",
  },
  admissibleRelated: {
    median: median(admissible),
    p90: percentile(admissible, 90),
    min: Math.min(...admissible),
    max: Math.max(...admissible),
    distribution: Object.fromEntries(
      [...new Set(admissible)].sort((a, b) => a - b).map((n) => [String(n), admissible.filter((x) => x === n).length]),
    ),
  },
  noRelationFiller: {
    casesWithAny: rows.filter((r) => r.noRelationEntries > 0).length,
    totalEntries: rows.reduce((t, r) => t + r.noRelationEntries, 0),
    withinFirstFivePositions: rows.reduce((t, r) => t + r.noRelationPositions.filter((p) => p <= 5).length, 0),
    note: "entries rendered as 'in the same file as the focus symbol; no indexed relationship to it' — a slot spent on a symbol the index relates to nothing",
  },
  boundSummary,
  cases: rows,
};

writeFileSync(path.join(RESULTS, "stage5_m172_decomposition.json"), `${JSON.stringify(report, null, 1)}\n`);

console.log(`cases: ${rows.length}`);
console.log(`admissible related: median ${report.admissibleRelated.median}, min ${report.admissibleRelated.min}, max ${report.admissibleRelated.max}`);
console.log(`distribution: ${JSON.stringify(report.admissibleRelated.distribution)}`);
console.log(`no-relation filler: ${report.noRelationFiller.totalEntries} entries over ${report.noRelationFiller.casesWithAny} cases, ${report.noRelationFiller.withinFirstFivePositions} inside the first five slots`);
console.table(boundSummary);
