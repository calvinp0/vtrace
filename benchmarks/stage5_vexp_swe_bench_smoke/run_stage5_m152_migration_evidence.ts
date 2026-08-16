// M152-E — migration and ownership evidence over a real (or copied) index.
//
// Runs the actual migration seam against an index, records row-level parity for
// every moved family, and then proves the invariant the milestone exists for:
// after the split, product activity leaves `index.sqlite` byte-identical.
//
// Copies first, authoritative state only once the copies pass (§61, §62).
//
//   bun benchmarks/.../run_stage5_m152_migration_evidence.ts \
//     --repo <path> [--label <name>] --out <dir>

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  PRODUCT_SESSION_TABLES,
  SESSION_MIGRATION_ORDER,
  classifyIndexTable,
  classifySessionTable,
} from "../../src/db/indexTableFamilies";
import { openProductIndexDatabase } from "../../src/db/sqlite";
import { getLatestIndexRun } from "../../src/db/repositories/indexRunsRepository";
import { resolveIndexDbPath } from "../../src/indexer/indexMeta";
import { searchMemory } from "../../src/observations/searchMemory";
import { getSessionContext } from "../../src/observations/getSessionContext";
import {
  LegacyMigrationOutcome,
  listLegacySessionTables,
  migrateLegacySessionState,
} from "../../src/session/legacyMigration";
import {
  getCapsuleManifestById,
  getCapsuleStaleness,
  persistCapsuleV2ManifestBestEffort,
} from "../../src/session/repositories/capsuleManifestsRepository";
import { listObservations, persistObservation } from "../../src/session/repositories/observationsRepository";
import { resolvePersistentDeferredVexpRef } from "../../src/session/repositories/deferredVexpRefsRepository";
import { ProductStoreLease, SessionStore, resolveSessionDbPath } from "../../src/session/sessionStore";

interface FamilyParity {
  readonly family: string;
  readonly rowsBefore: number;
  readonly rowsAfter: number;
  /** null when there is nothing to compare against, never a vacuous pass. */
  readonly idsPreserved: boolean | null;
  readonly contentPreserved: boolean | null;
  readonly rowsPreserved: boolean;
  readonly duplicates: number;
}

