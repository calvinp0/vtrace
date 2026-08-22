/**
 * M171-E — holdout qualification for the frozen R2000 contract.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m171_holdout.ts --corpus broad100a
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m171_holdout.ts --corpus broad100b
 *
 * The contract was frozen in `stage5_m171_frozen_selection.json` before this
 * runner was ever executed (§70). Nothing here may change it.
 *
 * Broad100-A contains all twelve development cases, so A is reported twice: the
 * full 100, and the 88-case non-development remainder that carries the primary
 * inference (§32). Broad100-B is disjoint from both and is never tuned against.
 *
 * Offline; reads `results/_m171_capture/<corpus>` only.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  median,
  modelVisibleTokens,
  percentile,
  projectedAttributableCostUsd,
  surfacedFilePaths,
  surfacedSymbols,
} from "./m171Contract";
import { projectOrientation, readPacketClaims, rungByName } from "./m171Projection";
import { auditPacket } from "./m171Soundness";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

const argv = process.argv.slice(2);
const corpus = argv[argv.indexOf("--corpus") + 1] ?? "broad100a";
const CAPTURE = path.join(RESULTS, "_m171_capture", corpus);

const FROZEN = rungByName("R2000");

const DEVELOPMENT_CASES: readonly string[] = Object.freeze([
  "astropy__astropy-14369", "django__django-13658", "matplotlib__matplotlib-22719",
  "mwaskom__seaborn-3187", "pallets__flask-5014", "psf__requests-1724",
  "pydata__xarray-6599", "pylint-dev__pylint-4551", "pytest-dev__pytest-7432",
  "scikit-learn__scikit-learn-10844", "sphinx-doc__sphinx-7462", "sympy__sympy-13480",
]);

/**
 * The M169 ledger's median cache amplification, applied uniformly to holdout
 * cases because no per-case telemetry exists for them.
 *
 * Stated rather than hidden: this makes every holdout dollar a comparison at ONE
 * amplification, not a prediction of a particular run. It is applied identically
 * to the current response and to the packet, so the RATIO between them is exact
 * and only the absolute level depends on the constant.
 */
const HOLDOUT_AMPLIFICATION = 7;

/** A gold symbol is delivered when some surfaced fq name's local part matches it. */
const localPart = (fqName: string): string => {
  const afterPath = fqName.includes("::") ? fqName.slice(fqName.lastIndexOf("::") + 2) : fqName;
  return afterPath.includes(".") ? afterPath.slice(afterPath.lastIndexOf(".") + 1) : afterPath;
};

/** Compare on the path SUFFIX: index paths and fixture paths differ by repo prefix. */
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
  readonly currentCostUsd: number;
  readonly packetCostUsd: number;
  readonly pivotPreserved: boolean | null;
  readonly goldFileCurrent: boolean | null;
  readonly goldFilePacket: boolean | null;
  readonly goldSymbolCurrent: boolean | null;
  readonly goldSymbolPacket: boolean | null;
  readonly currentFiles: number;
  readonly packetFiles: number;
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

  if (output == null) {
    rows.push({
      instanceId, isDevelopment: DEVELOPMENT_CASES.includes(instanceId), delivered: false, state: "NO_OUTPUT",
      currentTokens: modelVisibleTokens(JSON.stringify(envelope).length), packetTokens: 0,
      currentCostUsd: 0, packetCostUsd: 0, pivotPreserved: null,
      goldFileCurrent: null, goldFilePacket: null, goldSymbolCurrent: null, goldSymbolPacket: null,
      currentFiles: 0, packetFiles: 0, violations: 0,
    });
    continue;
  }

  const packet = projectOrientation(output, FROZEN);
  const claims = readPacketClaims(packet);
  const currentFiles = surfacedFilePaths(output);
  const currentSymbols = surfacedSymbols(output);
  const currentTokens = modelVisibleTokens(JSON.stringify(envelope).length);
  const packetTokens = modelVisibleTokens(JSON.stringify(packet).length);
  const productContext = output.productContext as Record<string, unknown> | undefined;
  const authoritativePivot = String(productContext?.leadPivot ?? "");
  const delivered = packet.state === "resolved";

  const symbolDelivered = (surfaced: ReadonlySet<string>): boolean | null => {
    if (goldSymbols.length === 0) return null;
    const locals = new Set([...surfaced].map(localPart));
    return goldSymbols.some((symbol) => locals.has(symbol));
  };

  rows.push({
    instanceId,
    isDevelopment: DEVELOPMENT_CASES.includes(instanceId),
    delivered,
    state: packet.state,
    currentTokens,
    packetTokens,
    currentCostUsd: projectedAttributableCostUsd(currentTokens, HOLDOUT_AMPLIFICATION),
    packetCostUsd: projectedAttributableCostUsd(packetTokens, HOLDOUT_AMPLIFICATION),
    pivotPreserved: authoritativePivot === "" ? null : packet.focus?.at === authoritativePivot,
    goldFileCurrent: goldFiles.length === 0 ? null : goldFiles.some((gold) => fileMatches(currentFiles, gold)),
    goldFilePacket: goldFiles.length === 0 ? null : goldFiles.some((gold) => fileMatches(claims.files, gold)),
    goldSymbolCurrent: symbolDelivered(currentSymbols),
    goldSymbolPacket: symbolDelivered(claims.locations),
    currentFiles: currentFiles.size,
    packetFiles: claims.files.size,
    violations: auditPacket(packet, output).length,
  });
}

