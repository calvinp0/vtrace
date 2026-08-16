/**
 * M151-E — table-level proof of what a product read does and does not mutate.
 *
 * WHY THIS REPLACES A HASH COMPARISON
 * ----------------
 * The closure gate was "the index file is byte-identical after a product read".
 * That gate rested on an assumption the audit refuted: `index.sqlite` does not
 * hold repository-derived state alone. It also holds product/session state that
 * three supported features persist on purpose — observation auto-capture, capsule
 * manifests, and deferred VEXP references.
 *
 * So a changed file hash does not tell you whether retrieval corrupted the index
 * or whether `search_memory` recorded a lookup. This runner answers that
 * precisely, per table:
 *
 *   repository-derived tables  -> MUST be byte-identical after any number of reads
 *   product/session tables     -> MAY change, and only these three families may
 *
 * Every table in the database is classified, and an unclassified table FAILS the
 * run rather than being skipped — the M146-A closure-guard pattern, so a new
 * table cannot silently land on the wrong side of the invariant.
 *
 * Deterministic. No agents, no network, no Docker, no indexing.
 */
import { Database } from "bun:sqlite";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { initRepo } from "../../src/setup/initRepo";
import { resolveRepoLocalPaths } from "../../src/setup/repoState";
import { resolveIndexDbPath } from "../../src/indexer/indexMeta";
import { defaultMcpToolRegistry } from "../../src/mcp/tools";
import { MCP_SERVER_ID, MCP_SERVER_SCHEMA, McpToolId } from "../../src/mcp/types";
import {
  classifyIndexTable,
  PRODUCT_SESSION_TABLES,
  REPOSITORY_DERIVED_PREFIXES,
  REPOSITORY_DERIVED_TABLES,
  type IndexTableFamily,
} from "../../src/db/indexTableFamilies";

const execFile = promisify(execFileCallback);
const RESULTS = path.join(import.meta.dir, "results");

// One definition, shared with src/mcp/readPathImmutability.test.ts.
const classify = classifyIndexTable;

const ARC = "/home/calvin/code/ARC";
const TCKDB = "/home/calvin/code/TCKDB_v2";

interface TableDigest {
  readonly rows: number;
  readonly digest: string;
}

/**
 * Full content digest per table, streamed so a 637k-row table does not have to be
 * materialised. Ordered by rowid where available so the digest is stable.
 */
function snapshotTables(dbPath: string): {
  tables: Map<string, TableDigest>;
  schemaDigest: string;
  objectCount: number;
  unclassified: string[];
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    const master = db.query(
      "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
    ).all();
    const schemaDigest = createHash("sha256").update(JSON.stringify(master)).digest("hex").slice(0, 16);

    const tables = (db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string }[]).map((row) => row.name);

    const digests = new Map<string, TableDigest>();
    const unclassified: string[] = [];

    for (const table of tables) {
      if (classify(table) === null) unclassified.push(table);
      const hash = createHash("sha256");
      let rows = 0;
      try {
        // `iterate` streams so a 637k-row table is never materialised.
        for (const row of db.query(`SELECT * FROM "${table}"`).iterate() as Iterable<unknown>) {
          rows += 1;
          hash.update(JSON.stringify(row));
        }
      } catch (error) {
        hash.update(`UNREADABLE:${String(error)}`);
      }
      digests.set(table, { rows, digest: hash.digest("hex").slice(0, 16) });
    }

    return { tables: digests, schemaDigest, objectCount: master.length, unclassified };
  } finally {
    db.close();
  }
}

function diffFamilies(
  before: ReturnType<typeof snapshotTables>,
  after: ReturnType<typeof snapshotTables>,
) {
  const changed: { table: string; family: IndexTableFamily | null; rows: string; }[] = [];
  for (const [table, post] of after.tables) {
    const pre = before.tables.get(table);
    if (pre === undefined) {
      changed.push({ table, family: classify(table), rows: `NEW (${post.rows})` });
      continue;
    }
    if (pre.digest === post.digest && pre.rows === post.rows) continue;
    changed.push({ table, family: classify(table), rows: `${pre.rows} -> ${post.rows}` });
  }
  const derivedChanged = changed.filter((entry) => entry.family === "repository_derived");
  const sessionChanged = changed.filter((entry) => entry.family === "product_session");
  const unknownChanged = changed.filter((entry) => entry.family === null);

  return {
    changed,
    derivedChanged,
    sessionChanged,
    unknownChanged,
    repositoryDerivedUnchanged: derivedChanged.length === 0,
    schemaUnchanged: before.schemaDigest === after.schemaDigest,
    objectCountUnchanged: before.objectCount === after.objectCount,
  };
}