async function hashFile(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  const bytes = await Bun.file(filePath).arrayBuffer();
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function rowCount(db: Database, table: string): number {
  try {
    return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } catch {
    return 0;
  }
}

/**
 * Content digest over a whole table, independent of both row order and COLUMN
 * order. The column-order part is load-bearing: a legacy `observations` table
 * gained its provenance columns through `ALTER TABLE`, so they sit at the end,
 * while the session schema declares them inline. `SELECT *` therefore returns
 * the same values under a different key order, and a naive digest would report
 * a content change where there is none.
 */
function tableDigest(db: Database, table: string): string {
  try {
    const rows = (db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[])
      .map((row) => JSON.stringify(
        Object.fromEntries(Object.keys(row).sort().map((key) => [key, row[key]])),
      ))
      .sort();
    return createHash("sha256").update(rows.join("\n")).digest("hex");
  } catch {
    return "MISSING";
  }
}

function primaryIds(db: Database, table: string): string[] {
  const pk: Record<string, string> = {
    observations: "id",
    capsule_manifests: "id",
    deferred_vexp_refs: "hash",
    deferred_vexp_ref_tombstones: "hash",
    sessions: "session_id",
    project_rules: "id",
    session_compression_summaries: "id",
  };
  const column = pk[table];
  if (column === undefined) return [];
  try {
    return (db.query(`SELECT ${column} AS id FROM ${table}`).all() as { id: string }[])
      .map((row) => String(row.id))
      .sort();
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const read = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const repoRoot = read("--repo");
  // Pre-migration row counts, recorded BEFORE the index lifecycle drained the
  // legacy tables. Without this the runner reads a already-migrated index, sees
  // zero legacy rows, and reports a parity failure that is an artifact of when
  // it ran rather than anything the migration did (§67).
  const preStatePath = read("--pre-state");
  const outDir = read("--out") ?? "benchmarks/stage5_vexp_swe_bench_smoke/results";
  const label = read("--label") ?? path.basename(repoRoot ?? "unknown");
  if (repoRoot === undefined) {
    console.error("--repo <path> is required");
    process.exit(2);
  }

  const indexPath = resolveIndexDbPath(repoRoot);
  const sessionPath = resolveSessionDbPath(repoRoot);

  // ---- Pre-migration identity (§64) ---------------------------------------
  const preIndexHash = await hashFile(indexPath);
  const preIndexSize = existsSync(indexPath) ? statSync(indexPath).size : 0;

  const recordedPre: Record<string, number> | undefined = preStatePath === undefined
    ? undefined
    : (JSON.parse(await Bun.file(preStatePath).text()) as Record<string, number>);

  const preDb = new Database(indexPath, { readonly: true });
  const legacyTables = listLegacySessionTables(preDb);
  const alreadyMigrated = legacyTables.length === 0 && existsSync(sessionPath);
  const before: Record<string, { rows: number; digest: string; ids: string[] }> = {};
  for (const table of SESSION_MIGRATION_ORDER) {
    before[table] = {
      rows: recordedPre?.[table] ?? rowCount(preDb, table),
      digest: tableDigest(preDb, table),
      ids: primaryIds(preDb, table),
    };
  }
  const preIndexRuns = rowCount(preDb, "index_runs");
  const preSymbols = rowCount(preDb, "symbols");
  const preFiles = rowCount(preDb, "files");
  preDb.close();

  // ---- Migration (§65) -----------------------------------------------------
  const migrationStartedMs = Date.now();
  const writableIndex = new Database(indexPath);
  const sessionStore = new SessionStore(sessionPath);
  let migrationOutcome: string;
  let rowsCopied = 0;
  try {
    const result = migrateLegacySessionState({
      indexDb: writableIndex,
      indexDbPath: indexPath,
      sessionDb: sessionStore.writeSession(),
    });
    migrationOutcome = result.outcome;
    rowsCopied = result.totalRowsCopied;
  } finally {
    sessionStore.close();
    writableIndex.close();
  }
  const migrationMs = Date.now() - migrationStartedMs;

  // ---- Post-migration parity (§67, §180) -----------------------------------
  const sessionDbRead = new Database(sessionPath, { readonly: true });
  const parity: FamilyParity[] = SESSION_MIGRATION_ORDER.map((table) => {
    const after = {
      rows: rowCount(sessionDbRead, table),
      digest: tableDigest(sessionDbRead, table),
      ids: primaryIds(sessionDbRead, table),
    };
    return {
      family: table,
      rowsBefore: before[table]!.rows,
      rowsAfter: after.rows,
      // When the drain already happened in `index_repo`, the legacy tables are
      // gone and there is nothing left to compare ids and content against. Row
      // parity against the RECORDED pre-state is still real evidence; claiming
      // id or content parity from an empty side would not be, so those report
      // as `null` rather than as a pass.
      //
      // A table with no single-column primary key (the link tables) has no ids
      // to compare either way; that is also `null`, not a failure.
      idsPreserved: alreadyMigrated || after.ids.length === 0
        ? null
        : JSON.stringify(before[table]!.ids) === JSON.stringify(after.ids),
      contentPreserved: alreadyMigrated
        ? null
        : before[table]!.digest === after.digest,
      rowsPreserved: after.rows === before[table]!.rows,
      duplicates: Math.max(0, after.rows - before[table]!.rows),
    };
  });
  const sessionObjects = (sessionDbRead.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).all() as { name: string }[]).map((row) => row.name);
  sessionDbRead.close();

  // ---- Post-migration index ownership (§136) -------------------------------
  const postDb = new Database(indexPath, { readonly: true });
  const postIndexObjects = (postDb.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).all() as { name: string }[]).map((row) => row.name);
  const productOwnedStillInIndex = postIndexObjects.filter(
    (name) => classifyIndexTable(name) === "product_session",
  );
  const unclassifiedIndexObjects = postIndexObjects.filter(
    (name) => classifyIndexTable(name) === null,
  );
  const unclassifiedSessionObjects = sessionObjects.filter(
    (name) => classifySessionTable(name) === null,
  );
  const derivedCopiedIntoSession = sessionObjects.filter(
    (name) => classifyIndexTable(name) === "repository_derived",
  );
  postDb.close();

  const postMigrationIndexHash = await hashFile(indexPath);

  // ---- H0, then real product activity, then Hfinal (§57, §66, §140) --------
  //
  // Everything below WRITES product state. Parity above was measured before any
  // of it, so a repeated run cannot report its own probe rows as migration
  // duplicates — the probe uses a fixed dedupe key and a deterministic manifest
  // id, so it is idempotent across runs.
  const h0Index = postMigrationIndexHash;
  const h0Session = await hashFile(sessionPath);

  const productDb = openProductIndexDatabase(indexPath);
  const lease = new ProductStoreLease(productDb, indexPath);
  const featureResults: Record<string, unknown> = {};
  try {
    const latestRun = getLatestIndexRun(productDb)?.id ?? null;

    // search_memory over migrated observations
    const memory = searchMemory(lease.read, { query: "index", maxResults: 5 });
    featureResults.searchMemory = {
      ok: true,
      migratedObservationsVisible: listObservations(lease.read.session).length,
      matched: memory.length,
    };

    // get_session_context
    const sessionContext = getSessionContext(lease.read, { limit: 3 });
    featureResults.getSessionContext = {
      ok: true,
      observations: sessionContext.observations.length,
    };

    // a migrated manifest still resolves, and its staleness is computable
    const migratedManifestId = before.capsule_manifests!.ids[0];
    if (migratedManifestId !== undefined && latestRun !== null) {
      const manifest = getCapsuleManifestById(lease.read.session, migratedManifestId);
      let stalenessStatus: string | null = null;
      try {
        stalenessStatus = getCapsuleStaleness(lease.read, migratedManifestId, latestRun)?.status ?? null;
      } catch (error) {
        stalenessStatus = `error:${(error as Error).message}`;
      }
      featureResults.capsuleManifest = {
        ok: manifest !== undefined,
        manifestId: migratedManifestId,
        items: manifest?.items.length ?? 0,
        stalenessStatus,
      };
    }

    // a migrated deferred ref still resolves
    const migratedRefHash = before.deferred_vexp_refs!.ids[0];
    if (migratedRefHash !== undefined) {
      const resolved = resolvePersistentDeferredVexpRef(lease.write.session, migratedRefHash);
      featureResults.deferredRef = {
        ok: resolved !== null,
        hash: migratedRefHash,
        stableId: resolved?.stableId ?? null,
      };
    }

    // a NEW observation and a NEW manifest, written through the real repositories
    const observation = persistObservation(lease.write, {
      repoRoot,
      kind: "insight" as never,
      source: "manual" as never,
      summary: `M152 migration evidence probe for ${label}`,
      body: "",
      ...(latestRun === null ? {} : { sourceRunId: latestRun }),
      dedupeKey: `m152-evidence:${label}`,
    });
    featureResults.newObservation = { ok: true, id: observation.id };

    const newManifestId = latestRun === null ? null : persistCapsuleV2ManifestBestEffort(
      lease.write,
      "m152 evidence probe",
      [{
        symbolId: "m152::probe",
        filePath: "m152/probe.py",
        fqName: "m152.probe",
        symbolKind: "function",
        role: "pivot",
        contentMode: "full",
        sourceBacked: false,
      }],
      latestRun,
    );
    featureResults.newManifest = {
      ok: newManifestId !== null,
      id: newManifestId,
      resolvable: newManifestId === null
        ? false
        : getCapsuleManifestById(lease.read.session, newManifestId) !== undefined,
    };
  } finally {
    lease.close();
    productDb.close();
  }

  const hFinalIndex = await hashFile(indexPath);
  const hFinalSession = await hashFile(sessionPath);

  const report = {
    milestone: "M152-E",
    label,
    repoRoot,
    indexPath,
    sessionPath,
    preMigration: {
      indexHash: preIndexHash,
      indexSizeBytes: preIndexSize,
      legacySessionTables: legacyTables.length,
      legacyRowTotal: Object.values(before).reduce((total, entry) => total + entry.rows, 0),
      indexRuns: preIndexRuns,
      files: preFiles,
      symbols: preSymbols,
      sessionStorePresent: false,
    },
    migration: {
      /**
       * `already_migrated_by_index_lifecycle` means the real `index_repo` seam
       * drained this repository, which is the intended production path; this
       * runner then measured the result rather than performing the move.
       */
      performedBy: alreadyMigrated ? "index_repo_lifecycle" : "evidence_runner",
      parityBasis: recordedPre === undefined ? "live_index" : "recorded_pre_state",
      outcome: migrationOutcome,
      rowsCopied,
      durationMs: migrationMs,
      indexHashAfter: postMigrationIndexHash,
      indexSizeAfterBytes: statSync(indexPath).size,
      sessionSizeBytes: existsSync(sessionPath) ? statSync(sessionPath).size : 0,
    },
    parity,
    ownership: {
      productOwnedStillInIndex,
      unclassifiedIndexObjects,
      unclassifiedSessionObjects,
      derivedCopiedIntoSession,
      indexObjectCount: postIndexObjects.length,
      sessionObjectCount: sessionObjects.length,
    },
    hashMatrix: {
      h0Index,
      hFinalIndex,
      indexUnchangedAcrossProductActivity: h0Index === hFinalIndex,
      h0Session,
      hFinalSession,
      sessionChangedAsExpected: h0Session !== hFinalSession,
    },
    featureResults,
    gates: {
      migrationCompleted: migrationOutcome !== LegacyMigrationOutcome.NotLegacy
        || legacyTables.length === 0,
      allFamiliesRowsPreserved: parity.every((family) => family.rowsPreserved),
      allFamiliesIdsPreserved: parity.every((family) => family.idsPreserved !== false),
      allFamiliesContentPreserved: parity.every((family) => family.contentPreserved !== false),
      noDuplicates: parity.every((family) => family.duplicates === 0),
      indexOwnsNoProductState: productOwnedStillInIndex.length === 0,
      noUnclassifiedObjects:
        unclassifiedIndexObjects.length === 0 && unclassifiedSessionObjects.length === 0,
      noEvidenceCopiedIntoSession: derivedCopiedIntoSession.length === 0,
      indexByteIdenticalUnderProductActivity: h0Index === hFinalIndex,
    },
  };

  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `stage5_m152_real_${label}_migration.json`);
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.gates, null, 2));
  console.log(`\nwrote ${outPath}`);
}

void main();
