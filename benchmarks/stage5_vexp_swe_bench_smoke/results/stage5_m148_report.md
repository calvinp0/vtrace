# M148 — access migration lifecycle, and repository-evidence completeness

**M148 — PASS**  ·  **M148-A — PASS**  ·  **M148-B — PASS**

| | |
| --- | --- |
| M147 predecessor (functional) | `3e3050968449daac2426fcf314b4fc573c637875` |
| M147 evidence-only | `2c6b0177e470c6aa525cd04ac1455c452dcd53b2` |
| M148-A | `f801792` Install the index access path as part of indexing, not as a manual step |
| M148-B | `cc06012` Make indexed path uniqueness fail closed on unknown repositories |
| Branch | `main`, 0 ahead of nothing pushed (`origin/main` is 10 behind local) |

Two questions, answered by measurement:

```
Can the M147 physical access optimization be reached through the product?   yes
Does indexed_path obey the same UNKNOWN != ABSENT truth as exact symbols?   it did not; it does now
```

---

## 1. M148-A — the migration became a lifecycle step

### The seam

Every authoritative index is produced by exactly two paths, and both already hold
a writable handle inside `withWorktreeIndexLock`:

```
vtrace index / MCP index_repo / watcher  ->  src/runtime/reindexRepo.ts
vtrace init / setup                      ->  src/setup/initRepo.ts
```

Both now call `ensureIndexAccessCapability` (`src/access/indexAccessLifecycle.ts`)
after the semantic index is written. No new CLI command: `vtrace index` *is*
normal index maintenance, and on an unchanged repository it plans `noop`.

The seam is deliberately **above** `src/indexer`. M146-A's closure guard walks the
value-import closure of the index write path; calling the migration from inside
the indexer would make a physical access path part of semantic derivation and
need an exemption to excuse it. Nothing in the indexer imports `src/access`, so
the guard passes **8/8 with no new exemption** — the architecture proves the
property instead of an allowlist asserting it.

Full audit: `stage5_m148_access_lifecycle_audit.md`. Contract:
`stage5_m148_access_migration_contract.md`.

### Existing compatible index, measured

| Gate | Result |
| --- | --- |
| refresh mode | `noop` |
| files parsed | **0** |
| files added / modified | 0 / 0 |
| graph rows inserted / deleted | 0 / 0 |
| derived content (`files`, `symbols`, `edges`, FTS, chunks) | byte-identical |
| membership answers | identical |
| readiness | `ready` before and after |
| derivation fingerprints | unchanged |
| access path installed | yes, both indexes |

Query plan, fixture and both real corpora:

```
before   SCAN symbols
after    MULTI-INDEX OR
           SEARCH symbols USING INDEX idx_symbols_local_name (local_name=?)
           SEARCH symbols USING INDEX idx_symbols_fq_name (fq_name=?)
```

### Fresh index

`initRepo` leaves the catalogue holding `idx_symbols_local_name` and
`idx_symbols_fq_name` — verified by reading `sqlite_master`, not an internal flag.
Cost: 1.17 ms of a 262 ms index run.

### Properties

| Property | Evidence |
| --- | --- |
| Idempotent | second run `applied: false`, `created: []`, no duplicate indexes, 0.12 ms |
| Atomic | with the second index's name occupied, the first is rolled back; `fallback` reported, nothing thrown |
| Concurrent | two writers racing: exactly one applies, one index of each name, content unmoved |
| Bounded under contention | a migration against a locked worktree fails with `WorktreeIndexLockError` inside its wait, and installs nothing behind the owner's back |
| Explicit | `index_status` opens read-only and closes; no query path migrates |
| Non-fatal | failure reported on `accessCapability.error`; the index stays `ready` |

### Real corpora (byte copies; user indexes never mutated)

| | ARC | TCKDB_v2 |
| --- | ---: | ---: |
| Index size | 98.5 MB | 558.5 MB |
| Symbols | 9,014 | 30,974 |
| Migration | **8.95 ms** | **43.5 ms** |
| Replaces a full rebuild of | ~31 s | ~123 s |
| Absent lookup before -> after | 1,848 us -> **2.0 us** | 8,043 us -> **2.0 us** |
| Semantic results identical | yes | yes |
| Files parsed during migration | 0 | 0 |

