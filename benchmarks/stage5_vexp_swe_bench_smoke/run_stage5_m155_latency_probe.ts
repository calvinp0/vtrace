// Stage 5 M155 — retrieval latency probe.
//
// WHY THIS EXISTS
// ----------------
// `run_stage5_retrieval_eval.ts` scores retrieval QUALITY and records no timing at
// all, so M155 §20/§69 (latency mean/median/p90, and the latency trend across
// architecture eras) cannot be answered from it. Adding timing to that runner would
// change its fingerprint and put a nondeterministic field inside the artifact whose
// semantic hash is the comparison authority.
//
// So this is a SEPARATE read-only pass over the SAME prepared corpus, reusing the
// SAME historical evaluator the paired benchmark uses. It measures the wall time of
// one capsule build per case, per declared implementation root.
//
// Following the M122 convention, latency is reported but never folded into a
// semantic comparison: `stableProjection` there excludes latency fields for exactly
// this reason. Nothing here alters retrieval, ranking, or delivery.
//
// NO Claude, NO Docker, NO agent run, NO API calls, NO network.

import { writeFile } from "node:fs/promises";

import { loadRetrievalFixture } from "./run_stage5_retrieval_eval";
import { createHistoricalEvaluator } from "./run_stage5_m134_historical_replay";

/** Repetitions per case. The per-case statistic is the MEDIAN of these, so a single
 *  scheduler hiccup cannot move the case's contribution to the aggregate. */
const REPETITIONS = 3;

export interface LatencyRow {
  readonly instance_id: string;
  readonly repo: string;
  /** Median of `REPETITIONS` timed builds, milliseconds. */
  readonly median_ms: number;
  readonly samples_ms: readonly number[];
  readonly failed: boolean;
}

export interface LatencySummary {
  readonly label: string;
  readonly implementationRoot: string;
  readonly commit: string;
  readonly cases: number;
  readonly measured: number;
  readonly failed: number;
  readonly repetitions: number;
  readonly mean_ms: number | null;
  readonly median_ms: number | null;
  readonly p90_ms: number | null;
  readonly rows: readonly LatencyRow[];
}

export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank; matches the M122 convention.
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank] ?? null;
}

export function median(values: readonly number[]): number | null {
  return percentile(values, 0.5);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

export async function probeLatency(config: {
  readonly vtraceRoot: string;
  readonly fixture: string;
  readonly label: string;
}): Promise<LatencySummary> {
  const entries = await loadRetrievalFixture(config.fixture);
  const evaluate = await createHistoricalEvaluator(config.vtraceRoot);
  const rows: LatencyRow[] = [];

  for (const entry of entries) {
    const samples: number[] = [];
    let failed = false;
    for (let i = 0; i < REPETITIONS; i += 1) {
      const started = performance.now();
      try {
        await evaluate(entry);
      } catch {
        failed = true;
        break;
      }
      samples.push(performance.now() - started);
    }
    rows.push({
      instance_id: entry.instance_id,
      repo: entry.repo,
      median_ms: failed ? 0 : round(median(samples) ?? 0),
      samples_ms: samples.map(round),
      failed,
    });
  }

  const measured = rows.filter((row) => !row.failed).map((row) => row.median_ms);
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: config.vtraceRoot, stdout: "pipe" })
    .stdout.toString().trim();

  return {
    label: config.label,
    implementationRoot: config.vtraceRoot,
    commit,
    cases: rows.length,
    measured: measured.length,
    failed: rows.length - measured.length,
    repetitions: REPETITIONS,
    mean_ms: measured.length > 0 ? round(mean(measured)!) : null,
    median_ms: measured.length > 0 ? round(median(measured)!) : null,
    p90_ms: measured.length > 0 ? round(percentile(measured, 0.9)!) : null,
    rows,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string => {
    const i = argv.indexOf(flag);
    if (i < 0 || argv[i + 1] === undefined) throw new Error(`${flag} is required.`);
    return argv[i + 1]!;
  };
  const summary = await probeLatency({
    vtraceRoot: get("--vtrace-root"),
    fixture: get("--fixture"),
    label: get("--label"),
  });
  await writeFile(get("--out"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(
    `${summary.label}: measured=${summary.measured}/${summary.cases} median=${summary.median_ms}ms p90=${summary.p90_ms}ms\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
