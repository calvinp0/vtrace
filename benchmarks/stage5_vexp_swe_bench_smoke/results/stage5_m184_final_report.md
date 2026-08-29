# M184 — Index Materialization Authority and Truthful No-op Semantics

```text
M184 overall      PASS

A  PASS   start-state authority + M183 contamination check
B  PASS   indexer lifecycle / no-op architecture audit
C  PASS   pre-fix reproduction + adversarial materialization matrix
D  PASS   candidate simulation and decision
E  PASS   minimal product repair + focused tests
F  PASS   semantic equivalence, regression qualification, closure

root-cause        NOOP_PREDICATE_OMITS_MATERIALIZATION_VALIDITY
repair            INDEX_MATERIALIZATION_REPAIR_VALIDATED
no-op             TRUTHFUL_NOOP_SEMANTICS_VALIDATED
index equivalence REMATERIALIZED_INDEX_SEMANTIC_EQUIVALENCE_VALIDATED
retrieval         RETRIEVAL_SEMANTICS_PRESERVED
M183 validity     M183_INDEX_CONTAMINATION_NOT_OBSERVED
product           KEEP_INDEXER_WITH_MATERIALIZATION_AUTHORITY_FIX
truthfulness      INDEX_STATUS_TRUTHFULNESS_PRESERVED_OR_STRENGTHENED
performance       INDEX_REPAIR_PERFORMANCE_ACCEPTABLE
next work         M183_FAILURE_STAGE_AUDIT_LICENSED

product changed   YES
retrieval changed NO      ranking changed NO      index format changed NO
index lifecycle   YES

live spend        $0.00
live work         NOT RUN
commits           7b10dcd06bcf036c1b85ce475dcf23d630b93d5e  (product repair + tests)
                  141947678d620b6b95e7bb3d7856849952112d6b  (evidence + closure)
                  <this commit>                              (SHA backfill)
pushed            NO
```

## Headline reproduction

```text
rm -rf .vtrace && vtrace index <repo>       # 1,257 scanned / 747 indexable files

BEFORE                                  AFTER
  exit               0                    exit               0
  reported status    indexed              reported status    indexed with 506 failures
  refresh mode       noop                 refresh mode       incremental
  reported files     1,257                reported files     1,257
  materialized DB    present              materialized DB    present
  indexed files      0                    indexed files      747
  symbols            0                    symbols            5,128
  retrieval usable   "Repo not indexed"   retrieval usable   capsuleMode micro, pivot delivered
```

`vtrace index` said `indexed`. `run-pipeline` said `Repo not indexed`. That reads
as "you never indexed this repository", not "your rebuild silently did nothing" —
which is why the defect could survive being user-reachable.

## Normal no-op proof

The repair does not work by disabling no-op.

```text
healthy current index, vtrace index         BEFORE            AFTER
  refresh mode                              noop              noop
  parsed files                              0                 0
  graph                                     unchanged         unchanged
  wall clock (1,257-file repo)              378-398 ms        372-399 ms
  three consecutive runs                    noop/noop/noop    noop/noop/noop
```

A legitimately **empty** repository also still no-ops after `rm -rf .vtrace` — an
empty index is the correct index for it, and a `symbolCount > 0` validity rule
would have condemned it to rebuild forever (§48).

## What changed

`src/indexer/materializationAuthority.ts` (new, 122 lines) answers one question:
does the graph in this database hold every file the snapshot calls `indexed`, at
the content hash the snapshot records? `src/indexer/indexProject.ts` consults it at
the no-op gate and, when the answer is no, degrades the plan to `incremental` with
`fullRebuildReason: "materialization_missing"` — one new member of an existing
diagnostic union, no serialization version change.

That is the whole product change. It replaces a guard on
`options.hasExistingGraph === false` that only `src/setup/initRepo.ts` ever
satisfied — the guard was correct and **dead for every CLI path**, which is why
`vtrace init` was safe in a fresh worktree while `vtrace index` was not.

## Required answers

**What does `vtrace index` now require before returning a no-op?** Source state
unchanged, derivation and parser/schema compatible (all unchanged from before),
**and** the materialized graph readable and holding every snapshot-indexed file at
the recorded content hash.

