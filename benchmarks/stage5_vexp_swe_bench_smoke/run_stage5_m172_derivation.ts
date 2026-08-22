/**
 * M172-B — deriving the admission policy on development evidence, and freezing it.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m172_derivation.ts
 *
 * M171-E failed one gate: gold-symbol delivery on Broad100-A, by three cases at
 * authoritative positions six and seven. R2500 would have recovered all three,
 * and adopting it then would have been choosing a parameter after seeing which
 * value fixed the holdout (§70). This script derives the replacement WITHOUT
 * consulting those three cases: it reads only `_m171_capture/dev`, and the
 * holdout captures are not opened until the policy is written to
 * `stage5_m172_frozen_policy.json`.
 *
 * Three candidates, all at the same 2,000-token ceiling and the same 1,800-char
 * focus bound, differing only in how the related list is admitted:
 *
 *   P_M171_R2000   count cap 5                       — the status quo, and the
 *                                                      §51 identity control
 *   P_SUPPLY       no count cap, ceiling is the bound
 *   P_RELATION     no count cap, and no entry whose only claim is proximity
 *
 * Offline; reads `_m171_capture/dev` only.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { median, modelVisibleTokens, percentile, projectedAttributableCostUsd } from "./m171Contract";
import { RUNGS, projectOrientation, readPacketClaims } from "./m171Projection";
import { NO_RELATION_PHRASE, POLICIES, packetTokens, projectOrientationM172 } from "./m172Projection";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CAPTURE = path.join(RESULTS, "_m171_capture", "dev");

const R2000 = RUNGS.find((rung) => rung.name === "R2000")!;

const AMPLIFICATION: Readonly<Record<string, number>> = Object.freeze(Object.fromEntries(
  (JSON.parse(readFileSync(path.join(RESULTS, "stage5_m169_economic_classes.json"), "utf-8")) as {
    rows: { instanceId: string; pipelineAmplificationRequests: number }[];
  }).rows.map((row) => [row.instanceId, row.pipelineAmplificationRequests]),
));

const localPart = (fqName: string): string => {
  const afterPath = fqName.includes("::") ? fqName.slice(fqName.lastIndexOf("::") + 2) : fqName;
  return afterPath.includes(".") ? afterPath.slice(afterPath.lastIndexOf(".") + 1) : afterPath;
};
const fileMatches = (surfaced: ReadonlySet<string>, goldFile: string): boolean => {
  for (const candidate of surfaced) {
    if (candidate === goldFile || candidate.endsWith(`/${goldFile}`) || goldFile.endsWith(`/${candidate}`)) return true;
  }
  return false;
};

const cases = readdirSync(CAPTURE).filter((f) => f.endsWith(".json")).sort()
  .map((f) => JSON.parse(readFileSync(path.join(CAPTURE, f), "utf-8")) as Record<string, any>)
  .filter((c) => c.default?.structuredContent?.result?.output != null);

// ---- §51 identity control -----------------------------------------
// P_M171_R2000 must reproduce M171's R2000 byte for byte. A comparative
// analyzer that cannot classify an unchanged input correctly has no standing to
// classify a changed one.

const identityMismatches: { instanceId: string; m171: number; m172: number }[] = [];
for (const captured of cases) {
  const output = captured.default.structuredContent.result.output as Record<string, unknown>;
  const a = JSON.stringify(projectOrientation(output, R2000));
  const b = JSON.stringify(projectOrientationM172(output, POLICIES[0]!));
  if (a !== b) identityMismatches.push({ instanceId: String(captured.instanceId), m171: a.length, m172: b.length });
}

// ---- price every candidate on development -------------------------

interface PolicyRow {
  readonly instanceId: string;
  readonly tokens: number;
  readonly costUsd: number | null;
  readonly related: number;
  readonly files: number;
  readonly ceilingBinds: boolean;
  readonly pivotPreserved: boolean | null;
  readonly goldFile: boolean | null;
  readonly goldSymbol: boolean | null;
  readonly noRelationEntries: number;
}

const byPolicy: Record<string, PolicyRow[]> = {};
const currentRows: { tokens: number; costUsd: number | null; files: number; goldFile: boolean | null; goldSymbol: boolean | null }[] = [];

for (const captured of cases) {
  const envelope = captured.default.structuredContent;
  const output = envelope.result.output as Record<string, unknown>;
  const instanceId = String(captured.instanceId);
  const amplification = AMPLIFICATION[instanceId] ?? null;
  const goldFiles: string[] = captured.expectedFiles ?? [];
  const goldSymbols: string[] = captured.expectedSymbols ?? [];
  const authoritativePivot = String((output.productContext as any)?.leadPivot ?? "");

  const currentTokens = modelVisibleTokens(JSON.stringify(envelope).length);
  currentRows.push({
    tokens: currentTokens,
    costUsd: amplification === null ? null : projectedAttributableCostUsd(currentTokens, amplification),
    files: 0, goldFile: null, goldSymbol: null,
  });

  for (const policy of POLICIES) {
    const packet = projectOrientationM172(output, policy);
    const claims = readPacketClaims(packet);
    const tokens = packetTokens(packet);
    const locals = new Set([...claims.locations].map(localPart));
    (byPolicy[policy.name] ??= []).push({
      instanceId,
      tokens,
      costUsd: amplification === null ? null : projectedAttributableCostUsd(tokens, amplification),
      related: packet.related.length,
      files: claims.files.size,
      ceilingBinds: tokens >= policy.ceilingTokens,
      pivotPreserved: authoritativePivot === "" ? null : packet.focus?.at === authoritativePivot,
      goldFile: goldFiles.length === 0 ? null : goldFiles.some((gold) => fileMatches(claims.files, gold)),
      goldSymbol: goldSymbols.length === 0 ? null : goldSymbols.some((symbol) => locals.has(symbol)),
      noRelationEntries: packet.related.filter((r) => r.how === NO_RELATION_PHRASE).length,
    });
  }
}

const rate = (rows: PolicyRow[], pick: (row: PolicyRow) => boolean | null) => {
  const measured = rows.map(pick).filter((v): v is boolean => v !== null);
  return measured.length === 0 ? null : measured.filter(Boolean).length / measured.length;
};

const summary = POLICIES.map((policy) => {
  const rows = byPolicy[policy.name]!;
  const tokens = rows.map((r) => r.tokens);
  const costs = rows.map((r) => r.costUsd).filter((c): c is number => c !== null);
  return {
    policy: policy.name,
    relatedCap: policy.relatedCap,
    excludeUnrelatedNeighbors: policy.excludeUnrelatedNeighbors,
    cases: rows.length,
    medianTokens: median(tokens),
    p90Tokens: percentile(tokens, 90),
    maxTokens: Math.max(...tokens),
    medianCostUsd: costs.length === 0 ? null : median(costs),
    medianRelated: median(rows.map((r) => r.related)),
    totalRelated: rows.reduce((t, r) => t + r.related, 0),
    totalFiles: rows.reduce((t, r) => t + r.files, 0),
    ceilingBindsCases: rows.filter((r) => r.ceilingBinds).length,
    pivotPreserved: rate(rows, (r) => r.pivotPreserved),
    goldFileRate: rate(rows, (r) => r.goldFile),
    goldSymbolRate: rate(rows, (r) => r.goldSymbol),
    noRelationEntriesDelivered: rows.reduce((t, r) => t + r.noRelationEntries, 0),
  };
});

const report = {
  schemaVersion: "stage5.m172.derivation.v1",
  milestone: "M172",
  workstream: "M172-B",
  title: "Admission policy candidates priced on development evidence alone",
  method: {
    corpus: "dev",
    cases: cases.length,
    source: "results/_m171_capture/dev",
    instrument: "m171Contract.modelVisibleTokens and m171Projection.readPacketClaims, unchanged from M171",
    holdoutNotOpened: "no Broad100-A or Broad100-B capture is read by this script",
    goldRole: "DIAGNOSTIC. Gold is reported per policy, never consulted per task to decide admission (§39, §42).",
  },
  identityControl: {
    rule: "§51 — P_M171_R2000 must reproduce m171Projection at R2000 byte for byte before any comparative verdict counts",
    cases: cases.length,
    mismatches: identityMismatches.length,
    pass: identityMismatches.length === 0,
    detail: identityMismatches,
  },
  summary,
  perPolicyCases: byPolicy,
};

writeFileSync(path.join(RESULTS, "stage5_m172_derivation.json"), `${JSON.stringify(report, null, 1)}\n`);

console.log(`identity control: ${identityMismatches.length === 0 ? "PASS" : `FAIL (${identityMismatches.length})`} over ${cases.length} cases`);
console.table(summary.map((s) => ({
  policy: s.policy, cap: s.relatedCap ?? "none", exclFiller: s.excludeUnrelatedNeighbors,
  medTok: s.medianTokens, p90Tok: s.p90Tokens, maxTok: s.maxTokens,
  medRel: s.medianRelated, totRel: s.totalRelated, totFiles: s.totalFiles,
  ceilBinds: s.ceilingBindsCases, pivot: s.pivotPreserved,
  goldFile: s.goldFileRate, goldSym: s.goldSymbolRate, filler: s.noRelationEntriesDelivered,
})));
