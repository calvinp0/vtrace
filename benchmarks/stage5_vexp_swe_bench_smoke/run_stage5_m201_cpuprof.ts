/**
 * M201 — CPU sample profile of the frozen A5 path.
 *
 * The SQL profiler accounts for the statement time; this accounts for the rest.
 * Run under `bun --cpu-prof`, which writes the profile on exit:
 *
 *   bun --cpu-prof --cpu-prof-dir <dir> --cpu-prof-interval 200 \
 *     benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m201_cpuprof.ts [--corpus C-LARGE] [--repeats 8]
 *
 * Only the timed region runs repeatedly: indexing and warm-up happen once, so
 * their samples do not swamp the query path the profile exists to explain.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { createMcpServer } from "../../src/mcp/server";
import { McpToolId, MCP_SERVER_SCHEMA } from "../../src/mcp/types";
import { A5_QUERIES, corpusSpecs } from "./m197aFixtures";
import { ensureSnapshot, materializeWorkingCopy } from "./m201Corpus";

const REPO = path.resolve(import.meta.dir, "../..");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const CORPUS = argOf("--corpus", "C-LARGE");
const REPEATS = Number.parseInt(argOf("--repeats", "8"), 10);
const SNAPSHOT = argOf("--snapshot", "/tmp/m201-snapshot");
const WORK_ROOT = argOf("--work", "/tmp/m201-work-cpuprof");
mkdirSync(SNAPSHOT, { recursive: true });
mkdirSync(WORK_ROOT, { recursive: true });

const spec = corpusSpecs(REPO).find((s) => s.id === CORPUS)!;
ensureSnapshot(spec, SNAPSHOT);
const work = materializeWorkingCopy(spec, SNAPSHOT, WORK_ROOT)!;
const server = createMcpServer({ context: { repoRoot: work, dbPath: path.join(work, ".vtrace/index.sqlite") } } as any);
const call = async (toolId: string, input: unknown) => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: "m201cpu", toolId, input });
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};
await call(McpToolId.IndexRepo, { repo_root: work });
const queries = A5_QUERIES[CORPUS] ?? [];
for (const task of queries) await call(McpToolId.GetCodeContext, { task, repo_root: work });

const t0 = performance.now();
for (let i = 0; i < REPEATS; i += 1) {
  for (const task of queries) await call(McpToolId.GetCodeContext, { task, repo_root: work });
}
console.log(`profiled ${REPEATS * queries.length} calls in ${(performance.now() - t0).toFixed(0)}ms`);
