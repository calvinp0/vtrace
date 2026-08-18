/**
 * M160-B §30, §81, §33 — materialize and index a fresh workspace per frozen
 * Broad100-B case.
 *
 * Preparation reproduces Broad100-A's protocol rather than improving on it: the
 * archive is taken from the same subtree per repository (django from its package
 * directory, everything else from the repository root), the workspace carries no
 * history, and `git init` plants the root marker that stops vtrace's project-root
 * detection at the workspace instead of resolving up into the vtrace repo.
 * "Fixing" the django asymmetry here would confound a protocol change with the
 * replication result (§119).
 *
 * WHAT IS NEW IS THE COMPLETENESS GATE.
 * Broad100-A carries two instances — django-13590 and django-15572 — whose
 * extraction stopped part-way through the tree, so `db/` never landed while
 * `apps/` and `contrib/` did. They then counted as VTRACE retrieval failures for
 * two milestones. Nothing in the old preparation could notice, because an index
 * over a truncated tree builds perfectly well. So every workspace here is
 * verified against `git ls-tree` at its own base commit BEFORE it is indexed, and
 * a workspace missing an in-scope gold file is refused rather than measured.
 *
 * Membership is already frozen (§27): a preparation failure is reported as an
 * availability fact about that case, never repaired by substituting another
 * instance (§99).
 *
 * NO Claude, NO Docker, NO agent run, NO API calls, NO paid anything.
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { archiveSubtree, goldPathInWorkspace, withinArchiveSubtree, type PoolCandidate } from "./m160Corpus";
import { benchCloneName } from "./run_stage5_m160_corpus_pool";

const exec = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RESULTS = path.join(import.meta.dir, "results");
const DEFAULT_OUT_ROOT = path.join(RESULTS, "workspaces", "m160_broad_b");
const DEFAULT_BENCH_REPOS_ROOT = "/home/calvin/code/vexp-swe-bench/.bench-repos";
const VTRACE_BIN = path.join(REPO_ROOT, "bin", "vtrace");
const INDEX_RELPATH = path.join(".vtrace", "index.sqlite");

/** §33 — the product's own availability vocabulary, never collapsed into pass/fail. */
export type Availability = "VALID" | "DEGRADED_VALID" | "UNAVAILABLE" | "PREPARATION_INVALID";

export interface PreparedWorkspace {
  readonly instanceId: string;
  readonly repo: string;
  readonly baseCommit: string;
  readonly workspace: string;
  readonly availability: Availability;
  readonly detail: string;
  readonly sourceFilesExpected: number;
  readonly sourceFilesOnDisk: number;
  readonly archiveOmissions: number;
  readonly missingGoldFiles: readonly string[];
  readonly index: {
    readonly filesScanned: number;
    readonly filesIndexed: number;
    readonly parseFailures: number;
    readonly readFailures: number;
    readonly symbols: number;
    readonly relationships: number;
    readonly coverageComplete: boolean;
    readonly failedLanguages: readonly string[];
  } | null;
  readonly indexMs: number;
}

interface IndexReport {
  totalFilesScanned?: number;
  totalFilesSuccessfullyIndexed?: number;
  totalParseFailures?: number;
  totalReadFailures?: number;
  totalSymbols?: number;
  totalRelationships?: number;
  coverage?: { complete?: boolean; failedLanguages?: string[] };
}

async function git(cwd: string, args: readonly string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return exec("git", [...args], { cwd, maxBuffer: 512 * 1024 * 1024 })
    .then(({ stdout, stderr }) => ({ ok: true, stdout, stderr }))
    .catch((error: { stdout?: string; stderr?: string }) => ({
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
    }));
}

/** `git archive <commit> | tar -x -C dest`, from the subtree the repo is archived at. */
function archiveExtract(from: string, commit: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = spawn("git", ["archive", commit], { cwd: from, stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-x", "-C", dest], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    let sourceCode: number | null = null;
    let tarCode: number | null = null;
    source.stderr?.on("data", (chunk) => (err += String(chunk)));
    tar.stderr?.on("data", (chunk) => (err += String(chunk)));
    source.stdout?.on("error", () => {});
    tar.stdin?.on("error", () => {});
    source.stdout?.pipe(tar.stdin!);
    source.on("error", reject);
    tar.on("error", reject);
    const settle = (): void => {
      if (sourceCode === null || tarCode === null) return;
      if (sourceCode !== 0) reject(new Error(`git archive exited ${sourceCode}: ${err.trim()}`));
      else if (tarCode !== 0) reject(new Error(`tar exited ${tarCode}: ${err.trim()}`));
      else resolve();
    };
    source.on("close", (code) => {
      sourceCode = code ?? 1;
      settle();
    });
    tar.on("close", (code) => {
      tarCode = code ?? 1;
      settle();
    });
  });
}

/** Paths the base commit holds inside the archived subtree, workspace-relative. */
export function expectedWorkspacePaths(treeOutput: string, repo: string): string[] {
  const subtree = archiveSubtree(repo);
  const prefix = subtree.length === 0 ? "" : `${subtree}/`;
  const out: string[] = [];
  for (const line of treeOutput.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (prefix.length > 0 && !trimmed.startsWith(prefix)) continue;
    out.push(prefix.length === 0 ? trimmed : trimmed.slice(prefix.length));
  }
  return out;
}