The absent lookup is the number that matters: proving a name is NOT in a
repository is what a uniqueness claim is made of.

### User-visible state

`index_status.accessCapability` reports `{version, nameLookupAccess, present,
missing}` read from the catalogue. `fallback` is a performance mode, never a
readiness verdict — an index without the access path answers the same questions
with the same rows and still reports `ready: true`.

---

## 2. M148-B — indexed_path now proves what it claims

### The defect, reproduced before any code changed

Three enabled members; `b` refused; both `a` and `b` index `shared/pipeline.py`:

```
status        selected
selected      ["a"]
reason        a selected on indexed_path evidence.
indexesOpened [a, c]
```

`b` was dropped from the population, and the one ready match was reported as the
owner — a global negative about a repository nobody asked. The same error M147
removed from the symbol lane, one tier up.

### The fix

The eligible population is every **enabled** member. Ready members answer
`present`/`definitely_absent`; refused ones contribute `unknown`; disabled ones
are outside routing entirely. The verdict comes from M147's own reducer —
`proveExactUniqueness` — with the lane's noun passed in, so the rule lives in one
place and the reason a user reads describes the question actually asked.

The old prefix bound is gone as a separate mechanism: a member past the bound is
`unknown (beyond_scan_bound)`, which composes with the same proof and tells the
user which remedy applies (raise the bound vs repair that index).

### Controls (§51), M147 measured side by side

| Case | M147 | M148 | Classification |
| --- | --- | --- | --- |
| B1 unique, all ready | selected(a) | selected(a), 2 proven absent | preserved |
| B2 duplicate, all ready | ambiguous(a,b) | ambiguous(a,b) | preserved |
| B3 ready owner + refused | **selected(a)** | **unproven**, names `b` | tightening |
| B4 ready absent + refused | no_match, global-negative reason | no_match, names `b` | tightening |
| B5 all ready absent | no_match | no_match, absent proof | preserved |
| B6 repair -> absent | selected(a) | unproven -> selected(a) | tightening |
| B7 repair -> present | ambiguous | unproven -> ambiguous | preserved |
| B8 explicit override | selected(c) | selected(c) | preserved |
| B9 absolute path | selected(a) | selected(a) | preserved |
| disabled member | selected(a) | selected(a), proof unique | preserved |
| 11 ready, unique owner | **ambiguous** (probe cap 8/11) | **selected(owner)** | capability gain |
| 11 members, one refused | ambiguous (cap) | ambiguous (names `absent-5`) | tightening |

Registration order reversed: identical status, selection and proof status on
every case. The refused member's index is never opened in any row.

### Real corpora

The real workspace is naturally mixed-readiness — ARC is `ready`, TCKDB_v2 is
`source_stale (head_changed)` **as found** (not caused, and not repaired, by this
milestone). So the correction fires on real data:

```
query    arc/species/converter.py
census   arc indexes it; tckdb does not
M147     selected(arc)
M148     unproven — "arc indexes this path, but 1 eligible repository could not
         be checked ... tckdb (index_refused)"
opened   [arc]     (tckdb's stale index is never read)
```

The census is computed by plain SQL over the same indexes, so the router is
checked by something that is not the router.

### Product path

Through `assembleWorkspaceProductContext`: `context: null`,
`indexesOpenedForRetrieval: []`, `assemble` never called, and the routing reason
names the unknown member. Nothing plausible-but-wrong is delivered from the
repository that merely happened to be ready.

### Cost

`files` already carries a UNIQUE covering index on `path`, so **no new migration
was needed** for this lane:

| | ARC | TCKDB_v2 |
| --- | ---: | ---: |
| read the whole path set | 63.4 us | 308.4 us |
| open + read + close (router's real pattern) | 280.8 us | 754.2 us |
| projected 1000 members | 281 ms | 754 ms |

`maxPathMembershipScans` defaults to 1024, matching the exact-name lane, chosen
from that measurement rather than from caution. The price of the proof is that a
deciding lane opens every enabled member's index instead of a prefix of eight.

### Other lanes audited (§110)

`explicit_route` and `path_containment` read no derived state; supporting-evidence
gathering makes no uniqueness claim; M144/M145 failure-path routing uses
absolute-path containment. No other **derived** lane claims uniqueness or absence
over a ready-filtered population, so nothing was broadened.

---

## 3. Frozen50 — single-repository preservation

| Metric | M147 | M148 | Δ |
| --- | ---: | ---: | ---: |
| Top-1 | 38 | 38 | 0 |
| Top-3 | 44 | 44 | 0 |
| Gold file anywhere | 48 | 48 | 0 |
| Gold symbol anywhere | 31 | 31 | 0 |
| Missing gold | 2 | 2 | 0 |
| Mean tokens | 1832.4 | 1832.4 | 0 |

**0 / 50 changed**, identical semantic hashes on `django` (20) and
`cross_repo_30` (30). `cross_repo_30` is recorded, as M146 and M147 recorded it,
as a single-repository preservation suite rather than a workspace benchmark.

Provenance: `provenanceValid: true`, `sameFixtureHash: true`,
`sameTargetCorpusHash: true`, `authoritative: true`. Both sides were executed in
this session — the M147 column is re-measured, not quoted — from a worktree at
`3e30509` and the candidate tree, against the same fixtures and the same
pre-existing target indexes, which neither side writes to.
`3e30509..2c6b017` touches only benchmark results, so `2c6b017` is evidence-only.

No changed case in either suite, and no unexplained movement anywhere.

---

## 4. Preservation

Full suite **4439 pass / 0 fail / 49 skip**, 274 files, **139.0 s** — 25 tests
added in 2 files and the suite got *faster* than M147's 147.6 s, so the new
fixtures did not push unrelated tests toward their timeouts (the M146 closure
finding). `bun run typecheck`, `bun run typecheck:benchmarks` and
`git diff --check` are clean.

Every derivation fingerprint is byte-identical between `3e30509` and M148:

```
schema_version        1.0.0+48e884e386a7
indexer_fingerprint   f20ea1ab...
parser_fingerprint    e633009f...
config_hash           4b003f22...
```

So no index in the field is invalidated by this milestone. Per-milestone claims
(M132 through M147) are recorded in `stage5_m148_preservation.json`.

---

## 5. Limitations

1. **The proof costs opens.** A deciding indexed-path lane opens every enabled
   member's index: 0.28 ms per ARC-sized member, 0.75 ms per TCKDB-sized one, so
   ~0.75 s at 1000 large members. Bounded and measured, but it is a real cost the
   old prefix did not pay — and the old prefix bought that saving with a claim it
   had not earned.
2. **Unknown members are not repaired.** The lane returns truthful state and
   stops. Auto-repair policy is deliberately out of scope (§57).
3. **`vtrace init` reports the migration only through state.** A failure there is
   visible via `index_status` (`nameLookupAccess: fallback`) rather than as a
   progress line at the moment it happens; the reindex path does emit one.
4. **TCKDB_v2's index is `source_stale` as found.** M148 neither caused nor
   repaired it. Its real-corpus rows are therefore mixed-readiness rows — which
   is what made them a useful control, but a fully-ready two-repository real
   acceptance was not available.
5. **Scale controls run at 11 real members, not 100 or 1000.** The 100/1000
   figures are projections from measured per-member cost, stated as projections.

## 6. Recommended next milestone

**M149 — repository-evidence lane completeness beyond routing.** M148 closes the
two derived routing lanes. The open question the audit surfaced is the one lane
class that was explicitly not broadened: evidence consumers *below* routing
(supporting-evidence gathering, cross-repo composition) still work from a bounded
prefix. They make no uniqueness claim today, so they are sound — but the same
audit should be run against what they DO claim, before a future change gives one
of them an absence claim it has not earned.

---

Artifacts: `stage5_m148_{access_lifecycle_audit,access_migration_contract,
indexed_path_population_audit,indexed_path_truth_contract}.md`,
`stage5_m148_{fresh_index_access,existing_index_migration,access_idempotency,
access_atomicity,access_query_plans,access_performance,
access_fingerprint_preservation,indexed_path_ready_unknown_controls,
indexed_path_registration_order,indexed_path_product_acceptance,
indexed_path_performance,real_workspace_indexed_path,predecessor_measured_cases,
preservation,checkpoint_paired,changed_case_ledger,
workspace_changed_case_ledger}.json`.

Generators: `run_stage5_m148_evidence.ts`, `run_stage5_m148_paired_benchmark.ts`.
