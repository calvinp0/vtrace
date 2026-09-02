import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, test } from "bun:test";

import { Database } from "bun:sqlite";
import { initRepo } from "../../src/setup/initRepo";
import { createMcpServer } from "../../src/mcp/server";
import { McpToolId, MCP_SERVER_SCHEMA } from "../../src/mcp/types";
import { openProductIndexDatabase } from "../../src/db/sqlite";
import {
  evaluateQueryOperationBudget,
  installQueryOperationCounter,
  startQueryOperationRecording,
  stopQueryOperationRecording,
  type QueryOperationBudget,
} from "./m201QueryOperationGate";

// M201. A5 is a latency claim, and latency is the one thing this machine could
// not hold still: the same tree measured 627 ms p90 under load and 332 ms quiet.
// These bound the WORK instead, which did not move across any of those runs.

installQueryOperationCounter();

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/**
 * Large enough that a whole-table scan is distinguishable from a per-file or
 * per-symbol lookup. On a five-symbol fixture every statement returns "every
 * symbol", and the scan bound degenerates into counting statements.
 */
const FIXTURE_MODULES = 40;

async function indexedFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "m201-opgate-"));
  roots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "queue.ts"), [
    "export interface Job { id: string; state: string }",
    "",
    "export class JobQueue {",
    "  schedule(job: Job): Job {",
    "    return { ...job, state: \"scheduled\" };",
    "  }",
    "  drain(): Job[] {",
    "    return [];",
    "  }",
    "}",
    "",
  ].join("\n"));
  await writeFile(path.join(root, "src", "scheduler.ts"), [
    "import { Job, JobQueue } from \"./queue\";",
    "",
    "export function scheduleJob(queue: JobQueue, job: Job): Job {",
    "  return queue.schedule(job);",
    "}",
    "",
    "export function describeSchedule(job: Job): string {",
    "  return `${job.id}:${job.state}`;",
    "}",
    "",
  ].join("\n"));
  // Unrelated modules, so the symbol table is bigger than any one file's share.
  for (let i = 0; i < FIXTURE_MODULES; i += 1) {
    await writeFile(path.join(root, "src", `module${i}.ts`), [
      `export interface Record${i} { id: string }`,
      "",
      `export class Store${i} {`,
      `  load(id: string): Record${i} { return { id }; }`,
      `  save(record: Record${i}): void { void record; }`,
      "}",
      "",
      `export function build${i}(id: string): Record${i} { return new Store${i}().load(id); }`,
      "",
    ].join("\n"));
  }
  await initRepo({ repoPath: root });
  return root;
}

/**
 * Deliberately generous. The gate exists to catch a lane that starts scanning
 * the table twice or looking a symbol up once per candidate, not to freeze
 * today's exact counts — a bound that fails on every ordinary retrieval change
 * gets raised until it means nothing.
 *
 * Calibrated against measured counts, not chosen: this fixture (206 symbols)
 * runs 3 scans, 181 executions and a worst statement repeat of 66, and the
 * frozen A5 corpora run 1-2 scans and 153-1042 executions per query with a
 * worst repeat of 62-625 on indexes of 98 to 10309 symbols. The bounds below sit
 * at roughly twice the fixture's own numbers, which a doubled scan or a genuine
 * per-candidate lookup loop clears immediately and an ordinary retrieval change
 * does not.
 *
 * "Whole table" is defined against the fixture rather than as a constant: a
 * result carrying every symbol the index holds is a scan whatever the repository
 * happens to be, and a literal row count would only mean something for one
 * fixture.
 */
function budgetFor(symbolCount: number): QueryOperationBudget {
  return {
    wholeTableRowThreshold: symbolCount,
    maxWholeTableScans: 6,
    maxRepeatsOfOneStatement: 120,
    maxExecutions: 400,
  };
}

function symbolCountOf(repoRoot: string): number {
  const db = openProductIndexDatabase(path.join(repoRoot, ".vtrace", "index.sqlite"));
  const count = (db.query("select count(*) c from symbols").get() as { c: number }).c;
  db.close();
  return count;
}

