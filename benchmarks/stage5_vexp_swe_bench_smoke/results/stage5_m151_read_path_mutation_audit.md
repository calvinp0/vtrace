# M151-E — Read-path mutation audit (§13, §106)

Measured before any patch, decomposed by layer against a disposable fixture, on a
**fully current** index produced by `index_repo` in this same tree.

## The stated hypothesis is refuted

The closure brief traced the mutation as:

```
get_code_context → workspace route → lead selected → withReadyRepoDb
                 → openIndexerDatabase → index mutation
```

`openIndexerDatabase` is **not** the writer. Measured layer by layer:

| layer | file hash | body hash | change counter | pages | objects |
| --- | --- | --- | ---: | ---: | ---: |
| 0. after `index_repo` (baseline) | `2d409c51…` | `3537ad36…` | 49 | 92 | 88 |
| 1. `new Database(path)` open+close | unchanged | unchanged | 49 | 92 | 88 |
| 2. `openIndexerDatabase` open+close | unchanged | unchanged | 49 | 92 | 88 |
| 2b. `initializeSchema` alone | unchanged | unchanged | 49 | 92 | 88 |
| 3. readonly open + `SELECT`s | unchanged | unchanged | 49 | 92 | 88 |
| 4.1 `get_code_context` #1 | **`1f9dbd41…`** | **changed** | **53** | 92 | 88 |
| 4.2 `get_code_context` #2 | **`1b2675ee…`** | **changed** | **55** | 92 | 88 |

On a current index, `CREATE TABLE / INDEX / VIRTUAL TABLE IF NOT EXISTS` is a
genuine no-op: schema initialization writes nothing. Page count, freelist, object
count and `schema_version` are all static across every layer, so this is not
schema installation, not migration, not FTS repair, not VACUUM/ANALYZE, and not a
journal/WAL artifact (the database stays in the same journal mode and no `-wal`
or `-shm` sidecar is produced).

What moves is the **change counter**, +4 then +2, with no page growth: ordinary
row writes into pages that already exist.

### The earlier ARC observation, explained

The +110,592-byte growth seen on ARC in the previous session was a *different*
event: that index predated a schema change, so `CREATE … IF NOT EXISTS`
materialised genuinely missing objects — once. That is legacy-index schema
completion, and it does not recur. It is not what makes repeated reads differ.

So the write class depends on index state:

| index state | `openIndexerDatabase` writes? |
| --- | --- |
| fully current | **no** |
| legacy / missing objects | yes, once (schema completion) |
| fresh from `index_repo` | no |

## What actually writes

Per-table row/content diff across one call of each product surface:

| surface | tables written |
| --- | --- |
| `get_code_context` | `capsule_manifests` 0→2, `capsule_manifest_items` 0→2, `deferred_vexp_refs` 0→1, `observations` 0→1, `observation_file_links` 0→1, `observation_symbol_links` 0→1, `observation_fq_name_links` 0→1 |
| `run_pipeline` | `deferred_vexp_refs` content changed (row count stable) |
| `get_context_capsule` | **none** |
| `index_status` | **none** |

Three distinct subsystems, all deliberate features rather than accidents:

1. **Observation auto-capture** — `captureVisibleCapsuleObservationBestEffort`
   (`src/mcp/tools.ts:8820`), called unconditionally on success. Its own comment
   describes it as "a best-effort post-success side effect shared with
   `get_context_capsule`", deduped by `(sourceRunId, query, intent, routingProfile,
   capsuleProfile, topPivots)`. The `saveObservation` flag guards a *different*,
   explicit persist at `tools.ts:8842`; auto-capture is not behind it.
   Consumers: `search_memory`, `get_session_context`, project rules, consolidation.

2. **Capsule manifest persistence** — `persistCapsuleManifestBestEffort` /
   `persistVisibleCapsuleManifestBestEffort`
   (`src/db/repositories/capsuleManifestsRepository.ts:158,206`). The returned
   `capsuleManifestId` is part of the product response.
   Consumers: `check_capsule_staleness`, `vtrace check-capsule`.

3. **Deferred vexp refs** — `persistDeferredVexpRef`
   (`src/db/repositories/deferredVexpRefsRepository.ts:53`), plus an
   `UPDATE deferred_vexp_refs SET last_accessed_at_ms = ?` on reuse
   (`:172`) — the one write here that genuinely is a "last accessed" heartbeat
   in §102's sense. The ref it stores is what the response hands the caller.
   Consumers: `expand_vexp_ref`, `vtrace expand-vexp-ref`.

`run_pipeline`'s second call touching only `deferred_vexp_refs` is that heartbeat:
the ref already existed and its access timestamp was rewritten.

`get_context_capsule` wrote nothing here only because the manifest and observation
for that query had already been persisted by the preceding `get_code_context` call
and both are deduped — it is not a read-only surface by construction.

## Why the M151-added probes were already safe

The routing probe and supporting-repository composition open members with
`new Database(path, { readonly: true })` and only issue `SELECT`s. Layer 3 above
is exactly that path, and it is byte-identical. Nothing M151 added participates in
any of the three write subsystems.

## Consequence for the closure

The index file mixes two kinds of state:

| kind | tables |
| --- | --- |
| derived, rebuilt by `index_repo` | `files`, `symbols`, `edges`, `edge_call_sites`, `symbol_mechanism_facts`, `document_chunks`, `index_runs`, `file_run_states`, `symbol_run_states`, `*_fts` |
| session/runtime, accumulated by product use | `observations` + 3 link tables, `capsule_manifests` + items, `deferred_vexp_refs` + tombstones, `sessions`, `session_compression_summaries`, `project_rules` |

"A read-only product request must not mutate the selected repository's index" is
therefore not a matter of opening the database differently. The product path
intentionally persists three functional records into the same file that holds
derived state. Making product reads observationally read-only requires deciding
where those records go — which is a product-behaviour decision, not a database
open-mode fix.

## Resolution

Suppressing the three writes was rejected: they are supported behaviour, and
withholding a deferred VEXP ref would either emit an unresolvable reference or
change delivered content and break the frozen M151-D parity gate. Splitting the
store was rejected for this milestone: it touches ~31 non-test source files and 19
test files plus migration, lifecycle and concurrency work, which is a storage
milestone rather than the tail of a wiring one.

What replaced the file-hash gate is a per-table proof — see
`stage5_m151_table_family_preservation.json` and the contract in
`stage5_m151_index_mutability_contract.md`. Measured across 3 repositories
(fixture, ARC, TCKDB_v2) x 4 product surfaces x 3 repeated calls:

| property | result |
| --- | --- |
| every table classified (unclassified fails the run) | true |
| repository-derived tables unchanged | true |
| schema digest unchanged | true |
| object count unchanged (no schema install) | true |
| derivation fingerprint unchanged | true |
| only documented product/session families mutated | true |
| `index_status` writes | none, on every repository |

The invariant left unmet is physical isolation, not evidence: repository-derived
state and product/session state still share one file. That is why M151-E remains
MIXED, and it is the next milestone.
