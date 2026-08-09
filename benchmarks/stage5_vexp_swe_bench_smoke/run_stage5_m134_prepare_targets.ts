// Prepare an isolated, same-source target corpus for one side of an M134 replay.
// Each target is a local shared clone pinned to the fixture worktree's exact HEAD,
// then indexed with the selected historical VTRACE implementation. No target
// index, manifest, parse cache, or state is shared between comparison sides.

import { access, cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";

import { loadRetrievalFixture } from "./run_stage5_retrieval_eval";
import { hashStable } from "./benchmarkProvenance";

interface Config {
  readonly vtraceRoot: string;
  readonly fixture: string;
  readonly outRoot: string;
  readonly outFixture: string;
  readonly report: string;
}

async function main(config: Config): Promise<void> {
  const entries = await loadRetrievalFixture(config.fixture);
  await mkdir(config.outRoot, { recursive: true });
  const rewritten = [];
  const targets = [];
  for (const entry of entries) {
    const source = path.resolve(entry.workspace);
    const destination = path.join(config.outRoot, entry.instance_id);
    const indexPath = path.join(destination, ".vtrace", "index.sqlite");
    const resumed = hasIndexedFiles(indexPath);
    let indexStatus = "historical_run_success";
    let indexOutputHash: string | null = null;
    let diagnosticHash: string | null = null;
    let unsupportedFiles: Array<{ path: string; hash: string }> = [];
    if (!resumed) {
      if (!(await exists(destination))) {
        await cp(source, destination, {
          recursive: true,
          filter: (candidate) => {
            const relative = path.relative(source, candidate).replace(/\\/g, "/");
            return relative !== ".git" && !relative.startsWith(".git/")
              && relative !== ".vtrace" && !relative.startsWith(".vtrace/");
          },
        });
      }
      const quarantined: Array<{ relative: string; source: string; held: string; hash: string }> = [];
      try {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const index = Bun.spawnSync(
            ["bash", path.join(config.vtraceRoot, "bin/vtrace"), "index", destination, "--mode", "full", "--quiet", "--json"],
            { cwd: config.vtraceRoot, stdout: "pipe", stderr: "pipe" },
          );
          indexOutputHash = hashStable(index.stdout.toString());
          if (index.exitCode === 0 && hasIndexedFiles(indexPath)) break;
          const stderr = index.stderr.toString();
          const failedPaths = parseFailedFilePaths(stderr);
          if (failedPaths.length === 0) {
            throw new Error(`Historical index failed for ${entry.instance_id}: ${stderr.trim()}`);
          }
          diagnosticHash = hashStable(stderr);
          for (const relative of failedPaths) {
            const original = path.join(destination, relative);
            if (!(await exists(original))) continue;
            const held = path.join(destination, ".vtrace", "m134-unsupported", relative);
            await mkdir(path.dirname(held), { recursive: true });
            quarantined.push({ relative, source: original, held, hash: hashStable(await readFile(original)) });
            await rename(original, held);
          }
          if (attempt === 7) throw new Error(`Historical index did not converge for ${entry.instance_id}.`);
        }
        if (!hasIndexedFiles(indexPath)) throw new Error(`Historical index is empty for ${entry.instance_id}.`);
        if (quarantined.length > 0) {
          indexStatus = "historical_run_success_with_unsupported_files";
          unsupportedFiles = quarantined.map(({ relative, hash }) => ({ path: relative, hash }));
        }
      } finally {
        for (const item of quarantined) await rename(item.held, item.source);
      }
    } else {
      indexStatus = "resumed_isolated_state";
    }
    rewritten.push({ ...entry, workspace: destination });
    targets.push({
      instanceId: entry.instance_id,
      repository: entry.repo,
      commit: null,
      tree: null,
      sourceWorkspace: entry.workspace,
      preparedWorkspace: destination,
      indexOutputHash,
      diagnosticHash,
      indexStatus,
      unsupportedFiles,
    });
    process.stdout.write(`prepared ${entry.instance_id}\n`);
  }
  await writeFile(config.outFixture, `${JSON.stringify(rewritten, null, 2)}\n`, "utf8");
  await writeFile(config.report, `${JSON.stringify({
    schemaVersion: "stage5.m134.prepared-target-corpus.v1",
    vtraceCommit: git(config.vtraceRoot, ["rev-parse", "HEAD"]),
    targetCorpusHash: hashStable(targets.map(({ preparedWorkspace: _prepared, sourceWorkspace: _source, ...target }) => target)),
    targets,
  }, null, 2)}\n`, "utf8");
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true).catch(() => false);
}

function hasIndexedFiles(dbPath: string): boolean {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query("SELECT COUNT(*) AS count FROM files").get() as { count: number } | null;
      return (row?.count ?? 0) > 0;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function parseFailedFilePaths(stderr: string): string[] {
  return [...stderr.matchAll(/^- (.+?) — [^\n]+$/gmu)].map((match) => match[1]!).sort();
}

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString().trim();
}

function parseArgs(argv: readonly string[]): Config {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined) throw new Error("Invalid target-preparation arguments.");
    values.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw new Error(`Missing ${flag}.`);
    return path.resolve(value);
  };
  return {
    vtraceRoot: required("--vtrace-root"),
    fixture: required("--fixture"),
    outRoot: required("--out-root"),
    outFixture: required("--out-fixture"),
    report: required("--report"),
  };
}

if (import.meta.main) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
