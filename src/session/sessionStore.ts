// Where mutable product state lives, and who is allowed to write it.
//
// M151 could not prove that a product read leaves the index alone, because the
// index file held both halves of the system: the evidence `index_repo` derives
// from source, and the observations, manifests and deferred references product
// features persist on purpose. A whole-file hash cannot tell those apart, so the
// invariant had to be stated per table and taken on trust.
//
// This module makes it physical. `index.sqlite` keeps repository evidence;
// `session.sqlite` beside it keeps the mutable half. After the split the hash of
// `index.sqlite` means exactly one thing again, so §57's whole-file gate becomes
// a real test rather than a wish.
//
// AUTHORITY IS A TYPE, NOT A CONVENTION
// -------------------------------------
// The failure this prevents is a function that takes `db: Database` and is
// handed whichever store the caller happened to have. `SessionDatabase` and
// `WritableSessionDatabase` are branded, so `persistObservation` cannot be
// passed the index handle and a retrieval path cannot be passed a writable
// session handle — the compiler rejects both, in every file, without anyone
// having to read the call site (§44, §122).
//
// LAZY BY CONSTRUCTION
// --------------------
// `readSession()` never creates a file. A repository that has never persisted
// product state reads as an EMPTY store, not an error and not a new file on
// disk, so `search_memory` on a fresh repository behaves exactly as it did
// before while leaving `.vtrace` untouched (§35, §76). `writeSession()` is what
// creates the store, on the first write that actually needs it.
//
// SCOPE
// -----
// One store per repository-local `.vtrace` directory, resolved from the index
// path rather than from the repo root. That is not a stylistic choice: it is
// what preserves existing memory scoping. `search_memory` has never filtered by
// `repo_root` — physical separation IS the scoping rule today (§93) — so a
// per-repo store reproduces current semantics exactly, and deriving the path
// from the index means a benchmark or test pointed at a temporary index
// automatically gets a temporary session store rather than the developer's live
// one (§150).

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";

import { resolveIndexDbPath } from "../indexer/indexMeta";
import {
  initializeSessionSchema,
  readSessionMeta,
  SESSION_SCHEMA_VERSION,
  SessionMetaKey,
  writeSessionMeta,
} from "./sessionSchema";

export const SESSION_DB_FILENAME = "session.sqlite" as const;

declare const SessionReadBrand: unique symbol;
declare const SessionWriteBrand: unique symbol;

/** A handle onto product/session state. May be read; may not be assumed writable. */
export type SessionDatabase = Database & { readonly [SessionReadBrand]: true };

/** A session handle a product feature may persist through. */
export type WritableSessionDatabase = SessionDatabase & { readonly [SessionWriteBrand]: true };

/**
 * The two stores a product request works across. Composition happens here, in
 * application code, rather than through SQLite `ATTACH`: no query in the
 * codebase joins a session table to a repository table, so attaching them would
 * buy nothing and would re-open the write path this milestone closed (§49, §50).
 */
export interface ProductStores {
  /** Repository evidence. Read authority only, for every product caller. */
  readonly index: Database;
  readonly session: SessionDatabase;
}

/** `ProductStores` whose session half may be written. */
export interface WritableProductStores extends ProductStores {
  readonly session: WritableSessionDatabase;
}

/** What a caller can expect of a repository's session store before opening it. */
export const SessionStoreStatus = Object.freeze({
  /** No store yet. Reads are empty; the first write creates it. */
  MissingButCreatable: "missing_but_creatable",
  Ready: "ready",
  /** Written by a newer vtrace. Refused rather than silently downgraded. */
  Incompatible: "incompatible",
  /** Present but unreadable. Never repaired by overwriting (§77). */
  Corrupt: "corrupt",
});

export type SessionStoreStatus = (typeof SessionStoreStatus)[keyof typeof SessionStoreStatus];

export interface SessionStoreHealth {
  readonly status: SessionStoreStatus;
  readonly path: string;
  readonly schemaVersion: number | null;
  readonly detail: string;
}

