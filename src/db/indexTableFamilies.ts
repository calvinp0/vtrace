// What lives in `index.sqlite`, and which half of it a product read may touch.
//
// M151-E set out to prove that a read-only product request leaves the index file
// byte-identical, and the measurement refuted the premise rather than the code:
// `index.sqlite` does not hold repository-derived state alone. Three supported
// features persist into the same file on purpose — observation auto-capture,
// capsule manifests, and deferred VEXP references — so a changed file hash cannot
// distinguish "retrieval corrupted the index" from "search_memory recorded a
// lookup".
//
// The boundary that can be enforced today is therefore stated per table:
//
//   repository-derived -> produced by `index_repo` from source. A product read
//                         must never change any of it, and neither may the schema
//                         or the object set (no migration, no schema install).
//
//   product/session    -> written by supported product behaviour. It MAY change
//                         during a read, and nothing outside it may.
//
// Physically separating the two is a storage milestone, not a wiring one. Until
// that lands, this module is the single definition both the evidence runners and
// the regression test read, so the two halves cannot drift apart, and an
// unclassified table is an error rather than an implicit exemption.

/** Tables `index_repo` derives from source. Immutable under product reads. */
export const REPOSITORY_DERIVED_TABLES: ReadonlySet<string> = new Set([
  "files",
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

/** State supported product features persist. The only tables a read may move. */
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
