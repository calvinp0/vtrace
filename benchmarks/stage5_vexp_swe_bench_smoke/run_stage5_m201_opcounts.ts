/**
 * M201 — the query-operation gate applied to the FROZEN A5 corpora (§31, §44).
 *
 * The unit test bounds a fixture; this reports the same counters on the three
 * corpora A5 is actually scored on, so the fixture's budget can be read against
 * real numbers instead of chosen from nothing. A whole-table scan here means a
 * result carrying every symbol the index holds.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m201_opcounts.ts [--label pre]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { openProductIndexDatabase } from "../../src/db/sqlite";
import { createMcpServer } from "../../src/mcp/server";
import { McpToolId, MCP_SERVER_SCHEMA } from "../../src/mcp/types";
import { A5_QUERIES, corpusSpecs, median } from "./m197aFixtures";
import { ensureSnapshot, materializeWorkingCopy } from "./m201Corpus";
import {
  installQueryOperationCounter, startQueryOperationRecording, stopQueryOperationRecording,
} from "./m201QueryOperationGate";

installQueryOperationCounter();

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const LABEL = argOf("--label", "pre");
const SNAPSHOT = argOf("--snapshot", "/tmp/m201-snapshot");
const WORK_ROOT = argOf("--work", `/tmp/m201-work-ops-${LABEL}`);
mkdirSync(SNAPSHOT, { recursive: true });
mkdirSync(WORK_ROOT, { recursive: true });

const call = async (server: any, toolId: string, input: unknown) => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: "m201ops", toolId, input });
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

const corpora: any[] = [];
for (const spec of corpusSpecs(REPO)) {
  ensureSnapshot(spec, SNAPSHOT);
  const work = materializeWorkingCopy(spec, SNAPSHOT, WORK_ROOT);
  if (work === null) { corpora.push({ id: spec.id, status: "CORPUS_ABSENT" }); continue; }
  const dbPath = path.join(work, ".vtrace/index.sqlite");
  const server = createMcpServer({ context: { repoRoot: work, dbPath } } as any);
  const indexed = await call(server, McpToolId.IndexRepo, { repo_root: work });
  if (indexed?.readiness?.status !== "ready") { corpora.push({ id: spec.id, status: "INDEX_NOT_READY" }); continue; }

  const db = openProductIndexDatabase(dbPath);
  const symbols = (db.query("select count(*) c from symbols").get() as { c: number }).c;
  db.close();

  const perQuery: any[] = [];
  for (const task of A5_QUERIES[spec.id] ?? []) {
    await call(server, McpToolId.GetCodeContext, { task, repo_root: work });
    startQueryOperationRecording(symbols);
    await call(server, McpToolId.GetCodeContext, { task, repo_root: work });
    const counts = stopQueryOperationRecording();
    perQuery.push({
      task,
      executions: counts.executions,
      distinctStatements: counts.distinctStatements,
      rowsReturned: counts.rowsReturned,
      wholeTableScans: counts.wholeTableScans,
      maxRepeatsOfOneStatement: counts.maxRepeatsOfOneStatement,
      mostRepeatedStatement: counts.statements[0] === undefined ? null : {
        executions: counts.statements[0].executions,
        rows: counts.statements[0].rows,
        sql: counts.statements[0].sql.replace(/\s+/g, " ").trim().slice(0, 200),
      },
    });
  }
  corpora.push({
    id: spec.id, indexedSymbols: symbols, wholeTableRowThreshold: symbols,
    medians: {
      executions: median(perQuery.map((q) => q.executions)),
      wholeTableScans: median(perQuery.map((q) => q.wholeTableScans)),
      maxRepeatsOfOneStatement: median(perQuery.map((q) => q.maxRepeatsOfOneStatement)),
      rowsReturned: median(perQuery.map((q) => q.rowsReturned)),
    },
    maxima: {
      executions: Math.max(...perQuery.map((q) => q.executions)),
      wholeTableScans: Math.max(...perQuery.map((q) => q.wholeTableScans)),
      maxRepeatsOfOneStatement: Math.max(...perQuery.map((q) => q.maxRepeatsOfOneStatement)),
    },
    perQuery,
  });
  const c = corpora.at(-1)!;
  console.log(`${spec.id.padEnd(8)} symbols ${String(symbols).padStart(6)} | per query: `
    + `scans ${c.medians.wholeTableScans} (max ${c.maxima.wholeTableScans}) | `
    + `executions ${c.medians.executions} (max ${c.maxima.executions}) | `
    + `worst statement repeat ${c.maxima.maxRepeatsOfOneStatement}`);
}

writeFileSync(path.join(RESULTS, `stage5_m201_opcounts_${LABEL}.json`), `${JSON.stringify({
  milestone: "M201", instrument: "run_stage5_m201_opcounts.ts", label: LABEL,
  definition: "a whole-table scan is one statement execution returning at least as many rows as the index holds symbols",
  corpora,
}, null, 2)}\n`);
console.log(`\nwrote results/stage5_m201_opcounts_${LABEL}.json`);
