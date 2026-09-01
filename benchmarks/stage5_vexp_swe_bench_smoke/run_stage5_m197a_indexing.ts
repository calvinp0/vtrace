/**
 * M197A — Track-A indexing measurements: A2 throughput, A3 incremental ratio,
 * A4 no-op freshness, A8 ingestion completeness.
 *
 * A8 is the veto, so it is measured through the AUTHORITATIVE product path
 * (`indexProject`) against a denominator this instrument derives itself by
 * walking the filesystem. Two denominators are always published — raw on-disk
 * files and post-exclusion eligible files — because a repair that improves
 * coverage by shrinking the second one must be visible as a gap between them.
 *
 * A2/A3/A4 run in a SEPARATE working copy from A8, because A3 must modify files
 * to be incremental at all, and a corpus that has been touched is no longer the
 * corpus A8 and the engine measurements are declared against.
 *
 * Known pre-existing defects (M196A §14) are measured here, not repaired:
 * incremental refresh re-parses the whole corpus, and a single-file Python
 * incremental aborts on `UNIQUE constraint failed: edges.id`. A crash is caught
 * and recorded as A3's failure mode; it is never allowed to end the run.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m197a_indexing.ts \
 *     [--repeats 3] [--scratch <dir>]
 */
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { indexProject } from "../../src/indexer/indexProject";
import type { IndexedFileSnapshotSet } from "../../src/indexer/incrementalIndex";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { scanRepo } from "../../src/fs/scanRepo";
import {
  SKIP_DIRS, corpusSpecs, prepareCorpus, sourceFilesOnDisk, latencyStats, median,
} from "./m197aFixtures";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const REPEATS = Number.parseInt(argOf("--repeats", "3"), 10);
const SCRATCH = argOf("--scratch", path.join(process.env.TMPDIR ?? "/tmp", "m197a"));

/**
 * The comment marker a probe appends when it modifies a file. It MUST match the
 * corpus language: a `//` line in a Python file makes the file fail to parse, so
 * the indexer skips it and an incremental defect that needs a genuine reparse
 * can no longer fire. A probe that hides the thing it probes for is worse than
 * no probe.
 */
const commentMarker = (spec: { readonly exts: readonly string[] }) =>
  spec.exts.includes(".py") ? "#" : "//";
mkdirSync(SCRATCH, { recursive: true });

/**
 * Reasons a file may leave A8's denominator. Only the repository's own declared
 * policy qualifies; a parse failure never does. Kept as a closed set so a
 * failing file cannot be reclassified into an excluded bucket (M196A control F6).
 */
const LEGITIMATE_EXCLUSIONS = new Set(["GIT_IGNORED", "WORKTREE_EXCLUDED", "PRODUCT_IGNORED_DIRECTORY"]);

const PRODUCT_IGNORED_DIRECTORIES = new Set([
  ".git", ".vtrace", ".codex", "node_modules", "dist", "build", "out", "coverage",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache", ".vite",
  ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  ".tox", ".eggs", "target", ".gradle", ".idea", ".vscode", ".vs", "vendor",
]);

function gitIgnoredPaths(sourceRoot: string, relPaths: readonly string[]): Set<string> {
  if (!existsSync(path.join(sourceRoot, ".git"))) return new Set();
  const out = new Set<string>();
  for (let i = 0; i < relPaths.length; i += 500) {
    const batch = relPaths.slice(i, i + 500);
    try {
      const stdout = execFileSync("git", ["-C", sourceRoot, "check-ignore", "--", ...batch], { encoding: "utf8" });
      for (const line of stdout.split("\n")) if (line.trim()) out.add(line.trim());
    } catch (error: any) {
      if (error?.status !== 1) throw error;
      for (const line of String(error?.stdout ?? "").split("\n")) if (line.trim()) out.add(line.trim());
    }
  }
  return out;
}

