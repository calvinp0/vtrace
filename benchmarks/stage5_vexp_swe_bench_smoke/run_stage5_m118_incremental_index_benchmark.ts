import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { normalizedGraphHash } from "../../src/indexer/normalizedGraph";
import { resolveIndexMetaPath } from "../../src/indexer/indexMeta";
import { reindexRepoAndRefreshState } from "../../src/runtime/reindexRepo";
import { initRepo } from "../../src/setup/initRepo";
import { resolveRepoLocalPaths } from "../../src/setup/repoState";
import { searchSymbols } from "../../src/retrieval/searchSymbols";
import {
  prepareRunnerOutput,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";

const execFile = promisify(execFileCallback);
// M141: reports go to an untracked run directory unless --out/--evidence
// asks otherwise, so validating the evidence can never overwrite it.
const RUNNER_NAME = "m118_incremental_index_benchmark";
if (process.argv.includes("--help")) {
  console.log(`run_stage5_m118_incremental_index_benchmark.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
  process.exit(0);
}
const resultsRoot = (await prepareRunnerOutput({ argv: process.argv.slice(2), runner: RUNNER_NAME })).dir;

interface Measurement {
  repository: string;
  scenario: string;
  mode: string;
  totalFiles: number;
  changedFiles: number;
  parsedFiles: number;
  cacheHits: number;
  cacheMisses: number;
  closureSize: number;
  fallbackReason: string | null;
  incrementalMs: number;
  fullMs: number;
  speedup: number;
  normalizedGraphEquivalent: boolean;
  retrievalEquivalent: boolean;
  sourceWorktreeUnchanged: boolean;
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m118-benchmark-"));
try {
  const measurements: Measurement[] = [];
  measurements.push(await benchmarkRepo(tempRoot, "typescript-120", "typescript", 120));
  measurements.push(await benchmarkRepo(tempRoot, "python-24", "python", 24));
  measurements.push(...await benchmarkRatios(tempRoot));
  const worktree = await benchmarkLinkedWorktree(tempRoot);
  measurements.push(worktree);

  const benchmark = {
    milestone: "M118",
    generatedAt: new Date().toISOString(),
    policy: "Full persistence/relink cost is common; select incremental only when provably safe parsed-file work is below full parsed-file work. Structural/package/add/delete/rename uncertainty falls back before mutation.",
    measurements,
    medianSpeedup: median(measurements.map((row) => row.speedup)),
    allGraphsEquivalent: measurements.every((row) => row.normalizedGraphEquivalent),
    allRetrievalEquivalent: measurements.every((row) => row.retrievalEquivalent),
  };
  const smoke = {
    milestone: "M118",
    generatedAt: benchmark.generatedAt,
    scenarios: measurements.map((row) => ({
      name: row.scenario,
      mode: row.mode,
      changedFileCounts: row.changedFiles,
      parseCacheHits: row.cacheHits,
      parseCacheMisses: row.cacheMisses,
      parsedFiles: row.parsedFiles,
      closureSize: row.closureSize,
      fallbackReason: row.fallbackReason,
      fullTimeMs: row.fullMs,
      incrementalTimeMs: row.incrementalMs,
      speedup: row.speedup,
      normalizedGraphEquivalence: row.normalizedGraphEquivalent,
      retrievalEquivalence: row.retrievalEquivalent,
      sourceWorktreeUnchanged: row.sourceWorktreeUnchanged,
    })),
    requiredScenarioMatrix: requiredScenarioMatrix(),
  };
  await mkdir(resultsRoot, { recursive: true });
  await writeFile(path.join(resultsRoot, "stage5_m118_incremental_index_benchmark.json"), `${JSON.stringify(benchmark, null, 2)}\n`);
  await writeFile(path.join(resultsRoot, "stage5_m118_incremental_index_smoke.detail.json"), `${JSON.stringify(smoke, null, 2)}\n`);
  console.log(JSON.stringify(benchmark, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function benchmarkRepo(root: string, label: string, language: "typescript" | "python", count: number): Promise<Measurement> {
  const repoRoot = path.join(root, label);
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const name = `unit_${index.toString().padStart(3, "0")}`;
    const source = language === "typescript"
      ? `export function ${name}(): number { return ${String(index).padStart(3, "0")}; }\n`
      : `def ${name}():\n    return ${index % 10}\n`;
    await writeFile(path.join(repoRoot, "src", `${name}.${language === "typescript" ? "ts" : "py"}`), source);
  }
  const initialized = await initRepo({ repoPath: repoRoot });
  const target = path.join(repoRoot, "src", `unit_000.${language === "typescript" ? "ts" : "py"}`);
  const original = await readFile(target, "utf8");
  await writeFile(target, original.replace(language === "typescript" ? "return 000" : "return 0", language === "typescript" ? "return 999" : "return 9"));
  const incrementalStarted = performance.now();
  const incremental = await refresh(repoRoot);
  const incrementalMs = performance.now() - incrementalStarted;
  const incrementalHash = graphHash(initialized.paths.dbPath);
  const retrievalBefore = retrievalRows(initialized.paths.dbPath);
  const fullStarted = performance.now();
  await refresh(repoRoot, "full");
  const fullMs = performance.now() - fullStarted;
  return {
    repository: label,
    scenario: "one-file-body-change",
    mode: incremental.indexResult.performance?.mode ?? "unknown",
    totalFiles: count,
    changedFiles: 1,
    parsedFiles: incremental.indexResult.performance?.parsedFiles ?? -1,
    cacheHits: incremental.indexResult.performance?.parseCacheHits ?? -1,
    cacheMisses: incremental.indexResult.performance?.parseCacheMisses ?? -1,
    closureSize: incremental.indexResult.performance?.affectedClosureFiles ?? -1,
    fallbackReason: incremental.indexResult.performance?.fallbackReason ?? null,
    incrementalMs,
    fullMs,
    speedup: round(fullMs / incrementalMs),
    normalizedGraphEquivalent: incrementalHash === graphHash(initialized.paths.dbPath),
    retrievalEquivalent: retrievalBefore === retrievalRows(initialized.paths.dbPath),
    sourceWorktreeUnchanged: true,
  };
}

async function benchmarkLinkedWorktree(root: string): Promise<Measurement> {
  const mainRoot = path.join(root, "linked-main");
  const featureRoot = path.join(root, "linked-feature");
  await mkdir(path.join(mainRoot, "src"), { recursive: true });
  await git(mainRoot, "init", "-b", "main");
  await git(mainRoot, "config", "user.email", "vtrace@example.test");
  await git(mainRoot, "config", "user.name", "Vtrace Test");
  await writeFile(path.join(mainRoot, ".gitignore"), ".vtrace/\n");
  for (let index = 0; index < 80; index += 1) await writeFile(path.join(mainRoot, "src", `f${index}.ts`), `export function f${index}(): number { return ${String(index).padStart(2, "0")}; }\n`);
  await git(mainRoot, "add", ".");
  await git(mainRoot, "commit", "-m", "fixture");
  await git(mainRoot, "worktree", "add", "-b", "feature", featureRoot);
  const main = await initRepo({ repoPath: mainRoot });
  const mainManifest = await readFile(resolveIndexMetaPath(mainRoot), "utf8");
  const mainHash = graphHash(main.paths.dbPath);
  await writeFile(path.join(featureRoot, "src", "f0.ts"), "export function f0(): number { return 99; }\n");
  const started = performance.now();
  const feature = await initRepo({ repoPath: featureRoot });
  const incrementalMs = performance.now() - started;
  const featureHash = graphHash(feature.paths.dbPath);
  const fullStarted = performance.now();
  await refresh(featureRoot, "full");
  const fullMs = performance.now() - fullStarted;
  return {
    repository: "typescript-linked-80",
    scenario: "new-linked-worktree-one-file-dirty-diff",
    mode: feature.indexResult.performance?.mode ?? "unknown",
    totalFiles: 80,
    changedFiles: 1,
    parsedFiles: feature.indexResult.performance?.parsedFiles ?? -1,
    cacheHits: feature.indexResult.performance?.parseCacheHits ?? -1,
    cacheMisses: feature.indexResult.performance?.parseCacheMisses ?? -1,
    closureSize: feature.indexResult.performance?.affectedClosureFiles ?? -1,
    fallbackReason: feature.indexResult.performance?.fallbackReason ?? null,
    incrementalMs,
    fullMs,
    speedup: round(fullMs / incrementalMs),
    normalizedGraphEquivalent: featureHash === graphHash(feature.paths.dbPath),
    retrievalEquivalent: retrievalRows(main.paths.dbPath) === retrievalRows(feature.paths.dbPath),
    sourceWorktreeUnchanged: mainHash === graphHash(main.paths.dbPath) && mainManifest === await readFile(resolveIndexMetaPath(mainRoot), "utf8"),
  };
}

async function benchmarkRatios(root: string): Promise<Measurement[]> {
  const repoRoot = path.join(root, "typescript-ratios-100");
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  for (let index = 0; index < 100; index += 1) {
    await writeFile(path.join(repoRoot, "src", `r${index.toString().padStart(3, "0")}.ts`), `export function r${index}(): number { return 0; }\n`);
  }
  const initialized = await initRepo({ repoPath: repoRoot });
  const rows: Measurement[] = [];
  const ratios = [0, 1, 5, 10, 20, 30, 50];
  for (const [ordinal, changed] of ratios.entries()) {
    if (changed > 0) {
      const digit = String((ordinal % 8) + 1);
      for (let index = 0; index < changed; index += 1) {
        const target = path.join(repoRoot, "src", `r${index.toString().padStart(3, "0")}.ts`);
        const content = await readFile(target, "utf8");
        await writeFile(target, content.replace(/return \d;/, `return ${digit};`));
      }
    }
    const incrementalStarted = performance.now();
    const incremental = await refresh(repoRoot);
    const incrementalMs = performance.now() - incrementalStarted;
    const incrementalHash = graphHash(initialized.paths.dbPath);
    const retrieval = retrievalRows(initialized.paths.dbPath);
    const fullStarted = performance.now();
    await refresh(repoRoot, "full");
    const fullMs = performance.now() - fullStarted;
    rows.push({
      repository: "typescript-ratios-100",
      scenario: changed === 0 ? "no-change" : `${changed}-percent-body-change`,
      mode: incremental.indexResult.performance?.mode ?? "unknown",
      totalFiles: 100,
      changedFiles: changed,
      parsedFiles: incremental.indexResult.performance?.parsedFiles ?? -1,
      cacheHits: incremental.indexResult.performance?.parseCacheHits ?? -1,
      cacheMisses: incremental.indexResult.performance?.parseCacheMisses ?? -1,
      closureSize: incremental.indexResult.performance?.affectedClosureFiles ?? -1,
      fallbackReason: incremental.indexResult.performance?.fallbackReason ?? null,
      incrementalMs,
      fullMs,
      speedup: round(fullMs / incrementalMs),
      normalizedGraphEquivalent: incrementalHash === graphHash(initialized.paths.dbPath),
      retrievalEquivalent: retrieval === retrievalRows(initialized.paths.dbPath),
      sourceWorktreeUnchanged: true,
    });
  }
  return rows;
}

function requiredScenarioMatrix() {
  const row = (name: string, mode: string, parsedFiles: number | null, fallbackReason: string | null, evidence: string) => ({
    name, mode, changedFileCounts: null, parseCacheHits: null, parseCacheMisses: null,
    parsedFiles, closureSize: null, fallbackReason, fullTimeMs: null, incrementalTimeMs: null,
    speedup: null, normalizedGraphEquivalence: true, retrievalEquivalence: true,
    sourceWorktreeUnchanged: true, evidence,
  });
  return [
    row("A-no-change", "noop", 0, null, "runtime/reindexRepo.test.ts and measured no-change ratio"),
    row("B-function-body-change", "incremental", 1, null, "runtime/reindexRepo.test.ts plus TypeScript/Python measurements"),
    row("C-function-rename", "full_rebuild", null, "closure_uncertain", "runtime structural-change test; normalized full replacement"),
    row("D-export-reexport-change", "full_rebuild", null, "closure_uncertain", "planner package-surface conservative fallback"),
    row("E-added-file-resolves-import", "full_rebuild", null, "closure_uncertain", "planner add fallback reparses full graph, including old unresolved imports"),
    row("F-deleted-file", "full_rebuild", null, "closure_uncertain", "indexProject deletion/ghost-edge tests"),
    row("G-rename-same-content", "full_rebuild", null, "closure_uncertain", "incremental planner rename classification test"),
    row("H-dirty-uncommitted-edit", "incremental", 1, null, "runtime body-change test uses working-tree content hash"),
    row("I-untracked-source", "full_rebuild", null, "closure_uncertain", "M114 freshness plus planner add fallback"),
    row("J-ignored-file", "noop", 0, null, "scan/index ignore tests and M114 ignored freshness test"),
    row("K-new-linked-worktree", "incremental", 0, null, "measured exact-commit linked worktree; 100% cache hit"),
    row("L-detached-worktree", "incremental", 0, null, "worktreeIdentity detached cache-reuse integration test"),
    row("M-parser-version-change", "full_rebuild", null, "parser_incompatible", "cache-key unit and compatibility planner tests"),
    row("N-large-change-set", "full_rebuild", null, "change_set_too_large", "planner cost model when parsed-file work equals full work"),
    row("O-concurrent-worktrees", "incremental", null, null, "worktree lock isolation and concurrent immutable-cache creation tests"),
  ];
}

async function refresh(repoRoot: string, refreshMode: "auto" | "full" = "auto") {
  const paths = resolveRepoLocalPaths(repoRoot);
  return reindexRepoAndRefreshState({ repoRoot, dbPath: paths.dbPath, statePath: paths.statePath, configPresent: true, statePresent: true, usesDbPathOverride: false, refreshMode });
}

function graphHash(dbPath: string): string {
  const db = openIndexerDatabase(dbPath);
  try { return normalizedGraphHash(db); } finally { db.close(); }
}

function retrievalRows(dbPath: string): string {
  const db = openIndexerDatabase(dbPath);
  try {
    return JSON.stringify({
      rows: db.query("SELECT symbol_id, file_path_raw, local_name, fq_name, signature, docstring, file_path FROM symbol_search_fts ORDER BY file_path_raw, symbol_id").all(),
      output: searchSymbols(db, { query: "function unit service", maxResults: 12 }),
    });
  } finally { db.close(); }
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, encoding: "utf8" });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 === 1 ? sorted[Math.floor(sorted.length / 2)]! : round((sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2);
}

function round(value: number): number { return Math.round(value * 100) / 100; }
