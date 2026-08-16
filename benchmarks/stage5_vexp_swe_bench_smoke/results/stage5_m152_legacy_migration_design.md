# M152 — Legacy migration design

Every repository indexed before this milestone has observations, manifests and
deferred references inside `index.sqlite`. Leaving them there while new writes go
to `session.sqlite` would be the worst available outcome: two authorities for the
same feature, a `search_memory` that silently forgets everything older than the
upgrade, and a physical invariant true only for repositories with no history.

## Trigger: the `index_repo` lifecycle, and nowhere else

Model A of §23. `reindexRepoAndRefreshState` already holds the worktree index
lock, already owns the only writable index handle in the system, and is already
the operation a user invokes knowing the index will change.

A product READ never migrates. That is the read-path index mutation this
milestone exists to abolish, and two concurrent reads racing to rewrite the same
index is precisely the §166 failure.

Choosing that seam costs nothing in reachability. Removing the session DDL from
`src/db/schema.ts` moves `schema_version`, so every pre-M152 index is
`schema_incompatible` and must be reindexed before it can answer anything at all.
The migration therefore runs on exactly the invocation the upgrade already
required — the two coincide instead of competing.

## Order: copy, mark, drop

```
1. open the session store, install its schema
2. copy each family, parents before children, in ONE session transaction
3. write the completion marker into session_meta
4. drop the legacy tables from the index, in one index transaction
```

Step 2 runs before the indexer touches anything, so a crash mid-index cannot
strand session rows in a file being rewritten around them.

## Failure model

| Crash point | State on disk | What a retry does |
| --- | --- | --- |
| during copy | session transaction rolled back; legacy tables intact and authoritative | starts clean |
| after copy, before marker | rows in session store, marker unset, legacy tables present | re-copies with `INSERT OR IGNORE` on real primary keys — adds nothing — then marks and drops |
| after marker, before drop | session store authoritative, legacy tables present but ignored | drops them |
| after drop | migration complete | detected as not-legacy; no-op |

No step can leave half the links in one file and half in the other with ambiguous
authority, because the **marker** — not the presence of either table set — is
what decides which store answers.

## Idempotence and retry safety

`INSERT OR IGNORE` against each table's declared primary key. Row insertion
order is never relied upon. Running the migration once, twice or three times
produces byte-equal session content and a stable index; a retry after a partial
copy adds nothing and loses nothing. Both are asserted in
`src/session/legacyMigration.test.ts`, the second by seeding a partial copy and
then migrating.

## Authority after migration

One-way. Once the marker names this index, `session.sqlite` is authoritative and
the legacy rows are ignored entirely — never unioned. A marker written for a
DIFFERENT index path does not suppress this one's migration: "some legacy state
was drained once" is not "this index was drained".

## Column drift

A legacy table may predate a column the session schema declares (a pre-M138
`observations` row has no provenance columns) or carry one since dropped. The
copy takes the intersection, so a missing column keeps the session schema's
default. That is what makes a pre-provenance observation arrive WITHOUT
provenance rather than being handed the migrating runtime's identity.

## Removal, not empty compatibility tables

The legacy tables are dropped. An empty writable session table left inside the
index is a place a future bug can write to, which is exactly the invariant this
milestone buys. Dropping reclaims pages lazily; no `VACUUM` is forced, because a
smaller file was never an acceptance criterion.

## Concurrency

The worktree index lock already serialises `index_repo`, so two processes cannot
migrate the same store simultaneously. No new coordination system was
introduced.

## Legacy detection on the read path

A product surface that opens an index still holding session tables refuses with
`session_store_migration_required` and names the command that fixes it. It does
not read the legacy rows, does not rewrite them, and does not delete anything.

## Measured on real repositories

| Repository | Legacy rows | Families | Migration | Performed by |
| --- | ---: | ---: | --- | --- |
| ARC | 4,100 | 11 | complete | `index_repo` lifecycle |
| TCKDB_v2 | 851 | 11 | complete | `index_repo` lifecycle |

Both were rehearsed on isolated copies of the real indexes before the
authoritative state was touched, and both copies passed every gate first.