/** `<repo>/.vtrace/session.sqlite`, the sibling of the index it belongs to. */
export function resolveSessionDbPath(repoRoot: string): string {
  return resolveSessionDbPathForIndexDb(resolveIndexDbPath(repoRoot));
}

/**
 * The session store beside a given index file. Deriving from the INDEX path and
 * not the repo root is what keeps a temporary or benchmark index from reaching
 * the developer's live session state (§96, §150). An in-memory index gets an
 * in-memory session store, so tests stay hermetic without opting in.
 */
export function resolveSessionDbPathForIndexDb(indexDbPath: string): string {
  if (indexDbPath === ":memory:" || indexDbPath.length === 0) {
    return ":memory:";
  }
  return path.join(path.dirname(path.resolve(indexDbPath)), SESSION_DB_FILENAME);
}

/**
 * A bounded lease over one repository's session store.
 *
 * One handle per mode per request, closed together at the end (§42): opening
 * SQLite once per feature write inside a single request would be pure overhead,
 * and a pool would be more machinery than two connections justify.
 */
export class SessionStore {
  readonly path: string;
  #read: SessionDatabase | null = null;
  #write: WritableSessionDatabase | null = null;
  #ephemeral = false;

  constructor(sessionDbPath: string) {
    this.path = sessionDbPath;
  }

  static forIndexDb(indexDbPath: string): SessionStore {
    return new SessionStore(resolveSessionDbPathForIndexDb(indexDbPath));
  }

  static forRepo(repoRoot: string): SessionStore {
    return new SessionStore(resolveSessionDbPath(repoRoot));
  }

  get exists(): boolean {
    return this.path === ":memory:" ? this.#write !== null : existsSync(this.path);
  }

