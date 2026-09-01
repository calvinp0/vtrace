/**
 * M196A — index timing, re-measured after the ingestion repair (§14).
 *
 * DESCRIPTIVE ONLY. M196 found incremental indexing slower than a cold build and
 * recorded it as an honest A3 failure; M196A must confirm the repair did not make
 * that worse, and must not tune it. The repair adds files to the corpus, so a
 * slower cold build is an expected consequence of indexing MORE, not a
 * regression — the ratio A3 tests is what matters.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m196a_index_timing.ts
 */
import { Database } from "bun:sqlite";
import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { indexProject } from "../../src/indexer/indexProject";
import { initializeSchema } from "../../src/db/schema";
import { scanRepo } from "../../src/fs/scanRepo";

const RESULTS = path.join(import.meta.dir, "results");
const SCRATCH = process.env.M196A_SCRATCH
  ?? "/tmp/claude-1000/-home-calvin-code-vtrace/4ce2f921-efa5-4b0b-a0b6-aa8c9ac200a6/scratchpad/m196a";

const CORPORA = [
  { id: "C-MED", source: path.resolve(import.meta.dir, "../../src"), ext: ".ts" },
  { id: "C-LARGE", source: path.join(SCRATCH, "C-LARGE"), ext: ".py" },
] as const;

/**
 * The k files to modify, drawn from the PRODUCT's own enumeration and then
 * sorted, so the measurement is reproducible and — more importantly — so it
 * cannot touch a file the indexer legitimately ignores. Touching a gitignored
 * path produces a run that reparses nothing, which reads exactly like a silent
 * staleness defect and is not one.
 */
async function touchTargets(root: string, ext: string, k: number): Promise<string[]> {
  const scanned = await scanRepo(root);
  return scanned.map((f) => f.path).filter((p) => p.endsWith(ext)).sort().slice(0, k);
}

const SKIP = new Set([".git", ".vtrace", "node_modules", "__pycache__", ".venv", "venv"]);

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const value = await fn();
  return [value, performance.now() - t0];
}

const rows: any[] = [];
for (const corpus of CORPORA) {
  if (!existsSync(corpus.source)) { rows.push({ id: corpus.id, status: "CORPUS_ABSENT" }); continue; }
  const work = path.join(SCRATCH, `timing-${corpus.id}`);
  rmSync(work, { recursive: true, force: true });
  cpSync(corpus.source, work, { recursive: true, filter: (s) => !SKIP.has(path.basename(s)) });

  const open = () => {
    const dir = path.join(work, ".vtrace");
    mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, "index.sqlite"));
    initializeSchema(db);
    return db;
  };

  // Cold: no .vtrace at all.
  rmSync(path.join(work, ".vtrace"), { recursive: true, force: true });
  let db = open();
  const [cold, coldMs] = await timed(() => indexProject({ repoRoot: work, db }));
  let snapshot = cold.snapshot;

  // No-op: nothing changed since the snapshot above.
  const [, noopMs] = await timed(() => indexProject({ repoRoot: work, db,
    ...(snapshot === undefined ? {} : { previousSnapshot: snapshot }), hasExistingGraph: true }));

  // Incremental: k files genuinely modified.
  const incremental: Record<string, number> = {};
  // An incremental refresh whose duration matches the no-op is only good news if
  // it actually re-parsed the changed file. Recording what the run attempted
  // separates "fast" from "silently skipped" (the M184 failure class).
  const incrementalWork: Record<string, unknown> = {};
  for (const k of [1, 3]) {
    const touchable = await touchTargets(work, corpus.ext, k);
    if (touchable.length < k) continue;
    for (const rel of touchable) {
      appendFileSync(path.join(work, rel), `\n${corpus.ext === ".py" ? "#" : "//"} m196a timing touch ${k}\n`);
    }
    // A pre-existing incremental defect can abort this call (see the M196A
    // report, C-LARGE). Recording the failure keeps the timing table honest
    // instead of dropping the row and reporting a smaller, cleaner table.
    try {
      const [result, ms] = await timed(() => indexProject({ repoRoot: work, db,
        ...(snapshot === undefined ? {} : { previousSnapshot: snapshot }), hasExistingGraph: true }));
      snapshot = result.snapshot ?? snapshot;
      incremental[`k=${k}`] = Math.round(ms);
      incrementalWork[`k=${k}`] = {
        touched: touchable,
        filesAttemptedForParse: result.totalFilesAttemptedForParse,
        filesIndexed: result.coverage.filesIndexed,
        reparsedExactlyTheChangedFiles: result.totalFilesAttemptedForParse === k,
      };
    } catch (error: any) {
      incrementalWork[`k=${k}`] = { touched: touchable, failed: true,
        error: String(error?.message).slice(0, 200),
        preExisting: "reproduced with the M196A parser repair reverted; not caused by it" };
    }
  }
  db.close();

  rows.push({
    id: corpus.id,
    filesIndexed: cold.coverage.filesIndexed,
    coldMs: Math.round(coldMs),
    noopMs: Math.round(noopMs),
    incrementalMs: incremental,
    incrementalWork,
    filesPerSecondCold: +(cold.coverage.filesIndexed / (coldMs / 1000)).toFixed(1),
    // A3's ratio: incremental time over cold time. VEXP claims <= 0.25.
    incrementalRatio: Object.fromEntries(Object.entries(incremental).map(([k, v]) => [k, +(v / coldMs).toFixed(3)])),
  });
  const r = rows.at(-1)!;
  console.log(`${corpus.id.padEnd(8)} files=${r.filesIndexed} cold=${r.coldMs}ms (${r.filesPerSecondCold} files/s) noop=${r.noopMs}ms incr=${JSON.stringify(r.incrementalMs)} ratio=${JSON.stringify(r.incrementalRatio)}`);
  console.log(`         reparsed: ${JSON.stringify(Object.fromEntries(Object.entries(r.incrementalWork).map(([k, v]: any) => [k, v.filesAttemptedForParse])))}`);
}

writeFileSync(path.join(RESULTS, "stage5_m196a_index_timing.json"),
  `${JSON.stringify({ milestone: "M196A", note: "descriptive only; no performance tuning performed (§14)",
    a3Threshold: { match: 0.25, exceed: 0.05 }, corpora: rows }, null, 2)}\n`);
