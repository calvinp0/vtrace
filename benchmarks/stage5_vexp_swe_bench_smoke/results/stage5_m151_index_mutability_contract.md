# M151-E — What may write to `index.sqlite`, and when

Companion to `stage5_m151_read_path_mutation_audit.md`. This states the contract
the code actually implements, as measured, so the next milestone has something
precise to change rather than an assumption to rediscover.

The closure brief asked for a *read-only DB contract* on the premise that product
reads reach a writable open by accident. They do not. The contract below is the
real one.

---

## Two kinds of state in one file

| family | tables | who writes it |
| --- | --- | --- |
| **repository-derived** | `files`, `symbols`, `edges`, `edge_call_sites`, `symbol_mechanism_facts`, `document_chunks`, `index_runs`, `file_run_states`, `symbol_run_states`, `document_search_fts*`, `symbol_search_fts*`, `symbol_body_literals_fts*` | `index_repo` only |
| **product/session** | `observations` + 3 link tables, `capsule_manifests` + items, `deferred_vexp_refs` + tombstones, `sessions`, `session_compression_summaries`, `project_rules` | supported product behaviour |

The single definition lives in `src/db/indexTableFamilies.ts`, read by both the
regression test and the evidence runner. An unclassified table fails rather than
inheriting a default, so a table added later has to be placed deliberately.

## What a product read may do

`get_code_context`, `run_pipeline`, `get_context_capsule`, `index_status`:

| operation | permitted |
| --- | --- |
| read repository-derived state | yes |
| write repository-derived state | **no** — measured across 3 repos × 4 surfaces × 3 calls |
| change the schema or object set | **no** |
| migrate, install schema, install an access capability | **no** |
| rebuild, repair, or incrementally index | **no** |
| create a missing index | **no** — asserted |
| write `observations` / manifests / deferred refs | **yes**, by design |

`index_status` writes nothing at all, on every repository measured.

## Why the three writes exist

Each is load-bearing for a supported feature, which is why suppressing them was
rejected:

| write | feature it serves | consumer |
| --- | --- | --- |
| observation auto-capture (`captureVisibleCapsuleObservationBestEffort`) | memory | `search_memory`, `get_session_context`, project rules, consolidation |
| capsule manifest (`persistCapsuleManifestBestEffort`) | staleness checking; `capsuleManifestId` is in the response | `check_capsule_staleness`, `vtrace check-capsule` |
| deferred VEXP ref (`persistDeferredVexpRef`) | the ref handed to the caller | `expand_vexp_ref`, `vtrace expand-vexp-ref` |

Not persisting a deferred ref would emit a reference nothing can resolve, and
suppressing deferral instead would change delivered content — which would break
the frozen M151-D single-repository parity gate.

## What M151's own additions do

The routing probe and supporting-repository composition open members with
`new Database(path, { readonly: true })` and issue only `SELECT`s. Measured: a
member probed for a route but not selected as lead is byte-identical afterwards.
A read-only handle also rejects DDL structurally rather than silently succeeding.

## Where writable opens remain, correctly

`openIndexerDatabase` stays writable and is the right lifecycle for `index_repo`,
migration, and incremental/full indexing. On a **current** index it writes
nothing — `CREATE … IF NOT EXISTS` is a genuine no-op, and the object count,
`schema_version`, page count and freelist are all static across an open.

On a **legacy** index whose objects are genuinely missing it completes the schema,
once. That is what produced the +110,592-byte change seen on ARC before the
authorized rebuild, and it does not recur.

## The invariant that is still unmet

> Repository evidence is *physically* isolated from product/session state.

Today both live in one file, so "the index file changed" cannot by itself
distinguish corrupted evidence from a recorded lookup. The per-table proof is
what closes that gap in evidence terms; it does not close it architecturally.

Making it physical means moving three subsystems into a separate store —
`session.sqlite` — which touches roughly 31 non-test source files and 19 test
files plus migration, lifecycle and concurrency work. That is a storage
milestone, not the tail of a wiring one, and it is why M151-E remains MIXED.

## Recommended target shape

```
index.sqlite     repository-derived evidence, immutable under product reads
session.sqlite   observations, capsule manifests, deferred refs,
                 sessions, project rules
```

with all three features preserved and delivered content unchanged. Establishing
that ownership boundary before cross-repository composition begins writing
observations and manifests for several repositories at once is the reason to do
it next rather than later.