async function runIndex(workspace: string): Promise<{ report: IndexReport | null; ms: number; error: string }> {
  const started = Date.now();
  return exec(VTRACE_BIN, ["index", workspace, "--json"], {
    cwd: REPO_ROOT,
    maxBuffer: 512 * 1024 * 1024,
  })
    .then(({ stdout }) => ({ report: JSON.parse(stdout) as IndexReport, ms: Date.now() - started, error: "" }))
    .catch((error: { stdout?: string; stderr?: string }) => {
      // A repository-fatal index failure is an availability fact, not a crash.
      try {
        if (error.stdout && error.stdout.trim().startsWith("{")) {
          return { report: JSON.parse(error.stdout) as IndexReport, ms: Date.now() - started, error: "" };
        }
      } catch {
        /* fall through to the error path */
      }
      return { report: null, ms: Date.now() - started, error: (error.stderr ?? String(error)).slice(0, 400) };
    });
}

async function prepareOne(
  kase: PoolCandidate,
  benchReposRoot: string,
  outRoot: string,
): Promise<PreparedWorkspace> {
  const workspace = path.join(outRoot, kase.instanceId);
  const clone = path.join(benchReposRoot, benchCloneName(kase.repo));
  const subtree = archiveSubtree(kase.repo);
  const archiveFrom = subtree.length === 0 ? clone : path.join(clone, subtree);
  const base = {
    instanceId: kase.instanceId,
    repo: kase.repo,
    baseCommit: kase.baseCommit,
    workspace: path.relative(REPO_ROOT, workspace),
  };
  const fail = (availability: Availability, detail: string, extra: Partial<PreparedWorkspace> = {}): PreparedWorkspace => ({
    ...base,
    availability,
    detail,
    sourceFilesExpected: 0,
    sourceFilesOnDisk: 0,
    archiveOmissions: 0,
    missingGoldFiles: [],
    index: null,
    indexMs: 0,
    ...extra,
  });

  if (!existsSync(archiveFrom)) {
    return fail("PREPARATION_INVALID", `archive source missing: ${archiveFrom}`);
  }

  const present = await git(clone, ["cat-file", "-e", `${kase.baseCommit}^{commit}`]);
  if (!present.ok) {
    const fetch = await git(clone, ["fetch", "--depth", "1", "--quiet", "origin", kase.baseCommit]);
    if (!fetch.ok) return fail("PREPARATION_INVALID", `fetch failed: ${fetch.stderr.trim().slice(0, 200)}`);
  }

  const tree = await git(clone, ["ls-tree", "-r", "--name-only", kase.baseCommit]);
  if (!tree.ok) return fail("PREPARATION_INVALID", `ls-tree failed: ${tree.stderr.trim().slice(0, 200)}`);
  const expected = expectedWorkspacePaths(tree.stdout, kase.repo);

  await mkdir(workspace, { recursive: true });
  try {
    await archiveExtract(archiveFrom, kase.baseCommit, workspace);
  } catch (error) {
    return fail("PREPARATION_INVALID", `archive/extract failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // THE COMPLETENESS GATE. `git archive` legitimately drops paths marked
  // `export-ignore`, so a plain count mismatch is informational — but a MISSING
  // GOLD FILE is fatal, because that is precisely the django-13590 shape.
  const onDisk = expected.filter((relative) => existsSync(path.join(workspace, relative)));
  const omissions = expected.length - onDisk.length;
  const goldInScope = kase.expectedFiles.filter(
    (file) => withinArchiveSubtree(kase.repo, file) && !kase.goldFilesCreatedByPatch.includes(file),
  );
  const missingGold = goldInScope.filter(
    (file) => !existsSync(path.join(workspace, goldPathInWorkspace(kase.repo, file))),
  );
  if (missingGold.length > 0) {
    return fail(
      "PREPARATION_INVALID",
      `workspace is missing gold file(s) that exist at the base commit: ${missingGold.join(", ")}`,
      {
        sourceFilesExpected: expected.length,
        sourceFilesOnDisk: onDisk.length,
        archiveOmissions: omissions,
        missingGoldFiles: missingGold,
      },
    );
  }

  const init = await git(workspace, ["init", "-q"]);
  if (!init.ok) return fail("PREPARATION_INVALID", `git init failed: ${init.stderr.trim().slice(0, 200)}`);

  const { report, ms, error } = await runIndex(workspace);
  const shared = {
    sourceFilesExpected: expected.length,
    sourceFilesOnDisk: onDisk.length,
    archiveOmissions: omissions,
    missingGoldFiles: [] as string[],
  };
  if (report === null || !existsSync(path.join(workspace, INDEX_RELPATH))) {
    return fail("UNAVAILABLE", `vtrace index failed: ${error || "no index produced"}`, { ...shared, indexMs: ms });
  }

  const parseFailures = report.totalParseFailures ?? 0;
  const readFailures = report.totalReadFailures ?? 0;
  const complete = report.coverage?.complete ?? true;
  const index = {
    filesScanned: report.totalFilesScanned ?? 0,
    filesIndexed: report.totalFilesSuccessfullyIndexed ?? 0,
    parseFailures,
    readFailures,
    symbols: report.totalSymbols ?? 0,
    relationships: report.totalRelationships ?? 0,
    coverageComplete: complete,
    failedLanguages: report.coverage?.failedLanguages ?? [],
  };
  // §32 — contained per-file parse failures leave the repository usable and
  // degraded. They are NEVER promoted to unavailable.
  const availability: Availability = parseFailures + readFailures > 0 || !complete ? "DEGRADED_VALID" : "VALID";
  return {
    ...base,
    availability,
    detail:
      availability === "VALID"
        ? "indexed; full coverage"
        : `indexed with contained per-file failures (parse ${parseFailures}, read ${readFailures})`,
    ...shared,
    index,
    indexMs: ms,
  };
}

interface Config {
  readonly manifest: string;
  readonly outRoot: string;
  readonly benchReposRoot: string;
  readonly out: string;
  readonly concurrency: number;
  readonly limit: number | null;
}

export function parseArgs(argv: readonly string[]): Config {
  let manifest = path.join(RESULTS, "stage5_m160_broad100b_manifest.json");
  let outRoot = DEFAULT_OUT_ROOT;
  let benchReposRoot = DEFAULT_BENCH_REPOS_ROOT;
  let out = RESULTS;
  let concurrency = 5;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[(i += 1)];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--manifest") manifest = value();
    else if (arg === "--out-root") outRoot = value();
    else if (arg === "--bench-repos-root") benchReposRoot = value();
    else if (arg === "--out") out = value();
    else if (arg === "--concurrency") concurrency = Number(value());
    else if (arg === "--limit") limit = Number(value());
    else throw new Error(`Unknown argument ${arg}`);
  }
  return { manifest, outRoot, benchReposRoot, out, concurrency, limit };
}

async function main(config: Config): Promise<void> {
  const manifest = JSON.parse(await readFile(config.manifest, "utf8")) as { cases: PoolCandidate[] };
  const cases = config.limit === null ? manifest.cases : manifest.cases.slice(0, config.limit);
  await mkdir(config.outRoot, { recursive: true });

  const results: PreparedWorkspace[] = [];
  const started = Date.now();
  let cursor = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, config.concurrency) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const kase = cases[index];
        if (kase === undefined) return;
        const prepared = await prepareOne(kase, config.benchReposRoot, config.outRoot);
        results.push(prepared);
        done += 1;
        console.log(
          `[${done}/${cases.length}] ${prepared.availability} ${kase.instanceId} ` +
            `(${prepared.index?.filesIndexed ?? 0} files, ${Math.round(prepared.indexMs / 1000)}s)`,
        );
      }
    }),
  );
  results.sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1));

  const counts = new Map<string, number>();
  for (const row of results) counts.set(row.availability, (counts.get(row.availability) ?? 0) + 1);

  const doc = {
    schemaVersion: "stage5.m160.broad100b-workspaces.v1",
    milestone: "M160",
    kind: "fresh, provenance-bound workspace preparation for the frozen Broad100-B corpus (§30)",
    protocol: {
      archiveSubtreeByRepo: "django from its package directory; every other repository from its root (inherited from Broad100-A)",
      historyIncluded: false,
      completenessGate: "every base-commit path checked on disk; a missing in-scope gold file refuses the workspace",
      indexMode: "fresh full index per workspace, from the frozen product build",
      quarantine: "none — M156 removed benchmark quarantine and M160 does not resurrect it (§31)",
    },
    counts: Object.fromEntries([...counts].sort()),
    totals: {
      cases: results.length,
      indexedFiles: results.reduce((sum, row) => sum + (row.index?.filesIndexed ?? 0), 0),
      parseFailures: results.reduce((sum, row) => sum + (row.index?.parseFailures ?? 0), 0),
      symbols: results.reduce((sum, row) => sum + (row.index?.symbols ?? 0), 0),
      indexSeconds: Math.round(results.reduce((sum, row) => sum + row.indexMs, 0) / 1000),
      wallSeconds: Math.round((Date.now() - started) / 1000),
    },
    degraded: results
      .filter((row) => row.availability === "DEGRADED_VALID")
      .map((row) => ({
        instanceId: row.instanceId,
        repo: row.repo,
        parseFailures: row.index?.parseFailures ?? 0,
        readFailures: row.index?.readFailures ?? 0,
        failedLanguages: row.index?.failedLanguages ?? [],
      })),
    refused: results.filter((row) => row.availability === "PREPARATION_INVALID" || row.availability === "UNAVAILABLE"),
    workspaces: results,
  };

  const outPath = path.join(config.out, "stage5_m160_broad100b_workspaces.json");
  await writeFile(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  console.log(`\nprepared ${results.length}: ${JSON.stringify(doc.counts)}`);
  console.log(`  ${path.relative(REPO_ROOT, outPath)}`);
}

if (import.meta.main) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
