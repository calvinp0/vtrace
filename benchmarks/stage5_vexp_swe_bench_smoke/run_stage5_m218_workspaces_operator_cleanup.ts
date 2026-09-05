/**
 * Operator-authorised removal of the historical live-run workspace store,
 * `results/workspaces/` (git clones made by the M88–M155 live runs and corpus
 * studies; gitignored; not used by the M214 cohort, which extracts its trees
 * from the SWE-bench images into its own owned scratch).
 *
 * Same discipline as the /tmp cleanup: the root is fixed to that one directory,
 * every top-level entry is measured, checked for a live process, cwd, mount or
 * container bind, kept if it is a symlink or its realpath is not exactly
 * <root>/<name>, removed with a walk that never follows symlinks, and recorded.
 *
 *   bun .../run_stage5_m218_workspaces_operator_cleanup.ts --dry-run
 *   bun .../run_stage5_m218_workspaces_operator_cleanup.ts --execute --operator "<name>"
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

const RESULTS_DIR = join(import.meta.dir, "results");
const ROOT = join(RESULTS_DIR, "workspaces");
const OUTPUT = join(RESULTS_DIR, "stage5_m218_workspaces_operator_cleanup.json");
const VTRACE_ROOT = join(import.meta.dir, "..", "..");

interface Decision {
  readonly name: string;
  readonly bytes: number;
  readonly entries: number;
  readonly ageDays: number;
  readonly action: "REMOVED" | "KEPT_LIVE_REFERENCE" | "KEPT_SYMLINK" | "KEPT_PATH_MISMATCH" | "WOULD_REMOVE" | "KEPT_ERROR";
  readonly detail: string;
}

function duBytes(path: string): { bytes: number; entries: number } {
  const bytes = Number(execFileSync("du", ["-xs", "-B1", "--apparent-size", path], { encoding: "utf8", maxBuffer: 1 << 20 }).split("\t")[0]);
  const entries = Number(execFileSync("bash", ["-c", `find ${JSON.stringify(path)} -xdev | wc -l`], { encoding: "utf8" }).trim());
  return { bytes, entries };
}

function liveReferenceIndex(): { cmdlines: string[]; cwds: string[]; mounts: string[]; dockerSources: string[] } {
  const cmdlines: string[] = [];
  const cwds: string[] = [];
  const own = new Set([process.pid, process.ppid]);
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || own.has(Number(entry))) continue;
    try { cmdlines.push(readFileSync(`/proc/${entry}/cmdline`, "latin1").replace(/\0/g, " ")); } catch { /* gone */ }
    try { cwds.push(readlinkSync(`/proc/${entry}/cwd`)); } catch { /* not ours */ }
  }
  const mounts = readFileSync("/proc/self/mountinfo", "utf8").split("\n").map((line) => line.split(" ")[4] ?? "").filter(Boolean);
  let dockerSources: string[] = [];
  try {
    const ids = execFileSync("docker", ["ps", "-aq"], { encoding: "utf8", timeout: 30_000 }).split("\n").map((s) => s.trim()).filter(Boolean);
    if (ids.length > 0) {
      dockerSources = execFileSync("docker", ["inspect", "--format", "{{range .Mounts}}{{.Source}}\n{{end}}", ...ids], { encoding: "utf8", timeout: 60_000 })
        .split("\n").map((s) => s.trim()).filter(Boolean);
    }
  } catch {
    dockerSources = ["<docker enumeration failed: every candidate is treated as referenced>"];
  }
  return { cmdlines, cwds, mounts, dockerSources };
}

function referenced(path: string, index: ReturnType<typeof liveReferenceIndex>): string | null {
  const under = (candidate: string): boolean => candidate === path || candidate.startsWith(`${path}${sep}`);
  if (index.dockerSources.some((source) => source.startsWith("<docker enumeration failed"))) return index.dockerSources[0]!;
  const cmd = index.cmdlines.find((line) => line.includes(path));
  if (cmd !== undefined) return `process cmdline: ${cmd.slice(0, 120)}`;
  const cwd = index.cwds.find(under);
  if (cwd !== undefined) return `process cwd: ${cwd}`;
  const mount = index.mounts.find(under);
  if (mount !== undefined) return `mount: ${mount}`;
  const source = index.dockerSources.find(under);
  if (source !== undefined) return `container bind: ${source}`;
  return null;
}

