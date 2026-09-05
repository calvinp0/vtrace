/**
 * M218 §24 follow-up — the OPERATOR-authorised cleanup of historical vtrace
 * scratch under the shared /tmp.
 *
 * The census attributed the entries by name prefix to vtrace's own unit-test
 * fixtures and Stage 5 runners but could not prove ownership to the §12
 * standard, so M218 deleted nothing. This script exists for the operator who
 * has read that census and decided. It is deliberately narrow:
 *
 *   * only top-level entries whose basename matches a registered vtrace
 *     producer prefix; system, browser, Claude Code and unattributed entries
 *     are never candidates;
 *   * every candidate is checked for a live process (cmdline or cwd), a host
 *     mount and a container bind before deletion; a referenced entry is kept;
 *   * a top-level symlink is never followed; a candidate whose realpath is not
 *     exactly /tmp/<name> is kept; the walk unlinks symlinks without following;
 *   * every decision is recorded with bytes, entries, age and producer.
 *
 *   bun .../run_stage5_m218_tmp_operator_cleanup.ts --dry-run
 *   bun .../run_stage5_m218_tmp_operator_cleanup.ts --execute --operator "<name>"
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { measureTree } from "./m218ScratchLifecycle";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m218_tmp_operator_cleanup.json");

/** Registered vtrace producers, from the census (`stage5_m218_tmp_census.json`). */
const VTRACE_PREFIXES: readonly { readonly pattern: RegExp; readonly producer: string }[] = Object.freeze([
  { pattern: /^vtrace-/, producer: "src/**/__fixtures__ and benchmark mkdtemp fixtures (vtrace-*)" },
  { pattern: /^m(1\d\d|2[01]\d)[-_]/, producer: "Stage 5 milestone runners and their tests (m100–m219 prefixes)" },
  { pattern: /^stage[45]-/, producer: "Stage 4/5 benchmark unit-test fixtures" },
  { pattern: /^arc-stage/, producer: "benchmarks/arc_stage* fixtures" },
  { pattern: /^(pivot-|pilot-|loc-signals|capsule-v|gp-critic|astropy-diag)/, producer: "src/**/__tests__ fixtures" },
]);

interface Decision {
  readonly name: string;
  readonly producer: string;
  readonly bytes: number;
  readonly entries: number;
  readonly ageDays: number | null;
  readonly action: "REMOVED" | "KEPT_LIVE_REFERENCE" | "KEPT_SYMLINK" | "KEPT_PATH_MISMATCH" | "WOULD_REMOVE" | "KEPT_ERROR";
  readonly detail: string;
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

/** Remove a tree rooted at an authorised /tmp entry, never following symlinks. */
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
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) unlinkSync(root);
  else { walk(root); rmdirSync(root); }
  return { errors };
}

function main(): void {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const operatorIndex = args.indexOf("--operator");
  const operator = operatorIndex >= 0 ? args[operatorIndex + 1] ?? "" : "";
  if (execute && operator.trim().length === 0) throw new Error("--execute requires --operator \"<name>\": this is an operator decision, recorded as such");
  const root = realpathSync(tmpdir());
  if (root !== "/tmp") throw new Error(`refusing: the shared temporary directory is ${root}, not /tmp`);
  const index = liveReferenceIndex();
  const now = Date.now();
  const decisions: Decision[] = [];
  let removedBytes = 0;
  let removedEntries = 0;
  for (const name of readdirSync(root).sort()) {
    const match = VTRACE_PREFIXES.find((entry) => entry.pattern.test(name));
    if (match === undefined) continue;
    const path = join(root, name);
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    const measured = measureTree(path);
    const base = { name, producer: match.producer, bytes: measured.bytes, entries: measured.inodes, ageDays: Number(((now - stat.mtimeMs) / 86_400_000).toFixed(1)) };
    if (stat.isSymbolicLink()) { decisions.push({ ...base, action: "KEPT_SYMLINK", detail: `-> ${readlinkSync(path)}` }); continue; }
    let canonical = "";
    try { canonical = realpathSync(path); } catch (error) { decisions.push({ ...base, action: "KEPT_ERROR", detail: (error as Error).message }); continue; }
    if (canonical !== path) { decisions.push({ ...base, action: "KEPT_PATH_MISMATCH", detail: canonical }); continue; }
    const live = referenced(path, index);
    if (live !== null) { decisions.push({ ...base, action: "KEPT_LIVE_REFERENCE", detail: live }); continue; }
    if (!execute) { decisions.push({ ...base, action: "WOULD_REMOVE", detail: "dry run" }); continue; }
    const result = removeNoFollow(path);
    if (result.errors.length > 0) decisions.push({ ...base, action: "KEPT_ERROR", detail: result.errors.slice(0, 3).join("; ") });
    else { decisions.push({ ...base, action: "REMOVED", detail: "ownership by registered vtrace producer prefix; no live process, cwd, mount or container bind; operator-authorised" }); removedBytes += measured.bytes; removedEntries += measured.inodes; }
  }
  const byAction = decisions.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.action]: (acc[d.action] ?? 0) + 1 }), {});
  const byProducer = VTRACE_PREFIXES.map((p) => ({ producer: p.producer, entries: decisions.filter((d) => d.producer === p.producer).length, bytes: decisions.filter((d) => d.producer === p.producer).reduce((t, d) => t + d.bytes, 0) }));
  const document = {
    schemaVersion: "stage5.m218.tmp-operator-cleanup.v1",
    milestone: "M218 (operator follow-up)",
    generatedAt: new Date().toISOString(),
    mode: execute ? "EXECUTE" : "DRY_RUN",
    operator: execute ? operator : null,
    rule: "only registered vtrace producer prefixes; live process/cwd/mount/container bind keeps the entry; top-level symlinks never followed; realpath must equal /tmp/<name>; nothing else under /tmp is a candidate",
    neverCandidates: ["system and browser temp", "claude-1000 (Claude Code sessions)", "m0xx-* (other projects)", "unattributed entries"],
    candidates: decisions.length,
    byAction,
    byProducer,
    removedBytes,
    removedEntries,
    decisions,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`${document.mode}: ${decisions.length} candidates; ${JSON.stringify(byAction)}; removed ${removedBytes} bytes / ${removedEntries} entries\nwrote ${OUTPUT}\n`);
}

main();
