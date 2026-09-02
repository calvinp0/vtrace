/**
 * M199 — incremental persistence profile and write-amplification report.
 *
 * Reproduces the frozen A3 sequence (§5) and, in a SEPARATE pass, counts the
 * rows a refresh writes (§7). The two are never taken from the same run: the
 * accounting triggers cost real time, and a latency number measured with them
 * installed would be a number about the instrument.
 *
 * The timing pass mirrors `run_stage5_m197a_indexing.ts` exactly — same corpora,
 * same ordering, same `ratioToColdMedian` denominator — because a "before"
 * measured a different way is not a before.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m199_persistence.ts \
 *     [--repeats 3] [--corpora C-MED,C-LARGE] [--scratch <dir>] [--out <name>]
 */
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { indexProject } from "../../src/indexer/indexProject";
import type { IndexedFileSnapshotSet } from "../../src/indexer/incrementalIndex";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { scanRepo } from "../../src/fs/scanRepo";
import { SKIP_DIRS, corpusSpecs, prepareCorpus, median } from "./m197aFixtures";
import {
  ACCOUNTED_TABLES, FTS_TABLES, accountRefresh, affectedSemanticRows, installWriteCounters,
  semanticWritesAreBounded, type RefreshWriteAccounting,
} from "./m199PersistenceAccounting";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const REPEATS = Number.parseInt(argOf("--repeats", "3"), 10);
const SCRATCH = argOf("--scratch", path.join(process.env.TMPDIR ?? "/tmp", "m199"));
const ONLY = argOf("--corpora", "C-SMALL,C-MED,C-LARGE").split(",").map((s) => s.trim());
const OUT = argOf("--out", "stage5_m199_persistence.json");
mkdirSync(SCRATCH, { recursive: true });

const commentMarker = (spec: { readonly exts: readonly string[] }) =>
  spec.exts.includes(".py") ? "#" : "//";

const loadAverage = () => {
  try { return readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number); }
  catch { return []; }
};

function openIndexDb(work: string): Database {
  mkdirSync(path.join(work, ".vtrace"), { recursive: true });
  return openIndexerDatabase(path.join(work, ".vtrace", "index.sqlite"));
}

/**
 * `indexProject` zeroes its stage timings unless `parserVersion` is passed, so
 * the frozen A3 instrument — which does not pass it — records no attribution at
 * all. Passing the value the product itself defaults to turns the diagnostics on
 * and changes nothing else: it is the same string, through the same parse-cache
 * key, on the same code path.
 */
export const DEFAULT_PARSER_VERSION = "builtin-parser-v1";

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const value = await fn();
  return [value, performance.now() - t0];
}

/** A copy of the corpus that nothing else has touched. */
function freshWork(spec: { id: string }, source: string, tag: string): string {
  const work = path.join(SCRATCH, `${tag}-${spec.id}`);
  rmSync(work, { recursive: true, force: true });
  cpSync(source, work, { recursive: true, dereference: false,
    filter: (s) => !SKIP_DIRS.has(path.basename(s)) });
  return work;
}

const appendProbe = (full: string, marker: string, tag: string) =>
  writeFileSync(full, `${readFileSync(full, "utf8")}\n${marker} m199 probe ${tag}\n`);

const stage = (result: any) => {
  const t = result?.performance?.timingsMs ?? {};
  return {
    discovery: +(t.discovery ?? 0).toFixed(1), planning: +(t.planning ?? 0).toFixed(1),
    parsing: +(t.parsing ?? 0).toFixed(1), invalidation: +(t.invalidation ?? 0).toFixed(1),
    linking: +(t.linking ?? 0).toFixed(1), persistence: +(t.persistence ?? 0).toFixed(1),
    retrievalIndex: +(t.retrievalIndex ?? 0).toFixed(1), validation: +(t.validation ?? 0).toFixed(1),
    total: +(t.total ?? 0).toFixed(1),
  };
};

const modeOf = (result: any) => ({
  mode: result?.performance?.mode, fallbackReason: result?.performance?.fallbackReason ?? null,
  parsedFiles: result?.performance?.parsedFiles,
  modifiedFiles: result?.performance?.modifiedFiles,
  affectedClosureFiles: result?.performance?.affectedClosureFiles,
  totalSymbols: result?.totalSymbols, totalRelationships: result?.totalRelationships,
});

