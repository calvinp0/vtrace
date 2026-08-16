import { createHash } from "node:crypto";
import type {
  ProductStores,
  SessionDatabase,
  WritableProductStores,
} from "../sessionStore";

import type { Capsule, CapsuleItem } from "../../capsule/types";
import { computeCapsuleStaleness } from "../../memory/computeCapsuleStaleness";
import type {
  CapsuleManifest,
  CapsuleManifestItemRecord,
  CapsuleManifestRecord,
  CapsuleStalenessComparisonStep,
  CapsuleStalenessResult,
} from "../../memory/types";
import {
  getIndexRunById,
  listFileDiffsForRun,
  listSymbolDiffsForRun,
} from "../../db/repositories/indexRunsRepository";

interface CapsuleManifestRow {
  id: string;
  source_run_id: number;
  query: string;
  created_at_ms: number;
}

interface CapsuleManifestItemRow {
  capsule_id: string;
  item_ordinal: number;
  symbol_id: string;
  file_path: string;
  fq_name: string;
  symbol_kind: string;
  role: string;
  content_mode: string;
  source_backed: number;
}

export interface PersistCapsuleManifestInput {
  sourceRunId: number;
  capsule: Capsule;
  createdAtMs?: number;
}

export function persistCapsuleManifest(
  stores: WritableProductStores,
  input: PersistCapsuleManifestInput,
): CapsuleManifest {
  return persistCapsuleManifestFromItems(stores, {
    sourceRunId: input.sourceRunId,
    query: input.capsule.query,
    items: capsuleToManifestItems(input.capsule),
    ...(input.createdAtMs === undefined ? {} : { createdAtMs: input.createdAtMs }),
  });
}

// The manifest-item identity fields needed to hash + persist a manifest. Plain
// strings so callers (the v1 `Capsule` path and the Capsule v2 product-adapter
// path) can supply structurally-compatible records without enum coupling. A full
// `CapsuleManifestItemRecord` is assignable to this shape.
export interface CapsuleManifestItemFields {
  symbolId: string;
  filePath: string;
  fqName: string;
  symbolKind: string;
  role: string;
  contentMode: string;
  sourceBacked: boolean;
}

export interface PersistCapsuleManifestFromItemsInput {
  sourceRunId: number;
  query: string;
  items: readonly CapsuleManifestItemFields[];
  createdAtMs?: number;
}

/**
 * Persist a capsule manifest from pre-built manifest-item records. Shared core of
 * the v1 (`Capsule`-derived) and Capsule v2 (product-adapter-derived) paths so
 * both compute the same deterministic id and write identical row shapes. Item
 * ordinals are reassigned from array order so callers need not pre-number them.
 */
