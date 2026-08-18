/**
 * M160-A §8, §23-§24, §80 — the pre-retrieval corpus integrity gate.
 *
 * WHY THIS RUNS BEFORE ANYTHING ELSE
 * -----------------------------------
 * M159 discovered that `django-13590` and `django-15572` were never valid
 * retrieval instances: the checked-out tree did not contain the package subtree
 * holding their gold file, so they had counted as VTRACE retrieval failures since
 * M157. That is a benchmark defect being read as a product defect, and it is only
 * cheap to catch before the corpus is frozen — afterwards it contaminates every
 * denominator downstream of it.
 *
 * So every pool member is gated on its SOURCE first, and the gate is deliberately
 * cheaper than a checkout: a depth-1 fetch of the base commit plus `git ls-tree`
 * over that commit answers "does the gold file exist at this revision?" without
 * materializing a tree or building an index. That is what makes it affordable to
 * gate all 400 candidates rather than a sampled cohort, which is what §22 asks
 * for — the pool is `Verified − Broad100-A − invalid` BEFORE sampling, so no
 * instance is ever replaced after the fact to keep the count round (§17).
 *
 * §80 is the hard distinction this gate exists to protect:
 *     gold file absent from the checkout  -> CORPUS_INVALID (not a product failure)
 *     gold file present but not indexed   -> INDEX_FILE_MISSING (a product failure)
 * Only the first is decided here. The second cannot be decided until M160-B.
 *
 * §25 — gold-file existence is an INTEGRITY test. The path is checked against the
 * source tree and recorded in the exclusion ledger; it is never handed to VTRACE,
 * which receives only the ordinary derived task text.
 *
 * Network: yes, `git fetch --depth 1` against the existing bench clones — the
 * same mechanism prepare_stage5_workspaces already uses. NO Claude, NO Docker,
 * NO agent run, NO API calls, NO index build.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { hashStable } from "./benchmarkProvenance";
import { fileMatches } from "./run_stage5_retrieval_eval";
import { benchCloneName } from "./run_stage5_m160_corpus_pool";
import { withinArchiveSubtree, type PoolCandidate } from "./m160Corpus";

const exec = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RESULTS = path.join(import.meta.dir, "results");
const DEFAULT_BENCH_REPOS_ROOT = "/home/calvin/code/vexp-swe-bench/.bench-repos";

export type IntegrityVerdict = "VALID" | "CORPUS_INVALID";

export type IntegrityFailure =
  | "REVISION_UNAVAILABLE"
  | "TREE_UNREADABLE"
  | "TREE_STRUCTURALLY_EMPTY"
  | "GOLD_FILE_ABSENT_FROM_SOURCE";

/**
 * Fetch attempts before a revision is called unavailable.
 *
 * The first full run of this gate returned 16 CORPUS_INVALID verdicts, every one
 * REVISION_UNAVAILABLE, spread across 8 unrelated repositories — and every one
 * fetched successfully on a manual retry seconds later. A transient network
 * error was being recorded as a permanent statement about the benchmark, which
 * would have silently biased the pool the corpus is drawn from. One attempt is
 * not a measurement.
 */
const FETCH_ATTEMPTS = 4;
const FETCH_BACKOFF_MS = [1000, 3000, 8000] as const;

export interface IntegrityRow {
  readonly instanceId: string;
  readonly repo: string;
  readonly baseCommit: string;
  readonly difficulty: string;
  readonly verdict: IntegrityVerdict;
  readonly failure: IntegrityFailure | null;
  readonly detail: string;
  readonly treeFileCount: number;
  readonly treePythonFileCount: number;
  readonly expectedFiles: readonly string[];
  readonly missingGoldFiles: readonly string[];
  readonly fetched: boolean;
  /** Attempts spent resolving the revision; >1 means a transient failure was survived. */
  readonly fetchAttempts: number;
}

/**
 * §24 — resolve a gold path against the source tree with the evaluator's own
 * comparator. M157 proved naive path equality can invert a conclusion, so this
 * gate does not get its own second comparator.
 */
export function goldFilePresent(goldPath: string, treePaths: ReadonlySet<string>): boolean {
  if (treePaths.has(goldPath)) return true;
  for (const candidate of treePaths) {
    if (fileMatches(goldPath, candidate)) return true;
  }
  return false;
}