function nestedWorktreeRoots(sourceRoot: string): string[] {
  if (!existsSync(path.join(sourceRoot, ".git"))) return [];
  try {
    return execFileSync("git", ["-C", sourceRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" })
      .split("\n").filter((l) => l.startsWith("worktree "))
      .map((l) => path.relative(sourceRoot, l.slice("worktree ".length).trim()))
      .filter((r) => r.length > 0 && !r.startsWith(".."));
  } catch { return []; }
}

function exclusionReason(
  rel: string, gitIgnored: ReadonlySet<string>, worktrees: readonly string[],
): string | null {
  if (worktrees.some((r) => rel === r || rel.startsWith(`${r}/`))) return "WORKTREE_EXCLUDED";
  if (gitIgnored.has(rel)) return "GIT_IGNORED";
  if (rel.split("/").some((seg) => PRODUCT_IGNORED_DIRECTORIES.has(seg))) return "PRODUCT_IGNORED_DIRECTORY";
  return null;
}

/**
 * The PRODUCT's own writer-open path. Reached for deliberately: opening the
 * index with a bare `new Database` skips `PRAGMA foreign_keys` and schema
 * initialisation, and an incremental refresh on such a handle aborts with
 * `UNIQUE constraint failed: edge_call_sites`. That is a misuse of the API by
 * the caller, not an incremental defect, and measuring it as one would have
 * reported a product failure this instrument caused.
 */
function openIndexDb(work: string): Database {
  mkdirSync(path.join(work, ".vtrace"), { recursive: true });
  return openIndexerDatabase(path.join(work, ".vtrace", "index.sqlite"));
}

/**
 * System load at measurement time. Recorded with every timing because this
 * machine is shared with the operator's own work: a cold index measured while
 * eleven cores are busy elsewhere is a real number about a contended machine,
 * not a property of the engine, and A2's threshold is close enough that the
 * difference decides the verdict.
 */
function loadAverage(): number[] {
  try {
    return readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number);
  } catch { return []; }
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const value = await fn();
  return [value, performance.now() - t0];
}

const startLoad = loadAverage();
console.log(`load average at start: ${startLoad.join(" ")} (${navigator.hardwareConcurrency} cpus)`);

const specs = corpusSpecs(REPO);
const indexing: any[] = [];
const ingestion: any[] = [];

for (const spec of specs) {
  const a8Work = prepareCorpus(spec, SCRATCH);
  if (a8Work === null) {
    ingestion.push({ id: spec.id, status: "CORPUS_ABSENT", source: spec.source });
    indexing.push({ id: spec.id, status: "CORPUS_ABSENT" });
    continue;
  }

  // ------------------------------------------------------------------- A8
  const onDisk = sourceFilesOnDisk(a8Work, spec.exts);
  const gitIgnored = gitIgnoredPaths(spec.source, onDisk);
  const worktrees = nestedWorktreeRoots(spec.source);

  const runs: { represented: string[]; symbols: number; edges: number; coverage: any; ms: number }[] = [];
  for (let i = 0; i < REPEATS; i += 1) {
    rmSync(path.join(a8Work, ".vtrace"), { recursive: true, force: true });
    const db = openIndexDb(a8Work);
    const [result, ms] = await timed(() => indexProject({ repoRoot: a8Work, db }));
    const represented = (db.query("select path from files order by path").all() as { path: string }[])
      .map((r) => r.path)
      .filter((p) => spec.exts.some((e) => p.endsWith(e)));
    runs.push({
      represented,
      symbols: (db.query("select count(*) c from symbols").get() as any).c,
      edges: (db.query("select count(*) c from edges").get() as any).c,
      coverage: (result as any).coverage,
      ms,
    });
    db.close();
  }

  const first = runs[0]!;
  const representedSet = new Set(first.represented);
  const missing = onDisk.filter((f) => !representedSet.has(f))
    .map((f) => ({ path: f, reason: exclusionReason(f, gitIgnored, worktrees) ?? "UNEXPLAINED_MISSING" }));
  const legitimate = missing.filter((m) => LEGITIMATE_EXCLUSIONS.has(m.reason));
  const unexplained = missing.filter((m) => !LEGITIMATE_EXCLUSIONS.has(m.reason));
  const eligible = onDisk.length - legitimate.length;

  const semanticKey = (r: typeof first) => JSON.stringify({ f: r.represented, s: r.symbols, e: r.edges });
  const nonIdentical = runs.filter((r) => semanticKey(r) !== semanticKey(first)).length;

  ingestion.push({
    id: spec.id, language: spec.language, source: spec.source,
    sourceFilesOnDisk: onDisk.length,
    legitimatelyExcluded: legitimate.length,
    eligible,
    frozenEligible: spec.frozenEligible,
    eligibleMatchesFrozen: eligible === spec.frozenEligible,
    represented: first.represented.length,
    unexplainedMissing: unexplained.length,
    coveragePercent: eligible > 0 ? +(100 * first.represented.length / eligible).toFixed(2) : null,
    coverageAgainstRawDisk: +(100 * first.represented.length / onDisk.length).toFixed(2),
    productCoverage: first.coverage,
    exclusionJustification: Object.fromEntries([...new Set(legitimate.map((m) => m.reason))].map((r) => [r, {
      count: legitimate.filter((m) => m.reason === r).length,
      examples: legitimate.filter((m) => m.reason === r).slice(0, 3).map((m) => m.path),
    }])),
    unexplainedMissingFiles: unexplained.slice(0, 50),
    totalSymbols: first.symbols,
    totalEdges: first.edges,
    determinism: { repeats: REPEATS, nonIdenticalRuns: nonIdentical,
      symbolCounts: runs.map((r) => r.symbols), edgeCounts: runs.map((r) => r.edges) },
  });
  const ing = ingestion.at(-1)!;
  console.log(`A8  ${spec.id.padEnd(8)} ${ing.represented}/${ing.eligible} = ${ing.coveragePercent}%  `
    + `(disk ${ing.sourceFilesOnDisk}, excluded ${ing.legitimatelyExcluded}, unexplained ${ing.unexplainedMissing}, nondet ${nonIdentical})`);

  // -------------------------------------------------------- A2 / A3 / A4
  const timingWork = path.join(SCRATCH, `timing-${spec.id}`);
  rmSync(timingWork, { recursive: true, force: true });
  cpSync(a8Work, timingWork, { recursive: true, dereference: false,
    filter: (s) => !SKIP_DIRS.has(path.basename(s)) });

  const coldMs: number[] = [];
  let coldSymbols = 0; let coldEdges = 0; let coldIndexBytes = 0; let filesIndexed = 0;
  let snapshot: IndexedFileSnapshotSet | undefined;
  for (let i = 0; i < REPEATS; i += 1) {
    rmSync(path.join(timingWork, ".vtrace"), { recursive: true, force: true });
    const db = openIndexDb(timingWork);
    const [result, ms] = await timed(() => indexProject({ repoRoot: timingWork, db }));
    coldMs.push(ms);
    coldSymbols = (result as any).totalSymbols;
    coldEdges = (result as any).totalRelationships;
    filesIndexed = (result as any).totalFilesSuccessfullyIndexed;
    snapshot = (result as any).snapshot;
    db.close();
    coldIndexBytes = statSync(path.join(timingWork, ".vtrace/index.sqlite")).size;
  }

  // A4: nothing changed since the snapshot the last cold run produced.
  const db = openIndexDb(timingWork);
  const noopMs: number[] = [];
  let noopReparsed: number | null = null;
  for (let i = 0; i < REPEATS; i += 1) {
    const [result, ms] = await timed(() => indexProject({ repoRoot: timingWork, db,
      ...(snapshot === undefined ? {} : { previousSnapshot: snapshot }), hasExistingGraph: true }));
    noopMs.push(ms);
    noopReparsed = (result as any).totalFilesAttemptedForParse;
    snapshot = (result as any).snapshot ?? snapshot;
  }

  // A3: k files genuinely modified, chosen from the PRODUCT's own enumeration so
  // the run cannot touch a path the indexer legitimately ignores — which would
  // reparse nothing and read exactly like the staleness defect it is not.
  const scanned = (await scanRepo(timingWork)).map((f) => f.path)
    .filter((p) => spec.exts.some((e) => p.endsWith(e))).sort();
  const incremental: Record<string, unknown> = {};
  for (const k of [1, 3]) {
    const targets = scanned.slice(0, k);
    try {
      for (const rel of targets) {
        const full = path.join(timingWork, rel);
        writeFileSync(full, `${readFileSync(full, "utf8")}\n${commentMarker(spec)} m197a incremental probe ${k}\n`);
      }
      const [result, ms] = await timed(() => indexProject({ repoRoot: timingWork, db,
        ...(snapshot === undefined ? {} : { previousSnapshot: snapshot }), hasExistingGraph: true }));
      snapshot = (result as any).snapshot ?? snapshot;
      incremental[`k${k}`] = {
        changedFiles: k, elapsedMs: +ms.toFixed(1),
        filesAttemptedForParse: (result as any).totalFilesAttemptedForParse,
        filesIndexed: (result as any).totalFilesSuccessfullyIndexed,
        ratioToColdMedian: +(ms / median(coldMs)).toFixed(3),
        failureMode: null,
      };
    } catch (error: any) {
      incremental[`k${k}`] = { changedFiles: k, elapsedMs: null, filesAttemptedForParse: null,
        filesIndexed: null, ratioToColdMedian: null,
        failureMode: String(error?.message ?? error).slice(0, 200) };
    }
  }
  db.close();

  /**
   * The known pre-existing incremental defect (M196A §14), measured rather than
   * repaired. It is SEQUENCE-DEPENDENT, which is why the ratio rows above do not
   * show it: a corpus indexed cold, refreshed once with no changes, and then
   * given a single changed file aborts on `UNIQUE constraint failed: edges.id`
   * for Python, while the same corpus given several no-op refreshes first does
   * not. Both sequences are reported so neither reads as the whole truth.
   */
  const defectWork = path.join(SCRATCH, `defect-${spec.id}`);
  rmSync(defectWork, { recursive: true, force: true });
  cpSync(a8Work, defectWork, { recursive: true, dereference: false,
    filter: (s) => !SKIP_DIRS.has(path.basename(s)) });
  let singleRefreshSequence: unknown;
  {
    const ddb = openIndexDb(defectWork);
    const cold0: any = await indexProject({ repoRoot: defectWork, db: ddb });
    const noop0: any = await indexProject({ repoRoot: defectWork, db: ddb,
      previousSnapshot: cold0.snapshot, hasExistingGraph: true });
    const target = (await scanRepo(defectWork)).map((f) => f.path)
      .filter((p) => spec.exts.some((e) => p.endsWith(e))).sort()[0];
    if (target === undefined) singleRefreshSequence = { status: "NO_TARGET" };
    else {
      const full = path.join(defectWork, target);
      writeFileSync(full, `${readFileSync(full, "utf8")}\n${commentMarker(spec)} m197a single-refresh probe\n`);
      try {
        const r: any = await indexProject({ repoRoot: defectWork, db: ddb,
          previousSnapshot: noop0.snapshot ?? cold0.snapshot, hasExistingGraph: true });
        singleRefreshSequence = { status: "OK", changedFiles: 1, target,
          filesAttemptedForParse: r.totalFilesAttemptedForParse };
      } catch (error: any) {
        singleRefreshSequence = { status: "CRASH", changedFiles: 1, target,
          error: String(error?.message ?? error).slice(0, 160),
          note: "pre-existing; reproduced through the product's own openIndexerDatabase path" };
      }
    }
    ddb.close();
  }
  rmSync(defectWork, { recursive: true, force: true });

  const coldMedian = median(coldMs);
  indexing.push({
    id: spec.id, language: spec.language,
    eligibleFiles: ingestion.at(-1)!.eligible,
    filesIndexed,
    cold: { ...latencyStats(coldMs.map((m) => +m.toFixed(1))),
      filesPerSecondMedian: +(1000 * filesIndexed / coldMedian).toFixed(2) },
    noop: latencyStats(noopMs.map((m) => +m.toFixed(1))),
    noopFilesAttemptedForParse: noopReparsed,
    incremental,
    singleRefreshSequence,
    symbols: coldSymbols, edges: coldEdges, indexBytes: coldIndexBytes,
  });
  const ix = indexing.at(-1)!;
  console.log(`A2  ${spec.id.padEnd(8)} cold ${ix.cold.median} ms → ${ix.cold.filesPerSecondMedian} files/s  `
    + `| A4 no-op ${ix.noop.median} ms (reparsed ${noopReparsed}) `
    + `| A3 k=1 ${JSON.stringify((incremental as any).k1?.ratioToColdMedian ?? (incremental as any).k1?.failureMode)} `
    + `k=3 ${JSON.stringify((incremental as any).k3?.ratioToColdMedian ?? (incremental as any).k3?.failureMode)} `
    + `| single-refresh ${(singleRefreshSequence as any)?.status}`);
  rmSync(timingWork, { recursive: true, force: true });
}

const out = {
  milestone: "M197A",
  instrument: "run_stage5_m197a_indexing.ts",
  claims: ["A2", "A3", "A4", "A8"],
  repeats: REPEATS,
  hardware: { cpus: navigator.hardwareConcurrency, scratch: SCRATCH,
    loadAverageAtStart: startLoad, loadAverageAtEnd: loadAverage(),
    note: "scratch is tmpfs; index build is RAM-backed and not comparable to unstated VEXP hardware" },
  ingestion,
  indexing,
};
writeFileSync(path.join(RESULTS, "stage5_m197a_indexing.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nwrote results/stage5_m197a_indexing.json`);
