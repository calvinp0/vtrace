// Stage 5R workspace preparation.
//
// WHY THIS EXISTS
// ----------------
// The deterministic Stage 5R retrieval eval needs, per instance, an indexed
// workspace (a checkout of the repo at the gold base_commit plus a vtrace
// `.vtrace/index.sqlite`). This script materializes those workspaces from a
// shallow bench clone — NO Docker, NO Claude, NO agent run, NO API calls. It is
// idempotent: an instance whose index already exists is skipped.
//
// For each instance it:
//   1. `git fetch --depth 1 origin <base_commit>` into the bench clone,
//   2. `git archive <base_commit> | tar -x` into `<out-root>/<instance_id>`
//      (a clean tree, no `.git` — vtrace indexes files, not history),
//   3. `vtrace index <workspace>` to build the index.
//
// Expected labels are NEVER consulted here — this only builds the searchable
// index Capsule v2 retrieval runs against.

import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_BENCH_REPO = "/home/calvin/code/vexp-swe-bench/.bench-repos/django__django/django";
const DEFAULT_BENCH_REPOS_ROOT = "/home/calvin/code/vexp-swe-bench/.bench-repos";
const DEFAULT_SWE_BENCH_DATA = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
const DEFAULT_OUT_ROOT = path.join(
  "benchmarks",
  "stage5_vexp_swe_bench_smoke",
  "results",
  "workspaces",
  "expanded",
);
// Cross-repo (non-Django) workspaces live in their own sibling root so the Django
// expansion set and the cross-repo set never collide on disk.
const DEFAULT_CROSS_REPO_OUT_ROOT = path.join(
  "benchmarks",
  "stage5_vexp_swe_bench_smoke",
  "results",
  "workspaces",
  "cross_repo",
);
const VTRACE_BIN = path.join("bin", "vtrace");
const INDEX_RELPATH = path.join(".vtrace", "index.sqlite");

// The deterministic 15-instance expansion set: the next 15 Django instances by
// number after the original five (10880/11095/11490/11728/11740). Chosen by a
// fixed rule, not cherry-picked, so the set is reproducible and not tuned.
export const DEFAULT_EXPANSION_INSTANCES: readonly string[] = [
  "django__django-10973",
  "django__django-11133",
  "django__django-11206",
  "django__django-11749",
  "django__django-11815",
  "django__django-11820",
  "django__django-12050",
  "django__django-12273",
  "django__django-12276",
  "django__django-12325",
  "django__django-12774",
  "django__django-12858",
  "django__django-13012",
  "django__django-13112",
  "django__django-13195",
];

// The first cross-repo (non-Django) retrieval set: a deterministic slice of the
// non-Django Python repos present in swe-bench-100. Selection rule: for each
// preferred repo, the first N instance_ids in sorted order — fixed and
// reproducible, not cherry-picked to the answer. Eight repos × 1–3 each = 16.
export const CROSS_REPO_INSTANCES: readonly string[] = [
  "sympy__sympy-12419",
  "sympy__sympy-12481",
  "sympy__sympy-13372",
  "scikit-learn__scikit-learn-10844",
  "scikit-learn__scikit-learn-11578",
  "matplotlib__matplotlib-22719",
  "matplotlib__matplotlib-24627",
  "astropy__astropy-14365",
  "astropy__astropy-14369",
  "pytest-dev__pytest-10051",
  "pytest-dev__pytest-5262",
  "sphinx-doc__sphinx-7462",
  "sphinx-doc__sphinx-7748",
  "psf__requests-1142",
  "psf__requests-1724",
  "pallets__flask-5014",
];

// The 14 NON-Django instances that grow the cross-repo set from 16 to 30. Picked
// for repo + issue-type diversity, NOT for being easy: three brand-new repos
// (pydata/xarray, mwaskom/seaborn, pylint-dev/pylint) join, and the issue mix
// spans parser/printing (sphinx docfields, sympy pycode), validation/error
// (pytest skipping, requests models), IO/encoding (astropy fits card + diff),
// plotting/rendering (matplotlib colors + figure, seaborn scales), config/options
// (pylint config), docs/build (sphinx napoleon), and core data structures
// (xarray variable + dataset, sympy mod). Every one has a gold patch that edits
// extractable Python source files. Multi-file patches (seaborn, pylint) are kept
// rather than filtered to easy single-file cases.
export const CROSS_REPO_EXPANSION_INSTANCES: readonly string[] = [
  "astropy__astropy-14539",
  "astropy__astropy-14598",
  "matplotlib__matplotlib-24970",
  "matplotlib__matplotlib-25960",
  "mwaskom__seaborn-3187",
  "psf__requests-5414",
  "pydata__xarray-2905",
  "pydata__xarray-3677",
  "pylint-dev__pylint-8898",
  "pytest-dev__pytest-7432",
  "sphinx-doc__sphinx-7910",
  "sphinx-doc__sphinx-9230",
  "sympy__sympy-15599",
  "sympy__sympy-16766",
];