test("one get_code_context request stays inside its query-operation budget", async () => {
  const root = await indexedFixture();
  const budget = budgetFor(symbolCountOf(root));
  const server = createMcpServer({ context: { repoRoot: root } });
  const request = (input: unknown) => server.handleRequest({
    schema: MCP_SERVER_SCHEMA, requestId: "m201-gate", toolId: McpToolId.GetCodeContext, input,
  } as never);

  // Warm: the first request in a process pays one-time resolution the budget is
  // not about.
  await request({ task: "how is a job scheduled onto the queue", repo_root: root });

  startQueryOperationRecording(budget.wholeTableRowThreshold);
  const response = await request({ task: "how is a job scheduled onto the queue", repo_root: root }) as {
    result: { ok: boolean };
  };
  const verdict = evaluateQueryOperationBudget(stopQueryOperationRecording(), budget);

  assert.equal(response.result.ok, true);
  assert.deepEqual(verdict.violations, []);
  assert.equal(verdict.ok, true);
  // A gate that recorded nothing would also report no violations.
  assert.ok(verdict.counts.executions > 0, "counter recorded no statement executions");
});

// --- F8: the gate is capable of failing -------------------------------------

test("a synthetic per-symbol lookup loop breaks the same budget", async () => {
  const root = await indexedFixture();
  const budget = budgetFor(symbolCountOf(root));
  const db = openProductIndexDatabase(path.join(root, ".vtrace", "index.sqlite"));
  const ids = (db.query("select id from symbols").all() as { id: string }[]).map((r) => r.id);
  assert.ok(ids.length > 0, "fixture produced no symbols");

  startQueryOperationRecording(budget.wholeTableRowThreshold);
  // The shape the profiling looked for: one statement, once per candidate. Run
  // against a budget whose repeat bound is the fixture's own symbol count, so
  // the control does not depend on the fixture being large.
  for (let round = 0; round < 3; round += 1) {
    for (const id of ids) db.query("select fq_name from symbols where id = ?").get(id);
  }
  const counts = stopQueryOperationRecording();
  db.close();

  const tight = { ...budget, maxRepeatsOfOneStatement: ids.length, maxExecutions: ids.length };
  const verdict = evaluateQueryOperationBudget(counts, tight);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.violations.some((v) => v.startsWith("statement_repeats")), verdict.violations.join("; "));
  assert.ok(verdict.violations.some((v) => v.startsWith("executions")), verdict.violations.join("; "));
});

test("a synthetic repeated whole-table scan breaks the scan bound", async () => {
  const root = await indexedFixture();
  const budget = budgetFor(symbolCountOf(root));
  const db = openProductIndexDatabase(path.join(root, ".vtrace", "index.sqlite"));

  startQueryOperationRecording(budget.wholeTableRowThreshold);
  for (let i = 0; i < budget.maxWholeTableScans + 2; i += 1) {
    db.query("select id, fq_name from symbols").all();
  }
  const verdict = evaluateQueryOperationBudget(stopQueryOperationRecording(), budget);
  db.close();

  assert.equal(verdict.ok, false);
  assert.ok(verdict.violations.some((v) => v.startsWith("whole_table_scans")), verdict.violations.join("; "));
});

// --- the control for the instrument itself ----------------------------------

test("the counter counts each execution once, whether prepared via query or prepare", () => {
  const db = new Database(":memory:");
  db.run("create table t(a integer)");
  db.run("insert into t values (1)");

  startQueryOperationRecording(Number.POSITIVE_INFINITY);
  db.query("select a from t").all();
  db.prepare("select a from t where a = ?").all(1);
  const counts = stopQueryOperationRecording();
  db.close();

  // `query()` is built on `prepare()`. An instrument that wraps both without
  // guarding reports 4 here, and a single retrieval pass then reads as two —
  // which is exactly how M201's first bottleneck hypothesis was manufactured.
  assert.equal(counts.executions, 2);
  assert.equal(counts.distinctStatements, 2);
  for (const statement of counts.statements) assert.equal(statement.executions, 1);
});
