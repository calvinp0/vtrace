/**
 * M201 — turn a `bun --cpu-prof` profile of the A5 path into stage attribution (§7).
 *
 * The SQL profiler accounts for statement time; this accounts for the rest, which
 * on C-LARGE is most of it. Self time is summed per call frame from the sample
 * stream; inclusive time for a named frame is the self time of every sample with
 * that frame anywhere on its stack.
 *
 * The profiled process also builds the index, so frames such as `spawnSync` and
 * `copyFileSync` belong to indexing and not to a query. The named product frames
 * below are reachable only from a query, which is why they are reported and the
 * process total is not treated as the query total.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m201_cpuprof_analyze.ts \
 *     --profile <file.cpuprofile> --calls 40 --label pre
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.join(import.meta.dir, "results");
const REPO = path.resolve(import.meta.dir, "../..");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const PROFILE = argOf("--profile", "");
const CALLS = Number.parseInt(argOf("--calls", "40"), 10);
const LABEL = argOf("--label", "pre");
const CORPUS = argOf("--corpus", "C-LARGE");

if (PROFILE === "") throw new Error("M201_PROFILE_REQUIRED: pass --profile <file.cpuprofile>");
const profile = JSON.parse(readFileSync(PROFILE, "utf8"));

const nodes = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]));
const parent = new Map<number, number>();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);

const selfMicros = new Map<number, number>();
profile.samples.forEach((id: number, i: number) => {
  selfMicros.set(id, (selfMicros.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
});
const label = (id: number): string => {
  const frame = nodes.get(id)?.callFrame ?? {};
  const url = String(frame.url ?? "").replace(REPO, "");
  return `${frame.functionName || "(anonymous)"} ${url}:${(frame.lineNumber ?? -1) + 1}`;
};
const totalMicros = [...selfMicros.values()].reduce((a, b) => a + b, 0);

/** Self time of every sample whose stack carries `name` anywhere. */
function inclusiveMicros(name: string): number {
  let total = 0;
  for (const [id, micros] of selfMicros) {
    let cursor: number | undefined = id;
    while (cursor !== undefined) {
      if (label(cursor).startsWith(`${name} `)) { total += micros; break; }
      cursor = parent.get(cursor);
    }
  }
  return total;
}

/**
 * The stages of the timed path, outermost first. Named rather than derived so
 * the attribution is a claim about the pipeline's structure that a reader can
 * check against the code, not a top-N list that reshuffles between profiles.
 */
const STAGES = [
  "runPipelineOrchestrator", "buildAuthoritativeProductRetrieval", "buildCapsuleV2",
  "hybridRetrieve", "lexicalCandidates", "queryBroadCandidates", "searchSymbolsPlainSql",
  "conceptOwnerCandidates", "retrieveConceptOwners", "listAllSymbols",
  "upstreamRescueCandidates", "assemble", "assembleProductContext", "addImpactEvidence",
  "getImpactGraph", "addMemoryAndRules", "buildPivotNeighborhoods", "projectAuthoritativeCapsule",
  "retrieveIndexedDocuments",
];

const perStage = STAGES.map((name) => {
  const micros = inclusiveMicros(name);
  return {
    stage: name,
    inclusiveMs: +(micros / 1000).toFixed(1),
    msPerQuery: +(micros / 1000 / CALLS).toFixed(2),
    percentOfSamples: +(100 * micros / totalMicros).toFixed(2),
  };
}).filter((row) => row.inclusiveMs > 0).sort((a, b) => b.inclusiveMs - a.inclusiveMs);

const selfByFrame = new Map<string, number>();
for (const [id, micros] of selfMicros) selfByFrame.set(label(id), (selfByFrame.get(label(id)) ?? 0) + micros);
const topSelf = [...selfByFrame.entries()]
  .sort((a, b) => b[1] - a[1]).slice(0, 25)
  .map(([frame, micros]) => ({
    frame, selfMs: +(micros / 1000).toFixed(1),
    msPerQuery: +(micros / 1000 / CALLS).toFixed(2),
    percentOfSamples: +(100 * micros / totalMicros).toFixed(2),
  }));

const out = {
  milestone: "M201", instrument: "run_stage5_m201_cpuprof_analyze.ts", label: LABEL, corpus: CORPUS,
  profile: PROFILE, profiledCalls: CALLS,
  samplingIntervalMicros: profile.samples.length > 0 ? Math.round(totalMicros / profile.samples.length) : null,
  totalSampledMs: +(totalMicros / 1000).toFixed(1),
  note: "the profiled process also built the index; frames reachable only from a query are reported, "
    + "and the process total is NOT the query total",
  stages: perStage,
  topSelfTime: topSelf,
};
writeFileSync(path.join(RESULTS, `stage5_m201_cpu_stages_${LABEL}_${CORPUS}.json`), `${JSON.stringify(out, null, 2)}\n`);
console.log(`${"stage".padEnd(38)} ${"ms/query".padStart(9)} ${"incl ms".padStart(9)}  % samples`);
for (const row of perStage) {
  console.log(`${row.stage.padEnd(38)} ${String(row.msPerQuery).padStart(9)} ${String(row.inclusiveMs).padStart(9)}  ${row.percentOfSamples}`);
}
console.log(`\nwrote results/stage5_m201_cpu_stages_${LABEL}_${CORPUS}.json`);