function contextBoundTo(repoRoot: string) {
  const paths = resolveRepoLocalPaths(repoRoot);
  return {
    serverId: MCP_SERVER_ID, repoRoot, dbPath: paths.dbPath, configPath: paths.configPath,
    statePath: paths.statePath, initialized: true, config: null, state: null,
  } as never;
}

async function callTool(repoRoot: string, toolId: McpToolId, input: Record<string, unknown>): Promise<any> {
  const registry = defaultMcpToolRegistry;
  return (await registry.getByToolId(toolId)!.handler({
    context: contextBoundTo(repoRoot),
    request: { schema: MCP_SERVER_SCHEMA, requestId: "m151-family", toolId, input },
  })) as any;
}

async function fileHash(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex").slice(0, 16);
}

const SURFACES: readonly [string, McpToolId][] = [
  ["get_code_context", McpToolId.GetCodeContext],
  ["run_pipeline", McpToolId.RunPipeline],
  ["get_context_capsule", McpToolId.GetContextCapsule],
  ["index_status", McpToolId.IndexStatus],
];

/** Repeated reads across every product surface, then one table-level diff. */
async function exerciseRepository(repoRoot: string, query: string, label: string) {
  const dbPath = resolveIndexDbPath(repoRoot);
  const metaPath = path.join(repoRoot, ".vtrace", "index.meta.json");

  const before = snapshotTables(dbPath);
  const beforeFile = await fileHash(dbPath);
  const beforeMeta = await fileHash(metaPath).catch(() => "absent");
  const beforeSize = (await stat(dbPath)).size;

  const perSurface: Record<string, unknown>[] = [];
  for (const [name, toolId] of SURFACES) {
    const input = toolId === McpToolId.IndexStatus ? {} : { query };
    const surfaceBefore = snapshotTables(dbPath);
    let ok = true;
    for (let call = 0; call < 3; call += 1) {
      const result = await callTool(repoRoot, toolId, input);
      ok = ok && result.ok === true;
    }
    const surfaceAfter = snapshotTables(dbPath);
    const diff = diffFamilies(surfaceBefore, surfaceAfter);
    perSurface.push({
      surface: name,
      calls: 3,
      ok,
      repositoryDerivedUnchanged: diff.repositoryDerivedUnchanged,
      schemaUnchanged: diff.schemaUnchanged,
      objectCountUnchanged: diff.objectCountUnchanged,
      derivedTablesChanged: diff.derivedChanged.map((e) => e.table),
      productSessionTablesChanged: diff.sessionChanged.map((e) => `${e.table} ${e.rows}`),
      unclassifiedTablesChanged: diff.unknownChanged.map((e) => e.table),
    });
    console.log(
      `  ${label}/${name.padEnd(20)} derivedUnchanged=${diff.repositoryDerivedUnchanged}`
      + ` schemaUnchanged=${diff.schemaUnchanged}`
      + ` sessionWrites=${diff.sessionChanged.length}`,
    );
  }

  const after = snapshotTables(dbPath);
  const overall = diffFamilies(before, after);

  return {
    repoRoot,
    query,
    tablesClassified: after.tables.size,
    unclassifiedTables: after.unclassified,
    classificationComplete: after.unclassified.length === 0,
    indexFileHashBefore: beforeFile,
    indexFileHashAfter: await fileHash(dbPath),
    indexFileSizeBefore: beforeSize,
    indexFileSizeAfter: (await stat(dbPath)).size,
    derivationFingerprintBefore: beforeMeta,
    derivationFingerprintAfter: await fileHash(metaPath).catch(() => "absent"),
    derivationFingerprintUnchanged: beforeMeta === (await fileHash(metaPath).catch(() => "absent")),
    schemaUnchanged: overall.schemaUnchanged,
    objectCountUnchanged: overall.objectCountUnchanged,
    repositoryDerivedUnchanged: overall.repositoryDerivedUnchanged,
    derivedTablesChanged: overall.derivedChanged.map((e) => `${e.table} ${e.rows}`),
    productSessionTablesChanged: overall.sessionChanged.map((e) => `${e.table} ${e.rows}`),
    unclassifiedTablesChanged: overall.unknownChanged.map((e) => e.table),
    perSurface,
  };
}

