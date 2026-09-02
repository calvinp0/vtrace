/**
 * M201 — tail-decile analysis for A5 (§30).
 *
 * A5 is a p90, so the queries that decide it are the slow ones. This ranks every
 * frozen A5 sample, isolates the slowest decile, and reports which query family
 * they belong to and what that family's work profile looks like — candidate and
 * statement counts from the operation ledger, stage split from the profiler.
 *
 * Reported per corpus AND pooled, because the frozen rule bands each corpus
 * separately: a pooled tail dominated by C-LARGE would hide that C-SMALL and
 * C-MED have their own, much lower, p90s.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m201_tail.ts --capture pre_a
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { median, percentile } from "./m197aFixtures";

const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const CAPTURE = argOf("--capture", "pre_a");
const PROFILE = argOf("--profile", "pre");
const OPS = argOf("--opcounts", "pre");

const read = (name: string) => {
  const p = path.join(RESULTS, name);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
const capture = read(`stage5_m201_a5_${CAPTURE}.json`);
if (capture === null) throw new Error(`M201_CAPTURE_MISSING: stage5_m201_a5_${CAPTURE}.json`);
const profile = read(`stage5_m201_profile_${PROFILE}.json`);
const opcounts = read(`stage5_m201_opcounts_${OPS}.json`);

const findOps = (corpus: string, task: string) =>
  (opcounts?.corpora ?? []).find((c: any) => c.id === corpus)?.perQuery
    ?.find((q: any) => q.task === task) ?? null;
const findProfile = (corpus: string, task: string) =>
  (profile?.corpora ?? []).find((c: any) => c.id === corpus)?.perQuery
    ?.find((q: any) => q.task === task) ?? null;

interface Sample { corpus: string; task: string; ms: number }
const samples: Sample[] = [];
const perCorpus: any[] = [];

for (const corpus of capture.corpora ?? []) {
  const corpusSamples: Sample[] = [];
  for (const query of corpus.perQuery ?? []) {
    for (const ms of query.samples ?? []) corpusSamples.push({ corpus: corpus.id, task: query.task, ms });
  }
  samples.push(...corpusSamples);
  const sorted = [...corpusSamples].sort((a, b) => b.ms - a.ms);
  const decile = Math.max(1, Math.ceil(sorted.length * 0.1));
  const slowest = sorted.slice(0, decile);
  const tasksInTail = [...new Set(slowest.map((s) => s.task))];
  perCorpus.push({
    corpus: corpus.id,
    samples: corpusSamples.length,
    p90: corpus.latency?.p90 ?? null,
    p95: corpus.latency?.p95 ?? null,
    median: corpus.latency?.median ?? null,
    slowestDecileSize: decile,
    slowestDecileMinMs: slowest.length === 0 ? null : +Math.min(...slowest.map((s) => s.ms)).toFixed(2),
    tailQueries: tasksInTail.map((task) => {
      const ops = findOps(corpus.id, task);
      const prof = findProfile(corpus.id, task);
      const all = corpusSamples.filter((s) => s.task === task).map((s) => s.ms);
      return {
        task,
        samplesInTail: slowest.filter((s) => s.task === task).length,
        medianMs: +median(all).toFixed(2),
        maxMs: +Math.max(...all).toFixed(2),
        // Why THIS query is slow, in the terms §30 asks for.
        sqlExecutions: ops?.executions ?? null,
        wholeTableScans: ops?.wholeTableScans ?? null,
        worstStatementRepeat: ops?.maxRepeatsOfOneStatement ?? null,
        rowsReturned: ops?.rowsReturned ?? null,
        sqlMs: prof?.sql?.totalSqlMs ?? null,
        sqlSharePercent: prof?.sql?.sqlSharePercent ?? null,
        dominantStage: prof === null ? null
          : (prof.sql?.sqlSharePercent ?? 0) >= 50 ? "sql" : "in-process retrieval",
      };
    }).sort((a, b) => b.medianMs - a.medianMs),
  });
}

const pooled = [...samples].sort((a, b) => b.ms - a.ms);
const pooledDecile = Math.max(1, Math.ceil(pooled.length * 0.1));
const out = {
  milestone: "M201", instrument: "run_stage5_m201_tail.ts",
  capture: CAPTURE, profileSource: PROFILE, opcountSource: OPS,
  rule: "A5 bands each corpus separately, so the decisive tail is each corpus's own slowest decile",
  perCorpus,
  pooled: {
    samples: pooled.length,
    p90: +percentile(samples.map((s) => s.ms), 0.9).toFixed(2),
    slowestDecileSize: pooledDecile,
    corporaRepresented: Object.fromEntries(
      [...new Set(pooled.slice(0, pooledDecile).map((s) => s.corpus))]
        .map((c) => [c, pooled.slice(0, pooledDecile).filter((s) => s.corpus === c).length])),
  },
  bindingCorpus: perCorpus.reduce((worst: any, c: any) =>
    worst === null || (c.p90 ?? 0) > (worst.p90 ?? 0) ? c : worst, null)?.corpus ?? null,
};
writeFileSync(path.join(RESULTS, `stage5_m201_tail_${CAPTURE}.json`), `${JSON.stringify(out, null, 2)}\n`);
for (const c of perCorpus) {
  console.log(`\n${c.corpus}  p90 ${c.p90}  tail floor ${c.slowestDecileMinMs}ms (${c.slowestDecileSize} of ${c.samples} samples)`);
  for (const q of c.tailQueries) {
    console.log(`   ${String(q.medianMs).padStart(8)}ms med / ${String(q.maxMs).padStart(8)}ms max  `
      + `sql ${String(q.sqlMs).padStart(7)}ms (${q.sqlSharePercent}%) execs ${String(q.sqlExecutions).padStart(5)} `
      + `scans ${q.wholeTableScans} worstRepeat ${String(q.worstStatementRepeat).padStart(4)}  ${q.task.slice(0, 40)}`);
  }
}
console.log(`\nbinding corpus: ${out.bindingCorpus}; pooled tail: ${JSON.stringify(out.pooled.corporaRepresented)}`);
console.log(`wrote results/stage5_m201_tail_${CAPTURE}.json`);