// The full ~30-instance cross-repo set: the original 16 plus the 14 expansion
// instances. Shares the same `cross_repo` workspace root, so the already-indexed
// 16 are idempotently skipped on prep — only the 14 new ones are materialized.
export const CROSS_REPO_30_INSTANCES: readonly string[] = [
  ...CROSS_REPO_INSTANCES,
  ...CROSS_REPO_EXPANSION_INSTANCES,
];

export interface PrepareConfig {
  readonly benchRepo: string;
  readonly sweBenchData: string;
  readonly outRoot: string;
  readonly instances: readonly string[];
  // Cross-repo mode: resolve a per-repo bench clone under `benchReposRoot` from
  // each instance's `repo` field (lazily `git init`+remote), instead of using the
  // single fixed `benchRepo`. Lets non-Django repos be materialized.
  readonly crossRepo: boolean;
  readonly benchReposRoot: string;
}

// `owner/name` -> the canonical GitHub clone URL. SWE-bench repo slugs are exactly
// the GitHub `owner/name`, so this is a direct mapping (no per-repo special cases).
export function repoToGitUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

// `owner/name` -> the on-disk bench-clone directory (`<root>/owner__name`), the
// same `owner__name` convention SWE-bench uses for instance IDs.
export function benchRepoDir(benchReposRoot: string, repo: string): string {
  return path.join(benchReposRoot, repo.replace("/", "__"));
}

// Ensure a (possibly empty) bench clone exists for `repo` with `origin` pointing
// at GitHub, WITHOUT cloning history: a fresh `git init` + remote is enough — the
// per-instance `git fetch --depth 1 origin <commit>` pulls only the one needed
// commit. Idempotent: an existing clone just has its `origin` URL re-asserted.
export async function ensureBenchRepo(benchReposRoot: string, repo: string): Promise<string> {
  const dir = benchRepoDir(benchReposRoot, repo);
  const url = repoToGitUrl(repo);
  if (await pathExists(path.join(dir, ".git"))) {
    // Re-assert origin so a stale/missing remote can't break the fetch.
    await run("git", ["remote", "set-url", "origin", url], dir);
    return dir;
  }
  await mkdir(dir, { recursive: true });
  const init = await run("git", ["init", "-q"], dir);
  if (init.code !== 0) throw new Error(`git init failed for ${repo}: ${init.stderr.trim()}`);
  const remote = await run("git", ["remote", "add", "origin", url], dir);
  if (remote.code !== 0) throw new Error(`git remote add failed for ${repo}: ${remote.stderr.trim()}`);
  return dir;
}

interface SweBenchRecord {
  readonly instance_id: string;
  readonly repo: string;
  readonly base_commit: string;
}

// Read the (instance_id -> base_commit, repo) map from the SWE-bench JSONL.
export async function loadBaseCommits(dataPath: string): Promise<Map<string, SweBenchRecord>> {
  const content = await readFile(dataPath, "utf8");
  const out = new Map<string, SweBenchRecord>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof record === "object" &&
      record !== null &&
      typeof (record as Record<string, unknown>).instance_id === "string" &&
      typeof (record as Record<string, unknown>).base_commit === "string"
    ) {
      const r = record as Record<string, unknown>;
      out.set(r.instance_id as string, {
        instance_id: r.instance_id as string,
        repo: (r.repo as string) ?? "django/django",
        base_commit: r.base_commit as string,
      });
    }
  }
  return out;
}

