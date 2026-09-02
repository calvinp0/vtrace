/**
 * M200 — query plans, per-statement cost, and storage impact for the binding
 * authority (§24, §40).
 *
 * The reverse-consumer lookup runs once per module the closure walk visits, so a
 * scan of every import descriptor per visit would turn a bounded closure into a
 * repository-scale one by another route. Plans are taken from a REAL C-LARGE
 * index for the reason M199 gave: SQLite picks a plan from the schema, but
 * whether a scan matters is a fact about how many rows the table holds.
 *
 * Storage is measured the only way that answers the question honestly — two
 * cold builds of the same corpus, one with the binding tables populated and one
 * with them emptied and VACUUMed, so the delta is the authority's own bytes and
 * not a difference between two corpora.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m200_queryplans.ts \
 *     [--corpora C-MED,C-LARGE] [--scratch <dir>] [--out <name>]
 */
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { indexProject } from "../../src/indexer/indexProject";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { SKIP_DIRS, corpusSpecs, prepareCorpus, median } from "./m197aFixtures";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const ONLY = argOf("--corpora", "C-MED,C-LARGE").split(",").map((s) => s.trim());
const SCRATCH = argOf("--scratch", path.join(process.env.TMPDIR ?? "/tmp", "m200qp"));
const OUT = argOf("--out", "stage5_m200_query_plans.json");
const REPEATS = Number.parseInt(argOf("--repeats", "3"), 10);
mkdirSync(SCRATCH, { recursive: true });

/** As M199's classifier: a bare SCAN is proportional to the table. */
function classify(rows: { detail: string }[]): string {
  const details = rows.map((r) => r.detail);
  if (details.some((d) => /^SCAN\b/.test(d) && !/USING (COVERING )?INDEX/.test(d))) return "full_scan";
  if (details.every((d) => /SEARCH|USING (COVERING )?INDEX|CORRELATED|LIST SUBQUERY|VIRTUAL TABLE INDEX/.test(d)
    || /^(CO-ROUTINE|MATERIALIZE|SCALAR SUBQUERY)/.test(d))) return "indexed";
  return "mixed";
}

const corpora: unknown[] = [];