async function git(cwd: string, args: readonly string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return exec("git", [...args], { cwd, maxBuffer: 256 * 1024 * 1024 })
    .then(({ stdout, stderr }) => ({ ok: true, stdout, stderr }))
    .catch((error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => ({
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
    }));
}

async function gateOne(candidate: PoolCandidate, benchReposRoot: string): Promise<IntegrityRow> {
  const clone = path.join(benchReposRoot, benchCloneName(candidate.repo));
  const base = {
    instanceId: candidate.instanceId,
    repo: candidate.repo,
    baseCommit: candidate.baseCommit,
    difficulty: candidate.difficulty,
    expectedFiles: candidate.expectedFiles,
  };

  let fetched = false;
  let fetchAttempts = 0;
  const present = await git(clone, ["cat-file", "-e", `${candidate.baseCommit}^{commit}`]);
  if (!present.ok) {
    fetched = true;
    let lastError = "";
    let resolved = false;
    for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt += 1) {
      fetchAttempts += 1;
      const fetch = await git(clone, ["fetch", "--depth", "1", "--quiet", "origin", candidate.baseCommit]);
      if (fetch.ok) {
        resolved = true;
        break;
      }
      lastError = fetch.stderr.trim();
      const backoff = FETCH_BACKOFF_MS[attempt];
      if (backoff !== undefined) await new Promise((resolve) => setTimeout(resolve, backoff));
    }
    if (!resolved) {
      return {
        ...base,
        verdict: "CORPUS_INVALID",
        failure: "REVISION_UNAVAILABLE",
        detail: `git fetch failed after ${fetchAttempts} attempts: ${lastError.slice(0, 200)}`,
        treeFileCount: 0,
        treePythonFileCount: 0,
        missingGoldFiles: [...candidate.expectedFiles],
        fetched,
        fetchAttempts,
      };
    }
  }

  const tree = await git(clone, ["ls-tree", "-r", "--name-only", candidate.baseCommit]);
  if (!tree.ok) {
    return {
      ...base,
      verdict: "CORPUS_INVALID",
      failure: "TREE_UNREADABLE",
      detail: tree.stderr.trim().slice(0, 200),
      treeFileCount: 0,
      treePythonFileCount: 0,
      missingGoldFiles: [...candidate.expectedFiles],
      fetched,
      fetchAttempts,
    };
  }

  const paths = tree.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const treePaths = new Set(paths);
  const pythonCount = paths.filter((p) => p.endsWith(".py") || p.endsWith(".pyx")).length;

  if (paths.length === 0) {
    return {
      ...base,
      verdict: "CORPUS_INVALID",
      failure: "TREE_STRUCTURALLY_EMPTY",
      detail: "ls-tree returned no paths at the base commit",
      treeFileCount: 0,
      treePythonFileCount: 0,
      missingGoldFiles: [...candidate.expectedFiles],
      fetched,
      fetchAttempts,
    };
  }

  // A gold file the patch CREATES is correctly absent at the base commit, and a
  // gold file outside the archived subtree was never in scope. Neither is a
  // corpus defect; only an unexplained absence is (§80).
  const created = new Set(candidate.goldFilesCreatedByPatch);
  const missing = candidate.expectedFiles.filter(
    (gold) =>
      !created.has(gold) &&
      withinArchiveSubtree(candidate.repo, gold) &&
      !goldFilePresent(gold, treePaths),
  );
  if (missing.length > 0) {
    return {
      ...base,
      verdict: "CORPUS_INVALID",
      failure: "GOLD_FILE_ABSENT_FROM_SOURCE",
      detail: `gold file(s) absent at ${candidate.baseCommit.slice(0, 12)}: ${missing.join(", ")}`,
      treeFileCount: paths.length,
      treePythonFileCount: pythonCount,
      missingGoldFiles: missing,
      fetched,
      fetchAttempts,
    };
  }

  return {
    ...base,
    verdict: "VALID",
    failure: null,
    detail: "revision resolved; tree present; every gold file resolves in source",
    treeFileCount: paths.length,
    treePythonFileCount: pythonCount,
    missingGoldFiles: [],
    fetched,
    fetchAttempts,
  };
}

/**
 * Gate the pool. Work is parallel ACROSS repositories and serial WITHIN one:
 * concurrent fetches into the same clone contend on the same index lock, and a
 * failed lock would read as an unavailable revision — a benchmark artefact
 * masquerading as a corpus defect, which is the exact confusion this gate exists
 * to prevent.
 */
export async function gatePool(
  candidates: readonly PoolCandidate[],
  benchReposRoot: string,
  onProgress?: (done: number, total: number) => void,
): Promise<IntegrityRow[]> {
  const byRepo = new Map<string, PoolCandidate[]>();
  for (const candidate of candidates) {
    const bucket = byRepo.get(candidate.repo) ?? [];
    bucket.push(candidate);
    byRepo.set(candidate.repo, bucket);
  }
  const rows: IntegrityRow[] = [];
  let done = 0;
  await Promise.all(
    [...byRepo.entries()].map(async ([, bucket]) => {
      for (const candidate of bucket) {
        rows.push(await gateOne(candidate, benchReposRoot));
        done += 1;
        onProgress?.(done, candidates.length);
      }
    }),
  );
  rows.sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1));
  return rows;
}

/** Median tree size per repository — the M159 signal that first exposed the two bad Django instances. */
export function treeSizeOutliers(rows: readonly IntegrityRow[], ratio = 0.75): Array<Record<string, unknown>> {
  const byRepo = new Map<string, IntegrityRow[]>();
  for (const row of rows) {
    if (row.treeFileCount === 0) continue;
    const bucket = byRepo.get(row.repo) ?? [];
    bucket.push(row);
    byRepo.set(row.repo, bucket);
  }
  const out: Array<Record<string, unknown>> = [];
  for (const [repo, bucket] of [...byRepo].sort()) {
    const sizes = bucket.map((r) => r.treeFileCount).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
    for (const row of bucket) {
      if (median > 0 && row.treeFileCount < median * ratio) {
        out.push({
          instanceId: row.instanceId,
          repo,
          treeFileCount: row.treeFileCount,
          repoMedian: median,
          share: Number((row.treeFileCount / median).toFixed(3)),
          verdict: row.verdict,
        });
      }
    }
  }
  return out;
}

