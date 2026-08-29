# M184-B/D — Index authority map, the first incorrect inference, and the repair decision

## 1. The four authorities

VTRACE keeps index state in two places, and the split is sound. What was wrong is
the inference between them.

| State | Location | Owner | Survives `rm -rf .vtrace`? | What it proves |
|---|---|---|---:|---|
| source snapshot (scan) | computed per run by `scanRepo` | `indexProject` | n/a | what the working tree contains right now |
| reusable snapshot registry | `<gitCommonDir>/vtrace/repositories/<repositoryId>/snapshots/<worktreeId>.json` | `sharedSnapshots.ts` | **yes** | a prior run observed this content under a compatible parser |
| parse cache | `<gitCommonDir>/vtrace/repositories/<repositoryId>/parse-cache/...` | `parseCache.ts` | **yes** | prior parse work can be reused without re-parsing |
| workspace manifest | `<worktreeRoot>/.vtrace/index.meta.json` | `indexMeta.ts` | no | derivation fingerprints + the file snapshot of the last local run |
| **materialized graph** | `<worktreeRoot>/.vtrace/index.sqlite` | `persistParseResult` / the persist transaction | no | **the only thing a query can actually read** |
| product store | `<worktreeRoot>/.vtrace/session.sqlite` | M152 store separation | no | session/observation state, not index content |

Restated as the milestone's four concepts:

```text
SOURCE/SNAPSHOT AUTHORITY      scanRepo + the snapshot's per-file content hashes
DERIVATION/CACHE AUTHORITY     registry record + parse cache + derivation fingerprints
MATERIALIZATION AUTHORITY      rows in .vtrace/index.sqlite
MANIFEST/REPORTING AUTHORITY   index.meta.json + IndexProjectResult totals + CLI render
```

Before M184 the last two were collapsed: whatever the first three concluded, the
manifest reported as achieved.

## 2. The no-op decision path

```text
runIndexCommand                       src/cli/commands/indexCommand.ts
  resolveRepoCommandPaths             -> repoRoot, dbPath = <root>/.vtrace/index.sqlite
  ensureDatabaseDirectory(dbPath)     -> RE-CREATES a deleted .vtrace
  reindexRepoAndRefreshState          src/runtime/reindexRepo.ts
    openIndexerDatabase(dbPath)       -> migrations run: an EMPTY but well-formed schema
    readIndexMeta(repoRoot)           -> localMeta; undefined when .vtrace was deleted
    localSnapshot = localMeta?.manifest?.files
    reusable = localSnapshot === undefined
      ? await selectReusableSnapshot(...)     <-- reads the DURABLE registry
      : undefined
    indexProject({ previousSnapshot: localSnapshot ?? reusable?.snapshot, ... })
      planIncrementalRefresh(...)     src/indexer/incrementalIndex.ts
        every content hash matches    -> { mode: "noop" }
      [old] if (mode === "noop" && options.hasExistingGraph === false) -> incremental
      if (mode === "noop" && previousSnapshot !== undefined) -> EARLY RETURN
```

## 3. First incorrect authority inference

`src/runtime/reindexRepo.ts:159`

```ts
previousSnapshot: localSnapshot ?? reusable?.snapshot,
```

`indexProject` treats `previousSnapshot` as *the state this database is already
in*. That is true of `localSnapshot` — the manifest and the graph are written by
the same run — and **not** true of `reusable.snapshot`, which describes a
materialization that may belong to another worktree, or to a workspace whose
`.vtrace` no longer exists. Nothing between that line and the early return asks
the database anything.

The guard that should have caught it, `src/indexer/indexProject.ts:170`, tested
`options.hasExistingGraph === false` — and **only `src/setup/initRepo.ts:77` ever
passed that option**. `reindexRepoAndRefreshState`, the path behind `vtrace
index`, never did, so the guard was dead for the entire CLI surface. This is why
`vtrace init` in a fresh worktree was safe while `vtrace index` was not.

Two consequences the M183 report did not have:

