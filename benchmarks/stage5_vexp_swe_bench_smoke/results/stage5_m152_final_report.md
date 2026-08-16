# M152 — Separate repository evidence from mutable product/session state

**Overall: PASS.** A / B / C / D / E all PASS.

> Repository evidence and mutable product state now have distinct physical
> ownership, distinct lifecycles, and distinct write authority.

## Commits

| | |
| --- | --- |
| M151 predecessor (final functional) | `87b3f5a47cf3dcd2b9ba7cdf8a1bb3163a9e27a7` |
| M152 functional | `e50fac76…` separate product state from the repository index |
| M152 functional | `72ce221c7006dc9e477dcbfa2d7e7372c136fa8c` answer for session state that outlives its index run |
| M152 evidence | this commit |

Branch `main`, local only, nothing pushed, no co-author trailers.
Worktrees: 14 pre-existing untouched; 2 created for paired attribution; 2 removed.

## Ownership before and after

| | before | after |
| --- | --- | --- |
| `index.sqlite` tables | 38 | 27 |
| product/session tables in the index | 11 | **0** |
| session store | did not exist | 11 tables + `session_meta` |
| unclassified objects | 0 | **0** |
| repository-derived tables copied into the session store | — | **0** |

Full matrix in `stage5_m152_table_ownership_audit.md`; contract in
`stage5_m152_storage_contract.md`; scope reasoning in
`stage5_m152_session_store_scope_decision.md`.

## The central invariant (§57, §143)

Measured on the migrated real ARC state,
`stage5_m152_index_session_hash_matrix.json`:

| Operation | index.sqlite changed | session.sqlite changed |
| --- | --- | --- |
| `get_code_context` | **NO** | YES (auto-capture) |
| `run_pipeline` | **NO** | YES |
| `get_context_capsule` | **NO** | YES |
| `search_memory` | **NO** | YES (auto-capture records the lookup) |
| `get_session_context` | **NO** | YES (auto-capture) |
| `index_status` | **NO** | NO |
| `index_repo` | YES | preserved, not rewritten |

`search_memory` and `get_session_context` move the session store because vtrace
auto-captures those tool calls as observations. §179 anticipated "normally NO";
the measured behaviour is YES, and it is recorded as measured.

The per-table classifier agrees across all three repositories exercised
(`repositoriesExercised: 3`, `surfacesPerRepository: 4`, `callsPerSurface: 3`):
`repositoryDerivedUnchangedEverywhere`, `schemaUnchangedEverywhere`,
`objectCountUnchangedEverywhere`, `derivationFingerprintUnchangedEverywhere` —
all true, with **`sessionWrites=0` into the index on every one of the 12 real
product calls**. That number was the whole of M151's unresolved finding.

## Real repository migration (§176)

Rehearsed on isolated copies of both real indexes first; both copies passed
every gate before authoritative state was touched.

| | ARC | TCKDB_v2 |
| --- | --- | --- |
| index size before | 112,467,968 B | 620,572,672 B |
| legacy session tables | 11 | 11 |
| legacy rows | 4,100 | 851 |
| migration performed by | `index_repo` lifecycle | `index_repo` lifecycle |
| migration duration | 3 ms | 2 ms |
| full re-derivation | 36 s (325 files, 9,014 symbols) | ~4 min (1,252 files, 31,366 symbols) |
| session store size | 4,648,960 B | 1,122,304 B |
| product/session tables left in index | 0 | 0 |
| H0 == Hfinal after product activity | **true** | **true** |

Row parity, all 11 families, both repositories: **exact**, zero duplicates, zero
loss, identifiers preserved.

| Family | ARC before → after | TCKDB before → after |
| --- | --- | --- |
| observations | 61 → 61 | 49 → 49 |
| observation_file_links | 292 → 292 | 150 → 150 |
| observation_symbol_links | 1,560 → 1,560 | 149 → 149 |
| observation_fq_name_links | 1,567 → 1,567 | 161 → 161 |
| capsule_manifests | 93 → 93 | 43 → 43 |
| capsule_manifest_items | 474 → 474 | 262 → 262 |
| deferred_vexp_refs | 53 → 53 | 37 → 37 |
| sessions / summaries / rules / tombstones | 0 → 0 | 0 → 0 |

## Feature round-trips on migrated real state

