import { Database } from "bun:sqlite";

import { initializeSchema } from "./schema";

/**
 * The INDEX WRITER's connection: writable, and it installs the schema.
 *
 * Reserved for `index_repo`, index migrations and the CLI write lifecycle. A
 * product request must not use this — that is what `openProductIndexDatabase`
 * below is for (§121).
 */
export function openIndexerDatabase(path = ":memory:"): Database {
  const db = new Database(path);
  db.run("PRAGMA foreign_keys = ON");
  initializeSchema(db);
  return db;
}

/**
 * A product request's connection to repository evidence: READ-ONLY, enforced by
 * SQLite rather than by convention.
 *
 * M151 could not do this, because product features legitimately wrote to this
 * file. Now that observations, manifests and deferred refs live in
 * `session.sqlite`, `index.sqlite` has no legitimate product writer at all, so
 * the boundary can be enforced by the operating system and the database engine
 * instead of by review (§118, §119, §120).
 *
 * `initializeSchema` is deliberately NOT called. Installing a schema is a write,
 * and a read path may not perform one — which also means an index predating a
 * table is no longer silently repaired mid-query. That case is detected and
 * reported as migration-required instead (§21, §79).
 */
export function openProductIndexDatabase(path: string): Database {
  const db = new Database(path, { readonly: true });
  // `readonly` already refuses writes; `query_only` closes the same door from
  // inside the connection, so an ATTACH-based path cannot reopen it (§50, §124).
  db.run("PRAGMA query_only = ON");
  return db;
}
