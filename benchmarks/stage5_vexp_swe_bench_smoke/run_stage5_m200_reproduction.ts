/**
 * M200 — pre-change reproduction of the frozen A3 failure (§6, gate G2).
 *
 * The frozen instrument reports two ratios and one verdict. It does not report
 * WHICH guard produced the k=3 full rebuild, and a repair aimed at the wrong
 * guard would still move the ratio — by turning a correctness check off. So this
 * instrument reproduces the frozen A3 sequence exactly (same corpus, same
 * ordering, same `ratioToColdMedian` denominator, same append-a-comment
 * mutation) and additionally names the control path:
 *
 *   guard 1  `planIncrementalRefresh`      — pre-parse, `closure_uncertain`
 *   guard 2  `computeSemanticContextHash`  — post-parse, `closure_uncertain`
 *
 * Both report the same `fullRebuildReason`, so the reason alone cannot separate
 * them. They are separated by asking guard 1 directly, in isolation, for the
 * same change set: if guard 1 already says `full_rebuild`, guard 2 was never
 * consulted and repairing it alone would change nothing.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m200_reproduction.ts \
 *     [--repeats 3] [--corpora C-LARGE] [--scratch <dir>] [--out <name>]
 */
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { indexProject } from "../../src/indexer/indexProject";
import {
  planIncrementalRefresh, type IndexedFileSnapshotSet,
} from "../../src/indexer/incrementalIndex";
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
const SCRATCH = argOf("--scratch", path.join(process.env.TMPDIR ?? "/tmp", "m200-repro"));
const ONLY = argOf("--corpora", "C-LARGE").split(",").map((s) => s.trim());
const OUT = argOf("--out", "stage5_m200_reproduction.json");
mkdirSync(SCRATCH, { recursive: true });

const commentMarker = (spec: { readonly exts: readonly string[] }) =>
  spec.exts.includes(".py") ? "#" : "//";

function openIndexDb(work: string): Database {
  mkdirSync(path.join(work, ".vtrace"), { recursive: true });
  return openIndexerDatabase(path.join(work, ".vtrace", "index.sqlite"));
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const value = await fn();
  return [value, performance.now() - t0];
}

const observed = (result: any) => ({
  mode: result?.performance?.mode ?? null,
  fallbackReason: result?.performance?.fallbackReason ?? null,
  modifiedFiles: result?.performance?.modifiedFiles ?? null,
  parsedFiles: result?.performance?.parsedFiles ?? null,
  affectedClosureFiles: result?.performance?.affectedClosureFiles ?? null,
  totalSymbols: result?.totalSymbols ?? null,
  totalRelationships: result?.totalRelationships ?? null,
});

const corpora: unknown[] = [];

for (const spec of corpusSpecs(REPO).filter((s) => ONLY.includes(s.id))) {
  const source = prepareCorpus(spec, SCRATCH);
  if (source === null) { corpora.push({ id: spec.id, status: "SOURCE_ABSENT" }); continue; }

  const work = path.join(SCRATCH, `timing-${spec.id}`);
  rmSync(work, { recursive: true, force: true });
  cpSync(source, work, { recursive: true, dereference: false,
    filter: (s) => !SKIP_DIRS.has(path.basename(s)) });

  // Cold builds: the frozen denominator.
  const coldMs: number[] = [];
  let snapshot: IndexedFileSnapshotSet | undefined;
  for (let i = 0; i < REPEATS; i += 1) {
    rmSync(path.join(work, ".vtrace"), { recursive: true, force: true });
    const db = openIndexDb(work);
    const [result, ms] = await timed(() => indexProject({ repoRoot: work, db }));
    coldMs.push(ms);
    snapshot = (result as any).snapshot;
    db.close();
  }
  const coldMedian = median(coldMs);

  const db = openIndexDb(work);
  // The frozen sequence takes REPEATS no-op refreshes before the k probes.
  for (let i = 0; i < REPEATS; i += 1) {
    const r: any = await indexProject({ repoRoot: work, db, previousSnapshot: snapshot, hasExistingGraph: true });
    snapshot = r.snapshot ?? snapshot;
  }

  const scanned = (await scanRepo(work)).map((f) => f.path)
    .filter((p) => spec.exts.some((e) => p.endsWith(e))).sort();
  const probes: Record<string, unknown> = {};
  for (const k of [1, 3]) {
    const targets = scanned.slice(0, k);
    for (const rel of targets) {
      const full = path.join(work, rel);
      writeFileSync(full, `${readFileSync(full, "utf8")}\n${commentMarker(spec)} m200 reproduction probe ${k}\n`);
    }
    // Guard 1 in isolation, on the same change set the refresh is about to see.
    const current = await scanRepo(work);
    const guard1 = planIncrementalRefresh({
      requestedMode: "auto", currentFiles: current, previous: snapshot, compatible: true,
    });
    const [result, ms] = await timed(() => indexProject({ repoRoot: work, db,
      previousSnapshot: snapshot, hasExistingGraph: true }));
    snapshot = (result as any).snapshot ?? snapshot;
    probes[`k${k}`] = {
      changedFiles: k, targets,
      guard1: { mode: guard1.mode, fullRebuildReason: guard1.fullRebuildReason ?? null,
        modified: guard1.modified.length, affectedClosureFiles: guard1.affectedClosureFiles.length },
      // Guard 2 only decides anything when guard 1 let an incremental plan through.
      guard2Consulted: guard1.mode === "incremental",
      refresh: observed(result),
      elapsedMs: +ms.toFixed(1),
      ratioToColdMedian: +(ms / coldMedian).toFixed(3),
    };
  }
  db.close();
  corpora.push({ id: spec.id, language: spec.language, repeats: REPEATS,
    coldMedianMs: +coldMedian.toFixed(1), probes });
  for (const k of [1, 3]) {
    const p: any = probes[`k${k}`];
    console.log(`${spec.id} k=${k}  ratio ${p.ratioToColdMedian}  guard1=${p.guard1.mode}`
      + `${p.guard1.fullRebuildReason ? `/${p.guard1.fullRebuildReason}` : ""}`
      + `  guard2Consulted=${p.guard2Consulted}  refresh=${p.refresh.mode}`
      + `${p.refresh.fallbackReason ? `/${p.refresh.fallbackReason}` : ""}`
      + `  parsed=${p.refresh.parsedFiles}`);
  }
}

const payload = {
  milestone: "M200", purpose: "pre-change reproduction of the frozen A3 k=3 full rebuild (§6/G2)",
  generatedFromCommit: (await Bun.$`git -C ${REPO} rev-parse HEAD`.text()).trim(),
  a3Threshold: { match: 0.25, exceed: 0.05, bandRequiresEveryValue: true },
  corpora,
};
writeFileSync(path.join(RESULTS, OUT), `${JSON.stringify(payload, null, 2)}\n`);
console.log(`\nwrote results/${OUT}`);