  /**
   * A handle for reading product state. Creates nothing: when no store exists,
   * this is an in-memory schema that is `query_only`, so a caller that reads
   * "empty" gets the same answers as one reading a real empty store, and a
   * caller that mistakes it for a writable handle fails loudly instead of
   * dropping the write on the floor.
   */
  readSession(): SessionDatabase {
    if (this.#write !== null) return this.#write;
    if (this.#read !== null) return this.#read;

    if (this.path !== ":memory:" && existsSync(this.path)) {
      const db = new Database(this.path, { readonly: true }) as SessionDatabase;
      db.run("PRAGMA foreign_keys = ON");
      this.#read = db;
      return db;
    }

    const empty = new Database(":memory:") as SessionDatabase;
    initializeSessionSchema(empty);
    empty.run("PRAGMA query_only = ON");
    this.#ephemeral = true;
    this.#read = empty;
    return empty;
  }

  /**
   * A handle for persisting product state, creating and schema-initialising the
   * store on first use. Initialisation is idempotent and touches nothing but
   * `session.sqlite` — the index handle is not even in scope here (§117).
   */
  writeSession(): WritableSessionDatabase {
    if (this.#write !== null) return this.#write;

    // A read handle opened earlier is read-only (or the ephemeral empty store).
    // It cannot be upgraded, so it is dropped in favour of the writable one.
    if (this.#read !== null) {
      closeQuietly(this.#read);
      this.#read = null;
      this.#ephemeral = false;
    }

    const db = new Database(this.path) as WritableSessionDatabase;
    db.run("PRAGMA foreign_keys = ON");
    if (this.path !== ":memory:") {
      // WAL lets a concurrent reader proceed while a product write is in flight.
      // Set only on the session store: the index's journal mode is not this
      // milestone's business (§127).
      try {
        db.run("PRAGMA journal_mode = WAL");
      } catch {
        // A filesystem that cannot do WAL still persists correctly in the
        // default journal mode.
      }
    }
    initializeSessionSchema(db);
    this.#write = db;
    return db;
  }

  /** True when reads are being served from the throwaway empty store. */
  get isEphemeralRead(): boolean {
    return this.#ephemeral && this.#write === null;
  }

  close(): void {
    if (this.#read !== null) closeQuietly(this.#read);
    if (this.#write !== null) closeQuietly(this.#write);
    this.#read = null;
    this.#write = null;
    this.#ephemeral = false;
  }
}

/**
 * What state the store is in, WITHOUT creating it.
 *
 * Deliberately separate from repository readiness: a repository whose index is
 * perfectly usable can have an unavailable session store, and reporting that as
 * "index not ready" would send a caller to reindex a repository that has nothing
 * wrong with it (§109, §110).
 */
export function inspectSessionStore(sessionDbPath: string): SessionStoreHealth {
  if (sessionDbPath !== ":memory:" && !existsSync(sessionDbPath)) {
    return {
      status: SessionStoreStatus.MissingButCreatable,
      path: sessionDbPath,
      schemaVersion: null,
      detail: "No product/session state has been persisted for this repository yet.",
    };
  }

  let db: Database | undefined;
  try {
    db = new Database(sessionDbPath, { readonly: true });
    const raw = readSessionMeta(db as SessionDatabase, SessionMetaKey.SchemaVersion);
    const version = raw === undefined ? null : Number.parseInt(raw, 10);

    if (version === null || Number.isNaN(version)) {
      return {
        status: SessionStoreStatus.Corrupt,
        path: sessionDbPath,
        schemaVersion: null,
        detail: "The session store records no schema version.",
      };
    }
    if (version > SESSION_SCHEMA_VERSION) {
      return {
        status: SessionStoreStatus.Incompatible,
        path: sessionDbPath,
        schemaVersion: version,
        detail: `The session store was written by a newer vtrace (schema ${version} > ${SESSION_SCHEMA_VERSION}).`,
      };
    }
    return {
      status: SessionStoreStatus.Ready,
      path: sessionDbPath,
      schemaVersion: version,
      detail: `Session store schema ${version}.`,
    };
  } catch (error) {
    return {
      status: SessionStoreStatus.Corrupt,
      path: sessionDbPath,
      schemaVersion: null,
      detail: `The session store could not be read: ${(error as Error).message}`,
    };
  } finally {
    if (db !== undefined) closeQuietly(db);
  }
}

/** Record which repository this store belongs to, so it cannot be misattributed (§13). */
export function bindSessionStoreToRepo(db: WritableSessionDatabase, repoRoot: string): void {
  const existing = readSessionMeta(db, SessionMetaKey.RepoRoot);
  if (existing === undefined) {
    writeSessionMeta(db, SessionMetaKey.RepoRoot, path.resolve(repoRoot));
  }
}

/**
 * One request's access to both stores, bound together so their lifetimes match.
 *
 * A caller asks for `read` or `write` at the point of use rather than being
 * handed one ambiguous handle up front, which is what keeps the read paths from
 * quietly acquiring write authority they never exercise (§37, §122). The index
 * handle belongs to the caller and is not closed here: the indexer owns its own,
 * and a product surface owns a read-only one.
 */
export class ProductStoreLease {
  readonly #indexDb: Database;
  readonly #sessionStore: SessionStore;

  constructor(indexDb: Database, indexDbPath: string) {
    this.#indexDb = indexDb;
    this.#sessionStore = SessionStore.forIndexDb(indexDbPath);
  }

  /** Both stores for reading. Creates no session file (§35). */
  get read(): ProductStores {
    return { index: this.#indexDb, session: this.#sessionStore.readSession() };
  }

  /** Both stores with the session half writable, creating it on first use. */
  get write(): WritableProductStores {
    return { index: this.#indexDb, session: this.#sessionStore.writeSession() };
  }

  get sessionPath(): string {
    return this.#sessionStore.path;
  }

  get sessionStoreExists(): boolean {
    return this.#sessionStore.exists;
  }

  close(): void {
    this.#sessionStore.close();
  }
}

/**
 * An in-memory pair for tests and for callers that already hold an index handle
 * and want product state that never reaches disk.
 */
export function createEphemeralSessionDatabase(): WritableSessionDatabase {
  const db = new Database(":memory:") as WritableSessionDatabase;
  db.run("PRAGMA foreign_keys = ON");
  initializeSessionSchema(db);
  return db;
}

function closeQuietly(db: Database): void {
  try {
    db.close();
  } catch {
    // A handle that cannot close must never fail the request that used it.
  }
}
