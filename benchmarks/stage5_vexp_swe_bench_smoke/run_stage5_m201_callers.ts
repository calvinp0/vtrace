/**
 * M201 — call-site attribution for the hot A5 statements (§8, §10).
 *
 * The profiler says a statement ran eight times; it cannot say who ran it. This
 * captures a stack trace at each execution of the statements named on the
 * command line and reports the distinct product call paths, with counts.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m201_callers.ts \
 *     [--corpus C-LARGE] [--match symbol_run_states]
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

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
/** Matchers are separated by `;;` so a matcher may itself contain a comma. */
const MATCHERS = argOf("--match", "symbol_run_states").split(";;");
const WORK_ROOT = argOf("--work", "/tmp/m201-work-callers");
mkdirSync(SNAPSHOT, { recursive: true });
mkdirSync(WORK_ROOT, { recursive: true });

const EXEC_METHODS = new Set(["all", "get", "run", "values", "iterate"]);
/**
 * `query()` is built on `prepare()`, so a statement obtained through `query()`
 * reaches BOTH patches. Wrapping it twice counts every execution twice, which
 * reads as a second retrieval pass that never happened.
 */
const wrapped = new WeakSet<object>();
let recording = false;
const hits = new Map<string, { matcher: string; count: number; frames: string[] }>();

/** Product frames only: node internals and this instrument say nothing useful. */
Error.stackTraceLimit = Number.parseInt(argOf("--frames", "60"), 10);
const productStack = (): string[] => {
  const raw = new Error().stack ?? "";
  return raw.split("\n").slice(1)
    .map((l) => l.trim())
    .filter((l) => l.includes("/src/") && !l.includes("m201"))
    .map((l) => l.replace(/^at\s+/, "").replace(REPO, "").replace(/:\d+\)?$/, ")"))
    .slice(0, Number.parseInt(argOf("--depth", "30"), 10));
};

for (const method of ["query", "prepare"] as const) {
  const original = (Database.prototype as any)[method];
  (Database.prototype as any)[method] = function patched(this: Database, sql: string, ...rest: unknown[]) {
    const statement = original.call(this, sql, ...rest);
    const matcher = typeof sql === "string" ? MATCHERS.find((m) => sql.includes(m)) : undefined;
    if (matcher === undefined) return statement;
    if (typeof statement === "object" && statement !== null && wrapped.has(statement)) return statement;
    const proxy = new Proxy(statement, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof prop !== "string" || !EXEC_METHODS.has(prop) || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (...callArgs: unknown[]) => {
          if (recording) {
            const frames = productStack();
            const key = `${matcher}\n${frames.join("\n")}`;
            const hit = hits.get(key) ?? { matcher, count: 0, frames };
            hit.count += 1;
            hits.set(key, hit);
          }
          return value.apply(target, callArgs);
        };
      },
    });
    wrapped.add(proxy);
    return proxy;
  };
}

const call = async (server: any, toolId: string, input: unknown) => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: "m201c", toolId, input });
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

const spec = corpusSpecs(REPO).find((s) => s.id === CORPUS)!;
ensureSnapshot(spec, SNAPSHOT);
const work = materializeWorkingCopy(spec, SNAPSHOT, WORK_ROOT)!;
const server = createMcpServer({ context: { repoRoot: work, dbPath: path.join(work, ".vtrace/index.sqlite") } } as any);
await call(server, McpToolId.IndexRepo, { repo_root: work });

const task = (A5_QUERIES[CORPUS] ?? [])[0]!;
await call(server, McpToolId.GetCodeContext, { task, repo_root: work });
recording = true;
await call(server, McpToolId.GetCodeContext, { task, repo_root: work });
recording = false;

const ranked = [...hits.values()].sort((a, b) => b.count - a.count);
const out = {
  milestone: "M201", instrument: "run_stage5_m201_callers.ts", corpus: CORPUS, task,
  matchers: MATCHERS,
  totalMatchedExecutions: ranked.reduce((n, h) => n + h.count, 0),
  distinctCallPaths: ranked.length,
  callPaths: ranked,
};
writeFileSync(path.join(RESULTS, `stage5_m201_callers_${CORPUS}.json`), `${JSON.stringify(out, null, 2)}\n`);
for (const h of ranked) {
  console.log(`\nx${h.count}  [${h.matcher}]`);
  for (const f of h.frames.slice(0, 7)) console.log(`     ${f}`);
}
console.log(`\ntotal ${out.totalMatchedExecutions} executions over ${out.distinctCallPaths} distinct call paths`);
