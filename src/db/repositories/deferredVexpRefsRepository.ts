import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import {
  type DeferredVexpContent,
  type DeferredVexpEntry,
  type DeferredVexpCategory,
  isValidDeferredVexpHash,
  stableStringifyDeferredVexpPayload,
} from "../../runPipeline/deferredVexpStore";

export const DEFERRED_VEXP_PERSISTENCE_DEFAULTS = Object.freeze({
  maxRecords: 1_000,
  maxTombstones: 1_000,
});

export interface PersistDeferredVexpRefInput {
  readonly entry: DeferredVexpEntry;
  readonly repoRoot: string;
  readonly sourceRunId?: number | null;
  readonly sessionId?: string | null;
  readonly notes?: readonly string[];
  readonly expiresAtMs?: number | null;
  readonly now?: () => number;
}

export interface PersistentDeferredVexpRefRecord extends DeferredVexpEntry {
  readonly repoRoot: string;
  readonly sourceRunId: number | null;
  readonly sessionId: string | null;
  readonly notes: readonly string[];
  readonly lastAccessedAtMs: number;
  readonly expiresAtMs: number | null;
  readonly payloadHash: string;
}

interface DeferredVexpRefRow {
  hash: string;
  stable_id: string;
  category: string;
  content_json: string;
  metadata_json: string;
  notes_json: string;
  repo_root: string;
  source_run_id: number | null;
  session_id: string | null;
  created_at_ms: number;
  last_accessed_at_ms: number;
  expires_at_ms: number | null;
  payload_hash: string;
}

export function persistDeferredVexpRef(
  db: Database,
  input: PersistDeferredVexpRefInput,
  options: {
    readonly maxRecords?: number;
    readonly maxTombstones?: number;
  } = {},
): PersistentDeferredVexpRefRecord {
  const now = input.now ?? Date.now;
  const lastAccessedAtMs = now();
  const payloadHash = computePayloadHash(input.entry.content);
  const notes = [...(input.notes ?? [])];

  db.run(
    `
      INSERT INTO deferred_vexp_refs (
        hash,
        stable_id,
        category,
        content_json,
        metadata_json,
        notes_json,
        repo_root,
        source_run_id,
        session_id,
        created_at_ms,
        last_accessed_at_ms,
        expires_at_ms,
        payload_hash
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        stable_id = excluded.stable_id,
        category = excluded.category,
        content_json = excluded.content_json,
        metadata_json = excluded.metadata_json,
        notes_json = excluded.notes_json,
        repo_root = excluded.repo_root,
        source_run_id = excluded.source_run_id,
        session_id = excluded.session_id,
        created_at_ms = excluded.created_at_ms,
        last_accessed_at_ms = excluded.last_accessed_at_ms,
        expires_at_ms = excluded.expires_at_ms,
        payload_hash = excluded.payload_hash
    `,
    [
      input.entry.hash,
      input.entry.stableId,
      input.entry.category,
      JSON.stringify(input.entry.content),
      JSON.stringify(input.entry.metadata),
      JSON.stringify(notes),
      input.repoRoot,
      input.sourceRunId ?? null,
      input.sessionId ?? null,
      input.entry.createdAtMs,
      lastAccessedAtMs,
      input.expiresAtMs ?? null,
      payloadHash,
    ],
  );

  db.run(
    `DELETE FROM deferred_vexp_ref_tombstones WHERE hash = ?`,
    [input.entry.hash],
  );

  cleanupDeferredVexpRefs(db, {
    maxRecords: options.maxRecords ?? DEFERRED_VEXP_PERSISTENCE_DEFAULTS.maxRecords,
    maxTombstones: options.maxTombstones ?? DEFERRED_VEXP_PERSISTENCE_DEFAULTS.maxTombstones,
    now,
  });

  return resolvePersistentDeferredVexpRef(db, input.entry.hash, { now })!;
}

export function resolvePersistentDeferredVexpRef(
  db: Database,
  hash: string,
  options: { readonly now?: () => number } = {},
): PersistentDeferredVexpRefRecord | null {
  if (!isValidDeferredVexpHash(hash)) {
    return null;
  }

  const now = options.now ?? Date.now;
  const accessedAtMs = now();
  const row = db.query(`
    SELECT
      hash,
      stable_id,
      category,
      content_json,
      metadata_json,
      notes_json,
      repo_root,
      source_run_id,
      session_id,
      created_at_ms,
      last_accessed_at_ms,
      expires_at_ms,
      payload_hash
    FROM deferred_vexp_refs
    WHERE hash = ?
  `).get(hash) as DeferredVexpRefRow | null;

  if (row === null) {
    return null;
  }

  if (row.expires_at_ms !== null && row.expires_at_ms <= accessedAtMs) {
    expirePersistentDeferredVexpRef(db, hash, {
      reason: "age_expired",
      now,
    });
    return null;
  }

  db.run(
    `UPDATE deferred_vexp_refs SET last_accessed_at_ms = ? WHERE hash = ?`,
    [accessedAtMs, hash],
  );

  return deferredVexpRefRowToRecord({
    ...row,
    last_accessed_at_ms: accessedAtMs,
  });
}