| Feature | ARC | TCKDB_v2 |
| --- | --- | --- |
| `search_memory` over migrated observations | 61 visible, 5 matched | 49 visible, 5 matched |
| `get_session_context` | 3 observations | 3 observations |
| migrated manifest resolves | yes, 6 items | yes, 3 items |
| `check_capsule_staleness` after reindex | **stale**, still stored | **stale**, still stored |
| migrated deferred ref resolves | yes (`vexp:capsule:1dff41c5`) | yes (`vexp:capsule:c76bce4d`) |
| new observation written to session store | yes | yes |
| new manifest id resolvable | yes | yes |
| unresolvable refs emitted | **0** | **0** |

The manifest line is the §145 acceptance: a manifest created before a reindex is
retained and reported **stale**, where a CASCADE used to delete it outright.

## Defect found and fixed during validation

Independent lifecycles create a state that could not previously exist: delete
`index.sqlite`, rebuild from scratch, and run ids restart at 1 while
`session.sqlite` survives holding rows naming run 11. Both staleness paths threw
on `comparisonRunId < sourceRunId` — previously unreachable, because the
observations lived in the file that was deleted.

Throwing would have taken out `search_memory` for a whole repository, and
`check_capsule_staleness` for a manifest whose honest classification is "stale".
Both now report stale with a `source_run_unavailable` reason and no invented
per-item detail. Regression test in `src/session/reindexLifecycle.test.ts`.

## Paired benchmark (§151, §183)

`87b3f5a4` → `72ce221c`, M134 provenance-safe framework:

| Suite | Cases | Semantic changes |
| --- | ---: | ---: |
| Frozen50 | 50 | **0** |
| Django | 20 | **0** |
| cross_repo_30 | 30 | **0** |

`provenanceValid: true`, `srcDirty: false`, `sameFixtureHash`,
`sameTargetCorpusHash`, `neitherSideWritesTargets` all true.

Zero movement here is **structural, not lucky**: these suites reach retrieval
directly and read only repository-derived tables, none of which changed stores.
A movement would have meant the split leaked into derivation, which §56 forbids.

Changed cases: **0**. Storage/layout changes are reported separately below and
are lifecycle changes, not retrieval changes.

## Preservation

| Gate | Result |
| --- | --- |
| M151 product corpus (16 cases) | unchanged — same leads, outcomes, abstentions |
| M151 real acceptance | ARC index unchanged: true; TCKDB index unchanged: true |
| M151 §101 ARC behaviours | `determine_family` / `get_all_families` leads preserved exactly |
| M151 boundedness / index_status | unchanged (1000 members still bounded) |
| M138 memory provenance | 7/7 dedicated tests; historical observations preserved and correctly suppressed |
| M150–M139 | full suite green |
| Tests | **4,633 pass, 49 skip, 0 fail** |
| `bun run typecheck` / `typecheck:benchmarks` | clean |
| `git diff --check` | clean |

### One pre-existing failure, attributed

`run_stage5_m138_memory_provenance_smoke` reports FAIL on `arcMemoryPass` and
`flowImpactPass`. Both gates hard-code ARC-generation-specific numbers
(3 dependents / 3 files); ARC's source has since moved and now yields 10/8.

Attribution was measured rather than assumed: ARC was indexed from identical
source with M151 code and with M152 code, and the impact output is **byte-identical**
(`dependentSymbolCount: 10, dependentFileCount: 8` both sides). The same
comparison over the migrated session store returns identical accounting from
both index generations. The failure predates M152 and is not caused by it.

## Index schema/version delta (§82, §107, §174)

`schema_version` moves once, because `src/db/schema.ts` is hashed into it and the
session DDL left. Consequences:

- a pre-M152 index is `schema_incompatible` and fully re-derived;
- that same `index_repo` invocation drains its session rows, so the upgrade and
  the migration coincide;
- derivation **semantics** are unchanged — no ranking, scoring, candidate
  generation or retrieval behaviour is touched, which the paired benchmark
  confirms at 0/100 across three suites.

Session schema version: 1, tracked independently in `session_meta`.

## Known limitations, unchanged

- `index_status` at 1000 members: ~360 ms, response still bounded. Not optimised
  (§155).
- No general pathless/identifier-less behavioural repository nomination lane
  (§156). That is M153.
- `src/mcp/tools.ts` carries `@ts-nocheck`, so the branded-type authority that
  found every other call path could not protect the largest product surface.
  Those call sites were rewired by hand and are covered by runtime tests only.

## Recommended M153 scope

Cross-repository behavioural routing and evidence composition: repository
nomination without explicit path or symbol hints, ownership versus support,
bounded multi-repository evidence composition, cross-repository evidence chains,
repository-level operation/subject alignment.

M152 was ordered first because a request that composes evidence from several
repositories writes manifests, observations and references whose provenance is
much harder to reason about while they still share a file with the evidence they
describe. That boundary now exists, and is enforced by SQLite rather than by
review.
