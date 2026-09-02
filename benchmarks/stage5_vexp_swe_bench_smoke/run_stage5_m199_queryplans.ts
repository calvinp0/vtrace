/**
 * M199 — query plans and per-statement cost for the statements a bounded
 * incremental refresh runs (§14).
 *
 * Plans are taken from a REAL C-LARGE index, not a synthetic one: SQLite picks a
 * plan from the schema, but whether a scan matters is a fact about how many rows
 * are in the table, and a fixture with ten symbols would report every statement
 * as cheap.
 *
 * Each statement is also timed in isolation against that index, because a plan
 * that says SCAN is only a defect if the scan is paid for. The two are reported
 * side by side so an index is only ever added where both agree.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m199_queryplans.ts \
 *     [--corpus C-LARGE] [--scratch <dir>] [--out <name>]
 */
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { indexProject } from "../../src/indexer/indexProject";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { SKIP_DIRS, corpusSpecs, prepareCorpus } from "./m197aFixtures";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const CORPUS = argOf("--corpus", "C-LARGE");
const SCRATCH = argOf("--scratch", path.join(process.env.TMPDIR ?? "/tmp", "m199qp"));
const OUT = argOf("--out", "stage5_m199_query_plans.json");
mkdirSync(SCRATCH, { recursive: true });

const spec = corpusSpecs(REPO).find((s) => s.id === CORPUS);
if (spec === undefined) throw new Error(`M199_UNKNOWN_CORPUS: ${CORPUS}`);
const prepared = prepareCorpus(spec, SCRATCH);
if (prepared === null) throw new Error(`M199_CORPUS_ABSENT: ${CORPUS}`);

const work = path.join(SCRATCH, `qp-${spec.id}`);
rmSync(work, { recursive: true, force: true });
cpSync(prepared, work, { recursive: true, dereference: false,
  filter: (s) => !SKIP_DIRS.has(path.basename(s)) });
mkdirSync(path.join(work, ".vtrace"), { recursive: true });
const db: Database = openIndexerDatabase(path.join(work, ".vtrace", "index.sqlite"));
await indexProject({ repoRoot: work, db, parserVersion: "builtin-parser-v1" });

const liveRows = (table: string) =>
  (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

const tableSizes = Object.fromEntries(
  ["files", "symbols", "edges", "edge_call_sites", "symbol_mechanism_facts", "document_chunks",
   "symbol_search_fts", "symbol_body_literals_fts", "document_search_fts"]
    .map((t) => [t, liveRows(t)]));

/** The file the plans are taken against: the one A3's k=1 probe modifies. */
const targetPath = (db.query(
  `SELECT path FROM files WHERE path LIKE '%.py' ORDER BY path LIMIT 1`,
).get() as { path: string }).path;
const targetId = (db.query("SELECT id FROM files WHERE path = ?").get(targetPath) as { id: string }).id;

const symbolIds = `SELECT id FROM symbols WHERE file_id = ?`;

/** Every statement the bounded invalidation path runs, with its real bindings. */
const STATEMENTS: { readonly id: string; readonly sql: string; readonly params: readonly unknown[] }[] = [
  { id: "lookup_file_id", sql: "SELECT id FROM files WHERE path = ?", params: [targetPath] },
  { id: "delete_call_sites_touching_file", params: [targetId, targetId],
    sql: `DELETE FROM edge_call_sites WHERE edge_id IN (
      SELECT id FROM edges WHERE src_symbol_id IN (${symbolIds}) OR dst_symbol_id IN (${symbolIds}))` },
  { id: "delete_edges_touching_file", params: [targetId, targetId],
    sql: `DELETE FROM edges WHERE src_symbol_id IN (${symbolIds}) OR dst_symbol_id IN (${symbolIds})` },
  { id: "delete_document_search_for_file", params: [targetId],
    sql: "DELETE FROM document_search_fts WHERE file_id = ?" },
  { id: "delete_document_chunks_for_file", params: [targetId],
    sql: "DELETE FROM document_chunks WHERE file_id = ?" },
  { id: "delete_mechanism_facts_for_file", params: [targetPath],
    sql: "DELETE FROM symbol_mechanism_facts WHERE file_path_raw = ?" },
  { id: "delete_body_literals_for_file", params: [targetPath],
    sql: "DELETE FROM symbol_body_literals_fts WHERE file_path_raw = ?" },
  { id: "delete_symbol_search_for_file", params: [targetPath],
    sql: "DELETE FROM symbol_search_fts WHERE file_path_raw = ?" },
  { id: "delete_symbols_for_file", params: [targetId],
    sql: "DELETE FROM symbols WHERE file_id = ?" },
  { id: "delete_file_by_path", params: [targetPath],
    sql: "DELETE FROM files WHERE path = ?" },
  { id: "validate_dangling_edges", params: [],
    sql: `SELECT COUNT(*) AS count FROM edges
      LEFT JOIN symbols src ON src.id = edges.src_symbol_id
      LEFT JOIN symbols dst ON dst.id = edges.dst_symbol_id
      WHERE src.id IS NULL OR dst.id IS NULL` },
  { id: "validate_dangling_search", params: [],
    sql: `SELECT COUNT(*) AS count FROM symbol_search_fts
      LEFT JOIN symbols ON symbols.id = symbol_search_fts.symbol_id
      WHERE symbols.id IS NULL` },
];

/**
 * Classify a plan by what SQLite says it does to each table. `SEARCH ... USING
 * INDEX` is a bounded lookup; a bare `SCAN` is proportional to the table.
 */
function classify(rows: { detail: string }[]): string {
  const details = rows.map((r) => r.detail);
  if (details.some((d) => /^SCAN\b/.test(d) && !/USING (COVERING )?INDEX/.test(d))) return "full_scan";
  if (details.every((d) => /SEARCH|USING (COVERING )?INDEX|CORRELATED|LIST SUBQUERY|VIRTUAL TABLE INDEX/.test(d)
    || /^(CO-ROUTINE|MATERIALIZE|SCALAR SUBQUERY)/.test(d))) return "indexed";
  return "mixed";
}

const statements = STATEMENTS.map((statement) => {
  const plan = db.query(`EXPLAIN QUERY PLAN ${statement.sql}`)
    .all(...(statement.params as any[])) as { detail: string }[];
  return { id: statement.id, sql: statement.sql.replace(/\s+/g, " ").trim(),
    plan: plan.map((row) => row.detail), classification: classify(plan) };
});

/**
 * Per-statement cost, taken inside a transaction that is rolled back so each
 * statement is timed against the SAME graph. Timing them in sequence would time
 * the second against a table the first had already emptied.
 */
const timings = STATEMENTS.map((statement) => {
  db.run("BEGIN");
  const t0 = performance.now();
  db.run(statement.sql, statement.params as any[]);
  const ms = performance.now() - t0;
  db.run("ROLLBACK");
  return { id: statement.id, ms: +ms.toFixed(2) };
});

db.close();
rmSync(work, { recursive: true, force: true });

const byId = new Map(timings.map((t) => [t.id, t.ms]));
const out = {
  milestone: "M199",
  instrument: "run_stage5_m199_queryplans.ts",
  corpus: spec.id,
  targetPath,
  tableSizes,
  statements: statements.map((s) => ({ ...s, isolatedMs: byId.get(s.id) ?? null })),
};
writeFileSync(path.join(RESULTS, OUT), `${JSON.stringify(out, null, 2)}\n`);
for (const s of out.statements) {
  console.log(`${s.classification.padEnd(10)} ${String(s.isolatedMs).padStart(8)} ms  ${s.id}`);
}
console.log(`\nwrote results/${OUT}`);
