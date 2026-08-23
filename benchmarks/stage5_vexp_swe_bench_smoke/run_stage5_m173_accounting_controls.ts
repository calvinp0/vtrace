/**
 * M173-A — prove the runtime accounting works BEFORE it is used to price
 * anything, on a corpus whose right answer is already known.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m173_accounting_controls.ts
 *
 * §21/§22. M169 found the harness had been summing `message.usage` once per
 * streamed CONTENT BLOCK, inflating cache reads ~2.65x and cache creation ~2.9x
 * and reducing `outputTokens` to a count of streaming placeholders. Every M173
 * economic figure rests on not repeating that, so the corrected path is
 * exercised here against M168's 36 completed runs, where the provider's own
 * `total_cost_usd` is the answer key.
 *
 * Three controls, and the second is the one that matters most:
 *
 *   POSITIVE   the deduplicated reconstruction plus the billing identity
 *              reproduces `total_cost_usd` on every uncensored run
 *   DISCRIMINATING  the NAIVE per-block summation does NOT. A control that
 *              passes on the broken path as well as the fixed one certifies
 *              nothing, and this repository has shipped four of those since
 *              M167 — so the naive path is run deliberately and required to
 *              fail.
 *   INFLATION  the canonical result row's own token fields are reported
 *              against the reconstruction, so nothing downstream is tempted to
 *              read them as truth.
 *
 * Offline. Reads captured artifacts only.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  Censoring,
  OPUS_4_5_PRICING,
  censoringOf,
  checkBillingIdentity,
  checkCacheIdentity,
  parseRun,
  priceUsage,
  reconstructInputSide,
  type ParsedRun,
} from "./m169Economics";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const RUNS = path.join(RESULTS, "runs");

/** The reference corpus: M168's completed runs, whose costs the provider settled. */
const REFERENCE_PREFIX = "m168_";

function rawDir(label: string): string | null {
  const parent = path.join(RUNS, label, "raw");
  if (!existsSync(parent)) return null;
  for (const child of readdirSync(parent)) {
    const dir = path.join(parent, child);
    if (readdirSync(dir).some((f) => f.startsWith("swebench-") && f.endsWith(".jsonl"))) return dir;
  }
  return null;
}

interface Loaded {
  readonly label: string;
  readonly parsed: ParsedRun;
  readonly lines: readonly string[];
  readonly rowInputTokens: number;
  readonly rowOutputTokens: number;
  readonly rowCacheReadTokens: number;
  readonly rowCacheCreationTokens: number;
}

function load(label: string): Loaded | null {
  const raw = rawDir(label);
  if (raw === null) return null;
  const stream = path.join(raw, "_agent_stream.first_pass.jsonl");
  if (!existsSync(stream)) return null;
  const rowFile = readdirSync(raw).find((f) => f.startsWith("swebench-") && f.endsWith(".jsonl"))!;
  const line = readFileSync(path.join(raw, rowFile), "utf-8").split("\n").find((l) => l.trim());
  if (line === undefined) return null;
  const row = JSON.parse(line) as Record<string, unknown>;
  const lines = readFileSync(stream, "utf-8").split("\n");
  return {
    label,
    parsed: parseRun(lines),
    lines,
    rowInputTokens: Number(row.inputTokens ?? 0),
    rowOutputTokens: Number(row.outputTokens ?? 0),
    rowCacheReadTokens: Number(row.cacheReadTokens ?? 0),
    rowCacheCreationTokens: Number(row.cacheCreationTokens ?? 0),
  };
}

/**
 * The DEFECT, reimplemented on purpose: sum `message.usage` over every streamed
 * assistant event without deduplicating on `message.id`. If this reproduced the
 * provider too, the corrected path would be unfalsifiable.
 */
function naiveInputSide(lines: readonly string[]): {
  inputTokens: number; cacheCreationTokens: number; cacheReadTokens: number;
} {
  let inputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (row.type !== "assistant") continue;
    const usage = ((row.message as Record<string, unknown> | undefined)?.usage ?? {}) as Record<string, unknown>;
    const num = (key: string): number => {
      const value = usage[key];
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    };
    inputTokens += num("input_tokens");
    cacheCreationTokens += num("cache_creation_input_tokens");
    cacheReadTokens += num("cache_read_input_tokens");
  }
  return { inputTokens, cacheCreationTokens, cacheReadTokens };
}

const labels = existsSync(RUNS)
  ? readdirSync(RUNS).filter((l) => l.startsWith(REFERENCE_PREFIX)).sort()
  : [];
const loaded = labels.map(load).filter((r): r is Loaded => r !== null);

