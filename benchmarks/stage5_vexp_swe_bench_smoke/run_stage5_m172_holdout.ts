/**
 * M172-D — holdout qualification for the frozen P_SUPPLY policy.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m172_holdout.ts --corpus broad100b
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m172_holdout.ts --corpus broad100a
 *
 * ONE policy, evaluated ONCE. It was frozen in `stage5_m172_frozen_policy.json`
 * before this runner existed, on an architectural defect diagnosed in M172-A
 * rather than on any delivery metric — development could not discriminate the
 * candidates on outcomes, so selecting on outcomes would have been selecting on
 * noise. Nothing here may change it (§70), and Broad100-B is not tuned against
 * under any result (§71).
 *
 * Both arms are reported against the SAME two references:
 *
 *   current    the full authoritative response, what the model is handed today
 *   m171       M171's frozen R2000 contract, so the delta attributable to
 *              removing the count cap is separated from the delta attributable
 *              to projecting at all
 *
 * Broad100-A carries all twelve development cases AND is contaminated a second
 * way: M171 reported which three of its cases failed the gold-symbol gate and at
 * what authoritative positions. Its licensing value is therefore spent. It is
 * reported for continuity. BROAD100-B IS THE LICENSING CHECK.
 *
 * Offline; reads `results/_m171_capture/<corpus>` only.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  median, modelVisibleTokens, percentile, projectedAttributableCostUsd,
  surfacedFilePaths, surfacedSymbols,
} from "./m171Contract";
import { projectOrientation, readPacketClaims, rungByName } from "./m171Projection";
import { auditPacket } from "./m171Soundness";
import { P_SUPPLY, packetTokens as m172Tokens, projectOrientationM172 } from "./m172Projection";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

const argv = process.argv.slice(2);
const corpus = argv[argv.indexOf("--corpus") + 1] ?? "broad100b";
const CAPTURE = path.join(RESULTS, "_m171_capture", corpus);

const M171_FROZEN = rungByName("R2000");
const HOLDOUT_AMPLIFICATION = 7;

const DEVELOPMENT_CASES: readonly string[] = Object.freeze([
  "astropy__astropy-14369", "django__django-13658", "matplotlib__matplotlib-22719",
  "mwaskom__seaborn-3187", "pallets__flask-5014", "psf__requests-1724",
  "pydata__xarray-6599", "pylint-dev__pylint-4551", "pytest-dev__pytest-7432",
  "scikit-learn__scikit-learn-10844", "sphinx-doc__sphinx-7462", "sympy__sympy-13480",
]);

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

interface Row {
  readonly instanceId: string;
  readonly isDevelopment: boolean;
  readonly delivered: boolean;
  readonly state: string;
  readonly currentTokens: number;
  readonly packetTokens: number;
  readonly m171Tokens: number;
  readonly currentCostUsd: number;
  readonly packetCostUsd: number;
  readonly pivotPreserved: boolean | null;
  readonly goldFileCurrent: boolean | null;
  readonly goldFilePacket: boolean | null;
  readonly goldFileM171: boolean | null;
  readonly goldSymbolCurrent: boolean | null;
  readonly goldSymbolPacket: boolean | null;
  readonly goldSymbolM171: boolean | null;
  readonly currentFiles: number;
  readonly packetFiles: number;
  readonly relatedSupply: number;
  readonly relatedDelivered: number;
  readonly relatedDeliveredM171: number;
  readonly ceilingBinds: boolean;
  readonly violations: number;
}

const rows: Row[] = [];

for (const file of readdirSync(CAPTURE).filter((name) => name.endsWith(".json")).sort()) {
  const captured = JSON.parse(readFileSync(path.join(CAPTURE, file), "utf-8")) as Record<string, any>;
  const envelope = captured.default?.structuredContent;
  if (envelope == null) continue;
  const output = envelope.result?.output as Record<string, unknown> | undefined;
  const instanceId = String(captured.instanceId);
  const goldFiles: string[] = captured.expectedFiles ?? [];
  const goldSymbols: string[] = captured.expectedSymbols ?? [];
  const currentTokens = modelVisibleTokens(JSON.stringify(envelope).length);

  if (output == null) {
    rows.push({
      instanceId, isDevelopment: DEVELOPMENT_CASES.includes(instanceId), delivered: false, state: "NO_OUTPUT",
      currentTokens, packetTokens: 0, m171Tokens: 0, currentCostUsd: 0, packetCostUsd: 0, pivotPreserved: null,
      goldFileCurrent: null, goldFilePacket: null, goldFileM171: null,
      goldSymbolCurrent: null, goldSymbolPacket: null, goldSymbolM171: null,
      currentFiles: 0, packetFiles: 0, relatedSupply: 0, relatedDelivered: 0, relatedDeliveredM171: 0,
      ceilingBinds: false, violations: 0,
    });
    continue;
  }

  const packet = projectOrientationM172(output, P_SUPPLY);
  const m171Packet = projectOrientation(output, M171_FROZEN);
  const supplyPacket = projectOrientationM172(output, { ...P_SUPPLY, ceilingTokens: Number.MAX_SAFE_INTEGER });
  const claims = readPacketClaims(packet);
  const m171Claims = readPacketClaims(m171Packet);
  const currentFiles = surfacedFilePaths(output);
  const currentSymbols = surfacedSymbols(output);
  const tokens = m172Tokens(packet);
  const authoritativePivot = String((output.productContext as any)?.leadPivot ?? "");

  const symbolIn = (surfaced: ReadonlySet<string>): boolean | null => {
    if (goldSymbols.length === 0) return null;
    const locals = new Set([...surfaced].map(localPart));
    return goldSymbols.some((symbol) => locals.has(symbol));
  };

  rows.push({
    instanceId,
    isDevelopment: DEVELOPMENT_CASES.includes(instanceId),
    delivered: packet.state === "resolved",
    state: packet.state,
    currentTokens,
    packetTokens: tokens,
    m171Tokens: m172Tokens(m171Packet),
    currentCostUsd: projectedAttributableCostUsd(currentTokens, HOLDOUT_AMPLIFICATION),
    packetCostUsd: projectedAttributableCostUsd(tokens, HOLDOUT_AMPLIFICATION),
    pivotPreserved: authoritativePivot === "" ? null : packet.focus?.at === authoritativePivot,
    goldFileCurrent: goldFiles.length === 0 ? null : goldFiles.some((g) => fileMatches(currentFiles, g)),
    goldFilePacket: goldFiles.length === 0 ? null : goldFiles.some((g) => fileMatches(claims.files, g)),
    goldFileM171: goldFiles.length === 0 ? null : goldFiles.some((g) => fileMatches(m171Claims.files, g)),
    goldSymbolCurrent: symbolIn(currentSymbols),
    goldSymbolPacket: symbolIn(claims.locations),
    goldSymbolM171: symbolIn(m171Claims.locations),
    currentFiles: currentFiles.size,
    packetFiles: claims.files.size,
    relatedSupply: supplyPacket.related.length,
    relatedDelivered: packet.related.length,
    relatedDeliveredM171: m171Packet.related.length,
    ceilingBinds: packet.related.length < supplyPacket.related.length,
    violations: auditPacket(packet, output).length,
  });
}

function summarize(label: string, subset: readonly Row[]): Record<string, unknown> {
  const delivered = subset.filter((r) => r.delivered);
  const rate = (pick: (row: Row) => boolean | null) => {
    const measurable = subset.filter((r) => pick(r) !== null);
    const hit = measurable.filter((r) => pick(r) === true).length;
    return { delivered: hit, measurable: measurable.length, rate: measurable.length === 0 ? null : hit / measurable.length };
  };
  const pp = (a: { rate: number | null }, b: { rate: number | null }) =>
    a.rate === null || b.rate === null ? null : 100 * (b.rate - a.rate);

  const goldFileCurrent = rate((r) => r.goldFileCurrent);
  const goldFilePacket = rate((r) => r.goldFilePacket);
  const goldFileM171 = rate((r) => r.goldFileM171);
  const goldSymbolCurrent = rate((r) => r.goldSymbolCurrent);
  const goldSymbolPacket = rate((r) => r.goldSymbolPacket);
  const goldSymbolM171 = rate((r) => r.goldSymbolM171);
  const pk = delivered.map((r) => r.packetTokens);
  const cur = delivered.map((r) => r.currentTokens);

  return {
    slice: label,
    cases: subset.length,
    delivered: delivered.length,
    notDelivered: subset.length - delivered.length,
    stateCounts: subset.reduce<Record<string, number>>((c, r) => ({ ...c, [r.state]: (c[r.state] ?? 0) + 1 }), {}),
    currentTokens: { median: median(cur), p90: percentile(cur, 0.9), max: cur.length === 0 ? 0 : Math.max(...cur) },
    packetTokens: { median: median(pk), p90: percentile(pk, 0.9), max: pk.length === 0 ? 0 : Math.max(...pk) },
    reductionFactor: median(pk) === 0 ? null : median(cur) / median(pk),
    currentProjectedCostUsd: { median: median(delivered.map((r) => r.currentCostUsd)) },
    packetProjectedCostUsd: {
      median: median(delivered.map((r) => r.packetCostUsd)),
      p90: percentile(delivered.map((r) => r.packetCostUsd), 0.9),
    },
    pivotIdentity: rate((r) => r.pivotPreserved),
    goldFile: { current: goldFileCurrent, m171: goldFileM171, packet: goldFilePacket, deltaVsCurrentPp: pp(goldFileCurrent, goldFilePacket), deltaVsM171Pp: pp(goldFileM171, goldFilePacket) },
    goldSymbol: { current: goldSymbolCurrent, m171: goldSymbolM171, packet: goldSymbolPacket, deltaVsCurrentPp: pp(goldSymbolCurrent, goldSymbolPacket), deltaVsM171Pp: pp(goldSymbolM171, goldSymbolPacket) },
    medianFiles: { current: median(delivered.map((r) => r.currentFiles)), packet: median(delivered.map((r) => r.packetFiles)) },
    relatedSupply: {
      median: median(delivered.map((r) => r.relatedSupply)),
      p90: percentile(delivered.map((r) => r.relatedSupply), 0.9),
      max: delivered.length === 0 ? 0 : Math.max(...delivered.map((r) => r.relatedSupply)),
      deliveredMedianM172: median(delivered.map((r) => r.relatedDelivered)),
      deliveredMedianM171: median(delivered.map((r) => r.relatedDeliveredM171)),
      withheldByM171Cap: delivered.reduce((t, r) => t + Math.max(0, r.relatedSupply - r.relatedDeliveredM171), 0),
      withheldByM172Ceiling: delivered.reduce((t, r) => t + Math.max(0, r.relatedSupply - r.relatedDelivered), 0),
    },
    ceilingBindsCases: delivered.filter((r) => r.ceilingBinds).length,
    soundnessViolations: subset.reduce((t, r) => t + r.violations, 0),
  };
}

const slices = corpus === "broad100a"
  ? [
    summarize("broad100a_full", rows),
    summarize("broad100a_non_development_remainder", rows.filter((r) => !r.isDevelopment)),
    summarize("broad100a_development_members", rows.filter((r) => r.isDevelopment)),
  ]
  : [summarize(`${corpus}_full`, rows)];

const body = {
  schemaVersion: "stage5.m172.holdout.v1",
  milestone: "M172",
  workstream: "M172-D",
  corpus,
  title: `Frozen P_SUPPLY orientation against ${corpus}, fresh indexes`,
  policyFrozenBefore: "stage5_m172_frozen_policy.json — selected on the M172-A architectural defect, unchanged since",
  policy: P_SUPPLY,
  role: corpus === "broad100b"
    ? "LICENSING CHECK. Broad100-B is disjoint from development and was not consulted during design. It is not tuned against under any result."
    : "CONTINUITY ONLY, CONTAMINATED TWICE: it contains all twelve development cases, and M171 published which three of its cases failed the gold-symbol gate and at what authoritative positions. Its licensing value is spent.",
  method: {
    channel: "structuredContent, all arms",
    tokenAuthority: "M166 measured calibration, 0.3174 tokens/character",
    costBasis: `PROJECTED ATTRIBUTABLE COST at a uniform amplification of ${HOLDOUT_AMPLIFICATION} requests (the M169 ledger median), applied identically to every arm so the ratio is exact and only the level depends on the constant`,
    references: {
      current: "the full authoritative response — what the model is handed today",
      m171: "M171's frozen R2000 contract, so the effect of removing the count cap is separable from the effect of projecting at all",
    },
    goldMatching: "file paths compared on suffix; symbols compared on the local part of the fq name",
    unmeasurable: "a case with no gold in the fixture is excluded from that rate rather than counted as a miss",
  },
  gates: {
    medianTokensAtOrBelow: 2000,
    p90TokensAtOrBelow: 2500,
    projectedCostAtOrBelowUsd: 0.026219,
    pivotIdentity: 1.0,
    goldFileRegressionAtMostPercentagePoints: 2,
    goldSymbolRegressionAtMostPercentagePoints: 2,
    soundnessViolations: 0,
  },
  slices,
  rows,
};

writeFileSync(path.join(RESULTS, `stage5_m172_${corpus}_holdout.json`), `${JSON.stringify(body, null, 1)}\n`);
process.stdout.write(`wrote stage5_m172_${corpus}_holdout.json\n`);