function distribution(values: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)));
}

interface Config {
  readonly pool: string;
  readonly benchReposRoot: string;
  readonly out: string;
  readonly limit: number | null;
}

export function parseArgs(argv: readonly string[]): Config {
  let pool = path.join(RESULTS, "stage5_m160_broad100b_candidate_pool.json");
  let benchReposRoot = DEFAULT_BENCH_REPOS_ROOT;
  let out = RESULTS;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[(i += 1)];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--pool") pool = value();
    else if (arg === "--bench-repos-root") benchReposRoot = value();
    else if (arg === "--out") out = value();
    else if (arg === "--limit") limit = Number(value());
    else throw new Error(`Unknown argument ${arg}`);
  }
  return { pool, benchReposRoot, out, limit };
}

async function main(config: Config): Promise<void> {
  const poolDoc = JSON.parse(await readFile(config.pool, "utf8")) as { candidates: PoolCandidate[] };
  const candidates = config.limit === null ? poolDoc.candidates : poolDoc.candidates.slice(0, config.limit);

  const started = Date.now();
  let lastLogged = 0;
  const rows = await gatePool(candidates, config.benchReposRoot, (done, total) => {
    if (done - lastLogged >= 25 || done === total) {
      lastLogged = done;
      console.log(`  gated ${done}/${total} (${Math.round((Date.now() - started) / 1000)}s)`);
    }
  });

  const valid = rows.filter((row) => row.verdict === "VALID");
  const invalid = rows.filter((row) => row.verdict === "CORPUS_INVALID");

  const audit = {
    schemaVersion: "stage5.m160.broad100b-integrity-audit.v1",
    milestone: "M160",
    kind: "pre-retrieval corpus integrity gate over the whole candidate pool (§8, §22)",
    checks: [
      "instance revision resolvable in the local bench clone (fetched depth-1 if absent)",
      "repository tree structurally present at the base commit",
      "every gold file referenced by the evaluator exists in the checked-out source",
      "gold paths resolved with the evaluator's own fileMatches comparator (§24)",
      "benchmark metadata (repo, base_commit, problem statement, gold labels) present — enforced upstream in the pool build",
    ],
    ranBeforeAnyRetrieval: true,
    ranBeforeSelection: true,
    counts: {
      gated: rows.length,
      valid: valid.length,
      corpusInvalid: invalid.length,
      fetched: rows.filter((row) => row.fetched).length,
      survivedTransientFetchFailure: rows.filter((row) => row.fetchAttempts > 1 && row.verdict === "VALID").length,
    },
    fetchRetryPolicy: {
      attempts: FETCH_ATTEMPTS,
      backoffMs: [...FETCH_BACKOFF_MS],
      why:
        "the first run of this gate produced 16 REVISION_UNAVAILABLE verdicts across 8 repositories " +
        "that all fetched on a manual retry; without retries a flaky network silently biases the pool",
    },
    failureReasons: distribution(invalid.map((row) => row.failure ?? "UNKNOWN")),
    invalidByRepository: distribution(invalid.map((row) => row.repo)),
    validByRepository: distribution(valid.map((row) => row.repo)),
    treeSizeOutliers: treeSizeOutliers(rows),
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    validPoolHash: hashStable(valid.map((row) => row.instanceId)),
    rows,
  };

  const exclusions = {
    schemaVersion: "stage5.m160.broad100b-exclusions.v1",
    milestone: "M160",
    kind: "every candidate dropped before selection, with its reason (§17)",
    note:
      "CORPUS_INVALID is a benchmark-fixture defect, never a VTRACE retrieval failure (§80). " +
      "These instances are removed from the pool BEFORE sampling, so no case is silently " +
      "replaced afterwards to reach a round hundred.",
    counts: {
      candidatePool: candidates.length,
      integrityFailures: invalid.length,
      eligibleAfterGate: valid.length,
    },
    excluded: invalid.map((row) => ({
      instanceId: row.instanceId,
      repo: row.repo,
      reason: row.failure,
      detail: row.detail,
      missingGoldFiles: row.missingGoldFiles,
      treeFileCount: row.treeFileCount,
    })),
  };

  const auditPath = path.join(config.out, "stage5_m160_broad100b_integrity_audit.json");
  const exclusionsPath = path.join(config.out, "stage5_m160_broad100b_exclusions.json");
  await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  await writeFile(exclusionsPath, `${JSON.stringify(exclusions, null, 2)}\n`, "utf8");

  console.log(`gated ${rows.length}: ${valid.length} VALID, ${invalid.length} CORPUS_INVALID`);
  console.log(`  ${path.relative(REPO_ROOT, auditPath)}`);
  console.log(`  ${path.relative(REPO_ROOT, exclusionsPath)}`);
}

if (import.meta.main) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