- **The manifest path is defective too.** With `.vtrace/index.meta.json` intact
  and only `index.sqlite` removed, `localSnapshot` is defined, the registry is
  never consulted, and the same false no-op occurs. The defect is not confined to
  `.git/vtrace`.
- **A never-indexed second worktree.** The registry is keyed by `repositoryId`,
  which every worktree shares. A brand-new worktree's *first* `vtrace index`
  selected a sibling's snapshot and produced an empty index (§35, measured).

## 4. Candidates

| Candidate | Verdict |
|---|---|
| `C_CURRENT` | rejected — 7 distinct states return a healthy no-op over an empty graph |
| `C_REQUIRE_MATERIALIZED_DB_EXISTENCE` | rejected — `ensureDatabaseDirectory` + `openIndexerDatabase` always leave a well-formed empty file present; existence proves nothing (§20) |
| `C_REQUIRE_MATERIALIZATION_COMPATIBILITY` | already present and already correct (`resolveDerivationRebuildReason`; case F rebuilds), but orthogonal — it never fires when only the graph is gone |
| `C_FORCE_FULL_REBUILD_WHEN_MISSING` | correct but wasteful — discards a durable parse cache that is still valid (§18, §41.7). 10.6 s where 1.8 s suffices |
| `C_REMATERIALIZE_FROM_CACHE_WHEN_MISSING` | chosen, as the *recovery* half |
| `C_SHARED_MATERIALIZATION_READINESS_PREDICATE` | chosen, as the *eligibility* half |

**Decision: one predicate governing the existing degrade path.**

`evaluateMaterializedGraph(db, snapshot, hasExistingGraph)` in
`src/indexer/materializationAuthority.ts` answers a single question — does the
graph hold every file this snapshot calls `indexed`, at the content the snapshot
records? When it does not, the no-op plan degrades to `incremental` with
`fullRebuildReason: "materialization_missing"`.

Two structural facts make that the minimal repair rather than a lifecycle rewrite:

1. **`noop` is the only mode that skips the persist transaction.** That
   transaction (`indexProject.ts`) `DELETE`s `files`, `symbols`, `edges` and every
   FTS table and re-inserts all of `successfulResults`, for `incremental` and
   `full_rebuild` alike. "Incremental" is a *parse*-level optimization, not a
   partial-graph mutation — so degrading to it re-materializes the whole graph.
2. **The recovery is nearly free.** With `plan.modified` empty, every file misses
   `initialParsePaths` and is served from the durable parse cache: measured 747
   cache hits and 0 re-parses on a 1,257-file repository.

The predicate is deliberately **structural, not content-based**. `symbolCount > 0`
would call a legitimately empty repository broken (§48, §50); comparing the
snapshot's indexed set against the `files` table is coherence between two surfaces
that are written by the same transaction, so an empty repository matches an empty
graph and stays a valid no-op. It also catches a graph attached to the wrong
source state (§23) for free, at the cost of one indexed table read — strictly
cheaper than the `listAllSymbols` + `listAllEdges` the no-op branch already ran.

## 5. What `vtrace index` now requires before returning a no-op

```text
source state unchanged                      planIncrementalRefresh -> mode "noop"
AND derivation/runtime compatible           resolveDerivationRebuildReason (unchanged)
AND parser registry/schema compatible       registryIncompatible / FILE_SNAPSHOT_SCHEMA_VERSION (unchanged)
AND the materialized graph is readable      evaluateMaterializedGraph   (NEW)
AND it holds every file the snapshot calls indexed, at the recorded content hash
```

Only then is no materialization work performed.

## 6. What `.git/vtrace` proves, and what it does not

It proves a prior run observed this repository content under a compatible parser,
and that the parse work for those files can be reused without re-parsing. It is
keyed by `repositoryId`, so it is shared across every worktree of a repository.

It does **not** prove that any particular worktree currently holds a materialized
index. It cannot: it is written once per successful run and never consulted when
the workspace database is deleted, emptied, truncated, or replaced. The storage
split is fine and is preserved. The defect was the inference.
