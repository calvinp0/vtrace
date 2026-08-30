/**
 * M190-B — materialise and index the held-out base trees.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m190_prepare.ts [--jobs N] [--only <instance>]
 *
 * M189 built its 69 base trees by hand and wrote the recipe into its report (M189 §10).
 * M190 §36 needs the expensive half of the pipeline to be a reproducible PHASE rather than a
 * remembered shell incantation, so the same recipe lives here, applied to exactly the
 * instances named in the frozen held-out manifest.
 *
 * THE RECIPE IS UNCHANGED, deliberately (§10):
 *
 *   git -C <bench-repo> archive <base_commit> | tar -x -C <trees>/<instance_id>
 *   bun src/cli/index.ts index <trees>/<instance_id> --quiet --json
 *
 * `git archive` and not `git checkout`: the bench repositories are read-only inputs shared
 * with the external harness, and M189's "bench repos read only; no checkout, no fetch, no
 * worktree" is a property M190 has to keep rather than a note about how M189 happened to
 * work. Archiving a commit-ish touches no ref, no index and no working tree.
 *
 * WHICH REVISION. `base_commit` from SWE-bench Verified, carried through the M189 corpus
 * ledger — the tree the agent actually started from. §10's "Git owns cross-revision truth"
 * forbids the convenient alternative of indexing a modern checkout and calling it close
 * enough; a 2023 astropy trace scored against 2026 astropy would be measuring the wrong
 * repository. The revision is recorded per instance in the ledger this writes.
 *
 * The `.m189_indexed` marker is the M189 driver's readiness predicate. It is written LAST,
 * after the indexer reports success, so a crashed or half-written tree is invisible to the
 * replication rather than silently analysed as an empty repository.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const BENCH_REPOS = "/home/calvin/code/vexp-swe-bench/.bench-repos";
const TREES = "/home/calvin/.cache/m189_trees";

const argv = process.argv.slice(2);
const jobs = Math.max(1, Number(argv[argv.indexOf("--jobs") + 1]) || 4);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;

interface ManifestArm {
  readonly instanceId: string; readonly repo: string; readonly baseCommit: string;
}
const manifest = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m190_heldout_manifest.json"), "utf8")) as {
  manifestHash: string; arms: ManifestArm[];
};

/** one row per INSTANCE — the tree is a property of the instance, not of the arm */
const instances = new Map<string, ManifestArm>();
for (const a of manifest.arms) if (!instances.has(a.instanceId)) instances.set(a.instanceId, a);

type IndexOutcome =
  | "INDEXED"
  | "ALREADY_INDEXED"
  | "BENCH_REPO_MISSING"
  | "SOURCE_REVISION_UNAVAILABLE"
  | "ARCHIVE_FAILED"
  | "INDEX_FAILED";

interface PrepareRow {
  instanceId: string; repo: string; baseCommit: string;
  outcome: IndexOutcome; detail: string | null;
  files: number | null; symbols: number | null; edges: number | null;
  indexMode: string | null; runtimeReady: boolean; elapsedMs: number;
}

const benchRepoDir = (repo: string): string => path.join(BENCH_REPOS, repo.replace("/", "__"));