/** Live rows in the semantic graph, the denominator F1's bound is taken against. */
function liveSemanticRows(db: Database): number {
  return ["files", "symbols", "edges", "edge_call_sites", "symbol_mechanism_facts", "document_chunks"]
    .reduce((total, table) =>
      total + (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c, 0);
}

const specs = corpusSpecs(REPO).filter((s) => ONLY.includes(s.id));
const startLoad = loadAverage();
console.log(`load average at start: ${startLoad.join(" ")} (${navigator.hardwareConcurrency} cpus)`);

const corpora: any[] = [];

for (const spec of specs) {
  const prepared = prepareCorpus(spec, SCRATCH);
  if (prepared === null) { corpora.push({ id: spec.id, status: "CORPUS_ABSENT" }); continue; }
  const marker = commentMarker(spec);

  // ------------------------------------------------------------ timing pass
  const timingWork = freshWork(spec, prepared, "timing");
  const coldMs: number[] = [];
  const coldStages: any[] = [];
  let snapshot: IndexedFileSnapshotSet | undefined;
  let filesIndexed = 0;
  let coldIndexBytes = 0;
  {
    for (let i = 0; i < REPEATS; i += 1) {
      rmSync(path.join(timingWork, ".vtrace"), { recursive: true, force: true });
      const db = openIndexDb(timingWork);
      const [result, ms] = await timed(() => indexProject({ repoRoot: timingWork, db, parserVersion: DEFAULT_PARSER_VERSION }));
      coldMs.push(ms); coldStages.push(stage(result));
      filesIndexed = (result as any).totalFilesSuccessfullyIndexed;
      snapshot = (result as any).snapshot;
      db.close();
      coldIndexBytes = statSync(path.join(timingWork, ".vtrace/index.sqlite")).size;
    }
  }
  const coldMedian = median(coldMs);

  const db = openIndexDb(timingWork);
  const noopMs: number[] = [];
  const noopStages: any[] = [];
  let noopMode: any = null;
  for (let i = 0; i < REPEATS; i += 1) {
    const [result, ms] = await timed(() => indexProject({ repoRoot: timingWork, db, parserVersion: DEFAULT_PARSER_VERSION,
      ...(snapshot === undefined ? {} : { previousSnapshot: snapshot }), hasExistingGraph: true }));
    noopMs.push(ms); noopStages.push(stage(result)); noopMode = modeOf(result);
    snapshot = (result as any).snapshot ?? snapshot;
  }

  const scanned = (await scanRepo(timingWork)).map((f) => f.path)
    .filter((p) => spec.exts.some((e) => p.endsWith(e))).sort();
  const incremental: Record<string, unknown> = {};
  for (const k of [1, 3]) {
    for (const rel of scanned.slice(0, k)) appendProbe(path.join(timingWork, rel), marker, `k${k}`);
    try {
      const [result, ms] = await timed(() => indexProject({ repoRoot: timingWork, db, parserVersion: DEFAULT_PARSER_VERSION,
        ...(snapshot === undefined ? {} : { previousSnapshot: snapshot }), hasExistingGraph: true }));
      snapshot = (result as any).snapshot ?? snapshot;
      incremental[`k${k}`] = { changedFiles: k, elapsedMs: +ms.toFixed(1),
        ratioToColdMedian: +(ms / coldMedian).toFixed(3), stages: stage(result),
        ...modeOf(result), failureMode: null };
    } catch (error: any) {
      incremental[`k${k}`] = { changedFiles: k, elapsedMs: null, ratioToColdMedian: null,
        failureMode: String(error?.message ?? error).slice(0, 200) };
    }
  }
  db.close();
  rmSync(timingWork, { recursive: true, force: true });

  // -------------------------------------------------------- accounting pass
  const acctWork = freshWork(spec, prepared, "acct");
  const acctDb = openIndexDb(acctWork);
  const cold: any = await indexProject({ repoRoot: acctWork, db: acctDb, parserVersion: DEFAULT_PARSER_VERSION });
  let acctSnapshot: IndexedFileSnapshotSet | undefined = cold.snapshot;
  installWriteCounters(acctDb);

  const accounting: Record<string, unknown> = {};
  const record = async (label: string, changedPaths: readonly string[]) => {
    for (const rel of changedPaths) appendProbe(path.join(acctWork, rel), marker, label);
    const semanticBefore = liveSemanticRows(acctDb);
    const affected = affectedSemanticRows(acctDb, changedPaths);
    const { value, accounting: acct } = await accountRefresh(acctDb, () =>
      indexProject({ repoRoot: acctWork, db: acctDb, parserVersion: DEFAULT_PARSER_VERSION,
        ...(acctSnapshot === undefined ? {} : { previousSnapshot: acctSnapshot }),
        hasExistingGraph: true }));
    acctSnapshot = (value as any).snapshot ?? acctSnapshot;
    accounting[label] = {
      ...modeOf(value),
      changedPaths,
      liveSemanticRowsBefore: semanticBefore,
      affectedSemanticRowsBefore: affected.total,
      affectedByTable: affected.byTable,
      boundedness: semanticWritesAreBounded(acct.semanticRowsWritten, affected.total),
      wholeGraphFractionWritten: semanticBefore === 0 ? null
        : +(acct.semanticRowsWritten / semanticBefore).toFixed(4),
      ...(acct as RefreshWriteAccounting),
    };
    const b = (accounting[label] as any).boundedness;
    console.log(`  acct ${spec.id} ${label.padEnd(6)} mode=${(accounting[label] as any).mode} `
      + `semantic=${acct.semanticRowsWritten} affected=${affected.total} `
      + `amp=${b.amplification} bounded=${b.bounded} `
      + `(graph ${semanticBefore}) bookkeeping=${acct.bookkeepingRowsWritten}`);
  };

  const acctScanned = (await scanRepo(acctWork)).map((f) => f.path)
    .filter((p) => spec.exts.some((e) => p.endsWith(e))).sort();
  await record("noop", []);
  await record("k1", acctScanned.slice(0, 1));
  await record("k3", acctScanned.slice(0, 3));

  // Symbol concentration: the largest single file's share of the graph, which is
  // what any per-file bound has to leave room for (§32 F1).
  const largest = acctDb.query(`SELECT f.path AS path, COUNT(s.id) AS c FROM files f
    JOIN symbols s ON s.file_id = f.id GROUP BY f.id ORDER BY c DESC LIMIT 3`)
    .all() as { path: string; c: number }[];
  const totalSymbols = (acctDb.query("SELECT COUNT(*) AS c FROM symbols").get() as any).c;

  acctDb.close();
  rmSync(acctWork, { recursive: true, force: true });

  corpora.push({
    id: spec.id, language: spec.language, filesIndexed,
    cold: { runsMs: coldMs.map((m) => +m.toFixed(1)), medianMs: +coldMedian.toFixed(1),
      stages: coldStages, indexBytes: coldIndexBytes },
    noop: { runsMs: noopMs.map((m) => +m.toFixed(1)), medianMs: +median(noopMs).toFixed(1),
      stages: noopStages, ...(noopMode ?? {}) },
    incremental,
    accounting,
    symbolConcentration: { totalSymbols, largestFiles: largest,
      largestFraction: totalSymbols === 0 ? null : +((largest[0]?.c ?? 0) / totalSymbols).toFixed(4) },
  });

  const k1 = incremental.k1 as any; const k3 = incremental.k3 as any;
  console.log(`${spec.id.padEnd(8)} cold ${coldMedian.toFixed(0)} ms | noop ${median(noopMs).toFixed(0)} ms `
    + `| k=1 ratio ${k1?.ratioToColdMedian} (${k1?.mode}) | k=3 ratio ${k3?.ratioToColdMedian} (${k3?.mode})`);
}

const out = {
  milestone: "M199",
  instrument: "run_stage5_m199_persistence.ts",
  purpose: "A3 reproduction (timing pass) and refresh write amplification (accounting pass)",
  repeats: REPEATS,
  accountedTables: ACCOUNTED_TABLES,
  ftsTablesMeasuredByLiveDeltaOnly: FTS_TABLES,
  hardware: { cpus: navigator.hardwareConcurrency, scratch: SCRATCH,
    loadAverageAtStart: startLoad, loadAverageAtEnd: loadAverage() },
  corpora,
};
writeFileSync(path.join(RESULTS, OUT), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nwrote results/${OUT}`);
