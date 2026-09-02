/**
 * M201 — memory and storage tradeoff record (§13, §36, §37).
 *
 * M201 adds no schema, no index and no cache, so the honest report is a measured
 * zero rather than an omitted section: the index files are the ones the frozen
 * A5 corpora were built with, and peak RSS is the query loop's own. Both are
 * recorded so a later milestone that DOES add an index has a baseline to state
 * its increase against.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m201_storage.ts
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { execFileSync } from "node:child_process";
import { createMcpServer } from "../../src/mcp/server";
import { McpToolId, MCP_SERVER_SCHEMA } from "../../src/mcp/types";
import { A5_QUERIES, corpusSpecs } from "./m197aFixtures";
import { ensureSnapshot, materializeWorkingCopy } from "./m201Corpus";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const SNAPSHOT = argOf("--snapshot", "/tmp/m201-snapshot");
const WORK_ROOT = argOf("--work", "/tmp/m201-work-storage");

const rssKb = (): number | null => {
  try {
    const status = readFileSync(`/proc/${process.pid}/status`, "utf8");
    const line = status.split("\n").find((l) => l.startsWith("VmHWM:"));
    return line === undefined ? null : Number.parseInt(line.replace(/\D+/g, ""), 10);
  } catch { return null; }
};
const sizeOf = (file: string): number | null => { try { return statSync(file).size; } catch { return null; } };
const call = async (server: any, toolId: string, input: unknown) => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: "m201s", toolId, input });
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

const schemaChanged = execFileSync("git", ["-C", REPO, "status", "--porcelain", "--", "src/db"], { encoding: "utf8" })
  .split("\n").filter((l) => l.trim().length > 0);

const rssBefore = rssKb();
const corpora: any[] = [];
for (const spec of corpusSpecs(REPO)) {
  ensureSnapshot(spec, SNAPSHOT);
  const work = materializeWorkingCopy(spec, SNAPSHOT, WORK_ROOT);
  if (work === null) { corpora.push({ id: spec.id, status: "CORPUS_ABSENT" }); continue; }
  const dbPath = path.join(work, ".vtrace/index.sqlite");
  const server = createMcpServer({ context: { repoRoot: work, dbPath } } as any);
  const indexed = await call(server, McpToolId.IndexRepo, { repo_root: work });
  if (indexed?.readiness?.status !== "ready") { corpora.push({ id: spec.id, status: "INDEX_NOT_READY" }); continue; }
  const rssAfterIndex = rssKb();
  for (const task of A5_QUERIES[spec.id] ?? []) {
    for (let i = 0; i < 3; i += 1) await call(server, McpToolId.GetCodeContext, { task, repo_root: work });
  }
  corpora.push({
    id: spec.id,
    indexBytes: sizeOf(dbPath),
    sessionBytes: sizeOf(path.join(work, ".vtrace/session.sqlite")),
    peakRssKbAfterIndex: rssAfterIndex,
    peakRssKbAfterQueries: rssKb(),
  });
  const c = corpora.at(-1)!;
  console.log(`${spec.id.padEnd(8)} index ${String(c.indexBytes).padStart(10)} B  session ${String(c.sessionBytes).padStart(9)} B  `
    + `peak RSS after queries ${c.peakRssKbAfterQueries} kB`);
}

const out = {
  milestone: "M201", instrument: "run_stage5_m201_storage.ts",
  schemaOrIndexChangesInThisMilestone: schemaChanged,
  newCachesIntroduced: [],
  cacheBoundednessNote: "no cache was introduced; the only request-local memo on the query path "
    + "(HybridRetrievalRequestCache.broadCandidates) predates M201 and is discarded with the request",
  peakRssKbAtStart: rssBefore,
  peakRssKbAtEnd: rssKb(),
  corpora,
  dbSizeDeltaBytes: 0,
  dbSizeDeltaPercent: 0,
};
writeFileSync(path.join(RESULTS, "stage5_m201_storage.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\npeak RSS ${rssBefore} -> ${out.peakRssKbAtEnd} kB; schema/index changes: ${schemaChanged.length}`);
console.log("wrote results/stage5_m201_storage.json");