function prepareOne(inst: ManifestArm): PrepareRow {
  const started = Date.now();
  const row: PrepareRow = {
    instanceId: inst.instanceId, repo: inst.repo, baseCommit: inst.baseCommit,
    outcome: "INDEXED", detail: null, files: null, symbols: null, edges: null,
    indexMode: null, runtimeReady: false, elapsedMs: 0,
  };
  const finish = (o: IndexOutcome, detail: string | null): PrepareRow =>
    ({ ...row, outcome: o, detail, elapsedMs: Date.now() - started });

  const treeDir = path.join(TREES, inst.instanceId);
  if (existsSync(path.join(treeDir, ".m189_indexed")) && existsSync(path.join(treeDir, ".vtrace/index.sqlite"))) {
    return finish("ALREADY_INDEXED", null);
  }
  const repoDir = benchRepoDir(inst.repo);
  if (!existsSync(repoDir)) return finish("BENCH_REPO_MISSING", repoDir);

  try {
    execFileSync("git", ["-C", repoDir, "cat-file", "-e", `${inst.baseCommit}^{commit}`], { stdio: "ignore" });
  } catch {
    return finish("SOURCE_REVISION_UNAVAILABLE", inst.baseCommit);
  }

  // A half-extracted tree from an earlier interrupted attempt would index as a partial
  // repository and produce candidates from a graph that never existed. Start clean.
  rmSync(treeDir, { recursive: true, force: true });
  mkdirSync(treeDir, { recursive: true });
  try {
    execSync(
      `git -C ${JSON.stringify(repoDir)} archive ${JSON.stringify(inst.baseCommit)} | tar -x -C ${JSON.stringify(treeDir)}`,
      { stdio: ["ignore", "ignore", "pipe"], shell: "/bin/bash" },
    );
  } catch (e) {
    return finish("ARCHIVE_FAILED", (e as Error).message.slice(0, 200));
  }

  let out = "";
  try {
    out = execFileSync("bun", [path.join(REPO_ROOT, "src/cli/index.ts"), "index", treeDir, "--quiet", "--json"], {
      cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, VTRACE_PROGRESS: "0" },
    });
  } catch (e) {
    return finish("INDEX_FAILED", (e as Error).message.slice(0, 300));
  }

  const dbPath = path.join(treeDir, ".vtrace/index.sqlite");
  if (!existsSync(dbPath)) return finish("INDEX_FAILED", "no index.sqlite produced");

  try {
    const parsed = JSON.parse(out.trim().split("\n").filter((l) => l.trim().startsWith("{")).pop() ?? "{}") as
      Record<string, unknown>;
    row.indexMode = typeof parsed.mode === "string" ? parsed.mode : null;
  } catch { /* the JSON shape is telemetry, not authority; the database below is authority */ }

  // Counts come from the database rather than from the CLI's summary, because the readiness
  // question M190 has to answer is "can getImpactGraph traverse this tree", and that is a
  // property of the stored graph.
  const db = new Database(dbPath, { readonly: true });
  try {
    const one = (sql: string): number => (db.query(sql).get() as { n: number } | null)?.n ?? 0;
    row.files = one("SELECT COUNT(*) AS n FROM files");
    row.symbols = one("SELECT COUNT(*) AS n FROM symbols");
    row.edges = one("SELECT COUNT(*) AS n FROM edges");
    row.runtimeReady = row.files > 0 && row.symbols > 0;
  } finally {
    db.close();
  }
  if (!row.runtimeReady) return finish("INDEX_FAILED", `empty graph files=${row.files} symbols=${row.symbols}`);

  writeFileSync(path.join(treeDir, ".m189_indexed"), `${inst.baseCommit}\n`);
  return finish("INDEXED", null);
}

// ── run ─────────────────────────────────────────────────────────────────────
const queue = [...instances.values()]
  .filter((i) => only === null || i.instanceId === only)
  .sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1));

const rows: PrepareRow[] = [];
let cursor = 0;
let done = 0;
async function worker(): Promise<void> {
  for (;;) {
    const i = cursor++;
    if (i >= queue.length) return;
    const inst = queue[i]!;
    const row = prepareOne(inst);
    rows.push(row);
    done += 1;
    process.stdout.write(
      `[${String(done).padStart(3)}/${queue.length}] ${row.outcome.padEnd(28)} ${inst.instanceId}` +
      `  files=${row.files ?? "-"} symbols=${row.symbols ?? "-"} edges=${row.edges ?? "-"} ${(row.elapsedMs / 1000).toFixed(1)}s\n`,
    );
    await Promise.resolve();
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, () => worker()));

rows.sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1));
const ledgerPath = path.join(RESULTS, "stage5_m190_prepare_ledger.jsonl");
if (only === null) {
  writeFileSync(ledgerPath, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
} else {
  const prior = existsSync(ledgerPath)
    ? readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as PrepareRow)
    : [];
  const merged = [...prior.filter((p) => !rows.some((r) => r.instanceId === p.instanceId)), ...rows]
    .sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1));
  writeFileSync(ledgerPath, `${merged.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

const by = (o: IndexOutcome): number => rows.filter((r) => r.outcome === o).length;
process.stdout.write([
  "",
  "M190-B prepare",
  `  manifest hash        ${manifest.manifestHash}`,
  `  instances            ${queue.length}`,
  `  INDEXED              ${by("INDEXED")}`,
  `  ALREADY_INDEXED      ${by("ALREADY_INDEXED")}`,
  `  BENCH_REPO_MISSING   ${by("BENCH_REPO_MISSING")}`,
  `  SOURCE_REVISION_UNAVAILABLE ${by("SOURCE_REVISION_UNAVAILABLE")}`,
  `  ARCHIVE_FAILED       ${by("ARCHIVE_FAILED")}`,
  `  INDEX_FAILED         ${by("INDEX_FAILED")}`,
  `  wall time            ${(rows.reduce((a, r) => a + r.elapsedMs, 0) / 1000 / 60).toFixed(1)} cpu-min`,
  "",
].join("\n"));
