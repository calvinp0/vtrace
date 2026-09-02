/**
 * M200 — stage profile of the frozen A3 k=1 and k=3 refreshes (§46).
 *
 * The frozen instrument does not pass `parserVersion`, which is what turns the
 * indexer's stage timings on, so it reports a ratio and no attribution. This
 * runs the same sequence with the value the product itself defaults to — the
 * same string, the same parse-cache key, the same code path — and reports where
 * the time goes. §46 allows optimising only the demonstrated dominant stage, so
 * the demonstration has to exist first.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m200_profile.ts \
 *     [--repeats 3] [--scratch <dir>] [--out <name>]
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { indexProject } from "../../src/indexer/indexProject";
import type { IndexedFileSnapshotSet } from "../../src/indexer/incrementalIndex";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { scanRepo } from "../../src/fs/scanRepo";
import { SKIP_DIRS, corpusSpecs, prepareCorpus, median } from "./m197aFixtures";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const REPEATS = Number.parseInt(argOf("--repeats", "3"), 10);
const SCRATCH = argOf("--scratch", path.join(process.env.TMPDIR ?? "/tmp", "m200prof"));
const OUT = argOf("--out", "stage5_m200_profile.json");
mkdirSync(SCRATCH, { recursive: true });
const PARSER = { parserVersion: "builtin-parser-v1" };

const stages = (result: any) => {
  const t = result?.performance?.timingsMs ?? {};
  const keys = ["discovery", "read", "planning", "parsing", "invalidation", "linking",
    "persistence", "retrievalIndex", "validation", "bookkeeping", "parseCacheWrite", "commit"];
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = +(t[key] ?? 0).toFixed(1);
  out.total = +(t.total ?? 0).toFixed(1);
  out.unattributed = +(out.total - keys.reduce((sum, key) => sum + out[key]!, 0)).toFixed(1);
  return out;
};

const spec = corpusSpecs(REPO).find((s) => s.id === "C-LARGE")!;
const source = prepareCorpus(spec, SCRATCH);
if (source === null) throw new Error("C-LARGE absent");

const work = path.join(SCRATCH, "prof");
rmSync(work, { recursive: true, force: true });
cpSync(source, work, { recursive: true, dereference: false,
  filter: (s) => !SKIP_DIRS.has(path.basename(s)) });

const coldMs: number[] = [];
let snapshot: IndexedFileSnapshotSet | undefined;
for (let i = 0; i < REPEATS; i += 1) {
  rmSync(path.join(work, ".vtrace"), { recursive: true, force: true });
  mkdirSync(path.join(work, ".vtrace"), { recursive: true });
  const db = openIndexerDatabase(path.join(work, ".vtrace", "index.sqlite"));
  const t0 = performance.now();
  const result: any = await indexProject({ repoRoot: work, db, ...PARSER });
  coldMs.push(performance.now() - t0);
  snapshot = result.snapshot;
  db.close();
}
const coldMedian = median(coldMs);

mkdirSync(path.join(work, ".vtrace"), { recursive: true });
const db = openIndexerDatabase(path.join(work, ".vtrace", "index.sqlite"));
for (let i = 0; i < REPEATS; i += 1) {
  const noop: any = await indexProject({ repoRoot: work, db,
    previousSnapshot: snapshot, hasExistingGraph: true, ...PARSER });
  snapshot = noop.snapshot ?? snapshot;
}
const scanned = (await scanRepo(work)).map((f) => f.path)
  .filter((p) => spec.exts.some((e) => p.endsWith(e))).sort();

const probes: Record<string, unknown> = {};
for (const k of [1, 3]) {
  for (const rel of scanned.slice(0, k)) {
    const full = path.join(work, rel);
    writeFileSync(full, `${readFileSync(full, "utf8")}\n# m200 profile probe ${k}\n`);
  }
  const t0 = performance.now();
  const result: any = await indexProject({ repoRoot: work, db,
    previousSnapshot: snapshot, hasExistingGraph: true, ...PARSER });
  const ms = performance.now() - t0;
  snapshot = result.snapshot ?? snapshot;
  const stageMs = stages(result);
  probes[`k${k}`] = {
    targets: scanned.slice(0, k), elapsedMs: +ms.toFixed(1),
    ratioToColdMedian: +(ms / coldMedian).toFixed(3),
    mode: result.performance?.mode, parsedFiles: result.performance?.parsedFiles,
    parseCacheHits: result.performance?.parseCacheHits,
    parseCacheMisses: result.performance?.parseCacheMisses,
    affectedClosureFiles: result.performance?.affectedClosureFiles,
    graphRowsDeleted: result.performance?.graphRowsDeleted,
    graphRowsInserted: result.performance?.graphRowsInserted,
    bindingClosure: result.performance?.bindingClosure ?? null,
    stagesMs: stageMs,
    dominantStage: Object.entries(stageMs)
      .filter(([key]) => key !== "total" && key !== "unattributed")
      .sort((a, b) => b[1] - a[1])[0],
  };
  const top = Object.entries(stageMs).filter(([key]) => key !== "total")
    .sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(`k=${k} ${(+(ms).toFixed(0))}ms ratio ${(ms / coldMedian).toFixed(3)} `
    + `mode=${result.performance?.mode} parsed=${result.performance?.parsedFiles}`);
  console.log(`     ${top.map(([key, value]) => `${key}=${value}`).join("  ")}`);
}
db.close();
rmSync(work, { recursive: true, force: true });

writeFileSync(path.join(RESULTS, OUT), `${JSON.stringify({
  milestone: "M200", instrument: "run_stage5_m200_profile.ts",
  purpose: "stage attribution for the frozen A3 k=1 and k=3 refreshes",
  generatedFromCommit: (await Bun.$`git -C ${REPO} rev-parse HEAD`.text()).trim(),
  corpus: spec.id, repeats: REPEATS, coldMedianMs: +coldMedian.toFixed(1), probes,
}, null, 2)}\n`);
console.log(`\nwrote results/${OUT}`);