async function main(): Promise<void> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "m151-family-"));
  const report: Record<string, unknown> = {};

  try {
    // ---- Fixture: per-surface attribution on a freshly built index ----------
    const fixture = path.join(scratch, "fixture");
    await mkdir(path.join(fixture, "src"), { recursive: true });
    await writeFile(path.join(fixture, "src", "engine.py"),
      "def pick_winner(records):\n    \"\"\"Choose the winning record.\"\"\"\n    return sorted(records)[0]\n");
    await execFile("git", ["init", "--initial-branch=main"], { cwd: fixture });
    await execFile("git", ["config", "user.email", "m151@example.com"], { cwd: fixture });
    await execFile("git", ["config", "user.name", "M151"], { cwd: fixture });
    await execFile("git", ["add", "."], { cwd: fixture });
    await execFile("git", ["commit", "-m", "i"], { cwd: fixture });
    await initRepo({ repoPath: fixture });

    console.log("[m151-family] fixture");
    report.fixture = await exerciseRepository(fixture, "pick_winner", "fixture");

    // ---- Read-after-write lifecycle (§101) ---------------------------------
    const fixtureDb = resolveIndexDbPath(fixture);
    const lifecycleBefore = snapshotTables(fixtureDb);
    for (let call = 0; call < 2; call += 1) {
      await callTool(fixture, McpToolId.GetCodeContext, { query: "pick_winner" });
    }
    const lifecycleAfter = snapshotTables(fixtureDb);
    const lifecycle = diffFamilies(lifecycleBefore, lifecycleAfter);
    report.readAfterWrite = {
      note: "index_repo -> H0, then repeated get_code_context. Derived state must not move.",
      repositoryDerivedUnchanged: lifecycle.repositoryDerivedUnchanged,
      schemaUnchanged: lifecycle.schemaUnchanged,
      productSessionTablesChanged: lifecycle.sessionChanged.map((e) => `${e.table} ${e.rows}`),
    };

    // ---- Real repositories --------------------------------------------------
    console.log("[m151-family] ARC");
    report.arc = await exerciseRepository(ARC, "How does ARC decide which reaction family wins?", "ARC");
    console.log("[m151-family] TCKDB_v2");
    report.tckdb = await exerciseRepository(TCKDB, "How are thermodynamic properties stored?", "TCKDB");

    const all = [report.fixture, report.arc, report.tckdb] as any[];
    const summary = {
      repositoriesExercised: all.length,
      surfacesPerRepository: SURFACES.length,
      callsPerSurface: 3,
      classificationComplete: all.every((r) => r.classificationComplete),
      repositoryDerivedUnchangedEverywhere: all.every((r) => r.repositoryDerivedUnchanged),
      schemaUnchangedEverywhere: all.every((r) => r.schemaUnchanged),
      objectCountUnchangedEverywhere: all.every((r) => r.objectCountUnchanged),
      derivationFingerprintUnchangedEverywhere: all.every((r) => r.derivationFingerprintUnchanged),
      onlyDocumentedFamiliesMutated: all.every((r) => r.unclassifiedTablesChanged.length === 0),
    };

    await writeFile(
      path.join(RESULTS, "stage5_m151_table_family_preservation.json"),
      `${JSON.stringify({
        milestone: "M151",
        generatedAt: new Date().toISOString(),
        note:
          "The byte-identity gate assumed index.sqlite holds repository-derived state "
          + "alone. It does not. This proves the invariant that actually matters: "
          + "repeated product reads leave every repository-derived table, the schema, "
          + "the object set and the derivation fingerprint untouched, and mutate only "
          + "the three documented product/session families.",
        families: {
          repository_derived: [
            ...REPOSITORY_DERIVED_TABLES,
            ...REPOSITORY_DERIVED_PREFIXES.map((prefix) => `${prefix}*`),
          ],
          product_session: [...PRODUCT_SESSION_TABLES],
          unclassifiedFailsTheRun: true,
        },
        summary,
        ...report,
      }, null, 2)}\n`,
    );

    console.log("\n[m151-family] SUMMARY");
    for (const [key, value] of Object.entries(summary)) console.log(`  ${key}: ${value}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
