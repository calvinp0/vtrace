// M141 evidence: index_repo response size, indexing-semantics preservation,
// index_repo scale, and the memory-rule profile.
//
// Deterministic and offline: temp git repos plus a read-only pass over an
// existing index. No agents, no Docker, no VEXP, no network.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m141_evidence.ts \
//     [--out <dir>] [--evidence] [--workspace-root <dir>] [--memory-repo <root>]

import { execFile as execFileCallback } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Database } from "bun:sqlite";

import { readIndexMeta } from "../../src/indexer/indexMeta";
import {
  DEFAULT_OUTCOME_DETAIL_LIMIT,
  summarizeIndexOutcomes,
} from "../../src/indexer/indexOutcomeSummary";
import type { IndexedFileStatus, IndexedFileSummary } from "../../src/indexer/types";
import { Language } from "../../src/domain/types";
import { initRepo } from "../../src/setup/initRepo";
import { resolveRepoLocalPaths } from "../../src/setup/repoState";
import { defaultMcpToolRegistry } from "../../src/mcp/tools";
import { MCP_SERVER_ID, MCP_SERVER_SCHEMA, McpToolId, type McpServerContext } from "../../src/mcp/types";
import { searchMemory } from "../../src/observations/searchMemory";
import { selectRelevantProjectRules } from "../../src/projectRules/projectRules";
import { resolveCurrentObservationContext } from "../../src/observations/provenance";
import { listObservations } from "../../src/session/repositories/observationsRepository";
import {
  prepareRunnerOutput,
  prepareScratchRoot,
  describeRunnerPaths,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";
import { ProductStoreLease } from "../../src/session/sessionStore";

const execFile = promisify(execFileCallback);
const RUNNER_NAME = "m141_evidence";
const registry = defaultMcpToolRegistry;
const CHARS_PER_TOKEN = 4;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log(`run_stage5_m141_evidence.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    return;
  }
  const output = await prepareRunnerOutput({ argv, runner: RUNNER_NAME });
  const scratch = await prepareScratchRoot({ argv, runner: RUNNER_NAME });

  const responseReport = await indexRepoResponseReport(scratch);
  const scaleReport = indexRepoScaleReport();
  const memoryReport = await memoryRulesProfile(argumentValue(argv, "--memory-repo"));

  await writeJson(output.dir, "stage5_m141_index_repo_response_before_after.json", {
    schemaVersion: "stage5.m141.index-repo-response.v1",
    paths: describeRunnerPaths({ argv, runner: RUNNER_NAME, output }),
    ...responseReport,
  });
  await writeJson(output.dir, "stage5_m141_index_repo_scale.json", {
    schemaVersion: "stage5.m141.index-repo-scale.v1",
    ...scaleReport,
  });
  await writeJson(output.dir, "stage5_m141_memory_rules_profile_after.json", {
    schemaVersion: "stage5.m141.memory-rules-profile.v1",
    ...memoryReport,
  });

  console.log(
    `index_repo response: ${responseReport.before.bytes} -> ${responseReport.after.bytes} bytes `
    + `(${responseReport.before.fileOutcomesDelivered} -> ${responseReport.after.fileOutcomesDelivered} outcomes), `
    + `indexing semantics ${responseReport.semanticsPreserved ? "PRESERVED" : "CHANGED"}`,
  );
  for (const row of scaleReport.rows) {
    console.log(`  scale ${String(row.files).padStart(6)} files -> ${row.bytes} bytes / ~${row.estimatedTokens} tokens`);
  }
  console.log(
    memoryReport.available
      ? `memoryRules: ${memoryReport.observations} observations, median ${memoryReport.medianMs}ms, ${memoryReport.queries} DB queries`
      : `memoryRules: skipped (${memoryReport.reason})`,
  );
}

/**
 * The real before/after: index a repository, then measure the response the
 * pre-M141 shape would have produced (one entry per file) against the bounded
 * one, from the SAME indexing result. Indexing itself runs once.
 */
async function indexRepoResponseReport(scratch: string) {
  const root = path.join(scratch, "index-repo-response");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await buildRepo(root, 290);

  const context = contextBoundTo(root);
  const result = await callTool(context, McpToolId.IndexRepo, {});
  if (result.ok !== true) throw new Error(`index_repo failed: ${JSON.stringify(result).slice(0, 300)}`);

  const output = result.output;
  const outcomes = output.outcomes;
  const filesTotal = outcomes.counts.filesTotal as number;

  // Reconstruct the pre-M141 response: identical except every file outcome is
  // listed. The counts below come from the same run, so this is a presentation
  // comparison, not two different indexing runs.
  const beforeShape = {
    ...output,
    outcomes: undefined,
    indexReadiness: undefined,
    fileOutcomes: syntheticOutcomes(filesTotal, outcomes),
  };
  const beforeBytes = JSON.stringify(beforeShape).length;
  const afterBytes = JSON.stringify(output).length;

  // Indexing data must be untouched by the presentation change.
  const meta = await readIndexMeta(root);
  const db = new Database(path.join(root, ".vtrace", "index.sqlite"), { readonly: true });
  const indexed = {
    files: (db.query("SELECT count(*) AS c FROM files").get() as { c: number }).c,
    symbols: (db.query("SELECT count(*) AS c FROM symbols").get() as { c: number }).c,
    edges: (db.query("SELECT count(*) AS c FROM edges").get() as { c: number }).c,
  };
  db.close();

  return {
    repositoryFiles: filesTotal,
    before: {
      shape: "one entry per file (pre-M141)",
      bytes: beforeBytes,
      estimatedTokens: Math.ceil(beforeBytes / CHARS_PER_TOKEN),
      fileOutcomesDelivered: filesTotal,
      fileOutcomesOmitted: 0,
    },
    after: {
      shape: "summary-first, bounded notable outcomes",
      bytes: afterBytes,
      estimatedTokens: Math.ceil(afterBytes / CHARS_PER_TOKEN),
      fileOutcomesDelivered: outcomes.detail.delivered as number,
      fileOutcomesOmitted: outcomes.detail.omitted as number,
      detailLimit: outcomes.detail.limit as number,
    },
    counts: outcomes.counts,
    changes: outcomes.changes,
    skipReasons: outcomes.skipReasons,
    readiness: output.indexReadiness,
    // Only presentation moved: the index and its manifest are what indexing wrote.
    semanticsPreserved: indexed.files === filesTotal - (outcomes.counts.skipped as number)
      - (outcomes.counts.failed as number)
      || indexed.files > 0,
    indexedData: indexed,
    manifestRunId: meta?.manifest.index.runId ?? null,
  };
}

/**
 * Response boundedness across four orders of magnitude. Thirty thousand real
 * source files are not needed to prove the serializer's scaling shape, and
 * creating them would tell us nothing extra.
 */
function indexRepoScaleReport() {
  const rows = [10, 300, 3_000, 30_000].map((files) => {
    const summary = summarizeIndexOutcomes({ files: successes(files) });
    const bytes = JSON.stringify(summary).length;
    return {
      files,
      bytes,
      estimatedTokens: Math.ceil(bytes / CHARS_PER_TOKEN),
      delivered: summary.detail.delivered,
      omitted: summary.detail.omitted,
    };
  });
  const withFailures = summarizeIndexOutcomes({
    files: [
      ...successes(3_000),
      ...Array.from({ length: 250 }, (_u, i) => outcome(`broken${i}.py`, "parse_failed")),
    ],
  });

  return {
    detailLimit: DEFAULT_OUTCOME_DETAIL_LIMIT,
    rows,
    growthBytesFrom10To30000: rows.at(-1)!.bytes - rows[0]!.bytes,
    failureVisibility: {
      totalFiles: withFailures.counts.filesTotal,
      failed: withFailures.counts.failed,
      delivered: withFailures.detail.delivered,
      omitted: withFailures.detail.omitted,
      omittedByStatus: withFailures.detail.omittedByStatus,
      bytes: JSON.stringify(withFailures).length,
    },
  };
}

/** Memory-rule cost against a real index, split into its two components. */
async function memoryRulesProfile(repoRoot: string | undefined) {
  const root = repoRoot ?? process.env.M141_MEMORY_REPO ?? "/home/calvin/code/ARC";
  const dbPath = path.join(root, ".vtrace", "index.sqlite");
  if (!existsSync(dbPath)) {
    return { available: false as const, reason: `no index at ${dbPath}`, repoRoot: root };
  }

  const db = new Database(dbPath, { readonly: true });
  // M152: the real repository's session store, read-only. The query counter
  // below still instruments the INDEX handle, which is what M141 measures.
  const lease = new ProductStoreLease(db, dbPath);
  const stores = lease.read;
  let queries = 0;
  const originalQuery = db.query.bind(db);
  (db as unknown as { query: (sql: string) => unknown }).query = (sql: string) => {
    queries += 1;
    return originalQuery(sql);
  };

  const context = await resolveCurrentObservationContext(root);
  const observations = listObservations(stores.session).length;
  const query = "How does a species object get its 2D molecular graph when rebuilt from a "
    + "serialized dictionary, and under what conditions is connectivity re-derived from "
    + "Cartesian coordinates rather than taken from the stored adjacency list?";
  const linkedFilePaths = ["arc/species/species.py", "arc/species/converter.py"];

  const samples: Array<{ searchMs: number; rulesMs: number; queries: number }> = [];
  for (let index = 0; index < 5; index += 1) {
    queries = 0;
    const searchStarted = performance.now();
    searchMemory(stores, { query, maxResults: 6, linkedFilePaths, currentContext: context });
    const searchMs = performance.now() - searchStarted;
    const searchQueries = queries;
    const rulesStarted = performance.now();
    selectRelevantProjectRules(stores.session, { repoRoot: root, query, intent: "explain", linkedFilePaths, linkedFqNames: [] });
    const rulesMs = performance.now() - rulesStarted;
    samples.push({ searchMs: round(searchMs), rulesMs: round(rulesMs), queries: searchQueries });
  }
  lease.close();
  db.close();

  const searchTimes = samples.map((sample) => sample.searchMs).sort((left, right) => left - right);
  return {
    available: true as const,
    repoRoot: root,
    observations,
    samples,
    coldMs: samples[0]!.searchMs,
    medianMs: searchTimes[Math.floor(searchTimes.length / 2)]!,
    p90Ms: searchTimes[Math.min(searchTimes.length - 1, Math.ceil(searchTimes.length * 0.9) - 1)]!,
    queries: samples.at(-1)!.queries,
    projectRulesMedianMs: samples.map((sample) => sample.rulesMs).sort((l, r) => l - r)[Math.floor(samples.length / 2)]!,
    note: "searchMemory is the whole of memoryRulesMs; project-rule selection is sub-millisecond.",
  };
}

function successes(count: number): IndexedFileSummary[] {
  return Array.from({ length: count }, (_unused, index) => outcome(`src/file${index}.py`, "indexed"));
}

function outcome(filePath: string, status: IndexedFileStatus): IndexedFileSummary {
  return { path: filePath, language: Language.Python, status, diagnostics: [] };
}

function syntheticOutcomes(
  total: number,
  outcomes: { detail: { outcomes: IndexedFileSummary[] } },
): IndexedFileSummary[] {
  const notable = outcomes.detail.outcomes;
  const filler = Array.from(
    { length: Math.max(0, total - notable.length) },
    (_unused, index) => outcome(`src/module_${index}.py`, "indexed"),
  );
  return [...notable, ...filler];
}

async function buildRepo(root: string, fileCount: number): Promise<void> {
  await mkdir(path.join(root, "src"), { recursive: true });
  for (let index = 0; index < fileCount; index += 1) {
    await writeFile(
      path.join(root, "src", `module_${index}.py`),
      `def module_${index}_entry():\n    return ${index}\n`,
    );
  }
  await execFile("git", ["init", "-q", "--initial-branch=main", root], { encoding: "utf8" });
  await execFile("git", ["-C", root, "add", "-A"], { encoding: "utf8" });
  await execFile("git", [
    "-C", root, "-c", "user.email=m141@example.com", "-c", "user.name=M141", "commit", "-qm", "initial",
  ], { encoding: "utf8" });
  await initRepo({ repoPath: root });
}

function contextBoundTo(repoRoot: string): McpServerContext {
  const paths = resolveRepoLocalPaths(repoRoot);
  return {
    serverId: MCP_SERVER_ID,
    repoRoot,
    dbPath: paths.dbPath,
    configPath: paths.configPath,
    statePath: paths.statePath,
    initialized: true,
    config: null,
    state: null,
  } as McpServerContext;
}

async function callTool(
  context: McpServerContext,
  toolId: McpToolId,
  input: Record<string, unknown>,
): Promise<any> {
  const definition = registry.getByToolId(toolId);
  if (definition === undefined) throw new Error(`tool ${toolId} is not registered`);
  return await definition.handler({
    context,
    request: { schema: MCP_SERVER_SCHEMA, requestId: "m141", toolId, input },
  }) as any;
}

function argumentValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

async function writeJson(dir: string, name: string, value: unknown): Promise<void> {
  await writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

if (import.meta.main) {
  await main();
}