for (const spec of corpusSpecs(REPO).filter((s) => ONLY.includes(s.id))) {
  const prepared = prepareCorpus(spec, SCRATCH);
  if (prepared === null) { corpora.push({ id: spec.id, status: "SOURCE_ABSENT" }); continue; }

  const work = path.join(SCRATCH, `qp-${spec.id}`);
  rmSync(work, { recursive: true, force: true });
  cpSync(prepared, work, { recursive: true, dereference: false,
    filter: (s) => !SKIP_DIRS.has(path.basename(s)) });
  mkdirSync(path.join(work, ".vtrace"), { recursive: true });

  const coldMs: number[] = [];
  let indexBytes = 0;
  for (let i = 0; i < REPEATS; i += 1) {
    rmSync(path.join(work, ".vtrace"), { recursive: true, force: true });
    mkdirSync(path.join(work, ".vtrace"), { recursive: true });
    const db = openIndexerDatabase(path.join(work, ".vtrace", "index.sqlite"));
    const t0 = performance.now();
    await indexProject({ repoRoot: work, db, parserVersion: "builtin-parser-v1" });
    coldMs.push(performance.now() - t0);
    db.close();
    indexBytes = statSync(path.join(work, ".vtrace/index.sqlite")).size;
  }

  const db: Database = openIndexerDatabase(path.join(work, ".vtrace", "index.sqlite"));
  const rows = (table: string) =>
    (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

  // A target that actually HAS consumers, chosen from the data so the plan is
  // taken against a lookup that returns something.
  const busiest = db.query(`
    SELECT resolved_target_path AS target, COUNT(*) AS consumers FROM import_descriptors
     WHERE resolved_target_path IS NOT NULL
     GROUP BY resolved_target_path ORDER BY consumers DESC, target LIMIT 1`).get() as
    { target: string; consumers: number } | null;
  const target = busiest?.target ?? "";
  const someFile = (db.query("SELECT file_path FROM module_bindings LIMIT 1").get() as
    { file_path: string } | null)?.file_path ?? "";

  const STATEMENTS = [
    { id: "reverse_importers_of_target", params: [target],
      sql: `SELECT file_path FROM import_descriptors
             WHERE resolved_target_path = ? AND resolution_status <> 'wildcard'` },
    { id: "reverse_wildcard_importers_of_target", params: [target],
      sql: `SELECT file_path FROM import_descriptors
             WHERE resolved_target_path = ? AND resolution_status = 'wildcard'` },
    { id: "re_exports_through", params: [someFile, target],
      sql: `SELECT 1 AS hit FROM module_bindings
             WHERE file_path = ? AND target_path = ?
               AND binding_kind IN ('re_export', 'module_alias') LIMIT 1` },
    { id: "read_persisted_surfaces", params: [],
      sql: `SELECT file_path, is_package_surface, unbounded_names, surface_digest
              FROM module_binding_surfaces` },
    { id: "delete_descriptors_for_file", params: [someFile],
      sql: "DELETE FROM import_descriptors WHERE file_path = ?" },
    { id: "delete_bindings_for_file", params: [someFile],
      sql: "DELETE FROM module_bindings WHERE file_path = ?" },
    { id: "delete_surface_for_file", params: [someFile],
      sql: "DELETE FROM module_binding_surfaces WHERE file_path = ?" },
  ];

  const statements = STATEMENTS.map((statement) => {
    const plan = db.query(`EXPLAIN QUERY PLAN ${statement.sql}`)
      .all(...(statement.params as any[])) as { detail: string }[];
    db.run("BEGIN");
    const t0 = performance.now();
    db.run(statement.sql, statement.params as any[]);
    const ms = performance.now() - t0;
    db.run("ROLLBACK");
    return {
      id: statement.id, sql: statement.sql.replace(/\s+/g, " ").trim(),
      plan: plan.map((row) => row.detail), classification: classify(plan),
      ms: +ms.toFixed(3),
    };
  });

  const bindingRowCounts = {
    module_binding_surfaces: rows("module_binding_surfaces"),
    module_bindings: rows("module_bindings"),
    import_descriptors: rows("import_descriptors"),
  };

  // Storage: empty the three tables in a COPY and VACUUM, so the delta is the
  // authority's bytes measured against the same graph rather than another one.
  // Both sides are VACUUMed, because a VACUUM alone reclaims free pages and a
  // one-sided comparison would bill that reclamation to the binding tables. On a
  // corpus with no binding rows at all the two must agree exactly, which is the
  // check that the measurement is measuring what it says.
  db.close();
  const measure = (tag: string, strip: boolean): number => {
    const copyPath = path.join(SCRATCH, `${tag}-${spec.id}.sqlite`);
    rmSync(copyPath, { force: true });
    cpSync(path.join(work, ".vtrace/index.sqlite"), copyPath);
    const copy = new Database(copyPath);
    if (strip) {
      copy.run("DELETE FROM import_descriptors");
      copy.run("DELETE FROM module_bindings");
      copy.run("DELETE FROM module_binding_surfaces");
    }
    copy.run("VACUUM");
    copy.close();
    const bytes = statSync(copyPath).size;
    rmSync(copyPath, { force: true });
    return bytes;
  };
  const vacuumedBytes = measure("vacuumed", false);
  const strippedBytes = measure("stripped", true);
  rmSync(work, { recursive: true, force: true });

  const entry = {
    id: spec.id, language: spec.language,
    coldBuildMedianMs: +median(coldMs).toFixed(1), repeats: REPEATS,
    indexBytes, bindingRowCounts,
    busiestTarget: busiest,
    storage: {
      onDiskBytes: indexBytes,
      vacuumedBytes, strippedAndVacuumedBytes: strippedBytes,
      bindingBytes: vacuumedBytes - strippedBytes,
      bindingSharePercent: +(100 * (vacuumedBytes - strippedBytes) / vacuumedBytes).toFixed(2),
    },
    statements,
    anyFullScan: statements.some((s) => s.classification === "full_scan"),
  };
  corpora.push(entry);
  console.log(`${spec.id}  cold ${entry.coldBuildMedianMs}ms  db ${(indexBytes / 1e6).toFixed(1)}MB  `
    + `binding rows ${JSON.stringify(bindingRowCounts)}  `
    + `binding bytes ${entry.storage.bindingBytes} (${entry.storage.bindingSharePercent}% of vacuumed)`);
  for (const s of statements) console.log(`   ${s.classification.padEnd(10)} ${s.ms}ms  ${s.id}`);
}

writeFileSync(path.join(RESULTS, OUT), `${JSON.stringify({
  milestone: "M200", instrument: "run_stage5_m200_queryplans.ts",
  purpose: "reverse-binding query plans, per-statement cost, and the authority's storage share",
  generatedFromCommit: (await Bun.$`git -C ${REPO} rev-parse HEAD`.text()).trim(),
  corpora,
}, null, 2)}\n`);
console.log(`\nwrote results/${OUT}`);