function removeNoFollow(root: string): { errors: string[] } {
  const errors: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let stat;
      try { stat = lstatSync(path); } catch (error) { errors.push(`lstat ${path}: ${(error as Error).message}`); continue; }
      try {
        if (stat.isSymbolicLink() || !stat.isDirectory()) unlinkSync(path);
        else { walk(path); rmdirSync(path); }
      } catch (error) { errors.push(`remove ${path}: ${(error as Error).message}`); }
    }
  };
  walk(root);
  rmdirSync(root);
  return { errors };
}

function main(): void {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const operatorIndex = args.indexOf("--operator");
  const operator = operatorIndex >= 0 ? args[operatorIndex + 1] ?? "" : "";
  if (execute && operator.trim().length === 0) throw new Error("--execute requires --operator \"<name>\"");
  if (!existsSync(ROOT)) throw new Error(`${ROOT} does not exist`);
  const root = realpathSync(ROOT);
  const tracked = execFileSync("git", ["-C", VTRACE_ROOT, "ls-files", "benchmarks/stage5_vexp_swe_bench_smoke/results/workspaces"], { encoding: "utf8" }).trim();
  if (tracked.length > 0) throw new Error("refusing: results/workspaces contains git-tracked files");
  const ignored = execFileSync("git", ["-C", VTRACE_ROOT, "check-ignore", "benchmarks/stage5_vexp_swe_bench_smoke/results/workspaces"], { encoding: "utf8" }).trim();
  if (ignored.length === 0) throw new Error("refusing: results/workspaces is not gitignored");

  const index = liveReferenceIndex();
  const now = Date.now();
  const decisions: Decision[] = [];
  let removedBytes = 0;
  let removedEntries = 0;
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const stat = lstatSync(path);
    const measured = duBytes(path);
    const base = { name, bytes: measured.bytes, entries: measured.entries, ageDays: Number(((now - stat.mtimeMs) / 86_400_000).toFixed(1)) };
    if (stat.isSymbolicLink()) { decisions.push({ ...base, action: "KEPT_SYMLINK", detail: `-> ${readlinkSync(path)}` }); continue; }
    if (realpathSync(path) !== path) { decisions.push({ ...base, action: "KEPT_PATH_MISMATCH", detail: realpathSync(path) }); continue; }
    const live = referenced(path, index);
    if (live !== null) { decisions.push({ ...base, action: "KEPT_LIVE_REFERENCE", detail: live }); continue; }
    if (!execute) { decisions.push({ ...base, action: "WOULD_REMOVE", detail: "dry run" }); continue; }
    const result = removeNoFollow(path);
    if (result.errors.length > 0) decisions.push({ ...base, action: "KEPT_ERROR", detail: result.errors.slice(0, 3).join("; ") });
    else { decisions.push({ ...base, action: "REMOVED", detail: "historical live-run workspace; gitignored; untracked; no live reference; operator-authorised" }); removedBytes += measured.bytes; removedEntries += measured.entries; }
  }
  let rootRemoved = false;
  if (execute && decisions.every((d) => d.action === "REMOVED")) {
    try { rmdirSync(root); rootRemoved = true; } catch { rootRemoved = false; }
  }
  const byAction = decisions.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.action]: (acc[d.action] ?? 0) + 1 }), {});
  const document = {
    schemaVersion: "stage5.m218.workspaces-operator-cleanup.v1",
    generatedAt: new Date().toISOString(),
    root,
    mode: execute ? "EXECUTE" : "DRY_RUN",
    operator: execute ? operator : null,
    rationale: "the M214 cohort extracts each task's tree from its SWE-bench image into owned scratch; the historical clone store is unused by it, gitignored, untracked, and regenerable",
    candidates: decisions.length,
    byAction,
    totalBytes: decisions.reduce((t, d) => t + d.bytes, 0),
    removedBytes,
    removedEntries,
    rootRemoved,
    decisions,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`${document.mode}: ${decisions.length} entries, ${(document.totalBytes / 1024 ** 3).toFixed(1)} GiB; ${JSON.stringify(byAction)}; removed ${(removedBytes / 1024 ** 3).toFixed(1)} GiB / ${removedEntries} files; root removed ${rootRemoved}\nwrote ${OUTPUT}\n`);
}

main();
