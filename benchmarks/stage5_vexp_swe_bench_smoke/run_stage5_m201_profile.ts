/**
 * M201 — per-query stage attribution for the frozen A5 path (§7, §8, §10).
 *
 * Three instruments over the SAME production call, so their totals can be
 * reconciled against one wall clock rather than compared across runs:
 *
 *   1. end-to-end wall time around `server.handleRequest`, the frozen A5 metric;
 *   2. the product's OWN stage clock (`productContext.timing`), read through
 *      `detail: "debug"` — the only surface that publishes it — so the split is
 *      the product's measurement of itself, not the benchmark's guess;
 *   3. every SQLite statement the production code prepared, counted and timed
 *      per statement text, which is where an N+1 becomes legible (§10).
 *
 * The debug call is a SECOND call, not the timed one: reading the clock must not
 * be inside the thing being clocked. Its stage split is therefore attributed to
 * an equivalent warm call, and the reconciliation column says how far the two
 * wall times drifted.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m201_profile.ts \
 *     [--label pre] [--scratch /tmp/m201-frozen] [--repeats 3]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createMcpServer } from "../../src/mcp/server";
import { McpToolId, MCP_SERVER_SCHEMA } from "../../src/mcp/types";
import { A5_QUERIES, corpusSpecs, latencyStats, median } from "./m197aFixtures";
import { ensureSnapshot, materializeWorkingCopy } from "./m201Corpus";
import { installSqlProfiler, startRecording, stopRecording, summarize } from "./m201SqlProfiler";

installSqlProfiler();

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const LABEL = argOf("--label", "pre");
const REPEATS = Number.parseInt(argOf("--repeats", "3"), 10);
const SNAPSHOT = argOf("--snapshot", "/tmp/m201-snapshot");
const WORK_ROOT = argOf("--work", `/tmp/m201-work-${LABEL}`);
mkdirSync(SNAPSHOT, { recursive: true });
mkdirSync(WORK_ROOT, { recursive: true });

const loadAverage = () => {
  try { return readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number); }
  catch { return []; }
};

type Server = ReturnType<typeof createMcpServer>;
const call = async (server: Server, toolId: string, input: unknown): Promise<any> => {
  const res: any = await server.handleRequest(
    { schema: MCP_SERVER_SCHEMA, requestId: "m201p", toolId, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

const perCorpus: any[] = [];
for (const spec of corpusSpecs(REPO)) {
  ensureSnapshot(spec, SNAPSHOT);
  const work = materializeWorkingCopy(spec, SNAPSHOT, WORK_ROOT);
  if (work === null) { perCorpus.push({ id: spec.id, status: "CORPUS_ABSENT" }); continue; }
  const dbPath = path.join(work, ".vtrace/index.sqlite");
  const server = createMcpServer({ context: { repoRoot: work, dbPath } } as any);
  const indexed = await call(server, McpToolId.IndexRepo, { repo_root: work });
  if (indexed?.readiness?.status !== "ready") {
    perCorpus.push({ id: spec.id, status: "INDEX_NOT_READY" }); continue;
  }

  const perQuery: any[] = [];
  for (const task of A5_QUERIES[spec.id] ?? []) {
    await call(server, McpToolId.GetCodeContext, { task, repo_root: work });

    // (1) the frozen metric, uninstrumented apart from the wall clock.
    const wall: number[] = [];
    for (let i = 0; i < REPEATS; i += 1) {
      const t0 = performance.now();
      await call(server, McpToolId.GetCodeContext, { task, repo_root: work });
      wall.push(performance.now() - t0);
    }

    // (2) the product's own stage clock.
    const debugT0 = performance.now();
    const debug = await call(server, McpToolId.GetCodeContext, { task, repo_root: work, detail: "debug" });
    const debugWall = performance.now() - debugT0;
    const timing = debug?.productContext?.timing ?? null;

    // (3) SQL, over one equivalent DEFAULT call.
    startRecording();
    const sqlT0 = performance.now();
    await call(server, McpToolId.GetCodeContext, { task, repo_root: work });
    const sqlWall = performance.now() - sqlT0;
    const statements = stopRecording();
    const sql = summarize(statements);

    const accounted = timing === null ? null : +(
      timing.freshnessMs + timing.retrievalMs + timing.capsuleBuildMs
      + timing.impactMs + timing.memoryRulesMs + timing.renderMs).toFixed(2);

    perQuery.push({
      task,
      wall: latencyStats(wall),
      productStageClock: timing,
      /** §7: stage totals must reconcile with end-to-end within a stated tolerance. */
      reconciliation: timing === null ? null : {
        stagesSumMs: accounted,
        productTotalMs: +timing.totalMs.toFixed(2),
        unattributedInsideProductMs: +(timing.totalMs - (accounted ?? 0)).toFixed(2),
        debugCallWallMs: +debugWall.toFixed(2),
        outsideProductClockMs: +(debugWall - timing.totalMs).toFixed(2),
        defaultCallMedianMs: +median(wall).toFixed(2),
        debugVsDefaultDeltaMs: +(debugWall - median(wall)).toFixed(2),
      },
      sql: {
        ...sql,
        instrumentedCallWallMs: +sqlWall.toFixed(2),
        sqlSharePercent: +(100 * sql.totalSqlMs / sqlWall).toFixed(2),
        topByTime: statements.slice(0, 12).map((s) => ({
          executions: s.executions, totalMs: +s.totalMs.toFixed(2), rows: s.rows,
          msPerExecution: +(s.totalMs / s.executions).toFixed(3),
          sql: s.sql.replace(/\s+/g, " ").trim().slice(0, 220),
        })),
        topByExecutions: [...statements].sort((a, b) => b.executions - a.executions).slice(0, 12)
          .map((s) => ({
            executions: s.executions, totalMs: +s.totalMs.toFixed(2), rows: s.rows,
            msPerExecution: +(s.totalMs / s.executions).toFixed(3),
            sql: s.sql.replace(/\s+/g, " ").trim().slice(0, 220),
          })),
      },
    });
    const q = perQuery.at(-1)!;
    console.log(`${spec.id} ${task.slice(0, 44).padEnd(46)} wall ${String(q.wall.median).padStart(7)}ms `
      + `sql ${String(q.sql.totalSqlMs).padStart(7)}ms (${q.sql.sqlSharePercent}%) `
      + `${String(q.sql.executions).padStart(5)} execs / ${q.sql.distinctStatements} stmts`);
  }

  perCorpus.push({
    id: spec.id, corpusPath: work, queries: perQuery.length, repeats: REPEATS,
    aggregate: {
      wallMedian: +median(perQuery.map((q) => q.wall.median)).toFixed(2),
      sqlMsMedian: +median(perQuery.map((q) => q.sql.totalSqlMs)).toFixed(2),
      sqlSharePercentMedian: +median(perQuery.map((q) => q.sql.sqlSharePercent)).toFixed(2),
      sqlExecutionsMedian: median(perQuery.map((q) => q.sql.executions)),
      distinctStatementsMedian: median(perQuery.map((q) => q.sql.distinctStatements)),
      stageMedians: ["freshnessMs", "retrievalMs", "capsuleBuildMs", "impactMs", "memoryRulesMs", "renderMs", "totalMs"]
        .reduce((acc: Record<string, number>, k) => {
          acc[k] = +median(perQuery.map((q) => q.productStageClock?.[k] ?? Number.NaN)).toFixed(2);
          return acc;
        }, {}),
    },
    perQuery,
  });
}

const out = {
  milestone: "M201", instrument: "run_stage5_m201_profile.ts", label: LABEL,
  repeats: REPEATS, snapshot: SNAPSHOT, workRoot: WORK_ROOT,
  hardware: { cpus: navigator.hardwareConcurrency, loadAverage: loadAverage() },
  corpora: perCorpus,
};
writeFileSync(path.join(RESULTS, `stage5_m201_profile_${LABEL}.json`), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nwrote results/stage5_m201_profile_${LABEL}.json`);