export function isPersistentDeferredVexpRefExpired(
  db: Database,
  hash: string,
): boolean {
  if (!isValidDeferredVexpHash(hash)) {
    return false;
  }

  const row = db.query(`
    SELECT hash
    FROM deferred_vexp_ref_tombstones
    WHERE hash = ?
  `).get(hash) as { hash: string } | null;

  return row !== null;
}

export function expirePersistentDeferredVexpRef(
  db: Database,
  hash: string,
  options: {
    readonly reason?: string;
    readonly repoRoot?: string;
    readonly now?: () => number;
  } = {},
): boolean {
  if (!isValidDeferredVexpHash(hash)) {
    return false;
  }

  const row = db.query(`
    SELECT repo_root
    FROM deferred_vexp_refs
    WHERE hash = ?
  `).get(hash) as { repo_root: string } | null;

  const repoRoot = options.repoRoot ?? row?.repo_root ?? "";
  db.run(`DELETE FROM deferred_vexp_refs WHERE hash = ?`, [hash]);
  db.run(
    `
      INSERT INTO deferred_vexp_ref_tombstones (
        hash,
        repo_root,
        expired_at_ms,
        reason
      )
      VALUES (?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        repo_root = excluded.repo_root,
        expired_at_ms = excluded.expired_at_ms,
        reason = excluded.reason
    `,
    [hash, repoRoot, (options.now ?? Date.now)(), options.reason ?? "expired"],
  );

  return row !== null;
}

export function cleanupDeferredVexpRefs(
  db: Database,
  options: {
    readonly maxRecords?: number;
    readonly maxTombstones?: number;
    readonly now?: () => number;
  } = {},
): void {
  const maxRecords = Math.max(1, options.maxRecords ?? DEFERRED_VEXP_PERSISTENCE_DEFAULTS.maxRecords);
  const maxTombstones = Math.max(1, options.maxTombstones ?? DEFERRED_VEXP_PERSISTENCE_DEFAULTS.maxTombstones);
  const now = options.now ?? Date.now;

  const expiredRows = db.query(`
    SELECT hash, repo_root
    FROM deferred_vexp_refs
    WHERE expires_at_ms IS NOT NULL
      AND expires_at_ms <= ?
    ORDER BY expires_at_ms ASC, hash ASC
  `).all(now()) as Array<{ hash: string; repo_root: string }>;

  for (const row of expiredRows) {
    expirePersistentDeferredVexpRef(db, row.hash, {
      repoRoot: row.repo_root,
      reason: "age_expired",
      now,
    });
  }

  const overflowRows = db.query(`
    SELECT hash, repo_root
    FROM deferred_vexp_refs
    ORDER BY created_at_ms ASC, hash ASC
    LIMIT (
      SELECT max(count(*) - ?, 0)
      FROM deferred_vexp_refs
    )
  `).all(maxRecords) as Array<{ hash: string; repo_root: string }>;

  for (const row of overflowRows) {
    expirePersistentDeferredVexpRef(db, row.hash, {
      repoRoot: row.repo_root,
      reason: "capacity_evicted",
      now,
    });
  }

  db.run(
    `
      DELETE FROM deferred_vexp_ref_tombstones
      WHERE hash IN (
        SELECT hash
        FROM deferred_vexp_ref_tombstones
        ORDER BY expired_at_ms ASC, hash ASC
        LIMIT (
          SELECT max(count(*) - ?, 0)
          FROM deferred_vexp_ref_tombstones
        )
      )
    `,
    [maxTombstones],
  );
}

function deferredVexpRefRowToRecord(row: DeferredVexpRefRow): PersistentDeferredVexpRefRecord {
  return {
    hash: row.hash,
    stableId: row.stable_id,
    category: row.category as DeferredVexpCategory,
    content: JSON.parse(row.content_json) as DeferredVexpContent,
    metadata: JSON.parse(row.metadata_json) as Readonly<Record<string, unknown>>,
    repoRoot: row.repo_root,
    sourceRunId: row.source_run_id,
    sessionId: row.session_id,
    notes: JSON.parse(row.notes_json) as readonly string[],
    createdAtMs: row.created_at_ms,
    lastAccessedAtMs: row.last_accessed_at_ms,
    expiresAtMs: row.expires_at_ms,
    payloadHash: row.payload_hash,
  };
}

function computePayloadHash(content: DeferredVexpContent): string {
  return createHash("sha256")
    .update(stableStringifyDeferredVexpPayload(content))
    .digest("hex");
}