function run(command: string, args: readonly string[], cwd?: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

// `git archive <commit> | tar -x -C <dest>` without a shell pipe. Both halves are
// observed: if `git archive` exits non-zero (e.g. a not-yet-fetched commit) its
// stdout closes early and tar sees a truncated stream — we surface git's error
// rather than letting an EPIPE on the pipe crash the process.
function archiveExtract(benchRepo: string, commit: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const git = spawn("git", ["archive", commit], { cwd: benchRepo, stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-x", "-C", dest], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    let gitCode: number | null = null;
    let tarCode: number | null = null;
    git.stderr?.on("data", (c) => (err += String(c)));
    tar.stderr?.on("data", (c) => (err += String(c)));
    // Swallow EPIPE on the pipe — tar closing early must not throw uncaught.
    git.stdout?.on("error", () => {});
    tar.stdin?.on("error", () => {});
    git.stdout?.pipe(tar.stdin!);
    git.on("error", reject);
    tar.on("error", reject);
    const settle = (): void => {
      if (gitCode === null || tarCode === null) return;
      if (gitCode !== 0) reject(new Error(`git archive exited ${gitCode}: ${err.trim()}`));
      else if (tarCode !== 0) reject(new Error(`tar exited ${tarCode}: ${err.trim()}`));
      else resolve();
    };
    git.on("close", (code) => {
      gitCode = code ?? 1;
      settle();
    });
    tar.on("close", (code) => {
      tarCode = code ?? 1;
      settle();
    });
  });
}

async function pathExists(target: string): Promise<boolean> {
  return stat(target).then(() => true).catch(() => false);
}

export interface PrepareResult {
  readonly instance_id: string;
  readonly workspace: string;
  readonly status: "indexed" | "skipped_present" | "error";
  readonly detail?: string;
}

export async function prepareWorkspaces(config: PrepareConfig): Promise<PrepareResult[]> {
  const baseCommits = await loadBaseCommits(config.sweBenchData);
  const results: PrepareResult[] = [];
  for (const instanceId of config.instances) {
    const workspace = path.join(config.outRoot, instanceId);
    const indexPath = path.join(workspace, INDEX_RELPATH);
    if (await pathExists(indexPath)) {
      results.push({ instance_id: instanceId, workspace, status: "skipped_present" });
      process.stdout.write(`· ${instanceId}: index already present, skipping\n`);
      continue;
    }
    const record = baseCommits.get(instanceId);
    if (!record) {
      results.push({ instance_id: instanceId, workspace, status: "error", detail: "not found in swe-bench data" });
      process.stderr.write(`✗ ${instanceId}: not found in ${config.sweBenchData}\n`);
      continue;
    }
    try {
      await mkdir(workspace, { recursive: true });
      // In cross-repo mode the bench clone is resolved (and lazily created) per
      // instance from its repo slug; otherwise the single fixed Django clone.
      const benchRepo = config.crossRepo
        ? await ensureBenchRepo(config.benchReposRoot, record.repo)
        : config.benchRepo;
      const fetch = await run("git", ["fetch", "--depth", "1", "origin", record.base_commit], benchRepo);
      if (fetch.code !== 0) throw new Error(`git fetch failed: ${fetch.stderr.trim()}`);
      await archiveExtract(benchRepo, record.base_commit, workspace);
      // `git init` plants a repo-root marker so `vtrace index` stops project-root
      // detection AT the workspace. Without it, a workspace nested inside the
      // vtrace repo resolves the root up to vtrace itself (wrong index, and a lock
      // on vtrace's own .vtrace). The archive carries no `.git`, so we add an empty one.
      const gitInit = await run("git", ["init", "-q"], workspace);
      if (gitInit.code !== 0) throw new Error(`git init failed: ${gitInit.stderr.trim()}`);
      const index = await run(VTRACE_BIN, ["index", workspace, "--quiet"]);
      if (index.code !== 0) throw new Error(`vtrace index failed: ${index.stderr.trim()}`);
      results.push({ instance_id: instanceId, workspace, status: "indexed" });
      process.stdout.write(`✓ ${instanceId}: indexed at ${workspace}\n`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ instance_id: instanceId, workspace, status: "error", detail });
      process.stderr.write(`✗ ${instanceId}: ${detail}\n`);
    }
  }
  return results;
}

export function parsePrepareArgs(argv: readonly string[]): PrepareConfig {
  let benchRepo = DEFAULT_BENCH_REPO;
  let benchReposRoot = DEFAULT_BENCH_REPOS_ROOT;
  let sweBenchData = DEFAULT_SWE_BENCH_DATA;
  let crossRepo = false;
  let crossRepo30 = false;
  let outRoot: string | null = null;
  let instances: string[] | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => {
      const v = argv[(i += 1)];
      if (v === undefined) throw new Error(`Flag ${arg} requires a value.`);
      return v;
    };
    if (arg === "--bench-repo") benchRepo = value();
    else if (arg === "--bench-repos-root") benchReposRoot = value();
    else if (arg === "--swe-bench-data") sweBenchData = value();
    else if (arg === "--out-root") outRoot = value();
    else if (arg === "--instances") instances = value().split(",").map((s) => s.trim()).filter(Boolean);
    // Cross-repo mode flips the defaults: the cross-repo instance set, the
    // cross_repo workspace root, and per-instance bench-clone resolution.
    else if (arg === "--cross-repo") crossRepo = true;
    // The ~30-instance superset (16 + 14 expansion). Same cross_repo root + per-repo
    // clones — the indexed 16 are skipped, only the 14 new ones are materialized.
    else if (arg === "--cross-repo-30") {
      crossRepo = true;
      crossRepo30 = true;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  const defaultInstances = crossRepo30
    ? [...CROSS_REPO_30_INSTANCES]
    : crossRepo
      ? [...CROSS_REPO_INSTANCES]
      : [...DEFAULT_EXPANSION_INSTANCES];
  return {
    benchRepo,
    benchReposRoot,
    sweBenchData,
    crossRepo,
    outRoot: outRoot ?? (crossRepo ? DEFAULT_CROSS_REPO_OUT_ROOT : DEFAULT_OUT_ROOT),
    instances: instances ?? defaultInstances,
  };
}

if (import.meta.main) {
  const config = parsePrepareArgs(process.argv.slice(2));
  prepareWorkspaces(config)
    .then((results) => {
      const indexed = results.filter((r) => r.status === "indexed").length;
      const skipped = results.filter((r) => r.status === "skipped_present").length;
      const errors = results.filter((r) => r.status === "error").length;
      process.stdout.write(`\nStage 5R workspaces: ${indexed} indexed · ${skipped} skipped · ${errors} errors\n`);
      if (errors > 0) process.exit(1);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