const rows = loaded.map((run) => {
  const censoring = censoringOf(run.parsed);
  const reconstructed = reconstructInputSide(run.parsed.requests);
  const provider = run.parsed.result?.usage ?? null;
  const reportedUsd = run.parsed.result?.costUsd ?? null;

  const identity = provider === null
    ? null
    : checkBillingIdentity(provider, reportedUsd, OPUS_4_5_PRICING, 1e-9);

  // The naive path, priced with the same identity. Output is taken from the
  // provider so the ONLY difference between the two figures is the input-side
  // summation — otherwise the comparison would confound two defects.
  const naive = naiveInputSide(run.lines);
  const naiveUsd = priceUsage({
    inputTokens: naive.inputTokens,
    // The naive path cannot see the 1h/5m split either; it is priced at the 1h
    // rate so it is given the most favourable reading available to it.
    cacheCreation1hTokens: naive.cacheCreationTokens,
    cacheCreation5mTokens: 0,
    cacheReadTokens: naive.cacheReadTokens,
    outputTokens: provider?.outputTokens ?? null,
  }, OPUS_4_5_PRICING);

  const cacheIdentity = checkCacheIdentity(run.parsed.requests);

  return {
    label: run.label,
    censoring,
    requests: run.parsed.requests.length,
    reportedUsd,
    billingIdentityHolds: identity?.holds ?? false,
    billingIdentityDeltaUsd: identity?.deltaUsd ?? null,
    naiveUsd: Number(naiveUsd.toFixed(6)),
    naiveDeltaUsd: reportedUsd === null ? null : Number(Math.abs(naiveUsd - reportedUsd).toFixed(6)),
    naiveReproducesProvider: reportedUsd !== null && Math.abs(naiveUsd - reportedUsd) <= 1e-9,
    cacheIdentityHolds: cacheIdentity.holdsEverywhere,
    reconstructedCacheReadTokens: reconstructed.cacheReadTokens,
    rowCacheReadTokens: run.rowCacheReadTokens,
    rowCacheReadInflation: reconstructed.cacheReadTokens === 0
      ? null : Number((run.rowCacheReadTokens / reconstructed.cacheReadTokens).toFixed(3)),
    reconstructedCacheCreationTokens: reconstructed.cacheCreation1hTokens + reconstructed.cacheCreation5mTokens,
    rowCacheCreationTokens: run.rowCacheCreationTokens,
    rowCacheCreationInflation: (reconstructed.cacheCreation1hTokens + reconstructed.cacheCreation5mTokens) === 0
      ? null
      : Number((run.rowCacheCreationTokens / (reconstructed.cacheCreation1hTokens + reconstructed.cacheCreation5mTokens)).toFixed(3)),
    providerOutputTokens: provider?.outputTokens ?? null,
    rowOutputTokens: run.rowOutputTokens,
  };
});

const uncensored = rows.filter((r) => r.censoring === Censoring.Uncensored);
const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(middle)]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const positiveControl = {
  name: "CORRECTED_PATH_REPRODUCES_THE_PROVIDER",
  runsChecked: uncensored.length,
  held: uncensored.filter((r) => r.billingIdentityHolds).length,
  toleranceUsd: 1e-9,
  passes: uncensored.length > 0 && uncensored.every((r) => r.billingIdentityHolds),
};

const discriminatingControl = {
  name: "NAIVE_PER_BLOCK_SUMMATION_MUST_FAIL",
  why:
    "a control that also passes on the defective path certifies nothing. M167's rule, "
    + "and the fourth repeat of the same defect shape was caught by a number that looked "
    + "too good rather than by a test.",
  runsChecked: uncensored.length,
  runsWhereNaiveAlsoReproducedProvider: uncensored.filter((r) => r.naiveReproducesProvider).length,
  medianNaiveErrorUsd: median(uncensored.map((r) => r.naiveDeltaUsd ?? 0)),
  maxNaiveErrorUsd: uncensored.length === 0 ? null : Math.max(...uncensored.map((r) => r.naiveDeltaUsd ?? 0)),
  passes: uncensored.length > 0 && uncensored.every((r) => !r.naiveReproducesProvider),
};

const inflationControl = {
  name: "CANONICAL_ROW_TOKEN_FIELDS_ARE_NOT_AUTHORITY",
  medianCacheReadInflation: median(uncensored.map((r) => r.rowCacheReadInflation).filter((v): v is number => v !== null)),
  medianCacheCreationInflation: median(uncensored.map((r) => r.rowCacheCreationInflation).filter((v): v is number => v !== null)),
  runsWhereRowOutputUnderstatesProvider: uncensored.filter(
    (r) => r.providerOutputTokens !== null && r.rowOutputTokens < r.providerOutputTokens,
  ).length,
  passes: true,
  note: "reported so nothing downstream reads the row's token fields as runtime truth (§20)",
};

const cacheIdentityControl = {
  name: "CACHE_IDENTITY_LICENSES_ATTRIBUTION",
  runsChecked: rows.length,
  held: rows.filter((r) => r.cacheIdentityHolds).length,
  note:
    "everything request n writes to cache, request n+1 reads back. Where it fails the "
    + "appended-token figure for that step is not derivable and the run is excluded from "
    + "attribution rather than estimated.",
  passes: rows.length > 0,
};

const controls = [positiveControl, discriminatingControl, inflationControl, cacheIdentityControl];
const allPass = controls.every((c) => c.passes);

const report = {
  schemaVersion: "stage5.m173.accounting-controls.v1",
  milestone: "M173",
  workstream: "M173-A",
  referenceCorpus: {
    prefix: REFERENCE_PREFIX,
    runsFound: loaded.length,
    uncensored: uncensored.length,
    censored: rows.length - uncensored.length,
    why: "M168's completed runs are the only corpus where the provider has already settled the answer",
  },
  pricing: OPUS_4_5_PRICING,
  accountingPath: {
    module: "m169Economics.parseRun / reconstructInputSide / checkBillingIdentity",
    deduplicationKey: "message.id",
    outputAuthority: "the terminal result event only; per-request output is a streaming placeholder",
  },
  controls,
  allPass,
  perRun: rows,
};

writeFileSync(
  path.join(RESULTS, "stage5_m173_accounting_controls.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

console.log(`accounting controls over ${loaded.length} reference runs (${uncensored.length} uncensored)`);
for (const control of controls) console.log(`  ${control.passes ? "PASS" : "FAIL"}  ${control.name}`);
console.log(`  billing identity held ${positiveControl.held}/${positiveControl.runsChecked}`);
console.log(`  naive summation reproduced the provider on ${discriminatingControl.runsWhereNaiveAlsoReproducedProvider}/${discriminatingControl.runsChecked} (must be 0)`);
console.log(`  median row cache-read inflation ${inflationControl.medianCacheReadInflation}x`);
process.exit(allPass ? 0 : 1);
