/**
 * M201 — where the repeated full-symbol scan enters the frozen A5 path.
 *
 * A stack trace says which function issued a statement; it does not say how many
 * layers above it decided to. This calls the PRODUCTION functions one layer at a
 * time against the same warm index and counts the scan at each, so the layer
 * that turns one logical retrieval into two is identified by subtraction rather
 * than by reading the call graph and hoping.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { openProductIndexDatabase } from "../../src/db/sqlite";
import { buildAuthoritativeProductRetrieval } from "../../src/capsuleV2/authoritativeProductRetrieval";
import { runReliableContextRetrieval } from "../../src/runPipeline/runPipelineOrchestrator";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { createMcpServer } from "../../src/mcp/server";
import { McpToolId, MCP_SERVER_SCHEMA } from "../../src/mcp/types";
import { A5_QUERIES, corpusSpecs } from "./m197aFixtures";
import { ensureSnapshot, materializeWorkingCopy } from "./m201Corpus";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const CORPUS = argOf("--corpus", "C-LARGE");
const SNAPSHOT = argOf("--snapshot", "/tmp/m201-snapshot");
const WORK_ROOT = argOf("--work", "/tmp/m201-work-layers");
mkdirSync(SNAPSHOT, { recursive: true });
mkdirSync(WORK_ROOT, { recursive: true });

/** The statement `listAllSymbols` issues — the whole symbol table, sorted. */
const FULL_SCAN = argOf("--statement", "ORDER BY files.path ASC, symbols.fq_name ASC, symbols.kind ASC");
const EXEC_METHODS = new Set(["all", "get", "run", "values", "iterate"]);
/**
 * `query()` is built on `prepare()`, so a statement obtained through `query()`
 * reaches BOTH patches. Wrapping it twice counts every execution twice, which
 * reads as a second retrieval pass that never happened.
 */
const wrapped = new WeakSet<object>();
let counter = 0;
let counting = false;
for (const method of ["query", "prepare"] as const) {
  const original = (Database.prototype as any)[method];
  (Database.prototype as any)[method] = function patched(this: Database, sql: string, ...rest: unknown[]) {
    const statement = original.call(this, sql, ...rest);
    if (typeof sql !== "string" || !sql.includes(FULL_SCAN)) return statement;
    if (typeof statement === "object" && statement !== null && wrapped.has(statement)) return statement;
    const proxy = new Proxy(statement, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof prop !== "string" || !EXEC_METHODS.has(prop) || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (...callArgs: unknown[]) => { if (counting) counter += 1; return value.apply(target, callArgs); };
      },
    });
    wrapped.add(proxy);
    return proxy;
  };
}
const measure = async (fn: () => unknown | Promise<unknown>): Promise<{ scans: number; ms: number }> => {
  counter = 0; counting = true;
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  counting = false;
  return { scans: counter, ms: +ms.toFixed(2) };
};

const spec = corpusSpecs(REPO).find((s) => s.id === CORPUS)!;
ensureSnapshot(spec, SNAPSHOT);
const work = materializeWorkingCopy(spec, SNAPSHOT, WORK_ROOT)!;
const dbPath = path.join(work, ".vtrace/index.sqlite");
const call = async (server: any, toolId: string, input: unknown) => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: "m201l", toolId, input });
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};
const server = createMcpServer({ context: { repoRoot: work, dbPath } } as any);
await call(server, McpToolId.IndexRepo, { repo_root: work });

const db = openProductIndexDatabase(dbPath);
const rows: any[] = [];
for (const task of A5_QUERIES[CORPUS] ?? []) {
  // Warm every layer once so none of the three measurements pays a first-call cost.
  buildAuthoritativeProductRetrieval(db, work, { query: task, preset: "explore", maxBudgetCharacters: 32_000, capsuleIntent: CapsuleIntent.Auto });
  runReliableContextRetrieval(db, work, { query: task, maxResults: 20, maxBudgetCharacters: 32_000, preset: "explore", capsuleIntent: CapsuleIntent.Auto, requireRoutedContext: true });
  await call(server, McpToolId.GetCodeContext, { task, repo_root: work });

  const authoritative = await measure(() => buildAuthoritativeProductRetrieval(db, work, {
    query: task, preset: "explore", maxBudgetCharacters: 32_000, capsuleIntent: CapsuleIntent.Auto }));
  const reliable = await measure(() => runReliableContextRetrieval(db, work, {
    query: task, maxResults: 20, maxBudgetCharacters: 32_000, preset: "explore",
    capsuleIntent: CapsuleIntent.Auto, requireRoutedContext: true }));
  const wholeRequest = await measure(() => call(server, McpToolId.GetCodeContext, { task, repo_root: work }));

  rows.push({ task, buildAuthoritativeProductRetrieval: authoritative, runReliableContextRetrieval: reliable, getCodeContextRequest: wholeRequest });
  console.log(`${task.slice(0, 44).padEnd(46)} authoritative ${authoritative.scans} | reliable ${reliable.scans} | request ${wholeRequest.scans}`);
}
db.close();

writeFileSync(path.join(RESULTS, `stage5_m201_layers_${CORPUS}.json`), `${JSON.stringify({
  milestone: "M201", instrument: "run_stage5_m201_layers.ts", corpus: CORPUS,
  statement: FULL_SCAN, corpusPath: work, rows,
}, null, 2)}\n`);
console.log(`\nwrote results/stage5_m201_layers_${CORPUS}.json`);
