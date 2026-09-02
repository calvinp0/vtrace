/**
 * M201 — full text of the hot A5 statements, with the query plan SQLite chooses
 * for each (§9). Separated from the profiler because a truncated statement is
 * enough to see a repetition count and never enough to fix one.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createMcpServer } from "../../src/mcp/server";
import { McpToolId, MCP_SERVER_SCHEMA } from "../../src/mcp/types";
import { A5_QUERIES, corpusSpecs } from "./m197aFixtures";
import { ensureSnapshot, materializeWorkingCopy } from "./m201Corpus";
import { installSqlProfiler, startRecording, stopRecording } from "./m201SqlProfiler";

installSqlProfiler();
const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const LABEL = argOf("--label", "pre");
const SNAPSHOT = argOf("--snapshot", "/tmp/m201-snapshot");
const CORPUS = argOf("--corpus", "C-LARGE");
const WORK_ROOT = argOf("--work", `/tmp/m201-work-${LABEL}`);
mkdirSync(SNAPSHOT, { recursive: true });
mkdirSync(WORK_ROOT, { recursive: true });

const call = async (server: any, toolId: string, input: unknown) => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: "m201h", toolId, input });
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

const spec = corpusSpecs(REPO).find((s) => s.id === CORPUS)!;
ensureSnapshot(spec, SNAPSHOT);
const work = materializeWorkingCopy(spec, SNAPSHOT, WORK_ROOT)!;
const dbPath = path.join(work, ".vtrace/index.sqlite");
const server = createMcpServer({ context: { repoRoot: work, dbPath } } as any);
await call(server, McpToolId.IndexRepo, { repo_root: work });

// Accumulate over ALL frozen queries of the corpus: a statement that is hot on
// one query and absent on the others is a query-family effect, and the ledger
// must be able to tell the two apart (§8).
const totals = new Map<string, { sql: string; executions: number; totalMs: number; rows: number; queries: Set<string> }>();
for (const task of A5_QUERIES[CORPUS] ?? []) {
  await call(server, McpToolId.GetCodeContext, { task, repo_root: work });
  startRecording();
  await call(server, McpToolId.GetCodeContext, { task, repo_root: work });
  for (const r of stopRecording()) {
    const t = totals.get(r.sql) ?? { sql: r.sql, executions: 0, totalMs: 0, rows: 0, queries: new Set<string>() };
    t.executions += r.executions; t.totalMs += r.totalMs; t.rows += r.rows;
    if (r.executions > 0) t.queries.add(task);
    totals.set(r.sql, t);
  }
}

const db = new Database(dbPath, { readonly: true });
const plansFor = (sql: string): string[] => {
  try {
    // EXPLAIN QUERY PLAN needs the same parameter arity; nulls bind fine because
    // the plan is chosen from the statement's shape, not its values.
    const n = db.prepare(sql).paramsCount;
    return (db.prepare(`explain query plan ${sql}`).all(...Array.from({ length: n }, () => null)) as any[])
      .map((r) => String(r.detail));
  } catch (error) { return [`PLAN_UNAVAILABLE: ${(error as Error).message.slice(0, 160)}`]; }
};

const ranked = [...totals.values()].sort((a, b) => b.totalMs - a.totalMs);
const out = {
  milestone: "M201", instrument: "run_stage5_m201_hotsql.ts", label: LABEL, corpus: CORPUS,
  corpusPath: work,
  indexShape: {
    files: (db.query("select count(*) c from files").get() as any).c,
    symbols: (db.query("select count(*) c from symbols").get() as any).c,
    edges: (db.query("select count(*) c from edges").get() as any).c,
  },
  queriesAggregated: (A5_QUERIES[CORPUS] ?? []).length,
  statements: ranked.slice(0, 25).map((s) => ({
    executions: s.executions, totalMs: +s.totalMs.toFixed(2), rows: s.rows,
    msPerExecution: +(s.totalMs / Math.max(1, s.executions)).toFixed(3),
    rowsPerExecution: Math.round(s.rows / Math.max(1, s.executions)),
    appearsInQueries: s.queries.size,
    plan: plansFor(s.sql),
    sql: s.sql,
  })),
};
writeFileSync(path.join(RESULTS, `stage5_m201_hotsql_${LABEL}_${CORPUS}.json`), `${JSON.stringify(out, null, 2)}\n`);
for (const s of out.statements.slice(0, 10)) {
  console.log(`${String(s.totalMs).padStart(8)}ms  x${String(s.executions).padStart(5)}  ${String(s.rowsPerExecution).padStart(6)} rows/ex  q=${s.appearsInQueries}`);
  console.log(`    plan: ${s.plan.join(" | ").slice(0, 200)}`);
  console.log(`    ${s.sql.replace(/\s+/g, " ").slice(0, 300)}`);
}
console.log(`\nwrote results/stage5_m201_hotsql_${LABEL}_${CORPUS}.json`);