// ---- summarize one slice -------------------------------------------

function summarize(label: string, subset: readonly Row[]): Record<string, unknown> {
  const deliveredRows = subset.filter((row) => row.delivered);
  const rate = (predicate: (row: Row) => boolean | null): { delivered: number; measurable: number; rate: number | null } => {
    const measurable = subset.filter((row) => predicate(row) !== null);
    const hit = measurable.filter((row) => predicate(row) === true).length;
    return { delivered: hit, measurable: measurable.length, rate: measurable.length === 0 ? null : hit / measurable.length };
  };
  const goldFileCurrent = rate((row) => row.goldFileCurrent);
  const goldFilePacket = rate((row) => row.goldFilePacket);
  const goldSymbolCurrent = rate((row) => row.goldSymbolCurrent);
  const goldSymbolPacket = rate((row) => row.goldSymbolPacket);
  const pivot = rate((row) => row.pivotPreserved);
  const packetTokens = deliveredRows.map((row) => row.packetTokens);
  const currentTokens = deliveredRows.map((row) => row.currentTokens);

  return {
    slice: label,
    cases: subset.length,
    delivered: deliveredRows.length,
    notDelivered: subset.length - deliveredRows.length,
    stateCounts: subset.reduce<Record<string, number>>((counts, row) => ({ ...counts, [row.state]: (counts[row.state] ?? 0) + 1 }), {}),
    currentTokens: { median: median(currentTokens), p90: percentile(currentTokens, 0.9), max: currentTokens.length === 0 ? 0 : Math.max(...currentTokens) },
    packetTokens: { median: median(packetTokens), p90: percentile(packetTokens, 0.9), max: packetTokens.length === 0 ? 0 : Math.max(...packetTokens) },
    reductionFactor: median(packetTokens) === 0 ? null : median(currentTokens) / median(packetTokens),
    currentProjectedCostUsd: { median: median(deliveredRows.map((row) => row.currentCostUsd)) },
    packetProjectedCostUsd: {
      median: median(deliveredRows.map((row) => row.packetCostUsd)),
      p90: percentile(deliveredRows.map((row) => row.packetCostUsd), 0.9),
    },
    pivotIdentity: pivot,
    goldFile: { current: goldFileCurrent, packet: goldFilePacket, deltaPercentagePoints: goldFileCurrent.rate === null || goldFilePacket.rate === null ? null : 100 * (goldFilePacket.rate - goldFileCurrent.rate) },
    goldSymbol: { current: goldSymbolCurrent, packet: goldSymbolPacket, deltaPercentagePoints: goldSymbolCurrent.rate === null || goldSymbolPacket.rate === null ? null : 100 * (goldSymbolPacket.rate - goldSymbolCurrent.rate) },
    medianFiles: { current: median(deliveredRows.map((row) => row.currentFiles)), packet: median(deliveredRows.map((row) => row.packetFiles)) },
    soundnessViolations: subset.reduce((total, row) => total + row.violations, 0),
  };
}

const slices = corpus === "broad100a"
  ? [
    summarize("broad100a_full", rows),
    summarize("broad100a_non_development_remainder", rows.filter((row) => !row.isDevelopment)),
    summarize("broad100a_development_members", rows.filter((row) => row.isDevelopment)),
  ]
  : [summarize(`${corpus}_full`, rows)];

const body = {
  schemaVersion: "stage5.m171.holdout.v1",
  milestone: "M171",
  workstream: "M171-E",
  corpus,
  title: `Frozen R2000 orientation against ${corpus}, fresh indexes`,
  contractFrozenBefore: "stage5_m171_frozen_selection.json — selected on development evidence, unchanged since",
  rung: FROZEN,
  method: {
    channel: "structuredContent, both arms",
    tokenAuthority: "M166 measured calibration, 0.3174 tokens/character",
    costBasis: `PROJECTED ATTRIBUTABLE COST at a uniform amplification of ${HOLDOUT_AMPLIFICATION} requests (the M169 ledger median). Applied identically to both arms, so the ratio is exact and only the level depends on the constant.`,
    goldMatching: "file paths compared on suffix, because index paths and fixture paths differ by repository prefix; symbols compared on the local part of the fq name",
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

writeFileSync(path.join(RESULTS, `stage5_m171_${corpus}_holdout.json`), `${JSON.stringify(body, null, 1)}\n`);
process.stdout.write(`wrote stage5_m171_${corpus}_holdout.json\n`);
for (const slice of slices) process.stdout.write(`${JSON.stringify(slice, null, 1)}\n`);