export function persistCapsuleManifestFromItems(
  stores: WritableProductStores,
  input: PersistCapsuleManifestFromItemsInput,
): CapsuleManifest {
  // The run is validated against the INDEX and the manifest is written to the
  // SESSION store. `source_run_id` is no longer a foreign key — it cannot be,
  // across two files — so this check is what keeps a manifest from claiming a
  // provenance the index never had (§28, §29).
  if (getIndexRunById(stores.index, input.sourceRunId) === undefined) {
    throw new Error(`Index run not found: ${input.sourceRunId}`);
  }

  const db = stores.session;

  const items = input.items.map((item, itemOrdinal) => ({ ...item, itemOrdinal }));
  const manifestId = computeCapsuleManifestId(input.sourceRunId, input.query, items);
  const createdAtMs = input.createdAtMs ?? Date.now();
  const existing = getCapsuleManifestById(db, manifestId);

  if (existing !== undefined) {
    return existing;
  }

  const transaction = db.transaction(() => {
    db.run(
      `
        INSERT INTO capsule_manifests (
          id,
          source_run_id,
          query,
          created_at_ms
        )
        VALUES (?, ?, ?, ?)
      `,
      [manifestId, input.sourceRunId, input.query, createdAtMs],
    );

    for (const item of items) {
      db.run(
        `
          INSERT INTO capsule_manifest_items (
            capsule_id,
            item_ordinal,
            symbol_id,
            file_path,
            fq_name,
            symbol_kind,
            role,
            content_mode,
            source_backed
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          manifestId,
          item.itemOrdinal,
          item.symbolId,
          item.filePath,
          item.fqName,
          item.symbolKind,
          item.role,
          item.contentMode,
          item.sourceBacked ? 1 : 0,
        ],
      );
    }
  });

  transaction();
  return getCapsuleManifestById(db, manifestId)!;
}

/**
 * Persist a capsule manifest as a best-effort side effect of a user-facing
 * capsule build (get_context_capsule, run_pipeline). Returns the deterministic
 * manifest id, or null when no manifest could be persisted: no index run exists
 * yet, the capsule has no items, or persistence failed unexpectedly. This must
 * never throw — manifest persistence is an auxiliary trust signal and must not
 * fail the primary tool/CLI response. Persistence is idempotent, so repeated
 * calls on the same repo state return the same id without duplicate rows.
 */
export function persistCapsuleManifestBestEffort(
  stores: WritableProductStores,
  capsule: Capsule,
  sourceRunId: number | null,
): string | null {
  if (sourceRunId === null) {
    return null;
  }

  if (capsule.pivots.length + capsule.supportingItems.length === 0) {
    return null;
  }

  try {
    return persistCapsuleManifest(stores, { sourceRunId, capsule }).id;
  } catch {
    return null;
  }
}

/**
 * Persist a Capsule v2 manifest as a best-effort side effect of a v2
 * `get_context_capsule` build, mirroring `persistCapsuleManifestBestEffort` for
 * the v1 path. Returns the deterministic manifest id, or null when none could be
 * persisted (no index run yet, the capsule has no items, or persistence failed).
 *
 * Capsule v2 items carry no DB `symbolId`, so the product adapter uses each item's
 * `fqName` as the stable symbol-identity surrogate for manifest hashing. The
 * manifest id therefore stays deterministic and `check_capsule_staleness` resolves
 * it; file-level staleness is exact, while symbol-level staleness compares against
 * the fqName surrogate rather than the persisted symbol id (a documented, intended
 * difference from the v1 path). Never throws.
 */
export function persistCapsuleV2ManifestBestEffort(
  stores: WritableProductStores,
  query: string,
  items: readonly CapsuleManifestItemFields[],
  sourceRunId: number | null,
): string | null {
  if (sourceRunId === null) {
    return null;
  }

  if (items.length === 0) {
    return null;
  }

  try {
    return persistCapsuleManifestFromItems(stores, { sourceRunId, query, items }).id;
  } catch {
    return null;
  }
}

export function getCapsuleManifestById(
  db: SessionDatabase,
  capsuleId: string,
): CapsuleManifest | undefined {
  const row = db.query(`
    SELECT
      id,
      source_run_id,
      query,
      created_at_ms
    FROM capsule_manifests
    WHERE id = ?
  `).get(capsuleId) as CapsuleManifestRow | null;

  if (row === null) {
    return undefined;
  }

  return {
    ...capsuleManifestRowToRecord(row),
    items: listCapsuleManifestItems(db, capsuleId),
  };
}

export function listCapsuleManifestItems(
  db: SessionDatabase,
  capsuleId: string,
): CapsuleManifestItemRecord[] {
  const rows = db.query(`
    SELECT
      capsule_id,
      item_ordinal,
      symbol_id,
      file_path,
      fq_name,
      symbol_kind,
      role,
      content_mode,
      source_backed
    FROM capsule_manifest_items
    WHERE capsule_id = ?
    ORDER BY item_ordinal ASC
  `).all(capsuleId) as CapsuleManifestItemRow[];

  return rows.map((row) => ({
    capsuleId: row.capsule_id,
    itemOrdinal: row.item_ordinal,
    symbolId: row.symbol_id,
    filePath: row.file_path,
    fqName: row.fq_name,
    symbolKind: row.symbol_kind as CapsuleManifestItemRecord["symbolKind"],
    role: row.role as CapsuleManifestItemRecord["role"],
    contentMode: row.content_mode as CapsuleManifestItemRecord["contentMode"],
    sourceBacked: row.source_backed === 1,
  }));
}

/**
 * Is a stored manifest still current?
 *
 * Reads the manifest from the session store and the run history from the index,
 * which is the whole point of the split: rebuilding an index no longer deletes
 * the manifests derived from it (a CASCADE used to), so "the manifest exists"
 * and "the manifest is current" stay two different questions (§18, §145).
 */
export function getCapsuleStaleness(
  stores: ProductStores,
  capsuleId: string,
  comparisonRunId: number,
): CapsuleStalenessResult | undefined {
  const manifest = getCapsuleManifestById(stores.session, capsuleId);
  const comparisonRun = getIndexRunById(stores.index, comparisonRunId);
  const db = stores.index;

  if (manifest === undefined || comparisonRun === undefined) {
    return undefined;
  }

  if (comparisonRunId < manifest.sourceRunId) {
    throw new Error("comparisonRunId must be greater than or equal to sourceRunId");
  }

  return computeCapsuleStaleness({
    manifest,
    comparisonRunId,
    steps: listComparisonSteps(stores.index, manifest.sourceRunId, comparisonRunId),
  });
}

function listComparisonSteps(
  db: import("bun:sqlite").Database,
  sourceRunId: number,
  comparisonRunId: number,
): CapsuleStalenessComparisonStep[] {
  if (sourceRunId === comparisonRunId) {
    return [];
  }

  const runIds: number[] = [];
  let currentRun = getIndexRunById(db, comparisonRunId);

  while (currentRun !== undefined && currentRun.id !== sourceRunId) {
    runIds.push(currentRun.id);

    if (currentRun.previousRunId === undefined) {
      throw new Error(`Run ${comparisonRunId} is not descended from source run ${sourceRunId}`);
    }

    currentRun = getIndexRunById(db, currentRun.previousRunId);
  }

  if (currentRun?.id !== sourceRunId) {
    throw new Error(`Run ${comparisonRunId} is not descended from source run ${sourceRunId}`);
  }

  return runIds.reverse().map((runId) => ({
    runId,
    fileDiffs: listFileDiffsForRun(db, runId) ?? [],
    symbolDiffs: listSymbolDiffsForRun(db, runId) ?? [],
  }));
}

function computeCapsuleManifestId(
  sourceRunId: number,
  query: string,
  items: readonly (CapsuleManifestItemFields & { itemOrdinal: number })[],
): string {
  const hash = createHash("sha256");
  hash.update(sourceRunId.toString(10));
  hash.update("\0");
  hash.update(query);

  for (const item of items) {
    hash.update("\0");
    hash.update([
      item.itemOrdinal.toString(10),
      item.symbolId,
      item.filePath,
      item.fqName,
      item.symbolKind,
      item.role,
      item.contentMode,
      item.sourceBacked ? "1" : "0",
    ].join("\0"));
  }

  return hash.digest("hex");
}

function capsuleToManifestItems(capsule: Capsule): CapsuleManifestItemRecord[] {
  return [...capsule.pivots, ...capsule.supportingItems]
    .map((item, itemOrdinal) => capsuleItemToManifestItemRecord(item, itemOrdinal));
}

function capsuleItemToManifestItemRecord(
  item: CapsuleItem,
  itemOrdinal: number,
): CapsuleManifestItemRecord {
  return {
    capsuleId: "",
    itemOrdinal,
    symbolId: item.symbolId,
    filePath: item.filePath,
    fqName: item.fqName,
    symbolKind: item.kind,
    role: item.role,
    contentMode: item.content.mode,
    sourceBacked: item.sourceBacked === true,
  };
}

function capsuleManifestRowToRecord(row: CapsuleManifestRow): CapsuleManifestRecord {
  return {
    id: row.id,
    sourceRunId: row.source_run_id,
    query: row.query,
    createdAtMs: row.created_at_ms,
  };
}
