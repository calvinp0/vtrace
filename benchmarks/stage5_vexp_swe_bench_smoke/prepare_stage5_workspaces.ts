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
const DEFAULT_SWE_BENCH_DATA = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
const DEFAULT_OUT_ROOT = path.join(
  "benchmarks",
  "stage5_vexp_swe_bench_smoke",
  "results",
  "workspaces",
  "expanded",
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

export interface PrepareConfig {
  readonly benchRepo: string;
  readonly sweBenchData: string;
  readonly outRoot: string;
  readonly instances: readonly string[];
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
      const fetch = await run("git", ["fetch", "--depth", "1", "origin", record.base_commit], config.benchRepo);
      if (fetch.code !== 0) throw new Error(`git fetch failed: ${fetch.stderr.trim()}`);
      await archiveExtract(config.benchRepo, record.base_commit, workspace);
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
  let sweBenchData = DEFAULT_SWE_BENCH_DATA;
  let outRoot = DEFAULT_OUT_ROOT;
  let instances = [...DEFAULT_EXPANSION_INSTANCES];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => {
      const v = argv[(i += 1)];
      if (v === undefined) throw new Error(`Flag ${arg} requires a value.`);
      return v;
    };
    if (arg === "--bench-repo") benchRepo = value();
    else if (arg === "--swe-bench-data") sweBenchData = value();
    else if (arg === "--out-root") outRoot = value();
    else if (arg === "--instances") instances = value().split(",").map((s) => s.trim()).filter(Boolean);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { benchRepo, sweBenchData, outRoot, instances };
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
