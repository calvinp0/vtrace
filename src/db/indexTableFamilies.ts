// Which store owns each persistent object, and in what order they migrate.
//
// M151-E set out to prove that a read-only product request leaves the index file
// byte-identical, and the measurement refuted the premise rather than the code:
// `index.sqlite` did not hold repository-derived state alone. Three supported
// features persisted into the same file on purpose — observation auto-capture,
// capsule manifests, and deferred VEXP references — so a changed file hash could
// not distinguish "retrieval corrupted the index" from "search_memory recorded a
// lookup". The boundary could only be stated per table and taken on trust.
//
// M152 made it physical. The two families below now live in two files:
//
//   repository-derived -> `index.sqlite`, produced by `index_repo` from source.
//                         No product read may change any of it, nor its schema
//                         or object set. A whole-file hash of this store is now
//                         a meaningful invariant (§57).
//
//   product/session    -> `session.sqlite`, written by supported product
//                         behaviour through `src/session`. It may change during
//                         a request; nothing outside it may.
//
// This module remains the single definition both the evidence runners and the
// regression tests read, so the two halves cannot drift apart, and an
// unclassified table is an error rather than an implicit exemption (§9, §59).
//
// Classification is by SEMANTIC OWNERSHIP, not by who happens to write today: an
// incrementally-maintained repository table is still repository-derived, and a
// product artifact computed FROM repository evidence is still session-owned once
// it is persisted (§8).

/** Tables `index_repo` derives from source. Immutable under product reads. */
export const REPOSITORY_DERIVED_TABLES: ReadonlySet<string> = new Set([
  "files",
  // M156 §60: which files `index_repo` could not parse is derived from the
  // repository's own source, exactly like which symbols it defines. It is not
  // session state, and putting it in `session.sqlite` would mean a re-index no
  // longer fully determines the index store.
  "file_index_failures",
  "symbols",
  "edges",
  "edge_call_sites",
  "symbol_mechanism_facts",
  "document_chunks",
  "index_runs",
  "file_run_states",
  "symbol_run_states",
]);

/**
 * FTS virtual tables and their shadow tables are derived too. Matched by prefix
 * so an FTS shape change cannot silently create an unclassified table.
 */
export const REPOSITORY_DERIVED_PREFIXES: readonly string[] = [
  "document_search_fts",
  "symbol_search_fts",
  "symbol_body_literals_fts",
];

/** State supported product features persist. Owned by `session.sqlite`. */
export const PRODUCT_SESSION_TABLES: ReadonlySet<string> = new Set([
  "observations",
  "observation_file_links",
  "observation_symbol_links",
  "observation_fq_name_links",
  "capsule_manifests",
  "capsule_manifest_items",
  "deferred_vexp_refs",
  "deferred_vexp_ref_tombstones",
  "sessions",
  "session_compression_summaries",
  "project_rules",
]);

/**
 * Bookkeeping the session store owns about ITSELF — its schema version and the
 * record of which legacy index it was drained from. It never existed in a mixed
 * index, so it is not a migration source; it is classified here only so the
 * closure check over `session.sqlite` has no unclassified object either (§136).
 */
export const SESSION_STORE_INTERNAL_TABLES: ReadonlySet<string> = new Set([
  "session_meta",
]);

/**
 * Copy order for the legacy drain: parents before children, so a row never
 * arrives before the row it references. `observations` precedes its three link
 * tables and `session_compression_summaries`; `capsule_manifests` precedes its
 * items. Every entry must also be in `PRODUCT_SESSION_TABLES`, which
 * `indexTableFamilies.test.ts` enforces so a table added to one and forgotten in
 * the other cannot silently skip migration.
 */
export const SESSION_MIGRATION_ORDER: readonly string[] = [
  "sessions",
  "observations",
  "observation_file_links",
  "observation_symbol_links",
  "observation_fq_name_links",
  "session_compression_summaries",
  "capsule_manifests",
  "capsule_manifest_items",
  "project_rules",
  "deferred_vexp_refs",
  "deferred_vexp_ref_tombstones",
];

export type IndexTableFamily = "repository_derived" | "product_session";

/** null means the table is unclassified, which callers must treat as a failure. */
export function classifyIndexTable(table: string): IndexTableFamily | null {
  if (REPOSITORY_DERIVED_TABLES.has(table)) return "repository_derived";
  if (REPOSITORY_DERIVED_PREFIXES.some((prefix) => table.startsWith(prefix))) {
    return "repository_derived";
  }
  if (PRODUCT_SESSION_TABLES.has(table)) return "product_session";
  return null;
}

/** As above, over objects found in a session store. */
export function classifySessionTable(table: string): IndexTableFamily | "session_internal" | null {
  if (SESSION_STORE_INTERNAL_TABLES.has(table)) return "session_internal";
  return classifyIndexTable(table);
}
