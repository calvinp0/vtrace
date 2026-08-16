# M152-A — Persistence ownership audit

Every persistent object vtrace creates, which store semantically owns it, who
reads it, who writes it, and whether M152 moves it. Ownership is decided by
**where the state comes from**, not by who happens to `INSERT` today (§8): an
incrementally-maintained repository table is still repository-derived, and a
product artifact computed *from* repository evidence is still session-owned once
it is persisted.

Source of truth for the classification is `src/db/indexTableFamilies.ts`. An
object it cannot classify is an error, not a default (§9).

## Repository-derived — stays in `index.sqlite`

| Object | Readers | Writers | Lifecycle | Move? |
| --- | --- | --- | --- | --- |
| `files` | retrieval, capsule, impact, access | `indexProject` | rebuilt/incremental per run | no |
| `symbols` | retrieval, capsule, graph, access | `indexProject` | rebuilt/incremental per run | no |
| `edges` | graph expansion, impact, logic flow | `indexProject` | rebuilt/incremental per run | no |
| `edge_call_sites` | logic-flow provenance | `indexProject` | additive since M131 | no |
| `symbol_mechanism_facts` | M150 behavioral retrieval | `indexProject` | additive since M150 | no |
| `document_chunks` | document retrieval | `indexProject` | rebuilt per run | no |
| `index_runs` | staleness, memory freshness, readiness | `indexProject` | append-only across runs | no |
| `file_run_states` | file diffs, staleness | `indexProject` | per run | no |
| `symbol_run_states` | symbol diffs, staleness | `indexProject` | per run | no |
| `document_search_fts*` | document search | `indexProject` | rebuilt per run | no |
| `symbol_search_fts*` | symbol search | `indexProject` | rebuilt per run | no |
| `symbol_body_literals_fts*` | literal search | `indexProject` | rebuilt per run | no |

`*` matches the FTS virtual table and its shadow tables by prefix, so an FTS
shape change cannot silently produce an unclassified object.

## Product/session — moves to `session.sqlite`

| Object | Readers | Writers | Lifecycle | Move? |
| --- | --- | --- | --- | --- |
| `observations` | `search_memory`, `get_session_context`, capsule memory surfacing, project rules | auto-capture, `save_observation`, session compression | retained; freshness by provenance | yes |
| `observation_file_links` | memory scoring | `persistObservation` | with parent | yes |
| `observation_symbol_links` | memory scoring | `persistObservation` | with parent | yes |
| `observation_fq_name_links` | memory scoring | `persistObservation` | with parent | yes |
| `sessions` | `get_session_context`, nudges, compression | `upsertSession` | per session | yes |
| `session_compression_summaries` | `get_session_context` | session compression | per compressed session | yes |
| `capsule_manifests` | `check_capsule_staleness`, `check-capsule` | `get_context_capsule`, `run_pipeline` | retained; staleness by run provenance | yes |
| `capsule_manifest_items` | staleness comparison | as parent | with parent | yes |
| `project_rules` | `run_pipeline` rules section, `vtrace rules` | rule generation/promotion, reindex staleness marking | retained | yes |
| `deferred_vexp_refs` | `expand_vexp_ref` | `run_pipeline` | retained until expiry | yes |
| `deferred_vexp_ref_tombstones` | `expand_vexp_ref` | ref expiry/cleanup | retained | yes |

## Session-store internal

| Object | Purpose |
| --- | --- |
| `session_meta` | session schema version, repository binding, legacy-migration marker |

Unclassified objects: **0**.

## Cross-store references

No SQL in the codebase joins a session table to a repository table. The only
coupling is by value, all of it to `index_runs(id)`:

| Session column | Was | Becomes |
| --- | --- | --- |
| `capsule_manifests.source_run_id` | `FK -> index_runs ON DELETE CASCADE` | provenance value, validated on write |
| `observations.source_run_id` | `FK -> index_runs ON DELETE SET NULL` | provenance value |
| `deferred_vexp_refs.source_run_id` | `FK -> index_runs ON DELETE SET NULL` | provenance value |
| `project_rules.source_run_id` | `FK -> index_runs ON DELETE SET NULL` | provenance value |

Dropping the constraints is not a silently discarded invariant; it changes two
behaviours, both in the direction this milestone wants:

- A manifest whose source run disappears used to be **CASCADE-deleted**. That
  made "the manifest exists" and "the manifest is current" the same question,
  which is precisely what `check_capsule_staleness` exists to tell apart. It is
  now retained and reported stale (§18, §145).
- The three `SET NULL` references silently erased their own provenance. They now
  keep it, and a run id the index no longer holds is a staleness answer rather
  than a null.

`persistCapsuleManifestFromItems` still validates `source_run_id` against
`index_runs` before writing, so a manifest cannot claim provenance the index
never had — the check moved from the engine to the one function that needs it.

`observations.symbol_id` links are hydrated from `symbols` at capture time and
stored as flat identity (path, fq name, kind). That was already true before
M152; it is why memory survives a reindex that changes internal symbol ids.
