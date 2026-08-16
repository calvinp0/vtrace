/**
 * M151 — authorized rebuild of the two authoritative indexes, as validation setup.
 *
 * WHY THIS EXISTS
 * ----------------
 * ARC and TCKDB_v2 were both `possibly_stale / schema_changed`, so
 * `assembleProductContext` failed closed and delivered zero items for every real
 * query. The same failure reproduces at the M150 baseline tree, so it is a
 * property of the stored indexes rather than anything M151 changed.
 *
 * §116 forbids touching an authoritative index unless the user explicitly asks.
 * The user did, scoped to this setup step, on the conditions recorded here:
 * capture identity and readiness first, rebuild only through the supported
 * `index_repo` write path, verify binding afterwards, and treat every later M151
 * measurement as read-only against the rebuilt state.
 *
 * The rebuilt hashes recorded here are the baseline every subsequent M151 run is
 * checked against. Stale->fresh differences are NOT attributable to M151, and
 * preservation comparisons must run both functional sides against this same state.
 */
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { resolveIndexDbPath } from "../../src/indexer/indexMeta";
import { resolveRepoLocalPaths } from "../../src/setup/repoState";
import { defaultMcpToolRegistry } from "../../src/mcp/tools";
import { MCP_SERVER_ID, MCP_SERVER_SCHEMA, McpToolId } from "../../src/mcp/types";
import type { McpServerContext } from "../../src/mcp/types";

const execFile = promisify(execFileCallback);
const RESULTS = path.join(import.meta.dir, "results");
const TARGETS = ["/home/calvin/code/ARC", "/home/calvin/code/TCKDB_v2"] as const;

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
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

async function callTool(repoRoot: string, toolId: McpToolId, input: Record<string, unknown>): Promise<any> {
  const registry = defaultMcpToolRegistry;
  return (await registry.getByToolId(toolId)!.handler({
    context: contextBoundTo(repoRoot),
    request: { schema: MCP_SERVER_SCHEMA, requestId: "m151-rebuild", toolId, input },
  })) as any;
}

async function observe(repoRoot: string): Promise<Record<string, unknown>> {
  const dbPath = resolveIndexDbPath(repoRoot);
  const stats = await stat(dbPath);
  const status = await callTool(repoRoot, McpToolId.IndexStatus, {});
  const head = (await execFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }))
    .stdout.trim();

  return {
    repoRoot,
    sourceHead: head,
    dbPath,
    sha256: await sha256(dbPath),
    bytes: stats.size,
    mtime: stats.mtime.toISOString(),
    readinessStatus: status.output?.readiness?.status ?? null,
    freshnessState: status.output?.freshness?.state ?? null,
    freshnessSummary: status.output?.freshness?.summary ?? null,
    indexedFiles: status.output?.indexedFileCount ?? null,
    latestRunId: status.output?.latestRunId ?? null,
    boundRepoRoot: status.output?.repoRoot ?? null,
  };
}

const before: Record<string, unknown>[] = [];
const after: Record<string, unknown>[] = [];

for (const target of TARGETS) {
  console.log(`[m151-rebuild] observing ${target}`);
  before.push(await observe(target));
}

for (const target of TARGETS) {
  console.log(`[m151-rebuild] rebuilding ${target} via index_repo`);
  const started = performance.now();
  const result = await callTool(target, McpToolId.IndexRepo, { repo_root: target });
  console.log(
    `[m151-rebuild]   ok=${result.ok} in ${((performance.now() - started) / 1000).toFixed(1)}s`
    + (result.ok ? "" : ` error=${result.error?.message}`),
  );
}

for (const target of TARGETS) {
  after.push(await observe(target));
}

const rows = TARGETS.map((target, index) => ({
  repoRoot: target,
  before: before[index],
  after: after[index],
  becameReady:
    (after[index] as any).readinessStatus === "ready"
    && (after[index] as any).freshnessState !== "possibly_stale",
  boundCorrectly: (after[index] as any).boundRepoRoot === target,
  sourceHeadUnchanged: (before[index] as any).sourceHead === (after[index] as any).sourceHead,
}));

await writeFile(
  path.join(RESULTS, "stage5_m151_index_rebuild_provenance.json"),
  `${JSON.stringify({
    milestone: "M151",
    generatedAt: new Date().toISOString(),
    authorization:
      "User-authorized under §116 as M151 validation setup only. Both indexes were "
      + "already possibly_stale/schema_changed and the same failure reproduces at the "
      + "M150 baseline tree, so stale->fresh differences are NOT attributable to M151. "
      + "Every later M151 measurement is read-only against the `after` hashes below, "
      + "and preservation comparisons run both functional sides against this state.",
    writePath: "MCP index_repo",
    repositories: rows,
  }, null, 2)}\n`,
);

for (const row of rows) {
  console.log(
    `[m151-rebuild] ${row.repoRoot}: ready=${row.becameReady} bound=${row.boundCorrectly} `
    + `head=${(row.after as any).sourceHead.slice(0, 8)} files=${(row.after as any).indexedFiles}`,
  );
  console.log(`               before ${(row.before as any).sha256.slice(0, 16)} -> after ${(row.after as any).sha256.slice(0, 16)}`);
}