**What does `.git/vtrace` prove, and what does it not?** It proves a prior run
observed this repository content under a compatible parser and that its parse work
is reusable. It does not prove that any particular worktree currently holds a
materialized index — it is keyed by `repositoryId`, shared across worktrees, and
written once per successful run. The storage split is sound and is preserved; the
defect was the inference between the two authorities.

**After `rm -rf .vtrace`, why did the old implementation return success without
rebuilding, and what exact decision changed?** `reindexRepoAndRefreshState`
(`src/runtime/reindexRepo.ts:159`) passes `localSnapshot ?? reusable?.snapshot` as
`previousSnapshot`. `indexProject` treats that as *the state this database is
already in* — true for the local manifest, false for a registry record.
`planIncrementalRefresh` then found every content hash matching and returned
`mode: "noop"`, and `indexProject` returned early without entering the persist
transaction. The first divergent condition is the no-op gate in
`indexProject.ts`, formerly `plan.mode === "noop" && options.hasExistingGraph ===
false` and now `plan.mode === "noop" && !evaluateMaterializedGraph(...).usable`.

**Does the repaired path fully reparse, re-materialize from cache, or choose?** It
chooses, and on the measured case it re-materializes from cache: 747 parse-cache
hits and **0** files re-parsed on a 1,257-file repository, 1.8 s against the 10.6 s
a full rebuild costs. Clearing `.git/vtrace` as well still yields a genuine
`full_rebuild` with 1,257 files parsed. The choice is not new logic — the
`incremental` path already reuses the cache, and it re-materializes the whole graph
because the persist transaction rewrites `files`/`symbols`/`edges`/FTS wholesale
for every non-no-op mode.

**Can any tested state still produce exit 0 with a healthy-looking manifest while
the required index is absent or unusable?** **NO** for all covered cases: seven
false-healthy states before, zero after, with the four already-correct controls
(compatible-schema rebuild, healthy-graph-without-manifest no-op, corrupt-DB
failure, real source change) unchanged.

**Did the repair change retrieval or ranking for already-healthy indexes?** **NO.**
32 packets — 8 queries × 4 intents, covering focus, related ids and order, roles,
selection reasons, content, budget accounting and decline-vs-delivery state — are
identical between arms after normalizing timing-only fields, with each arm building
its own index over the same immutable corpus.

**Did the defect affect any of the 30 counted M183 treatment arms?** **No**, and
the witness is authoritative rather than inferred. M183 discovered this defect
during its own preparation (commit `166d07a7`) and gated every workspace on
`mode === "full_rebuild"` **and** a symbol count read from the **database** rather
than the manifest — precisely the surface the defect falsifies. All 30 arms record
`full_rebuild`, `rebuilt: true`, `parsedFiles == totalCurrentFiles`, symbol counts
from 771 to 22,338, `headVerified: true`, zero dirty paths and uniform derivation
fingerprints. A contaminated workspace could not have entered the sweep.

M183's conclusions therefore stand unmodified. M184 does not reinterpret them and
does not attempt to rescue the benchmark through the index defect (§96):
`CURRENT_PRODUCT_UTILITY_NEUTRAL` remains M183's product verdict.

## Verification

```text
bun run typecheck              pass
bun run typecheck:benchmarks   pass
bun test                       5574 pass / 49 skip / 0 fail across 356 files
git diff --check               clean
```

`src/indexer/materializationAuthority.test.ts` adds 14 tests. Five are
known-positive detectors that fail against the pre-fix product and pass after it
(deleted `.vtrace`, deleted database with manifest present, emptied graph, three
delete-rebuild cycles, never-indexed sibling worktree). Nine are controls that pass
in both — the predicate's unit behaviour, the legitimate no-op, and the empty
repository that must stay a no-op. All fixtures are temporary and generic; none
depend on ARC or on a user-specific path.

## Evidence

- `stage5_m184_start_state.json` — HEAD, M183 ancestry, preserved dirt, authority surfaces
- `stage5_m184_m183_index_validity.json` — the 30-arm contamination check
- `stage5_m184_index_authority_map.md` — ownership matrix, lifecycle trace, candidate decision
- `stage5_m184_materialization_matrix.json` — 16 states, before and after
- `stage5_m184_index_equivalence.json` — semantic equivalence, cache reuse, performance
- `stage5_m184_retrieval_equivalence.json` — the 32-packet paired proof
- `stage5_m184_outstanding_defects.md` — debt and the M182 historical correction
