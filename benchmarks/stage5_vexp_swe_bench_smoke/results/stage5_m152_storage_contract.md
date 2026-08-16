# M152 — Storage contract

Two stores, two lifecycles, two write authorities.

## `index.sqlite`

```
repository-derived evidence
product-read IMMUTABLE (byte-identical, whole file)
writable only by the explicit index lifecycle
```

- **Contents.** `files`, `symbols`, `edges`, `edge_call_sites`,
  `symbol_mechanism_facts`, `document_chunks`, `index_runs`, `file_run_states`,
  `symbol_run_states`, and the three FTS virtual tables with their shadow tables.
- **Writers.** `index_repo` / `reindexRepoAndRefreshState`, index migrations, and
  the CLI write lifecycle — all through `openIndexerDatabase`.
- **Product access.** `openProductIndexDatabase`, opened `readonly` with
  `PRAGMA query_only = ON`. It does not install the schema: installing a schema
  is a write, and a read path may not perform one.
- **Invariant.** A whole-file hash is stable across every product/session
  request. This is now a hard gate rather than a per-table statement, because
  there is no longer any legitimate product writer.

## `session.sqlite`

```
mutable product/session state
independent schema and version lifecycle
repository/workspace provenance retained by value
created lazily, on the first write that needs it
```

- **Contents.** `observations` + its three link tables, `sessions`,
  `session_compression_summaries`, `capsule_manifests`, `capsule_manifest_items`,
  `project_rules`, `deferred_vexp_refs`, `deferred_vexp_ref_tombstones`, plus
  `session_meta` for the store's own version and migration marker.
- **Writers.** Only product-state persistence, through
  `WritableSessionDatabase`. Retrieval, ranking and parser code cannot obtain
  one — the type does not reach them.
- **Location.** Beside the index it belongs to, resolved from the INDEX path:
  `resolveSessionDbPathForIndexDb`. An in-memory index yields an in-memory
  session store, so temporary and benchmark indexes cannot reach live state.
- **Journal mode.** WAL where the filesystem allows it, so a concurrent reader
  proceeds while a product write is in flight. The index's journal mode is
  untouched.

## Write authority

| Connection | Opened by | Index writes | Session writes |
| --- | --- | --- | --- |
| `openIndexerDatabase` | `index_repo`, index migrations, CLI write lifecycle | yes | no (no session handle in scope) |
| `openProductIndexDatabase` | every MCP tool, CLI read commands | **rejected by SQLite** | no |
| `SessionStore.readSession()` | product reads | no | rejected (`readonly` / `query_only`) |
| `SessionStore.writeSession()` | product-state persistence | no | yes |

`ProductStoreLease` pairs an index handle with a lazily-opened session store and
ties their lifetimes to one request. `lease.read` creates no file; `lease.write`
creates the store on first use.

## Cross-store composition

In application code, never through SQLite `ATTACH`. No query in the codebase
joins a session table to a repository table, so attaching would buy nothing and
would reopen the write path this milestone closed. Functions needing both take
`ProductStores` and address each half explicitly:

```
persistObservation(stores)   -> reads stores.index (symbol identity)
                                writes stores.session
searchMemory(stores)         -> reads stores.session (observations)
                                reads stores.index (comparison run)
getCapsuleStaleness(stores)  -> reads stores.session (manifest)
                                reads stores.index (run history)
```

## Provenance, not foreign keys

`source_run_id` on manifests, observations, deferred refs and project rules is a
provenance VALUE naming the index run a record was derived under. SQLite cannot
enforce it across files, and `persistCapsuleManifestFromItems` validates it
against `index_runs` on write instead. A `source_run_id` the index no longer
holds is a staleness answer, not a dangling pointer.

## Failure semantics

Declared per feature in `src/session/persistenceFailurePolicy.ts`:

| Feature | Mode | On failure |
| --- | --- | --- |
| deferred VEXP ref | `RequirePersistence` | emit no reference at all |
| capsule manifest | `OmitIdentifierOnFailure` | valid response, no `capsuleManifestId` |
| observation capture | `BestEffort` | swallowed; retrieval unaffected |
| project rules | `BestEffort` | swallowed; rules reported unavailable |

## Legacy layout

A pre-M152 index still holding session tables is refused by the product surfaces
with `session_store_migration_required` and the command that fixes it. It is not
silently read, not silently rewritten, and not deleted. `index_repo` drains it.
