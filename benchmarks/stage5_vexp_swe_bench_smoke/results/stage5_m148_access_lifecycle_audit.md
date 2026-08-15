# M148-A — index lifecycle ownership audit

Where can an authoritative index be handed an additive physical access path,
without the access path becoming part of semantic derivation?

## 1. What was traced

| Surface | Entry point | Reaches |
| --- | --- | --- |
| `vtrace index` | `src/cli/commands/indexCommand.ts` | `reindexRepoAndRefreshState` |
| MCP `index_repo` | `src/mcp/tools.ts` | `reindexRepoAndRefreshState` |
| file watcher auto-reindex | `src/runtime/fileWatcher.ts` | `reindexRepoAndRefreshState` |
| `vtrace init` / `setup` | `src/setup/initRepo.ts` | `indexProject` directly |
| `index_status` | `src/mcp/tools.ts::inspectIndexStatus` | readiness + meta, **read only** |
| readiness | `src/indexer/indexReadiness.ts` | fingerprints + source snapshot |

Two — and only two — paths produce an authoritative index:
`reindexRepoAndRefreshState` (refresh, incremental and full) and `initRepo`
(first build). Both already hold a **writable** database handle inside
`withWorktreeIndexLock`, which is the M132/M141 ownership boundary.

## 2. The seam, and why it is not inside the indexer

M146-A's closure guard walks the value-import closure of
`src/indexer/indexProject.ts` and `src/indexer/indexMeta.ts` and demands that
everything reachable either feed a derivation fingerprint or carry a written
exemption. Calling the migration from inside the indexer would therefore make a
physical access path a member of the semantic derivation closure and require an
exemption to excuse it.

Chosen direction:

```
index lifecycle / orchestration      src/runtime/reindexRepo.ts, src/setup/initRepo.ts
    -> semantic index build          src/indexer/indexProject.ts
    -> index becomes authoritative
    -> ensure additive access        src/access/indexAccessLifecycle.ts
```

The lifecycle modules import the access module; the indexer never does. The
closure guard passes with **no new exemption** (`8 pass`), which is the
architectural claim being made rather than asserted.

## 3. Error, transaction and ownership semantics at the seam

| Property | Behaviour | Why |
| --- | --- | --- |
| Failure | Reported on `accessCapability.error`, never thrown | A missing query plan does not make an index wrong. Failing the index run would be a lie with an expensive remedy. |
| Transaction | Both `CREATE INDEX` statements in one transaction | Half an access path reports `fallback` forever; the membership query is an `OR` needing a keyed lookup on each side. |
| Ownership | Runs inside `withWorktreeIndexLock` | A migration must not bypass the lock that says who owns this worktree's index (M132), and inherits M141's bounded `lock_timeout` rather than hanging. |
| Reindex | Runs on every lifecycle invocation, including `noop` | The user-important case is the index that is already compatible. |
| Fingerprints | Untouched | The migration writes no row; `computeIndexFingerprints()` is byte-identical before and after. |

Precedent followed: `runBoundedSessionCompressionSweep` is already post-index,
bounded, idempotent, and isolates its own failures into a diagnostic. The access
migration is the same shape.

## 4. Surfaces deliberately NOT used

- **No new CLI command.** `vtrace index` *is* normal index maintenance, and on an
  unchanged repository it plans `noop`: 0 files parsed, 0 graph rows, 0 FTS rows.
  A `migrate-index` command would be a second name for what `index` already does.
- **No read-path migration.** `get_code_context`, `index_status` and workspace
  routing never mutate. A read that repaired the database would make cost depend
  on who asked first, and would undo the explicit lifecycle M146-A established.
- **No new readiness dimension.** `nameLookupAccess` is reported beside
  readiness, not inside it (§13, §31, §66).

## 5. Residual

`vtrace init` reports its outcome on `InitRepoResult.accessCapability` but emits
no progress line for it; a failure there is visible through `index_status`
(`accessCapability.nameLookupAccess: fallback`) rather than at the moment it
happens. The reindex path does emit a progress phase when it installs or fails.
